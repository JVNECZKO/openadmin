// Reusable server-rendered UI components.
import { html, raw, e, formatBytes, pct } from '../util.mjs';
import { icon } from './icons.mjs';

export const h = html;

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
  const s = String(status || '').toLowerCase();
  const map = {
    active: ['ok', 'Active'], running: ['ok', 'Running'], complete: ['ok', 'Complete'], enabled: ['ok', 'Enabled'],
    open: ['brand', 'Open'], 'in progress': ['warn', 'In progress'], answered: ['ok', 'Answered'],
    suspended: ['danger', 'Suspended'], stopped: ['danger', 'Stopped'], failed: ['danger', 'Failed'],
    pending: ['warn', 'Pending'], warning: ['warn', 'Warning'], free: ['muted', 'Free'],
    shared: ['brand', 'Shared'], server: ['ok', 'Server'], closed: ['muted', 'Closed'], expired: ['danger', 'Expired'],
  };
  const [tone, label] = map[s] || ['muted', status || '—'];
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
    <div class="progress ${cls}"><span style="width:${p}%"></span></div>
    ${showText ? html`<div class="progress-text"><span>${formatBytes(used)}</span><span>${total ? formatBytes(total) : 'unlimited'}${label ? ' · ' + label : ''}</span></div>` : ''}
  </div>`;
}

export function table({ columns, rows, empty = 'Nothing here yet', rowKey = 'id', actions = [], selectable = false, label = 'Data table' }) {
  if (!rows.length) return emptyState(empty);
  return html`<div class="table-wrap" tabindex="0" role="region" aria-label="${label}">
    <table class="data-table">
      <thead><tr>
        ${selectable ? html`<th class="col-check"><input type="checkbox" data-check-all></th>` : ''}
        ${columns.map((c) => html`<th class="${c.align === 'right' ? 'ta-r' : ''}" ${c.width ? raw(`style="width:${e(c.width)}"`) : ''}>${c.label}</th>`)}
        ${actions.length ? html`<th class="col-actions">Actions</th>` : ''}
      </tr></thead>
      <tbody>
        ${rows.map((row) => html`<tr>
          ${selectable ? html`<td class="col-check"><input type="checkbox" name="selected[]" value="${row[rowKey]}"></td>` : ''}
          ${columns.map((c) => html`<td class="${c.align === 'right' ? 'ta-r' : ''} ${c.cls || ''}">${c.render ? c.render(row) : (row[c.key] ?? '—')}</td>`)}
          ${actions.length ? html`<td class="col-actions"><div class="row-actions">${actions.map((a) => {
            if (a.show && !a.show(row)) return '';
            if (a.form) {
              const confirmText = typeof a.confirm === 'function' ? a.confirm(row) : a.confirm;
              return html`<form method="post" action="${a.form(row)}" class="inline" ${confirmText ? raw(`data-confirm="${e(confirmText)}"`) : ''}>
                <button type="submit" class="icon-btn ${a.danger ? 'danger' : ''}" title="${a.label}" aria-label="${a.label}">${icon(a.icon || 'trash', { size: 16 })}</button>
              </form>`;
            }
            return html`<a class="icon-btn${a.danger ? ' danger' : ''}" href="${typeof a.href === 'function' ? a.href(row) : a.href}" title="${a.label}" aria-label="${a.label}">${icon(a.icon || 'edit', { size: 16 })}</a>`;
          })}</div></td>` : ''}
        </tr>`)}
      </tbody>
    </table>
  </div>`;
}

export function emptyState(message, { icon: ic = 'folder', action = null, title = '' } = {}) {
  return html`<div class="empty" role="status">
    <div class="empty-icon">${icon(ic, { size: 26 })}</div>
    ${title ? html`<strong class="empty-title">${title}</strong>` : ''}
    <p>${message}</p>
    ${action ? html`<div class="empty-action">${action}</div>` : ''}
  </div>`;
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

export function field(f) {
  const id = `f_${f.name}`;
  const common = raw(`id="${id}" name="${e(f.name)}" ${f.required ? 'required' : ''} ${f.disabled ? 'disabled' : ''} ${f.placeholder ? `placeholder="${e(f.placeholder)}"` : ''} ${f.attrs || ''}`);
  let control;
  switch (f.type) {
    case 'textarea':
      control = html`<textarea ${common} rows="${f.rows || 5}">${f.value ?? ''}</textarea>`;
      break;
    case 'select':
      control = html`<select ${common}>
        ${(f.options || []).map((o) => {
          const val = typeof o === 'string' ? o : o.value;
          const label = typeof o === 'string' ? o : o.label;
          return html`<option value="${val}" ${String(f.value) === String(val) ? raw('selected') : ''}>${label}</option>`;
        })}
      </select>`;
      break;
    case 'checkbox':
      return html`<label class="check-field" for="${id}">
        <input type="checkbox" ${common} value="1" ${f.value ? raw('checked') : ''}>
        <span>${f.label}</span>${f.help ? html`<em>${f.help}</em>` : ''}
      </label>`;
    case 'radio':
      return html`<div class="field">
        <label class="field-label">${f.label}</label>
        <div class="radio-row">${(f.options || []).map((o) => html`<label class="radio"><input type="radio" name="${f.name}" value="${o.value}" ${String(f.value) === String(o.value) ? raw('checked') : ''}> <span>${o.label}</span></label>`)}</div>
        ${f.help ? html`<p class="field-help">${f.help}</p>` : ''}
      </div>`;
    case 'static':
      control = html`<div class="static-value">${f.value ?? '—'}</div>`;
      break;
    case 'password':
      control = html`<input type="password" ${common} value="${f.value ?? ''}" autocomplete="new-password">`;
      break;
    case 'number':
      control = html`<input type="number" ${common} value="${f.value ?? ''}" ${f.min !== undefined ? raw(`min="${f.min}"`) : ''} ${f.max !== undefined ? raw(`max="${f.max}"`) : ''} step="${f.step || 1}">`;
      break;
    case 'hidden':
      return html`<input type="hidden" ${common} value="${f.value ?? ''}">`;
    case 'html':
      return html`<div class="field field-full">${f.value}</div>`;
    default:
      control = html`<input type="${f.type || 'text'}" ${common} value="${f.value ?? ''}" ${f.autocomplete ? raw(`autocomplete="${e(f.autocomplete)}"`) : ''}>`;
  }
  return html`<div class="field ${f.full ? 'field-full' : ''} ${f.cls || ''}">
    ${f.type !== 'hidden' ? html`<label class="field-label" for="${id}">${f.label}${f.required ? html`<span class="req">*</span>` : ''}</label>` : ''}
    <div class="field-control">${control}${f.suffix ? html`<span class="field-suffix">${f.suffix}</span>` : ''}</div>
    ${f.help ? html`<p class="field-help">${f.help}</p>` : ''}
  </div>`;
}

export function form(fields, { action, method = 'post', csrf = '', submit = 'Save changes', cancel = '', enctype = '', cls = '' } = {}) {
  return html`<form class="oa-form ${cls}" method="${method}" action="${action}" ${enctype ? raw(`enctype="${e(enctype)}"`) : ''}>
    ${csrf ? html`<input type="hidden" name="_csrf" value="${csrf}">` : ''}
    <div class="form-grid">${fields.map((f) => (f && f.__raw ? f : field(f)))}</div>
    <div class="form-actions">
      <button class="btn btn-primary" type="submit">${icon('save', { size: 16 })}<span>${submit}</span></button>
      ${cancel ? html`<a class="btn btn-ghost" href="${cancel}">Cancel</a>` : ''}
    </div>
  </form>`;
}

export function tabs(items, active, { base = '' } = {}) {
  return html`<nav class="tabs" aria-label="Sections">${items.map((t) => html`<a class="tab ${t.key === active ? 'active' : ''}" href="${t.href || base + '?tab=' + t.key}" ${t.key === active ? raw('aria-current="page"') : ''}>${t.label}${t.count !== undefined ? html`<span class="tab-count">${t.count}</span>` : ''}</a>`)}</nav>`;
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
  return raw(`<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img">
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
  return html`<dl class="kv" style="--kv-cols:${cols}">${pairs.map(([k, v]) => html`<div class="kv-row"><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`;
}

export function modal(id, title, body, { footer = '', size = '', sub = '' } = {}) {
  return html`<div class="modal-backdrop" id="${id}" hidden>
    <div class="modal ${size}" role="dialog" aria-modal="true" aria-labelledby="${id}-title">
      <header class="modal-head">
        <div><h3 id="${id}-title">${title}</h3>${sub ? html`<p class="modal-sub">${sub}</p>` : ''}</div>
        <button class="icon-btn" type="button" data-close-modal aria-label="Close dialog">${icon('x', { size: 18 })}</button>
      </header>
      <div class="modal-body">${body}</div>
      ${footer ? html`<footer class="modal-foot">${footer}</footer>` : ''}
    </div>
  </div>`;
}

export function drawer(id, title, body, { footer = '', side = 'right', width = '' } = {}) {
  return html`<div class="drawer-backdrop" id="${id}" hidden data-drawer-side="${side}">
    <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="${id}-title" ${width ? raw(`style="--drawer-w:${e(width)}"`) : ''}>
      <header class="drawer-head">
        <h3 id="${id}-title">${title}</h3>
        <button class="icon-btn" type="button" data-close-drawer aria-label="Close panel">${icon('x', { size: 18 })}</button>
      </header>
      <div class="drawer-body">${body}</div>
      ${footer ? html`<footer class="drawer-foot">${footer}</footer>` : ''}
    </aside>
  </div>`;
}

export function copyValue(value, label = '') {
  return html`<span class="copy-value"><code>${value}</code><button class="icon-btn" type="button" data-copy="${value}" title="Copy ${label}" aria-label="Copy ${label || 'value'}">${icon('copy', { size: 14 })}</button></span>`;
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
      ${progress !== null ? html`<div class="progress mt-10"><span style="width:${Math.max(0, Math.min(100, Number(progress) || 0))}%"></span></div>` : ''}
      ${steps.length ? html`<ul class="provision-steps">${steps.map((step) => {
        const s = typeof step === 'string' ? { label: step } : step;
        return html`<li class="provision-step is-${s.state || 'pending'}"><span class="status-dot"></span><span>${s.label}</span>${s.meta ? html`<small>${s.meta}</small>` : ''}</li>`;
      })}</ul>` : ''}
    </div>
  </section>`;
}

export function skeleton(lines = 3, { cls = '', width = '' } = {}) {
  return html`<div class="skeleton-stack ${cls}" aria-hidden="true" ${width ? raw(`style="max-width:${e(width)}"`) : ''}>
    ${Array.from({ length: Math.max(1, Number(lines) || 1) }, (_, i) => html`<span class="skeleton skeleton-line" style="width:${[92, 78, 86, 64][i % 4]}%"></span>`)}
  </div>`;
}

export function livePill(label = 'Live', { state = '', url = '', interval = 60, meta = '' } = {}) {
  return html`<span class="live-pill ${state ? 'is-' + state : ''}" role="status" ${url ? raw(`data-live-url="${e(url)}" data-live-interval="${Number(interval) || 60}"`) : ''}>
    <span class="live-dot" aria-hidden="true"></span><span class="live-label">${label}</span>${meta ? html`<span class="live-meta">${meta}</span>` : ''}
  </span>`;
}
