// Generic list + form page renderers used across resources.
import { html as h, raw, e, formatDate } from '../../util.mjs';
import { card, table, form, btn, toolbar, alert, pageHead, emptyState } from '../components.mjs';
import { icon } from '../icons.mjs';

export function listCard({
  title, sub = '', columns, rows, actions = [], createHref, createLabel = 'Create', empty = 'Nothing here yet',
  filter = null, toolbarLeft = [], toolbarRight = [], footer = '', selectable = false, flush = true, id = '',
}) {
  const tools = [];
  if (filter) {
    tools.push(h`<div class="search">${icon('search', { size: 15 })}<input type="search" placeholder="${filter.placeholder || 'Filter…'}" data-filter-input="#${filter.target || 'dataTable'}" style="padding-left:32px"></div>`);
  }
  tools.push(...toolbarLeft);
  const right = [];
  if (createHref) right.push(btn(createLabel, { href: createHref, icon: 'plus' }));
  right.push(...toolbarRight);
  const hasToolbar = tools.length || right.length;
  return card(title, h`
    ${hasToolbar ? toolbar(tools, right) : ''}
    <div id="${id || 'dataTable'}">${table({ columns, rows, actions, empty, selectable })}</div>
    ${footer ? h`<div class="card-foot">${footer}</div>` : ''}
  `, { sub, padded: !flush, cls: 'list-card' });
}

export function formCard({ title, sub = '', fields, action, csrf, submit = 'Save', cancel = '', extra = '', description = '' }) {
  return card(title, h`${description ? h`<p class="small muted mb-18">${description}</p>` : ''}${form(fields, { action, csrf, submit, cancel })}${extra}`, { sub });
}

export function domainSelect(domains, selected, { action = '', label = 'Domain' } = {}) {
  if (!domains.length) return emptyState('No domains yet. Add a domain first.');
  return h`<div class="toolbar">
    <form method="get" action="${action}" class="row">
      <label class="field-label" for="domainSel" style="margin:0">${label}</label>
      <select id="domainSel" name="domain" data-domain-select style="width:280px">
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
