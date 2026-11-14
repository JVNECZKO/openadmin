#!/usr/bin/env node
// OpenAdmin HTTP server: sessions, routing, static assets, API dispatch.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ROOT, ensureDataDir, VERSION } from './config.mjs';
import { getDb, seedBase, seedDemo, setting, closeDb } from './db.mjs';
import { Router } from './router.mjs';
import { getSession, serializeCookie, clearCookie, cookieName, capabilities, requireLevel } from './auth.mjs';
import { parseCookies, parseForm, LEVELS } from './util.mjs';
import { sendHtml, sendJson, redirect } from './ui/respond.mjs';
import { renderLogin, renderError } from './ui/layout.mjs';
import { registerAuthRoutes } from './routes/auth.mjs';
import { register as registerMailConfig } from './features/mailconfig.mjs';
import { registerUserRoutes } from './routes/user.mjs';
import { registerResellerRoutes } from './routes/reseller.mjs';
import { registerAdminRoutes } from './routes/admin.mjs';
import { registerApiRoutes } from './routes/api.mjs';
import { registerLegacy } from './routes/legacy.mjs';
import { registerCompat } from './routes/compat.mjs';
import { register as registerWebmail } from './features/webmail.mjs';
import { APPS, status as appStatus, proxy as proxyApp, ensureStarted } from './apps.mjs';
import { collectUsage } from './usage.mjs';
import { formatCidr, ipMatches, normalizeIp } from './apikeys.mjs';
import { enforceAll } from './quota.mjs';
import { startScheduler } from './scheduler.mjs';
import { startImap, stopImap } from './imap.mjs';
import { syncMail } from './mail.mjs';
import { syncMaildirs } from './maildir.mjs';

const router = new Router();
const MIME = {
  '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.map': 'application/json',
};

/* ------------------------------------------------ trusted reverse proxies --
 * X-Forwarded-For is attacker-controlled unless the socket peer is an explicit
 * trusted proxy.  OA_TRUSTED_PROXIES is a comma-separated list of IPs/CIDRs;
 * the chain is walked from right to left and the first untrusted hop wins.
 */
const trustedProxies = (() => {
  const raw = String(process.env.OA_TRUSTED_PROXIES || '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const valid = [];
  for (const entry of raw) {
    const normalized = formatCidr(entry);
    if (normalized) valid.push(normalized);
    else console.warn(`[openadmin] ignoring invalid OA_TRUSTED_PROXIES entry: ${entry.slice(0, 64)}`);
  }
  return valid;
})();

function socketIp(req) {
  return normalizeIp(req.socket?.remoteAddress || '');
}

export function clientIp(req) {
  const socket = socketIp(req);
  const forwarded = req.headers?.['x-forwarded-for'];
  if (!trustedProxies.length || !socket || !trustedProxies.some((proxy) => ipMatches(socket, proxy))) return socket;
  if (!forwarded) return socket;
  const chain = String(forwarded).split(',').map((entry) => normalizeIp(entry.trim())).filter(Boolean);
  if (!chain.length) return socket;
  // Malformed hops cannot be attributed safely; fall back to the socket peer
  // instead of feeding an attacker-controlled string into audit/rate limits.
  if (chain.some((hop) => !formatCidr(hop))) return socket;
  const hops = [...chain, socket];
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    if (!trustedProxies.some((proxy) => ipMatches(hops[i], proxy))) return hops[i];
  }
  return hops[0] || socket;
}

const JSON_UPLOAD_BODY_LIMIT = Math.ceil(config.limits.maxUploadMb * 1024 * 1024 * 4 / 3) + 256 * 1024;
const BODY_LIMIT = Math.max(12 * 1024 * 1024, JSON_UPLOAD_BODY_LIMIT);

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared && declared > limit) {
      req.resume();
      reject(Object.assign(new Error(`Payload too large: ${declared} bytes exceeds ${limit} bytes`), { status: 413, code: 'payload_too_large' }));
      return;
    }
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        reject(Object.assign(new Error(`Payload too large: ${size} bytes exceeds ${limit} bytes`), { status: 413, code: 'payload_too_large' }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  const rel = pathname.replace(/^\/assets\//, '').replace(/\.\./g, '');
  const file = path.join(ROOT, 'src', 'public', rel);
  if (!file.startsWith(path.join(ROOT, 'src', 'public'))) return sendHtml(res, 'Not found', 404);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return sendHtml(res, 'Not found', 404);
  const ext = path.extname(file).toLowerCase();
  const buf = fs.readFileSync(file);
  const etag = `W/"${buf.length}-${fs.statSync(file).mtimeMs.toString(36)}"`;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': buf.length,
    'Cache-Control': ext === '.js' || ext === '.css' ? 'public, max-age=300' : 'public, max-age=3600',
    ETag: etag,
  });
  res.end(buf);
}

function trustedPeer(req) {
  const socket = socketIp(req);
  return !!socket && trustedProxies.some((proxy) => ipMatches(socket, proxy));
}

/** HTTPS detection for cookies/HSTS; forwarded proto is only trusted from a configured proxy. */
export function isSecureRequest(req) {
  if (req?.socket?.encrypted) return true;
  if (config.https) return true;
  if (!trustedPeer(req)) return false;
  const proto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

export function securityHeaders(res, req) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'");
  res.setHeader('Server', 'OpenAdmin');
  // SEC-013: never advertise the framework; HSTS only after HTTPS is confirmed.
  res.removeHeader?.('X-Powered-By');
  if (isSecureRequest(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

export async function handle(req, res) {
  const started = Date.now();
  securityHeaders(res, req);

  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { return sendHtml(res, 'Bad request', 400); }
  // SEC-023 / SEC-020: never leak reset or support tokens through Referer.
  if (url.pathname.startsWith('/reset-password') || url.pathname.startsWith('/lost-password') || url.pathname.startsWith('/support/')) {
    res.setHeader('Referrer-Policy', 'no-referrer');
  }

  const pathname = decodeURIComponent(url.pathname);
  const query = Object.fromEntries(url.searchParams.entries());
  const ip = clientIp(req);

  try {
    if (pathname.startsWith('/assets/')) return await serveStatic(req, res, pathname);
    if (pathname === '/favicon.ico' || pathname === '/favicon.svg') return await serveStatic(req, res, '/assets/favicon.svg');
    // Public liveness probe: no uptime/topology. The version stays for the
    // documented installer compatibility contract (see tests/smoke.test.mjs).
    if (pathname === '/healthz') return sendJson(res, { ok: true, version: VERSION });

    const cookies = parseCookies(req.headers.cookie || '');
    let session = null;
    let user = null;
    const token = cookies[cookieName()];
    if (token) {
      const found = getSession(token);
      if (found) { session = found.session; user = found.user; }
      else res.setHeader('Set-Cookie', clearCookie());
    }

    // SEC-012: bundled PHP applications are only reachable after the panel
    // session gate. The proxy also strips internal/hop-by-hop headers and sets
    // the external Host/X-Forwarded-* values before talking to loopback.
    const proxyAppId = (pathname === '/phpmyadmin' || pathname.startsWith('/phpmyadmin/')) ? 'phpmyadmin'
      : (pathname === '/roundcube' || pathname.startsWith('/roundcube/')) ? 'roundcube'
        : null;
    if (proxyAppId) {
      if (!user) {
        const next = encodeURIComponent(req.url || pathname);
        return redirect(res, `/login?next=${next}`);
      }
      if (APPS[proxyAppId] && appStatus(proxyAppId).running) return proxyApp(req, res, proxyAppId);
    }

    let body = {};
    let rawBody = null;
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') {
      rawBody = await readBody(req);
      const ct = String(req.headers['content-type'] || '');
      if (ct.includes('application/json')) {
        try { body = JSON.parse(rawBody.toString('utf8') || '{}'); } catch { body = {}; }
      } else if (ct.includes('multipart/form-data')) {
        body = { _raw: rawBody.toString('latin1') };
      } else if (ct.includes('xml')) {
        body = { _raw: rawBody.toString('utf8') };
      } else {
        body = parseForm(rawBody.toString('utf8'));
      }
    }

    const levelFromPath = pathname.startsWith('/admin') ? 'admin' : pathname.startsWith('/reseller') ? 'reseller' : 'user';
    const isApi = pathname.startsWith('/api/') || pathname.startsWith('/CMD_') || pathname === '/webdisk' || pathname.startsWith('/webdisk/');

    const ctx = {
      req, res, url, path: pathname, query, params: {}, body, rawBody,
      session, user, csrf: session?.csrf || '',
      ip, started, level: levelFromPath, isApi, cookies,
      caps: user ? capabilities(user) : {},
      flash: (msg, type = 'ok') => redirect(res, pathname, { flash: msg, type }),
      json: (data, status = 200) => sendJson(res, data, status),
      html: (markup, status = 200) => sendHtml(res, markup, status),
      redirect: (loc, opts) => redirect(res, loc, opts),
      page: null,
    };

    // Global panel ACL: read-only applies to non-admin roles.
    if (!isApi && user && req.method !== 'GET' && user.level !== 'admin') {
      try {
        const acl = JSON.parse(setting('panel_acl', '{}') || '{}');
        if (acl.read_only) return sendHtml(res, renderError({ code: 403, title: 'Panel is read-only', message: 'Administrator włączył tryb tylko do odczytu.', user, level: levelFromPath }), 403);
      } catch { /* ignore */ }
    }

    // Support sessions are read-only.
    if (session?.support && req.method !== 'GET' && pathname !== '/logout') {
      return sendHtml(res, renderError({ code: 403, title: 'Support access is read-only', message: 'Ten link nie pozwala zmieniać konfiguracji.', user, level: levelFromPath }), 403);
    }

    // CSRF protection for browser form posts (API uses per-request credentials).
    if (!isApi && req.method === 'POST' && session && pathname !== '/reset-password') {
      const provided = body._csrf || req.headers['x-csrf-token'];
      const { checkCsrf } = await import('./auth.mjs');
      if (!checkCsrf(session, provided) && !pathname.startsWith('/api/')) {
        return sendHtml(res, renderError({ code: 403, title: 'Invalid security token', message: 'Reload the page and try again.', user, level: levelFromPath }), 403);
      }
    }

    // Access control by URL prefix.
    if (pathname.startsWith('/admin') && !isApi) {
      if (!user) return redirect(res, `/login?next=${encodeURIComponent(pathname)}`);
      if (!requireLevel(user, 'admin')) return sendHtml(res, renderError({ code: 403, title: 'Administrator access required', message: 'Your account does not have administrator privileges.', user, level: 'user' }), 403);
    } else if (pathname.startsWith('/reseller') && !isApi) {
      if (!user) return redirect(res, `/login?next=${encodeURIComponent(pathname)}`);
      if (!requireLevel(user, 'reseller')) return sendHtml(res, renderError({ code: 403, title: 'Reseller access required', message: 'Your account does not have reseller privileges.', user, level: 'user' }), 403);
    } else if (pathname.startsWith('/user') && !isApi) {
      if (!user) return redirect(res, `/login?next=${encodeURIComponent(pathname)}`);
    } else if (pathname.startsWith('/compat') && !isApi) {
      if (!user) return redirect(res, `/login?next=${encodeURIComponent(pathname)}`);
    }

    const matched = router.match(req.method, pathname);
    if (!matched) {
      if (isApi) return sendJson(res, { error: 1, text: 'Unknown API command', details: '' }, 404);
      if (!user) return sendHtml(res, renderLogin({ csrf: '', error: '', serverName: setting('server_name', config.defaults.serverName), demo: config.demo || setting('demo_mode') === '1' }));
      return sendHtml(res, renderError({ code: 404, title: 'Page not found', message: `No page exists at ${pathname}.`, user, level: levelFromPath }), 404);
    }

    ctx.params = matched.params;
    const out = await matched.route.handler(ctx);

    // Handlers may stream the response themselves (file/backup downloads).
    if (out && out.handled) return;
    // Handlers may return a response object instead of writing directly.
    if (out && !res.writableEnded) {
      if (typeof out === 'string') return sendHtml(res, out, 200);
      if (out.__raw) return sendHtml(res, out, out.status || 200);
      if (out.json !== undefined) return sendJson(res, out.json, out.status || 200);
      if (out.raw !== undefined) {
        res.writeHead(out.status || 200, {
          'Content-Type': out.type === 'form' ? 'application/x-www-form-urlencoded; charset=utf-8' : 'text/plain; charset=utf-8',
          'Content-Length': Buffer.byteLength(out.raw),
          'Cache-Control': 'no-store',
        });
        return res.end(out.raw);
      }
      if (out.redirect) return redirect(res, out.redirect, out);
      if (out.html) return sendHtml(res, out.html, out.status || 200);
    }
    if (!res.writableEnded) sendHtml(res, 'OK');
  } catch (err) {
    const status = err.status || 500;
    console.error(`[openadmin] ${req.method} ${pathname} -> ${status}:`, err.message);
    if (process.env.OA_DEBUG) console.error(err.stack);
    if (String(req.url).startsWith('/api/') || String(req.url).startsWith('/CMD_')) {
      return sendJson(res, { error: 1, text: err.message, details: err.stack?.split('\n').slice(0, 3).join(' | ') || '' }, status);
    }
    if (!res.writableEnded) {
      sendHtml(res, renderError({ code: status, title: 'Something went wrong', message: config.demo ? String(err.message) : 'The request could not be completed. Check the server log for details.' }), status);
    }
  } finally {
    const ms = Date.now() - started;
    if (ms > 1500) console.warn(`[openadmin] slow ${req.method} ${pathname} ${ms}ms`);
  }
}

export function bootstrap({ quiet = false } = {}) {
  ensureDataDir();
  getDb();
  const seeded = seedBase({
    adminUser: config.defaults.adminUser,
    adminPassword: config.defaults.adminPassword,
    serverName: config.defaults.serverName,
    serverIp: config.defaults.serverIp,
    ns1: config.defaults.nameserver1,
    ns2: config.defaults.nameserver2,
  });
  if (config.demo) {
    seedDemo();
  }
  try { ensureStarted(); } catch (e) { console.warn('[openadmin] web apps:', e.message); }
  try { syncMail(); } catch (e) { console.warn('[openadmin] mail:', e.message); }
  try { syncMaildirs(); } catch (e) { console.warn('[openadmin] maildir:', e.message); }
  try { startScheduler(); } catch (e) { console.warn('[openadmin] scheduler:', e.message); }
  try {
    if (setting('demo_mode', '0') !== '1') { collectUsage(); enforceAll(); }
    try { syncMaildirs(); } catch { /* ignore */ }
    const timer = setInterval(() => { try { collectUsage(); } catch (e) { console.warn('[openadmin] usage:', e.message); } }, 15 * 60 * 1000);
    timer.unref();
  } catch (e) { console.warn('[openadmin] usage:', e.message); }
  if (!quiet) {
    if (seeded.created) {
      console.log(`\n  OpenAdmin installed.\n  Admin user: ${config.defaults.adminUser}`);
      if (!config.defaults.adminPassword) {
        console.log(`  Temporary password: ${seeded.password}`);
        console.log('  (change it after signing in)\n');
      }
    } else {
      console.log('  OpenAdmin database ready.');
    }
  }
  return seeded;
}

export function createApp() {
  registerAuthRoutes(router);
  registerUserRoutes(router);
  registerResellerRoutes(router);
  registerAdminRoutes(router);
  registerApiRoutes(router);
  registerLegacy(router);
  registerCompat(router);
  registerWebmail(router);
  registerMailConfig(router);
  return router;
}

let server = null;

export function start() {
  bootstrap({ quiet: false });
  createApp();
  const handler = (req, res) => { handle(req, res).catch((e) => { console.error(e); try { res.end('Internal error'); } catch { /* ignore */ } }); };
  const secure = config.https && config.certFile && config.keyFile;
  server = secure
    ? https.createServer({ cert: fs.readFileSync(config.certFile), key: fs.readFileSync(config.keyFile) }, handler)
    : http.createServer(handler);

  try { startImap(); } catch (e) { console.warn('[openadmin] IMAP:', e.message); }
  server.listen(config.port, config.host, () => {
    const scheme = secure ? 'https' : 'http';
    const host = config.host === '0.0.0.0' ? 'localhost' : config.host;
    console.log(`\n  OpenAdmin v${VERSION} listening on ${scheme}://${host}:${config.port}`);
    console.log(`  Provider: ${config.provider} · Demo: ${config.demo ? 'on' : 'off'} · License: unlimited (free)\n`);
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`Port ${config.port} is already in use. Set OA_PORT to another port.`);
    else console.error(e);
    process.exit(1);
  });
  const shutdown = () => {
    console.log('\n  Shutting down…');
    stopImap();
    server.close(() => { closeDb(); process.exit(0); });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) start();
