// Administrator automation engine: overview, job controls, settings and logs.
import { html as h, formatDate, timeAgo } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, form, field, statCard, btn } from '../ui/components.mjs';
import { t } from '../i18n.mjs';
import {
  automationStatus, updateAutomationJob, toggleAutomationJob, saveAutomationSettings,
  runAutomationJob, clearAutomationFailures, formatInterval,
} from '../automation.mjs';

const A = '/admin/automation';
const L = (ctx, text) => t(ctx.user?.language || 'pl', text);
const JOB_LABEL_PL = {
  'health.check': 'Kontrola stanu', 'mail.queue': 'Kontrola kolejki poczty', 'disk.check': 'Kontrola zajętości dysku',
  'backup.daily': 'Dzienny backup serwera', 'cleanup.tmp': 'Czyszczenie temp panelu', 'ssl.renew': 'Odnowienie SSL',
  'backup.prune': 'Retencja backupów',
};
const JOB_PL = {
  'health.check': 'Sprawdza stan panelu, usług, poczty i aplikacji.',
  'mail.queue': 'Liczy kolejkę Exim/panelową; ponawianie jest opcjonalne.',
  'disk.check': 'Mierzy zajętość panelu i magazynów, ostrzega powyżej progu.',
  'backup.daily': 'Tworzy jedną kopię serwera dziennie.',
  'cleanup.tmp': 'Usuwa stare pliki staging/cache panelu; nie dotyka katalogów domowych.',
  'ssl.renew': 'Odnawia certyfikaty wygasające w ciągu 30 dni.',
  'backup.prune': 'Usuwa kopie po okresie retencji.',
};

function statusBadge(status, pl = true) {
  const map = {
    ok: ['ok', 'OK'],
    warn: ['warn', pl ? 'Ostrzeżenie' : 'Warning'],
    error: ['danger', pl ? 'Niepowodzenie' : 'Failed'],
    skipped: ['muted', pl ? 'Pominięte' : 'Skipped'],
    unavailable: ['warn', pl ? 'Niedostępne' : 'Unavailable'],
    running: ['brand', pl ? 'W toku' : 'Running'],
    pending: ['muted', pl ? 'Oczekuje' : 'Pending'],
    critical: ['danger', pl ? 'KRYTYCZNE' : 'CRITICAL'],
    warning: ['warn', pl ? 'Ostrzeżenie' : 'Warning'],
    unknown: ['muted', pl ? 'Nieznane' : 'Unknown'],
  };
  const [tone, label] = map[String(status || 'pending').toLowerCase()] || ['muted', status || 'Pending'];
  return badge(label, tone, { dot: true });
}

function clip(value, length = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function durationLabel(run) {
  if (!run.finished_at) return 'w toku';
  const ms = new Date(run.finished_at).getTime() - new Date(run.started_at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60000)} min`;
}

function lastRunCell(job, ctx) {
  if (!job.last_run_at) return h`<span class="small muted">${(ctx?.user?.language || 'pl') === 'en' ? 'never' : 'nigdy'}</span>`;
  const pl = (ctx?.user?.language || 'pl') !== 'en';
  return h`<div class="small muted">wykonanie: ${statusBadge(job.last_status, pl)}</div><div class="small muted">stan: ${statusBadge(job.observation?.observedStatus || 'unknown', pl)}</div><div class="small muted">${formatDate(job.last_run_at, { time: true })} · ${timeAgo(job.last_run_at)}</div>`;
}

function nextRunCell(job, ctx) {
  const pl = (ctx?.user?.language || 'pl') !== 'en';
  if (!job.enabled) return h`<span class="small muted">${pl ? 'wyłączone' : 'disabled'}</span>`;
  if (!job.next_run_at) return h`${badge(pl ? 'teraz' : 'due now', 'warn', { dot: true })}`;
  if (job.due) return h`${badge(pl ? 'teraz' : 'due now', 'warn', { dot: true })}<div class="small muted">${formatDate(job.next_run_at, { time: true })}</div>`;
  return h`<div>${formatDate(job.next_run_at, { time: true })}</div><div class="small muted">${pl ? 'za' : 'in'} ${formatInterval(job.next_in_seconds)}</div>`;
}

function jobActions(ctx, job) {
  return h`<div class="row-actions">
    <form method="post" action="${A}/jobs/${encodeURIComponent(job.key)}/run" class="inline">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      ${btn(L(ctx, 'Run now'), { variant: 'primary', size: 'sm', icon: 'play', submit: true })}
    </form>
    <details class="more-menu">
      <summary class="btn btn-ghost btn-sm" role="button" aria-label="Więcej akcji">Więcej</summary>
      <div class="more-menu-list">
        <a class="menu-item" href="${A}?edit=${encodeURIComponent(job.key)}">${L(ctx, 'Edit')}</a>
        <form method="post" action="${A}/jobs/${encodeURIComponent(job.key)}/toggle">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <button class="menu-item" type="submit">${job.enabled ? L(ctx, 'Disable') : L(ctx, 'Enable')}</button>
        </form>
      </div>
    </details>
  </div>`;
}

export function register(router) {
  router.get(`${A}/status`, (ctx) => ({ json: automationStatus() }));

  router.get(A, (ctx) => {
    const status = automationStatus();
    const editing = ctx.query.edit ? status.jobs.find((job) => job.key === String(ctx.query.edit)) : null;
    const clearForm = h`<form method="post" action="${A}/clear-failures" class="inline">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      ${btn(L(ctx, 'Clear failures'), { variant: 'secondary', size: 'sm', icon: 'x', submit: true })}
    </form>`;
    const body = h`
      ${!status.enabled ? alert(L(ctx, 'Global automation is paused. Scheduled jobs will not run until it is enabled.'), 'warn') : ''}
      ${status.enabled && status.totals.critical ? alert(`${status.totals.critical} kontrola(-e) wykazała stan krytyczny mimo technicznego sukcesu wykonania. Otwórz szczegóły i napraw obserwowany problem.`, 'danger') : ''}
      ${status.enabled && !status.totals.critical && status.totals.failures ? alert(`${status.totals.failures} nieudanych prób zadań. Sprawdź historię, usuń przyczynę i uruchom zadanie ponownie.`, 'warn') : ''}
      <div class="stat-grid">
        ${statCard({ label: L(ctx, 'Automation'), value: status.enabled ? 'ON' : 'OFF', sub: status.enabled ? L(ctx, 'global scheduler active') : L(ctx, 'paused globally'), icon: 'refresh', tone: status.enabled ? 'ok' : 'warn' })}
        ${statCard({ label: L(ctx, 'Due now'), value: String(status.due), sub: L(ctx, 'jobs waiting for the next tick'), icon: 'clock', tone: status.due ? 'warn' : 'ok' })}
        ${statCard({ label: L(ctx, 'Scheduled jobs'), value: `${status.totals.enabled}/${status.totals.jobs}`, sub: L(ctx, 'enabled / total'), icon: 'list' })}
        ${statCard({ label: L(ctx, 'Krytyczne obserwacje'), value: String(status.totals.critical), sub: L(ctx, 'wynik kontroli, nie tylko wykonanie'), icon: 'alert', tone: status.totals.critical ? 'danger' : 'ok' })}
        ${statCard({ label: L(ctx, 'Nieudane wykonania'), value: String(status.totals.failures), sub: L(ctx, 'skumulowane próby'), icon: 'x', tone: status.totals.failures ? 'warn' : 'ok' })}
      </div>
      ${card(L(ctx, 'Automation settings'), form([
        field({ name: 'enabled', label: L(ctx, 'Global automation'), type: 'checkbox', value: status.enabled, help: L(ctx, 'Disabling this stops scheduled runs; manual Run now still works.') }),
        field({ name: 'disk_threshold', label: L(ctx, 'Disk alert threshold (%)'), type: 'number', value: status.settings.disk_threshold, min: 50, max: 99 }),
        field({ name: 'tmp_days', label: L(ctx, 'Remove panel temp/cache older than (days)'), type: 'number', value: status.settings.tmp_days, min: 1, max: 365 }),
        field({ name: 'mail_retry', label: L(ctx, 'Retry failed/deferred mail queue items'), type: 'checkbox', value: status.settings.mail_retry, help: L(ctx, 'Off by default. When enabled, each mail.queue run retries at most 10 failed or deferred messages.') }),
      ], { action: `${A}/settings`, csrf: ctx.csrf, submit: L(ctx, 'Save settings') }))}
      ${editing ? card(`${L(ctx, 'Edit job')} · ${JOB_LABEL_PL[editing.key] || editing.label}`, form([
        field({ name: 'interval_seconds', label: L(ctx, 'Interval'), value: String(editing.interval_seconds), required: true, help: L(ctx, 'Seconds or a suffix such as 30s, 15m, 24h. Minimum 15 seconds, maximum 30 days.') }),
        field({ name: 'enabled', label: L(ctx, 'Enabled'), type: 'checkbox', value: editing.enabled, help: L(ctx, 'Disabled jobs stay in the list and keep their history.') }),
      ], { action: `${A}/jobs/${encodeURIComponent(editing.key)}`, csrf: ctx.csrf, submit: L(ctx, 'Save job'), cancel: A })) : ''}
      ${card(L(ctx, 'Jobs'), table({
        cls: 'responsive-table',
        columns: [
          { label: L(ctx, 'Job'), dataLabel: 'Zadanie', render: (job) => h`<strong>${ctx.user?.language === 'pl' ? (JOB_LABEL_PL[job.key] || job.label) : job.label}</strong><div class="small muted">${ctx.user?.language === 'pl' ? (JOB_PL[job.key] || job.description) : job.description}</div>` },
          { label: L(ctx, 'Status'), dataLabel: 'Status', render: (job) => lastRunCell(job, ctx) },
          { label: L(ctx, 'Interval'), dataLabel: 'Interwał', render: (job) => h`<span>${formatInterval(job.interval_seconds)}</span>` },
          { label: L(ctx, 'Next run'), dataLabel: 'Następne uruchomienie', render: (job) => nextRunCell(job, ctx) },
          { label: L(ctx, 'Runs / failures'), dataLabel: 'Uruchomienia / błędy', render: (job) => h`<span>${job.run_count}</span> <span class="small muted">/ ${job.fail_count}</span>` },
          { label: L(ctx, 'Actions'), cls: 'col-actions', dataLabel: 'Akcje', render: (job) => jobActions(ctx, job) },
        ],
        rows: status.jobs,
        empty: L(ctx, 'No automation jobs are seeded yet.'),
      }), { padded: false, sub: L(ctx, 'Every action is a normal POST form with a CSRF token and works without client JavaScript.') })}
      ${card(L(ctx, 'Recent runs'), table({
        cls: 'responsive-table',
        columns: [
          { label: L(ctx, 'Job'), dataLabel: 'Zadanie', render: (run) => h`${JOB_LABEL_PL[run.job_key] || run.job_key}` },
          { label: L(ctx, 'Started'), dataLabel: 'Start', render: (run) => h`<div>${formatDate(run.started_at, { time: true })}</div><div class="small muted">${timeAgo(run.started_at)}</div>` },
          { label: L(ctx, 'Duration'), dataLabel: 'Czas', render: (run) => durationLabel(run) },
          { label: 'Wykonanie', dataLabel: 'Wykonanie', render: (run) => statusBadge(run.status, (ctx.user?.language || 'pl') !== 'en') },
          { label: 'Stan kontroli', dataLabel: 'Stan kontroli', render: (run) => statusBadge(run.observation?.observedStatus || 'unknown', (ctx.user?.language || 'pl') !== 'en') },
          { label: L(ctx, 'Output / error'), dataLabel: 'Wynik / błąd', render: (run) => h`<span class="small ${run.error ? 'danger' : 'muted'}">${clip(run.error || run.output || '—')}</span>` },
        ],
        rows: status.lastRuns,
        empty: L(ctx, 'No automation runs recorded yet.'),
      }), { padded: false, actions: [clearForm] })}
      <details class="technical-details"><summary>Informacje techniczne</summary><p class="small muted">${L(ctx, 'Scheduler tick source: src/scheduler.mjs. Job definitions and run history are stored in automation_jobs and automation_runs.')}</p></details>`;
    return page(ctx, { title: L(ctx, 'Automation'), subtitle: L(ctx, 'Scheduled jobs, run history and global controls'), body, wide: true });
  });

  router.post(`${A}/settings`, (ctx) => {
    const result = saveAutomationSettings({
      ...ctx.body,
      enabled: ctx.body.enabled === '1' ? '1' : '0',
      mail_retry: ctx.body.mail_retry === '1' ? '1' : '0',
    }, ctx.user.username);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(result.ok ? 'Automation settings saved' : result.error || 'Could not save settings')}${result.ok ? '' : '&type=error'}`);
  });

  router.post(`${A}/jobs/:key`, (ctx) => {
    const result = updateAutomationJob(ctx.params.key, {
      interval_seconds: ctx.body.interval_seconds,
      enabled: ctx.body.enabled === '1' ? '1' : '0',
    }, ctx.user.username);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(result.ok ? `Job ${ctx.params.key} saved` : result.error || 'Could not save job')}${result.ok ? '' : '&type=error'}`);
  });

  router.post(`${A}/jobs/:key/toggle`, (ctx) => {
    const result = toggleAutomationJob(ctx.params.key, ctx.user.username);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(result.ok ? `Job ${ctx.params.key} ${result.job?.enabled ? 'enabled' : 'disabled'}` : result.error || 'Could not change job')}${result.ok ? '' : '&type=error'}`);
  });

  router.post(`${A}/jobs/:key/run`, async (ctx) => {
    const result = await runAutomationJob(ctx.params.key, { trigger: 'manual', actor: ctx.user.username });
    const ok = result.status !== 'error' && result.status !== 'unavailable';
    const message = `${ctx.params.key}: ${result.status}${result.output ? ` — ${clip(result.output, 240)}` : ''}`;
    return ctx.redirect(`${A}?flash=${encodeURIComponent(message)}${ok ? '' : '&type=error'}`);
  });

  router.post(`${A}/clear-failures`, (ctx) => {
    const result = clearAutomationFailures(ctx.user.username);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(`Failure counters cleared (${result.cleared} attempt(s)); run history is kept`)}`);
  });
}
