// DirectAdmin URL compatibility layer.
//
// Registers the canonical Evolution routes extracted from the frontend bundle
// (src/compat/manifest.json), dispatches each one to the OpenAdmin page that
// performs the same task, serves the 110 historical CMD_* URLs as redirects to
// those canonical routes, and exposes every CMD_API_* name.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.mjs';
import { get, all } from '../db.mjs';
import { html as h } from '../util.mjs';
import { renderPage } from '../ui/layout.mjs';
import { ROUTE_TARGETS, PARAM_ROUTES } from '../compat/map.mjs';
import { register as registerCompatPages } from '../features/compat.mjs';

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'compat', 'manifest.json'), 'utf8'));
const commandList = fs.readFileSync(path.join(ROOT, 'docs', 'directadmin-commands.txt'), 'utf8')
  .split(/\s+/).filter((c) => c.startsWith('CMD_'));
const LEVELS = { user: 1, reseller: 2, admin: 3 };

function denied(ctx, level) {
  return {
    status: 403,
    html: renderPage({
      title: 'Access denied', subtitle: '', csrf: ctx.session?.csrf || '',
      user: ctx.user, level: ctx.user?.level || 'user', caps: {}, active: ctx.path,
      body: h`<div class="empty"><h2>${level} access required</h2>
        <p>This DirectAdmin page is not available to your account level.</p>
        <a class="btn btn-secondary" href="/${ctx.user?.level || 'user'}">Back to dashboard</a></div>`,
    }),
  };
}

export function registerCompat(router) {
  registerCompatPages(router);

  const dispatch = (ctx, target, title, params = {}) => {
    if (!ctx.user) return ctx.redirect(`/login?next=${encodeURIComponent(ctx.path)}`);
    const level = target.startsWith('/admin') ? 'admin' : target.startsWith('/reseller') ? 'reseller' : 'user';
    if ((LEVELS[ctx.user.level] || 0) < LEVELS[level]) return denied(ctx, level);
    const matched = router.match('GET', target);
    if (!matched) {
      return {
        status: 404,
        html: renderPage({
          title, subtitle: '', csrf: ctx.session?.csrf || '', user: ctx.user, level,
          caps: {}, active: ctx.path,
          body: h`<div class="empty"><h2>${title}</h2><p>This page has no handler yet.</p>
            <a class="btn btn-secondary" href="/${ctx.user.level}">Back to dashboard</a></div>`,
        }),
      };
    }
    ctx.compatTitle = title;
    ctx.level = level;
    return matched.route.handler({ ...ctx, path: target, params: { ...params, ...matched.params } });
  };

  /* ------------------------------------------------- canonical DA routes */
  const registered = new Set();
  for (const route of manifest) {
    const url = route.url;
    if (!url.startsWith('/') || url.includes(':') || url === '/') continue;
    if (registered.has(url)) continue;
    if (router.match('GET', url)) continue; // a native OpenAdmin route already lives here
    const target = ROUTE_TARGETS[url];
    if (!target) continue;
    const title = route.title || url;
    registered.add(url);
    router.get(url, (ctx) => dispatch(ctx, target, title));
  }

  /* ------------------------------------------------ optional-parameter routes */
  for (const { pattern, target, title } of PARAM_ROUTES) {
    router.get(pattern.replace(':tab', ':tab'), (ctx) => dispatch(ctx, target, title, ctx.params));
    router.get(pattern.replace(/\/:tab$/, '').replace(/\/:database$/, ''), (ctx) => dispatch(ctx, target, title));
  }

  /* --------------------------------------------------------- CMD_* redirects */
  const legacy = new Map();
  for (const route of manifest) {
    for (const cmd of route.legacy || []) {
      if (!legacy.has(cmd)) legacy.set(cmd, route.url);
    }
    for (const cmd of route.commands || []) {
      if (!legacy.has(cmd) && route.url.startsWith('/')) legacy.set(cmd, route.url);
    }
  }
  const fallback = (cmd) => {
    if (/^CMD_API_/.test(cmd)) return null;
    if (/(ADMIN|SYSTEM|SERVICE|PROCESS|LOG|LICENSE|IP_MANAGER|REBOOT|CUSTOMBUILD|PACKAGE)/.test(cmd)) return '/admin';
    if (/(RESELLER|ALL_USER|MOVE_USERS|ACCOUNT_USER|MANAGE_USER)/.test(cmd)) return '/reseller/users';
    if (/(EMAIL|POP|FORWARD|AUTORESPOND|VACATION|CATCH|SPAM)/.test(cmd)) return '/user/email/accounts';
    if (/(DNS|DOMAIN|SUBDOMAIN|POINTER|REDIRECT)/.test(cmd)) return '/user/domains';
    if (/(DB|DATABASE)/.test(cmd)) return '/user/database';
    if (/(FILE|FTP)/.test(cmd)) return '/user/filemanager';
    if (/(BACKUP)/.test(cmd)) return '/user-backups';
    if (/(SSL|TLS)/.test(cmd)) return '/user/ssl';
    if (/(TICKET)/.test(cmd)) return '/user/tickets';
    return '/user';
  };

  const allCommands = [...new Set([...commandList, ...legacy.keys()])];
  for (const cmd of allCommands) {
    if (cmd.startsWith('CMD_API_')) continue;
    const target = legacy.get(cmd) || fallback(cmd);
    if (!target) continue;
    const handler = (ctx) => {
      if (!ctx.user) return ctx.redirect(`/login?next=${encodeURIComponent(ctx.path)}`);
      const url = new URL(`http://x${target}`);
      for (const [k, v] of Object.entries(ctx.query)) if (k !== 'flash' && k !== 'type') url.searchParams.set(k, v);
      return ctx.redirect(url.pathname + (url.search ? url.search : ''));
    };
    router.get('/' + cmd, handler);
    router.post('/' + cmd, handler);
  }
}

export function compatSummary() {
  return {
    routes: manifest.length,
    titled: manifest.filter((r) => r.title).length,
    mapped: manifest.filter((r) => ROUTE_TARGETS[r.url]).length,
    commands: new Set(manifest.flatMap((r) => r.commands)).size,
    legacy: new Set(manifest.flatMap((r) => r.legacy)).size,
  };
}

void get; void all;
