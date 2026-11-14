// Durable scheduler. SQLite is the source of truth: next_run_at, leases and run
// history survive restarts; timers only wake the process up. Multiple panel
// instances coordinate through scheduler_leases and operation job leases, so a
// second instance never duplicates a scheduled run.
import fs from 'node:fs';
import os from 'node:os';
import { all, get, run, nowIso, setting, setSetting } from './db.mjs';
import { createServerBackup, backupPath, ensureJobSchema, processQueuedJobs, recoverInterruptedJobs } from './backups.mjs';
import { enqueueDueJobs, ensureBackupScheduleSchema, recoverStaleBackupLeases, schedulerTimezone } from './backupcenter.mjs';
import { sendMail, mtaStatus } from './mta.mjs';
import { dispatch, channels, addNotification, notifyAutomationFailure } from './notifications.mjs';
import { automationTick, seedAutomationJobs, recoverInterruptedRuns } from './automation.mjs';

export { automationStatus } from './automation.mjs';

export const SCHEDULER_TICK_MS = Math.max(5000, Number(process.env.OA_AUTOMATION_TICK_MS) || 20 * 1000);
const AUTOMATION_LEASE = 'automation.tick';
const LEASE_TTL_MS = 30 * 60 * 1000;

export function notifyAdmin(subject, body) {
  const admin = get("SELECT * FROM users WHERE level = 'admin' ORDER BY id LIMIT 1");
  const email = setting('notify_email', admin?.email || '');
  run('INSERT INTO messages(level, username, subject, body, created_at) VALUES(?,?,?,?,?)',
    'admin', admin?.username || null, subject, body, nowIso());
  if (channels().some((c) => c.enabled)) {
    dispatch(subject, body, { userId: admin?.id || null, level: 'warn' }).catch(() => {});
    return { ok: true, emailed: true, output: 'Dispatched to notification channels' };
  }
  addNotification({ userId: admin?.id || null, level: 'warn', title: subject, body });
  if (!email || !mtaStatus().available) return { ok: false, emailed: false };
  const sent = sendMail({ from: `panel@${setting('server_name', 'localhost')}`, to: email, subject: `[OpenAdmin] ${subject}`, body });
  return { ok: true, emailed: sent.ok, output: sent.output };
}

export function backupSettings() {
  return {
    enabled: setting('backup_enabled', '1') === '1',
    retentionDays: Number(setting('backup_retention_days', '14')) || 14,
    keep: Number(setting('backup_keep', '3')) || 3,
    notifyEmail: setting('notify_email', ''),
    lastRun: setting('backup_last_run', ''),
    timezone: schedulerTimezone(),
  };
}

export function runBackupJob({ force = false } = {}) {
  const cfg = backupSettings();
  if (!cfg.enabled && !force) return { ok: true, skipped: 'disabled' };
  const today = new Date().toISOString().slice(0, 10);
  const existing = get("SELECT * FROM backups WHERE filename LIKE 'admin_backup_%' AND created_at LIKE ?", `${today}%`);
  if (existing && !force) return { ok: true, skipped: 'already-today' };
  const admin = get("SELECT * FROM users WHERE level = 'admin' ORDER BY id LIMIT 1");
  if (!admin) return { ok: false, error: 'no admin account' };
  try {
    const backup = createServerBackup(admin, 'all');
    setSetting('backup_last_run', nowIso());
    pruneBackups(cfg);
    return { ok: true, filename: backup.filename, size: backup.size, jobId: backup.jobId, sha256: backup.sha256 };
  } catch (e) {
    notifyAdmin('Kopia zapasowa nie powiodła się', `Błąd: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

export function pruneBackups(cfg = backupSettings()) {
  const rows = all("SELECT * FROM backups WHERE filename LIKE 'admin_backup_%' ORDER BY created_at DESC");
  const cutoff = Date.now() - cfg.retentionDays * 864e5;
  let removed = 0;
  rows.forEach((row, index) => {
    if (index < cfg.keep) return;
    if (new Date(row.created_at).getTime() > cutoff) return;
    try { fs.rmSync(backupPath(row.filename), { force: true }); } catch { /* ignore */ }
    run('DELETE FROM backups WHERE id = ?', row.id);
    removed++;
  });
  return removed;
}

export function checkCertificateExpiry() {
  const day = new Date().toISOString().slice(0, 10);
  if (setting('cert_notify_date', '') === day) return;
  const soon = all("SELECT domain, expires_at FROM ssl_certs WHERE status = 'active' AND expires_at IS NOT NULL");
  const expiring = soon.filter((c) => new Date(c.expires_at).getTime() - Date.now() < 30 * 864e5);
  if (expiring.length) {
    notifyAdmin('Certyfikaty wygasają', expiring.map((c) => `${c.domain}: ${c.expires_at}`).join('\n'));
  }
  setSetting('cert_notify_date', day);
}

/* -------------------------------------------------------------------------- */
/* Leases                                                                     */
/* -------------------------------------------------------------------------- */

export function ensureSchedulerSchema() {
  ensureJobSchema();
}

function leaseOwner() {
  return `${os.hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
}

/** Atomic single-winner lease; expired leases are taken over. */
export function claimSchedulerLease(name, { owner = leaseOwner(), ttlMs = LEASE_TTL_MS } = {}) {
  ensureSchedulerSchema();
  const now = new Date();
  const acquiredAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + Math.max(1000, ttlMs)).toISOString();
  run(
    `INSERT INTO scheduler_leases(name, owner, acquired_at, heartbeat_at, expires_at)
     VALUES(?,?,?,?,?)
     ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, acquired_at = excluded.acquired_at,
       heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at
     WHERE scheduler_leases.owner = excluded.owner OR scheduler_leases.expires_at < excluded.acquired_at`,
    name, owner, acquiredAt, acquiredAt, expiresAt,
  );
  const row = get('SELECT * FROM scheduler_leases WHERE name = ?', name);
  return row?.owner === owner ? { ok: true, owner, expires_at: expiresAt } : { ok: false, owner: row?.owner || null, expires_at: row?.expires_at || null };
}

export function releaseSchedulerLease(name, owner) {
  if (!owner) return 0;
  return run('DELETE FROM scheduler_leases WHERE name = ? AND owner = ?', name, owner).changes;
}

export function schedulerStatus({ now = Date.now() } = {}) {
  ensureSchedulerSchema();
  ensureBackupScheduleSchema();
  const instant = new Date(Number(now) || Date.now()).toISOString();
  const leases = all('SELECT * FROM scheduler_leases ORDER BY name');
  const operation = all("SELECT status, COUNT(*) AS n FROM operation_jobs GROUP BY status");
  const nextBackups = all(
    `SELECT id, name, schedule, timezone, schedule_time, next_run_at, enabled, last_status, last_run_at
     FROM backup_jobs ORDER BY COALESCE(next_run_at, '') ASC LIMIT 10`,
  );
  return {
    timezone: schedulerTimezone(),
    tick_ms: SCHEDULER_TICK_MS,
    now: instant,
    leases,
    operation_jobs: operation,
    next_backup_jobs: nextBackups,
    automation: automationJobSummary(),
  };
}

function automationJobSummary() {
  try {
    const rows = all('SELECT key, enabled, next_run_at, last_status, run_count, fail_count FROM automation_jobs ORDER BY key');
    return rows;
  } catch { return []; }
}

/* -------------------------------------------------------------------------- */
/* Tick                                                                       */
/* -------------------------------------------------------------------------- */

let lastTick = null;

/**
 * One durable scheduler tick. Safe to call from any instance: every state
 * transition is a database compare-and-set (leases / next_run_at), the timer is
 * only a wake-up source.
 */
export async function schedulerTick({ now = Date.now(), limit = 2 } = {}) {
  ensureSchedulerSchema();
  const started = Date.now();
  const recoveredJobs = recoverInterruptedJobs({ now });
  const recoveredAutomation = recoverInterruptedRuns();
  const staleLeases = recoverStaleBackupLeases({ now });
  const due = enqueueDueJobs({ now, owner: `scheduler:${os.hostname()}:${process.pid}` });
  const queue = processQueuedJobs({ limit, now, inline: process.env.OA_JOB_INLINE === '1' });

  let automation = null;
  const lease = claimSchedulerLease(AUTOMATION_LEASE, { ttlMs: LEASE_TTL_MS });
  if (lease.ok) {
    try {
      automation = await automationTick({ now });
    } catch (error) {
      automation = { enabled: false, due: 0, ran: [], error: error.message };
    } finally {
      releaseSchedulerLease(AUTOMATION_LEASE, lease.owner);
    }
  } else {
    automation = { enabled: false, due: 0, ran: [], skipped: 'lease-held-by-other-instance' };
  }

  lastTick = { at: nowIso(), duration_ms: Date.now() - started, due: due.queued.length, spawned: queue.spawned.length, recovered: recoveredJobs.length };
  return {
    now: new Date(now).toISOString(),
    timezone: schedulerTimezone(),
    recovered: { jobs: recoveredJobs, automation: recoveredAutomation, backup_leases: staleLeases },
    enqueued: due.queued,
    skipped: due.skipped,
    queue,
    automation,
    duration_ms: lastTick.duration_ms,
  };
}

let timer = null;
let kickTimer = null;

export function startScheduler() {
  if (timer) return timer;
  try {
    ensureSchedulerSchema();
    seedAutomationJobs();
    recoverInterruptedRuns();
    recoverInterruptedJobs();
    recoverStaleBackupLeases();
  } catch (e) {
    console.warn('[openadmin] scheduler init:', e.message);
  }

  // Resume an update that deliberately restarted the panel. The pending state
  // file and the durable job (not the old process) own the transaction.
  import('./updates.mjs')
    .then((updates) => {
      if (typeof updates.resumePendingUpdate === 'function') return updates.resumePendingUpdate();
      return null;
    })
    .catch((e) => console.warn('[openadmin] update resume:', e.message));

  const tick = () => {
    schedulerTick().catch((e) => console.warn('[openadmin] scheduler:', e.message));
  };
  // A long custom interval (used by tests) intentionally suppresses the early
  // wake-up; the durable queue is still processed on the regular interval.
  const initialDelay = SCHEDULER_TICK_MS >= 600000 ? SCHEDULER_TICK_MS : Math.min(5000, SCHEDULER_TICK_MS);
  kickTimer = setTimeout(tick, initialDelay);
  kickTimer.unref?.();
  timer = setInterval(tick, SCHEDULER_TICK_MS);
  timer.unref?.();
  return timer;
}

/** Stop the wake-up timers (state remains durable in SQLite). */
export function stopScheduler() {
  if (timer) clearInterval(timer);
  if (kickTimer) clearTimeout(kickTimer);
  timer = null;
  kickTimer = null;
}

export function schedulerLastTick() {
  return lastTick;
}
