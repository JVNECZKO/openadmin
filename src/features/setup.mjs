// First-run wizard: server identity, web server, HTTPS and first deploy.
import os from 'node:os';
import { html as h } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, alert, kvList, badge, btn } from '../ui/components.mjs';
import { setupState, applySetup, restartPanel } from '../setup.mjs';
import { healthReport } from '../health.mjs';
import { SERVERS } from '../webserver.mjs';

function statusBadge(status) {
  return status === 'ok' ? badge('OK', 'ok', { dot: true }) : status === 'warn' ? badge('Uwaga', 'warn', { dot: true }) : badge('Błąd', 'danger', { dot: true });
}

export function register(router) {
  router.get('/admin/setup', async (ctx) => {
    const state = setupState();
    const health = await healthReport();
    const restartNeeded = state.https && !(process.env.OA_HTTPS === '1' && process.env.OA_CERT);
    const body = h`
      ${state.complete ? alert('Konfiguracja została już zakończona. Możesz ją powtórzyć, aby zmienić adresy lub certyfikat.', 'info') : alert('Witaj! Uzupełnij kilka informacji, a panel sam skonfiguruje strony, DNS i pocztę. Możesz to później zmienić.', 'warn')}
      ${restartNeeded ? card('HTTPS jest gotowy — uruchom panel ponownie', h`
        <p class="small muted">Certyfikat został zapisany. Aby panel odpowiadał po HTTPS, musi zostać zrestartowany.</p>
        <form method="post" action="/admin/setup/restart"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <button class="btn btn-primary" type="submit">Restartuj panel teraz</button></form>`) : ''}
      <div class="grid grid-2">
        ${card('To już wiemy o serwerze', h`${kvList([
          ['Hostname', state.hostname],
          ['Wykryte adresy IP', state.addresses.map((a) => `${a.address} (${a.iface})`).join(', ') || 'brak'],
          ['Provider', state.provider],
          ['Panel', `port 2222 · ${state.https ? 'HTTPS' : 'HTTP'}`],
        ])}`)}
        ${card('Sprawdzenie gotowości', h`<div class="stack" style="gap:8px">
          ${health.checks.filter((c) => ['web', 'php', 'db', 'dns', 'mail', 'port-80', 'port-25', 'port-993'].includes(c.id)).map((c) => h`<div class="spread"><span>${c.label}</span><span>${statusBadge(c.status)}</span></div>`)}
        </div>`, { actions: [h`<a class="link small" href="/admin/health">Pełny raport</a>`] })}
      </div>
      ${card('Konfiguracja', h`<form method="post" action="/admin/setup" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Nazwa serwera (hostname)</label><input name="server_name" value="${state.serverName}" required></div>
          <div class="field"><label class="field-label">Adres IP serwera</label><input name="server_ip" value="${state.serverIp}" required></div>
          <div class="field"><label class="field-label">Nazwa panelu (certyfikat HTTPS)</label><input name="panel_hostname" value="${state.panelHostname}"></div>
          <div class="field"><label class="field-label">Serwer WWW</label><select name="web_server">${Object.values(SERVERS).map((s) => h`<option value="${s.id}" ${state.webServer === s.id ? 'selected' : ''}>${s.label}</option>`)}</select></div>
          <div class="field"><label class="field-label">NS1</label><input name="ns1" value="${state.ns1}"></div>
          <div class="field"><label class="field-label">NS2</label><input name="ns2" value="${state.ns2}"></div>
          <div class="field"><label class="field-label">E-mail administratora</label><input name="admin_email" type="email" value="${state.adminEmail}"></div>
          <div class="field"><label class="field-label">Nowe hasło administratora</label><input name="admin_password" type="password" minlength="10" ${state.complete ? '' : 'required'} placeholder="min. 10 znaków"></div>
        </div>
        <label class="check-field mt-12"><input type="checkbox" name="enable_https" value="1" ${state.https ? '' : 'checked'}> <span>Włącz HTTPS panelu (certyfikat self-signed dla nazwy/IP)</span></label>
        <p class="small muted mt-12">Po zapisaniu panel od razu wdroży konfigurację stron, DNS i poczty. Porty 80/443/25 muszą być dostępne z internetu, aby działało to poza siecią lokalną.</p>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Zapisz i uruchom panel</button></div>
      </form>`, { padded: true })}
      ${card('Zewnętrzne DNS', h`<p class="small muted">Jeśli domena ma być widoczna w internecie, u registrar ustaw dla niej serwery nazw:</p>
        <pre class="code-block">${state.ns1}
${state.ns2}</pre>
        <p class="small muted">Oraz rekord A dla <code>${state.serverName}</code> → <code>${state.serverIp}</code>.</p>`)}`;
    return page(ctx, { title: 'Kreator konfiguracji', subtitle: 'Kilka kroków i panel jest gotowy', body, wide: true });
  });

  router.post('/admin/setup', (ctx) => {
    const result = applySetup(ctx.body);
    if (!result.ok) return ctx.redirect('/admin/setup?flash=' + encodeURIComponent(result.error) + '&type=error');
    if (result.restartRequired) return ctx.redirect('/admin/setup?flash=' + encodeURIComponent('Zapisano. Uruchom panel ponownie, aby włączyć HTTPS.'));
    return ctx.redirect('/admin/health?flash=' + encodeURIComponent('Konfiguracja zakończona. Wdrożono strony, DNS i pocztę.'));
  });

  router.post('/admin/setup/restart', (ctx) => {
    restartPanel();
    const state = setupState();
    const body = h`${card('Restartowanie panelu', h`
      <p>Panel uruchamia się ponownie z HTTPS. Odczekaj kilka sekund i otwórz:</p>
      <pre class="code-block">https://${state.panelHostname}:2222</pre>
      <p class="small muted">Jeśli certyfikat jest self-signed, przeglądarka pokaże ostrzeżenie — zaakceptuj je jednorazowo.</p>
      <a class="btn btn-primary" href="https://${state.panelHostname}:2222/admin/health">Otwórz panel</a>`)}`;
    return page(ctx, { title: 'Restart', subtitle: 'HTTPS', body });
  });
}
