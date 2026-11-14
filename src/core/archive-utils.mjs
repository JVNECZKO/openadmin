// Archive inspection and safe extraction.
//
// SEC-022: an archive is never handed to tar/unzip before its complete manifest
// has been parsed. Absolute paths, traversal, symlinks, hardlinks, devices and
// FIFOs are rejected. Extraction happens in a staging directory, the extracted
// tree is checked with lstat/realpath, and only then is it merged into the
// destination. No shell is involved anywhere in this module.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

const MAX_ENTRIES = 200000;
const MAX_NAME_BYTES = 4096;
const MAX_META_BYTES = 1024 * 1024;

export class ArchiveError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
    this.details = details;
  }
}

function failure(code, message, details = {}) {
  return { ok: false, code, error: message, ...details };
}

/** Resolve an executable through PATH without a shell. */
export function findExecutable(name) {
  if (typeof name !== 'string' || !name) return '';
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    if (!path.isAbsolute(name) || name.includes('\0')) return '';
    try {
      const st = fs.statSync(name);
      if (st.isFile()) {
        fs.accessSync(name, fs.constants.X_OK);
        return name;
      }
    } catch { /* not executable */ }
    return '';
  }
  if (!/^[A-Za-z0-9._+-]+$/.test(name)) return '';
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      const st = fs.statSync(candidate);
      if (!st.isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return '';
}

export function detectArchiveKind(filePath) {
  let fd;
  try { fd = fs.openSync(filePath, 'r'); } catch { return null; }
  try {
    const head = Buffer.alloc(512);
    const got = fs.readSync(fd, head, 0, head.length, 0);
    if (got >= 4) {
      if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05) && (head[3] === 0x04 || head[3] === 0x06)) return 'zip';
      if (head[0] === 0x1f && head[1] === 0x8b) return 'tar';
    }
    if (got >= 265 && head.subarray(257, 262).toString('latin1') === 'ustar') return 'tar';
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  const lower = String(filePath).toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.tar') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar';
  return null;
}

function normalizeEntryPath(raw) {
  if (typeof raw !== 'string') return { ok: false, code: 'ARCHIVE_PATH', error: 'Archive entry name is not text' };
  if (!raw || raw.includes('\0')) return { ok: false, code: 'ARCHIVE_PATH', error: 'Archive entry has an empty or NUL name' };
  if (Buffer.byteLength(raw) > MAX_NAME_BYTES) return { ok: false, code: 'ARCHIVE_PATH', error: 'Archive entry name is too long' };
  // Backslashes are path separators on Windows; refuse ambiguous names.
  if (raw.includes('\\')) return { ok: false, code: 'ARCHIVE_PATH', error: `Archive entry contains a backslash: ${raw.slice(0, 120)}` };
  if (raw.startsWith('/')) return { ok: false, code: 'ARCHIVE_PATH', error: `Archive entry is absolute: ${raw.slice(0, 120)}` };
  if (/^[A-Za-z]:/.test(raw)) return { ok: false, code: 'ARCHIVE_PATH', error: `Archive entry has a drive prefix: ${raw.slice(0, 120)}` };
  let name = raw;
  while (name.startsWith('./')) name = name.slice(2);
  const isDir = name.endsWith('/');
  if (isDir) name = name.replace(/\/+$/, '');
  if (!name || name === '.') return { ok: true, path: '', root: true, dir: true };
  const parts = name.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return { ok: false, code: 'ARCHIVE_PATH', error: `Archive entry escapes the destination: ${raw.slice(0, 120)}` };
  }
  return { ok: true, path: name, dir: isDir };
}

function typeName(tarType) {
  switch (tarType) {
    case '0': case '\0': case '7': return 'file';
    case '5': case 'D': return 'dir';
    case '1': return 'hardlink';
    case '2': return 'symlink';
    case '3': return 'char';
    case '4': return 'block';
    case '6': return 'fifo';
    default: return 'special';
  }
}

function parseOctal(buf) {
  // GNU tar stores very large values in base-256 with the high bit set.
  if (buf.length && (buf[0] & 0x80)) {
    let value = BigInt(buf[0] & 0x7f);
    for (let i = 1; i < buf.length; i++) value = value * 256n + BigInt(buf[i]);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(value);
  }
  const text = buf.toString('latin1').replace(/[\0 ]+$/g, '').trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) return null;
  const value = Number.parseInt(text, 8);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readExact(fd, target, length, position) {
  let read = 0;
  while (read < length) {
    const n = fs.readSync(fd, target, read, length - read, position + read);
    if (n <= 0) break;
    read += n;
  }
  return read;
}

function tarChecksumOk(block) {
  const expected = parseOctal(block.subarray(148, 156));
  if (expected === null) return false;
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < 512; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : block[i];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return expected === unsigned || expected === signed;
}

function readTarString(block, offset, length) {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return (end === -1 ? slice : slice.subarray(0, end)).toString('utf8');
}

function parsePax(text) {
  const records = {};
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0 || offset + length > text.length) break;
    const record = text.slice(space + 1, offset + length).replace(/\n$/, '');
    const eq = record.indexOf('=');
    if (eq > 0) records[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return records;
}

function decompressGzipForInspection(filePath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openadmin-arc-'));
  const target = path.join(dir, 'payload.tar');
  let inFd = null;
  let outFd = null;
  try {
    const gzip = findExecutable('gzip');
    if (!gzip) {
      fs.writeFileSync(target, zlib.gunzipSync(fs.readFileSync(filePath)), { mode: 0o600 });
      return { ok: true, dir, file: target };
    }
    inFd = fs.openSync(filePath, 'r');
    outFd = fs.openSync(target, 'w', 0o600);
    const r = spawnSync(gzip, ['-dc'], { stdio: [inFd, outFd, 'pipe'], timeout: 300000, maxBuffer: 1024 * 1024 });
    fs.closeSync(inFd); inFd = null;
    fs.closeSync(outFd); outFd = null;
    if (r.status !== 0) {
      return failure('ARCHIVE_CORRUPT', `Nie można zdekompresować archiwum: ${String(r.stderr || '').trim().slice(0, 300)}`);
    }
    return { ok: true, dir, file: target };
  } catch (error) {
    return failure('ARCHIVE_CORRUPT', `Nie można zdekompresować archiwum: ${error.message}`);
  } finally {
    if (inFd !== null) { try { fs.closeSync(inFd); } catch { /* ignore */ } }
    if (outFd !== null) { try { fs.closeSync(outFd); } catch { /* ignore */ } }
  }
}

export function inspectArchive(filePath, { kind = null, maxEntries = MAX_ENTRIES } = {}) {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch { return failure('ARCHIVE_MISSING', 'Archiwum nie istnieje'); }
  if (stat.isSymbolicLink()) return failure('ARCHIVE_SYMLINK', 'Archiwum nie może być dowiązaniem symbolicznym');
  if (!stat.isFile()) return failure('ARCHIVE_NOT_FILE', 'Archiwum nie jest zwykłym plikiem');
  const format = kind || detectArchiveKind(filePath);
  if (format === 'zip') return inspectZip(filePath, { maxEntries });
  if (format === 'tar' || format === 'tgz') return inspectTar(filePath, { maxEntries });
  return failure('ARCHIVE_UNSUPPORTED', 'Nieobsługiwany format archiwum (oczekiwano tar/tar.gz/zip)');
}

function inspectTar(filePath, { maxEntries }) {
  const head = Buffer.alloc(2);
  let fd0 = null;
  let gzip = false;
  try {
    fd0 = fs.openSync(filePath, 'r');
    const n = fs.readSync(fd0, head, 0, 2, 0);
    gzip = n === 2 && head[0] === 0x1f && head[1] === 0x8b;
  } catch { /* handled below */ }
  finally { if (fd0 !== null) { try { fs.closeSync(fd0); } catch { /* ignore */ } } }

  let payload = filePath;
  let temp = null;
  if (gzip) {
    const decompressed = decompressGzipForInspection(filePath);
    if (!decompressed.ok) return decompressed;
    payload = decompressed.file;
    temp = decompressed.dir;
  }
  try {
    const entries = [];
    const fd = fs.openSync(payload, 'r');
    try {
      const block = Buffer.alloc(512);
      let position = 0;
      let pendingName = null;
      let pendingLink = null;
      let pax = {};
      let zeroBlocks = 0;
      let totalBytes = 0;
      while (entries.length < maxEntries) {
        const read = readExact(fd, block, 512, position);
        if (read === 0) break;
        if (read < 512) return failure('ARCHIVE_CORRUPT', 'Ucięty nagłówek archiwum tar');
        if (block.every((b) => b === 0)) {
          zeroBlocks++;
          position += 512;
          if (zeroBlocks >= 2) break;
          continue;
        }
        zeroBlocks = 0;
        if (!tarChecksumOk(block)) return failure('ARCHIVE_CORRUPT', 'Nagłówek archiwum tar ma nieprawidłową sumę kontrolną');
        const size = parseOctal(block.subarray(124, 136));
        if (size === null) return failure('ARCHIVE_CORRUPT', 'Nagłówek archiwum tar ma nieprawidłowy rozmiar');
        const typeFlag = String.fromCharCode(block[156]);
        const prefix = readTarString(block, 345, 155);
        const rawBaseName = readTarString(block, 0, 100);
        const rawName = prefix ? `${prefix}/${rawBaseName}` : rawBaseName;
        const rawLink = readTarString(block, 157, 100);
        const dataStart = position + 512;

        if (typeFlag === 'L' || typeFlag === 'K' || typeFlag === 'x' || typeFlag === 'g') {
          if (size > MAX_META_BYTES) return failure('ARCHIVE_CORRUPT', 'Metadane archiwum tar są zbyt duże');
          const meta = Buffer.alloc(size);
          if (readExact(fd, meta, size, dataStart) !== size) return failure('ARCHIVE_CORRUPT', 'Ucięte metadane archiwum tar');
          const text = meta.toString('utf8');
          if (typeFlag === 'L') pendingName = text.replace(/\0.*$/s, '');
          else if (typeFlag === 'K') pendingLink = text.replace(/\0.*$/s, '');
          else if (typeFlag === 'x') {
            const parsed = parsePax(text);
            if (Object.keys(parsed).some((key) => key.startsWith('GNU.sparse.'))) {
              return failure('ARCHIVE_SPARSE_UNSUPPORTED', 'Sparsowane archiwa tar nie są obsługiwane');
            }
            pax = { ...pax, ...parsed };
          } else if (typeFlag === 'g') {
            return failure('ARCHIVE_PAX_GLOBAL_UNSUPPORTED', 'Globalne nagłówki PAX nie są obsługiwane');
          }
          position = dataStart + Math.ceil(size / 512) * 512;
          continue;
        }

        const effectiveName = pax.path || pendingName || rawName;
        const effectiveLink = pax.linkpath || pendingLink || rawLink;
        let effectiveSize = size;
        if (pax.size !== undefined) {
          const parsedSize = Number.parseInt(pax.size, 10);
          if (!Number.isSafeInteger(parsedSize) || parsedSize < 0) return failure('ARCHIVE_CORRUPT', 'PAX podaje nieprawidłowy rozmiar wpisu');
          effectiveSize = parsedSize;
        }
        pendingName = null; pendingLink = null; pax = {};

        if (effectiveName.length > MAX_NAME_BYTES) return failure('ARCHIVE_PATH', 'Nazwa wpisu archiwum jest zbyt długa');
        const safePath = normalizeEntryPath(effectiveName);
        if (!safePath.ok) return safePath;
        if (safePath.root) {
          position = dataStart + Math.ceil(effectiveSize / 512) * 512;
          continue;
        }
        const type = typeName(typeFlag);
        if (type === 'special') return failure('ARCHIVE_SPECIAL', `Nieobsługiwany typ wpisu archiwum: ${safePath.path}`, { entries });
        if (!Number.isSafeInteger(effectiveSize) || effectiveSize < 0) return failure('ARCHIVE_CORRUPT', `Nieprawidłowy rozmiar wpisu: ${safePath.path}`);
        const entry = {
          path: safePath.path,
          type: type === 'dir' && !safePath.dir ? 'dir' : type,
          size: type === 'file' || type === 'special' ? effectiveSize : 0,
          mode: parseOctal(block.subarray(100, 108)),
        };
        if (type === 'symlink' || type === 'hardlink') {
          if (!effectiveLink) return failure('ARCHIVE_LINK', `Link bez celu w archiwum: ${safePath.path}`);
          if (effectiveLink.includes('\0') || effectiveLink.startsWith('/') || effectiveLink.includes('\\')) {
            return failure('ARCHIVE_LINK', `Niebezpieczny cel linku w archiwum: ${safePath.path}`, { entries });
          }
          entry.linkTarget = effectiveLink;
        }
        entries.push(entry);
        totalBytes += effectiveSize;
        position = dataStart + Math.ceil(effectiveSize / 512) * 512;
        if (!Number.isSafeInteger(position)) return failure('ARCHIVE_CORRUPT', 'Archiwum tar ma nieprawidłową strukturę');
      }
      if (entries.length >= maxEntries) return failure('ARCHIVE_TOO_MANY_ENTRIES', `Archiwum ma więcej niż ${maxEntries} wpisów`);
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    if (!entries.length) return failure('ARCHIVE_EMPTY', 'Archiwum nie zawiera żadnych wpisów');
    return { ok: true, kind: 'tar', compression: gzip ? 'gzip' : null, entries, totalBytes: statSize(filePath) };
  } finally {
    if (temp) { try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

function statSize(filePath) {
  try { return fs.statSync(filePath).size; } catch { return 0; }
}

function inspectZip(filePath, { maxEntries }) {
  let fd;
  try { fd = fs.openSync(filePath, 'r'); } catch { return failure('ARCHIVE_MISSING', 'Archiwum nie istnieje'); }
  try {
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize < 22) return failure('ARCHIVE_CORRUPT', 'Plik ZIP jest za mały');
    const tailSize = Math.min(65557, fileSize);
    const tail = Buffer.alloc(tailSize);
    fs.readSync(fd, tail, 0, tailSize, fileSize - tailSize);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return failure('ARCHIVE_CORRUPT', 'Brak katalogu centralnego ZIP');
    const entriesCount = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (entriesCount === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
      return failure('ARCHIVE_ZIP64_UNSUPPORTED', 'Archiwum ZIP64 nie jest obsługiwane bezpiecznie');
    }
    if (entriesCount > maxEntries) return failure('ARCHIVE_TOO_MANY_ENTRIES', `Archiwum ma więcej niż ${maxEntries} wpisów`);
    if (centralSize > 64 * 1024 * 1024) return failure('ARCHIVE_TOO_LARGE', 'Katalog centralny ZIP jest zbyt duży');
    if (centralOffset + centralSize > fileSize) return failure('ARCHIVE_CORRUPT', 'Katalog centralny ZIP jest poza plikiem');
    const central = Buffer.alloc(centralSize);
    if (fs.readSync(fd, central, 0, centralSize, centralOffset) !== centralSize) {
      return failure('ARCHIVE_CORRUPT', 'Nie można odczytać katalogu centralnego ZIP');
    }
    const entries = [];
    let pos = 0;
    for (let index = 0; index < entriesCount; index++) {
      if (pos + 46 > central.length) return failure('ARCHIVE_CORRUPT', 'Ucięty katalog centralny ZIP');
      if (central.readUInt32LE(pos) !== 0x02014b50) return failure('ARCHIVE_CORRUPT', 'Nieprawidłowy wpis katalogu centralnego ZIP');
      const versionMadeBy = central.readUInt16LE(pos + 4);
      const flags = central.readUInt16LE(pos + 8);
      const method = central.readUInt16LE(pos + 10);
      const compressedSize = central.readUInt32LE(pos + 20);
      const uncompressedSize = central.readUInt32LE(pos + 24);
      const nameLen = central.readUInt16LE(pos + 28);
      const extraLen = central.readUInt16LE(pos + 30);
      const commentLen = central.readUInt16LE(pos + 32);
      const externalAttrs = central.readUInt32LE(pos + 38);
      const localOffset = central.readUInt32LE(pos + 42);
      const end = pos + 46 + nameLen + extraLen + commentLen;
      if (end > central.length) return failure('ARCHIVE_CORRUPT', 'Ucięty wpis katalogu centralnego ZIP');
      if (flags & 0x0001 || flags & 0x0040) return failure('ARCHIVE_ENCRYPTED', 'Zaszyfrowane archiwa ZIP nie są obsługiwane');
      const nameBuf = central.subarray(pos + 46, pos + 46 + nameLen);
      const name = nameBuf.toString((flags & 0x0800) ? 'utf8' : 'latin1');
      if (localOffset + 30 > fileSize) return failure('ARCHIVE_CORRUPT', `Wpis ZIP wskazuje poza plik: ${name.slice(0, 120)}`);
      const host = versionMadeBy >>> 8;
      const unixMode = (externalAttrs >>> 16) & 0xffff;
      let type = 'file';
      if (name.endsWith('/')) type = 'dir';
      if (unixMode) {
        const fileType = unixMode & 0o170000;
        if (fileType === 0o120000) type = 'symlink';
        else if (fileType === 0o040000) type = 'dir';
        else if (fileType === 0o010000) type = 'fifo';
        else if (fileType === 0o020000) type = 'char';
        else if (fileType === 0o060000) type = 'block';
        else if (fileType === 0o100000) type = 'file';
        else if (fileType !== 0) type = 'special';
      } else if (host === 0 && (externalAttrs & 0x10)) {
        type = 'dir';
      }
      const safePath = normalizeEntryPath(name);
      if (!safePath.ok) return safePath;
      if (safePath.root) { pos = end; continue; }
      entries.push({ path: safePath.path, type, size: type === 'file' ? uncompressedSize : 0, compressedSize, method, mode: unixMode ? (unixMode & 0o777) : null });
      pos = end;
    }
    if (!entries.length) return failure('ARCHIVE_EMPTY', 'Archiwum nie zawiera żadnych wpisów');
    return { ok: true, kind: 'zip', compression: null, entries, totalBytes: fileSize };
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** Reject every link/special entry. Installers and imports never need them. */
export function validateManifest(inspection) {
  if (!inspection || !inspection.ok) return inspection || failure('ARCHIVE_CORRUPT', 'Nie można sprawdzić archiwum');
  for (const entry of inspection.entries) {
    if (entry.type === 'symlink') return failure('ARCHIVE_LINK', `Archiwum zawiera dowiązanie symboliczne: ${entry.path}`, { entries: inspection.entries });
    if (entry.type === 'hardlink') return failure('ARCHIVE_HARDLINK', `Archiwum zawiera twarde dowiązanie: ${entry.path}`, { entries: inspection.entries });
    if (entry.type === 'char' || entry.type === 'block' || entry.type === 'fifo' || entry.type === 'special') {
      return failure('ARCHIVE_SPECIAL', `Archiwum zawiera wpis specjalny: ${entry.path}`, { entries: inspection.entries });
    }
    const safe = normalizeEntryPath(entry.path);
    if (!safe.ok) return safe;
  }
  return { ok: true, entries: inspection.entries };
}

function lstatOrNull(target) {
  try { return fs.lstatSync(target); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function scanTree(root) {
  const rootReal = fs.realpathSync(root);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) {
      return failure('EXTRACT_UNREADABLE', `Nie można sprawdzić rozpakowanego katalogu: ${error.message}`);
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let stat;
      try { stat = fs.lstatSync(full); } catch (error) {
        return failure('EXTRACT_UNREADABLE', `Nie można sprawdzić wpisu: ${error.message}`);
      }
      if (stat.isSymbolicLink()) return failure('EXTRACT_SYMLINK', `Rozpakowane archiwum zawiera dowiązanie: ${path.relative(root, full)}`);
      if (stat.isDirectory()) {
        // Archives may carry modes without owner execute; the extractor must
        // still be able to inspect and clean its own staging tree.
        try { fs.chmodSync(full, stat.mode | 0o700); } catch { /* best effort */ }
        stack.push(full);
        continue;
      }
      if (!stat.isFile()) return failure('EXTRACT_SPECIAL', `Rozpakowane archiwum zawiera wpis specjalny: ${path.relative(root, full)}`);
      if (stat.nlink > 1) return failure('EXTRACT_HARDLINK', `Rozpakowane archiwum zawiera twarde dowiązanie: ${path.relative(root, full)}`);
      const real = fs.realpathSync(full);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
        return failure('EXTRACT_ESCAPE', `Wpis wyprowadza poza katalog docelowy: ${path.relative(root, full)}`);
      }
    }
  }
  return { ok: true };
}

function mergeTree(source, destination) {
  const sourceReal = fs.realpathSync(source);
  const stack = [{ src: source, dest: destination }];
  while (stack.length) {
    const { src, dest } = stack.pop();
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      const stat = fs.lstatSync(srcPath);
      if (stat.isSymbolicLink()) return failure('EXTRACT_SYMLINK', `Nie można skopiować dowiązania: ${path.relative(sourceReal, srcPath)}`);
      let destStat = lstatOrNull(destPath);
      if (destStat) {
        if (destStat.isSymbolicLink()) return failure('DEST_SYMLINK', `Cel jest dowiązaniem: ${destPath}`);
        if (destStat.isFile() && destStat.nlink > 1) return failure('DEST_HARDLINK', `Cel jest twardym dowiązaniem: ${destPath}`);
        if (destStat.isFile() && !stat.isFile()) return failure('DEST_CONFLICT', `Konflikt typu pliku: ${destPath}`);
        if (!destStat.isDirectory() && stat.isDirectory()) return failure('DEST_CONFLICT', `Konflikt typu katalogu: ${destPath}`);
      }
      if (stat.isDirectory()) {
        if (!destStat) fs.mkdirSync(destPath, { recursive: false, mode: 0o755 });
        stack.push({ src: srcPath, dest: destPath });
      } else if (stat.isFile()) {
        if (destStat && destStat.isDirectory()) return failure('DEST_CONFLICT', `Katalog zastępuje plik: ${destPath}`);
        fs.copyFileSync(srcPath, destPath);
        try { fs.chmodSync(destPath, stat.mode & 0o777); } catch { /* best effort */ }
      } else {
        return failure('EXTRACT_SPECIAL', `Nieobsługiwany wpis: ${srcPath}`);
      }
    }
  }
  return { ok: true };
}

function extractToDirectory(filePath, destination, kind, timeout) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  if (kind === 'zip') {
    const unzip = findExecutable('unzip');
    if (!unzip) return failure('TOOL_MISSING', 'Brak unzip na serwerze');
    const r = spawnSync(unzip, ['-q', '-o', filePath, '-d', destination], { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) return failure('EXTRACT_FAILED', `Rozpakowanie ZIP nie powiodło się: ${(r.stderr || '').trim().slice(0, 400)}`);
    return { ok: true };
  }
  const tar = findExecutable('tar');
  if (!tar) return failure('TOOL_MISSING', 'Brak tar na serwerze');
  const args = ['-xf', filePath, '-C', destination, '--no-same-owner', '--no-same-permissions', '-m'];
  const r = spawnSync(tar, args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return failure('EXTRACT_FAILED', `Rozpakowanie TAR nie powiodło się: ${(r.stderr || '').trim().slice(0, 400)}`);
  return { ok: true };
}

/**
 * Validate an archive and extract it without ever trusting its links.
 * `merge: true` means the destination may already contain files (e.g. a domain
 * root); extraction always happens in a staging directory in that case.
 */
export function safeExtractArchive(filePath, destination, { kind = null, merge = false, timeout = 300000 } = {}) {
  const inspection = inspectArchive(filePath, { kind });
  const valid = validateManifest(inspection);
  if (!valid.ok) return valid;
  const target = path.resolve(destination);
  const kindResolved = inspection.kind;
  const targetExisted = fs.existsSync(target);
  try { fs.mkdirSync(target, { recursive: true, mode: 0o755 }); } catch (error) {
    return failure('DEST_NOT_DIRECTORY', `Katalog docelowy nie jest dostępny: ${error.message}`);
  }
  let targetStat;
  try { targetStat = fs.lstatSync(target); } catch (error) {
    return failure('DEST_NOT_DIRECTORY', `Katalog docelowy nie jest dostępny: ${error.message}`);
  }
  if (targetStat.isSymbolicLink()) return failure('DEST_SYMLINK', 'Katalog docelowy nie może być dowiązaniem');
  if (!targetStat.isDirectory()) return failure('DEST_NOT_DIRECTORY', 'Katalog docelowy nie jest katalogiem');

  const parent = path.dirname(target);
  const stage = fs.mkdtempSync(path.join(parent, '.openadmin-extract-'));
  try {
    const run = extractToDirectory(filePath, stage, kindResolved, timeout);
    if (!run.ok) return run;
    const scanned = scanTree(stage);
    if (!scanned.ok) return scanned;
    const merged = mergeTree(stage, target);
    if (!merged.ok) return merged;
    const finalScan = scanTree(target);
    if (!finalScan.ok) return finalScan;
    return { ok: true, kind: kindResolved, entries: inspection.entries, extracted: inspection.entries.length };
  } finally {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* ignore */ }
    if (!targetExisted) {
      try { if (!fs.readdirSync(target).length) fs.rmdirSync(target); } catch { /* ignore */ }
    }
  }
}

/** Post-extraction guard used by callers that extract through another code path. */
export function assertExtractedTree(root) {
  return scanTree(root);
}
