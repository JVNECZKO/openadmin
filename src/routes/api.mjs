// Public API: a DirectAdmin-compatible CMD_API_* surface plus a documented
// REST API at /api/v1. Both use HTTP Basic authentication with panel
// credentials or a login key (username:keyid:secret).
import fs from 'node:fs';
import pathMod from 'node:path';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { all, get, run, nowIso, hashPassword, setting, audit, verifyPassword } from '../db.mjs';
import { config, VERSION, ROOT } from '../config.mjs';
import { basicAuth, findUser, apiLogin, limitsFor, checkCsrf, rateLimited, recordFailure } from '../auth.mjs';
import { keyFromRequest } from '../apikeys.mjs';
import { handleMcp } from '../mcp.mjs';
import { html as h, formatBytes, isDomain, isEmail } from '../util.mjs';
import { homeDir, resolveUserPath, displayPath, provisionDomain, listTenantDir, writeTenantFile, validateEntryName } from '../features/files.mjs';
import { createZone } from '../features/domains.mjs';
import { visibleDomains, visibleUsers, canManageUser, quota, domainFor } from '../core/access.mjs';
import { backupFor, backupPath } from '../backups.mjs';
import { dovecotHash, syncMail } from '../mail.mjs';
import { rebuildCrontab } from '../cron.mjs';
import { generateAll } from '../webserver.mjs';
import { apply } from '../apply.mjs';
import { rebuildZone } from '../dns.mjs';
import { systemProvider } from '../providers/index.mjs';
import { checkDisk, enforceAll, quotaMeta } from '../quota.mjs';
import { encryptSecret } from '../secrets.mjs';
import { generateSelfSigned, installPem, issueLetsEncrypt, certPaths } from '../ssl.mjs';
import { detect as mariadbDetect, createDatabase as mariaCreate, createAccount as mariaAccount, dropDatabase as mariaDrop, dropAccount as mariaDropAccount } from '../mariadb.mjs';
import { providerExtras as providerExtrasSync } from '../providers/index.mjs';
import {
  notificationFeed, notificationView, unreadCount as notificationUnreadCount,
  markRead as markNotificationRead, markAllRead as markAllNotificationsRead,
  deleteNotification as deleteNotificationRecord, subscribeNotifications,
} from '../notifications.mjs';

/* ------------------------------------------------------------- utilities */
function legacyEncode(obj) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) { for (const item of v) parts.push(`${encodeURIComponent(k + '[]')}=${encodeURIComponent(item)}`); continue; }
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join('&');
}

function legacySend(res, status, obj) {
  const body = legacyEncode(obj);
  res.writeHead(status, {
    'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function legacyError(res, message, status = 200) {
  return legacySend(res, status, { error: 1, text: message, details: '' });
}

function ok(text = '') { return { error: 0, text }; }

/* ------------------------------------------------- login key allowlist ----
 * A login key may carry a comma/space separated list of exact API commands
 * (CMD_API_*).  A non-empty list is deny-by-default: the request must name an
 * allowed command exactly.  REST routes can be allowed by their route pattern
 * (e.g. /api/v1/domains) or by "METHOD /path".
 */
function loginKeyCommands(raw) {
  return String(raw || '').split(/[\s,;]+/).map((entry) => entry.trim()).filter(Boolean);
}

function requestedApiCommands(ctx) {
  const candidates = new Set();
  if (ctx.apiCommand) candidates.add(ctx.apiCommand);
  if (ctx.apiPattern) {
    candidates.add(ctx.apiPattern);
    candidates.add(ctx.apiPattern.replace(/^\/+/, ''));
    candidates.add(`/${ctx.apiPattern.replace(/^\/+/, '')}`);
  }
  if (ctx.apiRoute) candidates.add(ctx.apiRoute);
  return candidates;
}

function loginKeyDenied(user, ctx) {
  const commands = user?.login_key?.commands;
  if (!Array.isArray(commands) || commands.length === 0) return false;
  const candidates = requestedApiCommands(ctx);
  return !commands.some((command) => candidates.has(command));
}

function pruneLoginAttempts() {
  const since = new Date(Date.now() - config.limits.loginWindowMinutes * 60000).toISOString();
  run('DELETE FROM login_attempts WHERE created_at < ?', since);
}

/** Authenticate an API request: Basic auth (password or login key) or a panel session + CSRF. */
function authenticate(ctx) {
  const keyUser = keyFromRequest(ctx.req.headers, ctx.ip, ctx.req.method);
  if (keyUser) return keyUser;
  const auth = basicAuth(ctx.req.headers.authorization || '');
  if (auth) {
    // One limiter for every credential channel (SEC-009); also keep the table
    // bounded by dropping attempts older than the configured window.
    pruneLoginAttempts();
    if (rateLimited(auth.username, ctx.ip)) return null;
    if (auth.password.includes(':')) {
      const [keyId, ...rest] = auth.password.split(':');
      const secret = rest.join(':');
      const key = get('SELECT * FROM login_keys WHERE key_id = ?', String(keyId));
      const valid = key && key.key_id === String(keyId) && verifyPassword(secret, key.secret)
        && (!key.expires_at || new Date(key.expires_at) > new Date());
      if (!valid) {
        recordFailure(auth.username, ctx.ip);
        return null;
      }
      const user = get('SELECT * FROM users WHERE id = ?', key.user_id);
      if (!user || user.suspended) return null;
      const commands = loginKeyCommands(key.commands);
      user.login_key = { id: key.id, key_id: key.key_id, commands, expires_at: key.expires_at };
      user.auth = { type: 'login_key', id: key.id, key_id: key.key_id, commands };
      if (loginKeyDenied(user, ctx)) return null;
      run('UPDATE login_keys SET last_used = ? WHERE id = ?', nowIso(), key.id);
      return user;
    }
    const user = apiLogin(auth.username, auth.password, ctx.ip);
    if (user) user.auth = { type: 'password' };
    return user;
  }
  if (ctx.user) {
    if (ctx.req.method === 'GET') return ctx.user;
    if (checkCsrf(ctx.session, ctx.req.headers['x-csrf-token'] || ctx.body._csrf, { api: false })) return ctx.user;
  }
  return null;
}

/** User ids visible to an actor: null means every user (admin). */
function scopeUserIds(actor) {
  if (!actor || actor.level === 'admin') return null;
  const ids = new Set();
  if (Number.isSafeInteger(Number(actor.id))) ids.add(Number(actor.id));
  for (const visible of visibleUsers(actor)) {
    if (Number.isSafeInteger(Number(visible.id))) ids.add(Number(visible.id));
  }
  return [...ids];
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(',');
}

function scopedEmailRows(actor) {
  const ids = scopeUserIds(actor);
  if (!ids) return all('SELECT e.* FROM email_accounts e ORDER BY e.domain, e.local_part');
  if (!ids.length) return [];
  return all(`SELECT e.* FROM email_accounts e JOIN domains d ON d.id = e.domain_id
              WHERE d.user_id IN (${placeholders(ids.length)}) ORDER BY e.domain, e.local_part`, ...ids);
}

function scopedDatabaseRows(actor, columns = 'db_name, db_user, size_mb') {
  const ids = scopeUserIds(actor);
  if (!ids) return all(`SELECT ${columns} FROM databases ORDER BY db_name`);
  if (!ids.length) return [];
  return all(`SELECT ${columns} FROM databases WHERE user_id IN (${placeholders(ids.length)}) ORDER BY db_name`, ...ids);
}

function scopedBackupRows(actor, limit = 100) {
  const ids = scopeUserIds(actor);
  if (!ids) return all('SELECT * FROM backups ORDER BY id DESC LIMIT ?', limit);
  if (!ids.length) return [];
  return all(`SELECT * FROM backups WHERE user_id IN (${placeholders(ids.length)}) ORDER BY id DESC LIMIT ?`, ...ids, limit);
}

function scopedFtpRows(actor) {
  const ids = scopeUserIds(actor);
  if (!ids) return all('SELECT * FROM ftp_accounts ORDER BY username');
  if (!ids.length) return [];
  return all(`SELECT * FROM ftp_accounts WHERE user_id IN (${placeholders(ids.length)}) ORDER BY username`, ...ids);
}

/** Run a query whose FROM clause joins domains as `d`, scoped to visible user ids. */
function scopedDomainJoin(actor, selectSql, fromSql, tailSql = '') {
  const ids = scopeUserIds(actor);
  if (!ids) return all(`${selectSql} ${fromSql} ${tailSql}`);
  if (!ids.length) return [];
  // A caller-supplied WHERE clause must become AND after the scope predicate.
  const tail = String(tailSql || '').replace(/^\s*WHERE\s+/i, 'AND ');
  return all(`${selectSql} ${fromSql} WHERE d.user_id IN (${placeholders(ids.length)}) ${tail}`, ...ids);
}

function userDomainsFor(user) {
  return visibleDomains(user);
}

function jsonOk(res, data = {}) { return res.json ? res.json({ ok: true, ...data }) : null; }

/* ------------------------------------------------- live notification stream */
const notificationStreams = new Set();
const NOTIFICATION_STREAM_LIMIT = 25;
const NOTIFICATION_STREAM_PER_USER = 3;
const NOTIFICATION_HEARTBEAT_MS = 20000;
const NOTIFICATION_STREAM_DEFAULT_MS = 5 * 60 * 1000;
const NOTIFICATION_STREAM_MAX_MS = 10 * 60 * 1000;

function apiNotificationLimit(raw, fallback = 20) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, n));
}

function apiNotificationCursor(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number.parseInt(String(raw), 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function apiNotificationStatus(raw) {
  if (raw === 'unread' || raw === 'read') return raw;
  if (raw === '1') return 'unread';
  if (raw === '0') return 'read';
  return 'all';
}

function notificationStreamMs(raw) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return NOTIFICATION_STREAM_DEFAULT_MS;
  return Math.max(5000, Math.min(NOTIFICATION_STREAM_MAX_MS, n));
}

function notificationStreamSince(ctx) {
  const header = Number.parseInt(String(ctx.req.headers['last-event-id'] || ''), 10);
  if (Number.isSafeInteger(header) && header > 0) return header;
  const query = Number.parseInt(String(ctx.query.since || ''), 10);
  return Number.isSafeInteger(query) && query > 0 ? query : null;
}

/** Defensive JSON guard; the server-level support check also blocks non-GET. */
function notificationMutationDenied(ctx, user) {
  if (ctx.session?.support) return { status: 403, json: { ok: false, error: 'Support access is read-only' } };
  if (Array.isArray(user?.api_scopes) && user.api_scopes.length
    && !user.api_scopes.includes('write') && !user.api_scopes.includes('admin')) {
    return { status: 403, json: { ok: false, error: 'This API key is read-only' } };
  }
  return null;
}

/* ------------------------------------------------------------------ REST */
export function registerApiRoutes(router) {
  const api = (method, p, handler) => router.add(method, p, (ctx) => {
    ctx.apiPattern = p;
    ctx.apiRoute = `${method} ${p}`;
    return handler(ctx);
  });

  api('POST', '/mcp', async (ctx) => {
    const out = await handleMcp(ctx);
    return { status: out.status || 200, json: out.json ?? { ok: true } };
  });

  api('GET', '/api/v1/openapi.json', (ctx) => {
    const doc = openapiDoc();
    return { json: doc };
  });

  api('GET', '/api/v1/ping', (ctx) => {
    // Public health probes stay minimal; authenticated admins may read the
    // version used by the multi-server registry.
    const headers = ctx.req.headers || {};
    const attempt = headers['x-api-key'] || /^(Basic|Bearer oa_)/i.test(String(headers.authorization || ''));
    const user = attempt ? authenticate(ctx) : null;
    if (user?.level === 'admin') return { json: { ok: true, product: 'OpenAdmin', version: VERSION } };
    return { json: { ok: true } };
  });

  api('GET', '/api/v1/me', (ctx) => {
    const user = authenticate(ctx);
    if (!user) return unauthorized(ctx);
    return {
      json: {
        ok: true, user: publicUser(user),
        auth: user.auth
          ? { type: user.auth.type, key_id: user.auth.key_id ?? null, commands: user.auth.commands || null, scopes: user.auth.scopes || null }
          : { type: 'session' },
        capabilities: ctx.caps, limits: limitsFor(user),
      },
    };
  });

  api('GET', '/api/v1/domains', (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    const rows = userDomainsFor(user).map((d) => ({ name: d.name, docroot: d.docroot, php: d.php_version, ssl: !!d.ssl, status: d.status }));
    return { json: { ok: true, domains: rows } };
  });

  api('POST', '/api/v1/domains', (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    const name = String(ctx.body.domain || ctx.body.name || '').toLowerCase();
    const q = quota(user, 'domains');
    if (!q.ok) return badRequest(ctx, `Domain limit reached (${q.used}/${q.limit})`);
    if (!isDomain(name)) return badRequest(ctx, 'Invalid domain name');
    if (get('SELECT id FROM domains WHERE name = ?', name)) return badRequest(ctx, 'Domain already exists');
    const r = run(`INSERT INTO domains(user_id, username, name, docroot, php_version, ssl, status, is_main, ip, created_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?)`, user.id, user.username, name,
      `/home/${user.username}/domains/${name}/public_html`, '8.3', 1, 'active', 0, setting('server_ip', '127.0.0.1'), nowIso());
    if (ctx.body.dns !== 'no') createZone(r.lastInsertRowid, name);
    return { json: { ok: true, domain: name, id: r.lastInsertRowid } };
  });

  api('DELETE', '/api/v1/domains/:name', (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    const d = domainFor(user, ctx.params.name);
    if (!d) return notFound(ctx, 'Domain not found');
    run('DELETE FROM domains WHERE id = ?', d.id);
    return { json: { ok: true } };
  });

  api('GET', '/api/v1/email', (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    const rows = scopedEmailRows(user).map((e) => ({
      local_part: e.local_part, domain: e.domain, quota_mb: e.quota_mb, used_mb: e.used_mb, suspended: e.suspended,
    }));
    return { json: { ok: true, email: rows } };
  });

  api('POST', '/api/v1/email', (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    const d = domainFor(user, String(ctx.body.domain || ''));
    if (!d) return badRequest(ctx, 'Domain not found');
    const q = quota(user, 'emails');
    if (!q.ok) return badRequest(ctx, `Mailbox limit reached (${q.used}/${q.limit})`);
    const local = String(ctx.body.local_part || ctx.body.user || '').toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(local)) return badRequest(ctx, 'Invalid mailbox name');
    const policyError = passwordPolicyError(String(ctx.body.password || ''));
    if (policyError) return badRequest(ctx, policyError);
    let mailHash = null;
    try { mailHash = dovecotHash(String(ctx.body.password)); } catch { /* optional */ }
    run(`INSERT INTO email_accounts(domain_id, domain, local_part, password, quota_mb, used_mb, suspended, created_at, mail_hash)
         VALUES(?,?,?,?,?,?,?,?,?)`, d.id, d.name, local, hashPassword(String(ctx.body.password)), Number(ctx.body.quota_mb) || 1024, 0, 0, nowIso(), mailHash);
    syncMail();
    apply({ mail: true });
    return { json: { ok: true, email: `${local}@${d.name}` } };
  });

  api('DELETE', '/api/v1/email/:address', (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    const [local, domain] = String(ctx.params.address).split('@');
    const d = domainFor(user, domain || '');
    if (!d) return notFound(ctx, 'Mailbox not found');
    const row = get('SELECT * FROM email_accounts WHERE local_part = ? AND domain_id = ?', local, d.id);
    if (!row) return notFound(ctx, 'Mailbox not found');
    run('DELETE FROM email_accounts WHERE id = ?', row.id);
    syncMail();
    apply({ mail: true });
    return { json: { ok: true } };
  });

  api('GET', '/api/v1/dns/:domain', (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    const d = domainFor(user, ctx.params.domain);
    if (!d) return notFound(ctx, 'Domain not found');
    const records = all('SELECT id, name, type, value, priority, ttl FROM dns_records WHERE domain_id = ? ORDER BY type, name', d.id);
    return { json: { ok: true, domain: d.name, records } };
  });

  api('POST', '/api/v1/dns/:domain', (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    const d = domainFor(user, ctx.params.domain);
    if (!d) return notFound(ctx, 'Domain not found');
    run('INSERT INTO dns_records(domain_id, name, type, value, priority, ttl) VALUES(?,?,?,?,?,?)',
      d.id, String(ctx.body.name || '@'), String(ctx.body.type || 'A').toUpperCase(), String(ctx.body.value || ''),
      ctx.body.priority ? Number(ctx.body.priority) : null, Number(ctx.body.ttl) || 3600);
    return { json: { ok: true } };
  });

  api('GET', '/api/v1/databases', (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    return { json: { ok: true, databases: scopedDatabaseRows(user) } };
  });

  api('GET', '/api/v1/users', (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    if (user.level === 'user') return forbidden(ctx);
    const rows = visibleUsers(user, { level: 'user' }).map(publicUser);
    return { json: { ok: true, users: rows } };
  });

  api('POST', '/api/v1/users', (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    if (user.level === 'user') return forbidden(ctx);
    const username = String(ctx.body.username || '').toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]{1,31}$/.test(username)) return badRequest(ctx, 'Invalid username');
    if (get('SELECT id FROM users WHERE lower(username) = ?', username)) return badRequest(ctx, 'Username exists');
    const pkg = get('SELECT * FROM packages WHERE name = ?', String(ctx.body.package || 'default'));
    if (!pkg) return badRequest(ctx, 'Package not found');
    if (user.level === 'reseller') {
      const q = quota(user, 'users');
      if (!q.ok) return badRequest(ctx, `User limit reached (${q.used}/${q.limit})`);
    }
    const domain = String(ctx.body.domain || '').toLowerCase();
    const password = String(ctx.body.password || '');
    const policyError = passwordPolicyError(password);
    if (policyError) return badRequest(ctx, policyError);
    const created = systemProvider().createUser(username, `/home/${username}`);
    if (!created.ok) return badRequest(ctx, created.output);
    const r = run(`INSERT INTO users(username, password, email, level, owner, package, domain, ip, created_at)
                   VALUES(?,?,?,?,?,?,?,?,?)`, username, hashPassword(password),
      String(ctx.body.email || ''), 'user', user.level === 'reseller' ? user.username : null, pkg.name, domain,
      String(ctx.body.ip || setting('server_ip', '')), nowIso());
    if (domain && isDomain(domain)) {
      const dr = run(`INSERT INTO domains(user_id, username, name, docroot, php_version, ssl, status, is_main, ip, created_at)
                      VALUES(?,?,?,?,?,?,?,?,?,?)`, r.lastInsertRowid, username, domain,
        `/home/${username}/domains/${domain}/public_html`, '8.3', 1, 'active', 1, setting('server_ip', ''), nowIso());
      createZone(dr.lastInsertRowid, domain);
      provisionDomain(username, domain);
    }
    homeDir(username);
    apply({ web: true, dns: true, mail: true, pools: true });
    return { json: { ok: true, id: r.lastInsertRowid, username } };
  });

  api('GET', '/api/v1/packages', (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    const rows = all('SELECT name, type, limits FROM packages ORDER BY name').map((p) => ({ name: p.name, type: p.type, limits: JSON.parse(p.limits) }));
    return { json: { ok: true, packages: rows } };
  });

  api('GET', '/api/v1/backups/:id/download', (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    const row = backupFor(user, ctx.params.id);
    if (!row) return notFound(ctx, 'Backup not found');
    const file = backupPath(row.filename);
    if (!fs.existsSync(file)) return notFound(ctx, 'Archive file is missing');
    const stat = fs.statSync(file);
    ctx.res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${row.filename}"`,
    });
    fs.createReadStream(file).pipe(ctx.res);
    return { handled: true };
  });

  api('GET', '/api/v1/webserver', async (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    if (user.level !== 'admin') return forbidden(ctx);
    const { detect, activeServer, stagingDir } = await import('../webserver.mjs');
    const detected = detect();
    const active = activeServer();
    let files = 0;
    try { files = fs.readdirSync(pathMod.join(stagingDir(active), 'sites')).filter((f) => f.endsWith('.conf')).length; } catch { files = 0; }
    return {
      json: {
        ok: true,
        active: active.id,
        servers: Object.fromEntries(Object.entries(detected).map(([id, d]) => [id, {
          label: d.label, installed: d.installed, binary: d.binary?.path || null, version: d.binary?.version || null,
          service: d.service?.status || null,
        }])),
        generatedFiles: files,
        stagingDir: stagingDir(active),
      },
    };
  });

  api('GET', '/api/v1/stats', (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    const rows = all('SELECT * FROM usage_daily WHERE username = ? ORDER BY day DESC LIMIT 30', user.username);
    return { json: { ok: true, stats: rows } };
  });

  api('GET', '/api/v1/system', (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    // SEC-016: only administrators receive host/topology information. Other
    // roles get a role-appropriate, count-free document.
    if (user.level !== 'admin') {
      return { json: { ok: true, product: 'OpenAdmin', scope: 'account' } };
    }
    return {
      json: {
        ok: true, product: 'OpenAdmin', version: VERSION, license: 'AGPL-3.0 (unlimited, free)',
        server: { hostname: setting('server_name', 'localhost'), ip: setting('server_ip', '127.0.0.1'), ns1: setting('ns1', ''), ns2: setting('ns2', '') },
        counts: { users: get('SELECT COUNT(*) n FROM users').n, domains: get('SELECT COUNT(*) n FROM domains').n, packages: get('SELECT COUNT(*) n FROM packages').n },
        node: process.version, platform: process.platform,
      },
    };
  });

  /* ------------------------------------------------------ notifications API */
  api('GET', '/api/v1/notifications', (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    const feed = notificationFeed(user.id, {
      limit: apiNotificationLimit(ctx.query.limit),
      cursor: apiNotificationCursor(ctx.query.cursor || ctx.query.before),
      status: apiNotificationStatus(ctx.query.status || ctx.query.filter || (ctx.query.unread === '1' ? 'unread' : 'all')),
      level: String(ctx.query.level || ctx.query.severity || ''),
    });
    return {
      json: {
        ok: true,
        unread: feed.unread,
        unread_count: feed.unread,
        items: feed.items,
        notifications: feed.items,
        latest: feed.items,
        count: feed.items.length,
        has_more: feed.has_more,
        cursor: feed.next_cursor,
        next_cursor: feed.next_cursor,
        limit: feed.limit,
        server_time: feed.server_time,
        poll_after_ms: 15000,
        stream: '/api/v1/notifications/stream',
      },
    };
  });

  api('GET', '/api/v1/notifications/stream', (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    const res = ctx.res;
    let userStreams = 0;
    for (const c of notificationStreams) if (c.userId === user.id) userStreams++;
    if (notificationStreams.size >= NOTIFICATION_STREAM_LIMIT) {
      res.setHeader('Retry-After', '30');
      return { status: 503, json: { ok: false, error: 'Too many notification streams', retry_after: 30 } };
    }
    if (userStreams >= NOTIFICATION_STREAM_PER_USER) {
      res.setHeader('Retry-After', '30');
      return { status: 429, json: { ok: false, error: 'Too many notification streams for this account', retry_after: 30 } };
    }
    const limit = apiNotificationLimit(ctx.query.limit);
    const maxMs = notificationStreamMs(ctx.query.max_ms);
    const since = notificationStreamSince(ctx);
    const client = {
      userId: user.id, res, closed: false, ready: false, pending: [],
      unsubscribe: null, heartbeat: null, lifetime: null,
    };
    const close = () => {
      if (client.closed) return;
      client.closed = true;
      try { client.unsubscribe?.(); } catch { /* ignore */ }
      if (client.heartbeat) clearInterval(client.heartbeat);
      if (client.lifetime) clearTimeout(client.lifetime);
      notificationStreams.delete(client);
      try { if (!res.writableEnded) res.end(); } catch { /* ignore */ }
    };
    const send = (event, data, id) => {
      if (client.closed || res.writableEnded || res.destroyed) return false;
      let frame = '';
      if (event) frame += `event: ${event}\n`;
      if (id !== undefined && id !== null) frame += `id: ${id}\n`;
      // JSON.stringify escapes newlines, so every data frame stays single-line.
      frame += `data: ${JSON.stringify(data)}\n\n`;
      try { res.write(frame); return true; } catch { close(); return false; }
    };
    const deliver = (event) => {
      if (client.closed) return;
      const row = event.notification || null;
      if (row && !(row.user_id === null || row.user_id === undefined || row.user_id === user.id)) return;
      const unread = notificationUnreadCount(user.id);
      const at = nowIso();
      if (event.type === 'created') {
        send('notification', { ok: true, notification: notificationView(row), unread, unread_count: unread, server_time: at }, row?.id);
      } else if (event.type === 'read' || event.type === 'deleted') {
        send('change', { ok: true, type: event.type, id: row?.id ?? null, unread, unread_count: unread, server_time: at });
      } else if (event.type === 'read-all') {
        send('change', { ok: true, type: 'read-all', id: null, unread, unread_count: unread, server_time: at });
      }
    };

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    notificationStreams.add(client);

    // Subscribe before the initial snapshot so a notification created while the
    // connection is being set up is buffered rather than lost.
    client.unsubscribe = subscribeNotifications((event) => {
      if (client.closed) return;
      if (!client.ready) { if (client.pending.length < 200) client.pending.push(event); return; }
      deliver(event);
    });
    res.on('close', close);
    res.on('error', close);
    const feed = notificationFeed(user.id, { limit });
    send('ready', {
      ok: true,
      unread: feed.unread,
      unread_count: feed.unread,
      items: feed.items,
      count: feed.items.length,
      has_more: feed.has_more,
      cursor: feed.next_cursor,
      next_cursor: feed.next_cursor,
      server_time: feed.server_time,
      heartbeat_ms: NOTIFICATION_HEARTBEAT_MS,
      max_ms: maxMs,
      stream: true,
    });
    if (since) {
      const missed = all('SELECT * FROM notifications WHERE (user_id = ? OR user_id IS NULL) AND id > ? ORDER BY id ASC LIMIT 50', user.id, since);
      for (const row of missed) {
        send('notification', { ok: true, notification: notificationView(row), unread: notificationUnreadCount(user.id), server_time: nowIso() }, row.id);
      }
      if (missed.length === 50) {
        send('change', { ok: true, type: 'catchup-truncated', unread: notificationUnreadCount(user.id), server_time: nowIso() });
      }
    }
    client.ready = true;
    for (const event of client.pending.splice(0)) deliver(event);
    client.heartbeat = setInterval(() => {
      send('heartbeat', { ok: true, server_time: nowIso(), unread: notificationUnreadCount(user.id) });
    }, NOTIFICATION_HEARTBEAT_MS);
    client.heartbeat.unref?.();
    client.lifetime = setTimeout(() => {
      send('close', { ok: true, reason: 'max-duration', server_time: nowIso() });
      close();
    }, maxMs);
    client.lifetime.unref?.();
    return { handled: true };
  });

  const readNotification = (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    const denied = notificationMutationDenied(ctx, user); if (denied) return denied;
    const id = apiNotificationCursor(ctx.params.id);
    if (!id) return badRequest(ctx, 'Invalid notification id');
    const r = markNotificationRead(id, user.id);
    if (!r.ok) return notFound(ctx, 'Notification not found');
    const unread = notificationUnreadCount(user.id);
    return { json: { ok: true, id: r.id, read_at: r.read_at, changed: r.changed, unread, unread_count: unread, server_time: nowIso() } };
  };
  api('POST', '/api/v1/notifications/:id/read', readNotification);

  api('POST', '/api/v1/notifications/read-all', (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    const denied = notificationMutationDenied(ctx, user); if (denied) return denied;
    const r = markAllNotificationsRead(user.id);
    const unread = notificationUnreadCount(user.id);
    return { json: { ok: true, marked: r.marked, read: r.marked, unread, unread_count: unread, server_time: nowIso() } };
  });

  const removeNotification = (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    const denied = notificationMutationDenied(ctx, user); if (denied) return denied;
    const id = apiNotificationCursor(ctx.params.id);
    if (!id) return badRequest(ctx, 'Invalid notification id');
    const r = deleteNotificationRecord(id, user.id);
    if (!r.ok) return notFound(ctx, 'Notification not found');
    const unread = notificationUnreadCount(user.id);
    return { json: { ok: true, id: r.id, deleted: true, unread, unread_count: unread, server_time: nowIso() } };
  };
  api('DELETE', '/api/v1/notifications/:id', removeNotification);
  api('POST', '/api/v1/notifications/:id/delete', removeNotification);

  /* ------------------------------------------------------------ file API */
  api('GET', '/api/v1/files', (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    // SEC-002: listing rejects symlink escapes and never exposes host paths.
    const listing = listTenantDir(user.username, ctx.query.path || '');
    return {
      json: {
        ok: true,
        path: listing.display,
        entries: listing.entries.map((entry) => ({
          name: entry.name,
          type: entry.dir ? 'dir' : 'file',
          size: entry.size,
          modified: entry.mtime,
          symlink: entry.symlink,
          unsafe: entry.unsafe,
        })),
      },
    };
  });

  api('GET', '/api/v1/files/limits', (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    return { json: { ok: true, maxUploadMb: config.limits.maxUploadMb, maxUploadBytes: config.limits.maxUploadMb * 1024 * 1024 } };
  });

  api('POST', '/api/v1/files/upload', (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    const name = validateEntryName(String(ctx.body.name || 'upload.bin'));
    const encoded = String(ctx.body.data || '');
    const maxBytes = config.limits.maxUploadMb * 1024 * 1024;
    if (encoded.length > Math.ceil(maxBytes / 3) * 4) {
      return { status: 413, json: { ok: false, code: 'too_large', error: `File too large. Limit ${config.limits.maxUploadMb} MB (${maxBytes} bytes).` } };
    }
    const buf = Buffer.from(encoded, 'base64');
    if (buf.length > maxBytes) return { status: 413, json: { ok: false, code: 'too_large', error: `File too large: ${(buf.length / 1048576).toFixed(2)} MB > ${config.limits.maxUploadMb} MB.` } };
    const disk = checkDisk(user, buf.length / 1024 / 1024);
    if (!disk.ok) return { status: 413, json: { ok: false, error: `Disk quota exceeded (${disk.used.toFixed(1)} / ${disk.limit} MB)` } };
    // SEC-002: resolve the *full* target (including the final component) with
    // O_NOFOLLOW semantics. A pre-existing symlink/hardlink in the destination
    // must never redirect the write outside the tenant home.
    const base = String(ctx.body.path || `/home/${user.username}`).replace(/\/+$/, '');
    const requested = `${base}/${name}`;
    let written;
    try {
      written = writeTenantFile(user.username, requested, buf, { create: true });
    } catch (error) {
      if (error?.code === 'ALREADY_EXISTS') written = writeTenantFile(user.username, requested, buf, { create: false });
      else throw error;
    }
    return { json: { ok: true, path: written.display, size: buf.length } };
  });

  api('GET', '/api/v1/files/download', (ctx) => {
    const user = authenticate(ctx); if (!user) return unauthorized(ctx);
    const abs = resolveUserPath(user.username, ctx.query.path || '', { operation: 'read' });
    if (!abs.startsWith(homeDir(user.username))) return forbidden(ctx);
    if (!fs.existsSync(abs)) return notFound(ctx, 'File not found');
    if (fs.statSync(abs).isDirectory()) {
      // Stream a tar.gz of the directory using the system tar (arguments are not shell-interpreted).
      ctx.res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${path.basename(abs) || 'home'}.tar.gz"`,
      });
      const base = path.dirname(abs);
      const tar = spawn('tar', ['-czf', '-', '-C', base, path.basename(abs)]);
      tar.stdout.pipe(ctx.res);
      tar.stderr.on('data', () => { /* ignore */ });
      return { handled: true };
    }
    const data = fs.readFileSync(abs);
    ctx.res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': data.length,
      'Content-Disposition': `attachment; filename="${path.basename(abs)}"`,
    });
    ctx.res.end(data);
    return { handled: true };
  });

  /* --------------------------------------------------------- legacy CMD_API */
  const commands = {
    CMD_API_DOMAIN: (user) => {
      const rows = userDomainsFor(user);
      return { error: 0, text: 'Domains', list: rows.map((d) => d.name) };
    },
    CMD_API_SHOW_DOMAINS: (user) => ({ error: 0, text: 'Domains', list: userDomainsFor(user).map((d) => d.name) }),
    CMD_API_POP: (user, ctx) => {
      const domains = userDomainsFor(user).map((d) => d.name);
      const action = ctx.query.action || '';
      if (action === 'create') {
        const domain = String(ctx.query.domain || '');
        if (!domains.includes(domain)) return { error: 1, text: 'Domain not owned by user' };
        const local = String(ctx.query.user || '').toLowerCase();
        if (!local) return { error: 1, text: 'No username given' };
        const q = quota(user, 'emails');
        if (!q.ok) return { error: 1, text: `Mailbox limit reached (${q.used}/${q.limit})` };
        const password = String(ctx.query.passwd || ctx.query.password || '');
        if (password.length < 8) return { error: 1, text: 'Password must be at least 8 characters' };
        let mailHash = null;
        try { mailHash = dovecotHash(password); } catch { /* optional */ }
        run(`INSERT INTO email_accounts(domain_id, domain, local_part, password, quota_mb, used_mb, suspended, created_at, mail_hash)
             VALUES(?,?,?,?,?,?,?,?,?)`, get('SELECT id FROM domains WHERE name = ?', domain).id, domain, local, hashPassword(password), Number(ctx.query.quota) || 1024, 0, 0, nowIso(), mailHash);
        syncMail();
        apply({ mail: true });
    apply({ mail: true });
        return { error: 0, text: `Email account ${local}@${domain} created` };
      }
      if (action === 'delete') {
        const d = domainFor(user, ctx.query.domain || '');
        const local = String(ctx.query.user || ctx.query.local_part || '').toLowerCase();
        if (!d || !local) return { error: 1, text: 'Domain not found' };
        run('DELETE FROM email_accounts WHERE local_part = ? AND domain_id = ?', local, d.id);
        syncMail();
        apply({ mail: true });
        return { error: 0, text: 'Email account deleted' };
      }
      return { error: 0, text: 'Email accounts', list: scopedEmailRows(user).map((r) => `${r.local_part}@${r.domain}`) };
    },
    CMD_API_LICENSE: () => ({ error: 0, text: 'Unlimited free license', type: 'unlimited', expires: 'never', holders: '0' }),
    CMD_API_IP_MANAGER: (user) => {
      if (user.level === 'user') return { error: 1, text: 'Permission denied' };
      return { error: 0, text: 'IPs', list: all('SELECT ip FROM ips').map((i) => i.ip) };
    },
    CMD_API_SERVICES: (user) => {
      if (user.level !== 'admin') return { error: 1, text: 'Admin access required' };
      return { error: 0, text: 'Services', list: all('SELECT name FROM services').map((s) => s.name) };
    },
    CMD_API_SITE_BACKUP: (user, ctx) => {
      if (user.level === 'user') return { error: 1, text: 'Permission denied' };
      const filename = `api_backup_${Date.now()}.tar.gz`;
      run('INSERT INTO backups(user_id, filename, kind, size_mb, status, created_at) VALUES(?,?,?,?,?,?)',
        user.id, filename, 'api', 0, 'complete', nowIso());
      return { error: 0, text: 'Backup created', filename };
    },

    CMD_API_EMAIL_FORWARDER: (user, ctx) => {
      const action = String(ctx.query.action || '');
      const d = domainFor(user, ctx.query.domain || '');
      if (action === 'create') {
        if (!d) return { error: 1, text: 'Domain not found' };
        const source = String(ctx.query.source || ctx.query.prefix || '').toLowerCase();
        const dest = String(ctx.query.dest || ctx.query.destination || '');
        if (!source || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(dest)) return { error: 1, text: 'source and dest are required' };
        run('INSERT INTO email_forwarders(domain_id, domain, source, dest, keep_copy, created_at) VALUES(?,?,?,?,?,?)',
          d.id, d.name, source, dest, ctx.query.keep_copy === 'no' ? 0 : 1, nowIso());
        audit(user.username, user.level, 'email.forwarder', `${source}@${d.name}`, ctx.ip);
        return { error: 0, text: 'Forwarder created' };
      }
      if (action === 'delete') {
        const target = domainFor(user, ctx.query.domain || '');
        if (!target) return { error: 1, text: 'Domain not found' };
        run('DELETE FROM email_forwarders WHERE source = ? AND domain_id = ?', String(ctx.query.source || ''), target.id);
        return { error: 0, text: 'Forwarder deleted' };
      }
      return { error: 0, text: 'Forwarders', list: scopedDomainJoin(user,
        "SELECT f.source || '@' || f.domain AS a", 'FROM email_forwarders f JOIN domains d ON d.id = f.domain_id',
        'ORDER BY f.domain, f.source').map((r) => r.a) };
    },
    CMD_API_EMAIL_AUTORESPONDER: (user, ctx) => {
      const action = String(ctx.query.action || '');
      const d = domainFor(user, ctx.query.domain || '');
      if (action === 'create') {
        if (!d) return { error: 1, text: 'Domain not found' };
        const addr = String(ctx.query.email || ctx.query.user || '').toLowerCase();
        const email = addr.includes('@') ? addr : `${addr}@${d.name}`;
        if (!email.endsWith(`@${d.name}`)) return { error: 1, text: 'Email must belong to the selected domain' };
        if (!ctx.query.subject) return { error: 1, text: 'subject is required' };
        run('INSERT INTO autoresponders(domain_id, domain, email, subject, body, enabled, created_at) VALUES(?,?,?,?,?,?,?)',
          d.id, d.name, email, String(ctx.query.subject), String(ctx.query.body || ctx.query.text || ''), 1, nowIso());
        audit(user.username, user.level, 'email.autoresponder', email, ctx.ip);
        return { error: 0, text: 'Autoresponder created' };
      }
      if (action === 'delete') {
        const email = String(ctx.query.email || '').toLowerCase();
        const domain = email.includes('@') ? email.split('@').pop() : '';
        const target = domainFor(user, domain);
        if (!target) return { error: 1, text: 'Autoresponder not found' };
        run('DELETE FROM autoresponders WHERE email = ? AND domain_id = ?', email, target.id);
        return { error: 0, text: 'Autoresponder deleted' };
      }
      return { error: 0, text: 'Autoresponders', list: scopedDomainJoin(user,
        'SELECT a.email', 'FROM autoresponders a JOIN domains d ON d.id = a.domain_id', 'ORDER BY a.email').map((r) => r.email) };
    },
    CMD_API_EMAIL_VACATION: (user, ctx) => {
      const action = String(ctx.query.action || '');
      const d = domainFor(user, ctx.query.domain || '');
      if (action === 'create' || action === 'modify') {
        if (!d) return { error: 1, text: 'Domain not found' };
        const email = String(ctx.query.email || '').toLowerCase();
        if (!email.includes('@')) return { error: 1, text: 'email is required' };
        if (!email.endsWith(`@${d.name}`)) return { error: 1, text: 'Email must belong to the selected domain' };
        run(`INSERT INTO vacation(domain, email, subject, body, start_date, end_date, enabled, created_at) VALUES(?,?,?,?,?,?,?,?)
             ON CONFLICT(email) DO UPDATE SET subject = excluded.subject, body = excluded.body, enabled = 1`,
          d.name, email, String(ctx.query.subject || 'Out of office'), String(ctx.query.body || ''), ctx.query.start || null, ctx.query.end || null, 1, nowIso());
        return { error: 0, text: 'Vacation message saved' };
      }
      if (action === 'delete') {
        const email = String(ctx.query.email || '').toLowerCase();
        const target = domainFor(user, email.includes('@') ? email.split('@').pop() : '');
        if (!target) return { error: 1, text: 'Vacation message not found' };
        run('DELETE FROM vacation WHERE email = ? AND domain = ?', email, target.name);
        return { error: 0, text: 'Vacation message deleted' };
      }
      return { error: 0, text: 'Vacation messages', list: scopedDomainJoin(user,
        'SELECT v.email', 'FROM vacation v JOIN domains d ON d.name = v.domain', 'ORDER BY v.email').map((r) => r.email) };
    },
    CMD_API_FTP: (user, ctx) => {
      const action = String(ctx.query.action || '');
      if (action === 'create') {
        const base = String(ctx.query.user || ctx.query.username || '').replace(/[^a-zA-Z0-9._-]/g, '');
        if (!base || !ctx.query.passwd) return { error: 1, text: 'user and passwd are required' };
        const username = `${user.username}_${base}`.slice(0, 32);
        if (get('SELECT id FROM ftp_accounts WHERE username = ?', username)) return { error: 1, text: 'FTP user exists' };
        // The FTP root must stay inside the acting account's home (SEC-001/002).
        const safePath = resolveUserPath(user.username, String(ctx.query.path || `/home/${user.username}`), { operation: 'read' });
        const pathValue = displayPath(user.username, safePath);
        const created = systemProvider().createFtpUser(username, pathValue, String(ctx.query.passwd));
        if (!created.ok) return { error: 1, text: created.output };
        run('INSERT INTO ftp_accounts(user_id, username, path, quota_mb, password, created_at) VALUES(?,?,?,?,?,?)',
          user.id, username, pathValue, Number(ctx.query.quota) || 0, hashPassword(String(ctx.query.passwd)), nowIso());
        return { error: 0, text: 'FTP account created', username };
      }
      if (action === 'delete') {
        const uname = String(ctx.query.user || ctx.query.username || '');
        const ids = scopeUserIds(user);
        const row = ids
          ? get(`SELECT * FROM ftp_accounts WHERE username = ? AND user_id IN (${placeholders(ids.length)})`, uname, ...ids)
          : get('SELECT * FROM ftp_accounts WHERE username = ?', uname);
        if (!row) return { error: 1, text: 'FTP account not found' };
        systemProvider().deleteFtpUser(uname);
        run('DELETE FROM ftp_accounts WHERE id = ?', row.id);
        return { error: 0, text: 'FTP account deleted' };
      }
      return { error: 0, text: 'FTP accounts', list: scopedFtpRows(user).map((r) => r.username) };
    },
    CMD_API_DATABASES: (user, ctx) => {
      const action = String(ctx.query.action || '');
      if (action === 'create') {
        const name = String(ctx.query.name || ctx.query.db || '').replace(/[^a-zA-Z0-9_]/g, '');
        if (!name) return { error: 1, text: 'name is required' };
        const dbName = name.startsWith(user.username + '_') ? name : `${user.username}_${name}`;
        if (!ctx.query.passwd) return { error: 1, text: 'passwd is required' };
        const dbUser = `${user.username}_${String(ctx.query.user || name).replace(/[^a-zA-Z0-9_]/g, '')}`.slice(0, 64);
        if (mariadbDetect().connected) {
          const created = mariaCreate(dbName);
          if (!created.ok) return { error: 1, text: created.error };
          const acct = mariaAccount(dbName, dbUser, String(ctx.query.passwd));
          if (!acct.ok) { mariaDrop(dbName); return { error: 1, text: acct.error }; }
        }
        run('INSERT INTO databases(user_id, db_name, db_user, password, password_enc, size_mb, created_at) VALUES(?,?,?,?,?,?,?)',
          user.id, dbName, dbUser, hashPassword(String(ctx.query.passwd)), encryptSecret(String(ctx.query.passwd)), 0, nowIso());
        return { error: 0, text: 'Database created', name: dbName };
      }
      if (action === 'delete') {
        const dbName = String(ctx.query.name || ctx.query.db || '');
        const ids = scopeUserIds(user);
        const row = ids
          ? get(`SELECT * FROM databases WHERE db_name = ? AND user_id IN (${placeholders(ids.length)})`, dbName, ...ids)
          : get('SELECT * FROM databases WHERE db_name = ?', dbName);
        if (!row) return { error: 1, text: 'Database not found' };
        if (mariadbDetect().connected) {
          mariaDrop(row.db_name);
          mariaDropAccount(row.db_user);
        }
        run('DELETE FROM databases WHERE id = ?', row.id);
        return { error: 0, text: 'Database deleted' };
      }
      return { error: 0, text: 'Databases', list: scopedDatabaseRows(user, 'db_name').map((r) => r.db_name) };
    },
    CMD_API_CRON_JOBS: (user, ctx) => {
      const action = String(ctx.query.action || '');
      if (action === 'create') {
        if (!ctx.query.command) return { error: 1, text: 'command is required' };
        run('INSERT INTO cron_jobs(user_id, minute, hour, day, month, weekday, command, created_at) VALUES(?,?,?,?,?,?,?,?)',
          user.id, String(ctx.query.minute || '0'), String(ctx.query.hour || '*'), String(ctx.query.day || '*'),
          String(ctx.query.month || '*'), String(ctx.query.weekday || '*'), String(ctx.query.command), nowIso());
        rebuildCrontab(user.username);
        return { error: 0, text: 'Cron job created' };
      }
      if (action === 'delete') {
        run('DELETE FROM cron_jobs WHERE id = ? AND user_id = ?', Number(ctx.query.id || 0), user.id);
        rebuildCrontab(user.username);
        return { error: 0, text: 'Cron job deleted' };
      }
      return { error: 0, text: 'Cron jobs', list: all('SELECT command FROM cron_jobs WHERE user_id = ?', user.id).map((r) => r.command) };
    },
    CMD_API_SUBDOMAIN: (user, ctx) => {
      const action = String(ctx.query.action || '');
      const d = domainFor(user, ctx.query.domain || '');
      if (action === 'create') {
        if (!d) return { error: 1, text: 'Domain not found' };
        const name = String(ctx.query.name || ctx.query.subdomain || '').toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) return { error: 1, text: 'Invalid subdomain' };
        run('INSERT INTO subdomains(domain_id, username, name, php_version, docroot, created_at) VALUES(?,?,?,?,?,?)',
          d.id, user.username, name, d.php_version, `/home/${user.username}/domains/${d.name}/public_html/${name}`, nowIso());
        apply({ web: true, dns: true });
        return { error: 0, text: 'Subdomain created', name: `${name}.${d.name}` };
      }
      if (action === 'delete') {
        run('DELETE FROM subdomains WHERE name = ? AND username = ?', String(ctx.query.name || ''), user.username);
        return { error: 0, text: 'Subdomain deleted' };
      }
      return { error: 0, text: 'Subdomains', list: all('SELECT name FROM subdomains WHERE username = ?', user.username).map((r) => r.name) };
    },
    CMD_API_DOMAIN_POINTER: (user, ctx) => {
      const action = String(ctx.query.action || '');
      const d = domainFor(user, ctx.query.domain || '');
      if (action === 'create') {
        if (!d) return { error: 1, text: 'Domain not found' };
        const alias = String(ctx.query.alias || '').toLowerCase();
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(alias)) return { error: 1, text: 'Invalid alias' };
        run("INSERT INTO dns_records(domain_id, name, type, value, ttl) VALUES(?,?,?,?,?)", d.id, `pointer-${alias}`, 'POINTER', alias, 3600);
        apply({ web: true, dns: true });
        return { error: 0, text: 'Pointer created' };
      }
      if (action === 'delete') {
        run("DELETE FROM dns_records WHERE type = 'POINTER' AND value = ? AND domain_id = ?", String(ctx.query.alias || ''), d?.id || 0);
        return { error: 0, text: 'Pointer deleted' };
      }
      return { error: 0, text: 'Pointers', list: all(`SELECT r.value FROM dns_records r JOIN domains d ON d.id = r.domain_id WHERE r.type = 'POINTER' AND d.user_id = ?`, user.id).map((r) => r.value) };
    },
    CMD_API_REDIRECT: (user, ctx) => {
      const action = String(ctx.query.action || '');
      const d = domainFor(user, ctx.query.domain || '');
      if (action === 'create') {
        if (!d) return { error: 1, text: 'Domain not found' };
        if (!/^https?:\/\//i.test(String(ctx.query.to || ''))) return { error: 1, text: 'to must start with http:// or https://' };
        run('INSERT INTO redirects(domain_id, username, from_path, to_url, type, created_at) VALUES(?,?,?,?,?,?)',
          d.id, user.username, String(ctx.query.from || '/'), String(ctx.query.to), String(ctx.query.type || '301'), nowIso());
        apply({ web: true });
        return { error: 0, text: 'Redirect created' };
      }
      if (action === 'delete') {
        run('DELETE FROM redirects WHERE from_path = ? AND username = ?', String(ctx.query.from || ''), user.username);
        return { error: 0, text: 'Redirect deleted' };
      }
      return { error: 0, text: 'Redirects', list: all('SELECT from_path FROM redirects WHERE username = ?', user.username).map((r) => r.from_path) };
    },
    CMD_API_SSL: (user, ctx) => {
      const action = String(ctx.query.action || '');
      const domain = String(ctx.query.domain || '');
      const d = domainFor(user, domain);
      if (action === 'create' || action === 'selfsigned' || action === 'issue') {
        if (!d) return { error: 1, text: 'Domain not found' };
        const result = action === 'issue' ? issueLetsEncrypt(d.name, d.docroot, user.email || '') : generateSelfSigned(d.name, Number(ctx.query.days) || 365);
        if (!result.ok) return { error: 1, text: result.error };
        try { apply({ web: true }); } catch { /* apply status records it */ }
        return { error: 0, text: 'Certificate installed', expires: result.expiresAt || '' };
      }
      if (action === 'install' && ctx.query.cert && ctx.query.key) {
        if (!d) return { error: 1, text: 'Domain not found' };
        const result = installPem(d.name, String(ctx.query.cert), String(ctx.query.key), 'custom');
        if (result.ok) { try { apply({ web: true }); } catch { /* apply status records it */ } }
        return result.ok ? { error: 0, text: 'Certificate installed' } : { error: 1, text: result.error };
      }
      if (action === 'delete') {
        if (!d) return { error: 1, text: 'Domain not found' };
        run('DELETE FROM ssl_certs WHERE domain = ?', d.name);
        const paths = certPaths(d.name);
        try { fs.rmSync(paths.dir, { recursive: true, force: true }); } catch { /* ignore */ }
        return { error: 0, text: 'Certificate deleted' };
      }
      return { error: 0, text: 'Certificates', list: all('SELECT domain FROM ssl_certs WHERE username = ?', user.username).map((r) => r.domain) };
    },
    CMD_API_STATS: (user) => ({ error: 0, text: 'Stats', list: all('SELECT day || char(61) || bandwidth_mb AS v FROM usage_daily WHERE username = ?', user.username).map((r) => Object.values(r)[0]) }),
    CMD_API_REBOOT: (user, ctx) => {
      if (user.level !== 'admin') return { error: 1, text: 'Admin access required' };
      if (ctx.query.confirm !== 'yes') return { error: 1, text: 'Pass confirm=yes to reboot' };
      audit(user.username, 'admin', 'server.reboot', 'api', ctx.ip);
      return { error: 0, text: 'Reboot scheduled' };
    },
    CMD_API_TICKET_CREATE: (user, ctx) => {
      const subject = String(ctx.query.subject || '');
      const body = String(ctx.query.message || ctx.query.body || '');
      if (!subject || !body) return { error: 1, text: 'subject and message are required' };
      const ts = nowIso();
      const r = run(`INSERT INTO tickets(user_id, username, subject, department, priority, status, created_at, updated_at)
                     VALUES(?,?,?,?,?,?,?,?)`, user.id, user.username, subject, String(ctx.query.department || 'support'),
        String(ctx.query.priority || 'normal'), 'open', ts, ts);
      run('INSERT INTO ticket_messages(ticket_id, author, level, body, created_at) VALUES(?,?,?,?,?)', r.lastInsertRowid, user.username, user.level, body, ts);
      return { error: 0, text: 'Ticket created', id: String(r.lastInsertRowid) };
    },
  };

  // Aliases that the frontend publishes but the API historically named differently.
  commands.CMD_API_EMAIL_POP = commands.CMD_API_POP;
  commands.CMD_API_DB = commands.CMD_API_DATABASES;
  commands.CMD_API_DOMAIN = (user, ctx) => {
    const action = String(ctx.query.action || '');
    if (action === 'create') {
      const name = String(ctx.query.domain || ctx.query.name || '').toLowerCase();
      const q = quota(user, 'domains');
      if (!q.ok) return { error: 1, text: `Domain limit reached (${q.used}/${q.limit})` };
      if (!isDomain(name)) return { error: 1, text: 'Invalid domain name' };
      if (get('SELECT id FROM domains WHERE name = ?', name)) return { error: 1, text: 'Domain already exists' };
      const r = run(`INSERT INTO domains(user_id, username, name, docroot, php_version, ssl, status, is_main, ip, created_at)
                     VALUES(?,?,?,?,?,?,?,?,?,?)`, user.id, user.username, name,
        `/home/${user.username}/domains/${name}/public_html`, '8.3', 1, 'active', 0, setting('server_ip', '127.0.0.1'), nowIso());
      createZone(r.lastInsertRowid, name);
      provisionDomain(user.username, name);
      apply({ web: true, dns: true });
      if (ctx.query.dns === 'no') run('DELETE FROM dns_records WHERE domain_id = ?', r.lastInsertRowid);
      return { error: 0, text: 'Domain created', domain: name };
    }
    if (action === 'delete') {
      const d = domainFor(user, ctx.query.domain || '');
      if (!d) return { error: 1, text: 'Domain not found' };
      run('DELETE FROM domains WHERE id = ?', d.id);
      run('DELETE FROM ssl_certs WHERE domain = ?', d.name);
      try { fs.rmSync(pathMod.join(config.dataDir, 'dns', `${d.name}.db`), { force: true }); } catch { /* ignore */ }
      apply({ web: true, dns: true });
      return { error: 0, text: 'Domain deleted' };
    }
    return { error: 0, text: 'Domains', list: userDomainsFor(user).map((d) => d.name) };
  };

  for (const name of Object.keys(commands)) {
    const handler = (ctx) => {
      ctx.apiCommand = name;
      ctx.apiPattern = `/${name}`;
      const user = authenticate(ctx);
      if (!user) {
        // DirectAdmin convention: HTTP 200 with error=1 for auth failures.
        return { status: 200, raw: legacyEncode({ error: 1, text: 'Invalid login credentials', details: '' }), type: 'form' };
      }
      const result = commands[name](user, ctx);
      if (ctx.query.json === 'yes' || String(ctx.req.headers.accept || '').includes('application/json')) {
        return { json: result, status: result.error ? 200 : 200 };
      }
      if (result.error) return { status: 200, raw: legacyEncode({ error: 1, text: result.text, details: '' }), type: 'form' };
      return { status: 200, raw: legacyEncode(result), type: 'form' };
    };
    router.get(`/CMD_API_${name.replace('CMD_API_', '')}`, handler);
    router.post(`/CMD_API_${name.replace('CMD_API_', '')}`, handler);
  }

  /* ------------------------------------------------ remaining command names */
  // Every CMD_API_* name published by the DirectAdmin frontend resolves here.
  // Read commands return live data; commands that need software the provider
  // does not have return the DA error envelope instead of a 404.
  const listOf = (sql, ...params) => all(sql, ...params).map((r) => Object.values(r)[0]);
  const processNames = () => ['node', 'nginx', 'httpd', 'mariadbd', 'exim', 'dovecot', 'named', 'proftpd'];
  const providerPerlModules = () => { try { const r = providerExtrasSync().perlModules(); return r.ok ? r.packages.map((p) => `${p.name} ${p.version}`) : []; } catch { return []; } };
  const READ = {
    CMD_API_SHOW_DOMAIN: (u) => userDomainsFor(u).map((d) => d.name),
    CMD_API_SHOW_USER: (u) => visibleUsers(u, { level: 'user' }).map((x) => x.username),
    CMD_API_SHOW_RESELLER: (u) => (u.level === 'admin' ? all("SELECT username FROM users WHERE level = 'reseller'").map((x) => x.username) : []),
    CMD_API_ALL_USER_SHOW: (u) => visibleUsers(u).map((x) => x.username),
    CMD_API_USER_SHOW: (u) => visibleUsers(u, { level: 'user' }).map((x) => x.username),
    CMD_API_RESELLER_SHOW: (u) => (u.level === 'admin' ? all("SELECT username FROM users WHERE level = 'reseller'").map((x) => x.username) : []),
    CMD_API_ADMIN_SHOW: (u) => (u.level === 'admin' ? all("SELECT username FROM users WHERE level = 'admin'").map((x) => x.username) : []),
    CMD_API_SHOW_USER_PACKAGES: () => all("SELECT name FROM packages WHERE type = 'user'").map((x) => x.name),
    CMD_API_SHOW_RESELLER_PACKAGES: () => all("SELECT name FROM packages WHERE type = 'reseller'").map((x) => x.name),
    CMD_API_MANAGE_USER_PACKAGES: () => all("SELECT name FROM packages WHERE type = 'user'").map((x) => x.name),
    CMD_API_MANAGE_RESELLER_PACKAGES: () => all("SELECT name FROM packages WHERE type = 'reseller'").map((x) => x.name),
    CMD_API_SHOW_SERVICES: (u) => (u.level === 'admin' ? all('SELECT name FROM services').map((x) => x.name) : []),
    CMD_API_SYSTEM_SERVICES: (u) => (u.level === 'admin' ? all('SELECT name FROM services').map((x) => x.name) : []),
    CMD_API_EMAIL_USAGE: (u) => scopedDomainJoin(u, "SELECT e.local_part || '@' || e.domain AS address",
      'FROM email_accounts e JOIN domains d ON d.id = e.domain_id', 'ORDER BY e.domain, e.local_part').map((x) => x.address),
    CMD_API_EMAIL_LIST: (u) => scopedDomainJoin(u, "SELECT l.name || '@' || l.domain AS address",
      'FROM mailing_lists l JOIN domains d ON d.id = l.domain_id', 'ORDER BY l.domain, l.name').map((x) => x.address),
    CMD_API_EMAIL_VACATION: (u) => scopedDomainJoin(u, 'SELECT v.email', 'FROM vacation v JOIN domains d ON d.name = v.domain', 'ORDER BY v.email').map((x) => x.email),
    CMD_API_EMAIL_AUTORESPONDER: (u) => scopedDomainJoin(u, 'SELECT a.email',
      'FROM autoresponders a JOIN domains d ON d.id = a.domain_id', 'ORDER BY a.email').map((x) => x.email),
    CMD_API_EMAIL_CATCH_ALL: (u) => scopedDomainJoin(u, 'SELECT c.domain',
      'FROM catchall c JOIN domains d ON d.id = c.domain_id', 'ORDER BY c.domain').map((x) => x.domain),
    CMD_API_EMAIL_FILTER: (u) => scopedDomainJoin(u, 'SELECT f.id',
      'FROM email_filters f JOIN domains d ON d.name = f.domain', 'ORDER BY f.id').map((x) => String(x.id)),
    CMD_API_SPAMASSASSIN: (u) => scopedDomainJoin(u, 'SELECT f.domain',
      'FROM email_filters f JOIN domains d ON d.name = f.domain', 'GROUP BY f.domain ORDER BY f.domain').map((x) => x.domain),
    CMD_API_SSL: (u) => (u.level === 'admin' ? all('SELECT domain FROM ssl_certs').map((x) => x.domain) : all('SELECT domain FROM ssl_certs WHERE username = ?', u.username).map((x) => x.domain)),
    CMD_API_DOMAIN_TLS: (u) => all('SELECT domain FROM ssl_certs WHERE username = ?', u.username).map((x) => x.domain),
    CMD_API_ADMIN_SSL: (u) => (u.level === 'admin' ? all('SELECT domain FROM ssl_certs').map((x) => x.domain) : []),
    CMD_API_SERVER_TLS: (u) => (u.level === 'admin' ? all("SELECT value FROM settings WHERE key = 'server_name'").map((x) => x.value) : []),
    CMD_API_DNS_ADMIN: (u) => userDomainsFor(u).map((x) => x.name),
    CMD_API_DNS_RESELLER: (u) => visibleDomains(u).map((x) => x.name),
    CMD_API_DNS_MX: (u) => scopedDomainJoin(u, 'SELECT r.value', 'FROM dns_records r JOIN domains d ON d.id = r.domain_id',
      "WHERE r.type = 'MX' ORDER BY r.value").map((x) => x.value),
    CMD_API_DB_SHOW: (u) => scopedDatabaseRows(u, 'db_name').map((x) => x.db_name),
    CMD_API_FTP_SHOW: (u) => scopedFtpRows(u).map((x) => x.username),
    CMD_API_LOG_VIEWER: (u) => (u.level === 'admin'
      ? all('SELECT actor || char(58) || action AS v FROM audit_log ORDER BY id DESC LIMIT 100')
      : all('SELECT actor || char(58) || action AS v FROM audit_log WHERE actor = ? ORDER BY id DESC LIMIT 100', u.username)).map((x) => Object.values(x)[0]),
    CMD_API_PLUGINS: () => all('SELECT name FROM plugins').map((x) => x.name),
    CMD_API_PLUGIN_MANAGER: () => all('SELECT name FROM plugins').map((x) => x.name),
    CMD_API_SKINS: () => ['evolution', 'enhanced'],
    CMD_API_IP_CONFIG: (u) => (u.level === 'admin' ? all('SELECT ip FROM ips').map((x) => x.ip) : []),
    CMD_API_PHP_SETTINGS: () => String(setting('php_versions', '8.4,8.3,8.2,8.1,7.4')).split(','),
    CMD_API_HANDLERS: (u) => (JSON.parse(setting(`user:${u.username}:handlers`, '[]')) || []).map((x) => `${x.key} ${x.value}`),
    CMD_API_MIME_TYPES: (u) => (JSON.parse(setting(`user:${u.username}:mime-types`, '[]')) || []).map((x) => `${x.key} ${x.value}`),
    CMD_API_PROTECTED_DIRECTORIES: (u) => { const v = JSON.parse(setting(`protected:${u.username}`, '[]')); return v.map((x) => x.domain + x.path); },
    CMD_API_HOTLINK: (u) => Object.keys(JSON.parse(setting(`hotlink:${u.username}`, '{}'))).filter((k) => !k.startsWith('_')),
    CMD_API_REDIRECT: (u) => all('SELECT from_path FROM redirects WHERE username = ?', u.username).map((x) => x.from_path),
    CMD_API_SUBDOMAIN: (u) => all('SELECT name FROM subdomains WHERE username = ?', u.username).map((x) => x.name),
    CMD_API_LOGIN_KEYS: (u) => all('SELECT key_id FROM login_keys WHERE user_id = ?', u.id).map((x) => x.key_id),
    CMD_API_SSH_KEYS: (u) => all('SELECT fingerprint FROM ssh_keys WHERE user_id = ?', u.id).map((x) => x.fingerprint),
    CMD_API_WORDPRESS: (u) => all('SELECT domain FROM wordpress WHERE domain IN (SELECT name FROM domains WHERE user_id = ?)', u.id).map((x) => x.domain),
    CMD_API_GIT: (u) => { const v = JSON.parse(setting(`git:${u.username}`, '[]')); return v.map((x) => x.name); },
    CMD_API_TICKET: (u) => all('SELECT id FROM tickets WHERE user_id = ?', u.id).map((x) => String(x.id)),
    CMD_API_MAIL_QUEUE: (u) => (u.level === 'admin' ? all('SELECT id FROM mail_queue').map((x) => String(x.id)) : []),
    CMD_API_IMAPSYNC: (u) => all('SELECT id FROM imap_jobs WHERE username = ?', u.username).map((x) => String(x.id)),
    CMD_API_MULTI_SERVER: (u) => { if (u.level !== 'admin') return []; const v = JSON.parse(setting('cluster_peers', '[]')); return v.map((x) => x.host); },
    CMD_API_MOD_SECURITY: (u) => (u.level === 'admin' ? Object.keys(JSON.parse(setting('waf_domains', '{}'))) : []),
    CMD_API_NGINX_TEMPLATES: (u) => (u.level === 'admin' ? ['default', 'wordpress', 'laravel', 'static-site', 'reverse-proxy'] : []),
    CMD_API_TEMPLATE_DIFF: (u) => (u.level === 'admin' ? ['header.html', 'footer.html', 'login.html'] : []),
    CMD_API_CUSTOMBUILD: (u) => (u.level === 'admin' ? ['nginx', 'apache2', 'php', 'node'] : []),
    CMD_API_RESOURCE_USAGE: (u) => all('SELECT day || char(61) || bandwidth_mb AS v FROM usage_daily WHERE username = ?', u.username).map((x) => Object.values(x)[0]),
    CMD_API_EMAIL_LOGS: (u) => (u.level === 'admin' ? all('SELECT id FROM mail_queue LIMIT 50').map((x) => String(x.id)) : []),
    CMD_API_EMAIL_LOGS_SUMMARY: (u) => (u.level === 'admin' ? all('SELECT status, COUNT(*) n FROM mail_queue GROUP BY status').map((x) => `${x.status}=${x.n}`) : []),

    CMD_API_ACCOUNT_ADMIN: (u) => (u.level === 'admin' ? all("SELECT username FROM users WHERE level = 'admin'").map((x) => x.username) : []),
    CMD_API_ACCOUNT_RESELLER: (u) => (u.level === 'admin' ? all("SELECT username FROM users WHERE level = 'reseller'").map((x) => x.username) : []),
    CMD_API_ADDITIONAL_DOMAINS: (u) => userDomainsFor(u).map((d) => d.name),
    CMD_API_ADMIN_BACKUP: (u) => scopedBackupRows(u).map((x) => x.filename),
    CMD_API_ADMIN_BACKUP_MODIFY: (u) => scopedBackupRows(u).map((x) => x.filename),
    CMD_API_ADMIN_CRON_JOBS: (u) => (u.level === 'admin' ? all('SELECT command FROM cron_jobs').map((x) => x.command) : []),
    CMD_API_ADMIN_FILE_EDITOR: (u) => (u.level === 'admin' ? JSON.parse(setting('admin_file_editor_files', '[]')) : []),
    CMD_API_ADMIN_HISTORY: (u) => (u.level === 'admin'
      ? all('SELECT actor || char(32) || action AS v FROM audit_log ORDER BY id DESC LIMIT 200')
      : all('SELECT actor || char(32) || action AS v FROM audit_log WHERE actor = ? ORDER BY id DESC LIMIT 200', u.username)).map((x) => Object.values(x)[0]),
    CMD_API_ADMIN_SETTINGS: (u) => (u.level === 'admin' ? all('SELECT key FROM settings').map((x) => x.key) : []),
    CMD_API_ADMIN_STATS: (u) => (u.level === 'admin'
      ? [String(get('SELECT COUNT(*) n FROM users').n), String(get('SELECT COUNT(*) n FROM domains').n)]
      : []),
    CMD_API_BANDWIDTH_BREAKDOWN: (u) => all('SELECT day || char(61) || bandwidth_mb AS v FROM usage_daily WHERE username = ?', u.username).map((x) => Object.values(x)[0]),
    CMD_API_BRUTE_FORCE_MONITOR: (u) => (u.level === 'admin'
      ? all('SELECT ip || char(61) || COUNT(*) AS v FROM login_attempts GROUP BY ip').map((x) => Object.values(x)[0]) : []),
    CMD_API_CUSTOM_HTTPD: (u) => (u.level === 'admin' ? all("SELECT key FROM settings WHERE key LIKE 'httpd:%'").map((x) => x.key.replace('httpd:', '')) : []),
    CMD_API_DB: (u) => scopedDatabaseRows(u, 'db_name').map((x) => x.db_name),
    CMD_API_DB_USER_CREATE: (u) => scopedDatabaseRows(u, 'db_user').map((x) => x.db_user),
    CMD_API_DB_USER_PRIVS: (u) => scopedDatabaseRows(u, 'db_user').map((x) => x.db_user),
    CMD_API_DB_VIEW: (u) => scopedDatabaseRows(u, 'db_name').map((x) => x.db_name),
    CMD_API_DOMAIN_POINTER: (u) => scopedDomainJoin(u, 'SELECT r.value', 'FROM dns_records r JOIN domains d ON d.id = r.domain_id',
      "WHERE r.type = 'POINTER' ORDER BY r.value").map((x) => x.value),
    CMD_API_DU_BREAKDOWN: (u) => all('SELECT day || char(61) || disk_mb AS v FROM usage_daily WHERE username = ?', u.username).map((x) => Object.values(x)[0]),
    CMD_API_EDIT_USER_MESSAGE: () => all('SELECT subject FROM messages').map((x) => x.subject),
    CMD_API_EMAIL_AUTORESPONDER_CREATE: () => [],
    CMD_API_EMAIL_AUTORESPONDER_MODIFY: (u) => scopedDomainJoin(u, 'SELECT a.email',
      'FROM autoresponders a JOIN domains d ON d.id = a.domain_id', 'ORDER BY a.email').map((x) => x.email),
    CMD_API_EMAIL_FORWARDER_MODIFY: (u) => scopedDomainJoin(u, "SELECT f.source || '@' || f.domain AS address",
      'FROM email_forwarders f JOIN domains d ON d.id = f.domain_id', 'ORDER BY f.domain, f.source').map((x) => x.address),
    CMD_API_EMAIL_POP: (u) => scopedDomainJoin(u, "SELECT e.local_part || '@' || e.domain AS address",
      'FROM email_accounts e JOIN domains d ON d.id = e.domain_id', 'ORDER BY e.domain, e.local_part').map((x) => x.address),
    CMD_API_EMAIL_VACATION_CREATE: () => [],
    CMD_API_EMAIL_VACATION_MODIFY: (u) => scopedDomainJoin(u, 'SELECT v.email',
      'FROM vacation v JOIN domains d ON d.name = v.domain', 'ORDER BY v.email').map((x) => x.email),
    CMD_API_FILE_MANAGER: (u) => { const home = `/home/${u.username}`; return [home]; },
    CMD_API_FTP_SETTINGS: (u) => [setting(`ftp_settings_${u.username}`, '{}')],
    CMD_API_IP_MANAGER_DETAILS: (u) => (u.level === 'admin' ? all('SELECT ip FROM ips').map((x) => x.ip) : []),
    CMD_API_JSON_VALIDATE: () => ['valid'],
    CMD_API_MODIFY_RESELLER: (u) => (u.level === 'admin' ? all("SELECT username FROM users WHERE level = 'reseller'").map((x) => x.username) : []),
    CMD_API_MOVE_USERS: (u) => visibleUsers(u, { level: 'user' }).map((x) => x.username),
    CMD_API_NAME_SERVER: () => [setting('ns1', ''), setting('ns2', '')],
    CMD_API_NETDATA_SOCK: (u) => (u.level === 'admin' ? [get("SELECT status FROM services WHERE name = 'netdata'")?.status || 'not installed'] : []),
    CMD_API_PERL_MODULES: () => providerPerlModules(),
    CMD_API_PHP_SAFE_MODE: () => String(setting('php_versions', '8.4,8.3,8.2,8.1,7.4')).split(','),
    CMD_API_PLUGINS_ADMIN: () => all("SELECT name FROM plugins WHERE level = 'admin'").map((x) => x.name),
    CMD_API_PLUGINS_RESELLER: () => all("SELECT name FROM plugins WHERE level = 'reseller'").map((x) => x.name),
    CMD_API_PROCESS_MONITOR: (u) => (u.level === 'admin' ? processNames() : []),
    CMD_API_REBOOT: () => ['reboot requires POST with confirm=yes'],
    CMD_API_REDIS: (u) => (u.level === 'admin' ? [get("SELECT status FROM services WHERE name = 'redis'")?.status || 'not installed'] : []),
    CMD_API_RESELLER_HISTORY: (u) => (u.level === 'admin'
      ? all("SELECT actor || char(32) || action AS v FROM audit_log WHERE level = 'reseller' ORDER BY id DESC LIMIT 100")
      : all('SELECT actor || char(32) || action AS v FROM audit_log WHERE actor = ? ORDER BY id DESC LIMIT 100', u.username)).map((x) => Object.values(x)[0]),
    CMD_API_RESELLER_STATS: (u) => all('SELECT day || char(61) || bandwidth_mb AS v FROM usage_daily WHERE username = ?', u.username).map((x) => Object.values(x)[0]),
    CMD_API_RSPAMD_SOCK: (u) => (u.level === 'admin' ? [get("SELECT status FROM services WHERE name = 'rspamd'")?.status || 'not installed'] : []),
    CMD_API_SHOW_LOG: (u) => (u.level === 'admin'
      ? all('SELECT action FROM audit_log ORDER BY id DESC LIMIT 100')
      : all('SELECT action FROM audit_log WHERE actor = ? ORDER BY id DESC LIMIT 100', u.username)).map((x) => x.action),
    CMD_API_SHOW_RESELLER_PACKAGE: () => all("SELECT name FROM packages WHERE type = 'reseller'").map((x) => x.name),
    CMD_API_SHOW_USER_PACKAGE: () => all("SELECT name FROM packages WHERE type = 'user'").map((x) => x.name),
    CMD_API_SUSPENSION_MESSAGE: () => [setting('suspension_message', 'Account suspended')],
    CMD_API_SYSTEM_BACKUP: (u) => scopedBackupRows(u).map((x) => x.filename),
    CMD_API_TICKET_CREATE: () => [],
    CMD_API_TICKET_MANAGE: (u) => {
      const ids = scopeUserIds(u);
      const rows = ids
        ? all(`SELECT id FROM tickets WHERE user_id IN (${placeholders(ids.length)}) ORDER BY id DESC`, ...ids)
        : all('SELECT id FROM tickets ORDER BY id DESC');
      return rows.map((x) => String(x.id));
    },
    CMD_API_UNIT: (u) => (u.level === 'admin' ? [get("SELECT status FROM services WHERE name = 'unit'")?.status || 'not installed'] : []),
    CMD_API_USER_BACKUP: (u) => scopedBackupRows(u).map((x) => x.filename),
    CMD_API_USER_BACKUP_MODIFY: (u) => scopedBackupRows(u).map((x) => x.filename),
    CMD_API_USER_HISTORY: (u) => all('SELECT action FROM audit_log WHERE actor = ? ORDER BY id DESC LIMIT 100', u.username).map((x) => x.action),
    CMD_API_USER_STATS: (u) => all('SELECT day || char(61) || bandwidth_mb AS v FROM usage_daily WHERE username = ?', u.username).map((x) => Object.values(x)[0]),
    CMD_API_VERSION: () => [VERSION],
  };
  for (const cmd of READ_KEYS()) {
    if (commands[cmd]) continue;
    const handler = (ctx) => {
      ctx.apiCommand = cmd;
      ctx.apiPattern = `/${cmd}`;
      const user = authenticate(ctx);
      if (!user) return { status: 200, raw: legacyEncode({ error: 1, text: 'Invalid login credentials', details: '' }), type: 'form' };
      try {
        const list = READ[cmd] ? READ[cmd](user, ctx) : null;
        if (!list) return { status: 200, raw: legacyEncode({ error: 1, text: `${cmd} is not available in this installation`, details: '' }), type: 'form' };
        if (Array.isArray(list) && list.length === 0 && /_(CREATE|MODIFY)$/.test(cmd)) {
          return { status: 200, raw: legacyEncode({ error: 1, text: 'Missing required parameters', details: '' }), type: 'form' };
        }
        return { status: 200, raw: legacyEncode({ error: 0, text: cmd.replace('CMD_API_', '').replace(/_/g, ' ').toLowerCase(), list }), type: 'form' };
      } catch (e) {
        return { status: 200, raw: legacyEncode({ error: 1, text: e.message, details: '' }), type: 'form' };
      }
    };
    router.get(`/${cmd}`, handler);
    router.post(`/${cmd}`, handler);
  }

  // Anything still unpublished (mutating commands that need an external
  // provider) gets the DirectAdmin error envelope rather than a 404.
  for (const cmd of READ_KEYS()) {
    if (commands[cmd]) continue;
    if (router.match('GET', `/${cmd}`)) continue;
    router.get(`/${cmd}`, (ctx) => {
      ctx.apiCommand = cmd;
      ctx.apiPattern = `/${cmd}`;
      const user = authenticate(ctx); if (!user) return { status: 200, raw: legacyEncode({ error: 1, text: 'Invalid login credentials', details: '' }), type: 'form' };
      return { status: 200, raw: legacyEncode({ error: 1, text: `${cmd} requires an external provider and is not implemented`, details: '' }), type: 'form' };
    });
  }
  void listOf; void READ;
}

function READ_KEYS() {
  const file = pathMod.join(ROOT, 'docs', 'directadmin-commands.txt');
  const names = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\s+/).filter((c) => c.startsWith('CMD_')) : [];
  return names.map((c) => c.replace('CMD_', 'CMD_API_'));
}

function publicUser(u) {
  return { id: u.id, username: u.username, email: u.email, level: u.level, owner: u.owner, package: u.package, domain: u.domain, suspended: !!u.suspended, created_at: u.created_at };
}

function unauthorized(ctx) {
  ctx.res.setHeader('WWW-Authenticate', 'Basic realm="OpenAdmin"');
  return { status: 401, json: { ok: false, error: 'Authentication required' } };
}
function forbidden(ctx) { return { status: 403, json: { ok: false, error: 'Permission denied' } }; }
function badRequest(ctx, message) { return { status: 400, json: { ok: false, error: message } }; }
function notFound(ctx, message) { return { status: 404, json: { ok: false, error: message } }; }

function openapiDoc() {
  return {
    openapi: '3.0.3',
    info: {
      title: 'OpenAdmin API', version: VERSION,
      description: 'Free, unlimited hosting control panel API. DirectAdmin-compatible CMD_API_* endpoints are also available at /CMD_API_*.',
      license: { name: 'AGPL-3.0', url: 'https://www.gnu.org/licenses/agpl-3.0.html' },
    },
    servers: [{ url: '/api/v1' }],
    security: [{ basicAuth: [] }],
    components: {
      securitySchemes: { basicAuth: { type: 'http', scheme: 'basic' } },
      schemas: {
        Domain: { type: 'object', properties: { name: { type: 'string' }, docroot: { type: 'string' }, php: { type: 'string' }, ssl: { type: 'boolean' } } },
        User: { type: 'object', properties: { username: { type: 'string' }, email: { type: 'string' }, level: { type: 'string' }, package: { type: 'string' } } },
      },
    },
    paths: {
      '/me': { get: { summary: 'Current account', responses: { 200: { description: 'Account and limits' } } } },
      '/domains': {
        get: { summary: 'List domains', responses: { 200: { description: 'Domain list' } } },
        post: { summary: 'Create a domain', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { domain: { type: 'string' } } } } } }, responses: { 200: { description: 'Created' } } },
      },
      '/domains/{name}': { delete: { summary: 'Delete a domain', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Deleted' } } } },
      '/email': {
        get: { summary: 'List mailboxes', responses: { 200: { description: 'Mailboxes' } } },
        post: { summary: 'Create a mailbox', responses: { 200: { description: 'Created' } } },
      },
      '/dns/{domain}': {
        get: { summary: 'List DNS records', responses: { 200: { description: 'Zone' } } },
        post: { summary: 'Add a DNS record', responses: { 200: { description: 'Added' } } },
      },
      '/databases': { get: { summary: 'List databases', responses: { 200: { description: 'Databases' } } } },
      '/users': {
        get: { summary: 'List users (reseller/admin)', responses: { 200: { description: 'Users' } } },
        post: { summary: 'Create a user (reseller/admin)', responses: { 200: { description: 'Created' } } },
      },
      '/packages': { get: { summary: 'List packages', responses: { 200: { description: 'Packages' } } } },
      '/stats': { get: { summary: 'Usage statistics', responses: { 200: { description: 'Daily usage' } } } },
      '/system': { get: { summary: 'System information', responses: { 200: { description: 'System' } } } },
      '/notifications': { get: { summary: 'Unread count and latest notifications', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } }, { name: 'cursor', in: 'query', schema: { type: 'integer' } }, { name: 'status', in: 'query', schema: { type: 'string', enum: ['all', 'unread', 'read'] } }, { name: 'level', in: 'query', schema: { type: 'string', enum: ['info', 'ok', 'warn', 'danger'] } }], responses: { 200: { description: 'Notification feed' } } } },
      '/notifications/stream': { get: { summary: 'Server-sent event stream (ready, notification, change, heartbeat)', responses: { 200: { description: 'text/event-stream' } } } },
      '/notifications/{id}/read': { post: { summary: 'Mark one notification as read (write scope)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Read' }, 404: { description: 'Not found' } } } },
      '/notifications/read-all': { post: { summary: 'Mark all visible notifications as read (write scope)', responses: { 200: { description: 'Read all' } } } },
      '/notifications/{id}': { delete: { summary: 'Delete one notification (write scope)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' } } } },
      '/files': { get: { summary: 'List a directory', responses: { 200: { description: 'Entries' } } } },
      '/webserver': { get: { summary: 'Web server stack and generated vhosts', responses: { 200: { description: 'Detection and config counts' } } } },
    },
  };
}

void jsonOk; void legacyError; void legacySend; void h; void formatBytes; void isEmail; void audit; void findUser;
