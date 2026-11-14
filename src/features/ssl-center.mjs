// Administrator AutoSSL and service certificate management.
import { all } from '../db.mjs';
import { html as h, formatDate } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, tabs, form, field, kvList } from '../ui/components.mjs';
import {
  autoSslStatus, setSslKeyType, issueCertificate, renewExpiring, installServiceCert, logs,
  preflightAcme, acmeQueue, acmeSummary, processAcmeQueue, retryAcme, cancelAcme, renewalSchedule,
} from '../autossl.mjs';

const A = '/admin/ssl-center';

function domainLink(domain) {
  return `/admin/ssl?domain=${encodeURIComponent(domain)}`;
}

function statusBadge(status) {
  const tone = status === 'issued' ? 'ok' : status === 'failed' ? 'danger' : status === 'cancelled' ? 'muted' : 'warn';
  return badge(String(status || '—'), tone);
}

function queueTable(entries, csrf = '') {
  return table({
    columns: [
      { label: 'Domena', render: (row) => h`<a class="cell-strong" href="${domainLink(row.domain)}">${row.domain}</a><span class="cell-sub">${row.mode} / ${row.challenge}</span>` },
      { label: 'Status', render: (row) => statusBadge(row.status) },
      { label: 'Próby', render: (row) => `${row.attempts || 0}/${row.maxAttempts || 0}` },
      { label: 'Następna próba', render: (row) => row.nextAttemptAt ? formatDate(row.nextAttemptAt, { time: true }) : '—' },
      { label: 'Ostatni błąd', render: (row) => h`<span class="small muted">${row.lastError || '—'}</span>` },
      { label: 'Fallback', render: (row) => row.fallback === 'selfsigned' ? badge('self-signed', 'warn') : '—' },
      {
        label: 'Akcje', align: 'right', render: (row) => h`<div class="row-actions">
          ${row.status !== 'issued' ? h`<form method="post" action="${A}/queue/retry" class="inline"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="id" value="${row.id}"><button class="icon-btn" type="submit" title="Ponów teraz">↻</button></form>` : ''}
          ${['queued', 'waiting_dns', 'retrying'].includes(row.status) ? h`<form method="post" action="${A}/queue/cancel" class="inline"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="id" value="${row.id}"><button class="icon-btn danger" type="submit" title="Anuluj">×</button></form>` : ''}
        </div>`,
      },
    ],
    rows: entries,
    empty: 'Kolejka ACME jest pusta.',
  });
}

export function register(router) {
  router.get(A, (ctx) => {
    const tab = ['overview', 'queue', 'schedule', 'logs', 'service'].includes(String(ctx.query.tab)) ? String(ctx.query.tab) : 'overview';
    const st = autoSslStatus();
    const domainFilter = String(ctx.query.domain || '');
    const domains = all('SELECT name FROM domains ORDER BY name');
    const filt = (rows) => (domainFilter ? rows.filter((row) => row.domain === domainFilter) : rows);
    const queue = acmeQueue({ domain: domainFilter, limit: 100 });
    const schedule = filt(renewalSchedule());
    const certs = filt(st.certs);
    const summary = acmeSummary();
    const body = h`
      ${tabs([
        { key: 'overview', label: 'Certyfikaty', count: certs.length },
        { key: 'queue', label: 'Kolejka ACME', count: summary.active },
        { key: 'schedule', label: 'Harmonogram', count: schedule.filter((row) => row.due).length },
        { key: 'logs', label: 'Logi', count: st.logs.length },
        { key: 'service', label: 'Certyfikat usług' },
      ], tab, { base: A })}
      <div class="toolbar"><form method="get" action="${A}" class="row">
        <input type="hidden" name="tab" value="${tab}">
        <label class="field-label" for="sslDomain" style="margin:0">Domena</label>
        <select id="sslDomain" name="domain" data-domain-select style="width:280px">
          <option value="">Wszystkie domeny</option>
          ${domains.map((d) => h`<option value="${d.name}" ${domainFilter === d.name ? 'selected' : ''}>${d.name}</option>`)}
        </select>
        <noscript><button class="btn btn-secondary btn-sm">Filtruj</button></noscript>
      </form></div>
      ${tab === 'overview' ? h`
        ${card('AutoSSL', h`${kvList([
          ['Certbot', st.certbot || 'brak — używany self-signed'],
          ['Wygasające <30 dni', String(st.expiring.length)],
          ['Typ klucza', st.keyType],
          ['Kolejka ACME', `${summary.active} aktywnych / ${summary.waiting} czeka / ${summary.failed} nieudanych`],
          ['Alerty po wyczerpaniu prób', String(summary.alerts)],
        ])}
          <form method="post" action="${A}/keytype" class="row mt-18"><input type="hidden" name="_csrf" value="${ctx.csrf}">
            <label class="field-label" for="ssl-key-type" style="margin:0">Typ klucza</label>
            <select id="ssl-key-type" name="type">${['rsa2048', 'rsa4096', 'ecdsa-p256'].map((t) => h`<option ${t === st.keyType ? 'selected' : ''}>${t}</option>`)}</select>
            <button class="btn btn-secondary" type="submit">Zmień typ klucza</button></form>
          <form method="post" action="${A}/renew" class="mt-12"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-secondary" type="submit">Odnów wygasające</button></form>`)}
        ${card('Wystaw certyfikat', form([
          field({ name: 'domain', label: 'Domena', type: 'select', options: domains.map((d) => d.name) }),
          field({ name: 'email', label: 'E-mail ACME (opcjonalnie)' }),
        ], { action: `${A}/issue`, csrf: ctx.csrf, submit: 'Wystaw' }))}
        ${card('Preflight ACME (DNS/HTTP)', h`<p class="small muted">Sprawdza rekord A/AAAA, port 80, document root i certbot. Nic nie zapisuje.</p>
          ${form([
            field({ name: 'domain', label: 'Domena', type: 'select', options: domains.map((d) => d.name) }),
            field({ name: 'challenge', label: 'Wyzwanie', type: 'select', options: ['http-01', 'dns-01'] }),
          ], { action: `${A}/preflight`, csrf: ctx.csrf, submit: 'Uruchom preflight' })}`)}
        ${card('Aktywne certyfikaty', table({
          columns: [
            { label: 'Domena', render: (r) => h`<a class="cell-strong" href="${domainLink(r.domain)}">${r.domain}</a>` },
            { label: 'Typ', key: 'type' }, { label: 'Klucz', key: 'key_type' },
            { label: 'Wygasa', render: (r) => r.expires_at ? formatDate(r.expires_at, { time: true }) : '—' },
            { label: 'Status', render: (r) => new Date(r.expires_at).getTime() - Date.now() < 30 * 864e5 ? badge('wygasa', 'warn') : badge('OK', 'ok') },
          ],
          rows: certs,
          empty: 'Brak certyfikatów.',
        }), { padded: false })}
        ${alert('Bez publicznego DNS i portu 80 certbot nie wystawi Let’s Encrypt; panel użyje self-signed i pokaże to w logu oraz w kolejce ACME.', 'info')}
      ` : ''}
      ${tab === 'queue' ? h`
        ${card('Kolejka ACME', h`
          ${alert('Zadanie jest ponawiane z wykładniczym backoffem. Alert pojawia się dopiero po wyczerpaniu prób; fallback self-signed jest jawny.', 'info')}
          <form method="post" action="${A}/queue/process" class="row"><input type="hidden" name="_csrf" value="${ctx.csrf}">
            <button class="btn btn-secondary" type="submit">Przetwórz zaległe zadania</button>
            <span class="small muted">Uruchamia preflight DNS/HTTP i wystawianie dla zadań, których termin nadszedł.</span>
          </form>
        `)}
        ${card('Zadania', queueTable(queue, ctx.csrf), { padded: false })}
      ` : ''}
      ${tab === 'schedule' ? h`
        ${card('Harmonogram odnowień', table({
          columns: [
            { label: 'Domena', render: (r) => h`<a class="cell-strong" href="${domainLink(r.domain)}">${r.domain}</a>` },
            { label: 'Typ', key: 'type' },
            { label: 'Wygasa', render: (r) => r.expiresAt ? formatDate(r.expiresAt, { time: true }) : '—' },
            { label: 'Dni do wygaśnięcia', render: (r) => r.daysLeft ?? '—' },
            { label: 'Zaplanowane odnowienie', render: (r) => r.renewAt ? formatDate(r.renewAt, { time: true }) : '—' },
            { label: 'Stan', render: (r) => r.expired ? badge('wygasły', 'danger') : r.due ? badge('do odnowienia', 'warn') : badge('OK', 'ok') },
            { label: 'Auto-renew', render: (r) => r.autoRenew ? badge('włączone', 'ok') : badge('wyłączone', 'muted') },
          ],
          rows: schedule,
          empty: 'Brak certyfikatów w harmonogramie.',
        }), { padded: false })}
        ${alert('Harmonogram jest realizowany przez trwały scheduler; nieudane odnowienia trafiają do kolejki ACME z backoffem.', 'info')}
      ` : ''}
      ${tab === 'logs' ? h`${card('Logi AutoSSL', table({
        columns: [{ label: 'Czas', render: (r) => formatDate(r.created_at, { time: true }) }, { label: 'Domena', render: (r) => h`<a href="${domainLink(r.domain)}">${r.domain}</a>` }, { label: 'Akcja', key: 'action' }, { label: 'Status', render: (r) => badge(r.status, r.status === 'ok' ? 'ok' : 'danger') }, { label: 'Szczegóły', render: (r) => h`<span class="small muted">${r.detail || '—'}</span>` }],
        rows: logs(200), empty: 'Brak logów.',
      }), { padded: false })}` : ''}
      ${tab === 'service' ? h`
        ${card('Certyfikat dla Exim/Dovecot', form([
          field({ name: 'domain', label: 'Domena certyfikatu', type: 'select', options: st.certs.map((c) => c.domain) }),
        ], { action: `${A}/service`, csrf: ctx.csrf, submit: 'Zainstaluj dla usług' }))}
        ${alert('Zapisuje certyfikat w /etc/openadmin/service-tls, tworzy drop-in Exima/Dovecota, waliduje i przeładowuje usługi. Wymaga roota na Linuxie.', 'warn')}
      ` : ''}`;
    return page(ctx, { title: 'AutoSSL Center', subtitle: 'Certyfikaty, kolejka ACME, odnowienia i TLS usług', body, wide: true });
  });

  router.post(`${A}/keytype`, (ctx) => {
    const r = setSslKeyType(ctx.body.type, ctx.user.username);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(r.ok ? 'Typ klucza zapisany' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/issue`, (ctx) => {
    const r = issueCertificate(ctx.body.domain, { email: ctx.body.email, actor: ctx.user.username });
    return ctx.redirect(`${A}?flash=${encodeURIComponent(r.ok ? 'Certyfikat wystawiony' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/renew`, async (ctx) => {
    const out = await renewExpiring(ctx.user.username);
    return ctx.redirect(`${A}?tab=queue&flash=${encodeURIComponent(out.length ? `Odnowienia: ${out.filter((x) => x.ok).length}/${out.length} gotowych, ${out.filter((x) => x.pending).length} oczekuje` : 'Brak certyfikatów do odnowienia')}`);
  });
  router.post(`${A}/service`, (ctx) => {
    const r = installServiceCert(ctx.body.domain, ctx.user.username);
    return ctx.redirect(`${A}?tab=service&flash=${encodeURIComponent(r.ok ? 'Certyfikat usług zainstalowany' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/preflight`, async (ctx) => {
    const domain = String(ctx.body.domain || '');
    const result = await preflightAcme(domain, { challenge: ctx.body.challenge === 'dns-01' ? 'dns-01' : 'http-01', mode: 'letsencrypt' });
    const body = h`${card(`Preflight ACME · ${domain}`, h`
      ${alert(result.ok ? 'Wszystkie warunki są spełnione.' : 'ACME nie jest jeszcze gotowe — sprawdź warunki poniżej.', result.ok ? 'ok' : 'warn')}
      ${kvList([
        ['Rekomendacja', result.recommended],
        ['Retry po DNS/HTTP', result.retryable ? 'tak' : 'nie'],
        ['Certbot', result.certbot || 'brak'],
        ['Fallback', result.fallback ? `${result.fallback.mode}: ${result.fallback.detail}` : 'brak'],
      ])}
      <ul class="doc-list">${result.checks.map((check) => h`<li data-preflight-key="${check.key}">
        <div class="spread"><strong>${check.label}</strong>${check.ok ? badge(check.skipped ? 'pominięte' : 'OK', check.skipped ? 'muted' : 'ok') : badge(check.retryable ? 'retry' : 'błąd', check.retryable ? 'warn' : 'danger')}</div>
        <div class="small muted">${check.detail}</div>
      </li>`)}</ul>
      <a class="btn btn-primary" href="${A}?domain=${encodeURIComponent(domain)}">Wróć do AutoSSL</a>`)}`;
    return page(ctx, { title: 'Preflight ACME', subtitle: domain, body, wide: true });
  });
  router.post(`${A}/queue/process`, async (ctx) => {
    const result = await processAcmeQueue({ limit: 10, actor: ctx.user.username });
    const parts = [
      `przetworzono ${result.processed.length}`,
      `wystawiono ${result.issued.length}`,
      `czeka ${result.waiting.length}`,
      `nieudane ${result.failed.length}`,
    ];
    return ctx.redirect(`${A}?tab=queue&flash=${encodeURIComponent(parts.join(' · '))}`);
  });
  router.post(`${A}/queue/retry`, (ctx) => {
    const result = retryAcme(ctx.body.id, ctx.user.username);
    return ctx.redirect(`${A}?tab=queue&flash=${encodeURIComponent(result.ok ? 'Zadanie ACME ponowione teraz' : result.error)}${result.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/queue/cancel`, (ctx) => {
    const result = cancelAcme(ctx.body.id, ctx.user.username);
    return ctx.redirect(`${A}?tab=queue&flash=${encodeURIComponent(result.ok ? 'Zadanie ACME anulowane' : result.error)}${result.ok ? '' : '&type=error'}`);
  });
}
