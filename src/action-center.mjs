// Action Center — one aggregated, evidence-based list of what needs attention.
//
// Every finding is derived from data the panel already stores or from a live
// provider observation. Nothing is synthesised: when a source cannot answer,
// the source is reported as `unavailable` (or `partial`) together with the
// exact reason instead of contributing a made-up zero.
//
// The module is deliberately UI-free so the same snapshot feeds the admin
// dashboard card, the `/admin/action-center` page, tests and future API/CLI
// consumers. Mutations are limited to mute records (an acknowledgement, never
// a delete) and every mute is audited.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, setting, nowIso, audit } from './db.mjs';
import { config } from './config.mjs';
import { systemProvider } from './providers/index.mjs';
import { MetricsService, serviceStateRows, deriveJobObservation } from './metrics.mjs';
import { mailQueueSnapshot } from './mailops.mjs';
import {
  listServers as listBackupServers,
  listRuns as listBackupRuns,
} from './backupcenter.mjs';

const DAY_MS = 86400000;

/** Filter keys used by the page; also the stable `type` value of a finding. */
export const ACTION_CENTER_TYPES = Object.freeze({
  service: 'Usługi',
  ssl: 'Certyfikaty SSL',
  backup: 'Kopie zapasowe',
  mail: 'Poczta',
  updates: 'Aktualizacje',
  resources: 'Dysk, RAM i inody',
  dns: 'DNS',
  accounts: 'Konta bez 2FA',
  automation: 'Automatyzacja',
  'app-health': 'Aplikacje (phpMyAdmin / Roundcube)',
  security: 'Logowania i blokady',
});

export const SEVERITY = Object.freeze(['P0', 'P1', 'P2']);

export const SEVERITY_LABEL = Object.freeze({
  P0: 'P0 — natychmiast',
  P1: 'P1 — wysoki',
  P2: 'P2 — średni',
});

/**
 * Thresholds are exported so tests and future settings screens can use the
 * same numbers. Percent values are 0..100.
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  diskWarnPercent: 85,
  diskCriticalPercent: 92,
  memoryWarnPercent: 85,
  memoryCriticalPercent: 95,
  inodeWarnPercent: 80,
  inodeCriticalPercent: 90,
  sslWarnDays: 14,
  sslNoticeDays: 30,
  backupMaxAgeDays: 7,
  bounceWarnPercent: 2,
  bounceCriticalPercent: 5,
  bounceMinMessages: 20,
  queueDeferredWarn: 10,
  failedLoginWindowHours: 24,
  failedLoginRepeatCount: 5,
  muteMaxDays: 365,
});

let muteSchemaReady = false;

function ensureMuteSchema() {
  if (muteSchemaReady) return;
  run(`CREATE TABLE IF NOT EXISTS action_center_mutes (
    dedupe_key TEXT PRIMARY KEY,
    muted_until TEXT NOT NULL,
    muted_by TEXT NOT NULL DEFAULT 'admin',
    reason TEXT,
    created_at TEXT NOT NULL
  )`);
  muteSchemaReady = true;
}

function normalizeNow(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Stable id derived from the dedupe key so ids never reorder between loads. */
export function findingId(dedupeKey) {
  return `ac_${sha(dedupeKey).slice(0, 20)}`;
}

export function isSafeAdminHref(href) {
  const value = String(href || '');
  return value.startsWith('/admin') && !value.startsWith('//') && !value.includes('\n') && !value.includes('\r');
}

function makeFinding({
  dedupeKey,
  type,
  severity,
  title,
  impact,
  recommendation,
  action = null,
  detailsHref = '',
  source,
  sourceDetail = '',
  observedAt,
  evidence = null,
}) {
  const safeSeverity = SEVERITY.includes(severity) ? severity : 'P2';
  const safeAction = action && isSafeAdminHref(action.href)
    ? { label: String(action.label || 'Otwórz szczegóły'), href: action.href }
    : null;
  return {
    id: findingId(dedupeKey),
    dedupeKey,
    type: Object.hasOwn(ACTION_CENTER_TYPES, type) ? type : 'service',
    severity: safeSeverity,
    priority: safeSeverity,
    title,
    impact: String(impact || ''),
    recommendation: String(recommendation || ''),
    action: safeAction,
    detailsHref: detailsHref || `/admin/action-center?type=${encodeURIComponent(type)}`,
    muted: false,
    muteUntil: null,
    mutedBy: null,
    muteReason: null,
    observedAt,
    source,
    sourceDetail,
    evidence,
  };
}

export function activeMutes({ now = new Date() } = {}) {
  ensureMuteSchema();
  const at = normalizeNow(now);
  const rows = all('SELECT * FROM action_center_mutes ORDER BY muted_until');
  return rows.filter((row) => {
    const until = new Date(row.muted_until).getTime();
    return Number.isFinite(until) && until > at.getTime();
  });
}

export function muteFinding({
  dedupeKey,
  until,
  actor = 'admin',
  reason = '',
  now = new Date(),
} = {}) {
  ensureMuteSchema();
  const key = String(dedupeKey || '').trim();
  if (!/^[A-Za-z0-9:._@-]{3,220}$/.test(key)) {
    return { ok: false, code: 'invalid_key', error: 'Nieprawidłowy identyfikator pozycji.' };
  }
  const at = normalizeNow(now);
  const untilDate = new Date(until);
  if (Number.isNaN(untilDate.getTime())) {
    return { ok: false, code: 'invalid_until', error: 'Podaj prawidłową datę wyciszenia.' };
  }
  if (untilDate.getTime() <= at.getTime()) {
    return { ok: false, code: 'until_in_past', error: 'Data wyciszenia musi być w przyszłości.' };
  }
  if (untilDate.getTime() > at.getTime() + DEFAULT_THRESHOLDS.muteMaxDays * DAY_MS) {
    return { ok: false, code: 'until_too_far', error: `Maksymalny czas wyciszenia to ${DEFAULT_THRESHOLDS.muteMaxDays} dni.` };
  }
  const cleanReason = String(reason || '').trim().slice(0, 200);
  run(`INSERT INTO action_center_mutes(dedupe_key, muted_until, muted_by, reason, created_at)
       VALUES(?,?,?,?,?)
       ON CONFLICT(dedupe_key) DO UPDATE SET
         muted_until = excluded.muted_until,
         muted_by = excluded.muted_by,
         reason = excluded.reason,
         created_at = excluded.created_at`,
  key, untilDate.toISOString(), String(actor || 'admin').slice(0, 80), cleanReason, at.toISOString());
  audit(actor, 'admin', 'action_center.mute', `${key} until ${untilDate.toISOString()}`);
  return { ok: true, dedupeKey: key, mutedUntil: untilDate.toISOString() };
}

export function unmuteFinding({ dedupeKey, actor = 'admin' } = {}) {
  ensureMuteSchema();
  const key = String(dedupeKey || '').trim();
  if (!key) return { ok: false, code: 'invalid_key', error: 'Brak identyfikatora pozycji.' };
  const result = run('DELETE FROM action_center_mutes WHERE dedupe_key = ?', key);
  if (result.changes) audit(actor, 'admin', 'action_center.unmute', key, '');
  return { ok: true, removed: result.changes };
}

/**
 * Map one `applicationHealth()` result to an Action Center observation.
 * This function lives in health.mjs (additive) and is intentionally consumed
 * here so the process/application split stays owned by the health module.
 */
async function applicationObservations() {
  const health = await import('./health.mjs');
  const ids = ['phpmyadmin', 'roundcube'];
  const items = [];
  const sources = [];
  for (const id of ids) {
    let app;
    try {
      app = await health.applicationHealth(id);
    } catch (error) {
      sources.push({
        id: `app-health:${id}`,
        label: `Aplikacja ${id}`,
        status: 'unavailable',
        detail: `Probe aplikacji nie powiódł się: ${error.message}`,
        observedAt: nowIso(),
      });
      continue;
    }
    const name = app?.name || id;
    const observation = health.applicationObservation(app);
    if (!app?.installed) {
      sources.push({
        id: `app-health:${id}`,
        label: `Aplikacja ${name}`,
        status: 'ok',
        detail: 'Aplikacja nie jest zainstalowana — brak wpływu na dostępność.',
        observedAt: nowIso(),
      });
      continue;
    }
    if (!observation) {
      sources.push({
        id: `app-health:${id}`,
        label: `Aplikacja ${name}`,
        status: 'ok',
        detail: `HTTP ${app.http?.status ?? '—'} · proces ${app.process?.alive ? 'działa' : 'nie działa'} · login gotowy`,
        observedAt: nowIso(),
      });
      continue;
    }
    const severity = observation.severity === 'P0' || observation.severity === 'P1' ? 'P1' : 'P2';
    items.push(makeFinding({
      dedupeKey: `app-health:${id}:${observation.state}`,
      type: 'app-health',
      severity,
      title: observation.title,
      impact: observation.impact,
      recommendation: observation.recommendation,
      action: { label: 'Otwórz Health Center', href: '/admin/health' },
      detailsHref: '/admin/health',
      source: `app-health:${id}`,
      sourceDetail: observation.reason || `Stan aplikacji: ${observation.state}`,
      observedAt: observation.observedAt || nowIso(),
      evidence: {
        app: id,
        state: observation.state,
        httpStatus: observation.httpStatus,
        processAlive: observation.processAlive,
        port: observation.port,
        loginReady: observation.loginReady,
        reason: observation.reason,
      },
    }));
    sources.push({
      id: `app-health:${id}`,
      label: `Aplikacja ${name}`,
      status: 'partial',
      detail: observation.reason || `Stan aplikacji: ${observation.state}`,
      observedAt: observation.observedAt || nowIso(),
    });
  }
  return { items, sources };
}

/** Async application probe used by the page; kept separate from DB aggregation. */
export async function collectApplicationFindings() {
  try {
    return await applicationObservations();
  } catch (error) {
    return {
      items: [],
      sources: [{
        id: 'app-health',
        label: 'Aplikacje (phpMyAdmin / Roundcube)',
        status: 'unavailable',
        detail: `Nie można uruchomić probe aplikacji: ${error.message}`,
        observedAt: nowIso(),
      }],
    };
  }
}

function summarize(items, sources, now) {
  const active = items.filter((item) => !item.muted);
  const bySeverity = { P0: 0, P1: 0, P2: 0 };
  const byType = {};
  for (const item of active) {
    bySeverity[item.severity] += 1;
    byType[item.type] = (byType[item.type] || 0) + 1;
  }
  return {
    total: active.length,
    all: items.length,
    muted: items.length - active.length,
    bySeverity,
    byType,
    top: active.slice(0, 5),
    sourceCount: sources.length,
    unavailableSources: sources.filter((source) => source.status === 'unavailable').length,
    partialSources: sources.filter((source) => source.status === 'partial').length,
    generatedAt: now.toISOString(),
  };
}

/**
 * Collect one Action Center snapshot.
 *
 * Synchronous on purpose: the dashboard must stay fast and must never block on
 * remote checks. Application probes (which speak HTTP) are passed in by the
 * page through `extraItems`/`extraSources`; the snapshot then only merges them.
 */
export function collectActionCenter({
  now = new Date(),
  metrics = null,
  thresholds = null,
  extraItems = [],
  extraSources = [],
  serviceRows = null,
} = {}) {
  const at = normalizeNow(now);
  const atIso = at.toISOString();
  const limit = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  const items = [];
  const sources = [];
  const seen = new Set();

  const add = (item) => {
    if (!item || !item.dedupeKey || seen.has(item.dedupeKey)) return;
    seen.add(item.dedupeKey);
    items.push(item);
  };
  const source = (id, label, status, detail, observedAt = atIso) => {
    sources.push({ id, label, status, detail: String(detail || ''), observedAt });
  };
  const observe = (id, label, fn) => {
    try {
      const result = fn() || {};
      for (const item of result.items || []) add(item);
      source(id, label, result.status || 'ok', result.detail || '', result.observedAt || atIso);
    } catch (error) {
      source(id, label, 'unavailable', `Nie można odczytać źródła: ${error.message}`);
    }
  };

  /* --------------------------------------------------------- expected services */
  observe('services', 'Oczekiwane usługi', () => {
    const rows = all('SELECT * FROM services ORDER BY name');
    const activeEngine = setting('web_server', 'nginx');
    const classified = Array.isArray(serviceRows) && serviceRows.length
      ? serviceRows
      : serviceStateRows({ rows, provider: systemProvider(), activeEngine });
    const failed = classified.filter((row) => row.expected && row.state === 'failed');
    const unknown = classified.filter((row) => row.expected && row.state === 'unknown');
    const items = [];
    for (const row of failed) {
      items.push(makeFinding({
        dedupeKey: `service-failed:${row.name}`,
        type: 'service',
        severity: 'P0',
        title: `Usługa ${row.name} nie działa`,
        impact: 'Oczekiwana usługa nie odpowiada, więc zależne strony, poczta lub bazy mogą być niedostępne.',
        recommendation: `Uruchom usługę ${row.name} i sprawdź jej log. Jeśli usługa nie jest już potrzebna, zmień konfigurację zamiast ignorować alarm.`,
        action: { label: 'Otwórz usługi', href: '/admin/services' },
        detailsHref: '/admin/services',
        source: 'services',
        sourceDetail: `${row.detail} · źródło: ${row.source}`,
        observedAt: atIso,
        evidence: { service: row.name, state: row.state, detail: row.detail, provider: row.source },
      }));
    }
    for (const row of unknown) {
      items.push(makeFinding({
        dedupeKey: `service-unknown:${row.name}`,
        type: 'service',
        severity: 'P2',
        title: `Brak stanu usługi ${row.name}`,
        impact: 'Nie wiadomo, czy oczekiwana usługa działa — monitoring może nie wykryć awarii.',
        recommendation: 'Sprawdź usługę w System Services i odśwież stan. Brak danych nie jest traktowany jako sukces.',
        action: { label: 'Sprawdź usługę', href: '/admin/services' },
        detailsHref: '/admin/services',
        source: 'services',
        sourceDetail: row.detail,
        observedAt: atIso,
        evidence: { service: row.name, state: row.state, provider: row.source },
      }));
    }
    return {
      items,
      detail: `${classified.length} usług, ${failed.length} oczekiwanych nie działa, ${unknown.length} bez stanu`,
      status: unknown.length ? 'partial' : 'ok',
    };
  });

  /* ------------------------------------------------------------- certificates */
  observe('ssl', 'Certyfikaty SSL', () => {
    const certs = all("SELECT id, domain, username, type, issuer, expires_at FROM ssl_certs WHERE status = 'active' AND expires_at IS NOT NULL ORDER BY expires_at ASC");
    const items = [];
    let expired = 0;
    let warning = 0;
    for (const cert of certs) {
      const expires = new Date(cert.expires_at).getTime();
      if (!Number.isFinite(expires)) continue;
      const isExpired = expires <= at.getTime();
      const days = Math.ceil((expires - at.getTime()) / DAY_MS);
      if (isExpired) expired += 1;
      let severity = null;
      if (isExpired) severity = 'P0';
      else if (days <= limit.sslWarnDays) severity = 'P1';
      else if (days <= limit.sslNoticeDays) severity = 'P2';
      if (!severity) continue;
      if (!isExpired) warning += 1;
      const label = isExpired ? `Certyfikat ${cert.domain} wygasł` : `Certyfikat ${cert.domain} wygasa za ${days} dni`;
      items.push(makeFinding({
        dedupeKey: `cert-expiry:${cert.domain}`,
        type: 'ssl',
        severity,
        title: label,
        impact: isExpired
          ? 'Przeglądarki pokażą ostrzeżenie, a część klientów nie połączy się ze stroną.'
          : 'Po wygaśnięciu strony i poczta HTTPS przestaną być zaufane dla użytkowników.',
        recommendation: isExpired
          ? 'Wystaw certyfikat ponownie i sprawdź, czy odnowienie ACME działa automatycznie.'
          : 'Odśwież certyfikat w AutoSSL Center; jeśli odnowienie nie działa, sprawdź DNS i port 80.',
        action: { label: 'Otwórz AutoSSL', href: '/admin/ssl-center' },
        detailsHref: '/admin/ssl-center',
        source: 'ssl',
        sourceDetail: `${cert.type || 'certyfikat'} · ${cert.issuer || 'wystawca nieznany'} · ważny do ${cert.expires_at}`,
        observedAt: atIso,
        evidence: { domain: cert.domain, username: cert.username, expiresAt: cert.expires_at, daysLeft: days },
      }));
    }
    return {
      items,
      detail: certs.length
        ? `${certs.length} aktywnych certyfikatów · ${expired} wygasło · ${warning} wymaga odnowienia`
        : 'Brak aktywnych certyfikatów w bazie panelu',
    };
  });

  /* ---------------------------------------------------------------- backups */
  observe('backup', 'Kopie zapasowe', () => {
    const servers = listBackupServers();
    const runs = listBackupRuns(50);
    const jobs = all('SELECT * FROM backup_jobs ORDER BY name');
    const items = [];
    const remoteTypes = new Set(['sftp', 's3', 'ftp']);
    const remote = servers.filter((server) => remoteTypes.has(server.type) && Number(server.enabled) === 1);
    const enabledJobs = jobs.filter((job) => Number(job.enabled) === 1);
    const remoteIds = new Set(remote.map((server) => server.id));
    const recentCutoff = at.getTime() - limit.backupMaxAgeDays * DAY_MS;

    const latestAdmin = get("SELECT * FROM backups WHERE filename LIKE 'admin_backup_%' ORDER BY created_at DESC LIMIT 1");
    const latestRun = runs.find((row) => ['complete', 'succeeded'].includes(String(row.status)) && row.finished_at);
    const freshest = [latestAdmin?.created_at, latestRun?.finished_at]
      .filter(Boolean)
      .map((value) => new Date(value).getTime())
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0] || null;
    if (!freshest || freshest < recentCutoff) {
      items.push(makeFinding({
        dedupeKey: 'backup:server-freshness',
        type: 'backup',
        severity: 'P1',
        title: freshest ? `Ostatnia kopia serwera jest starsza niż ${limit.backupMaxAgeDays} dni` : 'Brak kopii zapasowej serwera',
        impact: 'Odtworzenie serwera po awarii lub błędnej zmianie może być niemożliwe albo nieaktualne.',
        recommendation: 'Uruchom kopię serwera i sprawdź harmonogram oraz retencję. Kopia bez testu odtworzenia nie jest gwarancją.',
        action: { label: 'Otwórz Backup Center', href: '/admin/backup-center' },
        detailsHref: '/admin/backup-center?tab=runs',
        source: 'backup',
        sourceDetail: freshest ? `Najnowsza kopia: ${new Date(freshest).toISOString()}` : 'Brak zakończonej kopii w panelu',
        observedAt: atIso,
        evidence: { latestAdmin: latestAdmin?.created_at || null, latestRun: latestRun?.finished_at || null, maxAgeDays: limit.backupMaxAgeDays },
      }));
    }

    const failedRuns = runs.filter((row) => {
      const stamp = row.finished_at || row.started_at;
      const time = new Date(stamp).getTime();
      return String(row.status) === 'failed' && Number.isFinite(time) && time >= at.getTime() - 7 * DAY_MS;
    });
    if (failedRuns.length) {
      const latest = failedRuns[0];
      items.push(makeFinding({
        dedupeKey: 'backup:failed-runs',
        type: 'backup',
        severity: 'P1',
        title: `${failedRuns.length} nieudanych uruchomień kopii zapasowej w 7 dni`,
        impact: 'Harmonogram kopii nie domyka się, więc ostatni sukces może być starszy niż wygląda.',
        recommendation: 'Otwórz raport uruchomień, sprawdź błąd celu lub miejsca i ponów job. Nie usuwaj poprzednich kopii do czasu sukcesu.',
        action: { label: 'Zobacz uruchomienia', href: '/admin/backup-center?tab=runs' },
        detailsHref: '/admin/backup-center?tab=runs',
        source: 'backup',
        sourceDetail: `${latest.job_name || 'kopia'} · ${latest.finished_at || latest.started_at} · ${String(latest.output || '').slice(0, 240)}`,
        observedAt: atIso,
        evidence: { failed: failedRuns.length, latestRunId: latest.id, status: latest.status },
      }));
    }

    const failedJobs = enabledJobs.filter((job) => String(job.last_status || '') === 'failed');
    for (const job of failedJobs) {
      items.push(makeFinding({
        dedupeKey: `backup-job-failed:${job.id}`,
        type: 'backup',
        severity: 'P1',
        title: `Harmonogram „${job.name}” zakończył się błędem`,
        impact: 'Ten zakres danych nie jest kopiowany zgodnie z harmonogramem.',
        recommendation: 'Sprawdź ostatni błąd joba, cel kopii i wolne miejsce, a następnie uruchom job ręcznie.',
        action: { label: 'Otwórz job', href: '/admin/backup-center?tab=jobs' },
        detailsHref: '/admin/backup-center?tab=jobs',
        source: 'backup',
        sourceDetail: String(job.last_output || job.last_status || '').slice(0, 300),
        observedAt: job.last_run_at || atIso,
        evidence: { jobId: job.id, scope: job.scope, serverId: job.server_id, lastRunAt: job.last_run_at },
      }));
    }

    if (!enabledJobs.length) {
      items.push(makeFinding({
        dedupeKey: 'backup:no-schedule',
        type: 'backup',
        severity: 'P1',
        title: 'Brak aktywnego harmonogramu kopii zapasowych',
        impact: 'Kopie nie powstaną automatycznie; awaria lub błąd operatora może oznaczać trwałą utratę danych.',
        recommendation: 'Utwórz harmonogram kopii z retencją i co najmniej jednym celem zewnętrznym.',
        action: { label: 'Skonfiguruj backup', href: '/admin/backup-center?tab=jobs' },
        detailsHref: '/admin/backup-center?tab=jobs',
        source: 'backup',
        sourceDetail: 'backup_jobs: 0 aktywnych',
        observedAt: atIso,
        evidence: { jobs: jobs.length, enabled: 0 },
      }));
    }

    if (!remote.length) {
      items.push(makeFinding({
        dedupeKey: 'backup:no-external-target',
        type: 'backup',
        severity: 'P1',
        title: 'Brak zewnętrznego celu kopii zapasowej',
        impact: 'Kopia leży na tym samym serwerze co dane — awaria hosta lub ransomware usuwa oba egzemplarze.',
        recommendation: 'Dodaj cel SFTP lub S3 i wskaż go w harmonogramie. Unikaj nieszyfrowanego FTP.',
        action: { label: 'Dodaj cel kopii', href: '/admin/backup-center?tab=servers' },
        detailsHref: '/admin/backup-center?tab=servers',
        source: 'backup',
        sourceDetail: `${servers.length} celów w panelu, 0 aktywnych zewnętrznych (SFTP/S3/FTP)`,
        observedAt: atIso,
        evidence: { servers: servers.map((server) => ({ id: server.id, type: server.type, enabled: server.enabled })) },
      }));
    } else {
      const untested = remote.filter((server) => server.last_test_ok === null || server.last_test_ok === undefined);
      const broken = remote.filter((server) => Number(server.last_test_ok) === 0);
      for (const server of broken) {
        items.push(makeFinding({
          dedupeKey: `backup-server-test:${server.id}`,
          type: 'backup',
          severity: 'P1',
          title: `Cel kopii „${server.name}” nie przeszedł testu`,
          impact: 'Kopie mogą nie docierać poza serwer, mimo że harmonogram raportuje uruchomienia.',
          recommendation: 'Popraw dane dostępowe lub sieć, wykonaj test połączenia i ponów kopię.',
          action: { label: 'Przetestuj cel', href: '/admin/backup-center?tab=servers' },
          detailsHref: '/admin/backup-center?tab=servers',
          source: 'backup',
          sourceDetail: String(server.last_test_output || '').slice(0, 300) || 'Ostatni test nie powiódł się',
          observedAt: server.last_test_at || atIso,
          evidence: { serverId: server.id, type: server.type },
        }));
      }
      for (const server of untested) {
        items.push(makeFinding({
          dedupeKey: `backup-server-untested:${server.id}`,
          type: 'backup',
          severity: 'P2',
          title: `Cel kopii „${server.name}” nie był testowany`,
          impact: 'Nie wiadomo, czy zewnętrzna kopia jest w ogóle zapisywana.',
          recommendation: 'Uruchom test połączenia w Backup Center.',
          action: { label: 'Przetestuj cel', href: '/admin/backup-center?tab=servers' },
          detailsHref: '/admin/backup-center?tab=servers',
          source: 'backup',
          sourceDetail: 'Brak historii testu połączenia',
          observedAt: atIso,
          evidence: { serverId: server.id, type: server.type },
        }));
      }
      const jobsUsingRemote = enabledJobs.filter((job) => remoteIds.has(job.server_id));
      if (enabledJobs.length && !jobsUsingRemote.length) {
        items.push(makeFinding({
          dedupeKey: 'backup:no-remote-schedule',
          type: 'backup',
          severity: 'P1',
          title: 'Harmonogram nie wysyła kopii do celu zewnętrznego',
          impact: 'Zewnętrzny cel istnieje, ale żaden aktywny job go nie używa — kopia pozostaje lokalna.',
          recommendation: 'Przypisz zewnętrzny cel do harmonogramu i wykonaj próbną kopię.',
          action: { label: 'Edytuj harmonogram', href: '/admin/backup-center?tab=jobs' },
          detailsHref: '/admin/backup-center?tab=jobs',
          source: 'backup',
          sourceDetail: `${enabledJobs.length} aktywnych jobów, 0 wskazuje cel zewnętrzny`,
          observedAt: atIso,
          evidence: { remoteIds: [...remoteIds], jobs: enabledJobs.length },
        }));
      }
    }

    const lastRun = latestRun || null;
    return {
      items,
      detail: `${enabledJobs.length} aktywnych harmonogramów · ${remote.length} celów zewnętrznych · ${runs.length} uruchomień w historii${lastRun?.finished_at ? ` · ostatni sukces ${lastRun.finished_at}` : ''}`,
    };
  });

  /* ------------------------------------------------------------------- mail */
  observe('mail', 'Kolejka i bounce poczty', () => {
    const items = [];
    const snap = mailQueueSnapshot();
    if (snap.ok === false) throw new Error(snap.error || 'Kolejka poczty jest niedostępna');
    const byStatus = { failed: snap.failed, deferred: snap.deferred, queued: snap.queued, total: snap.total };
    const failed = snap.failed;
    const deferred = snap.deferred;
    const total = snap.total;
    if (failed > 0) {
      items.push(makeFinding({
        dedupeKey: 'mail:queue-failed',
        type: 'mail',
        severity: 'P1',
        title: `${failed} wiadomości w kolejce poczty ma status failed`,
        impact: 'Wiadomości nie zostaną dostarczone; nadawcy i klienci mogą nie wiedzieć o niepowodzeniu.',
        recommendation: 'Otwórz kolejkę, sprawdź powód odrzucenia i ponów lub usuń wiadomości po analizie.',
        action: { label: 'Otwórz kolejkę', href: '/admin/mail?tab=queue' },
        detailsHref: '/admin/mail?tab=queue',
        source: 'mail',
        sourceDetail: `${snap.source}: ${failed} failed, ${deferred} deferred, ${total} łącznie`,
        observedAt: atIso,
        evidence: { byStatus, total },
      }));
    }
    if (deferred >= limit.queueDeferredWarn) {
      items.push(makeFinding({
        dedupeKey: 'mail:queue-deferred',
        type: 'mail',
        severity: 'P2',
        title: `${deferred} wstrzymanych wiadomości w kolejce`,
        impact: 'Dostarczenie jest opóźnione; narastająca kolejka może oznaczać problem z limitami lub reputacją.',
        recommendation: 'Sprawdź powody deferrali i limity wychodzącej poczty.',
        action: { label: 'Otwórz kolejkę', href: '/admin/mail?tab=queue' },
        detailsHref: '/admin/mail?tab=queue',
        source: 'mail',
        sourceDetail: `mail_queue: ${deferred} deferred`,
        observedAt: atIso,
        evidence: { byStatus, total },
      }));
    }

    const since = new Date(at.getTime() - DAY_MS).toISOString();
    const bounceRow = get(`SELECT COUNT(*) AS received,
        COALESCE(SUM(CASE WHEN raw LIKE '%<= <>%' OR raw LIKE '%<=<>%' THEN 1 ELSE 0 END), 0) AS bounced
      FROM mail_events WHERE created_at > ? AND status = 'received'`, since);
    const received = Number(bounceRow?.received) || 0;
    const bounced = Number(bounceRow?.bounced) || 0;
    let bounceRate = null;
    let bounceStatus = 'ok';
    let bounceDetail = `0 zdarzeń received w 24 h`;
    if (received > 0) {
      bounceRate = Math.round((bounced / received) * 1000) / 10;
      bounceDetail = `${bounced}/${received} bounce w 24 h (${bounceRate}%)`;
      if (received >= limit.bounceMinMessages && bounceRate >= limit.bounceCriticalPercent) {
        items.push(makeFinding({
          dedupeKey: 'mail:bounce-rate',
          type: 'mail',
          severity: 'P1',
          title: `Wysoki współczynnik bounce: ${bounceRate}%`,
          impact: 'Duża część wiadomości jest odbijana — możliwa utrata poczty i pogorszenie reputacji domeny.',
          recommendation: 'Sprawdź odrzucenia w Mail Operations, poprawność SPF/DKIM/DMARC i jakość list adresów.',
          action: { label: 'Otwórz zdarzenia poczty', href: '/admin/mail?tab=events' },
          detailsHref: '/admin/mail?tab=events',
          source: 'mail',
          sourceDetail: bounceDetail,
          observedAt: atIso,
          evidence: { received, bounced, bounceRate, windowHours: 24, threshold: limit.bounceCriticalPercent },
        }));
      } else if (received >= limit.bounceMinMessages && bounceRate >= limit.bounceWarnPercent) {
        items.push(makeFinding({
          dedupeKey: 'mail:bounce-rate',
          type: 'mail',
          severity: 'P2',
          title: `Podwyższony współczynnik bounce: ${bounceRate}%`,
          impact: 'Część wiadomości nie dociera; warto sprawdzić konfigurację uwierzytelniania domeny.',
          recommendation: 'Sprawdź SPF, DKIM i DMARC oraz odrzucenia w Mail Operations.',
          action: { label: 'Otwórz zdarzenia poczty', href: '/admin/mail?tab=events' },
          detailsHref: '/admin/mail?tab=events',
          source: 'mail',
          sourceDetail: bounceDetail,
          observedAt: atIso,
          evidence: { received, bounced, bounceRate, windowHours: 24, threshold: limit.bounceWarnPercent },
        }));
      } else if (received < limit.bounceMinMessages) {
        bounceStatus = 'partial';
        bounceDetail += ` — za mało danych do oceny progu (minimum ${limit.bounceMinMessages})`;
      }
    } else {
      bounceStatus = 'unavailable';
      bounceDetail = 'Brak zdarzeń poczty w 24 h — wskaźnik bounce niemierzalny (log niezsynchronizowany lub brak ruchu)';
    }
    return {
      items,
      detail: `kolejka: ${total} (${failed} failed, ${deferred} deferred) · ${bounceDetail}`,
      status: bounceStatus === 'unavailable' ? 'partial' : bounceStatus,
    };
  });

  /* ---------------------------------------------------------------- updates */
  observe('updates', 'Aktualizacje', () => {
    const items = [];
    let pending = [];
    try {
      const dir = path.join(config.dataDir, 'updates');
      pending = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((name) => /^pending-.*\.json$/.test(name))
        : [];
    } catch (error) {
      return { items, status: 'unavailable', detail: `Nie można odczytać katalogu aktualizacji: ${error.message}` };
    }
    if (pending.length) {
      items.push(makeFinding({
        dedupeKey: 'update:pending-finalize',
        type: 'updates',
        severity: 'P1',
        title: 'Aktualizacja panelu oczekuje na dokończenie po restarcie',
        impact: 'Panel może działać na mieszanych plikach lub schemacie do czasu finalizacji aktualizacji.',
        recommendation: 'Otwórz Update Center i dokończ lub wycofaj oczekującą aktualizację.',
        action: { label: 'Otwórz Update Center', href: '/admin/updates-center' },
        detailsHref: '/admin/updates-center',
        source: 'updates',
        sourceDetail: `pending: ${pending.join(', ')}`,
        observedAt: atIso,
        evidence: { pending },
      }));
    }
    return {
      items,
      status: 'partial',
      detail: 'Zdalne sprawdzanie krytycznych wydań nie jest uruchamiane przy każdym odczycie Action Center — uruchom je w Update Center, aby uzyskać aktualny stan.',
    };
  });

  /* ------------------------------------------------- disk / RAM / inode usage */
  observe('resources', 'Dysk, RAM i inody', () => {
    const service = metrics || new MetricsService();
    const items = [];
    const problems = [];

    const memory = service.memory();
    if (!memory.available) {
      problems.push(`RAM: ${memory.reason}`);
    } else if (Number.isFinite(memory.percent)) {
      const severity = memory.percent >= limit.memoryCriticalPercent ? 'P0'
        : memory.percent >= limit.memoryWarnPercent ? 'P1' : null;
      if (severity) {
        items.push(makeFinding({
          dedupeKey: 'resources:memory',
          type: 'resources',
          severity,
          title: `Pamięć RAM zajęta w ${memory.percent}%`,
          impact: 'Brak wolnej pamięci może powodować OOM killer, restarty usług i spowolnienie stron.',
          recommendation: 'Znajdź procesy zużywające pamięć, sprawdź limity PHP-FPM i ewentualnie zwiększ RAM.',
          action: { label: 'Otwórz System Information', href: '/admin/system-info' },
          detailsHref: '/admin/system-info',
          source: 'resources',
          sourceDetail: `${memory.source} · ${memory.timestamp}`,
          observedAt: memory.timestamp || atIso,
          evidence: { usedBytes: memory.usedBytes, totalBytes: memory.totalBytes, percent: memory.percent },
        }));
      }
    }

    const mounts = [config.dataDir, '/'].filter((value, index, list) => list.indexOf(value) === index);
    const inodes = new Map();
    for (const mount of mounts) {
      const disk = service.disk(mount);
      if (!disk.available) {
        problems.push(`${mount}: ${disk.reason}`);
      } else if (Number.isFinite(disk.percent)) {
        const severity = disk.percent >= limit.diskCriticalPercent ? 'P0'
          : disk.percent >= limit.diskWarnPercent ? 'P1' : null;
        if (severity) {
          items.push(makeFinding({
            dedupeKey: `resources:disk:${mount}`,
            type: 'resources',
            severity,
            title: `Dysk ${mount} zajęty w ${disk.percent}%`,
            impact: 'Brak miejsca zatrzyma kopie, logi, pocztę i zapisy bazy danych.',
            recommendation: 'Usuń stare logi i kopie, sprawdź duże katalogi; nie usuwaj danych klientów bez kopii.',
            action: { label: 'Otwórz System Information', href: '/admin/system-info' },
            detailsHref: '/admin/system-info',
            source: 'resources',
            sourceDetail: `${disk.source} · ${disk.timestamp}`,
            observedAt: disk.timestamp || atIso,
            evidence: { mount, usedBytes: disk.usedBytes, totalBytes: disk.totalBytes, percent: disk.percent },
          }));
        }
      }
      try {
        const stat = fs.statfsSync(mount);
        const files = Number(stat?.files);
        const freeFiles = Number(stat?.ffree);
        if (Number.isFinite(files) && files > 0 && Number.isFinite(freeFiles) && freeFiles >= 0) {
          const usedFiles = Math.max(0, files - freeFiles);
          const percent = Math.round((usedFiles / files) * 1000) / 10;
          inodes.set(mount, { percent, usedFiles, files });
          const severity = percent >= limit.inodeCriticalPercent ? 'P0'
            : percent >= limit.inodeWarnPercent ? 'P1' : null;
          if (severity) {
            items.push(makeFinding({
              dedupeKey: `resources:inodes:${mount}`,
              type: 'resources',
              severity,
              title: `Inody ${mount} zajęte w ${percent}%`,
              impact: 'Można nie móc utworzyć nowych plików nawet przy wolnym miejscu na dysku.',
              recommendation: 'Znajdź katalogi z ogromną liczbą małych plików (cache, sesje, poczta) i wyczyść je zgodnie z retencją.',
              action: { label: 'Otwórz System Information', href: '/admin/system-info' },
              detailsHref: '/admin/system-info',
              source: 'resources',
              sourceDetail: `statfs:${mount} · ${usedFiles}/${files} inodów`,
              observedAt: atIso,
              evidence: { mount, usedFiles, files, percent },
            }));
          }
        }
      } catch (error) {
        problems.push(`${mount} inody: ${error.code || error.message}`);
      }
    }

    const detail = [
      memory.available ? `RAM ${memory.percent}%` : 'RAM niedostępne',
      ...mounts.map((mount) => {
        const disk = service.disk(mount);
        const inode = inodes.get(mount);
        return `${mount} ${disk.available ? `${disk.percent}%` : 'niedostępny'}${inode ? ` / inody ${inode.percent}%` : ''}`;
      }),
      ...problems,
    ].join(' · ');
    return { items, detail, status: problems.length ? 'partial' : 'ok' };
  });

  /* -------------------------------------------------------------------- DNS */
  observe('dns', 'DNS stref panelu', () => {
    const expected = String(setting('server_ip', config.defaults.serverIp) || '').trim();
    const domains = all("SELECT id, name, username FROM domains WHERE status = 'active' ORDER BY name");
    if (!expected) {
      return { items: [], status: 'unavailable', detail: 'Brak ustawienia server_ip — nie można porównać rekordów A' };
    }
    if (!domains.length) return { items: [], detail: 'Brak aktywnych domen do sprawdzenia' };
    const records = all("SELECT domain_id, name, value FROM dns_records WHERE type = 'A'");
    const byDomain = new Map();
    for (const row of records) {
      if (!byDomain.has(row.domain_id)) byDomain.set(row.domain_id, []);
      byDomain.get(row.domain_id).push(row);
    }
    const items = [];
    let mismatched = 0;
    let missing = 0;
    for (const domain of domains) {
      const rows = byDomain.get(domain.id) || [];
      const apex = rows.filter((row) => row.name === '@' || row.name === '' || row.name === domain.name);
      if (!apex.length) {
        missing += 1;
        items.push(makeFinding({
          dedupeKey: `dns-missing-a:${domain.name}`,
          type: 'dns',
          severity: 'P2',
          title: `Domena ${domain.name} nie ma rekordu A w panelu`,
          impact: 'Domena może nie wskazywać na ten serwer, nawet jeśli vhost istnieje.',
          recommendation: 'Dodaj rekord A @ wskazujący na adres serwera i sprawdź delegację u registrar.',
          action: { label: 'Otwórz DNS', href: '/admin/dns' },
          detailsHref: '/admin/dns',
          source: 'dns',
          sourceDetail: `oczekiwano A → ${expected}`,
          observedAt: atIso,
          evidence: { domain: domain.name, expected, records: rows.length },
        }));
        continue;
      }
      const values = [...new Set(apex.map((row) => String(row.value).trim()))];
      if (!values.includes(expected)) {
        mismatched += 1;
        items.push(makeFinding({
          dedupeKey: `dns-mismatch:${domain.name}`,
          type: 'dns',
          severity: 'P1',
          title: `Rekord A domeny ${domain.name} wskazuje inny adres`,
          impact: 'Ruch może trafiać na inny serwer albo wcale, mimo poprawnego vhosta.',
          recommendation: 'Popraw rekord A na adres serwera po potwierdzeniu, że domena ma być hostowana tutaj.',
          action: { label: 'Popraw rekord A', href: '/admin/dns' },
          detailsHref: '/admin/dns',
          source: 'dns',
          sourceDetail: `A: ${values.join(', ')} · oczekiwano ${expected}`,
          observedAt: atIso,
          evidence: { domain: domain.name, expected, actual: values },
        }));
      }
    }
    return {
      items,
      detail: `${domains.length} aktywnych domen · ${mismatched} niezgodnych A · ${missing} bez A`,
      status: 'ok',
    };
  });

  /* ------------------------------------------------------------ 2FA accounts */
  observe('accounts', 'Konta bez 2FA', () => {
    const rows = all('SELECT level, COUNT(*) AS n, GROUP_CONCAT(username) AS usernames FROM users WHERE twofa_enabled = 0 GROUP BY level');
    const byLevel = Object.fromEntries(rows.map((row) => [row.level, { count: Number(row.n) || 0, usernames: String(row.usernames || '').split(',').filter(Boolean).slice(0, 8) }]));
    const items = [];
    if (byLevel.admin?.count) {
      items.push(makeFinding({
        dedupeKey: 'accounts:2fa:admin',
        type: 'accounts',
        severity: 'P1',
        title: `${byLevel.admin.count} konto(a) administratora bez 2FA`,
        impact: 'Przejęcie hasła administratora daje pełną kontrolę nad panelem i serwerem.',
        recommendation: 'Włącz 2FA dla kont administratorów i przechowuj kody odzyskiwania poza serwerem.',
        action: { label: 'Otwórz konta', href: '/admin/users' },
        detailsHref: '/admin/action-center?type=accounts',
        source: 'accounts',
        sourceDetail: `admin: ${byLevel.admin.usernames.join(', ')}`,
        observedAt: atIso,
        evidence: { level: 'admin', count: byLevel.admin.count, usernames: byLevel.admin.usernames },
      }));
    }
    for (const level of ['reseller', 'user']) {
      if (!byLevel[level]?.count) continue;
      items.push(makeFinding({
        dedupeKey: `accounts:2fa:${level}`,
        type: 'accounts',
        severity: 'P2',
        title: `${byLevel[level].count} kont (${level === 'reseller' ? 'resellerzy' : 'użytkownicy'}) bez 2FA`,
        impact: 'Konta klientów są chronione tylko hasłem; phishing lub wyciek hasła wystarczy do przejęcia.',
        recommendation: 'Zachęć lub wymuś 2FA w polityce kont i pokaż użytkownikom prostą instrukcję włączenia.',
        action: { label: 'Otwórz konta', href: '/admin/users' },
        detailsHref: `/admin/action-center?type=accounts`,
        source: 'accounts',
        sourceDetail: `${level}: ${byLevel[level].usernames.join(', ')}${byLevel[level].count > byLevel[level].usernames.length ? '…' : ''}`,
        observedAt: atIso,
        evidence: { level, count: byLevel[level].count, usernames: byLevel[level].usernames },
      }));
    }
    const total = Object.values(byLevel).reduce((sum, entry) => sum + entry.count, 0);
    return {
      items,
      detail: total
        ? `${total} kont bez 2FA (${Object.entries(byLevel).map(([level, entry]) => `${level}: ${entry.count}`).join(', ')})`
        : 'Wszystkie konta mają włączone 2FA',
    };
  });

  /* -------------------------------------------------------------- automation */
  observe('automation', 'Automatyzacja', () => {
    const jobs = all('SELECT * FROM automation_jobs ORDER BY key');
    const items = [];
    const failures = [];
    for (const job of jobs) {
      const observation = deriveJobObservation({
        key: job.key,
        status: job.last_status,
        output: job.last_output,
        error: job.last_status === 'error' ? job.last_output : '',
      });
      const failed = Number(job.fail_count || 0) > 0 || String(job.last_status || '') === 'error';
      const observedBad = ['critical', 'warning'].includes(observation.observedStatus);
      if (!failed && !observedBad) continue;
      failures.push({ job, observation });
      items.push(makeFinding({
        dedupeKey: `automation-failed:${job.key}`,
        type: 'automation',
        severity: observation.observedStatus === 'critical' ? 'P1' : 'P2',
        title: observation.observedStatus === 'critical' ? `Kontrola „${job.label}” wykryła stan krytyczny` : `Zadanie automatyzacji „${job.label}” wymaga uwagi`,
        impact: observation.observedStatus === 'critical' ? 'Kontrola wykonała się, ale wykryła realny problem operacyjny — nie jest to sukces.' : 'Powtarzalna kontrola lub czynność porządkowa nie wykonuje się poprawnie.',
        recommendation: 'Otwórz zadanie, sprawdź ostatni błąd i uruchom je ręcznie po poprawieniu przyczyny.',
        action: { label: 'Otwórz automatyzację', href: `/admin/automation?edit=${encodeURIComponent(job.key)}` },
        detailsHref: '/admin/automation',
        source: 'automation',
        sourceDetail: `wykonanie ${job.last_status} · obserwacja ${observation.observedStatus} · ${job.fail_count || 0} niepowodzeń · ${String(job.last_output || '').slice(0, 240)}`,
        observedAt: job.last_run_at || atIso,
        evidence: { key: job.key, failCount: job.fail_count, lastStatus: job.last_status, observedStatus: observation.observedStatus, reason: observation.reason },
      }));
    }
    const enabled = jobs.filter((job) => Number(job.enabled) === 1).length;
    return {
      items,
      detail: `${enabled}/${jobs.length} zadań włączonych · ${failures.filter((f) => f.observation.observedStatus === 'critical').length} krytycznych obserwacji · ${failures.length} wymaga uwagi`,
    };
  });

  /* ------------------------------------------------------- logins and blocks */
  observe('security', 'Nieudane logowania i blokady', () => {
    const since = new Date(at.getTime() - limit.failedLoginWindowHours * 3600000).toISOString();
    const attempts = all(`SELECT ip, COUNT(*) AS attempts, MAX(created_at) AS last, GROUP_CONCAT(DISTINCT username) AS users
      FROM login_attempts WHERE created_at > ? GROUP BY ip ORDER BY attempts DESC LIMIT 20`, since);
    const totalAttempts = attempts.reduce((sum, row) => sum + Number(row.attempts || 0), 0);
    const repeat = attempts.filter((row) => Number(row.attempts) >= limit.failedLoginRepeatCount);
    const blocks = all('SELECT * FROM ip_blocks WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at DESC', atIso);
    const items = [];
    if (repeat.length) {
      items.push(makeFinding({
        dedupeKey: 'security:failed-logins',
        type: 'security',
        severity: 'P1',
        title: `Powtarzające się nieudane logowania z ${repeat.length} adresów`,
        impact: 'Trwa próba zgadywania haseł; konto może zostać zablokowane lub przejęte.',
        recommendation: 'Sprawdź listę IP, zablokuj powtarzające się źródła i rozważ 2FA oraz ograniczenie dostępu do panelu.',
        action: { label: 'Otwórz Brute Force Monitor', href: '/admin/brute-force' },
        detailsHref: '/admin/brute-force',
        source: 'security',
        sourceDetail: `${totalAttempts} prób w ${limit.failedLoginWindowHours} h · najwięcej: ${attempts[0]?.ip || '—'} (${attempts[0]?.attempts || 0})`,
        observedAt: atIso,
        evidence: { windowHours: limit.failedLoginWindowHours, totalAttempts, repeat: repeat.slice(0, 10) },
      }));
    } else if (totalAttempts >= 5) {
      items.push(makeFinding({
        dedupeKey: 'security:failed-logins',
        type: 'security',
        severity: 'P2',
        title: `${totalAttempts} nieudanych logowań w ${limit.failedLoginWindowHours} h`,
        impact: 'Zwiększona liczba błędnych logowań może być próbą zgadywania haseł lub błędem konfiguracji klienta.',
        recommendation: 'Sprawdź źródła i upewnij się, że konta mają 2FA.',
        action: { label: 'Otwórz Brute Force Monitor', href: '/admin/brute-force' },
        detailsHref: '/admin/brute-force',
        source: 'security',
        sourceDetail: `${totalAttempts} prób z ${attempts.length} adresów`,
        observedAt: atIso,
        evidence: { windowHours: limit.failedLoginWindowHours, totalAttempts, attempts: attempts.slice(0, 10) },
      }));
    }
    if (blocks.length) {
      items.push(makeFinding({
        dedupeKey: 'security:active-blocks',
        type: 'security',
        severity: 'P2',
        title: `${blocks.length} aktywnych blokad IP`,
        impact: 'Blokady działają, ale ich liczba rośnie — warto sprawdzić, czy nie blokują legalnego ruchu.',
        recommendation: 'Przejrzyj blokady i daty wygaśnięcia; usuń nieaktualne wpisy.',
        action: { label: 'Zarządzaj blokadami', href: '/admin/security?tab=firewall' },
        detailsHref: '/admin/security?tab=firewall',
        source: 'security',
        sourceDetail: `aktywne blokady: ${blocks.length}`,
        observedAt: atIso,
        evidence: { activeBlocks: blocks.length, sample: blocks.slice(0, 10).map((row) => ({ cidr: row.cidr, expiresAt: row.expires_at })) },
      }));
    }
    return {
      items,
      detail: `${totalAttempts} nieudanych logowań w ${limit.failedLoginWindowHours} h · ${blocks.length} aktywnych blokad`,
    };
  });

  /* ------------------------------------------------------ injected app probes */
  for (const item of extraItems) add(item);
  for (const entry of extraSources) {
    sources.push({
      id: String(entry.id || 'extra'),
      label: String(entry.label || entry.id || 'Dodatkowe źródło'),
      status: ['ok', 'partial', 'unavailable'].includes(entry.status) ? entry.status : 'unavailable',
      detail: String(entry.detail || ''),
      observedAt: entry.observedAt || atIso,
    });
  }

  // Mutes are applied last so injected findings behave exactly like built-ins.
  let mutes = [];
  try {
    mutes = activeMutes({ now: at });
  } catch (error) {
    source('mutes', 'Wyciszenia', 'unavailable', `Nie można odczytać wyciszeń: ${error.message}`);
  }
  const muteByKey = new Map(mutes.map((row) => [row.dedupe_key, row]));
  for (const item of items) {
    const mute = muteByKey.get(item.dedupeKey);
    if (!mute) continue;
    item.muted = true;
    item.muteUntil = mute.muted_until;
    item.mutedBy = mute.muted_by;
    item.muteReason = mute.reason || '';
  }

  const rank = { P0: 0, P1: 1, P2: 2 };
  items.sort((a, b) => (rank[a.severity] - rank[b.severity]) || a.title.localeCompare(b.title, 'pl'));
  const summary = summarize(items, sources, at);
  return {
    generatedAt: atIso,
    items,
    sources,
    ...summary,
    thresholds: limit,
  };
}

/**
 * Small, deliberately side-effect-free projection used by the dashboard card.
 * It never probes applications or the network.
 */
export function collectDashboardAttention(options = {}) {
  const snapshot = collectActionCenter(options);
  return {
    generatedAt: snapshot.generatedAt,
    total: snapshot.total,
    bySeverity: snapshot.bySeverity,
    top: snapshot.top,
    muted: snapshot.muted,
    unavailableSources: snapshot.unavailableSources,
  };
}

/** Safe return target for mute/unmute POSTs: only the Action Center itself. */
export function safeActionCenterReturn(value) {
  const text = String(value || '');
  if (!/^\/admin\/action-center(?:\?[^#]*)?$/.test(text)) return '/admin/action-center';
  return text;
}
