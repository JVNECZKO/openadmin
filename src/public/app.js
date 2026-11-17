/* OpenAdmin client behaviour: shell interactions, command palette, live data,
   forms, filters, copy, toasts and progressive enhancements. */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const root = document.documentElement;
  const body = document.body;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

  const onReady = (fn) => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  };

  function debounce(fn, wait = 120) {
    let timer = null;
    return function debounced(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function normalizeVariant(variant) {
    const v = String(variant || 'info').toLowerCase();
    if (v === 'ok' || v === 'success') return 'success';
    if (v === 'danger' || v === 'error') return 'error';
    if (v === 'warn' || v === 'warning') return 'warning';
    return 'info';
  }

  function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function storageSet(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } }
  function sessionGet(key) { try { return sessionStorage.getItem(key); } catch { return null; } }
  function sessionSet(key, value) { try { sessionStorage.setItem(key, value); } catch { /* private mode */ } }

  function announce(message) {
    const region = $('[data-live-region]');
    if (!region || !message) return;
    region.textContent = '';
    setTimeout(() => { region.textContent = String(message); }, 40);
  }

  /* ------------------------------------------------------------- toasts */
  const TOAST_ICONS = {
    success: '<path d="m4 12 5 5L20 6"/>',
    error: '<path d="M12 3 2 20h20Z"/><path d="M12 9v5M12 17.5h.01"/>',
    warning: '<path d="M12 3 2 20h20Z"/><path d="M12 9v5M12 17.5h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  };

  function toastIcon(variant) {
    return `<svg class="i" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TOAST_ICONS[variant] || TOAST_ICONS.info}</svg>`;
  }

  let toastSequence = 0;
  function toast(message, options = {}) {
    if (typeof options === 'string') options = { variant: options };
    const stack = $('#toasts') || document.querySelector('.toast-stack');
    if (!stack) return null;
    const variant = normalizeVariant(options.variant);
    const el = document.createElement('div');
    el.className = `toast toast-${variant}`;
    el.id = `oa-toast-${++toastSequence}`;
    el.setAttribute('role', variant === 'error' ? 'alert' : 'status');
    el.innerHTML = `<span class="toast-icon" aria-hidden="true">${toastIcon(variant)}</span>
      <div class="toast-body"></div>
      <button class="toast-close" type="button" data-toast-dismiss aria-label="Dismiss notification">
        <svg class="i" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m5 5 14 14M19 5 5 19"/></svg>
      </button>`;
    const copy = $('.toast-body', el);
    if (options.title) {
      const strong = document.createElement('strong');
      strong.textContent = String(options.title);
      copy.appendChild(strong);
    }
    const p = document.createElement('p');
    p.textContent = String(message == null ? '' : message);
    copy.appendChild(p);

    stack.appendChild(el);
    while (stack.children.length > 4) stack.firstElementChild?.remove();

    let timeout = Number(options.timeout) || (variant === 'error' ? 7000 : 4200);
    let timer = null;
    const dismiss = () => {
      clearTimeout(timer);
      if (!el.isConnected || el.classList.contains('is-leaving')) return;
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), reduceMotion ? 0 : 180);
    };
    const arm = () => {
      clearTimeout(timer);
      if (timeout > 0) timer = setTimeout(dismiss, timeout);
    };
    const hold = () => clearTimeout(timer);
    el.addEventListener('mouseenter', hold);
    el.addEventListener('mouseleave', arm);
    el.addEventListener('focusin', hold);
    el.addEventListener('focusout', arm);
    $('[data-toast-dismiss]', el)?.addEventListener('click', dismiss);
    arm();
    return el;
  }

  /* ------------------------------------------------------------- theme */
  function currentMode() { return root.dataset.mode === 'dark' ? 'dark' : 'light'; }

  function syncThemeUi() {
    const dark = currentMode() === 'dark';
    const pl = document.documentElement.lang !== 'en';
    $$('[data-toggle-theme]').forEach((button) => {
      button.setAttribute('aria-pressed', String(dark));
      button.setAttribute('aria-label', dark ? (pl ? 'Przełącz na jasny motyw' : 'Switch to light mode') : (pl ? 'Przełącz na ciemny motyw' : 'Switch to dark mode'));
      button.setAttribute('title', dark ? (pl ? 'Przełącz na jasny motyw' : 'Switch to light mode') : (pl ? 'Przełącz na ciemny motyw' : 'Switch to dark mode'));
      const moon = $('[data-theme-icon="moon"]', button);
      const sun = $('[data-theme-icon="sun"]', button);
      if (moon) moon.hidden = dark;
      if (sun) sun.hidden = !dark;
      $$('[data-theme-label]', button).forEach((label) => { label.textContent = dark ? (pl ? 'Jasny' : 'Light') : (pl ? 'Ciemny' : 'Dark'); });
    });
    const meta = $('meta[name="theme-color"]');
    if (meta) {
      const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
      if (bg) meta.setAttribute('content', bg);
    }
    document.dispatchEvent(new CustomEvent('oa:theme', { detail: { mode: currentMode() } }));
  }

  function setTheme(mode, { persist = true } = {}) {
    const next = mode === 'dark' ? 'dark' : 'light';
    if (next === 'dark') root.dataset.mode = 'dark';
    else delete root.dataset.mode;
    if (persist) storageSet('oa_theme', next);
    syncThemeUi();
  }

  function toggleTheme() { setTheme(currentMode() === 'dark' ? 'light' : 'dark'); }

  /* ----------------------------------------------------------- sidebar */
  let sidebarReturnFocus = null;
  function sidebarOpen() {
    if (body.classList.contains('sidebar-open')) return;
    sidebarReturnFocus = document.activeElement;
    body.classList.add('sidebar-open');
    const scrim = $('.sidebar-scrim');
    if (scrim) scrim.hidden = false;
    const openBtn = $('[data-sidebar-open]');
    if (openBtn) openBtn.setAttribute('aria-expanded', 'true');
    setTimeout(() => {
      const closeBtn = $('[data-sidebar-close]');
      if (closeBtn && closeBtn.offsetParent !== null) closeBtn.focus();
      else $('.sidebar .nav-item')?.focus();
    }, 40);
  }

  function sidebarClose() {
    if (!body.classList.contains('sidebar-open')) return;
    body.classList.remove('sidebar-open');
    const scrim = $('.sidebar-scrim');
    if (scrim) { scrim.hidden = true; }
    const openBtn = $('[data-sidebar-open]');
    if (openBtn) { openBtn.setAttribute('aria-expanded', 'false'); }
    if (sidebarReturnFocus && typeof sidebarReturnFocus.focus === 'function') sidebarReturnFocus.focus();
    sidebarReturnFocus = null;
  }

  /* -------------------------------------------------------------- menu */
  function closeMenu() {
    const pop = $('[data-menu]');
    const toggle = $('[data-menu-toggle]');
    if (pop) pop.hidden = true;
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  }

  function initMenus() {
    const pop = $('[data-menu]');
    const toggle = $('[data-menu-toggle]');
    if (pop && toggle) {
      document.addEventListener('click', (event) => {
        if (pop.hidden) return;
        if (!pop.contains(event.target) && !toggle.contains(event.target)) closeMenu();
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !pop.hidden) { closeMenu(); toggle.focus(); }
      });
    }
  }

  /* ----------------------------------------------------------- overlays */
  const overlayStack = [];

  function decorateOverlay(overlay) {
    const dialog = $('.modal, .drawer', overlay);
    if (dialog) {
      if (!dialog.hasAttribute('role')) dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      const title = $('.modal-head h3, .drawer-head h3', dialog);
      if (title) {
        if (!title.id) title.id = `${overlay.id || 'overlay'}-title`;
        dialog.setAttribute('aria-labelledby', title.id);
      }
      $$('button[data-close-modal], button[data-close-drawer]', dialog).forEach((b) => {
        if (!b.getAttribute('aria-label')) b.setAttribute('aria-label', 'Close dialog');
      });
    }
  }

  function focusableIn(container) {
    return $$('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', container)
      .filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement);
  }

  function openOverlay(id, trigger) {
    const overlay = typeof id === 'string' ? document.getElementById(id) : id;
    if (!overlay || !overlay.hidden && overlay.classList.contains('is-open')) return;
    decorateOverlay(overlay);
    overlay.dataset.returnFocus = trigger ? (trigger.id || '') : '';
    overlay._oaTrigger = trigger || document.activeElement;
    overlay.hidden = false;
    void overlay.offsetWidth;
    overlay.classList.remove('is-closing');
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    overlayStack.push(overlay);
    body.classList.add('overlay-open');
    const dialog = $('.modal, .drawer', overlay) || overlay;
    const focusTarget = $('[autofocus]', dialog) || focusableIn(dialog)[0] || dialog;
    setTimeout(() => { try { focusTarget.focus({ preventScroll: true }); } catch { focusTarget.focus(); } }, 30);
  }

  function closeOverlay(overlay = overlayStack[overlayStack.length - 1]) {
    if (!overlay) return;
    const index = overlayStack.indexOf(overlay);
    if (index >= 0) overlayStack.splice(index, 1);
    overlay.classList.remove('is-open');
    overlay.classList.add('is-closing');
    const finish = () => {
      overlay.hidden = true;
      overlay.classList.remove('is-closing');
      overlay.setAttribute('aria-hidden', 'true');
      if (!overlayStack.length) body.classList.remove('overlay-open');
      const trigger = overlay._oaTrigger;
      if (trigger && typeof trigger.focus === 'function' && trigger.isConnected) trigger.focus();
      delete overlay._oaTrigger;
    };
    if (reduceMotion) finish();
    else setTimeout(finish, 180);
  }

  function initOverlays() {
    $$('.modal-backdrop, .drawer-backdrop').forEach(decorateOverlay);
    document.addEventListener('click', (event) => {
      const opener = event.target.closest('[data-open-modal]');
      if (opener) {
        event.preventDefault();
        openOverlay(opener.dataset.openModal, opener);
        return;
      }
      const drawerOpener = event.target.closest('[data-open-drawer]');
      if (drawerOpener) {
        event.preventDefault();
        openOverlay(drawerOpener.dataset.openDrawer, drawerOpener);
        return;
      }
      const closer = event.target.closest('[data-close-modal], [data-close-drawer]');
      if (closer) {
        event.preventDefault();
        closeOverlay(closer.closest('.modal-backdrop, .drawer-backdrop'));
        return;
      }
      if (event.target.matches('.modal-backdrop, .drawer-backdrop')) closeOverlay(event.target);
    });
  }

  /* ---------------------------------------------------------- palette */
  let paletteReturnFocus = null;
  let paletteItems = [];
  let paletteSel = 0;

  function readNavIndex() {
    try {
      const parsed = JSON.parse($('#oa-nav-index')?.textContent || '[]');
      return Array.isArray(parsed) ? parsed.filter((i) => i && i.label && i.href) : [];
    } catch { return []; }
  }

  const navIndex = readNavIndex();
  const entityIndex = (() => {
    try {
      const parsed = JSON.parse($('#oa-entity-index')?.textContent || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  })();
  const RECENT_KEY = 'oa_recent_pages';
  function readRecent() {
    try {
      const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.filter((item) => item && item.label && item.href).slice(0, 8) : [];
    } catch { return []; }
  }
  function rememberRecent(item) {
    if (!item || !item.href || item.href.startsWith('/login') || item.href.startsWith('/logout')) return;
    try {
      const next = [{ label: item.label, href: item.href, group: 'Ostatnio', icon: item.icon || 'clock' }, ...readRecent().filter((entry) => entry.href !== item.href)].slice(0, 8);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch { /* storage may be disabled */ }
  }
  const palette = $('#cmdPalette');
  const cmdInput = $('#cmdInput');
  const cmdResults = $('#cmdResults');

  const PALETTE_ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 7 8.5-7"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18"/>',
    chart: '<path d="M4 20V9M10 20V4M16 20v-7"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.4-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    bell: '<path d="M18 8a6 6 0 1 0-12 0c0 6-2 6-2 8h16c0-2-2-2-2-8"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v4h-4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>',
    logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="M10 8l-4 4 4 4M6 12h9"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    folder: '<path d="M3 7.5A2 2 0 0 1 5 5.5h4l2 2.5h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    command: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3Z"/>',
  };

  function paletteSvg(name) {
    const shape = PALETTE_ICONS[name] || PALETTE_ICONS.settings;
    const body = String(shape).trim().startsWith('<') ? String(shape) : `<path d="${shape}"/>`;
    return `<svg class="i cmd-ico" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  }

  function paletteActions() {
    const dark = currentMode() === 'dark';
    const bellHref = $('[data-bell]')?.getAttribute('href') || `/${window.OA_PAGE?.level || 'user'}/messages`;
    const actions = [
      {
        label: dark ? 'Switch to light theme' : 'Switch to dark theme',
        group: 'Actions', icon: dark ? 'sun' : 'moon', hint: 'theme',
        keywords: 'theme dark light mode kolory motyw',
        run: () => setTheme(dark ? 'light' : 'dark'),
      },
      {
        label: 'Refresh this page', group: 'Actions', icon: 'refresh', hint: 'reload',
        keywords: 'reload refresh odśwież',
        run: () => window.location.reload(),
      },
      {
        label: autoRefreshTimer ? 'Turn off auto-refresh' : 'Turn on auto-refresh',
        group: 'Actions', icon: 'clock', hint: 'auto',
        keywords: 'auto refresh interval odświeżanie',
        run: () => toggleAutoRefresh(),
      },
      {
        label: 'Open notifications', group: 'Actions', icon: 'bell', hint: 'inbox',
        keywords: 'notifications messages powiadomienia',
        href: bellHref,
      },
      {
        label: 'Sign out', group: 'Actions', icon: 'logout', hint: 'logout',
        keywords: 'logout sign out wyloguj',
        run: async () => {
          const meta = document.querySelector('meta[name="csrf-token"]');
          await fetch('/logout', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ _csrf: meta?.content || '' }),
          }).catch(() => {});
          window.location.href = '/login';
        },
      },
    ];
    return actions;
  }

  function highlightLabel(text, query) {
    const safe = escapeHtml(text);
    if (!query) return safe;
    try {
      return safe.replace(new RegExp(`(${escapeRegex(escapeHtml(query))})`, 'ig'), '<mark>$1</mark>');
    } catch { return safe; }
  }

  function updatePaletteSelection() {
    const nodes = $$('.cmd-item', cmdResults || document);
    nodes.forEach((node) => {
      const selected = Number(node.dataset.cmdIdx) === paletteSel;
      node.classList.toggle('sel', selected);
      node.setAttribute('aria-selected', String(selected));
    });
    if (cmdInput && nodes[paletteSel]) cmdInput.setAttribute('aria-activedescendant', nodes[paletteSel].id);
    nodes[paletteSel]?.scrollIntoView({ block: 'nearest' });
  }

  function renderPalette(query = '') {
    if (!cmdResults) return;
    const q = String(query || '').trim().toLowerCase();
    const matches = (item) => !q || [item.label, item.group, item.href, item.keywords].filter(Boolean).join(' ').toLowerCase().includes(q);
    const actions = paletteActions().filter(matches);
    const recent = readRecent().filter(matches);
    const entities = entityIndex.filter(matches);
    const pages = navIndex.filter(matches);
    const seen = new Set();
    const unique = (items) => items.filter((item) => { if (!item.href || seen.has(item.href)) return false; seen.add(item.href); return true; });
    const recentItems = recent.map((item) => ({ ...item, group: 'Ostatnio', icon: item.icon || 'clock' }));
    paletteItems = [...actions, ...unique(recentItems), ...unique(entities), ...unique(pages)].slice(0, 60);
    paletteSel = 0;
    if (!paletteItems.length) {
      cmdResults.innerHTML = `<div class="cmd-empty"><span>No matches for “${escapeHtml(q)}”</span><small>Spróbuj „motyw”, „domeny” lub „backup”.</small></div>`;
      cmdInput?.removeAttribute('aria-activedescendant');
      return;
    }
    let html = '';
    let group = '';
    paletteItems.forEach((item, index) => {
      if (item.group !== group) {
        group = item.group;
        html += `<div class="cmd-group" role="group" aria-label="${escapeHtml(group || 'Results')}">${escapeHtml(group)}</div>`;
      }
      const tag = item.href ? 'a' : 'button';
      const hrefAttr = item.href ? ` href="${escapeHtml(item.href)}"` : ` type="button"`;
      const hint = item.hint ? `<span class="cmd-hint">${escapeHtml(item.hint)}</span>` : '';
      html += `<${tag} class="cmd-item${index === 0 ? ' sel' : ''}"${hrefAttr} role="option" id="cmd-opt-${index}" data-cmd-idx="${index}" aria-selected="${index === 0}">
        ${paletteSvg(item.icon)}<span class="cmd-label">${highlightLabel(item.label, query)}</span>${hint}
      </${tag}>`;
    });
    cmdResults.innerHTML = html;
    updatePaletteSelection();
  }

  function activatePaletteItem(index) {
    const item = paletteItems[index];
    if (!item) return;
    if (item.href) {
      rememberRecent(item);
      closePalette();
      window.location.href = item.href;
      return;
    }
    closePalette();
    try { item.run(); } catch (error) { toast(String(error?.message || error), { variant: 'error' }); }
  }

  function openPalette() {
    if (!palette) return;
    paletteReturnFocus = document.activeElement;
    palette.hidden = false;
    body.classList.add('palette-open');
    cmdInput?.setAttribute('aria-expanded', 'true');
    renderPalette('');
    if (cmdInput) {
      cmdInput.value = '';
      setTimeout(() => cmdInput.focus(), 20);
    }
    $$('[data-open-search]').forEach((b) => b.setAttribute('aria-expanded', 'true'));
  }

  function closePalette() {
    if (!palette || palette.hidden) return;
    palette.hidden = true;
    body.classList.remove('palette-open');
    cmdInput?.setAttribute('aria-expanded', 'false');
    $$('[data-open-search]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    if (paletteReturnFocus && typeof paletteReturnFocus.focus === 'function') paletteReturnFocus.focus();
    paletteReturnFocus = null;
  }

  function paletteKeydown(event) {
    if (!palette || palette.hidden) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (!paletteItems.length) return true;
      if (event.key === 'Home') paletteSel = 0;
      else if (event.key === 'End') paletteSel = paletteItems.length - 1;
      else paletteSel = (paletteSel + (event.key === 'ArrowDown' ? 1 : -1) + paletteItems.length) % paletteItems.length;
      updatePaletteSelection();
      return true;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      activatePaletteItem(paletteSel);
      return true;
    }
    if (event.key === 'Tab') {
      // Keep the combobox interaction predictable: focus stays in the search field.
      event.preventDefault();
      cmdInput?.focus();
      return true;
    }
    return false;
  }

  function initPalette() {
    if (!palette) return;
    try {
      const page = window.OA_PAGE || {};
      if (page.path && page.title && page.path !== '/') rememberRecent({ label: page.title, href: page.path, group: 'Ostatnio' });
    } catch { /* ignore */ }
    $$('[data-open-search]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    cmdInput?.addEventListener('input', (event) => renderPalette(event.target.value));
    cmdResults?.addEventListener('click', (event) => {
      const item = event.target.closest('.cmd-item');
      if (!item) return;
      event.preventDefault();
      activatePaletteItem(Number(item.dataset.cmdIdx));
    });
    cmdResults?.addEventListener('mouseover', (event) => {
      const item = event.target.closest('.cmd-item');
      if (!item) return;
      paletteSel = Number(item.dataset.cmdIdx) || 0;
      updatePaletteSelection();
    });
    palette.addEventListener('click', (event) => { if (event.target === palette) closePalette(); });
    $$('[data-shortcut]').forEach((kbd) => { kbd.textContent = isMac ? '⌘K' : 'Ctrl K'; });
  }

  /* -------------------------------------------------------- auto refresh */
  const AUTO_KEY = 'oa_autorefresh';
  let autoRefreshFailures = 0;
  let autoRefreshBackoffUntil = 0;
  let autoRefreshTimer = null;
  let autoRefreshLast = 0;
  let autoRefreshInterval = 30;
  let autoRefreshAllowed = false;

  function refreshStampKey() { return `oa:lastRefresh:${location.pathname}${location.search}`; }

  function formatClock(date = new Date()) {
    const locale = (document.documentElement.lang || 'en').toLowerCase().startsWith('pl') ? 'pl-PL' : undefined;
    return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function stampPrefix() {
    return (document.documentElement.lang || 'en').toLowerCase().startsWith('pl') ? 'Zaktualizowano' : 'Updated';
  }

  function showRefreshStamp(text) {
    $$('[data-refresh-stamp]').forEach((el) => {
      if (text) {
        el.hidden = false;
        el.textContent = `${stampPrefix()} ${text}`;
      }
    });
  }

  function markRefreshed() {
    const stamp = formatClock();
    sessionSet(refreshStampKey(), stamp);
    showRefreshStamp(stamp);
    announce(`${stampPrefix()} ${stamp}`);
  }

  function hasPendingForm() {
    return !!document.querySelector('form.is-submitting') || body.classList.contains('is-submitting');
  }

  let softRefreshAt = 0;
  async function refreshPage() {
    if (document.hidden || hasPendingForm() || overlayStack.length) return;
    if (Date.now() - softRefreshAt < 8000) return;
    softRefreshAt = Date.now();
    /* Soft refresh: keep the shell and the page header (including the
       auto-refresh control) mounted; replace only the content cards. This
       avoids the full-page repaint/flicker that looked like a broken layout. */
    try {
      const res = await fetch(location.href, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'text/html' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const doc = new DOMParser().parseFromString(text, 'text/html');
      const fresh = doc.querySelector('main.content');
      const current = document.querySelector('main.content');
      if (!fresh || !current) throw new Error('content missing');
      const focus = document.activeElement;
      if (focus && current.contains(focus) && /^(INPUT|TEXTAREA|SELECT)$/.test(focus.tagName)) return;
      const scroll = window.scrollY;
      const oldHead = current.querySelector('.page-head');
      const freshNodes = Array.from(fresh.children).filter((n) => !n.classList.contains('page-head'));
      current.innerHTML = '';
      if (oldHead) current.appendChild(oldHead);
      freshNodes.forEach((n) => current.appendChild(n));
      if (window.scrollY !== scroll) window.scrollTo({ top: scroll, behavior: 'instant' });
      initForms();
      initFilters();
      initTableScroll();
      autoRefreshFailures = 0;
      autoRefreshBackoffUntil = 0;
      markRefreshed();
      document.dispatchEvent(new CustomEvent('oa:content-refreshed'));
    } catch {
      autoRefreshFailures += 1;
      const delay = Math.min(300000, Math.max(5000, autoRefreshInterval * 1000 * (2 ** Math.min(autoRefreshFailures, 5))));
      autoRefreshBackoffUntil = Date.now() + delay;
      updateAutoRefreshUi();
      announce(`Połączenie nie odpowiada. Kolejna próba za ${Math.ceil(delay / 1000)} s.`);
    }
  }

  function stopAutoRefresh() {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
    updateAutoRefreshUi();
  }

  function startAutoRefresh(interval = autoRefreshInterval) {
    autoRefreshInterval = Math.max(10, Math.min(3600, Number(interval) || 30));
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    autoRefreshLast = Date.now();
    autoRefreshTimer = setInterval(() => {
      if (document.hidden || !navigator.onLine) return;
      if (Date.now() < autoRefreshBackoffUntil) return;
      if (Date.now() - autoRefreshLast < autoRefreshInterval * 1000) return;
      autoRefreshLast = Date.now();
      refreshPage();
    }, 1000);
    updateAutoRefreshUi();
  }

  function updateAutoRefreshUi() {
    $$('[data-toggle-auto-refresh]').forEach((button) => {
      const on = !!autoRefreshTimer;
      button.setAttribute('aria-pressed', String(on));
      button.setAttribute('title', on
        ? `Auto-refresh is on (${autoRefreshInterval}s) — paused while this tab is hidden`
        : 'Auto-refresh this page every 30 seconds');
      const state = $('[data-ar-state]', button);
      if (state) state.textContent = !navigator.onLine ? 'Offline' : autoRefreshBackoffUntil > Date.now() ? 'Retry' : on ? 'On' : 'Off';
    });
  }

  function setAutoRefresh(on, interval = 30) {
    if (on && !autoRefreshAllowed) {
      announce('Auto-refresh is only available on overview and monitoring pages');
      return;
    }
    autoRefreshInterval = Math.max(10, Math.min(3600, Number(interval) || 30));
    if (on) {
      storageSet(AUTO_KEY, '1');
      startAutoRefresh(autoRefreshInterval);
      announce(`Auto-refresh is on. This page reloads every ${autoRefreshInterval} seconds.`);
    } else {
      storageSet(AUTO_KEY, '0');
      stopAutoRefresh();
      announce('Auto-refresh is off.');
    }
  }

  function toggleAutoRefresh() {
    setAutoRefresh(!autoRefreshTimer, Number($('[data-toggle-auto-refresh]')?.dataset.interval || autoRefreshInterval));
  }

  function initAutoRefresh() {
    const control = $('[data-toggle-auto-refresh]');
    const preference = storageGet(AUTO_KEY);
    const cleanPath = (location.pathname || '/').replace(/\/+$/, '') || '/';
    /* Auto-refresh is only for overview/monitoring screens. Interactive pages
       (terminal, file editor, wizards, installers, mail compose) must never be
       silently replaced while the user is typing or reading command output. */
    const autoSafePaths = new Set([
      '/user', '/user/statistics', '/reseller', '/reseller/statistics',
      '/admin', '/admin/users', '/admin/processes', '/admin/log-center', '/admin/logs',
    ]);
    const autoAllowed = autoSafePaths.has(cleanPath);
    autoRefreshAllowed = autoAllowed;
    window.addEventListener('online', () => updateAutoRefreshUi());
    window.addEventListener('offline', () => updateAutoRefreshUi());
    if (!autoAllowed && control) {
      control.hidden = true;
      control.setAttribute('aria-disabled', 'true');
      control.title = 'Auto-refresh is available on overview and monitoring pages';
    }
    const saved = preference === '1' && !!control && autoAllowed;
    const defaultOnPaths = new Set(['/admin', '/admin/users', '/admin/processes', '/admin/log-center', '/admin/logs', '/user', '/reseller']);
    const defaultOn = preference === null && !!control && autoAllowed && defaultOnPaths.has(cleanPath);
    const last = sessionGet(refreshStampKey());
    if (last) showRefreshStamp(last);
    if (saved || defaultOn) {
      startAutoRefresh(Number(control?.dataset.interval || 30));
      if (defaultOn && !last) showRefreshStamp(formatClock());
    } else {
      updateAutoRefreshUi();
    }

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && autoRefreshTimer && Date.now() - autoRefreshLast >= autoRefreshInterval * 1000) {
        autoRefreshLast = Date.now();
        refreshPage();
      }
    });

    /* Generic opt-in hook: [data-auto-refresh] on a page/container.
       Value can be a number of seconds (reload) or an absolute/relative URL
       (poll and refresh [data-refresh-target], the element, or a live field). */
    $$('[data-auto-refresh]').forEach((el) => {
      if (el.dataset.liveScope === 'notifications') return;
      const rawValue = String(el.getAttribute('data-auto-refresh') || '').trim();
      if (!rawValue || /^(off|false|0)$/i.test(rawValue)) return;
      const isUrl = /^(https?:\/\/|\/)/.test(rawValue);
      const seconds = Math.max(10, Number(el.dataset.refreshInterval) || (isUrl ? 30 : Number(rawValue) || 30));
      let lastRun = 0;
      const tick = async () => {
        if (document.hidden || Date.now() - lastRun < seconds * 1000) return;
        lastRun = Date.now();
        if (!isUrl) {
          if (!hasPendingForm() && !overlayStack.length) refreshPage();
          return;
        }
        try {
          const res = await fetch(rawValue, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json, text/html' } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const type = res.headers.get('content-type') || '';
          const target = el.dataset.refreshTarget ? $(el.dataset.refreshTarget) : el;
          if (type.includes('application/json')) {
            const data = await res.json();
            const field = el.dataset.refreshField;
            if (field && target) {
              const value = field.split('.').reduce((acc, key) => (acc && acc[key] != null ? acc[key] : undefined), data);
              if (value != null) target.textContent = String(value);
            }
            el.dispatchEvent(new CustomEvent('oa:refresh', { bubbles: true, detail: { data, url: rawValue } }));
          } else if (target) {
            target.innerHTML = await res.text();
          }
          markRefreshed();
        } catch (error) {
          el.dispatchEvent(new CustomEvent('oa:refresh-error', { bubbles: true, detail: { error, url: rawValue } }));
        }
      };
      setInterval(tick, 1000);
      if (isUrl) tick();
    });
  }

  /* ---------------------------------------------------------- live data */
  function valueAtPath(data, path) {
    if (!path) return undefined;
    return String(path).split('.').reduce((acc, key) => (acc && acc[key] != null ? acc[key] : undefined), data);
  }

  function setLiveState(el, state, detail = {}) {
    if (!el) return;
    el.classList.remove('is-online', 'is-offline', 'is-checking');
    if (state) el.classList.add(`is-${state}`);
    const pl = document.documentElement.lang !== 'en';
    const label = $('[data-live-label]', el);
    if (label) label.textContent = state === 'offline' ? (pl ? 'Offline' : 'Offline') : state === 'checking' ? (pl ? 'Sprawdzanie' : 'Checking') : (pl ? 'Online' : 'Live');
    const meta = $('[data-live-meta]', el);
    if (meta) {
      if (state === 'offline') meta.textContent = pl ? 'ponawiam…' : 'retrying…';
      else if (state === 'online') meta.textContent = detail.meta || (pl ? `sprawdzono ${formatClock().slice(0, 5)}` : `checked ${formatClock().slice(0, 5)}`);
      else meta.textContent = pl ? 'sprawdzanie…' : 'checking…';
    }
    el.dispatchEvent(new CustomEvent('oa:live', { bubbles: true, detail: { state, ...detail } }));
  }

  function applyLive(el, data, res) {
    if (!el) return;
    if (data && data.ok === false) {
      setLiveState(el, 'offline', { data });
      return;
    }
    const meta = $('[data-live-meta]', el);
    if (meta && data && typeof data.uptime === 'number') {
      const seconds = Math.max(0, Math.round(data.uptime));
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      meta.textContent = hours ? `up ${hours}h ${minutes}m` : `up ${minutes}m`;
    } else if (meta) {
      meta.textContent = `checked ${formatClock().slice(0, 5)}`;
    }
    const field = el.dataset.liveField;
    if (field) {
      const value = valueAtPath(data, field);
      if (value != null) {
        const target = el.dataset.liveTarget ? $(el.dataset.liveTarget) : ($('[data-live-value]', el) || el);
        if (target) {
          target.textContent = String(value);
          target.classList.add('is-updated');
          setTimeout(() => target.classList.remove('is-updated'), 900);
        }
      }
    }
    setLiveState(el, 'online', { data, status: res?.status, meta: meta?.textContent });
  }

  function initLive() {
    const elements = $$('[data-live-url]').filter((el) => !['notifications', 'dashboard'].includes(el.dataset.liveScope || ''));
    if (!elements.length) return;
    elements.forEach((el) => {
      const url = el.dataset.liveUrl;
      if (!url) return;
      const interval = Math.max(10, Number(el.dataset.liveInterval) || 60);
      let lastRun = 0;
      const tick = async () => {
        if (document.hidden || Date.now() - lastRun < interval * 1000) return;
        lastRun = Date.now();
        try {
          const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json, text/plain, text/html' } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const type = res.headers.get('content-type') || '';
          const data = type.includes('json') ? await res.json() : { text: await res.text(), ok: true };
          applyLive(el, data, res);
        } catch (error) {
          setLiveState(el, 'offline', { error });
          el.dispatchEvent(new CustomEvent('oa:live', { bubbles: true, detail: { state: 'offline', error } }));
        }
      };
      setInterval(tick, 1000);
      el.addEventListener('oa:refresh-requested', () => { lastRun = 0; tick(); });
      tick();
    });
  }

  /* Notification center: consume the JSON/SSE hooks emitted by the inbox card.
     Polling is the fallback; EventSource upgrades the same endpoint when it is
     available. We deliberately reload only when the visible feed changed so a
     quiet polling tick never steals focus from the reader. */
  function updateNotificationBadge(unread) {
    if (!Number.isFinite(Number(unread))) return;
    const count = Number(unread);
    $$('[data-bell]').forEach((bell) => {
      bell.dataset.badge = String(count);
      const countEl = $('[data-badge-count]', bell);
      if (countEl) {
        countEl.textContent = count > 99 ? '99+' : String(count);
        countEl.hidden = count <= 0;
      }
      const pl = document.documentElement.lang !== 'en';
      bell.setAttribute('aria-label', `${pl ? 'Powiadomienia' : 'Notifications'}${count ? (pl ? ` (${count} nieprzeczytane)` : ` (${count} unread)`) : ''}`);
    });
  }

  function initNotificationScopes() {
    const scopes = $$('[data-live-scope="notifications"]');
    if (!scopes.length) return;
    const pl = (document.documentElement.lang || 'pl').toLowerCase().startsWith('pl');
    const liveText = (unread) => (pl
      ? `Odświeżono ${formatClock()} · ${unread} nieprzeczytane`
      : `Updated ${formatClock()} · ${unread} unread`);

    scopes.forEach((scope) => {
      const url = scope.dataset.liveUrl;
      const stream = scope.dataset.liveStream;
      if (!url) return;
      const seconds = Math.max(5, Number(scope.dataset.autoRefresh) || Number(scope.dataset.refreshInterval) || 15);
      let signature = null;
      let scheduled = false;
      let lastPoll = 0;
      let source = null;

      const scheduleReload = () => {
        if (scheduled || document.hidden) return;
        scheduled = true;
        setTimeout(() => {
          if (document.hidden || hasPendingForm() || overlayStack.length) { scheduled = false; return; }
          window.location.reload();
        }, 500);
      };

      const absorb = (data, { changed = false } = {}) => {
        if (!data || typeof data !== 'object') return;
        const unread = Number(data.unread ?? data.unread_count ?? 0);
        updateNotificationBadge(unread);
        const indicator = $('[data-live-indicator]', scope);
        if (indicator) {
          indicator.textContent = liveText(unread);
          indicator.classList.add('is-updated');
          setTimeout(() => indicator.classList.remove('is-updated'), 1200);
        }
        scope.dataset.lastSync = String(Date.now());
        const items = Array.isArray(data.items) ? data.items : Array.isArray(data.notifications) ? data.notifications : null;
        const next = items && items.length
          ? `${unread}|${items.map((n) => n.id).join(',')}`
          : `${unread}|${Number(data.count) || 0}`;
        if (signature !== null && next !== signature && changed) scheduleReload();
        signature = next;
      };

      const poll = async () => {
        if (document.hidden || Date.now() - lastPoll < seconds * 1000) return;
        lastPoll = Date.now();
        try {
          const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
          if (!res.ok) return;
          const data = await res.json();
          absorb(data, { changed: true });
        } catch { /* keep the server-rendered inbox */ }
      };

      const connect = () => {
        if (!stream || typeof window.EventSource !== 'function' || document.hidden) return;
        try {
          source = new EventSource(stream);
          source.addEventListener('ready', (event) => {
            try { absorb(JSON.parse(event.data)); } catch { /* ignore malformed frame */ }
          });
          source.addEventListener('notification', (event) => {
            try {
              const data = JSON.parse(event.data);
              absorb(data, { changed: false });
              scheduleReload();
            } catch { scheduleReload(); }
          });
          source.addEventListener('change', (event) => {
            try {
              const data = JSON.parse(event.data);
              absorb(data, { changed: false });
              updateNotificationBadge(Number(data.unread ?? data.unread_count ?? 0));
              scheduleReload();
            } catch { scheduleReload(); }
          });
          source.onerror = () => {
            // EventSource reconnects by itself; polling below remains the fallback.
            if (source && source.readyState === 2) { source.close(); source = null; }
          };
        } catch { source = null; }
      };

      connect();
      setInterval(poll, 1000);
      poll();
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) { source?.close(); source = null; }
        else { connect(); lastPoll = 0; poll(); }
      });
      window.addEventListener('pagehide', () => { try { source?.close(); } catch { /* ignore */ } }, { once: true });
    });
  }

  /* Notification badge polling hook. Any bell/indicator with
     data-badge-url is polled when the backend exposes a JSON count endpoint.
     Supported shapes: {count}, {unread}, {unread_count}, {badge}, {data:{count}}. */
  function initBadgePolling() {
    $$('[data-badge-url]').forEach((el) => {
      const interval = Math.max(10, Number(el.dataset.badgeInterval) || 60);
      let lastRun = 0;
      const tick = async () => {
        if (document.hidden || Date.now() - lastRun < interval * 1000) return;
        lastRun = Date.now();
        try {
          const res = await fetch(el.dataset.badgeUrl, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
          if (!res.ok) return;
          const data = await res.json();
          let count = data?.count ?? data?.unread ?? data?.unread_count ?? data?.badge ?? data?.data?.count;
          if (Array.isArray(data?.data)) count = data.data.length;
          count = Number(count);
          if (!Number.isFinite(count)) return;
          const previous = Number(el.dataset.badge || 0);
          el.dataset.badge = String(count);
          const countEl = $('[data-badge-count]', el);
          if (countEl) {
            countEl.textContent = count > 99 ? '99+' : String(count);
            countEl.hidden = count <= 0;
          }
          el.setAttribute('aria-label', `${document.documentElement.lang === 'en' ? 'Notifications' : 'Powiadomienia'}${count ? (document.documentElement.lang === 'en' ? ` (${count} unread)` : ` (${count} nieprzeczytane)`) : ''}`);
          if (count > previous) announce(`${count} unread notification${count === 1 ? '' : 's'}`);
        } catch { /* keep the last server-rendered count */ }
      };
      setInterval(tick, 1000);
    });
  }

  /* ------------------------------------------------------ skeletons */
  function revealSkeleton(target) {
    const nodes = typeof target === 'string' ? $$(target) : (target ? [target] : []);
    nodes.forEach((el) => {
      el.classList.remove('skeleton');
      el.classList.add('is-skeleton-loaded');
      el.removeAttribute('data-skeleton');
      el.dispatchEvent(new CustomEvent('oa:skeleton-revealed', { bubbles: true }));
    });
  }

  function initSkeletons() {
    $$('[data-skeleton]:not([data-skeleton-hold])').forEach((el) => {
      const delay = Math.max(0, Number(el.dataset.skeletonDelay) || 120);
      setTimeout(() => revealSkeleton(el), delay);
    });
  }

  /* ------------------------------------------------------------ copy */
  async function copyText(value) {
    const text = String(value == null ? '' : value);
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall through to legacy copy */ }
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.className = 'visually-hidden-fixed';
      document.body.appendChild(area);
      area.select();
      area.setSelectionRange(0, area.value.length);
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch { return false; }
  }

  async function handleCopy(button) {
    const value = button.dataset.copy ?? '';
    const label = button.dataset.copyLabel || 'Copied to clipboard';
    const ok = await copyText(value);
    toast(ok ? label : 'Could not copy — select the value and copy it manually.', { variant: ok ? 'success' : 'error' });
    if (ok) {
      button.classList.add('is-copied');
      setTimeout(() => button.classList.remove('is-copied'), 1200);
    }
  }

  /* ----------------------------------------------------------- filters */
  function tableFromInput(input) {
    const selector = input.dataset.filterInput || input.dataset.filterTable;
    if (!selector) return null;
    try { return document.querySelector(selector); } catch { return null; }
  }

  function applyTableFilter(input) {
    const table = tableFromInput(input);
    if (!table) return;
    const query = String(input.value || '').trim().toLowerCase();
    const rows = $$('tbody tr', table).filter((row) => !row.classList.contains('filter-empty'));
    let visible = 0;
    rows.forEach((row) => {
      const match = !query || row.textContent.toLowerCase().includes(query);
      row.hidden = !match;
      if (match) visible += 1;
    });
    let empty = $('tbody tr.filter-empty', table);
    const headers = $$('thead th', table);
    if (!visible) {
      if (!empty) {
        empty = document.createElement('tr');
        empty.className = 'filter-empty';
        empty.innerHTML = `<td colspan="${Math.max(1, headers.length)}"><span class="filter-empty-text">No matching rows.</span></td>`;
        $('tbody', table)?.appendChild(empty);
      }
      empty.hidden = false;
    } else if (empty) {
      empty.hidden = true;
    }
    if (input.dataset.filterCount) {
      const count = document.querySelector(input.dataset.filterCount);
      if (count) count.textContent = `${visible} / ${rows.length}`;
    }
    input.dispatchEvent(new CustomEvent('oa:filter', { bubbles: true, detail: { table, query, visible, total: rows.length } }));
  }

  function initFilters() {
    $$('[data-filter-input]').forEach((input) => {
      const run = debounce(() => applyTableFilter(input), 80);
      input.addEventListener('input', run);
      input.addEventListener('search', run);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { input.value = ''; applyTableFilter(input); }
      });
      if (input.value) applyTableFilter(input);
    });
  }

  /* ------------------------------------------------------------ forms */
  function preserveSubmitterValue(form, submitter) {
    if (!submitter || !submitter.name || submitter.tagName === 'INPUT' && submitter.type === 'image') return;
    const existing = form.querySelector(`input[type="hidden"][data-submit-preserve][name="${CSS.escape(submitter.name)}"]`);
    if (existing) return;
    const hidden = document.createElement('input');
    hidden.type = 'hidden';
    hidden.name = submitter.name;
    hidden.value = submitter.value ?? '';
    hidden.setAttribute('data-submit-preserve', '');
    form.appendChild(hidden);
  }

  function markFormLoading(form, submitter) {
    form.classList.add('is-submitting');
    form.setAttribute('aria-busy', 'true');
    body.classList.add('is-submitting');
    const target = submitter || form.querySelector('button[type="submit"], input[type="submit"]');
    if (!target) return;
    // Preserve the submitter's name/value first, then disable synchronously so
    // the browser cannot submit the same form twice. The duplicate hidden field
    // keeps forms that branch on the clicked action intact.
    preserveSubmitterValue(form, target);
    target.classList.add('is-loading');
    target.setAttribute('aria-disabled', 'true');
    if (target.isConnected) {
      target.dataset.loadingDisabled = target.disabled ? 'was-disabled' : '1';
      target.disabled = true;
    }
    setTimeout(() => {
      if (document.contains(form)) resetFormLoading();
    }, 15000);
    const buttons = $$('button[type="submit"], input[type="submit"]', form).filter((b) => b !== target);
    buttons.forEach((b) => b.setAttribute('aria-disabled', 'true'));
  }

  function resetFormLoading() {
    $$('form.is-submitting').forEach((form) => {
      form.classList.remove('is-submitting');
      form.removeAttribute('aria-busy');
    });
    $$('[data-loading-disabled]').forEach((button) => {
      if (button.dataset.loadingDisabled !== 'was-disabled') button.disabled = false;
      delete button.dataset.loadingDisabled;
      button.classList.remove('is-loading');
      button.removeAttribute('aria-disabled');
    });
    $$('.is-loading').forEach((el) => el.classList.remove('is-loading'));
    body.classList.remove('is-submitting');
  }

  function initForms() {
    document.addEventListener('submit', (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      if (event.defaultPrevented) return;
      if (form.classList.contains('is-submitting')) {
        event.preventDefault();
        return;
      }
      if (form.hasAttribute('data-confirm') && form.dataset.oaConfirmed !== '1') {
        if (!window.confirm(form.getAttribute('data-confirm') || (document.documentElement.lang === 'en' ? 'Are you sure?' : 'Kontynuować?'))) {
          event.preventDefault();
          return;
        }
        form.dataset.oaConfirmed = '1';
      }
      if (form.hasAttribute('data-no-loading') || form.dataset.loading === 'off') return;
      markFormLoading(form, event.submitter);
    });
    window.addEventListener('pageshow', (event) => { if (event.persisted) resetFormLoading(); });
  }

  /* --------------------------------------------------------- page misc */
  function initSidebar() {
    const groups = $$('.nav-group');
    let hydrating = true;
    let saved = {};
    try { saved = JSON.parse(storageGet('oa_nav_groups') || '{}') || {}; } catch { saved = {}; }
    groups.forEach((group) => {
      const title = group.dataset.navGroup || '';
      if (group.querySelector('.nav-item.active')) group.open = true;
      else if (Object.prototype.hasOwnProperty.call(saved, title)) group.open = !!saved[title];
      group.addEventListener('toggle', () => {
        if (hydrating) return;
        const state = {};
        groups.forEach((g) => { state[g.dataset.navGroup || ''] = g.open; });
        storageSet('oa_nav_groups', JSON.stringify(state));
      });
    });
    hydrating = false;

    const nav = $('[data-nav-scroll]');
    const active = $('.nav-item.active', nav || document);
    if (nav && active) {
      // Keep the browser's saved nav scroll position. Only nudge the list when
      // the active item is genuinely outside the visible nav viewport, and do
      // the smallest possible scroll (never centre it and never jump past the
      // first group on load).
      const navBox = nav.getBoundingClientRect();
      const itemBox = active.getBoundingClientRect();
      const pad = 8;
      if (itemBox.top < navBox.top + pad) {
        nav.scrollTop = Math.max(0, nav.scrollTop - (navBox.top + pad - itemBox.top));
      } else if (itemBox.bottom > navBox.bottom - pad) {
        nav.scrollTop = Math.min(
          Math.max(0, nav.scrollHeight - nav.clientHeight),
          nav.scrollTop + (itemBox.bottom - navBox.bottom + pad),
        );
      }
    }

    window.addEventListener('resize', () => { if (window.innerWidth > 900) sidebarClose(); });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if ($('[data-menu]') && !$('[data-menu]').hidden) return;
      if (body.classList.contains('sidebar-open')) sidebarClose();
    });
  }

  function initAccordions() {
    document.addEventListener('toggle', (event) => {
      const details = event.target;
      if (!(details instanceof HTMLDetailsElement)) return;
      if (!details.open) return;
      const container = details.closest('[data-accordion]');
      if (!container) return;
      $$('details[open]', container).forEach((other) => {
        if (other !== details) other.open = false;
      });
    }, true);
  }

  function initCheckAll() {
    document.addEventListener('change', (event) => {
      const box = event.target.closest('[data-check-all]');
      if (box) {
        const table = box.closest('table');
        if (!table) return;
        $$('tbody input[type="checkbox"]', table).forEach((c) => {
          if (!c.closest('tr')?.hidden) c.checked = box.checked;
        });
        box.indeterminate = false;
        return;
      }
      if (event.target.matches('tbody input[type="checkbox"]')) {
        const table = event.target.closest('table');
        const all = $('[data-check-all]', table);
        if (!all) return;
        const rows = $$('tbody input[type="checkbox"]', table).filter((c) => !c.closest('tr')?.hidden);
        const checked = rows.filter((c) => c.checked).length;
        all.checked = checked === rows.length && rows.length > 0;
        all.indeterminate = checked > 0 && checked < rows.length;
      }
    });
  }

  function initMisc() {
    document.addEventListener('change', (event) => {
      if (event.target.matches('[data-autosubmit]') && event.target.form) event.target.form.submit();
      if (event.target.matches('[data-domain-select]')) {
        const url = new URL(window.location.href);
        url.searchParams.set('domain', event.target.value);
        window.location.href = url.toString();
      }
    });

    document.addEventListener('click', (event) => {
      const demo = event.target.closest('[data-demo-user]');
      if (demo) {
        const u = $('#username');
        const p = $('#password');
        if (u && p) {
          u.value = demo.dataset.demoUser;
          p.value = demo.dataset.demoPass;
          p.focus();
        }
        return;
      }
      const gen = event.target.closest('[data-genpass]');
      if (gen) {
        const target = document.querySelector(gen.dataset.genpass);
        if (!target) return;
        const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%^*-_';
        const arr = new Uint32Array(16);
        if (window.crypto?.getRandomValues) window.crypto.getRandomValues(arr);
        else for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 2 ** 32);
        target.value = Array.from(arr).map((n) => chars[n % chars.length]).join('');
        target.type = 'text';
        toast('Password generated', { variant: 'success' });
        return;
      }
      const tab = event.target.closest('[data-tab]');
      if (tab) {
        const url = new URL(window.location.href);
        url.searchParams.set('tab', tab.dataset.tab);
        window.location.href = url.toString();
      }
    });
  }

  function initDismiss() {
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-dismiss], [data-toast-dismiss]');
      if (!button) return;
      const node = button.closest('.flash, .toast, .alert, .notice, [data-dismissible]');
      if (!node) return;
      if (node.classList.contains('toast')) {
        if (node.classList.contains('is-leaving')) return;
        node.classList.add('is-leaving');
        setTimeout(() => node.remove(), reduceMotion ? 0 : 180);
      } else {
        node.classList.add('is-leaving');
        setTimeout(() => node.remove(), reduceMotion ? 0 : 160);
      }
    });
  }

  function initTheme() {
    syncThemeUi();
    window.addEventListener('storage', (event) => {
      if (event.key === 'oa_theme') {
        root.dataset.mode = event.newValue === 'dark' ? 'dark' : '';
        if (event.newValue !== 'dark') delete root.dataset.mode;
        syncThemeUi();
      }
      if (event.key === AUTO_KEY) {
        if (event.newValue === '1') startAutoRefresh(); else stopAutoRefresh();
      }
    });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener?.('change', (event) => {
      if (!storageGet('oa_theme')) {
        root.dataset.mode = event.matches ? 'dark' : '';
        if (!event.matches) delete root.dataset.mode;
        syncThemeUi();
      }
    });
  }

  /* --------------------------------------------------------- upload */
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        resolve(result.slice(result.indexOf(',') + 1));
      };
      reader.onerror = () => reject(reader.error || new Error('Could not read file'));
      reader.readAsDataURL(file);
    });
  }

  function initUpload() {
    const dropzone = $('#fileUpload');
    if (!dropzone) return;
    const input = $('#fileInput');
    if (!input) return;
    const path = dropzone.dataset.path || '/';
    dropzone.setAttribute('role', 'button');
    dropzone.setAttribute('tabindex', '0');
    dropzone.setAttribute('aria-label', 'Upload files: drop files here or press Enter to browse');
    dropzone.addEventListener('click', (event) => {
      if (event.target !== input) input.click();
    });
    dropzone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); }
    });
    function uploadStream(file, offset = 0, attempt = 0) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const query = new URLSearchParams({ path, name: file.name });
        xhr.open('POST', `/user/files/upload-stream?${query}`);
        xhr.responseType = 'json';
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.setRequestHeader('X-CSRF-Token', window.OA_CSRF || document.querySelector('meta[name="csrf-token"]')?.content || '');
        xhr.setRequestHeader('X-Upload-Offset', String(offset));
        xhr.upload.onprogress = (event) => {
          if (!event.lengthComputable) return;
          const pct = Math.min(100, Math.round(((offset + event.loaded) / Math.max(1, file.size)) * 100));
          const bar = dropzone.querySelector('[data-upload-progress]');
          if (bar) {
            for (const name of [...bar.classList]) if (/^pct-\d+$/.test(name)) bar.classList.remove(name);
            bar.classList.add(`pct-${pct}`);
          }
        };
        xhr.onload = () => {
          const json = xhr.response || {};
          if (xhr.status === 200 && json.ok) return resolve(json);
          if (xhr.status === 409 && Number.isFinite(Number(json.offset)) && attempt < 2) {
            return resolve(uploadStream(file, Number(json.offset), attempt + 1));
          }
          reject(new Error(json.error || `HTTP ${xhr.status}`));
        };
        xhr.onerror = () => {
          if (attempt < 2) return resolve(uploadStream(file, offset, attempt + 1));
          reject(new Error('Połączenie przerwane — spróbuj ponownie.'));
        };
        xhr.send(file.slice(offset));
      });
    }

    async function uploadFiles(files) {
      if (!files.length) return;
      dropzone.classList.add('is-uploading');
      let ok = 0;
      const pending = toast(`Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`, { variant: 'info', timeout: 0 });
      try {
        for (const file of files) {
          try {
            const maxBytes = Number(dropzone.dataset.maxUploadBytes || 0);
            if (maxBytes > 0 && file.size > maxBytes) {
              toast(`${file.name}: ${(file.size / 1048576).toFixed(1)} MB przekracza limit ${(maxBytes / 1048576).toFixed(0)} MB.`, { variant: 'error' });
              continue;
            }
            await uploadStream(file, 0);
            ok += 1;
            toast(`Uploaded ${file.name}`, { variant: 'success' });
          } catch (error) {
            toast(error?.message || `Upload failed: ${file.name}`, { variant: 'error' });
          }
        }
      } finally {
        pending?.remove();
        dropzone.classList.remove('is-uploading');
      }
      if (ok) setTimeout(() => window.location.reload(), 500);
    }
    input.addEventListener('change', () => uploadFiles(Array.from(input.files || [])));
    ['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (event) => {
      event.preventDefault();
      dropzone.classList.add('drag');
    }));
    ['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (event) => {
      event.preventDefault();
      dropzone.classList.remove('drag');
    }));
    dropzone.addEventListener('drop', (event) => uploadFiles(Array.from(event.dataTransfer?.files || [])));
  }

  /* ---------------------------------------------------------- tabs */
  function initTabs() {
    $$('.tabs').forEach((tabs) => {
      if (tabs.parentElement?.classList.contains('tabs-scroll')) return;
      const shell = document.createElement('div');
      shell.className = 'tabs-scroll';
      tabs.parentNode.insertBefore(shell, tabs);
      shell.appendChild(tabs);
      const hint = document.createElement('span');
      hint.className = 'tabs-hint';
      hint.setAttribute('aria-hidden', 'true');
      hint.innerHTML = `<svg class="i" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`;
      shell.appendChild(hint);
      const sync = () => {
        const scrollable = tabs.scrollWidth > tabs.clientWidth + 2;
        shell.classList.toggle('is-scrollable', scrollable);
        shell.classList.toggle('is-end', tabs.scrollLeft + tabs.clientWidth >= tabs.scrollWidth - 3);
      };
      tabs.addEventListener('scroll', sync, { passive: true });
      window.addEventListener('resize', sync, { passive: true });
      sync();
    });
  }

  /* ------------------------------------------------------ table scroll */
  function initTableScroll() {
    const wraps = $$('.table-wrap');
    wraps.forEach((wrap) => {
      if (!wrap.hasAttribute('tabindex')) wrap.setAttribute('tabindex', '0');
      if (!wrap.hasAttribute('role')) wrap.setAttribute('role', 'group');
      if (!wrap.getAttribute('aria-label')) wrap.setAttribute('aria-label', 'Tabela przewijalna w poziomie');
      const sync = () => {
        const scrollable = wrap.scrollWidth > wrap.clientWidth + 1;
        wrap.classList.toggle('is-scrollable', scrollable);
        wrap.classList.toggle('is-scrolled-end', wrap.scrollLeft + wrap.clientWidth >= wrap.scrollWidth - 2);
        wrap.dataset.scrollState = scrollable ? 'scrollable' : 'fit';
      };
      sync();
      wrap.addEventListener('scroll', sync, { passive: true });
      window.addEventListener('resize', sync, { passive: true });
    });
  }

  /* ---------------------------------------------------------- boot */

  function initWizard() {
    const form = document.querySelector('[data-wizard]');
    if (!form) return;
    const steps = $$('[data-wizard-step]', form);
    if (steps.length < 2) return;
    const indicators = $$('[data-wizard-indicator-step]', form);
    const fallback = $('[data-wizard-fallback]', form);
    let index = 0;
    form.classList.add('wizard-ready');
    const appSelect = form.querySelector('[name="app"]');
    const appPassword = form.querySelector('[name="app_admin_password"]');
    const syncAppRequired = () => { if (appPassword) appPassword.required = !!appSelect && appSelect.value !== 'none'; };
    if (appSelect) { appSelect.addEventListener('change', syncAppRequired); syncAppRequired(); }
    const firstInvalid = (step) => $$('input, select, textarea', step).find((el) => !el.disabled && el.willValidate && !el.checkValidity());
    function show(next, { scroll = true, focus = true } = {}) {
      index = Math.max(0, Math.min(steps.length - 1, next));
      steps.forEach((step, i) => { step.hidden = i !== index; });
      indicators.forEach((ind, i) => {
        ind.classList.toggle('is-active', i === index);
        ind.classList.toggle('is-done', i < index);
      });
      form.classList.toggle('wizard-last', index === steps.length - 1);
      if (fallback) fallback.hidden = true;
      const heading = $('h2', steps[index]);
      if (heading && focus) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
      if (scroll) {
        const top = steps[index].getBoundingClientRect().top + window.scrollY - 90;
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
    }
    form.addEventListener('click', (event) => {
      const next = event.target.closest('[data-wizard-next]');
      const back = event.target.closest('[data-wizard-back]');
      const submit = event.target.closest('[data-wizard-submit]');
      if (next) {
        const bad = firstInvalid(steps[index]);
        if (bad) { bad.reportValidity(); bad.focus(); return; }
        show(index + 1);
        return;
      }
      if (back) { show(index - 1); return; }
      if (submit) {
        const bad = firstInvalid(steps[index]);
        if (bad) { bad.reportValidity(); bad.focus(); return; }
        form.requestSubmit();
      }
    });
    show(0, { scroll: false, focus: false });
  }


  function initTerminal() {
    const form = $('.term-form');
    if (!form) return;
    const input = $('input[name="command"]', form);
    const term = $('#term');
    const submit = $('button[type="submit"]', form);
    if (!input || !term) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const command = input.value.trim();
      if (!command) return;
      const formData = new URLSearchParams(new FormData(form));
      const line = document.createElement('div');
      line.className = 'tline tline-pending';
      line.textContent = `$ ${command}`;
      term.appendChild(line);
      input.value = '';
      if (submit) { submit.disabled = true; submit.classList.add('is-loading'); }
      try {
        const res = await fetch(form.action, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'X-Requested-With': 'fetch' },
          body: formData,
        });
        const data = await res.json().catch(() => ({}));
        const out = document.createElement('div');
        out.className = 'tline';
        out.textContent = data.ok ? String(data.output || '(brak wyniku)').split('\n').slice(1).join('\n') : (data.error || `Błąd HTTP ${res.status}`);
        term.appendChild(out);
      } catch (error) {
        const out = document.createElement('div');
        out.className = 'tline tline-error';
        out.textContent = `Błąd: ${error.message}`;
        term.appendChild(out);
      } finally {
        if (submit) { submit.disabled = false; submit.classList.remove('is-loading'); }
        input.focus();
        term.scrollTop = term.scrollHeight;
      }
    });
  }


  function initPackageBuilder() {
    const form = document.querySelector('[data-package-form]');
    if (!form) return;
    const preset = form.querySelector('[data-package-preset]');
    const summary = form.querySelector('[data-package-summary]');
    const featureSet = form.querySelector('[data-feature-set]');
    const featureNote = form.querySelector('[data-feature-note]');
    const limitInputs = $$('[data-limit]', form);
    const presets = {
      starter: { domains: 1, subdomains: 5, emails: 5, ftp: 2, databases: 1, disk_mb: 1024, bandwidth_mb: 10240, cron: 0, ssl: 1, max_processes: 50 },
      business: { domains: 10, subdomains: 50, emails: 100, ftp: 20, databases: 20, disk_mb: 20480, bandwidth_mb: 204800, cron: 10, ssl: 10, max_processes: 100 },
      unlimited: Object.fromEntries(limitInputs.map((input) => [input.dataset.limit, 0])),
    };
    const pl = document.documentElement.lang !== 'en';
    const syncUnlimited = () => {
      $$('[data-unlimited]', form).forEach((checkbox) => {
        const input = form.querySelector(`[data-limit="${checkbox.dataset.unlimited}"]`);
        if (!input) return;
        input.disabled = checkbox.checked;
        if (checkbox.checked) input.value = '0';
      });
      updateSummary();
    };
    const updateSummary = () => {
      if (!summary) return;
      const values = Object.fromEntries(limitInputs.map((input) => [input.dataset.limit, input.value]));
      const fmt = (key, suffix = '') => values[key] === '0' || values[key] === '' ? (pl ? 'nielimitowane' : 'unlimited') : `${values[key]}${suffix}`;
      summary.textContent = pl
        ? `Domeny: ${fmt('domains')} · Skrzynki: ${fmt('emails')} · Dysk: ${fmt('disk_mb', ' MB')} · Transfer: ${fmt('bandwidth_mb', ' MB')}`
        : `Domains: ${fmt('domains')} · Mailboxes: ${fmt('emails')} · Disk: ${fmt('disk_mb', ' MB')} · Bandwidth: ${fmt('bandwidth_mb', ' MB')}`;
    };
    form.addEventListener('change', (event) => {
      if (event.target.matches('[data-unlimited]')) { syncUnlimited(); return; }
      if (event.target.matches('[data-package-preset]') && presets[event.target.value]) {
        for (const [key, value] of Object.entries(presets[event.target.value])) {
          const input = form.querySelector(`[data-limit="${key}"]`);
          if (input) input.value = String(value);
        }
        syncUnlimited();
        return;
      }
      if (event.target.matches('[data-feature-set]') && featureNote) {
        featureNote.classList.toggle('is-active', !!event.target.value);
        featureNote.textContent = event.target.value
          ? (pl ? 'Wybrany feature set nadpisuje poniższe przełączniki podczas zapisu.' : 'The selected feature set overrides the toggles below on save.')
          : (pl ? 'Przy ręcznym ustawieniu decydują checkboksy.' : 'Manual mode uses the checkboxes below.');
        return;
      }
      updateSummary();
    });
    syncUnlimited();
  }


  function initPasswordTools() {
    const pl = document.documentElement.lang !== 'en';
    $$('input[type="password"]').forEach((input) => {
      if (input.disabled || input.readOnly || input.dataset.passwordTools === '1') return;
      input.dataset.passwordTools = '1';
      const tools = document.createElement('span');
      tools.className = 'password-tools';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'icon-btn password-toggle';
      toggle.setAttribute('aria-label', pl ? 'Pokaż hasło' : 'Show password');
      toggle.textContent = pl ? 'Pokaż' : 'Show';
      toggle.addEventListener('click', () => {
        const visible = input.type === 'text';
        input.type = visible ? 'password' : 'text';
        toggle.textContent = visible ? (pl ? 'Pokaż' : 'Show') : (pl ? 'Ukryj' : 'Hide');
        toggle.setAttribute('aria-label', visible ? (pl ? 'Pokaż hasło' : 'Show password') : (pl ? 'Ukryj hasło' : 'Hide password'));
      });
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'icon-btn password-copy';
      copy.setAttribute('aria-label', pl ? 'Kopiuj hasło' : 'Copy password');
      copy.textContent = pl ? 'Kopiuj' : 'Copy';
      copy.addEventListener('click', async () => {
        if (!input.value) { toast(pl ? 'Pole hasła jest puste' : 'Password field is empty', { variant: 'warn' }); return; }
        const ok = await copyText(input.value);
        toast(ok ? (pl ? 'Hasło skopiowane' : 'Password copied') : (pl ? 'Nie udało się skopiować' : 'Could not copy'), { variant: ok ? 'success' : 'error' });
      });
      tools.append(toggle, copy);
      const control = input.closest('.field-control') || input;
      control.insertAdjacentElement('afterend', tools);
    });
  }

  function initDirtyGuard() {
    const dirty = new WeakSet();
    const pl = document.documentElement.lang !== 'en';
    document.addEventListener('input', (event) => {
      const form = event.target.closest('form');
      if (form && String(form.method).toLowerCase() === 'post' && !form.dataset.noDirtyGuard) dirty.add(form);
    });
    document.addEventListener('change', (event) => {
      const form = event.target.closest('form');
      if (form && String(form.method).toLowerCase() === 'post' && !form.dataset.noDirtyGuard) dirty.add(form);
    });
    document.addEventListener('submit', (event) => {
      const form = event.target.closest('form');
      if (form) form.dataset.submitted = '1';
    }, true);
    window.addEventListener('beforeunload', (event) => {
      const forms = $$('form').filter((form) => dirty.has(form) && form.dataset.submitted !== '1');
      if (!forms.length) return;
      event.preventDefault();
      event.returnValue = pl ? 'Masz niezapisane zmiany. Opuścić stronę?' : 'You have unsaved changes. Leave the page?';
      return event.returnValue;
    });
  }

  function init() {
    root.classList.add('is-ready');
    initSidebar();
    initTheme();
    initMenus();
    initDismiss();
    initPalette();
    initLive();
    initNotificationScopes();
    initBadgePolling();
    initAutoRefresh();
    initForms();
    initFilters();
    initTableScroll();
    initTabs();
    initOverlays();
    initAccordions();
    initSkeletons();
    initCheckAll();
    initMisc();
    initUpload();
    initWizard();
    initPackageBuilder();
    initPasswordTools();
    initDirtyGuard();
    initTerminal();
    updateAutoRefreshUi();

    document.addEventListener('change', (event) => {
      if (event.target.matches('[data-auto-submit]') && event.target.form) event.target.form.requestSubmit();
    });

    /* Delegated shell actions keep working for markup inserted later. */
    document.addEventListener('click', (event) => {
      const target = event.target;
      const confirmEl = target.closest('[data-confirm]');
      if (confirmEl && confirmEl.tagName !== 'FORM' && confirmEl.dataset.oaConfirmed !== '1') {
        if (!window.confirm(confirmEl.getAttribute('data-confirm') || (document.documentElement.lang === 'en' ? 'Are you sure?' : 'Kontynuować?'))) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        confirmEl.dataset.oaConfirmed = '1';
      }
      if (target.closest('[data-refresh-now]')) { refreshPage(); return; }
      if (target.closest('[data-sidebar-open]')) { sidebarOpen(); return; }
      if (target.closest('[data-sidebar-close]')) { sidebarClose(); return; }
      if (target.closest('[data-menu-toggle]')) {
        event.stopPropagation();
        const pop = $('[data-menu]');
        const toggle = $('[data-menu-toggle]');
        if (pop) {
          pop.hidden = !pop.hidden;
          toggle?.setAttribute('aria-expanded', String(!pop.hidden));
        }
        return;
      }
      if (target.closest('[data-toggle-theme]')) { toggleTheme(); return; }
      if (target.closest('[data-open-search]')) { openPalette(); return; }
      if (target.closest('[data-toggle-auto-refresh]')) { toggleAutoRefresh(); return; }
      const liveRefresh = target.closest('[data-live-refresh]');
      if (liveRefresh) {
        event.preventDefault();
        markRefreshed();
        if (liveRefresh.dataset.liveRefresh === 'poll') {
          const host = liveRefresh.closest('[data-live-url]');
          host?.dispatchEvent(new CustomEvent('oa:refresh-requested', { bubbles: true }));
        } else {
          window.location.reload();
        }
        return;
      }
      const copy = target.closest('[data-copy]');
      if (copy) { handleCopy(copy); return; }
      if (target.closest('.menu-item')) closeMenu();
    });

    document.addEventListener('keydown', (event) => {
      const key = event.key;
      const commandK = (event.metaKey || event.ctrlKey) && String(key).toLowerCase() === 'k';
      if (commandK) {
        event.preventDefault();
        if (palette && !palette.hidden) closePalette();
        else openPalette();
        return;
      }
      if (paletteKeydown(event)) return;
      if (key === 'Escape') {
        if (palette && !palette.hidden) { closePalette(); return; }
        if (overlayStack.length) { event.preventDefault(); closeOverlay(); return; }
        if ($('[data-menu]') && !$('[data-menu]').hidden) { closeMenu(); return; }
        if (body.classList.contains('sidebar-open')) sidebarClose();
        return;
      }
      if (overlayStack.length && key === 'Tab') {
        const overlay = overlayStack[overlayStack.length - 1];
        const dialog = $('.modal, .drawer', overlay) || overlay;
        const focusable = focusableIn(dialog);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
  }

  onReady(init);

  /* Public hooks for feature modules and small inline enhancements. */
  window.OA = Object.assign(window.OA || {}, {
    toast,
    announce,
    setTheme,
    toggleTheme,
    setAutoRefresh,
    toggleAutoRefresh,
    refreshLive: () => $$('[data-live-url]').forEach((el) => el.dispatchEvent(new CustomEvent('oa:refresh-requested', { bubbles: true }))),
    openPalette,
    closePalette,
    copy: copyText,
    revealSkeleton,
    isAutoRefreshOn: () => !!autoRefreshTimer,
  });
  window.oaToast = toast;
})();

/* Inject the session CSRF token into server-rendered action forms that do not
   carry one (table row actions, compact icon forms). */
(function () {
  var meta = document.querySelector('meta[name="csrf-token"]');
  if (!meta || !meta.content) return;
  function inject() {
    document.querySelectorAll('form[method="post"], form[method="POST"]').forEach(function (f) {
      if (f.querySelector('input[name="_csrf"]')) return;
      var i = document.createElement('input');
      i.type = 'hidden'; i.name = '_csrf'; i.value = meta.content;
      i.setAttribute('data-csrf-injected', '');
      f.appendChild(i);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
  else inject();
  new MutationObserver(inject).observe(document.body, { childList: true, subtree: true });
})();

/* Backup destination: show only fields that apply to the selected type. */
(function () {
  const remote = ['host', 'port', 'username', 'password', 'key'];
  document.querySelectorAll('form').forEach((form) => {
    const type = form.querySelector('select[name="type"]');
    if (!type || !form.querySelector('input[name="name"]')) return;
    const fieldFor = (name) => form.querySelector(`[name="${name}"]`)?.closest('.field');
    const sync = () => {
      const value = type.value;
      for (const name of remote) {
        const field = fieldFor(name);
        if (!field) continue;
        const visible = value === 'sftp' || value === 'ftp' || value === 's3';
        field.hidden = !visible;
        if (name === 'port') field.hidden = value === 's3';
        if (name === 'key') field.hidden = value !== 'sftp';
      }
      const path = fieldFor('path');
      if (path) {
        const label = path.querySelector('.field-label');
        if (label) label.textContent = value === 'local' ? 'Katalog lokalny' : 'Katalog / bucket / prefiks';
      }
    };
    type.addEventListener('change', sync);
    sync();
  });
})();
