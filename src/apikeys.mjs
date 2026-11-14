// Scoped API keys for the REST/CMD API and the MCP endpoint.
import crypto from 'node:crypto';
import { all, get, run, nowIso } from './db.mjs';

const MAX_ALLOWED_IPS = 50;

/* --------------------------------------------------------- IP / CIDR ---------
 * API key IP allowlists historically used `allowed.includes(ip)`, so a CIDR
 * such as 198.51.100.0/24 never matched.  The helpers below implement a real
 * IPv4/IPv6 parser, CIDR matching and validation shared by the API, the MCP
 * endpoint and the trusted-proxy logic in server.mjs.
 */

function parseIPv4(text) {
  const value = String(text || '').trim();
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    out = (out << 8) | octet;
  }
  return out >>> 0;
}

function formatIPv4(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');
}

function parseIPv6(text) {
  let value = String(text || '').trim().toLowerCase();
  if (!value || value.includes('%')) return null;
  // Embedded IPv4 suffix (e.g. ::ffff:192.0.2.1) is rewritten as two groups.
  if (value.includes('.')) {
    const idx = value.lastIndexOf(':');
    if (idx === -1) return null;
    const v4 = parseIPv4(value.slice(idx + 1));
    if (v4 === null) return null;
    value = `${value.slice(0, idx)}:${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (part) => {
    if (!part) return [];
    return part.split(':').map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : null));
  };
  const left = parseGroups(halves[0]);
  const right = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (left.some((g) => g === null) || right.some((g) => g === null)) return null;
  let groups;
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    groups = left;
  } else {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...Array(missing).fill(0), ...right];
  }
  let out = 0n;
  for (const group of groups) out = (out << 16n) | BigInt(group);
  return out;
}

function formatIPv6(value) {
  const groups = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) groups.push(Number((value >> shift) & 0xffffn));
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < groups.length;) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < groups.length && groups[j] === 0) j++;
    if (j - i > bestLength) { bestStart = i; bestLength = j - i; }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLength < 2) return hex.join(':');
  const left = hex.slice(0, bestStart).join(':');
  const right = hex.slice(bestStart + bestLength).join(':');
  return `${left}::${right}`;
}

/** Normalize an address: `::ffff:1.2.3.4` becomes `1.2.3.4`, IPv6 is canonical. */
export function normalizeIp(ip) {
  let text = String(ip ?? '').trim();
  if (!text) return '';
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(text);
  if (mapped) text = mapped[1];
  const v4 = parseIPv4(text);
  if (v4 !== null) return formatIPv4(v4);
  const v6 = parseIPv6(text);
  if (v6 !== null) return formatIPv6(v6);
  return text;
}

/** Parse an IP or CIDR rule. Returns null for malformed input. */
export function parseCidr(rule) {
  const text = String(rule ?? '').trim();
  if (!text) return null;
  const slash = text.indexOf('/');
  const address = slash === -1 ? text : text.slice(0, slash);
  const suffix = slash === -1 ? null : text.slice(slash + 1);
  const v4 = parseIPv4(address);
  if (v4 !== null) {
    const prefix = suffix === null ? 32 : (/^\d{1,2}$/.test(suffix) ? Number(suffix) : NaN);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
    return { family: 4, value: BigInt(v4), prefix };
  }
  const v6 = parseIPv6(address);
  if (v6 !== null) {
    const prefix = suffix === null ? 128 : (/^\d{1,3}$/.test(suffix) ? Number(suffix) : NaN);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
    // IPv4-mapped IPv6 ranges (::ffff:a.b.c.d/N) are matched as IPv4 so an
    // allowlist entry written either way behaves the same.
    if (prefix >= 96 && (v6 >> 32n) === 0xffffn) {
      return { family: 4, value: v6 & 0xffffffffn, prefix: prefix - 96 };
    }
    return { family: 6, value: v6, prefix };
  }
  return null;
}

export function formatCidr(rule) {
  const parsed = parseCidr(rule);
  if (!parsed) return null;
  const address = parsed.family === 4 ? formatIPv4(Number(parsed.value)) : formatIPv6(parsed.value);
  const max = parsed.family === 4 ? 32 : 128;
  return parsed.prefix === max ? address : `${address}/${parsed.prefix}`;
}

/** True when `ip` is contained in the exact address or CIDR `rule`. */
export function ipMatches(ip, rule) {
  const a = parseCidr(normalizeIp(ip));
  const b = parseCidr(String(rule ?? '').trim());
  if (!a || !b || a.family !== b.family) return false;
  const bits = a.family === 4 ? 32 : 128;
  if (b.prefix === 0) return true;
  const shift = BigInt(bits - b.prefix);
  return (a.value >> shift) === (b.value >> shift);
}

/** Validate and canonicalize an IP allowlist. Invalid entries fail closed. */
export function validateAllowedIps(input) {
  const list = Array.isArray(input)
    ? input
    : String(input ?? '').split(/[\s,]+/);
  const rules = [];
  const seen = new Set();
  for (const raw of list) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    const normalized = formatCidr(text);
    if (!normalized) return { ok: false, error: `Invalid IP address or CIDR: ${text.slice(0, 64)}` };
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    rules.push(normalized);
    if (rules.length > MAX_ALLOWED_IPS) return { ok: false, error: `At most ${MAX_ALLOWED_IPS} IP rules are allowed` };
  }
  return { ok: true, rules };
}

function ipAllowed(allowedIps, ip) {
  const rules = Array.isArray(allowedIps) ? allowedIps : [];
  if (!rules.length) return true;
  const address = normalizeIp(ip);
  if (!address) return false;
  return rules.some((rule) => ipMatches(address, rule));
}

/* ----------------------------------------------------------------- keys ---- */

export function listKeys(userId = null) {
  return userId
    ? all('SELECT * FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC', userId)
    : all('SELECT k.*, u.username FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.revoked_at IS NULL ORDER BY k.created_at DESC');
}

function cleanScopes(scopes) {
  const list = Array.isArray(scopes) ? scopes : [scopes];
  const kept = [...new Set(list.filter((scope) => ['read', 'write', 'admin'].includes(String(scope))))];
  return kept.length ? kept : ['read'];
}

export function createKey(userId, { name, scopes = ['read'], allowedIps = [] } = {}, actor = 'admin') {
  const user = get('SELECT * FROM users WHERE id = ?', Number(userId));
  if (!user) return { ok: false, error: 'User not found' };
  const validated = validateAllowedIps(allowedIps);
  if (!validated.ok) return validated;
  const secret = `oa_${crypto.randomBytes(28).toString('base64url')}`;
  const prefix = secret.slice(0, 10);
  const hash = crypto.createHash('sha256').update(secret).digest('hex');
  const r = run('INSERT INTO api_keys(user_id, name, prefix, key_hash, scopes, allowed_ips, created_at) VALUES(?,?,?,?,?,?,?)',
    user.id, String(name || 'API key').slice(0, 80), prefix, hash, JSON.stringify(cleanScopes(scopes)), JSON.stringify(validated.rules), nowIso());
  run('INSERT INTO audit_log(actor, level, action, target, ip, created_at) VALUES(?,?,?,?,?,?)', actor, 'admin', 'api.key.create', `${user.username}:${prefix}`, '', nowIso());
  return { ok: true, id: r.lastInsertRowid, secret, prefix, allowedIps: validated.rules };
}

export function updateKey(id, { name, scopes = [], allowedIps = [] }, actor = 'admin') {
  const row = get('SELECT * FROM api_keys WHERE id = ?', Number(id));
  if (!row) return { ok: false, error: 'Not found' };
  const validated = validateAllowedIps(allowedIps);
  if (!validated.ok) return validated;
  const scopesValue = cleanScopes(Array.isArray(scopes) && scopes.length ? scopes : (() => {
    try { return JSON.parse(row.scopes || '[]'); } catch { return ['read']; }
  })());
  run('UPDATE api_keys SET name = ?, scopes = ?, allowed_ips = ? WHERE id = ?',
    String(name || row.name).slice(0, 80), JSON.stringify(scopesValue), JSON.stringify(validated.rules), row.id);
  run('INSERT INTO audit_log(actor, level, action, target, ip, created_at) VALUES(?,?,?,?,?,?)', actor, 'admin', 'api.key.update', `${row.prefix}`, '', nowIso());
  return { ok: true, allowedIps: validated.rules };
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
  if (!ipAllowed(allowed, ip)) return null;
  let scopes = [];
  try { scopes = JSON.parse(row.scopes || '[]'); } catch { scopes = []; }
  if (method !== 'GET' && !scopes.includes('write') && !scopes.includes('admin')) return null;
  const user = get('SELECT * FROM users WHERE id = ?', row.user_id);
  if (!user || user.suspended) return null;
  run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', nowIso(), row.id);
  user.api_scopes = scopes;
  user.api_key_id = row.id;
  user.api_key = { id: row.id, name: row.name, prefix: row.prefix, scopes, allowed_ips: allowed };
  user.auth = { type: 'api_key', key_id: row.id, scopes };
  return user;
}
