// Site provisioning: coherent domain + engine + DNS + subdomains + SSL + vhost.
// The test gets its own OA_DATA_DIR so it can run in parallel with the smoke suite.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openadmin-provisioning-test-'));
process.env.OA_DATA_DIR = dataDir;
process.env.OA_PORT = '0';
process.env.OA_HOST = '127.0.0.1';
process.env.OA_DEMO = '1';
process.env.OA_ADMIN_PASSWORD = 'admin-test-pass';
process.env.OA_SESSION_TTL = '2';
process.env.OA_IMAP_PORT = String(20000 + (process.pid % 20000));
process.env.OA_PROVIDER = 'sandbox';

const serverMod = await import('../src/server.mjs');
const db = await import('../src/db.mjs');
const provisioning = await import('../src/provisioning.mjs');

let server;
let base;
const state = { engineDomains: {}, firstDomain: '', firstDomainId: null };
const stamp = `${Date.now().toString(36)}-${process.pid}`;

async function postForm(url, entries, cookie = '') {
  const params = new URLSearchParams();
  for (const [key, value] of entries) params.append(key, String(value));
  return fetch(base + url, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
    body: params.toString(),
  });
}

async function loginAs(username = 'demouser', password = 'demo') {
  const res = await postForm('/login', [['username', username], ['password', password]]);
  assert.equal(res.status, 302, `login for ${username} should redirect`);
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  return cookies.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
}

async function getPage(url, cookie) {
  const res = await fetch(base + url, { headers: { Cookie: cookie } });
  return { res, html: await res.text() };
}

function csrfOf(html) {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, 'page contains a CSRF token');
  return match[1];
}

function stagedVhost(engine, domain) {
  return path.join(dataDir, 'webserver', engine, 'sites', `${domain}.conf`);
}

function docrootOf(domain, sub = '') {
  return path.join(dataDir, 'homes', 'demouser', 'domains', domain, 'public_html', sub);
}

function userRow(username = 'demouser') {
  return db.get('SELECT * FROM users WHERE username = ?', username);
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

test('createSite provisions every engine, persists the override and reports vhost/dns steps', () => {
  const user = userRow();
  for (const engine of ['nginx', 'apache', 'openlitespeed', 'litespeed']) {
    const domain = `engine-${engine}-${stamp}.example`;
    const lite = engine === 'openlitespeed' || engine === 'litespeed';
    const result = provisioning.createSite({
      user, domain, engine, phpVersion: '8.3', sslMode: 'none', createDns: true,
      subdomains: lite ? ['cloud'] : [],
    });
    assert.equal(result.ok, true, `${engine}: ${JSON.stringify(result.errors)}`);
    assert.equal(result.created, true, `${engine}: a new domain row is created`);
    assert.equal(result.engine, engine);
    assert.equal(db.setting(`web_server:${domain}`), engine, `${engine}: web_server:<domain> persisted`);
    const row = db.get('SELECT * FROM domains WHERE name = ?', domain);
    assert.ok(row, `${engine}: domain row exists`);
    assert.equal(row.username, 'demouser');
    assert.ok(docrootOf(domain) && fs.existsSync(path.join(docrootOf(domain), 'index.html')), `${engine}: docroot index exists`);
    const records = db.get('SELECT COUNT(*) n FROM dns_records WHERE domain_id = ?', row.id).n;
    assert.ok(records >= 5, `${engine}: DNS records exist (${records})`);
    assert.ok(fs.existsSync(stagedVhost(engine, domain)), `${engine}: staged vhost file exists`);
    assert.match(fs.readFileSync(stagedVhost(engine, domain), 'utf8'), new RegExp(domain.replace(/\./g, '\\.')));
    if (lite) {
      const subVhost = path.join(dataDir, 'webserver', engine, 'sites', `cloud.${domain}.conf`);
      assert.ok(fs.existsSync(subVhost), `${engine}: separate subdomain vhost exists`);
      assert.match(fs.readFileSync(subVhost, 'utf8'), /cloud\./);
      assert.match(fs.readFileSync(subVhost, 'utf8'), new RegExp(`docRoot\\s+\\/home\\/demouser\\/domains\\/${domain.replace(/\./g, '\\.')}\\/public_html\\/cloud`));
    }
    const keys = result.steps.map((step) => step.key);
    assert.ok(keys.includes('vhost'), `${engine}: result includes vhost step`);
    assert.ok(keys.includes('dns'), `${engine}: result includes dns step`);
    assert.ok(keys.includes('docroot'), `${engine}: result includes docroot step`);
    assert.equal(result.steps.find((step) => step.key === 'vhost').ok, true, `${engine}: vhost step ok`);
    assert.equal(result.steps.find((step) => step.key === 'dns').ok, true, `${engine}: dns step ok`);
    assert.equal(result.steps.find((step) => step.key === 'dns').skipped, undefined);
    state.engineDomains[engine] = { domain, id: row.id };
    if (!state.firstDomain) { state.firstDomain = domain; state.firstDomainId = row.id; }
  }
  // The vhost step must come after the DNS/subdomain/SSL work it depends on.
  const order = state.engineDomains.nginx
    ? provisioning.lastProvision(state.engineDomains.nginx.domain)?.steps.map((step) => step.key) || []
    : [];
  assert.ok(order.indexOf('dns') < order.indexOf('vhost'), 'dns step precedes vhost');
});

test('subdomains create rows, document roots, DNS A records and engine vhosts', () => {
  const user = userRow();
  const domain = `subs-${stamp}.example`;
  const result = provisioning.createSite({
    user, domain, engine: 'nginx', phpVersion: '8.3', sslMode: 'none', createDns: true,
    subdomains: ['blog', 'shop'],
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const row = db.get('SELECT * FROM domains WHERE name = ?', domain);
  assert.ok(row);
  const subs = db.all('SELECT * FROM subdomains WHERE domain_id = ? ORDER BY name', row.id);
  assert.deepEqual(subs.map((s) => s.name), ['blog', 'shop']);
  const ip = db.setting('server_ip', '127.0.0.1');
  for (const name of ['blog', 'shop']) {
    const a = db.get("SELECT * FROM dns_records WHERE domain_id = ? AND name = ? AND type = 'A'", row.id, name);
    assert.ok(a, `${name}: DNS A record exists`);
    assert.equal(a.value, ip);
    assert.ok(fs.existsSync(path.join(docrootOf(domain, name), 'index.html')), `${name}: subdomain docroot exists`);
  }
  const vhost = fs.readFileSync(stagedVhost('nginx', domain), 'utf8');
  assert.match(vhost, new RegExp(`server_name blog\\.${domain.replace(/\./g, '\\.')}`));
  assert.match(vhost, new RegExp(`server_name shop\\.${domain.replace(/\./g, '\\.')}`));
  const subStep = result.steps.find((step) => step.key === 'subdomains');
  assert.ok(subStep?.ok, 'subdomains step ok');
  assert.equal(subStep.subdomains.length, 2);
});

test('createSite is idempotent for an existing domain', () => {
  const user = userRow();
  const { domain, id } = state.engineDomains.nginx;
  const beforeRecords = db.get('SELECT COUNT(*) n FROM dns_records WHERE domain_id = ?', id).n;
  const beforeSubs = db.get('SELECT COUNT(*) n FROM subdomains WHERE domain_id = ?', id).n;
  const result = provisioning.createSite({
    user, domain, engine: 'nginx', phpVersion: '8.3', sslMode: 'none', createDns: true,
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.created, false);
  assert.match(result.steps.find((step) => step.key === 'domain').detail, /already exists/);
  assert.equal(db.get('SELECT COUNT(*) n FROM dns_records WHERE domain_id = ?', id).n, beforeRecords, 'no duplicate DNS records');
  assert.equal(db.get('SELECT COUNT(*) n FROM subdomains WHERE domain_id = ?', id).n, beforeSubs, 'no duplicate subdomains');
  assert.equal(db.setting(`web_server:${domain}`), 'nginx');
});

test('invalid engine, invalid domain and foreign domain are rejected before mutation', () => {
  const user = userRow();
  const countBefore = db.get('SELECT COUNT(*) n FROM domains').n;

  const badEngine = provisioning.createSite({ user, domain: `bad-engine-${stamp}.example`, engine: 'iis', sslMode: 'none' });
  assert.equal(badEngine.ok, false);
  assert.equal(badEngine.errors[0].code, 'invalid_engine');
  assert.equal(db.get('SELECT id FROM domains WHERE name = ?', `bad-engine-${stamp}.example`), null);

  const badDomain = provisioning.createSite({ user, domain: 'not a domain', engine: 'nginx', sslMode: 'none' });
  assert.equal(badDomain.ok, false);
  assert.equal(badDomain.errors[0].code, 'invalid_domain');

  const reseller = userRow('demoreseller');
  const foreign = provisioning.createSite({ user: reseller, domain: 'example.com', engine: 'nginx', sslMode: 'none' });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.errors[0].code, 'foreign_domain');
  assert.equal(db.get('SELECT COUNT(*) n FROM domains').n, countBefore, 'rejections create no domain rows');
  assert.equal(db.setting('web_server:example.com', ''), '', 'foreign domain override untouched');

  const badSub = provisioning.createSite({
    user, domain: `bad-sub-${stamp}.example`, engine: 'nginx', sslMode: 'none', subdomains: ['bad name'],
  });
  assert.equal(badSub.ok, false);
  assert.equal(badSub.errors.some((error) => error.code === 'invalid_subdomain'), true);
  assert.equal(db.get('SELECT id FROM domains WHERE name = ?', `bad-sub-${stamp}.example`), null);

  const badPhp = provisioning.createSite({ user, domain: `bad-php-${stamp}.example`, engine: 'nginx', sslMode: 'none', phpVersion: '4.4' });
  assert.equal(badPhp.ok, false);
  assert.equal(badPhp.errors[0].code, 'invalid_php');
});

test('editing engine/PHP through the domain form persists settings and redeploys the vhost', async () => {
  const cookie = await loginAs();
  const { domain, id } = state.engineDomains.nginx;
  const edit = await getPage(`/user/domains/${id}/edit`, cookie);
  assert.equal(edit.res.status, 200);
  assert.match(edit.html, /data-engine-card="nginx"/);
  assert.match(edit.html, /data-engine-card="apache"/);
  assert.match(edit.html, /Save and redeploy/);
  const csrf = csrfOf(edit.html);

  const update = await postForm(`/user/domains/${id}/update`, [
    ['_csrf', csrf],
    ['engine', 'apache'],
    ['php_version', '8.4'],
    ['ssl_mode', 'keep'],
  ], cookie);
  assert.equal(update.status, 302);
  assert.match(update.headers.get('location'), new RegExp(`/user/domains/${id}/edit`));
  assert.equal(db.setting(`web_server:${domain}`), 'apache', 'engine override changed');
  assert.equal(db.get('SELECT php_version FROM domains WHERE id = ?', id).php_version, '8.4');
  assert.ok(fs.existsSync(stagedVhost('apache', domain)), 'apache vhost generated');
  assert.match(fs.readFileSync(stagedVhost('apache', domain), 'utf8'), /Apache vhost/);
  assert.equal(fs.existsSync(stagedVhost('nginx', domain)), false, 'stale nginx staging removed');

  const updated = await getPage(`/user/domains/${id}/edit?updated=1`, cookie);
  assert.equal(updated.res.status, 200);
  assert.match(updated.html, /Deployment status/);
  assert.match(updated.html, /data-step="vhost"/);
  assert.match(updated.html, /data-step="engine"/);
  assert.match(updated.html, /Apache HTTP Server/);
  assert.match(updated.html, /Domain saved/);
  assert.doesNotMatch(updated.html, /&lt;div class="field|&lt;label class="field-label"/);
});

test('website wizard shows all four engines with real availability badges and no escaped HTML', async () => {
  const cookie = await loginAs();
  const page = await getPage('/user/websites/new', cookie);
  assert.equal(page.res.status, 200);
  for (const engine of ['nginx', 'apache', 'openlitespeed', 'litespeed']) {
    assert.match(page.html, new RegExp(`data-engine-card="${engine}"`), `${engine} card present`);
  }
  for (const label of ['Nginx', 'Apache HTTP Server', 'OpenLiteSpeed', 'LiteSpeed Enterprise']) {
    assert.match(page.html, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${label} label present`);
  }
  for (const step of ['1', '2', '3', '4']) assert.match(page.html, new RegExp(`data-wizard-step="${step}"`));
  assert.match(page.html, /data-add-subdomain/);
  assert.match(page.html, /subdomains\[\]/);
  assert.match(page.html, /sandbox/); // real detection in the isolated sandbox
  assert.match(page.html, /name="app"/);
  assert.doesNotMatch(page.html, /&lt;div class="field|&lt;label class="field-label"|&lt;section class="card/);

  const csrf = csrfOf(page.html);
  const domain = `wizard-${stamp}.example`;
  const res = await postForm('/user/websites/new', [
    ['_csrf', csrf],
    ['domain', domain],
    ['engine', 'apache'],
    ['php_version', '8.3'],
    ['ssl_mode', 'none'],
    ['create_dns', '1'],
    ['subdomains[]', 'blog'],
    ['subdomains[]', 'shop'],
    ['app', 'none'],
  ], cookie);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Wynik provisioningu/);
  assert.match(html, /Kroki wdrożenia/);
  assert.match(html, /Apache HTTP Server/);
  assert.match(html, /data-step="vhost"/);
  assert.match(html, /data-step="dns"/);
  assert.match(html, /data-step="subdomains"/);
  assert.match(html, new RegExp(`/user/files\\?path=${encodeURIComponent(`/home/demouser/domains/${domain}/public_html`).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(html, new RegExp(`/user/dns\\?domain=${domain}`));
  assert.match(html, new RegExp(`/user/ssl\\?domain=${domain.replace(/\./g, '\\.')}`));
  assert.match(html, new RegExp(`/user/email/new\\?domain=${domain.replace(/\./g, '\\.')}`));
  assert.doesNotMatch(html, /Something went wrong|&lt;div class="field|&lt;label class="field-label"/);

  const row = db.get('SELECT * FROM domains WHERE name = ?', domain);
  assert.ok(row, 'wizard created the domain row');
  assert.equal(db.setting(`web_server:${domain}`), 'apache');
  assert.equal(db.get('SELECT COUNT(*) n FROM subdomains WHERE domain_id = ?', row.id).n, 2);
  const a = db.get("SELECT * FROM dns_records WHERE domain_id = ? AND name = 'blog' AND type = 'A'", row.id);
  assert.ok(a, 'wizard subdomain DNS A record exists');
  assert.ok(fs.existsSync(stagedVhost('apache', domain)), 'wizard generated the apache vhost');
});

test('domain create uses createSite backend, and delete cleans vhost/docroot/DNS', async () => {
  const cookie = await loginAs();
  const createPage = await getPage('/user/domains/create', cookie);
  assert.equal(createPage.res.status, 200);
  assert.match(createPage.html, /data-engine-card="openlitespeed"/);
  assert.match(createPage.html, /ssl_mode/);
  assert.doesNotMatch(createPage.html, /&lt;div class="field|&lt;label class="field-label"/);
  const createCsrf = csrfOf(createPage.html);

  const domain = `domain-create-${stamp}.example`;
  const create = await postForm('/user/domains/create', [
    ['_csrf', createCsrf],
    ['domain', domain],
    ['engine', 'openlitespeed'],
    ['php_version', '8.3'],
    ['ssl_mode', 'none'],
    ['create_dns', '1'],
  ], cookie);
  assert.equal(create.status, 302);
  assert.equal(db.setting(`web_server:${domain}`), 'openlitespeed');
  const row = db.get('SELECT * FROM domains WHERE name = ?', domain);
  assert.ok(row, 'domain create route persisted the row');
  assert.ok(fs.existsSync(stagedVhost('openlitespeed', domain)), 'domain create route generated the OLS vhost');
  assert.ok(fs.existsSync(path.join(docrootOf(domain), 'index.html')), 'domain create route provisioned the docroot');

  const edit = await getPage(`/user/domains/${row.id}/edit`, cookie);
  const deleteCsrf = csrfOf(edit.html);
  const removed = await postForm(`/user/domains/${row.id}/delete`, [['_csrf', deleteCsrf]], cookie);
  assert.equal(removed.status, 302);
  assert.equal(db.get('SELECT id FROM domains WHERE name = ?', domain), null);
  assert.equal(db.get('SELECT COUNT(*) n FROM dns_records WHERE domain_id = ?', row.id).n, 0);
  assert.equal(fs.existsSync(stagedVhost('openlitespeed', domain)), false, 'staged vhost removed');
  assert.equal(fs.existsSync(path.join(dataDir, 'homes', 'demouser', 'domains', domain)), false, 'domain docroot removed');
  assert.equal(db.setting(`web_server:${domain}`, ''), '', 'engine override cleaned');
});

test('self-signed SSL is applied before vhost generation and appears in the config', () => {
  const user = userRow();
  const domain = `ssl-${stamp}.example`;
  const result = provisioning.createSite({
    user, domain, engine: 'nginx', phpVersion: '8.3', sslMode: 'selfsigned', createDns: false,
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(db.get('SELECT ssl FROM domains WHERE name = ?', domain).ssl, 1);
  const sslStep = result.steps.find((step) => step.key === 'ssl');
  assert.ok(sslStep?.ok);
  assert.match(sslStep.detail, /Self-signed/i);
  const vhost = fs.readFileSync(stagedVhost('nginx', domain), 'utf8');
  assert.match(vhost, /listen 443 ssl/);
  assert.match(vhost, /ssl_certificate\s+\//);
  const dnsStep = result.steps.find((step) => step.key === 'dns');
  assert.equal(dnsStep.skipped, true, 'DNS not requested');
  assert.match(result.links.site, /^https:\/\//);

  const disabled = provisioning.createSite({
    user, domain, engine: 'nginx', phpVersion: '8.3', sslMode: 'none', createDns: false,
  });
  assert.equal(disabled.ok, true, JSON.stringify(disabled.errors));
  assert.equal(disabled.created, false);
  assert.equal(db.get('SELECT ssl FROM domains WHERE name = ?', domain).ssl, 0);
  assert.equal(db.get("SELECT id FROM ssl_certs WHERE domain = ? AND status = 'active'", domain), null, 'active certificate disabled');
  assert.doesNotMatch(fs.readFileSync(stagedVhost('nginx', domain), 'utf8'), /listen 443 ssl/, 'vhost redeployed without TLS');
});
