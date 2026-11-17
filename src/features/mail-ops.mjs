// Administrator Mail Operations Center.
import { all, get } from '../db.mjs';
import { html as h, formatDate, formatBytes } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, btn, badge, alert, emptyState, kvList, form, field, tabs, statCard } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import {
  mailOverview, queueList, queueAction, syncMailEvents, diagnose,
  listEvents, listFilters, addFilter, removeFilter, listRoutes, saveRoute,
  listRemoteSmtp, saveRemoteSmtp, testRemoteSmtp, activateRemoteSmtp,
  mailSettings, saveMailSettings, applyEximSettings, blacklist, addBlacklist,
  removeBlacklist, greylistingSupport, eximBin, applyRouting,
} from '../mailops.mjs';
import { listCountries, addCountry, removeCountry, geoipSupport } from '../countryfilter.mjs';

const A = '/admin/mail';

function tab(ctx) {
  const t = String(ctx.query.tab || 'overview');
  return ['overview', 'diagnose', 'queue', 'events', 'filters', 'routing', 'smtp', 'settings'].includes(t) ? t : 'overview';
}

export function register(router) {
  router.get(A, (ctx) => {
    const t = tab(ctx);
    const filterEditing = ctx.query.edit && t === 'filters' ? listFilters().find((f) => String(f.id) === String(ctx.query.edit)) : null;
    const smtpEditing = ctx.query.edit && t === 'smtp' ? listRemoteSmtp().find((s) => String(s.id) === String(ctx.query.edit)) : null;
    const ov = mailOverview();
    const cfg = mailSettings();
    const grey = greylistingSupport();
    const nav = tabs([
      { key: 'overview', label: 'Przegląd' },
      { key: 'diagnose', label: 'Diagnostyka' },
      { key: 'queue', label: 'Kolejka', count: ov.queue },
      { key: 'events', label: 'Dostarczenia' },
      { key: 'filters', label: 'Filtry', count: listFilters().length },
      { key: 'routing', label: 'Routing' },
      { key: 'smtp', label: 'Remote SMTP' },
      { key: 'settings', label: 'Ustawienia' },
    ], t, { base: A });
    let body = nav;

    if (t === 'overview') {
      body += h`
        ${!ov.exim ? alert('Exim nie jest wykryty — kolejka i raporty pokazują tylko wpisy panelu. Zainstaluj Exima, aby uzyskać pełną diagnozę.', 'warn') : ''}
        <div class="stat-grid">
          ${statCard({ label: 'W kolejce', value: String(ov.queue), sub: `${ov.deferred} deferred`, icon: 'mail', tone: ov.deferred ? 'warn' : 'ok', href: `${A}?tab=queue` })}
          ${statCard({ label: 'Dostarczone 24h', value: String(ov.delivered), sub: 'z logów Exima', icon: 'check', tone: 'ok', href: `${A}?tab=events` })}
          ${statCard({ label: 'Błędy 24h', value: String(ov.failed), sub: 'failed', icon: 'alert', tone: ov.failed ? 'danger' : 'ok', href: `${A}?tab=events&status=failed` })}
          ${statCard({ label: 'Zdarzenia 24h', value: String(ov.events), sub: 'odebrane/wysłane', icon: 'chart', href: `${A}?tab=events` })}
        </div>
        <div class="grid grid-2">
          ${card('Szybka diagnoza', h`<form method="post" action="${A}/diagnose" class="row"><input type="hidden" name="_csrf" value="${ctx.csrf}">
            <input name="address" placeholder="adres@domena.pl" required><button class="btn btn-primary" type="submit">Sprawdź adres</button></form>
            <p class="small muted mt-12">MX, SPF, DKIM, DMARC, skrzynka i porty 993/25/587.</p>`)}
          ${card('Dostarczalność domen', h`
            <form method="post" action="${A}/events/sync" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
              <button class="btn btn-secondary btn-sm" type="submit">${icon('refresh', { size: 14 })} Odśwież logi</button></form>
            ${listEvents({ limit: 8 }).length ? table({
              columns: [
                { label: 'Adres', render: (r) => h`<span class="cell-mono small">${r.recipient || r.sender}</span>` },
                { label: 'Status', render: (r) => badge(r.status, ({ delivered: 'ok', failed: 'danger', deferred: 'warn' })[r.status] || 'muted') },
                { label: 'Czas', render: (r) => formatDate(r.created_at, { time: true }) },
              ],
              rows: listEvents({ limit: 8 }),
            }) : emptyState('Brak zdarzeń — kliknij „Odśwież logi”.')}`)}
        </div>`;
    }

    if (t === 'diagnose') {
      body += card('Diagnostyka adresu e-mail', h`
        <form method="post" action="${A}/diagnose" class="row"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <input class="u-s95" name="address" type="email" placeholder="np. kontakt@twojadomena.pl" required>
          <button class="btn btn-primary" type="submit">Diagnozuj</button></form>
        <p class="small muted mt-12">Sprawdzamy domenę w panelu, MX, SPF, DKIM, DMARC, skrzynkę oraz porty IMAP/SMTP.</p>`);
    }

    if (t === 'queue') {
      const q = queueList();
      body += h`${q.rows.length ? card('Kolejka wiadomości', table({
        columns: [
          { label: 'ID', render: (r) => h`<span class="cell-mono small">${r.id}</span>` },
          { label: 'Wiek', key: 'age' },
          { label: 'Rozmiar', key: 'size' },
          { label: 'Nadawca', render: (r) => h`<span class="cell-mono small">${r.sender || '—'}</span>` },
          { label: 'Odbiorca', render: (r) => h`<span class="cell-mono small">${r.recipient || '—'}</span>` },
          { label: 'Status', render: (r) => badge(r.status, r.status === 'deferred' ? 'warn' : r.status === 'failed' ? 'danger' : 'ok') },
          { label: 'Powód', render: (r) => h`<span class="small muted">${r.reason || '—'}</span>` },
        ],
        rows: q.rows,
        actions: [
          { label: 'Ponów', form: (r) => `${A}/queue/${r.id}/retry`, icon: 'refresh' },
          { label: 'Usuń', form: (r) => `${A}/queue/${r.id}/delete`, icon: 'trash', danger: true, confirm: (r) => `Usunąć wiadomość ${r.id}?` },
        ],
      }), { sub: q.simulated ? 'sandbox — wpisy panelu' : 'exim -bp' }) : emptyState('Kolejka jest pusta.', { icon: 'mail' })}
      ${q.rows.length ? h`<div class="row mt-18"><form method="post" action="${A}/queue/retry-all" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-secondary btn-sm" type="submit">Ponów wszystkie</button></form></div>` : ''}`;
    }

    if (t === 'events') {
      const domain = String(ctx.query.domain || '');
      const status = String(ctx.query.status || '');
      const rows = listEvents({ domain, status, limit: 200 });
      body += h`${card('Zdarzenia dostarczeń', h`
        <form method="get" action="${A}" class="row mb-12"><input type="hidden" name="tab" value="events">
          <input name="domain" value="${domain}" placeholder="domena">
          <select name="status"><option value="">wszystkie</option>${['delivered', 'deferred', 'failed', 'received', 'relayed'].map((s) => h`<option value="${s}" ${status === s ? 'selected' : ''}>${s}</option>`)}</select>
          <button class="btn btn-secondary btn-sm" type="submit">Filtruj</button></form>
        <form method="post" action="${A}/events/sync" class="inline mb-12"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-secondary btn-sm" type="submit">${icon('refresh', { size: 14 })} Odśwież z Exima</button></form>
        ${table({
          columns: [
            { label: 'Czas', render: (r) => formatDate(r.created_at, { time: true }) },
            { label: 'Kierunek', render: (r) => badge(r.status, ({ delivered: 'ok', failed: 'danger', deferred: 'warn' })[r.status] || 'muted') },
            { label: 'Od', render: (r) => h`<span class="cell-mono small">${r.sender || '—'}</span>` },
            { label: 'Do', render: (r) => h`<span class="cell-mono small">${r.recipient || '—'}</span>` },
            { label: 'Powód', render: (r) => h`<span class="small muted">${r.reason || '—'}</span>` },
          ],
          rows,
          empty: 'Brak zdarzeń. Kliknij „Odśwież z Exima”.',
        })}`, { padded: false, sub: `${rows.length} wpis(ów)` })}`;
    }

    if (t === 'filters') {
      body += h`
        ${card('Dodaj filtr', form([
          field({ name: 'kind', label: 'Typ', type: 'select', options: [
            { value: 'sender_domain', label: 'Domena nadawcy' }, { value: 'rbl', label: 'RBL' }, { value: 'country', label: 'Kraj (wymaga GeoIP)' },
          ] }),
          field({ name: 'value', label: 'Wartość', required: true, placeholder: 'spam.example lub zen.spamhaus.org' }),
          field({ name: 'domain', label: 'Domena docelowa (opcjonalnie)' }),
          field({ name: 'action', label: 'Akcja', type: 'select', options: ['reject', 'defer', 'discard'] }),
        ], { action: `${A}/filters`, csrf: ctx.csrf, submit: 'Dodaj filtr' }))}
        ${filterEditing ? card(`Edytuj filtr · ${filterEditing.value}`, form([
          field({ name: 'kind', label: 'Typ', type: 'select', value: filterEditing.kind, options: [{value:'sender_domain',label:'Domena nadawcy'},{value:'rbl',label:'RBL'},{value:'country',label:'Kraj'}] }),
          field({ name: 'value', label: 'Wartość', value: filterEditing.value, required: true }),
          field({ name: 'domain', label: 'Domena', value: filterEditing.domain || '' }),
          field({ name: 'action', label: 'Akcja', type: 'select', value: filterEditing.action, options: ['reject','defer','discard'] }),
        ], { action: `${A}/filters/${filterEditing.id}/update`, csrf: ctx.csrf, submit: 'Zapisz filtr' })) : ''}
        ${card('Filtry', table({
          columns: [
            { label: 'Typ', key: 'kind' }, { label: 'Wartość', render: (r) => h`<span class="cell-mono">${r.value}</span>` },
            { label: 'Domena', key: 'domain' }, { label: 'Akcja', key: 'action' },
          ],
          rows: listFilters(),
          actions: [
            { label: 'Edytuj', href: (r) => `${A}?tab=filters&edit=${r.id}`, icon: 'edit' },
            { label: 'Usuń', form: (r) => `${A}/filters/${r.id}/delete`, icon: 'trash', danger: true, confirm: 'Usunąć filtr?' },
          ],
          empty: 'Brak filtrów.',
        }), { padded: false })}
        ${card('Czarna lista domen nadawców', h`<form method="post" action="${A}/blacklist" class="row"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <input name="domain" placeholder="spam.example" required><button class="btn btn-secondary" type="submit">Dodaj</button></form>
          ${table({ columns: [{ label: 'Domena', key: 'domain' }, { label: 'Powód', key: 'reason' }], rows: blacklist(), actions: [{ label: 'Usuń', form: (r) => `${A}/blacklist/${r.id}/delete`, icon: 'trash', danger: true }] })}`)}
      `;
    }

    if (t === 'routing') {
      const domains = all('SELECT name FROM domains ORDER BY name');
      body += h`
        ${card('Routing domeny', form([
          field({ name: 'domain', label: 'Domena', type: 'select', options: domains.map((d) => d.name) }),
          field({ name: 'router', label: 'Router', type: 'select', options: [
            { value: 'local', label: 'Lokalny (Dovecot)' }, { value: 'remote', label: 'Zdalny host' }, { value: 'split', label: 'Split delivery' },
          ] }),
          field({ name: 'target', label: 'Host:port', placeholder: 'mail2.example.com:25' }),
        ], { action: `${A}/routing`, csrf: ctx.csrf, submit: 'Zapisz routing' }))}
        ${card('Aktywny routing', table({
          columns: [{ label: 'Domena', key: 'domain' }, { label: 'Router', key: 'router' }, { label: 'Cel', key: 'target' }, { label: 'Split', render: (r) => badge(r.split ? 'tak' : 'nie', r.split ? 'warn' : 'muted') }],
          rows: listRoutes(), empty: 'Brak niestandardowego routingu.',
          actions: [{ label: 'Usuń', form: (r) => `${A}/routing/${encodeURIComponent(r.domain)}/delete`, icon: 'trash', danger: true, confirm: (r) => `Usunąć routing ${r.domain}?` }],
        }), { padded: false })}
        <form method="post" action="${A}/routing/apply"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-secondary" type="submit">Zastosuj routing w Eximie</button></form>`;
    }

    if (t === 'smtp') {
      body += h`
        ${card('Dodaj remote SMTP', form([
          field({ name: 'name', label: 'Nazwa', placeholder: 'SendGrid' }),
          field({ name: 'host', label: 'Host', required: true }),
          field({ name: 'port', label: 'Port', type: 'number', value: 587 }),
          field({ name: 'username', label: 'Użytkownik' }),
          field({ name: 'password', label: 'Hasło', type: 'password' }),
          field({ name: 'tls', label: 'TLS', type: 'checkbox', value: true }),
        ], { action: `${A}/smtp`, csrf: ctx.csrf, submit: 'Zapisz i przetestuj' }))}
        ${smtpEditing ? card(`Edytuj remote SMTP · ${smtpEditing.name}`, form([
          field({ name: 'name', label: 'Nazwa', value: smtpEditing.name, required: true }),
          field({ name: 'host', label: 'Host', value: smtpEditing.host, required: true }),
          field({ name: 'port', label: 'Port', type: 'number', value: smtpEditing.port }),
          field({ name: 'username', label: 'Użytkownik', value: smtpEditing.username || '' }),
          field({ name: 'password', label: 'Nowe hasło (puste = bez zmian)', type: 'password' }),
          field({ name: 'tls', label: 'TLS', type: 'checkbox', value: !!smtpEditing.tls }),
        ], { action: `${A}/smtp/${smtpEditing.id}/update`, csrf: ctx.csrf, submit: 'Zapisz remote SMTP' })) : ''}
        ${card('Skonfigurowane serwery', table({
          columns: [{ label: 'Nazwa', key: 'name' }, { label: 'Host', key: 'host' }, { label: 'Port', key: 'port' }, { label: 'Aktywny', render: (r) => badge(r.enabled ? 'tak' : 'nie', r.enabled ? 'ok' : 'muted') }],
          rows: listRemoteSmtp(),
          actions: [
            { label: 'Edytuj', href: (r) => `${A}?tab=smtp&edit=${r.id}`, icon: 'edit' },
            { label: 'Test', form: (r) => `${A}/smtp/${r.id}/test`, icon: 'check' },
            { label: 'Usuń', form: (r) => `${A}/smtp/${r.id}/delete`, icon: 'trash', danger: true, confirm: 'Usunąć remote SMTP?' },
            { label: 'Aktywuj', form: (r) => `${A}/smtp/${r.id}/activate`, icon: 'play' },
          ],
          empty: 'Brak remote SMTP.',
        }), { padded: false })}
      `;
    }

    if (t === 'settings') {
      body += h`
        ${card('Ustawienia poczty', form([
          field({ name: 'rbl', label: 'RBL (oddzielone spacją)', value: cfg.rbl.join(' '), full: true }),
          field({ name: 'greylisting', label: 'Greylisting', type: 'checkbox', value: cfg.greylisting, help: grey.supported ? 'Wykryto moduł greylistingu.' : 'Wymaga rspamd lub postgrey — bez modułu nie zostanie zastosowany.' }),
          field({ name: 'greylist_delay', label: 'Opóźnienie greylistingu (s)', type: 'number', value: cfg.greylist_delay }),
          field({ name: 'country_filter', label: 'Filtr krajów nadawcy', type: 'checkbox', value: cfg.country_filter, help: 'Wymaga GeoIP w Eximie; bez modułu opcja jest tylko zapisem.' }),
          field({ name: 'sender_blacklist', label: 'Domeny nadawców (jedna linia)', type: 'textarea', rows: 3, value: cfg.sender_blacklist.join('\n'), full: true }),
        ], { action: `${A}/settings`, csrf: ctx.csrf, submit: 'Zapisz ustawienia' }))}
        ${card('Zastosuj konfigurację', h`<form method="post" action="${A}/apply"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <p class="small muted">Zapisuje makra RBL, listę nadawców i routing w Eximie, waliduje i przeładowuje usługę.</p>
          <button class="btn btn-secondary" type="submit">Zastosuj Exim</button></form>`)}
        ${card('Filtr krajów nadawcy', h`${!geoipSupport().supported ? alert(`Zapis polityki bez egzekwowania: ${geoipSupport().reason}.`, 'warn') : ''}
          <form method="post" action="${A}/countries" class="row"><input type="hidden" name="_csrf" value="${ctx.csrf}">
            <input class="u-s96" name="country" maxlength="2" placeholder="np. ru" required><button class="btn btn-secondary" type="submit">Dodaj kraj</button></form>
          ${listCountries().length ? table({
            columns: [{ label: 'Kraj', render: (r) => h`<span class="cell-mono">${r.country.toUpperCase()}</span>` }, { label: 'Akcja', key: 'action' }],
            rows: listCountries(),
            actions: [{ label: 'Usuń', form: (r) => `${A}/countries/${r.country}/delete`, icon: 'trash', danger: true }],
          }) : h`<p class="small muted">Brak krajów.</p>`}`)}
        ${!grey.supported ? alert('Greylisting nie jest dostępny na tym serwerze (brak rspamd/postgrey). Ustawienie nie będzie udawać, że działa.', 'info') : ''}
      `;
    }

    return page(ctx, { title: 'Mail Operations Center', subtitle: 'Kolejka, dostarczalność, filtry i routing', body, wide: true });
  });

  router.post(`${A}/diagnose`, async (ctx) => {
    const result = await diagnose(ctx.body.address);
    if (!result.ok) return ctx.redirect(`${A}?tab=diagnose&flash=${encodeURIComponent(result.error)}&type=error`);
    const body = h`
      ${card(`Diagnoza · ${result.email}`, h`
        <div class="spread mb-12"><strong>Wynik: ${result.score}%</strong>${badge(result.score >= 80 ? 'dobrze' : result.score >= 50 ? 'do poprawy' : 'krytycznie', result.score >= 80 ? 'ok' : result.score >= 50 ? 'warn' : 'danger')}</div>
        <div class="stack">${result.checks.map((c) => h`<div class="service-row">
          <span class="service-dot ${c.ok ? 'on' : 'off'}"></span><div class="u-s14"><strong>${c.label}</strong><div class="small muted">${c.detail}</div>${c.ok ? '' : h`<div class="small u-s3">${c.hint}</div>`}</div>
          ${badge(c.ok ? 'OK' : 'problem', c.ok ? 'ok' : 'warn')}
        </div>`)}</div>
        <div class="row mt-18"><a class="btn btn-primary" href="${A}?tab=diagnose">Kolejny adres</a><a class="btn btn-secondary" href="${A}?tab=events">Raporty</a></div>`)}`;
    return page(ctx, { title: 'Diagnostyka poczty', subtitle: result.email, body });
  });
  router.post(`${A}/queue/:id/:action`, (ctx) => {
    const action = ctx.params.action === 'retry' ? 'retry' : 'delete';
    const r = queueAction(ctx.params.id, action);
    return ctx.redirect(`${A}?tab=queue&flash=${encodeURIComponent(r.ok ? r.output : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/queue/retry-all`, (ctx) => {
    const q = queueList();
    let ok = 0;
    for (const r of q.rows.filter((x) => x.status !== 'delivered')) if (queueAction(r.id, 'retry').ok) ok++;
    return ctx.redirect(`${A}?tab=queue&flash=${encodeURIComponent(`Ponowiono ${ok} wiadomości`)}`);
  });
  router.post(`${A}/events/sync`, (ctx) => {
    const r = syncMailEvents();
    return ctx.redirect(`${A}?tab=events&flash=${encodeURIComponent(r.output || r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/filters`, (ctx) => {
    const r = addFilter(ctx.body, ctx.user.username);
    return ctx.redirect(`${A}?tab=filters&flash=${encodeURIComponent(r.ok ? 'Filtr dodany' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/filters/:id/update`, (ctx) => {
    const f = get('SELECT * FROM mail_filters WHERE id = ?', Number(ctx.params.id));
    if (!f) return ctx.redirect(`${A}?tab=filters&flash=Not%20found&type=error`);
    run('UPDATE mail_filters SET kind=?, value=?, domain=?, action=? WHERE id=?', String(ctx.body.kind || f.kind), String(ctx.body.value || ''), String(ctx.body.domain || '') || null, String(ctx.body.action || f.action), f.id);
    return ctx.redirect(`${A}?tab=filters&flash=Filtr%20zaktualizowany`);
  });
  router.post(`${A}/filters/:id/delete`, (ctx) => { removeFilter(ctx.params.id, ctx.user.username); return ctx.redirect(`${A}?tab=filters&flash=Filtr%20usuni%C4%99ty`); });
  router.post(`${A}/blacklist`, (ctx) => {
    const r = addBlacklist(ctx.body.domain, ctx.user.username);
    return ctx.redirect(`${A}?tab=filters&flash=${encodeURIComponent(r.ok ? 'Domena zablokowana' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/blacklist/:id/delete`, (ctx) => { removeBlacklist(ctx.params.id); return ctx.redirect(`${A}?tab=filters&flash=Usuni%C4%99to`); });
  router.post(`${A}/routing`, (ctx) => {
    const r = saveRoute(ctx.body, ctx.user.username);
    return ctx.redirect(`${A}?tab=routing&flash=${encodeURIComponent(r.ok ? 'Routing zapisany' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/routing/:domain/delete`, (ctx) => {
    run('DELETE FROM mail_routing WHERE domain = ?', decodeURIComponent(ctx.params.domain));
    applyRouting();
    return ctx.redirect(`${A}?tab=routing&flash=Routing%20usuni%C4%99ty`);
  });
  router.post(`${A}/routing/apply`, (ctx) => {
    const r = applyRouting();
    return ctx.redirect(`${A}?tab=routing&flash=${encodeURIComponent(r.ok ? 'Routing zastosowany' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/smtp`, async (ctx) => {
    const r = await saveRemoteSmtp(ctx.body, ctx.user.username);
    if (!r.ok) return ctx.redirect(`${A}?tab=smtp&flash=${encodeURIComponent(r.error)}&type=error`);
    const msg = r.tested?.ok ? 'Zapisano; test TCP OK' : `Zapisano; test nieudany: ${r.tested?.detail || 'brak'}`;
    return ctx.redirect(`${A}?tab=smtp&flash=${encodeURIComponent(msg)}&type=${r.tested?.ok ? 'ok' : 'error'}`);
  });
  router.post(`${A}/smtp/:id/delete`, (ctx) => {
    run('DELETE FROM remote_smtp WHERE id = ?', Number(ctx.params.id));
    return ctx.redirect(`${A}?tab=smtp&flash=Usuni%C4%99to`);
  });
  router.post(`${A}/smtp/:id/update`, async (ctx) => {
    const r = await saveRemoteSmtp({ ...ctx.body, id: ctx.params.id }, ctx.user.username);
    return ctx.redirect(`${A}?tab=smtp&flash=${encodeURIComponent(r.ok ? 'Remote SMTP zapisany' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/smtp/:id/test`, async (ctx) => {
    const row = get('SELECT * FROM remote_smtp WHERE id = ?', Number(ctx.params.id));
    if (!row) return ctx.redirect(`${A}?tab=smtp&flash=Nie%20znaleziono&type=error`);
    const r = await testRemoteSmtp(row);
    return ctx.redirect(`${A}?tab=smtp&flash=${encodeURIComponent(r.ok ? `Test OK: ${r.detail}` : `Test nieudany: ${r.detail}`)}&type=${r.ok ? 'ok' : 'error'}`);
  });
  router.post(`${A}/smtp/:id/activate`, async (ctx) => {
    const r = await activateRemoteSmtp(ctx.params.id, ctx.user.username);
    return ctx.redirect(`${A}?tab=smtp&flash=${encodeURIComponent(r.ok ? 'Remote SMTP aktywny' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/settings`, (ctx) => {
    saveMailSettings(ctx.body, ctx.user.username);
    return ctx.redirect(`${A}?tab=settings&flash=Ustawienia%20zapisane`);
  });
  router.post(`${A}/countries`, (ctx) => {
    const r = addCountry(ctx.body.country, ctx.user.username);
   	return ctx.redirect(`${A}?tab=settings&flash=${encodeURIComponent(r.ok ? (r.supported ? 'Kraj dodany' : 'Kraj zapisany; Exim bez GeoIP — bez egzekwowania') : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/countries/:country/delete`, (ctx) => {
    removeCountry(ctx.params.country);
    return ctx.redirect(`${A}?tab=settings&flash=Kraj%20usuni%C4%99ty`);
  });
  router.post(`${A}/apply`, (ctx) => {
    const r = applyEximSettings();
    return ctx.redirect(`${A}?tab=settings&flash=${encodeURIComponent(r.ok ? 'Konfiguracja Exima zastosowana' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
}
