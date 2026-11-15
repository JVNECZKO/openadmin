// Reseller polish tests: control-center dashboard, scoped customer domains,
// real app installation guards, tickets, login-as and escaped-markup safety.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openadmin-reseller-test-'));
process.env.OA_DATA_DIR = dataDir;
process.env.OA_PORT = '0';
process.env.OA_IMAP_PORT = '0';
process.env.OA_HOST = '127.0.0.1';
process.env.OA_DEMO = '1';
process.env.OA_ADMIN_PASSWORD = 'admin-test-pass';
process.env.OA_SESSION_TTL = '24';

const serverMod = await import('../src/server.mjs');
const db = await import('../src/db.mjs');

let server;
let base;
let resellerCookie;
let demouser;
let foreignClient;
let foreignDomain;
let foreignTicket;
let pausedDomain;
let inactiveDomain;
let freshResellerCookie;

const stamp = Date.now();
const ts = db.nowIso();

async function form(url, fields, cookie = '') {
  return fetch(base + url, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
}

function cookieFrom(res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  return list.filter(Boolean).map((value) => value.split(';')[0]).join('; ');
}

async function loginAs(username, password = 'demo') {
  const res = await form('/login', { username, password });
  assert.equal(res.status, 302, `login for ${username} should redirect`);
  return cookieFrom(res);
}

async function getPage(url, cookie = resellerCookie) {
  const res = await fetch(base + url, { headers: { Cookie: cookie }, redirect: 'manual' });
  const html = await res.text();
  return { res, html };
}

function csrf(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'page should contain a CSRF token');
  return match[1];
}

function selectOptions(html, name) {
  return [...html.matchAll(new RegExp(`<select name="${name}"[^>]*>([\\s\\S]*?)<\\/select>`, 'g'))]
    .map((match) => [...match[1].matchAll(/value="([^"]*)"/g)].map((option) => option[1]));
}

function insertUser(username, { level, owner, packageName, email, suspended = 0 }) {
  const result = db.run(`INSERT INTO users(username, password, email, level, owner, package, domain, suspended, created_at, last_login, login_count)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`, username, db.hashPassword('demo'), email, level, owner, packageName, null, suspended, ts, ts, 1);
  return db.get('SELECT * FROM users WHERE id = ?', Number(result.lastInsertRowid));
}

function insertDomain(user, name, { ssl = 1, status = 'active', disk = 64 } = {}) {
  db.run(`INSERT INTO domains(user_id, username, name, docroot, php_version, ssl, status, is_main, ip, bandwidth_mb, disk_mb, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, user.id, user.username, name,
    `/home/${user.username}/domains/${name}/public_html`, '8.3', ssl, status, 0, '127.0.0.1', 128, disk, ts);
  return db.get('SELECT * FROM domains WHERE name = ?', name);
}

before(async () => {
  server = serverMod.start();
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  resellerCookie = await loginAs('demoreseller');
  demouser = db.get("SELECT * FROM users WHERE username = 'demouser'");
  assert.ok(demouser, 'demo seed contains demouser');
  db.run(`INSERT INTO app_installs(user_id, domain, path, type, version, admin_user, password_enc, data_dir, status, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, demouser.id, 'demo-site.org', '/', 'nextcloud', '30.0.1', 'admin', null, null, 'active', ts);

  // A customer owned by another reseller, including a ticket, proves that
  // customer-domain and ticket visibility really is scoped.
  const foreignReseller = insertUser(`foreignres${stamp}`, {
    level: 'reseller', owner: null, packageName: 'reseller_default', email: `foreignres${stamp}@example.test`,
  });
  foreignClient = insertUser(`foreignclient${stamp}`, {
    level: 'user', owner: foreignReseller.username, packageName: 'default', email: `foreignclient${stamp}@example.test`,
  });
  foreignDomain = insertDomain(foreignClient, `foreign-${stamp}.example`, { ssl: 0 });
  foreignTicket = Number(db.run(`INSERT INTO tickets(user_id, username, subject, department, priority, status, created_at, updated_at)
    VALUES(?,?,?,?,?,?,?,?)`, foreignClient.id, foreignClient.username, 'Foreign secret ticket', 'support', 'normal', 'open', ts, ts).lastInsertRowid);

  // A suspended customer must not be offered as an app-install target.
  const pausedClient = insertUser(`pausedclient${stamp}`, {
    level: 'user', owner: 'demoreseller', packageName: 'default', email: `paused${stamp}@example.test`, suspended: 1,
  });
  pausedDomain = insertDomain(pausedClient, `paused-${stamp}.example`, { ssl: 0, status: 'suspended' });

  // A domain can be inactive even when its owner is active: never install there.
  inactiveDomain = insertDomain(demouser, `inactive-${stamp}.example`, { ssl: 0, status: 'suspended' });

  // A fresh reseller has no customers: onboarding and empty states must render.
  insertUser(`freshreseller${stamp}`, {
    level: 'reseller', owner: null, packageName: 'reseller_default', email: `fresh${stamp}@example.test`,
  });
  freshResellerCookie = await loginAs(`freshreseller${stamp}`);
});

after(async () => {
  const { stopImap } = await import('../src/imap.mjs');
  stopImap();
  await new Promise((resolve) => server.close(resolve));
  db.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('reseller dashboard renders a real control center with KPIs and widgets', async () => {
  const { res, html } = await getPage('/reseller');
  assert.equal(res.status, 200);
  assert.match(html, /Pulpit resellera/);
  assert.match(html, /Klienci/);
  assert.match(html, /Domeny klientów/);
  assert.match(html, /Dodaj klienta/);
  assert.doesNotMatch(html, /Szybkie akcje/);
  assert.match(html, /Ostatnie zgłoszenia/);
  assert.match(html, /Ostatnie kopie klientów/);
  assert.match(html, /Aplikacje klientów/);
  assert.match(html, /Automatyzacja i kondycja/);
  assert.match(html, /Ostatnia aktywność/);
  assert.match(html, /data-auto-refresh="60"/);
  assert.match(html, /data-live-url="\/healthz"/);
  assert.match(html, /class="stat-grid"/);
  assert.match(html, /demouser/);
  assert.match(html, /pausedclient/);
  assert.match(html, /WordPress/);
  assert.match(html, /Nextcloud/);
  assert.doesNotMatch(html, /Something went wrong/);
});

test('reseller navigation does not duplicate the user menu', async () => {
  const { html } = await getPage('/reseller');
  const navMatch = html.match(/<nav class="nav"[\s\S]*?<\/nav>/);
  assert.ok(navMatch, 'sidebar navigation should render');
  const nav = navMatch[0];
  assert.doesNotMatch(nav, /href="\/user(?:\/|")/, 'reseller nav must not repeat user-level links');
  const hrefs = [...nav.matchAll(/class="nav-item[^"]*" href="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(hrefs.length > 10, 'reseller navigation should contain its own groups');
  assert.equal(new Set(hrefs).size, hrefs.length, 'navigation links must be unique');
  assert.ok(hrefs.includes('/reseller/domains'));
  assert.ok(hrefs.includes('/reseller/apps'));
  // The level switch is outside the main nav and keeps the User pill.
  assert.match(html, /class="level-switch"[\s\S]*href="\/user"/);
});

test('a fresh reseller gets onboarding and explicit empty states', async () => {
  const { res, html } = await getPage('/reseller', freshResellerCookie);
  assert.equal(res.status, 200);
  assert.match(html, /Zacznij tutaj/);
  assert.match(html, /Dodaj pierwszego klienta/);
  assert.match(html, /Nie masz jeszcze klientów/);
  assert.match(html, /z 6 gotowe/);
  assert.match(html, /Brak zgłoszeń od klientów/);
  assert.match(html, /Klienci nie mają jeszcze kopii zapasowych/);
  assert.match(html, /Żaden klient nie ma jeszcze zainstalowanej aplikacji/);
  assert.match(html, /Dodaj klienta/);
});

test('customer domains page supports search, status chips and scoped actions', async () => {
  const { res, html } = await getPage('/reseller/domains');
  assert.equal(res.status, 200);
  assert.match(html, /Domeny klientów/);
  assert.match(html, /data-filter-input="#resellerDomains"/);
  assert.match(html, /class="chip/);
  assert.match(html, /status=suspended/);
  assert.match(html, /status=ssl/);
  assert.match(html, /example\.com/);
  assert.match(html, /demo-site\.org/);
  assert.match(html, new RegExp(`paused-${stamp}\\.example`));
  assert.doesNotMatch(html, new RegExp(foreignDomain.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /users\/\d+\/login-as/);
  assert.match(html, /reseller\/apps\?domain=/);
  assert.match(html, /reseller\/dns\?domain=/);
  assert.match(html, /name="_csrf"/);
});

test('customer domain search and status filters narrow the result set', async () => {
  const search = await getPage('/reseller/domains?q=example');
  assert.equal(search.res.status, 200);
  assert.match(search.html, /example\.com/);
  assert.doesNotMatch(search.html, /demo-site\.org/);
  assert.doesNotMatch(search.html, new RegExp(foreignDomain.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const suspended = await getPage('/reseller/domains?status=suspended');
  assert.equal(suspended.res.status, 200);
  assert.match(suspended.html, new RegExp(`paused-${stamp}\\.example`));
  assert.doesNotMatch(suspended.html, /example\.com<\/a>/);

  const noSsl = await getPage('/reseller/domains?status=no-ssl');
  assert.equal(noSsl.res.status, 200);
  assert.match(noSsl.html, new RegExp(`paused-${stamp}\\.example`));

  const apps = await getPage('/reseller/domains?status=apps');
  assert.equal(apps.res.status, 200);
  assert.match(apps.html, /example\.com/);
  assert.match(apps.html, /demo-site\.org/);
});

test('customer domain page links resolve without broken destinations', async () => {
  const { html } = await getPage('/reseller/domains');
  const hrefs = [...new Set([...html.matchAll(/href="(\/reseller\/[^"#]*)"/g)]
    .map((match) => match[1].replace(/&amp;/g, '&')))]
    .filter((href) => !href.includes('/login-as'));
  assert.ok(hrefs.length > 0, 'page exposes reseller actions');
  for (const href of hrefs.slice(0, 20)) {
    const { res, html: target } = await getPage(href);
    assert.equal(res.status, 200, `${href} must resolve`);
    assert.doesNotMatch(target, /Something went wrong/, `${href} must not render an error page`);
  }
});

test('app installation only offers active customer domains', async () => {
  const { res, html } = await getPage('/reseller/apps');
  assert.equal(res.status, 200);
  assert.match(html, /Aplikacje klientów/);
  assert.match(html, /instalacja zakończona|Zainstaluj dla klienta/i);
  const selects = selectOptions(html, 'domain');
  assert.equal(selects.length, 6, 'one domain select per catalogue app');
  for (const options of selects) {
    assert.deepEqual([...options].sort(), ['demo-site.org', 'example.com']);
    assert.ok(!options.includes(foreignDomain.name), 'foreign domain must never be selectable');
    assert.ok(!options.includes(pausedDomain.name), 'suspended customer domain must not be selectable');
    assert.ok(!options.includes('reseller-demo.local'), 'reseller own domain must not be offered for customer installs');
  }
  const preselected = await getPage('/reseller/apps?domain=demo-site.org');
  assert.equal(preselected.res.status, 200);
  assert.match(preselected.html, /<option value="demo-site\.org" selected>/);
});

test('app installation rejects foreign, suspended and unknown targets without installing', async () => {
  const { html } = await getPage('/reseller/apps');
  const token = csrf(html);
  const wordpressBefore = db.get('SELECT COUNT(*) n FROM wordpress').n;
  const installsBefore = db.get('SELECT COUNT(*) n FROM app_installs').n;

  const cases = [
    { fields: { app: 'wordpress', domain: foreignDomain.name }, message: /nie należy do Twojego klienta/i },
    { fields: { app: 'wordpress', domain: 'reseller-demo.local' }, message: /nie należy do Twojego klienta/i },
    { fields: { app: 'wordpress', domain: pausedDomain.name }, message: /zawieszone/i },
    { fields: { app: 'wordpress', domain: inactiveDomain.name }, message: /zawieszone|nieaktywna/i },
    { fields: { app: 'not-a-real-app', domain: 'example.com' }, message: /Nieznana aplikacja/i },
    { fields: { app: 'wordpress', domain: 'example.com', admin_password: 'short' }, message: /co najmniej 8/i },
    { fields: { app: 'wordpress', domain: 'example.com', path: '/../etc' }, message: /Nieprawidłowa ścieżka/i },
    { fields: { app: 'nextcloud', domain: 'example.com', path: '/cloud' }, message: /katalogu głównym/i },
  ];

  for (const testCase of cases) {
    const res = await form('/reseller/apps/install', {
      _csrf: token,
      admin_user: 'admin',
      admin_password: 'long-enough-password',
      path: '/',
      ...testCase.fields,
    }, resellerCookie);
    assert.equal(res.status, 302, `${testCase.fields.app}/${testCase.fields.domain} should redirect with an error`);
    const location = decodeURIComponent(res.headers.get('location') || '');
    assert.match(location, /\/reseller\/apps\?flash=/, 'failure redirects back to the app catalogue');
    assert.match(location, testCase.message);
  }

  assert.equal(db.get('SELECT COUNT(*) n FROM wordpress').n, wordpressBefore, 'no WordPress row may be created');
  assert.equal(db.get('SELECT COUNT(*) n FROM app_installs').n, installsBefore, 'no app_installs row may be created');

  const noCsrf = await form('/reseller/apps/install', {
    app: 'wordpress', domain: 'example.com', admin_user: 'admin', admin_password: 'long-enough-password', path: '/',
  }, resellerCookie);
  assert.equal(noCsrf.status, 403, 'CSRF token remains mandatory');
});

test('installed apps overview shows icon, status and open link', async () => {
  const { res, html } = await getPage('/reseller/apps');
  assert.equal(res.status, 200);
  assert.match(html, /Zainstalowane aplikacje klientów/);
  assert.match(html, /class="app-installed"/);
  assert.match(html, /app-logo/);
  assert.match(html, /WordPress/);
  assert.match(html, /Nextcloud/);
  assert.match(html, /aktywna/);
  assert.match(html, /Otwórz/);
  assert.match(html, /https:\/\/example\.com\//);
  assert.match(html, /https:\/\/demo-site\.org\//);
  const expired = await getPage('/reseller/apps?install=not-a-real-token');
  assert.equal(expired.res.status, 200);
  assert.match(expired.html, /wygasł lub został już wykorzystany/);
  assert.doesNotMatch(expired.html, /Instalacja zakończona — dane jednorazowe/);
});

test('reseller pages return 200 and never leak escaped markup', async () => {
  const routes = [
    '/reseller', '/reseller/domains', '/reseller/domains?q=example&status=ssl',
    '/reseller/apps', '/reseller/apps?domain=example.com', '/reseller/statistics',
    '/reseller/dns', '/reseller/backups', '/reseller/tickets', '/reseller/users',
    '/reseller/packages', '/reseller/users/move', '/reseller/settings',
    '/reseller/ip-manager', '/reseller/nameservers', '/reseller/messages',
  ];
  for (const route of routes) {
    const { res, html } = await getPage(route);
    assert.equal(res.status, 200, `${route} should render`);
    assert.doesNotMatch(html, /Something went wrong/, `${route} rendered an error page`);
    assert.doesNotMatch(html, /&lt;(div|section|span|table|form|a) class=/, `${route} leaked escaped markup`);
    assert.doesNotMatch(html, /value="&lt;div class="field|&lt;label class="field-label"/, `${route} leaked escaped form fields`);
  }
  const dashboard = await getPage('/reseller');
  assert.match(dashboard.html, /class="stat-grid"/);
  const apps = await getPage('/reseller/apps');
  assert.match(apps.html, /class="app-tile-grid"/);
  const domains = await getPage('/reseller/domains');
  assert.match(domains.html, /chip-row/);
  const foreign = await getPage(`/reseller/apps?domain=${encodeURIComponent(foreignDomain.name)}`);
  assert.equal(foreign.res.status, 200);
  assert.doesNotMatch(foreign.html, new RegExp(foreignDomain.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('ticket visibility is scoped to the reseller customers', async () => {
  const list = await getPage('/reseller/tickets');
  assert.equal(list.res.status, 200);
  assert.doesNotMatch(list.html, /Foreign secret ticket/);

  const foreignView = await getPage(`/reseller/tickets/${foreignTicket}`);
  assert.equal(foreignView.res.status, 302, 'foreign ticket view must not render');
  assert.match(decodeURIComponent(foreignView.res.headers.get('location') || ''), /Nie znaleziono zgłoszenia/);

  const domainsPage = await getPage('/reseller/domains');
  const token = csrf(domainsPage.html);
  const reply = await form(`/reseller/tickets/${foreignTicket}/reply`, { _csrf: token, message: 'hijack' }, resellerCookie);
  assert.equal(reply.status, 302);
  assert.match(decodeURIComponent(reply.headers.get('location') || ''), /Nie znaleziono zgłoszenia/);
  assert.equal(db.get('SELECT COUNT(*) n FROM ticket_messages WHERE ticket_id = ?', foreignTicket).n, 0);

  const ownedTicket = db.get("SELECT * FROM tickets WHERE username = 'demouser' ORDER BY id LIMIT 1");
  assert.ok(ownedTicket, 'demo customer has a seeded ticket');
  const owned = await getPage(`/reseller/tickets/${ownedTicket.id}`);
  assert.equal(owned.res.status, 200);
  assert.match(owned.html, /Odpowiedź resellera/);
});

test('login-as opens an owned customer and rejects foreign accounts', async () => {
  const confirmation = await getPage(`/reseller/users/${demouser.id}/login-as`);
  assert.equal(confirmation.res.status, 200);
  assert.match(confirmation.html, /Zaloguj się jako klient/);
  const token = csrf(confirmation.html);

  const impersonate = await form(`/reseller/users/${demouser.id}/login-as`, { _csrf: token }, resellerCookie);
  assert.equal(impersonate.status, 302);
  assert.match(impersonate.headers.get('location') || '', /^\/user\?/);
  const customerCookie = cookieFrom(impersonate);
  assert.match(customerCookie, /OA_SESSION=/);
  const customerPage = await getPage('/user', customerCookie);
  assert.equal(customerPage.res.status, 200);
  assert.match(customerPage.html, /demouser/);

  const foreign = await form(`/reseller/users/${foreignClient.id}/login-as`, { _csrf: token }, resellerCookie);
  assert.equal(foreign.status, 302);
  assert.match(decodeURIComponent(foreign.headers.get('location') || ''), /tylko swojego klienta/);
  assert.equal(foreign.headers.get('set-cookie'), null, 'foreign login-as must not issue a session');
});

test('attacker-controlled ticket subjects are escaped in widgets', async () => {
  const xssId = Number(db.run(`INSERT INTO tickets(user_id, username, subject, department, priority, status, created_at, updated_at)
    VALUES(?,?,?,?,?,?,?,?)`, demouser.id, demouser.username, "<script>alert('xss')</script>", 'support', 'normal', 'open', ts, ts).lastInsertRowid);
  try {
    const { html } = await getPage('/reseller');
    assert.match(html, /&lt;script&gt;alert\(&#39;xss&#39;\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>alert\('xss'\)<\/script>/);
  } finally {
    db.run('DELETE FROM tickets WHERE id = ?', xssId);
  }
});
