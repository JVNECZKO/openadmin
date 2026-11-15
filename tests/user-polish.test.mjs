// User dashboard + unified app catalogue polish. Follows the same node:test /
// zero-dependency setup pattern as smoke.test.mjs: isolated OA_DATA_DIR, demo
// seed, real HTTP requests and real POST/CSRF checks.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openadmin-polish-test-'));
process.env.OA_DATA_DIR = dataDir;
process.env.OA_PORT = '0';
process.env.OA_IMAP_PORT = '0';
process.env.OA_HOST = '127.0.0.1';
process.env.OA_DEMO = '1';
process.env.OA_ADMIN_PASSWORD = 'admin-test-pass';
process.env.OA_SESSION_TTL = '2';

const serverMod = await import('../src/server.mjs');
const db = await import('../src/db.mjs');

let server;
let base;
let freshUserId = 0;

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
  return setCookie.filter(Boolean).map((cookie) => cookie.split(';')[0]).join('; ');
}

async function page(pathname, cookie) {
  const res = await fetch(base + pathname, { headers: { Cookie: cookie } });
  return { res, html: await res.text() };
}

before(async () => {
  server = serverMod.start();
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  freshUserId = db.run(
    'INSERT INTO users(username, password, email, level, package, created_at) VALUES(?,?,?,?,?,?)',
    'polishuser', db.hashPassword('demo'), 'polish@example.com', 'user', 'default', db.nowIso(),
  ).lastInsertRowid;
});

after(async () => {
  const { stopImap } = await import('../src/imap.mjs');
  stopImap();
  db.run('DELETE FROM sessions WHERE user_id = ?', freshUserId);
  db.run('DELETE FROM audit_log WHERE actor = ?', 'polishuser');
  db.run('DELETE FROM users WHERE id = ?', freshUserId);
  await new Promise((resolve) => server.close(resolve));
  db.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('user dashboard is a live overview without duplicate sections', async () => {
  const cookie = await loginAs('demouser');
  const { res, html } = await page('/user', cookie);
  assert.equal(res.status, 200);
  assert.match(html, /Pulpit/);

  // Live marker: a real server timestamp plus the generic shell hooks.
  assert.match(html, /id="user-live-status"/);
  assert.match(html, /data-auto-refresh="\d+"/);
  assert.match(html, /data-live-url="\/user"/);
  assert.match(html, /data-live-scope="dashboard"/);

  // Three recommendations and compact onboarding; no duplicate tool grid.
  assert.equal((html.match(/data-dashboard-app="/g) || []).length, 3);
  assert.match(html, /data-dashboard-app="wordpress"/);
  assert.match(html, /data-dashboard-app="nextcloud"/);
  assert.equal((html.match(/data-quick-action>/g) || []).length, 0);
  assert.equal((html.match(/data-all-tool>/g) || []).length, 0);
  assert.equal((html.match(/data-onboarding-step="/g) || []).length, 6);
  assert.equal((html.match(/Szybkie akcje/g) || []).length, 0);
  assert.equal((html.match(/Wszystkie narzędzia/g) || []).length, 0);

  // Resource meters expose a real state instead of a decorative 0% bar.
  assert.equal((html.match(/data-resource-meter="/g) || []).length, 6);
  assert.match(html, /data-resource-state="(W normie|Blisko limitu|Prawie pełny|Limit przekroczony|Bez limitu)"/);
  assert.match(html, /data-recent-activity/);
  assert.match(html, /data-automation-card/);

  // Every unfinished onboarding step points at a real action.
  assert.match(html, /href="\/user\/websites\/new"/);
  assert.match(html, /href="\/user\/2fa"/);
  assert.doesNotMatch(html, /value="&lt;div/);
  assert.doesNotMatch(html, /&lt;svg/);
});

test('fresh account onboarding links to all six real actions', async () => {
  const cookie = await loginAs('polishuser');
  const { res, html } = await page('/user', cookie);
  assert.equal(res.status, 200);
  const hrefs = [
    '/user/domains/create',
    '/user/websites/new',
    '/user/ssl',
    '/user/email/new',
    '/user/backups',
    '/user/2fa',
  ];
  for (const href of hrefs) assert.ok(html.includes(`href="${href}"`), `onboarding must link to ${href}`);
  assert.match(html, /0 z 6 gotowe/);
  assert.match(html, /Brak domen/);
  assert.equal((html.match(/data-dashboard-app="/g) || []).length, 3);
});

test('app catalogue exposes six searchable tiles with honest installed states', async () => {
  const cookie = await loginAs('demouser');
  const { res, html } = await page('/user/app-catalog', cookie);
  assert.equal(res.status, 200);
  assert.match(html, /Aplikacje/);
  assert.equal((html.match(/<article class="app-tile"/g) || []).length, 6);
  assert.equal((html.match(/data-app-key="/g) || []).length, 6);
  for (const name of ['WordPress', 'Nextcloud', 'PrestaShop', 'Joomla', 'Drupal', 'Moodle']) {
    assert.match(html, new RegExp(name));
  }
  assert.match(html, /data-app-installed="1"/);
  assert.match(html, /data-app-installed="0"/);
  assert.match(html, /Zainstalowane: 1/);
  assert.match(html, /Dostępna/);

  // Client-side name search and state chips, no extra framework/script file.
  assert.match(html, /type="search"[^>]*data-app-search|data-app-search[^>]*type="search"/);
  assert.match(html, /data-app-filter="all"/);
  assert.match(html, /data-app-filter="installed"/);
  assert.match(html, /data-app-filter="available"/);
  assert.match(html, /data-app-count/);
  assert.match(html, /data-app-no-results/);
  assert.match(html, /data-app-reset/);
  assert.match(html, /addEventListener\('input'/);

  // Version/type badges and the unified "Twoje aplikacje" list.
  assert.match(html, /Wersja: najnowsza/);
  assert.match(html, /Natywny instalator/);
  assert.match(html, /v8\.2\.1/);
  assert.match(html, /data-installed-app="wordpress"/);
  assert.match(html, /data-confirm="Usunąć/);

  // Real POST actions with CSRF, opened from an accessible install modal.
  assert.match(html, /action="\/user\/app-installer\/wordpress"/);
  assert.match(html, /action="\/user\/app-installer\/nextcloud"/);
  assert.match(html, /action="\/user\/app-catalog\/install"/);
  assert.equal((html.match(/data-install-form>/g) || []).length, 6);
  assert.equal((html.match(/data-install-submit/g) || []).length >= 6, true);
  assert.match(html, /data-install-status/);
  assert.match(html, /<div class="modal-backdrop"/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /name="_csrf"/);
  assert.doesNotMatch(html, /value="&lt;div/);
  assert.doesNotMatch(html, /&lt;svg/);
});

test('catalogue shows a real empty state and redirects the legacy installer URL', async () => {
  const cookie = await loginAs('polishuser');
  const { res, html } = await page('/user/app-catalog', cookie);
  assert.equal(res.status, 200);
  assert.match(html, /data-app-empty/);
  assert.match(html, /Nie masz jeszcze aplikacji/);
  assert.equal((html.match(/<article class="app-tile"/g) || []).length, 6);

  const redirect = await fetch(base + '/user/app-installer', { redirect: 'manual', headers: { Cookie: cookie } });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/user/app-catalog');
});

test('catalogue install endpoints keep CSRF and reject foreign domains', async () => {
  const cookie = await loginAs('demouser');
  const { html } = await page('/user/app-catalog', cookie);
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf, 'catalogue must render a CSRF token');

  const noCsrf = await form('/user/app-catalog/install', {
    app: 'joomla', domain: 'example.com', path: '/joomla', title: 'Test', admin_password: 'long-enough-pass',
  }, cookie);
  assert.equal(noCsrf.status, 403);

  const foreign = await form('/user/app-catalog/install', {
    _csrf: csrf, app: 'joomla', domain: 'not-owned.example', path: '/joomla', title: 'Test', admin_password: 'long-enough-pass',
  }, cookie);
  assert.equal(foreign.status, 302);
  assert.match(foreign.headers.get('location'), /^\/user\/app-catalog\?flash=/);
  assert.equal(db.get("SELECT id FROM app_installs WHERE domain = 'not-owned.example'"), null);

  const foreignWp = await form('/user/app-installer/wordpress', {
    _csrf: csrf, domain: 'not-owned.example', path: '/', title: 'Test', admin_password: 'long-enough-pass',
  }, cookie);
  assert.equal(foreignWp.status, 302);
  assert.match(foreignWp.headers.get('location'), /^\/user\/app-catalog\?flash=/);
  assert.equal(db.get("SELECT id FROM wordpress WHERE domain = 'not-owned.example'"), null);
});

test('automation card reflects real ACME/backup state without fake toggles', async () => {
  const cookie = await loginAs('demouser');
  let { html } = await page('/user', cookie);
  assert.match(html, /Automatyzacje/);
  assert.match(html, /Nieskonfigurowane/);
  assert.match(html, /Brak zadania automatycznego/);
  assert.match(html, /href="\/user\/ssl\?tab=acme"/);
  assert.match(html, /href="\/user\/backups"/);
  assert.doesNotMatch(html, /name="auto_ssl"/);
  assert.doesNotMatch(html, /name="auto_backup"/);

  db.run("INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    'acme_demouser', JSON.stringify({ autorenew: '0', challenge: 'http-01', key_type: 'ec-256' }));
  const jobId = db.run(`INSERT INTO backup_jobs(name, scope, target_user, components, schedule, retention_days, enabled, created_at)
    VALUES(?,?,?,?,?,?,?,?)`, 'Polish test job', 'user', 'demouser', '[]', 'weekly', 14, 1, db.nowIso()).lastInsertRowid;
  try {
    ({ html } = await page('/user', cookie));
    assert.match(html, /Wyłączone/);
    assert.match(html, /co tydzień/);
    assert.match(html, /Zaplanowane/);

    db.run("UPDATE settings SET value = ? WHERE key = ?", JSON.stringify({ autorenew: '1', challenge: 'http-01' }), 'acme_demouser');
    ({ html } = await page('/user', cookie));
    assert.match(html, /Włączone/);
  } finally {
    db.run('DELETE FROM backup_jobs WHERE id = ?', jobId);
    db.run('DELETE FROM settings WHERE key = ?', 'acme_demouser');
  }
});

test('appIcon renders safe inline SVG at 40 and 52 px', async () => {
  const { appIcon, appName } = await import('../src/ui/appicons.mjs');
  const small = appIcon('wordpress', { size: 40 }).value;
  const large = appIcon('nextcloud', { size: 52 }).value;
  for (const [markup, size] of [[small, 40], [large, 52]]) {
    assert.match(markup, new RegExp(`width="${size}"`));
    assert.match(markup, /data-app-icon="(wordpress|nextcloud)"/);
    assert.match(markup, /aria-hidden="true"/);
    assert.match(markup, /focusable="false"/);
    assert.match(markup, /<svg/);
    assert.doesNotMatch(markup, /&lt;/);
    assert.doesNotMatch(markup, /<img/);
  }
  const hardened = appIcon('wordpress', { cls: 'tile-logo evil" onclick="alert(1)' }).value;
  assert.match(hardened, /class="app-logo tile-logo"/);
  assert.doesNotMatch(hardened, /onclick/);
  assert.match(appIcon('unknown-app').value, /data-app-icon="generic"/);
  assert.equal(appName('unknown-app'), 'Aplikacja');
});
