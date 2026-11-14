// Disk and bandwidth quota enforcement against package limits.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';
import { all, get, run, nowIso, audit, setting } from './db.mjs';
import { limitsFor } from './auth.mjs';
import { userHome } from './paths.mjs';

export function dirSize(dir, depth = 0) {
  if (depth > 8) return 0;
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) total += dirSize(p, depth + 1);
      else total += fs.statSync(p).size;
    } catch { /* skip */ }
  }
  return total;
}

export function homeUsage(username) {
  return dirSize(userHome(username)) / 1024 / 1024;
}

export function checkDisk(user, extraMb = 0) {
  if (!user || user.level !== 'user') return { ok: true, unlimited: true };
  const limit = Number(limitsFor(user).disk_mb || 0);
  const used = homeUsage(user.username);
  return { ok: limit === 0 || used + extraMb <= limit, used, limit };
}

export function monthlyBandwidth(username) {
  const row = get(`SELECT COALESCE(SUM(bandwidth_mb),0) b FROM usage_daily
                   WHERE username = ? AND day >= date('now', '-30 day')`, username);
  return Number(row?.b || 0);
}

/** Suspend accounts that are over disk or monthly bandwidth limits. */
export function enforceAll() {
  const users = all("SELECT * FROM users WHERE level = 'user' AND suspended = 0");
  const suspended = [];
  for (const user of users) {
    const limits = limitsFor(user);
    const disk = homeUsage(user.username);
    const bw = monthlyBandwidth(user.username);
    let reason = '';
    if (Number(limits.disk_mb) > 0 && disk > Number(limits.disk_mb)) reason = `Disk quota exceeded (${disk.toFixed(1)} MB / ${limits.disk_mb} MB)`;
    else if (Number(limits.bandwidth_mb) > 0 && bw > Number(limits.bandwidth_mb)) reason = `Bandwidth quota exceeded (${bw.toFixed(1)} MB / ${limits.bandwidth_mb} MB)`;
    if (reason) {
      run('UPDATE users SET suspended = 1, suspended_reason = ? WHERE id = ?', reason, user.id);
      run('INSERT INTO messages(level, username, subject, body, created_at) VALUES(?,?,?,?,?)',
        'user', user.username, 'Account suspended', `${reason}. Contact your provider to restore service.`, nowIso());
      audit('system', 'admin', 'quota.suspend', `${user.username}: ${reason}`, 'local');
      suspended.push({ username: user.username, reason });
    }
  }
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'quota_last_enforced', nowIso());
  return { ok: true, checked: users.length, suspended };
}

export function quotaMeta() {
  return {
    lastEnforced: setting('quota_last_enforced', ''),
    suspended: all("SELECT username, suspended_reason FROM users WHERE level = 'user' AND suspended = 1"),
  };
}
