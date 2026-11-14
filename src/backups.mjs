// Backup engine and durable operations engine.
//
// Backups are real tar.gz archives with a manifest, SHA-256 identity and a
// per-object report. Long running work (backup, restore, upload, panel update)
// is a durable job stored in SQLite: status, real stage list, derived progress,
// event log, lease (multi-instance safe), cancellation, retry and resume.
//
// The schema below is created lazily with `CREATE TABLE IF NOT EXISTS` so a
// running installation picks it up without editing db.mjs. The same statements
// are exported as DURABLE_JOBS_MIGRATION and should be moved into db.mjs as a
// numbered migration (see the delivery report).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config } from './config.mjs';
import { getDb, run, get, all, nowIso, transaction } from './db.mjs';
import { dumpDatabase } from './mariadb.mjs';
import { homeRoot, userHome } from './paths.mjs';

/* -------------------------------------------------------------------------- */
/* Schema                                                                     */
/* -------------------------------------------------------------------------- */

export const JOB_STATUSES = ['queued', 'running', 'cancelling', 'cancelled', 'succeeded', 'failed', 'interrupted'];
export const TERMINAL_JOB_STATUSES = ['cancelled', 'succeeded', 'failed'];
export const STAGE_STATUSES = ['pending', 'running', 'complete', 'failed', 'skipped'];

/**
 * Exact SQL a future db.mjs migration must contain. It is also applied lazily
 * by ensureJobSchema() so this module works against a database created by an
 * older db.mjs (which this change is not allowed to edit).
 */
export const DURABLE_JOBS_MIGRATION = `
CREATE TABLE IF NOT EXISTS operation_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  stage TEXT,
  stage_label TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  actor TEXT,
  target TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  error TEXT,
  idempotency_key TEXT,
  request_key TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_owner TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_operation_jobs_idempotency
  ON operation_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_operation_jobs_status ON operation_jobs(status, id);
CREATE INDEX IF NOT EXISTS idx_operation_jobs_kind ON operation_jobs(kind, id);

CREATE TABLE IF NOT EXISTS operation_job_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  detail TEXT,
  value TEXT,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE(job_id, key)
);
CREATE INDEX IF NOT EXISTS idx_operation_job_stages_job ON operation_job_stages(job_id, seq);

CREATE TABLE IF NOT EXISTS operation_job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operation_job_events_job ON operation_job_events(job_id, id);

CREATE TABLE IF NOT EXISTS scheduler_leases (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`;

/** Extra backup metadata columns. Additive, safe for older installations. */
export const BACKUP_METADATA_MIGRATION = `
ALTER TABLE backups ADD COLUMN sha256 TEXT;
ALTER TABLE backups ADD COLUMN manifest TEXT;
ALTER TABLE backups ADD COLUMN size_bytes INTEGER;
ALTER TABLE backups ADD COLUMN scope TEXT;
ALTER TABLE backups ADD COLUMN verified_at TEXT;

ALTER TABLE backup_jobs ADD COLUMN next_run_at TEXT;
ALTER TABLE backup_jobs ADD COLUMN timezone TEXT;
ALTER TABLE backup_jobs ADD COLUMN schedule_time TEXT;
ALTER TABLE backup_jobs ADD COLUMN catch_up_minutes INTEGER NOT NULL DEFAULT 1440;
ALTER TABLE backup_jobs ADD COLUMN lease_owner TEXT;
ALTER TABLE backup_jobs ADD COLUMN lease_until TEXT;
ALTER TABLE backup_jobs ADD COLUMN last_attempt_at TEXT;
ALTER TABLE backup_jobs ADD COLUMN last_duration_ms INTEGER;

ALTER TABLE backup_runs ADD COLUMN operation_job_id INTEGER;
ALTER TABLE backup_runs ADD COLUMN sha256 TEXT;
ALTER TABLE backup_runs ADD COLUMN snapshot_point TEXT;
ALTER TABLE backup_runs ADD COLUMN report TEXT;
ALTER TABLE backup_runs ADD COLUMN restore_job_id INTEGER;
ALTER TABLE backup_runs ADD COLUMN restored_at TEXT;
`;

let jobSchemaReady = false;

export function ensureJobSchema({ force = false } = {}) {
  if (jobSchemaReady && !force) return;
  const db = getDb();
  db.exec(DURABLE_JOBS_MIGRATION);
  try { db.exec('PRAGMA busy_timeout = 10000'); } catch { /* older SQLite */ }
  jobSchemaReady = true;
}

function addColumnIfMissing(table, column, definition) {
  const cols = getDb().prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return false;
  getDb().exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

export function ensureBackupSchema() {
  ensureJobSchema();
  const added = [];
  const columns = [
    ['backups', 'sha256', 'TEXT'],
    ['backups', 'manifest', 'TEXT'],
    ['backups', 'size_bytes', 'INTEGER'],
    ['backups', 'scope', 'TEXT'],
    ['backups', 'verified_at', 'TEXT'],
    ['backup_jobs', 'next_run_at', 'TEXT'],
    ['backup_jobs', 'timezone', 'TEXT'],
    ['backup_jobs', 'schedule_time', 'TEXT'],
    ['backup_jobs', 'catch_up_minutes', 'INTEGER NOT NULL DEFAULT 1440'],
    ['backup_jobs', 'lease_owner', 'TEXT'],
    ['backup_jobs', 'lease_until', 'TEXT'],
    ['backup_jobs', 'last_attempt_at', 'TEXT'],
    ['backup_jobs', 'last_duration_ms', 'INTEGER'],
    ['backup_runs', 'operation_job_id', 'INTEGER'],
    ['backup_runs', 'sha256', 'TEXT'],
    ['backup_runs', 'snapshot_point', 'TEXT'],
    ['backup_runs', 'report', 'TEXT'],
    ['backup_runs', 'restore_job_id', 'INTEGER'],
    ['backup_runs', 'restored_at', 'TEXT'],
  ];
  for (const [table, column, definition] of columns) {
    if (addColumnIfMissing(table, column, definition)) added.push(`${table}.${column}`);
  }
  return added;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

export function backupDir() {
  const dir = path.join(config.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function safeName(name) {
  return path.basename(String(name)).replace(/[^A-Za-z0-9_.-]/g, '_');
}

export function backupPath(filename) {
  return path.join(backupDir(), safeName(filename));
}

function sizeOf(file) {
  try { return Math.round((fs.statSync(file).size / 1024 / 1024) * 10) / 10; } catch { return 0; }
}

function bytesOf(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read = 0;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function stableStringify(value) {
  const normalize = (input) => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') {
      const out = {};
      for (const key of Object.keys(input).sort()) out[key] = normalize(input[key]);
      return out;
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

export function countFiles(dir, { depth = 16 } = {}) {
  let n = 0;
  const walk = (d, level = 0) => {
    if (level > depth) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.isDirectory()) walk(path.join(d, ent.name), level + 1);
      else n++;
    }
  };
  walk(dir);
  return n;
}

function dirSummary(dir, { maxEntries = 500000 } = {}) {
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  let truncated = false;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        dirs++;
        stack.push(full);
      } else if (entry.isSymbolicLink()) {
        files++;
      } else {
        try { bytes += fs.lstatSync(full).size; } catch { /* vanished */ }
        files++;
      }
      if (files + dirs > maxEntries) { truncated = true; return { files, dirs, bytes, truncated }; }
    }
  }
  return { files, dirs, bytes, truncated };
}

export function freeBytes(target) {
  try {
    const stat = fs.statfsSync(target);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

function formatMb(bytes) {
  return `${(Number(bytes || 0) / 1024 / 1024).toFixed(1)} MB`;
}

class OperationError extends Error {
  constructor(message, code = 'operation_failed', detail = {}) {
    super(message);
    this.name = 'OperationError';
    this.code = code;
    this.detail = detail;
  }
}

export { OperationError };

export function requireDiskSpace(target, requiredBytes, label = 'operation') {
  const free = freeBytes(target);
  if (free === null) return { ok: true, checked: false, required: requiredBytes, free: null };
  const required = Math.ceil(Number(requiredBytes || 0));
  if (free < required) {
    throw new OperationError(
      `Not enough free space for ${label}: need ${formatMb(required)}, ${formatMb(free)} available at ${target}`,
      'insufficient_disk',
      { required, free, path: target },
    );
  }
  return { ok: true, checked: true, required, free };
}

function parseJson(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

/* -------------------------------------------------------------------------- */
/* Tar inspection / safe extraction (SEC-022)                                 */
/* -------------------------------------------------------------------------- */

function parseVerboseTail(line) {
  const marker = line.includes(' link to ') ? ' link to ' : line.includes(' -> ') ? ' -> ' : null;
  let left = line;
  let linkTarget = null;
  if (marker) {
    const index = line.lastIndexOf(marker);
    left = line.slice(0, index);
    linkTarget = line.slice(index + marker.length);
  }
  const match = /(?:^|\s)(?:\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?|[A-Z][a-z]{2}\s+\d{1,2}\s+(?:\d{2}:\d{2}|\d{4}))\s+(.+)$/.exec(left);
  if (!match) return { type: line[0] || '?', name: null, linkTarget };
  return { type: line[0] || '?', name: match[1], linkTarget };
}

function unsafeArchivePath(name) {
  const text = String(name);
  if (!text || text.includes('\0') || text.includes('\r') || text.includes('\n')) return true;
  if (text.startsWith('/') || text.startsWith('\\')) return true;
  if (/^[A-Za-z]:[\\/]/.test(text)) return true;
  const normalized = text.replace(/\\/g, '/');
  return normalized.split('/').some((part) => part === '..');
}

function pathInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

/**
 * Inspect a tar.gz before extraction. Rejects absolute/traversing names,
 * escaping symlinks/hardlinks, device/FIFO/socket entries and entries whose
 * type cannot be parsed (SEC-022).
 */
export function inspectTarFile(file) {
  if (!file || !fs.existsSync(file)) return { ok: false, error: 'Archive not found', code: 'not_found' };
  const bytes = bytesOf(file);
  const names = spawnSync('tar', ['-tzf', file], { encoding: 'utf8', timeout: 300000, maxBuffer: 256 * 1024 * 1024 });
  if (names.status !== 0) {
    return { ok: false, error: (names.stderr || 'invalid archive').trim().slice(0, 500), code: 'invalid_archive' };
  }
  const verbose = spawnSync('tar', ['-tvzf', file], { encoding: 'utf8', timeout: 300000, maxBuffer: 256 * 1024 * 1024 });
  if (verbose.status !== 0) {
    return { ok: false, error: (verbose.stderr || 'invalid archive listing').trim().slice(0, 500), code: 'invalid_archive' };
  }
  const entries = names.stdout.split('\n').filter(Boolean);
  const lines = verbose.stdout.split('\n').filter(Boolean);
  if (entries.length !== lines.length) {
    return { ok: false, error: 'Archive listing is ambiguous (name/type count mismatch)', code: 'ambiguous_archive', entries };
  }
  const unsafe = [];
  const links = [];
  const special = [];
  const details = [];
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseVerboseTail(lines[i]);
    const name = parsed.name ?? entries[i];
    if (!parsed.name) {
      return { ok: false, error: `Archive listing cannot be parsed at entry ${i + 1}`, code: 'ambiguous_archive', entries };
    }
    const type = parsed.type;
    const detail = { name, type, linkTarget: parsed.linkTarget || null };
    if (unsafeArchivePath(name)) {
      unsafe.push(name);
      detail.reason = 'unsafe path';
      details.push(detail);
      continue;
    }
    if (type === '-') {
      details.push(detail);
      continue;
    }
    if (type === 'd') {
      details.push(detail);
      continue;
    }
    if (type === 'l' || type === 'h') {
      const target = parsed.linkTarget || '';
      const resolved = path.resolve(path.dirname(path.join('/archive', name)), target);
      if (!target || unsafeArchivePath(target) || !pathInside('/archive', resolved)) {
        unsafe.push(`${name} -> ${target || '?'}`);
        detail.reason = 'escaping link';
      } else {
        links.push({ name, target, type: type === 'l' ? 'symlink' : 'hardlink' });
      }
      details.push(detail);
      continue;
    }
    special.push({ name, type });
    detail.reason = 'special file';
    details.push(detail);
  }
  if (unsafe.length) {
    return {
      ok: false,
      code: 'unsafe_archive',
      error: `unsafe archive entries: ${unsafe.slice(0, 3).join(', ')}`,
      entries,
      details,
      links,
      special,
      bytes,
    };
  }
  if (special.length) {
    return {
      ok: false,
      code: 'unsafe_archive',
      error: `archive contains device/FIFO/socket entries: ${special.slice(0, 3).map((s) => s.name).join(', ')}`,
      entries,
      details,
      links,
      special,
      bytes,
    };
  }
  return { ok: true, entries, details, links, special, bytes };
}

/** Compatibility wrapper used by the backup center and existing tests. */
export function inspectArchive(filename) {
  const file = backupPath(filename);
  const info = inspectTarFile(file);
  if (!info.ok) return info;
  return { ok: true, entries: info.entries, details: info.details, links: info.links, bytes: info.bytes };
}

function stripUnsafeModes(root) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(full);
      try {
        const stat = fs.lstatSync(full);
        const safeMode = stat.mode & 0o777;
        fs.chmodSync(full, entry.isDirectory() ? safeMode | 0o700 : safeMode);
      } catch { /* best effort */ }
    }
  }
}

/** Verify that extraction really stayed inside the staging root (links included). */
function verifyExtractedTree(root) {
  // macOS reports /var -> /private/var; canonicalize both sides so containment
  // checks compare real paths instead of user-visible symlink prefixes.
  const resolvedRoot = fs.realpathSync(root);
  const problems = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      let stat;
      try { stat = fs.lstatSync(full); } catch { continue; }
      if (stat.isSymbolicLink()) {
        let target = '';
        try { target = fs.readlinkSync(full); } catch { target = ''; }
        const resolved = path.resolve(path.dirname(full), target);
        if (!target || path.isAbsolute(target) || !pathInside(resolvedRoot, resolved)) {
          problems.push(`${path.relative(root, full)} -> ${target || '?'}`);
        }
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!stat.isFile()) {
        problems.push(`${path.relative(root, full)} (special file)`);
        continue;
      }
      try {
        const real = fs.realpathSync(full);
        if (!pathInside(resolvedRoot, real)) problems.push(`${path.relative(root, full)} (realpath escape)`);
      } catch { problems.push(`${path.relative(root, full)} (missing)`); }
    }
  }
  return problems;
}

export function safeExtractTar(file, destination, { timeout = 600000, preserveOwner = true } = {}) {
  const info = inspectTarFile(file);
  if (!info.ok) return info;
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const args = ['-xzf', file, '-C', destination];
  if (!preserveOwner) args.push('--no-same-owner');
  const result = spawnSync('tar', args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    return { ok: false, code: 'extract_failed', error: (result.stderr || 'extract failed').trim().slice(0, 800), details: info.details };
  }
  stripUnsafeModes(destination);
  const problems = verifyExtractedTree(destination);
  if (problems.length) {
    return {
      ok: false,
      code: 'unsafe_archive',
      error: `extracted archive escapes staging: ${problems.slice(0, 3).join(', ')}`,
      details: info.details,
    };
  }
  return { ok: true, entries: info.entries, details: info.details, links: info.links, bytes: info.bytes };
}

export function readArchiveManifest(filename) {
  const file = fs.existsSync(filename) ? filename : backupPath(filename);
  const out = spawnSync('tar', ['-xOzf', file, 'openadmin-backup.json'], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024,
  });
  if (out.status !== 0) return null;
  const parsed = parseJson(out.stdout, null);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

/* -------------------------------------------------------------------------- */
/* Archive manifests                                                          */
/* -------------------------------------------------------------------------- */

function hashTreeFiles(root, { maxFiles = 20000 } = {}) {
  const files = [];
  let bytes = 0;
  let truncated = false;
  const walk = (dir, rel = '') => {
    if (truncated) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      let stat;
      try { stat = fs.lstatSync(full); } catch { continue; }
      if (stat.isSymbolicLink()) {
        let target = '';
        try { target = fs.readlinkSync(full); } catch { /* ignore */ }
        files.push({ path: relPath, type: 'symlink', target, bytes: 0 });
        continue;
      }
      if (stat.isDirectory()) { walk(full, relPath); continue; }
      if (!stat.isFile()) {
        files.push({ path: relPath, type: 'special', bytes: 0 });
        continue;
      }
      if (files.length >= maxFiles) { truncated = true; return; }
      files.push({ path: relPath, type: 'file', bytes: stat.size, sha256: sha256File(full) });
      bytes += stat.size;
    }
  };
  walk(root);
  return { files, bytes, truncated, algorithm: 'sha256' };
}

/** Hash a directory tree (used by build diagnostics and manifests). */
export function hashDirectory(root) {
  const summary = hashTreeFiles(root);
  return { sha256: sha256Text(stableStringify(summary.files)), files: summary.files.length, bytes: summary.bytes, truncated: summary.truncated };
}

/* -------------------------------------------------------------------------- */
/* Durable job serialization                                                  */
/* -------------------------------------------------------------------------- */

function jobRow(id) {
  return get('SELECT * FROM operation_jobs WHERE id = ?', Number(id));
}

function decodeJob(row) {
  if (!row) return null;
  return {
    ...row,
    payload: parseJson(row.payload, {}),
    state: parseJson(row.state, {}),
    result: parseJson(row.result, null) ?? parseJson(row.result, {}),
    cancel_requested: !!row.cancel_requested,
  };
}

function stageRows(jobId) {
  return all('SELECT * FROM operation_job_stages WHERE job_id = ? ORDER BY seq, id', Number(jobId)).map((row) => ({
    ...row,
    value: row.value ? parseJson(row.value, null) : null,
  }));
}

function eventRows(jobId, limit = 80) {
  const rows = all('SELECT * FROM operation_job_events WHERE job_id = ? ORDER BY id DESC LIMIT ?', Number(jobId), Number(limit));
  return rows.reverse();
}

export function jobView(jobOrId, { events = 80 } = {}) {
  const row = typeof jobOrId === 'object' && jobOrId ? jobOrId : jobRow(jobOrId);
  const job = decodeJob(row);
  if (!job) return null;
  const stages = stageRows(job.id);
  // Progress reflects work actually completed. Skipped stages left behind by a
  // failed/cancelled job must not inflate the percentage.
  const done = stages.filter((s) => s.status === 'complete').length;
  const failedStage = stages.find((s) => s.status === 'failed');
  return {
    ...job,
    stages,
    events: eventRows(job.id, events),
    stageLabel: job.stage_label || stages.find((s) => s.key === job.stage)?.label || job.stage || '',
    stagesTotal: stages.length,
    stagesDone: done,
    progress: stages.length ? Math.round((done / stages.length) * 100) : Number(job.progress || 0),
    cancellable: ['queued', 'running', 'cancelling'].includes(job.status),
    retryable: ['failed', 'cancelled', 'interrupted'].includes(job.status),
    resumable: ['cancelled', 'interrupted'].includes(job.status) && stages.some((s) => ['complete', 'running'].includes(s.status)),
    terminal: TERMINAL_JOB_STATUSES.includes(job.status),
    errorCode: failedStage?.detail || job.error_code || null,
  };
}

export function listJobViews({ kinds = [], statuses = [], limit = 25 } = {}) {
  ensureJobSchema();
  const clauses = [];
  const params = [];
  if (kinds.length) {
    clauses.push(`kind IN (${kinds.map(() => '?').join(',')})`);
    params.push(...kinds);
  }
  if (statuses.length) {
    clauses.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all(`SELECT id FROM operation_jobs ${where} ORDER BY id DESC LIMIT ?`, ...params, Number(limit)).map((row) => jobView(row.id, { events: 12 }));
}

function jobOwner() {
  return process.env.OA_JOB_OWNER || `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
}

function leaseUntil(milliseconds) {
  return new Date(Date.now() + Math.max(1000, Number(milliseconds) || 60000)).toISOString();
}

function appendJobEvent(jobId, level, message) {
  const text = String(message ?? '').slice(0, 4000);
  if (!text) return;
  run('INSERT INTO operation_job_events(job_id, level, message, created_at) VALUES(?,?,?,?)', Number(jobId), level, text, nowIso());
}

function touchJob(jobId, fields = {}) {
  const sets = ['updated_at = ?'];
  const params = [nowIso()];
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = ?`);
    params.push(value);
  }
  params.push(Number(jobId));
  run(`UPDATE operation_jobs SET ${sets.join(', ')} WHERE id = ?`, ...params);
}

function heartbeatJob(jobId, owner, leaseMs) {
  run('UPDATE operation_jobs SET lease_owner = ?, lease_until = ?, updated_at = ? WHERE id = ? AND lease_owner = ?',
    owner, leaseUntil(leaseMs), nowIso(), Number(jobId), owner);
}

/* -------------------------------------------------------------------------- */
/* Job creation / state machine                                               */
/* -------------------------------------------------------------------------- */

export function registerJobHandler(kind, handler, { mode = 'async' } = {}) {
  jobHandlers.set(String(kind), { handler, mode });
}

const jobHandlers = new Map();

function handlerFor(kind) {
  return jobHandlers.get(String(kind)) || null;
}

async function ensureJobHandler(kind) {
  if (handlerFor(kind)) return true;
  // Restore/backup-center handlers live in backupcenter.mjs, panel updates in
  // updates.mjs. Importing on demand keeps the dependency graph acyclic.
  if (String(kind).startsWith('backup.') || String(kind).startsWith('upload.')) {
    try { await import('./backupcenter.mjs'); } catch { /* optional module */ }
  }
  if (String(kind).startsWith('update.')) {
    try { await import('./updates.mjs'); } catch { /* optional module */ }
  }
  return !!handlerFor(kind);
}

export function stagePlan(stages) {
  const seen = new Set();
  return (stages || []).map((stage, index) => {
    const key = String(stage.key || `stage-${index + 1}`);
    const label = String(stage.label || key);
    if (seen.has(key)) throw new Error(`Duplicate job stage key: ${key}`);
    seen.add(key);
    return { key, label };
  });
}

/**
 * Create a durable job. When `idempotencyKey` matches an active job, that job
 * is returned instead of creating a duplicate (double-click protection).
 */
export function createJob({
  kind,
  stages = [],
  actor = 'system',
  target = '',
  payload = {},
  idempotencyKey = null,
  maxAttempts = 3,
} = {}) {
  ensureJobSchema();
  const cleanKind = String(kind || '').trim();
  if (!cleanKind) throw new Error('Job kind is required');
  const plan = stagePlan(stages);
  const now = nowIso();
  const key = idempotencyKey ? String(idempotencyKey).slice(0, 240) : null;
  if (key) {
    const existing = get(
      "SELECT * FROM operation_jobs WHERE idempotency_key = ? AND status IN ('queued','running','cancelling') ORDER BY id DESC LIMIT 1",
      key,
    );
    if (existing) return { ok: true, reused: true, job: jobView(existing) };
  }
  let id;
  try {
    id = transaction(() => {
      const result = run(
        `INSERT INTO operation_jobs(kind, status, stage, stage_label, progress, actor, target, payload, state, idempotency_key, request_key, attempts, max_attempts, cancel_requested, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        cleanKind, 'queued', plan[0]?.key || null, plan[0]?.label || null, 0,
        String(actor || 'system'), String(target || ''), JSON.stringify(payload || {}), '{}',
        key, key, 0, Math.max(1, Number(maxAttempts) || 3), 0, now, now,
      );
      const jobId = result.lastInsertRowid;
      plan.forEach((stage, index) => {
        run('INSERT INTO operation_job_stages(job_id, seq, key, label, status) VALUES(?,?,?,?,?)',
          jobId, index + 1, stage.key, stage.label, 'pending');
      });
      appendJobEvent(jobId, 'info', `Job ${cleanKind} queued (${plan.length} stage${plan.length === 1 ? '' : 's'})`);
      return jobId;
    });
  } catch (error) {
    if (key) {
      const existing = get(
        "SELECT * FROM operation_jobs WHERE idempotency_key = ? AND status IN ('queued','running','cancelling') ORDER BY id DESC LIMIT 1",
        key,
      );
      if (existing) return { ok: true, reused: true, job: jobView(existing) };
    }
    throw error;
  }
  return { ok: true, reused: false, job: jobView(id) };
}

function setStage(jobId, key, status, { detail = null, value = undefined, label = '' } = {}) {
  const job = jobRow(jobId);
  if (!job) return null;
  const existing = get('SELECT * FROM operation_job_stages WHERE job_id = ? AND key = ?', Number(jobId), String(key));
  const now = nowIso();
  if (!existing) {
    const seq = (get('SELECT COALESCE(MAX(seq), 0) AS n FROM operation_job_stages WHERE job_id = ?', Number(jobId)).n || 0) + 1;
    run('INSERT INTO operation_job_stages(job_id, seq, key, label, status, detail, value, started_at, finished_at) VALUES(?,?,?,?,?,?,?,?,?)',
      Number(jobId), seq, String(key), String(label || key), status,
      detail === null ? null : String(detail).slice(0, 4000),
      value === undefined ? null : JSON.stringify(value),
      status === 'running' ? now : null,
      ['complete', 'failed', 'skipped'].includes(status) ? now : null);
  } else {
    run(`UPDATE operation_job_stages SET status = ?, detail = COALESCE(?, detail), value = COALESCE(?, value),
           started_at = COALESCE(started_at, ?), finished_at = ? WHERE job_id = ? AND key = ?`,
      status,
      detail === null ? null : String(detail).slice(0, 4000),
      value === undefined ? null : JSON.stringify(value),
      status === 'running' ? now : null,
      ['complete', 'failed', 'skipped'].includes(status) ? now : null,
      Number(jobId), String(key));
  }
  const stages = stageRows(jobId);
  const done = stages.filter((stage) => stage.status === 'complete').length;
  const progress = stages.length ? Math.round((done / stages.length) * 100) : 0;
  const current = stages.find((stage) => stage.key === String(key));
  const next = stages.find((stage) => stage.status === 'pending');
  touchJob(jobId, {
    progress,
    stage: current ? current.key : job.stage,
    stage_label: current ? current.label : job.stage_label,
  });
  if (status === 'complete' || status === 'skipped') {
    if (next && (!job.status || ['queued', 'running'].includes(job.status))) {
      touchJob(jobId, { stage: next.key, stage_label: next.label });
    }
  }
  return current;
}

function finishJob(jobId, status, { result = null, error = '' } = {}) {
  const now = nowIso();
  const finalProgress = status === 'succeeded' ? 100 : null;
  run(`UPDATE operation_jobs
       SET status = ?, error = ?, result = ?, finished_at = ?, updated_at = ?,
           idempotency_key = NULL, lease_owner = NULL, lease_until = NULL,
           progress = COALESCE(?, progress)
       WHERE id = ?`,
    status, error ? String(error).slice(0, 8000) : null,
    result === null ? null : JSON.stringify(result),
    now, now, finalProgress, Number(jobId));
  if (status === 'cancelled' || status === 'failed') {
    run("UPDATE operation_job_stages SET status = 'skipped', finished_at = COALESCE(finished_at, ?) WHERE job_id = ? AND status = 'pending'",
      now, Number(jobId));
  }
  run(`DELETE FROM operation_job_events WHERE job_id = ? AND id NOT IN
       (SELECT id FROM operation_job_events WHERE job_id = ? ORDER BY id DESC LIMIT 1000)`,
    Number(jobId), Number(jobId));
  notifyFinishedJob(jobId, status, error);
}

function notifyFinishedJob(jobId, status, error) {
  const row = jobRow(jobId);
  if (!row) return;
  if (!['backup.job.run', 'backup.restore.user', 'backup.restore.server', 'update.panel'].includes(row.kind)) return;
  const link = row.kind === 'update.panel'
    ? `/admin/updates-center/jobs/${row.id}`
    : `/admin/backup-center/operations/${row.id}`;
  const label = row.kind === 'update.panel' ? 'Aktualizacja panelu' : (row.kind.startsWith('backup.restore') ? 'Przywracanie backupu' : 'Backup');
  const title = `${label}: ${status === 'succeeded' ? 'zakończone' : status}`;
  const body = error ? String(error).slice(0, 500) : `Zadanie #${row.id} (${row.kind}) zakończyło się: ${status}.`;
  import('./notifications.mjs')
    .then((notifications) => {
      if (typeof notifications.addNotification !== 'function') return null;
      return notifications.addNotification({
        level: status === 'succeeded' ? 'ok' : 'danger',
        title,
        body,
        link,
        dedupeKey: `operation-job:${row.id}:${status}`,
        dedupeWindowMs: 60 * 1000,
      });
    })
    .catch(() => {});
}

function cancelRequested(jobId) {
  const row = get('SELECT cancel_requested FROM operation_jobs WHERE id = ?', Number(jobId));
  return !!row?.cancel_requested;
}

class JobCancelled extends Error {
  constructor() {
    super('Job cancelled by operator');
    this.name = 'JobCancelled';
  }
}

function createContext(job, { asyncMode, owner, leaseMs }) {
  const state = parseJson(job.state, {});
  const ctx = {
    job: jobView(job),
    get state() { return state; },
    cancelled: () => cancelRequested(job.id),
    checkCancel() {
      if (cancelRequested(job.id)) throw new JobCancelled();
    },
    log(level, message) {
      appendJobEvent(job.id, level, message);
    },
    setState(patch) {
      Object.assign(state, patch || {});
      run('UPDATE operation_jobs SET state = ?, updated_at = ? WHERE id = ?', JSON.stringify(state), nowIso(), job.id);
    },
    setResult(patch) {
      const current = parseJson(jobRow(job.id)?.result, {}) || {};
      Object.assign(current, patch || {});
      run('UPDATE operation_jobs SET result = ?, updated_at = ? WHERE id = ?', JSON.stringify(current), nowIso(), job.id);
    },
    heartbeat() { heartbeatJob(job.id, owner, leaseMs); },
    stage(key, label) {
      // Move the cursor without running work (used before a long stage).
      if (cancelRequested(job.id)) throw new JobCancelled();
      setStage(job.id, key, 'running', { label });
      heartbeatJob(job.id, owner, leaseMs);
    },
  };
  const runStage = (key, fn, { label = '', uninterruptible = false } = {}, done) => {
    if (!uninterruptible && cancelRequested(job.id)) throw new JobCancelled();
    const existing = get('SELECT * FROM operation_job_stages WHERE job_id = ? AND key = ?', job.id, String(key));
    if (existing?.status === 'complete' || existing?.status === 'skipped') {
      ctx.log('info', `Stage ${key} already completed; resumed without repeating it`);
      return done ? done(parseJson(existing.value, null)) : parseJson(existing.value, null);
    }
    setStage(job.id, key, 'running', { label });
    const stageLabel = get('SELECT label FROM operation_job_stages WHERE job_id = ? AND key = ?', job.id, String(key))?.label || label || key;
    appendJobEvent(job.id, 'info', `Stage started: ${stageLabel}`);
    heartbeatJob(job.id, owner, leaseMs);
    const complete = (value) => {
      setStage(job.id, key, 'complete', { detail: summarize(value), value });
      appendJobEvent(job.id, 'info', `Stage complete: ${stageLabel}${summarize(value) ? ` — ${summarize(value)}` : ''}`);
      heartbeatJob(job.id, owner, leaseMs);
      return value;
    };
    if (asyncMode) {
      return Promise.resolve()
        .then(fn)
        .then(complete, (error) => {
          setStage(job.id, key, 'failed', { detail: error?.message || String(error) });
          appendJobEvent(job.id, 'error', `Stage failed: ${stageLabel} — ${error?.message || error}`);
          throw error;
        });
    }
    try {
      return complete(fn());
    } catch (error) {
      setStage(job.id, key, 'failed', { detail: error?.message || String(error) });
      appendJobEvent(job.id, 'error', `Stage failed: ${stageLabel} — ${error?.message || error}`);
      throw error;
    }
  };
  if (asyncMode) {
    ctx.step = (key, fn, options = {}) => runStage(key, fn, options);
  } else {
    ctx.step = (key, fn, options = {}) => runStage(key, fn, options);
  }
  return ctx;
}

function summarize(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.slice(0, 500);
  try {
    const text = JSON.stringify(value);
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch { return ''; }
}

function claimJob(jobId, { owner, leaseMs }) {
  const now = nowIso();
  const result = run(
    `UPDATE operation_jobs
     SET status = 'running', started_at = COALESCE(started_at, ?), lease_owner = ?, lease_until = ?,
         attempts = attempts + 1, updated_at = ?
     WHERE id = ? AND status = 'queued'
       AND cancel_requested = 0
       AND (lease_until IS NULL OR lease_until < ?)`,
    now, owner, leaseUntil(leaseMs), now, Number(jobId), now,
  );
  return result.changes === 1;
}

function markInterrupted(jobId, reason) {
  const now = nowIso();
  run("UPDATE operation_job_stages SET status = 'failed', detail = ?, finished_at = ? WHERE job_id = ? AND status = 'running'",
    reason, now, Number(jobId));
  run(`UPDATE operation_jobs SET status = 'interrupted', error = ?, finished_at = ?, updated_at = ?,
          idempotency_key = NULL, lease_owner = NULL, lease_until = NULL WHERE id = ?`,
    reason, now, now, Number(jobId));
  appendJobEvent(jobId, 'error', reason);
}

/**
 * Execute a job in the current process. Async handlers use an async context;
 * `executeJobSync` is the compatibility path used by functions that must return
 * immediately (existing user backup/restore routes and smoke tests).
 */
export async function executeJobById(jobId, { owner = jobOwner(), leaseMs = 2 * 60 * 60 * 1000 } = {}) {
  ensureJobSchema();
  const row = jobRow(jobId);
  if (!row) return { ok: false, error: 'Job not found' };
  const decoded = decodeJob(row);
  if (TERMINAL_JOB_STATUSES.includes(decoded.status)) {
    return { ok: decoded.status === 'succeeded', status: decoded.status, job: jobView(jobId) };
  }
  await ensureJobHandler(decoded.kind);
  const registered = handlerFor(decoded.kind);
  if (!registered) {
    finishJob(jobId, 'failed', { error: `No handler registered for job kind ${decoded.kind}` });
    return { ok: false, status: 'failed', error: 'Handler not registered', job: jobView(jobId) };
  }
  if (!claimJob(jobId, { owner, leaseMs })) {
    return { ok: false, status: 'lease-held', error: 'Another worker holds this job', job: jobView(jobId) };
  }
  const job = jobRow(jobId);
  appendJobEvent(jobId, 'info', `Worker ${owner} started the job`);
  // Sync handlers (backup/restore) keep their synchronous contract even when a
  // detached job-runner process executes them.
  if (registered.mode === 'sync') {
    return runClaimedJobSync(job, registered, { owner, leaseMs });
  }
  const ctx = createContext(job, { asyncMode: true, owner, leaseMs });
  let status = 'succeeded';
  let error = '';
  let result = null;
  try {
    const output = await registered.handler(ctx);
    result = output && typeof output === 'object' ? output : { value: output ?? null };
    if (cancelRequested(jobId)) {
      result = { ...result, cancelled: true, cancelLate: true };
      appendJobEvent(jobId, 'warn', 'Cancellation was requested after the job passed its last safe checkpoint');
    }
    finishJob(jobId, 'succeeded', { result });
  } catch (failure) {
    if (failure instanceof JobCancelled) {
      status = 'cancelled';
      error = failure.message;
      appendJobEvent(jobId, 'warn', error);
      finishJob(jobId, 'cancelled', { error });
    } else {
      status = 'failed';
      error = failure?.message || String(failure);
      const partial = parseJson(jobRow(jobId)?.result, {}) || {};
      const details = failure instanceof OperationError ? { ...partial, code: failure.code, ...failure.detail } : partial;
      finishJob(jobId, 'failed', { error, result: Object.keys(details).length ? details : null });
    }
  }
  return { ok: status === 'succeeded', status, error, result: parseJson(jobRow(jobId)?.result, null), job: jobView(jobId) };
}

function runClaimedJobSync(job, registered, { owner, leaseMs }) {
  const jobId = job.id;
  appendJobEvent(jobId, 'info', `Worker ${owner} started the job (inline)`);
  const ctx = createContext(job, { asyncMode: false, owner, leaseMs });
  let status = 'succeeded';
  let error = '';
  try {
    const output = registered.handler(ctx);
    if (output && typeof output.then === 'function') throw new Error(`Sync job handler ${job.kind} returned a Promise`);
    const result = output && typeof output === 'object' ? output : { value: output ?? null };
    finishJob(jobId, 'succeeded', { result });
  } catch (failure) {
    if (failure instanceof JobCancelled) {
      status = 'cancelled';
      error = failure.message;
      finishJob(jobId, 'cancelled', { error });
    } else {
      status = 'failed';
      error = failure?.message || String(failure);
      const partial = parseJson(jobRow(jobId)?.result, {}) || {};
      const details = failure instanceof OperationError ? { ...partial, code: failure.code, ...failure.detail } : partial;
      finishJob(jobId, 'failed', { error, result: Object.keys(details).length ? details : null });
    }
  }
  return { ok: status === 'succeeded', status, error, result: parseJson(jobRow(jobId)?.result, null), job: jobView(jobId) };
}

export function executeJobSync(jobId, { owner = jobOwner(), leaseMs = 2 * 60 * 60 * 1000 } = {}) {
  ensureJobSchema();
  const row = jobRow(jobId);
  if (!row) throw new Error('Job not found');
  const decoded = decodeJob(row);
  if (TERMINAL_JOB_STATUSES.includes(decoded.status)) {
    return { ok: decoded.status === 'succeeded', status: decoded.status, job: jobView(jobId) };
  }
  const registered = handlerFor(decoded.kind);
  if (!registered) throw new Error(`No sync handler registered for job kind ${decoded.kind}`);
  if (registered.mode !== 'sync') throw new Error(`Job kind ${decoded.kind} requires the async runner`);
  if (!claimJob(jobId, { owner, leaseMs })) throw new Error('Another worker holds this job');
  return runClaimedJobSync(jobRow(jobId), registered, { owner, leaseMs });
}

export function cancelJob(jobId, { actor = 'operator', reason = 'Cancelled by operator' } = {}) {
  ensureJobSchema();
  const job = decodeJob(jobRow(jobId));
  if (!job) return { ok: false, error: 'Job not found' };
  if (TERMINAL_JOB_STATUSES.includes(job.status)) return { ok: false, error: `Job is already ${job.status}` };
  const now = nowIso();
  if (job.status === 'queued') {
    run("UPDATE operation_jobs SET status = 'cancelled', cancel_requested = 1, error = ?, finished_at = ?, updated_at = ?, idempotency_key = NULL WHERE id = ?",
      reason, now, now, Number(jobId));
    run("UPDATE operation_job_stages SET status = 'skipped', finished_at = ? WHERE job_id = ? AND status = 'pending'", now, Number(jobId));
    appendJobEvent(jobId, 'warn', `Queued job cancelled by ${actor}: ${reason}`);
  } else {
    run("UPDATE operation_jobs SET cancel_requested = 1, status = 'cancelling', updated_at = ? WHERE id = ?", now, Number(jobId));
    appendJobEvent(jobId, 'warn', `Cancellation requested by ${actor}: ${reason}`);
  }
  return { ok: true, job: jobView(jobId) };
}

function resetStages(jobId) {
  run("UPDATE operation_job_stages SET status = 'pending', detail = NULL, value = NULL, started_at = NULL, finished_at = NULL WHERE job_id = ?", Number(jobId));
}

export function retryJob(jobId, { actor = 'operator', reason = 'Retry requested' } = {}) {
  ensureJobSchema();
  const job = decodeJob(jobRow(jobId));
  if (!job) return { ok: false, error: 'Job not found' };
  if (!['failed', 'cancelled', 'interrupted'].includes(job.status)) return { ok: false, error: `Only failed, cancelled or interrupted jobs can be retried (job is ${job.status})` };
  resetStages(jobId);
  const first = get('SELECT * FROM operation_job_stages WHERE job_id = ? ORDER BY seq LIMIT 1', Number(jobId));
  run(`UPDATE operation_jobs SET status = 'queued', stage = ?, stage_label = ?, progress = 0, error = NULL, result = NULL,
          state = '{}', cancel_requested = 0, attempts = 0, lease_owner = NULL, lease_until = NULL,
          started_at = NULL, finished_at = NULL, updated_at = ?, idempotency_key = request_key WHERE id = ?`,
    first?.key || null, first?.label || null, nowIso(), Number(jobId));
  appendJobEvent(jobId, 'info', `Retry requested by ${actor}: ${reason}`);
  return { ok: true, job: jobView(jobId) };
}

export function resumeJob(jobId, { actor = 'operator' } = {}) {
  ensureJobSchema();
  const job = decodeJob(jobRow(jobId));
  if (!job) return { ok: false, error: 'Job not found' };
  if (!['interrupted', 'cancelled', 'failed'].includes(job.status)) return { ok: false, error: `Job cannot be resumed from ${job.status}` };
  const stages = stageRows(jobId);
  const safe = stages.some((stage) => stage.status === 'complete');
  if (!safe) return { ok: false, error: 'No completed stage to resume from; use retry instead' };
  // A failed/cancelled job leaves unfinished stages as running or skipped; both
  // must be retried while genuinely completed stages are preserved.
  run("UPDATE operation_job_stages SET status = 'pending', started_at = NULL, finished_at = NULL WHERE job_id = ? AND status IN ('running','failed','skipped')", Number(jobId));
  const next = get("SELECT * FROM operation_job_stages WHERE job_id = ? AND status = 'pending' ORDER BY seq LIMIT 1", Number(jobId));
  run(`UPDATE operation_jobs SET status = 'queued', stage = ?, stage_label = ?, error = NULL, cancel_requested = 0,
          attempts = 0, lease_owner = NULL, lease_until = NULL, started_at = NULL, finished_at = NULL,
          updated_at = ?, idempotency_key = request_key WHERE id = ?`,
    next?.key || job.stage, next?.label || job.stage_label, nowIso(), Number(jobId));
  appendJobEvent(jobId, 'info', `Resume requested by ${actor}; completed stages are not repeated`);
  return { ok: true, job: jobView(jobId) };
}

export function recoverInterruptedJobs({ now = Date.now() } = {}) {
  ensureJobSchema();
  const instant = new Date(Number(now) || Date.now()).toISOString();
  const rows = all("SELECT id, kind, lease_until FROM operation_jobs WHERE status IN ('running','cancelling')");
  const recovered = [];
  for (const row of rows) {
    if (row.lease_until && row.lease_until > instant) continue;
    if (row.kind === 'update.panel' && pendingUpdateStateFile()) continue;
    markInterrupted(row.id, 'Interrupted by panel restart (lease expired)');
    recovered.push(row.id);
  }
  return recovered;
}

/** Queue workers: claim queued jobs and spawn one job-runner process per job. */
export function processQueuedJobs({ limit = 1, now = Date.now(), inline = false } = {}) {
  ensureJobSchema();
  const instant = new Date(Number(now) || Date.now()).toISOString();
  const rows = all(
    `SELECT id, kind FROM operation_jobs
     WHERE status = 'queued' AND cancel_requested = 0
       AND (lease_until IS NULL OR lease_until < ?)
     ORDER BY id ASC LIMIT ?`,
    instant, Math.max(1, Number(limit) || 1),
  );
  const spawned = [];
  const inlineRan = [];
  for (const row of rows) {
    if (inline || String(row.kind) === 'update.panel') {
      // A panel update must run in the panel process so it can coordinate the
      // self-restart; backups/restores also stay inline when explicitly asked.
      const promise = executeJobById(row.id).catch((error) => {
        console.warn('[openadmin] job runner:', error.message);
      });
      inlineRan.push(row.id);
      if (inline) {
        // The caller is a test/admin action and expects completion when awaited.
        void promise;
      }
    } else {
      try {
        spawned.push({ id: row.id, pid: spawnJobRunner(row.id).pid });
      } catch (error) {
        spawned.push({ id: row.id, error: error.message });
      }
    }
  }
  return { spawned, inline: inlineRan };
}

export function spawnJobRunner(jobId) {
  const moduleUrl = pathToFileURL(fileURLToPath(import.meta.url)).href;
  const script = `
import(${JSON.stringify(moduleUrl)})
  .then((mod) => mod.executeJobById(${Number(jobId)}))
  .then((result) => { if (!result.ok && result.status !== 'cancelled') console.error(result.error || result.status); process.exit(result.ok ? 0 : 1); })
  .catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(1); });
`;
  const child = spawn(process.execPath, ['--no-warnings', '-e', script], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      OA_DATA_DIR: config.dataDir,
      OA_JOB_RUNNER: '1',
      OA_JOB_OWNER: `${os.hostname()}:${process.pid}:runner:${crypto.randomBytes(4).toString('hex')}`,
    },
  });
  child.unref();
  return { ok: true, pid: child.pid };
}

function pendingUpdateStateFile() {
  try {
    const dir = path.join(config.dataDir, 'updates');
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter((name) => name.startsWith('pending-') && name.endsWith('.json'));
    if (!files.length) return null;
    const file = path.join(dir, files.sort().at(-1));
    return parseJson(fs.readFileSync(file, 'utf8'), null) ? file : null;
  } catch { return null; }
}

/* -------------------------------------------------------------------------- */
/* Upload limits (one real limit, base64-aware preflight)                      */
/* -------------------------------------------------------------------------- */

/**
 * The panel currently sends uploads as base64 JSON. The only real number is
 * config.limits.maxUploadMb; the JSON body must additionally hold +33% base64
 * expansion plus a small envelope. server.mjs therefore has to use
 * uploadLimits().maxJsonBodyBytes instead of its private 12 MB constant.
 */
export function uploadLimits() {
  const configured = Number(config.limits?.maxUploadMb);
  const maxUploadMb = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 8;
  const maxBytes = maxUploadMb * 1024 * 1024;
  return {
    maxUploadMb,
    maxBytes,
    maxBase64Bytes: Math.ceil(maxBytes / 3) * 4,
    maxJsonBodyBytes: Math.ceil(maxBytes / 3) * 4 + 256 * 1024,
    encoding: 'base64-json',
    source: 'config.limits.maxUploadMb',
  };
}

export function preflightUpload({ filename = 'upload.bin', size = null, encoding = 'base64' } = {}) {
  const limits = uploadLimits();
  const name = path.basename(String(filename || 'upload.bin'));
  if (!name || name === '.' || name === '..') return { ok: false, code: 'invalid_filename', error: 'Invalid file name', limits };
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes < 0) return { ok: false, code: 'invalid_size', error: 'File size is required before uploading', limits };
  if (bytes > limits.maxBytes) {
    return {
      ok: false,
      code: 'too_large',
      error: `File is ${formatMb(bytes)} but the panel limit is ${limits.maxUploadMb} MB (${limits.maxBytes} bytes). Upload rejected before transfer.`,
      limits,
      filename: name,
      size: bytes,
    };
  }
  const bodyBytes = encoding === 'base64' ? limits.maxBase64Bytes : limits.maxBytes;
  return { ok: true, filename: name, size: bytes, encoding, bodyBytes, limits };
}

/* -------------------------------------------------------------------------- */
/* Backup creation                                                            */
/* -------------------------------------------------------------------------- */

export const BACKUP_CREATE_STAGES = [
  { key: 'preflight', label: 'Preflight (scope, disk, dependencies)' },
  { key: 'snapshot', label: 'Consistent snapshot point' },
  { key: 'archive', label: 'Build archive' },
  { key: 'verify', label: 'Verify archive integrity' },
  { key: 'record', label: 'Record backup metadata' },
];

export const RESTORE_STAGES = [
  { key: 'preflight', label: 'Preflight (archive, disk, scope)' },
  { key: 'stage', label: 'Extract into staging' },
  { key: 'snapshot', label: 'Create restore point' },
  { key: 'verify', label: 'Verify integrity and conflicts' },
  { key: 'apply', label: 'Atomic swap / database restore' },
  { key: 'report', label: 'Per-object report' },
];

function userByUsername(username) {
  return get('SELECT * FROM users WHERE username = ?', String(username || ''));
}

function preflightUserScope(user, kind) {
  const safeKind = ['full', 'home', 'email', 'db'].includes(kind) ? kind : 'full';
  if (!user || !user.username) throw new OperationError('Target account does not exist', 'scope_missing');
  const home = userHome(user.username);
  const homesRoot = path.resolve(homeRoot());
  if (!pathInside(homesRoot, home)) {
    throw new OperationError(`Refusing to touch a home outside ${homesRoot}`, 'scope_violation', { home, homesRoot });
  }
  const targets = [];
  if (safeKind !== 'db' && fs.existsSync(home)) {
    if (safeKind === 'email') {
      const mail = path.join(home, 'mail');
      if (fs.existsSync(mail)) targets.push(mail);
    } else {
      targets.push(home);
    }
  }
  const estimate = targets.reduce((sum, target) => {
    const summary = dirSummary(target);
    return sum + summary.bytes;
  }, 0);
  return { kind: safeKind, home, homesRoot, targets, estimatedBytes: estimate };
}

function dbSnapshot(dir) {
  const target = path.join(dir, 'openadmin.db');
  const escaped = target.replace(/'/g, "''");
  getDb().exec(`VACUUM INTO '${escaped}'`);
  return target;
}

function archiveUserBackup(user, kind, { jobId = null, scope = null } = {}) {
  ensureBackupSchema();
  const pre = scope || preflightUserScope(user, kind);
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `user_${user.username}_${stamp}_${crypto.randomBytes(3).toString('hex')}.tar.gz`;
  const staging = fs.mkdtempSync(path.join(config.dataDir, 'backup-stage-'));
  const entries = [];
  const report = [];
  try {
    const home = pre.home;
    if (pre.kind !== 'db') {
      let source = home;
      let target = path.join('homes', user.username);
      if (pre.kind === 'email') {
        source = path.join(home, 'mail');
        target = path.join('homes', user.username, 'mail');
      }
      if (fs.existsSync(source)) {
        fs.mkdirSync(path.dirname(path.join(staging, target)), { recursive: true });
        fs.cpSync(source, path.join(staging, target), { recursive: true, preserveTimestamps: true });
        entries.push(target);
        const summary = dirSummary(path.join(staging, target));
        report.push({ object: target, status: 'archived', files: summary.files, bytes: summary.bytes });
      } else {
        report.push({ object: target, status: 'missing', files: 0, bytes: 0 });
      }
    }

    // User archives never contain the panel database (it holds every account's
    // hashes). Database content is exported per owned database instead.
    const databases = all('SELECT db_name FROM databases WHERE user_id = ?', user.id);
    const dumpDir = path.join(staging, 'databases');
    const dumped = [];
    if (pre.kind === 'full' || pre.kind === 'db') {
      for (const row of databases) {
        const dump = dumpDatabase(row.db_name);
        fs.mkdirSync(dumpDir, { recursive: true });
        if (dump.ok && dump.sql) {
          fs.writeFileSync(path.join(dumpDir, `${row.db_name}.sql`), dump.sql, { mode: 0o600 });
          dumped.push({ name: row.db_name, file: `${row.db_name}.sql`, bytes: Buffer.byteLength(dump.sql) });
          report.push({ object: `databases/${row.db_name}`, status: 'archived', bytes: Buffer.byteLength(dump.sql) });
        } else {
          dumped.push({ name: row.db_name, file: null, error: dump.error });
          report.push({ object: `databases/${row.db_name}`, status: 'failed', error: dump.error });
        }
      }
      if (dumped.length) entries.push('databases');
    }

    const assetManifest = hashTreeFiles(staging, { maxFiles: 20000 });
    const manifest = {
      product: 'OpenAdmin',
      manifestVersion: 2,
      username: user.username,
      kind: pre.kind,
      created: nowIso(),
      version: 1,
      jobId,
      scope: {
        level: 'user',
        kind: pre.kind,
        username: user.username,
        home,
        targets: pre.targets,
        excludes: pre.kind === 'db' ? [] : ['panel database (never included in user backups)'],
      },
      entries,
      databases: dumped,
      integrity: {
        algorithm: 'sha256',
        files: assetManifest.files,
        filesCount: assetManifest.files.length,
        bytes: assetManifest.bytes,
        truncated: assetManifest.truncated,
      },
      note: 'User backups exclude the panel database by design.',
    };
    fs.writeFileSync(path.join(staging, 'openadmin-backup.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    entries.push('openadmin-backup.json');

    const out = backupPath(filename);
    const tar = spawnSync('tar', ['-czf', out, '-C', staging, ...entries], { encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
    if (tar.status !== 0) throw new OperationError(`tar failed: ${(tar.stderr || '').trim()}`, 'archive_failed');
    const sha256 = sha256File(out);
    const verification = inspectTarFile(out);
    if (!verification.ok) throw new OperationError(`archive verification failed: ${verification.error}`, 'verify_failed');
    if (!verification.entries.includes('openadmin-backup.json')) {
      throw new OperationError('archive verification failed: manifest missing', 'verify_failed');
    }
    const size = sizeOf(out);
    const sizeBytes = bytesOf(out);
    const result = run(
      `INSERT INTO backups(user_id, filename, kind, size_mb, status, created_at, sha256, manifest, size_bytes, scope, verified_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      user.id, filename, pre.kind, size, 'complete', nowIso(), sha256, JSON.stringify(manifest), sizeBytes, 'user', nowIso(),
    );
    return {
      ok: true,
      id: result.lastInsertRowid,
      jobId,
      filename,
      size,
      sizeBytes,
      sha256,
      verified: true,
      manifest,
      databases: dumped,
      files: countFiles(staging),
      entries: verification.entries.length,
      report,
      scope: manifest.scope,
    };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function archiveServerBackup(admin, backupScope = 'all', { jobId = null } = {}) {
  ensureBackupSchema();
  const scopeSafe = backupScope === 'db' ? 'db' : 'all';
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `admin_backup_${stamp}_${crypto.randomBytes(3).toString('hex')}.tar.gz`;
  const staging = fs.mkdtempSync(path.join(config.dataDir, 'backup-stage-'));
  const entries = [];
  const report = [];
  try {
    let homesSummary = { files: 0, dirs: 0, bytes: 0 };
    if (scopeSafe !== 'db') {
      const homes = homeRoot();
      if (fs.existsSync(homes)) {
        const estimate = dirSummary(homes);
        requireDiskSpace(config.dataDir, estimate.bytes * 1.1, 'server backup staging');
        fs.cpSync(homes, path.join(staging, 'homes'), {
          recursive: true,
          preserveTimestamps: true,
          // Never archive our own staging/rollback directories.
          filter: (source) => {
            const base = path.basename(source);
            return !base.startsWith('.openadmin-restore-') && !base.startsWith('.openadmin-upload-');
          },
        });
        entries.push('homes');
        homesSummary = dirSummary(path.join(staging, 'homes'));
        report.push({ object: 'homes', status: 'archived', files: homesSummary.files, bytes: homesSummary.bytes });
      } else {
        report.push({ object: 'homes', status: 'missing', files: 0, bytes: 0 });
      }
    }
    const dbFile = dbSnapshot(staging);
    entries.push('openadmin.db');
    const dbSha = sha256File(dbFile);
    report.push({ object: 'openadmin.db', status: 'archived', bytes: bytesOf(dbFile), sha256: dbSha });

    const assetManifest = hashTreeFiles(staging, { maxFiles: 1 });
    const manifest = {
      product: 'OpenAdmin',
      manifestVersion: 2,
      kind: scopeSafe === 'db' ? 'server-db' : 'server',
      created: nowIso(),
      version: 1,
      jobId,
      scope: {
        level: 'server',
        kind: scopeSafe === 'db' ? 'db' : 'all',
        homeRoot: homeRoot(),
        excludes: scopeSafe === 'db' ? ['homes'] : [],
      },
      entries,
      database: { file: 'openadmin.db', sha256: dbSha, bytes: bytesOf(dbFile) },
      homes: { files: homesSummary.files, bytes: homesSummary.bytes, truncated: homesSummary.truncated },
      integrity: { algorithm: 'sha256', archiveOnly: true, sampleFiles: assetManifest.files.length },
      note: 'Server backups contain every home plus a consistent panel database snapshot.',
    };
    fs.writeFileSync(path.join(staging, 'openadmin-backup.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    entries.push('openadmin-backup.json');

    const out = backupPath(filename);
    const tar = spawnSync('tar', ['-czf', out, '-C', staging, ...entries], { encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024 });
    if (tar.status !== 0) throw new OperationError(`tar failed: ${(tar.stderr || '').trim()}`, 'archive_failed');
    const sha256 = sha256File(out);
    const verification = inspectTarFile(out);
    if (!verification.ok) throw new OperationError(`archive verification failed: ${verification.error}`, 'verify_failed');
    const size = sizeOf(out);
    const result = run(
      `INSERT INTO backups(user_id, filename, kind, size_mb, status, created_at, sha256, manifest, size_bytes, scope, verified_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      admin.id, filename, 'server', size, 'complete', nowIso(), sha256, JSON.stringify(manifest), bytesOf(out), 'server', nowIso(),
    );
    return {
      ok: true,
      id: result.lastInsertRowid,
      jobId,
      filename,
      size,
      sizeBytes: bytesOf(out),
      sha256,
      verified: true,
      manifest,
      files: countFiles(staging),
      entries: verification.entries.length,
      report,
      scope: manifest.scope,
    };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function backupCreateHandler(ctx) {
  const payload = ctx.job.payload || {};
  const level = payload.level === 'server' ? 'server' : 'user';
  const preflight = ctx.step('preflight', () => {
    if (level === 'user') {
      const user = userByUsername(payload.username);
      if (!user) throw new OperationError('Target account does not exist', 'scope_missing');
      const scope = preflightUserScope(user, payload.kind);
      const needs = Math.max(scope.estimatedBytes, 1024 * 1024);
      const disk = requireDiskSpace(config.dataDir, needs * 1.5 + 16 * 1024 * 1024, 'backup staging');
      return { level, scope, estimatedBytes: scope.estimatedBytes, disk, userId: user.id, username: user.username };
    }
    const admin = get("SELECT * FROM users WHERE level = 'admin' ORDER BY id LIMIT 1");
    if (!admin) throw new OperationError('No administrator account exists', 'scope_missing');
    const origin = payload.scope === 'db' ? config.dataDir : homeRoot();
    const homes = origin === homeRoot() ? dirSummary(homeRoot()) : { bytes: 0, files: 0 };
    const disk = requireDiskSpace(config.dataDir, Math.max(homes.bytes, 1024 * 1024) * 1.5 + 32 * 1024 * 1024, 'server backup staging');
    return { level, adminId: admin.id, admin: admin.username, scope: payload.scope === 'db' ? 'db' : 'all', estimatedBytes: homes.bytes, disk };
  });
  const snapshot = ctx.step('snapshot', () => {
    const marker = {
      at: nowIso(),
      level,
      scope: level === 'user' ? preflight.scope.kind : preflight.scope,
      consistency: level === 'server' ? 'sqlite VACUUM INTO snapshot' : 'live home copy into staging',
    };
    ctx.setState({ snapshotPoint: marker });
    return marker;
  });
  const archive = ctx.step('archive', () => {
    if (level === 'user') {
      const user = userByUsername(preflight.username);
      return archiveUserBackup(user, preflight.scope.kind, { jobId: ctx.job.id, scope: preflight.scope });
    }
    const admin = { id: preflight.adminId };
    return archiveServerBackup(admin, preflight.scope, { jobId: ctx.job.id });
  });
  ctx.step('verify', () => {
    const verification = inspectTarFile(backupPath(archive.filename));
    if (!verification.ok) throw new OperationError(`verify failed: ${verification.error}`, 'verify_failed');
    if (archive.sha256 !== sha256File(backupPath(archive.filename))) {
      throw new OperationError('verify failed: SHA-256 mismatch after archive creation', 'integrity_mismatch');
    }
    return { verified: true, sha256: archive.sha256, entries: verification.entries.length };
  });
  const result = ctx.step('record', () => ({
    ...archive,
    jobId: ctx.job.id,
    snapshot,
    verified: true,
    integrity: { algorithm: 'sha256', sha256: archive.sha256, verifiedAt: nowIso() },
  }));
  return result;
}

function enqueueUserBackup(user, kind, actor) {
  ensureBackupSchema();
  const safeKind = ['full', 'home', 'email', 'db'].includes(kind) ? kind : 'full';
  const bucket = Math.floor(Date.now() / 60000);
  return createJob({
    kind: 'backup.create',
    stages: BACKUP_CREATE_STAGES,
    actor: actor || user?.username || 'system',
    target: `user:${user?.username || '?'}`,
    payload: { level: 'user', username: user?.username, kind: safeKind },
    idempotencyKey: `backup.create:user:${user?.id || user?.username}:${safeKind}:${bucket}`,
    maxAttempts: 2,
  });
}

function enqueueServerBackup(admin, scope, actor) {
  ensureBackupSchema();
  const bucket = Math.floor(Date.now() / 60000);
  return createJob({
    kind: 'backup.create',
    stages: BACKUP_CREATE_STAGES,
    actor: actor || admin?.username || 'system',
    target: 'server',
    payload: { level: 'server', scope: scope === 'db' ? 'db' : 'all' },
    idempotencyKey: `backup.create:server:${scope === 'db' ? 'db' : 'all'}:${bucket}`,
    maxAttempts: 2,
  });
}

/**
 * Queue a user backup without running it inside the HTTP request. Callers must
 * kick the queue (scheduler processQueuedJobs/spawnJobRunner) and redirect to
 * the operation job page.
 */
export function createUserBackupJob(user, kind = 'full', { actor = null } = {}) {
  const job = enqueueUserBackup(user, kind, actor);
  return { ok: true, jobId: job.job.id, job: job.job, reused: job.reused };
}

/** Queue a server backup as a durable job (non-blocking route variant). */
export function createServerBackupJob(admin, scope = 'all', { actor = null } = {}) {
  const job = enqueueServerBackup(admin, scope, actor);
  return { ok: true, jobId: job.job.id, job: job.job, reused: job.reused };
}

/** Create a real archive for one account. Throws on failure (legacy contract). */
export function createUserBackup(user, kind = 'full') {
  const job = enqueueUserBackup(user, kind, null);
  if (job.reused && TERMINAL_JOB_STATUSES.includes(job.job.status)) {
    return job.job.result;
  }
  const outcome = executeJobSync(job.job.id);
  if (!outcome.ok) throw new Error(outcome.error || 'Backup failed');
  return outcome.result;
}

/** Server-wide archive of every home plus the database. */
export function createServerBackup(admin, scope = 'all') {
  const job = enqueueServerBackup(admin, scope, null);
  if (job.reused && TERMINAL_JOB_STATUSES.includes(job.job.status)) return job.job.result;
  const outcome = executeJobSync(job.job.id);
  if (!outcome.ok) throw new Error(outcome.error || 'Backup failed');
  return outcome.result;
}

/* -------------------------------------------------------------------------- */
/* Restore                                                                    */
/* -------------------------------------------------------------------------- */

function backupRowByFilename(filename) {
  return get('SELECT * FROM backups WHERE filename = ? ORDER BY id DESC LIMIT 1', safeName(filename));
}

function verifyRestoreSource(file, { expectedSha = null, manifest = null } = {}) {
  const info = inspectTarFile(file);
  if (!info.ok) throw new OperationError(`archive rejected: ${info.error}`, info.code || 'invalid_archive');
  const sha256 = sha256File(file);
  if (expectedSha && sha256 !== expectedSha) {
    throw new OperationError('archive SHA-256 does not match the recorded backup identity', 'integrity_mismatch', { expected: expectedSha, actual: sha256 });
  }
  const archiveManifest = manifest || readArchiveManifest(file);
  if (archiveManifest) {
    if (archiveManifest.product && archiveManifest.product !== 'OpenAdmin') {
      throw new OperationError(`archive belongs to ${archiveManifest.product}, not OpenAdmin`, 'wrong_product');
    }
    if (archiveManifest.integrity?.algorithm === 'sha256' && Array.isArray(archiveManifest.integrity.files)) {
      for (const entry of archiveManifest.integrity.files) {
        if (!entry || entry.type !== 'file' || !entry.sha256) continue;
        const rel = String(entry.path || '');
        if (!rel || unsafeArchivePath(rel)) throw new OperationError('manifest contains an unsafe path', 'unsafe_archive');
      }
    }
  }
  return { info, sha256, manifest: archiveManifest };
}

function listRelFiles(root) {
  const out = [];
  const walk = (dir, rel = '') => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(full, relPath); continue; }
      let stat;
      try { stat = fs.lstatSync(full); } catch { continue; }
      out.push({ path: relPath, bytes: stat.size, type: entry.isSymbolicLink() ? 'symlink' : 'file' });
    }
  };
  walk(root);
  return out;
}

function conflictPreview(target, replacement, archiveEntries) {
  const current = fs.existsSync(target) ? listRelFiles(target) : [];
  const incoming = fs.existsSync(replacement) ? listRelFiles(replacement) : [];
  const currentMap = new Map(current.map((entry) => [entry.path, entry]));
  const incomingMap = new Map(incoming.map((entry) => [entry.path, entry]));
  let added = 0;
  let overwritten = 0;
  let changed = 0;
  const sample = [];
  for (const entry of incoming) {
    const existing = currentMap.get(entry.path);
    if (!existing) {
      added++;
      if (sample.length < 20) sample.push({ path: entry.path, change: 'added' });
    } else {
      overwritten++;
      if (existing.bytes !== entry.bytes) {
        changed++;
        if (sample.length < 20) sample.push({ path: entry.path, change: 'changed', before: existing.bytes, after: entry.bytes });
      }
    }
  }
  const removed = current.filter((entry) => !incomingMap.has(entry.path)).length;
  const archiveFiles = Array.isArray(archiveEntries) ? archiveEntries.length : null;
  return {
    target,
    currentFiles: current.length,
    archiveFiles: incoming.length || archiveFiles || 0,
    added,
    overwritten,
    changed,
    removed,
    sample,
  };
}

function restoreUserArchive({ user, row, jobId, ctx, previewOnly = false }) {
  ensureBackupSchema();
  const filename = safeName(row.filename);
  const file = backupPath(filename);
  const scope = ctx.step('preflight', () => {
    if (!user) throw new OperationError('Target account does not exist', 'scope_missing');
    const rowOwner = get('SELECT * FROM users WHERE id = ?', row.user_id);
    if (rowOwner && rowOwner.username !== user.username) {
      throw new OperationError('Backup belongs to a different account', 'scope_violation', { owner: rowOwner.username });
    }
    const info = verifyRestoreSource(file, { expectedSha: row.sha256 || null });
    const manifest = info.manifest;
    if (manifest && manifest.username && manifest.username !== user.username) {
      throw new OperationError('Archive manifest belongs to a different account', 'scope_violation');
    }
    const archiveKind = manifest?.kind || row.kind || 'full';
    const extractionNeed = Math.max(info.info.bytes * 4, 32 * 1024 * 1024);
    const disk = requireDiskSpace(config.dataDir, extractionNeed, 'restore staging');
    const homeParent = path.dirname(userHome(user.username));
    const homeDisk = fs.existsSync(homeParent)
      ? requireDiskSpace(homeParent, extractionNeed, 'restore staging on the home filesystem')
      : { ok: true, checked: false, required: extractionNeed, free: null };
    return {
      filename,
      sha256: info.sha256,
      expectedSha: row.sha256 || null,
      archiveKind,
      entries: info.info.entries.length,
      bytes: info.info.bytes,
      disk,
      homeDisk,
      verifiedAt: nowIso(),
    };
  });

  let workRoot = null;
  try {
  const staging = ctx.step('stage', () => {
    const home = userHome(user.username);
    fs.mkdirSync(path.dirname(home), { recursive: true, mode: 0o755 });
    const work = fs.mkdtempSync(path.join(path.dirname(home), '.openadmin-restore-'));
    workRoot = work;
    try {
      const extracted = path.join(work, 'archive');
      const extraction = safeExtractTar(file, extracted);
      if (!extraction.ok) throw new OperationError(`staging failed: ${extraction.error}`, extraction.code || 'extract_failed');
      const sourceRoot = path.join(extracted, 'homes', user.username);
      if (scope.archiveKind === 'db') {
        return { work, extracted, sourceRoot: path.join(extracted, 'databases'), target: null, action: 'databases-archived', conflicts: null };
      }
      if (!fs.existsSync(sourceRoot)) throw new OperationError('Archive does not contain this account home', 'scope_missing');
      if (scope.archiveKind === 'email') {
        const mail = path.join(sourceRoot, 'mail');
        if (!fs.existsSync(mail)) throw new OperationError('Archive does not contain this account mail directory', 'scope_missing');
        const conflicts = conflictPreview(path.join(home, 'mail'), mail, null);
        return { work, extracted, sourceRoot: mail, target: path.join(home, 'mail'), action: 'replace-mail', conflicts };
      }
      const conflicts = conflictPreview(home, sourceRoot, null);
      return { work, extracted, sourceRoot, target: home, action: 'replace-home', conflicts };
    } catch (error) {
      fs.rmSync(work, { recursive: true, force: true });
      throw error;
    }
  });

  if (previewOnly) return { scope, staging, preview: true };

  const snapshot = ctx.step('snapshot', () => {
    // Restore point: a full archive of the account as it is right now.
    const snapshotJobId = createJob({
      kind: 'backup.create',
      stages: BACKUP_CREATE_STAGES,
      actor: 'restore',
      target: `user:${user.username}`,
      payload: { level: 'user', username: user.username, kind: 'full' },
      maxAttempts: 1,
    });
    const snapshotOutcome = executeJobSync(snapshotJobId.job.id);
    if (!snapshotOutcome.ok) throw new OperationError(`restore point failed: ${snapshotOutcome.error}`, 'snapshot_failed');
    ctx.setState({ snapshot: snapshotOutcome.result.filename, snapshotJobId: snapshotJobId.job.id });
    return {
      filename: snapshotOutcome.result.filename,
      sha256: snapshotOutcome.result.sha256,
      jobId: snapshotJobId.job.id,
      createdAt: nowIso(),
    };
  });

  ctx.step('verify', () => {
    const fileSha = sha256File(file);
    if (scope.expectedSha && fileSha !== scope.expectedSha) {
      throw new OperationError('archive changed between preflight and apply', 'integrity_mismatch');
    }
    const manifest = readArchiveManifest(file);
    const problems = [];
    if (manifest?.integrity?.files?.length) {
      const extractedRoot = staging.extracted;
      for (const entry of manifest.integrity.files) {
        if (!entry || entry.type !== 'file' || !entry.sha256) continue;
        const rel = String(entry.path || '');
        if (!rel || unsafeArchivePath(rel)) { problems.push(`${rel || '?'}: unsafe path`); continue; }
        const target = path.join(extractedRoot, rel);
        if (!pathInside(extractedRoot, target)) { problems.push(`${rel}: escapes root`); continue; }
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) { problems.push(`${rel}: missing`); continue; }
        if (entry.bytes !== undefined && Number(entry.bytes) !== fs.statSync(target).size) { problems.push(`${rel}: size mismatch`); continue; }
        if (sha256File(target) !== entry.sha256) problems.push(`${rel}: sha256 mismatch`);
        if (problems.length > 5) break;
      }
    }
    if (problems.length) throw new OperationError(`integrity verification failed: ${problems.slice(0, 3).join('; ')}`, 'integrity_mismatch', { problems });
    return { verified: true, sha256: fileSha, stagedFiles: listRelFiles(staging.extracted).length };
  });

  const applied = ctx.step('apply', () => {
    const target = staging.target;
    if (!target) {
      return { applied: false, action: 'databases-archived', note: 'Database dumps are archived in this backup; panel restore does not import user databases.' };
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const previous = `${target}.pre-restore-${stamp}`;
    let movedPrevious = false;
    let swapped = false;
    try {
      if (fs.existsSync(target)) { fs.renameSync(target, previous); movedPrevious = true; }
      fs.renameSync(staging.sourceRoot, target);
      swapped = true;
      if (process.env.OA_RESTORE_FAULT === 'after-apply' || ctx.job.payload?.__fault === 'after-apply') {
        throw new Error('injected restore fault after atomic swap (test hook)');
      }
      const summary = dirSummary(target);
      if (movedPrevious) fs.rmSync(previous, { recursive: true, force: true });
      return { applied: true, action: staging.action, files: summary.files, bytes: summary.bytes, conflicts: staging.conflicts };
    } catch (error) {
      let rolledBack = false;
      const failurePath = `${target}.failed-${stamp}`;
      try {
        if (swapped && fs.existsSync(target)) fs.renameSync(target, failurePath);
        if (movedPrevious && fs.existsSync(previous)) fs.renameSync(previous, target);
        rolledBack = true;
      } catch (rollbackError) {
        ctx.log('error', `Rollback failed: ${rollbackError.message}`);
      }
      try { fs.rmSync(failurePath, { recursive: true, force: true }); } catch { /* ignore */ }
      ctx.setResult({ rolledBack, action: staging.action, target, error: error.message });
      throw new OperationError(`restore apply failed: ${error.message}${rolledBack ? ' (previous state restored)' : ' (ROLLBACK FAILED)'}`,
        'apply_failed', { rolledBack, target });
    }
  });

  const report = ctx.step('report', () => ({
    objects: [
      ...(staging.target ? [{ object: staging.action === 'replace-mail' ? `home:${user.username}/mail` : `home:${user.username}`, status: 'restored', action: staging.action, files: applied.files, bytes: applied.bytes, conflicts: staging.conflicts }] : []),
      ...(staging.target ? [] : [{ object: `databases:${user.username}`, status: 'archived_only', note: 'SQL dumps are stored in the archive; import them with the database tooling.' }]),
    ],
    restorePoint: snapshot,
    archive: { filename, sha256: scope.sha256, expectedSha: scope.expectedSha, entries: scope.entries },
  }));
  run('UPDATE backups SET verified_at = ? WHERE filename = ?', nowIso(), filename);
  return { ok: true, files: applied.files || 0, jobId, report: report.objects, restorePoint: snapshot, archive: report.archive };
  } finally {
    if (workRoot) fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

function restoreUserHandler(ctx) {
  const payload = ctx.job.payload || {};
  const user = userByUsername(payload.username);
  const row = backupRowByFilename(payload.filename);
  if (!row) throw new OperationError('Backup record not found', 'not_found');
  if (user && row.user_id !== user.id) throw new OperationError('Backup belongs to a different account', 'scope_violation');
  return restoreUserArchive({ user, row, jobId: ctx.job.id, ctx });
}

/** Restore one account's archive transactionally. Legacy synchronous contract. */
export function restoreUserBackup(user, filename) {
  ensureBackupSchema();
  const bucket = Math.floor(Date.now() / 60000);
  const job = createJob({
    kind: 'backup.restore.user',
    stages: RESTORE_STAGES,
    actor: user?.username || 'system',
    target: `user:${user?.username || '?'}`,
    payload: { level: 'user', username: user?.username, filename: safeName(filename) },
    idempotencyKey: `backup.restore:user:${user?.username || '?'}:${safeName(filename)}:${bucket}`,
    maxAttempts: 2,
  });
  if (job.reused && TERMINAL_JOB_STATUSES.includes(job.job.status)) return job.job.result;
  const outcome = executeJobSync(job.job.id);
  if (!outcome.ok) {
    const detail = outcome.result || {};
    return { ok: false, error: outcome.error, jobId: job.job.id, rolledBack: !!detail.rolledBack };
  }
  return { ...outcome.result, jobId: job.job.id, ok: true };
}

/** Queue a user restore as a durable job (non-blocking route variant). */
export function enqueueUserRestore(user, filename, { actor = null } = {}) {
  ensureBackupSchema();
  const bucket = Math.floor(Date.now() / 60000);
  const job = createJob({
    kind: 'backup.restore.user',
    stages: RESTORE_STAGES,
    actor: actor || user?.username || 'system',
    target: `user:${user?.username || '?'}`,
    payload: { level: 'user', username: user?.username, filename: safeName(filename) },
    idempotencyKey: `backup.restore:user:${user?.username || '?'}:${safeName(filename)}:${bucket}`,
    maxAttempts: 2,
  });
  return { ok: true, jobId: job.job.id, job: job.job, reused: job.reused };
}

/** Dry-run preview of a user restore (no writes). */
export function previewUserRestore(user, filename) {
  ensureBackupSchema();
  const row = backupRowByFilename(filename);
  if (!row) return { ok: false, error: 'Backup record not found', code: 'not_found' };
  if (user && row.user_id !== user.id) return { ok: false, error: 'Backup belongs to a different account', code: 'scope_violation' };
  const file = backupPath(row.filename);
  const info = inspectTarFile(file);
  if (!info.ok) return { ok: false, error: info.error, code: info.code };
  const sha256 = sha256File(file);
  if (row.sha256 && sha256 !== row.sha256) return { ok: false, error: 'Archive SHA-256 mismatch', code: 'integrity_mismatch' };
  const manifest = readArchiveManifest(file);
  const kind = manifest?.kind || row.kind || 'full';
  const home = userHome(user.username);
  const target = kind === 'email' ? path.join(home, 'mail') : kind === 'db' ? null : home;
  const current = target && fs.existsSync(target) ? listRelFiles(target) : [];
  const archiveEntries = info.entries.filter((entry) => entry.startsWith(`homes/${user.username}/`) || entry === `homes/${user.username}` || entry.startsWith('databases/'));
  const incomingCount = archiveEntries.filter((entry) => !entry.endsWith('/')).length;
  return {
    ok: true,
    filename: row.filename,
    sha256,
    expectedSha: row.sha256 || null,
    integrity: { verified: !!row.sha256, algorithm: 'sha256', archiveVerifiedAt: row.verified_at || null },
    kind,
    scope: manifest?.scope || { level: 'user', kind },
    target,
    entries: info.entries.length,
    archiveFiles: incomingCount,
    currentFiles: current.length,
    conflicts: {
      overwritten: Math.min(current.length, incomingCount),
      added: Math.max(0, incomingCount - current.length),
      removed: Math.max(0, current.length - incomingCount),
      note: 'Dry-run compares the archive inventory with the current home. Apply runs in staging with an automatic rollback point.',
    },
    sample: archiveEntries.slice(0, 40),
    backup: row,
  };
}

/* -------------------------------------------------------------------------- */
/* Upload jobs                                                                */
/* -------------------------------------------------------------------------- */

export const UPLOAD_STAGES = [
  { key: 'preflight', label: 'Preflight (limit, target, disk, conflict)' },
  { key: 'stage', label: 'Stage bytes next to the target' },
  { key: 'verify', label: 'Verify size and SHA-256' },
  { key: 'move', label: 'Atomic move into place' },
  { key: 'report', label: 'Record the upload job' },
];

function resolveUploadTarget(user, directory, filename) {
  const username = String(user?.username || '');
  if (!username) throw new OperationError('Upload target account is missing', 'scope_missing');
  const home = path.resolve(userHome(username));
  let rel = String(directory || '');
  const homeDisplay = `/home/${username}`;
  if (rel === homeDisplay) rel = '';
  else if (rel.startsWith(`${homeDisplay}/`)) rel = rel.slice(homeDisplay.length + 1);
  else if (rel.startsWith('/')) throw new OperationError('Upload directory is outside the account home', 'scope_violation');
  const dir = path.resolve(home, rel || '.');
  if (!pathInside(home, dir)) throw new OperationError('Upload directory is outside the account home', 'scope_violation');
  if (fs.existsSync(dir)) {
    // SEC-002: a symlinked directory must not move the write outside the home.
    const realHome = fs.realpathSync(home);
    const realDir = fs.realpathSync(dir);
    if (!pathInside(realHome, realDir)) throw new OperationError('Upload directory resolves outside the account home', 'symlink_blocked');
  }
  const name = path.basename(String(filename || ''));
  if (!name || name === '.' || name === '..' || name.includes('\0') || name !== String(filename || '')) {
    throw new OperationError('Invalid upload file name', 'invalid_filename');
  }
  const target = path.join(dir, name);
  if (!pathInside(home, target)) throw new OperationError('Upload target is outside the account home', 'scope_violation');
  return { home, dir, name, target };
}

function uploadHandler(ctx) {
  const payload = ctx.job.payload || {};
  const user = userByUsername(payload.username);
  const preflight = ctx.step('preflight', () => {
    if (!user) throw new OperationError('Upload target account is missing', 'scope_missing');
    const resolved = resolveUploadTarget(user, payload.directory, payload.filename);
    if (!fs.existsSync(resolved.dir) || !fs.statSync(resolved.dir).isDirectory()) {
      throw new OperationError(`Upload directory does not exist: ${resolved.dir}`, 'target_missing');
    }
    if (!fs.existsSync(payload.tempPath)) throw new OperationError('Staged upload file is missing', 'upload_missing');
    const stat = fs.lstatSync(payload.tempPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new OperationError('Staged upload is not a regular file', 'invalid_upload');
    if (payload.size !== undefined && Number(payload.size) !== stat.size) {
      throw new OperationError(`Declared upload size ${payload.size} does not match ${stat.size} bytes`, 'size_mismatch');
    }
    const sizeCheck = preflightUpload({ filename: resolved.name, size: stat.size });
    if (!sizeCheck.ok) throw new OperationError(sizeCheck.error, sizeCheck.code);
    if (fs.existsSync(resolved.target)) {
      const existing = fs.lstatSync(resolved.target);
      if (existing.isSymbolicLink()) throw new OperationError('Refusing to overwrite a symbolic link', 'symlink_blocked');
      if (!payload.overwrite) throw new OperationError(`Target already exists: ${resolved.name}`, 'conflict');
    }
    requireDiskSpace(resolved.dir, stat.size + 16 * 1024 * 1024, 'upload staging');
    return { ...resolved, size: stat.size, limit: sizeCheck.limits };
  });
  const part = path.join(preflight.dir, `.openadmin-upload-${ctx.job.id}.part`);
  let moved = false;
  try {
    const staged = ctx.step('stage', () => {
      fs.copyFileSync(payload.tempPath, part);
      fs.chmodSync(part, 0o600);
      return { part, bytes: fs.statSync(part).size };
    });
    const verified = ctx.step('verify', () => {
      const sha256 = sha256File(part);
      if (payload.sha256 && String(payload.sha256).toLowerCase() !== sha256) {
        throw new OperationError('Upload SHA-256 does not match the declared checksum', 'integrity_mismatch');
      }
      if (fs.statSync(part).size !== preflight.size) throw new OperationError('Uploaded byte count changed during staging', 'size_mismatch');
      return { sha256, bytes: preflight.size };
    });
    ctx.step('move', () => {
      let previous = null;
      if (fs.existsSync(preflight.target)) {
        previous = `${preflight.target}.openadmin-old-${ctx.job.id}`;
        fs.renameSync(preflight.target, previous);
      }
      try {
        fs.renameSync(part, preflight.target);
        moved = true;
        if (previous) fs.rmSync(previous, { force: true });
      } catch (error) {
        if (previous && fs.existsSync(previous) && !fs.existsSync(preflight.target)) fs.renameSync(previous, preflight.target);
        throw new OperationError(`Atomic upload move failed: ${error.message}`, 'move_failed');
      }
      return { target: preflight.target };
    });
    return ctx.step('report', () => ({
      ok: true,
      jobId: ctx.job.id,
      filename: preflight.name,
      path: resolvedUploadDisplay(user.username, preflight.target),
      size: verified.bytes,
      sha256: verified.sha256,
      directory: preflight.dir,
      stagedBytes: staged.bytes,
      limit: preflight.limit,
    }));
  } finally {
    if (!moved) { try { fs.rmSync(part, { force: true }); } catch { /* ignore */ } }
    if (payload.tempPath) { try { fs.rmSync(payload.tempPath, { force: true }); } catch { /* ignore */ } }
  }
}

function resolvedUploadDisplay(username, target) {
  const home = path.resolve(userHome(username));
  const relative = path.relative(home, target);
  return `/home/${username}/${relative.split(path.sep).join('/')}`;
}

/**
 * Create a durable upload job. The HTTP layer must stream the incoming file to
 * `tempPath` first and then call this function, so the request itself never
 * holds a long copy operation and a refresh cannot lose the upload.
 */
export function createUploadJob({
  user,
  directory = '',
  filename,
  tempPath,
  size = null,
  sha256 = null,
  overwrite = false,
  actor = user?.username || 'system',
  idempotencyKey = null,
} = {}) {
  ensureJobSchema();
  const statSize = size !== null && size !== undefined ? Number(size) : (tempPath && fs.existsSync(tempPath) ? fs.statSync(tempPath).size : NaN);
  const check = preflightUpload({ filename, size: statSize });
  if (!check.ok) return { ok: false, ...check };
  const name = check.filename;
  const key = idempotencyKey || `upload.store:${user?.username || '?'}:${directory}:${name}:${statSize}:${Math.floor(Date.now() / 60000)}`;
  const job = createJob({
    kind: 'upload.store',
    stages: UPLOAD_STAGES,
    actor,
    target: `upload:${user?.username || '?'}:${name}`,
    payload: { username: user?.username, directory, filename: name, tempPath, size: statSize, sha256, overwrite },
    idempotencyKey: key,
    maxAttempts: 2,
  });
  return { ok: true, jobId: job.job.id, job: job.job, reused: job.reused, limits: check.limits };
}

/* -------------------------------------------------------------------------- */
/* Legacy ownership helper (unchanged contract)                               */
/* -------------------------------------------------------------------------- */

/** Resolve a backup row for download, checking ownership. */
export function backupFor(user, id) {
  const row = get('SELECT * FROM backups WHERE id = ?', Number(id));
  if (!row) return null;
  if (user.level === 'admin') return row;
  if (user.level === 'reseller') {
    const owner = get('SELECT owner FROM users WHERE id = ?', row.user_id);
    if (owner?.owner === user.username || row.user_id === user.id) return row;
    return null;
  }
  return row.user_id === user.id ? row : null;
}

/* -------------------------------------------------------------------------- */
/* Core handler registration                                                  */
/* -------------------------------------------------------------------------- */

registerJobHandler('backup.create', backupCreateHandler, { mode: 'sync' });
registerJobHandler('backup.restore.user', restoreUserHandler, { mode: 'sync' });
registerJobHandler('upload.store', uploadHandler, { mode: 'sync' });

export function ensureJobHandlers() {
  return [...jobHandlers.keys()];
}

/** External stage/finish helpers for processes that hand a job across a restart. */
export function setJobStageExternally(jobId, key, status, options = {}) {
  ensureJobSchema();
  return setStage(jobId, key, status, options);
}

export function finishJobExternally(jobId, status, { result = null, error = '' } = {}) {
  ensureJobSchema();
  const allowed = ['succeeded', 'failed', 'cancelled', 'interrupted'];
  if (!allowed.includes(String(status))) throw new Error(`Invalid terminal status: ${status}`);
  finishJob(jobId, String(status), { result, error });
  return jobView(jobId);
}

export function appendJobEventExternally(jobId, level, message) {
  ensureJobSchema();
  appendJobEvent(jobId, level, message);
}
