// AutoSSL: key types, issuance/renewal log, service certificate installation.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';
import { all, get, run, nowIso, setting, setSetting, audit } from './db.mjs';
import { generateSelfSigned, issueLetsEncrypt, certbotAvailable, certPaths, validatePem } from './ssl.mjs';
import { writeManaged, backupFile, serviceReload, sh, which, isRoot } from './sys.mjs';

export function sslKeyType() { return setting('ssl_key_type', 'rsa2048'); }
export function setSslKeyType(type, actor = 'admin') {
  if (!['rsa2048', 'rsa4096', 'ecdsa-p256'].includes(type)) return { ok: false, error: 'Nieprawidłowy typ klucza' };
  setSetting('ssl_key_type', type);
  audit(actor, 'admin', 'ssl.keytype', type, '');
  return { ok: true };
}

export function logSsl(domain, action, status, detail = '') {
  run('INSERT INTO autossl_log(domain, action, status, detail, created_at) VALUES(?,?,?,?,?)', domain, action, status, String(detail).slice(0, 1000), nowIso());
}

export function logs(limit = 100) { return all('SELECT * FROM autossl_log ORDER BY id DESC LIMIT ?', Number(limit)); }

export function autoSslStatus() {
  const certs = all("SELECT id, domain, type, expires_at, status, key_type FROM ssl_certs WHERE status = 'active' ORDER BY expires_at");
  return {
    certs,
    expiring: certs.filter((c) => c.expires_at && new Date(c.expires_at).getTime() - Date.now() < 30 * 864e5),
    certbot: certbotAvailable(),
    keyType: sslKeyType(),
    logs: logs(20),
  };
}

export function issueCertificate(domain, { email = '', actor = 'admin' } = {}) {
  const d = get('SELECT * FROM domains WHERE name = ?', domain);
  if (!d) return { ok: false, error: 'Domena nie istnieje' };
  const certbot = certbotAvailable();
  let r;
  if (certbot) r = issueLetsEncrypt(domain, d.docroot, email || setting('admin_email', `admin@${domain}`));
  else r = generateSelfSigned(domain, 365);
  logSsl(domain, certbot ? 'letsencrypt' : 'selfsigned', r.ok ? 'ok' : 'error', r.error || r.expiresAt || '');
  audit(actor, 'admin', 'ssl.issue', domain, '');
  return r;
}

export function renewExpiring(actor = 'scheduler') {
  const soon = all("SELECT * FROM ssl_certs WHERE status = 'active' AND expires_at IS NOT NULL").filter((c) => new Date(c.expires_at).getTime() - Date.now() < 30 * 864e5);
  const out = [];
  for (const c of soon) {
    const d = get('SELECT * FROM domains WHERE name = ?', c.domain);
    if (!d) continue;
    const r = c.type === 'letsencrypt' && certbotAvailable() ? issueLetsEncrypt(c.domain, d.docroot, setting('admin_email', '')) : generateSelfSigned(c.domain, 365);
    logSsl(c.domain, 'renew', r.ok ? 'ok' : 'error', r.error || r.expiresAt || '');
    out.push({ domain: c.domain, ok: r.ok, error: r.error });
  }
  return out;
}

export function installServiceCert(domain, actor = 'admin') {
  const row = get("SELECT * FROM ssl_certs WHERE domain = ? AND status = 'active' ORDER BY id DESC LIMIT 1", domain);
  if (!row?.cert || !row?.key) return { ok: false, error: 'Brak aktywnego certyfikatu z kluczem' };
  const check = validatePem(row.cert, row.key);
  if (!check.ok) return { ok: false, error: check.error };
  const crt = `/etc/openadmin/service-tls/${domain}.crt`;
  const key = `/etc/openadmin/service-tls/${domain}.key`;
  writeManaged(crt, row.cert, { mode: 0o644 });
  writeManaged(key, row.key, { mode: 0o600 });
  if (config.provider === 'linux') {
    if (!isRoot()) return { ok: false, error: 'Root privileges required' };
    const exim = which('exim4') || which('exim');
    if (exim) {
      const conf = '/etc/exim4/conf.d/main/99_openadmin_service_tls';
      fs.mkdirSync(path.dirname(conf), { recursive: true });
      backupFile(conf);
      fs.writeFileSync(conf, `# Managed by OpenAdmin\ntls_certificate = ${crt}\ntls_privatekey = ${key}\n`, { mode: 0o644 });
      sh('update-exim4.conf');
      sh('systemctl', ['reload', 'exim4']);
    }
    if (which('doveconf')) {
      const conf = '/etc/dovecot/conf.d/99-openadmin-service-tls.conf';
      fs.mkdirSync(path.dirname(conf), { recursive: true });
      backupFile(conf);
      fs.writeFileSync(conf, `ssl_cert = <${crt}\nssl_key = <${key}\n`, { mode: 0o644 });
      const test = sh('doveconf', ['-n']);
      if (!test.ok) return { ok: false, error: `Dovecot config failed: ${test.stderr || test.error}` };
      serviceReload('dovecot');
    }
  }
  logSsl(domain, 'service-cert', 'ok', 'Exim/Dovecot');
  audit(actor, 'admin', 'ssl.service_cert', domain, '');
  return { ok: true, simulated: config.provider !== 'linux' };
}
