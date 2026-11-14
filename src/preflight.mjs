// Typed preflight engine for destructive / privileged panel operations.
//
// A preflight never performs the operation and never "repairs" anything on its
// own. It returns one deterministic condition list that a route can render and
// that tests can assert:
//
//   { ok, code, label, detail, fixable, fixHint, blocking }
//
// `ok` means every condition passed. `blocked` means at least one blocking
// condition failed; non-blocking failures are warnings the operator may accept.
//
// Every environmental dependency is injectable (`options.deps`) so the engine
// can be tested without touching the host and so routes can pass a provider
// observation where a direct DB read would be stale.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns';
import { all, get, setting } from './db.mjs';
import { config } from './config.mjs';
import { userHome } from './paths.mjs';
import { formatBytesIEC } from './metrics.mjs';
import { findExecutable, detectArchiveKind } from './core/archive-utils.mjs';
import { uploadLimits, ensureJobSchema } from './backups.mjs';
import { listApps } from './appcatalog.mjs';
import { validateDomain, validateInstallPath } from './appcatalog.mjs';

const MiB = 1024 * 1024;

export const PREFLIGHT_KINDS = Object.freeze([
  'app-install',
  'ssl-issue',
  'backup',
  'restore',
  'web-engine',
  'import',
  'upload',
]);

export const PREFLIGHT_LABELS = Object.freeze({
  'app-install': 'Instalacja aplikacji',
  'ssl-issue': 'Wystawienie certyfikatu SSL',
  backup: 'Kopia zapasowa',
  restore: 'Odtworzenie kopii',
  'web-engine': 'Zmiana silnika WWW',
  import: 'Import danych',
  upload: 'Wysyłka pliku',
});

const NATIVE_APPS = new Set(['wordpress', 'nextcloud']);
const KNOWN_APPS = new Set([...NATIVE_APPS, ...listApps().map((app) => app.key)]);

function makeCheck(ok, code, label, detail = '', {
  fixable = false,
  fixHint = '',
  blocking = true,
} = {}) {
  return {
    ok: !!ok,
    code: String(code),
    label: String(label),
    detail: String(detail || ''),
    fixable: !ok && !!fixable,
    fixHint: !ok && fixHint ? String(fixHint) : '',
    blocking: blocking !== false,
  };
}

function normalizeInput(input) {
  return input && typeof input === 'object' ? input : {};
}

function safeBasename(value) {
  const name = path.basename(String(value || '').trim());
  if (!name || name === '.' || name === '..' || name.includes('\0')) return '';
  return name;
}

function defaultDeps() {
  return {
    platform: config.provider,
    dataDir: config.dataDir,
    now: () => new Date(),
    exists: (target) => {
      try { return fs.existsSync(target); } catch { return false; }
    },
    isFile: (target) => {
      try { return fs.statSync(target).isFile(); } catch { return false; }
    },
    isDirectory: (target) => {
      try { return fs.statSync(target).isDirectory(); } catch { return false; }
    },
    readable: (target) => {
      try { fs.accessSync(target, fs.constants.R_OK); return true; } catch { return false; }
    },
    writable: (target) => {
      try { fs.accessSync(target, fs.constants.W_OK); return true; } catch { return false; }
    },
    stat: (target) => {
      try { return fs.statSync(target); } catch { return null; }
    },
    readdir: (target) => {
      try { return fs.readdirSync(target); } catch { return []; }
    },
    freeBytes: (target) => {
      try {
        const stats = fs.statfsSync(target);
        const bsize = Number(stats?.bsize);
        const bavail = Number(stats?.bavail);
        if (!Number.isFinite(bsize) || bsize <= 0 || !Number.isFinite(bavail) || bavail < 0) return null;
        return bavail * bsize;
      } catch { return null; }
    },
    findExecutable,
    archiveKind: detectArchiveKind,
    tcpOpen: (port, host = '127.0.0.1', timeout = 600) => new Promise((resolve) => {
      const socket = net.connect({ port, host });
      let settled = false;
      const finish = (open) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch { /* ignore */ }
        resolve(open);
      };
      socket.setTimeout(timeout);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    }),
    resolve4: async (domain) => dns.promises.resolve4(domain),
    domain: (name) => get('SELECT id, name, username, docroot, status FROM domains WHERE name = ?', name),
    user: (username) => get('SELECT id, username, level, suspended FROM users WHERE username = ?', username),
    serviceStatus: (name) => {
      try {
        const row = get('SELECT name, status, enabled FROM services WHERE name = ?', name);
        if (!row) return { known: false, status: null, enabled: null };
        return { known: true, status: row.status, enabled: Number(row.enabled) === 1 };
      } catch (error) {
        return { known: false, status: null, enabled: null, error: error.message };
      }
    },
    dnsRecords: (domainId, type = 'A') => all('SELECT name, value FROM dns_records WHERE domain_id = ? AND type = ?', domainId, type),
    activeJobs: (prefixes = []) => {
      try {
        ensureJobSchema();
        const rows = all("SELECT id, kind, status, target, updated_at FROM operation_jobs WHERE status IN ('queued','running','cancelling') ORDER BY id DESC LIMIT 50");
        return rows.filter((row) => !prefixes.length || prefixes.some((prefix) => String(row.kind).startsWith(prefix)));
      } catch (error) {
        return { unavailable: true, error: error.message };
      }
    },
    importJobs: () => all("SELECT id, source, target, status FROM import_jobs WHERE status NOT IN ('complete','completed','failed','cancelled','error') ORDER BY id DESC LIMIT 20"),
    uptime: () => process.uptime(),
    uploadLimits,
    settings: (key, fallback = '') => setting(key, fallback),
    serverIp: () => String(setting('server_ip', config.defaults.serverIp) || '').trim(),
    engineInstalled: (engine) => {
      const bins = {
        nginx: ['nginx'],
        apache: ['apache2', 'httpd', 'apachectl'],
        openlitespeed: ['openlitespeed', 'lshttpd', 'lswsctrl'],
        litespeed: ['litespeed', 'lshttpd', 'lswsctrl'],
      }[engine] || [];
      return bins.some((name) => findExecutable(name));
    },
    generatedConfigs: () => {
      const dir = path.join(config.dataDir, 'webserver');
      try {
        const engines = fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isDirectory());
        return engines.reduce((sum, engine) => {
          try { return sum + fs.readdirSync(path.join(dir, engine, 'sites')).filter((name) => name.endsWith('.conf')).length; } catch { return sum; }
        }, 0);
      } catch { return 0; }
    },
    userHome,
    all,
    get,
  };
}

function mergeDeps(options = {}) {
  return { ...defaultDeps(), ...(options.deps || {}), now: options.now || options.deps?.now || defaultDeps().now };
}

function nearestExisting(d, target) {
  let current = path.resolve(String(target || '.'));
  for (let i = 0; i < 40; i += 1) {
    if (d.exists(current)) return current;
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return null;
}

function writableTarget(d, target) {
  const existing = nearestExisting(d, target);
  if (!existing) return { ok: false, checked: target, reason: 'Nie można znaleźć istniejącego katalogu nadrzędnego' };
  if (!d.isDirectory(existing)) return { ok: false, checked: existing, reason: `${existing} nie jest katalogiem` };
  if (!d.writable(existing)) return { ok: false, checked: existing, reason: `brak prawa zapisu do ${existing}` };
  return { ok: true, checked: existing, reason: '' };
}

function diskCheck(d, target, requiredBytes, { label = 'Wolne miejsce', code = 'DISK_SPACE', blocking = true } = {}) {
  const free = d.freeBytes(target);
  if (free === null || free === undefined) {
    return makeCheck(false, 'DISK_UNKNOWN', label,
      `Nie można odczytać wolnego miejsca dla ${target}`,
      { fixable: false, fixHint: 'Sprawdź uprawnienia do statfs lub użyj innej ścieżki.', blocking });
  }
  if (Number(requiredBytes) > 0 && free < Number(requiredBytes)) {
    return makeCheck(false, code, label,
      `Wymagane ${formatBytesIEC(requiredBytes)}, wolne ${formatBytesIEC(free)} na ${target}`,
      { fixable: true, fixHint: 'Zwolnij miejsce (stare kopie, logi) lub wskaż inny wolumen.', blocking });
  }
  return makeCheck(true, code, label,
    Number(requiredBytes) > 0 ? `Wolne ${formatBytesIEC(free)}; wymagane ${formatBytesIEC(requiredBytes)}` : `Wolne ${formatBytesIEC(free)}`,
    { blocking });
}

function binaryCheck(d, name, { code, label, fixHint, blocking = true, required = true } = {}) {
  const resolved = d.findExecutable(name);
  if (resolved) return makeCheck(true, code || `BINARY_${String(name).toUpperCase()}`, label || `Zależność: ${name}`, `Znaleziono ${resolved}`, { blocking });
  return makeCheck(false, code || `BINARY_${String(name).toUpperCase()}`, label || `Zależność: ${name}`,
    `Nie znaleziono programu ${name} w PATH`,
    {
      fixable: true,
      fixHint: fixHint || `Zainstaluj pakiet zawierający ${name} i upewnij się, że jest w PATH.`,
      blocking: required ? blocking : false,
    });
}

function domainCheck(d, rawDomain) {
  const value = String(rawDomain || '').trim().toLowerCase();
  if (!value) {
    return {
      check: makeCheck(false, 'DOMAIN_REQUIRED', 'Domena', 'Wybierz domenę, dla której ma zostać wykonana operacja.',
        { fixable: false, fixHint: 'Dodaj domenę w panelu lub wybierz istniejącą.' }),
      domain: null,
    };
  }
  const validation = validateDomain(value);
  if (!validation.ok) {
    return {
      check: makeCheck(false, 'DOMAIN_INVALID', 'Domena', validation.error,
        { fixable: true, fixHint: 'Popraw nazwę domeny (bez protokołu i ścieżki).' }),
      domain: null,
    };
  }
  const domain = d.domain(validation.value);
  if (!domain) {
    return {
      check: makeCheck(false, 'DOMAIN_NOT_FOUND', 'Domena istnieje w panelu', `Brak domeny ${validation.value} w bazie panelu.`,
        { fixable: true, fixHint: 'Dodaj domenę i DNS przed instalacją lub wystawieniem certyfikatu.' }),
      domain: null,
    };
  }
  return {
    check: makeCheck(true, 'DOMAIN_OK', 'Domena istnieje w panelu', `${domain.name} · właściciel ${domain.username}`),
    domain,
  };
}

/**
 * Run one typed preflight. Never mutates application data; the only writes are
 * idempotent schema initialisation performed by the DB helper.
 *
 * @returns {Promise<{kind:string, ok:boolean, blocked:boolean, checks:Array, failed:number, checkedAt:string}>}
 */
export async function runPreflight(kind, input = {}, options = {}) {
  const d = mergeDeps(options);
  const normalizedKind = String(kind || '');
  const data = normalizeInput(input);
  const checks = [];
  const estimates = { diskRequiredBytes: null, downtimeSeconds: null, notes: [] };
  const add = (check) => checks.push(check);

  if (!PREFLIGHT_KINDS.includes(normalizedKind)) {
    add(makeCheck(false, 'UNKNOWN_KIND', 'Rodzaj operacji', `Nieznany preflight: ${normalizedKind || '(brak)'}`,
      { fixable: false, fixHint: `Dostępne rodzaje: ${PREFLIGHT_KINDS.join(', ')}` }));
  } else if (normalizedKind === 'app-install') {
    await preflightAppInstall(d, data, add, estimates);
  } else if (normalizedKind === 'ssl-issue') {
    await preflightSsl(d, data, add, estimates);
  } else if (normalizedKind === 'backup') {
    preflightBackup(d, data, add, estimates);
  } else if (normalizedKind === 'restore') {
    preflightRestore(d, data, add, estimates);
  } else if (normalizedKind === 'web-engine') {
    await preflightWebEngine(d, data, add, estimates);
  } else if (normalizedKind === 'import') {
    await preflightImport(d, data, add, estimates);
  } else if (normalizedKind === 'upload') {
    preflightUpload(d, data, add, estimates);
  }

  const failed = checks.filter((check) => !check.ok).length;
  const blocked = checks.some((check) => !check.ok && check.blocking);
  return {
    kind: normalizedKind,
    ok: failed === 0,
    blocked,
    failed,
    checks,
    estimates,
    checkedAt: d.now().toISOString(),
    input: sanitizeInput(normalizedKind, data),
  };
}

function sanitizeInput(kind, input) {
  const common = {
    kind,
    domain: input.domain ? String(input.domain).slice(0, 253) : undefined,
    path: input.path ? String(input.path).slice(0, 240) : undefined,
    username: input.username ? String(input.username).slice(0, 64) : undefined,
  };
  if (kind === 'upload') {
    return {
      ...common,
      filename: input.filename ? safeBasename(input.filename).slice(0, 200) : undefined,
      size: Number.isFinite(Number(input.size)) ? Number(input.size) : undefined,
      encoding: input.encoding ? String(input.encoding).slice(0, 20) : undefined,
    };
  }
  return common;
}

async function preflightAppInstall(d, input, add, estimates) {
  const app = String(input.app || '').trim().toLowerCase();
  add(app
    ? makeCheck(KNOWN_APPS.has(app), 'APP_KNOWN', 'Aplikacja jest obsługiwana',
      KNOWN_APPS.has(app) ? `Instalator: ${app}` : `Katalog nie zawiera aplikacji ${app}`,
      { fixable: true, fixHint: 'Wybierz aplikację z katalogu: WordPress, Nextcloud, Joomla, Drupal, PrestaShop, Moodle.' })
    : makeCheck(false, 'APP_REQUIRED', 'Aplikacja', 'Nie wybrano aplikacji.', { fixable: false }));

  const { check: domainCondition, domain } = domainCheck(d, input.domain);
  add(domainCondition);

  const pathResult = validateInstallPath(input.path ?? '/');
  add(pathResult.ok
    ? makeCheck(true, 'PATH_VALID', 'Ścieżka instalacji', `Ścieżka ${pathResult.value}`)
    : makeCheck(false, 'PATH_INVALID', 'Ścieżka instalacji', pathResult.error, { fixable: true, fixHint: 'Użyj ścieżki względnej, np. /sklep, bez „..”.' }));

  if (domain) {
    const home = d.userHome(domain.username);
    const docroot = path.join(home, 'domains', domain.name, 'public_html');
    const target = pathResult.ok && pathResult.value !== '/'
      ? path.join(docroot, pathResult.value.replace(/^\/+/, ''))
      : docroot;
    const writable = writableTarget(d, target);
    add(makeCheck(writable.ok, 'DOCROOT_WRITABLE', 'Katalog docelowy jest zapisywalny',
      writable.ok ? `Zapis do ${writable.checked}` : `${writable.checked || target}: ${writable.reason}`,
      { fixable: true, fixHint: `Utwórz katalog i nadaj właściciela ${domain.username}.` }));
    const homeExists = d.exists(home);
    add(makeCheck(homeExists, 'HOME_EXISTS', 'Katalog domowy konta istnieje',
      homeExists ? home : `Brak ${home} — konto nie ma jeszcze katalogu domowego.`,
      { fixable: true, fixHint: 'Uruchom provisioning konta lub utwórz katalog domowy.' }));
  }

  add(binaryCheck(d, 'php', {
    code: 'PHP_CLI',
    label: 'PHP CLI',
    fixHint: 'Zainstaluj PHP CLI (php-cli) — instalatory CMS uruchamiają skrypty PHP.',
  }));

  const db = d.serviceStatus('mysqld');
  if (!db.known) {
    add(makeCheck(false, 'DB_SERVICE_UNKNOWN', 'Usługa bazy danych', 'Brak zapisanego stanu usługi mysqld.', {
      blocking: false, fixable: true, fixHint: 'Sprawdź MariaDB w System Services i odśwież stan.',
    }));
  } else {
    add(makeCheck(db.status === 'running', 'DB_SERVICE', 'Usługa bazy danych działa',
      db.status === 'running' ? 'mysqld: running' : `mysqld: ${db.status}`,
      { fixable: true, fixHint: 'Uruchom MariaDB przed instalacją aplikacji.' }));
  }

  const setupComplete = String(d.settings('setup_complete', '0')) === '1';
  add(makeCheck(setupComplete, 'PANEL_SETUP', 'Konfiguracja panelu zakończona',
    setupComplete ? 'setup_complete=1' : 'Kreator konfiguracji nie został zakończony.',
    { blocking: false, fixable: true, fixHint: 'Dokończ kreator konfiguracji (IP, DNS, WWW).' }));

  const appPort = 80;
  const httpOpen = await d.tcpOpen(appPort, '127.0.0.1', 500);
  add(makeCheck(httpOpen, 'WEB_PORT', 'Port HTTP nasłuchuje',
    httpOpen ? '127.0.0.1:80 otwarte' : '127.0.0.1:80 zamknięte — vhost nie będzie dostępny po instalacji.',
    { blocking: false, fixable: true, fixHint: 'Uruchom wybrany silnik WWW przed instalacją.' }));

  const estimate = Math.max(64, Number(input.estimateMb) || 512) * MiB;
  estimates.diskRequiredBytes = estimate;
  estimates.downtimeSeconds = 0;
  estimates.notes.push('Instalacja aplikacji nie wymaga przerwy w działaniu innych stron; backup przed instalacją nadal zalecany.');
  add(diskCheck(d, d.dataDir, estimate, { label: 'Miejsce na pakiet i bazę', requiredBytes: estimate }));

  add(jobsCheck(d, ['backup.restore', 'upload.'], 'Brak aktywnego restore/upload'));
  const configWritable = writableTarget(d, d.dataDir);
  add(makeCheck(configWritable.ok, 'CONFIG_WRITABLE', 'Katalog danych panelu jest zapisywalny',
    configWritable.ok ? configWritable.checked : `${configWritable.checked}: ${configWritable.reason}`,
    { fixable: true, fixHint: 'Napraw uprawnienia katalogu danych panelu.' }));
}

async function preflightSsl(d, input, add, estimates) {
  const { check: domainCondition, domain } = domainCheck(d, input.domain);
  add(domainCondition);

  if (domain) {
    const records = d.dnsRecords(domain.id, 'A') || [];
    const expected = d.serverIp();
    const values = records.map((row) => String(row.value).trim());
    add(expected
      ? makeCheck(values.includes(expected), 'DNS_ZONE_A', 'Strefa DNS wskazuje serwer',
        values.length ? `A: ${values.join(', ')} · oczekiwano ${expected}` : `Brak rekordu A dla ${domain.name} w panelu`,
        { fixable: true, fixHint: 'Dodaj/rekord A @ wskazujący na IP serwera przed ACME HTTP-01.' })
      : makeCheck(false, 'SERVER_IP_MISSING', 'Adres IP serwera', 'Brak ustawienia server_ip.', { fixable: true, fixHint: 'Ustaw adres IP serwera w konfiguracji panelu.' }));

    if (expected) {
      let publicAnswers = [];
      let resolveError = '';
      try {
        publicAnswers = await d.resolve4(domain.name);
      } catch (error) {
        resolveError = error.code || error.message;
      }
      add(makeCheck(publicAnswers.includes(expected), 'DNS_PUBLIC_A', 'Publiczny DNS wskazuje serwer',
        publicAnswers.length
          ? `Publiczne A: ${publicAnswers.join(', ')} · oczekiwano ${expected}`
          : `Nie udało się potwierdzić publicznego A (${resolveError || 'brak odpowiedzi'})`,
        {
          fixable: true,
          fixHint: 'Sprawdź delegację domeny i propagację DNS; ACME HTTP-01 wymaga publicznego adresu.',
        }));
    }
  }

  const port80 = await d.tcpOpen(80, '127.0.0.1', 700);
  add(makeCheck(port80, 'PORT_80', 'Port 80 nasłuchuje lokalnie',
    port80 ? '127.0.0.1:80 otwarte' : '127.0.0.1:80 zamknięte — ACME HTTP-01 nie przejdzie.',
    { fixable: true, fixHint: 'Uruchom serwer WWW lub otwórz port 80 dla walidacji ACME.' }));

  add(binaryCheck(d, 'certbot', {
    code: 'CERTBOT',
    label: 'Klient ACME (certbot)',
    fixHint: 'Zainstaluj certbot lub użyj wbudowanego generatora self-signed (bez zaufania publicznego).',
  }));

  if (domain) {
    const docroot = path.join(d.userHome(domain.username), 'domains', domain.name, 'public_html');
    const exists = d.exists(docroot);
    const writable = exists ? d.writable(docroot) : false;
    add(makeCheck(exists && writable, 'WEBROOT', 'Webroot jest zapisywalny',
      exists ? (writable ? docroot : `${docroot}: brak prawa zapisu`) : `Brak ${docroot}`,
      { fixable: true, fixHint: 'Utwórz public_html i nadaj właściciela kontu domeny.' }));
  }

  estimates.diskRequiredBytes = 64 * MiB;
  estimates.downtimeSeconds = 0;
  estimates.notes.push('Wystawienie certyfikatu nie powinno wymagać przerwy; reload serwera WWW może być chwilowy.');
  add(diskCheck(d, d.dataDir, 64 * MiB, { label: 'Miejsce na certyfikat i logi' }));
  add(jobsCheck(d, ['backup.restore'], 'Brak aktywnego restore'));
}

function preflightBackup(d, input, add, estimates) {
  const dir = path.join(d.dataDir, 'backups');
  const writable = writableTarget(d, dir);
  add(makeCheck(writable.ok, 'BACKUP_DIR_WRITABLE', 'Katalog kopii jest zapisywalny',
    writable.ok ? writable.checked : `${writable.checked || dir}: ${writable.reason}`,
    { fixable: true, fixHint: 'Utwórz katalog backups i nadaj prawo zapisu użytkownikowi panelu.' }));

  add(binaryCheck(d, 'tar', {
    code: 'TAR',
    label: 'Archiwizator tar',
    fixHint: 'Zainstaluj tar — panel używa go do tworzenia i sprawdzania archiwów.',
  }));

  const estimate = Math.max(64, Number(input.estimateMb) || 2048) * MiB;
  estimates.diskRequiredBytes = estimate;
  estimates.downtimeSeconds = 0;
  estimates.notes.push('Kopia działa w tle; nie wymaga przerwy, ale może obciążać I/O.');
  add(diskCheck(d, d.dataDir, estimate, { label: 'Miejsce na kopię', requiredBytes: estimate }));

  let dbOk = false;
  let dbError = '';
  try {
    const row = d.get('SELECT 1 AS ok');
    dbOk = Number(row?.ok) === 1;
  } catch (error) {
    dbError = error.message;
  }
  add(makeCheck(dbOk, 'DB_READ', 'Baza panelu odpowiada', dbOk ? 'SELECT 1 → 1' : `Błąd bazy: ${dbError}`,
    { fixable: false, fixHint: 'Sprawdź integralność bazy panelu przed wykonaniem kopii.' }));

  const enabled = String(d.settings('backup_enabled', '1')) === '1';
  add(makeCheck(enabled, 'BACKUP_ENABLED', 'Harmonogram kopii włączony',
    enabled ? 'backup_enabled=1' : 'backup_enabled=0 — kopia ręczna nadal możliwa.',
    { blocking: false, fixable: true, fixHint: 'Włącz harmonogram w Backup Center, aby kopie powstawały automatycznie.' }));

  add(jobsCheck(d, ['backup.create', 'backup.job.run'], 'Brak innej kopii w toku'));
}

function preflightRestore(d, input, add, estimates) {
  const filename = safeBasename(input.filename || input.archive || '');
  add(filename
    ? makeCheck(true, 'ARCHIVE_NAME', 'Nazwa archiwum', filename)
    : makeCheck(false, 'ARCHIVE_NAME', 'Nazwa archiwum', 'Nie podano nazwy archiwum.', { fixable: false }));

  const archivePath = filename
    ? (path.isAbsolute(String(input.archive || '')) ? String(input.archive) : path.join(d.dataDir, 'backups', filename))
    : '';
  const stat = archivePath ? d.stat(archivePath) : null;
  const isFile = typeof stat?.isFile === 'function' ? stat.isFile() : !!stat?.isFile;
  const archiveOk = isFile && stat.size > 0 && d.readable(archivePath);
  add(makeCheck(archiveOk, 'ARCHIVE_EXISTS', 'Archiwum istnieje i jest czytelne',
    archiveOk
      ? `${archivePath} · ${formatBytesIEC(stat.size)}`
      : `${archivePath || '(brak)'} — plik nie istnieje, jest pusty lub bez prawa odczytu.`,
    { fixable: true, fixHint: 'Wgraj archiwum do katalogu backups lub wskaż prawidłową nazwę.' }));

  const required = archiveOk ? Math.max(128 * MiB, Math.ceil(stat.size * 2)) : 128 * MiB;
  estimates.diskRequiredBytes = required;
  estimates.downtimeSeconds = 60;
  estimates.notes.push('Restore jest operacją okna serwisowego; panel wykonuje punkt powrotu i staging.');
  add(diskCheck(d, d.dataDir, required, { label: 'Miejsce na staging i punkt powrotu', requiredBytes: required }));

  const staging = writableTarget(d, d.dataDir);
  add(makeCheck(staging.ok, 'STAGING_WRITABLE', 'Katalog staging jest zapisywalny',
    staging.ok ? staging.checked : `${staging.checked}: ${staging.reason}`,
    { fixable: true, fixHint: 'Napraw uprawnienia katalogu danych panelu.' }));

  if (input.username) {
    const user = d.user(String(input.username));
    add(makeCheck(!!user, 'TARGET_USER', 'Konto docelowe istnieje',
      user ? `${user.username} (${user.level})` : `Brak konta ${input.username}`,
      { fixable: true, fixHint: 'Wybierz istniejące konto lub odtwórz kopię na poziomie serwera.' }));
  } else {
    add(makeCheck(true, 'TARGET_SCOPE', 'Zakres odtworzenia', 'Restore serwera — konto docelowe nie jest wymagane.'));
  }

  const active = d.activeJobs(['backup.restore']);
  add(jobsCondition(active, 'Brak innego restore w toku', 'Poczekaj na zakończenie lub anuluj istniejący restore przed rozpoczęciem nowego.'));
}

async function preflightWebEngine(d, input, add, estimates) {
  const engine = String(input.engine || d.settings('web_server', 'nginx')).trim().toLowerCase();
  const supported = ['nginx', 'apache', 'openlitespeed', 'litespeed'].includes(engine);
  add(makeCheck(supported, 'ENGINE_SUPPORTED', 'Silnik jest obsługiwany',
    supported ? engine : `Nieznany silnik: ${engine}`,
    { fixable: true, fixHint: 'Wybierz nginx, apache, openlitespeed lub litespeed.' }));

  const sandbox = String(d.platform) !== 'linux';
  if (supported) {
    const installed = d.engineInstalled(engine);
    add(makeCheck(installed, 'ENGINE_INSTALLED', 'Silnik jest zainstalowany',
      installed ? 'Znaleziono binarkę silnika' : `Brak binarki ${engine} w PATH${sandbox ? ' (sandbox — instalacja symulowana)' : ''}`,
      {
        blocking: !sandbox,
        fixable: true,
        fixHint: sandbox ? 'Tryb sandbox nie instaluje pakietów hosta.' : 'Zainstaluj silnik WWW przed przełączeniem.',
      }));
  }

  const port80 = await d.tcpOpen(80, '127.0.0.1', 600);
  add(makeCheck(port80, 'PORT_80', 'Port 80 jest zwolniony/nasłuchuje',
    port80 ? '127.0.0.1:80 odpowiada' : '127.0.0.1:80 nie nasłuchuje — po przełączeniu strony będą niedostępne.',
    { fixable: true, fixHint: 'Sprawdź, który proces zajmuje port 80, i zaplanuj krótkie okno przełączenia.' }));

  const port443 = await d.tcpOpen(443, '127.0.0.1', 500);
  add(makeCheck(port443, 'PORT_443', 'Port 443 (HTTPS)',
    port443 ? '127.0.0.1:443 nasłuchuje' : '127.0.0.1:443 nie nasłuchuje — HTTPS może wymagać ponownego wdrożenia certyfikatów.',
    { blocking: false, fixable: true, fixHint: 'Po przełączeniu wdróż vhosty i certyfikaty SSL.' }));

  const php = d.serviceStatus('php-fpm');
  add(makeCheck(php.known && php.status === 'running', 'PHP_FPM', 'PHP-FPM działa',
    php.known ? `php-fpm: ${php.status}` : 'Brak zapisanego stanu php-fpm.',
    { blocking: false, fixable: true, fixHint: 'Sprawdź PHP / Web Stack przed zmianą silnika.' }));

  const configs = Number(d.generatedConfigs()) || 0;
  add(makeCheck(configs > 0, 'VHOSTS_GENERATED', 'Istnieją wygenerowane vhosty',
    configs ? `${configs} plików konfiguracji` : 'Brak wygenerowanych vhostów — po zmianie silnika wygeneruj konfigurację.',
    { blocking: false, fixable: true, fixHint: 'Uruchom generowanie vhostów w Web Server.' }));

  const cfgWritable = writableTarget(d, d.dataDir);
  add(makeCheck(cfgWritable.ok, 'CONFIG_WRITABLE', 'Konfiguracja panelu jest zapisywalna',
    cfgWritable.ok ? cfgWritable.checked : `${cfgWritable.checked}: ${cfgWritable.reason}`,
    { fixable: true, fixHint: 'Napraw uprawnienia katalogu danych panelu.' }));

  estimates.diskRequiredBytes = 256 * MiB;
  estimates.downtimeSeconds = 60;
  estimates.notes.push('Przełączenie silnika WWW wymaga krótkiego reloadu; zaplanuj okno serwisowe.');
  add(diskCheck(d, d.dataDir, 256 * MiB, { label: 'Miejsce na rollback konfiguracji' }));
  add(jobsCheck(d, ['backup.restore', 'update.panel'], 'Brak restore/aktualizacji w toku'));
}

async function preflightImport(d, input, add, estimates) {
  const source = String(input.source || '').trim();
  const exists = source ? d.exists(source) : false;
  const isFile = exists ? d.isFile(source) : false;
  const isDir = exists ? d.isDirectory(source) : false;
  add(makeCheck(exists && (isFile || isDir), 'SOURCE_EXISTS', 'Źródło importu istnieje',
    exists ? `${source} (${isFile ? 'plik' : 'katalog'})` : `Brak ścieżki ${source || '(brak)'}`,
    { fixable: true, fixHint: 'Wskaż archiwum kopii lub katalog danych do importu.' }));

  if (isFile) {
    let kind = null;
    try { kind = d.archiveKind(source); } catch { kind = null; }
    add(makeCheck(!!kind, 'ARCHIVE_KIND', 'Format archiwum jest rozpoznany',
      kind ? `Format: ${kind}` : 'Nie udało się rozpoznać archiwum (oczekiwano zip/tar.gz).',
      { fixable: true, fixHint: 'Użyj archiwum .zip, .tar, .tar.gz lub .tgz.' }));
    if (kind === 'tar') {
      add(binaryCheck(d, 'tar', {
        code: 'TAR', label: 'Archiwizator tar', fixHint: 'Zainstaluj tar do rozpakowania archiwum importu.',
      }));
    }
  }

  if (input.username) {
    const user = d.user(String(input.username));
    add(makeCheck(!!user, 'TARGET_USER', 'Konto docelowe istnieje',
      user ? `${user.username} (${user.level})` : `Brak konta ${input.username}`,
      { fixable: true, fixHint: 'Utwórz konto docelowe lub wybierz import serwera.' }));
  }
  if (input.domain) {
    const { check } = domainCheck(d, input.domain);
    add(check);
  }

  const mode = String(input.mode || 'file');
  const estimate = Math.max(64, Number(input.estimateMb) || 1024) * MiB;
  estimates.diskRequiredBytes = estimate;
  estimates.downtimeSeconds = mode === 'live' ? 30 : 0;
  estimates.notes.push('Import zapisuje dane w tle; przerwa zależy od trybu i zakresu.');
  add(diskCheck(d, d.dataDir, estimate, { label: 'Miejsce na import', requiredBytes: estimate }));

  const tmp = writableTarget(d, d.dataDir);
  add(makeCheck(tmp.ok, 'TMP_WRITABLE', 'Katalog tymczasowy jest zapisywalny',
    tmp.ok ? tmp.checked : `${tmp.checked}: ${tmp.reason}`,
    { fixable: true, fixHint: 'Napraw uprawnienia katalogu danych panelu.' }));

  if (mode === 'live') {
    add(binaryCheck(d, 'sshpass', {
      code: 'SSHPASS', label: 'sshpass (transfer live)',
      fixHint: 'Zainstaluj sshpass dla importu live lub użyj importu z pliku.',
    }));
    add(binaryCheck(d, 'rsync', {
      code: 'RSYNC', label: 'rsync (transfer live)',
      blocking: false,
      fixHint: 'Zainstaluj rsync dla transferu live.',
    }));
  }

  add(jobsCheck(d, ['backup.restore', 'import.'], 'Brak innego importu/restore w toku'));

  let importJobs = [];
  try {
    importJobs = d.importJobs() || [];
  } catch (error) {
    add(makeCheck(false, 'IMPORT_JOBS_UNKNOWN', 'Aktywne importy', `Nie można odczytać import_jobs: ${error.message}`,
      { blocking: false, fixable: true, fixHint: 'Sprawdź tabelę import_jobs i historię importów.' }));
  }
  if (importJobs.length && !(importJobs.unavailable)) {
    add(makeCheck(false, 'IMPORT_RUNNING', 'Brak aktywnego importu',
      `Aktywne importy: ${importJobs.map((row) => `#${row.id} ${row.status}`).join(', ')}`,
      { fixable: true, fixHint: 'Poczekaj na zakończenie aktywnego importu.' }));
  }
}

function preflightUpload(d, input, add, estimates) {
  const filename = safeBasename(input.filename || '');
  add(filename
    ? makeCheck(true, 'FILENAME_SAFE', 'Nazwa pliku jest bezpieczna', filename)
    : makeCheck(false, 'FILENAME_SAFE', 'Nazwa pliku jest bezpieczna', 'Nie podano prawidłowej nazwy pliku.',
      { fixable: true, fixHint: 'Podaj nazwę pliku bez ścieżek i znaków sterujących.' }));

  const size = Number(input.size);
  add(Number.isFinite(size) && size >= 0
    ? makeCheck(true, 'SIZE_VALID', 'Rozmiar pliku jest znany', formatBytesIEC(size))
    : makeCheck(false, 'SIZE_REQUIRED', 'Rozmiar pliku jest znany', 'Rozmiar pliku jest wymagany przed wysyłką.',
      { fixable: true, fixHint: 'Odczytaj rozmiar pliku po stronie klienta i wyślij go w preflight.' }));

  const limits = d.uploadLimits();
  if (Number.isFinite(size) && size >= 0) {
    add(makeCheck(size <= limits.maxBytes, 'UPLOAD_LIMIT', 'Mieści się w limicie panelu',
      `${formatBytesIEC(size)} z ${formatBytesIEC(limits.maxBytes)} (maxUploadMb=${limits.maxUploadMb})`,
      {
        fixable: true,
        fixHint: `Zmniejsz plik lub zwiększ OA_MAX_UPLOAD_MB (obecnie ${limits.maxUploadMb} MB).`,
      }));
  }

  const encoding = String(input.encoding || 'base64');
  add(makeCheck(encoding === 'base64', 'UPLOAD_ENCODING', 'Kodowanie żądania jest obsługiwane',
    encoding === 'base64' ? 'base64-json (obecny kontrakt panelu)' : `Nieobsługiwane kodowanie: ${encoding}.`,
    { fixable: true, fixHint: 'Obecny endpoint przyjmuje base64 JSON; multipart nie jest jeszcze wdrożony.' }));

  if (filename && Number.isFinite(size) && size >= 0 && encoding === 'base64') {
    const bodyBytes = Math.ceil(size / 3) * 4;
    add(makeCheck(bodyBytes <= limits.maxJsonBodyBytes, 'UPLOAD_BODY_LIMIT', 'Body JSON mieści się w limicie',
      `body ${formatBytesIEC(bodyBytes)} z ${formatBytesIEC(limits.maxJsonBodyBytes)}`,
      { fixable: true, fixHint: 'Zmniejsz plik lub zwiększ limit uploadu — kodowanie base64 powiększa body o ok. 33%.' }));
    add(diskCheck(d, d.dataDir, size + 64 * MiB, { label: 'Miejsce na zapis pliku', code: 'UPLOAD_DISK' }));
  }

  const tmp = writableTarget(d, d.dataDir);
  add(makeCheck(tmp.ok, 'TMP_WRITABLE', 'Katalog tymczasowy jest zapisywalny',
    tmp.ok ? tmp.checked : `${tmp.checked}: ${tmp.reason}`,
    { fixable: true, fixHint: 'Napraw uprawnienia katalogu danych panelu.' }));

  if (Number.isFinite(size) && size >= 0) {
    estimates.diskRequiredBytes = size + 64 * MiB;
    estimates.downtimeSeconds = 0;
    estimates.notes.push('Wysyłka nie wymaga przerwy; plik jest zapisywany przez job.');
  }
  add(jobsCheck(d, ['upload.store'], 'Brak innej wysyłki w toku', 'Poczekaj na zakończenie aktywnej wysyłki.', { blocking: false }));
}

function jobsCondition(active, label, fixHint, { blocking = true } = {}) {
  if (!Array.isArray(active)) {
    return makeCheck(false, 'JOBS_UNKNOWN', label,
      `Nie można odczytać aktywnych zadań: ${active?.error || 'nieznany błąd'}`,
      { blocking: false, fixable: true, fixHint: 'Sprawdź kolejkę zadań (operation_jobs).' });
  }
  if (!active.length) return makeCheck(true, 'ACTIVE_JOBS', label, 'Brak konfliktujących zadań');
  return makeCheck(false, 'ACTIVE_JOBS', label,
    active.map((job) => `#${job.id} ${job.kind} (${job.status})`).join(', '),
    { fixable: true, fixHint, blocking });
}

function jobsCheck(d, prefixes, label, fixHint = 'Poczekaj na zakończenie aktywnego zadania.', options = {}) {
  return jobsCondition(d.activeJobs(prefixes), label, fixHint, options);
}

/** Small helper used by routes/UI: summary of one preflight result. */
export function preflightSummary(result) {
  if (!result || !Array.isArray(result.checks)) {
    return { ok: false, blocked: true, failed: 0, label: 'Brak wyniku preflight', checks: [] };
  }
  return {
    ok: !!result.ok,
    blocked: !!result.blocked,
    failed: Number(result.failed) || result.checks.filter((check) => !check.ok).length,
    label: result.blocked ? 'Zablokowane' : result.ok ? 'Gotowe' : 'Ostrzeżenia',
    checks: result.checks,
  };
}
