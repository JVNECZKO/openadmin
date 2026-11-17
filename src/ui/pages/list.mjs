// Generic list + form page renderers used across resources.
import { html as h, raw, e, formatDate } from '../../util.mjs';
import { card, table, form, btn, toolbar, alert, pageHead, emptyState } from '../components.mjs';
import { icon } from '../icons.mjs';

export function listCard({
  title, sub = '', columns, rows, actions = [], createHref, createLabel = 'Create', empty = 'Nothing here yet',
  filter = null, toolbarLeft = [], toolbarRight = [], footer = '', selectable = false, flush = true, id = '', responsive = false, actionsMenu = false, selectForm = '',
}) {
  const tools = [];
  if (filter) {
    tools.push(h`<div class="search">${icon('search', { size: 15 })}<input class="u-s110" type="search" placeholder="${filter.placeholder || 'Filter…'}" data-filter-input="#${filter.target || 'dataTable'}"></div>`);
  }
  tools.push(...toolbarLeft);
  const right = [];
  if (createHref) right.push(btn(createLabel, { href: createHref, icon: 'plus' }));
  right.push(...toolbarRight);
  const hasToolbar = tools.length || right.length;
  return card(title, h`
    ${hasToolbar ? toolbar(tools, right) : ''}
    <div id="${id || 'dataTable'}">${table({ columns, rows, actions, empty, selectable, cls: responsive ? 'responsive-table' : '', actionsMenu, selectForm })}</div>
    ${footer ? h`<div class="card-foot">${footer}</div>` : ''}
  `, { sub, padded: !flush, cls: 'list-card' });
}

export function formCard({ title, sub = '', fields, action, csrf, submit = 'Save', cancel = '', extra = '', description = '' }) {
  return card(title, h`${description ? h`<p class="small muted mb-18">${description}</p>` : ''}${form(fields, { action, csrf, submit, cancel })}${extra}`, { sub });
}

export function domainSelect(domains, selected, { action = '', label = 'Domain', includeAll = false, allLabel = 'Wszystkie domeny' } = {}) {
  if (!domains.length) return emptyState('No domains yet. Add a domain first.');
  return h`<div class="toolbar">
    <form method="get" action="${action}" class="row">
      <label class="field-label u-s11" for="domainSel">${label}</label>
      <select class="u-s15" id="domainSel" name="domain" data-domain-select>
        ${includeAll ? h`<option value="all" ${selected === 'all' ? raw('selected') : ''}>${allLabel}</option>` : ''}
        ${domains.map((d) => h`<option value="${d.name}" ${d.name === selected ? raw('selected') : ''}>${d.name}</option>`)}
      </select>
      <noscript><button class="btn btn-secondary btn-sm" type="submit">Switch</button></noscript>
    </form>
  </div>`;
}

export function statRow(items) {
  return h`<div class="stat-grid">${items.map((i) => h`<div class="stat-card">
    <div class="stat-icon tone-${i.tone || 'brand'}">${icon(i.icon || 'chart', { size: 20 })}</div>
    <div class="stat-body"><span class="stat-label">${i.label}</span><strong class="stat-value">${i.value}</strong><span class="stat-sub">${i.sub || ''}</span></div>
  </div>`)}</div>`;
}

export function simpleFormPage(ctx, { title, subtitle, fields, action, submit, cancel, description, extra }) {
  return {
    title, subtitle,
    body: h`${ctx.query.error ? alert(ctx.query.error, 'danger') : ''}${formCard({ title, sub: subtitle, fields, action, csrf: ctx.csrf, submit, cancel, description, extra })}`,
  };
}

export function dashList(title, rows, renderRow, { href, empty = 'Nothing yet', seeAll = 'View all' } = {}) {
  return card(title, rows.length
    ? h`<div class="timeline">${rows.map(renderRow)}</div>`
    : emptyState(empty), { actions: href ? [h`<a class="link small" href="${href}">${seeAll}</a>`] : [] });
}

export function dateCell(iso) {
  return h`<span class="small">${formatDate(iso)}</span>`;
}
void e;

export function paginate(rows, { page = 1, perPage = 25 } = {}) {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.max(1, Math.min(pages, Number(page) || 1));
  const start = (current - 1) * perPage;
  return { total, pages, page: current, perPage, items: rows.slice(start, start + perPage), from: total ? start + 1 : 0, to: Math.min(total, start + perPage) };
}

export function pagination({ base, page = 1, pages = 1, query = '', label = 'Paginacja' } = {}) {
  if (pages <= 1) return '';
  const href = (n) => `${base}${base.includes('?') ? '&' : '?'}${query ? `${query}&` : ''}page=${n}`;
  const nums = [];
  for (let n = Math.max(1, page - 2); n <= Math.min(pages, page + 2); n += 1) nums.push(n);
  return h`<nav class="pagination" aria-label="${label}">
    ${page > 1 ? h`<a class="btn btn-ghost btn-sm" href="${href(page - 1)}">← Poprzednia</a>` : ''}
    ${nums.map((n) => h`<a class="chip ${n === page ? 'active' : ''}" href="${href(n)}" ${n === page ? raw('aria-current="page"') : ''}>${n}</a>`)}
    ${page < pages ? h`<a class="btn btn-ghost btn-sm" href="${href(page + 1)}">Następna →</a>` : ''}
  </nav>`;
}
