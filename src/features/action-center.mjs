// Administrator Action Center: aggregated findings, evidence sources, mutes
// and a read-only preflight runner.
//
// This page never owns the underlying observations. It renders the snapshot
// produced by src/action-center.mjs and the typed checks produced by
// src/preflight.mjs, so another surface (dashboard, API, CLI) can reuse the
// exact same truth.
import { html as h, formatDate, timeAgo } from '../util.mjs';
import { audit } from '../db.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, emptyState, kvList, statCard, form, field, btn } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { formatBytesIEC } from '../metrics.mjs';
import {
  ACTION_CENTER_TYPES,
  SEVERITY_LABEL,
  collectActionCenter,
  collectApplicationFindings,
  muteFinding,
  unmuteFinding,
  safeActionCenterReturn,
} from '../action-center.mjs';
import {
  PREFLIGHT_KINDS,
  PREFLIGHT_LABELS,
  runPreflight,
  preflightSummary,
} from '../preflight.mjs';

const A = '/admin/action-center';
const APP_PROBE_TTL_MS = 60000;
let applicationCache = { at: 0, value: null };

const SEVERITY_TONE = { P0: 'danger', P1: 'warn', P2: 'brand' };
const PRIORITY_SHORT = { P0: 'Krytyczne', P1: 'Ważne', P2: 'Zalecenia' };
const SOURCE_TONE = { ok: 'ok', info: 'brand', partial: 'warn', unavailable: 'danger' };
const MUTE_HOURS = [1, 24, 72, 168, 720];

function sourceTone(status) {
  return SOURCE_TONE[status] || 'muted';
}

function severityTone(severity) {
  return SEVERITY_TONE[severity] || 'muted';
}

function filterState(query = {}) {
  const severity = ['P0', 'P1', 'P2'].includes(String(query.severity)) ? String(query.severity) : 'all';
  const type = Object.hasOwn(ACTION_CENTER_TYPES, String(query.type)) ? String(query.type) : 'all';
  const show = ['active', 'muted', 'all'].includes(String(query.show)) ? String(query.show) : 'active';
  const q = String(query.q || '').trim().slice(0, 120);
  return { severity, type, show, q };
}

function buildUrl(filters = {}, patch = {}) {
  const merged = { ...filters, ...patch };
  const params = new URLSearchParams();
  if (merged.severity && merged.severity !== 'all') params.set('severity', merged.severity);
  if (merged.type && merged.type !== 'all') params.set('type', merged.type);
  if (merged.show && merged.show !== 'active') params.set('show', merged.show);
  if (merged.q) params.set('q', merged.q);
  const text = params.toString();
  return text ? `${A}?${text}` : A;
}

function currentUrl(ctx) {
  return safeActionCenterReturn(ctx.path + (ctx.url?.search || ''));
}

function filteredItems(snapshot, filters) {
  const needle = filters.q.toLowerCase();
  return snapshot.items.filter((item) => {
    if (filters.severity !== 'all' && item.severity !== filters.severity) return false;
    if (filters.type !== 'all' && item.type !== filters.type) return false;
    if (filters.show === 'active' && item.muted) return false;
    if (filters.show === 'muted' && !item.muted) return false;
    if (needle) {
      const haystack = `${item.title} ${item.impact} ${item.recommendation} ${item.source} ${item.type}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

function muteControls(ctx, item, returnTo) {
  if (item.muted) {
    return h`<form method="post" action="${A}/unmute" class="inline-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <input type="hidden" name="key" value="${item.dedupeKey}">
      <input type="hidden" name="returnTo" value="${returnTo}">
      <button class="btn btn-ghost btn-sm" type="submit">${icon('refresh', { size: 15 })}<span>Przywróć</span></button>
    </form>`;
  }
  return h`<form method="post" action="${A}/mute" class="inline-form">
    <input type="hidden" name="_csrf" value="${ctx.csrf}">
    <input type="hidden" name="key" value="${item.dedupeKey}">
    <input type="hidden" name="returnTo" value="${returnTo}">
    <label class="small muted" for="mute-hours-${item.id}">Wycisz na</label>
    <select id="mute-hours-${item.id}" name="hours" aria-label="Czas wyciszenia">
      ${MUTE_HOURS.map((hours) => h`<option value="${hours}" ${hours === 24 ? 'selected' : ''}>${hours < 24 ? `${hours} h` : `${Math.round(hours / 24)} dni`}</option>`)}
    </select>
    <input name="reason" maxlength="200" placeholder="Powód (opcjonalnie)" aria-label="Powód wyciszenia">
    <button class="btn btn-ghost btn-sm" type="submit">${icon('clock', { size: 15 })}<span>Wycisz</span></button>
  </form>`;
}

function findingCard(ctx, item, returnTo) {
  const typeLabel = ACTION_CENTER_TYPES[item.type] || item.type;
  const muted = item.muted
    ? badge(`Wyciszone do ${item.muteUntil ? formatDate(item.muteUntil, { time: true }) : '—'}`, 'muted')
    : '';
  const body = h`
    <div class="row mb-12" style="gap:6px">
      ${badge(SEVERITY_LABEL[item.severity] || item.severity, severityTone(item.severity))}
      ${badge(typeLabel, 'muted')}
      ${muted}
    </div>
    <p><strong>Wpływ:</strong> ${item.impact || '—'}</p>
    <p><strong>Rekomendacja:</strong> ${item.recommendation || '—'}</p>
    ${kvList([
      ['Źródło', item.sourceDetail ? h`<span>${item.source} · ${item.sourceDetail}</span>` : item.source],
      ['Zaobserwowano', item.observedAt ? h`<span title="${formatDate(item.observedAt, { time: true })}">${timeAgo(item.observedAt)}</span>` : '—'],
    ])}
    <div class="row mt-18" style="align-items:flex-start">
      ${item.action ? btn(item.action.label, { href: item.action.href, icon: 'arrowRight' }) : ''}
      ${btn('Szczegóły', { href: item.detailsHref || A, variant: 'secondary', icon: 'list' })}
      <a class="link small" href="${buildUrl({}, { type: item.type, show: 'all' })}">Tylko ten typ</a>
      ${muteControls(ctx, item, returnTo)}
    </div>`;
  return card(item.title, body, {
    sub: item.muted && item.mutedBy ? `Wyciszone przez ${item.mutedBy}` : '',
  });
}

function sourcesCard(snapshot) {
  const rows = snapshot.sources.map((source) => h`<div class="service-row">
    <span class="service-dot ${source.status === 'ok' ? 'on' : source.status === 'partial' ? '' : 'off'}"></span>
    <strong>${source.label}</strong>
    <span class="small muted" style="margin-left:8px; min-width:0; overflow-wrap:anywhere">${source.detail || 'Brak dodatkowych informacji'}</span>
    <span style="margin-left:auto">${badge(source.status === 'ok' ? 'OK' : source.status === 'info' ? 'Zalecenie' : source.status === 'partial' ? 'Częściowe' : 'Niedostępne', sourceTone(source.status), { dot: true })}</span>
  </div>`);
  const notable = snapshot.sources.filter((source) => source.status !== 'ok' && source.status !== 'info').length;
  return card('Źródła danych', h`
    <p class="small muted">Każda pozycja ma jawne źródło i czas obserwacji. „Niedostępne” oznacza, że panel nie posiada danych — nie jest to zero ani sukces.</p>
    <div class="stack" style="gap:8px">${rows}</div>
    ${notable ? '' : h`<p class="small muted mt-12">Wszystkie źródła odpowiedziały w tym odczycie.</p>`}
  `, { sub: `${snapshot.sources.length} źródeł · ${notable} wymaga uwagi`, padded: true });
}

function filterCard(filters, counts) {
  const typeOptions = [
    { value: 'all', label: `Wszystkie typy (${counts.total})` },
    ...Object.entries(ACTION_CENTER_TYPES).map(([value, label]) => ({ value, label: `${label} (${counts.byType[value] || 0})` })),
  ];
  return card('Filtry', form([
    field({
      name: 'severity',
      label: 'Poziom',
      type: 'select',
      value: filters.severity,
      options: [
        { value: 'all', label: `Wszystkie (${counts.total})` },
        { value: 'P0', label: `Krytyczne — działaj teraz (${counts.bySeverity.P0 || 0})` },
        { value: 'P1', label: `Ważne — zaplanuj naprawę (${counts.bySeverity.P1 || 0})` },
        { value: 'P2', label: `Zalecenia (${counts.bySeverity.P2 || 0})` },
      ],
    }),
    field({
      name: 'type',
      label: 'Typ',
      type: 'select',
      value: filters.type,
      options: typeOptions,
    }),
    field({
      name: 'show',
      label: 'Widok',
      type: 'select',
      value: filters.show,
      options: [
        { value: 'active', label: `Aktywne (${counts.total})` },
        { value: 'muted', label: `Wyciszone (${counts.muted})` },
        { value: 'all', label: 'Wszystkie' },
      ],
    }),
    field({
      name: 'q',
      label: 'Szukaj',
      type: 'search',
      value: filters.q,
      placeholder: 'tytuł, wpływ, źródło',
    }),
  ], {
    action: A,
    method: 'get',
    submit: 'Filtruj',
    cancel: A,
    cancelLabel: 'Wyczyść',
    cls: 'action-center-filters',
  }), { sub: 'Filtry działają po stronie serwera — stan można udostępnić linkiem.', padded: true });
}

function preflightResultCard(result) {
  const summary = preflightSummary(result);
  const tone = summary.blocked ? 'danger' : summary.ok ? 'ok' : 'warn';
  const label = summary.blocked
    ? 'Operacja zablokowana — popraw warunki oznaczone jako blokujące.'
    : summary.ok
      ? 'Wszystkie warunki spełnione. To nie wykonuje operacji — to tylko bramka.'
      : 'Operacja może się udać, ale są ostrzeżenia. Sprawdź warunki nieblokujące.';
  const rows = (result.checks || []).map((check) => ({
    ...check,
    statusLabel: check.ok ? 'OK' : check.blocking ? 'Blokada' : 'Ostrzeżenie',
    tone: check.ok ? 'ok' : check.blocking ? 'danger' : 'warn',
  }));
  return card(`Wynik preflight: ${PREFLIGHT_LABELS[result.kind] || result.kind}`, h`
    ${alert(label, tone)}
    ${kvList([
      ['Szacowane miejsce', result.estimates?.diskRequiredBytes ? formatBytesIEC(result.estimates.diskRequiredBytes) : '—'],
      ['Szacowana przerwa', result.estimates?.downtimeSeconds !== null && result.estimates?.downtimeSeconds !== undefined ? `${result.estimates.downtimeSeconds} s` : '—'],
    ])}
    ${result.estimates?.notes?.length ? h`<p class="small muted">${result.estimates.notes.join(' ')}</p>` : ''}
    ${table({
      columns: [
        {
          label: 'Warunek',
          render: (row) => h`<strong>${row.label}</strong><span class="cell-sub">${row.code}${row.blocking ? '' : ' · nieblokujące'}</span>`,
        },
        { label: 'Wynik', render: (row) => badge(row.statusLabel, row.tone, { dot: true }) },
        { label: 'Szczegóły', render: (row) => h`<span class="small">${row.detail || '—'}</span>` },
        { label: 'Naprawa', render: (row) => row.fixable ? h`<span class="small">${row.fixHint}</span>` : h`<span class="small muted">—</span>` },
      ],
      rows,
      empty: 'Preflight nie zwrócił żadnych warunków.',
      label: 'Warunki preflight',
    })}
    <p class="small muted mt-12">Wynik zapisany tylko w tej odpowiedzi. Preflight nie zmienia plików, nie restartuje usług i nie wykonuje operacji.</p>
  `, { sub: `Sprawdzono ${result.checkedAt ? formatDate(result.checkedAt, { time: true }) : '—'}` });
}

function preflightCard(ctx) {
  const selected = String(ctx.query.preflight || '');
  const result = ctx.preflightResult || null;
  return card('Preflight przed operacją', h`
    <p class="small muted">Sprawdź zależności, uprawnienia, miejsce, porty, DNS i aktywne zadania zanim wykonasz instalację, wystawisz SSL, uruchomisz backup/restore, przełączysz silnik, zaimportujesz dane lub wyślesz plik. Preflight jest tylko do odczytu.</p>
    ${form([
      field({
        name: 'preflight',
        label: 'Rodzaj operacji',
        type: 'select',
        value: selected || 'upload',
        options: PREFLIGHT_KINDS.map((kind) => ({ value: kind, label: PREFLIGHT_LABELS[kind] || kind })),
      }),
      field({ name: 'domain', label: 'Domena', value: String(ctx.query.domain || ''), placeholder: 'example.com' }),
      field({ name: 'app', label: 'Aplikacja (app-install)', value: String(ctx.query.app || ''), placeholder: 'wordpress' }),
      field({ name: 'path', label: 'Ścieżka instalacji', value: String(ctx.query.path || ''), placeholder: '/' }),
      field({ name: 'source', label: 'Źródło / archiwum', value: String(ctx.query.source || ''), placeholder: '/ścieżka/do/pliku.tar.gz' }),
      field({ name: 'filename', label: 'Nazwa pliku (upload)', value: String(ctx.query.filename || ''), placeholder: 'backup.tar.gz' }),
      field({ name: 'username', label: 'Konto docelowe', value: String(ctx.query.username || ''), placeholder: 'opcjonalnie' }),
      field({ name: 'size_mb', label: 'Rozmiar (MB)', type: 'number', min: 0, step: 1, value: String(ctx.query.size_mb || '') }),
      field({ name: 'engine', label: 'Silnik WWW', type: 'select', value: String(ctx.query.engine || 'nginx'), options: [
        { value: 'nginx', label: 'Nginx' },
        { value: 'apache', label: 'Apache' },
        { value: 'openlitespeed', label: 'OpenLiteSpeed' },
        { value: 'litespeed', label: 'LiteSpeed' },
      ] }),
    ], {
      action: A,
      method: 'get',
      submit: 'Uruchom preflight',
      cancel: A,
      cancelLabel: 'Wyczyść',
      cls: 'action-center-preflight',
    })}
    ${result ? preflightResultCard(result) : ''}
  `, { sub: 'Wynik per warunek: ok, kod, etykieta, szczegóły, możliwość naprawy i podpowiedź.' });
}

function itemPreflightInput(query) {
  const sizeMb = Number(query.size_mb);
  return {
    domain: String(query.domain || '').trim(),
    app: String(query.app || '').trim(),
    path: String(query.path || '').trim(),
    source: String(query.source || '').trim(),
    filename: String(query.filename || '').trim(),
    username: String(query.username || '').trim(),
    size: Number.isFinite(sizeMb) && sizeMb >= 0 ? Math.round(sizeMb * 1024 * 1024) : NaN,
    estimateMb: Number.isFinite(sizeMb) && sizeMb > 0 ? sizeMb : undefined,
    engine: String(query.engine || 'nginx').trim(),
    mode: String(query.mode || 'file').trim(),
  };
}

async function applicationFindingsCached() {
  if (Date.now() - applicationCache.at < APP_PROBE_TTL_MS && applicationCache.value) return applicationCache.value;
  applicationCache = { at: Date.now(), value: await collectApplicationFindings() };
  return applicationCache.value;
}

export function register(router) {
  router.get(A, async (ctx) => {
    const filters = filterState(ctx.query);
    let extra = { items: [], sources: [] };
    if (String(ctx.query.apps || '1') !== '0') {
      try { extra = await applicationFindingsCached(); } catch { /* collectActionCenter reports the unavailable source */ }
    }
    const snapshot = collectActionCenter({
      extraItems: extra.items || [],
      extraSources: extra.sources || [],
    });
    const visible = filteredItems(snapshot, filters);
    const returnTo = currentUrl(ctx);
    const selectedPreflight = String(ctx.query.preflight || '');
    let preflightResult = null;
    if (PREFLIGHT_KINDS.includes(selectedPreflight)) {
      preflightResult = await runPreflight(selectedPreflight, itemPreflightInput(ctx.query));
      try {
        const outcome = preflightResult.blocked ? 'blocked' : preflightResult.ok ? 'ok' : 'warn';
        audit(ctx.user?.username || 'admin', 'admin', 'action_center.preflight', `${selectedPreflight}:${outcome}`, ctx.ip || '');
      } catch { /* auditing must not hide the preflight result */ }
    }

    const cards = h`
      <div class="stat-grid">
        ${statCard({ label: 'Krytyczne — działaj teraz', value: String(snapshot.bySeverity.P0 || 0), sub: 'blokery wymagające reakcji', icon: 'alert', tone: 'danger', href: buildUrl(filters, { severity: 'P0', show: 'active' }) })}
        ${statCard({ label: 'Ważne — zaplanuj naprawę', value: String(snapshot.bySeverity.P1 || 0), sub: 'wpływ na usługi lub dane', icon: 'alertCircle', tone: 'warn', href: buildUrl(filters, { severity: 'P1', show: 'active' }) })}
        ${statCard({ label: 'Zalecenia', value: String(snapshot.bySeverity.P2 || 0), sub: 'do uporządkowania', icon: 'info', tone: 'brand', href: buildUrl(filters, { severity: 'P2', show: 'active' }) })}
        ${statCard({ label: 'Wyciszone', value: String(snapshot.muted || 0), sub: `${snapshot.sources.length} źródeł · ${snapshot.unavailableSources} niedostępnych`, icon: 'clock', tone: snapshot.unavailableSources ? 'warn' : 'muted', href: buildUrl(filters, { show: 'muted' }) })}
      </div>
      ${snapshot.unavailableSources ? alert(`Część źródeł jest niedostępna (${snapshot.unavailableSources}). Panel nie zgaduje ich stanu — powody znajdziesz w sekcji „Źródła danych”.`, 'warn') : ''}
      ${filterCard(filters, snapshot)}
      <div class="spread mb-12">
        <div class="row" style="gap:8px">
          ${badge(`${visible.length} pozycji w widoku`, 'brand')}
          ${badge(`ostatni odczyt ${timeAgo(snapshot.generatedAt)}`, 'muted')}
        </div>
        <a class="link small" href="${A}?apps=0">Szybki odczyt bez probe aplikacji</a>
      </div>
      ${visible.length
        ? h`<div class="stack" style="gap:14px">${visible.map((item) => findingCard(ctx, item, returnTo))}</div>`
        : emptyState(
          filters.show === 'muted'
            ? 'Brak wyciszonych pozycji w tym widoku.'
            : filters.severity !== 'all' || filters.type !== 'all' || filters.q
              ? 'Brak pozycji dla wybranych filtrów. Zmień filtr lub wyczyść wyszukiwanie.'
              : 'Brak obserwacji wymagających uwagi. Wszystkie źródła odpowiedziały i mieszczą się w progach.',
          {
            icon: filters.show === 'muted' ? 'clock' : 'checkCircle',
            title: filters.show === 'muted' ? 'Nic nie jest wyciszone' : 'Wszystko w normie',
            action: h`<a class="btn btn-secondary btn-sm" href="${A}">Wyczyść filtry</a>`,
          })}
      ${sourcesCard(snapshot)}
      ${preflightCard({ ...ctx, preflightResult })}`;
    return page(ctx, {
      title: 'Action Center',
      subtitle: 'Co wymaga uwagi — wpływ, rekomendacja, bezpieczna akcja i wyciszenie z terminem',
      body: cards,
      wide: true,
    });
  });

  router.post(`${A}/mute`, (ctx) => {
    const returnTo = safeActionCenterReturn(ctx.body.returnTo);
    const hours = Math.min(8760, Math.max(1, Number(ctx.body.hours) || 24));
    const until = new Date(Date.now() + hours * 3600000).toISOString();
    const result = muteFinding({
      dedupeKey: String(ctx.body.key || ''),
      until,
      actor: ctx.user?.username || 'admin',
      reason: String(ctx.body.reason || ''),
    });
    return ctx.redirect(returnTo, {
      flash: result.ok ? `Wyciszono do ${formatDate(result.mutedUntil, { time: true })}` : result.error,
      type: result.ok ? 'ok' : 'error',
    });
  });

  router.post(`${A}/unmute`, (ctx) => {
    const returnTo = safeActionCenterReturn(ctx.body.returnTo);
    const result = unmuteFinding({
      dedupeKey: String(ctx.body.key || ''),
      actor: ctx.user?.username || 'admin',
    });
    return ctx.redirect(returnTo, {
      flash: result.ok ? 'Pozycja przywrócona do listy' : result.error,
      type: result.ok ? 'ok' : 'error',
    });
  });
}
