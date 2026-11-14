// Panel branding, ACL, network ports and settings export/import.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';
import { setting, setSetting, audit } from './db.mjs';
import { getJson, setJson } from './json.mjs';
import { restartPanel } from './setup.mjs';

const ALLOWED_EXPORT = ['brand_name', 'brand_subtitle', 'brand_logo', 'brand_footer', 'webmail_name', 'support_url', 'timezone', 'panel_hostname', 'admin_alias', 'admin_port', 'enduser_port', 'panel_acl', 'disabled_features'];

export function branding() {
  return {
    name: setting('brand_name', 'OpenAdmin'),
    subtitle: setting('brand_subtitle', 'Control Panel'),
    logo: setting('brand_logo', ''),
    footer: setting('brand_footer', 'OpenAdmin · free & open source (AGPL-3.0)'),
    webmail: setting('webmail_name', 'Webmail'),
    support: setting('support_url', ''),
    timezone: setting('timezone', 'Europe/Warsaw'),
  };
}

export function saveBranding(body, actor = 'admin') {
  const vals = {
    brand_name: String(body.name || '').trim().slice(0, 60) || 'OpenAdmin',
    brand_subtitle: String(body.subtitle || '').trim().slice(0, 80),
    brand_logo: String(body.logo || '').trim().slice(0, 500),
    brand_footer: String(body.footer || '').trim().slice(0, 300),
    webmail_name: String(body.webmail || '').trim().slice(0, 60) || 'Webmail',
    support_url: String(body.support || '').trim().slice(0, 500),
    timezone: String(body.timezone || '').trim().slice(0, 80),
  };
  if (vals.brand_logo && !/^https?:\/\/|^\//.test(vals.brand_logo)) return { ok: false, error: 'Logo URL musi być http(s) lub ścieżką /' };
  for (const [k, v] of Object.entries(vals)) setSetting(k, v);
  audit(actor, 'admin', 'panel.branding', vals.brand_name, '');
  return { ok: true };
}

export function acl() {
  return getJson('panel_acl', {
    disable_domains: false, disable_emails: false, disable_ssh: false, disable_system_apps: false,
    max_addon_domains: 0, read_only: false,
  });
}

export function saveAcl(body, actor = 'admin') {
  const next = {
    disable_domains: !!body.disable_domains, disable_emails: !!body.disable_emails,
    disable_ssh: !!body.disable_ssh, disable_system_apps: !!body.disable_system_apps,
    max_addon_domains: Math.max(0, Number(body.max_addon_domains || 0)),
    read_only: !!body.read_only,
  };
  setJson('panel_acl', next);
  audit(actor, 'admin', 'panel.acl', JSON.stringify(next), '');
  return { ok: true, acl: next };
}

export function network() {
  return {
    hostname: setting('panel_hostname', setting('server_name', 'localhost')),
    port: Number(setting('admin_port', config.port) || config.port),
    alias: setting('admin_alias', ''),
    enduserPort: Number(setting('enduser_port', 2002) || 2002),
    https: config.https,
  };
}

export function saveNetwork(body, actor = 'admin') {
  const port = Number(body.port || config.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'Port musi być 1–65535' };
  setSetting('panel_hostname', String(body.hostname || '').trim());
  setSetting('admin_port', String(port));
  setSetting('admin_alias', String(body.alias || '').trim().replace(/[^a-zA-Z0-9_.-]/g, ''));
  setSetting('enduser_port', String(Math.max(1, Math.min(65535, Number(body.enduserPort || 2002)))));
  const envFile = path.join(config.dataDir, 'openadmin.env');
  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, 'utf8').split('\n');
    const set = (k, v) => { const i = lines.findIndex((l) => l.startsWith(k + '=')); if (i >= 0) lines[i] = `${k}=${v}`; else lines.push(`${k}=${v}`); };
    set('OA_PORT', port);
    fs.writeFileSync(envFile, lines.join('\n'), { mode: 0o600 });
  }
  audit(actor, 'admin', 'panel.network', `port ${port}`, '');
  return { ok: true, restart: 'Potrzebny restart panelu, aby zmienić port.' };
}

export function exportSettings() {
  const out = { product: 'OpenAdmin', version: 1, exported_at: new Date().toISOString() };
  for (const k of ALLOWED_EXPORT) out[k] = k.endsWith('_features') || k === 'panel_acl' ? getJson(k, null) : setting(k, null);
  return out;
}

export function importSettings(raw, actor = 'admin') {
  let data;
  try { data = JSON.parse(String(raw)); } catch { return { ok: false, error: 'Nieprawidłowy JSON' }; }
  if (!data || typeof data !== 'object') return { ok: false, error: 'Oczekiwano obiektu JSON' };
  let count = 0;
  for (const k of ALLOWED_EXPORT) {
    if (data[k] === undefined) continue;
    if (k === 'panel_acl' || k === 'disabled_features') setJson(k, data[k]);
    else setSetting(k, String(data[k]));
    count++;
  }
  audit(actor, 'admin', 'panel.import', `${count} keys`, '');
  return { ok: true, count };
}

export function restartNow() { return restartPanel(); }
