// Admin page for web server selection, vhost generation and deployment.
import fs from 'node:fs';
import path from 'node:path';
import { runPreflight } from '../preflight.mjs';
import { all, get, setting, setSetting, audit } from '../db.mjs';
import { html as h, formatDate } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, btn, badge, alert, emptyState, kvList } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { listCard } from '../ui/pages/list.mjs';
import { SERVERS, activeServer, detect, generateAll, validate, deploy, stagingDir } from '../webserver.mjs';
import { engineChoices, phpVersions } from '../provisioning.mjs';

export { engineChoices, phpVersions };

/* Shared site-provisioning UI used by the wizard and the domain pages. The
 * availability data comes from real binary/service detection in
 * engineChoices(); nothing here assumes which stack is installed. */
export function enginePicker({ selected = '', name = 'engine' } = {}) {
  const choices = engineChoices();
  const preferred = choices.find((c) => c.id === selected && c.available)
    || choices.find((c) => c.active && c.available)
    || choices.find((c) => c.available);
  return h`<div class="grid grid-2" data-engine-picker>
    ${choices.map((c) => h`<label class="service-row u-s1" data-engine-card="${c.id}" data-engine-available="${c.available ? '1' : '0'}">
      <input type="radio" name="${name}" value="${c.id}" ${preferred?.id === c.id ? 'checked' : ''} ${c.available ? '' : 'disabled'} data-engine-radio>
      <span class="service-dot ${c.installed ? 'on' : 'off'} u-s19"></span>
      <span class="u-s20">
        <strong class="u-s21">${c.label}</strong>
        <span class="small muted">${c.reason}</span>
      </span>
      <span class="u-s22">
        ${c.active ? badge('default', 'brand') : ''}
        ${c.installed ? badge('detected', 'ok') : c.sandbox ? badge('sandbox', 'warn') : badge('unavailable', 'muted')}
      </span>
    </label>`)}
  </div>
  <p class="field-help u-s23">Availability is read from real binary/service detection. “Sandbox” means the configuration is staged instead of reloading a live service.</p>`;
}

export function sslModeSelect({ selected = 'selfsigned', name = 'ssl_mode', includeKeep = false, id = 'ssl_mode' } = {}) {
  const options = [
    ...(includeKeep ? [{ value: 'keep', label: 'Keep current certificate setting' }] : []),
    { value: 'selfsigned', label: 'Self-signed — works immediately (browser warning)' },
    { value: 'letsencrypt', label: "Let's Encrypt — requires public DNS (self-signed fallback)" },
    { value: 'none', label: 'No SSL (HTTP only)' },
  ];
  return h`<select id="${id}" name="${name}">${options.map((o) => h`<option value="${o.value}" ${o.value === selected ? 'selected' : ''}>${o.label}</option>`)}</select>`;
}

export function provisioningSteps(steps = []) {
  if (!steps.length) return h`<p class="small muted">No provisioning steps were recorded.</p>`;
  return h`<ol class="doc-list">${steps.map((s) => h`<li data-step="${s.key || ''}">
    <div class="spread">
      <strong>${s.label || s.key || 'Step'}</strong>
      ${s.ok
        ? (s.skipped ? badge('skipped', 'muted') : badge('OK', 'ok'))
        : badge('failed', 'danger')}
    </div>
    <div class="small muted">${s.detail || ''}</div>
    ${Array.isArray(s.subdomains) && s.subdomains.length ? h`<ul class="doc-list u-s24">${s.subdomains.map((sub) => h`<li>${sub.ok ? badge('OK', 'ok') : badge('failed', 'danger')} ${sub.detail || sub.label}</li>`)}</ul>` : ''}
  </li>`)}</ol>`;
}


function serverRow(ctx, id, info, active) {
  return h`<div class="service-row">
    <span class="service-dot ${info.installed ? 'on' : 'off'}"></span>
    <strong>${info.label}</strong>
    <span class="small muted">${info.installed ? `${info.binary.path}${info.binary.version ? ' · ' + info.binary.version : ''}` : 'not detected on this host'}</span>
    <div class="u-s25">
      ${active === id ? badge('active', 'brand') : ''}
      ${info.installed ? (info.service ? badge(info.service.status, info.service.status === 'running' ? 'ok' : 'muted', { dot: true }) : badge('no service', 'muted')) : badge('not installed', 'muted')}
      <form method="post" action="/admin/web-server/active" class="inline">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <input type="hidden" name="server" value="${id}">
        <button class="btn btn-secondary btn-sm" type="submit" ${active === id ? 'disabled' : ''}>Use</button>
      </form>
    </div>
  </div>`;
}

export function register(router) {
  router.get('/admin/web-server', (ctx) => {
    const detected = detect();
    const active = activeServer();
    const generatedAt = setting('webconfig_generated_at', '');
    const phpHandler = setting('php_handler', 'php-fpm');
    const domains = all('SELECT * FROM domains ORDER BY name');
    const files = [];
    for (const [id, info] of Object.entries(detected)) {
      const dir = path.join(stagingDir(info), 'sites');
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.conf')) continue;
        const full = path.join(dir, f);
        files.push({ server: id, name: f, size: fs.statSync(full).size, path: full });
      }
    }
    const body = h`
      ${alert('One panel manages all four stacks. Choose the active web server, generate vhosts for every domain, validate the syntax and deploy to the system directories when running as root on Linux.', 'info')}
      ${card('Web servers', h`${Object.entries(detected).map(([id, info]) => serverRow(ctx, id, info, active.id))}`,
        { sub: 'Detection reads the real binaries and service state', actions: [h`<a class="link small" href="/admin/web-server">Re-detect</a>`] })}
      <div class="grid grid-2">
        ${card('PHP handler', h`<form method="post" action="/admin/web-server/php" class="oa-form">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <div class="form-grid">
            <div class="field"><label class="field-label">Handler</label><select name="handler">
              <option value="php-fpm" ${phpHandler === 'php-fpm' ? 'selected' : ''}>PHP-FPM socket (recommended)</option>
              <option value="proxy" ${phpHandler === 'proxy' ? 'selected' : ''}>Reverse proxy to :8080</option>
            </select></div>
            <div class="field"><label class="field-label">FPM socket</label><input value="/run/php/php-fpm-&lt;user&gt;.sock" disabled></div>
          </div>
          <div class="form-actions"><button class="btn btn-primary" type="submit">Save handler</button></div>
        </form>`)}
        ${card('Configuration', h`${kvList([
          ['Active server', active.label],
          ['Last generated', generatedAt ? formatDate(generatedAt, { time: true }) : 'never'],
          ['Generated files', String(files.length)],
          ['Staging directory', stagingDir(active)],
        ])}
        <div class="row mt-18">
          <form method="post" action="/admin/web-server/generate" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
            <button class="btn btn-primary btn-sm" type="submit">${icon('refresh', { size: 14 })} Generate vhosts</button></form>
          <form method="post" action="/admin/web-server/test" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
            <button class="btn btn-secondary btn-sm" type="submit">${icon('check', { size: 14 })} Validate</button></form>
          <form method="post" action="/admin/web-server/deploy" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
            <button class="btn btn-secondary btn-sm" type="submit" data-confirm="Wdrożyć do katalogów systemowych i przeładować usługi?">${icon('upload', { size: 14 })} Deploy</button></form>
        </div>`)}
      </div>
      ${ctx.query.output ? card('Validation output', h`<pre class="code-block">${ctx.query.output}</pre>`) : ''}
      ${listCard({
        title: 'Generated configuration', sub: `${files.length} file(s) across all stacks`, 
        columns: [
          { label: 'Domain file', render: (f) => h`<span class="cell-mono">${f.name}</span><span class="cell-sub">${f.server}</span>` },
          { label: 'Size', render: (f) => `${f.size} B`, align: 'right' },
          { label: 'Path', render: (f) => h`<span class="small muted">${f.path}</span>` },
        ],
        rows: files,
        empty: 'No configuration generated yet. Use “Generate vhosts”.',
        actions: [{ label: 'View', href: (f) => `/admin/web-server/view?file=${encodeURIComponent(path.join(f.server, f.name))}`, icon: 'eye' }],
      })}
      ${card('Per-domain web server', h`
        <p class="small muted mb-12">Override the active server for individual domains. Generation then writes that domain to the selected stack.</p>
        <form method="post" action="/admin/web-server/domains" class="oa-form">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <div class="form-grid">${domains.map((d) => h`<div class="field"><label class="field-label">${d.name}</label>
            <select name="server_${d.name}">
              <option value="">inherit (${active.label})</option>
              ${Object.values(SERVERS).map((s) => h`<option value="${s.id}" ${setting(`web_server:${d.name}`, '') === s.id ? 'selected' : ''}>${s.label}</option>`)}
            </select></div>`)}</div>
          <div class="form-actions"><button class="btn btn-primary" type="submit">Save overrides</button></div>
        </form>`, { sub: `${domains.length} domain(s)` })}
      ${detected.litespeed ? card('LiteSpeed Enterprise license', h`${kvList([
        ['Edition', 'Enterprise'],
        ['License key', setting('litespeed_license', '') ? 'configured' : 'not configured'],
        ['Serial', setting('litespeed_serial', '—')],
      ])}
      <form method="post" action="/admin/web-server/litespeed" class="row mt-18"><input type="hidden" name="_csrf" value="${ctx.csrf}">
        <input class="u-s14" name="license" placeholder="License key" value="${setting('litespeed_license', '')}">
        <input class="u-s26" name="serial" placeholder="Serial number" value="${setting('litespeed_serial', '')}">
        <button class="btn btn-primary" type="submit">Save license</button>
      </form>`) : ''}`;
    return page(ctx, { title: 'Web Server', subtitle: 'Nginx, Apache, OpenLiteSpeed and LiteSpeed Enterprise', body });
  });

  router.post('/admin/web-server/active', async (ctx) => {
    const id = String(ctx.body.server);
    if (!SERVERS[id]) return ctx.redirect('/admin/web-server?flash=Unknown%20server&type=error');
    const pre = await runPreflight('web-engine', { engine: id });
    if (pre.blocked) return ctx.redirect(`/admin/web-server?flash=${encodeURIComponent(`Preflight zablokował przełączenie: ${pre.checks.filter((c) => !c.ok && c.blocking).map((c) => c.label).join(', ')}`)}&type=error`);
    setSetting('web_server', id);
    generateAll(id);
    const deployed = deploy(id);
    audit(ctx.user.username, 'admin', 'webserver.active', id, ctx.ip);
    return ctx.redirect('/admin/web-server?flash=' + encodeURIComponent(`${SERVERS[id].label} is now active. ${deployed.output}`) + (deployed.ok ? '' : '&type=error'));
  });

  router.post('/admin/web-server/php', (ctx) => {
    setSetting('php_handler', ctx.body.handler === 'proxy' ? 'proxy' : 'php-fpm');
    return ctx.redirect('/admin/web-server?flash=PHP%20handler%20saved');
  });

  router.post('/admin/web-server/generate', (ctx) => {
    const result = generateAll(activeServer().id);
    audit(ctx.user.username, 'admin', 'webserver.generate', `${result.total} files`, ctx.ip);
    return ctx.redirect('/admin/web-server?flash=' + encodeURIComponent(`Generated ${result.total} configuration file(s)`));
  });

  router.post('/admin/web-server/test', (ctx) => {
    const result = validate(activeServer().id);
    const lines = [
      result.ok ? 'validation: OK' : 'validation: FAILED',
      ...result.issues.map((i) => `issue: ${i}`),
      result.binaryCheck ? `binary: ${result.binaryCheck.ok ? 'OK' : 'FAILED'}\n${result.binaryCheck.output}` : 'binary: not installed, structural checks only',
    ];
    return ctx.redirect('/admin/web-server?output=' + encodeURIComponent(lines.join('\n')));
  });

  router.post('/admin/web-server/deploy', (ctx) => {
    const result = deploy(activeServer().id);
    audit(ctx.user.username, 'admin', 'webserver.deploy', activeServer().id, ctx.ip);
    return ctx.redirect('/admin/web-server?flash=' + encodeURIComponent(result.output) + (result.ok ? '' : '&type=error'));
  });

  router.post('/admin/web-server/domains', (ctx) => {
    const domains = all('SELECT name FROM domains');
    for (const d of domains) {
      const value = String(ctx.body[`server_${d.name}`] || '');
      if (SERVERS[value]) setSetting(`web_server:${d.name}`, value);
      else setSetting(`web_server:${d.name}`, '');
    }
    return ctx.redirect('/admin/web-server?flash=Per-domain%20servers%20saved');
  });

  router.post('/admin/web-server/litespeed', (ctx) => {
    setSetting('litespeed_license', String(ctx.body.license || ''));
    setSetting('litespeed_serial', String(ctx.body.serial || ''));
    return ctx.redirect('/admin/web-server?flash=LiteSpeed%20license%20saved');
  });

  router.get('/admin/web-server/view', (ctx) => {
    const rel = String(ctx.query.file || '');
    if (!rel || rel.includes('..')) return ctx.redirect('/admin/web-server?flash=Invalid%20path&type=error');
    const full = path.join(stagingDir(activeServer()), 'sites', rel.split('/').pop());
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return ctx.redirect('/admin/web-server?flash=File%20not%20found&type=error');
    const body = h`${card(rel, h`<pre class="code-block">${fs.readFileSync(full, 'utf8')}</pre>`, {
      actions: [h`<a class="link small" href="/admin/web-server">Back</a>`],
    })}`;
    return page(ctx, { title: 'Configuration', subtitle: rel, body });
  });
}

void emptyState; void table; void btn; void get;
