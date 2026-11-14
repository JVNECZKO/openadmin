// Notification center (admin and user).
import { html as h, formatDate, timeAgo } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, badge, alert, tabs, form, field, emptyState, statCard } from '../ui/components.mjs';
import {
  listNotifications, unreadCount, notificationCounts, markRead, deleteNotification, markAllRead,
  channels, saveChannel, deleteChannel, testChannel, testAll, channelFor, channelSummary, safeLink,
} from '../notifications.mjs';

const AP = '/admin/notifications';
const UP = '/user/notifications';
const STATUS_VALUES = ['all', 'unread', 'read'];
const LEVEL_VALUES = ['info', 'ok', 'warn', 'danger'];
const LEVEL_BADGE = {
  info: ['info', 'brand'],
  ok: ['ok', 'ok'],
  warn: ['uwaga', 'warn'],
  danger: ['błąd', 'danger'],
};
const CHANNEL_TYPES = [
  { value: 'webhook', label: 'Webhook (JSON)' },
  { value: 'slack', label: 'Slack' },
  { value: 'discord', label: 'Discord' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'email', label: 'E-mail' },
];

function levelBadge(level) {
  const [label, tone] = LEVEL_BADGE[level] || [String(level || 'info'), 'brand'];
  return badge(label, tone);
}

function csrfField(ctx) {
  return h`<input type="hidden" name="_csrf" value="${ctx.csrf}">`;
}

function normalizeFilters(input = {}) {
  const rawStatus = input.status || input.filter || (String(input.unread || '') === '1' ? 'unread' : '');
  const status = STATUS_VALUES.includes(String(rawStatus || '')) ? String(rawStatus) : 'all';
  const rawLevel = input.level || input.severity || '';
  const level = LEVEL_VALUES.includes(String(rawLevel || '')) ? String(rawLevel) : '';
  return { status, level };
}

function filtersFromBody(ctx) {
  return normalizeFilters({ status: ctx.body.status, level: ctx.body.level });
}

function filterQuery(filters) {
  const p = new URLSearchParams();
  if (filters.status !== 'all') p.set('status', filters.status);
  if (filters.level) p.set('level', filters.level);
  return p.toString();
}

function inboxHref(base, filters) {
  const q = filterQuery(filters);
  return `${base}?tab=inbox${q ? `&${q}` : ''}`;
}

function userHref(base, filters) {
  const q = filterQuery(filters);
  return `${base}${q ? `?${q}` : ''}`;
}

function liveUrl(filters) {
  const p = new URLSearchParams({ limit: '50' });
  if (filters.status !== 'all') p.set('status', filters.status);
  if (filters.level) p.set('level', filters.level);
  return `/api/v1/notifications?${p.toString()}`;
}

function filterHidden(filters) {
  return h`<input type="hidden" name="status" value="${filters.status}">${filters.level ? h`<input type="hidden" name="level" value="${filters.level}">` : ''}`;
}

function filterForm(ctx, base, filters, { tab = false } = {}) {
  return h`<form method="get" action="${base}" class="toolbar" data-live-filters>
    ${tab ? h`<input type="hidden" name="tab" value="inbox">` : ''}
    <div class="toolbar-left">
      <label class="small muted" for="nf_status">Status</label>
      <select id="nf_status" name="status" data-autosubmit>
        <option value="all" ${filters.status === 'all' ? h`selected` : ''}>Wszystkie</option>
        <option value="unread" ${filters.status === 'unread' ? h`selected` : ''}>Nieprzeczytane</option>
        <option value="read" ${filters.status === 'read' ? h`selected` : ''}>Przeczytane</option>
      </select>
      <label class="small muted" for="nf_level">Poziom</label>
      <select id="nf_level" name="level" data-autosubmit>
        <option value="">Wszystkie</option>
        ${LEVEL_VALUES.map((level) => h`<option value="${level}" ${filters.level === level ? h`selected` : ''}>${level}</option>`)}
      </select>
      <button class="btn btn-secondary btn-sm" type="submit">Filtruj</button>
      <a class="btn btn-ghost btn-sm" href="${tab ? `${base}?tab=inbox` : base}">Wyczyść</a>
    </div>
    <div class="toolbar-right"><span class="small muted" data-live-indicator>Odświeżanie na żywo: 15 s · ostatnie 50</span> <span class="small muted" data-live-meta></span></div>
  </form>`;
}

function emptyInbox(filters) {
  if (filters.status === 'unread') return emptyState('Brak nieprzeczytanych powiadomień.');
  if (filters.status === 'read') return emptyState('Brak przeczytanych powiadomień.');
  return emptyState('Brak powiadomień.');
}

/* ------------------------------------------------------------- admin inbox */

function notificationRow(ctx, n, base, filters, { readOnly = false } = {}) {
  const unread = !n.read_at;
  const link = safeLink(n.link);
  return h`<tr data-notification-id="${n.id}" data-unread="${unread ? '1' : '0'}">
    <td>${levelBadge(n.level)}</td>
    <td>
      <div class="spread">
        <strong class="${unread ? '' : 'muted'}">${n.title}</strong>
        <span>${unread ? badge('nowe', 'warn') : badge('przeczytane', 'muted')}</span>
      </div>
      ${n.body ? h`<div class="small muted">${n.body}</div>` : ''}
      ${n.user_id === null || n.user_id === undefined ? h`<div class="small muted">Powiadomienie systemowe</div>` : ''}
    </td>
    <td class="small muted">${formatDate(n.created_at, { time: true })}</td>
    <td class="col-actions"><div class="row-actions">
      ${link ? h`<a class="btn btn-ghost btn-sm" href="${link}">Otwórz</a>` : ''}
      ${!readOnly && unread ? h`<form method="post" action="${base}/${n.id}/read" class="inline">${csrfField(ctx)}${filterHidden(filters)}<button class="btn btn-secondary btn-sm" type="submit">Oznacz</button></form>` : ''}
      ${!readOnly ? h`<form method="post" action="${base}/${n.id}/delete" class="inline" data-confirm="Usunąć powiadomienie?">${csrfField(ctx)}${filterHidden(filters)}<button class="btn btn-ghost btn-sm" type="submit">Usuń</button></form>` : ''}
    </div></td>
  </tr>`;
}

function notificationTable(ctx, rows, base, filters, { readOnly = false } = {}) {
  if (!rows.length) return emptyInbox(filters);
  return h`<div class="table-wrap">
    <table class="data-table" data-notifications-table>
      <thead><tr><th>Poziom</th><th>Powiadomienie</th><th>Czas</th><th class="col-actions">Akcje</th></tr></thead>
      <tbody>${rows.map((n) => notificationRow(ctx, n, base, filters, { readOnly }))}</tbody>
    </table>
  </div>`;
}

function adminInbox(ctx, filters) {
  const counts = notificationCounts(ctx.user.id);
  const ch = channelSummary();
  const rows = listNotifications(ctx.user.id, 100, filters);
  const readOnly = !!ctx.session?.support;
  return h`
    <div class="stat-grid">
      ${statCard({ label: 'Nieprzeczytane', value: counts.unread, sub: 'w panelu', icon: 'bell', tone: counts.unread ? 'warn' : 'ok' })}
      ${statCard({ label: 'Wszystkie', value: counts.total, sub: 'widoczne dla tego konta', icon: 'list', tone: 'brand' })}
      ${statCard({ label: 'Kanały zewnętrzne', value: `${ch.enabled}/${ch.total}`, sub: ch.total ? 'aktywne / wszystkie' : 'brak skonfigurowanych', icon: 'plug', tone: ch.enabled ? 'ok' : 'muted', href: `${AP}?tab=channels` })}
    </div>
    <section class="card" data-auto-refresh="15" data-auto-refresh-unit="seconds"
      data-live-url="${liveUrl(filters)}" data-live-stream="/api/v1/notifications/stream?limit=50"
      data-live-interval="15" data-live-field="unread" data-live-target="#notif_live_unread"
      data-live-scope="notifications">
      <header class="card-head">
        <div><h2>Skrzynka</h2><p>Zdarzenia panelu, automatyzacji i kanałów zewnętrznych.</p></div>
        <div class="card-actions">
          <span class="small muted">Nieprzeczytane: <strong id="notif_live_unread" data-live-value>${counts.unread}</strong></span>
          ${!readOnly && counts.unread ? h`<form method="post" action="${AP}/read-all" class="inline">${csrfField(ctx)}${filterHidden(filters)}<button class="btn btn-secondary btn-sm" type="submit">Oznacz wszystkie (${counts.unread})</button></form>` : ''}
        </div>
      </header>
      <div class="card-body flush">
        ${filterForm(ctx, AP, filters, { tab: true })}
        ${readOnly ? alert('Dostęp wsparcia jest tylko do odczytu — nie możesz oznaczać ani usuwać powiadomień.', 'info') : ''}
        ${notificationTable(ctx, rows, AP, filters, { readOnly })}
      </div>
    </section>`;
}

/* ---------------------------------------------------------- admin channels */

function channelFields(editing = null, readOnly = false) {
  return [
    field({ name: 'name', label: 'Nazwa', required: true, placeholder: 'Slack ops', value: editing?.name || '', disabled: readOnly }),
    field({ name: 'type', label: 'Typ', type: 'select', value: editing?.type || 'webhook', options: CHANNEL_TYPES, disabled: readOnly }),
    field({ name: 'url', label: 'URL webhook / Slack / Discord', full: true, value: editing?.config?.url || '', disabled: readOnly }),
    field({ name: 'token', label: 'Telegram bot token', value: editing?.config?.token || '', disabled: readOnly }),
    field({ name: 'chat_id', label: 'Telegram chat ID', value: editing?.config?.chat_id || '', disabled: readOnly }),
    field({ name: 'to', label: 'Adres e-mail', value: editing?.config?.to || '', disabled: readOnly }),
    field({ name: 'enabled_present', type: 'hidden', value: '1' }),
    field({ name: 'enabled', type: 'checkbox', label: 'Kanał aktywny', value: editing ? !!editing.enabled : true, disabled: readOnly }),
  ];
}

function channelTable(ctx, rows, { readOnly = false } = {}) {
  if (!rows.length) return emptyState('Brak kanałów — powiadomienia zostają w panelu.');
  return h`<div class="table-wrap">
    <table class="data-table" data-notification-channels>
      <thead><tr><th>Nazwa</th><th>Typ</th><th>Status</th><th>Utworzono</th><th class="col-actions">Akcje</th></tr></thead>
      <tbody>${rows.map((ch) => h`<tr data-channel-id="${ch.id}" data-enabled="${ch.enabled ? '1' : '0'}">
        <td><strong>${ch.name}</strong></td>
        <td>${badge(ch.type, 'brand')}</td>
        <td>${ch.enabled ? badge('Aktywny', 'ok', { dot: true }) : badge('Nieaktywny', 'muted', { dot: true })}</td>
        <td class="small muted">${formatDate(ch.created_at, { time: true })}</td>
        <td class="col-actions"><div class="row-actions">
          ${!readOnly ? h`<a class="btn btn-ghost btn-sm" href="${AP}?tab=channels&edit=${ch.id}">Edytuj</a>` : ''}
          ${!readOnly ? h`<form method="post" action="${AP}/channels/${ch.id}/test" class="inline">${csrfField(ctx)}<button class="btn btn-secondary btn-sm" type="submit">Test</button></form>` : ''}
          ${!readOnly ? h`<form method="post" action="${AP}/channels/${ch.id}/delete" class="inline" data-confirm="Usunąć kanał?">${csrfField(ctx)}<button class="btn btn-ghost btn-sm" type="submit">Usuń</button></form>` : ''}
        </div></td>
      </tr>`)}</tbody>
    </table>
  </div>`;
}

function adminChannels(ctx, editing) {
  const rows = channels();
  const ch = channelSummary();
  const readOnly = !!ctx.session?.support;
  return h`
    <div class="stat-grid">
      ${statCard({ label: 'Aktywne kanały', value: ch.enabled, sub: 'wysyłają powiadomienia', icon: 'plug', tone: ch.enabled ? 'ok' : 'muted' })}
      ${statCard({ label: 'Nieaktywne', value: ch.disabled, sub: 'zachowane bez wysyłki', icon: 'x', tone: 'muted' })}
      ${statCard({ label: 'Wszystkie', value: ch.total, sub: ch.types.join(', ') || 'brak typów', icon: 'list', tone: 'brand' })}
    </div>
    ${readOnly ? alert('Dostęp wsparcia jest tylko do odczytu — kanały można przeglądać, ale nie zmieniać.', 'info') : ''}
    ${readOnly ? '' : card('Dodaj kanał', form(channelFields(), { action: `${AP}/channels`, csrf: ctx.csrf, submit: 'Zapisz kanał' }))}
    ${!readOnly && editing ? card(`Edytuj kanał · ${editing.name}`, form(channelFields(editing), { action: `${AP}/channels/${editing.id}/update`, csrf: ctx.csrf, submit: 'Zapisz kanał', cancel: `${AP}?tab=channels` })) : ''}
    ${card('Kanały', channelTable(ctx, rows, { readOnly }), { padded: false })}
    ${!readOnly ? h`<form method="post" action="${AP}/test-all" class="mt-10">${csrfField(ctx)}<button class="btn btn-secondary" type="submit">Test wszystkich kanałów</button></form>` : ''}
    ${alert('Kanały zewnętrzne wysyłają tytuł i treść powiadomienia. Nie używaj ich do sekretów. Status „Aktywny" oznacza wyłącznie zapisane włączenie kanału; dostarczenie nadal zależy od zewnętrznego usługodawcy.', 'info')}`;
}

/* -------------------------------------------------------------- user inbox */

function userTimeline(ctx, rows, filters, { readOnly = false } = {}) {
  if (!rows.length) return emptyInbox(filters);
  return h`<div class="timeline" data-notifications-timeline>
    ${rows.map((n) => {
      const unread = !n.read_at;
      const link = safeLink(n.link);
      return h`<article class="timeline-item" data-notification-id="${n.id}" data-unread="${unread ? '1' : '0'}">
        <div class="timeline-dot">${levelBadge(n.level)}</div>
        <div class="timeline-body">
          <div class="spread">
            <strong class="${unread ? '' : 'muted'}">${n.title}</strong>
            <span class="small muted">${formatDate(n.created_at, { time: true })}</span>
          </div>
          ${n.body ? h`<div class="small">${n.body}</div>` : ''}
          ${link ? h`<a class="link small" href="${link}">Otwórz</a>` : ''}
          <div class="row mt-10">
            ${unread ? badge('nowe', 'warn') : badge('przeczytane', 'muted')}
            ${!readOnly && unread ? h`<form method="post" action="${UP}/${n.id}/read" class="inline">${csrfField(ctx)}${filterHidden(filters)}<button class="btn btn-ghost btn-sm" type="submit">Oznacz jako przeczytane</button></form>` : ''}
            ${!readOnly ? h`<form method="post" action="${UP}/${n.id}/delete" class="inline" data-confirm="Usunąć powiadomienie?">${csrfField(ctx)}${filterHidden(filters)}<button class="btn btn-ghost btn-sm" type="submit">Usuń</button></form>` : ''}
          </div>
        </div>
      </article>`;
    })}
  </div>`;
}

function userInbox(ctx, filters) {
  const counts = notificationCounts(ctx.user.id);
  const ch = channelSummary();
  const rows = listNotifications(ctx.user.id, 100, filters);
  const readOnly = !!ctx.session?.support;
  return h`
    <div class="stat-grid">
      ${statCard({ label: 'Nieprzeczytane', value: counts.unread, sub: 'w Twojej skrzynce', icon: 'bell', tone: counts.unread ? 'warn' : 'ok' })}
      ${statCard({ label: 'Wszystkie', value: counts.total, sub: 'w tym systemowe', icon: 'list', tone: 'brand' })}
      ${statCard({ label: 'Kanały zewnętrzne', value: `${ch.enabled}/${ch.total}`, sub: ch.total ? 'aktywne (administrator)' : 'tylko panel', icon: 'plug', tone: ch.enabled ? 'ok' : 'muted' })}
    </div>
    <section class="card" data-auto-refresh="15" data-auto-refresh-unit="seconds"
      data-live-url="${liveUrl(filters)}" data-live-stream="/api/v1/notifications/stream?limit=50"
      data-live-interval="15" data-live-field="unread" data-live-target="#notif_live_unread"
      data-live-scope="notifications">
      <header class="card-head">
        <div><h2>Powiadomienia</h2><p>Zdarzenia Twojego konta. Ostatnie zdarzenie: ${timeAgo(rows[0]?.created_at || new Date().toISOString())}.</p></div>
        <div class="card-actions">
          <span class="small muted">Nieprzeczytane: <strong id="notif_live_unread" data-live-value>${counts.unread}</strong></span>
          ${!readOnly && counts.unread ? h`<form method="post" action="${UP}/read-all" class="inline">${csrfField(ctx)}${filterHidden(filters)}<button class="btn btn-secondary btn-sm" type="submit">Oznacz wszystkie (${counts.unread})</button></form>` : ''}
        </div>
      </header>
      <div class="card-body">
        ${filterForm(ctx, UP, filters)}
        ${readOnly ? alert('Dostęp wsparcia jest tylko do odczytu — nie możesz oznaczać ani usuwać powiadomień.', 'info') : ''}
        ${userTimeline(ctx, rows, filters, { readOnly })}
      </div>
    </section>`;
}

/* ----------------------------------------------------------------- routes */

export function register(router) {
  router.get(AP, (ctx) => {
    const tab = String(ctx.query.tab || 'inbox') === 'channels' ? 'channels' : 'inbox';
    const filters = normalizeFilters(ctx.query);
    const editing = tab === 'channels' && ctx.query.edit ? channelFor(ctx.query.edit) : null;
    const body = h`
      ${tabs([{ key: 'inbox', label: 'Powiadomienia', count: unreadCount(ctx.user.id) }, { key: 'channels', label: 'Kanały', count: channels().length }], tab, { base: AP })}
      ${tab === 'inbox' ? adminInbox(ctx, filters) : adminChannels(ctx, editing)}`;
    return page(ctx, { title: 'Centrum powiadomień', subtitle: 'Zdarzenia panelu i kanały zewnętrzne', body, wide: true });
  });

  router.post(`${AP}/:id/read`, (ctx) => {
    const filters = filtersFromBody(ctx);
    const r = markRead(ctx.params.id, ctx.user.id);
    return ctx.redirect(inboxHref(AP, filters), {
      flash: r.ok ? 'Oznaczono powiadomienie jako przeczytane' : 'Nie znaleziono powiadomienia',
      type: r.ok ? 'ok' : 'error',
    });
  });
  router.post(`${AP}/:id/delete`, (ctx) => {
    const filters = filtersFromBody(ctx);
    const r = deleteNotification(ctx.params.id, ctx.user.id);
    return ctx.redirect(inboxHref(AP, filters), {
      flash: r.ok ? 'Usunięto powiadomienie' : 'Nie znaleziono powiadomienia',
      type: r.ok ? 'ok' : 'error',
    });
  });
  router.post(`${AP}/read-all`, (ctx) => {
    const filters = filtersFromBody(ctx);
    const r = markAllRead(ctx.user.id);
    return ctx.redirect(inboxHref(AP, filters), { flash: r.marked ? `Oznaczono ${r.marked} powiadomień` : 'Brak nowych powiadomień', type: 'ok' });
  });
  router.post(`${AP}/channels`, (ctx) => {
    const r = saveChannel(ctx.body, ctx.user.username);
    return ctx.redirect(`${AP}?tab=channels&flash=${encodeURIComponent(r.ok ? 'Kanał zapisany' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${AP}/channels/:id/update`, (ctx) => {
    const r = saveChannel({ ...ctx.body, id: ctx.params.id }, ctx.user.username);
    return ctx.redirect(`${AP}?tab=channels&flash=${encodeURIComponent(r.ok ? 'Kanał zaktualizowany' : r.error)}${r.ok ? '' : '&type=error'}`);
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
    const filters = normalizeFilters(ctx.query);
    return page(ctx, { title: 'Powiadomienia', subtitle: 'Zdarzenia Twojego konta', body: userInbox(ctx, filters) });
  });
  router.post(`${UP}/:id/read`, (ctx) => {
    const filters = filtersFromBody(ctx);
    const r = markRead(ctx.params.id, ctx.user.id);
    return ctx.redirect(userHref(UP, filters), {
      flash: r.ok ? 'Oznaczono powiadomienie jako przeczytane' : 'Nie znaleziono powiadomienia',
      type: r.ok ? 'ok' : 'error',
    });
  });
  router.post(`${UP}/:id/delete`, (ctx) => {
    const filters = filtersFromBody(ctx);
    const r = deleteNotification(ctx.params.id, ctx.user.id);
    return ctx.redirect(userHref(UP, filters), {
      flash: r.ok ? 'Usunięto powiadomienie' : 'Nie znaleziono powiadomienia',
      type: r.ok ? 'ok' : 'error',
    });
  });
  router.post(`${UP}/read-all`, (ctx) => {
    const filters = filtersFromBody(ctx);
    const r = markAllRead(ctx.user.id);
    return ctx.redirect(userHref(UP, filters), { flash: r.marked ? `Oznaczono ${r.marked} powiadomień` : 'Brak nowych powiadomień', type: 'ok' });
  });
}
