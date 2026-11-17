import fs from 'node:fs';
// Domains, subdomains, DNS zones, domain pointers and redirects.
import { all, get, run, nowIso, setting, setSetting, audit } from '../db.mjs';
import { limitsFor } from '../auth.mjs';
import { html as h, isDomain, formatBytes, formatDate, e } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, form, btn, badge, statusBadge, pageHead, alert, emptyState, tabs, toolbar, kvList } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { domainSelect, listCard } from '../ui/pages/list.mjs';
import { quota, visibleDomains, domainFor } from '../core/access.mjs';
import { rebuildZone, zoneMeta, zonePath } from '../dns.mjs';
import { runHooks } from '../plugins.mjs';
import { apply } from '../apply.mjs';
import { SERVERS, activeServer } from '../webserver.mjs';
import {
  createSite, createZone, cleanupDomainFiles, applySsl, redeploySite, lastProvision,
  saveSiteStatus, phpVersions, normalizeEngine, engineChoices, removeVhost, provisionSubdomainRoot,
  retrySiteSteps, recommendedDefaults, rememberChoices, siteMonitoring, checkSiteMonitoring,
} from '../provisioning.mjs';
import {
  templates as dnsTemplates, previewZoneChange, applyZonePlan, rollbackZoneChange,
  lastZoneSnapshot, publicZoneInfo, importBind, exportBind, setTemplateBinding,
} from '../dnsops.mjs';
import { enginePicker, sslModeSelect, provisioningSteps } from './webserver.mjs';
import { purgeAcmeForDomain } from '../autossl.mjs';

export { createZone };

function serverIp() { return setting('server_ip', '127.0.0.1'); }

function phpOptions() {
  const list = phpVersions();
  return list;
}

export function userDomains(ctx) {
  const domains = visibleDomains(ctx.user);
  const lim = limitsFor(ctx.user);
  const rows = domains.map((d) => ({
    ...d,
    engineLabel: (SERVERS[setting(`web_server:${d.name}`, '') || setting('web_server', 'nginx')] || SERVERS.nginx).label,
    subCount: get('SELECT COUNT(*) n FROM subdomains WHERE domain_id = ?', d.id).n,
    mailCount: get('SELECT COUNT(*) n FROM email_accounts WHERE domain_id = ?', d.id).n,
    dnsCount: get('SELECT COUNT(*) n FROM dns_records WHERE domain_id = ?', d.id).n,
  }));
  const body = h`
    ${alert(h`Domeny używają katalogu <strong>/home/${ctx.user.username}/domains/&lt;domena&gt;/public_html</strong> jako document root — tak jak w DirectAdmin.`, 'info')}
    ${listCard({
      title: 'Domains', sub: `${rows.length} domain${rows.length === 1 ? '' : 's'}${lim.domains ? ` of ${lim.domains} allowed` : ' · unlimited'}`,
      columns: [
        { label: 'Domain', render: (r) => h`<a class="cell-strong" href="/user/dns?domain=${r.name}">${r.name}</a><span class="cell-sub">${r.docroot || ''}</span>` },
        { label: 'Engine', render: (r) => h`<span class="cell-sub">${r.engineLabel}</span>` },
        { label: 'PHP', key: 'php_version' },
        { label: 'Subdomains', render: (r) => r.subCount },
        { label: 'Mailboxes', render: (r) => r.mailCount },
        { label: 'SSL', render: (r) => (r.ssl ? badge('Enabled', 'ok') : badge('Off', 'muted')) },
        { label: 'Disk', render: (r) => formatBytes(r.disk_mb), align: 'right' },
      ],
      rows,
      createHref: '/user/domains/create',
      createLabel: 'Add domain',
      actions: [
        { label: 'DNS', href: (r) => `/user/dns?domain=${r.name}`, icon: 'dns' },
        { label: 'Files', href: (r) => `/user/files?path=${encodeURIComponent(r.docroot || '/')}`, icon: 'folder' },
        { label: 'SSL', href: (r) => `/user/ssl?domain=${r.name}`, icon: 'lock' },
        { label: 'Edytuj', href: (r) => `/user/domains/${r.id}/edit`, icon: 'edit' },
        { label: 'Otwórz', href: (r) => `http://${r.name}/`, icon: 'globe' },
        { label: 'Logi', href: (r) => `/user/domains/${r.id}/logs`, icon: 'file' },
        { label: 'Delete', href: '#', icon: 'trash', danger: true, form: (r) => `/user/domains/${r.id}/delete`, confirm: 'Usunąć domenę wraz ze strefą DNS, pocztą i bazami?', icon: 'trash' },
      ],
      empty: 'No domains yet. Add your first domain to get started.',
      responsive: true,
    })}`;
  return page(ctx, { title: 'Domeny', subtitle: 'Zarządzaj domenami na swoim koncie', body });
}

export function domainCreatePage(ctx, error = '', values = {}) {
  const domains = visibleDomains(ctx.user);
  const q = quota(ctx.user, 'domains');
  const phpList = phpOptions();
  const defaults = recommendedDefaults({ actor: ctx.user, kind: 'domain' });
  const selectedPhp = values.phpVersion || ctx.body?.php_version || defaults.phpVersion || setting('php_default', '8.3');
  const selectedEngine = values.engine || ctx.body?.engine || defaults.engine || '';
  const createDns = values.createDns !== undefined
    ? !!values.createDns
    : ctx.body?.create_dns !== undefined
      ? !!(ctx.body.create_dns === '1' || ctx.body.create_dns === 'on' || ctx.body.create_dns === true)
      : defaults.createDns;
  const selectedSsl = values.sslMode
    || (ctx.body?.ssl_mode !== undefined ? String(ctx.body.ssl_mode) : ctx.body?.ssl !== undefined ? (ctx.body.ssl === '1' || ctx.body.ssl === 'on' ? 'selfsigned' : 'none') : defaults.sslMode || 'selfsigned');
  const chosen = engineChoices().find((engine) => engine.id === selectedEngine);
  const templates = (() => { try { return all('SELECT * FROM dns_templates ORDER BY name'); } catch { return []; } })();
  const selectedTemplate = String(values.dnsTemplate ?? ctx.body?.dns_template ?? defaults.dnsTemplateId ?? '');
  const createMailbox = values.createMailbox !== undefined ? !!values.createMailbox : ctx.body ? ctx.body.create_mailbox === '1' : defaults.createMailbox;
  const createBackup = values.backup !== undefined ? !!values.backup : ctx.body ? ctx.body.create_backup === '1' : defaults.backup;
  const createMonitoring = values.monitoring !== undefined ? !!values.monitoring : ctx.body ? ctx.body.create_monitoring === '1' : defaults.monitoring;
  const selectedApp = String(values.app ?? ctx.body?.app ?? 'none');
  const expert = setting(`dns_expert:${ctx.user.username}`, '0') === '1';
  const body = h`${error ? alert(error, 'danger') : ''}
    ${!q.ok ? alert(`You have reached your domain limit (${q.used}/${q.limit}). Remove a domain or ask your reseller for a larger package.`, 'warn') : ''}
    <form method="post" action="/user/domains/create" class="oa-form" id="domain-provision-wizard" data-wizard>
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <input type="hidden" name="wizard" value="1">
      <ol class="wizard-steps" data-wizard-indicator aria-label="Kroki dodawania domeny">
        ${[['Domena i silnik', 'adres i serwer WWW'], ['Document root i DNS', 'strefa i szablon'], ['Vhost i SSL', 'certyfikat i ponowienie'], ['Poczta i aplikacja', 'skrzynka podstawowa'], ['Backup i podsumowanie', 'monitoring i zapis']].map(([label, hint], index) => h`<li class="wizard-step ${index === 0 ? 'is-active' : ''}" data-wizard-indicator-step="${index + 1}">
          <span class="wizard-step-marker">${index + 1}</span><span class="wizard-step-copy"><strong>${label}</strong><small>${hint}</small></span>
        </li>`)}
      </ol>

      <div data-wizard-step="1" data-wizard-title="Domena i silnik">
        ${card('Krok 1 z 5 · Domena i silnik WWW', h`
          <div class="form-grid">
            <div class="field field-full"><label class="field-label" for="dname">Nazwa domeny <span class="req">*</span></label>
              <input id="dname" name="domain" type="text" required placeholder="example.com" value="${values.domain || ctx.body?.domain || ''}" ${!q.ok ? 'disabled' : ''}>
              <p class="field-help">Bez http:// i końcowego ukośnika. Istniejąca domena na Twoim koncie zostanie bezpiecznie zrekoncyliowana.</p></div>
            <details class="advanced-options field-full">
              <summary>Opcje zaawansowane: silnik WWW, PHP i certyfikat</summary>
              <p class="field-help">Domyślnie używamy zalecanej konfiguracji serwera. Zmień ją tylko, jeśli wiesz, czego potrzebujesz.</p>
              <div class="field"><label class="field-label">Silnik WWW</label>
                ${enginePicker({ selected: selectedEngine, name: 'engine' })}
                <p class="field-help">${chosen ? `Wybrano: ${chosen.label}. ` : ''}Wybór jest zapisywany dla tej domeny i używany do generowania vhosta.</p></div>
              <div class="field"><label class="field-label" for="php">Wersja PHP</label>
                <select id="php" name="php_version">${phpList.map((v) => h`<option value="${v}" ${v === selectedPhp ? 'selected' : ''}>PHP ${v}</option>`)}</select></div>
              <div class="field"><label class="field-label" for="domain-ssl">Tryb SSL</label>
                ${sslModeSelect({ selected: selectedSsl, name: 'ssl_mode', id: 'domain-ssl' })}
                <p class="field-help">Let's Encrypt wymaga publicznego DNS. Panel użyje certyfikatu self-signed i ponowi ACME po propagacji.</p></div>
            </details>
          </div>`)}
        <div class="wizard-actions"><button type="button" class="btn btn-primary" data-wizard-next>Dalej: katalog i DNS →</button></div>
      </div>

      <div data-wizard-step="2" data-wizard-title="Document root i DNS">
        ${card('Krok 2 z 5 · Document root i DNS', h`
          <div class="form-grid">
            <div class="field field-full"><label class="check-field"><input type="checkbox" name="docroot" value="1" ${values.docroot === undefined || values.docroot ? 'checked' : ''}> <span>Utwórz document root i stronę startową</span></label>
              <p class="field-help">Domyślnie <code>/home/${ctx.user.username}/domains/&lt;domena&gt;/public_html</code> — tak jak w DirectAdmin.</p></div>
            <div class="field field-full"><label class="check-field"><input type="checkbox" name="create_dns" value="1" ${createDns ? 'checked' : ''}><span>Utwórz strefę DNS z rekordami A/AAAA/MX/SPF/DKIM/DMARC i autodiscover</span></label>
              <p class="field-help">Rekordy generuje szablon pakietu/resellera lub wbudowany zestaw automatyczny. Ścieżka pliku strefy pozostaje ukryta poza trybem eksperckim.</p></div>
            <div class="field"><label class="field-label" for="domain-dns-template">Szablon DNS</label>
              <select id="domain-dns-template" name="dns_template"><option value="">Automatyczny (pakiet/reseller/domyślny)</option>
                ${templates.map((template) => h`<option value="${template.id}" ${selectedTemplate === String(template.id) ? 'selected' : ''}>${template.name}</option>`)}
              </select></div>
            <div class="field"><label class="field-label" for="domain-ip">IP (opcjonalnie)</label><input id="domain-ip" name="ip" value="${values.ip || ctx.body?.ip || ''}" placeholder="${setting('server_ip', '127.0.0.1')}"></div>
            <div class="field field-full"><label class="check-field"><input type="checkbox" name="check_delegation" value="1" ${values.checkDelegation ? 'checked' : ''}> <span>Sprawdź delegację DNS po utworzeniu domeny</span></label>
              <p class="field-help">Sprawdzenie używa publicznego resolvera. Delegacja w toku nie blokuje utworzenia strony — wynik można ponowić.</p></div>
          </div>`)}
        <div class="wizard-actions"><button type="button" class="btn btn-ghost" data-wizard-back>← Wstecz</button><button type="button" class="btn btn-primary" data-wizard-next>Dalej: vhost i SSL →</button></div>
      </div>

      <div data-wizard-step="3" data-wizard-title="Vhost i SSL">
        ${card('Krok 3 z 5 · Vhost, PHP i ponowienie ACME', h`
          <div class="form-grid">
            <div class="field field-full"><label class="check-field"><input type="checkbox" name="vhost" value="1" ${values.vhost === undefined || values.vhost ? 'checked' : ''}> <span>Wygeneruj i wdróż vhost</span></label></div>
            <div class="field field-full"><label class="check-field"><input type="checkbox" name="php_step" value="1" ${values.php === undefined || values.php ? 'checked' : ''}> <span>Ustaw runtime PHP</span></label></div>
            <div class="field field-full"><label class="check-field"><input type="checkbox" name="retry_ssl_after_dns" value="1" ${values.retrySslAfterDns === undefined || values.retrySslAfterDns ? 'checked' : ''}> <span>Jeśli Let's Encrypt nie może wystawić certyfikatu, ponów ACME po propagacji DNS</span></label>
              <p class="field-help">Panel zainstaluje wtedy przejściowy certyfikat self-signed i doda zadanie do kolejki AutoSSL. Retry ma backoff i alert dopiero po wyczerpaniu prób.</p></div>
            <div class="field field-full"><label class="check-field"><input type="checkbox" name="ssl" value="1" ${selectedSsl !== 'none' ? 'checked' : ''}> <span>Włącz HTTPS (zgodność ze starym formularzem)</span></label></div>
          </div>`)}
        <div class="wizard-actions"><button type="button" class="btn btn-ghost" data-wizard-back>← Wstecz</button><button type="button" class="btn btn-primary" data-wizard-next>Dalej: poczta i aplikacja →</button></div>
      </div>

      <div data-wizard-step="4" data-wizard-title="Poczta i aplikacja">
        ${card('Krok 4 z 5 · Skrzynka podstawowa i aplikacja', h`
          <div class="form-grid">
            <div class="field"><label class="field-label" for="domain-mailbox">Skrzynka podstawowa</label>
              <input id="domain-mailbox" name="mailbox_local" value="${values.mailboxLocal || ctx.body?.mailbox_local || 'postmaster'}" pattern="[a-z0-9][a-z0-9._-]{0,63}">
              <label class="check-field u-s24"><input type="checkbox" name="create_mailbox" value="1" ${createMailbox ? 'checked' : ''}> <span>Utwórz skrzynkę</span></label>
              <p class="field-help">Bez hasła panel wygeneruje je bezpiecznie; ustawisz je później w module Poczta.</p></div>
            <div class="field"><label class="field-label" for="domain-mailbox-quota">Limit skrzynki (MB)</label>
              <input id="domain-mailbox-quota" name="mailbox_quota_mb" type="number" min="0" value="${values.mailboxQuotaMb || ctx.body?.mailbox_quota_mb || 1024}"></div>
            <div class="field"><label class="field-label" for="domain-app">Aplikacja</label>
              <select id="domain-app" name="app">${[['none', 'Brak — pusta strona'], ['wordpress', 'WordPress'], ['nextcloud', 'Nextcloud']].map(([value, label]) => h`<option value="${value}" ${selectedApp === value ? 'selected' : ''}>${label}</option>`)}</select></div>
            <div class="field"><label class="field-label" for="domain-app-title">Tytuł strony</label><input id="domain-app-title" name="app_title" value="${values.appTitle || ''}"></div>
            <div class="field"><label class="field-label" for="domain-app-user">Login administratora aplikacji</label><input id="domain-app-user" name="app_admin_user" value="${values.appUser || 'admin'}"></div>
            <div class="field"><label class="field-label" for="domain-app-email">E-mail administratora</label><input id="domain-app-email" name="app_admin_email" type="email" value="${values.appEmail || ctx.user.email || ''}"></div>
            <div class="field field-full"><label class="field-label" for="domain-app-pass">Hasło administratora aplikacji</label><input id="domain-app-pass" name="app_admin_password" type="password" minlength="8" autocomplete="new-password" placeholder="min. 8 znaków — tylko przy instalacji"><p class="field-help">Hasło aplikacji pojawi się jednorazowo w wyniku instalacji i nie jest zapisywane w statusie wdrożenia.</p></div>
          </div>`)}
        <div class="wizard-actions"><button type="button" class="btn btn-ghost" data-wizard-back>← Wstecz</button><button type="button" class="btn btn-primary" data-wizard-next>Dalej: backup i podsumowanie →</button></div>
      </div>

      <div data-wizard-step="5" data-wizard-title="Backup i podsumowanie">
        ${card('Krok 5 z 5 · Backup, monitoring i podsumowanie', h`
          <div class="form-grid">
            <div class="field field-full"><label class="check-field"><input type="checkbox" name="create_backup" value="1" ${createBackup ? 'checked' : ''}> <span>Dzienny profil backupu dla konta i tej domeny</span></label>
              <p class="field-help">Tworzy realny job w Backup Center (harmonogram, retencja) — nie dekoracyjny przełącznik.</p></div>
            <div class="field field-full"><label class="check-field"><input type="checkbox" name="create_monitoring" value="1" ${createMonitoring ? 'checked' : ''}> <span>Monitoring dostępności strony</span></label>
              <p class="field-help">Zapisuje profil monitoringu; test HTTP uruchomisz przyciskiem „Sprawdź teraz” w edycji domeny.</p></div>
          </div>
          <p class="small muted">Zapis uruchomi preflight i atomowe wdrożenie. Jeżeli którakolwiek operacja kluczowa zawiedzie, utworzona w tym żądaniu domena zostanie wycofana.</p>
          <div class="form-actions u-s52" data-wizard-fallback>
            <button class="btn btn-primary" type="submit" ${!q.ok ? 'disabled' : ''}>${icon('plus', { size: 16 })}<span>Create domain</span></button>
            <a class="btn btn-ghost" href="/user/domains">Cancel</a>
          </div>`)}
          <div class="wizard-actions"><button type="button" class="btn btn-ghost" data-wizard-back>← Wstecz</button><button type="button" class="btn btn-primary" data-wizard-submit>Create domain</button></div>
      </div>
    </form>
    ${card('Istniejące domeny', h`${domains.length ? h`<div class="stack u-s49">${domains.map((d) => h`<div class="existing-domain">
      <strong>${d.name}</strong>
      <code class="existing-domain-path">${d.docroot || '—'}</code>
    </div>`)}</div>` : emptyState('Brak domen.')}`)}`;
  return page(ctx, { title: 'Dodaj domenę', subtitle: 'Utwórz stronę, pocztę i certyfikat w jednym kroku', body, wide: true });
}

export function registerDomainsPost(router) {
  router.post('/user/domains/create', (ctx) => {
    const body = ctx.body || {};
    const wizard = body.wizard === '1';
    const values = {
      domain: String(body.domain || '').trim().toLowerCase(),
      engine: String(body.engine || '').trim().toLowerCase(),
      phpVersion: String(body.php_version || setting('php_default', '8.3')),
      createDns: wizard ? body.create_dns === '1' : body.create_dns === '1' || body.create_dns === 'on' || body.create_dns === true,
      sslMode: body.ssl_mode !== undefined
        ? String(body.ssl_mode)
        : (body.ssl !== undefined ? (body.ssl === '1' || body.ssl === 'on' ? 'selfsigned' : 'none') : 'selfsigned'),
      docroot: wizard ? body.docroot === '1' : true,
      vhost: wizard ? body.vhost === '1' : true,
      php: wizard ? body.php_step === '1' : true,
      dnsTemplate: String(body.dns_template || ''),
      checkDelegation: wizard ? body.check_delegation === '1' : false,
      retrySslAfterDns: wizard ? body.retry_ssl_after_dns === '1' : false,
      createMailbox: wizard ? body.create_mailbox === '1' : false,
      mailboxLocal: String(body.mailbox_local || 'postmaster').trim().toLowerCase(),
      mailboxQuotaMb: Number(body.mailbox_quota_mb ?? 1024),
      app: String(body.app || 'none').trim().toLowerCase(),
      appTitle: String(body.app_title || ''),
      appUser: String(body.app_admin_user || 'admin'),
      appEmail: String(body.app_admin_email || ctx.user.email || ''),
      appPassword: String(body.app_admin_password || ''),
      backup: wizard ? body.create_backup === '1' : false,
      monitoring: wizard ? body.create_monitoring === '1' : false,
    };
    const existing = isDomain(values.domain) ? get('SELECT * FROM domains WHERE name = ?', values.domain) : null;
    if (existing && existing.user_id !== ctx.user.id) {
      return domainCreatePage(ctx, 'That domain already exists on the server.', values);
    }
    // A repeat submission for the same domain is a safe reconcile, not an error.
    let result;
    try {
      result = createSite({
        user: ctx.user,
        domain: values.domain,
        engine: values.engine,
        phpVersion: values.phpVersion,
        sslMode: values.sslMode,
        createDns: values.createDns,
        dnsTemplate: values.dnsTemplate || null,
        ip: String(body.ip || ''),
        docroot: values.docroot,
        vhost: values.vhost,
        php: values.php,
        checkDelegation: values.checkDelegation,
        retrySslAfterDns: values.retrySslAfterDns,
        mailbox: values.createMailbox ? {
          local: values.mailboxLocal, quotaMb: values.mailboxQuotaMb,
        } : null,
        app: values.app === 'none' ? null : {
          type: values.app, title: values.appTitle, adminUser: values.appUser,
          adminEmail: values.appEmail, adminPassword: values.appPassword,
        },
        backup: values.backup,
        monitoring: values.monitoring,
        rollbackOnFailure: true,
      });
    } catch (error) {
      return domainCreatePage(ctx, `Provisioning failed: ${error.message}`, values);
    }
    if (!result.ok && !result.created) {
      const message = (result.errors || []).map((err) => err.message).join(' ') || 'Could not create the domain.';
      return domainCreatePage(ctx, message, values);
    }
    if (result.rolledBack) {
      const message = (result.errors || []).map((err) => err.message).join(' ') || 'Provisioning failed.';
      return domainCreatePage(ctx, `${message} The partially created domain was rolled back.`, values);
    }
    try { runHooks('domain.create', { domain: values.domain, username: ctx.user.username, php: result.phpVersion, engine: result.engine }); } catch { /* ignore */ }
    try {
      rememberChoices(ctx.user, 'domain', {
        engine: values.engine, phpVersion: result.phpVersion, sslMode: values.sslMode,
        dnsTemplateId: values.dnsTemplate ? Number(values.dnsTemplate) || '' : '',
        createDns: values.createDns, createMailbox: values.createMailbox,
        mailboxLocal: values.mailboxLocal, mailboxQuotaMb: values.mailboxQuotaMb,
        backup: values.backup, monitoring: values.monitoring, delegationCheck: values.checkDelegation,
        retrySslAfterDns: values.retrySslAfterDns, docroot: values.docroot, php: values.php, vhost: values.vhost,
      });
    } catch { /* preferences are best effort */ }
    if (!result.ok) {
      return ctx.redirect(`/user/domains/${result.domainId}/edit`, {
        flash: `Domain ${values.domain} was created, but provisioning reported warnings. Review the deployment steps and retry only failed ones.`,
        type: 'error',
      });
    }
    return ctx.redirect(`/user/domains/${result.domainId}/edit?created=1&flash=` + encodeURIComponent(
      result.created ? `Domain ${values.domain} created on ${result.engineLabel}` : `Domain ${values.domain} already existed — components reconciled`,
    ));
  });

  router.post('/user/domains/:id/retry', (ctx) => {
    const d = domainFor(ctx.user, ctx.params.id);
    if (!d) return ctx.redirect('/user/domains?flash=Domain%20not%20found&type=error');
    const raw = ctx.body.steps ?? ctx.body['steps[]'] ?? [];
    const steps = (Array.isArray(raw) ? raw : [raw]).map(String).filter(Boolean);
    const result = retrySiteSteps({ user: ctx.user, domain: d.name, steps, ip: ctx.ip });
    return ctx.redirect(`/user/domains/${d.id}/edit`, {
      flash: result.ok
        ? `Ponowiono tylko kroki: ${result.retried.map((step) => step.key).join(', ') || 'brak'} — wszystkie kluczowe kroki są OK.`
        : `Ponowienie zakończyło się błędami: ${result.errors.map((error) => error.message).join(' ') || 'sprawdź status'}`,
      type: result.ok ? 'ok' : 'error',
    });
  });

  router.post('/user/domains/:id/monitor', async (ctx) => {
    const d = domainFor(ctx.user, ctx.params.id);
    if (!d) return ctx.redirect('/user/domains?flash=Domain%20not%20found&type=error');
    const result = await checkSiteMonitoring(d.name);
    return ctx.redirect(`/user/domains/${d.id}/edit`, {
      flash: result.ok
        ? `Monitoring: ${result.result.ok ? `HTTP ${result.result.status}` : `błąd ${result.result.error || 'połączenia'}`}`
        : result.error,
      type: result.ok && result.result.ok ? 'ok' : 'error',
    });
  });

  router.get('/user/domains/:id/logs', (ctx) => {
    const d = domainFor(ctx.user, ctx.params.id);
    if (!d) return ctx.redirect('/user/domains?flash=Domain%20not%20found&type=error');
    const candidates = [
      `/var/log/nginx/${d.name}.access.log`, `/var/log/nginx/${d.name}.error.log`,
      `/var/log/apache2/${d.name}.access.log`, `/var/log/apache2/${d.name}.error.log`,
      `/usr/local/lsws/logs/${d.name}.access.log`, `/usr/local/lsws/logs/${d.name}.error.log`,
    ].filter((f) => { try { return fs.existsSync(f); } catch { return false; } });
    const logs = candidates.map((f) => {
      let text = '';
      try { text = fs.readFileSync(f, 'utf8').split('\n').slice(-200).join('\n'); } catch { text = 'Nie można odczytać pliku'; }
      return { file: f, text };
    });
    const body = h`${card(`Logi: ${d.name}`, logs.length ? h`${logs.map((l) => h`<h3 class="form-section">${l.file}</h3><pre class="code-block small u-s53">${l.text || '(pusty)'}</pre>`)}` : h`<p class="small muted">Brak plików logów dla tej domeny. Na Linuksie pojawią się po pierwszym żądaniu do strony.</p>`, { actions: [h`<a class="link small" href="http://${d.name}/" target="_blank">Otwórz stronę</a>`] })}`;
    return page(ctx, { title: 'Logi domeny', subtitle: d.name, body, wide: true });
  });

  router.get('/user/domains/:id/edit', (ctx) => {
    const d = domainFor(ctx.user, ctx.params.id);
    if (!d) return ctx.redirect('/user/domains?flash=Domain%20not%20found&type=error');
    const currentEngine = setting(`web_server:${d.name}`, '') || activeServer().id;
    const phpList = phpOptions();
    if ((d.php_version || '') && !phpList.includes(d.php_version)) phpList.push(d.php_version);
    const status = lastProvision(d.name);
    const server = SERVERS[currentEngine] || activeServer();
    const failedSteps = (status?.steps || []).filter((step) => !step.ok && !step.skipped);
    const retryable = failedSteps.filter((step) => ['docroot', 'engine', 'php', 'dns', 'delegation', 'ssl', 'mailbox', 'backup', 'monitoring', 'vhost'].includes(step.key));
    const statusBody = status
      ? h`
        ${status.warnings?.length ? alert(h`${status.warnings.map((w) => h`<div>${w}</div>`)}`, 'warn', { title: 'Warnings' }) : ''}
        ${alert(status.ok ? 'Last deployment completed.' : 'Last deployment completed with warnings or errors.', status.ok ? 'ok' : 'warn')}
        <div class="small muted u-s54">${formatDate(status.at, { time: true })} · ${SERVERS[status.engine]?.label || status.engine || '—'} · PHP ${status.phpVersion || '—'}</div>
        ${provisioningSteps(status.steps || [])}
        ${retryable.length ? h`<form method="post" action="/user/domains/${d.id}/retry" class="oa-form u-s52">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <p class="field-label">Ponów tylko nieudane kroki</p>
          <div class="radio-row">${retryable.map((step) => h`<label class="check-field"><input type="checkbox" name="steps[]" value="${step.key}" checked> <span>${step.label || step.key}</span></label>`)}</div>
          <div class="form-actions"><button class="btn btn-secondary" type="submit">${icon('refresh', { size: 16 })} Ponów zaznaczone kroki</button></div>
        </form>` : ''}`
      : '';
    const monitoring = siteMonitoring(d.name);
    const body = h`
      ${ctx.query.created === '1' ? alert('Domena została utworzona lub zrekoncyliowana. Poniżej rzeczywiste wyniki i możliwość ponowienia tylko nieudanych kroków.', status?.ok === false ? 'warn' : 'ok') : ''}
      ${ctx.query.updated === '1' ? alert('Domain saved. The vhost was regenerated and the deployment result is shown below.', status?.ok === false ? 'warn' : 'ok') : ''}
      ${card(`Edit domain · ${d.name}`, h`<form method="post" action="/user/domains/${d.id}/update" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Domain</label><input value="${d.name}" disabled></div>
          <div class="field"><label class="field-label">Document root</label><input value="${d.docroot || ''}" disabled></div>
          <div class="field field-full"><label class="field-label">Web engine</label>
            ${enginePicker({ selected: currentEngine, name: 'engine' })}
            <p class="field-help">Current: ${server.label} (web_server:${d.name}). Saving regenerates the vhost and runs the deployment pipeline.</p></div>
          <div class="field"><label class="field-label" for="edit-php">PHP version</label>
            <select id="edit-php" name="php_version">${phpList.map((v) => h`<option value="${v}" ${v === d.php_version ? 'selected' : ''}>PHP ${v}</option>`)}</select></div>
          <div class="field"><label class="field-label" for="edit-ssl">SSL</label>
            ${sslModeSelect({ selected: 'keep', name: 'ssl_mode', includeKeep: true, id: 'edit-ssl' })}
            <p class="field-help">Current state: ${d.ssl ? 'enabled' : 'disabled'}. “Keep” never removes an active certificate.</p></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save and redeploy</button><a class="btn btn-ghost" href="/user/domains">Cancel</a></div>
      </form>`, { sub: 'Changing the engine, PHP or SSL updates the domain and re-runs vhost generation automatically.' })}
      ${status ? card('Deployment status', statusBody, { id: 'last-provision-status', sub: 'Result of the last domain create or edit' }) : ''}
      ${monitoring ? card('Monitoring i backup', h`
        ${kvList([
          ['Monitoring', monitoring.enabled ? badge('włączony', 'ok') : badge('wyłączony', 'muted')],
          ['URL', h`<code>${monitoring.url}</code>`],
          ['Ostatni test', monitoring.lastCheck ? `${monitoring.lastCheck.ok ? badge(`HTTP ${monitoring.lastCheck.status}`, 'ok') : badge('błąd', 'danger')} ${formatDate(monitoring.lastCheck.at, { time: true })} ${monitoring.lastCheck.error || ''}` : 'jeszcze nie uruchomiony'],
        ])}
        <form class="u-s55" method="post" action="/user/domains/${d.id}/monitor"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <button class="btn btn-secondary btn-sm" type="submit">${icon('refresh', { size: 14 })} Sprawdź teraz</button>
          <a class="btn btn-ghost btn-sm" href="/user/backups">Profil backupu w Backup Center</a>
        </form>`, { sub: 'Realny test HTTP; profil monitoringu jest zapisany dla tej domeny.' }) : ''}`;
    return page(ctx, { title: 'Edit domain', subtitle: d.name, body, wide: true });
  });

  router.post('/user/domains/:id/update', (ctx) => {
    const d = domainFor(ctx.user, ctx.params.id);
    if (!d) return ctx.redirect('/user/domains?flash=Domain%20not%20found&type=error');
    const engine = normalizeEngine(ctx.body.engine, setting(`web_server:${d.name}`, '') || activeServer().id);
    const choice = engineChoices().find((entry) => entry.id === engine);
    if (!choice || !choice.available) {
      return ctx.redirect(`/user/domains/${d.id}/edit`, {
        flash: `${choice?.label || engine} is not available on this host. The domain was not changed.`,
        type: 'error',
      });
    }
    const phpList = phpOptions();
    const php = phpList.includes(String(ctx.body.php_version)) ? String(ctx.body.php_version) : d.php_version;
    const steps = [];
    const warnings = [];
    let sslStep;
    if (ctx.body.ssl_mode !== undefined) {
      const mode = String(ctx.body.ssl_mode).trim().toLowerCase();
      if (mode === 'keep') {
        sslStep = { key: 'ssl', label: 'SSL certificate', ok: true, skipped: true, mode: 'keep', detail: 'SSL left unchanged' };
      } else if (['none', 'selfsigned', 'letsencrypt'].includes(mode)) {
        sslStep = applySsl({ domain: d.name, docroot: d.docroot, sslMode: mode, email: ctx.user.email || '' });
      } else {
        return ctx.redirect(`/user/domains/${d.id}/edit`, { flash: 'Unknown SSL mode. The domain was not changed.', type: 'error' });
      }
    } else {
      // Backwards compatibility with the old SSL checkbox form.
      const enabled = !!(ctx.body.ssl === '1' || ctx.body.ssl === 'on' || ctx.body.ssl === true);
      if (!enabled) run("UPDATE ssl_certs SET status = 'disabled' WHERE domain = ? AND status = 'active'", d.name);
      run('UPDATE domains SET ssl = ? WHERE id = ?', enabled ? 1 : 0, d.id);
      sslStep = { key: 'ssl', label: 'SSL certificate', ok: true, mode: enabled ? 'selfsigned' : 'none', detail: enabled ? 'SSL enabled (certificate unchanged)' : 'SSL disabled' };
    }
    if (sslStep.warning) warnings.push(sslStep.warning);
    if (!sslStep.ok) warnings.push(sslStep.detail || 'SSL operation failed');
    run('UPDATE domains SET php_version = ? WHERE id = ?', php, d.id);
    setSetting(`web_server:${d.name}`, engine);
    const redeploy = redeploySite({ user: ctx.user, domain: d.name, engine, ip: ctx.ip });
    if (redeploy.warnings?.length) warnings.push(...redeploy.warnings);
    const vhost = (redeploy.steps || []).find((s) => s.key === 'vhost') || { key: 'vhost', label: 'Web server config', ok: false, detail: 'Vhost generation did not run' };
    const allSteps = [
      { key: 'engine', label: 'Web engine', ok: true, detail: `${choice.label} — web_server:${d.name}` },
      { key: 'php', label: 'PHP version', ok: true, detail: `PHP ${php}` },
      sslStep,
      vhost,
    ];
    const ok = sslStep.ok !== false && !!redeploy.ok;
    const sslMode = ctx.body.ssl_mode !== undefined ? String(ctx.body.ssl_mode) : (ctx.body.ssl ? 'selfsigned' : 'none');
    saveSiteStatus(d.name, { ok, created: false, engine, phpVersion: php, sslMode, steps: allSteps, warnings });
    audit(ctx.user.username, ctx.user.level, 'domain.update', d.name, ctx.ip);
    return ctx.redirect(`/user/domains/${d.id}/edit?updated=1`, {
      flash: ok
        ? `Domain ${d.name} updated; ${choice.label} vhost regenerated and redeployed.`
        : `Domain ${d.name} updated with warnings — review the deployment steps below.`,
      type: ok ? 'ok' : 'error',
    });
  });

  router.post('/user/domains/:id/delete', (ctx) => {
    const d = domainFor(ctx.user, ctx.params.id);
    if (!d) return ctx.redirect('/user/domains?flash=Domain%20not%20found&type=error');
    run('DELETE FROM ssl_certs WHERE domain = ?', d.name);
    run('DELETE FROM settings WHERE key = ?', `site_provision_last:${d.name}`);
    run('DELETE FROM settings WHERE key = ?', `site_monitoring:${d.name}`);
    run('DELETE FROM settings WHERE key = ?', `web_server:${d.name}`);
    try { purgeAcmeForDomain(d.name); } catch { /* queue cleanup is best effort */ }
    try { run('DELETE FROM backup_jobs WHERE name = ? AND target_user = ?', `site:${d.name}`, d.username); } catch { /* best effort */ }
    try { fs.rmSync(zonePath(d.name), { force: true }); } catch { /* ignore */ }
    // Remove files before the row so subdomain vhosts can still be resolved.
    try { cleanupDomainFiles({ user: ctx.user, domain: d.name }); } catch { /* cleanup is best effort */ }
    run('DELETE FROM domains WHERE id = ?', d.id);
    apply({ web: true, dns: true });
    audit(ctx.user.username, ctx.user.level, 'domain.delete', d.name, ctx.ip);
    return ctx.redirect('/user/domains?flash=' + encodeURIComponent(`Domain ${d.name} deleted`));
  });


  /* ----------------------------------------------------------- subdomains */
  router.post('/user/subdomains/create', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/subdomains?flash=Choose%20a%20valid%20domain&type=error');
    const sub = String(ctx.body.name || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(sub)) return ctx.redirect('/user/subdomains?flash=Invalid%20subdomain%20name&type=error');
    const q = quota(ctx.user, 'subdomains');
    if (!q.ok) return ctx.redirect('/user/subdomains?flash=Subdomain%20limit%20reached&type=error');
    const docroot = `/home/${ctx.user.username}/domains/${d.name}/public_html/${sub}`;
    try { provisionSubdomainRoot(ctx.user.username, d.name, sub); } catch (e) {
      return ctx.redirect('/user/subdomains?flash=' + encodeURIComponent(`Could not create the subdomain directory: ${e.message}`) + '&type=error');
    }
    run(`INSERT INTO subdomains(domain_id, username, name, php_version, docroot, created_at) VALUES(?,?,?,?,?,?)`,
      d.id, ctx.user.username, sub, d.php_version, docroot, nowIso());
    run(`INSERT INTO dns_records(domain_id, name, type, value, ttl) VALUES(?,?,?,?,?)`, d.id, sub, 'A', d.ip || serverIp(), 3600);
    apply({ web: true, dns: true });
    audit(ctx.user.username, ctx.user.level, 'subdomain.create', `${sub}.${d.name}`, ctx.ip);
    return ctx.redirect('/user/subdomains?flash=' + encodeURIComponent(`Subdomain ${sub}.${d.name} created`));
  });

  router.post('/user/subdomains/:id/update', (ctx) => {
    const sub = get('SELECT * FROM subdomains WHERE id = ? AND username = ?', Number(ctx.params.id), ctx.user.username);
    if (!sub) return ctx.redirect('/user/subdomains?flash=Not%20found&type=error');
    const php = phpOptions().includes(String(ctx.body.php_version)) ? String(ctx.body.php_version) : sub.php_version;
    const docroot = String(ctx.body.docroot || sub.docroot);
    if (!docroot.startsWith(`/home/${ctx.user.username}/`)) return ctx.redirect('/user/subdomains?flash=Document%20root%20must%20be%20inside%20home&type=error');
    run('UPDATE subdomains SET php_version = ?, docroot = ? WHERE id = ?', php, docroot, sub.id);
    apply({ web: true });
    audit(ctx.user.username, ctx.user.level, 'subdomain.update', `${sub.name}`, ctx.ip);
    return ctx.redirect('/user/subdomains?flash=Subdomain%20updated');
  });

  router.post('/user/subdomains/:id/delete', (ctx) => {
    const s = get('SELECT * FROM subdomains WHERE id = ?', Number(ctx.params.id));
    if (!s || s.username !== ctx.user.username) return ctx.redirect('/user/subdomains?flash=Not%20found&type=error');
    const d = get('SELECT * FROM domains WHERE id = ?', s.domain_id);
    run('DELETE FROM subdomains WHERE id = ?', s.id);
    run('DELETE FROM dns_records WHERE domain_id = ? AND name = ? AND type = ?', s.domain_id, s.name, 'A');
    try { removeVhost(`${s.name}.${d?.name || ''}`); } catch { /* best effort */ }
    apply({ web: true, dns: true });
    audit(ctx.user.username, ctx.user.level, 'subdomain.delete', `${s.name}.${d?.name || ''}`, ctx.ip);
    return ctx.redirect('/user/subdomains?flash=' + encodeURIComponent(`Subdomain ${s.name}.${d?.name || ''} deleted`));
  });

  /* ------------------------------------------------------------------ DNS */
  router.post('/user/dns/add', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/dns?flash=Domain%20not%20found&type=error');
    const type = String(ctx.body.type || 'A').toUpperCase();
    const value = String(ctx.body.value || '').trim();
    if (!value) return ctx.redirect('/user/dns?domain=' + encodeURIComponent(d.name) + '&flash=Record%20value%20is%20required&type=error');
    run('INSERT INTO dns_records(domain_id, name, type, value, priority, ttl) VALUES(?,?,?,?,?,?)',
      d.id, String(ctx.body.name || '@').trim() || '@', type, value,
      ctx.body.priority ? Number(ctx.body.priority) : null, Number(ctx.body.ttl) || 3600);
    rebuildZone(d.name);
    apply({ dns: true });
    audit(ctx.user.username, ctx.user.level, 'dns.create', `${d.name} ${type} ${ctx.body.name}`, ctx.ip);
    return ctx.redirect('/user/dns?domain=' + encodeURIComponent(d.name) + '&flash=Record%20added');
  });

  router.post('/user/dns/:id/delete', (ctx) => {
    const r = get('SELECT * FROM dns_records WHERE id = ?', Number(ctx.params.id));
    if (!r) return ctx.redirect('/user/dns?flash=Record%20not%20found&type=error');
    const d = domainFor(ctx.user, r.domain_id);
    if (!d) return ctx.redirect('/user/dns?flash=Access%20denied&type=error');
    run('DELETE FROM dns_records WHERE id = ?', r.id);
    rebuildZone(d.name);
    apply({ dns: true });
    return ctx.redirect('/user/dns?domain=' + encodeURIComponent(d.name) + '&flash=Record%20deleted');
  });

  router.post('/user/dns/:id/update', (ctx) => {
    const r = get('SELECT * FROM dns_records WHERE id = ?', Number(ctx.params.id));
    const d = r ? domainFor(ctx.user, r.domain_id) : null;
    if (!d) return ctx.redirect('/user/dns?flash=Record%20not%20found&type=error');
    run('UPDATE dns_records SET name = ?, type = ?, value = ?, priority = ?, ttl = ? WHERE id = ?',
      String(ctx.body.name || '@'), String(ctx.body.type || 'A').toUpperCase(), String(ctx.body.value || ''),
      ctx.body.priority ? Number(ctx.body.priority) : null, Number(ctx.body.ttl) || 3600, r.id);
    rebuildZone(d.name);
    apply({ dns: true });
    audit(ctx.user.username, ctx.user.level, 'dns.update', `${d.name} #${r.id}`, ctx.ip);
    return ctx.redirect('/user/dns?domain=' + encodeURIComponent(d.name) + '&flash=Record%20updated');
  });

  router.post('/user/dns/expert', (ctx) => {
    const enabled = String(ctx.body.enabled || '') === '1' ? '1' : '0';
    setSetting(`dns_expert:${ctx.user.username}`, enabled);
    return ctx.redirect(`/user/dns${ctx.body.domain ? `?domain=${encodeURIComponent(ctx.body.domain)}` : ''}`);
  });

  router.post('/user/dns/template/apply', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/dns?flash=Domain%20not%20found&type=error');
    const owner = get('SELECT * FROM users WHERE id = ?', d.user_id);
    const result = applyZonePlan(d.name, { templateId: ctx.body.template || null, packageName: owner?.package || '', reseller: owner?.owner || '', actor: ctx.user.username });
    if (!result.ok) {
      return ctx.redirect(`/user/dns?domain=${encodeURIComponent(d.name)}&flash=${encodeURIComponent(result.error || result.errors?.[0]?.message || 'Szablon odrzucony')}&type=error`);
    }
    const scope = String(ctx.body.bind_scope || '');
    let bound = '';
    if (scope) {
      let allowed = false;
      let key = '';
      if (scope === 'domain') { allowed = true; key = d.name; }
      else if (scope === 'package' && owner?.package) {
        const pkg = get('SELECT * FROM packages WHERE name = ?', owner.package);
        if (ctx.user.level === 'admin' || pkg?.owner === ctx.user.username) { allowed = true; key = owner.package; }
      } else if (scope === 'reseller' && owner?.owner) {
        allowed = ctx.user.level === 'admin' || ctx.user.level === 'reseller';
        key = owner.owner;
      }
      if (allowed) {
        const binding = setTemplateBinding({ scope, key, templateId: ctx.body.template || null, actor: ctx.user.username });
        if (binding.ok) bound = `; zapisano jako domyślny dla ${scope}:${key}`;
      }
    }
    return ctx.redirect(`/user/dns?domain=${encodeURIComponent(d.name)}&flash=${encodeURIComponent(`Szablon zastosowany (${result.diff?.counts.added || 0} dodanych, ${result.diff?.counts.changed || 0} zmienionych)${bound}. Punkt przywracania: ${result.snapshotId || '—'}`)}`);
  });

  router.post('/user/dns/rollback', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/dns?flash=Domain%20not%20found&type=error');
    const result = rollbackZoneChange(d.name, ctx.body.snapshot, { actor: ctx.user.username });
    return ctx.redirect(`/user/dns?domain=${encodeURIComponent(d.name)}&flash=${encodeURIComponent(result.ok ? `Przywrócono ${result.restored} rekordów strefy` : result.error)}${result.ok ? '' : '&type=error'}`);
  });

  router.post('/user/dns/import', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/dns?flash=Domain%20not%20found&type=error');
    const text = String(ctx.body.text || '');
    if (Buffer.byteLength(text, 'utf8') > 512 * 1024) {
      return ctx.redirect(`/user/dns?domain=${encodeURIComponent(d.name)}&flash=Plik%20strefy%20jest%20za%20du%C5%BCy&type=error`);
    }
    const dryRun = ctx.body.dry_run === '1';
    const result = importBind(d.name, text, { dryRun, actor: ctx.user.username });
    if (!result.ok && !dryRun) {
      return ctx.redirect(`/user/dns?domain=${encodeURIComponent(d.name)}&flash=${encodeURIComponent(result.error || result.errors?.[0]?.message || 'Import odrzucony')}&type=error`);
    }
    if (!result.ok) {
      const body = h`${card('Import BIND — błędy', h`<ul class="doc-list">${(result.errors || []).map((error) => h`<li><strong>${error.line ? `linia ${error.line}: ` : ''}</strong>${error.message}</li>`)}</ul>
        <a class="btn btn-ghost" href="/user/dns?domain=${encodeURIComponent(d.name)}">Wróć</a>`)}`;
      return page(ctx, { title: 'Import BIND', subtitle: 'Walidacja nie powiodła się', body });
    }
    if (dryRun) {
      const body = h`${card('Import BIND — podgląd diffu', h`
        ${alert('Nic nie zapisano. Sprawdź diff i zatwierdź import.', 'info')}
        ${kvList([['Dodane', String(result.diff.counts.added)], ['Usunięte', String(result.diff.counts.removed)], ['Zmienione', String(result.diff.counts.changed)]])}
        <div class="grid grid-2 u-s27">
          <div><h3 class="form-section">Dodane</h3>${result.diff.added.length ? h`<ul class="doc-list">${result.diff.added.map((r) => h`<li><strong>+ ${r.type} ${r.name}</strong> → <code>${r.value}</code></li>`)}</ul>` : '<p class="small muted">Brak.</p>'}</div>
          <div><h3 class="form-section">Usunięte</h3>${result.diff.removed.length ? h`<ul class="doc-list">${result.diff.removed.map((r) => h`<li><strong>− ${r.type} ${r.name}</strong> → <code>${r.value}</code></li>`)}</ul>` : '<p class="small muted">Brak.</p>'}</div>
        </div>
        <form method="post" action="/user/dns/import" class="oa-form u-s27"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <input type="hidden" name="domain" value="${d.name}"><input type="hidden" name="dry_run" value="0">
          <div class="field field-full"><label class="field-label" for="dns-import-confirm">Strefa BIND do importu</label><textarea id="dns-import-confirm" name="text" rows="8">${text}</textarea></div>
          <div class="form-actions"><button class="btn btn-primary" type="submit">Zatwierdź import</button><a class="btn btn-ghost" href="/user/dns?domain=${encodeURIComponent(d.name)}">Anuluj</a></div>
        </form>`, { sub: `${d.name} · strefa jest walidowana przed zapisem` })}`;
      return page(ctx, { title: 'Import BIND', subtitle: d.name, body, wide: true });
    }
    return ctx.redirect(`/user/dns?domain=${encodeURIComponent(d.name)}&flash=${encodeURIComponent(`Zaimportowano strefę: +${result.diff.counts.added} / −${result.diff.counts.removed} / ~${result.diff.counts.changed}`)}`);
  });

  router.get('/user/dns/export', (ctx) => {
    const d = domainFor(ctx.user, ctx.query.domain);
    if (!d) return ctx.redirect('/user/dns?flash=Domain%20not%20found&type=error');
    const exported = exportBind(d.name);
    if (!exported.ok) return ctx.redirect(`/user/dns?domain=${encodeURIComponent(d.name)}&flash=${encodeURIComponent(exported.error)}&type=error`);
    ctx.res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    ctx.res.setHeader('Content-Disposition', `attachment; filename="${d.name}.zone"`);
    ctx.res.end(exported.text);
  });

  router.post('/user/dns/rebuild', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/dns?flash=Domain%20not%20found&type=error');
    const result = rebuildZone(d.name);
    return ctx.redirect('/user/dns?domain=' + encodeURIComponent(d.name) + '&flash=' + encodeURIComponent(result.ok ? 'Zone rebuilt and validated' : `Zone rebuilt with warnings: ${result.check.output}`) + (result.ok ? '' : '&type=error'));
  });

  /* ------------------------------------------------------------- redirects */
  router.post('/user/redirects/create', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/redirects?flash=Domain%20not%20found&type=error');
    const to = String(ctx.body.to_url || '').trim();
    if (!/^https?:\/\//i.test(to)) return ctx.redirect('/user/redirects?flash=Target%20must%20start%20with%20http(s)://&type=error');
    run('INSERT INTO redirects(domain_id, username, from_path, to_url, type, created_at) VALUES(?,?,?,?,?,?)',
      d.id, ctx.user.username, String(ctx.body.from_path || '/').trim(), to, String(ctx.body.type || '301'), nowIso());
    return ctx.redirect('/user/redirects?flash=Redirect%20created');
  });

  router.post('/user/redirects/:id/update', (ctx) => {
    const r = get('SELECT * FROM redirects WHERE id = ? AND username = ?', Number(ctx.params.id), ctx.user.username);
    if (!r) return ctx.redirect('/user/redirects?flash=Not%20found&type=error');
    const to = String(ctx.body.to_url || '').trim();
    if (!/^https?:\/\//i.test(to)) return ctx.redirect('/user/redirects?flash=Target%20must%20start%20with%20http(s)://&type=error');
    run('UPDATE redirects SET from_path=?, to_url=?, type=? WHERE id=?', String(ctx.body.from_path || '/'), to, String(ctx.body.type || '301'), r.id);
    audit(ctx.user.username, ctx.user.level, 'redirect.update', `${r.domain_id}:${to}`, ctx.ip);
    return ctx.redirect('/user/redirects?flash=Redirect%20updated');
  });

  router.post('/user/redirects/:id/delete', (ctx) => {
    const r = get('SELECT * FROM redirects WHERE id = ?', Number(ctx.params.id));
    if (r && r.username === ctx.user.username) run('DELETE FROM redirects WHERE id = ?', r.id);
    return ctx.redirect('/user/redirects?flash=Redirect%20deleted');
  });

  /* ---------------------------------------------------------------- pointers */
  router.post('/user/pointers/create', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/pointers?flash=Domain%20not%20found&type=error');
    const alias = String(ctx.body.alias || '').trim().toLowerCase();
    if (!isDomain(alias)) return ctx.redirect('/user/pointers?flash=Invalid%20pointer%20domain&type=error');
    if (get('SELECT id FROM domains WHERE name = ?', alias)) return ctx.redirect('/user/pointers?flash=That%20domain%20already%20exists&type=error');
    run('INSERT INTO dns_records(domain_id, name, type, value, ttl) VALUES(?,?,?,?,?)', d.id, `pointer-${alias}`, 'POINTER', alias, 3600);
    audit(ctx.user.username, ctx.user.level, 'pointer.create', alias, ctx.ip);
    return ctx.redirect('/user/pointers?flash=' + encodeURIComponent(`Pointer ${alias} → ${d.name} created`));
  });

  router.post('/user/pointers/:id/update', (ctx) => {
    const p = get("SELECT * FROM dns_records WHERE id = ? AND type = 'POINTER'", Number(ctx.params.id));
    const d = p ? domainFor(ctx.user, p.domain_id) : null;
    if (!d) return ctx.redirect('/user/pointers?flash=Not%20found&type=error');
    const alias = String(ctx.body.alias || '').trim().toLowerCase();
    if (!isDomain(alias) || get('SELECT id FROM domains WHERE name = ?', alias)) return ctx.redirect('/user/pointers?flash=Invalid%20or%20existing%20domain&type=error');
    run('UPDATE dns_records SET name=?, value=? WHERE id=?', `pointer-${alias}`, alias, p.id);
    rebuildZone(d.name); apply({ dns: true });
    audit(ctx.user.username, ctx.user.level, 'pointer.update', alias, ctx.ip);
    return ctx.redirect('/user/pointers?flash=Pointer%20updated');
  });

  router.post('/user/pointers/:id/delete', (ctx) => {
    run("DELETE FROM dns_records WHERE id = ? AND type = 'POINTER'", Number(ctx.params.id));
    return ctx.redirect('/user/pointers?flash=Pointer%20removed');
  });
}

export function register(router) {
  router.get('/user/domains', (ctx) => userDomains(ctx));
  router.get('/user/domains/create', (ctx) => domainCreatePage(ctx));

  router.get('/user/subdomains', (ctx) => {
    const domains = visibleDomains(ctx.user);
    const selected = ctx.query.domain || domains[0]?.name;
    const d = domains.find((x) => x.name === selected) || domains[0];
    const rows = d ? all('SELECT * FROM subdomains WHERE domain_id = ? ORDER BY name', d.id) : [];
    const editing = ctx.query.edit ? rows.find((r) => String(r.id) === String(ctx.query.edit)) : null;
    const body = h`
      ${domains.length ? domainSelect(domains, d?.name, { action: '/user/subdomains' }) : alert('Add a domain before creating subdomains.', 'warn')}
      ${listCard({
        title: 'Subdomains', sub: d ? `For ${d.name}` : '',
        columns: [
          { label: 'Subdomain', render: (r) => h`<span class="cell-strong">${r.name}.${d?.name}</span><span class="cell-sub">${r.docroot}</span>` },
          { label: 'PHP', render: (r) => r.php_version || d?.php_version },
          { label: 'Created', render: (r) => formatDate(r.created_at) },
        ],
        rows,
        empty: 'No subdomains for this domain yet.',
        actions: [
          { label: 'Edytuj', href: (r) => `/user/subdomains?domain=${encodeURIComponent(d?.name || '')}&edit=${r.id}`, icon: 'edit' },
          { label: 'Files', href: (r) => `/user/files?path=${encodeURIComponent(r.docroot || '/')}`, icon: 'folder' },
          { label: 'Delete', form: (r) => `/user/subdomains/${r.id}/delete`, confirm: 'Usunąć tę subdomenę?', icon: 'trash', danger: true },
        ],
        footer: d ? h`<form method="post" action="/user/subdomains/create" class="inline-form">
          <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="domain" value="${d.name}">
          <input class="u-s44" type="text" name="name" placeholder="blog" required>
          <button class="btn btn-primary btn-sm" type="submit">${icon('plus', { size: 14 })} Add subdomain</button>
        </form>` : '',
      })}
      ${editing ? card(`Edytuj subdomenę · ${editing.name}.${d?.name}`, h`<form method="post" action="/user/subdomains/${editing.id}/update" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Subdomena</label><input value="${editing.name}.${d?.name}" disabled></div>
          <div class="field"><label class="field-label">PHP</label><select name="php_version">${phpOptions().map((v) => h`<option ${v === (editing.php_version || d?.php_version) ? 'selected' : ''}>${v}</option>`)}</select></div>
          <div class="field field-full"><label class="field-label">Document root</label><input name="docroot" value="${editing.docroot || ''}"></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Zapisz</button><a class="btn btn-ghost" href="/user/subdomains?domain=${encodeURIComponent(d?.name || '')}">Anuluj</a></div>
      </form>`) : ''}`;
    return page(ctx, { title: 'Subdomains', subtitle: 'Create and manage subdomains on your domains', body });
  });

  router.get('/user/dns', (ctx) => {
    const domains = visibleDomains(ctx.user);
    const selected = ctx.query.domain || domains[0]?.name;
    const d = domains.find((x) => x.name === selected) || domains[0];
    const owner = d ? get('SELECT * FROM users WHERE id = ?', d.user_id) : null;
    const expert = ctx.query.expert === '1'
      || (ctx.query.expert === undefined && setting(`dns_expert:${ctx.user.username}`, '0') === '1');
    const info = d ? publicZoneInfo(d.name, { expert }) : null;
    const records = info?.records || [];
    const editing = ctx.query.edit ? records.find((r) => String(r.id) === String(ctx.query.edit)) : null;
    const templateRows = dnsTemplates();
    const selectedTemplate = String(ctx.query.template || '');
    const preview = d && selectedTemplate && ctx.query.preview === '1'
      ? previewZoneChange(d.name, { templateId: selectedTemplate, packageName: owner?.package || '', reseller: owner?.owner || '' })
      : null;
    const snapshot = d ? lastZoneSnapshot(d.name) : null;
    const body = h`
      ${!domains.length ? alert('Add a domain first to manage its DNS zone.', 'warn') : ''}
      ${d ? domainSelect(domains, d.name, { action: '/user/dns' }) : ''}
      ${d ? h`
        <div class="row u-s56">
          <form method="post" action="/user/dns/expert"><input type="hidden" name="_csrf" value="${ctx.csrf}">
            <input type="hidden" name="enabled" value="${expert ? '0' : '1'}">
            <button class="btn btn-ghost btn-sm" type="submit">${expert ? 'Wyłącz tryb ekspercki' : 'Tryb ekspercki'}</button></form>
        </div>` : ''}
      ${d ? card(`DNS zone · ${d.name}`, h`
        ${alert(info?.checked ? 'Strefa jest zwalidowana.' : 'Strefa nie została jeszcze zwalidowana.', info?.checked ? 'ok' : 'warn')}
        ${expert && info?.file ? alert(h`Ścieżka pliku strefy (tylko tryb ekspercki): <code>${info.file}</code>`, 'info') : '<p class="small muted">Ścieżki plików strefy są ukryte. Włącz tryb ekspercki, jeśli potrzebujesz jej do diagnostyki.</p>'}
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>Name</th><th>Type</th><th>Value</th><th>Priority</th><th>TTL</th><th class="col-actions">Actions</th></tr></thead>
          <tbody>${records.map((r) => h`<tr>
            <td class="cell-mono">${r.name}</td>
            <td>${badge(r.type, 'brand')}</td>
            <td class="cell-mono truncate u-s57">${r.value}</td>
            <td>${r.priority ?? '—'}</td>
            <td>${r.ttl}</td>
            <td class="col-actions"><div class="row-actions">
              <a class="icon-btn" href="/user/dns?domain=${encodeURIComponent(d.name)}&edit=${r.id}" title="Edit">${icon('edit', { size: 16 })}</a>
              <form method="post" action="/user/dns/${r.id}/delete" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
                <button class="icon-btn danger" type="submit" title="Delete" data-confirm="Usunąć ten rekord DNS?">${icon('trash', { size: 16 })}</button></form>
            </div></td>
          </tr>`)}
          </tbody>
        </table></div>`, { padded: false, actions: [h`<form method="post" action="/user/dns/rebuild" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="domain" value="${d.name}"><button class="btn btn-secondary btn-sm" type="submit">Rebuild zone</button></form>`] }) : ''}

      ${d ? card('Szablon DNS i podgląd diffu', h`
        <form method="get" action="/user/dns" class="row u-s58">
          <input type="hidden" name="domain" value="${d.name}">
          <input type="hidden" name="preview" value="1">
          <div class="field"><label class="field-label" for="dns-template-select">Szablon</label>
            <select id="dns-template-select" name="template"><option value="">Automatyczny (pakiet/reseller/domyślny)</option>
              ${templateRows.map((template) => h`<option value="${template.id}" ${selectedTemplate === String(template.id) ? 'selected' : ''}>${template.name}</option>`)}
            </select></div>
          <button class="btn btn-secondary" type="submit">Pokaż diff strefy</button>
        </form>
        ${preview ? h`
          ${!preview.ok ? alert(h`<ul class="doc-list">${(preview.errors || []).map((error) => h`<li>${error.message}</li>`)}</ul>`, 'danger', { title: 'Szablon odrzucony przez walidację' }) : ''}
          ${preview.ok ? h`
            ${kvList([
              ['Dodane', String(preview.diff.counts.added)],
              ['Usunięte', String(preview.diff.counts.removed)],
              ['Zmienione', String(preview.diff.counts.changed)],
              ['Bez zmian', String(preview.diff.counts.unchanged)],
              ['Źródło', preview.template ? `szablon ${preview.template.name}` : (preview.source === 'builtin' ? 'wbudowane rekordy automatyczne' : preview.source)],
            ])}
            <div class="grid grid-2 u-s27">
              <div><h3 class="form-section">Dodane / zmienione</h3>
                ${(preview.diff.added.length || preview.diff.changed.length) ? h`<ul class="doc-list">${preview.diff.added.map((r) => h`<li><strong>+ ${r.type} ${r.name}</strong> → <code>${r.value}</code></li>`)}${preview.diff.changed.map((entry) => h`<li><strong>~ ${entry.after.type} ${entry.after.name}</strong> <code>${entry.before.value}</code> → <code>${entry.after.value}</code></li>`)}</ul>` : '<p class="small muted">Brak nowych rekordów.</p>'}
              </div>
              <div><h3 class="form-section">Usunięte</h3>
                ${preview.diff.removed.length ? h`<ul class="doc-list">${preview.diff.removed.map((r) => h`<li><strong>− ${r.type} ${r.name}</strong> → <code>${r.value}</code></li>`)}</ul>` : '<p class="small muted">Brak usuwanych rekordów.</p>'}
              </div>
            </div>
            <form method="post" action="/user/dns/template/apply" class="oa-form u-s27">
              <input type="hidden" name="_csrf" value="${ctx.csrf}">
              <input type="hidden" name="domain" value="${d.name}">
              <input type="hidden" name="template" value="${selectedTemplate}">
              <div class="form-grid">
                <div class="field"><label class="field-label" for="dns-bind-scope">Zapisz wybór jako domyślny</label>
                  <select id="dns-bind-scope" name="bind_scope"><option value="">Tylko ta operacja</option><option value="domain">Dla tej domeny</option>
                    ${owner ? h`<option value="package">Dla pakietu ${owner.package || 'default'}</option>` : ''}
                    ${owner?.owner ? h`<option value="reseller">Dla resellera ${owner.owner}</option>` : ''}
                  </select></div>
              </div>
              <p class="small muted">Zastosowanie tworzy punkt przywracania; rollback przywróci poprzednie rekordy strefy.</p>
              <div class="form-actions"><button class="btn btn-primary" type="submit">Zastosuj szablon</button></div>
            </form>` : ''}
          ${snapshot ? h`<form class="u-s55" method="post" action="/user/dns/rollback"><input type="hidden" name="_csrf" value="${ctx.csrf}">
            <input type="hidden" name="domain" value="${d.name}"><input type="hidden" name="snapshot" value="${snapshot.id}">
            <button class="btn btn-ghost btn-sm" type="submit">Cofnij ostatnią zmianę strefy (${snapshot.count} rekordów)</button></form>` : ''}
        ` : '<p class="small muted">Wybierz szablon i pokaż diff przed zapisem — walidacja składni i konfliktów odbywa się przed mutacją.</p>'}`) : ''}

      ${d ? card('Import / eksport BIND', h`
        <div class="row u-s59">
          <a class="btn btn-secondary btn-sm" href="/user/dns/export?domain=${encodeURIComponent(d.name)}">Eksportuj strefę BIND</a>
          <span class="small muted">Eksport obejmuje tylko tę domenę (scope).</span>
        </div>
        <form method="post" action="/user/dns/import" class="oa-form u-s27">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <input type="hidden" name="domain" value="${d.name}">
          <div class="field field-full"><label class="field-label" for="dns-import-text">Import BIND (SOA/NS pomijane, walidacja przed zapisem)</label>
            <textarea id="dns-import-text" name="text" rows="7" placeholder="@ 3600 IN A 192.0.2.10&#10;www 3600 IN CNAME @"></textarea></div>
          <label class="check-field"><input type="checkbox" name="dry_run" value="1" checked> <span>Najpierw pokaż diff (dry-run)</span></label>
          <div class="form-actions"><button class="btn btn-secondary" type="submit">Importuj</button></div>
        </form>`) : ''}

      ${d && editing ? card(`Edit record · ${editing.type} ${editing.name}`, h`<form method="post" action="/user/dns/${editing.id}/update" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label" for="dns-edit-name">Name</label><input id="dns-edit-name" name="name" value="${editing.name}" required></div>
          <div class="field"><label class="field-label" for="dns-edit-type">Type</label><select id="dns-edit-type" name="type">
            ${['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'].map((t) => h`<option ${t === editing.type ? 'selected' : ''}>${t}</option>`)}
          </select></div>
          <div class="field field-full"><label class="field-label" for="dns-edit-value">Value</label><input id="dns-edit-value" name="value" value="${editing.value}" required></div>
          <div class="field"><label class="field-label" for="dns-edit-priority">Priority</label><input id="dns-edit-priority" name="priority" type="number" value="${editing.priority ?? ''}"></div>
          <div class="field"><label class="field-label" for="dns-edit-ttl">TTL</label><input id="dns-edit-ttl" name="ttl" type="number" value="${editing.ttl}"></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save record</button><a class="btn btn-ghost" href="/user/dns?domain=${encodeURIComponent(d.name)}">Cancel</a></div>
      </form>`) : ''}
      ${d ? card('Add DNS record', h`<form method="post" action="/user/dns/add" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="domain" value="${d.name}">
        <div class="form-grid">
          <div class="field"><label class="field-label" for="dns-add-name">Name</label><input id="dns-add-name" name="name" value="@" placeholder="@ or www"></div>
          <div class="field"><label class="field-label" for="dns-add-type">Type</label><select id="dns-add-type" name="type">
            ${['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'].map((t) => h`<option>${t}</option>`)}
          </select></div>
          <div class="field field-full"><label class="field-label" for="dns-add-value">Value</label><input id="dns-add-value" name="value" placeholder="192.0.2.1 or target.example.com." required></div>
          <div class="field"><label class="field-label" for="dns-add-priority">Priority (MX/SRV)</label><input id="dns-add-priority" name="priority" type="number" min="0" max="65535"></div>
          <div class="field"><label class="field-label" for="dns-add-ttl">TTL</label><input id="dns-add-ttl" name="ttl" type="number" value="3600" min="60"></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('plus', { size: 16 })} Add record</button></div>
      </form>`) : ''}`;
    return page(ctx, { title: 'DNS Management', subtitle: d ? `Zone for ${d.name}` : 'Manage DNS records', body, wide: true });
  });

  router.get('/user/pointers', (ctx) => {
    const domains = visibleDomains(ctx.user);
    const pointers = all(`SELECT r.*, d.name domain FROM dns_records r JOIN domains d ON d.id = r.domain_id
                          WHERE r.type = 'POINTER' AND d.user_id = ? ORDER BY r.value`, ctx.user.id);
    const editing = ctx.query.edit ? pointers.find((r) => String(r.id) === String(ctx.query.edit)) : null;
    const body = h`
      ${alert('A domain pointer makes an additional domain serve the same content as an existing domain. Add the pointer, then create an A record for it in its own DNS zone.', 'info')}
      ${listCard({
        title: 'Domain pointers', sub: `${pointers.length} pointer(s)`,
        columns: [
          { label: 'Pointer domain', render: (r) => h`<span class="cell-strong">${r.value}</span>` },
          { label: 'Points to', render: (r) => r.domain },
          { label: 'Created', render: (r) => formatDate(r.created_at) },
        ],
        rows: pointers,
        empty: 'No domain pointers yet.',
        actions: [
          { label: 'Edytuj', href: (r) => `/user/pointers?edit=${r.id}`, icon: 'edit' },
          { label: 'Remove', form: (r) => `/user/pointers/${r.id}/delete`, confirm: 'Remove this pointer?', icon: 'trash', danger: true },
        ],
        footer: h`<form method="post" action="/user/pointers/create" class="inline-form u-s60">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <select class="u-s61" name="domain">${domains.map((d) => h`<option value="${d.name}">${d.name}</option>`)}</select>
          <input class="u-s62" type="text" name="alias" placeholder="alias-domain.com">
          <button class="btn btn-primary btn-sm" type="submit">${icon('plus', { size: 14 })} Add pointer</button>
        </form>`,
      })}
      ${editing ? card(`Edytuj pointer · ${editing.value}`, h`<form method="post" action="/user/pointers/${editing.id}/update" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid"><div class="field field-full"><label class="field-label">Nowa domena wskaźnika</label><input name="alias" value="${editing.value}" required></div></div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Zapisz</button><a class="btn btn-ghost" href="/user/pointers">Anuluj</a></div>
      </form>`) : ''}`;
    return page(ctx, { title: 'Domain Pointers', subtitle: 'Alias extra domains to content you already host', body });
  });

  router.get('/user/redirects', (ctx) => {
    const rows = all('SELECT r.*, d.name domain FROM redirects r JOIN domains d ON d.id = r.domain_id WHERE r.username = ? ORDER BY r.created_at DESC', ctx.user.username);
    const editing = ctx.query.edit ? rows.find((r) => String(r.id) === String(ctx.query.edit)) : null;
    const domains = visibleDomains(ctx.user);
    const body = h`
      ${listCard({
        title: 'Site redirects', sub: 'HTTP redirects mapped to your domains',
        columns: [
          { label: 'From', render: (r) => h`<span class="cell-mono">${r.domain}${r.from_path}</span>` },
          { label: 'To', render: (r) => h`<span class="cell-mono">${r.to_url}</span>` },
          { label: 'Type', render: (r) => badge(r.type, 'brand') },
          { label: 'Created', render: (r) => formatDate(r.created_at) },
        ],
        rows,
        empty: 'No redirects configured.',
        actions: [
          { label: 'Edytuj', href: (r) => `/user/redirects?edit=${r.id}`, icon: 'edit' },
          { label: 'Delete', form: (r) => `/user/redirects/${r.id}/delete`, confirm: 'Usunąć przekierowanie?', icon: 'trash', danger: true },
        ],
        footer: h`<form class="u-s60" method="post" action="/user/redirects/create">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <select class="u-s40" name="domain">${domains.map((d) => h`<option value="${d.name}">${d.name}</option>`)}</select>
          <input class="u-s63" name="from_path" placeholder="/old-page">
          <input class="u-s64" name="to_url" placeholder="https://example.com/new-page">
          <select class="u-s65" name="type"><option>301</option><option>302</option></select>
          <button class="btn btn-primary btn-sm" type="submit">${icon('plus', { size: 14 })} Add redirect</button>
        </form>`,
      })}
      ${editing ? card(`Edytuj przekierowanie · ${editing.domain}${editing.from_path}`, h`<form method="post" action="/user/redirects/${editing.id}/update" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Od</label><input name="from_path" value="${editing.from_path}" required></div>
          <div class="field"><label class="field-label">Do URL</label><input name="to_url" value="${editing.to_url}" required></div>
          <div class="field"><label class="field-label">Typ</label><select name="type">${['301','302'].map((x) => h`<option ${x === editing.type ? 'selected' : ''}>${x}</option>`)}</select></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Zapisz</button><a class="btn btn-ghost" href="/user/redirects">Anuluj</a></div>
      </form>`) : ''}`;
    return page(ctx, { title: 'Site Redirects', subtitle: 'Redirect requests to another URL', body });
  });

  // Register POST handlers from the shared module.
  registerDomainsPost(router);
  void e; void tabs; void toolbar; void pageHead; void statusBadge; void form; void table;
}
