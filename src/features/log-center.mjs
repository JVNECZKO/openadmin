// Administrator log center.
import { html as h } from '../util.mjs';
import { formatBytesIEC } from '../metrics.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, form, field, tabs } from '../ui/components.mjs';
import { sources, tail, rotationConfig, saveRotation, downloadSource } from '../logcenter.mjs';

const A = '/admin/log-center';

export function register(router) {
  router.get(A, (ctx) => {
    const tab = String(ctx.query.tab || 'browse') === 'rotation' ? 'rotation' : 'browse';
    const srcs = sources();
    const id = String(ctx.query.source || srcs[0]?.id || '');
    const lines = String(ctx.query.lines || '200');
    const query = String(ctx.query.q || '');
    const result = id ? tail(id, { lines, query }) : { ok: false, rows: [] };
    const body = h`
      ${tabs([{ key: 'browse', label: 'Przeglądarka', count: srcs.length }, { key: 'rotation', label: 'Rotacja' }], tab, { base: A })}
      ${tab === 'browse' ? h`
        ${srcs.length ? card('Wybierz log', h`<form method="get" action="${A}" class="row"><input type="hidden" name="tab" value="browse">
          <select name="source">${srcs.map((s) => h`<option value="${s.id}" ${s.id === id ? 'selected' : ''}>${s.label} (${s.sizeBytes === null ? 'niedostępny' : formatBytesIEC(s.sizeBytes)})</option>`)}</select>
          <input class="u-s65" name="lines" value="${lines}" type="number" min="20" max="2000">
          <input name="q" value="${query}" placeholder="filtr tekstowy">
          <button class="btn btn-secondary" type="submit">Pokaż</button>
          ${id ? h`<a class="btn btn-ghost" href="${A}/download?source=${encodeURIComponent(id)}">Pobierz</a>` : ''}
        </form>`, { sub: 'Ostatnie 512 KB, maks. 2000 linii. Pobieranie zwraca cały plik.' }) : alert('Nie wykryto plików logów. Sprawdź, czy usługi zapisują logi w standardowych lokalizacjach.', 'warn')}
        ${!result.ok ? alert(result.error || 'Brak logów do wyświetlenia.', 'warn') : card(result.source.label, h`<pre class="code-block small u-s75">${result.rows.join('\n') || 'Brak linii.'}</pre>`, { sub: `${result.rows.length} linii · ${result.source.sizeBytes === null ? 'rozmiar niedostępny' : formatBytesIEC(result.source.sizeBytes)} · ${result.source.file}` })}
      ` : ''}
      ${tab === 'rotation' ? h`
        ${card('Konfiguracja logrotate', h`<form method="post" action="${A}/rotation" class="oa-form"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <textarea name="config" rows="18" class="code-block">${rotationConfig()}</textarea>
          <div class="form-actions"><button class="btn btn-primary" type="submit">Zapisz i zwaliduj</button></div></form>`, { sub: '/etc/logrotate.d/openadmin · walidacja logrotate -d' })}
        ${alert('Rotacja logów systemowych może wymagać restartu usług; dotyczy tylko plików panelu, nie całego syslogu.', 'info')}
      ` : ''}`;
    return page(ctx, { title: 'Log Center', subtitle: 'Nginx/Apache/Exim/auth/ModSecurity i rotacja', body, wide: true });
  });

  router.get(`${A}/download`, (ctx) => {
    const r = downloadSource(ctx.query.source);
    if (!r.ok) return ctx.redirect(`${A}?flash=${encodeURIComponent(r.error)}&type=error`);
    return { status: 200, raw: r.data.toString('utf8'), type: 'text/plain' };
  });
  router.post(`${A}/rotation`, (ctx) => {
    const r = saveRotation(ctx.body.config, ctx.user.username);
    return ctx.redirect(`${A}?tab=rotation&flash=${encodeURIComponent(r.ok ? 'Rotacja zapisana' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
}
