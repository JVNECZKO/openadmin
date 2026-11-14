// Dashboard for the User level. A single, dense overview: live server state,
// onboarding, real apps, quota meters and recent activity — no duplicate cards.
import fs from 'node:fs';
import path from 'node:path';
import { all, get } from '../db.mjs';
import { userHome } from '../paths.mjs';
import { limitsFor } from '../auth.mjs';
import { html as h, formatBytes, safeJson } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, statCard, btn, badge, emptyState, alert, sparkline } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { appIcon, appName } from '../ui/appicons.mjs';
import { greeting } from '../ui/pages/widgets.mjs';
import { visibleDomains, storageFor, usageSeries, countForNav } from '../core/access.mjs';

const APPS = [
  { key: 'wordpress', name: 'WordPress', desc: 'Strona, blog lub sklep' },
  { key: 'nextcloud', name: 'Nextcloud', desc: 'Prywatna chmura i pliki' },
  { key: 'prestashop', name: 'PrestaShop', desc: 'Sklep internetowy' },
  { key: 'joomla', name: 'Joomla', desc: 'CMS i portal' },
  { key: 'drupal', name: 'Drupal', desc: 'CMS i portal' },
  { key: 'moodle', name: 'Moodle', desc: 'Platforma e-learning' },
];

const AUDIT_LABELS = {
  login: ['Logowanie do panelu', 'user'],
  'login.2fa': ['Logowanie z weryfikacją dwuetapową', 'shield'],
  logout: ['Wylogowanie z panelu', 'logout'],
  'password.change': ['Zmieniono hasło', 'key'],
  'password.reset.request': ['Zgłoszono reset hasła', 'key'],
  'site.create': ['Utworzono stronę automatycznie', 'rocket'],
  'site.ensure': ['Sprawdzono konfigurację strony', 'refresh'],
  'site.redeploy': ['Wdrożono stronę ponownie', 'refresh'],
  'site.create.rejected': ['Odrzucono konfigurację strony', 'alert'],
  'subdomain.create': ['Dodano subdomenę', 'network'],
  'subdomain.update': ['Zmieniono subdomenę', 'network'],
  'dns.create': ['Dodano rekord DNS', 'dns'],
  'dns.update': ['Zmieniono rekord DNS', 'dns'],
  'ticket.create': ['Nowe zgłoszenie', 'ticket'],
  'webdisk.create': ['Utworzono konto WebDisk', 'cloud'],
  'wordpress.install': ['Zainstalowano WordPress', 'paint'],
  'wordpress.delete': ['Usunięto WordPress', 'trash'],
  'nextcloud.install': ['Zainstalowano Nextcloud', 'cloud'],
  'nextcloud.delete': ['Usunięto Nextcloud', 'trash'],
  'ssl.issue': ['Wystawiono certyfikat SSL', 'lock'],
  'ssl.renew': ['Odnowiono certyfikat SSL', 'refresh'],
  'backup.create': ['Utworzono kopię zapasową', 'archive'],
  'backup.restore': ['Przywrócono kopię zapasową', 'refresh'],
  'database.create': ['Utworzono bazę danych', 'database'],
  'database.delete': ['Usunięto bazę danych', 'trash'],
  'domain.create': ['Dodano domenę', 'globe'],
  'domain.delete': ['Usunięto domenę', 'trash'],
  'email.create': ['Utworzono skrzynkę e-mail', 'mail'],
  'ftp.create': ['Utworzono konto FTP', 'upload'],
  'cron.create': ['Dodano zadanie cron', 'clock'],
};

const AUDIT_HREFS = [
  [/^wordpress\.|^nextcloud\./, '/user/app-catalog#twoje-aplikacje'],
  [/^site\./, '/user/domains'],
  [/^subdomain\./, '/user/subdomains'],
  [/^dns\./, '/user/dns'],
  [/^ticket\./, '/user/tickets'],
  [/^webdisk\./, '/user/webdisk'],
  [/^ssl\./, '/user/ssl'],
  [/^backup\./, '/user/backups'],
  [/^database\./, '/user/databases'],
  [/^domain\./, '/user/domains'],
  [/^email\./, '/user/email'],
  [/^ftp\./, '/user/ftp'],
  [/^cron\./, '/user/cron'],
];

const SCHEDULE_LABELS = { hourly: 'co godzinę', daily: 'codziennie', weekly: 'co tydzień', monthly: 'co miesiąc' };

function dateTimePl(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('pl-PL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function percentTone(used, limit) {
  const total = Number(limit) || 0;
  if (!total) return 'ok';
  const p = (Number(used) || 0) / total * 100;
  return p >= 90 ? 'danger' : p >= 75 ? 'warn' : 'ok';
}

function resourceMeter({ key, label, used, limit, format = String, href = '' }) {
  const total = Number(limit) || 0;
  const limited = total > 0;
  const rawPercent = limited ? Math.round((Number(used) || 0) / total * 100) : null;
  const barPercent = limited ? Math.min(100, Math.max(0, rawPercent)) : 0;
  const [state, tone] = !limited
    ? ['Bez limitu', 'muted']
    : rawPercent > 100
      ? ['Limit przekroczony', 'danger']
      : rawPercent >= 90
        ? ['Prawie pełny', 'danger']
        : rawPercent >= 75
          ? ['Blisko limitu', 'warn']
          : ['W normie', 'ok'];
  return h`<div class="quota-row" data-resource-meter="${key}" data-resource-state="${state}">
    <div class="spread">
      <span class="small" style="font-weight:600">${href ? h`<a class="link" href="${href}">${label}</a>` : label}</span>
      ${badge(state, tone)}
    </div>
    ${limited ? h`<div class="progress ${tone === 'warn' ? 'warn' : tone === 'danger' ? 'danger' : ''}" role="progressbar" aria-label="${label}" aria-valuenow="${Math.min(100, rawPercent)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${barPercent}%"></span></div>` : ''}
    <div class="progress-text"><span>${format(used)}${limited ? ' / ' + format(limit) : ''}</span><span>${limited ? rawPercent + '%' : 'bez limitu'}</span></div>
  </div>`;
}

function usageCard(series) {
  const points = series.map((row) => Number(row.bandwidth_mb) || 0);
  const total = points.reduce((sum, value) => sum + value, 0);
  const peak = points.length ? Math.max(...points) : 0;
  const body = points.length
    ? h`
      <div class="spread mb-12">
        <div><div class="stat-value">${formatBytes(total)}</div><div class="small muted">łącznie · średnio ${formatBytes(total / Math.max(points.length, 1))}/dzień</div></div>
        <div class="ta-r"><div class="stat-value">${formatBytes(peak)}</div><div class="small muted">dzień szczytowy</div></div>
      </div>
      ${sparkline(points)}
      <div class="spread small muted mt-10"><span>${series[0]?.day || ''}</span><span>${series.at(-1)?.day || ''}</span></div>`
    : emptyState('Brak danych o transferze. Pojawią się po pierwszym okresie rozliczeniowym.', { icon: 'chart' });
  return card('Transfer', body, {
    sub: 'Ostatnie 30 dni',
    actions: [h`<a class="link small" href="/user/statistics">Statystyki →</a>`],
  });
}

function recentActivity(ctx, { appInstalls, wpRows, backups, tickets }) {
  const u = ctx.user;
  const audit = all('SELECT * FROM audit_log WHERE actor = ? ORDER BY created_at DESC LIMIT 12', u.username);
  const items = [];

  for (const row of audit) {
    const [label, iconName] = AUDIT_LABELS[row.action] || [String(row.action || 'Akcja').replace(/[._]/g, ' '), 'activity'];
    const href = AUDIT_HREFS.find(([pattern]) => pattern.test(String(row.action || '')))?.[1] || '';
    items.push({ at: row.created_at, icon: iconName, title: label, meta: row.target || '', href });
  }
  for (const row of appInstalls) {
    items.push({
      at: row.created_at,
      icon: 'download',
      title: `Zainstalowano ${appName(row.type)}`,
      meta: `${row.domain}${row.path && row.path !== '/' ? row.path : ''}`,
      href: '/user/app-catalog#twoje-aplikacje',
    });
  }
  for (const row of wpRows) {
    items.push({
      at: row.created_at,
      icon: 'paint',
      title: 'WordPress gotowy do pracy',
      meta: `${row.domain}${row.path && row.path !== '/' ? row.path : ''}`,
      href: '/user/wordpress',
    });
  }
  for (const row of backups) {
    items.push({ at: row.created_at, icon: 'archive', title: 'Kopia zapasowa', meta: row.filename, href: '/user/backups' });
  }
  for (const row of tickets) {
    items.push({ at: row.updated_at || row.created_at, icon: 'ticket', title: `Zgłoszenie: ${row.subject}`, meta: row.status || '', href: '/user/tickets' });
  }

  const seen = new Set();
  const latest = items
    .filter((item) => {
      const key = `${item.title}|${item.meta}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 6);

  return card('Ostatnia aktywność', latest.length
    ? h`<div class="timeline" data-recent-activity>${latest.map((item) => h`<div class="timeline-item">
        <div class="timeline-dot">${icon(item.icon, { size: 15 })}</div>
        <div class="timeline-body">
          <div>${item.href ? h`<a class="link" href="${item.href}">${item.title}</a>` : item.title}</div>
          <small>${item.meta ? h`${item.meta} · ` : ''}${dateTimePl(item.at)}</small>
        </div>
      </div>`)}</div>`
    : emptyState('Brak ostatniej aktywności. Twoje instalacje, kopie i zmiany pojawią się tutaj.', { icon: 'activity' }), {
    sub: 'Instalacje, kopie i zmiany na koncie',
    actions: [h`<a class="link small" href="/user/statistics">Statystyki →</a>`],
  });
}

function automationCard(u) {
  const acmeRow = get('SELECT value FROM settings WHERE key = ?', `acme_${u.username}`);
  const acme = acmeRow ? safeJson(acmeRow.value, null) : null;
  const acmeConfigured = !!(acme && typeof acme === 'object' && Object.keys(acme).length);
  const acmeOn = acmeConfigured && String(acme.autorenew ?? '') === '1';
  const acmeTone = acmeOn ? 'ok' : acmeConfigured ? 'warn' : 'muted';
  const acmeLabel = acmeOn ? 'Włączone' : acmeConfigured ? 'Wyłączone' : 'Nieskonfigurowane';
  const backupJob = get("SELECT * FROM backup_jobs WHERE scope = 'user' AND target_user = ? AND enabled = 1 ORDER BY id DESC LIMIT 1", u.username);
  const backupStatus = backupJob
    ? (backupJob.last_status === 'ok' ? ['Działa', 'ok'] : backupJob.last_status === 'failed' ? ['Ostatni błąd', 'danger'] : ['Zaplanowane', 'brand'])
    : ['Ręczne', 'muted'];

  return card('Automatyzacje', h`
    <div class="timeline" data-automation-card>
      <div class="timeline-item">
        <div class="timeline-dot">${icon('lock', { size: 15 })}</div>
        <div class="timeline-body">
          <div class="spread"><strong>Odnawianie SSL (ACME)</strong>${badge(acmeLabel, acmeTone, { dot: true })}</div>
          <small>${acmeConfigured ? `Auto-odnawianie: ${acmeOn ? 'włączone' : 'wyłączone'}${acme.challenge ? ' · ' + acme.challenge : ''}` : 'Ustaw challenge i auto-renew, aby certyfikaty odnawiały się same.'}</small>
          <div class="mt-10"><a class="link small" href="/user/ssl?tab=acme">Ustawienia ACME →</a></div>
        </div>
      </div>
      <div class="timeline-item">
        <div class="timeline-dot">${icon('archive', { size: 15 })}</div>
        <div class="timeline-body">
          <div class="spread"><strong>Kopie zapasowe</strong>${badge(backupStatus[0], backupStatus[1], { dot: true })}</div>
          <small>${backupJob ? `${SCHEDULE_LABELS[backupJob.schedule] || backupJob.schedule}${backupJob.last_run_at ? ' · ostatnio ' + dateTimePl(backupJob.last_run_at) : ' · jeszcze nie uruchamiano'}` : 'Brak zadania automatycznego dla tego konta — kopię utworzysz ręcznie.'}</small>
          <div class="mt-10"><a class="link small" href="/user/backups">Kopie zapasowe →</a></div>
        </div>
      </div>
    </div>`, { sub: 'Realny stan z panelu' });
}

export function userDashboard(ctx) {
  const u = ctx.user;
  const pl = (u.language || 'pl') === 'pl';
  const L = (en, plText) => (pl ? plText : en);
  const domains = visibleDomains(ctx.user);
  const emails = all('SELECT * FROM email_accounts WHERE domain IN (SELECT name FROM domains WHERE user_id = ?) ORDER BY used_mb DESC LIMIT 5', u.id);
  const emailCount = get('SELECT COUNT(*) n FROM email_accounts WHERE domain IN (SELECT name FROM domains WHERE user_id = ?)', u.id).n;
  const series = usageSeries(u.username, 30);
  const limits = limitsFor(u);
  const storage = storageFor(u, 'user');
  const bw30 = series.reduce((a, r) => a + (r.bandwidth_mb || 0), 0);
  const ftp = get('SELECT COUNT(*) n FROM ftp_accounts WHERE user_id = ?', u.id).n;
  const dbs = get('SELECT COUNT(*) n FROM databases WHERE user_id = ?', u.id).n;
  const sslCount = get('SELECT COUNT(*) n FROM ssl_certs WHERE username = ?', u.username).n;
  const backups = all('SELECT * FROM backups WHERE user_id = ? ORDER BY created_at DESC LIMIT 4', u.id);
  const tickets = all('SELECT * FROM tickets WHERE user_id = ? ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 3', u.id);
  const msg = get('SELECT * FROM messages WHERE (username = ? OR username IS NULL) AND read_at IS NULL ORDER BY created_at DESC LIMIT 1', u.username);
  const home = userHome(u.username);
  const siteReady = domains.some((d) => {
    const root = d.docroot && d.docroot.startsWith(home) ? d.docroot : path.join(home, 'domains', d.name, 'public_html');
    return ['index.php', 'index.html', 'index.htm'].some((f) => { try { return fs.existsSync(path.join(root, f)); } catch { return false; } });
  });
  const backupCount = get('SELECT COUNT(*) n FROM backups WHERE user_id = ?', u.id).n;
  const twofaOn = get('SELECT twofa_enabled e FROM users WHERE id = ?', u.id)?.e === 1;
  const wpRows = all('SELECT * FROM wordpress WHERE domain IN (SELECT name FROM domains WHERE user_id = ?) ORDER BY created_at DESC', u.id);
  const appInstalls = all('SELECT * FROM app_installs WHERE user_id = ? ORDER BY created_at DESC', u.id);
  const appTypeCounts = appInstalls.reduce((acc, row) => { acc[row.type] = (acc[row.type] || 0) + 1; return acc; }, {});
  const appCounts = {
    wordpress: wpRows.length,
    nextcloud: appTypeCounts.nextcloud || 0,
    prestashop: appTypeCounts.prestashop || 0,
    joomla: appTypeCounts.joomla || 0,
    drupal: appTypeCounts.drupal || 0,
    moodle: appTypeCounts.moodle || 0,
  };
  const appTotal = Object.values(appCounts).reduce((sum, count) => sum + count, 0);

  const steps = [
    { done: domains.length > 0, label: 'Dodaj domenę', href: '/user/domains/create' },
    { done: siteReady || wpRows.length > 0, label: 'Postaw stronę (kreator)', href: '/user/websites/new' },
    { done: sslCount > 0, label: 'Włącz certyfikat SSL', href: '/user/ssl' },
    { done: emailCount > 0, label: 'Utwórz skrzynkę e-mail', href: '/user/email/new' },
    { done: backupCount > 0, label: 'Zrób pierwszą kopię zapasową', href: '/user/backups' },
    { done: twofaOn, label: 'Włącz weryfikację dwuetapową', href: '/user/2fa' },
  ];
  const stepsDone = steps.filter((step) => step.done).length;
  const nextStep = steps.findIndex((step) => !step.done);
  const now = new Date().toISOString();
  const serverName = get('SELECT value FROM settings WHERE key = ?', 'server_name')?.value || 'localhost';
  const recent = recentActivity(ctx, { appInstalls, wpRows, backups, tickets });

  const body = h`
    <div class="hero">
      <div>
        <div class="row" style="gap:8px;margin-bottom:8px">
          ${badge(L('Package: ', 'Pakiet: ') + (u.package || 'default'), 'brand')}
          ${badge(u.suspended ? L('Suspended', 'Zawieszona') : L('Active', 'Aktywna'), u.suspended ? 'danger' : 'ok', { dot: true })}
          ${badge(L('Free license', 'Darmowa licencja'), 'ok')}
        </div>
        <h2>${pl ? `Dzień dobry, ${u.username}` : greeting(u)}</h2>
        <p>${L('Your account is hosted on', 'Twoje konto jest na serwerze')} <strong>${serverName}</strong>. ${L('Everything below is included — no add-ons, no per-domain fees.', 'Wszystko poniżej jest w cenie — bez dodatkowych opłat za domeny.')}</p>
        <div class="row mt-18">
          ${btn(L('Launch site wizard', 'Postaw stronę'), { href: '/user/websites/new', icon: 'rocket' })}
          ${btn(L('Add mailbox', 'Dodaj pocztę'), { href: '/user/email/new', icon: 'mail', variant: 'secondary' })}
          ${btn(L('Applications', 'Aplikacje'), { href: '/user/app-catalog', icon: 'cart', variant: 'secondary' })}
        </div>
      </div>
      <div class="hero-actions">
        ${badge(L('Domain, vhost, DNS and SSL in one wizard', 'Domena, vhost, DNS i SSL w jednym kreatorze'), 'ok', { dot: true })}
      </div>
    </div>

    <div class="spread mb-18" id="user-live-status" data-auto-refresh="60" data-auto-refresh-unit="seconds" data-live-url="/user" data-live-scope="dashboard">
      <div class="row" style="gap:8px">
        ${badge(L('Online', 'Online'), 'ok', { dot: true })}
        <span class="small muted">${L('Updated', 'Zaktualizowano')} <time datetime="${now}">${dateTimePl(now)}</time></span>
      </div>
      <a class="link small" href="/user" data-live-refresh>${icon('refresh', { size: 14 })} ${L('Refresh', 'Odśwież dane')}</a>
    </div>

    ${msg ? alert(h`<strong>${msg.subject}</strong><br>${msg.body}`, 'info') : ''}

    <div class="stat-grid">
      ${statCard({ label: L('Domains', 'Domeny'), value: `${domains.length}${limits.domains ? ' / ' + limits.domains : ''}`, sub: L('active domains', 'aktywne domeny'), icon: 'globe', href: '/user/domains' })}
      ${statCard({ label: L('Email accounts', 'Skrzynki e-mail'), value: `${emailCount}${limits.emails ? ' / ' + limits.emails : ''}`, sub: L('mailboxes', 'skrzynki'), icon: 'mail', href: '/user/email' })}
      ${statCard({ label: L('Disk usage', 'Użycie dysku'), value: formatBytes(storage.used), sub: limits.disk_mb ? `${L('of', 'z')} ${formatBytes(limits.disk_mb)} · ${storage.percent}%` : L('unlimited', 'bez limitu'), icon: 'database', tone: percentTone(storage.used, limits.disk_mb), href: '/user/statistics' })}
      ${statCard({ label: L('Bandwidth (30d)', 'Transfer (30 dni)'), value: formatBytes(bw30), sub: limits.bandwidth_mb ? `${L('of', 'z')} ${formatBytes(limits.bandwidth_mb)} · ${Math.round((bw30 / limits.bandwidth_mb) * 100)}%` : L('unlimited', 'bez limitu'), icon: 'chart', tone: percentTone(bw30, limits.bandwidth_mb), href: '/user/statistics' })}
    </div>

    ${card(L('First steps', 'Pierwsze kroki'), h`
      <div class="spread mb-12">
        <strong>${stepsDone} z ${steps.length} ${L('done', 'gotowe')}</strong>
        <span class="small muted">${nextStep === -1 ? L('Everything is ready', 'Wszystko gotowe — konto pracuje') : `${L('Next', 'Następny krok')}: ${steps[nextStep].label}`}</span>
      </div>
      <div class="progress mb-18" role="progressbar" aria-label="${L('Setup progress', 'Postęp konfiguracji')}" aria-valuenow="${stepsDone}" aria-valuemin="0" aria-valuemax="${steps.length}"><span style="width:${Math.round((stepsDone / steps.length) * 100)}%"></span></div>
      <div class="stack" style="gap:10px">
        ${steps.map((step, index) => step.done
          ? h`<div class="spread" data-onboarding-step="${index}">
              <span class="row" style="gap:8px">${badge(L('done', 'gotowe'), 'ok')}<span>${step.label}</span></span>
              ${icon('check', { size: 16, cls: 'text-ok' })}
            </div>`
          : h`<a class="spread" href="${step.href}" data-onboarding-step="${index}" style="color:inherit">
              <span class="row" style="gap:8px">${badge(index === nextStep ? L('next', 'następny krok') : L('to do', 'do zrobienia'), index === nextStep ? 'brand' : 'muted')}<span>${step.label}</span></span>
              <span class="btn btn-ghost btn-sm">${L('Open', 'Otwórz')} ${icon('arrowRight', { size: 14 })}</span>
            </a>`)}
      </div>`, { sub: L('Domain → site → SSL → mailbox → backup → 2FA', 'Domena → strona → SSL → poczta → kopia → 2FA') })}

    ${card(L('Applications — one click', 'Aplikacje — jeden klik'), h`
      <div class="app-tile-grid">
        ${APPS.map((app) => {
          const count = appCounts[app.key] || 0;
          return h`<a class="app-tile" href="/user/app-catalog#app-${app.key}" data-dashboard-app="${app.key}" aria-label="${app.name} — ${count ? count + L(' installed', ' zainstalowanych') : L('available to install', 'gotowa do instalacji')}">
            <div class="app-tile-head">
              ${appIcon(app.key, { size: 46 })}
              <div>
                <div class="app-tile-title"><h3>${app.name}</h3>${count ? badge(`${count}`, 'ok') : badge(L('ready', 'gotowa'), 'muted')}</div>
                <p class="app-tile-sub">${app.desc}</p>
              </div>
            </div>
            <div class="app-tile-actions">
              <span class="btn btn-secondary btn-sm">${count ? L('Manage', 'Zarządzaj') : L('Open installer', 'Otwórz instalator')} ${icon('arrowRight', { size: 14 })}</span>
            </div>
          </a>`;
        })}
      </div>`, {
      sub: appTotal ? (appTotal === 1 ? L('1 installed application', '1 zainstalowana aplikacja') : L(`${appTotal} installed applications`, `${appTotal} zainstalowanych aplikacji`)) : L('Six production-ready apps, installed on your own domain', 'Sześć gotowych aplikacji — instalujesz na własnej domenie'),
      actions: [h`<a class="link small" href="/user/app-catalog">${L('Full catalogue', 'Cały katalog')} →</a>`],
    })}

    <div class="grid grid-2-1">
      ${usageCard(series)}
      ${card(L('Account resources', 'Zasoby konta'), h`
        <div class="stack" style="gap:14px" data-resource-meters>
          ${resourceMeter({ key: 'disk', label: L('Disk', 'Dysk'), used: storage.used, limit: limits.disk_mb, format: formatBytes, href: '/user/statistics' })}
          ${resourceMeter({ key: 'bandwidth', label: L('Bandwidth (30d)', 'Transfer (30 dni)'), used: bw30, limit: limits.bandwidth_mb, format: formatBytes, href: '/user/statistics' })}
          ${resourceMeter({ key: 'email', label: L('Email accounts', 'Skrzynki e-mail'), used: emailCount, limit: limits.emails, href: '/user/email' })}
          ${resourceMeter({ key: 'databases', label: L('Databases', 'Bazy danych'), used: dbs, limit: limits.databases, href: '/user/databases' })}
          ${resourceMeter({ key: 'ftp', label: L('FTP accounts', 'Konta FTP'), used: ftp, limit: limits.ftp, href: '/user/ftp' })}
          ${resourceMeter({ key: 'ssl', label: L('SSL certificates', 'Certyfikaty SSL'), used: sslCount, limit: limits.ssl, href: '/user/ssl' })}
        </div>
        <div class="spread small muted mt-18">
          <span>PHP: ${Array.isArray(limits.php) ? limits.php.join(', ') : (limits.php || '8.3')}</span>
          <span>SSH: ${limits.ssh ? L('enabled', 'włączony') : L('disabled', 'wyłączony')}</span>
        </div>`, { sub: L('Based on your package ', 'Na podstawie pakietu ') + (u.package || 'default'), actions: [h`<a class="link small" href="/user/statistics">${L('Usage report', 'Raport użycia')} →</a>`] })}
    </div>

    <div class="grid grid-2">
      ${card(L('Your domains', 'Twoje domeny'), h`${domains.length ? h`<table class="data-table table-compact">
        <thead><tr><th>${L('Domain', 'Domena')}</th><th>SSL</th><th>${L('Disk', 'Dysk')}</th><th></th></tr></thead>
        <tbody>${domains.slice(0, 6).map((d) => h`<tr>
          <td><a class="cell-strong" href="/user/dns?domain=${encodeURIComponent(d.name)}">${d.name}</a><span class="cell-sub truncate" title="${d.docroot || ''}" style="max-width:300px">${d.docroot || ''}</span></td>
          <td>${d.ssl ? badge(L('Enabled', 'Włączony'), 'ok') : badge(L('Off', 'Wyłączony'), 'muted')}</td>
          <td>${formatBytes(d.disk_mb)}</td>
          <td class="col-actions"><a class="link small" href="/user/files?path=${encodeURIComponent(d.docroot || '/')}">${L('Files', 'Pliki')}</a></td>
        </tr>`)}</tbody>
      </table>` : emptyState(L('No domains yet', 'Brak domen'), { icon: 'globe', action: btn(L('Launch site wizard', 'Postaw pierwszą stronę'), { href: '/user/websites/new', icon: 'rocket' }) })}`, { sub: L('Primary and add-on domains', 'Domeny główne i dodatkowe'), actions: [h`<a class="link small" href="/user/websites/new">${L('Add site', 'Dodaj stronę')}</a>`, h`<a class="link small" href="/user/domains">${L('Manage', 'Zarządzaj')}</a>`] })}

      ${card(L('Top mailboxes', 'Największe skrzynki'), h`${emails.length ? h`<div class="timeline">${emails.map((m) => h`<div class="timeline-item">
          <div class="timeline-dot">${icon('mail', { size: 15 })}</div>
          <div class="timeline-body"><div class="spread"><strong>${m.local_part}@${m.domain}</strong><span class="small muted">${formatBytes(m.used_mb)} / ${formatBytes(m.quota_mb)}</span></div>
            <div class="progress" style="margin-top:6px"><span style="width:${Math.min(100, Math.round((m.used_mb / Math.max(m.quota_mb, 1)) * 100))}%"></span></div>
          </div>
        </div>`)}</div>` : emptyState(L('No mailboxes yet', 'Brak skrzynek'), { icon: 'mail', action: btn(L('Create mailbox', 'Utwórz skrzynkę'), { href: '/user/email/new', icon: 'plus' }) })}`, { sub: L('Storage used by mailbox', 'Miejsce zajęte przez skrzynki'), actions: [h`<a class="link small" href="/user/email/new">${L('New mailbox', 'Nowa skrzynka')}</a>`, h`<a class="link small" href="/user/email">${L('Manage', 'Zarządzaj')}</a>`] })}
    </div>

    <div class="grid grid-3">
      ${card(L('Quick actions', 'Szybkie akcje'), h`<div class="quick-grid" style="grid-template-columns:repeat(2,1fr)" data-quick-actions>
        ${quickAction('/user/websites/new', 'rocket', L('Launch site', 'Postaw stronę'), L('Domain + SSL + WordPress', 'Domena + SSL + WordPress'))}
        ${quickAction('/user/email/new', 'mail', L('New mailbox', 'Nowa skrzynka'), L('Create an e-mail account', 'Utwórz konto e-mail'))}
        ${quickAction('/user/databases/create', 'database', L('New database', 'Nowa baza'), 'MySQL / MariaDB')}
        ${quickAction('/user/ftp/create', 'upload', 'FTP', L('File transfer user', 'Konto do plików'))}
      </div>`)}

      ${recent}

      ${automationCard(u)}
    </div>

    ${card(L('All tools', 'Wszystkie narzędzia'), h`<div class="quick-grid" data-all-tools>
      ${toolTile('/user/domains', 'globe', L('Domains', 'Domeny'), L('Add, edit, delete', 'Dodaj, edytuj, usuń'))}
      ${toolTile('/user/subdomains', 'network', L('Subdomains', 'Subdomeny'), L('blog, shop, api', 'blog, sklep, api'))}
      ${toolTile('/user/dns', 'dns', L('DNS records', 'Strefy DNS'), L('A, MX, TXT, CNAME', 'A, MX, TXT, CNAME'))}
      ${toolTile('/user/redirects', 'arrowRight', L('Redirects', 'Przekierowania'), L('301 / 302', '301 / 302'))}
      ${toolTile('/user/ssl', 'lock', L('SSL certificates', 'Certyfikaty SSL'), L('Let’s Encrypt', 'Let’s Encrypt'))}
      ${toolTile('/user/email', 'mail', L('Mailboxes', 'Skrzynki e-mail'), L('IMAP / POP3 / SMTP', 'IMAP / POP3 / SMTP'))}
      ${toolTile('/user/email/forwarders', 'arrowRight', L('Forwarders', 'Przekierowania poczty'), L('Aliases', 'Aliasy'))}
      ${toolTile('/user/email/spam', 'shield', L('Spam filters', 'Filtry spamu'), L('Rules and blocklists', 'Reguły i blocklisty'))}
      ${toolTile('/user/files', 'folder', L('File manager', 'Menedżer plików'), L('Upload, edit, zip', 'Wgraj, edytuj, zip'))}
      ${toolTile('/user/ftp', 'upload', L('FTP accounts', 'Konta FTP'), L('Transfer files', 'Transfer plików'))}
      ${toolTile('/user/databases', 'database', L('Databases', 'Bazy danych'), L('MariaDB + phpMyAdmin', 'MariaDB + phpMyAdmin'))}
      ${toolTile('/user/cron', 'clock', L('Cron jobs', 'Zadania cron'), L('Scheduled tasks', 'Zaplanowane zadania'))}
      ${toolTile('/user/webdisk', 'cloud', 'WebDisk', L('WebDAV access', 'Dostęp WebDAV'))}
      ${toolTile('/user/backups', 'archive', L('Backups', 'Kopie zapasowe'), L('Download and restore', 'Pobierz i przywróć'))}
      ${toolTile('/user/php', 'php', L('PHP settings', 'Ustawienia PHP'), L('Version and INI', 'Wersja i INI'))}
      ${toolTile('/user/statistics', 'chart', L('Statistics', 'Statystyki'), L('Disk and bandwidth', 'Dysk i transfer'))}
    </div>`, { sub: L('Everything your hosting account can do', 'Wszystko, co może Twoje konto hostingowe') })}
  `;

  return page(ctx, {
    title: L('Dashboard', 'Pulpit'),
    subtitle: L('Overview of your hosting account', 'Przegląd Twojego konta hostingowego'),
    body,
    counts: countForNav(ctx.user, 'user'),
    storage,
  });
}

function quickAction(href, iconName, title, sub) {
  return h`<a class="quick-tile" href="${href}" data-quick-action>${icon(iconName, { size: 20 })}<strong>${title}</strong><span>${sub}</span></a>`;
}

function toolTile(href, iconName, title, sub) {
  return h`<a class="quick-tile" href="${href}" data-all-tool>${icon(iconName, { size: 20 })}<strong>${title}</strong><span>${sub}</span></a>`;
}

export function register(router) {
  router.get('/user', (ctx) => userDashboard(ctx));
}
