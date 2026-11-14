// Administrator PostgreSQL databases.
import { html as h } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, form, field, kvList } from '../ui/components.mjs';
import { overview, create, drop, changePassword } from '../postgres.mjs';
import { get } from '../db.mjs';

const A = '/admin/postgres';

export function register(router) {
  router.get(A, async (ctx) => {
    const ov = overview();
    const users = (await import('../db.mjs')).all("SELECT username FROM users WHERE level IN ('user','reseller') ORDER BY username");
    const body = h`
      ${!ov.status.ready ? alert(`PostgreSQL nie jest gotowy. ${ov.status.installed ? 'Usługa nie odpowiada.' : 'Zainstaluj: <code>apt install postgresql</code>.'}`, 'warn') : ''}
      ${card('Utwórz bazę', form([
        field({ name: 'owner', label: 'Właściciel', type: 'select', options: users.map((u) => u.username) }),
        field({ name: 'dbName', label: 'Nazwa bazy', required: true, placeholder: 'klient1_app' }),
        field({ name: 'password', label: 'Hasło (opcjonalnie)', type: 'password' }),
      ], { action: `${A}/create`, csrf: ctx.csrf, submit: 'Utwórz bazę' }), { sub: 'Tworzy rolę PostgreSQL i bazę właściciela; hasło pokazywane raz.' })}
      ${card('Bazy PostgreSQL', table({
        columns: [{ label: 'Baza', key: 'db_name' }, { label: 'Właściciel', key: 'username' }, { label: 'Rola', key: 'db_user' }, { label: 'Rozmiar', render: (r) => `${r.size_mb} MB` }],
        rows: ov.rows,
        actions: [
          { label: 'Hasło', href: (r) => `${A}/${r.id}/password`, icon: 'key' },
          { label: 'Usuń', form: (r) => `${A}/${r.id}/delete`, icon: 'trash', danger: true, confirm: 'Usunąć bazę?' },
        ],
        empty: 'Brak baz PostgreSQL.',
      }), { padded: false })}
      ${kvList([['Host', ov.host], ['Port', String(ov.port)], ['Wersja', ov.status.version || '—']])}`;
    return page(ctx, { title: 'PostgreSQL', subtitle: 'Bazy i role (opcjonalne)', body, wide: true });
  });
  router.post(`${A}/create`, (ctx) => {
    const r = create(ctx.body.owner, { dbName: ctx.body.dbName, password: ctx.body.password }, ctx.user.username);
    if (!r.ok) return ctx.redirect(`${A}?flash=${encodeURIComponent(r.error)}&type=error`);
    const body = h`${card('Baza utworzona', h`${kvList([['Baza', r.dbName], ['Rola', r.role], ['Hasło', h`<code>${r.password}</code>`]])}${r.simulated ? alert('Sandbox — operacja symulowana.', 'info') : ''}<a class="btn btn-primary mt-18" href="${A}">Wróć</a>`)}`;
    return page(ctx, { title: 'PostgreSQL', subtitle: 'Zapisz hasło', body });
  });
  router.get(`${A}/:id/password`, (ctx) => {
    const row = get('SELECT * FROM postgres_databases WHERE id = ?', Number(ctx.params.id));
    if (!row) return ctx.redirect(`${A}?flash=Not%20found&type=error`);
    const body = h`${card(`Hasło PostgreSQL · ${row.db_name}`, h`<form method="post" action="${A}/${row.id}/password" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid"><div class="field field-full"><label class="field-label">Nowe hasło</label><input name="password" type="password" minlength="8" required></div></div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Zmień hasło</button><a class="btn btn-ghost" href="${A}">Anuluj</a></div></form>`)}`;
    return page(ctx, { title: 'PostgreSQL password', subtitle: row.db_name, body });
  });

  router.post(`${A}/:id/password`, (ctx) => {
    const r = changePassword(ctx.params.id, ctx.body.password, ctx.user.username);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(r.ok ? 'Hasło zmienione' : r.error)}${r.ok ? '' : '&type=error'}`);
  });

  router.post(`${A}/:id/delete`, (ctx) => {
    const r = drop(ctx.params.id, ctx.user.username);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(r.ok ? 'Baza usunięta' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
}
