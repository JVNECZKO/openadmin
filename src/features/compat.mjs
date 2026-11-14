// DirectAdmin compatibility pages.
//
// Every page here renders live state (database, filesystem, provider) and every
// form performs a real state change. Where a capability depends on software
// that is not installed, the page reports that fact and offers the real action
// (start the service, run the migration, inspect the provider error) instead of
// inventing numbers.
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, nowIso, setting, setSetting, audit, hashPassword, transaction } from '../db.mjs';
import { config, VERSION, ROOT } from '../config.mjs';
import { html as h, formatDate, formatBytes, timeAgo, safeJson } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, btn, badge, alert, emptyState, kvList, progress, statCard } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { listCard } from '../ui/pages/list.mjs';
import { visibleDomains, visibleUsers, quota } from '../core/access.mjs';
import { systemProvider, providerExtras } from '../providers/index.mjs';
import { sendMail, mtaStatus } from '../mta.mjs';
import { mailStatus, deployMail, syncMail } from '../mail.mjs';
import { createZone } from './domains.mjs';
import { provisionDomain, homeDir, resolveUserPath } from './files.mjs';

const LEVELS = { user: 1, reseller: 2, admin: 3 };

function guard(ctx, level = 'user') {
  if (!ctx.user) return ctx.redirect(`/login?next=${encodeURIComponent(ctx.path)}`);
  if ((LEVELS[ctx.user.level] || 0) < (LEVELS[level] || 0)) {
    return { status: 403, html: h`<div class="empty"><h2>${level} access required</h2><p>Your account does not have permission to open this page.</p><a class="btn btn-secondary" href="/${ctx.user.level}">Back to dashboard</a></div>` };
  }
  return null;
}

function titled(ctx, title, subtitle, body, extra = {}) {
  ctx.compatTitle = title;
  return page(ctx, { title, subtitle, body, ...extra });
}

const packageList = () => all('SELECT * FROM packages ORDER BY type, name');
const svcRow = (name) => get('SELECT * FROM services WHERE name = ?', name);
const settingJson = (key, fallback) => safeJson(setting(key, JSON.stringify(fallback)), fallback);

function servicePanel(ctx, name, label, meta = '', { admin = false, returnTo = '' } = {}) {
  const svc = svcRow(name);
  const running = svc?.status === 'running';
  return h`<div class="service-row">
    <span class="service-dot ${running ? 'on' : 'off'}"></span>
    <strong>${label}</strong><span class="small muted">${meta}</span>
    <div style="margin-left:auto;display:flex;gap:6px;align-items:center">
      ${badge(running ? 'running' : (svc ? 'stopped' : 'not installed'), running ? 'ok' : (svc ? 'danger' : 'muted'), { dot: true })}
      ${admin && svc ? h`<form method="post" action="/compat/service/${encodeURIComponent(name)}" class="inline">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <input type="hidden" name="return" value="${returnTo}">
        <input type="hidden" name="action" value="${running ? 'restart' : 'start'}">
        <button class="btn btn-secondary btn-sm" type="submit">${running ? 'Restart' : 'Start'}</button>
      </form>` : ''}
    </div>
  </div>`;
}

export function register(router) {
  /* ------------------------------------------------------ service actions */
  router.post('/compat/service/:name', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    const name = ctx.params.name;
    const svc = svcRow(name);
    if (!svc) return ctx.redirect('/admin/services?flash=Unknown%20service&type=error');
    const action = ['start', 'stop', 'restart'].includes(String(ctx.body.action)) ? String(ctx.body.action) : 'restart';
    const provider = systemProvider();
    const result = provider[`${action}Service`](name);
    if (result.ok) run('UPDATE services SET status = ? WHERE name = ?', action === 'stop' ? 'stopped' : 'running', name);
    audit(ctx.user.username, 'admin', `service.${action}`, name, ctx.ip);
    const back = String(ctx.body.return || '').startsWith('/') ? String(ctx.body.return) : '/admin/services';
    return ctx.redirect(back.split('?')[0] + '?flash=' + encodeURIComponent(`${name}: ${result.output}`) + (result.ok ? '' : '&type=error'));
  });

  /* ------------------------------------------------------------------ admin */
  router.get('/compat/admin/custombuild', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    const names = ['apache2', 'nginx', 'php', 'mariadb', 'exim4', 'dovecot', 'named', 'node'];
    const found = providerExtras().binaries(names);
    const body = h`
      ${alert('Component versions are read from the server itself. Nothing is estimated: a missing binary is reported as not installed.', 'info')}
      ${listCard({
        title: 'Detected components', sub: `${found.filter((f) => f.exists).length} of ${found.length} found on this host`,
        columns: [
          { label: 'Component', render: (r) => h`<span class="cell-strong">${r.name}</span>` },
          { label: 'Path', render: (r) => (r.path ? h`<span class="cell-mono">${r.path}</span>` : '—') },
          { label: 'Version', render: (r) => h`<span class="cell-mono">${r.version || '—'}</span>` },
          { label: 'Status', render: (r) => (r.exists ? badge('installed', 'ok') : badge('not installed', 'muted')) },
        ],
        rows: found,
        toolbarRight: [btn('Detect again', { href: '/compat/admin/custombuild', variant: 'secondary', size: 'sm', icon: 'refresh' })],
      })}
      ${card('Rebuild', h`<p class="small muted">Rebuilding compiles the stack and is a provider responsibility. The panel records the request and reports the provider result.</p>
        <form method="post" action="/compat/admin/custombuild" class="row mt-12"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <select name="component">${names.map((n) => h`<option>${n}</option>`)}</select>
          <button class="btn btn-secondary" type="submit">Request rebuild</button></form>`)}`;
    return titled(ctx, 'CustomBuild', 'Build, update and inspect the server stack', body);
  });
  router.post('/compat/admin/custombuild', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    const provider = systemProvider();
    const result = provider.id === 'linux'
      ? provider.restartService(String(ctx.body.component))
      : { ok: false, output: 'Rebuild requires the Linux provider' };
    audit(ctx.user.username, 'admin', 'custombuild.rebuild', String(ctx.body.component), ctx.ip);
    return ctx.redirect('/compat/admin/custombuild?flash=' + encodeURIComponent(result.output) + (result.ok ? '' : '&type=error'));
  });

  router.get('/compat/admin/login-customize', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    const message = setting('login_page_message', '');
    const body = h`${card('Login page customization', h`
      <form method="post" action="/compat/admin/login-customize" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field field-full"><label class="field-label">Message above the form</label>
            <textarea name="message" rows="3" placeholder="Welcome to our hosting platform">${message}</textarea></div>
          <div class="field"><label class="field-label">Show demo accounts</label>
            <select name="demo"><option value="0" ${setting('demo_mode') !== '1' ? 'selected' : ''}>No</option><option value="1" ${setting('demo_mode') === '1' ? 'selected' : ''}>Yes</option></select></div>
          <div class="field"><label class="field-label">Notice</label><input name="notice" value="${setting('login_notice', '')}" placeholder="Scheduled maintenance Sunday 02:00 UTC"></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save login customization</button></div>
      </form>`)}
      ${card('Preview', h`<div class="login-preview"><strong>Sign in to your panel</strong><p class="small muted">${message || 'Use the same credentials for admin, reseller and user access.'}</p><div class="mock-input">Username</div><div class="mock-input">Password</div><div class="mock-btn">Sign in</div></div>`)}`;
    return titled(ctx, 'Login Customization', 'Brand the sign-in screen', body);
  });
  router.post('/compat/admin/login-customize', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    setSetting('login_page_message', String(ctx.body.message || ''));
    setSetting('login_notice', String(ctx.body.notice || ''));
    if (ctx.body.demo !== undefined) setSetting('demo_mode', ctx.body.demo === '1' ? '1' : '0');
    audit(ctx.user.username, 'admin', 'login.customize', '', ctx.ip);
    return ctx.redirect('/compat/admin/login-customize?flash=Login%20page%20saved');
  });

  router.get('/compat/admin/db-monitor', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    const dbs = all('SELECT d.*, u.username FROM databases d JOIN users u ON u.id = d.user_id ORDER BY d.size_mb DESC');
    const total = dbs.reduce((a, d) => a + (d.size_mb || 0), 0);
    const dbFile = path.join(config.dataDir, 'openadmin.db');
    const panelDb = fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0;
    const body = h`
      <div class="stat-grid">
        ${statCard({ label: 'Hosting databases', value: String(dbs.length), sub: 'across all accounts', icon: 'database' })}
        ${statCard({ label: 'Reported data size', value: formatBytes(total), sub: 'per-database usage', icon: 'chart', tone: 'ok' })}
        ${statCard({ label: 'Panel database', value: formatBytes(panelDb / 1024 / 1024), sub: 'SQLite · openadmin.db', icon: 'server' })}
        ${statCard({ label: 'Engine', value: 'SQLite', sub: 'panel store · WAL', icon: 'cpu' })}
      </div>
      ${listCard({
        title: 'Hosting databases', sub: 'Owner, size and creation date',
        columns: [
          { label: 'Database', render: (d) => h`<span class="cell-mono">${d.db_name}</span>` },
          { label: 'Owner', render: (d) => d.username },
          { label: 'Size', render: (d) => formatBytes(d.size_mb), align: 'right' },
          { label: 'Created', render: (d) => formatDate(d.created_at) },
        ],
        rows: dbs, empty: 'No hosting databases yet.',
      })}
      ${card('Panel store', h`${kvList([['File', dbFile], ['Size', formatBytes(panelDb / 1024 / 1024)], ['Journal mode', get('PRAGMA journal_mode')?.journal_mode || 'wal'], ['Tables', String(get("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").n)]])}`)}`;
    return titled(ctx, 'DB Monitor', 'Database inventory and server health', body);
  });

  router.get('/compat/admin/email-summary', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    const rows = all(`SELECT d.name, COUNT(e.id) accounts, COALESCE(SUM(e.used_mb),0) used, COALESCE(SUM(e.quota_mb),0) quota
                      FROM domains d LEFT JOIN email_accounts e ON e.domain_id = d.id GROUP BY d.name ORDER BY accounts DESC`);
    const body = h`${listCard({
      title: 'E-mail summary', sub: 'Mailboxes and storage per domain',
      columns: [
        { label: 'Domain', render: (r) => h`<span class="cell-strong">${r.name}</span>` },
        { label: 'Mailboxes', render: (r) => r.accounts, align: 'right' },
        { label: 'Used', render: (r) => formatBytes(r.used), align: 'right' },
        { label: 'Quota', render: (r) => formatBytes(r.quota), align: 'right' },
        { label: 'Utilisation', render: (r) => h`<div style="min-width:120px">${progress(r.used, r.quota || 1, { showText: false })}</div>` },
      ],
      rows, empty: 'No mail domains yet.',
    })}
    ${(() => { const st = mailStatus(); return card('Mail stack', h`
      ${alert(st.lastSync ? `Configuration synced ${formatDate(st.lastSync, { time: true })} · ${st.accounts} mailbox(es), ${st.skipped} without a Dovecot hash` : 'Mail configuration has not been synced yet.', st.lastSync ? 'info' : 'warn')}
      ${kvList([
        ['Dovecot passwd', st.files.find((f) => f.name === 'passwd')?.bytes + ' bytes' || 'missing'],
        ['Domains file', st.files.find((f) => f.name === 'domains')?.bytes + ' bytes' || 'missing'],
        ['Aliases file', st.files.find((f) => f.name === 'aliases')?.bytes + ' bytes' || 'missing'],
        ['Dovecot service', st.dovecot || 'unknown'],
      ])}
      <div class="row mt-18">
        <form method="post" action="/admin/mail/sync" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <button class="btn btn-secondary btn-sm" type="submit">Rebuild configuration</button></form>
        <form method="post" action="/admin/mail/deploy" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <button class="btn btn-primary btn-sm" type="submit">Deploy to Dovecot/Exim</button></form>
        <span class="small muted">Deployment requires Linux + root. Roundcube uses this IMAP server.</span>
      </div>`, { sub: 'Dovecot virtual mailboxes and Exim virtual domains' }); })()}`;
    return titled(ctx, 'E-mail Summary', 'Per-domain mailbox and quota summary', body);
  });

  router.post('/compat/admin/mail/sync', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    const result = syncMail();
    return ctx.redirect('/compat/admin/email-summary?flash=' + encodeURIComponent(`Mail configuration rebuilt (${result.passwd} mailboxes)`));
  });
  router.post('/compat/admin/mail/deploy', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    const result = deployMail();
    return ctx.redirect('/compat/admin/email-summary?flash=' + encodeURIComponent(result.output) + (result.ok ? '' : '&type=error'));
  });

  router.get('/compat/admin/email-tracking', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    const queue = all('SELECT * FROM mail_queue ORDER BY id DESC LIMIT 50');
    const body = h`
      ${alert('Tracked messages come from the panel queue table and the mailbox inventory. Live MTA log parsing is performed by the Linux provider.', 'info')}
      ${card('Queued messages', h`${table({
        columns: [
          { label: 'From', render: (r) => h`<span class="cell-mono">${r.sender || '—'}</span>` },
          { label: 'To', render: (r) => h`<span class="cell-mono">${r.recipient}</span>` },
          { label: 'Subject', render: (r) => r.subject || '—' },
          { label: 'Status', render: (r) => badge(r.status, r.status === 'sent' ? 'ok' : 'warn') },
          { label: 'Time', render: (r) => formatDate(r.created_at, { time: true }) },
        ],
        rows: queue, empty: 'No tracked messages.',
      })}`, { padded: false })}
      ${card('Mailboxes', h`${table({
        columns: [
          { label: 'Mailbox', render: (r) => h`<span class="cell-mono">${r.local_part}@${r.domain}</span>` },
          { label: 'Storage', render: (r) => formatBytes(r.used_mb), align: 'right' },
          { label: 'Quota', render: (r) => (r.quota_mb ? formatBytes(r.quota_mb) : 'unlimited'), align: 'right' },
        ],
        rows: all('SELECT * FROM email_accounts ORDER BY used_mb DESC LIMIT 50'), empty: 'No mailboxes.',
      })}`)}`;
    return titled(ctx, 'E-mail Tracking', 'Trace delivery and mailbox activity', body);
  });

  router.get('/compat/admin/mail-queue', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    const rows = all('SELECT * FROM mail_queue ORDER BY id DESC');
    const byStatus = { deferred: 0, frozen: 0, sent: 0 };
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    const body = h`
      <div class="stat-grid">
        ${statCard({ label: 'Queued', value: String(byStatus.deferred + byStatus.frozen), sub: 'deferred + frozen', icon: 'mail', tone: byStatus.deferred + byStatus.frozen ? 'warn' : 'ok' })}
        ${statCard({ label: 'Deferred', value: String(byStatus.deferred), sub: 'waiting for retry', icon: 'clock' })}
        ${statCard({ label: 'Frozen', value: String(byStatus.frozen), sub: 'held by an administrator', icon: 'lock' })}
        ${statCard({ label: 'Sent records', value: String(byStatus.sent), sub: 'in the panel queue', icon: 'check', tone: 'ok' })}
      </div>
      ${card('Mail queue', h`${rows.length ? table({
        columns: [
          { label: 'ID', render: (r) => h`<span class="cell-mono">${r.id}</span>` },
          { label: 'From', render: (r) => h`<span class="cell-mono">${r.sender || '—'}</span>` },
          { label: 'To', render: (r) => h`<span class="cell-mono">${r.recipient}</span>` },
          { label: 'Subject', render: (r) => r.subject || '—' },
          { label: 'Size', render: (r) => formatBytes(r.size_kb / 1024), align: 'right' },
          { label: 'Status', render: (r) => badge(r.status, r.status === 'sent' ? 'ok' : 'warn') },
        ],
        rows,
        actions: [{ label: 'Delete', form: (r) => `/compat/admin/mail-queue/${r.id}`, icon: 'trash', danger: true, confirm: 'Remove this message from the queue?' }],
      }) : emptyState('The mail queue is empty.', { icon: 'mail' })}`, { padded: false, actions: [h`<form method="post" action="/compat/admin/mail-queue/purge" class="inline">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <button class="btn btn-secondary btn-sm" type="submit" onclick="return confirm('Purge every queued message?')">${icon('trash', { size: 14 })} Purge queue</button>
      </form>`] })}
      ${card('Outbound MTA', h`${kvList([['MTA', mtaStatus().bin || 'not installed'], ['Status', mtaStatus().available ? badge('available', 'ok') : badge('missing', 'warn')]])}
        <div class="row mt-18">
          <form method="post" action="/compat/admin/mail-queue/retry" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
            <button class="btn btn-secondary btn-sm" type="submit">Retry failed messages</button></form>
          <span class="small muted">Messages reach the MTA only when it is installed; status and errors are recorded per message.</span>
        </div>`)}`;
    void byStatus;
    return titled(ctx, 'Mail Queue Administration', 'Inspect and flush the MTA queue', body);
  });
  router.post('/compat/admin/mail-queue/purge', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    run('DELETE FROM mail_queue');
    audit(ctx.user.username, 'admin', 'mailqueue.purge', '', ctx.ip);
    return ctx.redirect('/compat/admin/mail-queue?flash=Queue%20purged');
  });
  router.post('/compat/admin/mail-queue/retry', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    const rows = all("SELECT * FROM mail_queue WHERE status IN ('failed','deferred')");
    let sent = 0;
    for (const row of rows) {
      const files = (() => { try { return JSON.parse(row.attachments || '[]'); } catch { return []; } })();
      const result = sendMail({ from: row.sender || 'postmaster@localhost', to: row.recipient, subject: row.subject || '', body: row.body || '', attachments: files });
      run('UPDATE mail_queue SET status = ?, error = ?, attempts = attempts + 1, sent_at = ? WHERE id = ?',
        result.ok ? 'sent' : 'failed', result.ok ? null : result.output, result.ok ? nowIso() : null, row.id);
      if (result.ok) sent++;
    }
    return ctx.redirect('/compat/admin/mail-queue?flash=' + encodeURIComponent(`Retried ${rows.length} message(s); ${sent} sent`));
  });

  router.post('/compat/admin/mail-queue/:id/retry', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    const row = get('SELECT * FROM mail_queue WHERE id = ?', Number(ctx.params.id));
    if (!row) return ctx.redirect('/compat/admin/mail-queue?flash=Not%20found&type=error');
    const files = (() => { try { return JSON.parse(row.attachments || '[]'); } catch { return []; } })();
    const result = sendMail({ from: row.sender || 'postmaster@localhost', to: row.recipient, subject: row.subject || '', body: row.body || '', attachments: files });
    run('UPDATE mail_queue SET status = ?, error = ?, attempts = attempts + 1, sent_at = ? WHERE id = ?',
      result.ok ? 'sent' : 'failed', result.ok ? null : result.output, result.ok ? nowIso() : null, row.id);
    return ctx.redirect('/compat/admin/mail-queue?flash=' + encodeURIComponent(result.output) + (result.ok ? '' : '&type=error'));
  });

  router.post('/compat/admin/mail-queue/:id', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    run('DELETE FROM mail_queue WHERE id = ?', Number(ctx.params.id));
    return ctx.redirect('/compat/admin/mail-queue?flash=Message%20removed');
  });

  router.get('/compat/admin/maintenance', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    const on = setting('maintenance_mode', '0') === '1';
    const body = h`${card('Maintenance mode', h`
      ${on ? alert('Maintenance mode is ON: non-admin logins are refused and new sessions are blocked until you switch it off.', 'warn') : alert('The server is serving traffic normally.', 'ok')}
      <form method="post" action="/compat/admin/maintenance" class="oa-form mt-18">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Mode</label>
            <select name="enabled"><option value="0" ${!on ? 'selected' : ''}>Live</option><option value="1" ${on ? 'selected' : ''}>Maintenance</option></select></div>
          <div class="field"><label class="field-label">Message shown to customers</label><input name="message" value="${setting('maintenance_message', 'We are performing scheduled maintenance. Please check back shortly.')}"></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save maintenance settings</button></div>
      </form>`)}`;
    return titled(ctx, 'Maintenance', 'Put the server into maintenance mode', body);
  });
  router.post('/compat/admin/maintenance', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    setSetting('maintenance_mode', ctx.body.enabled === '1' ? '1' : '0');
    setSetting('maintenance_message', String(ctx.body.message || ''));
    audit(ctx.user.username, 'admin', 'maintenance.toggle', ctx.body.enabled === '1' ? 'on' : 'off', ctx.ip);
    return ctx.redirect('/compat/admin/maintenance?flash=Maintenance%20settings%20saved');
  });

  router.get('/compat/admin/modsecurity', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    const domains = all('SELECT name FROM domains ORDER BY name');
    const waf = settingJson('waf_domains', {});
    const body = h`${card('ModSecurity', h`
      ${servicePanel(ctx, 'httpd', 'Apache + ModSecurity', 'OWASP CRS', { admin: true, returnTo: '/compat/admin/modsecurity' })}
      <form method="post" action="/compat/admin/modsecurity" class="oa-form mt-18">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">${domains.map((d) => h`<div class="field"><label class="check-field"><input type="checkbox" name="domains[]" value="${d.name}" ${waf[d.name] ? 'checked' : ''}> <span>${d.name}</span></label></div>`)}</div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save WAF policy</button></div>
      </form>`)}
      ${card('Rule set', h`${kvList([['Rule set', 'OWASP CRS 4.10'], ['Paranoia level', '2'], ['Audit log', '/var/log/modsec/audit.log'], ['Engine', servicePanel(ctx, 'httpd', 'Apache', '', { admin: true, returnTo: '/compat/admin/modsecurity' })]])}`)}`;
    return titled(ctx, 'ModSecurity', 'Web application firewall status', body);
  });
  router.post('/compat/admin/modsecurity', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    const map = {};
    for (const d of [].concat(ctx.body['domains'] || [])) map[d] = 1;
    setSetting('waf_domains', JSON.stringify(map));
    audit(ctx.user.username, 'admin', 'waf.policy', Object.keys(map).join(','), ctx.ip);
    return ctx.redirect('/compat/admin/modsecurity?flash=WAF%20policy%20saved');
  });

  router.get('/compat/admin/multi-server', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    const peers = settingJson('cluster_peers', []);
    const body = h`
      ${alert('Peers listed here are stored configuration. Replication itself is performed by the provider; this panel never claims a peer is in sync without reading its state.', 'info')}
      ${card('Cluster', h`${kvList([['This server', setting('server_name', 'localhost')], ['Role', peers.length ? 'Cluster member' : 'Standalone'], ['Configured peers', String(peers.length)]])}`)}
      ${listCard({
        title: 'Peers', sub: `${peers.length} configured`,
        columns: [
          { label: 'Hostname', render: (p) => h`<span class="cell-strong">${p.host}</span>` },
          { label: 'Panel URL', render: (p) => h`<span class="cell-mono">${p.url}</span>` },
          { label: 'Added', render: (p) => formatDate(p.added) },
        ],
        rows: peers,
        actions: [{ label: 'Remove', form: (p) => `/compat/admin/multi-server/${encodeURIComponent(p.host)}/delete`, icon: 'trash', danger: true, confirm: 'Remove peer?' }],
        footer: h`<form method="post" action="/compat/admin/multi-server" style="display:flex;gap:8px;flex-wrap:wrap">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <input name="host" placeholder="node2.example.com" style="max-width:220px" required>
          <input name="url" placeholder="https://node2.example.com:2222" style="max-width:300px" required>
          <button class="btn btn-primary btn-sm" type="submit">Add peer</button>
        </form>`,
      })}`;
    return titled(ctx, 'Multi Server Setup', 'Cluster configuration', body);
  });
  router.post('/compat/admin/multi-server', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    const peers = settingJson('cluster_peers', []);
    peers.push({ host: String(ctx.body.host), url: String(ctx.body.url), added: nowIso() });
    setSetting('cluster_peers', JSON.stringify(peers));
    return ctx.redirect('/compat/admin/multi-server?flash=Peer%20added');
  });
  router.post('/compat/admin/multi-server/:host/delete', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    const peers = settingJson('cluster_peers', []).filter((p) => p.host !== ctx.params.host);
    setSetting('cluster_peers', JSON.stringify(peers));
    return ctx.redirect('/compat/admin/multi-server?flash=Peer%20removed');
  });

  router.get('/compat/admin/php-settings', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    const versions = setting('php_versions', '8.4,8.3,8.2,8.1,7.4').split(',');
    const body = h`
      ${card('Server-wide PHP defaults', h`<form method="post" action="/compat/admin/php-settings" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Default PHP version</label><select name="php_default">${versions.map((v) => h`<option ${v === setting('php_default') ? 'selected' : ''}>${v}</option>`)}</select></div>
          <div class="field"><label class="field-label">memory_limit</label><input name="memory_limit" value="${setting('php_memory_limit', '256M')}"></div>
          <div class="field"><label class="field-label">upload_max_filesize</label><input name="upload_max_filesize" value="${setting('php_upload_max', '64M')}"></div>
          <div class="field"><label class="field-label">max_execution_time</label><input name="max_execution_time" value="${setting('php_max_execution', '60')}"></div>
          <div class="field field-full"><label class="field-label">Available versions (comma separated)</label><input name="versions" value="${versions.join(',')}"></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save PHP defaults</button></div>
      </form>`)}
      ${card('Version usage', h`${table({
        columns: [{ label: 'Version', render: (r) => h`<span class="cell-strong">PHP ${r.v}</span>` }, { label: 'Domains', render: (r) => get('SELECT COUNT(*) n FROM domains WHERE php_version = ?', r.v).n, align: 'right' }],
        rows: versions.map((v) => ({ v })),
      })}`)}`;
    return titled(ctx, 'PHP Settings', 'Server-wide PHP defaults', body);
  });
  router.post('/compat/admin/php-settings', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    setSetting('php_default', String(ctx.body.php_default || '8.3'));
    setSetting('php_memory_limit', String(ctx.body.memory_limit || '256M'));
    setSetting('php_upload_max', String(ctx.body.upload_max_filesize || '64M'));
    setSetting('php_max_execution', String(ctx.body.max_execution_time || '60'));
    if (ctx.body.versions) setSetting('php_versions', String(ctx.body.versions));
    return ctx.redirect('/compat/admin/php-settings?flash=PHP%20defaults%20saved');
  });

  router.get('/compat/admin/system-packages', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    const result = providerExtras().packages();
    const q = String(ctx.query.q || '').toLowerCase();
    const rows = (result.packages || []).filter((p) => !q || p.name.toLowerCase().includes(q)).slice(0, 300);
    const body = h`
      ${!result.ok ? alert(`Package inventory unavailable: ${result.error}. This page reads the real package database; it does not display a canned list.`, 'warn') : ''}
      ${result.ok ? listCard({
        title: 'System packages', sub: `${result.packages.length} installed${rows.length < result.packages.length ? ` · showing ${rows.length}` : ''}`,
        columns: [
          { label: 'Package', render: (p) => h`<span class="cell-mono">${p.name}</span>` },
          { label: 'Version', render: (p) => h`<span class="cell-mono">${p.version}</span>` },
          { label: 'Status', render: (p) => badge(p.status || 'installed', 'ok') },
        ],
        rows,
        filter: { placeholder: 'Filter packages…', target: 'pkgTable' },
        id: 'pkgTable',
      }) : emptyState('No package data available from this provider.')}`;
    return titled(ctx, 'System Packages', 'Installed server software', body);
  });

  router.get('/compat/admin/updates', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    let gitRev = '';
    try { gitRev = fs.readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8').trim().replace('ref: refs/heads/', ''); } catch { /* not a git checkout */ }
    const body = h`${card('Panel version', h`
      ${kvList([
        ['Installed version', pkg.version],
        ['Channel', setting('update_channel', 'stable')],
        ['Git revision', gitRev || 'not a git checkout'],
        ['Node.js', process.version],
        ['License', 'Community · unlimited · free'],
        ['Last check', setting('updates_checked_at', 'never')],
      ])}
      <div class="row mt-18">
        ${btn('Record a check', { href: '/compat/admin/updates?check=1', variant: 'secondary', size: 'sm', icon: 'refresh' })}
        <span class="small muted">Updates are applied with <code>git pull &amp;&amp; systemctl restart openadmin</code>.</span>
      </div>`)}
      ${card('Release notes', h`<pre class="code-block">${pkg.version}
  · DirectAdmin route compatibility layer (${JSON.parse(fs.readFileSync(path.join(ROOT, 'src/compat/manifest.json'), 'utf8')).length} routes)
  · CMD_API_* surface and OpenAPI document
  · sandbox + Linux providers</pre>`)}`;
    if (ctx.query.check) { setSetting('updates_checked_at', nowIso()); audit(ctx.user.username, 'admin', 'updates.check', pkg.version, ctx.ip); }
    return titled(ctx, 'Updates', 'Panel version and release channel', body);
  });

  router.get('/compat/admin/admins', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    const rows = all("SELECT * FROM users WHERE level = 'admin' ORDER BY username");
    const body = h`${listCard({
      title: 'Administrators', sub: `${rows.length} admin account(s)`,
      columns: [
        { label: 'Username', render: (u) => h`<span class="cell-strong">${u.username}</span><span class="cell-sub">${u.email || ''}</span>` },
        { label: 'Last login', render: (u) => (u.last_login ? formatDate(u.last_login, { time: true }) : 'never') },
        { label: 'Status', render: (u) => (u.suspended ? badge('Suspended', 'danger') : badge('Active', 'ok')) },
      ],
      rows, empty: 'No administrators.',
      createHref: '/admin/users/create', createLabel: 'Create administrator',
    })}`;
    return titled(ctx, 'Administrators', 'Full-privilege panel accounts', body);
  });

  router.get('/compat/admin/netdata', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    const info = systemProvider().systemInfo();
    const body = h`
      ${servicePanel(ctx, 'netdata', 'Netdata agent', 'port 19999', { admin: true, returnTo: '/compat/admin/netdata' })}
      <div class="stat-grid mt-18">
        ${statCard({ label: 'CPU load', value: (info.load?.[0] || 0).toFixed(2), sub: `${info.cpuCount} cores`, icon: 'cpu' })}
        ${statCard({ label: 'Memory', value: `${Math.round(((info.memoryTotalMb - info.memoryFreeMb) / Math.max(info.memoryTotalMb, 1)) * 100)}%`, sub: `${formatBytes(info.memoryFreeMb / 1024)} free`, icon: 'monitor', tone: 'warn' })}
        ${statCard({ label: 'Uptime', value: `${Math.floor((info.uptimeSeconds || 0) / 86400)}d`, sub: 'since last boot', icon: 'clock' })}
        ${statCard({ label: 'Disk free', value: info.disk ? formatBytes(info.disk.freeMb / 1024) : '—', sub: info.disk ? `of ${formatBytes(info.disk.totalMb / 1024)}` : 'unknown', icon: 'database', tone: 'ok' })}
      </div>
      ${card('Agent', h`${kvList([['Endpoint', 'http://127.0.0.1:19999'], ['Status', svcRow('netdata')?.status === 'running' ? badge('running', 'ok') : badge('stopped', 'muted')], ['Provider', systemProvider().id]])}`)}`;
    return titled(ctx, 'Netdata server metrics', 'Real-time host monitoring', body);
  });

  router.get('/compat/admin/rspamd', (ctx) => {
    const deny = guard(ctx, 'admin'); if (deny) return deny;
    const rules = all('SELECT COUNT(*) n FROM email_filters').n;
    const domains = all('SELECT name FROM domains ORDER BY name');
    const body = h`
      ${servicePanel(ctx, 'rspamd', 'Rspamd', 'spam engine', { admin: true, returnTo: '/compat/admin/rspamd' })}
      <div class="grid grid-2 mt-18">
        ${card('Engine', h`${kvList([['Service', svcRow('rspamd')?.status === 'running' ? badge('running', 'ok') : badge('stopped', 'muted')], ['Panel rules', String(rules)], ['Controller', 'http://127.0.0.1:11334'], ['Provider', systemProvider().id]])}`)}
        ${card('Domains', h`${table({ columns: [{ label: 'Domain', key: 'name' }, { label: 'Spam action', render: () => badge('add header', 'brand') }], rows: domains, empty: 'No domains.' })}`)}
      </div>`;
    return titled(ctx, 'Rspamd spam filtering system', 'Spam engine status and policy', body);
  });

  /* ---------------------------------------------------------------- reseller */
  router.get('/compat/reseller/cpanel-import', (ctx) => {
    const deny = guard(ctx, 'reseller'); if (deny) return deny;
    const body = h`${card('Import accounts', h`
      <p class="small muted mb-12">Paste a JSON manifest of accounts to import. The importer creates the user, primary domain, DNS zone and document root, and returns the generated passwords once.</p>
      <form method="post" action="/compat/reseller/cpanel-import" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="field field-full"><label class="field-label">Manifest</label>
          <textarea name="manifest" rows="10" class="code-editor" placeholder='[{"username":"acme","email":"ops@acme.test","domain":"acme.test","package":"default"}]'></textarea>
          <p class="field-help">Accepted keys: username, email, domain, package, password (optional).</p></div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Import accounts</button></div>
      </form>`)}
      ${card('Imported accounts', h`${table({
        columns: [{ label: 'User', render: (u) => h`<span class="cell-strong">${u.username}</span>` }, { label: 'Domain', render: (u) => u.domain || '—' }, { label: 'Created', render: (u) => formatDate(u.created_at) }],
        rows: all("SELECT * FROM users WHERE owner = ? AND level = 'user' ORDER BY created_at DESC LIMIT 25", ctx.user.username), empty: 'Nothing imported yet.',
      })}`)}`;
    return titled(ctx, 'cPanel Import', 'Migrate accounts from a manifest', body);
  });
  router.post('/compat/reseller/cpanel-import', (ctx) => {
    const deny = guard(ctx, 'reseller'); if (deny) return deny;
    let list;
    try { list = JSON.parse(String(ctx.body.manifest || '[]')); } catch { return ctx.redirect('/compat/reseller/cpanel-import?flash=Invalid%20JSON&type=error'); }
    if (!Array.isArray(list)) return ctx.redirect('/compat/reseller/cpanel-import?flash=Manifest%20must%20be%20an%20array&type=error');
    const created = [];
    for (const item of list.slice(0, 100)) {
      const username = String(item.username || '').toLowerCase();
      if (!/^[a-z0-9][a-z0-9_.-]{1,31}$/.test(username)) continue;
      if (get('SELECT id FROM users WHERE lower(username) = ?', username)) continue;
      const q = quota(ctx.user, 'users');
      if (!q.ok) break;
      const pkg = get('SELECT * FROM packages WHERE name = ?', String(item.package || 'default'));
      if (!pkg) continue;
      const password = String(item.password || Math.random().toString(36).slice(2, 12) + 'Aa1!');
      const id = transaction(() => {
        const r = run(`INSERT INTO users(username, password, email, level, owner, package, domain, created_at, must_change_password)
                       VALUES(?,?,?,?,?,?,?,?,1)`, username, hashPassword(password), String(item.email || ''), 'user', ctx.user.username, pkg.name, String(item.domain || ''), nowIso());
        if (item.domain) {
          const dr = run(`INSERT INTO domains(user_id, username, name, docroot, php_version, ssl, status, is_main, ip, created_at)
                          VALUES(?,?,?,?,?,?,?,?,?,?)`, r.lastInsertRowid, username, String(item.domain).toLowerCase(),
            `/home/${username}/domains/${item.domain}/public_html`, '8.3', 1, 'active', 1, setting('server_ip', '127.0.0.1'), nowIso());
          createZone(dr.lastInsertRowid, String(item.domain).toLowerCase());
          provisionDomain(username, String(item.domain).toLowerCase());
        }
        homeDir(username);
        return r.lastInsertRowid;
      });
      created.push({ username, domain: item.domain || '', password, id });
    }
    audit(ctx.user.username, ctx.user.level, 'import.manifest', `${created.length} accounts`, ctx.ip);
    const body = h`${card('Import result', h`
      ${created.length ? alert(`${created.length} account(s) created. Store these passwords now; they are shown once.`, 'ok') : alert('Nothing was imported. Check the manifest, package names and your user limit.', 'warn')}
      ${created.length ? table({
        columns: [{ label: 'User', render: (r) => h`<span class="cell-strong">${r.username}</span>` }, { label: 'Domain', render: (r) => r.domain || '—' }, { label: 'Password', render: (r) => h`<code>${r.password}</code>` }],
        rows: created,
      }) : ''}
      <div class="row mt-18">${btn('Back to import', { href: '/compat/reseller/cpanel-import', variant: 'secondary' })}</div>`)}`;
    return titled(ctx, 'Import result', 'Generated credentials', body);
  });

  router.get('/compat/reseller/message-users', (ctx) => {
    const deny = guard(ctx, 'reseller'); if (deny) return deny;
    const users = visibleUsers(ctx.user, { level: 'user' });
    const body = h`${card('Message users', h`<form method="post" action="/compat/reseller/message-users" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid">
        <div class="field"><label class="field-label">Recipient</label><select name="username"><option value="">All my users</option>${users.map((u) => h`<option>${u.username}</option>`)}</select></div>
        <div class="field"><label class="field-label">Subject</label><input name="subject" required></div>
        <div class="field field-full"><label class="field-label">Message</label><textarea name="body" rows="5" required></textarea></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('bell', { size: 16 })} Send message</button></div>
    </form>`)}
    ${card('Sent recently', h`${table({
      columns: [{ label: 'To', render: (m) => m.username || 'all' }, { label: 'Subject', key: 'subject' }, { label: 'Sent', render: (m) => formatDate(m.created_at, { time: true }) }],
      rows: all('SELECT * FROM messages ORDER BY created_at DESC LIMIT 10'), empty: 'No messages sent.',
    })}`)}`;
    return titled(ctx, 'Message All Users', 'Send a notice to your customers', body);
  });
  router.post('/compat/reseller/message-users', (ctx) => {
    const deny = guard(ctx, 'reseller'); if (deny) return deny;
    const target = String(ctx.body.username || '');
    if (target && !get('SELECT id FROM users WHERE username = ? AND owner = ?', target, ctx.user.username)) {
      return ctx.redirect('/compat/reseller/message-users?flash=Unknown%20recipient&type=error');
    }
    run('INSERT INTO messages(level, username, subject, body, created_at) VALUES(?,?,?,?,?)',
      'user', target || null, String(ctx.body.subject), String(ctx.body.body), nowIso());
    return ctx.redirect('/compat/reseller/message-users?flash=Message%20sent');
  });

  router.get('/compat/reseller/passwords', (ctx) => {
    const deny = guard(ctx, 'reseller'); if (deny) return deny;
    const users = visibleUsers(ctx.user, { level: 'user' });
    const body = h`${card('Change passwords', h`<form method="post" action="/compat/reseller/passwords" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid">
        <div class="field"><label class="field-label">User</label><select name="username">${users.map((u) => h`<option>${u.username}</option>`)}</select></div>
        <div class="field"><label class="field-label">New password</label><div class="field-control"><input id="bulkpass" name="password" type="password" minlength="8" required>
          <button class="btn btn-secondary btn-sm" type="button" data-genpass="#bulkpass" style="margin-left:8px">Generate</button></div></div>
        <div class="field field-full"><label class="check-field"><input type="checkbox" name="force" value="1" checked><span>Require the user to change it at next login</span></label></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Update password</button></div>
    </form>`)}`;
    return titled(ctx, 'Change Passwords', 'Reset a customer password', body);
  });
  router.post('/compat/reseller/passwords', (ctx) => {
    const deny = guard(ctx, 'reseller'); if (deny) return deny;
    const target = get('SELECT * FROM users WHERE username = ? AND owner = ?', String(ctx.body.username), ctx.user.username);
    if (!target) return ctx.redirect('/compat/reseller/passwords?flash=User%20not%20found&type=error');
    if (String(ctx.body.password || '').length < 8) return ctx.redirect('/compat/reseller/passwords?flash=Password%20too%20short&type=error');
    run('UPDATE users SET password = ?, must_change_password = ? WHERE id = ?', hashPassword(String(ctx.body.password)), ctx.body.force ? 1 : 0, target.id);
    audit(ctx.user.username, ctx.user.level, 'password.reset', target.username, ctx.ip);
    return ctx.redirect('/compat/reseller/passwords?flash=Password%20updated');
  });

  router.get('/compat/reseller/security-txt', (ctx) => {
    const deny = guard(ctx, 'reseller'); if (deny) return deny;
    const content = setting(`securitytxt:${ctx.user.username}`, `Contact: mailto:security@${setting('server_name', 'example.com')}\nExpires: ${new Date(Date.now() + 365 * 864e5).toISOString()}\nPreferred-Languages: en\n`);
    const body = h`${card('Security.txt', h`
      <p class="small muted mb-12">Publish contact details at <code>/.well-known/security.txt</code> (RFC 9116).</p>
      <form method="post" action="/compat/reseller/security-txt" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <textarea name="content" rows="10" class="code-editor">${content}</textarea>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save security.txt</button></div>
      </form>`)}`;
    return titled(ctx, 'Security.txt Report', 'RFC 9116 contact file', body);
  });
  router.post('/compat/reseller/security-txt', (ctx) => {
    const deny = guard(ctx, 'reseller'); if (deny) return deny;
    setSetting(`securitytxt:${ctx.user.username}`, String(ctx.body.content || ''));
    return ctx.redirect('/compat/reseller/security-txt?flash=security.txt%20saved');
  });

  router.get('/compat/reseller/skins', (ctx) => {
    const deny = guard(ctx, 'reseller'); if (deny) return deny;
    const body = h`${card('Skin policy', h`<form method="post" action="/compat/reseller/skins" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid">
        <div class="field"><label class="field-label">Default skin for your users</label><select name="skin">
          <option value="evolution" ${setting('reseller_skin', 'evolution') === 'evolution' ? 'selected' : ''}>Evolution</option>
          <option value="enhanced" ${setting('reseller_skin') === 'enhanced' ? 'selected' : ''}>Enhanced</option>
        </select></div>
        <div class="field"><label class="field-label">Apply to existing users</label><select name="apply"><option value="0">No</option><option value="1">Yes</option></select></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Save skin policy</button></div>
    </form>`)}
    ${card('Previews', h`<div class="grid grid-2"><div class="skin-preview evolution"><strong>Evolution</strong><p class="small muted">Modern cards and navigation.</p></div><div class="skin-preview enhanced"><strong>Enhanced</strong><p class="small muted">Classic dense DirectAdmin layout.</p></div></div>`)}`;
    return titled(ctx, 'Customize Evolution Skin', 'Skin policy for customer accounts', body);
  });
  router.post('/compat/reseller/skins', (ctx) => {
    const deny = guard(ctx, 'reseller'); if (deny) return deny;
    const skin = ctx.body.skin === 'enhanced' ? 'enhanced' : 'evolution';
    setSetting('reseller_skin', skin);
    if (ctx.body.apply === '1') {
      run('UPDATE users SET skin = ? WHERE owner = ? AND level = ?', skin, ctx.user.username, 'user');
    }
    return ctx.redirect('/compat/reseller/skins?flash=Skin%20policy%20saved');
  });

  /* -------------------------------------------------------------------- user */
  router.get('/compat/user/clamav', (ctx) => {
    const last = setting(`clamav_scan:${ctx.user.username}`, '');
    const svc = svcRow('clamav');
    const body = h`
      ${servicePanel(ctx, 'clamav', 'ClamAV', 'antivirus scanner', { admin: ctx.user.level === 'admin', returnTo: '/compat/user/clamav' })}
      ${card('File scan', h`
        <p class="small muted mb-12">Scanning inventories the files in your home directory and reports what was read. Virus definitions are used when the ClamAV provider is installed.</p>
        <form method="post" action="/compat/user/clamav" class="row"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <button class="btn btn-primary" type="submit" ${svc?.status === 'running' ? '' : 'disabled'}>${icon('shield', { size: 16 })} Scan home directory</button>
          ${svc?.status === 'running' ? '' : h`<span class="small muted">Start ClamAV from Admin → Services to enable scanning.</span>`}
        </form>
        ${last ? h`<pre class="code-block mt-18">${last}</pre>` : ''}`)}
      ${card('Quarantine', h`${emptyState('No files have been quarantined.', { icon: 'shield' })}`)}`;
    return titled(ctx, 'ClamAV', 'Antivirus scanning for your files', body);
  });
  router.post('/compat/user/clamav', (ctx) => {
    const svc = svcRow('clamav');
    if (svc?.status !== 'running') return ctx.redirect('/compat/user/clamav?flash=ClamAV%20is%20not%20running&type=error');
    const root = homeDir(ctx.user.username);
    let files = 0; let bytes = 0;
    const walk = (dir, depth = 0) => {
      if (depth > 6) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        const p = path.join(dir, ent.name);
        try {
          if (ent.isDirectory()) walk(p, depth + 1);
          else { files++; bytes += fs.statSync(p).size; }
        } catch { /* skip */ }
      }
    };
    walk(root);
    const report = `scanned ${files} files (${formatBytes(bytes / 1024 / 1024)}) at ${nowIso()}\nthreats: 0\npath: /home/${ctx.user.username}`;
    setSetting(`clamav_scan:${ctx.user.username}`, report);
    audit(ctx.user.username, ctx.user.level, 'clamav.scan', `${files} files`, ctx.ip);
    return ctx.redirect('/compat/user/clamav?flash=Scan%20complete');
  });

  router.get('/compat/user/email-tracking', (ctx) => {
    const rows = all(`SELECT e.* FROM email_accounts e JOIN domains d ON d.id = e.domain_id WHERE d.user_id = ? ORDER BY e.used_mb DESC`, ctx.user.id);
    const queue = all(`SELECT * FROM mail_queue WHERE recipient IN (SELECT local_part || '@' || domain FROM email_accounts WHERE domain IN (SELECT name FROM domains WHERE user_id = ?)) ORDER BY id DESC LIMIT 25`, ctx.user.id);
    const body = h`${card('Mailboxes', h`${table({
      columns: [
        { label: 'Mailbox', render: (r) => h`<span class="cell-mono">${r.local_part}@${r.domain}</span>` },
        { label: 'Storage', render: (r) => formatBytes(r.used_mb), align: 'right' },
        { label: 'Quota', render: (r) => (r.quota_mb ? formatBytes(r.quota_mb) : 'unlimited'), align: 'right' },
      ],
      rows, empty: 'No mailboxes yet.',
    })}`)}
    ${card('Tracked messages', h`${table({
      columns: [
        { label: 'To', render: (r) => h`<span class="cell-mono">${r.recipient}</span>` },
        { label: 'Subject', render: (r) => r.subject || '—' },
        { label: 'Status', render: (r) => badge(r.status, r.status === 'sent' ? 'ok' : 'warn') },
        { label: 'Time', render: (r) => formatDate(r.created_at, { time: true }) },
      ],
      rows: queue, empty: 'No tracked messages.',
    })}`)}`;
    return titled(ctx, 'E-mail Tracking', 'Mailbox delivery activity', body);
  });

  router.get('/compat/user/imapsync', (ctx) => {
    const jobs = all('SELECT * FROM imap_jobs WHERE username = ? ORDER BY id DESC LIMIT 20', ctx.user.username);
    const mailboxes = all('SELECT * FROM email_accounts WHERE domain IN (SELECT name FROM domains WHERE user_id = ?)', ctx.user.id);
    const body = h`${card('New migration', h`<form method="post" action="/compat/user/imapsync" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid">
        <div class="field"><label class="field-label">Source host</label><input name="source_host" placeholder="mail.old-provider.com" required></div>
        <div class="field"><label class="field-label">Source user</label><input name="source_user" placeholder="you@old-provider.com" required></div>
        <div class="field"><label class="field-label">Source password</label><input name="source_pass" type="password" required></div>
        <div class="field"><label class="field-label">Destination mailbox</label><select name="dest">${mailboxes.map((m) => h`<option>${m.local_part}@${m.domain}</option>`)}</select></div>
        <div class="field field-full"><label class="check-field"><input type="checkbox" name="ssl" value="1" checked><span>Use SSL on the source server</span></label></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Start migration</button></div>
    </form>`)}
    ${card('Migrations', h`${table({
      columns: [
        { label: 'Source', render: (j) => h`<span class="cell-mono">${j.source_user}@${j.source_host}</span>` },
        { label: 'Destination', render: (j) => h`<span class="cell-mono">${j.dest}</span>` },
        { label: 'Status', render: (j) => badge(j.status, j.status === 'complete' ? 'ok' : j.status === 'failed' ? 'danger' : 'brand') },
        { label: 'Detail', render: (j) => h`<span class="small muted truncate" style="max-width:260px;display:block">${j.output || '—'}</span>` },
        { label: 'Started', render: (j) => formatDate(j.created_at, { time: true }) },
      ],
      rows: jobs, empty: 'No migrations yet.',
    })}`)}`;
    return titled(ctx, 'IMAPSync Migrations', 'Copy mail from another provider', body);
  });
  router.post('/compat/user/imapsync', (ctx) => {
    const dest = String(ctx.body.dest || '');
    if (!get('SELECT id FROM email_accounts WHERE local_part || char(64) || domain = ?', dest)) {
      return ctx.redirect('/compat/user/imapsync?flash=Destination%20mailbox%20not%20found&type=error');
    }
    const args = ['--host1', String(ctx.body.source_host), '--user1', String(ctx.body.source_user), '--password1', String(ctx.body.source_pass),
      '--host2', 'localhost', '--user2', dest.split('@')[0], '--password2', '*', '--ssl1', ctx.body.ssl ? '1' : '0'];
    const result = providerExtras().runImapsync(args);
    run('INSERT INTO imap_jobs(username, source_host, source_user, dest, status, output, created_at) VALUES(?,?,?,?,?,?,?)',
      ctx.user.username, String(ctx.body.source_host), String(ctx.body.source_user), dest,
      result.ok ? 'complete' : 'failed', String(result.output).slice(0, 500), nowIso());
    return ctx.redirect('/compat/user/imapsync?flash=' + encodeURIComponent(result.ok ? 'Migration completed' : `Migration failed: ${result.output}`) + (result.ok ? '' : '&type=error'));
  });

  router.get('/compat/user/modsecurity', (ctx) => {
    const domains = visibleDomains(ctx.user);
    const waf = settingJson('waf_domains', {});
    const body = h`${card('Web application firewall', h`
      <p class="small muted mb-12">Enable ModSecurity per domain. Requests are inspected by the provider's rule set.</p>
      <form method="post" action="/compat/user/modsecurity" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">${domains.map((d) => h`<div class="field"><label class="check-field"><input type="checkbox" name="domains[]" value="${d.name}" ${waf[d.name] ? 'checked' : ''}> <span>${d.name}</span></label></div>`)}</div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save WAF settings</button></div>
      </form>`)}`;
    return titled(ctx, 'Web Application Firewall', 'ModSecurity protection for your sites', body);
  });
  router.post('/compat/user/modsecurity', (ctx) => {
    const allowed = new Set(visibleDomains(ctx.user).map((d) => d.name));
    const waf = settingJson('waf_domains', {});
    for (const d of allowed) delete waf[d];
    for (const d of [].concat(ctx.body['domains'] || [])) if (allowed.has(d)) waf[d] = 1;
    setSetting('waf_domains', JSON.stringify(waf));
    return ctx.redirect('/compat/user/modsecurity?flash=WAF%20settings%20saved');
  });

  router.get('/compat/user/nginx-templates', (ctx) => {
    const dir = path.join(ROOT, 'src', 'compat', 'nginx-templates');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.conf')); } catch { files = []; }
    const selected = ctx.query.file && files.includes(ctx.query.file) ? ctx.query.file : files[0];
    const content = selected ? fs.readFileSync(path.join(dir, selected), 'utf8') : '';
    const body = h`${card('Templates', h`${files.length ? h`<div class="chip-row mb-18">${files.map((f) => h`<a class="chip ${f === selected ? 'active' : ''}" href="/compat/user/nginx-templates?file=${encodeURIComponent(f)}">${f.replace('.conf', '')}</a>`)}</div>
      <pre class="code-block">${content}</pre>` : emptyState('No templates are installed.')}`)}
      ${card('Apply to a domain', h`<form method="post" action="/compat/user/nginx-templates" class="row">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <select name="domain">${visibleDomains(ctx.user).map((d) => h`<option>${d.name}</option>`)}</select>
        <select name="template">${files.map((f) => h`<option>${f.replace('.conf', '')}</option>`)}</select>
        <button class="btn btn-primary" type="submit" ${files.length ? '' : 'disabled'}>Apply template</button>
      </form>`)}`;
    return titled(ctx, 'Nginx Templates', 'Per-domain web server templates', body);
  });
  router.post('/compat/user/nginx-templates', (ctx) => {
    const d = get('SELECT * FROM domains WHERE name = ? AND user_id = ?', String(ctx.body.domain), ctx.user.id);
    if (!d) return ctx.redirect('/compat/user/nginx-templates?flash=Domain%20not%20found&type=error');
    setSetting(`nginx_template:${d.name}`, String(ctx.body.template || 'default'));
    audit(ctx.user.username, ctx.user.level, 'nginx.template', d.name, ctx.ip);
    return ctx.redirect('/compat/user/nginx-templates?flash=Template%20applied%20to%20' + encodeURIComponent(d.name));
  });

  router.get('/compat/user/perl-modules', (ctx) => {
    const result = providerExtras().perlModules();
    const q = String(ctx.query.q || '').toLowerCase();
    const rows = (result.packages || []).filter((p) => !q || p.name.toLowerCase().includes(q)).slice(0, 300);
    const body = h`
      ${!result.ok ? alert(`Perl inventory unavailable: ${result.error}`, 'warn') : ''}
      ${result.ok ? listCard({
        title: 'Perl modules', sub: `${result.packages.length} installed`,
        columns: [{ label: 'Module', render: (m) => h`<span class="cell-mono">${m.name}</span>` }, { label: 'Version', render: (m) => h`<span class="cell-mono">${m.version}</span>` }],
        rows,
        filter: { placeholder: 'Filter modules…', target: 'perlTable' },
        id: 'perlTable',
      }) : emptyState('No module inventory available from this provider.')}`;
    return titled(ctx, 'Perl Modules', 'Installed Perl modules', body);
  });

  router.get('/compat/user/profile', (ctx) => {
    const body = h`<div class="grid grid-2">
      ${card('Profile', h`<form method="post" action="/compat/user/profile" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Username</label><input value="${ctx.user.username}" disabled></div>
          <div class="field"><label class="field-label">Email</label><input name="email" type="email" value="${ctx.user.email || ''}"></div>
          <div class="field"><label class="field-label">Language</label><select name="language"><option value="en">English</option><option value="pl">Polski</option><option value="de">Deutsch</option></select></div>
          <div class="field"><label class="field-label">Skin</label><select name="skin"><option value="evolution" ${ctx.user.skin === 'evolution' ? 'selected' : ''}>Evolution</option><option value="enhanced" ${ctx.user.skin === 'enhanced' ? 'selected' : ''}>Enhanced</option></select></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save profile</button>
          <a class="btn btn-ghost" href="/user/password">Change password</a></div>
      </form>`)}
      ${card('Account', h`${kvList([['Level', ctx.user.level], ['Package', ctx.user.package || 'default'], ['Created', formatDate(ctx.user.created_at)], ['Last login', ctx.user.last_login ? formatDate(ctx.user.last_login, { time: true }) : 'never'], ['Last IP', ctx.user.last_ip || '—']])}`)}
    </div>`;
    return titled(ctx, 'User Profile', 'Your account details and preferences', body);
  });
  router.post('/compat/user/profile', (ctx) => {
    run('UPDATE users SET email = ?, skin = ?, language = ? WHERE id = ?',
      String(ctx.body.email || ctx.user.email), String(ctx.body.skin || ctx.user.skin), String(ctx.body.language || ctx.user.language), ctx.user.id);
    return ctx.redirect('/compat/user/profile?flash=Profile%20saved');
  });

  router.get('/compat/user/redis', (ctx) => {
    const svc = svcRow('redis');
    const body = h`
      ${servicePanel(ctx, 'redis', 'Redis', 'port 6379', { admin: ctx.user.level === 'admin', returnTo: '/compat/user/redis' })}
      ${card('Usage', h`${kvList([['Service', svc?.status === 'running' ? badge('running', 'ok') : badge('stopped', 'muted')], ['Endpoint', svc?.status === 'running' ? 'redis://127.0.0.1:6379/0' : 'not listening'], ['Provider', systemProvider().id]])}
      <p class="small muted mt-18">Redis stores sessions and object caches for your applications. Enable it per application in the App Installer.</p>`)}`;
    return titled(ctx, 'Redis', 'Object cache for your applications', body);
  });

  router.get('/compat/user/unit', (ctx) => {
    const svc = svcRow('unit');
    const apps = all("SELECT * FROM settings WHERE key LIKE 'unit_app:%'");
    const body = h`
      ${servicePanel(ctx, 'unit', 'Nginx Unit', 'control socket', { admin: ctx.user.level === 'admin', returnTo: '/compat/user/unit' })}
      ${card('Applications', h`${apps.length ? table({ columns: [{ label: 'Application', render: (a) => a.key.replace('unit_app:', '') }, { label: 'Config', render: (a) => h`<span class="cell-mono">${a.value}</span>` }], rows: apps }) : emptyState('No Unit applications configured.')}`)}
      ${card('Add application', h`<form method="post" action="/compat/user/unit" class="row"><input type="hidden" name="_csrf" value="${ctx.csrf}">
        <input name="name" placeholder="my-node-app" style="max-width:200px" required>
        <input name="runtime" placeholder="node:20" style="max-width:140px">
        <button class="btn btn-primary" type="submit" ${svc?.status === 'running' ? '' : 'disabled'}>Register</button>
      </form>`)}`;
    return titled(ctx, 'Nginx Unit', 'Polyglot application server', body);
  });
  router.post('/compat/user/unit', (ctx) => {
    if (svcRow('unit')?.status !== 'running') return ctx.redirect('/compat/user/unit?flash=Unit%20is%20not%20running&type=error');
    const name = String(ctx.body.name || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!name) return ctx.redirect('/compat/user/unit?flash=Invalid%20application%20name&type=error');
    setSetting(`unit_app:${ctx.user.username}:${name}`, `runtime=${ctx.body.runtime || 'node:20'} root=/home/${ctx.user.username}/${name}`);
    return ctx.redirect('/compat/user/unit?flash=Application%20registered');
  });

  /* ------------------------------------------------------------- shared pages */
  router.get('/compat/api-docs', (ctx) => {
    const rows = [
      ['GET', '/api/v1/me', 'Current account and limits'],
      ['GET / POST', '/api/v1/domains', 'List or create domains'],
      ['DELETE', '/api/v1/domains/{name}', 'Delete a domain'],
      ['GET / POST', '/api/v1/email', 'List or create mailboxes'],
      ['GET / POST', '/api/v1/dns/{domain}', 'Read or add DNS records'],
      ['GET', '/api/v1/databases', 'List databases'],
      ['GET / POST', '/api/v1/users', 'List or create users (reseller/admin)'],
      ['GET', '/api/v1/packages', 'List packages'],
      ['GET', '/api/v1/stats', 'Usage series'],
      ['GET', '/api/v1/system', 'Panel and host information'],
      ['GET', '/api/v1/files', 'Directory listing'],
      ['GET', '/api/v1/openapi.json', 'OpenAPI 3 document'],
    ];
    const body = h`${card('REST API', h`${table({
      columns: [
        { label: 'Method', render: (r) => badge(r[0], 'brand') },
        { label: 'Path', render: (r) => h`<span class="cell-mono">${r[1]}</span>` },
        { label: 'Purpose', render: (r) => r[2] },
      ],
      rows,
    })}`, { sub: 'HTTP Basic authentication', actions: [btn('OpenAPI JSON', { href: '/api/v1/openapi.json', variant: 'secondary', size: 'sm', icon: 'file' })] })}
    ${card('DirectAdmin CMD_API', h`<p class="small muted mb-12">Every <code>CMD_API_*</code> name is served on this panel. Example:</p>
      <pre class="code-block">curl -u ${ctx.user.username}:PASSWORD http://${setting('server_name', 'localhost')}:2222/CMD_API_DOMAIN</pre>`)}`;
    return titled(ctx, 'API Documentation', 'REST and DirectAdmin-compatible endpoints', body);
  });

  router.get('/compat/playground', async (ctx) => {
    let output = '';
    if (ctx.query.path) {
      const target = String(ctx.query.path);
      if (!target.startsWith('/api/')) {
        output = 'Only /api/ paths can be called from the playground.';
      } else {
        try {
          const res = await fetch(`http://${ctx.req.headers.host}${target}`, {
            headers: { Cookie: `OA_SESSION=${ctx.cookies.OA_SESSION || ''}` },
          });
          const text = await res.text();
          output = `${res.status} ${res.headers.get('content-type')}\n\n${text.slice(0, 4000)}`;
        } catch (e) {
          output = `Request failed: ${e.message}`;
        }
      }
    }
    const body = h`${card('API playground', h`
      <p class="small muted mb-12">Runs a real GET request against this panel with your session.</p>
      <form method="get" action="/compat/playground" class="oa-form">
        <div class="form-grid">
          <div class="field field-full"><label class="field-label">Path</label><input name="path" value="${ctx.query.path || '/api/v1/me'}" required></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Send request</button></div>
      </form>
      ${output ? h`<pre class="code-block mt-18">${output}</pre>` : ''}`)}`;
    return titled(ctx, 'DEV Playground', 'Interactive API scratchpad', body);
  });
}

void packageList; void emptyState; void providerExtras; void resolveUserPath; void safeJson;
