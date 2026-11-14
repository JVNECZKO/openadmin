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

function tarList(file) {
  const r = spawnSync('tar', ['-tzf', file], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return { ok: false, error: (r.stderr || 'tar failed').trim() };
  return { ok: true, names: r.stdout.split('\n').filter(Boolean) };
}

export function detectKind(file) {
  const list = tarList(file);
  if (!list.ok) return { ok: false, error: list.error };
  const bad = list.names.find((n) => n.startsWith('/') || n.split('/').includes('..'));
  if (bad) return { ok: false, error: `Niebezpieczna ścieżka w archiwum: ${bad}` };
  const hasDir = (name) => list.names.some((n) => n === `${name}/` || n.startsWith(`${name}/`) || n.includes(`/${name}/`));
  const cpanel = hasDir('homedir');
  const da = hasDir('backup') || list.names.some((n) => n.endsWith('/user.conf'));
  return {
    ok: true,
    kind: cpanel ? 'cpanel' : da ? 'directadmin' : 'generic',
    entries: list.names.length,
    bytes: fs.statSync(file).size,
  };
}

export function extractArchive(file) {
  const dir = fs.mkdtempSync(path.join(config.dataDir, 'import-'));
  const r = spawnSync('tar', ['-xzf', file, '-C', dir, '--no-same-owner', '--no-same-permissions'], {
    encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: false, error: `Rozpakowanie nie powiodło się: ${(r.stderr || '').trim()}` };
  }
  return { ok: true, dir };
}

function walk(dir, depth = 0, out = []) {
  if (depth > 12) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    out.push({ path: p, name: e.name, dir: e.isDirectory() });
    if (e.isDirectory()) walk(p, depth + 1, out);
  }
  return out;
}

export function analyze(dir) {
  const all = walk(dir);
  const dirs = all.filter((e) => e.dir);
  const files = all.filter((e) => !e.dir);
  const home = dirs.find((d) => d.name === 'homedir')?.path
    || dirs.find((d) => d.name === 'backup')?.path
    || dir;
  const zoneFiles = files.filter((f) => /\.db$/i.test(f.name)).filter((f) => {
    try { return /\bSOA\b/i.test(fs.readFileSync(f.path, 'utf8').slice(0, 8000)); } catch { return false; }
  });
  const sqlFiles = files.filter((f) => /\.sql$/i.test(f.name));
  const webroots = [];
  for (const d of dirs.filter((x) => x.name === 'public_html')) {
    const parent = path.dirname(d.path);
    const domain = path.basename(parent);
    if (domain && domain !== 'homedir' && domain !== 'backup') webroots.push({ domain, dir: d.path });
  }
  if (!webroots.length) {
    const cp = dirs.find((d) => d.name === 'public_html' && d.path.startsWith(home + path.sep));
    if (cp) webroots.push({ domain: '', dir: cp.path });
  }
  const zones = zoneFiles.map((f) => ({ domain: path.basename(f.name).replace(/\.db$/i, ''), file: f.path }));
  const domains = [...new Set([...zones.map((z) => z.domain), ...webroots.map((w) => w.domain).filter(Boolean)])];
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
    let name = m[1] === '@' ? '@' : m[1].replace(/\.$/, '');
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

function mariadb(file, dbName) {
  const bin = mariadbDetect().connected ? (spawnSync('sh', ['-c', 'command -v mariadb'], { encoding: 'utf8' }).stdout || '').trim() : '';
  if (!bin) return { ok: false, error: 'MariaDB nie jest dostępna' };
  const args = ['-u', config.mysql.adminUser || 'root'];
  if (config.mysql.password) args.push(`-p${config.mysql.password}`);
  if (config.mysql.socket) args.push('--socket', config.mysql.socket);
  else if (config.mysql.host) args.push('-h', config.mysql.host, '-P', String(config.mysql.port));
  args.push(dbName);
  const r = spawnSync(bin, args, { input: fs.readFileSync(file), encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, error: r.status === 0 ? '' : (r.stderr || '').trim() };
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
    for (const z of info.zones) {
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(z.domain)) { report.skipped.push(`strefa ${z.domain}`); continue; }
      let d = get('SELECT * FROM domains WHERE name = ?', z.domain);
      if (!d) {
        const r = run(`INSERT INTO domains(user_id, username, name, docroot, php_version, ssl, status, is_main, ip, created_at)
                       VALUES(?,?,?,?,?,?,?,?,?,?)`, user.id, user.username, z.domain,
          `${home}/domains/${z.domain}/public_html`, '8.2', 0, 'active', 0, get("SELECT value FROM settings WHERE key='server_ip'")?.value || '127.0.0.1', nowIso());
        createZone(r.lastInsertRowid, z.domain);
        d = get('SELECT * FROM domains WHERE id = ?', r.lastInsertRowid);
      }
      const records = parseZone(fs.readFileSync(z.file, 'utf8'));
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
      rebuildZone(z.domain);
      report.domains.push({ domain: z.domain, records: added });
      report.dns += added;
    }
    for (const w of info.webroots) {
      const domain = w.domain || info.domains[0];
      if (!domain) { report.skipped.push('katalog public_html bez domeny'); continue; }
      const d = get('SELECT * FROM domains WHERE name = ? AND user_id = ?', domain, user.id);
      if (!d) { report.skipped.push(`pliki ${domain}`); continue; }
      fs.mkdirSync(d.docroot, { recursive: true });
      fs.cpSync(w.dir, d.docroot, { recursive: true, force: true, errorOnExist: false });
      report.files += info.files.filter((f) => f.path.startsWith(w.dir)).length;
    }
    // Remaining home files go to a separate folder to avoid overwriting the panel layout.
    const importedDir = path.join(home, 'imported', path.basename(info.home || 'backup'));
    if (info.home && fs.existsSync(info.home) && !info.webroots.length) {
      fs.cpSync(info.home, importedDir, { recursive: true, force: true, errorOnExist: false });
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
    spawnSync('chown', ['-R', `${user.username}:${user.username}`, home], { encoding: 'utf8', timeout: 120000 });
    apply({ web: true, dns: true, pools: true });
    return report;
  } finally {
    fs.rmSync(extracted.dir, { recursive: true, force: true });
  }
}
