// Administrator routes: server, resellers, users, packages, settings, tools.
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, nowIso, setting, setSetting, audit, hashPassword, transaction } from '../db.mjs';
import { config, VERSION } from '../config.mjs';
import { createSession, limitsFor } from '../auth.mjs';
import { html as h, formatBytes, formatDate, timeAgo, safeJson, isIp } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, btn, badge, alert, emptyState, kvList, progress, statCard, sparkline } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { listCard, domainSelect } from '../ui/pages/list.mjs';
import { countForNav, visibleUsers, visibleDomains, usageSeries, allUsageSeries, domainFor } from '../core/access.mjs';
import { usersPage, userForm, createUser, updateUser, userDetailPage, toggleSuspend, deleteUser, packagesPage, packageForm, savePackage, resellersPage, resellerForm } from '../features/user-admin.mjs';
import { usageChartCard } from '../ui/pages/widgets.mjs';
import { systemProvider, providerInfo } from '../providers/index.mjs';
import { register as registerWebServer } from '../features/webserver.mjs';
import { register as registerMariaDb } from '../features/mariadb.mjs';
import { register as registerApps } from '../features/apps.mjs';
import { createServerBackup } from '../backups.mjs';
import { collectUsage, usageMeta } from '../usage.mjs';
import { enforceAll, quotaMeta } from '../quota.mjs';
import { pluginInventory, hookScript } from '../plugins.mjs';
import { editorTargets, readTarget, saveTarget } from '../fileeditor.mjs';
import { rebuildAll, deployZones, zoneMeta } from '../dns.mjs';
import { mailStatus, deployMail, syncMail } from '../mail.mjs';
import { register as registerSetup } from '../features/setup.mjs';
import { register as registerHealth } from '../features/health.mjs';
import { register as registerImporter } from '../features/importer.mjs';
import { register as registerSecurityCenter } from '../features/security-center.mjs';
import { register as registerMailOps } from '../features/mail-ops.mjs';
import { register as registerBackupCenter } from '../features/backup-center.mjs';
import { register as registerPhpManager } from '../features/php-manager.mjs';
import { register as registerPlanCenter } from '../features/plan-center.mjs';
import { register as registerDnsCenter } from '../features/dns-center.mjs';
import { register as registerImportLive } from '../features/import-live.mjs';
import { register as registerUpdateCenter } from '../features/update-center.mjs';
import { register as registerApiKeys } from '../features/api-keys.mjs';
import { register as registerNotifications } from '../features/notifications.mjs';
import { register as registerResellerTools } from '../features/reseller-tools.mjs';
import { register as registerSupportAccess } from '../features/support-access.mjs';
import { register as registerSslCenter } from '../features/ssl-center.mjs';
import { register as registerLogCenter } from '../features/log-center.mjs';
import { register as registerStorage } from '../features/storage-center.mjs';
import { register as registerPanelConfig } from '../features/panel-config.mjs';
import { register as registerUserTools } from '../features/user-tools.mjs';
import { register as registerPostgres } from '../features/postgres-center.mjs';
import { register as registerMultiServer } from '../features/multiserver.mjs';

const A = '/admin';

function adminDashboard(ctx) {
  const users = all("SELECT * FROM users WHERE level = 'user'");
  const resellers = all("SELECT * FROM users WHERE level = 'reseller'");
  const domains = all('SELECT * FROM domains');
  const series = allUsageSeries(30);
  const services = all('SELECT * FROM services ORDER BY name').map((sv) => ({ ...sv, effective: systemProvider().serviceStatus(sv.name)?.status || sv.status }));
  const auditRows = all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 8');
  const tickets = all("SELECT * FROM tickets WHERE status != 'closed' ORDER BY created_at DESC LIMIT 5");
  const memTotal = os.totalmem() / 1024 / 1024;
  const memFree = os.freemem() / 1024 / 1024;
  const bw = series.reduce((a, r) => a + (r.bandwidth_mb || 0), 0);
  const running = services.filter((s) => s.status === 'running').length;
  const body = h`
    <div class="hero">
      <div>
        <h2>Server overview</h2>
        <p><strong>${users.length}</strong> ${users.length === 1 ? 'user' : 'users'} · <strong>${resellers.length}</strong> ${resellers.length === 1 ? 'reseller' : 'resellers'} · <strong>${domains.length}</strong> ${domains.length === 1 ? 'domain' : 'domains'} · ${running}/${services.length} services running.</p>
        <div class="row mt-18">${badge('OpenAdmin ' + VERSION, 'brand')}${badge('License: unlimited', 'ok')}${badge('Free & open source', 'ok')}</div>
      </div>
      <div class="hero-actions">
        ${btn('Create user', { href: '/admin/users/create', icon: 'plus' })}
        ${btn('Create reseller', { href: '/admin/resellers/create', variant: 'secondary', icon: 'users' })}
        ${btn('Server settings', { href: '/admin/settings', variant: 'secondary', icon: 'settings' })}
      </div>
    </div>
    ${setting('setup_complete', '0') !== '1' ? alert(h`<strong>Dokończ konfigurację panelu.</strong> Ustaw adres IP, serwery nazw i wdróż strony, DNS i pocztę. <a class="link" href="/admin/setup">Otwórz kreator →</a>`, 'warn') : ''}
    <div class="stat-grid">
      ${statCard({ label: 'Users', value: String(users.length), sub: `${resellers.length} resellers`, icon: 'users', href: '/admin/users' })}
      ${statCard({ label: 'Domains', value: String(domains.length), sub: `${domains.filter((d) => d.ssl).length} with SSL`, icon: 'globe', href: '/admin/dns' })}
      ${statCard({ label: 'Bandwidth (30d)', value: formatBytes(bw), sub: 'all accounts', icon: 'chart', tone: 'ok', href: '/admin/user-statistics' })}
      ${statCard({ label: 'Memory', value: `${Math.round(((memTotal - memFree) / memTotal) * 100)}%`, sub: `${formatBytes((memTotal - memFree) / 1024)} of ${formatBytes(memTotal / 1024)}`, icon: 'cpu', tone: 'warn', href: '/admin/system-info' })}
    </div>
    <div class="grid grid-2-1">
      ${usageChartCard(series.map((r) => ({ ...r, bandwidth_mb: r.bandwidth_mb })), { title: 'Server bandwidth', sub: 'Aggregate, last 30 days' })}
      ${card('Services', h`${services.slice(0, 7).map((s) => h`<div class="service-row">
        <span class="service-dot ${s.effective === 'running' ? 'on' : 'off'}"></span><strong>${s.name}</strong>
        <span style="margin-left:auto">${badge(s.effective, s.effective === 'running' ? 'ok' : 'danger', { dot: true })}</span>
      </div>`)}`, { actions: [h`<a class="link small" href="/admin/services">Manage</a>`] })}
    </div>
    <div class="grid grid-2">
      ${card('Recent activity', h`<div class="timeline">${auditRows.map((a) => h`<div class="timeline-item">
        <div class="timeline-dot">${icon('check', { size: 15 })}</div>
        <div class="timeline-body"><div class="spread"><span><strong>${a.actor}</strong> ${a.action.replace('.', ' ')} ${a.target || ''}</span><span class="small muted">${timeAgo(a.created_at)}</span></div>
        <small>${a.level} · ${a.ip || 'local'}</small></div></div>`)}</div>`, { actions: [h`<a class="link small" href="/admin/audit-log">Audit log</a>`] })}
      ${card('Open tickets', h`${tickets.length ? h`<div class="timeline">${tickets.map((t) => h`<div class="timeline-item"><div class="timeline-dot">${icon('ticket', { size: 15 })}</div>
        <div class="timeline-body"><div class="spread"><a class="link" href="/admin/tickets/${t.id}">${t.subject}</a><span class="small muted">${timeAgo(t.created_at)}</span></div><small>${t.username} · ${t.priority}</small></div></div>`)}</div>` : emptyState('No open tickets')}`, { actions: [h`<a class="link small" href="/admin/tickets">All tickets</a>`] })}
    </div>
    <div class="grid grid-4">
      ${quick('/admin/license', 'gift', 'Licensing', 'Free, unlimited')}
      ${quick('/admin/plugins', 'plug', 'Plugins', 'Extend the panel')}
      ${quick('/admin/backups', 'archive', 'Backups', 'Server snapshots')}
      ${quick('/admin/health', 'check', 'Stan serwera', 'Co działa, co naprawić')}
      ${quick('/admin/setup', 'settings', 'Kreator', 'Pierwsza konfiguracja')}
      ${quick('/admin/audit-log', 'list', 'Audit log', 'Every action')}
    </div>`;
  return page(ctx, { title: 'Admin Dashboard', subtitle: 'Server and hosting overview', body, counts: countForNav(ctx.user, 'admin') });
}

function quick(href, ic, title, sub) {
  return h`<a class="quick-tile" href="${href}">${icon(ic, { size: 20 })}<strong>${title}</strong><span>${sub}</span></a>`;
}

export function registerAdminRoutes(router) {
  registerWebServer(router);
  registerMariaDb(router);
  registerApps(router);
  registerSetup(router);
  registerHealth(router);
  registerImporter(router);
  registerSecurityCenter(router);
  registerMailOps(router);
  registerBackupCenter(router);
  registerPhpManager(router);
  registerPlanCenter(router);
  registerDnsCenter(router);
  registerImportLive(router);
  registerUpdateCenter(router);
  registerApiKeys(router);
  registerNotifications(router);
  registerResellerTools(router);
  registerSupportAccess(router);
  registerSslCenter(router);
  registerLogCenter(router);
  registerStorage(router);
  registerPanelConfig(router);
  registerUserTools(router);
  registerPostgres(router);
  registerMultiServer(router);
  router.get('/admin', (ctx) => adminDashboard(ctx));

  /* ------------------------------------------------------------ system info */
  router.get('/admin/system-info', (ctx) => {
    const memTotal = os.totalmem();
    const memFree = os.freemem();
    const load = os.loadavg();
    const uptime = os.uptime();
    const body = h`
      <div class="stat-grid">
        ${statCard({ label: 'Uptime', value: `${Math.floor(uptime / 86400)}d ${Math.floor((uptime % 86400) / 3600)}h`, sub: 'since last reboot', icon: 'clock' })}
        ${statCard({ label: 'Load average', value: load[0].toFixed(2), sub: `${load[1].toFixed(2)} · ${load[2].toFixed(2)}`, icon: 'cpu', tone: 'warn' })}
        ${statCard({ label: 'Memory', value: `${Math.round(((memTotal - memFree) / memTotal) * 100)}%`, sub: `${formatBytes((memTotal - memFree) / 1024 / 1024)} used`, icon: 'monitor' })}
        ${statCard({ label: 'CPU cores', value: String(os.cpus().length), sub: os.cpus()[0]?.model?.split(' ').slice(0, 3).join(' ') || '', icon: 'server', tone: 'ok' })}
      </div>
      <div class="grid grid-2">
        ${card('System', h`${kvList([
          ['Hostname', os.hostname()],
          ['Operating system', `${os.type()} ${os.release()}`],
          ['Platform', os.platform() + ' / ' + os.arch()],
          ['Kernel', os.version?.() || os.release()],
          ['Node.js', process.version],
          ['Panel', `OpenAdmin ${VERSION}`],
          ['Data directory', config.dataDir],
          ['Provider', providerInfo().label],
        ])}`)}
        ${card('Panel', h`${kvList([
          ['Server name', setting('server_name', 'localhost')],
          ['Server IP', setting('server_ip', '127.0.0.1')],
          ['Nameservers', `${setting('ns1', '')} · ${setting('ns2', '')}`],
          ['Default PHP', setting('php_default', '8.3')],
          ['Panel port', String(config.port)],
          ['Installed', formatDate(setting('installed_at', nowIso()))],
          ['License', 'Unlimited · free'],
        ])}`)}
      </div>
      ${card('Disk usage', h`${(() => {
        const doms = all('SELECT * FROM domains');
        const total = doms.reduce((a, d) => a + d.disk_mb, 0);
        return h`<div class="spread"><span class="stat-value">${formatBytes(total)}</span><span class="small muted">${doms.length} domains · ${all('SELECT * FROM users').length} accounts</span></div>${progress(total, Math.max(total * 1.4, 102400), { showText: false })}`;
      })()}`)}`;
    return page(ctx, { title: 'System Information', subtitle: 'Hardware, operating system and panel details', body });
  });

  /* -------------------------------------------------------------- services */
  router.get('/admin/services', (ctx) => {
    const provider = systemProvider();
    const services = all('SELECT * FROM services ORDER BY name').map((s) => {
      const live = provider.serviceStatus(s.name);
      return { ...s, effective: live?.status || s.status, simulated: !live?.status };
    });
    const body = h`${provider.id === 'sandbox' ? alert('Sandbox provider: service state is simulated and stored by the panel. Run with <code>OA_PROVIDER=linux</code> as root to read systemd.', 'info') : ''}
      ${card('Service monitor', h`${services.map((s) => h`<div class="service-row">
      <span class="service-dot ${s.effective === 'running' ? 'on' : 'off'}"></span>
      <strong>${s.name}</strong><span class="small muted">${serviceMeta(s.name)}</span>
      <div style="margin-left:auto;display:flex;gap:6px;align-items:center">
        ${badge(s.effective, s.effective === 'running' ? 'ok' : 'danger', { dot: true })}${s.simulated ? badge('simulated', 'muted') : ''}
        <form method="post" action="/admin/services/${encodeURIComponent(s.name)}/toggle" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <button class="btn btn-secondary btn-sm" type="submit">${s.status === 'running' ? 'Stop' : 'Start'}</button></form>
        <form method="post" action="/admin/services/${encodeURIComponent(s.name)}/restart" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <button class="btn btn-ghost btn-sm" type="submit">${icon('refresh', { size: 14 })} Restart</button></form>
      </div></div>`)}`, { sub: `${services.filter((s) => s.status === 'running').length} of ${services.length} running` })}`;
    return page(ctx, { title: 'Service Monitor', subtitle: 'Start, stop and restart server daemons', body });
  });

  router.post('/admin/services/:name/toggle', (ctx) => {
    const s = get('SELECT * FROM services WHERE name = ?', ctx.params.name);
    if (s) {
      run('UPDATE services SET status = ? WHERE name = ?', s.status === 'running' ? 'stopped' : 'running', s.name);
      audit(ctx.user.username, 'admin', 'service.' + (s.status === 'running' ? 'stop' : 'start'), s.name, ctx.ip);
    }
    return ctx.redirect('/admin/services?flash=Service%20updated');
  });
  router.post('/admin/services/:name/restart', (ctx) => {
    const result = systemProvider().restartService(ctx.params.name);
    if (result.ok) run("UPDATE services SET status = 'running' WHERE name = ?", ctx.params.name);
    audit(ctx.user.username, 'admin', 'service.restart', `${ctx.params.name}${result.simulated ? ' (sandbox)' : ''}`, ctx.ip);
    return ctx.redirect('/admin/services?flash=' + encodeURIComponent(result.ok ? `${ctx.params.name}: ${result.output}` : `Restart failed: ${result.output}`) + (result.ok ? '' : '&type=error'));
  });

  /* ------------------------------------------------------------- processes */
  router.get('/admin/processes', (ctx) => {
    const result = systemProvider().processes();
    const rows = result.rows || [];
    const logs = all('SELECT * FROM process_log ORDER BY id DESC LIMIT 50');
    const body = h`${card('Process list', h`
      ${result.ok ? '' : alert(result.error, 'error')}
      ${result.simulated ? alert('Showing the host process list from the sandbox provider; kill/action is simulated.', 'info') : ''}
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>PID</th><th>User</th><th>CPU %</th><th>MEM %</th><th>Command</th><th></th></tr></thead>
        <tbody>${rows.map((p) => h`<tr><td class="cell-mono">${p.pid}</td><td>${p.user}</td><td>${p.cpu.toFixed(1)}</td><td>${p.mem.toFixed(1)}</td><td class="cell-mono truncate" style="max-width:520px;display:block">${p.command}</td>
          <td class="col-actions"><div class="row-actions">
            <form method="post" action="/admin/processes/${p.pid}/kill" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="icon-btn danger" type="submit" title="Kill" onclick="return confirm('Wysłać SIGTERM do PID ${p.pid}?')">${icon('close', { size: 16 })}</button></form>
            <form method="post" action="/admin/processes/${p.pid}/trace" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="icon-btn" type="submit" title="Trace">${icon('eye', { size: 16 })}</button></form>
          </div></td></tr>`)}</tbody>
      </table></div>`, { sub: `${rows.length} process(es) · load ${os.loadavg()[0].toFixed(2)} · ${os.cpus().length} cores`, padded: false })}
      ${card('Kill all by user', h`<form method="post" action="/admin/processes/user" class="row"><input type="hidden" name="_csrf" value="${ctx.csrf}">
        <select name="user">${[...new Set(rows.map((r) => r.user))].map((u) => h`<option>${u}</option>`)}</select>
        <button class="btn btn-danger" type="submit" onclick="return confirm('Wysłać SIGTERM do wszystkich procesów tego użytkownika?')">Kill all</button></form>`)}
      ${logs.length ? card('Process action log', table({
        columns: [{ label: 'Czas', render: (r) => formatDate(r.created_at, { time: true }) }, { label: 'Akcja', key: 'action' }, { label: 'PID', key: 'pid' }, { label: 'Użytkownik', key: 'user' }, { label: 'Wynik', key: 'result' }],
        rows: logs,
      }), { padded: false }) : ''}`;
    return page(ctx, { title: 'Process Monitor', subtitle: 'Running processes, kill and trace', body, wide: true });
  });

  const protectedPids = () => new Set([1, process.pid, process.ppid]);
  function killProcess(pid, actor) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n < 2) return { ok: false, error: 'Invalid PID' };
    if (protectedPids().has(n)) return { ok: false, error: 'Ten proces jest chroniony' };
    if (config.provider !== 'linux') {
      run('INSERT INTO process_log(action, pid, user, command, result, created_at) VALUES(?,?,?,?,?,?)', 'kill', n, actor, '', 'simulated', nowIso());
      return { ok: true, simulated: true };
    }
    try {
      process.kill(n, 'SIGTERM');
      run('INSERT INTO process_log(action, pid, user, command, result, created_at) VALUES(?,?,?,?,?,?)', 'kill', n, actor, '', 'SIGTERM sent', nowIso());
      return { ok: true };
    } catch (e) {
      run('INSERT INTO process_log(action, pid, user, command, result, created_at) VALUES(?,?,?,?,?,?)', 'kill', n, actor, '', e.message, nowIso());
      return { ok: false, error: e.message };
    }
  }
  router.post('/admin/processes/:pid/kill', (ctx) => {
    const r = killProcess(ctx.params.pid, ctx.user.username);
    return ctx.redirect('/admin/processes?flash=' + encodeURIComponent(r.ok ? `Wysłano SIGTERM do ${ctx.params.pid}` : r.error) + (r.ok ? '' : '&type=error'));
  });
  router.post('/admin/processes/:pid/trace', (ctx) => {
    const pid = Number(ctx.params.pid);
    if (!Number.isInteger(pid) || pid < 2) return ctx.redirect('/admin/processes?flash=Invalid%20PID&type=error');
    if (config.provider !== 'linux') {
      return page(ctx, { title: 'Process trace', subtitle: `PID ${pid}`, body: h`${card('Sandbox trace', h`<pre class="code-block">PID ${pid}: trace simulated in sandbox.</pre>`)}` });
    }
    const strace = spawnSync('sh', ['-c', `command -v strace && timeout 3 strace -f -p ${pid} -e trace=network,file -s 120 2>&1 || true`], { encoding: 'utf8', timeout: 8000 });
    const proc = spawnSync('sh', ['-c', `cat /proc/${pid}/status 2>/dev/null | head -20; echo ---; readlink /proc/${pid}/cwd 2>/dev/null; cat /proc/${pid}/cmdline 2>/dev/null | tr '\0' ' '`], { encoding: 'utf8', timeout: 5000 });
    const output = `${strace.stdout || ''}\n${proc.stdout || ''}`.trim() || 'Brak danych (proces zakończony lub ptrace niedozwolony).';
    return page(ctx, { title: 'Process trace', subtitle: `PID ${pid}`, body: h`${card('Trace', h`<pre class="code-block small">${output.slice(0, 20000)}</pre>`)}` });
  });
  router.post('/admin/processes/user', (ctx) => {
    const rows = systemProvider().processes().rows || [];
    const user = String(ctx.body.user || '');
    const pids = [...new Set(rows.filter((r) => r.user === user).map((r) => r.pid))];
    let ok = 0;
    for (const pid of pids) if (killProcess(pid, ctx.user.username).ok) ok++;
    return ctx.redirect('/admin/processes?flash=' + encodeURIComponent(`Wysłano SIGTERM do ${ok} procesów użytkownika ${user}`));
  });

  /* ------------------------------------------------------------------ logs */
  router.get('/admin/logs', (ctx) => {
    const rows = all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200');
    const body = h`${card('Panel log', h`<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Time</th><th>Actor</th><th>Level</th><th>Action</th><th>Target</th><th>IP</th></tr></thead>
      <tbody>${rows.map((r) => h`<tr><td class="small">${formatDate(r.created_at, { time: true })}</td><td>${r.actor}</td><td>${badge(r.level, 'brand')}</td>
        <td class="cell-mono">${r.action}</td><td>${r.target || '—'}</td><td class="cell-mono small">${r.ip || '—'}</td></tr>`)}</tbody>
    </table></div>`, { padded: false })}
    ${card('Log files', h`${kvList([
      ['Panel log', '/var/log/openadmin/panel.log'],
      ['Access log', '/var/log/httpd/domains/*.log'],
      ['Error log', '/var/log/httpd/error_log'],
      ['Mail log', '/var/log/exim/mainlog'],
      ['Auth log', '/var/log/secure'],
    ])}<p class="small muted mt-18">Use the File Editor to inspect log files. Log rotation runs nightly.</p>`)}`;
    return page(ctx, { title: 'Log Viewer', subtitle: 'Panel and system logs', body });
  });

  /* -------------------------------------------------------------- settings */
  router.get('/admin/settings', (ctx) => {
    const body = h`${card('Server settings', h`<form method="post" action="/admin/settings" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid">
        <div class="field"><label class="field-label">Server hostname</label><input name="server_name" value="${setting('server_name', '')}"></div>
        <div class="field"><label class="field-label">Server IP</label><input name="server_ip" value="${setting('server_ip', '')}"></div>
        <div class="field"><label class="field-label">Primary nameserver</label><input name="ns1" value="${setting('ns1', '')}"></div>
        <div class="field"><label class="field-label">Secondary nameserver</label><input name="ns2" value="${setting('ns2', '')}"></div>
        <div class="field"><label class="field-label">Default PHP version</label><select name="php_default">${['8.4', '8.3', '8.2', '8.1', '7.4'].map((v) => h`<option ${v === setting('php_default') ? 'selected' : ''}>${v}</option>`)}</select></div>
        <div class="field"><label class="field-label">Default user package</label><select name="default_package">${all("SELECT * FROM packages WHERE type='user'").map((p) => h`<option ${p.name === setting('default_package') ? 'selected' : ''}>${p.name}</option>`)}</select></div>
        <div class="field"><label class="field-label">Webmail URL</label><input name="webmail_url" value="${setting('webmail_url', '/roundcube/')}"></div>
        <div class="field"><label class="field-label">Panel port</label><input value="${config.port}" disabled></div>
        <div class="field field-full"><label class="field-label">Login page message</label><textarea name="login_page_message" rows="2">${setting('login_page_message', '')}</textarea></div>
        <div class="field"><label class="field-label">Demo mode</label><select name="demo_mode"><option value="0" ${setting('demo_mode') !== '1' ? 'selected' : ''}>Disabled</option><option value="1" ${setting('demo_mode') === '1' ? 'selected' : ''}>Enabled</option></select></div>
        <div class="field"><label class="field-label">TLS mode</label><select name="tls_mode"><option value="modern" ${setting('tls_mode') === 'modern' ? 'selected' : ''}>Modern (TLS 1.2+)</option><option value="intermediate">Intermediate</option><option value="old">Legacy</option></select></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('save', { size: 16 })} Save settings</button></div>
    </form>`)}
    ${card('Security', h`${kvList([
      ['Panel login', `http://${setting('server_name', 'localhost')}:${config.port}`],
      ['Session lifetime', `${config.sessionTtlHours} hours`],
      ['Login throttling', `${config.limits.maxLoginAttempts} attempts / ${config.limits.loginWindowMinutes} min`],
      ['Two-factor authentication', 'Optional per account'],
      ['CSRF protection', 'Enabled'],
      ['API', 'HTTP Basic · CMD_API compatible'],
    ])}`)}`;
    return page(ctx, { title: 'Server Settings', subtitle: 'Panel-wide configuration', body });
  });

  router.post('/admin/settings', (ctx) => {
    for (const key of ['server_name', 'server_ip', 'ns1', 'ns2', 'php_default', 'default_package', 'webmail_url', 'login_page_message', 'demo_mode', 'tls_mode']) {
      if (ctx.body[key] !== undefined) setSetting(key, String(ctx.body[key]));
    }
    audit(ctx.user.username, 'admin', 'settings.update', '', ctx.ip);
    return ctx.redirect('/admin/settings?flash=Settings%20saved');
  });

  /* --------------------------------------------------------------- license */
  router.get('/admin/license', (ctx) => {
    const body = h`
      <div class="license-hero">
        <div class="license-seal">${icon('gift', { size: 30 })}</div>
        <div>
          <h2>Community Edition — unlimited, forever</h2>
          <p>No license keys. No account limits. No paid add-ons. OpenAdmin is free software under the AGPL-3.0; every feature is included for every installation.</p>
        </div>
      </div>
      <div class="grid grid-3">
        ${card('License status', h`${kvList([
          ['Edition', 'Community'],
          ['Type', 'Unlimited'],
          ['Account limit', 'Unlimited'],
          ['Domain limit', 'Unlimited'],
          ['Expires', 'Never'],
          ['Cost', '€0.00'],
        ], { cols: 1 })}`)}
        ${card('What is included', h`${kvList([
          ['Admin panel', badge('Included', 'ok')],
          ['Reseller panel', badge('Included', 'ok')],
          ['User panel', badge('Included', 'ok')],
          ['DNS management', badge('Included', 'ok')],
          ['Email + webmail', badge('Included', 'ok')],
          ['Backups', badge('Included', 'ok')],
          ['SSL / Let\'s Encrypt', badge('Included', 'ok')],
        ], { cols: 1 })}`)}
        ${card('No paywalls', h`<p class="small muted">There is no marketplace, no upsell, no feature gating. If a DirectAdmin capability exists, it is part of this package.</p>
          <p class="small muted mt-10">Compare the <a class="link" href="/help">feature matrix</a> or read the <a class="link" href="/api/v1/openapi.json">API reference</a>.</p>`)}
      </div>
      ${card('License terms', h`<p class="small muted">This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. There is no warranty, to the extent permitted by law.</p>
        <div class="row mt-18">${btn('View AGPL-3.0', { href: 'https://www.gnu.org/licenses/agpl-3.0.html', variant: 'secondary', attrs: 'target="_blank" rel="noopener"' })}</div>`)}`;
    return page(ctx, { title: 'Licensing', subtitle: 'Free, unlimited and open source', body });
  });

  /* ---------------------------------------------------------------- reboot */
  router.get('/admin/reboot', (ctx) => {
    const body = h`${card('Reboot server', h`
      <p class="small muted mb-18">A reboot restarts every service and drops all active sessions. This is simulated in the sandbox provider.</p>
      ${alert('All websites and mailboxes will be unavailable for 1–2 minutes.', 'warn')}
      <form method="post" action="/admin/reboot"><input type="hidden" name="_csrf" value="${ctx.csrf}">
        <button class="btn btn-danger" type="submit" onclick="return confirm('Reboot the server now?')">${icon('refresh', { size: 16 })} Reboot now</button></form>`)}`;
    return page(ctx, { title: 'Reboot', subtitle: 'Restart the server', body });
  });
  router.post('/admin/reboot', (ctx) => {
    const result = systemProvider().reboot();
    audit(ctx.user.username, 'admin', 'server.reboot', result.ok ? 'requested' : 'failed', ctx.ip);
    return ctx.redirect('/admin?flash=' + encodeURIComponent(result.output) + (result.ok ? '' : '&type=error'));
  });

  /* ------------------------------------------------------------- resellers */
  router.get('/admin/resellers', (ctx) => resellersPage(ctx));
  router.get('/admin/resellers/create', (ctx) => resellerForm(ctx, { path: `${A}/resellers` }));
  router.post('/admin/resellers/create', (ctx) => {
    const username = String(ctx.body.username || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]{1,31}$/.test(username)) return ctx.redirect(`${A}/resellers/create?flash=Invalid%20username&type=error`);
    if (get('SELECT id FROM users WHERE lower(username) = ?', username)) return ctx.redirect(`${A}/resellers/create?flash=Username%20exists&type=error`);
    if (String(ctx.body.password || '').length < 8) return ctx.redirect(`${A}/resellers/create?flash=Password%20too%20short&type=error`);
    const r = run(`INSERT INTO users(username, password, email, level, package, domain, ip, created_at) VALUES(?,?,?,?,?,?,?,?)`,
      username, hashPassword(String(ctx.body.password)), String(ctx.body.email || ''), 'reseller',
      String(ctx.body.package || 'reseller_default'), String(ctx.body.domain || ''), String(ctx.body.ip || setting('server_ip', '')), nowIso());
    audit(ctx.user.username, 'admin', 'reseller.create', username, ctx.ip);
    return ctx.redirect(`${A}/resellers/${r.lastInsertRowid}?flash=Reseller%20created`);
  });
  router.get('/admin/resellers/:id', (ctx) => {
    const r = get("SELECT * FROM users WHERE id = ? AND level = 'reseller'", Number(ctx.params.id));
    if (!r) return ctx.redirect(`${A}/resellers?flash=Not%20found&type=error`);
    return resellerForm(ctx, { path: `${A}/resellers`, existing: r });
  });
  router.post('/admin/resellers/:id', (ctx) => {
    const r = get("SELECT * FROM users WHERE id = ? AND level = 'reseller'", Number(ctx.params.id));
    if (!r) return ctx.redirect(`${A}/resellers?flash=Not%20found&type=error`);
    run('UPDATE users SET email = ?, package = ?, domain = ?, ip = ? WHERE id = ?',
      String(ctx.body.email || r.email), String(ctx.body.package || r.package), String(ctx.body.domain || ''), String(ctx.body.ip || ''), r.id);
    if (ctx.body.password) run('UPDATE users SET password = ? WHERE id = ?', hashPassword(String(ctx.body.password)), r.id);
    return ctx.redirect(`${A}/resellers/${r.id}?flash=Reseller%20updated`);
  });
  router.post('/admin/resellers/:id/suspend', (ctx) => {
    const r = get('SELECT * FROM users WHERE id = ?', Number(ctx.params.id));
    if (r) run('UPDATE users SET suspended = ? WHERE id = ?', r.suspended ? 0 : 1, r.id);
    return ctx.redirect(`${A}/resellers?flash=Updated`);
  });
  router.post('/admin/resellers/:id/delete', (ctx) => {
    run("DELETE FROM users WHERE id = ? AND level = 'reseller'", Number(ctx.params.id));
    return ctx.redirect(`${A}/resellers?flash=Reseller%20deleted`);
  });
  router.get('/admin/reseller-packages', (ctx) => packagesPage(ctx, { type: 'reseller', path: `${A}/reseller-packages` }));
  router.get('/admin/reseller-packages/create', (ctx) => packageForm(ctx, { path: `${A}/reseller-packages`, type: 'reseller' }));
  router.post('/admin/reseller-packages/create', (ctx) => savePackage(ctx, { type: 'reseller', owner: null, path: `${A}/reseller-packages` }));
  router.get('/admin/reseller-packages/:name', (ctx) => {
    const p = get('SELECT * FROM packages WHERE name = ? AND type = ?', ctx.params.name, 'reseller');
    if (!p) return ctx.redirect(`${A}/reseller-packages?flash=Not%20found&type=error`);
    return packageForm(ctx, { path: `${A}/reseller-packages`, type: 'reseller', existing: p });
  });
  router.post('/admin/reseller-packages/:name', (ctx) => savePackage(ctx, { type: 'reseller', owner: null, path: `${A}/reseller-packages` }));
  router.post('/admin/reseller-packages/:name/delete', (ctx) => {
    run('DELETE FROM packages WHERE name = ? AND type = ?', ctx.params.name, 'reseller');
    return ctx.redirect(`${A}/reseller-packages?flash=Package%20deleted`);
  });
  router.post('/admin/reseller-packages/:name/copy', (ctx) => {
    const p = get('SELECT * FROM packages WHERE name = ?', ctx.params.name);
    if (p) run('INSERT INTO packages(name, owner, type, limits, created_at) VALUES(?,?,?,?,?)', `${p.name}_copy${Math.floor(Math.random() * 90 + 10)}`, null, p.type, p.limits, nowIso());
    return ctx.redirect(`${A}/reseller-packages?flash=Package%20copied`);
  });
  router.get('/admin/reseller-statistics', (ctx) => {
    const rows = all("SELECT * FROM users WHERE level = 'reseller' ORDER BY username").map((r) => ({
      ...r,
      users: get("SELECT COUNT(*) n FROM users WHERE owner = ?", r.username).n,
      domains: get('SELECT COUNT(*) n FROM domains WHERE username = ?', r.username).n,
      bw: get('SELECT COALESCE(SUM(bandwidth_mb),0) b FROM usage_daily WHERE username = ?', r.username).b,
    }));
    const body = h`${card('Reseller statistics', h`${table({
      columns: [
        { label: 'Reseller', render: (r) => h`<a class="cell-strong" href="${A}/resellers/${r.id}">${r.username}</a>` },
        { label: 'Package', render: (r) => badge(r.package || '—', 'brand') },
        { label: 'Users', render: (r) => r.users, align: 'right' },
        { label: 'Domains', render: (r) => r.domains, align: 'right' },
        { label: 'Bandwidth', render: (r) => formatBytes(r.bw), align: 'right' },
      ],
      rows, empty: 'No resellers yet.',
    })}`)}`;
    return page(ctx, { title: 'Reseller Statistics', subtitle: 'Usage per reseller', body });
  });

  /* ----------------------------------------------------------------- users */
  router.get('/admin/users', (ctx) => usersPage(ctx, { path: `${A}/users`, level: 'user' }));
  router.get('/admin/users/create', (ctx) => userForm(ctx, { path: `${A}/users`, packages: all("SELECT * FROM packages WHERE type = 'user'") }));
  router.post('/admin/users/create', (ctx) => createUser(ctx, { path: `${A}/users`, level: 'user', owner: ctx.body.owner || null }));
  router.get('/admin/users/move', (ctx) => {
    const users = all("SELECT * FROM users WHERE level = 'user' ORDER BY username");
    const resellers = all("SELECT username FROM users WHERE level = 'reseller'");
    const body = h`${card('Move users between resellers', h`${table({
      columns: [
        { label: 'User', key: 'username' },
        { label: 'Current owner', render: (u) => u.owner || 'admin' },
        { label: 'New owner', render: (u) => h`<form method="post" action="${A}/users/${u.id}/move" class="inline" style="display:flex;gap:6px">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <select name="owner" style="height:30px;width:170px"><option value="">admin</option>${resellers.map((r) => h`<option ${r.username === u.owner ? 'selected' : ''}>${r.username}</option>`)}</select>
          <button class="btn btn-secondary btn-sm" type="submit">Move</button></form>` },
      ],
      rows: users, empty: 'No users',
    })}`)}`;
    return page(ctx, { title: 'Move Users', subtitle: 'Reassign accounts to a reseller', body });
  });
  router.post('/admin/users/:id/move', (ctx) => {
    run('UPDATE users SET owner = ? WHERE id = ? AND level = ?', String(ctx.body.owner || '') || null, Number(ctx.params.id), 'user');
    return ctx.redirect(`${A}/users/move?flash=User%20moved`);
  });
  router.get('/admin/users/:id', (ctx) => {
    const u = get('SELECT * FROM users WHERE id = ?', Number(ctx.params.id));
    if (!u) return ctx.redirect(`${A}/users?flash=Not%20found&type=error`);
    return userDetailPage(ctx, { path: `${A}/users`, target: u });
  });
  router.post('/admin/users/:id', (ctx) => {
    const u = get('SELECT * FROM users WHERE id = ?', Number(ctx.params.id));
    if (!u) return ctx.redirect(`${A}/users?flash=Not%20found&type=error`);
    return updateUser(ctx, { path: `${A}/users`, target: u });
  });
  router.post('/admin/users/:id/suspend', (ctx) => {
    const u = get('SELECT * FROM users WHERE id = ?', Number(ctx.params.id));
    if (!u) return ctx.redirect(`${A}/users?flash=Not%20found&type=error`);
    return toggleSuspend(ctx, { path: `${A}/users`, target: u });
  });
  router.post('/admin/users/:id/delete', (ctx) => {
    const u = get('SELECT * FROM users WHERE id = ?', Number(ctx.params.id));
    if (!u) return ctx.redirect(`${A}/users?flash=Not%20found&type=error`);
    return deleteUser(ctx, { path: `${A}/users`, target: u });
  });
  router.post('/admin/users/:id/login-as', (ctx) => {
    const u = get('SELECT * FROM users WHERE id = ?', Number(ctx.params.id));
    if (!u || u.level === 'admin') return ctx.redirect(`${A}/users?flash=Cannot%20impersonate%20this%20account&type=error`);
    const s = createSession(u, { ip: ctx.ip, ua: ctx.req.headers['user-agent'] });
    ctx.res.setHeader('Set-Cookie', `OA_SESSION=${s.token}; Path=/; HttpOnly; SameSite=Lax`);
    audit(ctx.user.username, 'admin', 'user.impersonate', u.username, ctx.ip);
    return ctx.redirect('/' + u.level + '?flash=' + encodeURIComponent(`Signed in as ${u.username}`));
  });
  router.get('/admin/user-packages', (ctx) => packagesPage(ctx, { type: 'user', path: `${A}/user-packages` }));
  router.get('/admin/user-packages/create', (ctx) => packageForm(ctx, { path: `${A}/user-packages`, type: 'user' }));
  router.post('/admin/user-packages/create', (ctx) => savePackage(ctx, { type: 'user', owner: null, path: `${A}/user-packages` }));
  router.get('/admin/user-packages/:name', (ctx) => {
    const p = get('SELECT * FROM packages WHERE name = ? AND type = ?', ctx.params.name, 'user');
    if (!p) return ctx.redirect(`${A}/user-packages?flash=Not%20found&type=error`);
    return packageForm(ctx, { path: `${A}/user-packages`, type: 'user', existing: p });
  });
  router.post('/admin/user-packages/:name', (ctx) => savePackage(ctx, { type: 'user', owner: null, path: `${A}/user-packages` }));
  router.post('/admin/user-packages/:name/delete', (ctx) => {
    run('DELETE FROM packages WHERE name = ? AND type = ?', ctx.params.name, 'user');
    return ctx.redirect(`${A}/user-packages?flash=Package%20deleted`);
  });
  router.post('/admin/user-packages/:name/copy', (ctx) => {
    const p = get('SELECT * FROM packages WHERE name = ?', ctx.params.name);
    if (p) run('INSERT INTO packages(name, owner, type, limits, created_at) VALUES(?,?,?,?,?)', `${p.name}_copy${Math.floor(Math.random() * 90 + 10)}`, null, p.type, p.limits, nowIso());
    return ctx.redirect(`${A}/user-packages?flash=Package%20copied`);
  });
  router.post('/admin/usage/collect', (ctx) => {
    const result = collectUsage();
    audit(ctx.user.username, 'admin', 'usage.collect', ctx.query.day || 'today', ctx.ip);
    return ctx.redirect(`${A}/user-statistics?flash=` + encodeURIComponent(`Usage collected for ${result.users} users`));
  });

  router.post('/admin/quotas/enforce', (ctx) => {
    const result = enforceAll();
    audit(ctx.user.username, 'admin', 'quota.enforce', `${result.suspended.length} suspended`, ctx.ip);
    return ctx.redirect(`${A}/user-statistics?flash=` + encodeURIComponent(`Checked ${result.checked} account(s), suspended ${result.suspended.length}`));
  });

  router.get('/admin/user-statistics', (ctx) => {
    const rows = all("SELECT * FROM users WHERE level = 'user' ORDER BY username").map((u) => ({
      ...u,
      domains: get('SELECT COUNT(*) n FROM domains WHERE user_id = ?', u.id).n,
      disk: get('SELECT COALESCE(SUM(disk_mb),0) d FROM domains WHERE user_id = ?', u.id).d,
      bw: get('SELECT COALESCE(SUM(bandwidth_mb),0) b FROM usage_daily WHERE username = ?', u.username).b,
    }));
    const meta = usageMeta();
    const body = h`${alert(meta.demo ? 'Demo mode: bandwidth figures in this database are seeded sample data.' : `Usage last collected ${meta.lastCollected || 'never'} · bandwidth source: ${meta.bandwidthSource}`, meta.demo ? 'warn' : 'info')}
      ${card('Quota enforcement', h`<p class="small muted mb-12">Suspends accounts over their package disk or 30-day bandwidth limit. Last run: ${quotaMeta().lastEnforced || 'never'}.</p>
        <form method="post" action="${A}/quotas/enforce"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <button class="btn btn-secondary btn-sm" type="submit">Enforce quotas now</button></form>`)}
      ${card('Collect now', h`<form method="post" action="${A}/usage/collect"><input type="hidden" name="_csrf" value="${ctx.csrf}">
        <p class="small muted mb-12">Recomputes disk usage from account homes and web statistics from the access logs the provider can read.</p>
        <button class="btn btn-primary btn-sm" type="submit">Collect usage</button></form>`)}
      ${usageChartCard(allUsageSeries(30), { title: 'Server bandwidth', sub: 'All users, last 30 days' })}
      ${card('All users', h`${table({
        columns: [
          { label: 'User', render: (u) => h`<a class="cell-strong" href="${A}/users/${u.id}">${u.username}</a>` },
          { label: 'Owner', render: (u) => u.owner || 'admin' },
          { label: 'Package', render: (u) => badge(u.package, 'brand') },
          { label: 'Domains', render: (u) => u.domains, align: 'right' },
          { label: 'Disk', render: (u) => formatBytes(u.disk), align: 'right' },
          { label: 'Bandwidth', render: (u) => formatBytes(u.bw), align: 'right' },
        ],
        rows: rows.sort((a, b) => b.bw - a.bw), empty: 'No users',
      })}`, { padded: false })}`;
    return page(ctx, { title: 'User Statistics', subtitle: 'Resource usage for every account', body });
  });

  /* ------------------------------------------------------------------- IPs */
  router.get('/admin/ip-manager', (ctx) => {
    const ips = all('SELECT * FROM ips ORDER BY ip');
    const body = h`${listCard({
      title: 'IP addresses', sub: `${ips.length} address(es)`,
      columns: [
        { label: 'IP', render: (i) => h`<span class="cell-mono">${i.ip}</span>` },
        { label: 'Netmask', render: (i) => h`<span class="cell-mono">${i.netmask}</span>` },
        { label: 'Status', render: (i) => badge(i.status, i.status === 'free' ? 'muted' : i.status === 'server' ? 'ok' : 'brand') },
        { label: 'Owner', render: (i) => i.owner || '—' },
        { label: 'Note', render: (i) => i.note || '—' },
      ],
      rows: ips,
      actions: [{ label: 'Delete', form: (i) => `${A}/ip-manager/${i.id}/delete`, confirm: 'Remove this IP?', icon: 'trash', danger: true, show: (i) => i.status === 'free' }],
      footer: h`<form method="post" action="${A}/ip-manager/add" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <input name="ip" placeholder="203.0.113.10" style="max-width:180px" required>
        <input name="netmask" value="255.255.255.0" style="max-width:170px">
        <select name="status"><option value="free">Free</option><option value="shared">Shared</option><option value="server">Server</option></select>
        <input name="owner" placeholder="reseller (optional)" style="max-width:180px">
        <button class="btn btn-primary btn-sm" type="submit">${icon('plus', { size: 14 })} Add IP</button>
      </form>`,
    })}`;
    return page(ctx, { title: 'IP Manager', subtitle: 'Server IP pool', body });
  });
  router.post('/admin/ip-manager/add', (ctx) => {
    if (!isIp(ctx.body.ip)) return ctx.redirect(`${A}/ip-manager?flash=Invalid%20IP&type=error`);
    run('INSERT OR IGNORE INTO ips(ip, netmask, status, owner, created_at) VALUES(?,?,?,?,?)',
      String(ctx.body.ip), String(ctx.body.netmask || '255.255.255.0'), String(ctx.body.status || 'free'), String(ctx.body.owner || '') || null, nowIso());
    return ctx.redirect(`${A}/ip-manager?flash=IP%20added`);
  });
  router.post('/admin/ip-manager/:id/delete', (ctx) => {
    run("DELETE FROM ips WHERE id = ? AND status = 'free'", Number(ctx.params.id));
    return ctx.redirect(`${A}/ip-manager?flash=IP%20removed`);
  });

  /* ------------------------------------------------------------------- DNS */
  router.get('/admin/dns', (ctx) => {
    const domains = all('SELECT * FROM domains ORDER BY name');
    const selected = ctx.query.domain || domains[0]?.name;
    const d = domains.find((x) => x.name === selected);
    const records = d ? all('SELECT * FROM dns_records WHERE domain_id = ? ORDER BY type, name', d.id) : [];
    const body = h`
      ${domains.length ? domainSelect(domains, d?.name, { action: `${A}/dns`, label: 'Zone' }) : alert('No domains yet.', 'warn')}
      ${card('Zone files', h`<div class="row">
        <form method="post" action="${A}/dns/rebuild" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <button class="btn btn-secondary btn-sm" type="submit">${icon('refresh', { size: 14 })} Rebuild all zones</button></form>
        <form method="post" action="${A}/dns/deploy" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <button class="btn btn-secondary btn-sm" type="submit">${icon('upload', { size: 14 })} Deploy to DNS server</button></form>
        <span class="small muted">${d ? `Zone: ${zoneMeta(d.name)?.file || 'not generated'}` : ''}</span>
      </div>`, { sub: 'BIND-format zones written to the data directory; deployment requires Linux + root' })}
      ${d ? card(`Zone · ${d.name}`, h`<div class="table-wrap"><table class="data-table">
        <thead><tr><th>Name</th><th>Type</th><th>Value</th><th>Priority</th><th>TTL</th><th></th></tr></thead>
        <tbody>${records.map((r) => h`<tr><td class="cell-mono">${r.name}</td><td>${badge(r.type, 'brand')}</td><td class="cell-mono">${r.value}</td>
          <td>${r.priority ?? '—'}</td><td>${r.ttl}</td>
          <td class="col-actions"><form method="post" action="${A}/dns/${r.id}/delete" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
            <button class="icon-btn danger" type="submit" onclick="return confirm('Delete record?')">${icon('trash', { size: 16 })}</button></form></td></tr>`)}</tbody>
      </table></div>`, { padded: false }) : ''}
      ${d ? card('Add record', h`<form method="post" action="${A}/dns/add" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">
        <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="domain" value="${d.name}">
        <div class="field"><label class="field-label">Name</label><input name="name" value="@" style="width:130px"></div>
        <div class="field"><label class="field-label">Type</label><select name="type" style="width:100px">${['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'].map((t) => h`<option>${t}</option>`)}</select></div>
        <div class="field" style="flex:1;min-width:240px"><label class="field-label">Value</label><input name="value" required></div>
        <div class="field"><label class="field-label">Priority</label><input name="priority" type="number" style="width:90px"></div>
        <button class="btn btn-primary" type="submit">Add</button>
      </form>`) : ''}`;
    return page(ctx, { title: 'DNS Administration', subtitle: 'All zones on the server', body });
  });
  router.post('/admin/dns/rebuild', (ctx) => {
    const result = rebuildAll();
    audit(ctx.user.username, 'admin', 'dns.rebuild', `${result.count} zones`, ctx.ip);
    return ctx.redirect(`${A}/dns?flash=` + encodeURIComponent(`Rebuilt ${result.count} zone(s)` + (result.ok ? '' : ' with warnings')));
  });
  router.post('/admin/dns/deploy', (ctx) => {
    const result = deployZones();
    audit(ctx.user.username, 'admin', 'dns.deploy', result.ok ? 'ok' : 'failed', ctx.ip);
    return ctx.redirect(`${A}/dns?flash=` + encodeURIComponent(result.output) + (result.ok ? '' : '&type=error'));
  });
  router.post('/admin/dns/add', (ctx) => {
    const d = get('SELECT * FROM domains WHERE name = ?', ctx.body.domain);
    if (!d) return ctx.redirect(`${A}/dns?flash=Domain%20not%20found&type=error`);
    run('INSERT INTO dns_records(domain_id, name, type, value, priority, ttl) VALUES(?,?,?,?,?,?)',
      d.id, String(ctx.body.name || '@') || '@', String(ctx.body.type || 'A').toUpperCase(), String(ctx.body.value || ''),
      ctx.body.priority ? Number(ctx.body.priority) : null, 3600);
    return ctx.redirect(`${A}/dns?domain=${encodeURIComponent(d.name)}&flash=Record%20added`);
  });
  router.post('/admin/dns/:id/delete', (ctx) => {
    const r = get('SELECT * FROM dns_records WHERE id = ?', Number(ctx.params.id));
    if (r) run('DELETE FROM dns_records WHERE id = ?', r.id);
    return ctx.redirect(`${A}/dns?flash=Record%20deleted`);
  });

  /* ------------------------------------------------------------ nameservers */
  router.get('/admin/nameservers', (ctx) => {
    const body = h`${card('Nameservers', h`<form method="post" action="${A}/nameservers" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid">
        <div class="field"><label class="field-label">Primary nameserver</label><input name="ns1" value="${setting('ns1', '')}"></div>
        <div class="field"><label class="field-label">Secondary nameserver</label><input name="ns2" value="${setting('ns2', '')}"></div>
        <div class="field"><label class="field-label">Third nameserver (optional)</label><input name="ns3" value="${setting('ns3', '')}"></div>
        <div class="field"><label class="field-label">Default TTL</label><input name="ttl" value="${setting('dns_ttl', '3600')}"></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Save nameservers</button></div>
    </form>`)}
    ${card('Glue records', h`<p class="small muted">Register these at your domain registrar so the nameservers resolve:</p>
      <pre class="code-block">${setting('ns1', 'ns1')}.   3600  IN  A  ${setting('server_ip', '127.0.0.1')}
${setting('ns2', 'ns2')}.   3600  IN  A  ${setting('server_ip', '127.0.0.1')}</pre>`)}`;
    return page(ctx, { title: 'Nameservers', subtitle: 'DNS infrastructure settings', body });
  });
  router.post('/admin/nameservers', (ctx) => {
    for (const k of ['ns1', 'ns2', 'ns3', 'ttl']) if (ctx.body[k] !== undefined) setSetting(k === 'ttl' ? 'dns_ttl' : k, String(ctx.body[k]));
    return ctx.redirect(`${A}/nameservers?flash=Nameservers%20saved`);
  });

  /* ------------------------------------------------------------------- SSL */
  router.get('/admin/ssl', (ctx) => {
    const certs = all('SELECT * FROM ssl_certs ORDER BY domain');
    const body = h`${alert('The panel itself runs with a self-signed certificate by default. Install a trusted certificate for the hostname to remove browser warnings.', 'info')}
      ${listCard({
        title: 'Server certificates', sub: `${certs.length} certificate(s) across all domains`,
        columns: [
          { label: 'Domain', render: (c) => h`<span class="cell-strong">${c.domain}</span>` },
          { label: 'Type', render: (c) => badge(c.type, 'brand') },
          { label: 'Expires', render: (c) => formatDate(c.expires_at) },
          { label: 'Status', render: (c) => badge(c.status, 'ok') },
        ],
        rows: certs, empty: 'No certificates.',
      })}
      ${card('Panel certificate', h`<form method="post" action="${A}/ssl/panel" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field field-full"><label class="field-label">Certificate (PEM)</label><textarea name="cert" rows="6"></textarea></div>
          <div class="field field-full"><label class="field-label">Private key (PEM)</label><textarea name="key" rows="6"></textarea></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Install panel certificate</button></div>
      </form>`)}`;
    return page(ctx, { title: 'Server SSL', subtitle: 'Certificates for services and the panel', body });
  });
  router.post('/admin/ssl/panel', (ctx) => ctx.redirect(`${A}/ssl?flash=Panel%20certificate%20queued%20for%20install`));

  /* ----------------------------------------------------------------- skins */
  router.get('/admin/skins', (ctx) => {
    const body = h`${card('Skins & themes', h`<form method="post" action="${A}/skins" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid">
        <div class="field"><label class="field-label">Default skin</label><select name="default_skin">
          <option value="evolution" ${setting('default_skin', 'evolution') === 'evolution' ? 'selected' : ''}>Evolution (modern)</option>
          <option value="enhanced" ${setting('default_skin') === 'enhanced' ? 'selected' : ''}>Enhanced (classic)</option>
        </select></div>
        <div class="field"><label class="field-label">Your skin</label><select name="my_skin">
          <option value="evolution" ${ctx.user.skin === 'evolution' ? 'selected' : ''}>Evolution (modern)</option>
          <option value="enhanced" ${ctx.user.skin === 'enhanced' ? 'selected' : ''}>Enhanced (classic)</option>
        </select></div>
        <div class="field"><label class="field-label">Accent colour</label><input type="color" name="accent" value="#0a6daa" style="height:38px"></div>
        <div class="field"><label class="field-label">Login page message</label><input name="login_message" value="${setting('login_page_message', '')}"></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Save appearance</button></div>
    </form>`)}
    ${card('Preview', h`<div class="grid grid-2">
      <div class="skin-preview evolution"><strong>Evolution</strong><p class="small muted">Modern cards, soft shadows, rounded corners, collapsible sidebar.</p></div>
      <div class="skin-preview enhanced"><strong>Enhanced</strong><p class="small muted">Classic DirectAdmin look: dense tables, square corners, blue headers.</p></div>
    </div>`)}`;
    return page(ctx, { title: 'Skins & Themes', subtitle: 'Panel appearance', body });
  });
  router.post('/admin/skins', (ctx) => {
    if (ctx.body.default_skin) setSetting('default_skin', String(ctx.body.default_skin));
    if (ctx.body.login_message !== undefined) setSetting('login_page_message', String(ctx.body.login_message));
    if (ctx.body.my_skin) run('UPDATE users SET skin = ? WHERE id = ?', String(ctx.body.my_skin), ctx.user.id);
    return ctx.redirect(`${A}/skins?flash=Appearance%20saved`);
  });

  /* --------------------------------------------------------------- plugins */
  router.get('/admin/plugins', (ctx) => {
    const rows = pluginInventory();
    const body = h`${listCard({
      title: 'Plugins', sub: `${rows.filter((r) => r.enabled).length} enabled`,
      columns: [
        { label: 'Plugin', render: (p) => h`<span class="cell-strong">${p.title || p.name}</span><span class="cell-sub">${p.description || ''}</span>` },
        { label: 'Level', render: (p) => badge(p.level, 'brand') },
        { label: 'Version', key: 'version' },
        { label: 'Hook', render: (p) => (p.hasHook ? badge('hook.js', 'ok') : badge('no hook', 'muted')) },
        { label: 'Status', render: (p) => (p.enabled ? badge('Enabled', 'ok') : badge('Disabled', 'muted')) },
      ],
      rows,
      actions: [
        { label: 'Toggle', form: (p) => `${A}/plugins/${p.id}/toggle`, icon: 'refresh' },
        { label: 'Remove', form: (p) => `${A}/plugins/${p.id}/delete`, confirm: 'Remove plugin?', icon: 'trash', danger: true },
      ],
      footer: h`<form method="post" action="${A}/plugins/add" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <input name="name" placeholder="plugin-name" style="max-width:180px" required>
        <input name="title" placeholder="Display name" style="max-width:180px">
        <select name="level"><option>user</option><option>reseller</option><option>admin</option></select>
        <input name="description" placeholder="Description" style="flex:1;min-width:200px">
        <button class="btn btn-primary btn-sm" type="submit">${icon('plus', { size: 14 })} Install plugin</button>
      </form>`,
    })}${card('Hook contract', h`<p class="small muted">Place a plugin under <code>${config.dataDir}/plugins/&lt;name&gt;/hook.js</code>. It is executed with Node for events such as <code>user.create</code>, <code>domain.create</code> and <code>email.create</code>; the event payload arrives as JSON on stdin and the event name as the first argument. Output is appended to <code>hook.log</code>.</p>
      <pre class="code-block">process.stdin.on('data', (b) => { const { event, payload } = JSON.parse(b); ... });</pre>`)}`;
    return page(ctx, { title: 'Plugins', subtitle: 'Extend the panel with hooks and custom pages', body });
  });
  router.post('/admin/plugins/add', (ctx) => {
    const name = String(ctx.body.name || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (name) run('INSERT OR IGNORE INTO plugins(name, title, level, version, enabled, description, created_at) VALUES(?,?,?,?,?,?,?)',
      name, String(ctx.body.title || name), String(ctx.body.level || 'user'), '1.0.0', 1, String(ctx.body.description || ''), nowIso());
    return ctx.redirect(`${A}/plugins?flash=Plugin%20installed`);
  });
  router.post('/admin/plugins/:id/toggle', (ctx) => {
    const p = get('SELECT * FROM plugins WHERE id = ?', Number(ctx.params.id));
    if (p) run('UPDATE plugins SET enabled = ? WHERE id = ?', p.enabled ? 0 : 1, p.id);
    return ctx.redirect(`${A}/plugins?flash=Plugin%20updated`);
  });
  router.post('/admin/plugins/:id/delete', (ctx) => {
    run('DELETE FROM plugins WHERE id = ?', Number(ctx.params.id));
    return ctx.redirect(`${A}/plugins?flash=Plugin%20removed`);
  });

  /* ------------------------------------------------------------- templates */
  router.get('/admin/templates', (ctx) => {
    const templates = ['header.html', 'footer.html', 'login.html'];
    const body = h`${card('Templates', h`${table({
      columns: [
        { label: 'Template', render: (t) => h`<span class="cell-mono">${t}</span>` },
        { label: 'Applied to', render: (t) => (t === 'header.html' ? 'panel pages (top)' : t === 'footer.html' ? 'panel pages (bottom)' : 'sign-in page') },
        { label: 'Overridden', render: (t) => (get('SELECT value FROM settings WHERE key = ?', `template:${t}`) ? badge('yes', 'warn') : badge('default', 'muted')) },
      ],
      rows: templates.map((t) => ({ t })),
      actions: [{ label: 'Edit', href: (t) => `${A}/templates/${encodeURIComponent(t.t)}`, icon: 'edit' }],
    })}`, { sub: 'HTML templates can be overridden per skin; changes are stored in the panel database' })}`;
    return page(ctx, { title: 'Templates', subtitle: 'Customise panel markup', body });
  });
  router.get('/admin/templates/:name', (ctx) => {
    const name = ctx.params.name;
    const current = get('SELECT value FROM settings WHERE key = ?', `template:${name}`)?.value || '';
    const body = h`${card(`Edit template · ${name}`, h`<form method="post" action="${A}/templates/${encodeURIComponent(name)}" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <textarea name="content" rows="20" class="code-editor">${current}</textarea>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Save template</button>
        <a class="btn btn-ghost" href="${A}/templates">Back</a></div></form>`)}`;
    return page(ctx, { title: name, subtitle: 'Template editor', body });
  });
  router.post('/admin/templates/:name', (ctx) => {
    setSetting(`template:${ctx.params.name}`, String(ctx.body.content || ''));
    return ctx.redirect(`${A}/templates?flash=Template%20saved`);
  });

  /* ----------------------------------------------------------- custom httpd */
  router.get('/admin/custom-httpd', (ctx) => {
    const domains = all('SELECT * FROM domains ORDER BY name');
    const selected = ctx.query.domain || domains[0]?.name;
    const snippet = selected ? setting(`httpd:${selected}`, '') : '';
    const body = h`${domains.length ? domainSelect(domains, selected, { action: `${A}/custom-httpd` }) : ''}
      ${selected ? card(`Custom HTTPD configuration · ${selected}`, h`<form method="post" action="${A}/custom-httpd" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="domain" value="${selected}">
        <p class="small muted mb-12">Included inside the &lt;VirtualHost&gt; block. Supports Apache and nginx directives.</p>
        <textarea name="config" rows="14" class="code-editor" placeholder="# e.g.&#10;Header always set X-Frame-Options &quot;SAMEORIGIN&quot;">${snippet}</textarea>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save configuration</button></div>
      </form>`) : emptyState('No domains')}`;
    return page(ctx, { title: 'Custom HTTPD', subtitle: 'Per-domain web server configuration', body });
  });
  router.post('/admin/custom-httpd', (ctx) => {
    setSetting(`httpd:${ctx.body.domain}`, String(ctx.body.config || ''));
    return ctx.redirect(`${A}/custom-httpd?domain=${encodeURIComponent(ctx.body.domain)}&flash=Configuration%20saved`);
  });

  /* --------------------------------------------------------------- backups */
  router.get('/admin/backups', (ctx) => {
    const rows = all('SELECT b.*, u.username FROM backups b JOIN users u ON u.id = b.user_id ORDER BY b.created_at DESC LIMIT 100');
    const body = h`
      <div class="grid grid-2">
        ${card('Create server backup', h`<p class="small muted mb-18">A server backup archives every account, domain, mailbox and database. Free and unlimited.</p>
          <form method="post" action="${A}/backups/create" class="row"><input type="hidden" name="_csrf" value="${ctx.csrf}">
            <select name="scope"><option value="all">All accounts</option><option value="users">Users only</option><option value="resellers">Resellers only</option></select>
            <button class="btn btn-primary" type="submit">${icon('archive', { size: 16 })} Create backup</button></form>`)}
        ${card('Destinations', h`${kvList([
          ['Local storage', config.dataDir + '/backups'],
          ['Remote (SFTP)', 'Not configured'],
          ['Retention', '30 days'],
          ['Schedule', 'Daily at 03:00'],
        ])}`)}
      </div>
      ${listCard({
        title: 'Backups', sub: `${rows.length} archive(s)`,
        columns: [
          { label: 'Account', render: (b) => b.username },
          { label: 'File', render: (b) => h`<span class="cell-mono">${b.filename}</span>` },
          { label: 'Size', render: (b) => formatBytes(b.size_mb), align: 'right' },
          { label: 'Created', render: (b) => formatDate(b.created_at, { time: true }) },
          { label: 'Status', render: (b) => badge(b.status, 'ok') },
        ],
        rows, empty: 'No backups yet.',
      })}`;
    return page(ctx, { title: 'Backup / Restore', subtitle: 'Server-wide backup management', body });
  });
  router.post('/admin/backups/create', (ctx) => {
    try {
      const result = createServerBackup(ctx.user, String(ctx.body.scope || 'all'));
      audit(ctx.user.username, 'admin', 'backup.server', result.filename, ctx.ip);
      return ctx.redirect(`${A}/backups?flash=` + encodeURIComponent(`Server backup ${result.filename} created (${result.size} MB)`));
    } catch (e) {
      return ctx.redirect(`${A}/backups?flash=` + encodeURIComponent('Backup failed: ' + e.message) + '&type=error');
    }
  });

  /* --------------------------------------------------------------- tickets */
  router.get('/admin/tickets', (ctx) => {
    const rows = all('SELECT * FROM tickets ORDER BY created_at DESC');
    const body = h`${listCard({
      title: 'Support tickets', sub: `${rows.filter((r) => r.status !== 'closed').length} open`,
      columns: [
        { label: 'Subject', render: (t) => h`<a class="cell-strong" href="${A}/tickets/${t.id}">${t.subject}</a><span class="cell-sub">#${t.id} · ${t.username}</span>` },
        { label: 'Department', render: (t) => badge(t.department, 'muted') },
        { label: 'Priority', render: (t) => badge(t.priority, t.priority === 'high' ? 'danger' : 'brand') },
        { label: 'Status', render: (t) => badge(t.status, t.status === 'open' ? 'brand' : t.status === 'closed' ? 'muted' : 'ok') },
        { label: 'Updated', render: (t) => timeAgo(t.updated_at) },
      ],
      rows, empty: 'No tickets.',
    })}`;
    return page(ctx, { title: 'Support Tickets', subtitle: 'All tickets on the server', body });
  });
  router.get('/admin/tickets/:id', (ctx) => {
    const t = get('SELECT * FROM tickets WHERE id = ?', Number(ctx.params.id));
    if (!t) return ctx.redirect(`${A}/tickets?flash=Not%20found&type=error`);
    const msgs = all('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at', t.id);
    const body = h`${card(t.subject, h`
      <div class="spread mb-18"><div class="row">${badge('#' + t.id, 'muted')}${badge(t.username, 'brand')}${badge(t.priority, 'brand')}${badge(t.status, 'ok')}</div>
        <span class="small muted">${formatDate(t.created_at, { time: true })}</span></div>
      <div class="ticket-thread">${msgs.map((m) => h`<div class="ticket-msg ${m.level === 'user' ? 'user' : 'staff'}">
        <div class="ticket-head"><strong>${m.author}</strong><span class="small muted">${formatDate(m.created_at, { time: true })}</span></div>
        <div class="ticket-body">${m.body}</div></div>`)}</div>
      <form method="post" action="${A}/tickets/${t.id}/reply" class="oa-form mt-18"><input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="field field-full"><label class="field-label">Reply</label><textarea name="message" rows="5" required></textarea></div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Send reply</button>
          <button class="btn btn-ghost" type="submit" formaction="${A}/tickets/${t.id}/close">Close</button></div></form>`)}`;
    return page(ctx, { title: 'Ticket #' + t.id, subtitle: t.subject, body });
  });
  router.post('/admin/tickets/:id/reply', (ctx) => {
    const t = get('SELECT * FROM tickets WHERE id = ?', Number(ctx.params.id));
    if (t && String(ctx.body.message || '').trim()) {
      run('INSERT INTO ticket_messages(ticket_id, author, level, body, created_at) VALUES(?,?,?,?,?)', t.id, ctx.user.username, 'admin', String(ctx.body.message), nowIso());
      run('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?', 'answered', nowIso(), t.id);
    }
    return ctx.redirect(`${A}/tickets/${ctx.params.id}?flash=Reply%20sent`);
  });
  router.post('/admin/tickets/:id/close', (ctx) => {
    run("UPDATE tickets SET status = 'closed', updated_at = ? WHERE id = ?", nowIso(), Number(ctx.params.id));
    return ctx.redirect(`${A}/tickets/${ctx.params.id}?flash=Closed`);
  });

  /* -------------------------------------------------------------- messages */
  router.get('/admin/messages', (ctx) => {
    const rows = all('SELECT * FROM messages ORDER BY created_at DESC LIMIT 50');
    const users = all('SELECT username FROM users ORDER BY username');
    const body = h`
      ${card('Send a message', h`<form method="post" action="${A}/messages/send" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Recipient</label><select name="username">
            <option value="">All users</option>${users.map((u) => h`<option>${u.username}</option>`)}</select></div>
          <div class="field"><label class="field-label">Level</label><select name="level"><option value="">auto</option><option value="admin">admin</option><option value="reseller">reseller</option><option value="user">user</option></select></div>
          <div class="field field-full"><label class="field-label">Subject</label><input name="subject" required></div>
          <div class="field field-full"><label class="field-label">Message</label><textarea name="body" rows="5" required></textarea></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('bell', { size: 16 })} Send message</button></div>
      </form>`)}
      ${card('Sent messages', h`${table({
        columns: [
          { label: 'To', render: (m) => m.username || 'all' },
          { label: 'Level', render: (m) => badge(m.level, 'brand') },
          { label: 'Subject', key: 'subject' },
          { label: 'Sent', render: (m) => formatDate(m.created_at, { time: true }) },
          { label: 'Read', render: (m) => (m.read_at ? badge('yes', 'ok') : badge('no', 'muted')) },
        ],
        rows, empty: 'No messages sent.',
      })}`)}`;
    return page(ctx, { title: 'Message System', subtitle: 'Send notices to accounts', body });
  });
  router.post('/admin/messages/send', (ctx) => {
    run('INSERT INTO messages(level, username, subject, body, created_at) VALUES(?,?,?,?,?)',
      String(ctx.body.level || 'user'), String(ctx.body.username || '') || null, String(ctx.body.subject), String(ctx.body.body), nowIso());
    audit(ctx.user.username, 'admin', 'message.send', String(ctx.body.username || 'all'), ctx.ip);
    return ctx.redirect(`${A}/messages?flash=Message%20sent`);
  });

  /* -------------------------------------------------------------- audit log */
  router.get('/admin/audit-log', (ctx) => {
    const rows = all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300');
    const body = h`${card('Audit log', h`${table({
      columns: [
        { label: 'Time', render: (r) => h`<span class="small">${formatDate(r.created_at, { time: true })}</span>` },
        { label: 'Actor', key: 'actor' },
        { label: 'Level', render: (r) => badge(r.level, 'brand') },
        { label: 'Action', render: (r) => h`<span class="cell-mono">${r.action}</span>` },
        { label: 'Target', render: (r) => r.target || '—' },
        { label: 'IP', render: (r) => h`<span class="cell-mono small">${r.ip || '—'}</span>` },
      ],
      rows, empty: 'No activity yet.',
    })}`, { sub: 'Every privileged action is recorded here' })}`;
    return page(ctx, { title: 'Audit Log', subtitle: 'Chronological record of panel actions', body, wide: true });
  });

  /* ------------------------------------------------------------ file editor */
  router.get('/admin/file-editor', (ctx) => {
    const targets = editorTargets();
    const selected = ctx.query.file && targets.some((t) => t.path === ctx.query.file) ? ctx.query.file : targets[0]?.path;
    const file = selected ? readTarget(selected) : { ok: false, error: 'No editable files found' };
    const body = h`${card('File editor', h`
      ${!file.ok ? alert(file.error, 'error') : h`
      <div class="row mb-12" style="flex-wrap:wrap">${targets.slice(0, 24).map((t) => h`<a class="chip ${t.path === selected ? 'active' : ''}" href="${A}/file-editor?file=${encodeURIComponent(t.path)}">${t.label}</a>`)}</div>
      <form method="post" action="${A}/file-editor" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="file" value="${selected}">
        <p class="small muted mb-12"><code>${selected}</code> · ${file.writable ? 'writable' : 'read-only'} · ${file.bytes} bytes · modified ${file.mtime}</p>
        <textarea name="content" rows="22" class="code-editor" ${file.writable ? '' : 'readonly'}>${file.content}</textarea>
        <div class="form-actions"><button class="btn btn-primary" type="submit" ${file.writable ? '' : 'disabled'}>${icon('save', { size: 16 })} Save file</button>
          <span class="small muted">A timestamped backup is written and the syntax is validated before saving.</span></div>
      </form>`}
      `, { padded: true, sub: 'Panel-managed files everywhere; /etc files with Linux + root' })}`;
    return page(ctx, { title: 'File Editor', subtitle: 'Edit real server configuration files', body, wide: true });
  });
  router.post('/admin/file-editor', (ctx) => {
    const result = saveTarget(String(ctx.body.file || ''), String(ctx.body.content || ''));
    audit(ctx.user.username, 'admin', 'file.edit', `${ctx.body.file}: ${result.ok ? 'ok' : 'rejected'}`, ctx.ip);
    return ctx.redirect(`${A}/file-editor?file=${encodeURIComponent(ctx.body.file)}&flash=` + encodeURIComponent(result.ok ? 'File saved and validated' : result.error) + (result.ok ? '' : '&type=error'));
  });

  /* ------------------------------------------------------------------ cron */
  router.get('/admin/cron', (ctx) => {
    const rows = all("SELECT c.*, u.username FROM cron_jobs c JOIN users u ON u.id = c.user_id ORDER BY c.id DESC LIMIT 100");
    const body = h`${card('System cron', h`${table({
      columns: [
        { label: 'User', render: (c) => c.username },
        { label: 'Schedule', render: (c) => h`<span class="cell-mono">${[c.minute, c.hour, c.day, c.month, c.weekday].join(' ')}</span>` },
        { label: 'Command', render: (c) => h`<span class="cell-mono truncate" style="max-width:460px;display:block">${c.command}</span>` },
      ],
      rows, empty: 'No cron jobs on the server.',
    })}`, { sub: 'All user cron jobs, aggregated' })}
    ${card('Panel maintenance', h`<pre class="code-block">0 3 * * *   /usr/local/openadmin/bin/openadmin backup --all
*/5 * * * * /usr/local/openadmin/bin/openadmin heartbeat
0 4 * * 0   /usr/local/openadmin/bin/openadmin cleanup --logs 30</pre>`)}`;
    return page(ctx, { title: 'System Cron', subtitle: 'Scheduled jobs across accounts', body });
  });

  /* --------------------------------------------------------- brute force */
  router.get('/admin/brute-force', (ctx) => {
    const rows = all(`SELECT ip, COUNT(*) attempts, MAX(created_at) last, GROUP_CONCAT(DISTINCT username) users
                      FROM login_attempts GROUP BY ip ORDER BY attempts DESC LIMIT 50`);
    const body = h`${alert('Failed logins are tracked for 24 hours. Blocked IPs are rejected before the password is checked.', 'info')}
      ${card('Failed login attempts', h`${table({
        columns: [
          { label: 'IP address', render: (r) => h`<span class="cell-mono">${r.ip || '—'}</span>` },
          { label: 'Attempts', render: (r) => r.attempts },
          { label: 'Usernames tried', render: (r) => h`<span class="small">${r.users || '—'}</span>` },
          { label: 'Last attempt', render: (r) => timeAgo(r.last) },
        ],
        rows, empty: 'No failed logins recorded.',
        actions: [{ label: 'Clear', form: (r) => `${A}/brute-force/clear?ip=${encodeURIComponent(r.ip || '')}`, icon: 'x' }],
      })}`)}`;
    return page(ctx, { title: 'Brute Force Monitor', subtitle: 'Track and block abusive IPs', body });
  });
  router.post('/admin/brute-force/clear', (ctx) => {
    run('DELETE FROM login_attempts WHERE ip = ?', ctx.query.ip);
    return ctx.redirect(`${A}/brute-force?flash=Entries%20cleared`);
  });
  void transaction; void limitsFor; void domainFor; void sparkline; void resellerForm;
}

function serviceMeta(name) {
  return {
    httpd: 'Apache 2.4 · port 80/443', nginx: 'reverse proxy · port 8080', exim: 'SMTP 25/587', dovecot: 'IMAP/POP3 143/993',
    mysqld: 'MariaDB · port 3306', bind: 'BIND · port 53', proftpd: 'FTP 21', 'php-fpm': 'PHP FastCGI', redis: 'cache · 6379', cron: 'scheduler',
  }[name] || '';
}

function defaultConfig(file) {
  if (file.includes('nginx')) return 'user  www-data;\nworker_processes auto;\nevents { worker_connections 1024; }\nhttp {\n  include /etc/nginx/mime.types;\n  include /etc/nginx/conf.d/*.conf;\n}';
  if (file.includes('httpd')) return 'ServerRoot "/etc/httpd"\nListen 80\nServerName localhost\nInclude conf.d/*.conf';
  if (file.includes('exim')) return 'primary_hostname = ' + setting('server_name', 'localhost') + '\nlocal_interfaces = 0.0.0.0\n';
  if (file.includes('dovecot')) return 'protocols = imap pop3 lmtp\nmail_location = maildir:~/Maildir';
  if (file.includes('named')) return 'options {\n  directory "/var/named";\n  recursion no;\n};';
  if (file.includes('php.ini')) return 'memory_limit = 256M\nupload_max_filesize = 64M\npost_max_size = 64M\nmax_execution_time = 60';
  return '# log file (read only in demo)\n';
}
