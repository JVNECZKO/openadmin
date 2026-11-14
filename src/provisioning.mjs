// Coherent site provisioning: one idempotent entry point used by the domain
// page, the "add a website" wizard and tests. It owns the order of operations
// (domain row → engine override → document root → DNS → subdomains → SSL →
// optional application → vhost generation/apply) and reports an honest,
// ordered step list instead of a single opaque "success".
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, setting, setSetting, nowIso, audit } from './db.mjs';
import { config } from './config.mjs';
import { isDomain, isEmail, isUsername } from './util.mjs';
import { quota } from './core/access.mjs';
import { userHome } from './paths.mjs';
import { provisionDomain } from './features/files.mjs';
import { SERVERS, activeServer, detect, stagingDir } from './webserver.mjs';
import { apply } from './apply.mjs';
import { rebuildZone, zonePath, zoneMeta } from './dns.mjs';
import { generateSelfSigned, issueLetsEncrypt, activeCert } from './ssl.mjs';
import { systemProvider } from './providers/index.mjs';
import { installWordPress } from './wordpress.mjs';
import { installNextcloud } from './nextcloud.mjs';

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
 *  a second call refreshes the staged zone instead of duplicating records. */
export function createZone(domainId, domain) {
  const existing = all('SELECT id FROM dns_records WHERE domain_id = ?', domainId);
  if (!existing.length) {
    const ip = setting('server_ip', '127.0.0.1');
    const ns1 = setting('ns1', 'ns1.localhost');
    const ns2 = setting('ns2', 'ns2.localhost');
    const records = [
      ['@', 'A', ip, null, 3600],
      ['www', 'A', ip, null, 3600],
      ['mail', 'A', ip, null, 3600],
      ['ftp', 'A', ip, null, 3600],
      ['@', 'MX', `mail.${domain}.`, 10, 3600],
      ['@', 'TXT', `v=spf1 a mx ip4:${ip} ~all`, null, 3600],
      ['_dmarc', 'TXT', `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`, null, 3600],
      ['@', 'NS', ns1.endsWith('.') ? ns1 : ns1 + '.', null, 3600],
      ['@', 'NS', ns2.endsWith('.') ? ns2 : ns2 + '.', null, 3600],
      ['_imaps._tcp', 'SRV', `0 1 993 mail.${domain}.`, null, 3600],
      ['_submission._tcp', 'SRV', `0 1 587 mail.${domain}.`, null, 3600],
    ];
    for (const [name, type, value, priority, ttl] of records) {
      run('INSERT INTO dns_records(domain_id, name, type, value, priority, ttl) VALUES(?,?,?,?,?,?)',
        domainId, name, type, value, priority, ttl);
    }
  }
  let zone = null;
  try { zone = rebuildZone(domain); } catch { /* staging is best effort; apply reports deployment */ }
  return {
    ok: true,
    created: !existing.length,
    records: get('SELECT COUNT(*) n FROM dns_records WHERE domain_id = ?', domainId).n,
    file: zone?.file || zonePath(domain),
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
    return { ok: true, key: 'ssl', label: 'SSL certificate', mode, detail: "Let's Encrypt certificate installed" };
  }
  const warning = `Let's Encrypt failed (${acme.error || 'unknown error'}); a self-signed certificate was used as the fallback.`;
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
  if (!count) detail = 'No DNS records were created';
  else if (dns.error) detail = `Zone built but deployment failed: ${dns.error}`;
  else if (dns.ok === false) detail = `Zone built but deployment failed: ${dns.output || 'unknown error'}`;
  else if (dns.simulated) detail = `Zone ${zonePath(domain)} with ${count} record(s) staged (sandbox: DNS server not reloaded)`;
  else detail = `Zone ${zonePath(domain)} with ${count} record(s) deployed${meta?.checked ? ' and validated' : ''}`;
  return {
    key: 'dns',
    label: 'DNS zone',
    ok,
    simulated: !!dns.simulated,
    records: count,
    file: zonePath(domain),
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
    cleanupDomainFiles({ user, domain });
    run('DELETE FROM ssl_certs WHERE domain = ?', domain);
    run('DELETE FROM domains WHERE id = ?', domainId);
    setSetting(`web_server:${domain}`, '');
    try { fs.rmSync(zonePath(domain), { force: true }); } catch { /* ignore */ }
    return { ok: true, detail: `Rolled back the partially created domain ${domain} (vhost, zone, files, rows)` };
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

/* ------------------------------------------------------------------- site */

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
  const ip = String(opts.ip || '');
  const errors = [];
  const warnings = [];

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
  const normalizedSubdomains = normalizeSubdomains(opts.subdomains);
  errors.push(...normalizedSubdomains.errors);
  const appInput = normalizeApp(opts.app);
  if (appInput.error) errors.push(appInput.error);
  const app = appInput.app || { type: 'none' };

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

  // 1. Domain row.
  if (created) {
    try {
      const isMain = get('SELECT COUNT(*) n FROM domains WHERE user_id = ?', dbUser.id).n === 0 ? 1 : 0;
      const inserted = run(`INSERT INTO domains(user_id, username, name, docroot, php_version, ssl, status, is_main, ip, created_at)
                            VALUES(?,?,?,?,?,?,?,?,?,?)`,
        dbUser.id, dbUser.username, rawDomain, docroot, phpVersion, 0, 'active', isMain,
        setting('server_ip', '127.0.0.1'), nowIso());
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
      }
    }
  } else {
    steps.push({ key: 'domain', label: 'Domain', ok: true, skipped: true, detail: `Domain ${rawDomain} already exists (#${domainId})` });
  }

  // 2. Document root and placeholder index.
  if (!domainFailed) {
    try {
      const shown = provisionDomain(dbUser.username, rawDomain);
      docroot = get('SELECT docroot FROM domains WHERE id = ?', domainId)?.docroot || docroot || shown;
      steps.push({ key: 'docroot', label: 'Document root', ok: true, detail: `Document root ready at ${docroot}` });
    } catch (e) {
      steps.push({ key: 'docroot', label: 'Document root', ok: false, detail: `Could not provision the document root: ${e.message}` });
    }

    // 3. Per-domain engine override (same key as src/webserver.mjs).
    try {
      setSetting(`web_server:${rawDomain}`, engine);
      pruneStaleVhosts(rawDomain, engine);
      steps.push({ key: 'engine', label: 'Web engine', ok: true, detail: `${SERVERS[engine].label} — setting web_server:${rawDomain}` });
    } catch (e) {
      steps.push({ key: 'engine', label: 'Web engine', ok: false, detail: `Could not persist the engine override: ${e.message}` });
    }

    // 4. Optional DNS zone.
    let zoneRecords = 0;
    if (createDns) {
      try {
        const zone = createZone(domainId, rawDomain);
        zoneRecords = zone.records;
        steps.push({ key: 'dns', label: 'DNS zone', ok: zoneRecords > 0, records: zoneRecords, detail: zoneRecords > 0 ? `Created ${zoneRecords} DNS record(s) in ${zone.file}` : 'No DNS records were created' });
      } catch (e) {
        steps.push({ key: 'dns', label: 'DNS zone', ok: false, detail: `Could not build the DNS zone: ${e.message}` });
      }
    } else {
      steps.push({ key: 'dns', label: 'DNS zone', ok: true, skipped: true, records: 0, detail: 'DNS zone was not requested' });
    }

    // 5. Subdomains: row, document root and (when a zone exists) an A record.
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

    // 6. SSL before vhost generation so the certificate lands in the config.
    // Re-running createSite without an explicit SSL mode never downgrades an
    // existing certificate; it simply reports the current state.
    let ssl;
    if (!created && !sslExplicit) {
      const currentSsl = get('SELECT ssl FROM domains WHERE id = ?', domainId)?.ssl;
      ssl = {
        key: 'ssl', label: 'SSL certificate', mode: 'keep', skipped: true,
        detail: currentSsl ? 'SSL left unchanged (certificate already configured)' : 'SSL left unchanged (currently disabled)',
      };
    } else {
      ssl = applySsl({ domain: rawDomain, docroot, sslMode, email: dbUser.email || '' });
    }
    if (ssl.warning) warnings.push(ssl.warning);
    steps.push(ssl);
    if (!ssl.ok) errors.push({ code: 'ssl_failed', message: ssl.detail });

    // 7. Optional app through the existing installers.
    let appInfo = null;
    let appStep = { key: 'app', label: 'Application', ok: true, skipped: true, detail: 'No application selected' };
    if (app.type !== 'none') {
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

    // 8. Generate and apply vhosts (and DNS) through the existing pipeline.
    const applyResult = runApply({ web: true, dns: createDns });
    if (applyResult.error) warnings.push(`apply() failed: ${applyResult.error}`);
    const vhost = vhostStep({ domain: rawDomain, engine, applyResult });
    if (vhost.warning) warnings.push(vhost.warning);
    steps.push(vhost);
    if (!vhost.ok) errors.push({ code: 'vhost_failed', message: vhost.detail });

    if (createDns) {
      const deployedDns = deployDnsStep({ domain: rawDomain, domainId, createDns: true, applyResult });
      const at = steps.findIndex((s) => s.key === 'dns');
      if (at >= 0) steps[at] = { ...steps[at], ...deployedDns };
      if (!deployedDns.ok) errors.push({ code: 'dns_failed', message: deployedDns.detail });
      else if (deployedDns.simulated) warnings.push('DNS is staged in sandbox mode; no live DNS server was reloaded.');
    }

    const failedCore = steps.filter((s) => !s.ok && !s.skipped && ['domain', 'docroot', 'engine', 'dns', 'subdomains', 'ssl', 'vhost'].includes(s.key));
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

    const sslEnabled = get('SELECT ssl FROM domains WHERE id = ?', domainId)?.ssl;
    const scheme = sslEnabled ? 'https' : 'http';
    const result = {
      ok,
      created,
      domain: rawDomain,
      domainId,
      docroot,
      engine,
      engineLabel: SERVERS[engine]?.label || engine,
      phpVersion: created ? phpVersion : (existing?.php_version || phpVersion),
      sslMode: sslMode || 'none',
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
      },
      app: appInfo,
      rolledBack,
      simulated: !!(steps.find((s) => s.key === 'vhost')?.simulated),
    };
    if (!rolledBack) {
      saveStatus(rawDomain, result);
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
