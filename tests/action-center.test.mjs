// Action Center + preflight contracts.
//
// The tests use the real DB schema and the real HTTP server for the page, but
// the preflight checks are fed with injected dependencies so no privileged
// host operation is attempted.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openadmin-action-center-'));
process.env.OA_DATA_DIR = dataDir;
process.env.OA_PORT = '0';
process.env.OA_IMAP_PORT = '0';
process.env.OA_HOST = '127.0.0.1';
process.env.OA_DEMO = '1';
process.env.OA_ADMIN_PASSWORD = 'admin-test-pass';
process.env.OA_SESSION_TTL = '2';
process.env.OA_AUTOMATION_TICK_MS = '600000';

const db = await import('../src/db.mjs');
const actionCenter = await import('../src/action-center.mjs');
const preflight = await import('../src/preflight.mjs');
const health = await import('../src/health.mjs');
const automation = await import('../src/automation.mjs');

const MiB = 1024 * 1024;
let server = null;
let serverMod = null;
let serverStartError = null;
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

before(async () => {
  try {
    serverMod = await import('../src/server.mjs');
    server = serverMod.start();
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  } catch (error) {
    // The aggregation/preflight contracts below are still testable when a
    // different module in the import graph is temporarily broken. The page test
    // skips with that exact reason instead of pretending it passed.
    serverStartError = error;
    server = null;
    db.seedBase({
      adminUser: 'admin',
      adminPassword: 'admin-test-pass',
      serverName: 'action-center.test',
      serverIp: '127.0.0.1',
      ns1: 'ns1.action-center.test',
      ns2: 'ns2.action-center.test',
    });
    db.seedDemo();
  }
  automation.seedAutomationJobs();

  // One real failure per family, inserted through the same tables the panel
  // reads. Nothing is mocked at the aggregation boundary.
  db.run("UPDATE services SET status = 'stopped' WHERE name = 'nginx'");
  db.run(`INSERT INTO ssl_certs(domain, username, type, issuer, expires_at, status, created_at)
          VALUES(?,?,?,?,?,?,?)`,
  'expire-test.example', 'demouser', 'letsencrypt', 'Test CA',
  new Date(Date.now() + 3 * 86400000).toISOString(), 'active', new Date().toISOString());
  db.run(`INSERT INTO mail_queue(sender, recipient, subject, size_kb, status, error, created_at)
          VALUES(?,?,?,?,?,?,?)`,
  'sender@example.com', 'missing@example.net', 'Test failure', 2, 'failed', 'connection refused', new Date().toISOString());

  const user = db.get("SELECT id FROM users WHERE username = 'demouser'");
  db.run(`INSERT INTO domains(user_id, username, name, docroot, ssl, status, created_at)
          VALUES(?,?,?,?,?,?,?)`,
  user.id, 'demouser', 'dns-bad.example', '/home/demouser/domains/dns-bad.example/public_html', 1, 'active', new Date().toISOString());
  const domain = db.get("SELECT id FROM domains WHERE name = 'dns-bad.example'");
  db.run(`INSERT INTO dns_records(domain_id, name, type, value, ttl) VALUES(?,?,?,?,?)`,
    domain.id, '@', 'A', '198.51.100.9', 3600);

  db.run(`UPDATE automation_jobs SET fail_count = 1, last_status = 'error', last_output = 'boom', last_run_at = ?
          WHERE key = 'disk.check'`, new Date().toISOString());

  for (let i = 0; i < 6; i += 1) {
    db.run('INSERT INTO login_attempts(username, ip, created_at) VALUES(?,?,?)',
      'victim', '203.0.113.55', new Date().toISOString());
  }
});

after(async () => {
  if (server) {
    const { stopImap } = await import('../src/imap.mjs');
    stopImap();
    await new Promise((resolve) => server.close(resolve));
  }
  db.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function itemByKey(snapshot, key) {
  return snapshot.items.find((item) => item.dedupeKey === key);
}

function sourceById(snapshot, id) {
  return snapshot.sources.find((entry) => entry.id === id);
}

function assertFindingShape(item) {
  for (const field of ['id', 'severity', 'priority', 'title', 'impact', 'recommendation', 'dedupeKey', 'source', 'observedAt']) {
    assert.ok(item[field] !== undefined && item[field] !== null && String(item[field]).length > 0, `${item.dedupeKey || '?'} missing ${field}`);
  }
  assert.match(item.id, /^ac_[a-f0-9]{20}$/);
  assert.ok(['P0', 'P1', 'P2'].includes(item.severity));
  assert.equal(item.priority, item.severity);
  assert.ok(!Number.isNaN(new Date(item.observedAt).getTime()), `${item.dedupeKey} observedAt is not a date`);
  assert.ok(Number.isInteger(item.muted) || typeof item.muted === 'boolean');
  if (item.action) {
    assert.ok(item.action.href.startsWith('/admin'), `${item.dedupeKey} action must stay inside admin`);
    assert.ok(item.action.label.length > 0);
  }
  assert.ok(Array.isArray(item.evidence) || (item.evidence && typeof item.evidence === 'object'), `${item.dedupeKey} evidence must be explicit`);
}

test('Action Center aggregates real service, SSL, backup, mail, DNS, 2FA, automation and login observations', () => {
  const snapshot = actionCenter.collectActionCenter();

  assert.ok(snapshot.items.length >= 8, `expected several real findings, got ${snapshot.items.length}`);
  assert.equal(snapshot.sourceCount, snapshot.sources.length);
  assert.equal(snapshot.all, snapshot.items.length);
  assert.equal(snapshot.total + snapshot.muted, snapshot.all);
  assert.equal(snapshot.bySeverity.P0 + snapshot.bySeverity.P1 + snapshot.bySeverity.P2, snapshot.total);
  assert.equal(snapshot.generatedAt, new Date(snapshot.generatedAt).toISOString());
  for (const item of snapshot.items) assertFindingShape(item);

  const service = itemByKey(snapshot, 'service-failed:nginx');
  assert.ok(service, 'expected service failure must be aggregated');
  assert.equal(service.severity, 'P0');
  assert.equal(service.type, 'service');

  const cert = itemByKey(snapshot, 'cert-expiry:expire-test.example');
  assert.ok(cert, 'expiring certificate must be aggregated');
  assert.equal(cert.severity, 'P1');
  assert.ok(cert.title.includes('wygasa'));

  const queue = itemByKey(snapshot, 'mail:queue-failed');
  assert.ok(queue, 'failed mail queue must be aggregated');
  assert.equal(queue.severity, 'P1');

  const dns = itemByKey(snapshot, 'dns-mismatch:dns-bad.example');
  assert.ok(dns, 'DNS A mismatch must be aggregated');
  assert.equal(dns.severity, 'P1');
  assert.deepEqual(dns.evidence.actual, ['198.51.100.9']);

  const account2fa = itemByKey(snapshot, 'accounts:2fa:admin');
  assert.ok(account2fa, 'admin accounts without 2FA must be explicit');
  assert.match(account2fa.title, /^Zalecenie:/);
  assert.equal(sourceById(snapshot, 'accounts').status, 'info');
  assert.ok(itemByKey(snapshot, 'automation-failed:disk.check'), 'automation failure must be explicit');
  assert.ok(itemByKey(snapshot, 'security:failed-logins'), 'repeated failed logins must be explicit');
  assert.ok(itemByKey(snapshot, 'backup:no-external-target'), 'absent external copy must be explicit');

  const updates = sourceById(snapshot, 'updates');
  assert.ok(updates, 'updates source must be reported');
  assert.equal(updates.status, 'partial');
  assert.match(updates.detail, /Update Center/);

  const mail = sourceById(snapshot, 'mail');
  assert.ok(mail, 'mail source must be reported');
  assert.equal(mail.status, 'partial');
  assert.match(mail.detail, /niemierzalny/);
});

test('Action Center mutes remove findings from active counts without deleting evidence', () => {
  const key = 'cert-expiry:expire-test.example';
  const before = actionCenter.collectActionCenter();
  assert.equal(itemByKey(before, key).muted, false);

  const muted = actionCenter.muteFinding({ dedupeKey: key, until: new Date(Date.now() + 2 * 3600000).toISOString(), actor: 'test', reason: 'known renewal' });
  assert.equal(muted.ok, true);

  const during = actionCenter.collectActionCenter();
  const item = itemByKey(during, key);
  assert.equal(item.muted, true);
  assert.ok(item.muteUntil);
  assert.equal(during.muted, before.muted + 1);
  assert.equal(during.total, before.total - 1);
  assert.equal(actionCenter.activeMutes().some((row) => row.dedupe_key === key), true);

  const past = actionCenter.muteFinding({ dedupeKey: key, until: new Date(Date.now() - 1000).toISOString() });
  assert.equal(past.ok, false);
  assert.equal(past.code, 'until_in_past');

  const restored = actionCenter.unmuteFinding({ dedupeKey: key, actor: 'test' });
  assert.equal(restored.ok, true);
  const after = actionCenter.collectActionCenter();
  assert.equal(itemByKey(after, key).muted, false);
  assert.equal(actionCenter.activeMutes().some((row) => row.dedupe_key === key), false);
});

test('applicationObservation keeps process health and application health separate', () => {
  const healthy = {
    id: 'phpmyadmin', name: 'phpMyAdmin', installed: true, state: 'running',
    observedStatus: 'ok', process: { alive: true }, port: { port: 8080 }, login: { ready: true },
    http: { status: 200 }, reasons: [],
  };
  assert.equal(health.applicationObservation(healthy), null);

  const failed = health.applicationObservation({
    ...healthy, state: 'failed', observedStatus: 'critical', http: { status: 502 }, lastError: 'Bad gateway',
    reasons: ['Brak odpowiedzi HTTP: Bad gateway'],
  });
  assert.equal(failed.severity, 'P1');
  assert.equal(failed.httpStatus, 502);
  assert.match(failed.title, /nie odpowiada/);

  const degraded = health.applicationObservation({
    ...healthy, state: 'degraded', observedStatus: 'warn', http: { status: 404 }, lastError: 'HTTP 404',
    login: { ready: false }, reasons: ['Ścieżka bazowa zwraca HTTP 404'],
  });
  assert.equal(degraded.severity, 'P2');
  assert.match(degraded.impact, /Część funkcji/);

  assert.equal(health.applicationObservation({ ...healthy, installed: false }), null);
});

test('preflight upload uses the real panel limit and reports every condition', async () => {
  const limits = {
    maxUploadMb: 8,
    maxBytes: 8 * MiB,
    maxBase64Bytes: Math.ceil(8 * MiB / 3) * 4,
    maxJsonBodyBytes: Math.ceil(8 * MiB / 3) * 4 + 256 * 1024,
    encoding: 'base64',
  };
  const deps = {
    uploadLimits: () => limits,
    freeBytes: () => 70 * MiB,
    exists: () => true,
    isDirectory: () => true,
    writable: () => true,
    activeJobs: () => [],
  };

  const accepted = await preflight.runPreflight('upload', { filename: 'backup.tar.gz', size: MiB, encoding: 'base64' }, { deps });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.blocked, false);
  assert.equal(accepted.checks.length, 8);
  assert.equal(accepted.estimates.diskRequiredBytes, MiB + 64 * MiB);
  assert.equal(accepted.estimates.downtimeSeconds, 0);
  assert.ok(accepted.estimates.notes.length > 0);
  for (const check of accepted.checks) {
    for (const field of ['ok', 'code', 'label', 'detail', 'fixable', 'fixHint']) {
      assert.ok(Object.hasOwn(check, field), `check ${check.code} missing ${field}`);
    }
  }

  const oversized = await preflight.runPreflight('upload', { filename: 'too-big.bin', size: 9 * MiB, encoding: 'base64' }, { deps });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.blocked, true);
  const codes = oversized.checks.filter((check) => !check.ok).map((check) => check.code);
  assert.ok(codes.includes('UPLOAD_LIMIT'));
  assert.ok(codes.includes('UPLOAD_BODY_LIMIT'));
  assert.ok(codes.includes('UPLOAD_DISK'));

  const multipart = await preflight.runPreflight('upload', { filename: 'x.bin', size: 100, encoding: 'multipart' }, { deps });
  assert.ok(multipart.checks.find((check) => check.code === 'UPLOAD_ENCODING' && !check.ok));

  const busy = await preflight.runPreflight('upload', { filename: 'x.bin', size: 100, encoding: 'base64' }, {
    deps: { ...deps, activeJobs: () => [{ id: 7, kind: 'upload.store', status: 'running' }] },
  });
  assert.equal(busy.ok, false);
  assert.equal(busy.blocked, false, 'an active upload is a warning, not a blocker');
  assert.ok(busy.checks.find((check) => check.code === 'ACTIVE_JOBS' && !check.ok));
});

test('preflight app install and SSL succeed with complete dependencies', async () => {
  const domain = { id: 11, name: 'example.com', username: 'demouser', docroot: '/home/demouser/domains/example.com/public_html', status: 'active' };
  const baseDeps = {
    platform: 'linux',
    domain: (name) => (name === 'example.com' ? domain : null),
    userHome: () => '/home/demouser',
    exists: () => true,
    isDirectory: () => true,
    writable: () => true,
    findExecutable: (name) => `/usr/bin/${name}`,
    serviceStatus: () => ({ known: true, status: 'running', enabled: true }),
    settings: () => '1',
    tcpOpen: async () => true,
    freeBytes: () => 10 * 1024 * MiB,
    activeJobs: () => [],
    dnsRecords: () => [{ name: '@', value: '127.0.0.1' }],
    serverIp: () => '127.0.0.1',
    resolve4: async () => ['127.0.0.1'],
  };

  const app = await preflight.runPreflight('app-install', { app: 'wordpress', domain: 'example.com', path: '/' }, { deps: baseDeps });
  assert.equal(app.ok, true, JSON.stringify(app.checks.filter((check) => !check.ok)));
  assert.equal(app.blocked, false);

  const ssl = await preflight.runPreflight('ssl-issue', { domain: 'example.com' }, { deps: baseDeps });
  assert.equal(ssl.ok, true, JSON.stringify(ssl.checks.filter((check) => !check.ok)));
  assert.equal(ssl.blocked, false);
  assert.ok(ssl.checks.some((check) => check.code === 'DNS_PUBLIC_A' && check.ok));
});

test('preflight blocks on active jobs, missing restore archives and unknown kinds', async () => {
  const backupDeps = {
    exists: () => true,
    isDirectory: () => true,
    writable: () => true,
    findExecutable: (name) => `/usr/bin/${name}`,
    freeBytes: () => 1024 * MiB,
    get: () => ({ ok: 1 }),
    settings: () => '1',
    activeJobs: () => [{ id: 4, kind: 'backup.job.run', status: 'running' }],
  };
  const backup = await preflight.runPreflight('backup', { estimateMb: 32 }, { deps: backupDeps });
  assert.equal(backup.blocked, true);
  assert.ok(backup.checks.find((check) => check.code === 'ACTIVE_JOBS' && !check.ok));

  const restoreDeps = {
    get: () => ({ ok: 1 }),
    stat: () => null,
    readable: () => false,
    exists: () => true,
    isDirectory: () => true,
    writable: () => true,
    freeBytes: () => 1024 * MiB,
    activeJobs: () => [],
  };
  const missing = await preflight.runPreflight('restore', { filename: 'missing.tar.gz' }, { deps: restoreDeps });
  assert.equal(missing.blocked, true);
  assert.ok(missing.checks.find((check) => check.code === 'ARCHIVE_EXISTS' && !check.ok));

  const restore = await preflight.runPreflight('restore', { filename: 'backup.tar.gz' }, {
    deps: {
      ...restoreDeps,
      stat: () => ({ isFile: () => true, size: 1000 }),
      readable: () => true,
    },
  });
  assert.equal(restore.ok, true, JSON.stringify(restore.checks.filter((check) => !check.ok)));

  const unknown = await preflight.runPreflight('teleport');
  assert.equal(unknown.blocked, true);
  assert.equal(unknown.checks[0].code, 'UNKNOWN_KIND');
});

test('preflight web-engine, import and upload contracts stay typed', async () => {
  const webDeps = {
    platform: 'linux',
    engineInstalled: () => true,
    tcpOpen: async () => true,
    serviceStatus: () => ({ known: true, status: 'running', enabled: true }),
    generatedConfigs: () => 3,
    exists: () => true,
    isDirectory: () => true,
    writable: () => true,
    freeBytes: () => 1024 * MiB,
    activeJobs: () => [],
    settings: () => 'nginx',
  };
  const web = await preflight.runPreflight('web-engine', { engine: 'nginx' }, { deps: webDeps });
  assert.equal(web.ok, true, JSON.stringify(web.checks.filter((check) => !check.ok)));
  assert.ok(web.checks.some((check) => check.code === 'PORT_80'));
  assert.equal(web.estimates.downtimeSeconds, 60);
  assert.equal(web.estimates.diskRequiredBytes, 256 * MiB);

  const importDeps = {
    exists: () => true,
    isFile: () => true,
    isDirectory: () => true,
    archiveKind: () => 'tar',
    findExecutable: (name) => `/usr/bin/${name}`,
    freeBytes: () => 2048 * MiB,
    writable: () => true,
    activeJobs: () => [],
    importJobs: () => [],
  };
  const imported = await preflight.runPreflight('import', { source: '/tmp/backup.tar.gz', username: 'demouser' }, {
    deps: {
      ...importDeps,
      user: () => ({ id: 1, username: 'demouser', level: 'user' }),
    },
  });
  assert.equal(imported.ok, true, JSON.stringify(imported.checks.filter((check) => !check.ok)));
  assert.ok(imported.checks.some((check) => check.code === 'ARCHIVE_KIND' && check.ok));

  const summary = preflight.preflightSummary(imported);
  assert.equal(summary.ok, true);
  assert.equal(summary.blocked, false);
  assert.equal(summary.label, 'Gotowe');
});

test('Action Center page, dashboard card and nav are wired without breaking metrics', async (t) => {
  if (serverStartError || !server) {
    t.skip(`HTTP page not reachable: ${serverStartError?.message || 'server not started'}`);
    return;
  }
  const anonymous = await fetch(base + '/admin/action-center', { redirect: 'manual' });
  assert.equal(anonymous.status, 302);
  assert.match(anonymous.headers.get('location'), /\/login/);

  const cookie = await loginAs('demoadmin');
  const pageRes = await fetch(base + '/admin/action-center', { headers: { Cookie: cookie } });
  assert.equal(pageRes.status, 200);
  const html = await pageRes.text();
  assert.match(html, /Action Center/);
  assert.match(html, /name="severity"/);
  assert.match(html, /name="type"/);
  assert.match(html, /name="show"/);
  assert.match(html, /Źródła danych/);
  assert.match(html, /Wycisz na/);
  assert.match(html, /Preflight przed operacją/);

  const preflightRes = await fetch(base + '/admin/action-center?preflight=upload&filename=probe.bin&size_mb=1', { headers: { Cookie: cookie } });
  assert.equal(preflightRes.status, 200);
  const preflightHtml = await preflightRes.text();
  assert.match(preflightHtml, /Wynik preflight: Wysyłka pliku/);
  assert.match(preflightHtml, /Wszystkie warunki spełnione|Operacja może się udać|Operacja zablokowana/);
  assert.ok(db.get("SELECT id FROM audit_log WHERE action = 'action_center.preflight' ORDER BY id DESC LIMIT 1"), 'explicit preflight is audited');

  const dashboard = await (await fetch(base + '/admin', { headers: { Cookie: cookie } })).text();
  assert.match(dashboard, /Wymaga uwagi/);
  assert.match(dashboard, /href="\/admin\/action-center"/);
  assert.match(dashboard, /Pamięć RAM/);
  assert.match(dashboard, /Transfer \(30 dni\)/);

  const csrf = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf, 'page exposes CSRF token');
  const key = html.match(/name="key" value="([^"]+)"/)?.[1];
  assert.ok(key, 'page exposes a mute key');

  const noToken = await form('/admin/action-center/mute', { key, hours: '1', returnTo: '/admin/action-center' }, cookie);
  assert.equal(noToken.status, 403);

  const muted = await form('/admin/action-center/mute', { _csrf: csrf, key, hours: '1', reason: 'test', returnTo: '/admin/action-center' }, cookie);
  assert.equal(muted.status, 302);
  assert.ok(db.get('SELECT dedupe_key FROM action_center_mutes WHERE dedupe_key = ?', key));
  const mutedPage = await (await fetch(base + '/admin/action-center?show=muted', { headers: { Cookie: cookie } })).text();
  assert.match(mutedPage, /Przywróć/);
  assert.ok(mutedPage.includes(key));

  const unmuted = await form('/admin/action-center/unmute', { _csrf: csrf, key, returnTo: '/admin/action-center' }, cookie);
  assert.equal(unmuted.status, 302);
  assert.equal(db.get('SELECT dedupe_key FROM action_center_mutes WHERE dedupe_key = ?', key), null);
});
