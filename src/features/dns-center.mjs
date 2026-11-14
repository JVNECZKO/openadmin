// Administrator DNS operations.
import { all } from '../db.mjs';
import { html as h } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, tabs, form, field, kvList } from '../ui/components.mjs';
import { dnsOverview, setZoneTtl, templates, saveTemplate, deleteTemplate, applyTemplate, setMx, cleanupDns } from '../dnsops.mjs';

const A = '/admin/dns-ops';

export function register(router) {
  router.get(A, (ctx) => {
    const tab = ['zones', 'mx', 'templates', 'cleanup'].includes(String(ctx.query.tab)) ? String(ctx.query.tab) : 'zones';
    const ov = dnsOverview();
    const editing = ctx.query.edit && tab === 'templates' ? templates().find((t) => String(t.id) === String(ctx.query.edit)) : null;
    const body = h`
      ${tabs([
        { key: 'zones', label: 'Strefy', count: ov.zones.length },
        { key: 'mx', label: 'MX' },
        { key: 'templates', label: 'Szablony', count: ov.templates },
        { key: 'cleanup', label: 'Cleanup' },
      ], tab, { base: A })}
      ${tab === 'zones' ? h`
        ${card('Strefy i TTL', table({
          columns: [
            { label: 'Domena', render: (r) => h`<span class="cell-strong">${r.name}</span>` },
            { label: 'Rekordy', render: (r) => String(r.records) },
            { label: 'TTL strefy', render: (r) => h`<form method="post" action="${A}/zones/${encodeURIComponent(r.name)}/ttl" class="row" style="gap:6px"><input type="hidden" name="_csrf" value="${ctx.csrf}"><input name="ttl" type="number" value="${r.dns_ttl}" min="60" max="604800" style="width:110px"><button class="btn btn-ghost btn-sm" type="submit">Zapisz</button></form>` },
          ],
          rows: ov.zones,
          actions: [{ label: 'Edytuj rekordy', href: (r) => `/admin/dns?domain=${encodeURIComponent(r.name)}`, icon: 'edit' }],
          empty: 'Brak stref DNS.',
        }), { padded: false })}
      ` : ''}
      ${tab === 'mx' ? h`
        ${card('Ustaw MX', form([
          field({ name: 'domain', label: 'Domena', type: 'select', options: ov.zones.map((z) => z.name) }),
          field({ name: 'host', label: 'Host MX', required: true, placeholder: 'mail.twojadomena.pl' }),
          field({ name: 'priority', label: 'Priorytet', type: 'number', value: 10, min: 0, max: 100 }),
        ], { action: `${A}/mx`, csrf: ctx.csrf, submit: 'Ustaw MX' }))}
        ${card('Aktualne MX', table({
          columns: [{ label: 'Domena', key: 'domain' }, { label: 'Host', render: (r) => h`<span class="cell-mono">${r.value}</span>` }, { label: 'Priorytet', key: 'priority' }],
          rows: all("SELECT d.name domain, r.value, r.priority FROM dns_records r JOIN domains d ON d.id = r.domain_id WHERE r.type = 'MX' ORDER BY d.name"),
          empty: 'Brak rekordów MX.',
        }), { padded: false })}
      ` : ''}
      ${tab === 'templates' ? h`
        ${card('Nowy szablon', form([
          field({ name: 'name', label: 'Nazwa', required: true }),
          field({ name: 'records', label: 'Rekordy (JSON)', type: 'textarea', rows: 8, full: true, value: '[\n  {"name":"@","type":"A","value":"192.0.2.10","ttl":3600},\n  {"name":"@","type":"MX","value":"mail.example.com","priority":10}\n]' }),
        ], { action: `${A}/templates`, csrf: ctx.csrf, submit: 'Zapisz szablon' }))}
        ${editing ? card(`Edytuj szablon · ${editing.name}`, form([
          field({ name: 'name', label: 'Nazwa', value: editing.name, required: true }),
          field({ name: 'records', label: 'Rekordy (JSON)', type: 'textarea', rows: 10, full: true, value: JSON.stringify(JSON.parse(editing.records || '[]'), null, 2) }),
        ], { action: `${A}/templates/${editing.id}/update`, csrf: ctx.csrf, submit: 'Zapisz szablon' })) : ''}
        ${card('Szablony', table({
          columns: [{ label: 'Nazwa', key: 'name' }, { label: 'Rekordy', render: (r) => String(JSON.parse(r.records || '[]').length) }],
          rows: templates(),
          actions: [
            { label: 'Edytuj', href: (r) => `${A}?tab=templates&edit=${r.id}`, icon: 'edit' },
            { label: 'Usuń', form: (r) => `${A}/templates/${r.id}/delete`, icon: 'trash', danger: true, confirm: 'Usunąć szablon?' },
          ],
          empty: 'Brak szablonów.',
        }), { padded: false })}
        ${templates().length ? card('Zastosuj szablon', form([
          field({ name: 'domain', label: 'Domena', type: 'select', options: ov.zones.map((z) => z.name) }),
          field({ name: 'template', label: 'Szablon', type: 'select', options: templates().map((t) => ({ value: String(t.id), label: t.name })) }),
          field({ name: 'replace', label: 'Zastąp istniejące rekordy (poza NS/SOA)', type: 'checkbox' }),
        ], { action: `${A}/templates/apply`, csrf: ctx.csrf, submit: 'Zastosuj' })) : ''}
      ` : ''}
      ${tab === 'cleanup' ? h`
        ${card('Cleanup DNS', h`<p class="small muted">Wykrywa duplikaty rekordów i puste wartości, przebudowuje strefy. Dry-run nic nie zmienia.</p>
          <div class="row"><form method="post" action="${A}/cleanup" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-secondary" type="submit">Dry-run</button></form>
          <form method="post" action="${A}/cleanup/apply" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-danger" type="submit" data-confirm="Usunąć duplikaty i przebudować strefy?">Wyczyść</button></form></div>`)}
        ${alert('DNS cluster jest kolejnym etapem — nie udajemy klastra, jeśli nie ma skonfigurowanych węzłów.', 'info')}
      ` : ''}`;
    return page(ctx, { title: 'DNS Operations', subtitle: 'TTL, MX, szablony i cleanup', body, wide: true });
  });

  router.post(`${A}/zones/:name/ttl`, (ctx) => {
    const r = setZoneTtl(decodeURIComponent(ctx.params.name), ctx.body.ttl, ctx.user.username);
    return ctx.redirect(`${A}?tab=zones&flash=${encodeURIComponent(r.ok ? r.output : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/mx`, (ctx) => {
    const r = setMx(ctx.body.domain, ctx.body.host, ctx.body.priority, ctx.user.username);
    return ctx.redirect(`${A}?tab=mx&flash=${encodeURIComponent(r.ok ? 'MX ustawiony' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/templates`, (ctx) => {
    const r = saveTemplate(ctx.body, ctx.user.username);
    return ctx.redirect(`${A}?tab=templates&flash=${encodeURIComponent(r.ok ? `Szablon zapisany (${r.count} rekordów)` : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/templates/:id/update`, (ctx) => {
    const r = saveTemplate({ ...ctx.body, id: ctx.params.id }, ctx.user.username);
    return ctx.redirect(`${A}?tab=templates&flash=${encodeURIComponent(r.ok ? 'Szablon zapisany' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/templates/:id/delete`, (ctx) => { deleteTemplate(ctx.params.id); return ctx.redirect(`${A}?tab=templates&flash=Usuni%C4%99to`); });
  router.post(`${A}/templates/apply`, (ctx) => {
    const r = applyTemplate(ctx.body.domain, ctx.body.template, { replace: !!ctx.body.replace, actor: ctx.user.username });
    return ctx.redirect(`${A}?tab=templates&flash=${encodeURIComponent(r.ok ? `Dodano ${r.added} rekordów` : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/cleanup`, (ctx) => {
    const r = cleanupDns({ apply: false, actor: ctx.user.username });
    const body = h`${card('Wynik dry-run', h`${kvList([['Duplikaty', String(r.duplicates)], ['Rekordy do usunięcia', String(r.duplicateRecords)], ['Puste wartości', String(r.invalid)]])}<p class="small muted mt-12">Nic nie zmieniono.</p><a class="btn btn-primary mt-18" href="${A}?tab=cleanup">Wróć</a>`)}`;
    return page(ctx, { title: 'DNS cleanup', subtitle: 'Dry-run', body });
  });
  router.post(`${A}/cleanup/apply`, (ctx) => {
    const r = cleanupDns({ apply: true, actor: ctx.user.username });
    return ctx.redirect(`${A}?tab=cleanup&flash=${encodeURIComponent(`Usunięto ${r.removed} rekordów; strefy przebudowane`)}`);
  });
}
