// Unified application catalogue: WordPress, Nextcloud, Joomla, Drupal,
// PrestaShop and Moodle. Native installers for WP/NC, catalogue installers for
// the rest; every tile is backed by a real download, database and installer.
//
// Three independent states are rendered explicitly:
//   1. catalogue   — [data-app-catalogue] with the tiles and search;
//   2. filter      — [data-app-filter-state], exactly one empty state for the
//                    active filter/search (never two at once);
//   3. installed   — [data-app-installed-region], the user's real installs.
// `#app-<key>` opens, focuses and expands the matching tile.
import { html as h, raw } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, badge, alert, kvList } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { appIcon, appName } from '../ui/appicons.mjs';
import { visibleDomains } from '../core/access.mjs';
import { all } from '../db.mjs';
import { listApps, installedApps, installApp, deleteApp } from '../appcatalog.mjs';

const A = '/user/app-catalog';
const APPS = [
  { key: 'wordpress', name: 'WordPress', desc: 'Strona, blog lub sklep', descEn: 'Website, blog or shop', version: 'najnowsza', native: true },
  { key: 'nextcloud', name: 'Nextcloud', desc: 'Prywatna chmura plików i współpraca', descEn: 'Private file cloud and collaboration', version: '30', native: true },
  ...listApps().map((app) => ({ ...app, native: false })),
];
const APP_BY_KEY = Object.fromEntries(APPS.map((app) => [app.key, app]));
const DESC_EN = {
  joomla: 'CMS and portal',
  drupal: 'CMS and portal',
  prestashop: 'Online store',
  moodle: 'E-learning platform',
};

function langOf(ctx) {
  return ctx?.user?.language === 'en' ? 'en' : 'pl';
}

function L(locale, en, pl) {
  return locale === 'en' ? en : pl;
}

function pluralPl(count, one, few, many) {
  const n = Math.abs(Number(count) || 0);
  const last = n % 10;
  const tens = n % 100;
  if (n === 1) return one;
  if (last >= 2 && last <= 4 && !(tens >= 12 && tens <= 14)) return few;
  return many;
}

function pluralEn(count, one, many) {
  return Math.abs(Number(count) || 0) === 1 ? one : many;
}

function installationLabel(locale, count) {
  return locale === 'en' ? pluralEn(count, 'installation', 'installations') : pluralPl(count, 'instalacja', 'instalacje', 'instalacji');
}

function activeLabel(locale, count) {
  return locale === 'en' ? pluralEn(count, 'active', 'active') : pluralPl(count, 'aktywna', 'aktywne', 'aktywnych');
}

function unfinishedLabel(locale, count) {
  return locale === 'en' ? pluralEn(count, 'to finish', 'to finish') : pluralPl(count, 'do dokończenia', 'do dokończenia', 'do dokończenia');
}

function dateTime(value, locale) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(locale === 'en' ? 'en-GB' : 'pl-PL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function versionLabel(app, locale) {
  if (app.version !== 'najnowsza') return `v${app.version}`;
  return L(locale, 'Version: latest', 'Wersja: najnowsza');
}

function typeLabel(app, locale) {
  if (app.native) return L(locale, 'Native installer', 'Natywny instalator');
  if (app.mode === 'cli') return L(locale, 'CLI + web', 'CLI + WWW');
  return L(locale, 'Web installer', 'Instalator WWW');
}

function appDesc(app, locale) {
  return L(locale, app.descEn || DESC_EN[app.key] || app.description || '', app.desc || app.description || '');
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

function statusMeta(row, locale) {
  if (row.status === 'active') return { label: L(locale, 'Active', 'Aktywna'), tone: 'ok' };
  if (row.status === 'web-installer') return { label: L(locale, 'Finish installation', 'Dokończ instalację'), tone: 'warn' };
  return { label: row.status || L(locale, 'Unknown', 'Nieznany'), tone: 'muted' };
}

function scriptJson(value) {
  return raw(JSON.stringify(value).replace(/</g, '\\u003c'));
}

function installForm(ctx, app, domains, locale) {
  const uid = `app-install-${app.key}`;
  const fixedPath = app.key === 'nextcloud';
  return h`<form method="post" action="${installAction(app)}" class="oa-form app-install-form" aria-label="${L(locale, `Install ${app.name}`, `Zainstaluj ${app.name}`)}" data-install-form>
    <input type="hidden" name="_csrf" value="${ctx.csrf}">
    <input type="hidden" name="app" value="${app.key}">
    <fieldset class="app-install-fields" style="border:0;padding:0;margin:0;min-width:0">
      <legend class="field-label">${L(locale, 'Installation details', 'Dane instalacji')}</legend>
      <div class="form-grid">
        <div class="field">
          <label class="field-label" for="${uid}-domain">${L(locale, 'Domain', 'Domena')} <span class="req" aria-hidden="true">*</span></label>
          <select id="${uid}-domain" name="domain" required aria-required="true" aria-describedby="${uid}-domain-help">
            ${domains.map((domain) => h`<option value="${domain.name}">${domain.name}</option>`)}
          </select>
          <p class="field-help" id="${uid}-domain-help">${L(locale, 'The application will be installed on the selected domain.', 'Aplikacja zostanie zainstalowana na wybranej domenie.')}</p>
        </div>
        <div class="field">
          <label class="field-label" for="${uid}-path">${L(locale, 'Path', 'Ścieżka')}</label>
          <input id="${uid}-path" name="path" value="${defaultPath(app)}" ${fixedPath ? 'readonly' : ''} aria-describedby="${uid}-path-help">
          <p class="field-help" id="${uid}-path-help">${fixedPath
            ? L(locale, 'Nextcloud installs in the domain root directory.', 'Nextcloud instaluje się w katalogu głównym domeny.')
            : L(locale, 'You can use a subdirectory, e.g. /shop.', 'Możesz wskazać podkatalog, np. /sklep.')}</p>
        </div>
        <div class="field">
          <label class="field-label" for="${uid}-title">${L(locale, 'Site title', 'Tytuł strony')}</label>
          <input id="${uid}-title" name="title" value="${app.name}" aria-describedby="${uid}-title-help">
          <p class="field-help" id="${uid}-title-help">${L(locale, 'The name shown in the application installer.', 'Nazwa widoczna w instalatorze aplikacji.')}</p>
        </div>
        <div class="field">
          <label class="field-label" for="${uid}-password">${L(locale, 'Admin password', 'Hasło administratora')} <span class="req" aria-hidden="true">*</span></label>
          <input id="${uid}-password" name="admin_password" type="password" minlength="8" required aria-required="true" autocomplete="new-password" aria-describedby="${uid}-password-help">
          <p class="field-help" id="${uid}-password-help">${L(locale, 'At least 8 characters. Save it — we show it after installation.', 'Co najmniej 8 znaków. Zapisz je — pokażemy je po instalacji.')}</p>
        </div>
      </div>
    </fieldset>
    <div class="form-actions">
      <button class="btn btn-primary" type="submit" data-install-submit>${icon('download', { size: 16 })}<span data-install-label>${L(locale, `Install ${app.name}`, `Zainstaluj ${app.name}`)}</span></button>
      <button class="btn btn-ghost" type="button" data-close-modal>${L(locale, 'Cancel', 'Anuluj')}</button>
    </div>
    <p class="small muted mt-10" data-install-status role="status" hidden></p>
  </form>`;
}

function installNote(app, locale) {
  if (app.native) {
    return app.key === 'wordpress'
      ? L(locale, 'WordPress installs immediately through WP-CLI. The panel address and admin credentials appear when it finishes.', 'WordPress instaluje się od razu przez WP-CLI. Po zakończeniu zobaczysz adres panelu i dane administratora.')
      : L(locale, 'Nextcloud installs immediately through occ. The address and admin credentials appear when it finishes.', 'Nextcloud instaluje się od razu przez occ. Po zakończeniu zobaczysz adres i dane administratora.');
  }
  if (app.mode === 'cli') {
    return L(locale,
      `${app.name} first tries the CLI installer. If that fails you get a browser link to finish — without a fake “done”.`,
      `${app.name} najpierw próbuje instalacji przez CLI. Jeśli się nie uda, dostaniesz link do dokończenia w przeglądarce — bez fałszywego „gotowe”.`);
  }
  return L(locale,
    `${app.name} creates a database and site; you finish the installer in the browser at ${app.installer}.`,
    `${app.name} utworzy bazę i stronę, a instalator dokończysz w przeglądarce pod adresem ${app.installer}.`);
}

function installModal(ctx, app, domains, count, locale) {
  const id = modalId(app);
  const existing = count
    ? L(locale,
      `You already have ${count} ${installationLabel(locale, count)} of ${app.name}. A new installation will be created separately on the selected domain.`,
      `Masz już ${count} ${pluralPl(count, 'instalację', 'instalacje', 'instalacji')} ${app.name}. Nowa instalacja powstanie osobno na wybranej domenie.`)
    : '';
  return h`<div class="modal-backdrop" id="${id}" data-app-modal role="presentation" aria-hidden="true" hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="${id}-title" aria-describedby="${id}-desc" tabindex="-1">
      <header class="modal-head">
        <div><h3 id="${id}-title">${L(locale, `Install ${app.name}`, `Zainstaluj ${app.name}`)}</h3><p class="small muted">${typeLabel(app, locale)} · ${versionLabel(app, locale)}</p></div>
        <button class="icon-btn" type="button" data-close-modal aria-label="${L(locale, 'Close installation dialog', 'Zamknij okno instalacji')}" title="${L(locale, 'Close installation dialog', 'Zamknij okno instalacji')}">${icon('x', { size: 18 })}</button>
      </header>
      <div class="modal-body">
        <div class="app-tile-head mb-18">
          ${appIcon(app.key, { size: 44 })}
          <div><div class="app-tile-title"><h3>${app.name}</h3>${badge(typeLabel(app, locale), 'muted')}</div><p class="app-tile-sub" id="${id}-desc">${appDesc(app, locale)}. ${L(locale, 'Installation takes as long as the package download — we never show a fake percentage.', 'Instalacja trwa tyle, ile pobranie pakietu — nie pokazujemy sztucznego procentu.')}</p></div>
        </div>
        ${existing ? alert(existing, 'info') : ''}
        ${installForm(ctx, app, domains, locale)}
        <p class="small muted mt-10">${installNote(app, locale)}</p>
      </div>
    </div>
  </div>`;
}

function installedRow(ctx, row, locale) {
  const app = APP_BY_KEY[row.type];
  const status = statusMeta(row, locale);
  const url = openUrl(row);
  const label = row.type === 'wordpress'
    ? L(locale, 'WP admin', 'Panel WP')
    : row.status === 'web-installer'
      ? L(locale, 'Finish installation', 'Dokończ instalację')
      : L(locale, 'Open', 'Otwórz');
  const pathLabel = `${row.domain}${relativePath(row.path)}`;
  const deleteAction = row.type === 'wordpress'
    ? `/user/app-installer/wordpress/${row.id}/delete`
    : row.type === 'nextcloud'
      ? `/user/app-installer/nextcloud/${row.id}/delete`
      : `${A}/${row.id}/delete`;
  const confirm = L(locale,
    `Remove ${appName(row.type)} from ${pathLabel}? Its database will also be removed.`,
    `Usunąć ${appName(row.type)} z ${pathLabel}? Usunięta zostanie także baza danych.`);
  return h`<div class="app-installed" data-installed-app="${row.type}">
    ${appIcon(row.type, { size: 40 })}
    <div style="min-width:0">
      <div class="app-tile-title"><strong>${appName(row.type)}</strong>${badge(status.label, status.tone, { dot: status.tone !== 'muted' })}${badge(`v${row.version || '—'}`, 'muted')}</div>
      <p class="app-tile-sub">${pathLabel} · ${L(locale, 'admin', 'admin')}: ${row.admin_user || 'admin'} · ${L(locale, 'created', 'utworzono')} ${dateTime(row.created_at, locale)}</p>
    </div>
    <div class="app-installed-actions">
      <a class="btn btn-secondary btn-sm" href="${url}" target="_blank" rel="noopener">${icon('globe', { size: 15 })} ${label}</a>
      ${row.type === 'wordpress' ? h`<a class="btn btn-ghost btn-sm" href="/user/wordpress">${icon('settings', { size: 15 })} ${L(locale, 'Manage', 'Zarządzaj')}</a>` : ''}
      <button class="btn btn-ghost btn-sm" type="button" data-copy="${url}" title="${L(locale, 'Copy address', 'Kopiuj adres')}" aria-label="${L(locale, 'Copy address', 'Kopiuj adres')}">${icon('copy', { size: 15 })} ${L(locale, 'Copy URL', 'Kopiuj URL')}</button>
      <form method="post" action="${deleteAction}" class="inline" data-confirm="${confirm}">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <button class="btn btn-danger btn-sm" type="submit">${icon('trash', { size: 15 })} ${L(locale, 'Remove', 'Usuń')}</button>
      </form>
    </div>
  </div>`;
}

function filterMessages(locale) {
  return {
    count: L(locale, '{visible} of {total} applications', '{visible} z {total} aplikacji'),
    noResults: L(locale, 'No applications match this search.', 'Brak aplikacji pasujących do wyszukiwania.'),
    noResultsHint: L(locale, 'Change the query or clear the filters.', 'Zmień frazę lub wyczyść filtry.'),
    installedZero: L(locale, 'You have no installed applications yet', 'Nie masz jeszcze zainstalowanych aplikacji'),
    installedZeroHint: L(locale, 'Pick a tile from the catalogue and install an application on your domain.', 'Wybierz kafelek z katalogu i zainstaluj aplikację na swojej domenie.'),
    availableZero: L(locale, 'All applications are already installed', 'Wszystkie aplikacje są już zainstalowane'),
    availableZeroHint: L(locale, 'Open your installed applications to manage them.', 'Przejdź do zainstalowanych aplikacji, aby nimi zarządzać.'),
    reset: L(locale, 'Clear filters', 'Wyczyść filtry'),
    showAll: L(locale, 'Show all applications', 'Pokaż wszystkie aplikacje'),
    installing: L(locale, 'Installing…', 'Instaluję…'),
    installingStatus: L(locale, 'Installation in progress — the panel is downloading the package and creating the database. Do not close this tab.', 'Instalacja trwa — panel pobiera pakiet i tworzy bazę. Nie zamykaj karty.'),
    defaultInstall: L(locale, 'Install', 'Zainstaluj'),
  };
}

export function register(router) {
  router.get(A, (ctx) => {
    const locale = langOf(ctx);
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
    const i18n = filterMessages(locale);
    const body = h`
      ${!canInstall ? alert(h`${L(locale, 'Add a domain first — applications are installed only on your domains.', 'Najpierw dodaj domenę — aplikacje instalujemy tylko na Twoich domenach.')} <a class="link" href="/user/websites/new">${L(locale, 'Create your first site in the wizard →', 'Postaw pierwszą stronę w kreatorze →')}</a>`, 'warn') : ''}
      ${alert(L(locale,
        'One catalogue, six applications. Pick a tile, check the version and installer type, then install on your own domain. After submitting the form you see the real result — no fake percentage.',
        'Jeden katalog, sześć aplikacji. Wybierz kafelek, sprawdź wersję i typ instalatora, a następnie zainstaluj na własnej domenie. Po wysłaniu formularza zobaczysz prawdziwy wynik — bez sztucznego procentu.'), 'info')}
      <div class="spread mb-12" data-app-catalog-summary>
        <div class="row" style="gap:8px">
          ${badge(L(locale, `${APPS.length} applications`, `${APPS.length} aplikacji`), 'brand')}
          ${badge(L(locale, `${installedTypes} of ${APPS.length} installed`, `${installedTypes} z ${APPS.length} zainstalowanych`), installedTypes ? 'ok' : 'muted', { dot: installedTypes > 0 })}
          ${badge(L(locale, `Available to install: ${available}`, `Dostępne do instalacji: ${available}`), 'muted')}
        </div>
        <span class="small muted">${L(locale, 'Last updated', 'Ostatnia aktualizacja')}: ${dateTime(new Date().toISOString(), locale)}</span>
      </div>
      <section data-app-catalogue aria-label="${L(locale, 'Application catalogue', 'Katalog aplikacji')}">
        <div class="toolbar" role="search" aria-label="${L(locale, 'Search and filter applications', 'Wyszukaj i filtruj aplikacje')}">
          <div class="toolbar-left">
            <div class="search">
              ${icon('search', { size: 15 })}
              <input type="search" id="app-search" data-app-search placeholder="${L(locale, 'Search applications…', 'Szukaj aplikacji…')}" aria-label="${L(locale, 'Search applications by name', 'Szukaj aplikacji po nazwie')}" autocomplete="off" style="width:280px">
            </div>
            <div class="chip-row" role="group" aria-label="${L(locale, 'Application filter', 'Filtr aplikacji')}">
              <button type="button" class="chip active" data-app-filter="all" aria-pressed="true">${L(locale, 'All', 'Wszystkie')} <span class="tab-count">${APPS.length}</span></button>
              <button type="button" class="chip" data-app-filter="installed" aria-pressed="false">${L(locale, 'Installed', 'Zainstalowane')} <span class="tab-count">${installedTypes}</span></button>
              <button type="button" class="chip" data-app-filter="available" aria-pressed="false">${L(locale, 'Available', 'Dostępne')} <span class="tab-count">${available}</span></button>
            </div>
          </div>
          <div class="toolbar-right"><span class="small muted" data-app-count aria-live="polite">${L(locale, `${APPS.length} of ${APPS.length} applications`, `${APPS.length} z ${APPS.length} aplikacji`)}</span></div>
        </div>
        <div class="app-tile-grid" id="app-grid" data-app-grid data-app-catalog>
          ${APPS.map((app) => {
            const count = counts[app.key] || 0;
            const installedState = count > 0;
            const titleId = `app-${app.key}-title`;
            return h`<article class="app-tile" id="app-${app.key}" tabindex="-1" aria-labelledby="${titleId}" aria-expanded="false" data-app-card data-app-focus-target data-app-key="${app.key}" data-app-name="${app.name} ${appDesc(app, 'pl')} ${appDesc(app, 'en')} ${app.key}" data-app-installed="${installedState ? '1' : '0'}">
              <div class="app-tile-head">
                ${appIcon(app.key, { size: 52 })}
                <div>
                  <div class="app-tile-title"><h3 id="${titleId}">${app.name}</h3>${installedState ? badge(L(locale, `Installed: ${count}`, `Zainstalowane: ${count}`), 'ok', { dot: true }) : badge(L(locale, 'Available', 'Dostępna'), 'muted')}</div>
                  <p class="app-tile-sub">${appDesc(app, locale)}</p>
                </div>
              </div>
              <div class="row" style="gap:6px">${badge(versionLabel(app, locale), 'brand')}${badge(typeLabel(app, locale), 'muted')}</div>
              <div class="app-meta"><span>PHP + MariaDB</span><span>${app.native ? L(locale, 'Updates through the panel', 'Aktualizacje przez panel') : app.mode === 'cli' ? L(locale, 'CLI, then web', 'CLI, potem WWW') : L(locale, 'Browser installer', 'Instalator w przeglądarce')}</span></div>
              <div class="app-tile-actions">
                ${canInstall
                  ? h`<button class="btn btn-primary btn-sm" type="button" data-app-open="${modalId(app)}" data-open-modal="${modalId(app)}" aria-haspopup="dialog" aria-controls="${modalId(app)}">${icon('download', { size: 15 })} ${installedState ? L(locale, 'Install another', 'Zainstaluj kolejną') : L(locale, 'Install', 'Zainstaluj')}</button>`
                  : h`<a class="btn btn-primary btn-sm" href="/user/websites/new">${icon('plus', { size: 15 })} ${L(locale, 'Add a domain to install', 'Dodaj domenę, aby zainstalować')}</a>`}
                ${installedState ? h`<a class="btn btn-ghost btn-sm" href="#twoje-aplikacje">${L(locale, `Your installs (${count})`, `Twoje instalacje (${count})`)}</a>` : ''}
              </div>
              <div class="app-tile-more small muted" data-app-detail hidden>
                <p>${typeLabel(app, locale)} · ${versionLabel(app, locale)}</p>
                <p>${L(locale, 'After installation you get files, a database and one-time admin credentials.', 'Po instalacji otrzymasz pliki, bazę i jednorazowe dane administratora.')}</p>
              </div>
            </article>`;
          })}
        </div>
        <div class="empty" data-app-no-results data-app-filter-state data-app-filter-empty role="status" hidden>
          <div class="empty-icon">${icon('search', { size: 26 })}</div>
          <strong class="empty-title" data-app-filter-title>${i18n.noResults}</strong>
          <p data-app-filter-body>${i18n.noResultsHint}</p>
          <button class="btn btn-secondary btn-sm" type="button" data-app-reset data-app-filter-cta>${i18n.reset}</button>
        </div>
      </section>

      <section id="twoje-aplikacje" class="mt-24" data-app-installed-region aria-label="${L(locale, 'Installed applications', 'Zainstalowane aplikacje')}">
        ${card(L(locale, 'Your applications', 'Twoje aplikacje'), h`${installedAll.length
          ? h`<div>${installedAll.map((row) => installedRow(ctx, row, locale))}</div>`
          : h`<div class="app-empty" data-app-empty>
              <div class="empty-icon">${icon('cart', { size: 26 })}</div>
              <p><strong>${L(locale, 'You have no applications yet', 'Nie masz jeszcze aplikacji')}</strong></p>
              <p class="small muted">${L(locale, 'Pick a tile above — installation creates files, a database and admin credentials.', 'Wybierz kafelek powyżej — instalacja utworzy pliki, bazę i dane administratora.')}</p>
              <a class="btn btn-primary btn-sm mt-10" href="#app-grid">${L(locale, 'Choose an application', 'Wybierz aplikację')}</a>
            </div>`}`, {
        sub: `${installedAll.length} ${installationLabel(locale, installedAll.length)} · ${activeCount} ${activeLabel(locale, activeCount)} · ${webInstallerCount} ${unfinishedLabel(locale, webInstallerCount)}`,
        actions: [h`<a class="link small" href="#app-grid">${L(locale, 'Install a new app →', 'Zainstaluj nową →')}</a>`],
      })}
      </section>
      ${canInstall ? APPS.map((app) => installModal(ctx, app, domains, counts[app.key] || 0, locale)) : ''}
      <script>
        (function () {
          'use strict';
          var I18N = ${scriptJson(i18n)};
          var cards = Array.prototype.slice.call(document.querySelectorAll('[data-app-card]'));
          var search = document.querySelector('[data-app-search]');
          var chips = Array.prototype.slice.call(document.querySelectorAll('[data-app-filter]'));
          var countOut = document.querySelector('[data-app-count]');
          var none = document.querySelector('[data-app-no-results]');
          var filterEmpty = document.querySelector('[data-app-filter-empty]');
          var filterTitle = document.querySelector('[data-app-filter-title]');
          var filterBody = document.querySelector('[data-app-filter-body]');
          var filterCta = document.querySelector('[data-app-filter-cta]');
          var installedRegion = document.querySelector('[data-app-installed-region]');
          var grid = document.querySelector('[data-app-grid]');
          var reset = document.querySelector('[data-app-reset]');
          var filter = 'all';
          var visibleCount = cards.length;

          function normalize(value) {
            return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          }

          function setText(node, value) {
            if (node) node.textContent = value;
          }

          function syncChips() {
            chips.forEach(function (chip) {
              var active = chip.getAttribute('data-app-filter') === filter;
              chip.classList.toggle('active', active);
              chip.setAttribute('aria-pressed', active ? 'true' : 'false');
            });
          }

          function applyFilters() {
            var query = normalize(search ? search.value.trim() : '');
            var visible = 0;
            cards.forEach(function (tile) {
              var isInstalled = tile.getAttribute('data-app-installed') === '1';
              var stateMatch = filter === 'all' || (filter === 'installed' && isInstalled) || (filter === 'available' && !isInstalled);
              var name = normalize(tile.getAttribute('data-app-name'));
              var queryMatch = !query || name.indexOf(query) !== -1;
              var show = stateMatch && queryMatch;
              tile.hidden = !show;
              if (show) visible++;
            });
            visibleCount = visible;
            if (countOut) countOut.textContent = I18N.count.replace('{visible}', String(visible)).replace('{total}', String(cards.length));
            if (grid) grid.hidden = visible === 0;
            if (none) none.hidden = visible !== 0;
            if (installedRegion) installedRegion.hidden = visible === 0;
            if (visible === 0) {
              var title = I18N.noResults;
              var body = I18N.noResultsHint;
              var cta = I18N.reset;
              if (query) {
                title = I18N.noResults; body = I18N.noResultsHint; cta = I18N.reset;
              } else if (filter === 'installed') {
                title = I18N.installedZero; body = I18N.installedZeroHint; cta = I18N.showAll;
              } else if (filter === 'available') {
                title = I18N.availableZero; body = I18N.availableZeroHint; cta = I18N.reset;
              }
              setText(filterTitle, title);
              setText(filterBody, body);
              setText(filterCta, cta);
              if (filterEmpty) filterEmpty.setAttribute('data-app-empty-kind', query ? 'search' : filter);
            }
          }

          function setFilter(next) {
            filter = next === 'installed' || next === 'available' ? next : 'all';
            syncChips();
            applyFilters();
          }

          function resetFilters() {
            if (search) search.value = '';
            filter = 'all';
            syncChips();
            applyFilters();
            if (search) search.focus();
          }

          function focusFromHash() {
            var hash = String(window.location.hash || '');
            if (hash.indexOf('#app-') !== 0) return false;
            var id = hash.slice(1);
            var target = document.getElementById(id);
            if (!target || target.getAttribute('data-app-card') === null) return false;
            if (target.hidden) {
              if (search) search.value = '';
              filter = 'all';
              syncChips();
              applyFilters();
            }
            target.hidden = false;
            target.classList.add('is-target');
            target.setAttribute('aria-expanded', 'true');
            target.setAttribute('tabindex', '-1');
            if (target.style) {
              target.style.outline = '3px solid var(--brand)';
              target.style.outlineOffset = '4px';
            }
            var detail = target.querySelector('[data-app-detail]');
            if (detail) detail.hidden = false;
            if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' });
            if (typeof target.focus === 'function') target.focus({ preventScroll: true });
            return true;
          }

          chips.forEach(function (chip) {
            chip.addEventListener('click', function () {
              setFilter(chip.getAttribute('data-app-filter') || 'all');
            });
          });
          if (search) search.addEventListener('input', applyFilters);
          if (reset) reset.addEventListener('click', resetFilters);
          window.addEventListener('hashchange', focusFromHash);
          applyFilters();
          focusFromHash();

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
              if (label) label.textContent = I18N.installing;
              form.setAttribute('aria-busy', 'true');
              if (status) {
                status.hidden = false;
                status.textContent = I18N.installingStatus;
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
              if (label) label.textContent = label.getAttribute('data-ready-label') || I18N.defaultInstall;
              var status = form.querySelector('[data-install-status]');
              if (status) status.hidden = true;
            });
          });

          window.OA_APP_CATALOG = {
            applyFilters: applyFilters,
            setFilter: setFilter,
            resetFilters: resetFilters,
            focusFromHash: focusFromHash,
            getFilter: function () { return filter; },
            getVisibleCount: function () { return visibleCount; }
          };
        })();
      </script>`;
    return page(ctx, {
      title: L(locale, 'Applications', 'Aplikacje'),
      subtitle: L(locale, 'WordPress, Nextcloud, PrestaShop, Joomla, Drupal, Moodle — in one click', 'WordPress, Nextcloud, PrestaShop, Joomla, Drupal, Moodle — jednym kliknięciem'),
      body,
      wide: true,
    });
  });

  router.post(`${A}/install`, (ctx) => {
    const locale = langOf(ctx);
    const app = listApps().find((row) => row.key === ctx.body.app);
    const result = installApp(ctx.body.app, {
      user: ctx.user, domain: ctx.body.domain, subpath: ctx.body.path,
      adminUser: 'admin', adminPass: String(ctx.body.admin_password || ''), title: ctx.body.title,
    });
    if (!result.ok) return ctx.redirect(`${A}?flash=${encodeURIComponent(result.error)}&type=error`);
    const body = h`${card(`${app?.name || ctx.body.app} — ${L(locale, 'installation', 'instalacja')}`, h`
      <div class="app-tile-head mb-18">${appIcon(ctx.body.app, { size: 52 })}<div><div class="app-tile-title"><h3>${app?.name || L(locale, 'Application', 'Aplikacja')}</h3>${badge(result.mode === 'cli' ? L(locale, 'Installed through CLI', 'Zainstalowana przez CLI') : L(locale, 'Finish in the browser', 'Do dokończenia w przeglądarce'), result.mode === 'cli' ? 'ok' : 'warn', { dot: true })}</div><p class="app-tile-sub">${result.mode === 'cli' ? L(locale, 'The application is ready. Save the admin password.', 'Aplikacja jest gotowa. Zapisz hasło administratora.') : L(locale, 'The database and files are ready — finish the installer in the browser.', 'Baza i pliki gotowe — dokończ instalator w przeglądarce.')}</p></div></div>
      ${result.warning ? alert(result.warning, 'warn') : ''}
      ${kvList([['URL', h`<a class="link" href="${result.url}" target="_blank" rel="noopener">${result.url}</a>`], [L(locale, 'Database', 'Baza'), result.db], [L(locale, 'Database user', 'Użytkownik bazy'), result.dbUser], [L(locale, 'Database password', 'Hasło bazy'), h`<code>${result.dbPass}</code>`], [L(locale, 'Administrator', 'Administrator'), result.adminUser], [L(locale, 'Admin password', 'Hasło administratora'), h`<code>${result.adminPass}</code>`]])}
      <div class="row mt-18"><a class="btn btn-primary" href="${A}">${L(locale, 'Back to applications', 'Wróć do aplikacji')}</a><a class="btn btn-secondary" href="${result.url}" target="_blank" rel="noopener">${L(locale, 'Open installer', 'Otwórz instalator')}</a><a class="btn btn-ghost" href="${A}#twoje-aplikacje">${L(locale, 'Your applications', 'Twoje aplikacje')}</a></div>`, { sub: L(locale, 'The real installation result — no shortcuts', 'Prawdziwy wynik instalacji — bez skrótów') })}`;
    return page(ctx, {
      title: L(locale, 'Application', 'Aplikacja'),
      subtitle: L(locale, 'Installation details', 'Dane instalacji'),
      body,
    });
  });

  router.post(`${A}/:id/delete`, (ctx) => {
    const locale = langOf(ctx);
    const result = deleteApp(ctx.params.id, ctx.user);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(result.ok ? L(locale, 'Application removed', 'Usunięto aplikację') : result.error)}${result.ok ? '' : '&type=error'}`);
  });
}
