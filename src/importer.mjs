// Import cPanel / DirectAdmin account backups: home files, DNS zones and MySQL
// dumps. Archives are extracted to a private temp directory and inspected; the
// report states exactly what was imported and what was skipped.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { config } from './config.mjs';
import { get, run, nowIso, hashPassword } from './db.mjs';
import { userHome } from './paths.mjs';
import { createZone } from './features/domains.mjs';
import { rebuildZone } from './dns.mjs';
import { apply } from './apply.mjs';
import { detect as mariadbDetect, createDatabase, createAccount, dropDatabase } from './mariadb.mjs';
import { encryptSecret } from './secrets.mjs';
import { findExecutable, inspectArchive, safeExtractArchive, validateManifest } from './core/archive-utils.mjs';

export function detectKind(filePath) {
  const inspection = inspectArchive(filePath);
  if (!inspection.ok) return inspection;
  if (inspection.kind !== 'tar') return { ok: false, code: 'ARCHIVE_UNSUPPORTED', error: 'Import obsługuje archiwa tar.gz' };
  const valid = validateManifest(inspection);
  if (!valid.ok) return valid;
  const names = inspection.entries.map((entry) => entry.path);
  const bad = names.find((name) => name.startsWith('/') || name.split('/').includes('..'));
  if (bad) return { ok: false, code: 'ARCHIVE_PATH', error: `Niebezpieczna ścieżka w archiwum: ${bad}` };
  const hasDir = (name) => names.some((entry) => entry === name || entry.startsWith(`${name}/`) || entry.includes(`/${name}/`));
  const cpanel = hasDir('homedir');
  const da = hasDir('backup') || names.some((entry) => entry.endsWith('/user.conf') || entry === 'user.conf');
  return {
    ok: true,
    kind: cpanel ? 'cpanel' : da ? 'directadmin' : 'generic',
    entries: names.length,
    bytes: fs.statSync(filePath).size,
  };
}

export function extractArchive(file) {
  const dir = fs.mkdtempSync(path.join(config.dataDir, 'import-'));
  const result = safeExtractArchive(file, dir, { kind: 'tar', merge: false, timeout: 300000 });
  if (!result.ok) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: false, code: result.code, error: `Rozpakowanie nie powiodło się: ${result.error}` };
  }
  return { ok: true, dir, entries: result.entries };
}

function walk(dir, depth = 0, out = []) {
  if (depth > 12) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      out.push({ path: full, name: entry.name, dir: true });
      walk(full, depth + 1, out);
    } else if (stat.isFile()) {
      out.push({ path: full, name: entry.name, dir: false });
    }
  }
  return out;
}


/** Read-only import plan: extract/analyze/clean up without creating users or DNS. */
export function previewArchive(filePath) {
  const extracted = extractArchive(filePath);
  if (!extracted.ok) return extracted;
  try {
    const analysis = analyze(extracted.dir);
    return {
      ok: true,
      kind: detectKind(filePath),
      counts: analysis.counts,
      domains: analysis.domains,
      zones: analysis.zones.map((z) => z.domain),
      sqlFiles: analysis.sqlFiles.map((f) => f.name),
      webroots: analysis.webroots,
      sampleFiles: analysis.files.slice(0, 20).map((f) => path.relative(extracted.dir, f.path)),
      home: analysis.home ? path.basename(analysis.home) : '',
    };
  } finally {
    fs.rmSync(extracted.dir, { recursive: true, force: true });
  }
}

export function analyze(dir) {
  const all = walk(dir);
  const dirs = all.filter((entry) => entry.dir);
  const files = all.filter((entry) => !entry.dir);
  const home = dirs.find((entry) => entry.name === 'homedir')?.path
    || dirs.find((entry) => entry.name === 'backup')?.path
    || dir;
  const zoneFiles = files.filter((file) => /\.db$/i.test(file.name)).filter((file) => {
    try { return /\bSOA\b/i.test(fs.readFileSync(file.path, 'utf8').slice(0, 8000)); } catch { return false; }
  });
  const sqlFiles = files.filter((file) => /\.sql$/i.test(file.name));
  const webroots = [];
  for (const entry of dirs.filter((item) => item.name === 'public_html')) {
    const parent = path.dirname(entry.path);
    const domain = path.basename(parent);
    if (domain && domain !== 'homedir' && domain !== 'backup') webroots.push({ domain, dir: entry.path });
  }
  if (!webroots.length) {
    const candidate = dirs.find((entry) => entry.name === 'public_html' && entry.path.startsWith(home + path.sep));
    if (candidate) webroots.push({ domain: '', dir: candidate.path });
  }
  const zones = zoneFiles.map((file) => ({ domain: path.basename(file.name).replace(/\.db$/i, ''), file: file.path }));
  const domains = [...new Set([...zones.map((zone) => zone.domain), ...webroots.map((webroot) => webroot.domain).filter(Boolean)])];
  return {
    home, dirs, files, zones, sqlFiles, webroots, domains,
    counts: { files: files.length, zones: zones.length, databases: sqlFiles.length, domains: domains.length, webroots: webroots.length },
  };
}

function parseZone(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const clean = line.replace(/;.*$/, '').trim();
    if (!clean || /^\$/.test(clean) || /SOA/i.test(clean)) continue;
    const m = clean.match(/^(\S+)\s+(?:(\d+)\s+)?(?:IN\s+)?(A|AAAA|CNAME|MX|TXT|SRV|CAA|NS)\s+(.+)$/i);
    if (!m) continue;
    const name = m[1] === '@' ? '@' : m[1].replace(/\.$/, '');
    let value = m[4].trim().replace(/^"|"$/g, '');
    let priority = null;
    if (m[3].toUpperCase() === 'MX') {
      const mx = value.match(/^(\d+)\s+(.+)$/);
      if (mx) { priority = Number(mx[1]); value = mx[2]; }
    }
    if (m[3].toUpperCase() === 'NS') continue;
    out.push({ name, type: m[3].toUpperCase(), value, priority, ttl: Number(m[2]) || 3600 });
  }
  return out;
}

/* ------------------------------------------------ MariaDB without argv secrets */
function optionValue(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
}

/** SEC-021: credentials go to a 0600 defaults file, never to `-p` in argv. */
export function renderMysqlDefaults(mysql = {}) {
  const lines = ['[client]'];
  if (mysql.adminUser) lines.push(`user=${optionValue(mysql.adminUser)}`);
  if (mysql.password) lines.push(`password=${optionValue(mysql.password)}`);
  if (mysql.socket) lines.push(`socket=${optionValue(mysql.socket)}`);
  else {
    if (mysql.host) lines.push(`host=${optionValue(mysql.host)}`);
    if (mysql.port) lines.push(`port=${Number(mysql.port) || 3306}`);
  }
  return lines.join('\n') + '\n';
}

export function buildMysqlClientArgs(mysql, defaultsFile) {
  const args = [`--defaults-extra-file=${defaultsFile}`];
  if (mysql.socket) args.push('--socket', String(mysql.socket));
  else if (mysql.host) args.push('-h', String(mysql.host), '-P', String(Number(mysql.port) || 3306));
  return args;
}

function mariadb(file, dbName) {
  const bin = findExecutable('mariadb') || findExecutable('mysql');
  if (!bin || !mariadbDetect().connected) return { ok: false, error: 'MariaDB nie jest dostępna' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openadmin-sql-'));
  const defaults = path.join(dir, 'client.cnf');
  try {
    fs.writeFileSync(defaults, renderMysqlDefaults(config.mysql), { mode: 0o600 });
    const args = buildMysqlClientArgs(config.mysql, defaults);
    args.push(dbName);
    const r = spawnSync(bin, args, { input: fs.readFileSync(file), encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
    return { ok: r.status === 0, error: r.status === 0 ? '' : (r.stderr || '').trim() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function ensureInsideHome(home, candidate) {
  const base = path.resolve(home);
  const target = path.resolve(candidate);
  if (target !== base && !target.startsWith(base + path.sep)) return false;
  let probe = target;
  while (probe !== base) {
    try { fs.lstatSync(probe); break; } catch (error) {
      if (error.code !== 'ENOENT') return false;
      probe = path.dirname(probe);
    }
  }
  try {
    const baseReal = fs.realpathSync(base);
    const probeReal = fs.realpathSync(probe);
    return probeReal === baseReal || probeReal.startsWith(baseReal + path.sep);
  } catch { return false; }
}

export function importArchive({ filePath, targetUsername, skipDb = false }) {
  const user = get('SELECT * FROM users WHERE username = ?', targetUsername);
  if (!user) return { ok: false, error: 'Konto docelowe nie istnieje' };
  const kind = detectKind(filePath);
  if (!kind.ok) return kind;
  const extracted = extractArchive(filePath);
  if (!extracted.ok) return extracted;
  const report = { ok: true, kind: kind.kind, domains: [], files: 0, dns: 0, databases: [], skipped: [] };
  try {
    const info = analyze(extracted.dir);
    const home = userHome(user.username);
    fs.mkdirSync(home, { recursive: true });
    if (fs.lstatSync(home).isSymbolicLink()) return { ok: false, code: 'HOME_SYMLINK', error: 'Katalog domowy konta jest dowiązaniem symbolicznym' };
    if (!ensureInsideHome(home, home)) return { ok: false, error: 'Nieprawidłowy katalog domowy konta' };
    for (const zone of info.zones) {
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(zone.domain)) { report.skipped.push(`strefa ${zone.domain}`); continue; }
      let d = get('SELECT * FROM domains WHERE name = ?', zone.domain);
      if (!d) {
        const r = run(`INSERT INTO domains(user_id, username, name, docroot, php_version, ssl, status, is_main, ip, created_at)
                       VALUES(?,?,?,?,?,?,?,?,?,?)`, user.id, user.username, zone.domain,
        `${home}/domains/${zone.domain}/public_html`, '8.2', 0, 'active', 0, get("SELECT value FROM settings WHERE key='server_ip'")?.value || '127.0.0.1', nowIso());
        createZone(r.lastInsertRowid, zone.domain);
        d = get('SELECT * FROM domains WHERE id = ?', r.lastInsertRowid);
      }
      const records = parseZone(fs.readFileSync(zone.file, 'utf8'));
      let added = 0;
      const replaced = new Set();
      for (const rec of records) {
        if (!replaced.has(rec.name)) {
          run('DELETE FROM dns_records WHERE domain_id = ? AND name = ?', d.id, rec.name);
          replaced.add(rec.name);
        }
        run('INSERT INTO dns_records(domain_id, name, type, value, priority, ttl) VALUES(?,?,?,?,?,?)', d.id, rec.name, rec.type, rec.value, rec.priority, rec.ttl);
        added++;
      }
      rebuildZone(zone.domain);
      report.domains.push({ domain: zone.domain, records: added });
      report.dns += added;
    }
    for (const webroot of info.webroots) {
      const domain = webroot.domain || info.domains[0];
      if (!domain) { report.skipped.push('katalog public_html bez domeny'); continue; }
      const d = get('SELECT * FROM domains WHERE name = ? AND user_id = ?', domain, user.id);
      if (!d) { report.skipped.push(`pliki ${domain}`); continue; }
      if (!ensureInsideHome(home, d.docroot)) { report.skipped.push(`pliki ${domain}: cel poza kontem`); continue; }
      fs.mkdirSync(d.docroot, { recursive: true });
      fs.cpSync(webroot.dir, d.docroot, { recursive: true, force: true, errorOnExist: false, verbatimSymlinks: false });
      report.files += info.files.filter((entry) => entry.path.startsWith(webroot.dir + path.sep)).length;
    }
    // Remaining home files go to a separate folder to avoid overwriting the panel layout.
    const importedDir = path.join(home, 'imported', path.basename(info.home || 'backup'));
    if (info.home && fs.existsSync(info.home) && !info.webroots.length && ensureInsideHome(home, importedDir)) {
      fs.cpSync(info.home, importedDir, { recursive: true, force: true, errorOnExist: false, verbatimSymlinks: false });
      report.files += info.files.length;
    }
    if (!skipDb) {
      for (const sql of info.sqlFiles) {
        const base = path.basename(sql.name, '.sql').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(-40);
        const dbName = `${user.username}_${base}`.slice(0, 60);
        const created = createDatabase(dbName);
        if (!created.ok) { report.skipped.push(`baza ${sql.name}: ${created.error}`); continue; }
        const imported = mariadb(sql.path, dbName);
        if (!imported.ok) { dropDatabase(dbName); report.skipped.push(`baza ${sql.name}: ${imported.error}`); continue; }
        const dbPass = crypto.randomBytes(18).toString('base64url');
        const account = createAccount(dbName, dbName, dbPass);
        if (!account.ok) { report.skipped.push(`konto bazy ${dbName}: ${account.error}`); }
        if (!get('SELECT id FROM databases WHERE db_name = ?', dbName)) {
          run('INSERT INTO databases(user_id, db_name, db_user, password, password_enc, size_mb, created_at) VALUES(?,?,?,?,?,?,?)',
            user.id, dbName, dbName, hashPassword(dbPass), encryptSecret(dbPass), 0, nowIso());
        }
        report.databases.push(dbName);
      }
    } else if (info.sqlFiles.length) report.skipped.push(`${info.sqlFiles.length} baz (pominięto)`);
    spawnSync('chown', ['-R', '--', `${user.username}:${user.username}`, home], { encoding: 'utf8', timeout: 120000 });
    apply({ web: true, dns: true, pools: true });
    return report;
  } finally {
    fs.rmSync(extracted.dir, { recursive: true, force: true });
  }
}
