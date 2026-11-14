// Scoped API keys for the REST/CMD API and the MCP endpoint.
import crypto from 'node:crypto';
import { all, get, run, nowIso, verifyPassword } from './db.mjs';
import { encryptSecret, decryptSecret } from './secrets.mjs';

export function listKeys(userId = null) {
  return userId
    ? all('SELECT * FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC', userId)
    : all('SELECT k.*, u.username FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.revoked_at IS NULL ORDER BY k.created_at DESC');
}

export function createKey(userId, { name, scopes = ['read'], allowedIps = [] } = {}, actor = 'admin') {
  const user = get('SELECT * FROM users WHERE id = ?', Number(userId));
  if (!user) return { ok: false, error: 'User not found' };
  const secret = `oa_${crypto.randomBytes(28).toString('base64url')}`;
  const prefix = secret.slice(0, 10);
  const hash = crypto.createHash('sha256').update(secret).digest('hex');
  const allowed = Array.isArray(allowedIps) ? allowedIps : String(allowedIps || '').split(/[\s,]+/).filter(Boolean);
  const r = run('INSERT INTO api_keys(user_id, name, prefix, key_hash, scopes, allowed_ips, created_at) VALUES(?,?,?,?,?,?,?)',
    user.id, String(name || 'API key').slice(0, 80), prefix, hash, JSON.stringify(scopes), JSON.stringify(allowed), nowIso());
  run('INSERT INTO audit_log(actor, level, action, target, ip, created_at) VALUES(?,?,?,?,?,?)', actor, 'admin', 'api.key.create', `${user.username}:${prefix}`, '', nowIso());
  return { ok: true, id: r.lastInsertRowid, secret, prefix };
}

export function revokeKey(id, actor = 'admin') {
  run('UPDATE api_keys SET revoked_at = ? WHERE id = ?', nowIso(), Number(id));
  run('INSERT INTO audit_log(actor, level, action, target, ip, created_at) VALUES(?,?,?,?,?,?)', actor, 'admin', 'api.key.revoke', String(id), '', nowIso());
  return { ok: true };
}

export function keyFromRequest(headers, ip = '', method = 'GET') {
  const raw = String(headers['x-api-key'] || '').trim() || (() => {
    const a = String(headers.authorization || '');
    return a.toLowerCase().startsWith('bearer oa_') ? a.slice(7).trim() : '';
  })();
  if (!raw.startsWith('oa_')) return null;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const row = get('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL', hash);
  if (!row) return null;
  let allowed = [];
  try { allowed = JSON.parse(row.allowed_ips || '[]'); } catch { allowed = []; }
  if (allowed.length && !allowed.includes(ip)) return null;
  const scopes = (() => { try { return JSON.parse(row.scopes || '[]'); } catch { return []; } })();
  if (method !== 'GET' && !scopes.includes('write') && !scopes.includes('admin')) return null;
  const user = get('SELECT * FROM users WHERE id = ?', row.user_id);
  if (!user || user.suspended) return null;
  run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', nowIso(), row.id);
  user.api_scopes = scopes;
  user.api_key_id = row.id;
  return user;
}
