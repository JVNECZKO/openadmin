// Authentication, login/logout, help and public pages.
import { config, VERSION } from '../config.mjs';
import crypto from 'node:crypto';
import { setting, run, audit, get, all, verifyPassword, hashPassword, nowIso } from '../db.mjs';
import { requestPasswordReset, verifyResetToken, consumeResetToken } from '../passwordreset.mjs';
import { verifyTotp } from '../twofa.mjs';
import { login, createSession, destroySession, findUser } from '../auth.mjs';
import { serializeCookie, clearCookie } from '../auth.mjs';
import { renderLogin } from '../ui/layout.mjs';
import { page } from '../ui/respond.mjs';
import { html as h, raw, e, isEmail } from '../util.mjs';
import { card, form, alert, btn, kvList } from '../ui/components.mjs';
import { icon as ic } from '../ui/icons.mjs';

export function registerAuthRoutes(router) {
  router.get('/', (ctx) => {
    if (!ctx.user) return ctx.redirect('/login');
    return ctx.redirect('/' + ctx.user.level);
  });

  router.get('/login', (ctx) => {
    if (ctx.user) return ctx.redirect('/' + ctx.user.level);
    const next = ctx.query.next ? decodeURIComponent(ctx.query.next) : '';
    const markup = renderLogin({
      csrf: ctx.session?.csrf || '',
      serverName: setting('server_name', config.defaults.serverName),
      demo: config.demo || setting('demo_mode') === '1',
      message: next,
      notice: ctx.query.expired ? 'Your session expired. Please sign in again.' : '',
      error: ctx.query.error || '',
    });
    return { status: 200, html: markup };
  });

  router.post('/login', (ctx) => {
    const { username = '', password = '', redirect: next = '' } = ctx.body;
    const result = login(String(username).trim(), String(password), { ip: ctx.ip, ua: ctx.req.headers['user-agent'] });
    if (!result.ok) {
      const markup = renderLogin({
        csrf: '', serverName: setting('server_name', config.defaults.serverName),
        demo: config.demo || setting('demo_mode') === '1', error: result.error, message: String(next),
      });
      return { status: 401, html: markup };
    }
    if (result.user.twofa_enabled) {
      const pending = crypto.randomBytes(24).toString('hex');
      run('INSERT INTO twofa_pending(token, user_id, expires_at) VALUES(?,?,?)', pending, result.user.id,
        new Date(Date.now() + 5 * 60 * 1000).toISOString());
      ctx.res.setHeader('Set-Cookie', `OA_2FA=${pending}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300`);
      return ctx.redirect('/login/2fa');
    }
    const s = createSession(result.user, { ip: ctx.ip, ua: ctx.req.headers['user-agent'] });
    audit(result.user.username, result.user.level, 'login', '', ctx.ip);
    ctx.res.setHeader('Set-Cookie', serializeCookie(s.token, { secure: config.https }));
    let target = '/' + result.user.level;
    if (next && String(next).startsWith('/') && !String(next).startsWith('//')) target = String(next);
    if (result.user.level === 'admin' && config.provider === 'linux' && setting('setup_complete', '0') !== '1') target = '/admin/setup';
    else if (result.user.must_change_password) target = '/user/password?force=1';
    return ctx.redirect(target);
  });

  const twofaPage = (error = '') => h`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Two-factor authentication · OpenAdmin</title><link rel="stylesheet" href="/assets/app.css?v=${VERSION}"></head>
<body class="login-body"><div class="wm-login"><div class="wm-login-card">
  <h1>Two-factor authentication</h1>
  <p class="small muted">Enter the 6-digit code from your authenticator app, or a recovery code.</p>
  ${error ? h`<div class="alert alert-danger">${error}</div>` : ''}
  <form method="post" action="/login/2fa" class="oa-form">
    <div class="field"><label class="field-label">Authentication code</label><input name="code" autocomplete="one-time-code" inputmode="numeric" required autofocus placeholder="123456"></div>
    <div class="form-actions"><button class="btn btn-primary btn-block" type="submit">Verify</button></div>
  </form>
  <p class="small muted mt-18"><a class="link" href="/login">Back to sign in</a></p>
</div></div></body></html>`;

  router.get('/login/2fa', (ctx) => {
    run("DELETE FROM twofa_pending WHERE expires_at < ?", nowIso());
    const pending = ctx.cookies.OA_2FA;
    const row = pending ? get('SELECT * FROM twofa_pending WHERE token = ?', pending) : null;
    if (!row || new Date(row.expires_at) < new Date()) return ctx.redirect('/login?error=' + encodeURIComponent('Two-factor session expired'));
    return { status: 200, html: twofaPage() };
  });

  router.post('/login/2fa', (ctx) => {
    const pending = ctx.cookies.OA_2FA;
    const row = pending ? get('SELECT * FROM twofa_pending WHERE token = ?', pending) : null;
    if (!row || new Date(row.expires_at) < new Date()) return ctx.redirect('/login?error=' + encodeURIComponent('Two-factor session expired'));
    const user = get('SELECT * FROM users WHERE id = ?', row.user_id);
    const code = String(ctx.body.code || '').replace(/\s/g, '');
    let ok = user?.twofa_secret ? verifyTotp(user.twofa_secret, code) : false;
    if (!ok && user) {
      const codes = all('SELECT * FROM twofa_recovery WHERE user_id = ? AND used_at IS NULL', user.id);
      for (const c of codes) {
        if (verifyPassword(code, c.code_hash)) {
          run('UPDATE twofa_recovery SET used_at = ? WHERE id = ?', nowIso(), c.id);
          ok = true;
          break;
        }
      }
    }
    if (!ok) {
      run('UPDATE twofa_pending SET attempts = attempts + 1 WHERE token = ?', pending);
      const after = get('SELECT * FROM twofa_pending WHERE token = ?', pending);
      if (!after || after.attempts >= 5) {
        run('DELETE FROM twofa_pending WHERE token = ?', pending);
        ctx.res.setHeader('Set-Cookie', 'OA_2FA=; Path=/; Max-Age=0');
        return ctx.redirect('/login?error=' + encodeURIComponent('Too many invalid codes. Sign in again.'));
      }
      return { status: 401, html: twofaPage('Invalid authentication code.') };
    }
    run('DELETE FROM twofa_pending WHERE token = ?', pending);
    const s = createSession(user, { ip: ctx.ip, ua: ctx.req.headers['user-agent'] });
    audit(user.username, user.level, 'login.2fa', '', ctx.ip);
    ctx.res.setHeader('Set-Cookie', [serializeCookie(s.token, { secure: config.https }), 'OA_2FA=; Path=/; Max-Age=0']);
    return ctx.redirect('/' + user.level);
  });

  router.get('/logout', (ctx) => {
    const token = ctx.cookies['OA_SESSION'];
    if (token) destroySession(token);
    if (ctx.user) audit(ctx.user.username, ctx.user.level, 'logout', '', ctx.ip);
    ctx.res.setHeader('Set-Cookie', clearCookie());
    return ctx.redirect('/login');
  });

  router.post('/logout', (ctx) => {
    const token = ctx.cookies['OA_SESSION'];
    if (token) destroySession(token);
    ctx.res.setHeader('Set-Cookie', clearCookie());
    return ctx.redirect('/login');
  });

  router.get('/login/account-disabled', (ctx) => {
    const body = h`<div class="login-card" style="max-width:440px;margin:8vh auto">
      ${card('Account disabled', h`
        ${alert('This account has been suspended by an administrator or reseller. Websites, email and FTP access are offline until it is restored.', 'danger')}
        <p class="small muted">If you believe this is a mistake, contact your hosting provider and quote your username.</p>
        <div class="row mt-18"><a class="btn btn-secondary" href="/login">Back to sign in</a></div>`)}
    </div>`;
    return { status: 403, html: h`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Account disabled · OpenAdmin</title><link rel="stylesheet" href="/assets/app.css?v=${VERSION}"></head><body class="login-body">${body}</body></html>` };
  });

  router.get('/login/license-expired', (ctx) => {
    const body = h`<div class="login-card" style="max-width:480px;margin:8vh auto">
      ${card('No license required', h`
        ${alert('OpenAdmin has no license expiry. This page exists for compatibility with DirectAdmin redirects, but the Community Edition is free forever with unlimited accounts.', 'ok')}
        ${kvList([['Edition', 'Community'], ['Expires', 'Never'], ['Accounts', 'Unlimited'], ['Cost', '€0.00']], { cols: 1 })}
        <div class="row mt-18"><a class="btn btn-primary" href="/login">Continue to sign in</a></div>`)}
    </div>`;
    return { status: 200, html: h`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>License · OpenAdmin</title><link rel="stylesheet" href="/assets/app.css?v=${VERSION}"></head><body class="login-body">${body}</body></html>` };
  });

  router.get('/login/lost-password', (ctx) => ctx.redirect('/lost-password'));

  router.get('/lost-password', (ctx) => {
    const body = h`<div class="login-card" style="max-width:420px;margin:8vh auto">
      ${card('Reset your password', h`
        ${alert('For security, password resets are handled by your administrator or reseller. Ask them to issue a new password from the panel, or run <code>openadmin passwd &lt;username&gt;</code> on the server.', 'info')}
        <form method="post" action="/lost-password" class="oa-form">
          <div class="form-grid">
            <div class="field field-full"><label class="field-label" for="lu">Username or email</label>
              <input id="lu" name="account" type="text" placeholder="your-username" required></div>
          </div>
          <div class="form-actions"><button class="btn btn-primary" type="submit">Send reset request</button>
          <a class="btn btn-ghost" href="/login">Back to sign in</a></div>
        </form>`, { sub: 'Request a password reset from your provider' })}
    </div>`;
    return { status: 200, html: h`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reset password · OpenAdmin</title><link rel="stylesheet" href="/assets/app.css?v=${VERSION}"></head><body class="login-body">${body}</body></html>` };
  });

  const resetPage = (token, error = '') => h`<!DOCTYPE html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ustaw nowe hasło · OpenAdmin</title><link rel="stylesheet" href="/assets/app.css?v=${VERSION}"></head><body class="login-body"><div class="login-wrap single"><div class="login-card">
    <h1>Ustaw nowe hasło</h1>
    ${error ? h`<div class="alert alert-danger">${error}</div>` : ''}
    <form method="post" action="/reset-password" class="oa-form">
      <input type="hidden" name="token" value="${token}">
      <div class="field"><label class="field-label">Nowe hasło</label><input name="password" type="password" minlength="8" required autofocus autocomplete="new-password"></div>
      <div class="field"><label class="field-label">Powtórz hasło</label><input name="password2" type="password" minlength="8" required autocomplete="new-password"></div>
      <div class="form-actions"><button class="btn btn-primary btn-block" type="submit">Zapisz hasło</button></div>
    </form>
  </div></div></body></html>`;

  router.get('/reset-password', (ctx) => {
    const token = String(ctx.query.token || '');
    const row = verifyResetToken(token);
    if (!row) return { status: 400, html: resetPage('', 'Link wygasł lub jest nieprawidłowy. Poproś o nowy.') };
    return { status: 200, html: resetPage(token) };
  });

  router.post('/reset-password', (ctx) => {
    const token = String(ctx.body.token || '');
    const row = verifyResetToken(token);
    if (!row) return { status: 400, html: resetPage('', 'Link wygasł lub jest nieprawidłowy. Poproś o nowy.') };
    const password = String(ctx.body.password || '');
    if (password.length < 8) return { status: 400, html: resetPage(token, 'Hasło musi mieć co najmniej 8 znaków.') };
    if (password !== String(ctx.body.password2 || '')) return { status: 400, html: resetPage(token, 'Hasła nie są identyczne.') };
    const user = get('SELECT * FROM users WHERE id = ?', row.user_id);
    if (!user) return { status: 400, html: resetPage('', 'Konto nie istnieje.') };
    run('UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?', hashPassword(password), user.id);
    consumeResetToken(row);
    run('DELETE FROM sessions WHERE user_id = ?', user.id);
    audit(user.username, user.level, 'password.reset.email', '', ctx.ip);
    return ctx.redirect('/login?error=' + encodeURIComponent('Hasło zostało zmienione. Zaloguj się.'));
  });

  router.post('/lost-password', (ctx) => {
    const account = String(ctx.body.account || '').trim();
    const user = findUser(account) || get('SELECT * FROM users WHERE email = ?', account);
    if (user) {
      const sent = requestPasswordReset(user);
      if (!sent.ok) {
        run(`INSERT INTO tickets(user_id, username, subject, department, priority, status, created_at, updated_at)
             VALUES(?,?,?,?,?,?,?,?)`, user.id, user.username, 'Password reset requested', 'support', 'high', 'open', nowIso(), nowIso());
      } else {
        audit(user.username, user.level, 'password.reset.request', '', ctx.ip);
      }
    }
    return ctx.redirect('/login?error=' + encodeURIComponent('Jeśli konto istnieje, wysłaliśmy link do resetu hasła.'));
  });

  router.get('/help', (ctx) => {
    const body = h`<div class="grid grid-2">
      ${card('Getting started', h`<ol class="doc-list">
        <li><strong>Sign in</strong> with your panel account. Admins can switch between Admin, Reseller and User views from the sidebar.</li>
        <li><strong>Create a package</strong> under Admin → User Packages to define limits (domains, email, disk, bandwidth).</li>
        <li><strong>Create a user</strong> under Reseller → Create User, or Admin → Create User. A home directory and primary domain are provisioned automatically.</li>
        <li><strong>Point DNS</strong> at your server, then issue a certificate under SSL/TLS Certificates.</li>
      </ol>`)}
      ${card('Compatibility', h`<p class="small muted">OpenAdmin implements the DirectAdmin command surface: <code>/CMD_API_*</code> endpoints, the <code>error=0</code> response convention, and the three-level permission model. See <a href="/api/v1/openapi.json">the OpenAPI document</a> for the REST API.</p>
        ${kvList([['Panel port', String(config.port)], ['API auth', 'HTTP Basic'], ['Response format', 'URL-encoded / JSON'], ['License', 'AGPL-3.0, unlimited']])}`)}
    </div>
    ${card('Keyboard shortcuts', h`${kvList([['Command palette', '⌘K / Ctrl+K'], ['Close dialogs', 'Esc'], ['Navigate results', '↑ / ↓'], ['Open result', 'Enter']])}`)}`;
    return page(ctx, { title: 'Documentation', subtitle: 'OpenAdmin help and reference', body });
  });

  router.get('/switch-skin', (ctx) => {
    if (!ctx.user) return ctx.redirect('/login');
    const skin = ctx.query.skin === 'enhanced' ? 'enhanced' : 'evolution';
    run('UPDATE users SET skin = ? WHERE id = ?', skin, ctx.user.id);
    return ctx.redirect(ctx.req.headers.referer ? new URL(ctx.req.headers.referer).pathname : '/' + ctx.user.level);
  });

  router.get('/switch-level', (ctx) => {
    if (!ctx.user) return ctx.redirect('/login');
    const target = ['user', 'reseller', 'admin'].includes(String(ctx.query.level)) ? ctx.query.level : 'user';
    const allowed = target === 'user' || (target === 'reseller' && ctx.user.level !== 'user') || (target === 'admin' && ctx.user.level === 'admin');
    return ctx.redirect(allowed ? '/' + target : '/' + ctx.user.level);
  });

  // Simple public status endpoint used by installers.
  router.get('/version', () => ({ json: { product: 'OpenAdmin', version: VERSION, license: 'AGPL-3.0', edition: 'Community' } }));
}

export function docList(items) {
  return h`<ol class="doc-list">${items.map((i) => h`<li>${i}</li>`)}</ol>`;
}
void e; void isEmail; void btn; void ic; void raw; void ic;
