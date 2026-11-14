// Automation engine tests — isolated database, real jobs and the admin page.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openadmin-automation-test-'));
process.env.OA_DATA_DIR = dataDir;
process.env.OA_PORT = '0';
process.env.OA_HOST = '127.0.0.1';
process.env.OA_DEMO = '1';
process.env.OA_ADMIN_PASSWORD = 'admin-test-pass';
// Keep the timer out of the assertions; the tick itself is exercised directly.
process.env.OA_AUTOMATION_TICK_MS = '600000';

const serverMod = await import('../src/server.mjs');
const db = await import('../src/db.mjs');
const automation = await import('../src/automation.mjs');

let server;
let base;

async function form(url, fields, cookie = '') {
  return fetch(base + url, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
}

async function loginAs(username, password = 'demo') {
  const res = await form('/login', { username, password });
  assert.equal(res.status, 302, `login for ${username} should redirect`);
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  return setCookie.filter(Boolean).map((entry) => entry.split(';')[0]).join('; ');
}

async function csrfFrom(cookie, url = '/admin/automation') {
  const html = await (await fetch(base + url, { headers: { Cookie: cookie } })).text();
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, `CSRF token present on ${url}`);
  return match[1];
}

before(async () => {
  server = serverMod.start();
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  // The suite manipulates next_run_at explicitly; make sure the background
  // timer cannot pick a job up in the middle of an assertion.
  db.run("UPDATE automation_jobs SET next_run_at = '2999-01-01T00:00:00.000Z'");
});

after(async () => {
  const { stopImap } = await import('../src/imap.mjs');
  stopImap();
  await new Promise((resolve) => server.close(resolve));
  db.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('new tables exist without replacing the existing schema', () => {
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name);
  assert.ok(tables.includes('automation_jobs'));
  assert.ok(tables.includes('automation_runs'));
  assert.ok(tables.includes('users'), 'existing tables are preserved');
});

test('automation jobs are seeded once with real definitions', () => {
  const first = automation.seedAutomationJobs();
  const second = automation.seedAutomationJobs();
  assert.equal(second.created, 0, 'seeding is idempotent');
  const jobs = db.all('SELECT * FROM automation_jobs ORDER BY key');
  assert.equal(jobs.length, automation.AUTOMATION_JOBS.length);
  assert.deepEqual(
    jobs.map((job) => job.key).sort(),
    automation.AUTOMATION_JOBS.map((job) => job.key).sort(),
  );
  assert.ok(jobs.every((job) => job.label && job.interval_seconds >= automation.MIN_INTERVAL_SECONDS));
  assert.ok(jobs.every((job) => job.next_run_at), 'every job has a durable next run');
  assert.equal(first.total, jobs.length);
});

test('interval parsing accepts seconds and suffixes and rejects garbage', () => {
  assert.equal(automation.parseInterval('600'), 600);
  assert.equal(automation.parseInterval('15m'), 900);
  assert.equal(automation.parseInterval('2h'), 7200);
  assert.equal(automation.parseInterval('1d'), 86400);
  assert.equal(automation.parseInterval('5s'), automation.MIN_INTERVAL_SECONDS);
  assert.equal(automation.parseInterval('nonsense'), null);
  assert.equal(automation.parseInterval(''), null);
});

test('automationStatus is JSON-serializable and reports jobs, due count and last runs', () => {
  const status = automation.automationStatus();
  assert.equal(typeof status.enabled, 'boolean');
  assert.equal(typeof status.due, 'number');
  assert.equal(status.version, automation.AUTOMATION_STATUS_VERSION);
  assert.ok(Array.isArray(status.jobs));
  assert.ok(Array.isArray(status.lastRuns));
  assert.deepEqual(Object.keys(status.settings).sort(), ['disk_threshold', 'mail_retry', 'tmp_days']);
  assert.deepEqual(Object.keys(status.totals).sort(), ['enabled', 'failures', 'jobs']);
  assert.ok(status.jobs.every((job) => typeof job.due === 'boolean' && typeof job.description === 'string'));
  assert.ok(status.jobs.every((job) => ['key', 'label', 'enabled', 'interval_seconds', 'last_run_at', 'next_run_at', 'last_status', 'last_output', 'run_count', 'fail_count'].every((key) => key in job)));
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(status)));
});

test('enabling and editing a job persists and controls scheduling', () => {
  const result = automation.updateAutomationJob('health.check', { interval_seconds: '15m', enabled: '1' });
  assert.equal(result.ok, true);
  assert.equal(result.job.interval_seconds, 900);
  assert.equal(result.job.enabled, 1);
  assert.ok(result.job.next_run_at, 'enabled job has a next run');

  const disabled = automation.updateAutomationJob('health.check', { interval_seconds: '15m', enabled: '0' });
  assert.equal(disabled.job.enabled, 0);
  assert.equal(disabled.job.next_run_at, null);

  const invalid = automation.updateAutomationJob('health.check', { interval_seconds: 'eventually', enabled: '1' });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /Interval/);

  automation.updateAutomationJob('health.check', { interval_seconds: '300', enabled: '1' });
  db.run("UPDATE automation_jobs SET next_run_at = '2999-01-01T00:00:00.000Z' WHERE key = 'health.check'");
});

test('health.check runs the existing health report and records a run', async () => {
  const result = await automation.runAutomationJob('health.check', { trigger: 'manual', actor: 'test' });
  assert.equal(result.ok, true, result.error);
  assert.ok(['ok', 'warn'].includes(result.status), `unexpected health status ${result.status}`);
  assert.match(result.output, /health=/);
  const record = db.get("SELECT * FROM automation_runs WHERE job_key = 'health.check' ORDER BY id DESC LIMIT 1");
  assert.equal(record.status, result.status);
  assert.ok(record.finished_at);
  const job = db.get("SELECT * FROM automation_jobs WHERE key = 'health.check'");
  assert.equal(job.run_count, 1);
  assert.ok(job.last_run_at);
});

test('backup.prune removes expired temp backups and keeps the newest', async () => {
  const { backupPath } = await import('../src/backups.mjs');
  const admin = db.get("SELECT id FROM users WHERE level = 'admin' ORDER BY id LIMIT 1");
  db.setSetting('backup_keep', '1');
  db.setSetting('backup_retention_days', '1');
  const keep = `admin_backup_2000-01-02_keep-${Date.now()}.tar.gz`;
  const remove = `admin_backup_2000-01-01_remove-${Date.now()}.tar.gz`;
  fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
  fs.writeFileSync(backupPath(keep), 'keep');
  fs.writeFileSync(backupPath(remove), 'remove');
  db.run('INSERT INTO backups(user_id, filename, kind, size_mb, status, created_at) VALUES(?,?,?,?,?,?)',
    admin.id, keep, 'server', 0.1, 'complete', '2000-01-02T00:00:00.000Z');
  db.run('INSERT INTO backups(user_id, filename, kind, size_mb, status, created_at) VALUES(?,?,?,?,?,?)',
    admin.id, remove, 'server', 0.1, 'complete', '2000-01-01T00:00:00.000Z');

  const result = await automation.runAutomationJob('backup.prune', { trigger: 'manual', actor: 'test' });
  assert.equal(result.ok, true, result.error);
  assert.match(result.output, /Removed 1/);
  assert.equal(fs.existsSync(backupPath(remove)), false, 'expired archive deleted');
  assert.equal(db.get('SELECT id FROM backups WHERE filename = ?', remove), null);
  assert.equal(fs.existsSync(backupPath(keep)), true, 'newest archive kept');

  db.run('DELETE FROM backups WHERE filename = ?', keep);
  fs.rmSync(backupPath(keep), { force: true });
  db.setSetting('backup_keep', '3');
  db.setSetting('backup_retention_days', '14');
});

test('backup.daily is skipped when disabled and never duplicates today\'s archive', async () => {
  const admin = db.get("SELECT id FROM users WHERE level = 'admin' ORDER BY id LIMIT 1");
  const count = () => db.get("SELECT COUNT(*) AS n FROM backups WHERE filename LIKE 'admin_backup_%'").n;
  db.setSetting('backup_enabled', '0');
  const before = count();
  const disabled = await automation.runAutomationJob('backup.daily', { trigger: 'manual', actor: 'test' });
  assert.equal(disabled.status, 'skipped');
  assert.match(disabled.output, /disabled/);
  assert.equal(count(), before, 'disabled backup must not create an archive row');

  db.setSetting('backup_enabled', '1');
  const today = new Date().toISOString().slice(0, 10);
  const filename = `admin_backup_${today}_existing.tar.gz`;
  db.run('INSERT INTO backups(user_id, filename, kind, size_mb, status, created_at) VALUES(?,?,?,?,?,?)',
    admin.id, filename, 'server', 0.1, 'complete', new Date().toISOString());
  const existing = count();
  const duplicate = await automation.runAutomationJob('backup.daily', { trigger: 'manual', actor: 'test' });
  assert.equal(duplicate.status, 'skipped');
  assert.match(duplicate.output, /already exists/);
  assert.equal(count(), existing, 'no duplicate archive row was created');
  db.run('DELETE FROM backups WHERE filename = ?', filename);
});

test('cleanup.tmp only removes old panel-owned temp data, never homes', async () => {
  const stale = path.join(dataDir, 'backup-stage-test-old');
  const homeProbe = path.join(dataDir, 'homes', 'probe-user');
  fs.mkdirSync(stale, { recursive: true });
  fs.mkdirSync(homeProbe, { recursive: true });
  fs.writeFileSync(path.join(stale, 'leftover.txt'), 'temp');
  fs.writeFileSync(path.join(homeProbe, 'important.txt'), 'user data');
  const old = new Date(Date.now() - 30 * 864e5);
  fs.utimesSync(stale, old, old);
  fs.utimesSync(homeProbe, old, old);
  fs.utimesSync(path.join(homeProbe, 'important.txt'), old, old);

  const result = await automation.runAutomationJob('cleanup.tmp', { trigger: 'manual', actor: 'test' });
  assert.equal(result.ok, true, result.error);
  assert.match(result.output, /homes and backups untouched/);
  assert.equal(fs.existsSync(stale), false, 'old panel staging removed');
  assert.equal(fs.existsSync(path.join(homeProbe, 'important.txt')), true, 'user home untouched');

  fs.rmSync(homeProbe, { recursive: true, force: true });
});

test('scheduler exposes a live tick and never throws when no job is due', async () => {
  const scheduler = await import('../src/scheduler.mjs');
  const timer = scheduler.startScheduler();
  assert.ok(timer, 'startScheduler returns its timer');
  const tick = await automation.automationTick({ now: Date.now() });
  assert.equal(tick.enabled, true);
  assert.ok(Array.isArray(tick.ran));
  const health = await fetch(base + '/healthz');
  assert.equal(health.status, 200, 'HTTP server survived the scheduler tick');
});

test('a scheduler tick runs due jobs by next_run_at and skips disabled jobs', async () => {
  const pruneBefore = db.get("SELECT run_count, last_run_at FROM automation_jobs WHERE key = 'backup.prune'");
  db.run("UPDATE automation_jobs SET next_run_at = '2000-01-01T00:00:00.000Z' WHERE key = 'health.check'");
  db.run("UPDATE automation_jobs SET enabled = 0, next_run_at = '2000-01-01T00:00:00.000Z' WHERE key = 'backup.prune'");
  const tick = await automation.automationTick({ now: Date.now(), limit: 5 });
  assert.equal(tick.enabled, true);
  assert.ok(tick.ran.some((entry) => entry.job?.key === 'health.check' && (entry.status === 'ok' || entry.status === 'warn')));
  assert.ok(!tick.ran.some((entry) => entry.job?.key === 'backup.prune'));
  assert.ok(db.get("SELECT run_count FROM automation_jobs WHERE key = 'health.check'").run_count >= 2);
  const pruneAfter = db.get("SELECT run_count, last_run_at FROM automation_jobs WHERE key = 'backup.prune'");
  assert.equal(pruneAfter.last_run_at, pruneBefore.last_run_at, 'disabled job did not run');
  assert.equal(pruneAfter.run_count, pruneBefore.run_count, 'disabled job did not count a run');

  db.run("UPDATE automation_jobs SET next_run_at = '2999-01-01T00:00:00.000Z' WHERE key = 'health.check'");
  db.run("UPDATE automation_jobs SET enabled = 1, next_run_at = '2999-01-01T00:00:00.000Z' WHERE key = 'backup.prune'");
});

test('admin automation page renders and status endpoint returns JSON', async () => {
  const cookie = await loginAs('demoadmin');
  const page = await fetch(base + '/admin/automation', { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Automation/);
  assert.match(html, /backup\.daily/);
  assert.match(html, /health\.check/);
  assert.match(html, /Recent runs/);

  const status = await fetch(base + '/admin/automation/status', { headers: { Cookie: cookie } });
  assert.equal(status.status, 200);
  const json = await status.json();
  assert.equal(typeof json.enabled, 'boolean');
  assert.ok(Array.isArray(json.jobs));
  assert.ok(json.jobs.length >= 7);
  assert.ok(Array.isArray(json.lastRuns));

  const userCookie = await loginAs('demouser');
  const forbidden = await fetch(base + '/admin/automation/status', { headers: { Cookie: userCookie } });
  assert.equal(forbidden.status, 403);
});

test('admin toggles require CSRF and persist through normal forms', async () => {
  const cookie = await loginAs('demoadmin');
  const before = db.get("SELECT * FROM automation_jobs WHERE key = 'backup.prune'");

  const noToken = await form('/admin/automation/jobs/backup.prune/toggle', {}, cookie);
  assert.equal(noToken.status, 403, 'missing CSRF token is rejected');

  const csrf = await csrfFrom(cookie);
  const toggled = await form('/admin/automation/jobs/backup.prune/toggle', { _csrf: csrf }, cookie);
  assert.equal(toggled.status, 302);
  assert.notEqual(db.get("SELECT enabled FROM automation_jobs WHERE key = 'backup.prune'").enabled, before.enabled);

  const edited = await form('/admin/automation/jobs/backup.prune', { _csrf: csrf, interval_seconds: '12h', enabled: '1' }, cookie);
  assert.equal(edited.status, 302);
  const job = db.get("SELECT * FROM automation_jobs WHERE key = 'backup.prune'");
  assert.equal(job.interval_seconds, 43200);
  assert.equal(job.enabled, 1);
  db.run("UPDATE automation_jobs SET next_run_at = '2999-01-01T00:00:00.000Z' WHERE key = 'backup.prune'");

  const run = await form('/admin/automation/jobs/backup.prune/run', { _csrf: csrf }, cookie);
  assert.equal(run.status, 302);
  assert.ok(db.get("SELECT run_count FROM automation_jobs WHERE key = 'backup.prune'").run_count >= 1);
});

test('global switch and clear-failures use CSRF-protected forms', async () => {
  const cookie = await loginAs('demoadmin');
  const csrf = await csrfFrom(cookie);
  const off = await form('/admin/automation/settings', { _csrf: csrf, disk_threshold: '91', tmp_days: '9' }, cookie);
  assert.equal(off.status, 302);
  assert.equal(db.setting('automation_enabled'), '0');
  assert.equal(db.setting('automation_disk_threshold'), '91');
  assert.equal(db.setting('automation_tmp_days'), '9');

  const on = await form('/admin/automation/settings', { _csrf: csrf, enabled: '1', disk_threshold: '90', tmp_days: '7' }, cookie);
  assert.equal(on.status, 302);
  assert.equal(db.setting('automation_enabled'), '1');

  db.run("UPDATE automation_jobs SET fail_count = 4 WHERE key = 'health.check'");
  const cleared = await form('/admin/automation/clear-failures', { _csrf: csrf }, cookie);
  assert.equal(cleared.status, 302);
  assert.equal(db.get('SELECT COALESCE(SUM(fail_count), 0) AS n FROM automation_jobs').n, 0);
});
