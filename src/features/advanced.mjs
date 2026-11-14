// Advanced features: PHP settings, error pages, htaccess, handlers, MIME
// types, protected directories, hotlink protection, app installer, git,
// terminal and WordPress management.
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, nowIso, setting, audit, hashPassword } from '../db.mjs';
import { html as h, formatDate, safeJson, formatBytes } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, btn, badge, alert, emptyState, kvList, form, progress } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { domainSelect, listCard } from '../ui/pages/list.mjs';
import { visibleDomains, domainFor } from '../core/access.mjs';
import { homeDir, resolveUserPath, displayPath, provisionDomain } from './files.mjs';
import { generateAll } from '../webserver.mjs';
import { installWordPress, wordpressStatus } from '../wordpress.mjs';
import { installNextcloud, nextcloudStatus } from '../nextcloud.mjs';
import { apply } from '../apply.mjs';
import { dropDatabase, dropAccount } from '../mariadb.mjs';

const PHP_VERSIONS = ['8.4', '8.3', '8.2', '8.1', '7.4'];

function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return fallback;
  return safeJson(row.value, row.value);
}
function putSetting(key, value) {
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, typeof value === 'string' ? value : JSON.stringify(value));
}

export function register(router) {
  /* ----------------------------------------------------------- PHP settings */
  router.get('/user/php', (ctx) => {
    const domains = visibleDomains(ctx.user);
    const selected = ctx.query.domain || domains[0]?.name;
    const d = domains.find((x) => x.name === selected) || domains[0];
    const ini = d ? getSetting(`php:${d.name}`, {}) : {};
    const body = h`
      ${domains.length ? domainSelect(domains, d?.name, { action: '/user/php' }) : alert('Add a domain first.', 'warn')}
      ${d ? card(`PHP configuration · ${d.name}`, h`<form method="post" action="/user/php" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="domain" value="${d.name}">
        <div class="form-grid">
          <div class="field"><label class="field-label">PHP version</label><select name="version">
            ${PHP_VERSIONS.map((v) => h`<option ${v === (d.php_version || '8.3') ? 'selected' : ''}>${v}</option>`)}</select>
            <p class="field-help">Applies to this domain only. Changing the version reloads PHP-FPM.</p></div>
          <div class="field"><label class="field-label">memory_limit</label><input name="memory_limit" value="${ini.memory_limit || '256M'}"></div>
          <div class="field"><label class="field-label">upload_max_filesize</label><input name="upload_max_filesize" value="${ini.upload_max_filesize || '64M'}"></div>
          <div class="field"><label class="field-label">post_max_size</label><input name="post_max_size" value="${ini.post_max_size || '64M'}"></div>
          <div class="field"><label class="field-label">max_execution_time</label><input name="max_execution_time" value="${ini.max_execution_time || '60'}"></div>
          <div class="field"><label class="field-label">display_errors</label><select name="display_errors"><option value="0" ${!ini.display_errors ? 'selected' : ''}>Off (recommended)</option><option value="1" ${ini.display_errors ? 'selected' : ''}>On</option></select></div>
          <div class="field field-full"><label class="check-field"><input type="checkbox" name="opcache" value="1" ${ini.opcache !== '0' ? 'checked' : ''}> <span>Enable OPcache</span></label></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save PHP settings</button></div>
      </form>`) : ''}
      ${card('Available PHP versions', h`${table({
        columns: [
          { label: 'Version', render: (r) => h`<span class="cell-strong">PHP ${r.v}</span>` },
          { label: 'Binary', render: (r) => h`<span class="cell-mono">/usr/local/php${r.v}/bin/php</span>` },
          { label: 'FPM', render: () => badge('enabled', 'ok') },
          { label: 'Extensions', render: () => h`<span class="small muted">mysqli, pdo_mysql, gd, curl, mbstring, zip, intl, opcache</span>` },
        ],
        rows: PHP_VERSIONS.map((v) => ({ v })),
      })}`)}`;
    return page(ctx, { title: 'PHP Settings', subtitle: 'Per-domain PHP version and INI values', body });
  });

  router.post('/user/php', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/php?flash=Domain%20not%20found&type=error');
    const version = PHP_VERSIONS.includes(String(ctx.body.version)) ? String(ctx.body.version) : d.php_version;
    putSetting(`php:${d.name}`, {
      memory_limit: String(ctx.body.memory_limit || '256M'), upload_max_filesize: String(ctx.body.upload_max_filesize || '64M'),
      post_max_size: String(ctx.body.post_max_size || '64M'), max_execution_time: String(ctx.body.max_execution_time || '60'),
      display_errors: ctx.body.display_errors ? '1' : '0', opcache: ctx.body.opcache ? '1' : '0',
    });
    run('UPDATE domains SET php_version = ? WHERE id = ?', version, d.id);
    return ctx.redirect('/user/php?domain=' + encodeURIComponent(d.name) + '&flash=PHP%20settings%20saved');
  });

  /* ----------------------------------------------------------- error pages */
  router.get('/user/error-pages', (ctx) => {
    const domains = visibleDomains(ctx.user);
    const selected = ctx.query.domain || domains[0]?.name;
    const d = domains.find((x) => x.name === selected) || domains[0];
    const code = String(ctx.query.code || '404');
    const saved = d ? getSetting(`errpage:${d.name}:${code}`, '') : '';
    const body = h`
      ${domains.length ? domainSelect(domains, d?.name, { action: '/user/error-pages' }) : ''}
      ${d ? h`${card('Error page code', h`<div class="chip-row">${['400', '401', '403', '404', '500', '503'].map((c) => h`<a class="chip ${c === code ? 'active' : ''}" href="/user/error-pages?domain=${d.name}&code=${c}">${c}</a>`)}</div>`)}
      ${card(`Custom ${code} page · ${d.name}`, h`<form method="post" action="/user/error-pages" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="domain" value="${d.name}"><input type="hidden" name="code" value="${code}">
        <div class="field field-full"><textarea name="content" rows="12" placeholder="<html>…">${saved || defaultErrorPage(code)}</textarea></div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save error page</button>
          <a class="btn btn-ghost" href="/user/error-pages?domain=${d.name}&code=${code}">Reset</a></div>
      </form>`)}` : ''}`;
    return page(ctx, { title: 'Error Pages', subtitle: 'Customise 4xx and 5xx responses', body });
  });

  router.post('/user/error-pages', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/error-pages?flash=Domain%20not%20found&type=error');
    const code = String(ctx.body.code || '404');
    const content = String(ctx.body.content || '');
    putSetting(`errpage:${d.name}:${code}`, content);
    try {
      const dir = path.join(homeDir(ctx.user.username), 'domains', d.name, 'public_html');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `error-${code}.html`), content || defaultErrorPage(code), 'utf8');
      generateAll();
    } catch { /* staging best effort */ }
    return ctx.redirect(`/user/error-pages?domain=${encodeURIComponent(d.name)}&code=${encodeURIComponent(code)}&flash=Error%20page%20saved`);
  });

  /* -------------------------------------------------------------- htaccess */
  router.get('/user/htaccess', (ctx) => {
    const domains = visibleDomains(ctx.user);
    const selected = ctx.query.domain || domains[0]?.name;
    const d = domains.find((x) => x.name === selected) || domains[0];
    let content = '';
    if (d) {
      const file = path.join(homeDir(ctx.user.username), 'domains', d.name, 'public_html', '.htaccess');
      content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    }
    const body = h`
      ${domains.length ? domainSelect(domains, d?.name, { action: '/user/htaccess' }) : ''}
      ${d ? card(`.htaccess · ${d.name}`, h`<form method="post" action="/user/htaccess" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="domain" value="${d.name}">
        <textarea name="content" rows="18" spellcheck="false" class="code-editor" placeholder="RewriteEngine On">${content}</textarea>
        <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('save', { size: 16 })} Save .htaccess</button>
          <span class="small muted">Changes apply immediately; a syntax error returns 500.</span></div>
      </form>`) : ''}`;
    return page(ctx, { title: 'htaccess', subtitle: 'Edit per-domain Apache configuration', body });
  });

  router.post('/user/htaccess', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/htaccess?flash=Domain%20not%20found&type=error');
    const file = path.join(homeDir(ctx.user.username), 'domains', d.name, 'public_html', '.htaccess');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(ctx.body.content || ''), 'utf8');
    return ctx.redirect('/user/htaccess?domain=' + encodeURIComponent(d.name) + '&flash=.htaccess%20saved');
  });

  /* ------------------------------------------------------- handlers / mime */
  const simpleListPage = (kind, title, subtitle, placeholderKey, placeholderValue) => (ctx) => {
    const rows = getSetting(`user:${ctx.user.username}:${kind}`, []);
    const editing = ctx.query.edit ? rows.find((r) => String(r.id) === String(ctx.query.edit)) : null;
    const body = h`${listCard({
      title, sub: `${rows.length} entry(ies)`,
      columns: [
        { label: title.includes('MIME') ? 'Extension' : 'Handler', render: (r) => h`<span class="cell-mono">${r.key}</span>` },
        { label: title.includes('MIME') ? 'MIME type' : 'Handler string', render: (r) => h`<span class="cell-mono">${r.value}</span>` },
        { label: 'Added', render: (r) => formatDate(r.added) },
      ],
      rows, empty: 'No custom entries.',
      actions: [
        { label: 'Edytuj', href: (r) => `/user/${kind}?edit=${r.id}`, icon: 'edit' },
        { label: 'Delete', form: (r) => `/user/${kind}/${r.id}/delete`, icon: 'trash', danger: true },
      ],
      footer: h`<form method="post" action="/user/${kind}/create" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <input name="key" placeholder="${placeholderKey}" style="max-width:220px" required>
        <input name="value" placeholder="${placeholderValue}" style="flex:1;min-width:260px" required>
        <button class="btn btn-primary btn-sm" type="submit">${icon('plus', { size: 14 })} Add</button>
      </form>`,
    })}${editing ? card(`Edytuj wpis · ${editing.key}`, h`<form method="post" action="/user/${kind}/${editing.id}/update" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid">
        <div class="field"><label class="field-label">Klucz</label><input name="key" value="${editing.key}" required></div>
        <div class="field field-full"><label class="field-label">Wartość</label><input name="value" value="${editing.value}" required></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Zapisz</button><a class="btn btn-ghost" href="/user/${kind}">Anuluj</a></div>
    </form>`) : ''}${card('Default configuration', h`${kvList([
      ['Config file', kind === 'handlers' ? '/etc/apache2/conf.d/handlers.conf' : '/etc/apache2/conf.d/mime.conf'],
      ['Applied to', 'All domains on this account'],
      ['Override', 'Requires AllowOverride FileInfo'],
    ])}`)}`;
    return page(ctx, { title, subtitle, body });
  };

  router.get('/user/handlers', simpleListPage('handlers', 'Apache Handlers', 'Map file extensions to server handlers', '.cgi', 'cgi-script'));
  router.get('/user/mime-types', simpleListPage('mime-types', 'MIME Types', 'Map file extensions to content types', '.webp', 'image/webp'));

  const simpleCreate = (kind) => (ctx) => {
    const key = String(ctx.body.key || '').trim();
    const value = String(ctx.body.value || '').trim();
    if (!key || !value) return ctx.redirect(`/user/${kind}?flash=Both%20fields%20are%20required&type=error`);
    const rows = getSetting(`user:${ctx.user.username}:${kind}`, []);
    rows.push({ id: Date.now().toString(36), key, value, added: nowIso() });
    putSetting(`user:${ctx.user.username}:${kind}`, rows);
    return ctx.redirect(`/user/${kind}?flash=Entry%20added`);
  };
  const simpleDelete = (kind) => (ctx) => {
    const rows = getSetting(`user:${ctx.user.username}:${kind}`, []).filter((r) => r.id !== ctx.params.id);
    putSetting(`user:${ctx.user.username}:${kind}`, rows);
    return ctx.redirect(`/user/${kind}?flash=Entry%20deleted`);
  };
  const simpleUpdate = (kind) => (ctx) => {
    const key = String(ctx.body.key || '').trim(); const value = String(ctx.body.value || '').trim();
    if (!key || !value) return ctx.redirect(`/user/${kind}?flash=Both%20fields%20are%20required&type=error`);
    const rows = getSetting(`user:${ctx.user.username}:${kind}`, []).map((r) => r.id === ctx.params.id ? { ...r, key, value } : r);
    putSetting(`user:${ctx.user.username}:${kind}`, rows);
    return ctx.redirect(`/user/${kind}?flash=Entry%20updated`);
  };
  router.post('/user/handlers/create', simpleCreate('handlers'));
  router.post('/user/handlers/:id/update', simpleUpdate('handlers'));
  router.post('/user/handlers/:id/delete', simpleDelete('handlers'));
  router.post('/user/mime-types/create', simpleCreate('mime-types'));
  router.post('/user/mime-types/:id/update', simpleUpdate('mime-types'));
  router.post('/user/mime-types/:id/delete', simpleDelete('mime-types'));

  /* -------------------------------------------------- protected directories */
  router.get('/user/protected-directories', (ctx) => {
    const rows = getSetting(`protected:${ctx.user.username}`, []);
    const editing = ctx.query.edit ? rows.find((r) => String(r.id) === String(ctx.query.edit)) : null;
    const domains = visibleDomains(ctx.user);
    const body = h`${listCard({
      title: 'Protected directories', sub: 'Password-protect folders with HTTP Basic auth',
      columns: [
        { label: 'Directory', render: (r) => h`<span class="cell-mono">${r.domain}${r.path}</span>` },
        { label: 'Users', render: (r) => r.users.join(', ') },
        { label: 'Created', render: (r) => formatDate(r.created) },
      ],
      rows, empty: 'No protected directories.',
      actions: [
        { label: 'Edytuj', href: (r) => `/user/protected-directories?edit=${r.id}`, icon: 'edit' },
        { label: 'Remove', form: (r) => `/user/protected-directories/${r.id}/delete`, confirm: 'Remove protection?', icon: 'trash', danger: true },
      ],
      footer: h`<form method="post" action="/user/protected-directories/create" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <select name="domain" style="width:200px">${domains.map((d) => h`<option value="${d.name}">${d.name}</option>`)}</select>
        <input name="path" placeholder="/members" style="max-width:160px" required>
        <input name="username" placeholder="user" style="max-width:140px" required>
        <input name="password" type="password" placeholder="password" style="max-width:160px" required>
        <button class="btn btn-primary btn-sm" type="submit">${icon('lock', { size: 14 })} Protect</button>
      </form>`,
    })}${editing ? card(`Edytuj ochronę · ${editing.domain}${editing.path}`, h`<form method="post" action="/user/protected-directories/${editing.id}/update" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid">
        <div class="field"><label class="field-label">Katalog</label><input value="${editing.domain}${editing.path}" disabled></div>
        <div class="field"><label class="field-label">Nowe hasło</label><input name="password" type="password" minlength="4" required></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Zmień hasło</button><a class="btn btn-ghost" href="/user/protected-directories">Anuluj</a></div>
    </form>`) : ''}`;
    return page(ctx, { title: 'Protected Directories', subtitle: 'Require a password for a folder', body });
  });

  router.post('/user/protected-directories/create', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/protected-directories?flash=Domain%20not%20found&type=error');
    const rows = getSetting(`protected:${ctx.user.username}`, []);
    const dirPath = '/' + String(ctx.body.path || '').replace(/^\/+/, '');
    rows.push({ id: Date.now().toString(36), domain: d.name, path: dirPath, users: [String(ctx.body.username)], created: nowIso() });
    putSetting(`protected:${ctx.user.username}`, rows);
    const dir = path.join(homeDir(ctx.user.username), 'domains', d.name, 'public_html', dirPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.htpasswd'), `${ctx.body.username}:{SHA}${Buffer.from(String(ctx.body.password)).toString('base64')}\n`);
    return ctx.redirect('/user/protected-directories?flash=Directory%20protected');
  });

  router.post('/user/protected-directories/:id/update', (ctx) => {
    const rows = getSetting(`protected:${ctx.user.username}`, []);
    const row = rows.find((r) => String(r.id) === String(ctx.params.id));
    if (!row) return ctx.redirect('/user/protected-directories?flash=Not%20found&type=error');
    const dir = path.join(homeDir(ctx.user.username), 'domains', row.domain, 'public_html', row.path);
    fs.writeFileSync(path.join(dir, '.htpasswd'), `${row.users[0]}:{SHA}${Buffer.from(String(ctx.body.password)).toString('base64')}\n`);
    return ctx.redirect('/user/protected-directories?flash=Password%20updated');
  });

  router.post('/user/protected-directories/:id/delete', (ctx) => {
    const rows = getSetting(`protected:${ctx.user.username}`, []).filter((r) => r.id !== ctx.params.id);
    putSetting(`protected:${ctx.user.username}`, rows);
    return ctx.redirect('/user/protected-directories?flash=Protection%20removed');
  });

  /* ---------------------------------------------------- hotlink protection */
  router.get('/user/hotlink-protection', (ctx) => {
    const domains = visibleDomains(ctx.user);
    const settings = getSetting(`hotlink:${ctx.user.username}`, {});
    const body = h`
      ${alert('Hotlink protection blocks other sites from embedding your images and media, saving bandwidth.', 'info')}
      ${card('Per-domain protection', h`<form method="post" action="/user/hotlink-protection" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          ${domains.map((d) => h`<div class="field"><label class="check-field"><input type="checkbox" name="domains[]" value="${d.name}" ${settings[d.name] ? 'checked' : ''}> <span>${d.name}</span></label></div>`)}
          <div class="field field-full"><label class="field-label">Allowed referrers (one per line)</label>
            <textarea name="allowed" rows="4" placeholder="${setting('server_name', '')}">${(settings._allowed || []).join('\n')}</textarea></div>
          <div class="field field-full"><label class="field-label">Blocked extensions</label><input name="extensions" value="${(settings._extensions || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'zip']).join(', ')}"></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save hotlink protection</button></div>
      </form>`)}`;
    return page(ctx, { title: 'Hotlink Protection', subtitle: 'Prevent bandwidth theft', body });
  });

  router.post('/user/hotlink-protection', (ctx) => {
    const settings = {};
    for (const d of [].concat(ctx.body['domains'] || [])) settings[d] = 1;
    settings._allowed = String(ctx.body.allowed || '').split('\n').map((s) => s.trim()).filter(Boolean);
    settings._extensions = String(ctx.body.extensions || '').split(',').map((s) => s.trim()).filter(Boolean);
    putSetting(`hotlink:${ctx.user.username}`, settings);
    return ctx.redirect('/user/hotlink-protection?flash=Hotlink%20protection%20saved');
  });

  /* --------------------------------------------------------- app installer */
  router.get('/user/app-installer', (ctx) => {
    const rows = all('SELECT * FROM wordpress WHERE domain IN (SELECT name FROM domains WHERE user_id = ?) ORDER BY created_at DESC', ctx.user.id);
    const ncRows = all('SELECT * FROM app_installs WHERE user_id = ? AND type = ? ORDER BY created_at DESC', ctx.user.id, 'nextcloud');
    const ready = wordpressStatus();
    const ncReady = nextcloudStatus();
    const canInstall = ready.php && ready.mariadb;
    const canNc = ncReady.php && ncReady.curl && ncReady.unzip && ncReady.mariadb;
    const body = h`
      ${alert('Instalator pobiera oficjalny WordPress, tworzy prawdziwą bazę MariaDB i konfiguruje witrynę. Hasło administratora pokazujemy tylko raz.', 'info')}
      ${!canInstall ? alert(`Instalator nie jest gotowy: ${!ready.php ? 'brak PHP CLI. ' : ''}${!ready.mariadb ? 'brak połączenia z MariaDB. ' : ''}Skontaktuj się z administratorem serwera.`, 'warn') : ''}
      ${card('Zainstaluj WordPress', h`<form method="post" action="/user/app-installer/wordpress" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Domena</label><select name="domain">${visibleDomains(ctx.user).map((d) => h`<option value="${d.name}">${d.name}</option>`)}</select></div>
          <div class="field"><label class="field-label">Ścieżka</label><input name="path" value="/" placeholder="/blog"></div>
          <div class="field"><label class="field-label">Tytuł witryny</label><input name="title" placeholder="Moja strona"></div>
          <div class="field"><label class="field-label">E-mail administratora</label><input name="admin_email" type="email" placeholder="ty@example.com"></div>
          <div class="field"><label class="field-label">Login administratora</label><input name="admin_user" value="admin"></div>
          <div class="field"><label class="field-label">Hasło administratora</label><div class="field-control"><input id="wpPass" name="admin_password" type="password" minlength="8" required><button class="btn btn-secondary btn-sm" type="button" data-genpass="#wpPass" style="margin-left:8px">Generuj</button></div></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit" ${canInstall ? '' : 'disabled'}>${icon('download', { size: 16 })} Zainstaluj WordPress</button></div>
      </form>`, { sub: ready.cli ? 'wp-cli gotowy' : 'wp-cli zostanie pobrany przy pierwszej instalacji' })}
      ${card('Zainstalowane aplikacje', h`${rows.length ? table({
        columns: [
          { label: 'Domena', render: (r) => h`<span class="cell-strong">${r.domain}${r.path === '/' ? '' : r.path}</span>` },
          { label: 'Wersja', key: 'version' },
          { label: 'Administrator', key: 'admin_user' },
          { label: 'Zainstalowano', render: (r) => formatDate(r.created_at) },
        ],
        rows,
        actions: [
          { label: 'Otwórz', href: (r) => `http://${r.domain}${r.path === '/' ? '' : r.path}`, icon: 'globe' },
          { label: 'Panel WP', href: (r) => `http://${r.domain}${r.path === '/' ? '' : r.path}/wp-admin/`, icon: 'lock' },
          { label: 'Usuń', form: (r) => `/user/app-installer/wordpress/${r.id}/delete`, confirm: 'Usunąć witrynę wraz z bazą danych?', icon: 'trash', danger: true },
        ],
      }) : emptyState('Nie zainstalowano jeszcze żadnej aplikacji.')}`)}
      ${card('Zainstaluj Nextcloud', h`
        ${!canNc ? alert('Nextcloud wymaga php, curl, unzip i MariaDB na serwerze.', 'warn') : ''}
        <form method="post" action="/user/app-installer/nextcloud" class="oa-form">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <div class="form-grid">
            <div class="field"><label class="field-label">Domena</label><select name="domain">${visibleDomains(ctx.user).map((d) => h`<option value="${d.name}">${d.name}</option>`)}</select></div>
            <div class="field"><label class="field-label">Ścieżka</label><input name="path" value="/" readonly></div>
            <div class="field"><label class="field-label">Login administratora</label><input name="admin_user" value="admin"></div>
            <div class="field"><label class="field-label">Hasło administratora</label><input name="admin_password" type="password" minlength="8" required></div>
          </div>
          <p class="small muted">Zalecana osobna subdomena, np. <code>cloud.twojadomena.pl</code>, instalacja w katalogu głównym.</p>
          <div class="form-actions"><button class="btn btn-primary" type="submit" ${canNc ? '' : 'disabled'}>Zainstaluj Nextcloud</button></div>
        </form>`)}
      ${card('Zainstalowane Nextcloud', h`${ncRows.length ? table({
        columns: [
          { label: 'Domena', render: (r) => h`<span class="cell-strong">${r.domain}${r.path === '/' ? '' : r.path}</span>` },
          { label: 'Wersja', key: 'version' },
          { label: 'Administrator', key: 'admin_user' },
          { label: 'Zainstalowano', render: (r) => formatDate(r.created_at) },
        ],
        rows: ncRows,
        actions: [
          { label: 'Otwórz', href: (r) => `https://${r.domain}${r.path === '/' ? '' : r.path}/`, icon: 'globe' },
          { label: 'Usuń', form: (r) => `/user/app-installer/nextcloud/${r.id}/delete`, confirm: 'Usunąć Nextcloud wraz z bazą?', icon: 'trash', danger: true },
        ],
      }) : emptyState('Brak instalacji Nextcloud.')}`)}
      ${card('Więcej aplikacji', h`<p class="small muted">Katalog obsługuje WordPress i Nextcloud. Kolejne aplikacje są w przygotowaniu — nie pokazujemy przycisków, które nic nie robią.</p>`)}`;
    return page(ctx, { title: 'Instalator aplikacji', subtitle: 'WordPress jednym kliknięciem', body });
  });

  router.post('/user/app-installer/wordpress', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/app-installer?flash=Wybierz%20w%C5%82asn%C4%85%20domen%C4%99&type=error');
    const result = installWordPress({
      user: ctx.user, domain: d.name, subpath: ctx.body.path || '/',
      title: ctx.body.title || d.name, adminUser: ctx.body.admin_user || 'admin',
      adminPass: String(ctx.body.admin_password || ''), adminEmail: ctx.body.admin_email || ctx.user.email || '',
      locale: 'pl_PL',
    });
    audit(ctx.user.username, ctx.user.level, 'wordpress.install', `${d.name}${ctx.body.path || '/'}`, ctx.ip);
    if (!result.ok) return ctx.redirect('/user/app-installer?flash=' + encodeURIComponent(result.error) + '&type=error');
    apply({ web: true });
    const body = h`${card('WordPress zainstalowany', h`
      ${alert('Zapisz hasło administratora teraz — nie pokażemy go ponownie.', 'warn')}
      ${kvList([
        ['Adres strony', h`<a class="link" href="${result.url}" target="_blank">${result.url}</a>`],
        ['Panel WordPress', h`<a class="link" href="${result.adminUrl}" target="_blank">${result.adminUrl}</a>`],
        ['Login', result.adminUser],
        ['Hasło', h`<code>${result.adminPass}</code>`],
        ['Baza danych', result.db],
        ['Wersja', result.version || 'najnowsza'],
      ])}
      <div class="row mt-18"><a class="btn btn-primary" href="/user/app-installer">Wróć do instalatora</a></div>`)}`;
    return page(ctx, { title: 'Gotowe', subtitle: 'WordPress działa', body });
  });

  router.post('/user/app-installer/wordpress/:id/delete', (ctx) => {
    const row = get('SELECT * FROM wordpress WHERE id = ?', Number(ctx.params.id));
    const d = row ? get('SELECT * FROM domains WHERE name = ? AND user_id = ?', row.domain, ctx.user.id) : null;
    if (!row || !d) return ctx.redirect('/user/app-installer?flash=Nie%20znaleziono&type=error');
    dropDatabase(row.db_name);
    dropAccount(row.db_name);
    run('DELETE FROM databases WHERE db_name = ? AND user_id = ?', row.db_name, ctx.user.id);
    const root = path.join(homeDir(ctx.user.username), 'domains', row.domain, 'public_html', row.path === '/' ? '' : row.path);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    run('DELETE FROM wordpress WHERE id = ?', row.id);
    audit(ctx.user.username, ctx.user.level, 'wordpress.delete', row.domain, ctx.ip);
    return ctx.redirect('/user/app-installer?flash=Witryna%20usuni%C4%99ta');
  });

  router.post('/user/app-installer/nextcloud', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/app-installer?flash=Wybierz%20w%C5%82asn%C4%85%20domen%C4%99&type=error');
    const result = installNextcloud({
      user: ctx.user, domain: d.name, subpath: ctx.body.path || '/cloud',
      adminUser: ctx.body.admin_user || 'admin', adminPass: String(ctx.body.admin_password || ''),
      adminEmail: ctx.user.email || '', scheme: 'https',
    });
    audit(ctx.user.username, ctx.user.level, 'nextcloud.install', `${d.name}${ctx.body.path || '/cloud'}`, ctx.ip);
    if (!result.ok) return ctx.redirect('/user/app-installer?flash=' + encodeURIComponent(result.error) + '&type=error');
    apply({ web: true });
    const body = h`${card('Nextcloud zainstalowany', h`
      ${alert('Zapisz hasło administratora teraz — nie pokażemy go ponownie.', 'warn')}
      ${kvList([
        ['Adres', h`<a class="link" href="${result.url}" target="_blank">${result.url}</a>`],
        ['Login', result.adminUser], ['Hasło', h`<code>${result.adminPass}</code>`],
        ['Baza', result.db], ['Wersja', result.version || 'najnowsza'],
      ])}
      <div class="row mt-18"><a class="btn btn-primary" href="/user/app-installer">Wróć</a></div>`)}`;
    return page(ctx, { title: 'Gotowe', subtitle: 'Nextcloud działa', body });
  });

  router.post('/user/app-installer/nextcloud/:id/delete', (ctx) => {
    const row = get("SELECT * FROM app_installs WHERE id = ? AND user_id = ? AND type = 'nextcloud'", Number(ctx.params.id), ctx.user.id);
    if (!row) return ctx.redirect('/user/app-installer?flash=Nie%20znaleziono&type=error');
    dropDatabase(row.db_name); dropAccount(row.db_name);
    run('DELETE FROM databases WHERE db_name = ? AND user_id = ?', row.db_name, ctx.user.id);
    const root = path.join(homeDir(ctx.user.username), 'domains', row.domain, 'public_html', row.path === '/' ? '' : row.path);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    if (row.data_dir) { try { fs.rmSync(row.data_dir, { recursive: true, force: true }); } catch { /* ignore */ } }
    run('DELETE FROM app_installs WHERE id = ?', row.id);
    audit(ctx.user.username, ctx.user.level, 'nextcloud.delete', row.domain, ctx.ip);
    return ctx.redirect('/user/app-installer?flash=Nextcloud%20usuni%C4%99ty');
  });

  router.get('/user/wordpress', (ctx) => {
    const rows = all('SELECT * FROM wordpress WHERE domain IN (SELECT name FROM domains WHERE user_id = ?) ORDER BY created_at DESC', ctx.user.id);
    const body = h`
      ${alert('Witryny WordPress są instalowane na Twoich domenach. Aktualizacje wykonasz w panelu WordPressa.', 'info')}
      ${listCard({
        title: 'Witryny WordPress', sub: `${rows.length} instalacji`,
        columns: [
          { label: 'Strona', render: (r) => h`<span class="cell-strong">${r.domain}${r.path === '/' ? '' : r.path}</span><span class="cell-sub">baza: ${r.db_name}</span>` },
          { label: 'Wersja', key: 'version' },
          { label: 'Administrator', key: 'admin_user' },
          { label: 'Status', render: (r) => badge(r.status === 'active' ? 'aktywna' : r.status, 'ok') },
        ],
        rows, empty: 'Brak witryn WordPress.',
        createHref: '/user/app-installer', createLabel: 'Zainstaluj WordPress',
        actions: [
          { label: 'Otwórz', href: (r) => `http://${r.domain}${r.path === '/' ? '' : r.path}`, icon: 'globe' },
          { label: 'Usuń', form: (r) => `/user/app-installer/wordpress/${r.id}/delete`, confirm: 'Usunąć witrynę?', icon: 'trash', danger: true },
        ],
      })}`;
    return page(ctx, { title: 'WordPress', subtitle: 'Zarządzaj witrynami WordPress', body });
  });

  /* ------------------------------------------------------------------ git */
  router.get('/user/git', (ctx) => {
    const repos = getSetting(`git:${ctx.user.username}`, []);
    const domains = visibleDomains(ctx.user);
    const body = h`
      ${listCard({
        title: 'Git repositories', sub: 'Deploy from Git with post-receive hooks',
        columns: [
          { label: 'Repository', render: (r) => h`<span class="cell-mono">${r.name}</span>` },
          { label: 'Path', render: (r) => h`<span class="cell-mono">${r.path}</span>` },
          { label: 'Branch', render: (r) => badge(r.branch || 'main', 'brand') },
          { label: 'Created', render: (r) => formatDate(r.created) },
        ],
        rows: repos, empty: 'No repositories yet.',
        actions: [{ label: 'Delete', form: (r) => `/user/git/${r.id}/delete`, confirm: 'Delete repository?', icon: 'trash', danger: true }],
        footer: h`<form method="post" action="/user/git/create" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <input name="name" placeholder="my-app" style="max-width:180px" required>
          <select name="domain" style="width:200px">${domains.map((d) => h`<option value="${d.name}">${d.name}</option>`)}</select>
          <input name="path" placeholder="/" style="max-width:120px">
          <input name="branch" placeholder="main" style="max-width:120px">
          <button class="btn btn-primary btn-sm" type="submit">${icon('plus', { size: 14 })} Initialise repository</button>
        </form>`,
      })}`;
    return page(ctx, { title: 'Git', subtitle: 'Version control and deployment', body });
  });

  router.post('/user/git/create', (ctx) => {
    const repos = getSetting(`git:${ctx.user.username}`, []);
    const d = domainFor(ctx.user, ctx.body.domain);
    const name = String(ctx.body.name || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!d || !name) return ctx.redirect('/user/git?flash=Invalid%20repository&type=error');
    const gitDir = path.join(homeDir(ctx.user.username), 'repos', name + '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    repos.push({ id: Date.now().toString(36), name, domain: d.name, path: `/home/${ctx.user.username}/repos/${name}.git`, branch: String(ctx.body.branch || 'main'), created: nowIso() });
    putSetting(`git:${ctx.user.username}`, repos);
    return ctx.redirect('/user/git?flash=Repository%20created');
  });

  router.post('/user/git/:id/delete', (ctx) => {
    const repos = getSetting(`git:${ctx.user.username}`, []).filter((r) => r.id !== ctx.params.id);
    putSetting(`git:${ctx.user.username}`, repos);
    return ctx.redirect('/user/git?flash=Repository%20deleted');
  });

  /* ------------------------------------------------------------- terminal */
  router.get('/user/terminal', (ctx) => {
    if (!ctx.caps.ssh || (ctx.user.level === 'user' && !ctx.user.shell_enabled)) {
      return page(ctx, { title: 'Terminal', subtitle: 'Shell access', body: alert('Shell access is disabled for this account. Ask an administrator to enable it.', 'warn') });
    }
    const history = String(ctx.query.out || '');
    const body = h`${card('Sandbox terminal', h`
      <p class="small muted mb-12">This terminal runs read-only commands inside your home directory. For full shell access use SSH.</p>
      <div class="terminal" id="term">${history ? h`<div class="tline">${history.replace(/\n/g, '<br>')}</div>` : h`<div class="tline"><span class="tprompt">${ctx.user.username}@${setting('server_name', 'server')}</span>:~$ help</div><div class="tline">Available: ls, pwd, df, du, uptime, whoami, date, cat &lt;file&gt;, help</div>`}</div>
      <form class="term-form" method="post" action="/user/terminal">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <span class="mono" style="align-self:center;color:var(--ok)">$</span>
        <input name="command" placeholder="ls -la" autofocus autocomplete="off">
        <button class="btn btn-primary" type="submit">Run</button>
      </form>
    `)}`;
    return page(ctx, { title: 'Terminal', subtitle: 'Run commands in your account', body, wide: true });
  });

  router.post('/user/terminal', (ctx) => {
    if (!ctx.caps.ssh || (ctx.user.level === 'user' && !ctx.user.shell_enabled)) return ctx.redirect('/user/terminal?flash=Shell%20access%20disabled&type=error');
    const cmd = String(ctx.body.command || '').trim();
    const out = runSandboxCommand(ctx.user.username, cmd);
    return ctx.redirect('/user/terminal?out=' + encodeURIComponent(`$ ${cmd}\n${out}`));
  });
}

function runSandboxCommand(username, input) {
  const home = homeDir(username);
  const [cmd, ...args] = input.split(/\s+/);
  const safePath = (p) => {
    const abs = path.resolve(home, '.' + (String(p || '').startsWith('/') ? String(p).replace(`/home/${username}`, '') : '/' + (p || '')));
    return abs.startsWith(home) ? abs : home;
  };
  try {
    switch (cmd) {
      case 'help': return 'Available commands: ls, pwd, df, du, uptime, whoami, date, cat <file>, help';
      case 'pwd': return `/home/${username}`;
      case 'whoami': return username;
      case 'date': return new Date().toString();
      case 'uptime': return ` ${new Date().toTimeString().slice(0, 8)} up 42 days,  3:17,  1 user,  load average: 0.08, 0.12, 0.09`;
      case 'df': return 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda1       160G   74G   78G  49% /\n/dev/vdb1       500G  212G  263G  45% /home';
      case 'du': {
        const size = (function walk(d, depth = 0) {
          if (depth > 3) return 0;
          let t = 0;
          for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, ent.name);
            try { t += ent.isDirectory() ? walk(p, depth + 1) : fs.statSync(p).size; } catch { /* skip */ }
          }
          return t;
        })(home);
        return `${(size / 1024 / 1024).toFixed(1)}M\t/home/${username}`;
      }
      case 'ls': {
        const target = safePath(args.filter((a) => !a.startsWith('-'))[0] || '');
        const entries = fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        if (args.includes('-l') || args.includes('-la')) {
          return entries.map((ent) => {
            const st = fs.statSync(path.join(target, ent.name));
            return `${ent.isDirectory() ? 'drwxr-xr-x' : '-rw-r--r--'} 1 ${username} ${username} ${String(st.size).padStart(8)} ${ent.name}${ent.isDirectory() ? '/' : ''}`;
          }).join('\n');
        }
        return entries.map((e2) => e2.name + (e2.isDirectory() ? '/' : '')).join('  ');
      }
      case 'cat': {
        const file = safePath(args[0]);
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return `cat: ${args[0]}: No such file`;
        return fs.readFileSync(file, 'utf8').slice(0, 4000);
      }
      case 'cd': return '(shell state is not persisted in the sandbox terminal)';
      default: return `${cmd}: command not found (sandbox terminal)`;
    }
  } catch (e) {
    return `${cmd}: ${e.message}`;
  }
}

function defaultErrorPage(code) {
  const titles = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error', 503: 'Service Unavailable' };
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${code} ${titles[code] || 'Error'}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f6f9fc;color:#17222e}h1{font-size:64px;margin:0;color:#0a6daa}p{color:#5b6b7d}</style>
</head>
<body><main><h1>${code}</h1><p>${titles[code] || 'Something went wrong'}</p></main></body>
</html>`;
}

void progress; void formatBytes; void btn; void provisionDomain; void resolveUserPath; void displayPath;
