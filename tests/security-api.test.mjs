// Security regression tests for the REST/CMD API, sessions, MCP and server
// proxy trust. Node's built-in test runner only; isolated simulated database.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openadmin-security-api-'));
process.env.OA_DATA_DIR = dataDir;
process.env.OA_PORT = '0';
process.env.OA_IMAP_PORT = '0';
process.env.OA_HOST = '127.0.0.1';
process.env.OA_DEMO = '0';
process.env.OA_ADMIN_PASSWORD = 'admin-test-pass';
process.env.OA_SESSION_TTL = '24';
process.env.OA_SESSION_IDLE_MINUTES = '120';
// The test socket is loopback, so it must be a trusted proxy for the
// X-Forwarded-For chain tests. Private/benchmark ranges are trusted hops.
process.env.OA_TRUSTED_PROXIES = '127.0.0.1,::1,10.0.0.0/8,2001:db8::/32';

const serverMod = await import('../src/server.mjs');
const db = await import('../src/db.mjs');
const apikeys = await import('../src/apikeys.mjs');

let server;
let base;
let admin;
let resellerA;
let resellerB;
let userA;
let userB;
let rateUser;
let domainA;
let domainB;
let backupA;
let backupB;

const ts = db.nowIso();
const stamp = Date.now();

function basic(username, password) {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

function credentials(actor) {
  return basic(actor.username, actor.level === 'admin' ? 'admin-test-pass' : 'demo');
}

async function api(pathname, { actor = null, method = 'GET', body = null, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (actor) requestHeaders.Authorization = credentials(actor);
  if (body) requestHeaders['Content-Type'] = 'application/json';
  const res = await fetch(base + pathname, {
    method,
    headers: requestHeaders,
    redirect: 'manual',
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* CMD responses are form encoded */ }
  return { res, status: res.status, text, json };
}

async function form(pathname, fields, cookie = '') {
  return fetch(base + pathname, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
}

function cookieFrom(response) {
  const list = response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get('set-cookie')];
  return list.filter(Boolean).map((value) => value.split(';')[0]).join('; ');
}

async function loginAs(username, password = 'demo') {
  const response = await form('/login', { username, password });
  assert.equal(response.status, 302, `login for ${username} should redirect`);
  return cookieFrom(response);
}

function sessionToken(cookie) {
  return /(?:^|;\s*)OA_SESSION=([^;]+)/.exec(cookie || '')?.[1] || null;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function csrfFor(cookie) {
  const token = sessionToken(cookie);
  assert.ok(token, 'session cookie carries a token');
  const row = db.get('SELECT csrf FROM sessions WHERE token_hash = ?', tokenHash(token));
  assert.ok(row?.csrf, 'session row resolves by token hash');
  return row.csrf;
}

async function mcp(secret, name, args = {}) {
  const response = await fetch(base + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const json = await response.json();
  const text = json?.result?.content?.[0]?.text ?? '';
  let value = null;
  try { value = JSON.parse(text); } catch { /* error text */ }
  return { status: response.status, json, text, value, isError: json?.result?.isError === true };
}

async function mcpList(secret) {
  const response = await fetch(base + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const json = await response.json();
  return (json?.result?.tools || []).map((tool) => tool.name);
}

function addUser(username, level, owner, packageName) {
  const result = db.run(`INSERT INTO users(username, password, email, level, owner, package, domain, suspended, created_at)
                         VALUES(?,?,?,?,?,?,?,?,?)`,
  username, db.hashPassword('demo'), `${username}@example.test`, level, owner, packageName, null, 0, ts);
  return db.get('SELECT * FROM users WHERE id = ?', Number(result.lastInsertRowid));
}

function addDomain(user, name) {
  const result = db.run(`INSERT INTO domains(user_id, username, name, docroot, php_version, ssl, status, is_main, ip, created_at)
                         VALUES(?,?,?,?,?,?,?,?,?,?)`,
  user.id, user.username, name, `/home/${user.username}/domains/${name}/public_html`, '8.3', 1, 'active', 0, '127.0.0.1', ts);
  return db.get('SELECT * FROM domains WHERE id = ?', Number(result.lastInsertRowid));
}

function addMailbox(domain, localPart) {
  db.run(`INSERT INTO email_accounts(domain_id, domain, local_part, password, quota_mb, used_mb, suspended, created_at)
          VALUES(?,?,?,?,?,?,?,?)`, domain.id, domain.name, localPart, db.hashPassword('demo'), 1024, 0, 0, ts);
  return db.get('SELECT * FROM email_accounts WHERE domain = ? AND local_part = ?', domain.name, localPart);
}

before(async () => {
  server = serverMod.start();
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  admin = db.get("SELECT * FROM users WHERE level = 'admin'");
  resellerA = addUser('seca-reseller', 'reseller', null, 'reseller_default');
  resellerB = addUser('secb-reseller', 'reseller', null, 'reseller_default');
  userA = addUser('seca-user', 'user', resellerA.username, 'default');
  userB = addUser('secb-user', 'user', resellerB.username, 'default');
  rateUser = addUser('sec-rate-user', 'user', resellerB.username, 'default');

  domainA = addDomain(userA, `a-${stamp}.sec.example.test`);
  domainB = addDomain(userB, `b-${stamp}.sec.example.test`);
  addMailbox(domainA, 'usera');
  addMailbox(domainB, 'userb');

  db.run(`INSERT INTO dns_records(domain_id, name, type, value, priority, ttl) VALUES(?,?,?,?,?,?)`, domainA.id, 'www', 'A', '192.0.2.11', null, 3600);
  db.run(`INSERT INTO dns_records(domain_id, name, type, value, priority, ttl) VALUES(?,?,?,?,?,?)`, domainB.id, 'www', 'A', '192.0.2.22', null, 3600);

  db.run(`INSERT INTO databases(user_id, db_name, db_user, password, size_mb, created_at) VALUES(?,?,?,?,?,?)`,
    userA.id, 'seca_db', 'seca_db', db.hashPassword('demo'), 1, ts);
  db.run(`INSERT INTO databases(user_id, db_name, db_user, password, size_mb, created_at) VALUES(?,?,?,?,?,?)`,
    userB.id, 'secb_db', 'secb_db', db.hashPassword('demo'), 1, ts);

  fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
  backupA = { filename: 'seca-backup.tar.gz', body: 'archive-a' };
  backupB = { filename: 'secb-backup.tar.gz', body: 'archive-b' };
  for (const [owner, backup] of [[userA, backupA], [userB, backupB]]) {
    fs.writeFileSync(path.join(dataDir, 'backups', backup.filename), backup.body);
    const result = db.run(`INSERT INTO backups(user_id, filename, kind, size_mb, status, created_at) VALUES(?,?,?,?,?,?)`,
      owner.id, backup.filename, 'full', 0.1, 'complete', ts);
    backup.id = Number(result.lastInsertRowid);
  }

  for (const [owner, domain, local] of [[userA, domainA, 'seca'], [userB, domainB, 'secb']]) {
    db.run(`INSERT INTO tickets(user_id, username, subject, department, priority, status, created_at, updated_at)
            VALUES(?,?,?,?,?,?,?,?)`, owner.id, owner.username, `${local} ticket`, 'support', 'normal', 'open', ts, ts);
    db.run(`INSERT INTO ftp_accounts(user_id, username, path, quota_mb, password, created_at) VALUES(?,?,?,?,?,?)`,
      owner.id, `ftp-${local}`, `/home/${owner.username}`, 0, db.hashPassword('demo'), ts);
    db.run(`INSERT INTO email_forwarders(domain_id, domain, source, dest, keep_copy, created_at) VALUES(?,?,?,?,?,?)`,
      domain.id, domain.name, `${local}-fwd`, `${local}@example.net`, 1, ts);
    db.run(`INSERT INTO autoresponders(domain_id, domain, email, subject, body, enabled, created_at) VALUES(?,?,?,?,?,?,?)`,
      domain.id, domain.name, `${local}-auto@${domain.name}`, 'Away', 'Back soon', 1, ts);
    db.run(`INSERT INTO vacation(domain, email, subject, body, enabled, created_at) VALUES(?,?,?,?,?,?)`,
      domain.name, `${local}-vacation@${domain.name}`, 'Away', 'Back soon', 1, ts);
  }
});

after(async () => {
  const { stopImap } = await import('../src/imap.mjs');
  stopImap();
  await new Promise((resolve) => server.close(resolve));
  db.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ SEC-006 */
test('SEC-006: X-Forwarded-For is honored only from configured trusted proxies', () => {
  const { clientIp } = serverMod;

  assert.equal(clientIp({ headers: { 'x-forwarded-for': '198.51.100.9' }, socket: { remoteAddress: '203.0.113.5' } }), '203.0.113.5',
    'untrusted peers cannot spoof the client address');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '203.0.113.5' } }), '203.0.113.5');

  assert.equal(clientIp({ headers: { 'x-forwarded-for': '198.51.100.7' }, socket: { remoteAddress: '127.0.0.1' } }), '198.51.100.7');
  assert.equal(clientIp({
    headers: { 'x-forwarded-for': '198.51.100.7, 10.1.2.3' }, socket: { remoteAddress: '127.0.0.1' },
  }), '198.51.100.7', 'the chain is walked from the right, skipping trusted hops');
  assert.equal(clientIp({
    headers: { 'x-forwarded-for': '10.1.2.3, 10.1.2.4' }, socket: { remoteAddress: '127.0.0.1' },
  }), '10.1.2.3', 'all-trusted chains return the leftmost hop');

  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '::ffff:192.0.2.4' } }), '192.0.2.4', 'IPv4-mapped IPv6 is normalized');
  assert.equal(clientIp({
    headers: { 'x-forwarded-for': '198.51.100.8, 2001:db8::4' }, socket: { remoteAddress: '2001:db8::1' },
  }), '198.51.100.8', 'IPv6 proxy chains are supported');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '::1' } }), '::1');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': 'not-an-ip' }, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1',
    'malformed forwarded hops fall back to the socket peer');
});

/* ------------------------------------------------------------------ SEC-017 */
test('SEC-017: API key IP allowlists use real IPv4/IPv6 CIDR matching and validation', async () => {
  assert.equal(apikeys.ipMatches('198.51.100.42', '198.51.100.0/24'), true);
  assert.equal(apikeys.ipMatches('198.51.101.42', '198.51.100.0/24'), false);
  assert.equal(apikeys.ipMatches('198.51.100.42', '198.51.100.42'), true);
  assert.equal(apikeys.ipMatches('2001:db8::4', '2001:db8::/32'), true);
  assert.equal(apikeys.ipMatches('2001:db9::4', '2001:db8::/32'), false);
  assert.equal(apikeys.ipMatches('::ffff:10.9.8.7', '10.0.0.0/8'), true, 'IPv4-mapped addresses match IPv4 CIDRs');
  assert.equal(apikeys.ipMatches('198.51.100.7', '::ffff:198.51.100.0/120'), true, 'mapped CIDR rules match IPv4');
  assert.equal(apikeys.ipMatches('not-an-ip', '10.0.0.0/8'), false);

  assert.equal(apikeys.validateAllowedIps(['198.51.100.0/24', '2001:db8::/32']).ok, true);
  assert.equal(apikeys.validateAllowedIps(['198.51.100.0/33']).ok, false);
  assert.equal(apikeys.validateAllowedIps(['300.1.1.1']).ok, false);

  const invalid = apikeys.createKey(userA.id, { name: 'invalid-ip', scopes: ['read'], allowedIps: ['198.51.100.0/33'] });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /Invalid IP/);

  const cidrKey = apikeys.createKey(userA.id, { name: 'cidr-key', scopes: ['read'], allowedIps: ['10.0.0.0/8', '2001:db8::/32'] });
  assert.equal(cidrKey.ok, true);
  assert.equal(apikeys.keyFromRequest({ 'x-api-key': cidrKey.secret }, '10.9.8.7', 'GET')?.username, userA.username);
  assert.equal(apikeys.keyFromRequest({ 'x-api-key': cidrKey.secret }, '::ffff:10.9.8.7', 'GET')?.username, userA.username);
  assert.ok(apikeys.keyFromRequest({ 'x-api-key': cidrKey.secret }, '2001:db8::42', 'GET'));
  assert.equal(apikeys.keyFromRequest({ 'x-api-key': cidrKey.secret }, '192.0.2.7', 'GET'), null);
  assert.equal(apikeys.updateKey(cidrKey.id, { name: 'cidr-key', scopes: ['read'], allowedIps: ['bad-cidr'] }).ok, false);

  const httpKey = apikeys.createKey(userA.id, { name: 'http-cidr', scopes: ['read'], allowedIps: ['10.0.0.0/8'] });
  const allowed = await api('/api/v1/domains', { headers: { 'X-API-Key': httpKey.secret, 'X-Forwarded-For': '10.1.2.3' } });
  assert.equal(allowed.status, 200, 'a trusted forwarded address inside the CIDR is accepted');
  const denied = await api('/api/v1/domains', { headers: { 'X-API-Key': httpKey.secret, 'X-Forwarded-For': '192.0.2.10' } });
  assert.equal(denied.status, 401, 'an address outside the CIDR is rejected');

  apikeys.revokeKey(cidrKey.id);
  assert.equal(apikeys.keyFromRequest({ 'x-api-key': cidrKey.secret }, '10.9.8.7', 'GET'), null, 'revoked keys stop working');
});

/* ------------------------------------------------------------------ SEC-004 */
test('SEC-004: login-key command allowlist is exact and deny-by-default', async () => {
  const keyId = `key-${stamp}`;
  const secret = `secret-${stamp}`;
  db.run(`INSERT INTO login_keys(user_id, key_id, secret, expires_at, commands, created_at) VALUES(?,?,?,?,?,?)`,
    userA.id, keyId, db.hashPassword(secret), new Date(Date.now() + 3600_000).toISOString(),
    `CMD_API_DOMAIN,/api/v1/me`, ts);
  const header = basic(userA.username, `${keyId}:${secret}`);

  const allowed = await api('/CMD_API_DOMAIN', { headers: { Authorization: header } });
  assert.equal(allowed.status, 200);
  assert.match(allowed.text, /^error=0/);
  assert.match(allowed.text, new RegExp(domainA.name.replace(/\./g, '\\.')));
  assert.ok(db.get('SELECT last_used FROM login_keys WHERE key_id = ?', keyId).last_used, 'allowed use is recorded');

  const context = await api('/api/v1/me', { headers: { Authorization: header } });
  assert.equal(context.status, 200);
  assert.equal(context.json.auth.type, 'login_key');
  assert.deepEqual(context.json.auth.commands, ['CMD_API_DOMAIN', '/api/v1/me'], 'the exact allowlist context is attached');

  const deniedRest = await api('/api/v1/domains', { headers: { Authorization: header } });
  assert.equal(deniedRest.status, 401, 'a non-allowlisted REST route is denied');

  const deniedCmd = await api('/CMD_API_DB', { headers: { Authorization: header } });
  assert.equal(deniedCmd.status, 200);
  assert.match(deniedCmd.text, /^error=1/, 'a non-allowlisted CMD command is denied');

  // Empty commands means "all commands" (the documented key semantics).
  const allId = `all-${stamp}`;
  const allSecret = `allsecret-${stamp}`;
  db.run(`INSERT INTO login_keys(user_id, key_id, secret, expires_at, commands, created_at) VALUES(?,?,?,?,?,?)`,
    userB.id, allId, db.hashPassword(allSecret), null, '', ts);
  const all = await api('/api/v1/domains', { headers: { Authorization: basic(userB.username, `${allId}:${allSecret}`) } });
  assert.equal(all.status, 200);

  const expiredId = `expired-${stamp}`;
  const expiredSecret = `expiredsecret-${stamp}`;
  db.run(`INSERT INTO login_keys(user_id, key_id, secret, expires_at, commands, created_at) VALUES(?,?,?,?,?,?)`,
    userA.id, expiredId, db.hashPassword(expiredSecret), '2000-01-01T00:00:00.000Z', 'CMD_API_DOMAIN', ts);
  const expired = await api('/CMD_API_DOMAIN', { headers: { Authorization: basic(userA.username, `${expiredId}:${expiredSecret}`) } });
  assert.match(expired.text, /^error=1/, 'expired keys are rejected');

  const revokedId = `revoked-${stamp}`;
  const revokedSecret = `revokedsecret-${stamp}`;
  db.run(`INSERT INTO login_keys(user_id, key_id, secret, expires_at, commands, created_at) VALUES(?,?,?,?,?,?)`,
    userA.id, revokedId, db.hashPassword(revokedSecret), null, 'CMD_API_DOMAIN', ts);
  db.run('DELETE FROM login_keys WHERE key_id = ?', revokedId);
  const revoked = await api('/CMD_API_DOMAIN', { headers: { Authorization: basic(userA.username, `${revokedId}:${revokedSecret}`) } });
  assert.match(revoked.text, /^error=1/, 'revoked keys are rejected');
  db.run('DELETE FROM login_attempts');
});

/* ------------------------------------------------------------------ SEC-009 */
test('SEC-009: Basic Auth shares the login rate limiter and keeps attempts bounded', async () => {
  const forwarded = { 'X-Forwarded-For': '203.0.113.99' };
  for (let i = 0; i < 12; i += 1) {
    const attempt = await api('/api/v1/me', { headers: { Authorization: basic(rateUser.username, 'wrong'), ...forwarded } });
    assert.equal(attempt.status, 401);
  }
  const blocked = await api('/api/v1/me', { headers: { Authorization: basic(rateUser.username, 'demo'), ...forwarded } });
  assert.equal(blocked.status, 401, 'correct credentials stay blocked during the backoff window');

  const recorded = db.get("SELECT COUNT(*) n FROM login_attempts WHERE lower(username) = lower(?)", rateUser.username).n;
  assert.ok(recorded <= 8, `attempt rows are bounded by the configured limit (got ${recorded})`);

  db.run("INSERT INTO login_attempts(username, ip, created_at) VALUES(?,?,?)", rateUser.username, '203.0.113.98', '2000-01-01T00:00:00.000Z');
  await api('/api/v1/me', { headers: { Authorization: basic(rateUser.username, 'wrong'), 'X-Forwarded-For': '203.0.113.98' } });
  assert.equal(db.get("SELECT id FROM login_attempts WHERE ip = '203.0.113.98'"), null, 'attempts older than the window are pruned');
  db.run("DELETE FROM login_attempts WHERE lower(username) = lower(?)", rateUser.username);
});

/* ------------------------------------------------------------------ SEC-010 */
test('SEC-010: session tokens are hashed at rest and idle sessions expire', async () => {
  const cookie = await loginAs(admin.username, 'admin-test-pass');
  const raw = sessionToken(cookie);
  assert.ok(raw);
  const hash = tokenHash(raw);

  assert.equal(db.get('SELECT token FROM sessions WHERE token = ?', raw), null, 'the raw cookie token is not stored');
  const row = db.get('SELECT * FROM sessions WHERE token_hash = ?', hash);
  assert.ok(row, 'the session resolves through its token hash');
  assert.equal(row.token, hash);
  assert.ok(row.last_seen);

  // The stored hash must not itself be usable as a bearer cookie (DB dump).
  const hashAsCookie = await fetch(base + '/admin', { headers: { Cookie: `OA_SESSION=${row.token}` }, redirect: 'manual' });
  assert.equal(hashAsCookie.status, 302, 'a stored hash is not accepted as a session token');

  // A pre-migration row (raw token, no token_hash) is transparently upgraded.
  const legacy = `legacy-${crypto.randomBytes(12).toString('hex')}`;
  db.run(`INSERT INTO sessions(token, user_id, csrf, ip, ua, created_at, expires_at, support, support_token)
          VALUES(?,?,?,?,?,?,?,?,?)`,
  legacy, admin.id, crypto.randomBytes(12).toString('hex'), '127.0.0.1', 'legacy-test', ts,
  new Date(Date.now() + 3600_000).toISOString(), 0, null);
  const upgradedRequest = await fetch(base + '/admin', { headers: { Cookie: `OA_SESSION=${legacy}` }, redirect: 'manual' });
  assert.equal(upgradedRequest.status, 200, 'an existing raw-token session keeps working');
  const upgraded = db.get('SELECT * FROM sessions WHERE token_hash = ?', tokenHash(legacy));
  assert.ok(upgraded, 'the legacy row was migrated to a hash');
  assert.equal(upgraded.token, tokenHash(legacy));

  // Idle timeout: a fresh absolute expiry is irrelevant when last_seen is old.
  const idleCookie = await loginAs(admin.username, 'admin-test-pass');
  const idleRaw = sessionToken(idleCookie);
  const idleHash = tokenHash(idleRaw);
  db.run('UPDATE sessions SET last_seen = ? WHERE token_hash = ?', new Date(Date.now() - 3 * 3600_000).toISOString(), idleHash);
  const idleResponse = await fetch(base + '/admin', { headers: { Cookie: `OA_SESSION=${idleRaw}` }, redirect: 'manual' });
  assert.equal(idleResponse.status, 302);
  assert.match(idleResponse.headers.get('location') || '', /\/login/);
  assert.equal(db.get('SELECT token FROM sessions WHERE token_hash = ?', idleHash), null, 'idle session row is removed');
});

/* ------------------------------------------------------------------ SEC-019 */
test('SEC-019: MCP tools enforce Admin/Reseller-A/Reseller-B/User-A/User-B scope', async () => {
  const keys = {
    admin: apikeys.createKey(admin.id, { name: 'mcp-admin', scopes: ['read'] }),
    resellerA: apikeys.createKey(resellerA.id, { name: 'mcp-resa', scopes: ['read'] }),
    resellerB: apikeys.createKey(resellerB.id, { name: 'mcp-resb', scopes: ['read'] }),
    userA: apikeys.createKey(userA.id, { name: 'mcp-usera', scopes: ['read'] }),
    userB: apikeys.createKey(userB.id, { name: 'mcp-userb', scopes: ['read'] }),
  };
  for (const key of Object.values(keys)) assert.equal(key.ok, true);

  const adminDomains = (await mcp(keys.admin.secret, 'list_domains')).value;
  assert.ok(adminDomains.some((domain) => domain.name === domainA.name));
  assert.ok(adminDomains.some((domain) => domain.name === domainB.name));
  assert.equal((await mcp(keys.admin.secret, 'get_health')).isError, false);
  assert.equal((await mcp(keys.admin.secret, 'get_mail_queue')).isError, false);
  assert.equal((await mcp(keys.admin.secret, 'get_mail_overview')).isError, false);

  const scopeMatrix = [
    [keys.resellerA, domainA.name, domainB.name, 'usera', 'userb'],
    [keys.resellerB, domainB.name, domainA.name, 'userb', 'usera'],
    [keys.userA, domainA.name, domainB.name, 'usera', 'userb'],
    [keys.userB, domainB.name, domainA.name, 'userb', 'usera'],
  ];
  for (const [key, ownDomain, foreignDomain, ownMailbox, foreignMailbox] of scopeMatrix) {
    const domains = (await mcp(key.secret, 'list_domains')).value.map((domain) => domain.name);
    assert.ok(domains.includes(ownDomain), `${key.ok ? '' : ''}owns ${ownDomain}`);
    assert.ok(!domains.includes(foreignDomain), `does not see ${foreignDomain}`);

    const mailboxes = (await mcp(key.secret, 'list_mailboxes')).value;
    assert.ok(mailboxes.some((mailbox) => mailbox.domain === ownDomain && mailbox.local_part === ownMailbox));
    assert.ok(!mailboxes.some((mailbox) => mailbox.domain === foreignDomain), 'no foreign mailboxes');

    const databases = (await mcp(key.secret, 'list_databases')).value.map((row) => row.db_name);
    assert.ok(databases.includes(ownMailbox === 'usera' ? 'seca_db' : 'secb_db'));
    assert.ok(!databases.includes(ownMailbox === 'usera' ? 'secb_db' : 'seca_db'));

    const backups = (await mcp(key.secret, 'list_backups')).value.map((row) => row.filename);
    assert.ok(backups.includes(ownMailbox === 'usera' ? backupA.filename : backupB.filename));
    assert.ok(!backups.includes(ownMailbox === 'usera' ? backupB.filename : backupA.filename));

    const search = (await mcp(key.secret, 'search_records', { query: 'sec.example.test' })).value;
    assert.ok(search.domains.includes(ownDomain));
    assert.ok(!search.domains.includes(foreignDomain));
    assert.ok(search.mailboxes.some((mailbox) => mailbox.includes(ownMailbox)));
    assert.ok(!search.mailboxes.some((mailbox) => mailbox.includes(foreignMailbox)));

    assert.equal((await mcp(key.secret, 'get_health')).isError, true, 'health is admin-only');
    assert.equal((await mcp(key.secret, 'get_mail_queue')).isError, true, 'mail queue is admin-only');
    assert.equal((await mcp(key.secret, 'get_mail_overview')).isError, true, 'mail overview is admin-only');
    assert.equal((await mcp(key.secret, 'get_settings')).isError, true, 'global settings are admin-only');
    assert.equal((await mcp(key.secret, 'list_users')).isError, true, 'user enumeration is admin-only');
    const tools = await mcpList(key.secret);
    assert.ok(!tools.includes('get_health') && !tools.includes('get_mail_queue'), 'admin tools are hidden from tools/list');
  }
});

/* ------------------------------------------------------------------ SEC-016 */
test('SEC-016: public and non-admin endpoints omit global topology/counts', async () => {
  const health = await fetch(base + '/healthz');
  const healthJson = await health.json();
  assert.equal(health.status, 200);
  assert.equal(healthJson.ok, true);
  assert.equal('uptime' in healthJson, false, 'uptime is no longer public');
  assert.equal('counts' in healthJson, false);

  const publicPing = await api('/api/v1/ping');
  assert.equal(publicPing.status, 200);
  assert.equal(publicPing.json.version, undefined, 'unauthenticated ping does not reveal the version');

  const adminPing = await api('/api/v1/ping', { actor: admin });
  assert.equal(adminPing.status, 200);
  assert.match(adminPing.json.version, /^\d+\.\d+\.\d+/);

  for (const actor of [resellerA, userA]) {
    const system = await api('/api/v1/system', { actor });
    assert.equal(system.status, 200);
    assert.equal(system.json.counts, undefined, 'non-admin system response has no global counts');
    assert.equal(system.json.server, undefined, 'non-admin system response has no host topology');
    assert.equal(system.json.node, undefined);
    assert.equal(system.json.platform, undefined);
  }
  const adminSystem = await api('/api/v1/system', { actor: admin });
  assert.ok(adminSystem.json.counts && adminSystem.json.server && adminSystem.json.node);

  assert.equal((await api('/api/v1/webserver', { actor: userA })).status, 403);
  assert.equal((await api('/api/v1/webserver', { actor: resellerA })).status, 403);
  assert.equal((await api('/api/v1/webserver', { actor: admin })).status, 200);
});

/* ------------------------------------------------------------------ SEC-001 */
test('SEC-001: object endpoints use the shared tenant scope (negative matrix)', async () => {
  const domainMatrix = [
    [admin, [domainA.name, domainB.name]],
    [resellerA, [domainA.name]],
    [resellerB, [domainB.name]],
    [userA, [domainA.name]],
    [userB, [domainB.name]],
  ];
  for (const [actor, expected] of domainMatrix) {
    const result = await api('/api/v1/domains', { actor });
    assert.equal(result.status, 200);
    const names = result.json.domains.map((domain) => domain.name);
    for (const name of expected) assert.ok(names.includes(name), `${actor.username} sees ${name}`);
    for (const foreign of [domainA.name, domainB.name].filter((name) => !expected.includes(name))) {
      assert.ok(!names.includes(foreign), `${actor.username} must not see ${foreign}`);
    }
  }

  // DNS: read and write are both scoped.
  assert.equal((await api(`/api/v1/dns/${domainB.name}`, { actor: resellerA })).status, 404);
  const dnsWrite = await api(`/api/v1/dns/${domainB.name}`, { actor: resellerA, method: 'POST', body: { name: 'evil', type: 'A', value: '203.0.113.9' } });
  assert.equal(dnsWrite.status, 404);
  assert.equal(db.get('SELECT id FROM dns_records WHERE value = ?', '203.0.113.9'), null);
  assert.equal((await api(`/api/v1/dns/${domainA.name}`, { actor: resellerA })).status, 200);

  // Mailboxes: listing, creation and deletion.
  const emailA = await api('/api/v1/email', { actor: resellerA });
  assert.ok(emailA.json.email.some((mailbox) => mailbox.domain === domainA.name));
  assert.ok(!emailA.json.email.some((mailbox) => mailbox.domain === domainB.name));
  assert.equal((await api('/api/v1/email', { actor: resellerA, method: 'POST', body: { domain: domainB.name, local_part: 'evil', password: 'long-enough' } })).status, 400);
  assert.equal((await api(`/api/v1/email/userb@${domainB.name}`, { actor: resellerA, method: 'DELETE' })).status, 404);
  assert.ok(db.get('SELECT id FROM email_accounts WHERE domain = ? AND local_part = ?', domainB.name, 'userb'));

  // Databases and users.
  const databases = await api('/api/v1/databases', { actor: resellerA });
  assert.ok(databases.json.databases.some((database) => database.db_name === 'seca_db'));
  assert.ok(!databases.json.databases.some((database) => database.db_name === 'secb_db'));
  assert.equal((await api('/api/v1/users', { actor: userA })).status, 403);
  const usersA = await api('/api/v1/users', { actor: resellerA });
  assert.deepEqual(usersA.json.users.map((user) => user.username), ['seca-user']);
  assert.equal((await api('/api/v1/users', { actor: resellerB })).json.users.some((user) => user.username === 'seca-user'), false);

  // Backups: ownership-checked downloads.
  const ownBackup = await api(`/api/v1/backups/${backupA.id}/download`, { actor: resellerA });
  assert.equal(ownBackup.status, 200);
  assert.equal(ownBackup.text, backupA.body);
  assert.equal((await api(`/api/v1/backups/${backupB.id}/download`, { actor: resellerA })).status, 404);
  assert.equal((await api(`/api/v1/backups/${backupA.id}/download`, { actor: userB })).status, 404);

  // Domain deletion stays scoped too.
  assert.equal((await api(`/api/v1/domains/${domainB.name}`, { actor: resellerA, method: 'DELETE' })).status, 404);
  assert.ok(db.get('SELECT id FROM domains WHERE name = ?', domainB.name));

  // Legacy CMD mutations must not delete foreign objects.
  const cmd = async (query, actor) => api(`/${query}`, { actor });
  const popDelete = await cmd(`CMD_API_POP?action=delete&domain=${domainB.name}&user=userb`, resellerA);
  assert.match(popDelete.text, /^error=1/);
  assert.ok(db.get('SELECT id FROM email_accounts WHERE domain = ? AND local_part = ?', domainB.name, 'userb'));

  const dbDelete = await cmd('CMD_API_DATABASES?action=delete&name=secb_db', resellerA);
  assert.match(dbDelete.text, /^error=1/);
  assert.ok(db.get('SELECT id FROM databases WHERE db_name = ?', 'secb_db'));

  const forwarderDelete = await cmd(`CMD_API_EMAIL_FORWARDER?action=delete&domain=${domainB.name}&source=secb-fwd`, resellerA);
  assert.match(forwarderDelete.text, /^error=1/);
  assert.ok(db.get('SELECT id FROM email_forwarders WHERE domain = ? AND source = ?', domainB.name, 'secb-fwd'));

  const autoDelete = await cmd(`CMD_API_EMAIL_AUTORESPONDER?action=delete&email=secb-auto@${domainB.name}`, resellerA);
  assert.match(autoDelete.text, /^error=1/);
  assert.ok(db.get('SELECT id FROM autoresponders WHERE email = ?', `secb-auto@${domainB.name}`));

  const vacationDelete = await cmd(`CMD_API_EMAIL_VACATION?action=delete&email=secb-vacation@${domainB.name}`, resellerA);
  assert.match(vacationDelete.text, /^error=1/);
  assert.ok(db.get('SELECT id FROM vacation WHERE email = ?', `secb-vacation@${domainB.name}`));

  const ftpDelete = await cmd('CMD_API_FTP?action=delete&user=ftp-secb', resellerA);
  assert.match(ftpDelete.text, /^error=1/);
  assert.ok(db.get('SELECT id FROM ftp_accounts WHERE username = ?', 'ftp-secb'));

  // Scoped read SQL must stay valid for both a reseller and the administrator
  // (the helper switches between a scoped WHERE and the unscoped query).
  for (const query of ['CMD_API_DNS_MX', 'CMD_API_EMAIL_FILTER', 'CMD_API_SPAMASSASSIN', 'CMD_API_DOMAIN_POINTER', 'CMD_API_USER_BACKUP']) {
    const resellerRead = await cmd(query, resellerA);
    assert.match(resellerRead.text, /^error=0/, `${query} must work for a reseller: ${resellerRead.text}`);
    const adminRead = await cmd(query, admin);
    assert.match(adminRead.text, /^error=0/, `${query} must work for an admin: ${adminRead.text}`);
  }
});

/* ----------------------------------------------------------- SEC-012/013 --- */
test('SEC-012/SEC-013: app proxy requires a panel session and HSTS is HTTPS-only', async () => {
  const bag = () => {
    const values = new Map();
    return {
      values,
      setHeader(name, value) { values.set(String(name).toLowerCase(), value); },
      removeHeader(name) { values.delete(String(name).toLowerCase()); },
      getHeader(name) { return values.get(String(name).toLowerCase()); },
    };
  };

  const plain = bag();
  plain.setHeader('X-Powered-By', 'PHP/8.2.35');
  serverMod.securityHeaders(plain, { socket: {}, headers: {} });
  assert.equal(plain.getHeader('strict-transport-security'), undefined, 'no HSTS over plain HTTP');
  assert.equal(plain.getHeader('x-powered-by'), undefined, 'framework fingerprint header is removed');

  const secure = bag();
  serverMod.securityHeaders(secure, { socket: { encrypted: true }, headers: {} });
  assert.match(secure.getHeader('strict-transport-security'), /max-age=31536000/);

  const proxied = bag();
  serverMod.securityHeaders(proxied, {
    socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-proto': 'https' },
  });
  assert.match(proxied.getHeader('strict-transport-security'), /max-age=/, 'trusted proxy HTTPS enables HSTS');

  const untrusted = bag();
  serverMod.securityHeaders(untrusted, {
    socket: { remoteAddress: '203.0.113.5' }, headers: { 'x-forwarded-proto': 'https' },
  });
  assert.equal(untrusted.getHeader('strict-transport-security'), undefined, 'untrusted forwarded proto is ignored');

  const health = await fetch(base + '/healthz');
  assert.equal(health.headers.get('strict-transport-security'), null, 'HTTP responses do not send HSTS');

  const php = await fetch(base + '/phpmyadmin', { redirect: 'manual' });
  assert.equal(php.status, 302);
  assert.match(php.headers.get('location') || '', /^\/login\?next=/);
  const roundcube = await fetch(base + '/roundcube/', { redirect: 'manual' });
  assert.equal(roundcube.status, 302);
  assert.match(roundcube.headers.get('location') || '', /^\/login\?next=/);
});

/* ------------------------------------------------- SEC-002 integration ---- */
test('SEC-002: API file upload/download cannot follow links outside the tenant home', async () => {
  const home = path.join(dataDir, 'homes', userA.username);
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openadmin-outside-'));
  const outsideFile = path.join(outsideDir, 'secret.txt');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(outsideFile, 'outside-secret');
  fs.symlinkSync(outsideFile, path.join(home, 'evil-file'));
  fs.symlinkSync(outsideDir, path.join(home, 'evil-dir'));

  const upload = await api('/api/v1/files/upload', {
    actor: userA, method: 'POST',
    body: { path: `/home/${userA.username}`, name: 'evil-file', data: Buffer.from('overwritten').toString('base64') },
  });
  assert.equal(upload.status, 403);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside-secret', 'the symlink target was not modified');

  const nestedUpload = await api('/api/v1/files/upload', {
    actor: userA, method: 'POST',
    body: { path: `/home/${userA.username}/evil-dir`, name: 'created.txt', data: Buffer.from('x').toString('base64') },
  });
  assert.equal(nestedUpload.status, 403);
  assert.equal(fs.existsSync(path.join(outsideDir, 'created.txt')), false);

  const download = await api(`/api/v1/files/download?path=${encodeURIComponent(`/home/${userA.username}/evil-file`)}`, { actor: userA });
  assert.equal(download.status, 403);
  assert.doesNotMatch(download.text, /outside-secret/);

  const listing = await api('/api/v1/files', { actor: userA });
  assert.equal(listing.status, 200);
  const link = listing.json.entries.find((entry) => entry.name === 'evil-file');
  assert.ok(link && link.unsafe === true && link.symlink === true);

  const normal = await api('/api/v1/files/upload', {
    actor: userA, method: 'POST',
    body: { path: `/home/${userA.username}`, name: 'normal.txt', data: Buffer.from('normal').toString('base64') },
  });
  assert.equal(normal.status, 200, normal.text);
  assert.equal(fs.readFileSync(path.join(home, 'normal.txt'), 'utf8'), 'normal');

  fs.rmSync(outsideDir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ SEC-018 */
test('SEC-018: logout and switch-skin are POST+CSRF and reject GET', async () => {
  const cookie = await loginAs(userA.username);
  const csrf = csrfFor(cookie);
  const beforeSkin = db.get('SELECT skin FROM users WHERE id = ?', userA.id).skin;

  const getSkin = await fetch(base + '/switch-skin?skin=enhanced', { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(getSkin.status, 405);
  assert.equal(getSkin.headers.get('allow'), 'POST');
  assert.equal(db.get('SELECT skin FROM users WHERE id = ?', userA.id).skin, beforeSkin, 'GET must not mutate the skin');

  const noCsrfSkin = await form('/switch-skin', { skin: 'enhanced' }, cookie);
  assert.equal(noCsrfSkin.status, 403);
  assert.equal(db.get('SELECT skin FROM users WHERE id = ?', userA.id).skin, beforeSkin);

  const switchSkin = await form('/switch-skin', { _csrf: csrf, skin: 'enhanced' }, cookie);
  assert.equal(switchSkin.status, 302);
  assert.equal(db.get('SELECT skin FROM users WHERE id = ?', userA.id).skin, 'enhanced');

  const getLogout = await fetch(base + '/logout', { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(getLogout.status, 405);
  assert.equal(getLogout.headers.get('allow'), 'POST');
  assert.equal((await fetch(base + '/user', { headers: { Cookie: cookie }, redirect: 'manual' })).status, 200, 'GET logout must not destroy the session');

  const noCsrfLogout = await form('/logout', {}, cookie);
  assert.equal(noCsrfLogout.status, 403);
  assert.equal((await fetch(base + '/user', { headers: { Cookie: cookie }, redirect: 'manual' })).status, 200);

  const logout = await form('/logout', { _csrf: csrf }, cookie);
  assert.equal(logout.status, 302);
  assert.equal((await fetch(base + '/user', { headers: { Cookie: cookie }, redirect: 'manual' })).status, 302);
  assert.equal(db.get('SELECT token FROM sessions WHERE token_hash = ?', tokenHash(sessionToken(cookie))), null);
});
