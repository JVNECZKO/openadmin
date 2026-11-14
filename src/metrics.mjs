// MetricsService — one source of truth for host measurements.
//
// Every value is stored in base units (bytes, seconds) together with the
// source that produced it, its timestamp and an explicit freshness state.
// Presentation code uses the single IEC formatter below; unavailable data is
// represented as `null` and must never be rendered as `0`.
import fs from 'node:fs';
import os from 'node:os';

export const METRIC_STATUS = Object.freeze({
  FRESH: 'fresh',
  STALE: 'stale',
  UNAVAILABLE: 'unavailable',
});

export const METRIC_UNITS = Object.freeze({ BYTES: 'bytes', SECONDS: 'seconds' });

export const SERVICE_STATE = Object.freeze({
  EXPECTED: 'expected',
  INSTALLED: 'installed',
  ENABLED: 'enabled',
  RUNNING: 'running',
  INACTIVE_BY_DESIGN: 'inactive-by-design',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
});

export const SERVICE_STATE_LABEL = Object.freeze({
  running: 'działa',
  failed: 'nie działa',
  'inactive-by-design': 'nieaktywna',
  unknown: 'nieznana',
  installed: 'zainstalowana',
  enabled: 'włączona',
  expected: 'oczekiwana',
});

export const SERVICE_STATE_TONE = Object.freeze({
  running: 'ok',
  failed: 'danger',
  'inactive-by-design': 'muted',
  unknown: 'warn',
});

export const OBSERVED_STATUS = Object.freeze({
  OK: 'ok',
  WARN: 'warn',
  CRITICAL: 'critical',
  UNKNOWN: 'unknown',
  SKIPPED: 'skipped',
});

/** Web engine id (setting `web_server`) → service row name. */
export const WEB_ENGINE_SERVICES = Object.freeze({
  nginx: 'nginx',
  apache: 'httpd',
  openlitespeed: 'openlitespeed',
  litespeed: 'litespeed',
});

export const WEB_ENGINE_LABELS = Object.freeze({
  nginx: 'Nginx',
  apache: 'Apache',
  openlitespeed: 'OpenLiteSpeed',
  litespeed: 'LiteSpeed',
});

const WEB_SERVICE_ENGINE = Object.fromEntries(
  Object.entries(WEB_ENGINE_SERVICES).map(([engine, service]) => [service, engine]),
);

// Services the current configuration expects to run. Optional daemons are
// reported (running / inactive-by-design) but never inflate the dashboard
// numerator or denominator.
const CORE_SERVICES = new Set(['exim', 'dovecot', 'mysqld', 'bind', 'php-fpm', 'cron']);
const OPTIONAL_SERVICES = new Set(['proftpd', 'redis', 'clamav', 'rspamd', 'unit', 'netdata']);

export function isOptionalService(name) {
  return OPTIONAL_SERVICES.has(String(name));
}

export function isWebEngineService(name) {
  return Object.hasOwn(WEB_SERVICE_ENGINE, String(name));
}

/**
 * One IEC formatter for the whole panel. Base value is always bytes.
 * Invalid/unknown values return a visible placeholder, never `0 B`.
 */
export function formatBytesIEC(value, { unavailable = '—', decimals } = {}) {
  if (value === null || value === undefined || value === '') return unavailable;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return unavailable;
  if (n === 0) return '0 B';

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let index = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  let scaled = n / 1024 ** index;
  // Rounding 1023.99 KiB must not produce "1024 KiB"; promote it to MiB.
  if (index > 0 && index < units.length - 1 && Number(scaled.toFixed(2)) >= 1024) {
    index += 1;
    scaled = n / 1024 ** index;
  }
  if (index === 0) return `${Math.round(scaled)} B`;
  const digits = decimals ?? (scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2);
  let text = scaled.toFixed(digits);
  // Trim fraction zeros only: 1.50 → 1.5, but 460 must not become 46.
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return `${text} ${units[index]}`;
}

/** Backwards-friendly alias for presentation code that speaks "bytes". */
export const formatBytes = formatBytesIEC;

/**
 * Build one metric observation.
 *
 * @returns {{
 *   value: number|null, unit: string, source: string, timestamp: string|null,
 *   ageSeconds: number|null, status: 'fresh'|'stale'|'unavailable',
 *   available: boolean, reason: string|null
 * }}
 */
export function metricValue(value, {
  unit = METRIC_UNITS.BYTES,
  source = 'unknown',
  timestamp = null,
  staleAfterSeconds = 60,
  reason = null,
  now = Date.now(),
  status = null,
} = {}) {
  const numeric = value === null || value === undefined || value === ''
    ? null
    : (typeof value === 'number' ? value : Number(value));
  const measuredAt = timestamp === null || timestamp === undefined
    ? now
    : new Date(timestamp).getTime();
  const validTimestamp = Number.isFinite(measuredAt) ? new Date(measuredAt).toISOString() : null;

  if (!Number.isFinite(numeric) || numeric < 0 || !validTimestamp) {
    return {
      value: null,
      unit,
      source,
      timestamp: validTimestamp,
      ageSeconds: null,
      status: METRIC_STATUS.UNAVAILABLE,
      available: false,
      reason: reason || 'Brak danych źródłowych',
    };
  }

  const ageSeconds = Math.max(0, Math.round((now - measuredAt) / 1000));
  const freshness = status || (ageSeconds > staleAfterSeconds ? METRIC_STATUS.STALE : METRIC_STATUS.FRESH);
  return {
    value: numeric,
    unit,
    source,
    timestamp: validTimestamp,
    ageSeconds,
    status: freshness,
    available: true,
    reason: freshness === METRIC_STATUS.STALE
      ? (reason || `Pomiar starszy niż ${staleAfterSeconds} s`)
      : reason,
  };
}

export const makeMetric = metricValue;

function percentOf(used, total) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return Math.round((used / total) * 1000) / 10;
}

/**
 * One measurement service for host memory and filesystems. Values are bytes;
 * callers format them with `formatBytesIEC()` at the last moment.
 */
export class MetricsService {
  constructor({
    os: osImpl = os,
    statfs = fs.statfsSync,
    readFileSync = fs.readFileSync,
    existsSync = fs.existsSync,
    clock = () => new Date(),
    meminfoPath = '/proc/meminfo',
    staleAfterSeconds = 60,
  } = {}) {
    this.os = osImpl;
    this.statfs = statfs;
    this.readFileSync = readFileSync;
    this.existsSync = existsSync;
    this.clock = clock;
    this.meminfoPath = meminfoPath;
    this.staleAfterSeconds = staleAfterSeconds;
  }

  nowMs() {
    const value = this.clock();
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(ms) ? ms : Date.now();
  }

  nowIso() {
    return new Date(this.nowMs()).toISOString();
  }

  readMeminfo() {
    if (!this.meminfoPath || !this.existsSync(this.meminfoPath)) return null;
    let text;
    try {
      text = this.readFileSync(this.meminfoPath, 'utf8');
    } catch {
      return null;
    }
    const values = {};
    for (const line of String(text).split('\n')) {
      const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB\s*$/.exec(line);
      if (match) values[match[1]] = Number(match[2]) * 1024;
    }
    const total = values.MemTotal;
    if (!Number.isFinite(total) || total <= 0) return null;
    const available = Number.isFinite(values.MemAvailable)
      ? values.MemAvailable
      : (values.MemFree || 0) + (values.Buffers || 0) + (values.Cached || 0);
    return { total, available, source: `procfs:${this.meminfoPath}` };
  }

  /** Host memory in bytes. Unavailable measurements are null, never 0. */
  memory() {
    const timestamp = this.nowIso();
    const now = this.nowMs();
    try {
      let total = null;
      let available = null;
      let source = 'os';
      const meminfo = this.readMeminfo();
      if (meminfo) {
        total = meminfo.total;
        available = meminfo.available;
        source = meminfo.source;
      } else {
        total = Number(this.os.totalmem());
        available = Number(this.os.freemem());
        source = 'os.totalmem/freemem';
      }
      if (!Number.isFinite(total) || total <= 0) throw new Error('Nie można odczytać całkowitej pamięci');
      if (!Number.isFinite(available) || available < 0) throw new Error('Nie można odczytać wolnej pamięci');
      const boundedAvailable = Math.min(available, total);
      const used = Math.max(0, total - boundedAvailable);
      return {
        ...metricValue(used, {
          unit: METRIC_UNITS.BYTES,
          source,
          timestamp,
          now,
          staleAfterSeconds: this.staleAfterSeconds,
        }),
        usedBytes: used,
        totalBytes: total,
        availableBytes: boundedAvailable,
        freeBytes: boundedAvailable,
        percent: percentOf(used, total),
        kind: 'memory',
      };
    } catch (error) {
      return {
        ...metricValue(null, {
          unit: METRIC_UNITS.BYTES,
          source: 'os',
          timestamp,
          now,
          reason: error.message || 'Pamięć niedostępna',
        }),
        usedBytes: null,
        totalBytes: null,
        availableBytes: null,
        freeBytes: null,
        percent: null,
        kind: 'memory',
      };
    }
  }

  /** Filesystem usage in bytes for one mount point. */
  disk(mount = '/') {
    const target = String(mount || '/');
    const timestamp = this.nowIso();
    const now = this.nowMs();
    try {
      const stat = this.statfs(target);
      const blockSize = Number(stat?.bsize);
      const blocks = Number(stat?.blocks);
      const availableBlocks = Number(stat?.bavail);
      if (!Number.isFinite(blockSize) || blockSize <= 0 || !Number.isFinite(blocks) || blocks <= 0) {
        throw new Error(`Nie można odczytać rozmiaru systemu plików ${target}`);
      }
      if (!Number.isFinite(availableBlocks) || availableBlocks < 0) {
        throw new Error(`Nie można odczytać wolnego miejsca ${target}`);
      }
      const total = blocks * blockSize;
      const free = Math.min(total, availableBlocks * blockSize);
      const used = Math.max(0, total - free);
      return {
        ...metricValue(used, {
          unit: METRIC_UNITS.BYTES,
          source: `statfs:${target}`,
          timestamp,
          now,
          staleAfterSeconds: this.staleAfterSeconds,
        }),
        usedBytes: used,
        totalBytes: total,
        availableBytes: free,
        freeBytes: free,
        percent: percentOf(used, total),
        mount: target,
        kind: 'disk',
      };
    } catch (error) {
      return {
        ...metricValue(null, {
          unit: METRIC_UNITS.BYTES,
          source: `statfs:${target}`,
          timestamp,
          now,
          reason: error.code || error.message || 'Dysk niedostępny',
        }),
        usedBytes: null,
        totalBytes: null,
        availableBytes: null,
        freeBytes: null,
        percent: null,
        mount: target,
        kind: 'disk',
      };
    }
  }

  system({ mount = '/' } = {}) {
    return {
      memory: this.memory(),
      disk: this.disk(mount),
      generatedAt: this.nowIso(),
    };
  }
}

export function createMetricsService(options) {
  return new MetricsService(options);
}

/**
 * Classify one service row. `expected` is explicit for callers that know the
 * desired configuration; otherwise it is derived from the core service set and
 * the active web engine.
 */
export function classifyServiceState({
  name,
  storedStatus = null,
  liveStatus = null,
  installed = true,
  activeWebEngine = 'nginx',
  simulated = false,
  expected,
} = {}) {
  const serviceName = String(name || '');
  const engine = WEB_SERVICE_ENGINE[serviceName] || null;
  const activeService = WEB_ENGINE_SERVICES[activeWebEngine] || WEB_ENGINE_SERVICES.nginx;
  const activeLabel = WEB_ENGINE_LABELS[activeWebEngine] || WEB_ENGINE_LABELS.nginx;
  const isActiveWebService = serviceName === activeService;
  const expectedFlag = expected === undefined
    ? CORE_SERVICES.has(serviceName) || isActiveWebService
    : !!expected;
  const observedStatus = liveStatus || storedStatus || null;
  const hasObservation = observedStatus === 'running' || observedStatus === 'stopped';
  const isInstalled = installed !== false;
  const source = liveStatus ? 'provider' : storedStatus ? 'panel' : 'unknown';

  let state = SERVICE_STATE.UNKNOWN;
  let detail = 'Brak danych o stanie usługi';

  if (engine && !isActiveWebService) {
    state = SERVICE_STATE.INACTIVE_BY_DESIGN;
    detail = `Nieaktywny — wybrano ${activeLabel}`;
  } else if (!expectedFlag) {
    if (observedStatus === 'running') {
      state = SERVICE_STATE.RUNNING;
      detail = 'Usługa opcjonalna działa';
    } else {
      state = SERVICE_STATE.INACTIVE_BY_DESIGN;
      detail = 'Usługa opcjonalna — nieaktywna';
    }
  } else if (!isInstalled) {
    state = SERVICE_STATE.FAILED;
    detail = 'Usługa oczekiwana nie jest zainstalowana';
  } else if (!hasObservation) {
    state = SERVICE_STATE.UNKNOWN;
    detail = 'Brak danych o stanie usługi';
  } else if (observedStatus === 'running') {
    state = SERVICE_STATE.RUNNING;
    detail = simulated ? 'Działa (stan symulowany przez sandbox)' : 'Usługa działa';
  } else {
    state = SERVICE_STATE.FAILED;
    detail = 'Usługa oczekiwana nie działa';
  }

  return {
    name: serviceName,
    state,
    label: SERVICE_STATE_LABEL[state] || state,
    detail,
    expected: expectedFlag,
    installed: isInstalled,
    enabled: expectedFlag && isInstalled,
    running: state === SERVICE_STATE.RUNNING,
    failed: state === SERVICE_STATE.FAILED,
    unknown: state === SERVICE_STATE.UNKNOWN,
    inactiveByDesign: state === SERVICE_STATE.INACTIVE_BY_DESIGN,
    observedStatus,
    source,
    simulated: !!simulated,
    webEngine: engine,
    activeWebEngine,
  };
}

/**
 * Resolve live provider state for each persisted service row and classify it.
 * A provider that returns `{ status: null, simulated: true }` (sandbox) falls
 * back to the panel's stored state, exactly like the rest of the panel.
 */
export function serviceStateRows({
  rows = [],
  provider = null,
  statusFor = null,
  activeEngine = 'nginx',
} = {}) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    let live = null;
    try {
      if (typeof statusFor === 'function') live = statusFor(row.name);
      else if (provider && typeof provider.serviceStatus === 'function') live = provider.serviceStatus(row.name);
    } catch {
      live = null;
    }
    return {
      ...row,
      ...classifyServiceState({
        name: row.name,
        storedStatus: row.status || null,
        liveStatus: live?.status || null,
        installed: row.installed === undefined ? true : !!row.installed,
        activeWebEngine: activeEngine,
        simulated: !!live?.simulated,
      }),
    };
  });
}

/**
 * Counts used by the dashboard and health page. Alternates and optional
 * daemons are labelled but excluded from `expected`/`running`.
 */
export function summarizeServiceStates(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const expectedRows = list.filter((row) => row.expected);
  return {
    total: list.length,
    expected: expectedRows.length,
    running: expectedRows.filter((row) => row.state === SERVICE_STATE.RUNNING).length,
    failed: expectedRows.filter((row) => row.state === SERVICE_STATE.FAILED).length,
    unknown: expectedRows.filter((row) => row.state === SERVICE_STATE.UNKNOWN).length,
    inactiveByDesign: list.filter((row) => row.state === SERVICE_STATE.INACTIVE_BY_DESIGN).length,
    runningOptional: list.filter((row) => !row.expected && row.state === SERVICE_STATE.RUNNING).length,
  };
}

/**
 * Separate the execution of an automation job from the state it observed.
 * A successful job run is not a healthy subsystem: `mail.queue` with
 * `failed=9` is a successful execution that observed `critical`.
 */
export function deriveJobObservation({ key = '', status = 'unknown', output = '', error = '' } = {}) {
  const normalizedStatus = String(status || 'unknown');
  const executionStatus = {
    ok: 'success',
    warn: 'success',
    error: 'failed',
    skipped: 'skipped',
    unavailable: 'unavailable',
  }[normalizedStatus] || 'unknown';
  const text = `${output || ''}${error ? `\n${error}` : ''}`;
  let observedStatus = OBSERVED_STATUS.UNKNOWN;
  let reason = null;

  if (executionStatus === 'skipped') {
    observedStatus = OBSERVED_STATUS.SKIPPED;
  } else if (normalizedStatus === 'unavailable') {
    observedStatus = OBSERVED_STATUS.UNKNOWN;
    reason = error || output || 'Kontrola niedostępna';
  } else if (key === 'mail.queue') {
    const failed = Number(/failed=(\d+)/.exec(text)?.[1] || 0);
    const deferred = Number(/deferred=(\d+)/.exec(text)?.[1] || 0);
    if (failed > 0) {
      observedStatus = OBSERVED_STATUS.CRITICAL;
      reason = `${failed} nieudanych wiadomości w kolejce`;
    } else if (deferred > 0) {
      observedStatus = OBSERVED_STATUS.WARN;
      reason = `${deferred} wstrzymanych wiadomości w kolejce`;
    } else {
      observedStatus = OBSERVED_STATUS.OK;
    }
  } else if (key === 'health.check') {
    const health = /health=(ok|warn|fail)/.exec(text)?.[1];
    if (health === 'fail') {
      observedStatus = OBSERVED_STATUS.CRITICAL;
      reason = 'Raport zdrowia zgłasza błędy krytyczne';
    } else if (health === 'warn') {
      observedStatus = OBSERVED_STATUS.WARN;
      reason = 'Raport zdrowia zgłasza ostrzeżenia';
    } else if (health === 'ok') {
      observedStatus = OBSERVED_STATUS.OK;
    }
  } else if (key === 'disk.check') {
    if (/threshold crossed/i.test(text)) {
      observedStatus = OBSERVED_STATUS.WARN;
      reason = 'Przekroczono próg zajętości dysku';
    } else {
      observedStatus = OBSERVED_STATUS.OK;
    }
  } else if (executionStatus === 'failed') {
    observedStatus = OBSERVED_STATUS.CRITICAL;
    reason = error || output || 'Zadanie zakończyło się błędem';
  } else if (executionStatus === 'success') {
    observedStatus = OBSERVED_STATUS.OK;
  }

  return {
    key,
    executionStatus,
    observedStatus,
    critical: observedStatus === OBSERVED_STATUS.CRITICAL,
    reason,
  };
}

export function worstObservation(observations = []) {
  const list = Array.isArray(observations) ? observations : [];
  const rank = {
    [OBSERVED_STATUS.CRITICAL]: 4,
    [OBSERVED_STATUS.WARN]: 3,
    [OBSERVED_STATUS.UNKNOWN]: 2,
    [OBSERVED_STATUS.SKIPPED]: 1,
    [OBSERVED_STATUS.OK]: 0,
  };
  return list.reduce((worst, item) => (rank[item.observedStatus] ?? -1) > (rank[worst] ?? -1)
    ? item.observedStatus
    : worst, OBSERVED_STATUS.OK);
}
