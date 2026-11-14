// User and package administration shared by the Reseller and Admin levels.
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, nowIso, hashPassword, audit, setting, transaction } from '../db.mjs';
import { config } from '../config.mjs';
import { limitsFor } from '../auth.mjs';
import { html as h, isDomain, isEmail, isUsername, formatBytes, formatDate, safeJson } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, btn, badge, alert, emptyState, kvList, progress, form } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { listCard, domainSelect } from '../ui/pages/list.mjs';
import { visibleUsers, canManageUser, visibleDomains, ownedUsernames, quota } from '../core/access.mjs';
import { homeDir, provisionDomain } from './files.mjs';
import { createZone } from './domains.mjs';
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
      { label: 'Delete', form: (p) => `${path}/${encodeURIComponent(p.name)}/delete`, confirm: 'Delete this package?', icon: 'trash', danger: true, show: (p) => !(counts.get(p.name) > 0) },
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

export function packageForm(ctx, { path, type, existing = null }) {
  const limits = existing ? safeJson(existing.limits, {}) : (type === 'reseller'
    ? { users: 50, domains: 500, subdomains: 1000, emails: 1000, databases: 200, bandwidth_mb: 0, disk_mb: 102400, ips: 2, packages: 20, php: ['8.3'], dns_control: 1, cpu_percent: 0, memory_mb: 0, io_read_mbps: 0, io_write_mbps: 0, max_processes: 200 }
    : { domains: 10, subdomains: 25, emails: 50, ftp: 10, databases: 10, bandwidth_mb: 102400, disk_mb: 10240, cron: 5, ssl: 10, php: ['8.3'], dns_control: 0, cpu_percent: 0, memory_mb: 0, io_read_mbps: 0, io_write_mbps: 0, max_processes: 100 });
  const body = h`${card(existing ? `Edit package · ${existing.name}` : 'Create package', h`
    <form method="post" action="${path}${existing ? '/' + encodeURIComponent(existing.name) : '/create'}" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid">
        <div class="field"><label class="field-label">Package name</label>
          <input name="name" value="${existing?.name || ''}" ${existing ? 'disabled' : 'required'} pattern="[a-zA-Z0-9_.-]{2,40}"></div>
        <div class="field"><label class="field-label">Type</label><input value="${type === 'reseller' ? 'Reseller package' : 'User package'}" disabled></div>
      </div>
      <h3 class="form-section">Resource limits</h3>
      <p class="small muted" style="margin:-8px 0 14px">Set 0 for unlimited.</p>
      <div class="form-grid form-grid-3">
        ${LIMIT_FIELDS.filter(([k]) => type === 'reseller' || !['users', 'ips', 'packages'].includes(k)).map(([k, label]) => h`<div class="field">
          <label class="field-label">${label}</label><input type="number" min="0" name="lim_${k}" value="${limits[k] ?? 0}">
        </div>`)}
      </div>
      <h3 class="form-section">Features</h3>
      <div class="field field-full"><label class="field-label">Feature set</label>
        <select name="feature_set"><option value="">— ręcznie —</option>${featureSets().map((f) => h`<option value="${f.name}" ${limits.feature_set === f.name ? 'selected' : ''}>${f.name}</option>`)}</select>
        <p class="field-help">Wybranie feature setu nadpisuje poniższe przełączniki funkcji.</p></div>
      <div class="form-grid form-grid-3">
        ${BOOL_LIMITS.map(([k, label]) => h`<div class="field"><label class="check-field"><input type="checkbox" name="bool_${k}" value="1" ${Number(limits[k]) ? 'checked' : ''}> <span>${label}</span></label></div>`)}
        <div class="field field-full"><label class="field-label">PHP versions</label>
          <div class="radio-row">${PHP.map((v) => h`<label class="check-field"><input type="checkbox" name="php[]" value="${v}" ${(limits.php || []).includes(v) ? 'checked' : ''}> <span>PHP ${v}</span></label>`)}</div></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('save', { size: 16 })} ${existing ? 'Save package' : 'Create package'}</button>
        <a class="btn btn-ghost" href="${path}">Cancel</a></div>
    </form>`)}`;
  return page(ctx, { title: existing ? 'Edit Package' : 'Create Package', subtitle: type === 'reseller' ? 'Reseller package limits' : 'User package limits', body });
}

export function savePackage(ctx, { type, owner, path }) {
  const name = String(ctx.body.name || '').trim();
  if (!/^[a-zA-Z0-9_.-]{2,40}$/.test(name)) return ctx.redirect(`${path}?flash=Invalid%20package%20name&type=error`);
  const limits = {};
  for (const [k] of LIMIT_FIELDS) if (ctx.body[`lim_${k}`] !== undefined) limits[k] = Number(ctx.body[`lim_${k}`]) || 0;
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
    createHref: `${path}/create`, createLabel: 'Create user',
    empty: 'No accounts yet.',
    toolbarLeft: level === 'user' ? [h`<a class="chip ${suspended === null ? 'active' : ''}" href="${path}">All</a><a class="chip ${suspended === 0 ? 'active' : ''}" href="${path}/suspended">Active</a>`] : [],
    actions: [
      { label: 'Login as', form: (u) => `${path}/${u.id}/login-as`, icon: 'logout', show: (u) => ctx.user.level === 'admin' && level === 'user' },
      { label: 'Edit', href: (u) => `${path}/${u.id}`, icon: 'edit' },
      { label: 'Suspend', form: (u) => `${path}/${u.id}/suspend`, icon: 'lock' },
      { label: 'Delete', form: (u) => `${path}/${u.id}/delete`, confirm: 'Permanently delete this account and all its data?', icon: 'trash', danger: true },
    ],
  })}`;
  return page(ctx, { title, subtitle: 'Manage hosted accounts', body, actions: [btn('Create user', { href: `${path}/create`, icon: 'plus' })] });
}

export function userForm(ctx, { path, existing = null, packages = [], resellers = false }) {
  const pkgRows = packages.length ? packages : all('SELECT * FROM packages WHERE type = ? ORDER BY name', 'user');
  const body = h`${card(existing ? `Modify user · ${existing.username}` : 'Create user', h`
    <form method="post" action="${path}${existing ? '/' + existing.id : '/create'}" class="oa-form" autocomplete="off">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid">
        <div class="field"><label class="field-label">Username <span class="req">*</span></label>
          <input name="username" value="${existing?.username || ''}" ${existing ? 'disabled' : 'required'} pattern="[a-z0-9][a-z0-9_.-]{1,31}" placeholder="johndoe">
          <p class="field-help">Lowercase letters, numbers, dot, dash and underscore.</p></div>
        <div class="field"><label class="field-label">${existing ? 'New password (leave blank to keep)' : 'Password'}</label>
          <div class="field-control"><input id="upass" name="password" type="password" minlength="8" ${existing ? '' : 'required'}>
            <button class="btn btn-secondary btn-sm" type="button" data-genpass="#upass" style="margin-left:8px">Generate</button></div></div>
        <div class="field"><label class="field-label">Email</label><input name="email" type="email" value="${existing?.email || ''}" required></div>
        <div class="field"><label class="field-label">Package</label><select name="package">
          ${pkgRows.map((p) => h`<option value="${p.name}" ${existing?.package === p.name ? 'selected' : ''}>${p.name}</option>`)}</select></div>
        <div class="field"><label class="field-label">Primary domain</label><input name="domain" value="${existing?.domain || ''}" placeholder="customer.com">
          <p class="field-help">Optional. Creates the document root, DNS zone and mail domain.</p></div>
        <div class="field"><label class="field-label">IP address</label><select name="ip">
          <option value="">${setting('server_ip', '127.0.0.1')} (server)</option>
          ${all("SELECT * FROM ips WHERE status != 'free'").map((i) => h`<option value="${i.ip}" ${existing?.ip === i.ip ? 'selected' : ''}>${i.ip}</option>`)}
        </select></div>
        ${resellers ? h`<div class="field"><label class="field-label">Reseller package</label><select name="package2">
          ${all("SELECT * FROM packages WHERE type = 'reseller'").map((p) => h`<option>${p.name}</option>`)}</select></div>` : ''}
        <div class="field field-full"><label class="field-label">Notes</label><textarea name="notes" rows="2">${existing?.notes || ''}</textarea></div>
        ${existing ? h`<div class="field field-full"><label class="check-field"><input type="checkbox" name="suspend" value="1" ${existing.suspended ? 'checked' : ''}> <span>Suspend this account</span></label></div>` : h`<div class="field field-full"><label class="check-field"><input type="checkbox" name="notify" value="1" checked> <span>Send a welcome message with the login details</span></label></div>`}
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('save', { size: 16 })} ${existing ? 'Save changes' : 'Create account'}</button>
        <a class="btn btn-ghost" href="${path}">Cancel</a></div>
    </form>`)}`;
  return page(ctx, { title: existing ? 'Modify User' : 'Create User', subtitle: existing ? existing.username : 'Provision a new hosting account', body });
}

export function createUser(ctx, { path, level = 'user', owner = null }) {
  const username = String(ctx.body.username || '').trim().toLowerCase();
  if (!isUsername(username) || username.length < 2) return ctx.redirect(`${path}/create?flash=Invalid%20username&type=error`);
  if (get('SELECT id FROM users WHERE lower(username) = ?', username)) return ctx.redirect(`${path}/create?flash=Username%20already%20exists&type=error`);
  const pkg = get('SELECT * FROM packages WHERE name = ? AND type = ?', String(ctx.body.package || 'default'), level === 'reseller' ? 'reseller' : 'user');
  if (!pkg) return ctx.redirect(`${path}/create?flash=Package%20not%20found&type=error`);
  const password = String(ctx.body.password || '');
  if (password.length < 8) return ctx.redirect(`${path}/create?flash=Password%20must%20be%20at%20least%208%20characters&type=error`);
  if (level === 'user' && ctx.user.level === 'reseller') {
    const q = quota(ctx.user, 'users');
    if (!q.ok) return ctx.redirect(`${path}/create?flash=User%20limit%20reached&type=error`);
  }
  const domain = String(ctx.body.domain || '').trim().toLowerCase();
  if (domain && !isDomain(domain)) return ctx.redirect(`${path}/create?flash=Invalid%20domain&type=error`);
  if (domain && get('SELECT id FROM domains WHERE name = ?', domain)) return ctx.redirect(`${path}/create?flash=Domain%20already%20exists&type=error`);
  const created = systemProvider().createUser(username, `/home/${username}`);
  if (!created.ok) return ctx.redirect(`${path}/create?flash=` + encodeURIComponent('System account failed: ' + created.output) + '&type=error');
  const ts = nowIso();
  const id = transaction(() => {
    const r = run(`INSERT INTO users(username, password, email, level, owner, package, domain, ip, notes, created_at, must_change_password)
                   VALUES(?,?,?,?,?,?,?,?,?,?,1)`,
      username, hashPassword(password), String(ctx.body.email || ''), level, owner, pkg.name, domain,
      String(ctx.body.ip || setting('server_ip', '127.0.0.1')), String(ctx.body.notes || ''), ts);
    if (domain) {
      const d = run(`INSERT INTO domains(user_id, username, name, docroot, php_version, ssl, status, is_main, ip, created_at)
                     VALUES(?,?,?,?,?,?,?,?,?,?)`,
        r.lastInsertRowid, username, domain, `/home/${username}/domains/${domain}/public_html`, '8.3', 1, 'active', 1,
        String(ctx.body.ip || setting('server_ip', '127.0.0.1')), ts);
      createZone(d.lastInsertRowid, domain);
      provisionDomain(username, domain);
    }
    homeDir(username);
    copySkeleton(username);
    if (ctx.body.notify) {
      run('INSERT INTO messages(level, username, subject, body, created_at) VALUES(?,?,?,?,?)', 'user', username,
        'Witaj w OpenAdmin', `Twoje konto jest gotowe.\nUżytkownik: ${username}\nPanel: https://${setting('server_name', 'localhost')}:2222\nDomeny: ${domain || '—'}`, ts);
    }
    return r.lastInsertRowid;
  });
  audit(ctx.user.username, ctx.user.level, 'user.create', username, ctx.ip);
  try { runHooks('user.create', { username, email: ctx.body.email, package: pkg.name, domain }); } catch { /* plugin failure does not block */ }
  try { apply({ web: true, dns: true, mail: true, pools: true }); } catch { /* apply status records failures */ }
  return ctx.redirect(`${path}/${id}?flash=` + encodeURIComponent(`Account ${username} created`));
}

export function updateUser(ctx, { path, target }) {
  const password = String(ctx.body.password || '');
  const shell = !!ctx.body.shell_enabled;
  if (shell !== !!target.shell_enabled) {
    const r = systemProvider().setShell(target.username, shell);
    if (!r.ok) return ctx.redirect(`${path}/${target.id}?flash=${encodeURIComponent('Shell change failed: ' + (r.output || 'unknown'))}&type=error`);
    run('UPDATE users SET shell_enabled = ? WHERE id = ?', shell ? 1 : 0, target.id);
  }
  if (password && password.length < 8) return ctx.redirect(`${path}/${target.id}?flash=Password%20too%20short&type=error`);
  run(`UPDATE users SET email = ?, package = ?, domain = ?, ip = ?, notes = ?, suspended = ?, must_change_password = ? WHERE id = ?`,
    String(ctx.body.email || target.email), String(ctx.body.package || target.package), String(ctx.body.domain || '').toLowerCase(),
    String(ctx.body.ip || target.ip), String(ctx.body.notes || ''), ctx.body.suspend ? 1 : 0,
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
  const body = h`
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
            <button class="btn btn-secondary btn-sm" type="button" data-genpass="#upass" style="margin-left:8px">Generate</button></div></div>
          <div class="field"><label class="field-label">Notes</label><input name="notes" value="${target.notes || ''}"></div>
          <div class="field field-full"><label class="check-field"><input type="checkbox" name="shell_enabled" value="1" ${target.shell_enabled ? 'checked' : ''}> <span>Shell access (SSH/terminal)</span></label></div>
          <div class="field field-full"><label class="check-field"><input type="checkbox" name="suspend" value="1" ${target.suspended ? 'checked' : ''}> <span>Suspend account</span></label></div>
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
      ])}`)}
    </div>
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
    }) : emptyState('No backups')}`)}`;
  return page(ctx, { title: target.username, subtitle: `${target.level} account · ${target.email || ''}`, body, actions: [
    btn('Sign in as user', { href: `${path}/${target.id}/login-as`, variant: 'secondary', icon: 'logout', attrs: 'onclick="return confirm(\'Open this account in a new session?\')"' }),
  ] });
}

export function toggleSuspend(ctx, { path, target }) {
  run('UPDATE users SET suspended = ? WHERE id = ?', target.suspended ? 0 : 1, target.id);
  audit(ctx.user.username, ctx.user.level, target.suspended ? 'user.unsuspend' : 'user.suspend', target.username, ctx.ip);
  return ctx.redirect(`${path}?flash=` + encodeURIComponent(`${target.username} ${target.suspended ? 'unsuspended' : 'suspended'}`));
}

export function deleteUser(ctx, { path, target }) {
  const domains = all('SELECT name FROM domains WHERE user_id = ?', target.id);
  const ftp = all('SELECT username FROM ftp_accounts WHERE user_id = ?', target.id);
  const dkim = all(`SELECT k.* FROM dkim_keys k JOIN domains d ON d.name = k.domain WHERE d.user_id = ?`, target.id);
  const backups = all('SELECT filename FROM backups WHERE user_id = ?', target.id);
  for (const d of domains) {
    try { fs.rmSync(zonePath(d.name), { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(certPaths(d.name).dir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(path.join(config.dataDir, 'dkim', `${d.name}.default.key`), { force: true }); } catch { /* ignore */ }
  }
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
      { label: 'Delete', form: (r) => `${path}/${r.id}/delete`, confirm: 'Delete this reseller?', icon: 'trash', danger: true },
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
