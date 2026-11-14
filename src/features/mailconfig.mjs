// Public autoconfig/autodiscover endpoints and the per-mailbox client settings page.
import { all, get } from '../db.mjs';
import { html as h } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, alert, kvList } from '../ui/components.mjs';
import { clientSettings, autoconfigXml, autodiscoverXml } from '../autoconfig.mjs';
import { visibleDomains, domainFor } from '../core/access.mjs';

function hostDomain(req) {
  const host = String(req.headers.host || '').split(':')[0];
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? host : '';
}

function sendXml(ctx, xml) {
  ctx.res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
  ctx.res.end(xml);
  return { handled: true };
}

export function register(router) {
  const configHandler = (ctx) => {
    const email = String(ctx.query.email || '').trim() || `user@${hostDomain(ctx.req) || 'localhost'}`;
    return sendXml(ctx, autoconfigXml(email));
  };
  router.get('/mail/config-v1.1.xml', configHandler);
  router.get('/.well-known/autoconfig/mail/config-v1.1.xml', configHandler);
  router.get('/autoconfig.xml', configHandler);

  router.post('/autodiscover/autodiscover.xml', (ctx) => {
    const raw = String(ctx.body._raw || '') + JSON.stringify(ctx.body || {});
    const email = (/<EMailAddress>([^<]+)<\/EMailAddress>/i.exec(raw)?.[1]
      || /"email"\s*:\s*"([^"]+)"/i.exec(raw)?.[1]
      || String(ctx.query.email || '')).trim();
    if (!email.includes('@')) {
      ctx.res.writeHead(400, { 'Content-Type': 'application/xml' });
      ctx.res.end('<?xml version="1.0"?><Autodiscover><Response><Error/></Response></Autodiscover>');
      return { handled: true };
    }
    return sendXml(ctx, autodiscoverXml(email));
  });

  router.get('/user/email/client-settings', (ctx) => {
    const d = ctx.query.domain ? domainFor(ctx.user, ctx.query.domain) : visibleDomains(ctx.user)[0];
    if (!d) return ctx.redirect('/user/email?flash=Najpierw%20dodaj%20domen%C4%99&type=error');
    const accounts = all('SELECT * FROM email_accounts WHERE domain_id = ? ORDER BY local_part', d.id);
    const selected = String(ctx.query.address || (accounts[0] ? `${accounts[0].local_part}@${accounts[0].domain}` : ''));
    const s = clientSettings(selected);
    const body = h`
      ${alert('Te ustawienia działają w Thunderbirdzie, Outlooku, Apple Mail i aplikacjach mobilnych. Wpisz je w aplikacji pocztowej.', 'info')}
      ${card('Wybierz skrzynkę', h`<form method="get" action="/user/email/client-settings" class="row">
        <select name="address">${accounts.map((a) => h`<option value="${a.local_part}@${a.domain}" ${selected === `${a.local_part}@${a.domain}` ? 'selected' : ''}>${a.local_part}@${a.domain}</option>`)}</select>
        <button class="btn btn-secondary btn-sm" type="submit">Pokaż ustawienia</button></form>`)}
      ${selected ? card('Ustawienia aplikacji pocztowej', h`
        <div class="grid grid-2">
          ${kvList([
            ['Adres e-mail', h`<code>${s.address}</code>`],
            ['Serwer poczty przychodzącej (IMAP)', h`<code>${s.imap.host}</code>`],
            ['Port IMAP', h`<code>${s.imap.port}</code> (SSL/TLS)`],
            ['Serwer poczty wychodzącej (SMTP)', h`<code>${s.smtp.host}</code>`],
            ['Port SMTP', h`<code>${s.smtp.port}</code> (STARTTLS)`],
            ['Login', h`<code>${s.address}</code>`],
            ['Hasło', 'to samo, którego używasz w webmailu'],
          ])}
          <div>
            <p class="small muted">Automatyczna konfiguracja</p>
            <p class="small">Wpisz adres e-mail w aplikacji — większość programów sama pobierze ustawienia z:</p>
            <pre class="code-block small">http://${s.server}/mail/config-v1.1.xml</pre>
            <p class="small muted">Outlook: autodiscover</p>
            <pre class="code-block small">http://${s.server}/autodiscover/autodiscover.xml</pre>
          </div>
        </div>
        <div class="row mt-18">
          <a class="btn btn-primary" href="/webmail" target="_blank">Otwórz webmail</a>
          <a class="btn btn-ghost" href="/user/email?domain=${encodeURIComponent(d.name)}">Wróć do skrzynek</a>
        </div>`) : ''}`;
    return page(ctx, { title: 'Ustawienia poczty', subtitle: 'IMAP, SMTP i autokonfiguracja', body });
  });
}
