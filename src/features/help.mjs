// Contextual help for non-technical users. Every string is rendered in the
// language selected on the account; no untranslated English CTA leaks into the
// Polish locale (and vice versa).
import { html as h } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, alert } from '../ui/components.mjs';

function localeOf(ctx) {
  return ctx?.user?.language === 'en' ? 'en' : 'pl';
}

function L(locale, en, pl) {
  return locale === 'en' ? en : pl;
}

export function register(router) {
  router.get('/user/help', (ctx) => {
    if (!ctx.user) return ctx.redirect('/login');
    const locale = localeOf(ctx);
    const body = h`
      ${alert(L(locale,
        'The simplest way: use the “Add site” and “Add mailbox” buttons on the dashboard. Everything else happens automatically.',
        'Najprościej: użyj przycisków „Dodaj stronę” i „Dodaj pocztę” na pulpicie. Reszta dzieje się automatycznie.'), 'info')}
      <div class="grid grid-2">
        ${card(L(locale, 'How do I publish a website?', 'Jak postawić stronę?'), h`<ol class="small u-s13">
          <li>${L(locale, 'Click', 'Kliknij')} <strong>${L(locale, 'Add site', 'Dodaj stronę')}</strong> ${L(locale, 'and enter a domain (e.g.', 'i wpisz domenę (np.')} <code>mycompany.com</code>).</li>
          <li>${L(locale, 'Keep the recommended configuration and click Next. Engine changes are only in Advanced options.', 'Zostaw zalecaną konfigurację i kliknij Dalej. Zmiana silnika jest tylko w opcjach zaawansowanych.')}</li>
          <li>${L(locale, 'The default certificate works immediately. Public DNS is needed only for a publicly trusted certificate.', 'Domyślny certyfikat działa od razu. Publiczny DNS jest potrzebny tylko dla zaufanego certyfikatu.')}</li>
          <li>${L(locale, 'Add subdomains (e.g.', 'Dodaj subdomeny (np.')} <code>blog</code>, <code>shop</code>) ${L(locale, '— each gets its own vhost and DNS record.', '— każda dostanie własny vhost i rekord DNS.')}</li>
          <li>${L(locale, 'Optionally choose WordPress or Nextcloud; the installer creates the database and shows credentials once.', 'Opcjonalnie wybierz WordPress lub Nextcloud; instalator utworzy bazę i pokaże dane tylko raz.')}</li>
          <li>${L(locale, 'At your domain registrar, set the DNS records shown after the site is created.', 'U registrar domeny ustaw rekordy DNS pokazane po utworzeniu strony.')}</li>
          <li>${L(locale, 'Upload files in the', 'Pliki wgrasz w')} <a class="link" href="/user/files">${L(locale, 'File manager', 'Menedżerze plików')}</a>.</li>
        </ol>`)}
        ${card(L(locale, 'How do I set up email on my phone?', 'Jak skonfigurować pocztę w telefonie?'), h`<ol class="small u-s13">
          <li>${L(locale, 'Create a mailbox with', 'Utwórz skrzynkę przez')} <strong>${L(locale, 'Add mailbox', 'Dodaj pocztę')}</strong>.</li>
          <li>${L(locale, 'Open', 'Otwórz')} <a class="link" href="/user/email/client-settings">${L(locale, 'Client settings', 'Ustawienia klienta')}</a> ${L(locale, 'and pick the mailbox.', 'i wybierz skrzynkę.')}</li>
          <li>${L(locale, 'Enter the email address in your phone — most apps fetch the settings automatically.', 'Wpisz w telefonie adres e-mail — większość aplikacji pobierze ustawienia automatycznie.')}</li>
          <li>${L(locale, 'Manually: IMAP', 'Ręcznie: IMAP')} <code>mail.yourdomain</code> ${L(locale, 'port', 'port')} <code>993</code> SSL, SMTP ${L(locale, 'port', 'port')} <code>587</code> STARTTLS.</li>
          <li>${L(locale, 'The login is the full email address; the password is the webmail password.', 'Login to pełny adres e-mail, hasło takie jak do webmaila.')}</li>
        </ol>`)}
        ${card(L(locale, 'The site is not working', 'Strona nie działa?'), h`<ol class="small u-s13">
          <li>${L(locale, 'Check', 'Sprawdź')} <a class="link" href="/user/domains">${L(locale, 'domains', 'domeny')}</a> → <strong>${L(locale, 'Logs', 'Logi')}</strong> ${L(locale, 'to see whether the browser gets a 404/500 error.', 'czy przeglądarka nie dostaje błędu 404/500.')}</li>
          <li>${L(locale, 'Make sure the domain points to the right IP address (A record) and that DNS propagation is complete.', 'Upewnij się, że domena wskazuje na właściwy adres IP (rekord A) i że minęła propagacja DNS.')}</li>
          <li>${L(locale, 'If you just added the domain, wait up to 24 hours for DNS at your registrar.', 'Jeśli dopiero dodałeś domenę, odczekaj do 24 h na DNS u registrar.')}</li>
        </ol>`)}
        ${card(L(locale, 'Security and backups', 'Bezpieczeństwo i kopie'), h`<ul class="small u-s13">
          <li>${L(locale, 'Enable', 'Włącz')} <a class="link" href="/user/2fa">${L(locale, 'two-factor authentication', 'weryfikację dwuetapową')}</a> — ${L(locale, 'scan the QR code.', 'zeskanuj kod QR.')}</li>
          <li>${L(locale, 'Change your password in', 'Zmień hasło w')} <a class="link" href="/user/password">${L(locale, 'Account', 'Koncie')}</a>.</li>
          <li>${L(locale, 'Backups:', 'Kopie zapasowe:')} <a class="link" href="/user/backups">${L(locale, 'Backups', 'Kopie')}</a>; ${L(locale, 'an administrator can enable automatic backups in Server health.', 'administrator może włączyć automatyczne kopie w Stanie serwera.')}</li>
          <li>${L(locale, 'Never share the WordPress administrator password — it is shown only once.', 'Nie udostępniaj hasła administratora WordPressa — jest pokazywane tylko raz.')}</li>
        </ul>`)}
        ${card(L(locale, 'DNS at your registrar — what to enter?', 'DNS u registrar — co wpisać?'), h`<p class="small">${L(locale, 'After adding a site the panel shows ready-made records. The most common ones:', 'Po dodaniu strony panel pokazuje gotowe rekordy. Najczęściej:')}</p>
          <pre class="code-block small">A     @      YOUR_IP
A     www    YOUR_IP
MX    @      10 mail.yourdomain.com.
NS    @      ns1.yourserver
NS    @      ns2.yourserver</pre>
          <p class="small muted">${L(locale, 'If you are unsure where to put them, send these records to your registrar’s support.', 'Jeśli nie wiesz, gdzie to wpisać, wyślij te rekordy supportowi registrar.')}</p>`)}
        ${card(L(locale, 'WordPress — first steps', 'WordPress — pierwsze kroki'), h`<ol class="small u-s13">
          <li>${L(locale, 'After installation, save the administrator login and password (shown once).', 'Po instalacji zapisz login i hasło administratora (pokazywane raz).')}</li>
          <li>${L(locale, 'Open', 'Wejdź na')} <code>/wp-admin/</code> ${L(locale, 'and sign in.', 'i zaloguj się.')}</li>
          <li>${L(locale, 'Customise the site: Appearance → Themes; add posts and pages.', 'Zmotywuj stronę: Wygląd → Motywy, dodaj wpisy i strony.')}</li>
          <li>${L(locale, 'Update WordPress in WP admin; the panel handles backups.', 'Aktualizuj WordPressa w panelu WP; kopie robi panel.')}</li>
        </ol>`)}
      </div>
      ${card(L(locale, 'Still not working?', 'Nadal nie działa?'), h`<p class="small">${L(locale, 'Contact your administrator and include: the domain name, the site address, the time the error occurred and a screenshot. Logs are in', 'Skontaktuj się z administratorem i podaj: nazwę domeny, adres strony, godzinę wystąpienia błędu oraz zrzut ekranu. Logi znajdziesz w')} <a class="link" href="/user/domains">${L(locale, 'Domains → Logs', 'Domeny → Logi')}</a>.</p>`)}
    `;
    return page(ctx, {
      title: L(locale, 'Help', 'Pomoc'),
      subtitle: L(locale, 'Common tasks step by step', 'Najczęstsze zadania krok po kroku'),
      body,
    });
  });
}
