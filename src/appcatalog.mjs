// Additional one-click applications: Joomla, Drupal, PrestaShop, Moodle.
// Downloads official releases, provisions MariaDB, and runs a CLI installer
// where the project ships one; otherwise leaves a working web installer and
// says so explicitly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { config } from './config.mjs';
import { all, get, run, nowIso, hashPassword } from './db.mjs';
import { detect, createDatabase, createAccount, dropDatabase, dropAccount } from './mariadb.mjs';
import { encryptSecret } from './secrets.mjs';
import { userHome } from './paths.mjs';
import { findExecutable, safeExtractArchive } from './core/archive-utils.mjs';

export const APPS = {
  joomla: {
    name: 'Joomla', version: '5.2.2', url: 'https://downloads.joomla.org/cms/joomla5/5-2-2/Joomla_5-2-2-Stable-Full_Package.zip',
    kind: 'zip', installer: '/installation/index.php', mode: 'web', description: 'CMS / portal',
  },
  drupal: {
    name: 'Drupal', version: '11.1.0', url: 'https://ftp.drupal.org/files/projects/drupal-11.1.0.tar.gz',
    kind: 'tgz', installer: '/core/install.php', mode: 'web', description: 'CMS / portal',
  },
  prestashop: {
    name: 'PrestaShop', version: '8.2.1', url: 'https://github.com/PrestaShop/PrestaShop/releases/download/8.2.1/prestashop_8.2.1.zip',
    kind: 'zip', installer: '/install/', mode: 'web', description: 'Sklep e-commerce',
  },
  moodle: {
    name: 'Moodle', version: '4.5', url: 'https://download.moodle.org/download.php/direct/stable405/moodle-latest-405.tgz',
    kind: 'tgz', installer: '/install.php', mode: 'cli', cli: 'admin/cli/install.php', description: 'Platforma e-learning',
  },
};

export function listApps() {
  return Object.entries(APPS).map(([key, a]) => ({ key, ...a }));
}

export function installedApps(userId) {
  return all("SELECT * FROM app_installs WHERE user_id = ? AND type IN ('joomla','drupal','prestashop','moodle') ORDER BY id DESC", userId);
}

/* ------------------------------------------------------------- validation */
// SEC-003: every value that ends up in an installer is validated by type,
// length and format. Passwords/titles may contain metacharacters; they are
// never interpreted by a shell because every process is started with argv.

const SERVICE_USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const ADMIN_USER_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOCALE_RE = /^[a-z]{2,3}_[A-Z]{2}$/;
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function invalid(code, field, error) {
  return { ok: false, code, field, error };
}

export function validateServiceUser(value) {
  if (typeof value !== 'string' || !SERVICE_USER_RE.test(value)) return invalid('INVALID_SERVICE_USER', 'user', 'Nieprawidłowy użytkownik systemowy');
  return { ok: true, value };
}

export function validateDomain(value) {
  if (typeof value !== 'string') return invalid('INVALID_DOMAIN', 'domain', 'Domena musi być tekstem');
  const domain = value.trim().toLowerCase();
  if (!domain || domain.length > 253 || !DOMAIN_RE.test(domain)) return invalid('INVALID_DOMAIN', 'domain', 'Nieprawidłowa nazwa domeny');
  return { ok: true, value: domain };
}

export function validateAdminUser(value) {
  const adminUser = value === undefined || value === null || value === '' ? 'admin' : value;
  if (typeof adminUser !== 'string') return invalid('INVALID_ADMIN_USER', 'adminUser', 'Login administratora musi być tekstem');
  const trimmed = adminUser.trim();
  if (!ADMIN_USER_RE.test(trimmed)) return invalid('INVALID_ADMIN_USER', 'adminUser', 'Login administratora może zawierać litery, cyfry, kropkę, myślnik, podkreślenie i @ (1–64 znaki)');
  return { ok: true, value: trimmed };
}

export function validateAdminPassword(value) {
  if (typeof value !== 'string') return invalid('INVALID_PASSWORD', 'adminPass', 'Hasło administratora musi być tekstem');
  if (value.length < 8) return invalid('WEAK_PASSWORD', 'adminPass', 'Hasło administratora musi mieć co najmniej 8 znaków');
  if (value.length > 128) return invalid('PASSWORD_TOO_LONG', 'adminPass', 'Hasło administratora może mieć maksymalnie 128 znaków');
  if (/[\0\r\n]/.test(value)) return invalid('INVALID_PASSWORD', 'adminPass', 'Hasło administratora zawiera niedozwolone znaki sterujące');
  return { ok: true, value };
}

export function validateInstallPath(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: '/' };
  if (typeof value !== 'string') return invalid('INVALID_PATH', 'path', 'Ścieżka instalacji musi być tekstem');
  const raw = value.trim();
  if (raw.length > 200) return invalid('INVALID_PATH', 'path', 'Ścieżka instalacji jest zbyt długa');
  if (/[\0\r\n%\\]/.test(raw)) return invalid('INVALID_PATH', 'path', 'Ścieżka instalacji zawiera niedozwolone znaki');
  const rel = raw.replace(/^\/+|\/+$/g, '');
  if (!rel) return { ok: true, value: '/' };
  const parts = rel.split('/');
  if (parts.some((part) => part === '.' || part === '..' || part.length > 64 || !SEGMENT_RE.test(part))) {
    return invalid('INVALID_PATH', 'path', 'Nieprawidłowa ścieżka instalacji (bez „..”, znaków specjalnych i pustych segmentów)');
  }
  return { ok: true, value: '/' + parts.join('/') };
}

export function validateTitle(value, fallback = '') {
  const title = value === undefined || value === null || value === '' ? fallback : value;
  if (typeof title !== 'string') return invalid('INVALID_TITLE', 'title', 'Tytuł musi być tekstem');
  const trimmed = title.trim();
  if (!trimmed) return invalid('INVALID_TITLE', 'title', 'Tytuł nie może być pusty');
  if (trimmed.length > 120) return invalid('INVALID_TITLE', 'title', 'Tytuł może mieć maksymalnie 120 znaków');
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return invalid('INVALID_TITLE', 'title', 'Tytuł zawiera niedozwolone znaki sterujące');
  return { ok: true, value: trimmed };
}

export function validateAdminEmail(value, fallback = '') {
  const email = value === undefined || value === null || value === '' ? fallback : value;
  if (typeof email !== 'string') return invalid('INVALID_EMAIL', 'adminEmail', 'Adres e-mail musi być tekstem');
  const trimmed = email.trim();
  if (!trimmed || trimmed.length > 254 || !EMAIL_RE.test(trimmed)) return invalid('INVALID_EMAIL', 'adminEmail', 'Nieprawidłowy adres e-mail administratora');
  return { ok: true, value: trimmed };
}

export function validateLocale(value) {
  const locale = value === undefined || value === null || value === '' ? 'pl_PL' : value;
  if (typeof locale !== 'string' || !LOCALE_RE.test(locale)) return invalid('INVALID_LOCALE', 'locale', 'Nieprawidłowy kod języka');
  return { ok: true, value: locale };
}

export function validateScheme(value, fallback = 'https') {
  const scheme = value === undefined || value === null || value === '' ? fallback : value;
  if (scheme !== 'http' && scheme !== 'https') return invalid('INVALID_SCHEME', 'scheme', 'Nieprawidłowy schemat adresu');
  return { ok: true, value: scheme };
}

export function validateInstallOptions(input = {}, { defaultTitle = '' } = {}) {
  const domain = validateDomain(input.domain);
  if (!domain.ok) return domain;
  const subpath = validateInstallPath(input.subpath ?? '/');
  if (!subpath.ok) return subpath;
  const adminUser = validateAdminUser(input.adminUser);
  if (!adminUser.ok) return adminUser;
  const adminPass = validateAdminPassword(input.adminPass);
  if (!adminPass.ok) return adminPass;
  const title = validateTitle(input.title, defaultTitle || domain.value);
  if (!title.ok) return title;
  const adminEmail = validateAdminEmail(input.adminEmail, `admin@${domain.value}`);
  if (!adminEmail.ok) return adminEmail;
  const locale = validateLocale(input.locale);
  if (!locale.ok) return locale;
  const scheme = validateScheme(input.scheme);
  if (!scheme.ok) return scheme;
  return {
    ok: true,
    value: {
      domain: domain.value,
      subpath: subpath.value,
      adminUser: adminUser.value,
      adminPass: adminPass.value,
      title: title.value,
      adminEmail: adminEmail.value,
      locale: locale.value,
      scheme: scheme.value,
    },
  };
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

/* ----------------------------------------------------------- process exec */
// No `sh -c` anywhere: commands are always spawned with an argv array.

export function runAsUser(username, command, args, { cwd, timeout = 300000, input } = {}) {
  if (typeof username !== 'string' || !SERVICE_USER_RE.test(username)) {
    return { status: null, stdout: '', stderr: 'Nieprawidłowy użytkownik systemowy', error: 'INVALID_SERVICE_USER' };
  }
  if (!path.isAbsolute(command)) {
    const resolved = findExecutable(command);
    if (!resolved) return { status: null, stdout: '', stderr: `Brak programu ${command}`, error: 'TOOL_MISSING' };
    command = resolved;
  }
  if (config.provider !== 'linux') return { status: 0, stdout: 'sandbox', stderr: '', simulated: true };
  const options = { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, input };
  const runuser = findExecutable('runuser');
  if (runuser) {
    return spawnSync(runuser, ['-u', username, '--', command, ...args], { ...options, cwd });
  }
  const uidResult = spawnSync('id', ['-u', username], { encoding: 'utf8', timeout: 10000 });
  const gidResult = spawnSync('id', ['-g', username], { encoding: 'utf8', timeout: 10000 });
  const uid = Number.parseInt(String(uidResult.stdout || '').trim(), 10);
  const gid = Number.parseInt(String(gidResult.stdout || '').trim(), 10);
  if (uidResult.status !== 0 || gidResult.status !== 0 || !Number.isInteger(uid) || !Number.isInteger(gid)) {
    return { status: null, stdout: '', stderr: `Nie można ustalić konta ${username}`, error: 'USER_LOOKUP_FAILED' };
  }
  return spawnSync(command, args, { ...options, cwd, uid, gid });
}

function userIds(username) {
  const uidResult = spawnSync('id', ['-u', username], { encoding: 'utf8', timeout: 10000 });
  const gidResult = spawnSync('id', ['-g', username], { encoding: 'utf8', timeout: 10000 });
  const uid = Number.parseInt(String(uidResult.stdout || '').trim(), 10);
  const gid = Number.parseInt(String(gidResult.stdout || '').trim(), 10);
  if (uidResult.status !== 0 || gidResult.status !== 0 || !Number.isInteger(uid) || !Number.isInteger(gid)) return null;
  return { uid, gid };
}

function phpString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Render a PHP wrapper that supplies argv without putting secrets in `ps`. */
export function renderPhpArgvWrapper({ scriptPath, argv }) {
  if (typeof scriptPath !== 'string' || !path.isAbsolute(scriptPath)) throw new Error('Wrapper script path must be absolute');
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string')) throw new Error('Wrapper argv must be an array of strings');
  const lines = argv.map((arg) => `  ${phpString(arg)},`).join('\n');
  return `<?php\n$argv = array(\n${lines}\n);\n$argc = count($argv);\n$_SERVER['argv'] = $argv;\n$_SERVER['argc'] = $argc;\nrequire ${phpString(scriptPath)};\n`;
}

/**
 * Run a PHP script as the tenant user. Secret arguments are placed in a
 * 0600 wrapper file owned by that user, never in the process argument list.
 */
export function runPhpScriptWithSecrets(username, cwd, { script, args = [], secretArgs = [] }, { timeout = 600000 } = {}) {
  const serviceUser = validateServiceUser(username);
  if (!serviceUser.ok) return { status: null, stdout: '', stderr: serviceUser.error, error: serviceUser.code };
  if (typeof script !== 'string' || !script) return { status: null, stdout: '', stderr: 'Brak skryptu instalatora', error: 'INVALID_SCRIPT' };
  if (!Array.isArray(args) || !Array.isArray(secretArgs)) return { status: null, stdout: '', stderr: 'Nieprawidłowe argumenty', error: 'INVALID_ARGS' };
  if (config.provider !== 'linux') return { status: 0, stdout: 'sandbox', stderr: '', simulated: true };
  const php = findExecutable('php');
  if (!php) return { status: null, stdout: '', stderr: 'PHP CLI nie jest zainstalowane', error: 'TOOL_MISSING' };
  const ids = userIds(username);
  if (!ids) return { status: null, stdout: '', stderr: 'Nie można ustalić konta użytkownika', error: 'USER_LOOKUP_FAILED' };
  const scriptPath = path.isAbsolute(script) ? script : path.resolve(cwd, script);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openadmin-php-'));
  try {
    fs.chmodSync(dir, 0o700);
    try { fs.chownSync(dir, ids.uid, ids.gid); } catch { /* non-root execution */ }
    const wrapper = path.join(dir, 'installer.php');
    fs.writeFileSync(wrapper, renderPhpArgvWrapper({ scriptPath, argv: [scriptPath, ...args, ...secretArgs] }), { mode: 0o600 });
    try { fs.chownSync(wrapper, ids.uid, ids.gid); } catch { /* non-root execution */ }
    return runAsUser(username, php, [wrapper], { cwd, timeout });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* --------------------------------------------------------- CLI invocations */
export function buildMoodleInvocation({
  wwwroot, dataDir, dbName, dbUser = dbName, dbPass, title, domain, adminUser, adminPass, adminEmail,
}) {
  return {
    script: 'admin/cli/install.php',
    args: [
      `--wwwroot=${wwwroot}`, `--dataroot=${dataDir}`, '--dbtype=mariadb', '--dbhost=localhost',
      `--dbname=${dbName}`, `--dbuser=${dbUser}`,
      `--fullname=${title}`, `--shortname=${String(domain).split('.')[0]}`,
      `--adminuser=${adminUser}`, `--adminemail=${adminEmail}`,
      '--non-interactive', '--agree-license',
    ],
    secretArgs: [`--dbpass=${dbPass}`, `--adminpass=${adminPass}`],
  };
}

export function buildPrestashopInvocation({
  domain, dbName, dbUser = dbName, dbPass, title, adminUser, adminPass, adminEmail,
}) {
  return {
    script: 'install-dev/index_cli.php',
    args: [
      `--domain=${domain}`, '--db_server=localhost', `--db_name=${dbName}`, `--db_user=${dbUser}`,
      `--name=${title}`, `--email=${adminEmail}`, '--language=pl', '--country=PL', '--newsletter=0',
      '--allow_unsigned_modules=1',
    ],
    secretArgs: [`--db_password=${dbPass}`, `--password=${adminPass}`],
  };
}

/* --------------------------------------------------------------- install */
function download(app) {
  const cache = path.join(config.dataDir, 'appcache');
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const ext = app.kind === 'zip' ? 'zip' : 'tgz';
  const file = path.join(cache, `${app.name.toLowerCase()}-${app.version}.${ext}`);
  let cachedStat = null;
  try { cachedStat = fs.lstatSync(file); } catch { /* missing */ }
  if (cachedStat?.isSymbolicLink()) return { ok: false, code: 'CACHE_SYMLINK', error: 'Plik cache aplikacji jest dowiązaniem symbolicznym' };
  if (cachedStat && !cachedStat.isFile()) return { ok: false, code: 'CACHE_NOT_FILE', error: 'Plik cache aplikacji nie jest zwykłym plikiem' };
  if (cachedStat && cachedStat.size > 1000000) return { ok: true, file, cached: true };
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  const curl = findExecutable('curl');
  if (!curl) return { ok: false, error: 'Brak curl' };
  if (typeof app.url !== 'string' || !/^https:\/\//.test(app.url)) return { ok: false, error: 'Nieprawidłowy adres wydania' };
  const r = spawnSync(curl, ['-fL', '--max-time', '600', '-o', file, app.url], { encoding: 'utf8', timeout: 620000 });
  if (r.status !== 0) return { ok: false, error: `Pobranie ${app.name} nie powiodło się: ${(r.stderr || '').slice(0, 400)}` };
  return { ok: true, file, cached: false };
}

function extract(app, file, root) {
  fs.mkdirSync(root, { recursive: true });
  const extracted = safeExtractArchive(file, root, {
    kind: app.kind === 'zip' ? 'zip' : 'tar',
    merge: true,
    timeout: 300000,
  });
  if (!extracted.ok) return { ok: false, error: `${extracted.error}${extracted.code ? ` (${extracted.code})` : ''}`, code: extracted.code };
  // Releases are often wrapped in one top-level directory. Pre-existing
  // domain placeholders (index.html/css) must not defeat that flattening.
  const topLevel = new Set(extracted.entries.map((entry) => entry.path.split('/')[0]).filter((name) => name && !name.startsWith('._')));
  if (topLevel.size === 1) {
    const only = [...topLevel][0];
    const nested = path.join(root, only);
    let nestedStat = null;
    try { nestedStat = fs.lstatSync(nested); } catch { /* no nested dir */ }
    if (nestedStat?.isDirectory() && !nestedStat.isSymbolicLink()) {
      const placeholders = new Set(['index.html', 'index.htm', 'css', 'style.css', 'error-404.html']);
      for (const entry of fs.readdirSync(nested)) {
        const target = path.join(root, entry);
        if (fs.existsSync(target)) {
          if (!placeholders.has(entry)) return { ok: false, error: `Konflikt pliku w archiwum: ${entry}` };
          const existing = fs.lstatSync(target);
          if (existing.isSymbolicLink()) return { ok: false, error: `Konflikt pliku w archiwum: ${entry}` };
          fs.rmSync(target, { recursive: existing.isDirectory(), force: true });
        }
        fs.renameSync(path.join(nested, entry), target);
      }
      fs.rmdirSync(nested);
    }
  }
  return { ok: true };
}

export function installApp(key, options = {}) {
  const app = APPS[key];
  if (!app) return { ok: false, code: 'UNKNOWN_APP', error: 'Nieznana aplikacja' };
  const user = options.user;
  if (!user || typeof user !== 'object' || typeof user.username !== 'string') return { ok: false, code: 'INVALID_USER', error: 'Brak konta docelowego' };
  const serviceUser = validateServiceUser(user.username);
  if (!serviceUser.ok) return serviceUser;
  const domain = validateDomain(options.domain);
  if (!domain.ok) return domain;
  const d = get('SELECT * FROM domains WHERE name = ? AND user_id = ?', domain.value, user.id);
  if (!d) return { ok: false, code: 'DOMAIN_NOT_OWNED', error: 'Domena nie należy do tego konta' };
  const valid = validateInstallOptions({ ...options, domain: domain.value }, { defaultTitle: d.name });
  if (!valid.ok) return valid;
  const params = valid.value;
  if (!detect().connected) return { ok: false, code: 'MARIADB_UNAVAILABLE', error: 'MariaDB nie jest dostępna' };
  if (!findExecutable('php')) return { ok: false, code: 'PHP_MISSING', error: 'Brak PHP CLI' };

  const home = userHome(user.username);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(home).isSymbolicLink()) return { ok: false, code: 'HOME_SYMLINK', error: 'Katalog domowy konta jest dowiązaniem symbolicznym' };
  const root = path.resolve(home, 'domains', d.name, 'public_html', params.subpath.slice(1));
  if (!ensureInsideHome(home, root)) return { ok: false, code: 'PATH_OUTSIDE_TENANT', error: 'Ścieżka instalacji wyprowadza poza katalog domeny' };
  if (fs.existsSync(root) && fs.readdirSync(root).filter((x) => !['index.html', 'css'].includes(x)).length) {
    return { ok: false, code: 'TARGET_NOT_EMPTY', error: 'Katalog docelowy nie jest pusty' };
  }
  fs.mkdirSync(root, { recursive: true });
  const suffix = crypto.randomBytes(3).toString('hex');
  const dbName = `${user.username}_${key.slice(0, 3)}_${suffix}`.slice(0, 60);
  const dbPass = crypto.randomBytes(18).toString('base64url');
  const db = createDatabase(dbName);
  if (!db.ok) return { ok: false, code: 'DATABASE_FAILED', error: db.error };
  const account = createAccount(dbName, dbName, dbPass);
  if (!account.ok) { dropDatabase(dbName); return { ok: false, code: 'DATABASE_USER_FAILED', error: account.error }; }
  const dl = download(app);
  if (!dl.ok) { dropDatabase(dbName); dropAccount(dbName); return dl; }
  const ext = extract(app, dl.file, root);
  if (!ext.ok) { dropDatabase(dbName); dropAccount(dbName); return ext; }
  spawnSync('chown', ['-R', '--', `${user.username}:${user.username}`, root], { timeout: 120000 });

  let mode = app.mode;
  let warning = '';
  let dataDir = null;
  if (app.mode === 'cli') {
    dataDir = path.join(home, `appdata-${key}-${suffix}`);
    fs.mkdirSync(dataDir, { recursive: true });
    spawnSync('chown', ['-R', '--', `${user.username}:${user.username}`, dataDir], { timeout: 60000 });
    const wwwroot = `${params.scheme}://${params.domain}${params.subpath === '/' ? '' : params.subpath}`;
    let invocation;
    if (key === 'moodle') {
      invocation = buildMoodleInvocation({
        wwwroot, dataDir, dbName, dbPass, title: params.title, domain: params.domain,
        adminUser: params.adminUser, adminPass: params.adminPass, adminEmail: params.adminEmail,
      });
    } else if (key === 'prestashop') {
      invocation = buildPrestashopInvocation({
        domain: params.domain, dbName, dbPass, title: params.title,
        adminUser: params.adminUser, adminPass: params.adminPass, adminEmail: params.adminEmail,
      });
    }
    if (invocation) {
      const r = runPhpScriptWithSecrets(user.username, root, invocation, { timeout: 600000 });
      if (r.status !== 0) {
        mode = 'web';
        warning = `${app.name}: CLI installer nie powiódł się (${String(r.stderr || r.stdout || '').replaceAll(params.adminPass, '[redacted]').replaceAll(dbPass, '[redacted]').slice(-500)}). Dokończ w przeglądarce: ${app.installer}`;
      }
    }
  }
  run(`INSERT INTO app_installs(user_id, domain, path, type, version, db_name, admin_user, password_enc, data_dir, status, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`, user.id, params.domain, params.subpath, key, app.version, dbName, params.adminUser, encryptSecret(params.adminPass), dataDir, mode === 'cli' ? 'active' : 'web-installer', nowIso());
  run('INSERT INTO databases(user_id, db_name, db_user, password, password_enc, size_mb, created_at) VALUES(?,?,?,?,?,?,?)', user.id, dbName, dbName, hashPassword(dbPass), encryptSecret(dbPass), 0, nowIso());
  return {
    ok: true, mode, warning,
    url: `${params.scheme}://${params.domain}${params.subpath === '/' ? '' : params.subpath}${mode === 'cli' ? '/' : app.installer}`,
    db: dbName, dbUser: dbName, dbPass, adminUser: params.adminUser, adminPass: params.adminPass, version: app.version,
  };
}

export function deleteApp(id, user) {
  const row = get('SELECT * FROM app_installs WHERE id = ? AND user_id = ?', Number(id), user.id);
  if (!row) return { ok: false, error: 'Not found' };
  if (row.type === 'nextcloud') return { ok: false, error: 'Use the Nextcloud delete action' };
  dropDatabase(row.db_name); dropAccount(row.db_name);
  run('DELETE FROM databases WHERE db_name = ?', row.db_name);
  const home = userHome(user.username);
  const root = path.resolve(home, 'domains', row.domain, 'public_html', row.path === '/' ? '' : row.path);
  if (ensureInsideHome(home, root)) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (row.data_dir) {
    const resolvedData = path.resolve(row.data_dir);
    if (resolvedData === path.resolve(home) || resolvedData.startsWith(path.resolve(home) + path.sep)) {
      try { fs.rmSync(resolvedData, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  run('DELETE FROM app_installs WHERE id = ?', row.id);
  return { ok: true };
}
