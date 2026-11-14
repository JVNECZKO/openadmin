// Application shell: sidebar, top bar and document layout.
import { html, raw, e, formatBytes, humanLevel } from '../util.mjs';
import { icon } from './icons.mjs';
import { navFor, isActive } from './nav.mjs';
import { VERSION } from '../config.mjs';
import { htmlLang } from '../i18n.mjs';
import { setting } from '../db.mjs';

function brandMark(size = 30) {
  return raw(`<svg class="brand-mark" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
    <defs><linearGradient id="om" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#38bdf8"/><stop offset="0.55" stop-color="#0a6daa"/><stop offset="1" stop-color="#0b3f69"/>
    </linearGradient></defs>
    <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#om)"/>
    <path d="M16 8.5 23 22h-3.3l-1.2-2.6h-5L12.3 22H9Z" fill="#fff" opacity=".95"/>
    <path d="M16 13.2l-1.15 2.6h2.3Z" fill="#0a6daa"/>
  </svg>`);
}

function sidebar({ user, level, caps, path, counts, storage, version }) {
  const groups = navFor(level, caps, { admin: user.level === 'admin', reseller: user.level !== 'user', lang: user?.language || 'pl', mode: user?.ui_mode || 'simple' });
  return html`<aside class="sidebar" id="sidebar" data-sidebar>
    <div class="sidebar-brand">
      <a href="/${level}" class="brand-link">
        ${brandMark(34)}
        <span class="brand-text"><strong>OpenAdmin</strong><em>${level === 'admin' ? 'Server' : level === 'reseller' ? 'Reseller' : 'Control Panel'}</em></span>
      </a>
      <button class="icon-btn only-mobile" type="button" data-sidebar-close aria-label="Close menu">${icon('x', { size: 18 })}</button>
    </div>

    <div class="level-switch" role="tablist" aria-label="Panel level">
      ${user.level === 'admin' ? html`<a class="level-pill ${level === 'admin' ? 'active' : ''}" href="/admin">Admin</a>` : ''}
      ${user.level !== 'user' ? html`<a class="level-pill ${level === 'reseller' ? 'active' : ''}" href="/reseller">Reseller</a>` : ''}
      <a class="level-pill ${level === 'user' ? 'active' : ''}" href="/user">User</a>
    </div>

    <nav class="nav" aria-label="Main navigation">
      ${groups.map((g, gi) => html`<details class="nav-group" ${gi < 5 ? raw('open') : ''}>
        <summary class="nav-group-title"><span>${g.title}</span>${icon('chevronDown', { size: 14, cls: 'chev' })}</summary>
        <ul class="nav-list">
          ${g.items.map((i) => html`<li>
            <a class="nav-item ${isActive(i.href, path) ? 'active' : ''}" href="${i.href}" data-nav>
              <span class="nav-ico">${icon(i.icon, { size: 18 })}</span>
              <span class="nav-label">${i.label}</span>
              ${i.badge ? html`<span class="nav-badge">${i.badge}</span>` : ''}
              ${counts?.[i.key] ? html`<span class="nav-badge subtle">${counts[i.key]}</span>` : ''}
            </a>
          </li>`)}
        </ul>
      </details>`)}
    </nav>

    <div class="sidebar-foot">
      ${storage ? html`<div class="storage-widget">
        <div class="storage-head"><span>Disk usage</span><strong>${formatBytes(storage.used)}</strong></div>
        <div class="progress ${storage.percent > 90 ? 'danger' : storage.percent > 75 ? 'warn' : ''}"><span style="width:${storage.percent}%"></span></div>
        <div class="storage-sub"><span>${storage.percent}% of ${storage.total ? formatBytes(storage.total) : 'unlimited'}</span><span>${storage.files} files</span></div>
      </div>` : ''}
      <div class="sidebar-meta">
        <span>OpenAdmin v${version}</span>
        <span class="badge badge-ok">Free</span>
      </div>
    </div>
  </aside>`;
}

function topbar({ user, level, path, csrf, notifications, title }) {
  return html`<header class="topbar">
    <div class="topbar-left">
      <button class="icon-btn only-mobile" type="button" data-sidebar-open aria-label="Open menu">${icon('menu', { size: 20 })}</button>
      <div class="crumb"><span class="crumb-item">${level === 'admin' ? 'Admin' : level === 'reseller' ? 'Reseller' : 'User'}</span><span class="crumb-sep">/</span><span class="crumb-item">${title}</span></div>
    </div>
    <div class="topbar-center">
      <button class="search-trigger" type="button" data-open-search>
        ${icon('search', { size: 16 })}<span>Search pages and commands…</span><kbd>⌘K</kbd>
      </button>
    </div>
    <div class="topbar-right">
      <a class="icon-btn" href="/${level}/messages" title="Notifications" data-badge="${notifications}">
        ${icon('bell', { size: 19 })}${notifications ? html`<i class="notify-dot"></i>` : ''}
      </a>
      <button class="icon-btn" type="button" data-toggle-theme title="Toggle dark mode">${icon('moon', { size: 19 })}</button>
      <div class="menu">
        <button class="avatar-btn" type="button" data-menu-toggle>
          <span class="avatar">${user.username.slice(0, 1).toUpperCase()}</span>
          <span class="avatar-meta"><strong>${user.username}</strong><em>${humanLevel(user.level)}</em></span>
          ${icon('chevronDown', { size: 14 })}
        </button>
        <div class="menu-pop" data-menu hidden>
          <div class="menu-head"><strong>${user.username}</strong><span>${user.email || ''}</span></div>
          <a class="menu-item" href="/user/password">${icon('key', { size: 16 })} Change password</a>
          <a class="menu-item" href="/user/login-keys">${icon('shield', { size: 16 })} Login keys</a>
          <a class="menu-item" href="/user/statistics">${icon('chart', { size: 16 })} My statistics</a>
          <div class="menu-sep"></div>
          <a class="menu-item" href="/logout" data-csrf="${csrf}">${icon('logout', { size: 16 })} Sign out</a>
        </div>
      </div>
    </div>
  </header>`;
}

export function renderPage({
  title, subtitle = '', body, user, level, caps, active = '', csrf, flash = null,
  actions = [], counts = null, storage = null, wide = false, searchIndex = [],
}) {
  const path = active || '/';
  const docTitle = title ? `${title} · OpenAdmin` : 'OpenAdmin';
  return html`<!DOCTYPE html>
<html lang="${htmlLang(user.language || 'pl')}" data-skin="${user.skin || 'evolution'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${docTitle}</title>
  <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/assets/app.css?v=${VERSION}">
  <script>try{var m=localStorage.getItem('oa_theme');if(m==='dark'||(!m&&window.matchMedia('(prefers-color-scheme: dark)').matches&&localStorage.getItem('oa_theme')!=='light'))document.documentElement.dataset.mode='dark';}catch(e){}</script>
</head>
<body class="app-body">
  <div class="app-shell">
    ${sidebar({ user, level, caps, path, counts, storage, version: VERSION })}
    <div class="app-main">
      ${topbar({ user, level, path, csrf, title, notifications: counts?.notifications || 0 })}
      <main class="content ${wide ? 'content-wide' : ''}">
        ${setting('template:header.html', '') ? raw(`<div class="template-header">${setting('template:header.html', '')}</div>`) : ''}
        ${flash ? html`<div class="flash flash-${flash.type || 'ok'}">${icon(flash.type === 'error' ? 'alert' : 'check', { size: 18 })}<span>${flash.message}</span><button class="icon-btn" type="button" data-dismiss>${icon('x', { size: 14 })}</button></div>` : ''}
        <div class="page-head">
          <div class="page-head-text">
            <h1>${title}</h1>
            ${subtitle ? html`<p>${subtitle}</p>` : ''}
          </div>
          ${actions.length ? html`<div class="page-actions">${actions}</div>` : ''}
        </div>
        ${body}
        ${setting('template:footer.html', '') ? raw(`<div class="template-footer">${setting('template:footer.html', '')}</div>`) : ''}
      </main>
      <footer class="app-footer">
        <span>OpenAdmin ${VERSION} · free &amp; open source (AGPL-3.0) · unlimited accounts</span>
        <span class="footer-links"><a href="/api/v1/openapi.json">API</a><a href="/help">Documentation</a><a href="/admin/license">License</a></span>
      </footer>
    </div>
  </div>
  <div class="sidebar-scrim" data-sidebar-close hidden></div>
  <div class="cmd-palette" id="cmdPalette" hidden>
    <div class="cmd-box">
      <div class="cmd-input">${icon('search', { size: 18 })}<input type="text" id="cmdInput" placeholder="Search pages, settings and commands…" autocomplete="off"><kbd>esc</kbd></div>
      <div class="cmd-results" id="cmdResults"></div>
      <div class="cmd-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span></div>
    </div>
  </div>
  <div class="toast-stack" id="toasts"></div>
  <script>window.OA_CSRF=${raw(JSON.stringify(csrf || ''))};</script>
  <script type="application/json" id="oa-nav-index">${raw(JSON.stringify(searchIndex))}</script>
  <script src="/assets/app.js?v=${VERSION}" defer></script>
  <script src="/assets/i18n.js?v=${VERSION}" defer></script>
</body>
</html>`;
}

export function renderLogin({ message = '', error = '', csrf = '', serverName = '', demo = false, notice = '' }) {
  const demoAccounts = demo
    ? html`<div class="demo-strip">
        <div class="demo-title">${icon('sparkles', { size: 16 })} Live demo accounts</div>
        <div class="demo-grid">
          <button type="button" class="demo-chip" data-demo-user="demouser" data-demo-pass="demo"><strong>User</strong><span>demouser / demo</span></button>
          <button type="button" class="demo-chip" data-demo-user="demoreseller" data-demo-pass="demo"><strong>Reseller</strong><span>demoreseller / demo</span></button>
          <button type="button" class="demo-chip" data-demo-user="demoadmin" data-demo-pass="demo"><strong>Admin</strong><span>demoadmin / demo</span></button>
        </div>
      </div>`
    : '';
  return html`<!DOCTYPE html>
<html lang="en" data-skin="evolution">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Sign in · OpenAdmin</title>
  <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/assets/app.css?v=${VERSION}">
</head>
<body class="login-body">
  <div class="login-wrap">
    <section class="login-panel">
      <div class="login-brand">
        <a class="brand-link" href="/">${brandMark(38)}<span class="brand-text"><strong>OpenAdmin</strong><em>${serverName || 'Hosting Control Panel'}</em></span></a>
      </div>
      <div class="login-card">
        ${setting('template:login.html', '') ? raw(`<div class="template-login">${setting('template:login.html', '')}</div>`) : ''}
        <h1>Sign in to your panel</h1>
        <p class="login-sub">Use the same credentials for admin, reseller and user access.</p>
        ${error ? html`<div class="alert alert-danger">${icon('alert', { size: 18 })}<div>${error}</div></div>` : ''}
        ${notice ? html`<div class="alert alert-warn">${icon('info', { size: 18 })}<div>${notice}</div></div>` : ''}
        <form method="post" action="/login" class="login-form" autocomplete="on">
          <input type="hidden" name="_csrf" value="${csrf}">
          <input type="hidden" name="redirect" value="${message || ''}">
          <label class="field-label" for="username">Username</label>
          <div class="input-icon">${icon('user', { size: 18 })}<input id="username" name="username" type="text" required autofocus autocomplete="username" placeholder="your-username"></div>
          <label class="field-label" for="password">Password</label>
          <div class="input-icon">${icon('lock', { size: 18 })}<input id="password" name="password" type="password" required autocomplete="current-password" placeholder="••••••••"></div>
          <div class="login-row">
            <label class="check-field small"><input type="checkbox" name="remember" value="1" checked><span>Remember me</span></label>
            <a href="/lost-password" class="link">Forgot password?</a>
          </div>
          <button class="btn btn-primary btn-block btn-lg" type="submit">${icon('arrowRight', { size: 18 })}<span>Sign in</span></button>
        </form>
        ${demoAccounts}
        ${notice ? '' : ''}
        <p class="login-help">Need an account? Contact your hosting provider. This panel is free software under the AGPL-3.0.</p>
      </div>
      <footer class="login-foot"><span>OpenAdmin v${VERSION}</span><span>100% free · no license fees</span></footer>
    </section>
    <aside class="login-aside">
      <div class="aside-glow"></div>
      <div class="aside-inner">
        <span class="pill-light">${icon('gift', { size: 15 })} Free forever · unlimited domains</span>
        <h2>Everything your server needs,<br>nothing you have to pay for.</h2>
        <p>A DirectAdmin-compatible control panel for admins, resellers and users — domains, DNS, email, databases, files, backups and SSL in one place.</p>
        <ul class="aside-list">
          <li>${icon('check', { size: 16 })} Admin · Reseller · User panels</li>
          <li>${icon('check', { size: 16 })} DirectAdmin-compatible CMD_API</li>
          <li>${icon('check', { size: 16 })} Free licensing, unlimited accounts</li>
        </ul>
        <div class="aside-stats">
          <div><strong>3</strong><span>panel levels</span></div>
          <div><strong>110</strong><span>mapped commands</span></div>
          <div><strong>€0</strong><span>forever</span></div>
        </div>
      </div>
      <div class="aside-art" aria-hidden="true">
        <div class="mock-window">
          <div class="mock-top"><i></i><i></i><i></i></div>
          <div class="mock-body">
            <div class="mock-side"></div>
            <div class="mock-main"><div class="mock-bar w60"></div><div class="mock-tiles"><i></i><i></i><i></i></div><div class="mock-line w80"></div><div class="mock-line w50"></div><div class="mock-line w70"></div></div>
          </div>
        </div>
      </div>
    </aside>
  </div>
  <script src="/assets/app.js?v=${VERSION}" defer></script>
  <script src="/assets/i18n.js?v=${VERSION}" defer></script>
</body>
</html>`;
}

export function renderError({ code = 404, title = 'Not found', message = '', user = null, level = 'user' }) {
  const body = html`<div class="error-page">
    <div class="error-code">${code}</div>
    <h2>${title}</h2>
    <p>${message || 'The page you requested could not be found.'}</p>
    <a class="btn btn-primary" href="/${level}">${icon('home', { size: 16 })}<span>Back to dashboard</span></a>
  </div>`;
  if (!user) {
    return html`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${code} · OpenAdmin</title><link rel="stylesheet" href="/assets/app.css?v=${VERSION}"></head><body class="login-body"><div class="login-wrap single">${body}</div></body></html>`;
  }
  return renderPage({ title, body, user, level, caps: {}, active: '', csrf: '', subtitle: '' });
}
