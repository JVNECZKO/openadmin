// WebDisk account UI and WebDAV endpoint.
import { html as h, formatDate } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, alert, form, field } from '../ui/components.mjs';
import { visibleDomains } from '../core/access.mjs';
import { listWebdisks, createWebdisk, deleteWebdisk, handleWebdisk } from '../webdisk.mjs';

const A = '/user/webdisk';

export function register(router) {
  router.any('/webdisk', (ctx) => handleWebdisk(ctx));
  router.any('/webdisk/*', (ctx) => handleWebdisk(ctx));

  router.get(A, (ctx) => {
    const domains = visibleDomains(ctx.user);
    const rows = listWebdisks(ctx.user.id);
    const body = h`
      ${alert('WebDisk to WebDAV. Podłącz go w Finderze/Eksploratorze jako https://host:2222/webdisk/ z loginem i hasłem konta WebDisk.', 'info')}
      ${card('Nowe konto WebDisk', form([
        field({ name: 'domain', label: 'Domena', type: 'select', options: domains.map((d) => d.name) }),
        field({ name: 'subpath', label: 'Podkatalog (opcjonalnie)', placeholder: 'np. files' }),
        field({ name: 'password', label: 'Hasło (opcjonalnie, min. 8)', type: 'password' }),
      ], { action: `${A}/create`, csrf: ctx.csrf, submit: 'Utwórz WebDisk' }))}
      ${card('Konta WebDisk', table({
        columns: [{ label: 'Login', render: (r) => h`<span class="cell-mono">${r.username}</span>` }, { label: 'Domena', key: 'domain' }, { label: 'Katalog', render: (r) => h`<span class="cell-mono small">${r.path}</span>` }, { label: 'Utworzono', render: (r) => formatDate(r.created_at) }],
        rows,
        actions: [{ label: 'Usuń', form: (r) => `${A}/${r.id}/delete`, icon: 'trash', danger: true, confirm: 'Usunąć konto WebDisk?' }],
        empty: 'Brak kont WebDisk.',
      }), { padded: false })}`;
    return page(ctx, { title: 'WebDisk (WebDAV)', subtitle: 'Dostęp do plików jak dysk sieciowy', body, wide: true });
  });
  router.post(`${A}/create`, (ctx) => {
    const r = createWebdisk(ctx.user, { domain: ctx.body.domain, subpath: ctx.body.subpath, password: ctx.body.password }, ctx.user.username);
    if (!r.ok) return ctx.redirect(`${A}?flash=${encodeURIComponent(r.error)}&type=error`);
    const body = h`${card('WebDisk utworzony', h`<p>URL: <code>https://${ctx.req.headers.host}/webdisk/</code></p><p>Login: <code>${r.username}</code></p><p>Hasło: <code>${r.password}</code></p><p class="small muted">Zapisz hasło teraz.</p><a class="btn btn-primary mt-18" href="${A}">Wróć</a>`)}`;
    return page(ctx, { title: 'WebDisk', subtitle: 'Zapisz dane', body });
  });
  router.post(`${A}/:id/delete`, (ctx) => {
    const r = deleteWebdisk(ctx.params.id, ctx.user, ctx.user.username);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(r.ok ? 'Usunięto' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
}
