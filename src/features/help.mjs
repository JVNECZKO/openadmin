// Contextual help for non-technical users.
import { html as h } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, alert } from '../ui/components.mjs';

export function register(router) {
  router.get('/user/help', (ctx) => {
    const body = h`
      ${alert('Najprościej: użyj przycisków „Dodaj stronę” i „Dodaj pocztę” na pulpicie. Reszta dzieje się automatycznie.', 'info')}
      <div class="grid grid-2">
        ${card('Jak postawić stronę?', h`<ol class="small" style="line-height:1.9;padding-left:18px">
          <li>Kliknij <strong>Dodaj stronę</strong> i wpisz domenę (np. <code>mojafirma.pl</code>).</li>
          <li>Wybierz silnik WWW: Nginx, Apache, OpenLiteSpeed albo LiteSpeed Enterprise. Kafelki pokazują, co jest realnie wykryte na serwerze.</li>
          <li>Wybierz PHP i certyfikat SSL — self-signed działa od razu, Let's Encrypt wymaga publicznego DNS.</li>
          <li>Dodaj subdomeny (np. <code>blog</code>, <code>sklep</code>) — każda dostanie własny vhost i rekord DNS.</li>
          <li>Opcjonalnie wybierz WordPress lub Nextcloud; instalator utworzy bazę i pokaże dane tylko raz.</li>
          <li>U registrar domeny ustaw rekordy DNS pokazane po utworzeniu strony.</li>
          <li>Pliki wgrasz w <a class="link" href="/user/files">Menedżerze plików</a>.</li>
        </ol>`)}
        ${card('Jak skonfigurować pocztę w telefonie?', h`<ol class="small" style="line-height:1.9;padding-left:18px">
          <li>Utwórz skrzynkę przez <strong>Dodaj pocztę</strong>.</li>
          <li>Otwórz <a class="link" href="/user/email/client-settings">Ustawienia klienta</a> i wybierz skrzynkę.</li>
          <li>Wpisz w telefonie adres e-mail — większość aplikacji pobierze ustawienia automatycznie.</li>
          <li>Ręcznie: IMAP <code>mail.twojadomena</code> port <code>993</code> SSL, SMTP port <code>587</code> STARTTLS.</li>
          <li>Login to pełny adres e-mail, hasło takie jak do webmaila.</li>
        </ol>`)}
        ${card('Strona nie działa?', h`<ol class="small" style="line-height:1.9;padding-left:18px">
          <li>Otwórz <a class="link" href="/admin/health">Stan serwera</a> (admin) — czerwone elementy mają przycisk naprawy.</li>
          <li>Sprawdź <a class="link" href="/user/domains">domeny</a> → <strong>Logi</strong>, czy przeglądarka nie dostaje błędu 404/500.</li>
          <li>Upewnij się, że domena wskazuje na właściwy adres IP (rekord A) i że minęła propagacja DNS.</li>
          <li>Jeśli dopiero dodałeś domenę, odczekaj do 24 h na DNS u registrar.</li>
        </ol>`)}
        ${card('Bezpieczeństwo i kopie', h`<ul class="small" style="line-height:1.9;padding-left:18px">
          <li>Włącz <a class="link" href="/user/2fa">weryfikację dwuetapową</a> — zeskanuj kod QR.</li>
          <li>Zmień hasło w <a class="link" href="/user/password">Koncie</a>.</li>
          <li>Kopie zapasowe: <a class="link" href="/user/backups">Backupy</a>; administrator może włączyć automatyczne kopie w Stanie serwera.</li>
          <li>Nie udostępniaj hasła administratora WordPressa — jest pokazywane tylko raz.</li>
        </ul>`)}
        ${card('DNS u registrar — co wpisać?', h`<p class="small">Po dodaniu strony panel pokazuje gotowe rekordy. Najczęściej:</p>
          <pre class="code-block small">A     @      TWOJE_IP
A     www    TWOJE_IP
MX    @      10 mail.twojadomena.pl.
NS    @      ns1.twojserwer
NS    @      ns2.twojserwer</pre>
          <p class="small muted">Jeśli nie wiesz, gdzie to wpisać, wyślij te rekordy supportowi registrar.</p>`)}
        ${card('WordPress — pierwsze kroki', h`<ol class="small" style="line-height:1.9;padding-left:18px">
          <li>Po instalacji zapisz login i hasło administratora (pokazywane raz).</li>
          <li>Wejdź na <code>/wp-admin/</code> i zaloguj się.</li>
          <li>Zmotywuj stronę: Wygląd → Motywy, dodaj wpisy i strony.</li>
          <li>Aktualizuj WordPressa w panelu WP; kopie robi panel.</li>
        </ol>`)}
      </div>
      ${card('Nadal nie działa?', h`<p class="small">Skontaktuj się z administratorem i podaj: nazwę domeny, adres strony, godzinę wystąpienia błędu oraz zrzut ekranu. Logi znajdziesz w <a class="link" href="/user/domains">Domeny → Logi</a>.</p>`)}`;
    return page(ctx, { title: 'Pomoc', subtitle: 'Najczęstsze zadania krok po kroku', body });
  });
}
