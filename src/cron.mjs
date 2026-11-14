// Crontab generation and installation for account jobs.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from './config.mjs';
import { all, get, run, nowIso } from './db.mjs';
import { systemProvider } from './providers/index.mjs';

export function cronDir() {
  const dir = path.join(config.dataDir, 'cron');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function cronPath(username) {
  return path.join(cronDir(), `${username}.cron`);
}

const FIELD = /^(\*|(\d{1,2})(-\d{1,2})?(\/\d{1,2})?)(,(\*|(\d{1,2})(-\d{1,2})?(\/\d{1,2})?))*$/;

export function validateJob(job) {
  for (const [field, value, max] of [['minute', job.minute, 59], ['hour', job.hour, 23], ['day', job.day, 31], ['month', job.month, 12], ['weekday', job.weekday, 7]]) {
    const v = String(value ?? '');
    if (!FIELD.test(v)) return `${field} is not valid cron syntax`;
    for (const part of v.split(',')) {
      const start = Number.parseInt(part, 10);
      if (!Number.isNaN(start) && start > max) return `${field} must be <= ${max}`;
    }
  }
  if (!String(job.command || '').trim()) return 'command is required';
  return null;
}

export function renderCrontab(username) {
  const jobs = all('SELECT * FROM cron_jobs WHERE user_id = (SELECT id FROM users WHERE username = ?) ORDER BY id', username);
  const lines = [`# OpenAdmin crontab for ${username}`, `# generated ${nowIso()}`, 'SHELL=/bin/sh', 'PATH=/usr/local/bin:/usr/bin:/bin', ''];
  for (const j of jobs) lines.push(`${j.minute} ${j.hour} ${j.day} ${j.month} ${j.weekday} ${j.command}`);
  return lines.join('\n') + '\n';
}

export function rebuildCrontab(username) {
  const content = renderCrontab(username);
  const file = cronPath(username);
  fs.writeFileSync(file, content, { mode: 0o600 });
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    `crontab_meta:${username}`, JSON.stringify({ file, at: nowIso(), jobs: content.split('\n').filter((l) => l && !l.startsWith('#') && !l.includes('=')).length }));
  return { ok: true, file, content };
}

export function installCrontab(username) {
  const rebuild = rebuildCrontab(username);
  const provider = systemProvider();
  if (provider.id !== 'linux') {
    return { ok: true, simulated: true, output: `Crontab generated at ${rebuild.file} (sandbox provider)`, file: rebuild.file };
  }
  if (process.getuid && process.getuid() !== 0) return { ok: false, output: 'Root privileges are required to install crontabs' };
  const user = get('SELECT username FROM users WHERE username = ?', username);
  if (!user) return { ok: false, output: 'User not found' };
  const r = spawnSync('crontab', ['-u', username, rebuild.file], { encoding: 'utf8', timeout: 30000 });
  return { ok: r.status === 0, output: r.status === 0 ? `Installed crontab for ${username}` : (r.stderr || '').trim(), file: rebuild.file };
}

export function cronMeta(username) {
  const row = get('SELECT value FROM settings WHERE key = ?', `crontab_meta:${username}`);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

export function installAll() {
  const users = all("SELECT username FROM users WHERE level IN ('user','reseller')");
  return users.map((u) => ({ username: u.username, ...installCrontab(u.username) }));
}
