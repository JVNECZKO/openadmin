// Background housekeeping: scheduled backups, retention and admin alerts.
import fs from 'node:fs';
import { all, get, run, nowIso, setting, setSetting } from './db.mjs';
import { createServerBackup, backupPath } from './backups.mjs';
import { sendMail, mtaStatus } from './mta.mjs';

export function notifyAdmin(subject, body) {
  const admin = get("SELECT * FROM users WHERE level = 'admin' ORDER BY id LIMIT 1");
  const email = setting('notify_email', admin?.email || '');
  run('INSERT INTO messages(level, username, subject, body, created_at) VALUES(?,?,?,?,?)',
    'admin', admin?.username || null, subject, body, nowIso());
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
export function startScheduler() {
  if (timer) return timer;
  const tick = () => {
    try { runBackupJob(); } catch (e) { console.warn('[openadmin] backup:', e.message); }
    try { checkCertificateExpiry(); } catch (e) { console.warn('[openadmin] certs:', e.message); }
  };
  setTimeout(tick, 60 * 1000).unref?.();
  timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref?.();
  return timer;
}
