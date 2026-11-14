// Durable jobs, transactional restore, scheduler leases and update signing.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openadmin-jobs-restore-'));
process.env.OA_DATA_DIR = dataDir;
process.env.OA_DEMO = '1';
process.env.OA_PROVIDER = 'sandbox';
process.env.OA_AUTOMATION_TICK_MS = '600000';
delete process.env.OA_UPDATE_PUBLIC_KEY;
delete process.env.OA_UPDATE_ALLOW_UNSIGNED;
delete process.env.OA_UPDATE_SKIP_RESTART;
delete process.env.OA_RESTORE_FAULT;

const db = await import('../src/db.mjs');
const backups = await import('../src/backups.mjs');
const backupcenter = await import('../src/backupcenter.mjs');
const scheduler = await import('../src/scheduler.mjs');
const updates = await import('../src/updates.mjs');

const user = () => db.get("SELECT * FROM users WHERE username = 'demouser'");
const admin = () => db.get("SELECT * FROM users WHERE username = 'demoadmin'");
const home = () => path.join(dataDir, 'homes', 'demouser');

before(() => {
  db.getDb();
  db.seedBase({ adminUser: 'demoadmin', adminPassword: 'admin-test-pass', serverName: 'jobs.test', serverIp: '127.0.0.1' });
  db.seedDemo();
  fs.mkdirSync(home(), { recursive: true });
  fs.writeFileSync(path.join(home(), 'probe.txt'), 'before');
});

after(() => {
  try { db.closeDb(); } catch { /* ignore */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('durable job schema is additive and the migration SQL is exported', () => {
  backups.ensureJobSchema();
  backups.ensureBackupSchema();
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name);
  for (const table of ['operation_jobs', 'operation_job_stages', 'operation_job_events', 'scheduler_leases']) {
    assert.ok(tables.includes(table), `missing ${table}`);
  }
  const backupColumns = db.all('PRAGMA table_info(backups)').map((column) => column.name);
  for (const column of ['sha256', 'manifest', 'size_bytes', 'verified_at']) assert.ok(backupColumns.includes(column), `backups.${column}`);
  const jobColumns = db.all('PRAGMA table_info(backup_jobs)').map((column) => column.name);
  for (const column of ['next_run_at', 'timezone', 'schedule_time', 'catch_up_minutes', 'lease_owner', 'lease_until']) assert.ok(jobColumns.includes(column), `backup_jobs.${column}`);
  assert.match(backups.DURABLE_JOBS_MIGRATION, /CREATE TABLE IF NOT EXISTS operation_jobs/);
  assert.match(backups.BACKUP_METADATA_MIGRATION, /ALTER TABLE backups ADD COLUMN sha256/);
});

test('idempotency key deduplicates active jobs and is released on finish', async () => {
  const stages = [{ key: 'only', label: 'Only stage' }];
  backups.registerJobHandler('test.idempotency', (ctx) => ctx.step('only', () => ({ ok: true })), { mode: 'sync' });
  const first = backups.createJob({ kind: 'test.idempotency', stages, actor: 'tester', idempotencyKey: 'idem-key-1' });
  const second = backups.createJob({ kind: 'test.idempotency', stages, actor: 'tester', idempotencyKey: 'idem-key-1' });
  assert.equal(second.reused, true);
  assert.equal(second.job.id, first.job.id);
  const outcome = backups.executeJobSync(first.job.id);
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.job.status, 'succeeded');
  assert.equal(outcome.job.progress, 100);
  const third = backups.createJob({ kind: 'test.idempotency', stages, actor: 'tester', idempotencyKey: 'idem-key-1' });
  assert.equal(third.reused, false);
  assert.notEqual(third.job.id, first.job.id);
  const row = db.get('SELECT idempotency_key, request_key FROM operation_jobs WHERE id = ?', first.job.id);
  assert.equal(row.idempotency_key, null, 'active idempotency key is cleared on finish');
  assert.equal(row.request_key, 'idem-key-1', 'request key is kept for history');
});

test('progress is derived from real stages, log is durable and resume skips completed stages', async () => {
  const stages = [
    { key: 'one', label: 'One' }, { key: 'two', label: 'Two' }, { key: 'three', label: 'Three' },
  ];
  let oneRuns = 0;
  let failAtTwo = true;
  backups.registerJobHandler('test.resume', (ctx) => {
    ctx.step('one', () => { oneRuns += 1; return { prepared: true }; });
    ctx.step('two', () => {
      if (failAtTwo) throw new Error('injected stage failure');
      return { copied: true };
    });
    ctx.step('three', () => ({ verified: true }));
    return { ok: true };
  }, { mode: 'sync' });

  const created = backups.createJob({ kind: 'test.resume', stages, actor: 'tester' });
  const failed = backups.executeJobSync(created.job.id);
  assert.equal(failed.ok, false);
  const failedView = backups.jobView(created.job.id);
  assert.equal(failedView.status, 'failed');
  assert.equal(failedView.stagesDone, 1, 'only the first stage completed');
  assert.ok(failedView.events.some((event) => /Stage failed: Two/.test(event.message)));
  const persisted = db.get('SELECT status, progress FROM operation_jobs WHERE id = ?', created.job.id);
  assert.equal(persisted.status, 'failed');

  failAtTwo = false;
  const resumed = backups.resumeJob(created.job.id, { actor: 'tester' });
  assert.equal(resumed.ok, true, resumed.error);
  const outcome = backups.executeJobSync(created.job.id);
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.job.status, 'succeeded');
  assert.equal(outcome.job.progress, 100);
  assert.equal(oneRuns, 1, 'completed stage was not repeated on resume');
  assert.ok(outcome.job.events.some((event) => /already completed; resumed/.test(event.message)));
});

test('cancelling a queued job is durable and cannot run later', async () => {
  const created = backups.createJob({ kind: 'test.cancelled', stages: [{ key: 'one', label: 'One' }], actor: 'tester' });
  backups.registerJobHandler('test.cancelled', (ctx) => ctx.step('one', () => 'never'), { mode: 'sync' });
  const cancelled = backups.cancelJob(created.job.id, { actor: 'tester' });
  assert.equal(cancelled.ok, true);
  assert.equal(backups.jobView(created.job.id).status, 'cancelled');
  const outcome = await backups.executeJobById(created.job.id);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 'cancelled');
});

test('backup archive carries SHA-256, a manifest and a per-object report', () => {
  const backup = backups.createUserBackup(user(), 'home');
  assert.equal(backup.ok, true);
  const archive = backups.backupPath(backup.filename);
  assert.ok(fs.existsSync(archive));
  assert.equal(backup.sha256, backups.sha256File(archive));
  const row = db.get('SELECT * FROM backups WHERE filename = ?', backup.filename);
  assert.equal(row.sha256, backup.sha256);
  assert.equal(row.size_bytes, fs.statSync(archive).size);
  const manifest = JSON.parse(row.manifest);
  assert.equal(manifest.product, 'OpenAdmin');
  assert.equal(manifest.manifestVersion, 2);
  assert.ok(manifest.integrity.files.length >= 1);
  assert.ok(manifest.integrity.files.every((entry) => !entry.sha256 || /^[a-f0-9]{64}$/.test(entry.sha256)));
  assert.ok(Array.isArray(backup.report) && backup.report.some((entry) => entry.object === 'homes/demouser'));
  const inspected = backups.inspectArchive(backup.filename);
  assert.equal(inspected.ok, true);
  assert.ok(inspected.entries.includes('openadmin-backup.json'));
  assert.ok(!inspected.entries.includes('openadmin.db'), 'user backup never contains the panel database');
  const view = backups.jobView(backup.jobId);
  assert.equal(view.status, 'succeeded');
  assert.equal(view.progress, 100);
  assert.ok(view.stages.every((stage) => stage.status === 'complete'));
});

test('user restore is transactional and leaves a restore point', () => {
  const backup = backups.createUserBackup(user(), 'full');
  fs.writeFileSync(path.join(home(), 'probe.txt'), 'changed-live');
  const restored = backups.restoreUserBackup(user(), backup.filename);
  assert.equal(restored.ok, true, restored.error);
  assert.equal(fs.readFileSync(path.join(home(), 'probe.txt'), 'utf8'), 'before');
  assert.ok(restored.jobId);
  const job = backups.jobView(restored.jobId);
  assert.equal(job.status, 'succeeded');
  assert.ok(Array.isArray(restored.report));
  assert.ok(restored.report.some((entry) => entry.object === 'home:demouser' && entry.status === 'restored'));
  assert.ok(restored.restorePoint?.filename, 'restore point snapshot recorded');
  assert.ok(fs.existsSync(backups.backupPath(restored.restorePoint.filename)), 'snapshot archive exists');
});

test('a failing restore automatically rolls the home back', () => {
  const backup = backups.createUserBackup(user(), 'full');
  fs.writeFileSync(path.join(home(), 'probe.txt'), 'after-live');
  process.env.OA_RESTORE_FAULT = 'after-apply';
  try {
    const restored = backups.restoreUserBackup(user(), backup.filename);
    assert.equal(restored.ok, false);
    assert.equal(restored.rolledBack, true, 'rollback flag is reported');
    assert.equal(fs.readFileSync(path.join(home(), 'probe.txt'), 'utf8'), 'after-live', 'live state restored after failure');
    const job = backups.jobView(restored.jobId);
    assert.equal(job.status, 'failed');
    assert.match(job.error, /previous state restored/);
    assert.equal(job.result?.rolledBack, true);
    assert.ok(!fs.existsSync(`${home()}.failed-${'x'}`));
    const leftovers = fs.readdirSync(path.dirname(home())).filter((name) => name.startsWith('.openadmin-restore-'));
    assert.deepEqual(leftovers, [], 'staging directory cleaned after rollback');
  } finally {
    delete process.env.OA_RESTORE_FAULT;
  }
});

test('server restore previews conflicts, restores the database transactionally and records a restore point', () => {
  db.run("INSERT INTO settings(key, value) VALUES('restore_probe', 'before') ON CONFLICT(key) DO UPDATE SET value = 'before'");
  const backup = backups.createServerBackup(admin(), 'all');
  assert.equal(backup.ok, true);
  const runId = db.run(
    `INSERT INTO backup_runs(job_id, filename, status, size_mb, local_path, started_at, sha256)
     VALUES(NULL, ?, ?, ?, ?, ?, ?)`,
    backup.filename, 'complete', backup.size, backups.backupPath(backup.filename), new Date().toISOString(), backup.sha256,
  ).lastInsertRowid;
  const preview = backupcenter.previewRestoreRun(runId);
  assert.equal(preview.ok, true, preview.error);
  assert.equal(preview.hasDb, true);
  assert.equal(preview.integrity.verified, true);
  assert.ok(preview.homes.some((entry) => entry.username === 'demouser'));
  assert.equal(db.get("SELECT value FROM settings WHERE key='restore_probe'").value, 'before', 'preview is read-only');

  db.run("UPDATE settings SET value='after' WHERE key='restore_probe'");
  const restored = backupcenter.restoreRun(runId, { dryRun: false, actor: 'test' });
  assert.equal(restored.ok, true, restored.error);
  assert.equal(db.get("SELECT value FROM settings WHERE key='restore_probe'").value, 'before');
  assert.ok(restored.objects.some((entry) => entry.object === 'db:settings' && entry.status === 'restored'));
  assert.ok(restored.preRestore, 'pre-restore server snapshot recorded');
  const job = backups.jobView(restored.jobId);
  assert.equal(job.status, 'succeeded');
  const run = db.get('SELECT * FROM backup_runs WHERE id = ?', runId);
  assert.ok(run.restored_at);
  assert.equal(run.restore_job_id, restored.jobId);
});

test('a failing server restore rolls files and the panel database back', () => {
  db.run("INSERT INTO settings(key, value) VALUES('rollback_probe', 'before') ON CONFLICT(key) DO UPDATE SET value = 'before'");
  const backup = backups.createServerBackup(admin(), 'all');
  const runId = db.run(
    `INSERT INTO backup_runs(job_id, filename, status, size_mb, local_path, started_at, sha256)
     VALUES(NULL, ?, ?, ?, ?, ?, ?)`,
    backup.filename, 'complete', backup.size, backups.backupPath(backup.filename), new Date().toISOString(), backup.sha256,
  ).lastInsertRowid;
  db.run("UPDATE settings SET value='after' WHERE key='rollback_probe'");
  process.env.OA_RESTORE_FAULT = 'after-apply';
  try {
    const restored = backupcenter.restoreRun(runId, { dryRun: false, actor: 'test' });
    assert.equal(restored.ok, false);
    assert.equal(restored.rolledBack, true);
    assert.equal(db.get("SELECT value FROM settings WHERE key='rollback_probe'").value, 'after', 'database rolled back to the pre-restore snapshot');
    const job = backups.jobView(restored.jobId);
    assert.equal(job.status, 'failed');
    assert.equal(job.result?.dbRollback, true);
  } finally {
    delete process.env.OA_RESTORE_FAULT;
  }
});

test('restore refuses an archive with an escaping symlink (SEC-022)', () => {
  const work = fs.mkdtempSync(path.join(dataDir, 'malicious-'));
  fs.writeFileSync(path.join(work, 'payload.txt'), 'x');
  fs.symlinkSync('../../outside', path.join(work, 'escape'));
  const filename = 'unsafe_symlink.tar.gz';
  const tar = spawnSync('tar', ['-czf', backups.backupPath(filename), '-C', work, '.'], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  try {
    const inspected = backups.inspectArchive(filename);
    assert.equal(inspected.ok, false);
    assert.equal(inspected.code, 'unsafe_archive');
    assert.match(inspected.error, /unsafe archive entries/);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('scheduler computes nextRunAt in the job timezone and applies catch-up policy', () => {
  const summer = backupcenter.nextRunAt({ schedule: 'daily', time: '03:00', timezone: 'Europe/Warsaw', from: Date.parse('2026-07-01T00:30:00Z') });
  assert.equal(summer, '2026-07-01T01:00:00.000Z', 'summer time is UTC+2');
  const winter = backupcenter.nextRunAt({ schedule: 'daily', time: '03:00', timezone: 'Europe/Warsaw', from: Date.parse('2026-01-01T00:30:00Z') });
  assert.equal(winter, '2026-01-01T02:00:00.000Z', 'winter time is UTC+1');
  assert.equal(backupcenter.validTimezone('Europe/Warsaw'), true);
  assert.equal(backupcenter.validTimezone('Not/AZone'), false);

  const saved = backupcenter.saveJob({
    name: 'durable-nightly', scope: 'user', target_user: 'demouser', schedule: 'daily',
    schedule_time: '03:00', timezone: 'Europe/Warsaw', catch_up_minutes: 60, retention_days: 7,
  }, 'test');
  assert.equal(saved.ok, true, saved.error);
  assert.ok(saved.next_run_at);
  db.run('UPDATE backup_jobs SET next_run_at = ? WHERE id = ?', new Date(Date.now() - 2 * 60000).toISOString(), saved.id);
  const first = backupcenter.enqueueDueJobs({ now: Date.now() });
  assert.equal(first.queued.length, 1);
  assert.equal(first.queued[0].backupJobId, saved.id);
  const operation = db.get('SELECT * FROM operation_jobs WHERE id = ?', first.queued[0].operationJobId);
  assert.equal(operation.kind, 'backup.job.run');
  assert.equal(operation.status, 'queued');
  const after = db.get('SELECT next_run_at, lease_owner FROM backup_jobs WHERE id = ?', saved.id);
  assert.equal(after.lease_owner, null);
  assert.ok(new Date(after.next_run_at).getTime() > Date.now(), 'next run advanced into the future');
  const second = backupcenter.enqueueDueJobs({ now: Date.now() });
  assert.equal(second.queued.length, 0, 'lease + nextRunAt prevent duplicate enqueue');

  db.run('UPDATE backup_jobs SET next_run_at = ? WHERE id = ?', new Date(Date.now() - 2 * 86400000).toISOString(), saved.id);
  const missed = backupcenter.enqueueDueJobs({ now: Date.now() });
  assert.equal(missed.queued.length, 0);
  assert.equal(missed.skipped.length, 1);
  assert.equal(missed.skipped[0].reason, 'catch-up-window');
  assert.equal(db.get('SELECT last_status FROM backup_jobs WHERE id = ?', saved.id).last_status, 'skipped');
});

test('scheduler leases have a single winner and are taken over after expiry', async () => {
  const first = scheduler.claimSchedulerLease('test.lease', { owner: 'instance-a', ttlMs: 150 });
  assert.equal(first.ok, true);
  const blocked = scheduler.claimSchedulerLease('test.lease', { owner: 'instance-b', ttlMs: 150 });
  assert.equal(blocked.ok, false);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const taken = scheduler.claimSchedulerLease('test.lease', { owner: 'instance-b', ttlMs: 150 });
  assert.equal(taken.ok, true);
  scheduler.releaseSchedulerLease('test.lease', 'instance-b');
  const status = scheduler.schedulerStatus();
  assert.ok(status.timezone);
  assert.ok(Array.isArray(status.next_backup_jobs));
});

function signManifest(manifest, privateKey, keyId = 'test-key') {
  const copy = { ...manifest };
  delete copy.signature;
  const canonical = backups.stableStringify(copy);
  const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64');
  return { ...manifest, signature: { algorithm: 'ed25519', keyId, value: signature } };
}

test('panel update manifests require a pinned Ed25519 signature', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const manifest = {
    manifestVersion: 1,
    product: 'OpenAdmin',
    version: '9.9.9',
    channel: 'stable',
    sha256: 'a'.repeat(64),
    size: 1024,
    releaseUrl: 'https://example.invalid/openadmin-9.9.9.tar.gz',
    publishedAt: new Date().toISOString(),
    files: [{ path: 'src/server.mjs', sha256: 'b'.repeat(64) }],
  };
  const signed = signManifest(manifest, privateKey);

  const unsigned = updates.verifyUpdateManifest(manifest, { publicKeys: [`test-key=${publicBase64}`], allowUnsigned: false });
  assert.equal(unsigned.ok, false);
  assert.equal(unsigned.code, 'unsigned');

  const verified = updates.verifyUpdateManifest(signed, { publicKeys: [`test-key=${publicBase64}`] });
  assert.equal(verified.ok, true, verified.error);
  assert.equal(verified.keyId, 'test-key');
  assert.equal(verified.unsigned, false);

  const tampered = { ...signed, version: '9.9.10' };
  const rejected = updates.verifyUpdateManifest(tampered, { publicKeys: [`test-key=${publicBase64}`] });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'invalid_signature');

  const noKey = updates.verifyUpdateManifest(signed, { publicKeys: [] });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.code, 'no_pinned_key');

  const optedIn = updates.verifyUpdateManifest(manifest, { publicKeys: [], allowUnsigned: true });
  assert.equal(optedIn.ok, true);
  assert.equal(optedIn.unsigned, true);
  assert.equal(optedIn.insecure, true);
});

test('a signed manifest is verified end-to-end against a pinned key for a loopback update channel', async () => {
  const http = await import('node:http');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const manifest = {
    manifestVersion: 1,
    product: 'OpenAdmin',
    version: '9.9.9',
    channel: 'stable',
    sha256: 'e'.repeat(64),
    size: 1024,
    releaseUrl: 'http://127.0.0.1:1/openadmin-9.9.9.tar.gz',
    publishedAt: new Date().toISOString(),
    files: [{ path: 'src/server.mjs', sha256: 'f'.repeat(64) }],
  };
  const signed = signManifest(manifest, privateKey, 'loopback-key');
  const server = http.createServer((req, res) => {
    if (req.url === '/manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(signed));
      return;
    }
    if (req.url === '/manifest.json.sig') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(signed.signature.value);
      return;
    }
    res.writeHead(404); res.end('missing');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  signed.releaseUrl = `http://127.0.0.1:${port}/openadmin-9.9.9.tar.gz`;
  const resign = signManifest({ ...signed, releaseUrl: signed.releaseUrl }, privateKey, 'loopback-key');
  process.env.OA_UPDATE_MANIFEST_URL = `http://127.0.0.1:${port}/manifest.json`;
  process.env.OA_UPDATE_SIGNATURE_URL = `http://127.0.0.1:${port}/manifest.json.sig`;
  process.env.OA_UPDATE_PUBLIC_KEY = `loopback-key=${publicBase64}`;
  try {
    // Serve the re-signed manifest whose releaseUrl points at this loopback port.
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      if (req.url === '/manifest.json') { res.writeHead(200); res.end(JSON.stringify(resign)); return; }
      if (req.url === '/manifest.json.sig') { res.writeHead(200); res.end(resign.signature.value); return; }
      res.writeHead(404); res.end('missing');
    });
    const dry = await updates.stagePanelUpdate({ apply: false });
    assert.equal(dry.ok, true, dry.error);
    assert.equal(dry.verification.ok, true);
    assert.equal(dry.verification.keyId, 'loopback-key');
    assert.equal(dry.manifest.version, '9.9.9');
    assert.equal(dry.compatibility.ok, true, dry.compatibility.errors.join('; '));
  } finally {
    delete process.env.OA_UPDATE_MANIFEST_URL;
    delete process.env.OA_UPDATE_SIGNATURE_URL;
    delete process.env.OA_UPDATE_PUBLIC_KEY;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the update pipeline is ten stages and a dry-run refuses unsigned manifests by default', async () => {
  assert.equal(updates.UPDATE_STAGES.length, 10);
  assert.deepEqual(updates.UPDATE_STAGES.map((stage) => stage.key), [
    'download', 'verify', 'compatibility', 'backup', 'staging',
    'dependencies', 'migrations', 'restart', 'smoke', 'commit',
  ]);
  const manifest = {
    manifestVersion: 1, product: 'OpenAdmin', version: '9.9.9', channel: 'stable',
    sha256: 'd'.repeat(64), size: 1024, releaseUrl: 'https://example.invalid/openadmin.tar.gz',
  };
  const result = await updates.stagePanelUpdate({ apply: false, manifest });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unsigned');
  assert.match(result.error, /unsigned|signature/i);
});

test('compatibility checks reject older or foreign releases', async () => {
  const manifest = {
    product: 'OpenAdmin', version: '0.0.1', sha256: 'c'.repeat(64), size: 1024,
    releaseUrl: 'https://example.invalid/a.tar.gz', requires: { node: '>=22.5.0' },
  };
  const result = await updates.checkCompatibility(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.startsWith('newer:')));
  const foreign = { ...manifest, product: 'OtherPanel', version: '9.9.9' };
  const foreignResult = await updates.checkCompatibility(foreign);
  assert.equal(foreignResult.ok, false);
  assert.ok(foreignResult.errors.some((entry) => entry.startsWith('product:')));
});

test('build diagnostics expose build ID, commit, schema and assets hashes', () => {
  const info = updates.buildInfo();
  assert.equal(typeof info.buildId, 'string');
  assert.ok(info.buildId.length > 0);
  assert.ok(info.schema.tables > 10);
  assert.match(info.schema.hash, /^[a-f0-9]{16}$/);
  assert.match(String(info.assets.sha256), /^[a-f0-9]{64}$/);
  assert.equal(info.channel, updates.updateChannel());
  assert.ok(info.updateKeys, 'key status is part of diagnostics');
  const text = updates.diagnosticsText();
  assert.match(text, /OpenAdmin diagnostics/);
  assert.match(text, /build:/);
  assert.match(text, /schema:/);
  assert.match(text, /assets:/);
});

test('upload is a durable job with staging, integrity and atomic placement', () => {
  const temp = path.join(os.tmpdir(), `openadmin-upload-${Date.now()}.bin`);
  fs.writeFileSync(temp, Buffer.from('durable upload body'));
  const created = backups.createUploadJob({
    user: user(), directory: '/home/demouser', filename: 'uploaded.txt', tempPath: temp, size: 19,
  });
  assert.equal(created.ok, true, created.error);
  const outcome = backups.executeJobSync(created.jobId);
  assert.equal(outcome.ok, true, outcome.error);
  const job = backups.jobView(created.jobId);
  assert.equal(job.status, 'succeeded');
  assert.ok(job.stages.every((stage) => stage.status === 'complete'));
  const target = path.join(home(), 'uploaded.txt');
  assert.equal(fs.readFileSync(target, 'utf8'), 'durable upload body');
  assert.equal(outcome.result.sha256, backups.sha256File(target));

  const conflictTemp = path.join(os.tmpdir(), `openadmin-upload-conflict-${Date.now()}.bin`);
  fs.writeFileSync(conflictTemp, Buffer.from('other'));
  const conflict = backups.createUploadJob({
    user: user(), directory: '/home/demouser', filename: 'uploaded.txt', tempPath: conflictTemp, size: 5,
  });
  const conflictOutcome = backups.executeJobSync(conflict.jobId);
  assert.equal(conflictOutcome.ok, false);
  assert.match(conflictOutcome.error, /already exists|conflict/i);
  assert.equal(fs.readFileSync(target, 'utf8'), 'durable upload body', 'existing file is not clobbered without overwrite');
  fs.rmSync(target, { force: true });
  fs.rmSync(temp, { force: true });
  fs.rmSync(conflictTemp, { force: true });
});

test('upload limit preflight uses one limit and rejects oversized files before transfer', () => {
  const limits = backups.uploadLimits();
  assert.ok(limits.maxBytes > 0);
  assert.ok(limits.maxBase64Bytes > limits.maxBytes);
  assert.ok(limits.maxJsonBodyBytes >= limits.maxBase64Bytes);
  const ok = backups.preflightUpload({ filename: 'ok.txt', size: limits.maxBytes + 1 });
  assert.equal(ok.ok, false);
  assert.equal(ok.code, 'too_large');
  assert.match(ok.error, new RegExp(`${limits.maxUploadMb} MB`));
  const within = backups.preflightUpload({ filename: 'ok.txt', size: limits.maxBytes });
  assert.equal(within.ok, true);
  const invalid = backups.preflightUpload({ filename: '..', size: 1 });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'invalid_filename');
});
