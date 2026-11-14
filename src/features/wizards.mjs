// Guided flows for non-technical users: add a website and add a mailbox.
import { html as h } from '../util.mjs';
import { run, nowIso, hashPassword, audit, setting } from '../db.mjs';
import { page } from '../ui/respond.mjs';
import { card, alert, kvList, badge } from '../ui/components.mjs';
import { quota, visibleDomains, domainFor } from '../core/access.mjs';
import { createSite, engineChoices, phpVersions } from '../provisioning.mjs';
import { enginePicker, sslModeSelect, provisioningSteps } from './webserver.mjs';
import { dovecotHash, syncMail } from '../mail.mjs';
import { apply } from '../apply.mjs';
import { clientSettings } from '../autoconfig.mjs';

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
  };
}

function subdomainRow(value = '', { removable = true } = {}) {
  return h`<div class="row" data-subdomain-row style="align-items:flex-end">
    <div class="field" style="flex:1;min-width:180px">
      <label class="field-label">Subdomena</label>
      <input name="subdomains[]" value="${value}" placeholder="blog" autocomplete="off">
    </div>
    <button type="button" class="btn btn-ghost btn-sm" data-remove-subdomain ${removable ? '' : 'hidden'}>Usuń</button>
  </div>`;
}

function subdomainEditor(values) {
  const rows = values.subdomains.length ? values.subdomains : [''];
  return h`
    <div style="display:flex;flex-direction:column;gap:8px" data-subdomain-rows>
      ${rows.map((name, i) => subdomainRow(name, { removable: i > 0 || rows.length > 1 }))}
    </div>
    <button type="button" class="btn btn-secondary btn-sm" data-add-subdomain style="margin-top:10px">+ Dodaj subdomenę</button>
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
    <p class="small muted" style="margin-top:12px">Jeśli domena nie jest jeszcze delegowana do tego serwera, ustaw u niej rekordy lub NS. Poniżej domyślne rekordy panelu:</p>
    <pre class="code-block">${dnsInfo(result.domain)}</pre>
    <div class="row" style="margin-top:12px">
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
  return h`${wizardForm(ctx, values)}
    ${domains.length ? card('Masz już domeny', h`${domains.map((d) => h`<div class="spread" style="padding:6px 0"><a class="link" href="/user/files?path=${encodeURIComponent(d.docroot || '/')}">${d.name}</a><span>${d.ssl ? badge('SSL', 'ok') : badge('bez SSL', 'warn')}</span></div>`)}`) : ''}`;
}

export function register(router) {
  router.get('/user/websites/new', (ctx) => {
    const values = {
      domain: '', engine: '', phpVersion: setting('php_default', '8.3'), sslMode: 'selfsigned',
      createDns: true, subdomains: [], appType: 'none', appTitle: '', appUser: 'admin', appEmail: ctx.user.email || '',
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
}
