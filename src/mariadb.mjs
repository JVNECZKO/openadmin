// MariaDB / MySQL administration through the vendor client.
// Every query runs against the real server; when no server is reachable the
// callers report that state instead of pretending.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { config } from './config.mjs';

const SAFE = /^[A-Za-z0-9_]{1,64}$/;

const candidates = () => {
  const list = [];
  if (process.env.OA_MYSQL_ADMIN_USER) list.push(process.env.OA_MYSQL_ADMIN_USER);
  list.push(config.mysql.adminUser, 'root', os.userInfo().username);
  return [...new Set(list.filter(Boolean))];
};


/** MariaDB credentials never travel in argv (visible in `ps`). */
function mysqlEnv() {
  return config.mysql.password ? { ...process.env, MYSQL_PWD: config.mysql.password } : process.env;
}

function argsFor(user, extra = {}) {
  const args = ['--batch', '--skip-column-names', '--connect-timeout=3', '-u', user];
  if (config.mysql.socket) args.push('--socket', config.mysql.socket);
  else if (config.mysql.host) args.push('-h', config.mysql.host, '-P', String(config.mysql.port));
  if (extra.db) args.push(extra.db);
  return args;
}

function exec(user, sql, extra = {}) {
  const bin = which('mariadb') || which('mysql');
  if (!bin) return { ok: false, error: 'MariaDB client is not installed', rows: [], output: '' };
  const r = spawnSync(bin, [...argsFor(user, extra), '-e', sql], { encoding: 'utf8', timeout: 30000, env: mysqlEnv() });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { ok: r.status === 0, error: r.status === 0 ? '' : out.split('\n').slice(-3).join(' '), rows: (r.stdout || '').split('\n').filter(Boolean).map((l) => l.split('\t')), output: out };
}

export function which(bin) {
  const r = spawnSync('sh', ['-c', `command -v ${bin} 2>/dev/null`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

let cached = null;
/** Detect a working admin connection; result is cached for the process. */
export function detect(force = false) {
  if (cached && !force) return cached;
  const client = which('mariadb') || which('mysql');
  for (const user of candidates()) {
    const r = exec(user, 'SELECT VERSION(), CURRENT_USER()');
    if (r.ok && r.rows[0]) {
      cached = { connected: true, client, user, version: r.rows[0][0], currentUser: r.rows[0][1] || `${user}@localhost`, error: '' };
      return cached;
    }
  }
  cached = { connected: false, client, user: '', version: '', currentUser: '', error: client ? 'No MariaDB account could connect with the configured credentials' : 'MariaDB client not installed' };
  return cached;
}

export function query(sql, db) {
  const d = detect();
  if (!d.connected) return { ok: false, error: d.error, rows: [] };
  const r = exec(d.user, sql, { db });
  return { ok: r.ok, error: r.error, rows: r.rows, output: r.output };
}

export function listDatabases() {
  const r = query('SHOW DATABASES');
  if (!r.ok) return r;
  const skip = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);
  return { ok: true, rows: r.rows.map((x) => x[0]).filter((n) => !skip.has(n)) };
}

export function databaseSizes() {
  const r = query(`SELECT table_schema, ROUND(SUM(data_length + index_length) / 1024, 1)
                   FROM information_schema.tables GROUP BY table_schema`);
  if (!r.ok) return r;
  return { ok: true, map: Object.fromEntries(r.rows.map(([db, mb]) => [db, Number(mb) || 0])) };
}

export function createDatabase(name) {
  if (!SAFE.test(name)) return { ok: false, error: 'Invalid database name' };
  return query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
}

export function dropDatabase(name) {
  if (!SAFE.test(name)) return { ok: false, error: 'Invalid database name' };
  return query(`DROP DATABASE IF EXISTS \`${name}\``);
}

export function createAccount(db, user, password) {
  if (!SAFE.test(db) || !SAFE.test(user)) return { ok: false, error: 'Invalid database or user name' };
  if (!password || String(password).length < 8) return { ok: false, error: 'Password must be at least 8 characters' };
  const pw = String(password).replace(/'/g, "''");
  const steps = [
    `CREATE USER IF NOT EXISTS '${user}'@'localhost' IDENTIFIED BY '${pw}'`,
    `ALTER USER '${user}'@'localhost' IDENTIFIED BY '${pw}'`,
    `GRANT ALL PRIVILEGES ON \`${db}\`.* TO '${user}'@'localhost'`,
    'FLUSH PRIVILEGES',
  ];
  for (const sql of steps) {
    const r = query(sql);
    if (!r.ok) return r;
  }
  return { ok: true };
}

export function dropAccount(user) {
  if (!SAFE.test(user)) return { ok: false, error: 'Invalid user name' };
  return query(`DROP USER IF EXISTS '${user}'@'localhost'`);
}

export function tables(db) {
  if (!SAFE.test(db)) return { ok: false, error: 'Invalid database name' };
  const r = query(`SELECT table_name, table_rows, ROUND((data_length + index_length) / 1024, 1)
                   FROM information_schema.tables WHERE table_schema = '${db}' ORDER BY table_name`);
  return r;
}

/** Dump one database as SQL text (requires mariadb-dump). */
export function dumpDatabase(name) {
  if (!SAFE.test(name)) return { ok: false, error: 'Invalid database name', sql: '' };
  const bin = which('mariadb-dump') || which('mysqldump');
  if (!bin) return { ok: false, error: 'mariadb-dump is not installed', sql: '' };
  const d = detect();
  if (!d.connected) return { ok: false, error: d.error, sql: '' };
  const args = ['--single-transaction', '--no-tablespaces', '-u', d.user];
  if (config.mysql.socket) args.push('--socket', config.mysql.socket);
  else if (config.mysql.host) args.push('-h', config.mysql.host, '-P', String(config.mysql.port));
  args.push(name);
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024, env: mysqlEnv() });
  return { ok: r.status === 0, sql: r.stdout || '', error: r.status === 0 ? '' : (r.stderr || '').trim() };
}

export function accounts() {
  const r = query(`SELECT User, Host FROM mysql.user WHERE User NOT IN ('root', 'mariadb.sys', 'mysql') ORDER BY User`);
  return r;
}

export function status() {
  const d = detect();
  if (!d.connected) return { ...d, databases: 0 };
  const db = listDatabases();
  return { ...d, databases: db.ok ? db.rows.length : 0 };
}
