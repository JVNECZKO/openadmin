// Dashboard for the User level.
import fs from 'node:fs';
import path from 'node:path';
import { all, get } from '../db.mjs';
import { userHome } from '../paths.mjs';
import { limitsFor } from '../auth.mjs';
import { html as h, formatBytes, timeAgo, formatDate } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, statCard, btn, badge, statusBadge, table, emptyState, progress, kvList, alert } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { quotaCard, usageChartCard, greeting } from '../ui/pages/widgets.mjs';
import { visibleDomains, storageFor, usageSeries, countForNav } from '../core/access.mjs';

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
  const certs = get('SELECT COUNT(*) n FROM ssl_certs WHERE username = ?', u.username).n;
  const backups = all('SELECT * FROM backups WHERE user_id = ? ORDER BY created_at DESC LIMIT 3', u.id);
  const msg = get('SELECT * FROM messages WHERE (username = ? OR username IS NULL) AND read_at IS NULL ORDER BY created_at DESC LIMIT 1', u.username);
  const home = userHome(u.username);
  const siteReady = domains.some((d) => {
    const root = d.docroot && d.docroot.startsWith(home) ? d.docroot : path.join(home, 'domains', d.name, 'public_html');
    return ['index.php', 'index.html', 'index.htm'].some((f) => { try { return fs.existsSync(path.join(root, f)); } catch { return false; } });
  });
  const sslCount = get('SELECT COUNT(*) n FROM ssl_certs WHERE username = ?', u.username).n;
  const backupCount = get('SELECT COUNT(*) n FROM backups WHERE user_id = ?', u.id).n;
  const twofaOn = get('SELECT twofa_enabled e FROM users WHERE id = ?', u.id)?.e === 1;
  const steps = [
    { done: domains.length > 0, label: 'Dodaj domenę', href: '/user/websites/new' },
    { done: siteReady, label: 'Wgraj stronę (index.html/php)', href: '/user/files' },
    { done: sslCount > 0, label: 'Włącz certyfikat SSL', href: '/user/ssl' },
    { done: emailCount > 0, label: 'Utwórz skrzynkę e-mail', href: '/user/email/new' },
    { done: backupCount > 0, label: 'Zrób pierwszą kopię zapasową', href: '/user/backups' },
    { done: twofaOn, label: 'Włącz weryfikację dwuetapową', href: '/user/2fa' },
  ];
  const stepsDone = steps.filter((s) => s.done).length;

  const body = h`
    <div class="hero">
      <div>
        <h2>${pl ? `Dzień dobry, ${u.username}` : greeting(u)}</h2>
        <p>${L('Your account is hosted on', 'Twoje konto jest na serwerze')} <strong>${get('SELECT value FROM settings WHERE key = ?', 'server_name')?.value || 'localhost'}</strong>. ${L('Everything below is included — no add-ons, no per-domain fees.', 'Wszystko poniżej jest w cenie — bez dodatkowych opłat za domeny.')}</p>
        <div class="row mt-18">
          ${badge(L('Package: ', 'Pakiet: ') + (u.package || 'default'), 'brand')}
          ${badge(L('Free license', 'Darmowa licencja'), 'ok')}
          ${badge(u.suspended ? L('Suspended', 'Zawieszona') : L('Active', 'Aktywna'), u.suspended ? 'danger' : 'ok', { dot: true })}
        </div>
      </div>
      <div class="hero-actions">
        ${btn('Dodaj stronę', { href: '/user/websites/new', icon: 'plus' })}
        ${btn('Dodaj pocztę', { href: '/user/email/new', icon: 'mail', variant: 'secondary' })}
        ${btn('Pliki', { href: '/user/files', icon: 'folder', variant: 'secondary' })}
      </div>
    </div>

    ${msg ? alert(h`<strong>${msg.subject}</strong><br>${msg.body}`, 'info') : ''}
    ${stepsDone < steps.length ? card('Pierwsze kroki', h`
      <div class="spread mb-12"><strong>${stepsDone} z ${steps.length} gotowe</strong><span class="small muted">${stepsDone === 0 ? 'Zacznij od domeny' : 'Dokończ konfigurację'}</span></div>
      <div class="progress mb-18"><span style="width:${Math.round((stepsDone / steps.length) * 100)}%"></span></div>
      <div class="stack" style="gap:10px">${steps.map((st) => h`<div class="spread">
        <span>${st.done ? badge('gotowe', 'ok') : badge('do zrobienia', 'warn')} ${st.done ? st.label : h`<a class="link" href="${st.href}">${st.label}</a>`}</span>
        ${st.done ? '' : h`<a class="btn btn-ghost btn-sm" href="${st.href}">Przejdź →</a>`}
      </div>`)}</div>`, { sub: L('Six steps to a working website, mailbox and backup', 'Sześć kroków do strony, skrzynki i kopii zapasowej') }) : ''}

    <div class="stat-grid">
      ${statCard({ label: L('Domains', 'Domeny'), value: `${domains.length}${limits.domains ? ' / ' + limits.domains : ''}`, sub: L('active domains', 'aktywne domeny'), icon: 'globe', href: '/user/domains' })}
      ${statCard({ label: L('Email accounts', 'Skrzynki e-mail'), value: `${emailCount}${limits.emails ? ' / ' + limits.emails : ''}`, sub: L('mailboxes', 'skrzynki'), icon: 'mail', href: '/user/email' })}
      ${statCard({ label: L('Disk usage', 'Użycie dysku'), value: formatBytes(storage.used), sub: limits.disk_mb ? `${L('of', 'z')} ${formatBytes(limits.disk_mb)}` : L('unlimited', 'bez limitu'), icon: 'database', tone: 'warn', href: '/user/statistics' })}
      ${statCard({ label: L('Bandwidth (30d)', 'Transfer (30 dni)'), value: formatBytes(bw30), sub: limits.bandwidth_mb ? `${L('of', 'z')} ${formatBytes(limits.bandwidth_mb)}` : L('unlimited', 'bez limitu'), icon: 'chart', tone: 'ok', href: '/user/statistics' })}
    </div>

    <div class="grid grid-2-1">
      ${usageChartCard(series, { title: L('Bandwidth usage', 'Użycie transferu'), sub: L('Last 30 days', 'Ostatnie 30 dni') })}
      ${card(L('Account limits', 'Limity konta'), h`
        <div class="stack" style="gap:14px">
          ${quotaCard({ title: L('Disk', 'Dysk'), used: Math.round(storage.used), limit: limits.disk_mb || 0, unit: 'MB' })}
          ${quotaCard({ title: L('Bandwidth', 'Transfer'), used: Math.round(bw30), limit: limits.bandwidth_mb || 0, unit: 'MB' })}
          ${quotaCard({ title: L('Email accounts', 'Skrzynki e-mail'), used: emailCount, limit: limits.emails || 0, unit: '' })}
          ${quotaCard({ title: L('Databases', 'Bazy danych'), used: dbs, limit: limits.databases || 0, unit: '' })}
        </div>`, { sub: L('Based on your ', 'Na podstawie pakietu ') + (u.package || 'default'), actions: [h`<a class="link small" href="/user/statistics">${L('Usage report', 'Raport użycia')}</a>`] })}
    </div>

    <div class="grid grid-2">
      ${card(L('Your domains', 'Twoje domeny'), h`${domains.length ? h`<table class="data-table table-compact">
        <thead><tr><th>${L('Domain', 'Domena')}</th><th>PHP</th><th>SSL</th><th>${L('Disk', 'Dysk')}</th><th></th></tr></thead>
        <tbody>${domains.slice(0, 6).map((d) => h`<tr>
          <td><a class="cell-strong" href="/user/dns?domain=${d.name}">${d.name}</a><span class="cell-sub">${d.docroot || ''}</span></td>
          <td>${d.php_version || '—'}</td>
          <td>${d.ssl ? badge(L('Enabled', 'Włączony'), 'ok') : badge(L('Off', 'Wyłączony'), 'muted')}</td>
          <td>${formatBytes(d.disk_mb)}</td>
          <td class="col-actions"><a class="link small" href="/user/files?path=${encodeURIComponent(d.docroot || '/')}">${L('Files', 'Pliki')}</a></td>
        </tr>`)}</tbody>
      </table>` : emptyState(L('No domains yet', 'Brak domen'), { action: btn(L('Add your first domain', 'Dodaj pierwszą domenę'), { href: '/user/websites/new', icon: 'plus' }) })}`, { sub: L('Primary and add-on domains', 'Domeny główne i dodatkowe'), actions: [h`<a class="link small" href="/user/domains">${L('Manage', 'Zarządzaj')}</a>`] })}

      ${card(L('Top mailboxes', 'Największe skrzynki'), h`${emails.length ? h`<div class="timeline">${emails.map((m) => h`<div class="timeline-item">
          <div class="timeline-dot">${icon('mail', { size: 15 })}</div>
          <div class="timeline-body"><div class="spread"><strong>${m.local_part}@${m.domain}</strong><span class="small muted">${formatBytes(m.used_mb)} / ${formatBytes(m.quota_mb)}</span></div>
            <div class="progress" style="margin-top:6px"><span style="width:${Math.min(100, Math.round((m.used_mb / Math.max(m.quota_mb, 1)) * 100))}%"></span></div>
          </div>
        </div>`)}</div>` : emptyState(L('No mailboxes yet', 'Brak skrzynek'), { icon: 'mail' })}`, { sub: L('Storage used by mailbox', 'Miejsce zajęte przez skrzynki'), actions: [h`<a class="link small" href="/user/email">${L('Manage', 'Zarządzaj')}</a>`] })}
    </div>

    <div class="grid grid-3">
      ${card(L('Quick actions', 'Szybkie akcje'), h`<div class="quick-grid" style="grid-template-columns:repeat(2,1fr)">
        ${quick('/user/email/new', 'mail', 'Nowa skrzynka', 'Utwórz konto e-mail')}
        ${quick('/user/databases/create', 'database', L('New database', 'Nowa baza'), 'MySQL / MariaDB')}
        ${quick('/user/ftp/create', 'upload', 'FTP', L('File transfer user', 'Konto do plików'))}
        ${quick('/user/websites/new', 'globe', 'Nowa strona', 'Domena + SSL + WordPress')}
        ${quick('/user/backups', 'archive', L('Backup', 'Kopia zapasowa'), L('Download a full backup', 'Pobierz pełną kopię'))}
        ${quick('/user/cron', 'clock', 'Cron', L('Scheduled commands', 'Zaplanowane polecenia'))}
      </div>`)}
      ${card(L('Resources', 'Zasoby'), h`${kvList([
        [L('FTP accounts', 'Konta FTP'), `${ftp} / ${limits.ftp || '∞'}`],
        [L('Databases', 'Bazy danych'), `${dbs} / ${limits.databases || '∞'}`],
        [L('SSL certificates', 'Certyfikaty SSL'), `${certs} / ${limits.ssl || '∞'}`],
        [L('PHP versions', 'Wersje PHP'), (limits.php || []).join(', ') || '8.3'],
        [L('SSH access', 'Dostęp SSH'), limits.ssh ? L('Enabled', 'Włączony') : L('Disabled', 'Wyłączony')],
      ])}`)}
      ${card(L('Recent backups', 'Ostatnie kopie'), h`${backups.length ? h`<div class="timeline">${backups.map((b) => h`<div class="timeline-item">
          <div class="timeline-dot">${icon('archive', { size: 15 })}</div>
          <div class="timeline-body"><div class="truncate">${b.filename}</div><small>${formatDate(b.created_at)} · ${formatBytes(b.size_mb)}</small></div>
        </div>`)}</div>` : emptyState(L('No backups yet', 'Brak kopii'), { icon: 'archive' })}`, { actions: [h`<a class="link small" href="/user/backups">${L('All backups', 'Wszystkie kopie')}</a>`] })}
    </div>`;

  return page(ctx, {
    title: L('Dashboard', 'Pulpit'), subtitle: L('Overview of your hosting account', 'Przegląd Twojego konta hostingowego'), body,
    counts: countForNav(ctx.user, 'user'), storage,
  });
}

function quick(href, iconName, title, sub) {
  return h`<a class="quick-tile" href="${href}">${icon(iconName, { size: 20 })}<strong>${title}</strong><span>${sub}</span></a>`;
}

export function register(router) {
  router.get('/user', (ctx) => userDashboard(ctx));
  void statusBadge; void table; void progress; void timeAgo;
}
