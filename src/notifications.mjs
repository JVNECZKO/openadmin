// In-app notifications plus outbound channels (email, webhook, Slack,
// Discord, Telegram). Channel endpoints are configured by an administrator.
import { all, get, run, nowIso } from './db.mjs';
import { encryptSecret, decryptSecret } from './secrets.mjs';
import { sendMail, mtaStatus } from './mta.mjs';
import { setting } from './db.mjs';

export function listNotifications(userId, limit = 100) {
  return all('SELECT * FROM notifications WHERE user_id = ? OR user_id IS NULL ORDER BY id DESC LIMIT ?', userId, Number(limit));
}

export function unreadCount(userId) {
  return get('SELECT COUNT(*) n FROM notifications WHERE (user_id = ? OR user_id IS NULL) AND read_at IS NULL', userId).n;
}

export function markRead(id, userId) {
  run('UPDATE notifications SET read_at = ? WHERE id = ? AND (user_id = ? OR user_id IS NULL)', nowIso(), Number(id), userId);
  return { ok: true };
}

export function markAllRead(userId) {
  run('UPDATE notifications SET read_at = ? WHERE (user_id = ? OR user_id IS NULL) AND read_at IS NULL', nowIso(), userId);
  return { ok: true };
}

export function addNotification({ userId = null, level = 'info', title, body = '', link = '' }) {
  const r = run('INSERT INTO notifications(user_id, level, title, body, link, created_at) VALUES(?,?,?,?,?,?)', userId, level, String(title).slice(0, 200), body, link, nowIso());
  return { ok: true, id: r.lastInsertRowid };
}

export function channels() { return all('SELECT * FROM notification_channels ORDER BY name'); }

export function channelFor(id) {
  const ch = get('SELECT * FROM notification_channels WHERE id = ?', Number(id));
  if (!ch) return null;
  let cfg = {};
  try { cfg = JSON.parse(decryptSecret(ch.config_enc)); } catch { cfg = {}; }
  return { ...ch, config: cfg };
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
  if (body.id) run('UPDATE notification_channels SET name=?, type=?, config_enc=?, enabled=? WHERE id=?', name, type, encryptSecret(JSON.stringify(config)), body.enabled === undefined || !!body.enabled ? 1 : 0, Number(body.id));
  else run('INSERT INTO notification_channels(name, type, config_enc, enabled, created_at) VALUES(?,?,?,?,?)', name, type, encryptSecret(JSON.stringify(config)), 1, nowIso());
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

export async function dispatch(title, body, { userId = null, level = 'info', link = '' } = {}) {
  const n = addNotification({ userId, level, title, body, link });
  const results = [];
  for (const ch of channels().filter((c) => c.enabled)) results.push({ name: ch.name, ...(await sendChannel(ch, title, body)) });
  return { ok: true, notification: n.id, channels: results };
}

export async function testAll() {
  const out = [];
  for (const ch of channels().filter((c) => c.enabled)) out.push({ name: ch.name, ...(await sendChannel(ch, 'Test OpenAdmin', 'Test kanału powiadomień.')) });
  return out;
}
