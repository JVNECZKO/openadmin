// i18n + accessibility + state-contract tests for the owned UI surface.
//
// The suite deliberately avoids DOM libraries: rendered HTML is inspected with
// small deterministic scanners, while the client locale layer and the catalogue
// filter script are executed in isolated `node:vm` contexts with explicit
// stubs. No browser and no third-party dependencies are required.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openadmin-i18n-a11y-'));
process.env.OA_DATA_DIR = dataDir;
process.env.OA_PORT = '0';
process.env.OA_IMAP_PORT = '0';
process.env.OA_HOST = '127.0.0.1';
process.env.OA_DEMO = '1';
process.env.OA_ADMIN_PASSWORD = 'admin-test-pass';
process.env.OA_SESSION_TTL = '2';

const serverMod = await import('../src/server.mjs');
const db = await import('../src/db.mjs');
const components = await import('../src/ui/components.mjs');
const i18nModule = await import('../src/public/i18n.js');
const I18N = globalThis.OA_I18N;

const I18N_SOURCE = fs.readFileSync(path.resolve('src/public/i18n.js'), 'utf8');
const PROPER_NAMES = ['OpenAdmin', 'WordPress', 'Nextcloud', 'PrestaShop', 'Joomla', 'Drupal', 'Moodle', 'phpMyAdmin', 'Roundcube', 'MariaDB', 'MySQL', 'DirectAdmin', 'Netdata', 'Rspamd', "Let's Encrypt"];

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
  return setCookie.filter(Boolean).map((cookie) => cookie.split(';')[0]).join('; ');
}

async function page(pathname, cookie, options = {}) {
  const res = await fetch(base + pathname, { headers: { Cookie: cookie, ...(options.headers || {}) } });
  return { res, html: await res.text() };
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

/* --------------------------------------------------------------- helpers */
function parseAttrs(tag) {
  const source = String(tag || '').replace(/^<\s*[a-zA-Z0-9-]+/, '');
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = re.exec(source))) {
    out[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return out;
}

function decodeEntities(value) {
  return String(value)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'");
}

function visibleText(html) {
  return decodeEntities(String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function mainText(html) {
  const main = String(html).match(/<main\b[\s\S]*?<\/main>/i);
  return visibleText(main ? main[0] : html);
}

function scanForms(html) {
  const forms = [];
  const formRe = /<form\b([^>]*class="[^"]*\boa-form\b[^"]*"[^>]*)>([\s\S]*?)<\/form>/gi;
  let formMatch;
  while ((formMatch = formRe.exec(html))) {
    const formAttrs = parseAttrs(`<form ${formMatch[1]}>`);
    const body = formMatch[2];
    const controls = [];
    const controlRe = /<(input|select|textarea)\b([^>]*)>/gi;
    let controlMatch;
    while ((controlMatch = controlRe.exec(body))) {
      const attrs = parseAttrs(`<${controlMatch[1]} ${controlMatch[2]}>`);
      const type = (attrs.type || (controlMatch[1] === 'input' ? 'text' : controlMatch[1])).toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
      controls.push({ tag: controlMatch[1].toLowerCase(), attrs, index: controlMatch.index, end: controlMatch.index + controlMatch[0].length });
    }
    forms.push({ attrs: formAttrs, body, controls, start: formMatch.index, end: formMatch.index + formMatch[0].length });
  }
  const labels = [];
  const labelRe = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
  let labelMatch;
  while ((labelMatch = labelRe.exec(html))) {
    labels.push({
      attrs: parseAttrs(`<label ${labelMatch[1]}>`),
      text: visibleText(labelMatch[2]),
      start: labelMatch.index,
      end: labelMatch.index + labelMatch[0].length,
    });
  }
  const allIds = new Set();
  const duplicateIds = [];
  const idRe = /\sid="([^"]+)"/g;
  let idMatch;
  while ((idMatch = idRe.exec(html))) {
    if (allIds.has(idMatch[1])) duplicateIds.push(idMatch[1]);
    allIds.add(idMatch[1]);
  }
  return { forms, labels, ids: allIds, duplicateIds };
}

function accessibleName(control, labels, ids) {
  if (control.attrs['aria-label'] && control.attrs['aria-label'].trim()) return control.attrs['aria-label'].trim();
  if (control.attrs['aria-labelledby']) {
    const refs = control.attrs['aria-labelledby'].split(/\s+/).filter(Boolean);
    if (!refs.length || refs.some((id) => !ids.has(id))) return '';
    return refs.join(' ');
  }
  const id = control.attrs.id;
  if (id) {
    const byFor = labels.find((label) => label.attrs.for === id && label.text);
    if (byFor) return byFor.text;
  }
  const wrapping = labels.find((label) => label.start <= control.index && control.end <= label.end && label.text);
  return wrapping ? wrapping.text : '';
}

/* ------------------------------------------------------------------ i18n */
test('PL and EN message catalogues are complete and free of forbidden output', () => {
  assert.ok(I18N, 'OA_I18N must be exposed');
  const plKeys = Object.keys(I18N.messages.pl).sort();
  const enKeys = Object.keys(I18N.messages.en).sort();
  assert.deepEqual(enKeys, plKeys, 'both locales must expose exactly the same keys');
  assert.ok(plKeys.length > 250, `catalogue is too small (${plKeys.length} keys)`);

  for (const locale of ['pl', 'en']) {
    for (const [key, value] of Object.entries(I18N.messages[locale])) {
      assert.equal(typeof value, 'string', `${locale}.${key} must be a string`);
      assert.ok(value.trim(), `${locale}.${key} must not be empty`);
      assert.equal(/undefined|\[object Object\]|\bNaN\b|Nothing here yet|^Brak:\s/i.test(value), false, `${locale}.${key} contains a forbidden placeholder: ${value}`);
    }
  }

  const localizedKeys = [
    'login.signIn', 'login.forgot', 'login.remember', 'login.asideTitle',
    'recovery.submit', 'recovery.newPassword', 'recovery.invalidToken',
    'palette.title', 'palette.navigate', 'palette.open', 'palette.close',
    'dashboard.title', 'dashboard.firstSteps',
    'appcatalog.install', 'appcatalog.installed',
    'empty.table', 'state.error', 'state.stale', 'state.partial',
  ];
  for (const key of localizedKeys) {
    assert.notEqual(I18N.messages.pl[key], I18N.messages.en[key], `${key} must actually be translated`);
  }

  for (const brand of PROPER_NAMES) {
    assert.equal(I18N.translate(brand, 'pl'), brand, `${brand} must stay untranslated`);
    assert.equal(I18N.translate(brand, 'en'), brand, `${brand} must stay untranslated`);
  }

  assert.equal(I18N.hasMessage('does.not.exist'), false);
  assert.equal(I18N.t('does.not.exist'), '');
  assert.equal(I18N.formatMessage('palette.resultCount', { count: 7 }, 'pl'), '7 wyników');
  assert.equal(I18N.formatMessage('palette.resultCount', {}, 'pl').includes('undefined'), false);
});

test('locale resolution follows the requested locale, cookie, account and browser', () => {
  const cases = [
    [{ search: '?lang=pl', htmlLang: 'en', isLogin: true, languages: ['en-US'] }, 'pl'],
    [{ search: '?lang=en', htmlLang: 'pl', isLogin: false, languages: ['pl-PL'] }, 'en'],
    [{ search: '', cookie: 'oa_lang=pl', htmlLang: 'en', isLogin: true, languages: ['en-US'] }, 'pl'],
    [{ search: '', htmlLang: 'en', isLogin: false, languages: ['pl-PL'] }, 'en'],
    [{ search: '', htmlLang: 'pl', isLogin: false, languages: ['en-US'] }, 'pl'],
    [{ search: '', htmlLang: 'en', isLogin: true, languages: ['pl-PL'] }, 'pl'],
    [{ search: '?lang=de', htmlLang: 'en', isLogin: true, languages: ['en-US'] }, 'en'],
    [{ search: '', htmlLang: 'en', isLogin: true, acceptLanguage: 'pl-PL,pl;q=0.9,en;q=0.8' }, 'pl'],
    [{ search: '', htmlLang: 'en', isLogin: true, storage: { oa_lang: 'pl' }, languages: ['en-US'] }, 'pl'],
  ];
  for (const [hints, expected] of cases) {
    assert.equal(I18N.resolveLocale(hints), expected, JSON.stringify(hints));
  }
});

test('login and password recovery strings follow the selected locale', () => {
  assert.equal(I18N.translate('Sign in to your panel', 'pl'), 'Zaloguj się do panelu');
  assert.equal(I18N.translate('Remember me', 'pl'), 'Zapamiętaj mnie');
  assert.equal(I18N.translate('Forgot password?', 'pl'), 'Nie pamiętasz hasła?');
  assert.equal(I18N.translate('Send reset request', 'pl'), 'Wyślij prośbę o reset hasła');
  assert.equal(I18N.translate('Ustaw nowe hasło', 'en'), 'Set a new password');
  assert.equal(I18N.translate('Link wygasł lub jest nieprawidłowy. Poproś o nowy.', 'en'), 'This link expired or is invalid. Request a new one.');
  assert.equal(I18N.translate('Hasło musi mieć co najmniej 8 znaków.', 'en'), 'The password must be at least 8 characters long.');
  assert.equal(I18N.translate('Zaloguj się do panelu', 'en'), 'Sign in to your panel');
  assert.equal(I18N.translate('Nothing here yet', 'pl'), I18N.messages.pl['state.unavailable']);
  assert.equal(I18N.translate('Brak: tickets', 'en').includes('Brak:'), false);
});

test('client locale layer translates a login DOM using the requested locale', () => {
  const loginStrings = [
    'Sign in to your panel',
    'Use the same credentials for admin, reseller and user access.',
    'Username',
    'Password',
    'Remember me',
    'Forgot password?',
    'Sign in',
    'Send reset request',
  ];
  const nodes = loginStrings.map((value) => ({
    nodeType: 3,
    nodeValue: value,
    parentElement: { nodeType: 1, tagName: 'P' },
  }));

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    navigator: { languages: ['en-US'], language: 'en-US' },
    location: { search: '?lang=pl', protocol: 'https:' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  sandbox.globalThis = sandbox;
  const documentStub = {
    readyState: 'complete',
    cookie: '',
    title: 'Sign in · OpenAdmin',
    documentElement: {
      lang: 'en',
      setAttribute(name, value) { this[name] = value; },
    },
    body: {
      ownerDocument: null,
      classList: { contains: (name) => name === 'login-body' },
    },
    addEventListener() {},
    createTreeWalker() {
      let index = 0;
      return { nextNode: () => nodes[index++] || null };
    },
    querySelectorAll: () => [],
    getElementById: () => null,
    dispatchEvent() {},
  };
  documentStub.body.ownerDocument = documentStub;
  sandbox.document = documentStub;

  const context = vm.createContext(sandbox);
  vm.runInContext(I18N_SOURCE, context);
  const api = context.OA_I18N || sandbox.OA_I18N;
  assert.ok(api, 'locale API must be exposed in the DOM context');
  assert.equal(documentStub.documentElement.lang, 'pl');
  assert.deepEqual(nodes.map((node) => node.nodeValue), [
    'Zaloguj się do panelu',
    'Te same dane logowania dla admina, resellera i użytkownika.',
    'Użytkownik',
    'Hasło',
    'Zapamiętaj mnie',
    'Nie pamiętasz hasła?',
    'Zaloguj się',
    'Wyślij prośbę o reset hasła',
  ]);
  assert.equal(documentStub.title, 'Zaloguj się · OpenAdmin');
});

test('command palette strings are fully localized', () => {
  const expected = {
    'palette.title': 'Paleta poleceń',
    'palette.search': 'Szukaj stron, ustawień i poleceń…',
    'palette.navigate': 'nawiguj',
    'palette.open': 'otwórz',
    'palette.close': 'zamknij',
    'palette.switchDark': 'Przełącz na ciemny motyw',
    'palette.refresh': 'Odśwież tę stronę',
    'palette.notifications': 'Otwórz powiadomienia',
    'palette.signOut': 'Wyloguj się',
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(I18N.t(key, null, 'pl'), value, `${key} must be localized in PL`);
  }
  assert.equal(I18N.translate('Command palette', 'pl'), 'Paleta poleceń');
  assert.equal(I18N.translate('Search pages, settings and commands…', 'pl'), 'Szukaj stron, ustawień i poleceń…');
  assert.equal(I18N.translate('Turn off auto-refresh', 'pl'), 'Wyłącz automatyczne odświeżanie');
  assert.equal(I18N.translate('No matches for “theme”.', 'pl'), 'Brak wyników dla „theme”.');
  assert.equal(I18N.translate('Try “theme”, “domains” or “backup”.', 'pl'), 'Spróbuj „motyw”, „domeny” lub „kopia”.');
  assert.equal(I18N.translate('theme', 'pl'), 'motyw');
  assert.equal(I18N.translate('No matches for “theme”.', 'pl').includes('Brak:'), false);
});

test('client-generated shell messages (toasts, live region) are localized', () => {
  const expected = {
    'Copied to clipboard': 'Skopiowano do schowka',
    'Password generated': 'Wygenerowano hasło',
    'Auto-refresh is off.': 'Auto-odświeżanie jest wyłączone.',
    'Could not read file': 'Nie udało się odczytać pliku',
    'Switch to dark mode': 'Przełącz na tryb ciemny',
    'Upload files: drop files here or press Enter to browse': 'Wgraj pliki: przeciągnij je tutaj lub naciśnij Enter, aby wybrać',
  };
  for (const [source, translated] of Object.entries(expected)) {
    assert.equal(I18N.translate(source, 'pl'), translated, `${source} must be localized`);
  }
  assert.equal(I18N.translate('Auto-refresh is on. This page reloads every 30 seconds.', 'pl'), 'Auto-odświeżanie włączone. Strona przeładuje się co 30 s.');
  assert.equal(I18N.translate('Uploading 2 files…', 'pl'), 'Wgrywanie 2 plików…');
  assert.equal(I18N.translate('3 unread notifications', 'pl'), '3 nieprzeczytanych powiadomień');
});

/* ------------------------------------------------------ rendered locales */
test('rendered PL pages contain no forbidden placeholders or untranslated CTAs', async () => {
  const cookie = await loginAs('demouser');
  const routes = ['/user', '/user/app-catalog', '/user/help'];
  const forbidden = [
    [/Nothing here yet/i, 'Nothing here yet'],
    [/Brak:\s/i, 'Brak:'],
    [/\bundefined\b/i, 'undefined'],
    [/\[object Object\]/i, '[object Object]'],
    [/\bNaN\b/, 'NaN'],
    [/\bNo\s+(domains|mailboxes|users|data|results|activity|backups|tickets)\b/i, 'raw No…'],
  ];
  const englishCta = /\b(Create|Add|Save|Cancel|Delete|Install|Open|Manage|Refresh|Search|Submit|Continue|Back|Next|Finish|Send|Retry|Close|Dismiss)\b/;

  for (const route of routes) {
    const { res, html } = await page(route, cookie);
    assert.equal(res.status, 200, `${route} must render`);
    const text = mainText(html);
    for (const [pattern, label] of forbidden) {
      assert.doesNotMatch(text, pattern, `${route} leaks forbidden text: ${label}`);
    }
    const cta = text.match(englishCta);
    assert.equal(cta, null, `${route} leaks an untranslated English CTA: ${cta && cta[1]}`);
  }
});

test('EN locale renders dashboard, catalogue and help in English', async () => {
  const userId = db.get("SELECT id FROM users WHERE username = 'demouser'").id;
  db.run("UPDATE users SET language = 'en' WHERE id = ?", userId);
  try {
    const cookie = await loginAs('demouser');
    const dashboard = await page('/user', cookie);
    assert.equal(dashboard.res.status, 200);
    const dashText = mainText(dashboard.html);
    for (const label of ['First steps', 'Your domains', 'Applications — one click', 'Quick actions']) {
      assert.ok(dashText.includes(label), `dashboard misses EN label: ${label}`);
    }
    assert.equal(dashText.includes('Pierwsze kroki'), false, 'dashboard still renders PL headings in EN locale');

    const catalog = await page('/user/app-catalog', cookie);
    const catalogText = mainText(catalog.html);
    for (const label of ['Applications', 'Your applications', 'Installed', 'Available']) {
      assert.ok(catalogText.includes(label), `catalogue misses EN label: ${label}`);
    }
    assert.ok(catalog.html.includes('Search applications…'), 'catalogue misses the EN search placeholder');
    assert.ok(catalogText.includes('Online store'), 'catalogue misses the EN PrestaShop description');
    assert.equal(catalogText.includes('Zainstalowane:'), false, 'catalogue still renders PL counters in EN locale');

    const help = await page('/user/help', cookie);
    const helpText = mainText(help.html);
    assert.ok(helpText.includes('How do I publish a website?'));
    assert.equal(helpText.includes('Jak postawić stronę'), false);
  } finally {
    db.run("UPDATE users SET language = 'pl' WHERE id = ?", userId);
  }
});

/* ------------------------------------------------------- form semantics */
test('field() renders unique ids, labels, described help/errors and required markers', () => {
  const first = components.field({ name: 'email', label: 'E-mail', required: true, help: 'Podaj adres', error: 'Błędny adres' }).value;
  const second = components.field({ name: 'email', label: 'E-mail', required: true, help: 'Podaj adres' }).value;
  const id1 = first.match(/id="([^"]+)"/)[1];
  const id2 = second.match(/id="([^"]+)"/)[1];
  assert.notEqual(id1, id2, 'repeated field names must get unique ids');
  assert.match(first, new RegExp(`<label class="field-label" for="${id1}"`));
  assert.match(first, new RegExp(`aria-describedby="${id1}-help ${id1}-error"`));
  assert.match(first, new RegExp(`id="${id1}-help"`));
  assert.match(first, new RegExp(`id="${id1}-error"`));
  assert.match(first, /aria-invalid="true"/);
  assert.match(first, /aria-errormessage="[^"]+-error"/);
  assert.match(first, /required aria-required="true"/);
  assert.match(first, /class="req" aria-hidden="true">\*/);

  const checkbox = components.field({ name: 'agree', label: 'Akceptuję', type: 'checkbox', required: true, help: 'Wymagane' }).value;
  assert.match(checkbox, /<label class="check-field" for="f_agree_\d+"/);
  assert.match(checkbox, /aria-describedby="f_agree_\d+-help"/);
  assert.match(checkbox, /id="f_agree_\d+-help"/);

  const radio = components.field({ name: 'mode', label: 'Tryb', type: 'radio', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }).value;
  assert.match(radio, /<fieldset[^>]*>/);
  assert.match(radio, /<legend class="field-label">Tryb<\/legend>/);
  assert.equal((radio.match(/id="f_mode_\d+-\d+"/g) || []).length, 2);
  assert.equal((radio.match(/<label class="radio" for="f_mode_\d+-\d+"/g) || []).length, 2);
});

test('form() exposes a stable labelled form and required hint', () => {
  const markup = components.form([components.field({ name: 'domain', label: 'Domena', required: true })], {
    action: '/user/domains/create',
    csrf: 'token',
    label: 'Nowa domena',
  }).value;
  assert.match(markup, /<form class="oa-form\s*"[^>]*aria-label="Nowa domena"/);
  assert.match(markup, /data-i18n="form.requiredHint"/);
  assert.match(markup, /name="_csrf" value="token"/);
});

test('table actions, empty states and state panels are accessible and localized', () => {
  const empty = components.table({ columns: [{ label: 'Nazwa', key: 'name' }], rows: [] }).value;
  assert.equal(empty.includes('Nothing here yet'), false);
  assert.match(empty, /role="status"/);
  assert.match(empty, /data-i18n="empty.table"/);
  assert.match(empty, /data-state="empty"/);
  const sanitized = components.table({ columns: [{ label: 'Nazwa', key: 'name' }], rows: [], empty: 'Nothing here yet' }).value;
  assert.equal(sanitized.includes('Nothing here yet'), false, 'legacy default must be sanitized');
  assert.match(sanitized, /data-i18n="empty.table"/);
  const sanitizedDirect = components.emptyState('Brak: tickets').value;
  assert.doesNotMatch(sanitizedDirect, /Brak:\s/);

  const table = components.table({
    columns: [{ label: 'Nazwa', key: 'name' }],
    rows: [{ id: 1, name: 'demo' }],
    selectable: true,
    actions: [
      { href: () => '/edit', label: 'Edytuj', icon: 'edit' },
      { form: () => '/delete', label: 'Usuń', icon: 'trash', danger: true, confirm: 'Na pewno?' },
    ],
  }).value;
  assert.match(table, /aria-label="Zaznacz wszystkie wiersze"/);
  assert.match(table, /aria-label="Zaznacz wiersz 1"/);
  assert.match(table, /href="\/edit" title="Edytuj" aria-label="Edytuj"/);
  assert.match(table, /title="Usuń" aria-label="Usuń"/);
  assert.match(table, /<th scope="col" class="col-check">/);
  assert.match(table, /<th scope="col" class="col-actions">Akcje<\/th>/);
  const safeCells = components.table({
    columns: [{ label: 'Wartość', key: 'value' }],
    rows: [{ id: 1, value: { nested: true } }, { id: 2, value: Number.NaN }],
  }).value;
  assert.equal(safeCells.includes('[object Object]'), false);
  assert.equal(safeCells.includes('NaN'), false);
  assert.equal((safeCells.match(/>—</g) || []).length, 2);

  for (const state of ['loading', 'empty', 'error', 'unavailable', 'permission', 'dependency', 'stale', 'partial']) {
    const panel = components.statePanel(state, { retryHref: '/retry' }).value;
    assert.match(panel, new RegExp(`data-state="${state}"`), `${state} must expose data-state`);
    assert.match(panel, /role="(status|alert)"/, `${state} must expose an ARIA role`);
    const key = state === 'empty' ? 'empty.table' : `state.${state}`;
    assert.ok(I18N.hasMessage(key), `missing i18n message for ${state}`);
    assert.match(panel, new RegExp(`data-i18n="${key.replace('.', '\\.')}"`));
  }
  assert.match(components.statePanel('error', { retryHref: '/retry' }).value, /role="alert"/);
  assert.match(components.statePanel('loading').value, /aria-busy="true"/);

  const copy = components.copyValue('abc').value;
  assert.match(copy, /title="Copy value"/);
  assert.match(copy, /aria-label="Copy value"/);
  const modal = components.modal('demo', 'Tytuł', 'Treść').value;
  assert.match(modal, /aria-modal="true"/);
  assert.match(modal, /aria-label="Close dialog"/);
  assert.match(modal, /data-i18n-aria-label="a11y.closeDialog"/);
});

for (const [label, user, route] of [
  ['API keys', 'demoadmin', '/admin/api-keys'],
  ['SSL center', 'demoadmin', '/admin/ssl-center'],
  ['application catalogue modal', 'demouser', '/user/app-catalog'],
]) {
  test(`rendered ${label} fields have unique ids, labels and described help`, async () => {
    const cookie = await loginAs(user);
    const { res, html } = await page(route, cookie);
    assert.equal(res.status, 200, `${route} must render`);
    const { forms, labels, ids, duplicateIds } = scanForms(html);
    assert.deepEqual(duplicateIds, [], `${route} renders duplicate ids: ${duplicateIds.join(', ')}`);
    assert.ok(forms.length > 0, `${route} must render at least one component form`);

    const controlIds = new Set();
    for (const formEntry of forms) {
      const formText = formEntry.body;
      const helpIds = [...formText.matchAll(/<p class="field-help" id="([^"]+)"/g)].map((match) => match[1]);
      const described = new Set();
      for (const control of formEntry.controls) {
        assert.ok(control.attrs.id, `${route}: control ${control.tag} has no id`);
        assert.equal(controlIds.has(control.attrs.id), false, `${route}: duplicate control id ${control.attrs.id}`);
        controlIds.add(control.attrs.id);
        const name = accessibleName(control, labels, ids);
        assert.ok(name, `${route}: control #${control.attrs.id} (${control.tag}) has no programmatic label`);
        if (control.attrs.required !== undefined) {
          assert.ok(name.includes('*') || control.attrs['aria-required'] === 'true', `${route}: required control #${control.attrs.id} has no required marker`);
        }
        if (control.attrs['aria-describedby']) {
          for (const id of control.attrs['aria-describedby'].split(/\s+/).filter(Boolean)) {
            assert.ok(ids.has(id), `${route}: aria-describedby points at missing id ${id}`);
            described.add(id);
          }
        }
      }
      for (const id of helpIds) {
        assert.ok(described.has(id), `${route}: help text #${id} is not linked through aria-describedby`);
      }
    }
  });
}

/* ------------------------------------------------------ app catalog state */
function extractCatalogScript(html) {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const script = scripts.find((entry) => entry.includes('data-app-card') && entry.includes('data-app-filter'));
  assert.ok(script, 'catalogue filter script must be present');
  return script;
}

function catalogElement(attrs = {}) {
  const store = { ...attrs };
  const classes = new Set();
  const element = {
    hidden: false,
    value: '',
    textContent: '',
    focused: false,
    scrolled: false,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); },
    },
    getAttribute(name) { return Object.hasOwn(store, name) ? store[name] : null; },
    setAttribute(name, value) { store[name] = String(value); },
    hasAttribute(name) { return Object.hasOwn(store, name); },
    addEventListener() {},
    scrollIntoView() { element.scrolled = true; },
    focus() { element.focused = true; },
    querySelector(selector) { return selector === '[data-app-detail]' ? element.detail : null; },
  };
  element.detail = { hidden: true };
  return element;
}

function catalogEnvironment(html, { installed = null } = {}) {
  const articles = [...html.matchAll(/<article class="app-tile"[^>]*>([\s\S]*?)<\/article>/g)];
  const cards = articles.map((match) => {
    const attrs = parseAttrs(match[0].slice(0, match[0].indexOf('>') + 1));
    return catalogElement({
      'data-app-card': '',
      'data-app-key': attrs['data-app-key'],
      'data-app-name': attrs['data-app-name'],
      'data-app-installed': installed === true ? '1' : installed === false ? '0' : (attrs['data-app-installed'] || '0'),
      id: attrs.id,
    });
  });
  const chips = ['all', 'installed', 'available'].map((filter) => catalogElement({ 'data-app-filter': filter }));
  const search = catalogElement();
  const count = catalogElement();
  const empty = catalogElement();
  empty.hidden = true;
  const title = catalogElement();
  const body = catalogElement();
  const cta = catalogElement();
  const installedRegion = catalogElement();
  const grid = catalogElement();
  const reset = cta;
  const selectors = {
    '[data-app-search]': search,
    '[data-app-count]': count,
    '[data-app-no-results]': empty,
    '[data-app-filter-empty]': empty,
    '[data-app-filter-title]': title,
    '[data-app-filter-body]': body,
    '[data-app-filter-cta]': cta,
    '[data-app-installed-region]': installedRegion,
    '[data-app-grid]': grid,
    '[data-app-reset]': reset,
  };
  const document = {
    querySelectorAll(selector) {
      if (selector === '[data-app-card]') return cards;
      if (selector === '[data-app-filter]') return chips;
      if (selector === '[data-install-form]' || selector === '[data-install-form][aria-busy="true"]') return [];
      return [];
    },
    querySelector(selector) { return selectors[selector] || null; },
    getElementById(id) { return cards.find((card) => card.getAttribute('id') === id) || null; },
  };
  const listeners = {};
  const sandbox = {
    console,
    document,
    location: { hash: '' },
    addEventListener(type, handler) { listeners[type] = handler; },
    querySelectorAll: document.querySelectorAll,
    querySelector: document.querySelector,
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext('globalThis.window = globalThis;', context);
  return { cards, chips, search, count, empty, title, body, cta, installedRegion, grid, reset, listeners, context, sandbox };
}

test('catalogue markup exposes catalogue, filter and installed states independently', async () => {
  const cookie = await loginAs('demouser');
  const { html } = await page('/user/app-catalog', cookie);
  const markup = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  assert.match(markup, /data-app-catalogue/);
  assert.match(markup, /data-app-filter-state/);
  assert.match(markup, /data-app-installed-region/);
  assert.match(markup, /id="twoje-aplikacje"/);
  assert.equal((markup.match(/data-app-no-results/g) || []).length, 1, 'only one filter empty-state container');
  assert.equal((html.match(/<article class="app-tile"/g) || []).length, 6);
  assert.match(html, /id="app-wordpress"[^>]*tabindex="-1"/);
  assert.match(html, /data-app-detail/);
  assert.match(html, /window\.OA_APP_CATALOG/);
});

test('installed filter with zero results renders exactly one empty state', async () => {
  const cookie = await loginAs('demouser');
  const { html } = await page('/user/app-catalog', cookie);
  const script = extractCatalogScript(html);
  const env = catalogEnvironment(html, { installed: false });
  vm.runInContext(script, env.context);
  const api = env.sandbox.OA_APP_CATALOG || env.context.OA_APP_CATALOG;
  assert.ok(api, 'catalogue runtime API must be exposed');

  api.setFilter('installed');
  assert.equal(api.getVisibleCount(), 0);
  assert.equal(env.grid.hidden, true);
  assert.equal(env.empty.hidden, false, 'filter empty state must be visible');
  assert.equal(env.installedRegion.hidden, true, 'installed region must be hidden to avoid a second empty state');
  assert.equal(env.title.textContent, 'Nie masz jeszcze zainstalowanych aplikacji');
  assert.equal(env.cta.textContent, 'Pokaż wszystkie aplikacje');
  assert.equal(env.count.textContent, '0 z 6 aplikacji');
  const visibleEmptyStates = [env.empty, env.installedRegion].filter((element) => !element.hidden).length;
  assert.equal(visibleEmptyStates, 1);
});

test('available filter with everything installed renders exactly one empty state', async () => {
  const cookie = await loginAs('demouser');
  const { html } = await page('/user/app-catalog', cookie);
  const script = extractCatalogScript(html);
  const env = catalogEnvironment(html, { installed: true });
  vm.runInContext(script, env.context);
  const api = env.sandbox.OA_APP_CATALOG || env.context.OA_APP_CATALOG;

  api.setFilter('available');
  assert.equal(api.getVisibleCount(), 0);
  assert.equal(env.grid.hidden, true);
  assert.equal(env.empty.hidden, false);
  assert.equal(env.installedRegion.hidden, true);
  assert.equal(env.title.textContent, 'Wszystkie aplikacje są już zainstalowane');
  assert.equal([env.empty, env.installedRegion].filter((element) => !element.hidden).length, 1);
});

test('catalogue search empty state is localized and resettable', async () => {
  const cookie = await loginAs('demouser');
  const { html } = await page('/user/app-catalog', cookie);
  const script = extractCatalogScript(html);
  const env = catalogEnvironment(html);
  vm.runInContext(script, env.context);
  const api = env.sandbox.OA_APP_CATALOG || env.context.OA_APP_CATALOG;

  env.search.value = 'zzz-no-such-app';
  api.applyFilters();
  assert.equal(api.getVisibleCount(), 0);
  assert.equal(env.title.textContent, 'Brak aplikacji pasujących do wyszukiwania.');
  assert.equal(env.cta.textContent, 'Wyczyść filtry');
  assert.equal(env.count.textContent, '0 z 6 aplikacji');
});

test('#app-<key> focuses, expands and reveals the matching tile', async () => {
  const cookie = await loginAs('demouser');
  const { html } = await page('/user/app-catalog', cookie);
  const script = extractCatalogScript(html);
  const env = catalogEnvironment(html, { installed: false });
  vm.runInContext(script, env.context);
  const api = env.sandbox.OA_APP_CATALOG || env.context.OA_APP_CATALOG;

  const target = env.cards.find((card) => card.getAttribute('data-app-key') === 'wordpress');
  env.context.location.hash = '#app-wordpress';
  assert.equal(api.focusFromHash(), true);
  assert.equal(target.hidden, false);
  assert.equal(target.focused, true);
  assert.equal(target.getAttribute('aria-expanded'), 'true');
  assert.equal(target.classList.contains('is-target'), true);
  assert.equal(target.detail.hidden, false);

  api.setFilter('installed');
  assert.equal(api.getVisibleCount(), 0);
  assert.equal(api.focusFromHash(), true, 'anchor must reset a filter that hides the target');
  assert.equal(api.getFilter(), 'all');
  assert.equal(target.hidden, false);
});

test('catalogue tiles and installed rows label icon-only actions', async () => {
  const cookie = await loginAs('demouser');
  const { html } = await page('/user/app-catalog', cookie);
  assert.match(html, /data-copy="[^"]+" title="[^"]+" aria-label="[^"]+"/);
  const modalStart = html.indexOf('class="modal" role="dialog" aria-modal="true" aria-labelledby="app-modal-wordpress-title"');
  assert.ok(modalStart > -1, 'install modal must render');
  const modal = html.slice(modalStart, html.indexOf('<script>', modalStart));
  assert.match(modal, /aria-labelledby="[^"]+-title"/);
  assert.match(modal, /aria-describedby="[^"]+-desc"/);
  assert.match(modal, /aria-label="Zamknij okno instalacji"/);
  assert.match(modal, /<legend class="field-label">Dane instalacji<\/legend>/);
  assert.match(modal, /required aria-required="true"/);
  for (const id of modal.matchAll(/aria-describedby="([^"]+)"/g)) {
    for (const ref of id[1].split(/\s+/)) {
      assert.ok(html.includes(`id="${ref}"`), `missing aria-describedby target ${ref}`);
    }
  }
});

test('CSP uses a nonce and all rendered scripts carry it', async () => {
  const cookie = await loginAs('demoadmin');
  const { res, html } = await page('/admin', cookie);
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  const nonce = /script-src 'self' 'nonce-([^']+)'/.exec(csp)?.[1];
  assert.ok(nonce, 'nonce is present');
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
  assert.ok(scripts.length > 0);
  for (const tag of scripts) assert.match(tag, new RegExp(`nonce="${nonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), tag);
  assert.doesNotMatch(html, /\son(click|change|submit|load|error)=/i, 'no inline event handlers');
});

test('admin navigation is translated in Polish, not mixed English labels', async () => {
  const cookie = await loginAs('demoadmin');
  const { html } = await page('/admin', cookie);
  const raw = ['Mail Operations', 'Live transfer', 'Panel Configuration', 'Show All Users', 'User Tools', 'Plans & Limits', 'User Statistics', 'Message System', 'Support Access', 'Audit Log', 'System Cron', 'Bulk actions'];
  for (const label of raw) assert.doesNotMatch(html, new RegExp(`>${label}<`), `raw nav label: ${label}`);
  assert.match(html, /Operacje poczty|Centrum uwagi|Automatyzacja/);
});
