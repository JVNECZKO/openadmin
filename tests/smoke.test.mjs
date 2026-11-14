// OpenAdmin test suite — node:test, no third-party dependencies.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openadmin-test-'));
process.env.OA_DATA_DIR = dataDir;
process.env.OA_PORT = '0';
process.env.OA_HOST = '127.0.0.1';
process.env.OA_DEMO = '1';
process.env.OA_ADMIN_PASSWORD = 'admin-test-pass';
process.env.OA_SESSION_TTL = '2';

const serverMod = await import('../src/server.mjs');
const db = await import('../src/db.mjs');
const auth = await import('../src/auth.mjs');

let server;
let base;

async function form(url, fields, cookie = '') {
  const res = await fetch(base + url, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
  return res;
}

async function loginAs(username, password = 'demo') {
  const res = await form('/login', { username, password });
  assert.equal(res.status, 302, `login for ${username} should redirect`);
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  return setCookie.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
}

function basic(username, password) {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

before(async () => {
  server = serverMod.start();
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  const { stopImap } = await import('../src/imap.mjs');
  stopImap();
  await new Promise((resolve) => server.close(resolve));
  db.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('password hashing is salted and verifiable', () => {
  const a = db.hashPassword('correct horse');
  const b = db.hashPassword('correct horse');
  assert.notEqual(a, b, 'two hashes of the same password must differ');
  assert.equal(db.verifyPassword('correct horse', a), true);
  assert.equal(db.verifyPassword('wrong', a), false);
  assert.equal(db.verifyPassword('correct horse', 'garbage'), false);
});

test('schema creates the expected tables', () => {
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
  for (const t of ['users', 'domains', 'dns_records', 'email_accounts', 'databases', 'tickets', 'audit_log', 'backups', 'packages']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
});

test('demo seed is idempotent', () => {
  const before = db.get('SELECT COUNT(*) n FROM tickets').n;
  db.seedDemo();
  db.seedDemo();
  const afterCount = db.get('SELECT COUNT(*) n FROM tickets').n;
  assert.equal(afterCount, before, 're-seeding must not duplicate rows');
});

test('login page renders', async () => {
  const res = await fetch(base + '/login');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Sign in to your panel/);
  assert.match(html, /demouser/);
});

test('user dashboard requires authentication', async () => {
  const res = await fetch(base + '/user', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /\/login/);
});

test('user can sign in and load the dashboard', async () => {
  const cookie = await loginAs('demouser');
  const res = await fetch(base + '/user', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Pulpit|Dashboard/);
  assert.match(html, /example\.com/);
  assert.match(html, /OpenAdmin/);
});

test('admin pages are forbidden to a user account', async () => {
  const cookie = await loginAs('demouser');
  const res = await fetch(base + '/admin', { headers: { Cookie: cookie } });
  assert.equal(res.status, 403);
  const html = await res.text();
  assert.match(html, /Administrator access required/);
});

test('cross-site form post without a CSRF token is rejected', async () => {
  const cookie = await loginAs('demouser');
  const res = await form('/user/domains/create', { domain: 'csrf-test.example' }, cookie);
  assert.equal(res.status, 403);
  assert.equal(!!db.get('SELECT id FROM domains WHERE name = ?', 'csrf-test.example'), false);
});

test('legacy CMD_API returns DirectAdmin-shaped data', async () => {
  const res = await fetch(base + '/CMD_API_DOMAIN', { headers: { Authorization: basic('demouser', 'demo') } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /x-www-form-urlencoded/);
  const text = await res.text();
  assert.match(text, /^error=0/);
  assert.match(text, /example\.com/);
});

test('legacy CMD_API rejects bad credentials with error=1', async () => {
  const res = await fetch(base + '/CMD_API_DOMAIN', { headers: { Authorization: basic('demouser', 'wrong') } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /error=1/);
});

test('REST API reports the authenticated account', async () => {
  const res = await fetch(base + '/api/v1/me', { headers: { Authorization: basic('demoreseller', 'demo') } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.user.username, 'demoreseller');
  assert.equal(json.user.level, 'reseller');
});

test('REST API creates and deletes a domain', async () => {
  const name = `api-${Date.now()}.example`;
  const created = await fetch(base + '/api/v1/domains', {
    method: 'POST',
    headers: { Authorization: basic('demouser', 'demo'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain: name }),
  });
  assert.equal(created.status, 200);
  const body = await created.json();
  assert.equal(body.ok, true);
  assert.ok(db.get('SELECT id FROM domains WHERE name = ?', name), 'domain persisted');
  const dns = db.get('SELECT COUNT(*) n FROM dns_records WHERE domain_id = ?', body.id);
  assert.ok(dns.n >= 5, 'zone records were created');

  const deleted = await fetch(`${base}/api/v1/domains/${name}`, {
    method: 'DELETE',
    headers: { Authorization: basic('demouser', 'demo') },
  });
  assert.equal(deleted.status, 200);
  assert.equal(db.get('SELECT id FROM domains WHERE name = ?', name), null);
});

test('package limits are enforced for the user API', async () => {
  const user = db.get("SELECT * FROM users WHERE username = 'demouser'");
  const pkg = db.get('SELECT * FROM packages WHERE name = ?', user.package);
  const limits = JSON.parse(pkg.limits);
  const current = db.get('SELECT COUNT(*) n FROM domains WHERE user_id = ?', user.id).n;
  const room = Math.max(0, limits.domains - current);
  for (let i = 0; i < room; i++) {
    db.run(`INSERT INTO domains(user_id, username, name, docroot, status, created_at) VALUES(?,?,?,?,?,?)`,
      user.id, user.username, `quota-${i}.example`, `/home/${user.username}/quota-${i}`, 'active', db.nowIso());
  }
  const res = await fetch(base + '/api/v1/domains', {
    method: 'POST',
    headers: { Authorization: basic('demouser', 'demo'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain: 'over-limit.example' }),
  });
  assert.equal(res.status, 400, 'over-quota creation must fail');
  const json = await res.json();
  assert.match(json.error, /limit/i);
  db.run('DELETE FROM domains WHERE name LIKE ?', 'quota-%.example');
});

test('every admin page renders without an error page', async () => {
  const cookie = await loginAs('demoadmin');
  const routes = [
    '/admin', '/admin/system-info', '/admin/services', '/admin/processes', '/admin/logs',
    '/admin/settings', '/admin/license', '/admin/reboot', '/admin/resellers', '/admin/resellers/create',
    '/admin/reseller-packages', '/admin/reseller-statistics', '/admin/users', '/admin/users/create',
    '/admin/user-packages', '/admin/user-statistics', '/admin/users/move', '/admin/ip-manager',
    '/admin/dns', '/admin/nameservers', '/admin/ssl', '/admin/skins', '/admin/plugins',
    '/admin/templates', '/admin/custom-httpd', '/admin/backups', '/admin/tickets', '/admin/messages',
    '/admin/audit-log', '/admin/file-editor', '/admin/cron', '/admin/brute-force',
    '/admin/web-server', '/admin/mariadb', '/admin/web-apps',
    '/reseller', '/reseller/users', '/reseller/packages', '/reseller/statistics', '/reseller/dns',
    '/reseller/ip-manager', '/reseller/tickets', '/reseller/settings', '/reseller/backups',
  ];
  for (const route of routes) {
    const res = await fetch(base + route, { headers: { Cookie: cookie } });
    const html = await res.text();
    assert.equal(res.status, 200, `${route} should render`);
    assert.ok(!/Something went wrong/.test(html), `${route} rendered an error page`);
  }
});

test('every user page renders without an error page', async () => {
  const cookie = await loginAs('demouser');
  const routes = [
    '/user', '/user/statistics', '/user/messages', '/user/domains', '/user/domains/create',
    '/user/subdomains', '/user/dns', '/user/pointers', '/user/redirects', '/user/ssl',
    '/user/wordpress', '/user/email', '/user/email/create', '/user/email/forwarders',
    '/user/email/autoresponders', '/user/email/vacation', '/user/email/catch-all',
    '/user/email/lists', '/user/email/spam', '/user/email/usage', '/user/files', '/user/ftp',
    '/user/ftp/create', '/user/ftp/settings', '/user/backups', '/user/cron', '/user/databases',
    '/user/databases/create', '/user/password', '/user/login-keys', '/user/ssh-keys',
    '/user/tickets', '/user/tickets/create', '/user/php', '/user/error-pages', '/user/htaccess',
    '/user/handlers', '/user/mime-types', '/user/protected-directories', '/user/hotlink-protection',
    '/user/app-installer', '/user/git', '/user/terminal', '/user/system-info',
  ];
  for (const route of routes) {
    const res = await fetch(base + route, { headers: { Cookie: cookie } });
    const html = await res.text();
    assert.equal(res.status, 200, `${route} should render`);
    assert.ok(!/Something went wrong/.test(html), `${route} rendered an error page`);
  }
});

test('admin can switch level without losing access', async () => {
  const cookie = await loginAs('demoadmin');
  for (const route of ['/admin', '/reseller', '/user']) {
    const res = await fetch(base + route, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200, `${route} should be reachable by admin`);
  }
});

test('logout invalidates the session (POST + CSRF only)', async () => {
  const cookie = await loginAs('demouser');
  const page = await (await fetch(base + '/user', { headers: { Cookie: cookie } })).text();
  const token = /name="_csrf" value="([^"]+)"/.exec(page)?.[1];
  assert.ok(token, 'user page must expose a CSRF token');
  const res = await form('/logout', { _csrf: token }, cookie);
  assert.equal(res.status, 302);
  const afterLogout = await fetch(base + '/user', { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(afterLogout.status, 302, 'stale cookie must not grant access');
});

test('capabilities reflect package feature flags', () => {
  const user = db.get("SELECT * FROM users WHERE username = 'demouser'");
  const caps = auth.capabilities(user);
  assert.equal(caps.domains, true);
  assert.equal(caps.ssh, false, 'default package does not include SSH');
  assert.ok(Array.isArray(caps.php));
});

test('openapi document is valid JSON with expected paths', async () => {
  const res = await fetch(base + '/api/v1/openapi.json');
  assert.equal(res.status, 200);
  const doc = await res.json();
  assert.equal(doc.openapi, '3.0.3');
  assert.ok(doc.paths['/domains']);
  assert.ok(doc.paths['/email']);
});

test('health endpoint is liveness-only and does not expose build version', async () => {
  const res = await fetch(base + '/healthz');
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.version, undefined);
});

/* ---------------------------------------------------------------- compat */
test('every DirectAdmin frontend route resolves', async () => {
  const cookie = await loginAs('demoadmin');
  const manifest = JSON.parse(fs.readFileSync(new URL('../src/compat/manifest.json', import.meta.url), 'utf8'));
  const skip = new Set(['/', '/:pathMatch(.*)*', '/dev/playground']);
  const failures = [];
  for (const route of manifest) {
    const url = route.url;
    if (!url.startsWith('/') || url.includes(':') || skip.has(url)) continue;
    const res = await fetch(base + url, { headers: { Cookie: cookie }, redirect: 'manual' });
    const html = res.status === 200 ? await res.text() : '';
    const okStatus = res.status === 200 || res.status === 302 || (url === '/login/account-disabled' && res.status === 403);
    if (!okStatus || /Something went wrong/.test(html)) failures.push(`${res.status} ${url}`);
  }
  assert.deepEqual(failures, [], `unresolved DirectAdmin routes: ${failures.join(', ')}`);
});

test('all 110 CMD_API names answer with the DirectAdmin envelope', async () => {
  const names = fs.readFileSync(new URL('../docs/directadmin-commands.txt', import.meta.url), 'utf8')
    .split(/\s+/).filter((c) => c.startsWith('CMD_')).map((c) => c.replace('CMD_', 'CMD_API_'));
  assert.equal(names.length, 110);
  let withData = 0;
  for (const name of names) {
    const res = await fetch(`${base}/${name}`, { headers: { Authorization: basic('demoadmin', 'demo') } });
    assert.equal(res.status, 200, `${name} returned ${res.status}`);
    const text = await res.text();
    assert.match(text, /^error=[01]/, `${name} did not return the DA envelope`);
    if (text.startsWith('error=0')) withData++;
  }
  assert.ok(withData >= 95, `only ${withData} commands returned data`);
});

test('web server configurations generate and validate for all four stacks', async () => {
  const ws = await import('../src/webserver.mjs');
  for (const id of ['nginx', 'apache', 'openlitespeed', 'litespeed']) {
    db.setSetting('web_server', id);
    const generated = ws.generateAll(id);
    assert.ok(generated.total > 0, `${id} generated no files`);
    const dir = ws.stagingDir(ws.SERVERS[id]);
    const files = fs.readdirSync(path.join(dir, 'sites')).filter((f) => f.endsWith('.conf'));
    assert.ok(files.length >= 4, `${id} should generate a vhost per domain`);
    const checked = ws.validate(id);
    assert.deepEqual(checked.issues, [], `${id} validation issues: ${checked.issues.join('; ')}`);
    const sample = fs.readFileSync(path.join(dir, 'sites', files[0]), 'utf8');
    if (id === 'nginx') {
      assert.match(sample, /server\s*\{/);
      assert.match(sample, /fastcgi_pass unix:/);
    } else if (id === 'apache') {
      assert.match(sample, /<VirtualHost \*:80>/);
      assert.match(sample, /DocumentRoot/);
    } else {
      assert.match(sample, /docRoot\s+\//);
      assert.match(sample, /vhDomain\s+/);
      assert.match(sample, /scripthandler/);
      assert.match(sample, /lsapi:lsphp/);
    }
  }
  db.setSetting('web_server', 'nginx');
});

test('web server admin page and API report detection state', async () => {
  const cookie = await loginAs('demoadmin');
  const page = await fetch(base + '/admin/web-server', { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  for (const label of ['Nginx', 'Apache HTTP Server', 'OpenLiteSpeed', 'LiteSpeed Enterprise']) {
    assert.match(html, new RegExp(label));
  }
  const api = await fetch(base + '/api/v1/webserver', { headers: { Authorization: basic('demoadmin', 'demo') } });
  assert.equal(api.status, 200);
  const json = await api.json();
  assert.equal(json.ok, true);
  assert.ok(json.servers.nginx);
  assert.ok(json.servers.litespeed);
});


/* --------------------------------------------------------------- webmail */
test('webmail signs in and delivers mail between hosted mailboxes', async () => {
  const login = await fetch(base + '/webmail/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'info@example.com', password: 'demo' }).toString(),
  });
  assert.equal(login.status, 302);
  const cookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get('set-cookie')])
    .filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  assert.match(cookie, /OA_WEBMAIL=/);

  const inbox = await fetch(base + '/webmail', { headers: { Cookie: cookie } });
  assert.equal(inbox.status, 200);
  assert.match(await inbox.text(), /Welcome to OpenAdmin/);

  const compose = await fetch(base + '/webmail?compose=1', { headers: { Cookie: cookie } });
  const html = await compose.text();
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)[1];
  const sent = await fetch(base + '/webmail/send', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, to: 'sales@example.com', subject: 'Test delivery', body: 'Hello from the test suite.' }).toString(),
  });
  assert.equal(sent.status, 302);
  const delivered = db.get("SELECT * FROM mail_messages WHERE mailbox = 'sales@example.com' AND subject = 'Test delivery'");
  assert.ok(delivered, 'message delivered to the recipient mailbox');
  const copy = db.get("SELECT * FROM mail_messages WHERE mailbox = 'info@example.com' AND folder = 'Sent' AND subject = 'Test delivery'");
  assert.ok(copy, 'sender keeps a copy in Sent');
});

test('webmail rejects a wrong mailbox password', async () => {
  const res = await fetch(base + '/webmail/login', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'info@example.com', password: 'wrong-password' }).toString(),
  });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /Invalid mailbox or password/);
});

test('webmail enforces CSRF on send', async () => {
  const login = await fetch(base + '/webmail/login', {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'info@example.com', password: 'demo' }).toString(),
  });
  const cookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get('set-cookie')])
    .filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  const res = await fetch(base + '/webmail/send', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ to: 'sales@example.com', subject: 'csrf', body: 'x' }).toString(),
  });
  assert.equal(res.status, 302);
  assert.equal(db.get("SELECT id FROM mail_messages WHERE subject = 'csrf'"), null);
});

/* --------------------------------------------------------------- mariadb */
test('MariaDB detection and live database lifecycle', async () => {
  const maria = await import('../src/mariadb.mjs');
  const st = maria.status();
  assert.equal(typeof st.connected, 'boolean');
  assert.ok('version' in st);
  if (!st.connected) return; // server not installed: detection is still correct
  const name = `oa_test_${Date.now().toString(36)}`;
  const created = maria.createDatabase(name);
  assert.equal(created.ok, true);
  assert.ok(maria.listDatabases().rows.includes(name), 'database exists on the server');
  const dropped = maria.dropDatabase(name);
  assert.equal(dropped.ok, true);
  assert.ok(!maria.listDatabases().rows.includes(name), 'database removed');
});

/* ------------------------------------------------------------ web apps */
test('bundled app status and fallback pages work', async () => {
  const apps = await import('../src/apps.mjs');
  const all = apps.statusAll();
  assert.ok(all.phpmyadmin);
  assert.ok(all.roundcube);
  for (const st of Object.values(all)) {
    assert.equal(typeof st.installed, 'boolean');
    assert.equal(typeof st.running, 'boolean');
    assert.ok(Array.isArray(st.missingExtensions));
  }
  const cookie = await loginAs('demoadmin');
  const page = await fetch(base + '/admin/web-apps', { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /phpMyAdmin/);
  assert.match(html, /Roundcube/);
  const fallback = await fetch(base + '/phpmyadmin', { headers: { Cookie: cookie } });
  assert.equal(fallback.status, 200);
});

/* ------------------------------------------------------------ P0: backups */
test('backups are real archives that download and restore', async () => {
  const { createUserBackup, inspectArchive, restoreUserBackup } = await import('../src/backups.mjs');
  const { spawnSync } = await import('node:child_process');
  const user = db.get("SELECT * FROM users WHERE username = 'demouser'");
  const home = path.join(dataDir, 'homes', 'demouser');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'restore-probe.txt'), 'before');
  const backup = createUserBackup(user, 'full');
  assert.ok(fs.existsSync(path.join(dataDir, 'backups', backup.filename)), 'archive exists');
  const inspected = inspectArchive(backup.filename);
  assert.equal(inspected.ok, true);
  assert.ok(inspected.entries.some((e) => e.startsWith('homes/demouser')), 'archive contains the home');
  assert.ok(!inspected.entries.includes('openadmin.db'), 'user archive does not leak the panel database');
  assert.ok(inspected.entries.includes('openadmin-backup.json'), 'manifest present');
  const manifest = JSON.parse(spawnSync('tar', ['-xzf', path.join(dataDir, 'backups', backup.filename), '-O', 'openadmin-backup.json']).stdout);
  assert.equal(manifest.username, 'demouser');
  assert.equal(manifest.kind, 'full');

  const res = await fetch(`${base}/api/v1/backups/${backup.id}/download`, { headers: { Authorization: basic('demouser', 'demo') } });
  assert.equal(res.status, 200);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.ok(bytes.length > 500, 'download returns the archive');
  assert.equal(bytes[0], 0x1f); // gzip magic

  fs.writeFileSync(path.join(home, 'restore-probe.txt'), 'changed');
  const restored = restoreUserBackup(user, backup.filename);
  assert.equal(restored.ok, true);
  assert.equal(fs.readFileSync(path.join(home, 'restore-probe.txt'), 'utf8'), 'before');
});

/* ------------------------------------------------------- P0: API mutations */
test('CMD_API mutations create and delete real records', async () => {
  const call = async (q) => (await fetch(`${base}/${q}`, { headers: { Authorization: basic('demouser', 'demo') } })).text();
  const post = async (q) => (await fetch(`${base}/${q}`, { method: 'POST', headers: { Authorization: basic('demouser', 'demo') } })).text();

  assert.match(await call('CMD_API_EMAIL_FORWARDER?action=create&domain=example.com&source=api-fwd&dest=target@example.net'), /error=0/);
  assert.ok(db.get("SELECT * FROM email_forwarders WHERE source = 'api-fwd'"), 'forwarder stored');
  assert.match(await call('CMD_API_EMAIL_FORWARDER'), /api-fwd/);
  assert.match(await call('CMD_API_EMAIL_FORWARDER?action=delete&domain=example.com&source=api-fwd'), /error=0/);

  assert.match(await call('CMD_API_FTP?action=create&user=apiftp&passwd=secret-pass-123'), /error=0/);
  assert.ok(db.get("SELECT * FROM ftp_accounts WHERE username = 'demouser_apiftp'"), 'FTP account stored');

  assert.match(await post('CMD_API_CRON_JOBS?action=create&command=/bin/true&minute=5'), /error=0/);
  assert.ok(db.get("SELECT * FROM cron_jobs WHERE command = '/bin/true'"), 'cron job stored');

  assert.match(await call('CMD_API_SUBDOMAIN?action=create&domain=example.com&name=api-sub'), /error=0/);
  assert.ok(db.get("SELECT * FROM subdomains WHERE name = 'api-sub'"), 'subdomain stored');

  assert.match(await call('CMD_API_REDIRECT?action=create&domain=example.com&from=/api-old&to=https://example.com/new'), /error=0/);
  assert.ok(db.get("SELECT * FROM redirects WHERE from_path = '/api-old'"), 'redirect stored');
});

/* ---------------------------------------------------------------- P0: SSL */
test('self-signed certificates are generated and enter the vhosts', async () => {
  const ssl = await import('../src/ssl.mjs');
  const ws = await import('../src/webserver.mjs');
  const domain = `ssl-${Date.now()}.example`;
  const result = ssl.generateSelfSigned(domain, 30);
  assert.equal(result.ok, true, result.error || 'generated');
  assert.ok(fs.existsSync(result.paths.cert) && fs.existsSync(result.paths.key));
  const cert = fs.readFileSync(result.paths.cert, 'utf8');
  assert.match(cert, /BEGIN CERTIFICATE/);
  const info = ssl.certInfo(result.paths.cert);
  assert.ok(new Date(info.expiresAt) > new Date());
  const nginx = ws.renderNginx({ name: domain, username: 'demouser' });
  assert.match(nginx, /listen 443 ssl/);
  assert.match(nginx, /ssl_certificate\s+\//);
  const apache = ws.renderApache({ name: domain, username: 'demouser' });
  assert.match(apache, /\*:443/);
});

/* ------------------------------------------------------- P1: DNS and cron */
test('DNS zones are generated and contain new records', async () => {
  const dns = await import('../src/dns.mjs');
  const created = await fetch(base + '/api/v1/dns/example.com', {
    method: 'POST', headers: { Authorization: basic('demoadmin', 'demo'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'zone-test', type: 'A', value: '192.0.2.55' }),
  });
  assert.equal(created.status, 200);
  const result = dns.rebuildZone('example.com');
  assert.equal(result.ok, true, (result.check && result.check.output) || 'zone valid');
  const zone = fs.readFileSync(dns.zonePath('example.com'), 'utf8');
  assert.match(zone, /zone-test/);
  assert.match(zone, /IN\s+SOA/);
  assert.match(zone, /IN\s+NS/);
});

test('cron jobs rebuild a real crontab file', async () => {
  const cron = await import('../src/cron.mjs');
  const res = await fetch(`${base}/CMD_API_CRON_JOBS?action=create&command=/usr/bin/true&minute=15`, {
    headers: { Authorization: basic('demouser', 'demo') },
  });
  assert.match(await res.text(), /error=0/);
  const text = fs.readFileSync(cron.cronPath('demouser'), 'utf8');
  assert.match(text, /15 \* \* \* \* \/usr\/bin\/true/);
});

/* ------------------------------------------------- P1: users/FTP/SSH/mail */
test('FTP accounts and SSH keys land in provider state', async () => {
  const res = await fetch(`${base}/CMD_API_FTP?action=create&user=probeftp&passwd=probe-pass-123&path=/home/demouser`, {
    headers: { Authorization: basic('demouser', 'demo') },
  });
  assert.match(await res.text(), /error=0/);
  const passwd = fs.readFileSync(path.join(dataDir, 'ftp', 'passwd'), 'utf8');
  assert.match(passwd, /demouser_probeftp:\$6\$/);

  const provider = (await import('../src/providers/index.mjs')).systemProvider();
  const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKeyForOpenAdmin test@local';
  const installed = provider.installSshKey('demouser', key);
  assert.equal(installed.ok, true);
  const auth = fs.readFileSync(path.join(dataDir, 'homes', 'demouser', '.ssh', 'authorized_keys'), 'utf8');
  assert.match(auth, /AAAAC3NzaC1lZDI1NTE5/);
});

test('mail provisioning writes Dovecot hashes, Maildirs and aliases', async () => {
  const mail = await import('../src/mail.mjs');
  const result = mail.syncMail();
  assert.ok(result.passwd >= 1);
  const passwd = fs.readFileSync(path.join(dataDir, 'mail', 'passwd'), 'utf8');
  assert.match(passwd, /info@example\.com:\$6\$/);
  assert.match(passwd, /:1000:1000::/);
  const aliases = fs.readFileSync(path.join(dataDir, 'mail', 'aliases'), 'utf8');
  assert.match(aliases, /contact@example\.com: info@example\.com/);
  assert.ok(fs.existsSync(path.join(dataDir, 'homes', 'demouser', 'mail', 'example.com', 'info', 'new')));
});

/* ------------------------------------------------------- P1: vhost extras */
test('vhosts include subdomains, pointers, redirects, WAF and app proxies', async () => {
  const ws = await import('../src/webserver.mjs');
  await fetch(`${base}/CMD_API_SUBDOMAIN?action=create&domain=example.com&name=vhost-sub`, { headers: { Authorization: basic('demouser', 'demo') } });
  await fetch(`${base}/CMD_API_DOMAIN_POINTER?action=create&domain=example.com&alias=alias.example`, { headers: { Authorization: basic('demouser', 'demo') } });
  await fetch(`${base}/CMD_API_REDIRECT?action=create&domain=example.com&from=/go&to=https://example.com/new`, { headers: { Authorization: basic('demouser', 'demo') } });
  db.run(`INSERT INTO hosted_apps(user_id, domain, path_prefix, type, port, command, status, created_at) VALUES(?,?,?,?,?,?,?,?)`,
    db.get("SELECT id FROM users WHERE username='demouser'").id, 'example.com', '/app', 'node', 3055, '/usr/bin/node app.js', 'registered', db.nowIso());
  db.setSetting('web_server', 'nginx');
  ws.generateAll('nginx');
  const nginx = fs.readFileSync(path.join(dataDir, 'webserver', 'nginx', 'sites', 'example.com.conf'), 'utf8');
  assert.match(nginx, /server_name vhost-sub\.example\.com/);
  assert.match(nginx, /server_name alias\.example/);
  assert.match(nginx, /location = \/go \{ return 301 https:\/\/example\.com\/new; \}/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:3055/);
});

/* ------------------------------------------------------------- P2: 2FA */
test('two-factor authentication challenges the login', async () => {
  const twofa = await import('../src/twofa.mjs');
  const secret = twofa.generateSecret();
  db.run("UPDATE users SET twofa_secret = ?, twofa_enabled = 1 WHERE username = 'demouser'", secret);
  try {
    const first = await fetch(base + '/login', {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'demouser', password: 'demo' }).toString(),
    });
    assert.equal(first.status, 302);
    assert.match(first.headers.get('location'), /\/login\/2fa/);
    const cookie = (first.headers.getSetCookie ? first.headers.getSetCookie() : [first.headers.get('set-cookie')])
      .filter(Boolean).map((c) => c.split(';')[0]).join('; ');

    const challenge = await fetch(base + '/login/2fa', { headers: { Cookie: cookie } });
    assert.equal(challenge.status, 200);
    assert.match(await challenge.text(), /Two-factor authentication/);

    const wrong = await fetch(base + '/login/2fa', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: '000000' }).toString(),
    });
    assert.equal(wrong.status, 401);

    const code = twofa.totp(secret);
    const ok = await fetch(base + '/login/2fa', {
      method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code }).toString(),
    });
    assert.equal(ok.status, 302);
    assert.match(ok.headers.get('location'), /\/user/);
  } finally {
    db.run("UPDATE users SET twofa_enabled = 0, twofa_secret = NULL WHERE username = 'demouser'");
  }
});

/* -------------------------------------------------------- P2: plugin hooks */
test('plugin hooks execute with the event payload', async () => {
  const plugins = await import('../src/plugins.mjs');
  const dir = path.join(dataDir, 'plugins', 'probe');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hook.js'), `
let data = '';
process.stdin.on('data', (c) => { data += c; });
process.stdin.on('end', () => {
  const { event, payload } = JSON.parse(data);
  require('fs').appendFileSync(${JSON.stringify(path.join(dir, 'events.log'))}, event + ':' + payload.username + '\\n');
});
`);
  db.run("INSERT INTO plugins(name, title, level, version, enabled, description, created_at) VALUES(?,?,?,?,?,?,?)",
    'probe', 'Probe', 'admin', '1.0.0', 1, 'test', db.nowIso());
  const results = plugins.runHooks('user.create', { username: 'hook-user' });
  const probe = results.find((r) => r.plugin === 'probe');
  assert.ok(probe, 'hook ran');
  assert.equal(probe.ok, true, probe.output);
  const log = fs.readFileSync(path.join(dir, 'events.log'), 'utf8');
  assert.match(log, /user\.create:hook-user/);
});

/* ------------------------------------------------- P2: app hosting / FPM */
test('hosted apps generate systemd units and proxy entries', async () => {
  const hosted = await import('../src/features/hosted-apps.mjs');
  const app = db.get("SELECT * FROM hosted_apps WHERE port = 3055");
  assert.ok(app, 'app row exists');
  const file = hosted.writeUnit(app, 'demouser');
  assert.ok(fs.existsSync(file));
  const unit = fs.readFileSync(file, 'utf8');
  assert.match(unit, /ExecStart=\/usr\/bin\/node app\.js/);
  assert.match(unit, /Environment=PORT=3055/);
  assert.match(unit, /WorkingDirectory=\/home\/demouser/);
});

test('phpMyAdmin FPM configuration is generated', async () => {
  const apps = await import('../src/apps.mjs');
  const result = apps.phpFpmConfigs();
  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(path.join(result.dir, 'phpmyadmin-pool.conf')));
  assert.match(fs.readFileSync(path.join(result.dir, 'phpmyadmin-nginx.conf'), 'utf8'), /fastcgi_pass/);
});

/* --------------------------------------------- P2: applied site settings */
test('MIME, handlers, hotlink, protected dirs and error pages reach the vhosts', async () => {
  const ws = await import('../src/webserver.mjs');
  db.setSetting('user:demouser:mime-types', JSON.stringify([{ key: '.webp', value: 'image/webp' }]));
  db.setSetting('user:demouser:handlers', JSON.stringify([{ key: '.cgi', value: 'cgi-script' }]));
  db.setSetting('hotlink:demouser', JSON.stringify({ 'example.com': 1, _allowed: ['example.org'], _extensions: ['jpg'] }));
  db.setSetting('protected:demouser', JSON.stringify([{ id: 'p1', domain: 'example.com', path: '/members', users: ['alice'] }]));
  db.setSetting('errpage:example.com:404', '<html>not found</html>');
  db.setSetting('httpd:example.com', 'add_header X-Test "1";');
  db.setSetting('web_server', 'nginx');

  const nginx = ws.renderNginx({ name: 'example.com', username: 'demouser' });
  assert.match(nginx, /error_page 404 \/error-404\.html/);
  assert.match(nginx, /auth_basic "Restricted"/);
  assert.match(nginx, /valid_referers/);
  assert.match(nginx, /image\/webp webp/);
  assert.match(nginx, /add_header X-Test/);

  const apache = ws.renderApache({ name: 'example.com', username: 'demouser' });
  assert.match(apache, /ErrorDocument 404/);
  assert.match(apache, /AddType image\/webp \.webp/);
  assert.match(apache, /AddHandler cgi-script \.cgi/);
  assert.match(apache, /AuthType Basic/);
  assert.match(apache, /SetEnvIfNoCase Referer/);
});

/* ------------------------------------------------------ P0: usage metering */
test('usage collection records real disk usage and a timestamp', async () => {
  const usage = await import('../src/usage.mjs');
  const result = usage.collectUsage();
  assert.equal(result.ok, true);
  const today = new Date().toISOString().slice(0, 10);
  const row = db.get("SELECT * FROM usage_daily WHERE day = ? AND username = 'demouser'", today);
  assert.ok(row, 'a usage row exists for today');
  assert.ok(row.disk_mb > 0, 'disk usage measured from the home');
  assert.ok(usage.usageMeta().lastCollected);
});

/* --------------------------------------------------------- P2: API SSL */
test('CMD_API_SSL issues a real self-signed certificate', async () => {
  const domain = `api-ssl-${Date.now()}.example`;
  db.run(`INSERT INTO domains(user_id, username, name, docroot, php_version, ssl, status, is_main, ip, created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`, db.get("SELECT id FROM users WHERE username='demouser'").id, 'demouser', domain,
    `/home/demouser/domains/${domain}/public_html`, '8.3', 1, 'active', 0, '127.0.0.1', db.nowIso());
  const text = await (await fetch(`${base}/CMD_API_SSL?action=selfsigned&domain=${domain}&days=30`, {
    headers: { Authorization: basic('demouser', 'demo') },
  })).text();
  assert.match(text, /error=0/);
  const cert = db.get("SELECT * FROM ssl_certs WHERE domain = ? AND status = 'active'", domain);
  assert.ok(cert && cert.cert && cert.cert.includes('BEGIN CERTIFICATE'));
});

/* ------------------------------------------------ continuation: templates */
test('template overrides are applied to pages and the login screen', async () => {
  db.setSetting('template:header.html', '<div id="tpl-header">Custom header</div>');
  db.setSetting('template:login.html', '<div id="tpl-login">Support: help@example.com</div>');
  const cookie = await loginAs('demouser');
  const page = await fetch(base + '/user', { headers: { Cookie: cookie } });
  assert.match(await page.text(), /Custom header/);
  const login = await fetch(base + '/login');
  assert.match(await login.text(), /Support: help@example.com/);
  db.setSetting('template:header.html', '');
  db.setSetting('template:login.html', '');
});

/* --------------------------------------------- continuation: API aliases */
test('CMD_API_EMAIL_POP, DOMAIN and DB aliases mutate state', async () => {
  const call = async (q) => (await fetch(`${base}/${q}`, { headers: { Authorization: basic('demouser', 'demo') } })).text();

  assert.match(await call('CMD_API_EMAIL_POP?action=create&domain=example.com&user=alias-pop&passwd=alias-pass-123'), /error=0/);
  assert.ok(db.get("SELECT * FROM email_accounts WHERE local_part = 'alias-pop'"), 'mailbox created through alias');
  assert.match(await call('CMD_API_EMAIL_POP?action=delete&domain=example.com&user=alias-pop'), /error=0/);

  const domain = `alias-${Date.now()}.example`;
  assert.match(await call(`CMD_API_DOMAIN?action=create&domain=${domain}`), /error=0/);
  assert.ok(db.get('SELECT * FROM domains WHERE name = ?', domain), 'domain created through alias');
  assert.match(await call(`CMD_API_DOMAIN?action=delete&domain=${domain}`), /error=0/);
  assert.equal(db.get('SELECT * FROM domains WHERE name = ?', domain), null);

  const maria = await import('../src/mariadb.mjs');
  if (maria.status().connected) {
    const dbName = `aliasdb_${Date.now().toString(36)}`;
    assert.match(await call(`CMD_API_DB?action=create&name=${dbName}&passwd=alias-db-pass-123`), /error=0/);
    assert.ok(maria.listDatabases().rows.includes(`demouser_${dbName}`), 'database created on MariaDB');
    assert.match(await call(`CMD_API_DB?action=delete&name=demouser_${dbName}`), /error=0/);
    await mariadbCleanup(`demouser_${dbName}`);
  }
});

async function mariadbCleanup(name) {
  try {
    const { spawnSync } = await import('node:child_process');
    spawnSync('mariadb', ['-u', process.env.USER || 'root', '-e', `DROP DATABASE IF EXISTS \`${name}\``]);
  } catch { /* ignore */ }
}

/* -------------------------------------------------- continuation: DNS deploy */
test('DNS deployment writes named.conf stanzas', async () => {
  const dns = await import('../src/dns.mjs');
  const result = dns.deployZones();
  assert.equal(result.ok, true);
  const conf = fs.readFileSync(path.join(dataDir, 'dns', 'named.conf.openadmin'), 'utf8');
  assert.match(conf, /zone "example\.com"/);
  assert.match(conf, /type master/);
});

/* ------------------------------------------------- continuation: webmail drafts */
test('webmail saves drafts, sends them and paginates', async () => {
  const login = await fetch(base + '/webmail/login', {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'info@example.com', password: 'demo' }).toString(),
  });
  const cookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get('set-cookie')])
    .filter(Boolean).map((c) => c.split(';')[0]).join('; ');

  const compose = await fetch(base + '/webmail?compose=1', { headers: { Cookie: cookie } });
  const csrf = (await compose.text()).match(/name="_csrf" value="([^"]+)"/)[1];
  const draft = await fetch(base + '/webmail/draft', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, to: 'sales@example.com', subject: 'Draft subject', body: 'Draft body' }).toString(),
  });
  assert.equal(draft.status, 302);
  const saved = db.get("SELECT * FROM mail_messages WHERE mailbox = 'info@example.com' AND folder = 'Drafts' AND subject = 'Draft subject'");
  assert.ok(saved, 'draft stored');

  const draftsPage = await fetch(base + '/webmail?folder=Drafts', { headers: { Cookie: cookie } });
  assert.match(await draftsPage.text(), /Draft subject/);

  const send = await fetch(base + '/webmail/send', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, draft_id: String(saved.id), to: 'sales@example.com', subject: 'Draft subject', body: 'Draft body' }).toString(),
  });
  assert.equal(send.status, 302);
  assert.equal(db.get('SELECT id FROM mail_messages WHERE id = ?', saved.id), null);
  assert.ok(db.get("SELECT * FROM mail_messages WHERE mailbox = 'sales@example.com' AND subject = 'Draft subject'"));

  for (let i = 0; i < 23; i++) {
    db.run(`INSERT INTO mail_messages(mailbox, uid, folder, from_addr, to_addr, subject, body, seen, size_kb, created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)`, 'info@example.com', 1000 + i, 'INBOX', 'bulk@example.net', 'info@example.com',
      `Bulk message ${i}`, 'body', 1, 1, db.nowIso());
  }
  const second = await fetch(base + '/webmail?page=2', { headers: { Cookie: cookie } });
  const html = await second.text();
  assert.match(html, /Page 2 of/);
});

/* ------------------------------------------------ continuation: app lifecycle */
test('hosted apps start and stop through the provider', async () => {
  const app = db.get("SELECT * FROM hosted_apps WHERE port = 3055");
  assert.ok(app);
  const cookie = await loginAs('demouser');
  const page = await fetch(base + '/user/apps', { headers: { Cookie: cookie } });
  const csrf = (await page.text()).match(/name="_csrf" value="([^"]+)"/)[1];
  const start = await fetch(`${base}/user/apps/${app.id}/start`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  assert.equal(start.status, 302);
  assert.equal(db.get('SELECT status FROM hosted_apps WHERE id = ?', app.id).status, 'running');
  const stop = await fetch(`${base}/user/apps/${app.id}/stop`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  assert.equal(stop.status, 302);
  assert.equal(db.get('SELECT status FROM hosted_apps WHERE id = ?', app.id).status, 'stopped');
});

/* --------------------------------------- continuation: regeneration paths */
test('mailbox API stores a Dovecot hash and domain creation regenerates vhosts', async () => {
  const call = async (q) => (await fetch(`${base}/${q}`, { headers: { Authorization: basic('demouser', 'demo') } })).text();
  const domain = `regen-${Date.now()}.example`;
  db.setSetting('web_server', 'nginx');
  assert.match(await call(`CMD_API_DOMAIN?action=create&domain=${domain}`), /error=0/);
  const vhost = path.join(dataDir, 'webserver', 'nginx', 'sites', `${domain}.conf`);
  assert.ok(fs.existsSync(vhost), 'vhost generated for the new domain');

  assert.match(await call(`CMD_API_EMAIL_POP?action=create&domain=${domain}&user=regenbox&passwd=regen-pass-123`), /error=0/);
  const account = db.get("SELECT * FROM email_accounts WHERE local_part = 'regenbox'");
  assert.ok(account.mail_hash && account.mail_hash.startsWith('$6$'), 'Dovecot hash stored');
  const passwd = fs.readFileSync(path.join(dataDir, 'mail', 'passwd'), 'utf8');
  assert.ok(passwd.includes(`regenbox@${domain}`), 'mailbox present in Dovecot passwd');
  await call(`CMD_API_EMAIL_POP?action=delete&domain=${domain}&user=regenbox`);
  await call(`CMD_API_DOMAIN?action=delete&domain=${domain}`);
});

/* ------------------------------------------------ continuation: SMTP queue */
test('outbound mail is handed to the local MTA and recorded', async () => {
  const mta = await import('../src/mta.mjs');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'mta-bin-'));
  const out = path.join(bin, 'message.eml');
  fs.writeFileSync(path.join(bin, 'sendmail'), `#!/bin/sh\ncat > ${JSON.stringify(out)}\nexit 0\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  const oldBin = process.env.OA_MTA_BIN;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.OA_MTA_BIN = path.join(bin, 'sendmail');
  try {
    assert.equal(mta.findMta(), path.join(bin, 'sendmail'));
    const result = mta.sendMail({ from: 'info@example.com', to: 'outside@example.net', subject: 'SMTP probe', body: 'Hello outside.' });
    assert.equal(result.ok, true, result.output);
    const message = fs.readFileSync(out, 'utf8');
    assert.match(message, /Subject: SMTP probe/);
    assert.match(message, /Hello outside\./);

    const login = await fetch(base + '/webmail/login', {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'info@example.com', password: 'demo' }).toString(),
    });
    const cookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get('set-cookie')])
      .filter(Boolean).map((c) => c.split(';')[0]).join('; ');
    const compose = await (await fetch(base + '/webmail?compose=1', { headers: { Cookie: cookie } })).text();
    const csrf = compose.match(/name="_csrf" value="([^"]+)"/)[1];
    await fetch(base + '/webmail/send', {
      method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, to: 'outside@example.net', subject: 'Queued probe', body: 'body' }).toString(),
    });
    const row = db.get("SELECT * FROM mail_queue WHERE subject = 'Queued probe'");
    assert.ok(row, 'queue row written');
    assert.equal(row.status, 'sent');
    assert.ok(row.sent_at);
  } finally {
    process.env.PATH = oldPath;
    if (oldBin === undefined) delete process.env.OA_MTA_BIN; else process.env.OA_MTA_BIN = oldBin;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

/* --------------------------------------------- continuation: attachments */
test('webmail attachments upload, send and download', async () => {
  const login = await fetch(base + '/webmail/login', {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'info@example.com', password: 'demo' }).toString(),
  });
  const cookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get('set-cookie')])
    .filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  const compose = await (await fetch(base + '/webmail?compose=1', { headers: { Cookie: cookie } })).text();
  const csrf = compose.match(/name="_csrf" value="([^"]+)"/)[1];

  const upload = await fetch(base + '/webmail/attach', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ _csrf: csrf, name: 'hello.txt', data: Buffer.from('attachment body').toString('base64') }),
  });
  assert.equal(upload.status, 200);
  const { token } = await upload.json();
  assert.ok(token);

  const send = await fetch(base + '/webmail/send', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, to: 'sales@example.com', subject: 'With attachment', body: 'see file', 'attachment[]': token }).toString(),
  });
  assert.equal(send.status, 302);
  const attachment = db.get(`SELECT a.* FROM mail_attachments a JOIN mail_messages m ON m.id = a.message_id
                             WHERE m.mailbox = 'sales@example.com' AND m.subject = 'With attachment'`);
  assert.ok(attachment, 'attachment linked to recipient message');

  const salesLogin = await fetch(base + '/webmail/login', {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'sales@example.com', password: 'demo' }).toString(),
  });
  const salesCookie = (salesLogin.headers.getSetCookie ? salesLogin.headers.getSetCookie() : [salesLogin.headers.get('set-cookie')])
    .filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  const download = await fetch(`${base}/webmail/attachment/${attachment.id}`, { headers: { Cookie: salesCookie } });
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'attachment body');
});

/* -------------------------------------------------- continuation: quotas */
test('disk quotas block uploads and oversized accounts are suspended', async () => {
  const quota = await import('../src/quota.mjs');
  db.run('INSERT OR IGNORE INTO packages(name, owner, type, limits, created_at) VALUES(?,?,?,?,?)',
    'tiny-quota', null, 'user', JSON.stringify({ domains: 1, emails: 1, disk_mb: 1, bandwidth_mb: 1 }), db.nowIso());
  const r = db.run(`INSERT INTO users(username, password, email, level, package, created_at, api_enabled)
                    VALUES(?,?,?,?,?,?,1)`, 'quotauser', db.hashPassword('quota-pass-123'), 'quota@example.com', 'user', 'tiny-quota', db.nowIso());
  const user = db.get('SELECT * FROM users WHERE id = ?', r.lastInsertRowid);
  fs.mkdirSync(path.join(dataDir, 'homes', 'quotauser'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'homes', 'quotauser', 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 1));
  const check = quota.checkDisk(user, 0);
  assert.equal(check.ok, false);

  // The upload is rejected while the account is still active.
  const upload = await fetch(base + '/api/v1/files/upload', {
    method: 'POST',
    headers: { Authorization: basic('quotauser', 'quota-pass-123'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/home/quotauser', name: 'more.bin', data: Buffer.alloc(1024 * 1024, 2).toString('base64') }),
  });
  assert.equal(upload.status, 413);

  const enforced = quota.enforceAll();
  const suspended = db.get('SELECT * FROM users WHERE id = ?', user.id);
  assert.equal(suspended.suspended, 1);
  assert.match(suspended.suspended_reason, /Disk quota exceeded/);
  assert.ok(enforced.suspended.some((s) => s.username === 'quotauser'));
  db.run('DELETE FROM users WHERE id = ?', user.id);
  db.run('DELETE FROM packages WHERE name = ?', 'tiny-quota');
});

/* ------------------------------------------------ continuation: phpMyAdmin SSO */
test('phpMyAdmin SSO exchanges a signed token for database credentials', async () => {
  const apps = await import('../src/apps.mjs');
  const secrets = await import('../src/secrets.mjs');
  const { panelSecret } = await import('../src/config.mjs');

  const dir = path.join(dataDir, 'apps', 'phpmyadmin');
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.php'), '<?php echo "fake";');
  const sso = apps.enablePhpMyAdminSso();
  assert.equal(sso.ok, true, sso.error);
  assert.ok(fs.existsSync(path.join(dir, 'signon.php')));
  const config = fs.readFileSync(path.join(dir, 'config.inc.php'), 'utf8');
  assert.match(config, /auth_type'\] = 'signon'/);
  assert.match(config, /SignonSession/);

  // Create a database through the API so its password is stored encrypted.
  const dbName = `sso_${Date.now().toString(36)}`;
  const create = await fetch(`${base}/CMD_API_DB?action=create&name=${dbName}&passwd=sso-pass-12345`, {
    headers: { Authorization: basic('demouser', 'demo') },
  });
  assert.match(await create.text(), /error=0/);
  const row = db.get("SELECT * FROM databases WHERE db_name = ?", `demouser_${dbName}`);
  assert.ok(row.password_enc, 'password encrypted at rest');
  assert.equal(secrets.decryptSecret(row.password_enc), 'sso-pass-12345');

  const token = secrets.ssoToken({ userId: row.user_id, db: row.db_name });
  const exchange = await fetch(base + '/api/phpmyadmin/credentials', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenAdmin-Secret': panelSecret() },
    body: JSON.stringify({ token }),
  });
  assert.equal(exchange.status, 200);
  const creds = await exchange.json();
  assert.equal(creds.ok, true);
  assert.equal(creds.username, row.db_user);
  assert.equal(creds.password, 'sso-pass-12345');

  const denied = await fetch(base + '/api/phpmyadmin/credentials', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenAdmin-Secret': 'wrong' },
    body: JSON.stringify({ token }),
  });
  assert.equal(denied.status, 403);
  apps.stop('phpmyadmin');
  db.run('DELETE FROM databases WHERE db_name = ?', row.db_name);
});

/* --------------------------------------------------- continuation: IMAP */
test('IMAP server logs in, lists, selects, fetches and appends', async () => {
  const net = await import('node:net');
  const { createImapServer } = await import('../src/imap.mjs');
  const server = createImapServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));
  let buffer = '';
  const waitFor = (needle) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${needle}; got ${buffer.slice(-500)}`)), 4000);
    const check = () => {
      if (buffer.includes(needle)) { clearTimeout(timer); socket.off('data', check); resolve(buffer); }
    };
    buffer = '';
    socket.on('data', (chunk) => { buffer += chunk.toString('utf8'); check(); });
    check();
  });
  socket.write('a1 LOGIN info@example.com demo\r\n');
  await waitFor('a1 OK');
  socket.write('a2 LIST "" "*"\r\n');
  const list = await waitFor('a2 OK');
  assert.match(list, /"INBOX"/);
  assert.match(list, /"Sent"/);
  socket.write('a3 SELECT INBOX\r\n');
  const selected = await waitFor('a3 OK');
  assert.match(selected, /EXISTS/);
  socket.write('a4 FETCH 1 (UID FLAGS RFC822.SIZE BODY.PEEK[HEADER.FIELDS (SUBJECT FROM)])\r\n');
  const fetched = await waitFor('a4 OK');
  assert.match(fetched, /FETCH/);
  assert.match(fetched, /Subject:/);
  assert.match(fetched, /RFC822\.SIZE \d+/);

  const subject = 'IMAP appended message';
  const raw = `From: info@example.com\r\nTo: info@example.com\r\nSubject: ${subject}\r\n\r\nAppended body`;
  socket.write(`a5 APPEND Sent (\\Seen) {${Buffer.byteLength(raw)}}\r\n`);
  await waitFor('+ Ready');
  socket.write(raw + '\r\n');
  await waitFor('a5 OK');
  assert.ok(db.get("SELECT * FROM mail_messages WHERE subject = ?", subject), 'APPEND stored the message');
  socket.write('a6 LOGOUT\r\n');
  await waitFor('a6 OK');
  socket.end();
  await new Promise((resolve) => server.close(resolve));
});

/* --------------------------------------- continuation: queue body + MIME */
test('mail queue keeps bodies, retries them and sends attachments', async () => {
  const mta = await import('../src/mta.mjs');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'mta2-'));
  const out = path.join(bin, 'message.eml');
  fs.writeFileSync(path.join(bin, 'sendmail'), `#!/bin/sh\ncat > ${JSON.stringify(out)}\nexit 0\n`, { mode: 0o755 });
  const oldBin = process.env.OA_MTA_BIN;
  process.env.OA_MTA_BIN = path.join(bin, 'sendmail');
  try {
    const attachment = path.join(bin, 'note.txt');
    fs.writeFileSync(attachment, 'attached content');
    const built = mta.buildMessage({
      from: 'info@example.com', to: 'x@example.net', subject: 'Multi', body: 'hello',
      attachments: [{ filename: 'note.txt', path: attachment, mime: 'text/plain' }],
    });
    assert.match(built, /multipart\/mixed/);
    assert.match(built, /filename="note\.txt"/);
    assert.match(built, new RegExp(Buffer.from('attached content').toString('base64').slice(0, 12)));

    const login = await fetch(base + '/webmail/login', {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'info@example.com', password: 'demo' }).toString(),
    });
    const cookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get('set-cookie')])
      .filter(Boolean).map((c) => c.split(';')[0]).join('; ');
    const compose = await (await fetch(base + '/webmail?compose=1', { headers: { Cookie: cookie } })).text();
    const csrf = compose.match(/name="_csrf" value="([^"]+)"/)[1];

    const bad = await fetch(base + '/webmail/send', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, to: 'not-an-address', subject: 'Bad', body: 'x' }).toString(),
    });
    assert.equal(bad.status, 400);

    const upload = await (await fetch(base + '/webmail/attach', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ _csrf: csrf, name: 'note.txt', data: Buffer.from('attached content').toString('base64') }),
    })).json();
    await fetch(base + '/webmail/send', {
      method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, to: 'outside@example.net', subject: 'Queue attach', body: 'retry-body', 'attachment[]': upload.token }).toString(),
    });
    const row = db.get("SELECT * FROM mail_queue WHERE subject = 'Queue attach'");
    assert.ok(row);
    assert.equal(row.body, 'retry-body');
    assert.match(row.attachments, /note\.txt/);
    const sentFile = fs.readFileSync(out, 'utf8');
    assert.match(sentFile, /multipart\/mixed/);

    db.run("UPDATE mail_queue SET status = 'failed', sent_at = NULL WHERE id = ?", row.id);
    const admin = await loginAs('demoadmin');
    const queuePage = await (await fetch(base + '/compat/admin/mail-queue', { headers: { Cookie: admin } })).text();
    const acsrf = queuePage.match(/name="_csrf" value="([^"]+)"/)[1];
    const retry = await fetch(`${base}/compat/admin/mail-queue/${row.id}/retry`, {
      method: 'POST', redirect: 'manual', headers: { Cookie: admin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: acsrf }).toString(),
    });
    assert.equal(retry.status, 302);
    assert.equal(db.get('SELECT status FROM mail_queue WHERE id = ?', row.id).status, 'sent');
    assert.match(fs.readFileSync(out, 'utf8'), /retry-body/);
  } finally {
    if (oldBin === undefined) delete process.env.OA_MTA_BIN; else process.env.OA_MTA_BIN = oldBin;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

/* --------------------------------------------- continuation: real admin ops */
test('process monitor reads real processes and the file editor edits real files', async () => {
  const provider = (await import('../src/providers/index.mjs')).systemProvider();
  const procs = provider.processes();
  assert.equal(procs.ok, true, procs.error);
  assert.ok(procs.rows.length > 0);
  assert.ok(procs.rows.every((p) => Number.isInteger(p.pid)));

  const ws = await import('../src/webserver.mjs');
  db.setSetting('web_server', 'nginx');
  ws.generateAll('nginx');
  const target = path.join(dataDir, 'webserver', 'nginx', 'sites', 'example.com.conf');
  assert.ok(fs.existsSync(target));

  const admin = await loginAs('demoadmin');
  const page = await (await fetch(`${base}/admin/file-editor?file=${encodeURIComponent(target)}`, { headers: { Cookie: admin } })).text();
  assert.match(page, /server_name example\.com/);
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const updated = `${fs.readFileSync(target, 'utf8')}\n# edited by test\n`;
  const save = await fetch(base + '/admin/file-editor', {
    method: 'POST', redirect: 'manual', headers: { Cookie: admin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, file: target, content: updated }).toString(),
  });
  assert.equal(save.status, 302);
  assert.match(fs.readFileSync(target, 'utf8'), /edited by test/);
  assert.ok(fs.readdirSync(path.dirname(target)).some((f) => f.includes('.bak.')), 'backup written');

  const escape = await fetch(base + '/admin/file-editor', {
    method: 'POST', redirect: 'manual', headers: { Cookie: admin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, file: '/etc/passwd', content: 'x' }).toString(),
  });
  assert.equal(escape.status, 302);
  assert.match(fs.readFileSync(target, 'utf8'), /edited by test/, 'target unchanged by traversal attempt');
});

/* ---------------------------------------------- continuation: DKIM + quotas */
test('DKIM generates a real key and publishes the DNS record', async () => {
  const dkim = await import('../src/dkim.mjs');
  const result = dkim.generateDkim('example.com');
  assert.equal(result.ok, true, result.error);
  assert.ok(fs.existsSync(result.keyPath));
  assert.match(fs.readFileSync(result.keyPath, 'utf8'), /BEGIN (RSA )?PRIVATE KEY/);
  assert.match(result.publicKey, /^v=DKIM1; k=rsa; p=/);
  const row = db.get("SELECT * FROM dkim_keys WHERE domain = 'example.com'");
  assert.equal(row.selector, 'default');
  const txt = db.get("SELECT * FROM dns_records WHERE domain_id = (SELECT id FROM domains WHERE name='example.com') AND name = 'default._domainkey'");
  assert.ok(txt, 'TXT record written');
  assert.match(txt.value, /p=/);
  const zone = fs.readFileSync(path.join(dataDir, 'dns', 'example.com.db'), 'utf8');
  assert.match(zone, /default\._domainkey/);
});

test('mailbox usage is recalculated and IMAP APPEND respects the quota', async () => {
  const usage = await import('../src/usage.mjs');
  const account = db.get("SELECT * FROM email_accounts WHERE local_part = 'info'");
  fs.mkdirSync(path.join(dataDir, 'homes', 'demouser', 'mail', 'example.com', 'info', 'cur'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'homes', 'demouser', 'mail', 'example.com', 'info', 'cur', 'test.eml'), 'x'.repeat(2048));
  usage.recalcMailUsage();
  const updated = db.get('SELECT * FROM email_accounts WHERE id = ?', account.id);
  assert.ok(updated.used_mb > 0);

  const net = await import('node:net');
  const { createImapServer } = await import('../src/imap.mjs');
  db.run('UPDATE email_accounts SET quota_mb = 1, used_mb = 1 WHERE id = ?', account.id);
  const server = createImapServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socket = net.connect(server.address().port, '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));
  let buffer = '';
  const waitFor = (needle) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${needle}: ${buffer.slice(-300)}`)), 4000);
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes(needle)) { clearTimeout(timer); socket.off('data', onData); resolve(buffer); }
    };
    buffer = '';
    socket.on('data', onData);
  });
  socket.write('q1 LOGIN info@example.com demo\r\n');
  await waitFor('q1 OK');
  socket.write('q2 SELECT Sent\r\n');
  await waitFor('q2 OK');
  const raw = 'From: info@example.com\r\nTo: info@example.com\r\nSubject: quota\r\n\r\nbody';
  socket.write(`q3 APPEND Sent (\\Seen) {${Buffer.byteLength(raw)}}\r\n`);
  await waitFor('+ Ready');
  socket.write(raw + '\r\n');
  const response = await waitFor('q3 ');
  assert.match(response, /q3 NO \[OVERQUOTA\]/);
  socket.end();
  await new Promise((resolve) => server.close(resolve));
  db.run('UPDATE email_accounts SET quota_mb = 1024, used_mb = 0 WHERE id = ?', account.id);
});

/* ------------------------------------------------ continuation: account hygiene */
test('2FA locks the challenge after five wrong codes', async () => {
  const twofa = await import('../src/twofa.mjs');
  const secret = twofa.generateSecret();
  db.run("UPDATE users SET twofa_secret = ?, twofa_enabled = 1 WHERE username = 'demouser'", secret);
  try {
    const first = await fetch(base + '/login', {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'demouser', password: 'demo' }).toString(),
    });
    const cookie = (first.headers.getSetCookie ? first.headers.getSetCookie() : [first.headers.get('set-cookie')])
      .filter(Boolean).map((c) => c.split(';')[0]).join('; ');
    let last;
    for (let i = 0; i < 5; i++) {
      last = await fetch(base + '/login/2fa', {
        method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: '000000' }).toString(),
      });
    }
    assert.equal(last.status, 302);
    assert.match(last.headers.get('location'), /\/login\?error=/);
    assert.equal(db.get('SELECT COUNT(*) n FROM twofa_pending')[0]?.n ?? db.get('SELECT COUNT(*) n FROM twofa_pending').n, 0);
  } finally {
    db.run("UPDATE users SET twofa_enabled = 0, twofa_secret = NULL WHERE username = 'demouser'");
    db.run('DELETE FROM twofa_pending');
  }
});

test('deleting an account removes its zone, cron, FTP, DKIM and backups', async () => {
  const { rebuildZone } = await import('../src/dns.mjs');
  const { cronPath } = await import('../src/cron.mjs');
  const { backupPath } = await import('../src/backups.mjs');
  const { createUserBackup } = await import('../src/backups.mjs');
  const provider = (await import('../src/providers/index.mjs')).systemProvider();
  db.run('INSERT OR IGNORE INTO packages(name, owner, type, limits, created_at) VALUES(?,?,?,?,?)',
    'cleanup-pkg', null, 'user', JSON.stringify({ domains: 1, emails: 1 }), db.nowIso());
  const r = db.run(`INSERT INTO users(username, password, email, level, package, created_at) VALUES(?,?,?,?,?,?)`,
    'cleanupuser', db.hashPassword('cleanup-pass-123'), 'clean@example.com', 'user', 'cleanup-pkg', db.nowIso());
  const user = db.get('SELECT * FROM users WHERE id = ?', r.lastInsertRowid);
  db.run(`INSERT INTO domains(user_id, username, name, docroot, php_version, ssl, status, is_main, ip, created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`, user.id, 'cleanupuser', 'cleanup.example', '/home/cleanupuser/domains/cleanup.example/public_html',
    '8.3', 1, 'active', 1, '127.0.0.1', db.nowIso());
  const dom = db.get('SELECT * FROM domains WHERE name = ?', 'cleanup.example');
  db.run("INSERT INTO dns_records(domain_id, name, type, value, priority, ttl) VALUES(?,?,?,?,?,?)", dom.id, '@', 'A', '192.0.2.10', null, 3600);
  rebuildZone('cleanup.example');
  const ftpName = 'cleanupuser_ftp';
  provider.createFtpUser(ftpName, `/home/cleanupuser`, 'ftp-pass-123');
  db.run('INSERT INTO ftp_accounts(user_id, username, path, quota_mb, password, created_at) VALUES(?,?,?,?,?,?)',
    user.id, ftpName, '/home/cleanupuser', 0, db.hashPassword('ftp-pass-123'), db.nowIso());
  fs.writeFileSync(cronPath('cleanupuser'), '# cron');
  const backup = createUserBackup(user, 'home');
  assert.ok(fs.existsSync(backupPath(backup.filename)));

  const admin = await loginAs('demoadmin');
  const detail = await (await fetch(`${base}/admin/users/${user.id}`, { headers: { Cookie: admin } })).text();
  const csrf = detail.match(/name="_csrf" value="([^"]+)"/)[1];
  const del = await fetch(`${base}/admin/users/${user.id}/delete`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: admin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  assert.equal(del.status, 302);
  assert.equal(db.get('SELECT id FROM users WHERE id = ?', user.id), null);
  assert.ok(!fs.existsSync(path.join(dataDir, 'dns', 'cleanup.example.db')), 'zone removed');
  assert.ok(!fs.existsSync(cronPath('cleanupuser')), 'crontab removed');
  assert.ok(!fs.existsSync(backupPath(backup.filename)), 'backup removed');
  const passwd = fs.readFileSync(path.join(dataDir, 'ftp', 'passwd'), 'utf8');
  assert.ok(!passwd.includes(ftpName), 'FTP entry removed');
});

test('home paths follow the provider', async () => {
  const paths = await import('../src/paths.mjs');
  const { config } = await import('../src/config.mjs');
  const old = config.provider;
  try {
    config.provider = 'sandbox';
    assert.equal(paths.homeRoot(), path.join(dataDir, 'homes'));
    config.provider = 'linux';
    assert.equal(paths.userHome('alice'), '/home/alice');
  } finally {
    config.provider = old;
  }
});

/* ------------------------------------------------ continuation: Maildir sync */
test('Maildir delivery is imported into webmail/IMAP exactly once', async () => {
  const { syncMaildirs } = await import('../src/maildir.mjs');
  const dir = path.join(dataDir, 'homes', 'demouser', 'mail', 'example.com', 'info', 'new');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'inbound-1.eml'), [
    'From: sender@example.net',
    'To: info@example.com',
    'Subject: Imported inbound',
    'Date: Fri, 13 Nov 2026 09:00:00 +0000',
    '',
    'Inbound body',
  ].join('\r\n'));
  const first = syncMaildirs();
  assert.ok(first.imported >= 1);
  const row = db.get("SELECT * FROM mail_messages WHERE subject = 'Imported inbound' AND mailbox = 'info@example.com'");
  assert.ok(row, 'message imported');
  assert.equal(row.folder, 'INBOX');
  assert.match(row.body, /Inbound body/);
  const second = syncMaildirs();
  assert.equal(second.imported, 0);
  assert.equal(db.get("SELECT COUNT(*) n FROM mail_messages WHERE subject = 'Imported inbound'")[0]?.n
    ?? db.get("SELECT COUNT(*) n FROM mail_messages WHERE subject = 'Imported inbound'").n, 1);
});

test('inbound multipart mail is reduced to readable text', async () => {
  const { syncMaildirs } = await import('../src/maildir.mjs');
  const dir = path.join(dataDir, 'homes', 'demouser', 'mail', 'example.com', 'info', 'new');
  fs.mkdirSync(dir, { recursive: true });
  const boundary = 'BOUND42';
  fs.writeFileSync(path.join(dir, 'multipart-1.eml'), [
    'From: multi@example.net', 'To: info@example.com', 'Subject: Multipart inbound',
    `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', '', 'Plain part text', '',
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', '', '<p>HTML part</p>', '',
    `--${boundary}--`, '',
  ].join('\r\n'));
  syncMaildirs();
  const row = db.get("SELECT * FROM mail_messages WHERE subject = 'Multipart inbound'");
  assert.ok(row);
  assert.match(row.body, /Plain part text/);
  assert.ok(!row.body.includes('BOUND42'));
});

/* ------------------------------------------------ laik UX: P0 additions */
test('autoconfig, autodiscover and mail client settings work', async () => {
  const xml = await fetch(base + '/mail/config-v1.1.xml?email=info@example.com');
  assert.equal(xml.status, 200);
  const body = await xml.text();
  assert.match(body, /<clientConfig/);
  assert.match(body, /<port>993<\/port>/);
  assert.match(body, /<port>587<\/port>/);

  const auto = await fetch(base + '/autodiscover/autodiscover.xml', {
    method: 'POST', headers: { 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><Autodiscover><Request><EMailAddress>info@example.com</EMailAddress></Request></Autodiscover>',
  });
  assert.equal(auto.status, 200);
  assert.match(await auto.text(), /<Autodiscover/);

  const cookie = await loginAs('demouser');
  const page = await fetch(base + '/user/email/client-settings?address=info@example.com', { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /993/);

  const mailbox = db.get('SELECT * FROM email_accounts ORDER BY id LIMIT 1');
  assert.ok(mailbox, 'seeded mailbox exists');
  const setup = await fetch(`${base}/user/email/${mailbox.id}/setup`, { headers: { Cookie: cookie } });
  assert.equal(setup.status, 200);
  const setupHtml = await setup.text();
  assert.match(setupHtml, /IMAP SSL/);
  assert.match(setupHtml, /993/);
  assert.match(setupHtml, /587/);
  assert.match(setupHtml, /DNS poczty/);
  const tested = await fetch(`${base}/user/email/${mailbox.id}/test`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: (await import('../src/auth.mjs')).getSession(cookie.split('=')[1])?.session.csrf || '' }).toString(),
  });
  assert.equal(tested.status, 200);
  assert.match(await tested.text(), /Test portów/);
});

test('setup wizard and health page render for the administrator', async () => {
  const cookie = await loginAs('demoadmin');
  const setup = await fetch(base + '/admin/setup', { headers: { Cookie: cookie } });
  assert.equal(setup.status, 200);
  const html = await setup.text();
  assert.match(html, /Kreator konfiguracji/);
  assert.match(html, /name="server_ip"/);
  const health = await fetch(base + '/admin/health', { headers: { Cookie: cookie } });
  assert.equal(health.status, 200);
  assert.match(await health.text(), /Stan serwera/);
});

test('domain creation applies web and DNS configuration automatically', async () => {
  const name = `auto-${Date.now()}.example`;
  const text = await (await fetch(`${base}/CMD_API_DOMAIN?action=create&domain=${name}`, {
    headers: { Authorization: basic('demouser', 'demo') },
  })).text();
  assert.match(text, /error=0/);
  assert.equal(db.setting('apply_pending', '1'), '0');
  assert.ok(db.setting('last_apply_at', ''), 'apply timestamp recorded');
  assert.ok(fs.existsSync(path.join(dataDir, 'webserver', 'nginx', 'sites', `${name}.conf`)), 'vhost staged');
  await fetch(`${base}/CMD_API_DOMAIN?action=delete&domain=${name}`, { headers: { Authorization: basic('demouser', 'demo') } });
});

test('self-service password reset changes the password and invalidates the token', async () => {
  const { createResetToken } = await import('../src/passwordreset.mjs');
  db.run(`INSERT INTO users(username, password, email, level, package, created_at) VALUES(?,?,?,?,?,?)`,
    'resetuser', db.hashPassword('before-pass-123'), 'reset@example.test', 'user', 'default', db.nowIso());
  const user = db.get("SELECT * FROM users WHERE username = 'resetuser'");
  const token = createResetToken(user.id);
  const exchange = await fetch(`${base}/reset-password?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
  assert.equal(exchange.status, 302);
  assert.equal(exchange.headers.get('location'), '/reset-password');
  const resetCookie = exchange.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  assert.match(resetCookie, /OA_RESET=/);
  const page = await fetch(base + '/reset-password', { headers: { Cookie: resetCookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Ustaw nowe hasło/);
  const reset = await fetch(base + '/reset-password', {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: resetCookie },
    body: new URLSearchParams({ password: 'after-pass-456', password2: 'after-pass-456' }).toString(),
  });
  assert.equal(reset.status, 302);
  assert.equal(db.get("SELECT * FROM password_resets WHERE user_id = ?", user.id), null);
  const login = await fetch(base + '/login', {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'resetuser', password: 'after-pass-456' }).toString(),
  });
  assert.equal(login.status, 302);
  db.run('DELETE FROM users WHERE id = ?', user.id);
});

test('interface settings switch language and simple mode', async () => {
  const cookie = await loginAs('demouser');
  const page = await (await fetch(base + '/user/interface', { headers: { Cookie: cookie } })).text();
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const res = await fetch(base + '/user/interface', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, language: 'en', ui_mode: 'advanced' }).toString(),
  });
  assert.equal(res.status, 302);
  assert.equal(db.get("SELECT language, ui_mode FROM users WHERE username='demouser'").language, 'en');
  const dash = await (await fetch(base + '/user', { headers: { Cookie: cookie } })).text();
  assert.match(dash, /Dashboard/);
  db.run("UPDATE users SET language='pl', ui_mode='simple' WHERE username='demouser'");
});

test('WordPress installer rejects foreign domains and missing passwords', async () => {
  const { installWordPress } = await import('../src/wordpress.mjs');
  const user = db.get("SELECT * FROM users WHERE username='demouser'");
  const foreign = installWordPress({ user, domain: 'not-owned.example', adminPass: 'long-enough-pass' });
  assert.equal(foreign.ok, false);
  assert.match(foreign.error, /nie należy/);
  const weak = installWordPress({ user, domain: 'example.com', adminPass: 'short' });
  assert.equal(weak.ok, false);
  assert.match(weak.error, /8 znaków/);
});

test('help page is available in simple mode', async () => {
  const cookie = await loginAs('demouser');
  const res = await fetch(base + '/user/help', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /Jak postawić stronę/);
  assert.match(text, /Dodaj pocztę/);
});

test('cPanel backup import restores DNS and website files', async () => {
  const { spawnSync } = await import('node:child_process');
  const { importArchive, detectKind } = await import('../src/importer.mjs');
  const domain = `import-${Date.now()}.example`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cpimport-'));
  const root = path.join(work, 'cpmove-tester');
  fs.mkdirSync(path.join(root, 'homedir', 'public_html'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dnszones'), { recursive: true });
  fs.mkdirSync(path.join(root, 'mysql'), { recursive: true });
  fs.writeFileSync(path.join(root, 'homedir', 'public_html', 'index.html'), '<h1>Imported site</h1>');
  fs.writeFileSync(path.join(root, 'dnszones', `${domain}.db`), [
    '$TTL 3600', '@ IN SOA ns1.example. root.example. ( 1 3600 1800 1209600 3600 )',
    '@ IN A 192.0.2.77', 'www IN CNAME @', '@ IN MX 10 mail.example.', '@ IN TXT "v=spf1 mx ~all"',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'mysql', 'shop.sql'), 'CREATE TABLE IF NOT EXISTS t (id INT);');
  const archive = path.join(work, 'cpmove-tester.tar.gz');
  const tar = spawnSync('tar', ['-czf', archive, '-C', work, 'cpmove-tester']);
  assert.equal(tar.status, 0);
  assert.equal(detectKind(archive).kind, 'cpanel');
  const result = importArchive({ filePath: archive, targetUsername: 'demouser', skipDb: true });
  assert.equal(result.ok, true, result.error);
  assert.ok(result.domains.some((d) => d.domain === domain));
  const d = db.get('SELECT * FROM domains WHERE name = ?', domain);
  assert.ok(d, 'domain created');
  assert.ok(fs.existsSync(path.join(d.docroot, 'index.html')), 'web files copied');
  const a = db.get("SELECT * FROM dns_records WHERE domain_id = ? AND type = 'A' AND name = '@'", d.id);
  assert.equal(a.value, '192.0.2.77');
  db.run('DELETE FROM domains WHERE id = ?', d.id);
  fs.rmSync(work, { recursive: true, force: true });
});

test('admin migration page renders', async () => {
  const cookie = await loginAs('demoadmin');
  const res = await fetch(base + '/admin/import', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Migracja z cPanel/);
});

test('Nextcloud installer validates input and the app page offers it', async () => {
  const { installNextcloud } = await import('../src/nextcloud.mjs');
  const user = db.get("SELECT * FROM users WHERE username='demouser'");
  const foreign = installNextcloud({ user, domain: 'not-owned.example', adminPass: 'long-enough-pass' });
  assert.equal(foreign.ok, false);
  assert.match(foreign.error, /nie należy/);
  const weak = installNextcloud({ user, domain: 'example.com', adminPass: 'short' });
  assert.equal(weak.ok, false);
  assert.match(weak.error, /8 znaków/);
  const cookie = await loginAs('demouser');
  const page = await (await fetch(base + '/user/app-installer', { headers: { Cookie: cookie } })).text();
  assert.match(page, /Nextcloud/);
  assert.match(page, /WordPress/);
  assert.match(page, /app-tile-grid/);
});

test('security center renders and blocks/removes an IP in sandbox', async () => {
  const cookie = await loginAs('demoadmin');
  const page = await (await fetch(base + '/admin/security?tab=firewall', { headers: { Cookie: cookie } })).text();
  assert.match(page, /Security Center/);
  assert.match(page, /IP block/);
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const add = await fetch(base + '/admin/security/ipblock/add', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, cidr: '198.51.100.0/24', reason: 'test' }).toString(),
  });
  assert.equal(add.status, 302);
  const row = db.get("SELECT * FROM ip_blocks WHERE cidr = '198.51.100.0/24'");
  assert.ok(row);
  assert.ok(fs.existsSync(path.join(dataDir, 'simulated', 'etc', 'openadmin', 'firewall.nft')));
  const del = await fetch(base + `/admin/security/ipblock/${row.id}/delete`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  assert.equal(del.status, 302);
  assert.equal(db.get("SELECT * FROM ip_blocks WHERE cidr = '198.51.100.0/24'"), null);
});

test('security policy, SSH and root key import persist safely', async () => {
  const cookie = await loginAs('demoadmin');
  const page = await (await fetch(base + '/admin/security?tab=policy', { headers: { Cookie: cookie } })).text();
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  await fetch(base + '/admin/security/policy', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, minlen: '14', minclass: '4', maxrepeat: '2' }).toString(),
  });
  assert.equal(getSettingValue('security_password_policy').minlen, 14);
  const ssh = await fetch(base + '/admin/security/ssh', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, port: '2222', permit_root_login: 'prohibit-password', max_auth_tries: '4' }).toString(),
  });
  assert.equal(ssh.status, 302);
  const conf = fs.readFileSync(path.join(dataDir, 'simulated', 'etc', 'ssh', 'sshd_config.d', '99-openadmin.conf'), 'utf8');
  assert.match(conf, /Port 2222/);
  const pub = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE7u5fakekeyfortestonly000000000000000000000 test@example';
  const key = await fetch(base + '/admin/security/keys/import', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, name: 'test-key', public_key: pub }).toString(),
  });
  assert.equal(key.status, 302);
  assert.ok(db.get("SELECT * FROM root_ssh_keys WHERE name = 'test-key'"));
  assert.match(fs.readFileSync(path.join(dataDir, 'simulated', 'root', '.ssh', 'authorized_keys'), 'utf8'), /ssh-ed25519/);
});

function getSettingValue(key) {
  const row = db.get('SELECT value FROM settings WHERE key = ?', key);
  return row ? JSON.parse(row.value) : null;
}

test('mail operations center renders, diagnoses and filters mail', async () => {
  const cookie = await loginAs('demoadmin');
  const page = await (await fetch(base + '/admin/mail?tab=filters', { headers: { Cookie: cookie } })).text();
  assert.match(page, /Mail Operations Center/);
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const diag = await fetch(base + '/admin/mail/diagnose', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, address: 'info@example.com' }).toString(),
  });
  assert.equal(diag.status, 200);
  assert.match(await diag.text(), /Diagnoza/);
  const f = await fetch(base + '/admin/mail/filters', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, kind: 'sender_domain', value: 'spam.example', action: 'reject' }).toString(),
  });
  assert.equal(f.status, 302);
  assert.ok(db.get("SELECT * FROM mail_filters WHERE value = 'spam.example'"));
  const q = await fetch(base + '/admin/mail?tab=queue', { headers: { Cookie: cookie } });
  assert.equal(q.status, 200);
  assert.match(await q.text(), /Kolejka/);
});

test('mail settings and blacklist persist', async () => {
  const cookie = await loginAs('demoadmin');
  const page = await (await fetch(base + '/admin/mail?tab=settings', { headers: { Cookie: cookie } })).text();
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  await fetch(base + '/admin/mail/settings', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, rbl: 'zen.spamhaus.org', sender_blacklist: 'bad.example' }).toString(),
  });
  const cfg = JSON.parse(db.get("SELECT value FROM settings WHERE key = 'mail_ops_settings'").value);
  assert.deepEqual(cfg.rbl, ['zen.spamhaus.org']);
  const bl = await fetch(base + '/admin/mail/blacklist', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, domain: 'blocked.example' }).toString(),
  });
  assert.equal(bl.status, 302);
  assert.ok(db.get("SELECT * FROM blacklist_domains WHERE domain = 'blocked.example'"));
});

test('backup center creates a local server, runs a job and dry-runs restore', async () => {
  const cookie = await loginAs('demoadmin');
  const page = await (await fetch(base + '/admin/backup-center?tab=servers', { headers: { Cookie: cookie } })).text();
  assert.match(page, /Backup Center/);
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const target = path.join(dataDir, 'remote-backups');
  const srv = await fetch(base + '/admin/backup-center/servers', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, name: 'test-local', type: 'local', path: target }).toString(),
  });
  assert.equal(srv.status, 302);
  assert.ok(db.get("SELECT * FROM backup_servers WHERE name = 'test-local'"));
  const server = db.get("SELECT * FROM backup_servers WHERE name = 'test-local'");
  const job = await fetch(base + '/admin/backup-center/jobs', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, name: 'test-job', scope: 'user', target_user: 'demouser', server_id: String(server.id), schedule: 'daily', retention_days: '7' }).toString(),
  });
  assert.equal(job.status, 302);
  const row = db.get("SELECT * FROM backup_jobs WHERE name = 'test-job'");
  assert.ok(row);
  const run = await fetch(base + `/admin/backup-center/jobs/${row.id}/run`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  assert.equal(run.status, 302);
  const r = db.get('SELECT * FROM backup_runs WHERE job_id = ? ORDER BY id DESC', row.id);
  assert.equal(r.status, 'complete');
  assert.ok(fs.existsSync(r.local_path));
  assert.ok(fs.existsSync(path.join(target, r.filename)));
  const dry = await fetch(base + `/admin/backup-center/runs/${r.id}/dry`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  assert.equal(dry.status, 200);
  assert.match(await dry.text(), /Dry-run restore/);
});

test('PHP stack manager renders and saves FPM settings', async () => {
  const cookie = await loginAs('demoadmin');
  const page = await (await fetch(base + '/admin/php?tab=fpm&user=demouser', { headers: { Cookie: cookie } })).text();
  assert.match(page, /PHP \/ Web Stack/);
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const res = await fetch(base + '/admin/php/fpm?user=demouser', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, pm: 'ondemand', 'pm.max_children': '12', 'pm.max_requests': '300' }).toString(),
  });
  assert.equal(res.status, 302);
  const cfg = JSON.parse(db.get("SELECT value FROM settings WHERE key = 'fpm_pool:demouser'").value);
  assert.equal(cfg['pm.max_children'], '12');
  const overview = await (await fetch(base + '/admin/php', { headers: { Cookie: cookie } })).text();
  assert.match(overview, /Wersje PHP|Nie znaleziono/);
});

test('plans page creates feature set and toggles global feature', async () => {
  const cookie = await loginAs('demoadmin');
  const page = await (await fetch(base + '/admin/plans?tab=sets', { headers: { Cookie: cookie } })).text();
  assert.match(page, /Plans & Limits/);
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const r = await fetch(base + '/admin/plans/sets', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, name: 'no-ftp', f_ftp: '1' }).toString(),
  });
  assert.equal(r.status, 302);
  assert.ok(db.get("SELECT * FROM feature_sets WHERE name = 'no-ftp'"));
  const off = await fetch(base + '/admin/plans/features/ftp', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  assert.equal(off.status, 302);
  assert.ok(JSON.parse(db.get("SELECT value FROM settings WHERE key = 'disabled_features'").value).includes('ftp'));
  const lim = (await import('../src/auth.mjs')).limitsFor(db.get("SELECT * FROM users WHERE username='demouser'"));
  assert.equal(Number(lim.ftp), 0);
});

test('DNS operations changes zone TTL and MX', async () => {
  const cookie = await loginAs('demoadmin');
  const page = await (await fetch(base + '/admin/dns-ops?tab=zones', { headers: { Cookie: cookie } })).text();
  assert.match(page, /DNS Operations/);
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const ttl = await fetch(base + '/admin/dns-ops/zones/example.com/ttl', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, ttl: '7200' }).toString(),
  });
  assert.equal(ttl.status, 302);
  assert.equal(db.get("SELECT dns_ttl FROM domains WHERE name = 'example.com'").dns_ttl, 7200);
  const mx = await fetch(base + '/admin/dns-ops/mx', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, domain: 'example.com', host: 'mail.example.com', priority: '5' }).toString(),
  });
  assert.equal(mx.status, 302);
  assert.ok(db.get("SELECT * FROM dns_records WHERE domain_id = (SELECT id FROM domains WHERE name='example.com') AND type='MX' AND value='mail.example.com'"));
});

test('live transfer creates and runs a sandbox job', async () => {
  const cookie = await loginAs('demoadmin');
  const page = await (await fetch(base + '/admin/import-live', { headers: { Cookie: cookie } })).text();
  assert.match(page, /Live transfer/);
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const create = await fetch(base + '/admin/import-live/create', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, source: 'cpanel', host: 'source.example.com', username: 'alice', password: 'secret', target: 'demouser' }).toString(),
  });
  assert.equal(create.status, 302);
  const job = db.get("SELECT * FROM import_jobs WHERE host = 'source.example.com'");
  assert.ok(job);
  const run = await fetch(base + `/admin/import-live/jobs/${job.id}/run`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  assert.equal(run.status, 302);
  assert.equal(db.get('SELECT status FROM import_jobs WHERE id = ?', job.id).status, 'complete');
});

test('update center renders and OS dry-run is safe', async () => {
  const cookie = await loginAs('demoadmin');
  const page = await (await fetch(base + '/admin/updates-center?tab=os', { headers: { Cookie: cookie } })).text();
  assert.match(page, /Update Center/);
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const dry = await fetch(base + '/admin/updates-center/os/dry', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  assert.equal(dry.status, 200);
  assert.match(await dry.text(), /Pakiety|Sandbox|Brak aktualizacji/);
});

test('API key authenticates REST and MCP with read scope', async () => {
  const cookie = await loginAs('demoadmin');
  const page = await (await fetch(base + '/admin/api-keys', { headers: { Cookie: cookie } })).text();
  assert.match(page, /API Keys & MCP/);
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const admin = db.get("SELECT * FROM users WHERE username='demoadmin'");
  const create = await fetch(base + '/admin/api-keys/create', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, user_id: String(admin.id), name: 'mcp-test', scopes: 'read' }).toString(),
  });
  assert.equal(create.status, 200);
  const html = await create.text();
  const secret = /<pre class="code-block">(oa_[^<]+)<\/pre>/.exec(html)?.[1];
  assert.ok(secret);
  const api = await fetch(base + '/api/v1/domains', { headers: { 'X-API-Key': secret } });
  assert.equal(api.status, 200);
  const init = await fetch(base + '/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(init.status, 200);
  const initJson = await init.json();
  assert.equal(initJson.result.serverInfo.name, 'OpenAdmin');
  const tools = await fetch(base + '/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  }).then((r) => r.json());
  assert.ok(tools.result.tools.some((t) => t.name === 'list_domains'));
  const call = await fetch(base + '/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_domains', arguments: {} } }),
  }).then((r) => r.json());
  assert.match(call.result.content[0].text, /example\.com/);
});

test('notification center and webhook channel work', async () => {
  const http = await import('node:http');
  let received = null;
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => { received = b; res.writeHead(200); res.end('ok'); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const cookie = await loginAs('demoadmin');
  const page = await (await fetch(base + '/admin/notifications?tab=channels', { headers: { Cookie: cookie } })).text();
  assert.match(page, /Centrum powiadomień/);
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const add = await fetch(base + '/admin/notifications/channels', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, name: 'test-hook', type: 'webhook', url: `http://127.0.0.1:${port}/hook` }).toString(),
  });
  assert.equal(add.status, 302);
  const ch = db.get("SELECT * FROM notification_channels WHERE name = 'test-hook'");
  assert.ok(ch);
  const test = await fetch(base + `/admin/notifications/channels/${ch.id}/test`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  assert.equal(test.status, 302);
  await new Promise((r) => setTimeout(r, 300));
  assert.match(received || '', /Test OpenAdmin/);
  const user = await fetch(base + '/user/notifications', { headers: { Cookie: await loginAs('demouser') } });
  assert.equal(user.status, 200);
  server.close();
});

test('reseller tools creates plan, assigns and changes ownership', async () => {
  const cookie = await loginAs('demoadmin');
  const page = await (await fetch(base + '/admin/reseller-tools?tab=plans', { headers: { Cookie: cookie } })).text();
  assert.match(page, /Reseller Tools/);
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const plan = await fetch(base + '/admin/reseller-tools/plans', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, name: 'test-reseller-plan', users: '10', domains: '100' }).toString(),
  });
  assert.equal(plan.status, 302);
  assert.ok(db.get("SELECT * FROM reseller_plans WHERE name = 'test-reseller-plan'"));
  const assign = await fetch(base + '/admin/reseller-tools/plans/assign', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, username: 'demoreseller', plan: 'test-reseller-plan' }).toString(),
  });
  assert.equal(assign.status, 302);
  assert.equal(db.get("SELECT reseller_plan FROM users WHERE username='demoreseller'").reseller_plan, 'test-reseller-plan');
});

test('support access link creates a read-only session', async () => {
  const cookie = await loginAs('demoadmin');
  const page = await (await fetch(base + '/admin/support-access', { headers: { Cookie: cookie } })).text();
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const create = await fetch(base + '/admin/support-access/create', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, hours: '2' }).toString(),
  });
  const html = await create.text();
  const link = /<pre class="code-block">(\/support\/[^<]+)<\/pre>/.exec(html)?.[1];
  assert.ok(link);
  const redeem = await fetch(base + link, { redirect: 'manual' });
  assert.equal(redeem.status, 302);
  const setCookie = redeem.headers.get('set-cookie');
  assert.ok(setCookie);
  const supportCookie = setCookie.split(';')[0];
  const admin = await fetch(base + '/admin', { headers: { Cookie: supportCookie } });
  assert.equal(admin.status, 200);
  const post = await fetch(base + '/admin/support-access/create', {
    method: 'POST', headers: { Cookie: supportCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, hours: '1' }).toString(),
  });
  assert.equal(post.status, 403);
});

test('AutoSSL center renders and records key type', async () => {
  const cookie = await loginAs('demoadmin');
  const page = await (await fetch(base + '/admin/ssl-center', { headers: { Cookie: cookie } })).text();
  assert.match(page, /AutoSSL Center/);
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const r = await fetch(base + '/admin/ssl-center/keytype', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, type: 'ecdsa-p256' }).toString(),
  });
  assert.equal(r.status, 302);
  assert.equal(db.get("SELECT value FROM settings WHERE key = 'ssl_key_type'").value, 'ecdsa-p256');
});

test('log center tails a simulated log and saves rotation', async () => {
  const logDir = path.join(dataDir, 'simulated', 'var', 'log');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'test.log'), 'first line\nneedle line\nlast line\n');
  const cookie = await loginAs('demoadmin');
  const page = await (await fetch(base + '/admin/log-center?source=sim%3Atest.log&q=needle', { headers: { Cookie: cookie } })).text();
  assert.match(page, /needle line/);
  const rotPage = await (await fetch(base + '/admin/log-center?tab=rotation', { headers: { Cookie: cookie } })).text();
  const csrf = rotPage.match(/name="_csrf" value="([^"]+)"/)[1];
  const rot = await fetch(base + '/admin/log-center/rotation', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, config: '/var/log/openadmin/*.log {\n daily\n rotate 7\n}\n' }).toString(),
  });
  assert.equal(rot.status, 302);
  assert.match(fs.readFileSync(path.join(dataDir, 'simulated', 'etc', 'logrotate.d', 'openadmin'), 'utf8'), /rotate 7/);
});

test('process monitor offers kill and trace safely', async () => {
  const cookie = await loginAs('demoadmin');
  const page = await (await fetch(base + '/admin/processes', { headers: { Cookie: cookie } })).text();
  assert.match(page, /Process Monitor/);
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const bad = await fetch(base + '/admin/processes/999999/kill', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  assert.equal(bad.status, 302);
  const trace = await fetch(base + '/admin/processes/1/trace', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  assert.equal(trace.status, 200);
});

test('storage destination can be added and measured', async () => {
  const cookie = await loginAs('demoadmin');
  const page = await (await fetch(base + '/admin/storage', { headers: { Cookie: cookie } })).text();
  assert.match(page, /Storage Destinations/);
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const path2 = path.join(dataDir, 'storage-test');
  const r = await fetch(base + '/admin/storage/add', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, name: 'test-storage', path: path2, type: 'ext4', alert_percent: '90' }).toString(),
  });
  assert.equal(r.status, 302);
  assert.ok(db.get("SELECT * FROM storage_paths WHERE path = ?", path2));
  assert.ok(fs.existsSync(path2));
});

test('panel configuration saves branding and ACL', async () => {
  const cookie = await loginAs('demoadmin');
  const page = await (await fetch(base + '/admin/panel-config?tab=branding', { headers: { Cookie: cookie } })).text();
  assert.match(page, /Panel Configuration/);
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const b = await fetch(base + '/admin/panel-config/branding', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, name: 'TestPanel', subtitle: 'Hosting', footer: 'Test footer' }).toString(),
  });
  assert.equal(b.status, 302);
  const dash = await (await fetch(base + '/admin', { headers: { Cookie: cookie } })).text();
  assert.match(dash, /TestPanel/);
  const a = await fetch(base + '/admin/panel-config/access', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, disable_domains: '1' }).toString(),
  });
  assert.equal(a.status, 302);
  const { capabilities } = await import('../src/auth.mjs');
  const cap = capabilities(db.get("SELECT * FROM users WHERE username='demouser'"));
  assert.equal(cap.domains, false);
  db.run("DELETE FROM settings WHERE key IN ('brand_name','brand_subtitle','brand_footer','panel_acl')");
});

test('user tools creates demo, toggles shell and saves skeleton', async () => {
  const cookie = await loginAs('demoadmin');
  const page = await (await fetch(base + '/admin/user-tools?tab=shell', { headers: { Cookie: cookie } })).text();
  assert.match(page, /User Tools/);
  const csrf = page.match(/name="csrf-token" content="([^"]+)"/)[1];
  const shell = await fetch(base + '/admin/user-tools/shell/demouser', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  assert.equal(shell.status, 302);
  assert.equal(db.get("SELECT shell_enabled FROM users WHERE username='demouser'").shell_enabled, 1);
  const demo = await fetch(base + '/admin/user-tools/demo', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, label: 'demotest' }).toString(),
  });
  assert.equal(demo.status, 200);
  assert.ok(db.get("SELECT * FROM users WHERE demo = 1 AND username LIKE 'demotest%'"));
  const skel = path.join(dataDir, 'skeleton-test');
  fs.mkdirSync(skel, { recursive: true });
  const s = await fetch(base + '/admin/user-tools/skeleton', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, path: skel }).toString(),
  });
  assert.equal(s.status, 302);
  assert.equal(db.get("SELECT value FROM settings WHERE key='skeleton_directory'").value, skel);
});

test('PostgreSQL manager renders and reports availability', async () => {
  const cookie = await loginAs('demoadmin');
  const page = await (await fetch(base + '/admin/postgres', { headers: { Cookie: cookie } })).text();
  assert.match(page, /PostgreSQL/);
  assert.match(page, /Utwórz bazę|nie jest gotowy/);
});

test('multi-server registry adds, tests and removes a node', async () => {
  const cookie = await loginAs('demoadmin');
  const page = await (await fetch(base + '/admin/multiserver', { headers: { Cookie: cookie } })).text();
  assert.match(page, /Multi Server/);
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const add = await fetch(base + '/admin/multiserver/add', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, name: 'self', url: base, role: 'web' }).toString(),
  });
  assert.equal(add.status, 302);
  const node = db.get("SELECT * FROM servers WHERE name = 'self'");
  assert.ok(node);
  const test = await fetch(base + `/admin/multiserver/${node.id}/test`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  assert.equal(test.status, 302);
  assert.match(db.get('SELECT last_status FROM servers WHERE id = ?', node.id).last_status, /^ok/);
});

test('WebDisk account supports WebDAV PUT/GET/PROPFIND/DELETE', async () => {
  const cookie = await loginAs('demouser');
  const page = await (await fetch(base + '/user/webdisk', { headers: { Cookie: cookie } })).text();
  assert.match(page, /WebDisk/);
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const create = await fetch(base + '/user/webdisk/create', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, domain: 'example.com', subpath: 'webdavtest', password: 'WebdavPass123!' }).toString(),
  });
  assert.equal(create.status, 200);
  const html = await create.text();
  const login = /Login: <code>([^<]+)<\/code>/.exec(html)?.[1];
  assert.ok(login);
  const auth = 'Basic ' + Buffer.from(`${login}:WebdavPass123!`).toString('base64');
  const put = await fetch(base + '/webdisk/hello.txt', { method: 'PUT', headers: { Authorization: auth, 'Content-Type': 'application/octet-stream' }, body: 'hello webdav' });
  assert.equal(put.status, 201);
  const get = await fetch(base + '/webdisk/hello.txt', { headers: { Authorization: auth } });
  assert.equal(get.status, 200);
  assert.equal(await get.text(), 'hello webdav');
  const prop = await fetch(base + '/webdisk/', { method: 'PROPFIND', headers: { Authorization: auth, Depth: '1' } });
  assert.equal(prop.status, 207);
  assert.match(await prop.text(), /hello\.txt/);
  const del = await fetch(base + '/webdisk/hello.txt', { method: 'DELETE', headers: { Authorization: auth } });
  assert.equal(del.status, 204);
  const w = db.get("SELECT * FROM webdisks WHERE username = ?", login);
  db.run('DELETE FROM webdisks WHERE id = ?', w.id);
});

test('app catalogue renders and validates installs', async () => {
  const cookie = await loginAs('demouser');
  const page = await (await fetch(base + '/user/app-catalog', { headers: { Cookie: cookie } })).text();
  assert.match(page, /Aplikacje/);
  assert.match(page, /WordPress/); assert.match(page, /Nextcloud/);
  assert.match(page, /Joomla/); assert.match(page, /Drupal/); assert.match(page, /PrestaShop/); assert.match(page, /Moodle/);
  const { installApp } = await import('../src/appcatalog.mjs');
  const user = db.get("SELECT * FROM users WHERE username='demouser'");
  const foreign = installApp('joomla', { user, domain: 'not-owned.example', adminPass: 'long-enough-pass' });
  assert.equal(foreign.ok, false);
  assert.match(foreign.error, /nie należy/);
  const weak = installApp('joomla', { user, domain: 'example.com', adminPass: 'short' });
  assert.equal(weak.ok, false);
  assert.match(weak.error, /8 znaków/);
});

test('server backup restore restores settings and files from a real archive', async () => {
  const { createServerBackup, backupPath } = await import('../src/backups.mjs');
  const { restoreRun } = await import('../src/backupcenter.mjs');
  const admin = db.get("SELECT * FROM users WHERE username='demoadmin'");
  db.run("INSERT INTO settings(key,value) VALUES('restore_probe','before') ON CONFLICT(key) DO UPDATE SET value='before'");
  const b = createServerBackup(admin, 'all');
  assert.equal(b.ok, true, b.error);
  const rid = db.run("INSERT INTO backup_runs(job_id,filename,status,size_mb,local_path,started_at) VALUES(NULL,?,?,?,?,?)", b.filename, 'complete', b.size, backupPath(b.filename), new Date().toISOString()).lastInsertRowid;
  db.run("UPDATE settings SET value='after' WHERE key='restore_probe'");
  const r = restoreRun(rid, { dryRun: false, actor: 'demoadmin' });
  assert.equal(r.ok, true, r.error);
  assert.equal(db.get("SELECT value FROM settings WHERE key='restore_probe'").value, 'before');
  db.run("DELETE FROM settings WHERE key='restore_probe'");
  db.run('DELETE FROM backup_runs WHERE id = ?', rid);
  db.run('DELETE FROM backups WHERE filename = ?', b.filename);
  fs.rmSync(backupPath(b.filename), { force: true });
});

test('country email filter stores policy and reports GeoIP support', async () => {
  const cookie = await loginAs('demoadmin');
  const page = await (await fetch(base + '/admin/mail?tab=settings', { headers: { Cookie: cookie } })).text();
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const r = await fetch(base + '/admin/mail/countries', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, country: 'ru' }).toString(),
  });
  assert.equal(r.status, 302);
  assert.ok(db.get("SELECT * FROM country_email_policy WHERE country='ru'"));
  const del = await fetch(base + '/admin/mail/countries/ru/delete', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  assert.equal(del.status, 302);
  assert.equal(db.get("SELECT * FROM country_email_policy WHERE country='ru'"), null);
});

test('no rendered form leaks escaped field markup', async () => {
  const admin = await loginAs('demoadmin');
  const user = await loginAs('demouser');
  const adminRoutes = ['/admin/security?tab=firewall', '/admin/security?tab=ssh', '/admin/security?tab=keys', '/admin/security?tab=policy', '/admin/security?tab=groups', '/admin/security?tab=waf', '/admin/mail?tab=filters', '/admin/mail?tab=routing', '/admin/mail?tab=smtp', '/admin/mail?tab=settings', '/admin/backup-center?tab=servers', '/admin/backup-center?tab=jobs', '/admin/php?tab=ini', '/admin/php?tab=fpm', '/admin/plans?tab=sets', '/admin/dns-ops?tab=mx', '/admin/dns-ops?tab=templates', '/admin/import-live', '/admin/api-keys', '/admin/notifications?tab=channels', '/admin/reseller-tools?tab=plans', '/admin/support-access', '/admin/ssl-center', '/admin/log-center?tab=rotation', '/admin/storage', '/admin/panel-config?tab=branding', '/admin/panel-config?tab=access', '/admin/user-tools?tab=skeleton', '/admin/postgres', '/admin/multiserver'];
  for (const route of adminRoutes) {
    const html = await (await fetch(base + route, { headers: { Cookie: admin } })).text();
    assert.doesNotMatch(html, /value="&lt;div class="field|&lt;label class="field-label"/, `escaped form markup in ${route}`);
  }
  for (const route of ['/user/app-catalog', '/user/webdisk', '/user/interface', '/user/php', '/user/domains/create', '/user/email/new']) {
    const html = await (await fetch(base + route, { headers: { Cookie: user } })).text();
    assert.doesNotMatch(html, /value="&lt;div class="field|&lt;label class="field-label"/, `escaped form markup in ${route}`);
  }
});

test('admin DNS record has working edit and update', async () => {
  const cookie = await loginAs('demoadmin');
  const rec = db.get("SELECT r.* FROM dns_records r JOIN domains d ON d.id=r.domain_id WHERE d.name='example.com' AND r.type='A' AND r.name='@'");
  assert.ok(rec);
  const page = await (await fetch(base + `/admin/dns?domain=example.com&edit=${rec.id}`, { headers: { Cookie: cookie } })).text();
  assert.match(page, /Edit record/);
  assert.doesNotMatch(page, /value="&lt;div class="field/);
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const r = await fetch(base + `/admin/dns/${rec.id}/update`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, name: '@', type: 'A', value: '192.0.2.55', ttl: '600' }).toString(),
  });
  assert.equal(r.status, 302);
  const updated = db.get('SELECT * FROM dns_records WHERE id = ?', rec.id);
  assert.equal(updated.value, '192.0.2.55');
  assert.equal(updated.ttl, 600);
});

test('primary user CRUD resources support update', async () => {
  const cookie = await loginAs('demouser');
  const domain = db.get("SELECT * FROM domains WHERE username='demouser' LIMIT 1");
  let page = await (await fetch(base + `/user/domains/${domain.id}/edit`, { headers: { Cookie: cookie } })).text();
  assert.match(page, /Edit domain/);
  let csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  await fetch(base + `/user/domains/${domain.id}/update`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, php_version: '8.4', ssl: '1' }).toString(),
  });
  assert.equal(db.get('SELECT php_version FROM domains WHERE id=?', domain.id).php_version, '8.4');

  const mail = db.get("SELECT * FROM email_accounts WHERE domain='example.com' LIMIT 1");
  page = await (await fetch(base + `/user/email?domain=example.com&edit=${mail.id}`, { headers: { Cookie: cookie } })).text();
  csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  await fetch(base + `/user/email/${mail.id}/update`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, quota_mb: '2048' }).toString(),
  });
  assert.equal(db.get('SELECT quota_mb FROM email_accounts WHERE id=?', mail.id).quota_mb, 2048);

  const cronId = db.run('INSERT INTO cron_jobs(user_id,minute,hour,day,month,weekday,command,created_at) VALUES(?,?,?,?,?,?,?,?)', db.get("SELECT * FROM users WHERE username='demouser'").id, '0', '*', '*', '*', '*', '/bin/true', new Date().toISOString()).lastInsertRowid;
  page = await (await fetch(base + `/user/cron?edit=${cronId}`, { headers: { Cookie: cookie } })).text();
  csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  await fetch(base + `/user/cron/${cronId}/update`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, minute: '5', hour: '*', day: '*', month: '*', weekday: '*', command: '/bin/echo updated' }).toString(),
  });
  assert.equal(db.get('SELECT command FROM cron_jobs WHERE id=?', cronId).command, '/bin/echo updated');
  db.run('DELETE FROM cron_jobs WHERE id=?', cronId);

  const dbRow = db.get("SELECT * FROM databases WHERE user_id=(SELECT id FROM users WHERE username='demouser') LIMIT 1");
  page = await (await fetch(base + `/user/databases/${dbRow.id}/password`, { headers: { Cookie: cookie } })).text();
  assert.match(page, /Zmiana hasła/);
});

test('user and reseller catalog pages use visual tiles', async () => {
  const user = await loginAs('demouser');
  const dash = await (await fetch(base + '/user', { headers: { Cookie: user } })).text();
  assert.match(dash, /Wszystkie narzędzia/);
  assert.match(dash, /Strefy DNS/);
  assert.match(dash, /Bazy danych/);
  const catalog = await (await fetch(base + '/user/app-catalog', { headers: { Cookie: user } })).text();
  assert.match(catalog, /app-tile-grid/);
  assert.match(catalog, /PrestaShop/);
  assert.match(catalog, /WordPress/);
  assert.doesNotMatch(catalog, /&lt;div class="app-empty"/);
  const installer = await (await fetch(base + '/user/app-installer', { headers: { Cookie: user } })).text();
  assert.match(installer, /WordPress/);
  assert.match(installer, /app-tile-grid/);
  const reseller = await loginAs('demoreseller');
  const apps = await (await fetch(base + '/reseller/apps', { headers: { Cookie: reseller } })).text();
  assert.match(apps, /Aplikacje klientów/);
  assert.match(apps, /app-tile-grid/);
  const domains = await (await fetch(base + '/reseller/domains', { headers: { Cookie: reseller } })).text();
  assert.match(domains, /Domeny klientów/);
});

test('terminal commands return JSON without a page refresh and wizard has stepper hooks', async () => {
  const admin = await loginAs('demoadmin');
  const page = await (await fetch(base + '/user/terminal', { headers: { Cookie: admin } })).text();
  assert.match(page, /term-form/);
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const res = await fetch(base + '/user/terminal', {
    method: 'POST',
    headers: { Cookie: admin, Accept: 'application/json', 'X-Requested-With': 'fetch', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, command: 'pwd' }).toString(),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.match(json.output, /\$ pwd/);
  const wizard = await (await fetch(base + '/user/websites/new', { headers: { Cookie: admin } })).text();
  assert.match(wizard, /data-wizard/);
  assert.match(wizard, /data-wizard-indicator/);
  assert.match(wizard, /data-wizard-next/);
});

test('temporary suspension auto-unsuspends after its deadline', async () => {
  const username = `susp_${Date.now().toString(36)}`;
  const past = new Date(Date.now() - 60_000).toISOString();
  db.run(`INSERT INTO users(username, password, email, level, package, created_at, suspended, suspended_reason, suspended_until)
          VALUES(?,?,?,?,?,?,?,?,?)`, username, db.hashPassword('StrongPass123!'), `${username}@example.com`, 'user', 'default', db.nowIso(), 1, 'test', past);
  const scheduler = await import('../src/scheduler.mjs');
  const result = scheduler.schedulerTick({ now: Date.now(), limit: 0 });
  assert.ok((await result).auto_unsuspended >= 1);
  const row = db.get('SELECT * FROM users WHERE username = ?', username);
  assert.equal(row.suspended, 0);
  assert.equal(row.suspended_until, null);
  db.run('DELETE FROM users WHERE id = ?', row.id);
});

test('user statistics exposes disk breakdown and CSV/JSON export', async () => {
  const cookie = await loginAs('demouser');
  const page = await fetch(base + '/user/statistics', { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Zużycie dysku według typu/);
  assert.match(html, /Prognoza transferu/);
  const json = await fetch(base + '/user/statistics/export?format=json', { headers: { Cookie: cookie } });
  assert.equal(json.status, 200);
  const data = await json.json();
  assert.equal(data.username, 'demouser');
  assert.ok(Array.isArray(data.rows));
  const csv = await fetch(base + '/user/statistics/export?format=csv', { headers: { Cookie: cookie } });
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /^day,bandwidth_mb,disk_mb,emails,requests/);
});

test('streaming upload endpoint accepts raw bytes and reports progress metadata', async () => {
  const cookie = await loginAs('demouser');
  const page = await fetch(base + '/user/files', { headers: { Cookie: cookie } });
  const html = await page.text();
  const csrf = /meta name="csrf-token" content="([^"]+)"/.exec(html)?.[1];
  assert.ok(csrf, 'CSRF meta is present');
  const body = Buffer.from('raw streaming upload test');
  const res = await fetch(base + '/user/files/upload-stream?path=%2Fhome%2Fdemouser&name=stream-test.txt', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf }, body,
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.size, body.length);
});
