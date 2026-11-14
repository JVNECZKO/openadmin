// Real WordPress provisioning: official core, wp-cli, MariaDB database and
// wp-config. No placeholder index.php.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { config } from './config.mjs';
import { get, run, nowIso, hashPassword } from './db.mjs';
import { detect, createDatabase, createAccount, dropDatabase, dropAccount } from './mariadb.mjs';
import { encryptSecret } from './secrets.mjs';
import { userHome } from './paths.mjs';
import { systemProvider } from './providers/index.mjs';

function bin(name) {
  const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function wpCliPath() {
  const dir = path.join(config.dataDir, 'bin');
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  return path.join(dir, 'wp-cli.phar');
}

export function ensureWpCli() {
  const file = wpCliPath();
  if (fs.existsSync(file) && fs.statSync(file).size > 500000) return { ok: true, file };
  const curl = bin('curl');
  if (!curl) return { ok: false, error: 'curl is required to download wp-cli' };
  const r = spawnSync(curl, ['-fsSL', '--max-time', '120', '-o', file, 'https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar'], { encoding: 'utf8', timeout: 130000 });
  if (r.status !== 0 || !fs.existsSync(file) || fs.statSync(file).size < 500000) {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    return { ok: false, error: `wp-cli download failed: ${(r.stderr || '').trim()}` };
  }
  return { ok: true, file };
}

function wp(php, cli, args) {
  return spawnSync(php, [cli, ...args, '--allow-root'], { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
}

export function installWordPress({ user, domain, subpath = '/', title = '', adminUser = 'admin', adminPass = '', adminEmail = '', locale = 'pl_PL', scheme = 'http' }) {
  const d = get('SELECT * FROM domains WHERE name = ? AND user_id = ?', domain, user.id);
  if (!d) return { ok: false, error: 'Domena nie należy do tego konta' };
  const urlPath = '/' + String(subpath || '/').replace(/^\/+|\/+$/g, '');
  if (urlPath.includes('..')) return { ok: false, error: 'Nieprawidłowa ścieżka' };
  if (!adminPass || String(adminPass).length < 8) return { ok: false, error: 'Hasło administratora musi mieć co najmniej 8 znaków' };
  const php = bin('php');
  if (!php) return { ok: false, error: 'PHP CLI nie jest zainstalowane' };
  const maria = detect();
  if (!maria.connected) return { ok: false, error: `WordPress wymaga MariaDB: ${maria.error || 'brak połączenia'}` };
  const cli = ensureWpCli();
  if (!cli.ok) return cli;

  const root = path.join(userHome(user.username), 'domains', domain, 'public_html', urlPath);
  if (!root.startsWith(path.join(userHome(user.username), 'domains', domain, 'public_html'))) return { ok: false, error: 'Ścieżka poza katalogiem domeny' };
  fs.mkdirSync(root, { recursive: true });

  const suffix = crypto.randomBytes(3).toString('hex');
  const dbName = `${user.username}_wp_${suffix}`.slice(0, 60);
  const dbUser = dbName;
  const dbPass = crypto.randomBytes(18).toString('base64url');
  const created = createDatabase(dbName);
  if (!created.ok) return { ok: false, error: `Nie można utworzyć bazy: ${created.error}` };
  const account = createAccount(dbName, dbUser, dbPass);
  if (!account.ok) { dropDatabase(dbName); return { ok: false, error: `Nie można utworzyć użytkownika bazy: ${account.error}` }; }

  try {
    const download = wp(php, cli.file, ['core', 'download', `--path=${root}`, `--locale=${locale}`, '--force']);
    if (download.status !== 0) throw new Error(`Pobranie WordPressa nie powiodło się: ${(download.stderr || download.stdout).slice(0, 800)}`);
    const configCmd = wp(php, cli.file, ['config', 'create', `--path=${root}`, `--dbname=${dbName}`, `--dbuser=${dbUser}`, `--dbpass=${dbPass}`, '--dbhost=localhost', '--dbprefix=wp_', '--skip-check']);
    if (configCmd.status !== 0) throw new Error(`wp-config nie powstał: ${(configCmd.stderr || configCmd.stdout).slice(0, 800)}`);
    const siteTitle = String(title || domain).replace(/["\\]/g, '');
    const install = wp(php, cli.file, ['core', 'install', `--path=${root}`,
      `--url=${urlPath === '/' ? `${scheme}://${domain}/` : `${scheme}://${domain}${urlPath}/`}`,
      `--title=${siteTitle}`, `--admin_user=${adminUser}`, `--admin_password=${adminPass}`,
      `--admin_email=${adminEmail || `admin@${domain}`}`, '--skip-email']);
    if (install.status !== 0) throw new Error(`Instalacja WordPressa nie powiodła się: ${(install.stderr || install.stdout).slice(0, 800)}`);
    const version = wp(php, cli.file, ['core', 'version', `--path=${root}`]);

    try {
      const owner = user.username;
      spawnSync('chown', ['-R', `${owner}:${owner}`, root], { encoding: 'utf8', timeout: 60000 });
    } catch { /* ignore */ }

    const enc = encryptSecret(adminPass);
    run(`INSERT INTO databases(user_id, db_name, db_user, password, password_enc, size_mb, created_at) VALUES(?,?,?,?,?,?,?)`,
      user.id, dbName, dbUser, hashPassword(dbPass), encryptSecret(dbPass), 0, nowIso());
    run(`INSERT INTO wordpress(domain, path, version, db_name, admin_user, admin_password, password_enc, status, created_at)
         VALUES(?,?,?,?,?,?,?,?,?)`, domain, urlPath, (version.stdout || 'latest').trim(), dbName, adminUser, '', enc, 'active', nowIso());
    return {
      ok: true, url: urlPath === '/' ? `${scheme}://${domain}/` : `${scheme}://${domain}${urlPath}/`,
      adminUrl: urlPath === '/' ? `${scheme}://${domain}/wp-admin/` : `${scheme}://${domain}${urlPath}/wp-admin/`,
      db: dbName, adminUser, adminPass, version: (version.stdout || '').trim(),
    };
  } catch (e) {
    dropDatabase(dbName);
    dropAccount(dbUser);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, error: e.message };
  }
}

export function wordpressStatus() {
  return {
    cli: fs.existsSync(wpCliPath()) ? wpCliPath() : null,
    php: bin('php'),
    mariadb: detect().connected,
  };
}
