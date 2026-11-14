// Visibility rules, quotas and counters shared by every panel level.
import { all, get, setting } from '../db.mjs';
import { limitsFor } from '../auth.mjs';
import { safeJson, pct } from '../util.mjs';

export function ownedUsernames(actor) {
  if (actor.level === 'admin') return null; // null = everyone
  if (actor.level === 'reseller') {
    return all('SELECT username FROM users WHERE owner = ?', actor.username).map((r) => r.username);
  }
  return [actor.username];
}

export function visibleUsers(actor, { level = null, suspended = null } = {}) {
  const params = [];
  let sql = 'SELECT * FROM users WHERE 1=1';
  if (actor.level === 'reseller') { sql += ' AND owner = ?'; params.push(actor.username); }
  else if (actor.level === 'user') { sql += ' AND id = ?'; params.push(actor.id); }
  if (level) { sql += ' AND level = ?'; params.push(level); }
  if (suspended !== null) { sql += ' AND suspended = ?'; params.push(suspended ? 1 : 0); }
  sql += ' ORDER BY username';
  return all(sql, ...params);
}

export function visibleDomains(actor) {
  if (actor.level === 'admin') return all('SELECT * FROM domains ORDER BY is_main DESC, name');
  if (actor.level === 'reseller') {
    return all('SELECT d.* FROM domains d JOIN users u ON u.id = d.user_id WHERE u.owner = ? OR u.username = ? ORDER BY d.is_main DESC, d.name', actor.username, actor.username);
  }
  return all('SELECT * FROM domains WHERE user_id = ? ORDER BY is_main DESC, name', actor.id);
}

export function canManageUser(actor, target) {
  if (!target) return false;
  if (actor.level === 'admin') return true;
  if (actor.level === 'reseller') return target.owner === actor.username && target.level === 'user';
  return target.id === actor.id;
}

export function canManageDomain(actor, domain) {
  if (!domain) return false;
  if (actor.level === 'admin') return true;
  if (actor.level === 'reseller') {
    const owner = get('SELECT username, owner FROM users WHERE id = ?', domain.user_id);
    return domain.username === actor.username || owner?.owner === actor.username;
  }
  return domain.user_id === actor.id;
}

export function domainFor(actor, nameOrId) {
  const d = /^\d+$/.test(String(nameOrId))
    ? get('SELECT * FROM domains WHERE id = ?', Number(nameOrId))
    : get('SELECT * FROM domains WHERE name = ?', String(nameOrId));
  return canManageDomain(actor, d) ? d : null;
}

export function quota(actor, key, amount = 1) {
  const lim = Number(limitsFor(actor)[key] ?? 0);
  if (lim === 0) return { ok: true, used: 0, limit: 0, unlimited: true };
  let used = 0;
  if (key === 'domains') used = get('SELECT COUNT(*) n FROM domains WHERE user_id = ?', actor.id).n;
  else if (key === 'subdomains') used = get('SELECT COUNT(*) n FROM subdomains WHERE username = ?', actor.username).n;
  else if (key === 'emails') used = get('SELECT COUNT(*) n FROM email_accounts WHERE domain IN (SELECT name FROM domains WHERE user_id = ?)', actor.id).n;
  else if (key === 'ftp') used = get('SELECT COUNT(*) n FROM ftp_accounts WHERE user_id = ?', actor.id).n;
  else if (key === 'databases') used = get('SELECT COUNT(*) n FROM databases WHERE user_id = ?', actor.id).n;
  else if (key === 'cron') used = get('SELECT COUNT(*) n FROM cron_jobs WHERE user_id = ?', actor.id).n;
  else if (key === 'users') used = get('SELECT COUNT(*) n FROM users WHERE owner = ?', actor.username).n;
  else if (key === 'ssl') used = get('SELECT COUNT(*) n FROM ssl_certs WHERE username = ?', actor.username).n;
  return { ok: used + amount <= lim, used, limit: lim, unlimited: false };
}

export function countForNav(actor, level) {
  const counts = {};
  const own = actor.username;
  if (level === 'admin') {
    counts['a-users'] = get("SELECT COUNT(*) n FROM users WHERE level = 'user'").n;
    counts['a-resellers'] = get("SELECT COUNT(*) n FROM users WHERE level = 'reseller'").n;
    counts['a-tickets'] = get("SELECT COUNT(*) n FROM tickets WHERE status != 'closed'").n;
    counts['a-messages'] = get('SELECT COUNT(*) n FROM messages WHERE level = ?').n;
  } else if (level === 'reseller') {
    counts['r-users'] = get("SELECT COUNT(*) n FROM users WHERE owner = ?", own).n;
    counts['r-tickets'] = get('SELECT COUNT(*) n FROM tickets WHERE username IN (SELECT username FROM users WHERE owner = ?) AND status != ?', own, 'closed').n;
  } else {
    counts['email'] = get('SELECT COUNT(*) n FROM email_accounts WHERE domain IN (SELECT name FROM domains WHERE user_id = ?)', actor.id).n;
    counts['domains'] = get('SELECT COUNT(*) n FROM domains WHERE user_id = ?', actor.id).n;
    counts['tickets'] = get('SELECT COUNT(*) n FROM tickets WHERE user_id = ? AND status != ?', actor.id, 'closed').n;
    counts['messages'] = get("SELECT COUNT(*) n FROM messages WHERE (username = ? OR username IS NULL) AND read_at IS NULL", own).n;
  }
  counts.notifications = counts['a-tickets'] || counts['r-tickets'] || counts['tickets'] || counts.messages || 0;
  return counts;
}

export function storageFor(actor, level) {
  let disk = 0; let total = 0; let files = 0;
  const doms = level === 'user'
    ? all('SELECT disk_mb FROM domains WHERE user_id = ?', actor.id)
    : all('SELECT disk_mb FROM domains');
  for (const d of doms) { disk += Number(d.disk_mb) || 0; files += 1200 + Math.round((Number(d.disk_mb) || 0) * 3.2); }
  const lim = Number(limitsFor(actor).disk_mb || 0);
  total = lim;
  return { used: disk, total, files, percent: total ? pct(disk, total) : Math.min(99, Math.round(disk / 400)) };
}

export function usageSeries(username, days = 30) {
  const rows = all('SELECT * FROM usage_daily WHERE username = ? ORDER BY day DESC LIMIT ?', username, days);
  return rows.reverse();
}

export function allUsageSeries(days = 14) {
  return all(`SELECT day, SUM(bandwidth_mb) bandwidth_mb, SUM(disk_mb) disk_mb, SUM(emails) emails, SUM(requests) requests
              FROM usage_daily GROUP BY day ORDER BY day DESC LIMIT ?`, days).reverse();
}

export function serverInfo() {
  return {
    hostname: setting('server_name', 'localhost'),
    ip: setting('server_ip', '127.0.0.1'),
    os: process.platform,
    node: process.version,
    version: setting('panel_version', '1.0.0'),
    ns1: setting('ns1', ''),
    ns2: setting('ns2', ''),
  };
}

export function parseLimits(text, fallback = {}) {
  return { ...fallback, ...safeJson(text, {}) };
}
