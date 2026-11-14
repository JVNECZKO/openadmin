// In-app notifications plus outbound channels (email, webhook, Slack,
// Discord, Telegram). Channel endpoints are configured by an administrator.
//
// Notifications are also the event source for the live API/SSE endpoint. This
// module is the single writer, so every path that creates or changes an
// in-app notification publishes one typed event to in-process subscribers.
import { EventEmitter } from 'node:events';
import { all, get, run, nowIso, setting } from './db.mjs';
import { encryptSecret, decryptSecret } from './secrets.mjs';
import { sendMail, mtaStatus } from './mta.mjs';

const NOTIFICATION_LEVELS = ['info', 'ok', 'warn', 'danger'];
const LEVEL_SET = new Set(NOTIFICATION_LEVELS);
const DEFAULT_FEED_LIMIT = 20;
const MAX_FEED_LIMIT = 100;
// Repeated failure alerts are coalesced while the previous one is still
// unread. Info/ok messages keep the old one-row-per-call behaviour unless a
// caller supplies an explicit dedupeKey/window.
const WARN_DEDUPE_MS = 15 * 60 * 1000;
const DANGER_DEDUPE_MS = 60 * 60 * 1000;
const MAX_DEDUPE_MS = 24 * 60 * 60 * 1000;
const bus = new EventEmitter();
bus.setMaxListeners(200);

/* ------------------------------------------------------------------ events */

/**
 * Subscribe to notification changes. Events are plain data:
 *   { type: 'created', notification }
 *   { type: 'read', notification }
 *   { type: 'deleted', notification }
 *   { type: 'read-all', user_id }
 * The raw `notification.user_id` is retained so the API can enforce
 * per-account isolation before anything is sent over a stream.
 */
export function subscribeNotifications(listener) {
  const wrapped = (event) => {
    try { listener(event); } catch { /* a broken listener must not break dispatch */ }
  };
  bus.on('notification', wrapped);
  return () => bus.off('notification', wrapped);
}

function emitNotification(event) {
  bus.emit('notification', event);
}

/* ------------------------------------------------------------------ shaping */

/** Only relative paths and http(s) URLs are usable as notification links. */
export function safeLink(value) {
  const link = String(value || '').trim();
  if (!link) return '';
  if (link.startsWith('/') && !link.startsWith('//')) return link;
  if (/^https?:\/\//i.test(link)) return link;
  return '';
}

/** Public JSON representation of one notification row (no owner id leak). */
export function notificationView(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    level: LEVEL_SET.has(row.level) ? row.level : 'info',
    title: String(row.title ?? ''),
    body: String(row.body ?? ''),
    link: safeLink(row.link),
    read: !!row.read_at,
    unread: !row.read_at,
    read_at: row.read_at || null,
    created_at: row.created_at || null,
    scope: row.user_id === null || row.user_id === undefined ? 'system' : 'account',
  };
}

function clampLimit(value, fallback = DEFAULT_FEED_LIMIT, max = MAX_FEED_LIMIT) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, n));
}

function normalizeStatus(value) {
  return ['all', 'unread', 'read'].includes(String(value || '')) ? String(value) : 'all';
}

function normalizeLevel(value) {
  return LEVEL_SET.has(String(value || '')) ? String(value) : '';
}

function visibleWhere(userId) {
  return { sql: '(user_id = ? OR user_id IS NULL)', params: [userId] };
}

/* -------------------------------------------------------------------- reads */

/**
 * Legacy page helper: returns raw rows visible to the account. `limit` and the
 * optional filter object are additive, so existing callers keep working.
 */
export function listNotifications(userId, limit = 100, { status = 'all', level = '' } = {}) {
  const where = [visibleWhere(userId).sql];
  const params = [userId];
  const state = normalizeStatus(status);
  if (state === 'unread') where.push('read_at IS NULL');
  if (state === 'read') where.push('read_at IS NOT NULL');
  const lvl = normalizeLevel(level);
  if (lvl) { where.push('level = ?'); params.push(lvl); }
  params.push(clampLimit(limit, 100, 500));
  return all(`SELECT * FROM notifications WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, ...params);
}

export function unreadCount(userId) {
  const row = get('SELECT COUNT(*) AS n FROM notifications WHERE (user_id = ? OR user_id IS NULL) AND read_at IS NULL', userId);
  return Number(row?.n || 0);
}

export function notificationCounts(userId) {
  const row = get(`SELECT COUNT(*) AS total,
                          COALESCE(SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END), 0) AS unread
                     FROM notifications WHERE (user_id = ? OR user_id IS NULL)`, userId);
  const total = Number(row?.total || 0);
  const unread = Number(row?.unread || 0);
  return { total, unread, read: Math.max(0, total - unread) };
}

/**
 * Cursor-paginated feed used by GET /api/v1/notifications and the SSE
 * endpoint. Cursors are notification ids and are deliberately opaque to
 * clients except for "pass it back as ?cursor=".
 */
export function notificationFeed(userId, { limit = DEFAULT_FEED_LIMIT, cursor = null, status = 'all', level = '' } = {}) {
  const pageSize = clampLimit(limit);
  const where = [visibleWhere(userId).sql];
  const params = [userId];
  const state = normalizeStatus(status);
  if (state === 'unread') where.push('read_at IS NULL');
  if (state === 'read') where.push('read_at IS NOT NULL');
  const lvl = normalizeLevel(level);
  if (lvl) { where.push('level = ?'); params.push(lvl); }
  const before = cursor === null || cursor === undefined || cursor === '' ? null : Number(cursor);
  if (Number.isSafeInteger(before) && before > 0) { where.push('id < ?'); params.push(before); }
  params.push(pageSize + 1);
  const rows = all(`SELECT * FROM notifications WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, ...params);
  const page = rows.slice(0, pageSize);
  const hasMore = rows.length > pageSize;
  return {
    unread: unreadCount(userId),
    items: page.map(notificationView),
    server_time: nowIso(),
    next_cursor: hasMore && page.length ? Number(page[page.length - 1].id) : null,
    has_more: hasMore,
    limit: pageSize,
  };
}

/** One visible notification, or null when it belongs to another account. */
export function notificationFor(id, userId) {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return get('SELECT * FROM notifications WHERE id = ? AND (user_id = ? OR user_id IS NULL)', n, userId);
}

/* ------------------------------------------------------------------- writes */

export function markRead(id, userId) {
  const row = notificationFor(id, userId);
  if (!row) return { ok: false, notFound: true };
  if (row.read_at) return { ok: true, id: row.id, read_at: row.read_at, changed: false };
  const at = nowIso();
  run('UPDATE notifications SET read_at = ? WHERE id = ?', at, row.id);
  const updated = get('SELECT * FROM notifications WHERE id = ?', row.id);
  emitNotification({ type: 'read', notification: updated });
  return { ok: true, id: row.id, read_at: at, changed: true };
}

export function deleteNotification(id, userId) {
  const row = notificationFor(id, userId);
  if (!row) return { ok: false, notFound: true };
  run('DELETE FROM notifications WHERE id = ?', row.id);
  emitNotification({ type: 'deleted', notification: row });
  return { ok: true, id: row.id };
}

export function markAllRead(userId) {
  const marked = run('UPDATE notifications SET read_at = ? WHERE (user_id = ? OR user_id IS NULL) AND read_at IS NULL', nowIso(), userId).changes;
  if (marked > 0) emitNotification({ type: 'read-all', user_id: userId });
  return { ok: true, marked };
}

function dedupeWindow({ level, dedupeKey, dedupeWindowMs }) {
  const explicit = dedupeWindowMs === null || dedupeWindowMs === undefined || dedupeWindowMs === ''
    ? NaN
    : Number(dedupeWindowMs);
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(MAX_DEDUPE_MS, Math.floor(explicit)));
  if (dedupeKey) return WARN_DEDUPE_MS;
  if (level === 'danger') return DANGER_DEDUPE_MS;
  if (level === 'warn') return WARN_DEDUPE_MS;
  return 0;
}

function findDuplicate({ userId, level, title, body, windowMs }) {
  const since = new Date(Date.now() - windowMs).toISOString();
  const where = [
    'level = ?',
    'title = ?',
    "COALESCE(body, '') = ?",
    'read_at IS NULL',
    'created_at >= ?',
  ];
  const params = [level, title, body, since];
  if (userId === null || userId === undefined) where.push('user_id IS NULL');
  else { where.push('user_id = ?'); params.push(userId); }
  return get(`SELECT * FROM notifications WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 1`, ...params);
}

/**
 * Create one in-app notification and publish it to live subscribers.
 * Returns `{ ok, id, notification, deduplicated }`. When deduplicated is true
 * an identical unread notification from the dedupe window already exists and
 * its id is returned instead of inserting a duplicate row.
 */
export function addNotification({ userId = null, level = 'info', title, body = '', link = '', dedupeKey = null, dedupeWindowMs = null } = {}) {
  const lvl = LEVEL_SET.has(String(level)) ? String(level) : 'info';
  const text = String(title ?? '').trim().slice(0, 200) || 'Powiadomienie';
  const message = String(body ?? '');
  const href = safeLink(link);
  const windowMs = dedupeWindow({ level: lvl, dedupeKey, dedupeWindowMs });
  if (windowMs > 0) {
    const existing = findDuplicate({ userId, level: lvl, title: text, body: message, windowMs });
    if (existing) {
      return { ok: true, id: Number(existing.id), deduplicated: true, notification: existing };
    }
  }
  const r = run('INSERT INTO notifications(user_id, level, title, body, link, created_at) VALUES(?,?,?,?,?,?)',
    userId, lvl, text, message, href, nowIso());
  const row = get('SELECT * FROM notifications WHERE id = ?', r.lastInsertRowid);
  emitNotification({ type: 'created', notification: row });
  return { ok: true, id: Number(r.lastInsertRowid), deduplicated: false, notification: row };
}

/* ---------------------------------------------------------------- channels */

export function channels() { return all('SELECT * FROM notification_channels ORDER BY name'); }

export function channelSummary() {
  const rows = channels();
  return {
    total: rows.length,
    enabled: rows.filter((c) => !!c.enabled).length,
    disabled: rows.filter((c) => !c.enabled).length,
    types: [...new Set(rows.map((c) => c.type))],
  };
}

export function channelFor(id) {
  const ch = get('SELECT * FROM notification_channels WHERE id = ?', Number(id));
  if (!ch) return null;
  let cfg = {};
  try { cfg = JSON.parse(decryptSecret(ch.config_enc)); } catch { cfg = {}; }
  return { ...ch, config: cfg };
}

function truthyFlag(value) {
  return value === true || value === 1 || ['1', 'true', 'on', 'yes'].includes(String(value).toLowerCase());
}

export function saveChannel(body, actor = 'admin') {
  const type = ['email', 'webhook', 'slack', 'discord', 'telegram'].includes(body.type) ? body.type : 'webhook';
  const name = String(body.name || '').trim();
  if (!name) return { ok: false, error: 'Nazwa jest wymagana' };
  const config = {};
  if (type === 'email') config.to = String(body.to || '').trim();
  else if (type === 'telegram') { config.token = String(body.token || '').trim(); config.chat_id = String(body.chat_id || '').trim(); }
  else config.url = String(body.url || '').trim();
  if (type !== 'email' && type !== 'telegram' && !/^https?:\/\//.test(config.url)) return { ok: false, error: 'Podaj URL http(s)' };
  // `enabled_present` is emitted by the notification-center checkbox pair.
  // When it is absent (API/legacy callers) an update keeps the current state.
  const enabledPressed = body.enabled_present !== undefined;
  const enabled = enabledPressed ? (truthyFlag(body.enabled) ? 1 : 0) : (body.enabled === undefined ? 1 : (truthyFlag(body.enabled) ? 1 : 0));
  if (body.id) {
    const existing = get('SELECT * FROM notification_channels WHERE id = ?', Number(body.id));
    if (!existing) return { ok: false, error: 'Kanał nie istnieje' };
    const nextEnabled = enabledPressed || body.enabled !== undefined ? enabled : Number(existing.enabled || 0);
    run('UPDATE notification_channels SET name=?, type=?, config_enc=?, enabled=? WHERE id=?', name, type, encryptSecret(JSON.stringify(config)), nextEnabled, Number(body.id));
  } else {
    run('INSERT INTO notification_channels(name, type, config_enc, enabled, created_at) VALUES(?,?,?,?,?)', name, type, encryptSecret(JSON.stringify(config)), enabled, nowIso());
  }
  return { ok: true, type };
}

export function deleteChannel(id) { run('DELETE FROM notification_channels WHERE id = ?', Number(id)); return { ok: true }; }

export async function sendChannel(channel, title, body) {
  let cfg = {};
  try { cfg = JSON.parse(decryptSecret(channel.config_enc)); } catch { return { ok: false, error: 'Cannot decrypt channel config' }; }
  if (channel.type === 'email') {
    if (!mtaStatus().available) return { ok: false, error: 'MTA unavailable' };
    const r = sendMail({ from: `panel@${setting('server_name', 'localhost')}`, to: cfg.to, subject: `[OpenAdmin] ${title}`, body });
    return { ok: r.ok, error: r.error || '' };
  }
  let url = cfg.url;
  let payload = { title, body, text: `${title}\n${body}` };
  if (channel.type === 'slack') payload = { text: `*${title}*\n${body}` };
  if (channel.type === 'discord') payload = { content: `**${title}**\n${body}` };
  if (channel.type === 'telegram') {
    url = `https://api.telegram.org/bot${cfg.token}/sendMessage`;
    payload = { chat_id: cfg.chat_id, text: `${title}\n${body}` };
  }
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
    return { ok: res.ok, error: res.ok ? '' : `HTTP ${res.status}` };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function testChannel(id) {
  const ch = get('SELECT * FROM notification_channels WHERE id = ?', Number(id));
  if (!ch) return { ok: false, error: 'Not found' };
  return sendChannel(ch, 'Test OpenAdmin', 'To jest test kanału powiadomień.');
}

export async function dispatch(title, body, { userId = null, level = 'info', link = '', dedupeKey = null, dedupeWindowMs = null } = {}) {
  const n = addNotification({ userId, level, title, body, link, dedupeKey, dedupeWindowMs });
  if (n.deduplicated) {
    // Never repeat the same alert to e-mail/Slack/Discord while the in-app
    // copy is still unread: that is the spam path, not a new event.
    return { ok: true, notification: n.id, deduplicated: true, channels: [] };
  }
  const results = [];
  for (const ch of channels().filter((c) => c.enabled)) results.push({ name: ch.name, ...(await sendChannel(ch, title, body)) });
  return { ok: true, notification: n.id, deduplicated: false, channels: results };
}

/**
 * Integration helper for the scheduler/automation agent. Sends one danger
 * notification to the responsible admin and coalesces retries of the same
 * failure for an hour. Scheduler notifications that already go through
 * `dispatch()` / `addNotification()` are deduplicated by addNotification too.
 */
export async function notifyAutomationFailure({ source = 'automation', title = '', body = '', link = '', userId = null, dedupeKey = null, dedupeWindowMs = DANGER_DEDUPE_MS } = {}) {
  const admin = userId === null ? get("SELECT id FROM users WHERE level = 'admin' ORDER BY id LIMIT 1") : null;
  const target = userId === null ? (admin?.id ?? null) : userId;
  const label = source ? String(source).trim().slice(0, 40) : 'automation';
  const subject = String(title || '').trim() || `Błąd automatyzacji: ${label}`;
  return dispatch(subject, body, {
    userId: target,
    level: 'danger',
    link,
    dedupeKey: dedupeKey || `automation:${label}`,
    dedupeWindowMs,
  });
}

export async function testAll() {
  const out = [];
  for (const ch of channels().filter((c) => c.enabled)) out.push({ name: ch.name, ...(await sendChannel(ch, 'Test OpenAdmin', 'Test kanału powiadomień.')) });
  return out;
}
