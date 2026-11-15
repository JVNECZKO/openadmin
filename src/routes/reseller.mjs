// Reseller-level routes: control-center dashboard, customers, domains, apps,
// DNS, statistics, tickets, IPs, backups and settings.
import crypto from 'node:crypto';
import { all, get, run, nowIso, setting, audit } from '../db.mjs';
import { limitsFor, serializeCookie } from '../auth.mjs';
import { config } from '../config.mjs';
import { startImpersonation } from '../secrets.mjs';
import { previewActorCookie } from '../apps.mjs';
import { html as h, raw, formatBytes, pct } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, btn, badge, alert, emptyState, kvList, progress, statCard, sparkline } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { domainSelect } from '../ui/pages/list.mjs';
import { countForNav, visibleUsers, visibleDomains, canManageUser, domainFor } from '../core/access.mjs';
import { usersPage, userForm, createUser, updateUser, userDetailPage, toggleSuspend, deleteUser, packagesPage, packageForm, savePackage } from '../features/user-admin.mjs';
import { rebuildZone } from '../dns.mjs';
import { apply, applyStatus } from '../apply.mjs';
import { appIcon, appName } from '../ui/appicons.mjs';
import { listApps, installApp } from '../appcatalog.mjs';
import { installWordPress } from '../wordpress.mjs';
import { installNextcloud } from '../nextcloud.mjs';
import { backupSettings } from '../scheduler.mjs';
import { usageMeta } from '../usage.mjs';

const R = '/reseller';

/* ------------------------------------------------------------------ catalogue */

const APP_CATALOG = [
  { key: 'wordpress', name: 'WordPress', desc: 'Strona, blog lub sklep', version: 'najnowsza', installer: 'natywny instalator', defaultPath: '/', note: 'Wymaga PHP CLI i MariaDB. Adres panelu: /wp-admin/' },
  { key: 'nextcloud', name: 'Nextcloud', desc: 'Prywatna chmura plików i współpraca', version: 'najnowsza', installer: 'natywny instalator', defaultPath: '/', note: 'Nextcloud instaluj w katalogu głównym osobnej domeny.' },
  ...listApps().map((a) => ({
    key: a.key,
    name: a.name,
    desc: a.description,
    version: a.version,
    installer: a.mode === 'cli' ? 'CLI + instalator WWW' : 'instalator WWW',
    defaultPath: `/${a.key}`,
    note: a.mode === 'cli' ? 'Najpierw próbuje instalatora CLI; w razie błędu kończy w przeglądarce.' : 'Baza i pliki są przygotowywane, a instalację kończysz w przeglądarce.',
  })),
];
const APP_BY_KEY = new Map(APP_CATALOG.map((a) => [a.key, a]));
const CATALOG_TYPES = new Set(['nextcloud', 'joomla', 'drupal', 'prestashop', 'moodle']);

/* --------------------------------------------------------------- formatting */

function plural(value, one, few, many) {
  const n = Math.abs(Number(value) || 0);
  if (n === 1) return one;
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function datePl(iso, { time = false } = {}) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('pl-PL', {
    year: 'numeric', month: 'short', day: '2-digit',
    ...(time ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

function relTime(iso) {
  if (!iso) return 'brak aktywności';
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return String(iso);
  const delta = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return 'przed chwilą';
  if (minutes < 60) return `${minutes} ${plural(minutes, 'minutę', 'minuty', 'minut')} temu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${plural(hours, 'godzinę', 'godziny', 'godzin')} temu`;
  const days = Math.floor(hours / 24);
  if (days < 31) return `${days} ${plural(days, 'dzień', 'dni', 'dni')} temu`;
  return datePl(iso);
}

function healthFor(used, limit) {
  const total = Number(limit) || 0;
  if (!total) return { tone: 'muted', text: 'bez limitu', percent: 0 };
  const percent = Math.min(100, pct(used, total));
  if (percent >= 100) return { tone: 'danger', text: 'limit osiągnięty', percent };
  if (percent >= 90) return { tone: 'danger', text: `${percent}% limitu`, percent };
  if (percent >= 75) return { tone: 'warn', text: `${percent}% limitu`, percent };
  return { tone: 'ok', text: 'w normie', percent };
}

function statTone(health) {
  return health.tone === 'muted' ? 'brand' : health.tone;
}

function healthBadge(health) {
  return badge(health.text, health.tone, { dot: true });
}

function ticketBadge(status) {
  const map = {
    open: ['otwarte', 'brand'],
    answered: ['odpowiedziano', 'ok'],
    closed: ['zamknięte', 'muted'],
    pending: ['oczekuje', 'warn'],
  };
  const [label, tone] = map[String(status)] || [String(status || '—'), 'muted'];
  return badge(label, tone, { dot: true });
}

function priorityBadge(priority) {
  const map = { high: ['wysoki', 'danger'], normal: ['normalny', 'brand'], low: ['niski', 'muted'] };
  const [label, tone] = map[String(priority)] || [String(priority || '—'), 'muted'];
  return badge(label, tone);
}

function domainStateBadge(domain) {
  if (domain.user_suspended) return badge('konto zawieszone', 'danger', { dot: true });
  if (domain.status === 'active') return badge('aktywna', 'ok', { dot: true });
  if (domain.status === 'suspended') return badge('zawieszona', 'danger', { dot: true });
  return badge(domain.status || '—', 'muted', { dot: true });
}

function backupStateBadge(status) {
  const map = {
    complete: ['gotowa', 'ok'],
    running: ['w toku', 'warn'],
    pending: ['oczekuje', 'warn'],
    failed: ['błąd', 'danger'],
    error: ['błąd', 'danger'],
  };
  const [label, tone] = map[String(status)] || [String(status || '—'), 'muted'];
  return badge(label, tone, { dot: true });
}

function appStateBadge(status) {
  const map = {
    active: ['aktywna', 'ok'],
    'web-installer': ['dokończ w przeglądarce', 'warn'],
    failed: ['błąd', 'danger'],
    error: ['błąd', 'danger'],
    stopped: ['zatrzymana', 'muted'],
  };
  const [label, tone] = map[String(status)] || [String(status || 'nieznany'), 'muted'];
  return badge(label, tone, { dot: true });
}

function liveHealthPill() {
  return h`<span class="live-pill" role="status" data-live-url="/healthz" data-live-interval="60" title="Kondycja panelu jest sprawdzana automatycznie">
    <span class="live-dot" aria-hidden="true"></span><span class="live-label">Kondycja</span>
  </span>`;
}

function iconLink(href, iconName, label) {
  return h`<a class="icon-btn" href="${href}" title="${label}" aria-label="${label}">${icon(iconName, { size: 16 })}</a>`;
}

function postIcon(ctx, action, iconName, label, confirmText = '') {
  return h`<form method="post" action="${action}" class="inline">
    <input type="hidden" name="_csrf" value="${ctx.csrf}">
    <button class="icon-btn" type="submit" title="${label}" aria-label="${label}" ${confirmText ? raw(`data-confirm="${String(confirmText).replace(/"/g, '&quot;')}"`) : ''}>${icon(iconName, { size: 16 })}</button>
  </form>`;
}

function limitRow(label, used, limit, usedLabel, limitLabel, health) {
  return h`<div>
    <div class="spread small"><span>${label}</span><span>${usedLabel} / ${Number(limit) ? limitLabel : '∞'} ${healthBadge(health)}</span></div>
    ${progress(used, Number(limit) || 1, { showText: false })}
  </div>`;
}

/* ------------------------------------------------------------------- data */

function ownerScope(actor) {
  return actor.level === 'admin' ? null : actor.username;
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!map.has(value)) map.set(value, []);
    map.get(value).push(row);
  }
  return map;
}

function installedResellerApps(actor) {
  const wordpress = all(`SELECT 'wordpress' type, w.id, w.domain, w.path, w.version, w.status,
      w.admin_user, w.created_at, u.id user_id, u.username, u.suspended user_suspended, d.ssl domain_ssl
    FROM wordpress w
    JOIN domains d ON d.name = w.domain
    JOIN users u ON u.id = d.user_id
    WHERE (u.owner = ? OR ? IS NULL) AND u.level = 'user'`, actor.username, ownerScope(actor));
  const catalogue = all(`SELECT a.type, a.id, a.domain, a.path, a.version, a.status,
      a.admin_user, a.created_at, u.id user_id, u.username, u.suspended user_suspended, d.ssl domain_ssl
    FROM app_installs a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN domains d ON d.name = a.domain AND d.user_id = a.user_id
    WHERE (u.owner = ? OR ? IS NULL) AND u.level = 'user' AND a.type IN (${[...CATALOG_TYPES].map(() => '?').join(',')})`,
  actor.username, ownerScope(actor), ...CATALOG_TYPES);
  const seen = new Set();
  return [...wordpress, ...catalogue]
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .filter((row) => {
      const key = `${row.type}|${row.domain}|${row.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function appOpenUrl(row) {
  const scheme = Number(row.domain_ssl) ? 'https' : 'http';
  const path = String(row.path || '/');
  const suffix = path === '/' ? '' : path.replace(/\/+$/, '');
  return `${scheme}://${row.domain}${suffix}/`;
}

function customerSnapshot(actor) {
  const customers = visibleUsers(actor, { level: 'user' });
  const domains = all(`SELECT d.*, u.username, u.suspended user_suspended
    FROM domains d JOIN users u ON u.id = d.user_id
    WHERE (u.owner = ? OR ? IS NULL) AND u.level = 'user' ORDER BY d.name`, actor.username, ownerScope(actor));
  const apps = installedResellerApps(actor);
  const tickets = all(`SELECT t.* FROM tickets t JOIN users u ON u.id = t.user_id
    WHERE u.owner = ? OR ? IS NULL ORDER BY t.updated_at DESC, t.id DESC`, actor.username, ownerScope(actor));
  const backups = all(`SELECT b.*, u.username FROM backups b JOIN users u ON u.id = b.user_id
    WHERE u.owner = ? OR ? IS NULL ORDER BY b.created_at DESC, b.id DESC`, actor.username, ownerScope(actor));
  const usage = all(`SELECT ud.day, SUM(ud.bandwidth_mb) bandwidth_mb, SUM(ud.disk_mb) disk_mb
    FROM usage_daily ud JOIN users u ON u.username = ud.username
    WHERE u.owner = ? OR ? IS NULL GROUP BY ud.day ORDER BY ud.day DESC LIMIT 30`, actor.username, ownerScope(actor)).reverse();
  const usageByUser = new Map(all(`SELECT ud.username, SUM(ud.bandwidth_mb) bandwidth_mb
    FROM usage_daily ud JOIN users u ON u.username = ud.username
    WHERE u.owner = ? OR ? IS NULL GROUP BY ud.username`, actor.username, ownerScope(actor)).map((r) => [r.username, Number(r.bandwidth_mb) || 0]));
  const domainsByUser = groupBy(domains, 'user_id');
  const appsByUser = groupBy(apps, 'user_id');
  const ticketsByUser = groupBy(tickets, 'user_id');
  const backupsByUser = groupBy(backups, 'user_id');

  const summaries = customers.map((user) => {
    const userDomains = domainsByUser.get(user.id) || [];
    const userApps = appsByUser.get(user.id) || [];
    const userTickets = ticketsByUser.get(user.id) || [];
    const userBackups = backupsByUser.get(user.id) || [];
    const activity = [
      user.last_login,
      ...userDomains.map((d) => d.created_at),
      ...userApps.map((a) => a.created_at),
      ...userTickets.map((t) => t.updated_at),
      ...userBackups.map((b) => b.created_at),
    ].filter(Boolean).sort();
    return {
      ...user,
      domains: userDomains,
      domainCount: userDomains.length,
      apps: userApps,
      appCount: userApps.length,
      disk: userDomains.reduce((total, d) => total + (Number(d.disk_mb) || 0), 0),
      bandwidth: usageByUser.get(user.username) || 0,
      lastActivity: activity.at(-1) || null,
      suspended: !!user.suspended,
    };
  });

  return {
    customers: summaries,
    domains,
    apps,
    tickets,
    backups,
    usage,
    usageByUser,
    openTickets: tickets.filter((t) => t.status !== 'closed'),
  };
}

function canManageTicket(actor, ticket) {
  if (!ticket) return false;
  if (actor.level === 'admin') return true;
  return !!get('SELECT id FROM users WHERE username = ? AND owner = ?', ticket.username, actor.username);
}

/* --------------------------------------------------------- one-time results */

const INSTALL_RESULT_TTL = 10 * 60 * 1000;
const installResults = new Map();

function stashInstallResult(payload) {
  const token = crypto.randomBytes(18).toString('hex');
  installResults.set(token, { at: Date.now(), ...payload });
  for (const [key, value] of installResults) {
    if (Date.now() - value.at > INSTALL_RESULT_TTL) installResults.delete(key);
  }
  return token;
}

function takeInstallResult(token) {
  const key = String(token || '');
  const found = installResults.get(key);
  if (!found) return null;
  installResults.delete(key);
  if (Date.now() - found.at > INSTALL_RESULT_TTL) return null;
  return found;
}

function appsError(ctx, message) {
  return ctx.redirect(`${R}/apps?flash=${encodeURIComponent(message)}&type=error`);
}

function normalizeInstallPath(value, fallback = '/') {
  let path = String(value ?? fallback).trim() || fallback;
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/+$/, '');
  return path || '/';
}

function validInstallPath(path) {
  if (path === '/') return true;
  return /^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(path) && !path.split('/').includes('..');
}

function usageSourceLabel(source) {
  const text = String(source || '');
  if (!text || text === 'not collected yet') return 'brak pomiarów';
  if (text.includes('access logs')) return 'logi dostępu';
  if (text.includes('unavailable')) return 'niedostępne (brak logów)';
  return text;
}

/* ---------------------------------------------------------------- dashboard */

function quickTile(href, iconName, title, sub) {
  return h`<a class="quick-tile" href="${href}">${icon(iconName, { size: 20 })}<strong>${title}</strong><span>${sub}</span></a>`;
}

function resellerDashboard(ctx) {
  const snapshot = customerSnapshot(ctx.user);
  const limits = limitsFor(ctx.user);
  const customers = snapshot.customers;
  const domains = snapshot.domains;
  const openTickets = snapshot.openTickets;
  const disk = domains.reduce((total, d) => total + (Number(d.disk_mb) || 0), 0);
  const measuredBandwidth = snapshot.usage.reduce((total, row) => total + (Number(row.bandwidth_mb) || 0), 0);
  const domainBandwidth = domains.reduce((total, d) => total + (Number(d.bandwidth_mb) || 0), 0);
  const bandwidth = measuredBandwidth || domainBandwidth;
  const bandwidthSource = measuredBandwidth ? 'dzienne pomiary' : 'ostatni znany transfer domen';
  const points = snapshot.usage.map((row) => Number(row.bandwidth_mb) || 0);
  const peak = Math.max(...points, 0);
  const ipsUsed = get('SELECT COUNT(*) n FROM ips WHERE owner = ?', ctx.user.username).n;
  const packages = all("SELECT name FROM packages WHERE type = 'user' AND (owner IS NULL OR owner = ?)", ctx.user.username);
  const appsPending = snapshot.apps.filter((a) => a.status === 'web-installer').length;
  const appsFailed = snapshot.apps.filter((a) => a.status === 'failed' || a.status === 'error').length;
  const healthUsers = healthFor(customers.length, limits.users);
  const healthDomains = healthFor(domains.length, limits.domains);
  const healthDisk = healthFor(disk, limits.disk_mb);
  const healthBandwidth = healthFor(bandwidth, limits.bandwidth_mb);
  const isNew = customers.length === 0;

  const backupConfig = backupSettings();
  const deployment = applyStatus();
  const usageInfo = usageMeta();
  const sslCerts = all(`SELECT s.domain, s.expires_at FROM ssl_certs s
    WHERE s.status = 'active' AND s.domain IN (
      SELECT d.name FROM domains d JOIN users u ON u.id = d.user_id WHERE (u.owner = ? OR ? IS NULL) AND u.level = 'user'
    )`, ctx.user.username, ownerScope(ctx.user));
  const expiringCerts = sslCerts.filter((cert) => {
    if (!cert.expires_at) return false;
    const expires = new Date(cert.expires_at).getTime();
    return Number.isFinite(expires) && expires - Date.now() < 30 * 864e5;
  });
  const deployBadge = deployment.pending
    ? badge('oczekuje', 'warn', { dot: true })
    : deployment.lastAt
      ? (deployment.ok ? badge('OK', 'ok', { dot: true }) : badge('błąd', 'danger', { dot: true }))
      : badge('brak danych', 'muted', { dot: true });

  const steps = [
    { done: packages.length > 0, label: 'Wybierz pakiet dla klientów', href: '/reseller/packages' },
    { done: customers.length > 0, label: 'Dodaj pierwszego klienta', href: '/reseller/users/create' },
    { done: domains.length > 0, label: 'Utwórz domenę klienta', href: '/reseller/domains' },
    { done: snapshot.apps.length > 0, label: 'Zainstaluj pierwszą aplikację', href: '/reseller/apps' },
    { done: snapshot.backups.length > 0, label: 'Skonfiguruj kopie zapasowe', href: '/reseller/backups' },
    { done: snapshot.tickets.length > 0, label: 'Odbierz pierwsze zgłoszenie', href: '/reseller/tickets' },
  ];
  const stepsDone = steps.filter((step) => step.done).length;

  const hero = h`<div class="hero">
    <div>
      <p>${isNew
        ? 'Zacznij od utworzenia klienta, przypisania domeny i pierwszego pakietu. Wszystko, co potrzebne do sprzedaży hostingu, jest w tym panelu.'
        : h`Zarządzasz <strong>${customers.length}</strong> ${plural(customers.length, 'klientem', 'klientami', 'klientami')} i <strong>${domains.length}</strong> ${plural(domains.length, 'domeną', 'domenami', 'domenami')}. Limity, aplikacje, DNS i zgłoszenia masz w jednym miejscu.`}</p>
      <div class="row mt-18">
        ${badge('Pakiet: ' + (ctx.user.package || 'reseller'), 'brand')}
        ${badge(`${openTickets.length} ${plural(openTickets.length, 'otwarte zgłoszenie', 'otwarte zgłoszenia', 'otwartych zgłoszeń')}`, openTickets.length ? 'warn' : 'ok', { dot: true })}
        ${badge('Darmowa licencja', 'ok')}
      </div>
    </div>
    <div class="hero-actions">
      ${btn('Dodaj klienta', { href: '/reseller/users/create', icon: 'plus' })}
    </div>
  </div>`;

  const kpis = h`<div class="stat-grid">
    ${statCard({
      label: 'Klienci',
      value: `${customers.length}${limits.users ? ' / ' + limits.users : ''}`,
      sub: h`${healthBadge(healthUsers)} <span class="muted">konta klientów</span>`,
      icon: 'users', tone: statTone(healthUsers), href: '/reseller/users',
    })}
    ${statCard({
      label: 'Domeny klientów',
      value: `${domains.length}${limits.domains ? ' / ' + limits.domains : ''}`,
      sub: h`${healthBadge(healthDomains)} <span class="muted">w Twoim resellerze</span>`,
      icon: 'globe', tone: statTone(healthDomains), href: '/reseller/domains',
    })}
    ${statCard({
      label: 'Dysk klientów',
      value: formatBytes(disk),
      sub: h`${healthBadge(healthDisk)} <span class="muted">${limits.disk_mb ? 'z ' + formatBytes(limits.disk_mb) : 'bez limitu pakietu'}</span>`,
      icon: 'database', tone: statTone(healthDisk), href: '/reseller/statistics',
    })}
    ${statCard({
      label: 'Transfer (30 dni)',
      value: formatBytes(bandwidth),
      sub: h`${healthBadge(healthBandwidth)} <span class="muted">${bandwidthSource}</span>`,
      icon: 'chart', tone: statTone(healthBandwidth), href: '/reseller/statistics',
    })}
  </div>`;

  const onboarding = stepsDone < steps.length ? card(
    isNew ? 'Zacznij tutaj' : 'Dokończ konfigurację',
    h`<div class="spread mb-12"><strong>${stepsDone} z ${steps.length} gotowe</strong><span class="small muted">${isNew ? 'Pierwsze kroki w panelu resellera' : 'Kilka kroków do pełnej konfiguracji'}</span></div>
      <div class="progress mb-18"><span style="width:${Math.round((stepsDone / steps.length) * 100)}%"></span></div>
      <div class="stack" style="gap:10px">${steps.map((step) => h`<div class="spread">
        <span>${step.done ? badge('gotowe', 'ok', { dot: true }) : badge('do zrobienia', 'warn', { dot: true })} ${step.done ? step.label : h`<a class="link" href="${step.href}">${step.label}</a>`}</span>
        ${step.done ? '' : h`<a class="btn btn-ghost btn-sm" href="${step.href}">Przejdź →</a>`}
      </div>`)}</div>`,
    { sub: 'Pakiety, klienci, domeny, aplikacje, kopie i wsparcie' },
  ) : '';

  const chart = snapshot.usage.length
    ? card('Transfer klientów', h`
      <div class="spread mb-12">
        <div><div class="stat-value">${formatBytes(measuredBandwidth)}</div><div class="small muted">łącznie · średnio ${formatBytes(measuredBandwidth / Math.max(points.length, 1))} dziennie</div></div>
        <div class="ta-r"><div class="stat-value">${formatBytes(peak)}</div><div class="small muted">szczyt dnia</div></div>
      </div>
      ${sparkline(points)}
      <div class="spread small muted mt-10"><span>${snapshot.usage[0]?.day || ''}</span><span>${snapshot.usage.at(-1)?.day || ''}</span></div>`,
    { sub: 'Ostatnie 30 dni', actions: [h`<a class="link small" href="/reseller/statistics">Szczegóły</a>`] })
    : card('Transfer klientów', emptyState('Brak dziennych pomiarów transferu. KPI pokazuje ostatni znany transfer domen.', {
      icon: 'chart',
      action: btn('Zobacz statystyki', { href: '/reseller/statistics', variant: 'secondary', icon: 'chart' }),
    }), { sub: 'Ostatnie 30 dni', actions: [h`<a class="link small" href="/reseller/statistics">Szczegóły</a>`] });

  const limitsCard = card('Limity i kondycja', h`<div class="stack" style="gap:14px">
    ${limitRow('Klienci', customers.length, limits.users, String(customers.length), String(limits.users), healthUsers)}
    ${limitRow('Domeny', domains.length, limits.domains, String(domains.length), String(limits.domains), healthDomains)}
    ${limitRow('Dysk', disk, limits.disk_mb, formatBytes(disk), formatBytes(limits.disk_mb), healthDisk)}
    ${limitRow('Transfer', bandwidth, limits.bandwidth_mb, formatBytes(bandwidth), formatBytes(limits.bandwidth_mb), healthBandwidth)}
    ${limitRow('Adresy IP', ipsUsed, limits.ips, String(ipsUsed), String(limits.ips), healthFor(ipsUsed, limits.ips))}
    <div class="spread small"><span>Aplikacje klientów</span><span>${badge(`${snapshot.apps.length} ${plural(snapshot.apps.length, 'zainstalowana', 'zainstalowane', 'zainstalowanych')}`, snapshot.apps.length ? 'ok' : 'muted')} ${appsPending ? badge(`${appsPending} do dokończenia`, 'warn') : ''}</span></div>
  </div>`, {
    sub: 'Na podstawie pakietu ' + (ctx.user.package || 'reseller'),
    actions: [h`<a class="link small" href="/reseller/settings">Ustawienia</a>`],
  });

  const quickActions = card('Szybkie akcje', h`<div class="quick-grid">
    ${quickTile('/reseller/users/create', 'plus', 'Nowy klient', 'Konto + domena + pakiet')}
    ${quickTile('/reseller/domains', 'globe', 'Domeny klientów', `${domains.length} ${plural(domains.length, 'domena', 'domeny', 'domen')}`)}
    ${quickTile('/reseller/apps', 'cart', 'Aplikacje', 'WordPress, sklep, chmura')}
    ${quickTile('/reseller/packages/create', 'archive', 'Nowy pakiet', 'Limity i funkcje')}
    ${quickTile('/reseller/dns', 'dns', 'DNS klientów', 'Strefy i rekordy')}
    ${quickTile('/reseller/backups', 'archive', 'Kopie zapasowe', `${snapshot.backups.length} ${plural(snapshot.backups.length, 'archiwum', 'archiwa', 'archiwów')}`)}
    ${quickTile('/reseller/tickets', 'ticket', 'Zgłoszenia', `${openTickets.length} ${plural(openTickets.length, 'otwarte', 'otwarte', 'otwartych')}`)}
    ${quickTile('/reseller/ip-manager', 'network', 'Adresy IP', `${ipsUsed} ${plural(ipsUsed, 'adres', 'adresy', 'adresów')}`)}
  </div>`, { sub: 'Najczęstsze zadania resellera' });

  const customerRows = customers.slice(0, 10).map((user) => {
    const firstDomain = user.domains.find((domain) => !domain.user_suspended && domain.status === 'active')?.name
      || user.domains[0]?.name;
    return h`<tr>
      <td><a class="cell-strong" href="/reseller/users/${user.id}">${user.username}</a><span class="cell-sub">${user.email || '—'}</span></td>
      <td><a class="link" href="/reseller/domains?q=${encodeURIComponent(user.username)}">${user.domainCount}</a></td>
      <td>${user.appCount ? h`<a class="link" href="/reseller/apps${firstDomain ? '?domain=' + encodeURIComponent(firstDomain) : ''}">${user.appCount}</a>` : '—'}</td>
      <td>${formatBytes(user.disk)}</td>
      <td>${user.bandwidth ? formatBytes(user.bandwidth) : '—'}</td>
      <td>${relTime(user.lastActivity)}</td>
      <td>${user.suspended ? badge('zawieszony', 'danger', { dot: true }) : badge('aktywny', 'ok', { dot: true })}</td>
      <td class="col-actions"><div class="row-actions">
        ${iconLink(`/reseller/users/${user.id}`, 'user', 'Panel klienta')}
        ${firstDomain && !user.suspended ? iconLink(`/reseller/apps?domain=${encodeURIComponent(firstDomain)}`, 'cart', 'Zainstaluj aplikację') : ''}
        ${!user.suspended ? postIcon(ctx, `${R}/users/${user.id}/login-as`, 'logout', 'Zaloguj jako klienta', 'Zalogować się jako ten klient?') : ''}
      </div></td>
    </tr>`;
  });

  const customerList = card('Klienci', customers.length ? h`<div class="table-wrap"><table class="data-table">
    <thead><tr><th>Klient</th><th>Domeny</th><th>Aplikacje</th><th>Dysk</th><th>Transfer</th><th>Ostatnia aktywność</th><th>Status</th><th class="col-actions">Akcje</th></tr></thead>
    <tbody>${customerRows}</tbody>
  </table></div>` : emptyState('Nie masz jeszcze klientów. Utwórz pierwsze konto, aby przypisać domenę i aplikację.', {
    icon: 'users',
    action: btn('Dodaj pierwszego klienta', { href: '/reseller/users/create', icon: 'plus' }),
  }), {
    sub: `${customers.length} ${plural(customers.length, 'konto klienta', 'konta klientów', 'kont klientów')}${customers.length > 10 ? ' · pokazano 10' : ''}`,
    padded: !customers.length,
    actions: [h`<a class="link small" href="/reseller/users">Wszyscy klienci</a>`],
  });

  const ticketsWidget = card('Ostatnie zgłoszenia', snapshot.tickets.length ? h`<div class="timeline">${snapshot.tickets.slice(0, 5).map((ticket) => h`<div class="timeline-item">
    <div class="timeline-dot">${icon('ticket', { size: 15 })}</div>
    <div class="timeline-body">
      <div class="spread"><a class="link" href="/reseller/tickets/${ticket.id}"><strong>${ticket.subject}</strong></a><span class="small muted">${relTime(ticket.updated_at)}</span></div>
      <small>${ticket.username} · ${ticketBadge(ticket.status)}</small>
    </div>
  </div>`)}</div>` : emptyState('Brak zgłoszeń od klientów.', { icon: 'ticket' }), {
    sub: `${openTickets.length} ${plural(openTickets.length, 'otwarte zgłoszenie', 'otwarte zgłoszenia', 'otwartych zgłoszeń')}`,
    actions: [h`<a class="link small" href="/reseller/tickets">Wszystkie zgłoszenia</a>`],
  });

  const backupsWidget = card('Ostatnie kopie klientów', snapshot.backups.length ? h`<div class="timeline">${snapshot.backups.slice(0, 4).map((backup) => h`<div class="timeline-item">
    <div class="timeline-dot">${icon('archive', { size: 15 })}</div>
    <div class="timeline-body"><div class="truncate">${backup.filename}</div><small>${backup.username} · ${formatBytes(backup.size_mb)} · ${relTime(backup.created_at)}</small></div>
  </div>`)}</div>` : emptyState('Klienci nie mają jeszcze kopii zapasowych.', { icon: 'archive' }), {
    sub: `${snapshot.backups.length} ${plural(snapshot.backups.length, 'archiwum', 'archiwa', 'archiwów')}`,
    actions: [h`<a class="link small" href="/reseller/backups">Wszystkie kopie</a>`],
  });

  const appsWidget = card('Aplikacje klientów', snapshot.apps.length ? h`<div>${snapshot.apps.slice(0, 4).map((app) => h`<div class="app-installed">
    ${appIcon(app.type, { size: 34 })}
    <div><strong>${appName(app.type)}</strong><p class="app-tile-sub">${app.username} · ${app.domain}</p></div>
    <div class="app-installed-actions">${appStateBadge(app.status)}${iconLink(appOpenUrl(app), 'globe', 'Otwórz aplikację')}</div>
  </div>`)}</div>` : emptyState('Żaden klient nie ma jeszcze zainstalowanej aplikacji.', {
    icon: 'cart',
    action: btn('Otwórz katalog aplikacji', { href: '/reseller/apps', icon: 'cart' }),
  }), {
    sub: `${snapshot.apps.length} ${plural(snapshot.apps.length, 'instalacja', 'instalacje', 'instalacji')}${appsFailed ? ` · ${appsFailed} z błędem` : ''}`,
    actions: [h`<a class="link small" href="/reseller/apps">Katalog aplikacji</a>`],
  });

  const automation = card('Automatyzacja i kondycja', h`<div class="stack" style="gap:14px">
    <div>
      <div class="spread"><span class="small" style="font-weight:600">Automatyczne kopie zapasowe</span>${backupConfig.enabled ? badge('włączone', 'ok', { dot: true }) : badge('wyłączone', 'warn', { dot: true })}</div>
      <p class="field-help">Ostatni przebieg: ${backupConfig.lastRun ? relTime(backupConfig.lastRun) : 'jeszcze nie uruchamiano'} · retencja ${backupConfig.retentionDays} dni</p>
    </div>
    <div>
      <div class="spread"><span class="small" style="font-weight:600">Ostatnie wdrożenie konfiguracji</span>${deployBadge}</div>
      <p class="field-help">${deployment.lastAt ? `Ostatnio: ${relTime(deployment.lastAt)}` : 'Jeszcze nie uruchamiano wdrożenia.'}${deployment.pending ? ' Zmiany oczekują na wdrożenie.' : ''}</p>
    </div>
    <div>
      <div class="spread"><span class="small" style="font-weight:600">Certyfikaty SSL klientów</span>${expiringCerts.length ? badge(`${expiringCerts.length} wygasa`, 'warn', { dot: true }) : badge(`${sslCerts.length} aktywnych`, sslCerts.length ? 'ok' : 'muted', { dot: true })}</div>
      <p class="field-help">${expiringCerts.length ? 'Odnów certyfikaty w panelu klienta lub przez AutoSSL.' : 'Brak certyfikatów wygasających w ciągu 30 dni.'}</p>
    </div>
    <div>
      <div class="spread"><span class="small" style="font-weight:600">Pomiar użycia</span>${usageInfo.lastCollected ? badge(relTime(usageInfo.lastCollected), 'ok', { dot: true }) : badge('brak danych', 'muted', { dot: true })}</div>
      <p class="field-help">Źródło transferu: ${usageSourceLabel(usageInfo.bandwidthSource)}</p>
    </div>
  </div>`, {
    sub: 'Tylko do odczytu — dane z bieżących ustawień i dziennika wdrożeń',
    actions: [liveHealthPill(), h`<a class="link small" href="/reseller/statistics">Statystyki</a>`],
  });

  const body = h`<div data-auto-refresh="60">
    ${hero}
    ${kpis}
    ${onboarding}
    <div class="grid grid-2-1">${chart}${limitsCard}</div>
    ${customerList}
    <div class="grid grid-3">${ticketsWidget}${backupsWidget}${appsWidget}</div>
    ${automation}
  </div>`;

  return page(ctx, {
    title: 'Pulpit resellera',
    subtitle: isNew ? 'Pierwsze kroki i centrum zarządzania resellerem' : 'Klienci, limity, aplikacje i wsparcie w jednym miejscu',
    body,
    counts: countForNav(ctx.user, 'reseller'),
  });
}

/* --------------------------------------------------------------- statistics */

function resellerStatistics(ctx) {
  const snapshot = customerSnapshot(ctx.user);
  const rows = snapshot.customers.map((user) => ({
    ...user,
    bandwidth: user.bandwidth || user.domains.reduce((total, d) => total + (Number(d.bandwidth_mb) || 0), 0),
  }));
  const total = snapshot.usage.reduce((sum, row) => sum + (Number(row.bandwidth_mb) || 0), 0);
  const points = snapshot.usage.map((row) => Number(row.bandwidth_mb) || 0);
  const chart = snapshot.usage.length
    ? card('Transfer w czasie', h`
      <div class="spread mb-12"><div><div class="stat-value">${formatBytes(total)}</div><div class="small muted">łącznie w ostatnich 30 dniach</div></div><div class="ta-r"><div class="stat-value">${formatBytes(Math.max(...points, 0))}</div><div class="small muted">szczyt dnia</div></div></div>
      ${sparkline(points)}`, { sub: 'Wszyscy klienci resellera' })
    : card('Transfer w czasie', emptyState('Panel nie zebrał jeszcze dziennych pomiarów transferu. Poniżej pokazujemy ostatnie znane wartości z domen.', { icon: 'chart' }), { sub: 'Ostatnie 30 dni' });
  const tableCard = card('Użycie w podziale na klientów', table({
    columns: [
      { label: 'Klient', render: (user) => h`<a class="cell-strong" href="/reseller/users/${user.id}">${user.username}</a><span class="cell-sub">${user.email || '—'}</span>` },
      { label: 'Pakiet', render: (user) => badge(user.package || 'default', 'brand') },
      { label: 'Domeny', render: (user) => user.domainCount, align: 'right' },
      { label: 'Aplikacje', render: (user) => user.appCount, align: 'right' },
      { label: 'Dysk', render: (user) => formatBytes(user.disk), align: 'right' },
      { label: 'Transfer (30 dni)', render: (user) => formatBytes(user.bandwidth), align: 'right' },
      { label: 'Ostatnia aktywność', render: (user) => relTime(user.lastActivity) },
    ],
    rows: rows.sort((a, b) => b.bandwidth - a.bandwidth),
    empty: 'Brak klientów do pokazania.',
  }), { sub: `${rows.length} ${plural(rows.length, 'konto', 'konta', 'kont')}`, padded: false });
  const body = h`${chart}${tableCard}`;
  return page(ctx, {
    title: 'Statystyki resellera',
    subtitle: 'Transfer, dysk i użycie w podziale na klientów',
    body,
    counts: countForNav(ctx.user, 'reseller'),
  });
}

/* --------------------------------------------------------------------- DNS */

function resellerDns(ctx) {
  const domains = visibleDomains(ctx.user);
  const requested = String(ctx.query.domain || '');
  const selected = requested || domains[0]?.name;
  const domain = domains.find((item) => item.name === selected) || domains[0];
  const records = domain ? all('SELECT * FROM dns_records WHERE domain_id = ? ORDER BY type, name', domain.id) : [];
  const editing = ctx.query.edit ? records.find((record) => String(record.id) === String(ctx.query.edit)) : null;
  const recordRows = records.map((record) => h`<tr>
    <td class="cell-mono">${record.name}</td>
    <td>${badge(record.type, 'brand')}</td>
    <td class="cell-mono">${record.value}</td>
    <td>${record.priority ?? '—'}</td>
    <td>${record.ttl}</td>
    <td class="col-actions"><div class="row-actions">
      ${iconLink(`/reseller/dns?domain=${encodeURIComponent(domain.name)}&edit=${record.id}`, 'edit', 'Edytuj rekord')}
      ${postIcon(ctx, `/reseller/dns/${record.id}/delete`, 'trash', 'Usuń rekord', 'Usunąć ten rekord DNS?')}
    </div></td>
  </tr>`);
  const body = h`
    ${domains.length ? domainSelect(domains, domain?.name, { action: '/reseller/dns', label: 'Domena' }) : alert('Brak domen w Twoim resellerze. Dodaj klienta z domeną, aby zarządzać strefą DNS.', 'warn')}
    ${domain ? card(`Strefa DNS · ${domain.name}`, records.length ? h`<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Nazwa</th><th>Typ</th><th>Wartość</th><th>Priorytet</th><th>TTL</th><th class="col-actions">Akcje</th></tr></thead>
      <tbody>${recordRows}</tbody>
    </table></div>` : emptyState('Ta strefa nie ma jeszcze rekordów DNS.', { icon: 'dns' }), { padded: records.length === 0 }) : ''}
    ${domain && editing ? card(`Edytuj rekord · ${editing.type} ${editing.name}`, h`<form method="post" action="/reseller/dns/${editing.id}/update" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid">
        <div class="field"><label class="field-label">Nazwa</label><input name="name" value="${editing.name}" required></div>
        <div class="field"><label class="field-label">Typ</label><select name="type">${['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'].map((type) => h`<option ${type === editing.type ? 'selected' : ''}>${type}</option>`)}</select></div>
        <div class="field field-full"><label class="field-label">Wartość</label><input name="value" value="${editing.value}" required></div>
        <div class="field"><label class="field-label">Priorytet</label><input name="priority" type="number" value="${editing.priority ?? ''}"></div>
        <div class="field"><label class="field-label">TTL</label><input name="ttl" type="number" value="${editing.ttl}" min="60"></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Zapisz rekord</button><a class="btn btn-ghost" href="/reseller/dns?domain=${encodeURIComponent(domain.name)}">Anuluj</a></div>
    </form>`) : ''}
    ${domain ? card('Dodaj rekord', h`<form method="post" action="/reseller/dns/add" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">
      <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="domain" value="${domain.name}">
      <div class="field"><label class="field-label">Nazwa</label><input name="name" value="@" style="width:140px"></div>
      <div class="field"><label class="field-label">Typ</label><select name="type" style="width:100px">${['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'].map((type) => h`<option>${type}</option>`)}</select></div>
      <div class="field" style="flex:1;min-width:240px"><label class="field-label">Wartość</label><input name="value" required></div>
      <div class="field"><label class="field-label">Priorytet</label><input name="priority" type="number" style="width:100px"></div>
      <button class="btn btn-primary" type="submit">Dodaj rekord</button>
    </form>`, { sub: `Zmiany są wdrażane automatycznie · ${domain.name}` }) : ''}`;
  return page(ctx, {
    title: 'Administracja DNS',
    subtitle: 'Strefy i rekordy domen klientów',
    body,
    counts: countForNav(ctx.user, 'reseller'),
  });
}

/* --------------------------------------------------------------------- IPs */

function resellerIps(ctx) {
  const ips = all("SELECT * FROM ips WHERE owner = ? OR owner IS NULL OR owner = 'admin' ORDER BY ip", ctx.user.username);
  const statusMap = { free: ['wolny', 'muted'], shared: ['współdzielony', 'brand'], server: ['serwerowy', 'ok'] };
  const rows = ips.map((ip) => {
    const [label, tone] = statusMap[ip.status] || [ip.status || '—', 'muted'];
    return h`<tr>
      <td class="cell-mono">${ip.ip}</td>
      <td class="cell-mono">${ip.netmask}</td>
      <td>${badge(label, tone, { dot: true })}</td>
      <td>${ip.owner || 'administrator'}</td>
      <td class="col-actions"><div class="row-actions">${ip.owner === ctx.user.username ? postIcon(ctx, `/reseller/ip-manager/${ip.id}/release`, 'x', 'Zwolnij adres IP', 'Zwolnić ten adres IP?') : ''}</div></td>
    </tr>`;
  });
  const body = h`${card('Adresy IP', h`${ips.length ? h`<div class="table-wrap"><table class="data-table">
    <thead><tr><th>Adres IP</th><th>Maska</th><th>Status</th><th>Właściciel</th><th class="col-actions">Akcje</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>` : emptyState('Brak adresów IP przypisanych do resellera.', { icon: 'network' })}`, {
    sub: 'Współdzielone adresy są używane przez wszystkie konta; dedykowane przypisujesz klientom',
    padded: ips.length === 0,
  })}`;
  return page(ctx, {
    title: 'Menedżer IP',
    subtitle: 'Przypisywanie i zwalnianie adresów IP',
    body,
    counts: countForNav(ctx.user, 'reseller'),
  });
}

/* ----------------------------------------------------------------- tickets */

function resellerTickets(ctx) {
  const rows = all(`SELECT t.* FROM tickets t JOIN users u ON u.id = t.user_id
    WHERE u.owner = ? OR ? IS NULL ORDER BY t.created_at DESC, t.id DESC`, ctx.user.username, ownerScope(ctx.user));
  const open = rows.filter((row) => row.status !== 'closed').length;
  const body = h`${card('Zgłoszenia klientów', table({
    columns: [
      { label: 'Temat', render: (ticket) => h`<a class="cell-strong" href="/reseller/tickets/${ticket.id}">${ticket.subject}</a><span class="cell-sub">#${ticket.id} · ${ticket.username}</span>` },
      { label: 'Priorytet', render: (ticket) => priorityBadge(ticket.priority) },
      { label: 'Status', render: (ticket) => ticketBadge(ticket.status) },
      { label: 'Zaktualizowano', render: (ticket) => relTime(ticket.updated_at) },
    ],
    rows,
    empty: 'Brak zgłoszeń od klientów.',
  }), { sub: `${open} ${plural(open, 'otwarte zgłoszenie', 'otwarte zgłoszenia', 'otwartych zgłoszeń')}` })}`;
  return page(ctx, {
    title: 'Zgłoszenia klientów',
    subtitle: 'Wsparcie dla kont, którymi zarządzasz',
    body,
    counts: countForNav(ctx.user, 'reseller'),
  });
}

function ticketView(ctx, ticketId, base) {
  const ticket = get('SELECT * FROM tickets WHERE id = ?', Number(ticketId));
  if (!ticket || !canManageTicket(ctx.user, ticket)) {
    return ctx.redirect(base + '?flash=' + encodeURIComponent('Nie znaleziono zgłoszenia lub nie należy do Twojego klienta.') + '&type=error');
  }
  const messages = all('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at', ticket.id);
  const body = h`${card(ticket.subject, h`
    <div class="spread mb-18"><div class="row">${badge('#' + ticket.id, 'muted')}${badge(ticket.username, 'brand')}${priorityBadge(ticket.priority)}${ticketBadge(ticket.status)}</div>
      <span class="small muted">${datePl(ticket.created_at, { time: true })}</span></div>
    <div class="ticket-thread">${messages.map((message) => h`<div class="ticket-msg ${message.level === 'user' ? 'user' : 'staff'}">
      <div class="ticket-head"><strong>${message.author}</strong><span class="small muted">${datePl(message.created_at, { time: true })}</span></div>
      <div class="ticket-body">${message.body}</div></div>`)}</div>
    <form method="post" action="${base}/${ticket.id}/reply" class="oa-form mt-18"><input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="field field-full"><label class="field-label">Odpowiedź resellera</label><textarea name="message" rows="5" required></textarea></div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Wyślij odpowiedź</button>
        <button class="btn btn-ghost" type="submit" formaction="${base}/${ticket.id}/close">Zamknij zgłoszenie</button></div></form>`)}`;
  return page(ctx, {
    title: 'Zgłoszenie #' + ticket.id,
    subtitle: ticket.subject,
    body,
    counts: countForNav(ctx.user, 'reseller'),
  });
}

/* ----------------------------------------------------------------- domains */

function resellerDomains(ctx) {
  const query = String(ctx.query.q || '').trim().slice(0, 80);
  const status = ['active', 'suspended', 'ssl', 'no-ssl', 'apps'].includes(String(ctx.query.status))
    ? String(ctx.query.status)
    : 'all';
  const allRows = all(`SELECT d.*, u.username, u.package, u.suspended user_suspended, u.id user_id
    FROM domains d JOIN users u ON u.id = d.user_id
    WHERE (u.owner = ? OR ? IS NULL) AND u.level = 'user' ORDER BY d.name`, ctx.user.username, ownerScope(ctx.user));
  const apps = installedResellerApps(ctx.user);
  const appsByDomain = groupBy(apps, 'domain');
  const appCount = (domain) => (appsByDomain.get(domain.name) || []).length;
  const lowered = query.toLowerCase();
  let rows = allRows.filter((domain) => {
    if (!lowered) return true;
    return [domain.name, domain.username, domain.docroot, domain.package]
      .some((value) => String(value || '').toLowerCase().includes(lowered));
  });
  if (status === 'active') rows = rows.filter((domain) => !domain.user_suspended && domain.status === 'active');
  else if (status === 'suspended') rows = rows.filter((domain) => domain.user_suspended || domain.status !== 'active');
  else if (status === 'ssl') rows = rows.filter((domain) => Number(domain.ssl));
  else if (status === 'no-ssl') rows = rows.filter((domain) => !Number(domain.ssl));
  else if (status === 'apps') rows = rows.filter((domain) => appCount(domain) > 0);

  const chip = (key, label, count) => h`<a class="chip ${status === key ? 'active' : ''}" href="/reseller/domains?status=${key === 'all' ? '' : key}${query ? '&q=' + encodeURIComponent(query) : ''}">${label} <span class="small muted">${count}</span></a>`;
  const counts = {
    all: allRows.length,
    active: allRows.filter((domain) => !domain.user_suspended && domain.status === 'active').length,
    suspended: allRows.filter((domain) => domain.user_suspended || domain.status !== 'active').length,
    ssl: allRows.filter((domain) => Number(domain.ssl)).length,
    'no-ssl': allRows.filter((domain) => !Number(domain.ssl)).length,
    apps: allRows.filter((domain) => appCount(domain) > 0).length,
  };

  const tableRows = rows.map((domain) => {
    const installed = appCount(domain);
    const canLogin = !domain.user_suspended;
    const canInstallApp = canLogin && domain.status === 'active';
    return h`<tr>
      <td><a class="cell-strong" href="/reseller/dns?domain=${encodeURIComponent(domain.name)}">${domain.name}</a><span class="cell-sub">${domain.docroot || 'brak katalogu'}</span></td>
      <td><a class="link" href="/reseller/users/${domain.user_id}">${domain.username}</a></td>
      <td>${badge(domain.package || 'default', 'brand')}</td>
      <td>${domainStateBadge(domain)}</td>
      <td>${domain.php_version || '—'}</td>
      <td>${Number(domain.ssl) ? badge('SSL', 'ok', { dot: true }) : badge('brak', 'muted')}</td>
      <td>${formatBytes(domain.disk_mb)}</td>
      <td>${installed ? h`<a class="link" href="/reseller/apps?domain=${encodeURIComponent(domain.name)}">${badge(`${installed} ${plural(installed, 'aplikacja', 'aplikacje', 'aplikacji')}`, 'brand')}</a>` : badge('brak', 'muted')}</td>
      <td class="col-actions"><div class="row-actions">
        ${iconLink(`/reseller/dns?domain=${encodeURIComponent(domain.name)}`, 'dns', 'Edytuj DNS')}
        ${canInstallApp ? iconLink(`/reseller/apps?domain=${encodeURIComponent(domain.name)}`, 'cart', 'Zainstaluj aplikację') : ''}
        ${iconLink(`/reseller/users/${domain.user_id}`, 'user', 'Panel klienta')}
        ${canLogin ? postIcon(ctx, `${R}/users/${domain.user_id}/login-as`, 'logout', 'Zaloguj jako klienta', 'Zalogować się jako ten klient?') : ''}
      </div></td>
    </tr>`;
  });

  const emptyMessage = allRows.length
    ? 'Brak domen pasujących do wyszukiwania lub filtra.'
    : 'Nie masz jeszcze domen klientów. Utwórz konto klienta z domeną, aby zacząć.';
  const emptyAction = allRows.length
    ? btn('Wyczyść filtry', { href: '/reseller/domains', variant: 'secondary', icon: 'x' })
    : btn('Dodaj klienta z domeną', { href: '/reseller/users/create', icon: 'plus' });
  const filterForm = h`<form method="get" action="/reseller/domains" class="toolbar">
    <div class="toolbar-left">
      <div class="search">${icon('search', { size: 15 })}<input type="search" name="q" value="${query}" placeholder="Szukaj domeny, klienta lub pakietu…" aria-label="Szukaj domeny, klienta lub pakietu" data-filter-input="#resellerDomains" style="padding-left:32px"></div>
      ${status !== 'all' ? h`<input type="hidden" name="status" value="${status}">` : ''}
      <button class="btn btn-secondary btn-sm" type="submit">Szukaj</button>
      ${query || status !== 'all' ? h`<a class="btn btn-ghost btn-sm" href="/reseller/domains">Wyczyść</a>` : ''}
    </div>
    <div class="toolbar-right chip-row">
      ${chip('all', 'Wszystkie', counts.all)}
      ${chip('active', 'Aktywne', counts.active)}
      ${chip('suspended', 'Zawieszone', counts.suspended)}
      ${chip('ssl', 'Z SSL', counts.ssl)}
      ${chip('no-ssl', 'Bez SSL', counts['no-ssl'])}
      ${chip('apps', 'Z aplikacjami', counts.apps)}
    </div>
  </form>`;

  const domainsCard = card('Domeny klientów', h`${filterForm}${rows.length ? h`<div id="resellerDomains" class="table-wrap"><table class="data-table">
    <thead><tr><th>Domena</th><th>Klient</th><th>Pakiet</th><th>Status</th><th>PHP</th><th>SSL</th><th>Dysk</th><th>Aplikacje</th><th class="col-actions">Akcje</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table></div>` : h`<div id="resellerDomains">${emptyState(emptyMessage, { icon: 'globe', action: emptyAction })}</div>`}`, {
    sub: `${rows.length} z ${allRows.length} ${plural(allRows.length, 'domena', 'domeny', 'domen')} · lista obejmuje wyłącznie Twoich klientów`,
    padded: false,
    actions: [h`<a class="link small" href="/reseller/apps">Katalog aplikacji</a>`],
  });

  const body = h`
    ${alert('To domeny Twoich klientów. DNS edytujesz bezpośrednio, aplikacje instalujesz jednym kliknięciem, a konto klienta otworzysz w jego panelu.', 'info')}
    ${domainsCard}
    ${card('Szybkie akcje', h`<div class="quick-grid">
      ${quickTile('/reseller/users/create', 'plus', 'Nowy klient', 'Konto + domena')}
      ${quickTile('/reseller/apps', 'cart', 'Zainstaluj aplikację', 'Tylko domeny klientów')}
      ${quickTile('/reseller/dns', 'dns', 'Zarządzaj DNS', 'Strefy i rekordy')}
      ${quickTile('/reseller/packages/create', 'archive', 'Nowy pakiet', 'Limity i funkcje')}
    </div>`, { sub: 'Domena powstaje razem z kontem klienta w kreatorze użytkownika' })}`;
  return page(ctx, {
    title: 'Domeny klientów',
    subtitle: 'Wszystkie domeny w Twoim resellerze — wyszukuj, filtruj i zarządzaj',
    body,
    wide: true,
    counts: countForNav(ctx.user, 'reseller'),
  });
}

/* -------------------------------------------------------------------- apps */

function installResultCard(result) {
  const meta = APP_BY_KEY.get(result.app);
  const label = meta?.name || result.name || appName(result.app);
  const modeText = result.mode === 'cli'
    ? 'Zainstalowana przez CLI'
    : result.mode === 'web' || result.mode === 'web-installer'
      ? 'Baza i pliki gotowe — dokończ instalator w przeglądarce'
      : 'Gotowe';
  const rows = [
    ['Adres', result.url ? h`<a class="link" href="${result.url}" target="_blank" rel="noopener">${result.url}</a>` : '—'],
    ['Tryb', modeText],
    ['Baza', result.db || '—'],
    ['Użytkownik bazy', result.dbUser || '—'],
    ['Hasło bazy', result.dbPass ? h`<code>${result.dbPass}</code>` : '—'],
    ['Login administratora', result.adminUser || 'admin'],
    ['Hasło administratora', result.adminPass ? h`<code>${result.adminPass}</code>` : '—'],
    ['Wersja', result.version || 'najnowsza'],
  ];
  if (result.adminUrl) rows.splice(1, 0, ['Panel aplikacji', h`<a class="link" href="${result.adminUrl}" target="_blank" rel="noopener">${result.adminUrl}</a>`]);
  return card('Instalacja zakończona — dane jednorazowe', h`
    <div class="app-tile-head mb-18">${appIcon(result.app, { size: 52 })}<div><h3>${label}</h3><p class="app-tile-sub">${result.user} · ${result.domain}</p></div></div>
    ${alert('Te dane dostępowe pokazujemy tylko raz. Skopiuj hasła teraz — po odświeżeniu strony nie będzie można ich odzyskać.', 'warn')}
    ${result.warning ? alert(result.warning, 'warn') : ''}
    ${result.mode === 'web' || result.mode === 'web-installer' ? alert('Instalator WWW jest gotowy. Otwórz adres aplikacji i dokończ konfigurację w przeglądarce.', 'info') : ''}
    ${kvList(rows, { cols: 2 })}
    <div class="row mt-18"><a class="btn btn-primary" href="/reseller/apps">Wróć do aplikacji</a>${result.url ? h`<a class="btn btn-secondary" href="${result.url}" target="_blank" rel="noopener">${icon('globe', { size: 16 })} Otwórz</a>` : ''}</div>`);
}

function resellerApps(ctx) {
  const customers = visibleUsers(ctx.user, { level: 'user' });
  const customerDomains = all(`SELECT d.*, u.username, u.email, u.suspended user_suspended
    FROM domains d JOIN users u ON u.id = d.user_id
    WHERE (u.owner = ? OR ? IS NULL) AND u.level = 'user' ORDER BY d.name`, ctx.user.username, ownerScope(ctx.user));
  const installable = customerDomains.filter((domain) => !domain.user_suspended && domain.status === 'active');
  const installed = installedResellerApps(ctx.user);
  const counts = new Map();
  for (const app of installed) counts.set(app.type, (counts.get(app.type) || 0) + 1);
  const requested = String(ctx.query.domain || '');
  const selected = installable.find((domain) => domain.name === requested)
    || installable[0];
  const requestedInvalid = !!requested && !installable.some((domain) => domain.name === requested);
  const result = ctx.query.install ? takeInstallResult(String(ctx.query.install)) : null;
  const expired = !!ctx.query.install && !result;
  const pending = installed.filter((app) => app.status === 'web-installer').length;
  const failed = installed.filter((app) => app.status === 'failed' || app.status === 'error').length;
  const domainOptions = installable.map((domain) => h`<option value="${domain.name}" ${selected?.name === domain.name ? raw('selected') : ''}>${domain.username} · ${domain.name}</option>`);

  const resultBlock = result
    ? installResultCard(result)
    : expired
      ? alert('Link z danymi instalacji wygasł lub został już wykorzystany. Hasła nie są przechowywane — w razie potrzeby zresetuj je w aplikacji.', 'warn')
      : '';

  const tiles = APP_CATALOG.map((app) => {
    const installedCount = counts.get(app.key) || 0;
    const isNextcloud = app.key === 'nextcloud';
    return h`<article class="app-tile" id="app-${app.key}">
      <div class="app-tile-head">${appIcon(app.key, { size: 52 })}<div>
        <div class="app-tile-title"><h3>${app.name}</h3>${installedCount ? badge(`${installedCount} ${plural(installedCount, 'instalacja', 'instalacje', 'instalacji')}`, 'ok') : ''}</div>
        <p class="app-tile-sub">${app.desc}</p>
      </div></div>
      <div class="app-meta"><span>v${app.version}</span><span>${app.installer}</span><span>PHP + MariaDB</span></div>
      <p class="small muted">${app.note}</p>
      <div class="app-tile-actions">${installable.length ? h`<details><summary class="btn btn-primary btn-sm">${icon('download', { size: 15 })} Zainstaluj dla klienta</summary>
        <form method="post" action="/reseller/apps/install" class="oa-form app-install-form">
          <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="app" value="${app.key}">
          <div class="form-grid">
            <div class="field field-full"><label class="field-label">Domena klienta</label><select name="domain" required>${domainOptions}</select><p class="field-help">Lista zawiera wyłącznie domeny Twoich aktywnych klientów.</p></div>
            <div class="field"><label class="field-label">Ścieżka</label><input name="path" value="${isNextcloud ? '/' : app.defaultPath}" ${isNextcloud ? 'readonly' : ''}></div>
            <div class="field"><label class="field-label">Login administratora</label><input name="admin_user" value="admin" pattern="[A-Za-z0-9._-]{2,32}" required></div>
            <div class="field"><label class="field-label">Hasło administratora</label><div class="field-control"><input id="apppass_${app.key}" name="admin_password" type="password" minlength="8" required autocomplete="new-password"><button class="btn btn-secondary btn-sm" type="button" data-genpass="#apppass_${app.key}" style="margin-left:6px">Generuj</button></div></div>
            <div class="field field-full"><label class="field-label">Tytuł strony (opcjonalnie)</label><input name="title" placeholder="Np. ${app.name} — nazwa klienta"></div>
          </div>
          <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('download', { size: 15 })} Zainstaluj ${app.name}</button></div>
        </form></details>` : h`<a class="btn btn-secondary btn-sm" href="/reseller/users/create">${icon('plus', { size: 15 })} Dodaj klienta z domeną</a>`}</div>
    </article>`;
  });

  const installedRows = installed.map((app) => h`<div class="app-installed">
    ${appIcon(app.type, { size: 40 })}
    <div>
      <strong>${appName(app.type)} ${appStateBadge(app.status)}</strong>
      <p class="app-tile-sub">${app.username} · ${app.domain}${app.path && app.path !== '/' ? app.path : ''} · v${app.version || '—'} · admin: ${app.admin_user || 'admin'}</p>
    </div>
    <div class="app-installed-actions">
      <a class="btn btn-secondary btn-sm" href="${appOpenUrl(app)}" target="_blank" rel="noopener">${icon('globe', { size: 15 })} Otwórz</a>
      <a class="btn btn-ghost btn-sm" href="/reseller/users/${app.user_id}">${icon('user', { size: 15 })} Klient</a>
    </div>
  </div>`);

  const stats = h`<div class="stat-grid">
    ${statCard({ label: 'Domeny klientów', value: String(customerDomains.length), sub: `${installable.length} ${plural(installable.length, 'gotowa', 'gotowe', 'gotowych')} do instalacji`, icon: 'globe', href: '/reseller/domains' })}
    ${statCard({ label: 'Zainstalowane aplikacje', value: String(installed.length), sub: `${customers.length} ${plural(customers.length, 'klient', 'klientów', 'klientów')} w resellerze`, icon: 'cart', tone: installed.length ? 'ok' : 'brand', href: '#zainstalowane-aplikacje' })}
    ${statCard({ label: 'Do dokończenia', value: String(pending), sub: 'instalatory WWW w toku', icon: 'refresh', tone: pending ? 'warn' : 'ok', href: '#zainstalowane-aplikacje' })}
    ${statCard({ label: 'Wymagają uwagi', value: String(failed), sub: 'instalacje z błędem', icon: 'alert', tone: failed ? 'danger' : 'ok', href: '#zainstalowane-aplikacje' })}
  </div>`;

  const noDomains = !installable.length
    ? alert('Brak aktywnych domen klientów do instalacji. Dodaj klienta z domeną albo odblokuj zawieszone konto, aby kontynuować.', 'warn')
    : '';
  const invalidDomainAlert = requestedInvalid
    ? alert('Wybrana domena nie należy do aktywnych klientów Twojego resellera. Wybierz domenę z listy poniżej.', 'warn')
    : '';

  const body = h`
    ${alert('Instalujesz aplikacje na domenach swoich klientów. Wybór domen jest ograniczony do Twoich kont, a dane administratora pokazujemy tylko raz.', 'info')}
    ${resultBlock}
    ${invalidDomainAlert}
    ${noDomains}
    ${stats}
    <div id="katalog-aplikacji" class="app-tile-grid">${tiles}</div>
    <div id="zainstalowane-aplikacje" class="mt-24">
      ${card('Zainstalowane aplikacje klientów', installed.length ? h`<div>${installedRows}</div>` : emptyState('Żaden klient nie ma jeszcze aplikacji. Wybierz kafelek powyżej, aby zainstalować pierwszą.', {
        icon: 'cart',
        action: btn('Przejdź do katalogu', { href: '#katalog-aplikacji', icon: 'cart' }),
      }), {
        sub: `${installed.length} ${plural(installed.length, 'instalacja', 'instalacje', 'instalacji')}${pending ? ` · ${pending} do dokończenia` : ''}${failed ? ` · ${failed} z błędem` : ''}`,
        padded: installed.length === 0,
      })}
    </div>`;
  return page(ctx, {
    title: 'Aplikacje klientów',
    subtitle: 'WordPress, Nextcloud, PrestaShop, Joomla, Drupal i Moodle na domenach klientów',
    body,
    wide: true,
    counts: countForNav(ctx.user, 'reseller'),
  });
}

/* --------------------------------------------------------------- register */

export function registerResellerRoutes(router) {
  router.get('/reseller', (ctx) => resellerDashboard(ctx));
  router.get('/reseller/domains', (ctx) => resellerDomains(ctx));
  router.get('/reseller/apps', (ctx) => resellerApps(ctx));

  router.post('/reseller/apps/install', (ctx) => {
    const app = APP_BY_KEY.get(String(ctx.body.app || ''));
    if (!app) return appsError(ctx, 'Nieznana aplikacja. Wybierz jedną z aplikacji dostępnych w katalogu.');
    const domainName = String(ctx.body.domain || '').trim().toLowerCase();
    const domain = domainName
      ? get(`SELECT d.*, u.id user_id, u.username, u.owner, u.level user_level, u.suspended user_suspended, u.email
          FROM domains d JOIN users u ON u.id = d.user_id WHERE d.name = ?`, domainName)
      : null;
    const customer = domain ? get('SELECT * FROM users WHERE id = ?', domain.user_id) : null;
    if (!domain || !customer || customer.level !== 'user' || !canManageUser(ctx.user, customer)) {
      return appsError(ctx, 'Ta domena nie należy do Twojego klienta. Wybierz domenę z listy w katalogu aplikacji.');
    }
    if (customer.suspended || domain.user_suspended || domain.status !== 'active') {
      return appsError(ctx, 'Konto klienta lub jego domena jest zawieszone lub nieaktywna. Odblokuj je przed instalacją aplikacji.');
    }
    const password = String(ctx.body.admin_password || '');
    if (password.length < 8) return appsError(ctx, 'Hasło administratora musi mieć co najmniej 8 znaków.');
    if (password.length > 128) return appsError(ctx, 'Hasło administratora może mieć maksymalnie 128 znaków.');
    const adminUser = String(ctx.body.admin_user || 'admin').trim();
    if (!/^[A-Za-z0-9._-]{2,32}$/.test(adminUser)) {
      return appsError(ctx, 'Login administratora może zawierać litery, cyfry, kropkę, myślnik i podkreślenie (2–32 znaki).');
    }
    const subpath = normalizeInstallPath(ctx.body.path, app.defaultPath);
    if (!validInstallPath(subpath)) {
      return appsError(ctx, 'Nieprawidłowa ścieżka instalacji. Użyj np. / lub /blog — bez znaków specjalnych i bez „..”.');
    }
    if (app.key === 'nextcloud' && subpath !== '/') {
      return appsError(ctx, 'Nextcloud instaluj w katalogu głównym domeny (ścieżka /).');
    }
    try {
      const args = {
        user: customer,
        domain: domain.name,
        subpath,
        adminUser,
        adminPass: password,
        title: String(ctx.body.title || '').trim().slice(0, 120) || domain.name,
        adminEmail: customer.email || '',
        locale: 'pl_PL',
        scheme: Number(domain.ssl) ? 'https' : 'http',
      };
      let result;
      if (app.key === 'wordpress') result = installWordPress(args);
      else if (app.key === 'nextcloud') result = installNextcloud(args);
      else result = installApp(app.key, args);
      if (!result || !result.ok) {
        return appsError(ctx, `Nie udało się zainstalować ${app.name}: ${result?.error || 'nieznany błąd instalatora'}`);
      }
      try { apply({ web: true }); } catch { /* wdrożenie zapisze błąd w statusie, instalacja jest już wykonana */ }
      audit(ctx.user.username, 'reseller', 'app.install', `${app.key}:${customer.username}:${domain.name}`, ctx.ip);
      const token = stashInstallResult({
        app: app.key,
        name: app.name,
        user: customer.username,
        domain: domain.name,
        ...result,
        mode: result.mode || (app.key === 'wordpress' || app.key === 'nextcloud' ? 'native' : 'web'),
      });
      return ctx.redirect(`${R}/apps?install=${token}&flash=${encodeURIComponent(`${app.name} zainstalowany — zapisz dane dostępowe.`)}`);
    } catch (error) {
      return appsError(ctx, `Instalacja ${app.name} nie powiodła się: ${error.message}`);
    }
  });

  router.get('/reseller/users', (ctx) => usersPage(ctx, { path: `${R}/users` }));
  router.get('/reseller/users/suspended', (ctx) => usersPage(ctx, { path: `${R}/users`, suspended: 1, title: 'Suspended Users' }));
  router.get('/reseller/users/create', (ctx) => userForm(ctx, { path: `${R}/users`, packages: all("SELECT * FROM packages WHERE type = 'user'") }));
  router.post('/reseller/users/create', (ctx) => createUser(ctx, { path: `${R}/users`, level: 'user', owner: ctx.user.username }));
  router.get('/reseller/users/move', (ctx) => {
    const users = visibleUsers(ctx.user, { level: 'user' });
    const packages = all("SELECT * FROM packages WHERE type = 'user' AND (owner IS NULL OR owner = ?) ORDER BY name", ctx.user.username);
    const body = h`${card('Przenoszenie klientów', users.length ? h`<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Klient</th><th>Pakiet</th><th>Nowy pakiet</th></tr></thead>
      <tbody>${users.map((user) => h`<tr>
        <td><a class="cell-strong" href="/reseller/users/${user.id}">${user.username}</a><span class="cell-sub">${user.email || '—'}</span></td>
        <td>${badge(user.package || 'default', 'brand')}</td>
        <td><form method="post" action="${R}/users/${user.id}/move" class="inline" style="display:flex;gap:6px;align-items:center">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <select name="package" style="height:30px;width:180px">${packages.map((pkg) => h`<option ${pkg.name === user.package ? 'selected' : ''}>${pkg.name}</option>`)}</select>
          <button class="btn btn-secondary btn-sm" type="submit">Przenieś</button>
        </form></td>
      </tr>`)}</tbody>
    </table></div>` : emptyState('Brak klientów do przeniesienia.', { icon: 'users' }), {
      sub: 'Zmiana pakietu nie usuwa danych — nowe limity obowiązują od razu',
      padded: users.length === 0,
    })}`;
    return page(ctx, { title: 'Przenoszenie klientów', subtitle: 'Zmiana pakietu lub przypisania konta', body, counts: countForNav(ctx.user, 'reseller') });
  });
  router.post('/reseller/users/:id/move', (ctx) => {
    const user = get('SELECT * FROM users WHERE id = ?', Number(ctx.params.id));
    if (!canManageUser(ctx.user, user)) return ctx.redirect(`${R}/users?flash=Access%20denied&type=error`);
    const pkg = get('SELECT name FROM packages WHERE name = ? AND type = ?', String(ctx.body.package || ''), 'user');
    if (pkg) run('UPDATE users SET package = ? WHERE id = ?', pkg.name, user.id);
    return ctx.redirect(`${R}/users?flash=Klient%20przeniesiony`);
  });

  router.get('/reseller/users/:id', (ctx) => {
    const user = get('SELECT * FROM users WHERE id = ?', Number(ctx.params.id));
    if (!canManageUser(ctx.user, user)) return ctx.redirect(`${R}/users?flash=Access%20denied&type=error`);
    return userDetailPage(ctx, { path: `${R}/users`, target: user });
  });
  router.post('/reseller/users/:id', (ctx) => {
    const user = get('SELECT * FROM users WHERE id = ?', Number(ctx.params.id));
    if (!canManageUser(ctx.user, user)) return ctx.redirect(`${R}/users?flash=Access%20denied&type=error`);
    return updateUser(ctx, { path: `${R}/users`, target: user });
  });
  router.post('/reseller/users/:id/suspend', (ctx) => {
    const user = get('SELECT * FROM users WHERE id = ?', Number(ctx.params.id));
    if (!canManageUser(ctx.user, user)) return ctx.redirect(`${R}/users?flash=Access%20denied&type=error`);
    return toggleSuspend(ctx, { path: `${R}/users`, target: user });
  });
  router.post('/reseller/users/:id/delete', (ctx) => {
    const user = get('SELECT * FROM users WHERE id = ?', Number(ctx.params.id));
    if (!canManageUser(ctx.user, user)) return ctx.redirect(`${R}/users?flash=Access%20denied&type=error`);
    return deleteUser(ctx, { path: `${R}/users`, target: user });
  });

  // Resellers may open their own customers' panels. Ownership is re-checked on
  // every request, and the confirmation GET keeps this action CSRF-safe while
  // still fixing the "Sign in as user" link rendered by the shared user page.
  router.get('/reseller/users/:id/login-as', (ctx) => {
    const user = get('SELECT * FROM users WHERE id = ?', Number(ctx.params.id));
    if (!user || user.level !== 'user' || !canManageUser(ctx.user, user)) {
      return ctx.redirect(`${R}/users?flash=${encodeURIComponent('Możesz otworzyć panel tylko swojego klienta.')}&type=error`);
    }
    if (user.suspended) {
      return ctx.redirect(`${R}/users/${user.id}?flash=${encodeURIComponent('Konto klienta jest zawieszone.')}&type=error`);
    }
    const body = h`${card('Zaloguj się jako klient', h`
      <p>Otworzysz panel użytkownika <strong>${user.username}</strong> (${user.email || 'brak adresu e-mail'}).</p>
      ${alert('Ta operacja zostanie zapisana w dzienniku audytu. Po zakończeniu pracy wyloguj się i zaloguj ponownie jako reseller.', 'warn')}
      <div class="row mt-18">
        <form method="post" action="${R}/users/${user.id}/login-as" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <button class="btn btn-primary" type="submit">${icon('logout', { size: 16 })} Zaloguj jako ${user.username}</button></form>
        <a class="btn btn-ghost" href="/reseller/users/${user.id}">Anuluj</a>
      </div>`)}`;
    return page(ctx, { title: 'Zaloguj jako klienta', subtitle: user.username, body, counts: countForNav(ctx.user, 'reseller') });
  });
  router.post('/reseller/users/:id/login-as', (ctx) => {
    const user = get('SELECT * FROM users WHERE id = ?', Number(ctx.params.id));
    if (!user || user.level !== 'user' || !canManageUser(ctx.user, user)) {
      return ctx.redirect(`${R}/users?flash=${encodeURIComponent('Możesz otworzyć panel tylko swojego klienta.')}&type=error`);
    }
    if (user.suspended) return ctx.redirect(`${R}/users/${user.id}?flash=${encodeURIComponent('Konto klienta jest zawieszone.')}&type=error`);
    const actor = ctx.cookies['OA_SESSION'];
    const result = startImpersonation(ctx.user, user.id, {
      ip: ctx.ip, ua: ctx.req.headers['user-agent'], actorSessionToken: actor, readOnly: true,
    });
    if (!result.ok) return ctx.redirect(`${R}/users/${user.id}?flash=${encodeURIComponent(result.error)}&type=error`);
    ctx.res.setHeader('Set-Cookie', [
      serializeCookie(result.token, { secure: config.https }),
      previewActorCookie(actor, { secure: config.https }),
    ]);
    return ctx.redirect(`/user?flash=${encodeURIComponent(`Podglądasz konto ${user.username} (tylko do odczytu)`)}`);
  });

  router.get('/reseller/packages', (ctx) => packagesPage(ctx, { owner: ctx.user.username, type: 'user', path: `${R}/packages` }));
  router.get('/reseller/packages/create', (ctx) => packageForm(ctx, { path: `${R}/packages`, type: 'user' }));
  router.post('/reseller/packages/create', (ctx) => savePackage(ctx, { type: 'user', owner: ctx.user.username, path: `${R}/packages` }));
  router.get('/reseller/packages/:name', (ctx) => {
    const pkg = get('SELECT * FROM packages WHERE name = ? AND type = ?', ctx.params.name, 'user');
    if (!pkg || (pkg.owner && pkg.owner !== ctx.user.username)) {
      return ctx.redirect(`${R}/packages?flash=${encodeURIComponent('Nie możesz edytować tego pakietu.')}&type=error`);
    }
    return packageForm(ctx, { path: `${R}/packages`, type: 'user', existing: pkg });
  });
  router.post('/reseller/packages/:name', (ctx) => {
    const pkg = get('SELECT * FROM packages WHERE name = ? AND type = ?', ctx.params.name, 'user');
    if (!pkg || (pkg.owner && pkg.owner !== ctx.user.username)) {
      return ctx.redirect(`${R}/packages?flash=${encodeURIComponent('Nie możesz edytować tego pakietu.')}&type=error`);
    }
    return savePackage(ctx, { type: 'user', owner: ctx.user.username, path: `${R}/packages` });
  });
  router.post('/reseller/packages/:name/copy', (ctx) => {
    const pkg = get('SELECT * FROM packages WHERE name = ? AND type = ?', ctx.params.name, 'user');
    if (!pkg || (pkg.owner && pkg.owner !== ctx.user.username)) {
      return ctx.redirect(`${R}/packages?flash=${encodeURIComponent('Nie możesz skopiować tego pakietu.')}&type=error`);
    }
    const name = `${pkg.name}_copy${Math.floor(Math.random() * 90 + 10)}`;
    run('INSERT INTO packages(name, owner, type, limits, created_at) VALUES(?,?,?,?,?)', name, ctx.user.username, pkg.type, pkg.limits, nowIso());
    return ctx.redirect(`${R}/packages?flash=Pakiet%20skopiowany`);
  });
  router.post('/reseller/packages/:name/delete', (ctx) => {
    const inUse = get('SELECT COUNT(*) n FROM users WHERE package = ?', ctx.params.name).n;
    if (!inUse) run('DELETE FROM packages WHERE name = ? AND owner = ?', ctx.params.name, ctx.user.username);
    return ctx.redirect(`${R}/packages?flash=` + encodeURIComponent(inUse ? 'Pakiet jest w użyciu' : 'Pakiet usunięty'));
  });

  router.get('/reseller/statistics', (ctx) => resellerStatistics(ctx));
  router.get('/reseller/dns', (ctx) => resellerDns(ctx));
  router.post('/reseller/dns/add', (ctx) => {
    const domain = domainFor(ctx.user, ctx.body.domain);
    if (!domain) return ctx.redirect(`${R}/dns?flash=Nie%20znaleziono%20domeny&type=error`);
    run('INSERT INTO dns_records(domain_id, name, type, value, priority, ttl) VALUES(?,?,?,?,?,?)',
      domain.id, String(ctx.body.name || '@') || '@', String(ctx.body.type || 'A').toUpperCase(), String(ctx.body.value || ''),
      ctx.body.priority ? Number(ctx.body.priority) : null, Number(ctx.body.ttl) || 3600);
    rebuildZone(domain.name); apply({ dns: true });
    audit(ctx.user.username, 'reseller', 'dns.create', domain.name, ctx.ip);
    return ctx.redirect(`${R}/dns?domain=${encodeURIComponent(domain.name)}&flash=Rekord%20dodany`);
  });
  router.post('/reseller/dns/:id/update', (ctx) => {
    const record = get('SELECT * FROM dns_records WHERE id = ?', Number(ctx.params.id));
    const domain = record ? domainFor(ctx.user, record.domain_id) : null;
    if (!domain) return ctx.redirect(`${R}/dns?flash=Nie%20znaleziono%20rekordu&type=error`);
    run('UPDATE dns_records SET name=?, type=?, value=?, priority=?, ttl=? WHERE id=?',
      String(ctx.body.name || '@'), String(ctx.body.type || record.type).toUpperCase(), String(ctx.body.value || ''),
      ctx.body.priority ? Number(ctx.body.priority) : null, Number(ctx.body.ttl) || record.ttl, record.id);
    rebuildZone(domain.name); apply({ dns: true });
    audit(ctx.user.username, 'reseller', 'dns.update', `${domain.name} #${record.id}`, ctx.ip);
    return ctx.redirect(`${R}/dns?domain=${encodeURIComponent(domain.name)}&flash=Rekord%20zaktualizowany`);
  });
  router.post('/reseller/dns/:id/delete', (ctx) => {
    const record = get('SELECT * FROM dns_records WHERE id = ?', Number(ctx.params.id));
    const domain = record ? domainFor(ctx.user, record.domain_id) : null;
    if (domain) { run('DELETE FROM dns_records WHERE id = ?', record.id); rebuildZone(domain.name); apply({ dns: true }); }
    audit(ctx.user.username, 'reseller', 'dns.delete', domain?.name || String(ctx.params.id), ctx.ip);
    return ctx.redirect(`${R}/dns?domain=${encodeURIComponent(domain?.name || '')}&flash=Rekord%20usuni%C4%99ty`);
  });

  router.get('/reseller/ip-manager', (ctx) => resellerIps(ctx));
  router.post('/reseller/ip-manager/:id/release', (ctx) => {
    run("UPDATE ips SET owner = NULL, status = 'shared' WHERE id = ? AND owner = ?", Number(ctx.params.id), ctx.user.username);
    return ctx.redirect(`${R}/ip-manager?flash=Adres%20IP%20zwolniony`);
  });

  router.get('/reseller/nameservers', (ctx) => {
    const body = h`${card('Serwery nazw', h`
      <p class="small muted mb-18">Te serwery nazw są przekazywane Twoim klientom. Muszą być zarejestrowane jako rekordy glue u rejestratora domen.</p>
      ${kvList([['Główny', setting('ns1', 'ns1.localhost')], ['Zapasowy', setting('ns2', 'ns2.localhost')], ['IP serwera', setting('server_ip', '127.0.0.1')]])}
      <p class="small muted mt-18">Klienci powinni utworzyć rekordy NS wskazujące na te nazwy hostów.</p>`)}
      ${card('Szablony DNS', h`${kvList([['Domyślny szablon strefy', '/usr/local/directadmin/data/templates/dns_default.conf'], ['TTL', '3600'], ['E-mail', 'postmaster@domena']])}`)}`;
    return page(ctx, { title: 'Serwery nazw', subtitle: 'Infrastruktura DNS Twojego resellera', body, counts: countForNav(ctx.user, 'reseller') });
  });

  router.get('/reseller/backups', (ctx) => {
    const rows = all(`SELECT b.*, u.username FROM backups b JOIN users u ON u.id = b.user_id
      WHERE u.owner = ? OR ? IS NULL ORDER BY b.created_at DESC`, ctx.user.username, ownerScope(ctx.user));
    const body = h`${card('Kopie zapasowe klientów', table({
      columns: [
        { label: 'Klient', render: (backup) => h`<a class="link" href="/reseller/users/${backup.user_id}">${backup.username}</a>` },
        { label: 'Plik', render: (backup) => h`<span class="cell-mono">${backup.filename}</span>` },
        { label: 'Rozmiar', render: (backup) => formatBytes(backup.size_mb), align: 'right' },
        { label: 'Utworzono', render: (backup) => datePl(backup.created_at, { time: true }) },
        { label: 'Status', render: (backup) => backupStateBadge(backup.status) },
      ],
      rows,
      empty: 'Klienci nie mają jeszcze kopii zapasowych.',
    }), { sub: `${rows.length} ${plural(rows.length, 'archiwum', 'archiwa', 'archiwów')}` })}`;
    return page(ctx, { title: 'Kopie zapasowe klientów', subtitle: 'Archiwum kont, którymi zarządzasz', body, counts: countForNav(ctx.user, 'reseller') });
  });

  router.get('/reseller/tickets', (ctx) => resellerTickets(ctx));
  router.get('/reseller/tickets/:id', (ctx) => ticketView(ctx, ctx.params.id, `${R}/tickets`));
  router.post('/reseller/tickets/:id/reply', (ctx) => {
    const ticket = get('SELECT * FROM tickets WHERE id = ?', Number(ctx.params.id));
    if (!canManageTicket(ctx.user, ticket)) {
      return ctx.redirect(`${R}/tickets?flash=${encodeURIComponent('Nie znaleziono zgłoszenia lub nie należy do Twojego klienta.')}&type=error`);
    }
    if (String(ctx.body.message || '').trim()) {
      run('INSERT INTO ticket_messages(ticket_id, author, level, body, created_at) VALUES(?,?,?,?,?)', ticket.id, ctx.user.username, 'reseller', String(ctx.body.message), nowIso());
      run('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?', 'answered', nowIso(), ticket.id);
    }
    return ctx.redirect(`${R}/tickets/${ctx.params.id}?flash=Odpowied%C5%BA%20wys%C5%82ana`);
  });
  router.post('/reseller/tickets/:id/close', (ctx) => {
    const ticket = get('SELECT * FROM tickets WHERE id = ?', Number(ctx.params.id));
    if (!canManageTicket(ctx.user, ticket)) {
      return ctx.redirect(`${R}/tickets?flash=${encodeURIComponent('Nie znaleziono zgłoszenia lub nie należy do Twojego klienta.')}&type=error`);
    }
    run("UPDATE tickets SET status = 'closed', updated_at = ? WHERE id = ?", nowIso(), ticket.id);
    return ctx.redirect(`${R}/tickets/${ticket.id}?flash=Zg%C5%82oszenie%20zamkni%C4%99te`);
  });

  router.get('/reseller/messages', (ctx) => {
    const rows = all("SELECT * FROM messages WHERE level = 'reseller' AND (username = ? OR username IS NULL) ORDER BY created_at DESC", ctx.user.username);
    const body = h`${card('Wiadomości', h`${rows.length ? h`<div class="timeline">${rows.map((message) => h`<div class="timeline-item"><div class="timeline-dot">${icon('bell', { size: 15 })}</div>
      <div class="timeline-body"><strong>${message.subject}</strong><p class="small muted">${message.body}</p><small>${relTime(message.created_at)}</small></div></div>`)}</div>` : emptyState('Brak wiadomości od administratora.', { icon: 'bell' })}`)}`;
    return page(ctx, { title: 'Wiadomości', subtitle: 'Komunikaty od administratora serwera', body, counts: countForNav(ctx.user, 'reseller') });
  });

  router.get('/reseller/settings', (ctx) => {
    const body = h`${card('Ustawienia resellera', h`<form method="post" action="/reseller/settings" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid">
        <div class="field"><label class="field-label">E-mail</label><input name="email" type="email" value="${ctx.user.email || ''}"></div>
        <div class="field"><label class="field-label">Język</label><select name="language"><option value="pl">Polski</option><option value="en">English</option><option value="de">Deutsch</option></select></div>
        <div class="field"><label class="field-label">Domyślny pakiet klienta</label><select name="default_package">${all("SELECT * FROM packages WHERE type = 'user'").map((pkg) => h`<option>${pkg.name}</option>`)}</select></div>
        <div class="field"><label class="field-label">Powiadamiaj o nowym kliencie</label><select name="notify"><option value="1">Tak</option><option value="0">Nie</option></select></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Zapisz ustawienia</button>
        <a class="btn btn-ghost" href="/user/password">Zmień hasło</a></div>
    </form>`)}
    ${card('Konto', h`${kvList([['Nazwa użytkownika', ctx.user.username], ['Poziom', 'Reseller'], ['Pakiet', ctx.user.package], ['Utworzono', datePl(ctx.user.created_at)]])}`)}`;
    return page(ctx, { title: 'Ustawienia resellera', subtitle: 'Preferencje Twojego konta', body, counts: countForNav(ctx.user, 'reseller') });
  });
  router.post('/reseller/settings', (ctx) => {
    run('UPDATE users SET email = ? WHERE id = ?', String(ctx.body.email || ctx.user.email), ctx.user.id);
    return ctx.redirect('/reseller/settings?flash=Ustawienia%20zapisane');
  });
}
