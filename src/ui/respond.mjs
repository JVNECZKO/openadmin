// Response helpers shared by route modules.
import crypto from 'node:crypto';
import { html as h, raw } from '../util.mjs';
import { renderPage } from './layout.mjs';
import { navFor } from './nav.mjs';
import { enhanceFormA11y } from './a11y.mjs';

export function sendHtml(res, markup, status = 200) {
  const rawBody = markup && markup.__raw ? markup.value : String(markup ?? '');
  const nonce = crypto.randomBytes(18).toString('base64');
  let body = enhanceFormA11y(rawBody);
  body = body.replace(/<script\b(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`);
  res.setHeader('Content-Security-Policy', `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'`);
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendJson(res, data, status = 200, headers = {}) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function redirect(res, location, { flash, type = 'ok' } = {}) {
  let url = location;
  if (flash) {
    const u = new URL(location, 'http://x');
    u.searchParams.set('flash', flash);
    u.searchParams.set('type', type);
    url = u.pathname + '?' + u.searchParams.toString();
  }
  res.writeHead(302, { Location: url, 'Cache-Control': 'no-store' });
  res.end();
}

export function flashMessage(ctx) {
  const f = ctx.query.flash;
  if (!f) return null;
  return { message: String(f).slice(0, 300), type: ctx.query.type === 'error' ? 'error' : 'ok' };
}

export function searchIndexFor(level, caps, user) {
  const groups = navFor(level, caps, { admin: user.level === 'admin', reseller: user.level !== 'user' });
  const out = [];
  for (const g of groups) for (const i of g.items) out.push({ label: i.label, href: i.href, icon: i.icon, group: g.title });
  return out;
}

/** Standard full page render used by every authenticated page. */
export function page(ctx, { title, subtitle = '', body, actions = [], wide = false, counts = null, storage = null, active = '' }) {
  return renderPage({
    title: ctx.compatTitle || title, subtitle, body: body ? (body.__raw ? body : raw(String(body))) : '',
    user: ctx.user, level: ctx.level, caps: ctx.caps, active: active || ctx.path,
    csrf: ctx.session?.csrf || '', flash: flashMessage(ctx), actions,
    counts, storage, wide, searchIndex: searchIndexFor(ctx.level, ctx.caps, ctx.user),
  });
}

export function notFound(ctx, message = '') {
  const pl = (ctx.user?.language || 'pl') !== 'en';
  return { status: 404, html: h`<div class="empty"><p>${message || (pl ? 'Nie znaleziono strony' : 'Page not found')}</p><a class="btn btn-secondary" href="/${ctx.level}">${pl ? 'Wróć do pulpitu' : 'Back to dashboard'}</a></div>` };
}
