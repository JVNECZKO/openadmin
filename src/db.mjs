// SQLite persistence layer. OpenAdmin deliberately uses Node's built-in
// `node:sqlite` so the panel has zero third-party runtime dependencies.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { config, ensureDataDir } from './config.mjs';
import { userHome } from './paths.mjs';

let db = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  owner TEXT,
  type TEXT NOT NULL DEFAULT 'user',
  limits TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  email TEXT,
  level TEXT NOT NULL DEFAULT 'user',
  owner TEXT,
  package TEXT,
  domain TEXT,
  ip TEXT,
  suspended INTEGER NOT NULL DEFAULT 0,
  suspended_reason TEXT,
  notes TEXT,
  language TEXT NOT NULL DEFAULT 'pl',
  skin TEXT NOT NULL DEFAULT 'evolution',
  created_at TEXT NOT NULL,
  last_login TEXT,
  login_count INTEGER NOT NULL DEFAULT 0,
  last_ip TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  api_enabled INTEGER NOT NULL DEFAULT 1,
  twofa_secret TEXT,
  twofa_enabled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_users_owner ON users(owner);
CREATE INDEX IF NOT EXISTS idx_users_level ON users(level);

CREATE TABLE IF NOT EXISTS domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  name TEXT UNIQUE NOT NULL,
  docroot TEXT,
  php_version TEXT,
  ssl INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  is_main INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  bandwidth_mb REAL NOT NULL DEFAULT 0,
  disk_mb REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_domains_user ON domains(username);

CREATE TABLE IF NOT EXISTS subdomains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  php_version TEXT,
  docroot TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(domain_id, name)
);

CREATE TABLE IF NOT EXISTS dns_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  priority INTEGER,
  ttl INTEGER NOT NULL DEFAULT 3600
);
CREATE INDEX IF NOT EXISTS idx_dns_domain ON dns_records(domain_id);

CREATE TABLE IF NOT EXISTS email_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  local_part TEXT NOT NULL,
  password TEXT NOT NULL,
  quota_mb INTEGER NOT NULL DEFAULT 0,
  used_mb REAL NOT NULL DEFAULT 0,
  mail_hash TEXT,
  suspended INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(domain, local_part)
);

CREATE TABLE IF NOT EXISTS email_forwarders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  source TEXT NOT NULL,
  dest TEXT NOT NULL,
  keep_copy INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS autoresponders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS catchall (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id INTEGER NOT NULL UNIQUE REFERENCES domains(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  dest TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vacation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ftp_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  quota_mb INTEGER NOT NULL DEFAULT 0,
  password TEXT NOT NULL,
  anonymous INTEGER NOT NULL DEFAULT 0,
  suspended INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS databases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  db_name TEXT NOT NULL,
  db_user TEXT NOT NULL,
  password TEXT NOT NULL,
  password_enc TEXT,
  size_mb REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(db_name)
);

CREATE TABLE IF NOT EXISTS cron_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  minute TEXT NOT NULL DEFAULT '0',
  hour TEXT NOT NULL DEFAULT '*',
  day TEXT NOT NULL DEFAULT '*',
  month TEXT NOT NULL DEFAULT '*',
  weekday TEXT NOT NULL DEFAULT '*',
  command TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ssl_certs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  username TEXT,
  type TEXT NOT NULL DEFAULT 'letsencrypt',
  issuer TEXT,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  cert TEXT,
  key TEXT,
  csr TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'full',
  size_mb REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'complete',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  subject TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT 'support',
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'user',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT UNIQUE NOT NULL,
  netmask TEXT NOT NULL DEFAULT '255.255.255.0',
  status TEXT NOT NULL DEFAULT 'free',
  owner TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id TEXT NOT NULL UNIQUE,
  secret TEXT NOT NULL,
  expires_at TEXT,
  commands TEXT,
  created_at TEXT NOT NULL,
  last_used TEXT
);

CREATE TABLE IF NOT EXISTS ssh_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL DEFAULT 'user',
  username TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  level TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL,
  username TEXT NOT NULL,
  bandwidth_mb REAL NOT NULL DEFAULT 0,
  disk_mb REAL NOT NULL DEFAULT 0,
  emails INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day, username)
);

CREATE TABLE IF NOT EXISTS hosted_apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  path_prefix TEXT NOT NULL DEFAULT '/',
  type TEXT NOT NULL DEFAULT 'node',
  port INTEGER NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'registered',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plugins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  title TEXT,
  level TEXT NOT NULL DEFAULT 'user',
  version TEXT NOT NULL DEFAULT '1.0.0',
  enabled INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_installs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  domain TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '/',
  type TEXT NOT NULL,
  version TEXT,
  db_name TEXT,
  admin_user TEXT,
  password_enc TEXT,
  data_dir TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wordpress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '/',
  version TEXT NOT NULL DEFAULT '6.6',
  db_name TEXT,
  admin_user TEXT,
  admin_password TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS redirects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  from_path TEXT NOT NULL,
  to_url TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '301',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mailing_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  name TEXT NOT NULL,
  members TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  field TEXT NOT NULL DEFAULT 'subject',
  operator TEXT NOT NULL DEFAULT 'contains',
  value TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'move',
  target TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS twofa_pending (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS twofa_recovery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  code_hash TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  csrf TEXT NOT NULL,
  ip TEXT,
  ua TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  support INTEGER NOT NULL DEFAULT 0,
  support_token TEXT,
  token_hash TEXT,
  last_seen TEXT
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox TEXT NOT NULL,
  uid INTEGER NOT NULL,
  folder TEXT NOT NULL DEFAULT 'INBOX',
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  cc TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  size_kb REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_mailbox ON mail_messages(mailbox, folder);

CREATE TABLE IF NOT EXISTS webmail_sessions (
  token TEXT PRIMARY KEY,
  mailbox TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dkim_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL UNIQUE,
  selector TEXT NOT NULL DEFAULT 'default',
  key_path TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS maildir_imports (
  path TEXT PRIMARY KEY,
  mailbox TEXT NOT NULL,
  message_id INTEGER,
  imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_kb REAL NOT NULL DEFAULT 0,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT,
  recipient TEXT NOT NULL,
  subject TEXT,
  size_kb REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'deferred',
  body TEXT,
  attachments TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS imap_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  source_host TEXT NOT NULL,
  source_user TEXT NOT NULL,
  dest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  output TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'running',
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS cron_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  command TEXT NOT NULL,
  exit_code INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ip_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cidr TEXT NOT NULL UNIQUE,
  reason TEXT,
  created_by TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS root_ssh_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT,
  private_path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS country_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL DEFAULT 'block',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT,
  domain TEXT,
  sender TEXT,
  recipient TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  raw TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_events_created ON mail_events(created_at);
CREATE INDEX IF NOT EXISTS idx_mail_events_domain ON mail_events(domain);

CREATE TABLE IF NOT EXISTS mail_filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'reject',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_routing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL UNIQUE,
  router TEXT NOT NULL DEFAULT 'local',
  target TEXT,
  split INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_smtp (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 587,
  username TEXT,
  password_enc TEXT,
  tls INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backup_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  host TEXT,
  port INTEGER,
  path TEXT,
  username TEXT,
  password_enc TEXT,
  key_enc TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_test_at TEXT,
  last_test_ok INTEGER,
  last_test_output TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backup_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'server',
  target_user TEXT,
  components TEXT NOT NULL DEFAULT '[]',
  server_id INTEGER REFERENCES backup_servers(id) ON DELETE SET NULL,
  schedule TEXT NOT NULL DEFAULT 'daily',
  retention_days INTEGER NOT NULL DEFAULT 14,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_status TEXT,
  last_output TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backup_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER REFERENCES backup_jobs(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  size_mb REAL NOT NULL DEFAULT 0,
  server_id INTEGER,
  local_path TEXT,
  remote_path TEXT,
  output TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS automation_jobs (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  interval_seconds INTEGER NOT NULL DEFAULT 86400,
  last_run_at TEXT,
  next_run_at TEXT,
  last_status TEXT,
  last_output TEXT,
  run_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_key TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  output TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_automation_jobs_due ON automation_jobs(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_automation_runs_job ON automation_runs(job_key, id);
CREATE INDEX IF NOT EXISTS idx_automation_runs_started ON automation_runs(started_at);

CREATE TABLE IF NOT EXISTS feature_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  features TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dns_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  records TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blacklist_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL UNIQUE,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  host TEXT,
  username TEXT,
  target TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  progress INTEGER NOT NULL DEFAULT 0,
  log TEXT,
  options TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  allowed_ips TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  level TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  config_enc TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS support_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL,
  prefix TEXT NOT NULL,
  created_by TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'read',
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS autossl_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS storage_paths (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'ext4',
  alert_percent INTEGER NOT NULL DEFAULT 90,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reseller_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  privileges TEXT NOT NULL DEFAULT '{}',
  limits TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS process_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  pid INTEGER,
  user TEXT,
  command TEXT,
  result TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS postgres_databases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  db_name TEXT NOT NULL UNIQUE,
  db_user TEXT NOT NULL,
  password_enc TEXT,
  size_mb REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  token_enc TEXT,
  role TEXT NOT NULL DEFAULT 'web',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT,
  last_status TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webdisks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  domain TEXT NOT NULL,
  path TEXT NOT NULL,
  password_enc TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS country_email_policy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL DEFAULT 'reject',
  created_at TEXT NOT NULL
);

`;

export function nowIso() {
  return new Date().toISOString();
}

export function dbFile() {
  ensureDataDir();
  return path.join(config.dataDir, 'openadmin.db');
}

export function getDb() {
  if (db) return db;
  db = new DatabaseSync(dbFile());
  db.exec(SCHEMA);
  try {
    const cols = db.prepare('PRAGMA table_info(email_accounts)').all();
    if (!cols.some((c) => c.name === 'mail_hash')) db.exec('ALTER TABLE email_accounts ADD COLUMN mail_hash TEXT');
    const userCols = db.prepare('PRAGMA table_info(users)').all();
    if (!userCols.some((c) => c.name === 'twofa_secret')) db.exec('ALTER TABLE users ADD COLUMN twofa_secret TEXT');
    if (!userCols.some((c) => c.name === 'twofa_enabled')) db.exec('ALTER TABLE users ADD COLUMN twofa_enabled INTEGER NOT NULL DEFAULT 0');
    const queueCols = db.prepare('PRAGMA table_info(mail_queue)').all();
    if (!queueCols.some((c) => c.name === 'error')) db.exec('ALTER TABLE mail_queue ADD COLUMN error TEXT');
    if (!queueCols.some((c) => c.name === 'attempts')) db.exec('ALTER TABLE mail_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    if (!queueCols.some((c) => c.name === 'sent_at')) db.exec('ALTER TABLE mail_queue ADD COLUMN sent_at TEXT');
    if (!queueCols.some((c) => c.name === 'body')) db.exec('ALTER TABLE mail_queue ADD COLUMN body TEXT');
    if (!queueCols.some((c) => c.name === 'attachments')) db.exec('ALTER TABLE mail_queue ADD COLUMN attachments TEXT');
    const dbCols = db.prepare('PRAGMA table_info(databases)').all();
    if (!dbCols.some((c) => c.name === 'password_enc')) db.exec('ALTER TABLE databases ADD COLUMN password_enc TEXT');
    const pendingCols = db.prepare('PRAGMA table_info(twofa_pending)').all();
    if (!pendingCols.some((c) => c.name === 'attempts')) db.exec('ALTER TABLE twofa_pending ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    const wpCols = db.prepare('PRAGMA table_info(wordpress)').all();
    if (!wpCols.some((c) => c.name === 'password_enc')) db.exec('ALTER TABLE wordpress ADD COLUMN password_enc TEXT');
    const appCols = db.prepare('PRAGMA table_info(app_installs)').all();
    if (appCols.length && !appCols.some((c) => c.name === 'data_dir')) db.exec('ALTER TABLE app_installs ADD COLUMN data_dir TEXT');
    if (!userCols.some((c) => c.name === 'language')) db.exec("ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT 'pl'");
    if (!userCols.some((c) => c.name === 'ui_mode')) db.exec("ALTER TABLE users ADD COLUMN ui_mode TEXT NOT NULL DEFAULT 'simple'");
    if (!userCols.some((c) => c.name === 'shell_enabled')) db.exec('ALTER TABLE users ADD COLUMN shell_enabled INTEGER NOT NULL DEFAULT 0');
    if (!userCols.some((c) => c.name === 'demo')) db.exec('ALTER TABLE users ADD COLUMN demo INTEGER NOT NULL DEFAULT 0');
    if (!userCols.some((c) => c.name === 'reseller_plan')) db.exec('ALTER TABLE users ADD COLUMN reseller_plan TEXT');
    if (!userCols.some((c) => c.name === 'home_path')) db.exec('ALTER TABLE users ADD COLUMN home_path TEXT');
    if (!userCols.some((c) => c.name === 'webdisk_enabled')) db.exec('ALTER TABLE users ADD COLUMN webdisk_enabled INTEGER NOT NULL DEFAULT 0');
    const pkgCols = db.prepare('PRAGMA table_info(packages)').all();
    if (!pkgCols.some((c) => c.name === 'features')) db.exec("ALTER TABLE packages ADD COLUMN features TEXT NOT NULL DEFAULT '{}'");
    if (!pkgCols.some((c) => c.name === 'resources')) db.exec("ALTER TABLE packages ADD COLUMN resources TEXT NOT NULL DEFAULT '{}'");
    const domCols = db.prepare('PRAGMA table_info(domains)').all();
    if (!domCols.some((c) => c.name === 'dns_ttl')) db.exec('ALTER TABLE domains ADD COLUMN dns_ttl INTEGER NOT NULL DEFAULT 3600');
    const sslCols = db.prepare('PRAGMA table_info(ssl_certs)').all();
    if (!sslCols.some((c) => c.name === 'key_type')) db.exec("ALTER TABLE ssl_certs ADD COLUMN key_type TEXT DEFAULT 'rsa2048'");
    const jobCols = db.prepare('PRAGMA table_info(backup_jobs)').all();
    if (jobCols.length && !jobCols.some((c) => c.name === 'target_user')) db.exec('ALTER TABLE backup_jobs ADD COLUMN target_user TEXT');
    const sessCols = db.prepare('PRAGMA table_info(sessions)').all();
    if (sessCols.length && !sessCols.some((c) => c.name === 'support')) db.exec('ALTER TABLE sessions ADD COLUMN support INTEGER NOT NULL DEFAULT 0');
    if (sessCols.length && !sessCols.some((c) => c.name === 'support_token')) db.exec('ALTER TABLE sessions ADD COLUMN support_token TEXT');
    if (sessCols.length && !sessCols.some((c) => c.name === 'token_hash')) db.exec('ALTER TABLE sessions ADD COLUMN token_hash TEXT');
    if (sessCols.length && !sessCols.some((c) => c.name === 'last_seen')) db.exec('ALTER TABLE sessions ADD COLUMN last_seen TEXT');
    // SEC-010: sessions store only a SHA-256 token hash. Existing databases are
    // migrated in place so open browser sessions keep working: the cookie value
    // remains the raw token, while the row key becomes its hash.
    const sessionRows = db.prepare('SELECT rowid, token, token_hash, created_at FROM sessions').all();
    const updateSession = db.prepare('UPDATE sessions SET token = ?, token_hash = ?, last_seen = COALESCE(last_seen, ?) WHERE rowid = ?');
    for (const row of sessionRows) {
      const current = String(row.token || '');
      const hash = row.token_hash ? String(row.token_hash) : crypto.createHash('sha256').update(current).digest('hex');
      if (current === hash && row.token_hash === hash) {
        if (!row.created_at) updateSession.run(hash, hash, nowIso(), row.rowid);
        continue;
      }
      // We cannot know the last activity of a pre-migration session; grant a
      // fresh idle window instead of logging every existing user out on deploy.
      updateSession.run(hash, hash, nowIso(), row.rowid);
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash) WHERE token_hash IS NOT NULL');
  } catch { /* table created by schema */ }
  return db;
}

function normalize(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  if (v === undefined || v === null) return null;
  if (typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}

export function run(sql, ...params) {
  const stmt = getDb().prepare(sql);
  const res = stmt.run(...params.map(normalize));
  return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
}

export function get(sql, ...params) {
  return getDb().prepare(sql).get(...params.map(normalize)) ?? null;
}

export function all(sql, ...params) {
  return getDb().prepare(sql).all(...params.map(normalize));
}

export function transaction(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

/* ------------------------------ settings ------------------------------- */

export function setting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
}

/* ------------------------------ passwords ------------------------------ */

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts[0] !== 'scrypt' || parts.length !== 6) return false;
    const [, N, r, p, saltHex, hashHex] = parts;
    const hash = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 64, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    const expected = Buffer.from(hashHex, 'hex');
    return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
  } catch {
    return false;
  }
}

/* -------------------------------- audit -------------------------------- */

export function audit(actor, level, action, target = '', ip = '') {
  run('INSERT INTO audit_log(actor, level, action, target, ip, created_at) VALUES(?,?,?,?,?,?)',
    actor, level, action, target, ip, nowIso());
}

/* --------------------------------- seed -------------------------------- */

export const DEFAULT_PACKAGE_LIMITS = {
  domains: 10,
  subdomains: 25,
  emails: 50,
  email_quota_mb: 1024,
  ftp: 10,
  databases: 10,
  bandwidth_mb: 102400,
  disk_mb: 10240,
  inodes: 200000,
  cron: 5,
  ssl: 10,
  php: ['8.3', '8.2', '8.1'],
  dns_control: 1,
  ssh: 0,
  cgi: 0,
  spam: 1,
  catch_all: 1,
  autoresponders: 10,
  forwarders: 50,
  mailing_lists: 1,
  nodejs: 0,
  python: 0,
  wordpress: 1,
  suspended: 0,
};

export const DEFAULT_RESELLER_LIMITS = {
  users: 50,
  domains: 500,
  subdomains: 1000,
  emails: 1000,
  databases: 200,
  bandwidth_mb: 1048576,
  disk_mb: 102400,
  ips: 4,
  packages: 20,
  php: ['8.3', '8.2', '8.1'],
  dns_control: 1,
  ssh: 0,
  wordpress: 1,
};

function packageLimits(type) {
  return { ...(type === 'reseller' ? DEFAULT_RESELLER_LIMITS : DEFAULT_PACKAGE_LIMITS) };
}

export function seedBase({ adminUser, adminPassword, serverName, serverIp, ns1, ns2 } = {}) {
  const d = getDb();
  const count = get('SELECT COUNT(*) AS n FROM users');
  if (count && count.n > 0) return { created: false };

  const password = adminPassword || crypto.randomBytes(9).toString('base64url');
  const ts = nowIso();

  transaction(() => {
    run(`INSERT INTO packages(name, owner, type, limits, created_at) VALUES(?,?,?,?,?)`,
      'default', null, 'user', JSON.stringify(packageLimits('user')), ts);
    run(`INSERT INTO packages(name, owner, type, limits, created_at) VALUES(?,?,?,?,?)`,
      'unlimited', null, 'user', JSON.stringify({ ...packageLimits('user'), domains: 0, subdomains: 0, emails: 0, ftp: 0, databases: 0, bandwidth_mb: 0, disk_mb: 0 }), ts);
    run(`INSERT INTO packages(name, owner, type, limits, created_at) VALUES(?,?,?,?,?)`,
      'reseller_default', null, 'reseller', JSON.stringify(packageLimits('reseller')), ts);

    run(`INSERT INTO users(username, password, email, level, owner, package, domain, created_at, must_change_password)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      adminUser, hashPassword(password), `admin@${serverName}`, 'admin', null, 'unlimited', serverName, ts, adminPassword ? 0 : 1);

    setSetting('server_name', serverName);
    setSetting('server_ip', serverIp);
    setSetting('ns1', ns1);
    setSetting('ns2', ns2);
    setSetting('panel_version', config.version);
    setSetting('theme', 'evolution');
    setSetting('installed_at', ts);
    setSetting('license_type', 'unlimited');
    setSetting('license_expires', 'never');
    setSetting('license_holders', '0');
    setSetting('license_edition', 'Community');
    setSetting('tls_mode', 'modern');
    setSetting('php_default', '8.3');
    setSetting('default_package', 'default');
    setSetting('reseller_package', 'reseller_default');
    setSetting('login_page_message', '');
    setSetting('demo_mode', config.demo ? '1' : '0');
  });
  ensureServices();

  return { created: true, password };
}

function demoMailHash() {
  try {
    const r = spawnSync('openssl', ['passwd', '-6', 'demo'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch { /* ignore */ }
  return '{PLAIN}demo';
}

export function ensureServices() {
  getDb();
  for (const svc of ['httpd', 'nginx', 'exim', 'dovecot', 'mysqld', 'bind', 'proftpd', 'php-fpm', 'redis', 'cron', 'clamav', 'rspamd', 'unit', 'netdata', 'openlitespeed', 'litespeed']) {
    run('INSERT OR IGNORE INTO services(name, status) VALUES(?, ?)', svc, 'running');
  }
}

export function seedDemo() {
  const ts = nowIso();
  getDb();
  ensureServices();
  if (get("SELECT id FROM users WHERE username = 'demouser'")) {
    ensureDemoFiles();
    return true;
  }
  transaction(() => {
    const mkUser = (username, level, owner, pkg, domain) => {
      const existing = get('SELECT id FROM users WHERE username = ?', username);
      if (existing) return existing.id;
      const r = run(`INSERT INTO users(username, password, email, level, owner, package, domain, created_at, last_login, login_count)
                     VALUES(?,?,?,?,?,?,?,?,?,?)`,
        username, hashPassword('demo'), `${username}@example.com`, level, owner, pkg, domain, ts, ts, 12);
      return r.lastInsertRowid;
    };

    const adminId = mkUser('demoadmin', 'admin', null, 'unlimited', 'demo.openadmin.local');
    const resellerId = mkUser('demoreseller', 'reseller', null, 'reseller_default', 'reseller-demo.local');
    const userId = mkUser('demouser', 'user', 'demoreseller', 'default', 'example.com');
    for (const u of ['demoadmin', 'demoreseller', 'demouser']) {
      run('UPDATE users SET password = ? WHERE username = ?', hashPassword('demo'), u);
    }

    const addDomain = (username, uid, name, main) => {
      const exists = get('SELECT id FROM domains WHERE name = ?', name);
      if (exists) return exists.id;
      const r = run(`INSERT INTO domains(user_id, username, name, docroot, php_version, ssl, status, is_main, ip, bandwidth_mb, disk_mb, created_at)
                     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        uid, username, name, `/home/${username}/domains/${name}/public_html`, '8.3', 1, 'active', main ? 1 : 0,
        config.defaults.serverIp, Math.round(Math.random() * 600 + 40), Math.round(Math.random() * 240 + 12), ts);

      const zone = [
        ['@', 'A', config.defaults.serverIp, null],
        ['www', 'A', config.defaults.serverIp, null],
        ['mail', 'A', config.defaults.serverIp, null],
        ['ftp', 'A', config.defaults.serverIp, null],
        ['@', 'MX', `mail.${name}.`, 10],
        ['@', 'TXT', 'v=spf1 a mx ip4:' + config.defaults.serverIp + ' ~all', null],
        ['_dmarc', 'TXT', 'v=DMARC1; p=quarantine; rua=mailto:postmaster@' + name, null],
        ['@', 'NS', config.defaults.nameserver1 + '.', null],
        ['@', 'NS', config.defaults.nameserver2 + '.', null],
      ];
      for (const [n, t, v, pr] of zone) {
        run('INSERT INTO dns_records(domain_id, name, type, value, priority, ttl) VALUES(?,?,?,?,?,?)', r.lastInsertRowid, n, t, v, pr, 3600);
      }
      return r.lastInsertRowid;
    };

    const mainId = addDomain('demouser', userId, 'example.com', true);
    addDomain('demouser', userId, 'demo-site.org', false);
    addDomain('demoreseller', resellerId, 'reseller-demo.local', true);
    addDomain('demoadmin', adminId, 'demo.openadmin.local', true);

    run('INSERT OR IGNORE INTO subdomains(domain_id, username, name, php_version, docroot, created_at) VALUES(?,?,?,?,?,?)',
      mainId, 'demouser', 'blog', '8.3', '/home/demouser/domains/example.com/public_html/blog', ts);

    const emails = [['info', 1024, 96], ['sales', 512, 41], ['support', 2048, 780], ['noreply', 256, 3]];
    for (const [local, quota, used] of emails) {
      run(`INSERT OR IGNORE INTO email_accounts(domain_id, domain, local_part, password, quota_mb, used_mb, suspended, created_at, mail_hash)
           VALUES(?,?,?,?,?,?,?,?,?)`, mainId, 'example.com', local, hashPassword('demo'), quota, used, 0, ts, demoMailHash());
    }
    run(`INSERT OR IGNORE INTO email_forwarders(domain_id, domain, source, dest, keep_copy, created_at) VALUES(?,?,?,?,?,?)`,
      mainId, 'example.com', 'contact@example.com', 'info@example.com', 1, ts);
    run(`INSERT OR IGNORE INTO autoresponders(domain_id, domain, email, subject, body, enabled, created_at) VALUES(?,?,?,?,?,?,?)`,
      mainId, 'example.com', 'support@example.com', 'We received your message', 'Thanks for contacting us. We will reply within one business day.', 1, ts);
    run(`INSERT OR IGNORE INTO catchall(domain_id, domain, dest, created_at) VALUES(?,?,?,?)`,
      mainId, 'example.com', 'info@example.com', ts);

    const demoMail = [
      ['info@example.com', 'INBOX', 'Welcome to OpenAdmin', 'noreply@openadmin.local', 'Your hosting account is ready. This mailbox is served by the built-in webmail and by Roundcube when installed.', 1],
      ['info@example.com', 'INBOX', 'Invoice #2026-118 paid', 'billing@example.net', 'Thanks for your payment. Your next invoice is due on 1 December 2026.', 0],
      ['info@example.com', 'INBOX', 'New ticket: SSL for demo-site.org', 'demouser@example.com', 'Could you enable a free certificate for demo-site.org? Thanks!', 0],
      ['sales@example.com', 'INBOX', 'Quote request', 'lead@prospect.test', 'Hello, we would like a quote for 5 domains and 20 mailboxes.', 0],
      ['sales@example.com', 'SENT', 'Re: Quote request', 'lead@prospect.test', 'Happy to help — the panel is free and unlimited, so there is no licence cost. What is your timeline?', 1],
      ['support@example.com', 'INBOX', 'Migration question', 'customer@example.org', 'Can I move my sites from cPanel?', 0],
      ['support@example.com', 'SENT', 'Re: Migration question', 'customer@example.org', 'Yes — use Reseller → cPanel Import, or the IMAPSync migration page for mail.', 1],
    ];
    let uid = 1;
    for (const [mailbox, folder, subject, from, body, seen] of demoMail) {
      run(`INSERT INTO mail_messages(mailbox, uid, folder, from_addr, to_addr, subject, body, seen, size_kb, created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)`, mailbox, uid++, folder, from, mailbox, subject, body, seen, Math.max(1, Math.round(body.length / 1024)), ts);
    }

    run(`INSERT OR IGNORE INTO ftp_accounts(user_id, username, path, quota_mb, password, created_at) VALUES(?,?,?,?,?,?)`,
      userId, 'demouser', '/home/demouser', 2048, hashPassword('demo'), ts);
    run(`INSERT OR IGNORE INTO ftp_accounts(user_id, username, path, quota_mb, password, created_at) VALUES(?,?,?,?,?,?)`,
      userId, 'uploads', '/home/demouser/domains/example.com/public_html/uploads', 512, hashPassword('demo'), ts);
    run(`INSERT OR IGNORE INTO databases(user_id, db_name, db_user, password, size_mb, created_at) VALUES(?,?,?,?,?,?)`,
      userId, 'demouser_wp', 'demouser_wp', hashPassword('demo'), 18.4, ts);

    run(`INSERT OR IGNORE INTO cron_jobs(user_id, minute, hour, day, month, weekday, command, created_at) VALUES(?,?,?,?,?,?,?,?)`,
      userId, '0', '3', '*', '*', '*', '/usr/local/bin/php /home/demouser/domains/example.com/public_html/cron.php', ts);

    run(`INSERT OR IGNORE INTO ssl_certs(domain, username, type, issuer, expires_at, status, created_at) VALUES(?,?,?,?,?,?,?)`,
      'example.com', 'demouser', 'letsencrypt', "Let's Encrypt R3", new Date(Date.now() + 62 * 864e5).toISOString(), 'active', ts);
    run(`INSERT OR IGNORE INTO ssl_certs(domain, username, type, issuer, expires_at, status, created_at) VALUES(?,?,?,?,?,?,?)`,
      'demo-site.org', 'demouser', 'self-signed', 'OpenAdmin Self-Signed', new Date(Date.now() + 365 * 864e5).toISOString(), 'active', ts);

    run(`INSERT OR IGNORE INTO backups(user_id, filename, kind, size_mb, status, created_at) VALUES(?,?,?,?,?,?)`,
      userId, 'user_demouser_2026-11-01.tar.gz', 'full', 412.6, 'complete', '2026-11-01T03:00:00.000Z');
    run(`INSERT OR IGNORE INTO backups(user_id, filename, kind, size_mb, status, created_at) VALUES(?,?,?,?,?,?)`,
      userId, 'user_demouser_2026-11-08.tar.gz', 'full', 418.2, 'complete', '2026-11-08T03:00:00.000Z');

    run(`INSERT OR IGNORE INTO tickets(user_id, username, subject, department, priority, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)`,
      userId, 'demouser', 'Enable SSL for demo-site.org', 'support', 'normal', 'open', ts, ts);
    run(`INSERT OR IGNORE INTO ticket_messages(ticket_id, author, level, body, created_at) VALUES(?,?,?,?,?)`,
      1, 'demouser', 'user', 'Could you enable a free certificate for demo-site.org? Thanks!', ts);

    run(`INSERT OR IGNORE INTO ips(ip, netmask, status, owner, note, created_at) VALUES(?,?,?,?,?,?)`,
      config.defaults.serverIp, '255.255.255.0', 'server', 'admin', 'Primary server IP', ts);
    run(`INSERT OR IGNORE INTO ips(ip, netmask, status, owner, note, created_at) VALUES(?,?,?,?,?,?)`,
      '203.0.113.24', '255.255.255.0', 'shared', 'demoreseller', 'Reseller pool', ts);

    run(`INSERT OR IGNORE INTO messages(level, username, subject, body, created_at) VALUES(?,?,?,?,?)`,
      'user', 'demouser', 'Witaj w OpenAdmin', 'Twoje konto hostingowe jest gotowe. Panel jest w 100% darmowy i bez limitów.', ts);

    run(`INSERT OR IGNORE INTO plugins(name, title, level, version, enabled, description, created_at) VALUES(?,?,?,?,?,?,?)`,
      'phpmyadmin', 'phpMyAdmin', 'user', '5.2.1', 1, 'Database management interface', ts);
    run(`INSERT OR IGNORE INTO plugins(name, title, level, version, enabled, description, created_at) VALUES(?,?,?,?,?,?,?)`,
      'roundcube', 'Roundcube Webmail', 'user', '1.6.7', 1, 'Webmail client', ts);

    run(`INSERT OR IGNORE INTO wordpress(domain, path, version, db_name, admin_user, status, created_at) VALUES(?,?,?,?,?,?,?)`,
      'example.com', '/', '6.6.2', 'demouser_wp', 'admin', 'active', ts);

    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 864e5);
      const day = d.toISOString().slice(0, 10);
      for (const [u, mult] of [['demouser', 1], ['demoreseller', 0.4], ['demoadmin', 0.2]]) {
        run(`INSERT OR IGNORE INTO usage_daily(day, username, bandwidth_mb, disk_mb, emails, requests) VALUES(?,?,?,?,?,?)`,
          day, u,
          Math.round((320 + Math.sin(i / 3) * 120 + Math.random() * 80) * mult),
          Math.round((4200 + i * 6 + Math.random() * 40) * mult),
          Math.round((120 + Math.random() * 60) * mult),
          Math.round((9000 + Math.random() * 3000) * mult));
      }
    }

    run(`INSERT OR IGNORE INTO redirects(domain_id, username, from_path, to_url, type, created_at) VALUES(?,?,?,?,?,?)`,
      mainId, 'demouser', '/old-page', 'https://example.com/new-page', '301', ts);

    setSetting('demo_mode', '1');
  });

  ensureDemoFiles();
  return true;
}

function ensureDemoFiles() {
  // Sample document roots so the file manager and site previews have content.
  const sample = {
    'index.html': `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>example.com</title>\n<link rel="stylesheet" href="/css/style.css"></head>\n<body><h1>It works!</h1><p>This site is hosted on OpenAdmin.</p></body></html>\n`,
    'about.html': `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>About</title><link rel="stylesheet" href="/css/style.css"></head>\n<body><h1>About us</h1><p>Welcome to example.com.</p></body></html>\n`,
    'css/style.css': `body{font-family:system-ui,sans-serif;margin:0;padding:48px;background:#f6f9fc;color:#17222e}h1{color:#0a6daa}\n`,
    '.htaccess': `# OpenAdmin sample .htaccess\nOptions -Indexes\n<IfModule mod_deflate.c>\n  AddOutputFilterByType DEFLATE text/html text/css application/javascript\n</IfModule>\n`,
    'robots.txt': `User-agent: *\nAllow: /\n`,
  };
  for (const [rel, content] of Object.entries(sample)) {
    const full = path.join(userHome('demouser'), 'domains', 'example.com', 'public_html', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (!fs.existsSync(full)) fs.writeFileSync(full, content, 'utf8');
  }
  fs.mkdirSync(path.join(userHome('demouser'), 'mail'), { recursive: true });
  fs.mkdirSync(path.join(userHome('demouser'), 'backups'), { recursive: true });
}

export function closeDb() {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
    db = null;
  }
}
