// Administrator automation engine: overview, job controls, settings and logs.
import { html as h, formatDate, timeAgo } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, form, field, statCard, btn } from '../ui/components.mjs';
import {
  automationStatus, updateAutomationJob, toggleAutomationJob, saveAutomationSettings,
  runAutomationJob, clearAutomationFailures, formatInterval,
} from '../automation.mjs';

const A = '/admin/automation';

function statusBadge(status) {
  const map = {
    ok: ['ok', 'OK'],
    warn: ['warn', 'Warning'],
    error: ['danger', 'Failed'],
    skipped: ['muted', 'Skipped'],
    unavailable: ['warn', 'Unavailable'],
    running: ['brand', 'Running'],
    pending: ['muted', 'Pending'],
  };
  const [tone, label] = map[String(status || 'pending').toLowerCase()] || ['muted', status || 'Pending'];
  return badge(label, tone, { dot: true });
}

function clip(value, length = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function durationLabel(run) {
  if (!run.finished_at) return 'running';
  const ms = new Date(run.finished_at).getTime() - new Date(run.started_at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60000)} min`;
}

function lastRunCell(job) {
  if (!job.last_run_at) return h`<span class="small muted">never</span>`;
  return h`${statusBadge(job.last_status)}<div class="small muted">${formatDate(job.last_run_at, { time: true })} · ${timeAgo(job.last_run_at)}</div>`;
}

function nextRunCell(job) {
  if (!job.enabled) return h`<span class="small muted">disabled</span>`;
  if (!job.next_run_at) return h`${badge('due now', 'warn', { dot: true })}`;
  if (job.due) return h`${badge('due now', 'warn', { dot: true })}<div class="small muted">${formatDate(job.next_run_at, { time: true })}</div>`;
  return h`<div>${formatDate(job.next_run_at, { time: true })}</div><div class="small muted">in ${formatInterval(job.next_in_seconds)}</div>`;
}

function jobActions(ctx, job) {
  return h`<div class="row-actions">
    <a class="btn btn-ghost btn-sm" href="${A}?edit=${encodeURIComponent(job.key)}">Edit</a>
    <form method="post" action="${A}/jobs/${encodeURIComponent(job.key)}/run" class="inline">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      ${btn('Run now', { variant: 'secondary', size: 'sm', icon: 'play', submit: true })}
    </form>
    <form method="post" action="${A}/jobs/${encodeURIComponent(job.key)}/toggle" class="inline">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      ${btn(job.enabled ? 'Disable' : 'Enable', { variant: 'ghost', size: 'sm', icon: job.enabled ? 'x' : 'check', submit: true })}
    </form>
  </div>`;
}

export function register(router) {
  router.get(`${A}/status`, (ctx) => ({ json: automationStatus() }));

  router.get(A, (ctx) => {
    const status = automationStatus();
    const editing = ctx.query.edit ? status.jobs.find((job) => job.key === String(ctx.query.edit)) : null;
    const clearForm = h`<form method="post" action="${A}/clear-failures" class="inline">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      ${btn('Clear failures', { variant: 'secondary', size: 'sm', icon: 'x', submit: true })}
    </form>`;
    const body = h`
      ${!status.enabled ? alert('Global automation is paused. Scheduled jobs will not run until it is enabled.', 'warn') : ''}
      ${status.enabled && status.totals.failures ? alert(`${status.totals.failures} failed job attempt(s) are recorded. Inspect Recent runs, fix the cause, then run the job again.`, 'warn') : ''}
      <div class="stat-grid">
        ${statCard({ label: 'Automation', value: status.enabled ? 'ON' : 'OFF', sub: status.enabled ? 'global scheduler active' : 'paused globally', icon: 'refresh', tone: status.enabled ? 'ok' : 'warn' })}
        ${statCard({ label: 'Due now', value: String(status.due), sub: 'jobs waiting for the next tick', icon: 'clock', tone: status.due ? 'warn' : 'ok' })}
        ${statCard({ label: 'Scheduled jobs', value: `${status.totals.enabled}/${status.totals.jobs}`, sub: 'enabled / total', icon: 'list' })}
        ${statCard({ label: 'Failures', value: String(status.totals.failures), sub: 'cumulative failed attempts', icon: 'alert', tone: status.totals.failures ? 'danger' : 'ok' })}
      </div>
      ${card('Automation settings', form([
        field({ name: 'enabled', label: 'Global automation', type: 'checkbox', value: status.enabled, help: 'Disabling this stops scheduled runs; manual Run now still works.' }),
        field({ name: 'disk_threshold', label: 'Disk alert threshold (%)', type: 'number', value: status.settings.disk_threshold, min: 50, max: 99 }),
        field({ name: 'tmp_days', label: 'Remove panel temp/cache older than (days)', type: 'number', value: status.settings.tmp_days, min: 1, max: 365 }),
        field({ name: 'mail_retry', label: 'Retry failed/deferred mail queue items', type: 'checkbox', value: status.settings.mail_retry, help: 'Off by default. When enabled, each mail.queue run retries at most 10 failed or deferred messages.' }),
      ], { action: `${A}/settings`, csrf: ctx.csrf, submit: 'Save settings' }))}
      ${editing ? card(`Edit job · ${editing.label}`, form([
        field({ name: 'interval_seconds', label: 'Interval', value: String(editing.interval_seconds), required: true, help: 'Seconds or a suffix such as 30s, 15m, 24h. Minimum 15 seconds, maximum 30 days.' }),
        field({ name: 'enabled', label: 'Enabled', type: 'checkbox', value: editing.enabled, help: 'Disabled jobs stay in the list and keep their history.' }),
      ], { action: `${A}/jobs/${encodeURIComponent(editing.key)}`, csrf: ctx.csrf, submit: 'Save job', cancel: A })) : ''}
      ${card('Jobs', table({
        columns: [
          { label: 'Job', render: (job) => h`<strong>${job.label}</strong><div class="small muted"><span class="cell-mono">${job.key}</span></div><div class="small muted">${job.description}</div>` },
          { label: 'Status', render: (job) => lastRunCell(job) },
          { label: 'Interval', render: (job) => h`<span>${formatInterval(job.interval_seconds)}</span><div class="small muted">${job.interval_seconds}s</div>` },
          { label: 'Next run', render: (job) => nextRunCell(job) },
          { label: 'Runs / failures', render: (job) => h`<span>${job.run_count}</span> <span class="small muted">/ ${job.fail_count}</span>` },
          { label: 'Actions', cls: 'col-actions', render: (job) => jobActions(ctx, job) },
        ],
        rows: status.jobs,
        empty: 'No automation jobs are seeded yet.',
      }), { padded: false, sub: 'Every action is a normal POST form with a CSRF token and works without client JavaScript.' })}
      ${card('Recent runs', table({
        columns: [
          { label: 'Job', render: (run) => h`<span class="cell-mono">${run.job_key}</span>` },
          { label: 'Started', render: (run) => h`<div>${formatDate(run.started_at, { time: true })}</div><div class="small muted">${timeAgo(run.started_at)}</div>` },
          { label: 'Duration', render: (run) => durationLabel(run) },
          { label: 'Status', render: (run) => statusBadge(run.status) },
          { label: 'Output / error', render: (run) => h`<span class="small ${run.error ? 'danger' : 'muted'}">${clip(run.error || run.output || '—')}</span>` },
        ],
        rows: status.lastRuns,
        empty: 'No automation runs recorded yet.',
      }), { padded: false, actions: [clearForm] })}
      <p class="small muted">Scheduler tick source: src/scheduler.mjs. Job definitions and run history are stored in automation_jobs and automation_runs.</p>`;
    return page(ctx, { title: 'Automation', subtitle: 'Scheduled jobs, run history and global controls', body, wide: true });
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
