// Shared dashboard widgets.
import { html as h, formatBytes, pct, timeAgo, formatDate } from '../../util.mjs';
import { card, statCard, progress, sparkline, donut, badge, statusBadge, btn, kvList } from '../components.mjs';
import { icon } from '../icons.mjs';

export function usageChartCard(series, { title = 'Bandwidth usage', sub = 'Last 30 days', metric = 'bandwidth_mb' } = {}) {
  const points = series.map((r) => Number(r[metric]) || 0);
  const total = points.reduce((a, b) => a + b, 0);
  const peak = Math.max(...points, 0);
  return card(title, h`
    <div class="spread mb-12">
      <div><div class="stat-value">${formatBytes(total)}</div><div class="small muted">total · avg ${formatBytes(total / Math.max(points.length, 1))}/day</div></div>
      <div class="ta-r"><div class="stat-value">${formatBytes(peak)}</div><div class="small muted">peak day</div></div>
    </div>
    ${sparkline(points)}
    <div class="spread small muted mt-10"><span>${series[0]?.day || ''}</span><span>${series.at(-1)?.day || ''}</span></div>
  `, { sub, actions: [h`<a class="link small" href="/user/statistics">Details</a>`] });
}

export function quotaCard({ title, used, limit, unit = 'MB', sub = '' }) {
  const p = pct(used, limit);
  return h`<div class="quota-row">
    <div class="spread"><span class="small" style="font-weight:600">${title}</span><span class="small muted">${used} / ${limit || '∞'} ${unit}</span></div>
    <div class="progress ${p > 90 ? 'danger' : p > 75 ? 'warn' : ''}" style="margin-top:6px"><span style="width:${p}%"></span></div>
    ${sub ? h`<div class="small muted" style="margin-top:4px">${sub}</div>` : ''}
  </div>`;
}

export function activityFeed(items) {
  return card('Recent activity', h`<div class="timeline">${items.map((i) => h`<div class="timeline-item">
    <div class="timeline-dot">${icon(i.icon || 'check', { size: 15 })}</div>
    <div class="timeline-body"><div>${i.text}</div><small>${i.meta || ''}</small></div>
  </div>`)}</div>`);
}

export function serviceRow(name, status, meta = '') {
  return h`<div class="service-row">
    <span class="service-dot ${status === 'running' ? 'on' : 'off'}"></span>
    <strong>${name}</strong><span class="small muted">${meta}</span>
    <span style="margin-left:auto">${statusBadge(status)}</span>
  </div>`;
}

export function greeting(user) {
  const hour = new Date().getHours();
  const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${user.username}`;
}

export { formatBytes, formatDate, timeAgo, badge, btn, kvList, donut };
