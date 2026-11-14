// Administrator PostgreSQL databases.
import { html as h } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, form, field, kvList } from '../ui/components.mjs';
import { overview, create, drop } from '../postgres.mjs';

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
        actions: [{ label: 'Usuń', form: (r) => `${A}/${r.id}/delete`, icon: 'trash', danger: true, confirm: 'Usunąć bazę?' }],
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
  router.post(`${A}/:id/delete`, (ctx) => {
    const r = drop(ctx.params.id, ctx.user.username);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(r.ok ? 'Baza usunięta' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
}
