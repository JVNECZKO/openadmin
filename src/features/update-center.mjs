// Administrator panel/OS update center.
import { html as h } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, tabs, kvList } from '../ui/components.mjs';
import { checkPanel, osCheck, stagePanelUpdate, applyOsUpdates, updateInfo } from '../updates.mjs';

const A = '/admin/updates-center';

export function register(router) {
  router.get(A, (ctx) => {
    const tab = ['panel', 'os'].includes(String(ctx.query.tab)) ? String(ctx.query.tab) : 'panel';
    const info = updateInfo();
    const body = h`
      ${tabs([{ key: 'panel', label: 'Panel' }, { key: 'os', label: 'Pakiety OS' }], tab, { base: A })}
      ${tab === 'panel' ? h`
        ${card('Wersja panelu', h`${kvList([['Zainstalowana', info.current], ['Ostatnia aktualizacja', info.lastPanel || '—']])}
          <div class="row mt-18"><form method="post" action="${A}/check" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-primary" type="submit">Sprawdź aktualizacje</button></form>
          <form method="post" action="${A}/panel/dry" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-secondary" type="submit">Dry-run aktualizacji</button></form></div>`)}
        ${alert('Aktualizacja panelu pobiera paczkę z GitHub, robi backup src/bin/package.json i podmienia pliki. Wymaga restartu usługi; nie jest wykonywana automatycznie.', 'warn')}
      ` : ''}
      ${tab === 'os' ? h`
        ${card('Pakiety systemowe', h`<form method="post" action="${A}/os/dry" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-secondary" type="submit">Sprawdź (dry-run)</button></form>
          <p class="small muted mt-12">Używa <code>apt-get -s upgrade</code>; aktualizacja realna wymaga potwierdzenia i uprawnień roota.</p>`)}
        ${info.lastOs ? kvList([['Ostatnia aktualizacja OS', info.lastOs]]) : ''}
      ` : ''}`;
    return page(ctx, { title: 'Update Center', subtitle: 'Panel i pakiety systemowe', body, wide: true });
  });

  router.post(`${A}/check`, async (ctx) => {
    const r = await checkPanel();
    if (!r.ok) return ctx.redirect(`${A}?flash=${encodeURIComponent(r.error)}&type=error`);
    const body = h`${card('Wynik sprawdzania', h`${kvList([['Zainstalowana', r.current], ['Najnowsza', r.latest], ['Aktualizacja', r.update ? 'dostępna' : 'brak']])}
      ${r.notes ? h`<pre class="code-block small mt-12">${String(r.notes).slice(0, 4000)}</pre>` : ''}
      <div class="row mt-18"><a class="btn btn-primary" href="${A}">Wróć</a></div>`)}`;
    return page(ctx, { title: 'Aktualizacje panelu', subtitle: r.latest, body });
  });
  router.post(`${A}/panel/dry`, async (ctx) => {
    const r = await stagePanelUpdate({ apply: false, actor: ctx.user.username });
    if (!r.ok) return ctx.redirect(`${A}?flash=${encodeURIComponent(r.error)}&type=error`);
    const body = h`${card('Dry-run aktualizacji', h`${kvList([['Zainstalowana', r.current], ['Najnowsza', r.latest], ['Paczka', r.url || '—'], ['Backup', r.backupDir || '—']])}
      <p class="small muted mt-12">${r.note || 'Aktualizacja dostępna. Zastosowanie wymaga potwierdzenia.'}</p>
      ${r.note ? '' : h`<form method="post" action="${A}/panel/apply"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-danger" type="submit" onclick="return confirm('Zaktualizować panel? Zostanie wykonany backup i trzeba będzie zrestartować usługę.')">Zastosuj aktualizację</button></form>`}
      <div class="row mt-18"><a class="btn btn-primary" href="${A}">Wróć</a></div>`)}`;
    return page(ctx, { title: 'Aktualizacja panelu', subtitle: 'Dry-run', body });
  });
  router.post(`${A}/panel/apply`, async (ctx) => {
    const r = await stagePanelUpdate({ apply: true, actor: ctx.user.username });
    const msg = r.ok ? (r.applied ? `Zaktualizowano do ${r.latest}; backup: ${r.backup}. Zrestartuj panel: ${r.restart}` : r.note) : r.error;
    return ctx.redirect(`${A}?flash=${encodeURIComponent(msg)}&type=${r.ok ? 'ok' : 'error'}`);
  });
  router.post(`${A}/os/dry`, (ctx) => {
    const r = applyOsUpdates({ apply: false, actor: ctx.user.username });
    const body = h`${card('Pakiety do aktualizacji', table({
      columns: [{ label: 'Pakiet', key: 'name' }, { label: 'Z', key: 'from' }, { label: 'Do', key: 'to' }],
      rows: r.packages || [],
      empty: r.simulated ? 'Sandbox — brak pakietów OS.' : 'Brak aktualizacji.',
    }), { padded: false })}
      ${r.packages?.length ? h`<form method="post" action="${A}/os/apply" class="mt-18"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-danger" type="submit" onclick="return confirm('Zaktualizować pakiety OS?')">Zainstaluj aktualizacje</button></form>` : ''}
      <div class="row mt-18"><a class="btn btn-primary" href="${A}?tab=os">Wróć</a></div>`;
    return page(ctx, { title: 'Aktualizacje OS', subtitle: 'Dry-run', body });
  });
  router.post(`${A}/os/apply`, (ctx) => {
    const r = applyOsUpdates({ apply: true, actor: ctx.user.username });
    return ctx.redirect(`${A}?tab=os&flash=${encodeURIComponent(r.ok ? `Zainstalowano ${r.count} pakietów` : r.error || r.output)}&type=${r.ok ? 'ok' : 'error'}`);
  });
}
