// WebDisk account UI and WebDAV endpoint.
import { html as h, formatDate } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, alert, form, field } from '../ui/components.mjs';
import { visibleDomains } from '../core/access.mjs';
import { listWebdisks, createWebdisk, deleteWebdisk, handleWebdisk } from '../webdisk.mjs';
import { run, audit } from '../db.mjs';
import { encryptSecret } from '../secrets.mjs';

const A = '/user/webdisk';

export function register(router) {
  router.any('/webdisk', (ctx) => handleWebdisk(ctx));
  router.any('/webdisk/*', (ctx) => handleWebdisk(ctx));

  router.get(A, (ctx) => {
    const domains = visibleDomains(ctx.user);
    const rows = listWebdisks(ctx.user.id);
    const editing = ctx.query.edit ? rows.find((r) => String(r.id) === String(ctx.query.edit)) : null;
    const body = h`
      ${alert(`WebDisk to WebDAV. Podłącz go w Finderze/Eksploratorze jako https://${ctx.req.headers.host}/webdisk/ z loginem i hasłem konta WebDisk.`, 'info')}
      ${card('Nowe konto WebDisk', form([
        field({ name: 'domain', label: 'Domena', type: 'select', options: domains.map((d) => d.name) }),
        field({ name: 'subpath', label: 'Podkatalog (opcjonalnie)', placeholder: 'np. files' }),
        field({ name: 'password', label: 'Hasło (opcjonalnie, min. 8)', type: 'password' }),
      ], { action: `${A}/create`, csrf: ctx.csrf, submit: 'Utwórz WebDisk' }))}
      ${card('Konta WebDisk', table({
        columns: [{ label: 'Login', render: (r) => h`<span class="cell-mono">${r.username}</span>` }, { label: 'Domena', key: 'domain' }, { label: 'Katalog', render: (r) => h`<span class="cell-mono small">${r.path}</span>` }, { label: 'Utworzono', render: (r) => formatDate(r.created_at) }],
        rows,
        actions: [
          { label: 'Edytuj', href: (r) => `${A}?edit=${r.id}`, icon: 'edit' },
          { label: 'Usuń', form: (r) => `${A}/${r.id}/delete`, icon: 'trash', danger: true, confirm: 'Usunąć konto WebDisk?' },
        ],
        empty: 'Brak kont WebDisk.',
      }), { padded: false })}
      ${editing ? card(`Edytuj WebDisk · ${editing.username}`, h`<form method="post" action="${A}/${editing.id}/update" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Login</label><input value="${editing.username}" disabled></div>
          <div class="field"><label class="field-label">Nowe hasło</label><input name="password" type="password" minlength="8" required></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Zmień hasło</button><a class="btn btn-ghost" href="${A}">Anuluj</a></div>
      </form>`) : ''}`;
    return page(ctx, { title: 'WebDisk (WebDAV)', subtitle: 'Dostęp do plików jak dysk sieciowy', body, wide: true });
  });
  router.post(`${A}/create`, (ctx) => {
    const r = createWebdisk(ctx.user, { domain: ctx.body.domain, subpath: ctx.body.subpath, password: ctx.body.password }, ctx.user.username);
    if (!r.ok) return ctx.redirect(`${A}?flash=${encodeURIComponent(r.error)}&type=error`);
    const body = h`${card('WebDisk utworzony', h`<p>URL: <code>https://${ctx.req.headers.host}/webdisk/</code></p><p>Login: <code>${r.username}</code></p><p>Hasło: <code>${r.password}</code></p><p class="small muted">Zapisz hasło teraz.</p><a class="btn btn-primary mt-18" href="${A}">Wróć</a>`)}`;
    return page(ctx, { title: 'WebDisk', subtitle: 'Zapisz dane', body });
  });
  router.post(`${A}/:id/update`, (ctx) => {
    const row = listWebdisks(ctx.user.id).find((r) => r.id === Number(ctx.params.id));
    if (!row) return ctx.redirect(`${A}?flash=Not%20found&type=error`);
    const password = String(ctx.body.password || '');
    if (password.length < 8) return ctx.redirect(`${A}?flash=Password%20must%20be%208%2B%20characters&type=error`);
    run('UPDATE webdisks SET password_enc = ? WHERE id = ?', encryptSecret(password), row.id);
    audit(ctx.user.username, ctx.user.level, 'webdisk.update', row.username, ctx.ip);
    return ctx.redirect(`${A}?flash=Has%C5%82o%20zmienione`);
  });

  router.post(`${A}/:id/delete`, (ctx) => {
    const r = deleteWebdisk(ctx.params.id, ctx.user, ctx.user.username);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(r.ok ? 'Usunięto' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
}
