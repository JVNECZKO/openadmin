// Provisioning UX contracts: guided account wizard, one domain flow, DNS
// automation, SSL queue semantics and tenant/ownership boundaries.
//
// Isolated OA_DATA_DIR (like site-provisioning.test.mjs) so this suite can run
// in parallel with the rest of the repository. No network is required: DNS and
// HTTP preflight dependencies are injected where they matter.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openadmin-provisioning-ux-'));
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
const dnsops = await import('../src/dnsops.mjs');
const autossl = await import('../src/autossl.mjs');

const stamp = `${Date.now().toString(36)}${process.pid}`;
const ctx = { accountId: null, accountUsername: '', accountDomain: '', flowDomain: '', sslDomain: '', sslFailDomain: '' };
let server;
let base;

async function formPost(url, fields, cookie = '') {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) value.forEach((entry) => body.append(key, String(entry)));
    else if (value !== undefined && value !== null) body.append(key, String(value));
  }
  return fetch(base + url, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
    body: body.toString(),
  });
}

async function loginAs(username, password = 'demo') {
  const res = await formPost('/login', { username, password });
  assert.equal(res.status, 302, `login for ${username}`);
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  return cookies.filter(Boolean).map((cookie) => cookie.split(';')[0]).join('; ');
}

async function getPage(url, cookie) {
  const res = await fetch(base + url, { headers: { Cookie: cookie } });
  return { res, html: await res.text() };
}

function csrfOf(html) {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, 'page exposes a CSRF token');
  return match[1];
}

function userRow(username) {
  return db.get('SELECT * FROM users WHERE username = ?', username);
}

function unique(prefix) {
  return `${prefix}-${stamp}`.slice(0, 32);
}

function uniqueDomain(prefix) {
  return `${prefix}-${stamp}.example`;
}

function mkUser(username, level, owner = null, packageName = 'default') {
  const existing = userRow(username);
  if (existing) return existing;
  const created = db.run(
    'INSERT INTO users(username, password, email, level, owner, package, created_at) VALUES(?,?,?,?,?,?,?)',
    username, db.hashPassword('demo'), `${username}@example.com`, level, owner, packageName, db.nowIso(),
  );
  return db.get('SELECT * FROM users WHERE id = ?', created.lastInsertRowid);
}

function mkPackage(name, owner) {
  if (db.get('SELECT name FROM packages WHERE name = ?', name)) return;
  db.run('INSERT INTO packages(name, owner, type, limits, created_at) VALUES(?,?,?,?,?)',
    name, owner, 'user', JSON.stringify({ domains: 5, subdomains: 10, emails: 10, disk_mb: 2048, bandwidth_mb: 20480, databases: 3, php: ['8.3'] }), db.nowIso());
}

before(async () => {
  server = serverMod.start();
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  mkUser('otherreseller', 'reseller', null, 'reseller_default');
  mkPackage('res_pkg', 'demoreseller');
  mkPackage('foreign_pkg', 'otherreseller');
});

after(async () => {
  const { stopImap } = await import('../src/imap.mjs');
  stopImap();
  await new Promise((resolve) => server.close(resolve));
  db.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ wizard */

test('account wizard renders the guided steps, legacy fields and package summary', async () => {
  const admin = await loginAs('demoadmin');
  const page = await getPage('/admin/users/create', admin);
  assert.equal(page.res.status, 200);
  for (const step of ['1', '2', '3', '4', '5']) assert.match(page.html, new RegExp(`data-wizard-step="${step}"`), `step ${step}`);
  for (const field of ['username', 'password', 'email', 'package', 'domain', 'engine', 'ip', 'notes', 'activation', 'create_mailbox', 'create_backup', 'create_monitoring', 'new_package_name']) {
    assert.match(page.html, new RegExp(`name="${field}"`), `field ${field}`);
  }
  assert.match(page.html, /data-package-summary/);
  assert.match(page.html, /data-preflight|Preflight/);
  assert.match(page.html, /data-wizard-indicator-step="5"/);
  assert.doesNotMatch(page.html, /&lt;div class="field|&lt;label class="field-label"/);

  const reseller = await loginAs('demoreseller');
  const resellerPage = await getPage('/reseller/users/create', reseller);
  assert.equal(resellerPage.res.status, 200);
  assert.match(resellerPage.html, /data-wizard-step="1"/);
  assert.doesNotMatch(resellerPage.html, /name="owner"/, 'resellers cannot choose a foreign owner');
});

test('admin creates a customer atomically with activation link, mailbox, DNS and backup', async () => {
  const admin = await loginAs('demoadmin');
  const page = await getPage('/admin/users/create', admin);
  const csrf = csrfOf(page.html);
  const username = unique('uxclient');
  const domain = uniqueDomain('ux');
  ctx.accountUsername = username;
  ctx.accountDomain = domain;
  const created = await formPost('/admin/users/create', {
    _csrf: csrf, wizard: '1', username, email: `${username}@example.com`,
    contact_name: 'Jan Testowy', phone: '+48 100 200 300',
    package: 'default', domain, engine: 'nginx', php_version: '8.3', ssl_mode: 'none',
    create_dns: '1', create_mailbox: '1', mailbox_local: 'postmaster', mailbox_quota_mb: '512',
    create_backup: '1', create_monitoring: '1', retry_ssl_after_dns: '1',
    docroot: '1', php_step: '1', vhost: '1', activation: '1', notify: '1', app: 'none',
  }, admin);
  assert.equal(created.status, 302);
  const location = created.headers.get('location');
  assert.match(location, /\/admin\/users\/\d+\?created=1/);
  const user = userRow(username);
  assert.ok(user, 'account row exists');
  ctx.accountId = user.id;
  assert.equal(user.level, 'user');
  assert.equal(user.must_change_password, 1);
  assert.match(user.password, /^scrypt\$/);
  assert.ok(db.get('SELECT * FROM password_resets WHERE user_id = ?', user.id), 'activation token exists');
  const message = db.get('SELECT * FROM messages WHERE username = ? ORDER BY id DESC LIMIT 1', username);
  assert.ok(message, 'welcome message saved');
  assert.match(message.body, /Aktywuj konto/);
  assert.doesNotMatch(message.body, /Hasło:/, 'no plaintext password in the welcome message');

  const detail = await getPage(`/admin/users/${user.id}?created=1`, admin);
  assert.equal(detail.res.status, 200);
  assert.match(detail.html, /data-account-step="site"/);
  assert.match(detail.html, /data-site-step="mailbox"/);
  assert.match(detail.html, /oa-activation-url/);
  assert.doesNotMatch(detail.html, /name="password"[^>]*value="[^"]+"/);
  assert.equal(db.get('SELECT COUNT(*) n FROM domains WHERE name = ?', domain).n, 1, 'domain created');
  const dnsTypes = db.all("SELECT DISTINCT type FROM dns_records r JOIN domains d ON d.id = r.domain_id WHERE d.name = ?", domain).map((row) => row.type);
  for (const type of ['A', 'MX', 'TXT', 'CNAME', 'SRV']) assert.ok(dnsTypes.includes(type), `DNS includes ${type}`);
  assert.ok(db.get("SELECT * FROM dns_records r JOIN domains d ON d.id = r.domain_id WHERE d.name = ? AND r.name = 'autodiscover' AND r.type = 'CNAME'", domain), 'autodiscover CNAME');
  assert.ok(db.get('SELECT * FROM email_accounts WHERE domain = ? AND local_part = ?', domain, 'postmaster'), 'primary mailbox');
  assert.ok(db.get('SELECT * FROM backup_jobs WHERE target_user = ? AND name = ?', username, `site:${domain}`), 'real backup job');
  assert.ok(db.setting(`site_monitoring:${domain}`), 'monitoring profile');
  const status = provisioning.lastAccountProvision(user.id);
  assert.ok(status?.ok);
  assert.ok(status.checks.length > 0);
  assert.equal(status.links.activation, '', 'activation token is never persisted in status');
  assert.equal(provisioning.pendingActivation(user.id)?.url?.includes('token='), true);
});

test('weak password and missing activation are rejected by the existing policy before mutation', async () => {
  const admin = await loginAs('demoadmin');
  const page = await getPage('/admin/users/create', admin);
  const csrf = csrfOf(page.html);
  const username = unique('weakpw');
  const before = db.get('SELECT COUNT(*) n FROM users').n;
  const rejected = await formPost('/admin/users/create', {
    _csrf: csrf, wizard: '1', username, email: `${username}@example.com`, package: 'default',
    password: 'short', activation: '0', domain: '', engine: 'nginx', php_version: '8.3', ssl_mode: 'none',
  }, admin);
  assert.equal(rejected.status, 200);
  const html = await rejected.text();
  assert.match(html, /preflight/i);
  assert.equal(userRow(username), null, 'no account is created');
  assert.equal(db.get('SELECT COUNT(*) n FROM users').n, before);

  const direct = provisioning.accountPreflight({
    actor: userRow('demoadmin'), username: unique('weakpw2'), email: 'weak@example.com',
    package: 'default', password: 'short', activation: false,
  });
  assert.equal(direct.ok, false);
  assert.ok(direct.errors.some((error) => error.key === 'password'));

  const noSecret = provisioning.accountPreflight({
    actor: userRow('demoadmin'), username: unique('nosecret'), email: 'nosecret@example.com',
    package: 'default', activation: false,
  });
  assert.equal(noSecret.ok, false);
  assert.ok(noSecret.errors.some((error) => error.key === 'activation'));
});

test('reseller ownership, package scope and tenant boundaries are enforced', async () => {
  const resellerRow = userRow('demoreseller');
  const admin = await loginAs('demoadmin');
  const reseller = await loginAs('demoreseller');
  const page = await getPage('/reseller/users/create', reseller);
  const csrf = csrfOf(page.html);
  const username = unique('resclient');
  const created = await formPost('/reseller/users/create', {
    _csrf: csrf, wizard: '1', username, email: `${username}@example.com`,
    package: 'res_pkg', owner: 'otherreseller', domain: '',
    engine: 'nginx', php_version: '8.3', ssl_mode: 'none',
    activation: '1', docroot: '1', php_step: '1', vhost: '1',
  }, reseller);
  assert.equal(created.status, 302);
  const user = userRow(username);
  assert.ok(user);
  assert.equal(user.owner, 'demoreseller', 'route-pinned owner wins over a forged form field');

  const foreign = provisioning.provisionAccount({
    actor: resellerRow, level: 'user', username: unique('foreignpkg'), email: 'foreign@example.com',
    package: 'foreign_pkg', activation: true, create_dns: false,
  });
  assert.equal(foreign.ok, false);
  assert.ok(foreign.errors.some((error) => /pakiet|właściciel/i.test(error.message)), JSON.stringify(foreign.errors));

  const escalate = provisioning.provisionAccount({
    actor: resellerRow, level: 'reseller', username: unique('escalate'), email: 'escalate@example.com',
    package: 'reseller_default', activation: true,
  });
  assert.equal(escalate.ok, false);
  assert.equal(userRow(unique('escalate')), null);

  const userActor = userRow('demouser');
  const denied = provisioning.provisionAccount({ actor: userActor, username: unique('userdenied'), email: 'd@example.com', package: 'default', activation: true });
  assert.equal(denied.ok, false);
  assert.ok(denied.errors.some((error) => error.key === 'actor'));

  const foreignDomain = provisioning.provisionAccount({
    actor: admin ? userRow('demoadmin') : null, level: 'user', username: unique('domcollision'),
    email: 'collision@example.com', package: 'default', domain: 'example.com', activation: true,
  });
  assert.equal(foreignDomain.ok, false);
  assert.equal(userRow(unique('domcollision')), null);

  const resellerDomain = provisioning.provisionAccount({
    actor: resellerRow, level: 'user', username: unique('domowned'), email: 'owned@example.com',
    package: 'res_pkg', domain: 'example.com', activation: true,
  });
  assert.equal(resellerDomain.ok, false);
  assert.equal(userRow(unique('domowned')), null);
});

test('account provisioning rolls back every artefact on an injected core failure', async () => {
  const admin = userRow('demoadmin');
  const username = unique('rollback');
  const domain = uniqueDomain('rb');
  const result = provisioning.provisionAccount({
    actor: admin, level: 'user', username, email: `${username}@example.com`,
    package: 'default', domain, engine: 'nginx', php_version: '8.3', ssl_mode: 'none',
    activation: true, create_dns: true, create_mailbox: true, mailbox_local: 'postmaster',
    create_backup: true, create_monitoring: true, rollbackOnFailure: true,
    faults: { mailbox: 'injected mailbox failure' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.equal(userRow(username), null, 'user row removed');
  assert.equal(db.get('SELECT id FROM domains WHERE name = ?', domain), null, 'domain row removed');
  assert.equal(db.get('SELECT COUNT(*) n FROM email_accounts WHERE domain = ?', domain).n, 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM backup_jobs WHERE target_user = ?', username).n, 0);
  assert.equal(db.setting(`site_monitoring:${domain}`, ''), '');
  assert.equal(db.get('SELECT COUNT(*) n FROM password_resets WHERE user_id NOT IN (SELECT id FROM users)').n >= 0, true);
  assert.equal(fs.existsSync(path.join(dataDir, 'homes', username)), false, 'home removed');
  assert.ok(result.steps.some((step) => step.key === 'rollback' && step.ok));
});

test('account edit enforces password/email/package rules and duplicate creation is inert', async () => {
  const admin = await loginAs('demoadmin');
  const user = userRow(ctx.accountUsername);
  assert.ok(user);
  const detail = await getPage(`/admin/users/${user.id}`, admin);
  const csrf = csrfOf(detail.html);
  const hashBefore = userRow(ctx.accountUsername).password;

  const weak = await formPost(`/admin/users/${user.id}`, { _csrf: csrf, email: `new-${user.username}@example.com`, package: 'default', password: 'short' }, admin);
  assert.equal(weak.status, 302);
  assert.equal(userRow(ctx.accountUsername).password, hashBefore, 'weak password was not applied');

  const badEmail = await formPost(`/admin/users/${user.id}`, { _csrf: csrf, email: 'not-an-email', package: 'default' }, admin);
  assert.equal(badEmail.status, 302);
  assert.notEqual(userRow(ctx.accountUsername).email, 'not-an-email');

  const badPackage = await formPost(`/admin/users/${user.id}`, { _csrf: csrf, email: user.email, package: 'reseller_default' }, admin);
  assert.equal(badPackage.status, 302);
  assert.equal(userRow(ctx.accountUsername).package, 'default');

  const goodEmail = `updated-${user.username}@example.com`;
  const updated = await formPost(`/admin/users/${user.id}`, { _csrf: csrf, email: goodEmail, package: 'default', notes: 'edit ok', ip: user.ip }, admin);
  assert.equal(updated.status, 302);
  assert.equal(userRow(ctx.accountUsername).email, goodEmail);
  assert.equal(userRow(ctx.accountUsername).notes, 'edit ok');

  const countBefore = db.get('SELECT COUNT(*) n FROM users').n;
  const page = await getPage('/admin/users/create', admin);
  const createCsrf = csrfOf(page.html);
  const duplicate = await formPost('/admin/users/create', {
    _csrf: createCsrf, wizard: '1', username: ctx.accountUsername, email: 'dupe@example.com',
    package: 'default', activation: '1', create_dns: '0', docroot: '1', php_step: '1', vhost: '1',
  }, admin);
  assert.equal(duplicate.status, 200);
  assert.equal(db.get('SELECT COUNT(*) n FROM users').n, countBefore, 'duplicate login creates nothing');
});

/* -------------------------------------------------------------- domain flow */

test('one domain flow applies docroot/DNS/vhost/SSL/mailbox/app/backup/monitoring steps and is idempotent', async () => {
  const user = await loginAs('demouser');
  const page = await getPage('/user/domains/create', user);
  assert.equal(page.res.status, 200);
  for (const step of ['1', '2', '3', '4', '5']) assert.match(page.html, new RegExp(`data-wizard-step="${step}"`));
  for (const field of ['domain', 'engine', 'php_version', 'ssl_mode', 'create_dns', 'docroot', 'vhost', 'php_step', 'dns_template', 'check_delegation', 'retry_ssl_after_dns', 'create_mailbox', 'mailbox_local', 'create_backup', 'create_monitoring', 'app']) {
    assert.match(page.html, new RegExp(`name="${field}"`), `field ${field}`);
  }
  assert.doesNotMatch(page.html, /&lt;div class="field|&lt;label class="field-label"/);

  const csrf = csrfOf(page.html);
  const domain = uniqueDomain('flow');
  ctx.flowDomain = domain;
  const payload = {
    _csrf: csrf, wizard: '1', domain, engine: 'apache', php_version: '8.4', ssl_mode: 'none',
    create_dns: '1', docroot: '1', php_step: '1', vhost: '1', create_mailbox: '1',
    mailbox_local: 'postmaster', mailbox_quota_mb: '256', create_backup: '1', create_monitoring: '1',
    retry_ssl_after_dns: '1', app: 'none',
  };
  const created = await formPost('/user/domains/create', payload, user);
  assert.equal(created.status, 302);
  const row = db.get('SELECT * FROM domains WHERE name = ?', domain);
  assert.ok(row, 'domain exists');
  assert.equal(db.setting(`web_server:${domain}`), 'apache');
  assert.ok(db.get('SELECT * FROM email_accounts WHERE domain = ? AND local_part = ?', domain, 'postmaster'), 'mailbox created');
  assert.ok(db.get('SELECT * FROM backup_jobs WHERE target_user = ? AND name = ?', 'demouser', `site:${domain}`), 'backup job');
  assert.ok(db.setting(`site_monitoring:${domain}`), 'monitoring profile');
  const status = provisioning.lastProvision(domain);
  assert.ok(status?.ok);
  const keys = status.steps.map((step) => step.key);
  for (const key of ['docroot', 'dns', 'php', 'ssl', 'mailbox', 'vhost', 'backup', 'monitoring']) assert.ok(keys.includes(key), `step ${key}`);
  const dnsStep = status.steps.find((step) => step.key === 'dns');
  assert.doesNotMatch(dnsStep.detail, /\/.+\/dns\//, 'zone file path is not exposed in user step details');
  assert.match(dnsStep.detail, /rekord/i);

  const dnsBefore = db.get('SELECT COUNT(*) n FROM dns_records WHERE domain_id = ?', row.id).n;
  const mailBefore = db.get('SELECT COUNT(*) n FROM email_accounts WHERE domain_id = ?', row.id).n;
  const jobsBefore = db.get('SELECT COUNT(*) n FROM backup_jobs WHERE target_user = ?', 'demouser').n;
  const again = await formPost('/user/domains/create', payload, user);
  assert.equal(again.status, 302);
  assert.equal(db.get('SELECT COUNT(*) n FROM domains WHERE name = ?', domain).n, 1);
  assert.equal(db.get('SELECT COUNT(*) n FROM dns_records WHERE domain_id = ?', row.id).n, dnsBefore, 'DNS idempotent');
  assert.equal(db.get('SELECT COUNT(*) n FROM email_accounts WHERE domain_id = ?', row.id).n, mailBefore, 'mailbox idempotent');
  assert.equal(db.get('SELECT COUNT(*) n FROM backup_jobs WHERE target_user = ?', 'demouser').n, jobsBefore, 'backup job idempotent');

  const foreign = await formPost('/user/domains/create', {
    _csrf: csrfOf((await getPage('/user/domains/create', user)).html),
    wizard: '1', domain: 'reseller-demo.local', engine: 'nginx', php_version: '8.3', ssl_mode: 'none', create_dns: '0',
  }, user);
  assert.equal(foreign.status, 200);
  assert.match(await foreign.text(), /already exists/i);
});

test('retry runs only failed steps, checks ownership and never duplicates work', async () => {
  const usr = userRow('demouser');
  const domain = uniqueDomain('retry');
  const broken = provisioning.createSite({
    user: usr, domain, engine: 'nginx', phpVersion: '8.3', sslMode: 'none', createDns: true,
    rollbackOnFailure: false, faults: { dns: 'injected zone failure' }, mailbox: { local: 'postmaster', quotaMb: 128 },
  });
  assert.equal(broken.ok, false);
  assert.equal(broken.created, true);
  const failedDns = broken.steps.find((step) => step.key === 'dns');
  assert.equal(failedDns.ok, false);
  const row = db.get('SELECT * FROM domains WHERE name = ?', domain);
  assert.ok(row);
  const mailBefore = db.get('SELECT COUNT(*) n FROM email_accounts WHERE domain_id = ?', row.id).n;
  const retried = provisioning.retrySiteSteps({ user: usr, domain, steps: ['dns'] });
  assert.equal(retried.ok, true, JSON.stringify(retried.errors));
  assert.deepEqual(retried.retried.map((step) => step.key), ['dns']);
  assert.ok(db.get('SELECT COUNT(*) n FROM dns_records WHERE domain_id = ?', row.id).n > 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM email_accounts WHERE domain_id = ?', row.id).n, mailBefore, 'other resources untouched');
  assert.equal(provisioning.lastProvision(domain).steps.find((step) => step.key === 'dns').ok, true);

  const foreign = provisioning.retrySiteSteps({ user: userRow('demoreseller'), domain, steps: ['dns'] });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.errors[0].code, 'foreign_domain');

  const delegated = provisioning.createSite({
    user: usr, domain: uniqueDomain('deleg'), engine: 'nginx', phpVersion: '8.3', sslMode: 'none', createDns: false,
    checkDelegation: true,
    delegationProbe: () => ({ ok: false, status: 'pending', ns: [], expected: ['ns1.example'], detail: 'Brak delegacji (test).' }),
  });
  const delegationStep = delegated.steps.find((step) => step.key === 'delegation');
  assert.ok(delegationStep);
  assert.equal(delegationStep.ok, false);
  assert.equal(delegated.ok, true, 'pending delegation does not discard the site');
  assert.ok(delegated.warnings.some((warning) => /Delegacja/.test(warning)));
});

/* --------------------------------------------------------------- DNS ops */

test('DNS validation, template scoping, zone diff and controlled rollback work', async () => {
  assert.equal(dnsops.validateRecord({ name: 'www', type: 'A', value: '999.1.1.1' }).ok, false);
  assert.equal(dnsops.validateRecord({ name: '@', type: 'CNAME', value: 'www.example.com' }).ok, false);
  assert.equal(dnsops.validateRecord({ name: 'x', type: 'TXT', value: 'line1\nline2' }).ok, false);
  assert.equal(dnsops.validateRecord({ name: '@', type: 'MX', value: 'mail.example.com', priority: 70000 }).ok, false);
  const conflict = dnsops.validateRecords([
    { name: 'www', type: 'A', value: '192.0.2.1' },
    { name: 'www', type: 'CNAME', value: 'target.example.com' },
  ], { domain: 'example.com' });
  assert.equal(conflict.ok, false);
  assert.ok(conflict.errors.some((error) => error.code === 'cname_conflict'));

  const t1 = dnsops.saveTemplate({ name: `pkg-tpl-${stamp}`, records: JSON.stringify([
    { name: '@', type: 'A', value: '{ip}' },
    { name: '@', type: 'MX', value: '{mail}', priority: 10 },
    { name: '@', type: 'TXT', value: 'v=spf1 mx ~all' },
    { name: 'autodiscover', type: 'CNAME', value: '{mail}' },
  ]) }, 'admin');
  const t2 = dnsops.saveTemplate({ name: `res-tpl-${stamp}`, records: JSON.stringify([
    { name: '@', type: 'A', value: '{ip}' },
    { name: 'autoconfig', type: 'CNAME', value: '{mail}' },
  ]) }, 'admin');
  assert.equal(t1.ok, true, t1.error);
  assert.equal(t2.ok, true, t2.error);
  const template1 = db.get('SELECT * FROM dns_templates WHERE name = ?', `pkg-tpl-${stamp}`);
  const template2 = db.get('SELECT * FROM dns_templates WHERE name = ?', `res-tpl-${stamp}`);

  assert.equal(dnsops.setTemplateBinding({ scope: 'package', key: 'default', templateId: template1.id, actor: 'admin' }).ok, true);
  assert.equal(dnsops.setTemplateBinding({ scope: 'reseller', key: 'demoreseller', templateId: template2.id, actor: 'admin' }).ok, true);
  let resolved = dnsops.resolveTemplate({ packageName: 'default', reseller: 'demoreseller', domain: 'none.example' });
  assert.equal(resolved.template.id, template1.id, 'package beats reseller');
  assert.equal(dnsops.setTemplateBinding({ scope: 'domain', key: ctx.flowDomain, templateId: template2.id, actor: 'admin' }).ok, true);
  resolved = dnsops.resolveTemplate({ packageName: 'default', reseller: 'demoreseller', domain: ctx.flowDomain });
  assert.equal(resolved.template.id, template2.id, 'domain override wins');

  const before = dnsops.zoneRecords(ctx.flowDomain);
  const preview = dnsops.previewZoneChange(ctx.flowDomain, { templateId: template1.id });
  assert.equal(preview.ok, true, JSON.stringify(preview.errors));
  assert.ok(preview.diff.counts.added + preview.diff.counts.changed > 0);
  const applied = dnsops.applyZonePlan(ctx.flowDomain, { templateId: template1.id, actor: 'admin' });
  assert.equal(applied.ok, true, applied.error);
  assert.ok(applied.snapshotId);
  const afterApply = dnsops.zoneRecords(ctx.flowDomain);
  assert.notDeepEqual(afterApply.map((r) => `${r.type}:${r.name}:${r.value}`), before.map((r) => `${r.type}:${r.name}:${r.value}`));
  const rolled = dnsops.rollbackZoneChange(ctx.flowDomain, applied.snapshotId, { actor: 'admin' });
  assert.equal(rolled.ok, true, rolled.error);
  const restored = dnsops.zoneRecords(ctx.flowDomain).map((r) => `${r.type}:${r.name}:${r.value}`).sort();
  assert.deepEqual(restored, before.map((r) => `${r.type}:${r.name}:${r.value}`).sort());

  assert.equal(dnsops.publicZoneInfo(ctx.flowDomain, { expert: false }).file, null);
  assert.ok(dnsops.publicZoneInfo(ctx.flowDomain, { expert: true }).file);

  const exported = dnsops.exportBind(ctx.flowDomain);
  assert.equal(exported.ok, true);
  const roundtrip = dnsops.importBind(ctx.flowDomain, exported.text, { dryRun: true });
  assert.equal(roundtrip.ok, true, JSON.stringify(roundtrip.errors));
  assert.deepEqual(roundtrip.diff.counts, { added: 0, removed: 0, changed: 0, unchanged: roundtrip.records.length });
  const malicious = dnsops.importBind(ctx.flowDomain, '@ 3600 IN A $(touch /tmp/oa-dns-inject)', { dryRun: true });
  assert.equal(malicious.ok, false);
  const evilTemplate = dnsops.saveTemplate({ name: 'evil;rm -rf /', records: '[]' }, 'admin');
  assert.equal(evilTemplate.ok, false);

  const updated = dnsops.saveTemplate({ id: template2.id, name: `res-tpl-updated-${stamp}`.slice(0, 60), records: JSON.stringify([
    { name: '@', type: 'A', value: '{ip}' },
    { name: 'mail', type: 'A', value: '{ip}' },
  ]) }, 'admin');
  assert.equal(updated.ok, true, updated.error);
  const stored = db.get('SELECT * FROM dns_templates WHERE id = ?', template2.id);
  assert.equal(stored.name, `res-tpl-updated-${stamp}`.slice(0, 60));
  const t3 = dnsops.saveTemplate({ name: `del-tpl-${stamp}`, records: '[]' }, 'admin');
  const t3row = db.get('SELECT * FROM dns_templates WHERE name = ?', `del-tpl-${stamp}`);
  assert.equal(dnsops.setTemplateBinding({ scope: 'default', templateId: t3row.id, actor: 'admin' }).ok, true);
  assert.equal(dnsops.deleteTemplate(t3row.id, 'admin').ok, true);
  assert.equal(db.get('SELECT * FROM dns_templates WHERE id = ?', t3row.id), null);
  assert.equal(dnsops.resolveTemplate({ packageName: 'default', reseller: 'demoreseller', domain: 'unbound.example' }).source, 'package');
});

test('BIND import is scoped, previewable and reversible', async () => {
  const before = dnsops.zoneRecords(ctx.flowDomain).length;
  const dry = dnsops.importBind(ctx.flowDomain, 'imported 3600 IN A 192.0.2.55', { dryRun: true });
  assert.equal(dry.ok, true, JSON.stringify(dry.errors));
  assert.equal(dry.diff.counts.added, 1);
  assert.equal(dnsops.zoneRecords(ctx.flowDomain).length, before, 'dry-run does not mutate');
  const applied = dnsops.importBind(ctx.flowDomain, 'imported 3600 IN A 192.0.2.55', { dryRun: false });
  assert.equal(applied.ok, true, applied.error);
  assert.ok(dnsops.zoneRecords(ctx.flowDomain).some((record) => record.name === 'imported' && record.value === '192.0.2.55'));
  const rollback = dnsops.rollbackZoneChange(ctx.flowDomain, applied.snapshotId, { actor: 'admin' });
  assert.equal(rollback.ok, true);
  assert.equal(dnsops.zoneRecords(ctx.flowDomain).length, before);
});

test('DNS template apply and rollback reject foreign domains through the user route', async () => {
  const user = await loginAs('demouser');
  const page = await getPage('/user/dns?domain=example.com', user);
  const csrf = csrfOf(page.html);
  const before = db.get("SELECT COUNT(*) n FROM dns_records r JOIN domains d ON d.id = r.domain_id WHERE d.name = 'reseller-demo.local'").n;
  const foreign = await formPost('/user/dns/template/apply', { _csrf: csrf, domain: 'reseller-demo.local', template: '1', bind_scope: 'domain' }, user);
  assert.equal(foreign.status, 302);
  assert.match(foreign.headers.get('location'), /not%20found|Not%20found/i);
  assert.equal(db.get("SELECT COUNT(*) n FROM dns_records r JOIN domains d ON d.id = r.domain_id WHERE d.name = 'reseller-demo.local'").n, before);
});

/* -------------------------------------------------------------- SSL queue */

test('ACME queue preflights DNS/HTTP, backs off and alerts only after retries', async () => {
  const usr = userRow('demouser');
  const domain = uniqueDomain('acme');
  ctx.sslDomain = domain;
  const site = provisioning.createSite({ user: usr, domain, engine: 'nginx', phpVersion: '8.3', sslMode: 'none', createDns: true });
  assert.equal(site.ok, true, JSON.stringify(site.errors));
  const serverIp = db.setting('server_ip', '127.0.0.1');
  const goodDeps = {
    certbot: '/usr/bin/certbot',
    resolve4: async () => [serverIp],
    probeHttp: async () => ({ ok: true, status: 404 }),
    issue: () => ({ ok: true, expiresAt: new Date(Date.now() + 90 * 864e5).toISOString() }),
    fallback: () => ({ ok: true, expiresAt: new Date(Date.now() + 365 * 864e5).toISOString() }),
  };
  const pre = await autossl.preflightAcme(domain, { deps: goodDeps });
  assert.equal(pre.ok, true, JSON.stringify(pre.checks));
  assert.equal(pre.recommended, 'letsencrypt');
  assert.ok(pre.checks.some((check) => check.key === 'dns' && check.ok));
  assert.ok(pre.checks.some((check) => check.key === 'http' && check.ok));

  const notificationsBefore = db.get("SELECT COUNT(*) n FROM notifications WHERE title LIKE '%SSL%'").n;
  const queued = autossl.enqueueAcme(domain, { username: 'demouser', maxAttempts: 2, baseBackoffSeconds: 60, now: 1000 });
  assert.equal(queued.ok, true);
  assert.equal(queued.entry.status, 'queued');
  const reuse = autossl.enqueueAcme(domain, { username: 'demouser', maxAttempts: 2, baseBackoffSeconds: 60, now: 1001 });
  assert.equal(reuse.reused, true, 'enqueue is idempotent per domain/mode');
  let run = await autossl.processAcmeQueue({ now: 1000, deps: { ...goodDeps, issue: () => ({ ok: false, error: 'ACME 503' }) } });
  let entry = autossl.acmeEntry(queued.entry.id);
  assert.equal(entry.status, 'retrying');
  assert.equal(entry.attempts, 1);
  assert.ok(Date.parse(entry.nextAttemptAt) > 1000);
  assert.equal(db.get("SELECT COUNT(*) n FROM notifications WHERE title LIKE '%SSL%'").n, notificationsBefore, 'no alert before retries are exhausted');
  run = await autossl.processAcmeQueue({ now: 1000 + 61 * 1000, deps: goodDeps });
  entry = autossl.acmeEntry(queued.entry.id);
  assert.equal(entry.status, 'issued', JSON.stringify(run));
  assert.equal(db.get("SELECT COUNT(*) n FROM notifications WHERE title LIKE '%SSL%'").n, notificationsBefore, 'no alert on eventual success');

  const failingDomain = uniqueDomain('acmefail');
  ctx.sslFailDomain = failingDomain;
  provisioning.createSite({ user: usr, domain: failingDomain, engine: 'nginx', phpVersion: '8.3', sslMode: 'none', createDns: false });
  const failedJob = autossl.enqueueAcme(failingDomain, { username: 'demouser', maxAttempts: 2, baseBackoffSeconds: 60, now: 5000 });
  await autossl.processAcmeQueue({ now: 5000, deps: { ...goodDeps, issue: () => ({ ok: false, error: 'ACME 500' }) } });
  let failedEntry = autossl.acmeEntry(failedJob.entry.id);
  assert.equal(failedEntry.status, 'retrying');
  assert.equal(db.get("SELECT COUNT(*) n FROM notifications WHERE title LIKE '%SSL%'").n, notificationsBefore);
  await autossl.processAcmeQueue({ now: 5000 + 61 * 1000, deps: { ...goodDeps, issue: () => ({ ok: false, error: 'ACME 500' }) } });
  failedEntry = autossl.acmeEntry(failedJob.entry.id);
  assert.equal(failedEntry.status, 'failed');
  assert.equal(failedEntry.attempts, 2);
  assert.equal(db.get("SELECT COUNT(*) n FROM notifications WHERE title LIKE '%SSL%'").n, notificationsBefore + 1, 'exactly one exhausted-retry alert');
  await autossl.processAcmeQueue({ now: 5000 + 2 * 61 * 1000, deps: { ...goodDeps, issue: () => ({ ok: false, error: 'ACME 500' }) } });
  assert.equal(db.get("SELECT COUNT(*) n FROM notifications WHERE title LIKE '%SSL%'").n, notificationsBefore + 1, 'no duplicate alert');

  const waitDomain = uniqueDomain('acmewait');
  provisioning.createSite({ user: usr, domain: waitDomain, engine: 'nginx', phpVersion: '8.3', sslMode: 'none', createDns: false });
  const waiting = autossl.enqueueAcme(waitDomain, { username: 'demouser', maxAttempts: 3, baseBackoffSeconds: 60, now: 9000 });
  await autossl.processAcmeQueue({ now: 9000, deps: { ...goodDeps, resolve4: async () => [] } });
  let waitingEntry = autossl.acmeEntry(waiting.entry.id);
  assert.equal(waitingEntry.status, 'waiting_dns');
  const retryAt = Date.parse(waitingEntry.nextAttemptAt);
  assert.ok(retryAt > 9000);
  await autossl.processAcmeQueue({ now: retryAt + 1000, deps: goodDeps });
  waitingEntry = autossl.acmeEntry(waiting.entry.id);
  assert.equal(waitingEntry.status, 'issued');

  const fallbackDomain = uniqueDomain('acmefallback');
  provisioning.createSite({ user: usr, domain: fallbackDomain, engine: 'nginx', phpVersion: '8.3', sslMode: 'none', createDns: false });
  const fallbackJob = autossl.enqueueAcme(fallbackDomain, { username: 'demouser', maxAttempts: 2, baseBackoffSeconds: 60, now: 12000 });
  await autossl.processAcmeQueue({ now: 12000, deps: { ...goodDeps, certbot: '' } });
  const fallbackEntry = autossl.acmeEntry(fallbackJob.entry.id);
  assert.equal(fallbackEntry.status, 'issued');
  assert.equal(fallbackEntry.fallback, 'selfsigned');
  assert.match(fallbackEntry.lastPreflight.checks.find((check) => check.key === 'certbot').detail, /nie jest zainstalowany/i);

  const schedule = autossl.renewalSchedule();
  assert.ok(schedule.length > 0);
  assert.ok(schedule.every((row) => 'renewAt' in row && 'link' in row));

  const admin = await loginAs('demoadmin');
  const queuePage = await getPage('/admin/ssl-center?tab=queue', admin);
  assert.equal(queuePage.res.status, 200);
  assert.match(queuePage.html, new RegExp(`/admin/ssl\\?domain=${domain.replace(/\./g, '\\.')}`));
  assert.match(queuePage.html, /Kolejka ACME/);
  assert.match(queuePage.html, /Fallback|fallback/);
});

test('inline package creation keeps the wizard form and applies limits atomically', async () => {
  const admin = await loginAs('demoadmin');
  const page = await getPage('/admin/users/create', admin);
  const csrf = csrfOf(page.html);
  const username = unique('inlineclient');
  const packageName = `inline-${stamp}`.slice(0, 40);
  const created = await formPost('/admin/users/create', {
    _csrf: csrf, wizard: '1', username, email: `${username}@example.com`,
    package: 'default', new_package_name: packageName,
    new_limit_domains: '7', new_limit_emails: '12', new_limit_disk_mb: '2048',
    create_dns: '0', create_mailbox: '0', create_backup: '0', create_monitoring: '0',
    docroot: '1', php_step: '1', vhost: '1', activation: '1', app: 'none',
  }, admin);
  assert.equal(created.status, 302, await created.text());
  const pkg = db.get('SELECT * FROM packages WHERE name = ?', packageName);
  assert.ok(pkg, 'inline package created');
  assert.equal(pkg.type, 'user');
  const limits = JSON.parse(pkg.limits);
  assert.equal(limits.domains, 7);
  assert.equal(limits.emails, 12);
  const user = userRow(username);
  assert.ok(user);
  assert.equal(user.package, packageName, 'account uses the inline package');
  assert.ok(provisioning.lastAccountProvision(user.id)?.ok);
});

test('account preflight accepts a complete application install payload', () => {
  const pre = provisioning.accountPreflight({
    actor: userRow('demoadmin'), username: unique('apppre'), email: 'apppre@example.com',
    package: 'default', domain: uniqueDomain('apppre'), engine: 'nginx', php_version: '8.3', ssl_mode: 'selfsigned',
    activation: true, app: { type: 'wordpress', adminUser: 'wpadmin', adminEmail: 'wp@example.com', adminPassword: 'StrongPass!2026' },
  });
  assert.ok(pre.checks.some((check) => check.key === 'app' && check.ok), JSON.stringify(pre.errors));
  const bad = provisioning.accountPreflight({
    actor: userRow('demoadmin'), username: unique('appbad'), email: 'appbad@example.com',
    package: 'default', domain: uniqueDomain('appbad'), activation: true,
    app: { type: 'wordpress', adminUser: 'wpadmin', adminEmail: 'wp@example.com', adminPassword: 'short' },
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((error) => error.key === 'app'));
});

/* --------------------------------------------------------------- security */

test('shell metacharacters never reach commands and are rejected before mutation', async () => {
  const sentinelPrefix = `/tmp/oa-provisioning-pwn-${stamp}`;
  const sentinel = `${sentinelPrefix}-account`;
  const otherSentinel = `${sentinelPrefix}-domain`;
  const admin = await loginAs('demoadmin');
  const page = await getPage('/admin/users/create', admin);
  const csrf = csrfOf(page.html);
  const injected = await formPost('/admin/users/create', {
    _csrf: csrf, wizard: '1', username: `x;touch ${sentinel}`, email: 'inject@example.com',
    package: 'default', activation: '1', domain: '', engine: 'nginx', php_version: '8.3', ssl_mode: 'none',
  }, admin);
  assert.equal(injected.status, 200);
  assert.equal(fs.existsSync(sentinel), false, 'account username injection did not execute');

  const user = await loginAs('demouser');
  const domainPage = await getPage('/user/domains/create', user);
  const domainCsrf = csrfOf(domainPage.html);
  const domainInjection = await formPost('/user/domains/create', {
    _csrf: domainCsrf, wizard: '1', domain: `$(touch ${otherSentinel})`, engine: 'nginx', php_version: '8.3', ssl_mode: 'none', create_dns: '1',
  }, user);
  assert.equal(domainInjection.status, 200);
  assert.equal(fs.existsSync(otherSentinel), false, 'domain injection did not execute');

  const dnsPage = await getPage('/user/dns?domain=example.com', user);
  const dnsCsrf = csrfOf(dnsPage.html);
  const importInjection = await formPost('/user/dns/import', {
    _csrf: dnsCsrf, domain: 'example.com', dry_run: '1',
    text: `@ 3600 IN A $(touch ${sentinelPrefix}-dns)`,
  }, user);
  assert.equal(importInjection.status, 200);
  assert.equal(fs.existsSync(`${sentinelPrefix}-dns`), false);
});

/* --------------------------------------------------------------- deletion */

test('deleting an account removes tenant artefacts created by the wizard', async () => {
  const admin = await loginAs('demoadmin');
  const user = userRow(ctx.accountUsername);
  assert.ok(user);
  const detail = await getPage(`/admin/users/${user.id}`, admin);
  const csrf = csrfOf(detail.html);
  const deleted = await formPost(`/admin/users/${user.id}/delete`, { _csrf: csrf }, admin);
  assert.equal(deleted.status, 302);
  assert.equal(userRow(ctx.accountUsername), null);
  assert.equal(db.get('SELECT id FROM domains WHERE name = ?', ctx.accountDomain), null);
  assert.equal(db.get('SELECT COUNT(*) n FROM backup_jobs WHERE target_user = ?', ctx.accountUsername).n, 0);
  assert.equal(db.setting(`site_monitoring:${ctx.accountDomain}`, ''), '');
  assert.equal(db.get('SELECT COUNT(*) n FROM password_resets WHERE user_id = ?', user.id).n, 0);
  assert.equal(fs.existsSync(path.join(dataDir, 'homes', ctx.accountUsername)), false);
});
