// User and package administration shared by the Reseller and Admin levels.
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, nowIso, hashPassword, audit, setting, setSetting, transaction } from '../db.mjs';
import { config } from '../config.mjs';
import { limitsFor } from '../auth.mjs';
import { html as h, isDomain, isEmail, isUsername, formatBytes, formatDate, safeJson } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, btn, badge, alert, emptyState, kvList, progress, form } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { listCard, domainSelect } from '../ui/pages/list.mjs';
import { visibleUsers, canManageUser, visibleDomains, ownedUsernames, quota } from '../core/access.mjs';
import { passwordPolicyError } from '../security.mjs';
import {
  provisionAccount, lastAccountProvision, pendingActivation, rememberChoices,
} from '../provisioning.mjs';
import { renderUserProvisioningForm, renderAccountResult } from './wizards.mjs';
import { purgeAcmeForDomain } from '../autossl.mjs';
import { homeDir } from './files.mjs';
import { systemProvider } from '../providers/index.mjs';
import { zonePath } from '../dns.mjs';
import { certPaths } from '../ssl.mjs';
import { cronPath } from '../cron.mjs';
import { backupPath } from '../backups.mjs';
import { runHooks } from '../plugins.mjs';
import { syncMail } from '../mail.mjs';
import { generateAll } from '../webserver.mjs';
import { deployPools } from '../phpfpm.mjs';
import { apply } from '../apply.mjs';
import { userHome } from '../paths.mjs';
import { featureSets } from '../plancenter.mjs';

const LIMIT_FIELDS = [
  ['domains', 'Domains'], ['subdomains', 'Subdomains'], ['emails', 'Email accounts'], ['email_quota_mb', 'Mailbox quota (MB)'],
  ['ftp', 'FTP accounts'], ['databases', 'Databases'], ['bandwidth_mb', 'Bandwidth (MB/mo)'], ['disk_mb', 'Disk quota (MB)'],
  ['inodes', 'Inodes'], ['cron', 'Cron jobs'], ['ssl', 'SSL certificates'], ['users', 'Users (resellers)'], ['ips', 'IP addresses'],
  ['packages', 'Packages (resellers)'], ['autoresponders', 'Autoresponders'], ['forwarders', 'Forwarders'], ['mailing_lists', 'Mailing lists'],
  ['cpu_percent', 'CPU limit (%)'], ['memory_mb', 'Memory limit (MB)'], ['io_read_mbps', 'IO read (MB/s)'], ['io_write_mbps', 'IO write (MB/s)'],
  ['max_processes', 'Max processes'],
];
const BOOL_LIMITS = [['dns_control', 'DNS control'], ['ssh', 'SSH access'], ['cgi', 'CGI scripts'], ['spam', 'Spam filter'], ['catch_all', 'Catch-all email'], ['wordpress', 'WordPress manager'], ['nodejs', 'Node.js apps'], ['python', 'Python apps'], ['git', 'Git']];
const PHP = ['8.4', '8.3', '8.2', '8.1', '7.4'];

export const BASE = '/user';

/* --------------------------------------------------------------- packages */
export function packagesPage(ctx, { owner = null, type = 'user', path = '/reseller/packages' } = {}) {
  const rows = owner
    ? all('SELECT * FROM packages WHERE type = ? AND (owner IS NULL OR owner = ?) ORDER BY name', type, owner)
    : all('SELECT * FROM packages WHERE type = ? ORDER BY name', type);
  const counts = new Map(all('SELECT package, COUNT(*) n FROM users GROUP BY package').map((r) => [r.package, r.n]));
  const body = h`${listCard({
    title: type === 'reseller' ? 'Reseller packages' : 'User packages',
    sub: `${rows.length} package(s) · shared limits for every account that uses them`,
    columns: [
      { label: 'Package', render: (p) => h`<span class="cell-strong">${p.name}</span>${p.owner ? h`<span class="cell-sub">owned by ${p.owner}</span>` : h`<span class="cell-sub">global</span>`}` },
      { label: 'Domains', render: (p) => fmtLimit(safeJson(p.limits, {}).domains) },
      { label: 'Email', render: (p) => fmtLimit(safeJson(p.limits, {}).emails) },
      { label: 'Disk', render: (p) => fmtLimit(safeJson(p.limits, {}).disk_mb, ' MB') },
      { label: 'Bandwidth', render: (p) => fmtLimit(safeJson(p.limits, {}).bandwidth_mb, ' MB') },
      { label: 'Accounts', render: (p) => String(counts.get(p.name) || 0) },
    ],
    rows,
    createHref: `${path}/create`,
    createLabel: 'Create package',
    empty: 'No packages yet.',
    actions: [
      { label: 'Edit', href: (p) => `${path}/${encodeURIComponent(p.name)}`, icon: 'edit' },
      { label: 'Copy', form: (p) => `${path}/${encodeURIComponent(p.name)}/copy`, icon: 'copy' },
      { label: 'Delete', form: (p) => `${path}/${encodeURIComponent(p.name)}/delete`, confirm: 'Usunąć ten pakiet?', icon: 'trash', danger: true, show: (p) => !(counts.get(p.name) > 0) },
    ],
  })}`;
  return page(ctx, { title: type === 'reseller' ? 'Reseller Packages' : 'User Packages', subtitle: 'Define storage, feature and account limits', body });
}

function copySkeleton(username) {
  const src = setting('skeleton_directory', '/etc/skel');
  if (!fs.existsSync(src)) return;
  const home = `/home/${username}`;
  try {
    fs.mkdirSync(home, { recursive: true });
    for (const ent of fs.readdirSync(src)) {
      const to = path.join(home, ent);
      if (fs.existsSync(to)) continue;
      fs.cpSync(path.join(src, ent), to, { recursive: true, errorOnExist: false, force: false });
    }
    systemProvider().chownUser(username);
  } catch { /* skeleton is best effort */ }
}

function fmtLimit(v, unit = '') {
  if (v === undefined || v === null) return '—';
  if (Number(v) === 0) return 'unlimited';
  return `${Number(v).toLocaleString()}${unit}`;
}

const LIMIT_PL = {
  domains: 'Domeny', subdomains: 'Subdomeny', emails: 'Skrzynki e-mail', email_quota_mb: 'Limit skrzynki (MB)',
  ftp: 'Konta FTP', databases: 'Bazy danych', bandwidth_mb: 'Transfer (MB/mies.)', disk_mb: 'Limit dysku (MB)',
  inodes: 'Inody', cron: 'Zadania cron', ssl: 'Certyfikaty SSL', users: 'Konta (reseller)', ips: 'Adresy IP',
  packages: 'Pakiety (reseller)', autoresponders: 'Autorespondery', forwarders: 'Przekierowania', mailing_lists: 'Listy mailingowe',
  cpu_percent: 'Limit CPU (%)', memory_mb: 'Limit pamięci (MB)', io_read_mbps: 'Odczyt IO (MB/s)', io_write_mbps: 'Zapis IO (MB/s)',
  max_processes: 'Maks. procesów',
};
const BOOL_PL = { dns_control: 'Kontrola DNS', ssh: 'Dostęp SSH', cgi: 'Skrypty CGI', spam: 'Filtr spamu', catch_all: 'Catch-all', wordpress: 'Menedżer WordPress', nodejs: 'Aplikacje Node.js', python: 'Aplikacje Python', git: 'Git' };
const PACKAGE_PRESETS = {
  starter: { label: 'Starter — mała strona', values: { domains: 1, subdomains: 5, emails: 5, ftp: 2, databases: 1, disk_mb: 1024, bandwidth_mb: 10240, cron: 0, ssl: 1, max_processes: 50 } },
  business: { label: 'Business — firma', values: { domains: 10, subdomains: 50, emails: 100, ftp: 20, databases: 20, disk_mb: 20480, bandwidth_mb: 204800, cron: 10, ssl: 10, max_processes: 100 } },
  unlimited: { label: 'Unlimited — bez limitów', values: Object.fromEntries(LIMIT_FIELDS.map(([k]) => [k, 0])) },
};

function packageLimitInput(k, limits) {
  const value = limits[k] ?? 0;
  return h`<div class="field package-limit"><label class="field-label" for="lim-${k}">${LIMIT_PL[k] || k}</label>
    <input id="lim-${k}" type="number" min="0" name="lim_${k}" value="${value}" data-limit="${k}">
    <label class="check-field package-unlimited"><input type="checkbox" name="unl_${k}" value="1" data-unlimited="${k}" ${Number(value) === 0 ? 'checked' : ''}> <span>nielimitowane</span></label>
  </div>`;
}

export function packageForm(ctx, { path, type, existing = null }) {
  const limits = existing ? safeJson(existing.limits, {}) : (type === 'reseller'
    ? { users: 50, domains: 500, subdomains: 1000, emails: 1000, databases: 200, bandwidth_mb: 0, disk_mb: 102400, ips: 2, packages: 20, php: ['8.3'], dns_control: 1, cpu_percent: 0, memory_mb: 0, io_read_mbps: 0, io_write_mbps: 0, max_processes: 200 }
    : { domains: 10, subdomains: 25, emails: 50, ftp: 10, databases: 10, bandwidth_mb: 102400, disk_mb: 10240, cron: 5, ssl: 10, php: ['8.3'], dns_control: 0, cpu_percent: 0, memory_mb: 0, io_read_mbps: 0, io_write_mbps: 0, max_processes: 100 });
  const fields = LIMIT_FIELDS.filter(([k]) => type === 'reseller' || !['users', 'ips', 'packages'].includes(k));
  const body = h`${card(existing ? `Edytuj pakiet · ${existing.name}` : 'Nowy pakiet', h`
    <form method="post" action="${path}${existing ? '/' + encodeURIComponent(existing.name) : '/create'}" class="oa-form package-form" data-package-form>
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid">
        <div class="field"><label class="field-label" for="pkg-name">Nazwa pakietu <span class="req">*</span></label>
          <input id="pkg-name" name="name" value="${existing?.name || ''}" ${existing ? 'disabled' : 'required'} pattern="[a-zA-Z0-9_.-]{2,40}" placeholder="starter"></div>
        <div class="field"><label class="field-label" for="pkg-type">Typ</label><input id="pkg-type" value="${type === 'reseller' ? 'Pakiet resellera' : 'Pakiet użytkownika'}" disabled></div>
        <div class="field field-full"><label class="field-label" for="pkg-preset">Preset</label>
          <select id="pkg-preset" data-package-preset><option value="">— własne ustawienia —</option>${Object.entries(PACKAGE_PRESETS).map(([key, preset]) => h`<option value="${key}">${preset.label}</option>`)}</select>
          <p class="field-help">Preset wypełnia limity; możesz je potem zmienić. „Nielimitowane” oznacza 0 i nie zużywa limitu.</p></div>
      </div>
      <div class="package-layout">
        <div class="package-main">
          <details class="package-section"><summary>Zasoby</summary>
            <div class="form-grid form-grid-3">${fields.filter(([k]) => !['cpu_percent', 'memory_mb', 'io_read_mbps', 'io_write_mbps', 'max_processes'].includes(k)).map(([k]) => packageLimitInput(k, limits))}</div>
          </details>
          <details class="package-section"><summary>Funkcje</summary>
            <div class="field field-full"><label class="field-label" for="pkg-feature-set">Feature set</label>
              <select id="pkg-feature-set" name="feature_set" data-feature-set><option value="">— ręcznie —</option>${featureSets().map((f) => h`<option value="${f.name}" ${limits.feature_set === f.name ? 'selected' : ''}>${f.name}</option>`)}</select>
              <p class="field-help" data-feature-note>Wybranie feature setu nadpisuje poniższe przełączniki funkcji. Przy ręcznym ustawieniu decydują checkboksy.</p></div>
            <div class="form-grid form-grid-3">${BOOL_LIMITS.map(([k]) => h`<div class="field"><label class="check-field"><input type="checkbox" name="bool_${k}" value="1" data-feature-toggle ${Number(limits[k]) ? 'checked' : ''}> <span>${BOOL_PL[k] || k}</span></label></div>`)}</div>
            <div class="field field-full"><label class="field-label">Wersje PHP</label><div class="radio-row">${PHP.map((v) => h`<label class="check-field"><input type="checkbox" name="php[]" value="${v}" data-feature-toggle ${(limits.php || []).includes(v) ? 'checked' : ''}> <span>PHP ${v}</span></label>`)}</div></div>
          </details>
          <details class="package-section"><summary>Wydajność i zasoby systemowe</summary>
            <div class="form-grid form-grid-3">${fields.filter(([k]) => ['cpu_percent', 'memory_mb', 'io_read_mbps', 'io_write_mbps', 'max_processes'].includes(k)).map(([k]) => packageLimitInput(k, limits))}</div>
          </details>
        </div>
        <aside class="package-summary"><div class="package-summary-inner">
          <strong>Podsumowanie</strong>
          <p class="small muted" data-package-summary>Wybierz preset lub ustaw limity ręcznie.</p>
          <div class="small muted">Puste pole = 0 = nielimitowane. Feature set ma pierwszeństwo przed checkboksami.</div>
        </div></aside>
      </div>
      <div class="package-savebar"><button class="btn btn-primary" type="submit">${icon('save', { size: 16 })} ${existing ? 'Zapisz pakiet' : 'Utwórz pakiet'}</button>
        <a class="btn btn-ghost" href="${path}">Anuluj</a></div>
    </form>`)}`;
  return page(ctx, { title: existing ? 'Edytuj pakiet' : 'Nowy pakiet', subtitle: type === 'reseller' ? 'Limity pakietu resellera' : 'Limity pakietu użytkownika', body });
}

export function savePackage(ctx, { type, owner, path }) {
  const name = String(ctx.body.name || '').trim();
  if (!/^[a-zA-Z0-9_.-]{2,40}$/.test(name)) return ctx.redirect(`${path}?flash=Invalid%20package%20name&type=error`);
  const limits = {};
  for (const [k] of LIMIT_FIELDS) {
    if (ctx.body[`unl_${k}`]) limits[k] = 0;
    else if (ctx.body[`lim_${k}`] !== undefined) limits[k] = Number(ctx.body[`lim_${k}`]) || 0;
  }
  limits.ssh = ctx.body.bool_ssh ? 1 : 0;
  limits.cgi = ctx.body.bool_cgi ? 1 : 0;
  limits.spam = ctx.body.bool_spam ? 1 : 0;
  limits.catch_all = ctx.body.bool_catch_all ? 1 : 0;
  limits.wordpress = ctx.body.bool_wordpress ? 1 : 0;
  limits.nodejs = ctx.body.bool_nodejs ? 1 : 0;
  limits.python = ctx.body.bool_python ? 1 : 0;
  limits.git = ctx.body.bool_git ? 1 : 0;
  limits.dns_control = ctx.body.bool_dns_control ? 1 : 0;
  limits.php = [].concat(ctx.body.php || []).filter((v) => PHP.includes(v));
  if (!limits.php.length) limits.php = ['8.3'];
  if (ctx.body.feature_set) {
    const fs = get('SELECT * FROM feature_sets WHERE name = ?', String(ctx.body.feature_set));
    if (fs) {
      const features = safeJson(fs.features, {});
      for (const [k, v] of Object.entries(features)) limits[k] = v ? 1 : 0;
      limits.feature_set = fs.name;
    }
  }
  const exists = get('SELECT * FROM packages WHERE name = ?', name);
  if (exists) {
    if (owner && exists.owner && exists.owner !== owner) return ctx.redirect(`${path}?flash=You%20cannot%20edit%20this%20package&type=error`);
    run('UPDATE packages SET limits = ?, updated_at = ? WHERE name = ?', JSON.stringify(limits), nowIso(), name);
  } else {
    run('INSERT INTO packages(name, owner, type, limits, created_at) VALUES(?,?,?,?,?)', name, owner, type, JSON.stringify(limits), nowIso());
  }
  try { deployPools(); } catch { /* apply status records failures */ }
  return ctx.redirect(`${path}?flash=` + encodeURIComponent(`Package ${name} saved`));
}

/* ------------------------------------------------------------------ users */
export function usersPage(ctx, { path = '/reseller/users', level = 'user', suspended = null, title = 'Users' } = {}) {
  const rows = visibleUsers(ctx.user, { level, suspended });
  const withStats = rows.map((u) => ({
    ...u,
    domainCount: get('SELECT COUNT(*) n FROM domains WHERE user_id = ?', u.id).n,
    disk: get('SELECT COALESCE(SUM(disk_mb),0) d FROM domains WHERE user_id = ?', u.id).d,
  }));
  const lim = limitsFor(ctx.user);
  const body = h`${listCard({
    title, sub: `${withStats.length} account(s)${level === 'user' && lim.users ? ` of ${lim.users}` : ''}`,
    columns: [
      { label: 'Username', render: (u) => h`<a class="cell-strong" href="${path}/${u.id}">${u.username}</a><span class="cell-sub">${u.email || '—'}</span>` },
      { label: 'Domain', render: (u) => (u.domain ? h`<span class="cell-mono">${u.domain}</span>` : '—') },
      { label: 'Package', render: (u) => badge(u.package || 'default', 'brand') },
      { label: 'Domains', render: (u) => u.domainCount, align: 'right' },
      { label: 'Disk', render: (u) => formatBytes(u.disk), align: 'right' },
      { label: 'Status', render: (u) => (u.suspended ? badge('Suspended', 'danger', { dot: true }) : badge('Active', 'ok', { dot: true })) },
      { label: 'Last login', render: (u) => (u.last_login ? formatDate(u.last_login) : 'never') },
    ],
    rows: withStats,
    empty: 'No accounts yet.',
    toolbarLeft: level === 'user' ? [h`<a class="chip ${suspended === null ? 'active' : ''}" href="${path}">All</a><a class="chip ${suspended === 0 ? 'active' : ''}" href="${path}/suspended">Active</a>`] : [],
    actions: [
      { label: 'Login as', form: (u) => `${path}/${u.id}/login-as`, icon: 'logout', show: (u) => ctx.user.level === 'admin' && level === 'user' },
      { label: 'Edit', href: (u) => `${path}/${u.id}`, icon: 'edit' },
      { label: 'Suspend', form: (u) => `${path}/${u.id}/suspend`, icon: 'lock' },
      { label: 'Delete', form: (u) => `${path}/${u.id}/delete`, confirm: 'Permanently delete this account and all its data?', icon: 'trash', danger: true },
    ],
  })}`;
  return page(ctx, { title, subtitle: 'Zarządzaj kontami hostingowymi', body, actions: [btn('Szybkie konto', { href: `${path}/quick`, variant: 'secondary', icon: 'plus' }), btn('Pełny kreator', { href: `${path}/create`, icon: 'plus' })] });
}

function visiblePackageRows(ctx) {
  return all("SELECT * FROM packages WHERE type = 'user' ORDER BY name")
    .filter((pkg) => ctx.user.level !== 'reseller' || !pkg.owner || pkg.owner === ctx.user.username);
}


/** One-page account creation for the common case: customer + package + optional site. */
export function quickUserForm(ctx, { path, packages = [], values = {}, preflight = null, error = '' } = {}) {
  const rows = (packages.length ? packages : visiblePackageRows(ctx)).filter((pkg) => pkg.type === 'user');
  const v = values || {};
  const selected = String(v.package || rows[0]?.name || '');
  const resellerRows = ctx.user.level === 'admin' ? all("SELECT username FROM users WHERE level = 'reseller' ORDER BY username") : [];
  const body = h`${error ? alert(error, 'danger') : ''}
    ${preflight && (preflight.errors?.length || preflight.checks?.length) ? alert(h`<ul class="doc-list">${(preflight.errors || []).map((entry) => h`<li><strong>${entry.code || 'Błąd'}:</strong> ${entry.message || entry}</li>`)}</ul>`, 'danger', { title: 'Popraw pola i spróbuj ponownie' }) : ''}
    ${card('Szybkie konto klienta', h`<form method="post" action="${path}/quick" class="oa-form" autocomplete="off">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid">
        <div class="field"><label class="field-label" for="quick-username">Login klienta <span class="req">*</span></label>
          <input id="quick-username" name="username" value="${v.username || ''}" required pattern="[a-z0-9][a-z0-9_.-]{1,31}" placeholder="johndoe" autocomplete="off">
          <p class="field-help">Małe litery, cyfry, kropka, myślnik i podkreślenie.</p></div>
        <div class="field"><label class="field-label" for="quick-email">E-mail klienta <span class="req">*</span></label>
          <input id="quick-email" name="email" type="email" value="${v.email || ''}" required></div>
        <div class="field"><label class="field-label" for="quick-package">Pakiet <span class="req">*</span></label>
          <select id="quick-package" name="package" required>${rows.map((pkg) => h`<option value="${pkg.name}" ${pkg.name === selected ? 'selected' : ''}>${pkg.name}${pkg.owner ? ` — ${pkg.owner}` : ' — globalny'}</option>`)}</select></div>
        <div class="field"><label class="field-label" for="quick-domain">Domena (opcjonalnie)</label>
          <input id="quick-domain" name="domain" value="${v.domain || ''}" placeholder="klient.pl" autocomplete="off">
          <p class="field-help">Jeśli podasz domenę, panel utworzy stronę, DNS i certyfikat.</p></div>
        <div class="field"><label class="field-label" for="quick-password">Hasło (opcjonalnie)</label>
          <div class="field-control"><input id="quick-password" name="password" type="password" minlength="10" placeholder="Puste = link aktywacyjny">
            <button class="btn btn-secondary btn-sm" type="button" data-genpass="#quick-password">Wygeneruj</button></div>
          <p class="field-help">Puste pole oznacza bezpieczny link aktywacyjny zamiast hasła w plaintext.</p></div>
        ${ctx.user.level === 'admin' ? h`<div class="field"><label class="field-label" for="quick-owner">Właściciel (reseller)</label>
          <select id="quick-owner" name="owner"><option value="">Administrator (bez resellera)</option>${resellerRows.map((row) => h`<option value="${row.username}" ${v.owner === row.username ? 'selected' : ''}>${row.username}</option>`)}</select></div>` : ''}
        <div class="field field-full"><label class="check-field"><input type="checkbox" name="create_domain" value="1" ${v.create_domain === undefined || v.create_domain ? 'checked' : ''}> <span>Utwórz stronę WWW, DNS i certyfikat dla podanej domeny</span></label></div>
        <div class="field field-full"><label class="check-field"><input type="checkbox" name="create_mailbox" value="1" ${v.create_mailbox ? 'checked' : ''}> <span>Utwórz skrzynkę postmaster@domena</span></label></div>
        <div class="field field-full"><label class="check-field"><input type="checkbox" name="create_backup" value="1" ${v.create_backup ? 'checked' : ''}> <span>Dodaj dzienny profil kopii zapasowej</span></label></div>
        <div class="field field-full"><label class="field-label" for="quick-notes">Notatka wewnętrzna</label><textarea id="quick-notes" name="notes" rows="2">${v.notes || ''}</textarea></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('plus', { size: 16 })} Utwórz konto</button>
        <a class="btn btn-ghost" href="${path}/create">Przejdź do pełnego kreatora</a>
        <a class="btn btn-ghost" href="${path}">Anuluj</a></div>
    </form>`, { sub: 'Najczęstszy scenariusz: klient, pakiet i opcjonalnie pierwsza strona. Pełny kreator pozostaje dostępny.' })}`;
  return page(ctx, { title: 'Szybkie konto klienta', subtitle: 'Jedna strona zamiast pięciu kroków', body, wide: true });
}

export function createQuickUser(ctx, { path, level = 'user', owner = null } = {}) {
  const body = ctx.body || {};
  const values = { ...body };
  const payload = {
    actor: ctx.user,
    level,
    owner: owner ?? (body.owner || null),
    username: body.username,
    email: body.email,
    package: body.package,
    password: body.password,
    activation: !body.password,
    domain: body.domain,
    create_domain: body.domain ? body.create_domain !== undefined : false,
    create_dns: true,
    create_mailbox: !!body.create_mailbox,
    mailbox_local: 'postmaster',
    mailbox_quota_mb: 1024,
    create_backup: !!body.create_backup,
    create_monitoring: false,
    notify: true,
    notes: body.notes,
    rollbackOnFailure: true,
    actorIp: ctx.ip,
  };
  let result;
  try { result = provisionAccount(payload); }
  catch (error) {
    return quickUserForm(ctx, { path, values, error: `Nie udało się uruchomić provisioningu: ${error.message}` });
  }
  if (result.ok) {
    try { rememberChoices(ctx.user, 'account', { createDns: true, backup: !!body.create_backup, docroot: true, php: true, vhost: true }); } catch { /* best effort */ }
    return page(ctx, {
      title: 'Konto utworzone',
      subtitle: `${result.username} · ${result.package || ''}`,
      body: h`${renderAccountResult(result)}<div class="row mt-18"><a class="btn btn-primary" href="${path}/${result.userId}">Otwórz konto</a><a class="btn btn-secondary" href="${path}/quick">Utwórz kolejne</a><a class="btn btn-ghost" href="${path}">Wróć do listy</a></div>`,
      wide: true,
    });
  }
  return quickUserForm(ctx, { path, values, preflight: result, error: 'Konto nie zostało utworzone — popraw zaznaczone pola.' });
}

export function userForm(ctx, { path, existing = null, packages = [], resellers = false, values = null, preflight = null, error = '' } = {}) {
  const pkgRows = (packages.length ? packages : all('SELECT * FROM packages WHERE type = ? ORDER BY name', existing?.level === 'reseller' ? 'reseller' : 'user'))
    .filter((pkg) => ctx.user.level !== 'reseller' || !pkg.owner || pkg.owner === ctx.user.username);
  if (!existing) {
    const resellerRows = ctx.user.level === 'admin'
      ? all("SELECT username FROM users WHERE level = 'reseller' ORDER BY username")
      : [];
    const body = renderUserProvisioningForm(ctx, {
      path,
      packages: pkgRows.filter((pkg) => pkg.type === 'user'),
      values: values || {},
      preflight,
      error,
      resellers: resellerRows,
    });
    return page(ctx, {
      title: 'Utwórz konto klienta',
      subtitle: 'Kontakt → pakiet → domena/DNS → WWW/PHP/SSL/poczta → preflight → atomowe wykonanie',
      body,
      wide: true,
    });
  }
  const body = h`${card(existing ? `Modify user · ${existing.username}` : 'Create user', h`
    <form method="post" action="${path}/${existing.id}" class="oa-form" autocomplete="off">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid">
        <div class="field"><label class="field-label" for="oa-edit-username">Username</label>
          <input id="oa-edit-username" name="username" value="${existing.username}" disabled></div>
        <div class="field"><label class="field-label" for="oa-edit-password">Nowe hasło (puste = bez zmiany)</label>
          <div class="field-control"><input id="oa-edit-password" name="password" type="password" minlength="10">
            <button class="btn btn-secondary btn-sm u-s18" type="button" data-genpass="#oa-edit-password">Generate</button></div>
          <p class="field-help">Polityka panelu: długość i klasy znaków są sprawdzane po stronie serwera.</p></div>
        <div class="field"><label class="field-label" for="oa-edit-email">Email</label><input id="oa-edit-email" name="email" type="email" value="${existing.email || ''}" required></div>
        <div class="field"><label class="field-label" for="oa-edit-package">Package</label><select id="oa-edit-package" name="package">
          ${pkgRows.map((p) => h`<option value="${p.name}" ${existing.package === p.name ? 'selected' : ''}>${p.name}${p.owner ? ` — ${p.owner}` : ''}</option>`)}</select></div>
        <div class="field"><label class="field-label" for="oa-edit-domain">Primary domain</label><input id="oa-edit-domain" name="domain" value="${existing.domain || ''}" placeholder="customer.com">
          <p class="field-help">Zmiana pola nie przenosi automatycznie plików — domenę dodaj w kreatorze domen.</p></div>
        <div class="field"><label class="field-label" for="oa-edit-ip">IP</label><input id="oa-edit-ip" name="ip" value="${existing.ip || ''}"></div>
        <div class="field field-full"><label class="field-label" for="oa-edit-notes">Notes</label><textarea id="oa-edit-notes" name="notes" rows="2">${existing.notes || ''}</textarea></div>
        <div class="field field-full"><label class="check-field"><input type="checkbox" name="shell_enabled" value="1" ${existing.shell_enabled ? 'checked' : ''}> <span>Shell access (SSH/terminal)</span></label></div>
        <div class="field field-full"><label class="check-field"><input type="checkbox" name="suspend" value="1" ${existing.suspended ? 'checked' : ''}> <span>Suspend this account</span></label></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('save', { size: 16 })} Save changes</button>
        <a class="btn btn-ghost" href="${path}">Cancel</a></div>
    </form>`)}`;
  return page(ctx, { title: existing ? 'Modify User' : 'Create User', subtitle: existing ? existing.username : 'Provision a new hosting account', body });
}

function wizardPayload(ctx, { level = 'user', owner = null } = {}) {
  const body = ctx.body || {};
  const wizard = String(body.wizard || '') === '1';
  const explicit = (name) => (wizard ? body[name] === '1' : body[name] === undefined ? undefined : body[name] === '1' || body[name] === 'on' || body[name] === true);
  return {
    actor: ctx.user,
    level,
    owner: owner ?? (body.owner || null),
    username: body.username,
    email: body.email,
    contact_name: body.contact_name,
    phone: body.phone,
    notes: body.notes,
    package: body.new_package_name ? '__new__' : (body.package || 'default'),
    new_package_name: body.new_package_name,
    new_limit_domains: body.new_limit_domains,
    new_limit_emails: body.new_limit_emails,
    new_limit_disk_mb: body.new_limit_disk_mb,
    new_limit_bandwidth_mb: body.new_limit_bandwidth_mb,
    new_limit_databases: body.new_limit_databases,
    password: body.password,
    activation: wizard ? body.activation === '1' : !body.password,
    domain: body.domain,
    create_domain: undefined,
    engine: body.engine,
    php_version: body.php_version,
    ssl_mode: body.ssl_mode,
    ip: body.ip,
    create_dns: wizard ? body.create_dns === '1' : true,
    dns_template: body.dns_template,
    check_delegation: explicit('check_delegation'),
    create_mailbox: explicit('create_mailbox'),
    mailbox_local: body.mailbox_local,
    mailbox_quota_mb: body.mailbox_quota_mb,
    app: (body.app && body.app !== 'none') || body.wordpress === '1'
      ? {
        type: body.wordpress === '1' && !body.app ? 'wordpress' : body.app,
        title: body.app_title,
        adminUser: body.app_admin_user,
        adminEmail: body.app_admin_email,
        adminPassword: body.app_admin_password,
      }
      : 'none',
    create_backup: explicit('create_backup'),
    create_monitoring: explicit('create_monitoring'),
    retry_ssl_after_dns: explicit('retry_ssl_after_dns'),
    docroot: wizard ? body.docroot === '1' : undefined,
    php_step: wizard ? body.php_step === '1' : undefined,
    vhost: wizard ? body.vhost === '1' : undefined,
    notify: wizard ? body.notify === '1' : !!body.notify,
    rollbackOnFailure: true,
    actorIp: ctx.ip,
  };
}

export function createUser(ctx, { path, level = 'user', owner = null }) {
  const payload = wizardPayload(ctx, { level, owner });
  let result;
  try {
    result = provisionAccount(payload);
  } catch (error) {
    const values = ctx.body || {};
    const body = renderUserProvisioningForm(ctx, {
      path,
      packages: visiblePackageRows(ctx),
      values,
      error: `Nie udało się uruchomić provisioningu: ${error.message}`,
    });
    return page(ctx, { title: 'Utwórz konto klienta', subtitle: 'Błąd provisioningu', body, wide: true });
  }

  if (result.ok) {
    try {
      rememberChoices(ctx.user, 'account', {
        engine: payload.engine, phpVersion: payload.php_version, sslMode: payload.ssl_mode,
        dnsTemplateId: payload.dns_template ? Number(payload.dns_template) || '' : '',
        createDns: payload.create_dns !== false, createMailbox: !!payload.create_mailbox,
        mailboxLocal: payload.mailbox_local, mailboxQuotaMb: Number(payload.mailbox_quota_mb) || 1024,
        backup: !!payload.create_backup, monitoring: !!payload.create_monitoring,
        delegationCheck: !!payload.check_delegation, retrySslAfterDns: !!payload.retry_ssl_after_dns,
        docroot: payload.docroot !== false, php: payload.php_step !== false, vhost: payload.vhost !== false,
      });
    } catch { /* preferences are best effort */ }
    return ctx.redirect(`${path}/${result.userId}?created=1&flash=` + encodeURIComponent(`Konto ${result.username} utworzone`));
  }

  // A partial account that could not be rolled back is still a real account:
  // send the operator to its detail page where every step is visible.
  if (result.userId && !result.rolledBack) {
    return ctx.redirect(`${path}/${result.userId}?created=1&type=error&flash=` + encodeURIComponent('Konto powstało częściowo — przejrzyj kroki provisioningu.'));
  }
  const values = ctx.body || {};
  const body = renderUserProvisioningForm(ctx, {
    path,
    packages: visiblePackageRows(ctx),
    values,
    preflight: result,
    error: 'Konfiguracja została odrzucona — nic nie zostało utworzone.',
  });
  return page(ctx, {
    title: 'Utwórz konto klienta',
    subtitle: 'Popraw konfigurację i spróbuj ponownie',
    body,
    wide: true,
  });
}

export function updateUser(ctx, { path, target }) {
  const password = String(ctx.body.password || '');
  const shell = !!ctx.body.shell_enabled;
  const email = String(ctx.body.email || target.email || '').trim();
  if (email && !isEmail(email)) return ctx.redirect(`${path}/${target.id}?flash=${encodeURIComponent('Nieprawidłowy adres e-mail')}&type=error`);
  const packageName = String(ctx.body.package || target.package || '');
  const pkg = get('SELECT * FROM packages WHERE name = ?', packageName);
  const wantedType = target.level === 'reseller' ? 'reseller' : 'user';
  if (!pkg || pkg.type !== wantedType) {
    return ctx.redirect(`${path}/${target.id}?flash=${encodeURIComponent('Pakiet nie istnieje lub ma nieprawidłowy typ')}&type=error`);
  }
  if (ctx.user.level === 'reseller' && pkg.owner && pkg.owner !== ctx.user.username) {
    return ctx.redirect(`${path}/${target.id}?flash=${encodeURIComponent('Ten pakiet należy do innego resellera')}&type=error`);
  }
  const domain = String(ctx.body.domain || '').trim().toLowerCase();
  if (domain && !isDomain(domain)) return ctx.redirect(`${path}/${target.id}?flash=${encodeURIComponent('Nieprawidłowa domena główna')}&type=error`);
  if (domain) {
    const existing = get('SELECT * FROM domains WHERE name = ?', domain);
    if (existing && existing.user_id !== target.id) {
      return ctx.redirect(`${path}/${target.id}?flash=${encodeURIComponent('Ta domena należy do innego konta')}&type=error`);
    }
  }
  if (shell !== !!target.shell_enabled) {
    const r = systemProvider().setShell(target.username, shell);
    if (!r.ok) return ctx.redirect(`${path}/${target.id}?flash=${encodeURIComponent('Shell change failed: ' + (r.output || 'unknown'))}&type=error`);
    run('UPDATE users SET shell_enabled = ? WHERE id = ?', shell ? 1 : 0, target.id);
  }
  if (password) { const policyError = passwordPolicyError(password); if (policyError) return ctx.redirect(`${path}/${target.id}?flash=${encodeURIComponent(policyError)}&type=error`); }
  const suspended = ctx.body.suspend ? 1 : 0;
  const suspendReason = suspended ? String(ctx.body.suspend_reason || target.suspended_reason || '').slice(0, 500) : null;
  const suspendUntilRaw = suspended ? String(ctx.body.suspend_until || '').trim() : '';
  const suspendUntil = suspendUntilRaw && Number.isFinite(Date.parse(suspendUntilRaw)) ? new Date(suspendUntilRaw).toISOString() : null;
  run(`UPDATE users SET email = ?, package = ?, domain = ?, ip = ?, notes = ?, suspended = ?, suspended_reason = ?, suspended_until = ?, must_change_password = ? WHERE id = ?`,
    email || target.email, pkg.name, domain || target.domain || '',
    String(ctx.body.ip || target.ip), String(ctx.body.notes || ''), suspended, suspendReason, suspendUntil,
    password ? 1 : target.must_change_password, target.id);
  if (password) run('UPDATE users SET password = ? WHERE id = ?', hashPassword(password), target.id);
  audit(ctx.user.username, ctx.user.level, 'user.update', target.username, ctx.ip);
  return ctx.redirect(`${path}/${target.id}?flash=Account%20updated`);
}

export function userDetailPage(ctx, { path, target }) {
  const domains = all('SELECT * FROM domains WHERE user_id = ? ORDER BY name', target.id);
  const backups = all('SELECT * FROM backups WHERE user_id = ? ORDER BY created_at DESC LIMIT 5', target.id);
  const limits = limitsFor(target);
  const usage = all('SELECT * FROM usage_daily WHERE username = ? ORDER BY day DESC LIMIT 30', target.username);
  const bw = usage.reduce((a, r) => a + (r.bandwidth_mb || 0), 0);
  const activation = pendingActivation(target.id);
  const provision = lastAccountProvision(target.id);
  const mailboxes = all(`SELECT e.* FROM email_accounts e JOIN domains d ON d.id = e.domain_id WHERE d.user_id = ? ORDER BY e.domain, e.local_part LIMIT 10`, target.id);
  const databases = all('SELECT * FROM databases WHERE user_id = ? ORDER BY db_name LIMIT 10', target.id);
  const apps = all('SELECT * FROM app_installs WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', target.id);
  const tickets = all('SELECT id, subject, status, created_at FROM tickets WHERE username = ? ORDER BY id DESC LIMIT 5', target.username);
  const resellerView = String(path).startsWith('/reseller');
  const ticketBase = resellerView ? '/reseller/tickets' : '/admin/tickets';
  const body = h`
    ${ctx.query.created === '1' ? alert('Konto zostało utworzone. Poniżej znajduje się rzeczywisty wynik provisioningu.', provision?.ok === false ? 'warn' : 'ok') : ''}
    ${activation ? card('Aktywacja konta', h`
      ${alert('Hasło nie jest wyświetlane w panelu. Przekaż klientowi jednorazowy link aktywacyjny — wygasa po godzinie.', 'info')}
      <div class="field"><label class="field-label" for="oa-activation-url">Link aktywacyjny</label>
        <input id="oa-activation-url" readonly value="${activation.url}"></div>
      <p class="small muted">Utworzono ${formatDate(activation.createdAt, { time: true })}.</p>
      <form method="post" action="${path}/${target.id}/activation"><input type="hidden" name="_csrf" value="${ctx.csrf}">
        <button class="btn btn-secondary" type="submit">${icon('refresh', { size: 16 })} Wygeneruj nowy link</button></form>`) : ''}
    ${!activation && target.level !== 'admin' ? card('Aktywacja konta', h`
      <p class="small muted">Brak aktywnego linku aktywacyjnego (wykorzystany lub wygasł). Możesz wygenerować nowy jednorazowy link.</p>
      <form method="post" action="${path}/${target.id}/activation"><input type="hidden" name="_csrf" value="${ctx.csrf}">
        <button class="btn btn-secondary" type="submit">${icon('refresh', { size: 16 })} Wygeneruj link aktywacyjny</button></form>`) : ''}
    <div class="grid grid-2-1">
      ${card('Account', h`<form method="post" action="${path}/${target.id}" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Username</label><input value="${target.username}" disabled></div>
          <div class="field"><label class="field-label">Level</label><input value="${target.level}" disabled></div>
          <div class="field"><label class="field-label">Email</label><input name="email" type="email" value="${target.email || ''}"></div>
          <div class="field"><label class="field-label">Package</label><select name="package">
            ${all('SELECT * FROM packages WHERE type = ? ORDER BY name', target.level === 'reseller' ? 'reseller' : 'user').map((p) => h`<option ${p.name === target.package ? 'selected' : ''}>${p.name}</option>`)}</select></div>
          <div class="field"><label class="field-label">Primary domain</label><input name="domain" value="${target.domain || ''}"></div>
          <div class="field"><label class="field-label">IP</label><input name="ip" value="${target.ip || ''}"></div>
          <div class="field"><label class="field-label">New password</label><div class="field-control"><input id="upass" name="password" type="password" placeholder="leave blank to keep">
            <button class="btn btn-secondary btn-sm u-s18" type="button" data-genpass="#upass">Generate</button></div></div>
          <div class="field"><label class="field-label">Notes</label><input name="notes" value="${target.notes || ''}"></div>
          <div class="field field-full"><label class="check-field"><input type="checkbox" name="shell_enabled" value="1" ${target.shell_enabled ? 'checked' : ''}> <span>Shell access (SSH/terminal)</span></label></div>
          <div class="field field-full"><label class="check-field"><input type="checkbox" name="suspend" value="1" ${target.suspended ? 'checked' : ''}> <span>Suspend account</span></label></div>
          <div class="field"><label class="field-label" for="oa-suspend-reason">Powód zawieszenia</label><input id="oa-suspend-reason" name="suspend_reason" value="${target.suspended_reason || ''}" placeholder="np. zaległa płatność"></div>
          <div class="field"><label class="field-label" for="oa-suspend-until">Automatycznie odwieś</label><input id="oa-suspend-until" name="suspend_until" type="datetime-local" value="${target.suspended_until ? String(target.suspended_until).slice(0,16) : ''}"><p class="field-help">Puste = bez terminu.</p></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save account</button>
          <a class="btn btn-ghost" href="${path}">Back to list</a></div>
      </form>`)}
      ${card('Usage', h`${kvList([
        ['Domains', `${domains.length} / ${limits.domains || '∞'}`],
        ['Disk', formatBytes(domains.reduce((a, d) => a + d.disk_mb, 0))],
        ['Bandwidth (30d)', formatBytes(bw)],
        ['Email accounts', String(get('SELECT COUNT(*) n FROM email_accounts WHERE domain IN (SELECT name FROM domains WHERE user_id = ?)', target.id).n)],
        ['Databases', String(get('SELECT COUNT(*) n FROM databases WHERE user_id = ?', target.id).n)],
        ['Created', formatDate(target.created_at)],
        ['Last login', target.last_login ? formatDate(target.last_login, { time: true }) : 'never'],
        ['Status', target.suspended ? badge('Suspended', 'danger') : badge('Active', 'ok')],
        ['Powód zawieszenia', target.suspended_reason || '—'],
        ['Odwieszenie', target.suspended_until ? formatDate(target.suspended_until, { time: true }) : '—'],
      ])}`)}
    </div>
    ${card('Klient 360°', h`<div class="grid grid-2">
      <div class="stack"><strong>Poczta · ${mailboxes.length}</strong>${mailboxes.length ? mailboxes.map((m) => h`<div class="spread small"><span>${m.local_part}@${m.domain}</span><span>${formatBytes(m.used_mb)}</span></div>`) : h`<span class="small muted">Brak skrzynek.</span>`}</div>
      <div class="stack"><strong>Bazy · ${databases.length}</strong>${databases.length ? databases.map((d) => h`<div class="spread small"><span class="cell-mono">${d.db_name}</span><span>${formatBytes(d.size_mb)}</span></div>`) : h`<span class="small muted">Brak baz.</span>`}</div>
      <div class="stack"><strong>Aplikacje · ${apps.length}</strong>${apps.length ? apps.map((a) => h`<div class="spread small"><span>${a.type} · ${a.domain}</span>${badge(a.status || 'active', a.status === 'active' ? 'ok' : 'warn')}</div>`) : h`<span class="small muted">Brak instalacji.</span>`}</div>
      <div class="stack"><strong>Zgłoszenia · ${tickets.filter((t) => t.status !== 'closed').length} otwarte</strong>${tickets.length ? tickets.map((t) => h`<div class="spread small">${resellerView ? h`<a class="link" href="${ticketBase}/${t.id}">${t.subject}</a>` : h`<span>${t.subject}</span>`}<span>${t.status}</span></div>`) : h`<span class="small muted">Brak zgłoszeń.</span>`}</div>
    </div>`, { sub: 'Jedna karta: domena, poczta, bazy, aplikacje i zgłoszenia — wszystko w scope tego klienta' })}
    ${card('Domains', h`${domains.length ? table({
      columns: [
        { label: 'Domain', render: (d) => h`<span class="cell-strong">${d.name}</span>` },
        { label: 'PHP', key: 'php_version' },
        { label: 'SSL', render: (d) => (d.ssl ? badge('on', 'ok') : badge('off', 'muted')) },
        { label: 'Disk', render: (d) => formatBytes(d.disk_mb), align: 'right' },
      ], rows: domains, empty: 'No domains',
    }) : emptyState('No domains')}`, { sub: 'Document roots and limits follow the account package' })}
    ${card('Recent backups', h`${backups.length ? table({
      columns: [{ label: 'File', key: 'filename' }, { label: 'Size', render: (b) => formatBytes(b.size_mb) }, { label: 'Created', render: (b) => formatDate(b.created_at) }],
      rows: backups, empty: 'None',
    }) : emptyState('No backups')}`)}
    ${provision ? card('Wynik provisioningu konta', h`${renderAccountResult(provision, { title: 'Kroki wykonania' })}`,
    { sub: `${formatDate(provision.at, { time: true })} · ${provision.rolledBack ? 'rollback wykonany' : provision.ok ? 'sukces' : 'częściowy wynik'}` }) : ''}`;
  return page(ctx, { title: target.username, subtitle: `${target.level} account · ${target.email || ''}`, body, actions: [
    btn('Sign in as user', { href: `${path}/${target.id}/login-as`, variant: 'secondary', icon: 'logout', attrs: 'data-confirm="Otworzyć to konto w nowej sesji?"' }),
  ] });
}

export function toggleSuspend(ctx, { path, target }) {
  const reason = String(ctx.body?.reason || '').trim().slice(0, 500);
  const untilRaw = String(ctx.body?.until || '').trim();
  let until = null;
  if (untilRaw) {
    const parsed = new Date(untilRaw);
    if (!Number.isFinite(parsed.getTime())) return ctx.redirect(`${path}/${target.id}?flash=${encodeURIComponent('Nieprawidłowa data końca zawieszenia')}&type=error`);
    until = parsed.toISOString();
  }
  if (target.suspended) {
    run('UPDATE users SET suspended = 0, suspended_reason = NULL, suspended_until = NULL WHERE id = ?', target.id);
    audit(ctx.user.username, ctx.user.level, 'user.unsuspend', target.username, ctx.ip);
  } else {
    run('UPDATE users SET suspended = 1, suspended_reason = ?, suspended_until = ? WHERE id = ?', reason || null, until, target.id);
    audit(ctx.user.username, ctx.user.level, 'user.suspend', `${target.username}${until ? ` until ${until}` : ''}${reason ? `: ${reason}` : ''}`, ctx.ip);
  }
  return ctx.redirect(`${path}/${target.id}?flash=` + encodeURIComponent(`${target.username} ${target.suspended ? 'unsuspended' : 'suspended'}`));
}

export function deleteUser(ctx, { path, target }) {
  const domains = all('SELECT name FROM domains WHERE user_id = ?', target.id);
  const ftp = all('SELECT username FROM ftp_accounts WHERE user_id = ?', target.id);
  const dkim = all(`SELECT k.* FROM dkim_keys k JOIN domains d ON d.name = k.domain WHERE d.user_id = ?`, target.id);
  const backups = all('SELECT filename FROM backups WHERE user_id = ?', target.id);
  for (const d of domains) {
    try { purgeAcmeForDomain(d.name); } catch { /* queue cleanup is best effort */ }
    try { run('DELETE FROM backup_jobs WHERE name = ? AND target_user = ?', `site:${d.name}`, target.username); } catch { /* ignore */ }
    run('DELETE FROM settings WHERE key = ?', `site_monitoring:${d.name}`);
    run('DELETE FROM settings WHERE key = ?', `site_provision_last:${d.name}`);
    try { fs.rmSync(zonePath(d.name), { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(certPaths(d.name).dir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(path.join(config.dataDir, 'dkim', `${d.name}.default.key`), { force: true }); } catch { /* ignore */ }
  }
  run('DELETE FROM settings WHERE key = ?', `user_provision_last:${target.id}`);
  run('DELETE FROM settings WHERE key = ?', `user_activation:${target.id}`);
  run('DELETE FROM password_resets WHERE user_id = ?', target.id);
  for (const k of dkim) { try { fs.rmSync(k.key_path, { force: true }); } catch { /* ignore */ } }
  for (const f of ftp) { try { systemProvider().deleteFtpUser(f.username); } catch { /* ignore */ } }
  for (const b of backups) { try { fs.rmSync(backupPath(b.filename), { force: true }); } catch { /* ignore */ } }
  try { fs.rmSync(cronPath(target.username), { force: true }); } catch { /* ignore */ }
  systemProvider().deleteUser(target.username);
  run('DELETE FROM users WHERE id = ?', target.id);
  try { fs.rmSync(userHome(target.username), { recursive: true, force: true }); } catch { /* ignore */ }
  try { apply({ web: true, dns: true, mail: true, pools: true }); } catch { /* ignore */ }
  audit(ctx.user.username, ctx.user.level, 'user.delete', target.username, ctx.ip);
  try { deployPools(); } catch { /* apply status records failures */ }
  return ctx.redirect(`${path}?flash=` + encodeURIComponent(`Account ${target.username} deleted`));
}

/* ------------------------------------------------------------- resellers */
export function resellersPage(ctx, path = '/admin/resellers') {
  const rows = all("SELECT * FROM users WHERE level = 'reseller' ORDER BY username").map((u) => ({
    ...u,
    userCount: get("SELECT COUNT(*) n FROM users WHERE owner = ?", u.username).n,
    domainCount: get('SELECT COUNT(*) n FROM domains WHERE username = ?', u.username).n,
  }));
  const body = h`${listCard({
    title: 'Resellers', sub: `${rows.length} reseller(s)`,
    columns: [
      { label: 'Reseller', render: (r) => h`<a class="cell-strong" href="${path}/${r.id}">${r.username}</a><span class="cell-sub">${r.email || '—'}</span>` },
      { label: 'Package', render: (r) => badge(r.package || '—', 'brand') },
      { label: 'Users', render: (r) => r.userCount, align: 'right' },
      { label: 'Domains', render: (r) => r.domainCount, align: 'right' },
      { label: 'Created', render: (r) => formatDate(r.created_at) },
      { label: 'Status', render: (r) => (r.suspended ? badge('Suspended', 'danger') : badge('Active', 'ok')) },
    ],
    rows, createHref: `${path}/create`, createLabel: 'Create reseller', empty: 'No resellers yet.',
    actions: [
      { label: 'Edit', href: (r) => `${path}/${r.id}`, icon: 'edit' },
      { label: 'Suspend', form: (r) => `${path}/${r.id}/suspend`, icon: 'lock' },
      { label: 'Delete', form: (r) => `${path}/${r.id}/delete`, confirm: 'Usunąć tego resellera?', icon: 'trash', danger: true },
    ],
  })}`;
  return page(ctx, { title: 'Resellers', subtitle: 'Manage reseller accounts and their limits', body });
}

export function resellerForm(ctx, { path, existing = null }) {
  const pkgs = all("SELECT * FROM packages WHERE type = 'reseller' ORDER BY name");
  const body = h`${card(existing ? `Modify reseller · ${existing.username}` : 'Create reseller', h`<form method="post" action="${path}${existing ? '/' + existing.id : '/create'}" class="oa-form">
    <input type="hidden" name="_csrf" value="${ctx.csrf}">
    <div class="form-grid">
      <div class="field"><label class="field-label">Username <span class="req">*</span></label><input name="username" value="${existing?.username || ''}" ${existing ? 'disabled' : 'required'} pattern="[a-z0-9][a-z0-9_.-]{1,31}"></div>
      <div class="field"><label class="field-label">${existing ? 'New password' : 'Password'}</label><input id="rpass" name="password" type="password" minlength="8" ${existing ? '' : 'required'}></div>
      <div class="field"><label class="field-label">Email</label><input name="email" type="email" value="${existing?.email || ''}" required></div>
      <div class="field"><label class="field-label">Reseller package</label><select name="package">${pkgs.map((p) => h`<option ${p.name === existing?.package ? 'selected' : ''}>${p.name}</option>`)}</select></div>
      <div class="field"><label class="field-label">Primary domain</label><input name="domain" value="${existing?.domain || ''}"></div>
      <div class="field"><label class="field-label">IP</label><input name="ip" value="${existing?.ip || setting('server_ip', '')}"></div>
    </div>
    <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('save', { size: 16 })} ${existing ? 'Save reseller' : 'Create reseller'}</button>
      <a class="btn btn-ghost" href="${path}">Cancel</a></div>
  </form>`)}`;
  return page(ctx, { title: existing ? 'Modify Reseller' : 'Create Reseller', subtitle: 'Resellers can create and manage users', body });
}

void form; void progress; void domainSelect; void visibleDomains; void ownedUsernames; void canManageUser; void isEmail;
