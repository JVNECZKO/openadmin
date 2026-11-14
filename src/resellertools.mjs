// Reseller privilege plans, IP delegation, ownership transfer and mass edits.
import { all, get, run, nowIso, setting, setSetting, audit } from './db.mjs';

export function plans() { return all('SELECT * FROM reseller_plans ORDER BY name'); }

export function savePlan(body, actor = 'admin') {
  const name = String(body.name || '').trim();
  if (!/^[a-zA-Z0-9_.-]{2,40}$/.test(name)) return { ok: false, error: 'Nieprawidłowa nazwa' };
  const privileges = {
    create_users: !!body.create_users, create_domains: !!body.create_domains, email: !!body.email,
    dns: !!body.dns, ssl: !!body.ssl, backups: !!body.backups, ip_delegation: !!body.ip_delegation,
    packages: !!body.packages, resellers: !!body.resellers,
  };
  const limits = {
    users: Math.max(0, Number(body.users || 0)), domains: Math.max(0, Number(body.domains || 0)),
    emails: Math.max(0, Number(body.emails || 0)), databases: Math.max(0, Number(body.databases || 0)),
    disk_mb: Math.max(0, Number(body.disk_mb || 0)), bandwidth_mb: Math.max(0, Number(body.bandwidth_mb || 0)),
  };
  if (body.id) run('UPDATE reseller_plans SET name=?, privileges=?, limits=? WHERE id=?', name, JSON.stringify(privileges), JSON.stringify(limits), Number(body.id));
  else run('INSERT INTO reseller_plans(name, privileges, limits, created_at) VALUES(?,?,?,?)', name, JSON.stringify(privileges), JSON.stringify(limits), nowIso());
  audit(actor, 'admin', 'reseller.plan.save', name, '');
  return { ok: true };
}

export function deletePlan(id) { run('DELETE FROM reseller_plans WHERE id = ?', Number(id)); return { ok: true }; }

export function assignPlan(username, plan, actor = 'admin') {
  const u = get("SELECT * FROM users WHERE username = ? AND level = 'reseller'", username);
  if (!u) return { ok: false, error: 'Reseller nie istnieje' };
  if (plan && !get('SELECT id FROM reseller_plans WHERE name = ?', plan)) return { ok: false, error: 'Plan nie istnieje' };
  run('UPDATE users SET reseller_plan = ? WHERE id = ?', plan || null, u.id);
  audit(actor, 'admin', 'reseller.plan.assign', `${username}:${plan || '-'}`, '');
  return { ok: true };
}

export function resellers() { return all("SELECT * FROM users WHERE level = 'reseller' ORDER BY username"); }

export function delegatedIps() { return all("SELECT * FROM ips WHERE owner IS NOT NULL ORDER BY owner, ip"); }

export function delegateIp(ip, reseller, actor = 'admin') {
  const row = get('SELECT * FROM ips WHERE ip = ?', String(ip || ''));
  if (!row) return { ok: false, error: 'IP nie istnieje w puli' };
  if (row.status === 'server') return { ok: false, error: 'IP serwera nie może być delegowane' };
  if (reseller && !get("SELECT id FROM users WHERE username = ? AND level = 'reseller'", reseller)) return { ok: false, error: 'Reseller nie istnieje' };
  run('UPDATE ips SET owner = ? WHERE id = ?', reseller || null, row.id);
  if (reseller) setSetting(`reseller_shared_ip:${reseller}`, row.ip);
  audit(actor, 'admin', 'reseller.ip.delegate', `${row.ip}:${reseller || '-'}`, '');
  return { ok: true };
}

export function changeOwner(from, to, usernames, actor = 'admin') {
  const target = get("SELECT * FROM users WHERE username = ? AND level IN ('reseller','admin')", to);
  if (!target) return { ok: false, error: 'Nowy właściciel nie istnieje' };
  let changed = 0;
  for (const name of usernames) {
    const u = get("SELECT * FROM users WHERE username = ? AND level = 'user' AND owner = ?", name, from);
    if (!u) continue;
    run('UPDATE users SET owner = ? WHERE id = ?', target.username, u.id);
    changed++;
  }
  audit(actor, 'admin', 'reseller.owner.change', `${from} -> ${to}: ${changed}`, '');
  return { ok: true, changed };
}

export function massModify(usernames, { package: pkg = '', suspended = null }, actor = 'admin') {
  let changed = 0;
  for (const name of usernames) {
    const u = get("SELECT * FROM users WHERE username = ? AND level = 'user'", name);
    if (!u) continue;
    if (pkg) run('UPDATE users SET package = ? WHERE id = ?', pkg, u.id);
    if (suspended !== null) run('UPDATE users SET suspended = ?, suspended_reason = ? WHERE id = ?', suspended ? 1 : 0, suspended ? 'mass modify' : null, u.id);
    changed++;
  }
  audit(actor, 'admin', 'reseller.mass_modify', `${changed} accounts`, '');
  return { ok: true, changed };
}

export function resellerOverview() {
  return {
    plans: plans(), resellers: resellers(), ips: delegatedIps(),
    counts: all("SELECT owner, COUNT(*) n FROM users WHERE level = 'user' AND owner IS NOT NULL GROUP BY owner"),
  };
}
