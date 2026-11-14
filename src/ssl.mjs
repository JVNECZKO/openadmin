// Certificate operations: real self-signed keys, certbot ACME when installed,
// PEM validation, and installation into the active web server configuration.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from './config.mjs';
import { get, run, nowIso, setting } from './db.mjs';
import { systemProvider } from './providers/index.mjs';

export function certDir(domain) {
  const dir = path.join(config.dataDir, 'ssl', domain.replace(/[^a-z0-9.-]/gi, '_'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function certWebPaths(domain) {
  if (systemProvider().id === 'linux') {
    const dir = `/etc/openadmin/ssl/${domain}`;
    return { dir, cert: `${dir}/fullchain.pem`, key: `${dir}/privkey.pem` };
  }
  return certPaths(domain);
}

export function certPaths(domain) {
  const dir = certDir(domain);
  return { dir, cert: path.join(dir, 'fullchain.pem'), key: path.join(dir, 'privkey.pem'), csr: path.join(dir, 'request.csr') };
}

function openssl(args, opts = {}) {
  const r = spawnSync('openssl', args, { encoding: 'utf8', timeout: 60000, ...opts });
  return { ok: r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}`.trim(), status: r.status };
}

export function certInfo(certPemPath) {
  const r = openssl(['x509', '-in', certPemPath, '-noout', '-enddate', '-subject']);
  if (!r.ok) return null;
  const end = /notAfter=(.+)/.exec(r.output)?.[1]?.trim();
  const subject = /subject=(.+)/.exec(r.output)?.[1]?.trim();
  const expiry = end ? new Date(end) : null;
  return {
    expiresAt: expiry && !Number.isNaN(expiry.getTime()) ? expiry.toISOString() : null,
    subject,
  };
}

export function validatePem(cert, key) {
  const dir = fs.mkdtempSync(path.join(config.dataDir, 'cert-check-'));
  try {
    const c = path.join(dir, 'c.pem');
    const k = path.join(dir, 'k.pem');
    fs.writeFileSync(c, cert);
    fs.writeFileSync(k, key);
    const info = openssl(['x509', '-in', c, '-noout', '-enddate']);
    if (!info.ok) return { ok: false, error: 'Certificate is not a valid PEM certificate' };
    const keyOk = openssl(['pkey', '-in', k, '-noout']);
    if (!keyOk.ok) return { ok: false, error: 'Private key is not a valid PEM key' };
    const certMod = openssl(['x509', '-in', c, '-noout', '-modulus']).output;
    const keyMod = openssl(['rsa', '-in', k, '-noout', '-modulus']).output;
    if (certMod && keyMod && certMod !== keyMod) return { ok: false, error: 'Certificate and key do not match' };
    const exp = /notAfter=(.+)/.exec(info.output)?.[1]?.trim();
    return { ok: true, expiresAt: exp ? new Date(exp).toISOString() : null };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function generateSelfSigned(domain, days = 365) {
  const paths = certPaths(domain);
  const keyType = setting('ssl_key_type', 'rsa2048');
  const keyArgs = keyType === 'ecdsa-p256' ? ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256'] : keyType === 'rsa4096' ? ['-newkey', 'rsa:4096'] : ['-newkey', 'rsa:2048'];
  const r = openssl(['req', '-x509', ...keyArgs, '-nodes', '-days', String(days),
    '-keyout', paths.key, '-out', paths.cert, '-subj', `/CN=${domain}`,
    '-addext', `subjectAltName=DNS:${domain},DNS:www.${domain}`]);
  if (!r.ok) return { ok: false, error: r.output || 'openssl failed' };
  const info = certInfo(paths.cert);
  if (!info) return { ok: false, error: 'Generated certificate could not be parsed' };
  run('UPDATE ssl_certs SET status = ? WHERE domain = ?', 'replaced', domain);
  run(`INSERT INTO ssl_certs(domain, username, type, issuer, expires_at, status, cert, key, created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    domain, null, 'self-signed', `OpenAdmin Self-Signed (${domain})`, info.expiresAt, 'active',
    fs.readFileSync(paths.cert, 'utf8'), fs.readFileSync(paths.key, 'utf8'), nowIso());
  run("UPDATE ssl_certs SET key_type = ? WHERE domain = ? AND status = 'active'", keyType, domain);
  return { ok: true, expiresAt: info.expiresAt, paths };
}

export function certbotAvailable() {
  const r = spawnSync('sh', ['-c', 'command -v certbot'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

export function issueLetsEncrypt(domain, docroot, email = '') {
  const bin = certbotAvailable();
  if (!bin) return { ok: false, error: 'certbot is not installed; install certbot or use a self-signed certificate' };
  const args = ['certonly', '--webroot', '-w', docroot, '-d', domain, '-d', `www.${domain}`,
    '--non-interactive', '--agree-tos', '--email', email || `admin@${domain}`, '--keep-until-expiring'];
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 180000 });
  if (r.status !== 0) return { ok: false, error: `${(r.stderr || r.stdout || '').trim().slice(-600)}` };
  const live = `/etc/letsencrypt/live/${domain}`;
  const certFile = path.join(live, 'fullchain.pem');
  const keyFile = path.join(live, 'privkey.pem');
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) return { ok: false, error: 'certbot succeeded but certificates were not found' };
  const paths = certPaths(domain);
  fs.copyFileSync(certFile, paths.cert);
  fs.copyFileSync(keyFile, paths.key);
  return installPem(domain, fs.readFileSync(paths.cert, 'utf8'), fs.readFileSync(paths.key, 'utf8'), 'letsencrypt');
}

export function installPem(domain, cert, key, type = 'custom') {
  const check = validatePem(cert, key);
  if (!check.ok) return { ok: false, error: check.error };
  const paths = certPaths(domain);
  fs.writeFileSync(paths.cert, cert, { mode: 0o600 });
  fs.writeFileSync(paths.key, key, { mode: 0o600 });
  run('UPDATE ssl_certs SET status = ? WHERE domain = ?', 'expired', domain);
  run(`INSERT INTO ssl_certs(domain, username, type, issuer, expires_at, status, cert, key, created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    domain, null, type, type === 'letsencrypt' ? "Let's Encrypt" : 'Uploaded certificate', check.expiresAt, 'active', cert, key, nowIso());
  run('UPDATE domains SET ssl = 1 WHERE name = ?', domain);
  return { ok: true, expiresAt: check.expiresAt, paths };
}

export function activeCert(domain) {
  const row = get("SELECT * FROM ssl_certs WHERE domain = ? AND status = 'active' AND cert IS NOT NULL ORDER BY id DESC LIMIT 1", domain);
  if (!row) return null;
  const paths = certPaths(domain);
  if (!fs.existsSync(paths.cert) && row.cert) fs.writeFileSync(paths.cert, row.cert, { mode: 0o600 });
  if (!fs.existsSync(paths.key) && row.key) fs.writeFileSync(paths.key, row.key, { mode: 0o600 });
  return { row, paths, webPaths: certWebPaths(domain) };
}

export function providerCerts() {
  return { provider: systemProvider().id, directory: path.join(config.dataDir, 'ssl') };
}

export function sslStatus() {
  return {
    certbot: certbotAvailable() || null,
    openssl: openssl(['version']).ok,
    directory: path.join(config.dataDir, 'ssl'),
    autoRenew: setting('ssl_autorenew', '1') === '1',
  };
}
