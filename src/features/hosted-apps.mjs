// Node.js / Python application hosting: registry, systemd unit generation and
// reverse-proxy entries in the generated vhosts.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { all, get, run, nowIso, audit } from '../db.mjs';
import { config } from '../config.mjs';
import { html as h, formatDate } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, btn } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { listCard } from '../ui/pages/list.mjs';
import { visibleDomains, domainFor } from '../core/access.mjs';
import { systemProvider } from '../providers/index.mjs';
import { generateAll } from '../webserver.mjs';

export function unitDir() {
  const dir = path.join(config.dataDir, 'apps', 'systemd');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function unitPath(app) {
  return path.join(unitDir(), `${app.id}-${app.domain.replace(/[^a-z0-9]/gi, '_')}.service`);
}

export function renderUnit(app, username) {
  return `[Unit]
Description=OpenAdmin ${app.type} app ${app.domain}${app.path_prefix}
After=network.target

[Service]
Type=simple
User=${username}
WorkingDirectory=/home/${username}
ExecStart=${app.command}
Restart=always
RestartSec=3
Environment=PORT=${app.port}

[Install]
WantedBy=multi-user.target
`;
}

export function writeUnit(app, username) {
  const file = unitPath(app);
  fs.writeFileSync(file, renderUnit(app, username), 'utf8');
  return file;
}

export function deployApps() {
  if (systemProvider().id !== 'linux') return { ok: true, simulated: true, output: `Unit files generated in ${unitDir()} (sandbox provider)` };
  if (process.getuid && process.getuid() !== 0) return { ok: false, output: 'Root privileges are required to install units' };
  const apps = all('SELECT a.*, u.username FROM hosted_apps a JOIN users u ON u.id = a.user_id');
  let count = 0;
  for (const app of apps) {
    const file = writeUnit(app, app.username);
    fs.copyFileSync(file, `/etc/systemd/system/${path.basename(file)}`);
    count++;
  }
  spawnSync('systemctl', ['daemon-reload'], { encoding: 'utf8', timeout: 20000 });
  return { ok: true, output: `Installed ${count} unit(s); systemd reloaded` };
}

export function register(router) {
  router.get('/user/apps', (ctx) => {
    const rows = all('SELECT * FROM hosted_apps WHERE user_id = ? ORDER BY id DESC', ctx.user.id);
    const domains = visibleDomains(ctx.user);
    const body = h`
      ${alert('Node.js and Python applications run behind the selected web server through a loopback port. Unit files are generated here; installation requires Linux + root.', 'info')}
      ${listCard({
        title: 'Hosted applications', sub: `${rows.length} app(s)`,
        columns: [
          { label: 'App', render: (a) => h`<span class="cell-strong">${a.domain}${a.path_prefix}</span><span class="cell-sub">${a.type} · port ${a.port}</span>` },
          { label: 'Command', render: (a) => h`<span class="cell-mono truncate u-s30">${a.command}</span>` },
          { label: 'Status', render: (a) => badge(a.status, a.status === 'running' ? 'ok' : 'muted') },
          { label: 'Created', render: (a) => formatDate(a.created_at) },
        ],
        rows,
        empty: 'No applications registered.',
        actions: [
          { label: 'Start', form: (a) => `/user/apps/${a.id}/start`, icon: 'play' },
          { label: 'Stop', form: (a) => `/user/apps/${a.id}/stop`, icon: 'x' },
          { label: 'Remove', form: (a) => `/user/apps/${a.id}/delete`, icon: 'trash', danger: true, confirm: 'Usunąć tę aplikację?' },
        ],
        footer: h`<form class="u-s31" method="post" action="/user/apps/create">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <select class="u-s40" name="domain">${domains.map((d) => h`<option>${d.name}</option>`)}</select>
          <input class="u-s41" name="path_prefix" value="/">
          <select name="type"><option value="node">Node.js</option><option value="python">Python</option></select>
          <input class="u-s41" name="port" type="number" min="3000" max="3999" value="3000">
          <input class="u-s42" name="command" placeholder="/usr/bin/node app.js" required>
          <button class="btn btn-primary btn-sm" type="submit">${icon('plus', { size: 14 })} Register app</button>
        </form>`,
      })}
      ${card('Generated units', h`<pre class="code-block">${rows.map((a) => unitPath(a)).join('\n') || '# none'}</pre>`, {
        actions: [h`<form method="post" action="/user/apps/deploy" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <button class="btn btn-secondary btn-sm" type="submit">Install units</button></form>`],
      })}`;
    return page(ctx, { title: 'Node.js / Python Apps', subtitle: 'Application hosting and reverse proxy', body });
  });

  router.post('/user/apps/create', (ctx) => {
    const d = domainFor(ctx.user, String(ctx.body.domain || ''));
    if (!d) return ctx.redirect('/user/apps?flash=Domain%20not%20found&type=error');
    const port = Number(ctx.body.port);
    if (!Number.isInteger(port) || port < 3000 || port > 3999) return ctx.redirect('/user/apps?flash=Port%20must%20be%203000-3999&type=error');
    const command = String(ctx.body.command || '').trim();
    if (!command) return ctx.redirect('/user/apps?flash=Command%20is%20required&type=error');
    const type = ctx.body.type === 'python' ? 'python' : 'node';
    const prefix = String(ctx.body.path_prefix || '/').startsWith('/') ? String(ctx.body.path_prefix || '/') : '/';
    const r = run('INSERT INTO hosted_apps(user_id, domain, path_prefix, type, port, command, status, created_at) VALUES(?,?,?,?,?,?,?,?)',
      ctx.user.id, d.name, prefix, type, port, command, 'registered', nowIso());
    const app = get('SELECT * FROM hosted_apps WHERE id = ?', r.lastInsertRowid);
    writeUnit(app, ctx.user.username);
    generateAll();
    audit(ctx.user.username, ctx.user.level, 'app.register', `${d.name}${prefix}`, ctx.ip);
    return ctx.redirect('/user/apps?flash=' + encodeURIComponent(`Application registered on ${d.name}${prefix}`));
  });

  router.post('/user/apps/:id/start', (ctx) => {
    const app = get('SELECT * FROM hosted_apps WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    if (!app) return ctx.redirect('/user/apps?flash=Not%20found&type=error');
    const unit = `${path.basename(unitPath(app))}`;
    const result = systemProvider().startApp(unit);
    if (result.ok) run("UPDATE hosted_apps SET status = 'running' WHERE id = ?", app.id);
    audit(ctx.user.username, ctx.user.level, 'app.start', app.domain, ctx.ip);
    return ctx.redirect('/user/apps?flash=' + encodeURIComponent(result.output) + (result.ok ? '' : '&type=error'));
  });

  router.post('/user/apps/:id/stop', (ctx) => {
    const app = get('SELECT * FROM hosted_apps WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    if (!app) return ctx.redirect('/user/apps?flash=Not%20found&type=error');
    const unit = path.basename(unitPath(app));
    const result = systemProvider().stopApp(unit);
    if (result.ok) run("UPDATE hosted_apps SET status = 'stopped' WHERE id = ?", app.id);
    audit(ctx.user.username, ctx.user.level, 'app.stop', app.domain, ctx.ip);
    return ctx.redirect('/user/apps?flash=' + encodeURIComponent(result.output) + (result.ok ? '' : '&type=error'));
  });

  router.post('/user/apps/:id/delete', (ctx) => {
    const app = get('SELECT * FROM hosted_apps WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    if (app) {
      try { fs.rmSync(unitPath(app), { force: true }); } catch { /* ignore */ }
      run('DELETE FROM hosted_apps WHERE id = ?', app.id);
      generateAll();
    }
    return ctx.redirect('/user/apps?flash=Application%20removed');
  });

  router.post('/user/apps/deploy', (ctx) => {
    const result = deployApps();
    audit(ctx.user.username, ctx.user.level, 'apps.deploy', result.ok ? 'ok' : 'failed', ctx.ip);
    return ctx.redirect('/user/apps?flash=' + encodeURIComponent(result.output) + (result.ok ? '' : '&type=error'));
  });
}

void btn;
