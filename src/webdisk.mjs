// Minimal WebDAV webdisk. Every path goes through the same tenant resolver as
// the file manager: no traversal, no external symlink, no hardlink writes,
// quota-aware PUT, hashed Basic Auth credentials and an audit trail.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { all, get, run, nowIso, audit, hashPassword, verifyPassword, passwordNeedsRehash } from './db.mjs';
import { encryptSecret, decryptSecret } from './secrets.mjs';
import { userHome, homeRoot } from './paths.mjs';
import { resolveUserPath, resolveUserPathSafe } from './features/files.mjs';
import { checkDisk } from './quota.mjs';
import { limitsFor, rateLimited, recordFailure, clearFailures } from './auth.mjs';

const MAX_PUT_BYTES = 64 * 1024 * 1024;

export function listWebdisks(userId = null) {
  return userId ? all('SELECT * FROM webdisks WHERE user_id = ? ORDER BY id DESC', userId) : all('SELECT w.*, u.username AS owner FROM webdisks w JOIN users u ON u.id = w.user_id ORDER BY w.id DESC');
}

function rejectSubpath(raw) {
  const value = String(raw ?? '');
  if (value.length > 1024 || /\0|[\x00-\x1f\x7f]/.test(value) || value.includes('\\') || value.startsWith('/')) return false;
  if (/%(?:2e|2f|5c|00)/i.test(value)) return false;
  if (value.split('/').some((part) => part === '..' || part === '.')) return false;
  return true;
}

export function createWebdisk(user, { domain, subpath = '', password = '' } = {}, actor = 'admin') {
  const d = get('SELECT * FROM domains WHERE name = ? AND user_id = ?', String(domain || ''), user.id);
  if (!d) return { ok: false, error: 'Domena nie należy do konta' };
  if (!rejectSubpath(subpath)) return { ok: false, error: 'Nieprawidłowa ścieżka WebDisk' };
  const username = `${user.username}-${crypto.randomBytes(2).toString('hex')}`;
  const pass = password || crypto.randomBytes(16).toString('base64url');
  if (String(pass).length < 8) return { ok: false, error: 'Hasło min. 8 znaków' };
  let docroot;
  try {
    const home = userHome(user.username);
    const rawDocroot = d.docroot && path.resolve(d.docroot).startsWith(path.resolve(home) + path.sep)
      ? d.docroot
      : path.join(home, 'domains', d.name, 'public_html');
    const docrootRel = path.relative(home, rawDocroot);
    if (docrootRel.startsWith('..') || path.isAbsolute(docrootRel)) return { ok: false, error: 'Document root poza kontem' };
    const requested = `/home/${user.username}/${docrootRel}`;
    docroot = resolveUserPath(user.username, requested, { operation: 'create' });
    const rel = String(subpath || '').replace(/^\/+|\/+$/g, '');
    const candidate = rel ? path.resolve(docroot, rel) : docroot;
    if (candidate !== docroot && !candidate.startsWith(docroot + path.sep)) return { ok: false, error: 'WebDisk musi pozostać w katalogu domeny' };
    fs.mkdirSync(docroot, { recursive: true, mode: 0o750 });
    const baseRel = path.relative(home, candidate);
    if (baseRel.startsWith('..') || path.isAbsolute(baseRel)) return { ok: false, error: 'WebDisk poza katalogiem konta' };
    const base = resolveUserPath(user.username, `/home/${user.username}/${baseRel}`, { operation: 'create' });
    fs.mkdirSync(base, { recursive: true, mode: 0o750 });
    const real = fs.realpathSync(base);
    if (!real.startsWith(fs.realpathSync(userHome(user.username)) + path.sep)) return { ok: false, error: 'WebDisk poza katalogiem konta' };
    run('INSERT INTO webdisks(user_id, username, domain, path, password_enc, password_hash, enabled, created_at) VALUES(?,?,?,?,?,?,?,?)',
      user.id, username, d.name, base, null, hashPassword(pass), 1, nowIso());
    audit(actor, 'user', 'webdisk.create', username, '');
    return { ok: true, username, password: pass, path: base };
  } catch (error) {
    return { ok: false, error: error.code ? `${error.code}: ${error.message}` : error.message };
  }
}

export function deleteWebdisk(id, user, actor = 'admin') {
  const row = get('SELECT * FROM webdisks WHERE id = ?', Number(id));
  if (!row) return { ok: false, error: 'Not found' };
  if (user.level !== 'admin' && row.user_id !== user.id) return { ok: false, error: 'Forbidden' };
  run('DELETE FROM webdisks WHERE id = ?', row.id);
  audit(actor, user.level, 'webdisk.delete', row.username, '');
  return { ok: true };
}

function authUser(ctx) {
  const auth = String(ctx.req.headers.authorization || '');
  if (!auth.toLowerCase().startsWith('basic ')) return { row: null };
  let decoded = '';
  try { decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8'); } catch { return { row: null }; }
  const idx = decoded.indexOf(':');
  if (idx < 1) return { row: null };
  const username = decoded.slice(0, idx);
  const password = decoded.slice(idx + 1);
  if (rateLimited(`webdisk:${username}`, ctx.ip)) return { limited: true };
  const row = get('SELECT * FROM webdisks WHERE username = ? AND enabled = 1', username);
  if (!row) { recordFailure(`webdisk:${username}`, ctx.ip); return { row: null }; }
  let ok = false;
  if (row.password_hash) {
    ok = verifyPassword(password, row.password_hash);
  } else if (row.password_enc) {
    // One-time migration from the old reversible format.
    try {
      const stored = decryptSecret(row.password_enc);
      const a = Buffer.from(password); const b = Buffer.from(stored);
      ok = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (ok) run('UPDATE webdisks SET password_hash = ?, password_enc = NULL WHERE id = ?', hashPassword(password), row.id);
    } catch { ok = false; }
  }
  if (ok && passwordNeedsRehash(row.password_hash)) run('UPDATE webdisks SET password_hash = ? WHERE id = ?', hashPassword(password), row.id);
  if (!ok) {
    recordFailure(`webdisk:${username}`, ctx.ip);
    audit('webdisk', 'webdisk', 'webdisk.auth.fail', username, ctx.ip);
    return { row: null };
  }
  clearFailures(`webdisk:${username}`, ctx.ip, { clearIp: false });
  return { row };
}

function xml(s) { return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c])); }

function propfind(row, user, rel, stat, depth) {
  const href = `/webdisk/${rel.split('/').map(encodeURIComponent).join('/')}${stat.isDirectory() && !rel.endsWith('/') ? '/' : ''}`;
  const type = stat.isDirectory() ? '<D:collection/>' : '';
  let xmlOut = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>${href}</D:href><D:propstat><D:prop><D:resourcetype>${type}</D:resourcetype><D:getcontentlength>${stat.isDirectory() ? 0 : stat.size}</D:getcontentlength><D:getlastmodified>${stat.mtime.toUTCString()}</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  if (depth !== '0' && stat.isDirectory()) {
    let names = [];
    try { names = fs.readdirSync(path.join(row.path, rel)).slice(0, 500); } catch { names = []; }
    for (const name of names) {
      const childRel = path.posix.join(rel, name);
      try {
        const safe = resolvedFor(user, path.join(row.path, childRel), 'read');
        const lst = fs.lstatSync(safe);
        if (lst.isSymbolicLink() || (lst.isFile() && lst.nlink > 1)) continue;
        const st = fs.statSync(safe);
        if (!st.isDirectory() && !st.isFile()) continue;
        const ch = `/webdisk/${childRel.split('/').map(encodeURIComponent).join('/')}${st.isDirectory() ? '/' : ''}`;
        xmlOut += `<D:response><D:href>${ch}</D:href><D:propstat><D:prop><D:resourcetype>${st.isDirectory() ? '<D:collection/>' : ''}</D:resourcetype><D:getcontentlength>${st.isDirectory() ? 0 : st.size}</D:getcontentlength><D:getlastmodified>${st.mtime.toUTCString()}</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
      } catch { /* skip unsafe children */ }
    }
  }
  return xmlOut + '</D:multistatus>';
}

function safeRel(raw) {
  let value = String(raw || '').replace(/^\/+/, '');
  if (!value) return '';
  if (/%(?:2e|2f|5c|00)/i.test(value)) throw new Error('encoded separator');
  try { value = decodeURIComponent(value); } catch { throw new Error('invalid encoding'); }
  if (value.includes('\\') || /\0|[\x00-\x1f\x7f]/.test(value)) throw new Error('invalid characters');
  const parts = value.split('/').filter(Boolean);
  if (parts.some((part) => part === '..' || part === '.')) throw new Error('traversal');
  return parts.join('/');
}

function resolvedFor(user, abs, operation) {
  const home = userHome(user.username);
  const relative = path.relative(home, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw Object.assign(new Error('Forbidden'), { status: 403 });
  const safe = resolveUserPathSafe(user.username, `/home/${user.username}/${relative}`, { operation });
  if (!safe.ok) throw Object.assign(new Error(safe.error), { status: safe.status || 403, code: safe.code });
  return safe.path;
}

function rootFor(row, operation = 'read') {
  const user = get('SELECT * FROM users WHERE id = ?', row.user_id);
  if (!user) throw new Error('owner missing');
  return { user, root: resolvedFor(user, row.path, operation) };
}

function targetFor(row, rel, operation) {
  const { user, root } = rootFor(row, operation === 'read' ? 'read' : 'create');
  const candidate = rel ? path.resolve(root, rel) : root;
  if (candidate !== root && !candidate.startsWith(root + path.sep)) throw Object.assign(new Error('Forbidden'), { status: 403 });
  return { user, root, path: resolvedFor(user, candidate, operation) };
}

function isUnsafeFinal(abs) {
  try {
    const st = fs.lstatSync(abs);
    return st.isSymbolicLink() || (st.isFile() && st.nlink > 1);
  } catch { return false; }
}

function homeInodeCount(root) {
  let count = 0;
  const walk = (dir, depth) => {
    if (depth > 20 || count > 200000) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      count += 1;
      if (ent.isDirectory()) walk(path.join(dir, ent.name), depth + 1);
    }
  };
  walk(root, 0);
  return count;
}

export function handleWebdisk(ctx) {
  const auth = authUser(ctx);
  if (auth.limited) {
    ctx.res.setHeader('Retry-After', '600');
    ctx.res.writeHead(429, { 'Content-Type': 'text/plain' }); ctx.res.end('Too many attempts'); return { handled: true };
  }
  if (!auth.row) {
    ctx.res.setHeader('WWW-Authenticate', 'Basic realm="OpenAdmin WebDisk"');
    ctx.res.writeHead(401, { 'Content-Type': 'text/plain' }); ctx.res.end('Authentication required');
    return { handled: true };
  }
  const row = auth.row;
  const method = ctx.req.method;
  let rel = '';
  try { rel = safeRel(ctx.path.replace(/^\/webdisk\/?/, '')); } catch { ctx.res.writeHead(400); ctx.res.end('Bad path'); return { handled: true }; }
  if (method === 'OPTIONS') {
    ctx.res.writeHead(200, { DAV: '1, 2', Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE, LOCK, UNLOCK', 'MS-Author-Via': 'DAV' }); ctx.res.end();
    return { handled: true };
  }
  try {
    if (method === 'PROPFIND') {
      const target = targetFor(row, rel, 'read');
      const st = fs.statSync(target.path);
      if (isUnsafeFinal(target.path)) { ctx.res.writeHead(403); ctx.res.end(); return { handled: true }; }
      const body = propfind(row, target.user, rel, st, String(ctx.req.headers.depth || '1'));
      ctx.res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }); ctx.res.end(body);
      return { handled: true };
    }
    if (method === 'GET' || method === 'HEAD') {
      const target = targetFor(row, rel, 'read');
      const st = fs.statSync(target.path);
      if (st.isDirectory()) { ctx.res.writeHead(405); ctx.res.end(); return { handled: true }; }
      if (isUnsafeFinal(target.path)) { ctx.res.writeHead(403); ctx.res.end(); return { handled: true }; }
      const data = fs.readFileSync(target.path);
      ctx.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length, 'Last-Modified': st.mtime.toUTCString() });
      ctx.res.end(method === 'HEAD' ? undefined : data);
      return { handled: true };
    }
    if (method === 'PUT') {
      const target = targetFor(row, rel, 'create');
      const data = ctx.rawBody || Buffer.from(String(ctx.body?._raw || ''));
      if (!Buffer.isBuffer(data) || data.length > MAX_PUT_BYTES) { ctx.res.writeHead(413); ctx.res.end(); return { handled: true }; }
      const quota = checkDisk(target.user, data.length / 1024 / 1024);
      if (!quota.ok) { ctx.res.writeHead(507); ctx.res.end('Quota exceeded'); return { handled: true }; }
      const inodeLimit = Number(limitsFor(target.user).inodes || 0);
      if (inodeLimit > 0 && homeInodeCount(userHome(target.user.username)) >= inodeLimit) { ctx.res.writeHead(507); ctx.res.end('Inode quota exceeded'); return { handled: true }; }
      if (isUnsafeFinal(target.path)) { ctx.res.writeHead(403); ctx.res.end(); return { handled: true }; }
      fs.mkdirSync(path.dirname(target.path), { recursive: true, mode: 0o750 });
      const temp = path.join(path.dirname(target.path), `.openadmin-webdav-${crypto.randomBytes(8).toString('hex')}`);
      let reopened;
      try {
        // Re-resolve immediately before opening to narrow TOCTOU.
        reopened = targetFor(row, rel, 'create');
        if (isUnsafeFinal(reopened.path)) throw Object.assign(new Error('Forbidden'), { status: 403 });
        const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o640);
        try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
        fs.renameSync(temp, reopened.path);
        audit(row.username, 'user', 'webdisk.put', rel, ctx.ip);
        ctx.res.writeHead(201); ctx.res.end(); return { handled: true };
      } catch (error) {
        try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
        throw error;
      }
    }
    if (method === 'MKCOL') {
      const target = targetFor(row, rel, 'create');
      fs.mkdirSync(target.path, { recursive: false, mode: 0o750 });
      audit(row.username, 'user', 'webdisk.mkcol', rel, ctx.ip);
      ctx.res.writeHead(201); ctx.res.end(); return { handled: true };
    }
    if (method === 'DELETE') {
      if (!rel) { ctx.res.writeHead(403); ctx.res.end('Cannot delete WebDisk root'); return { handled: true }; }
      const target = targetFor(row, rel, 'delete');
      if (isUnsafeFinal(target.path)) { ctx.res.writeHead(403); ctx.res.end(); return { handled: true }; }
      fs.rmSync(target.path, { recursive: true, force: false });
      audit(row.username, 'user', 'webdisk.delete', rel, ctx.ip);
      ctx.res.writeHead(204); ctx.res.end(); return { handled: true };
    }
    if (method === 'MOVE') {
      if (!rel) { ctx.res.writeHead(403); ctx.res.end('Cannot move WebDisk root'); return { handled: true }; }
      const source = targetFor(row, rel, 'delete');
      if (isUnsafeFinal(source.path)) { ctx.res.writeHead(403); ctx.res.end(); return { handled: true }; }
      const dest = String(ctx.req.headers.destination || '');
      let destPath = '';
      try { destPath = new URL(dest, 'http://local').pathname; } catch { /* ignore */ }
      let destRel = '';
      try { destRel = safeRel(destPath.replace(/^\/webdisk\/?/, '')); } catch { ctx.res.writeHead(400); ctx.res.end(); return { handled: true }; }
      const destination = targetFor(row, destRel, 'create');
      if (isUnsafeFinal(destination.path)) { ctx.res.writeHead(403); ctx.res.end(); return { handled: true }; }
      fs.mkdirSync(path.dirname(destination.path), { recursive: true, mode: 0o750 });
      fs.renameSync(source.path, destination.path);
      audit(row.username, 'user', 'webdisk.move', `${rel} -> ${destRel}`, ctx.ip);
      ctx.res.writeHead(201); ctx.res.end(); return { handled: true };
    }
    if (method === 'LOCK' || method === 'UNLOCK') {
      ctx.res.writeHead(200, { 'Content-Type': 'application/xml', 'Lock-Token': '<opaquelocktoken:' + crypto.randomUUID() + '>' });
      ctx.res.end('<?xml version="1.0"?><D:prop xmlns:D="DAV:"><D:lockdiscovery/></D:prop>');
      return { handled: true };
    }
    ctx.res.writeHead(405, { Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE, LOCK, UNLOCK' }); ctx.res.end();
    return { handled: true };
  } catch (error) {
    const status = Number(error.status) || (error.code === 'ENOENT' ? 404 : error.code === 'EEXIST' ? 409 : 403);
    ctx.res.writeHead(status); ctx.res.end(status === 404 ? '' : 'Forbidden');
    return { handled: true };
  }
}
