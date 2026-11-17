// Remote backup destinations, durable backup jobs and transactional restore.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from './config.mjs';
import { all, get, run, nowIso, getDb, audit, setting } from './db.mjs';
import { encryptSecret, decryptSecret } from './secrets.mjs';
import {
  BACKUP_CREATE_STAGES,
  RESTORE_STAGES,
  OperationError,
  backupPath,
  countFiles,
  createJob,
  createServerBackup,
  createUserBackup,
  ensureBackupSchema,
  executeJobSync,
  inspectTarFile,
  jobView,
  readArchiveManifest,
  registerJobHandler,
  requireDiskSpace,
  safeExtractTar,
  sha256File,
} from './backups.mjs';
import { homeRoot } from './paths.mjs';
import { which, isRoot } from './sys.mjs';

export const BACKUP_JOB_STAGES = [
  { key: 'preflight', label: 'Preflight (destination, disk, account)' },
  { key: 'backup', label: 'Create archive' },
  { key: 'upload', label: 'Upload to destination' },
  { key: 'prune', label: 'Apply retention' },
  { key: 'record', label: 'Record run history' },
];

const SCHEDULES = ['hourly', 'daily', 'weekly', 'monthly'];

/* -------------------------------------------------------------------------- */
/* Time zone aware scheduling                                                 */
/* -------------------------------------------------------------------------- */

export function validTimezone(timezone) {
  const value = String(timezone || '').trim();
  if (!value) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch { return false; }
}

export function schedulerTimezone() {
  const configured = setting('scheduler_timezone', '');
  if (configured && validTimezone(configured)) return configured;
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

function tzParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const part of formatter.formatToParts(new Date(date))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return parts;
}

function tzOffsetMs(date, timezone) {
  const parts = tzParts(date, timezone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
  return asUtc - new Date(date).getTime();
}

/** Convert a wall-clock time in a named zone to a UTC Date (DST-safe iteration). */
function zonedToUtc(year, month, day, hour, minute, timezone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 3; i += 1) {
    const offset = tzOffsetMs(new Date(guess), timezone);
    guess = Date.UTC(year, month - 1, day, hour, minute, 0) - offset;
  }
  return new Date(guess);
}

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function parseScheduleTime(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || '').trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * Compute the next `next_run_at` for a backup job. The calculation happens in
 * the job's IANA timezone; `previous` keeps the rhythm stable across restarts
 * instead of resetting it whenever a process starts.
 */
export function nextRunAt({ schedule = 'daily', time = '03:00', timezone = 'UTC', from = Date.now(), previous = null } = {}) {
  const tz = validTimezone(timezone) ? timezone : 'UTC';
  const clock = parseScheduleTime(time) || { hour: 3, minute: 0 };
  const frequency = SCHEDULES.includes(schedule) ? schedule : 'daily';
  const start = previous && Number.isFinite(new Date(previous).getTime()) ? new Date(previous) : new Date(from);
  let parts = tzParts(start, tz);
  if (!previous) {
    parts = { ...tzParts(new Date(from), tz) };
    if (frequency === 'hourly') {
      parts = { ...parts, minute: clock.minute, second: 0 };
      let candidate = zonedToUtc(parts.year, parts.month, parts.day, parts.hour, parts.minute, tz);
      while (candidate.getTime() <= from) {
        const next = tzParts(new Date(candidate.getTime() + 3600e3), tz);
        candidate = zonedToUtc(next.year, next.month, next.day, next.hour, next.minute, tz);
      }
      return candidate.toISOString();
    }
    parts = { ...parts, hour: clock.hour, minute: clock.minute, second: 0 };
    let candidate = zonedToUtc(parts.year, parts.month, parts.day, parts.hour, parts.minute, tz);
    if (frequency === 'weekly' && candidate.getTime() <= from) candidate = zonedToUtc(parts.year, parts.month, parts.day + 7, parts.hour, parts.minute, tz);
    if (frequency === 'monthly' && candidate.getTime() <= from) {
      const targetMonth = parts.month; // 1-based next month
      const year = parts.year + Math.floor(targetMonth / 12);
      const month = (targetMonth % 12) + 1;
      const day = Math.min(parts.day, daysInMonth(year, month - 1));
      candidate = zonedToUtc(year, month, day, parts.hour, parts.minute, tz);
    }
    if (frequency === 'daily' && candidate.getTime() <= from) candidate = zonedToUtc(parts.year, parts.month, parts.day + 1, parts.hour, parts.minute, tz);
    return candidate.toISOString();
  }

  for (let attempt = 0; attempt < 10000; attempt += 1) {
    let candidate;
    if (frequency === 'hourly') {
      const next = tzParts(new Date(start.getTime() + (attempt + 1) * 3600e3), tz);
      candidate = zonedToUtc(next.year, next.month, next.day, next.hour, next.minute, tz);
    } else if (frequency === 'weekly') {
      candidate = zonedToUtc(parts.year, parts.month, parts.day + (attempt + 1) * 7, clock.hour, clock.minute, tz);
    } else if (frequency === 'monthly') {
      const monthIndex = (parts.month - 1) + (attempt + 1);
      const year = parts.year + Math.floor(monthIndex / 12);
      const month = (monthIndex % 12) + 1;
      const day = Math.min(parts.day, daysInMonth(year, month - 1));
      candidate = zonedToUtc(year, month, day, clock.hour, clock.minute, tz);
    } else {
      candidate = zonedToUtc(parts.year, parts.month, parts.day + (attempt + 1), clock.hour, clock.minute, tz);
    }
    if (candidate.getTime() > from) return candidate.toISOString();
  }
  return new Date(from + 864e5).toISOString();
}

/* -------------------------------------------------------------------------- */
/* Schema / defaults                                                          */
/* -------------------------------------------------------------------------- */

export function ensureBackupScheduleSchema() {
  const added = ensureBackupSchema();
  try {
    getDb().exec('CREATE INDEX IF NOT EXISTS idx_backup_jobs_due ON backup_jobs(enabled, next_run_at)');
  } catch { /* older SQLite */ }
  return added;
}

function ensureScheduleDefaults() {
  ensureBackupScheduleSchema();
  const timezone = schedulerTimezone();
  const rows = all('SELECT id, next_run_at, timezone, schedule_time, catch_up_minutes FROM backup_jobs');
  for (const row of rows) {
    const patch = {};
    if (!row.timezone) patch.timezone = timezone;
    if (!row.schedule_time) patch.schedule_time = '03:00';
    if (row.catch_up_minutes === null || row.catch_up_minutes === undefined) patch.catch_up_minutes = 1440;
    if (!row.next_run_at) patch.next_run_at = nowIso();
    if (!Object.keys(patch).length) continue;
    const sets = Object.keys(patch).map((key) => `${key} = ?`).join(', ');
    run(`UPDATE backup_jobs SET ${sets} WHERE id = ?`, ...Object.values(patch), row.id);
  }
}

/* -------------------------------------------------------------------------- */
/* Servers                                                                    */
/* -------------------------------------------------------------------------- */

export function listServers() {
  ensureBackupScheduleSchema();
  return all('SELECT * FROM backup_servers ORDER BY name');
}

export function listJobs() {
  ensureScheduleDefaults();
  return all('SELECT j.*, s.name AS server_name FROM backup_jobs j LEFT JOIN backup_servers s ON s.id = j.server_id ORDER BY j.name');
}

export function listRuns(limit = 100) {
  ensureBackupScheduleSchema();
  return all('SELECT r.*, j.name AS job_name FROM backup_runs r LEFT JOIN backup_jobs j ON j.id = r.job_id ORDER BY r.id DESC LIMIT ?', Number(limit));
}

function plainFtpPolicy() {
  const until = String(setting('backup_plain_ftp_until', '')).trim();
  const untilTime = until ? new Date(`${until.length === 10 ? `${until}T23:59:59` : until}`).getTime() : NaN;
  const active = Number.isFinite(untilTime) && untilTime > Date.now();
  return {
    allowed: active,
    until: active ? new Date(untilTime).toISOString() : null,
    reason: 'Plain FTP sends credentials and the whole archive unencrypted (SEC-024). Use SFTP. Temporary use requires setting backup_plain_ftp_until to a future date and an explicit confirmation.',
  };
}

export function saveServer(body, actor = 'admin') {
  ensureBackupScheduleSchema();
  const type = ['local', 'ftp', 'sftp', 's3'].includes(body.type) ? body.type : 'local';
  if (type === 'ftp') {
    const policy = plainFtpPolicy();
    if (!policy.allowed || String(body.allow_plain_ftp || '') !== '1') {
      return { ok: false, error: policy.reason };
    }
    audit(actor, 'admin', 'backup.server.plain_ftp', String(body.name || ''), 'temporary exception until ' + policy.until);
  }
  const name = String(body.name || '').trim();
  if (!name) return { ok: false, error: 'Nazwa jest wymagana' };
  const host = String(body.host || '').trim();
  const target = String(body.path || '').trim();
  if (type === 'local' && !target) return { ok: false, error: 'Podaj katalog lokalny' };
  if (type !== 'local' && !host) return { ok: false, error: 'Podaj host' };
  if (type === 'local' && !path.isAbsolute(target)) return { ok: false, error: 'Katalog lokalny musi być ścieżką bezwzględną' };
  const enc = body.password ? encryptSecret(String(body.password)) : null;
  if (body.id) {
    run('UPDATE backup_servers SET name=?, type=?, host=?, port=?, path=?, username=?, password_enc=COALESCE(?, password_enc), key_enc=COALESCE(?, key_enc) WHERE id=?',
      name, type, host, Number(body.port || 0) || null, target, String(body.username || ''), enc, body.key ? encryptSecret(String(body.key)) : null, Number(body.id));
    audit(actor, 'admin', 'backup.server.update', name, '');
    return { ok: true, id: Number(body.id) };
  }
  const r = run('INSERT INTO backup_servers(name, type, host, port, path, username, password_enc, key_enc, enabled, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    name, type, host, Number(body.port || 0) || null, target, String(body.username || ''), enc, body.key ? encryptSecret(String(body.key)) : null, 1, nowIso());
  audit(actor, 'admin', 'backup.server.add', name, '');
  return { ok: true, id: r.lastInsertRowid };
}

export function deleteServer(id, actor = 'admin') {
  run('DELETE FROM backup_servers WHERE id = ?', Number(id));
  audit(actor, 'admin', 'backup.server.delete', String(id), '');
  return { ok: true };
}

function curlBin() { return which('curl'); }

function curlUrl(s, filename = '') {
  const port = s.port ? `:${s.port}` : '';
  const base = String(s.path || '').replace(/\/+$/, '');
  const scheme = s.type === 'sftp' ? 'sftp' : 'ftp';
  return `${scheme}://${s.host}${port}${base}/${filename}`;
}

/** Secret goes through curl's stdin config, never through argv (SEC-021). */
function curlSecretInput(server) {
  const escape = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '');
  const user = server.username || 'anonymous';
  const password = server.password_enc ? decryptSecret(server.password_enc) : '';
  return `user = "${escape(user)}:${escape(password)}"\n`;
}

function runCurl(args, { input = '', timeout = 30000 } = {}) {
  return spawnSync(curlBin(), args, { encoding: 'utf8', timeout, input, maxBuffer: 32 * 1024 * 1024 });
}

/** Materialize an encrypted SSH private key only for the duration of a curl call. */
function curlSshOptions(server) {
  if (server.type !== 'sftp' || !server.key_enc) return { args: [], cleanup() {} };
  let key = '';
  try { key = decryptSecret(server.key_enc); } catch { return { args: [], cleanup() {} }; }
  if (!key) return { args: [], cleanup() {} };
  const dir = fs.mkdtempSync(path.join(config.dataDir, 'backup-key-'));
  const file = path.join(dir, 'id');
  fs.writeFileSync(file, key, { mode: 0o600 });
  const args = ['--key', file];
  args.push('--insecure'); // curl 7.88 has no portable known_hosts option; SFTP transport remains encrypted.
  return { args, cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

export function testServer(server) {
  let result;
  if (server.type === 'local') {
    try {
      fs.mkdirSync(server.path, { recursive: true, mode: 0o700 });
      const probe = path.join(server.path, `.openadmin-test-${Date.now()}`);
      fs.writeFileSync(probe, 'ok', { mode: 0o600 });
      fs.rmSync(probe);
      result = { ok: true, detail: `Zapis do ${server.path} działa` };
    } catch (e) { result = { ok: false, detail: e.message }; }
  } else if (server.type === 's3') {
    const aws = which('aws');
    if (!aws) result = { ok: false, detail: 'Brak AWS CLI. Zainstaluj awscli lub użyj SFTP.' };
    else {
      const env = { ...process.env };
      if (server.username) env.AWS_ACCESS_KEY_ID = server.username;
      if (server.password_enc) env.AWS_SECRET_ACCESS_KEY = decryptSecret(server.password_enc);
      const probe = spawnSync(aws, ['s3', 'ls', server.path.replace(/\/?$/, '/')], { encoding: 'utf8', timeout: 30000, env });
      result = { ok: probe.status === 0, detail: probe.status === 0 ? 'Bucket dostępny' : (probe.stderr || 'aws s3 ls failed').trim().slice(0, 400) };
    }
  } else {
    if (server.type === 'ftp' && !plainFtpPolicy().allowed) {
      result = { ok: false, detail: plainFtpPolicy().reason };
    } else if (!curlBin()) {
      result = { ok: false, detail: 'Brak curl' };
    } else {
      const ssh = curlSshOptions(server);
      try {
        const probe = runCurl(['-fsS', '-K', '-', ...ssh.args, '--max-time', '20', curlUrl(server)], { input: curlSecretInput(server) });
        result = { ok: probe.status === 0, detail: probe.status === 0 ? 'Połączenie działa' : (probe.stderr || 'curl failed').trim().slice(0, 400) };
      } finally { ssh.cleanup(); }
    }
  }
  if (server.id) {
    run('UPDATE backup_servers SET last_test_at=?, last_test_ok=?, last_test_output=? WHERE id=?',
      nowIso(), result.ok ? 1 : 0, String(result.detail || '').slice(0, 2000), Number(server.id));
  }
  return result;
}

export function uploadFile(server, file) {
  const filename = path.basename(file);
  if (!/^[A-Za-z0-9_.-]+$/.test(filename)) return { ok: false, error: 'Invalid filename' };
  if (!fs.existsSync(file)) return { ok: false, error: 'Archive not found' };
  if (server.type === 'local') {
    try {
      fs.mkdirSync(server.path, { recursive: true, mode: 0o700 });
      const destination = path.join(server.path, filename);
      const temp = `${destination}.part-${process.pid}`;
      fs.copyFileSync(file, temp);
      fs.renameSync(temp, destination);
      return { ok: true, destination };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  if (server.type === 'ftp' && !plainFtpPolicy().allowed) return { ok: false, error: plainFtpPolicy().reason };
  if (server.type === 's3') {
    const aws = which('aws');
    if (!aws) return { ok: false, error: 'Brak AWS CLI' };
    const env = { ...process.env };
    if (server.username) env.AWS_ACCESS_KEY_ID = server.username;
    if (server.password_enc) env.AWS_SECRET_ACCESS_KEY = decryptSecret(server.password_enc);
    const dest = server.path.replace(/\/$/, '') + '/' + filename;
    const r = spawnSync(aws, ['s3', 'cp', file, dest], { encoding: 'utf8', timeout: 600000, env });
    return r.status === 0 ? { ok: true, destination: dest } : { ok: false, error: (r.stderr || 'aws s3 cp failed').trim().slice(0, 500) };
  }
  if (!curlBin()) return { ok: false, error: 'Brak curl' };
  const ssh = curlSshOptions(server);
  try {
    const r = runCurl(['-fsS', '-K', '-', ...ssh.args, '--max-time', '600', '--upload-file', file, curlUrl(server, filename)], {
      input: curlSecretInput(server), timeout: 620000,
    });
    return r.status === 0 ? { ok: true, destination: curlUrl(server, filename) } : { ok: false, error: (r.stderr || 'upload failed').trim().slice(0, 500) };
  } finally { ssh.cleanup(); }
}

export function downloadFile(server, filename, dest) {
  if (!/^[A-Za-z0-9_.-]+$/.test(filename)) return { ok: false, error: 'Invalid filename' };
  if (server.type === 'local') {
    try {
      fs.copyFileSync(path.join(server.path, filename), dest);
      try { fs.chmodSync(dest, 0o600); } catch { /* ignore */ }
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  if (server.type === 'ftp' && !plainFtpPolicy().allowed) return { ok: false, error: plainFtpPolicy().reason };
  if (server.type === 's3') {
    const aws = which('aws');
    if (!aws) return { ok: false, error: 'Brak AWS CLI' };
    const env = { ...process.env };
    if (server.username) env.AWS_ACCESS_KEY_ID = server.username;
    if (server.password_enc) env.AWS_SECRET_ACCESS_KEY = decryptSecret(server.password_enc);
    const src = server.path.replace(/\/$/, '') + '/' + filename;
    const r = spawnSync(aws, ['s3', 'cp', src, dest], { encoding: 'utf8', timeout: 600000, env });
    return r.status === 0 ? { ok: true } : { ok: false, error: (r.stderr || 'aws s3 cp failed').trim().slice(0, 400) };
  }
  if (!curlBin()) return { ok: false, error: 'Brak curl' };
  const ssh = curlSshOptions(server);
  try {
    const r = runCurl(['-fsS', '-K', '-', ...ssh.args, '--max-time', '600', '-o', dest, curlUrl(server, filename)], {
      input: curlSecretInput(server), timeout: 620000,
    });
    return r.status === 0 ? { ok: true } : { ok: false, error: (r.stderr || 'download failed').trim().slice(0, 400) };
  } finally { ssh.cleanup(); }
}

/* -------------------------------------------------------------------------- */
/* Backup jobs                                                                */
/* -------------------------------------------------------------------------- */

export function saveJob(body, actor = 'admin') {
  ensureBackupScheduleSchema();
  const name = String(body.name || '').trim();
  if (!name) return { ok: false, error: 'Nazwa joba jest wymagana' };
  const scope = body.scope === 'user' ? 'user' : 'server';
  const schedule = SCHEDULES.includes(body.schedule) ? body.schedule : 'daily';
  const timezone = validTimezone(body.timezone) ? String(body.timezone) : schedulerTimezone();
  const scheduleTime = parseScheduleTime(body.schedule_time) ? String(body.schedule_time) : '03:00';
  const catchUpMinutes = Math.min(10080, Math.max(0, Number(body.catch_up_minutes ?? 1440) || 0));
  const components = Array.isArray(body.components) ? body.components : String(body.components || '').split(',').map((x) => x.trim()).filter(Boolean);
  const enabled = body.id ? (body.enabled === undefined ? 1 : (/^(1|true|on|yes)$/i.test(String(body.enabled)) ? 1 : 0)) : 1;
  const targetUser = scope === 'user' ? String(body.target_user || '') : null;
  if (scope === 'user' && !targetUser) return { ok: false, error: 'Dla zakresu „konto” wybierz użytkownika' };
  if (scope === 'user' && !get('SELECT id FROM users WHERE username = ?', targetUser)) return { ok: false, error: 'Wybrane konto nie istnieje' };
  const serverId = Number(body.server_id) || null;
  if (serverId && !get('SELECT id FROM backup_servers WHERE id = ?', serverId)) return { ok: false, error: 'Wybrana lokalizacja backupu nie istnieje' };
  const next = nextRunAt({ schedule, time: scheduleTime, timezone, from: Date.now() });
  if (body.id) {
    run(`UPDATE backup_jobs SET name=?, scope=?, target_user=?, components=?, server_id=?, schedule=?, retention_days=?,
           enabled=?, timezone=?, schedule_time=?, catch_up_minutes=?, next_run_at=? WHERE id=?`,
      name, scope, targetUser, JSON.stringify(components), serverId, schedule,
      Math.min(3650, Math.max(1, Number(body.retention_days || 14))), enabled, timezone, scheduleTime, catchUpMinutes, next, Number(body.id));
    audit(actor, 'admin', 'backup.job.update', name, '');
    return { ok: true, id: Number(body.id), next_run_at: next };
  }
  const r = run(`INSERT INTO backup_jobs(name, scope, target_user, components, server_id, schedule, retention_days, enabled,
                 created_at, timezone, schedule_time, catch_up_minutes, next_run_at)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    name, scope, targetUser, JSON.stringify(components), serverId, schedule,
    Math.min(3650, Math.max(1, Number(body.retention_days || 14))), 1, nowIso(), timezone, scheduleTime, catchUpMinutes, next);
  audit(actor, 'admin', 'backup.job.add', name, '');
  return { ok: true, id: r.lastInsertRowid, next_run_at: next };
}

export function deleteJob(id) {
  run('UPDATE backup_jobs SET enabled = 0, lease_owner = NULL, lease_until = NULL WHERE id = ?', Number(id));
  run('DELETE FROM backup_jobs WHERE id = ?', Number(id));
  return { ok: true };
}

function backupKindForJob(job) {
  const components = (() => {
    try { return JSON.parse(job.components || '[]'); } catch { return []; }
  })();
  if (job.scope === 'user') {
    if (components.length === 1 && ['home', 'email', 'db'].includes(components[0])) return components[0];
    return 'full';
  }
  return 'all';
}

/**
 * Queue one backup-center job as a durable operation job. Double clicks return
 * the active job thanks to the idempotency key.
 */
export function runJob(jobId, { actor = 'admin', runNow = false } = {}) {
  ensureBackupScheduleSchema();
  const job = get('SELECT * FROM backup_jobs WHERE id = ?', Number(jobId));
  if (!job) return { ok: false, error: 'Job not found' };
  const operation = createJob({
    kind: 'backup.job.run',
    stages: BACKUP_JOB_STAGES,
    actor,
    target: `backup-job:${job.id}`,
    payload: { backupJobId: job.id, manual: true, requestedBy: actor },
    idempotencyKey: `backup.job.manual:${job.id}`,
    maxAttempts: 2,
  });
  if (operation.reused) {
    return { ok: true, queued: true, reused: true, jobId: operation.job.id, job: operation.job, backupJobId: job.id };
  }
  if (runNow) {
    const outcome = executeJobSync(operation.job.id);
    return { ok: outcome.ok, queued: false, jobId: operation.job.id, job: outcome.job, ...(outcome.result || {}), error: outcome.error };
  }
  return { ok: true, queued: true, jobId: operation.job.id, job: operation.job, backupJobId: job.id };
}

function backupJobHandler(ctx) {
  ensureBackupScheduleSchema();
  const payload = ctx.job.payload || {};
  const job = get('SELECT * FROM backup_jobs WHERE id = ?', Number(payload.backupJobId));
  if (!job) throw new OperationError('Backup job no longer exists', 'not_found');
  const server = job.server_id ? get('SELECT * FROM backup_servers WHERE id = ?', job.server_id) : null;
  const started = Date.now();
  const runRow = run('INSERT INTO backup_runs(job_id, filename, status, server_id, started_at, operation_job_id) VALUES(?,?,?,?,?,?)',
    job.id, `job-${job.id}-${started}.tar.gz`, 'running', server?.id || null, nowIso(), ctx.job.id);
  const runId = runRow.lastInsertRowid;
  ctx.setState({ runId, backupJobId: job.id });
  ctx.setResult({ runId, backupJobId: job.id });

  const fail = (error) => {
    run('UPDATE backup_runs SET status=?, output=?, finished_at=? WHERE id=?', 'failed', String(error).slice(0, 2000), nowIso(), runId);
    run('UPDATE backup_jobs SET last_run_at=?, last_status=?, last_output=?, last_attempt_at=?, last_duration_ms=? WHERE id=?',
      nowIso(), 'failed', String(error).slice(0, 2000), nowIso(), Date.now() - started, job.id);
    throw new OperationError(String(error), 'backup_failed');
  };

  try {
    const preflight = ctx.step('preflight', () => {
      if (job.scope === 'user') {
        const user = get('SELECT * FROM users WHERE username = ?', job.target_user);
        if (!user) throw new OperationError('Target user does not exist', 'scope_missing');
      }
      if (server) {
        if (server.type === 'ftp' && !plainFtpPolicy().allowed) throw new OperationError(plainFtpPolicy().reason, 'plain_ftp_disabled');
        if (server.type === 'local') {
          fs.mkdirSync(server.path, { recursive: true, mode: 0o700 });
          fs.accessSync(server.path, fs.constants.W_OK);
          requireDiskSpace(server.path, 512 * 1024 * 1024, 'backup destination');
        } else if (!curlBin() && server.type !== 's3') {
          throw new OperationError('curl is required for SFTP/FTP destinations', 'dependency_missing');
        }
      }
      const disk = requireDiskSpace(config.dataDir, 256 * 1024 * 1024, 'backup staging');
      return { destination: server ? `${server.type}:${server.name}` : 'local', disk };
    });

    const archive = ctx.step('backup', () => {
      if (job.scope === 'user') {
        const user = get('SELECT * FROM users WHERE username = ?', job.target_user);
        return createUserBackup(user, backupKindForJob(job));
      }
      const admin = get("SELECT * FROM users WHERE level = 'admin' ORDER BY id LIMIT 1");
      return createServerBackup(admin, backupKindForJob(job));
    });

    const uploaded = ctx.step('upload', () => {
      if (!server) return { ok: true, destination: 'local', skipped: 'no-remote-destination' };
      const result = uploadFile(server, backupPath(archive.filename));
      if (!result.ok) throw new OperationError(`Upload failed: ${result.error}`, 'upload_failed');
      return result;
    });

    ctx.step('prune', () => ({ removed: pruneJob(job) }));

    const report = ctx.step('record', () => {
      const duration = Date.now() - started;
      run(`UPDATE backup_runs SET filename=?, status=?, size_mb=?, local_path=?, remote_path=?, finished_at=?,
             sha256=?, report=? WHERE id=?`,
        archive.filename, 'complete', archive.size || 0, backupPath(archive.filename), uploaded.destination || null,
        nowIso(), archive.sha256 || null, JSON.stringify({ archive: archive.report, upload: uploaded }), runId);
      run('UPDATE backup_jobs SET last_run_at=?, last_status=?, last_output=?, last_attempt_at=?, last_duration_ms=? WHERE id=?',
        nowIso(), 'ok', (uploaded.destination || 'local').slice(0, 2000), nowIso(), duration, job.id);
      audit(payload.requestedBy || 'scheduler', 'admin', 'backup.job.run', job.name, '');
      return {
        runId,
        filename: archive.filename,
        size: archive.size,
        sha256: archive.sha256,
        destination: uploaded.destination || 'local',
        durationMs: duration,
        archiveReport: archive.report,
      };
    });
    const result = { ok: true, ...report, snapshot: preflight };
    ctx.setResult(result);
    return result;
  } catch (error) {
    if (!(error instanceof OperationError && error.code === 'backup_failed')) fail(error.message);
    throw error;
  }
}

export function pruneJob(job) {
  ensureBackupScheduleSchema();
  const cutoff = Date.now() - Number(job.retention_days || 14) * 864e5;
  const runs = all("SELECT * FROM backup_runs WHERE job_id = ? AND status = 'complete' ORDER BY id DESC", job.id);
  let removed = 0;
  for (const row of runs) {
    if (new Date(row.started_at).getTime() > cutoff) continue;
    try { fs.rmSync(row.local_path || backupPath(row.filename), { force: true }); } catch { /* ignore */ }
    if (row.server_id && row.remote_path) {
      const server = get('SELECT * FROM backup_servers WHERE id = ?', row.server_id);
      if (server?.type === 'local') {
        try { fs.rmSync(path.join(server.path, row.filename), { force: true }); } catch { /* ignore */ }
      }
    }
    run('DELETE FROM backup_runs WHERE id = ?', row.id);
    removed += 1;
  }
  return removed;
}

export function dueJobs({ now = Date.now() } = {}) {
  ensureBackupScheduleSchema();
  ensureScheduleDefaults();
  const instant = new Date(Number(now) || Date.now()).toISOString();
  return all(
    `SELECT * FROM backup_jobs
     WHERE enabled = 1
       AND (next_run_at IS NULL OR next_run_at <= ?)
       AND (lease_until IS NULL OR lease_until < ?)
     ORDER BY COALESCE(next_run_at, '') ASC`,
    instant, instant,
  );
}

/**
 * Claim due backup-center jobs and enqueue one durable operation job each.
 * The queue (SQLite) is the source of truth: restarts and multiple panel
 * instances observe the same next_run_at/lease instead of independent timers.
 */
export function enqueueDueJobs({ now = Date.now(), owner = `scheduler:${process.pid}` } = {}) {
  ensureBackupScheduleSchema();
  const due = dueJobs({ now });
  const queued = [];
  const skipped = [];
  for (const job of due) {
    const timezone = validTimezone(job.timezone) ? job.timezone : schedulerTimezone();
    const previous = job.next_run_at || null;
    const catchUpMinutes = Number(job.catch_up_minutes ?? 1440);
    const scheduledAt = previous ? new Date(previous).getTime() : Number(now);
    const missedBy = previous ? Number(now) - scheduledAt : 0;
    const catchUpCutoff = Math.max(0, catchUpMinutes) * 60000;
    if (previous && catchUpMinutes > 0 && missedBy > catchUpCutoff) {
      const next = nextRunAt({ schedule: job.schedule, time: job.schedule_time, timezone, from: now, previous: null });
      run('UPDATE backup_jobs SET next_run_at=?, last_status=?, last_output=?, lease_owner=NULL, lease_until=NULL WHERE id=?',
        next, 'skipped', `Missed run was outside the catch-up window (${catchUpMinutes} min)`, job.id);
      skipped.push({ backupJobId: job.id, reason: 'catch-up-window', next_run_at: next });
      continue;
    }
    const lease = new Date(Number(now) + 10 * 60000).toISOString();
    const claimed = run(
      `UPDATE backup_jobs SET lease_owner=?, lease_until=?, last_attempt_at=?
       WHERE id=? AND enabled=1 AND (lease_until IS NULL OR lease_until < ?)`,
      owner, lease, nowIso(), job.id, new Date(Number(now)).toISOString(),
    );
    if (!claimed.changes) continue;
    try {
      const next = nextRunAt({
        schedule: job.schedule, time: job.schedule_time, timezone, from: now,
        previous: previous && new Date(previous).getTime() > now - 315360000000 ? previous : null,
      });
      const occurrence = previous || new Date(now).toISOString();
      const operation = createJob({
        kind: 'backup.job.run',
        stages: BACKUP_JOB_STAGES,
        actor: 'scheduler',
        target: `backup-job:${job.id}`,
        payload: { backupJobId: job.id, scheduledFor: occurrence },
        idempotencyKey: `backup.job:${job.id}:${occurrence}`,
        maxAttempts: 2,
      });
      run('UPDATE backup_jobs SET next_run_at=?, lease_owner=NULL, lease_until=NULL WHERE id=?', next, job.id);
      queued.push({ backupJobId: job.id, operationJobId: operation.job.id, reused: !!operation.reused, scheduledFor: occurrence, next_run_at: next });
    } catch (error) {
      run('UPDATE backup_jobs SET lease_owner=NULL, lease_until=NULL WHERE id=?', job.id);
      skipped.push({ backupJobId: job.id, reason: error.message });
    }
  }
  return { queued, skipped };
}

export function recoverStaleBackupLeases({ now = Date.now() } = {}) {
  ensureBackupScheduleSchema();
  const instant = new Date(Number(now) || Date.now()).toISOString();
  return run('UPDATE backup_jobs SET lease_owner=NULL, lease_until=NULL WHERE lease_until IS NOT NULL AND lease_until < ?', instant).changes;
}

/** Legacy name used by the scheduler; enqueues durable jobs. */
export function runDueJobs({ now = Date.now() } = {}) {
  const result = enqueueDueJobs({ now });
  // Return a result per enqueued job so callers can surface failures.
  return result.queued.map((entry) => ({ ok: true, queued: true, jobId: entry.operationJobId, backupJobId: entry.backupJobId }));
}

/* -------------------------------------------------------------------------- */
/* Transactional server restore                                               */
/* -------------------------------------------------------------------------- */

function resolveRunFile(row) {
  if (row.local_path && fs.existsSync(row.local_path)) return { file: row.local_path, temp: null };
  if (!row.server_id) return { file: null, temp: null, error: 'Archive is not available locally or on its server' };
  const server = get('SELECT * FROM backup_servers WHERE id = ?', row.server_id);
  if (!server) return { file: null, temp: null, error: 'Backup server missing' };
  const temp = path.join(config.dataDir, `restore-download-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.tar.gz`);
  const download = downloadFile(server, row.filename, temp);
  if (!download.ok) return { file: null, temp: null, error: download.error };
  return { file: temp, temp };
}

function expectedShaForRun(row) {
  if (row.sha256) return row.sha256;
  const backup = get('SELECT sha256 FROM backups WHERE filename = ? ORDER BY id DESC LIMIT 1', row.filename);
  return backup?.sha256 || null;
}

function verifySqliteSnapshot(file) {
  if (!fs.existsSync(file)) return { ok: false, error: 'panel database snapshot is missing' };
  const db = getDb();
  let attached = false;
  try {
    const escaped = file.replace(/'/g, "''");
    db.exec(`ATTACH DATABASE '${escaped}' AS verify_restore`);
    attached = true;
    const integrity = db.prepare('PRAGMA verify_restore.integrity_check').all();
    const text = integrity.map((row) => Object.values(row)[0]).join('; ');
    if (!/^ok$/i.test(text.trim())) return { ok: false, error: `integrity_check: ${text.slice(0, 500)}` };
    const tables = db.prepare("SELECT COUNT(*) AS n FROM verify_restore.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get();
    return { ok: true, tables: Number(tables?.n || 0) };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (attached) { try { db.exec('DETACH DATABASE verify_restore'); } catch { /* ignore */ } }
  }
}

const RESTORE_SKIP_TABLES = new Set([
  'sessions', 'login_attempts', 'sqlite_sequence',
  'backup_runs', 'operation_jobs', 'operation_job_stages', 'operation_job_events', 'scheduler_leases',
]);

function quoteIdent(value) { return `"${String(value).replace(/"/g, '""')}"`; }

function restoreDbFile(file) {
  const db = getDb();
  const escaped = file.replace(/'/g, "''");
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`ATTACH DATABASE '${escaped}' AS restored`);
    const tables = db.prepare("SELECT name FROM restored.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const report = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const { name } of tables) {
        if (RESTORE_SKIP_TABLES.has(name)) continue;
        const safeTable = String(name).replace(/'/g, "''");
        const cols = db.prepare(`PRAGMA main.table_info('${safeTable}')`).all().map((column) => column.name);
        const restoredCols = db.prepare(`PRAGMA restored.table_info('${safeTable}')`).all().map((column) => column.name);
        const common = cols.filter((column) => restoredCols.includes(column));
        if (!common.length) continue;
        const list = common.map((column) => `"${column}"`).join(',');
        db.exec(`DELETE FROM main.${quoteIdent(name)}`);
        db.exec(`INSERT INTO main.${quoteIdent(name)} (${list}) SELECT ${list} FROM restored.${quoteIdent(name)}`);
        const count = db.prepare(`SELECT COUNT(*) AS n FROM main.${quoteIdent(name)}`).get();
        report.push({ object: `db:${name}`, status: 'restored', rows: Number(count?.n || 0) });
      }
      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length) {
        db.exec('ROLLBACK');
        return { ok: false, error: `foreign_key_check failed (${violations.length} violation(s))`, report };
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      return { ok: false, error: e.message, report };
    }
    return { ok: true, tables: tables.length, report };
  } catch (e) {
    return { ok: false, error: e.message, report: [] };
  } finally {
    try { db.exec('DETACH DATABASE restored'); } catch { /* ignore */ }
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export function previewRestoreRun(runId) {
  ensureBackupScheduleSchema();
  const row = get('SELECT * FROM backup_runs WHERE id = ?', Number(runId));
  if (!row) return { ok: false, error: 'Backup run not found' };
  const resolved = resolveRunFile(row);
  if (!resolved.file) return { ok: false, error: resolved.error };
  try {
    const info = inspectTarFile(resolved.file);
    if (!info.ok) return { ok: false, error: info.error, code: info.code };
    const sha256 = sha256File(resolved.file);
    const expectedSha = expectedShaForRun(row);
    const manifest = readArchiveManifest(resolved.file);
    const hasDb = info.entries.includes('openadmin.db');
    const homeNames = new Set();
    for (const entry of info.entries) {
      const match = /^homes\/([^/]+)/.exec(entry);
      if (match) homeNames.add(match[1]);
    }
    const homes = [...homeNames].map((username) => {
      const current = path.join(homeRoot(), username);
      const currentFiles = fs.existsSync(current) ? countFiles(current) : 0;
      const archivedFiles = info.details.filter((detail) => detail.name.startsWith(`homes/${username}/`) && detail.type === '-').length;
      return {
        username,
        target: current,
        currentFiles,
        archivedFiles,
        conflicts: {
          added: Math.max(0, archivedFiles - currentFiles),
          overwritten: Math.min(currentFiles, archivedFiles),
          removed: Math.max(0, currentFiles - archivedFiles),
        },
      };
    });
    return {
      ok: true,
      dryRun: true,
      runId: row.id,
      filename: row.filename,
      bytes: info.bytes,
      entries: info.entries.length,
      hasDb,
      sha256,
      expectedSha,
      integrity: { verified: !!expectedSha && sha256 === expectedSha, algorithm: 'sha256' },
      manifest,
      homes,
      sample: info.entries.slice(0, 40),
      note: 'Apply runs in staging with a pre-restore server snapshot and an automatic rollback.',
    };
  } finally {
    if (resolved.temp) { try { fs.rmSync(resolved.temp, { force: true }); } catch { /* ignore */ } }
  }
}

function restoreServerHandler(ctx) {
  ensureBackupScheduleSchema();
  const payload = ctx.job.payload || {};
  const row = get('SELECT * FROM backup_runs WHERE id = ?', Number(payload.runId));
  if (!row) throw new OperationError('Backup run not found', 'not_found');
  const resolved = resolveRunFile(row);
  if (!resolved.file) throw new OperationError(resolved.error || 'Archive unavailable', 'archive_missing');
  let stagingRoot = null;
  let restorePointDb = null;
  const swapped = [];
  try {
    const preflight = ctx.step('preflight', () => {
      if (config.provider === 'linux' && !isRoot()) throw new OperationError('Root privileges required for restore', 'permission_denied');
      const info = inspectTarFile(resolved.file);
      if (!info.ok) throw new OperationError(`archive rejected: ${info.error}`, info.code || 'invalid_archive');
      const sha256 = sha256File(resolved.file);
      const expectedSha = expectedShaForRun(row);
      if (expectedSha && sha256 !== expectedSha) {
        throw new OperationError('Archive SHA-256 does not match the recorded backup identity', 'integrity_mismatch', { expected: expectedSha, actual: sha256 });
      }
      const manifest = readArchiveManifest(resolved.file);
      if (manifest?.product && manifest.product !== 'OpenAdmin') throw new OperationError('Archive is not an OpenAdmin backup', 'wrong_product');
      requireDiskSpace(config.dataDir, info.bytes * 5 + 64 * 1024 * 1024, 'restore staging');
      const dbOk = info.entries.includes('openadmin.db');
      return { sha256, expectedSha, bytes: info.bytes, entries: info.entries.length, hasDb: dbOk, manifest };
    });

    const staged = ctx.step('stage', () => {
      fs.mkdirSync(homeRoot(), { recursive: true, mode: 0o755 });
      stagingRoot = fs.mkdtempSync(path.join(homeRoot(), '.openadmin-restore-'));
      const extraction = safeExtractTar(resolved.file, stagingRoot);
      if (!extraction.ok) throw new OperationError(`staging failed: ${extraction.error}`, extraction.code || 'extract_failed');
      const homes = path.join(stagingRoot, 'homes');
      const dbFile = path.join(stagingRoot, 'openadmin.db');
      if (!fs.existsSync(homes) && !fs.existsSync(dbFile)) throw new OperationError('Archive contains neither homes nor a panel database', 'empty_archive');
      if (fs.existsSync(dbFile)) {
        const verified = verifySqliteSnapshot(dbFile);
        if (!verified.ok) throw new OperationError(`panel database snapshot rejected: ${verified.error}`, 'integrity_mismatch');
      }
      return { homes: fs.existsSync(homes) ? homes : null, dbFile: fs.existsSync(dbFile) ? dbFile : null, treeFiles: countFiles(stagingRoot) };
    });

    const snapshot = ctx.step('snapshot', () => {
      const admin = get("SELECT * FROM users WHERE level = 'admin' ORDER BY id LIMIT 1");
      if (!admin) throw new OperationError('No administrator account exists', 'scope_missing');
      const preRestore = createServerBackup(admin, 'all');
      restorePointDb = path.join(stagingRoot, 'restore-point.db');
      const escaped = restorePointDb.replace(/'/g, "''");
      getDb().exec(`VACUUM INTO '${escaped}'`);
      ctx.setState({ preRestore: preRestore.filename, restorePointDb });
      return { backup: preRestore.filename, sha256: preRestore.sha256, dbSnapshot: restorePointDb, createdAt: nowIso() };
    });

    const verified = ctx.step('verify', () => {
      const sha256 = sha256File(resolved.file);
      if (preflight.expectedSha && sha256 !== preflight.expectedSha) {
        throw new OperationError('archive changed between preflight and apply', 'integrity_mismatch');
      }
      const homes = staged.homes && fs.existsSync(staged.homes)
        ? fs.readdirSync(staged.homes, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
        : [];
      for (const username of homes) {
        if (!/^[A-Za-z0-9_.-]+$/.test(username) || username.startsWith('.')) {
          throw new OperationError(`unsafe home entry in archive: ${username}`, 'unsafe_archive');
        }
      }
      const dbReport = staged.dbFile ? verifySqliteSnapshot(staged.dbFile) : null;
      if (dbReport && !dbReport.ok) throw new OperationError(`database verification failed: ${dbReport.error}`, 'integrity_mismatch');
      return { sha256, verified: true, homes, db: dbReport, stagedFiles: staged.treeFiles };
    });

    const applied = ctx.step('apply', () => {
      const report = [];
      let dbRestored = false;
      try {
        if (staged.homes && fs.existsSync(staged.homes)) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          for (const entry of fs.readdirSync(staged.homes, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const username = entry.name;
            const source = path.join(staged.homes, username);
            const target = path.join(homeRoot(), username);
            const previous = `${target}.pre-restore-${stamp}`;
            let movedPrevious = false;
            if (fs.existsSync(target)) {
              fs.renameSync(target, previous);
              movedPrevious = true;
            }
            try {
              fs.renameSync(source, target);
            } catch (error) {
              if (movedPrevious && fs.existsSync(previous)) fs.renameSync(previous, target);
              throw error;
            }
            swapped.push({ target, previous, movedPrevious });
            const summary = { files: countFiles(target) };
            report.push({ object: `home:${username}`, status: 'restored', action: 'replace', files: summary.files, rollbackDir: previous });
          }
        }
        if (staged.dbFile) {
          const restore = restoreDbFile(staged.dbFile);
          if (!restore.ok) throw new OperationError(`Database restore failed: ${restore.error}`, 'db_restore_failed');
          dbRestored = true;
          report.push(...restore.report);
          ensureJobSchemaAfterRestore();
        }
        if (process.env.OA_RESTORE_FAULT === 'after-apply' || ctx.job.payload?.__fault === 'after-apply') {
          throw new Error('injected restore fault after apply (test hook)');
        }
        return { report, dbRestored };
      } catch (error) {
        const rollback = rollbackHomes(swapped);
        let dbRollback = null;
        if (dbRestored && restorePointDb) {
          dbRollback = restoreDbFile(restorePointDb);
        }
        ctx.setResult({ rolledBack: rollback.ok, dbRollback: dbRollback?.ok ?? null, error: error.message });
        throw new OperationError(
          `restore failed: ${error.message}${rollback.ok ? ' (files restored)' : ' (FILE ROLLBACK FAILED)'}${dbRollback ? (dbRollback.ok ? ' (database restored)' : ' (DATABASE ROLLBACK FAILED)') : ''}`,
          'apply_failed',
          { rolledBack: rollback.ok, dbRollback: dbRollback?.ok ?? null, rollbackErrors: rollback.errors },
        );
      }
    });

    const report = ctx.step('report', () => {
      // Post-restore validation: the live connection must see the restored data.
      const counts = {
        users: Number(get('SELECT COUNT(*) AS n FROM users')?.n || 0),
        domains: Number(get('SELECT COUNT(*) AS n FROM domains')?.n || 0),
        settings: Number(get('SELECT COUNT(*) AS n FROM settings')?.n || 0),
      };
      if (counts.users < 1) throw new OperationError('restored database has no users; rollback required', 'smoke_failed');
      const outcome = {
        objects: applied.report,
        dbRestored: applied.dbRestored,
        preRestore: snapshot.backup,
        restorePoint: snapshot,
        sha256: verified.sha256,
        counts,
      };
      for (const swap of swapped) {
        try { fs.rmSync(swap.previous, { recursive: true, force: true }); } catch { /* keep rollback dir */ }
      }
      run('UPDATE backup_runs SET restored_at=?, restore_job_id=?, report=?, sha256=COALESCE(sha256,?) WHERE id=?',
        nowIso(), ctx.job.id, JSON.stringify(outcome), verified.sha256, row.id);
      audit(payload.requestedBy || 'admin', 'admin', 'backup.restore', row.filename, '');
      return outcome;
    });
    return { ok: true, ...report };
  } finally {
    if (stagingRoot) { try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* ignore */ } }
    if (resolved.temp) { try { fs.rmSync(resolved.temp, { force: true }); } catch { /* ignore */ } }
  }
}

function rollbackHomes(swapped) {
  const errors = [];
  for (const swap of [...swapped].reverse()) {
    try {
      if (fs.existsSync(swap.target)) {
        const failed = `${swap.target}.failed-${Date.now()}`;
        fs.renameSync(swap.target, failed);
        try { fs.rmSync(failed, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      if (swap.movedPrevious && fs.existsSync(swap.previous)) fs.renameSync(swap.previous, swap.target);
    } catch (error) {
      errors.push(`${swap.target}: ${error.message}`);
    }
  }
  return { ok: !errors.length, errors };
}

function ensureJobSchemaAfterRestore() {
  try {
    ensureBackupScheduleSchema();
  } catch (error) {
    console.warn('[openadmin] backup schema after restore:', error.message);
  }
}

export function restoreRun(runId, { dryRun = true, actor = 'admin', wait = true } = {}) {
  ensureBackupScheduleSchema();
  const row = get('SELECT * FROM backup_runs WHERE id = ?', Number(runId));
  if (!row) return { ok: false, error: 'Backup run not found' };
  if (dryRun) return previewRestoreRun(runId);
  const bucket = Math.floor(Date.now() / 60000);
  const operation = createJob({
    kind: 'backup.restore.server',
    stages: RESTORE_STAGES,
    actor,
    target: `restore-run:${row.id}`,
    payload: { runId: row.id, requestedBy: actor },
    idempotencyKey: `backup.restore:run:${row.id}:${bucket}`,
    maxAttempts: 2,
  });
  if (!wait) return { ok: true, queued: true, jobId: operation.job.id, job: operation.job };
  const outcome = executeJobSync(operation.job.id);
  if (!outcome.ok) {
    const detail = outcome.result || {};
    return { ok: false, error: outcome.error, jobId: operation.job.id, rolledBack: !!detail.rolledBack };
  }
  return { ...outcome.result, ok: true, jobId: operation.job.id };
}

/* -------------------------------------------------------------------------- */
/* Restore of a user backup through the backup center                         */
/* -------------------------------------------------------------------------- */

export function listRestorableRuns(limit = 50) {
  return all("SELECT * FROM backup_runs WHERE status = 'complete' ORDER BY id DESC LIMIT ?", Number(limit));
}

registerJobHandler('backup.job.run', backupJobHandler, { mode: 'sync' });
registerJobHandler('backup.restore.server', restoreServerHandler, { mode: 'sync' });

export { jobView };
