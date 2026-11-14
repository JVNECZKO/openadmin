// Real Nextcloud provisioning: official release, MariaDB, occ maintenance:install.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { config } from './config.mjs';
import { get, run, nowIso, hashPassword } from './db.mjs';
import { userHome } from './paths.mjs';
import { detect, createDatabase, createAccount, dropDatabase, dropAccount } from './mariadb.mjs';
import { encryptSecret } from './secrets.mjs';
import { findExecutable, safeExtractArchive } from './core/archive-utils.mjs';
import {
  validateAdminEmail, validateAdminPassword, validateAdminUser, validateDomain, validateInstallOptions,
  validateScheme, validateServiceUser, runAsUser, runPhpScriptWithSecrets,
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

/** Pure argv builder; secrets are kept separate and only put in a 0600 wrapper. */
export function buildNextcloudInstallInvocation({
  occPath, dbName, dbUser = dbName, dbPass, adminUser, adminPass, dataDir,
}) {
  return {
    script: occPath,
    args: [
      'maintenance:install', '--database=mysql', `--database-name=${dbName}`, `--database-user=${dbUser}`,
      '--database-host=localhost', `--admin-user=${adminUser}`, `--data-dir=${dataDir}`, '--no-interaction',
    ],
    secretArgs: [`--database-pass=${dbPass}`, `--admin-pass=${adminPass}`],
  };
}

export function buildNextcloudConfigArgs(key, value, index = null) {
  return ['config:system:set', key, ...(index === null ? [] : [String(index)]), '--value', value];
}

export function installNextcloud(options = {}) {
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
  const adminEmail = validateAdminEmail(options.adminEmail, `admin@${domain.value}`);
  if (!adminEmail.ok) return adminEmail;
  const scheme = validateScheme(options.scheme, 'https');
  if (!scheme.ok) return scheme;
  const pathCheck = validateInstallOptions({
    domain: domain.value,
    subpath: options.subpath ?? '/',
    adminUser: adminUser.value,
    adminPass: password.value,
    title: domain.value,
    adminEmail: adminEmail.value,
    locale: 'pl_PL',
    scheme: scheme.value,
  }, { defaultTitle: domain.value });
  if (!pathCheck.ok) return pathCheck;

  const maria = detect();
  if (!maria.connected) return { ok: false, code: 'MARIADB_UNAVAILABLE', error: `Nextcloud wymaga MariaDB: ${maria.error || 'brak połączenia'}` };
  const php = bin('php');
  const curl = bin('curl');
  const unzip = bin('unzip');
  if (!php || !curl || !unzip) return { ok: false, code: 'TOOL_MISSING', error: 'Brak php, curl lub unzip na serwerze' };
  const phpVersion = (spawnSync(php, ['-r', 'echo PHP_VERSION;'], { encoding: 'utf8', timeout: 15000 }).stdout || '').trim();
  const ncVersion = /^8\.[0-2]\./.test(phpVersion) ? '30.0.17' : 'latest';
  const downloadUrl = ncVersion === 'latest'
    ? 'https://download.nextcloud.com/server/releases/latest.zip'
    : `https://download.nextcloud.com/server/releases/nextcloud-${ncVersion}.zip`;
  if (pathCheck.value.subpath !== '/') return { ok: false, code: 'INVALID_PATH', error: 'Nextcloud instaluj w katalogu głównym osobnej domeny (np. cloud.twojadomena.pl), nie w podkatalogu.' };
  const home = userHome(user.username);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(home).isSymbolicLink()) return { ok: false, code: 'HOME_SYMLINK', error: 'Katalog domowy konta jest dowiązaniem symbolicznym' };
  const root = path.resolve(home, 'domains', domain.value, 'public_html');
  if (!ensureInsideHome(home, root)) return { ok: false, code: 'PATH_OUTSIDE_TENANT', error: 'Ścieżka domeny wyprowadza poza katalog konta' };
  if (fs.existsSync(root) && !fs.existsSync(path.join(root, 'occ'))) {
    const allowed = new Set(['index.html', 'index.htm', 'css', 'style.css', 'error-404.html']);
    const foreign = fs.readdirSync(root).filter((entry) => !allowed.has(entry));
    if (foreign.length) return { ok: false, code: 'TARGET_NOT_EMPTY', error: 'Katalog domeny nie jest pusty. Nextcloud zainstaluj na osobnej subdomenie (np. cloud.twojadomena.pl).' };
  }
  const dataDir = path.join(home, 'nextcloud-data', `${domain.value}-${crypto.randomBytes(3).toString('hex')}`);
  if (!ensureInsideHome(home, dataDir)) return { ok: false, code: 'PATH_OUTSIDE_TENANT', error: 'Katalog danych wyprowadza poza konto' };
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const suffix = crypto.randomBytes(3).toString('hex');
  const dbName = `${user.username}_nc_${suffix}`.slice(0, 60);
  const dbPass = crypto.randomBytes(18).toString('base64url');
  const created = createDatabase(dbName);
  if (!created.ok) return { ok: false, code: 'DATABASE_FAILED', error: `Nie można utworzyć bazy: ${created.error}` };
  const account = createAccount(dbName, dbName, dbPass);
  if (!account.ok) { dropDatabase(dbName); return { ok: false, code: 'DATABASE_USER_FAILED', error: `Nie można utworzyć użytkownika bazy: ${account.error}` }; }
  let tempZip = '';
  try {
    tempZip = path.join(config.dataDir, `nextcloud-${suffix}.zip`);
    const dl = spawnSync(curl, ['-fL', '--max-time', '600', '-o', tempZip, downloadUrl], { encoding: 'utf8', timeout: 620000 });
    if (dl.status !== 0) throw new Error(`Pobranie Nextcloud nie powiodło się: ${(dl.stderr || '').slice(0, 500)}`);
    const extracted = safeExtractArchive(tempZip, root, { kind: 'zip', merge: true, timeout: 300000 });
    if (!extracted.ok) throw new Error(`Rozpakowanie nie powiodło się: ${extracted.error} (${extracted.code})`);
    const inner = path.join(root, 'nextcloud');
    if (!fs.existsSync(path.join(inner, 'occ'))) throw new Error('Archiwum nie zawiera occ');
    for (const leftover of ['index.html', 'index.htm', 'style.css', 'css', 'error-404.html']) {
      try { fs.rmSync(path.join(root, leftover), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    for (const entry of fs.readdirSync(inner)) {
      const target = path.join(root, entry);
      if (fs.existsSync(target)) throw new Error(`Konflikt pliku w archiwum Nextcloud: ${entry}`);
      fs.renameSync(path.join(inner, entry), target);
    }
    fs.rmdirSync(inner);
    spawnSync('chown', ['-R', '--', `${user.username}:${user.username}`, root, dataDir], { encoding: 'utf8', timeout: 120000 });
    const occPath = path.join(root, 'occ');
    const invocation = buildNextcloudInstallInvocation({
      occPath, dbName, dbPass, adminUser: adminUser.value, adminPass: password.value, dataDir,
    });
    const install = runPhpScriptWithSecrets(user.username, root, invocation, { timeout: 300000 });
    if (install.status !== 0) {
      const detail = String(install.stderr || install.stdout || '').replaceAll(password.value, '[redacted]').replaceAll(dbPass, '[redacted]');
      throw new Error(`occ install: ${detail.slice(-900)}`);
    }
    const configCommands = [
      buildNextcloudConfigArgs('trusted_domains', domain.value, 1),
      buildNextcloudConfigArgs('overwrite.cli.url', `${scheme.value}://${domain.value}`),
    ];
    for (const configArgs of configCommands) {
      const r = runAsUser(user.username, php, [occPath, ...configArgs], { cwd: root, timeout: 60000 });
      if (r.status !== 0) throw new Error(`occ config: ${String(r.stderr || r.stdout || '').slice(-500)}`);
    }
    const status = runAsUser(user.username, php, [occPath, 'status', '--output=json'], { cwd: root, timeout: 60000 });
    let version = '';
    try { version = JSON.parse(status.stdout || '{}').versionstring || ''; } catch { /* ignore */ }
    run(`INSERT INTO app_installs(user_id, domain, path, type, version, db_name, admin_user, password_enc, data_dir, status, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`, user.id, domain.value, '/', 'nextcloud', version, dbName, adminUser.value, encryptSecret(password.value), dataDir, 'active', nowIso());
    run(`INSERT INTO databases(user_id, db_name, db_user, password, password_enc, size_mb, created_at) VALUES(?,?,?,?,?,?,?)`,
      user.id, dbName, dbName, hashPassword(dbPass), encryptSecret(dbPass), 0, nowIso());
    return {
      ok: true, url: `${scheme.value}://${domain.value}/`, adminUser: adminUser.value, adminPass: password.value,
      db: dbName, version: version || ncVersion, phpVersion,
    };
  } catch (error) {
    dropDatabase(dbName); dropAccount(dbName);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, code: 'INSTALL_FAILED', error: error.message };
  } finally {
    try { fs.rmSync(tempZip, { force: true }); } catch { /* ignore */ }
  }
}

export function nextcloudStatus() {
  return { php: bin('php'), curl: bin('curl'), unzip: bin('unzip'), mariadb: detect().connected };
}
