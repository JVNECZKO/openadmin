// Background housekeeping: scheduled backups, retention, automation and alerts.
import fs from 'node:fs';
import { all, get, run, nowIso, setting, setSetting } from './db.mjs';
import { createServerBackup, backupPath } from './backups.mjs';
import { runDueJobs } from './backupcenter.mjs';
import { sendMail, mtaStatus } from './mta.mjs';
import { dispatch, channels, addNotification, notifyAutomationFailure } from './notifications.mjs';
import { automationTick, seedAutomationJobs, recoverInterruptedRuns } from './automation.mjs';

export { automationStatus } from './automation.mjs';

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
    return { ok: true, filename: backup.filename, size: backup.size };
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

let timer = null;
let legacyTimer = null;

const AUTOMATION_TICK_MS = Math.max(5000, Number(process.env.OA_AUTOMATION_TICK_MS) || 20 * 1000);

export function startScheduler() {
  if (timer) return timer;
  try {
    seedAutomationJobs();
    recoverInterruptedRuns();
  } catch (e) {
    console.warn('[openadmin] automation init:', e.message);
  }

  // Fast tick: durable automation jobs due by next_run_at. Every error is
  // contained here so a failing job can never take the HTTP server down.
  const tick = () => {
    automationTick().catch((e) => console.warn('[openadmin] automation:', e.message));
  };
  setTimeout(tick, Math.min(3000, AUTOMATION_TICK_MS)).unref?.();
  timer = setInterval(tick, AUTOMATION_TICK_MS);
  timer.unref?.();

  // Legacy hourly housekeeping is kept for the Backup Center scheduler jobs
  // and the daily certificate-expiry notification. Automatic server backups
  // themselves now run through the durable backup.daily automation job.
  const legacyTick = () => {
    try {
      for (const result of runDueJobs()) {
        if (result && result.ok === false) {
          void notifyAutomationFailure({
            source: 'backup-center',
            title: 'Backup Center job failed',
            body: result.error || 'Backup job failed',
            link: '/admin/backup-center',
          }).catch(() => {});
        }
      }
    } catch (e) { console.warn('[openadmin] backup jobs:', e.message); }
    try { checkCertificateExpiry(); } catch (e) { console.warn('[openadmin] certs:', e.message); }
  };
  setTimeout(legacyTick, 60 * 1000).unref?.();
  legacyTimer = setInterval(legacyTick, 60 * 60 * 1000);
  legacyTimer.unref?.();
  return timer;
}
