// Reusable server-rendered UI components.
import { html, raw, e, formatBytes, pct } from '../util.mjs';
import { icon } from './icons.mjs';

export const h = html;

export function pctClass(value) {
  const n = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  return `pct-${n}`;
}

export function pageHead(title, subtitle = '', actions = [], { tools = [] } = {}) {
  return html`<div class="page-head">
    <div class="page-head-text">
      <h1>${title}</h1>
      ${subtitle ? html`<p>${subtitle}</p>` : ''}
    </div>
    <div class="page-head-side">
      ${tools.length ? html`<div class="page-head-tools">${tools}</div>` : ''}
      ${actions.length ? html`<div class="page-actions">${actions}</div>` : ''}
    </div>
  </div>`;
}

export function btn(label, { href, variant = 'primary', icon: ic, type = 'button', name, value, size = '', attrs = '', submit = false } = {}) {
  const cls = `btn btn-${variant}${size ? ' btn-' + size : ''}`;
  const inner = html`${ic ? icon(ic, { size: 16 }) : ''}<span>${label}</span>`;
  if (href) return html`<a class="${cls}" href="${href}" ${raw(attrs)}>${inner}</a>`;
  return html`<button class="${cls}" type="${submit ? 'submit' : type}" ${name ? raw(`name="${e(name)}" value="${e(value ?? '')}"`) : ''} ${raw(attrs)}>${inner}</button>`;
}

export function badge(text, tone = 'muted', { dot = false } = {}) {
  return html`<span class="badge badge-${tone}">${dot ? html`<i class="dot"></i>` : ''}${text}</span>`;
}

export function statusBadge(status) {
  const rawStatus = typeof status === 'string' || typeof status === 'number' ? String(status) : '';
  const s = rawStatus.toLowerCase();
  const map = {
    active: ['ok', 'Active'], running: ['ok', 'Running'], complete: ['ok', 'Complete'], enabled: ['ok', 'Enabled'],
    open: ['brand', 'Open'], 'in progress': ['warn', 'In progress'], answered: ['ok', 'Answered'],
    suspended: ['danger', 'Suspended'], stopped: ['danger', 'Stopped'], failed: ['danger', 'Failed'],
    pending: ['warn', 'Pending'], warning: ['warn', 'Warning'], free: ['muted', 'Free'],
    shared: ['brand', 'Shared'], server: ['ok', 'Server'], closed: ['muted', 'Closed'], expired: ['danger', 'Expired'],
  };
  const [tone, label] = map[s] || ['muted', rawStatus || '—'];
  return badge(label, tone, { dot: true });
}

export function card(title, body, { actions = [], sub = '', padded = true, cls = '', id = '' } = {}) {
  return html`<section class="card ${cls}" ${id ? raw(`id="${e(id)}"`) : ''}>
    ${title ? html`<header class="card-head">
      <div><h2>${title}</h2>${sub ? html`<p>${sub}</p>` : ''}</div>
      ${actions.length ? html`<div class="card-actions">${actions}</div>` : ''}
    </header>` : ''}
    <div class="card-body${padded ? '' : ' flush'}">${body}</div>
  </section>`;
}

export function statCard({ label, value, sub = '', icon: ic = 'chart', tone = 'brand', href = '', trend = null }) {
  const trendHtml = trend === null ? '' : html`<span class="stat-trend ${trend >= 0 ? 'up' : 'down'}">${trend >= 0 ? '▲' : '▼'} ${Math.abs(trend)}%</span>`;
  const inner = html`<div class="stat-icon tone-${tone}">${icon(ic, { size: 20 })}</div>
      <div class="stat-body">
        <span class="stat-label">${label}</span>
        <strong class="stat-value">${value}</strong>
        <span class="stat-sub">${sub} ${trendHtml}</span>
      </div>`;
  return href
    ? html`<a class="stat-card" href="${href}">${inner}</a>`
    : html`<div class="stat-card">${inner}</div>`;
}

export function progress(used, total, { label = '', tone = '', showText = true } = {}) {
  const p = pct(used, total);
  const cls = tone || (p > 90 ? 'danger' : p > 75 ? 'warn' : '');
  return html`<div class="progress-wrap">
    <div class="progress ${cls}"><span class="${pctClass(p)}"></span></div>
    ${showText ? html`<div class="progress-text"><span>${formatBytes(used)}</span><span>${total ? formatBytes(total) : 'unlimited'}${label ? ' · ' + label : ''}</span></div>` : ''}
  </div>`;
}

const FORBIDDEN_EMPTY = /^(Nothing here yet|Nothing yet|No results)\.?$/i;

function safeEmptyMessage(value) {
  if (value === null || value === undefined || value === '') return '';
  const text = typeof value === 'string' ? value : (value && value.__raw ? String(value.value) : '');
  if (!text.trim()) return '';
  if (FORBIDDEN_EMPTY.test(text.trim()) || /^Brak:\s/i.test(text.trim())) return '';
  return value;
}

function tableCell(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number' && Number.isNaN(value)) return '—';
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return value.__raw ? value : '—';
  return value;
}

export function table({
  columns,
  rows,
  empty = '',
  emptyTitle = '',
  emptyAction = null,
  emptyKey = 'empty.table',
  rowKey = 'id',
  actions = [],
  selectable = false,
  label = 'Tabela danych',
  actionsLabel = 'Akcje',
  selectAllLabel = 'Zaznacz wszystkie wiersze',
  selectRowLabel = 'Zaznacz wiersz',
  cls = '',
  actionsMenu = false,
  menuLabel = 'Więcej',
  selectForm = '',
}) {
  if (!rows.length) {
    const message = safeEmptyMessage(empty);
    return emptyState(message, {
      title: emptyTitle,
      action: emptyAction,
      key: message ? '' : emptyKey,
    });
  }
  return html`<div class="table-wrap" tabindex="0" role="region" aria-label="${label}">
    <table class="data-table ${cls}">
      <thead><tr>
        ${selectable ? html`<th scope="col" class="col-check"><input type="checkbox" data-check-all ${selectForm ? raw(`form="${selectForm}"`) : ''} aria-label="${selectAllLabel}"></th>` : ''}
        ${columns.map((c) => html`<th scope="col" class="${c.align === 'right' ? 'ta-r' : ''}">${c.label}</th>`)}
        ${actions.length ? html`<th scope="col" class="col-actions">${actionsLabel}</th>` : ''}
      </tr></thead>
      <tbody>
        ${rows.map((row, rowIndex) => html`<tr>
          ${selectable ? html`<td class="col-check"><input type="checkbox" name="selected[]" value="${row[rowKey]}" ${selectForm ? raw(`form="${selectForm}"`) : ''} aria-label="${selectRowLabel} ${rowIndex + 1}"></td>` : ''}
          ${columns.map((c) => html`<td class="${c.align === 'right' ? 'ta-r' : ''} ${c.cls || ''}" data-label="${e(c.dataLabel || c.label || '')}">${tableCell(c.render ? c.render(row) : row[c.key])}</td>`)}
          ${actions.length ? html`<td class="col-actions">${actionsMenu ? html`<div class="row-actions"><details class="more-menu"><summary class="btn btn-ghost btn-sm" role="button" aria-label="${menuLabel}">${menuLabel}</summary><div class="more-menu-list">${actions.map((a) => {
            if (a.show && !a.show(row)) return '';
            const actionLabel = typeof a.label === 'function' ? a.label(row) : (a.label || actionsLabel);
            if (a.form) {
              const confirmText = typeof a.confirm === 'function' ? a.confirm(row) : a.confirm;
              return html`<form method="post" action="${a.form(row)}" class="inline" ${confirmText ? raw(`data-confirm="${e(confirmText)}"`) : ''}><button type="submit" class="menu-item ${a.danger ? 'danger' : ''}">${icon(a.icon || 'trash', { size: 15 })} ${e(actionLabel)}</button></form>`;
            }
            return html`<a class="menu-item${a.danger ? ' danger' : ''}" href="${typeof a.href === 'function' ? a.href(row) : a.href}">${icon(a.icon || 'edit', { size: 15 })} ${e(actionLabel)}</a>`;
          })}</div></details></div>` : html`<div class="row-actions">${actions.map((a) => {
            if (a.show && !a.show(row)) return '';
            const actionLabel = typeof a.label === 'function' ? a.label(row) : (a.label || actionsLabel);
            if (a.form) {
              const confirmText = typeof a.confirm === 'function' ? a.confirm(row) : a.confirm;
              return html`<form method="post" action="${a.form(row)}" class="inline" ${confirmText ? raw(`data-confirm="${e(confirmText)}"`) : ''}>
                <button type="submit" class="icon-btn ${a.danger ? 'danger' : ''}" title="${actionLabel}" aria-label="${actionLabel}">${icon(a.icon || 'trash', { size: 16 })}<span class="action-text">${e(actionLabel)}</span></button>
              </form>`;
            }
            return html`<a class="icon-btn${a.danger ? ' danger' : ''}" href="${typeof a.href === 'function' ? a.href(row) : a.href}" title="${actionLabel}" aria-label="${actionLabel}">${icon(a.icon || 'edit', { size: 16 })}<span class="action-text">${e(actionLabel)}</span></a>`;
          })}</div>`}</td>` : ''}
        </tr>`)}
      </tbody>
    </table>
  </div>`;
}

export function emptyState(message, { icon: ic = 'folder', action = null, title = '', key = '', titleKey = '', state = 'empty' } = {}) {
  const safeMessage = safeEmptyMessage(message);
  const fallback = safeMessage || 'Dane pojawią się po dodaniu pierwszego elementu.';
  const messageKey = key || (safeMessage ? '' : 'empty.table');
  return html`<div class="empty" role="status" data-state="${state}">
    <div class="empty-icon">${icon(ic, { size: 26 })}</div>
    ${title ? html`<strong class="empty-title" ${titleKey ? raw(`data-i18n="${e(titleKey)}"`) : ''}>${title}</strong>` : ''}
    <p ${messageKey ? raw(`data-i18n="${e(messageKey)}"`) : ''}>${fallback}</p>
    ${action ? html`<div class="empty-action">${action}</div>` : ''}
  </div>`;
}

/** Empty/loading/error/stale/partial state contract shared by feature pages.
 *  Every variant has a stable `data-state`, an accessible role, a localized
 *  message key and an optional recovery action. */
export function statePanel(state, {
  title = '',
  message = '',
  hint = '',
  action = null,
  retryHref = '',
  retryLabel = 'Try again',
  meta = '',
  icon: ic = '',
} = {}) {
  const variants = {
    loading: { icon: 'clock', role: 'status', live: 'polite', key: 'state.loading', hintKey: 'state.loadingHint', fallback: 'Ładowanie danych…', fallbackHint: 'Poczekaj, aż panel pobierze aktualny stan.' },
    empty: { icon: 'folder', role: 'status', live: '', key: 'empty.table', hintKey: 'empty.tableHint', fallback: 'Dane pojawią się po dodaniu pierwszego elementu.', fallbackHint: 'Dodaj element lub zmień filtr, aby zobaczyć wyniki.' },
    error: { icon: 'alertCircle', role: 'alert', live: '', key: 'state.error', hintKey: 'state.errorHint', fallback: 'Nie udało się pobrać danych.', fallbackHint: 'Spróbuj ponownie. Jeśli błąd się powtarza, sprawdź logi serwera.' },
    unavailable: { icon: 'alertCircle', role: 'alert', live: '', key: 'state.unavailable', hintKey: 'state.unavailableHint', fallback: 'Dane są chwilowo niedostępne.', fallbackHint: 'Źródło danych nie odpowiedziało. Odśwież widok za chwilę.' },
    permission: { icon: 'lock', role: 'alert', live: '', key: 'state.permission', hintKey: 'state.permissionHint', fallback: 'Nie masz uprawnień do tego widoku.', fallbackHint: 'Poproś administratora o odpowiedni zakres uprawnień.' },
    dependency: { icon: 'plug', role: 'alert', live: '', key: 'state.dependency', hintKey: 'state.dependencyHint', fallback: 'Brak wymaganej zależności.', fallbackHint: 'Zainstaluj brakujący komponent lub skontaktuj się z administratorem.' },
    stale: { icon: 'refresh', role: 'status', live: 'polite', key: 'state.stale', hintKey: 'state.staleHint', fallback: 'Dane mogą być nieaktualne.', fallbackHint: 'Ostatni pomiar jest starszy niż oczekiwany. Odśwież dane.' },
    partial: { icon: 'alertCircle', role: 'status', live: 'polite', key: 'state.partial', hintKey: 'state.partialHint', fallback: 'Część danych jest niedostępna.', fallbackHint: 'Widok pokazuje tylko źródła, które odpowiedziały. Sprawdź szczegóły.' },
  };
  const variant = variants[state] ? state : 'unavailable';
  const v = variants[variant];
  const resolvedAction = action || (retryHref ? html`<a class="btn btn-secondary btn-sm" href="${retryHref}">${icon('refresh', { size: 15 })} <span>${retryLabel}</span></a>` : null);
  const body = message || v.fallback;
  const hintText = hint || v.fallbackHint;
  return html`<section class="empty state-panel state-${variant}" role="${v.role}" data-state="${variant}" ${v.live ? raw(`aria-live="${v.live}"`) : ''} ${variant === 'loading' ? raw('aria-busy="true"') : ''}>
    <div class="empty-icon">${icon(ic || v.icon, { size: 26 })}</div>
    ${title ? html`<strong class="empty-title">${title}</strong>` : ''}
    <p ${!message ? raw(`data-i18n="${v.key}"`) : ''}>${body}</p>
    ${hintText ? html`<p class="small muted" ${!hint ? raw(`data-i18n="${v.hintKey}"`) : ''}>${hintText}</p>` : ''}
    ${meta ? html`<p class="small muted">${meta}</p>` : ''}
    ${resolvedAction ? html`<div class="empty-action">${resolvedAction}</div>` : ''}
  </section>`;
}

/** Escape a plain alert string but restore the handful of inline tags that
 *  feature pages deliberately write (`<code>`, `<strong>`, `<br>`, …). Only
 *  the tag names below are restored; attributes and all other markup stay
 *  escaped, so user-provided values cannot inject HTML. */
function inlineAlert(value) {
  const escaped = String(value ?? '')
    // Keep already-written entities such as &lt;domain&gt; displayable, but
    // escape every raw ampersand the feature author did not intend as markup.
    .replace(/&(?!(?:lt|gt|amp|quot|nbsp|#39);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return escaped.replace(/&lt;(\/?)(strong|b|em|i|code|small|span|br)\s*\/?&gt;/gi, '<$1$2>');
}

export function alert(message, tone = 'info', { title = '' } = {}) {
  const icons = { info: 'info', ok: 'checkCircle', warn: 'alertCircle', danger: 'alertCircle', success: 'checkCircle' };
  const role = tone === 'danger' || tone === 'warn' ? 'alert' : 'status';
  const body = message && message.__raw ? message : raw(inlineAlert(message));
  return html`<div class="alert alert-${tone}" role="${role}">${icon(icons[tone] || 'info', { size: 18 })}
    <div>${title ? html`<strong>${title}</strong>` : ''}<div>${body}</div></div></div>`;
}

let fieldSequence = 0;

function fieldSlug(value) {
  return String(value || 'field')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'field';
}

function applyDescribedBy(attrs, describedBy) {
  if (!describedBy) return attrs || '';
  const base = String(attrs || '');
  const existing = base.match(/aria-describedby\s*=\s*("([^"]*)"|'([^']*)')/i);
  if (existing) {
    const value = existing[2] !== undefined ? existing[2] : existing[3];
    const merged = `${value} ${describedBy}`.trim();
    return base.replace(existing[0], `aria-describedby="${e(merged)}"`);
  }
  return `${base} aria-describedby="${e(describedBy)}"`;
}

export function field(f) {
  const id = f.id ? String(f.id) : `f_${fieldSlug(f.name)}_${++fieldSequence}`;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [f.describedby, f.help ? helpId : '', f.error ? errorId : ''].filter(Boolean).join(' ');
  const required = !!f.required;
  const invalid = !!f.error;
  let commonAttrs = [
    f.attrs || '',
    `id="${e(id)}"`,
    `name="${e(f.name)}"`,
    required ? 'required aria-required="true"' : '',
    f.disabled ? 'disabled' : '',
    f.placeholder ? `placeholder="${e(f.placeholder)}"` : '',
    f.autocomplete && f.type !== 'password' ? `autocomplete="${e(f.autocomplete)}"` : '',
    invalid ? 'aria-invalid="true"' : '',
    invalid ? `aria-errormessage="${e(errorId)}"` : '',
  ].filter(Boolean).join(' ');
  commonAttrs = applyDescribedBy(commonAttrs, describedBy);

  const help = f.help ? html`<p class="field-help" id="${helpId}">${f.help} <a class="field-help-link" href="/help" aria-label="Pomoc i dokumentacja">?</a></p>` : '';
  const error = f.error ? html`<p class="field-error" id="${errorId}" role="alert">${f.error}</p>` : '';
  const requiredMark = required ? html`<span class="req" aria-hidden="true">*</span>` : '';

  if (f.type === 'hidden') {
    return html`<input type="hidden" id="${id}" name="${e(f.name)}" value="${f.value ?? ''}" ${f.attrs ? raw(f.attrs) : ''}>`;
  }

  if (f.type === 'html') {
    return html`<div class="field field-full">${f.value}</div>`;
  }

  if (f.type === 'static') {
    return html`<div class="field ${f.full ? 'field-full' : ''} ${f.cls || ''}" data-field="${e(f.name || '')}">
      <span class="field-label" id="${id}-label">${f.label}${requiredMark}</span>
      <div class="field-control"><div class="static-value" aria-labelledby="${id}-label">${f.value ?? '—'}</div>${f.suffix ? html`<span class="field-suffix">${f.suffix}</span>` : ''}</div>
      ${help}${error}
    </div>`;
  }

  if (f.type === 'checkbox') {
    return html`<div class="field ${f.full ? 'field-full' : ''} ${f.cls || ''}" data-field="${e(f.name || '')}">
      <label class="check-field" for="${id}">
        <input type="checkbox" ${raw(commonAttrs)} value="1" ${f.value ? raw('checked') : ''}>
        <span>${f.label}${requiredMark}</span>
      </label>
      ${help}${error}
    </div>`;
  }

  if (f.type === 'radio') {
    const groupDescribedBy = applyDescribedBy('', describedBy);
    return html`<fieldset id="${id}-group" class="field ${f.full ? 'field-full' : ''} ${f.cls || ''}" ${raw(groupDescribedBy)} data-field="${e(f.name || '')}">
      <legend class="field-label">${f.label}${requiredMark}</legend>
      <div class="radio-row">${(f.options || []).map((o, index) => {
        const optionId = `${id}-${index + 1}`;
        const value = typeof o === 'string' ? o : o.value;
        const label = typeof o === 'string' ? o : o.label;
        return html`<label class="radio" for="${optionId}"><input type="radio" id="${optionId}" name="${e(f.name)}" value="${e(value)}" ${String(f.value) === String(value) ? raw('checked') : ''} ${required ? raw('aria-required="true"') : ''}> <span>${label}</span></label>`;
      })}</div>
      ${help}${error}
    </fieldset>`;
  }

  let control;
  switch (f.type) {
    case 'textarea':
      control = html`<textarea ${raw(commonAttrs)} rows="${f.rows || 5}">${f.value ?? ''}</textarea>`;
      break;
    case 'select':
      control = html`<select ${raw(commonAttrs)}>
        ${(f.options || []).map((o) => {
          const val = typeof o === 'string' ? o : o.value;
          const label = typeof o === 'string' ? o : o.label;
          return html`<option value="${e(val)}" ${String(f.value) === String(val) ? raw('selected') : ''}>${label}</option>`;
        })}
      </select>`;
      break;
    case 'password':
      control = html`<input type="password" ${raw(commonAttrs)} value="${f.value ?? ''}" autocomplete="new-password">`;
      break;
    case 'number':
      control = html`<input type="number" ${raw(commonAttrs)} value="${f.value ?? ''}" ${f.min !== undefined ? raw(`min="${f.min}"`) : ''} ${f.max !== undefined ? raw(`max="${f.max}"`) : ''} step="${f.step || 1}">`;
      break;
    default:
      control = html`<input type="${f.type || 'text'}" ${raw(commonAttrs)} value="${f.value ?? ''}">`;
  }

  return html`<div class="field ${f.full ? 'field-full' : ''} ${f.cls || ''}" data-field="${e(f.name || '')}">
    <label class="field-label" for="${id}">${f.label}${requiredMark}</label>
    <div class="field-control">${control}${f.suffix ? html`<span class="field-suffix">${f.suffix}</span>` : ''}</div>
    ${help}${error}
  </div>`;
}

export function form(fields, {
  action,
  method = 'post',
  csrf = '',
  submit = 'Save changes',
  submitKey = '',
  cancel = '',
  cancelLabel = 'Cancel',
  cancelKey = '',
  enctype = '',
  cls = '',
  label = '',
  errors = [],
} = {}) {
  const effectiveSubmitKey = submitKey || (submit === 'Save changes' ? 'common.saveChanges' : '');
  const effectiveCancelKey = cancelKey || (cancelLabel === 'Cancel' ? 'common.cancel' : '');
  const submitAttr = effectiveSubmitKey ? raw(`data-i18n="${e(effectiveSubmitKey)}"`) : '';
  const cancelAttr = effectiveCancelKey ? raw(`data-i18n="${e(effectiveCancelKey)}"`) : '';
  const hasRequired = fields.some((entry) => entry && (entry.required || (entry.__raw && /class="req"/.test(String(entry.value)))));
  return html`<form class="oa-form ${cls}" method="${method}" action="${action}" ${label ? raw(`aria-label="${e(label)}"`) : ''} ${enctype ? raw(`enctype="${e(enctype)}"`) : ''}>
    ${csrf ? html`<input type="hidden" name="_csrf" value="${csrf}">` : ''}
    ${errors.length ? html`<div class="alert alert-danger" role="alert"><strong data-i18n="form.errorSummary">Popraw zaznaczone pola.</strong><ul class="small">${errors.map((message) => html`<li>${message}</li>`)}</ul></div>` : ''}
    ${hasRequired ? html`<p class="field-help small" data-i18n="form.requiredHint">Pola oznaczone gwiazdką są wymagane.</p>` : ''}
    <div class="form-grid">${fields.map((f) => (f && f.__raw ? f : field(f)))}</div>
    <div class="form-actions">
      <button class="btn btn-primary" type="submit">${icon('save', { size: 16 })}<span ${submitAttr}>${submit}</span></button>
      ${cancel ? html`<a class="btn btn-ghost" href="${cancel}"><span ${cancelAttr}>${cancelLabel}</span></a>` : ''}
    </div>
  </form>`;
}

export function tabs(items, active, { base = '', label = 'Sections' } = {}) {
  return html`<nav class="tabs" aria-label="${label}" data-i18n-aria-label="a11y.sections">${items.map((t) => html`<a class="tab ${t.key === active ? 'active' : ''}" href="${t.href || base + '?tab=' + t.key}" ${t.key === active ? raw('aria-current="page"') : ''}>${t.label}${t.count !== undefined ? html`<span class="tab-count">${t.count}</span>` : ''}</a>`)}</nav>`;
}

export function toolbar(left = [], right = [], { sticky = false, cls = '' } = {}) {
  return html`<div class="toolbar ${sticky ? 'toolbar-sticky' : ''} ${cls}"><div class="toolbar-left">${left}</div><div class="toolbar-right">${right}</div></div>`;
}

export function sparkline(points, { width = 640, height = 120, color = 'var(--brand)' } = {}) {
  const data = points.map(Number);
  if (!data.length) return raw('');
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = Math.max(max - min, 1);
  const stepX = width / Math.max(data.length - 1, 1);
  const coords = data.map((v, i) => [i * stepX, height - ((v - min) / span) * (height - 16) - 8]);
  const path = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${path} L${width},${height} L0,${height} Z`;
  return raw(`<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Wykres trendu">
    <defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity=".25"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#sg)"/><path d="${path}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>
  </svg>`);
}

export function donut(segments, { size = 148, thickness = 16, center = '' } = {}) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const circles = segments.map((s) => {
    const len = (s.value / total) * c;
    const el = raw(`<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${thickness}" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${size / 2} ${size / 2})"/>`);
    offset += len;
    return el;
  });
  return html`<div class="donut-wrap">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--surface-3)" stroke-width="${thickness}"/>
      ${circles}
    </svg>
    ${center ? html`<div class="donut-center">${center}</div>` : ''}
  </div>`;
}

export function kvList(pairs, { cols = 2 } = {}) {
  return html`<dl class="kv kv-cols-${Math.max(1, Math.min(4, Number(cols) || 2))}">${pairs.map(([k, v]) => html`<div class="kv-row"><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`;
}

export function modal(id, title, body, { footer = '', size = '', sub = '', closeLabel = 'Close dialog' } = {}) {
  return html`<div class="modal-backdrop" id="${id}" hidden>
    <div class="modal ${size}" role="dialog" aria-modal="true" aria-labelledby="${id}-title" ${sub ? raw(`aria-describedby="${id}-sub"`) : ''} tabindex="-1">
      <header class="modal-head">
        <div><h3 id="${id}-title">${title}</h3>${sub ? html`<p class="modal-sub" id="${id}-sub">${sub}</p>` : ''}</div>
        <button class="icon-btn" type="button" data-close-modal aria-label="${closeLabel}" title="${closeLabel}" data-i18n-aria-label="a11y.closeDialog" data-i18n-title="a11y.closeDialog">${icon('x', { size: 18 })}</button>
      </header>
      <div class="modal-body">${body}</div>
      ${footer ? html`<footer class="modal-foot">${footer}</footer>` : ''}
    </div>
  </div>`;
}

export function drawer(id, title, body, { footer = '', side = 'right', width = '', closeLabel = 'Close panel' } = {}) {
  return html`<div class="drawer-backdrop" id="${id}" hidden data-drawer-side="${side}">
    <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="${id}-title" tabindex="-1">
      <header class="drawer-head">
        <h3 id="${id}-title">${title}</h3>
        <button class="icon-btn" type="button" data-close-drawer aria-label="${closeLabel}" title="${closeLabel}" data-i18n-aria-label="a11y.closePanel" data-i18n-title="a11y.closePanel">${icon('x', { size: 18 })}</button>
      </header>
      <div class="drawer-body">${body}</div>
      ${footer ? html`<footer class="drawer-foot">${footer}</footer>` : ''}
    </aside>
  </div>`;
}

export function copyValue(value, label = '') {
  const copyLabel = String(label || 'value');
  return html`<span class="copy-value"><code>${value}</code><button class="icon-btn" type="button" data-copy="${value}" title="Copy ${copyLabel}" aria-label="Copy ${copyLabel}">${icon('copy', { size: 14 })}</button></span>`;
}

/* ------------------------------------------------------- guided flows */

export function wizardSteps(steps, active = 0, { label = 'Setup progress' } = {}) {
  const list = steps || [];
  return html`<ol class="wizard-steps" aria-label="${label}">${list.map((step, i) => {
    const s = typeof step === 'string' ? { label: step } : step;
    const state = i < active ? 'is-done' : i === active ? 'is-active' : 'is-upcoming';
    return html`<li class="wizard-step ${state}" ${i === active ? raw('aria-current="step"') : ''}>
      <span class="wizard-step-marker">${i < active ? icon('check', { size: 14 }) : i + 1}</span>
      <span class="wizard-step-copy"><strong>${s.label}</strong>${s.hint ? html`<small>${s.hint}</small>` : ''}</span>
    </li>`;
  })}</ol>`;
}

export function engineChoice(engines, selected, { name = 'engine', legend = 'Web server', help = '', submitLabel = 'Continue' } = {}) {
  return html`<fieldset class="engine-fieldset">
    <legend class="field-label">${legend}</legend>
    ${help ? html`<p class="field-help">${help}</p>` : ''}
    <div class="engine-grid">${(engines || []).map((engine) => {
      const key = engine.key || engine.value;
      return html`<label class="engine-card ${String(selected) === String(key) ? 'is-selected' : ''}" data-engine="${key}">
        <input type="radio" name="${name}" value="${key}" ${String(selected) === String(key) ? raw('checked') : ''}>
        <span class="engine-head">
          <span class="engine-logo">${icon(engine.icon || 'server', { size: 20 })}</span>
          <span class="engine-name">${engine.label}</span>
          <span class="engine-check" aria-hidden="true">${icon('check', { size: 13 })}</span>
        </span>
        ${engine.desc ? html`<span class="engine-desc">${engine.desc}</span>` : ''}
        ${engine.meta ? html`<span class="engine-meta">${engine.meta}</span>` : ''}
      </label>`;
    })}</div>
  </fieldset>`;
}

export function provisionStatus({ state = 'pending', title = 'Provisioning', detail = '', steps = [], progress = null, live = false } = {}) {
  const tone = ['pending', 'running', 'success', 'error'].includes(state) ? state : 'pending';
  return html`<section class="provision-status is-${tone}" data-provision-status="${tone}" role="status" ${live ? raw('aria-live="polite"') : ''}>
    <span class="provision-indicator" aria-hidden="true">${tone === 'success' ? icon('checkCircle', { size: 18 }) : tone === 'error' ? icon('alertCircle', { size: 18 }) : html`<span class="provision-spinner"></span>`}</span>
    <div class="provision-copy">
      <strong>${title}</strong>
      ${detail ? html`<p>${detail}</p>` : ''}
      ${progress !== null ? html`<div class="progress mt-10"><span class="${pctClass(progress)}"></span></div>` : ''}
      ${steps.length ? html`<ul class="provision-steps">${steps.map((step) => {
        const s = typeof step === 'string' ? { label: step } : step;
        return html`<li class="provision-step is-${s.state || 'pending'}"><span class="status-dot"></span><span>${s.label}</span>${s.meta ? html`<small>${s.meta}</small>` : ''}</li>`;
      })}</ul>` : ''}
    </div>
  </section>`;
}

export function skeleton(lines = 3, { cls = '', width = '' } = {}) {
  return html`<div class="skeleton-stack ${cls}" aria-hidden="true">
    ${Array.from({ length: Math.max(1, Number(lines) || 1) }, (_, i) => html`<span class="skeleton skeleton-line ${pctClass([92, 78, 86, 64][i % 4])}"></span>`)}
  </div>`;
}

export function livePill(label = 'Live', { state = '', url = '', interval = 60, meta = '' } = {}) {
  return html`<span class="live-pill ${state ? 'is-' + state : ''}" role="status" ${url ? raw(`data-live-url="${e(url)}" data-live-interval="${Number(interval) || 60}"`) : ''}>
    <span class="live-dot" aria-hidden="true"></span><span class="live-label">${label}</span>${meta ? html`<span class="live-meta">${meta}</span>` : ''}
  </span>`;
}
