// Remote backup destinations, jobs and restore.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from './config.mjs';
import { all, get, run, nowIso, getDb, audit } from './db.mjs';
import { encryptSecret, decryptSecret } from './secrets.mjs';
import { createServerBackup, createUserBackup, inspectArchive, backupPath } from './backups.mjs';
import { homeRoot } from './paths.mjs';
import { which, sh, isRoot } from './sys.mjs';

export function listServers() { return all('SELECT * FROM backup_servers ORDER BY name'); }
export function listJobs() { return all('SELECT j.*, s.name AS server_name FROM backup_jobs j LEFT JOIN backup_servers s ON s.id = j.server_id ORDER BY j.name'); }
export function listRuns(limit = 100) { return all('SELECT r.*, j.name AS job_name FROM backup_runs r LEFT JOIN backup_jobs j ON j.id = r.job_id ORDER BY r.id DESC LIMIT ?', Number(limit)); }

export function saveServer(body, actor = 'admin') {
  const type = ['local', 'ftp', 'sftp', 's3'].includes(body.type) ? body.type : 'local';
  const name = String(body.name || '').trim();
  if (!name) return { ok: false, error: 'Nazwa jest wymagana' };
  const host = String(body.host || '').trim();
  const target = String(body.path || '').trim();
  if ((type === 'local') && !target) return { ok: false, error: 'Podaj katalog lokalny' };
  if (type !== 'local' && !host) return { ok: false, error: 'Podaj host' };
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

function serverUrl(s, filename) {
  if (s.type === 'ftp') return `ftp://${s.host}${s.port ? ':' + s.port : ''}${s.path.replace(/\/$/, '')}/${filename}`;
  if (s.type === 'sftp') return `sftp://${s.host}${s.port ? ':' + s.port : ''}${s.path.replace(/\/$/, '')}/${filename}`;
  return '';
}

export function testServer(server) {
  if (server.type === 'local') {
    try {
      fs.mkdirSync(server.path, { recursive: true, mode: 0o700 });
      const probe = path.join(server.path, `.openadmin-test-${Date.now()}`);
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe);
      return { ok: true, detail: `Zapis do ${server.path} działa` };
    } catch (e) { return { ok: false, detail: e.message }; }
  }
  if (server.type === 's3') {
    const aws = which('aws');
    if (!aws) return { ok: false, detail: 'Brak AWS CLI. Zainstaluj awscli lub użyj SFTP/FTP.' };
    const env = { ...process.env };
    if (server.username) env.AWS_ACCESS_KEY_ID = server.username;
    if (server.password_enc) env.AWS_SECRET_ACCESS_KEY = decryptSecret(server.password_enc);
    const r = spawnSync(aws, ['s3', 'ls', server.path.replace(/\/?$/, '/')], { encoding: 'utf8', timeout: 30000, env });
    return { ok: r.status === 0, detail: r.status === 0 ? 'Bucket dostępny' : (r.stderr || 'aws s3 ls failed').trim().slice(0, 400) };
  }
  const curl = curlBin();
  if (!curl) return { ok: false, detail: 'Brak curl' };
  const args = ['-fsS', '--max-time', '20', '--user', `${server.username || 'anonymous'}:${server.password_enc ? decryptSecret(server.password_enc) : ''}`, serverUrl(server, '').replace(/\/$/, '') + '/'];
  const r = spawnSync(curl, args, { encoding: 'utf8', timeout: 30000 });
  return { ok: r.status === 0, detail: r.status === 0 ? 'Połączenie działa' : (r.stderr || 'curl failed').trim().slice(0, 400) };
}

export function uploadFile(server, file) {
  const filename = path.basename(file);
  if (server.type === 'local') {
    try {
      fs.mkdirSync(server.path, { recursive: true, mode: 0o700 });
      fs.copyFileSync(file, path.join(server.path, filename));
      return { ok: true, destination: path.join(server.path, filename) };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  if (server.type === 's3') {
    const aws = which('aws');
    if (!aws) return { ok: false, error: 'Brak AWS CLI' };
    const env = { ...process.env };
    if (server.username) env.AWS_ACCESS_KEY_ID = server.username;
    if (server.password_enc) env.AWS_SECRET_ACCESS_KEY = decryptSecret(server.password_enc);
    const dest = server.path.replace(/\/$/, '') + '/' + filename;
    const r = spawnSync(aws, ['s3', 'cp', file, dest], { encoding: 'utf8', timeout: 300000, env });
    return r.status === 0 ? { ok: true, destination: dest } : { ok: false, error: (r.stderr || 'aws s3 cp failed').trim().slice(0, 500) };
  }
  const curl = curlBin();
  if (!curl) return { ok: false, error: 'Brak curl' };
  const args = ['-fsS', '--max-time', '600', '--upload-file', file, '--user', `${server.username || 'anonymous'}:${server.password_enc ? decryptSecret(server.password_enc) : ''}`, serverUrl(server, filename)];
  const r = spawnSync(curl, args, { encoding: 'utf8', timeout: 620000 });
  return r.status === 0 ? { ok: true, destination: serverUrl(server, filename) } : { ok: false, error: (r.stderr || 'upload failed').trim().slice(0, 500) };
}

export function downloadFile(server, filename, dest) {
  if (!/^[A-Za-z0-9_.-]+$/.test(filename)) return { ok: false, error: 'Invalid filename' };
  if (server.type === 'local') {
    try { fs.copyFileSync(path.join(server.path, filename), dest); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
  }
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
  const curl = curlBin();
  if (!curl) return { ok: false, error: 'Brak curl' };
  const r = spawnSync(curl, ['-fsS', '--max-time', '600', '-o', dest, '--user', `${server.username || 'anonymous'}:${server.password_enc ? decryptSecret(server.password_enc) : ''}`, serverUrl(server, filename)], { encoding: 'utf8', timeout: 620000 });
  return r.status === 0 ? { ok: true } : { ok: false, error: (r.stderr || 'download failed').trim().slice(0, 400) };
}

export function saveJob(body, actor = 'admin') {
  const name = String(body.name || '').trim();
  if (!name) return { ok: false, error: 'Nazwa joba jest wymagana' };
  const scope = body.scope === 'user' ? 'user' : 'server';
  const schedule = ['hourly', 'daily', 'weekly', 'monthly'].includes(body.schedule) ? body.schedule : 'daily';
  const components = Array.isArray(body.components) ? body.components : String(body.components || '').split(',').filter(Boolean);
  if (body.id) {
    run('UPDATE backup_jobs SET name=?, scope=?, target_user=?, components=?, server_id=?, schedule=?, retention_days=?, enabled=? WHERE id=?',
      name, scope, String(body.target_user || '') || null, JSON.stringify(components), Number(body.server_id) || null, schedule, Math.max(1, Number(body.retention_days || 14)), body.enabled ? 1 : 0, Number(body.id));
    return { ok: true, id: Number(body.id) };
  }
  const r = run('INSERT INTO backup_jobs(name, scope, target_user, components, server_id, schedule, retention_days, enabled, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    name, scope, String(body.target_user || '') || null, JSON.stringify(components), Number(body.server_id) || null, schedule, Math.max(1, Number(body.retention_days || 14)), 1, nowIso());
  audit(actor, 'admin', 'backup.job.add', name, '');
  return { ok: true, id: r.lastInsertRowid };
}

export function deleteJob(id) { run('DELETE FROM backup_jobs WHERE id = ?', Number(id)); return { ok: true }; }

export function runJob(jobId, { actor = 'admin' } = {}) {
  const job = get('SELECT * FROM backup_jobs WHERE id = ?', Number(jobId));
  if (!job) return { ok: false, error: 'Job not found' };
  const admin = get("SELECT * FROM users WHERE level = 'admin' ORDER BY id LIMIT 1");
  const server = job.server_id ? get('SELECT * FROM backup_servers WHERE id = ?', job.server_id) : null;
  const runRow = run('INSERT INTO backup_runs(job_id, filename, status, server_id, started_at) VALUES(?,?,?,?,?)', job.id, `job-${job.id}-${Date.now()}.tar.gz`, 'running', server?.id || null, nowIso());
  try {
    let archive;
    if (job.scope === 'user' && job.target_user) {
      const user = get('SELECT * FROM users WHERE username = ?', job.target_user);
      if (!user) throw new Error('Target user does not exist');
      archive = createUserBackup(user, 'full');
    } else {
      archive = createServerBackup(admin, 'all');
    }
    let uploaded = null;
    if (server) {
      uploaded = uploadFile(server, backupPath(archive.filename));
      if (!uploaded.ok) throw new Error(`Upload failed: ${uploaded.error}`);
    }
    run('UPDATE backup_runs SET filename=?, status=?, size_mb=?, local_path=?, remote_path=?, finished_at=? WHERE id=?',
      archive.filename, 'complete', archive.size || 0, backupPath(archive.filename), uploaded?.destination || null, nowIso(), runRow.lastInsertRowid);
    run('UPDATE backup_jobs SET last_run_at=?, last_status=?, last_output=? WHERE id=?', nowIso(), 'ok', uploaded?.destination || 'local', job.id);
    pruneJob(job);
    audit(actor, 'admin', 'backup.job.run', job.name, '');
    return { ok: true, filename: archive.filename, size: archive.size, uploaded: uploaded?.destination || '' };
  } catch (e) {
    run('UPDATE backup_runs SET status=?, output=?, finished_at=? WHERE id=?', 'failed', e.message, nowIso(), runRow.lastInsertRowid);
    run('UPDATE backup_jobs SET last_run_at=?, last_status=?, last_output=? WHERE id=?', nowIso(), 'failed', e.message, job.id);
    return { ok: false, error: e.message };
  }
}

export function pruneJob(job) {
  const cutoff = Date.now() - Number(job.retention_days || 14) * 864e5;
  const runs = all("SELECT * FROM backup_runs WHERE job_id = ? AND status = 'complete' ORDER BY id DESC", job.id);
  for (const r of runs) {
    if (new Date(r.started_at).getTime() > cutoff) continue;
    try { fs.rmSync(r.local_path || backupPath(r.filename), { force: true }); } catch { /* ignore */ }
    if (r.server_id) {
      const s = get('SELECT * FROM backup_servers WHERE id = ?', r.server_id);
      if (s?.type === 'local') { try { fs.rmSync(path.join(s.path, r.filename), { force: true }); } catch { /* ignore */ } }
    }
    run('DELETE FROM backup_runs WHERE id = ?', r.id);
  }
}

export function dueJobs() {
  const jobs = all('SELECT * FROM backup_jobs WHERE enabled = 1');
  const now = Date.now();
  return jobs.filter((j) => {
    const last = j.last_run_at ? new Date(j.last_run_at).getTime() : 0;
    const ms = j.schedule === 'hourly' ? 3600e3 : j.schedule === 'weekly' ? 7 * 864e5 : j.schedule === 'monthly' ? 30 * 864e5 : 864e5;
    return now - last >= ms;
  });
}

export function runDueJobs() {
  const out = [];
  for (const j of dueJobs()) out.push(runJob(j.id, { actor: 'scheduler' }));
  return out;
}

function inspectFile(file) {
  if (!fs.existsSync(file)) return { ok: false, error: 'Archive not found' };
  const list = spawnSync('tar', ['-tzf', file], { encoding: 'utf8', timeout: 300000, maxBuffer: 256 * 1024 * 1024 });
  if (list.status !== 0) return { ok: false, error: (list.stderr || 'invalid archive').trim() };
  const entries = list.stdout.split('\n').filter(Boolean);
  const unsafe = entries.filter((e) => e.startsWith('/') || e.split('/').includes('..'));
  if (unsafe.length) return { ok: false, error: `unsafe paths: ${unsafe.slice(0, 3).join(', ')}`, entries };
  return { ok: true, entries, bytes: fs.statSync(file).size };
}

function extractArchiveFile(file) {
  const info = inspectFile(file);
  if (!info.ok) return { ok: false, error: info.error };
  const work = fs.mkdtempSync(path.join(config.dataDir, 'restore-'));
  const tar = spawnSync('tar', ['-xzf', file, '-C', work], { encoding: 'utf8', timeout: 300000 });
  if (tar.status !== 0) return { ok: false, error: (tar.stderr || 'extract failed').trim() };
  return { ok: true, work, entries: info.entries };
}

function restoreDbFile(file) {
  const db = getDb();
  const escaped = file.replace(/'/g, "''");
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`ATTACH DATABASE '${escaped}' AS restored`);
    const tables = db.prepare("SELECT name FROM restored.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    db.exec('BEGIN');
    for (const { name } of tables) {
      if (name === 'sessions' || name === 'login_attempts') continue;
      const safeTable = String(name).replace(/'/g, "''");
      const cols = db.prepare(`PRAGMA main.table_info('${safeTable}')`).all().map((c) => c.name);
      const rcols = db.prepare(`PRAGMA restored.table_info('${safeTable}')`).all().map((c) => c.name);
      const common = cols.filter((c) => rcols.includes(c));
      if (!common.length) continue;
      const list = common.map((c) => `"${c}"`).join(',');
      db.exec(`DELETE FROM main."${name}"`);
      db.exec(`INSERT INTO main."${name}" (${list}) SELECT ${list} FROM restored."${name}"`);
    }
    db.exec('COMMIT');
    return { ok: true, tables: tables.length };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    return { ok: false, error: e.message };
  } finally {
    try { db.exec('DETACH DATABASE restored'); } catch { /* ignore */ }
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export function restoreRun(runId, { dryRun = true, actor = 'admin' } = {}) {
  const row = get('SELECT * FROM backup_runs WHERE id = ?', Number(runId));
  if (!row) return { ok: false, error: 'Backup run not found' };
  let file = row.local_path && fs.existsSync(row.local_path) ? row.local_path : null;
  let temp = null;
  if (!file && row.server_id) {
    const s = get('SELECT * FROM backup_servers WHERE id = ?', row.server_id);
    if (!s) return { ok: false, error: 'Backup server missing' };
    temp = path.join(config.dataDir, `restore-download-${Date.now()}.tar.gz`);
    const dl = downloadFile(s, row.filename, temp);
    if (!dl.ok) return { ok: false, error: dl.error };
    file = temp;
  }
  if (!file) return { ok: false, error: 'Archive is not available locally or on its server' };
  const inspect = inspectFile(file);
  if (!inspect.ok) return { ok: false, error: inspect.error };
  const hasDb = inspect.entries.includes('openadmin.db') || inspect.entries.includes('homes/');
  if (dryRun) {
    if (temp) { try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ } }
    return { ok: true, dryRun: true, entries: inspect.entries.length, hasDb, sample: inspect.entries.slice(0, 40), bytes: inspect.bytes };
  }
  if (!isRoot() && config.provider === 'linux') return { ok: false, error: 'Root privileges required for restore' };
  const admin = get("SELECT * FROM users WHERE level = 'admin' ORDER BY id LIMIT 1");
  const pre = createServerBackup(admin, 'all');
  const ext = extractArchiveFile(file);
  if (!ext.ok) return ext;
  try {
    if (fs.existsSync(path.join(ext.work, 'homes'))) {
      fs.mkdirSync(homeRoot(), { recursive: true });
      fs.cpSync(path.join(ext.work, 'homes'), homeRoot(), { recursive: true, force: true });
    }
    let dbRestored = false;
    if (fs.existsSync(path.join(ext.work, 'openadmin.db'))) {
      const r = restoreDbFile(path.join(ext.work, 'openadmin.db'));
      if (!r.ok) return { ok: false, error: `Database restore failed: ${r.error}`, preRestore: pre.filename };
      dbRestored = true;
    }
    audit(actor, 'admin', 'backup.restore', row.filename, '');
    return { ok: true, dryRun: false, dbRestored, preRestore: pre.filename, entries: inspect.entries.length };
  } finally {
    fs.rmSync(ext.work, { recursive: true, force: true });
    if (temp) { try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ } }
  }
}
