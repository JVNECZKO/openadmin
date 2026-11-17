// Admin page and fallbacks for the bundled web applications.
import crypto from 'node:crypto';
import { html as h, formatDate } from '../util.mjs';
import { audit, setting } from '../db.mjs';
import { panelSecret } from '../config.mjs';
import { page } from '../ui/respond.mjs';
import { card, btn, badge, alert, kvList, table, emptyState } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { listCard } from '../ui/pages/list.mjs';
import { consumeSsoToken } from '../secrets.mjs';
import { APPS, status, statusAll, install, start, stop, logs, phpFpmConfigs, deployPhpFpm, enablePhpMyAdminSso, phpMyAdminSsoEnabled, roundcubePreflight, setRoundcubeImapHost } from '../apps.mjs';

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

/** Loopback check based on the actual socket, not a spoofable header. */
function fromLoopback(ctx) {
  const address = String(ctx.req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return address === '127.0.0.1' || address === '::1';
}

/** SEC-011 handshake: validate the service secret, then atomically consume. */
function phpMyAdminCredentials(ctx) {
  if (!fromLoopback(ctx)) return { status: 403, json: { ok: false, code: 'loopback', error: 'Loopback only' } };
  if (!safeEqual(ctx.req.headers['x-openadmin-secret'], panelSecret())) {
    return { status: 403, json: { ok: false, code: 'service', error: 'Invalid service secret' } };
  }
  const result = consumeSsoToken(String(ctx.body.token || ''), {
    sessionToken: ctx.body.session ? String(ctx.body.session) : null,
  });
  if (!result.ok) {
    const statusCode = result.code === 'db_missing' ? 404 : result.code === 'no_credential' ? 409 : 403;
    return { status: statusCode, json: { ok: false, code: result.code, error: result.error } };
  }
  return { json: { ok: true, username: result.username, password: result.password, db: result.db } };
}

function appRow(ctx, st) {
  const runnable = st.installed && !st.missingExtensions.length;
  return h`<div class="app-row">
    <div class="app-icon">${icon(st.id === 'phpmyadmin' ? 'database' : 'mail', { size: 20 })}</div>
    <div class="app-row-body">
      <strong>${st.name} <span class="small muted">${st.version || st.version === '' ? 'v' + st.version : ''}</span></strong>
      <span class="small muted">${st.description}</span>
      <div class="row u-s79">
        ${st.installed ? badge('zainstalowana', 'ok') : badge('niezainstalowana', 'muted')}
        ${st.running ? badge('działa na :' + st.port, 'brand') : badge('zatrzymana', 'muted')}
        ${st.missingExtensions.length ? badge('brakuje PHP: ' + st.missingExtensions.join(', '), 'warn') : ''}
      </div>
    </div>
    <div class="app-row-actions">
      ${st.running ? (st.id === 'phpmyadmin'
        ? h`<a class="btn btn-secondary btn-sm" href="/user/databases">Wybierz bazę</a>`
        : h`<a class="btn btn-secondary btn-sm" href="/${st.id}/" target="_blank" rel="noopener">Otwórz</a>`) : ''}
      ${!st.installed && ctx.user.level === 'admin' ? h`<form method="post" action="/admin/web-apps/${st.id}/install" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
        <button class="btn btn-primary btn-sm" type="submit">Zainstaluj</button></form>` : ''}
      ${st.installed && !st.running && ctx.user.level === 'admin' ? h`<form method="post" action="/admin/web-apps/${st.id}/start" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
        <button class="btn btn-primary btn-sm" type="submit" ${runnable ? '' : 'disabled'}>Uruchom</button></form>` : ''}
      ${st.running && ctx.user.level === 'admin' ? h`<form method="post" action="/admin/web-apps/${st.id}/stop" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
        <button class="btn btn-ghost btn-sm" type="submit">Zatrzymaj</button></form>` : ''}
    </div>
  </div>`;
}

function fallbackPage(ctx, id) {
  if (!ctx.user) return ctx.redirect(`/login?next=${encodeURIComponent('/' + id + '/')}`);
  const st = status(id);
  const admin = ctx.user && ctx.user.level === 'admin';
  const body = h`${card(`${st.name}`, h`
    ${!st.installed ? alert(`${st.name} nie jest jeszcze zainstalowana na tym serwerze.${admin ? ' Użyj przycisku poniżej, aby pobrać oficjalne wydanie do katalogu danych panelu.' : ' Poproś administratora o instalację w Admin → Aplikacje WWW.'}`, 'info') : ''}
    ${st.installed && st.missingExtensions.length ? alert(`Zainstalowana, ale brakuje PHP: ${st.missingExtensions.join(', ')}. W Debian/Ubuntu zainstaluj <code>php-${st.missingExtensions.join(' php-')}</code>.`, 'warn') : ''}
    ${kvList([
      ['Wersja', st.version || st.version === '' ? 'v' + st.version : 'niezainstalowana'],
      ['Status', st.running ? badge('działa', 'ok') : badge('zatrzymana', 'muted')],
      ['URL', h`<code>/${st.id}/</code>`],
      ['Wymaga', st.requires.join(', ')],
      ['Katalog danych', st.dir],
    ])}
    <div class="row mt-18">
      ${admin && !st.installed ? h`<form method="post" action="/admin/web-apps/${st.id}/install" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
        <button class="btn btn-primary" type="submit">Zainstaluj ${st.name}</button></form>` : ''}
      ${admin && st.installed && !st.running ? h`<form method="post" action="/admin/web-apps/${st.id}/start" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
        <button class="btn btn-primary" type="submit" ${st.missingExtensions.length ? 'disabled' : ''}>Uruchom ${st.name}</button></form>` : ''}
      ${admin ? h`<a class="btn btn-secondary" href="/admin/web-apps">Wszystkie aplikacje</a>` : ''}
      ${!id || id === 'phpmyadmin' ? h`<a class="btn btn-ghost" href="/user/databases">Bazy danych</a>` : h`<a class="btn btn-ghost" href="/user/email">Skrzynki</a>`}
    </div>`)}`;
  return page(ctx, { title: st.name, subtitle: st.description, body });
}

function logTail(id, query = '') {
  const raw = logs(id) || '';
  const needle = String(query || '').toLowerCase();
  const lines = raw.split('\n');
  const filtered = needle ? lines.filter((line) => line.toLowerCase().includes(needle)) : lines;
  const tail = filtered.slice(-40).join('\n');
  return tail || 'Brak wpisów w logu.';
}

export function register(router) {
  // Registered before routes/api.mjs (admin routes are mounted first). This is
  // the only handler allowed to exchange a phpMyAdmin nonce for credentials.
  router.post('/api/phpmyadmin/credentials', (ctx) => phpMyAdminCredentials(ctx));

  // Probe used by the generated nginx fragment (`auth_request`) so a PHP-FPM
  // deployment cannot bypass the panel session gate for /phpmyadmin/.
  router.get('/api/phpmyadmin/session', (ctx) => {
    if (!ctx.user) return { status: 401, json: { ok: false, error: 'Panel session required' } };
    if (ctx.session?.support) return { status: 403, json: { ok: false, error: 'Read-only session' } };
    return { json: { ok: true, user: ctx.user.username, level: ctx.user.level } };
  });

  router.get('/admin/web-apps', (ctx) => {
    const all = statusAll();
    const body = h`
      ${alert('phpMyAdmin i Roundcube są pobierane z oficjalnych archiwów do katalogu danych panelu, konfigurowane lokalnie i udostępniane przez loopback za panelem. Nic nie jest dołączane do repozytorium.', 'info')}
      ${card('Aplikacje', h`${Object.values(all).map((st) => appRow(ctx, st))}`, { sub: 'Instalacja, uruchamianie i zatrzymywanie jednym kliknięciem' })}
      ${card('Środowisko PHP', h`${(() => {
        const exts = all.phpmyadmin?.missingExtensions || [];
        return kvList([
          ['PHP CLI', all.phpmyadmin?.php ? badge('dostępne', 'ok') : badge('brak', 'danger')],
          ['mysqli', all.phpmyadmin?.missingExtensions.includes('mysqli') ? badge('brak', 'danger') : badge('obecne', 'ok')],
          ['imap (Roundcube)', all.roundcube?.missingExtensions.includes('imap') ? badge('brak', 'warn') : badge('obecne', 'ok')],
          ['pdo_sqlite', all.roundcube?.missingExtensions.includes('pdo_sqlite') ? badge('brak', 'warn') : badge('obecne', 'ok')],
        ]);
      })()}`)}
      ${all.phpmyadmin?.installed ? card('Jednokrotne logowanie phpMyAdmin', h`
        ${phpMyAdminSsoEnabled()
          ? alert('SSO jest włączone: strona Bazy danych otwiera phpMyAdmin dla bazy z zapisanymi danymi dostępowymi. Każde przekazanie używa losowego nonce zapisanego tylko jako hash, wygasa po 60 sekundach i jest jednorazowe.', 'ok')
          : alert('Włącz SSO, aby otwierać phpMyAdmin bezpośrednio ze strony Bazy danych. Przekazanie używa jednorazowego nonce, nigdy wielokrotnego tokenu URL.', 'info')}
        <form method="post" action="/admin/web-apps/phpmyadmin/sso"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <button class="btn btn-primary btn-sm" type="submit">${phpMyAdminSsoEnabled() ? 'Wygeneruj ponownie konfigurację SSO' : 'Włącz SSO'}</button></form>`)
        : ''}
      ${card('Logowanie do webmaila', h`
        ${alert('Standardowe wejście do webmaila z listy skrzynek otwiera formularz logowania i wymaga hasła skrzynki. Panel pokazuje ostrzeżenie przed przejściem i nie obiecuje logowania bez hasła; Roundcube również wymaga hasła skrzynki.', 'warn')}
        <p class="small muted">Jeśli skrzynka ma inne hasło niż konto panelu, użyj hasła skrzynki. Administrator/reseller może je zresetować w liście skrzynek.</p>
        <div class="row mt-12">
          <a class="btn btn-secondary btn-sm" href="/webmail" target="_blank" rel="noopener">Otwórz webmail</a>
          ${all.roundcube?.installed ? h`<a class="btn btn-ghost btn-sm" href="/roundcube/" target="_blank" rel="noopener">Otwórz Roundcube</a>` : ''}
        </div>`)}
      ${card('Proxy i nagłówki', h`
        <p class="small muted mb-12">Aplikacje działają na loopbacku, a panel jest jedynym punktem wejścia. Proxy wymaga sesji panelu, usuwa nagłówki hop-by-hop oraz wewnętrzne, nie ujawnia <code>X-Powered-By</code>/<code>Server</code> i przekazuje aplikacji zewnętrzny host oraz schemat.</p>
        ${kvList([
          ['Sesja panelu', badge('wymagana', 'ok')],
          ['Cookie panelu w aplikacji', badge('usuwane', 'ok')],
          ['Nagłówki wewnętrzne', badge('filtrowane', 'ok')],
          ['SSO phpMyAdmin', phpMyAdminSsoEnabled() ? badge('włączone', 'ok') : badge('wyłączone', 'muted')],
        ])}`)}
      ${card('Wdrożenie PHP-FPM', h`<p class="small muted mb-12">W produkcji uruchamiaj phpMyAdmin przez PHP-FPM zamiast serwera deweloperskiego PHP. Wygeneruj pool i fragment nginx, a następnie wdróż na Linuksie jako root.</p>
        <div class="row">
          <form method="post" action="/admin/web-apps/fpm/generate" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
            <button class="btn btn-secondary btn-sm" type="submit">Wygeneruj konfigurację</button></form>
          <form method="post" action="/admin/web-apps/fpm/deploy" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
            <button class="btn btn-primary btn-sm" type="submit">Wdróż do PHP-FPM</button></form>
          <span class="small muted">${ctx.query.fpm ? ctx.query.fpm : ''}</span>
        </div>`)}
      ${Object.values(all).filter((st) => st.installed).map((st) => {
        const activeFilter = String(ctx.query.logapp || '') === st.id ? String(ctx.query.logq || '') : '';
        return card(`${st.name} — log`, h`
          <form method="get" action="/admin/web-apps" class="row u-s48">
            <input type="hidden" name="logapp" value="${st.id}">
            <input class="u-s80" name="logq" value="${activeFilter}" placeholder="Szukaj w logu">
            <button class="btn btn-secondary btn-sm" type="submit">Szukaj</button>
            <a class="btn btn-ghost btn-sm" href="/admin/web-apps/${st.id}/logs/download">Pobierz log</a>
          </form>
          <pre class="code-block">${logTail(st.id, activeFilter)}</pre>
          <p class="small muted">Ostatnie 40 pasujących wpisów; pełny log dostępny przez pobranie.</p>`, {
          actions: [h`<a class="link small" href="/admin/web-apps">Odśwież</a>`],
        });
      })}`;
    return page(ctx, { title: 'Aplikacje WWW', subtitle: 'phpMyAdmin, Roundcube i ich środowisko PHP', body });
  });

  router.get('/admin/web-apps/:id/logs/download', (ctx) => {
    const id = String(ctx.params.id || '');
    if (!APPS[id]) return ctx.redirect('/admin/web-apps?flash=Nieznana aplikacja&type=error');
    const raw = logs(id) || '';
    ctx.res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    ctx.res.setHeader('Content-Disposition', `attachment; filename="${id}.log"`);
    ctx.res.end(raw);
  });

  router.get('/admin/web-apps/roundcube/preflight', (ctx) => {
    const pf = roundcubePreflight();
    const items = [
      ['PHP CLI', pf.php, pf.php ? 'available' : 'PHP nie znaleziono w PATH'],
      ['PHP imap extension', !pf.missingExtensions.includes('imap'), pf.missingExtensions.includes('imap') ? 'Zainstaluj php-imap (Debian/Ubuntu: apt install php-imap)' : 'present'],
      ['PDO SQLite', !pf.missingExtensions.includes('pdo_sqlite'), pf.missingExtensions.includes('pdo_sqlite') ? 'Zainstaluj php-sqlite3' : 'present'],
      ['IMAP server on ' + pf.imapHost, pf.imapReachable, pf.imapReachable ? 'TCP osiągalne' : 'Brak nasłuchu; usługa IMAP panelu nasłuchuje na 127.0.0.1:1143'],
      ['Roundcube files', pf.installed, pf.installed ? 'installed' : 'Zainstaluj w Aplikacje WWW'],
      ['Roundcube config', pf.config, pf.config ? 'config/config.inc.php zapisany' : 'missing'],
    ];
    const body = h`${card('Roundcube preflight', h`${table({
      columns: [
        { label: 'Requirement', render: (r) => h`<span class="cell-strong">${r[0]}</span>` },
        { label: 'Status', render: (r) => (r[1] ? badge('ok', 'ok') : badge('missing', 'danger')) },
        { label: 'Detail', render: (r) => r[2] },
      ],
      rows: items,
    })}${!pf.ready ? alert('Roundcube cannot complete a login until every red item is resolved. The built-in /webmail has no PHP extension dependency.', 'warn') : ''}`, { sub: 'Everything is checked against the host, not assumed' })}
    ${card('IMAP host', h`<form method="post" action="/admin/web-apps/roundcube/imap" class="row">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <input class="u-s28" name="host" value="${pf.imapHost}">
      <button class="btn btn-secondary btn-sm" type="submit">Save &amp; rewrite config</button>
      <span class="small muted">Panel IMAP: localhost:1143 · Dovecot: localhost:143</span>
    </form>`)}
    ${card('Fix commands', h`<pre class="code-block"># Debian / Ubuntu
apt install php-imap php-sqlite3
systemctl restart php8.3-fpm

# The panel's own IMAP service listens on 127.0.0.1:1143 (OA_IMAP_PORT).
# With Dovecot installed, set roundcube_imap_host to localhost:143 instead.</pre>`)}`;
    return page(ctx, { title: 'Roundcube Preflight', subtitle: 'Runtime requirements', body });
  });

  router.post('/admin/web-apps/roundcube/imap', (ctx) => {
    const result = setRoundcubeImapHost(String(ctx.body.host || 'localhost:1143'));
    audit(ctx.user.username, 'admin', 'roundcube.imap', result.host, ctx.ip);
    return ctx.redirect('/admin/web-apps/roundcube/preflight?flash=' + encodeURIComponent(`IMAP host set to ${result.host}`));
  });

  router.post('/admin/web-apps/phpmyadmin/sso', (ctx) => {
    const result = enablePhpMyAdminSso();
    audit(ctx.user.username, 'admin', 'phpmyadmin.sso', result.ok ? 'enabled' : 'failed', ctx.ip);
    return ctx.redirect('/admin/web-apps?flash=' + encodeURIComponent(result.ok ? 'phpMyAdmin SSO configured' : result.error) + (result.ok ? '' : '&type=error'));
  });

  router.post('/admin/web-apps/fpm/generate', (ctx) => {
    const result = phpFpmConfigs();
    return ctx.redirect('/admin/web-apps?fpm=' + encodeURIComponent(`Generated ${result.files.join(', ')} in ${result.dir}`));
  });

  router.post('/admin/web-apps/fpm/deploy', (ctx) => {
    const result = deployPhpFpm();
    audit(ctx.user.username, 'admin', 'app.phpfpm', result.ok ? 'ok' : 'failed', ctx.ip);
    return ctx.redirect('/admin/web-apps?flash=' + encodeURIComponent(result.output) + (result.ok ? '' : '&type=error'));
  });

  router.post('/admin/web-apps/:id/install', async (ctx) => {
    const id = ctx.params.id;
    if (!APPS[id]) return ctx.redirect('/admin/web-apps?flash=Unknown%20application&type=error');
    try {
      const result = await install(id);
      audit(ctx.user.username, 'admin', 'app.install', id, ctx.ip);
      return ctx.redirect('/admin/web-apps?flash=' + encodeURIComponent(result.ok ? `${APPS[id].name} installed` : result.error) + (result.ok ? '' : '&type=error'));
    } catch (e) {
      return ctx.redirect('/admin/web-apps?flash=' + encodeURIComponent(`Install failed: ${e.message}`) + '&type=error');
    }
  });

  router.post('/admin/web-apps/:id/start', (ctx) => {
    const id = ctx.params.id;
    const result = start(id);
    audit(ctx.user.username, 'admin', 'app.start', id, ctx.ip);
    return ctx.redirect('/admin/web-apps?flash=' + encodeURIComponent(result.ok ? `${APPS[id].name} started` : result.error) + (result.ok ? '' : '&type=error'));
  });

  router.post('/admin/web-apps/:id/stop', (ctx) => {
    const id = ctx.params.id;
    stop(id);
    audit(ctx.user.username, 'admin', 'app.stop', id, ctx.ip);
    return ctx.redirect('/admin/web-apps?flash=Stopped');
  });

  // Fallbacks when the app is not running; the proxy in server.mjs handles the
  // live case before routing.
  router.get('/phpmyadmin', (ctx) => fallbackPage(ctx, 'phpmyadmin'));
  router.get('/phpmyadmin/*', (ctx) => fallbackPage(ctx, 'phpmyadmin'));
  router.get('/roundcube', (ctx) => fallbackPage(ctx, 'roundcube'));
  router.get('/roundcube/*', (ctx) => fallbackPage(ctx, 'roundcube'));
}

void formatDate; void table; void emptyState; void setting; void btn;
