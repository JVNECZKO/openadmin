// Administrator live transfer from cPanel/DirectAdmin over SSH/rsync.
import { all } from '../db.mjs';
import { html as h, formatDate } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, form, field, emptyState } from '../ui/components.mjs';
import { liveJobs, createLiveJob, runLiveJob, testLive, checkTools } from '../livetransfer.mjs';

const A = '/admin/import-live';

export function register(router) {
  router.get(A, (ctx) => {
    const users = all("SELECT username FROM users WHERE level IN ('user','reseller') ORDER BY username");
    const tools = checkTools();
    const jobs = liveJobs();
    const body = h`
      ${!tools.ssh || !tools.rsync ? alert(`Brak narzędzi: ${!tools.ssh ? 'ssh ' : ''}${!tools.rsync ? 'rsync ' : ''}${!tools.sshpass ? '(sshpass opcjonalnie dla haseł)' : ''}`, 'warn') : ''}
      ${card('Nowy transfer', form([
        field({ name: 'source', label: 'Źródło', type: 'select', options: [{ value: 'cpanel', label: 'cPanel' }, { value: 'directadmin', label: 'DirectAdmin' }] }),
        field({ name: 'host', label: 'Host SSH', required: true, placeholder: 'srv123.example.com' }),
        field({ name: 'port', label: 'Port SSH', type: 'number', value: 22 }),
        field({ name: 'username', label: 'Użytkownik SSH', required: true }),
        field({ name: 'password', label: 'Hasło SSH (wymaga sshpass)', type: 'password' }),
        field({ name: 'key', label: 'Klucz prywatny SSH', type: 'textarea', rows: 4, full: true, placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----' }),
        field({ name: 'target', label: 'Konto docelowe', type: 'select', options: users.map((u) => u.username) }),
        field({ name: 'source_dir', label: 'Katalog źródłowy (opcjonalnie)', placeholder: '/home/user/' }),
      ], { action: `${A}/create`, csrf: ctx.csrf, submit: 'Utwórz transfer' }))}
      ${tools.sshpass ? '' : alert('Transfer z hasłem wymaga sshpass. Bez niego użyj klucza SSH.', 'info')}
      ${card('Batch', h`<form method="post" action="${A}/batch" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <p class="small muted">Jedna linia: <code>host|port|user|hasło|target</code>. Hasła są szyfrowane w bazie i usuwane po wykonaniu. Maks. 10.</p>
        <textarea name="batch" rows="6" placeholder="srv1.example.com|22|alice|secret|klient1" class="code-block"></textarea>
        <div class="form-actions"><button class="btn btn-secondary" type="submit">Utwórz i uruchom batch</button></div></form>`)}
      ${card('Transfery', table({
        columns: [
          { label: 'ID', key: 'id' }, { label: 'Źródło', key: 'source' }, { label: 'Host', render: (r) => h`<span class="cell-mono small">${r.host}</span>` },
          { label: 'Konto', key: 'target' }, { label: 'Status', render: (r) => badge(r.status, r.status === 'complete' ? 'ok' : r.status === 'failed' ? 'danger' : 'warn') },
          { label: 'Postęp', render: (r) => `${r.progress}%` }, { label: 'Start', render: (r) => formatDate(r.created_at, { time: true }) },
        ],
        rows: jobs,
        actions: [{ label: 'Uruchom', form: (r) => `${A}/jobs/${r.id}/run`, icon: 'play', show: (r) => r.status !== 'complete' }],
        empty: 'Brak transferów.',
      }), { padded: false })}
      ${jobs.length ? card('Ostatni log', h`<pre class="code-block small">${jobs[0].log || '—'}</pre>`) : ''}`;
    return page(ctx, { title: 'Live transfer', subtitle: 'cPanel / DirectAdmin przez SSH i rsync', body, wide: true });
  });

  router.post(`${A}/create`, (ctx) => {
    const r = createLiveJob(ctx.body, ctx.user.username);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(r.ok ? 'Transfer utworzony' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/test`, async (ctx) => {
    const r = testLive(ctx.body);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(r.ok ? (r.simulated ? 'Test symulowany (sandbox)' : 'Połączenie SSH OK') : r.error)}&type=${r.ok ? 'ok' : 'error'}`);
  });
  router.post(`${A}/jobs/:id/run`, (ctx) => {
    const r = runLiveJob(ctx.params.id);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(r.ok ? (r.simulated ? 'Transfer symulowany (sandbox)' : `Skonfigurowano ${r.copied} webroot(ów)`) : r.error)}&type=${r.ok ? 'ok' : 'error'}`);
  });
  router.post(`${A}/batch`, (ctx) => {
    const lines = String(ctx.body.batch || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 10);
    let created = 0; const errors = [];
    for (const line of lines) {
      const [host, port, username, password, target] = line.split('|');
      const r = createLiveJob({ source: 'cpanel', host, port, username, password, target }, ctx.user.username);
      if (r.ok) created++; else errors.push(`${target}: ${r.error}`);
    }
    if (errors.length) return ctx.redirect(`${A}?flash=${encodeURIComponent(`Utworzono ${created}; błędy: ${errors.join('; ')}`)}&type=error`);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(`Utworzono ${created} transferów`)}`);
  });
}
