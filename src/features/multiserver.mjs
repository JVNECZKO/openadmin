// Administrator multi-server registry.
import { html as h } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, form, field } from '../ui/components.mjs';
import { nodes, saveNode, deleteNode, testNode, refreshNodes } from '../multiserver.mjs';

const A = '/admin/multiserver';

export function register(router) {
  router.get(A, (ctx) => {
    const list = nodes();
    const editing = ctx.query.edit ? list.find((r) => String(r.id) === String(ctx.query.edit)) : null;
    const body = h`
      ${card('Dodaj node', form([
        field({ name: 'name', label: 'Nazwa', required: true }),
        field({ name: 'url', label: 'URL panelu', required: true, placeholder: 'https://node2.example.com:2222' }),
        field({ name: 'role', label: 'Rola', type: 'select', options: ['web', 'db', 'dns', 'mail', 'backup'] }),
        field({ name: 'token', label: 'API key (opcjonalnie)', type: 'password' }),
      ], { action: `${A}/add`, csrf: ctx.csrf, submit: 'Dodaj node' }))}
      ${editing ? card(`Edytuj node · ${editing.name}`, form([
        field({ name: 'name', label: 'Nazwa', value: editing.name, required: true }),
        field({ name: 'url', label: 'URL', value: editing.url, required: true }),
        field({ name: 'role', label: 'Rola', type: 'select', value: editing.role, options: ['web', 'db', 'dns', 'mail', 'backup'] }),
        field({ name: 'token', label: 'Nowy API key (puste = bez zmian)', type: 'password' }),
      ], { action: `${A}/${editing.id}/update`, csrf: ctx.csrf, submit: 'Zapisz node' })) : ''}
      ${card('Nodes', table({
        columns: [
          { label: 'Nazwa', key: 'name' }, { label: 'URL', render: (r) => h`<span class="cell-mono small">${r.url}</span>` }, { label: 'Rola', key: 'role' },
          { label: 'Status', render: (r) => r.last_status ? badge(String(r.last_status).slice(0, 20), String(r.last_status).startsWith('ok') ? 'ok' : 'danger') : badge('nieznany', 'muted') },
          { label: 'Ostatni test', key: 'last_seen_at' },
        ],
        rows: list,
        actions: [
          { label: 'Edytuj', href: (r) => `${A}?edit=${r.id}`, icon: 'edit' },
          { label: 'Test', form: (r) => `${A}/${r.id}/test`, icon: 'refresh' },
          { label: 'Usuń', form: (r) => `${A}/${r.id}/delete`, icon: 'trash', danger: true, confirm: 'Usunąć node?' },
        ],
        empty: 'Brak zdalnych węzłów. To nie jest klaster — tylko rejestr i health-check.',
      }), { padded: false })}
      <form method="post" action="${A}/refresh" class="mt-12"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-secondary" type="submit">Odśwież wszystkie</button></form>
      ${alert('To rejestr i monitoring. Rzeczywiste wdrożenia na zdalny node wymagają osobnego API/agentа i nie są udawane.', 'info')}`;
    return page(ctx, { title: 'Multi Server', subtitle: 'Rejestr węzłów i health-check', body, wide: true });
  });
  router.post(`${A}/add`, (ctx) => {
    const r = saveNode(ctx.body, ctx.user.username);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(r.ok ? 'Node dodany' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/:id/update`, (ctx) => {
    const r = saveNode({ ...ctx.body, id: ctx.params.id }, ctx.user.username);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(r.ok ? 'Node zapisany' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/:id/test`, async (ctx) => {
    const r = await testNode(ctx.params.id);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(r.ok ? `Node OK ${r.version || ''}` : `Node błąd: ${r.error || r.status}`)}&type=${r.ok ? 'ok' : 'error'}`);
  });
  router.post(`${A}/refresh`, async (ctx) => {
    const out = await refreshNodes();
    return ctx.redirect(`${A}?flash=${encodeURIComponent(out.length ? out.map((x) => `${x.name}: ${x.ok ? 'OK' : 'błąd'}`).join('; ') : 'Brak nodów')}`);
  });
  router.post(`${A}/:id/delete`, (ctx) => { deleteNode(ctx.params.id, ctx.user.username); return ctx.redirect(`${A}?flash=Usuni%C4%99to`); });
}
