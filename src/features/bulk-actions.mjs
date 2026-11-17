// Admin/reseller bulk action surface: selection page, mandatory signed preview
// and an apply step that reports every object independently. This module only
// registers routes and renders HTML; the policy/engine lives in bulk-actions.mjs.
import { all } from '../db.mjs';
import { html as h, raw, formatDate, formatBytes } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { requireLevel } from '../auth.mjs';
import { card, table, badge, alert, field, emptyState, kvList } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import {
  BULK_BACKUP_KINDS,
  BULK_SSL_MODES,
  MAX_BULK_OBJECTS,
  bulkPhpVersions,
  listBulkTargets,
  previewBulkAction,
  applyBulkAction,
} from '../bulk-actions.mjs';

const BACKUP_LABELS = { full: 'Full account', home: 'Home directory', email: 'Mail only', db: 'Databases only' };
const SSL_LABELS = { letsencrypt: "Let's Encrypt", selfsigned: 'Self-signed' };

function flashFrom(ctx) {
  const message = ctx.query?.flash;
  if (!message) return null;
  return { type: ctx.query?.type === 'error' ? 'error' : 'ok', message: String(message).slice(0, 300) };
}

function objectTypeFrom(ctx) {
  const raw = String(ctx.query?.type || ctx.query?.objectType || 'users').toLowerCase();
  return raw === 'domains' || raw === 'domain' ? 'domains' : 'users';
}

function packageOptions(actor) {
  const rows = actor.level === 'admin'
    ? all('SELECT name, type FROM packages ORDER BY type, name')
    : all("SELECT name, type FROM packages WHERE type = 'user' AND (owner IS NULL OR owner = ?) ORDER BY name", actor.username);
  return rows.map((pkg) => ({ value: pkg.name, label: `${pkg.name} (${pkg.type})` }));
}

function userColumns() {
  return [
    {
      label: 'Account',
      render: (row) => h`<span class="cell-strong">${row.username}</span><span class="cell-sub">${row.email || 'no email'}</span>`,
    },
    {
      label: 'Level / package',
      render: (row) => h`${badge(row.level, 'brand')} <span class="small">${row.package || '—'}</span>`,
    },
    {
      label: 'Status',
      render: (row) => (row.suspended ? badge('Suspended', 'danger', { dot: true }) : badge('Active', 'ok', { dot: true })),
    },
    {
      label: 'Last login',
      render: (row) => (row.last_login ? h`<span class="small muted">${formatDate(row.last_login, { time: true })}</span>` : h`<span class="small muted">never</span>`),
    },
  ];
}

function domainColumns() {
  return [
    {
      label: 'Domain',
      render: (row) => h`<span class="cell-strong">${row.name}</span><span class="cell-sub">${row.docroot || ''}</span>`,
    },
    { label: 'Client', render: (row) => h`<span class="small">${row.username}</span>` },
    { label: 'PHP', render: (row) => h`<span class="small">${row.php_version || 'default'}</span>` },
    { label: 'SSL', render: (row) => (row.ssl ? badge('on', 'ok') : badge('off', 'muted')) },
    { label: 'Status', render: (row) => (row.status === 'suspended' ? badge('Suspended', 'danger', { dot: true }) : badge('Active', 'ok', { dot: true })) },
    { label: 'Disk', align: 'right', render: (row) => formatBytes(row.disk_mb) },
  ];
}

function filterForm(B, objectType, query) {
  const state = String(query.state || '');
  return h`<form method="get" action="${B}" class="toolbar" data-bulk-filter>
    <input type="hidden" name="type" value="${objectType}">
    <div class="row">
      <label class="field-label" for="bulk-q">Search</label>
      <input class="u-s45" id="bulk-q" name="q" type="search" value="${query.q || ''}" placeholder="${objectType === 'domains' ? 'domain or client' : 'username, email or package'}">
      <label class="field-label" for="bulk-state">Status</label>
      <select id="bulk-state" name="state">
        <option value="" ${state === '' ? raw('selected') : ''}>All</option>
        <option value="active" ${state === 'active' ? raw('selected') : ''}>Active</option>
        <option value="suspended" ${state === 'suspended' ? raw('selected') : ''}>Suspended</option>
      </select>
      <button class="btn btn-secondary btn-sm" type="submit">${icon('filter', { size: 15 })}${h`<span>Filter</span>`}</button>
    </div>
  </form>`;
}

function actionFields(ctx, objectType, listing) {
  const fields = [
    field({
      name: 'action',
      label: 'Action',
      type: 'select',
      required: true,
      options: listing.actions.map((action) => ({ value: action.key, label: action.label })),
      help: 'Only the fields relevant to the selected action are used; the server validates the action and value.',
    }),
  ];
  if (objectType === 'users') {
    fields.push(
      field({
        name: 'package',
        label: 'Package · package change',
        type: 'select',
        options: packageOptions(ctx.user),
        help: 'The package type must match the target account (user or reseller).',
      }),
      field({
        name: 'backup_kind',
        label: 'Backup scope · backup',
        type: 'select',
        value: 'full',
        options: BULK_BACKUP_KINDS.map((kind) => ({ value: kind, label: BACKUP_LABELS[kind] || kind })),
      }),
      field({
        name: 'reason',
        label: 'Suspension reason · suspend',
        placeholder: 'Visible to the operator in the account record',
        help: 'Optional, max 300 characters. Stored with the suspension.',
      }),
      field({
        name: 'subject',
        label: 'Message subject · send message',
        placeholder: 'Service notice',
      }),
      field({
        name: 'message',
        label: 'Message body · send message',
        type: 'textarea',
        full: true,
        rows: 4,
        placeholder: 'Message delivered to the in-panel inbox…',
      }),
    );
  } else {
    const phpOptions = bulkPhpVersions(ctx.user);
    fields.push(
      field({
        name: 'php',
        label: 'PHP version · change PHP',
        type: 'select',
        options: phpOptions.map((version) => ({ value: version, label: `PHP ${version}` })),
        help: 'Validated against the enabled PHP versions for your level.',
      }),
      field({
        name: 'ssl_mode',
        label: 'SSL mode · issue SSL',
        type: 'select',
        value: 'letsencrypt',
        options: BULK_SSL_MODES.map((mode) => ({ value: mode, label: SSL_LABELS[mode] || mode })),
      }),
    );
  }
  return fields;
}

function selectionPage(ctx, B) {
  const objectType = objectTypeFrom(ctx);
  const query = ctx.query || {};
  const listing = listBulkTargets(ctx.user, {
    objectType,
    q: query.q || '',
    state: query.state || '',
  });
  if (!listing.ok) {
    return {
      status: listing.status || 403,
      html: page(ctx, {
        title: 'Bulk actions',
        subtitle: 'Access denied',
        body: alert(listing.error, 'danger'),
      }),
    };
  }

  const rows = listing.rows;
  const columns = objectType === 'domains' ? domainColumns() : userColumns();
  const scopeNote = ctx.user.level === 'admin'
    ? 'Administrator accounts are excluded and cannot be changed in bulk. Reseller accounts and customers are in scope.'
    : 'Only your own customer accounts and domains are listed. Foreign objects are rejected even if an id is submitted manually.';
  const fields = actionFields(ctx, objectType, listing);
  const flash = flashFrom(ctx);

  const body = h`
    ${flash ? alert(flash.message, flash.type) : ''}
    ${card('Choose objects', h`
      ${filterForm(B, objectType, query)}
      <p class="small muted mt-12">${scopeNote}</p>
      <div class="row mt-12">
        <a class="btn btn-ghost btn-sm ${objectType === 'users' ? 'active' : ''}" href="${B}?type=users">Users</a>
        <a class="btn btn-ghost btn-sm ${objectType === 'domains' ? 'active' : ''}" href="${B}?type=domains">Domains</a>
        <span class="small muted">${listing.shown} of ${listing.total} object(s) shown${listing.truncated ? ` · cap ${MAX_BULK_OBJECTS}` : ''}</span>
      </div>
    `, { sub: 'Filter, select multiple rows, then preview the exact effects before anything changes' })}
    ${card('Preview action', h`
      <form method="post" action="${B}/preview" class="oa-form" data-bulk-preview-form>
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <input type="hidden" name="objectType" value="${objectType}">
        <div class="form-grid">${fields}</div>
        ${rows.length
          ? table({
            columns,
            rows,
            rowKey: 'id',
            selectable: true,
            label: objectType === 'domains' ? 'Domains available for bulk actions' : 'Accounts available for bulk actions',
            selectAllLabel: 'Select all listed objects',
            selectRowLabel: 'Select object',
          })
          : emptyState('No objects match this filter.', { icon: objectType === 'domains' ? 'globe' : 'users' })}
        <p class="small muted mt-12">Nothing is changed until you confirm the preview. The next step lists every eligible and blocked object with its effects, downtime and disk estimate.</p>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit" ${rows.length ? '' : 'disabled'}>
            ${icon('eye', { size: 16 })}<span>Preview action</span>
          </button>
          <a class="btn btn-ghost" href="${B}?type=${objectType}">Reset selection</a>
        </div>
      </form>
    `, { sub: `Bulk ${objectType === 'domains' ? 'domain' : 'account'} operations` })}
  `;
  return page(ctx, {
    title: 'Bulk actions',
    subtitle: 'Select many accounts or domains, preview every effect, then apply with a signed confirmation',
    body,
    wide: true,
  });
}

function previewRowStatus(entry) {
  return entry.eligible
    ? badge('Eligible', 'ok', { dot: true })
    : badge('Blocked', 'warn', { dot: true });
}

function objectColumn(objectType) {
  return {
    label: objectType === 'domains' ? 'Domain' : 'Account',
    render: (entry) => h`<span class="cell-strong">${entry.label}</span><span class="cell-sub">${entry.kind} #${entry.id}</span>`,
  };
}

function previewPage(ctx, B, result) {
  const preview = result.preview;
  const rows = preview.objects || [];
  const columns = [
    objectColumn(preview.objectType),
    { label: 'Eligibility', render: previewRowStatus },
    {
      label: 'Reason / effects',
      render: (entry) => (entry.eligible
        ? h`<ul class="small u-s46">${(entry.effects || []).map((effect) => h`<li>${effect}</li>`)}</ul>`
        : h`<span class="small">${entry.reason || entry.code || 'Blocked'}</span>`),
    },
    {
      label: 'Downtime',
      render: (entry) => h`<span class="small">${entry.downtimeMinutes ? `${entry.downtimeMinutes} min` : 'none'}</span>${entry.downtimeText ? h`<span class="cell-sub">${entry.downtimeText}</span>` : ''}`,
    },
    {
      label: 'Disk',
      align: 'right',
      render: (entry) => (entry.diskMb ? h`<span class="small">~${formatBytes(entry.diskMb)}</span>` : h`<span class="small muted">—</span>`),
    },
  ];
  const canApply = preview.eligible > 0;
  const body = h`
    ${preview.blocked > 0
      ? alert(`${preview.blocked} of ${preview.count} selected object(s) are blocked and will be skipped. Review the reasons before applying.`, 'warn')
      : alert(`All ${preview.count} selected object(s) are eligible. Nothing has been changed yet.`, 'info')}
    ${card(`Preview · ${preview.actionLabel}`, h`
      ${kvList([
        ['Selected objects', String(preview.count)],
        ['Eligible', String(preview.eligible)],
        ['Blocked', String(preview.blocked)],
        ['Estimated downtime', preview.estimate?.downtimeText || 'No planned downtime.'],
        ['Estimated disk', preview.estimate?.diskText || 'No additional disk footprint.'],
        ['Confirmation valid until', formatDate(result.expiresAt, { time: true })],
      ])}
      ${preview.effects?.length ? h`
        <h3 class="mt-18">Effects</h3>
        <ul class="small">${preview.effects.map((effect) => h`<li>${effect}</li>`)}</ul>` : ''}
      <p class="small muted mt-12">The apply step revalidates permissions and every object. A confirmation token cannot be reused for a different batch, and an expired token is rejected before any change.</p>
    `, { sub: `${result.batchId} · server-side batch bound to your session` })}
    ${card('Per-object eligibility', table({
      columns,
      rows,
      empty: 'No objects were selected.',
      label: 'Per-object bulk preview',
    }))}
    <form method="post" action="${B}/apply" class="oa-form" data-bulk-apply-form>
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <input type="hidden" name="token" value="${result.token}">
      <div class="form-actions">
        <button class="btn btn-primary" type="submit" ${canApply ? '' : 'disabled'} data-confirm="Apply this bulk action to ${preview.eligible} eligible object(s)? Each object is processed independently and a per-object report is returned.">
          ${icon('check', { size: 16 })}<span>Apply to ${preview.eligible} eligible object(s)</span>
        </button>
        <a class="btn btn-ghost" href="${B}?type=${preview.objectType}">Cancel and change selection</a>
      </div>
    </form>
  `;
  return page(ctx, {
    title: `Bulk preview · ${preview.actionLabel}`,
    subtitle: `${preview.eligible} eligible · ${preview.blocked} blocked · no changes applied yet`,
    body,
    wide: true,
  });
}

function statusTone(status) {
  if (status === 'succeeded') return 'ok';
  if (status === 'partial') return 'warn';
  if (status === 'blocked') return 'warn';
  return 'danger';
}

function statusLabel(status) {
  return { succeeded: 'Succeeded', partial: 'Partial success', blocked: 'Blocked', failed: 'Failed' }[status] || status;
}

function detailText(details) {
  if (!details || typeof details !== 'object') return '—';
  const entries = Object.entries(details).filter(([, value]) => value !== null && value !== undefined && value !== '');
  if (!entries.length) return '—';
  return entries.map(([key, value]) => `${key}=${String(value)}`).join(', ');
}

function reportPage(ctx, B, result) {
  const report = result.report;
  const rows = report.objects || [];
  const columns = [
    objectColumn(report.objectType),
    {
      label: 'Result',
      render: (entry) => (entry.ok
        ? badge('Changed', 'ok', { dot: true })
        : entry.blocked
          ? badge('Blocked', 'warn', { dot: true })
          : badge('Failed', 'danger', { dot: true })),
    },
    { label: 'Message', render: (entry) => h`<span class="small">${entry.message || entry.code || '—'}</span>` },
    { label: 'Details', render: (entry) => h`<span class="cell-mono small">${detailText(entry.details)}</span>` },
  ];
  const body = h`
    ${result.reused ? alert('This confirmation token was already applied. Showing the stored report; no new backups, SSL jobs or messages were created.', 'info') : ''}
    ${alert(report.message, statusTone(report.status))}
    ${card('Run summary', h`
      ${kvList([
        ['Action', report.actionLabel],
        ['Outcome', statusLabel(report.status)],
        ['Selected', String(report.totals?.selected || 0)],
        ['Changed', String(report.totals?.succeeded || 0)],
        ['Failed', String(report.totals?.failed || 0)],
        ['Blocked', String(report.totals?.blocked || 0)],
        ['Started', formatDate(report.startedAt, { time: true })],
        ['Finished', formatDate(report.finishedAt, { time: true })],
      ])}
      ${report.warnings?.length ? alert(report.warnings.join(' '), 'warn') : ''}
      ${report.maintenance ? h`<p class="small muted mt-12">PHP configuration: ${report.maintenance.detail}</p>` : ''}
      <p class="small muted mt-12">${report.ok ? 'Every selected object changed successfully.' : 'This run is not a full success. The per-object report below is authoritative.'}</p>
    `, { sub: `${report.batchId} · ${result.reused ? 'stored report' : 'executed now'}` })}
    ${card('Per-object report', table({
      columns,
      rows,
      empty: 'The batch had no objects.',
      label: 'Per-object bulk apply report',
    }))}
    <div class="row mt-18">
      <a class="btn btn-primary" href="${B}?type=${report.objectType}">Back to bulk actions</a>
    </div>
  `;
  return page(ctx, {
    title: 'Bulk action report',
    subtitle: `${statusLabel(report.status)} · ${report.totals?.succeeded || 0} changed, ${report.totals?.failed || 0} failed, ${report.totals?.blocked || 0} blocked`,
    body,
    wide: true,
  });
}

function errorPage(ctx, B, result) {
  const noChange = [
    'invalid_token', 'token_expired', 'csrf_mismatch', 'missing_token', 'batch_not_found',
    'token_actor_mismatch', 'forbidden', 'unknown_action', 'no_selection', 'too_many_objects',
    'invalid_value', 'invalid_php_version', 'object_type_mismatch', 'unknown_object_type',
  ].includes(result.code);
  const body = h`
    ${alert(result.error || 'The bulk operation was rejected.', 'danger')}
    <p class="small muted">${result.code ? `Reason code: ${result.code}` : ''}</p>
    <div class="row mt-18">
      <a class="btn btn-primary" href="${B}">Back to bulk actions</a>
    </div>
  `;
  return page(ctx, {
    title: 'Bulk action rejected',
    subtitle: noChange ? 'No changes were made' : 'Review the run state before retrying',
    body,
  });
}

function inputFrom(ctx) {
  const body = ctx.body || {};
  return {
    action: body.action,
    objectType: body.objectType || body.type,
    ids: body.selected ?? body['selected[]'] ?? body.ids,
    value: body.value,
    package: body.package,
    php: body.php,
    backupKind: body.backup_kind ?? body.backupKind,
    sslMode: body.ssl_mode ?? body.sslMode,
    reason: body.reason,
    subject: body.subject,
    message: body.message,
  };
}

/**
 * Register the admin and reseller bulk surfaces. Root integration:
 *   registerBulkActions(router, { base: '/admin/bulk', level: 'admin' });
 *   registerBulkActions(router, { base: '/reseller/bulk', level: 'reseller' });
 */
export function registerBulkActions(router, { base = '/admin/bulk', level = 'admin' } = {}) {
  if (!router || typeof router.get !== 'function' || typeof router.post !== 'function') {
    throw new Error('registerBulkActions requires a Router instance');
  }
  const B = String(base || '').replace(/\/+$/, '');
  if (!/^\/(?:admin|reseller)\/bulk(?:\/[A-Za-z0-9_-]+)*$/.test(B)) {
    throw new Error(`registerBulkActions base must be /admin/bulk or /reseller/bulk (got ${base})`);
  }
  if (level !== 'admin' && level !== 'reseller') {
    throw new Error(`registerBulkActions level must be admin or reseller (got ${level})`);
  }
  const required = level;
  const expected = B.startsWith('/admin/') ? 'admin' : 'reseller';
  if (required !== expected) {
    throw new Error(`registerBulkActions base ${B} must use level=${expected}`);
  }

  const denied = (ctx) => {
    if (!ctx.user) {
      return {
        status: 403,
        html: h`<div class="error-page"><div class="error-code">403</div><h2>Access denied</h2><p>Sign in with the matching administrator or reseller role.</p></div>`,
      };
    }
    return {
      status: 403,
      html: page(ctx, {
        title: 'Bulk actions',
        subtitle: 'Access denied',
        body: alert('Bulk operations require the matching administrator or reseller role.', 'danger'),
      }),
    };
  };
  const allowed = (ctx) => !!(ctx.user && requireLevel(ctx.user, required)
    && (ctx.user.level === 'admin' || ctx.user.level === 'reseller'));

  router.get(B, (ctx) => {
    if (!allowed(ctx)) return denied(ctx);
    return selectionPage(ctx, B);
  });

  router.post(`${B}/preview`, (ctx) => {
    if (!allowed(ctx)) return denied(ctx);
    const result = previewBulkAction(ctx.user, inputFrom(ctx), {
      csrf: ctx.csrf || ctx.session?.csrf || '',
      ip: ctx.ip || '',
    });
    if (!result.ok) {
      return {
        status: result.status || 400,
        html: errorPage(ctx, B, result),
      };
    }
    return previewPage(ctx, B, result);
  });

  router.post(`${B}/apply`, (ctx) => {
    if (!allowed(ctx)) return denied(ctx);
    const token = ctx.body?.token;
    const result = applyBulkAction(ctx.user, token, {
      csrf: ctx.csrf || ctx.session?.csrf || '',
      ip: ctx.ip || '',
    });
    if (!result.ok && !result.report) {
      return {
        status: result.status || 400,
        html: errorPage(ctx, B, result),
      };
    }
    return reportPage(ctx, B, result);
  });

  return {
    base: B,
    level: required,
    paths: { page: B, preview: `${B}/preview`, apply: `${B}/apply` },
  };
}
