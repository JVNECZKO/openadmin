// Administrator reseller privilege plans, IP delegation, ownership and mass edits.
import { all, get } from '../db.mjs';
import { html as h } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, tabs, form, field, alert } from '../ui/components.mjs';
import { plans, savePlan, deletePlan, assignPlan, resellers, delegatedIps, delegateIp, changeOwner, massModify, resellerOverview } from '../resellertools.mjs';

const A = '/admin/reseller-tools';

export function register(router) {
  router.get(A, (ctx) => {
    const tab = ['plans', 'ips', 'ownership', 'mass'].includes(String(ctx.query.tab)) ? String(ctx.query.tab) : 'plans';
    const ov = resellerOverview();
    const users = all("SELECT username, owner, package, suspended FROM users WHERE level = 'user' ORDER BY username");
    const ips = all('SELECT * FROM ips ORDER BY ip');
    const body = h`
      ${tabs([
        { key: 'plans', label: 'Plany resellera', count: ov.plans.length },
        { key: 'ips', label: 'IP delegation' },
        { key: 'ownership', label: 'Zmiana właściciela' },
        { key: 'mass', label: 'Mass modify' },
      ], tab, { base: A })}
      ${tab === 'plans' ? h`
        ${card('Nowy plan resellera', form([
          field({ name: 'name', label: 'Nazwa', required: true }),
          field({ name: 'users', label: 'Max użytkowników', type: 'number', value: 50 }),
          field({ name: 'domains', label: 'Max domen', type: 'number', value: 500 }),
          field({ name: 'emails', label: 'Max skrzynek', type: 'number', value: 1000 }),
          field({ name: 'databases', label: 'Max baz', type: 'number', value: 200 }),
          field({ name: 'disk_mb', label: 'Dysk MB', type: 'number', value: 102400 }),
          field({ name: 'bandwidth_mb', label: 'Transfer MB', type: 'number', value: 0 }),
          ...['create_users', 'create_domains', 'email', 'dns', 'ssl', 'backups', 'ip_delegation', 'packages'].map((k) => field({ name: k, label: k, type: 'checkbox', value: true })),
        ], { action: `${A}/plans`, csrf: ctx.csrf, submit: 'Utwórz plan' }))}
        ${card('Plany', table({
          columns: [{ label: 'Nazwa', key: 'name' }, { label: 'Limity', render: (r) => Object.entries(JSON.parse(r.limits || '{}')).map(([k, v]) => `${k}=${v}`).join(' ') }],
          rows: ov.plans,
          actions: [{ label: 'Usuń', form: (r) => `${A}/plans/${r.id}/delete`, icon: 'trash', danger: true, confirm: 'Usunąć plan?' }],
          empty: 'Brak planów.',
        }), { padded: false })}
        ${card('Przypisz plan', h`<form method="post" action="${A}/plans/assign" class="row"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <select name="username">${ov.resellers.map((u) => h`<option>${u.username}</option>`)}</select>
          <select name="plan"><option value="">— brak —</option>${ov.plans.map((p) => h`<option>${p.name}</option>`)}</select>
          <button class="btn btn-secondary" type="submit">Przypisz</button></form>`)}
      ` : ''}
      ${tab === 'ips' ? h`
        ${card('Deleguj IP', h`<form method="post" action="${A}/ips" class="row"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <select name="ip">${ips.map((i) => h`<option value="${i.ip}">${i.ip} (${i.status}${i.owner ? ', ' + i.owner : ''})</option>`)}</select>
          <select name="reseller"><option value="">— zwolnij —</option>${ov.resellers.map((u) => h`<option>${u.username}</option>`)}</select>
          <button class="btn btn-secondary" type="submit">Zapisz</button></form>`)}
        ${card('Delegowane IP', table({
          columns: [{ label: 'IP', render: (r) => h`<span class="cell-mono">${r.ip}</span>` }, { label: 'Właściciel', key: 'owner' }, { label: 'Status', key: 'status' }],
          rows: ov.ips, empty: 'Brak delegacji.',
        }), { padded: false })}
        ${alert('Shared IP resellera jest zapisywany jako ustawienie; nowe konta nie dziedziczą go automatycznie, dopóki nie wdrożysz przypisania w tworzeniu użytkownika.', 'info')}
      ` : ''}
      ${tab === 'ownership' ? h`
        ${card('Przenieś konta', h`<form method="post" action="${A}/ownership" class="oa-form"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <div class="row"><select name="from">${ov.resellers.map((u) => h`<option>${u.username}</option>`)}</select>
          <span>→</span><select name="to">${ov.resellers.map((u) => h`<option>${u.username}</option>`)}</select></div>
          <div class="grid grid-3 mt-12">${users.filter((u) => u.owner).map((u) => h`<label class="check-field"><input type="checkbox" name="usernames[]" value="${u.username}"> <span>${u.username} (${u.owner})</span></label>`)}</div>
          <div class="form-actions"><button class="btn btn-primary" type="submit">Przenieś zaznaczone</button></div></form>`)}
      ` : ''}
      ${tab === 'mass' ? h`
        ${card('Mass modify', h`<form method="post" action="${A}/mass" class="oa-form"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <div class="row"><input name="package" placeholder="nowy pakiet (opcjonalnie)"><select name="suspended"><option value="">bez zmian</option><option value="0">aktywuj</option><option value="1">zawieś</option></select></div>
          <div class="grid grid-3 mt-12">${users.map((u) => h`<label class="check-field"><input type="checkbox" name="usernames[]" value="${u.username}"> <span>${u.username} ${u.suspended ? '(suspended)' : ''}</span></label>`)}</div>
          <div class="form-actions"><button class="btn btn-primary" type="submit">Zastosuj</button></div></form>`)}
      ` : ''}`;
    return page(ctx, { title: 'Reseller Tools', subtitle: 'Plany, IP, właściciel i mass modify', body, wide: true });
  });

  router.post(`${A}/plans`, (ctx) => {
    const r = savePlan(ctx.body, ctx.user.username);
    return ctx.redirect(`${A}?tab=plans&flash=${encodeURIComponent(r.ok ? 'Plan zapisany' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/plans/:id/delete`, (ctx) => { deletePlan(ctx.params.id); return ctx.redirect(`${A}?tab=plans&flash=Usuni%C4%99to`); });
  router.post(`${A}/plans/assign`, (ctx) => {
    const r = assignPlan(ctx.body.username, ctx.body.plan, ctx.user.username);
    return ctx.redirect(`${A}?tab=plans&flash=${encodeURIComponent(r.ok ? 'Plan przypisany' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/ips`, (ctx) => {
    const r = delegateIp(ctx.body.ip, ctx.body.reseller, ctx.user.username);
    return ctx.redirect(`${A}?tab=ips&flash=${encodeURIComponent(r.ok ? 'IP zaktualizowane' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/ownership`, (ctx) => {
    const list = [].concat(ctx.body.usernames || []);
    const r = changeOwner(ctx.body.from, ctx.body.to, list, ctx.user.username);
    return ctx.redirect(`${A}?tab=ownership&flash=${encodeURIComponent(r.ok ? `Przeniesiono ${r.changed}` : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/mass`, (ctx) => {
    const list = [].concat(ctx.body.usernames || []);
    const suspended = ctx.body.suspended === '' ? null : ctx.body.suspended === '1';
    const r = massModify(list, { package: ctx.body.package || '', suspended }, ctx.user.username);
    return ctx.redirect(`${A}?tab=mass&flash=${encodeURIComponent(`Zmieniono ${r.changed}`)}`);
  });
}
