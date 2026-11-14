// App catalogue: Joomla, Drupal, PrestaShop, Moodle.
import { html as h, formatDate } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, form, field, kvList } from '../ui/components.mjs';
import { visibleDomains } from '../core/access.mjs';
import { listApps, installedApps, installApp, deleteApp } from '../appcatalog.mjs';

const A = '/user/app-catalog';

export function register(router) {
  router.get(A, (ctx) => {
    const domains = visibleDomains(ctx.user);
    const installed = installedApps(ctx.user.id);
    const apps = listApps();
    const body = h`
      ${alert('Joomla i Drupal uruchamiają instalator w przeglądarce po utworzeniu bazy. PrestaShop i Moodle próbują instalacji CLI; jeśli się nie uda, pokażą link do dokończenia — bez fałszywego „gotowe”.', 'info')}
      <div class="grid grid-2">${apps.map((a) => card(a.name, h`
        <p class="small muted">${a.description} · wersja ${a.version}</p>
        <form method="post" action="${A}/install" class="oa-form">
          <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="app" value="${a.key}">
          <div class="form-grid">
            <div class="field"><label class="field-label">Domena</label><select name="domain">${domains.map((d) => h`<option>${d.name}</option>`)}</select></div>
            <div class="field"><label class="field-label">Ścieżka</label><input name="path" value="/${a.key}" required></div>
            <div class="field"><label class="field-label">Tytuł</label><input name="title" value="${a.name}"></div>
            <div class="field"><label class="field-label">Hasło admina</label><input name="admin_password" type="password" minlength="8" required></div>
          </div>
          <div class="form-actions"><button class="btn btn-primary" type="submit">Zainstaluj ${a.name}</button></div>
        </form>`))}</div>
      ${card('Zainstalowane aplikacje', table({
        columns: [
          { label: 'Aplikacja', key: 'type' }, { label: 'Domena', render: (r) => h`${r.domain}${r.path === '/' ? '' : r.path}` },
          { label: 'Wersja', key: 'version' }, { label: 'Status', render: (r) => badge(r.status, r.status === 'active' ? 'ok' : 'warn') },
          { label: 'Data', render: (r) => formatDate(r.created_at) },
        ],
        rows: installed,
        actions: [
          { label: 'Otwórz', href: (r) => `https://${r.domain}${r.path === '/' ? '' : r.path}/`, icon: 'globe' },
          { label: 'Usuń', form: (r) => `${A}/${r.id}/delete`, icon: 'trash', danger: true, confirm: 'Usunąć aplikację i bazę?' },
        ],
        empty: 'Brak aplikacji z katalogu.',
      }), { padded: false })}`;
    return page(ctx, { title: 'Katalog aplikacji', subtitle: 'Joomla, Drupal, PrestaShop, Moodle', body, wide: true });
  });

  router.post(`${A}/install`, (ctx) => {
    const r = installApp(ctx.body.app, {
      user: ctx.user, domain: ctx.body.domain, subpath: ctx.body.path,
      adminUser: 'admin', adminPass: String(ctx.body.admin_password || ''), title: ctx.body.title,
    });
    if (!r.ok) return ctx.redirect(`${A}?flash=${encodeURIComponent(r.error)}&type=error`);
    const body = h`${card(`${ctx.body.app} — instalacja`, h`
      ${r.warning ? alert(r.warning, 'warn') : ''}
      ${r.mode === 'cli' ? alert('Aplikacja zainstalowana przez CLI. Zapisz hasło administratora.', 'ok') : alert('Baza gotowa. Dokończ instalator w przeglądarce.', 'info')}
      ${kvList([['URL', h`<a class="link" href="${r.url}" target="_blank">${r.url}</a>`], ['Baza', r.db], ['DB user', r.dbUser], ['DB hasło', h`<code>${r.dbPass}</code>`], ['Admin', r.adminUser], ['Hasło admina', h`<code>${r.adminPass}</code>`]])}
      <div class="row mt-18"><a class="btn btn-primary" href="${A}">Wróć</a></div>`)}`;
    return page(ctx, { title: 'Aplikacja', subtitle: 'Dane instalacji', body });
  });
  router.post(`${A}/:id/delete`, (ctx) => {
    const r = deleteApp(ctx.params.id, ctx.user);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(r.ok ? 'Usunięto' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
}
