// File manager (jailed to each account's home directory), FTP, backups, cron.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { all, get, run, nowIso, hashPassword, audit, setting } from '../db.mjs';
import { config } from '../config.mjs';
import { limitsFor } from '../auth.mjs';
import { html as h, formatBytes, formatDate, e, randomPassword, isEmail } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, emptyState, kvList, progress, pctClass } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { listCard } from '../ui/pages/list.mjs';
import { quota } from '../core/access.mjs';
import { createUserBackup, restoreUserBackup, createUserBackupJob, enqueueUserRestore, spawnJobRunner, jobView } from '../backups.mjs';
import { validateJob, rebuildCrontab, installCrontab, cronMeta } from '../cron.mjs';
import { systemProvider } from '../providers/index.mjs';
import { checkDisk } from '../quota.mjs';
import { userHome } from '../paths.mjs';

/* ------------------------------------------------------------------ paths */
// SEC-002: one resolver for every tenant path. No caller is allowed to fall
// back to the home directory: an unsafe path is a typed error, not a redirect.
const USERNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const WRITE_OPERATIONS = new Set(['write', 'create', 'delete', 'rename', 'upload']);

export class TenantPathError extends Error {
  constructor(code, message, { status = 403, field = 'path' } = {}) {
    super(message);
    this.name = 'TenantPathError';
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

function tenantError(code, message, status = 403) {
  return new TenantPathError(code, message, { status });
}

export function assertUsername(username) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw tenantError('INVALID_USERNAME', 'Invalid account name', 400);
  }
  return username;
}

export function homeDir(username) {
  assertUsername(username);
  const home = path.resolve(userHome(username));
  try { fs.mkdirSync(home, { recursive: true, mode: 0o700 }); } catch {
    throw tenantError('HOME_UNAVAILABLE', 'Account home is unavailable', 500);
  }
  let stat;
  try { stat = fs.lstatSync(home); } catch {
    throw tenantError('HOME_UNAVAILABLE', 'Account home is unavailable', 500);
  }
  if (stat.isSymbolicLink()) throw tenantError('HOME_SYMLINK', 'Account home must not be a symbolic link');
  if (!stat.isDirectory()) throw tenantError('HOME_NOT_DIRECTORY', 'Account home is not a directory', 500);
  return home;
}

function realHome(username) {
  const home = homeDir(username);
  try { return fs.realpathSync(home); } catch {
    throw tenantError('HOME_UNAVAILABLE', 'Account home is unavailable', 500);
  }
}

function decodeRequestedPath(value) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw tenantError('INVALID_PATH_TYPE', 'Path must be a string', 400);
  if (value.length > 4096) throw tenantError('PATH_TOO_LONG', 'Path is too long', 400);
  if (/\0/.test(value)) throw tenantError('INVALID_PATH_CHARS', 'Path contains a NUL byte', 400);
  // Encoded separators are rejected before normalisation so double-encoding
  // cannot smuggle a separator past the resolver.
  let probe = value;
  for (let depth = 0; depth < 4; depth++) {
    if (/%(?:2e|2f|5c|00)/i.test(probe)) throw tenantError('ENCODED_SEPARATOR', 'Path contains an encoded separator');
    let next;
    try { next = decodeURIComponent(probe); } catch { break; }
    if (next === probe) break;
    probe = next;
  }
  if (/[\x00-\x1f\x7f]/.test(value)) throw tenantError('INVALID_PATH_CHARS', 'Path contains control characters', 400);
  if (value.includes('\\')) throw tenantError('INVALID_PATH_CHARS', 'Backslashes are not allowed in paths', 400);
  return value;
}

function tenantRelativePath(username, requested) {
  let rel = decodeRequestedPath(requested);
  if (rel === '' || rel === '/') return '';
  if (rel.startsWith('/home/')) {
    const rest = rel.slice('/home/'.length);
    const slash = rest.indexOf('/');
    const owner = slash === -1 ? rest : rest.slice(0, slash);
    if (owner !== username) throw tenantError('PATH_OUTSIDE_TENANT', 'Path belongs to another account');
    rel = slash === -1 ? '' : rest.slice(slash);
  } else if (rel === '/home') {
    throw tenantError('PATH_OUTSIDE_TENANT', 'Path belongs to another account');
  }
  const parts = rel.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) throw tenantError('PATH_TRAVERSAL', 'Path traversal is not allowed');
  if (parts.some((part) => part.length > 255)) throw tenantError('PATH_SEGMENT_TOO_LONG', 'Path segment is too long', 400);
  return parts.join('/');
}

function nearestExisting(target, home) {
  let current = target;
  while (current !== home) {
    try { fs.lstatSync(current); return current; } catch (error) {
      if (error.code !== 'ENOENT') throw tenantError('PATH_UNREADABLE', 'Path cannot be inspected', 500);
      current = path.dirname(current);
    }
  }
  return home;
}

function assertReadablePath(home, abs, rootReal) {
  const probe = nearestExisting(abs, home);
  let probeReal;
  try { probeReal = fs.realpathSync(probe); } catch {
    throw tenantError('PATH_UNREADABLE', 'Path cannot be resolved', 500);
  }
  if (probeReal !== rootReal && !probeReal.startsWith(rootReal + path.sep)) {
    throw tenantError('SYMLINK_ESCAPE', 'Path resolves outside the account home');
  }
  // The final component may be a symlink, but its target must stay inside.
  let stat = null;
  try { stat = fs.lstatSync(abs); } catch (error) { if (error.code !== 'ENOENT') throw tenantError('PATH_UNREADABLE', 'Path cannot be inspected', 500); }
  if (stat?.isSymbolicLink()) {
    let targetReal;
    try { targetReal = fs.realpathSync(abs); } catch {
      throw tenantError('SYMLINK_ESCAPE', 'Path resolves outside the account home');
    }
    if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
      throw tenantError('SYMLINK_ESCAPE', 'Path resolves outside the account home');
    }
  }
}

function assertWritablePath(home, abs) {
  const relative = path.relative(home, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw tenantError('PATH_OUTSIDE_TENANT', 'Path escapes the account home');
  let current = home;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw tenantError('PATH_UNREADABLE', 'Path cannot be inspected', 500);
    }
    if (stat.isSymbolicLink()) throw tenantError('SYMLINK_BLOCKED', 'Symbolic links are not allowed for write operations');
    if (current === abs) {
      if (!stat.isFile() && !stat.isDirectory()) throw tenantError('SPECIAL_FILE', 'Special files cannot be modified');
      if (stat.isFile() && stat.nlink > 1) throw tenantError('HARDLINK_BLOCKED', 'Files with multiple hard links cannot be modified');
    }
  }
}

/**
 * Resolve a user supplied path inside the tenant home.
 * @param {string} username
 * @param {string} [requested] absolute (/home/user/...), home-relative or empty
 * @param {{operation?: 'read'|'list'|'write'|'create'|'delete'|'rename'|'upload'}} [options]
 * @returns {string} lexical path inside the home
 * @throws {TenantPathError}
 */
export function resolveUserPath(username, requested = '', { operation = 'read' } = {}) {
  assertUsername(username);
  const home = homeDir(username);
  const rootReal = realHome(username);
  const rel = tenantRelativePath(username, requested);
  const abs = rel ? path.resolve(home, rel) : home;
  if (abs !== home && !abs.startsWith(home + path.sep)) throw tenantError('PATH_OUTSIDE_TENANT', 'Path escapes the account home');
  if (WRITE_OPERATIONS.has(operation)) assertWritablePath(home, abs);
  else assertReadablePath(home, abs, rootReal);
  return abs;
}

/** Non-throwing wrapper for callers that prefer a typed result. */
export function resolveUserPathSafe(username, requested = '', options = {}) {
  try { return { ok: true, path: resolveUserPath(username, requested, options) }; }
  catch (error) {
    if (error instanceof TenantPathError) return { ok: false, code: error.code, error: error.message, status: error.status };
    throw error;
  }
}

export function displayPath(username, abs) {
  const home = homeDir(username);
  const resolved = path.resolve(abs);
  if (resolved === home) return `/home/${username}`;
  if (!resolved.startsWith(home + path.sep)) throw tenantError('PATH_OUTSIDE_TENANT', 'Path escapes the account home');
  return `/home/${username}${resolved.slice(home.length)}`;
}

export function validateEntryName(value) {
  if (typeof value !== 'string') throw tenantError('INVALID_NAME', 'Name must be a string', 400);
  const name = value.trim();
  if (!name || name === '.' || name === '..') throw tenantError('INVALID_NAME', 'Invalid name', 400);
  if (name.length > 255) throw tenantError('INVALID_NAME', 'Name is too long', 400);
  if (/[\0\/\\]/.test(name) || /[\x00-\x1f\x7f]/.test(name)) throw tenantError('INVALID_NAME', 'Name contains invalid characters', 400);
  return name;
}

function statForEntry(username, abs, name) {
  const entryPath = path.join(abs, name);
  let stat;
  try { stat = fs.lstatSync(entryPath); } catch { return null; }
  if (stat.isSymbolicLink()) {
    try {
      const safe = resolveUserPath(username, displayPath(username, abs) + '/' + name, { operation: 'read' });
      const target = fs.statSync(safe);
      return { stat, target, symlink: true, safe: true };
    } catch {
      return { stat, target: null, symlink: true, safe: false };
    }
  }
  return { stat, target: stat, symlink: false, safe: true };
}

export function listTenantDir(username, requested = '') {
  const abs = resolveUserPath(username, requested, { operation: 'list' });
  const dirents = fs.readdirSync(abs, { withFileTypes: true });
  const entries = [];
  for (const dirent of dirents) {
    if (dirent.name === '.' || dirent.name === '..') continue;
    const info = statForEntry(username, abs, dirent.name);
    if (!info) continue;
    const target = info.target || info.stat;
    const dir = info.safe && target.isDirectory();
    const ext = path.extname(dirent.name).toLowerCase();
    entries.push({
      name: dirent.name,
      dir,
      symlink: info.symlink,
      unsafe: !info.safe,
      size: dir ? dirSize(path.join(abs, dirent.name)) : Number(target.size) || 0,
      mtime: target.mtime ? target.mtime.toISOString() : new Date(0).toISOString(),
      perms: humanPerms(target.mode || 0),
      full: path.join(abs, dirent.name),
      editable: !dir && !info.symlink && info.safe && target.isFile() && (TEXT_EXT.has(ext) || dirent.name === '.htaccess'),
      ext,
    });
  }
  return { path: abs, display: displayPath(username, abs), entries };
}

export function readTenantFile(username, requested, { maxBytes = 400000 } = {}) {
  const abs = resolveUserPath(username, requested, { operation: 'read' });
  const stat = fs.lstatSync(abs);
  if (stat.isDirectory()) throw tenantError('IS_DIRECTORY', 'Path is a directory', 400);
  if (!stat.isFile() && !stat.isSymbolicLink()) throw tenantError('SPECIAL_FILE', 'Not a regular file', 400);
  const data = fs.readFileSync(abs);
  if (maxBytes && data.length > maxBytes) return { ok: true, path: abs, content: data.subarray(0, maxBytes).toString('utf8'), size: data.length, truncated: true };
  return { ok: true, path: abs, content: data.toString('utf8'), size: data.length, truncated: false };
}

function writeFlags(create) {
  const constants = fs.constants;
  const noFollow = constants.O_NOFOLLOW || 0;
  return create
    ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow
    : constants.O_WRONLY | constants.O_TRUNC | noFollow;
}

export function writeTenantFile(username, requested, content, { create = false, mode = 0o644 } = {}) {
  const abs = resolveUserPath(username, requested, { operation: create ? 'create' : 'write' });
  if (typeof content !== 'string' && !Buffer.isBuffer(content)) throw tenantError('INVALID_CONTENT', 'Content must be text or a buffer', 400);
  let fd;
  try { fd = fs.openSync(abs, writeFlags(create), mode); }
  catch (error) {
    if (error.code === 'ELOOP') throw tenantError('FINAL_SYMLINK', 'Refusing to write through a symbolic link');
    if (error.code === 'EEXIST') throw tenantError('ALREADY_EXISTS', 'File already exists', 409);
    if (error.code === 'ENOENT') throw tenantError('PARENT_MISSING', 'Parent directory does not exist', 404);
    throw error;
  }
  try { fs.writeFileSync(fd, content); } finally { try { fs.closeSync(fd); } catch { /* ignore */ } }
  return { ok: true, path: abs, display: displayPath(username, abs), size: Buffer.byteLength(content) };
}

export function createTenantDir(username, requested, name) {
  const safeName = validateEntryName(name);
  const dir = resolveUserPath(username, requested, { operation: 'create' });
  const abs = path.join(dir, safeName);
  if (abs !== dir && !abs.startsWith(dir + path.sep)) throw tenantError('PATH_OUTSIDE_TENANT', 'Path escapes the account home');
  fs.mkdirSync(abs, { recursive: false, mode: 0o755 });
  return { ok: true, path: abs, display: displayPath(username, abs) };
}

export function deleteTenantPath(username, requested, name = null) {
  const base = resolveUserPath(username, requested, { operation: 'delete' });
  const abs = name === null ? base : path.join(base, validateEntryName(name));
  if (abs === homeDir(username)) throw tenantError('HOME_DELETE_BLOCKED', 'The account home cannot be deleted');
  if (abs !== base && !abs.startsWith(base + path.sep)) throw tenantError('PATH_OUTSIDE_TENANT', 'Path escapes the account home');
  resolveUserPath(username, displayPath(username, abs), { operation: 'delete' });
  fs.rmSync(abs, { recursive: true, force: false });
  return { ok: true, path: displayPath(username, abs) };
}

export function renameTenantPath(username, requested, oldName, newName) {
  const base = resolveUserPath(username, requested, { operation: 'rename' });
  const from = path.join(base, validateEntryName(oldName));
  const to = path.join(base, validateEntryName(newName));
  if (!from.startsWith(base + path.sep) || !to.startsWith(base + path.sep)) throw tenantError('PATH_OUTSIDE_TENANT', 'Path escapes the account home');
  resolveUserPath(username, displayPath(username, from), { operation: 'rename' });
  resolveUserPath(username, displayPath(username, to), { operation: 'rename' });
  fs.renameSync(from, to);
  return { ok: true, from: displayPath(username, from), to: displayPath(username, to) };
}

function pathFailure(error) {
  return error instanceof TenantPathError ? error : new TenantPathError('PATH_ERROR', error?.message || 'Path operation failed', { status: 500 });
}

function filesRedirect(ctx, error, fallbackPath = null) {
  const base = fallbackPath || `/user/files?path=${encodeURIComponent(`/home/${ctx.user.username}`)}`;
  const sep = base.includes('?') ? '&' : '?';
  return ctx.redirect(base + sep + 'flash=' + encodeURIComponent(pathFailure(error).message) + '&type=error');
}

function humanPerms(mode) {
  const s = (mode & 0o777).toString(8).padStart(3, '0');
  return s;
}

function dirSize(dir, depth = 0, root = dir) {
  let total = 0;
  if (depth > 4) return 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const ent of entries) {
    if (ent.name === '.' || ent.name === '..' || ent.isSymbolicLink()) continue;
    const p = path.join(dir, ent.name);
    try {
      const stat = fs.lstatSync(p);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        const real = fs.realpathSync(p);
        const rootReal = fs.realpathSync(root);
        if (real === rootReal || real.startsWith(rootReal + path.sep)) total += dirSize(p, depth + 1, root);
      } else if (stat.isFile()) total += stat.size;
    } catch { /* skip */ }
  }
  return total;
}

const TEXT_EXT = new Set(['.html', '.htm', '.css', '.js', '.json', '.txt', '.md', '.php', '.conf', '.ini', '.xml', '.svg', '.yml', '.yaml', '.htaccess', '.sh', '.sql']);

/** Create a document root with a default index page for a new domain. */
export function provisionDomain(username, domain) {
  const root = path.join(homeDir(username), 'domains', domain, 'public_html');
  fs.mkdirSync(path.join(root, 'css'), { recursive: true });
  const index = path.join(root, 'index.html');
  if (!fs.existsSync(index)) {
    fs.writeFileSync(index, `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${domain}</title>\n<link rel="stylesheet" href="/css/style.css"></head>\n<body><h1>${domain}</h1><p>This site is hosted on OpenAdmin.</p></body></html>\n`, 'utf8');
  }
  const css = path.join(root, 'css', 'style.css');
  if (!fs.existsSync(css)) fs.writeFileSync(css, 'body{font-family:system-ui,sans-serif;margin:0;padding:48px;background:#f6f9fc;color:#17222e}h1{color:#0a6daa}\n', 'utf8');
  systemProvider().chownUser(username);
  return displayPath(username, root);
}

export function register(router) {
  /* --------------------------------------------------------- file manager */
  router.get('/user/files', (ctx) => {
    const username = ctx.user.username;
    const requested = ctx.query.path || `/home/${username}`;
    let dirInfo;
    try { dirInfo = listTenantDir(username, requested); }
    catch (error) { return filesRedirect(ctx, error); }
    const { path: abs, display } = dirInfo;
    const entries = dirInfo.entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));

    const absParts = display.split('/').filter(Boolean);
    const crumbs = absParts.slice(2).map((part, i) => ({
      label: part, path: '/' + absParts.slice(0, i + 3).join('/'),
    }));
    const editing = ctx.query.edit ? entries.find((x) => x.name === ctx.query.edit && x.editable) : null;
    let editorContent = '';
    if (editing) {
      try { editorContent = readTenantFile(username, display + '/' + editing.name).content; } catch { editorContent = ''; }
    }

    const body = h`
      ${card('Menedżer plików', h`
        <div class="file-pathbar">
          <a class="crumb-home" href="/user/files?path=/home/${username}" aria-label="Katalog domowy">${icon('home', { size: 15 })}</a>
          ${crumbs.map((c) => h`<span class="crumb-sep">/</span><a class="crumb-link" href="/user/files?path=${encodeURIComponent(c.path)}">${c.label}</a>`)}
          <span class="file-path-abs">${display}</span>
        </div>
        <p class="file-count small muted">${entries.length} elementów · ${formatBytes(dirSize(abs) / 1024 / 1024)}</p>
        <div class="file-toolbar">
          <details class="more-menu">
            <summary class="btn btn-primary btn-sm" role="button">${icon('plus', { size: 14 })} Nowy</summary>
            <div class="more-menu-list">
              <a class="menu-item" href="/user/files?path=${encodeURIComponent(display)}&new=file">Nowy plik</a>
              <a class="menu-item" href="/user/files?path=${encodeURIComponent(display)}&new=dir">Nowy katalog</a>
            </div>
          </details>
          <button class="btn btn-secondary btn-sm" type="button" data-open-modal="uploadModal">${icon('upload', { size: 14 })} Wgraj</button>
          <details class="more-menu">
            <summary class="btn btn-ghost btn-sm" role="button">Więcej</summary>
            <div class="more-menu-list">
              <a class="menu-item" href="/api/v1/files/download?path=${encodeURIComponent(display)}">Pobierz katalog (zip)</a>
            </div>
          </details>
        </div>
        <div class="table-wrap"><table class="data-table file-table responsive-table">
          <thead><tr><th>Nazwa</th><th>Rozmiar</th><th>Uprawnienia</th><th>Zmodyfikowano</th><th class="col-actions">Akcje</th></tr></thead>
          <tbody>
            ${display !== `/home/${username}` ? h`<tr><td colspan="5"><a class="link" href="/user/files?path=${encodeURIComponent(display.split('/').slice(0, -1).join('/') || '/home/' + username)}">${icon('arrowRight', { size: 14 })} Parent directory</a></td></tr>` : ''}
            ${entries.length ? entries.map((f) => h`<tr>
              <td data-label="Nazwa"><div class="file-name">${icon(f.dir ? 'folder' : 'file', { size: 16 })}
                ${f.unsafe ? h`<span title="Symbolic link escapes the account home">${f.name}</span>${badge('blocked', 'danger')}`
                  : f.dir ? h`<a href="/user/files?path=${encodeURIComponent(display + '/' + f.name)}">${f.name}</a>` : h`<span>${f.name}</span>`}</div></td>
              <td data-label="Rozmiar">${f.dir ? '—' : formatBytes(f.size / 1024 / 1024)}</td>
              <td class="cell-mono" data-label="Uprawnienia">${f.perms}</td>
              <td class="small" data-label="Zmodyfikowano">${formatDate(f.mtime, { time: true })}</td>
              <td class="col-actions" data-label="Akcje">${f.unsafe ? h`<span class="small muted">blocked</span>` : h`<div class="row-actions">
                ${f.dir
                  ? h`<a class="btn btn-secondary btn-sm" href="/user/files?path=${encodeURIComponent(display + '/' + f.name)}">Otwórz</a>`
                  : f.editable
                    ? h`<a class="btn btn-secondary btn-sm" href="/user/files?path=${encodeURIComponent(display)}&edit=${encodeURIComponent(f.name)}">Edytuj</a>`
                    : h`<a class="btn btn-secondary btn-sm" href="/api/v1/files/download?path=${encodeURIComponent(display + '/' + f.name)}">Pobierz</a>`}
                <details class="more-menu">
                  <summary class="btn btn-ghost btn-sm" role="button">Więcej</summary>
                  <div class="more-menu-list">
                    ${!f.dir ? h`<a class="menu-item" href="/api/v1/files/download?path=${encodeURIComponent(display + '/' + f.name)}">Pobierz</a>` : ''}
                    <button class="menu-item" type="button" data-open-modal="rename-${encodeURIComponent(f.name)}">Zmień nazwę</button>
                    <form method="post" action="/user/files/delete"><input type="hidden" name="_csrf" value="${ctx.csrf}">
                      <input type="hidden" name="path" value="${display}"><input type="hidden" name="name" value="${f.name}">
                      <button class="menu-item danger" type="submit" data-confirm="Usunąć ${e(f.name)}?">Usuń</button></form>
                  </div>
                </details>
              </div>`}</td>
            </tr>`) : h`<tr><td colspan="5">${emptyState('This directory is empty.')}</td></tr>`}
          </tbody>
        </table></div>
      `, { padded: false })}

      ${ctx.query.new ? card(ctx.query.new === 'dir' ? 'New folder' : 'New file', h`<form method="post" action="/user/files/create" class="oa-form u-s82">
        <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="path" value="${display}">
        <input type="hidden" name="kind" value="${ctx.query.new === 'dir' ? 'dir' : 'file'}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Name</label><input name="name" required placeholder="${ctx.query.new === 'dir' ? 'assets' : 'index.html'}"></div>
          ${ctx.query.new === 'dir' ? '' : h`<div class="field"><label class="field-label">Content</label><textarea name="content" rows="4" placeholder="Optional initial content"></textarea></div>`}
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Create</button><a class="btn btn-ghost" href="/user/files?path=${encodeURIComponent(display)}">Cancel</a></div>
      </form>`) : ''}
      ${editing ? card(`Edit · ${editing.name}`, h`<form method="post" action="/user/files/save" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <input type="hidden" name="path" value="${display}"><input type="hidden" name="name" value="${editing.name}">
        <p class="small muted mb-12">${display}/${editing.name} · ${formatBytes(editing.size / 1024 / 1024)}</p>
        <textarea name="content" rows="22" spellcheck="false" class="code-editor">${editorContent}</textarea>
        <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('save', { size: 16 })} Save file</button>
          <a class="btn btn-ghost" href="/user/files?path=${encodeURIComponent(display)}">Close</a></div>
      </form>`) : ''}

      <div class="modal-backdrop" id="uploadModal" hidden>
        <div class="modal">
          <header class="modal-head"><h3>Upload files</h3><button class="icon-btn" type="button" data-close-modal>${icon('x', { size: 18 })}</button></header>
          <div class="modal-body">
            <div class="dropzone" id="fileUpload" data-path="${display}" data-max-upload-bytes="${config.limits.maxUploadMb * 1024 * 1024}">
              ${icon('upload', { size: 26 })}
              <p><strong>Drop files here</strong> or click to browse</p>
              <input type="file" id="fileInput" multiple hidden>
              <span class="small muted">Maximum ${config.limits.maxUploadMb} MB per file · strumieniowo z możliwością wznowienia</span>
              <div class="progress-track u-s83" aria-hidden="true"><div class="progress-fill u-s84" data-upload-progress></div></div>
            </div>
          </div>
        </div>
      </div>
      ${entries.filter((f) => f.name).map((f) => h`<div class="modal-backdrop" id="rename-${encodeURIComponent(f.name)}" hidden>
        <div class="modal"><header class="modal-head"><h3>Rename</h3><button class="icon-btn" type="button" data-close-modal>${icon('x', { size: 18 })}</button></header>
          <div class="modal-body"><form method="post" action="/user/files/rename" class="oa-form" id="rn-${encodeURIComponent(f.name)}">
            <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="path" value="${display}"><input type="hidden" name="old" value="${f.name}">
            <div class="field"><label class="field-label">New name</label><input name="new" value="${f.name}" required></div>
          </form></div>
          <footer class="modal-foot"><button class="btn btn-ghost" type="button" data-close-modal>Cancel</button>
            <button class="btn btn-primary" type="submit" form="rn-${encodeURIComponent(f.name)}">Rename</button></footer>
        </div>
      </div>`)}`;
    return page(ctx, { title: 'File Manager', subtitle: display, body, wide: true });
  });

  router.post('/user/files/create', (ctx) => {
    const fallback = `/user/files?path=${encodeURIComponent(String(ctx.body.path || `/home/${ctx.user.username}`))}`;
    const disk = checkDisk(ctx.user);
    if (!disk.ok) return ctx.redirect('/user/files?flash=' + encodeURIComponent(`Disk quota exceeded (${disk.used.toFixed(1)} / ${disk.limit} MB)`) + '&type=error');
    try {
      const dir = resolveUserPath(ctx.user.username, ctx.body.path, { operation: 'create' });
      const display = displayPath(ctx.user.username, dir);
      const name = validateEntryName(ctx.body.name);
      if (ctx.body.kind === 'dir') createTenantDir(ctx.user.username, display, name);
      else writeTenantFile(ctx.user.username, display + '/' + name, String(ctx.body.content || ''), { create: true });
      systemProvider().chownUser(ctx.user.username);
      return ctx.redirect('/user/files?path=' + encodeURIComponent(display) + '&flash=Created');
    } catch (error) { return filesRedirect(ctx, error, fallback); }
  });

  router.post('/user/files/save', (ctx) => {
    const fallback = `/user/files?path=${encodeURIComponent(String(ctx.body.path || `/home/${ctx.user.username}`))}`;
    const disk = checkDisk(ctx.user);
    if (!disk.ok) return ctx.redirect('/user/files?path=' + encodeURIComponent(ctx.body.path || '') + '&flash=' + encodeURIComponent('Disk quota exceeded') + '&type=error');
    try {
      const dir = resolveUserPath(ctx.user.username, ctx.body.path, { operation: 'write' });
      const display = displayPath(ctx.user.username, dir);
      const name = validateEntryName(ctx.body.name);
      writeTenantFile(ctx.user.username, display + '/' + name, String(ctx.body.content ?? ''), { create: false });
      systemProvider().chownUser(ctx.user.username);
      return ctx.redirect('/user/files?path=' + encodeURIComponent(display) + '&flash=File%20saved');
    } catch (error) { return filesRedirect(ctx, error, fallback); }
  });

  router.post('/user/files/delete', (ctx) => {
    const fallback = `/user/files?path=${encodeURIComponent(String(ctx.body.path || `/home/${ctx.user.username}`))}`;
    try {
      const dir = resolveUserPath(ctx.user.username, ctx.body.path, { operation: 'delete' });
      const display = displayPath(ctx.user.username, dir);
      deleteTenantPath(ctx.user.username, display, ctx.body.name);
      return ctx.redirect('/user/files?path=' + encodeURIComponent(display) + '&flash=Deleted');
    } catch (error) { return filesRedirect(ctx, error, fallback); }
  });

  router.post('/user/files/rename', (ctx) => {
    const fallback = `/user/files?path=${encodeURIComponent(String(ctx.body.path || `/home/${ctx.user.username}`))}`;
    try {
      const dir = resolveUserPath(ctx.user.username, ctx.body.path, { operation: 'rename' });
      const display = displayPath(ctx.user.username, dir);
      renameTenantPath(ctx.user.username, display, ctx.body.old, ctx.body.new);
      return ctx.redirect('/user/files?path=' + encodeURIComponent(display) + '&flash=Renamed');
    } catch (error) { return filesRedirect(ctx, error, fallback); }
  });


  /* ------------------------------------------------- streaming upload */
  router.post('/user/files/upload-stream', async (ctx) => {
    const requestedPath = String(ctx.query.path || `/home/${ctx.user.username}`);
    const name = String(ctx.query.name || '').trim();
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      return { status: 400, json: { ok: false, code: 'invalid_name', error: 'Nieprawidłowa nazwa pliku.' } };
    }
    let dir;
    try { dir = resolveUserPath(ctx.user.username, requestedPath, { operation: 'upload' }); }
    catch (error) { return { status: 403, json: { ok: false, code: error.code || 'path_denied', error: error.message } }; }
    fs.mkdirSync(dir, { recursive: true });
    const full = path.join(dir, name);
    const maxBytes = config.limits.maxUploadMb * 1024 * 1024;
    const offsetHeader = Number(ctx.req.headers['x-upload-offset'] || 0);
    const offset = Number.isFinite(offsetHeader) && offsetHeader > 0 ? Math.trunc(offsetHeader) : 0;
    if (offset > maxBytes) return { status: 413, json: { ok: false, code: 'too_large', error: `Limit ${config.limits.maxUploadMb} MB.` } };
    const tempDir = path.join(config.dataDir, 'uploads');
    fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    const key = crypto.createHash('sha256').update(`${ctx.user.username}:${full}`).digest('hex').slice(0, 40);
    const temp = path.join(tempDir, `${key}.part`);
    if (offset > 0) {
      const size = fs.existsSync(temp) ? fs.statSync(temp).size : 0;
      if (size !== offset) return { status: 409, json: { ok: false, code: 'offset_mismatch', offset: size, error: `Wznów od bajtu ${size}.` } };
    } else {
      try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
    }
    const disk = checkDisk(ctx.user, offset / 1024 / 1024);
    if (!disk.ok) return { status: 413, json: { ok: false, code: 'quota', error: `Brak miejsca: ${disk.used.toFixed(1)} / ${disk.limit} MB.` } };
    let written = offset;
    try {
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(temp, { flags: offset > 0 ? 'a' : 'w', mode: 0o600 });
        let failed = false;
        const fail = (error) => { if (failed) return; failed = true; ws.destroy(); reject(error); };
        ctx.req.on('data', (chunk) => {
          written += chunk.length;
          if (written > maxBytes) { ctx.req.destroy(); fail(Object.assign(new Error(`Limit ${config.limits.maxUploadMb} MB.`), { status: 413, code: 'too_large' })); }
        });
        ctx.req.on('aborted', () => fail(Object.assign(new Error('Upload przerwany'), { status: 499, code: 'aborted' })));
        ctx.req.on('error', fail);
        ws.on('error', fail);
        ws.on('finish', resolve);
        ctx.req.pipe(ws);
      });
    } catch (error) {
      return { status: error.status || 500, json: { ok: false, code: error.code || 'upload_failed', error: error.message, offset: fs.existsSync(temp) ? fs.statSync(temp).size : 0 } };
    }
    if (written === 0) return { status: 400, json: { ok: false, code: 'empty', error: 'Pusty plik.' } };
    try {
      const check = resolveUserPath(ctx.user.username, `${requestedPath.replace(/\/+$/, '')}/${name}`, { operation: 'upload' });
      if (check !== full) throw new Error('Ścieżka docelowa zmieniła się podczas uploadu.');
      fs.renameSync(temp, full);
      fs.chmodSync(full, 0o644);
      systemProvider().chownUser(ctx.user.username);
    } catch (error) {
      return { status: 403, json: { ok: false, code: 'write_failed', error: error.message } };
    }
    audit(ctx.user.username, ctx.user.level, 'file.upload', name, ctx.ip);
    return { json: { ok: true, name, path: displayPath(ctx.user.username, full), size: written } };
  });

  /* ------------------------------------------------------------------ FTP */
  router.get('/user/ftp', (ctx) => {
    const rows = all('SELECT * FROM ftp_accounts WHERE user_id = ? ORDER BY username', ctx.user.id);
    const editing = ctx.query.edit ? rows.find((r) => String(r.id) === String(ctx.query.edit)) : null;
    const lim = limitsFor(ctx.user);
    const body = h`
      ${alert('FTP accounts can be restricted to any directory inside your home. Anonymous FTP can be enabled per domain under FTP Settings.', 'info')}
      ${listCard({
        title: 'FTP accounts', sub: `${rows.length} of ${lim.ftp || '∞'} accounts`,
        columns: [
          { label: 'Username', render: (r) => h`<span class="cell-strong">${r.username}</span>${r.anonymous ? badge('anonymous', 'warn') : ''}` },
          { label: 'Directory', render: (r) => h`<span class="cell-mono">${r.path}</span>` },
          { label: 'Quota', render: (r) => (r.quota_mb ? formatBytes(r.quota_mb) : 'Unlimited') },
          { label: 'Status', render: (r) => (r.suspended ? badge('Suspended', 'danger') : badge('Active', 'ok')) },
        ],
        rows, empty: 'No FTP accounts yet.',
        createHref: '/user/ftp/create', createLabel: 'Create FTP account',
        actions: [
          { label: 'Edytuj', href: (r) => `/user/ftp?edit=${r.id}`, icon: 'edit' },
          { label: 'Toggle', form: (r) => `/user/ftp/${r.id}/toggle`, icon: 'lock' },
          { label: 'Delete', form: (r) => `/user/ftp/${r.id}/delete`, confirm: 'Delete FTP account?', icon: 'trash', danger: true },
        ],
      })}
      ${editing ? card(`Edytuj FTP · ${editing.username}`, h`<form method="post" action="/user/ftp/${editing.id}/update" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Użytkownik</label><input value="${editing.username}" disabled></div>
          <div class="field"><label class="field-label">Nowe hasło (puste = bez zmian)</label><input name="password" type="password" minlength="8"></div>
          <div class="field"><label class="field-label">Katalog</label><input name="path" value="${editing.path}" required></div>
          <div class="field"><label class="field-label">Quota MB</label><input name="quota_mb" type="number" min="0" value="${editing.quota_mb}"></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Zapisz</button><a class="btn btn-ghost" href="/user/ftp">Anuluj</a></div>
      </form>`) : ''}`;
    return page(ctx, { title: 'FTP Accounts', subtitle: 'Manage file transfer users', body });
  });

  router.get('/user/ftp/create', (ctx) => {
    const body = h`${card('Create FTP account', h`<form method="post" action="/user/ftp/create" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid">
        <div class="field"><label class="field-label">Username <span class="req">*</span></label><input name="username" required pattern="[a-zA-Z0-9._-]{2,32}" placeholder="deploy"><p class="field-help">Created as <code>${ctx.user.username}_deploy</code>.</p></div>
        <div class="field"><label class="field-label">Password <span class="req">*</span></label>
          <div class="field-control"><input id="ftppass" name="password" type="password" required minlength="8"><button class="btn btn-secondary btn-sm u-s18" type="button" data-genpass="#ftppass">Generate</button></div></div>
        <div class="field field-full"><label class="field-label">Directory</label><input name="path" value="/home/${ctx.user.username}" required></div>
        <div class="field"><label class="field-label">Quota (MB)</label><input name="quota_mb" type="number" min="0" value="0"><p class="field-help">0 = unlimited</p></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Create FTP account</button><a class="btn btn-ghost" href="/user/ftp">Cancel</a></div>
    </form>`)}`;
    return page(ctx, { title: 'Create FTP Account', subtitle: 'Add a file transfer user', body });
  });

  router.post('/user/ftp/create', (ctx) => {
    const q = quota(ctx.user, 'ftp');
    if (!q.ok) return ctx.redirect('/user/ftp?flash=FTP%20limit%20reached&type=error');
    const user = `${ctx.user.username}_${String(ctx.body.username || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 24)}`;
    if (get('SELECT id FROM ftp_accounts WHERE username = ?', user)) return ctx.redirect('/user/ftp?flash=That%20FTP%20user%20already%20exists&type=error');
    const password = String(ctx.body.password || '');
    if (password.length < 8) return ctx.redirect('/user/ftp?flash=Password%20must%20be%208%2B%20characters&type=error');
    let reqPath;
    try {
      const abs = resolveUserPath(ctx.user.username, ctx.body.path || `/home/${ctx.user.username}`, { operation: 'write' });
      reqPath = displayPath(ctx.user.username, abs);
    } catch (error) { return filesRedirect(ctx, error, '/user/ftp'); }
    const created = systemProvider().createFtpUser(user, reqPath, password);
    if (!created.ok) return ctx.redirect('/user/ftp?flash=' + encodeURIComponent(created.output) + '&type=error');
    run('INSERT INTO ftp_accounts(user_id, username, path, quota_mb, password, created_at) VALUES(?,?,?,?,?,?)',
      ctx.user.id, user, reqPath, Number(ctx.body.quota_mb) || 0, hashPassword(password), nowIso());
    audit(ctx.user.username, ctx.user.level, 'ftp.create', user, ctx.ip);
    return ctx.redirect('/user/ftp?flash=' + encodeURIComponent(`FTP account ${user} created`));
  });

  router.post('/user/ftp/:id/update', (ctx) => {
    const a = get('SELECT * FROM ftp_accounts WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    if (!a) return ctx.redirect('/user/ftp?flash=Not%20found&type=error');
    const password = String(ctx.body.password || '');
    let path2;
    try {
      const abs = resolveUserPath(ctx.user.username, ctx.body.path || a.path, { operation: 'write' });
      path2 = displayPath(ctx.user.username, abs);
    } catch (error) { return filesRedirect(ctx, error, '/user/ftp'); }
    if (password && password.length < 8) return ctx.redirect('/user/ftp?flash=Password%20must%20be%208%2B%20characters&type=error');
    if (password) {
      const r = systemProvider().createFtpUser(a.username, path2, password);
      if (!r.ok) return ctx.redirect('/user/ftp?flash=' + encodeURIComponent(r.output || 'FTP update failed') + '&type=error');
    }
    run('UPDATE ftp_accounts SET path = ?, quota_mb = ?' + (password ? ', password = ?' : '') + ' WHERE id = ?',
      ...(password ? [path2, Number(ctx.body.quota_mb) || 0, hashPassword(password), a.id] : [path2, Number(ctx.body.quota_mb) || 0, a.id]));
    audit(ctx.user.username, ctx.user.level, 'ftp.update', a.username, ctx.ip);
    return ctx.redirect('/user/ftp?flash=FTP%20account%20updated');
  });

  router.post('/user/ftp/:id/delete', (ctx) => {
    const a = get('SELECT * FROM ftp_accounts WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    if (a) {
      systemProvider().deleteFtpUser(a.username);
      run('DELETE FROM ftp_accounts WHERE id = ?', a.id);
    }
    return ctx.redirect('/user/ftp?flash=FTP%20account%20deleted');
  });

  router.post('/user/ftp/:id/toggle', (ctx) => {
    const a = get('SELECT * FROM ftp_accounts WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    if (a) run('UPDATE ftp_accounts SET suspended = ? WHERE id = ?', a.suspended ? 0 : 1, a.id);
    return ctx.redirect('/user/ftp?flash=Updated');
  });

  router.get('/user/ftp/settings', (ctx) => {
    const domains = all('SELECT * FROM domains WHERE user_id = ? ORDER BY name', ctx.user.id);
    const body = h`${card('FTP settings', h`
      <form method="post" action="/user/ftp/settings" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Anonymous FTP</label>
            <select name="anonymous"><option value="0">Disabled (recommended)</option><option value="1">Enabled (read-only)</option></select></div>
          <div class="field"><label class="field-label">FTP over TLS</label>
            <select name="tls"><option value="1">Required</option><option value="0">Optional</option></select></div>
          <div class="field"><label class="field-label">Passive port range</label><input name="passive" value="35000-35999"></div>
          <div class="field"><label class="field-label">Max connections per user</label><input type="number" name="maxconn" value="8" min="1"></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save settings</button></div>
      </form>`)}
      ${card('Domain FTP access', h`${table({
        columns: [
          { label: 'Domain', key: 'name' },
          { label: 'Anonymous user', render: (d) => h`<span class="cell-mono">ftp@${d.name}</span>` },
          { label: 'Status', render: () => badge('Disabled', 'muted') },
        ],
        rows: domains, empty: 'No domains yet.',
      })}`)}`;
    return page(ctx, { title: 'FTP Settings', subtitle: 'Server-wide FTP options for your account', body });
  });

  router.post('/user/ftp/settings', (ctx) => {
    run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', `ftp_settings_${ctx.user.username}`, JSON.stringify(ctx.body));
    return ctx.redirect('/user/ftp/settings?flash=Settings%20saved');
  });

  /* -------------------------------------------------------------- backups */
  router.get('/user/backups', (ctx) => {
    const rows = all('SELECT * FROM backups WHERE user_id = ? ORDER BY created_at DESC', ctx.user.id);
    const body = h`
      <div class="grid grid-2">
        ${card('Create backup', h`
          <p class="small muted mb-18">User backups contain your home directory plus SQL dumps of your own databases. The panel database is excluded by design; DNS zones stay server-managed and are not included.</p>
          ${kvList([['Last backup', rows[0] ? formatDate(rows[0].created_at, { time: true }) : 'never'], ['Total backups', String(rows.length)], ['Storage used', formatBytes(rows.reduce((a, r) => a + r.size_mb, 0))]])}
          <form method="post" action="/user/backups/create" class="row u-s85">
            <input type="hidden" name="_csrf" value="${ctx.csrf}">
            <select name="kind"><option value="full">Full backup</option><option value="home">Home directory</option><option value="email">Email only</option><option value="db">Databases only</option></select>
            <button class="btn btn-primary" type="submit">${icon('archive', { size: 16 })} Create backup</button>
          </form>`)}
        ${card('Restore', h`<p class="small muted mb-12">Restore a previous backup over your current account. Existing files with the same name are replaced.</p>
          <form method="post" action="/user/backups/restore" class="row"><input type="hidden" name="_csrf" value="${ctx.csrf}">
            <select name="id">${rows.map((r) => h`<option value="${r.id}">${r.filename}</option>`)}</select>
            <button class="btn btn-secondary" type="submit" data-confirm="Restore this backup?">Restore backup</button></form>`)}
      </div>
      ${listCard({
        title: 'Backup history', sub: `${rows.length} archive(s)`,
        columns: [
          { label: 'Filename', render: (r) => h`<span class="cell-mono">${r.filename}</span>` },
          { label: 'Type', render: (r) => badge(r.kind, 'brand') },
          { label: 'Size', render: (r) => formatBytes(r.size_mb), align: 'right' },
          { label: 'Status', render: (r) => badge(r.status, 'ok') },
          { label: 'Created', render: (r) => formatDate(r.created_at, { time: true }) },
        ],
        rows,
        empty: 'No backups created yet.',
        actions: [
          { label: 'Download', href: (r) => `/api/v1/backups/${r.id}/download`, icon: 'download' },
          { label: 'Delete', form: (r) => `/user/backups/${r.id}/delete`, confirm: 'Delete this backup?', icon: 'trash', danger: true },
        ],
      })}`;
    return page(ctx, { title: 'Backups', subtitle: 'Create and restore account backups', body });
  });

  router.post('/user/backups/create', (ctx) => {
    const kind = ['full', 'home', 'email', 'db'].includes(String(ctx.body.kind)) ? String(ctx.body.kind) : 'full';
    const job = createUserBackupJob(ctx.user, kind, { actor: ctx.user.username });
    spawnJobRunner(job.jobId);
    audit(ctx.user.username, ctx.user.level, 'backup.create.request', `job:${job.jobId}`, ctx.ip);
    return ctx.redirect(`/user/backups/operations/${job.jobId}`);
  });

  router.get('/user/backups/operations/:id', (ctx) => {
    const job = jobView(Number(ctx.params.id));
    if (!job || (job.actor !== ctx.user.username && job.target !== `user:${ctx.user.username}`)) {
      return ctx.redirect('/user/backups?flash=Zadanie%20nie%20znalezione&type=error');
    }
    const stages = job.stages || [];
    const body = h`${card('Zadanie backupu', h`
      ${alert(`Status: ${job.status} · etap: ${job.stage_label || job.stage || '—'} · ${job.progress || 0}%`, job.status === 'complete' ? 'ok' : job.status === 'failed' ? 'danger' : 'info')}
      <div class="progress-track mb-18"><div class="progress-fill ${pctClass(job.progress)}"></div></div>
      <div class="stack">${stages.map((stage) => h`<div class="spread small"><span>${stage.label}</span><span>${badge(stage.status, stage.status === 'complete' ? 'ok' : stage.status === 'failed' ? 'danger' : 'muted')}</span></div>`)}</div>
      ${job.error ? alert(job.error, 'danger') : ''}
      <div class="row mt-18"><a class="btn btn-primary" href="/user/backups">Wróć do backupów</a>${['queued', 'running'].includes(job.status) ? h`<button class="btn btn-secondary" type="button" data-refresh-now>Odśwież status</button>` : ''}</div>
    `)}`;
    return page(ctx, { title: 'Backup', subtitle: `Zadanie #${job.id}`, body });
  });

  router.post('/user/backups/:id/delete', (ctx) => {
    const b = get('SELECT * FROM backups WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    if (b) {
      run('DELETE FROM backups WHERE id = ?', b.id);
      try { fs.rmSync(path.join(config.dataDir, 'backups', b.filename), { force: true }); } catch { /* ignore */ }
    }
    return ctx.redirect('/user/backups?flash=Backup%20deleted');
  });

  router.post('/user/backups/restore', (ctx) => {
    const b = get('SELECT * FROM backups WHERE id = ? AND user_id = ?', Number(ctx.body.id), ctx.user.id);
    if (!b) return ctx.redirect('/user/backups?flash=Backup%20not%20found&type=error');
    const job = enqueueUserRestore(ctx.user, b.filename, { actor: ctx.user.username });
    spawnJobRunner(job.jobId);
    audit(ctx.user.username, ctx.user.level, 'backup.restore.request', `job:${job.jobId}`, ctx.ip);
    return ctx.redirect(`/user/backups/operations/${job.jobId}`);
  });

  /* ----------------------------------------------------------------- cron */
  router.get('/user/cron', (ctx) => {
    const rows = all('SELECT * FROM cron_jobs WHERE user_id = ? ORDER BY id', ctx.user.id);
    const editing = ctx.query.edit ? rows.find((r) => String(r.id) === String(ctx.query.edit)) : null;
    const lim = limitsFor(ctx.user);
    const body = h`
      ${alert('Cron uses standard 5-field syntax. Commands run as your account with your home directory as the working directory.', 'info')}
      ${listCard({
        title: 'Cron jobs', sub: `${rows.length} of ${lim.cron || '∞'} jobs`,
        columns: [
          { label: 'Schedule', render: (r) => h`<span class="cell-mono">${[r.minute, r.hour, r.day, r.month, r.weekday].join(' ')}</span>` },
          { label: 'Command', render: (r) => h`<span class="cell-mono truncate u-s86">${r.command}</span>` },
          { label: 'Created', render: (r) => formatDate(r.created_at) },
        ],
        rows, empty: 'No cron jobs yet.',
        actions: [
          { label: 'Edytuj', href: (r) => `/user/cron?edit=${r.id}`, icon: 'edit' },
          { label: 'Delete', form: (r) => `/user/cron/${r.id}/delete`, confirm: 'Delete cron job?', icon: 'trash', danger: true },
        ],
        footer: h`<form method="post" action="/user/cron/create" class="cron-form">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <div class="cron-fields">
            <input name="minute" value="0" title="Minute" aria-label="Minute">
            <input name="hour" value="*" title="Hour" aria-label="Hour">
            <input name="day" value="*" title="Day" aria-label="Day">
            <input name="month" value="*" title="Month" aria-label="Month">
            <input name="weekday" value="*" title="Weekday" aria-label="Weekday">
          </div>
          <input class="u-s87" name="command" placeholder="/usr/local/bin/php /home/${ctx.user.username}/cron.php" required>
          <button class="btn btn-primary btn-sm" type="submit">${icon('plus', { size: 14 })} Add cron job</button>
        </form>`,
      })}
      ${editing ? card('Edytuj zadanie cron', h`<form method="post" action="/user/cron/${editing.id}/update" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="cron-fields">
          ${['minute','hour','day','month','weekday'].map((k) => h`<input name="${k}" value="${editing[k]}" aria-label="${k}">`)}
        </div>
        <div class="field field-full mt-12"><label class="field-label">Command</label><input name="command" value="${editing.command}" required></div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Zapisz</button><a class="btn btn-ghost" href="/user/cron">Anuluj</a></div>
      </form>`) : ''}
      ${card('Generated crontab', h`
        ${alert(`Crontab file: <code>${cronMeta(ctx.user.username)?.file || 'not generated'}</code> · installed by the provider on Linux (cron reload).`, 'info')}
        <pre class="code-block">${rows.map((r) => `${[r.minute, r.hour, r.day, r.month, r.weekday].join(' ')} ${r.command}`).join('\n') || '# no jobs'}</pre>
        <form method="post" action="/user/cron/install" class="mt-18"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <button class="btn btn-secondary btn-sm" type="submit">Install crontab</button></form>`)}`;
    return page(ctx, { title: 'Cron Jobs', subtitle: 'Schedule commands to run automatically', body });
  });

  router.post('/user/cron/create', (ctx) => {
    const q = quota(ctx.user, 'cron');
    if (!q.ok) return ctx.redirect('/user/cron?flash=Cron%20limit%20reached&type=error');
    const job = {
      minute: String(ctx.body.minute ?? '0'), hour: String(ctx.body.hour ?? '*'), day: String(ctx.body.day ?? '*'),
      month: String(ctx.body.month ?? '*'), weekday: String(ctx.body.weekday ?? '*'), command: String(ctx.body.command || '').trim(),
    };
    const problem = validateJob(job);
    if (problem) return ctx.redirect('/user/cron?flash=' + encodeURIComponent(problem) + '&type=error');
    run('INSERT INTO cron_jobs(user_id, minute, hour, day, month, weekday, command, created_at) VALUES(?,?,?,?,?,?,?,?)',
      ctx.user.id, job.minute, job.hour, job.day, job.month, job.weekday, job.command, nowIso());
    rebuildCrontab(ctx.user.username);
    audit(ctx.user.username, ctx.user.level, 'cron.create', job.command, ctx.ip);
    return ctx.redirect('/user/cron?flash=Cron%20job%20created');
  });

  router.post('/user/cron/install', (ctx) => {
    const result = installCrontab(ctx.user.username);
    audit(ctx.user.username, ctx.user.level, 'cron.install', result.ok ? 'ok' : 'failed', ctx.ip);
    return ctx.redirect('/user/cron?flash=' + encodeURIComponent(result.output) + (result.ok ? '' : '&type=error'));
  });

  router.post('/user/cron/:id/update', (ctx) => {
    const job = get('SELECT * FROM cron_jobs WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    if (!job) return ctx.redirect('/user/cron?flash=Not%20found&type=error');
    const next = { minute: String(ctx.body.minute ?? job.minute), hour: String(ctx.body.hour ?? job.hour), day: String(ctx.body.day ?? job.day), month: String(ctx.body.month ?? job.month), weekday: String(ctx.body.weekday ?? job.weekday), command: String(ctx.body.command || '').trim() };
    const problem = validateJob(next);
    if (problem) return ctx.redirect('/user/cron?flash=' + encodeURIComponent(problem) + '&type=error');
    run('UPDATE cron_jobs SET minute=?, hour=?, day=?, month=?, weekday=?, command=? WHERE id=?', next.minute, next.hour, next.day, next.month, next.weekday, next.command, job.id);
    rebuildCrontab(ctx.user.username);
    audit(ctx.user.username, ctx.user.level, 'cron.update', next.command, ctx.ip);
    return ctx.redirect('/user/cron?flash=Cron%20job%20updated');
  });

  router.post('/user/cron/:id/delete', (ctx) => {
    run('DELETE FROM cron_jobs WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    rebuildCrontab(ctx.user.username);
    audit(ctx.user.username, ctx.user.level, 'cron.delete', String(ctx.params.id), ctx.ip);
    return ctx.redirect('/user/cron?flash=Cron%20job%20deleted');
  });
}

void e; void randomPassword; void isEmail; void setting;
