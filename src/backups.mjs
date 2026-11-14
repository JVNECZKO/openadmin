// Backup engine: real tar.gz archives of account homes and the panel database,
// with validated restore and safe download paths.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from './config.mjs';
import { getDb, run, get, all, nowIso } from './db.mjs';
import { dumpDatabase } from './mariadb.mjs';
import { homeRoot, userHome } from './paths.mjs';

function backupDir() {
  const dir = path.join(config.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(name) {
  return path.basename(String(name)).replace(/[^A-Za-z0-9_.-]/g, '_');
}

export function backupPath(filename) {
  return path.join(backupDir(), safeName(filename));
}

function dbSnapshot(dir) {
  const target = path.join(dir, 'openadmin.db');
  const escaped = target.replace(/'/g, "''");
  getDb().exec(`VACUUM INTO '${escaped}'`);
  return target;
}

function sizeOf(file) {
  try { return Math.round((fs.statSync(file).size / 1024 / 1024) * 10) / 10; } catch { return 0; }
}

function countFiles(dir) {
  let n = 0;
  const walk = (d, depth = 0) => {
    if (depth > 8) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.isDirectory()) walk(path.join(d, ent.name), depth + 1);
      else n++;
    }
  };
  walk(dir);
  return n;
}

/**
 * Create a real archive for one account.
 * kind: full | home | email | db
 */
export function createUserBackup(user, kind = 'full') {
  const kindSafe = ['full', 'home', 'email', 'db'].includes(kind) ? kind : 'full';
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `user_${user.username}_${stamp}_${Math.random().toString(36).slice(2, 6)}.tar.gz`;
  const staging = fs.mkdtempSync(path.join(config.dataDir, 'backup-stage-'));
  const entries = [];
  try {
    const home = userHome(user.username);
    if (kindSafe !== 'db') {
      let source = home;
      let target = path.join('homes', user.username);
      if (kindSafe === 'email') {
        source = path.join(home, 'mail');
        target = path.join('homes', user.username, 'mail');
      }
      if (fs.existsSync(source)) {
        fs.mkdirSync(path.join(staging, 'homes', user.username), { recursive: true });
        fs.cpSync(source, path.join(staging, target), { recursive: true });
        entries.push(target);
      }
    }

    // User archives never contain the panel database (it holds every account's
    // hashes). Database content is exported per owned database instead.
    const databases = all('SELECT db_name FROM databases WHERE user_id = ?', user.id);
    const dumpDir = path.join(staging, 'databases');
    const dumped = [];
    if (kindSafe === 'full' || kindSafe === 'db') {
      for (const row of databases) {
        const dump = dumpDatabase(row.db_name);
        fs.mkdirSync(dumpDir, { recursive: true });
        if (dump.ok && dump.sql) {
          fs.writeFileSync(path.join(dumpDir, `${row.db_name}.sql`), dump.sql);
          dumped.push({ name: row.db_name, file: `${row.db_name}.sql`, bytes: Buffer.byteLength(dump.sql) });
        } else {
          dumped.push({ name: row.db_name, file: null, error: dump.error });
        }
      }
      if (dumped.length) entries.push('databases');
    }

    const manifest = {
      product: 'OpenAdmin',
      username: user.username,
      kind: kindSafe,
      created: nowIso(),
      version: 1,
      databases: dumped,
      note: 'User backups exclude the panel database by design.',
    };
    fs.writeFileSync(path.join(staging, 'openadmin-backup.json'), JSON.stringify(manifest, null, 2));
    entries.push('openadmin-backup.json');

    const out = backupPath(filename);
    const tar = spawnSync('tar', ['-czf', out, '-C', staging, ...entries], { encoding: 'utf8', timeout: 120000 });
    if (tar.status !== 0) throw new Error(`tar failed: ${(tar.stderr || '').trim()}`);
    const size = sizeOf(out);
    const r = run('INSERT INTO backups(user_id, filename, kind, size_mb, status, created_at) VALUES(?,?,?,?,?,?)',
      user.id, filename, kindSafe, size, 'complete', nowIso());
    return { ok: true, id: r.lastInsertRowid, filename, size, databases: dumped, files: countFiles(staging) };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Server-wide archive of every home plus the database. */
export function createServerBackup(admin, scope = 'all') {
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `admin_backup_${stamp}_${Math.random().toString(36).slice(2, 6)}.tar.gz`;
  const staging = fs.mkdtempSync(path.join(config.dataDir, 'backup-stage-'));
  const entries = [];
  try {
    if (scope !== 'db') {
      const homes = homeRoot();
      if (fs.existsSync(homes)) {
        fs.cpSync(homes, path.join(staging, 'homes'), { recursive: true });
        entries.push('homes');
      }
    }
    dbSnapshot(staging);
    entries.push('openadmin.db');
    const out = backupPath(filename);
    const tar = spawnSync('tar', ['-czf', out, '-C', staging, ...entries], { encoding: 'utf8', timeout: 300000 });
    if (tar.status !== 0) throw new Error(`tar failed: ${(tar.stderr || '').trim()}`);
    const size = sizeOf(out);
    run('INSERT INTO backups(user_id, filename, kind, size_mb, status, created_at) VALUES(?,?,?,?,?,?)',
      admin.id, filename, 'server', size, 'complete', nowIso());
    return { ok: true, filename, size };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Validate that an archive only contains relative, non-traversing paths. */
export function inspectArchive(filename) {
  const file = backupPath(filename);
  if (!fs.existsSync(file)) return { ok: false, error: 'Archive not found' };
  const list = spawnSync('tar', ['-tzf', file], { encoding: 'utf8', timeout: 60000 });
  if (list.status !== 0) return { ok: false, error: (list.stderr || 'invalid archive').trim() };
  const entries = list.stdout.split('\n').filter(Boolean);
  const unsafe = entries.filter((e) => e.startsWith('/') || e.split('/').includes('..'));
  if (unsafe.length) return { ok: false, error: `unsafe paths: ${unsafe.slice(0, 3).join(', ')}`, entries };
  return { ok: true, entries, bytes: fs.statSync(file).size };
}

/** Restore one account's archive over its home directory. */
export function restoreUserBackup(user, filename) {
  const info = inspectArchive(filename);
  if (!info.ok) return { ok: false, error: info.error };
  const work = fs.mkdtempSync(path.join(config.dataDir, 'restore-'));
  try {
    const tar = spawnSync('tar', ['-xzf', backupPath(filename), '-C', work], { encoding: 'utf8', timeout: 300000 });
    if (tar.status !== 0) return { ok: false, error: (tar.stderr || 'extract failed').trim() };
    const source = path.join(work, 'homes', user.username);
    if (!fs.existsSync(source)) return { ok: false, error: 'Archive does not contain this account' };
    const home = userHome(user.username);
    fs.mkdirSync(home, { recursive: true });
    fs.cpSync(source, home, { recursive: true, force: true });
    return { ok: true, files: countFiles(home) };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Resolve a backup row for download, checking ownership. */
export function backupFor(user, id) {
  const row = get('SELECT * FROM backups WHERE id = ?', Number(id));
  if (!row) return null;
  if (user.level === 'admin') return row;
  if (user.level === 'reseller') {
    const owner = get('SELECT owner FROM users WHERE id = ?', row.user_id);
    if (owner?.owner === user.username || row.user_id === user.id) return row;
    return null;
  }
  return row.user_id === user.id ? row : null;
}
