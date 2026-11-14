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
import { findExecutable } from './core/archive-utils.mjs';
import {
  validateAdminEmail, validateAdminPassword, validateAdminUser, validateDomain, validateInstallOptions,
  validateLocale, validateScheme, validateServiceUser,
} from './appcatalog.mjs';

function bin(name) {
  return findExecutable(name);
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

export function wpCliPath() {
  const dir = path.join(config.dataDir, 'bin');
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  return path.join(dir, 'wp-cli.phar');
}

export function ensureWpCli() {
  const file = wpCliPath();
  let cachedStat = null;
  try { cachedStat = fs.lstatSync(file); } catch { /* missing */ }
  if (cachedStat?.isSymbolicLink()) return { ok: false, code: 'CACHE_SYMLINK', error: 'wp-cli cache is a symbolic link' };
  if (cachedStat && !cachedStat.isFile()) return { ok: false, code: 'CACHE_NOT_FILE', error: 'wp-cli cache is not a regular file' };
  if (cachedStat && cachedStat.size > 500000) return { ok: true, file };
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  const curl = bin('curl');
  if (!curl) return { ok: false, error: 'curl is required to download wp-cli' };
  const r = spawnSync(curl, ['-fsSL', '--max-time', '120', '-o', file, 'https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar'], { encoding: 'utf8', timeout: 130000 });
  if (r.status !== 0 || !fs.existsSync(file) || fs.statSync(file).size < 500000) {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    return { ok: false, error: `wp-cli download failed: ${(r.stderr || '').trim()}` };
  }
  return { ok: true, file };
}

function wp(php, cli, args, { input } = {}) {
  return spawnSync(php, [cli, ...args, '--allow-root'], { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024, input });
}

function redact(value, secrets) {
  let text = String(value || '');
  for (const secret of secrets) {
    if (secret) text = text.replaceAll(secret, '[redacted]');
  }
  return text;
}

/** Pure builders: no secret is ever placed in the process argument list. */
export function buildWordPressConfigInvocation({ root, dbName, dbUser }) {
  return {
    args: ['config', 'create', `--path=${root}`, `--dbname=${dbName}`, `--dbuser=${dbUser}`,
      '--dbhost=localhost', '--dbprefix=wp_', '--skip-check', '--prompt=dbpass'],
    needsStdin: 'dbPass',
  };
}

export function buildWordPressInstallInvocation({ root, url, title, adminUser, adminEmail }) {
  return {
    args: ['core', 'install', `--path=${root}`, `--url=${url}`, `--title=${title}`,
      `--admin_user=${adminUser}`, `--admin_email=${adminEmail}`, '--skip-email', '--prompt=admin_password'],
    needsStdin: 'adminPass',
  };
}

export function installWordPress(options = {}) {
  const user = options.user;
  if (!user || typeof user !== 'object' || typeof user.username !== 'string') return { ok: false, code: 'INVALID_USER', error: 'Brak konta docelowego' };
  const serviceUser = validateServiceUser(user.username);
  if (!serviceUser.ok) return serviceUser;
  const domain = validateDomain(options.domain);
  if (!domain.ok) return domain;
  const d = get('SELECT * FROM domains WHERE name = ? AND user_id = ?', domain.value, user.id);
  if (!d) return { ok: false, code: 'DOMAIN_NOT_OWNED', error: 'Domena nie należy do tego konta' };
  const password = validateAdminPassword(options.adminPass);
  if (!password.ok) return password;
  const adminUser = validateAdminUser(options.adminUser);
  if (!adminUser.ok) return adminUser;
  const locale = validateLocale(options.locale);
  if (!locale.ok) return locale;
  const scheme = validateScheme(options.scheme, 'http');
  if (!scheme.ok) return scheme;
  const adminEmail = validateAdminEmail(options.adminEmail, `admin@${domain.value}`);
  if (!adminEmail.ok) return adminEmail;
  const valid = validateInstallOptions({
    domain: domain.value,
    subpath: options.subpath ?? '/',
    adminUser: adminUser.value,
    adminPass: password.value,
    title: options.title,
    adminEmail: adminEmail.value,
    locale: locale.value,
    scheme: scheme.value,
  }, { defaultTitle: domain.value });
  if (!valid.ok) return valid;
  const params = valid.value;
  const php = bin('php');
  if (!php) return { ok: false, code: 'PHP_MISSING', error: 'PHP CLI nie jest zainstalowane' };
  const maria = detect();
  if (!maria.connected) return { ok: false, code: 'MARIADB_UNAVAILABLE', error: `WordPress wymaga MariaDB: ${maria.error || 'brak połączenia'}` };
  const cli = ensureWpCli();
  if (!cli.ok) return { ...cli, code: 'WPCLI_MISSING' };

  const home = userHome(user.username);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(home).isSymbolicLink()) return { ok: false, code: 'HOME_SYMLINK', error: 'Katalog domowy konta jest dowiązaniem symbolicznym' };
  const root = path.resolve(home, 'domains', domain.value, 'public_html', params.subpath.slice(1));
  if (!ensureInsideHome(home, root)) return { ok: false, code: 'PATH_OUTSIDE_TENANT', error: 'Ścieżka poza katalogiem domeny' };
  fs.mkdirSync(root, { recursive: true });

  const suffix = crypto.randomBytes(3).toString('hex');
  const dbName = `${user.username}_wp_${suffix}`.slice(0, 60);
  const dbUser = dbName;
  const dbPass = crypto.randomBytes(18).toString('base64url');
  const created = createDatabase(dbName);
  if (!created.ok) return { ok: false, code: 'DATABASE_FAILED', error: `Nie można utworzyć bazy: ${created.error}` };
  const account = createAccount(dbName, dbUser, dbPass);
  if (!account.ok) { dropDatabase(dbName); return { ok: false, code: 'DATABASE_USER_FAILED', error: `Nie można utworzyć użytkownika bazy: ${account.error}` }; }

  const secrets = [password.value, dbPass];
  try {
    const download = wp(php, cli.file, ['core', 'download', `--path=${root}`, `--locale=${params.locale}`, '--force']);
    if (download.status !== 0) throw new Error(`Pobranie WordPressa nie powiodło się: ${redact(download.stderr || download.stdout, secrets).slice(0, 800)}`);

    const configBuild = buildWordPressConfigInvocation({ root, dbName, dbUser });
    const configCmd = wp(php, cli.file, configBuild.args, { input: `${dbPass}\n` });
    if (configCmd.status !== 0) throw new Error(`wp-config nie powstał: ${redact(configCmd.stderr || configCmd.stdout, secrets).slice(0, 800)}`);

    const url = params.subpath === '/' ? `${params.scheme}://${params.domain}/` : `${params.scheme}://${params.domain}${params.subpath}/`;
    const installBuild = buildWordPressInstallInvocation({
      root, url, title: params.title, adminUser: params.adminUser, adminEmail: params.adminEmail,
    });
    const install = wp(php, cli.file, installBuild.args, { input: `${password.value}\n` });
    if (install.status !== 0) throw new Error(`Instalacja WordPressa nie powiodła się: ${redact(install.stderr || install.stdout, secrets).slice(0, 800)}`);
    const version = wp(php, cli.file, ['core', 'version', `--path=${root}`]);

    try {
      const owner = user.username;
      spawnSync('chown', ['-R', '--', `${owner}:${owner}`, root], { encoding: 'utf8', timeout: 60000 });
    } catch { /* ignore */ }

    const enc = encryptSecret(password.value);
    run(`INSERT INTO databases(user_id, db_name, db_user, password, password_enc, size_mb, created_at) VALUES(?,?,?,?,?,?,?)`,
      user.id, dbName, dbUser, hashPassword(dbPass), encryptSecret(dbPass), 0, nowIso());
    run(`INSERT INTO wordpress(domain, path, version, db_name, admin_user, admin_password, password_enc, status, created_at)
         VALUES(?,?,?,?,?,?,?,?,?)`, params.domain, params.subpath, (version.stdout || 'latest').trim(), dbName, params.adminUser, '', enc, 'active', nowIso());
    return {
      ok: true, url, adminUrl: url + 'wp-admin/',
      db: dbName, adminUser: params.adminUser, adminPass: password.value, version: (version.stdout || '').trim(),
    };
  } catch (error) {
    dropDatabase(dbName);
    dropAccount(dbUser);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, code: 'INSTALL_FAILED', error: redact(error.message, secrets) };
  }
}

export function wordpressStatus() {
  return {
    cli: fs.existsSync(wpCliPath()) ? wpCliPath() : null,
    php: bin('php'),
    mariadb: detect().connected,
  };
}
