// Authentication, sessions, CSRF and capability resolution.
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { get, run, all, nowIso, setting, verifyPassword } from './db.mjs';
import { safeJson, LEVELS } from './util.mjs';
import { impersonationForSession } from './secrets.mjs';

const COOKIE = 'OA_SESSION';
const SESSION_TOUCH_MS = 30000;

/** Session cookies are opaque to the browser; only their SHA-256 hash is stored. */
export function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token ?? '')).digest('hex');
}

function sessionIdleMs() {
  const minutes = Number.parseInt(process.env.OA_SESSION_IDLE_MINUTES ?? '', 10);
  const bounded = Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 10080) : 120;
  return bounded * 60000;
}

export function findUser(username) {
  return get('SELECT * FROM users WHERE lower(username) = lower(?)', String(username || '').trim());
}

export function userById(id) {
  return get('SELECT * FROM users WHERE id = ?', id);
}

export function isSuspended(user) {
  return !!user?.suspended;
}

export function rateLimited(username, ip) {
  const since = new Date(Date.now() - config.limits.loginWindowMinutes * 60000).toISOString();
  const row = get(
    `SELECT COUNT(*) AS n FROM login_attempts WHERE created_at > ? AND (ip = ? OR lower(username) = lower(?))`,
    since, ip, username,
  );
  return (row?.n || 0) >= config.limits.maxLoginAttempts;
}

export function recordFailure(username, ip) {
  run('INSERT INTO login_attempts(username, ip, created_at) VALUES(?,?,?)', username, ip, nowIso());
}

export function clearFailures(username, ip) {
  run('DELETE FROM login_attempts WHERE lower(username) = lower(?) OR ip = ?', username, ip);
}

export function login(username, password, { ip = '', ua = '' } = {}) {
  if (rateLimited(username, ip)) {
    return { ok: false, error: 'Too many failed attempts. Try again in a few minutes.' };
  }
  const user = findUser(username);
  if (!user || !verifyPassword(password, user.password)) {
    recordFailure(username, ip);
    return { ok: false, error: 'Invalid username or password.' };
  }
  if (isSuspended(user)) {
    return { ok: false, error: 'This account is suspended. Contact your reseller or administrator.' };
  }
  clearFailures(username, ip);
  run('UPDATE users SET last_login = ?, last_ip = ?, login_count = login_count + 1 WHERE id = ?', nowIso(), ip, user.id);
  return { ok: true, user: { ...user, last_login: nowIso() } };
}

export function createSession(user, { ip = '', ua = '', support = false, supportToken = null, ttlHours = null } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(24).toString('hex');
  const hours = Math.min(config.sessionTtlHours, Math.max(1, Number(ttlHours || config.sessionTtlHours)));
  const now = nowIso();
  const expires = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  const tokenHash = hashSessionToken(token);
  // The token column is an opaque storage key (= hash). The raw cookie value is
  // returned to the caller but is never persisted.
  run('INSERT INTO sessions(token, user_id, csrf, ip, ua, created_at, expires_at, support, support_token, token_hash, last_seen) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    tokenHash, user.id, csrf, ip, String(ua).slice(0, 250), now, expires, support ? 1 : 0, supportToken, tokenHash, now);
  return { token, csrf, expires };
}

function deleteSessionRow(session) {
  if (!session) return;
  run('DELETE FROM sessions WHERE token = ? OR token_hash = ?', session.token, session.token_hash || session.token);
}

export function getSession(token) {
  if (!token) return null;
  const raw = String(token);
  const tokenHash = hashSessionToken(raw);
  let s = get('SELECT * FROM sessions WHERE token_hash = ?', tokenHash);
  if (!s) {
    // Compatibility path for pre-migration rows only. A stored hash must never
    // be accepted as a bearer cookie: that would make a database dump usable.
    s = get('SELECT * FROM sessions WHERE token = ? AND token_hash IS NULL', raw);
    if (s) {
      run('UPDATE sessions SET token = ?, token_hash = ?, last_seen = COALESCE(last_seen, created_at) WHERE token = ?',
        tokenHash, tokenHash, s.token);
      s = { ...s, token: tokenHash, token_hash: tokenHash };
    }
  }
  if (!s) return null;
  const now = Date.now();
  if (!Number.isFinite(Date.parse(s.expires_at)) || new Date(s.expires_at).getTime() < now) {
    deleteSessionRow(s);
    return null;
  }
  const lastSeen = Date.parse(s.last_seen || s.created_at);
  if (!Number.isFinite(lastSeen) || now - lastSeen > sessionIdleMs()) {
    deleteSessionRow(s);
    return null;
  }
  if (now - lastSeen > SESSION_TOUCH_MS) {
    run('UPDATE sessions SET last_seen = ? WHERE token_hash = ?', nowIso(), s.token_hash || tokenHash);
    s.last_seen = nowIso();
  }
  let user = userById(s.user_id);
  if (!user || isSuspended(user)) {
    deleteSessionRow(s);
    return null;
  }
  // A preview session carries explicit actor/subject state. Stale preview rows
  // invalidate the session instead of silently downgrading to a normal login.
  let impersonation = null;
  try {
    impersonation = impersonationForSession(raw);
    if (!impersonation) {
      const stale = get('SELECT expires_at FROM impersonations WHERE session_hash = ?', tokenHash);
      if (stale) {
        run('DELETE FROM impersonations WHERE session_hash = ?', tokenHash);
        deleteSessionRow(s);
        return null;
      }
    }
  } catch { /* impersonations table not created yet */ }
  if (impersonation) {
    user = { ...user, impersonation };
    s = { ...s, impersonation, read_only: impersonation.readOnly };
  }
  return { session: s, user, support: s.support === 1, impersonation };
}

export function destroySession(token) {
  if (!token) return;
  const raw = String(token);
  const tokenHash = hashSessionToken(raw);
  // Stored hashes are not valid credentials: the raw fallback applies only to
  // pre-migration rows that never received a token_hash.
  run('DELETE FROM sessions WHERE token_hash = ? OR (token = ? AND token_hash IS NULL)', tokenHash, raw);
}

export function destroyUserSessions(userId) {
  run('DELETE FROM sessions WHERE user_id = ?', userId);
}


/** Rotate a panel session after a privilege-sensitive change. */
export function rotateSession(rawToken, { ip = '', ua = '' } = {}) {
  const found = getSession(rawToken);
  if (!found) return null;
  // Never rotate a preview: the actor cookie points to the original session.
  if (found.impersonation) return { token: rawToken, csrf: found.session.csrf, expires: found.session.expires_at, unchanged: true };
  const created = createSession(found.user, {
    ip: ip || found.session.ip || '', ua: ua || found.session.ua || '',
    support: found.session.support === 1, supportToken: found.session.support_token || null,
  });
  destroySession(rawToken);
  return created;
}

export function reissueSession(ctx) {
  const rotated = rotateSession(ctx.cookies?.[COOKIE], { ip: ctx.ip, ua: ctx.req?.headers?.['user-agent'] || '' });
  if (rotated && !rotated.unchanged) {
    ctx.res.setHeader('Set-Cookie', serializeCookie(rotated.token, { secure: config.https }));
    ctx.session = { ...(ctx.session || {}), csrf: rotated.csrf };
  }
  return rotated;
}

export function cookieName() { return COOKIE; }

export function serializeCookie(token, { secure = config.https, maxAge = config.sessionTtlHours * 3600 } = {}) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** CSRF token check for state changing requests. */
export function checkCsrf(session, provided, { api = false } = {}) {
  if (api) return true; // API calls authenticate per-request
  if (!session?.csrf || !provided) return false;
  const a = Buffer.from(String(session.csrf));
  const b = Buffer.from(String(provided));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Package limits for a user (admin/reseller get permissive defaults). */
export function limitsFor(user) {
  if (user.level === 'admin') {
    return { domains: 0, subdomains: 0, emails: 0, ftp: 0, databases: 0, bandwidth_mb: 0, disk_mb: 0, cron: 0, ssl: 0, users: 0, ips: 0, packages: 0, php: ['8.4', '8.3', '8.2', '8.1'], dns_control: 1, ssh: 1, wordpress: 1, inodes: 0, email_quota_mb: 0, max_processes: 0, cpu_percent: 0, memory_mb: 0, io_read_mbps: 0, io_write_mbps: 0 };
  }
  const pkg = user.package ? get('SELECT * FROM packages WHERE name = ?', user.package) : null;
  const defaults = user.level === 'reseller'
    ? { users: 50, domains: 500, emails: 1000, ftp: 100, databases: 200, bandwidth_mb: 0, disk_mb: 0, cron: 20, ssl: 100, ips: 2, packages: 20, php: ['8.3', '8.2', '8.1'], dns_control: 1, wordpress: 1, max_processes: 200, cpu_percent: 0, memory_mb: 0 }
    : { domains: 10, subdomains: 25, emails: 50, ftp: 10, databases: 10, bandwidth_mb: 102400, disk_mb: 10240, cron: 5, ssl: 10, php: ['8.3'], dns_control: 0, wordpress: 1, max_processes: 100, cpu_percent: 0, memory_mb: 0 };
  const merged = { ...defaults, ...(pkg ? safeJson(pkg.limits, {}) : {}) };
  if (user.level === 'reseller' && user.reseller_plan) {
    const rp = get('SELECT * FROM reseller_plans WHERE name = ?', user.reseller_plan);
    if (rp) Object.assign(merged, safeJson(rp.limits, {}));
  }
  try {
    const disabled = JSON.parse(setting('disabled_features', '[]') || '[]');
    if (Array.isArray(disabled)) for (const key of disabled) merged[key] = 0;
  } catch { /* ignore */ }
  return merged;
}

export function capabilities(user) {
  const l = limitsFor(user);
  let acl = {};
  try { acl = JSON.parse(setting('panel_acl', '{}') || '{}'); } catch { acl = {}; }
  const on = (v) => Number(v) !== 0;
  const cap = {
    domains: on(l.domains),
    subdomains: on(l.subdomains),
    emails: on(l.emails),
    emailResponders: on(l.emails),
    mailingLists: on(l.mailing_lists ?? 1),
    ftp: on(l.ftp),
    databases: on(l.databases),
    ssl: on(l.ssl),
    cron: on(l.cron),
    ssh: Number(l.ssh) === 1,
    dns: Number(l.dns_control) === 1,
    wordpress: Number(l.wordpress) === 1,
    nodejs: Number(l.nodejs) === 1,
    python: Number(l.python) === 1,
    sysInfo: true,
    aftp: user.level !== 'user' || Number(l.ftp) > 0,
    git: Number(l.git ?? 0) === 1,
    loginKeys: true,
    spam: Number(l.spam ?? 1) === 1,
    catchAll: Number(l.catch_all ?? 1) === 1,
    cgi: Number(l.cgi ?? 0) === 1,
    php: l.php || ['8.3'],
    phone: true,
  };
  if (acl.disable_domains) cap.domains = false;
  if (acl.disable_emails) cap.emails = false;
  if (acl.disable_ssh) { cap.ssh = false; }
  if (acl.disable_system_apps) { cap.nodejs = false; cap.python = false; }
  return cap;
}

export function requireLevel(user, level) {
  return (LEVELS[user?.level] || 0) >= (LEVELS[level] || 0);
}

/** DirectAdmin API authentication uses HTTP Basic credentials. */
export function basicAuth(header) {
  if (!header || !header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx === -1) return null;
  return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
}

export function apiLogin(username, password, ip = '') {
  const user = findUser(username);
  if (!user || !verifyPassword(password, user.password)) {
    recordFailure(username, ip);
    return null;
  }
  if (isSuspended(user)) return null;
  if (!user.api_enabled) return null;
  clearFailures(username, ip);
  return user;
}

export function activeSessions(userId) {
  const idleSince = new Date(Date.now() - sessionIdleMs()).toISOString();
  return all('SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? AND (last_seen IS NULL OR last_seen > ?) ORDER BY created_at DESC',
    userId, nowIso(), idleSince);
}

export function serverName() {
  return setting('server_name', config.defaults.serverName);
}
