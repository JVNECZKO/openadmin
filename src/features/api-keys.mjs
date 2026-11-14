// Administrator API keys and MCP endpoint.
import { all } from '../db.mjs';
import { html as h, formatDate } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, form, field, kvList } from '../ui/components.mjs';
import { listKeys, createKey, revokeKey } from '../apikeys.mjs';

const A = '/admin/api-keys';

export function register(router) {
  router.get(A, (ctx) => {
    const users = all("SELECT id, username, level FROM users WHERE level IN ('admin','reseller','user') ORDER BY username");
    const keys = listKeys();
    const body = h`
      ${card('Nowy klucz API', form([
        field({ name: 'user_id', label: 'Właściciel', type: 'select', options: users.map((u) => ({ value: String(u.id), label: `${u.username} (${u.level})` })) }),
        field({ name: 'name', label: 'Nazwa', required: true, placeholder: 'Automatyzacja / MCP' }),
        field({ name: 'scopes', label: 'Zakres', type: 'select', options: [
          { value: 'read', label: 'read — tylko odczyt' }, { value: 'write', label: 'write — odczyt i zapis' }, { value: 'admin', label: 'admin — pełny dostęp' },
        ] }),
        field({ name: 'allowed_ips', label: 'Dozwolone IP (opcjonalnie, po przecinku)', full: true, placeholder: '203.0.113.7, 198.51.100.0/24' }),
      ], { action: `${A}/create`, csrf: ctx.csrf, submit: 'Wygeneruj klucz' }))}
      ${card('Klucze API', table({
        columns: [
          { label: 'Właściciel', render: (r) => `${r.username}` }, { label: 'Nazwa', key: 'name' },
          { label: 'Prefiks', render: (r) => h`<span class="cell-mono">${r.prefix}…</span>` },
          { label: 'Zakres', render: (r) => JSON.parse(r.scopes || '[]').join(', ') },
          { label: 'IP', render: (r) => JSON.parse(r.allowed_ips || '[]').join(', ') || 'wszystkie' },
          { label: 'Ostatnio', render: (r) => r.last_used_at ? formatDate(r.last_used_at, { time: true }) : '—' },
        ],
        rows: keys,
        actions: [{ label: 'Unieważnij', form: (r) => `${A}/${r.id}/revoke`, icon: 'trash', danger: true, confirm: 'Unieważnić klucz?' }],
        empty: 'Brak kluczy API.',
      }), { padded: false })}
      ${card('MCP', h`${kvList([['Endpoint', h`<code>${ctx.req.headers.host ? `https://${ctx.req.headers.host}/mcp` : '/mcp'}</code>`], ['Autoryzacja', 'Bearer <klucz API>'], ['Narzędzia', '14 read-only (list_domains, list_mailboxes, get_health, …)']])}
        <p class="small muted mt-12">Klient MCP wysyła JSON-RPC 2.0: <code>initialize</code>, <code>tools/list</code>, <code>tools/call</code>. Klucz musi mieć zakres read.</p>`)}
      ${alert('Klucz pokazujemy tylko raz. Jeśli IP allowlist jest pusta, klucz działa z każdego adresu — ustaw IP dla produkcji.', 'warn')}`;
    return page(ctx, { title: 'API Keys & MCP', subtitle: 'Scoped keys for automation and AI clients', body, wide: true });
  });

  router.post(`${A}/create`, (ctx) => {
    const scopes = [String(ctx.body.scopes || 'read')].filter((s) => ['read', 'write', 'admin'].includes(s));
    const ips = String(ctx.body.allowed_ips || '').split(/[\s,]+/).filter(Boolean);
    const r = createKey(ctx.body.user_id, { name: ctx.body.name, scopes, allowedIps: ips }, ctx.user.username);
    if (!r.ok) return ctx.redirect(`${A}?flash=${encodeURIComponent(r.error)}&type=error`);
    const body = h`${card('Klucz utworzony', h`${alert('Zapisz klucz teraz — nie pokaże się ponownie.', 'warn')}
      <pre class="code-block">${r.secret}</pre>
      ${kvList([['Prefiks', r.prefix], ['Zakres', scopes.join(', ')], ['MCP', h`<code>Authorization: Bearer ${r.secret}</code>`]])}
      <div class="row mt-18"><a class="btn btn-primary" href="${A}">Wróć</a></div>`)}`;
    return page(ctx, { title: 'Nowy klucz API', subtitle: 'Zapisz go bezpiecznie', body });
  });
  router.post(`${A}/:id/revoke`, (ctx) => { revokeKey(ctx.params.id, ctx.user.username); return ctx.redirect(`${A}?flash=Klucz%20uniewa%C5%BCniony`); });
}
