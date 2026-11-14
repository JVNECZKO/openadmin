// Unified application catalogue: WordPress, Nextcloud, Joomla, Drupal,
// PrestaShop and Moodle. Native installers for WP/NC, catalogue installers for
// the rest; every tile is backed by a real download, database and installer.
import { html as h, formatDate } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, badge, alert, kvList } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { appIcon } from '../ui/appicons.mjs';
import { visibleDomains } from '../core/access.mjs';
import { all, get } from '../db.mjs';
import { listApps, installedApps, installApp, deleteApp } from '../appcatalog.mjs';

const A = '/user/app-catalog';
const APPS = [
  { key: 'wordpress', name: 'WordPress', desc: 'Strona, blog lub sklep', version: 'najnowsza', native: true },
  { key: 'nextcloud', name: 'Nextcloud', desc: 'Prywatna chmura plików i współpraca', version: '30', native: true },
  ...listApps().map((a) => ({ ...a, native: false })),
];

function installForm(ctx, app, domains) {
  const action = app.native ? `/user/app-installer/${app.key}` : `${A}/install`;
  const path = app.key === 'nextcloud' ? '/' : app.native ? '/' : `/${app.key}`;
  return h`<form method="post" action="${action}" class="oa-form app-install-form">
    <input type="hidden" name="_csrf" value="${ctx.csrf}">
    <input type="hidden" name="app" value="${app.key}">
    <div class="form-grid">
      <div class="field"><label class="field-label">Domena</label><select name="domain" required>${domains.map((d) => h`<option value="${d.name}">${d.name}</option>`)}</select></div>
      <div class="field"><label class="field-label">Ścieżka</label><input name="path" value="${path}" ${app.key === 'nextcloud' ? 'readonly' : ''}></div>
      <div class="field"><label class="field-label">Tytuł</label><input name="title" value="${app.name}"></div>
      <div class="field"><label class="field-label">Hasło administratora</label><input name="admin_password" type="password" minlength="8" required></div>
    </div>
    <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('download', { size: 16 })} Zainstaluj ${app.name}</button></div>
  </form>`;
}

export function register(router) {
  router.get(A, (ctx) => {
    const domains = visibleDomains(ctx.user);
    const installed = installedApps(ctx.user.id);
    const wp = all('SELECT * FROM wordpress WHERE domain IN (SELECT name FROM domains WHERE user_id = ?) ORDER BY created_at DESC', ctx.user.id);
    const nc = all("SELECT * FROM app_installs WHERE user_id = ? AND type = 'nextcloud' ORDER BY created_at DESC", ctx.user.id);
    const installedAll = [
      ...wp.map((r) => ({ ...r, type: 'wordpress', _native: true })),
      ...nc.map((r) => ({ ...r, type: 'nextcloud', _native: true })),
      ...installed.map((r) => ({ ...r, _native: false })),
    ];
    const counts = Object.fromEntries(APPS.map((a) => [a.key, installedAll.filter((r) => r.type === a.key).length]));
    const canInstall = domains.length > 0;
    const body = h`
      ${!canInstall ? alert('Najpierw dodaj domenę — aplikacje instalujemy tylko na Twoich domenach.', 'warn') : ''}
      ${alert('Jeden katalog, sześć aplikacji. Kliknij „Zainstaluj”, uzupełnij dane i gotowe. WordPress i Nextcloud mają natywne instalatory; pozostałe kończą instalację w przeglądarce (Moodle próbuje CLI).', 'info')}
      <div class="app-tile-grid">
        ${APPS.map((a) => h`<article class="app-tile">
          <div class="app-tile-head">
            ${appIcon(a.key, { size: 52 })}
            <div>
              <div class="app-tile-title"><h3>${a.name}</h3>${counts[a.key] ? badge(`${counts[a.key]} zainstalowane`, 'ok') : ''}</div>
              <p class="app-tile-sub">${a.desc}</p>
            </div>
          </div>
          <div class="app-meta"><span>v${a.version}</span><span>${a.native ? 'natywny instalator' : a.mode === 'cli' ? 'CLI + WWW' : 'instalator WWW'}</span><span>PHP + MariaDB</span></div>
          <div class="app-tile-actions">
            <details><summary class="btn btn-primary btn-sm">${icon('download', { size: 15 })} Zainstaluj</summary>${installForm(ctx, a, domains)}</details>
            ${counts[a.key] ? h`<a class="btn btn-ghost btn-sm" href="#twoje-aplikacje">Twoje instalacje (${counts[a.key]})</a>` : ''}
          </div>
        </article>`)}
      </div>
      <div id="twoje-aplikacje" class="mt-24">
        ${card('Twoje aplikacje', h`${installedAll.length ? installedAll.map((r) => h`<div class="app-installed">
          ${appIcon(r.type, { size: 40 })}
          <div><strong>${r.type === 'wordpress' ? 'WordPress' : r.type === 'nextcloud' ? 'Nextcloud' : r.type[0].toUpperCase() + r.type.slice(1)}</strong><p class="app-tile-sub">${r.domain}${r.path && r.path !== '/' ? r.path : ''} · v${r.version || '—'} · admin: ${r.admin_user || 'admin'}</p></div>
          <div class="app-installed-actions">
            ${badge('aktywna', 'ok')}
            <a class="btn btn-secondary btn-sm" href="${r.type === 'wordpress' ? 'http' : 'https'}://${r.domain}${r.path && r.path !== '/' ? r.path : ''}${r.type === 'wordpress' ? '/wp-admin/' : '/'}" target="_blank" rel="noopener">${icon('globe', { size: 15 })} Otwórz</a>
            <form method="post" action="${r.type === 'wordpress' ? `/user/app-installer/wordpress/${r.id}/delete` : r.type === 'nextcloud' ? `/user/app-installer/nextcloud/${r.id}/delete` : `${A}/${r.id}/delete`}" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-danger btn-sm" type="submit" onclick="return confirm('Usunąć aplikację wraz z bazą?')">${icon('trash', { size: 15 })} Usuń</button></form>
          </div>
        </div>`) : h`<div class="app-empty">Nie masz jeszcze aplikacji. Wybierz kafelek powyżej.</div>`}`)}
      </div>`;
    return page(ctx, { title: 'Aplikacje', subtitle: 'WordPress, Nextcloud, PrestaShop, Joomla, Drupal, Moodle — jednym kliknięciem', body, wide: true });
  });

  router.post(`${A}/install`, (ctx) => {
    const app = listApps().find((a) => a.key === ctx.body.app);
    const r = installApp(ctx.body.app, {
      user: ctx.user, domain: ctx.body.domain, subpath: ctx.body.path,
      adminUser: 'admin', adminPass: String(ctx.body.admin_password || ''), title: ctx.body.title,
    });
    if (!r.ok) return ctx.redirect(`${A}?flash=${encodeURIComponent(r.error)}&type=error`);
    const body = h`${card(`${app?.name || ctx.body.app} — instalacja`, h`
      <div class="app-tile-head mb-18">${appIcon(ctx.body.app, { size: 52 })}<div><h3>${app?.name || 'Aplikacja'}</h3><p class="app-tile-sub">${r.mode === 'cli' ? 'Zainstalowana przez CLI' : 'Baza gotowa — dokończ instalator w przeglądarce'}</p></div></div>
      ${r.warning ? alert(r.warning, 'warn') : ''}
      ${r.mode === 'cli' ? alert('Aplikacja zainstalowana przez CLI. Zapisz hasło administratora.', 'ok') : alert('Baza gotowa. Dokończ instalator w przeglądarce.', 'info')}
      ${kvList([['URL', h`<a class="link" href="${r.url}" target="_blank">${r.url}</a>`], ['Baza', r.db], ['DB user', r.dbUser], ['DB hasło', h`<code>${r.dbPass}</code>`], ['Admin', r.adminUser], ['Hasło admina', h`<code>${r.adminPass}</code>`]])}
      <div class="row mt-18"><a class="btn btn-primary" href="${A}">Wróć do aplikacji</a><a class="btn btn-secondary" href="${r.url}" target="_blank">Otwórz instalator</a></div>`)}`;
    return page(ctx, { title: 'Aplikacja', subtitle: 'Dane instalacji', body });
  });
  router.post(`${A}/:id/delete`, (ctx) => {
    const r = deleteApp(ctx.params.id, ctx.user);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(r.ok ? 'Usunięto' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
}
