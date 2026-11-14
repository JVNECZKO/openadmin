// Administrator plans: feature sets, global switches and resource limits.
import { all } from '../db.mjs';
import { html as h } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, tabs, form, field } from '../ui/components.mjs';
import { FEATURES, featureSets, saveFeatureSet, deleteFeatureSet, disabledFeatures, setFeatureDisabled, planOverview, applyAllLimits, packageResources } from '../plancenter.mjs';

const A = '/admin/plans';

export function register(router) {
  router.get(A, (ctx) => {
    const tab = ['overview', 'features', 'sets'].includes(String(ctx.query.tab)) ? String(ctx.query.tab) : 'overview';
    const ov = planOverview();
    const disabled = disabledFeatures();
    const body = h`
      ${tabs([
        { key: 'overview', label: 'Plany i zasoby' },
        { key: 'features', label: 'Funkcje globalne', count: disabled.size },
        { key: 'sets', label: 'Feature sets', count: ov.featureSets.length },
      ], tab, { base: A })}
      ${tab === 'overview' ? h`
        ${card('Pakiety', table({
          columns: [
            { label: 'Pakiet', render: (r) => h`<span class="cell-strong">${r.name}</span><span class="cell-sub">${r.type}</span>` },
            { label: 'CPU %', render: (r) => packageResources(r.name).cpu_percent || '—' },
            { label: 'RAM MB', render: (r) => packageResources(r.name).memory_mb || '—' },
            { label: 'IO MB/s', render: (r) => `${packageResources(r.name).io_read_mbps}/${packageResources(r.name).io_write_mbps}` },
            { label: 'Procesy', render: (r) => packageResources(r.name).max_processes || '—' },
            { label: 'Inode', render: (r) => packageResources(r.name).inodes || '—' },
          ],
          rows: ov.packages,
          empty: 'Brak pakietów.',
        }), { padded: false })}
        ${card('Zastosuj limity', h`<form method="post" action="${A}/apply"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <p class="small muted">Tworzy wpisy limits.conf, slice systemd, quota dysk/inode (jeśli FS wspiera) i dopasowuje pm.max_children. Elementy nieobsługiwane są raportowane, nie ukrywane.</p>
          <button class="btn btn-primary" type="submit">Zastosuj do wszystkich kont</button></form>`)}
        ${alert('Twarde limity CPU/RAM są przygotowywane jako slice systemd; procesy PHP-FPM są nim objęte tylko po wdrożeniu per-user FPM. Panel nie będzie twierdził, że limit działa, jeśli nie jest egzekwowany.', 'info')}
      ` : ''}
      ${tab === 'features' ? h`
        ${card('Globalne wyłączanie funkcji', table({
          columns: [{ label: 'Funkcja', render: (r) => r.label }, { label: 'Stan', render: (r) => badge(r.disabled ? 'wyłączona' : 'włączona', r.disabled ? 'danger' : 'ok') }],
          rows: FEATURES.map(([key, label]) => ({ key, label, disabled: disabled.has(key) })),
          actions: [{ label: 'Przełącz', form: (r) => `${A}/features/${r.key}`, icon: 'toggle' }],
        }), { padded: false })}
      ` : ''}
      ${tab === 'sets' ? h`
        ${card('Nowy feature set', form(FEATURES.map(([key, label]) => field({ name: `f_${key}`, label, type: 'checkbox' })).concat([field({ name: 'name', label: 'Nazwa', required: true })]), { action: `${A}/sets`, csrf: ctx.csrf, submit: 'Utwórz feature set' }))}
        ${card('Feature sets', table({
          columns: [{ label: 'Nazwa', key: 'name' }, { label: 'Funkcje', render: (r) => Object.entries(JSON.parse(r.features || '{}')).filter(([, v]) => v).map(([k]) => k).join(', ') || '—' }],
          rows: featureSets(),
          actions: [{ label: 'Usuń', form: (r) => `${A}/sets/${r.id}/delete`, icon: 'trash', danger: true, confirm: 'Usunąć feature set?' }],
          empty: 'Brak feature setów.',
        }), { padded: false })}
      ` : ''}`;
    return page(ctx, { title: 'Plans & Limits', subtitle: 'Feature sets, globalne funkcje i limity zasobów', body, wide: true });
  });

  router.post(`${A}/sets`, (ctx) => {
    const r = saveFeatureSet(ctx.body, ctx.user.username);
    return ctx.redirect(`${A}?tab=sets&flash=${encodeURIComponent(r.ok ? 'Feature set zapisany' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/sets/:id/delete`, (ctx) => { deleteFeatureSet(ctx.params.id); return ctx.redirect(`${A}?tab=sets&flash=Usuni%C4%99to`); });
  router.post(`${A}/features/:key`, (ctx) => {
    const r = setFeatureDisabled(ctx.params.key, !disabledFeatures().has(ctx.params.key), ctx.user.username);
    return ctx.redirect(`${A}?tab=features&flash=${encodeURIComponent(r.ok ? 'Funkcja przełączona' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/apply`, (ctx) => {
    const results = applyAllLimits(ctx.user.username);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(`Limity zastosowane dla ${results.length} kont`)}`);
  });
}
