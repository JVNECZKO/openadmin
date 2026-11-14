// Coherent site provisioning: one idempotent entry point used by the domain
// page, the "add a website" wizard and tests. It owns the order of operations
// (domain row → engine override → document root → DNS → subdomains → SSL →
// optional application → vhost generation/apply) and reports an honest,
// ordered step list instead of a single opaque "success".
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import net from 'node:net';
import { all, get, run, setting, setSetting, nowIso, audit, transaction, hashPassword, DEFAULT_PACKAGE_LIMITS } from './db.mjs';
import { config } from './config.mjs';
import { isDomain, isEmail, isIp, isUsername, randomPassword, safeJson } from './util.mjs';
import { quota } from './core/access.mjs';
import { limitsFor } from './auth.mjs';
import { passwordPolicyError } from './security.mjs';
import { createResetToken, resetLink } from './passwordreset.mjs';
import { userHome } from './paths.mjs';
import { provisionDomain } from './features/files.mjs';
import { SERVERS, activeServer, detect, stagingDir } from './webserver.mjs';
import { apply } from './apply.mjs';
import { rebuildZone, zonePath, zoneMeta } from './dns.mjs';
import { generateSelfSigned, issueLetsEncrypt, activeCert, certbotAvailable } from './ssl.mjs';
import { systemProvider } from './providers/index.mjs';
import { installWordPress } from './wordpress.mjs';
import { installNextcloud } from './nextcloud.mjs';
import { dovecotHash, syncMail } from './mail.mjs';
import { saveJob as saveBackupJob } from './backupcenter.mjs';
import { runHooks } from './plugins.mjs';
import {
  defaultZoneRecords, expandTemplateRecords, resolveTemplate, validateRecords,
  probeDelegation, ensureDkimRecord,
} from './dnsops.mjs';
import { enqueueAcme, logSsl, acmeDashboardLink, purgeAcmeForDomain } from './autossl.mjs';

export const ENGINE_IDS = Object.keys(SERVERS);
export const SSL_MODES = ['none', 'selfsigned', 'letsencrypt'];
export const APP_TYPES = ['none', 'wordpress', 'nextcloud'];
const MAX_SUBDOMAINS = 100;
const RESERVED_SUBDOMAINS = new Set(['www', 'mail', 'ftp', '@', 'localhost']);
const SUB_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const APP_USER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/* ------------------------------------------------------------- validation */

export function phpVersions() {
  const list = String(setting('php_versions', '8.4,8.3,8.2,8.1,7.4'))
    .split(',')
    .map((v) => v.trim())
    .filter((v) => /^\d+\.\d+$/.test(v));
  return list.length ? list : ['8.3'];
}

export function normalizeEngine(value, fallback = '') {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'ols' || raw === 'open-lite-speed' || raw === 'open_litespeed') return 'openlitespeed';
  if (raw === 'lite-speed' || raw === 'litespeed-enterprise') return 'litespeed';
  return raw;
}

export function normalizeSslMode(value, fallback = 'selfsigned') {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on', 'selfsigned', 'self-signed', 'self_signed', 'ss'].includes(raw)) return 'selfsigned';
  if (['letsencrypt', "let's encrypt", 'lets-encrypt', 'le', 'acme'].includes(raw)) return 'letsencrypt';
  if (['0', 'false', 'no', 'off', 'none', 'disabled'].includes(raw)) return 'none';
  return null;
}

/** Data used by the engine cards in the wizard and domain forms. */
export function engineChoices() {
  const detected = detect();
  const active = activeServer();
  const sandbox = systemProvider().id === 'sandbox';
  return ENGINE_IDS.map((id) => {
    const server = SERVERS[id];
    const info = detected[id] || {};
    const installed = !!info.installed;
    const available = installed || sandbox;
    return {
      id,
      label: info.label || server.label,
      installed,
      available,
      active: active.id === id,
      sandbox: sandbox && !installed,
      simulated: sandbox && !installed,
      binary: info.binary || null,
      service: info.service || null,
      status: installed ? 'detected' : sandbox ? 'sandbox' : 'unavailable',
      reason: installed
        ? `${info.binary?.path || server.binaries[0]}${info.binary?.version ? ` · ${info.binary.version}` : ''}`
        : sandbox
          ? 'sandbox: configuration is staged, no service is reloaded'
          : 'web server binary not detected on this host',
    };
  });
}

function validateEngine(engine) {
  if (!ENGINE_IDS.includes(engine)) {
    return { ok: false, code: 'invalid_engine', message: `Unknown web engine "${engine}". Use nginx, apache, openlitespeed or litespeed.` };
  }
  const info = engineChoices().find((e) => e.id === engine);
  if (!info?.available) {
    return { ok: false, code: 'engine_unavailable', message: `${info?.label || engine} is not installed on this host. Install it or choose another engine.` };
  }
  return { ok: true, engine, info };
}

function resolveUser(user) {
  if (!user || user.id === undefined || user.id === null || !user.username) return null;
  const row = get('SELECT * FROM users WHERE id = ?', Number(user.id));
  if (!row || row.username !== String(user.username)) return null;
  return row;
}

function normalizeSubdomains(input) {
  const raw = Array.isArray(input) ? input : input === undefined || input === null ? [] : [input];
  const list = [];
  const errors = [];
  const seen = new Set();
  for (const item of raw) {
    if (item === undefined || item === null) continue;
    const name = String(typeof item === 'object' ? (item.name ?? item.subdomain ?? '') : item).trim().toLowerCase();
    if (!name) continue;
    if (list.length >= MAX_SUBDOMAINS) {
      errors.push({ code: 'too_many_subdomains', message: `A maximum of ${MAX_SUBDOMAINS} subdomains can be created at once.` });
      break;
    }
    if (RESERVED_SUBDOMAINS.has(name) || !SUB_LABEL.test(name)) {
      errors.push({ code: 'invalid_subdomain', message: `"${name}" is not a valid subdomain label.` });
      continue;
    }
    if (seen.has(name)) {
      errors.push({ code: 'duplicate_subdomain', message: `Subdomain "${name}" is configured twice.` });
      continue;
    }
    const phpVersion = typeof item === 'object' && item.phpVersion ? String(item.phpVersion).trim() : '';
    if (phpVersion && !phpVersions().includes(phpVersion)) {
      errors.push({ code: 'invalid_php', message: `Unsupported PHP version "${phpVersion}" for subdomain "${name}".` });
      continue;
    }
    seen.add(name);
    list.push({ name, phpVersion: phpVersion || '' });
  }
  return { list, errors };
}

function normalizeApp(input) {
  if (input === undefined || input === null || input === false || input === '') return { app: { type: 'none' } };
  const app = typeof input === 'object' ? { ...input } : { type: String(input) };
  app.type = String(app.type || 'none').trim().toLowerCase();
  if (!APP_TYPES.includes(app.type)) {
    return { error: { code: 'invalid_app', message: `Unknown application "${app.type}". Choose none, wordpress or nextcloud.` } };
  }
  if (app.type === 'none') return { app: { type: 'none' } };
  app.adminUser = String(app.adminUser || 'admin').trim();
  app.adminEmail = String(app.adminEmail || '').trim();
  app.title = String(app.title || '').trim();
  app.adminPassword = String(app.adminPassword || '');
  if (!APP_USER.test(app.adminUser)) {
    return { error: { code: 'invalid_app_user', message: 'Application administrator name contains invalid characters.' } };
  }
  if (app.adminEmail && !isEmail(app.adminEmail)) {
    return { error: { code: 'invalid_app_email', message: 'Application administrator e-mail is not valid.' } };
  }
  if (app.adminPassword.length < 8) {
    return { error: { code: 'invalid_app_password', message: 'The application administrator password must be at least 8 characters long.' } };
  }
  return { app };
}

function asBool(value) {
  return value === true || value === 1 || ['1', 'true', 'yes', 'on', 'checked'].includes(String(value ?? '').trim().toLowerCase());
}

function failResult({ domain, engine, phpVersion, sslMode, errors, dbUser, ip }) {
  const steps = errors.map((e) => ({ key: e.code || 'validation', label: 'Validation', ok: false, detail: e.message }));
  if (dbUser) {
    try { audit(dbUser.username, dbUser.level, 'site.create.rejected', `${domain || '-'}: ${errors[0]?.code || 'validation'}`, ip || ''); } catch { /* audit is best effort */ }
  }
  return {
    ok: false,
    created: false,
    domain: domain || '',
    domainId: null,
    docroot: '',
    engine: engine || '',
    phpVersion: phpVersion || '',
    sslMode: sslMode || '',
    steps,
    errors,
    warnings: [],
    links: {},
    app: null,
  };
}

/* --------------------------------------------------------------- DNS zone */

/** Create the default zone records for a new domain. Also used by the legacy
 *  API/importer call sites (re-exported from features/domains.mjs). Idempotent:
 *  a second call refreshes the staged zone instead of duplicating records.
 *
 *  Records come from a package/reseller template when one is bound, otherwise
 *  from the built-in automatic set (A/AAAA/MX/SPF/DKIM/DMARC/autodiscover).
 *  The zone file path is internal data; user-facing steps show record counts. */
export function createZone(domainId, domain, {
  templateId = null, packageName = '', reseller = '', actor = '', dkim = true,
  ip = setting('server_ip', '127.0.0.1'), ipv6 = setting('server_ip6', ''),
} = {}) {
  const existing = all('SELECT id FROM dns_records WHERE domain_id = ?', domainId);
  const warnings = [];
  let chosen = { source: 'builtin', template: null };
  if (!existing.length) {
    const explicit = templateId ? get('SELECT * FROM dns_templates WHERE id = ?', Number(templateId)) : null;
    if (explicit) chosen = { source: 'template', template: explicit };
    else chosen = resolveTemplate({ packageName, reseller, domain });
    let records = [];
    if (chosen.template) {
      let parsed = [];
      try { parsed = JSON.parse(chosen.template.records || '[]'); } catch { parsed = []; }
      records = expandTemplateRecords(parsed, { domain });
    } else {
      records = defaultZoneRecords(domain, { ip, ipv6 });
    }
    const validation = validateRecords(records, { domain });
    if (!validation.ok) {
      return {
        ok: false,
        created: false,
        error: validation.errors.map((error) => error.message).join(' '),
        errors: validation.errors,
        warnings,
        records: 0,
        file: zonePath(domain),
      };
    }
    for (const record of validation.records) {
      run('INSERT INTO dns_records(domain_id, name, type, value, priority, ttl) VALUES(?,?,?,?,?,?)',
        domainId, record.name, record.type, record.value, record.priority ?? null, record.ttl || 3600);
    }
    // DKIM is generated after the base records, so generateDkim() can publish
    // its TXT record without creating a duplicate.
    const hasDkimTxt = validation.records.some((record) => record.type === 'TXT' && record.name.endsWith('._domainkey'));
    if (dkim && !hasDkimTxt) {
      try {
        const key = ensureDkimRecord(domain, { actor: actor || 'system', generate: true });
        if (!key.ok) warnings.push(key.error || 'Klucz DKIM nie został wygenerowany');
      } catch (error) {
        warnings.push(`DKIM: ${error.message}`);
      }
    }
  }
  let zone = null;
  try { zone = rebuildZone(domain); } catch (error) { warnings.push(`Zone staging: ${error.message}`); }
  return {
    ok: true,
    created: !existing.length,
    records: get('SELECT COUNT(*) n FROM dns_records WHERE domain_id = ?', domainId).n,
    file: zone?.file || zonePath(domain),
    template: chosen.template ? { id: chosen.template.id, name: chosen.template.name } : null,
    source: chosen.source,
    warnings,
    checked: !!zone?.check?.ok,
  };
}

/* --------------------------------------------------------------------- SSL */

/** Apply one SSL mode. Let's Encrypt falls back to a self-signed certificate
 *  with an explicit warning so the result never pretends ACME succeeded. */
export function applySsl({ domain, docroot, sslMode = 'selfsigned', email = '', force = false } = {}) {
  const mode = normalizeSslMode(sslMode);
  if (!isDomain(domain)) return { ok: false, key: 'ssl', label: 'SSL certificate', mode, detail: 'Invalid domain for SSL' };
  if (mode === null) return { ok: false, key: 'ssl', label: 'SSL certificate', mode: sslMode, detail: 'Unknown SSL mode' };
  if (mode === 'none') {
    run("UPDATE ssl_certs SET status = 'disabled' WHERE domain = ? AND status = 'active'", domain);
    run('UPDATE domains SET ssl = 0 WHERE name = ?', domain);
    try { logSsl(domain, 'disable', 'ok', 'SSL disabled by site provisioning'); } catch { /* log is best effort */ }
    return { ok: true, key: 'ssl', label: 'SSL certificate', mode, skipped: true, detail: 'SSL disabled — the site is served over HTTP only' };
  }
  const current = activeCert(domain);
  if (!force && current) {
    if (mode === 'selfsigned' && current.row.type === 'self-signed') {
      run('UPDATE domains SET ssl = 1 WHERE name = ?', domain);
      return { ok: true, key: 'ssl', label: 'SSL certificate', mode, skipped: true, detail: 'A self-signed certificate is already active' };
    }
    if (mode === 'letsencrypt' && current.row.type === 'letsencrypt') {
      run('UPDATE domains SET ssl = 1 WHERE name = ?', domain);
      return { ok: true, key: 'ssl', label: 'SSL certificate', mode, skipped: true, detail: "A Let's Encrypt certificate is already active" };
    }
  }
  const days = Number(setting('ssl_selfsigned_days', '365')) || 365;
  if (mode === 'selfsigned') {
    try {
      const cert = generateSelfSigned(domain, days);
      if (!cert.ok) return { ok: false, key: 'ssl', label: 'SSL certificate', mode, detail: `Self-signed certificate failed: ${cert.error}` };
      run('UPDATE domains SET ssl = 1 WHERE name = ?', domain);
      try { logSsl(domain, 'selfsigned', 'ok', cert.expiresAt || ''); } catch { /* log is best effort */ }
      return { ok: true, key: 'ssl', label: 'SSL certificate', mode, expiresAt: cert.expiresAt, detail: `Self-signed certificate installed (expires ${cert.expiresAt || 'unknown'})` };
    } catch (e) {
      return { ok: false, key: 'ssl', label: 'SSL certificate', mode, detail: `Self-signed certificate failed: ${e.message}` };
    }
  }
  // Let's Encrypt, with an honest self-signed fallback.
  let acme;
  try { acme = issueLetsEncrypt(domain, docroot, email || ''); }
  catch (e) { acme = { ok: false, error: e.message }; }
  if (acme.ok) {
    run('UPDATE domains SET ssl = 1 WHERE name = ?', domain);
    try { logSsl(domain, 'letsencrypt', 'ok', acme.expiresAt || ''); } catch { /* log is best effort */ }
    return { ok: true, key: 'ssl', label: 'SSL certificate', mode, detail: "Let's Encrypt certificate installed" };
  }
  const warning = `Let's Encrypt failed (${acme.error || 'unknown error'}); a self-signed certificate was used as the fallback.`;
  try { logSsl(domain, 'letsencrypt', 'error', acme.error || 'unknown error'); } catch { /* log is best effort */ }
  const stillActive = activeCert(domain);
  if (stillActive && stillActive.row.type === 'self-signed') {
    run('UPDATE domains SET ssl = 1 WHERE name = ?', domain);
    return { ok: true, key: 'ssl', label: 'SSL certificate', mode, fallback: true, warning, detail: `${warning} The existing self-signed certificate remains active.` };
  }
  try {
    const fallback = generateSelfSigned(domain, days);
    if (!fallback.ok) {
      return { ok: false, key: 'ssl', label: 'SSL certificate', mode, fallback: true, warning, detail: `${warning} Self-signed fallback also failed: ${fallback.error}` };
    }
    run('UPDATE domains SET ssl = 1 WHERE name = ?', domain);
    return { ok: true, key: 'ssl', label: 'SSL certificate', mode, fallback: true, warning, detail: `${warning} Installed a self-signed fallback (expires ${fallback.expiresAt || 'unknown'}).` };
  } catch (e) {
    return { ok: false, key: 'ssl', label: 'SSL certificate', mode, fallback: true, warning, detail: `${warning} Self-signed fallback also failed: ${e.message}` };
  }
}

/* ---------------------------------------------------------------- vhosts */

function runApply(flags) {
  try { return apply(flags); }
  catch (e) { return { ok: false, steps: [], error: e.message }; }
}

function vhostStep({ domain, engine, applyResult }) {
  const server = SERVERS[engine] || activeServer();
  const active = activeServer();
  const web = (applyResult.steps || []).find((s) => s.part === 'web') || {};
  let file = '';
  let generated = false;
  try {
    file = path.join(stagingDir(server), 'sites', `${domain}${server.ext}`);
    generated = fs.existsSync(file) && fs.statSync(file).size > 0;
  } catch { generated = false; }
  const activeEngine = active.id === server.id;
  const deployOk = !web.error && web.ok !== false;
  const simulated = !!web.simulated;
  let ok = generated && (activeEngine ? deployOk : true);
  let detail;
  if (web.error) detail = `Vhost generation failed: ${web.error}`;
  else if (!generated) detail = `Expected vhost file was not generated at ${file || '(staging unavailable)'}`;
  else if (activeEngine && !deployOk) detail = `Vhost generated, but deployment failed: ${web.output || 'unknown error'}`;
  else if (simulated) detail = `Generated ${server.label} vhost ${file} (sandbox: staged only, service not reloaded)${activeEngine ? '' : `; active server is ${active.label}`}`;
  else if (activeEngine) detail = `Generated and deployed ${server.label} vhost ${file}`;
  else detail = `Generated ${server.label} vhost ${file}; active server is ${active.label}`;
  let warning = '';
  if (!activeEngine) {
    warning = `The ${server.label} vhost was generated, but the active web server is ${active.label}. Activate ${server.label} in Web Server or keep this per-domain override for staging.`;
  }
  return {
    key: 'vhost',
    label: 'Web server config',
    ok,
    generated,
    deployed: activeEngine && deployOk && !simulated,
    simulated,
    engine: server.id,
    activeEngine,
    file,
    detail,
    warning,
  };
}

function deployDnsStep({ domain, domainId, createDns, applyResult }) {
  const count = get('SELECT COUNT(*) n FROM dns_records WHERE domain_id = ?', domainId)?.n || 0;
  if (!createDns) {
    return { key: 'dns', label: 'DNS zone', ok: true, skipped: true, records: count, detail: 'DNS zone was not requested' };
  }
  const dns = (applyResult.steps || []).find((s) => s.part === 'dns') || {};
  const ok = count > 0 && !dns.error && dns.ok !== false;
  const meta = zoneMeta(domain);
  let detail;
  // Zone file paths are internal; users see the record count and validation
  // state. The expert-mode DNS page is the only place that can reveal a path.
  if (!count) detail = 'No DNS records were created';
  else if (dns.error) detail = `Zone built but deployment failed: ${dns.error}`;
  else if (dns.ok === false) detail = `Zone built but deployment failed: ${dns.output || 'unknown error'}`;
  else if (dns.simulated) detail = `${count} rekord(ów) DNS przygotowanych i zwalidowanych (sandbox: serwer DNS nie został przeładowany)`;
  else detail = `${count} rekord(ów) DNS wdrożonych${meta?.checked ? ' i zwalidowanych' : ''}`;
  return {
    key: 'dns',
    label: 'DNS zone',
    ok,
    simulated: !!dns.simulated,
    records: count,
    detail,
  };
}

function saveStatus(domain, payload) {
  if (!isDomain(domain) || !payload) return;
  const steps = (payload.steps || []).slice(0, 40).map((s) => ({
    key: String(s.key || ''),
    label: String(s.label || ''),
    ok: !!s.ok,
    skipped: !!s.skipped,
    detail: String(s.detail || '').slice(0, 900),
  }));
  const warnings = (payload.warnings || []).slice(0, 20).map((w) => String(w).slice(0, 900));
  const body = {
    at: nowIso(),
    ok: !!payload.ok,
    created: !!payload.created,
    engine: String(payload.engine || ''),
    phpVersion: String(payload.phpVersion || ''),
    sslMode: String(payload.sslMode || ''),
    dnsTemplate: payload.dnsTemplate || null,
    options: payload.options && typeof payload.options === 'object' ? payload.options : null,
    steps,
    warnings,
  };
  setSetting(`site_provision_last:${domain}`, JSON.stringify(body));
}

/** Persist the last provisioning result for the edit page. Secrets are never
 *  included: only step keys/labels/details and warnings are stored. */
export function saveSiteStatus(domain, payload) {
  saveStatus(domain, payload);
}

export function lastProvision(domain) {
  if (!isDomain(domain)) return null;
  const row = get('SELECT value FROM settings WHERE key = ?', `site_provision_last:${domain}`);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

function removeDocroot(username, domain) {
  if (!isUsername(username) || !isDomain(domain)) return false;
  const base = path.resolve(userHome(username), 'domains');
  const dir = path.resolve(base, domain);
  if (dir !== path.join(base, domain) || !dir.startsWith(base + path.sep)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function pruneStaleVhosts(domain, keepEngine) {
  if (!isDomain(domain)) return [];
  const removed = [];
  const subdomains = all(`SELECT s.name FROM subdomains s JOIN domains d ON d.id = s.domain_id WHERE d.name = ?`, domain);
  for (const server of Object.values(SERVERS)) {
    if (server.id === keepEngine) continue;
    for (const name of [domain, ...subdomains.map((sub) => `${sub.name}.${domain}`)]) {
      const candidates = [];
      try { candidates.push(path.join(stagingDir(server), 'sites', `${name}${server.ext}`)); } catch { /* staging unavailable */ }
      candidates.push(path.join(server.availableDir, `${name}${server.ext}`));
      candidates.push(path.join(server.enabledDir, `${name}${server.ext}`));
      candidates.push(path.join(server.availableDir, name));
      for (const candidate of candidates) {
        try {
          if (!fs.existsSync(candidate)) continue;
          fs.rmSync(candidate, { recursive: true, force: true });
          removed.push(candidate);
        } catch { /* permission or system path: keep going */ }
      }
    }
  }
  return removed;
}

/** Remove generated, staged and deployed vhost artefacts for one domain.
 *  Missing files/directories are ignored; no other domain is touched. */
export function removeVhost(domain) {
  if (!isDomain(domain)) return { ok: false, removed: [], detail: 'Invalid domain' };
  const removed = pruneStaleVhosts(domain, null);
  setSetting(`web_server:${domain}`, '');
  return { ok: true, removed };
}

/** Delete filesystem artefacts that belong to a removed domain. Database rows
 *  are deleted by the caller; this only touches the account home, the staged
 *  vhosts and the panel certificate directory. */
export function cleanupDomainFiles({ user, domain } = {}) {
  const username = typeof user === 'string' ? user : user?.username;
  if (!isUsername(username) || !isDomain(domain)) return { ok: false, detail: 'Unsafe cleanup target' };
  // LiteSpeed writes one config per subdomain; remove those before the parent.
  const subs = all(`SELECT s.name FROM subdomains s JOIN domains d ON d.id = s.domain_id WHERE d.name = ?`, domain);
  for (const sub of subs) {
    try { removeVhost(`${sub.name}.${domain}`); } catch { /* best effort */ }
  }
  const vhost = removeVhost(domain);
  const files = removeDocroot(username, domain);
  const certs = path.join(config.dataDir, 'ssl', domain.replace(/[^a-z0-9.-]/gi, '_'));
  try { fs.rmSync(certs, { recursive: true, force: true }); } catch { /* ignore */ }
  return { ok: true, vhost, files, detail: `Removed domain artefacts for ${domain}` };
}

/** Explicit, safe rollback of a domain created by this call. It is never used
 *  when an application installer succeeded (its database would be orphaned). */
function rollbackCreatedSite({ user, domain, domainId }) {
  if (!isDomain(domain) || !isUsername(user.username)) return { ok: false, detail: 'Unsafe rollback target' };
  try {
    try { purgeAcmeForDomain(domain); } catch { /* queue cleanup is best effort */ }
    try { run('DELETE FROM backup_jobs WHERE name = ? AND target_user = ?', `site:${domain}`, user.username); } catch { /* best effort */ }
    cleanupDomainFiles({ user, domain });
    run('DELETE FROM ssl_certs WHERE domain = ?', domain);
    run('DELETE FROM domains WHERE id = ?', domainId);
    setSetting(`web_server:${domain}`, '');
    for (const key of [`site_monitoring:${domain}`, `site_provision_last:${domain}`]) run('DELETE FROM settings WHERE key = ?', key);
    try { fs.rmSync(zonePath(domain), { force: true }); } catch { /* ignore */ }
    return { ok: true, detail: `Rolled back the partially created domain ${domain} (vhost, DNS zone, files, backup profile, rows)` };
  } catch (e) {
    return { ok: false, detail: `Rollback failed: ${e.message}` };
  }
}

export function provisionSubdomainRoot(username, domain, name) {
  if (!isUsername(username) || !isDomain(domain) || !SUB_LABEL.test(String(name || ''))) {
    throw new Error('Invalid subdomain provisioning target');
  }
  const base = path.resolve(userHome(username), 'domains', domain, 'public_html');
  const root = path.resolve(base, name);
  if (!root.startsWith(base + path.sep)) throw new Error('Subdomain document root escapes the domain');
  fs.mkdirSync(root, { recursive: true });
  const index = path.join(root, 'index.html');
  if (!fs.existsSync(index)) {
    fs.writeFileSync(index, `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${name}.${domain}</title></head>\n<body><h1>${name}.${domain}</h1><p>This subdomain is hosted on OpenAdmin.</p></body></html>\n`, 'utf8');
  }
  try { systemProvider().chownUser(username); } catch { /* provider best effort */ }
  return `/home/${username}/domains/${domain}/public_html/${name}`;
}

/* ------------------------------------------------------ account provisioning */

const RESERVED_USERNAMES = new Set([
  'root', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail', 'news', 'uucp', 'proxy',
  'www-data', 'backup', 'list', 'irc', 'gnats', 'nobody', 'systemd', 'mysql', 'postgres',
  'exim', 'dovecot', 'bind', 'named', 'apache', 'nginx', 'nologin', 'halt', 'shutdown',
]);

/** Generate a password that satisfies the panel policy instead of assuming a
 *  fixed alphabet always covers every required character class. */
export function randomStrongPassword(length = 20) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = randomPassword(Math.max(12, Number(length) || 20));
    if (!passwordPolicyError(candidate)) return candidate;
  }
  return randomPassword(64);
}

function asMailbox(input) {
  if (input === undefined || input === null || input === false || input === '') return null;
  if (input === true) return { local: 'postmaster', quotaMb: 1024 };
  if (typeof input === 'string') return { local: input, quotaMb: 1024 };
  if (typeof input === 'object') {
    return {
      local: String(input.local || input.localPart || input.mailbox || 'postmaster').trim().toLowerCase(),
      quotaMb: Number(input.quotaMb ?? input.quota_mb ?? input.quota ?? 1024),
      password: String(input.password || ''),
    };
  }
  return null;
}

function mailboxPreflight(mailbox, { domain, pkg }) {
  if (!mailbox) return { ok: true, mailbox: null };
  if (!domain) return { ok: false, error: 'Skrzynka podstawowa wymaga domeny.' };
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(mailbox.local)) return { ok: false, error: 'Nieprawidłowa nazwa skrzynki podstawowej.' };
  if (!Number.isFinite(mailbox.quotaMb) || mailbox.quotaMb < 0) return { ok: false, error: 'Nieprawidłowy limit skrzynki (MB).' };
  const limits = pkg ? { ...DEFAULT_PACKAGE_LIMITS, ...safeJson(pkg.limits, {}) } : { ...DEFAULT_PACKAGE_LIMITS };
  if (Number(limits.emails) > 0 && Number(limits.emails) < 1) return { ok: false, error: 'Pakiet nie pozwala na utworzenie skrzynki e-mail.' };
  if (Number(limits.email_quota_mb) > 0 && mailbox.quotaMb > Number(limits.email_quota_mb)) {
    return { ok: false, error: `Limit skrzynki w pakiecie to ${limits.email_quota_mb} MB.` };
  }
  return { ok: true, mailbox };
}

function ipPreflight(ip, { owner = '' } = {}) {
  const value = String(ip || setting('server_ip', '127.0.0.1')).trim();
  if (!isIp(value) || net.isIP(value) === 0) return { ok: false, error: 'Nieprawidłowy adres IP.' };
  if (value === setting('server_ip', '127.0.0.1')) return { ok: true, ip: value };
  const row = get('SELECT * FROM ips WHERE ip = ?', value);
  if (!row || row.status === 'free') return { ok: false, error: `Adres ${value} nie jest przypisany do panelu.` };
  if (row.owner && owner && row.owner !== owner) return { ok: false, error: `Adres ${value} należy do innego konta.` };
  return { ok: true, ip: value };
}

function resolveAccountPackage(body, actor, level, owner) {
  const requested = String(body.package || '').trim();
  const inlineName = String(body.new_package_name || '').trim();
  const wantsInline = !!inlineName && (!requested || requested === '__new__');
  if (wantsInline) {
    if (!/^[a-zA-Z0-9_.-]{2,40}$/.test(inlineName)) return { ok: false, error: 'Nieprawidłowa nazwa pakietu inline.' };
    if (get('SELECT id FROM packages WHERE lower(name) = lower(?)', inlineName)) return { ok: false, error: 'Pakiet o tej nazwie już istnieje.' };
    const defaults = { ...DEFAULT_PACKAGE_LIMITS };
    let parsed = {};
    try { parsed = body.new_package_limits ? JSON.parse(String(body.new_package_limits)) : {}; } catch { parsed = {}; }
    const limits = { ...defaults, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    for (const key of ['domains', 'subdomains', 'emails', 'email_quota_mb', 'ftp', 'databases', 'bandwidth_mb', 'disk_mb', 'cron', 'ssl']) {
      if (body[`new_limit_${key}`] !== undefined && String(body[`new_limit_${key}`]) !== '') limits[key] = Math.max(0, Number(body[`new_limit_${key}`]) || 0);
    }
    if (body.new_package_php) {
      const list = [].concat(body.new_package_php).map(String).filter((value) => ['8.4', '8.3', '8.2', '8.1', '7.4'].includes(value));
      if (list.length) limits.php = list;
    }
    return {
      ok: true,
      inline: {
        name: inlineName,
        type: level === 'reseller' ? 'reseller' : 'user',
        owner: actor.level === 'reseller' ? actor.username : (owner || null),
        limits,
      },
      pkg: { name: inlineName, type: level === 'reseller' ? 'reseller' : 'user', owner: actor.level === 'reseller' ? actor.username : (owner || null), limits: JSON.stringify(limits) },
    };
  }
  const pkg = get('SELECT * FROM packages WHERE name = ?', requested || 'default');
  if (!pkg) return { ok: false, error: 'Pakiet nie istnieje.' };
  const wantedType = level === 'reseller' ? 'reseller' : 'user';
  if (pkg.type !== wantedType) return { ok: false, error: 'Pakiet ma nieprawidłowy typ dla tego konta.' };
  if (actor.level === 'reseller' && pkg.owner && pkg.owner !== actor.username) return { ok: false, error: 'Ten pakiet należy do innego resellera.' };
  if (actor.level === 'admin' && pkg.owner && pkg.owner !== owner) return { ok: false, error: 'Pakiet jest przypisany do innego konta — wybierz globalny pakiet lub właściciela.' };
  return { ok: true, pkg, inline: null };
}

/**
 * Dry-run preflight for the admin/reseller account wizard. Every check is a
 * real validation of the requested operation; nothing is mutated here.
 */
export function accountPreflight(input = {}) {
  const body = input || {};
  const checks = [];
  const errors = [];
  const warnings = [];
  const add = (key, label, ok, detail, { severity = 'error', ...extra } = {}) => {
    const check = { key, label, ok: !!ok, severity, detail: String(detail || ''), ...extra };
    checks.push(check);
    if (!check.ok && severity === 'error') errors.push({ code: key, message: check.detail, key });
    if (!check.ok && severity === 'warn') warnings.push(check.detail);
    return check;
  };
  const actor = body.actor || body.user;
  const actorOk = !!actor && ['admin', 'reseller'].includes(actor.level) && !!actor.username;
  add('actor', 'Uprawnienia operatora', actorOk, actorOk ? `${actor.username} (${actor.level}) może tworzyć konta.` : 'Brak uprawnień do tworzenia kont (wymagany administrator lub reseller).');
  if (!actorOk) return { ok: false, checks, errors, warnings, normalized: null };

  const level = body.level === 'reseller' ? 'reseller' : 'user';
  if (actor.level === 'reseller' && level === 'reseller') add('level', 'Poziom konta', false, 'Reseller nie może tworzyć innych resellerów.');
  const username = String(body.username || '').trim().toLowerCase();
  const usernameOk = /^[a-z0-9][a-z0-9_.-]{1,31}$/.test(username) && !RESERVED_USERNAMES.has(username);
  add('username', 'Nazwa użytkownika', usernameOk, usernameOk ? `Login ${username} jest poprawny.` : 'Login: 2–32 znaki, małe litery/cyfry/kropka/myślnik/podkreślenie, bez nazw systemowych.');
  add('username_free', 'Login jest wolny', usernameOk && !get('SELECT id FROM users WHERE lower(username) = ?', username), usernameOk && !get('SELECT id FROM users WHERE lower(username) = ?', username) ? 'Brak konta o tym loginie.' : 'Konto o tym loginie już istnieje.');

  let owner = null;
  if (actor.level === 'reseller') {
    owner = actor.username;
    if (body.owner && String(body.owner) !== actor.username) add('owner', 'Właściciel konta', false, 'Reseller nie może przypisać konta do innego właściciela.');
    const q = quota(actor, 'users');
    add('owner_quota', 'Limit kont resellera', q.ok, q.ok ? `Wykorzystano ${q.used}/${q.limit || '∞'} kont.` : `Limit kont resellera osiągnięty (${q.used}/${q.limit}).`);
  } else {
    const requestedOwner = String(body.owner || '').trim();
    if (requestedOwner) {
      const row = get("SELECT * FROM users WHERE username = ? AND level = 'reseller'", requestedOwner);
      add('owner', 'Właściciel konta', !!row, row ? `Konto będzie zarządzane przez resellera ${requestedOwner}.` : 'Wybrany reseller nie istnieje.');
      owner = row ? requestedOwner : null;
    } else {
      add('owner', 'Właściciel konta', true, 'Konto będzie zarządzane bezpośrednio przez administratora.');
    }
  }

  const email = String(body.email || '').trim();
  add('email', 'Adres e-mail', isEmail(email), isEmail(email) ? `Kontakt: ${email}` : 'Podaj poprawny adres e-mail kontaktu.');

  const pkgInfo = resolveAccountPackage(body, actor, level, owner);
  add('package', 'Pakiet', pkgInfo.ok, pkgInfo.ok ? `Pakiet ${pkgInfo.pkg.name} jest dostępny.` : pkgInfo.error);
  const pkg = pkgInfo.ok ? pkgInfo.pkg : null;
  const inline = pkgInfo.ok ? pkgInfo.inline : null;
  const limits = pkg ? { ...DEFAULT_PACKAGE_LIMITS, ...safeJson(pkg.limits, {}) } : { ...DEFAULT_PACKAGE_LIMITS };
  if (pkg) add('package_owner', 'Właściciel pakietu', true, pkg.owner ? `Pakiet należy do ${pkg.owner}.` : 'Pakiet globalny.');

  const password = String(body.password || '');
  let activation = body.activation === undefined ? !password : asBool(body.activation);
  if (password) activation = false;
  const policyError = password ? passwordPolicyError(password) : '';
  add('password', 'Polityka haseł', !password || !policyError, password ? (policyError || 'Hasło spełnia politykę panelu.') : (activation ? 'Zostanie wygenerowany silny login startowy + link aktywacyjny (hasło nie jest wysyłane w plaintext).' : 'Podaj hasło spełniające politykę panelu.'));
  if (!password && !activation) add('activation', 'Aktywacja konta', false, 'Bez hasła wymagany jest link aktywacyjny.');

  const domain = String(body.domain || '').trim().toLowerCase();
  const wantsDomain = !!domain && (body.create_domain === undefined || asBool(body.create_domain));
  let engine = normalizeEngine(body.engine, activeServer().id);
  let phpVersion = String(body.php_version ?? setting('php_default', '8.3'));
  let sslMode = normalizeSslMode(body.ssl_mode ?? body.ssl ?? 'selfsigned');
  let ip = String(body.ip || setting('server_ip', '127.0.0.1')).trim();
  let dnsTemplate = null;
  if (wantsDomain) {
    add('domain', 'Domena', isDomain(domain), isDomain(domain) ? `Domena ${domain} jest poprawna.` : 'Podaj poprawną nazwę domeny.');
    add('domain_free', 'Domena jest wolna', isDomain(domain) && !get('SELECT id FROM domains WHERE name = ?', domain), isDomain(domain) && !get('SELECT id FROM domains WHERE name = ?', domain) ? 'Domena nie jest jeszcze używana.' : 'Domena jest już zarządzana w panelu.');
    if (Number(limits.domains) > 0) add('domain_quota', 'Limit domen pakietu', Number(limits.domains) >= 1, `Pakiet pozwala na ${limits.domains} domen(y).`);
    const engineCheck = validateEngine(engine);
    add('engine', 'Silnik WWW', engineCheck.ok, engineCheck.ok ? `${engineCheck.info.label} jest dostępny.` : engineCheck.message);
    add('php', 'Wersja PHP', phpVersions().includes(phpVersion), phpVersions().includes(phpVersion) ? `PHP ${phpVersion}.` : `Nieobsługiwana wersja PHP ${phpVersion}.`);
    add('ssl', 'Tryb SSL', sslMode !== null, sslMode !== null ? `Tryb ${sslMode}.` : 'Nieznany tryb SSL.');
    const ipCheck = ipPreflight(ip, { owner });
    add('ip', 'Adres IP', ipCheck.ok, ipCheck.ok ? `IP ${ipCheck.ip}.` : ipCheck.error);
    if (ipCheck.ok) ip = ipCheck.ip;
    const templateOption = body.dns_template || body.dnsTemplate || '';
    const templateRef = templateOption && typeof templateOption === 'object'
      ? (templateOption.id ?? templateOption.name ?? '')
      : templateOption;
    if (templateRef) {
      const row = /^\d+$/.test(String(templateRef))
        ? get('SELECT * FROM dns_templates WHERE id = ?', Number(templateRef))
        : get('SELECT * FROM dns_templates WHERE name = ?', String(templateRef));
      add('dns_template', 'Szablon DNS', !!row, row ? `Szablon ${row.name}.` : 'Wybrany szablon DNS nie istnieje.');
      if (row) dnsTemplate = row;
    } else {
      const resolved = resolveTemplate({ packageName: pkg?.name || '', reseller: owner || '', domain });
      dnsTemplate = resolved.template || null;
      add('dns_template', 'Szablon DNS', true, resolved.template ? `Domyślny szablon ${resolved.template.name}.` : 'Wbudowane rekordy A/AAAA/MX/SPF/DKIM/DMARC/autodiscover.');
    }
  } else {
    add('domain', 'Domena', true, 'Konto bez domeny — dodasz ją później.', { severity: 'info' });
    engine = ''; phpVersion = ''; sslMode = 'none';
  }

  const mailbox = asMailbox(body.mailbox !== undefined ? body.mailbox : (asBool(body.create_mailbox) ? { local: body.mailbox_local || 'postmaster', quotaMb: Number(body.mailbox_quota_mb ?? 1024), password: body.mailbox_password || '' } : null));
  const mailboxCheck = mailboxPreflight(mailbox, { domain: wantsDomain ? domain : '', pkg });
  add('mailbox', 'Skrzynka podstawowa', mailboxCheck.ok,
    mailboxCheck.ok ? (mailbox ? `${mailbox.local}@${domain} (${mailbox.quotaMb} MB).` : 'Nie wybrano skrzynki.') : mailboxCheck.error,
    { severity: mailbox && !mailboxCheck.ok ? 'error' : 'warn' });

  const appInput = normalizeApp(body.app ?? (body.app_type ? { type: body.app_type, title: body.app_title, adminUser: body.app_admin_user, adminEmail: body.app_admin_email, adminPassword: body.app_admin_password } : undefined));
  if (appInput.error) add('app', 'Aplikacja', false, appInput.error.message);
  else if (appInput.app.type !== 'none' && !wantsDomain) add('app', 'Aplikacja', false, 'Instalacja aplikacji wymaga domeny.');
  else add('app', 'Aplikacja', true, appInput.app.type === 'none' ? 'Bez aplikacji.' : `Aplikacja ${appInput.app.type}.`);

  try {
    const stat = fs.statfsSync(config.dataDir);
    const freeMb = Math.round((Number(stat.bavail) * Number(stat.bsize)) / 1024 / 1024);
    add('capacity', 'Miejsce na dysku', freeMb > 50, `Wolne miejsce: ${freeMb} MB.`, { severity: freeMb > 50 ? 'info' : 'warn' });
  } catch {
    add('capacity', 'Miejsce na dysku', true, 'Nie udało się odczytać statystyk dysku — pominięto.', { severity: 'info', skipped: true });
  }

  const activationRequested = !password && activation;
  const generatedPassword = password || (activationRequested ? randomStrongPassword(20) : '');
  return {
    ok: errors.length === 0,
    checks,
    errors,
    warnings,
    normalized: {
      actor, level, owner, username, email, package: pkg, inlinePackage: inline,
      password, generatedPassword, activation: activationRequested,
      domain: wantsDomain ? domain : '', wantsDomain, engine, phpVersion, sslMode, ip, dnsTemplate,
      mailbox: mailboxCheck.ok ? mailbox : null, app: appInput.app || { type: 'none' },
      backup: asBool(body.create_backup ?? body.backup),
      monitoring: asBool(body.create_monitoring ?? body.monitoring),
      delegationCheck: asBool(body.check_delegation ?? body.delegation),
      retrySslAfterDns: asBool(body.retry_ssl_after_dns ?? body.retrySslAfterDns),
      docroot: body.docroot === undefined ? true : asBool(body.docroot),
      php: body.php_step === undefined ? true : asBool(body.php_step),
      vhost: body.vhost === undefined ? true : asBool(body.vhost),
      notes: [String(body.notes || '').trim(), body.contact_name ? `Kontakt: ${String(body.contact_name).trim()}` : '', body.phone ? `Telefon: ${String(body.phone).trim()}` : ''].filter(Boolean).join('\n').slice(0, 2000),
      notify: body.notify === undefined ? true : asBool(body.notify),
      rollbackOnFailure: body.rollbackOnFailure === undefined ? true : asBool(body.rollbackOnFailure),
      faults: body.faults && typeof body.faults === 'object' ? body.faults : {},
    },
  };
}

function seedAccountHome(username) {
  try {
    const home = userHome(username);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const src = setting('skeleton_directory', '/etc/skel');
    if (fs.existsSync(src) && fs.statSync(src).isDirectory()) {
      for (const entry of fs.readdirSync(src)) {
        const target = path.join(home, entry);
        if (fs.existsSync(target)) continue;
        try { fs.cpSync(path.join(src, entry), target, { recursive: true, errorOnExist: false, force: false }); } catch { /* best effort per file */ }
      }
    }
    try { systemProvider().chownUser(username); } catch { /* provider best effort */ }
    return { ok: true, home, detail: `Katalog domowy ${home} gotowy.` };
  } catch (error) {
    return { ok: false, detail: `Nie udało się przygotować katalogu domowego: ${error.message}` };
  }
}

function activationRecordFor(userId) {
  const row = get('SELECT value FROM settings WHERE key = ?', `user_activation:${userId}`);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

/** Create/refresh the one-time activation link. The plaintext password is
 *  never generated into the link or the welcome message. */
export function createActivationLink(user, actor = 'admin') {
  if (!user?.id || !user?.username) return { ok: false, error: 'Konto nie istnieje.' };
  const token = createResetToken(user.id);
  const url = resetLink(token);
  const record = {
    url,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    actor: String(actor || 'admin'),
  };
  setSetting(`user_activation:${user.id}`, JSON.stringify(record));
  run('UPDATE users SET must_change_password = 1 WHERE id = ?', user.id);
  try { audit(actor, 'admin', 'user.activation', user.username, ''); } catch { /* audit is best effort */ }
  return { ok: true, ...record };
}

/** Return a still-valid activation link record, or null when it was used/expired. */
export function pendingActivation(userId) {
  const record = activationRecordFor(userId);
  if (!record?.url) return null;
  try {
    const token = new URL(record.url).searchParams.get('token') || '';
    const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const row = get('SELECT * FROM password_resets WHERE token_hash = ?', hash);
    if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) return null;
    return record;
  } catch { return null; }
}

export function clearActivation(userId) {
  run('DELETE FROM settings WHERE key = ?', `user_activation:${userId}`);
  return { ok: true };
}

function saveAccountStatus(userId, payload) {
  if (!userId) return;
  const body = {
    at: nowIso(),
    ok: !!payload.ok,
    activationPending: !!payload.activation,
    steps: (payload.steps || []).slice(0, 40).map((step) => ({
      key: String(step.key || ''), label: String(step.label || ''), ok: !!step.ok, skipped: !!step.skipped,
      optional: !!step.optional, detail: String(step.detail || '').slice(0, 900),
      subSteps: Array.isArray(step.subSteps) ? step.subSteps.slice(0, 30).map((sub) => ({
        key: String(sub.key || ''), label: String(sub.label || ''), ok: !!sub.ok, skipped: !!sub.skipped,
        detail: String(sub.detail || '').slice(0, 500),
      })) : undefined,
    })),
    checks: (payload.checks || []).slice(0, 30).map((check) => ({
      key: String(check.key || ''), label: String(check.label || ''), ok: !!check.ok,
      skipped: !!check.skipped, detail: String(check.detail || '').slice(0, 500),
    })),
    warnings: (payload.warnings || []).slice(0, 20).map((warning) => String(warning).slice(0, 900)),
    links: { ...(payload.links || {}), activation: '' },
    rolledBack: !!payload.rolledBack,
  };
  setSetting(`user_provision_last:${userId}`, JSON.stringify(body));
}

export function lastAccountProvision(userId) {
  const row = get('SELECT value FROM settings WHERE key = ?', `user_provision_last:${Number(userId)}`);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

function ensureSiteBackupJob({ domain, username, actor = 'admin' }) {
  const name = `site:${domain}`;
  const existing = get('SELECT * FROM backup_jobs WHERE name = ? AND target_user = ?', name, username);
  if (existing) {
    return { ok: true, id: existing.id, created: false, nextRunAt: existing.next_run_at || null, detail: `Profil backupu już istnieje (#${existing.id}).` };
  }
  const result = saveBackupJob({
    name, scope: 'user', target_user: username, components: ['home', 'email', 'db'],
    schedule: setting('site_backup_schedule', 'daily'), retention_days: Number(setting('site_backup_retention_days', '14')) || 14,
    timezone: setting('scheduler_timezone', '') || undefined,
  }, actor);
  if (!result?.ok) return { ok: false, error: result?.error || 'Nie udało się zapisać profilu backupu.' };
  return { ok: true, id: result.id, created: true, nextRunAt: result.next_run_at, detail: `Dzienny profil backupu #${result.id} zapisany (retencja ${setting('site_backup_retention_days', '14')} dni).` };
}

function monitoringProfile(domain) {
  const row = get('SELECT value FROM settings WHERE key = ?', `site_monitoring:${domain}`);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

function enableMonitoring(domain, username, { scheme = 'http' } = {}) {
  const profile = {
    enabled: true, url: `${scheme === 'https' ? 'https' : 'http'}://${domain}/`, intervalSeconds: 300, createdAt: nowIso(),
    createdBy: username || '', lastCheck: null,
  };
  setSetting(`site_monitoring:${domain}`, JSON.stringify(profile));
  return { ok: true, profile, detail: `Monitoring zapisany: ${profile.url} co ${profile.intervalSeconds / 60} min (pierwszy test uruchomisz ręcznie).` };
}

export function siteMonitoring(domain) {
  if (!isDomain(domain)) return null;
  return monitoringProfile(domain);
}

function probeHttpUrl(url, timeout = 5000) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(url); } catch { resolve({ ok: false, status: null, error: 'invalid-url' }); return; }
    const lib = target.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    const request = lib.request(target, { method: 'GET', timeout, rejectUnauthorized: false, headers: { 'User-Agent': 'OpenAdmin-Monitor/1.0' } }, (response) => {
      response.resume();
      response.on('end', () => finish({ ok: true, status: response.statusCode, error: '' }));
      response.on('error', (error) => finish({ ok: false, status: null, error: error.message }));
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => finish({ ok: false, status: null, error: error.code || error.message }));
    request.end();
  });
}

/** Run one real HTTP check for a monitoring profile and store the observation. */
export async function checkSiteMonitoring(domain, { probe = probeHttpUrl } = {}) {
  const profile = monitoringProfile(domain);
  if (!profile) return { ok: false, error: 'Monitoring nie jest włączony dla tej domeny.' };
  const result = await probe(profile.url);
  profile.lastCheck = { at: nowIso(), ok: !!result.ok, status: result.status ?? null, error: String(result.error || '').slice(0, 300) };
  setSetting(`site_monitoring:${domain}`, JSON.stringify(profile));
  return { ok: true, profile, result: profile.lastCheck };
}

function rollbackAccount({ userId, username, domain, activation, packageName, packageWasInline }) {
  const steps = [];
  const step = (key, label, ok, detail) => steps.push({ key, label, ok, detail });
  if (domain) {
    try { purgeAcmeForDomain(domain); } catch { /* queue cleanup is best effort */ }
    try { run('DELETE FROM backup_jobs WHERE name = ? AND target_user = ?', `site:${domain}`, username); } catch { /* best effort */ }
    try {
      for (const key of [`site_provision_last:${domain}`, `site_monitoring:${domain}`, `web_server:${domain}`]) {
        run('DELETE FROM settings WHERE key = ?', key);
      }
    } catch { /* best effort */ }
    try { cleanupDomainFiles({ user: { username }, domain }); } catch { /* best effort */ }
    try { run('DELETE FROM ssl_certs WHERE domain = ?', domain); } catch { /* best effort */ }
    try { run('DELETE FROM domains WHERE name = ?', domain); } catch { /* best effort */ }
    step('site', 'Strona i domena', true, `Usunięto artefakty domeny ${domain}.`);
  }
  try {
    run('DELETE FROM password_resets WHERE user_id = ?', userId);
    if (activation) run('DELETE FROM settings WHERE key = ?', `user_activation:${userId}`);
    run('DELETE FROM messages WHERE username = ?', username);
    run('DELETE FROM settings WHERE key = ?', `user_provision_last:${userId}`);
    step('activation', 'Link aktywacyjny', true, 'Unieważniono link i wiadomość powitalną.');
  } catch (error) {
    step('activation', 'Link aktywacyjny', false, `Nie udało się wyczyścić aktywacji: ${error.message}`);
  }
  try {
    systemProvider().deleteUser(username);
    run('DELETE FROM users WHERE id = ?', userId);
    fs.rmSync(userHome(username), { recursive: true, force: true });
    step('account', 'Konto', true, `Usunięto konto ${username} i katalog domowy.`);
  } catch (error) {
    step('account', 'Konto', false, `Rollback konta nie powiódł się: ${error.message}`);
  }
  if (packageName && packageWasInline) {
    try {
      const used = get('SELECT COUNT(*) n FROM users WHERE package = ?', packageName).n;
      if (used === 0) run('DELETE FROM packages WHERE name = ?', packageName);
    } catch { /* best effort */ }
  }
  return { ok: steps.every((entry) => entry.ok), steps };
}

/**
 * Atomic (compensating) account provisioning used by /admin/users/create and
 * /reseller/users/create. The system account, database rows, home directory,
 * domain artefacts, mailbox, backup profile and activation link are tracked as
 * ordered steps; a failure rolls back every artefact created by this call.
 */
export function provisionAccount(input = {}) {
  const pre = accountPreflight(input);
  const base = {
    ok: false, created: false, userId: null, username: pre.normalized?.username || '',
    activation: null, checks: pre.checks, steps: [], errors: pre.errors, warnings: pre.warnings,
    rolledBack: false, package: pre.normalized?.package?.name || '', links: {},
  };
  if (!pre.ok) {
    try { audit(pre.normalized?.actor?.username || 'system', pre.normalized?.actor?.level || 'admin', 'user.create.rejected', pre.normalized?.username || String(input.username || ''), input.actorIp || input.ip || ''); } catch { /* audit is best effort */ }
    return base;
  }
  const data = pre.normalized;
  const steps = [];
  const errors = [];
  const warnings = [...pre.warnings];
  const faults = data.faults || {};
  let rollbackNeeded = false;
  const fail = (key, label, detail, { optional = false } = {}) => {
    const step = { key, label, ok: false, optional, detail };
    steps.push(step);
    if (optional) warnings.push(detail);
    else { rollbackNeeded = true; errors.push({ code: `${key}_failed`, message: detail }); }
    return step;
  };
  let packageCreated = false;
  let userId = null;
  let activation = null;
  let site = null;

  if (data.inlinePackage) {
    if (faults.package) {
      fail('package', 'Pakiet inline', `Wymuszony błąd pakietu: ${faults.package}`);
      return { ...base, steps, errors, warnings };
    }
    try {
      run('INSERT INTO packages(name, owner, type, limits, created_at) VALUES(?,?,?,?,?)',
        data.inlinePackage.name, data.inlinePackage.owner, data.inlinePackage.type,
        JSON.stringify(data.inlinePackage.limits), nowIso());
      packageCreated = true;
      steps.push({ key: 'package', label: 'Pakiet inline', ok: true, detail: `Utworzono pakiet ${data.inlinePackage.name}.` });
    } catch (error) {
      fail('package', 'Pakiet inline', `Nie udało się utworzyć pakietu: ${error.message}`);
      return { ...base, steps, errors, warnings };
    }
  }

  if (faults.system) {
    fail('system', 'Konto systemowe', `Wymuszony błąd konta systemowego: ${faults.system}`);
  } else {
    let system;
    try { system = systemProvider().createUser(data.username, userHome(data.username)); }
    catch (error) { system = { ok: false, output: error.message }; }
    if (!system?.ok) fail('system', 'Konto systemowe', `Nie udało się utworzyć konta systemowego: ${system?.output || 'nieznany błąd'}`);
    else steps.push({ key: 'system', label: 'Konto systemowe', ok: true, detail: system.output || `Konto systemowe ${data.username} utworzone.` });
  }
  if (rollbackNeeded) {
    if (packageCreated) run('DELETE FROM packages WHERE name = ?', data.inlinePackage.name);
    return { ...base, steps, errors, warnings };
  }

  const timestamp = nowIso();
  try {
    const passwordHash = hashPassword(data.password || data.generatedPassword);
    userId = transaction(() => {
      const result = run(`INSERT INTO users(username, password, email, level, owner, package, domain, ip, notes, created_at, must_change_password)
                         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        data.username, passwordHash, data.email, data.level, data.owner, data.package?.name,
        data.domain || '', data.ip, data.notes, timestamp, 1);
      return result.lastInsertRowid;
    });
    steps.push({ key: 'account', label: 'Konto panelu', ok: true, detail: `Konto ${data.username} (#${userId}) utworzone w pakiecie ${data.package?.name}.` });
  } catch (error) {
    fail('account', 'Konto panelu', `Nie udało się zapisać konta: ${error.message}`);
    // Another request may have won the unique-login race: never delete a
    // system account that now belongs to a committed panel account.
    const raced = get('SELECT id FROM users WHERE lower(username) = ?', data.username);
    if (!raced) {
      try { systemProvider().deleteUser(data.username); } catch { /* best effort */ }
      try { fs.rmSync(userHome(data.username), { recursive: true, force: true }); } catch { /* best effort */ }
    }
    if (packageCreated) run('DELETE FROM packages WHERE name = ?', data.inlinePackage.name);
    return { ...base, steps, errors, warnings };
  }

  const dbUserRow = get('SELECT * FROM users WHERE id = ?', userId);
  if (faults.home) {
    fail('home', 'Katalog domowy', `Wymuszony błąd katalogu domowego: ${faults.home}`);
  } else {
    const home = seedAccountHome(data.username);
    if (!home.ok) fail('home', 'Katalog domowy', home.detail);
    else steps.push({ key: 'home', label: 'Katalog domowy', ok: true, detail: home.detail });
  }

  if (rollbackNeeded) {
    const rollback = rollbackAccount({ userId, username: data.username, domain: '', activation: false, packageName: data.inlinePackage?.name, packageWasInline: packageCreated });
    steps.push({ key: 'rollback', label: 'Rollback konta', ok: rollback.ok, detail: rollback.steps.map((entry) => entry.detail).join(' ') || 'Rollback wykonany.' });
    return { ...base, steps, errors, warnings, rolledBack: rollback.ok };
  }

  if (data.activation) {
    if (faults.activation) {
      fail('activation', 'Aktywacja', `Wymuszony błąd aktywacji: ${faults.activation}`);
    } else {
      activation = createActivationLink(dbUserRow, data.actor.username);
      if (!activation.ok) fail('activation', 'Aktywacja', activation.error || 'Nie udało się utworzyć linku aktywacyjnego.');
      else steps.push({ key: 'activation', label: 'Aktywacja', ok: true, detail: `Link aktywacyjny wygenerowany (ważny do ${new Date(activation.expiresAt).toLocaleString('pl-PL')}).` });
    }
  } else {
    steps.push({ key: 'activation', label: 'Aktywacja', ok: true, skipped: true, detail: 'Konto utworzone z hasłem podanym przez operatora.' });
  }

  if (data.wantsDomain) {
    if (faults.domain) {
      fail('site', 'Domena i strona', `Wymuszony błąd domeny: ${faults.domain}`);
    } else {
      try {
        site = createSite({
          user: dbUserRow,
          domain: data.domain,
          engine: data.engine,
          phpVersion: data.phpVersion,
          sslMode: data.sslMode,
          createDns: true,
          dnsTemplate: data.dnsTemplate?.id || null,
          ip: data.ip,
          mailbox: data.mailbox,
          backup: data.backup,
          monitoring: data.monitoring,
          checkDelegation: data.delegationCheck,
          retrySslAfterDns: data.retrySslAfterDns,
          docroot: data.docroot,
          php: data.php,
          vhost: data.vhost,
          rollbackOnFailure: data.rollbackOnFailure,
          faults: data.faults,
        });
        steps.push({
          key: 'site', label: 'Strona, DNS, SSL i poczta', ok: !!site.ok,
          detail: site.ok ? `Domena ${data.domain} wdrożona (${site.steps.filter((entry) => entry.ok && !entry.skipped).length} kroków OK).` : `Wdrożenie domeny zgłosiło błędy: ${(site.errors || []).map((entry) => entry.message).join(' ') || 'szczegóły poniżej'}`,
          subSteps: site.steps,
        });
        warnings.push(...(site.warnings || []));
        if (!site.ok) {
          rollbackNeeded = true;
          errors.push(...(site.errors || []).map((entry) => ({ code: entry.code || 'site_failed', message: entry.message })));
        }
      } catch (error) {
        fail('site', 'Domena i strona', `Wdrożenie strony zgłosiło wyjątek: ${error.message}`);
      }
    }
  } else {
    steps.push({ key: 'site', label: 'Domena i strona', ok: true, skipped: true, detail: 'Konto bez domeny — dodasz ją później z poziomu panelu.' });
  }

  if (!rollbackNeeded && data.notify) {
    try {
      const panel = `https://${setting('server_name', 'localhost')}:2222`;
      const lines = [
        `Witaj ${data.username},`,
        '',
        'Twoje konto hostingowe jest gotowe.',
        `Panel: ${panel}`,
        activation?.url ? `Aktywuj konto (jednorazowy link, 1 godzina): ${activation.url}` : 'Hasło ustawił administrator — zmień je po pierwszym logowaniu.',
        data.domain ? `Domena: ${data.domain}` : '',
      ].filter(Boolean);
      run('INSERT INTO messages(level, username, subject, body, created_at) VALUES(?,?,?,?,?)',
        'user', data.username, 'Aktywacja konta OpenAdmin', lines.join('\n'), nowIso());
      steps.push({ key: 'notify', label: 'Wiadomość powitalna', ok: true, skipLog: true, detail: 'Wiadomość z linkiem aktywacyjnym zapisana w panelu (bez hasła).' });
    } catch (error) {
      warnings.push(`Nie udało się zapisać wiadomości powitalnej: ${error.message}`);
    }
  }

  if (rollbackNeeded) {
    if (site?.app?.ok) {
      warnings.push('Rollback konta został wstrzymany, ponieważ zainstalowano aplikację — jej baza zostałaby osierocona. Usuń konto ręcznie.');
    } else if (data.rollbackOnFailure) {
      const rollback = rollbackAccount({
        userId, username: data.username, domain: data.wantsDomain ? data.domain : '',
        activation: !!activation, packageName: data.inlinePackage?.name, packageWasInline: packageCreated,
      });
      steps.push({ key: 'rollback', label: 'Rollback', ok: rollback.ok, detail: rollback.steps.map((entry) => entry.detail).join(' ') || 'Rollback wykonany.' });
      base.rolledBack = rollback.ok;
      try { audit(data.actor.username, data.actor.level, 'user.create.rollback', data.username, input.actorIp || input.ip || ''); } catch { /* audit is best effort */ }
      if (!rollback.ok) warnings.push('Część operacji rollbacku nie powiodła się — sprawdź konto i artefakty ręcznie.');
    }
  }

  const ok = !rollbackNeeded;
  const result = {
    ...base,
    ok,
    created: ok,
    userId,
    username: data.username,
    activation: activation ? { expiresAt: activation.expiresAt } : null,
    steps,
    errors,
    warnings,
    rolledBack: base.rolledBack,
    package: data.package?.name || data.inlinePackage?.name || '',
    links: ok ? {
      account: data.level === 'reseller' ? '/admin/resellers' : '/admin/users',
      domain: data.domain ? `/user/domains/${site?.domainId || ''}/edit` : '',
      dns: data.domain ? `/user/dns?domain=${encodeURIComponent(data.domain)}` : '',
      ssl: data.domain ? `/user/ssl?domain=${encodeURIComponent(data.domain)}` : '',
      email: data.domain ? `/user/email/new?domain=${encodeURIComponent(data.domain)}` : '',
      activation: activation?.url || '',
    } : {},
  };
  if (ok && !base.rolledBack) {
    try { audit(data.actor.username, data.actor.level, 'user.create', data.username, input.actorIp || input.ip || ''); } catch { /* audit is best effort */ }
    try { runHooks('user.create', { username: data.username, email: data.email, package: result.package, domain: data.domain }); } catch { /* plugin failure does not block */ }
  }
  if (userId && !result.rolledBack) saveAccountStatus(userId, result);
  return result;
}

/* ------------------------------------------------------------------- site */

/**
 * Idempotent site creation. Returns ordered steps plus real links, warnings and
 * errors. It never throws on validation or deployment errors; callers can show
 * the honest result. Only a domain created by this call can be rolled back,
 * and only when `rollbackOnFailure` is explicitly true and no app was installed.
 */
/**
 * Idempotent site creation. Returns ordered steps plus real links, warnings and
 * errors. It never throws on validation or deployment errors; callers can show
 * the honest result. Only a domain created by this call can be rolled back,
 * and only when `rollbackOnFailure` is explicitly true and no app was installed.
 */
export function createSite(input = {}) {
  const opts = input || {};
  const dbUser = resolveUser(opts.user);
  const rawDomain = String(opts.domain ?? '').trim().toLowerCase().replace(/\.+$/, '');
  const engine = normalizeEngine(opts.engine, activeServer().id);
  const phpVersion = String(opts.phpVersion ?? setting('php_default', '8.3')).trim();
  const sslExplicit = opts.sslMode !== undefined || opts.ssl !== undefined;
  const sslMode = normalizeSslMode(opts.sslMode ?? opts.ssl ?? 'selfsigned');
  const createDns = asBool(opts.createDns ?? opts.createDnsZone ?? opts.dns);
  let ip = String(opts.ip || '').trim();
  const errors = [];
  const warnings = [];
  const faults = opts.faults && typeof opts.faults === 'object' ? opts.faults : {};
  const docrootEnabled = opts.docroot === undefined ? true : asBool(opts.docroot);
  const phpEnabled = opts.php === undefined ? true : asBool(opts.php);
  const vhostEnabled = opts.vhost === undefined ? true : asBool(opts.vhost);
  const delegationRequested = asBool(opts.checkDelegation ?? opts.delegationCheck);
  const retrySslAfterDns = asBool(opts.retrySslAfterDns ?? opts.retry_ssl_after_dns);
  const wantBackup = asBool(opts.backup ?? opts.createBackup);
  const wantMonitoring = asBool(opts.monitoring ?? opts.createMonitoring);
  const pkgRow = dbUser?.package ? get('SELECT * FROM packages WHERE name = ?', dbUser.package) : null;
  let mailbox = asMailbox(opts.mailbox !== undefined
    ? opts.mailbox
    : (asBool(opts.createMailbox) ? {
      local: opts.mailboxLocal || opts.mailbox_local || 'postmaster',
      quotaMb: Number(opts.mailboxQuotaMb ?? opts.mailbox_quota_mb ?? 1024),
      password: opts.mailboxPassword || opts.mailbox_password || '',
    } : null));
  let dnsTemplate = null;

  if (!dbUser) {
    return failResult({ domain: rawDomain, engine, phpVersion, sslMode, errors: [{ code: 'invalid_user', message: 'A valid panel account is required.' }] });
  }
  if (!isDomain(rawDomain) || rawDomain.length > 253) {
    return failResult({ domain: rawDomain, engine, phpVersion, sslMode, errors: [{ code: 'invalid_domain', message: 'That does not look like a valid domain name.' }], dbUser, ip });
  }
  const engineCheck = validateEngine(engine);
  if (!engineCheck.ok) errors.push({ code: engineCheck.code, message: engineCheck.message });
  if (!phpVersions().includes(phpVersion)) {
    errors.push({ code: 'invalid_php', message: `Unsupported PHP version "${phpVersion}". Choose one of: ${phpVersions().join(', ')}.` });
  }
  if (sslMode === null) {
    errors.push({ code: 'invalid_ssl_mode', message: 'Unknown SSL mode. Use none, selfsigned or letsencrypt.' });
  }
  if (ip) {
    const ipCheck = ipPreflight(ip, { owner: dbUser.owner || dbUser.username });
    if (!ipCheck.ok) errors.push({ code: 'invalid_ip', message: ipCheck.error });
    else ip = ipCheck.ip;
  }
  const normalizedSubdomains = normalizeSubdomains(opts.subdomains);
  errors.push(...normalizedSubdomains.errors);
  const appInput = normalizeApp(opts.app);
  if (appInput.error) errors.push(appInput.error);
  const app = appInput.app || { type: 'none' };
  const mailboxCheck = mailboxPreflight(mailbox, { domain: rawDomain, pkg: pkgRow });
  if (!mailboxCheck.ok) errors.push({ code: 'invalid_mailbox', message: mailboxCheck.error });
  if (mailboxCheck.ok) mailbox = mailboxCheck.mailbox;
  const templateOption = opts.dnsTemplate ?? opts.dns_template ?? '';
  const templateRef = templateOption && typeof templateOption === 'object'
    ? (templateOption.id ?? templateOption.name ?? '')
    : templateOption;
  if (templateRef) {
    const row = /^\d+$/.test(String(templateRef))
      ? get('SELECT * FROM dns_templates WHERE id = ?', Number(templateRef))
      : get('SELECT * FROM dns_templates WHERE name = ?', String(templateRef));
    if (!row) errors.push({ code: 'invalid_dns_template', message: 'The selected DNS template does not exist.' });
    else dnsTemplate = row;
  }

  const existing = get('SELECT * FROM domains WHERE name = ?', rawDomain);
  if (existing && existing.user_id !== dbUser.id) {
    errors.push({ code: 'foreign_domain', message: 'This domain is already managed by another account.' });
  }
  if (!existing) {
    const q = quota(dbUser, 'domains');
    if (!q.ok) errors.push({ code: 'domain_limit', message: `Domain limit reached (${q.used}/${q.limit}).` });
  }
  if (normalizedSubdomains.list.length) {
    let newCount = 0;
    for (const sub of normalizedSubdomains.list) {
      const row = existing
        ? get('SELECT id FROM subdomains WHERE domain_id = ? AND name = ?', existing.id, sub.name)
        : null;
      if (!row) newCount++;
    }
    if (newCount > 0) {
      const q = quota(dbUser, 'subdomains', newCount);
      if (!q.ok) errors.push({ code: 'subdomain_limit', message: `Subdomain limit reached (${q.used}/${q.limit}).` });
    }
  }
  if (errors.length) return failResult({ domain: rawDomain, engine, phpVersion, sslMode, errors, dbUser, ip });

  const steps = [];
  const created = !existing;
  let domainId = existing?.id || null;
  let docroot = existing?.docroot || `/home/${dbUser.username}/domains/${rawDomain}/public_html`;
  let domainFailed = false;
  let mailboxCreated = false;
  let mailboxAddress = '';
  let dnsInfo = null;

  const addStep = (step, faultKey, { optional = false } = {}) => {
    const fault = faultKey ? faults[faultKey] : '';
    if (fault) {
      const failed = { ...step, ok: false, detail: `Wymuszony błąd kroku ${faultKey}: ${fault}` };
      steps.push(failed);
      if (optional) warnings.push(failed.detail);
      else errors.push({ code: `${faultKey}_failed`, message: failed.detail });
      return failed;
    }
    steps.push(step);
    if (!step.ok && !step.skipped) {
      if (optional) warnings.push(step.detail || `Krok ${step.key} zgłosił ostrzeżenie`);
      else errors.push({ code: `${step.key}_failed`, message: step.detail || `Krok ${step.key} nie powiódł się` });
    }
    return step;
  };

  // 1. Domain row.
  if (created) {
    try {
      const isMain = get('SELECT COUNT(*) n FROM domains WHERE user_id = ?', dbUser.id).n === 0 ? 1 : 0;
      const inserted = run(`INSERT INTO domains(user_id, username, name, docroot, php_version, ssl, status, is_main, ip, created_at)
                            VALUES(?,?,?,?,?,?,?,?,?,?)`,
        dbUser.id, dbUser.username, rawDomain, docroot, phpVersion, 0, 'active', isMain,
        opts.ip || setting('server_ip', '127.0.0.1'), nowIso());
      domainId = inserted.lastInsertRowid;
      steps.push({ key: 'domain', label: 'Domain', ok: true, detail: `Created domain ${rawDomain} (#${domainId})` });
    } catch (e) {
      const raced = get('SELECT * FROM domains WHERE name = ?', rawDomain);
      if (raced && raced.user_id === dbUser.id) {
        domainId = raced.id;
        docroot = raced.docroot || docroot;
        steps.push({ key: 'domain', label: 'Domain', ok: true, skipped: true, detail: `Domain ${rawDomain} already exists (#${raced.id})` });
      } else {
        domainFailed = true;
        steps.push({ key: 'domain', label: 'Domain', ok: false, detail: `Could not create the domain row: ${e.message}` });
        errors.push({ code: 'domain_failed', message: steps[0].detail });
      }
    }
  } else {
    steps.push({ key: 'domain', label: 'Domain', ok: true, skipped: true, detail: `Domain ${rawDomain} already exists (#${domainId})` });
  }

  if (!domainFailed) {
    // 2. Document root and placeholder index.
    if (!docrootEnabled) {
      steps.push({ key: 'docroot', label: 'Document root', ok: true, skipped: true, detail: 'Tworzenie katalogu dokumentów pominięte.' });
    } else if (faults.docroot) {
      addStep({ key: 'docroot', label: 'Document root', ok: true, detail: 'provisioning' }, 'docroot');
    } else {
      try {
        const shown = provisionDomain(dbUser.username, rawDomain);
        docroot = get('SELECT docroot FROM domains WHERE id = ?', domainId)?.docroot || docroot || shown;
        steps.push({ key: 'docroot', label: 'Document root', ok: true, detail: `Document root ready at ${docroot}` });
      } catch (e) {
        steps.push({ key: 'docroot', label: 'Document root', ok: false, detail: `Could not provision the document root: ${e.message}` });
        errors.push({ code: 'docroot_failed', message: steps[steps.length - 1].detail });
      }
    }

    // 3. Per-domain engine override (same key as src/webserver.mjs).
    if (faults.engine) {
      addStep({ key: 'engine', label: 'Web engine', ok: true, detail: 'engine' }, 'engine');
    } else {
      try {
        setSetting(`web_server:${rawDomain}`, engine);
        pruneStaleVhosts(rawDomain, engine);
        steps.push({ key: 'engine', label: 'Web engine', ok: true, detail: `${SERVERS[engine].label} — setting web_server:${rawDomain}` });
      } catch (e) {
        steps.push({ key: 'engine', label: 'Web engine', ok: false, detail: `Could not persist the engine override: ${e.message}` });
        errors.push({ code: 'engine_failed', message: steps[steps.length - 1].detail });
      }
    }

    // 4. PHP runtime (the domain row already stores it; this step makes the
    // result explicit and can be retried independently).
    if (!phpEnabled) {
      steps.push({ key: 'php', label: 'PHP runtime', ok: true, skipped: true, detail: 'Zmiana wersji PHP pominięta.' });
    } else if (faults.php) {
      addStep({ key: 'php', label: 'PHP runtime', ok: true, detail: 'php' }, 'php');
    } else {
      run('UPDATE domains SET php_version = ? WHERE id = ?', phpVersion, domainId);
      steps.push({ key: 'php', label: 'PHP runtime', ok: true, detail: `PHP ${phpVersion} zapisany dla ${rawDomain}.` });
    }

    // 5. Optional DNS zone (template or built-in automatic records).
    if (!createDns) {
      steps.push({ key: 'dns', label: 'DNS zone', ok: true, skipped: true, records: 0, detail: 'DNS zone was not requested' });
    } else if (faults.dns) {
      addStep({ key: 'dns', label: 'DNS zone', ok: true, detail: 'dns' }, 'dns');
    } else {
      try {
        dnsInfo = createZone(domainId, rawDomain, {
          templateId: dnsTemplate?.id || null,
          packageName: dbUser.package || '',
          reseller: dbUser.owner || '',
          actor: dbUser.username,
          dkim: opts.dkim !== false,
          ip: ip || setting('server_ip', '127.0.0.1'),
        });
        if (!dnsInfo.ok) {
          steps.push({ key: 'dns', label: 'DNS zone', ok: false, detail: dnsInfo.error || 'Nie udało się zbudować strefy DNS.' });
          errors.push({ code: 'dns_failed', message: steps[steps.length - 1].detail });
        } else {
          if (dnsInfo.warnings?.length) warnings.push(...dnsInfo.warnings);
          steps.push({
            key: 'dns', label: 'DNS zone', ok: dnsInfo.records > 0, records: dnsInfo.records,
            template: dnsInfo.template, source: dnsInfo.source,
            detail: dnsInfo.records > 0
              ? `${dnsInfo.records} rekord(ów) DNS${dnsInfo.template ? ` z szablonu ${dnsInfo.template.name}` : ' (A/AAAA/MX/SPF/DKIM/DMARC/autodiscover)'}${dnsInfo.checked ? ' i zwalidowanych' : ''}`
              : 'No DNS records were created',
          });
          if (dnsInfo.records === 0) errors.push({ code: 'dns_failed', message: 'Nie utworzono rekordów DNS.' });
        }
      } catch (e) {
        steps.push({ key: 'dns', label: 'DNS zone', ok: false, detail: `Could not build the DNS zone: ${e.message}` });
        errors.push({ code: 'dns_failed', message: steps[steps.length - 1].detail });
      }
    }

    // 6. Delegation check (requested explicitly; pending delegation is a
    // warning, not a reason to discard a correctly provisioned site).
    if (!delegationRequested) {
      steps.push({ key: 'delegation', label: 'Delegation check', ok: true, skipped: true, detail: 'Sprawdzanie delegacji nie zostało wybrane.' });
    } else if (faults.delegation) {
      addStep({ key: 'delegation', label: 'Delegation check', ok: true, detail: 'delegation' }, 'delegation', { optional: true });
    } else {
      let probe;
      try {
        probe = typeof opts.delegationProbe === 'function' ? opts.delegationProbe(rawDomain) : probeDelegation(rawDomain);
      } catch (e) {
        probe = { ok: false, status: 'unavailable', detail: `Nie udało się sprawdzić delegacji: ${e.message}` };
      }
      const step = {
        key: 'delegation', label: 'Delegation check', ok: !!probe.ok, status: probe.status,
        ns: probe.ns, expected: probe.expected, detail: probe.detail,
      };
      steps.push(step);
      if (!probe.ok) warnings.push(`Delegacja: ${probe.detail}`);
    }

    // 7. Subdomains: row, document root and (when a zone exists) an A record.
    const subSteps = [];
    const zoneExists = get('SELECT COUNT(*) n FROM dns_records WHERE domain_id = ?', domainId).n > 0;
    const serverIp = setting('server_ip', '127.0.0.1');
    for (const sub of normalizedSubdomains.list) {
      try {
        const existingSub = get('SELECT * FROM subdomains WHERE domain_id = ? AND name = ?', domainId, sub.name);
        const subDocroot = existingSub?.docroot || `/home/${dbUser.username}/domains/${rawDomain}/public_html/${sub.name}`;
        if (!existingSub) {
          run(`INSERT INTO subdomains(domain_id, username, name, php_version, docroot, created_at) VALUES(?,?,?,?,?,?)`,
            domainId, dbUser.username, sub.name, sub.phpVersion || phpVersion, subDocroot, nowIso());
        }
        const actualDocroot = provisionSubdomainRoot(dbUser.username, rawDomain, sub.name);
        let dnsNote = 'no DNS zone';
        if (zoneExists) {
          const a = get("SELECT id FROM dns_records WHERE domain_id = ? AND name = ? AND type = 'A'", domainId, sub.name);
          if (!a) {
            run("INSERT INTO dns_records(domain_id, name, type, value, priority, ttl) VALUES(?,?,?,?,?,?)",
              domainId, sub.name, 'A', existing?.ip || serverIp, null, 3600);
            dnsNote = `A ${existing?.ip || serverIp}`;
          } else {
            dnsNote = 'A record already present';
          }
          try { rebuildZone(rawDomain); } catch { /* apply reports deployment */ }
        } else {
          warnings.push(`Subdomain ${sub.name}.${rawDomain} has no DNS A record because no DNS zone was requested.`);
        }
        subSteps.push({ key: `subdomain:${sub.name}`, label: `Subdomain ${sub.name}`, ok: true, detail: `${sub.name}.${rawDomain} · ${actualDocroot} · ${dnsNote}` });
      } catch (e) {
        subSteps.push({ key: `subdomain:${sub.name}`, label: `Subdomain ${sub.name}`, ok: false, detail: `Could not create ${sub.name}.${rawDomain}: ${e.message}` });
      }
    }
    steps.push({
      key: 'subdomains',
      label: 'Subdomains',
      ok: normalizedSubdomains.list.length ? subSteps.every((s) => s.ok) : true,
      skipped: normalizedSubdomains.list.length === 0,
      subdomains: subSteps,
      detail: normalizedSubdomains.list.length
        ? `${subSteps.filter((s) => s.ok).length}/${subSteps.length} subdomain(s) ready: ${normalizedSubdomains.list.map((s) => `${s.name}.${rawDomain}`).join(', ')}`
        : 'No subdomains requested',
    });
    if (normalizedSubdomains.list.length && !steps[steps.length - 1].ok) {
      errors.push({ code: 'subdomain_failed', message: 'One or more subdomains could not be provisioned.' });
    }

    // 8. SSL before vhost generation so the certificate lands in the config.
    // Re-running createSite without an explicit SSL mode never downgrades an
    // existing certificate; it simply reports the current state.
    let ssl;
    if (faults.ssl) {
      ssl = { key: 'ssl', label: 'SSL certificate', ok: false, mode: sslMode, detail: `Wymuszony błąd kroku ssl: ${faults.ssl}` };
      errors.push({ code: 'ssl_failed', message: ssl.detail });
    } else if (!created && !sslExplicit) {
      const currentSsl = get('SELECT ssl FROM domains WHERE id = ?', domainId)?.ssl;
      ssl = {
        key: 'ssl', label: 'SSL certificate', mode: 'keep', skipped: true,
        detail: currentSsl ? 'SSL left unchanged (certificate already configured)' : 'SSL left unchanged (currently disabled)',
      };
      steps.push(ssl);
    } else {
      ssl = applySsl({ domain: rawDomain, docroot, sslMode, email: dbUser.email || '' });
      if (ssl.warning) warnings.push(ssl.warning);
      if (retrySslAfterDns && sslMode === 'letsencrypt' && ssl.fallback) {
        try {
          const queued = enqueueAcme(rawDomain, {
            username: dbUser.username, actorLevel: dbUser.level, email: dbUser.email || '',
            mode: 'letsencrypt', challenge: 'http-01', source: 'site-provisioning',
            reason: 'SSL fallback after DNS preflight', maxAttempts: Number(setting('acme_max_attempts', '5')) || 5,
            baseBackoffSeconds: Number(setting('acme_retry_backoff_seconds', '300')) || 300,
          });
          if (queued.ok) {
            ssl.queue = { id: queued.entry.id, status: queued.entry.status, nextAttemptAt: queued.entry.nextAttemptAt };
            ssl.detail = `${ssl.detail} Ponowienie ACME po DNS dodane do kolejki (zadanie #${queued.entry.id}); certyfikat self-signed pozostaje aktywny do czasu sukcesu.`
              + (certbotAvailable() ? '' : ' Certbot nie jest zainstalowany — zadanie będzie mogło zostać przetworzone po jego instalacji.');
            warnings.push(`ACME: ponowienie po propagacji DNS zakolejkowane jako #${queued.entry.id}.`);
          } else {
            warnings.push(`ACME: nie udało się zakolejkować ponowienia (${queued.error}).`);
          }
        } catch (error) {
          warnings.push(`ACME: nie udało się zakolejkować ponowienia (${error.message}).`);
        }
      }
      steps.push(ssl);
      if (!ssl.ok) errors.push({ code: 'ssl_failed', message: ssl.detail });
    }

    // 9. Primary mailbox (idempotent on domain + local part).
    if (!mailbox) {
      steps.push({ key: 'mailbox', label: 'Primary mailbox', ok: true, skipped: true, detail: 'Nie wybrano skrzynki podstawowej.' });
    } else if (faults.mailbox) {
      addStep({ key: 'mailbox', label: 'Primary mailbox', ok: true, detail: 'mailbox' }, 'mailbox');
    } else {
      try {
        const current = get('SELECT * FROM email_accounts WHERE domain = ? AND local_part = ?', rawDomain, mailbox.local);
        if (current) {
          mailboxAddress = `${mailbox.local}@${rawDomain}`;
          steps.push({ key: 'mailbox', label: 'Primary mailbox', ok: true, skipped: true, address: mailboxAddress, detail: `Skrzynka ${mailboxAddress} już istnieje.` });
        } else {
          const password = mailbox.password || randomStrongPassword(16);
          let mailHash = null;
          try { mailHash = dovecotHash(password); } catch { mailHash = null; }
          run(`INSERT INTO email_accounts(domain_id, domain, local_part, password, quota_mb, used_mb, suspended, created_at, mail_hash)
               VALUES(?,?,?,?,?,?,?,?,?)`,
            domainId, rawDomain, mailbox.local, hashPassword(password), mailbox.quotaMb, 0, 0, nowIso(), mailHash);
          mailboxCreated = true;
          mailboxAddress = `${mailbox.local}@${rawDomain}`;
          try { syncMail(); } catch (error) { warnings.push(`Poczta zsynchronizowana częściowo: ${error.message}`); }
          steps.push({ key: 'mailbox', label: 'Primary mailbox', ok: true, address: mailboxAddress, detail: `Skrzynka ${mailboxAddress} utworzona (${mailbox.quotaMb} MB, hasło ustawione — nie jest wyświetlane).` });
        }
      } catch (e) {
        steps.push({ key: 'mailbox', label: 'Primary mailbox', ok: false, detail: `Nie udało się utworzyć skrzynki: ${e.message}` });
        errors.push({ code: 'mailbox_failed', message: steps[steps.length - 1].detail });
      }
    }

    // 10. Optional app through the existing installers.
    let appInfo = null;
    let appStep = { key: 'app', label: 'Application', ok: true, skipped: true, detail: 'No application selected' };
    if (faults.app) {
      appStep = { key: 'app', label: 'Application', ok: false, detail: `Wymuszony błąd kroku app: ${faults.app}` };
      errors.push({ code: 'app_failed', message: appStep.detail });
    } else if (app.type !== 'none') {
      const installedBefore = app.type === 'wordpress'
        ? get("SELECT id FROM wordpress WHERE domain = ? AND path = '/' AND status = 'active'", rawDomain)
        : get("SELECT id FROM app_installs WHERE domain = ? AND type = 'nextcloud' AND status = 'active'", rawDomain);
      if (installedBefore) {
        appStep = { key: 'app', label: 'Application', ok: true, skipped: true, detail: `${app.type} is already installed on this domain` };
      } else {
        const scheme = get('SELECT ssl FROM domains WHERE id = ?', domainId)?.ssl ? 'https' : 'http';
        try {
          const result = app.type === 'wordpress'
            ? installWordPress({
              user: dbUser, domain: rawDomain, subpath: '/', title: app.title || rawDomain,
              adminUser: app.adminUser, adminPass: app.adminPassword, adminEmail: app.adminEmail || dbUser.email || '',
              scheme,
            })
            : installNextcloud({
              user: dbUser, domain: rawDomain, subpath: '/', adminUser: app.adminUser,
              adminPass: app.adminPassword, adminEmail: app.adminEmail || dbUser.email || '', scheme,
            });
          if (result.ok) {
            appInfo = { ...result, type: app.type };
            appStep = { key: 'app', label: 'Application', ok: true, detail: `${app.type} installed${result.url ? ` at ${result.url}` : ''}` };
          } else {
            appStep = { key: 'app', label: 'Application', ok: false, detail: `${app.type} installation failed: ${result.error}` };
            errors.push({ code: 'app_failed', message: appStep.detail });
          }
        } catch (e) {
          appStep = { key: 'app', label: 'Application', ok: false, detail: `${app.type} installation failed: ${e.message}` };
          errors.push({ code: 'app_failed', message: appStep.detail });
        }
      }
    }
    steps.push(appStep);

    // 11. Apply the staged configuration (web/DNS/mail) through the existing
    // pipeline, then report the vhost result separately.
    const applyResult = (vhostEnabled || createDns || mailboxCreated)
      ? runApply({ web: vhostEnabled, dns: createDns, mail: mailboxCreated })
      : { ok: true, steps: [] };
    if (applyResult.error) warnings.push(`apply() failed: ${applyResult.error}`);
    if (vhostEnabled) {
      const vhost = vhostStep({ domain: rawDomain, engine, applyResult });
      if (vhost.warning) warnings.push(vhost.warning);
      steps.push(vhost);
      if (!vhost.ok) errors.push({ code: 'vhost_failed', message: vhost.detail });
      if (faults.vhost) {
        vhost.ok = false;
        vhost.detail = `Wymuszony błąd kroku vhost: ${faults.vhost}`;
        errors.push({ code: 'vhost_failed', message: vhost.detail });
      }
    } else {
      steps.push({ key: 'vhost', label: 'Web server config', ok: true, skipped: true, detail: 'Generowanie vhosta pominięte.' });
    }

    if (createDns && !faults.dns) {
      const deployedDns = deployDnsStep({ domain: rawDomain, domainId, createDns: true, applyResult });
      const at = steps.findIndex((s) => s.key === 'dns');
      if (at >= 0) steps[at] = { ...steps[at], ...deployedDns };
      if (!deployedDns.ok) errors.push({ code: 'dns_failed', message: deployedDns.detail });
      else if (deployedDns.simulated) warnings.push('DNS is staged in sandbox mode; no live DNS server was reloaded.');
    }

    // 12. Optional backup profile — real backup_jobs row consumed by the
    // durable scheduler (not a decorative checkbox).
    if (!wantBackup) {
      steps.push({ key: 'backup', label: 'Backup profile', ok: true, skipped: true, detail: 'Profil backupu nie został wybrany.' });
    } else if (faults.backup) {
      addStep({ key: 'backup', label: 'Backup profile', ok: true, detail: 'backup' }, 'backup', { optional: true });
    } else {
      const backup = ensureSiteBackupJob({ domain: rawDomain, username: dbUser.username, actor: dbUser.username });
      addStep({ key: 'backup', label: 'Backup profile', ok: backup.ok, id: backup.id, nextRunAt: backup.nextRunAt, detail: backup.detail || backup.error }, '', { optional: true });
    }

    // 13. Optional monitoring profile with a real manual probe route.
    if (!wantMonitoring) {
      steps.push({ key: 'monitoring', label: 'Monitoring', ok: true, skipped: true, detail: 'Monitoring nie został wybrany.' });
    } else if (faults.monitoring) {
      addStep({ key: 'monitoring', label: 'Monitoring', ok: true, detail: 'monitoring' }, 'monitoring', { optional: true });
    } else {
      const monitor = enableMonitoring(rawDomain, dbUser.username, {
        scheme: get('SELECT ssl FROM domains WHERE id = ?', domainId)?.ssl ? 'https' : 'http',
      });
      addStep({ key: 'monitoring', label: 'Monitoring', ok: monitor.ok, detail: monitor.detail }, '', { optional: true });
    }

    const coreKeys = new Set(['domain', 'docroot', 'engine', 'php', 'dns', 'subdomains', 'ssl', 'mailbox', 'vhost']);
    const failedCore = steps.filter((s) => !s.ok && !s.skipped && coreKeys.has(s.key));
    const failedApp = appStep && !appStep.ok;
    let ok = failedCore.length === 0 && !failedApp;

    // Explicit, safe rollback only when the caller asked for it.
    let rolledBack = false;
    if (!ok && created && asBool(opts.rollbackOnFailure)) {
      if (appStep.ok && !appStep.skipped) {
        warnings.push('Rollback was not attempted because an application was installed; its database would be left orphaned. Remove the domain manually if needed.');
      } else {
        const rollback = rollbackCreatedSite({ user: dbUser, domain: rawDomain, domainId });
        rolledBack = rollback.ok;
        steps.push({ key: 'rollback', label: 'Rollback', ok: rollback.ok, detail: rollback.detail });
        if (!rollback.ok) warnings.push(rollback.detail);
      }
    }

    const sslEnabled = rolledBack ? 0 : get('SELECT ssl FROM domains WHERE id = ?', domainId)?.ssl;
    const scheme = sslEnabled ? 'https' : 'http';
    const result = {
      ok,
      created,
      domain: rawDomain,
      domainId: rolledBack ? null : domainId,
      docroot,
      engine,
      engineLabel: SERVERS[engine]?.label || engine,
      phpVersion: created ? phpVersion : (existing?.php_version || phpVersion),
      sslMode: sslMode || 'none',
      dnsTemplate: dnsInfo?.template || (dnsTemplate ? { id: dnsTemplate.id, name: dnsTemplate.name } : null),
      mailbox: mailboxAddress ? { address: mailboxAddress } : null,
      backup: steps.find((s) => s.key === 'backup' && !s.skipped) || null,
      monitoring: steps.find((s) => s.key === 'monitoring' && !s.skipped) || null,
      steps,
      errors,
      warnings,
      links: rolledBack ? {} : {
        site: `${scheme}://${rawDomain}/`,
        files: `/user/files?path=${encodeURIComponent(docroot)}`,
        dns: `/user/dns?domain=${encodeURIComponent(rawDomain)}`,
        ssl: `/user/ssl?domain=${encodeURIComponent(rawDomain)}`,
        email: `/user/email/new?domain=${encodeURIComponent(rawDomain)}`,
        domain: `/user/domains/${domainId}/edit`,
        retry: `/user/domains/${domainId}/edit#last-provision-status`,
      },
      app: appInfo,
      rolledBack,
      simulated: !!(steps.find((s) => s.key === 'vhost')?.simulated),
    };
    if (!rolledBack) {
      saveStatus(rawDomain, {
        ...result,
        options: {
          docroot: docrootEnabled, php: phpEnabled, vhost: vhostEnabled,
          mailbox: mailbox ? { local: mailbox.local, quotaMb: mailbox.quotaMb } : null,
          backup: wantBackup, monitoring: wantMonitoring,
          delegation: delegationRequested, retrySslAfterDns,
          dnsTemplateId: dnsTemplate?.id || null,
        },
      });
      try { audit(dbUser.username, dbUser.level, created ? 'site.create' : 'site.ensure', rawDomain, ip); } catch { /* audit is best effort */ }
    }
    return result;
  }

  // Domain creation itself failed — no pipeline to run.
  if (domainFailed) {
    return {
      ok: false, created: false, domain: rawDomain, domainId, docroot, engine,
      engineLabel: SERVERS[engine]?.label || engine, phpVersion, sslMode,
      steps, errors: errors.length ? errors : [{ code: 'domain_failed', message: steps[0]?.detail || 'Could not create the domain.' }],
      warnings, links: {}, app: null, rolledBack: false, simulated: false,
    };
  }
  // Unreachable, but keeps the contract explicit.
  return failResult({ domain: rawDomain, engine, phpVersion, sslMode, errors: [{ code: 'provision_failed', message: 'Provisioning did not run.' }], dbUser, ip });
}

/* ------------------------------------------------------- retry / defaults */

const RETRYABLE_STEPS = new Set(['docroot', 'engine', 'php', 'dns', 'delegation', 'ssl', 'mailbox', 'backup', 'monitoring', 'vhost']);

function mergeSteps(previous = [], retried = []) {
  const map = new Map(retried.map((step) => [step.key, step]));
  const merged = previous.map((step) => (map.has(step.key) ? map.get(step.key) : step));
  for (const step of retried) if (!merged.some((entry) => entry.key === step.key)) merged.push(step);
  return merged;
}

function stepOk(steps = []) {
  return steps.every((step) => step.ok || step.skipped || step.optional);
}

/**
 * Retry only the requested (or previously failed) provisioning steps. Every
 * operation is idempotent and ownership is re-checked before any write.
 */
export function retrySiteSteps({ user, domain, steps = [], ip = '' } = {}) {
  const dbUser = resolveUser(user);
  const name = String(domain || '').trim().toLowerCase();
  const base = { ok: false, domain: name, domainId: null, retried: [], steps: [], errors: [], warnings: [], links: {} };
  if (!dbUser) return { ...base, errors: [{ code: 'invalid_user', message: 'A valid panel account is required.' }] };
  if (!isDomain(name)) return { ...base, errors: [{ code: 'invalid_domain', message: 'Invalid domain name.' }] };
  const row = get('SELECT * FROM domains WHERE name = ?', name);
  if (!row) return { ...base, errors: [{ code: 'not_found', message: 'Domain not found.' }] };
  if (row.user_id !== dbUser.id) return { ...base, errors: [{ code: 'foreign_domain', message: 'This domain belongs to another account.' }] };

  const previous = lastProvision(name) || { steps: [], warnings: [], options: null, engine: '' };
  const options = previous.options || {};
  const requested = (Array.isArray(steps) ? steps : String(steps || '').split(','))
    .map((value) => String(value || '').trim()).filter(Boolean);
  const failed = (previous.steps || []).filter((step) => !step.ok && !step.skipped).map((step) => step.key);
  const failedSet = new Set(failed);
  // The UI only offers failed steps; enforce that contract server-side so a
  // crafted request cannot rebuild healthy resources unnecessarily.
  const keys = (requested.length ? requested : failed)
    .filter((key) => RETRYABLE_STEPS.has(key))
    .filter((key) => !requested.length || !previous.steps?.length || failedSet.has(key));
  if (!keys.length) {
    return {
      ...base,
      ok: stepOk(previous.steps || []),
      domainId: row.id,
      steps: previous.steps || [],
      warnings: previous.warnings || [],
      links: { domain: `/user/domains/${row.id}/edit` },
    };
  }

  const retried = [];
  const errors = [];
  const warnings = [];
  const engine = previous.engine || setting(`web_server:${name}`, '') || activeServer().id;
  const phpVersion = previous.phpVersion || row.php_version || setting('php_default', '8.3');
  const docroot = row.docroot || `/home/${dbUser.username}/domains/${name}/public_html`;
  const failRetry = (key, label, detail) => {
    const step = { key, label, ok: false, detail };
    retried.push(step);
    errors.push({ code: `${key}_failed`, message: detail });
    return step;
  };

  for (const key of keys) {
    try {
      if (key === 'docroot') {
        const shown = provisionDomain(dbUser.username, name);
        retried.push({ key, label: 'Document root', ok: true, detail: `Document root ready at ${shown || docroot}` });
      } else if (key === 'engine') {
        setSetting(`web_server:${name}`, engine);
        pruneStaleVhosts(name, engine);
        retried.push({ key, label: 'Web engine', ok: true, detail: `${SERVERS[engine]?.label || engine} — setting web_server:${name}` });
      } else if (key === 'php') {
        run('UPDATE domains SET php_version = ? WHERE id = ?', phpVersion, row.id);
        retried.push({ key, label: 'PHP runtime', ok: true, detail: `PHP ${phpVersion} zapisany dla ${name}.` });
      } else if (key === 'dns') {
        const zone = createZone(row.id, name, {
          templateId: options.dnsTemplateId || previous.dnsTemplate?.id || null,
          packageName: dbUser.package || '', reseller: dbUser.owner || '', actor: dbUser.username,
          ip: row.ip || setting('server_ip', '127.0.0.1'),
        });
        if (!zone.ok) { failRetry(key, 'DNS zone', zone.error || 'Nie udało się zbudować strefy DNS.'); continue; }
        const applied = runApply({ dns: true });
        const deployed = deployDnsStep({ domain: name, domainId: row.id, createDns: true, applyResult: applied });
        retried.push({ ...deployed, template: zone.template, source: zone.source, records: zone.records, detail: deployed.detail || `${zone.records} rekord(ów) DNS gotowych.` });
        if (!deployed.ok) errors.push({ code: 'dns_failed', message: deployed.detail });
      } else if (key === 'delegation') {
        const probe = probeDelegation(name);
        retried.push({ key, label: 'Delegation check', ok: !!probe.ok, status: probe.status, ns: probe.ns, expected: probe.expected, detail: probe.detail });
        if (!probe.ok) warnings.push(`Delegacja: ${probe.detail}`);
      } else if (key === 'ssl') {
        const mode = ['none', 'selfsigned', 'letsencrypt'].includes(previous.sslMode) ? previous.sslMode : 'selfsigned';
        const ssl = applySsl({ domain: name, docroot, sslMode: mode, email: dbUser.email || '' });
        if (options.retrySslAfterDns && mode === 'letsencrypt' && ssl.fallback) {
          try {
            const queued = enqueueAcme(name, {
              username: dbUser.username, actorLevel: dbUser.level, email: dbUser.email || '',
              mode: 'letsencrypt', challenge: 'http-01', source: 'site-retry',
              reason: 'SSL retry after DNS preflight', maxAttempts: Number(setting('acme_max_attempts', '5')) || 5,
              baseBackoffSeconds: Number(setting('acme_retry_backoff_seconds', '300')) || 300,
            });
            if (queued.ok) {
              ssl.queue = { id: queued.entry.id, status: queued.entry.status, nextAttemptAt: queued.entry.nextAttemptAt };
              ssl.detail = `${ssl.detail} ACME retry queued (#${queued.entry.id}).`;
            }
          } catch (error) { warnings.push(`ACME: ${error.message}`); }
        }
        retried.push(ssl);
        if (ssl.warning) warnings.push(ssl.warning);
        if (!ssl.ok) errors.push({ code: 'ssl_failed', message: ssl.detail });
      } else if (key === 'mailbox') {
        const local = options.mailbox?.local || 'postmaster';
        const current = get('SELECT * FROM email_accounts WHERE domain = ? AND local_part = ?', name, local);
        if (current) {
          retried.push({ key, label: 'Primary mailbox', ok: true, skipped: true, address: `${local}@${name}`, detail: `Skrzynka ${local}@${name} już istnieje.` });
        } else {
          const quotaMb = Number(options.mailbox?.quotaMb ?? 1024);
          const password = randomStrongPassword(16);
          let mailHash = null;
          try { mailHash = dovecotHash(password); } catch { mailHash = null; }
          run(`INSERT INTO email_accounts(domain_id, domain, local_part, password, quota_mb, used_mb, suspended, created_at, mail_hash)
               VALUES(?,?,?,?,?,?,?,?,?)`, row.id, name, local, hashPassword(password), quotaMb, 0, 0, nowIso(), mailHash);
          try { syncMail(); } catch (error) { warnings.push(`Poczta zsynchronizowana częściowo: ${error.message}`); }
          retried.push({ key, label: 'Primary mailbox', ok: true, address: `${local}@${name}`, detail: `Skrzynka ${local}@${name} utworzona (${quotaMb} MB).` });
        }
      } else if (key === 'backup') {
        const backup = ensureSiteBackupJob({ domain: name, username: dbUser.username, actor: dbUser.username });
        retried.push({ key, label: 'Backup profile', ok: backup.ok, id: backup.id, detail: backup.detail || backup.error });
      } else if (key === 'monitoring') {
        const monitor = enableMonitoring(name, dbUser.username, { scheme: row.ssl ? 'https' : 'http' });
        retried.push({ key, label: 'Monitoring', ok: monitor.ok, detail: monitor.detail });
      } else if (key === 'vhost') {
        setSetting(`web_server:${name}`, engine);
        const applied = runApply({ web: true, dns: false });
        const vhost = vhostStep({ domain: name, engine, applyResult: applied });
        retried.push(vhost);
        if (!vhost.ok) errors.push({ code: 'vhost_failed', message: vhost.detail });
      }
    } catch (error) {
      failRetry(key, key, `Ponowienie kroku ${key} nie powiodło się: ${error.message}`);
    }
  }

  const merged = mergeSteps(previous.steps || [], retried);
  const coreKeys = new Set(['domain', 'docroot', 'engine', 'php', 'dns', 'subdomains', 'ssl', 'mailbox', 'vhost']);
  const ok = merged.every((step) => step.ok || step.skipped || step.optional || !coreKeys.has(step.key)) && errors.length === 0;
  const result = {
    ok,
    domain: name,
    domainId: row.id,
    engine,
    phpVersion,
    steps: merged,
    retried,
    errors,
    warnings: [...(previous.warnings || []), ...warnings],
    links: { domain: `/user/domains/${row.id}/edit`, ssl: `/user/ssl?domain=${encodeURIComponent(name)}` },
  };
  saveStatus(name, {
    ok,
    created: false,
    engine,
    phpVersion,
    sslMode: previous.sslMode || '',
    dnsTemplate: previous.dnsTemplate || null,
    options: previous.options || null,
    steps: merged,
    warnings: result.warnings,
  });
  try { audit(dbUser.username, dbUser.level, 'site.retry', `${name}:${keys.join(',')}`, ip); } catch { /* audit is best effort */ }
  return result;
}

/** Safe defaults for both guided forms, optionally remembering the last
 *  successful choices per user and kind (domain/account). Passwords are never
 *  remembered. */
export function recommendedDefaults({ actor, kind = 'domain', packageName = '' } = {}) {
  const username = actor?.username || '';
  let saved = {};
  if (username) {
    try { saved = JSON.parse(setting(`provision_defaults:${username}:${kind}`, '{}')); } catch { saved = {}; }
  }
  const resolved = resolveTemplate({
    packageName: packageName || actor?.package || '',
    reseller: actor?.owner || (actor?.level === 'reseller' ? username : ''),
    domain: '',
  });
  return {
    engine: saved.engine || setting(`web_server`, '') || activeServer().id,
    phpVersion: saved.phpVersion || setting('php_default', '8.3'),
    sslMode: saved.sslMode || 'selfsigned',
    dnsTemplateId: saved.dnsTemplateId || resolved.template?.id || '',
    dnsTemplateName: resolved.template?.name || '',
    createDns: saved.createDns !== false,
    createMailbox: saved.createMailbox !== false,
    mailboxLocal: saved.mailboxLocal || 'postmaster',
    mailboxQuotaMb: saved.mailboxQuotaMb || 1024,
    backup: saved.backup !== false,
    monitoring: saved.monitoring !== false,
    delegationCheck: saved.delegationCheck === true,
    retrySslAfterDns: saved.retrySslAfterDns !== false,
    docroot: saved.docroot !== false,
    php: saved.php !== false,
    vhost: saved.vhost !== false,
  };
}

const REMEMBERED_DEFAULT_KEYS = new Set([
  'engine', 'phpVersion', 'sslMode', 'dnsTemplateId', 'createDns', 'createMailbox',
  'mailboxLocal', 'mailboxQuotaMb', 'backup', 'monitoring', 'delegationCheck',
  'retrySslAfterDns', 'docroot', 'php', 'vhost',
]);

/** Persist only non-secret, typed preferences. */
export function rememberChoices(actor, kind = 'domain', choices = {}) {
  if (!actor?.username || !choices || typeof choices !== 'object') return { ok: false };
  const safe = {};
  for (const [key, value] of Object.entries(choices)) {
    if (REMEMBERED_DEFAULT_KEYS.has(key) && ['string', 'number', 'boolean'].includes(typeof value)) safe[key] = value;
  }
  setSetting(`provision_defaults:${actor.username}:${kind}`, JSON.stringify(safe));
  return { ok: true, saved: Object.keys(safe) };
}

/**
 * Re-read the domain, persist its engine override and regenerate/deploy vhosts.
 * Used by the domain edit form and by tests. Never throws for validation.
 */
export function redeploySite({ user, domain, engine, createDns = false, ip = '' } = {}) {
  const dbUser = resolveUser(user);
  const name = String(domain || '').trim().toLowerCase();
  if (!dbUser) return { ok: false, engine: normalizeEngine(engine, activeServer().id), steps: [], warnings: [], errors: [{ code: 'invalid_user', message: 'A valid panel account is required.' }] };
  if (!isDomain(name)) return { ok: false, engine: normalizeEngine(engine, activeServer().id), steps: [], warnings: [], errors: [{ code: 'invalid_domain', message: 'Invalid domain name.' }] };
  const row = get('SELECT * FROM domains WHERE name = ?', name);
  if (!row) return { ok: false, engine: normalizeEngine(engine, activeServer().id), steps: [], warnings: [], errors: [{ code: 'not_found', message: 'Domain not found.' }] };
  if (row.user_id !== dbUser.id) return { ok: false, engine: normalizeEngine(engine, activeServer().id), steps: [], warnings: [], errors: [{ code: 'foreign_domain', message: 'This domain belongs to another account.' }] };
  const chosen = normalizeEngine(engine, normalizeEngine(setting(`web_server:${name}`, ''), activeServer().id));
  const check = validateEngine(chosen);
  if (!check.ok) return { ok: false, engine: chosen, steps: [{ key: 'engine', label: 'Web engine', ok: false, detail: check.message }], warnings: [], errors: [{ code: check.code, message: check.message }] };
  setSetting(`web_server:${name}`, chosen);
  pruneStaleVhosts(name, chosen);
  const applyResult = runApply({ web: true, dns: asBool(createDns) });
  const vhost = vhostStep({ domain: name, engine: chosen, applyResult });
  const warnings = vhost.warning ? [vhost.warning] : [];
  const steps = [
    { key: 'engine', label: 'Web engine', ok: true, detail: `${SERVERS[chosen].label} — setting web_server:${name}` },
    vhost,
  ];
  if (asBool(createDns)) {
    const dns = deployDnsStep({ domain: name, domainId: row.id, createDns: true, applyResult });
    steps.push(dns);
    if (!dns.ok) warnings.push(dns.detail);
  }
  const ok = steps.every((s) => s.ok || s.skipped);
  const result = { ok, domain: name, domainId: row.id, engine: chosen, steps, warnings, errors: ok ? [] : [{ code: 'vhost_failed', message: vhost.detail }], links: { domain: `/user/domains/${row.id}/edit` } };
  saveStatus(name, { ...result, phpVersion: row.php_version, sslMode: '' });
  try { audit(dbUser.username, dbUser.level, 'site.redeploy', name, ip); } catch { /* audit is best effort */ }
  return result;
}
