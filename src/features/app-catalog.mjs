// Unified application catalogue: WordPress, Nextcloud, Joomla, Drupal,
// PrestaShop and Moodle. Native installers for WP/NC, catalogue installers for
// the rest; every tile is backed by a real download, database and installer.
import { html as h } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, badge, alert, kvList } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { appIcon, appName } from '../ui/appicons.mjs';
import { visibleDomains } from '../core/access.mjs';
import { all } from '../db.mjs';
import { listApps, installedApps, installApp, deleteApp } from '../appcatalog.mjs';

const A = '/user/app-catalog';
const APPS = [
  { key: 'wordpress', name: 'WordPress', desc: 'Strona, blog lub sklep', version: 'najnowsza', native: true },
  { key: 'nextcloud', name: 'Nextcloud', desc: 'Prywatna chmura plików i współpraca', version: '30', native: true },
  ...listApps().map((app) => ({ ...app, native: false })),
];
const APP_BY_KEY = Object.fromEntries(APPS.map((app) => [app.key, app]));

function plural(count, one, few, many) {
  const n = Math.abs(Number(count) || 0);
  const last = n % 10;
  const tens = n % 100;
  if (n === 1) return one;
  if (last >= 2 && last <= 4 && !(tens >= 12 && tens <= 14)) return few;
  return many;
}

function dateTimePl(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('pl-PL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function versionLabel(app) {
  return app.version === 'najnowsza' ? 'Wersja: najnowsza' : `v${app.version}`;
}

function typeLabel(app) {
  if (app.native) return 'Natywny instalator';
  if (app.mode === 'cli') return 'CLI + WWW';
  return 'Instalator WWW';
}

function modalId(app) {
  return `app-modal-${app.key}`;
}

function installAction(app) {
  return app.native ? `/user/app-installer/${app.key}` : `${A}/install`;
}

function defaultPath(app) {
  if (app.native) return '/';
  return `/${app.key}`;
}

function relativePath(path) {
  const value = String(path || '').trim();
  if (!value || value === '/') return '';
  const prefixed = value.startsWith('/') ? value : `/${value}`;
  return prefixed.replace(/\/+$/, '');
}

function appBaseUrl(row) {
  return `https://${row.domain}${relativePath(row.path)}`;
}

function openUrl(row) {
  if (row.type === 'wordpress') return `http://${row.domain}${relativePath(row.path)}/wp-admin/`;
  const app = APP_BY_KEY[row.type];
  if (row.status === 'web-installer' && app?.installer) {
    return `https://${row.domain}${relativePath(row.path)}${app.installer}`;
  }
  return `${appBaseUrl(row)}/`;
}

function statusMeta(row) {
  if (row.status === 'active') return { label: 'Aktywna', tone: 'ok' };
  if (row.status === 'web-installer') return { label: 'Dokończ instalację', tone: 'warn' };
  return { label: row.status || 'Nieznany', tone: 'muted' };
}

function installForm(ctx, app, domains) {
  const uid = `app-${app.key}`;
  const fixedPath = app.key === 'nextcloud';
  return h`<form method="post" action="${installAction(app)}" class="oa-form app-install-form" data-install-form>
    <input type="hidden" name="_csrf" value="${ctx.csrf}">
    <input type="hidden" name="app" value="${app.key}">
    <div class="form-grid">
      <div class="field">
        <label class="field-label" for="${uid}-domain">Domena <span class="req">*</span></label>
        <select id="${uid}-domain" name="domain" required aria-describedby="${uid}-domain-help">
          ${domains.map((domain) => h`<option value="${domain.name}">${domain.name}</option>`)}
        </select>
        <p class="field-help" id="${uid}-domain-help">Aplikacja zostanie zainstalowana na wybranej domenie.</p>
      </div>
      <div class="field">
        <label class="field-label" for="${uid}-path">Ścieżka</label>
        <input id="${uid}-path" name="path" value="${defaultPath(app)}" ${fixedPath ? 'readonly' : ''} aria-describedby="${uid}-path-help">
        <p class="field-help" id="${uid}-path-help">${fixedPath ? 'Nextcloud instaluje się w katalogu głównym domeny.' : 'Możesz wskazać podkatalog, np. /sklep.'}</p>
      </div>
      <div class="field">
        <label class="field-label" for="${uid}-title">Tytuł strony</label>
        <input id="${uid}-title" name="title" value="${app.name}" aria-describedby="${uid}-title-help">
        <p class="field-help" id="${uid}-title-help">Nazwa widoczna w instalatorze aplikacji.</p>
      </div>
      <div class="field">
        <label class="field-label" for="${uid}-password">Hasło administratora <span class="req">*</span></label>
        <input id="${uid}-password" name="admin_password" type="password" minlength="8" required autocomplete="new-password" aria-describedby="${uid}-password-help">
        <p class="field-help" id="${uid}-password-help">Co najmniej 8 znaków. Zapisz je — pokażemy je po instalacji.</p>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn btn-primary" type="submit" data-install-submit>${icon('download', { size: 16 })}<span data-install-label>Zainstaluj ${app.name}</span></button>
      <button class="btn btn-ghost" type="button" data-close-modal>Anuluj</button>
    </div>
    <p class="small muted mt-10" data-install-status role="status" hidden></p>
  </form>`;
}

function installModal(ctx, app, domains, count) {
  const id = modalId(app);
  const note = app.native
    ? (app.key === 'wordpress'
      ? 'WordPress instaluje się od razu przez WP-CLI. Po zakończeniu zobaczysz adres panelu i dane administratora.'
      : 'Nextcloud instaluje się od razu przez occ. Po zakończeniu zobaczysz adres i dane administratora.')
    : app.mode === 'cli'
      ? `${app.name} najpierw próbuje instalacji przez CLI. Jeśli się nie uda, dostaniesz link do dokończenia w przeglądarce — bez fałszywego „gotowe”.`
      : `${app.name} utworzy bazę i stronę, a instalator dokończysz w przeglądarce pod adresem ${app.installer}.`;
  return h`<div class="modal-backdrop" id="${id}" data-app-modal role="presentation" aria-hidden="true" hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="${id}-title" aria-describedby="${id}-desc">
      <header class="modal-head">
        <div><h3 id="${id}-title">Zainstaluj ${app.name}</h3><p class="small muted">${typeLabel(app)} · ${versionLabel(app)}</p></div>
        <button class="icon-btn" type="button" data-close-modal aria-label="Zamknij okno instalacji">${icon('x', { size: 18 })}</button>
      </header>
      <div class="modal-body">
        <div class="app-tile-head mb-18">
          ${appIcon(app.key, { size: 44 })}
          <div><div class="app-tile-title"><h3>${app.name}</h3>${badge(typeLabel(app), 'muted')}</div><p class="app-tile-sub" id="${id}-desc">${app.desc}. Instalacja trwa tyle, ile pobranie pakietu — nie pokazujemy sztucznego procentu.</p></div>
        </div>
        ${count ? alert(`Masz już ${count} ${plural(count, 'instalację', 'instalacje', 'instalacji')} ${app.name}. Nowa instalacja powstanie osobno na wybranej domenie.`, 'info') : ''}
        ${installForm(ctx, app, domains)}
        <p class="small muted mt-10">${note}</p>
      </div>
    </div>
  </div>`;
}

function installedRow(ctx, row) {
  const app = APP_BY_KEY[row.type];
  const status = statusMeta(row);
  const url = openUrl(row);
  const label = row.type === 'wordpress' ? 'Panel WP' : row.status === 'web-installer' ? 'Dokończ instalację' : 'Otwórz';
  const pathLabel = `${row.domain}${relativePath(row.path)}`;
  const deleteAction = row.type === 'wordpress'
    ? `/user/app-installer/wordpress/${row.id}/delete`
    : row.type === 'nextcloud'
      ? `/user/app-installer/nextcloud/${row.id}/delete`
      : `${A}/${row.id}/delete`;
  return h`<div class="app-installed" data-installed-app="${row.type}">
    ${appIcon(row.type, { size: 40 })}
    <div style="min-width:0">
      <div class="app-tile-title"><strong>${appName(row.type)}</strong>${badge(status.label, status.tone, { dot: status.tone !== 'muted' })}${badge(`v${row.version || '—'}`, 'muted')}</div>
      <p class="app-tile-sub">${pathLabel} · admin: ${row.admin_user || 'admin'} · utworzono ${dateTimePl(row.created_at)}</p>
    </div>
    <div class="app-installed-actions">
      <a class="btn btn-secondary btn-sm" href="${url}" target="_blank" rel="noopener">${icon('globe', { size: 15 })} ${label}</a>
      ${row.type === 'wordpress' ? h`<a class="btn btn-ghost btn-sm" href="/user/wordpress">${icon('settings', { size: 15 })} Zarządzaj</a>` : ''}
      <button class="btn btn-ghost btn-sm" type="button" data-copy="${url}" title="Kopiuj adres">${icon('copy', { size: 15 })} Kopiuj URL</button>
      <form method="post" action="${deleteAction}" class="inline" data-confirm="Usunąć ${appName(row.type)} z ${pathLabel}? Usunięta zostanie także baza danych.">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <button class="btn btn-danger btn-sm" type="submit">${icon('trash', { size: 15 })} Usuń</button>
      </form>
    </div>
  </div>`;
}

export function register(router) {
  router.get(A, (ctx) => {
    const domains = visibleDomains(ctx.user);
    const installed = installedApps(ctx.user.id);
    const wp = all('SELECT * FROM wordpress WHERE domain IN (SELECT name FROM domains WHERE user_id = ?) ORDER BY created_at DESC', ctx.user.id);
    const nc = all("SELECT * FROM app_installs WHERE user_id = ? AND type = 'nextcloud' ORDER BY created_at DESC", ctx.user.id);
    const installedAll = [
      ...wp.map((row) => ({ ...row, type: 'wordpress', _native: true })),
      ...nc.map((row) => ({ ...row, type: 'nextcloud', _native: true })),
      ...installed.map((row) => ({ ...row, _native: false })),
    ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const counts = Object.fromEntries(APPS.map((app) => [app.key, installedAll.filter((row) => row.type === app.key).length]));
    const installedTypes = APPS.filter((app) => counts[app.key] > 0).length;
    const available = APPS.length - installedTypes;
    const activeCount = installedAll.filter((row) => row.status === 'active').length;
    const webInstallerCount = installedAll.filter((row) => row.status === 'web-installer').length;
    const canInstall = domains.length > 0;
    const body = h`
      ${!canInstall ? alert(h`Najpierw dodaj domenę — aplikacje instalujemy tylko na Twoich domenach. <a class="link" href="/user/websites/new">Postaw pierwszą stronę w kreatorze →</a>`, 'warn') : ''}
      ${alert('Jeden katalog, sześć aplikacji. Wybierz kafelek, sprawdź wersję i typ instalatora, a następnie zainstaluj na własnej domenie. Po wysłaniu formularza zobaczysz prawdziwy wynik — bez sztucznego procentu.', 'info')}
      <div class="spread mb-12" data-app-catalog-summary>
        <div class="row" style="gap:8px">
          ${badge(`${APPS.length} aplikacji`, 'brand')}
          ${badge(`${installedTypes} z ${APPS.length} zainstalowanych`, installedTypes ? 'ok' : 'muted', { dot: installedTypes > 0 })}
          ${badge(`Dostępne do instalacji: ${available}`, 'muted')}
        </div>
        <span class="small muted">Ostatnia aktualizacja: ${dateTimePl(new Date().toISOString())}</span>
      </div>
      <div class="toolbar" role="search" aria-label="Wyszukaj i filtruj aplikacje">
        <div class="toolbar-left">
          <div class="search">
            ${icon('search', { size: 15 })}
            <input type="search" id="app-search" data-app-search placeholder="Szukaj aplikacji…" aria-label="Szukaj aplikacji po nazwie" autocomplete="off" style="width:280px">
          </div>
          <div class="chip-row" role="group" aria-label="Filtr aplikacji">
            <button type="button" class="chip active" data-app-filter="all" aria-pressed="true">Wszystkie <span class="tab-count">${APPS.length}</span></button>
            <button type="button" class="chip" data-app-filter="installed" aria-pressed="false">Zainstalowane <span class="tab-count">${installedTypes}</span></button>
            <button type="button" class="chip" data-app-filter="available" aria-pressed="false">Dostępne <span class="tab-count">${available}</span></button>
          </div>
        </div>
        <div class="toolbar-right"><span class="small muted" data-app-count aria-live="polite">${APPS.length} z ${APPS.length} aplikacji</span></div>
      </div>
      <div class="app-tile-grid" id="app-grid" data-app-grid>
        ${APPS.map((app) => {
          const count = counts[app.key] || 0;
          const installedState = count > 0;
          return h`<article class="app-tile" id="app-${app.key}" data-app-card data-app-key="${app.key}" data-app-name="${app.name} ${app.desc} ${app.key}" data-app-installed="${installedState ? '1' : '0'}">
            <div class="app-tile-head">
              ${appIcon(app.key, { size: 52 })}
              <div>
                <div class="app-tile-title"><h3>${app.name}</h3>${installedState ? badge(`Zainstalowane: ${count}`, 'ok', { dot: true }) : badge('Dostępna', 'muted')}</div>
                <p class="app-tile-sub">${app.desc}</p>
              </div>
            </div>
            <div class="row" style="gap:6px">${badge(versionLabel(app), 'brand')}${badge(typeLabel(app), 'muted')}</div>
            <div class="app-meta"><span>PHP + MariaDB</span><span>${app.native ? 'Aktualizacje przez panel' : app.mode === 'cli' ? 'CLI, potem WWW' : 'Instalator w przeglądarce'}</span></div>
            <div class="app-tile-actions">
              ${canInstall
                ? h`<button class="btn btn-primary btn-sm" type="button" data-app-open="${modalId(app)}" data-open-modal="${modalId(app)}" aria-haspopup="dialog" aria-controls="${modalId(app)}">${icon('download', { size: 15 })} ${installedState ? 'Zainstaluj kolejną' : 'Zainstaluj'}</button>`
                : h`<a class="btn btn-primary btn-sm" href="/user/websites/new">${icon('plus', { size: 15 })} Dodaj domenę, aby zainstalować</a>`}
              ${installedState ? h`<a class="btn btn-ghost btn-sm" href="#twoje-aplikacje">Twoje instalacje (${count})</a>` : ''}
            </div>
          </article>`;
        })}
      </div>
      <div class="empty" data-app-no-results role="status" hidden>
        <div class="empty-icon">${icon('search', { size: 26 })}</div>
        <p>Brak aplikacji pasujących do wyszukiwania.</p>
        <button class="btn btn-secondary btn-sm" type="button" data-app-reset>Wyczyść filtry</button>
      </div>

      <div id="twoje-aplikacje" class="mt-24">
        ${card('Twoje aplikacje', h`${installedAll.length
          ? h`<div>${installedAll.map((row) => installedRow(ctx, row))}</div>`
          : h`<div class="app-empty" data-app-empty>
              <div class="empty-icon">${icon('cart', { size: 26 })}</div>
              <p><strong>Nie masz jeszcze aplikacji</strong></p>
              <p class="small muted">Wybierz kafelek powyżej — instalacja utworzy pliki, bazę i dane administratora.</p>
              <a class="btn btn-primary btn-sm mt-10" href="#app-grid">Wybierz aplikację</a>
            </div>`}`, {
        sub: `${installedAll.length} ${plural(installedAll.length, 'instalacja', 'instalacje', 'instalacji')} · ${activeCount} ${plural(activeCount, 'aktywna', 'aktywne', 'aktywnych')} · ${webInstallerCount} ${plural(webInstallerCount, 'do dokończenia', 'do dokończenia', 'do dokończenia')}`,
        actions: [h`<a class="link small" href="#app-grid">Zainstaluj nową →</a>`],
      })}
      </div>
      ${canInstall ? APPS.map((app) => installModal(ctx, app, domains, counts[app.key] || 0)) : ''}
      <script>
        (function () {
          'use strict';
          var cards = Array.prototype.slice.call(document.querySelectorAll('[data-app-card]'));
          var search = document.querySelector('[data-app-search]');
          var chips = Array.prototype.slice.call(document.querySelectorAll('[data-app-filter]'));
          var countOut = document.querySelector('[data-app-count]');
          var none = document.querySelector('[data-app-no-results]');
          var grid = document.querySelector('[data-app-grid]');
          var reset = document.querySelector('[data-app-reset]');
          var filter = 'all';

          function normalize(value) {
            return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          }

          function applyFilters() {
            var query = normalize(search ? search.value.trim() : '');
            var visible = 0;
            cards.forEach(function (card) {
              var isInstalled = card.getAttribute('data-app-installed') === '1';
              var stateMatch = filter === 'all' || (filter === 'installed' && isInstalled) || (filter === 'available' && !isInstalled);
              var name = normalize(card.getAttribute('data-app-name'));
              var queryMatch = !query || name.indexOf(query) !== -1;
              var show = stateMatch && queryMatch;
              card.hidden = !show;
              if (show) visible++;
            });
            if (countOut) countOut.textContent = visible + ' z ' + cards.length + ' aplikacji';
            if (none) none.hidden = visible !== 0;
            if (grid) grid.hidden = visible === 0;
          }

          chips.forEach(function (chip) {
            chip.addEventListener('click', function () {
              filter = chip.getAttribute('data-app-filter') || 'all';
              chips.forEach(function (item) {
                var active = item === chip;
                item.classList.toggle('active', active);
                item.setAttribute('aria-pressed', active ? 'true' : 'false');
              });
              applyFilters();
            });
          });
          if (search) search.addEventListener('input', applyFilters);
          if (reset) reset.addEventListener('click', function () {
            if (search) search.value = '';
            filter = 'all';
            chips.forEach(function (chip) {
              var active = chip.getAttribute('data-app-filter') === 'all';
              chip.classList.toggle('active', active);
              chip.setAttribute('aria-pressed', active ? 'true' : 'false');
            });
            applyFilters();
            if (search) search.focus();
          });
          applyFilters();

          /* Overlay opening, focus trap, Escape and backdrops are owned by
             the global shell (data-open-modal/data-close-modal). Keeping them
             here would double-handle the same modal and steal focus. */
          Array.prototype.forEach.call(document.querySelectorAll('[data-install-form]'), function (form) {
            var submit = form.querySelector('[data-install-submit]');
            var label = form.querySelector('[data-install-label]');
            var status = form.querySelector('[data-install-status]');
            if (label) label.setAttribute('data-ready-label', label.textContent);
            form.addEventListener('submit', function () {
              if (submit) {
                submit.disabled = true;
                submit.setAttribute('aria-disabled', 'true');
              }
              if (label) label.textContent = 'Instaluję…';
              form.setAttribute('aria-busy', 'true');
              if (status) {
                status.hidden = false;
                status.textContent = 'Instalacja trwa — panel pobiera pakiet i tworzy bazę. Nie zamykaj karty.';
              }
            });
          });
          window.addEventListener('pageshow', function () {
            Array.prototype.forEach.call(document.querySelectorAll('[data-install-form][aria-busy="true"]'), function (form) {
              form.removeAttribute('aria-busy');
              var submit = form.querySelector('[data-install-submit]');
              var label = form.querySelector('[data-install-label]');
              if (submit) {
                submit.disabled = false;
                submit.removeAttribute('aria-disabled');
              }
              if (label) label.textContent = label.getAttribute('data-ready-label') || 'Zainstaluj';
              var status = form.querySelector('[data-install-status]');
              if (status) status.hidden = true;
            });
          });
        })();
      </script>`;
    return page(ctx, { title: 'Aplikacje', subtitle: 'WordPress, Nextcloud, PrestaShop, Joomla, Drupal, Moodle — jednym kliknięciem', body, wide: true });
  });

  router.post(`${A}/install`, (ctx) => {
    const app = listApps().find((row) => row.key === ctx.body.app);
    const result = installApp(ctx.body.app, {
      user: ctx.user, domain: ctx.body.domain, subpath: ctx.body.path,
      adminUser: 'admin', adminPass: String(ctx.body.admin_password || ''), title: ctx.body.title,
    });
    if (!result.ok) return ctx.redirect(`${A}?flash=${encodeURIComponent(result.error)}&type=error`);
    const body = h`${card(`${app?.name || ctx.body.app} — instalacja`, h`
      <div class="app-tile-head mb-18">${appIcon(ctx.body.app, { size: 52 })}<div><div class="app-tile-title"><h3>${app?.name || 'Aplikacja'}</h3>${badge(result.mode === 'cli' ? 'Zainstalowana przez CLI' : 'Do dokończenia w przeglądarce', result.mode === 'cli' ? 'ok' : 'warn', { dot: true })}</div><p class="app-tile-sub">${result.mode === 'cli' ? 'Aplikacja jest gotowa. Zapisz hasło administratora.' : 'Baza i pliki gotowe — dokończ instalator w przeglądarce.'}</p></div></div>
      ${result.warning ? alert(result.warning, 'warn') : ''}
      ${kvList([['URL', h`<a class="link" href="${result.url}" target="_blank" rel="noopener">${result.url}</a>`], ['Baza', result.db], ['Użytkownik bazy', result.dbUser], ['Hasło bazy', h`<code>${result.dbPass}</code>`], ['Administrator', result.adminUser], ['Hasło administratora', h`<code>${result.adminPass}</code>`]])}
      <div class="row mt-18"><a class="btn btn-primary" href="${A}">Wróć do aplikacji</a><a class="btn btn-secondary" href="${result.url}" target="_blank" rel="noopener">Otwórz instalator</a><a class="btn btn-ghost" href="${A}#twoje-aplikacje">Twoje aplikacje</a></div>`, { sub: 'Prawdziwy wynik instalacji — bez skrótów' })}`;
    return page(ctx, { title: 'Aplikacja', subtitle: 'Dane instalacji', body });
  });

  router.post(`${A}/:id/delete`, (ctx) => {
    const result = deleteApp(ctx.params.id, ctx.user);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(result.ok ? 'Usunięto aplikację' : result.error)}${result.ok ? '' : '&type=error'}`);
  });
}
