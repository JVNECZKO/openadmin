// PostgreSQL database management (optional service).
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { config } from './config.mjs';
import { all, get, run, nowIso, setting, audit } from './db.mjs';
import { encryptSecret } from './secrets.mjs';
import { which, sh, isRoot } from './sys.mjs';

export function status() {
  const bin = which('psql');
  const ready = bin ? sh('pg_isready', ['-q'], { timeout: 5000 }).ok : false;
  return { installed: !!bin, ready, version: bin ? sh('psql', ['--version']).stdout : '', simulated: config.provider !== 'linux' };
}

function psql(sql) {
  if (config.provider !== 'linux') return { ok: true, stdout: '', simulated: true };
  const r = sh('runuser', ['-u', 'postgres', '--', 'psql', '-v', 'ON_ERROR_STOP=1', '-tAc', sql], { timeout: 30000 });
  return { ok: r.ok, stdout: r.stdout, error: r.stderr || r.error };
}

export function list() {
  return all('SELECT d.*, u.username FROM postgres_databases d JOIN users u ON u.id = d.user_id ORDER BY d.db_name');
}

export function create(ownerUsername, { dbName, password = '' } = {}, actor = 'admin') {
  const u = get('SELECT * FROM users WHERE username = ?', ownerUsername);
  if (!u) return { ok: false, error: 'Konto nie istnieje' };
  const name = String(dbName || '').toLowerCase();
  if (!/^[a-z][a-z0-9_]{2,40}$/.test(name)) return { ok: false, error: 'Nazwa bazy: małe litery, cyfry, _' };
  if (!status().ready) return { ok: false, error: 'PostgreSQL nie działa. Zainstaluj postgresql i uruchom usługę.' };
  if (get('SELECT id FROM postgres_databases WHERE db_name = ?', name)) return { ok: false, error: 'Baza już istnieje' };
  const role = name.slice(0, 30);
  const pass = password || crypto.randomBytes(18).toString('base64url');
  const r = psql(`CREATE ROLE "${role}" LOGIN PASSWORD '${pass.replace(/'/g, "''")}';`);
  if (!r.ok) return { ok: false, error: `CREATE ROLE: ${r.error}` };
  const d = psql(`CREATE DATABASE "${name}" OWNER "${role}";`);
  if (!d.ok) { psql(`DROP ROLE IF EXISTS "${role}";`); return { ok: false, error: `CREATE DATABASE: ${d.error}` }; }
  run('INSERT INTO postgres_databases(user_id, db_name, db_user, password_enc, size_mb, created_at) VALUES(?,?,?,?,?,?)', u.id, name, role, encryptSecret(pass), 0, nowIso());
  audit(actor, 'admin', 'postgres.create', name, '');
  return { ok: true, dbName: name, role, password: pass, simulated: config.provider !== 'linux' };
}

export function drop(id, actor = 'admin') {
  const row = get('SELECT * FROM postgres_databases WHERE id = ?', Number(id));
  if (!row) return { ok: false, error: 'Not found' };
  if (config.provider === 'linux' && status().ready) {
    const d = psql(`DROP DATABASE IF EXISTS "${row.db_name}";`);
    if (!d.ok) return { ok: false, error: d.error };
    psql(`DROP ROLE IF EXISTS "${row.db_user}";`);
  }
  run('DELETE FROM postgres_databases WHERE id = ?', row.id);
  audit(actor, 'admin', 'postgres.drop', row.db_name, '');
  return { ok: true };
}

export function overview() { return { status: status(), rows: list(), host: 'localhost', port: 5432 }; }
