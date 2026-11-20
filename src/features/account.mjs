// Statistics, messages, support tickets and system information.
import { all, get, run, nowIso, setting, audit } from '../db.mjs';
import { limitsFor } from '../auth.mjs';
import { html as h, formatBytes, formatDate, timeAgo } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, btn, badge, alert, emptyState, kvList, progress } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { usageChartCard } from '../ui/pages/widgets.mjs';
import { listCard } from '../ui/pages/list.mjs';
import { usageSeries, visibleDomains, storageFor } from '../core/access.mjs';
import { LANGUAGES, UI_MODES } from '../i18n.mjs';

export function register(router) {
  router.get('/user/interface', (ctx) => {
    const u = get('SELECT * FROM users WHERE id = ?', ctx.user.id);
    const body = h`${card('Język i widok panelu', h`<form method="post" action="/user/interface" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid">
        <div class="field"><label class="field-label">Język</label><select name="language">
          ${LANGUAGES.map((l) => h`<option value="${l.id}" ${u.language === l.id ? 'selected' : ''}>${l.label}</option>`)}
        </select></div>
        <div class="field"><label class="field-label">Widok</label><select name="ui_mode">
          ${UI_MODES.map((m) => h`<option value="${m.id}" ${u.ui_mode === m.id ? 'selected' : ''}>${m.label}</option>`)}
        </select></div>
      </div>
      <p class="small muted">Widok prosty pokazuje całe hostingowe centrum: strony, domeny i DNS, pocztę, pliki, FTP, bazy, cron, SSL, aplikacje, kopie i konto. Widok zaawansowany dodaje ustawienia techniczne (htaccess, handlery, MIME, terminal, Git, Redis itd.).</p>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Zapisz</button></div>
    </form>`)}`;
    return page(ctx, { title: 'Język i widok', subtitle: 'Dostosuj panel do siebie', body });
  });

  router.post('/user/interface', (ctx) => {
    const lang = ctx.body.language === 'en' ? 'en' : 'pl';
    const mode = ctx.body.ui_mode === 'advanced' ? 'advanced' : 'simple';
    run('UPDATE users SET language = ?, ui_mode = ? WHERE id = ?', lang, mode, ctx.user.id);
    audit(ctx.user.username, ctx.user.level, 'interface.update', `${lang}/${mode}`, ctx.ip);
    return ctx.redirect('/user/interface?flash=' + encodeURIComponent('Zapisano ustawienia interfejsu'));
  });

  /* ----------------------------------------------------------- statistics */
  router.get('/user/statistics/export', (ctx) => {
    const series = usageSeries(ctx.user.username, 90);
    const rows = series.map((r) => ({ day: r.day, bandwidth_mb: r.bandwidth_mb, disk_mb: r.disk_mb, emails: r.emails, requests: r.requests }));
    if (String(ctx.query.format || 'json') === 'csv') {
      const header = 'day,bandwidth_mb,disk_mb,emails,requests';
      const csv = [header, ...rows.map((r) => [r.day, r.bandwidth_mb, r.disk_mb, r.emails, r.requests].join(','))].join('\n') + '\n';
      ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="openadmin-${ctx.user.username}-usage.csv"`, 'Content-Length': Buffer.byteLength(csv), 'Cache-Control': 'no-store' });
      ctx.res.end(csv);
      return { handled: true };
    }
    return { json: { ok: true, username: ctx.user.username, generated_at: nowIso(), source: 'panel usage_daily', rows } };
  });

  router.get('/user/statistics', (ctx) => {
    const series = usageSeries(ctx.user.username, 30);
    const domains = visibleDomains(ctx.user);
    const lim = limitsFor(ctx.user);
    const storage = storageFor(ctx.user, 'user');
    const bw = series.reduce((a, r) => a + (r.bandwidth_mb || 0), 0);
    const emails = series.reduce((a, r) => a + (r.emails || 0), 0);
    const mailUsed = Number(get(`SELECT COALESCE(SUM(e.used_mb),0) n FROM email_accounts e JOIN domains d ON d.id = e.domain_id WHERE d.user_id = ?`, ctx.user.id).n) || 0;
    const dbUsed = Number(get('SELECT COALESCE(SUM(size_mb),0) n FROM databases WHERE user_id = ?', ctx.user.id).n) || 0;
    const backupUsed = Number(get('SELECT COALESCE(SUM(size_mb),0) n FROM backups WHERE user_id = ?', ctx.user.id).n) || 0;
    const fileUsed = Math.max(0, Number(storage.used) - mailUsed - dbUsed - backupUsed);
    const measuredAt = nowIso();
    const forecast = series.slice(-7).reduce((a, r) => a + (r.bandwidth_mb || 0), 0) / Math.max(1, Math.min(7, series.length)) * 30;
    const diskPct = lim.disk_mb ? Math.round((storage.used / lim.disk_mb) * 100) : 0;
    const bwPct = lim.bandwidth_mb ? Math.round((bw / lim.bandwidth_mb) * 100) : 0;
    const body = h`
      ${diskPct >= 80 ? alert(`Dysk zajęty w ${diskPct}% limitu. ${diskPct >= 100 ? 'Nowe pliki mogą zostać odrzucone.' : diskPct >= 90 ? 'Stan krytyczny — natychmiast zaplanuj czyszczenie lub zwiększ pakiet.' : 'Zaplanuj czyszczenie lub zwiększ pakiet.'}`, diskPct >= 90 ? 'danger' : 'warn') : ''}
      ${bwPct >= 80 ? alert(`Transfer zajęty w ${bwPct}% limitu.${bwPct >= 90 ? ' Stan krytyczny.' : ''}`, bwPct >= 90 ? 'danger' : 'warn') : ''}
      ${!series.length ? alert('Brak danych pomiarowych. Admin może uruchomić zbieranie w Administracja → Statystyki.', 'info') : ''}
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-icon">${icon('chart', { size: 20 })}</div><div class="stat-body"><span class="stat-label">Transfer (30 dni)</span><strong class="stat-value">${formatBytes(bw)}</strong><span class="stat-sub">${lim.bandwidth_mb ? 'z ' + formatBytes(lim.bandwidth_mb) : 'unlimited'}</span></div></div>
        <div class="stat-card"><div class="stat-icon tone-ok">${icon('database', { size: 20 })}</div><div class="stat-body"><span class="stat-label">Zajęty dysk</span><strong class="stat-value">${formatBytes(storage.used)}</strong><span class="stat-sub">${storage.files} inodes</span></div></div>
        <div class="stat-card"><div class="stat-icon tone-warn">${icon('mail', { size: 20 })}</div><div class="stat-body"><span class="stat-label">Poczta wysłana/odebrana</span><strong class="stat-value">${emails.toLocaleString()}</strong><span class="stat-sub">ostatnie 30 dni</span></div></div>
        <div class="stat-card"><div class="stat-icon">${icon('globe', { size: 20 })}</div><div class="stat-body"><span class="stat-label">Żądania HTTP</span><strong class="stat-value">${series.reduce((a, r) => a + (r.requests || 0), 0).toLocaleString()}</strong><span class="stat-sub">across ${domains.length} domain(s)</span></div></div>
      </div>
      ${usageChartCard(series, { title: 'Transfer', sub: 'Dzienny transfer, ostatnie 30 dni' })}
      <div class="grid grid-2">
        ${card('Zużycie według domeny', h`${table({
          cls: 'responsive-table',
          columns: [
            { label: 'Domena', dataLabel: 'Domena', render: (d) => h`<span class="cell-strong">${d.name}</span>` },
            { label: 'Transfer', dataLabel: 'Transfer', render: (d) => formatBytes(d.bandwidth_mb), align: 'right' },
            { label: 'Dysk', dataLabel: 'Dysk', render: (d) => formatBytes(d.disk_mb), align: 'right' },
            { label: 'Udział', dataLabel: 'Udział', render: (d) => h`<div class="u-s97">${progress(d.bandwidth_mb, Math.max(...domains.map((x) => x.bandwidth_mb), 1), { showText: false })}</div>` },
          ],
          rows: domains, empty: 'Brak domen.',
        })}`)}
        ${card('Dziennik dzienny', h`<details class="stats-details"><summary>Pokaż dziennik (12 dni)</summary>${table({
          cls: 'responsive-table',
          columns: [
            { label: 'Dzień', dataLabel: 'Dzień', key: 'day' },
            { label: 'Transfer', dataLabel: 'Transfer', render: (r) => formatBytes(r.bandwidth_mb), align: 'right' },
            { label: 'Żądania', dataLabel: 'Żądania', render: (r) => Number(r.requests || 0).toLocaleString(), align: 'right' },
          ],
          rows: series.slice(-12).reverse(),
        })}</details>`, { sub: 'Ostatnie 12 dni' })}
      </div>
      ${card('Zużycie dysku według typu', h`${table({
        cls: 'responsive-table',
        columns: [
          { label: 'Typ', dataLabel: 'Typ', key: 'type' },
          { label: 'Rozmiar', dataLabel: 'Rozmiar', render: (r) => formatBytes(r.size), align: 'right' },
          { label: 'Udział', dataLabel: 'Udział', render: (r) => h`<div class="u-s36">${progress(r.size, Math.max(storage.used, 1), { showText: false })}</div>` },
        ],
        rows: [
          { type: 'Pliki i strony', size: fileUsed },
          { type: 'Poczta', size: mailUsed },
          { type: 'Bazy danych', size: dbUsed },
          { type: 'Kopie zapasowe', size: backupUsed },
        ],
      })}<p class="small muted mt-12">Pomiar: ${formatDate(measuredAt, { time: true })} · źródło: metadane panelu + ${storage.files} inode. Prognoza transferu na 30 dni: <strong>${formatBytes(forecast)}</strong>.</p>
      <div class="row mt-12"><a class="btn btn-secondary btn-sm" href="/user/statistics/export?format=csv">Eksport CSV</a><a class="btn btn-secondary btn-sm" href="/user/statistics/export?format=json">Eksport JSON</a></div>`)}
      ${card('Limity pakietu', h`${kvList([
        ['Pakiet', ctx.user.package || 'default'],
        ['Domeny', `${domains.length} / ${lim.domains || '∞'}`],
        ['Skrzynki e-mail', `${get('SELECT COUNT(*) n FROM email_accounts WHERE domain IN (SELECT name FROM domains WHERE user_id = ?)', ctx.user.id).n} / ${lim.emails || '∞'}`],
        ['Bazy danych', `${get('SELECT COUNT(*) n FROM databases WHERE user_id = ?', ctx.user.id).n} / ${lim.databases || '∞'}`],
        ['Dysk', `${formatBytes(storage.used)} / ${lim.disk_mb ? formatBytes(lim.disk_mb) : 'bez limitu'}`],
        ['Transfer', `${formatBytes(bw)} / ${lim.bandwidth_mb ? formatBytes(lim.bandwidth_mb) : 'bez limitu'}`],
      ])}`)}`;
    return page(ctx, { title: 'Statystyki', subtitle: 'Transfer, dysk i wykorzystanie zasobów', body });
  });

  /* ------------------------------------------------------------- messages */
  router.get('/user/messages', (ctx) => {
    const rows = all("SELECT * FROM messages WHERE username = ? OR username IS NULL ORDER BY created_at DESC", ctx.user.username);
    const body = h`${card('Messages', h`${rows.length ? h`<div class="timeline">${rows.map((m) => h`<div class="timeline-item">
      <div class="timeline-dot">${icon(m.read_at ? 'mail' : 'bell', { size: 15 })}</div>
      <div class="timeline-body">
        <div class="spread"><strong>${m.subject}</strong><span class="small muted">${timeAgo(m.created_at)}</span></div>
        <p class="small muted u-s98">${m.body}</p>
        ${!m.read_at ? h`<form class="u-s24" method="post" action="/user/messages/${m.id}/read"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <button class="btn btn-ghost btn-sm" type="submit">Mark as read</button></form>` : badge('Read', 'muted')}
      </div></div>`)}</div>` : emptyState('No messages.')}`, { sub: `${rows.filter((r) => !r.read_at).length} unread` })}`;
    return page(ctx, { title: 'Messages', subtitle: 'Notices from your hosting provider', body });
  });

  router.post('/user/messages/:id/read', (ctx) => {
    run('UPDATE messages SET read_at = ? WHERE id = ? AND (username = ? OR username IS NULL)', nowIso(), Number(ctx.params.id), ctx.user.username);
    return ctx.redirect('/user/messages?flash=Marked%20as%20read');
  });

  /* -------------------------------------------------------------- tickets */
  router.get('/user/tickets', (ctx) => {
    const rows = all('SELECT * FROM tickets WHERE user_id = ? ORDER BY created_at DESC', ctx.user.id);
    const body = h`
      ${listCard({
        title: 'Support tickets', sub: `${rows.filter((r) => r.status !== 'closed').length} open`,
        columns: [
          { label: 'Subject', render: (t) => h`<a class="cell-strong" href="/user/tickets/${t.id}">${t.subject}</a><span class="cell-sub">#${t.id} · ${t.department}</span>` },
          { label: 'Priority', render: (t) => badge(t.priority, t.priority === 'high' ? 'danger' : t.priority === 'low' ? 'muted' : 'brand') },
          { label: 'Status', render: (t) => badge(t.status, t.status === 'open' ? 'brand' : t.status === 'closed' ? 'muted' : 'ok') },
          { label: 'Updated', render: (t) => timeAgo(t.updated_at) },
        ],
        rows, empty: 'No tickets yet.',
        createHref: '/user/tickets/create', createLabel: 'New ticket',
      })}`;
    return page(ctx, { title: 'Support Tickets', subtitle: 'Talk to your hosting provider', body });
  });

  router.get('/user/tickets/create', (ctx) => {
    const body = h`${card('Open a ticket', h`<form method="post" action="/user/tickets/create" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid">
        <div class="field field-full"><label class="field-label">Subject</label><input name="subject" required placeholder="Short summary"></div>
        <div class="field"><label class="field-label">Department</label><select name="department"><option>support</option><option>billing</option><option>sales</option><option>abuse</option></select></div>
        <div class="field"><label class="field-label">Priority</label><select name="priority"><option value="low">Low</option><option value="normal" selected>Normal</option><option value="high">High</option></select></div>
        <div class="field field-full"><label class="field-label">Message</label><textarea name="message" rows="8" required placeholder="Describe the issue, including any error messages."></textarea></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('ticket', { size: 16 })} Submit ticket</button><a class="btn btn-ghost" href="/user/tickets">Cancel</a></div>
    </form>`)}`;
    return page(ctx, { title: 'New Ticket', subtitle: 'Describe your issue', body });
  });

  router.post('/user/tickets/create', (ctx) => {
    const subject = String(ctx.body.subject || '').trim();
    const message = String(ctx.body.message || '').trim();
    if (!subject || !message) return ctx.redirect('/user/tickets/create?flash=Subject%20and%20message%20are%20required&type=error');
    const ts = nowIso();
    const r = run(`INSERT INTO tickets(user_id, username, subject, department, priority, status, created_at, updated_at)
                   VALUES(?,?,?,?,?,?,?,?)`, ctx.user.id, ctx.user.username, subject, String(ctx.body.department || 'support'),
      String(ctx.body.priority || 'normal'), 'open', ts, ts);
    run('INSERT INTO ticket_messages(ticket_id, author, level, body, created_at) VALUES(?,?,?,?,?)',
      r.lastInsertRowid, ctx.user.username, ctx.user.level, message, ts);
    audit(ctx.user.username, ctx.user.level, 'ticket.create', String(r.lastInsertRowid), ctx.ip);
    return ctx.redirect('/user/tickets/' + r.lastInsertRowid + '?flash=Ticket%20created');
  });

  router.get('/user/tickets/:id', (ctx) => {
    const t = get('SELECT * FROM tickets WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    if (!t) return ctx.redirect('/user/tickets?flash=Ticket%20not%20found&type=error');
    const msgs = all('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at', t.id);
    const body = h`
      ${card(`${t.subject}`, h`
        <div class="spread mb-18"><div class="row">${badge('#' + t.id, 'muted')}${badge(t.department, 'brand')}${badge(t.priority, t.priority === 'high' ? 'danger' : 'brand')}${badge(t.status, t.status === 'open' ? 'brand' : 'ok')}</div>
          <span class="small muted">Opened ${formatDate(t.created_at, { time: true })}</span></div>
        <div class="ticket-thread">${msgs.map((m) => h`<div class="ticket-msg ${m.level === 'user' ? 'user' : 'staff'}">
          <div class="ticket-head"><strong>${m.author}</strong><span class="small muted">${formatDate(m.created_at, { time: true })}</span></div>
          <div class="ticket-body">${m.body}</div>
        </div>`)}</div>
        ${t.status !== 'closed' ? h`<form method="post" action="/user/tickets/${t.id}/reply" class="oa-form mt-18">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <div class="field field-full"><label class="field-label">Reply</label><textarea name="message" rows="5" required></textarea></div>
          <div class="form-actions"><button class="btn btn-primary" type="submit">Send reply</button>
            <button class="btn btn-ghost" type="submit" formaction="/user/tickets/${t.id}/close">Close ticket</button></div>
        </form>` : alert('This ticket is closed.', 'info')}
      `)}`;
    return page(ctx, { title: 'Ticket #' + t.id, subtitle: t.subject, body });
  });

  router.post('/user/tickets/:id/reply', (ctx) => {
    const t = get('SELECT * FROM tickets WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    if (!t) return ctx.redirect('/user/tickets?flash=Not%20found&type=error');
    const body = String(ctx.body.message || '').trim();
    if (body) {
      run('INSERT INTO ticket_messages(ticket_id, author, level, body, created_at) VALUES(?,?,?,?,?)', t.id, ctx.user.username, ctx.user.level, body, nowIso());
      run('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?', 'open', nowIso(), t.id);
    }
    return ctx.redirect('/user/tickets/' + t.id + '?flash=Reply%20sent');
  });

  router.post('/user/tickets/:id/close', (ctx) => {
    run("UPDATE tickets SET status = 'closed', updated_at = ? WHERE id = ? AND user_id = ?", nowIso(), Number(ctx.params.id), ctx.user.id);
    return ctx.redirect('/user/tickets/' + ctx.params.id + '?flash=Ticket%20closed');
  });

  /* --------------------------------------------------------- system info */
  router.get('/user/system-info', (ctx) => {
    const lim = limitsFor(ctx.user);
    const storage = storageFor(ctx.user, 'user');
    const body = h`
      ${card('Server information', h`${kvList([
        ['Hostname', setting('server_name', 'localhost')],
        ['Server IP', setting('server_ip', '127.0.0.1')],
        ['Operating system', 'Debian 12 (bookworm)'],
        ['Kernel', '6.1.0-amd64'],
        ['Panel version', 'OpenAdmin ' + setting('panel_version', '1.1.0')],
        ['Panel port', '2222'],
        ['Nameservers', `${setting('ns1', 'ns1')} · ${setting('ns2', 'ns2')}`],
        ['Timezone', 'Europe/Warsaw'],
      ])}`)}
      <div class="grid grid-2">
        ${card('Your resources', h`${kvList([
          ['Pakiet', ctx.user.package || 'default'],
          ['Disk', `${formatBytes(storage.used)} of ${lim.disk_mb ? formatBytes(lim.disk_mb) : 'unlimited'}`],
          ['Domains', `${visibleDomains(ctx.user).length} of ${lim.domains || '∞'}`],
          ['PHP versions', (lim.php || []).join(', ')],
          ['SSH access', ctx.caps.ssh ? 'Enabled' : 'Disabled'],
        ])}`)}
        ${card('Software versions', h`${kvList([
          ['Apache', '2.4.62'],
          ['Nginx', '1.26.2 (reverse proxy)'],
          ['PHP', (lim.php || ['8.3']).join(' / ')],
          ['MariaDB', '11.4.3'],
          ['Exim', '4.98'],
          ['Dovecot', '2.3.21'],
          ['BIND', '9.18.28'],
          ['ProFTPD', '1.3.8'],
        ])}`)}
      </div>`;
    return page(ctx, { title: 'System Information', subtitle: 'Server and account details', body });
  });
  void btn;
}
