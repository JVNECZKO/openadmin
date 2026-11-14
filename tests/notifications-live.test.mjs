// Live notifications: REST feed, read/read-all/delete, SSE, isolation,
// API-key scopes, support read-only handling and the notification-center UI.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openadmin-notifications-'));
process.env.OA_DATA_DIR = dataDir;
process.env.OA_PORT = '0';
process.env.OA_HOST = '127.0.0.1';
process.env.OA_DEMO = '1';
process.env.OA_ADMIN_PASSWORD = 'admin-test-pass';
process.env.OA_SESSION_TTL = '2';

const serverMod = await import('../src/server.mjs');
const db = await import('../src/db.mjs');
const notify = await import('../src/notifications.mjs');
const apikeys = await import('../src/apikeys.mjs');
const support = await import('../src/supportaccess.mjs');
const scheduler = await import('../src/scheduler.mjs');

let server;
let base;

async function form(url, fields, cookie = '') {
  return fetch(base + url, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
}

async function loginAs(username, password = 'demo') {
  const res = await form('/login', { username, password });
  assert.equal(res.status, 302, `login for ${username} should redirect`);
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  return list.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
}

function csrfFor(cookie) {
  const token = /(?:^|;\s*)OA_SESSION=([^;]+)/.exec(cookie || '')?.[1];
  assert.ok(token, 'session cookie should contain OA_SESSION');
  // SEC-010: only the SHA-256 hash of the cookie token is stored.
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const row = db.get('SELECT csrf FROM sessions WHERE token_hash = ?', hash);
  assert.ok(row?.csrf, 'session should have a CSRF token');
  return row.csrf;
}

function users() {
  return {
    admin: db.get("SELECT * FROM users WHERE username = 'demoadmin'"),
    reseller: db.get("SELECT * FROM users WHERE username = 'demoreseller'"),
    user: db.get("SELECT * FROM users WHERE username = 'demouser'"),
  };
}

function resetNotifications() {
  db.run('DELETE FROM notifications');
  db.run('DELETE FROM notification_channels');
}

function jsonHeaders(cookie) { return cookie ? { Cookie: cookie } : {}; }

function parseSse(raw) {
  return String(raw)
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      let event = 'message';
      let id = null;
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('id:')) id = Number(line.slice(3).trim());
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      let parsed = null;
      try { parsed = JSON.parse(data.join('\n')); } catch { parsed = null; }
      return { event, id, data: data.join('\n'), json: parsed };
    });
}

async function openSse(cookie, path = '/api/v1/notifications/stream', extraHeaders = {}) {
  const ac = new AbortController();
  const res = await fetch(base + path, {
    headers: { Accept: 'text/event-stream', ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
    signal: ac.signal,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  async function readUntil(predicate, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(raw)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`SSE timeout; received: ${raw.slice(0, 500)}`);
      const timer = setTimeout(() => ac.abort(), remaining);
      try {
        const { value, done } = await reader.read();
        clearTimeout(timer);
        if (done) break;
        raw += decoder.decode(value, { stream: true });
      } catch (e) {
        clearTimeout(timer);
        throw e;
      }
    }
    if (!predicate(raw)) throw new Error(`SSE condition not met; received: ${raw.slice(0, 500)}`);
    return raw;
  }
  async function close() {
    ac.abort();
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  return { res, readUntil, close, raw: () => raw };
}

before(async () => {
  server = serverMod.start();
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  const { stopImap } = await import('../src/imap.mjs');
  stopImap();
  await new Promise((resolve) => server.close(resolve));
  db.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('notification API reports unread count, newest items, server time and cursor', async () => {
  resetNotifications();
  const { admin, reseller, user } = users();
  const older = notify.addNotification({ userId: user.id, level: 'warn', title: 'Older user alert' });
  const global = notify.addNotification({ userId: null, level: 'info', title: 'Global maintenance' });
  const newest = notify.addNotification({ userId: user.id, level: 'danger', title: 'Newest user alert' });
  notify.addNotification({ userId: admin.id, level: 'warn', title: 'Admin-only alert' });
  notify.addNotification({ userId: reseller.id, level: 'warn', title: 'Reseller-only alert' });

  const cookie = await loginAs('demouser');
  const res = await fetch(base + '/api/v1/notifications?limit=2', { headers: jsonHeaders(cookie) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.unread, 3, 'own + system notifications only');
  assert.equal(json.unread_count, 3);
  assert.equal(json.items.length, 2);
  assert.equal(json.notifications.length, 2);
  assert.equal(json.items[0].id, newest.id, 'newest first');
  assert.equal(json.items[1].id, global.id);
  assert.equal(json.items[0].read, false);
  assert.equal(json.items[1].scope, 'system');
  assert.ok(!Number.isNaN(Date.parse(json.server_time)), 'server_time is an ISO timestamp');
  assert.equal(json.cursor, global.id);
  assert.equal(json.has_more, true);
  assert.ok(json.items.every((n) => n.title !== 'Admin-only alert' && n.title !== 'Reseller-only alert'));

  const page2 = await fetch(base + `/api/v1/notifications?limit=2&cursor=${global.id}`, { headers: jsonHeaders(cookie) });
  const next = await page2.json();
  assert.equal(next.items.length, 1);
  assert.equal(next.items[0].id, older.id);
  assert.equal(next.has_more, false);
  assert.equal(next.cursor, null);

  const invalidLimit = await fetch(base + '/api/v1/notifications?limit=not-a-number', { headers: jsonHeaders(cookie) });
  assert.equal(invalidLimit.status, 200);
  assert.equal((await invalidLimit.json()).limit, 20, 'invalid limit falls back safely');

  const unreadOnly = await fetch(base + '/api/v1/notifications?status=unread', { headers: jsonHeaders(cookie) });
  assert.equal((await unreadOnly.json()).items.length, 3);
});

test('read-scoped API keys can read but not mutate; write keys can read, mark and delete', async () => {
  resetNotifications();
  const { user } = users();
  const own = notify.addNotification({ userId: user.id, level: 'warn', title: 'Read scope target' });
  const global = notify.addNotification({ userId: null, level: 'info', title: 'Global for scope' });

  const readKey = apikeys.createKey(user.id, { name: 'notifications-read', scopes: ['read'] });
  const readList = await fetch(base + '/api/v1/notifications', { headers: { 'X-API-Key': readKey.secret } });
  assert.equal(readList.status, 200);
  assert.equal((await readList.json()).unread, 2);

  const readAttempt = await fetch(base + `/api/v1/notifications/${own.id}/read`, {
    method: 'POST', headers: { 'X-API-Key': readKey.secret },
  });
  assert.equal(readAttempt.status, 401, 'read-scoped key is rejected on mutation');
  assert.equal(db.get('SELECT read_at FROM notifications WHERE id = ?', own.id).read_at, null);

  const readAllAttempt = await fetch(base + '/api/v1/notifications/read-all', {
    method: 'POST', headers: { 'X-API-Key': readKey.secret },
  });
  assert.equal(readAllAttempt.status, 401);
  assert.equal(db.get('SELECT read_at FROM notifications WHERE id = ?', own.id).read_at, null);

  const writeKey = apikeys.createKey(user.id, { name: 'notifications-write', scopes: ['write'] });
  const read = await fetch(base + `/api/v1/notifications/${own.id}/read`, {
    method: 'POST', headers: { 'X-API-Key': writeKey.secret },
  });
  assert.equal(read.status, 200);
  const readJson = await read.json();
  assert.equal(readJson.ok, true);
  assert.ok(readJson.read_at);
  assert.equal(readJson.unread, 1);

  const all = await fetch(base + '/api/v1/notifications/read-all', {
    method: 'POST', headers: { 'X-API-Key': writeKey.secret },
  });
  assert.equal(all.status, 200);
  assert.equal((await all.json()).unread, 0);

  const del = await fetch(base + `/api/v1/notifications/${own.id}`, {
    method: 'DELETE', headers: { 'X-API-Key': writeKey.secret },
  });
  assert.equal(del.status, 200);
  assert.equal(!!db.get('SELECT id FROM notifications WHERE id = ?', own.id), false);

  const adminNote = notify.addNotification({ userId: users().admin.id, level: 'warn', title: 'Not the key owner' });
  const notMine = await fetch(base + `/api/v1/notifications/${adminNote.id}/read`, {
    method: 'POST', headers: { 'X-API-Key': writeKey.secret },
  });
  assert.equal(notMine.status, 404, 'write key cannot mutate another account');
  assert.equal(db.get('SELECT read_at FROM notifications WHERE id = ?', adminNote.id).read_at, null);
  assert.ok(global.id);
});

test('session CSRF is enforced and support sessions stay read-only', async () => {
  resetNotifications();
  const { admin } = users();
  const csrfCookie = await loginAs('demoadmin');
  const csrf = csrfFor(csrfCookie);
  const n = notify.addNotification({ userId: admin.id, level: 'warn', title: 'Support read test' });

  const noCsrf = await fetch(base + `/api/v1/notifications/${n.id}/read`, {
    method: 'POST', headers: { Cookie: csrfCookie },
  });
  assert.equal(noCsrf.status, 401);
  assert.equal(db.get('SELECT read_at FROM notifications WHERE id = ?', n.id).read_at, null);

  const withCsrf = await fetch(base + `/api/v1/notifications/${n.id}/read`, {
    method: 'POST', headers: { Cookie: csrfCookie, 'X-CSRF-Token': csrf },
  });
  assert.equal(withCsrf.status, 200);
  assert.ok(db.get('SELECT read_at FROM notifications WHERE id = ?', n.id).read_at);

  const second = notify.addNotification({ userId: admin.id, level: 'warn', title: 'Support block test' });
  const grant = support.createSupport({ hours: 1, createdBy: 'demoadmin' });
  const redeemed = support.redeemSupport(grant.token, { ip: '127.0.0.1', ua: 'notifications-test' });
  assert.equal(redeemed.ok, true);
  const supportCookie = `OA_SESSION=${redeemed.session.token}`;
  const supportCsrf = redeemed.session.csrf;

  const supportRead = await fetch(base + '/api/v1/notifications', { headers: { Cookie: supportCookie } });
  assert.equal(supportRead.status, 200, 'support access may read');
  const supportPage = await fetch(base + '/admin/notifications', { headers: { Cookie: supportCookie } });
  assert.equal(supportPage.status, 200);
  assert.match(await supportPage.text(), /tylko do odczytu/);

  const supportPost = await fetch(base + `/api/v1/notifications/${second.id}/read`, {
    method: 'POST', headers: { Cookie: supportCookie, 'X-CSRF-Token': supportCsrf },
  });
  assert.equal(supportPost.status, 403, 'server-level support guard blocks POST');
  assert.equal(db.get('SELECT read_at FROM notifications WHERE id = ?', second.id).read_at, null);

  const supportForm = await form(`/admin/notifications/${second.id}/read`, { _csrf: supportCsrf }, supportCookie);
  assert.equal(supportForm.status, 403);
  assert.equal(db.get('SELECT read_at FROM notifications WHERE id = ?', second.id).read_at, null);
});

test('notification center page has accessible actions, live hooks, truthful channel status and escaped content', async () => {
  resetNotifications();
  const { admin } = users();
  const cookie = await loginAs('demoadmin');
  const csrf = csrfFor(cookie);
  const malicious = notify.addNotification({
    userId: admin.id,
    level: 'warn',
    title: '<img src=x onerror=alert(1)>',
    body: '<script>alert("xss")</script>',
    link: 'javascript:alert(1)',
  });
  const readable = notify.addNotification({ userId: admin.id, level: 'info', title: 'Readable notification' });

  notify.saveChannel({ name: 'enabled-hook', type: 'webhook', url: 'http://127.0.0.1:9/hook', enabled_present: '1', enabled: '1' });
  notify.saveChannel({ name: 'disabled-hook', type: 'webhook', url: 'http://127.0.0.1:9/hook2', enabled_present: '1', enabled: '0' });

  const page = await fetch(base + '/admin/notifications', { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Centrum powiadomień/);
  assert.match(html, /data-auto-refresh="15"/);
  assert.match(html, /data-live-url="\/api\/v1\/notifications/);
  assert.match(html, /data-live-stream="\/api\/v1\/notifications\/stream/);
  assert.match(html, /data-notifications-table/);
  assert.match(html, /data-unread="1"/);
  assert.match(html, /Oznacz wszystkie/);
  assert.match(html, /name="_csrf"/);
  assert.equal(html.includes('<img src=x onerror=alert(1)>'), false, 'title must be escaped');
  assert.equal(html.includes('<script>alert("xss")</script>'), false, 'body must be escaped');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.equal(html.includes('href="javascript:'), false, 'unsafe links are dropped');

  const deleteAction = `/admin/notifications/${malicious.id}/delete`;
  assert.ok(html.includes(`action="${deleteAction}"`), 'delete form is present and works without JS');
  const deletePost = await form(deleteAction, { _csrf: csrf, status: 'all', level: '' }, cookie);
  assert.equal(deletePost.status, 302);
  assert.equal(!!db.get('SELECT id FROM notifications WHERE id = ?', malicious.id), false);

  const markPost = await form(`/admin/notifications/${readable.id}/read`, { _csrf: csrf, status: 'all' }, cookie);
  assert.equal(markPost.status, 302);
  assert.ok(db.get('SELECT read_at FROM notifications WHERE id = ?', readable.id).read_at);

  const channels = await fetch(base + '/admin/notifications?tab=channels', { headers: { Cookie: cookie } });
  assert.equal(channels.status, 200);
  const channelsHtml = await channels.text();
  assert.match(channelsHtml, /Aktywny/);
  assert.match(channelsHtml, /Nieaktywny/);
  assert.match(channelsHtml, /data-enabled="0"/);
  assert.match(channelsHtml, /data-enabled="1"/);

  const empty = await fetch(base + '/admin/notifications?tab=inbox&status=unread', { headers: { Cookie: cookie } });
  assert.match(await empty.text(), /Brak nieprzeczytanych powiadomień/);
});

test('admin, reseller and user notifications stay isolated', async () => {
  resetNotifications();
  const { admin, reseller, user } = users();
  const userNote = notify.addNotification({ userId: user.id, level: 'warn', title: 'User private note' });
  const resellerNote = notify.addNotification({ userId: reseller.id, level: 'warn', title: 'Reseller private note' });
  const adminNote = notify.addNotification({ userId: admin.id, level: 'warn', title: 'Admin private note' });
  const globalNote = notify.addNotification({ userId: null, level: 'info', title: 'Global visible note' });

  const userJson = await (await fetch(base + '/api/v1/notifications', { headers: jsonHeaders(await loginAs('demouser')) })).json();
  const userTitles = userJson.items.map((n) => n.title);
  assert.ok(userTitles.includes('User private note'));
  assert.ok(userTitles.includes('Global visible note'));
  assert.ok(!userTitles.includes('Admin private note'));
  assert.ok(!userTitles.includes('Reseller private note'));

  const adminCookie = await loginAs('demoadmin');
  const adminJson = await (await fetch(base + '/api/v1/notifications', { headers: jsonHeaders(adminCookie) })).json();
  const adminTitles = adminJson.items.map((n) => n.title);
  assert.ok(adminTitles.includes('Admin private note'));
  assert.ok(adminTitles.includes('Global visible note'));
  assert.ok(!adminTitles.includes('User private note'));

  const resellerCookie = await loginAs('demoreseller');
  const resellerRead = await fetch(base + `/api/v1/notifications/${userNote.id}/read`, {
    method: 'POST', headers: { Cookie: resellerCookie, 'X-CSRF-Token': csrfFor(resellerCookie) },
  });
  assert.equal(resellerRead.status, 404, 'cross-account notification is not visible');
  assert.equal(db.get('SELECT read_at FROM notifications WHERE id = ?', userNote.id).read_at, null);

  const resellerDelete = await fetch(base + `/api/v1/notifications/${userNote.id}`, {
    method: 'DELETE', headers: { Cookie: resellerCookie, 'X-CSRF-Token': csrfFor(resellerCookie) },
  });
  assert.equal(resellerDelete.status, 404);
  assert.ok(db.get('SELECT id FROM notifications WHERE id = ?', userNote.id));

  const userPage = await fetch(base + '/user/notifications', { headers: { Cookie: await loginAs('demouser') } });
  assert.equal(userPage.status, 200);
  const userHtml = await userPage.text();
  assert.match(userHtml, /User private note/);
  assert.match(userHtml, /Global visible note/);
  assert.equal(userHtml.includes('Admin private note'), false);
  assert.match(userHtml, /data-auto-refresh="15"/);
  assert.ok(globalNote.id && resellerNote.id && adminNote.id);
});

test('SSE emits ready and scoped notification events; unauthenticated stream is rejected', async () => {
  resetNotifications();
  const unauth = await fetch(base + '/api/v1/notifications/stream');
  assert.equal(unauth.status, 401);

  const { admin, user } = users();
  const cookie = await loginAs('demouser');
  const first = await openSse(cookie);
  assert.equal(first.res.status, 200);
  assert.match(first.res.headers.get('content-type') || '', /text\/event-stream/);
  await first.readUntil((raw) => raw.includes('event: ready'));
  const ready = parseSse(first.raw()).find((item) => item.event === 'ready');
  assert.ok(ready?.json?.ok);
  assert.equal(ready.json.unread, 0);

  notify.addNotification({ userId: admin.id, level: 'warn', title: 'Admin should not stream' });
  const mine = notify.addNotification({ userId: user.id, level: 'danger', title: 'Streamed for user' });
  notify.addNotification({ userId: null, level: 'info', title: 'Streamed globally' });
  await first.readUntil((raw) => raw.includes('Streamed globally'));
  const events = parseSse(first.raw()).filter((item) => item.event === 'notification');
  const titles = events.map((item) => item.json?.notification?.title);
  assert.ok(titles.includes('Streamed for user'));
  assert.ok(titles.includes('Streamed globally'));
  assert.ok(!titles.includes('Admin should not stream'), 'per-account isolation applies to SSE');
  assert.ok(events.some((item) => item.id === mine.id));
  await first.close();

  const readKey = apikeys.createKey(user.id, { name: 'sse-read', scopes: ['read'] });
  const keyed = await openSse('', '/api/v1/notifications/stream', { 'X-API-Key': readKey.secret });
  assert.equal(keyed.res.status, 200);
  await keyed.readUntil((raw) => raw.includes('event: ready'));
  await keyed.close();
  void admin; void user;
});

test('dispatch and the scheduler failure path create one record and suppress duplicate spam', async () => {
  resetNotifications();
  const { admin, user } = users();
  const first = await notify.dispatch('Automatyzacja nie powiodła się', 'timeout', { userId: admin.id, level: 'warn' });
  const second = await notify.dispatch('Automatyzacja nie powiodła się', 'timeout', { userId: admin.id, level: 'warn' });
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(first.notification, second.notification);
  assert.deepEqual(second.channels, []);
  assert.equal(db.get('SELECT COUNT(*) n FROM notifications').n, 1);

  // Failure alerts from the scheduler's existing notifyAdmin() path are in-app
  // rows too, and repeats are coalesced while the row is unread.
  scheduler.notifyAdmin('Kopia zapasowa nie powiodła się', 'Błąd: brak miejsca');
  scheduler.notifyAdmin('Kopia zapasowa nie powiodła się', 'Błąd: brak miejsca');
  assert.equal(db.get("SELECT COUNT(*) n FROM notifications WHERE title = 'Kopia zapasowa nie powiodła się'").n, 1);

  const infoOne = notify.addNotification({ userId: user.id, level: 'info', title: 'Info one' });
  const infoTwo = notify.addNotification({ userId: user.id, level: 'info', title: 'Info one' });
  assert.notEqual(infoOne.id, infoTwo.id, 'regular info messages are not coalesced');

  const auto = await notify.notifyAutomationFailure({ source: 'backup', title: 'Backup job failed', body: 'disk full' });
  const autoRepeat = await notify.notifyAutomationFailure({ source: 'backup', title: 'Backup job failed', body: 'disk full' });
  assert.equal(auto.deduplicated, false);
  assert.equal(autoRepeat.deduplicated, true);
  const stored = db.get('SELECT * FROM notifications WHERE title = ?', 'Backup job failed');
  assert.equal(stored.level, 'danger');
  const primaryAdmin = db.get("SELECT * FROM users WHERE level = 'admin' ORDER BY id LIMIT 1");
  assert.equal(stored.user_id, primaryAdmin.id);
});
