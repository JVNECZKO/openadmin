/* OpenAdmin client behaviour: shell interactions, search palette, copy, toasts. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ---------------------------------------------------------- sidebar */
  const body = document.body;
  $$('[data-sidebar-open]').forEach((b) => b.addEventListener('click', () => {
    body.classList.add('sidebar-open');
    const scrim = $('.sidebar-scrim'); if (scrim) scrim.hidden = false;
  }));
  $$('[data-sidebar-close]').forEach((b) => b.addEventListener('click', () => {
    body.classList.remove('sidebar-open');
    const scrim = $('.sidebar-scrim'); if (scrim) scrim.hidden = true;
  }));

  /* ------------------------------------------------------------- theme */
  const themeBtn = $('[data-toggle-theme]');
  function applyTheme(mode) {
    if (mode === 'dark') document.documentElement.dataset.mode = 'dark';
    else delete document.documentElement.dataset.mode;
    try { localStorage.setItem('oa_theme', mode); } catch (e) { /* ignore */ }
  }
  if (themeBtn) themeBtn.addEventListener('click', () => {
    const dark = document.documentElement.dataset.mode === 'dark';
    applyTheme(dark ? 'light' : 'dark');
  });

  /* -------------------------------------------------------- user menu */
  const menuToggle = $('[data-menu-toggle]');
  const menuPop = $('[data-menu]');
  if (menuToggle && menuPop) {
    menuToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      menuPop.hidden = !menuPop.hidden;
    });
    document.addEventListener('click', (e) => {
      if (!menuPop.hidden && !menuPop.contains(e.target) && e.target !== menuToggle) menuPop.hidden = true;
    });
  }

  /* ------------------------------------------------------------ flash */
  $$('[data-dismiss]').forEach((b) => b.addEventListener('click', () => {
    const flash = b.closest('.flash'); if (flash) flash.remove();
  }));

  /* -------------------------------------------------------- command palette */
  let navIndex = [];
  try { navIndex = JSON.parse($('#oa-nav-index')?.textContent || '[]'); } catch (e) { navIndex = []; }
  const palette = $('#cmdPalette');
  const cmdInput = $('#cmdInput');
  const cmdResults = $('#cmdResults');
  let selIndex = 0;
  let filtered = [];

  function openPalette() {
    if (!palette) return;
    palette.hidden = false;
    setTimeout(() => cmdInput && cmdInput.focus(), 10);
    renderResults('');
  }
  function closePalette() { if (palette) palette.hidden = true; }

  function renderResults(q) {
    if (!cmdResults) return;
    const query = q.trim().toLowerCase();
    filtered = navIndex.filter((i) => !query || (i.label + ' ' + (i.group || '') + ' ' + i.href).toLowerCase().includes(query)).slice(0, 40);
    selIndex = 0;
    if (!filtered.length) {
      cmdResults.innerHTML = '<div class="cmd-group">No matches</div>';
      return;
    }
    let html = '';
    let group = '';
    filtered.forEach((item, idx) => {
      if (item.group !== group) { group = item.group; html += `<div class="cmd-group">${escapeHtml(group)}</div>`; }
      html += `<a class="cmd-item${idx === 0 ? ' sel' : ''}" href="${item.href}" data-idx="${idx}">${svgIcon(item.icon)}<span>${escapeHtml(item.label)}</span></a>`;
    });
    cmdResults.innerHTML = html;
    $$('.cmd-item', cmdResults).forEach((el) => el.addEventListener('mouseenter', () => {
      $$('.cmd-item', cmdResults).forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel'); selIndex = Number(el.dataset.idx);
    }));
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  const ICONS = { home: 'M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5', mail: 'M3 6h18v12H3z', globe: 'M3 12h18M12 3a15 15 0 0 1 0 18', chart: 'M4 20V9M10 20V4M16 20v-7', users: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6', settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z' };
  function svgIcon(name) {
    const d = ICONS[name] || ICONS.settings;
    return `<svg class="i" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  }
  $$('[data-open-search]').forEach((b) => b.addEventListener('click', openPalette));
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    if (e.key === 'Escape') { closePalette(); $$('.menu-pop').forEach((m) => (m.hidden = true)); }
    if (palette && !palette.hidden && cmdInput) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const items = $$('.cmd-item', cmdResults);
        if (!items.length) return;
        items[selIndex]?.classList.remove('sel');
        selIndex = (selIndex + 1) % items.length;
        items[selIndex]?.classList.add('sel');
        items[selIndex]?.scrollIntoView({ block: 'nearest' });
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const items = $$('.cmd-item', cmdResults);
        if (!items.length) return;
        items[selIndex]?.classList.remove('sel');
        selIndex = (selIndex - 1 + items.length) % items.length;
        items[selIndex]?.classList.add('sel');
        items[selIndex]?.scrollIntoView({ block: 'nearest' });
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const item = filtered[selIndex];
        if (item) window.location.href = item.href;
      }
    }
  });
  if (palette) palette.addEventListener('click', (e) => { if (e.target === palette) closePalette(); });
  if (cmdInput) cmdInput.addEventListener('input', (e) => renderResults(e.target.value));

  /* ------------------------------------------------------------- search filter */
  $$('[data-filter-input]').forEach((input) => {
    input.addEventListener('input', () => {
      const q = input.value.toLowerCase();
      const table = document.querySelector(input.dataset.filterInput);
      if (!table) return;
      $$('tbody tr', table).forEach((tr) => {
        tr.style.display = !q || tr.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });
  });

  /* --------------------------------------------------------------- copy */
  $$('[data-copy]').forEach((btn) => btn.addEventListener('click', async () => {
    const value = btn.dataset.copy;
    try {
      await navigator.clipboard.writeText(value);
      toast('Copied to clipboard');
    } catch (e) {
      toast('Copy failed');
    }
  }));

  /* --------------------------------------------------------------- toast */
  function toast(msg) {
    const stack = $('#toasts');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 2400);
  }
  window.oaToast = toast;

  /* ----------------------------------------------------------- demo login */
  $$('[data-demo-user]').forEach((chip) => chip.addEventListener('click', () => {
    const u = $('#username'); const p = $('#password');
    if (u && p) {
      u.value = chip.dataset.demoUser;
      p.value = chip.dataset.demoPass;
      p.focus();
    }
  }));

  /* --------------------------------------------------------------- modals */
  $$('[data-open-modal]').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();
    const m = document.getElementById(b.dataset.openModal);
    if (m) m.hidden = false;
  }));
  $$('[data-close-modal]').forEach((b) => b.addEventListener('click', () => {
    const m = b.closest('.modal-backdrop'); if (m) m.hidden = true;
  }));
  $$('.modal-backdrop').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; }));

  /* -------------------------------------------------------- confirm forms */
  $$('form[data-confirm]').forEach((f) => f.addEventListener('submit', (e) => {
    if (!window.confirm(f.dataset.confirm)) e.preventDefault();
  }));

  /* ------------------------------------------------------ select all rows */
  $$('[data-check-all]').forEach((box) => box.addEventListener('change', () => {
    const table = box.closest('table');
    $$('tbody input[type=checkbox]', table).forEach((c) => (c.checked = box.checked));
  }));

  /* ------------------------------------------------ domain selector reload */
  $$('[data-domain-select]').forEach((sel) => sel.addEventListener('change', () => {
    const url = new URL(window.location.href);
    url.searchParams.set('domain', sel.value);
    window.location.href = url.toString();
  }));

  /* -------------------------------------------------- password generator */
  $$('[data-genpass]').forEach((btn) => btn.addEventListener('click', () => {
    const target = document.querySelector(btn.dataset.genpass);
    if (!target) return;
    const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%^*-_';
    const arr = new Uint32Array(16);
    crypto.getRandomValues(arr);
    target.value = Array.from(arr).map((n) => chars[n % chars.length]).join('');
    target.type = 'text';
    toast('Password generated');
  }));

  /* ------------------------------------------------------ auto-submit filter */
  $$('[data-autosubmit]').forEach((el) => el.addEventListener('change', () => el.form && el.form.submit()));

  /* ------------------------------------------------------ file upload (base64) */
  const dropzone = $('#fileUpload');
  if (dropzone) {
    const input = $('#fileInput');
    const path = dropzone.dataset.path || '/';
    async function uploadFiles(files) {
      for (const file of files) {
        const buf = await file.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        const res = await fetch('/api/v1/files/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.OA_CSRF || '' },
          body: JSON.stringify({ path, name: file.name, data: b64 }),
        });
        const json = await res.json().catch(() => ({}));
        toast(json.ok ? `Uploaded ${file.name}` : (json.error || 'Upload failed'));
      }
      window.location.reload();
    }
    input?.addEventListener('change', () => uploadFiles(Array.from(input.files || [])));
    ['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); }));
    dropzone.addEventListener('drop', (e) => uploadFiles(Array.from(e.dataTransfer.files || [])));
  }

  /* ------------------------------------------------------- keep tab in sync */
  $$('[data-tab]').forEach((el) => el.addEventListener('click', () => {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', el.dataset.tab);
    window.location.href = url.toString();
  }));
})();
