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
        <h2>Reseller dashboard</h2>
        <p>You manage <strong>${users.length}</strong> user account(s) and <strong>${domains.length}</strong> domain(s) on this server. Create packages, provision accounts and monitor usage.</p>
        <div class="row mt-18">${badge('Package: ' + (ctx.user.package || 'reseller'), 'brand')}${badge('Free license', 'ok')}${badge('Unlimited reseller', 'ok')}</div>
      </div>
      <div class="hero-actions">
        ${btn('Create user', { href: '/reseller/users/create', icon: 'plus' })}
        ${btn('New package', { href: '/reseller/packages/create', variant: 'secondary', icon: 'archive' })}
      </div>
    </div>
    <div class="stat-grid">
      ${statCard({ label: 'Users', value: `${users.length}${lim.users ? ' / ' + lim.users : ''}`, sub: 'hosted accounts', icon: 'users', href: '/reseller/users' })}
      ${statCard({ label: 'Domains', value: String(domains.length), sub: 'across your users', icon: 'globe', href: '/reseller/dns' })}
      ${statCard({ label: 'Disk used', value: formatBytes(disk), sub: lim.disk_mb ? 'of ' + formatBytes(lim.disk_mb) : 'unlimited', icon: 'database', tone: 'warn' })}
      ${statCard({ label: 'Bandwidth (30d)', value: formatBytes(bw), sub: 'reseller traffic', icon: 'chart', tone: 'ok', href: '/reseller/statistics' })}
    </div>
    <div class="grid grid-2-1">
      ${usageChartCard(series, { title: 'Reseller bandwidth', sub: 'Last 30 days across all users' })}
      ${card('Recent users', h`${users.length ? h`<div class="timeline">${users.slice(-5).reverse().map((u) => h`<div class="timeline-item">
        <div class="timeline-dot">${icon('user', { size: 15 })}</div>
        <div class="timeline-body"><div class="spread"><a class="link" href="/reseller/users/${u.id}"><strong>${u.username}</strong></a><span class="small muted">${timeAgo(u.created_at)}</span></div>
          <small>${u.domain || 'no domain'} · ${u.package}</small></div></div>`)}</div>` : emptyState('No users yet', { action: btn('Create the first user', { href: '/reseller/users/create', icon: 'plus' }) })}`, { actions: [h`<a class="link small" href="/reseller/users">All users</a>`] })}
    </div>
    <div class="grid grid-2">
      ${card('Open tickets', h`${tickets.length ? h`<div class="timeline">${tickets.map((t) => h`<div class="timeline-item"><div class="timeline-dot">${icon('ticket', { size: 15 })}</div>
        <div class="timeline-body"><div class="spread"><a class="link" href="/reseller/tickets/${t.id}">${t.subject}</a><span class="small muted">${timeAgo(t.created_at)}</span></div><small>${t.username} · ${t.priority}</small></div></div>`)}</div>` : emptyState('No open tickets')}`, { actions: [h`<a class="link small" href="/reseller/tickets">All tickets</a>`] })}
      ${card('Your limits', h`<div class="stack" style="gap:14px">
        <div><div class="spread small"><span>Users</span><span>${users.length} / ${lim.users || '∞'}</span></div>${progress(users.length, lim.users || 1, { showText: false })}</div>
        <div><div class="spread small"><span>Domains</span><span>${domains.length} / ${lim.domains || '∞'}</span></div>${progress(domains.length, lim.domains || 1, { showText: false })}</div>
        <div><div class="spread small"><span>Disk</span><span>${formatBytes(disk)} / ${lim.disk_mb ? formatBytes(lim.disk_mb) : '∞'}</span></div>${progress(disk, lim.disk_mb || 1, { showText: false })}</div>
        <div><div class="spread small"><span>IP addresses</span><span>${get("SELECT COUNT(*) n FROM ips WHERE owner = ?", ctx.user.username).n} / ${lim.ips || '∞'}</span></div></div>
      </div>`, { actions: [h`<a class="link small" href="/reseller/settings">Settings</a>`] })}
    </div>`;
  return page(ctx, { title: 'Reseller Dashboard', subtitle: 'Your accounts, packages and usage', body, counts: countForNav(ctx.user, 'reseller') });
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

export function registerResellerRoutes(router) {
  router.get('/reseller', (ctx) => resellerDashboard(ctx));

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
