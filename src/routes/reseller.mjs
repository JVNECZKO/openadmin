// Reseller-level routes: dashboards, users, packages, DNS, stats, tickets.
import { all, get, run, nowIso, setting, audit, hashPassword } from '../db.mjs';
import { createSession, limitsFor } from '../auth.mjs';
import { html as h, formatBytes, formatDate, formatDate as fd, timeAgo } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, btn, badge, alert, emptyState, kvList, progress, statCard } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { listCard, domainSelect } from '../ui/pages/list.mjs';
import { countForNav, visibleUsers, visibleDomains, usageSeries, canManageUser, domainFor } from '../core/access.mjs';
import { usersPage, userForm, createUser, updateUser, userDetailPage, toggleSuspend, deleteUser, packagesPage, packageForm, savePackage, resellerForm } from '../features/user-admin.mjs';
import { usageChartCard } from '../ui/pages/widgets.mjs';
import { rebuildZone } from '../dns.mjs';
import { apply } from '../apply.mjs';
import { appIcon } from '../ui/appicons.mjs';
import { listApps, installApp } from '../appcatalog.mjs';
import { installWordPress } from '../wordpress.mjs';
import { installNextcloud } from '../nextcloud.mjs';

const R = '/reseller';

function resellerDashboard(ctx) {
  const users = visibleUsers(ctx.user, { level: 'user' });
  const domains = visibleDomains(ctx.user);
  const series = usageSeries(ctx.user.username, 30);
  const lim = limitsFor(ctx.user);
  const bw = series.reduce((a, r) => a + (r.bandwidth_mb || 0), 0);
  const disk = domains.reduce((a, d) => a + d.disk_mb, 0);
  const tickets = all("SELECT * FROM tickets WHERE username IN (SELECT username FROM users WHERE owner = ?) AND status != 'closed' ORDER BY created_at DESC LIMIT 5", ctx.user.username);
  const body = h`
    <div class="hero">
      <div>
        <h2>Pulpit resellera</h2>
        <p>Zarządzasz <strong>${users.length}</strong> kontem/klientami i <strong>${domains.length}</strong> domenami. Twórz pakiety, zakładaj konta i pilnuj limitów.</p>
        <div class="row mt-18">${badge('Pakiet: ' + (ctx.user.package || 'reseller'), 'brand')}${badge('Darmowa licencja', 'ok')}${badge('Bez limitu resellera', 'ok')}</div>
      </div>
      <div class="hero-actions">
        ${btn('Utwórz klienta', { href: '/reseller/users/create', icon: 'plus' })}
        ${btn('Nowy pakiet', { href: '/reseller/packages/create', variant: 'secondary', icon: 'archive' })}
      </div>
    </div>
    <div class="stat-grid">
      ${statCard({ label: 'Użytkownicy', value: `${users.length}${lim.users ? ' / ' + lim.users : ''}`, sub: 'konta klientów', icon: 'users', href: '/reseller/users' })}
      ${statCard({ label: 'Domeny', value: String(domains.length), sub: 'w Twoim resellerze', icon: 'globe', href: '/reseller/dns' })}
      ${statCard({ label: 'Użycie dysku', value: formatBytes(disk), sub: lim.disk_mb ? 'z ' + formatBytes(lim.disk_mb) : 'bez limitu', icon: 'database', tone: 'warn' })}
      ${statCard({ label: 'Transfer (30 dni)', value: formatBytes(bw), sub: 'ruch resellera', icon: 'chart', tone: 'ok', href: '/reseller/statistics' })}
    </div>
    <div class="grid grid-2-1">
      ${usageChartCard(series, { title: 'Transfer resellera', sub: 'Ostatnie 30 dni, wszyscy klienci' })}
      ${card('Ostatnie konta', h`${users.length ? h`<div class="timeline">${users.slice(-5).reverse().map((u) => h`<div class="timeline-item">
        <div class="timeline-dot">${icon('user', { size: 15 })}</div>
        <div class="timeline-body"><div class="spread"><a class="link" href="/reseller/users/${u.id}"><strong>${u.username}</strong></a><span class="small muted">${timeAgo(u.created_at)}</span></div>
          <small>${u.domain || 'no domain'} · ${u.package}</small></div></div>`)}</div>` : emptyState('No users yet', { action: btn('Create the first user', { href: '/reseller/users/create', icon: 'plus' }) })}`, { actions: [h`<a class="link small" href="/reseller/users">All users</a>`] })}
    </div>
    <div class="grid grid-2">
      ${card('Otwarte zgłoszenia', h`${tickets.length ? h`<div class="timeline">${tickets.map((t) => h`<div class="timeline-item"><div class="timeline-dot">${icon('ticket', { size: 15 })}</div>
        <div class="timeline-body"><div class="spread"><a class="link" href="/reseller/tickets/${t.id}">${t.subject}</a><span class="small muted">${timeAgo(t.created_at)}</span></div><small>${t.username} · ${t.priority}</small></div></div>`)}</div>` : emptyState('No open tickets')}`, { actions: [h`<a class="link small" href="/reseller/tickets">All tickets</a>`] })}
      ${card('Twoje limity', h`<div class="stack" style="gap:14px">
        <div><div class="spread small"><span>Użytkownicy</span><span>${users.length} / ${lim.users || '∞'}</span></div>${progress(users.length, lim.users || 1, { showText: false })}</div>
        <div><div class="spread small"><span>Domeny</span><span>${domains.length} / ${lim.domains || '∞'}</span></div>${progress(domains.length, lim.domains || 1, { showText: false })}</div>
        <div><div class="spread small"><span>Dysk</span><span>${formatBytes(disk)} / ${lim.disk_mb ? formatBytes(lim.disk_mb) : '∞'}</span></div>${progress(disk, lim.disk_mb || 1, { showText: false })}</div>
        <div><div class="spread small"><span>Adresy IP</span><span>${get("SELECT COUNT(*) n FROM ips WHERE owner = ?", ctx.user.username).n} / ${lim.ips || '∞'}</span></div></div>
      </div>`, { actions: [h`<a class="link small" href="/reseller/settings">Settings</a>`] })}
    </div>
    <div class="mt-24">
      ${card('Szybkie akcje', h`<div class="quick-grid">
        ${quickTile('/reseller/users/create', 'plus', 'Nowy klient', 'Konto + domena + pakiet')}
        ${quickTile('/reseller/domains', 'globe', 'Domeny klientów', `${domains.length} domen`)}
        ${quickTile('/reseller/packages/create', 'archive', 'Nowy pakiet', 'Limity i funkcje')}
        ${quickTile('/reseller/apps', 'cart', 'Aplikacje', 'WordPress, sklep, chmura')}
        ${quickTile('/reseller/dns', 'dns', 'DNS klientów', 'Strefy i rekordy')}
        ${quickTile('/reseller/ip-manager', 'network', 'Adresy IP', 'Delegacja i zwalnianie')}
        ${quickTile('/reseller/backups', 'archive', 'Kopie klientów', 'Archiwum kont')}
        ${quickTile('/reseller/cpanel-import', 'download', 'Migracja cPanel', 'Przenieś konta')}
      </div>`)}
    </div>`;
  return page(ctx, { title: 'Pulpit resellera', subtitle: 'Twoje konta, pakiety i wykorzystanie zasobów', body, counts: countForNav(ctx.user, 'reseller') });
}

function resellerStatistics(ctx) {
  const users = visibleUsers(ctx.user, { level: 'user' });
  const series = usageSeries(ctx.user.username, 30);
  const rows = users.map((u) => {
    const doms = all('SELECT * FROM domains WHERE user_id = ?', u.id);
    const usage = all('SELECT * FROM usage_daily WHERE username = ? ORDER BY day DESC LIMIT 30', u.username);
    return { ...u, domains: doms.length, disk: doms.reduce((a, d) => a + d.disk_mb, 0), bw: usage.reduce((a, r) => a + (r.bandwidth_mb || 0), 0) };
  });
  const body = h`
    ${usageChartCard(series, { title: 'Aggregate bandwidth', sub: 'Reseller + users, last 30 days' })}
    ${card('Per-user usage', h`${table({
      columns: [
        { label: 'User', render: (u) => h`<a class="cell-strong" href="/reseller/users/${u.id}">${u.username}</a>` },
        { label: 'Package', render: (u) => badge(u.package, 'brand') },
        { label: 'Domains', render: (u) => u.domains, align: 'right' },
        { label: 'Disk', render: (u) => formatBytes(u.disk), align: 'right' },
        { label: 'Bandwidth', render: (u) => formatBytes(u.bw), align: 'right' },
      ],
      rows: rows.sort((a, b) => b.bw - a.bw), empty: 'No users yet.',
    })}`)}`;
  return page(ctx, { title: 'Reseller Statistics', subtitle: 'Usage across every account you manage', body });
}

function resellerDns(ctx) {
  const domains = visibleDomains(ctx.user);
  const selected = ctx.query.domain || domains[0]?.name;
  const d = domains.find((x) => x.name === selected) || domains[0];
  const records = d ? all('SELECT * FROM dns_records WHERE domain_id = ? ORDER BY type, name', d.id) : [];
  const editing = ctx.query.edit ? records.find((r) => String(r.id) === String(ctx.query.edit)) : null;
  const body = h`
    ${domains.length ? domainSelect(domains, d?.name, { action: '/reseller/dns' }) : alert('No domains under your resellers yet.', 'warn')}
    ${d ? card(`DNS zone · ${d.name}`, h`<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Name</th><th>Type</th><th>Value</th><th>Priority</th><th>TTL</th><th></th></tr></thead>
      <tbody>${records.map((r) => h`<tr><td class="cell-mono">${r.name}</td><td>${badge(r.type, 'brand')}</td>
        <td class="cell-mono">${r.value}</td><td>${r.priority ?? '—'}</td><td>${r.ttl}</td>
        <td class="col-actions"><div class="row-actions">
          <a class="icon-btn" href="/reseller/dns?domain=${encodeURIComponent(d.name)}&edit=${r.id}" title="Edit">${icon('edit', { size: 16 })}</a>
          <form method="post" action="/reseller/dns/${r.id}/delete" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <button class="icon-btn danger" type="submit" title="Delete" onclick="return confirm('Delete record?')">${icon('trash', { size: 16 })}</button></form></div></td></tr>`)}</tbody>
    </table></div>`, { padded: false } ) : ''}
    ${d && editing ? card(`Edit record · ${editing.type} ${editing.name}`, h`<form method="post" action="/reseller/dns/${editing.id}/update" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid">
        <div class="field"><label class="field-label">Name</label><input name="name" value="${editing.name}" required></div>
        <div class="field"><label class="field-label">Type</label><select name="type">${['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'].map((t) => h`<option ${t === editing.type ? 'selected' : ''}>${t}</option>`)}</select></div>
        <div class="field field-full"><label class="field-label">Value</label><input name="value" value="${editing.value}" required></div>
        <div class="field"><label class="field-label">Priority</label><input name="priority" type="number" value="${editing.priority ?? ''}"></div>
        <div class="field"><label class="field-label">TTL</label><input name="ttl" type="number" value="${editing.ttl}" min="60"></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Save record</button><a class="btn btn-ghost" href="/reseller/dns?domain=${encodeURIComponent(d.name)}">Cancel</a></div></form>`) : ''}
    ${d ? card('Add record', h`<form method="post" action="/reseller/dns/add" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">
      <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="domain" value="${d.name}">
      <div class="field"><label class="field-label">Name</label><input name="name" value="@" style="width:140px"></div>
      <div class="field"><label class="field-label">Type</label><select name="type" style="width:100px">${['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'].map((t) => h`<option>${t}</option>`)}</select></div>
      <div class="field" style="flex:1;min-width:240px"><label class="field-label">Value</label><input name="value" required></div>
      <div class="field"><label class="field-label">Priority</label><input name="priority" type="number" style="width:100px"></div>
      <button class="btn btn-primary" type="submit">Add record</button>
    </form>`) : ''}`;
  return page(ctx, { title: 'DNS Administration', subtitle: 'Manage zones for your users', body });
}

function resellerIps(ctx) {
  const ips = all("SELECT * FROM ips WHERE owner = ? OR owner IS NULL OR owner = 'admin' ORDER BY ip", ctx.user.username);
  const body = h`${card('IP addresses', h`${table({
    columns: [
      { label: 'IP', render: (i) => h`<span class="cell-mono">${i.ip}</span>` },
      { label: 'Netmask', render: (i) => h`<span class="cell-mono">${i.netmask}</span>` },
      { label: 'Status', render: (i) => badge(i.status, i.status === 'free' ? 'muted' : 'ok') },
      { label: 'Owner', render: (i) => i.owner || 'admin' },
    ],
    rows: ips,
    empty: 'No IPs assigned.',
    actions: [{ label: 'Release', form: (i) => `/reseller/ip-manager/${i.id}/release`, icon: 'x', show: (i) => i.owner === ctx.user.username }],
  })}`, { sub: 'Shared IPs are used by all accounts; dedicated IPs are assigned per user' })}`;
  return page(ctx, { title: 'IP Manager', subtitle: 'Assign and release IP addresses', body });
}

function resellerTickets(ctx) {
  const rows = all(`SELECT t.* FROM tickets t JOIN users u ON u.id = t.user_id WHERE u.owner = ? ORDER BY t.created_at DESC`, ctx.user.username);
  const body = h`${listCard({
    title: 'Support tickets', sub: `${rows.filter((r) => r.status !== 'closed').length} open`,
    columns: [
      { label: 'Subject', render: (t) => h`<a class="cell-strong" href="/reseller/tickets/${t.id}">${t.subject}</a><span class="cell-sub">#${t.id} · ${t.username}</span>` },
      { label: 'Priority', render: (t) => badge(t.priority, t.priority === 'high' ? 'danger' : 'brand') },
      { label: 'Status', render: (t) => badge(t.status, t.status === 'open' ? 'brand' : 'ok') },
      { label: 'Updated', render: (t) => timeAgo(t.updated_at) },
    ],
    rows, empty: 'No tickets from your users.',
  })}`;
  return page(ctx, { title: 'Support Tickets', subtitle: 'Tickets from accounts you manage', body });
}

function ticketView(ctx, ticketId, base) {
  const t = get('SELECT * FROM tickets WHERE id = ?', Number(ticketId));
  if (!t) return ctx.redirect(base + '?flash=Ticket%20not%20found&type=error');
  const msgs = all('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at', t.id);
  const body = h`${card(`${t.subject}`, h`
    <div class="spread mb-18"><div class="row">${badge('#' + t.id, 'muted')}${badge(t.username, 'brand')}${badge(t.priority, 'brand')}${badge(t.status, 'ok')}</div>
      <span class="small muted">${formatDate(t.created_at, { time: true })}</span></div>
    <div class="ticket-thread">${msgs.map((m) => h`<div class="ticket-msg ${m.level === 'user' ? 'user' : 'staff'}">
      <div class="ticket-head"><strong>${m.author}</strong><span class="small muted">${formatDate(m.created_at, { time: true })}</span></div>
      <div class="ticket-body">${m.body}</div></div>`)}</div>
    <form method="post" action="${base}/${t.id}/reply" class="oa-form mt-18"><input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="field field-full"><label class="field-label">Staff reply</label><textarea name="message" rows="5" required></textarea></div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Send reply</button>
        <button class="btn btn-ghost" type="submit" formaction="${base}/${t.id}/close">Close ticket</button></div></form>`)}`;
  return page(ctx, { title: 'Ticket #' + t.id, subtitle: t.subject, body });
}

function resellerDomains(ctx) {
  const rows = all(`SELECT d.*, u.username, u.package, u.id user_id FROM domains d JOIN users u ON u.id = d.user_id WHERE u.owner = ? ORDER BY d.name`, ctx.user.username);
  const body = h`
    ${alert('To są domeny Twoich klientów. DNS możesz edytować bezpośrednio; pozostałe zmiany wykonasz w panelu klienta.', 'info')}
    <div class="grid grid-2">
      ${card('Domeny klientów', h`${rows.length ? h`<div class="table-wrap"><table class="data-table">
        <thead><tr><th>Domena</th><th>Klient</th><th>Pakiet</th><th>PHP</th><th>SSL</th><th>Dysk</th><th></th></tr></thead>
        <tbody>${rows.map((d) => h`<tr>
          <td><a class="cell-strong" href="/reseller/dns?domain=${encodeURIComponent(d.name)}">${d.name}</a><span class="cell-sub">${d.docroot || ''}</span></td>
          <td><a class="link" href="/reseller/users/${d.user_id}">${d.username}</a></td>
          <td>${badge(d.package || 'default', 'brand')}</td>
          <td>${d.php_version || '—'}</td>
          <td>${d.ssl ? badge('SSL', 'ok') : badge('brak', 'muted')}</td>
          <td>${formatBytes(d.disk_mb)}</td>
          <td class="col-actions"><div class="row-actions">
            <a class="icon-btn" href="/reseller/dns?domain=${encodeURIComponent(d.name)}" title="DNS">${icon('dns', { size: 16 })}</a>
            <form method="post" action="/reseller/users/${d.user_id}/login-as" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="icon-btn" type="submit" title="Zarządzaj kontem">${icon('edit', { size: 16 })}</button></form>
          </div></td>
        </tr>`)}</tbody>
      </table></div>` : emptyState('Brak domen — dodaj użytkownika i domenę.', { action: btn('Dodaj użytkownika', { href: '/reseller/users/create', icon: 'plus' }) })}`)}
      ${card('Szybkie akcje', h`<div class="quick-grid" style="grid-template-columns:repeat(2,1fr)">
        ${quickTile('/reseller/users/create', 'plus', 'Nowy klient', 'Konto + domena')}
        ${quickTile('/reseller/packages', 'archive', 'Pakiety', 'Limity i funkcje')}
        ${quickTile('/reseller/dns', 'dns', 'DNS', 'Strefy klientów')}
        ${quickTile('/reseller/apps', 'cart', 'Aplikacje', 'WordPress i inne')}
      </div>`)}
    </div>`;
  return page(ctx, { title: 'Domeny klientów', subtitle: 'Wszystkie domeny w Twoim resellerze', body, wide: true });
}

function quickTile(href, iconName, title, sub) {
  return h`<a class="quick-tile" href="${href}">${icon(iconName, { size: 20 })}<strong>${title}</strong><span>${sub}</span></a>`;
}

function resellerApps(ctx, result) {
  const users = visibleUsers(ctx.user, { level: 'user' });
  const domains = all(`SELECT d.*, u.username FROM domains d JOIN users u ON u.id = d.user_id WHERE u.owner = ? ORDER BY d.name`, ctx.user.username);
  const installed = [
    ...all(`SELECT w.*, u.username, 'wordpress' type FROM wordpress w JOIN domains d ON d.name = w.domain JOIN users u ON u.id = d.user_id WHERE u.owner = ?`, ctx.user.username),
    ...all(`SELECT a.*, u.username FROM app_installs a JOIN users u ON u.id = a.user_id WHERE u.owner = ? AND a.type IN ('nextcloud','joomla','drupal','prestashop','moodle')`, ctx.user.username),
  ];
  const apps = [
    { key: 'wordpress', name: 'WordPress', desc: 'Strona, blog lub sklep', version: 'latest' },
    { key: 'nextcloud', name: 'Nextcloud', desc: 'Prywatna chmura plików', version: '30' },
    { key: 'prestashop', name: 'PrestaShop', desc: 'Sklep e-commerce', version: '8.2' },
    { key: 'joomla', name: 'Joomla', desc: 'CMS / portal', version: '5.2' },
    { key: 'drupal', name: 'Drupal', desc: 'CMS / portal', version: '11.1' },
    { key: 'moodle', name: 'Moodle', desc: 'Platforma e-learning', version: '4.5' },
  ];
  const resultCard = result ? card('Instalacja zakończona', h`
      <div class="app-tile-head mb-18">${appIcon(result.app, { size: 52 })}<div><h3>${result.name}</h3><p class="app-tile-sub">${result.user} · ${result.domain}</p></div></div>
      ${result.warning ? alert(result.warning, 'warn') : ''}
      ${kvList([['URL', h`<a class="link" href="${result.url}" target="_blank">${result.url}</a>`], ['Baza', result.db || '—'], ['DB user', result.dbUser || '—'], ['DB hasło', h`<code>${result.dbPass || '—'}</code>`], ['Admin', result.adminUser || 'admin'], ['Hasło admina', h`<code>${result.adminPass || '—'}</code>`]])}
      <div class="row mt-18"><a class="btn btn-primary" href="/reseller/apps">Wróć do aplikacji</a></div>`) : '';
  const body = h`
    ${alert('Instalujesz aplikacje na domenach swoich klientów. Hasło administratora przekaż klientowi — pokazujemy je tylko raz.', 'info')}
    ${resultCard}
    <div class="app-tile-grid">
      ${apps.map((a) => h`<article class="app-tile">
        <div class="app-tile-head">${appIcon(a.key, { size: 52 })}<div><div class="app-tile-title"><h3>${a.name}</h3></div><p class="app-tile-sub">${a.desc}</p></div></div>
        <div class="app-meta"><span>v${a.version}</span><span>PHP + MariaDB</span></div>
        <div class="app-tile-actions"><details><summary class="btn btn-primary btn-sm">${icon('download', { size: 15 })} Zainstaluj dla klienta</summary>
          <form method="post" action="/reseller/apps/install" class="oa-form app-install-form">
            <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="app" value="${a.key}">
            <div class="form-grid">
              <div class="field field-full"><label class="field-label">Domena klienta</label><select name="domain" required>${domains.map((d) => h`<option value="${d.name}">${d.username} — ${d.name}</option>`)}</select></div>
              <div class="field"><label class="field-label">Ścieżka</label><input name="path" value="${a.key === 'wordpress' || a.key === 'nextcloud' ? '/' : '/' + a.key}"></div>
              <div class="field"><label class="field-label">Hasło admina</label><input name="admin_password" type="password" minlength="8" required></div>
            </div>
            <div class="form-actions"><button class="btn btn-primary" type="submit" ${users.length && domains.length ? '' : 'disabled'}>Zainstaluj ${a.name}</button></div>
          </form></details></div>
      </article>`)}
    </div>
    ${card('Zainstalowane aplikacje klientów', h`${installed.length ? installed.map((r) => h`<div class="app-installed">
      ${appIcon(r.type, { size: 40 })}<div><strong>${r.type === 'wordpress' ? 'WordPress' : r.type === 'nextcloud' ? 'Nextcloud' : r.type[0].toUpperCase() + r.type.slice(1)}</strong><p class="app-tile-sub">${r.username} · ${r.domain}${r.path && r.path !== '/' ? r.path : ''}</p></div>
      <div class="app-installed-actions"><a class="btn btn-secondary btn-sm" href="https://${r.domain}${r.path && r.path !== '/' ? r.path : ''}/" target="_blank">${icon('globe', { size: 15 })} Otwórz</a></div>
    </div>`) : h`<div class="app-empty">Brak aplikacji u klientów.</div>`}`)}`;
  return page(ctx, { title: 'Aplikacje klientów', subtitle: 'WordPress, Nextcloud, sklep i CMS jednym kliknięciem', body, wide: true });
}

export function registerResellerRoutes(router) {
  router.get('/reseller', (ctx) => resellerDashboard(ctx));
  router.get('/reseller/domains', (ctx) => resellerDomains(ctx));
  router.get('/reseller/apps', (ctx) => resellerApps(ctx));
  router.post('/reseller/apps/install', (ctx) => {
    const domainRow = get('SELECT * FROM domains WHERE name = ?', String(ctx.body.domain || ''));
    const user = domainRow ? get("SELECT * FROM users WHERE id = ? AND level = 'user' AND owner = ?", domainRow.user_id, ctx.user.username) : null;
    if (!user) return ctx.redirect('/reseller/apps?flash=Domena%20nie%20nale%C5%BCy%20do%20Twojego%20klienta&type=error');
    const domain = domainFor(user, domainRow.name);
    if (!domain) return ctx.redirect('/reseller/apps?flash=Domena%20nie%20nale%C5%BCy%20do%20klienta&type=error');
    const app = String(ctx.body.app);
    const args = { user, domain: domain.name, subpath: ctx.body.path || '/', adminUser: 'admin', adminPass: String(ctx.body.admin_password || ''), title: domain.name, adminEmail: user.email || '' };
    let r;
    if (app === 'wordpress') r = installWordPress(args);
    else if (app === 'nextcloud') r = installNextcloud(args);
    else r = installApp(app, args);
    if (!r.ok) return ctx.redirect('/reseller/apps?flash=' + encodeURIComponent(r.error) + '&type=error');
    audit(ctx.user.username, 'reseller', 'app.install', `${app}:${user.username}:${domain.name}`, ctx.ip);
    const name = app === 'wordpress' ? 'WordPress' : app === 'nextcloud' ? 'Nextcloud' : (listApps().find((a) => a.key === app)?.name || app);
    return resellerApps(ctx, { app, name, user: user.username, domain: domain.name, ...r });
  });

  router.get('/reseller/users', (ctx) => usersPage(ctx, { path: `${R}/users` }));
  router.get('/reseller/users/suspended', (ctx) => usersPage(ctx, { path: `${R}/users`, suspended: 1, title: 'Suspended Users' }));
  router.get('/reseller/users/create', (ctx) => userForm(ctx, { path: `${R}/users`, packages: all("SELECT * FROM packages WHERE type = 'user'") }));
  router.post('/reseller/users/create', (ctx) => createUser(ctx, { path: `${R}/users`, level: 'user', owner: ctx.user.username }));
  router.get('/reseller/users/move', (ctx) => {
    const users = visibleUsers(ctx.user, { level: 'user' });
    const body = h`${card('Move users', h`<p class="small muted mb-18">Moving a user transfers their account, domains and data to another reseller. As a reseller you can move users between your own packages.</p>
      ${table({
        columns: [
          { label: 'User', key: 'username' },
          { label: 'Package', render: (u) => badge(u.package, 'brand') },
          { label: 'Target package', render: (u) => h`<form method="post" action="${R}/users/${u.id}/move" class="inline" style="display:flex;gap:6px;align-items:center">
            <input type="hidden" name="_csrf" value="${ctx.csrf}">
            <select name="package" style="height:30px;width:160px">${all("SELECT * FROM packages WHERE type = 'user' AND (owner IS NULL OR owner = ?)", ctx.user.username).map((p) => h`<option>${p.name}</option>`)}</select>
            <button class="btn btn-secondary btn-sm" type="submit">Move</button></form>` },
        ],
        rows: users, empty: 'No users to move.',
      })}`)}`;
    return page(ctx, { title: 'Move Users', subtitle: 'Change package or ownership', body });
  });
  router.post('/reseller/users/:id/move', (ctx) => {
    const u = get('SELECT * FROM users WHERE id = ?', Number(ctx.params.id));
    if (!canManageUser(ctx.user, u)) return ctx.redirect(`${R}/users?flash=Access%20denied&type=error`);
    if (get('SELECT name FROM packages WHERE name = ?', ctx.body.package)) {
      run('UPDATE users SET package = ? WHERE id = ?', ctx.body.package, u.id);
    }
    return ctx.redirect(`${R}/users?flash=User%20moved`);
  });

  router.get('/reseller/users/:id', (ctx) => {
    const u = get('SELECT * FROM users WHERE id = ?', Number(ctx.params.id));
    if (!canManageUser(ctx.user, u)) return ctx.redirect(`${R}/users?flash=Access%20denied&type=error`);
    return userDetailPage(ctx, { path: `${R}/users`, target: u });
  });
  router.post('/reseller/users/:id', (ctx) => {
    const u = get('SELECT * FROM users WHERE id = ?', Number(ctx.params.id));
    if (!canManageUser(ctx.user, u)) return ctx.redirect(`${R}/users?flash=Access%20denied&type=error`);
    return updateUser(ctx, { path: `${R}/users`, target: u });
  });
  router.post('/reseller/users/:id/suspend', (ctx) => {
    const u = get('SELECT * FROM users WHERE id = ?', Number(ctx.params.id));
    if (!canManageUser(ctx.user, u)) return ctx.redirect(`${R}/users?flash=Access%20denied&type=error`);
    return toggleSuspend(ctx, { path: `${R}/users`, target: u });
  });
  router.post('/reseller/users/:id/delete', (ctx) => {
    const u = get('SELECT * FROM users WHERE id = ?', Number(ctx.params.id));
    if (!canManageUser(ctx.user, u)) return ctx.redirect(`${R}/users?flash=Access%20denied&type=error`);
    return deleteUser(ctx, { path: `${R}/users`, target: u });
  });
  router.post('/reseller/users/:id/login-as', (ctx) => {
    // Resellers cannot impersonate; this route is intentionally absent for them.
    return ctx.redirect(`${R}/users?flash=Impersonation%20requires%20administrator&type=error`);
  });

  router.get('/reseller/packages', (ctx) => packagesPage(ctx, { owner: ctx.user.username, type: 'user', path: `${R}/packages` }));
  router.get('/reseller/packages/create', (ctx) => packageForm(ctx, { path: `${R}/packages`, type: 'user' }));
  router.post('/reseller/packages/create', (ctx) => savePackage(ctx, { type: 'user', owner: ctx.user.username, path: `${R}/packages` }));
  router.get('/reseller/packages/:name', (ctx) => {
    const p = get('SELECT * FROM packages WHERE name = ? AND type = ?', ctx.params.name, 'user');
    if (!p) return ctx.redirect(`${R}/packages?flash=Package%20not%20found&type=error`);
    return packageForm(ctx, { path: `${R}/packages`, type: 'user', existing: p });
  });
  router.post('/reseller/packages/:name', (ctx) => savePackage(ctx, { type: 'user', owner: ctx.user.username, path: `${R}/packages` }));
  router.post('/reseller/packages/:name/copy', (ctx) => {
    const p = get('SELECT * FROM packages WHERE name = ?', ctx.params.name);
    if (!p) return ctx.redirect(`${R}/packages?flash=Not%20found&type=error`);
    const name = `${p.name}_copy${Math.floor(Math.random() * 90 + 10)}`;
    run('INSERT INTO packages(name, owner, type, limits, created_at) VALUES(?,?,?,?,?)', name, ctx.user.username, p.type, p.limits, nowIso());
    return ctx.redirect(`${R}/packages?flash=Package%20copied`);
  });
  router.post('/reseller/packages/:name/delete', (ctx) => {
    const inUse = get('SELECT COUNT(*) n FROM users WHERE package = ?', ctx.params.name).n;
    if (!inUse) run('DELETE FROM packages WHERE name = ? AND owner = ?', ctx.params.name, ctx.user.username);
    return ctx.redirect(`${R}/packages?flash=` + encodeURIComponent(inUse ? 'Package is in use' : 'Package deleted'));
  });

  router.get('/reseller/statistics', (ctx) => resellerStatistics(ctx));
  router.get('/reseller/dns', (ctx) => resellerDns(ctx));
  router.post('/reseller/dns/add', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect(`${R}/dns?flash=Domain%20not%20found&type=error`);
    run('INSERT INTO dns_records(domain_id, name, type, value, priority, ttl) VALUES(?,?,?,?,?,?)',
      d.id, String(ctx.body.name || '@') || '@', String(ctx.body.type || 'A').toUpperCase(), String(ctx.body.value || ''),
      ctx.body.priority ? Number(ctx.body.priority) : null, Number(ctx.body.ttl) || 3600);
    rebuildZone(d.name); apply({ dns: true });
    audit(ctx.user.username, 'reseller', 'dns.create', d.name, ctx.ip);
    return ctx.redirect(`${R}/dns?domain=${encodeURIComponent(d.name)}&flash=Record%20added`);
  });
  router.post('/reseller/dns/:id/update', (ctx) => {
    const r = get('SELECT * FROM dns_records WHERE id = ?', Number(ctx.params.id));
    const d = r ? domainFor(ctx.user, r.domain_id) : null;
    if (!d) return ctx.redirect(`${R}/dns?flash=Record%20not%20found&type=error`);
    run('UPDATE dns_records SET name=?, type=?, value=?, priority=?, ttl=? WHERE id=?',
      String(ctx.body.name || '@'), String(ctx.body.type || r.type).toUpperCase(), String(ctx.body.value || ''),
      ctx.body.priority ? Number(ctx.body.priority) : null, Number(ctx.body.ttl) || r.ttl, r.id);
    rebuildZone(d.name); apply({ dns: true });
    audit(ctx.user.username, 'reseller', 'dns.update', `${d.name} #${r.id}`, ctx.ip);
    return ctx.redirect(`${R}/dns?domain=${encodeURIComponent(d.name)}&flash=Record%20updated`);
  });
  router.post('/reseller/dns/:id/delete', (ctx) => {
    const r = get('SELECT * FROM dns_records WHERE id = ?', Number(ctx.params.id));
    const d = r ? domainFor(ctx.user, r.domain_id) : null;
    if (d) { run('DELETE FROM dns_records WHERE id = ?', r.id); rebuildZone(d.name); apply({ dns: true }); }
    audit(ctx.user.username, 'reseller', 'dns.delete', d?.name || String(ctx.params.id), ctx.ip);
    return ctx.redirect(`${R}/dns?domain=${encodeURIComponent(d?.name || '')}&flash=Record%20deleted`);
  });

  router.get('/reseller/ip-manager', (ctx) => resellerIps(ctx));
  router.post('/reseller/ip-manager/:id/release', (ctx) => {
    run("UPDATE ips SET owner = NULL, status = 'shared' WHERE id = ? AND owner = ?", Number(ctx.params.id), ctx.user.username);
    return ctx.redirect(`${R}/ip-manager?flash=IP%20released`);
  });

  router.get('/reseller/nameservers', (ctx) => {
    const body = h`${card('Nameservers', h`
      <p class="small muted mb-18">These are the nameservers advertised to your customers. They must be registered as glue records at your domain registrar.</p>
      ${kvList([['Primary', setting('ns1', 'ns1.localhost')], ['Secondary', setting('ns2', 'ns2.localhost')], ['Server IP', setting('server_ip', '127.0.0.1')]])}
      <p class="small muted mt-18">Customers should create NS records pointing their domains at these hostnames.</p>`)}
      ${card('DNS templates', h`${kvList([['Default zone template', '/usr/local/directadmin/data/templates/dns_default.conf'], ['TTL', '3600'], ['Email', 'postmaster@domain']])}`)}`;
    return page(ctx, { title: 'Nameservers', subtitle: 'Your DNS infrastructure', body });
  });

  router.get('/reseller/backups', (ctx) => {
    const rows = all(`SELECT b.*, u.username FROM backups b JOIN users u ON u.id = b.user_id WHERE u.owner = ? ORDER BY b.created_at DESC`, ctx.user.username);
    const body = h`${listCard({
      title: 'User backups', sub: `${rows.length} archive(s)`,
      columns: [
        { label: 'User', render: (b) => b.username },
        { label: 'File', render: (b) => h`<span class="cell-mono">${b.filename}</span>` },
        { label: 'Size', render: (b) => formatBytes(b.size_mb), align: 'right' },
        { label: 'Created', render: (b) => formatDate(b.created_at, { time: true }) },
      ],
      rows, empty: 'No backups from your users yet.',
    })}`;
    return page(ctx, { title: 'Backups', subtitle: 'Backups created by your users', body });
  });

  router.get('/reseller/tickets', (ctx) => resellerTickets(ctx));
  router.get('/reseller/tickets/:id', (ctx) => ticketView(ctx, ctx.params.id, `${R}/tickets`));
  router.post('/reseller/tickets/:id/reply', (ctx) => {
    const t = get('SELECT * FROM tickets WHERE id = ?', Number(ctx.params.id));
    if (t && String(ctx.body.message || '').trim()) {
      run('INSERT INTO ticket_messages(ticket_id, author, level, body, created_at) VALUES(?,?,?,?,?)', t.id, ctx.user.username, 'reseller', String(ctx.body.message), nowIso());
      run('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?', 'answered', nowIso(), t.id);
    }
    return ctx.redirect(`${R}/tickets/${ctx.params.id}?flash=Reply%20sent`);
  });
  router.post('/reseller/tickets/:id/close', (ctx) => {
    run("UPDATE tickets SET status = 'closed', updated_at = ? WHERE id = ?", nowIso(), Number(ctx.params.id));
    return ctx.redirect(`${R}/tickets/${ctx.params.id}?flash=Ticket%20closed`);
  });

  router.get('/reseller/messages', (ctx) => {
    const rows = all("SELECT * FROM messages WHERE level = 'reseller' AND (username = ? OR username IS NULL) ORDER BY created_at DESC", ctx.user.username);
    const body = h`${card('Messages', h`${rows.length ? h`<div class="timeline">${rows.map((m) => h`<div class="timeline-item"><div class="timeline-dot">${icon('bell', { size: 15 })}</div>
      <div class="timeline-body"><strong>${m.subject}</strong><p class="small muted">${m.body}</p><small>${timeAgo(m.created_at)}</small></div></div>`)}</div>` : emptyState('No messages.')}`)}`;
    return page(ctx, { title: 'Messages', subtitle: 'Notices from the server administrator', body });
  });

  router.get('/reseller/settings', (ctx) => {
    const body = h`${card('Reseller settings', h`<form method="post" action="/reseller/settings" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid">
        <div class="field"><label class="field-label">Email</label><input name="email" type="email" value="${ctx.user.email || ''}"></div>
        <div class="field"><label class="field-label">Language</label><select name="language"><option value="en">English</option><option value="pl">Polski</option><option value="de">Deutsch</option></select></div>
        <div class="field"><label class="field-label">Default user package</label><select name="default_package">${all("SELECT * FROM packages WHERE type = 'user'").map((p) => h`<option>${p.name}</option>`)}</select></div>
        <div class="field"><label class="field-label">Notify on new user</label><select name="notify"><option value="1">Yes</option><option value="0">No</option></select></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Save settings</button>
        <a class="btn btn-ghost" href="/user/password">Change password</a></div>
    </form>`)}
    ${card('Account', h`${kvList([['Username', ctx.user.username], ['Level', 'Reseller'], ['Package', ctx.user.package], ['Created', formatDate(ctx.user.created_at)]])}`)}`;
    return page(ctx, { title: 'Reseller Settings', subtitle: 'Your account preferences', body });
  });
  router.post('/reseller/settings', (ctx) => {
    run('UPDATE users SET email = ? WHERE id = ?', String(ctx.body.email || ctx.user.email), ctx.user.id);
    return ctx.redirect('/reseller/settings?flash=Settings%20saved');
  });

  void hashPassword; void createSession; void audit; void fd; void resellerForm;
}
