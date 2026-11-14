// Usage metering: real disk consumption per account and web statistics from the
// access logs the web server writes. When no logs exist only disk is metered.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';
import { all, get, run, nowIso, setting } from './db.mjs';
import { systemProvider } from './providers/index.mjs';
import { userHome, mailHome } from './paths.mjs';

export function dirSize(dir, depth = 0) {
  let total = 0;
  if (depth > 8) return 0;
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

/** Recalculate per-mailbox usage from the Maildirs on disk. */
export function recalcMailUsage() {
  const accounts = all('SELECT * FROM email_accounts');
  let updated = 0;
  for (const a of accounts) {
    const owner = get('SELECT username FROM users WHERE id = (SELECT user_id FROM domains WHERE id = ?)', a.domain_id);
    if (!owner) continue;
    const dir = mailHome(owner.username, a.domain, a.local_part);
    const mb = Math.round((dirSize(dir) / 1024 / 1024) * 1000) / 1000;
    run('UPDATE email_accounts SET used_mb = ? WHERE id = ?', mb, a.id);
    updated++;
  }
  return updated;
}

/** Collect one day of usage for every account. */
export function collectUsage(day = new Date().toISOString().slice(0, 10)) {
  const provider = systemProvider();
  const users = all("SELECT * FROM users WHERE level = 'user'");
  const domains = all('SELECT * FROM domains');
  const byUser = new Map();
  let measuredBandwidth = false;
  for (const d of domains) {
    const stats = provider.readAccessLog(d.name);
    const current = byUser.get(d.username) || { bandwidth: 0, requests: 0 };
    if (stats) {
      current.bandwidth += stats.bytes / 1024 / 1024;
      current.requests += stats.requests;
      measuredBandwidth = true;
    }
    byUser.set(d.username, current);
  }
  for (const u of users) {
    const home = userHome(u.username);
    const diskMb = Math.round((dirSize(home) / 1024 / 1024) * 1000) / 1000;
    const stats = byUser.get(u.username) || { bandwidth: 0, requests: 0 };
    const emails = all(`SELECT COUNT(*) n FROM email_accounts WHERE domain IN (SELECT name FROM domains WHERE user_id = ?)`, u.id)[0]?.n || 0;
    run(`INSERT INTO usage_daily(day, username, bandwidth_mb, disk_mb, emails, requests) VALUES(?,?,?,?,?,?)
         ON CONFLICT(day, username) DO UPDATE SET bandwidth_mb = excluded.bandwidth_mb, disk_mb = excluded.disk_mb,
           emails = excluded.emails, requests = excluded.requests`,
      day, u.username, Math.round(stats.bandwidth * 1000) / 1000, diskMb, emails, stats.requests);
  }
  recalcMailUsage();
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'usage_last_collected', nowIso());
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    'usage_bandwidth_source', measuredBandwidth ? 'access logs' : 'unavailable (no access logs)');
  return { ok: true, day, users: users.length, measuredBandwidth };
}

export function usageMeta() {
  return {
    lastCollected: setting('usage_last_collected', ''),
    bandwidthSource: setting('usage_bandwidth_source', 'not collected yet'),
    demo: setting('demo_mode', '0') === '1',
  };
}
