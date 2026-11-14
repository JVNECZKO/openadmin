// First-run configuration and panel HTTPS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { config } from './config.mjs';
import { get, run, setting, setSetting, nowIso, hashPassword } from './db.mjs';
import { applyAll } from './apply.mjs';
import { systemProvider } from './providers/index.mjs';

export function detectedAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const addr of list || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push({ iface: name, address: addr.address });
    }
  }
  return out;
}

export function setupState() {
  return {
    complete: setting('setup_complete', '0') === '1',
    https: config.https || setting('panel_https', '0') === '1',
    serverName: setting('server_name', os.hostname()),
    panelHostname: setting('panel_hostname', setting('server_name', os.hostname())),
    serverIp: setting('server_ip', config.defaults.serverIp),
    ns1: setting('ns1', config.defaults.nameserver1),
    ns2: setting('ns2', config.defaults.nameserver2),
    webServer: setting('web_server', 'nginx'),
    adminEmail: get("SELECT email FROM users WHERE level='admin' ORDER BY id LIMIT 1")?.email || '',
    adminMustChange: get("SELECT must_change_password m FROM users WHERE level='admin' ORDER BY id LIMIT 1")?.m === 1,
    addresses: detectedAddresses(),
    hostname: os.hostname(),
    provider: systemProvider().id,
    certFile: path.join(config.dataDir, 'panel', 'panel.crt'),
  };
}

function updateEnv(updates) {
  const file = path.join(config.dataDir, 'openadmin.env');
  if (!fs.existsSync(file)) return { ok: false, error: 'Brak pliku openadmin.env' };
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const [key, value] of Object.entries(updates)) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (idx >= 0) lines[idx] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
  return { ok: true };
}

export function enablePanelHttps() {
  const dir = path.join(config.dataDir, 'panel');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cert = path.join(dir, 'panel.crt');
  const key = path.join(dir, 'panel.key');
  const host = setting('panel_hostname', setting('server_name', os.hostname()));
  const ip = setting('server_ip', '127.0.0.1');
  if (!/^[a-z0-9.-]+$/i.test(host)) return { ok: false, error: 'Nieprawidłowa nazwa hosta panelu' };
  if (!fs.existsSync(cert) || !fs.existsSync(key)) {
    const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825',
      '-keyout', key, '-out', cert, '-subj', `/CN=${host}`,
      '-addext', `subjectAltName=DNS:${host},IP:${ip}`], { encoding: 'utf8', timeout: 60000 });
    if (r.status !== 0) return { ok: false, error: `openssl: ${(r.stderr || '').trim()}` };
    fs.chmodSync(key, 0o600);
  }
  const env = updateEnv({ OA_HTTPS: '1', OA_CERT: cert, OA_KEY: key });
  if (!env.ok) return env;
  setSetting('panel_https', '1');
  setSetting('panel_hostname', host);
  return { ok: true, cert, key, host, restartRequired: true };
}

export function applySetup(body) {
  const serverName = String(body.server_name || '').trim();
  const serverIp = String(body.server_ip || '').trim();
  const ns1 = String(body.ns1 || '').trim();
  const ns2 = String(body.ns2 || '').trim();
  const hostname = String(body.panel_hostname || serverName).trim();
  if (serverIp && !/^\d{1,3}(\.\d{1,3}){3}$/.test(serverIp)) return { ok: false, error: 'Adres IP serwera jest nieprawidłowy' };
  if (serverName && !/^[a-z0-9.-]+$/i.test(serverName)) return { ok: false, error: 'Nazwa serwera jest nieprawidłowa' };
  if (body.web_server && ['nginx', 'apache', 'openlitespeed', 'litespeed'].includes(body.web_server)) setSetting('web_server', body.web_server);
  if (serverName) setSetting('server_name', serverName);
  if (hostname) setSetting('panel_hostname', hostname);
  if (serverIp) setSetting('server_ip', serverIp);
  if (ns1) setSetting('ns1', ns1);
  if (ns2) setSetting('ns2', ns2);

  const admin = get("SELECT * FROM users WHERE level='admin' ORDER BY id LIMIT 1");
  const firstRun = setting('setup_complete', '0') !== '1';
  if (firstRun && !body.admin_password) return { ok: false, error: 'Ustaw nowe hasło administratora (min. 10 znaków)' };
  if (admin) {
    if (body.admin_email) run('UPDATE users SET email = ? WHERE id = ?', String(body.admin_email).trim(), admin.id);
    if (body.admin_password) {
      if (String(body.admin_password).length < 10) return { ok: false, error: 'Hasło administratora musi mieć co najmniej 10 znaków' };
      run('UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?', hashPassword(String(body.admin_password)), admin.id);
      updateEnv({ OA_ADMIN_PASSWORD: String(body.admin_password) });
    }
  }
  let https = { ok: true, skipped: true };
  if (body.enable_https) https = enablePanelHttps();
  if (https && !https.ok) return https;
  const applied = applyAll();
  setSetting('setup_complete', '1');
  setSetting('setup_completed_at', nowIso());
  return { ok: true, applied, https, restartRequired: !!(https && https.restartRequired) };
}

export function restartPanel() {
  if (systemProvider().id !== 'linux') return { ok: true, simulated: true };
  const child = spawn('sh', ['-c', 'sleep 1; systemctl restart openadmin'], { detached: true, stdio: 'ignore' });
  child.unref();
  return { ok: true };
}
