// Bulk operations contracts: tenant matrix, signed two-step preview, token
// tamper/expiry, partial failures, audits and idempotency. The engine is tested
// directly against the real DB; the route surface is exercised through the real
// Router with fake request contexts so no production route edit is required.
process.env.OA_IMAP_PORT = '0';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openadmin-bulk-actions-'));
process.env.OA_DATA_DIR = dataDir;
process.env.OA_DEMO = '1';
process.env.OA_ADMIN_PASSWORD = 'admin-test-pass';
process.env.OA_SESSION_TTL = '2';

const db = await import('../src/db.mjs');
const bulk = await import('../src/bulk-actions.mjs');
const backups = await import('../src/backups.mjs');
const auth = await import('../src/auth.mjs');
const access = await import('../src/core/access.mjs');
const { Router } = await import('../src/router.mjs');
const feature = await import('../src/features/bulk-actions.mjs');

const CSRF = 'bulk-csrf-test';
let admin;
let resellerA;
let resellerB;
let admin2;
let alphaCustomer;
let betaCustomer;
let tokA;
let tokB;
let auditA;
let auditB;
let partialA;
let partialB;
let backupA;
let backupB;
let failA;
let failB;
let routeUser;
let phpUser;
let domAlpha;
let domBeta;
let domBackupA;
let domBackupB;
let domPhp;
let alphaOnlyPackage;

function nowIso() {
  return new Date().toISOString();
}

function makeUser(username, level, owner, pkg) {
  const id = db.run(
    `INSERT INTO users(username, password, email, level, owner, package, created_at, last_login)
     VALUES(?,?,?,?,?,?,?,?)`,
    username,
    db.hashPassword('demo'),
    `${username}@bulk.test`,
    level,
    owner,
    pkg,
    nowIso(),
    nowIso(),
  ).lastInsertRowid;
  return db.get('SELECT * FROM users WHERE id = ?', id);
}

function makeDomain(user, name, phpVersion = '8.3') {
  const id = db.run(
    `INSERT INTO domains(user_id, username, name, docroot, php_version, ssl, status, is_main, ip, disk_mb, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    user.id,
    user.username,
    name,
    `/home/${user.username}/domains/${name}/public_html`,
    phpVersion,
    1,
    'active',
    0,
    '127.0.0.1',
    128,
    nowIso(),
  ).lastInsertRowid;
  return db.get('SELECT * FROM domains WHERE id = ?', id);
}

before(() => {
  db.seedBase({
    adminUser: 'admin',
    adminPassword: 'admin-test-pass',
    serverName: 'bulk.test',
    serverIp: '127.0.0.1',
    ns1: 'ns1.bulk.test',
    ns2: 'ns2.bulk.test',
  });
  db.seedDemo();

  db.run(
    `INSERT INTO packages(name, owner, type, limits, created_at) VALUES(?,?,?,?,?)`,
    'alpha-only', 'resA', 'user', JSON.stringify({ domains: 5 }), nowIso(),
  );
  db.run(
    `INSERT INTO packages(name, owner, type, limits, created_at) VALUES(?,?,?,?,?)`,
    'bravo-only', 'resB', 'user', JSON.stringify({ domains: 5 }), nowIso(),
  );
  alphaOnlyPackage = db.get("SELECT * FROM packages WHERE name = 'alpha-only'");

  admin = db.get("SELECT * FROM users WHERE username = 'demoadmin'");
  resellerA = makeUser('resA', 'reseller', null, 'reseller_default');
  resellerB = makeUser('resB', 'reseller', null, 'reseller_default');
  admin2 = makeUser('other-admin', 'admin', null, 'unlimited');
  alphaCustomer = makeUser('alpha-customer', 'user', 'resA', 'default');
  betaCustomer = makeUser('beta-customer', 'user', 'resB', 'default');
  tokA = makeUser('token-a', 'user', 'resA', 'default');
  tokB = makeUser('token-b', 'user', 'resA', 'default');
  auditA = makeUser('audit-a', 'user', 'resA', 'default');
  auditB = makeUser('audit-b', 'user', 'resA', 'default');
  partialA = makeUser('partial-a', 'user', 'resA', 'default');
  partialB = makeUser('partial-b', 'user', 'resA', 'default');
  backupA = makeUser('backup-a', 'user', 'resA', 'default');
  backupB = makeUser('backup-b', 'user', 'resA', 'default');
  failA = makeUser('fail-a', 'user', 'resA', 'default');
  failB = makeUser('fail-b', 'user', 'resA', 'default');
  routeUser = makeUser('route-user', 'user', 'resA', 'default');
  phpUser = makeUser('php-user', 'user', 'resA', 'default');

  domAlpha = makeDomain(alphaCustomer, 'alpha-customer.test');
  domBeta = makeDomain(betaCustomer, 'beta-customer.test');
  domBackupA = makeDomain(backupA, 'backup-a.test');
  domBackupB = makeDomain(backupB, 'backup-b.test');
  domPhp = makeDomain(phpUser, 'php-version.test', '8.2');
});

after(() => {
  db.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function preview(actor, input, opts = {}) {
  return bulk.previewBulkAction(actor, input, {
    csrf: CSRF,
    ip: '127.0.0.1',
    ...opts,
  });
}

function apply(actor, token, opts = {}) {
  return bulk.applyBulkAction(actor, token, {
    csrf: CSRF,
    ip: '127.0.0.1',
    ...opts,
  });
}

function entryFor(result, id) {
  return result.preview.objects.find((entry) => String(entry.id) === String(id));
}

function auditCount(action, target = null) {
  if (target === null) {
    return db.get('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?', action).n;
  }
  return db.get('SELECT COUNT(*) AS n FROM audit_log WHERE action = ? AND target = ?', action, target).n;
}

function jobCount() {
  backups.ensureJobSchema();
  return db.get("SELECT COUNT(*) AS n FROM operation_jobs WHERE kind = 'backup.create'").n;
}

function messageCount(subject) {
  return db.get('SELECT COUNT(*) AS n FROM messages WHERE subject = ?', subject).n;
}

function acmeQueue() {
  return JSON.parse(db.setting('acme_queue', '[]') || '[]');
}

function decodeTokenPayload(token) {
  return JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString('utf8'));
}

/* ------------------------------------------------------------------ matrix */

test('tenant matrix: admin cannot bulk admin accounts, reseller cannot touch foreign objects', () => {
  const adminPreview = preview(admin, {
    action: 'suspend',
    objectType: 'users',
    ids: [admin2.id, alphaCustomer.id, betaCustomer.id],
  });
  assert.equal(adminPreview.ok, true);
  assert.equal(adminPreview.preview.count, 3);
  assert.equal(adminPreview.preview.eligible, 2);
  assert.equal(adminPreview.preview.blocked, 1);
  assert.equal(entryFor(adminPreview, admin2.id).code, 'admin_protected');
  assert.equal(entryFor(adminPreview, alphaCustomer.id).eligible, true);
  assert.equal(entryFor(adminPreview, betaCustomer.id).eligible, true);

  const resellerPreview = preview(resellerA, {
    action: 'suspend',
    objectType: 'users',
    ids: [alphaCustomer.id, betaCustomer.id],
  });
  assert.equal(resellerPreview.ok, true);
  assert.equal(resellerPreview.preview.eligible, 1);
  assert.equal(resellerPreview.preview.blocked, 1);
  assert.equal(entryFor(resellerPreview, betaCustomer.id).code, 'foreign');
  assert.equal(entryFor(resellerPreview, betaCustomer.id).label, `user #${betaCustomer.id}`);
  assert.doesNotMatch(JSON.stringify(resellerPreview.preview), /beta-customer/);

  const foreignDomain = preview(resellerA, {
    action: 'php',
    objectType: 'domains',
    ids: [domAlpha.id, domBeta.id],
    php: '8.2',
  });
  assert.equal(foreignDomain.ok, true);
  assert.equal(entryFor(foreignDomain, domAlpha.id).eligible, true);
  assert.equal(entryFor(foreignDomain, domBeta.id).code, 'foreign');

  const userActor = db.get("SELECT * FROM users WHERE username = 'demouser'");
  const forbidden = preview(userActor, { action: 'suspend', objectType: 'users', ids: [alphaCustomer.id] });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.code, 'forbidden');
  assert.equal(forbidden.status, 403);

  const unknown = preview(admin, { action: 'delete-everything', objectType: 'users', ids: [alphaCustomer.id] });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'unknown_action');
  assert.equal(apply(admin, 'not-a-token').ok, false);

  const adminOnly = preview(admin, { action: 'suspend', objectType: 'users', ids: [admin2.id] });
  assert.equal(adminOnly.preview.eligible, 0);
  const blockedApply = apply(admin, adminOnly.token);
  assert.equal(blockedApply.report.status, 'blocked');
  assert.equal(blockedApply.report.ok, false);
  assert.equal(db.get('SELECT suspended FROM users WHERE id = ?', admin2.id).suspended, 0);

  const listedForReseller = bulk.listBulkTargets(resellerA, { objectType: 'users' });
  assert.equal(listedForReseller.ok, true);
  assert.ok(listedForReseller.rows.every((row) => row.owner === resellerA.username || row.username === resellerA.username));
  assert.ok(!listedForReseller.rows.some((row) => row.id === betaCustomer.id));

  const listedForAdmin = bulk.listBulkTargets(admin, { objectType: 'users' });
  assert.ok(!listedForAdmin.rows.some((row) => row.level === 'admin'));
});

/* --------------------------------------------------------- preview contract */

test('preview validates action/value and returns effects, downtime and disk estimates', () => {
  const invalidPhp = preview(admin, {
    action: 'php', objectType: 'domains', ids: [domPhp.id], php: '9.9',
  });
  assert.equal(invalidPhp.ok, false);
  assert.equal(invalidPhp.code, 'invalid_php_version');

  const restrictedPhp = preview(resellerA, {
    action: 'php', objectType: 'domains', ids: [domPhp.id], php: '8.4',
  });
  assert.equal(restrictedPhp.ok, false);
  assert.equal(restrictedPhp.code, 'invalid_php_version');

  const invalidPackage = preview(resellerA, {
    action: 'package', objectType: 'users', ids: [alphaCustomer.id], package: 'missing-package',
  });
  assert.equal(invalidPackage.ok, false);
  assert.equal(invalidPackage.code, 'invalid_value');

  const invalidBackup = preview(resellerA, {
    action: 'backup', objectType: 'users', ids: [alphaCustomer.id], backupKind: 'everything',
  });
  assert.equal(invalidBackup.ok, false);
  assert.equal(invalidBackup.code, 'invalid_value');

  const missingMessageBody = preview(resellerA, {
    action: 'message', objectType: 'users', ids: [alphaCustomer.id], subject: 'Subject only',
  });
  assert.equal(missingMessageBody.ok, false);
  assert.equal(missingMessageBody.code, 'invalid_value');

  const mismatch = preview(admin, {
    action: 'ssl', objectType: 'users', ids: [alphaCustomer.id],
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'object_type_mismatch');

  const invalidIds = preview(admin, {
    action: 'suspend', objectType: 'users', ids: ['999999', 'not-an-id'],
  });
  assert.equal(invalidIds.preview.count, 2);
  assert.equal(invalidIds.preview.blocked, 2);
  assert.equal(invalidIds.preview.objects.find((entry) => entry.id === 'not-an-id').code, 'invalid_id');
  assert.equal(invalidIds.preview.objects.find((entry) => entry.id === 999999).code, 'not_found');

  const backupPreview = preview(resellerA, {
    action: 'backup', objectType: 'users', ids: [backupA.id], backupKind: 'full',
  });
  assert.equal(backupPreview.preview.eligible, 1);
  assert.ok(backupPreview.preview.effects.length >= 1);
  assert.ok(backupPreview.preview.estimate.diskMb > 0);
  assert.match(backupPreview.preview.estimate.diskText, /MB/);

  const phpPreview = preview(admin, {
    action: 'php', objectType: 'domains', ids: [domPhp.id], php: '8.4',
  });
  assert.equal(phpPreview.preview.eligible, 1);
  assert.equal(phpPreview.preview.value.php, '8.4');
  assert.equal(phpPreview.preview.estimate.downtimeMinutes, 1);

  assert.deepEqual(bulk.BULK_ACTION_KEYS, ['suspend', 'activate', 'package', 'backup', 'message', 'ssl', 'php']);
});

/* ------------------------------------------------------------- token gate */

test('confirmation token rejects tampering, wrong CSRF, wrong actor and expiry', () => {
  const before = db.get('SELECT suspended FROM users WHERE id = ?', tokA.id).suspended;
  const result = preview(admin, {
    action: 'suspend', objectType: 'users', ids: [tokA.id],
  });
  assert.equal(result.ok, true);
  const payload = decodeTokenPayload(result.token);
  assert.equal(payload.b, result.batchId);
  assert.equal(payload.ac, 'suspend');
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'objects'));
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'selected'));
  assert.doesNotMatch(JSON.stringify(payload), /tokA|token-a/);

  const [body, signature] = result.token.split('.');
  const tampered = `${body}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
  const tamperResult = apply(admin, tampered);
  assert.equal(tamperResult.ok, false);
  assert.equal(tamperResult.code, 'invalid_token');

  const csrfMismatch = apply(admin, result.token, { csrf: 'different-session' });
  assert.equal(csrfMismatch.ok, false);
  assert.equal(csrfMismatch.code, 'csrf_mismatch');

  const actorMismatch = apply(resellerB, result.token);
  assert.equal(actorMismatch.ok, false);
  assert.equal(actorMismatch.code, 'token_actor_mismatch');

  assert.equal(apply(admin, '').code, 'missing_token');
  assert.equal(db.get('SELECT suspended FROM users WHERE id = ?', tokA.id).suspended, before);

  const base = Date.now();
  const expiring = preview(admin, {
    action: 'suspend', objectType: 'users', ids: [tokB.id],
  }, { now: base });
  const expired = apply(admin, expiring.token, { now: base + bulk.bulkTokenTtlSeconds() * 1000 + 1 });
  assert.equal(expired.ok, false);
  assert.equal(expired.code, 'token_expired');
  assert.equal(db.get('SELECT suspended FROM users WHERE id = ?', tokB.id).suspended, 0);

  const valid = apply(admin, expiring.token, { now: base + 1000 });
  assert.equal(valid.report.status, 'succeeded');
  assert.equal(db.get('SELECT suspended FROM users WHERE id = ?', tokB.id).suspended, 1);
});

/* ----------------------------------------------- apply, audit, idempotency */

test('apply executes each object, audits every mutation and returns the stored report on replay', () => {
  const result = preview(resellerA, {
    action: 'suspend', objectType: 'users', ids: [auditA.id, auditB.id],
  });
  assert.equal(result.ok, true);
  const first = apply(resellerA, result.token);
  assert.equal(first.ok, true);
  assert.equal(first.report.status, 'succeeded');
  assert.deepEqual(first.report.totals, { selected: 2, eligible: 2, succeeded: 2, failed: 0, blocked: 0 });
  assert.equal(db.get('SELECT suspended FROM users WHERE id = ?', auditA.id).suspended, 1);
  assert.equal(db.get('SELECT suspended FROM users WHERE id = ?', auditB.id).suspended, 1);
  assert.equal(auditCount('bulk.suspend', 'audit-a'), 1);
  assert.equal(auditCount('bulk.suspend', 'audit-b'), 1);

  const replay = apply(resellerA, result.token);
  assert.equal(replay.reused, true);
  assert.equal(replay.ok, true);
  assert.deepEqual(replay.report, first.report);
  assert.equal(auditCount('bulk.suspend', 'audit-a'), 1);
  assert.equal(auditCount('bulk.suspend', 'audit-b'), 1);

  // Permission revalidation after preview: partial success, never a full claim.
  db.run('UPDATE users SET suspended = 1, suspended_reason = ? WHERE id IN (?, ?)', 'test', partialA.id, partialB.id);
  const partialPreview = preview(resellerA, {
    action: 'activate', objectType: 'users', ids: [partialA.id, partialB.id],
  });
  assert.equal(partialPreview.preview.eligible, 2);
  db.run('UPDATE users SET owner = ? WHERE id = ?', resellerB.username, partialB.id);
  const partialApply = apply(resellerA, partialPreview.token);
  assert.equal(partialApply.ok, false);
  assert.equal(partialApply.report.status, 'partial');
  assert.match(partialApply.report.message, /Partial success/);
  assert.deepEqual(partialApply.report.totals, { selected: 2, eligible: 1, succeeded: 1, failed: 0, blocked: 1 });
  assert.equal(db.get('SELECT suspended FROM users WHERE id = ?', partialA.id).suspended, 0);
  assert.equal(db.get('SELECT suspended FROM users WHERE id = ?', partialB.id).suspended, 1);
  assert.equal(auditCount('bulk.activate', 'partial-a'), 1);
  assert.equal(auditCount('bulk.activate', 'partial-b'), 0);
  db.run('UPDATE users SET owner = ? WHERE id = ?', resellerA.username, partialB.id);
});

test('backup, message and SSL apply once and replay never duplicates jobs or messages', () => {
  const spawnCalls = [];
  const deps = {
    spawnJobRunner: (jobId) => {
      spawnCalls.push(jobId);
      return { ok: true, pid: process.pid };
    },
  };
  const jobsBefore = jobCount();
  const backupPreview = preview(resellerA, {
    action: 'backup', objectType: 'users', ids: [backupA.id, backupB.id], backupKind: 'full',
  });
  assert.equal(jobCount(), jobsBefore, 'preview must not queue backup jobs');
  const backupApply = apply(resellerA, backupPreview.token, { deps });
  assert.equal(backupApply.ok, true);
  assert.equal(backupApply.report.totals.succeeded, 2);
  assert.equal(spawnCalls.length, 2);
  assert.equal(jobCount(), jobsBefore + 2);
  for (const entry of backupApply.report.objects) {
    assert.equal(entry.ok, true);
    assert.ok(Number(entry.details.jobId) > 0);
    assert.equal(entry.details.runner, 'spawned');
  }
  const backupReplay = apply(resellerA, backupPreview.token, { deps });
  assert.equal(backupReplay.reused, true);
  assert.equal(spawnCalls.length, 2);
  assert.equal(jobCount(), jobsBefore + 2);
  assert.equal(auditCount('bulk.backup'), 2);

  const subject = `Bulk maintenance ${Date.now()}`;
  const messagesBefore = messageCount(subject);
  const messagePreview = preview(resellerA, {
    action: 'message',
    objectType: 'users',
    ids: [backupA.id, backupB.id],
    subject,
    message: 'Please review the maintenance window.',
  });
  assert.equal(messageCount(subject), messagesBefore, 'preview must not add messages');
  const messageApply = apply(resellerA, messagePreview.token);
  assert.equal(messageApply.report.status, 'succeeded');
  assert.equal(messageCount(subject), messagesBefore + 2);
  const messageReplay = apply(resellerA, messagePreview.token);
  assert.equal(messageReplay.reused, true);
  assert.equal(messageCount(subject), messagesBefore + 2);
  assert.equal(auditCount('bulk.message'), 2);

  const queueBefore = acmeQueue().length;
  const sslPreview = preview(resellerA, {
    action: 'ssl', objectType: 'domains', ids: [domBackupA.id, domBackupB.id], sslMode: 'letsencrypt',
  });
  assert.equal(acmeQueue().length, queueBefore, 'preview must not enqueue ACME jobs');
  const sslApply = apply(resellerA, sslPreview.token);
  assert.equal(sslApply.report.status, 'succeeded');
  assert.equal(acmeQueue().length, queueBefore + 2);
  assert.ok(acmeQueue().some((entry) => entry.domain === 'backup-a.test'));
  assert.ok(acmeQueue().some((entry) => entry.domain === 'backup-b.test'));
  const sslReplay = apply(resellerA, sslPreview.token);
  assert.equal(sslReplay.reused, true);
  assert.equal(acmeQueue().length, queueBefore + 2);
  assert.equal(auditCount('bulk.ssl'), 2);
});

test('an execution error on one object reports partial failure and never full success', () => {
  const previewResult = preview(resellerA, {
    action: 'backup', objectType: 'users', ids: [failA.id, failB.id],
  });
  const deps = {
    createUserBackupJob: (user) => {
      if (user.username === 'fail-b') throw new Error('simulated disk failure');
      return { ok: true, jobId: 424242, reused: false };
    },
    spawnJobRunner: () => ({ ok: true, pid: process.pid }),
  };
  const result = apply(resellerA, previewResult.token, { deps });
  assert.equal(result.ok, false);
  assert.equal(result.report.status, 'partial');
  assert.match(result.report.message, /Partial success/);
  assert.deepEqual(result.report.totals, { selected: 2, eligible: 2, succeeded: 1, failed: 1, blocked: 0 });
  const failedRow = result.report.objects.find((entry) => entry.label === 'fail-b');
  assert.equal(failedRow.ok, false);
  assert.equal(failedRow.code, 'execution_failed');
  assert.match(failedRow.message, /simulated disk failure/);
  assert.equal(auditCount('bulk.backup', 'fail-a'), 1);
  assert.equal(auditCount('bulk.backup.failed', 'fail-b'), 1);
  const replay = apply(resellerA, previewResult.token, { deps });
  assert.equal(replay.reused, true);
  assert.equal(replay.report.status, 'partial');
  assert.equal(auditCount('bulk.backup.failed', 'fail-b'), 1);
});

test('package and PHP actions validate ownership/version and apply through the real engine', () => {
  const foreignPackage = preview(resellerA, {
    action: 'package',
    objectType: 'users',
    ids: [alphaCustomer.id],
    package: 'bravo-only',
  });
  assert.equal(foreignPackage.preview.eligible, 0);
  assert.equal(entryFor(foreignPackage, alphaCustomer.id).code, 'package_forbidden');

  const packagePreview = preview(resellerA, {
    action: 'package',
    objectType: 'users',
    ids: [alphaCustomer.id],
    package: alphaOnlyPackage.name,
  });
  assert.equal(packagePreview.preview.eligible, 1);
  const packageApply = apply(resellerA, packagePreview.token);
  assert.equal(packageApply.report.status, 'succeeded');
  assert.equal(db.get('SELECT package FROM users WHERE id = ?', alphaCustomer.id).package, alphaOnlyPackage.name);
  assert.equal(auditCount('bulk.package', 'alpha-customer'), 1);

  const phpAllowed = preview(admin, {
    action: 'php', objectType: 'domains', ids: [domPhp.id], php: '8.4',
  });
  let reloads = 0;
  const phpApply = apply(admin, phpAllowed.token, {
    deps: {
      applyPhp: () => {
        reloads += 1;
        return { ok: true, steps: [] };
      },
    },
  });
  assert.equal(phpApply.report.status, 'succeeded');
  assert.equal(reloads, 1);
  assert.equal(db.get('SELECT php_version FROM domains WHERE id = ?', domPhp.id).php_version, '8.4');
  assert.equal(phpApply.report.maintenance.ok, true);
  assert.equal(auditCount('bulk.php', 'php-version.test'), 1);
  const phpReplay = apply(admin, phpAllowed.token, {
    deps: { applyPhp: () => { reloads += 1; return { ok: true }; } },
  });
  assert.equal(phpReplay.reused, true);
  assert.equal(reloads, 1);

  // The DB row changed but the reload failed: that is not a full success.
  db.run('UPDATE domains SET php_version = ? WHERE id = ?', '8.2', domPhp.id);
  const failingReloadPreview = preview(admin, {
    action: 'php', objectType: 'domains', ids: [domPhp.id], php: '8.4',
  });
  const failingReload = apply(admin, failingReloadPreview.token, {
    deps: { applyPhp: () => ({ ok: false, steps: [{ error: 'fpm reload failed' }] }) },
  });
  assert.equal(failingReload.ok, false);
  assert.equal(failingReload.report.status, 'partial');
  assert.equal(failingReload.report.maintenance.ok, false);
  assert.match(failingReload.report.message, /reload reported errors/);
  assert.equal(db.get('SELECT php_version FROM domains WHERE id = ?', domPhp.id).php_version, '8.4');
});

/* -------------------------------------------------------------- route UI */

function fakeCtx(user, overrides = {}) {
  return {
    user,
    level: user.level,
    caps: auth.capabilities(user),
    path: '/admin/bulk',
    query: {},
    body: {},
    params: {},
    session: { csrf: CSRF },
    csrf: CSRF,
    ip: '127.0.0.1',
    ...overrides,
  };
}

async function invoke(router, method, pathname, ctx) {
  const matched = router.match(method, pathname);
  assert.ok(matched, `${method} ${pathname} must be registered`);
  const out = await matched.route.handler(ctx);
  if (out && out.__raw) return { status: 200, html: out.value };
  if (out && out.html) return { status: out.status || 200, html: out.html.__raw ? out.html.value : String(out.html) };
  return { status: 200, html: String(out) };
}

test('routes for admin and reseller render CSRF-protected checkboxes, preview and apply', async () => {
  const router = new Router();
  const adminRoutes = feature.registerBulkActions(router, { base: '/admin/bulk', level: 'admin' });
  const resellerRoutes = feature.registerBulkActions(router, { base: '/reseller/bulk', level: 'reseller' });
  assert.deepEqual(adminRoutes.paths, {
    page: '/admin/bulk', preview: '/admin/bulk/preview', apply: '/admin/bulk/apply',
  });
  assert.deepEqual(resellerRoutes.paths, {
    page: '/reseller/bulk', preview: '/reseller/bulk/preview', apply: '/reseller/bulk/apply',
  });
  assert.throws(() => feature.registerBulkActions(router, { base: '/admin/bulk', level: 'reseller' }), /level=admin/);
  assert.throws(() => feature.registerBulkActions(router, { base: '/admin/bulk', level: 'owner' }), /level must be/);
  assert.throws(() => feature.registerBulkActions(router, { base: '/other/bulk', level: 'admin' }), /admin\/bulk/);

  const adminPage = await invoke(router, 'GET', '/admin/bulk', fakeCtx(admin));
  assert.equal(adminPage.status, 200);
  assert.match(adminPage.html, /name="selected\[\]"/);
  assert.match(adminPage.html, /name="_csrf"/);
  assert.match(adminPage.html, /data-bulk-preview-form/);
  assert.match(adminPage.html, /Preview action/);
  assert.match(adminPage.html, /Administrator accounts are excluded/);
  assert.match(adminPage.html, /action="\/admin\/bulk\/preview"/);

  const resellerDomainPage = await invoke(router, 'GET', '/reseller/bulk', fakeCtx(resellerA, {
    path: '/reseller/bulk', query: { type: 'domains' },
  }));
  assert.equal(resellerDomainPage.status, 200);
  assert.match(resellerDomainPage.html, /name="selected\[\]"/);
  assert.match(resellerDomainPage.html, /PHP version · change PHP/);
  assert.match(resellerDomainPage.html, /action="\/reseller\/bulk\/preview"/);

  const previewCtx = fakeCtx(resellerA, {
    path: '/reseller/bulk',
    body: { action: 'suspend', objectType: 'users', selected: [String(routeUser.id)] },
  });
  const previewPage = await invoke(router, 'POST', '/reseller/bulk/preview', previewCtx);
  assert.equal(previewPage.status, 200);
  assert.match(previewPage.html, /data-bulk-apply-form/);
  assert.match(previewPage.html, /name="token" value="/);
  assert.match(previewPage.html, /name="_csrf"/);
  const token = previewPage.html.match(/name="token" value="([^"]+)"/)?.[1];
  assert.ok(token);

  const applyPage = await invoke(router, 'POST', '/reseller/bulk/apply', fakeCtx(resellerA, {
    path: '/reseller/bulk',
    body: { token },
  }));
  assert.equal(applyPage.status, 200);
  assert.match(applyPage.html, /Run summary/);
  assert.match(applyPage.html, /Changed/);
  assert.match(applyPage.html, /Back to bulk actions/);

  const replayPage = await invoke(router, 'POST', '/reseller/bulk/apply', fakeCtx(resellerA, {
    path: '/reseller/bulk',
    body: { token },
  }));
  assert.equal(replayPage.status, 200);
  assert.match(replayPage.html, /already applied/);

  const denied = await invoke(router, 'GET', '/admin/bulk', fakeCtx(resellerA));
  assert.equal(denied.status, 403);
});
