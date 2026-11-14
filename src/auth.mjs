// Authentication, sessions, CSRF and capability resolution.
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { get, run, all, nowIso, setting, verifyPassword } from './db.mjs';
import { safeJson, LEVELS } from './util.mjs';

const COOKIE = 'OA_SESSION';

export function findUser(username) {
  return get('SELECT * FROM users WHERE lower(username) = lower(?)', String(username || '').trim());
}

export function userById(id) {
  return get('SELECT * FROM users WHERE id = ?', id);
}

export function isSuspended(user) {
  return !!user?.suspended;
}

export function rateLimited(username, ip) {
  const since = new Date(Date.now() - config.limits.loginWindowMinutes * 60000).toISOString();
  const row = get(
    `SELECT COUNT(*) AS n FROM login_attempts WHERE created_at > ? AND (ip = ? OR lower(username) = lower(?))`,
    since, ip, username,
  );
  return (row?.n || 0) >= config.limits.maxLoginAttempts;
}

export function recordFailure(username, ip) {
  run('INSERT INTO login_attempts(username, ip, created_at) VALUES(?,?,?)', username, ip, nowIso());
}

export function clearFailures(username, ip) {
  run('DELETE FROM login_attempts WHERE lower(username) = lower(?) OR ip = ?', username, ip);
}

export function login(username, password, { ip = '', ua = '' } = {}) {
  if (rateLimited(username, ip)) {
    return { ok: false, error: 'Too many failed attempts. Try again in a few minutes.' };
  }
  const user = findUser(username);
  if (!user || !verifyPassword(password, user.password)) {
    recordFailure(username, ip);
    return { ok: false, error: 'Invalid username or password.' };
  }
  if (isSuspended(user)) {
    return { ok: false, error: 'This account is suspended. Contact your reseller or administrator.' };
  }
  clearFailures(username, ip);
  run('UPDATE users SET last_login = ?, last_ip = ?, login_count = login_count + 1 WHERE id = ?', nowIso(), ip, user.id);
  return { ok: true, user: { ...user, last_login: nowIso() } };
}

export function createSession(user, { ip = '', ua = '' } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000).toISOString();
  run('INSERT INTO sessions(token, user_id, csrf, ip, ua, created_at, expires_at) VALUES(?,?,?,?,?,?,?)',
    token, user.id, csrf, ip, String(ua).slice(0, 250), nowIso(), expires);
  return { token, csrf, expires };
}

export function getSession(token) {
  if (!token) return null;
  const s = get('SELECT * FROM sessions WHERE token = ?', token);
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) {
    run('DELETE FROM sessions WHERE token = ?', token);
    return null;
  }
  const user = userById(s.user_id);
  if (!user || isSuspended(user)) return null;
  return { session: s, user };
}

export function destroySession(token) {
  if (token) run('DELETE FROM sessions WHERE token = ?', token);
}

export function destroyUserSessions(userId) {
  run('DELETE FROM sessions WHERE user_id = ?', userId);
}

export function cookieName() { return COOKIE; }

export function serializeCookie(token, { secure = false, maxAge = config.sessionTtlHours * 3600 } = {}) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** CSRF token check for state changing requests. */
export function checkCsrf(session, provided, { api = false } = {}) {
  if (api) return true; // API calls authenticate per-request
  if (!session?.csrf || !provided) return false;
  const a = Buffer.from(String(session.csrf));
  const b = Buffer.from(String(provided));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Package limits for a user (admin/reseller get permissive defaults). */
export function limitsFor(user) {
  if (user.level === 'admin') {
    return { domains: 0, subdomains: 0, emails: 0, ftp: 0, databases: 0, bandwidth_mb: 0, disk_mb: 0, cron: 0, ssl: 0, users: 0, ips: 0, packages: 0, php: ['8.4', '8.3', '8.2', '8.1'], dns_control: 1, ssh: 1, wordpress: 1, inodes: 0, email_quota_mb: 0 };
  }
  const pkg = user.package ? get('SELECT * FROM packages WHERE name = ?', user.package) : null;
  const defaults = user.level === 'reseller'
    ? { users: 50, domains: 500, emails: 1000, ftp: 100, databases: 200, bandwidth_mb: 0, disk_mb: 0, cron: 20, ssl: 100, ips: 2, packages: 20, php: ['8.3', '8.2', '8.1'], dns_control: 1, wordpress: 1 }
    : { domains: 10, subdomains: 25, emails: 50, ftp: 10, databases: 10, bandwidth_mb: 102400, disk_mb: 10240, cron: 5, ssl: 10, php: ['8.3'], dns_control: 0, wordpress: 1 };
  return { ...defaults, ...(pkg ? safeJson(pkg.limits, {}) : {}) };
}

export function capabilities(user) {
  const l = limitsFor(user);
  const on = (v) => Number(v) !== 0;
  return {
    domains: on(l.domains),
    subdomains: on(l.subdomains),
    emails: on(l.emails),
    emailResponders: on(l.emails),
    mailingLists: on(l.mailing_lists ?? 1),
    ftp: on(l.ftp),
    databases: on(l.databases),
    ssl: on(l.ssl),
    cron: on(l.cron),
    ssh: Number(l.ssh) === 1,
    dns: Number(l.dns_control) === 1,
    wordpress: Number(l.wordpress) === 1,
    nodejs: Number(l.nodejs) === 1,
    python: Number(l.python) === 1,
    sysInfo: true,
    aftp: user.level !== 'user' || Number(l.ftp) > 0,
    git: Number(l.git ?? 0) === 1,
    loginKeys: true,
    spam: Number(l.spam ?? 1) === 1,
    catchAll: Number(l.catch_all ?? 1) === 1,
    cgi: Number(l.cgi ?? 0) === 1,
    php: l.php || ['8.3'],
    phone: true,
  };
}

export function requireLevel(user, level) {
  return (LEVELS[user?.level] || 0) >= (LEVELS[level] || 0);
}

/** DirectAdmin API authentication uses HTTP Basic credentials. */
export function basicAuth(header) {
  if (!header || !header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx === -1) return null;
  return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
}

export function apiLogin(username, password, ip = '') {
  const user = findUser(username);
  if (!user || !verifyPassword(password, user.password)) {
    recordFailure(username, ip);
    return null;
  }
  if (isSuspended(user)) return null;
  if (!user.api_enabled) return null;
  clearFailures(username, ip);
  return user;
}

export function activeSessions(userId) {
  return all('SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC', userId, nowIso());
}

export function serverName() {
  return setting('server_name', config.defaults.serverName);
}
