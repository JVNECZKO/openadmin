/* Client-side Polish layer for the remaining English UI strings. Server-rendered
   pages stay bilingual; when <html lang="pl"> this translates labels, buttons
   and placeholders without touching code or API payloads. */
(function () {
  if (document.documentElement.lang !== 'pl') return;
  var M = {
    'Dashboard': 'Pulpit', 'Statistics': 'Statystyki', 'Messages': 'Wiadomości',
    'Server overview': 'Przegląd serwera', 'Server and hosting overview': 'Serwer i hosting',
    'Create user': 'Utwórz użytkownika', 'Create reseller': 'Utwórz resellera', 'Server settings': 'Ustawienia serwera',
    'Users': 'Użytkownicy', 'Domains': 'Domeny', 'Bandwidth (30d)': 'Transfer (30 dni)', 'Memory': 'Pamięć',
    'Services': 'Usługi', 'Manage': 'Zarządzaj', 'Recent activity': 'Ostatnia aktywność', 'Audit log': 'Dziennik zdarzeń',
    'Open tickets': 'Otwarte zgłoszenia', 'All tickets': 'Wszystkie zgłoszenia', 'No open tickets': 'Brak otwartych zgłoszeń',
    'Backups': 'Kopie zapasowe', 'Server snapshots': 'Migawki serwera', 'Every action': 'Każda akcja',
    'Licensing': 'Licencja', 'Free, unlimited': 'Darmowa, bez limitów', 'Plugins': 'Wtyczki', 'Extend the panel': 'Rozszerz panel',
    'Server info': 'Informacje o serwerze', 'System Information': 'Informacje o systemie',
    'E-mail Accounts': 'Skrzynki e-mail', 'Email accounts': 'Skrzynki e-mail', 'Forwarders': 'Przekierowania',
    'Autoresponders': 'Autoodpowiedzi', 'Vacation Messages': 'Wiadomości urlopowe', 'Catch-All E-mail': 'Catch-all',
    'Mailing Lists': 'Listy mailingowe', 'SPAM Filters': 'Filtry spamu', 'Email Usage': 'Użycie poczty',
    'Add domain': 'Dodaj domenę', 'Add subdomain': 'Dodaj subdomenę', 'Add record': 'Dodaj rekord',
    'Create': 'Utwórz', 'Save': 'Zapisz', 'Cancel': 'Anuluj', 'Delete': 'Usuń', 'Edit': 'Edytuj',
    'Download': 'Pobierz', 'Restore': 'Przywróć', 'Upload': 'Wgraj', 'New folder': 'Nowy katalog',
    'Search': 'Szukaj', 'Actions': 'Akcje', 'Status': 'Status', 'Name': 'Nazwa', 'Type': 'Typ',
    'Value': 'Wartość', 'Priority': 'Priorytet', 'TTL': 'TTL', 'Active': 'Aktywna', 'Suspended': 'Zawieszona',
    'Enabled': 'Włączone', 'Disabled': 'Wyłączone', 'Unlimited': 'Bez limitu', 'Used': 'Użyte', 'Free': 'Darmowe',
    'Open': 'Otwórz', 'Close': 'Zamknij', 'Back': 'Wstecz', 'Next': 'Dalej', 'Previous': 'Poprzednie',
    'Submit': 'Wyślij', 'Install': 'Zainstaluj', 'Remove': 'Usuń', 'Update': 'Aktualizuj', 'Generate': 'Wygeneruj',
    'Copy': 'Kopiuj', 'Show': 'Pokaż', 'Hide': 'Ukryj', 'Refresh': 'Odśwież', 'Filter': 'Filtruj', 'Reset': 'Resetuj',
    'Create backup': 'Utwórz kopię', 'Create database': 'Utwórz bazę', 'Create mailbox': 'Utwórz skrzynkę',
    'Send': 'Wyślij', 'Reply': 'Odpowiedz', 'Compose': 'Nowa wiadomość', 'Inbox': 'Odebrane', 'Drafts': 'Wersje robocze',
    'Sent': 'Wysłane', 'Trash': 'Kosz', 'Logout': 'Wyloguj', 'Sign in': 'Zaloguj się', 'Username': 'Użytkownik',
    'Password': 'Hasło', 'Email': 'E-mail', 'Domain': 'Domena', 'Package': 'Pakiet', 'Owner': 'Właściciel',
    'Level': 'Poziom', 'Created': 'Utworzono', 'Expires': 'Wygasa', 'Size': 'Rozmiar', 'Disk': 'Dysk',
    'Disk usage': 'Użycie dysku', 'Bandwidth': 'Transfer', 'SSL certificates': 'Certyfikaty SSL',
    'Cron jobs': 'Zadania cron', 'FTP accounts': 'Konta FTP', 'Databases': 'Bazy danych',
    'Quick actions': 'Szybkie akcje', 'Resources': 'Zasoby', 'Top mailboxes': 'Największe skrzynki',
    'Your domains': 'Twoje domeny', 'Account limits': 'Limity konta', 'Usage report': 'Raport użycia',
    'All backups': 'Wszystkie kopie', 'Recent backups': 'Ostatnie kopie', 'No domains yet': 'Brak domen',
    'No mailboxes yet': 'Brak skrzynek', 'No backups yet': 'Brak kopii', 'No activity yet.': 'Brak aktywności',
    'Domains hosted on your account': 'Domeny na Twoim koncie', 'Domain Management': 'Strony i domeny',
    'File Management': 'Pliki', 'File Manager': 'Menedżer plików', 'FTP Management': 'Konta FTP',
    'FTP Settings': 'Ustawienia FTP', 'Cron Jobs': 'Zadania cron', 'Login Keys': 'Klucze logowania',
    'SSH Keys': 'Klucze SSH', 'Tickets': 'Zgłoszenia', 'Advanced': 'Zaawansowane', 'PHP Settings': 'Ustawienia PHP',
    'Error Pages': 'Strony błędów', 'Apache Handlers': 'Handlery Apache', 'MIME types': 'Typy MIME',
    'Password Protected Directories': 'Katalogi chronione', 'Hotlink Protection': 'Ochrona hotlink',
    'App Installer': 'Instalator aplikacji', 'Node.js / Python Apps': 'Aplikacje Node/Python',
    'ClamAV': 'Antywirus', 'IMAPSync Migrations': 'Migracja IMAP', 'Nginx Templates': 'Szablony Nginx',
    'Perl Modules': 'Moduły Perl', 'User Profile': 'Profil użytkownika',
    'E-mail Summary': 'Podsumowanie poczty', 'Mail Queue': 'Kolejka poczty', 'Process Monitor': 'Monitor procesów',
    'File Editor': 'Edytor plików', 'Log Viewer': 'Podgląd logów', 'CustomBuild': 'CustomBuild',
    'System Packages': 'Pakiety systemowe', 'Maintenance': 'Konserwacja', 'Multi Server': 'Wiele serwerów',
    'Admin Dashboard': 'Pulpit administratora', 'Administrator Settings': 'Ustawienia administratora',
    'System Services': 'Usługi systemowe', 'Web Server': 'Serwer WWW', 'Web Apps': 'Aplikacje WWW',
    'Login Customization': 'Personalizacja logowania', 'Customize Skin': 'Motyw', 'Skins': 'Motywy',
    'DNS Administration': 'Administracja DNS', 'Name Servers': 'Serwery nazw', 'IP Management': 'Zarządzanie IP',
    'Change Passwords': 'Zmiana haseł', 'Message All Users': 'Wiadomość do wszystkich', 'Add New User': 'Dodaj użytkownika',
    'My Users': 'Moi użytkownicy', 'Suspended Users': 'Zawieszeni użytkownicy', 'Move Users': 'Przenieś użytkowników',
    'Reseller Statistics': 'Statystyki resellera', 'Reseller Settings': 'Ustawienia resellera',
    'User Management': 'Zarządzanie użytkownikami', 'Reseller Tools': 'Narzędzia resellera',
    'New mailbox': 'Nowa skrzynka', 'New database': 'Nowa baza', 'New folder': 'Nowy katalog',
    'FTP account': 'Konto FTP', 'Backup': 'Kopia zapasowa', 'Cron job': 'Zadanie cron',
    'SSL certificate': 'Certyfikat SSL', 'Details': 'Szczegóły', 'Usage report': 'Raport użycia',
    'Package: default': 'Pakiet: domyślny', 'Free license': 'Darmowa licencja', 'Active': 'Aktywna',
    'Download a full backup': 'Pobierz pełną kopię', 'Scheduled commands': 'Zaplanowane polecenia',
    'MySQL / MariaDB': 'MySQL / MariaDB', 'File transfer user': 'Konto do plików',
    'Domain + SSL + WordPress': 'Domena + SSL + WordPress', 'Utwórz konto e-mail': 'Utwórz konto e-mail',
    'Primary and add-on domains': 'Domeny główne i dodatkowe', 'Storage used by mailbox': 'Miejsce zajęte przez skrzynki',
    'Overview of your hosting account': 'Przegląd Twojego konta hostingowego',
    'Welcome to OpenAdmin': 'Witaj w OpenAdmin',
    'Your hosting account is ready. The panel is 100% free and unlimited.': 'Twoje konto hostingowe jest gotowe. Panel jest w 100% darmowy i bez limitów.',
    'peak day': 'szczyt dnia', 'API': 'API', 'Documentation': 'Dokumentacja', 'License': 'Licencja',
    'free & open source (AGPL-3.0)': 'darmowy i open source (AGPL-3.0)',
    'of': 'z', 'unlimited': 'bez limitu', 'total': 'łącznie', 'avg': 'średnio',
    'Create Reseller': 'Utwórz resellera', 'List Resellers': 'Lista resellerów', 'Manage Reseller Packages': 'Pakiety resellerów',
    'Reseller package': 'Pakiet resellera', 'Primary domain': 'Domena główna', 'Create reseller': 'Utwórz resellera',
    'Save reseller': 'Zapisz resellera', 'Modify reseller': 'Edytuj resellera', 'Resellers can create and manage users': 'Resellerzy mogą tworzyć konta i zarządzać nimi',
    'Reseller Dashboard': 'Pulpit resellera', 'Reseller dashboard': 'Pulpit resellera', 'Recent users': 'Ostatnie konta',
    'Your limits': 'Twoje limity', 'Open tickets': 'Otwarte zgłoszenia', 'Reseller bandwidth': 'Transfer resellera',
    'All users': 'Wszyscy użytkownicy', 'All tickets': 'Wszystkie zgłoszenia', 'Packages': 'Pakiety', 'Package': 'Pakiet',
    'User Management': 'Zarządzanie użytkownikami', 'Reseller Overview': 'Przegląd resellera', 'Reseller Tools': 'Narzędzia resellera',
    'Manage User Packages': 'Pakiety użytkowników', 'Add New User': 'Dodaj użytkownika', 'My Users': 'Moi użytkownicy',
    'Suspended Users': 'Zawieszeni użytkownicy', 'Move Users': 'Przenieś użytkowników', 'IP Management': 'Zarządzanie IP',
    'DNS Administration': 'Administracja DNS', 'Name Servers': 'Serwery nazw', 'cPanel Import': 'Import cPanel',
    'Change Passwords': 'Zmiana haseł', 'Message All Users': 'Wiadomość do wszystkich', 'Security.txt': 'Security.txt',
    'Skins': 'Motywy', 'Reseller Settings': 'Ustawienia resellera', 'Reseller Statistics': 'Statystyki resellera',
    'Add a domain': 'Dodaj domenę', 'Domain name': 'Nazwa domeny', 'Web engine': 'Silnik WWW', 'SSL mode': 'Tryb SSL',
    'Create a DNS zone with default A, MX, SPF, DMARC and NS records': 'Utwórz strefę DNS z domyślnymi rekordami A, MX, SPF, DMARC i NS',
    'Existing domains': 'Istniejące domeny', 'Document root': 'Katalog strony', 'SSL enabled': 'SSL włączony',
    'Save domain': 'Zapisz domenę', 'Edit domain': 'Edytuj domenę', 'Create domain': 'Utwórz domenę',
    'Add domain': 'Dodaj domenę', 'Domain Management': 'Strony i domeny', 'DNS zone': 'Strefa DNS', 'Zone file': 'Plik strefy',
    'Rebuild zone': 'Odbuduj strefę', 'Add record': 'Dodaj rekord', 'Nameservers': 'Serwery nazw', 'Search pages and commands…': 'Szukaj stron i poleceń…',
    'Self-signed — works immediately (browser warning)': 'Self-signed — działa od razu (ostrzeżenie przeglądarki)',
    "Let's Encrypt — requires public DNS": "Let's Encrypt — wymaga publicznego DNS",
    'No SSL (HTTP only)': 'Bez SSL (tylko HTTP)', 'PHP version': 'Wersja PHP', 'Certificate': 'Certyfikat',
    'Private key': 'Klucz prywatny', 'Install certificate': 'Zainstaluj certyfikat', 'Issue certificate': 'Wystaw certyfikat',
    'Upload certificate': 'Wgraj certyfikat', 'Renew': 'Odnów', 'Expires': 'Wygasa',
    'Server certificates': 'Certyfikaty serwera', 'Panel certificate': 'Certyfikat panelu', 'Install panel certificate': 'Zainstaluj certyfikat panelu',
    'Web Server': 'Serwer WWW', 'Web servers': 'Serwery WWW', 'Active': 'Aktywny', 'Use': 'Użyj', 'Detected': 'Wykryty',
    'Not detected': 'Nie wykryto', 'Deploy configuration': 'Wdróż konfigurację', 'Test configuration': 'Testuj konfigurację',
    'Generate configuration': 'Wygeneruj konfigurację', 'PHP handler': 'Obsługa PHP', 'LiteSpeed Enterprise license': 'Licencja LiteSpeed Enterprise',
    'Backup / Restore': 'Kopie zapasowe', 'Server-wide backup management': 'Zarządzanie kopiami serwera', 'Create backup': 'Utwórz kopię',
    'Create server backup': 'Utwórz kopię serwera', 'Download': 'Pobierz', 'Restore': 'Przywróć', 'Delete': 'Usuń',
    'No backups yet': 'Brak kopii zapasowych', 'Backup file': 'Plik kopii', 'Created': 'Utworzono',
    'SSL/TLS Certificates': 'Certyfikaty SSL/TLS', 'SSL Certificates': 'Certyfikaty SSL', 'Certificate authority': 'Urząd certyfikacji',
    'AutoSSL': 'AutoSSL', 'Issue': 'Wystaw', 'Self-signed': 'Self-signed', "Let's Encrypt": "Let's Encrypt",
    'Add domain': 'Dodaj domenę', 'Add a website': 'Dodaj stronę', 'Create website': 'Utwórz stronę',
    'No users yet': 'Brak użytkowników', 'No domains yet': 'Brak domen', 'No mailboxes yet': 'Brak skrzynek',
    'No tickets yet': 'Brak zgłoszeń', 'No activity yet': 'Brak aktywności', 'No data': 'Brak danych',
    'Create user': 'Utwórz użytkownika', 'Create User': 'Utwórz użytkownika', 'Add user': 'Dodaj użytkownika',
    'Modify User': 'Edytuj użytkownika', 'Account': 'Konto', 'Account limits': 'Limity konta', 'Resources': 'Zasoby',
    'Quick actions': 'Szybkie akcje', 'Open': 'Otwórz', 'Close': 'Zamknij', 'Back': 'Wstecz', 'Next': 'Dalej',
    'Previous': 'Poprzednie', 'Save changes': 'Zapisz zmiany', 'Cancel': 'Anuluj', 'Refresh': 'Odśwież',
    'Run now': 'Uruchom teraz', 'Enable': 'Włącz', 'Disable': 'Wyłącz', 'Clear failures': 'Wyczyść błędy',
    'Recent runs': 'Ostatnie uruchomienia', 'Last run': 'Ostatnie uruchomienie', 'Next run': 'Następne uruchomienie',
    'Interval': 'Interwał', 'Job': 'Zadanie', 'Jobs': 'Zadania', 'Output': 'Wynik', 'Never': 'Nigdy',
    'due now': 'teraz', 'in': 'za', 'Global automation': 'Automatyzacja globalna', 'Automation settings': 'Ustawienia automatyzacji',
    'Disk threshold': 'Próg dysku', 'Temp retention': 'Retencja temp', 'Mail retry': 'Ponawianie poczty',
    'Recent activity': 'Ostatnia aktywność', 'Server overview': 'Przegląd serwera', 'Server and hosting overview': 'Serwer i hosting',
    'Create user': 'Utwórz użytkownika', 'Create reseller': 'Utwórz resellera', 'Server settings': 'Ustawienia serwera',
    'Free & open source': 'Darmowy i open source',
    'default': 'domyślny', 'sandbox': 'sandbox', 'detected': 'wykryty', 'not detected': 'nie wykryto',
    'sandbox: configuration is staged, no service is reloaded': 'sandbox: konfiguracja jest odkładana, usługa nie jest przeładowywana',
    'web server binary not detected on this host': 'nie wykryto binarki serwera WWW na tym hoście',
    'Automation': 'Automatyzacja', 'Live': 'Online', 'Auto-refresh': 'Auto-odświeżanie', 'OFF': 'WYŁ.', 'ON': 'WŁ.',
    'Create a new domain on your account and choose its web engine': 'Utwórz nową domenę i wybierz dla niej silnik WWW',
    'Availability is read from real binary/service detection. “Sandbox” means the configuration is staged instead of reloading a live service.': 'Dostępność pochodzi z realnej detekcji binarek i usług. „Sandbox” oznacza, że konfiguracja jest odkładana, a nie przeładowywana na żywej usłudze.',
    'Enter the domain without http:// or a trailing slash.': 'Wpisz domenę bez http:// i bez ukośnika na końcu.',
    'Availability is read from real binary/service detection. "Sandbox" means the configuration is staged instead of reloading a live service.': 'Dostępność pochodzi z realnej detekcji binarek i usług. „Sandbox” oznacza, że konfiguracja jest odkładana, a nie przeładowywana na żywej usłudze.',
    'The choice is stored per domain as web_server:<domain> and used for vhost generation.': 'Wybór jest zapisywany per domena jako web_server:<domena> i używany do generowania vhosta.',
    "Let's Encrypt needs public DNS; the panel falls back to self-signed and says so in the result.": "Let's Encrypt wymaga publicznego DNS; panel w razie błędu zainstaluje self-signed i pokaże to w wyniku.",
    'Creating the domain runs the same provisioning pipeline as the website wizard: domain row, docroot, engine override, DNS, SSL and vhost generation.': 'Utworzenie domeny uruchamia ten sam proces co kreator strony: wpis domeny, katalog, wybór silnika, DNS, SSL i generowanie vhosta.',
    'Web engine': 'Silnik WWW', 'Domain name': 'Nazwa domeny', 'SSL mode': 'Tryb SSL', 'Existing domains': 'Istniejące domeny',
    'Add a domain': 'Dodaj domenę', 'Create domain': 'Utwórz domenę'
  };
  var PATTERNS = [
    [/^(\d+)\s+domains?$/i, '$1 domen'],
    [/^(\d+)\s+users?$/i, '$1 użytkowników'],
    [/^(\d+)\s+resellers?$/i, '$1 resellerów'],
    [/^(\d+)\s+mailboxes?$/i, '$1 skrzynek'],
    [/^(\d+)\s+services? running\.?$/i, '$1 usług działa'],
    [/^(\d+)\s+message\(s\)$/i, '$1 wiadomości'],
    [/^1 account\(s\)$/i, '1 konto'], [/^(\d+)\s+account\(s\)$/i, '$1 kont'],
    [/^1 mailbox\(es\)$/i, '1 skrzynka'], [/^(\d+)\s+mailbox\(es\)$/i, '$1 skrzynek'],
    [/^1 installation\(s\)$/i, '1 instalacja'], [/^(\d+)\s+installation\(s\)$/i, '$1 instalacji'],
    [/^1 archive\(s\)$/i, '1 archiwum'], [/^(\d+)\s+archive\(s\)$/i, '$1 archiwów'],
    [/^1 process\(es\)$/i, '1 proces'], [/^(\d+)\s+process\(es\)$/i, '$1 procesów'],
    [/^1 certificate\(s\)$/i, '1 certyfikat'], [/^(\d+)\s+certificate\(s\)$/i, '$1 certyfikatów'],
    [/^Page (\d+) of (\d+)$/i, 'Strona $1 z $2'],
    [/^(\d+)\s+of\s+(\d+)$/i, '$1 z $2'],
    [/^of (.+)$/i, 'z $1'],
    [/^No (.+) yet\.$/i, 'Brak: $1'],
    [/^total · avg (.+)\/day$/i, 'łącznie · średnio $1/dzień'],
    [/^· unlimited accounts$/i, '· bez limitu kont'],
    [/^· (\d+) accounts$/i, '· $1 kont']

  ];
  var SKIP = { SCRIPT: 1, STYLE: 1, PRE: 1, CODE: 1, TEXTAREA: 1, KBD: 1, SAMP: 1 };
  function tr(text) {
    var key = text.trim();
    if (!key) return null;
    if (M[key]) return text.replace(key, M[key]);
    for (var i = 0; i < PATTERNS.length; i++) {
      if (PATTERNS[i][0].test(key)) return text.replace(key, key.replace(PATTERNS[i][0], PATTERNS[i][1]));
    }
    return null;
  }
  function walk(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      var p = node.parentElement;
      if (!p || SKIP[p.tagName] || p.closest('[data-no-i18n]')) continue;
      var out = tr(node.nodeValue);
      if (out !== null && out !== node.nodeValue) node.nodeValue = out;
    }
  }
  function attrs(root) {
    root.querySelectorAll('[placeholder],[title],[aria-label]').forEach(function (el) {
      ['placeholder', 'title', 'aria-label'].forEach(function (a) {
        var v = el.getAttribute(a);
        if (!v) return;
        var out = tr(v);
        if (out !== null) el.setAttribute(a, out);
      });
    });
  }
  function run() { walk(document.body); attrs(document); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
  new MutationObserver(function (muts) {
    muts.forEach(function (m) {
      m.addedNodes.forEach(function (n) {
        if (n.nodeType === 1) { walk(n); attrs(n); } else if (n.nodeType === 3 && n.parentElement) { var o = tr(n.nodeValue); if (o !== null) n.nodeValue = o; }
      });
    });
  }).observe(document.body, { childList: true, subtree: true });
})();
