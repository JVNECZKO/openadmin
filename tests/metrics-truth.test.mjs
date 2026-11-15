// Metrics truth contract tests — base units, service state, counts, mail parser,
// log sizes, health aggregation and application probes.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openadmin-metrics-test-'));
process.env.OA_DATA_DIR = dataDir;
process.env.OA_PORT = '0';
process.env.OA_IMAP_PORT = '0';
process.env.OA_HOST = '127.0.0.1';
process.env.OA_DEMO = '0';
process.env.OA_PROVIDER = 'sandbox';

const db = await import('../src/db.mjs');
const metrics = await import('../src/metrics.mjs');
const mail = await import('../src/mail.mjs');
const mailops = await import('../src/mailops.mjs');
const logcenter = await import('../src/logcenter.mjs');
const health = await import('../src/health.mjs');

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

let userIdA;
let userIdB;

function insertUser(username, level = 'user') {
  db.run('INSERT INTO users(username, password, level, created_at) VALUES(?,?,?,?)',
    username, 'test', level, new Date().toISOString());
  return db.get('SELECT id FROM users WHERE username = ?', username).id;
}

function insertDomain(userId, username, name) {
  db.run('INSERT INTO domains(user_id, username, name, created_at) VALUES(?,?,?,?)',
    userId, username, name, new Date().toISOString());
  return db.get('SELECT id FROM domains WHERE name = ?', name).id;
}

function insertMailbox(domainId, domain, localPart, { suspended = 0, usedMb = 1 } = {}) {
  db.run(`INSERT INTO email_accounts(domain_id, domain, local_part, password, quota_mb, used_mb, suspended, created_at)
          VALUES(?,?,?,?,?,?,?,?)`,
  domainId, domain, localPart, 'x', 100, usedMb, suspended, new Date().toISOString());
}

before(() => {
  userIdA = insertUser('metric-a');
  userIdB = insertUser('metric-b');
  const domainA = insertDomain(userIdA, 'metric-a', 'a.example');
  const domainB = insertDomain(userIdB, 'metric-b', 'b.example');
  insertMailbox(domainA, 'a.example', 'one');
  insertMailbox(domainA, 'a.example', 'two', { suspended: 1 });
  insertMailbox(domainB, 'b.example', 'three');
});

after(() => {
  db.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('IEC formatter covers B/KiB/MiB/GiB/TiB and never renders unavailable as 0', () => {
  assert.equal(metrics.formatBytesIEC(0), '0 B');
  assert.equal(metrics.formatBytesIEC(1), '1 B');
  assert.equal(metrics.formatBytesIEC(1023), '1023 B');
  assert.equal(metrics.formatBytesIEC(1024), '1 KiB');
  assert.equal(metrics.formatBytesIEC(1536), '1.5 KiB');
  assert.equal(metrics.formatBytesIEC(MiB), '1 MiB');
  assert.equal(metrics.formatBytesIEC(1536 * 1024), '1.5 MiB');
  assert.equal(metrics.formatBytesIEC(GiB), '1 GiB');
  assert.equal(metrics.formatBytesIEC(460 * GiB), '460 GiB', 'trailing zeros in whole numbers must survive');
  assert.equal(metrics.formatBytesIEC(100 * MiB), '100 MiB');
  assert.equal(metrics.formatBytesIEC(1024 ** 4), '1 TiB');
  assert.equal(metrics.formatBytesIEC(1024 ** 2 - 1), '1 MiB');

  for (const unavailable of [null, undefined, '', NaN, Infinity, -1]) {
    const rendered = metrics.formatBytesIEC(unavailable);
    assert.notEqual(rendered, '0 B', `unavailable value ${String(unavailable)} must not render as zero`);
    assert.equal(rendered, '—');
  }
});

test('MetricsService keeps memory and disk values in bytes with source and timestamp', () => {
  const service = new metrics.MetricsService({
    os: { totalmem: () => 8 * GiB, freemem: () => 2 * GiB },
    meminfoPath: path.join(dataDir, 'does-not-exist-meminfo'),
    clock: () => new Date('2026-01-02T03:04:05.000Z'),
  });
  const memory = service.memory();
  assert.equal(memory.status, 'fresh');
  assert.equal(memory.available, true);
  assert.equal(memory.unit, 'bytes');
  assert.equal(memory.usedBytes, 6 * GiB);
  assert.equal(memory.totalBytes, 8 * GiB);
  assert.equal(memory.percent, 75);
  assert.equal(memory.source, 'os.totalmem/freemem');
  assert.equal(memory.timestamp, '2026-01-02T03:04:05.000Z');

  const broken = new metrics.MetricsService({
    os: { totalmem: () => { throw new Error('memory probe failed'); }, freemem: () => 0 },
    meminfoPath: path.join(dataDir, 'does-not-exist-meminfo'),
  });
  const unavailable = broken.memory();
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.usedBytes, null);
  assert.equal(unavailable.totalBytes, null);
  assert.equal(unavailable.percent, null);
  assert.match(unavailable.reason, /memory probe failed/);
  assert.equal(metrics.formatBytesIEC(unavailable.usedBytes), '—');

  const diskService = new metrics.MetricsService({
    statfs: () => ({ bsize: 4096, blocks: 1024, bavail: 512 }),
  });
  const disk = diskService.disk('/');
  assert.equal(disk.status, 'fresh');
  assert.equal(disk.totalBytes, 4 * MiB);
  assert.equal(disk.usedBytes, 2 * MiB);
  assert.equal(disk.freeBytes, 2 * MiB);
  assert.equal(disk.percent, 50);
  assert.equal(disk.source, 'statfs:/');
  assert.equal(metrics.formatBytesIEC(disk.usedBytes), '2 MiB');

  const brokenDisk = new metrics.MetricsService({
    statfs: () => { throw Object.assign(new Error('statfs failed'), { code: 'ENOENT' }); },
  }).disk('/missing');
  assert.equal(brokenDisk.status, 'unavailable');
  assert.equal(brokenDisk.usedBytes, null);
  assert.equal(brokenDisk.percent, null);
  assert.equal(metrics.formatBytesIEC(brokenDisk.value), '—');
});

test('metric freshness is explicit and stale observations keep the value', () => {
  const fresh = metrics.metricValue(1024, { source: 'probe', timestamp: '2026-01-01T00:00:00Z', now: Date.parse('2026-01-01T00:00:10Z') });
  assert.equal(fresh.status, 'fresh');
  assert.equal(fresh.available, true);

  const stale = metrics.metricValue(1024, {
    source: 'probe',
    timestamp: '2026-01-01T00:00:00Z',
    now: Date.parse('2026-02-01T00:00:00Z'),
    staleAfterSeconds: 60,
  });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.available, true);
  assert.equal(stale.value, 1024);
  assert.match(stale.reason, /starszy/);

  const missing = metrics.metricValue(null, { source: 'probe', reason: 'brak odczytu' });
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.value, null);
  assert.match(missing.reason, /brak odczytu/);
});

test('service state keeps alternate web engines inactive-by-design and out of counters', () => {
  const rows = [
    { name: 'nginx', status: 'running' },
    { name: 'httpd', status: 'stopped' },
    { name: 'openlitespeed', status: 'stopped' },
    { name: 'exim', status: 'running' },
    { name: 'dovecot', status: 'running' },
    { name: 'mysqld', status: 'running' },
    { name: 'bind', status: 'running' },
    { name: 'php-fpm', status: 'running' },
    { name: 'cron', status: 'running' },
    { name: 'redis', status: 'stopped' },
  ];
  const provider = {
    serviceStatus: (name) => ({
      status: ['nginx', 'exim', 'dovecot', 'mysqld', 'bind', 'php-fpm', 'cron'].includes(name) ? 'running' : 'stopped',
      simulated: false,
    }),
  };
  const states = metrics.serviceStateRows({ rows, provider, activeEngine: 'nginx' });
  const apache = states.find((state) => state.name === 'httpd');
  assert.equal(apache.state, 'inactive-by-design');
  assert.equal(apache.expected, false);
  assert.match(apache.detail, /Nginx/);
  assert.equal(states.find((state) => state.name === 'openlitespeed').state, 'inactive-by-design');
  assert.equal(states.find((state) => state.name === 'redis').state, 'inactive-by-design');

  const summary = metrics.summarizeServiceStates(states);
  assert.equal(summary.expected, 7, 'only the active engine and core services are expected');
  assert.equal(summary.running, 7);
  assert.equal(summary.failed, 0);
  assert.equal(summary.inactiveByDesign, 3);

  const stopped = metrics.serviceStateRows({
    rows,
    provider: { serviceStatus: () => ({ status: 'stopped', simulated: false }) },
    activeEngine: 'nginx',
  });
  const stoppedSummary = metrics.summarizeServiceStates(stopped);
  assert.equal(stoppedSummary.failed, 7);
  assert.equal(stopped.find((state) => state.name === 'httpd').state, 'inactive-by-design');
  assert.equal(stopped.find((state) => state.name === 'nginx').state, 'failed');

  const unknown = metrics.serviceStateRows({
    rows: [{ name: 'nginx', status: null }],
    provider: { serviceStatus: () => ({ status: null, simulated: false }) },
    activeEngine: 'nginx',
  });
  assert.equal(unknown[0].state, 'unknown');
  assert.equal(unknown[0].expected, true);
});

test('automation execution status is separate from the observed subsystem state', () => {
  const observation = metrics.deriveJobObservation({
    key: 'mail.queue',
    status: 'ok',
    output: 'panel queue: total=9, deferred=0, failed=9, queued=0',
  });
  assert.equal(observation.executionStatus, 'success');
  assert.equal(observation.observedStatus, 'critical');
  assert.equal(observation.critical, true);
  assert.match(observation.reason, /9/);

  const healthy = metrics.deriveJobObservation({
    key: 'mail.queue',
    status: 'ok',
    output: 'panel queue: total=0, deferred=0, failed=0, queued=0',
  });
  assert.equal(healthy.executionStatus, 'success');
  assert.equal(healthy.observedStatus, 'ok');

  const healthCheck = metrics.deriveJobObservation({
    key: 'health.check',
    status: 'ok',
    output: 'health=fail ok=3 warn=2 fail=1',
  });
  assert.equal(healthCheck.executionStatus, 'success');
  assert.equal(healthCheck.observedStatus, 'critical');
});

test('mailbox count uses get() as an object and every scope agrees with its list', () => {
  const status = mail.mailStatus();
  assert.equal(status.accounts, 3, 'get() returns an object; accounts must not fall back to 0');
  assert.equal(status.accounts, mail.mailAccounts().length);
  assert.equal(status.activeAccounts, 2);
  assert.equal(status.suspendedAccounts, 1);

  const scopeA = { userId: userIdA };
  assert.equal(mail.mailboxCount(scopeA), 2);
  assert.equal(mail.mailboxList(scopeA).length, 2);
  assert.equal(mail.mailSummary(scopeA).total, 2);

  const scopeB = { userId: userIdB };
  assert.equal(mail.mailboxCount(scopeB), 1);
  assert.equal(mail.mailboxList(scopeB).length, 1);

  assert.equal(mail.mailboxCount({ domain: 'a.example' }), 2);
  assert.equal(mail.mailboxCount({ userId: userIdA, domain: 'a.example' }), 2);
  assert.equal(mail.mailboxCount(), mail.mailAccounts().length);
});

test('mailStatus file sizes are bytes, not megabytes', () => {
  const synced = mail.syncMail();
  assert.equal(synced.ok, true);
  const status = mail.mailStatus();
  assert.ok(status.files.length > 0);
  let sum = 0;
  for (const file of status.files) {
    const actual = fs.statSync(path.join(status.directory, file.name)).size;
    assert.equal(file.bytes, actual, `${file.name} bytes must be raw file size`);
    sum += actual;
  }
  assert.equal(status.configBytes, sum);
  assert.ok(status.configBytes < 10 * 1024 * 1024, 'mail configuration is measured in bytes');
});

test('Exim parser separates sender/recipient, bounce, local delivery and retry', () => {
  const success = mailops.parseEximLine('2026-11-14 12:00:00 1abcDEF-000001-AA <= alice@example.com H=mail P=esmtp S=123 for bob@example.com');
  assert.equal(success.status, 'received');
  assert.equal(success.sender, 'alice@example.com');
  assert.equal(success.recipient, 'bob@example.com');
  assert.equal(success.addressParse, 'ok');

  const bounce = mailops.parseEximLine('2026-11-14 12:00:01 1abcDEF-000001-AA <= <> R=system T=local');
  assert.equal(bounce.bounce, true);
  assert.equal(bounce.sender, null, 'bounce sender is empty in the envelope, not an empty address');
  assert.equal(bounce.addressParse, 'bounce');

  const local = mailops.parseEximLine('2026-11-14 12:00:02 1abcDEF-000001-AA => /var/mail/mail <bob@example.com> R=local_delivery T=maildir');
  assert.equal(local.recipient, 'bob@example.com');
  assert.equal(local.localDelivery, true);
  assert.equal(local.deliveryPath, '/var/mail/mail');
  assert.notEqual(local.recipient, '/var/mail/mail');

  const retry = mailops.parseEximLine('2026-11-14 12:00:03 1abcDEF-000001-AA == bob@example.com R=dnslookup T=remote_smtp defer (110): Connection timed out');
  assert.equal(retry.status, 'deferred');
  assert.equal(retry.retry, true);
  assert.equal(retry.recipient, 'bob@example.com');

  const separator = mailops.parseEximLine('2026-11-14 12:00:04 1abcDEF-000001-AA ** bob@example.com: R=dnslookup T=remote_smtp: 550 rejected');
  assert.equal(separator.recipient, 'bob@example.com', 'log separator must not become part of the address');
  assert.equal(separator.status, 'failed');

  assert.equal(mailops.normalizeAddress(undefined), null);
  assert.equal(mailops.normalizeAddress(''), null);
  assert.equal(mailops.normalizeAddress(':'), null);
  assert.equal(mailops.normalizeAddress('/var/mail/mail'), null);
  assert.equal(mailops.normalizeAddress('<>'), null);
  assert.equal(mailops.normalizeAddress('bob@example.com:'), 'bob@example.com');
});

test('mail event sync stores addresses, never undefined/paths, and keeps the raw line', () => {
  const fixture = [
    '2026-11-14 12:10:00 1abcDEF-000010-AA <= alice@example.com H=mail P=esmtp S=123 for bob@example.com',
    '2026-11-14 12:10:01 1abcDEF-000010-AA <= <> R=system T=local',
    '2026-11-14 12:10:02 1abcDEF-000010-AA => /var/mail/mail <bob@example.com> R=local_delivery T=maildir',
    '2026-11-14 12:10:03 1abcDEF-000010-AA == bob@example.com R=dnslookup T=remote_smtp defer (110): Connection timed out',
    '2026-11-14 12:10:04 1abcDEF-000010-AA ** :',
  ].join('\n');
  const fixturePath = path.join(dataDir, 'mainlog.fixture');
  fs.writeFileSync(fixturePath, `${fixture}\n`);

  const first = mailops.syncMailEvents({ logFile: fixturePath, maxLines: 20 });
  assert.equal(first.ok, true);
  assert.equal(first.inserted, 5);
  assert.equal(first.unparsed, 1);

  const second = mailops.syncMailEvents({ logFile: fixturePath, maxLines: 20 });
  assert.equal(second.inserted, 0, 'raw line is the idempotency key');

  const rows = mailops.listEvents({ limit: 20 });
  assert.equal(rows.length, 5);
  for (const row of rows) {
    for (const value of [row.sender, row.recipient]) {
      if (value === null) continue;
      assert.ok(!['', ':', 'undefined', 'null', '/var/mail/mail'].includes(value), `invalid rendered address: ${value}`);
    }
    assert.ok(fixture.includes(row.raw), 'raw log line is retained for details');
  }
  const unparsed = rows.find((row) => row.status === 'failed');
  assert.match(unparsed.reason, /Nie udało się sparsować/);
  assert.equal(unparsed.sender, null);
  assert.equal(unparsed.recipient, null);
});

test('queue rows normalize separators and delivery paths before rendering', () => {
  db.run('INSERT INTO mail_queue(sender, recipient, status, created_at) VALUES(?,?,?,?)',
    ':', '/var/mail/mail', 'failed', new Date().toISOString());
  const queue = mailops.queueList();
  const row = queue.rows.find((entry) => entry.recipient === null);
  assert.ok(row, 'invalid path must not be returned as an address');
  assert.equal(row.sender, null);
  assert.notEqual(row.sender, ':');
  assert.notEqual(row.recipient, '/var/mail/mail');
});

test('log sources expose sizeBytes and the Log Center formatter stays in bytes', () => {
  const logDir = path.join(dataDir, 'simulated', 'var', 'log');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'smoke.log');
  fs.writeFileSync(logFile, 'x'.repeat(1536));

  const source = logcenter.sources().find((entry) => entry.id === 'sim:smoke.log');
  assert.ok(source, 'simulated log source is listed');
  assert.equal(source.sizeBytes, 1536);
  assert.equal(source.size, 1536);
  assert.equal(source.status, 'fresh');
  assert.equal(metrics.formatBytesIEC(source.sizeBytes), '1.5 KiB');

  const result = logcenter.tail('sim:smoke.log', { lines: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.source.sizeBytes, 1536);
  assert.equal(metrics.formatBytesIEC(result.source.sizeBytes), '1.5 KiB');
  assert.notEqual(metrics.formatBytesIEC(result.source.sizeBytes), '3.65 GB');
});

test('application health probes the base path and refuses running for 4xx/5xx', async () => {
  const base = {
    id: 'phpmyadmin',
    name: 'phpMyAdmin',
    installed: true,
    pid: 4321,
    running: true,
    port: 8082,
    url: '/phpmyadmin/',
    php: true,
    missingExtensions: [],
  };
  const okApp = await health.applicationHealth('phpmyadmin', {
    statusFn: () => base,
    http: async () => ({ ok: true, status: 200, body: '<html>login</html>', error: '' }),
    ssoEnabled: () => true,
  });
  assert.equal(okApp.state, 'running');
  assert.equal(okApp.running, true);
  assert.equal(okApp.observedStatus, 'ok');
  assert.equal(okApp.login.sso, true);
  assert.equal(okApp.http.status, 200);

  const notFound = await health.applicationHealth('phpmyadmin', {
    statusFn: () => base,
    http: async () => ({ ok: true, status: 404, body: 'Not found', error: '' }),
    ssoEnabled: () => true,
  });
  assert.equal(notFound.state, 'degraded');
  assert.equal(notFound.running, false);
  assert.equal(notFound.observedStatus, 'warn');
  assert.equal(notFound.http.status, 404);

  const forbidden = await health.applicationHealth('roundcube', {
    statusFn: () => ({ ...base, id: 'roundcube', name: 'Roundcube', port: 8083, url: '/roundcube/' }),
    http: async () => ({ ok: true, status: 403, body: 'Forbidden', error: '' }),
    ssoEnabled: () => false,
  });
  assert.equal(forbidden.state, 'degraded');
  assert.equal(forbidden.running, false);

  const failure = await health.applicationHealth('roundcube', {
    statusFn: () => ({ ...base, id: 'roundcube', name: 'Roundcube', port: 8083, url: '/roundcube/' }),
    http: async () => ({ ok: true, status: 500, body: 'Internal error', error: '' }),
    ssoEnabled: () => false,
  });
  assert.equal(failure.state, 'failed');
  assert.equal(failure.running, false);
  assert.equal(failure.observedStatus, 'critical');

  const refused = await health.applicationHealth('roundcube', {
    statusFn: () => ({ ...base, id: 'roundcube', name: 'Roundcube', port: 8083, url: '/roundcube/' }),
    http: async () => ({ ok: false, status: null, body: '', error: 'ECONNREFUSED' }),
    ssoEnabled: () => false,
  });
  assert.equal(refused.state, 'failed');
  assert.equal(refused.running, false);
  assert.match(refused.lastError, /ECONNREFUSED/);

  const stopped = await health.applicationHealth('phpmyadmin', {
    statusFn: () => ({ ...base, pid: 0, running: false }),
    http: async () => ({ ok: true, status: 200, body: '', error: '' }),
    ssoEnabled: () => true,
  });
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.running, false);

  const missingExtensions = await health.applicationHealth('phpmyadmin', {
    statusFn: () => ({ ...base, missingExtensions: ['mysqli'] }),
    http: async () => ({ ok: true, status: 200, body: '<html>login</html>', error: '' }),
    ssoEnabled: () => true,
  });
  assert.equal(missingExtensions.state, 'degraded');
  assert.equal(missingExtensions.running, false);
});

test('health summary never stays green when a critical check failed', () => {
  const clean = health.summarizeHealth([
    { status: 'ok', executionStatus: 'ok' },
    { status: 'ok', executionStatus: 'ok' },
  ]);
  assert.equal(clean.summary, 'ok');
  assert.equal(clean.observedStatus, 'ok');
  assert.equal(clean.executionStatus, 'completed');

  const critical = health.summarizeHealth([
    { status: 'ok', executionStatus: 'ok' },
    { status: 'fail', critical: true, executionStatus: 'ok', observedStatus: 'critical' },
    { status: 'ok', executionStatus: 'ok' },
  ]);
  assert.equal(critical.summary, 'fail');
  assert.equal(critical.observedStatus, 'critical');
  assert.equal(critical.counts.fail, 1);
  assert.equal(critical.criticalFailures, 1);

  const skipped = health.summarizeHealth([
    { status: 'ok', executionStatus: 'ok' },
    { status: 'warn', executionStatus: 'skipped' },
  ]);
  assert.equal(skipped.summary, 'warn');
  assert.equal(skipped.executionStatus, 'partial');
  assert.equal(skipped.skipped, 1);
});

test('linux health path probes vhosts, PHP, DB, queue, mailboxes, DNS, TLS and apps', async () => {
  const appBase = {
    installed: true,
    pid: 1234,
    running: true,
    port: 8082,
    url: '/app/',
    php: true,
    missingExtensions: [],
  };
  const report = await health.healthReport({
    probe: {
      provider: { id: 'linux', serviceStatus: () => ({ status: 'running', simulated: false }) },
      php: () => ({ ok: true, version: '8.4', error: '' }),
      poolStatus: () => ({ exists: true }),
      queue: () => ({ ok: true, simulated: false, rows: [] }),
      appStatus: (id) => ({ ...appBase, id, name: id, port: id === 'phpmyadmin' ? 8082 : 8083, url: `/${id}/` }),
      ssoEnabled: () => true,
      http: async () => ({ ok: true, status: 200, body: '<html>login</html>', error: '' }),
      tcp: async () => true,
      tls: async () => ({ ok: true, protocol: 'TLSv1.3', authorized: true, validTo: '2027-01-01T00:00:00Z', error: '' }),
      dig: (name, type) => {
        if (type === 'A') return ['127.0.0.1'];
        if (name.startsWith('_dmarc.')) return ['v=DMARC1; p=quarantine'];
        if (name.startsWith('default._domainkey.')) return ['v=DKIM1; k=rsa'];
        if (type === 'TXT') return ['v=spf1 a mx ~all'];
        return [];
      },
      digPublic: () => ['127.0.0.1'],
    },
  });
  const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
  assert.equal(byId['vhost-http'].status, 'ok');
  assert.equal(byId.php.status, 'ok');
  assert.equal(byId['db-panel'].status, 'ok');
  assert.equal(byId.db.status, 'ok');
  assert.equal(byId.queue.status, 'ok');
  assert.equal(byId.mailboxes.status, 'ok');
  assert.equal(byId.mail.status, 'ok');
  assert.equal(byId.dns.status, 'ok');
  assert.equal(byId['ssl-handshake'].status, 'ok');
  assert.equal(byId['app-phpmyadmin'].status, 'ok');
  assert.equal(byId['app-roundcube'].status, 'ok');
  assert.equal(report.counts.fail, 0, `unexpected failures: ${report.checks.filter((c) => c.status === 'fail').map((c) => c.id).join(', ')}`);
  assert.equal(report.executionStatus, 'completed', 'linux probes are all executed');
});

test('healthReport aggregates a failing mail queue into fail and exposes functional checks', async () => {
  const report = await health.healthReport({
    probe: {
      provider: { id: 'sandbox', serviceStatus: () => ({ status: 'running', simulated: true }) },
      php: () => ({ ok: true, version: '8.4-test', error: '' }),
      appStatus: () => ({ installed: false }),
      queue: () => ({
        ok: true,
        simulated: true,
        rows: [
          { status: 'failed', recipient: 'bob@example.com' },
          { status: 'failed', recipient: 'carol@example.com' },
          { status: 'queued', recipient: 'dave@example.com' },
        ],
      }),
      tcp: async () => false,
    },
  });

  const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
  for (const id of ['web', 'php', 'db-panel', 'db', 'queue', 'mailboxes', 'vhost-http', 'dns', 'certs', 'app-phpmyadmin', 'app-roundcube', 'automation']) {
    assert.ok(byId[id], `missing functional check ${id}`);
  }
  assert.equal(byId.queue.status, 'fail');
  assert.equal(byId.queue.critical, true);
  assert.equal(byId.queue.observedStatus, 'critical');
  assert.equal(byId.queue.executionStatus, 'ok', 'the probe executed successfully…');
  assert.equal(report.queue.failed, 2);
  assert.ok(report.automation, 'automation observations are exposed');
  assert.ok(!report.automation.jobs.some((job) => job.key === 'health.check'),
    'health.check must not feed its own previous result back into the report');
  assert.equal(report.summary, 'fail', '…but the observed subsystem state turns the summary red');
  assert.equal(report.observedStatus, 'critical');
  assert.equal(report.executionStatus, 'partial', 'sandbox checks are honestly skipped');
  assert.equal(report.mailboxes.consistent, true);
  assert.equal(report.metrics.memory.unit, 'bytes');
  assert.equal(report.metrics.disk.unit, 'bytes');
});
