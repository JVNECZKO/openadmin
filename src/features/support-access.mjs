// Administrator support access links.
import { html as h, formatDate } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, form, field } from '../ui/components.mjs';
import { listSupport, createSupport, revokeSupport, redeemSupport } from '../supportaccess.mjs';
import { serializeCookie } from '../auth.mjs';
import { config } from '../config.mjs';

const A = '/admin/support-access';

export function register(router) {
  router.get(A, (ctx) => {
    const rows = listSupport().map((r) => ({ ...r, expired: new Date(r.expires_at).getTime() < Date.now(), active: !r.revoked_at && new Date(r.expires_at).getTime() >= Date.now() }));
    const body = h`
      ${card('Nowy dostęp dla supportu', form([
        field({ name: 'hours', label: 'Ważność (godziny)', type: 'number', value: 24, min: 1, max: 720 }),
      ], { action: `${A}/create`, csrf: ctx.csrf, submit: 'Wygeneruj link' }))}
      ${alert('Link daje read-only dostęp do panelu administratora i wygasa automatycznie. Nie wysyłaj go publicznie.', 'warn')}
      ${card('Aktywne i historyczne linki', table({
        columns: [
          { label: 'Prefiks', render: (r) => h`<span class="cell-mono">${r.prefix}…</span>` },
          { label: 'Utworzył', key: 'created_by' },
          { label: 'Wygasa', render: (r) => formatDate(r.expires_at, { time: true }) },
          { label: 'Ostatnio użyty', render: (r) => r.last_used_at ? formatDate(r.last_used_at, { time: true }) : '—' },
          { label: 'Status', render: (r) => r.revoked_at ? badge('unieważniony', 'muted') : r.expired ? badge('wygasł', 'muted') : badge('aktywny', 'ok') },
        ],
        rows,
        actions: [{ label: 'Unieważnij', form: (r) => `${A}/${r.id}/revoke`, icon: 'trash', danger: true, show: (r) => !r.revoked_at, confirm: 'Unieważnić link?' }],
        empty: 'Brak linków support access.',
      }), { padded: false })}`;
    return page(ctx, { title: 'Support Access', subtitle: 'Czasowy read-only dostęp dla wsparcia', body, wide: true });
  });

  router.post(`${A}/create`, (ctx) => {
    const r = createSupport({ hours: ctx.body.hours, createdBy: ctx.user.username });
    const url = `/support/${r.token}`;
    const body = h`${card('Link support access', h`${alert('Kopia linku nie będzie już pokazana.', 'warn')}
      <pre class="code-block">${url}</pre>
      <p class="small muted">Ważny do ${formatDate(r.expires, { time: true })}. Otwórz w trybie prywatnym.</p>
      <div class="row mt-18"><a class="btn btn-primary" href="${A}">Wróć</a></div>`)}`;
    return page(ctx, { title: 'Support Access', subtitle: 'Nowy link', body });
  });
  router.get('/support/:token', (ctx) => {
    const r = redeemSupport(ctx.params.token, { ip: ctx.ip, ua: ctx.req.headers['user-agent'] || '' });
    if (!r.ok) return page(ctx, { title: 'Support Access', subtitle: 'Link nieaktywny', body: h`${alert(r.error, 'danger')}` });
    ctx.res.setHeader('Set-Cookie', serializeCookie(r.session.token, { secure: ctx.secure }));
    return ctx.redirect('/admin');
  });

  router.post(`${A}/:id/revoke`, (ctx) => { revokeSupport(ctx.params.id, ctx.user.username); return ctx.redirect(`${A}?flash=Link%20uniewa%C5%BCniony`); });
}
