// Administrator backup destinations, durable jobs and transactional restore.
import { all } from '../db.mjs';
import { html as h, formatDate } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, form, field, tabs, kvList, progress } from '../ui/components.mjs';
import {
  listServers,
  listJobs,
  listRuns,
  saveServer,
  deleteServer,
  testServer,
  saveJob,
  deleteJob,
  runJob,
  restoreRun,
  previewRestoreRun,
  schedulerTimezone,
} from '../backupcenter.mjs';
import { cancelJob, retryJob, resumeJob, jobView, listJobViews, spawnJobRunner } from '../backups.mjs';

const A = '/admin/backup-center';

function tab(ctx) {
  const value = String(ctx.query.tab || 'servers');
  return ['servers', 'jobs', 'runs', 'operations'].includes(value) ? value : 'servers';
}

function stageLabel(label) {
  return ({
    'Preflight (destination, disk, account)': 'Wstępna kontrola (cel, dysk, konto)',
    'Create archive': 'Tworzenie archiwum', 'Upload to destination': 'Wysyłka do celu',
    'Apply retention': 'Zastosowanie retencji', 'Record run history': 'Zapis historii',
    'Preflight': 'Wstępna kontrola', 'Record backup metadata': 'Zapis metadanych backupu',
  })[label] || label;
}

function statusLabel(status) {
  return ({
    queued: 'w kolejce', running: 'w toku', succeeded: 'zakończone', complete: 'zakończone',
    failed: 'błąd', error: 'błąd', cancelled: 'anulowane', cancelling: 'anulowanie',
    pending: 'oczekuje', ok: 'OK', skipped: 'pominięte',
  })[String(status || '').toLowerCase()] || status || '—';
}

function statusTone(status) {
  if (status === 'complete' || status === 'succeeded' || status === 'ok') return 'ok';
  if (status === 'failed' || status === 'error') return 'danger';
  if (status === 'running' || status === 'queued' || status === 'cancelling') return 'warn';
  return 'muted';
}

function flashFrom(ctx) {
  return ctx.query.flash ? { type: ctx.query.type === 'error' ? 'error' : 'ok', message: String(ctx.query.flash) } : null;
}

async function waitForJob(jobId, timeoutMs = 300000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = jobView(jobId);
    if (!job || job.terminal) return job;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return jobView(jobId);
}

function operationColumns() {
  return [
    { label: 'Zadanie', render: (r) => h`<a href="${A}/operations/${r.id}" class="cell-strong">#${r.id}</a>` },
    { label: 'Status', render: (r) => h`${badge(statusLabel(r.status), statusTone(r.status))}<div class="small muted">${stageLabel(r.stageLabel || r.stage || '')}</div>` },
    { label: 'Postęp', render: (r) => h`<div class="small">${r.progress}% (${r.stagesDone}/${r.stagesTotal})</div>` },
    { label: 'Cel', render: (r) => h`<span class="cell-mono small">${r.target || '—'}</span>` },
    { label: 'Aktualizacja', render: (r) => h`<span class="small muted">${formatDate(r.updated_at, { time: true })}</span>` },
  ];
}

function operationDetail(ctx, job) {
  const result = job.result || {};
  return h`
    ${card(`Zadanie #${job.id}`, h`
      ${kvList([
        ['Rodzaj', job.kind], ['Status', statusLabel(job.status)], ['Etap', stageLabel(job.stageLabel || job.stage || '—')],
        ['Postęp', `${job.progress}% (${job.stagesDone}/${job.stagesTotal} etapów)`],
        ['Aktor', job.actor || '—'], ['Cel', job.target || '—'],
        ['Utworzono', formatDate(job.created_at, { time: true })],
        ['Zakończono', job.finished_at ? formatDate(job.finished_at, { time: true }) : '—'],
        ['Błąd', job.error || '—'],
      ])}
      ${job.cancellable ? h`<div class="row mt-18"><form method="post" action="${A}/operations/${job.id}/cancel" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-danger btn-sm" type="submit" data-confirm="Anulować zadanie? Zostanie zatrzymane w najbliższym bezpiecznym punkcie kontrolnym.">Anuluj</button></form></div>` : ''}
      ${job.retryable ? h`<div class="row mt-18"><form method="post" action="${A}/operations/${job.id}/retry" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-secondary btn-sm" type="submit">Ponów</button></form>${job.resumable ? h`<form method="post" action="${A}/operations/${job.id}/resume" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-primary btn-sm" type="submit">Wznów</button></form>` : ''}</div>` : ''}
    `)}
    ${card('Etapy', h`<div class="stack">${job.stages.map((stage) => h`<div class="service-row"><div style="flex:1"><strong>${stageLabel(stage.label)}</strong><div class="small muted">${stage.detail || ''}</div></div>${badge(statusLabel(stage.status), stage.status === 'complete' || stage.status === 'succeeded' ? 'ok' : stage.status === 'failed' ? 'danger' : stage.status === 'running' ? 'brand' : 'muted')}</div>`)}</div><div class="mt-18">${progress(job.stagesDone, job.stagesTotal || 1, { label: `${job.progress}%` })}</div>`)}
    ${card('Dziennik', job.events.length ? h`<pre class="code-block small">${job.events.map((event) => `[${event.created_at}] ${event.level}: ${event.message}`).join('\n')}</pre>` : '<p class="small muted">Brak wpisów.</p>')}
    ${Object.keys(result).length ? card('Raport per obiekt', h`<pre class="code-block small">${JSON.stringify(result, null, 2)}</pre>`) : ''}
    <div class="row mt-18"><a class="btn btn-primary" href="${A}?tab=operations">Wróć</a><a class="btn btn-ghost" href="${A}/operations/${job.id}/state">JSON</a></div>
    ${['queued', 'running'].includes(job.status) ? h`<meta http-equiv="refresh" content="3">` : ''}
  `;
}

function dryRunPage(ctx, preview) {
  const homes = preview.homes || [];
  return h`
    ${card('Dry-run restore', h`
      ${kvList([
        ['Archiwum', preview.filename],
        ['SHA-256', preview.sha256],
        ['Integralność', preview.integrity?.verified ? 'zgodna z zapisem' : 'brak zapisanego hasha — tylko struktura archiwum'],
        ['Wpisy', String(preview.entries)],
        ['Baza panelu', preview.hasDb ? 'tak (zostanie przywrócona transakcyjnie)' : 'nie'],
        ['Rozmiar', `${(Number(preview.bytes || 0) / 1024 / 1024).toFixed(1)} MB`],
      ])}
      ${preview.expectedSha && preview.sha256 !== preview.expectedSha ? alert('Hash archiwum nie zgadza się z zapisem — restore zostanie odrzucony.', 'error') : ''}
      <p class="small muted mt-12">${preview.note || ''}</p>
    `)}
    ${card('Konflikty i zakres', homes.length ? h`<div class="table-wrap"><table class="data-table"><thead><tr><th>Konto</th><th>Pliki teraz</th><th>Pliki w archiwum</th><th>Nadpisane</th><th>Dodane</th><th>Usunięte</th></tr></thead><tbody>${homes.map((home) => h`<tr><td class="cell-mono">${home.username}</td><td>${home.currentFiles}</td><td>${home.archivedFiles}</td><td>${home.conflicts.overwritten}</td><td>${home.conflicts.added}</td><td>${home.conflicts.removed}</td></tr>`)}</tbody></table></div>` : '<p class="small muted">Archiwum nie zawiera katalogów domowych.</p>')}
    ${card('Przykładowe wpisy', h`<div class="table-wrap"><table class="data-table"><thead><tr><th>Wpis</th></tr></thead><tbody>${(preview.sample || []).map((entry) => h`<tr><td class="cell-mono small">${entry}</td></tr>`)}</tbody></table></div>`)}
    <div class="row mt-18"><a class="btn btn-primary" href="${A}?tab=runs">Wróć</a><form method="post" action="${A}/runs/${preview.runId}/restore" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-danger" type="submit" data-confirm="Przywrócić backup? Zostanie utworzony punkt powrotu, staging, weryfikacja integralności i automatyczny rollback w razie błędu.">Przywróć transakcyjnie</button></form></div>
  `;
}

export function register(router) {
  router.get(A, (ctx) => {
    const current = tab(ctx);
    const users = all("SELECT username FROM users WHERE level IN ('user','reseller') ORDER BY username");
    const servers = listServers();
    const jobs = listJobs();
    const runs = listRuns(60);
    const operations = listJobViews({ kinds: ['backup.job.run', 'backup.create', 'backup.restore.server', 'backup.restore.user'], limit: 40 });
    const editServer = ctx.query.edit && current === 'servers' ? servers.find((x) => String(x.id) === String(ctx.query.edit)) : null;
    const editJob = ctx.query.edit && current === 'jobs' ? jobs.find((x) => String(x.id) === String(ctx.query.edit)) : null;
    const flash = flashFrom(ctx);
    const tz = schedulerTimezone();
    const body = h`
      ${tabs([
        { key: 'servers', label: 'Lokalizacje', count: servers.length },
        { key: 'jobs', label: 'Zadania', count: jobs.length },
        { key: 'runs', label: 'Historia', count: runs.length },
        { key: 'operations', label: 'Operacje', count: operations.length },
      ], current, { base: A })}
      ${flash ? alert(flash.message, flash.type) : ''}
      ${current === 'servers' ? h`
        ${card('Dodaj lokalizację backupu', form([
          field({ name: 'name', label: 'Nazwa', required: true, placeholder: 'S3 lub NAS' }),
          field({ name: 'type', label: 'Typ', type: 'select', options: [
            { value: 'local', label: 'Lokalny katalog' }, { value: 'sftp', label: 'SFTP (curl)' },
            { value: 'ftp', label: 'FTP — niebezpieczny, wymaga wyjątku' }, { value: 's3', label: 'Amazon S3 (AWS CLI)' },
          ] }),
          field({ name: 'host', label: 'Host', placeholder: 'backup.example.com' }),
          field({ name: 'port', label: 'Port', type: 'number' }),
          field({ name: 'path', label: 'Katalog / bucket / prefiks', placeholder: '/backups lub s3://bucket/openadmin', full: true }),
          field({ name: 'username', label: 'Użytkownik / Access Key' }),
          field({ name: 'password', label: 'Hasło / Secret Key', type: 'password' }),
          field({ name: 'key', label: 'Klucz prywatny SSH (SFTP)', type: 'textarea', rows: 4, full: true, help: 'Wklej klucz PEM/OpenSSH. Jest szyfrowany w bazie i używany tylko podczas transferu.' }),
        ], { action: `${A}/servers`, csrf: ctx.csrf, submit: 'Zapisz i przetestuj' }))}
        ${editServer ? card(`Edytuj lokalizację · ${editServer.name}`, form([
          field({ name: 'name', label: 'Nazwa', value: editServer.name, required: true }),
          field({ name: 'type', label: 'Typ', type: 'select', value: editServer.type, options: ['local', 'sftp', 'ftp', 's3'] }),
          field({ name: 'host', label: 'Host', value: editServer.host || '' }),
          field({ name: 'port', label: 'Port', type: 'number', value: editServer.port || '' }),
          field({ name: 'path', label: 'Katalog/bucket', value: editServer.path || '', full: true }),
          field({ name: 'username', label: 'Użytkownik', value: editServer.username || '' }),
          field({ name: 'password', label: 'Nowe hasło (puste = bez zmian)', type: 'password' }),
          field({ name: 'key', label: 'Nowy klucz SSH (puste = bez zmian)', type: 'textarea', rows: 4, full: true, help: 'Klucz jest szyfrowany i usuwany z procesu po transferze.' }),
        ], { action: `${A}/servers/${editServer.id}/update`, csrf: ctx.csrf, submit: 'Zapisz lokalizację' })) : ''}
        ${card('Lokalizacje', table({
          cls: 'responsive-table',
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
        ${alert('SFTP używa curl; hasło jest przekazywane przez chroniony stdin, nie przez argv (SEC-021). Zwykły FTP jest domyślnie zablokowany, bo wysyła poświadczenia i archiwum bez szyfrowania (SEC-024); wyjątek wymaga daty w backup_plain_ftp_until.', 'info')}
      ` : ''}
      ${current === 'jobs' ? h`
        ${card('Nowy job', form([
          field({ name: 'name', label: 'Nazwa', required: true, placeholder: 'Backup nightly' }),
          field({ name: 'scope', label: 'Zakres', type: 'select', options: [{ value: 'server', label: 'Cały serwer' }, { value: 'user', label: 'Jedno konto' }] }),
          field({ name: 'target_user', label: 'Konto (dla zakresu user)', type: 'select', options: [{ value: '', label: '—' }, ...users.map((u) => ({ value: u.username, label: u.username }))] }),
          field({ name: 'server_id', label: 'Lokalizacja', type: 'select', options: [{ value: '', label: 'Tylko lokalnie' }, ...servers.map((s) => ({ value: String(s.id), label: s.name }))] }),
          field({ name: 'schedule', label: 'Harmonogram', type: 'select', options: [
            { value: 'hourly', label: 'Co godzinę' }, { value: 'daily', label: 'Codziennie' }, { value: 'weekly', label: 'Co tydzień' }, { value: 'monthly', label: 'Co miesiąc' },
          ] }),
          field({ name: 'schedule_time', label: 'Godzina (HH:MM, strefa joba)', value: '03:00', placeholder: '03:00' }),
          field({ name: 'timezone', label: 'Strefa czasowa (IANA)', value: tz, placeholder: 'Europe/Warsaw' }),
          field({ name: 'catch_up_minutes', label: 'Catch-up po restarcie (min)', type: 'number', value: 1440, min: 0, max: 10080 }),
          field({ name: 'retention_days', label: 'Retencja (dni)', type: 'number', value: 14, min: 1 }),
        ], { action: `${A}/jobs`, csrf: ctx.csrf, submit: 'Utwórz job' }))}
        ${editJob ? card(`Edytuj job · ${editJob.name}`, form([
          field({ name: 'name', label: 'Nazwa', value: editJob.name, required: true }),
          field({ name: 'scope', label: 'Zakres', type: 'select', value: editJob.scope, options: [{ value: 'server', label: 'serwer' }, { value: 'user', label: 'konto' }] }),
          field({ name: 'target_user', label: 'Konto', type: 'select', value: editJob.target_user || '', options: [{ value: '', label: '—' }, ...users.map((x) => ({ value: x.username, label: x.username }))] }),
          field({ name: 'server_id', label: 'Lokalizacja', type: 'select', value: String(editJob.server_id || ''), options: [{ value: '', label: 'lokalnie' }, ...servers.map((x) => ({ value: String(x.id), label: x.name }))] }),
          field({ name: 'schedule', label: 'Harmonogram', type: 'select', value: editJob.schedule, options: ['hourly', 'daily', 'weekly', 'monthly'] }),
          field({ name: 'schedule_time', label: 'Godzina HH:MM', value: editJob.schedule_time || '03:00' }),
          field({ name: 'timezone', label: 'Strefa czasowa', value: editJob.timezone || tz }),
          field({ name: 'catch_up_minutes', label: 'Catch-up (min)', type: 'number', value: editJob.catch_up_minutes ?? 1440 }),
          field({ name: 'retention_days', label: 'Retencja dni', type: 'number', value: editJob.retention_days }),
        ], { action: `${A}/jobs/${editJob.id}/update`, csrf: ctx.csrf, submit: 'Zapisz job' })) : ''}
        ${card('Joby', table({
          cls: 'responsive-table',
          columns: [
            { label: 'Nazwa', key: 'name' }, { label: 'Zakres', render: (r) => r.scope === 'user' ? `user: ${r.target_user}` : 'serwer' },
            { label: 'Lokalizacja', render: (r) => r.server_name || 'lokalnie' },
            { label: 'Harmonogram', render: (r) => h`${r.schedule} ${r.schedule_time || '03:00'}<div class="small muted">${r.timezone || tz}</div>` },
            { label: 'Następny', render: (r) => r.next_run_at ? formatDate(r.next_run_at, { time: true }) : '—' },
            { label: 'Ostatni', render: (r) => r.last_run_at ? h`${badge(statusLabel(r.last_status || '?'), r.last_status === 'ok' ? 'ok' : 'danger')}<div class="small muted">${formatDate(r.last_run_at, { time: true })}</div>` : '—' },
          ],
          rows: jobs,
          actions: [
            { label: 'Edytuj', href: (r) => `${A}?tab=jobs&edit=${r.id}`, icon: 'edit' },
            { label: 'Uruchom', form: (r) => `${A}/jobs/${r.id}/run`, icon: 'play' },
            { label: 'Usuń', form: (r) => `${A}/jobs/${r.id}/delete`, icon: 'trash', danger: true, confirm: 'Usunąć job?' },
          ],
          empty: 'Brak zadań. Backup lokalny nadal działa codziennie.',
        }), { padded: false })}
        ${alert('Kolejka jest trwała: nextRunAt, lease, catch-up i historia prób są w bazie. Restart panelu ani druga instancja nie resetują rytmu ani nie dublują uruchomień.', 'info')}
      ` : ''}
      ${current === 'runs' ? h`
        ${card('Historia', table({
          cls: 'responsive-table',
          columns: [
            { label: 'Zadanie', render: (r) => r.job_name || '—' }, { label: 'Plik', render: (r) => h`<span class="cell-mono small">${r.filename}</span>` },
            { label: 'Status', render: (r) => badge(statusLabel(r.status), statusTone(r.status)) },
            { label: 'SHA-256', render: (r) => h`<span class="cell-mono small">${r.sha256 ? String(r.sha256).slice(0, 12) : '—'}</span>` },
            { label: 'Rozmiar', render: (r) => `${r.size_mb} MB` }, { label: 'Start', render: (r) => formatDate(r.started_at, { time: true }) },
            { label: 'Restore', render: (r) => r.restored_at ? formatDate(r.restored_at, { time: true }) : '—' },
          ],
          rows: runs,
          empty: 'Brak uruchomień.',
        }), { padded: false })}
        ${card('Przywracanie', h`<p class="small muted">Najpierw <strong>dry-run</strong> — pokaże integralność, zakres i konflikty. Apply tworzy punkt powrotu, rozpakowuje archiwum do staging, weryfikuje manifest i pliki, przełącza katalogi atomowo (rollback przy błędzie) oraz odtwarza bazę panelu w jednej transakcji.</p>
          <div class="stack">${runs.filter((r) => r.status === 'complete').slice(0, 20).map((r) => h`<div class="service-row"><div style="flex:1"><strong>${r.job_name || r.filename}</strong><div class="small muted">${r.filename}${r.sha256 ? ` · sha256 ${String(r.sha256).slice(0, 12)}` : ''}</div></div>
            <form method="post" action="${A}/runs/${r.id}/dry" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-ghost btn-sm" type="submit">Próba</button></form>
            <form method="post" action="${A}/runs/${r.id}/restore" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-danger btn-sm" type="submit" data-confirm="Przywrócić ten backup transakcyjnie? Zostanie wykonany punkt powrotu i automatyczny rollback w razie błędu.">Przywróć</button></form>
          </div>`)}</div>`)}
      ` : ''}
      ${current === 'operations' ? h`
        ${card('Zadania backupu i restore', table({
          cls: 'responsive-table',
          columns: operationColumns(),
          rows: operations,
          empty: 'Brak zadań operacyjnych.',
        }), { padded: false })}
        ${alert('Każdy backup/restore to trwały job: status, etapy, realny postęp, log, lease, cancel/retry/resume i idempotency key. Odświeżenie strony nie przerywa zadania.', 'info')}
      ` : ''}`;
    return page(ctx, { title: 'Centrum backupów', subtitle: 'Lokalizacje, trwałe zadania, historia i transakcyjne przywracanie', body, wide: true });
  });

  router.post(`${A}/servers`, async (ctx) => {
    const r = saveServer(ctx.body, ctx.user.username);
    if (!r.ok) return ctx.redirect(`${A}?tab=servers&flash=${encodeURIComponent(r.error)}&type=error`);
    const server = listServers().find((x) => x.id === r.id);
    const test = server ? testServer(server) : { ok: false, detail: 'missing' };
    return ctx.redirect(`${A}?tab=servers&flash=${encodeURIComponent(test.ok ? `Zapisano; ${test.detail}` : `Zapisano, test nieudany: ${test.detail}`)}&type=${test.ok ? 'ok' : 'error'}`);
  });

  router.post(`${A}/servers/:id/update`, (ctx) => {
    const r = saveServer({ ...ctx.body, id: ctx.params.id }, ctx.user.username);
    return ctx.redirect(`${A}?tab=servers&flash=${encodeURIComponent(r.ok ? 'Lokalizacja zapisana' : r.error)}${r.ok ? '' : '&type=error'}`);
  });

  router.post(`${A}/servers/:id/test`, (ctx) => {
    const server = listServers().find((x) => x.id === Number(ctx.params.id));
    if (!server) return ctx.redirect(`${A}?tab=servers&flash=Nie%20znaleziono&type=error`);
    const test = testServer(server);
    return ctx.redirect(`${A}?tab=servers&flash=${encodeURIComponent(test.detail)}&type=${test.ok ? 'ok' : 'error'}`);
  });

  router.post(`${A}/servers/:id/delete`, (ctx) => { deleteServer(ctx.params.id); return ctx.redirect(`${A}?tab=servers&flash=Usuni%C4%99to`); });

  router.post(`${A}/jobs`, (ctx) => {
    const r = saveJob(ctx.body, ctx.user.username);
    return ctx.redirect(`${A}?tab=jobs&flash=${encodeURIComponent(r.ok ? `Job utworzony; następny: ${r.next_run_at}` : r.error)}${r.ok ? '' : '&type=error'}`);
  });

  router.post(`${A}/jobs/:id/update`, (ctx) => {
    const r = saveJob({ ...ctx.body, id: ctx.params.id }, ctx.user.username);
    return ctx.redirect(`${A}?tab=jobs&flash=${encodeURIComponent(r.ok ? 'Job zapisany' : r.error)}${r.ok ? '' : '&type=error'}`);
  });

  router.post(`${A}/jobs/:id/run`, async (ctx) => {
    const r = runJob(ctx.params.id, { actor: ctx.user.username });
    if (!r.ok) return ctx.redirect(`${A}?tab=jobs&flash=${encodeURIComponent(r.error)}&type=error`);
    try { spawnJobRunner(r.jobId); } catch { /* scheduler will pick it up */ }
    const job = await waitForJob(r.jobId);
    const ok = job?.status === 'succeeded';
    return ctx.redirect(`${A}/operations/${r.jobId}?flash=${encodeURIComponent(ok ? `Backup gotowy: ${job.result?.filename || ''}` : (job?.error || 'Zadanie zakończone bez sukcesu'))}&type=${ok ? 'ok' : 'error'}`);
  });

  router.post(`${A}/jobs/:id/delete`, (ctx) => { deleteJob(ctx.params.id); return ctx.redirect(`${A}?tab=jobs&flash=Usuni%C4%99to`); });

  router.get(`${A}/operations/:id`, (ctx) => {
    const job = jobView(ctx.params.id);
    if (!job) return ctx.redirect(`${A}?tab=operations&flash=${encodeURIComponent('Nie znaleziono zadania')}&type=error`);
    return page(ctx, { title: `Zadanie #${job.id}`, subtitle: stageLabel(job.stageLabel || job.status), body: operationDetail(ctx, job), wide: true });
  });

  router.get(`${A}/operations/:id/state`, (ctx) => {
    const job = jobView(ctx.params.id);
    if (!job) return ctx.json({ ok: false, error: 'Not found' }, 404);
    return ctx.json({ ok: true, job });
  });

  router.post(`${A}/operations/:id/cancel`, (ctx) => {
    const r = cancelJob(ctx.params.id, { actor: ctx.user.username });
    return ctx.redirect(`${A}/operations/${ctx.params.id}?flash=${encodeURIComponent(r.ok ? 'Anulowanie zlecone' : r.error)}&type=${r.ok ? 'ok' : 'error'}`);
  });

  router.post(`${A}/operations/:id/retry`, (ctx) => {
    const r = retryJob(ctx.params.id, { actor: ctx.user.username });
    if (r.ok) kickQueue();
    return ctx.redirect(`${A}/operations/${ctx.params.id}?flash=${encodeURIComponent(r.ok ? 'Zadanie ponowione' : r.error)}&type=${r.ok ? 'ok' : 'error'}`);
  });

  router.post(`${A}/operations/:id/resume`, (ctx) => {
    const r = resumeJob(ctx.params.id, { actor: ctx.user.username });
    if (r.ok) kickQueue();
    return ctx.redirect(`${A}/operations/${ctx.params.id}?flash=${encodeURIComponent(r.ok ? 'Zadanie wznowione' : r.error)}&type=${r.ok ? 'ok' : 'error'}`);
  });

  router.post(`${A}/runs/:id/dry`, (ctx) => {
    const preview = previewRestoreRun(ctx.params.id);
    if (!preview.ok) return ctx.redirect(`${A}?tab=runs&flash=${encodeURIComponent(preview.error)}&type=error`);
    return page(ctx, { title: 'Próbne przywracanie', subtitle: 'Walidacja integralności, zakresu i konfliktów', body: dryRunPage(ctx, preview), wide: true });
  });

  router.post(`${A}/runs/:id/restore`, async (ctx) => {
    const r = restoreRun(ctx.params.id, { dryRun: false, actor: ctx.user.username, wait: false });
    if (!r.ok) return ctx.redirect(`${A}?tab=runs&flash=${encodeURIComponent(r.error)}&type=error`);
    try { spawnJobRunner(r.jobId); } catch { /* scheduler will pick it up */ }
    const job = await waitForJob(r.jobId);
    const ok = job?.status === 'succeeded';
    return ctx.redirect(`${A}/operations/${r.jobId}?flash=${encodeURIComponent(ok ? 'Backup przywrócony; punkt powrotu zapisany' : (job?.error || 'Restore nie powiódł się'))}&type=${ok ? 'ok' : 'error'}`);
  });
}

function kickQueue() {
  import('../scheduler.mjs')
    .then((scheduler) => scheduler.schedulerTick({ limit: 1 }))
    .catch(() => {});
}
