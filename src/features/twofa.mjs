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
      const body = h`${card('Weryfikacja dwuetapowa', h`
        ${alert('Weryfikacja dwuetapowa jest włączona dla tego konta. Kod jest wymagany przy każdym logowaniu.', 'ok')}
        ${kvList([['Status', badge('włączona', 'ok')], ['Kody odzyskiwania', String(recovery.length)], ['Metoda', 'TOTP (RFC 6238, 30 s, SHA-1)']])}
        <h3 class="form-section">Wyłącz</h3>
        <form method="post" action="/user/2fa/disable" class="oa-form">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <div class="form-grid">
            <div class="field"><label class="field-label">Hasło</label><input name="password" type="password" required></div>
            <div class="field"><label class="field-label">Aktualny kod</label><input name="code" inputmode="numeric" required placeholder="123456"></div>
          </div>
          <div class="form-actions"><button class="btn btn-danger" type="submit">Wyłącz weryfikację dwuetapową</button></div>
        </form>`)}`;
      return page(ctx, { title: 'Weryfikacja dwuetapowa', subtitle: 'Chroń logowanie do panelu', body });
    }
    let secret = setting(`twofa_setup:${user.id}`, '');
    if (!secret) { secret = generateSecret(); setSetting(`twofa_setup:${user.id}`, secret); }
    const url = otpauthURL({ account: user.username, secret });
    const qr = qrSvg(url, { size: 220 });
    const body = h`${card('Włącz weryfikację dwuetapową', h`
      <p class="small muted mb-18">Add this account to your authenticator app, then enter the 6-digit code to confirm.</p>
      <div class="grid grid-2">
        ${kvList([['Konto', user.username], ['Sekret', h`<code>${secret}</code>`], ['Typ', 'Czasowy (TOTP)'], ['Cyfry', '6 / 30 sekund']])}
        <div>
          ${qr ? h`<div class="u-s66">${raw(qr)}<p class="small muted">Zeskanuj w aplikacji Google Authenticator / Microsoft Authenticator</p></div>` : h`<p class="small muted">Zainstaluj pakiet <code>qrencode</code>, aby zobaczyć kod QR, albo wpisz sekret ręcznie.</p>`}
          <p class="small muted">otpauth URI</p>
          <pre class="code-block small">${url}</pre>
        </div>
      </div>
      <form method="post" action="/user/2fa/enable" class="oa-form mt-18">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="field"><label class="field-label">Authentication code</label><input name="code" inputmode="numeric" required autofocus placeholder="123456"></div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Enable 2FA</button></div>
      </form>`)}`;
    return page(ctx, { title: 'Weryfikacja dwuetapowa', subtitle: 'Dodaj drugi składnik do swojego konta', body });
  });

  router.post('/user/2fa/enable', (ctx) => {
    const secret = setting(`twofa_setup:${ctx.user.id}`, '');
    if (!secret) return ctx.redirect('/user/2fa?flash=Sesja%20konfiguracji%20wygas%C5%82a&type=error');
    if (!verifyTotp(secret, String(ctx.body.code || ''))) {
      return ctx.redirect('/user/2fa?flash=' + encodeURIComponent('Kod nie pasuje. Sprawdź zegar aplikacji i spróbuj ponownie.') + '&type=error');
    }
    const codes = recoveryCodes();
    run('UPDATE users SET twofa_secret = ?, twofa_enabled = 1 WHERE id = ?', sealTotp(secret), ctx.user.id);
    reissueSession(ctx);
    run('DELETE FROM twofa_recovery WHERE user_id = ?', ctx.user.id);
    for (const code of codes) {
      run('INSERT INTO twofa_recovery(user_id, code_hash) VALUES(?,?)', ctx.user.id, hashPassword(code));
    }
    setSetting(`twofa_setup:${ctx.user.id}`, '');
    const body = h`${card('Weryfikacja dwuetapowa włączona', h`
      ${alert('Zapisz teraz kody odzyskiwania. Każdy działa jednorazowo i nie zostanie ponownie pokazany.', 'warn')}
      <pre class="code-block">${codes.join('\n')}</pre>
      <div class="row mt-18">${btn('Gotowe', { href: '/user/2fa' })}</div>`)}`;
    return page(ctx, { title: 'Kody odzyskiwania', subtitle: 'Zapisz je w bezpiecznym miejscu', body });
  });

  router.post('/user/2fa/disable', (ctx) => {
    const user = get('SELECT * FROM users WHERE id = ?', ctx.user.id);
    if (!user.twofa_enabled) return ctx.redirect('/user/2fa');
    if (!verifyPassword(String(ctx.body.password || ''), user.password)) {
      return ctx.redirect('/user/2fa?flash=Has%C5%82o%20jest%20nieprawid%C5%82owe&type=error');
    }
    if (!verifyTotp(openTotp(user.twofa_secret), String(ctx.body.code || ''))) {
      return ctx.redirect('/user/2fa?flash=Nieprawid%C5%82owy%20kod%20uwierzytelniaj%C4%85cy&type=error');
    }
    run('UPDATE users SET twofa_enabled = 0, twofa_secret = NULL WHERE id = ?', user.id);
    reissueSession(ctx);
    run('DELETE FROM twofa_recovery WHERE user_id = ?', user.id);
    return ctx.redirect('/user/2fa?flash=Weryfikacja%20dwuetapowa%20wy%C5%82%C4%85czona');
  });
}


