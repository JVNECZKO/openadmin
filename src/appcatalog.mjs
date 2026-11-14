// Additional one-click applications: Joomla, Drupal, PrestaShop, Moodle.
// Downloads official releases, provisions MariaDB, and runs a CLI installer
// where the project ships one; otherwise leaves a working web installer and
// says so explicitly.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { config } from './config.mjs';
import { all, get, run, nowIso, hashPassword } from './db.mjs';
import { detect, createDatabase, createAccount, dropDatabase, dropAccount } from './mariadb.mjs';
import { encryptSecret } from './secrets.mjs';
import { userHome } from './paths.mjs';
import { which } from './sys.mjs';

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

function download(app) {
  const cache = path.join(config.dataDir, 'appcache');
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const ext = app.kind === 'zip' ? 'zip' : 'tgz';
  const file = path.join(cache, `${app.name.toLowerCase()}-${app.version}.${ext}`);
  if (fs.existsSync(file) && fs.statSync(file).size > 1000000) return { ok: true, file, cached: true };
  const curl = which('curl');
  if (!curl) return { ok: false, error: 'Brak curl' };
  const r = spawnSync(curl, ['-fL', '--max-time', '600', '-o', file, app.url], { encoding: 'utf8', timeout: 620000 });
  if (r.status !== 0) return { ok: false, error: `Pobranie ${app.name} nie powiodło się: ${(r.stderr || '').slice(0, 400)}` };
  return { ok: true, file, cached: false };
}

function extract(app, file, root) {
  fs.mkdirSync(root, { recursive: true });
  if (app.kind === 'zip') {
    const unzip = which('unzip');
    if (!unzip) return { ok: false, error: 'Brak unzip' };
    const r = spawnSync(unzip, ['-q', file, '-d', root], { encoding: 'utf8', timeout: 300000 });
    if (r.status !== 0) return { ok: false, error: `Rozpakowanie: ${(r.stderr || '').slice(0, 300)}` };
  } else {
    const r = spawnSync('tar', ['-xzf', file, '-C', root], { encoding: 'utf8', timeout: 300000 });
    if (r.status !== 0) return { ok: false, error: `Rozpakowanie: ${(r.stderr || '').slice(0, 300)}` };
  }
  const entries = fs.readdirSync(root);
  if (entries.length === 1 && fs.statSync(path.join(root, entries[0])).isDirectory()) {
    const nested = path.join(root, entries[0]);
    for (const e of fs.readdirSync(nested)) fs.renameSync(path.join(nested, e), path.join(root, e));
    fs.rmdirSync(nested);
  }
  return { ok: true };
}

function asUser(username, cmd, cwd, timeout = 600000) {
  if (config.provider !== 'linux') return { status: 0, stdout: 'sandbox', stderr: '' };
  if (which('runuser')) return spawnSync('runuser', ['-u', username, '--', 'sh', '-c', cmd], { cwd, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  return spawnSync('su', ['-s', '/bin/sh', username, '-c', cmd], { cwd, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
}

export function installApp(key, { user, domain, subpath = '/', adminUser = 'admin', adminPass = '', title = '' }) {
  const app = APPS[key];
  if (!app) return { ok: false, error: 'Nieznana aplikacja' };
  const d = get('SELECT * FROM domains WHERE name = ? AND user_id = ?', domain, user.id);
  if (!d) return { ok: false, error: 'Domena nie należy do tego konta' };
  if (!adminPass || String(adminPass).length < 8) return { ok: false, error: 'Hasło administratora musi mieć co najmniej 8 znaków' };
  if (!detect().connected) return { ok: false, error: 'MariaDB nie jest dostępna' };
  if (!which('php')) return { ok: false, error: 'Brak PHP CLI' };
  const rel = String(subpath || '/').replace(/^\/+|\/+$/g, '');
  const urlPath = '/' + rel;
  const root = path.join(userHome(user.username), 'domains', d.name, 'public_html', urlPath);
  if (fs.existsSync(root) && fs.readdirSync(root).filter((x) => !['index.html', 'css'].includes(x)).length) return { ok: false, error: 'Katalog docelowy nie jest pusty' };
  fs.mkdirSync(root, { recursive: true });
  const suffix = crypto.randomBytes(3).toString('hex');
  const dbName = `${user.username}_${key.slice(0, 3)}_${suffix}`.slice(0, 60);
  const dbPass = crypto.randomBytes(18).toString('base64url');
  const db = createDatabase(dbName);
  if (!db.ok) return { ok: false, error: db.error };
  const account = createAccount(dbName, dbName, dbPass);
  if (!account.ok) { dropDatabase(dbName); return { ok: false, error: account.error }; }
  const dl = download(app);
  if (!dl.ok) { dropDatabase(dbName); dropAccount(dbName); return dl; }
  const ext = extract(app, dl.file, root);
  if (!ext.ok) { dropDatabase(dbName); dropAccount(dbName); return ext; }
  spawnSync('chown', ['-R', `${user.username}:${user.username}`, root], { timeout: 120000 });
  let mode = app.mode;
  let warning = '';
  let dataDir = null;
  if (app.mode === 'cli') {
    dataDir = path.join(userHome(user.username), `appdata-${key}-${suffix}`);
    fs.mkdirSync(dataDir, { recursive: true });
    spawnSync('chown', ['-R', `${user.username}:${user.username}`, dataDir], { timeout: 60000 });
    let cmd;
    if (key === 'moodle') {
      cmd = `php admin/cli/install.php --wwwroot=${JSON.stringify(`https://${domain}${urlPath === '/' ? '' : urlPath}`)} --dataroot=${JSON.stringify(dataDir)} --dbtype=mariadb --dbhost=localhost --dbname=${dbName} --dbuser=${dbName} --dbpass=${JSON.stringify(dbPass)} --fullname=${JSON.stringify(title || domain)} --shortname=${JSON.stringify(domain.split('.')[0])} --adminuser=${adminUser} --adminpass=${JSON.stringify(String(adminPass))} --adminemail=${JSON.stringify(`${adminUser}@${domain}`)} --non-interactive --agree-license`;
    } else if (key === 'prestashop') {
      cmd = `php install-dev/index_cli.php --domain=${domain} --db_server=localhost --db_name=${dbName} --db_user=${dbName} --db_password=${JSON.stringify(dbPass)} --name=${JSON.stringify(title || domain)} --email=${JSON.stringify(`${adminUser}@${domain}`)} --password=${JSON.stringify(String(adminPass))} --language=pl --country=PL --newsletter=0 --allow_unsigned_modules=1`;
    }
    const r = asUser(user.username, cmd, root);
    if (r.status !== 0) { mode = 'web'; warning = `${app.name}: CLI installer nie powiódł się (${(r.stderr || r.stdout || '').slice(-500)}). Dokończ w przeglądarce: ${app.installer}`; }
  }
  run(`INSERT INTO app_installs(user_id, domain, path, type, version, db_name, admin_user, password_enc, data_dir, status, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`, user.id, domain, urlPath, key, app.version, dbName, adminUser, encryptSecret(adminPass), dataDir, mode === 'cli' ? 'active' : 'web-installer', nowIso());
  run('INSERT INTO databases(user_id, db_name, db_user, password, password_enc, size_mb, created_at) VALUES(?,?,?,?,?,?,?)', user.id, dbName, dbName, hashPassword(dbPass), encryptSecret(dbPass), 0, nowIso());
  return { ok: true, mode, warning, url: `https://${domain}${urlPath === '/' ? '' : urlPath}${mode === 'cli' ? '/' : app.installer}`, db: dbName, dbUser: dbName, dbPass, adminUser, adminPass, version: app.version };
}

export function deleteApp(id, user) {
  const row = get('SELECT * FROM app_installs WHERE id = ? AND user_id = ?', Number(id), user.id);
  if (!row) return { ok: false, error: 'Not found' };
  if (row.type === 'nextcloud') return { ok: false, error: 'Use the Nextcloud delete action' };
  dropDatabase(row.db_name); dropAccount(row.db_name);
  run('DELETE FROM databases WHERE db_name = ?', row.db_name);
  const root = path.join(userHome(user.username), 'domains', row.domain, 'public_html', row.path === '/' ? '' : row.path);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  if (row.data_dir) { try { fs.rmSync(row.data_dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  run('DELETE FROM app_installs WHERE id = ?', row.id);
  return { ok: true };
}
