// AutoSSL: ACME queue with DNS/HTTP preflight, exponential retry, renewal
// schedule, late alerts and an explicit self-signed fallback.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { all, get, run, nowIso, setting, setSetting, audit } from './db.mjs';
import { generateSelfSigned, issueLetsEncrypt, certbotAvailable, validatePem, certPaths } from './ssl.mjs';
import { writeManaged, backupFile, serviceReload, sh, which, isRoot } from './sys.mjs';
import { addNotification } from './notifications.mjs';
import { isDomain } from './util.mjs';

const QUEUE_KEY = 'acme_queue';
const QUEUE_LIMIT = 200;
const ACTIVE_STATUSES = new Set(['queued', 'waiting_dns', 'retrying', 'issuing']);
const TERMINAL_STATUSES = new Set(['issued', 'failed', 'cancelled']);

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

function iso(ms) { return new Date(ms).toISOString(); }

function maxAttemptsSetting() {
  const value = Number(setting('acme_max_attempts', '5'));
  return Number.isInteger(value) ? Math.min(20, Math.max(1, value)) : 5;
}

function baseBackoffSetting() {
  const value = Number(setting('acme_retry_backoff_seconds', '300'));
  return Number.isInteger(value) ? Math.min(86400, Math.max(30, value)) : 300;
}

/* --------------------------------------------------------------- preflight */

function httpGet(url, timeout = 4000) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(url); } catch { resolve({ ok: false, error: 'invalid-url' }); return; }
    const lib = target.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    const request = lib.request(target, { method: 'GET', timeout, headers: { 'User-Agent': 'OpenAdmin-ACME-Preflight/1.0' } }, (response) => {
      response.resume();
      response.on('end', () => finish({ ok: true, status: response.statusCode }));
      response.on('error', (error) => finish({ ok: false, error: error.message }));
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => finish({ ok: false, error: error.code || error.message }));
    request.end();
  });
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

function docrootStatus(domain) {
  const row = get('SELECT docroot FROM domains WHERE name = ?', domain);
  if (!row) return { ok: false, exists: false, writable: false, docroot: '', detail: 'Domena nie istnieje w panelu.' };
  const display = row.docroot || '';
  // The panel stores DirectAdmin-compatible /home paths; in the sandbox the
  // same tree lives under the data directory. Check the real location.
  const actual = config.provider === 'linux'
    ? display
    : display.replace(/^\/home\//, path.join(config.dataDir, 'homes') + '/');
  let writable = false;
  try { fs.accessSync(actual, fs.constants.W_OK); writable = true; } catch { writable = false; }
  return { ok: writable, exists: fs.existsSync(actual), writable, docroot: display, detail: writable ? `Document root ${display} jest zapisywalny.` : `Document root ${display || '(brak)'} nie istnieje lub nie jest zapisywalny.` };
}

/**
 * DNS/HTTP preflight for one certificate. Every check reports the real result;
 * retryable failures are exactly the ones DNS propagation or a fresh web
 * server reload can fix. The self-signed fallback is explicit, never implied.
 */
export async function preflightAcme(domain, options = {}) {
  const challenge = options.challenge === 'dns-01' ? 'dns-01' : 'http-01';
  const mode = options.mode === 'selfsigned' ? 'selfsigned' : 'letsencrypt';
  const email = String(options.email || '');
  const deps = { ...options, ...(options.deps || {}) };
  const name = String(domain || '').trim().toLowerCase();
  const checks = [];
  const wantLetsEncrypt = mode !== 'selfsigned';
  const now = Number(deps.now) || Date.now();
  const add = (key, label, ok, detail, extra = {}) => checks.push({ key, label, ok: !!ok, detail: String(detail || ''), ...extra });
  const row = isDomain(name) ? get('SELECT * FROM domains WHERE name = ?', name) : null;
  add('domain', 'Domena w panelu', !!row, row ? `Domena ${name} istnieje.` : 'Domena nie istnieje w panelu.');
  if (!row) {
    return {
      ok: false, domain: name, challenge, mode, checks, recommended: 'manual', retryable: false,
      serverIp: setting('server_ip', '127.0.0.1'), checkedAt: iso(now),
      errors: [{ code: 'domain_missing', message: 'Domena nie istnieje w panelu.' }], warnings: [],
    };
  }
  const docroot = docrootStatus(name);
  add('docroot', 'Document root', docroot.ok, docroot.detail);
  const certbot = deps.certbot !== undefined ? deps.certbot : certbotAvailable();
  if (wantLetsEncrypt) {
    add('certbot', 'Certbot / ACME', !!certbot, certbot ? `Certbot: ${certbot}` : 'Certbot nie jest zainstalowany — niedostępne jest wystawianie Let’s Encrypt.', { severity: 'warn' });
  } else {
    add('certbot', 'Certbot / ACME', true, 'Tryb self-signed — ACME nie jest wymagane.', { skipped: true });
  }
  const serverIp = String(deps.serverIp || setting('server_ip', '127.0.0.1'));
  let addresses = [];
  let dnsError = '';
  const resolve4 = deps.resolve4 || dns.resolve4;
  try {
    addresses = (await withTimeout(resolve4(name), Number(deps.dnsTimeoutMs) || 2500)) || [];
  } catch (error) {
    dnsError = error.code || error.message || 'DNS error';
    addresses = [];
  }
  const dnsOk = addresses.includes(serverIp);
  const isDnsChallenge = challenge === 'dns-01';
  if (isDnsChallenge) {
    const expected = [setting('ns1', ''), setting('ns2', '')].filter(Boolean).map((value) => String(value).replace(/\.$/, '').toLowerCase());
    let ns = [];
    try { ns = (await withTimeout((deps.resolveNs || dns.resolveNs)(name), Number(deps.dnsTimeoutMs) || 2500)) || []; } catch { ns = []; }
    const nsNormalized = ns.map((value) => String(value).replace(/\.$/, '').toLowerCase());
    const delegated = expected.length ? expected.some((value) => nsNormalized.includes(value)) : nsNormalized.length > 0;
    add('dns', 'Delegacja DNS dla DNS-01', delegated,
      nsNormalized.length ? `NS: ${nsNormalized.join(', ')}` : 'Brak publicznych rekordów NS.',
      { severity: 'warn', retryable: true });
    add('http', 'HTTP-01 na porcie 80', true, 'Pominięte — wybrano wyzwanie DNS-01.', { skipped: true });
  } else {
    add('dns', 'DNS wskazuje na ten serwer', dnsOk,
      dnsOk ? `A ${name} → ${addresses.join(', ')} (serwer ${serverIp}).`
        : addresses.length
          ? `A ${name} → ${addresses.join(', ')}; oczekiwano ${serverIp}. Delegacja/propagacja może być jeszcze w toku.`
          : `Brak rekordu A dla ${name}${dnsError ? ` (${dnsError})` : ''} — DNS nie propagował się jeszcze.`,
      { severity: 'warn', retryable: true });
    const probeUrl = `http://${name}/.well-known/acme-challenge/openadmin-preflight`;
    if (dnsOk) {
      const probe = await withTimeout((deps.probeHttp || httpGet)(probeUrl), Number(deps.httpTimeoutMs) || 4000);
      if (!probe) add('http', 'HTTP-01 na porcie 80', false, 'Przekroczenie czasu probe HTTP.', { severity: 'warn', retryable: true });
      else if (!probe.ok) add('http', 'HTTP-01 na porcie 80', false, `Port 80 nie odpowiada: ${probe.error || 'błąd połączenia'}.`, { severity: 'warn', retryable: true });
      else add('http', 'HTTP-01 na porcie 80', true, `Serwer WWW odpowiada HTTP ${probe.status} — wyzwanie HTTP-01 jest obsługiwane.`);
    } else {
      add('http', 'HTTP-01 na porcie 80', false, 'Probe HTTP pominięty do czasu poprawnego DNS.', { severity: 'warn', skipped: true, retryable: true });
    }
  }

  const errors = checks.filter((check) => !check.ok && !check.skipped && ['domain', 'docroot'].includes(check.key))
    .map((check) => ({ code: check.key === 'domain' ? 'domain_missing' : 'docroot_unavailable', message: check.detail }));
  const retryable = checks.some((check) => check.ok === false && check.retryable);
  const hardFailure = !docroot.ok || (!wantLetsEncrypt ? false : !certbot);
  const ok = checks.filter((check) => !check.skipped).every((check) => check.ok);
  const fallback = !wantLetsEncrypt
    ? { mode: 'selfsigned', available: true, detail: 'Wybrano certyfikat self-signed — przeglądarki pokażą ostrzeżenie.' }
    : !certbot
      ? { mode: 'selfsigned', available: true, detail: 'Certbot nie jest zainstalowany; panel może wystawić certyfikat self-signed i oznaczy go jako fallback.' }
      : !ok && retryable
        ? { mode: 'selfsigned', available: true, detail: 'ACME nie jest jeszcze gotowe (DNS/HTTP); do czasu ponowienia można używać self-signed.' }
        : null;
  const recommended = !wantLetsEncrypt ? 'selfsigned' : (!certbot || hardFailure ? (docroot.ok ? 'selfsigned' : 'manual') : (ok ? 'letsencrypt' : (retryable ? 'retry' : 'manual')));
  return {
    ok: wantLetsEncrypt ? ok : checks.filter((check) => check.key === 'domain' || check.key === 'docroot').every((check) => check.ok),
    domain: name, challenge, mode, checks, errors,
    warnings: checks.filter((check) => check.ok === false && check.retryable).map((check) => check.detail),
    retryable, recommended, fallback, certbot: certbot || '', serverIp,
    addresses, docroot: docroot.docroot, checkedAt: iso(now),
  };
}

/* ------------------------------------------------------------------ queue */

function loadQueue() {
  try {
    const parsed = JSON.parse(setting(QUEUE_KEY, '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveQueue(queue) {
  setSetting(QUEUE_KEY, JSON.stringify((Array.isArray(queue) ? queue : []).slice(0, QUEUE_LIMIT)));
}

function newId() { return `a${crypto.randomBytes(8).toString('hex')}`; }

function publicEntry(entry) {
  if (!entry) return null;
  return {
    ...entry,
    link: acmeDashboardLink(entry.domain, { level: entry.actorLevel || 'user' }),
    statusLabel: {
      queued: 'W kolejce', waiting_dns: 'Czeka na DNS', retrying: 'Ponawianie',
      issuing: 'Wystawianie', issued: 'Wystawiony', failed: 'Nieudany', cancelled: 'Anulowany',
    }[entry.status] || entry.status,
  };
}


/** Remove queued/active ACME work when a domain is deleted. */
export function purgeAcmeForDomain(domain) {
  const name = String(domain || '').trim().toLowerCase();
  if (!name) return { ok: false, error: 'Brak domeny' };
  const queue = loadQueue();
  const kept = queue.filter((entry) => String(entry.domain || '').toLowerCase() !== name);
  const removed = queue.length - kept.length;
  if (removed) saveQueue(kept);
  return { ok: true, removed };
}

export function acmeQueue({ domain = '', status = '', limit = 50 } = {}) {
  const list = loadQueue()
    .filter((entry) => !domain || entry.domain === domain)
    .filter((entry) => !status || (status === 'active' ? ACTIVE_STATUSES.has(entry.status) : entry.status === status))
    .sort((a, b) => Date.parse(a.nextAttemptAt || a.createdAt || 0) - Date.parse(b.nextAttemptAt || b.createdAt || 0));
  return list.slice(0, Math.max(1, Math.min(200, Number(limit) || 50))).map(publicEntry);
}

export function acmeEntry(id) {
  return publicEntry(loadQueue().find((entry) => entry.id === String(id)) || null);
}

export function acmeSummary() {
  const queue = loadQueue();
  const counts = {};
  for (const entry of queue) counts[entry.status] = (counts[entry.status] || 0) + 1;
  return {
    total: queue.length,
    active: queue.filter((entry) => ACTIVE_STATUSES.has(entry.status)).length,
    waiting: queue.filter((entry) => entry.status === 'waiting_dns' || entry.status === 'retrying').length,
    failed: queue.filter((entry) => entry.status === 'failed').length,
    issued: queue.filter((entry) => entry.status === 'issued').length,
    alerts: queue.filter((entry) => entry.status === 'failed' && entry.alertSent).length,
    counts,
  };
}

function activeForDomain(domain, mode = '') {
  return loadQueue().find((entry) => entry.domain === domain
    && ACTIVE_STATUSES.has(entry.status)
    && (!mode || entry.mode === mode));
}

/** Idempotent enqueue: a second request for the same domain/mode reuses the
 *  active job instead of creating duplicates. */
export function enqueueAcme(domain, {
  username = '', actorLevel = 'user', email = '', mode = 'letsencrypt', challenge = 'http-01',
  source = 'manual', reason = '', maxAttempts = maxAttemptsSetting(), baseBackoffSeconds = baseBackoffSetting(),
  now = Date.now(),
} = {}) {
  const name = String(domain || '').trim().toLowerCase();
  if (!isDomain(name)) return { ok: false, error: 'Nieprawidłowa domena' };
  if (!get('SELECT id FROM domains WHERE name = ?', name)) return { ok: false, error: 'Domena nie istnieje w panelu' };
  const normalizedMode = mode === 'selfsigned' ? 'selfsigned' : 'letsencrypt';
  const existing = activeForDomain(name, normalizedMode);
  if (existing) return { ok: true, reused: true, entry: publicEntry(existing) };
  const entry = {
    id: newId(),
    domain: name,
    username: String(username || ''),
    actorLevel: ['admin', 'reseller', 'user'].includes(actorLevel) ? actorLevel : 'user',
    email: String(email || ''),
    mode: normalizedMode,
    challenge: challenge === 'dns-01' ? 'dns-01' : 'http-01',
    source: String(source || 'manual').slice(0, 60),
    reason: String(reason || '').slice(0, 300),
    status: 'queued',
    attempts: 0,
    maxAttempts: Math.min(20, Math.max(1, Number(maxAttempts) || maxAttemptsSetting())),
    baseBackoffSeconds: Math.min(86400, Math.max(30, Number(baseBackoffSeconds) || baseBackoffSetting())),
    nextAttemptAt: iso(now),
    createdAt: iso(now),
    updatedAt: iso(now),
    lastError: '',
    lastPreflight: null,
    fallback: normalizedMode === 'selfsigned' ? 'selfsigned' : '',
    alertSent: false,
    history: [],
  };
  const queue = loadQueue();
  queue.unshift(entry);
  saveQueue(queue);
  logSsl(name, 'acme.queue', 'ok', `${normalizedMode}/${entry.challenge} source=${entry.source}${reason ? ` reason=${reason}` : ''}`);
  return { ok: true, reused: false, entry: publicEntry(entry) };
}

export function cancelAcme(id, actor = 'admin') {
  const queue = loadQueue();
  const entry = queue.find((item) => item.id === String(id));
  if (!entry) return { ok: false, error: 'Zadanie ACME nie istnieje' };
  if (TERMINAL_STATUSES.has(entry.status) && entry.status !== 'issued') return { ok: false, error: 'Zadanie już zakończone' };
  entry.status = 'cancelled';
  entry.updatedAt = nowIso();
  entry.nextAttemptAt = null;
  entry.history = [...(entry.history || []), { at: entry.updatedAt, action: 'cancelled', actor }];
  saveQueue(queue);
  logSsl(entry.domain, 'acme.cancel', 'ok', `id=${entry.id} actor=${actor}`);
  audit(actor, 'admin', 'ssl.acme.cancel', entry.domain, '');
  return { ok: true, entry: publicEntry(entry) };
}

export function retryAcme(id, actor = 'admin', { now = Date.now() } = {}) {
  const queue = loadQueue();
  const entry = queue.find((item) => item.id === String(id));
  if (!entry) return { ok: false, error: 'Zadanie ACME nie istnieje' };
  if (entry.status === 'issued') return { ok: false, error: 'Certyfikat jest już wystawiony' };
  entry.status = 'queued';
  entry.attempts = 0;
  entry.nextAttemptAt = iso(now);
  entry.updatedAt = iso(now);
  entry.lastError = '';
  entry.alertSent = false;
  entry.history = [...(entry.history || []), { at: entry.updatedAt, action: 'manual-retry', actor }];
  saveQueue(queue);
  logSsl(entry.domain, 'acme.retry', 'ok', `id=${entry.id} actor=${actor}`);
  audit(actor, 'admin', 'ssl.acme.retry', entry.domain, '');
  return { ok: true, entry: publicEntry(entry) };
}

function backoffMs(entry) {
  const base = Math.max(30, Number(entry.baseBackoffSeconds) || 300) * 1000;
  const attempt = Math.max(1, Number(entry.attempts) || 1);
  return Math.min(24 * 3600 * 1000, base * 2 ** Math.min(10, attempt - 1));
}

export function nextAttemptFor(entry, now = Date.now()) {
  return iso(Number(now) + backoffMs(entry));
}

function notifyExhausted(entry) {
  if (entry.alertSent) return null;
  entry.alertSent = true;
  const owner = entry.username
    ? get('SELECT id, username FROM users WHERE username = ?', entry.username)
    : get(`SELECT u.id, u.username FROM users u JOIN domains d ON d.user_id = u.id WHERE d.name = ?`, entry.domain);
  const link = acmeDashboardLink(entry.domain, { level: entry.actorLevel || 'user' });
  const result = addNotification({
    userId: owner?.id || null,
    level: 'danger',
    title: `SSL: nie udało się wystawić certyfikatu dla ${entry.domain}`,
    body: `Po ${entry.attempts} próbach ACME nadal zwraca błąd: ${entry.lastError || 'nieznany błąd'}. `
      + (entry.fallback ? `Aktywny fallback: ${entry.fallback}. ` : '')
      + 'Sprawdź DNS/port 80 i ponów z kolejki ACME.',
    link,
    dedupeKey: `acme-exhausted:${entry.domain}`,
    dedupeWindowMs: 24 * 3600 * 1000,
  });
  logSsl(entry.domain, 'acme.alert', 'error', `attempts=${entry.attempts} ${entry.lastError || ''}`.trim());
  return { domain: entry.domain, notificationId: result.id, link };
}

function fallbackCertificate(entry, deps = {}) {
  if (typeof deps.fallback === 'function') return deps.fallback(entry);
  const days = Number(setting('ssl_selfsigned_days', '365')) || 365;
  return generateSelfSigned(entry.domain, days);
}

function issueForEntry(entry, preflight, deps = {}) {
  if (typeof deps.issue === 'function') return deps.issue(entry, preflight);
  return issueLetsEncrypt(entry.domain, preflight.docroot || setting('server_docroot', ''), entry.email || setting('admin_email', ''));
}

function failEntry(entry, message, { now, retryable, alerts }) {
  entry.attempts = Number(entry.attempts) || 1;
  entry.lastError = String(message || 'nieznany błąd').slice(0, 500);
  entry.updatedAt = iso(now);
  entry.history = [...(entry.history || []).slice(-19), { at: entry.updatedAt, attempt: entry.attempts, action: 'failed', detail: entry.lastError }];
  if (entry.attempts >= entry.maxAttempts || !retryable) {
    entry.status = 'failed';
    entry.nextAttemptAt = null;
    const alert = notifyExhausted(entry);
    if (alert) alerts.push(alert);
    return 'failed';
  }
  entry.status = retryable ? 'retrying' : 'retrying';
  entry.nextAttemptAt = nextAttemptFor(entry, now);
  logSsl(entry.domain, 'acme.retry', 'error', `attempt=${entry.attempts}/${entry.maxAttempts} ${entry.lastError}`);
  return 'retrying';
}

/**
 * Process due ACME jobs. deps injects resolve4/probeHttp/certbot/issue/fallback
 * for deterministic tests; production uses the real network and certbot.
 */
export async function processAcmeQueue(options = {}) {
  const now = Number(options.now) || Date.now();
  const limit = options.limit || 5;
  const actor = options.actor || 'scheduler';
  const deps = { ...options, ...(options.deps || {}) };
  const queue = loadQueue();
  const due = queue
    .filter((entry) => ['queued', 'waiting_dns', 'retrying'].includes(entry.status))
    .filter((entry) => !entry.nextAttemptAt || Date.parse(entry.nextAttemptAt) <= now)
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 5)));
  const result = { processed: [], issued: [], waiting: [], failed: [], alerts: [] };
  for (const entry of due) {
    entry.attempts = (Number(entry.attempts) || 0) + 1;
    entry.status = 'issuing';
    entry.updatedAt = iso(now);
    let preflight;
    try {
      preflight = entry.mode === 'selfsigned'
        ? { ok: true, checks: [], recommended: 'selfsigned', fallback: null, checkedAt: iso(now) }
        : await preflightAcme(entry.domain, {
          challenge: entry.challenge, mode: entry.mode, email: entry.email, deps: { ...deps, now },
        });
    } catch (error) {
      preflight = { ok: false, retryable: true, checks: [], errors: [{ code: 'preflight_failed', message: error.message }], recommended: 'retry', fallback: null };
    }
    entry.lastPreflight = {
      ok: !!preflight.ok,
      recommended: preflight.recommended,
      checks: (preflight.checks || []).map((check) => ({ key: check.key, ok: check.ok, skipped: !!check.skipped, detail: String(check.detail || '').slice(0, 300) })),
      checkedAt: preflight.checkedAt || iso(now),
    };
    if (entry.mode === 'selfsigned' || preflight.recommended === 'selfsigned') {
      let fallback;
      try { fallback = fallbackCertificate(entry, deps); }
      catch (error) { fallback = { ok: false, error: error.message }; }
      if (fallback?.ok) {
        entry.status = 'issued';
        entry.fallback = 'selfsigned';
        entry.updatedAt = iso(now);
        entry.nextAttemptAt = null;
        entry.lastError = '';
        entry.history = [...(entry.history || []).slice(-19), { at: entry.updatedAt, attempt: entry.attempts, action: 'issued', detail: 'selfsigned fallback' }];
        logSsl(entry.domain, 'acme.fallback', 'ok', `self-signed fallback (${fallback.expiresAt || 'unknown expiry'})`);
        result.issued.push(publicEntry(entry));
        result.processed.push(publicEntry(entry));
        continue;
      }
      const state = failEntry(entry, fallback?.error || 'self-signed fallback failed', { now, retryable: false, alerts: result.alerts });
      (state === 'failed' ? result.failed : result.waiting).push(publicEntry(entry));
      result.processed.push(publicEntry(entry));
      continue;
    }
    if (!preflight.ok) {
      const state = failEntry(entry, preflight.errors?.[0]?.message || preflight.warnings?.[0] || 'Preflight ACME nie powiódł się', {
        now, retryable: !!preflight.retryable, alerts: result.alerts,
      });
      if (state === 'failed') result.failed.push(publicEntry(entry));
      else {
        entry.status = entry.lastPreflight.checks.some((check) => check.key === 'dns' && !check.ok) ? 'waiting_dns' : 'retrying';
        result.waiting.push(publicEntry(entry));
      }
      result.processed.push(publicEntry(entry));
      continue;
    }
    let issued;
    try { issued = issueForEntry(entry, preflight, deps); }
    catch (error) { issued = { ok: false, error: error.message }; }
    if (issued?.ok) {
      entry.status = 'issued';
      entry.fallback = '';
      entry.lastError = '';
      entry.updatedAt = iso(now);
      entry.nextAttemptAt = null;
      entry.history = [...(entry.history || []).slice(-19), { at: entry.updatedAt, attempt: entry.attempts, action: 'issued', detail: 'ACME ok' }];
      logSsl(entry.domain, 'acme.issued', 'ok', `attempt=${entry.attempts} ${issued.expiresAt || ''}`.trim());
      result.issued.push(publicEntry(entry));
      result.processed.push(publicEntry(entry));
      continue;
    }
    const state = failEntry(entry, issued?.error || 'Wystawienie certyfikatu nie powiodło się', { now, retryable: true, alerts: result.alerts });
    (state === 'failed' ? result.failed : result.waiting).push(publicEntry(entry));
    result.processed.push(publicEntry(entry));
  }
  saveQueue(queue);
  return result;
}

/* -------------------------------------------------------------- schedule */

export function renewalSchedule({ now = Date.now() } = {}) {
  const autoRenew = setting('ssl_autorenew', '1') === '1';
  const rows = all("SELECT * FROM ssl_certs WHERE status = 'active' ORDER BY expires_at");
  return rows.map((cert) => {
    const expires = cert.expires_at ? new Date(cert.expires_at).getTime() : null;
    const daysLeft = Number.isFinite(expires) ? Math.ceil((expires - now) / 864e5) : null;
    const renewAt = Number.isFinite(expires) ? new Date(expires - 30 * 864e5).toISOString() : null;
    return {
      domain: cert.domain,
      type: cert.type,
      expiresAt: cert.expires_at,
      daysLeft,
      renewAt,
      due: Number.isFinite(expires) ? expires - now < 30 * 864e5 : false,
      expired: Number.isFinite(expires) ? expires < now : false,
      autoRenew,
      fallback: cert.type !== 'letsencrypt',
      link: acmeDashboardLink(cert.domain, { level: 'admin' }),
    };
  });
}

export function acmeDashboardLink(domain, { level = 'user' } = {}) {
  const name = String(domain || '').trim().toLowerCase();
  if (!isDomain(name)) return '/user/ssl';
  if (level === 'admin') return `/admin/ssl-center?domain=${encodeURIComponent(name)}`;
  return `/user/ssl?domain=${encodeURIComponent(name)}`;
}

function dueRenewalCerts(now = Date.now()) {
  return all("SELECT * FROM ssl_certs WHERE status = 'active' AND expires_at IS NOT NULL")
    .filter((cert) => new Date(cert.expires_at).getTime() - now < 30 * 864e5);
}

/**
 * Renewal entry point used by the durable scheduler. Jobs are queued and
 * processed with backoff; pending retries are reported as pending (not as a
 * success or a failure), so no premature alert leaves the panel.
 */
export async function renewExpiring(actor = 'scheduler', { now = Date.now(), deps = {} } = {}) {
  const due = dueRenewalCerts(now);
  if (!due.length) return [];
  const out = [];
  for (const cert of due) {
    const mode = cert.type === 'letsencrypt' ? 'letsencrypt' : 'selfsigned';
    let entry = activeForDomain(cert.domain, mode);
    if (!entry) {
      const queued = enqueueAcme(cert.domain, {
        username: cert.username || '',
        email: setting('admin_email', ''),
        mode,
        source: 'renewal',
        reason: `expires ${cert.expires_at}`,
        actorLevel: 'admin',
        now,
      });
      entry = queued.entry || null;
    }
    out.push({ domain: cert.domain, mode, entryId: entry?.id || null });
  }
  const processed = await processAcmeQueue({ now, limit: Math.max(1, out.length), actor, deps });
  const byDomain = new Map();
  for (const entry of [...processed.issued, ...processed.waiting, ...processed.failed]) byDomain.set(entry.domain, entry);
  return out.map((row) => {
    const entry = byDomain.get(row.domain) || acmeEntry(row.entryId);
    if (!entry) return { domain: row.domain, ok: false, error: 'Brak zadania ACME' };
    if (entry.status === 'failed') return { domain: row.domain, ok: false, error: entry.lastError || 'ACME failed', status: entry.status };
    if (entry.status === 'issued') return { domain: row.domain, ok: true, status: entry.status, fallback: entry.fallback || '', expiresAt: entry.updatedAt };
    return {
      domain: row.domain, ok: true, pending: true, status: entry.status,
      nextAttemptAt: entry.nextAttemptAt, error: entry.lastError || '',
    };
  });
}

/* --------------------------------------------------------------- status */

export function autoSslStatus() {
  const certs = all("SELECT id, domain, type, expires_at, status, key_type FROM ssl_certs WHERE status = 'active' ORDER BY expires_at");
  const queue = acmeQueue({ limit: 100 });
  return {
    certs,
    expiring: certs.filter((cert) => cert.expires_at && new Date(cert.expires_at).getTime() - Date.now() < 30 * 864e5),
    certbot: certbotAvailable(),
    keyType: sslKeyType(),
    logs: logs(20),
    queue,
    queueSummary: acmeSummary(),
    schedule: renewalSchedule(),
    alerts: queue.filter((entry) => entry.status === 'failed' && entry.alertSent),
  };
}

/* ------------------------------------------------------------ legacy API */

export function issueCertificate(domain, { email = '', actor = 'admin' } = {}) {
  const d = get('SELECT * FROM domains WHERE name = ?', domain);
  if (!d) return { ok: false, error: 'Domena nie istnieje' };
  const certbot = certbotAvailable();
  let result;
  if (certbot) result = issueLetsEncrypt(domain, d.docroot, email || setting('admin_email', `admin@${domain}`));
  else result = generateSelfSigned(domain, 365);
  logSsl(domain, certbot ? 'letsencrypt' : 'selfsigned', result.ok ? 'ok' : 'error', result.error || result.expiresAt || '');
  audit(actor, 'admin', 'ssl.issue', domain, '');
  return { ...result, fallback: !certbot };
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

void certPaths;
