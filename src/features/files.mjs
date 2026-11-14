// File manager (jailed to each account's home directory), FTP, backups, cron.
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, nowIso, hashPassword, audit, setting } from '../db.mjs';
import { config } from '../config.mjs';
import { limitsFor } from '../auth.mjs';
import { html as h, formatBytes, formatDate, e, randomPassword, isEmail } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, emptyState, kvList, progress } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { listCard } from '../ui/pages/list.mjs';
import { quota } from '../core/access.mjs';
import { createUserBackup, restoreUserBackup } from '../backups.mjs';
import { validateJob, rebuildCrontab, installCrontab, cronMeta } from '../cron.mjs';
import { systemProvider } from '../providers/index.mjs';
import { checkDisk } from '../quota.mjs';
import { userHome } from '../paths.mjs';

/* ------------------------------------------------------------------ paths */
export function homeDir(username) {
  const p = userHome(username);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function resolveUserPath(username, requested = '') {
  const home = homeDir(username);
  let rel = String(requested || '').replace(/^\/home\/[^/]+/, '');
  rel = rel.replace(/\/+$/, '') || '/';
  const abs = path.resolve(home, '.' + (rel.startsWith('/') ? rel : '/' + rel));
  if (abs !== home && !abs.startsWith(home + path.sep)) return home;
  return abs;
}

export function displayPath(username, abs) {
  const home = homeDir(username);
  if (abs === home) return `/home/${username}`;
  return `/home/${username}${abs.slice(home.length)}`;
}

function humanPerms(mode) {
  const s = (mode & 0o777).toString(8).padStart(3, '0');
  return s;
}

function dirSize(dir, depth = 0) {
  let total = 0;
  if (depth > 4) return 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const ent of entries) {
    if (ent.name === '.' || ent.name === '..') continue;
    const p = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) total += dirSize(p, depth + 1);
      else total += fs.statSync(p).size;
    } catch { /* skip */ }
  }
  return total;
}

const TEXT_EXT = new Set(['.html', '.htm', '.css', '.js', '.json', '.txt', '.md', '.php', '.conf', '.ini', '.xml', '.svg', '.yml', '.yaml', '.htaccess', '.sh', '.sql']);

/** Create a document root with a default index page for a new domain. */
export function provisionDomain(username, domain) {
  const root = path.join(homeDir(username), 'domains', domain, 'public_html');
  fs.mkdirSync(path.join(root, 'css'), { recursive: true });
  const index = path.join(root, 'index.html');
  if (!fs.existsSync(index)) {
    fs.writeFileSync(index, `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${domain}</title>\n<link rel="stylesheet" href="/css/style.css"></head>\n<body><h1>${domain}</h1><p>This site is hosted on OpenAdmin.</p></body></html>\n`, 'utf8');
  }
  const css = path.join(root, 'css', 'style.css');
  if (!fs.existsSync(css)) fs.writeFileSync(css, 'body{font-family:system-ui,sans-serif;margin:0;padding:48px;background:#f6f9fc;color:#17222e}h1{color:#0a6daa}\n', 'utf8');
  systemProvider().chownUser(username);
  return displayPath(username, root);
}

export function register(router) {
  /* --------------------------------------------------------- file manager */
  router.get('/user/files', (ctx) => {
    const username = ctx.user.username;
    const requested = ctx.query.path || `/home/${username}`;
    const abs = resolveUserPath(username, requested);
    const display = displayPath(username, abs);
    let entries = [];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true }).map((ent) => {
        const full = path.join(abs, ent.name);
        let st = { size: 0, mtime: new Date(), mode: 0o644 };
        try { st = fs.statSync(full); } catch { /* ignore */ }
        const ext = path.extname(ent.name).toLowerCase();
        return {
          name: ent.name, dir: ent.isDirectory(), size: ent.isDirectory() ? dirSize(full) : st.size,
          mtime: st.mtime.toISOString(), perms: humanPerms(st.mode), full,
          editable: !ent.isDirectory() && (TEXT_EXT.has(ext) || ent.name === '.htaccess'),
          ext,
        };
      }).sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    } catch { entries = []; }

    const absParts = display.split('/').filter(Boolean);
    const crumbs = absParts.slice(2).map((part, i) => ({
      label: part, path: '/' + absParts.slice(0, i + 3).join('/'),
    }));
    const editing = ctx.query.edit ? entries.find((x) => x.name === ctx.query.edit && x.editable) : null;
    const editorContent = editing && fs.existsSync(editing.full) ? fs.readFileSync(editing.full, 'utf8').slice(0, 400000) : '';

    const body = h`
      ${card('File manager', h`
        <div class="file-pathbar">
          <a class="crumb-home" href="/user/files?path=/home/${username}">${icon('home', { size: 15 })}</a>
          ${crumbs.map((c) => h`<span class="crumb-sep">/</span><a class="crumb-link" href="/user/files?path=${encodeURIComponent(c.path)}">${c.label}</a>`)}
          <span class="file-path-abs">${display}</span>
        </div>
        <div class="file-toolbar">
          <a class="btn btn-primary btn-sm" href="/user/files?path=${encodeURIComponent(display)}&new=file">${icon('file', { size: 14 })} New file</a>
          <a class="btn btn-secondary btn-sm" href="/user/files?path=${encodeURIComponent(display)}&new=dir">${icon('folder', { size: 14 })} New folder</a>
          <button class="btn btn-secondary btn-sm" type="button" data-open-modal="uploadModal">${icon('upload', { size: 14 })} Upload</button>
          <a class="btn btn-secondary btn-sm" href="/api/v1/files/download?path=${encodeURIComponent(display)}">${icon('download', { size: 14 })} Download folder (zip)</a>
          <span class="small muted" style="margin-left:auto">${entries.length} item(s) · ${formatBytes(dirSize(abs) / 1024 / 1024)}</span>
        </div>
        <div class="table-wrap"><table class="data-table file-table">
          <thead><tr><th>Name</th><th>Size</th><th>Permissions</th><th>Modified</th><th class="col-actions">Actions</th></tr></thead>
          <tbody>
            ${display !== `/home/${username}` ? h`<tr><td colspan="5"><a class="link" href="/user/files?path=${encodeURIComponent(display.split('/').slice(0, -1).join('/') || '/home/' + username)}">${icon('arrowRight', { size: 14 })} Parent directory</a></td></tr>` : ''}
            ${entries.length ? entries.map((f) => h`<tr>
              <td><div class="file-name">${icon(f.dir ? 'folder' : 'file', { size: 16 })}
                ${f.dir ? h`<a href="/user/files?path=${encodeURIComponent(display + '/' + f.name)}">${f.name}</a>` : h`<span>${f.name}</span>`}</div></td>
              <td>${f.dir ? '—' : formatBytes(f.size / 1024 / 1024)}</td>
              <td class="cell-mono">${f.perms}</td>
              <td class="small">${formatDate(f.mtime, { time: true })}</td>
              <td class="col-actions"><div class="row-actions">
                ${f.editable ? h`<a class="icon-btn" href="/user/files?path=${encodeURIComponent(display)}&edit=${encodeURIComponent(f.name)}" title="Edit">${icon('edit', { size: 16 })}</a>` : ''}
                ${!f.dir ? h`<a class="icon-btn" href="/api/v1/files/download?path=${encodeURIComponent(display + '/' + f.name)}" title="Download">${icon('download', { size: 16 })}</a>` : ''}
                <button class="icon-btn" type="button" data-open-modal="rename-${encodeURIComponent(f.name)}" title="Rename">${icon('tag', { size: 16 })}</button>
                <form method="post" action="/user/files/delete" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
                  <input type="hidden" name="path" value="${display}"><input type="hidden" name="name" value="${f.name}">
                  <button class="icon-btn danger" type="submit" title="Delete" onclick="return confirm('Delete ${e(f.name)}?')">${icon('trash', { size: 16 })}</button></form>
              </div></td>
            </tr>`) : h`<tr><td colspan="5">${emptyState('This directory is empty.')}</td></tr>`}
          </tbody>
        </table></div>
      `, { padded: false })}

      ${ctx.query.new ? card(ctx.query.new === 'dir' ? 'New folder' : 'New file', h`<form method="post" action="/user/files/create" class="oa-form" style="max-width:520px">
        <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="path" value="${display}">
        <input type="hidden" name="kind" value="${ctx.query.new === 'dir' ? 'dir' : 'file'}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Name</label><input name="name" required placeholder="${ctx.query.new === 'dir' ? 'assets' : 'index.html'}"></div>
          ${ctx.query.new === 'dir' ? '' : h`<div class="field"><label class="field-label">Content</label><textarea name="content" rows="4" placeholder="Optional initial content"></textarea></div>`}
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Create</button><a class="btn btn-ghost" href="/user/files?path=${encodeURIComponent(display)}">Cancel</a></div>
      </form>`) : ''}
      ${editing ? card(`Edit · ${editing.name}`, h`<form method="post" action="/user/files/save" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <input type="hidden" name="path" value="${display}"><input type="hidden" name="name" value="${editing.name}">
        <p class="small muted mb-12">${display}/${editing.name} · ${formatBytes(editing.size / 1024 / 1024)}</p>
        <textarea name="content" rows="22" spellcheck="false" class="code-editor">${editorContent}</textarea>
        <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('save', { size: 16 })} Save file</button>
          <a class="btn btn-ghost" href="/user/files?path=${encodeURIComponent(display)}">Close</a></div>
      </form>`) : ''}

      <div class="modal-backdrop" id="uploadModal" hidden>
        <div class="modal">
          <header class="modal-head"><h3>Upload files</h3><button class="icon-btn" type="button" data-close-modal>${icon('x', { size: 18 })}</button></header>
          <div class="modal-body">
            <div class="dropzone" id="fileUpload" data-path="${display}">
              ${icon('upload', { size: 26 })}
              <p><strong>Drop files here</strong> or click to browse</p>
              <input type="file" id="fileInput" multiple hidden>
              <span class="small muted">Maximum ${config.limits.maxUploadMb} MB per file</span>
            </div>
          </div>
        </div>
      </div>
      ${entries.filter((f) => f.name).map((f) => h`<div class="modal-backdrop" id="rename-${encodeURIComponent(f.name)}" hidden>
        <div class="modal"><header class="modal-head"><h3>Rename</h3><button class="icon-btn" type="button" data-close-modal>${icon('x', { size: 18 })}</button></header>
          <div class="modal-body"><form method="post" action="/user/files/rename" class="oa-form" id="rn-${encodeURIComponent(f.name)}">
            <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="path" value="${display}"><input type="hidden" name="old" value="${f.name}">
            <div class="field"><label class="field-label">New name</label><input name="new" value="${f.name}" required></div>
          </form></div>
          <footer class="modal-foot"><button class="btn btn-ghost" type="button" data-close-modal>Cancel</button>
            <button class="btn btn-primary" type="submit" form="rn-${encodeURIComponent(f.name)}">Rename</button></footer>
        </div>
      </div>`)}`;
    return page(ctx, { title: 'File Manager', subtitle: display, body, wide: true });
  });

  router.post('/user/files/create', (ctx) => {
    const disk = checkDisk(ctx.user);
    if (!disk.ok) return ctx.redirect('/user/files?flash=' + encodeURIComponent(`Disk quota exceeded (${disk.used.toFixed(1)} / ${disk.limit} MB)`) + '&type=error');
    const dir = resolveUserPath(ctx.user.username, ctx.body.path);
    const name = path.basename(String(ctx.body.name || '').trim());
    if (!name || name === '.' || name === '..') return ctx.redirect('/user/files?flash=Invalid%20name&type=error');
    const full = path.join(dir, name);
    try {
      if (ctx.body.kind === 'dir') fs.mkdirSync(full, { recursive: false });
      else fs.writeFileSync(full, String(ctx.body.content || ''), 'utf8');
    } catch (e) {
      return ctx.redirect('/user/files?path=' + encodeURIComponent(displayPath(ctx.user.username, dir)) + '&flash=' + encodeURIComponent(e.message) + '&type=error');
    }
    systemProvider().chownUser(ctx.user.username);
    return ctx.redirect('/user/files?path=' + encodeURIComponent(displayPath(ctx.user.username, dir)) + '&flash=Created');
  });

  router.post('/user/files/save', (ctx) => {
    const disk = checkDisk(ctx.user);
    if (!disk.ok) return ctx.redirect('/user/files?path=' + encodeURIComponent(ctx.body.path || '') + '&flash=' + encodeURIComponent('Disk quota exceeded') + '&type=error');
    const dir = resolveUserPath(ctx.user.username, ctx.body.path);
    const full = path.join(dir, path.basename(String(ctx.body.name)));
    if (!full.startsWith(homeDir(ctx.user.username))) return ctx.redirect('/user/files?flash=Access%20denied&type=error');
    fs.writeFileSync(full, String(ctx.body.content ?? ''), 'utf8');
    systemProvider().chownUser(ctx.user.username);
    return ctx.redirect('/user/files?path=' + encodeURIComponent(displayPath(ctx.user.username, dir)) + '&flash=File%20saved');
  });

  router.post('/user/files/delete', (ctx) => {
    const dir = resolveUserPath(ctx.user.username, ctx.body.path);
    const full = path.join(dir, path.basename(String(ctx.body.name)));
    if (!full.startsWith(homeDir(ctx.user.username))) return ctx.redirect('/user/files?flash=Access%20denied&type=error');
    try { fs.rmSync(full, { recursive: true, force: true }); } catch { /* ignore */ }
    return ctx.redirect('/user/files?path=' + encodeURIComponent(displayPath(ctx.user.username, dir)) + '&flash=Deleted');
  });

  router.post('/user/files/rename', (ctx) => {
    const dir = resolveUserPath(ctx.user.username, ctx.body.path);
    const from = path.join(dir, path.basename(String(ctx.body.old)));
    const to = path.join(dir, path.basename(String(ctx.body.new)));
    try { fs.renameSync(from, to); } catch { /* ignore */ }
    return ctx.redirect('/user/files?path=' + encodeURIComponent(displayPath(ctx.user.username, dir)) + '&flash=Renamed');
  });

  /* ------------------------------------------------------------------ FTP */
  router.get('/user/ftp', (ctx) => {
    const rows = all('SELECT * FROM ftp_accounts WHERE user_id = ? ORDER BY username', ctx.user.id);
    const lim = limitsFor(ctx.user);
    const body = h`
      ${alert('FTP accounts can be restricted to any directory inside your home. Anonymous FTP can be enabled per domain under FTP Settings.', 'info')}
      ${listCard({
        title: 'FTP accounts', sub: `${rows.length} of ${lim.ftp || '∞'} accounts`,
        columns: [
          { label: 'Username', render: (r) => h`<span class="cell-strong">${r.username}</span>${r.anonymous ? badge('anonymous', 'warn') : ''}` },
          { label: 'Directory', render: (r) => h`<span class="cell-mono">${r.path}</span>` },
          { label: 'Quota', render: (r) => (r.quota_mb ? formatBytes(r.quota_mb) : 'Unlimited') },
          { label: 'Status', render: (r) => (r.suspended ? badge('Suspended', 'danger') : badge('Active', 'ok')) },
        ],
        rows, empty: 'No FTP accounts yet.',
        createHref: '/user/ftp/create', createLabel: 'Create FTP account',
        actions: [
          { label: 'Toggle', form: (r) => `/user/ftp/${r.id}/toggle`, icon: 'lock' },
          { label: 'Delete', form: (r) => `/user/ftp/${r.id}/delete`, confirm: 'Delete FTP account?', icon: 'trash', danger: true },
        ],
      })}`;
    return page(ctx, { title: 'FTP Accounts', subtitle: 'Manage file transfer users', body });
  });

  router.get('/user/ftp/create', (ctx) => {
    const body = h`${card('Create FTP account', h`<form method="post" action="/user/ftp/create" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid">
        <div class="field"><label class="field-label">Username <span class="req">*</span></label><input name="username" required pattern="[a-zA-Z0-9._-]{2,32}" placeholder="deploy"><p class="field-help">Created as <code>${ctx.user.username}_deploy</code>.</p></div>
        <div class="field"><label class="field-label">Password <span class="req">*</span></label>
          <div class="field-control"><input id="ftppass" name="password" type="password" required minlength="8"><button class="btn btn-secondary btn-sm" type="button" data-genpass="#ftppass" style="margin-left:8px">Generate</button></div></div>
        <div class="field field-full"><label class="field-label">Directory</label><input name="path" value="/home/${ctx.user.username}" required></div>
        <div class="field"><label class="field-label">Quota (MB)</label><input name="quota_mb" type="number" min="0" value="0"><p class="field-help">0 = unlimited</p></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Create FTP account</button><a class="btn btn-ghost" href="/user/ftp">Cancel</a></div>
    </form>`)}`;
    return page(ctx, { title: 'Create FTP Account', subtitle: 'Add a file transfer user', body });
  });

  router.post('/user/ftp/create', (ctx) => {
    const q = quota(ctx.user, 'ftp');
    if (!q.ok) return ctx.redirect('/user/ftp?flash=FTP%20limit%20reached&type=error');
    const user = `${ctx.user.username}_${String(ctx.body.username || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 24)}`;
    if (get('SELECT id FROM ftp_accounts WHERE username = ?', user)) return ctx.redirect('/user/ftp?flash=That%20FTP%20user%20already%20exists&type=error');
    const reqPath = String(ctx.body.path || `/home/${ctx.user.username}`);
    const created = systemProvider().createFtpUser(user, reqPath, String(ctx.body.password));
    if (!created.ok) return ctx.redirect('/user/ftp?flash=' + encodeURIComponent(created.output) + '&type=error');
    run('INSERT INTO ftp_accounts(user_id, username, path, quota_mb, password, created_at) VALUES(?,?,?,?,?,?)',
      ctx.user.id, user, reqPath, Number(ctx.body.quota_mb) || 0, hashPassword(String(ctx.body.password)), nowIso());
    audit(ctx.user.username, ctx.user.level, 'ftp.create', user, ctx.ip);
    return ctx.redirect('/user/ftp?flash=' + encodeURIComponent(`FTP account ${user} created`));
  });

  router.post('/user/ftp/:id/delete', (ctx) => {
    const a = get('SELECT * FROM ftp_accounts WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    if (a) {
      systemProvider().deleteFtpUser(a.username);
      run('DELETE FROM ftp_accounts WHERE id = ?', a.id);
    }
    return ctx.redirect('/user/ftp?flash=FTP%20account%20deleted');
  });

  router.post('/user/ftp/:id/toggle', (ctx) => {
    const a = get('SELECT * FROM ftp_accounts WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    if (a) run('UPDATE ftp_accounts SET suspended = ? WHERE id = ?', a.suspended ? 0 : 1, a.id);
    return ctx.redirect('/user/ftp?flash=Updated');
  });

  router.get('/user/ftp/settings', (ctx) => {
    const domains = all('SELECT * FROM domains WHERE user_id = ? ORDER BY name', ctx.user.id);
    const body = h`${card('FTP settings', h`
      <form method="post" action="/user/ftp/settings" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Anonymous FTP</label>
            <select name="anonymous"><option value="0">Disabled (recommended)</option><option value="1">Enabled (read-only)</option></select></div>
          <div class="field"><label class="field-label">FTP over TLS</label>
            <select name="tls"><option value="1">Required</option><option value="0">Optional</option></select></div>
          <div class="field"><label class="field-label">Passive port range</label><input name="passive" value="35000-35999"></div>
          <div class="field"><label class="field-label">Max connections per user</label><input type="number" name="maxconn" value="8" min="1"></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save settings</button></div>
      </form>`)}
      ${card('Domain FTP access', h`${table({
        columns: [
          { label: 'Domain', key: 'name' },
          { label: 'Anonymous user', render: (d) => h`<span class="cell-mono">ftp@${d.name}</span>` },
          { label: 'Status', render: () => badge('Disabled', 'muted') },
        ],
        rows: domains, empty: 'No domains yet.',
      })}`)}`;
    return page(ctx, { title: 'FTP Settings', subtitle: 'Server-wide FTP options for your account', body });
  });

  router.post('/user/ftp/settings', (ctx) => {
    run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', `ftp_settings_${ctx.user.username}`, JSON.stringify(ctx.body));
    return ctx.redirect('/user/ftp/settings?flash=Settings%20saved');
  });

  /* -------------------------------------------------------------- backups */
  router.get('/user/backups', (ctx) => {
    const rows = all('SELECT * FROM backups WHERE user_id = ? ORDER BY created_at DESC', ctx.user.id);
    const body = h`
      <div class="grid grid-2">
        ${card('Create backup', h`
          <p class="small muted mb-18">User backups contain your home directory plus SQL dumps of your own databases. The panel database is excluded by design; DNS zones stay server-managed and are not included.</p>
          ${kvList([['Last backup', rows[0] ? formatDate(rows[0].created_at, { time: true }) : 'never'], ['Total backups', String(rows.length)], ['Storage used', formatBytes(rows.reduce((a, r) => a + r.size_mb, 0))]])}
          <form method="post" action="/user/backups/create" style="margin-top:16px" class="row">
            <input type="hidden" name="_csrf" value="${ctx.csrf}">
            <select name="kind"><option value="full">Full backup</option><option value="home">Home directory</option><option value="email">Email only</option><option value="db">Databases only</option></select>
            <button class="btn btn-primary" type="submit">${icon('archive', { size: 16 })} Create backup</button>
          </form>`)}
        ${card('Restore', h`<p class="small muted mb-12">Restore a previous backup over your current account. Existing files with the same name are replaced.</p>
          <form method="post" action="/user/backups/restore" class="row"><input type="hidden" name="_csrf" value="${ctx.csrf}">
            <select name="id">${rows.map((r) => h`<option value="${r.id}">${r.filename}</option>`)}</select>
            <button class="btn btn-secondary" type="submit" onclick="return confirm('Restore this backup?')">Restore backup</button></form>`)}
      </div>
      ${listCard({
        title: 'Backup history', sub: `${rows.length} archive(s)`,
        columns: [
          { label: 'Filename', render: (r) => h`<span class="cell-mono">${r.filename}</span>` },
          { label: 'Type', render: (r) => badge(r.kind, 'brand') },
          { label: 'Size', render: (r) => formatBytes(r.size_mb), align: 'right' },
          { label: 'Status', render: (r) => badge(r.status, 'ok') },
          { label: 'Created', render: (r) => formatDate(r.created_at, { time: true }) },
        ],
        rows,
        empty: 'No backups created yet.',
        actions: [
          { label: 'Download', href: (r) => `/api/v1/backups/${r.id}/download`, icon: 'download' },
          { label: 'Delete', form: (r) => `/user/backups/${r.id}/delete`, confirm: 'Delete this backup?', icon: 'trash', danger: true },
        ],
      })}`;
    return page(ctx, { title: 'Backups', subtitle: 'Create and restore account backups', body });
  });

  router.post('/user/backups/create', (ctx) => {
    const kind = ['full', 'home', 'email', 'db'].includes(String(ctx.body.kind)) ? String(ctx.body.kind) : 'full';
    try {
      const result = createUserBackup(ctx.user, kind);
      audit(ctx.user.username, ctx.user.level, 'backup.create', result.filename, ctx.ip);
      return ctx.redirect('/user/backups?flash=' + encodeURIComponent(`Backup ${result.filename} created (${result.size} MB, ${result.files} files)`));
    } catch (e) {
      return ctx.redirect('/user/backups?flash=' + encodeURIComponent('Backup failed: ' + e.message) + '&type=error');
    }
  });

  router.post('/user/backups/:id/delete', (ctx) => {
    const b = get('SELECT * FROM backups WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    if (b) {
      run('DELETE FROM backups WHERE id = ?', b.id);
      try { fs.rmSync(path.join(config.dataDir, 'backups', b.filename), { force: true }); } catch { /* ignore */ }
    }
    return ctx.redirect('/user/backups?flash=Backup%20deleted');
  });

  router.post('/user/backups/restore', (ctx) => {
    const b = get('SELECT * FROM backups WHERE id = ? AND user_id = ?', Number(ctx.body.id), ctx.user.id);
    if (!b) return ctx.redirect('/user/backups?flash=Backup%20not%20found&type=error');
    const result = restoreUserBackup(ctx.user, b.filename);
    if (!result.ok) return ctx.redirect('/user/backups?flash=' + encodeURIComponent('Restore failed: ' + result.error) + '&type=error');
    audit(ctx.user.username, ctx.user.level, 'backup.restore', b.filename, ctx.ip);
    return ctx.redirect('/user/backups?flash=' + encodeURIComponent(`Backup ${b.filename} restored (${result.files} files)`));
  });

  /* ----------------------------------------------------------------- cron */
  router.get('/user/cron', (ctx) => {
    const rows = all('SELECT * FROM cron_jobs WHERE user_id = ? ORDER BY id', ctx.user.id);
    const lim = limitsFor(ctx.user);
    const body = h`
      ${alert('Cron uses standard 5-field syntax. Commands run as your account with your home directory as the working directory.', 'info')}
      ${listCard({
        title: 'Cron jobs', sub: `${rows.length} of ${lim.cron || '∞'} jobs`,
        columns: [
          { label: 'Schedule', render: (r) => h`<span class="cell-mono">${[r.minute, r.hour, r.day, r.month, r.weekday].join(' ')}</span>` },
          { label: 'Command', render: (r) => h`<span class="cell-mono truncate" style="max-width:420px;display:block">${r.command}</span>` },
          { label: 'Created', render: (r) => formatDate(r.created_at) },
        ],
        rows, empty: 'No cron jobs yet.',
        actions: [{ label: 'Delete', form: (r) => `/user/cron/${r.id}/delete`, confirm: 'Delete cron job?', icon: 'trash', danger: true }],
        footer: h`<form method="post" action="/user/cron/create" class="cron-form">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <div class="cron-fields">
            <input name="minute" value="0" title="Minute" aria-label="Minute">
            <input name="hour" value="*" title="Hour" aria-label="Hour">
            <input name="day" value="*" title="Day" aria-label="Day">
            <input name="month" value="*" title="Month" aria-label="Month">
            <input name="weekday" value="*" title="Weekday" aria-label="Weekday">
          </div>
          <input name="command" placeholder="/usr/local/bin/php /home/${ctx.user.username}/cron.php" required style="flex:1;min-width:280px">
          <button class="btn btn-primary btn-sm" type="submit">${icon('plus', { size: 14 })} Add cron job</button>
        </form>`,
      })}
      ${card('Generated crontab', h`
        ${alert(`Crontab file: <code>${cronMeta(ctx.user.username)?.file || 'not generated'}</code> · installed by the provider on Linux (cron reload).`, 'info')}
        <pre class="code-block">${rows.map((r) => `${[r.minute, r.hour, r.day, r.month, r.weekday].join(' ')} ${r.command}`).join('\n') || '# no jobs'}</pre>
        <form method="post" action="/user/cron/install" class="mt-18"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <button class="btn btn-secondary btn-sm" type="submit">Install crontab</button></form>`)}`;
    return page(ctx, { title: 'Cron Jobs', subtitle: 'Schedule commands to run automatically', body });
  });

  router.post('/user/cron/create', (ctx) => {
    const q = quota(ctx.user, 'cron');
    if (!q.ok) return ctx.redirect('/user/cron?flash=Cron%20limit%20reached&type=error');
    const job = {
      minute: String(ctx.body.minute ?? '0'), hour: String(ctx.body.hour ?? '*'), day: String(ctx.body.day ?? '*'),
      month: String(ctx.body.month ?? '*'), weekday: String(ctx.body.weekday ?? '*'), command: String(ctx.body.command || '').trim(),
    };
    const problem = validateJob(job);
    if (problem) return ctx.redirect('/user/cron?flash=' + encodeURIComponent(problem) + '&type=error');
    run('INSERT INTO cron_jobs(user_id, minute, hour, day, month, weekday, command, created_at) VALUES(?,?,?,?,?,?,?,?)',
      ctx.user.id, job.minute, job.hour, job.day, job.month, job.weekday, job.command, nowIso());
    rebuildCrontab(ctx.user.username);
    audit(ctx.user.username, ctx.user.level, 'cron.create', job.command, ctx.ip);
    return ctx.redirect('/user/cron?flash=Cron%20job%20created');
  });

  router.post('/user/cron/install', (ctx) => {
    const result = installCrontab(ctx.user.username);
    audit(ctx.user.username, ctx.user.level, 'cron.install', result.ok ? 'ok' : 'failed', ctx.ip);
    return ctx.redirect('/user/cron?flash=' + encodeURIComponent(result.output) + (result.ok ? '' : '&type=error'));
  });

  router.post('/user/cron/:id/delete', (ctx) => {
    run('DELETE FROM cron_jobs WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    rebuildCrontab(ctx.user.username);
    return ctx.redirect('/user/cron?flash=Cron%20job%20deleted');
  });
}

void e; void randomPassword; void isEmail; void setting;
