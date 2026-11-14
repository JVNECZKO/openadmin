// Plain-language readiness checks for the admin dashboard / health page.
//
// A check result has two separate dimensions:
//   executionStatus — did the probe run (ok / skipped / unavailable / failed)
//   observedStatus  — what did it observe (ok / warn / critical / unknown)
// A successfully executed probe can still observe a critical subsystem state.
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { spawnSync } from 'node:child_process';
import { all, get, setting } from './db.mjs';
import { config } from './config.mjs';
import { systemProvider } from './providers/index.mjs';
import { activeServer } from './webserver.mjs';
import { poolStatus } from './phpfpm.mjs';
import { mailStatus, mailAccounts } from './mail.mjs';
import { applyStatus } from './apply.mjs';
import { queueList } from './mailops.mjs';
import { status as appStatus, phpMyAdminSsoEnabled } from './apps.mjs';
import {
  MetricsService,
  formatBytesIEC,
  serviceStateRows,
  summarizeServiceStates,
  classifyServiceState,
  deriveJobObservation,
  worstObservation,
  SERVICE_STATE,
  OBSERVED_STATUS,
} from './metrics.mjs';

const SANDBOX_REASON = 'Sandbox nie odczytuje systemd/procesów hosta; wynik jest oznaczony jako pominięty.';

export function tcpProbe(port, host = '127.0.0.1', timeout = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (open) => { try { socket.destroy(); } catch { /* ignore */ } resolve(open); };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function dig(name, type, server = null) {
  const args = ['+short', '+time=2', '+tries=1', type, name];
  if (server) args.push(`@${server}`);
  const result = spawnSync('dig', args, { encoding: 'utf8', timeout: 5000 });
  return result.status === 0 ? result.stdout.trim().split('\n').filter(Boolean) : null;
}

function digPublic(domain, type) {
  return dig(domain, type, '1.1.1.1');
}

/**
 * Minimal HTTP probe. Returns the status code instead of treating every
 * response as a healthy service; callers classify 4xx/5xx explicitly.
 */
export function httpProbe(url, { headers = {}, timeout = 1500, bodyLimit = 4096 } = {}) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      resolve({ ok: false, status: null, error: 'Nieprawidłowy adres URL', body: '' });
      return;
    }
    const lib = target.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = lib.request(target, {
      method: 'GET',
      timeout,
      rejectUnauthorized: false,
      headers: { 'User-Agent': 'OpenAdmin-Health/1.0', ...headers },
    }, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        if (body.length < bodyLimit) body += chunk.toString('utf8');
      });
      response.on('end', () => finish({
        ok: true,
        status: response.statusCode,
        headers: response.headers,
        body: body.slice(0, bodyLimit),
        error: '',
      }));
      response.on('error', (error) => finish({ ok: false, status: null, error: error.message, body: '' }));
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => finish({
      ok: false,
      status: null,
      error: error.code || error.message || 'request failed',
      body: '',
    }));
    request.end();
  });
}

export function tlsProbe(host, port = 443, { servername = null, timeout = 2000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const socket = tls.connect({
      host,
      port,
      servername: servername || undefined,
      rejectUnauthorized: false,
      timeout,
    }, () => {
      const cert = socket.getPeerCertificate?.() || null;
      const result = {
        ok: true,
        protocol: socket.getProtocol?.() || null,
        authorized: socket.authorized !== false,
        validTo: cert?.valid_to || null,
        subject: cert?.subject?.CN || null,
        issuer: cert?.issuer?.CN || null,
        error: socket.authorized === false ? 'certyfikat niezweryfikowany' : '',
      };
      socket.end();
      finish(result);
    });
    socket.on('timeout', () => { socket.destroy(); finish({ ok: false, error: 'timeout' }); });
    socket.on('error', (error) => finish({ ok: false, error: error.code || error.message || 'TLS error' }));
  });
}

export function phpProbe() {
  const result = spawnSync('php', ['-r', 'echo PHP_VERSION;'], { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) {
    return { ok: false, version: null, error: (result.stderr || result.error?.message || 'PHP CLI niedostępny').trim() };
  }
  return { ok: true, version: (result.stdout || '').trim(), error: '' };
}

function item(id, label, status, detail, fix = null, extra = {}) {
  return {
    id,
    label,
    status,
    detail,
    fix,
    critical: !!extra.critical,
    executionStatus: extra.executionStatus || 'ok',
    availability: extra.availability || (extra.executionStatus === 'skipped' ? 'unavailable' : 'observed'),
    observedStatus: extra.observedStatus || (status === 'fail' ? OBSERVED_STATUS.CRITICAL : status),
    reason: extra.reason || null,
    metric: extra.metric || null,
    app: extra.app || null,
  };
}

/**
 * Split process health from application health for phpMyAdmin / Roundcube.
 * `running` is only true after the application's base path answered with
 * 2xx/3xx; serial 4xx/5xx responses are degraded/failed, never "running".
 */
export async function applicationHealth(id, {
  statusFn = appStatus,
  http = httpProbe,
  ssoEnabled = phpMyAdminSsoEnabled,
} = {}) {
  const result = {
    id,
    name: id === 'phpmyadmin' ? 'phpMyAdmin' : id === 'roundcube' ? 'Roundcube' : String(id),
    installed: false,
    process: { pid: 0, alive: false },
    port: { port: null, open: null },
    basePath: null,
    http: null,
    login: { kind: id === 'phpmyadmin' ? 'sso' : 'password', sso: false, path: '/', ready: false },
    resources: { php: false, missingExtensions: [] },
    state: 'unknown',
    observedStatus: OBSERVED_STATUS.UNKNOWN,
    running: false,
    reasons: [],
    lastError: '',
  };

  let app;
  try {
    app = statusFn(id);
  } catch (error) {
    result.reasons.push(`Nie można odczytać statusu: ${error.message}`);
    result.lastError = error.message;
    return result;
  }
  if (!app) {
    result.reasons.push('Nieznana aplikacja');
    return result;
  }

  let sso = false;
  try { sso = !!ssoEnabled(); } catch { sso = false; }
  result.name = app.name || result.name;
  result.installed = !!app.installed;
  result.version = app.version || '';
  result.process = { pid: Number(app.pid) || 0, alive: !!app.pid };
  result.port = { port: Number(app.port) || null, open: app.pid ? !!app.running : null, source: 'apps.status' };
  result.basePath = app.url || `/${id}/`;
  result.resources = { php: !!app.php, missingExtensions: Array.isArray(app.missingExtensions) ? app.missingExtensions : [] };
  result.login = {
    kind: id === 'phpmyadmin' ? 'sso' : 'password',
    sso: id === 'phpmyadmin' ? sso : false,
    path: id === 'phpmyadmin' && sso ? '/signon.php' : '/',
    ready: false,
  };

  if (!app.installed) {
    result.state = 'not-installed';
    result.observedStatus = OBSERVED_STATUS.WARN;
    result.reasons.push('Aplikacja nie jest zainstalowana');
    return result;
  }
  if (!app.pid) {
    result.state = 'stopped';
    result.observedStatus = OBSERVED_STATUS.WARN;
    result.reasons.push('Proces aplikacji nie działa');
    return result;
  }

  let response;
  try {
    response = await http(`http://127.0.0.1:${app.port}/`, {
      timeout: 2000,
      headers: { Host: `127.0.0.1:${app.port}` },
    });
  } catch (error) {
    response = { ok: false, status: null, error: error.message, body: '' };
  }
  result.http = {
    ok: !!response.ok,
    status: response.status ?? null,
    error: response.error || '',
    bodyExcerpt: String(response.body || '').slice(0, 500),
  };

  if (!response.ok) {
    result.state = 'failed';
    result.observedStatus = OBSERVED_STATUS.CRITICAL;
    result.lastError = response.error || 'Brak odpowiedzi HTTP';
    result.reasons.push(`Brak odpowiedzi HTTP: ${result.lastError}`);
  } else if (response.status >= 500) {
    result.state = 'failed';
    result.observedStatus = OBSERVED_STATUS.CRITICAL;
    result.lastError = `HTTP ${response.status}`;
    result.reasons.push(`Ścieżka bazowa zwraca HTTP ${response.status}`);
  } else if (response.status >= 400) {
    result.state = 'degraded';
    result.observedStatus = OBSERVED_STATUS.WARN;
    result.lastError = `HTTP ${response.status}`;
    result.reasons.push(`Ścieżka bazowa zwraca HTTP ${response.status}`);
  } else {
    const body = String(response.body || '');
    const authError = /single sign-on failed|signon failed|fatal error|parse error|database error/i.exec(body);
    if (authError) {
      result.state = 'degraded';
      result.observedStatus = OBSERVED_STATUS.WARN;
      result.lastError = authError[0];
      result.reasons.push(`Aplikacja zgłasza błąd: ${authError[0]}`);
    } else {
      result.state = 'running';
      result.observedStatus = OBSERVED_STATUS.OK;
    }
  }

  if (result.resources.missingExtensions.length) {
    result.reasons.push(`Brak rozszerzeń PHP: ${result.resources.missingExtensions.join(', ')}`);
    if (result.state === 'running') {
      result.state = 'degraded';
      result.observedStatus = OBSERVED_STATUS.WARN;
    }
  }
  if (id === 'phpmyadmin' && !sso) {
    result.reasons.push('SSO nie jest skonfigurowane — wymagane logowanie do bazy');
    if (result.state === 'running') {
      result.state = 'degraded';
      result.observedStatus = OBSERVED_STATUS.WARN;
    }
  }
  result.running = result.state === 'running';
  result.login.ready = result.state === 'running';
  return result;
}

/**
 * Additive Action Center view of one `applicationHealth()` result.
 *
 * OA-019C requires process health and application health to be separate.
 * `applicationHealth()` stays the single source of that split; this projection
 * only packages its observed state for the Action Center without changing any
 * calculation, threshold or returned health field. A healthy running app
 * returns null, so the caller never renders a synthetic "all good" row.
 */
export function applicationObservation(app) {
  if (!app || !app.installed) return null;
  const state = String(app.state || 'unknown');
  if (state === 'running' && app.observedStatus === OBSERVED_STATUS.OK) return null;

  const httpStatus = Number(app.http?.status);
  const severity = state === 'failed'
    ? 'P1'
    : state === 'degraded'
      ? (Number.isFinite(httpStatus) && httpStatus >= 500 ? 'P1' : 'P2')
      : state === 'stopped'
        ? 'P1'
        : 'P2';
  const stateLabel = state === 'failed'
    ? 'aplikacja nie odpowiada'
    : state === 'degraded'
      ? 'aplikacja działa z błędami'
      : state === 'stopped'
        ? 'proces aplikacji nie działa'
        : `stan aplikacji: ${state}`;
  const reason = app.lastError || app.reasons?.[0] || stateLabel;
  const name = app.name || app.id || 'Aplikacja';
  return {
    appId: app.id || '',
    name,
    state,
    severity,
    title: `${name}: ${stateLabel}`,
    impact: state === 'stopped' || state === 'failed'
      ? `Użytkownicy nie mogą otworzyć ${name}; baza lub webmail mogą być niedostępne z panelu.`
      : `Część funkcji ${name} może nie działać, mimo że proces jest uruchomiony.`,
    recommendation: state === 'stopped' || state === 'failed'
      ? `Sprawdź proces, port i ścieżkę bazową ${name} w Health Center, a następnie uruchom aplikację ponownie.`
      : `Sprawdź log aplikacji ${name}, wymagane rozszerzenia PHP i konfigurację logowania/SSO.`,
    reason: String(reason).slice(0, 500),
    httpStatus: Number.isFinite(httpStatus) ? httpStatus : null,
    processAlive: !!app.process?.alive,
    port: Number(app.port?.port) || null,
    loginReady: !!app.login?.ready,
    observedAt: new Date().toISOString(),
  };
}

/**
 * Aggregate checks without letting a successful execution hide a failed
 * observation. Any `fail` (not only `critical: true`) makes the summary fail.
 */
export function summarizeHealth(checks = []) {
  const list = Array.isArray(checks) ? checks : [];
  const counts = { ok: 0, warn: 0, fail: 0 };
  let skipped = 0;
  let unavailable = 0;
  for (const check of list) {
    if (Object.hasOwn(counts, check.status)) counts[check.status] += 1;
    if (check.executionStatus === 'skipped') skipped += 1;
    if (check.executionStatus === 'unavailable') unavailable += 1;
  }
  const failed = list.filter((check) => check.status === 'fail');
  const criticalFailures = failed.filter((check) => check.critical).length;
  const summary = failed.length ? 'fail' : list.some((check) => check.status === 'warn') ? 'warn' : 'ok';
  return {
    counts,
    skipped,
    unavailable,
    criticalFailures,
    summary,
    observedStatus: summary === 'fail' ? OBSERVED_STATUS.CRITICAL : summary,
    executionStatus: list.some((check) => check.executionStatus === 'failed')
      ? 'failed'
      : skipped || unavailable ? 'partial' : 'completed',
  };
}

function serviceRowsFor(provider, statusFor, activeEngine) {
  return serviceStateRows({
    rows: all('SELECT * FROM services ORDER BY name'),
    provider: { serviceStatus: (name) => statusFor(name) },
    activeEngine,
  });
}

function appCheckStatus(app) {
  if (!app.installed) return 'warn';
  if (app.state === 'failed') return 'fail';
  if (app.state === 'running') return 'ok';
  return 'warn';
}

export async function healthReport({ probe = {} } = {}) {
  const provider = probe.provider || systemProvider();
  const statusFor = probe.serviceStatus || ((name) => {
    try { return provider.serviceStatus(name); } catch (error) { return { ok: false, status: null, error: error.message }; }
  });
  const http = probe.http || httpProbe;
  const tcp = probe.tcp || tcpProbe;
  const digFn = probe.dig || dig;
  const digPublicFn = probe.digPublic || digPublic;
  const php = probe.php || phpProbe;
  const queue = probe.queue || queueList;
  const mail = probe.mailStatus || mailStatus;
  const accounts = probe.mailAccounts || mailAccounts;
  const appStatusFn = probe.appStatus || appStatus;
  const ssoEnabled = probe.ssoEnabled || phpMyAdminSsoEnabled;
  const poolStatusFn = probe.poolStatus || poolStatus;
  const tlsCheck = probe.tls || tlsProbe;
  const metrics = probe.metrics || new MetricsService();
  const sandbox = provider.id === 'sandbox';

  const server = activeServer();
  const activeEngine = setting('web_server', server.id);
  const serviceRows = serviceRowsFor(provider, statusFor, activeEngine);
  const serviceSummary = summarizeServiceStates(serviceRows);
  const checks = [];

  checks.push(item(
    'setup',
    'Konfiguracja początkowa',
    setting('setup_complete', '0') === '1' ? 'ok' : 'warn',
    setting('setup_complete', '0') === '1' ? 'Kreator zakończony' : 'Uruchom kreator pierwszej konfiguracji',
    { label: 'Otwórz kreator', action: 'setup', href: '/admin/setup' },
  ));
  checks.push(item(
    'https',
    'Panel po HTTPS',
    config.https ? 'ok' : 'warn',
    config.https ? 'Certyfikat panelu aktywny' : 'Panel działa po HTTP; przeglądarka ostrzega o niezabezpieczonym połączeniu',
    { label: 'Włącz HTTPS', action: 'https' },
  ));

  /* ------------------------------------------------------------- web server */
  const webService = server.service;
  const webState = serviceRows.find((row) => row.name === webService)
    || classifyServiceState({ name: webService, liveStatus: statusFor(webService)?.status || null, activeWebEngine: activeEngine });
  if (sandbox) {
    checks.push(item(
      'web',
      `Serwer WWW (${server.label})`,
      'warn',
      `${SANDBOX_REASON} Stan z panelu: ${webState.detail}`,
      { label: 'Wdróż ponownie', action: 'web' },
      { critical: true, executionStatus: 'skipped', availability: 'unavailable', reason: SANDBOX_REASON },
    ));
  } else {
    const ok = webState.state === SERVICE_STATE.RUNNING;
    checks.push(item(
      'web',
      `Serwer WWW (${server.label})`,
      ok ? 'ok' : 'fail',
      ok ? 'Usługa działa' : `Usługa nie działa — strony nie będą dostępne (${webState.detail})`,
      { label: 'Wdróż ponownie', action: 'web' },
      { critical: true },
    ));
  }

  /* ------------------------------------------------------------------- PHP */
  const phpRuntime = php();
  const phpRow = serviceRows.find((row) => row.name === 'php-fpm')
    || classifyServiceState({ name: 'php-fpm', liveStatus: statusFor('php-fpm')?.status || null, activeWebEngine: activeEngine });
  const users = all("SELECT username FROM users WHERE level IN ('user','reseller')");
  const pools = users.map((user) => poolStatusFn(user.username));
  const poolsOk = pools.length === 0 || pools.some((pool) => pool.exists);
  if (sandbox) {
    checks.push(item(
      'php',
      'PHP-FPM',
      'warn',
      `${phpRuntime.ok ? `PHP CLI ${phpRuntime.version}` : `PHP CLI: ${phpRuntime.error}`} · PHP-FPM: ${phpRow.detail} · pule: ${pools.filter((pool) => pool.exists).length}`,
      { label: 'Wdróż PHP', action: 'web' },
      { critical: true, executionStatus: 'skipped', availability: 'unavailable', reason: SANDBOX_REASON },
    ));
  } else {
    const ok = phpRuntime.ok && phpRow.state === SERVICE_STATE.RUNNING && poolsOk;
    checks.push(item(
      'php',
      'PHP-FPM',
      ok ? 'ok' : 'fail',
      ok
        ? `Działa · ${phpRuntime.version || 'PHP'} · ${pools.filter((pool) => pool.exists).length} pul`
        : `PHP nie działa lub brak pul dla kont (${phpRuntime.error || phpRow.detail})`,
      { label: 'Wdróż PHP', action: 'web' },
      { critical: true },
    ));
  }

  /* -------------------------------------------------------------- databases */
  let panelDb = { ok: false, detail: '' };
  try {
    const row = get('SELECT 1 AS ok');
    panelDb = { ok: Number(row?.ok) === 1, detail: `SELECT 1 → ${row?.ok ?? 'brak odpowiedzi'}` };
  } catch (error) {
    panelDb = { ok: false, detail: `Zapytanie nie powiodło się: ${error.message}` };
  }
  checks.push(item(
    'db-panel',
    'Baza panelu (SQLite)',
    panelDb.ok ? 'ok' : 'fail',
    panelDb.detail,
    null,
    { critical: true, executionStatus: panelDb.ok ? 'ok' : 'failed' },
  ));

  const dbRow = serviceRows.find((row) => row.name === 'mysqld')
    || classifyServiceState({ name: 'mysqld', liveStatus: statusFor('mysqld')?.status || null, activeWebEngine: activeEngine });
  if (sandbox) {
    checks.push(item(
      'db',
      'Baza danych (MariaDB)',
      'warn',
      `${SANDBOX_REASON} Stan z panelu: ${dbRow.detail}`,
      null,
      { critical: true, executionStatus: 'skipped', availability: 'unavailable', reason: SANDBOX_REASON },
    ));
  } else {
    const ok = dbRow.state === SERVICE_STATE.RUNNING;
    checks.push(item(
      'db',
      'Baza danych (MariaDB)',
      ok ? 'ok' : 'fail',
      ok ? 'Usługa działa' : `Baza nie działa — panel i strony mogą nie działać (${dbRow.detail})`,
      null,
      { critical: true },
    ));
  }

  /* ----------------------------------------------------------------- queue */
  let queueReport = { total: 0, failed: 0, deferred: 0, queued: 0, simulated: false, source: 'panel' };
  let queueStatus = 'warn';
  let queueDetail = 'Nie sprawdzono kolejki poczty';
  let queueExecution = 'skipped';
  let queueReason = null;
  try {
    const result = queue();
    if (!result || result.ok === false) throw new Error(result?.error || 'Kolejka poczty jest niedostępna');
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const byStatus = rows.reduce((acc, row) => {
      const key = row.status || 'queued';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    queueReport = {
      total: rows.length,
      failed: byStatus.failed || 0,
      deferred: byStatus.deferred || 0,
      queued: byStatus.queued || 0,
      simulated: !!result.simulated || rows.some((row) => row.db),
      source: result.simulated || rows.some((row) => row.db) ? 'panel queue' : 'Exim queue',
    };
    queueExecution = 'ok';
    if (queueReport.failed > 0) {
      queueStatus = 'fail';
      queueDetail = `${queueReport.source}: ${queueReport.failed} nieudanych z ${queueReport.total} wiadomości (deferred ${queueReport.deferred})`;
      queueReason = `${queueReport.failed} nieudanych wiadomości w kolejce`;
    } else if (queueReport.deferred > 0) {
      queueStatus = 'warn';
      queueDetail = `${queueReport.source}: ${queueReport.deferred} wstrzymanych z ${queueReport.total} wiadomości`;
    } else if (queueReport.simulated) {
      queueStatus = 'warn';
      queueDetail = `${queueReport.source}: ${queueReport.total} wiadomości; stan symulowany (sandbox)`;
      queueReason = SANDBOX_REASON;
    } else {
      queueStatus = 'ok';
      queueDetail = `${queueReport.source}: kolejka pusta lub bez błędów (${queueReport.total} wiadomości)`;
    }
  } catch (error) {
    queueStatus = 'fail';
    queueExecution = 'failed';
    queueDetail = `Nie można odczytać kolejki poczty: ${error.message}`;
    queueReason = error.message;
  }
  checks.push(item(
    'queue',
    'Kolejka poczty',
    queueStatus,
    queueDetail,
    null,
    {
      critical: true,
      executionStatus: queueExecution,
      reason: queueReason,
      availability: queueExecution === 'skipped' ? 'unavailable' : 'observed',
    },
  ));

  /* -------------------------------------------------------------- mailboxes */
  let mailReport = null;
  let mailboxReport = { count: null, listCount: null, consistent: false, source: 'email_accounts' };
  try {
    mailReport = mail({});
    const list = accounts();
    const listCount = Array.isArray(list) ? list.length : 0;
    const count = Number(mailReport?.accounts);
    const consistent = Number.isFinite(count) && count === listCount;
    mailboxReport = { count: Number.isFinite(count) ? count : null, listCount, consistent, source: 'email_accounts' };
    checks.push(item(
      'mailboxes',
      'Liczba skrzynek',
      consistent ? 'ok' : 'fail',
      consistent
        ? `${count} skrzynek · licznik zgodny z listą email_accounts`
        : `Licznik ${Number.isFinite(count) ? count : 'brak'} ≠ lista ${listCount} — dane niespójne`,
      null,
      { critical: true, executionStatus: 'ok', reason: consistent ? null : 'Licznik skrzynek nie zgadza się z listą' },
    ));
  } catch (error) {
    checks.push(item(
      'mailboxes',
      'Liczba skrzynek',
      'fail',
      `Nie można odczytać liczby skrzynek: ${error.message}`,
      null,
      { critical: true, executionStatus: 'failed', reason: error.message },
    ));
  }

  /* ----------------------------------------------------------- mail services */
  const eximRow = serviceRows.find((row) => row.name === 'exim')
    || classifyServiceState({ name: 'exim', liveStatus: statusFor('exim')?.status || null, activeWebEngine: activeEngine });
  const dovecotRow = serviceRows.find((row) => row.name === 'dovecot')
    || classifyServiceState({ name: 'dovecot', liveStatus: statusFor('dovecot')?.status || null, activeWebEngine: activeEngine });
  const mailCount = mailboxReport.count;
  const eximLabel = eximRow.state === SERVICE_STATE.RUNNING ? 'działa' : eximRow.detail;
  const dovecotLabel = dovecotRow.state === SERVICE_STATE.RUNNING ? 'działa' : dovecotRow.detail;
  if (sandbox) {
    checks.push(item(
      'mail',
      'Poczta (Exim + Dovecot)',
      'warn',
      `${SANDBOX_REASON} Exim: ${eximLabel} · Dovecot: ${dovecotLabel} · skrzynek: ${mailCount ?? 'niedostępne'}`,
      { label: 'Wdróż pocztę', action: 'mail' },
      { critical: true, executionStatus: 'skipped', availability: 'unavailable', reason: SANDBOX_REASON },
    ));
  } else {
    const ok = eximRow.state === SERVICE_STATE.RUNNING && dovecotRow.state === SERVICE_STATE.RUNNING;
    checks.push(item(
      'mail',
      'Poczta (Exim + Dovecot)',
      ok ? 'ok' : 'fail',
      `Exim: ${eximLabel} · Dovecot: ${dovecotLabel} · skrzynek: ${mailCount ?? 'niedostępne'}`,
      { label: 'Wdróż pocztę', action: 'mail' },
      { critical: true },
    ));
  }

  /* -------------------------------------------------------------- vhost HTTP */
  const domains = all('SELECT name, ssl FROM domains ORDER BY name');
  if (sandbox) {
    checks.push(item(
      'vhost-http',
      'HTTP vhostów',
      'warn',
      `${SANDBOX_REASON} Nie wysłano żądań HTTP do vhostów.`,
      null,
      { critical: true, executionStatus: 'skipped', availability: 'unavailable', reason: SANDBOX_REASON },
    ));
  } else if (!domains.length) {
    checks.push(item(
      'vhost-http',
      'HTTP vhostów',
      'warn',
      'Brak domen do sprawdzenia — dodaj domenę, aby testować vhost.',
      null,
      { critical: true, executionStatus: 'skipped', availability: 'unavailable', reason: 'Brak domen' },
    ));
  } else {
    const sample = domains.slice(0, 5);
    const failures = [];
    const warnings = [];
    let okCount = 0;
    for (const domain of sample) {
      let response = await http('http://127.0.0.1:80/', { headers: { Host: domain.name }, timeout: 1500 });
      if (!response.ok || response.status >= 500) {
        const secure = await http('https://127.0.0.1:443/', { headers: { Host: domain.name }, timeout: 1500 });
        if (secure.ok && secure.status < 500) response = secure;
      }
      if (!response.ok || response.status >= 500) {
        failures.push(`${domain.name}: ${response.error || `HTTP ${response.status}`}`);
      } else if (response.status >= 400) {
        warnings.push(`${domain.name}: HTTP ${response.status}`);
      } else {
        okCount += 1;
      }
    }
    const status = failures.length ? 'fail' : warnings.length ? 'warn' : 'ok';
    const detail = failures.length
      ? `${okCount}/${sample.length} vhostów odpowiada; błędy: ${failures.slice(0, 3).join('; ')}`
      : warnings.length
        ? `${okCount}/${sample.length} vhostów odpowiada; ostrzeżenia: ${warnings.slice(0, 3).join('; ')}`
        : `${okCount}/${sample.length} vhostów odpowiada poprawnie`;
    checks.push(item(
      'vhost-http',
      'HTTP vhostów',
      status,
      detail,
      null,
      { critical: true, reason: failures[0] || warnings[0] || null },
    ));
  }

  /* -------------------------------------------------------------- DNS + SSL */
  const dnsRow = serviceRows.find((row) => row.name === 'bind')
    || classifyServiceState({ name: 'bind', liveStatus: statusFor('bind')?.status || null, activeWebEngine: activeEngine });
  if (sandbox) {
    checks.push(item(
      'dns',
      'Serwer DNS (BIND)',
      'warn',
      `${SANDBOX_REASON} Stan z panelu: ${dnsRow.detail} · stref: ${domains.length}`,
      { label: 'Wdróż strefy', action: 'dns' },
      { critical: true, executionStatus: 'skipped', availability: 'unavailable', reason: SANDBOX_REASON },
    ));
  } else {
    const ok = dnsRow.state === SERVICE_STATE.RUNNING;
    checks.push(item(
      'dns',
      'Serwer DNS (BIND)',
      ok ? 'ok' : 'fail',
      ok ? `Działa · ${domains.length} stref` : `DNS nie działa — domeny nie będą rozwiązywane (${dnsRow.detail})`,
      { label: 'Wdróż strefy', action: 'dns' },
      { critical: true },
    ));
  }

  if (provider.id === 'linux' && !sandbox) {
    for (const domain of domains.slice(0, 5)) {
      const answers = digFn(domain.name, 'A');
      const expected = setting('server_ip', '127.0.0.1');
      const ok = Array.isArray(answers) && answers.includes(expected);
      if (answers === null) {
        checks.push(item(
          `dns-${domain.name}`,
          `DNS: ${domain.name}`,
          'warn',
          'Nie można uruchomić dig — nie zweryfikowano strefy',
          { label: 'Wdróż DNS', action: 'dns' },
          { executionStatus: 'unavailable', availability: 'unavailable', reason: 'dig niedostępny' },
        ));
      } else {
        checks.push(item(
          `dns-${domain.name}`,
          `DNS: ${domain.name}`,
          ok ? 'ok' : 'warn',
          ok ? `A → ${expected}` : `A wskazuje ${answers.length ? answers.join(', ') : 'brak'} zamiast ${expected}`,
          { label: 'Wdróż DNS', action: 'dns' },
        ));
      }
      const mailCountForDomain = Number(get('SELECT COUNT(*) AS n FROM email_accounts WHERE domain = ?', domain.name)?.n) || 0;
      if (mailCountForDomain > 0) {
        const txt = digFn(domain.name, 'TXT') || [];
        const spf = txt.some((value) => value.includes('v=spf1'));
        const dmarc = (digFn(`_dmarc.${domain.name}`, 'TXT') || []).some((value) => value.includes('v=DMARC1'));
        const dkim = (digFn(`default._domainkey.${domain.name}`, 'TXT') || []).length > 0;
        const missing = [!spf && 'SPF', !dmarc && 'DMARC', !dkim && 'DKIM'].filter(Boolean);
        checks.push(item(
          `mailauth-${domain.name}`,
          `Poczta: ${domain.name}`,
          missing.length ? 'warn' : 'ok',
          missing.length ? `Brakuje: ${missing.join(', ')}` : 'SPF, DKIM i DMARC opublikowane',
        ));
      }
    }

    const publicZone = domains.find((zone) => !/\.(local|localhost|test|example|invalid)$/i.test(zone.name));
    if (publicZone) {
      const publicAnswers = digPublicFn(publicZone.name, 'A');
      const expected = setting('server_ip', '127.0.0.1');
      checks.push(item(
        'public-dns',
        `Publiczny DNS: ${publicZone.name}`,
        publicAnswers && publicAnswers.includes(expected) ? 'ok' : 'warn',
        publicAnswers && publicAnswers.includes(expected)
          ? 'Domena widoczna w publicznym DNS'
          : 'Nie widzimy domeny w publicznym DNS — może trwać propagacja lub brak delegacji u registrar',
      ));
    }
  }

  const certs = all("SELECT domain, expires_at FROM ssl_certs WHERE status = 'active'");
  const expired = certs.filter((cert) => cert.expires_at && new Date(cert.expires_at).getTime() <= Date.now());
  const soon = certs.filter((cert) => cert.expires_at && new Date(cert.expires_at).getTime() - Date.now() < 30 * 864e5 && !expired.includes(cert));
  checks.push(item(
    'certs',
    'Certyfikaty SSL',
    expired.length ? 'fail' : soon.length ? 'warn' : certs.length ? 'ok' : 'warn',
    expired.length
      ? `${expired.length} certyfikat(ów) wygasło`
      : soon.length
        ? `${soon.length} certyfikat(ów) wygasa w ciągu 30 dni`
        : certs.length
          ? `${certs.length} aktywnych certyfikatów`
          : 'Brak aktywnego certyfikatu SSL',
    null,
    { critical: expired.length > 0, reason: expired.length ? 'Certyfikat wygasł' : null },
  ));

  if (sandbox) {
    checks.push(item(
      'ssl-handshake',
      'Połączenie TLS',
      'warn',
      `${SANDBOX_REASON} Nie wykonano handshake TLS.`,
      null,
      { executionStatus: 'skipped', availability: 'unavailable', reason: SANDBOX_REASON },
    ));
  } else {
    const host = '127.0.0.1';
    const port = config.https ? Number(config.port) : 443;
    const result = await tlsCheck(host, port, { servername: setting('server_name', 'localhost') });
    const authorized = result.ok && result.authorized !== false;
    const expiresSoon = result.validTo && new Date(result.validTo).getTime() - Date.now() < 30 * 864e5;
    checks.push(item(
      'ssl-handshake',
      'Połączenie TLS',
      !result.ok ? 'warn' : authorized && !expiresSoon ? 'ok' : 'warn',
      !result.ok
        ? `Brak odpowiedzi TLS: ${result.error}`
        : `TLS ${result.protocol || ''} · certyfikat ${authorized ? 'zweryfikowany' : 'niezweryfikowany'}${result.validTo ? ` · ważny do ${result.validTo}` : ''}`,
      null,
      { reason: !result.ok ? result.error : (!authorized ? 'certyfikat niezweryfikowany' : null) },
    ));
  }

  /* --------------------------------------------------------- applications */
  const applications = [];
  for (const id of ['phpmyadmin', 'roundcube']) {
    let app;
    try {
      app = await applicationHealth(id, { statusFn: appStatusFn, http, ssoEnabled });
    } catch (error) {
      app = {
        id,
        name: id,
        installed: false,
        state: 'unknown',
        observedStatus: OBSERVED_STATUS.UNKNOWN,
        running: false,
        reasons: [`Probe nie powiódł się: ${error.message}`],
        process: { pid: 0, alive: false },
        port: { port: null, open: null },
        http: null,
        login: { kind: 'unknown', sso: false, path: '/', ready: false },
        resources: { php: false, missingExtensions: [] },
      };
    }
    applications.push(app);
    const status = appCheckStatus(app);
    const detail = app.installed
      ? `${app.name}: proces ${app.process?.alive ? 'działa' : 'nie działa'}, HTTP ${app.http?.status ?? 'brak'}, login ${app.login?.kind || 'brak'}${app.reasons?.length ? ` · ${app.reasons.join('; ')}` : ''}`
      : `${app.name}: nie jest zainstalowany (${app.reasons?.join('; ') || 'brak instalacji'})`;
    checks.push(item(
      `app-${id}`,
      `Aplikacja: ${app.name}`,
      status,
      detail,
      null,
      {
        critical: app.installed,
        executionStatus: app.installed ? 'ok' : 'skipped',
        availability: app.installed ? 'observed' : 'unavailable',
        reason: app.reasons?.[0] || null,
        app,
      },
    ));
  }

  /* ----------------------------------------------------------- automation */
  let automationReport = null;
  try {
    const automation = await import('./automation.mjs');
    const status = automation.automationStatus();
    // Do not feed the previous health.check result back into this report:
    // that would make a single failed run self-sustaining. Other subsystem
    // observations (mail queue, disk, backups, …) are aggregated normally.
    const observations = status.jobs
      .filter((job) => job.key !== 'health.check')
      .map((job) => ({
        key: job.key,
        label: job.label,
        lastRunAt: job.last_run_at,
        ...deriveJobObservation({
          key: job.key,
          status: job.last_status,
          output: job.last_output,
        }),
      }));
    const critical = observations.filter((observation) => observation.observedStatus === OBSERVED_STATUS.CRITICAL);
    const warnings = observations.filter((observation) => observation.observedStatus === OBSERVED_STATUS.WARN);
    const ran = observations.filter((observation) => observation.lastRunAt);
    automationReport = {
      enabled: status.enabled,
      jobs: observations,
      totalJobs: observations.length,
      critical: critical.length,
      warnings: warnings.length,
      observedStatus: worstObservation(observations),
    };
    const checkStatus = critical.length ? 'fail' : warnings.length || !ran.length ? 'warn' : 'ok';
    const detail = critical.length
      ? `${critical.length} kontroli krytycznych: ${critical.map((observation) => observation.label).join(', ')}`
      : warnings.length
        ? `${warnings.length} kontroli z ostrzeżeniami: ${warnings.map((observation) => observation.label).join(', ')}`
        : ran.length
          ? `Wszystkie ${observations.length} kontroli bez błędów`
          : 'Brak historii uruchomień automatycznych kontroli';
    checks.push(item(
      'automation',
      'Automatyzacja i kontrole',
      checkStatus,
      detail,
      null,
      {
        critical: true,
        executionStatus: 'ok',
        reason: critical[0]?.reason || warnings[0]?.reason || null,
      },
    ));
  } catch (error) {
    checks.push(item(
      'automation',
      'Automatyzacja i kontrole',
      'warn',
      `Nie można odczytać automatyzacji: ${error.message}`,
      null,
      { critical: true, executionStatus: 'unavailable', availability: 'unavailable', reason: error.message },
    ));
  }

  /* ------------------------------------------------------------- ports */
  for (const [port, label] of [[80, 'HTTP'], [443, 'HTTPS'], [25, 'SMTP'], [993, 'IMAPS'], [2222, 'panel']]) {
    if (sandbox) {
      checks.push(item(
        `port-${port}`,
        `Port ${port} (${label})`,
        'warn',
        `${SANDBOX_REASON} Nie sprawdzono portu ${port}.`,
        null,
        { executionStatus: 'skipped', availability: 'unavailable', reason: SANDBOX_REASON },
      ));
      continue;
    }
    const open = await tcp(port);
    const isOptional = port === 443 || port === 993;
    checks.push(item(
      `port-${port}`,
      `Port ${port} (${label})`,
      open ? 'ok' : isOptional ? 'warn' : 'fail',
      open ? 'Nasłuchuje' : 'Zamknięty lub usługa nie działa',
      null,
      { critical: !isOptional },
    ));
  }

  const apply = applyStatus();
  checks.push(item(
    'apply',
    'Ostatnie wdrożenie zmian',
    apply.pending ? 'warn' : apply.lastAt ? (apply.ok ? 'ok' : 'fail') : 'warn',
    apply.pending ? 'Są zmiany oczekujące na wdrożenie' : apply.lastAt ? `${apply.ok ? 'OK' : 'Błędy'} · ${apply.lastAt}` : 'Jeszcze nie uruchamiano',
    { label: 'Wdróż wszystko', action: 'apply' },
  ));

  const lastBackup = get("SELECT * FROM backups WHERE filename LIKE 'admin_backup_%' ORDER BY created_at DESC LIMIT 1");
  const backupAge = lastBackup ? (Date.now() - new Date(lastBackup.created_at).getTime()) / 864e5 : 999;
  checks.push(item(
    'backup',
    'Kopie zapasowe',
    backupAge <= 7 ? 'ok' : 'warn',
    lastBackup ? `Ostatnia: ${lastBackup.created_at}` : 'Brak kopii serwera',
    { label: 'Zrób kopię', action: 'backup' },
  ));

  const memory = metrics.memory();
  const disk = metrics.disk(config.dataDir);
  checks.push(item(
    'disk',
    'Miejsce na dysku',
    !disk.available ? 'warn' : disk.percent > 90 ? 'fail' : disk.percent > 75 ? 'warn' : 'ok',
    !disk.available
      ? `Nie można odczytać: ${disk.reason}`
      : `Zajęte ${disk.percent}% (${formatBytesIEC(disk.usedBytes)} z ${formatBytesIEC(disk.totalBytes)}) · ${disk.source}`,
    null,
    {
      executionStatus: disk.available ? 'ok' : 'unavailable',
      availability: disk.available ? 'observed' : 'unavailable',
      reason: disk.available ? null : disk.reason,
      metric: disk,
      critical: disk.available && disk.percent > 90,
    },
  ));

  const summary = summarizeHealth(checks);
  return {
    checks,
    ...summary,
    mail: mailReport,
    mailboxes: mailboxReport,
    queue: queueReport,
    applications: Object.fromEntries(applications.map((app) => [app.id, app])),
    automation: automationReport,
    metrics: { memory, disk },
    services: { rows: serviceRows, ...serviceSummary },
    apply,
    generatedAt: new Date().toISOString(),
  };
}
