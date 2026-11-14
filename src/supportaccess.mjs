// Time-limited, read-only support access.
import crypto from 'node:crypto';
import { all, get, run, nowIso, audit } from './db.mjs';
import { createSession } from './auth.mjs';

function hash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

export function listSupport() {
  return all('SELECT * FROM support_access ORDER BY created_at DESC');
}

export function createSupport({ hours = 24, createdBy = 'admin', scope = 'read' } = {}) {
  const token = `oas_${crypto.randomBytes(24).toString('base64url')}`;
  const prefix = token.slice(0, 10);
  const expires = new Date(Date.now() + Math.min(24 * 30, Math.max(1, Number(hours || 24))) * 3600 * 1000).toISOString();
  run('INSERT INTO support_access(token_hash, prefix, created_by, scope, expires_at, created_at) VALUES(?,?,?,?,?,?)',
    hash(token), prefix, createdBy, scope, expires, nowIso());
  audit(createdBy, 'admin', 'support.access.create', prefix, '');
  return { ok: true, token, prefix, expires };
}

export function revokeSupport(id, actor = 'admin') {
  const row = get('SELECT * FROM support_access WHERE id = ?', Number(id));
  if (!row) return { ok: false, error: 'Not found' };
  run('UPDATE support_access SET revoked_at = ? WHERE id = ?', nowIso(), row.id);
  run('DELETE FROM sessions WHERE support_token = ?', row.prefix);
  audit(actor, 'admin', 'support.access.revoke', row.prefix, '');
  return { ok: true };
}

export function redeemSupport(token, { ip = '', ua = '' } = {}) {
  if (!String(token).startsWith('oas_')) return { ok: false, error: 'Invalid token' };
  const row = get('SELECT * FROM support_access WHERE token_hash = ?', hash(String(token)));
  if (!row) return { ok: false, error: 'Token nie istnieje' };
  if (row.revoked_at) return { ok: false, error: 'Token unieważniony' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, error: 'Token wygasł' };
  const admin = get("SELECT * FROM users WHERE username = ? AND level = 'admin'", row.created_by) || get("SELECT * FROM users WHERE level = 'admin' ORDER BY id LIMIT 1");
  if (!admin) return { ok: false, error: 'Brak konta administratora' };
  const ttl = Math.max(1, Math.ceil((new Date(row.expires_at).getTime() - Date.now()) / 3600000));
  const s = createSession(admin, { ip, ua, support: true, supportToken: row.prefix, ttlHours: Math.min(12, ttl) });
  run('UPDATE support_access SET last_used_at = ? WHERE id = ?', nowIso(), row.id);
  audit('support:' + row.prefix, 'admin', 'support.access.redeem', ip, '');
  return { ok: true, session: s };
}
