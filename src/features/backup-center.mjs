// Administrator backup destinations, jobs and restore.
import { all } from '../db.mjs';
import { html as h, formatDate } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, emptyState, form, field, tabs, kvList } from '../ui/components.mjs';
import { listServers, listJobs, listRuns, saveServer, deleteServer, testServer, saveJob, deleteJob, runJob, restoreRun } from '../backupcenter.mjs';

const A = '/admin/backup-center';

function tab(ctx) {
  const t = String(ctx.query.tab || 'servers');
  return ['servers', 'jobs', 'runs'].includes(t) ? t : 'servers';
}

export function register(router) {
  router.get(A, (ctx) => {
    const t = tab(ctx);
    const users = all("SELECT username FROM users WHERE level IN ('user','reseller') ORDER BY username");
    const servers = listServers();
    const jobs = listJobs();
    const runs = listRuns(60);
    const editServer = ctx.query.edit && t === 'servers' ? servers.find((x) => String(x.id) === String(ctx.query.edit)) : null;
    const editJob = ctx.query.edit && t === 'jobs' ? jobs.find((x) => String(x.id) === String(ctx.query.edit)) : null;
    const body = h`
      ${tabs([
        { key: 'servers', label: 'Serwery backup', count: servers.length },
        { key: 'jobs', label: 'Joby', count: jobs.length },
        { key: 'runs', label: 'Historia i restore', count: runs.length },
      ], t, { base: A })}
      ${t === 'servers' ? h`
        ${card('Dodaj lokalizację backupu', form([
          field({ name: 'name', label: 'Nazwa', required: true, placeholder: 'S3 lub NAS' }),
          field({ name: 'type', label: 'Typ', type: 'select', options: [
            { value: 'local', label: 'Lokalny katalog' }, { value: 'sftp', label: 'SFTP (curl)' }, { value: 'ftp', label: 'FTP/FTPS (curl)' }, { value: 's3', label: 'Amazon S3 (AWS CLI)' },
          ] }),
          field({ name: 'host', label: 'Host', placeholder: 'backup.example.com' }),
          field({ name: 'port', label: 'Port', type: 'number' }),
          field({ name: 'path', label: 'Katalog / bucket / prefiks', placeholder: '/backups lub s3://bucket/openadmin', full: true }),
          field({ name: 'username', label: 'Użytkownik / Access Key' }),
          field({ name: 'password', label: 'Hasło / Secret Key', type: 'password' }),
        ], { action: `${A}/servers`, csrf: ctx.csrf, submit: 'Zapisz i przetestuj' }))}
        ${editServer ? card(`Edytuj lokalizację · ${editServer.name}`, form([
          field({ name: 'name', label: 'Nazwa', value: editServer.name, required: true }),
          field({ name: 'type', label: 'Typ', type: 'select', value: editServer.type, options: ['local', 'sftp', 'ftp', 's3'] }),
          field({ name: 'host', label: 'Host', value: editServer.host || '' }),
          field({ name: 'port', label: 'Port', type: 'number', value: editServer.port || '' }),
          field({ name: 'path', label: 'Katalog/bucket', value: editServer.path || '', full: true }),
          field({ name: 'username', label: 'Użytkownik', value: editServer.username || '' }),
          field({ name: 'password', label: 'Nowe hasło (puste = bez zmian)', type: 'password' }),
        ], { action: `${A}/servers/${editServer.id}/update`, csrf: ctx.csrf, submit: 'Zapisz lokalizację' })) : ''}
        ${card('Lokalizacje', table({
          columns: [
            { label: 'Nazwa', key: 'name' }, { label: 'Typ', key: 'type' },
            { label: 'Host', render: (r) => h`<span class="cell-mono small">${r.host || r.path || '—'}</span>` },
            { label: 'Test', render: (r) => r.last_test_at ? badge(r.last_test_ok ? 'OK' : 'błąd', r.last_test_ok ? 'ok' : 'danger') : badge('brak', 'muted') },
          ],
          rows: servers,
          actions: [
            { label: 'Edytuj', href: (r) => `${A}?tab=servers&edit=${r.id}`, icon: 'edit' },
            { label: 'Test', form: (r) => `${A}/servers/${r.id}/test`, icon: 'check' },
            { label: 'Usuń', form: (r) => `${A}/servers/${r.id}/delete`, icon: 'trash', danger: true, confirm: 'Usunąć lokalizację?' },
          ],
          empty: 'Brak zdalnych lokalizacji — backup lokalny nadal działa.',
        }), { padded: false })}
        ${alert('SFTP/FTP wymaga zainstalowanego curl. S3 wymaga AWS CLI i kluczy. Panel pokaże dokładny błąd, zamiast udawać sukces.', 'info')}
      ` : ''}
      ${t === 'jobs' ? h`
        ${card('Nowy job', form([
          field({ name: 'name', label: 'Nazwa', required: true, placeholder: 'Backup nightly' }),
          field({ name: 'scope', label: 'Zakres', type: 'select', options: [{ value: 'server', label: 'Cały serwer' }, { value: 'user', label: 'Jedno konto' }] }),
          field({ name: 'target_user', label: 'Konto (dla zakresu user)', type: 'select', options: [{ value: '', label: '—' }, ...users.map((u) => ({ value: u.username, label: u.username }))] }),
          field({ name: 'server_id', label: 'Lokalizacja', type: 'select', options: [{ value: '', label: 'Tylko lokalnie' }, ...servers.map((s) => ({ value: String(s.id), label: s.name }))] }),
          field({ name: 'schedule', label: 'Harmonogram', type: 'select', options: [
            { value: 'hourly', label: 'Co godzinę' }, { value: 'daily', label: 'Codziennie' }, { value: 'weekly', label: 'Co tydzień' }, { value: 'monthly', label: 'Co miesiąc' },
          ] }),
          field({ name: 'retention_days', label: 'Retencja (dni)', type: 'number', value: 14, min: 1 }),
        ], { action: `${A}/jobs`, csrf: ctx.csrf, submit: 'Utwórz job' }))}
        ${editJob ? card(`Edytuj job · ${editJob.name}`, form([
          field({ name: 'name', label: 'Nazwa', value: editJob.name, required: true }),
          field({ name: 'scope', label: 'Zakres', type: 'select', value: editJob.scope, options: [{ value: 'server', label: 'serwer' }, { value: 'user', label: 'konto' }] }),
          field({ name: 'target_user', label: 'Konto', type: 'select', value: editJob.target_user || '', options: [{ value: '', label: '—' }, ...users.map((u) => ({ value: u.username, label: u.username }))] }),
          field({ name: 'server_id', label: 'Lokalizacja', type: 'select', value: String(editJob.server_id || ''), options: [{ value: '', label: 'lokalnie' }, ...servers.map((x) => ({ value: String(x.id), label: x.name }))] }),
          field({ name: 'schedule', label: 'Harmonogram', type: 'select', value: editJob.schedule, options: ['hourly', 'daily', 'weekly', 'monthly'] }),
          field({ name: 'retention_days', label: 'Retencja dni', type: 'number', value: editJob.retention_days }),
        ], { action: `${A}/jobs/${editJob.id}/update`, csrf: ctx.csrf, submit: 'Zapisz job' })) : ''}
        ${card('Joby', table({
          columns: [
            { label: 'Nazwa', key: 'name' }, { label: 'Zakres', render: (r) => r.scope === 'user' ? `user: ${r.target_user}` : 'serwer' },
            { label: 'Lokalizacja', render: (r) => r.server_name || 'lokalnie' }, { label: 'Harmonogram', key: 'schedule' },
            { label: 'Ostatni', render: (r) => r.last_run_at ? h`${badge(r.last_status || '?', r.last_status === 'ok' ? 'ok' : 'danger')}<div class="small muted">${formatDate(r.last_run_at, { time: true })}</div>` : '—' },
          ],
          rows: jobs,
          actions: [
            { label: 'Edytuj', href: (r) => `${A}?tab=jobs&edit=${r.id}`, icon: 'edit' },
            { label: 'Uruchom', form: (r) => `${A}/jobs/${r.id}/run`, icon: 'play' },
            { label: 'Usuń', form: (r) => `${A}/jobs/${r.id}/delete`, icon: 'trash', danger: true, confirm: 'Usunąć job?' },
          ],
          empty: 'Brak jobów. Backup lokalny nadal działa codziennie.',
        }), { padded: false })}
      ` : ''}
      ${t === 'runs' ? h`
        ${card('Historia', table({
          columns: [
            { label: 'Job', render: (r) => r.job_name || '—' }, { label: 'Plik', render: (r) => h`<span class="cell-mono small">${r.filename}</span>` },
            { label: 'Status', render: (r) => badge(r.status, r.status === 'complete' ? 'ok' : r.status === 'failed' ? 'danger' : 'warn') },
            { label: 'Rozmiar', render: (r) => `${r.size_mb} MB` }, { label: 'Start', render: (r) => formatDate(r.started_at, { time: true }) },
          ],
          rows: runs,
          empty: 'Brak uruchomień.',
        }), { padded: false })}
        ${card('Przywracanie', h`<p class="small muted">Najpierw uruchom <strong>dry-run</strong> — sprawdzi archiwum i pokaże zawartość. Przywrócenie tworzy kopię pre-restore, nadpisuje pliki domów i odtwarza bazę panelu (poza sesjami).</p>
          <div class="stack">${runs.filter((r) => r.status === 'complete').slice(0, 20).map((r) => h`<div class="service-row"><div style="flex:1"><strong>${r.job_name || r.filename}</strong><div class="small muted">${r.filename}</div></div>
            <form method="post" action="${A}/runs/${r.id}/dry" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-ghost btn-sm" type="submit">Dry-run</button></form>
            <form method="post" action="${A}/runs/${r.id}/restore" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-danger btn-sm" type="submit" onclick="return confirm('Przywrócić ten backup? Zostanie wykonana kopia pre-restore.')">Przywróć</button></form>
          </div>`)}</div>`)}
      ` : ''}`;
    return page(ctx, { title: 'Backup Center', subtitle: 'Lokalizacje, joby, historia i restore', body, wide: true });
  });

  router.post(`${A}/servers`, async (ctx) => {
    const r = saveServer(ctx.body, ctx.user.username);
    if (!r.ok) return ctx.redirect(`${A}?tab=servers&flash=${encodeURIComponent(r.error)}&type=error`);
    const s = listServers().find((x) => x.id === r.id);
    const t = await testServer(s);
    const { run } = await import('../db.mjs');
    run('UPDATE backup_servers SET last_test_at=?, last_test_ok=?, last_test_output=? WHERE id=?', new Date().toISOString(), t.ok ? 1 : 0, t.detail, r.id);
    return ctx.redirect(`${A}?tab=servers&flash=${encodeURIComponent(t.ok ? `Zapisano; ${t.detail}` : `Zapisano, test nieudany: ${t.detail}`)}&type=${t.ok ? 'ok' : 'error'}`);
  });
  router.post(`${A}/servers/:id/update`, async (ctx) => {
    const r = saveServer({ ...ctx.body, id: ctx.params.id }, ctx.user.username);
    return ctx.redirect(`${A}?tab=servers&flash=${encodeURIComponent(r.ok ? 'Lokalizacja zapisana' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/servers/:id/test`, async (ctx) => {
    const s = listServers().find((x) => x.id === Number(ctx.params.id));
    if (!s) return ctx.redirect(`${A}?tab=servers&flash=Nie%20znaleziono&type=error`);
    const t = await testServer(s);
    const { run } = await import('../db.mjs');
    run('UPDATE backup_servers SET last_test_at=?, last_test_ok=?, last_test_output=? WHERE id=?', new Date().toISOString(), t.ok ? 1 : 0, t.detail, s.id);
    return ctx.redirect(`${A}?tab=servers&flash=${encodeURIComponent(t.detail)}&type=${t.ok ? 'ok' : 'error'}`);
  });
  router.post(`${A}/servers/:id/delete`, (ctx) => { deleteServer(ctx.params.id); return ctx.redirect(`${A}?tab=servers&flash=Usuni%C4%99to`); });
  router.post(`${A}/jobs`, (ctx) => {
    const r = saveJob(ctx.body, ctx.user.username);
    return ctx.redirect(`${A}?tab=jobs&flash=${encodeURIComponent(r.ok ? 'Job utworzony' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/jobs/:id/update`, (ctx) => {
    const r = saveJob({ ...ctx.body, id: ctx.params.id }, ctx.user.username);
    return ctx.redirect(`${A}?tab=jobs&flash=${encodeURIComponent(r.ok ? 'Job zapisany' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/jobs/:id/run`, (ctx) => {
    const r = runJob(ctx.params.id, { actor: ctx.user.username });
    return ctx.redirect(`${A}?tab=runs&flash=${encodeURIComponent(r.ok ? `Backup gotowy: ${r.filename}` : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/jobs/:id/delete`, (ctx) => { deleteJob(ctx.params.id); return ctx.redirect(`${A}?tab=jobs&flash=Usuni%C4%99to`); });
  router.post(`${A}/runs/:id/dry`, (ctx) => {
    const r = restoreRun(ctx.params.id, { dryRun: true, actor: ctx.user.username });
    if (!r.ok) return ctx.redirect(`${A}?tab=runs&flash=${encodeURIComponent(r.error)}&type=error`);
    const body = h`${card('Dry-run restore', h`
      ${kvList([['Archiwum', 'OK'], ['Wpisy', String(r.entries)], ['Baza panelu', r.hasDb ? 'tak' : 'nie']])}
      <p class="small muted mt-12">Nie zmieniono żadnych plików.</p>
      <div class="table-wrap mt-12"><table class="data-table"><thead><tr><th>Wpis</th></tr></thead><tbody>${r.sample.map((x) => h`<tr><td class="cell-mono small">${x}</td></tr>`)}</tbody></table></div>
      <div class="row mt-18"><a class="btn btn-primary" href="${A}?tab=runs">Wróć</a></div>`)}`;
    return page(ctx, { title: 'Dry-run backupu', subtitle: 'Walidacja archiwum', body });
  });
  router.post(`${A}/runs/:id/restore`, (ctx) => {
    const r = restoreRun(ctx.params.id, { dryRun: false, actor: ctx.user.username });
    return ctx.redirect(`${A}?tab=runs&flash=${encodeURIComponent(r.ok ? 'Backup przywrócony; kopia pre-restore zapisana' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
}
