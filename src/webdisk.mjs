// Minimal WebDAV webdisk. Each account maps one URL namespace to a directory
// under the owner's home; Basic auth, PROPFIND/GET/PUT/MKCOL/DELETE/MOVE.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { all, get, run, nowIso, audit } from './db.mjs';
import { encryptSecret, decryptSecret } from './secrets.mjs';
import { userHome, homeRoot } from './paths.mjs';

export function listWebdisks(userId = null) {
  return userId ? all('SELECT * FROM webdisks WHERE user_id = ? ORDER BY id DESC', userId) : all('SELECT w.*, u.username AS owner FROM webdisks w JOIN users u ON u.id = w.user_id ORDER BY w.id DESC');
}

export function createWebdisk(user, { domain, subpath = '', password = '' } = {}, actor = 'admin') {
  const d = get('SELECT * FROM domains WHERE name = ? AND user_id = ?', String(domain || ''), user.id);
  if (!d) return { ok: false, error: 'Domena nie należy do konta' };
  const username = `${user.username}-${crypto.randomBytes(2).toString('hex')}`;
  const pass = password || crypto.randomBytes(16).toString('base64url');
  if (String(pass).length < 8) return { ok: false, error: 'Hasło min. 8 znaków' };
  const docroot = d.docroot && d.docroot.startsWith(homeRoot()) ? d.docroot : path.join(userHome(user.username), 'domains', d.name, 'public_html');
  fs.mkdirSync(docroot, { recursive: true, mode: 0o750 });
  const base = path.join(docroot, String(subpath || '').replace(/^\/+|\/+$/g, ''));
  fs.mkdirSync(base, { recursive: true, mode: 0o750 });
  run('INSERT INTO webdisks(user_id, username, domain, path, password_enc, enabled, created_at) VALUES(?,?,?,?,?,?,?)', user.id, username, d.name, base, encryptSecret(pass), 1, nowIso());
  audit(actor, 'user', 'webdisk.create', username, '');
  return { ok: true, username, password: pass, path: base };
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
  if (!auth.toLowerCase().startsWith('basic ')) return null;
  let decoded = '';
  try { decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8'); } catch { return null; }
  const idx = decoded.indexOf(':');
  if (idx < 1) return null;
  const username = decoded.slice(0, idx);
  const password = decoded.slice(idx + 1);
  const row = get('SELECT * FROM webdisks WHERE username = ? AND enabled = 1', username);
  if (!row) return null;
  let stored = '';
  try { stored = decryptSecret(row.password_enc); } catch { return null; }
  const a = Buffer.from(password); const b = Buffer.from(stored);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return row;
}

function xml(s) { return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c])); }

function propfind(row, rel, stat, depth) {
  const href = `/webdisk/${rel.split('/').map(encodeURIComponent).join('/')}${stat.isDirectory() && !rel.endsWith('/') ? '/' : ''}`;
  const type = stat.isDirectory() ? '<D:collection/>' : '';
  let xmlOut = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>${href}</D:href><D:propstat><D:prop><D:resourcetype>${type}</D:resourcetype><D:getcontentlength>${stat.isDirectory() ? 0 : stat.size}</D:getcontentlength><D:getlastmodified>${stat.mtime.toUTCString()}</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  if (depth !== '0' && stat.isDirectory()) {
    for (const name of fs.readdirSync(path.join(row.path, rel)).slice(0, 500)) {
      const childRel = path.posix.join(rel, name);
      try {
        const st = fs.statSync(path.join(row.path, childRel));
        const ch = `/webdisk/${childRel.split('/').map(encodeURIComponent).join('/')}${st.isDirectory() ? '/' : ''}`;
        xmlOut += `<D:response><D:href>${ch}</D:href><D:propstat><D:prop><D:resourcetype>${st.isDirectory() ? '<D:collection/>' : ''}</D:resourcetype><D:getcontentlength>${st.isDirectory() ? 0 : st.size}</D:getcontentlength><D:getlastmodified>${st.mtime.toUTCString()}</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
      } catch { /* skip */ }
    }
  }
  return xmlOut + '</D:multistatus>';
}

export function handleWebdisk(ctx) {
  const row = authUser(ctx);
  if (!row) {
    ctx.res.setHeader('WWW-Authenticate', 'Basic realm="OpenAdmin WebDisk"');
    ctx.res.writeHead(401, { 'Content-Type': 'text/plain' }); ctx.res.end('Authentication required');
    return { handled: true };
  }
  const rel = decodeURIComponent(ctx.path.replace(/^\/webdisk\/?/, '')).replace(/\\/g, '/');
  if (rel.split('/').includes('..')) { ctx.res.writeHead(400); ctx.res.end('Bad path'); return { handled: true }; }
  const target = path.resolve(row.path, rel);
  if (target !== path.resolve(row.path) && !target.startsWith(path.resolve(row.path) + path.sep)) { ctx.res.writeHead(403); ctx.res.end('Forbidden'); return { handled: true }; }
  const method = ctx.req.method;
  if (method === 'OPTIONS') {
    ctx.res.writeHead(200, { DAV: '1, 2', Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE, LOCK, UNLOCK', 'MS-Author-Via': 'DAV' }); ctx.res.end();
    return { handled: true };
  }
  if (method === 'PROPFIND') {
    try {
      const st = fs.statSync(target);
      const body = propfind(row, rel, st, String(ctx.req.headers.depth || '1'));
      ctx.res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }); ctx.res.end(body);
    } catch { ctx.res.writeHead(404); ctx.res.end(); }
    return { handled: true };
  }
  if (method === 'GET' || method === 'HEAD') {
    try {
      const st = fs.statSync(target);
      if (st.isDirectory()) { ctx.res.writeHead(405); ctx.res.end(); return { handled: true }; }
      const data = fs.readFileSync(target);
      ctx.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length, 'Last-Modified': st.mtime.toUTCString() });
      ctx.res.end(method === 'HEAD' ? undefined : data);
    } catch { ctx.res.writeHead(404); ctx.res.end(); }
    return { handled: true };
  }
  if (method === 'PUT') {
    const data = ctx.rawBody || Buffer.from(String(ctx.body?._raw || ''));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    ctx.res.writeHead(201); ctx.res.end(); return { handled: true };
  }
  if (method === 'MKCOL') {
    try { fs.mkdirSync(target, { recursive: false }); ctx.res.writeHead(201); } catch { ctx.res.writeHead(405); }
    ctx.res.end(); return { handled: true };
  }
  if (method === 'DELETE') {
    try { fs.rmSync(target, { recursive: true, force: true }); ctx.res.writeHead(204); } catch { ctx.res.writeHead(404); }
    ctx.res.end(); return { handled: true };
  }
  if (method === 'MOVE') {
    const dest = String(ctx.req.headers.destination || '');
    let destPath = '';
    try { destPath = new URL(dest, 'http://local').pathname; } catch { /* ignore */ }
    const destRel = decodeURIComponent(destPath.replace(/^\/webdisk\/?/, ''));
    const destTarget = path.resolve(row.path, destRel);
    if (!destTarget.startsWith(path.resolve(row.path) + path.sep)) { ctx.res.writeHead(403); ctx.res.end(); return { handled: true }; }
    try { fs.mkdirSync(path.dirname(destTarget), { recursive: true }); fs.renameSync(target, destTarget); ctx.res.writeHead(201); } catch { ctx.res.writeHead(409); }
    ctx.res.end(); return { handled: true };
  }
  if (method === 'LOCK' || method === 'UNLOCK') {
    ctx.res.writeHead(200, { 'Content-Type': 'application/xml', 'Lock-Token': '<opaquelocktoken:' + crypto.randomUUID() + '>' });
    ctx.res.end('<?xml version="1.0"?><D:prop xmlns:D="DAV:"><D:lockdiscovery/></D:prop>');
    return { handled: true };
  }
  ctx.res.writeHead(405, { Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE, LOCK, UNLOCK' }); ctx.res.end();
  return { handled: true };
}
