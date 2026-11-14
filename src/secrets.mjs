// Reversible encryption for database credentials and the one-time phpMyAdmin
// sign-on nonce store.
//
// SSO design (SEC-011 / OA-003):
//   - the panel issues a random nonce when a user clicks "Open phpMyAdmin";
//   - only the SHA-256 hash of that nonce is stored at rest;
//   - the nonce is valid for a few seconds, bound to the panel user, the
//     database name and the panel session that requested it;
//   - the phpMyAdmin sign-on helper exchanges it exactly once through the
//     loopback credentials endpoint; consumption is an atomic conditional
//     UPDATE, so a token cannot be replayed even under a race;
//   - the browser never sees the nonce in a URL: it is carried by an
//     HttpOnly, path-scoped cookie that is deleted after the exchange.
import crypto from 'node:crypto';
import { panelSecret } from './config.mjs';
import { get, run, nowIso, audit } from './db.mjs';
import { createSession, destroySession, hashSessionToken, userById, isSuspended } from './auth.mjs';

function key() {
  return crypto.createHash('sha256').update(panelSecret()).digest();
}

export function encryptSecret(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

export function decryptSecret(payload) {
  if (!payload) return null;
  try {
    const [ivB, tagB, ctB] = String(payload).split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}


/** Versioned TOTP secret storage. Legacy plaintext is accepted only for migration. */
export function sealTotp(secret) {
  return `v1:${encryptSecret(String(secret || ''))}`;
}
export function openTotp(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (raw.startsWith('v1:')) return decryptSecret(raw.slice(3)) || '';
  return raw; // legacy plaintext; re-seal on next successful verification
}

/* ---------------------------- SSO nonce store ---------------------------- */

export const SSO_TTL_SECONDS = 60;
const SSO_MAX_TTL_SECONDS = 120;
const SSO_TABLE = 'app_sso_tokens';

let ssoTableReady = false;
function ensureSsoTable() {
  if (ssoTableReady) return;
  run(`CREATE TABLE IF NOT EXISTS ${SSO_TABLE} (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    db_name TEXT NOT NULL,
    session_hash TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
  )`);
  ssoTableReady = true;
}

export function ssoTokenHash(token) {
  return crypto.createHash('sha256').update(String(token ?? '')).digest('hex');
}

/** Short, human-readable reasons so the panel can render a recoverable error. */
export const SSO_ERRORS = {
  missing: 'Link jednokrotnego logowania wygasł lub został już użyty. Otwórz phpMyAdmin ponownie.',
  invalid: 'Ten link logowania jest nieprawidłowy. Otwórz phpMyAdmin ponownie z listy baz danych.',
  expired: 'Link logowania wygasł (ważny 60 sekund). Kliknij „Spróbuj ponownie”.',
  reused: 'Ten link logowania został już użyty. Ze względów bezpieczeństwa nie można go powtórzyć.',
  session_required: 'Brak aktywnej sesji panelu. Zaloguj się ponownie i spróbuj jeszcze raz.',
  session_mismatch: 'Link należy do innej sesji panelu. Otwórz phpMyAdmin ponownie z tej sesji.',
  db_missing: 'Baza danych nie istnieje lub nie należy do tego konta.',
  no_credential: 'Dla tej bazy nie ma zapisanego hasła, więc nie można zalogować się automatycznie. Ustaw nowe hasło bazy i spróbuj ponownie.',
  sso_disabled: 'Jednokrotne logowanie do phpMyAdmin nie jest skonfigurowane. Administrator może je włączyć w Admin → Web Apps.',
  unavailable: 'phpMyAdmin nie jest zainstalowany albo nie odpowiada. Sprawdź stan aplikacji w Admin → Web Apps.',
  read_only: 'Podgląd konta jest tylko do odczytu — phpMyAdmin i zapis do bazy są zablokowane. Zakończ podgląd, aby otworzyć bazę.',
  service: 'Integracja phpMyAdmin nie może potwierdzić swojej tożsamości. Skonfiguruj ponownie jednokrotne logowanie.',
};

export function ssoErrorMessage(code) {
  return SSO_ERRORS[String(code || '')] || SSO_ERRORS.invalid;
}

/**
 * Create a one-time nonce. `sessionToken` binds it to the browser session that
 * requested the hand-off (the raw token is never stored, only its hash).
 * Returns the raw nonce; callers must not put it in a URL.
 */
export function ssoToken({ userId, db, sessionToken = '', ttlSeconds = SSO_TTL_SECONDS }) {
  ensureSsoTable();
  const ttl = Math.min(SSO_MAX_TTL_SECONDS, Math.max(1, Math.trunc(Number(ttlSeconds) || SSO_TTL_SECONDS)));
  const raw = crypto.randomBytes(32).toString('base64url');
  const created = nowIso();
  const expires = new Date(Date.now() + ttl * 1000).toISOString();
  // Opportunistic retention: nonces live for seconds, so a day of history is
  // plenty for diagnostics and never grows without bound.
  run(`DELETE FROM ${SSO_TABLE} WHERE created_at < ?`, new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  run(`INSERT INTO ${SSO_TABLE}(token_hash, user_id, db_name, session_hash, created_at, expires_at)
       VALUES(?,?,?,?,?,?)`,
  ssoTokenHash(raw), Number(userId), String(db), sessionToken ? ssoTokenHash(sessionToken) : '', created, expires);
  return raw;
}

function lookupNonce(raw) {
  ensureSsoTable();
  return get(`SELECT * FROM ${SSO_TABLE} WHERE token_hash = ?`, ssoTokenHash(raw));
}

function sameHash(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

/**
 * Validate and consume a nonce atomically. Returns credentials only after the
 * conditional UPDATE succeeded, so concurrent requests cannot both win.
 */
export function consumeSsoToken(rawToken, { sessionToken = null } = {}) {
  const raw = String(rawToken || '');
  if (!raw) return { ok: false, code: 'missing', error: ssoErrorMessage('missing') };
  const row = lookupNonce(raw);
  if (!row) return { ok: false, code: 'invalid', error: ssoErrorMessage('invalid') };
  if (row.consumed_at) return { ok: false, code: 'reused', error: ssoErrorMessage('reused') };
  const now = Date.now();
  if (!Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= now) {
    run(`UPDATE ${SSO_TABLE} SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL`, nowIso(), row.token_hash);
    return { ok: false, code: 'expired', error: ssoErrorMessage('expired') };
  }
  if (row.session_hash) {
    if (!sessionToken) return { ok: false, code: 'session_required', error: ssoErrorMessage('session_required') };
    if (!sameHash(row.session_hash, ssoTokenHash(sessionToken))) {
      return { ok: false, code: 'session_mismatch', error: ssoErrorMessage('session_mismatch') };
    }
  }
  const consumedAt = nowIso();
  let query = `UPDATE ${SSO_TABLE} SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`;
  const params = [consumedAt, row.token_hash, consumedAt];
  if (row.session_hash) { query += ' AND session_hash = ?'; params.push(row.session_hash); }
  const result = run(query, ...params);
  if (result.changes !== 1) {
    const after = lookupNonce(raw);
    const code = after?.consumed_at ? 'reused' : 'expired';
    return { ok: false, code, error: ssoErrorMessage(code) };
  }

  const database = get('SELECT * FROM databases WHERE db_name = ? AND user_id = ?', row.db_name, row.user_id);
  if (!database) return { ok: false, code: 'db_missing', error: ssoErrorMessage('db_missing') };
  const password = decryptSecret(database.password_enc);
  if (!password) return { ok: false, code: 'no_credential', error: ssoErrorMessage('no_credential') };
  return {
    ok: true,
    userId: row.user_id,
    db: database.db_name,
    username: database.db_user,
    password,
    consumedAt,
  };
}

/**
 * Legacy HMAC token verification kept for module compatibility with older
 * call sites. New sign-on flows must use consumeSsoToken(): a token that is
 * only verified (not consumed) is replayable by design.
 */
export function verifySsoToken(token) {
  try {
    const [body, sig] = String(token).split('.');
    if (!body || !sig) return null;
    const expected = crypto.createHmac('sha256', key()).update(body).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

/* --------------------------- impersonation store --------------------------- */
// An administrator (or reseller) may open one customer account in an explicit
// preview session. The state lives server-side and is bound to exactly one
// session token. The view is read-only by default (the subject session carries
// the existing `support` flag, which server.mjs already treats as GET-only).
// The actor's raw session token is never persisted here: the browser keeps it
// in a short-lived HttpOnly preview-actor cookie so the panel can restore it.
//
// NOTE: this table belongs in db.mjs next to the other schema; it is created
// lazily so this module can ship without editing db.mjs (see delivery report).

let impersonationTableReady = false;
function ensureImpersonationTable() {
  if (impersonationTableReady) return;
  run(`CREATE TABLE IF NOT EXISTS impersonations (
    session_hash TEXT PRIMARY KEY,
    actor_id INTEGER NOT NULL,
    actor_username TEXT NOT NULL,
    actor_level TEXT NOT NULL,
    subject_id INTEGER NOT NULL,
    subject_username TEXT NOT NULL,
    subject_level TEXT NOT NULL,
    read_only INTEGER NOT NULL DEFAULT 1,
    started_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`);
  impersonationTableReady = true;
}

function impersonationRecord(rawToken) {
  if (!rawToken) return { row: null, expired: false };
  ensureImpersonationTable();
  const row = get('SELECT * FROM impersonations WHERE session_hash = ?', hashSessionToken(rawToken));
  if (!row) return { row: null, expired: false };
  if (!Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) < Date.now()) {
    return { row, expired: true };
  }
  return { row, expired: false };
}

function impersonationView(row) {
  return {
    actor: row.actor_username,
    actorId: row.actor_id,
    actorLevel: row.actor_level,
    subject: row.subject_username,
    subjectId: row.subject_id,
    subjectLevel: row.subject_level,
    startedAt: row.started_at,
    readOnly: row.read_only === 1,
  };
}

/** Current preview view for a panel session token, or null. Never guesses. */
export function impersonationForSession(rawToken) {
  const state = impersonationRecord(rawToken);
  return state.row && !state.expired ? impersonationView(state.row) : null;
}

/**
 * Open an explicit preview session for one subject account.
 * Returns { ok:false, code:'subject_required' } instead of silently falling
 * back to "the first client" when no subject id is supplied.
 */
export function startImpersonation(actor, subjectId, {
  ip = '', ua = '', actorSessionToken = '', readOnly = true, ttlHours = 2,
} = {}) {
  ensureImpersonationTable();
  if (!actor || !['admin', 'reseller'].includes(actor.level)) {
    return { ok: false, code: 'forbidden', error: 'Only administrators and resellers can preview an account.' };
  }
  const sid = Number(subjectId);
  if (!Number.isInteger(sid) || sid <= 0) {
    return { ok: false, code: 'subject_required', error: 'Wybierz konto, które chcesz podejrzeć.' };
  }
  const subject = userById(sid);
  if (!subject) return { ok: false, code: 'subject_required', error: 'Konto nie istnieje.' };
  if (subject.id === actor.id) return { ok: false, code: 'self', error: 'Nie możesz podejrzeć własnego konta.' };
  if (subject.level === 'admin') return { ok: false, code: 'admin_target', error: 'Konto administratora nie może być podglądane.' };
  if (isSuspended(subject)) return { ok: false, code: 'suspended', error: 'Konto jest zawieszone.' };
  if (actor.level === 'reseller' && subject.owner !== actor.username) {
    return { ok: false, code: 'forbidden', error: 'Możesz podejrzeć tylko konto swojego klienta.' };
  }
  if (actorSessionToken) {
    const actorRow = get('SELECT * FROM sessions WHERE token_hash = ?', hashSessionToken(actorSessionToken));
    if (!actorRow || Number(actorRow.user_id) !== Number(actor.id)) {
      return { ok: false, code: 'actor_session', error: 'Sesja administratora wygasła. Zaloguj się ponownie.' };
    }
  }
  const hours = Math.min(12, Math.max(1, Number(ttlHours) || 2));
  const session = createSession(subject, { ip, ua, support: readOnly, ttlHours: hours });
  const startedAt = nowIso();
  run(`INSERT INTO impersonations(session_hash, actor_id, actor_username, actor_level,
        subject_id, subject_username, subject_level, read_only, started_at, expires_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
  hashSessionToken(session.token), actor.id, actor.username, actor.level,
  subject.id, subject.username, subject.level, readOnly ? 1 : 0, startedAt, session.expires);
  audit(actor.username, actor.level, 'user.impersonate.start',
    `${subject.username}${readOnly ? ' (read-only)' : ''}`, ip);
  const view = {
    actor: actor.username, actorId: actor.id, actorLevel: actor.level,
    subject: subject.username, subjectId: subject.id, subjectLevel: subject.level,
    startedAt, readOnly: !!readOnly,
  };
  return { ok: true, token: session.token, csrf: session.csrf, expires: session.expires, subject, view, readOnly: !!readOnly };
}


/** Deliberate escalation from read-only preview to write mode. */
export function enableImpersonationWrite(rawToken, { ip = '' } = {}) {
  const state = impersonationRecord(rawToken);
  if (!state.row) return { ok: false, code: 'not_impersonating', error: 'Nie jesteś w trybie podglądu.' };
  const row = state.row;
  const changed = run('UPDATE impersonations SET read_only = 0 WHERE session_hash = ? AND read_only = 1', row.session_hash);
  if (!changed.changes) return { ok: true, already: true, subject: row.subject_username };
  run('UPDATE sessions SET support = 0 WHERE token_hash = ?', row.session_hash);
  audit(row.actor_username, row.actor_level, 'user.impersonate.write', row.subject_username, ip);
  return { ok: true, subject: row.subject_username, actor: row.actor_username };
}

/**
 * End a preview session. The subject session is destroyed; the actor's original
 * session (kept in the browser's OA_PREVIEW_ACTOR cookie) is untouched.
 */
export function stopImpersonation(rawToken, { ip = '' } = {}) {
  if (!rawToken) return { ok: false, code: 'not_impersonating' };
  const state = impersonationRecord(rawToken);
  if (!state.row) return { ok: false, code: 'not_impersonating' };
  const row = state.row;
  run('DELETE FROM impersonations WHERE session_hash = ?', row.session_hash);
  destroySession(rawToken);
  audit(row.actor_username, row.actor_level, 'user.impersonate.stop', row.subject_username, ip);
  return {
    ok: true,
    actor: row.actor_username,
    actorId: row.actor_id,
    actorLevel: row.actor_level,
    subject: row.subject_username,
    subjectId: row.subject_id,
  };
}

/** Validate the administrator session kept in the preview-actor cookie. */
export function resolvePreviewActor(rawToken, actorId) {
  if (!rawToken) return null;
  const row = get('SELECT * FROM sessions WHERE token_hash = ?', hashSessionToken(rawToken));
  if (!row || Number(row.user_id) !== Number(actorId)) return null;
  if (!Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= Date.now()) return null;
  const idleMinutes = Number.parseInt(process.env.OA_SESSION_IDLE_MINUTES ?? '', 10);
  const idleMs = (Number.isFinite(idleMinutes) && idleMinutes > 0 ? Math.min(idleMinutes, 10080) : 120) * 60000;
  const lastSeen = Date.parse(row.last_seen || row.created_at);
  if (!Number.isFinite(lastSeen) || Date.now() - lastSeen > idleMs) return null;
  const user = userById(row.user_id);
  if (!user || isSuspended(user)) return null;
  return { token: rawToken, user, session: row };
}

/** Housekeeping for abandoned preview sessions. */
export function sweepImpersonations() {
  ensureImpersonationTable();
  run('DELETE FROM impersonations WHERE expires_at < ?', new Date(Date.now() - 24 * 3600 * 1000).toISOString());
}
