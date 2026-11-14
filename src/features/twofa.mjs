// Two-factor enrollment, recovery codes and disabling.
import { html as h, raw } from '../util.mjs';
import { all, get, run, nowIso, setSetting, setting, hashPassword, verifyPassword } from '../db.mjs';
import { page } from '../ui/respond.mjs';
import { card, alert, kvList, badge, btn } from '../ui/components.mjs';
import { generateSecret, verifyTotp, otpauthURL, recoveryCodes } from '../twofa.mjs';
import { qrSvg } from '../qr.mjs';
import { sealTotp, openTotp } from '../secrets.mjs';
import { reissueSession } from '../auth.mjs';

export function register(router) {
  router.get('/user/2fa', (ctx) => {
    const user = get('SELECT * FROM users WHERE id = ?', ctx.user.id);
    if (user.twofa_enabled) {
      const recovery = all('SELECT * FROM twofa_recovery WHERE user_id = ? AND used_at IS NULL', user.id);
      const body = h`${card('Two-factor authentication', h`
        ${alert('Two-factor authentication is enabled for this account. A code is required at every login.', 'ok')}
        ${kvList([['Status', badge('enabled', 'ok')], ['Recovery codes left', String(recovery.length)], ['Method', 'TOTP (RFC 6238, 30s, SHA-1)']])}
        <h3 class="form-section">Disable</h3>
        <form method="post" action="/user/2fa/disable" class="oa-form">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <div class="form-grid">
            <div class="field"><label class="field-label">Password</label><input name="password" type="password" required></div>
            <div class="field"><label class="field-label">Current code</label><input name="code" inputmode="numeric" required placeholder="123456"></div>
          </div>
          <div class="form-actions"><button class="btn btn-danger" type="submit">Disable two-factor authentication</button></div>
        </form>`)}`;
      return page(ctx, { title: 'Two-Factor Authentication', subtitle: 'Protect your panel login', body });
    }
    let secret = setting(`twofa_setup:${user.id}`, '');
    if (!secret) { secret = generateSecret(); setSetting(`twofa_setup:${user.id}`, secret); }
    const url = otpauthURL({ account: user.username, secret });
    const qr = qrSvg(url, { size: 220 });
    const body = h`${card('Enable two-factor authentication', h`
      <p class="small muted mb-18">Add this account to your authenticator app, then enter the 6-digit code to confirm.</p>
      <div class="grid grid-2">
        ${kvList([['Account', user.username], ['Secret', h`<code>${secret}</code>`], ['Type', 'Time-based (TOTP)'], ['Digits', '6 / 30 seconds']])}
        <div>
          ${qr ? h`<div style="text-align:center">${raw(qr)}<p class="small muted">Zeskanuj w aplikacji Google Authenticator / Microsoft Authenticator</p></div>` : h`<p class="small muted">Zainstaluj pakiet <code>qrencode</code>, aby zobaczyć kod QR, albo wpisz sekret ręcznie.</p>`}
          <p class="small muted">otpauth URI</p>
          <pre class="code-block small">${url}</pre>
        </div>
      </div>
      <form method="post" action="/user/2fa/enable" class="oa-form mt-18">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="field"><label class="field-label">Authentication code</label><input name="code" inputmode="numeric" required autofocus placeholder="123456"></div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Enable 2FA</button></div>
      </form>`)}`;
    return page(ctx, { title: 'Two-Factor Authentication', subtitle: 'Add a second factor to your account', body });
  });

  router.post('/user/2fa/enable', (ctx) => {
    const secret = setting(`twofa_setup:${ctx.user.id}`, '');
    if (!secret) return ctx.redirect('/user/2fa?flash=Setup%20expired&type=error');
    if (!verifyTotp(secret, String(ctx.body.code || ''))) {
      return ctx.redirect('/user/2fa?flash=' + encodeURIComponent('That code did not match. Check your authenticator clock and try again.') + '&type=error');
    }
    const codes = recoveryCodes();
    run('UPDATE users SET twofa_secret = ?, twofa_enabled = 1 WHERE id = ?', sealTotp(secret), ctx.user.id);
    reissueSession(ctx);
    run('DELETE FROM twofa_recovery WHERE user_id = ?', ctx.user.id);
    for (const code of codes) {
      run('INSERT INTO twofa_recovery(user_id, code_hash) VALUES(?,?)', ctx.user.id, hashPassword(code));
    }
    setSetting(`twofa_setup:${ctx.user.id}`, '');
    const body = h`${card('Two-factor authentication enabled', h`
      ${alert('Store these recovery codes now. Each one works once and they are not shown again.', 'warn')}
      <pre class="code-block">${codes.join('\n')}</pre>
      <div class="row mt-18">${btn('Done', { href: '/user/2fa' })}</div>`)}`;
    return page(ctx, { title: 'Recovery Codes', subtitle: 'Save these somewhere safe', body });
  });

  router.post('/user/2fa/disable', (ctx) => {
    const user = get('SELECT * FROM users WHERE id = ?', ctx.user.id);
    if (!user.twofa_enabled) return ctx.redirect('/user/2fa');
    if (!verifyPassword(String(ctx.body.password || ''), user.password)) {
      return ctx.redirect('/user/2fa?flash=Password%20is%20incorrect&type=error');
    }
    if (!verifyTotp(openTotp(user.twofa_secret), String(ctx.body.code || ''))) {
      return ctx.redirect('/user/2fa?flash=Invalid%20authentication%20code&type=error');
    }
    run('UPDATE users SET twofa_enabled = 0, twofa_secret = NULL WHERE id = ?', user.id);
    reissueSession(ctx);
    run('DELETE FROM twofa_recovery WHERE user_id = ?', user.id);
    return ctx.redirect('/user/2fa?flash=Two-factor%20authentication%20disabled');
  });
}


