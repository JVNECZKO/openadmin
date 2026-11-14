#!/usr/bin/env node
/* Read-only visual/UX audit harness for OpenAdmin.
 *
 * Usage:
 *   node tools/visual-audit.mjs --base http://127.0.0.1:2311 --out /tmp/visual-audit-x
 *
 * It logs in through the real login form as the three demo accounts, then
 * captures full-page screenshots and DOM metrics for each route at 390/768/1440.
 * It never writes to the application data directory or modifies src/.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

/* ------------------------------------------------------------------ args */
const argv = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
}
function flag(name) { return argv.includes(`--${name}`); }
const BASE = (arg('base', 'http://127.0.0.1:2311')).replace(/\/$/, '');
const OUT = arg('out', `/tmp/visual-audit-${Date.now()}`);
const SHOTS = path.join(OUT, 'shots');
const CHROME = arg('chrome', process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const ONLY = arg('only', ''); // comma separated route ids or roles
const WIDTHS_OVERRIDE = arg('widths', '');
const SKIP_TABS = flag('skip-tabs');
const SKIP_HTML_SCAN = flag('skip-html-scan');

for (const d of [OUT, SHOTS, path.join(OUT, 'logs')]) fs.mkdirSync(d, { recursive: true });

/* --------------------------------------------------------------- routes */
const CORE = [
  { role: 'login', id: 'login', path: '/login', label: 'Login' },

  { role: 'admin', id: 'dashboard', path: '/admin', label: 'Admin dashboard' },
  { role: 'admin', id: 'users', path: '/admin/users', label: 'Admin users' },
  { role: 'admin', id: 'user-packages', path: '/admin/user-packages', label: 'Admin user packages' },
  { role: 'admin', id: 'reseller-packages', path: '/admin/reseller-packages', label: 'Admin reseller packages' },
  { role: 'admin', id: 'security', path: '/admin/security', label: 'Security center' },
  { role: 'admin', id: 'mail', path: '/admin/mail', label: 'Mail operations' },
  { role: 'admin', id: 'backup-center', path: '/admin/backup-center', label: 'Backup center' },
  { role: 'admin', id: 'php', path: '/admin/php', label: 'PHP manager' },
  { role: 'admin', id: 'plans', path: '/admin/plans', label: 'Plans & limits' },
  { role: 'admin', id: 'dns-ops', path: '/admin/dns-ops', label: 'DNS operations' },
  { role: 'admin', id: 'processes', path: '/admin/processes', label: 'Process monitor' },
  { role: 'admin', id: 'log-center', path: '/admin/log-center', label: 'Log center' },
  { role: 'admin', id: 'panel-config', path: '/admin/panel-config', label: 'Panel configuration' },
  { role: 'admin', id: 'web-server', path: '/admin/web-server', label: 'Web server' },
  { role: 'admin', id: 'automation', path: '/admin/automation', label: 'Automation' },

  { role: 'reseller', id: 'dashboard', path: '/reseller', label: 'Reseller dashboard' },
  { role: 'reseller', id: 'users', path: '/reseller/users', label: 'Reseller users' },
  { role: 'reseller', id: 'packages', path: '/reseller/packages', label: 'Reseller packages' },
  { role: 'reseller', id: 'domains', path: '/reseller/domains', label: 'Reseller domains' },
  { role: 'reseller', id: 'apps', path: '/reseller/apps', label: 'Reseller apps' },
  { role: 'reseller', id: 'dns', path: '/reseller/dns', label: 'Reseller DNS' },
  { role: 'reseller', id: 'backups', path: '/reseller/backups', label: 'Reseller backups' },
  { role: 'reseller', id: 'tickets', path: '/reseller/tickets', label: 'Reseller tickets' },
  { role: 'reseller', id: 'settings', path: '/reseller/settings', label: 'Reseller settings' },

  { role: 'user', id: 'dashboard', path: '/user', label: 'User dashboard' },
  { role: 'user', id: 'domains', path: '/user/domains', label: 'User domains' },
  { role: 'user', id: 'dns', path: '/user/dns', label: 'User DNS' },
  { role: 'user', id: 'email', path: '/user/email', label: 'User email' },
  { role: 'user', id: 'files', path: '/user/files', label: 'File manager' },
  { role: 'user', id: 'databases', path: '/user/databases', label: 'Databases' },
  { role: 'user', id: 'ssl', path: '/user/ssl', label: 'SSL/TLS' },
  { role: 'user', id: 'backups', path: '/user/backups', label: 'User backups' },
  { role: 'user', id: 'app-catalog', path: '/user/app-catalog', label: 'App catalog' },
  { role: 'user', id: 'wordpress', path: '/user/wordpress', label: 'WordPress manager' },
  { role: 'user', id: 'webdisk', path: '/user/webdisk', label: 'WebDisk' },
  { role: 'user', id: 'statistics', path: '/user/statistics', label: 'User statistics' },
  { role: 'user', id: 'help', path: '/user/help', label: 'User help' },

  /* Site creation flow requested by lead: wizard entry, domain create/edit,
     subdomains and the admin web-server page (engine config). */
  { role: 'user', id: 'websites-new', path: '/user/websites/new', label: 'Add website wizard' },
  { role: 'user', id: 'domains-create', path: '/user/domains/create', label: 'Create domain' },
  { role: 'user', id: 'domain-edit', path: '/user/domains/1/edit', label: 'Edit domain' },
  { role: 'user', id: 'subdomains', path: '/user/subdomains', label: 'Subdomains' },
];

const TAB_ROUTES = [];
function tabs(role, basePath, idPrefix, keys, labelPrefix, widths = [1440, 390]) {
  for (const key of keys) {
    TAB_ROUTES.push({
      role, id: `${idPrefix}-${key}`, path: `${basePath}?tab=${key}`,
      label: `${labelPrefix} · ${key}`, widths, tab: key,
    });
  }
}
if (!SKIP_TABS) {
  tabs('admin', '/admin/security', 'security', ['firewall', 'ssh', 'keys', 'policy', 'countries', 'groups', 'mail', 'waf'], 'Security');
  tabs('admin', '/admin/mail', 'mail', ['diagnose', 'queue', 'events', 'filters', 'routing', 'smtp', 'settings'], 'Mail');
  tabs('admin', '/admin/backup-center', 'backup-center', ['jobs', 'runs'], 'Backup center');
  tabs('admin', '/admin/php', 'php', ['ini', 'extensions', 'fpm', 'apache'], 'PHP');
  tabs('admin', '/admin/plans', 'plans', ['features', 'sets'], 'Plans');
  tabs('admin', '/admin/dns-ops', 'dns-ops', ['mx', 'templates', 'cleanup'], 'DNS ops');
  tabs('admin', '/admin/log-center', 'log-center', ['rotation'], 'Log center');
  tabs('admin', '/admin/panel-config', 'panel-config', ['access', 'network', 'export'], 'Panel config');
}

const VIEWPORTS = {
  390: { width: 390, height: 844 },
  768: { width: 768, height: 1024 },
  1440: { width: 1440, height: 1000 },
};
const DEFAULT_WIDTHS = [390, 768, 1440];

let routes = [...CORE.map((r) => ({ ...r, widths: DEFAULT_WIDTHS })), ...TAB_ROUTES];
if (ONLY) {
  const filters = ONLY.split(',').map((s) => s.trim()).filter(Boolean);
  routes = routes.filter((r) => filters.includes(r.role) || filters.includes(r.id) || filters.some((f) => r.id.startsWith(f + '-')));
}
if (WIDTHS_OVERRIDE) {
  const ws = WIDTHS_OVERRIDE.split(',').map(Number).filter((n) => VIEWPORTS[n]);
  routes = routes.map((r) => ({ ...r, widths: ws.filter((w) => (r.widths || DEFAULT_WIDTHS).includes(w)) }));
}
routes = routes.filter((r) => r.widths && r.widths.length);

const ACCOUNTS = {
  admin: { username: 'demoadmin', password: 'demo' },
  reseller: { username: 'demoreseller', password: 'demo' },
  user: { username: 'demouser', password: 'demo' },
};

const ROLE_LANDING = { admin: '/admin', reseller: '/reseller', user: '/user', login: '/login' };

/* --------------------------------------------------------------- helpers */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(...a) { console.log(...a); }
function byId(r) { return `${r.role}:${r.id}`; }

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/* --------------------------------------------------------------- CDP glue */
class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.listeners = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} ${JSON.stringify(msg.error.data || '')}`));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        const fns = this.listeners.get(msg.method);
        if (fns) for (const fn of fns) fn(msg.params || {});
      }
    };
    return this;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  waitEvent(method, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting ${method}`)), timeout);
      const fn = (p) => {
        clearTimeout(t);
        const arr = this.listeners.get(method) || [];
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
        resolve(p);
      };
      this.on(method, fn);
    });
  }
}

/* ------------------------------------------------------------- in-page JS */
/* eslint-disable no-undef */
function inPageMetrics() {
  const round = (n) => Math.round(Number(n || 0) * 10) / 10;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const doc = document.documentElement;
  const body = document.body;
  const EXCLUDE = '#sidebar, .sidebar-scrim, #cmdPalette, .toast-stack, .menu-pop, .modal-backdrop';
  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      if (n.id) { s += '#' + n.id; parts.unshift(s); break; }
      const cls = Array.from(n.classList || []).filter((c) => c && !/^(ng|is-)/.test(c)).slice(0, 2);
      if (cls.length) s += '.' + cls.join('.');
      const p = n.parentElement;
      if (p) {
        const sibs = Array.from(p.children).filter((x) => x.tagName === n.tagName);
        if (sibs.length > 1) s += `:nth-of-type(${sibs.indexOf(n) + 1})`;
      }
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const textOf = (el, n = 90) => String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.closest(EXCLUDE) || el.closest('[hidden]')) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0.5 && r.height > 0.5;
  };
  const parseColor = (c) => {
    if (!c) return null;
    let m = c.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      if (p.length >= 3) return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    if (c === 'transparent' || c === 'rgba(0, 0, 0, 0)') return { r: 0, g: 0, b: 0, a: 0 };
    return null;
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const contrast = (a, b) => {
    const l1 = lum(a); const l2 = lum(b);
    return round((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05));
  };
  const all = Array.from(body.querySelectorAll('*'));

  /* horizontal overflow */
  const offenders = [];
  for (const el of all) {
    if (!isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    const overflowPx = Math.max(0, r.right - vw) + Math.max(0, -r.left);
    if (overflowPx > 1) {
      const cs = getComputedStyle(el);
      offenders.push({
        selector: pathOf(el), tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 120),
        text: textOf(el), left: round(r.left), right: round(r.right), width: round(r.width),
        overflowPx: round(overflowPx), position: cs.position, overflowX: cs.overflowX,
      });
    }
  }
  offenders.sort((a, b) => b.overflowPx - a.overflowPx);

  /* clipped by an overflow:hidden ancestor */
  const clipped = [];
  const watch = 'table, pre, .tabs, .toolbar, .page-head, .card-head, .field, input, select, textarea, button, a.btn, h1, h2, .kv, .row, .data-table, .stat-card';
  for (const el of body.querySelectorAll(watch)) {
    if (!isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    for (let a = el.parentElement; a && a !== body; a = a.parentElement) {
      const acs = getComputedStyle(a);
      if (acs.overflowX === 'hidden' || acs.overflowX === 'clip') {
        const ar = a.getBoundingClientRect();
        if (r.right > ar.right + 2 || r.left < ar.left - 2) {
          clipped.push({
            selector: pathOf(el), ancestor: pathOf(a), tag: el.tagName.toLowerCase(),
            text: textOf(el, 70), overRight: round(r.right - ar.right), underLeft: round(ar.left - r.left),
          });
          break;
        }
      }
    }
  }

  /* tables */
  const tables = [];
  for (const t of body.querySelectorAll('table')) {
    if (!isVisible(t)) continue;
    const wrap = t.closest('.table-wrap');
    const tr = t.getBoundingClientRect();
    const wr = wrap ? wrap.getBoundingClientRect() : null;
    tables.push({
      selector: pathOf(t), rows: t.tBodies[0] ? t.tBodies[0].rows.length : 0,
      cols: t.tHead && t.tHead.rows[0] ? t.tHead.rows[0].cells.length : 0,
      width: round(tr.width), wrapperWidth: wr ? round(wr.width) : null,
      wrapperScrollWidth: wrap ? wrap.scrollWidth : null,
      scrollable: wrap ? wrap.scrollWidth > wrap.clientWidth + 1 : false,
      clippedWithoutScroll: wr ? tr.right > wr.right + 2 && !(wrap.scrollWidth > wrap.clientWidth + 1) : tr.right > vw + 1,
      firstHeader: t.tHead && t.tHead.rows[0] ? textOf(t.tHead.rows[0], 120) : '',
    });
  }

  /* tabs */
  const tabBars = [];
  for (const t of body.querySelectorAll('.tabs')) {
    if (!isVisible(t)) continue;
    const r = t.getBoundingClientRect();
    tabBars.push({
      selector: pathOf(t), labels: Array.from(t.querySelectorAll('.tab')).map((x) => textOf(x, 40)),
      width: round(r.width), scrollWidth: t.scrollWidth, clientWidth: t.clientWidth,
      scrollable: t.scrollWidth > t.clientWidth + 1, overflowX: getComputedStyle(t).overflowX,
      right: round(r.right),
    });
  }

  /* inputs / buttons out of parent or viewport */
  const inputOverflow = [];
  for (const el of body.querySelectorAll('input, select, textarea')) {
    if (!isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    const parent = el.closest('.field-control, .field, td, .row, .card-body, form') || el.parentElement;
    const pr = parent ? parent.getBoundingClientRect() : null;
    if (r.right > vw + 1 || (pr && (r.right > pr.right + 2 || r.width > pr.width + 2))) {
      inputOverflow.push({
        selector: pathOf(el), type: el.getAttribute('type') || el.tagName.toLowerCase(),
        name: el.getAttribute('name') || '', width: round(r.width), right: round(r.right),
        parentRight: pr ? round(pr.right) : null, parentWidth: pr ? round(pr.width) : null,
        overflowPx: pr ? round(Math.max(r.right - pr.right, r.width - pr.width)) : round(r.right - vw),
      });
    }
  }

  /* visual overlap of interactive elements */
  const inter = [];
  for (const el of body.querySelectorAll('a[href], button, input, select, textarea, [role="button"]')) {
    if (!isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 5 || r.height < 5) continue;
    inter.push({ el, r, selector: pathOf(el), text: textOf(el, 50) || el.getAttribute('name') || el.getAttribute('type') || '' });
  }
  const overlaps = [];
  for (let i = 0; i < inter.length && overlaps.length < 40; i++) {
    for (let j = i + 1; j < inter.length; j++) {
      const a = inter[i]; const b = inter[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (ix <= 4 || iy <= 4) continue;
      const area = ix * iy;
      const minArea = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
      if (area / minArea < 0.18) continue;
      overlaps.push({
        a: a.selector, b: b.selector, aText: a.text, bText: b.text,
        overlapW: round(ix), overlapH: round(iy), ratio: round(area / minArea),
      });
      if (overlaps.length >= 12) break;
    }
  }

  /* contrast on direct text nodes */
  const lowContrast = [];
  const seen = new Set();
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || node.nodeValue.trim().length < 2) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (!p || !isVisible(p)) return NodeFilter.FILTER_REJECT;
      if (p.closest('script, style, noscript, option')) return NodeFilter.FILTER_REJECT;
      const cs = getComputedStyle(p);
      if (Number(cs.opacity) < 0.05) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  while ((node = walker.nextNode()) && lowContrast.length < 80) {
    const p = node.parentElement;
    const cs = getComputedStyle(p);
    const color = parseColor(cs.color);
    if (!color || color.a < 0.05) continue;
    let bg = null;
    for (let a = p; a; a = a.parentElement) {
      const c = parseColor(getComputedStyle(a).backgroundColor);
      if (c && c.a > 0.05) { bg = c; break; }
    }
    if (!bg) bg = { r: 255, g: 255, b: 255, a: 1 };
    const ratio = contrast(color, bg);
    const fs = parseFloat(cs.fontSize) || 14;
    const fw = parseInt(cs.fontWeight, 10) || 400;
    const large = fs >= 24 || (fs >= 18.66 && fw >= 700);
    const threshold = large ? 3 : 4.5;
    if (ratio < threshold) {
      const key = pathOf(p) + '|' + cs.color + '|' + cs.backgroundColor;
      if (seen.has(key)) continue;
      seen.add(key);
      lowContrast.push({
        selector: pathOf(p), text: String(node.nodeValue).replace(/\s+/g, ' ').trim().slice(0, 70),
        color: cs.color, bg: `rgb(${bg.r}, ${bg.g}, ${bg.b})`, ratio, fontSize: fs, fontWeight: fw, large, threshold,
      });
    }
  }
  lowContrast.sort((a, b) => a.ratio - b.ratio);

  /* raw escaped HTML / visible tags */
  const visibleText = body.innerText || '';
  const rawMatches = [];
  const rawRe = /&lt;\s*\/?\s*(div|span|table|thead|tbody|tr|td|th|form|input|button|select|textarea|script|style|a|p|h[1-6]|strong|em|b|i|small|code|label|option)\b/gi;
  let m;
  while ((m = rawRe.exec(visibleText)) && rawMatches.length < 8) {
    rawMatches.push(visibleText.slice(Math.max(0, m.index - 40), m.index + 90).replace(/\s+/g, ' '));
  }
  const literalTag = [];
  for (const el of body.querySelectorAll('p, td, pre, code, .cell-sub, li, div')) {
    const t = (el.childElementCount === 0 ? el.textContent : '') || '';
    if (/<\s*\/?\s*(div|span|table|form|input|button|a|p|h[1-6]|strong|em|b|i|small|code|label|option)\b[^>]*>/i.test(t)) {
      literalTag.push({ selector: pathOf(el), text: t.replace(/\s+/g, ' ').trim().slice(0, 160) });
      if (literalTag.length >= 8) break;
    }
  }

  /* suspicious text */
  const suspicious = [];
  for (const re of [/\bundefined\b/g, /\bNaN\b/g, /\[object Object\]/g, /&nbsp;/g]) {
    let mm;
    while ((mm = re.exec(visibleText)) && suspicious.length < 10) {
      suspicious.push(visibleText.slice(Math.max(0, mm.index - 50), mm.index + 80).replace(/\s+/g, ' '));
    }
  }

  /* empty cards */
  const emptyCards = [];
  for (const c of body.querySelectorAll('.card')) {
    if (!isVisible(c)) continue;
    const b = c.querySelector('.card-body');
    if (!b) continue;
    const t = (b.innerText || '').trim();
    if (t.length < 2 && !b.querySelector('input,select,textarea,button,table,svg,img')) {
      emptyCards.push({ selector: pathOf(c), title: textOf(c.querySelector('.card-head') || c, 80) });
    }
  }

  /* forms */
  const forms = Array.from(document.forms).map((f) => {
    const inputs = Array.from(f.querySelectorAll('input,select,textarea'));
    const actionAttr = f.getAttribute('action');
    return {
      selector: pathOf(f), action: actionAttr, method: (f.getAttribute('method') || 'get').toLowerCase(),
      csrf: !!f.querySelector('input[name="_csrf"]'), csrfFilled: !!f.querySelector('input[name="_csrf"]')?.value,
      inputs: inputs.length, passwords: f.querySelectorAll('input[type="password"]').length,
      submits: f.querySelectorAll('button[type="submit"],button:not([type]),input[type="submit"]').length,
      emptyAction: actionAttr === null || actionAttr.trim() === '' || actionAttr.trim() === '#',
      confirm: f.hasAttribute('data-confirm'),
      inline: f.classList.contains('inline'),
    };
  });

  /* language mix (main content only) */
  const main = document.querySelector('main') || body;
  const mainText = (main.innerText || '').slice(0, 60000);
  const plLetterMatches = mainText.match(/[ąćęłńóśźż]/gi) || [];
  const plWords = ['Dodaj', 'Usuń', 'Zapisz', 'Ustawienia', 'Brak', 'Wyloguj', 'Pomoc', 'Nazwa', 'Hasło', 'Konto', 'Domena', 'Poczta', 'Kopia', 'Wybierz', 'Anuluj', 'Potwierdź', 'Szukaj', 'Włącz', 'Wyłącz', 'Zarządzaj', 'Edytuj', 'Nowy', 'Nowa', 'Nowe', 'Pakiety', 'Użytkownicy', 'Statystyki', 'Serwer', 'Użytkownik', 'Dostęp', 'Wartość', 'Cena', 'Opis', 'Utwórz', 'Zmień', 'Przejdź', 'Zastosuj', 'Odśwież', 'Ostatni', 'Zakres', 'Lokalizacja', 'Harmonogram', 'Zaplecze', 'Bezpieczeństwo'];
  const enWords = ['Dashboard', 'Management', 'Settings', 'Users', 'User', 'Packages', 'Domains', 'Email', 'Files', 'Backups', 'Add', 'Create', 'Delete', 'Save', 'Cancel', 'Search', 'Actions', 'Status', 'Name', 'Date', 'Owner', 'Overview', 'Tools', 'Server', 'Account', 'Password', 'Logout', 'Welcome', 'Enabled', 'Disabled', 'Never', 'Always', 'Configure', 'Install', 'Update', 'View', 'Edit', 'Close', 'Open', 'Help', 'Documentation', 'Free', 'Active', 'Suspended', 'Complete', 'Failed', 'Pending', 'Warning', 'Running', 'Stopped', 'None', 'Unlimited', 'Loading', 'No', 'Yes', 'Total', 'Used', 'This', 'All', 'New'];
  const countWords = (list) => list.reduce((acc, w) => acc + (new RegExp(`(^|[^A-Za-z])${w}([^A-Za-z]|$)`, 'g').test(mainText) ? 1 : 0), 0);
  const labels = Array.from(main.querySelectorAll('h1, h2, h3, th, button, label, .tab, .btn, .nav-group-title')).map((e) => textOf(e, 50)).filter(Boolean);
  const uniqueLabels = [...new Set(labels)].slice(0, 60);
  const plCount = plWords.reduce((acc, w) => acc + ((mainText.match(new RegExp(`\\b${w}\\b`, 'g')) || []).length), 0);
  const enCount = enWords.reduce((acc, w) => acc + ((mainText.match(new RegExp(`\\b${w}\\b`, 'g')) || []).length), 0);

  /* auto refresh / feedback cues */
  const metaRefresh = document.querySelector('meta[http-equiv="refresh"]')?.getAttribute('content') || null;
  const refreshCue = Array.from(document.querySelectorAll('a, button')).some((el) => /odśwież|refresh|auto.?refresh|live/i.test(textOf(el, 60)));
  const lastUpdated = /(last updated|ostatnia aktualizacja|as of|data odświeżenia)/i.test(mainText);
  const polling = Array.from(document.scripts).filter((s) => !s.src).some((s) => /setInterval\s*\(|fetch\s*\(/.test(s.textContent || ''));

  /* empty selects (visible controls with no real options) */
  const emptySelects = [];
  for (const select of body.querySelectorAll('select')) {
    if (!isVisible(select)) continue;
    const opts = Array.from(select.options || []);
    const real = opts.filter((o) => String(o.value) !== '');
    if (!opts.length || (real.length === 0 && !opts.some((o) => o.textContent.trim()))) {
      emptySelects.push({ selector: pathOf(select), name: select.getAttribute('name') || '', options: opts.length });
    }
  }

  /* images */
  const brokenImages = Array.from(document.images)
    .filter((i) => !i.complete || i.naturalWidth === 0)
    .map((i) => ({ src: i.getAttribute('src'), alt: i.getAttribute('alt'), selector: pathOf(i) }));

  /* links sample for dead-link checking */
  const links = [];
  const seenLinks = new Set();
  for (const a of body.querySelectorAll('a[href]')) {
    if (!isVisible(a)) continue;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue;
    let u;
    try { u = new URL(href, location.href); } catch { continue; }
    if (u.origin !== location.origin) continue;
    const key = u.pathname + u.search;
    if (seenLinks.has(key)) continue;
    seenLinks.add(key);
    links.push({ href: key, text: textOf(a, 50) });
    if (links.length >= 80) break;
  }

  /* h1 */
  const h1s = Array.from(main.querySelectorAll('h1')).map((h) => textOf(h, 120));
  const cards = Array.from(body.querySelectorAll('.card')).filter(isVisible);
  const emptyStateCount = Array.from(body.querySelectorAll('.empty')).filter(isVisible).length;

  return {
    viewport: { width: vw, height: vh },
    title: document.title,
    lang: document.documentElement.lang,
    skin: document.documentElement.dataset.skin || '',
    h1: h1s[0] || '',
    h1Count: h1s.length,
    textLength: (main.innerText || '').trim().length,
    cards: cards.length,
    tables: tables.length,
    emptyStates: emptyStateCount,
    buttons: Array.from(body.querySelectorAll('button, a.btn')).filter(isVisible).length,
    scrollWidth: doc.scrollWidth,
    bodyScrollWidth: body.scrollWidth,
    innerWidth: vw,
    scrollHeight: doc.scrollHeight,
    hasHorizontalOverflow: doc.scrollWidth > vw + 1,
    horizontalOverflowPx: round(doc.scrollWidth - vw),
    overflowOffenders: offenders.slice(0, 20),
    clipped,
    tables,
    tabBars,
    inputOverflow,
    overlaps,
    lowContrast: lowContrast.slice(0, 20),
    contrastChecked: seen.size,
    rawEscapedHtml: { count: rawMatches.length, samples: rawMatches, literalTags: literalTag },
    suspicious,
    emptyCards,
    forms,
    language: {
      plLetters: plLetterMatches.length, plWords: plCount, enWords: enCount,
      plLexemes: countWords(plWords), enLexemes: countWords(enWords), labels: uniqueLabels,
    },
    feedback: { metaRefresh, refreshCue, lastUpdated, polling, spinners: Array.from(body.querySelectorAll('.spinner,.loading,.skeleton,[aria-busy="true"]')).filter(isVisible).length },
    brokenImages,
    emptySelects,
    links,
    navActive: Array.from(body.querySelectorAll('.nav-item.active')).length,
    navTotal: Array.from(body.querySelectorAll('.nav-item')).length,
    sidebar: (() => {
      const s = document.querySelector('[data-sidebar]');
      if (!s) return null;
      const r = s.getBoundingClientRect();
      return { left: round(r.left), right: round(r.right), width: round(r.width), visible: r.left < vw && r.right > 0, classOpen: document.body.classList.contains('sidebar-open') };
    })(),
    topbar: (() => {
      const t = document.querySelector('.topbar');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      const br = document.querySelector('.breadcrumbs');
      const bcs = br ? getComputedStyle(br) : null;
      return {
        rect: { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) },
        scrollWidth: t.scrollWidth, clientWidth: t.clientWidth,
        overflow: t.scrollWidth > t.clientWidth + 1,
        position: getComputedStyle(t).position,
        breadcrumbListStyle: bcs ? bcs.listStyleType : null,
        breadcrumbItems: br ? br.querySelectorAll('li').length : 0,
        breadcrumbText: br ? String(br.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120) : '',
      };
    })(),
  };
}

/* ------------------------------------------------------------ credentials */
async function login(role) {
  if (role === 'login') return { cookie: null, status: 'public' };
  const acc = ACCOUNTS[role];
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: acc.username, password: acc.password, redirect: '' }).toString(),
    redirect: 'manual',
  });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  const raw = setCookies.join(';');
  const match = raw.match(/OA_SESSION=([^;]+)/);
  if (!match) throw new Error(`Login failed for ${role}: HTTP ${res.status}, no OA_SESSION in ${raw.slice(0, 200)}`);
  return { cookie: `OA_SESSION=${match[1]}`, status: res.status };
}

/* --------------------------------------------------------------- screenshot */
async function capturePng(cdp, sessionId, clip, beyond = true) {
  const params = { format: 'png', fromSurface: true, captureBeyondViewport: beyond };
  if (clip) params.clip = clip;
  const { data } = await cdp.send('Page.captureScreenshot', params, sessionId);
  return Buffer.from(data, 'base64');
}

/* --------------------------------------------------------------- HTML scan */
function scanHtml(role, cookie, route) {
  return fetch(`${BASE}${route.path}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' })
    .then(async (res) => {
      const html = await res.text();
      const forms = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map((m) => {
        const attrs = m[1]; const inner = m[2];
        const method = (/method="([^"]*)"/i.exec(attrs)?.[1] || 'get').toLowerCase();
        const action = /action="([^"]*)"/i.exec(attrs)?.[1] ?? null;
        const csrf = /name="_csrf"/i.test(inner);
        const buttons = (inner.match(/<button\b/gi) || []).length;
        const submitButtons = (inner.match(/<button[^>]*type="submit"/gi) || []).length + (inner.match(/<button(?![^>]*type=)[^>]*>/gi) || []).length;
        const label = (/<button\b[^>]*>([\s\S]*?)<\/button>/i.exec(inner)?.[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
        return { method, action, csrf, buttons, submitButtons, label };
      });
      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
      const duplicateIds = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
      return {
        role, id: route.id, path: route.path, status: res.status, bytes: html.length,
        title: (/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').trim(),
        forms,
        postWithoutCsrf: forms.filter((f) => f.method === 'post' && !f.csrf),
        postWithoutAction: forms.filter((f) => f.method === 'post' && (!f.action || f.action.trim() === '#' || f.action.includes('undefined'))),
        duplicateIds,
        escapedEntities: (html.match(/&lt;\s*\/?\s*(div|span|table|tr|td|form|input|button|a|p|h[1-6])\b/gi) || []).length,
        doubleEscaped: (html.match(/&amp;lt;/g) || []).length,
        hasCsrfMeta: /name="csrf-token"/.test(html),
      };
    })
    .catch((e) => ({ role, id: route.id, path: route.path, error: e.message }));
}

/* --------------------------------------------------------------- main */
const summary = {
  base: BASE, startedAt: new Date().toISOString(), chrome: CHROME,
  routes: routes.map((r) => ({ role: r.role, id: r.id, path: r.path, label: r.label, widths: r.widths })),
  pages: [], htmlScans: [], deadLinks: [], login: {}, errors: [],
};

const port = await freePort();
const profile = path.join(OUT, 'chrome-profile');
const chromeLog = fs.openSync(path.join(OUT, 'logs', 'chrome.log'), 'w');
const chromeProc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions',
  '--metrics-recording-only', '--mute-audio', '--force-device-scale-factor=1',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1440,1000', 'about:blank',
], { stdio: ['ignore', chromeLog, chromeLog] });

let cdp;
let sessionId;
let browserVersion = null;
try {
  let version;
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) { version = await res.json(); break; }
    } catch { /* retry */ }
    await sleep(150);
  }
  if (!version) throw new Error('Chrome did not expose CDP');
  browserVersion = version.Browser;
  cdp = await new CDP(version.webSocketDebuggerUrl).connect();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  sessionId = attached.sessionId;
  const s = (m, p) => cdp.send(m, p, sessionId);
  await s('Page.enable');
  await s('Runtime.enable');
  await s('Log.enable');
  await s('Network.enable');
  await s('Network.setCacheDisabled', { cacheDisabled: true });
  await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await s('Runtime.setAsyncCallStackDepth', { maxDepth: 0 });

  /* per-page event buffers */
  let consoleEvents = [];
  let failedRequests = [];
  let documentStatus = null;
  const requestMap = new Map();
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error' || p.type === 'warning' || p.type === 'assert') {
      const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 500);
      consoleEvents.push({ kind: 'console', level: p.type, text, url: p.stackTrace?.callFrames?.[0]?.url, line: p.stackTrace?.callFrames?.[0]?.lineNumber });
    }
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    consoleEvents.push({ kind: 'exception', level: 'error', text: String(d.exception?.description || d.text || 'exception').slice(0, 800), url: d.url, line: d.lineNumber });
  });
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry && (p.entry.level === 'error' || p.entry.level === 'warning')) {
      consoleEvents.push({ kind: 'log', level: p.entry.level, text: String(p.entry.text || '').slice(0, 500), url: p.entry.url, line: p.entry.lineNumber });
    }
  });
  cdp.on('Network.requestWillBeSent', (p) => {
    requestMap.set(p.requestId, { url: p.request?.url, type: p.type, method: p.request?.method });
  });
  cdp.on('Network.responseReceived', (p) => {
    const req = requestMap.get(p.requestId) || {};
    const status = p.response?.status;
    if (p.type === 'Document' && !documentStatus) documentStatus = { status, url: p.response?.url };
    if (status >= 400) {
      failedRequests.push({ url: p.response?.url, status, type: p.type, method: req.method || '' });
    }
  });
  cdp.on('Network.loadingFailed', (p) => {
    const req = requestMap.get(p.requestId) || {};
    if (p.canceled) return;
    const url = req.url || '';
    if (/devtools|favicon|\.well-known\/appspecific/.test(url)) return;
    failedRequests.push({ url, status: null, type: p.type || req.type, error: p.errorText || 'loadingFailed' });
  });

  /* log in each role */
  const cookies = {};
  for (const role of ['admin', 'reseller', 'user']) {
    cookies[role] = await login(role);
    summary.login[role] = { status: cookies[role].status, cookie: cookies[role].cookie ? 'present' : 'missing' };
    log(`login ${role}: ${cookies[role].status} cookie=${cookies[role].cookie ? 'ok' : 'BROKEN'}`);
  }

  /* crawl */
  let n = 0;
  for (const route of routes) {
    for (const width of route.widths) {
      n++;
      const vp = VIEWPORTS[width];
      const creds = cookies[route.role];
      const shots = {};
      const pageRecord = {
        role: route.role, id: route.id, label: route.label, path: route.path, width,
        startedAt: new Date().toISOString(),
      };
      const s = (m, p) => cdp.send(m, p, sessionId);
      try {
        consoleEvents = []; failedRequests = []; documentStatus = null; requestMap.clear();
        await s('Emulation.setDeviceMetricsOverride', {
          width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false,
          screenWidth: vp.width, screenHeight: vp.height,
        });
        if (creds?.cookie) {
          await s('Network.setCookie', {
            name: 'OA_SESSION', value: creds.cookie.split('=')[1], url: BASE + '/',
            path: '/', httpOnly: true, sameSite: 'Lax',
          });
          await s('Network.setExtraHTTPHeaders', { headers: { cookie: creds.cookie } });
        } else {
          await s('Network.setExtraHTTPHeaders', { headers: {} });
        }
        const load = cdp.waitEvent('Page.loadEventFired', 25000).catch(() => null);
        const nav = await s('Page.navigate', { url: BASE + route.path });
        await load;
        try {
          await s('Runtime.evaluate', { expression: 'document.fonts && document.fonts.ready', awaitPromise: true });
        } catch { /* ignore */ }
        await sleep(650);
        const evalRes = await s('Runtime.evaluate', {
          expression: `(${inPageMetrics.toString()})()`, returnByValue: true, awaitPromise: true,
        });
        if (evalRes.exceptionDetails) throw new Error(`in-page metrics failed: ${evalRes.exceptionDetails.text}`);
        const metrics = evalRes.result.value;
        pageRecord.metrics = metrics;
        pageRecord.httpStatus = documentStatus?.status ?? null;
        pageRecord.finalUrl = documentStatus?.url || null;
        pageRecord.navigated = nav;
        pageRecord.url = BASE + route.path;
        pageRecord.console = consoleEvents.slice(0, 25);
        pageRecord.failedRequests = failedRequests.slice(0, 25);
        pageRecord.ok = (documentStatus?.status ?? 0) < 400 && consoleEvents.filter((e) => e.kind === 'exception').length === 0;

        /* full page screenshot */
        const layout = await s('Page.getLayoutMetrics');
        const content = layout.cssContentSize || layout.contentSize;
        const fullW = vp.width; // viewport width: overflow must stay visible, not be widened away
        const fullH = Math.ceil(content.height);
        const MAX_H = 20000;
        const clipH = Math.min(fullH, MAX_H);
        const fullFile = path.join(SHOTS, `${route.role}__${route.id}__${width}__full.png`);
        try {
          const buf = await capturePng(cdp, sessionId, { x: 0, y: 0, width: fullW, height: clipH, scale: 1 });
          fs.writeFileSync(fullFile, buf);
          shots.full = fullFile;
          pageRecord.fullPage = { width: fullW, height: fullH, capturedHeight: clipH, truncated: fullH > MAX_H, bytes: buf.length };
        } catch (e) {
          pageRecord.screenshotError = e.message;
        }

        /* viewport (top) screenshot */
        await s('Runtime.evaluate', { expression: 'window.scrollTo(0,0)' });
        await sleep(80);
        const topFile = path.join(SHOTS, `${route.role}__${route.id}__${width}__top.png`);
        try {
          const buf = await capturePng(cdp, sessionId, null, false);
          fs.writeFileSync(topFile, buf);
          shots.top = topFile;
        } catch { /* ignore */ }

        /* mobile sidebar interaction on the three dashboards */
        const dashboards = new Set(['/admin', '/reseller', '/user']);
        if (width === 390 && dashboards.has(route.path)) {
          try {
            await s('Runtime.evaluate', {
              expression: `(() => { const b=document.querySelector('[data-sidebar-open]'); if(b){b.click(); return true;} return false; })()`,
              returnByValue: true,
            });
            await sleep(400);
            const openMetrics = await s('Runtime.evaluate', { expression: `(${inPageMetrics.toString()})()`, returnByValue: true });
            pageRecord.metricsSidebarOpen = openMetrics.result.value;
            const sideFile = path.join(SHOTS, `${route.role}__sidebar-open__${width}.png`);
            const buf = await capturePng(cdp, sessionId, null, false);
            fs.writeFileSync(sideFile, buf);
            shots.sidebarOpen = sideFile;
            await s('Runtime.evaluate', { expression: `document.querySelector('[data-sidebar-close]')?.click()` });
            await sleep(120);
          } catch (e) { pageRecord.sidebarError = e.message; }
        }

        pageRecord.screenshots = shots;
        log(`[${n}/${routes.reduce((a, r) => a + r.widths.length, 0)}] ${route.role}/${route.id} @${width} status=${pageRecord.httpStatus} h=${vp.height} full=${pageRecord.fullPage?.height || '?'} ov=${metrics.hasHorizontalOverflow ? metrics.horizontalOverflowPx : 0} err=${pageRecord.console.length} net=${pageRecord.failedRequests.length}`);
      } catch (e) {
        pageRecord.error = e.message;
        summary.errors.push({ route: byId(route), width, error: e.message });
        log(`FAIL ${route.role}/${route.id} @${width}: ${e.message}`);
      }
      summary.pages.push(pageRecord);
      fs.writeFileSync(path.join(OUT, 'raw.json'), JSON.stringify(summary, null, 2));
    }
  }

  /* server-side HTML scan (forms/CSRF/escaping) */
  if (!SKIP_HTML_SCAN) {
    log('scanning raw HTML for forms/CSRF/duplicate ids…');
    const seen = new Set();
    for (const route of routes) {
      const key = route.role + '|' + route.path;
      if (seen.has(key)) continue;
      seen.add(key);
      const creds = cookies[route.role];
      const scan = await scanHtml(route.role, creds?.cookie, route);
      summary.htmlScans.push(scan);
    }
  }

  /* dead-link sample from collected anchors */
  if (!flag('skip-links')) {
    log('checking sampled page links…');
    const links = new Map();
    for (const p of summary.pages) {
      for (const l of (p.metrics?.links || [])) {
        if (!links.has(l.href)) links.set(l.href, { href: l.href, roles: new Set(), pages: new Set() });
        const rec = links.get(l.href);
        rec.roles.add(p.role); rec.pages.add(`${p.role}:${p.id}@${p.width}`);
      }
    }
    const skip = /logout|switch-level|phpmyadmin|roundcube|webmail|download|delete|remove|uninstall|install\?|action=|backup-now|create-backup|test\?|refresh\?|clear|kill|sync|toggle|rebuild|deploy|collect|enforce/i;
    const candidates = [...links.values()].filter((l) => !skip.test(l.href)).slice(0, 160);
    let done = 0;
    async function worker() {
      while (done < candidates.length) {
        const l = candidates[done++];
        const role = [...l.roles][0];
        const creds = cookies[role];
        try {
          const res = await fetch(BASE + l.href, { headers: creds?.cookie ? { cookie: creds.cookie } : {}, redirect: 'follow' });
          const text = await res.text();
          summary.deadLinks.push({
            href: l.href, status: res.status, bytes: text.length, roles: [...l.roles],
            pages: [...l.pages].slice(0, 6),
            finalUrl: res.url.replace(BASE, ''),
          });
        } catch (e) {
          summary.deadLinks.push({ href: l.href, status: 0, error: e.message, roles: [...l.roles] });
        }
      }
    }
    await Promise.all(Array.from({ length: 5 }, worker));
  }
} catch (e) {
  summary.errors.push({ fatal: e.message, stack: (e.stack || '').split('\n').slice(0, 8) });
  log('FATAL', e.message);
} finally {
  try { await cdp?.send('Browser.close'); } catch { /* ignore */ }
  try { chromeProc.kill('SIGTERM'); } catch { /* ignore */ }
  await sleep(500);
  try { fs.closeSync(chromeLog); } catch { /* ignore */ }
  summary.finishedAt = new Date().toISOString();
  summary.browserVersion = browserVersion;
  fs.writeFileSync(path.join(OUT, 'raw.json'), JSON.stringify(summary, null, 2));
  log(`done -> ${path.join(OUT, 'raw.json')}`);
  process.exit(0);
}
