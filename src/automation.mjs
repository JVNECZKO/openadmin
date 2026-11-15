// Durable background automation engine.
//
// Jobs live in SQLite (automation_jobs) and every attempt is recorded in
// automation_runs, so a panel restart never loses the schedule or the history.
// The engine intentionally has no timers of its own: scheduler.mjs drives it so
// tests can call automationTick() deterministically.
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, nowIso, setting, setSetting, audit } from './db.mjs';
import { config } from './config.mjs';
import { listStorage } from './storage.mjs';
import { homeRoot } from './paths.mjs';
import { formatBytes } from './util.mjs';
import { deriveJobObservation } from './metrics.mjs';

export const MIN_INTERVAL_SECONDS = 15;
export const MAX_INTERVAL_SECONDS = 30 * 86400;
export const AUTOMATION_STATUS_VERSION = 1;
const RUNS_KEPT_PER_JOB = 200;
const OUTPUT_LIMIT = 4000;
const STATUSES = ['ok', 'warn', 'skipped', 'unavailable', 'error'];

// `initialDelaySeconds` is only used when a job is first seeded, so a fresh
// install does not start every job at the same instant.
export const AUTOMATION_JOBS = [
  {
    key: 'health.check', label: 'Health check', interval_seconds: 300, initialDelaySeconds: 10,
    description: 'Runs the existing health report and records its summary.',
  },
  {
    key: 'mail.queue', label: 'Mail queue check', interval_seconds: 300, initialDelaySeconds: 20,
    description: 'Counts Exim/panel queue items; retry is opt-in only.',
  },
  {
    key: 'disk.check', label: 'Disk usage check', interval_seconds: 900, initialDelaySeconds: 30,
    description: 'Measures panel and configured storage paths and notifies above the threshold.',
  },
  {
    key: 'backup.daily', label: 'Daily server backup', interval_seconds: 86400, initialDelaySeconds: 60,
    description: 'Creates one server backup per day; reuses the existing backup engine.',
  },
  {
    key: 'cleanup.tmp', label: 'Panel temp cleanup', interval_seconds: 86400, initialDelaySeconds: 120,
    description: 'Deletes old panel-owned staging/cache entries; never touches homes.',
  },
  {
    key: 'ssl.renew', label: 'SSL renewal', interval_seconds: 86400, initialDelaySeconds: 180,
    description: 'Renews certificates expiring within 30 days through AutoSSL.',
  },
  {
    key: 'backup.prune', label: 'Backup retention', interval_seconds: 86400, initialDelaySeconds: 300,
    description: 'Prunes expired server backups using the existing retention settings.',
  },
];

const DEFINITIONS = new Map(AUTOMATION_JOBS.map((job) => [job.key, job]));

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function numberSetting(value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, min, max) : fallback;
}

function boolSetting(key, fallback = true) {
  const value = setting(key, fallback ? '1' : '0');
  return !/^(0|false|off|no)$/i.test(String(value));
}

export function automationSettings() {
  return {
    enabled: boolSetting('automation_enabled', true),
    diskThreshold: numberSetting(setting('automation_disk_threshold', '90'), 90, 50, 99),
    tmpDays: numberSetting(setting('automation_tmp_days', '7'), 7, 1, 365),
    mailRetry: boolSetting('automation_mail_retry', false),
  };
}

/** Parse "30", "30s", "15m", "2h", "1d" (or "1w") into seconds. */
export function parseInterval(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).trim().toLowerCase();
  let seconds = null;
  if (/^\d+$/.test(text)) {
    seconds = Number(text);
  } else {
    const match = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/.exec(text);
    if (match) {
      const factors = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
      seconds = Number(match[1]) * factors[match[2][0]];
    }
  }
  if (!Number.isFinite(seconds) || seconds < 1) return null;
  return clamp(seconds, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS);
}

export function formatInterval(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (!total) return '—';
  if (total % 86400 === 0) return `${total / 86400} d`;
  if (total % 3600 === 0) return `${total / 3600} h`;
  if (total % 60 === 0) return `${total / 60} min`;
  return `${total} s`;
}

function dueAt(iso, now = Date.now()) {
  if (!iso) return true;
  const time = new Date(iso).getTime();
  return !Number.isFinite(time) || time <= Number(now);
}

/** Insert missing job definitions. Existing rows are never overwritten. */
export function seedAutomationJobs() {
  const now = Date.now();
  let created = 0;
  for (const job of AUTOMATION_JOBS) {
    if (get('SELECT key FROM automation_jobs WHERE key = ?', job.key)) continue;
    const next = new Date(now + (job.initialDelaySeconds || 30) * 1000).toISOString();
    const result = run(
      `INSERT OR IGNORE INTO automation_jobs(key, label, enabled, interval_seconds, next_run_at, last_status, run_count, fail_count)
       VALUES(?,?,?,?,?,?,?,?)`,
      job.key, job.label, 1, job.interval_seconds, next, 'pending', 0, 0,
    );
    if (result.changes) created++;
  }
  return { created, total: get('SELECT COUNT(*) AS n FROM automation_jobs').n };
}

/** A durable snapshot that is safe to JSON.stringify(). */
export function automationStatus() {
  seedAutomationJobs();
  const cfg = automationSettings();
  const now = Date.now();
  const jobs = all('SELECT * FROM automation_jobs ORDER BY key').map((job) => {
    const definition = DEFINITIONS.get(job.key);
    const next = job.next_run_at ? new Date(job.next_run_at).getTime() : NaN;
    return {
      ...job,
      enabled: !!job.enabled,
      description: definition?.description || '',
      due: cfg.enabled && !!job.enabled && dueAt(job.next_run_at, now),
      next_in_seconds: Number.isFinite(next) ? Math.max(0, Math.round((next - now) / 1000)) : null,
      observation: deriveJobObservation({ key: job.key, status: job.last_status, output: job.last_output, error: job.last_error || (job.last_status === 'error' ? job.last_output : '') }),
    };
  });
  return {
    version: AUTOMATION_STATUS_VERSION,
    enabled: cfg.enabled,
    due: jobs.filter((job) => job.due).length,
    totals: {
      jobs: jobs.length,
      enabled: jobs.filter((job) => job.enabled).length,
      failures: jobs.reduce((sum, job) => sum + Number(job.fail_count || 0), 0),
      critical: jobs.filter((job) => job.observation?.observedStatus === 'critical').length,
      warning: jobs.filter((job) => job.observation?.observedStatus === 'warning').length,
    },
    settings: {
      disk_threshold: cfg.diskThreshold,
      tmp_days: cfg.tmpDays,
      mail_retry: cfg.mailRetry,
    },
    jobs,
    lastRuns: all('SELECT * FROM automation_runs ORDER BY id DESC LIMIT 20').map((run) => ({
      ...run,
      observation: deriveJobObservation({ key: run.job_key, status: run.status, output: run.output, error: run.error }),
    })),
    generated_at: new Date(now).toISOString(),
  };
}

export function saveAutomationSettings(body = {}, actor = 'admin') {
  const enabled = body.enabled === undefined ? boolSetting('automation_enabled', true)
    : /^(1|true|on|yes)$/i.test(String(body.enabled));
  const current = automationSettings();
  const diskThreshold = numberSetting(body.disk_threshold ?? setting('automation_disk_threshold', '90'), current.diskThreshold, 50, 99);
  const tmpDays = numberSetting(body.tmp_days ?? setting('automation_tmp_days', '7'), current.tmpDays, 1, 365);
  const mailRetry = body.mail_retry === undefined ? boolSetting('automation_mail_retry', false)
    : /^(1|true|on|yes)$/i.test(String(body.mail_retry));
  setSetting('automation_enabled', enabled ? '1' : '0');
  setSetting('automation_disk_threshold', diskThreshold);
  setSetting('automation_tmp_days', tmpDays);
  setSetting('automation_mail_retry', mailRetry ? '1' : '0');
  if (enabled) {
    run("UPDATE automation_jobs SET next_run_at = ? WHERE enabled = 1 AND next_run_at IS NULL", nowIso());
  }
  audit(actor, 'admin', 'automation.settings', `enabled=${enabled ? 1 : 0}`, '');
  return { ok: true, settings: automationSettings() };
}

export function updateAutomationJob(key, body = {}, actor = 'admin') {
  seedAutomationJobs();
  const job = get('SELECT * FROM automation_jobs WHERE key = ?', String(key));
  if (!job) return { ok: false, error: 'Job not found' };
  const interval = parseInterval(body.interval_seconds);
  if (interval === null) {
    return { ok: false, error: `Interval must be between ${MIN_INTERVAL_SECONDS}s and 30 days (e.g. 30s, 15m, 24h)` };
  }
  const enabled = body.enabled === undefined ? job.enabled
    : /^(1|true|on|yes)$/i.test(String(body.enabled)) ? 1 : 0;
  const next = enabled ? new Date(Date.now() + interval * 1000).toISOString() : null;
  run('UPDATE automation_jobs SET enabled = ?, interval_seconds = ?, next_run_at = ? WHERE key = ?',
    enabled, interval, next, job.key);
  audit(actor, 'admin', 'automation.job.update', `${job.key}:${interval}s:${enabled ? 'on' : 'off'}`, '');
  return { ok: true, job: get('SELECT * FROM automation_jobs WHERE key = ?', job.key) };
}

export function setAutomationJobEnabled(key, enabled, actor = 'admin') {
  seedAutomationJobs();
  const job = get('SELECT * FROM automation_jobs WHERE key = ?', String(key));
  if (!job) return { ok: false, error: 'Job not found' };
  const next = enabled ? nowIso() : null;
  run('UPDATE automation_jobs SET enabled = ?, next_run_at = ? WHERE key = ?', enabled ? 1 : 0, next, job.key);
  audit(actor, 'admin', 'automation.job.toggle', `${job.key}:${enabled ? 'on' : 'off'}`, '');
  return { ok: true, job: get('SELECT * FROM automation_jobs WHERE key = ?', job.key) };
}

export function toggleAutomationJob(key, actor = 'admin') {
  const job = get('SELECT * FROM automation_jobs WHERE key = ?', String(key));
  if (!job) return { ok: false, error: 'Job not found' };
  return setAutomationJobEnabled(key, !job.enabled, actor);
}

export function clearAutomationFailures(actor = 'admin') {
  const before = get('SELECT COALESCE(SUM(fail_count), 0) AS n FROM automation_jobs').n;
  run('UPDATE automation_jobs SET fail_count = 0');
  audit(actor, 'admin', 'automation.failures.clear', String(before), '');
  return { ok: true, cleared: Number(before) || 0 };
}

/** Mark runs left in "running" by a crashed process as interrupted. */
export function recoverInterruptedRuns() {
  const rows = all("SELECT id FROM automation_runs WHERE status = 'running'");
  if (!rows.length) return 0;
  const finished = nowIso();
  for (const row of rows) {
    run("UPDATE automation_runs SET status = 'error', finished_at = ?, error = ? WHERE id = ?",
      finished, 'Interrupted by panel restart', row.id);
  }
  return rows.length;
}

function skipped(output) {
  return { status: 'skipped', output };
}

function unavailable(output, error = '') {
  return { status: 'unavailable', output, error };
}

function normalizeResult(result) {
  if (result === undefined || result === null) return { status: 'ok', output: 'Completed', error: '' };
  if (typeof result === 'string') return { status: 'ok', output: result, error: '' };
  let status = String(result.status || '').toLowerCase();
  if (!STATUSES.includes(status)) {
    if (result.unavailable) status = 'unavailable';
    else if (result.skipped) status = 'skipped';
    else if (result.ok === false) status = 'error';
    else if (result.warn) status = 'warn';
    else status = 'ok';
  }
  const output = String(result.output ?? result.detail ?? result.summary ?? result.error ?? status).slice(0, OUTPUT_LIMIT);
  let error = result.error ? String(result.error).slice(0, OUTPUT_LIMIT) : '';
  if (status === 'error' && !error) error = output;
  return { status, output, error };
}

/* ------------------------------- job handlers ------------------------------ */

async function jobBackupDaily() {
  const scheduler = await import('./scheduler.mjs');
  if (typeof scheduler.runBackupJob !== 'function') return unavailable('Backup engine is not available (runBackupJob missing)');
  const cfg = scheduler.backupSettings();
  if (!cfg.enabled) return skipped('Automatic backups are disabled (setting backup_enabled=0)');
  const result = scheduler.runBackupJob();
  if (!result || result.skipped === 'disabled') return skipped('Automatic backups are disabled');
  if (result.skipped === 'already-today') return skipped('A server backup already exists for today; no duplicate created');
  if (!result.ok) {
    return { status: 'error', output: `Backup failed: ${result.error || 'unknown error'}`, error: result.error || 'Backup failed' };
  }
  const size = result.size === undefined ? '' : ` (${result.size} MB)`;
  return { status: 'ok', output: `Server backup ${result.filename || 'created'}${size}` };
}

async function jobBackupPrune() {
  const scheduler = await import('./scheduler.mjs');
  if (typeof scheduler.pruneBackups !== 'function') return unavailable('Backup retention is not available (pruneBackups missing)');
  const cfg = scheduler.backupSettings();
  const removed = scheduler.pruneBackups(cfg);
  return {
    status: 'ok',
    output: `Removed ${Number(removed) || 0} expired server backup(s); retention ${cfg.retentionDays} days, keep ${cfg.keep}`,
  };
}

async function jobSslRenew() {
  let autossl;
  try {
    autossl = await import('./autossl.mjs');
  } catch (error) {
    return unavailable(`AutoSSL module is not available: ${error.message}`);
  }
  if (typeof autossl.renewExpiring !== 'function') {
    return unavailable('AutoSSL module does not expose renewExpiring()');
  }
  const active = all("SELECT domain, expires_at FROM ssl_certs WHERE status = 'active' AND expires_at IS NOT NULL");
  const due = active.filter((cert) => new Date(cert.expires_at).getTime() - Date.now() < 30 * 864e5);
  if (!due.length) {
    return { status: 'ok', output: `No certificates due for renewal (${active.length} active checked)` };
  }
  const results = await autossl.renewExpiring('scheduler');
  if (!Array.isArray(results)) return unavailable('AutoSSL renewal returned no result');
  if (!results.length) {
    return { status: 'warn', output: `${due.length} certificate(s) are due but AutoSSL produced no renewal action` };
  }
  const failed = results.filter((entry) => !entry || entry.ok === false);
  const details = results.map((entry) => `${entry.domain || 'unknown'}=${entry.ok === false ? 'failed' : 'ok'}`).join(', ');
  const missing = Math.max(0, due.length - results.length);
  if (failed.length) {
    const message = failed.map((entry) => `${entry.domain || 'unknown'}: ${entry.error || 'renewal failed'}`).join('; ');
    return { status: 'error', output: `Renewed ${results.length - failed.length}/${due.length} due certificate(s): ${details}${missing ? `; no action for ${missing}` : ''}`, error: message };
  }
  return { status: missing ? 'warn' : 'ok', output: `Renewed ${results.length}/${due.length} due certificate(s): ${details}${missing ? `; no action for ${missing}` : ''}` };
}

async function jobHealthCheck() {
  let health;
  try {
    health = await import('./health.mjs');
  } catch (error) {
    return unavailable(`Health module is not available: ${error.message}`);
  }
  if (typeof health.healthReport !== 'function') return unavailable('Health module does not expose healthReport()');
  const report = await health.healthReport();
  const counts = report?.counts || {};
  const failing = Array.isArray(report?.checks) ? report.checks.filter((check) => check.status === 'fail') : [];
  const summary = `health=${report?.summary || 'unknown'} ok=${counts.ok || 0} warn=${counts.warn || 0} fail=${counts.fail || 0}`;
  if (!failing.length) return { status: report?.summary === 'warn' ? 'warn' : 'ok', output: summary };
  const details = failing.slice(0, 5).map((check) => `${check.label || check.id}: ${check.detail || ''}`.trim()).join('; ');
  return { status: 'warn', output: `${summary}; needs attention: ${details}` };
}

async function jobMailQueue() {
  let mailops;
  try {
    mailops = await import('./mailops.mjs');
  } catch (error) {
    return unavailable(`Mail queue module is not available: ${error.message}`);
  }
  if (typeof mailops.queueList !== 'function') return unavailable('Mail queue inspector is not available (queueList missing)');
  const snap = typeof mailops.mailQueueSnapshot === 'function' ? mailops.mailQueueSnapshot() : null;
  if (!snap || snap.ok === false) return unavailable(snap?.error || 'Mail queue is unavailable', snap?.error || '');
  const rows = snap.rows;
  const summary = `${snap.source}: total=${snap.total}, deferred=${snap.deferred}, failed=${snap.failed}, queued=${snap.queued}`;
  const cfg = automationSettings();
  if (!cfg.mailRetry) return { status: 'ok', output: `${summary}; retry disabled`, observation: snap.failed > 0 ? 'critical' : snap.deferred > 0 ? 'warning' : 'ok' };
  if (typeof mailops.queueAction !== 'function') return unavailable(`${summary}; queueAction missing, retry is unavailable`);
  const candidates = rows.filter((row) => row.status === 'failed' || row.status === 'deferred').slice(0, 10);
  let retried = 0;
  const errors = [];
  for (const row of candidates) {
    const retry = mailops.queueAction(row.id, 'retry');
    if (retry?.ok) retried++;
    else errors.push(`${row.recipient || row.id}: ${retry?.error || retry?.output || 'retry failed'}`);
  }
  const output = `${summary}; retried=${retried}/${candidates.length}${errors.length ? `; errors: ${errors.slice(0, 3).join('; ')}` : ''}`;
  return errors.length ? { status: 'warn', output, error: errors[0] } : { status: 'ok', output };
}

async function jobDiskCheck() {
  const cfg = automationSettings();
  const readings = [];
  const alerts = [];
  const seen = new Set();
  const add = (label, target, threshold, used, free, total) => {
    const resolved = path.resolve(target);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const percent = Math.round(Number(used) * 10) / 10;
    readings.push({ label, path: target, percent, free, total, threshold });
    if (percent >= threshold) alerts.push({ label, path: target, percent, threshold });
  };
  try {
    const stat = fs.statfsSync(config.dataDir);
    const total = stat.blocks * stat.bsize;
    const free = stat.bavail * stat.bsize;
    if (total > 0) add('Panel data', config.dataDir, cfg.diskThreshold, ((total - free) / total) * 100, free, total);
  } catch (error) {
    readings.push({ label: 'Panel data', path: config.dataDir, error: error.message });
  }
  for (const storage of listStorage()) {
    if (!storage.exists || !storage.total) continue;
    const threshold = clamp(storage.alert_percent || cfg.diskThreshold, 50, 99);
    add(storage.name || storage.path, storage.path, threshold, storage.used, storage.free, storage.total);
  }
  const homes = homeRoot();
  if (homes && fs.existsSync(homes) && config.provider === 'linux') {
    try {
      const stat = fs.statfsSync(homes);
      const total = stat.blocks * stat.bsize;
      const free = stat.bavail * stat.bsize;
      if (total > 0) add('Home directories', homes, cfg.diskThreshold, ((total - free) / total) * 100, free, total);
    } catch { /* unreadable home filesystem is not fatal */ }
  }
  if (!readings.some((reading) => !reading.error)) return unavailable('No storage path could be measured', readings.map((r) => r.error).filter(Boolean).join('; '));
  const summary = readings.map((reading) => reading.error
    ? `${reading.label}: unavailable (${reading.error})`
    : `${reading.label}: ${reading.percent}% used, ${formatBytes(reading.free / 1024 / 1024)} free`).join('; ');
  if (!alerts.length) {
    if (setting('automation_disk_alert_state', '')) setSetting('automation_disk_alert_state', '');
    return { status: 'ok', output: summary };
  }
  const state = `${nowIso().slice(0, 10)}|${alerts.map((alert) => `${alert.path}=${alert.percent}`).join('|')}`;
  let notification = 'already notified today';
  if (setting('automation_disk_alert_state', '') !== state) {
    try {
      const scheduler = await import('./scheduler.mjs');
      if (typeof scheduler.notifyAdmin === 'function') {
        scheduler.notifyAdmin('Dysk prawie pełny', alerts.map((alert) => `${alert.label} (${alert.path}): ${alert.percent}% ≥ ${alert.threshold}%`).join('\n'));
        setSetting('automation_disk_alert_state', state);
        notification = 'admin notified';
      } else {
        notification = 'notification helper unavailable';
      }
    } catch (error) {
      notification = `notification failed: ${error.message}`;
    }
  }
  return {
    status: 'warn',
    output: `${summary}; threshold crossed: ${alerts.map((alert) => `${alert.label} ${alert.percent}%`).join(', ')}; ${notification}`,
  };
}

async function jobCleanupTmp() {
  const days = automationSettings().tmpDays;
  const cutoff = Date.now() - days * 864e5;
  const targets = new Map();
  const dataRoot = path.resolve(config.dataDir);
  const homes = path.resolve(homeRoot());
  const isInsideHomes = (target) => {
    const resolved = path.resolve(target);
    return resolved === homes || resolved.startsWith(homes + path.sep);
  };
  const add = (target) => {
    try {
      const resolved = path.resolve(target);
      const relative = path.relative(dataRoot, resolved);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
      if (isInsideHomes(resolved)) return;
      const stat = fs.lstatSync(resolved);
      if (stat.mtimeMs >= cutoff) return;
      targets.set(resolved, stat);
    } catch { /* vanished or unreadable entries are skipped */ }
  };
  try {
    for (const entry of fs.readdirSync(dataRoot, { withFileTypes: true })) {
      if (/^(backup-stage-|restore-|restore-download-|cert-check-|import-|live-import-)/.test(entry.name)) {
        add(path.join(dataRoot, entry.name));
      }
    }
  } catch { /* data directory not readable; nothing to clean */ }
  for (const cacheDir of [path.join(dataRoot, 'appcache'), path.join(dataRoot, 'apps', 'cache')]) {
    try {
      for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) add(path.join(cacheDir, entry.name));
    } catch { /* cache directory does not exist */ }
  }
  try {
    for (const entry of fs.readdirSync(path.join(dataRoot, 'apps'), { withFileTypes: true })) {
      if (entry.name.startsWith('.install-')) add(path.join(dataRoot, 'apps', entry.name));
    }
  } catch { /* apps directory does not exist */ }
  try {
    for (const entry of fs.readdirSync(path.join(dataRoot, 'updates'), { withFileTypes: true })) {
      if (entry.name.startsWith('stage-')) add(path.join(dataRoot, 'updates', entry.name));
    }
  } catch { /* updates directory does not exist */ }
  let removed = 0;
  const errors = [];
  for (const [target, stat] of targets) {
    try {
      fs.rmSync(target, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: true });
      removed++;
    } catch (error) {
      errors.push(`${path.basename(target)}: ${error.message}`);
    }
  }
  const output = `Removed ${removed} panel temp/cache item(s) older than ${days} day(s); homes and backups untouched`;
  return errors.length ? { status: 'warn', output: `${output}; errors: ${errors.slice(0, 3).join('; ')}`, error: errors[0] } : { status: 'ok', output };
}

const HANDLERS = {
  'backup.daily': jobBackupDaily,
  'backup.prune': jobBackupPrune,
  'ssl.renew': jobSslRenew,
  'health.check': jobHealthCheck,
  'mail.queue': jobMailQueue,
  'disk.check': jobDiskCheck,
  'cleanup.tmp': jobCleanupTmp,
};

const inFlight = new Set();
let tickInFlight = false;

function notifyJobFailure(job, error, output) {
  // backup.daily already calls notifyAdmin() inside runBackupJob(); a second
  // alert here would be noise. Every other job reports through the shared
  // deduplicating automation-failure helper.
  if (job.key === 'backup.daily') return;
  // Fire-and-forget: the run history is already durable and must not wait on
  // e-mail/webhook delivery. notifications.mjs deduplicates repeated alerts.
  import('./notifications.mjs')
    .then(({ notifyAutomationFailure }) => {
      if (typeof notifyAutomationFailure !== 'function') return null;
      return notifyAutomationFailure({
        source: job.key,
        title: `Automation job failed: ${job.label}`,
        body: `${job.key}: ${error || output || 'unknown error'}`,
        link: '/admin/automation',
      });
    })
    .catch(() => {});
}

function writeRun(runId, status, output, error, job) {
  const finished = nowIso();
  if (runId !== null) {
    run('UPDATE automation_runs SET finished_at = ?, status = ?, output = ?, error = ? WHERE id = ?',
      finished, status, output, error || null, runId);
  }
  const next = job.enabled ? new Date(Date.now() + Number(job.interval_seconds) * 1000).toISOString() : null;
  const stored = error && !output.includes(error) ? `${output}\n${error}` : output;
  run(`UPDATE automation_jobs
         SET last_run_at = ?, next_run_at = ?, last_status = ?, last_output = ?,
             run_count = run_count + 1, fail_count = fail_count + ?
       WHERE key = ?`,
    finished, next, status, stored.slice(0, OUTPUT_LIMIT), status === 'error' ? 1 : 0, job.key);
  run(`DELETE FROM automation_runs
        WHERE job_key = ?
          AND id NOT IN (SELECT id FROM automation_runs WHERE job_key = ? ORDER BY id DESC LIMIT ?)`,
    job.key, job.key, RUNS_KEPT_PER_JOB);
  return finished;
}

/**
 * Run one job. Scheduled runs respect the global switch and the job switch;
 * manual runs are explicit operator actions and therefore bypass them.
 */
export async function runAutomationJob(key, { trigger = 'manual', actor = 'admin' } = {}) {
  seedAutomationJobs();
  const job = get('SELECT * FROM automation_jobs WHERE key = ?', String(key));
  if (!job) return { ok: false, status: 'unavailable', output: `Unknown automation job: ${key}`, error: 'Job not found' };
  if (trigger === 'schedule') {
    if (!automationSettings().enabled) return { ok: false, status: 'skipped', output: 'Automatic execution is disabled globally', skipped: true };
    if (!job.enabled) return { ok: false, status: 'skipped', output: `${job.key} is disabled`, skipped: true };
  }
  if (inFlight.has(job.key)) {
    return { ok: false, status: 'skipped', output: `${job.key} is already running`, skipped: true };
  }
  if (trigger !== 'schedule') audit(actor, 'admin', 'automation.run', job.key, '');
  inFlight.add(job.key);
  const started = nowIso();
  let runId = null;
  let status = 'error';
  let output = '';
  let error = '';
  try {
    runId = run('INSERT INTO automation_runs(job_key, started_at, status) VALUES(?,?,?)',
      job.key, started, 'running').lastInsertRowid;
    const handler = HANDLERS[job.key];
    if (!handler) {
      status = 'unavailable';
      output = `No handler is registered for ${job.key}`;
    } else {
      const normalized = normalizeResult(await handler());
      status = normalized.status;
      output = normalized.output;
      error = normalized.error;
    }
  } catch (failure) {
    status = 'error';
    error = failure.message || String(failure);
    output = `${job.key} failed: ${error}`;
  } finally {
    try {
      writeRun(runId, status, output, error, job);
    } catch (failure) {
      console.warn('[openadmin] automation record:', failure.message);
    }
    if (status === 'error') notifyJobFailure(job, error, output);
    inFlight.delete(job.key);
  }
  const observation = deriveJobObservation({ key: job.key, status, output, error });
  return { ok: status === 'ok' || status === 'warn', status, output, error, observation: observation.observedStatus, executionStatus: observation.executionStatus, observedStatus: observation.observedStatus, job: get('SELECT * FROM automation_jobs WHERE key = ?', job.key) };
}

/** One scheduler tick: run jobs whose next_run_at is due. Never throws per job. */
export async function automationTick({ now = Date.now(), limit = 10 } = {}) {
  if (tickInFlight) {
    return { enabled: automationSettings().enabled, due: 0, ran: [], skipped: 'tick-in-progress' };
  }
  tickInFlight = true;
  try {
    seedAutomationJobs();
    const cfg = automationSettings();
    if (!cfg.enabled) return { enabled: false, due: 0, ran: [], skipped: 'disabled' };
    const instant = new Date(Number(now) || Date.now()).toISOString();
    const due = all(
      `SELECT key FROM automation_jobs
        WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)
        ORDER BY COALESCE(next_run_at, '') ASC LIMIT ?`,
      instant, Math.max(1, Number(limit) || 10),
    );
    const ran = [];
    for (const job of due) {
      try {
        ran.push(await runAutomationJob(job.key, { trigger: 'schedule', actor: 'scheduler' }));
      } catch (error) {
        ran.push({ ok: false, status: 'error', output: `${job.key} failed: ${error.message}`, error: error.message });
      }
    }
    return { enabled: true, due: due.length, ran };
  } finally {
    tickInFlight = false;
  }
}
