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

function bin(name) {
  const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function asUser(username, command, cwd, timeout = 300000) {
  const runuser = bin('runuser');
  if (runuser) return spawnSync(runuser, ['-u', username, '--', 'sh', '-c', command], { cwd, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  return spawnSync('su', ['-s', '/bin/sh', username, '-c', command], { cwd, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
}

export function installNextcloud({ user, domain, subpath = '/', adminUser = 'admin', adminPass = '', adminEmail = '', scheme = 'https' }) {
  const d = get('SELECT * FROM domains WHERE name = ? AND user_id = ?', domain, user.id);
  if (!d) return { ok: false, error: 'Domena nie należy do tego konta' };
  if (!adminPass || String(adminPass).length < 8) return { ok: false, error: 'Hasło administratora musi mieć co najmniej 8 znaków' };
  const maria = detect();
  if (!maria.connected) return { ok: false, error: `Nextcloud wymaga MariaDB: ${maria.error || 'brak połączenia'}` };
  const php = bin('php');
  const curl = bin('curl');
  const unzip = bin('unzip');
  if (!php || !curl || !unzip) return { ok: false, error: 'Brak php, curl lub unzip na serwerze' };
  const phpVersion = (spawnSync(php, ['-r', 'echo PHP_VERSION;'], { encoding: 'utf8' }).stdout || '').trim();
  const ncVersion = /^8\.[0-2]\./.test(phpVersion) ? '30.0.17' : 'latest';
  const downloadUrl = ncVersion === 'latest'
    ? 'https://download.nextcloud.com/server/releases/latest.zip'
    : `https://download.nextcloud.com/server/releases/nextcloud-${ncVersion}.zip`;
  const urlPath = '/' + String(subpath || '/').replace(/^\/+|\/+$/g, '');
  if (urlPath !== '/') return { ok: false, error: 'Nextcloud instaluj w katalogu głównym osobnej domeny (np. cloud.twojadomena.pl), nie w podkatalogu.' };
  const root = path.join(userHome(user.username), 'domains', domain, 'public_html', urlPath);
  if (fs.existsSync(root) && !fs.existsSync(path.join(root, 'occ'))) {
    const allowed = new Set(['index.html', 'index.htm', 'css', 'style.css', 'error-404.html']);
    const foreign = fs.readdirSync(root).filter((e) => !allowed.has(e));
    if (foreign.length) return { ok: false, error: 'Katalog domeny nie jest pusty. Nextcloud zainstaluj na osobnej subdomenie (np. cloud.twojadomena.pl).' };
  }
  const dataDir = path.join(userHome(user.username), 'nextcloud-data', `${domain}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const suffix = crypto.randomBytes(3).toString('hex');
  const dbName = `${user.username}_nc_${suffix}`.slice(0, 60);
  const dbPass = crypto.randomBytes(18).toString('base64url');
  const created = createDatabase(dbName);
  if (!created.ok) return { ok: false, error: `Nie można utworzyć bazy: ${created.error}` };
  const account = createAccount(dbName, dbName, dbPass);
  if (!account.ok) { dropDatabase(dbName); return { ok: false, error: `Nie można utworzyć użytkownika bazy: ${account.error}` }; }
  let tempZip = '';
  try {
    tempZip = path.join(config.dataDir, `nextcloud-${suffix}.zip`);
    const dl = spawnSync(curl, ['-fL', '--max-time', '600', '-o', tempZip, downloadUrl], { encoding: 'utf8', timeout: 620000 });
    if (dl.status !== 0) throw new Error(`Pobranie Nextcloud nie powiodło się: ${(dl.stderr || '').slice(0, 500)}`);
    const ex = spawnSync(unzip, ['-q', tempZip, '-d', root], { encoding: 'utf8', timeout: 300000 });
    if (ex.status !== 0) throw new Error(`Rozpakowanie nie powiodło się: ${(ex.stderr || '').slice(0, 500)}`);
    const inner = path.join(root, 'nextcloud');
    if (!fs.existsSync(path.join(inner, 'occ'))) throw new Error('Archiwum nie zawiera occ');
    for (const entry of fs.readdirSync(inner)) {
      fs.renameSync(path.join(inner, entry), path.join(root, entry));
    }
    fs.rmdirSync(inner);
    for (const leftover of ['index.html', 'index.htm', 'style.css', 'css']) {
      try { fs.rmSync(path.join(root, leftover), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    spawnSync('chown', ['-R', `${user.username}:${user.username}`, root, dataDir], { encoding: 'utf8', timeout: 120000 });
    const cmd = `php occ maintenance:install --database=mysql --database-name=${dbName} --database-user=${dbName} --database-pass=${JSON.stringify(dbPass)} --database-host=localhost --admin-user=${adminUser} --admin-pass=${JSON.stringify(String(adminPass))} --data-dir=${JSON.stringify(dataDir)} --no-interaction`;
    const install = asUser(user.username, cmd, root, 300000);
    if (install.status !== 0) throw new Error(`occ install: ${(install.stderr || install.stdout || '').slice(-900)}`);
    asUser(user.username, `php occ config:system:set trusted_domains 1 --value=${domain}`, root, 60000);
    asUser(user.username, `php occ config:system:set overwrite.cli.url --value=${scheme}://${domain}${urlPath === '/' ? '' : urlPath}`, root, 60000);
    const status = asUser(user.username, 'php occ status --output=json', root, 60000);
    let version = '';
    try { version = JSON.parse(status.stdout || '{}').versionstring || ''; } catch { /* ignore */ }
    run(`INSERT INTO app_installs(user_id, domain, path, type, version, db_name, admin_user, password_enc, data_dir, status, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`, user.id, domain, urlPath, 'nextcloud', version, dbName, adminUser, encryptSecret(adminPass), dataDir, 'active', nowIso());
    run(`INSERT INTO databases(user_id, db_name, db_user, password, password_enc, size_mb, created_at) VALUES(?,?,?,?,?,?,?)`,
      user.id, dbName, dbName, hashPassword(dbPass), encryptSecret(dbPass), 0, nowIso());
    return { ok: true, url: `${scheme}://${domain}${urlPath === '/' ? '' : urlPath}/`, adminUser, adminPass, db: dbName, version: version || ncVersion, phpVersion };
  } catch (e) {
    dropDatabase(dbName); dropAccount(dbName);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, error: e.message };
  } finally {
    try { fs.rmSync(tempZip, { force: true }); } catch { /* ignore */ }
  }
}

export function nextcloudStatus() {
  return { php: bin('php'), curl: bin('curl'), unzip: bin('unzip'), mariadb: detect().connected };
}
