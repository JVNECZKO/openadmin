// Administrator MultiPHP / PHP-FPM / Apache modules manager.
import { all, setting, setSetting } from '../db.mjs';
import { html as h } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, tabs, form, field, kvList } from '../ui/components.mjs';
import { versions, extensions, iniValues, managedIni, saveIni, toggleExtension, fpmSettings, saveFpmSettings, apacheStatus, toggleApacheModule } from '../phpstack.mjs';
import { deployPools } from '../phpfpm.mjs';

const A = '/admin/php';
const INI_FIELDS = [
  ['memory_limit', 'Memory limit'], ['upload_max_filesize', 'Upload max'], ['post_max_size', 'POST max'],
  ['max_execution_time', 'Max execution time'], ['max_input_time', 'Max input time'], ['max_input_vars', 'Max input vars'],
  ['display_errors', 'Display errors'], ['log_errors', 'Log errors'], ['allow_url_fopen', 'allow_url_fopen'],
  ['allow_url_include', 'allow_url_include'], ['date.timezone', 'Timezone'], ['session.gc_maxlifetime', 'Session lifetime'],
  ['opcache.enable', 'OPcache'], ['opcache.memory_consumption', 'OPcache memory'], ['realpath_cache_size', 'Realpath cache'],
];
const FPM_FIELDS = [
  ['pm', 'Process manager'], ['pm.max_children', 'Max children'], ['pm.start_servers', 'Start servers'],
  ['pm.min_spare_servers', 'Min spare'], ['pm.max_spare_servers', 'Max spare'], ['pm.max_requests', 'Max requests'],
  ['pm.process_idle_timeout', 'Idle timeout'], ['request_terminate_timeout', 'Request terminate timeout'], ['rlimit_files', 'rlimit files'],
];

export function register(router) {
  router.get(A, (ctx) => {
    const tab = ['overview', 'ini', 'extensions', 'fpm', 'apache'].includes(String(ctx.query.tab)) ? String(ctx.query.tab) : 'overview';
    const vers = versions();
    const v = String(ctx.query.version || vers[0] || '8.2');
    const users = all("SELECT username FROM users WHERE level IN ('user','reseller') ORDER BY username");
    const user = String(ctx.query.user || users[0]?.username || '');
    const ini = iniValues(v);
    const apache = apacheStatus();
    const body = h`
      ${tabs([
        { key: 'overview', label: 'Przegląd' },
        { key: 'ini', label: 'PHP INI' },
        { key: 'extensions', label: 'Rozszerzenia' },
        { key: 'fpm', label: 'PHP-FPM' },
        { key: 'apache', label: 'Apache' },
      ], tab, { base: A })}
      ${tab === 'overview' ? h`
        ${vers.length ? card('Wersje PHP', table({
          columns: [
            { label: 'Wersja', render: (r) => h`<span class="cell-mono">${r}</span>` },
            { label: 'FPM', render: (r) => badge('php' + r + '-fpm', 'brand') },
            { label: 'Domyślna', render: (r) => r === (setting('php_default_version', vers[0])) ? badge('tak', 'ok') : '' },
          ],
          rows: vers,
        }), { padded: false }) : alert('Nie znaleziono /etc/php/*/fpm — PHP-FPM nie jest zainstalowany.', 'warn')}
        ${vers.length ? card('Domyślna wersja PHP', h`<form method="post" action="${A}/default" class="row"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <select name="version">${vers.map((x) => h`<option ${x === setting('php_default_version', vers[0]) ? 'selected' : ''}>${x}</option>`)}</select>
          <button class="btn btn-primary" type="submit">Ustaw domyślną</button></form>
          <p class="small muted mt-12">Nowe domeny dziedziczą tę wersję; istniejące zmienisz w Domeny → PHP.</p>`) : ''}
        ${card('Aktualny stan', kvList([
          ['PHP CLI', setting('php_default_version', vers[0] || 'brak')],
          ['FPM', vers.length ? 'php' + vers[0] + '-fpm' : 'brak'],
          ['Apache', apache.available ? 'wykryty' : 'brak'],
          ['moduły Apache', String(apache.modules.length)],
        ]))}
      ` : ''}
      ${tab === 'ini' ? h`
        ${card('Wersja', h`<form method="get" action="${A}" class="row"><input type="hidden" name="tab" value="ini">
          <select name="version" data-auto-submit>${vers.map((x) => h`<option ${x === v ? 'selected' : ''}>${x}</option>`)}</select></form>`)}
        ${card('INI · PHP ' + v, form(INI_FIELDS.map(([key, label]) => field({ name: key, label, value: ini[key]?.local_value ?? ini[key] ?? '', full: ['display_errors', 'log_errors', 'allow_url_fopen', 'allow_url_include', 'opcache.enable'].includes(key) ? false : false })), { action: `${A}/ini?version=${v}`, csrf: ctx.csrf, submit: 'Zapisz INI' }), { sub: 'Tylko bezpieczna lista dyrektyw; zapis waliduje php-fpm -t i przeładowuje usługę.' })}
        ${managedIni(v) ? card('Zarządzany plik', h`<pre class="code-block">${managedIni(v)}</pre>`) : ''}
      ` : ''}
      ${tab === 'extensions' ? h`
        ${card('Wersja', h`<form method="get" action="${A}" class="row"><input type="hidden" name="tab" value="extensions">
          <select name="version" data-auto-submit>${vers.map((x) => h`<option ${x === v ? 'selected' : ''}>${x}</option>`)}</select></form>`)}
        ${card('Rozszerzenia PHP ' + v, h`<div class="grid grid-3">${extensions(v).map((ext) => h`<div class="service-row"><span class="service-dot on"></span><span class="cell-mono">${ext}</span>
          <form method="post" action="${A}/extensions?version=${v}" class="inline u-s3"><input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="ext" value="${ext}"><input type="hidden" name="enabled" value="0"><button class="btn btn-ghost btn-sm" type="submit">Wyłącz</button></form></div>`)}</div>
          <p class="small muted mt-12">Lista pokazuje aktywne rozszerzenia. Wyłączanie wymaga phpdismod i może wymagać ponownego uruchomienia FPM.</p>`, { padded: true })}
      ` : ''}
      ${tab === 'fpm' ? h`
        ${card('Konto', h`<form method="get" action="${A}" class="row"><input type="hidden" name="tab" value="fpm">
          <select name="user" data-auto-submit>${users.map((u) => h`<option ${u.username === user ? 'selected' : ''}>${u.username}</option>`)}</select></form>`)}
        ${user ? card('Pool FPM · ' + user, form(FPM_FIELDS.map(([key, label]) => field({
          name: key, label, value: fpmSettings(user)[key] ?? '',
          type: key === 'pm' ? 'select' : 'text',
          options: key === 'pm' ? ['ondemand', 'dynamic', 'static'] : undefined,
        })), { action: `${A}/fpm?user=${user}`, csrf: ctx.csrf, submit: 'Zapisz i wdróż pule' }), { sub: 'Zmiany trafiają do /etc/php/<wersja>/fpm/pool.d/openadmin-<user>.conf i są walidowane.' }) : alert('Brak kont użytkowników.', 'warn')}
        <form method="post" action="${A}/fpm/deploy"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-secondary" type="submit">Przebuduj wszystkie pule</button></form>
      ` : ''}
      ${tab === 'apache' ? h`
        ${!apache.available ? alert('Apache nie jest zainstalowany — zarządzanie modułami niedostępne (aktywny może być nginx/OLS).', 'warn') : ''}
        ${apache.available ? card('Moduły Apache', table({
          columns: [{ label: 'Moduł', render: (r) => h`<span class="cell-mono">${r.name}</span>` }, { label: 'Status', render: (r) => badge(r.enabled ? 'włączony' : 'wyłączony', r.enabled ? 'ok' : 'muted') }],
          rows: apache.modules.map((m) => ({ name: m.replace(/_module.*/, ''), enabled: true })),
          actions: [{ label: 'Wyłącz', form: (r) => `${A}/apache/${encodeURIComponent(r.name)}/disable`, icon: 'close', danger: true, confirm: (r) => `Wyłączyć moduł ${r.name}?` }],
          empty: 'Brak modułów.',
        }), { padded: false }) : ''}
        ${apache.available ? card('Włącz moduł', h`<form method="post" action="${A}/apache/enable" class="row"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <input name="module" placeholder="np. headers" required><button class="btn btn-secondary" type="submit">Włącz</button></form>`) : ''}
      ` : ''}`;
    return page(ctx, { title: 'PHP / Web Stack', subtitle: 'MultiPHP, INI, rozszerzenia, FPM i moduły Apache', body, wide: true });
  });

  router.post(`${A}/default`, (ctx) => {
    if (!versions().includes(String(ctx.body.version))) return ctx.redirect(`${A}?flash=Nieznana%20wersja&type=error`);
    setSetting('php_default_version', String(ctx.body.version));
    return ctx.redirect(`${A}?flash=Domyslna%20wersja%20zapisana`);
  });
  router.post(`${A}/ini`, (ctx) => {
    const v = String(ctx.query.version || ctx.body.version || '');
    const r = saveIni(v, ctx.body, ctx.user.username);
    return ctx.redirect(`${A}?tab=ini&version=${encodeURIComponent(v)}&flash=${encodeURIComponent(r.ok ? 'INI zapisane' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/extensions`, (ctx) => {
    const v = String(ctx.query.version || ctx.body.version || '');
    const r = toggleExtension(v, String(ctx.body.ext), String(ctx.body.enabled) === '1', ctx.user.username);
    return ctx.redirect(`${A}?tab=extensions&version=${encodeURIComponent(v)}&flash=${encodeURIComponent(r.ok ? 'Rozszerzenie zaktualizowane' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/fpm`, (ctx) => {
    const username = String(ctx.query.user || ctx.body.user || '');
    const r = saveFpmSettings(username, ctx.body, ctx.user.username);
    return ctx.redirect(`${A}?tab=fpm&user=${encodeURIComponent(username)}&flash=${encodeURIComponent(r.ok ? 'Ustawienia FPM zapisane' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/fpm/deploy`, (ctx) => {
    const r = deployPools();
    return ctx.redirect(`${A}?tab=fpm&flash=${encodeURIComponent(r.ok ? r.output : r.output)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/apache/enable`, (ctx) => {
    const r = toggleApacheModule(String(ctx.body.module), true, ctx.user.username);
    return ctx.redirect(`${A}?tab=apache&flash=${encodeURIComponent(r.ok ? 'Moduł włączony' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/apache/:name/disable`, (ctx) => {
    const r = toggleApacheModule(ctx.params.name, false, ctx.user.username);
    return ctx.redirect(`${A}?tab=apache&flash=${encodeURIComponent(r.ok ? 'Moduł wyłączony' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
}
