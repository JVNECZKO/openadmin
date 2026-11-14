#!/usr/bin/env node
/*
 * tools/qa-final.mjs — reproducible final QA audit for OpenAdmin.
 *
 * Read-only with respect to src/. By default it boots its own isolated demo
 * server (OA_DEMO=1, fresh data dir, free port), logs in as admin/reseller/user
 * through the real login form, walks the navigation at 390/768/1280/1920,
 * records console errors, failed requests, overflow, duplicate ids, missing
 * labels, forbidden texts, app-catalogue states, role/impersonation context and
 * dashboard-vs-DB counts. It also runs negative security checks (P0/P1) over
 * HTTP and at module level, and uses a locally installed axe-core if present.
 *
 * Usage:
 *   node tools/qa-final.mjs                         # isolated demo + full audit
 *   node tools/qa-final.mjs --out /tmp/qa-final     # custom output directory
 *   node tools/qa-final.mjs --base http://127.0.0.1:2222 --admin-pass PASS
 *   node tools/qa-final.mjs --skip-security --widths 390,1280
 *
 * Nothing in src/ is modified. All mutations happen in the isolated data dir
 * created under <out>/data (users, a backup job, API/login keys, test files).
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(arg('out', path.join('/tmp', `openadmin-qa-final-${STAMP}`)));
const SHOTS = path.join(OUT, 'shots');
const CHROME = arg('chrome', process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const EXTERNAL_BASE = arg('base', '');
const WIDTHS = (arg('widths', '390,768,1280,1920').split(',')).map(Number).filter((n) => n >= 320);
const WALK_WIDTHS = [1280, 390];
const ADMIN_USER = arg('admin-user', 'admin');
const ADMIN_PASS = arg('admin-pass', 'QaAdminPass!2026');
const DEMO_PASS = 'demo';
const MAX_UPLOAD_MB = Number(arg('max-upload-mb', '16'));
const SKIP_SECURITY = flag('skip-security');
const SKIP_VISUAL = flag('skip-visual');
const CSP_SMOKE = flag('csp-smoke');
const HEADLESS = !flag('show');
const AXE_CANDIDATES = [
  process.env.AXE_PATH,
  '/Users/lukasz/Desktop/Rebrand_v2/node_modules/axe-core/axe.min.js',
  '/Users/lukasz/Desktop/Rebrand/node_modules/axe-core/axe.min.js',
  path.join(ROOT, 'node_modules', 'axe-core', 'axe.min.js'),
].filter(Boolean);

for (const dir of [OUT, SHOTS, path.join(OUT, 'logs'), path.join(OUT, 'console')]) fs.mkdirSync(dir, { recursive: true });
const UNIT_DATA = path.join(OUT, 'unit-data');
fs.mkdirSync(UNIT_DATA, { recursive: true, mode: 0o700 });
// Module-level security checks import src/db.mjs in this process; point it at a
// throwaway database so the isolated demo server database is never touched.
process.env.OA_DATA_DIR = UNIT_DATA;

const startedAt = Date.now();
const results = {
  meta: {
    product: 'OpenAdmin', version: '1.0.0', generatedAt: new Date().toISOString(),
    base: null, isolated: !EXTERNAL_BASE, root: ROOT, widths: WIDTHS, node: process.version,
    chrome: CHROME, axe: null, dataDir: null, durationMs: 0,
  },
  checks: [],
  routes: [],
  security: [],
  axe: [],
  counts: [],
  screenshots: {},
  artifacts: {},
  summary: {},
};

function record(area, id, status, detail, evidence = null) {
  const item = { area, id, status, detail, ...(evidence ? { evidence } : {}) };
  results.checks.push(item);
  const icon = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : status === 'warn' ? 'WARN' : 'SKIP';
  console.log(`[${icon}] ${area}/${id}: ${detail}`);
  return item;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = (v) => String(v).replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 90) || 'page';
const fileUrl = (p) => pathToFileURL(p).href;

/* ------------------------------------------------------------------ server */
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

let serverChild = null;
let base = EXTERNAL_BASE.replace(/\/$/, '');
let dataDir = null;
let adminPass = ADMIN_PASS;

async function waitFor(url, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status < 500) return res;
      last = new Error(`HTTP ${res.status}`);
    } catch (e) { last = e; }
    await sleep(200);
  }
  throw last || new Error(`timeout waiting for ${url}`);
}

async function startServer() {
  dataDir = path.join(OUT, 'data');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const port = await freePort();
  const imapPort = await freePort();
  base = `http://127.0.0.1:${port}`;
  results.meta.base = base;
  results.meta.dataDir = dataDir;
  const logFd = fs.openSync(path.join(OUT, 'logs', 'server.log'), 'a');
  const env = {
    ...process.env,
    OA_DEMO: '1',
    OA_DATA_DIR: dataDir,
    OA_PORT: String(port),
    OA_HOST: '127.0.0.1',
    OA_ADMIN_USER: ADMIN_USER,
    OA_ADMIN_PASSWORD: adminPass,
    OA_SERVER_NAME: 'panel.qa.local',
    OA_MAX_UPLOAD_MB: String(MAX_UPLOAD_MB),
    OA_IMAP_PORT: String(imapPort),
    OA_SESSION_TTL: '24',
  };
  // X-Forwarded-For must be ignored unless a trusted proxy is configured; the
  // audit deliberately starts without OA_TRUSTED_PROXIES.
  delete env.OA_TRUSTED_PROXIES;
  delete env.OA_UPDATE_ALLOW_UNSIGNED;
  serverChild = spawn(process.execPath, ['src/server.mjs'], { cwd: ROOT, env, stdio: ['ignore', logFd, logFd] });
  serverChild.on('exit', (code, signal) => {
    fs.writeFileSync(path.join(OUT, 'logs', 'server-exit.json'), JSON.stringify({ code, signal, at: new Date().toISOString() }));
  });
  await waitFor(`${base}/login`);
  record('env', 'isolated-server', 'pass', `demo server on ${base} with fresh data dir`, { dataDir, pid: serverChild.pid, maxUploadMb: MAX_UPLOAD_MB });
}

function stopServer() {
  if (!serverChild) return;
  try { serverChild.kill('SIGTERM'); } catch { /* ignore */ }
  setTimeout(() => { try { serverChild.kill('SIGKILL'); } catch { /* ignore */ } }, 1500).unref();
}

/* ------------------------------------------------------------------ http */
class Http {
  constructor(baseUrl) { this.base = baseUrl; this.cookies = new Map(); }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  absorb(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
    for (const raw of list.filter(Boolean)) {
      const [pair, ...attrs] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (!value || attrs.some((a) => /max-age=0($|;)/i.test(a.trim()))) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  async req(pathname, { method = 'GET', form = null, body = null, headers = {}, redirect = 'manual' } = {}) {
    const h = { ...headers };
    if (this.cookies.size) h.Cookie = this.header();
    let payload;
    if (form) {
      h['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(form).toString();
    } else if (body !== null && body !== undefined) {
      h['Content-Type'] = h['Content-Type'] || 'application/json';
      payload = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetch(this.base + pathname, { method, headers: h, body: payload, redirect });
    this.absorb(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return {
      status: res.status, headers: res.headers, text, json,
      location: res.headers.get('location') || '',
      setCookies: typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [],
    };
  }
  async getCsrf(pathname = '/') {
    const page = await this.req(pathname);
    const m = /name="_csrf"\s+value="([^"]+)"/.exec(page.text)
      || /name="csrf-token"\s+content="([^"]+)"/.exec(page.text);
    return m ? m[1] : '';
  }
}

async function login(username, password = DEMO_PASS, extraHeaders = {}) {
  const session = new Http(base);
  const res = await session.req('/login', { method: 'POST', form: { username, password }, headers: extraHeaders });
  if (res.status !== 302 || !session.cookies.has('OA_SESSION')) {
    throw new Error(`login ${username} failed: HTTP ${res.status} ${res.location || ''}`);
  }
  return { session, res };
}

function basic(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

async function api(user, pass, pathname, { method = 'GET', body = null, headers = {} } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: { Authorization: basic(user, pass), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* legacy form */ }
  return { status: res.status, text, json, headers: res.headers };
}

async function mcp(secret, method, params = {}) {
  const res = await fetch(base + '/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(Object.keys(params).length ? { params } : {}) }),
  });
  const json = await res.json().catch(() => null);
  const text = json?.result?.content?.[0]?.text ?? '';
  let value = null;
  try { value = JSON.parse(text); } catch { /* error text */ }
  return { status: res.status, json, text, value, isError: json?.result?.isError === true };
}

async function mcpCall(secret, name, args = {}) {
  return mcp(secret, 'tools/call', { name, arguments: args });
}

/* --------------------------------------------------------------- database */
const dbPath = () => (dataDir ? path.join(dataDir, 'openadmin.db') : null);
function dbGet(sql) {
  const file = dbPath();
  if (!file || !fs.existsSync(file) || !spawnSync('sqlite3', ['--version']).stdout) return null;
  const r = spawnSync('sqlite3', ['-readonly', file, sql], { encoding: 'utf8' });
  if (r.status !== 0) return { error: (r.stderr || '').trim() };
  return { rows: (r.stdout || '').trim().split('\n').filter(Boolean).map((line) => (line.includes('|') ? line.split('|') : [line])), raw: (r.stdout || '').trim() };
}
function dbExec(sql) {
  const file = dbPath();
  if (!file || !fs.existsSync(file)) return false;
  const r = spawnSync('sqlite3', [file, sql], { encoding: 'utf8' });
  return r.status === 0;
}

/* ---------------------------------------------------------------- chrome */
class Browser {
  constructor() { this.chrome = null; this.ws = null; this.msgId = 0; this.pending = new Map(); this.handlers = []; this.sessionId = null; }

  async launch() {
    if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`);
    const port = await freePort();
    const profile = path.join(OUT, 'chrome-profile');
    fs.rmSync(profile, { recursive: true, force: true });
    const logFd = fs.openSync(path.join(OUT, 'logs', 'chrome.log'), 'a');
    this.chrome = spawn(CHROME, [
      ...(HEADLESS ? ['--headless=new'] : []),
      '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-component-update', '--disable-sync',
      '--metrics-recording-only', '--mute-audio', '--no-sandbox',
      `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1920,1080', 'about:blank',
    ], { stdio: ['ignore', logFd, logFd] });
    let version = null;
    for (let i = 0; i < 80; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (res.ok) { version = await res.json(); break; }
      } catch { /* retry */ }
      await sleep(150);
    }
    if (!version) throw new Error('Chrome DevTools endpoint did not start');
    this.ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
        return;
      }
      if (msg.method) for (const handler of this.handlers) handler(msg.method, msg.params || {}, msg.sessionId);
    };
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const attached = await this.send('Target.attachToTarget', { targetId, flatten: true });
    this.sessionId = attached.sessionId;
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Network.enable');
    await this.send('Log.enable');
    await this.send('Network.setCacheDisabled', { cacheDisabled: true });
    const tree = await this.send('Page.getFrameTree');
    this.mainFrameId = tree.frameTree.frame.id;
    this.targetId = targetId;
    return this;
  }

  send(method, params = {}, sessionId = this.sessionId) {
    const id = ++this.msgId;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(handler) { this.handlers.push(handler); }

  async evaluate(expression) {
    const out = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || out.exceptionDetails.exception?.description || 'evaluate failed');
    return out.result?.value;
  }

  async viewport(width, height = 900) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: width < 600, screenWidth: width, screenHeight: height,
    });
  }

  async emulateLight() {
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  }

  async addInitScript(source) {
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  async setCookies(cookies) {
    await this.send('Network.clearBrowserCookies');
    for (const [name, value] of cookies) {
      await this.send('Network.setCookie', { name, value, url: `${base}/`, path: '/', httpOnly: true, sameSite: 'Lax' });
    }
  }

  async navigate(url, width, collectors) {
    await this.viewport(width);
    if (collectors) collectors.reset();
    await this.send('Page.navigate', { url });
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      try {
        const ready = await this.evaluate('document.readyState');
        if (ready === 'complete') break;
      } catch { /* context swap */ }
      await sleep(80);
    }
    await sleep(220);
    return collectors ? collectors.snapshot() : null;
  }

  async screenshot(name) {
    const metrics = await this.send('Page.getLayoutMetrics');
    const cs = metrics.cssContentSize || metrics.contentSize || { width: 1280, height: 900 };
    const clip = { x: 0, y: 0, width: Math.min(Math.max(cs.width, 320), 2000), height: Math.min(Math.max(cs.height, 400), 9000), scale: 1 };
    const shot = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
    const file = path.join(SHOTS, `${slug(name)}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    results.screenshots[name] = path.relative(OUT, file);
    return file;
  }

  async close() {
    try { this.ws?.close(); } catch { /* ignore */ }
    try { this.chrome?.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

class Collectors {
  constructor(browser) {
    this.browser = browser;
    this.consoleErrors = [];
    this.failedRequests = [];
    this.mainStatus = null;
    this.mainUrl = null;
    browser.on((method, params) => {
      if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
        const text = (params.args || []).map((a) => a.value ?? a.description ?? a.type ?? '').filter(Boolean).join(' ');
        if (text) this.consoleErrors.push(text.slice(0, 500));
      } else if (method === 'Runtime.exceptionThrown') {
        const d = params.exceptionDetails || {};
        const text = d.exception?.description || d.text || 'exception';
        this.consoleErrors.push(String(text).split('\n')[0].slice(0, 500));
      } else if (method === 'Log.entryAdded') {
        const e = params.entry || {};
        if (e.level === 'error' && e.source !== 'network') this.consoleErrors.push(String(e.text || '').slice(0, 500));
      } else if (method === 'Network.responseReceived') {
        const r = params.response || {};
        if (params.type === 'Document' && params.frameId === this.browser.mainFrameId) {
          this.mainStatus = r.status;
          this.mainUrl = r.url;
        }
        if (r.status >= 400 && !String(r.url).startsWith('data:')) {
          this.failedRequests.push({ status: r.status, url: String(r.url).slice(0, 300), type: params.type });
        }
      } else if (method === 'Network.loadingFailed') {
        if (!/ERR_ABORTED/.test(params.errorText || '')) {
          this.failedRequests.push({ status: 0, url: String(params.requestId).slice(0, 40), type: 'loadingFailed', error: params.errorText });
        }
      }
    });
  }
  reset() { this.consoleErrors = []; this.failedRequests = []; this.mainStatus = null; this.mainUrl = null; }
  snapshot() {
    const uniq = (list, key) => [...new Map(list.map((item) => [key(item), item])).values()];
    return {
      status: this.mainStatus, finalUrl: this.mainUrl,
      consoleErrors: [...new Set(this.consoleErrors)].slice(0, 20),
      failedRequests: uniq(this.failedRequests, (r) => `${r.status}:${r.url}`).slice(0, 30),
    };
  }
}

/* ------------------------------------------------------------ page checks */
const PAGE_CHECK_SOURCE = String.raw`(() => {
  const hidden = (el) => {
    if (!el || !el.isConnected) return true;
    const s = getComputedStyle(el);
    return s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0 || el.getClientRects().length === 0;
  };
  const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const labelText = (el) => clean(el.textContent);
  const isControl = (el) => {
    const tag = el.tagName.toLowerCase();
    if (!['input', 'select', 'textarea'].includes(tag)) return false;
    if (tag === 'input') return !['hidden', 'submit', 'button', 'reset', 'image'].includes((el.type || '').toLowerCase());
    return true;
  };
  const controls = [...document.querySelectorAll('input,select,textarea')].filter((el) => isControl(el) && !hidden(el));
  const nameInfo = (el) => {
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return { name: aria, how: 'aria-label' };
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const text = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
      if (clean(text)) return { name: clean(text), how: 'aria-labelledby' };
    }
    if (el.id) {
      const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab) return { name: labelText(lab), how: 'label[for]' };
    }
    const wrap = el.closest('label');
    if (wrap) return { name: labelText(wrap), how: 'wrapping-label' };
    if (el.getAttribute('title')) return { name: clean(el.getAttribute('title')), how: 'title-only', weak: true };
    if (el.getAttribute('placeholder')) return { name: clean(el.getAttribute('placeholder')), how: 'placeholder-only', weak: true };
    return { name: '', how: 'none', weak: true };
  };
  const missingLabels = controls.map((el) => {
    const info = nameInfo(el);
    return {
      accessibleName: info.name || '', how: info.how, weak: !!info.weak || !info.name,
      tag: el.tagName.toLowerCase(), type: el.type || '', id: el.id || '',
      field: el.getAttribute('name') || '',
    };
  }).filter((x) => !x.accessibleName || x.weak);
  const missingByGroup = {};
  for (const m of missingLabels) {
    const key = m.how + ':' + (m.field || '(no name attr)');
    missingByGroup[key] = (missingByGroup[key] || 0) + 1;
  }
  const brokenLabels = [...document.querySelectorAll('label[for]')]
    .filter((lab) => !document.getElementById(lab.getAttribute('for')))
    .map((lab) => lab.getAttribute('for'));
  const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
  const idCounts = {};
  for (const id of ids) idCounts[id] = (idCounts[id] || 0) + 1;
  const duplicateIds = Object.entries(idCounts).filter(([, n]) => n > 1).map(([id, n]) => ({ id, count: n }));
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  const forbidden = [];
  const patterns = [/\bundefined\b/, /\bnull\b/, /\[object Object\]/, /\bNaN\b/, /Nothing here yet/i, /Brak\s*:/i];
  let node;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue || '';
    if (!text.trim()) continue;
    const parent = node.parentElement;
    if (!parent || ['SCRIPT', 'STYLE', 'PRE', 'CODE', 'TEXTAREA'].includes(parent.tagName)) continue;
    if (hidden(parent)) continue;
    for (const pattern of patterns) {
      const m = pattern.exec(text);
      if (m) {
        forbidden.push({ pattern: String(pattern), match: m[0], context: clean(text), tag: parent.tagName.toLowerCase() });
        break;
      }
    }
    if (forbidden.length >= 20) break;
  }
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter((h) => !hidden(h)).map((h) => ({ level: Number(h.tagName.slice(1)), text: clean(h.textContent).slice(0, 80) }));
  const headingJumps = [];
  let prev = 0;
  for (const h of headings) { if (prev && h.level > prev + 1) headingJumps.push({ from: prev, to: h.level, text: h.text }); prev = h.level; }
  const ariaBroken = [];
  for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
    for (const el of document.querySelectorAll('[' + attr + ']')) {
      for (const id of (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean)) {
        if (!document.getElementById(id)) ariaBroken.push({ attr, id, tag: el.tagName.toLowerCase() });
      }
    }
  }
  const inScrollable = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1) return true;
    }
    return false;
  };
  const vw = window.innerWidth;
  const offenders = [];
  if (document.documentElement.scrollWidth > vw + 1) {
    for (const el of document.querySelectorAll('body *')) {
      if (hidden(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if ((r.right > vw + 2 || r.left < -2) && !inScrollable(el)) {
        offenders.push({ tag: el.tagName.toLowerCase(), cls: clean(el.className).slice(0, 80), id: el.id || '', left: Math.round(r.left), right: Math.round(r.right) });
        if (offenders.length >= 8) break;
      }
    }
  }
  const identity = {
    username: clean(document.querySelector('.avatar-meta strong')?.textContent),
    levelLabel: clean(document.querySelector('.avatar-meta em')?.textContent),
    activePill: clean(document.querySelector('.level-pill.active')?.textContent),
  };
  const banner = document.querySelector('[data-impersonation-banner]');
  const context = {
    impersonation: banner ? {
      actor: banner.getAttribute('data-actor'), subject: banner.getAttribute('data-subject'),
      readOnly: banner.getAttribute('data-read-only'),
      text: clean(banner.textContent), exit: !!banner.querySelector('form[action="/logout"]'),
    } : null,
    adminNotice: !!document.querySelector('[data-admin-context-notice]'),
  };
  const doc = document.documentElement;
  return {
    title: clean(document.title), identity, context,
    overflow: { innerWidth: vw, scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, offenders },
    duplicateIds: duplicateIds.slice(0, 20),
    labels: {
      controls: controls.length,
      missing: missingLabels.length,
      missingByGroup: Object.fromEntries(Object.entries(missingByGroup).sort((a, b) => b[1] - a[1]).slice(0, 12)),
      samples: missingLabels.slice(0, 10),
      brokenFor: brokenLabels.slice(0, 10),
    },
    forbidden: forbidden.slice(0, 10),
    headings: { h1: headings.filter((h) => h.level === 1).map((h) => h.text), jumps: headingJumps.slice(0, 10) },
    ariaBroken: ariaBroken.slice(0, 10),
    text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 600),
  };
})()`;

async function inspectPage(browser) {
  return browser.evaluate(PAGE_CHECK_SOURCE);
}

async function runAxe(browser, axeSource) {
  if (!axeSource) return null;
  try {
    await browser.evaluate(axeSource);
    const raw = await browser.evaluate(`(async () => {
      const r = await axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
        resultTypes: ['violations'],
      });
      return r.violations.map((v) => ({
        id: v.id, impact: v.impact, help: v.help, description: v.description,
        nodes: v.nodes.slice(0, 4).map((n) => ({ target: n.target, html: String(n.html || '').slice(0, 240), summary: n.failureSummary })),
      }));
    })()`);
    return raw || [];
  } catch (e) {
    return [{ id: 'axe-error', impact: 'unknown', help: String(e.message).slice(0, 300), nodes: [] }];
  }
}

const FALLBACK_CONTRAST = String.raw`(() => {
  const parse = (v) => {
    const m = /rgba?\(([^)]+)\)/.exec(v || '');
    if (!m) return null;
    const p = m[1].split(',').map((x) => Number.parseFloat(x.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const blend = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const effectiveBg = (el) => {
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    const layers = [];
    for (let p = el; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.backgroundImage && s.backgroundImage !== 'none') return null;
      const c = parse(s.backgroundColor);
      if (c && c.a > 0) layers.push(c);
      if (c && c.a >= 1) break;
    }
    for (const layer of layers.reverse()) bg = blend(layer, bg);
    return bg;
  };
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!el.isConnected) continue;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.nodeValue.trim()).map((n) => n.nodeValue.trim()).join(' ');
    if (!own) continue;
    const fg = parse(s.color); const bg = effectiveBg(el);
    if (!fg || !bg) continue;
    const fgc = blend(fg, bg);
    const L1 = lum(fgc), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = Number.parseFloat(s.fontSize) || 16;
    const bold = (Number(s.fontWeight) || 400) >= 700;
    const large = px >= 24 || (bold && px >= 18.66);
    const min = large ? 3 : 4.5;
    if (ratio + 0.01 < min) out.push({ ratio: Number(ratio.toFixed(2)), min, text: own.slice(0, 80), tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 60) });
    if (out.length >= 25) break;
  }
  return out;
})()`;

/* ------------------------------------------------------------- routes */
const CRITICAL = {
  admin: [
    '/admin', '/admin/users', '/admin/users/create', '/admin/settings', '/admin/security',
    '/admin/health', '/admin/automation', '/admin/backup-center', '/admin/web-apps', '/admin/api-keys',
    '/admin/system-info', '/admin/services', '/admin/log-center', '/admin/mail', '/admin/updates-center',
    '/compat/admin/netdata', '/compat/admin/rspamd', '/help',
  ],
  reseller: [
    '/reseller', '/reseller/users', '/reseller/users/create', '/reseller/domains', '/reseller/apps',
    '/reseller/backups', '/reseller/dns', '/reseller/packages/create', '/reseller/settings', '/help',
  ],
  user: [
    '/user', '/user/domains', '/user/domains/create', '/user/email', '/user/email/new',
    '/user/databases', '/user/databases/create', '/user/files', '/user/statistics', '/user/app-catalog',
    '/user/backups', '/user/dns', '/user/login-keys', '/user/password', '/user/websites/new', '/user/help', '/help',
  ],
};
const SHOT_ROUTES = new Set([
  '/admin', '/admin/users/create', '/admin/settings', '/admin/security', '/admin/health', '/admin/backup-center',
  '/admin/automation', '/admin/web-apps', '/reseller', '/reseller/users/create', '/reseller/domains',
  '/reseller/packages/create', '/user', '/user/app-catalog', '/user/email', '/user/email/new',
  '/user/databases/create', '/user/files', '/user/statistics', '/user/domains/create', '/help', '/login',
]);
const AXE_ROUTES = new Set([
  '/admin', '/admin/users/create', '/admin/settings', '/admin/security', '/admin/health', '/admin/backup-center',
  '/reseller', '/reseller/users/create', '/reseller/domains', '/user', '/user/email', '/user/databases/create',
  '/user/files', '/user/app-catalog', '/user/statistics', '/help', '/login',
]);

function parseNav(html) {
  const links = [];
  for (const m of html.matchAll(/<a class="nav-item[^"]*"\s+href="([^"]+)"/g)) links.push(m[1].replace(/&amp;/g, '&'));
  return [...new Set(links)];
}
function roleRoutes(role, nav) {
  const prefix = `/${role}`;
  const own = nav.filter((href) => href.startsWith(prefix) || href.startsWith(`/compat/${role}`) || href === '/help');
  return [...new Set([prefix, ...(CRITICAL[role] || []), ...own])].filter((href) => href.startsWith(prefix) || href.startsWith(`/compat/${role}`) || href === '/help');
}

async function sweepRole(browser, collectors, role, session, axeSource) {
  const dash = await session.req(`/${role}`);
  const nav = parseNav(dash.text);
  const routes = roleRoutes(role, nav);
  record('routes', `${role}-nav`, routes.length ? 'pass' : 'fail', `${routes.length} routes discovered for ${role}`, { nav: routes.length, sample: routes.slice(0, 8) });
  await browser.setCookies(session.cookies);
  const seenShots = new Set();
  for (const width of WALK_WIDTHS) {
    for (const pathname of routes) {
      const url = base + pathname;
      let page = null;
      let collected = null;
      try {
        collected = await browser.navigate(url, width, collectors);
        page = await inspectPage(browser);
      } catch (e) {
        record('routes', `${role}-${slug(pathname)}-${width}`, 'fail', `navigation failed: ${e.message}`, { url });
        continue;
      }
      const issue = [];
      const status = collected?.status ?? 0;
      if (!(status >= 200 && status < 400)) issue.push(`status ${status}`);
      if (collected?.consoleErrors?.length) issue.push(`${collected.consoleErrors.length} console error(s)`);
      const badReq = (collected?.failedRequests || []).filter((r) => r.status >= 500);
      if (badReq.length) issue.push(`${badReq.length} 5xx request(s)`);
      if (page.overflow.scrollWidth > page.overflow.innerWidth + 1) issue.push(`overflow ${page.overflow.scrollWidth}>${page.overflow.innerWidth}`);
      if (page.duplicateIds.length) issue.push(`${page.duplicateIds.length} duplicate id(s)`);
      if (page.forbidden.length) issue.push(`${page.forbidden.length} forbidden text(s)`);
      if (page.ariaBroken.length) issue.push(`${page.ariaBroken.length} broken aria ref(s)`);
      if (page.labels.missing) issue.push(`${page.labels.missing} unlabeled control(s)`);
      const routeResult = {
        role, path: pathname, width, status, finalUrl: collected?.finalUrl || url,
        consoleErrors: collected?.consoleErrors || [], failedRequests: collected?.failedRequests || [],
        overflow: page.overflow, duplicateIds: page.duplicateIds, labels: page.labels,
        forbidden: page.forbidden, headings: page.headings, ariaBroken: page.ariaBroken,
        identity: page.identity, context: page.context, title: page.title, issues: issue,
      };
      results.routes.push(routeResult);
      if (issue.length) console.log(`  · ${role} ${pathname} @${width}: ${issue.join('; ')}`);

      const wantShot = SKIP_VISUAL ? false
        : (SHOT_ROUTES.has(pathname) && [390, 1280].includes(width))
          || (issue.some((i) => /forbidden|overflow|duplicate id/.test(i)) && !seenShots.has(`${pathname}-${width}`));
      if (wantShot) {
        try {
          const shotPath = await browser.screenshot(`${role}${pathname.replace(/\//g, '_') || '_'}-${width}${SHOT_ROUTES.has(pathname) ? '' : '-issue'}`);
          routeResult.screenshot = path.relative(OUT, shotPath);
          seenShots.add(`${pathname}-${width}`);
        } catch (e) {
          routeResult.screenshotError = e.message;
        }
      }

      if (axeSource && width === 1280 && AXE_ROUTES.has(pathname)) {
        const violations = await runAxe(browser, axeSource);
        const serious = (violations || []).filter((v) => ['critical', 'serious'].includes(v.impact));
        const axeError = (violations || []).find((v) => v.id === 'axe-error');
        results.axe.push({ role, path: pathname, width, total: violations?.length || 0, serious: serious.length, error: axeError?.help || null, violations: serious.slice(0, 8) });
        routeResult.axeSerious = serious.length;
        if (serious.length || axeError) {
          try { await browser.screenshot(`${role}${pathname.replace(/\//g, '_')}-axe`); } catch { /* ignore */ }
        }
      }
    }
  }
  record('routes', `${role}-walk`, 'pass', `walked ${routes.length} routes at ${WALK_WIDTHS.join('/')}`, { routes: routes.length });
  return routes;
}

/* --------------------------------------------------------- app catalogue */
async function catalogueCheck(browser, collectors, session, label, expectedInstalled) {
  await browser.setCookies(session.cookies);
  await browser.navigate(`${base}/user/app-catalog`, 1280, collectors);
  const initial = await browser.evaluate(`(() => {
    const hidden = (el) => !el || getComputedStyle(el).display === 'none' || el.getClientRects().length === 0;
    return {
      tiles: document.querySelectorAll('[data-app-card]').length,
      installed: document.querySelectorAll('[data-app-card][data-app-installed="1"]').length,
      installedChip: document.querySelector('[data-app-filter="installed"] .tab-count')?.textContent?.trim(),
      availableChip: document.querySelector('[data-app-filter="available"] .tab-count')?.textContent?.trim(),
      installedRegionHidden: hidden(document.querySelector('[data-app-installed-region]')),
      filterEmptyHidden: hidden(document.querySelector('[data-app-filter-empty]')),
      installedRegionText: (document.querySelector('[data-app-installed-region]')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 300),
    };
  })()`);
  const clickAndRead = async (filter) => {
    await browser.evaluate(`document.querySelector('[data-app-filter="${filter}"]')?.click()`);
    await sleep(180);
    return browser.evaluate(`(() => {
      const hidden = (el) => !el || getComputedStyle(el).display === 'none' || el.getClientRects().length === 0;
      const empty = document.querySelector('[data-app-filter-empty]');
      const region = document.querySelector('[data-app-installed-region]');
      return {
        filterEmptyHidden: hidden(empty), installedRegionHidden: hidden(region),
        kind: empty?.getAttribute('data-app-empty-kind') || '',
        title: (document.querySelector('[data-app-filter-title]')?.textContent || '').trim(),
        body: (document.querySelector('[data-app-filter-body]')?.textContent || '').trim(),
        visibleTiles: [...document.querySelectorAll('[data-app-card]')].filter((el) => !hidden(el)).length,
        bothVisible: !hidden(empty) && !hidden(region),
        bothHidden: hidden(empty) && hidden(region),
      };
    })()`);
  };
  const installed = await clickAndRead('installed');
  const available = await clickAndRead('available');
  // no-results state
  await browser.evaluate(`(() => {
    const input = document.querySelector('[data-app-search]');
    if (!input) return false;
    input.value = 'zzzz-no-such-app';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(180);
  const noResults = await browser.evaluate(`(() => {
    const hidden = (el) => !el || getComputedStyle(el).display === 'none' || el.getClientRects().length === 0;
    const empty = document.querySelector('[data-app-filter-empty]');
    const region = document.querySelector('[data-app-installed-region]');
    return {
      filterEmptyHidden: hidden(empty), installedRegionHidden: hidden(region), kind: empty?.getAttribute('data-app-empty-kind') || '',
      title: (document.querySelector('[data-app-filter-title]')?.textContent || '').trim(),
      bothVisible: !hidden(empty) && !hidden(region),
    };
  })()`);
  await browser.evaluate(`document.querySelector('[data-app-reset]')?.click()`);
  let hashTarget = null;
  try {
    await browser.navigate(`${base}/user/app-catalog#app-wordpress`, 1280, collectors);
    await sleep(200);
    hashTarget = await browser.evaluate(`(() => {
      const target = document.querySelector('#app-wordpress');
      return target ? { exists: true, expanded: target.getAttribute('aria-expanded'), focused: document.activeElement === target || target.contains(document.activeElement) } : { exists: false };
    })()`);
  } catch (e) { hashTarget = { exists: false, error: e.message }; }
  let shot = null;
  try { await browser.navigate(`${base}/user/app-catalog`, 390, collectors); await browser.evaluate(`document.querySelector('[data-app-filter="installed"]')?.click()`); await sleep(150); shot = path.relative(OUT, await browser.screenshot(`${label}-catalogue-installed-390`)); } catch { /* ignore */ }
  const expected = Number(expectedInstalled);
  const pass = initial.tiles > 0
    && !installed.bothVisible && !installed.bothHidden
    && !available.bothVisible && !available.bothHidden
    && !noResults.bothVisible
    && initial.installed === expected
    && Number(initial.installedChip) === expected
    && (!expected || installed.installedRegionHidden === false)
    && hashTarget?.exists === true;
  record('catalogue', `${label}-states`, pass ? 'pass' : 'fail',
    `tiles=${initial.tiles} installed=${initial.installed}/${expected} installedState=${installed.kind} noResultsKind=${noResults.kind} hashTarget=${hashTarget?.exists}`,
    { initial, installed, available, noResults, hashTarget, screenshot: shot });
  return { initial, installed, available, noResults, hashTarget, pass, screenshot: shot };
}

/* ------------------------------------------------------- admin/user context */
async function contextCheck(browser, collectors, admin, demouser, demouserPass, dbSource) {
  await browser.setCookies(admin.cookies);
  await browser.navigate(`${base}/user`, 1280, collectors);
  const adminUserView = await inspectPage(browser);
  record('context', 'admin-user-view', adminUserView.context.adminNotice && !adminUserView.context.impersonation ? 'pass' : 'fail',
    adminUserView.context.adminNotice ? 'explicit notice shown, no impersonation banner' : 'missing explicit admin context notice',
    { identity: adminUserView.identity, context: adminUserView.context });
  try { await browser.screenshot('admin-user-view-notice-1280'); } catch { /* ignore */ }

  const usersPage = await admin.req('/admin/users');
  const formMatch = /<form[^>]+action="(\/admin\/users\/(\d+)\/login-as)"[^>]*>[\s\S]*?name="_csrf" value="([^"]+)"/.exec(usersPage.text);
  const anyLoginAs = /action="(\/admin\/users\/(\d+)\/login-as)"/.exec(usersPage.text);
  const dbId = typeof dbSource === 'function' ? dbSource("SELECT id FROM users WHERE username='demouser'")?.rows?.[0]?.[0] : null;
  const targetId = dbId || formMatch?.[2] || anyLoginAs?.[2] || null;
  if (!targetId) {
    record('context', 'impersonation', 'fail', 'no login-as form found on /admin/users');
    return null;
  }
  const csrf = formMatch?.[3] || await admin.getCsrf('/admin/users');
  const preview = new Http(base);
  // Keep the actor session; the POST sets the preview session cookie.
  for (const [k, v] of admin.cookies) preview.cookies.set(k, v);
  const start = await preview.req(`/admin/users/${targetId}/login-as`, { method: 'POST', form: { _csrf: csrf } });
  const bannerPresent = start.status === 302 && preview.cookies.has('OA_SESSION') && preview.cookies.get('OA_SESSION') !== admin.cookies.get('OA_SESSION');
  await browser.setCookies(preview.cookies);
  await browser.navigate(`${base}/user`, 1280, collectors);
  const previewPage = await inspectPage(browser);
  const banner = previewPage.context.impersonation;
  const ok = bannerPresent && banner?.actor === ADMIN_USER && banner?.subject === demouser && banner?.readOnly === '1' && banner?.exit;
  record('context', 'impersonation-banner', ok ? 'pass' : 'fail',
    banner ? `actor=${banner.actor} subject=${banner.subject} readOnly=${banner.readOnly} exit=${banner.exit}` : 'banner missing',
    { startStatus: start.status, location: start.location, banner });
  try { await browser.screenshot('impersonation-banner-1280'); } catch { /* ignore */ }

  // Read-only enforcement: a write under preview must be blocked and persist nothing.
  const previewCsrf = await preview.getCsrf('/user');
  const keyCountBefore = dbSource ? Number(dbSource("SELECT COUNT(*) FROM login_keys WHERE user_id = (SELECT id FROM users WHERE username='demouser')")?.rows?.[0]?.[0] || -1) : -1;
  const write = await preview.req('/user/login-keys/create', { method: 'POST', form: { _csrf: previewCsrf, name: 'qa-preview-write', days: '30', commands: 'CMD_API_DOMAIN' } });
  const keyCountAfter = dbSource ? Number(dbSource("SELECT COUNT(*) FROM login_keys WHERE user_id = (SELECT id FROM users WHERE username='demouser')")?.rows?.[0]?.[0] || -1) : -1;
  const blocked = write.status === 403 && (keyCountAfter === keyCountBefore || keyCountBefore < 0);
  record('context', 'preview-read-only', blocked ? 'pass' : 'fail',
    `write under preview -> HTTP ${write.status}; login_keys ${keyCountBefore}->${keyCountAfter}`,
    { status: write.status, body: write.text.slice(0, 200), keyCountBefore, keyCountAfter });

  // Stop preview and confirm the administrator session is restored.
  const stopCsrf = await preview.getCsrf('/user');
  const stop = await preview.req('/logout', { method: 'POST', form: { _csrf: stopCsrf, stop_impersonation: '1' } });
  const restored = stop.status === 302 && preview.cookies.has('OA_SESSION');
  record('context', 'stop-impersonation', restored ? 'pass' : 'fail', `stop -> HTTP ${stop.status} ${stop.location}`, { location: stop.location });
  return { adminUserView, previewPage, write, stop };
}

/* ----------------------------------------------- targeted fix checks */
function contrastRatio(a, b) {
  const parse = (value) => {
    const m = /rgba?\(([^)]+)\)/.exec(String(value || ''));
    if (!m) return null;
    const p = m[1].split(',').map((x) => Number.parseFloat(x.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const fg = parse(a); const bg = parse(b);
  if (!fg || !bg) return null;
  const L1 = lum(fg); const L2 = lum(bg);
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}

async function loginLocaleChecks() {
  const cases = [
    { id: 'query-pl', path: '/login?lang=pl', headers: {}, expect: 'pl' },
    { id: 'header-pl', path: '/login', headers: { 'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.5' }, expect: 'pl' },
    { id: 'cookie-pl', path: '/login', headers: { Cookie: 'oa_lang=pl' }, expect: 'pl' },
    { id: 'query-en-over-header-pl', path: '/login?lang=en', headers: { 'Accept-Language': 'pl-PL,pl;q=0.9' }, expect: 'en' },
  ];
  const details = [];
  let ok = true;
  for (const item of cases) {
    const res = await new Http(base).req(item.path, { headers: item.headers });
    const lang = /<html\s+lang="([^"]+)"/.exec(res.text)?.[1] || '';
    const polish = /(Zaloguj|Nazwa użytkownika|Hasło)/.test(res.text);
    const cookie = res.setCookies.find((value) => /^oa_lang=/i.test(value)) || '';
    const pass = res.status === 200 && lang === item.expect && (item.expect === 'pl' ? polish : !polish);
    if (!pass) ok = false;
    details.push({ case: item.id, expect: item.expect, status: res.status, lang, polish, cookie: cookie.split(';')[0] });
  }
  record('i18n', 'login-locale', ok ? 'pass' : 'fail',
    details.map((d) => `${d.case}:${d.lang}/${d.polish ? 'pl' : 'en'}`).join(' · '), { cases: details });
  return ok;
}

async function serviceCardCheck(browser, collectors, admin) {
  await browser.setCookies(admin.cookies);
  await browser.navigate(`${base}/admin`, 1280, collectors);
  const rows = await browser.evaluate(`(() => {
    const hidden = (el) => !el || getComputedStyle(el).display === 'none' || el.getClientRects().length === 0;
    return [...document.querySelectorAll('.service-row > strong')].filter((el) => !hidden(el)).map((el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        text: (el.textContent || '').trim().slice(0, 60),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        lineHeight: Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5 || 18,
        whiteSpace: style.whiteSpace,
      };
    });
  })()`);
  const bad = (rows || []).filter((r) => r.width < 80 || r.height > r.lineHeight * 1.6);
  let shot = null;
  try { shot = path.relative(OUT, await browser.screenshot('admin-service-names-1280')); } catch { /* ignore */ }
  record('layout', 'admin-service-names', rows?.length && bad.length === 0 ? 'pass' : 'fail',
    `${rows?.length || 0} service names; ${bad.length} narrower than 80px or wrapped`, { bad: bad.slice(0, 8), rows: rows?.slice(0, 12), screenshot: shot });
  return bad.length === 0;
}

async function themeContrastCheck(browser, collectors, admin) {
  await browser.setCookies(admin.cookies);
  await browser.emulateLight();
  await browser.evaluate("localStorage.setItem('oa_theme','light')").catch(() => {});
  await browser.navigate(`${base}/admin`, 1280, collectors);
  await browser.evaluate("localStorage.setItem('oa_theme','light')");
  await browser.navigate(`${base}/admin`, 1280, collectors);
  const light = await browser.evaluate(`(() => {
    const el = document.querySelector('.badge-ok');
    if (!el) return null;
    const s = getComputedStyle(el);
    return { text: (el.textContent || '').trim(), color: s.color, background: s.backgroundColor, fontSize: s.fontSize };
  })()`);
  const lightRatio = light ? contrastRatio(light.color, light.background) : null;
  record('theme', 'light-badge-contrast', lightRatio !== null && lightRatio >= 4.5 ? 'pass' : 'fail',
    light ? `.badge-ok ${light.color} on ${light.background} = ${lightRatio?.toFixed(2) ?? 'n/a'}:1` : '.badge-ok not found', { light, ratio: lightRatio });

  await browser.evaluate("localStorage.setItem('oa_theme','dark')");
  await browser.navigate(`${base}/admin/settings`, 1280, collectors);
  const dark = await browser.evaluate(`(() => {
    const el = document.querySelector('.btn-primary');
    if (!el) return null;
    const s = getComputedStyle(el);
    return { text: (el.textContent || '').trim(), color: s.color, background: s.backgroundColor, fontSize: s.fontSize };
  })()`);
  const darkRatio = dark ? contrastRatio(dark.color, dark.background) : null;
  record('theme', 'dark-primary-contrast', darkRatio !== null && darkRatio >= 4.5 ? 'pass' : 'fail',
    dark ? `.btn-primary ${dark.color} on ${dark.background} = ${darkRatio?.toFixed(2) ?? 'n/a'}:1` : '.btn-primary not found', { dark, ratio: darkRatio });
  await browser.evaluate("localStorage.setItem('oa_theme','light')").catch(() => {});
  return { lightRatio, darkRatio };
}

/* -------------------------------------------------------- CSP smoke */
async function cspSmoke(browser, collectors, admin, user) {
  const add = (id, status, detail, evidence = null) => {
    results.security.push({ id, status, detail, evidence });
    record('smoke', id, status, detail, evidence);
  };
  const violations = [];
  const consoleAll = [];
  const capture = async (label) => {
    try {
      const found = await browser.evaluate('window.__cspViolations || []');
      for (const item of found || []) violations.push({ where: label, ...item });
    } catch { /* page may be navigating */ }
    consoleAll.push(...(collectors.consoleErrors || []));
    collectors.reset();
  };
  await browser.addInitScript(`window.__cspViolations=[];document.addEventListener('securitypolicyviolation',function(e){window.__cspViolations.push({directive:e.violatedDirective,blockedURI:e.blockedURI,sourceFile:e.sourceFile,line:e.lineNumber,sample:String(e.sample||'').slice(0,120)});});`);

  /* 1. static CSP/markup contract on real responses */
  const pages = [
    ['/login', null], ['/admin', admin], ['/admin/users', admin], ['/user/app-catalog', user],
  ];
  const markup = [];
  for (const [pathname, session] of pages) {
    const res = await (session ? session.req(pathname) : new Http(base).req(pathname));
    const csp = res.headers.get('content-security-policy') || '';
    const scriptSrc = /(?:^|;)\s*script-src([^;]*)/i.exec(csp)?.[1]?.trim() || '';
    const nonce = /'nonce-([^']+)'/.exec(scriptSrc)?.[1] || '';
    const scripts = [...res.text.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]);
    const missingNonce = scripts.filter((attrs) => !/\bnonce\s*=/.test(attrs)).length;
    const inlineEvents = [...res.text.matchAll(/\son(?:click|change|submit|input|load|error|focus|blur)\s*=/gi)].length;
    markup.push({ pathname, csp, scriptSrc, nonce: !!nonce, scripts: scripts.length, missingNonce, inlineEvents });
  }
  const noUnsafe = markup.every((m) => !/unsafe-inline/i.test(m.scriptSrc) && m.nonce);
  add('CSP-001-script-policy', noUnsafe ? 'pass' : 'fail',
    markup.map((m) => `${m.pathname}: ${m.scriptSrc.replace(/'nonce-[^']+'/, "'nonce-…'")}`).join(' | '), { markup });
  const cleanMarkup = markup.every((m) => m.missingNonce === 0 && m.inlineEvents === 0);
  add('CSP-002-markup', cleanMarkup ? 'pass' : 'fail',
    markup.map((m) => `${m.pathname}: scripts=${m.scripts} missingNonce=${m.missingNonce} inlineEvents=${m.inlineEvents}`).join(' | '));

  /* 2. real browser login through the form */
  await browser.setCookies([]);
  await browser.navigate(`${base}/login`, 1280, null);
  await capture('login');
  await browser.evaluate(`(() => {
    const form = document.querySelector('form[action="/login"]');
    const u = document.querySelector('#username'); const p = document.querySelector('#password');
    if (!form || !u || !p) throw new Error('login form missing');
    u.value = ${JSON.stringify(ADMIN_USER)}; p.value = ${JSON.stringify(adminPass)};
    form.requestSubmit(); return true;
  })()`);
  let loginPath = '';
  for (let i = 0; i < 80; i++) {
    await sleep(100);
    try { loginPath = await browser.evaluate('location.pathname'); } catch { /* nav */ }
    if (loginPath && loginPath !== '/login') break;
  }
  await capture('admin');
  const adminIdentity = await browser.evaluate(`(() => ({ user: document.querySelector('.avatar-meta strong')?.textContent?.trim() || '', level: document.querySelector('.avatar-meta em')?.textContent?.trim() || '' }))()`);
  add('CSP-003-ui-login', loginPath === '/admin' && adminIdentity.user === ADMIN_USER ? 'pass' : 'fail',
    `login form submit -> ${loginPath || 'no navigation'}, identity=${adminIdentity.user}/${adminIdentity.level}`, { adminIdentity });

  /* 3. theme toggle + persistence */
  await browser.evaluate("localStorage.setItem('oa_theme','light')");
  await browser.send('Page.reload');
  await sleep(400);
  await capture('theme-light');
  const before = await browser.evaluate("document.documentElement.dataset.mode || 'light'");
  await browser.evaluate("document.querySelector('[data-toggle-theme]')?.click()");
  await sleep(200);
  const darkMode = await browser.evaluate("document.documentElement.dataset.mode || 'light'");
  const stored = await browser.evaluate("localStorage.getItem('oa_theme') || ''");
  await browser.send('Page.reload');
  await sleep(350);
  const persisted = await browser.evaluate("document.documentElement.dataset.mode || 'light'");
  await browser.evaluate("document.querySelector('[data-toggle-theme]')?.click()");
  await sleep(150);
  const lightMode = await browser.evaluate("document.documentElement.dataset.mode || 'light'");
  await capture('theme-dark');
  add('CSP-004-theme', darkMode === 'dark' && stored === 'dark' && persisted === 'dark' && lightMode === 'light' ? 'pass' : 'fail',
    `start=${before} click->${darkMode} stored=${stored} reload=${persisted} back->${lightMode}`, { before, darkMode, stored, persisted, lightMode });

  /* 4. app catalogue filters */
  await browser.setCookies(user.cookies);
  await browser.navigate(`${base}/user/app-catalog`, 1280, null);
  await capture('app-catalog');
  const catalog = await browser.evaluate(`(() => {
    const hidden = (el) => !el || getComputedStyle(el).display === 'none' || el.getClientRects().length === 0;
    const read = () => ({ empty: !hidden(document.querySelector('[data-app-filter-empty]')), region: !hidden(document.querySelector('[data-app-installed-region]')), tiles: [...document.querySelectorAll('[data-app-card]')].filter((el) => !hidden(el)).length });
    document.querySelector('[data-app-filter="installed"]')?.click();
    const installed = read();
    document.querySelector('[data-app-filter="available"]')?.click();
    const available = read();
    document.querySelector('[data-app-filter="all"]')?.click();
    const all = read();
    return { installed, available, all };
  })()`);
  const catalogOk = catalog.all.tiles > 0 && catalog.installed.empty === false && catalog.available.empty === false
    && catalog.installed.region === true && catalog.available.region === true;
  add('CSP-005-app-catalog', catalogOk ? 'pass' : 'fail',
    `all tiles=${catalog.all.tiles}, installed empty=${catalog.installed.empty} region=${catalog.installed.region}, available empty=${catalog.available.empty} region=${catalog.available.region}`, { catalog });

  /* 5. delegated data-confirm */
  await browser.setCookies(admin.cookies);
  await browser.navigate(`${base}/admin/users`, 1280, null);
  await capture('users');
  let dialog = null;
  const dialogHandler = (method, params) => { if (method === 'Page.javascriptDialogOpening') dialog = params; };
  browser.on(dialogHandler);
  const confirmForms = await browser.evaluate("document.querySelectorAll('form[data-confirm]').length");
  // Click asynchronously: window.confirm blocks the renderer, and awaiting the
  // evaluate call would deadlock before we can dismiss the dialog.
  await browser.evaluate("setTimeout(() => { document.querySelector('form[data-confirm] button[type=submit]')?.click(); }, 0); true");
  await sleep(350);
  if (dialog) await browser.send('Page.handleJavaScriptDialog', { accept: false });
  await sleep(200);
  const afterDialog = await browser.evaluate('location.pathname');
  await capture('data-confirm');
  add('CSP-006-data-confirm', !!dialog && afterDialog === '/admin/users' ? 'pass' : 'fail',
    `forms=${confirmForms}, dialog=${!!dialog} ${dialog?.message ? 'message="' + dialog.message.slice(0, 70) + '"' : ''}, path after dismiss=${afterDialog}`, { dialog: dialog ? { message: dialog.message, type: dialog.type } : null });

  /* 6. delegated auto-submit (captured, prevented before mutation) */
  await browser.navigate(`${base}/admin/php`, 1280, null);
  await capture('php');
  const auto = await browser.evaluate(`(() => {
    window.__autoSubmitted = false;
    document.addEventListener('submit', (event) => {
      if (event.target.querySelector('[data-auto-submit]')) { event.preventDefault(); window.__autoSubmitted = true; }
    }, true);
    let select = document.querySelector('[data-auto-submit]');
    if (!select) {
      const form = document.createElement('form'); form.method = 'post'; form.action = '/admin/php';
      select = document.createElement('select'); select.name = 'version'; select.setAttribute('data-auto-submit', '');
      const option = document.createElement('option'); option.textContent = '8.3'; select.append(option);
      form.append(select); document.body.append(form);
    }
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { found: !!document.querySelector('[data-auto-submit]'), forms: document.querySelectorAll('[data-auto-submit]').length };
  })()`);
  await sleep(250);
  const autoSubmitted = await browser.evaluate('window.__autoSubmitted === true');
  await capture('auto-submit');
  add('CSP-007-auto-submit', autoSubmitted ? 'pass' : 'fail', `selects=${auto.forms}, submit event observed=${autoSubmitted}`);

  /* 7. CSP violation collection */
  const cspConsole = [...new Set(consoleAll.filter((line) => /Content Security Policy|Refused to|CSP/i.test(line)))];
  add('CSP-008-violations', violations.length === 0 && cspConsole.length === 0 ? 'pass' : 'fail',
    `securitypolicyviolation events=${violations.length}, console CSP errors=${cspConsole.length}`,
    { violations: violations.slice(0, 10), console: cspConsole.slice(0, 10) });

  /* 8. webmail session token is stored hashed */
  try {
    const wm = new Http(base);
    const res = await wm.req('/webmail/login', { method: 'POST', form: { email: 'info@example.com', password: 'demo' } });
    const raw = wm.cookies.get('OA_WEBMAIL') || '';
    const row = dbGet('SELECT token FROM webmail_sessions ORDER BY created_at DESC LIMIT 1');
    const stored = row?.rows?.[0]?.[0] || '';
    const source = fs.readFileSync(path.join(ROOT, 'src/features/webmail.mjs'), 'utf8');
    const usesHash = /hashSessionToken\(token\)/.test(source);
    const ok = res.status === 302 && raw.length > 0 && /^[a-f0-9]{64}$/.test(stored) && stored !== raw && usesHash;
    add('WEBMAIL-001-token-hash', ok ? 'pass' : 'fail',
      `login=${res.status} cookie=${raw.length} chars, DB=${stored.length} chars hex=${/^[a-f0-9]{64}$/.test(stored)}, cookie==DB=${stored === raw}, sourceHash=${usesHash}`,
      { dbPrefix: stored.slice(0, 12) });
  } catch (e) {
    add('WEBMAIL-001-token-hash', 'fail', `webmail probe failed: ${e.message}`);
  }

  // Remove the listener added for the dialog probe.
  const idx = browser.handlers.indexOf(dialogHandler);
  if (idx >= 0) browser.handlers.splice(idx, 1);
}

/* --------------------------------------------------- templates + theme */
async function templatesCheck(browser, collectors, admin) {
  const page = await admin.req('/admin/templates');
  const hasObject = /\[object Object\]/.test(page.text);
  const rows = ['header.html', 'footer.html', 'login.html'].every((name) => page.text.includes(name));
  let shot = null;
  try {
    await browser.setCookies(admin.cookies);
    await browser.navigate(`${base}/admin/templates`, 1280, collectors);
    shot = path.relative(OUT, await browser.screenshot('admin-templates-fixed-1280'));
  } catch { /* screenshot best effort */ }
  record('content', 'admin-templates', !hasObject && rows ? 'pass' : 'fail',
    hasObject ? 'renders [object Object]' : `table renders header.html/footer.html/login.html without [object Object]`,
    { hasObject, rows, screenshot: shot });
  return !hasObject && rows;
}

async function darkThemeCheck(browser, collectors, sessions, axeSource) {
  const jobs = [
    ['admin', '/admin', 1280, sessions.admin],
    ['admin', '/admin/users/create', 1280, sessions.admin],
    ['admin', '/admin/settings', 1280, sessions.admin],
    ['reseller', '/reseller', 1280, sessions.reseller],
    ['user', '/user', 1280, sessions.user],
    ['user', '/user/app-catalog', 1280, sessions.user],
    ['user', '/user/files', 1280, sessions.user],
    ['login', '/login', 1280, null],
    ['admin', '/admin', 390, sessions.admin],
    ['user', '/user', 390, sessions.user],
  ];
  // Seed localStorage on the origin, then let each page boot in dark mode.
  await browser.setCookies([]);
  await browser.navigate(`${base}/login`, 1280, collectors);
  await browser.evaluate("localStorage.setItem('oa_theme','dark')");
  const details = [];
  let ok = true;
  for (const [role, pathname, width, session] of jobs) {
    try {
      await browser.setCookies(session ? session.cookies : []);
      const collected = await browser.navigate(`${base}${pathname}`, width, collectors);
      const state = await browser.evaluate(`(() => {
        const bg = getComputedStyle(document.body).backgroundColor;
        const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(bg);
        const lum = m ? (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255 : null;
        return { mode: document.documentElement.dataset.mode || '', bg, lum, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth };
      })()`);
      const shot = path.relative(OUT, await browser.screenshot(`dark-${role}${pathname.replace(/\//g, '_') || '_'}-${width}`));
      const item = {
        role, path: pathname, width, status: collected.status,
        mode: state.mode, bg: state.bg, darkBg: state.lum !== null && state.lum < 0.45,
        overflow: state.scrollWidth > state.innerWidth + 1,
        consoleErrors: collected.consoleErrors, screenshot: shot,
      };
      details.push(item);
      if (item.mode !== 'dark' || !item.darkBg || item.overflow || item.consoleErrors.length) ok = false;
      if (axeSource && width === 1280) {
        const violations = await runAxe(browser, axeSource);
        const serious = (violations || []).filter((v) => ['critical', 'serious'].includes(v.impact));
        const axeError = (violations || []).find((v) => v.id === 'axe-error');
        results.axe.push({ theme: 'dark', role, path: pathname, width, total: violations?.length || 0, serious: serious.length, error: axeError?.help || null, violations: serious.slice(0, 8) });
      }
    } catch (e) {
      details.push({ role, path: pathname, width, error: e.message });
      ok = false;
    }
  }
  await browser.evaluate("localStorage.setItem('oa_theme','light')").catch(() => {});
  const broken = details.filter((d) => d.error || d.mode !== 'dark' || !d.darkBg || d.overflow || d.consoleErrors?.length);
  record('theme', 'dark-mode', ok ? 'pass' : 'fail',
    `${details.length} dark-theme page snapshots; ${broken.length} failed mode/background/overflow/console checks`,
    { snapshots: details });
  return details;
}

/* ------------------------------------------------------------ security */
async function securityChecks(admin, demouser, resellerB, userB) {
  const add = (id, status, detail, evidence = null) => {
    results.security.push({ id, status, detail, evidence });
    record('security', id, status, detail, evidence);
  };

  /* SEC-001 reseller A/B + user object scope over REST */
  try {
    const listA = await api('demoreseller', DEMO_PASS, '/api/v1/domains');
    const namesA = (listA.json?.domains || []).map((d) => d.name);
    const listB = await api(resellerB.username, resellerB.password, '/api/v1/domains');
    const namesB = (listB.json?.domains || []).map((d) => d.name);
    const readForeign = await api('demoreseller', DEMO_PASS, '/api/v1/dns/qa-b.example');
    const writeForeign = await api('demoreseller', DEMO_PASS, '/api/v1/dns/qa-b.example', { method: 'POST', body: { name: 'qa-evil', type: 'A', value: '203.0.113.9' } });
    const deleteForeign = await api('demoreseller', DEMO_PASS, '/api/v1/dns/qa-b.example', { method: 'DELETE' });
    const userForeign = await api('demouser', DEMO_PASS, '/api/v1/dns/qa-b.example');
    const ownB = await api(resellerB.username, resellerB.password, '/api/v1/dns/qa-b.example');
    const scopeOk = !namesA.includes('qa-b.example') && namesB.includes('qa-b.example')
      && readForeign.status === 404 && writeForeign.status === 404 && deleteForeign.status === 404
      && userForeign.status === 404 && ownB.status === 200;
    add('SEC-001-reseller-ab', scopeOk ? 'pass' : 'fail',
      `A sees [${namesA.join(',')}] B sees [${namesB.join(',')}]; foreign read/write/delete=${readForeign.status}/${writeForeign.status}/${deleteForeign.status}; user foreign=${userForeign.status}; B own=${ownB.status}`,
      { readForeign: readForeign.text.slice(0, 160) });
  } catch (e) { add('SEC-001-reseller-ab', 'fail', `error: ${e.message}`); }

  /* SEC-002 symlink + hardlink escape */
  try {
    const home = path.join(dataDir, 'homes', 'demouser');
    fs.mkdirSync(home, { recursive: true });
    const outsideDir = fs.mkdtempSync(path.join(OUT, 'outside-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'outside-secret');
    const linkFile = path.join(home, 'qa-evil-link');
    const linkDir = path.join(home, 'qa-evil-dir');
    const hardFile = path.join(home, 'qa-evil-hard');
    for (const p of [linkFile, linkDir, hardFile]) { try { fs.rmSync(p, { force: true }); } catch { /* ignore */ } }
    fs.symlinkSync(outsideFile, linkFile);
    fs.symlinkSync(outsideDir, linkDir);
    fs.linkSync(outsideFile, hardFile);
    const download = await api('demouser', DEMO_PASS, `/api/v1/files/download?path=${encodeURIComponent('/home/demouser/qa-evil-link')}`);
    const uploadLink = await api('demouser', DEMO_PASS, '/api/v1/files/upload', { method: 'POST', body: { path: '/home/demouser', name: 'qa-evil-link', data: Buffer.from('overwritten').toString('base64') } });
    const uploadDir = await api('demouser', DEMO_PASS, '/api/v1/files/upload', { method: 'POST', body: { path: '/home/demouser/qa-evil-dir', name: 'created.txt', data: Buffer.from('x').toString('base64') } });
    const uploadHard = await api('demouser', DEMO_PASS, '/api/v1/files/upload', { method: 'POST', body: { path: '/home/demouser', name: 'qa-evil-hard', data: Buffer.from('overwritten').toString('base64') } });
    const outsideIntact = fs.readFileSync(outsideFile, 'utf8') === 'outside-secret' && !fs.existsSync(path.join(outsideDir, 'created.txt'));
    const list = await api('demouser', DEMO_PASS, '/api/v1/files');
    const entry = (list.json?.entries || []).find((x) => x.name === 'qa-evil-link');
    const ok = download.status === 403 && uploadLink.status === 403 && uploadDir.status === 403 && uploadHard.status === 403 && outsideIntact && entry?.unsafe === true;
    add('SEC-002-symlink-hardlink', ok ? 'pass' : 'fail',
      `download=${download.status} uploadLink=${uploadLink.status} uploadDir=${uploadDir.status} uploadHard=${uploadHard.status} outsideIntact=${outsideIntact} listedUnsafe=${entry?.unsafe}`,
      { uploadLink: uploadLink.text.slice(0, 180), uploadHard: uploadHard.text.slice(0, 180) });
    fs.rmSync(outsideDir, { recursive: true, force: true });
    for (const p of [linkFile, linkDir, hardFile]) { try { fs.rmSync(p, { force: true }); } catch { /* ignore */ } }
  } catch (e) { add('SEC-002-symlink-hardlink', 'fail', `error: ${e.message}`); }

  /* SEC-003 no shell string execution in installer code paths */
  try {
    // Installer modules only: these are the paths that interpolate form data
    // into child processes. Comments are stripped so prose mentioning sh -c is
    // not a false positive.
    const files = ['src/appcatalog.mjs', 'src/nextcloud.mjs', 'src/wordpress.mjs', 'src/features/app-catalog.mjs', 'src/features/hosted-apps.mjs', 'src/core/archive-utils.mjs'];
    const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const hits = [];
    for (const rel of files) {
      const full = path.join(ROOT, rel);
      if (!fs.existsSync(full)) continue;
      const text = stripComments(fs.readFileSync(full, 'utf8'));
      for (const pattern of [/\bsh\s+-c\b/g, /\bexecSync\s*\(/g, /\bexec\s*\(\s*[`'"]/g, /spawnSync\(\s*['"]sh['"]/g]) {
        let m;
        while ((m = pattern.exec(text))) hits.push(`${rel}:${m.index}:${m[0]}`);
      }
    }
    // apps.mjs uses sh -c only for a numeric loopback port probe; record it as
    // a hardening note instead of conflating it with installer form data.
    const appsText = fs.readFileSync(path.join(ROOT, 'src/apps.mjs'), 'utf8');
    const portProbe = /spawnSync\(\s*['"]sh['"]\s*,\s*\[\s*['"]-c['"]\s*,\s*`[^`]*\$\{port\}/.test(appsText);
    add('SEC-003-no-sh-c', hits.length === 0 ? 'pass' : 'fail',
      hits.length ? `${hits.length} shell-string execution hit(s) in installer modules` : `installer modules use argv only; apps.mjs port probe${portProbe ? ' still uses sh -c for an internal numeric port (P2 hardening)' : ' is argv-only'}`,
      { hits: hits.slice(0, 10), portProbe });
  } catch (e) { add('SEC-003-no-sh-c', 'fail', `error: ${e.message}`); }

  /* SEC-004 login-key command allowlist */
  try {
    const page = await demouser.req('/user/login-keys');
    const lkCsrf = /name="_csrf"\s+value="([^"]+)"/.exec(page.text)?.[1] || '';
    const created = await demouser.req('/user/login-keys/create', { method: 'POST', form: { _csrf: lkCsrf, name: 'qa-final-key', days: '30', commands: 'CMD_API_DOMAIN' } });
    const keyId = /<code>([a-f0-9]{10,16})<\/code>/.exec(created.text)?.[1];
    const secret = /<code>([A-Za-z0-9_-]{20,})<\/code>/.exec(created.text)?.[1];
    if (!keyId || !secret) throw new Error('could not parse created login key');
    const allowed = await api('demouser', `${keyId}:${secret}`, '/CMD_API_DOMAIN');
    const denied = await api('demouser', `${keyId}:${secret}`, '/CMD_API_POP');
    const deniedApi = await api('demouser', `${keyId}:${secret}`, '/api/v1/email');
    const allowedOk = allowed.status === 200 && /(?:^|&)error=0(?:&|$)/.test(allowed.text);
    const deniedOk = denied.status === 200 && /(?:^|&)error=1(?:&|$)/.test(denied.text) && deniedApi.status === 401;
    add('SEC-004-login-key-scope', allowedOk && deniedOk ? 'pass' : 'fail',
      `allowed=${allowed.status}/${/error=0/.test(allowed.text)} deniedCMD=${denied.status}/${/error=1/.test(denied.text)} deniedAPI=${deniedApi.status}`,
      { keyId, denied: denied.text.slice(0, 150) });
    const row = dbGet("SELECT id FROM login_keys WHERE key_id = '" + keyId.replace(/[^a-f0-9]/g, '') + "'");
    if (row?.rows?.[0]?.[0]) await demouser.req(`/user/login-keys/${row.rows[0][0]}/delete`, { method: 'POST', form: { _csrf: lkCsrf } });
  } catch (e) { add('SEC-004-login-key-scope', 'fail', `error: ${e.message}`); }

  /* SEC-005 unsigned update manifest refused */
  try {
    const mod = await import(fileUrl(path.join(ROOT, 'src/updates.mjs')));
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const rawPub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    const manifest = {
      product: 'openadmin', version: '9.9.9', sha256: 'a'.repeat(64),
      releaseUrl: 'https://updates.example.test/openadmin-9.9.9.tar.gz',
    };
    const unsigned = mod.verifyUpdateManifest(manifest, { allowUnsigned: false });
    const sort = (v) => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
    const canonical = JSON.stringify(sort(manifest));
    const goodSig = crypto.sign(null, Buffer.from(canonical), privateKey).toString('base64');
    const signedOk = mod.verifyUpdateManifest({ ...manifest, signature: { algorithm: 'ed25519', keyId: 'qa', value: goodSig } }, { publicKeys: [`qa=${rawPub}`] });
    const signedBad = mod.verifyUpdateManifest({ ...manifest, signature: { algorithm: 'ed25519', keyId: 'qa', value: Buffer.alloc(64).toString('base64') } }, { publicKeys: [`qa=${rawPub}`] });
    const ok = unsigned.ok === false && unsigned.code === 'unsigned' && signedOk.ok === true && signedBad.ok === false;
    add('SEC-005-unsigned-update', ok ? 'pass' : 'fail',
      `unsigned=${unsigned.code} signedGood=${signedOk.ok} signedBad=${signedBad.code}`,
      { unsigned, signedBad });
  } catch (e) { add('SEC-005-unsigned-update', 'fail', `error: ${e.message}`); }

  /* SEC-019 MCP tenant scope */
  try {
    const keys = await createApiKeys(admin);
    const adminTools = (await mcp(keys.admin, 'tools/list')).json?.result?.tools?.map((t) => t.name) || [];
    const resellerTools = (await mcp(keys.reseller, 'tools/list')).json?.result?.tools?.map((t) => t.name) || [];
    const userTools = (await mcp(keys.user, 'tools/list')).json?.result?.tools?.map((t) => t.name) || [];
    const healthAsReseller = await mcpCall(keys.reseller, 'get_health');
    const healthAsUser = await mcpCall(keys.user, 'get_health');
    const domainsReseller = await mcpCall(keys.reseller, 'list_domains');
    const domainsUser = await mcpCall(keys.user, 'list_domains');
    const backupsUser = await mcpCall(keys.user, 'list_backups');
    const namesFrom = (value) => (Array.isArray(value) ? value : (value?.domains || [])).map((d) => (typeof d === 'string' ? d : d.name));
    const resellerNames = namesFrom(domainsReseller.value);
    const userNames = namesFrom(domainsUser.value);
    const adminOnly = ['get_health', 'get_mail_queue', 'get_mail_overview', 'get_settings', 'list_users', 'list_packages'];
    const leak = [...resellerTools, ...userTools].filter((t) => adminOnly.includes(t));
    const ok = leak.length === 0
      && healthAsReseller.isError && healthAsUser.isError
      && !resellerNames.includes('qa-b.example') && !resellerNames.includes('demo.openadmin.local')
      && !userNames.includes('qa-b.example') && !userNames.includes('reseller-demo.local')
      && Array.isArray(backupsUser.value) && adminTools.includes('get_health');
    add('SEC-019-mcp-scope', ok ? 'pass' : 'fail',
      `admin-only leaked=${leak.length}; health reseller/user=${healthAsReseller.isError}/${healthAsUser.isError}; resellerDomains=[${resellerNames.slice(0, 6)}]; userDomains=[${userNames.slice(0, 6)}]; userBackups=${Array.isArray(backupsUser.value) ? backupsUser.value.length : 'n/a'}`,
      { resellerTools, userTools });
  } catch (e) { add('SEC-019-mcp-scope', 'fail', `error: ${e.message}`); }

  /* SEC-006 X-Forwarded-For trust over HTTP: audit must store the socket peer. */
  try {
    const before = dbGet("SELECT COUNT(*) FROM audit_log WHERE action='login'");
    const spoof = await login(ADMIN_USER, adminPass, { 'X-Forwarded-For': '203.0.113.77' });
    const row = dbGet("SELECT actor, ip FROM audit_log WHERE action='login' ORDER BY id DESC LIMIT 1");
    const ip = row?.rows?.[0]?.[1] || '';
    const ok = spoof.res.status === 302 && ip === '127.0.0.1';
    add('SEC-006-xff-trust', ok ? 'pass' : 'fail', `spoofed XFF login audit ip=${ip || 'n/a'} (expected socket 127.0.0.1)`, { audit: row?.rows?.[0] });
  } catch (e) { add('SEC-006-xff-trust', 'fail', `error: ${e.message}`); }

  /* SEC-009 shared rate limiter for Basic Auth */
  try {
    const weakUser = `qarate${Date.now().toString().slice(-5)}`;
    const weakPass = 'QaRatePass!2026';
    const create = await admin.req('/admin/users/create', {
      method: 'POST', form: { _csrf: await admin.getCsrf('/admin/users/create'), username: weakUser, password: weakPass, email: `${weakUser}@example.test`, package: 'default', owner: '' },
    });
    const createdId = dbGet(`SELECT id FROM users WHERE username='${weakUser}'`)?.rows?.[0]?.[0];
    let last = null;
    for (let i = 0; i < 9; i++) last = await api(weakUser, 'wrong-password', '/api/v1/me');
    const correct = await api(weakUser, weakPass, '/api/v1/me');
    const ok = !!createdId && correct.status === 401;
    add('SEC-009-basic-rate-limit', ok ? 'pass' : 'fail', `created=${!!createdId} (${create.status}) after 9 failures correct password -> ${correct.status} (expected 401)`, { last: last?.status });
    // The limiter is IP-wide; clear the audit's own failed attempts so later
    // checks are not poisoned by this isolated negative test.
    dbExec('DELETE FROM login_attempts');
  } catch (e) { add('SEC-009-basic-rate-limit', 'fail', `error: ${e.message}`); }

  /* Password policy is enforced server-side (SEC-008). */
  try {
    const weakUser = `qaweak${Date.now().toString().slice(-5)}`;
    const res = await admin.req('/admin/users/create', {
      method: 'POST', form: { _csrf: await admin.getCsrf('/admin/users/create'), username: weakUser, password: 'short', email: `${weakUser}@example.test`, package: 'default', owner: '' },
    });
    const row = dbGet(`SELECT COUNT(*) FROM users WHERE username='${weakUser}'`);
    const created = Number(row?.rows?.[0]?.[0] || 0);
    const rejected = created === 0 && (res.status === 302 ? /type=error/i.test(res.location) : /(Hasło|password|policy|10 znak)/i.test(res.text));
    add('SEC-008-password-policy', rejected ? 'pass' : 'fail', `weak password -> HTTP ${res.status}; user rows=${created}`, { location: res.location, text: res.text.slice(0, 180) });
  } catch (e) { add('SEC-008-password-policy', 'fail', `error: ${e.message}`); }

  /* SEC-011 SSO one-time nonce replay (module-level: no PHP app in sandbox). */
  try {
    fs.rmSync(UNIT_DATA, { recursive: true, force: true });
    fs.mkdirSync(UNIT_DATA, { recursive: true, mode: 0o700 });
    process.env.OA_DATA_DIR = UNIT_DATA;
    const secrets = await import(fileUrl(path.join(ROOT, 'src/secrets.mjs')));
    const db = await import(fileUrl(path.join(ROOT, 'src/db.mjs')));
    db.getDb();
    db.run("INSERT INTO users(username, password, email, level, package, created_at) VALUES('qa_sso','x','qa@example.test','user','default',?)", new Date().toISOString());
    const uid = Number(db.get("SELECT id FROM users WHERE username='qa_sso'").id);
    db.run("INSERT INTO databases(user_id, db_name, db_user, password, password_enc, size_mb, created_at) VALUES(?,?,?,?,?,?,?)",
      uid, 'qa_sso_db', 'qa_sso', 'x', secrets.encryptSecret('qa-db-password'), 0, new Date().toISOString());
    const token = secrets.ssoToken({ userId: uid, db: 'qa_sso_db', sessionToken: 'qa-session-token' });
    const first = secrets.consumeSsoToken(token, { sessionToken: 'qa-session-token' });
    const replay = secrets.consumeSsoToken(token, { sessionToken: 'qa-session-token' });
    const mismatchToken = secrets.ssoToken({ userId: uid, db: 'qa_sso_db', sessionToken: 'qa-session-token' });
    const mismatch = secrets.consumeSsoToken(mismatchToken, { sessionToken: 'another-session-token' });
    const afterMismatch = secrets.consumeSsoToken(mismatchToken, { sessionToken: 'qa-session-token' });
    const ok = first.ok === true && replay.ok === false && replay.code === 'reused'
      && mismatch.ok === false && mismatch.code === 'session_mismatch' && afterMismatch.ok === true;
    add('SEC-011-sso-replay', ok ? 'pass' : 'fail',
      `first=${first.ok} replay=${replay.code} mismatch=${mismatch.code} correctSessionAfterMismatch=${afterMismatch.ok}`,
      { first: { ok: first.ok }, replay, mismatch });
  } catch (e) { add('SEC-011-sso-replay', 'fail', `error: ${e.message}`); }

  /* SEC-020 support tokens + SEC-007 cookie flags: live header checks. */
  try {
    const l = await login('demouser', DEMO_PASS);
    const setCookie = l.res.setCookies.join(' | ');
    const flagsOk = /OA_SESSION=[^;]+;[\s\S]*HttpOnly/.test(setCookie) && /SameSite=Lax/.test(setCookie) && /Path=\//.test(setCookie);
    add('SEC-007-cookie-flags', flagsOk ? 'pass' : 'fail', `login cookies: ${setCookie.slice(0, 220)}`, { setCookie });
  } catch (e) { add('SEC-007-cookie-flags', 'fail', `error: ${e.message}`); }

  /* OA-031 upload limit: config is honored and no hidden 12 MB cap. */
  try {
    const filesPage = await demouser.req('/user/files');
    const configText = await admin.req('/admin/settings');
    const shown = `${filesPage.text} ${configText.text}`.includes(`${MAX_UPLOAD_MB} MB`) || `${filesPage.text} ${configText.text}`.includes(`${MAX_UPLOAD_MB}MB`);
    const size = 13 * 1024 * 1024;
    const bytes = Buffer.alloc(size, 0x41);
    const upload = await fetch(base + '/api/v1/files/upload', {
      method: 'POST',
      headers: { Authorization: basic('demouser', DEMO_PASS), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/home/demouser', name: 'qa-13mb.bin', data: bytes.toString('base64') }),
      redirect: 'manual',
    });
    const largeOk = upload.status === 200;
    // Declared Content-Length above the effective body cap must be refused early.
    const over = await new Promise((resolve) => {
      const soc = net.connect(Number(new URL(base).port), '127.0.0.1', () => {
        const auth = basic('demouser', DEMO_PASS);
        soc.write(`POST /api/v1/files/upload HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: ${auth}\r\nContent-Type: application/json\r\nContent-Length: ${Math.ceil(((MAX_UPLOAD_MB * 4 / 3) + 8) * 1024 * 1024)}\r\nConnection: close\r\n\r\n`);
      });
      let data = '';
      soc.setTimeout(5000, () => { soc.destroy(); resolve({ status: 0, data }); });
      soc.on('data', (c) => { data += c.toString(); });
      soc.on('end', () => resolve({ status: Number((/HTTP\/1\.[01] (\d+)/.exec(data) || [])[1] || 0), data }));
      soc.on('error', () => resolve({ status: 0, data }));
    });
    try { fs.rmSync(path.join(dataDir, 'homes', 'demouser', 'qa-13mb.bin'), { force: true }); } catch { /* ignore */ }
    const ok = shown && largeOk && over.status === 413;
    add('OA-031-upload-limit', ok ? 'pass' : 'fail',
      `ui/config shows ${MAX_UPLOAD_MB}MB=${shown}; 13MiB upload=${upload.status}; oversized declared body=${over.status} (expected 413)`,
      { overStatus: over.status, overHead: over.data.slice(0, 160) });
  } catch (e) { add('OA-031-upload-limit', 'fail', `error: ${e.message}`); }

  /* OA-032 backup job idempotency: concurrent double-run yields one operation. */
  try {
    const csrf = await admin.getCsrf('/admin/backup-center');
    const name = `QA idempotency ${Date.now()}`;
    await admin.req('/admin/backup-center/jobs', {
      method: 'POST',
      form: { _csrf: csrf, name, scope: 'server', schedule: 'daily', schedule_time: '03:00', timezone: 'UTC', retention_days: '7' },
    });
    const jobRow = dbGet(`SELECT id FROM backup_jobs WHERE name='${name.replace(/'/g, "''")}' ORDER BY id DESC LIMIT 1`);
    const jobId = jobRow?.rows?.[0]?.[0];
    if (!jobId) throw new Error('backup job was not created');
    const fire = () => admin.req(`/admin/backup-center/jobs/${jobId}/run`, { method: 'POST', form: { _csrf: csrf } });
    const [a, b] = await Promise.all([fire(), fire()]);
    const ops = dbGet(`SELECT COUNT(*) FROM operation_jobs WHERE target='backup-job:${jobId}' AND kind='backup.job.run'`);
    const count = Number(ops?.rows?.[0]?.[0] || 0);
    const opA = /operations\/(\d+)/.exec(a.location)?.[1];
    const opB = /operations\/(\d+)/.exec(b.location)?.[1];
    const ok = count === 1 && opA && opA === opB;
    add('OA-032-backup-idempotency', ok ? 'pass' : 'fail',
      `two concurrent run clicks -> operation jobs=${count}, ids=${opA}/${opB}`, { a: a.location, b: b.location, jobId });
  } catch (e) { add('OA-032-backup-idempotency', 'fail', `error: ${e.message}`); }

  /* SEC-006 module-level trusted-proxy chain walk. */
  try {
    const code = `const { clientIp } = await import(${JSON.stringify(fileUrl(path.join(ROOT, 'src/server.mjs')))});\n` +
      `const req = { socket: { remoteAddress: '203.0.113.5' }, headers: { 'x-forwarded-for': '198.51.100.7' } };\n` +
      `console.log(clientIp(req));`;
    const run = (env) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, ...env, OA_DATA_DIR: path.join(OUT, 'unit-data') }, encoding: 'utf8', timeout: 20000 });
    const plain = run({ OA_TRUSTED_PROXIES: '' });
    const trusted = run({ OA_TRUSTED_PROXIES: '203.0.113.5' });
    const other = run({ OA_TRUSTED_PROXIES: '10.0.0.1' });
    const ok = plain.stdout.trim() === '203.0.113.5' && trusted.stdout.trim() === '198.51.100.7' && other.stdout.trim() === '203.0.113.5';
    add('SEC-006-proxy-chain', ok ? 'pass' : 'fail',
      `untrusted=${plain.stdout.trim() || plain.stderr.trim().slice(0, 120)} trusted=${trusted.stdout.trim()} other=${other.stdout.trim()}`);
  } catch (e) { add('SEC-006-proxy-chain', 'fail', `error: ${e.message}`); }
}

async function createApiKeys(admin) {
  const page = await admin.req('/admin/api-keys');
  const csrf = /name="_csrf"\s+value="([^"]+)"/.exec(page.text)?.[1] || '';
  const ids = {};
  for (const m of page.text.matchAll(/<option value="(\d+)">([^<]+)<\/option>/g)) {
    const username = m[2].replace(/\s*\([^)]*\)\s*$/, '').trim();
    ids[username] = m[1];
  }
  if (!ids.demouser || !ids.demoreseller || !ids.admin) {
    const dbRows = dbGet("SELECT username, id FROM users WHERE username IN ('admin','demouser','demoreseller')");
    for (const row of dbRows?.rows || []) ids[row[0]] = row[1];
  }
  const make = async (username, label) => {
    const res = await admin.req('/admin/api-keys/create', {
      method: 'POST',
      form: { _csrf: csrf, user_id: ids[username], name: `${label}-${Date.now()}`, scopes: 'read', allowed_ips: '' },
    });
    const secret = /<pre class="code-block">([^<]+)<\/pre>/.exec(res.text)?.[1]?.trim();
    if (!secret) throw new Error(`API key for ${username} not created (HTTP ${res.status})`);
    return secret;
  };
  return { admin: await make('admin', 'qa-admin'), reseller: await make('demoreseller', 'qa-reseller'), user: await make('demouser', 'qa-user') };
}

/* -------------------------------------------------------------- counts */
async function countChecks(admin, reseller, user, qauserb) {
  const add = (id, status, detail, evidence = null) => {
    results.counts.push({ id, status, detail, evidence });
    record('counts', id, status, detail, evidence);
  };
  const textOf = async (session, pathname) => (await session.req(pathname)).text;
  const dbq = (sql) => dbGet(sql);

  const adminText = await textOf(admin, '/admin');
  const adminMatch = /<strong>(\d+)<\/strong>\s*u[żz]ytkownik[óo]w\s*·\s*<strong>(\d+)<\/strong>\s*reseller[óo]w\s*·\s*<strong>(\d+)<\/strong>\s*domen/i.exec(adminText)
    || /(\d+)\s*u[żz]ytkownik[óo]w.*?(\d+)\s*reseller[óo]w.*?(\d+)\s*domen/i.exec(adminText.replace(/<[^>]+>/g, ' '));
  const dbUsers = dbq("SELECT COUNT(*) FROM users WHERE level='user'");
  const dbResellers = dbq("SELECT COUNT(*) FROM users WHERE level='reseller'");
  const dbDomains = dbq('SELECT COUNT(*) FROM domains');
  if (adminMatch && dbUsers?.rows?.[0] && dbResellers?.rows?.[0] && dbDomains?.rows?.[0]) {
    const [du, dr, dd] = [Number(adminMatch[1]), Number(adminMatch[2]), Number(adminMatch[3])];
    const [eu, er, ed] = [Number(dbUsers.rows[0][0]), Number(dbResellers.rows[0][0]), Number(dbDomains.rows[0][0])];
    add('admin-dashboard-vs-db', du === eu && dr === er && dd === ed ? 'pass' : 'fail',
      `dashboard ${du}/${dr}/${dd} users/resellers/domains vs DB ${eu}/${er}/${ed}`, { dashboard: [du, dr, dd], db: [eu, er, ed] });
  } else {
    add('admin-dashboard-vs-db', 'skip', 'could not parse dashboard counters or DB unavailable');
  }

  const servicesDash = /(\d+)\/(\d+)\s*oczekiwanych us[łl]ug dzia[łl]a/i.exec(adminText)?.[0] || '';
  const servicesPage = await textOf(admin, '/admin/services');
  const servicesMatch = /(\d+)\s*z\s*(\d+)\s*oczekiwanych dzia[łl]a/i.exec(servicesPage.replace(/<[^>]+>/g, ' '));
  const dashNums = /(\d+)\/(\d+)/.exec(servicesDash);
  const okServices = !!(dashNums && servicesMatch && dashNums[1] === servicesMatch[1] && dashNums[2] === servicesMatch[2]);
  add('services-dashboard-vs-page', okServices ? 'pass' : 'fail',
    `dashboard "${servicesDash}" vs services page "${servicesMatch?.[0] || 'n/a'}"`, { servicesMatch: servicesMatch?.[0] });

  const resellerText = await textOf(reseller, '/reseller');
  const resMatch = /Zarz[ąa]dzasz\s*<strong>(\d+)<\/strong>[^<]*klient[^<]*<strong>(\d+)<\/strong>\s*domenami/i.exec(resellerText)
    || /Zarz[ąa]dzasz\s*(\d+)\s*klient[^0-9]*(\d+)\s*domenami/i.exec(resellerText.replace(/<[^>]+>/g, ' '));
  const dbClients = dbq("SELECT COUNT(*) FROM users WHERE level='user' AND owner='demoreseller'");
  const dbResDomains = dbq("SELECT COUNT(*) FROM domains WHERE user_id IN (SELECT id FROM users WHERE owner='demoreseller')");
  if (resMatch && dbClients?.rows?.[0] && dbResDomains?.rows?.[0]) {
    const [dc, dd] = [Number(resMatch[1]), Number(resMatch[2])];
    const [ec, ed] = [Number(dbClients.rows[0][0]), Number(dbResDomains.rows[0][0])];
    add('reseller-dashboard-vs-db', dc === ec && dd === ed ? 'pass' : 'fail', `dashboard ${dc} clients/${dd} domains vs DB ${ec}/${ed}`, { dashboard: [dc, dd], db: [ec, ed] });
  } else add('reseller-dashboard-vs-db', 'skip', 'could not parse reseller counters or DB unavailable');

  const userText = await textOf(user, '/user');
  const meter = (name) => {
    const re = new RegExp(`data-resource-meter="${name}"[\\s\\S]*?<span>(\\d+)\\s*\\/\\s*(\\d+)</span>`);
    const m = re.exec(userText);
    return m ? { used: Number(m[1]), limit: Number(m[2]) } : null;
  };
  const emailMeter = meter('email');
  const dbEmail = dbq("SELECT COUNT(*) FROM email_accounts WHERE domain IN (SELECT name FROM domains WHERE user_id=(SELECT id FROM users WHERE username='demouser'))");
  if (emailMeter && dbEmail?.rows?.[0]) {
    const dbn = Number(dbEmail.rows[0][0]);
    add('user-email-meter-vs-db', emailMeter.used === dbn ? 'pass' : 'fail', `meter ${emailMeter.used}/${emailMeter.limit} vs DB ${dbn}`, { meter: emailMeter, db: dbn });
  } else add('user-email-meter-vs-db', 'skip', 'email meter or DB unavailable');

  const dbMeter = meter('databases');
  const dbDatabases = dbq("SELECT COUNT(*) FROM databases WHERE user_id=(SELECT id FROM users WHERE username='demouser')");
  if (dbMeter && dbDatabases?.rows?.[0]) {
    const dbn = Number(dbDatabases.rows[0][0]);
    add('user-databases-meter-vs-db', dbMeter.used === dbn ? 'pass' : 'fail', `meter ${dbMeter.used}/${dbMeter.limit} vs DB ${dbn}`, { meter: dbMeter, db: dbn });
  } else add('user-databases-meter-vs-db', 'skip', 'databases meter or DB unavailable');

  const apiEmail = await api('demouser', DEMO_PASS, '/api/v1/email');
  const apiDomains = await api('demouser', DEMO_PASS, '/api/v1/domains');
  const dbEmailCount = dbq("SELECT COUNT(*) FROM email_accounts WHERE domain IN (SELECT name FROM domains WHERE user_id=(SELECT id FROM users WHERE username='demouser'))");
  const dbDomainCount = dbq("SELECT COUNT(*) FROM domains WHERE user_id=(SELECT id FROM users WHERE username='demouser')");
  const emailApi = apiEmail.json?.email?.length ?? -1;
  const domainsApi = apiDomains.json?.domains?.length ?? -1;
  const emailDb = Number(dbEmailCount?.rows?.[0]?.[0] ?? -1);
  const domainsDb = Number(dbDomainCount?.rows?.[0]?.[0] ?? -1);
  add('user-api-list-vs-db', emailApi === emailDb && domainsApi === domainsDb ? 'pass' : 'fail',
    `API email/domains ${emailApi}/${domainsApi} vs DB ${emailDb}/${domainsDb}`, { emailApi, domainsApi, emailDb, domainsDb });

  const appSb = await textOf(qauserb, '/user/app-catalog');
  const qaInstalled = /data-app-filter="installed"[\s\S]{0,300}?<span class="tab-count">(\d+)<\/span>/.exec(appSb)?.[1];
  const dbWp = Number(dbq("SELECT COUNT(*) FROM wordpress WHERE domain IN (SELECT name FROM domains WHERE user_id=(SELECT id FROM users WHERE username='qauserb'))")?.rows?.[0]?.[0] ?? -1);
  const dbNative = Number(dbq("SELECT COUNT(*) FROM app_installs WHERE user_id=(SELECT id FROM users WHERE username='qauserb')")?.rows?.[0]?.[0] ?? -1);
  const dbApps = dbWp + dbNative;
  const qaApps = Number(qaInstalled ?? -1);
  add('catalogue-counter-vs-db', qaApps === dbApps ? 'pass' : 'fail', `qauserb catalogue installed chip=${qaApps} vs DB=${dbApps}`, { qaApps, dbApps });
}

/* --------------------------------------------------------------- main */
async function main() {
  if (EXTERNAL_BASE) {
    results.meta.base = base;
    if (flag('data-dir')) dataDir = path.resolve(arg('data-dir'));
    results.meta.dataDir = dataDir;
    await waitFor(`${base}/login`);
    record('env', 'external-server', 'pass', `auditing ${base} (mutating checks use isolated accounts only)`);
  } else {
    await startServer();
  }
  results.meta.maxUploadMb = MAX_UPLOAD_MB;

  let axeSource = null;
  for (const candidate of AXE_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) {
      axeSource = fs.readFileSync(candidate, 'utf8');
      let version = 'unknown';
      try { version = JSON.parse(fs.readFileSync(path.join(path.dirname(candidate), 'package.json'), 'utf8')).version; } catch { /* ignore */ }
      results.meta.axe = { path: candidate, version };
      break;
    }
  }
  record('a11y', 'axe-core', axeSource ? 'pass' : 'warn', axeSource ? `axe-core ${results.meta.axe.version} loaded locally (no install)` : 'axe-core not found locally; using fallback checks');

  let browser = null;
  try {
    const adminLogin = await login(ADMIN_USER, adminPass);
    const resellerLogin = await login('demoreseller', DEMO_PASS);
    const userLogin = await login('demouser', DEMO_PASS);

    // OA-010: query, cookie and Accept-Language must all select PL/EN server-side.
    try { await loginLocaleChecks(); } catch (e) { record('i18n', 'login-locale', 'fail', `locale probe failed: ${e.message}`); }

    // Set up a second reseller/user/domain for A/B negative tests.
    let resellerB = { username: 'qaresellerb', password: 'QaResellerB!2026' };
    let userB = { username: 'qauserb', password: 'QaUserB!2026x' };
    let qauserbLogin = null;
    try {
      const csrf = await adminLogin.session.getCsrf('/admin/resellers/create');
      await adminLogin.session.req('/admin/resellers/create', {
        method: 'POST', form: { _csrf: csrf, username: resellerB.username, password: resellerB.password, email: 'qa-b@example.test', package: 'reseller_default', domain: 'qa-b.example' },
      });
      const csrf2 = await adminLogin.session.getCsrf('/admin/users/create');
      const created = await adminLogin.session.req('/admin/users/create', {
        method: 'POST', form: { _csrf: csrf2, username: userB.username, password: userB.password, email: 'qa-userb@example.test', package: 'default', owner: resellerB.username, domain: 'qa-b.example' },
      });
      resellerB = { ...resellerB, created: /created/i.test(created.location) };
      try { qauserbLogin = await login(userB.username, userB.password); } catch { /* may require password change */ }
      const bDomains = await api(resellerB.username, resellerB.password, '/api/v1/domains');
      record('setup', 'reseller-b', bDomains.json?.domains?.some((d) => d.name === 'qa-b.example') ? 'pass' : 'fail',
        `reseller B scope domains: ${(bDomains.json?.domains || []).map((d) => d.name).join(', ') || 'none'}`);
    } catch (e) {
      record('setup', 'reseller-b', 'fail', `could not create reseller B / user B: ${e.message}`);
    }

    if (SKIP_SECURITY) {
      record('security', 'all', 'skip', 'security checks skipped by flag');
    } else {
      await securityChecks(adminLogin.session, userLogin.session, resellerB, userB);
    }

    if (!SKIP_VISUAL) {
      browser = await new Browser().launch();
      const collectors = new Collectors(browser);
      if (CSP_SMOKE) {
        await cspSmoke(browser, collectors, adminLogin.session, userLogin.session);
        return;
      }
      // Explicit light theme: headless Chrome otherwise follows the host OS and
      // many route checks would silently audit dark mode. Dark mode is tested
      // separately below, so both themes have real evidence.
      await browser.emulateLight();
      await browser.setCookies([]);
      await browser.navigate(`${base}/login`, 1280, collectors);
      await browser.evaluate("localStorage.setItem('oa_theme','light')");
      const lightState = await browser.evaluate(`(() => {
        const bg = getComputedStyle(document.body).backgroundColor;
        const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(bg);
        const lum = m ? (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255 : null;
        return { mode: document.documentElement.dataset.mode || '', bg, lum };
      })()`);
      record('theme', 'light-mode', lightState.mode !== 'dark' && lightState.lum !== null && lightState.lum > 0.4 ? 'pass' : 'fail',
        `explicit light theme -> mode="${lightState.mode}" body=${lightState.bg}`, lightState);
      try { await browser.screenshot('light-login-1280'); } catch { /* ignore */ }
      // Logged-out login page.
      for (const width of [390, 1280]) {
        const collected = await browser.navigate(`${base}/login`, width, collectors);
        const page = await inspectPage(browser);
        results.routes.push({
          role: 'login', path: '/login', width, status: collected.status, consoleErrors: collected.consoleErrors,
          failedRequests: collected.failedRequests, overflow: page.overflow, duplicateIds: page.duplicateIds,
          labels: page.labels, forbidden: page.forbidden, headings: page.headings, ariaBroken: page.ariaBroken,
          identity: page.identity, context: page.context, title: page.title,
          issues: [
            ...(collected.status !== 200 ? [`status ${collected.status}`] : []),
            ...(page.overflow.scrollWidth > page.overflow.innerWidth + 1 ? ['overflow'] : []),
            ...(page.labels.missing ? [`${page.labels.missing} unlabeled control(s)`] : []),
            ...(page.forbidden.length ? ['forbidden text'] : []),
          ],
        });
        if (width === 1280) await browser.screenshot('login-1280');
        if (width === 390) await browser.screenshot('login-390');
        if (axeSource && width === 1280) {
          const violations = await runAxe(browser, axeSource);
          const serious = (violations || []).filter((v) => ['critical', 'serious'].includes(v.impact));
          const axeError = (violations || []).find((v) => v.id === 'axe-error');
          results.axe.push({ role: 'login', path: '/login', width, total: violations?.length || 0, serious: serious.length, error: axeError?.help || null, violations: serious.slice(0, 8) });
        }
      }

      await sweepRole(browser, collectors, 'admin', adminLogin.session, axeSource);
      await sweepRole(browser, collectors, 'reseller', resellerLogin.session, axeSource);
      await sweepRole(browser, collectors, 'user', userLogin.session, axeSource);

      // Key routes at the remaining widths.
      const extraWidths = WIDTHS.filter((w) => !WALK_WIDTHS.includes(w));
      for (const role of ['admin', 'reseller', 'user']) {
        const session = role === 'admin' ? adminLogin.session : role === 'reseller' ? resellerLogin.session : userLogin.session;
        await browser.setCookies(session.cookies);
        for (const width of extraWidths) {
          for (const pathname of CRITICAL[role]) {
            try {
              const collected = await browser.navigate(base + pathname, width, collectors);
              const page = await inspectPage(browser);
              results.routes.push({
                role, path: pathname, width, status: collected.status, consoleErrors: collected.consoleErrors,
                failedRequests: collected.failedRequests, overflow: page.overflow, duplicateIds: page.duplicateIds,
                labels: page.labels, forbidden: page.forbidden, headings: page.headings, ariaBroken: page.ariaBroken,
                identity: page.identity, context: page.context, title: page.title,
                issues: [
                  ...(collected.status >= 400 || collected.status === 0 ? [`status ${collected.status}`] : []),
                  ...(page.overflow.scrollWidth > page.overflow.innerWidth + 1 ? ['overflow'] : []),
                  ...(page.forbidden.length ? ['forbidden text'] : []),
                  ...(page.duplicateIds.length ? ['duplicate ids'] : []),
                ],
              });
            } catch (e) {
              results.routes.push({ role, path: pathname, width, status: 0, issues: [`navigation failed: ${e.message}`] });
            }
          }
        }
      }

      const appDbCount = (username) => {
        const wp = Number(dbGet(`SELECT COUNT(*) FROM wordpress WHERE domain IN (SELECT name FROM domains WHERE user_id=(SELECT id FROM users WHERE username='${username}'))`)?.rows?.[0]?.[0] ?? 0);
        const native = Number(dbGet(`SELECT COUNT(*) FROM app_installs WHERE user_id=(SELECT id FROM users WHERE username='${username}')`)?.rows?.[0]?.[0] ?? 0);
        return wp + native;
      };
      const demouserApps = appDbCount('demouser');
      const qaApps = qauserbLogin ? appDbCount('qauserb') : 0;
      if (qauserbLogin) {
        await catalogueCheck(browser, collectors, userLogin.session, 'demouser', demouserApps);
        await catalogueCheck(browser, collectors, qauserbLogin.session, 'qauserb', qaApps);
      } else {
        await catalogueCheck(browser, collectors, userLogin.session, 'demouser', demouserApps);
      }

      await contextCheck(browser, collectors, adminLogin.session, 'demouser', DEMO_PASS, dbGet);
      await templatesCheck(browser, collectors, adminLogin.session);
      await serviceCardCheck(browser, collectors, adminLogin.session);
      await themeContrastCheck(browser, collectors, adminLogin.session);
      await darkThemeCheck(browser, collectors, {
        admin: adminLogin.session, reseller: resellerLogin.session, user: userLogin.session,
      }, axeSource);

      // Fallback a11y checks (always run; axe supplements them).
      const a11yPages = results.routes.filter((r) => r.width === 1280 && r.labels);
      const missing = a11yPages.reduce((n, r) => n + (r.labels?.missing || 0), 0);
      const dup = a11yPages.reduce((n, r) => n + (r.duplicateIds?.length || 0), 0);
      const aria = a11yPages.reduce((n, r) => n + (r.ariaBroken?.length || 0), 0);
      record('a11y', 'form-labels', missing === 0 ? 'pass' : 'fail', `${missing} unlabeled/weakly labelled control(s) across ${a11yPages.length} audited pages`);
      record('a11y', 'duplicate-ids', dup === 0 ? 'pass' : 'fail', `${dup} duplicate id(s) across audited pages`);
      record('a11y', 'aria-references', aria === 0 ? 'pass' : 'fail', `${aria} broken aria-labelledby/describedby/controls reference(s)`);
      if (!axeSource) {
        await browser.setCookies(userLogin.session.cookies);
        await browser.navigate(`${base}/user`, 1280, collectors);
        const contrast = await browser.evaluate(FALLBACK_CONTRAST);
        record('a11y', 'contrast-fallback', contrast?.length ? 'fail' : 'pass', `${contrast?.length || 0} low-contrast text node(s) on /user`, { samples: contrast?.slice(0, 10) });
      }
      const serious = results.axe.reduce((n, r) => n + (r.serious || 0), 0);
      const axeErrors = results.axe.filter((r) => r.error);
      record('a11y', 'axe-serious', axeSource ? (serious ? 'fail' : 'pass') : 'skip',
        axeSource ? `${serious} serious/critical violation group(s) on ${results.axe.length} page(s)` : 'axe not available');
      record('a11y', 'axe-runtime', axeSource ? (axeErrors.length ? 'fail' : 'pass') : 'skip',
        axeSource ? `${axeErrors.length} page(s) failed to run axe` : 'axe not available', { errors: axeErrors.slice(0, 3) });

      await countChecks(adminLogin.session, resellerLogin.session, userLogin.session, qauserbLogin?.session || userLogin.session);
    } else {
      record('routes', 'all', 'skip', 'visual/browser checks skipped by flag');
    }

    // Aggregate route issues.
    const walked = results.routes.filter((r) => WIDTHS.includes(r.width));
    const badStatus = walked.filter((r) => r.status >= 400 || r.status === 0);
    const overflow = ResultsOverflow(walked);
    const consoleErr = [...new Set(walked.flatMap((r) => r.consoleErrors || []))];
    const failed5xx = walked.flatMap((r) => (r.failedRequests || []).filter((x) => x.status >= 500));
    const forbidden = walked.flatMap((r) => (r.forbidden || []).map((f) => ({ path: r.path, width: r.width, ...f })));
    record('routes', 'http-status', badStatus.length === 0 ? 'pass' : 'fail', `${badStatus.length}/${walked.length} route/width checks returned >=400`);
    record('layout', 'horizontal-overflow', overflow.length === 0 ? 'pass' : 'fail', `${overflow.length}/${walked.length} route/width combinations overflow horizontally`, { samples: overflow.slice(0, 10) });
    record('runtime', 'console-errors', consoleErr.length === 0 ? 'pass' : 'fail', `${consoleErr.length} unique JS console error(s)`, { samples: consoleErr.slice(0, 10) });
    record('runtime', 'failed-5xx', failed5xx.length === 0 ? 'pass' : 'fail', `${failed5xx.length} failed 5xx request(s)`);
    record('i18n', 'forbidden-texts', forbidden.length === 0 ? 'pass' : 'fail', `${forbidden.length} forbidden text occurrence(s)`, { samples: forbidden.slice(0, 10) });

    // Width coverage statement.
    const widthCoverage = {};
    for (const width of WIDTHS) widthCoverage[width] = results.routes.filter((r) => r.width === width).length;
    if (SKIP_VISUAL) record('layout', 'width-coverage', 'skip', 'visual checks skipped by flag');
    else record('layout', 'width-coverage', WIDTHS.every((w) => widthCoverage[w] > 0) ? 'pass' : 'fail', `audited routes per width: ${JSON.stringify(widthCoverage)}`, widthCoverage);
  } catch (e) {
    record('fatal', 'audit', 'fail', e.stack || e.message);
  } finally {
    try { await browser?.close(); } catch { /* ignore */ }
    stopServer();
  }
}

function ResultsOverflow(routes) {
  return routes.filter((r) => r.overflow && r.overflow.scrollWidth > r.overflow.innerWidth + 1)
    .map((r) => ({ role: r.role, path: r.path, width: r.width, scrollWidth: r.overflow.scrollWidth, innerWidth: r.overflow.innerWidth, offenders: r.overflow.offenders?.slice(0, 3) }));
}

function summarize() {
  const counts = { pass: 0, fail: 0, warn: 0, skip: 0 };
  for (const c of results.checks) counts[c.status] = (counts[c.status] || 0) + 1;
  const routeIssues = results.routes.filter((r) => (r.issues || []).length);
  results.summary = {
    ...counts,
    checks: results.checks.length,
    routes: results.routes.length,
    routesWithIssues: routeIssues.length,
    securityPass: results.security.filter((s) => s.status === 'pass').length,
    securityFail: results.security.filter((s) => s.status === 'fail').length,
    axePages: results.axe.length,
    countsPass: results.counts.filter((c) => c.status === 'pass').length,
    countsFail: results.counts.filter((c) => c.status === 'fail').length,
    screenshots: Object.keys(results.screenshots).length,
    durationMs: Date.now() - startedAt,
  };
  results.meta.durationMs = results.summary.durationMs;
  const report = path.join(OUT, 'results.json');
  fs.writeFileSync(report, JSON.stringify(results, null, 2));
  const md = [
    '# OpenAdmin QA final — automated run',
    '',
    `- Generated: ${results.meta.generatedAt}`,
    `- Base: ${results.meta.base}${results.meta.isolated ? ' (isolated demo server)' : ''}`,
    `- Node: ${results.meta.node}; Chrome: ${results.meta.chrome}`,
    `- axe-core: ${results.meta.axe ? `${results.meta.axe.version} (${results.meta.axe.path})` : 'not found'}`,
    `- Duration: ${(results.summary.durationMs / 1000).toFixed(1)}s`,
    '',
    '## Check matrix',
    '',
    '| Area | Check | Status | Detail |',
    '|---|---|---|---|',
    ...results.checks.map((c) => `| ${c.area} | ${c.id} | ${c.status.toUpperCase()} | ${String(c.detail).replace(/\|/g, '\\|').slice(0, 220)} |`),
    '',
    '## Security checks',
    '',
    '| Check | Status | Detail |',
    '|---|---|---|',
    ...results.security.map((s) => `| ${s.id} | ${s.status.toUpperCase()} | ${String(s.detail).replace(/\|/g, '\\|').slice(0, 240)} |`),
    '',
    '## Routes with issues',
    '',
    ...routeIssues.slice(0, 200).map((r) => `- ${r.role} ${r.path} @${r.width}px: ${(r.issues || []).join('; ')}`),
    '',
    '## Screenshots',
    '',
    ...Object.entries(results.screenshots).map(([name, file]) => `- ${name}: ${file}`),
    '',
    '## Counts',
    '',
    ...results.counts.map((c) => `- ${c.id}: ${c.status.toUpperCase()} — ${c.detail}`),
    '',
    '## Axe violations',
    '',
    ...results.axe.map((a) => `- ${a.role} ${a.path}: ${a.serious} serious (${a.total} total)`),
    '',
  ];
  fs.writeFileSync(path.join(OUT, 'report.md'), md.join('\n'));
  results.artifacts = { results: report, report: path.join(OUT, 'report.md'), shots: SHOTS, serverLog: path.join(OUT, 'logs', 'server.log') };
  console.log('\n=== QA FINAL SUMMARY ===');
  console.log(JSON.stringify(results.summary, null, 2));
  console.log(`Evidence: ${report}`);
  console.log(`Report:   ${path.join(OUT, 'report.md')}`);
  console.log(`Shots:    ${SHOTS}`);
}

try {
  await main();
} catch (e) {
  record('fatal', 'main', 'fail', e.stack || e.message);
  try { stopServer(); } catch { /* ignore */ }
} finally {
  summarize();
  process.exit(results.summary.fail ? 1 : 0);
}
