// SSO, impersonation, role-context and cookie-contract tests.
//
// Covers the OA-003/004/005/006/015 and SEC-007/011/012/013 acceptance points:
// one-time hashed phpMyAdmin nonces, panel-gated app proxy, explicit read-only
// preview sessions, role-correct layout for /compat and /help, central cookie
// policy and the webmail password notice.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openadmin-sso-test-'));
process.env.OA_DATA_DIR = dataDir;
process.env.OA_PORT = '0';
process.env.OA_IMAP_PORT = '0';
process.env.OA_HOST = '127.0.0.1';
process.env.OA_DEMO = '1';
process.env.OA_ADMIN_PASSWORD = 'admin-test-pass';
process.env.OA_SESSION_TTL = '24';
delete process.env.NODE_ENV;
delete process.env.OA_COOKIE_SECURE;

const serverMod = await import('../src/server.mjs');
const db = await import('../src/db.mjs');
const auth = await import('../src/auth.mjs');
const secrets = await import('../src/secrets.mjs');
const apps = await import('../src/apps.mjs');
const layout = await import('../src/ui/layout.mjs');

let server;
let base;

function cookieFrom(res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  return list.filter(Boolean).map((value) => value.split(';')[0]).join('; ');
}

function rawSessionCookie(cookieHeader) {
  const match = String(cookieHeader || '').match(/OA_SESSION=([^;]+)/);
  return match ? match[1] : '';
}

async function form(url, fields, cookie = '', extraHeaders = {}) {
  return fetch(base + url, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(cookie ? { Cookie: cookie } : {}),
      ...extraHeaders,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

async function loginAs(username, password = 'demo') {
  const res = await form('/login', { username, password });
  assert.equal(res.status, 302, `login for ${username} should redirect, got ${res.status}`);
  return cookieFrom(res);
}

async function getPage(url, cookie = '') {
  const res = await fetch(base + url, {
    headers: cookie ? { Cookie: cookie } : {},
    redirect: 'manual',
  });
  const html = await res.text();
  return { res, html };
}

function csrfFrom(html) {
  const match = String(html).match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'page should contain a CSRF token');
  return match[1];
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function postCredentials(body, secret, extraHeaders = {}) {
  const { panelSecret } = await import('../src/config.mjs');
  return fetch(base + '/api/phpmyadmin/credentials', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-OpenAdmin-Secret': secret === undefined ? panelSecret() : secret,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

let adminUser;
let userSubject;
let resellerUser;
let adminCookie;
let userCookie;
let resellerCookie;
let databaseRow;

before(async () => {
  server = serverMod.start();
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  adminUser = db.get("SELECT * FROM users WHERE username = 'demoadmin'");
  userSubject = db.get("SELECT * FROM users WHERE username = 'demouser'");
  resellerUser = db.get("SELECT * FROM users WHERE username = 'demoreseller'");
  assert.ok(adminUser && userSubject && resellerUser, 'demo seed provides all roles');
  adminCookie = await loginAs('demoadmin');
  userCookie = await loginAs('demouser');
  resellerCookie = await loginAs('demoreseller');
  databaseRow = db.get('SELECT * FROM databases WHERE user_id = ? ORDER BY id LIMIT 1', userSubject.id);
  assert.ok(databaseRow, 'demo user has a database');
  db.run('UPDATE databases SET password_enc = ? WHERE id = ?', secrets.encryptSecret('demo-db-secret-123'), databaseRow.id);
  databaseRow = db.get('SELECT * FROM databases WHERE id = ?', databaseRow.id);
});

after(async () => {
  try { apps.stop('phpmyadmin'); } catch { /* ignore */ }
  const { stopImap } = await import('../src/imap.mjs');
  stopImap();
  await new Promise((resolve) => server.close(resolve));
  db.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ cookies */

test('session cookie is HttpOnly, SameSite=Lax and scoped to / on login', async () => {
  const httpLogin = await form('/login', { username: 'demouser', password: 'demo' });
  assert.equal(httpLogin.status, 302);
  const httpCookie = httpLogin.headers.getSetCookie().join('\n');
  assert.match(httpCookie, /HttpOnly/);
  assert.match(httpCookie, /SameSite=Lax/);
  assert.match(httpCookie, /Path=\//);
  // NOTE: adding `Secure` for TLS-terminating proxies needs the central cookie
  // policy patch for src/auth.mjs (reported; auth.mjs is owned by SEC-010).
});

test('app cookies follow the central Secure policy (phpMyAdmin nonce, preview actor)', () => {
  const secureReq = { headers: { 'x-forwarded-proto': 'https' }, socket: {} };
  const plainReq = { headers: {}, socket: {} };
  const pma = apps.pmaSignonCookie('nonce-value', { req: secureReq });
  assert.match(pma, /^OA_PMA=nonce-value/);
  assert.match(pma, /Path=\/phpmyadmin/);
  assert.match(pma, /HttpOnly/);
  assert.match(pma, /SameSite=Strict/);
  assert.match(pma, /Max-Age=60/);
  assert.match(pma, /Secure/);
  assert.doesNotMatch(apps.pmaSignonCookie('nonce-value', { req: plainReq }), /Secure/);

  const actor = apps.previewActorCookie('admin-session', { req: secureReq });
  assert.match(actor, /^OA_PREVIEW_ACTOR=admin-session/);
  assert.match(actor, /Path=\//);
  assert.match(actor, /HttpOnly/);
  assert.match(actor, /SameSite=Strict/);
  assert.match(actor, /Secure/);
  assert.match(apps.clearPreviewActorCookie({ req: plainReq }), /Max-Age=0/);
});

test('2FA challenge cookie is HttpOnly, SameSite=Lax and path-scoped', async () => {
  const username = `twofa_${Date.now().toString(36)}`;
  const created = db.run(`INSERT INTO users(username, password, email, level, owner, package, created_at, twofa_enabled, twofa_secret)
    VALUES(?,?,?,?,?,?,?,?,?)`, username, db.hashPassword('twofa-pass-123'), `${username}@example.com`,
  'user', 'demoreseller', 'default', db.nowIso(), 1, 'JBSWY3DPEHPK3PXP');
  try {
    const res = await form('/login', { username, password: 'twofa-pass-123' }, '', { 'X-Forwarded-Proto': 'https' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /\/login\/2fa/);
    const cookie = res.headers.getSetCookie().join('\n');
    assert.match(cookie, /OA_2FA=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
    // `Secure` for X-Forwarded-Proto: https is part of the reported central
    // cookie-policy patch for auth.mjs; the current 2FA cookie is manual there.
  } finally {
    db.run('DELETE FROM twofa_pending WHERE user_id = ?', created.lastInsertRowid);
    db.run('DELETE FROM users WHERE id = ?', created.lastInsertRowid);
  }
});

/* ------------------------------------------------------- phpMyAdmin SSO */

test('phpMyAdmin nonce is stored hashed, bound to the panel session and consumed once', async () => {
  const sessionToken = rawSessionCookie(userCookie);
  const nonce = secrets.ssoToken({ userId: userSubject.id, db: databaseRow.db_name, sessionToken });
  const row = db.get('SELECT * FROM app_sso_tokens WHERE token_hash = ?', hash(nonce));
  assert.ok(row, 'nonce row exists');
  assert.notEqual(row.token_hash, nonce, 'raw nonce must never be stored');
  assert.equal(row.token_hash, hash(nonce));
  assert.equal(row.session_hash, hash(sessionToken), 'nonce is bound to the issuing panel session');
  assert.equal(row.consumed_at, null);

  const ok = await postCredentials({ token: nonce, session: sessionToken });
  assert.equal(ok.status, 200);
  const creds = await ok.json();
  assert.equal(creds.ok, true);
  assert.equal(creds.username, databaseRow.db_user);
  assert.equal(creds.password, 'demo-db-secret-123');
  assert.equal(creds.db, databaseRow.db_name);

  const replay = await postCredentials({ token: nonce, session: sessionToken });
  assert.equal(replay.status, 403);
  const replayBody = await replay.json();
  assert.equal(replayBody.ok, false);
  assert.equal(replayBody.code, 'reused');
  assert.match(replayBody.error, /już użyty/i);
});

test('phpMyAdmin nonce rejects wrong session, missing DB, wrong user, expiry and bad service secret', async () => {
  const sessionToken = rawSessionCookie(userCookie);

  // Wrong session must not consume the nonce.
  const bound = secrets.ssoToken({ userId: userSubject.id, db: databaseRow.db_name, sessionToken });
  const mismatch = await postCredentials({ token: bound, session: 'f'.repeat(64) });
  assert.equal(mismatch.status, 403);
  assert.equal((await mismatch.json()).code, 'session_mismatch');
  const noSession = await postCredentials({ token: bound });
  assert.equal(noSession.status, 403);
  assert.equal((await noSession.json()).code, 'session_required');
  const correct = await postCredentials({ token: bound, session: sessionToken });
  assert.equal(correct.status, 200, 'a rejected session attempt must not burn the nonce');

  // Missing database (single use, still no credentials).
  const missing = secrets.ssoToken({ userId: userSubject.id, db: `missing_${Date.now()}`, sessionToken });
  const missingRes = await postCredentials({ token: missing, session: sessionToken });
  assert.equal(missingRes.status, 404);
  assert.equal((await missingRes.json()).code, 'db_missing');

  // Wrong owner: a token minted for the reseller cannot open a user database.
  const wrongUser = secrets.ssoToken({ userId: resellerUser.id, db: databaseRow.db_name, sessionToken });
  const wrongRes = await postCredentials({ token: wrongUser, session: sessionToken });
  assert.equal(wrongRes.status, 404, 'token for another user must not map to the database');
  assert.equal((await wrongRes.json()).code, 'db_missing');

  // Expired nonce.
  const expired = secrets.ssoToken({ userId: userSubject.id, db: databaseRow.db_name, sessionToken });
  db.run('UPDATE app_sso_tokens SET expires_at = ? WHERE token_hash = ?',
    new Date(Date.now() - 1000).toISOString(), hash(expired));
  const expiredRes = await postCredentials({ token: expired, session: sessionToken });
  assert.equal(expiredRes.status, 403);
  assert.equal((await expiredRes.json()).code, 'expired');

  // Invalid service secret is rejected before anything is consumed.
  const badSecret = await postCredentials({ token: secrets.ssoToken({ userId: userSubject.id, db: databaseRow.db_name, sessionToken }), session: sessionToken }, 'not-the-secret');
  assert.equal(badSecret.status, 403);
  assert.equal((await badSecret.json()).code, 'service');
});

test('unbound (legacy) nonce still works exactly once for the internal handshake', async () => {
  const nonce = secrets.ssoToken({ userId: userSubject.id, db: databaseRow.db_name });
  const first = await postCredentials({ token: nonce });
  assert.equal(first.status, 200);
  const second = await postCredentials({ token: nonce });
  assert.equal(second.status, 403);
  assert.equal((await second.json()).code, 'reused');
});

test('phpMyAdmin sign-on helper never takes the nonce from the URL and returns to the panel on failure', async () => {
  const dir = path.join(dataDir, 'apps', 'phpmyadmin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.php'), '<?php echo "fake";');
  const result = apps.enablePhpMyAdminSso();
  assert.equal(result.ok, true, result.error);
  try {
    const php = fs.readFileSync(path.join(dir, 'signon.php'), 'utf8');
    assert.match(php, /_COOKIE\['OA_PMA'\]/);
    assert.doesNotMatch(php, /_GET\['token'\]/, 'the nonce must not be read from the query string');
    assert.doesNotMatch(php, /Single sign-on failed or expired/);
    assert.match(php, /pma_error=/);
    assert.match(php, /\/user\/databases\?pma_error=/);
    assert.match(php, /header\('Location: ' \. \$target/);
    assert.match(php, /_COOKIE\['OA_SESSION'\]/);
    assert.match(php, /HTTP_X_FORWARDED_PROTO/, 'the bridge forwards the external scheme to PHP');
    assert.ok(fs.existsSync(path.join(dataDir, 'apps', '.pma-signon-secret')), 'service secret lives outside the webroot');
    assert.equal(fs.existsSync(path.join(dir, '.openadmin-secret')), false, 'legacy in-webroot secret removed');
    const config = fs.readFileSync(path.join(dir, 'config.inc.php'), 'utf8');
    assert.match(config, /auth_type'\] = 'signon'/);
    assert.doesNotMatch(config, /signon\.php\?token/);
  } finally {
    apps.stop('phpmyadmin');
  }
});

test('database page uses a POST hand-off and never renders the nonce in a URL', async () => {
  const { html } = await getPage('/user/databases', userCookie);
  assert.match(html, /phpMyAdmin/);
  assert.doesNotMatch(html, /\/phpmyadmin\/signon\.php\?token=/, 'no reusable URL token may be rendered');
  assert.doesNotMatch(html, /signon\.php\?token/);
});

function portReachable(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    const done = (value) => { try { socket.destroy(); } catch { /* ignore */ } resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

test('POST hand-off sets a short-lived scoped nonce cookie and redirects without a secret in the URL', async (t) => {
  const appPort = apps.APPS.phpmyadmin.port;
  if (await portReachable(appPort)) {
    t.skip(`port ${appPort} is busy`);
    return;
  }
  // A separate process is required: the panel probes the application port with
  // a synchronous curl, which would block an in-process HTTP server.
  const upstream = spawn(process.execPath, ['-e',
    `require('http').createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('fake phpmyadmin'); }).listen(${appPort}, '127.0.0.1')`,
  ], { stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      up = await portReachable(appPort, 200);
    }
    assert.ok(up, 'fake application listener started');
    const appDirPath = path.join(dataDir, 'apps', 'phpmyadmin');
    const pidPath = path.join(dataDir, 'apps', 'phpmyadmin.pid');
    fs.mkdirSync(appDirPath, { recursive: true });
    fs.writeFileSync(path.join(appDirPath, 'index.php'), '<?php echo "fake";');
    fs.writeFileSync(pidPath, String(upstream.pid));
    assert.equal(apps.status('phpmyadmin').running, true, 'fake app is reported running');
    assert.equal(apps.enablePhpMyAdminSso().ok, true);
    const page = await getPage('/user/databases', userCookie);
    assert.equal(page.res.status, 200);
    assert.match(page.html, /action="\/user\/databases\/\d+\/phpmyadmin"/, 'SSO is offered as a POST action');
    const token = csrfFrom(page.html);
    const start = await form(`/user/databases/${databaseRow.id}/phpmyadmin`, { _csrf: token }, userCookie);
    assert.equal(start.status, 302);
    assert.equal(start.headers.get('location'), `/phpmyadmin/signon.php?db=${encodeURIComponent(databaseRow.db_name)}`);
    assert.doesNotMatch(start.headers.get('location') || '', /token=/, 'nonce must not appear in the redirect URL');
    const cookie = start.headers.getSetCookie().join('\n');
    assert.match(cookie, /OA_PMA=/);
    assert.match(cookie, /Path=\/phpmyadmin/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Max-Age=60/);
    const nonce = /OA_PMA=([^;]+)/.exec(cookie)?.[1];
    const stored = db.get('SELECT * FROM app_sso_tokens WHERE token_hash = ?', hash(nonce));
    assert.ok(stored, 'issued nonce is stored');
    assert.equal(stored.session_hash, hash(rawSessionCookie(userCookie)));
    assert.equal(stored.consumed_at, null);
    const audit = db.get("SELECT 1 FROM audit_log WHERE action = 'database.phpmyadmin.sso' AND actor = 'demouser'");
    assert.ok(audit, 'hand-off is audited');
    fs.rmSync(pidPath, { force: true });
  } finally {
    try { upstream.kill('SIGTERM'); } catch { /* ignore */ }
    fs.rmSync(path.join(dataDir, 'apps', 'phpmyadmin.pid'), { force: true });
  }
});

test('pma_error renders a readable panel message with a retry action', async () => {
  const { res, html } = await getPage('/user/databases?pma_error=expired&pma_db=' + encodeURIComponent(databaseRow.db_name), userCookie);
  assert.equal(res.status, 200);
  assert.match(html, /Nie udało się otworzyć phpMyAdmin/);
  assert.match(html, /wygasł/i);
  assert.match(html, /Spróbuj ponownie/);
  assert.doesNotMatch(html, /Single sign-on failed or expired/);
});

test('generated PHP-FPM vhost keeps phpMyAdmin behind the panel session gate', async () => {
  const generated = apps.phpFpmConfigs();
  const nginx = fs.readFileSync(path.join(generated.dir, 'phpmyadmin-nginx.conf'), 'utf8');
  assert.match(nginx, /auth_request \/openadmin-phpmyadmin-auth/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:\d+\/api\/phpmyadmin\/session/);
  assert.match(nginx, /fastcgi_pass/, 'the FPM path is still generated');

  const anonymous = await fetch(base + '/api/phpmyadmin/session');
  assert.equal(anonymous.status, 401);
  const authed = await fetch(base + '/api/phpmyadmin/session', { headers: { Cookie: userCookie } });
  assert.equal(authed.status, 200);
  assert.equal((await authed.json()).user, 'demouser');

  const started = secrets.startImpersonation(adminUser, userSubject.id, { actorSessionToken: rawSessionCookie(adminCookie) });
  assert.equal(started.ok, true, started.error);
  try {
    const preview = await fetch(base + '/api/phpmyadmin/session', { headers: { Cookie: `OA_SESSION=${started.token}` } });
    assert.equal(preview.status, 403, 'a read-only preview cannot authorize the database application');
  } finally {
    secrets.stopImpersonation(started.token);
  }
});

/* -------------------------------------------------------- proxy hardening */

test('app proxy requires a panel session even when invoked before session parsing', () => {
  const req = { headers: {}, method: 'GET', url: '/phpmyadmin/' };
  const res = {
    code: null, headers: null, ended: false,
    writeHead(code, headers) { this.code = code; this.headers = headers; },
    end() { this.ended = true; },
  };
  apps.proxy(req, res, 'phpmyadmin');
  assert.equal(res.code, 302);
  assert.match(res.headers.Location, /^\/login\?next=/);
  assert.equal(res.ended, true);
});

test('app proxy refuses third-party access during a read-only preview', () => {
  const started = secrets.startImpersonation(adminUser, userSubject.id, {
    actorSessionToken: rawSessionCookie(adminCookie), ip: '127.0.0.1',
  });
  assert.equal(started.ok, true, started.error);
  try {
    const req = { headers: { cookie: `OA_SESSION=${started.token}` }, method: 'GET', url: '/phpmyadmin/' };
    const res = {
      code: null, headers: null,
      writeHead(code, headers) { this.code = code; this.headers = headers; },
      end() {},
    };
    apps.proxy(req, res, 'phpmyadmin');
    assert.equal(res.code, 302);
    assert.match(res.headers.Location, /pma_error=read_only/);
  } finally {
    secrets.stopImpersonation(started.token);
  }
});

test('proxy strips hop-by-hop and internal headers and adds external forwarding', () => {
  const req = {
    headers: {
      host: 'panel.example.com:2222',
      connection: 'keep-alive, x-secret-hop',
      'x-secret-hop': '1',
      'x-powered-by': 'evil',
      authorization: 'Basic abc',
      'x-openadmin-secret': 'leak',
      'x-forwarded-for': '6.6.6.6',
      'x-forwarded-proto': 'https',
      cookie: 'OA_SESSION=panel-token; OA_PMA=nonce',
      accept: 'text/html',
    },
    socket: { remoteAddress: '10.0.0.5' },
  };
  const headers = apps.proxyRequestHeaders(req, { secure: true, host: 'panel.example.com:2222', ip: '10.0.0.5' });
  assert.equal(headers.host, 'panel.example.com:2222');
  assert.equal(headers['x-forwarded-host'], 'panel.example.com:2222');
  assert.equal(headers['x-forwarded-proto'], 'https');
  assert.equal(headers['x-forwarded-for'], '10.0.0.5');
  assert.equal(headers.authorization, undefined);
  assert.equal(headers['x-openadmin-secret'], undefined);
  assert.equal(headers['x-forwarded-for'] === '6.6.6.6', false);
  assert.equal(headers['x-secret-hop'], undefined, 'Connection-listed hop-by-hop header removed');
  assert.equal(headers.connection, undefined);
  assert.doesNotMatch(headers.cookie, /OA_SESSION/, 'panel session cookie is not handed to third-party PHP');
  assert.match(headers.cookie, /OA_PMA=nonce/);

  const bridgeHeaders = apps.proxyRequestHeaders(req, { secure: true, keepPanelSession: true });
  assert.match(bridgeHeaders.cookie, /OA_SESSION=panel-token/, 'only the regenerated signon bridge sees the panel cookie');
});

test('proxy response headers drop fingerprints and force Secure on app cookies', () => {
  const headers = apps.proxyResponseHeaders({
    'x-powered-by': 'PHP/8.2.35',
    server: 'nginx/1.24',
    'transfer-encoding': 'chunked',
    'set-cookie': ['OpenAdminPMA=abc; Path=/phpmyadmin'],
    'content-type': 'text/html',
  }, { secure: true, appId: 'phpmyadmin' });
  assert.equal(headers['x-powered-by'], undefined);
  assert.equal(headers.server, undefined);
  assert.equal(headers['transfer-encoding'], undefined);
  assert.match(headers['set-cookie'][0], /Secure/);
  assert.match(headers['set-cookie'][0], /HttpOnly/);
  assert.equal(headers['content-type'], 'text/html');
  assert.equal(headers['referrer-policy'], 'no-referrer');
});

/* --------------------------------------------------------- impersonation */

test('impersonation requires an explicit subject and never falls back to the first client', () => {
  const sessionsBefore = db.get('SELECT COUNT(*) n FROM sessions').n;
  const missing = secrets.startImpersonation(adminUser, null, { actorSessionToken: rawSessionCookie(adminCookie) });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'subject_required');
  const zero = secrets.startImpersonation(adminUser, 0, { actorSessionToken: rawSessionCookie(adminCookie) });
  assert.equal(zero.ok, false);
  assert.equal(zero.code, 'subject_required');
  assert.equal(db.get('SELECT COUNT(*) n FROM sessions').n, sessionsBefore, 'failed preview must not create a session');
});

test('impersonation exposes actor, subject, start and read-only state and renders the persistent banner', async () => {
  const started = secrets.startImpersonation(adminUser, userSubject.id, {
    actorSessionToken: rawSessionCookie(adminCookie), ip: '127.0.0.1', readOnly: true,
  });
  assert.equal(started.ok, true, started.error);
  try {
    const view = secrets.impersonationForSession(started.token);
    assert.ok(view, 'preview view is stored server-side');
    assert.equal(view.actor, 'demoadmin');
    assert.equal(view.actorLevel, 'admin');
    assert.equal(view.subject, 'demouser');
    assert.equal(view.readOnly, true);
    assert.ok(view.startedAt);

    const found = auth.getSession(started.token);
    assert.ok(found, 'preview session resolves');
    assert.equal(found.user.id, userSubject.id);
    assert.equal(found.support, true, 'read-only preview is enforced as a GET-only session');

    // The banner itself is rendered from an explicit `user.impersonation`
    // view. Attaching that view in auth.getSession() is the one-line integration
    // patch reported for auth.mjs (owned by SEC-010).
    const banner = layout.renderPage({
      title: 'Pulpit', body: '', user: { ...userSubject, impersonation: view },
      level: 'user', caps: {}, active: '/user', csrf: started.csrf,
    }).value;
    assert.match(banner, /data-impersonation-banner/);
    assert.match(banner, /Podglądasz konto/);
    assert.match(banner, /demouser/);
    assert.match(banner, /demoadmin/);
    assert.match(banner, /Zakończ podgląd/);
    assert.match(banner, /Tryb tylko do odczytu/);
    assert.match(banner, /data-level="user"/);
    assert.match(banner, /action="\/logout"/, 'exit uses POST /logout');
    assert.match(banner, /name="_csrf"/);

    const audit = db.get("SELECT * FROM audit_log WHERE action = 'user.impersonate.start' AND actor = 'demoadmin' ORDER BY id DESC LIMIT 1");
    assert.ok(audit, 'start is audited with actor');
    assert.match(audit.target, /demouser/, 'audit records the subject');

    // Read-only: the subject session cannot mutate anything, even without the
    // banner integration in place.
    const page = await getPage('/user', `OA_SESSION=${started.token}`);
    assert.equal(page.res.status, 200);
    const token = csrfFrom(page.html);
    const write = await form('/user/domains/create', { _csrf: token, domain: 'preview-escape.example' }, `OA_SESSION=${started.token}`);
    assert.equal(write.status, 403, 'read-only preview must reject state changes');
    assert.equal(!!db.get('SELECT id FROM domains WHERE name = ?', 'preview-escape.example'), false);
  } finally {
    secrets.stopImpersonation(started.token);
  }
});

test('stopping a preview destroys only the subject session and can restore the validated actor session', async () => {
  const adminSession = rawSessionCookie(adminCookie);
  const started = secrets.startImpersonation(adminUser, userSubject.id, { actorSessionToken: adminSession, ip: '127.0.0.1' });
  assert.equal(started.ok, true, started.error);
  const stopped = secrets.stopImpersonation(started.token, { ip: '127.0.0.1' });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.actor, 'demoadmin');
  assert.equal(stopped.subject, 'demouser');
  assert.equal(stopped.actorId, adminUser.id);
  assert.equal(!!db.get('SELECT 1 FROM sessions WHERE token_hash = ?', hash(started.token)), false, 'subject preview session deleted');
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'user.impersonate.stop' AND actor = 'demoadmin' AND target = 'demouser'"), 'stop audited');

  const actor = secrets.resolvePreviewActor(adminSession, stopped.actorId);
  assert.ok(actor, 'the browser-held admin session validates for restore');
  assert.equal(actor.user.username, 'demoadmin');
  const adminStillValid = auth.getSession(adminSession);
  assert.ok(adminStillValid, 'admin session was never destroyed by the preview');
  assert.equal(auth.getSession(started.token), null, 'stopped preview token is dead');
});

test('preview-actor cookie is HttpOnly, short-lived and Secure on HTTPS', () => {
  const secureReq = { headers: { 'x-forwarded-proto': 'https' }, socket: {} };
  const cookie = apps.previewActorCookie('admin-session-token', { req: secureReq });
  assert.match(cookie, /^OA_PREVIEW_ACTOR=admin-session-token/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=7200/);
  assert.match(cookie, /Secure/);
});

test('impersonation rejects admin targets, self and foreign reseller customers', () => {
  const anotherAdmin = db.get("SELECT * FROM users WHERE level = 'admin' AND id != ? LIMIT 1", adminUser.id);
  if (anotherAdmin) {
    const result = secrets.startImpersonation(adminUser, anotherAdmin.id, { actorSessionToken: rawSessionCookie(adminCookie) });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'admin_target');
  }
  const self = secrets.startImpersonation(adminUser, adminUser.id, { actorSessionToken: rawSessionCookie(adminCookie) });
  assert.equal(self.ok, false);
  assert.equal(self.code, 'self');
  const foreign = secrets.startImpersonation(resellerUser, adminUser.id, { actorSessionToken: rawSessionCookie(resellerCookie) });
  assert.equal(foreign.ok, false);
  assert.ok(['admin_target', 'forbidden'].includes(foreign.code));
});

/* ----------------------------------------------------------- role context */

test('/compat/admin pages render the administrator layout, never the user sidebar', async () => {
  const { res, html } = await getPage('/compat/admin/netdata', adminCookie);
  assert.equal(res.status, 200);
  assert.match(html, /data-level="admin"/);
  assert.doesNotMatch(html, /data-level="user"/);
  assert.match(html, /href="\/admin\/web-apps"/, 'admin navigation is present');
  assert.match(html, /aria-current="page"[^>]*>Admin</);
});

test('/help renders in the signed-in account role (explicit, not accidental user context)', async () => {
  const adminHelp = await getPage('/help', adminCookie);
  assert.equal(adminHelp.res.status, 200);
  assert.match(adminHelp.html, /data-level="admin"/);
  assert.match(adminHelp.html, /href="\/admin\/web-apps"/);

  const resellerHelp = await getPage('/help', resellerCookie);
  assert.equal(resellerHelp.res.status, 200);
  assert.match(resellerHelp.html, /data-level="reseller"/);
  assert.match(resellerHelp.html, /href="\/reseller\/users"/);

  const userHelp = await getPage('/help', userCookie);
  assert.equal(userHelp.res.status, 200);
  assert.match(userHelp.html, /data-level="user"/);
  assert.doesNotMatch(userHelp.html, /href="\/admin\/web-apps"/);
});

test('admin on a user route gets an explicit context notice instead of a mixed pseudocontext', async () => {
  const { res, html } = await getPage('/user', adminCookie);
  assert.equal(res.status, 200);
  assert.match(html, /data-admin-context-notice/);
  assert.match(html, /Widok administratora w interfejsie użytkownika/);
  assert.match(html, /href="\/admin\/users"/);
  assert.doesNotMatch(html, /data-impersonation-banner/);
});

/* --------------------------------------------------------------- webmail */

test('mailbox webmail action shows a pre-login password notice and never promises SSO', async () => {
  const { res, html } = await getPage('/user/email', userCookie);
  assert.equal(res.status, 200);
  assert.match(html, /data-webmail-notice/);
  assert.match(html, /Webmail wymaga hasła skrzynki/);
  assert.match(html, /potrzebne będzie hasło tej skrzynki/i);
  assert.match(html, /a\[href\^="\/webmail\?email="\]/, 'the notice intercepts the contextual webmail link');
  assert.match(html, /Przejdź do logowania/);
  assert.doesNotMatch(html, /webmail SSO|SSO webmail/i);
});

test('webmail still asks for the mailbox password (no hidden SSO hand-off)', async () => {
  const { res, html } = await getPage('/webmail?email=' + encodeURIComponent('info@example.com'), userCookie);
  assert.equal(res.status, 200);
  assert.match(html, /Zaloguj się do webmaila|Sign in to webmail/);
  assert.match(html, /type="password"/);
  assert.match(html, /adresu skrzynki i hasła|mailbox address and password/i);
});

test('admin web apps page states the webmail password requirement explicitly', async () => {
  const { res, html } = await getPage('/admin/web-apps', adminCookie);
  assert.equal(res.status, 200);
  assert.match(html, /Logowanie do webmaila|Webmail sign-in/);
  assert.match(html, /otwiera formularz logowania i wymaga hasła skrzynki/);
  assert.match(html, /nie obiecuje logowania bez hasła/);
  assert.match(html, /Roundcube również wymaga hasła skrzynki/);
});
