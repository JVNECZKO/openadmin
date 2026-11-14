// Guided flows for non-technical users: add a website and add a mailbox.
import { html as h, isDomain, isEmail } from '../util.mjs';
import { all, get, run, nowIso, hashPassword, audit } from '../db.mjs';
import { page } from '../ui/respond.mjs';
import { card, alert, kvList, btn, badge } from '../ui/components.mjs';
import { quota, visibleDomains, domainFor } from '../core/access.mjs';
import { createZone } from './domains.mjs';
import { provisionDomain } from './files.mjs';
import { generateSelfSigned, issueLetsEncrypt } from '../ssl.mjs';
import { apply } from '../apply.mjs';
import { installWordPress } from '../wordpress.mjs';
import { dovecotHash, syncMail } from '../mail.mjs';
import { clientSettings } from '../autoconfig.mjs';

function dnsInfo(domain, ip, ns1, ns2) {
  return `A     @              ${ip}
A     www            ${ip}
MX    @              10 mail.${domain}.
NS    @              ${ns1}
NS    @              ${ns2}`;
}

export function register(router) {
  router.get('/user/websites/new', (ctx) => {
    const domains = visibleDomains(ctx.user);
    const body = h`${card('Dodaj stronę w 3 krokach', h`
      <p class="small muted">Wpisz domenę, wybierz certyfikat i opcjonalnie zainstaluj WordPress. Panel sam utworzy katalog, vhost, DNS i PHP.</p>
      <form method="post" action="/user/websites/new" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field field-full"><label class="field-label">Domena</label><input name="domain" placeholder="example.com" required></div>
          <div class="field"><label class="field-label">Certyfikat SSL</label><select name="ssl">
            <option value="selfsigned">Self-signed — działa od razu (przeglądarka ostrzeże)</option>
            <option value="letsencrypt">Let's Encrypt — wymaga publicznego DNS</option>
            <option value="none">Bez SSL (tylko HTTP)</option>
          </select></div>
          <div class="field"><label class="field-label">Dodaj WordPress</label><select name="wordpress"><option value="0">Nie, tylko pusta strona</option><option value="1">Tak, zainstaluj WordPress</option></select></div>
          <div class="field"><label class="field-label">Tytuł strony (WordPress)</label><input name="wp_title" placeholder="Moja strona"></div>
          <div class="field"><label class="field-label">Hasło administratora WordPress</label><input name="wp_password" type="password" minlength="8" placeholder="min. 8 znaków"></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Utwórz stronę</button></div>
      </form>`)}
      ${domains.length ? card('Masz już domeny', h`${domains.map((d) => h`<div class="spread" style="padding:6px 0"><a class="link" href="/user/files?path=${encodeURIComponent(d.docroot || '/')}">${d.name}</a><span>${d.ssl ? badge('SSL', 'ok') : badge('bez SSL', 'warn')}</span></div>`)}`) : ''}`;
    return page(ctx, { title: 'Dodaj stronę', subtitle: 'Domena, SSL i WordPress jednym krokiem', body });
  });

  router.post('/user/websites/new', (ctx) => {
    const name = String(ctx.body.domain || '').trim().toLowerCase();
    if (!isDomain(name)) return ctx.redirect('/user/websites/new?flash=' + encodeURIComponent('Nieprawidłowa nazwa domeny') + '&type=error');
    if (get('SELECT id FROM domains WHERE name = ?', name)) return ctx.redirect('/user/websites/new?flash=' + encodeURIComponent('Ta domena już istnieje') + '&type=error');
    const q = quota(ctx.user, 'domains');
    if (!q.ok) return ctx.redirect('/user/websites/new?flash=' + encodeURIComponent('Osiągnięto limit domen') + '&type=error');
    const ip = get("SELECT value FROM settings WHERE key='server_ip'")?.value || '127.0.0.1';
    const ns1 = get("SELECT value FROM settings WHERE key='ns1'")?.value || 'ns1.localhost';
    const ns2 = get("SELECT value FROM settings WHERE key='ns2'")?.value || 'ns2.localhost';
    const docroot = `/home/${ctx.user.username}/domains/${name}/public_html`;
    const r = run(`INSERT INTO domains(user_id, username, name, docroot, php_version, ssl, status, is_main, ip, created_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?)`, ctx.user.id, ctx.user.username, name, docroot, '8.2', 0, 'active',
      get('SELECT COUNT(*) n FROM domains WHERE user_id = ?', ctx.user.id).n === 0 ? 1 : 0, ip, nowIso());
    createZone(r.lastInsertRowid, name);
    provisionDomain(ctx.user.username, name);
    let sslText = 'Bez SSL';
    let sslOk = false;
    if (ctx.body.ssl === 'selfsigned') {
      const s = generateSelfSigned(name, 365);
      sslOk = s.ok; sslText = s.ok ? 'Self-signed zainstalowany' : `Błąd SSL: ${s.error}`;
    } else if (ctx.body.ssl === 'letsencrypt') {
      const le = issueLetsEncrypt(name, docroot, ctx.user.email || '');
      if (le.ok) { sslOk = true; sslText = "Let's Encrypt zainstalowany"; }
      else {
        const fallback = generateSelfSigned(name, 365);
        sslOk = fallback.ok;
        sslText = `Let's Encrypt nie powiódł się (${le.error}); zainstalowano self-signed`;
      }
    }
    if (sslOk) run('UPDATE domains SET ssl = 1 WHERE id = ?', r.lastInsertRowid);
    let wp = null;
    if (ctx.body.wordpress === '1') {
      wp = installWordPress({
        user: ctx.user, domain: name, title: ctx.body.wp_title || name,
        adminPass: String(ctx.body.wp_password || ''), adminEmail: ctx.user.email || '', scheme: sslOk ? 'https' : 'http',
      });
    }
    const applied = apply({ web: true, dns: true, mail: true, pools: true });
    audit(ctx.user.username, ctx.user.level, 'website.create', name, ctx.ip);
    const body = h`${card('Strona utworzona', h`
      ${alert(applied.ok ? 'Wdrożono konfigurację.' : 'Strona powstała, ale wdrożenie zgłosiło błędy — sprawdź Stan serwera.', applied.ok ? 'ok' : 'warn')}
      ${kvList([
        ['Adres', h`<a class="link" href="http://${name}/" target="_blank">http://${name}/</a>`],
        ['Katalog plików', h`<code>${docroot}</code>`],
        ['SSL', sslText],
        ['WordPress', wp ? (wp.ok ? 'zainstalowany' : `błąd: ${wp.error}`) : 'nie wybrano'],
      ])}
      ${wp?.ok ? h`<h3 class="form-section">Dane WordPress</h3>${kvList([
        ['Panel', h`<a class="link" href="${wp.adminUrl}" target="_blank">${wp.adminUrl}</a>`],
        ['Login', wp.adminUser], ['Hasło', h`<code>${wp.adminPass}</code>`],
      ])}${alert('Zapisz hasło WordPress teraz — nie pokażemy go ponownie.', 'warn')}` : ''}
      <h3 class="form-section">DNS u registrar</h3>
      <pre class="code-block">${dnsInfo(name, ip, ns1, ns2)}</pre>
      <p class="small muted">Jeśli domena nie jest jeszcze delegowana do tego serwera, ustaw powyższe rekordy (lub NS) u registrar.</p>
      <div class="row mt-18">
        <a class="btn btn-primary" href="/user/files?path=${encodeURIComponent(docroot)}">Wgraj pliki</a>
        <a class="btn btn-secondary" href="/user/email/new?domain=${encodeURIComponent(name)}">Dodaj pocztę</a>
        <a class="btn btn-ghost" href="/admin/health">Stan serwera</a>
      </div>`)}`;
    return page(ctx, { title: 'Gotowe', subtitle: name, body });
  });

  router.get('/user/email/new', (ctx) => {
    const domains = visibleDomains(ctx.user);
    const selected = ctx.query.domain || domains[0]?.name || '';
    if (!domains.length) return ctx.redirect('/user/websites/new?flash=' + encodeURIComponent('Najpierw dodaj domenę') + '&type=error');
    const body = h`${card('Dodaj skrzynkę e-mail', h`
      <form method="post" action="/user/email/new" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Domena</label><select name="domain">${domains.map((d) => h`<option value="${d.name}" ${selected === d.name ? 'selected' : ''}>${d.name}</option>`)}</select></div>
          <div class="field"><label class="field-label">Nazwa skrzynki</label><input name="local" placeholder="kontakt" required></div>
          <div class="field"><label class="field-label">Hasło</label><input name="password" type="password" minlength="8" required></div>
          <div class="field"><label class="field-label">Limit (MB)</label><input name="quota_mb" type="number" min="0" value="1024"></div>
        </div>
        <p class="small muted">Po utworzeniu pokażemy ustawienia IMAP/SMTP i autokonfigurację dla telefonu i Outlooka.</p>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Utwórz skrzynkę</button></div>
      </form>`)}`;
    return page(ctx, { title: 'Dodaj pocztę', subtitle: 'Skrzynka i ustawienia klienta', body });
  });

  router.post('/user/email/new', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/email/new?flash=' + encodeURIComponent('Nieprawidłowa domena') + '&type=error');
    const local = String(ctx.body.local || '').toLowerCase().trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(local)) return ctx.redirect('/user/email/new?flash=' + encodeURIComponent('Nieprawidłowa nazwa skrzynki') + '&type=error');
    const password = String(ctx.body.password || '');
    if (password.length < 8) return ctx.redirect('/user/email/new?flash=' + encodeURIComponent('Hasło musi mieć co najmniej 8 znaków') + '&type=error');
    const q = quota(ctx.user, 'emails');
    if (!q.ok) return ctx.redirect('/user/email/new?flash=' + encodeURIComponent('Osiągnięto limit skrzynek') + '&type=error');
    let mailHash = null;
    try { mailHash = dovecotHash(password); } catch { /* optional */ }
    run(`INSERT INTO email_accounts(domain_id, domain, local_part, password, quota_mb, used_mb, suspended, created_at, mail_hash)
         VALUES(?,?,?,?,?,?,?,?,?)`, d.id, d.name, local, hashPassword(password), Number(ctx.body.quota_mb) || 1024, 0, 0, nowIso(), mailHash);
    syncMail();
    apply({ mail: true, dns: true });
    audit(ctx.user.username, ctx.user.level, 'email.create', `${local}@${d.name}`, ctx.ip);
    const s = clientSettings(`${local}@${d.name}`);
    const body = h`${card('Skrzynka utworzona', h`
      ${alert('Poczta jest gotowa. Poniżej ustawienia do telefonu, Outlooka lub Thunderbirda.', 'ok')}
      ${kvList([
        ['Adres e-mail', h`<code>${s.address}</code>`],
        ['IMAP', h`<code>${s.imap.host}:${s.imap.port}</code> (SSL/TLS)`],
        ['SMTP', h`<code>${s.smtp.host}:${s.smtp.port}</code> (STARTTLS)`],
        ['Login', h`<code>${s.address}</code>`],
        ['Autokonfiguracja', h`<code>http://${s.server}/mail/config-v1.1.xml</code>`],
      ])}
      <div class="row mt-18">
        <a class="btn btn-primary" href="/webmail">Otwórz webmail</a>
        <a class="btn btn-secondary" href="/user/email/client-settings?address=${encodeURIComponent(s.address)}">Ustawienia klienta</a>
        <a class="btn btn-ghost" href="/user/email">Wszystkie skrzynki</a>
      </div>`)}`;
    return page(ctx, { title: 'Gotowe', subtitle: s.address, body });
  });
}
