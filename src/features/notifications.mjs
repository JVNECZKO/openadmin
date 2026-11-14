// Notification center (admin and user).
import { html as h, formatDate } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, tabs, form, field, emptyState } from '../ui/components.mjs';
import { listNotifications, unreadCount, markRead, markAllRead, channels, saveChannel, deleteChannel, testChannel, testAll } from '../notifications.mjs';

const AP = '/admin/notifications';
const UP = '/user/notifications';

export function register(router) {
  router.get(AP, (ctx) => {
    const tab = String(ctx.query.tab || 'inbox') === 'channels' ? 'channels' : 'inbox';
    const rows = listNotifications(ctx.user.id);
    const body = h`
      ${tabs([{ key: 'inbox', label: 'Powiadomienia', count: unreadCount(ctx.user.id) }, { key: 'channels', label: 'Kanały', count: channels().length }], tab, { base: AP })}
      ${tab === 'inbox' ? h`
        ${card('Skrzynka', h`${rows.length ? table({
          columns: [
            { label: 'Poziom', render: (r) => badge(r.level, ({ ok: 'ok', warn: 'warn', danger: 'danger' })[r.level] || 'brand') },
            { label: 'Tytuł', render: (r) => h`<strong>${r.title}</strong>${r.body ? h`<div class="small muted">${r.body}</div>` : ''}` },
            { label: 'Czas', render: (r) => formatDate(r.created_at, { time: true }) },
            { label: 'Status', render: (r) => r.read_at ? badge('przeczytane', 'muted') : badge('nowe', 'warn') },
          ],
          rows,
          actions: [
            { label: 'Otwórz', href: (r) => r.link || AP, icon: 'eye' },
            { label: 'Oznacz', form: (r) => `${AP}/${r.id}/read`, icon: 'check', show: (r) => !r.read_at },
          ],
          empty: 'Brak powiadomień.',
        }) : emptyState('Brak powiadomień.')}
        <form method="post" action="${AP}/read-all" class="mt-12"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-secondary btn-sm" type="submit">Oznacz wszystkie jako przeczytane</button></form>`, { padded: false })}
      ` : ''}
      ${tab === 'channels' ? h`
        ${card('Dodaj kanał', form([
          field({ name: 'name', label: 'Nazwa', required: true, placeholder: 'Slack ops' }),
          field({ name: 'type', label: 'Typ', type: 'select', options: [
            { value: 'webhook', label: 'Webhook (JSON)' }, { value: 'slack', label: 'Slack' }, { value: 'discord', label: 'Discord' }, { value: 'telegram', label: 'Telegram' }, { value: 'email', label: 'E-mail' },
          ] }),
          field({ name: 'url', label: 'URL webhook / Slack / Discord', full: true }),
          field({ name: 'token', label: 'Telegram bot token' }),
          field({ name: 'chat_id', label: 'Telegram chat ID' }),
          field({ name: 'to', label: 'Adres e-mail' }),
        ], { action: `${AP}/channels`, csrf: ctx.csrf, submit: 'Zapisz kanał' }))}
        ${card('Kanały', table({
          columns: [{ label: 'Nazwa', key: 'name' }, { label: 'Typ', key: 'type' }, { label: 'Aktywny', render: (r) => badge(r.enabled ? 'tak' : 'nie', r.enabled ? 'ok' : 'muted') }],
          rows: channels(),
          actions: [
            { label: 'Test', form: (r) => `${AP}/channels/${r.id}/test`, icon: 'send' },
            { label: 'Usuń', form: (r) => `${AP}/channels/${r.id}/delete`, icon: 'trash', danger: true, confirm: 'Usunąć kanał?' },
          ],
          empty: 'Brak kanałów — powiadomienia zostają w panelu.',
        }), { padded: false })}
        <form method="post" action="${AP}/test-all" class="mt-12"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-secondary" type="submit">Test wszystkich kanałów</button></form>
        ${alert('Kanały zewnętrzne wysyłają tytuł i treść powiadomienia. Nie używaj ich do sekretów.', 'info')}
      ` : ''}`;
    return page(ctx, { title: 'Centrum powiadomień', subtitle: 'Zdarzenia panelu i kanały zewnętrzne', body, wide: true });
  });

  router.post(`${AP}/:id/read`, (ctx) => { markRead(ctx.params.id, ctx.user.id); return ctx.redirect(AP); });
  router.post(`${AP}/read-all`, (ctx) => { markAllRead(ctx.user.id); return ctx.redirect(AP); });
  router.post(`${AP}/channels`, (ctx) => {
    const r = saveChannel(ctx.body, ctx.user.username);
    return ctx.redirect(`${AP}?tab=channels&flash=${encodeURIComponent(r.ok ? 'Kanał zapisany' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${AP}/channels/:id/delete`, (ctx) => { deleteChannel(ctx.params.id); return ctx.redirect(`${AP}?tab=channels&flash=Usuni%C4%99to`); });
  router.post(`${AP}/channels/:id/test`, async (ctx) => {
    const r = await testChannel(ctx.params.id);
    return ctx.redirect(`${AP}?tab=channels&flash=${encodeURIComponent(r.ok ? 'Test wysłany' : r.error)}&type=${r.ok ? 'ok' : 'error'}`);
  });
  router.post(`${AP}/test-all`, async (ctx) => {
    const out = await testAll();
    return ctx.redirect(`${AP}?tab=channels&flash=${encodeURIComponent(out.length ? out.map((x) => `${x.name}: ${x.ok ? 'OK' : x.error}`).join('; ') : 'Brak kanałów')}`);
  });

  router.get(UP, (ctx) => {
    const rows = listNotifications(ctx.user.id);
    const body = h`${card('Powiadomienia', h`${rows.length ? h`<div class="timeline">${rows.map((n) => h`<div class="timeline-item"><div class="timeline-dot">${badge(n.level, 'brand')}</div><div class="timeline-body"><div class="spread"><strong>${n.title}</strong><span class="small muted">${formatDate(n.created_at, { time: true })}</span></div><div class="small">${n.body || ''}</div>${n.link ? h`<a class="link small" href="${n.link}">Otwórz</a>` : ''}</div></div>`)}</div>` : emptyState('Brak powiadomień.')}
      <form method="post" action="${UP}/read-all" class="mt-12"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-secondary btn-sm" type="submit">Oznacz wszystkie jako przeczytane</button></form>`, { padded: false })}`;
    return page(ctx, { title: 'Powiadomienia', subtitle: 'Zdarzenia Twojego konta', body });
  });
  router.post(`${UP}/read-all`, (ctx) => { markAllRead(ctx.user.id); return ctx.redirect(UP); });
  router.post(`${UP}/:id/read`, (ctx) => { markRead(ctx.params.id, ctx.user.id); return ctx.redirect(UP); });
}
