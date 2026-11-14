// OpenAdmin configuration. Everything is read from the environment with sane
// defaults so the panel can run from a checkout with zero setup.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
export const VERSION = '1.0.0';

function int(v, d) {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
}
function bool(v, d) {
  if (v === undefined || v === '') return d;
  return !/^(0|false|no|off)$/i.test(String(v));
}

export const config = {
  version: VERSION,
  root: ROOT,
  dataDir: process.env.OA_DATA_DIR || path.join(ROOT, 'data'),
  port: int(process.env.OA_PORT, 2222),
  imapPort: int(process.env.OA_IMAP_PORT, 1143),
  host: process.env.OA_HOST || '127.0.0.1',
  https: bool(process.env.OA_HTTPS, false),
  certFile: process.env.OA_CERT || '',
  keyFile: process.env.OA_KEY || '',
  sessionTtlHours: int(process.env.OA_SESSION_TTL, 12),
  demo: bool(process.env.OA_DEMO, false),
  // Provider used to talk to the underlying operating system. The sandbox
  // provider is a safe, fully functional simulator and is the default.
  provider: process.env.OA_PROVIDER || 'sandbox',
  mysql: {
    adminUser: process.env.OA_MYSQL_ADMIN_USER || 'root',
    password: process.env.OA_MYSQL_ADMIN_PASSWORD || '',
    socket: process.env.OA_MYSQL_SOCKET || '',
    host: process.env.OA_MYSQL_HOST || '',
    port: int(process.env.OA_MYSQL_PORT, 3306),
  },
  // Free licensing: OpenAdmin has no paid tiers. The license module reports
  // an unlimited licence for every install, forever.
  license: {
    type: 'unlimited',
    holders: int(process.env.OA_LICENSE_HOLDERS, 0), // 0 = unlimited
    expires: null,
    edition: 'Community',
  },
  defaults: {
    adminUser: process.env.OA_ADMIN_USER || 'admin',
    adminPassword: process.env.OA_ADMIN_PASSWORD || '',
    adminEmail: process.env.OA_ADMIN_EMAIL || 'admin@localhost',
    serverName: process.env.OA_SERVER_NAME || os.hostname(),
    nameserver1: process.env.OA_NS1 || 'ns1.' + os.hostname(),
    nameserver2: process.env.OA_NS2 || 'ns2.' + os.hostname(),
    serverIp: process.env.OA_SERVER_IP || '127.0.0.1',
  },
  limits: {
    maxUploadMb: int(process.env.OA_MAX_UPLOAD_MB, 256),
    maxLoginAttempts: 8,
    loginWindowMinutes: 10,
    maxUploadMb: 256,
  },
};

export function ensureDataDir() {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(config.dataDir, 'backups'), { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, 'sessions'), { recursive: true });
  return config.dataDir;
}

/** Persistent secret used for CSRF and cookie signing. */
export function panelSecret() {
  ensureDataDir();
  const f = path.join(config.dataDir, 'secret.key');
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(f, 'utf8').trim();
}
