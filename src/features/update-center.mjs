// Administrator panel/OS update center.
import { html as h } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, tabs, kvList, progress } from '../ui/components.mjs';
import {
  checkPanel,
  osCheck,
  stagePanelUpdate,
  applyOsUpdates,
  updateInfo,
  buildInfo,
  diagnosticsText,
  updateChannel,
} from '../updates.mjs';
import { cancelJob, retryJob, resumeJob, jobView } from '../backups.mjs';

const A = '/admin/updates-center';

function flashFrom(ctx) {
  return ctx.query.flash ? { type: ctx.query.type === 'error' ? 'error' : 'ok', message: String(ctx.query.flash) } : null;
}

function statusBadge(status) {
  const tone = status === 'succeeded' ? 'ok' : status === 'failed' ? 'danger' : status === 'running' ? 'brand' : status === 'interrupted' ? 'warn' : 'muted';
  return badge(status, tone);
}

function jobColumns() {
  return [
    { label: 'Job', render: (r) => h`<a href="${A}/jobs/${r.id}" class="cell-strong">#${r.id}</a><span class="cell-sub">${r.kind}</span>` },
    { label: 'Status', render: (r) => h`${statusBadge(r.status)}<div class="small muted">${r.stageLabel || r.stage || ''}</div>` },
    { label: 'Postęp', render: (r) => h`<div class="small">${r.progress}% (${r.stagesDone}/${r.stagesTotal})</div>` },
    { label: 'Wersja', render: (r) => h`<span class="cell-mono small">${r.payload?.version || r.payload?.channel || '—'}</span>` },
    { label: 'Start', render: (r) => h`<span class="small muted">${r.created_at || ''}</span>` },
  ];
}

function jobsCard(jobs) {
  return card('Zadania aktualizacji', table({
    columns: jobColumns(),
    rows: jobs,
    empty: 'Brak zadań aktualizacji. Uruchom dry-run lub zastosuj podpisane wydanie.',
  }), { padded: false });
}

function buildCard(info) {
  const build = info.build || {};
  const assets = build.assets || {};
  const schema = build.schema || {};
  const keys = build.updateKeys || {};
  return card('Diagnostyka wdrożonego buildu', h`
    ${kvList([
      ['Wersja panelu', build.version || info.current],
      ['Build ID', build.buildId || '—'],
      ['Commit', build.commit || 'nieznany'],
      ['Data wdrożenia', build.deployedAt || '—'],
      ['Kanał aktualizacji', build.channel || updateChannel()],
      ['Schemat DB', `v${schema.version || '?'} · ${schema.tables || 0} tabel · ${schema.hash || '?'}`],
      ['Hash assetów', `${assets.sha256 ? String(assets.sha256).slice(0, 20) : '—'} (${assets.files || 0} plików)`],
      ['Node / platforma', `${build.node || ''} · ${build.platform || ''}`],
    ])}
    <div class="row mt-18">
      <button type="button" class="btn btn-ghost btn-sm" id="copy-diagnostics">Kopiuj diagnostykę</button>
      <span class="small muted" id="copy-diagnostics-status"></span>
    </div>
    <pre class="code-block small mt-12" id="diagnostics-text">${diagnosticsText()}</pre>
    <script>
      (function () {
        var button = document.getElementById('copy-diagnostics');
        var status = document.getElementById('copy-diagnostics-status');
        var text = document.getElementById('diagnostics-text');
        if (!button || !text) return;
        button.addEventListener('click', function () {
          var value = text.textContent || '';
          var done = function () { if (status) status.textContent = 'Skopiowano do schowka'; };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(value).then(done, function () { fallback(value); });
          } else { fallback(value); }
          function fallback(v) {
            var area = document.createElement('textarea');
            area.value = v; area.setAttribute('readonly', 'readonly');
            area.className = 'offscreen-textarea';
            document.body.appendChild(area); area.select();
            try { document.execCommand('copy'); done(); } catch (e) { if (status) status.textContent = 'Kopiowanie niedostępne'; }
            document.body.removeChild(area);
          }
        });
      })();
    </script>
  `);
}

function keysCard() {
  const build = buildInfo();
  const keys = build.updateKeys || {};
  return card('Zaufane klucze aktualizacji', h`
    ${kvList([
      ['Pinned keys', keys.configured ? `${keys.count} (${(keys.keyIds || []).join(', ')})` : 'brak'],
      ['Źródło klucza', keys.source || 'none'],
      ['Tryb unsigned', keys.allowUnsigned ? 'DOZWOLONY (ryzyko)' : 'zabroniony (domyślnie)'],
    ])}
    ${keys.errors?.length ? alert(`Błędy kluczy: ${keys.errors.join('; ')}`, 'warn') : ''}
    ${keys.configured ? '' : alert('Brak przypiętego klucza publicznego. Aktualizacje są celowo blokowane do czasu ustawienia OA_UPDATE_PUBLIC_KEY lub klucza w konfiguracji panelu — klucz musi pochodzić z zaufanego kanału, nie z serwera wydań (SEC-005).', 'warn')}
    <p class="small muted mt-12">Klucz Ed25519 ustaw jako <code>OA_UPDATE_PUBLIC_KEY=keyId=base64</code> w jednostce systemd albo <code>update_public_key</code> w ustawieniach panelu. Manifest bez podpisu jest odrzucany, chyba że administrator świadomie ustawi <code>OA_UPDATE_ALLOW_UNSIGNED=1</code>.</p>
  `);
}

function verificationCard(result) {
  const checks = result?.compatibility?.checks || [];
  return card('Weryfikacja wydania', h`
    ${kvList([
      ['Wersja zainstalowana', result.current || '—'],
      ['Wersja w manifeście', result.latest || result.manifest?.version || '—'],
      ['SHA-256 paczki', result.manifest?.sha256 || '—'],
      ['Podpis', result.verification?.ok ? `Ed25519 (${result.verification.keyId || 'pinned'})` : (result.verification?.unsigned ? 'brak — tryb wymuszony' : 'niezweryfikowany')],
      ['Pliki w manifeście', result.manifest?.files || 0],
      ['Kanał', result.channel || updateChannel()],
    ])}
    ${(result.compatibility?.errors || []).length ? alert(result.compatibility.errors.join('; '), 'error') : ''}
    ${checks.length ? table({
      columns: [{ label: 'Kontrola', key: 'id' }, { label: 'Status', render: (row) => badge(row.status, row.status === 'ok' ? 'ok' : row.status === 'warn' ? 'warn' : 'danger') }, { label: 'Szczegóły', key: 'detail' }],
      rows: checks,
    }) : ''}
    ${result.verified === false ? alert('Wydanie nie zostało w pełni zweryfikowane.', 'error') : ''}
    <div class="row mt-18"><a class="btn btn-primary" href="${A}">Wróć</a></div>
  `);
}

function jobDetail(ctx, job) {
  const result = job.result || {};
  const payload = job.payload || {};
  return h`
    ${card(`Zadanie aktualizacji #${job.id}`, h`
      ${kvList([
        ['Status', job.status],
        ['Etap', job.stageLabel || job.stage || '—'],
        ['Postęp', `${job.progress}% (${job.stagesDone}/${job.stagesTotal} etapów)`],
        ['Wersja', payload.version || job.target || '—'],
        ['Utworzono', job.created_at],
        ['Zakończono', job.finished_at || '—'],
        ['Błąd', job.error || '—'],
      ])}
      ${['queued', 'running', 'cancelling'].includes(job.status) ? h`<div class="row mt-18">
        <form method="post" action="${A}/jobs/${job.id}/cancel" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-danger btn-sm" type="submit" data-confirm="Anulować zadanie? Operacja zakończy się po bezpiecznym punkcie kontrolnym.">Anuluj</button></form>
      </div>` : ''}
      ${job.retryable ? h`<div class="row mt-18">
        <form method="post" action="${A}/jobs/${job.id}/retry" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-secondary btn-sm" type="submit">Ponów</button></form>
        ${job.resumable ? h`<form method="post" action="${A}/jobs/${job.id}/resume" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-primary btn-sm" type="submit">Wznów od ostatniego etapu</button></form>` : ''}
      </div>` : ''}
    `)}
    ${card('Etapy', h`<div class="stack">${job.stages.map((stage) => h`
      <div class="service-row"><div class="u-s14"><strong>${stage.label}</strong><div class="small muted">${stage.detail || ''}</div></div>
      ${badge(stage.status, stage.status === 'complete' ? 'ok' : stage.status === 'failed' ? 'danger' : stage.status === 'running' ? 'brand' : 'muted')}
      </div>`)}</div><div class="mt-18">${progress(job.stagesDone, job.stagesTotal || 1, { label: `${job.progress}%` })}</div>`)}
    ${card('Log', job.events.length ? h`<pre class="code-block small">${job.events.map((event) => `[${event.created_at}] ${event.level}: ${event.message}`).join('\n')}</pre>` : '<p class="small muted">Brak wpisów.</p>')}
    ${Object.keys(result).length ? card('Raport', h`<pre class="code-block small">${JSON.stringify(result, null, 2)}</pre>`) : ''}
    <div class="row mt-18"><a class="btn btn-primary" href="${A}">Wróć</a></div>
    ${['queued', 'running'].includes(job.status) ? h`<meta http-equiv="refresh" content="4">` : ''}
  `;
}

export function register(router) {
  router.get(A, (ctx) => {
    const tab = ['panel', 'os'].includes(String(ctx.query.tab)) ? String(ctx.query.tab) : 'panel';
    const info = updateInfo();
    const flash = flashFrom(ctx);
    const body = h`
      ${tabs([{ key: 'panel', label: 'Panel' }, { key: 'os', label: 'Pakiety OS' }], tab, { base: A })}
      ${flash ? alert(flash.message, flash.type) : ''}
      ${tab === 'panel' ? h`
        ${info.pending?.length ? alert(`Aktualizacja oczekuje na finalizację po restarcie: ${info.pending.map((entry) => `job #${entry.jobId} (${entry.phase})`).join(', ')}.`, 'warn') : ''}
        ${buildCard(info)}
        ${keysCard()}
        ${card('Aktualizacja panelu', h`
          <p class="small muted">Cykl: podpisany manifest → SHA-256 → zgodność → backup plików i bazy → staging → zależności → migracje → restart → smoke test → commit/rollback. Restart jest wykonywany automatycznie przez usługę systemd albo pomocnik procesu; nie ma potrzeby ręcznego <code>systemctl restart</code>.</p>
          <div class="row mt-18">
            <form method="post" action="${A}/check" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-primary" type="submit">Sprawdź aktualizacje</button></form>
            <form method="post" action="${A}/panel/dry" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-secondary" type="submit">Dry-run (weryfikacja manifestu)</button></form>
          </div>
          ${info.jobs?.length ? h`<div class="row mt-18"><a class="btn btn-ghost btn-sm" href="${A}?tab=panel">Odśwież listę zadań</a></div>` : ''}
        `)}
        ${jobsCard(info.jobs || [])}
        ${card('Historia', table({
          columns: [
            { label: 'Data', key: 'created_at' },
            { label: 'Wersja', render: (row) => row.payload?.version || '—' },
            { label: 'Status', render: (row) => statusBadge(row.status) },
            { label: 'Szczegóły', render: (row) => h`<a href="${A}/jobs/${row.id}">#${row.id}</a>` },
          ],
          rows: (info.jobs || []).filter((row) => row.terminal),
          empty: 'Brak zakończonych aktualizacji.',
        }), { padded: false })}
      ` : ''}
      ${tab === 'os' ? h`
        ${card('Pakiety systemowe', h`<form method="post" action="${A}/os/dry" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-secondary" type="submit">Sprawdź (dry-run)</button></form>
          <p class="small muted mt-12">Używa <code>apt-get -s upgrade</code>; aktualizacja realna wymaga potwierdzenia i uprawnień roota.</p>`)}
        ${info.lastOs ? kvList([['Ostatnia aktualizacja OS', info.lastOs]]) : ''}
      ` : ''}`;
    return page(ctx, { title: 'Update Center', subtitle: 'Podpisane aktualizacje panelu i pakiety systemowe', body, wide: true });
  });

  router.post(`${A}/check`, async (ctx) => {
    const r = await checkPanel();
    if (!r.ok) return ctx.redirect(`${A}?flash=${encodeURIComponent(r.error)}&type=error`);
    const body = h`
      ${card('Wynik sprawdzania', h`${kvList([
        ['Zainstalowana', r.current], ['Najnowsza', r.latest], ['Kanał', r.channel],
        ['Aktualizacja', r.update ? 'dostępna' : 'brak'],
        ['Podpisany manifest', r.manifest ? 'tak' : 'nie'],
        ['Gotowa do instalacji', r.canApply ? 'tak' : 'nie'],
        ['Blokada', r.blocked || '—'],
      ])}
      ${r.manifestError ? alert(r.manifestError, 'error') : ''}
      ${r.verification && !r.verification.ok ? alert(r.verification.error, 'error') : ''}
      ${r.compatibility?.errors?.length ? alert(r.compatibility.errors.join('; '), 'error') : ''}
      ${r.notes ? h`<pre class="code-block small mt-12">${String(r.notes).slice(0, 4000)}</pre>` : ''}
      <div class="row mt-18"><a class="btn btn-primary" href="${A}">Wróć</a>${r.canApply && r.update ? h`<form method="post" action="${A}/panel/apply" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-danger" type="submit" data-confirm="Zastosować podpisane wydanie ${r.latest}? Zostanie wykonany backup, restart i smoke test; przy błędzie nastąpi automatyczny rollback.">Zastosuj ${r.latest}</button></form>` : ''}</div>`)}`;
    return page(ctx, { title: 'Aktualizacje panelu', subtitle: r.latest, body });
  });

  router.post(`${A}/panel/dry`, async (ctx) => {
    const r = await stagePanelUpdate({ apply: false, actor: ctx.user.username });
    if (!r.ok) return ctx.redirect(`${A}?flash=${encodeURIComponent(r.error)}&type=error`);
    return page(ctx, { title: 'Aktualizacja panelu', subtitle: 'Dry-run — podpis i zgodność', body: verificationCard(r) });
  });

  router.post(`${A}/panel/apply`, async (ctx) => {
    const r = await stagePanelUpdate({ apply: true, actor: ctx.user.username });
    if (!r.ok) return ctx.redirect(`${A}?flash=${encodeURIComponent(r.error)}&type=error`);
    return ctx.redirect(`${A}/jobs/${r.jobId}?flash=${encodeURIComponent('Aktualizacja uruchomiona jako zadanie trwałe; restart nastąpi automatycznie.')}`);
  });

  router.get(`${A}/jobs/:id`, (ctx) => {
    const job = jobView(ctx.params.id);
    if (!job || job.kind !== 'update.panel') return ctx.redirect(`${A}?flash=${encodeURIComponent('Nie znaleziono zadania')}&type=error`);
    return page(ctx, { title: `Aktualizacja #${job.id}`, subtitle: job.stageLabel || job.status, body: jobDetail(ctx, job), wide: true });
  });

  router.get(`${A}/jobs/:id/state`, (ctx) => {
    const job = jobView(ctx.params.id);
    if (!job || job.kind !== 'update.panel') return ctx.json({ ok: false, error: 'Not found' }, 404);
    return ctx.json({ ok: true, job });
  });

  router.post(`${A}/jobs/:id/cancel`, (ctx) => {
    const r = cancelJob(ctx.params.id, { actor: ctx.user.username });
    return ctx.redirect(`${A}/jobs/${ctx.params.id}?flash=${encodeURIComponent(r.ok ? 'Anulowanie zlecone' : r.error)}&type=${r.ok ? 'ok' : 'error'}`);
  });

  router.post(`${A}/jobs/:id/retry`, (ctx) => {
    const r = retryJob(ctx.params.id, { actor: ctx.user.username });
    if (r.ok) stageRunUpdate(ctx.params.id);
    return ctx.redirect(`${A}/jobs/${ctx.params.id}?flash=${encodeURIComponent(r.ok ? 'Zadanie ponowione' : r.error)}&type=${r.ok ? 'ok' : 'error'}`);
  });

  router.post(`${A}/jobs/:id/resume`, (ctx) => {
    const r = resumeJob(ctx.params.id, { actor: ctx.user.username });
    if (r.ok) stageRunUpdate(ctx.params.id);
    return ctx.redirect(`${A}/jobs/${ctx.params.id}?flash=${encodeURIComponent(r.ok ? 'Zadanie wznowione' : r.error)}&type=${r.ok ? 'ok' : 'error'}`);
  });

  router.post(`${A}/os/dry`, (ctx) => {
    const r = applyOsUpdates({ apply: false, actor: ctx.user.username });
    const body = h`${card('Pakiety do aktualizacji', table({
      columns: [{ label: 'Pakiet', key: 'name' }, { label: 'Z', key: 'from' }, { label: 'Do', key: 'to' }],
      rows: r.packages || [],
      empty: r.simulated ? 'Sandbox — brak pakietów OS.' : 'Brak aktualizacji.',
    }), { padded: false })}
      ${r.packages?.length ? h`<form method="post" action="${A}/os/apply" class="mt-18"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-danger" type="submit" data-confirm="Zaktualizować pakiety OS?">Zainstaluj aktualizacje</button></form>` : ''}
      <div class="row mt-18"><a class="btn btn-primary" href="${A}?tab=os">Wróć</a></div>`;
    return page(ctx, { title: 'Aktualizacje OS', subtitle: 'Dry-run', body });
  });

  router.post(`${A}/os/apply`, (ctx) => {
    const r = applyOsUpdates({ apply: true, actor: ctx.user.username });
    return ctx.redirect(`${A}?tab=os&flash=${encodeURIComponent(r.ok ? `Zainstalowano ${r.count} pakietów` : r.error || r.output)}&type=${r.ok ? 'ok' : 'error'}`);
  });
}

function stageRunUpdate(jobId) {
  // Retry/resume moves the job back to queued; the scheduler is the durable
  // executor, so no in-request long polling is needed here.
  void jobId;
  import('../scheduler.mjs')
    .then((scheduler) => scheduler.schedulerTick({ limit: 1 }))
    .catch(() => {});
}
