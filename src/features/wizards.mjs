// Guided flows for non-technical users: add a website and add a mailbox.
import { html as h, formatDate, raw } from '../util.mjs';
import { run, get, all, nowIso, hashPassword, audit, setting } from '../db.mjs';
import { page } from '../ui/respond.mjs';
import { card, alert, kvList, badge, btn } from '../ui/components.mjs';
import { quota, visibleDomains, domainFor, canManageUser } from '../core/access.mjs';
import { createSite, engineChoices, phpVersions, recommendedDefaults, createActivationLink } from '../provisioning.mjs';
import { enginePicker, sslModeSelect, provisioningSteps } from './webserver.mjs';
import { dovecotHash, syncMail } from '../mail.mjs';
import { apply } from '../apply.mjs';
import { clientSettings } from '../autoconfig.mjs';
import { icon } from '../ui/icons.mjs';

function dnsInfo(domain) {
  const ip = setting('server_ip', '127.0.0.1');
  const ns1 = setting('ns1', 'ns1.localhost');
  const ns2 = setting('ns2', 'ns2.localhost');
  return `A     @              ${ip}
A     www            ${ip}
MX    @              10 mail.${domain}.
NS    @              ${ns1}
NS    @              ${ns2}`;
}

function readSubdomains(body = {}) {
  const raw = body.subdomains ?? body['subdomains[]'] ?? body.subdomain ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((v) => String(v ?? '').trim().toLowerCase()).filter(Boolean);
}

function appFromBody(body = {}, user = {}) {
  const type = String(body.app || (body.wordpress === '1' ? 'wordpress' : 'none')).trim().toLowerCase();
  if (type === 'none') return null;
  return {
    type,
    title: String(body.app_title || body.wp_title || '').trim(),
    adminUser: String(body.app_admin_user || 'admin').trim(),
    adminEmail: String(body.app_admin_email || user.email || '').trim(),
    adminPassword: String(body.app_admin_password || body.wp_password || ''),
  };
}

function sslModeFromBody(body = {}) {
  if (body.ssl_mode !== undefined) return String(body.ssl_mode);
  // Backwards compatibility with the old three-value SSL select and checkbox.
  if (body.ssl !== undefined) {
    const legacy = String(body.ssl);
    if (legacy === '1' || legacy === 'on') return 'selfsigned';
    return legacy;
  }
  return 'selfsigned';
}

function valuesFromBody(ctx) {
  const body = ctx.body || {};
  return {
    domain: String(body.domain || '').trim().toLowerCase(),
    engine: String(body.engine || '').trim().toLowerCase(),
    phpVersion: String(body.php_version || setting('php_default', '8.3')),
    sslMode: sslModeFromBody(body),
    createDns: body.create_dns === '1' || body.create_dns === true || body.create_dns === 'on',
    subdomains: readSubdomains(body),
    appType: String(body.app || (body.wordpress === '1' ? 'wordpress' : 'none')).trim().toLowerCase(),
    appTitle: String(body.app_title || body.wp_title || '').trim(),
    appUser: String(body.app_admin_user || 'admin').trim(),
    appEmail: String(body.app_admin_email || ctx.user?.email || '').trim(),
    dnsTemplate: String(body.dns_template || ''),
    checkDelegation: body.check_delegation === '1',
    createMailbox: body.create_mailbox === '1',
    mailboxLocal: String(body.mailbox_local || 'postmaster').trim().toLowerCase(),
    mailboxQuotaMb: Number(body.mailbox_quota_mb || 1024),
    backup: body.create_backup === '1',
    monitoring: body.create_monitoring === '1',
    retrySslAfterDns: body.retry_ssl_after_dns === '1',
  };
}

function subdomainRow(value = '', { removable = true } = {}) {
  return h`<div class="row u-s89" data-subdomain-row>
    <div class="field u-s90">
      <label class="field-label">Subdomena</label>
      <input name="subdomains[]" value="${value}" placeholder="blog" autocomplete="off">
    </div>
    <button type="button" class="btn btn-ghost btn-sm" data-remove-subdomain ${removable ? '' : 'hidden'}>Usuń</button>
  </div>`;
}

function subdomainEditor(values) {
  const rows = values.subdomains.length ? values.subdomains : [''];
  return h`
    <div class="u-s91" data-subdomain-rows>
      ${rows.map((name, i) => subdomainRow(name, { removable: i > 0 || rows.length > 1 }))}
    </div>
    <button type="button" class="btn btn-secondary btn-sm u-s55" data-add-subdomain>+ Dodaj subdomenę</button>
    <p class="field-help">Domena główna dostaje certyfikat z kroku 2. Każda subdomena dostaje własny vhost i — jeśli strefa DNS jest włączona — rekord A. Limit wynika z pakietu; puste wiersze są ignorowane.</p>
    <noscript><p class="small muted">Bez JavaScriptu możesz dodać jedną subdomenę w tym kroku. Kolejne dodasz później na stronie Subdomeny.</p></noscript>
    <template id="oa-subdomain-template">${subdomainRow('', { removable: true })}</template>
    <script>
      (() => {
        const container = document.querySelector('[data-subdomain-rows]');
        const add = document.querySelector('[data-add-subdomain]');
        const template = document.getElementById('oa-subdomain-template');
        if (!container || !add || !template) return;
        const sync = () => {
          const rows = [...container.querySelectorAll('[data-subdomain-row]')];
          rows.forEach((row, i) => {
            const button = row.querySelector('[data-remove-subdomain]');
            if (button) button.hidden = rows.length <= 1 && i === 0;
          });
        };
        container.addEventListener('click', (event) => {
          const button = event.target.closest('[data-remove-subdomain]');
          if (!button) return;
          const rows = [...container.querySelectorAll('[data-subdomain-row]')];
          const row = button.closest('[data-subdomain-row]');
          if (!row) return;
          if (rows.length <= 1) { const input = row.querySelector('input'); if (input) input.value = ''; return; }
          row.remove();
          sync();
        });
        add.addEventListener('click', () => {
          const fragment = template.content.cloneNode(true);
          const row = fragment.querySelector('[data-subdomain-row]');
          container.appendChild(fragment);
          const input = row && row.querySelector('input');
          if (input) input.focus();
          sync();
        });
        sync();
      })();
    </script>`;
}

function wizardForm(ctx, values) {
  const php = setting('php_default', '8.3');
  const phpList = phpVersions();
  const choices = engineChoices();
  const anyInstalled = choices.some((e) => e.installed);
  const anySandbox = choices.some((e) => e.sandbox);
  const appAvailable = ['none', 'wordpress', 'nextcloud'];
  const selectedSsl = values.sslMode || 'selfsigned';
  const selectedApp = appAvailable.includes(values.appType) ? values.appType : 'none';
  const stepLabels = ['Domena i silnik', 'PHP, SSL i DNS', 'Subdomeny', 'Aplikacja'];
  const form = h`<form method="post" action="/user/websites/new" class="oa-form" id="site-wizard" data-wizard>
    <input type="hidden" name="_csrf" value="${ctx.csrf}">
    <ol class="wizard-steps" data-wizard-indicator aria-label="Kroki tworzenia strony">
      ${stepLabels.map((label, i) => h`<li class="wizard-step ${i === 0 ? 'is-active' : ''}" data-wizard-indicator-step="${i + 1}">
        <span class="wizard-step-marker">${i + 1}</span><span class="wizard-step-copy"><strong>${label}</strong><small>${i === 0 ? 'start' : i === 3 ? 'opcjonalnie' : 'konfiguracja'}</small></span>
      </li>`)}
    </ol>
    <div data-wizard-step="1" data-wizard-title="Domena i silnik">
      ${card('Krok 1 z 4 · Domena i silnik WWW', h`
        <div class="form-grid">
          <div class="field field-full">
            <label class="field-label" for="site-domain">Domena <span class="req">*</span></label>
            <input id="site-domain" name="domain" value="${values.domain}" placeholder="example.com" required autocomplete="off">
            <p class="field-help">Bez http:// i bez ukośnika na końcu. Panel utworzy katalog, vhost, DNS i PHP.</p>
          </div>
          <div class="field field-full">
            <label class="field-label">Silnik WWW</label>
            ${enginePicker({ selected: values.engine, name: 'engine' })}
          </div>
        </div>
        ${!anyInstalled ? alert(anySandbox
          ? 'Nie wykryto binarek serwera WWW. Tryb sandbox: konfiguracja zostanie wygenerowana i odłożona, bez przeładowania usługi.'
          : 'Żaden serwer WWW nie został wykryty na tym hoście. Zainstaluj Nginx, Apache, OpenLiteSpeed lub LiteSpeed i odśwież stronę.', 'warn') : ''}
        ${anyInstalled && !choices.some((e) => e.installed && e.available) ? alert('Wybrany serwer nie jest zainstalowany — wybierz silnik oznaczony jako „detected”.', 'warn') : ''}
      `, { sub: 'Wybierz silnik; panel użyje ustawienia web_server:<domena> dla tej strony.' })}
      <div class="wizard-actions"><button type="button" class="btn btn-primary wizard-next" data-wizard-next>Dalej: PHP i SSL →</button></div>
    </div>
    <div data-wizard-step="2">
      ${card('Krok 2 z 4 · PHP, SSL i strefa DNS', h`
        <div class="form-grid">
          <div class="field">
            <label class="field-label" for="site-php">Wersja PHP</label>
            <select id="site-php" name="php_version">${phpList.map((v) => h`<option value="${v}" ${v === values.phpVersion ? 'selected' : ''}>PHP ${v}</option>`)}</select>
          </div>
          <div class="field">
            <label class="field-label" for="site-ssl">Certyfikat SSL</label>
            ${sslModeSelect({ selected: selectedSsl, name: 'ssl_mode', id: 'site-ssl' })}
            <p class="field-help">Let's Encrypt wymaga publicznego DNS; przy błędzie panel zainstaluje self-signed i pokaże ostrzeżenie.</p>
          </div>
          <div class="field field-full">
            <label class="check-field"><input type="checkbox" name="create_dns" value="1" ${values.createDns ? 'checked' : ''}><span>Utwórz strefę DNS z domyślnymi rekordami A, MX, SPF, DMARC i NS</span></label>
            <p class="field-help">Bez strefy DNS rekordy dla subdomen nie powstaną — vhost i katalog nadal będą utworzone.</p>
          </div>
          <div class="field">
            <label class="field-label" for="site-dns-template">Szablon DNS</label>
            <select id="site-dns-template" name="dns_template"><option value="">Automatyczny</option>
              ${(() => { try { return all('SELECT * FROM dns_templates ORDER BY name').map((t) => h`<option value="${t.id}" ${String(values.dnsTemplate || '') === String(t.id) ? 'selected' : ''}>${t.name}</option>`); } catch { return ''; } })()}
            </select>
          </div>
          <div class="field field-full"><div class="row u-s92">
            <label class="check-field"><input type="checkbox" name="check_delegation" value="1" ${values.checkDelegation ? 'checked' : ''}> <span>Sprawdź delegację DNS</span></label>
            <label class="check-field"><input type="checkbox" name="retry_ssl_after_dns" value="1" ${values.retrySslAfterDns ? 'checked' : ''}> <span>Ponów ACME po DNS</span></label>
            <label class="check-field"><input type="checkbox" name="create_backup" value="1" ${values.backup ? 'checked' : ''}> <span>Backup dzienny</span></label>
            <label class="check-field"><input type="checkbox" name="create_monitoring" value="1" ${values.monitoring ? 'checked' : ''}> <span>Monitoring</span></label>
          </div></div>
          <div class="field"><label class="field-label" for="site-mailbox">Skrzynka podstawowa</label>
            <input id="site-mailbox" name="mailbox_local" value="${values.mailboxLocal || 'postmaster'}" pattern="[a-z0-9][a-z0-9._-]{0,63}">
            <label class="check-field u-s24"><input type="checkbox" name="create_mailbox" value="1" ${values.createMailbox ? 'checked' : ''}> <span>Utwórz skrzynkę</span></label></div>
          <div class="field"><label class="field-label" for="site-mailbox-quota">Limit skrzynki (MB)</label>
            <input id="site-mailbox-quota" name="mailbox_quota_mb" type="number" min="0" value="${values.mailboxQuotaMb || 1024}"></div>
        </div>
      `, { sub: 'Domyślna wersja PHP: ' + php + '. SSL możesz zmienić później w edycji domeny.' })}
      <div class="wizard-actions"><button type="button" class="btn btn-ghost" data-wizard-back>← Wstecz</button><button type="button" class="btn btn-primary wizard-next" data-wizard-next>Dalej: subdomeny →</button></div>
    </div>
    <div data-wizard-step="3">
      ${card('Krok 3 z 4 · Subdomeny (opcjonalnie)', h`${subdomainEditor(values)}`,
        { sub: '0–N subdomen; każda z własnym vhostem i rekordem A, gdy strefa DNS jest aktywna.' })}
      <div class="wizard-actions"><button type="button" class="btn btn-ghost" data-wizard-back>← Wstecz</button><button type="button" class="btn btn-primary wizard-next" data-wizard-next>Dalej: aplikacja →</button></div>
    </div>
    <div data-wizard-step="4">
      ${card('Krok 4 z 4 · Aplikacja (opcjonalnie)', h`
        <div class="form-grid">
          <div class="field">
            <label class="field-label" for="site-app">Aplikacja</label>
            <select id="site-app" name="app">
              ${appAvailable.map((v) => h`<option value="${v}" ${v === selectedApp ? 'selected' : ''}>${v === 'none' ? 'Brak — pusta strona' : v === 'wordpress' ? 'WordPress' : 'Nextcloud'}</option>`)}
            </select>
            <p class="field-help">Instalatory używają istniejących mechanizmów panelu (baza MariaDB, wp-cli / occ). Jeżeli środowisko nie jest gotowe, krok pokaże rzeczywisty błąd.</p>
          </div>
          <div class="field">
            <label class="field-label" for="site-app-title">Tytuł strony (WordPress)</label>
            <input id="site-app-title" name="app_title" value="${values.appTitle}" placeholder="Moja strona">
          </div>
          <div class="field">
            <label class="field-label" for="site-app-user">Login administratora aplikacji</label>
            <input id="site-app-user" name="app_admin_user" value="${values.appUser || 'admin'}" autocomplete="username">
          </div>
          <div class="field">
            <label class="field-label" for="site-app-email">E-mail administratora aplikacji</label>
            <input id="site-app-email" name="app_admin_email" type="email" value="${values.appEmail}" autocomplete="email">
          </div>
          <div class="field field-full">
            <label class="field-label" for="site-app-pass">Hasło administratora aplikacji</label>
            <input id="site-app-pass" name="app_admin_password" type="password" minlength="8" autocomplete="new-password" placeholder="min. 8 znaków — wymagane tylko przy instalacji aplikacji">
            <p class="field-help">Hasło pojawi się jednorazowo w wyniku instalacji. Nie jest zapisywane w statusie wdrożenia.</p>
          </div>
        </div>
      `, { sub: 'Nextcloud najlepiej instaluje się na osobnej subdomenie z pustym katalogiem głównym.' })}
      <div class="wizard-actions"><button type="button" class="btn btn-ghost" data-wizard-back>← Wstecz</button><button type="button" class="btn btn-primary" data-wizard-submit>Utwórz stronę</button></div>
    </div>
    <div class="form-actions" data-wizard-fallback>
      <button class="btn btn-primary" type="submit">Utwórz stronę</button>
      <a class="btn btn-ghost" href="/user/domains">Anuluj</a>
    </div>
  </form>`;
  return form;
}

function errorList(errors = []) {
  return h`<ul class="doc-list">${errors.map((e) => h`<li><strong>${e.code || 'error'}:</strong> ${e.message || e}</li>`)}</ul>`;
}

function resultPage(ctx, result) {
  const warningList = (result.warnings || []).filter(Boolean);
  const alerts = h`
    ${result.ok
      ? alert(warningList.length ? 'Strona została utworzona, ale wynik zawiera ostrzeżenia — przejrzyj listę poniżej.' : (result.created ? 'Strona została utworzona i wdrożona.' : 'Istniejąca strona została zaktualizowana.'), warningList.length ? 'warn' : 'ok')
      : alert(result.created
        ? 'Domena i część zasobów powstały, ale wdrożenie nie zakończyło się w pełni. Poniższe kroki pokazują dokładnie co zostało zrobione.'
        : 'Nie udało się utworzyć strony. Poniżej znajdują się rzeczywiste wyniki walidacji i wdrożenia.', 'danger')}
    ${warningList.length ? alert(h`${warningList.map((w) => h`<div>${w}</div>`)}`, 'warn', { title: 'Ostrzeżenia' }) : ''}
    ${(result.errors || []).length ? alert(h`${errorList(result.errors)}`, 'danger', { title: 'Błędy' }) : ''}
    ${result.rolledBack ? alert('Utworzona w tym żądaniu domena została wycofana (rollback), ponieważ wdrożenie nie powiodło się.', 'info') : ''}`;

  const meta = kvList([
    ['Domena', result.links?.site ? h`<a class="link" href="${result.links.site}" target="_blank" rel="noopener">${result.domain}</a>` : result.domain],
    ['Silnik WWW', result.engineLabel || result.engine || '—'],
    ['PHP', result.phpVersion || '—'],
    ['SSL', result.sslMode === 'none' ? 'wyłączony' : (result.sslMode || '—')],
    ['Katalog', h`<code>${result.docroot || '—'}</code>`],
    ['Tryb', result.simulated ? 'sandbox — konfiguracja odłożona, usługa nieprzeładowana' : 'wdrożenie systemowe'],
  ]);

  const appInfo = result.app?.ok ? card('Dane aplikacji', h`
    ${alert('Zapisz hasło teraz — panel nie pokaże go ponownie.', 'warn')}
    ${kvList([
    ['Aplikacja', result.app.type || (result.app.adminUrl ? 'aplikacja' : '—')],
    ['Adres', result.app.url ? h`<a class="link" href="${result.app.url}" target="_blank" rel="noopener">${result.app.url}</a>` : '—'],
    ['Panel', result.app.adminUrl ? h`<a class="link" href="${result.app.adminUrl}" target="_blank" rel="noopener">${result.app.adminUrl}</a>` : '—'],
    ['Login', result.app.adminUser || '—'],
    ['Hasło', h`<code>${result.app.adminPass || '—'}</code>`],
    ['Baza', result.app.db || '—'],
  ])}`) : '';

  const links = result.links && Object.keys(result.links).length ? card('Co dalej', h`
    <div class="row">
      ${result.links.site ? h`<a class="btn btn-primary" href="${result.links.site}" target="_blank" rel="noopener">Otwórz stronę</a>` : ''}
      ${result.links.files ? h`<a class="btn btn-secondary" href="${result.links.files}">Wgraj pliki</a>` : ''}
      ${result.links.dns ? h`<a class="btn btn-secondary" href="${result.links.dns}">Strefa DNS</a>` : ''}
      ${result.links.ssl ? h`<a class="btn btn-secondary" href="${result.links.ssl}">Certyfikat SSL</a>` : ''}
      ${result.links.email ? h`<a class="btn btn-secondary" href="${result.links.email}">Dodaj pocztę</a>` : ''}
      ${result.links.domain ? h`<a class="btn btn-ghost" href="${result.links.domain}">Zarządzaj domeną</a>` : ''}
    </div>
    <p class="small muted u-s27">Jeśli domena nie jest jeszcze delegowana do tego serwera, ustaw u niej rekordy lub NS. Poniżej domyślne rekordy panelu:</p>
    <pre class="code-block">${dnsInfo(result.domain)}</pre>
    <div class="row u-s27">
      <a class="btn btn-ghost" href="/user/websites/new">Dodaj kolejną stronę</a>
      <a class="btn btn-ghost" href="/user/domains">Wszystkie domeny</a>
    </div>`) : '';

  return h`${alerts}
    ${card('Wynik provisioningu', h`${meta}<h3 class="form-section">Kroki wdrożenia</h3>${provisioningSteps(result.steps || [])}`,
    { sub: result.ok ? 'Kolejność rzeczywistych operacji' : 'Każdy krok pokazuje prawdziwy wynik' })}
    ${appInfo}
    ${links}`;
}

function wizardPage(ctx, values = {}) {
  const domains = visibleDomains(ctx.user);
  return h`${alert(h`To uproszczony kreator strony. Pełny, jeden przepływ domeny (document root → DNS → delegacja → vhost → PHP → SSL z retry → poczta → aplikacja → backup/monitoring) znajdziesz w <a class="link" href="/user/domains/create">kreatorze domeny</a>.`, 'info')}
    ${wizardForm(ctx, values)}
    ${domains.length ? card('Masz już domeny', h`${domains.map((d) => h`<div class="spread u-s93"><a class="link" href="/user/files?path=${encodeURIComponent(d.docroot || '/')}">${d.name}</a><span>${d.ssl ? badge('SSL', 'ok') : badge('bez SSL', 'warn')}</span></div>`)}`) : ''}`;
}

/* ----------------------------------------------- account provisioning wizard */

export const USER_WIZARD_STEPS = [
  { key: 'contact', label: 'Klient i kontakt', hint: 'kto i jak się kontaktować' },
  { key: 'package', label: 'Pakiet', hint: 'limity i podsumowanie' },
  { key: 'domain', label: 'Domena, IP i DNS', hint: 'strefa i delegacja' },
  { key: 'stack', label: 'WWW, PHP, SSL, poczta', hint: 'usługi i aplikacja' },
  { key: 'preflight', label: 'Podsumowanie i preflight', hint: 'sprawdzenie przed zapisem' },
];

function asValue(values, name, fallback = '') {
  if (!values || values[name] === undefined || values[name] === null) return fallback;
  return values[name];
}

function asFlag(values, name, fallback = false) {
  if (!values || values[name] === undefined || values[name] === null || values[name] === '') return fallback;
  return values[name] === true || values[name] === 1 || ['1', 'on', 'true', 'yes', 'checked'].includes(String(values[name]).toLowerCase());
}

function packageSummaries(rows = []) {
  const out = {};
  for (const pkg of rows) {
    let limits = {};
    try { limits = JSON.parse(pkg.limits || '{}'); } catch { limits = {}; }
    out[pkg.name] = {
      domains: Number(limits.domains) || 0,
      subdomains: Number(limits.subdomains) || 0,
      emails: Number(limits.emails) || 0,
      disk_mb: Number(limits.disk_mb) || 0,
      bandwidth_mb: Number(limits.bandwidth_mb) || 0,
      databases: Number(limits.databases) || 0,
      php: Array.isArray(limits.php) ? limits.php : [],
    };
  }
  return out;
}

function limitLabel(value, unit = '') {
  if (value === undefined || value === null) return '—';
  return Number(value) === 0 ? 'bez limitu' : `${value}${unit}`;
}

function packageSummaryRows(limits = {}) {
  return kvList([
    ['Domeny', limitLabel(limits.domains)],
    ['Subdomeny', limitLabel(limits.subdomains)],
    ['Skrzynki e-mail', limitLabel(limits.emails)],
    ['Dysk', limitLabel(limits.disk_mb, ' MB')],
    ['Transfer', limitLabel(limits.bandwidth_mb, ' MB')],
    ['Bazy danych', limitLabel(limits.databases)],
    ['PHP', Array.isArray(limits.php) && limits.php.length ? limits.php.map((v) => `PHP ${v}`).join(', ') : 'domyślna wersja'],
  ], { cols: 1 });
}

function preflightPanel(checks = []) {
  if (!Array.isArray(checks) || !checks.length) return '';
  return card('Preflight — rzeczywiste wyniki', h`
    <ul class="doc-list" data-preflight-checks>
      ${checks.map((check) => h`<li data-preflight-key="${check.key || ''}" data-preflight-ok="${check.ok ? '1' : '0'}">
        <div class="spread"><strong>${check.label || check.key || 'Sprawdzenie'}</strong>
          ${check.ok ? badge(check.skipped ? 'pominięte' : 'OK', check.skipped ? 'muted' : 'ok')
            : badge(check.severity === 'warn' ? 'ostrzeżenie' : 'błąd', check.severity === 'warn' ? 'warn' : 'danger')}
        </div>
        <div class="small muted">${check.detail || ''}</div>
      </li>`)}
    </ul>`, { sub: 'Sprawdzenia nie zmieniają stanu — dopiero „Utwórz konto” wykonuje operację.' });
}

export function renderAccountResult(status, { title = 'Wynik provisioningu konta' } = {}) {
  if (!status) return '';
  const warnings = status.warnings || [];
  const steps = status.steps || [];
  const activationLink = status.links?.activation || '';
  return h`${status.ok
    ? alert('Konto zostało utworzone i wdrożone.', warnings.length ? 'warn' : 'ok')
    : alert(status.rolledBack
      ? 'Wdrożenie nie powiodło się — wszystkie artefakty utworzone w tym żądaniu zostały wycofane (rollback).'
      : 'Wdrożenie zgłosiło błędy. Przejrzyj kroki i komunikaty poniżej.', 'danger')}
    ${warnings.length ? alert(h`${warnings.map((warning) => h`<div>${warning}</div>`)}`, 'warn', { title: 'Ostrzeżenia' }) : ''}
    ${(status.errors || []).length ? alert(h`<ul class="doc-list">${status.errors.map((error) => h`<li><strong>${error.code || 'error'}:</strong> ${error.message || error}</li>`)}</ul>`, 'danger', { title: 'Błędy' }) : ''}
    ${activationLink ? alert(h`Link aktywacyjny: <code>${activationLink}</code><div class="small muted">Hasło nie jest nigdzie wyświetlane ani wysyłane w plaintext.</div>`, 'info', { title: 'Aktywacja konta' }) : ''}
    ${status.checks?.length ? preflightPanel(status.checks) : ''}
    ${card(title, h`<ol class="doc-list" data-account-steps>
      ${steps.map((step) => h`<li data-account-step="${step.key || ''}">
        <div class="spread"><strong>${step.label || step.key || 'Krok'}</strong>
          ${step.ok ? badge(step.skipped ? 'pominięte' : 'OK', step.skipped ? 'muted' : 'ok')
            : badge(step.optional ? 'ostrzeżenie' : 'błąd', step.optional ? 'warn' : 'danger')}
        </div>
        <div class="small muted">${step.detail || ''}</div>
        ${Array.isArray(step.subSteps) && step.subSteps.length ? h`<ul class="doc-list u-s24">
          ${step.subSteps.map((sub) => h`<li data-site-step="${sub.key || ''}">${sub.ok ? badge(sub.skipped ? 'pominięte' : 'OK', sub.skipped ? 'muted' : 'ok') : badge('błąd', 'danger')} <span class="small">${sub.label || sub.key}: ${sub.detail || ''}</span></li>`)}
        </ul>` : ''}
      </li>`)}
    </ol>`, { sub: 'Kolejność rzeczywistych operacji — każda pozycja to prawdziwy wynik, nie deklaracja.' })}
    ${status.links && Object.keys(status.links).some((key) => key !== 'activation' && status.links[key]) ? card('Co dalej', h`
      <div class="row u-s59">
        ${status.links.site ? h`<a class="btn btn-secondary btn-sm" href="${status.links.site}" target="_blank" rel="noopener">Otwórz stronę</a>` : ''}
        ${status.links.dns ? h`<a class="btn btn-secondary btn-sm" href="${status.links.dns}">Strefa DNS</a>` : ''}
        ${status.links.ssl ? h`<a class="btn btn-secondary btn-sm" href="${status.links.ssl}">Certyfikat SSL</a>` : ''}
        ${status.links.email ? h`<a class="btn btn-secondary btn-sm" href="${status.links.email}">Dodaj pocztę</a>` : ''}
        ${status.links.domain ? h`<a class="btn btn-ghost btn-sm" href="${status.links.domain}">Zarządzaj domeną</a>` : ''}
      </div>`, { sub: 'Linki prowadzą do konkretnego obiektu utworzonego w tym wdrożeniu.' }) : ''}`;
}

/**
 * Guided account form used by both /admin/users/create and
 * /reseller/users/create. Legacy field names stay present in the markup so
 * existing integrations keep working; the wizard is progressive enhancement.
 */
export function renderUserProvisioningForm(ctx, {
  path, packages = [], values = {}, preflight = null, error = '', resellers = [],
} = {}) {
  const rows = packages.length ? packages : [];
  const defaults = recommendedDefaults({ actor: ctx.user, kind: 'account', packageName: asValue(values, 'package', rows[0]?.name || 'default') });
  const summaries = packageSummaries(rows);
  const templates = (() => { try { return all('SELECT * FROM dns_templates ORDER BY name'); } catch { return []; } })();
  const ipRows = (() => { try { return all('SELECT * FROM ips ORDER BY ip'); } catch { return []; } })();
  const engine = asValue(values, 'engine', defaults.engine || '');
  const php = String(asValue(values, 'php_version', defaults.phpVersion || setting('php_default', '8.3')));
  const ssl = String(asValue(values, 'ssl_mode', defaults.sslMode || 'selfsigned'));
  const selectedPackage = String(asValue(values, 'package', rows[0]?.name || 'default'));
  const selectedApp = String(asValue(values, 'app', 'none'));
  const wantsDns = asFlag(values, 'create_dns', defaults.createDns);
  const wantsMailbox = asFlag(values, 'create_mailbox', defaults.createMailbox);
  const wantsBackup = asFlag(values, 'create_backup', defaults.backup);
  const wantsMonitoring = asFlag(values, 'create_monitoring', defaults.monitoring);
  const activation = asFlag(values, 'activation', true);
  const selectedTemplate = String(asValue(values, 'dns_template', defaults.dnsTemplateId || ''));
  const inlineOpen = !rows.length || !!asValue(values, 'new_package_name', '');
  const stepCopy = USER_WIZARD_STEPS.map((step, index) => h`<li class="wizard-step ${index === 0 ? 'is-active' : ''}" data-wizard-indicator-step="${index + 1}">
    <span class="wizard-step-marker">${index + 1}</span>
    <span class="wizard-step-copy"><strong>${step.label}</strong><small>${step.hint}</small></span>
  </li>`);
  const html = h`<form method="post" action="${path}/create" class="oa-form" id="user-provision-wizard" data-wizard autocomplete="off">
    <input type="hidden" name="_csrf" value="${ctx.csrf}">
    <input type="hidden" name="wizard" value="1">
    ${error ? alert(error, 'danger') : ''}
    ${preflight && (preflight.checks?.length || preflight.errors?.length) ? h`
      ${preflightPanel(preflight.checks || [])}
      ${preflight.errors?.length ? alert(h`<ul class="doc-list">${preflight.errors.map((entry) => h`<li><strong>${entry.code || 'error'}:</strong> ${entry.message || entry}</li>`)}</ul>`, 'danger', { title: 'Co trzeba poprawić' }) : ''}
    ` : ''}
    <ol class="wizard-steps" data-wizard-indicator aria-label="Kroki tworzenia konta">${stepCopy}</ol>

    <div data-wizard-step="1" data-wizard-title="Klient i kontakt">
      ${card('Krok 1 z 5 · Klient i kontakt', h`
        <div class="form-grid">
          <div class="field"><label class="field-label" for="oa-user-username">Login klienta <span class="req">*</span></label>
            <input id="oa-user-username" name="username" value="${asValue(values, 'username')}" required pattern="[a-z0-9][a-z0-9_.-]{1,31}" placeholder="johndoe" autocomplete="off">
            <p class="field-help">Małe litery, cyfry, kropka, myślnik i podkreślenie. Panel zaproponuje bezpieczny login, jeśli chcesz go zmienić.</p></div>
          <div class="field"><label class="field-label" for="oa-user-email">E-mail kontaktu <span class="req">*</span></label>
            <input id="oa-user-email" name="email" type="email" value="${asValue(values, 'email')}" required>
            <p class="field-help">Na ten adres trafi powiadomienie o koncie (bez hasła w plaintext).</p></div>
          <div class="field"><label class="field-label" for="oa-user-contact">Osoba kontaktowa</label>
            <input id="oa-user-contact" name="contact_name" value="${asValue(values, 'contact_name')}" placeholder="Imię i nazwisko"></div>
          <div class="field"><label class="field-label" for="oa-user-phone">Telefon</label>
            <input id="oa-user-phone" name="phone" value="${asValue(values, 'phone')}" placeholder="+48 ..."></div>
          ${ctx.user.level === 'admin' ? h`<div class="field"><label class="field-label" for="oa-user-owner">Właściciel (reseller)</label>
            <select id="oa-user-owner" name="owner"><option value="">Administrator (bez resellera)</option>
              ${resellers.map((reseller) => h`<option value="${reseller.username}" ${String(asValue(values, 'owner', '')) === reseller.username ? 'selected' : ''}>${reseller.username}</option>`)}
            </select><p class="field-help">Opcjonalnie. Reseller otrzyma możliwość zarządzania tym kontem.</p></div>` : ''}
          <div class="field field-full"><label class="field-label" for="oa-user-notes">Notatki</label>
            <textarea id="oa-user-notes" name="notes" rows="2">${asValue(values, 'notes')}</textarea></div>
        </div>`)}
      <div class="wizard-actions"><button type="button" class="btn btn-primary" data-wizard-next>Dalej: pakiet →</button></div>
    </div>

    <div data-wizard-step="2" data-wizard-title="Pakiet">
      ${card('Krok 2 z 5 · Pakiet i limity', h`
        <div class="form-grid">
          <div class="field field-full"><label class="field-label" for="oa-user-package">Pakiet <span class="req">*</span></label>
            <select id="oa-user-package" name="package">
              ${rows.length ? rows.map((pkg) => h`<option value="${pkg.name}" ${selectedPackage === pkg.name ? 'selected' : ''}>${pkg.name}${pkg.owner ? ` — ${pkg.owner}` : ' — globalny'}</option>`) : h`<option value="__new__">— utwórz pakiet inline —</option>`}
            </select>
            <p class="field-help">Pakiet wybiera limity domen, poczty, dysku i transferu. Zmiana pakietu nie usuwa danych.</p></div>
        </div>
        <div data-package-summary>${packageSummaryRows(summaries[selectedPackage] || {})}</div>
        <details class="u-s52" ${inlineOpen ? 'open' : ''}><summary>Nie ma odpowiedniego pakietu? Utwórz go inline bez utraty formularza</summary>
          <div class="form-grid form-grid-3 u-s55">
            <div class="field"><label class="field-label" for="oa-user-new-package">Nazwa nowego pakietu</label>
              <input id="oa-user-new-package" name="new_package_name" value="${asValue(values, 'new_package_name')}" pattern="[a-zA-Z0-9_.-]{2,40}"></div>
            <div class="field"><label class="field-label" for="oa-user-new-domains">Domeny</label><input id="oa-user-new-domains" name="new_limit_domains" type="number" min="0" value="${asValue(values, 'new_limit_domains', 10)}"></div>
            <div class="field"><label class="field-label" for="oa-user-new-emails">Skrzynki e-mail</label><input id="oa-user-new-emails" name="new_limit_emails" type="number" min="0" value="${asValue(values, 'new_limit_emails', 50)}"></div>
            <div class="field"><label class="field-label" for="oa-user-new-disk">Dysk (MB)</label><input id="oa-user-new-disk" name="new_limit_disk_mb" type="number" min="0" value="${asValue(values, 'new_limit_disk_mb', 10240)}"></div>
            <div class="field"><label class="field-label" for="oa-user-new-bandwidth">Transfer (MB)</label><input id="oa-user-new-bandwidth" name="new_limit_bandwidth_mb" type="number" min="0" value="${asValue(values, 'new_limit_bandwidth_mb', 102400)}"></div>
            <div class="field"><label class="field-label" for="oa-user-new-databases">Bazy danych</label><input id="oa-user-new-databases" name="new_limit_databases" type="number" min="0" value="${asValue(values, 'new_limit_databases', 10)}"></div>
          </div>
          <p class="field-help">Pozostaw nazwę pustą, aby użyć wybranego pakietu. Nowy pakiet zostanie utworzony w tej samej operacji co konto.</p>
        </details>`)}
      <div class="wizard-actions"><button type="button" class="btn btn-ghost" data-wizard-back>← Wstecz</button><button type="button" class="btn btn-primary" data-wizard-next>Dalej: domena →</button></div>
    </div>

    <div data-wizard-step="3" data-wizard-title="Domena, IP i DNS">
      ${card('Krok 3 z 5 · Domena, IP i DNS', h`
        <div class="form-grid">
          <div class="field field-full"><label class="field-label" for="oa-user-domain">Domena główna</label>
            <input id="oa-user-domain" name="domain" value="${asValue(values, 'domain')}" placeholder="klient.pl" autocomplete="off">
            <p class="field-help">Opcjonalnie. Zostanie utworzona domena, document root, strefa DNS, vhost i certyfikat.</p></div>
          <div class="field"><label class="field-label" for="oa-user-ip">Adres IP</label>
            <select id="oa-user-ip" name="ip"><option value="${setting('server_ip', '127.0.0.1')}">${setting('server_ip', '127.0.0.1')} (serwer)</option>
              ${ipRows.map((row) => h`<option value="${row.ip}" ${String(asValue(values, 'ip', '')) === row.ip ? 'selected' : ''}>${row.ip}${row.owner ? ` — ${row.owner}` : ''}</option>`)}
            </select></div>
          <div class="field"><label class="field-label" for="oa-user-dns-template">Szablon DNS</label>
            <select id="oa-user-dns-template" name="dns_template"><option value="">Automatyczny (pakiet/reseller/domyślny)</option>
              ${templates.map((template) => h`<option value="${template.id}" ${selectedTemplate === String(template.id) ? 'selected' : ''}>${template.name}</option>`)}
            </select><p class="field-help">Szablon z pakietu lub resellera jest używany automatycznie, jeśli nie wybierzesz innego.</p></div>
          <div class="field field-full"><label class="check-field"><input type="checkbox" name="create_dns" value="1" ${wantsDns ? 'checked' : ''}> <span>Utwórz strefę DNS z rekordami A/AAAA/MX/SPF/DKIM/DMARC i autodiscover</span></label></div>
          <div class="field field-full"><label class="check-field"><input type="checkbox" name="check_delegation" value="1" ${asFlag(values, 'check_delegation', defaults.delegationCheck) ? 'checked' : ''}> <span>Sprawdź delegację DNS po utworzeniu domeny</span></label>
            <p class="field-help">Delegacja w toku nie blokuje utworzenia strony — wynik pojawi się jako ostrzeżenie i można go ponowić.</p></div>
        </div>`)}
      <div class="wizard-actions"><button type="button" class="btn btn-ghost" data-wizard-back>← Wstecz</button><button type="button" class="btn btn-primary" data-wizard-next>Dalej: WWW i poczta →</button></div>
    </div>

    <div data-wizard-step="4" data-wizard-title="WWW, PHP, SSL, poczta">
      ${card('Krok 4 z 5 · WWW, PHP, SSL i poczta', h`
        <div class="form-grid">
          <div class="field field-full"><label class="field-label">Silnik WWW</label>${enginePicker({ selected: engine, name: 'engine' })}</div>
          <div class="field"><label class="field-label" for="oa-user-php">Wersja PHP</label>
            <select id="oa-user-php" name="php_version">${phpVersions().map((version) => h`<option value="${version}" ${version === php ? 'selected' : ''}>PHP ${version}</option>`)}</select></div>
          <div class="field"><label class="field-label" for="oa-user-ssl">Certyfikat SSL</label>${sslModeSelect({ selected: ssl, name: 'ssl_mode', id: 'oa-user-ssl' })}
            <p class="field-help">Let's Encrypt wymaga publicznego DNS i portu 80; panel pokaże fallback i może ponowić ACME po propagacji.</p></div>
          <div class="field"><label class="field-label" for="oa-user-mailbox">Skrzynka podstawowa</label>
            <input id="oa-user-mailbox" name="mailbox_local" value="${asValue(values, 'mailbox_local', defaults.mailboxLocal || 'postmaster')}" pattern="[a-z0-9][a-z0-9._-]{0,63}">
            <label class="check-field u-s24"><input type="checkbox" name="create_mailbox" value="1" ${wantsMailbox ? 'checked' : ''}> <span>Utwórz tę skrzynkę</span></label></div>
          <div class="field"><label class="field-label" for="oa-user-mailbox-quota">Limit skrzynki (MB)</label>
            <input id="oa-user-mailbox-quota" name="mailbox_quota_mb" type="number" min="0" value="${asValue(values, 'mailbox_quota_mb', defaults.mailboxQuotaMb || 1024)}"></div>
          <div class="field field-full"><label class="field-label" for="oa-user-app">Aplikacja</label>
            <select id="oa-user-app" name="app">
              ${[['none', 'Brak — pusta strona'], ['wordpress', 'WordPress'], ['nextcloud', 'Nextcloud']].map(([value, label]) => h`<option value="${value}" ${selectedApp === value ? 'selected' : ''}>${label}</option>`)}
            </select></div>
          <div class="field"><label class="field-label" for="oa-user-app-title">Tytuł strony</label><input id="oa-user-app-title" name="app_title" value="${asValue(values, 'app_title')}" placeholder="Moja strona"></div>
          <div class="field"><label class="field-label" for="oa-user-app-user">Login administratora aplikacji</label><input id="oa-user-app-user" name="app_admin_user" value="${asValue(values, 'app_admin_user', 'admin')}" autocomplete="username"></div>
          <div class="field"><label class="field-label" for="oa-user-app-email">E-mail administratora aplikacji</label><input id="oa-user-app-email" name="app_admin_email" type="email" value="${asValue(values, 'app_admin_email')}" autocomplete="email"></div>
          <div class="field"><label class="field-label" for="oa-user-app-pass">Hasło administratora aplikacji</label><input id="oa-user-app-pass" name="app_admin_password" type="password" minlength="8" autocomplete="new-password" placeholder="min. 8 znaków — tylko przy instalacji"></div>
          <div class="field field-full"><div class="row u-s92">
            <label class="check-field"><input type="checkbox" name="docroot" value="1" ${asFlag(values, 'docroot', true) ? 'checked' : ''}> <span>Document root</span></label>
            <label class="check-field"><input type="checkbox" name="php_step" value="1" ${asFlag(values, 'php_step', true) ? 'checked' : ''}> <span>PHP runtime</span></label>
            <label class="check-field"><input type="checkbox" name="vhost" value="1" ${asFlag(values, 'vhost', true) ? 'checked' : ''}> <span>Vhost</span></label>
            <label class="check-field"><input type="checkbox" name="create_backup" value="1" ${wantsBackup ? 'checked' : ''}> <span>Backup dzienny</span></label>
            <label class="check-field"><input type="checkbox" name="create_monitoring" value="1" ${wantsMonitoring ? 'checked' : ''}> <span>Monitoring</span></label>
            <label class="check-field"><input type="checkbox" name="retry_ssl_after_dns" value="1" ${asFlag(values, 'retry_ssl_after_dns', defaults.retrySslAfterDns) ? 'checked' : ''}> <span>Ponów ACME po DNS</span></label>
          </div></div>
        </div>`)}
      <div class="wizard-actions"><button type="button" class="btn btn-ghost" data-wizard-back>← Wstecz</button><button type="button" class="btn btn-primary" data-wizard-next>Dalej: podsumowanie →</button></div>
    </div>

    <div data-wizard-step="5" data-wizard-title="Podsumowanie i preflight" data-preflight>
      ${card('Krok 5 z 5 · Podsumowanie i preflight', h`
        <div data-user-summary class="small muted">Podsumowanie wypełni się na podstawie wybranych wartości.</div>
        <h3 class="form-section">Bezpieczne hasło</h3>
        <div class="form-grid">
          <div class="field"><label class="field-label" for="oa-user-password">Hasło (opcjonalnie)</label>
            <div class="field-control"><input id="oa-user-password" name="password" type="password" minlength="10" placeholder="Pozostaw puste, aby użyć linku aktywacyjnego">
              <button class="btn btn-secondary btn-sm u-s18" type="button" data-genpass="#oa-user-password">Wygeneruj</button></div>
            <p class="field-help">Hasło musi spełniać politykę panelu. Jeśli pozostanie puste, wygenerujemy silne hasło startowe (nigdy nie pokazywane) i jednorazowy link aktywacyjny.</p></div>
          <div class="field"><label class="check-field"><input type="checkbox" name="activation" value="1" ${activation ? 'checked' : ''}> <span>Wyślij/zapisz link aktywacyjny zamiast hasła</span></label>
            <p class="field-help">Link jest jednorazowy i wygasa po godzinie; hasło nie jest wysyłane w wiadomości.</p></div>
          <div class="field"><label class="check-field"><input type="checkbox" name="notify" value="1" ${asFlag(values, 'notify', true) ? 'checked' : ''}> <span>Zapisz wiadomość powitalną w panelu</span></label></div>
        </div>
        <p class="small muted">„Utwórz konto” uruchomi preflight i atomowe wdrożenie. Błąd w dowolnym kroku wycofa utworzone konto, domenę, pocztę i profil backupu.</p>`)}
      <div class="wizard-actions"><button type="button" class="btn btn-ghost" data-wizard-back>← Wstecz</button><button type="button" class="btn btn-primary" data-wizard-submit>${icon('plus', { size: 16 })} Utwórz konto</button></div>
    </div>

    <div class="form-actions" data-wizard-fallback>
      <button class="btn btn-primary" type="submit">Utwórz konto</button>
      <a class="btn btn-ghost" href="${path}">Anuluj</a>
    </div>

    <script type="application/json" id="oa-package-summaries">${raw(JSON.stringify(summaries).replace(/</g, '\\u003c'))}</script>
    <script>
      (() => {
        const select = document.getElementById('oa-user-package');
        const target = document.querySelector('[data-package-summary]');
        const dataNode = document.getElementById('oa-package-summaries');
        let summaries = {};
        try { summaries = JSON.parse(dataNode.textContent || '{}'); } catch { summaries = {}; }
        const limit = (value, unit = '') => value === undefined ? '—' : Number(value) === 0 ? 'bez limitu' : value + unit;
        const render = () => {
          const limits = summaries[select && select.value] || {};
          if (!target) return;
          const rows = [
            ['Domeny', limit(limits.domains)],
            ['Subdomeny', limit(limits.subdomains)],
            ['Skrzynki e-mail', limit(limits.emails)],
            ['Dysk', limit(limits.disk_mb, ' MB')],
            ['Transfer', limit(limits.bandwidth_mb, ' MB')],
            ['Bazy danych', limit(limits.databases)],
            ['PHP', (limits.php || []).join(', ') || 'domyślna wersja'],
          ];
          target.innerHTML = '<table class="data-table"><tbody>' + rows.map(([key, value]) => '<tr><th scope="row">' + key + '</th><td>' + String(value) + '</td></tr>').join('') + '</tbody></table>';
        };
        if (select) select.addEventListener('change', render);
        render();
        const summarize = () => {
          const box = document.querySelector('[data-user-summary]');
          if (!box) return;
          const value = (name) => { const field = document.querySelector('[name="' + name + '"]'); return field ? field.value : ''; };
          const items = [
            ['Login', value('username')],
            ['E-mail', value('email')],
            ['Pakiet', value('package') || value('new_package_name')],
            ['Domena', value('domain') || 'bez domeny'],
            ['PHP', value('php_version')],
            ['Skrzynka', value('create_mailbox') ? (value('mailbox_local') || 'postmaster') + '@' + (value('domain') || '—') : 'brak'],
          ];
          box.innerHTML = '<table class="data-table"><tbody>' + items.map(([key, item]) => '<tr><th scope="row">' + key + '</th><td>' + String(item) + '</td></tr>').join('') + '</tbody></table>';
        };
        document.querySelectorAll('#user-provision-wizard [data-wizard-next], #user-provision-wizard [data-wizard-back], #user-provision-wizard input, #user-provision-wizard select').forEach((el) => {
          el.addEventListener(el.tagName === 'INPUT' || el.tagName === 'SELECT' ? 'input' : 'click', summarize);
        });
        summarize();
      })();
    </script>
  </form>`;
  return html;
}

export function register(router) {
  router.get('/user/websites/new', (ctx) => {
    const values = {
      domain: '', engine: '', phpVersion: setting('php_default', '8.3'), sslMode: 'selfsigned',
      createDns: true, subdomains: [], appType: 'none', appTitle: '', appUser: 'admin', appEmail: ctx.user.email || '',
      dnsTemplate: '', checkDelegation: false, createMailbox: true, mailboxLocal: 'postmaster', mailboxQuotaMb: 1024,
      backup: true, monitoring: true, retrySslAfterDns: true,
    };
    return page(ctx, { title: 'Dodaj stronę', subtitle: 'Cztery kroki: domena i silnik, PHP/SSL/DNS, subdomeny, aplikacja', body: wizardPage(ctx, values), wide: true });
  });

  router.post('/user/websites/new', (ctx) => {
    const values = valuesFromBody(ctx);
    const app = appFromBody(ctx.body || {}, ctx.user);
    let result;
    try {
      result = createSite({
        user: ctx.user,
        domain: values.domain,
        engine: values.engine,
        phpVersion: values.phpVersion,
        sslMode: values.sslMode,
        createDns: values.createDns,
        subdomains: values.subdomains,
        app,
        dnsTemplate: values.dnsTemplate || null,
        checkDelegation: values.checkDelegation,
        retrySslAfterDns: values.retrySslAfterDns,
        mailbox: values.createMailbox ? { local: values.mailboxLocal, quotaMb: values.mailboxQuotaMb } : null,
        backup: values.backup,
        monitoring: values.monitoring,
        ip: ctx.ip,
      });
    } catch (e) {
      return page(ctx, {
        title: 'Dodaj stronę', subtitle: 'Błąd provisioningu',
        body: h`${alert(`Nie udało się uruchomić provisioningu: ${e.message}`, 'danger')}
          ${wizardPage(ctx, values)}`,
        wide: true,
      });
    }
    if (!result.ok && !result.created) {
      return page(ctx, {
        title: 'Dodaj stronę', subtitle: 'Popraw konfigurację i spróbuj ponownie',
        body: h`${alert('Konfiguracja została odrzucona — nic nie zostało utworzone.', 'danger')}
          ${result.errors?.length ? alert(h`${errorList(result.errors)}`, 'danger', { title: 'Co trzeba poprawić' }) : ''}
          ${wizardPage(ctx, values)}`,
        wide: true,
      });
    }
    return page(ctx, {
      title: result.ok ? 'Strona gotowa' : 'Wdrożenie z błędami',
      subtitle: result.domain,
      body: resultPage(ctx, result),
      wide: true,
    });
  });

  router.get('/user/email/new', (ctx) => {
    const domains = visibleDomains(ctx.user);
    const selected = ctx.query.domain || domains[0]?.name || '';
    if (!domains.length) return ctx.redirect('/user/websites/new?flash=' + encodeURIComponent('Najpierw dodaj domenę') + '&type=error');
    const body = h`${card('Dodaj skrzynkę e-mail', h`
      <form method="post" action="/user/email/new" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Domena</label><select name="domain">${domains.map((d) => h`<option value="${d.name}" ${selected === d.name ? 'selected' : ''}>${d.name}</option>`)}</select></div>
          <div class="field"><label class="field-label">Nazwa skrzynki</label><input name="local" placeholder="kontakt" required></div>
          <div class="field"><label class="field-label">Hasło</label><input name="password" type="password" minlength="8" required></div>
          <div class="field"><label class="field-label">Limit (MB)</label><input name="quota_mb" type="number" min="0" value="1024"></div>
        </div>
        <p class="small muted">Po utworzeniu pokażemy ustawienia IMAP/SMTP i autokonfigurację dla telefonu i Outlooka.</p>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Utwórz skrzynkę</button></div>
      </form>`)}`;
    return page(ctx, { title: 'Dodaj pocztę', subtitle: 'Skrzynka i ustawienia klienta', body });
  });

  router.post('/user/email/new', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/email/new?flash=' + encodeURIComponent('Nieprawidłowa domena') + '&type=error');
    const local = String(ctx.body.local || '').toLowerCase().trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(local)) return ctx.redirect('/user/email/new?flash=' + encodeURIComponent('Nieprawidłowa nazwa skrzynki') + '&type=error');
    const password = String(ctx.body.password || '');
    if (password.length < 8) return ctx.redirect('/user/email/new?flash=' + encodeURIComponent('Hasło musi mieć co najmniej 8 znaków') + '&type=error');
    const q = quota(ctx.user, 'emails');
    if (!q.ok) return ctx.redirect('/user/email/new?flash=' + encodeURIComponent('Osiągnięto limit skrzynek') + '&type=error');
    let mailHash = null;
    try { mailHash = dovecotHash(password); } catch { /* optional */ }
    run(`INSERT INTO email_accounts(domain_id, domain, local_part, password, quota_mb, used_mb, suspended, created_at, mail_hash)
         VALUES(?,?,?,?,?,?,?,?,?)`, d.id, d.name, local, hashPassword(password), Number(ctx.body.quota_mb) || 1024, 0, 0, nowIso(), mailHash);
    syncMail();
    apply({ mail: true, dns: true });
    audit(ctx.user.username, ctx.user.level, 'email.create', `${local}@${d.name}`, ctx.ip);
    const s = clientSettings(`${local}@${d.name}`);
    const body = h`${card('Skrzynka utworzona', h`
      ${alert('Poczta jest gotowa. Poniżej ustawienia do telefonu, Outlooka lub Thunderbirda.', 'ok')}
      ${kvList([
      ['Adres e-mail', h`<code>${s.address}</code>`],
      ['IMAP', h`<code>${s.imap.host}:${s.imap.port}</code> (SSL/TLS)`],
      ['SMTP', h`<code>${s.smtp.host}:${s.smtp.port}</code> (STARTTLS)`],
      ['Login', h`<code>${s.address}</code>`],
      ['Autokonfiguracja', h`<code>http://${s.server}/mail/config-v1.1.xml</code>`],
    ])}
      <div class="row mt-18">
        <a class="btn btn-primary" href="/webmail">Otwórz webmail</a>
        <a class="btn btn-secondary" href="/user/email/client-settings?address=${encodeURIComponent(s.address)}">Ustawienia klienta</a>
        <a class="btn btn-ghost" href="/user/email">Wszystkie skrzynki</a>
      </div>`)}`;
    return page(ctx, { title: 'Gotowe', subtitle: s.address, body });
  });

  /* --------------------------------------------- account activation links */
  for (const base of ['/admin/users', '/reseller/users']) {
    router.post(`${base}/:id/activation`, (ctx) => {
      const target = get('SELECT * FROM users WHERE id = ?', Number(ctx.params.id));
      if (!target || target.level === 'admin' || !canManageUser(ctx.user, target)) {
        return ctx.redirect(`${base}?flash=${encodeURIComponent('Brak uprawnień do tego konta')}&type=error`);
      }
      const link = createActivationLink(target, ctx.user.username);
      if (!link.ok) return ctx.redirect(`${base}/${target.id}?flash=${encodeURIComponent(link.error || 'Nie udało się utworzyć linku')}&type=error`);
      audit(ctx.user.username, ctx.user.level, 'user.activation.resend', target.username, ctx.ip);
      return ctx.redirect(`${base}/${target.id}?flash=${encodeURIComponent('Nowy link aktywacyjny wygenerowany (ważny 1 godzinę)')}`);
    });
  }
}
