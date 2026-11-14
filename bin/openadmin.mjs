#!/usr/bin/env node
// OpenAdmin command line interface.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

const [command = 'help', ...rest] = process.argv.slice(2);
const args = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    args[k] = v !== undefined ? v : (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true);
  } else positional.push(a);
}

function banner() {
  console.log(`
  ${c.blue('◈ OpenAdmin')} ${c.dim('· free hosting control panel · AGPL-3.0')}
`);
}

async function load(env = {}) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const db = await import(path.join(root, 'src', 'db.mjs'));
  const auth = await import(path.join(root, 'src', 'auth.mjs'));
  const config = await import(path.join(root, 'src', 'config.mjs'));
  return { db, auth, config };
}

async function cmdStart() {
  const { start } = await import(path.join(root, 'src', 'server.mjs'));
  start();
}

async function cmdInstall() {
  banner();
  const { db, config } = await load();
  const { config: cfg, ensureDataDir } = config;
  ensureDataDir();
  db.getDb();
  const existing = db.get('SELECT COUNT(*) n FROM users');
  if (existing?.n > 0) {
    console.log(c.yellow('  Panel already installed. Use `openadmin passwd <user>` to reset a password.'));
    return;
  }
  const password = args.password || crypto.randomBytes(9).toString('base64url');
  const result = db.seedBase({
    adminUser: args.user || cfg.defaults.adminUser,
    adminPassword: password,
    serverName: cfg.defaults.serverName,
    serverIp: cfg.defaults.serverIp,
    ns1: cfg.defaults.nameserver1,
    ns2: cfg.defaults.nameserver2,
  });
  console.log(c.green('  Installation complete.'));
  console.log(`  Data directory : ${cfg.dataDir}`);
  console.log(`  Admin user     : ${args.user || cfg.defaults.adminUser}`);
  console.log(`  Admin password : ${result.password || password}`);
  console.log(`  Panel URL      : http://localhost:${cfg.port}`);
  if (args.demo) {
    db.seedDemo();
    console.log(c.dim('  Demo accounts seeded: demouser / demoreseller / demoadmin (password: demo)'));
  }
}

async function cmdPasswd() {
  const user = positional[0];
  if (!user) return fail('Usage: openadmin passwd <username> [new-password]');
  const { db } = await load();
  const row = db.get('SELECT * FROM users WHERE lower(username) = lower(?)', user);
  if (!row) return fail(`User ${user} not found`);
  const password = positional[1] || crypto.randomBytes(9).toString('base64url');
  db.run('UPDATE users SET password = ?, must_change_password = ? WHERE id = ?', db.hashPassword(password), positional[1] ? 0 : 1, row.id);
  db.audit('cli', 'admin', 'password.reset', user, 'local');
  console.log(c.green(`  Password updated for ${user}.`));
  console.log(`  New password: ${c.bold(password)}`);
}

async function cmdUserAdd() {
  const username = positional[0];
  if (!username) return fail('Usage: openadmin useradd <username> [--email a@b] [--package default] [--domain example.com]');
  const { db } = await load();
  if (db.get('SELECT id FROM users WHERE lower(username) = lower(?)', username)) return fail('User already exists');
  const pkg = db.get('SELECT * FROM packages WHERE name = ?', args.package || 'default') || db.get('SELECT * FROM packages LIMIT 1');
  const password = args.password || crypto.randomBytes(9).toString('base64url');
  const domain = String(args.domain || '').toLowerCase();
  const r = db.run(`INSERT INTO users(username, password, email, level, package, domain, created_at)
                    VALUES(?,?,?,?,?,?,?)`, username, db.hashPassword(password), args.email || '', 'user', pkg?.name || 'default', domain, db.nowIso());
  if (domain) {
    const d = db.run(`INSERT INTO domains(user_id, username, name, docroot, php_version, ssl, status, is_main, created_at)
                      VALUES(?,?,?,?,?,?,?,?,?)`, r.lastInsertRowid, username, domain, `/home/${username}/domains/${domain}/public_html`, '8.3', 1, 'active', 1, db.nowIso());
    const { createZone } = await import(path.join(root, 'src', 'features', 'domains.mjs'));
    createZone(d.lastInsertRowid, domain);
  }
  console.log(c.green(`  User ${username} created.`));
  console.log(`  Password: ${password}`);
}

async function cmdUserDel() {
  const username = positional[0];
  if (!username) return fail('Usage: openadmin userdel <username>');
  const { db } = await load();
  const row = db.get("SELECT * FROM users WHERE username = ? AND level != 'admin'", username);
  if (!row) return fail('User not found (or is an administrator)');
  db.run('DELETE FROM users WHERE id = ?', row.id);
  console.log(c.green(`  User ${username} deleted.`));
}

async function cmdLicense() {
  banner();
  const { db, config } = await load();
  const { config: cfg } = config;
  db.getDb();
  const panel = {
    edition: db.setting('license_edition', 'Community'),
    type: db.setting('license_type', 'unlimited'),
    expires: db.setting('license_expires', 'never'),
    holders: db.setting('license_holders', '0'),
    version: db.setting('panel_version', cfg.version),
  };
  console.log(`  Edition      : ${c.bold('Community (free)')}`);
  console.log(`  Type         : ${panel.type} (no account limit)`);
  console.log(`  Expires      : ${panel.expires}`);
  console.log(`  Cost         : €0.00`);
  console.log(`  License      : AGPL-3.0-or-later`);
  console.log(`  Panel version: ${panel.version}`);
  console.log(c.dim('\n  There are no paid add-ons and no feature gating in OpenAdmin.\n'));
}

async function cmdDoctor() {
  banner();
  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push(['Node.js >= 22.5', nodeMajor > 22 || (nodeMajor === 22 && Number(process.versions.node.split('.')[1]) >= 5), process.version]);
  let sqlite = false;
  try { await import('node:sqlite'); sqlite = true; } catch { sqlite = false; }
  checks.push(['node:sqlite available', sqlite, sqlite ? 'yes' : 'no']);
  const { config } = await import(path.join(root, 'src', 'config.mjs'));
  try { fs.mkdirSync(config.dataDir, { recursive: true }); checks.push(['Data directory writable', true, config.dataDir]); }
  catch (e) { checks.push(['Data directory writable', false, e.message]); }
  try { const { dbFile } = await import(path.join(root, 'src', 'db.mjs')); checks.push(['Database file', fs.existsSync(dbFile()) ? true : 'info', fs.existsSync(dbFile()) ? dbFile() : 'not initialised yet']); }
  catch (e) { checks.push(['SQLite file', false, e.message]); }
  try { const st = fs.statfsSync(config.dataDir); checks.push(['Disk free', true, `${(st.bavail * st.bsize / 1024 / 1024 / 1024).toFixed(1)} GB`]); } catch { checks.push(['Disk free', true, 'unknown']); }
  checks.push(['Panel port free', !(await isPortBusy(config.port)), String(config.port)]);
  for (const [name, ok, detail] of checks) {
    const mark = ok === true ? c.green('✓') : ok === 'info' ? c.yellow('•') : c.red('✗');
    console.log(`  ${mark} ${name.padEnd(26)} ${c.dim(detail || '')}`);
  }
  console.log('');
}

async function isPortBusy(port) {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(true));
    s.once('listening', () => s.close(() => resolve(false)));
    s.listen(port, '127.0.0.1');
  });
}

async function cmdBackup() {
  const { config } = await import(path.join(root, 'src', 'config.mjs'));
  fs.mkdirSync(path.join(config.dataDir, 'backups'), { recursive: true });
  const out = path.join(config.dataDir, 'backups', `openadmin-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`);
  const r = spawnSync('tar', ['-czf', out, '-C', config.dataDir, 'openadmin.db', 'homes'], { stdio: 'inherit' });
  if (r.status !== 0) return fail('Backup failed (is tar installed?)');
  const size = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
  console.log(c.green(`  Backup created: ${out} (${size} MB)`));
}

async function cmdApps() {
  const action = positional[0] || 'status';
  const id = positional[1];
  const { config } = await import(path.join(root, 'src', 'config.mjs'));
  const apps = await import(path.join(root, 'src', 'apps.mjs'));
  if (action === 'status') {
    const all = apps.statusAll();
    for (const st of Object.values(all)) {
      console.log(`  ${st.installed ? c.green('✓') : c.red('✗')} ${st.name.padEnd(14)} ${st.installed ? 'installed' : 'not installed'} · ${st.running ? c.green('running') + ' :' + st.port : 'stopped'}${st.missingExtensions.length ? c.yellow(' · missing PHP: ' + st.missingExtensions.join(', ')) : ''}`);
    }
    console.log(c.dim(`  Data: ${config.dataDir}/apps`));
    return;
  }
  if (!apps.APPS[id]) return fail(`Usage: openadmin apps ${action} phpmyadmin|roundcube`);
  if (action === 'install') {
    console.log(`  Installing ${apps.APPS[id].name}…`);
    const result = await apps.install(id);
    if (!result.ok) return fail(result.error);
    console.log(c.green(`  Installed ${apps.APPS[id].name} ${apps.APPS[id].version}`));
    const started = apps.start(id);
    console.log(started.ok ? c.green(`  Running on http://127.0.0.1:${apps.APPS[id].port}/`) : c.yellow('  ' + started.error));
    return;
  }
  if (action === 'start') {
    const result = apps.start(id);
    if (!result.ok) return fail(result.error);
    console.log(c.green(`  ${apps.APPS[id].name} running on port ${apps.APPS[id].port}`));
    return;
  }
  if (action === 'stop') {
    apps.stop(id);
    console.log(c.green(`  ${apps.APPS[id].name} stopped`));
    return;
  }
  return fail('Usage: openadmin apps status|install|start|stop [phpmyadmin|roundcube]');
}

async function cmdDemo() {
  const { db } = await load();
  db.getDb();
  db.seedDemo();
  console.log(c.green('  Demo data seeded.'));
  console.log('  demouser / demoreseller / demoadmin — password: demo');
}

async function cmdInfo() {
  banner();
  const { db, config } = await load();
  db.getDb();
  const counts = {
    users: db.get("SELECT COUNT(*) n FROM users WHERE level = 'user'").n,
    resellers: db.get("SELECT COUNT(*) n FROM users WHERE level = 'reseller'").n,
    domains: db.get('SELECT COUNT(*) n FROM domains').n,
    packages: db.get('SELECT COUNT(*) n FROM packages').n,
    tickets: db.get("SELECT COUNT(*) n FROM tickets WHERE status != 'closed'").n,
  };
  console.log(`  Users        : ${counts.users}`);
  console.log(`  Resellers    : ${counts.resellers}`);
  console.log(`  Domains      : ${counts.domains}`);
  console.log(`  Packages     : ${counts.packages}`);
  console.log(`  Open tickets : ${counts.tickets}`);
  console.log(`  Data dir     : ${config.config.dataDir}`);
  console.log(`  Panel port   : ${config.config.port}`);
  console.log('');
}

function fail(message) {
  console.error(c.red('  ' + message));
  process.exitCode = 1;
}

function help() {
  banner();
  console.log(`  ${c.bold('Usage')}  openadmin <command> [options]

  ${c.bold('Commands')}
    start                 Start the panel (default port 2222)
    install               Initialise the database and admin account
    info                  Show account and domain counts
    passwd <user> [pass]   Reset a panel password
    useradd <name>        Create a hosting user
    userdel <name>        Delete a hosting user
    demo                  Seed demo accounts and sample data
    apps [status|install|start|stop] [phpmyadmin|roundcube]
    license               Show license status (free & unlimited)
    backup                Create a tarball of the database and homes
    doctor                Check the runtime environment
    version               Print the version

  ${c.bold('Environment')}
    OA_PORT        Panel port (default 2222)
    OA_HOST        Bind address (default 127.0.0.1)
    OA_DATA_DIR    Data directory (default ./data)
    OA_DEMO=1      Seed demo accounts on boot
    OA_PROVIDER    sandbox (default) or linux

  ${c.dim('Documentation: docs/  ·  API: /api/v1/openapi.json')}
`);
}

const commands = {
  start: cmdStart, install: cmdInstall, passwd: cmdPasswd, useradd: cmdUserAdd, userdel: cmdUserDel,
  license: cmdLicense, doctor: cmdDoctor, backup: cmdBackup, demo: cmdDemo, info: cmdInfo, apps: cmdApps,
  version: async () => {
    const { version } = await import(path.join(root, 'package.json'), { with: { type: 'json' } });
    console.log(version);
  },
  help,
};

try {
  await (commands[command] || help)();
} catch (e) {
  console.error(c.red('  Error: ' + e.message));
  if (process.env.OA_DEBUG) console.error(e.stack);
  process.exitCode = 1;
}
