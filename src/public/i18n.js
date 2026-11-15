/* OpenAdmin locale layer (PL/EN).
 *
 * Responsibilities:
 *  - one complete message catalogue for every locale we ship;
 *  - locale resolution for the login/panel shell (query → cookie → account →
 *    browser), including the pre-login screens;
 *  - translation of server-rendered text that predates this layer;
 *  - localisation of empty/loading/error/stale/partial state components and
 *    the launch catalog filter messages;
 *  - a deterministic, testable API exposed as `OA_I18N`.
 *
 * The layer is intentionally dependency-free and idempotent. It never writes
 * raw placeholders (`undefined`, `null`, `NaN`, `[object Object]`,
 * `Nothing here yet`, `Brak: …`) into the document.
 */
(function (root) {
  'use strict';

  if (root.OA_I18N) return; // idempotent: the shell also injects this file.

  var LOCALES = ['pl', 'en'];
  var DEFAULT_LOCALE = 'en';
  var STORAGE_KEY = 'oa_lang';
  var COOKIE_KEY = 'oa_lang';
  var LOCALE_ATTR = 'data-oa-locale';

  /* ------------------------------------------------------------ messages */
  var MESSAGES = {
    pl: {
      'locale.name': 'Polski',
      'locale.switch': 'Zmień język',
      'locale.current': 'Bieżący język: polski',

      'common.yes': 'Tak',
      'common.no': 'Nie',
      'common.ok': 'OK',
      'common.unknown': 'Nieznany',
      'common.unavailable': 'Niedostępne',
      'common.notConfigured': 'Nie skonfigurowano',
      'common.noData': 'Brak danych',
      'common.loading': 'Ładowanie…',
      'common.actions': 'Akcje',
      'common.details': 'Szczegóły',
      'common.more': 'Więcej',
      'common.less': 'Mniej',
      'common.all': 'Wszystkie',
      'common.search': 'Szukaj',
      'common.filter': 'Filtruj',
      'common.reset': 'Resetuj',
      'common.refresh': 'Odśwież',
      'common.retry': 'Spróbuj ponownie',
      'common.dismiss': 'Zamknij komunikat',
      'common.close': 'Zamknij',
      'common.cancel': 'Anuluj',
      'common.save': 'Zapisz',
      'common.saveChanges': 'Zapisz zmiany',
      'common.create': 'Utwórz',
      'common.add': 'Dodaj',
      'common.edit': 'Edytuj',
      'common.delete': 'Usuń',
      'common.remove': 'Usuń',
      'common.open': 'Otwórz',
      'common.back': 'Wstecz',
      'common.next': 'Dalej',
      'common.continue': 'Kontynuuj',
      'common.install': 'Zainstaluj',
      'common.update': 'Aktualizuj',
      'common.generate': 'Wygeneruj',
      'common.copy': 'Kopiuj',
      'common.copied': 'Skopiowano',
      'common.download': 'Pobierz',
      'common.restore': 'Przywróć',
      'common.upload': 'Wgraj',
      'common.show': 'Pokaż',
      'common.hide': 'Ukryj',
      'common.enabled': 'Włączone',
      'common.disabled': 'Wyłączone',
      'common.unlimited': 'Bez limitu',
      'common.required': 'Pole wymagane',

      'state.loading': 'Ładowanie danych…',
      'state.loadingHint': 'Poczekaj, aż panel pobierze aktualny stan.',
      'state.empty': 'Dane pojawią się po dodaniu pierwszego elementu.',
      'state.emptyHint': 'Dodaj element lub zmień filtr, aby zobaczyć wyniki.',
      'state.error': 'Nie udało się pobrać danych.',
      'state.errorHint': 'Spróbuj ponownie. Jeśli błąd się powtarza, sprawdź logi serwera.',
      'state.unavailable': 'Dane są chwilowo niedostępne.',
      'state.unavailableHint': 'Źródło danych nie odpowiedziało. Odśwież widok za chwilę.',
      'state.permission': 'Nie masz uprawnień do tego widoku.',
      'state.permissionHint': 'Poproś administratora o odpowiedni zakres uprawnień.',
      'state.dependency': 'Brak wymaganej zależności.',
      'state.dependencyHint': 'Zainstaluj brakujący komponent lub skontaktuj się z administratorem.',
      'state.stale': 'Dane mogą być nieaktualne.',
      'state.staleHint': 'Ostatni pomiar jest starszy niż oczekiwany. Odśwież dane.',
      'state.partial': 'Część danych jest niedostępna.',
      'state.partialHint': 'Widok pokazuje tylko źródła, które odpowiedziały. Sprawdź szczegóły.',
      'state.lastUpdated': 'Ostatnia aktualizacja',
      'state.offline': 'Brak połączenia z serwerem.',
      'state.offlineHint': 'Sprawdź połączenie i spróbuj ponownie.',

      'empty.table': 'Dane pojawią się po dodaniu pierwszego elementu.',
      'empty.tableHint': 'Dodaj element lub zmień filtr, aby zobaczyć wyniki.',
      'empty.domains': 'Brak domen',
      'empty.domainsHint': 'Dodaj pierwszą domenę, aby uruchomić stronę, pocztę i SSL.',
      'empty.addDomain': 'Dodaj domenę',
      'empty.mailboxes': 'Brak skrzynek',
      'empty.mailboxesHint': 'Utwórz skrzynkę, aby odbierać pocztę na tej domenie.',
      'empty.createMailbox': 'Utwórz skrzynkę',
      'empty.activity': 'Brak ostatniej aktywności',
      'empty.activityHint': 'Twoje instalacje, kopie i zmiany pojawią się tutaj.',
      'empty.transfer': 'Brak danych o transferze',
      'empty.transferHint': 'Pojawią się po pierwszym okresie rozliczeniowym.',
      'empty.noResults': 'Brak wyników',
      'empty.noResultsHint': 'Zmień wyszukiwanie lub wyczyść filtry.',
      'empty.resetFilters': 'Wyczyść filtry',
      'empty.installed': 'Nie masz jeszcze aplikacji',
      'empty.installedHint': 'Wybierz kafelek powyżej — instalacja utworzy pliki, bazę i dane administratora.',
      'empty.chooseApp': 'Wybierz aplikację',
      'empty.available': 'Wszystkie aplikacje są już zainstalowane',
      'empty.availableHint': 'Przejdź do swoich instalacji, aby zarządzać aplikacjami.',
      'empty.showInstalled': 'Pokaż zainstalowane',

      'a11y.required': 'wymagane',
      'a11y.optional': 'opcjonalne',
      'a11y.closeDialog': 'Zamknij okno dialogowe',
      'a11y.closePanel': 'Zamknij panel',
      'a11y.actions': 'Akcje wiersza',
      'a11y.dataTable': 'Tabela danych',
      'a11y.selectAll': 'Zaznacz wszystkie wiersze',
      'a11y.selectRow': 'Zaznacz wiersz',
      'a11y.sections': 'Sekcje',
      'a11y.setupProgress': 'Postęp konfiguracji',
      'a11y.skipToContent': 'Przejdź do treści',
      'a11y.copy': 'Kopiuj',
      'a11y.copyValue': 'Kopiuj wartość',
      'a11y.searchApps': 'Szukaj aplikacji po nazwie',
      'a11y.filterApps': 'Filtruj aplikacje',
      'a11y.installForm': 'Formularz instalacji aplikacji',
      'a11y.installDetails': 'Dane instalacji',
      'a11y.passwordHint': 'Hasło musi mieć co najmniej 8 znaków.',
      'a11y.domainHint': 'Aplikacja zostanie zainstalowana na wybranej domenie.',

      'form.requiredHint': 'Pola oznaczone gwiazdką są wymagane.',
      'form.errorSummary': 'Popraw zaznaczone pola.',
      'form.fixErrors': 'Popraw błędy formularza.',
      'form.saving': 'Zapisywanie…',

      'status.active': 'Aktywna',
      'status.running': 'Działa',
      'status.complete': 'Zakończone',
      'status.enabled': 'Włączone',
      'status.open': 'Otwarte',
      'status.inProgress': 'W toku',
      'status.answered': 'Odpowiedziano',
      'status.suspended': 'Zawieszona',
      'status.stopped': 'Zatrzymana',
      'status.failed': 'Błąd',
      'status.pending': 'Oczekuje',
      'status.warning': 'Ostrzeżenie',
      'status.free': 'Darmowe',
      'status.shared': 'Współdzielone',
      'status.server': 'Serwer',
      'status.closed': 'Zamknięte',
      'status.expired': 'Wygasło',

      'login.title': 'Zaloguj się do panelu',
      'login.subtitle': 'Te same dane logowania dla admina, resellera i użytkownika.',
      'login.username': 'Użytkownik',
      'login.password': 'Hasło',
      'login.usernamePlaceholder': 'twoja-nazwa',
      'login.remember': 'Zapamiętaj mnie',
      'login.forgot': 'Nie pamiętasz hasła?',
      'login.signIn': 'Zaloguj się',
      'login.needAccount': 'Potrzebujesz konta? Skontaktuj się z hostingodawcą. Panel jest wolnym oprogramowaniem na licencji AGPL-3.0.',
      'login.demoTitle': 'Konta demo',
      'login.demoUser': 'Użytkownik',
      'login.demoReseller': 'Reseller',
      'login.demoAdmin': 'Admin',
      'login.demoHint': 'Kliknij konto demo, aby wypełnić formularz.',
      'login.asideTagline': 'Darmowy na zawsze · bez limitu domen',
      'login.asideTitle': 'Wszystko, czego potrzebuje serwer — bez opłat.',
      'login.asideBody': 'Panel zgodny z DirectAdmin dla adminów, resellerów i użytkowników — domeny, DNS, poczta, bazy, pliki, kopie i SSL w jednym miejscu.',
      'login.asideLevels': 'Panele Admin · Reseller · Użytkownik',
      'login.asideCommands': 'Zgodne API CMD_API DirectAdmin',
      'login.asideFree': 'Darmowa licencja, bez limitu kont',
      'login.statLevels': 'poziomy panelu',
      'login.statCommands': 'zmapowane komendy',
      'login.statForever': 'na zawsze',
      'login.footerFree': '100% darmowy · bez opłat licencyjnych',
      'login.hostingPanel': 'Panel hostingowy',
      'login.errorExpired': 'Sesja wygasła. Zaloguj się ponownie.',
      'login.errorInvalid': 'Nieprawidłowa nazwa użytkownika lub hasło.',
      'login.errorRate': 'Zbyt wiele nieudanych prób. Spróbuj ponownie za kilka minut.',
      'login.errorSuspended': 'Konto jest zawieszone. Skontaktuj się z resellerem lub administratorem.',
      'login.expiredNotice': 'Sesja wygasła. Zaloguj się ponownie.',

      'recovery.title': 'Zresetuj hasło',
      'recovery.subtitle': 'Poproś dostawcę o reset hasła',
      'recovery.help': 'Ze względów bezpieczeństwa reset hasła wykonuje administrator lub reseller. Poproś go o nowe hasło z panelu albo uruchom <code>openadmin passwd &lt;username&gt;</code> na serwerze.',
      'recovery.account': 'Nazwa użytkownika lub e-mail',
      'recovery.accountPlaceholder': 'twoja-nazwa',
      'recovery.submit': 'Wyślij prośbę o reset hasła',
      'recovery.back': 'Wróć do logowania',
      'recovery.requested': 'Jeśli konto istnieje, wysłaliśmy prośbę o reset hasła.',
      'recovery.newPassword': 'Nowe hasło',
      'recovery.repeatPassword': 'Powtórz hasło',
      'recovery.save': 'Zapisz hasło',
      'recovery.invalidToken': 'Link wygasł lub jest nieprawidłowy. Poproś o nowy.',
      'recovery.shortPassword': 'Hasło musi mieć co najmniej 8 znaków.',
      'recovery.mismatch': 'Hasła nie są identyczne.',
      'recovery.noAccount': 'Konto nie istnieje.',
      'recovery.changed': 'Hasło zostało zmienione. Zaloguj się.',
      'recovery.titleSet': 'Ustaw nowe hasło',

      'palette.title': 'Paleta poleceń',
      'palette.search': 'Szukaj stron, ustawień i poleceń…',
      'palette.results': 'Polecenia i strony',
      'palette.actions': 'Akcje',
      'palette.navigate': 'nawiguj',
      'palette.open': 'otwórz',
      'palette.close': 'zamknij',
      'palette.noMatches': 'Brak wyników dla „{query}”.',
      'palette.tryHint': 'Spróbuj „motyw”, „domeny” lub „kopia”.',
      'palette.switchLight': 'Przełącz na jasny motyw',
      'palette.switchDark': 'Przełącz na ciemny motyw',
      'palette.refresh': 'Odśwież tę stronę',
      'palette.toggleAutoOn': 'Włącz automatyczne odświeżanie',
      'palette.toggleAutoOff': 'Wyłącz automatyczne odświeżanie',
      'palette.notifications': 'Otwórz powiadomienia',
      'palette.signOut': 'Wyloguj się',
      'palette.resultCount': '{count} wyników',

      'dashboard.title': 'Pulpit',
      'dashboard.subtitle': 'Przegląd Twojego konta hostingowego',
      'dashboard.package': 'Pakiet',
      'dashboard.suspended': 'Zawieszona',
      'dashboard.active': 'Aktywna',
      'dashboard.freeLicense': 'Darmowa licencja',
      'dashboard.accountOn': 'Twoje konto jest na serwerze',
      'dashboard.included': 'Wszystko poniżej jest w cenie — bez dodatkowych opłat za domeny.',
      'dashboard.launchSite': 'Postaw stronę',
      'dashboard.addMailbox': 'Dodaj pocztę',
      'dashboard.applications': 'Aplikacje',
      'dashboard.domainWizard': 'Domena, vhost, DNS i SSL w jednym kreatorze',
      'dashboard.online': 'Online',
      'dashboard.updated': 'Zaktualizowano',
      'dashboard.refresh': 'Odśwież dane',
      'dashboard.domains': 'Domeny',
      'dashboard.activeDomains': 'aktywne domeny',
      'dashboard.emailAccounts': 'Skrzynki e-mail',
      'dashboard.mailboxes': 'skrzynki',
      'dashboard.diskUsage': 'Użycie dysku',
      'dashboard.bandwidth': 'Transfer (30 dni)',
      'dashboard.of': 'z',
      'dashboard.unlimited': 'bez limitu',
      'dashboard.firstSteps': 'Pierwsze kroki',
      'dashboard.done': 'gotowe',
      'dashboard.everythingReady': 'Wszystko gotowe — konto pracuje',
      'dashboard.nextStep': 'Następny krok',
      'dashboard.toDo': 'do zrobienia',
      'dashboard.next': 'następny krok',
      'dashboard.setupProgress': 'Postęp konfiguracji',
      'dashboard.open': 'Otwórz',
      'dashboard.appsOneClick': 'Aplikacje — jeden klik',
      'dashboard.installedApplications': 'zainstalowanych aplikacji',
      'dashboard.installedOne': 'zainstalowana aplikacja',
      'dashboard.availableToInstall': 'gotowa do instalacji',
      'dashboard.ready': 'gotowa',
      'dashboard.manage': 'Zarządzaj',
      'dashboard.openInstaller': 'Otwórz instalator',
      'dashboard.sixApps': 'Sześć gotowych aplikacji — instalujesz na własnej domenie',
      'dashboard.fullCatalogue': 'Cały katalog',
      'dashboard.accountResources': 'Zasoby konta',
      'dashboard.basedOnPackage': 'Na podstawie pakietu',
      'dashboard.usageReport': 'Raport użycia',
      'dashboard.yourDomains': 'Twoje domeny',
      'dashboard.addSite': 'Dodaj stronę',
      'dashboard.topMailboxes': 'Największe skrzynki',
      'dashboard.storageMailbox': 'Miejsce zajęte przez skrzynki',
      'dashboard.newMailbox': 'Nowa skrzynka',
      'dashboard.createMailbox': 'Utwórz skrzynkę',
      'dashboard.quickActions': 'Szybkie akcje',
      'dashboard.allTools': 'Wszystkie narzędzia',
      'dashboard.allToolsSub': 'Wszystko, co może Twoje konto hostingowe',
      'dashboard.newDatabase': 'Nowa baza',
      'dashboard.fileTransferUser': 'Konto do plików',
      'dashboard.transfer': 'Transfer',
      'dashboard.last30': 'Ostatnie 30 dni',
      'dashboard.total': 'łącznie',
      'dashboard.avgPerDay': 'średnio {value}/dzień',
      'dashboard.peakDay': 'dzień szczytowy',
      'dashboard.noLimit': 'Bez limitu',
      'dashboard.within': 'W normie',
      'dashboard.nearLimit': 'Blisko limitu',
      'dashboard.almostFull': 'Prawie pełny',
      'dashboard.overLimit': 'Limit przekroczony',
      'dashboard.recentActivity': 'Ostatnia aktywność',
      'dashboard.activitySub': 'Instalacje, kopie i zmiany na koncie',
      'dashboard.automations': 'Automatyzacje',
      'dashboard.automationSub': 'Realny stan z panelu',
      'dashboard.acme': 'Odnawianie SSL (ACME)',
      'dashboard.backups': 'Kopie zapasowe',
      'dashboard.notConfigured': 'Nieskonfigurowane',
      'dashboard.configuredOff': 'Wyłączone',
      'dashboard.configuredOn': 'Włączone',
      'dashboard.running': 'Działa',
      'dashboard.lastError': 'Ostatni błąd',
      'dashboard.scheduled': 'Zaplanowane',
      'dashboard.manual': 'Ręczne',
      'dashboard.acmeHint': 'Ustaw challenge i auto-renew, aby certyfikaty odnawiały się same.',
      'dashboard.acmeSettings': 'Ustawienia ACME',
      'dashboard.autoRenew': 'Auto-odnawianie',
      'dashboard.noBackupJob': 'Brak zadania automatycznego dla tego konta — kopię utworzysz ręcznie.',
      'dashboard.notRunYet': 'jeszcze nie uruchamiano',
      'dashboard.lastRun': 'ostatnio',
      'dashboard.backupStatus': 'Kopie zapasowe',
      'dashboard.auditLogin': 'Logowanie do panelu',
      'dashboard.auditLogout': 'Wylogowanie z panelu',
      'dashboard.auditPasswordChange': 'Zmieniono hasło',
      'dashboard.auditPasswordReset': 'Zgłoszono reset hasła',
      'dashboard.auditSiteCreate': 'Utworzono stronę automatycznie',
      'dashboard.auditSiteCheck': 'Sprawdzono konfigurację strony',
      'dashboard.auditSiteRedeploy': 'Wdrożono stronę ponownie',
      'dashboard.auditSiteRejected': 'Odrzucono konfigurację strony',
      'dashboard.auditSubdomainCreate': 'Dodano subdomenę',
      'dashboard.auditSubdomainUpdate': 'Zmieniono subdomenę',
      'dashboard.auditDnsCreate': 'Dodano rekord DNS',
      'dashboard.auditDnsUpdate': 'Zmieniono rekord DNS',
      'dashboard.auditTicketCreate': 'Nowe zgłoszenie',
      'dashboard.auditWebdiskCreate': 'Utworzono konto WebDisk',
      'dashboard.auditWpInstall': 'Zainstalowano WordPress',
      'dashboard.auditWpDelete': 'Usunięto WordPress',
      'dashboard.auditNcInstall': 'Zainstalowano Nextcloud',
      'dashboard.auditNcDelete': 'Usunięto Nextcloud',
      'dashboard.auditSslIssue': 'Wystawiono certyfikat SSL',
      'dashboard.auditSslRenew': 'Odnowiono certyfikat SSL',
      'dashboard.auditBackupCreate': 'Utworzono kopię zapasową',
      'dashboard.auditBackupRestore': 'Przywrócono kopię zapasową',
      'dashboard.auditDatabaseCreate': 'Utworzono bazę danych',
      'dashboard.auditDatabaseDelete': 'Usunięto bazę danych',
      'dashboard.auditDomainCreate': 'Dodano domenę',
      'dashboard.auditDomainDelete': 'Usunięto domenę',
      'dashboard.auditEmailCreate': 'Utworzono skrzynkę e-mail',
      'dashboard.auditFtpCreate': 'Utworzono konto FTP',
      'dashboard.auditCronCreate': 'Dodano zadanie cron',
      'dashboard.ticket': 'Zgłoszenie',
      'dashboard.wpReady': 'WordPress gotowy do pracy',
      'dashboard.backup': 'Kopia zapasowa',
      'dashboard.installed': 'Zainstalowano',
      'dashboard.everythingAccount': 'Wszystko, co może Twoje konto hostingowe',
      'dashboard.domain': 'Domena',
      'dashboard.files': 'Pliki',
      'dashboard.sslOff': 'Wyłączony',
      'dashboard.sslOn': 'Włączony',
      'dashboard.sshEnabled': 'włączony',
      'dashboard.sshDisabled': 'wyłączony',
      'dashboard.storageUsed': 'Miejsce zajęte przez skrzynki',

      'appcatalog.title': 'Aplikacje',
      'appcatalog.subtitle': 'WordPress, Nextcloud, PrestaShop, Joomla, Drupal, Moodle — jednym kliknięciem',
      'appcatalog.all': 'Wszystkie',
      'appcatalog.installed': 'Zainstalowane',
      'appcatalog.available': 'Dostępne',
      'appcatalog.searchPlaceholder': 'Szukaj aplikacji…',
      'appcatalog.yourApps': 'Twoje aplikacje',
      'appcatalog.install': 'Zainstaluj',
      'appcatalog.installAnother': 'Zainstaluj kolejną',
      'appcatalog.installedCount': 'Zainstalowane: {count}',
      'appcatalog.availableBadge': 'Dostępna',
      'appcatalog.versionLatest': 'Wersja: najnowsza',
      'appcatalog.nativeInstaller': 'Natywny instalator',
      'appcatalog.webInstaller': 'Instalator WWW',
      'appcatalog.cliWeb': 'CLI + WWW',

      'help.title': 'Pomoc',
      'help.subtitle': 'Najczęstsze zadania krok po kroku',
      'help.intro': 'Najprościej: użyj przycisków „Dodaj stronę” i „Dodaj pocztę” na pulpicie. Reszta dzieje się automatycznie.'
    },
    en: {
      'locale.name': 'English',
      'locale.switch': 'Change language',
      'locale.current': 'Current language: English',

      'common.yes': 'Yes',
      'common.no': 'No',
      'common.ok': 'OK',
      'common.unknown': 'Unknown',
      'common.unavailable': 'Unavailable',
      'common.notConfigured': 'Not configured',
      'common.noData': 'No data',
      'common.loading': 'Loading…',
      'common.actions': 'Actions',
      'common.details': 'Details',
      'common.more': 'More',
      'common.less': 'Less',
      'common.all': 'All',
      'common.search': 'Search',
      'common.filter': 'Filter',
      'common.reset': 'Reset',
      'common.refresh': 'Refresh',
      'common.retry': 'Try again',
      'common.dismiss': 'Dismiss message',
      'common.close': 'Close',
      'common.cancel': 'Cancel',
      'common.save': 'Save',
      'common.saveChanges': 'Save changes',
      'common.create': 'Create',
      'common.add': 'Add',
      'common.edit': 'Edit',
      'common.delete': 'Delete',
      'common.remove': 'Remove',
      'common.open': 'Open',
      'common.back': 'Back',
      'common.next': 'Next',
      'common.continue': 'Continue',
      'common.install': 'Install',
      'common.update': 'Update',
      'common.generate': 'Generate',
      'common.copy': 'Copy',
      'common.copied': 'Copied',
      'common.download': 'Download',
      'common.restore': 'Restore',
      'common.upload': 'Upload',
      'common.show': 'Show',
      'common.hide': 'Hide',
      'common.enabled': 'Enabled',
      'common.disabled': 'Disabled',
      'common.unlimited': 'Unlimited',
      'common.required': 'Required field',

      'state.loading': 'Loading data…',
      'state.loadingHint': 'Wait while the panel fetches the current state.',
      'state.empty': 'Data will appear here after the first item is added.',
      'state.emptyHint': 'Add an item or change the filter to see results.',
      'state.error': 'Could not load data.',
      'state.errorHint': 'Try again. If the error repeats, check the server log.',
      'state.unavailable': 'Data is temporarily unavailable.',
      'state.unavailableHint': 'The data source did not answer. Refresh this view in a moment.',
      'state.permission': 'You do not have permission to view this.',
      'state.permissionHint': 'Ask an administrator for the required permissions.',
      'state.dependency': 'A required dependency is missing.',
      'state.dependencyHint': 'Install the missing component or contact an administrator.',
      'state.stale': 'This data may be out of date.',
      'state.staleHint': 'The last measurement is older than expected. Refresh the data.',
      'state.partial': 'Some data is unavailable.',
      'state.partialHint': 'This view shows only the sources that answered. Check the details.',
      'state.lastUpdated': 'Last updated',
      'state.offline': 'No connection to the server.',
      'state.offlineHint': 'Check your connection and try again.',

      'empty.table': 'Data will appear here after the first item is added.',
      'empty.tableHint': 'Add an item or change the filter to see results.',
      'empty.domains': 'No domains',
      'empty.domainsHint': 'Add your first domain to launch a website, email and SSL.',
      'empty.addDomain': 'Add a domain',
      'empty.mailboxes': 'No mailboxes',
      'empty.mailboxesHint': 'Create a mailbox to receive email on this domain.',
      'empty.createMailbox': 'Create a mailbox',
      'empty.activity': 'No recent activity',
      'empty.activityHint': 'Your installations, backups and changes will appear here.',
      'empty.transfer': 'No transfer data',
      'empty.transferHint': 'It will appear after the first billing period.',
      'empty.noResults': 'No results',
      'empty.noResultsHint': 'Change the search or clear the filters.',
      'empty.resetFilters': 'Clear filters',
      'empty.installed': 'You have no applications yet',
      'empty.installedHint': 'Pick a tile above — installation creates files, a database and admin credentials.',
      'empty.chooseApp': 'Choose an application',
      'empty.available': 'All applications are installed',
      'empty.availableHint': 'Open your installations to manage applications.',
      'empty.showInstalled': 'Show installed',

      'a11y.required': 'required',
      'a11y.optional': 'optional',
      'a11y.closeDialog': 'Close dialog',
      'a11y.closePanel': 'Close panel',
      'a11y.actions': 'Row actions',
      'a11y.dataTable': 'Data table',
      'a11y.selectAll': 'Select all rows',
      'a11y.selectRow': 'Select row',
      'a11y.sections': 'Sections',
      'a11y.setupProgress': 'Setup progress',
      'a11y.skipToContent': 'Skip to content',
      'a11y.copy': 'Copy',
      'a11y.copyValue': 'Copy value',
      'a11y.searchApps': 'Search applications by name',
      'a11y.filterApps': 'Filter applications',
      'a11y.installForm': 'Application installation form',
      'a11y.installDetails': 'Installation details',
      'a11y.passwordHint': 'The password must be at least 8 characters long.',
      'a11y.domainHint': 'The application will be installed on the selected domain.',

      'form.requiredHint': 'Fields marked with an asterisk are required.',
      'form.errorSummary': 'Fix the highlighted fields.',
      'form.fixErrors': 'Fix the form errors.',
      'form.saving': 'Saving…',

      'status.active': 'Active',
      'status.running': 'Running',
      'status.complete': 'Complete',
      'status.enabled': 'Enabled',
      'status.open': 'Open',
      'status.inProgress': 'In progress',
      'status.answered': 'Answered',
      'status.suspended': 'Suspended',
      'status.stopped': 'Stopped',
      'status.failed': 'Failed',
      'status.pending': 'Pending',
      'status.warning': 'Warning',
      'status.free': 'Free',
      'status.shared': 'Shared',
      'status.server': 'Server',
      'status.closed': 'Closed',
      'status.expired': 'Expired',

      'login.title': 'Sign in to your panel',
      'login.subtitle': 'Use the same credentials for admin, reseller and user access.',
      'login.username': 'Username',
      'login.password': 'Password',
      'login.usernamePlaceholder': 'your-username',
      'login.remember': 'Remember me',
      'login.forgot': 'Forgot password?',
      'login.signIn': 'Sign in',
      'login.needAccount': 'Need an account? Contact your hosting provider. This panel is free software under the AGPL-3.0.',
      'login.demoTitle': 'Live demo accounts',
      'login.demoUser': 'User',
      'login.demoReseller': 'Reseller',
      'login.demoAdmin': 'Admin',
      'login.demoHint': 'Click a demo account to fill the form.',
      'login.asideTagline': 'Free forever · unlimited domains',
      'login.asideTitle': 'Everything your server needs, nothing you have to pay for.',
      'login.asideBody': 'A DirectAdmin-compatible control panel for admins, resellers and users — domains, DNS, email, databases, files, backups and SSL in one place.',
      'login.asideLevels': 'Admin · Reseller · User panels',
      'login.asideCommands': 'DirectAdmin-compatible CMD_API',
      'login.asideFree': 'Free licensing, unlimited accounts',
      'login.statLevels': 'panel levels',
      'login.statCommands': 'mapped commands',
      'login.statForever': 'forever',
      'login.footerFree': '100% free · no license fees',
      'login.hostingPanel': 'Hosting Control Panel',
      'login.errorExpired': 'Your session expired. Please sign in again.',
      'login.errorInvalid': 'Invalid username or password.',
      'login.errorRate': 'Too many failed attempts. Try again in a few minutes.',
      'login.errorSuspended': 'This account is suspended. Contact your reseller or administrator.',
      'login.expiredNotice': 'Your session expired. Please sign in again.',

      'recovery.title': 'Reset your password',
      'recovery.subtitle': 'Request a password reset from your provider',
      'recovery.help': 'For security, password resets are handled by your administrator or reseller. Ask them to issue a new password from the panel, or run <code>openadmin passwd &lt;username&gt;</code> on the server.',
      'recovery.account': 'Username or email',
      'recovery.accountPlaceholder': 'your-username',
      'recovery.submit': 'Send reset request',
      'recovery.back': 'Back to sign in',
      'recovery.requested': 'If the account exists, we sent a password reset request.',
      'recovery.newPassword': 'New password',
      'recovery.repeatPassword': 'Repeat password',
      'recovery.save': 'Save password',
      'recovery.invalidToken': 'This link expired or is invalid. Request a new one.',
      'recovery.shortPassword': 'The password must be at least 8 characters long.',
      'recovery.mismatch': 'The passwords do not match.',
      'recovery.noAccount': 'The account does not exist.',
      'recovery.changed': 'The password has been changed. Sign in.',
      'recovery.titleSet': 'Set a new password',

      'palette.title': 'Command palette',
      'palette.search': 'Search pages, settings and commands…',
      'palette.results': 'Commands and pages',
      'palette.actions': 'Actions',
      'palette.navigate': 'navigate',
      'palette.open': 'open',
      'palette.close': 'close',
      'palette.noMatches': 'No matches for “{query}”.',
      'palette.tryHint': 'Try “theme”, “domains” or “backup”.',
      'palette.switchLight': 'Switch to light theme',
      'palette.switchDark': 'Switch to dark theme',
      'palette.refresh': 'Refresh this page',
      'palette.toggleAutoOn': 'Turn on auto-refresh',
      'palette.toggleAutoOff': 'Turn off auto-refresh',
      'palette.notifications': 'Open notifications',
      'palette.signOut': 'Sign out',
      'palette.resultCount': '{count} results',

      'dashboard.title': 'Dashboard',
      'dashboard.subtitle': 'Overview of your hosting account',
      'dashboard.package': 'Package',
      'dashboard.suspended': 'Suspended',
      'dashboard.active': 'Active',
      'dashboard.freeLicense': 'Free license',
      'dashboard.accountOn': 'Your account is hosted on',
      'dashboard.included': 'Everything below is included — no add-ons, no per-domain fees.',
      'dashboard.launchSite': 'Launch site wizard',
      'dashboard.addMailbox': 'Add mailbox',
      'dashboard.applications': 'Applications',
      'dashboard.domainWizard': 'Domain, vhost, DNS and SSL in one wizard',
      'dashboard.online': 'Online',
      'dashboard.updated': 'Updated',
      'dashboard.refresh': 'Refresh',
      'dashboard.domains': 'Domains',
      'dashboard.activeDomains': 'active domains',
      'dashboard.emailAccounts': 'Email accounts',
      'dashboard.mailboxes': 'mailboxes',
      'dashboard.diskUsage': 'Disk usage',
      'dashboard.bandwidth': 'Bandwidth (30d)',
      'dashboard.of': 'of',
      'dashboard.unlimited': 'unlimited',
      'dashboard.firstSteps': 'First steps',
      'dashboard.done': 'done',
      'dashboard.everythingReady': 'Everything is ready — your account is running',
      'dashboard.nextStep': 'Next',
      'dashboard.toDo': 'to do',
      'dashboard.next': 'next',
      'dashboard.setupProgress': 'Setup progress',
      'dashboard.open': 'Open',
      'dashboard.appsOneClick': 'Applications — one click',
      'dashboard.installedApplications': 'installed applications',
      'dashboard.installedOne': 'installed application',
      'dashboard.availableToInstall': 'available to install',
      'dashboard.ready': 'ready',
      'dashboard.manage': 'Manage',
      'dashboard.openInstaller': 'Open installer',
      'dashboard.sixApps': 'Six production-ready apps, installed on your own domain',
      'dashboard.fullCatalogue': 'Full catalogue',
      'dashboard.accountResources': 'Account resources',
      'dashboard.basedOnPackage': 'Based on your package ',
      'dashboard.usageReport': 'Usage report',
      'dashboard.yourDomains': 'Your domains',
      'dashboard.addSite': 'Add site',
      'dashboard.topMailboxes': 'Top mailboxes',
      'dashboard.storageMailbox': 'Storage used by mailbox',
      'dashboard.newMailbox': 'New mailbox',
      'dashboard.createMailbox': 'Create mailbox',
      'dashboard.quickActions': 'Quick actions',
      'dashboard.allTools': 'All tools',
      'dashboard.allToolsSub': 'Everything your hosting account can do',
      'dashboard.newDatabase': 'New database',
      'dashboard.fileTransferUser': 'File transfer user',
      'dashboard.transfer': 'Transfer',
      'dashboard.last30': 'Last 30 days',
      'dashboard.total': 'total',
      'dashboard.avgPerDay': 'avg {value}/day',
      'dashboard.peakDay': 'Peak day',
      'dashboard.noLimit': 'No limit',
      'dashboard.within': 'Within limits',
      'dashboard.nearLimit': 'Near limit',
      'dashboard.almostFull': 'Almost full',
      'dashboard.overLimit': 'Limit exceeded',
      'dashboard.recentActivity': 'Recent activity',
      'dashboard.activitySub': 'Installations, backups and changes on the account',
      'dashboard.automations': 'Automations',
      'dashboard.automationSub': 'Real state from the panel',
      'dashboard.acme': 'SSL renewal (ACME)',
      'dashboard.backups': 'Backups',
      'dashboard.notConfigured': 'Not configured',
      'dashboard.configuredOff': 'Disabled',
      'dashboard.configuredOn': 'Enabled',
      'dashboard.running': 'Running',
      'dashboard.lastError': 'Last error',
      'dashboard.scheduled': 'Scheduled',
      'dashboard.manual': 'Manual',
      'dashboard.acmeHint': 'Set the challenge and auto-renew so certificates renew themselves.',
      'dashboard.acmeSettings': 'ACME settings',
      'dashboard.autoRenew': 'Auto-renew',
      'dashboard.noBackupJob': 'No automatic job for this account — create backups manually.',
      'dashboard.notRunYet': 'not run yet',
      'dashboard.lastRun': 'last run',
      'dashboard.backupStatus': 'Backups',
      'dashboard.auditLogin': 'Signed in to the panel',
      'dashboard.auditLogout': 'Signed out of the panel',
      'dashboard.auditPasswordChange': 'Password changed',
      'dashboard.auditPasswordReset': 'Password reset requested',
      'dashboard.auditSiteCreate': 'Site created automatically',
      'dashboard.auditSiteCheck': 'Site configuration checked',
      'dashboard.auditSiteRedeploy': 'Site redeployed',
      'dashboard.auditSiteRejected': 'Site configuration rejected',
      'dashboard.auditSubdomainCreate': 'Subdomain added',
      'dashboard.auditSubdomainUpdate': 'Subdomain changed',
      'dashboard.auditDnsCreate': 'DNS record added',
      'dashboard.auditDnsUpdate': 'DNS record changed',
      'dashboard.auditTicketCreate': 'New ticket',
      'dashboard.auditWebdiskCreate': 'WebDisk account created',
      'dashboard.auditWpInstall': 'WordPress installed',
      'dashboard.auditWpDelete': 'WordPress removed',
      'dashboard.auditNcInstall': 'Nextcloud installed',
      'dashboard.auditNcDelete': 'Nextcloud removed',
      'dashboard.auditSslIssue': 'SSL certificate issued',
      'dashboard.auditSslRenew': 'SSL certificate renewed',
      'dashboard.auditBackupCreate': 'Backup created',
      'dashboard.auditBackupRestore': 'Backup restored',
      'dashboard.auditDatabaseCreate': 'Database created',
      'dashboard.auditDatabaseDelete': 'Database removed',
      'dashboard.auditDomainCreate': 'Domain added',
      'dashboard.auditDomainDelete': 'Domain removed',
      'dashboard.auditEmailCreate': 'Email account created',
      'dashboard.auditFtpCreate': 'FTP account created',
      'dashboard.auditCronCreate': 'Cron job added',
      'dashboard.ticket': 'Ticket',
      'dashboard.wpReady': 'WordPress ready to use',
      'dashboard.backup': 'Backup',
      'dashboard.installed': 'Installed',
      'dashboard.everythingAccount': 'Everything your hosting account can do',
      'dashboard.domain': 'Domain',
      'dashboard.files': 'Files',
      'dashboard.sslOff': 'Disabled',
      'dashboard.sslOn': 'Enabled',
      'dashboard.sshEnabled': 'enabled',
      'dashboard.sshDisabled': 'disabled',
      'dashboard.storageUsed': 'Storage used by mailbox',

      'appcatalog.title': 'Applications',
      'appcatalog.subtitle': 'WordPress, Nextcloud, PrestaShop, Joomla, Drupal, Moodle — in one click',
      'appcatalog.all': 'All',
      'appcatalog.installed': 'Installed',
      'appcatalog.available': 'Available',
      'appcatalog.searchPlaceholder': 'Search applications…',
      'appcatalog.yourApps': 'Your applications',
      'appcatalog.install': 'Install',
      'appcatalog.installAnother': 'Install another',
      'appcatalog.installedCount': 'Installed: {count}',
      'appcatalog.availableBadge': 'Available',
      'appcatalog.versionLatest': 'Version: latest',
      'appcatalog.nativeInstaller': 'Native installer',
      'appcatalog.webInstaller': 'Web installer',
      'appcatalog.cliWeb': 'CLI + web',

      'help.title': 'Help',
      'help.subtitle': 'Common tasks step by step',
      'help.intro': 'The simplest way: use the “Add site” and “Add mailbox” buttons on the dashboard. Everything else happens automatically.'
    }
  };

  /* Legacy English strings that still exist in server-rendered pages. New
     code uses message keys; this dictionary keeps older pages honest. */
  var LEGACY_EN_PL = {
    'Dashboard': 'Pulpit', 'Statistics': 'Statystyki', 'Messages': 'Wiadomości',
    'Server overview': 'Przegląd serwera', 'Server and hosting overview': 'Serwer i hosting',
    'Create user': 'Utwórz użytkownika', 'Create reseller': 'Utwórz resellera', 'Server settings': 'Ustawienia serwera',
    'Manage the domains hosted on your account': 'Zarządzaj domenami na swoim koncie',
    'Primary and add-on domains': 'Domeny główne i dodatkowe',
    'No domains yet. Add your first domain to get started.': 'Brak domen. Dodaj pierwszą domenę, aby zacząć.',
    'Subdomains': 'Subdomeny', 'Mailboxes': 'Skrzynki', 'Domain': 'Domena', 'Add domain': 'Dodaj domenę',
    'Create mailbox': 'Utwórz skrzynkę', 'Quota': 'Limit', 'Mailbox': 'Skrzynka', 'Suspend / enable': 'Zawieś / włącz',
    'No mailboxes on this domain yet.': 'Brak skrzynek na tej domenie.',
    'Email accounts': 'Skrzynki e-mail', 'Create and manage POP3/IMAP mailboxes': 'Twórz i zarządzaj skrzynkami POP3/IMAP',
    'Users': 'Użytkownicy', 'Domains': 'Domeny', 'Bandwidth (30d)': 'Transfer (30 dni)', 'Memory': 'Pamięć',
    'Services': 'Usługi', 'Manage': 'Zarządzaj', 'Recent activity': 'Ostatnia aktywność', 'Audit log': 'Dziennik zdarzeń',
    'Open tickets': 'Otwarte zgłoszenia', 'All tickets': 'Wszystkie zgłoszenia', 'No open tickets': 'Brak otwartych zgłoszeń',
    'Backups': 'Kopie zapasowe', 'Server snapshots': 'Migawki serwera', 'Every action': 'Każda akcja',
    'Licensing': 'Licencja', 'Free, unlimited': 'Darmowa, bez limitów', 'Plugins': 'Wtyczki', 'Extend the panel': 'Rozszerz panel',
    'Server info': 'Informacje o serwerze', 'System Information': 'Informacje o systemie',
    'E-mail Accounts': 'Skrzynki e-mail', 'Forwarders': 'Przekierowania', 'Autoresponders': 'Autoodpowiedzi',
    'Vacation Messages': 'Wiadomości urlopowe', 'Catch-All E-mail': 'Catch-all', 'Mailing Lists': 'Listy mailingowe',
    'SPAM Filters': 'Filtry spamu', 'Email Usage': 'Użycie poczty', 'Add subdomain': 'Dodaj subdomenę',
    'Add record': 'Dodaj rekord', 'Create': 'Utwórz', 'Save': 'Zapisz', 'Cancel': 'Anuluj', 'Delete': 'Usuń',
    'Edit': 'Edytuj', 'Download': 'Pobierz', 'Restore': 'Przywróć', 'Upload': 'Wgraj', 'New folder': 'Nowy katalog',
    'Search': 'Szukaj', 'Actions': 'Akcje', 'Status': 'Status', 'Name': 'Nazwa', 'Type': 'Typ', 'Value': 'Wartość',
    'Priority': 'Priorytet', 'TTL': 'TTL', 'Active': 'Aktywna', 'Suspended': 'Zawieszona', 'Enabled': 'Włączone',
    'Disabled': 'Wyłączone', 'Unlimited': 'Bez limitu', 'Used': 'Użyte', 'Free': 'Darmowe', 'Open': 'Otwórz',
    'Close': 'Zamknij', 'Back': 'Wstecz', 'Next': 'Dalej', 'Previous': 'Poprzednie', 'Submit': 'Wyślij',
    'Install': 'Zainstaluj', 'Remove': 'Usuń', 'Update': 'Aktualizuj', 'Generate': 'Wygeneruj', 'Copy': 'Kopiuj',
    'Show': 'Pokaż', 'Hide': 'Ukryj', 'Refresh': 'Odśwież', 'Filter': 'Filtruj', 'Reset': 'Resetuj',
    'Create backup': 'Utwórz kopię', 'Create database': 'Utwórz bazę', 'Send': 'Wyślij', 'Reply': 'Odpowiedz',
    'Compose': 'Nowa wiadomość', 'Inbox': 'Odebrane', 'Drafts': 'Wersje robocze', 'Sent': 'Wysłane', 'Trash': 'Kosz',
    'Logout': 'Wyloguj', 'Sign in': 'Zaloguj się', 'Username': 'Użytkownik', 'Password': 'Hasło', 'Email': 'E-mail',
    'Package': 'Pakiet', 'Owner': 'Właściciel', 'Level': 'Poziom', 'Created': 'Utworzono', 'Expires': 'Wygasa',
    'Size': 'Rozmiar', 'Disk': 'Dysk', 'Disk usage': 'Użycie dysku', 'Bandwidth': 'Transfer',
    'SSL certificates': 'Certyfikaty SSL', 'Cron jobs': 'Zadania cron', 'FTP accounts': 'Konta FTP', 'Databases': 'Bazy danych',
    'Quick actions': 'Szybkie akcje', 'Resources': 'Zasoby', 'Top mailboxes': 'Największe skrzynki',
    'Your domains': 'Twoje domeny', 'Account limits': 'Limity konta', 'Usage report': 'Raport użycia',
    'All backups': 'Wszystkie kopie', 'Recent backups': 'Ostatnie kopie', 'No domains yet': 'Brak domen',
    'No mailboxes yet': 'Brak skrzynek', 'No backups yet': 'Brak kopii zapasowych',
    'No activity yet.': 'Brak aktywności', 'No activity yet': 'Brak aktywności', 'No data': 'Brak danych',
    'No users yet': 'Brak użytkowników', 'No tickets yet': 'Brak zgłoszeń',
    'Domains hosted on your account': 'Domeny na Twoim koncie', 'Domain Management': 'Strony i domeny',
    'File Management': 'Pliki', 'File Manager': 'Menedżer plików', 'FTP Management': 'Konta FTP',
    'FTP Settings': 'Ustawienia FTP', 'Cron Jobs': 'Zadania cron', 'Login Keys': 'Klucze logowania',
    'SSH Keys': 'Klucze SSH', 'Tickets': 'Zgłoszenia', 'Advanced': 'Zaawansowane', 'PHP Settings': 'Ustawienia PHP',
    'Error Pages': 'Strony błędów', 'Apache Handlers': 'Handlery Apache', 'MIME types': 'Typy MIME',
    'Password Protected Directories': 'Katalogi chronione', 'Hotlink Protection': 'Ochrona hotlink',
    'App Installer': 'Instalator aplikacji', 'Node.js / Python Apps': 'Aplikacje Node/Python',
    'ClamAV': 'Antywirus', 'IMAPSync Migrations': 'Migracja IMAP', 'Nginx Templates': 'Szablony Nginx',
    'Perl Modules': 'Moduły Perl', 'User Profile': 'Profil użytkownika', 'E-mail Summary': 'Podsumowanie poczty',
    'Mail Queue': 'Kolejka poczty', 'Process Monitor': 'Monitor procesów', 'File Editor': 'Edytor plików',
    'Log Viewer': 'Podgląd logów', 'System Packages': 'Pakiety systemowe', 'Maintenance': 'Konserwacja',
    'Multi Server': 'Wiele serwerów', 'Admin Dashboard': 'Pulpit administratora',
    'Administrator Settings': 'Ustawienia administratora', 'System Services': 'Usługi systemowe',
    'Web Server': 'Serwer WWW', 'Web Apps': 'Aplikacje WWW', 'Login Customization': 'Personalizacja logowania',
    'Customize Skin': 'Motyw', 'Skins': 'Motywy', 'DNS Administration': 'Administracja DNS',
    'Name Servers': 'Serwery nazw', 'IP Management': 'Zarządzanie IP', 'Change Passwords': 'Zmiana haseł',
    'Message All Users': 'Wiadomość do wszystkich', 'Add New User': 'Dodaj użytkownika', 'My Users': 'Moi użytkownicy',
    'Suspended Users': 'Zawieszeni użytkownicy', 'Move Users': 'Przenieś użytkowników',
    'Reseller Statistics': 'Statystyki resellera', 'Reseller Settings': 'Ustawienia resellera',
    'User Management': 'Zarządzanie użytkownikami', 'Reseller Tools': 'Narzędzia resellera',
    'New mailbox': 'Nowa skrzynka', 'New database': 'Nowa baza', 'FTP account': 'Konto FTP',
    'Backup': 'Kopia zapasowa', 'Cron job': 'Zadanie cron', 'SSL certificate': 'Certyfikat SSL',
    'Details': 'Szczegóły', 'Free license': 'Darmowa licencja', 'Download a full backup': 'Pobierz pełną kopię',
    'Scheduled commands': 'Zaplanowane polecenia', 'MySQL / MariaDB': 'MySQL / MariaDB',
    'File transfer user': 'Konto do plików', 'Domain + SSL + WordPress': 'Domena + SSL + WordPress',
    'Utwórz konto e-mail': 'Utwórz konto e-mail', 'Storage used by mailbox': 'Miejsce zajęte przez skrzynki',
    'Overview of your hosting account': 'Przegląd Twojego konta hostingowego', 'Welcome to OpenAdmin': 'Witaj w OpenAdmin',
    'Your hosting account is ready. The panel is 100% free and unlimited.': 'Twoje konto hostingowe jest gotowe. Panel jest w 100% darmowy i bez limitów.',
    'peak day': 'szczyt dnia', 'Documentation': 'Dokumentacja', 'License': 'Licencja',
    'free & open source (AGPL-3.0)': 'darmowy i open source (AGPL-3.0)', 'of': 'z', 'unlimited': 'bez limitu',
    'total': 'łącznie', 'avg': 'średnio', 'Reseller package': 'Pakiet resellera', 'Primary domain': 'Domena główna',
    'Save reseller': 'Zapisz resellera', 'Modify reseller': 'Edytuj resellera',
    'Resellers can create and manage users': 'Resellerzy mogą tworzyć konta i zarządzać nimi',
    'Reseller Dashboard': 'Pulpit resellera', 'Reseller dashboard': 'Pulpit resellera', 'Recent users': 'Ostatnie konta',
    'Your limits': 'Twoje limity', 'Reseller bandwidth': 'Transfer resellera', 'All users': 'Wszyscy użytkownicy',
    'Packages': 'Pakiety', 'Reseller Overview': 'Przegląd resellera', 'Manage User Packages': 'Pakiety użytkowników',
    'cPanel Import': 'Import cPanel', 'Security.txt': 'Security.txt', 'Add a domain': 'Dodaj domenę',
    'Domain name': 'Nazwa domeny', 'Web engine': 'Silnik WWW', 'SSL mode': 'Tryb SSL',
    'Create a DNS zone with default A, MX, SPF, DMARC and NS records': 'Utwórz strefę DNS z domyślnymi rekordami A, MX, SPF, DMARC i NS',
    'Existing domains': 'Istniejące domeny', 'Document root': 'Katalog strony', 'SSL enabled': 'SSL włączony',
    'Save domain': 'Zapisz domenę', 'Edit domain': 'Edytuj domenę', 'Create domain': 'Utwórz domenę',
    'DNS zone': 'Strefa DNS', 'Zone file': 'Plik strefy', 'Rebuild zone': 'Odbuduj strefę', 'Nameservers': 'Serwery nazw',
    'Search pages and commands…': 'Szukaj stron i poleceń…',
    'Self-signed — works immediately (browser warning)': 'Self-signed — działa od razu (ostrzeżenie przeglądarki)',
    "Let's Encrypt — requires public DNS": "Let's Encrypt — wymaga publicznego DNS",
    'No SSL (HTTP only)': 'Bez SSL (tylko HTTP)', 'PHP version': 'Wersja PHP', 'Certificate': 'Certyfikat',
    'Private key': 'Klucz prywatny', 'Install certificate': 'Zainstaluj certyfikat', 'Issue certificate': 'Wystaw certyfikat',
    'Upload certificate': 'Wgraj certyfikat', 'Renew': 'Odnów', 'Server certificates': 'Certyfikaty serwera',
    'Panel certificate': 'Certyfikat panelu', 'Install panel certificate': 'Zainstaluj certyfikat panelu',
    'Web servers': 'Serwery WWW', 'Use': 'Użyj', 'Detected': 'Wykryty', 'Not detected': 'Nie wykryto',
    'Deploy configuration': 'Wdróż konfigurację', 'Test configuration': 'Testuj konfigurację',
    'Generate configuration': 'Wygeneruj konfigurację', 'PHP handler': 'Obsługa PHP',
    'LiteSpeed Enterprise license': 'Licencja LiteSpeed Enterprise', 'Backup / Restore': 'Kopie zapasowe',
    'Server-wide backup management': 'Zarządzanie kopiami serwera', 'Create server backup': 'Utwórz kopię serwera',
    'Backup file': 'Plik kopii', 'SSL/TLS Certificates': 'Certyfikaty SSL/TLS', 'SSL Certificates': 'Certyfikaty SSL',
    'Certificate authority': 'Urząd certyfikacji', 'Issue': 'Wystaw', 'Self-signed': 'Self-signed',
    'Add a website': 'Dodaj stronę', 'Create website': 'Utwórz stronę', 'Create User': 'Utwórz użytkownika',
    'Add user': 'Dodaj użytkownika', 'Modify User': 'Edytuj użytkownika', 'Account': 'Konto',
    'Save changes': 'Zapisz zmiany', 'Sign in to your panel': 'Zaloguj się do panelu',
    'Use the same credentials for admin, reseller and user access.': 'Te same dane logowania dla admina, resellera i użytkownika.',
    'Remember me': 'Zapamiętaj mnie', 'Forgot password?': 'Nie pamiętasz hasła?',
    'LIVE DEMO ACCOUNTS': 'KONTA DEMO', 'Live demo accounts': 'Konta demo',
    'Need an account? Contact your hosting provider. This panel is free software under the AGPL-3.0.': 'Potrzebujesz konta? Skontaktuj się z hostingodawcą. Panel jest wolnym oprogramowaniem na licencji AGPL-3.0.',
    'Everything your server needs, nothing you have to pay for.': 'Wszystko, czego potrzebuje serwer — bez opłat.',
    'A DirectAdmin-compatible control panel for admins, resellers and users — domains, DNS, email, databases, files, backups and SSL in one place.': 'Panel zgodny z DirectAdmin dla adminów, resellerów i użytkowników — domeny, DNS, poczta, bazy, pliki, kopie i SSL w jednym miejscu.',
    'PANEL LEVELS': 'POZIOMY PANELU', 'MAPPED COMMANDS': 'ZMAPOWANE KOMENDY', 'FOREVER': 'NA ZAWSZE',
    'panel levels': 'poziomy panelu', 'mapped commands': 'zmapowane komendy', 'forever': 'na zawsze',
    '100% free · no license fees': '100% darmowy · bez opłat licencyjnych',
    'Free forever · unlimited domains': 'Darmowy na zawsze · bez limitu domen',
    'Admin · Reseller · User panels': 'Panele Admin · Reseller · Użytkownik',
    'DirectAdmin-compatible CMD_API': 'Zgodne API CMD_API DirectAdmin',
    'Free licensing, unlimited accounts': 'Darmowa licencja, bez limitu kont',
    'Hosting Control Panel': 'Panel hostingowy', 'Run now': 'Uruchom teraz', 'Enable': 'Włącz', 'Disable': 'Wyłącz',
    'Clear failures': 'Wyczyść błędy', 'Recent runs': 'Ostatnie uruchomienia', 'Last run': 'Ostatnie uruchomienie',
    'Next run': 'Następne uruchomienie', 'Interval': 'Interwał', 'Job': 'Zadanie', 'Jobs': 'Zadania', 'Output': 'Wynik',
    'Never': 'Nigdy', 'due now': 'teraz', 'in': 'za', 'Global automation': 'Automatyzacja globalna',
    'Automation settings': 'Ustawienia automatyzacji', 'Disk threshold': 'Próg dysku', 'Temp retention': 'Retencja temp',
    'Mail retry': 'Ponawianie poczty', 'Free & open source': 'Darmowy i open source', 'default': 'domyślny',
    'sandbox': 'sandbox', 'detected': 'wykryty', 'not detected': 'nie wykryto',
    'web server binary not detected on this host': 'nie wykryto binarki serwera WWW na tym hoście',
    'Automation': 'Automatyzacja', 'Live': 'Online', 'Auto-refresh': 'Auto-odświeżanie', 'OFF': 'WYŁ.', 'ON': 'WŁ.',
    'Off': 'Wył.', 'On': 'Wł.', 'Dark': 'Ciemny', 'Light': 'Jasny', 'Server': 'Serwer', 'Resellers': 'Resellerzy',
    'Settings': 'Ustawienia', 'Tools': 'Narzędzia', 'files': 'plików',
    'Skip to content': 'Przejdź do treści', 'Dismiss message': 'Zamknij komunikat',
    'Copied to clipboard': 'Skopiowano do schowka',
    'Could not copy — select the value and copy it manually.': 'Nie udało się skopiować — zaznacz wartość i skopiuj ją ręcznie.',
    'Password generated': 'Wygenerowano hasło',
    'Auto-refresh is off.': 'Auto-odświeżanie jest wyłączone.',
    'Auto-refresh is only available on overview and monitoring pages': 'Auto-odświeżanie jest dostępne tylko na stronach przeglądu i monitoringu.',
    'Auto-refresh is available on overview and monitoring pages': 'Auto-odświeżanie jest dostępne tylko na stronach przeglądu i monitoringu.',
    'Auto-refresh this page every 30 seconds': 'Odświeżaj tę stronę co 30 sekund',
    'Could not read file': 'Nie udało się odczytać pliku',
    'Upload files: drop files here or press Enter to browse': 'Wgraj pliki: przeciągnij je tutaj lub naciśnij Enter, aby wybrać',
    'Switch to dark mode': 'Przełącz na tryb ciemny',
    'Switch to light mode': 'Przełącz na tryb jasny',
    'Open notifications': 'Otwórz powiadomienia',
    'Two-factor authentication': 'Weryfikacja dwuetapowa',
    'Enter the 6-digit code from your authenticator app, or a recovery code.': 'Wpisz 6-cyfrowy kod z aplikacji uwierzytelniającej lub kod odzyskiwania.',
    'Authentication code': 'Kod uwierzytelniający',
    'Verify': 'Zweryfikuj',
    'Account disabled': 'Konto zawieszone',
    'This account has been suspended by an administrator or reseller. Websites, email and FTP access are offline until it is restored.': 'To konto zostało zawieszone przez administratora lub resellera. Strony, poczta i FTP są wyłączone do czasu przywrócenia konta.',
    'If you believe this is a mistake, contact your hosting provider and quote your username.': 'Jeśli to pomyłka, skontaktuj się z hostingodawcą i podaj nazwę użytkownika.',
    'Continue to sign in': 'Przejdź do logowania',
    'No license required': 'Licencja nie jest wymagana',
    'Set a new password': 'Ustaw nowe hasło',
    'New password': 'Nowe hasło',
    'Repeat password': 'Powtórz hasło',
    'Save password': 'Zapisz hasło',
    'This link expired or is invalid. Request a new one.': 'Link wygasł lub jest nieprawidłowy. Poproś o nowy.',
    'The password must be at least 8 characters long.': 'Hasło musi mieć co najmniej 8 znaków.',
    'The passwords do not match.': 'Hasła nie są identyczne.',
    'The account does not exist.': 'Konto nie istnieje.',
    'The password has been changed. Sign in.': 'Hasło zostało zmienione. Zaloguj się.',
    'Close dialog': 'Zamknij okno dialogowe', 'Close panel': 'Zamknij panel', 'Data table': 'Tabela danych',
    'Sections': 'Sekcje', 'Setup progress': 'Postęp konfiguracji',
    'No certificates yet.': 'Brak certyfikatów.', 'No active sessions.': 'Brak aktywnych sesji.',
    'No login keys yet.': 'Brak kluczy logowania.', 'No SSH keys added.': 'Brak kluczy SSH.',
    'No hosting databases yet.': 'Brak baz hostingowych.', 'No mail domains yet.': 'Brak domen pocztowych.',
    'No tracked messages.': 'Brak śledzonych wiadomości.', 'No mailboxes.': 'Brak skrzynek.',
    'No administrators.': 'Brak administratorów.', 'No messages sent.': 'Brak wysłanych wiadomości.',
    'No migrations yet.': 'Brak migracji.', 'No custom entries.': 'Brak własnych wpisów.',
    'No protected directories.': 'Brak katalogów chronionych.', 'No repositories yet.': 'Brak repozytoriów.',
    'No non-system accounts.': 'Brak kont poza systemowymi.', 'No applications registered.': 'Brak zarejestrowanych aplikacji.',
    'No automation jobs are seeded yet.': 'Brak zadań automatyzacji.',
    'No automation runs recorded yet.': 'Brak zapisanych uruchomień automatyzacji.',
    'No subdomains for this domain yet.': 'Brak subdomen dla tej domeny.',
    'No domain pointers yet.': 'Brak aliasów domen.', 'No redirects configured.': 'Brak skonfigurowanych przekierowań.',
    'Nothing here yet': 'Dane pojawią się po dodaniu pierwszego elementu.',
    'Nothing yet': 'Dane pojawią się po dodaniu pierwszego elementu.',
    'No results': 'Brak wyników', 'No matches': 'Brak wyników',
    'Loading…': 'Ładowanie…', 'Loading...': 'Ładowanie…',
    'Unavailable': 'Niedostępne', 'Not configured': 'Nie skonfigurowano',
    'Required': 'Wymagane', 'required': 'wymagane', 'Optional': 'Opcjonalne', 'optional': 'opcjonalne',
    'theme': 'motyw', 'reload': 'przeładuj', 'auto': 'auto', 'inbox': 'skrzynka', 'logout': 'wyloguj',
    'Results': 'Wyniki',
    'Page not found': 'Nie znaleziono strony', 'Back to dashboard': 'Wróć do pulpitu',
    'Permission denied': 'Brak uprawnień', 'Access denied': 'Odmowa dostępu',
    'Are you sure?': 'Czy na pewno?', 'Yes': 'Tak', 'No': 'Nie',
    'Everything is ready': 'Wszystko gotowe', 'Everything is ready — your account is running': 'Wszystko gotowe — konto pracuje',
    'Backup Center': 'Centrum kopii zapasowych',
    'Update Center': 'Centrum aktualizacji',
    'Log Center': 'Centrum logów',
    'Security Center': 'Centrum bezpieczeństwa',
    'Action Center': 'Centrum wymagających uwagi',
    'Multi Server Registry': 'Rejestr serwerów',
    'DNS Operations': 'Operacje DNS',
    'AutoSSL Center': 'Centrum AutoSSL',
    'Plugin Center': 'Centrum wtyczek',
    'Next': 'Dalej', 'Open installer': 'Otwórz instalator', 'Full catalogue': 'Cały katalog', 'ready': 'gotowa',
    'available to install': 'gotowa do instalacji', 'installed': 'zainstalowana', 'to do': 'do zrobienia',
    'done': 'gotowe', 'next': 'następny krok'
  };

  var PROPER = {
    openadmin: 1, wordpress: 1, nextcloud: 1, prestashop: 1, joomla: 1, drupal: 1, moodle: 1,
    phpmyadmin: 1, roundcube: 1, mariadb: 1, mysql: 1, postgresql: 1, redis: 1, nginx: 1, apache: 1,
    openlitespeed: 1, litespeed: 1, directadmin: 1, cpanel: 1, netdata: 1, rspamd: 1, acme: 1,
    'let\'s encrypt': 1, webdisk: 1, webdav: 1, php: 1, ssl: 1, tls: 1, dns: 1, ftp: 1, ssh: 1,
    imap: 1, pop3: 1, smtp: 1, dkim: 1, spf: 1, dmarc: 1, api: 1, cli: 1, www: 1, mcp: 1, csf: 1,
    cloudlinux: 1, exim: 1, dovecot: 1, opendkim: 1, clamav: 1, modsecurity: 1, openssl: 1, ubuntu: 1,
    debian: 1, linux: 1, proxmox: 1, netdata: 1
  };

  /* --------------------------------------------------------- dictionaries */
  function own(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

  function deriveDictionary(from, to) {
    var out = {};
    var seen = {};
    var ambiguous = {};
    var source = MESSAGES[from] || {};
    var target = MESSAGES[to] || {};
    Object.keys(source).forEach(function (key) {
      var src = source[key];
      var dst = target[key];
      if (typeof src !== 'string' || typeof dst !== 'string') return;
      if (!src || !dst || src === dst || /[{}]/.test(src) || /[{}]/.test(dst)) return;
      if (ambiguous[src]) return;
      if (seen[src] && seen[src] !== dst) {
        ambiguous[src] = true;
        delete out[src];
        return;
      }
      seen[src] = dst;
      out[src] = dst;
    });
    return out;
  }

  function reverseLegacy() {
    var out = {};
    var seen = {};
    var ambiguous = {};
    Object.keys(LEGACY_EN_PL).forEach(function (en) {
      var pl = LEGACY_EN_PL[en];
      if (!pl || pl === en || /\$\d|\{\w+\}/.test(pl)) return;
      if (ambiguous[pl]) return;
      if (seen[pl] && seen[pl] !== en) {
        ambiguous[pl] = true;
        delete out[pl];
        return;
      }
      seen[pl] = en;
      out[pl] = en;
    });
    return out;
  }

  var EN_PL = Object.assign({}, deriveDictionary('en', 'pl'), LEGACY_EN_PL);
  var PL_EN = Object.assign({}, deriveDictionary('pl', 'en'), reverseLegacy());

  /* A few bilingual strings that are not message values but appear in
     generated payloads / JSON. Kept explicit to avoid unsafe guesses. */
  Object.assign(EN_PL, {
    'No data to display.': 'Brak danych do wyświetlenia.',
    'No data yet.': 'Brak danych.',
    'Select all rows': 'Zaznacz wszystkie wiersze',
    'Copy value': 'Kopiuj wartość',
    'Try again': 'Spróbuj ponownie',
    'Last updated': 'Ostatnia aktualizacja',
    'Are you sure?': 'Czy na pewno?'
  });
  Object.assign(PL_EN, {
    'motyw': 'theme', 'przeładuj': 'reload', 'skrzynka': 'inbox', 'wyloguj': 'logout', 'Wyniki': 'Results',
    'Brak danych do wyświetlenia.': 'No data to display.',
    'Brak skrzynek na tej domenie.': 'No mailboxes on this domain yet.',
    'Brak otwartych zgłoszeń': 'No open tickets',
    'Dane pojawią się po dodaniu pierwszego elementu.': 'Data will appear here after the first item is added.',
    'Dane pojawią się tutaj, gdy będą dostępne.': 'Data will appear here when it is available.',
    'Brak aplikacji pasujących do wyszukiwania.': 'No applications match this search.',
    'Wyczyść filtry': 'Clear filters',
    'Pokaż wszystkie aplikacje': 'Show all applications',
    'Nie masz jeszcze zainstalowanych aplikacji': 'You have no installed applications yet',
    'Wszystkie aplikacje są już zainstalowane': 'All applications are already installed'
  });

  var PATTERNS_EN_PL = [
    [/^No matches for “(.+)”\.?$/i, 'Brak wyników dla „$1”.'],
    [/^Auto-refresh is on\. This page reloads every (\d+) seconds\.$/i, 'Auto-odświeżanie włączone. Strona przeładuje się co $1 s.'],
    [/^Uploading (\d+) files?…$/i, 'Wgrywanie $1 plików…'],
    [/^Uploaded (.+)$/i, 'Wgrano $1'],
    [/^Upload failed: (.+)$/i, 'Wgrywanie nie powiodło się: $1'],
    [/^1 unread notification$/i, '1 nieprzeczytane powiadomienie'],
    [/^(\d+) unread notifications$/i, '$1 nieprzeczytanych powiadomień'],
    [/^(\d+)\s+domains?$/i, '$1 domen'],
    [/^(\d+)\s+users?$/i, '$1 użytkowników'],
    [/^(\d+)\s+resellers?$/i, '$1 resellerów'],
    [/^(\d+)\s+mailboxes?$/i, '$1 skrzynek'],
    [/^(\d+)\s+services? running\.?$/i, '$1 usług działa'],
    [/^(\d+)\s+messages?$/i, '$1 wiadomości'],
    [/^(\d+)\s+accounts?$/i, '$1 kont'],
    [/^1 account\(s\)$/i, '1 konto'],
    [/^(\d+)\s+account\(s\)$/i, '$1 kont'],
    [/^1 mailbox\(es\)$/i, '1 skrzynka'],
    [/^(\d+)\s+mailbox\(es\)$/i, '$1 skrzynek'],
    [/^1 installation\(s\)$/i, '1 instalacja'],
    [/^(\d+)\s+installation\(s\)$/i, '$1 instalacji'],
    [/^1 archive\(s\)$/i, '1 archiwum'],
    [/^(\d+)\s+archive\(s\)$/i, '$1 archiwów'],
    [/^1 process\(es\)$/i, '1 proces'],
    [/^(\d+)\s+process\(es\)$/i, '$1 procesów'],
    [/^1 certificate\(s\)$/i, '1 certyfikat'],
    [/^(\d+)\s+certificate\(s\)$/i, '$1 certyfikatów'],
    [/^Page (\d+) of (\d+)$/i, 'Strona $1 z $2'],
    [/^(\d+)\s+of\s+(\d+)$/i, '$1 z $2'],
    [/^total · avg (.+)\/day$/i, 'łącznie · średnio $1/dzień'],
    [/^· unlimited accounts$/i, '· bez limitu kont'],
    [/^· (\d+) accounts$/i, '· $1 kont'],
    [/^No SSL \(HTTP only\)$/i, 'Bez SSL (tylko HTTP)']
  ];

  var PATTERNS_PL_EN = [
    [/^Brak wyników dla „(.+)”\.?$/i, 'No matches for “$1”.'],
    [/^Auto-odświeżanie włączone\. Strona przeładuje się co (\d+) s\.$/i, 'Auto-refresh is on. This page reloads every $1 seconds.'],
    [/^Wgrywanie (\d+) plików…$/i, 'Uploading $1 files…'],
    [/^Wgrano (.+)$/i, 'Uploaded $1'],
    [/^Wgrywanie nie powiodło się: (.+)$/i, 'Upload failed: $1'],
    [/^(\d+) nieprzeczytanych powiadomień$/i, '$1 unread notifications'],
    [/^(\d+) domen$/i, '$1 domains'],
    [/^(\d+) użytkowników$/i, '$1 users'],
    [/^(\d+) resellerów$/i, '$1 resellers'],
    [/^(\d+) skrzynek$/i, '$1 mailboxes'],
    [/^(\d+) usług działa$/i, '$1 services running'],
    [/^(\d+) wiadomości$/i, '$1 messages'],
    [/^1 konto$/i, '1 account'],
    [/^(\d+) kont$/i, '$1 accounts'],
    [/^1 skrzynka$/i, '1 mailbox'],
    [/^(\d+) instalacji$/i, '$1 installations'],
    [/^1 instalacja$/i, '1 installation'],
    [/^(\d+) archiwów$/i, '$1 archives'],
    [/^1 archiwum$/i, '1 archive'],
    [/^(\d+) procesów$/i, '$1 processes'],
    [/^(\d+) certyfikatów$/i, '$1 certificates'],
    [/^Strona (\d+) z (\d+)$/i, 'Page $1 of $2'],
    [/^(\d+) z (\d+)$/i, '$1 of $2'],
    [/^łącznie · średnio (.+)\/dzień$/i, 'total · avg $1/day'],
    [/^· bez limitu kont$/i, '· unlimited accounts'],
    [/^(\d+) aplikacji$/i, '$1 applications'],
    [/^(\d+) zainstalowanych$/i, '$1 installed'],
    [/^(\d+) gotowe$/i, '$1 done'],
    [/^Ładowanie…$/i, 'Loading…'],
    [/^Brak danych$/i, 'No data'],
    [/^Nieznany$/i, 'Unknown'],
    [/^Niedostępne$/i, 'Unavailable'],
    [/^Nie skonfigurowano$/i, 'Not configured']
  ];

  /* ------------------------------------------------------------ forbidden */
  var FORBIDDEN = [
    /^Nothing here yet\.?$/i,
    /^Nothing yet\.?$/i,
    /^Brak:\s/i,
    /^\s*undefined\s*$/i,
    /^\s*null\s*$/i,
    /^\s*NaN\s*$/i,
    /\[object Object\]/i
  ];

  function isForbiddenText(value) {
    var text = String(value == null ? '' : value);
    return FORBIDDEN.some(function (re) { return re.test(text); });
  }

  /* -------------------------------------------------------------- locales */
  function normalizeLocale(value) {
    var raw = String(value == null ? '' : value).trim().toLowerCase();
    if (!raw) return '';
    var lang = raw.split(/[-_]/)[0];
    return LOCALES.indexOf(lang) === -1 ? '' : lang;
  }

  function parseQuery(search) {
    var out = {};
    String(search || '').replace(/^\?/, '').split('&').forEach(function (part) {
      if (!part) return;
      var idx = part.indexOf('=');
      var key = idx === -1 ? part : part.slice(0, idx);
      var val = idx === -1 ? '' : part.slice(idx + 1);
      try { out[decodeURIComponent(key)] = decodeURIComponent(val.replace(/\+/g, ' ')); } catch { out[key] = val; }
    });
    return out;
  }

  function parseCookieString(cookie) {
    var out = {};
    String(cookie || '').split(';').forEach(function (part) {
      var idx = part.indexOf('=');
      if (idx === -1) return;
      var key = part.slice(0, idx).trim();
      var val = part.slice(idx + 1).trim();
      if (!key) return;
      try { out[key] = decodeURIComponent(val); } catch { out[key] = val; }
    });
    return out;
  }

  function matchLanguage(tag) {
    return normalizeLocale(tag);
  }

  function resolveLocale(input) {
    var hints = input || {};
    var query = hints.query || parseQuery(hints.search || '');
    if (typeof URLSearchParams !== 'undefined' && query instanceof URLSearchParams) {
      query = { lang: query.get('lang') || '', hl: query.get('hl') || '', locale: query.get('locale') || '' };
    }
    var explicit = normalizeLocale(query.lang || query.hl || query.locale);
    if (explicit) return explicit;

    var cookie = hints.cookie || '';
    var cookies = typeof cookie === 'string' ? parseCookieString(cookie) : (cookie || {});
    var fromCookie = normalizeLocale(cookies[COOKIE_KEY] || cookies.lang || cookies.language);
    if (hints.isLogin && fromCookie) return fromCookie;

    var storage = hints.storage || {};
    var stored = normalizeLocale(hints.storageLocale || storage[STORAGE_KEY] || storage.lang || storage.language);
    if (hints.isLogin && stored) return stored;

    var htmlLang = normalizeLocale(hints.htmlLang);
    if (htmlLang && !fromCookie && !stored) return htmlLang;
    if (!hints.isLogin && fromCookie) return fromCookie;
    if (!hints.isLogin && stored) return stored;

    var languages = hints.languages || hints.acceptLanguage || hints.browserLanguage;
    if (typeof languages === 'string') languages = languages.split(',').map(function (part) { return part.split(';')[0].trim(); });
    if (!Array.isArray(languages)) languages = languages ? [languages] : [];
    for (var i = 0; i < languages.length; i++) {
      var match = matchLanguage(languages[i]);
      if (match) return match;
    }
    if (htmlLang) return htmlLang;
    return DEFAULT_LOCALE;
  }

  /* ------------------------------------------------------------- messages */
  function hasMessage(key, locale) {
    var lang = normalizeLocale(locale) || currentLocale;
    return own(MESSAGES[lang] || {}, key);
  }

  function interpolate(template, vars) {
    return String(template == null ? '' : template).replace(/\{(\w+)\}/g, function (_, name) {
      if (!vars || !own(vars, name)) return '';
      var value = vars[name];
      if (value === null || value === undefined) return '';
      if (typeof value === 'number' && Number.isNaN(value)) return '';
      if (typeof value === 'object') return '';
      return String(value);
    });
  }

  function t(key, vars, locale) {
    var lang = normalizeLocale(locale) || currentLocale;
    var table = MESSAGES[lang] || MESSAGES[DEFAULT_LOCALE];
    if (!own(table, key)) return '';
    return interpolate(table[key], vars);
  }

  /* ----------------------------------------------------------- translation */
  function isProperName(text) {
    var words = String(text || '').toLowerCase().match(/[a-zà-ž0-9'’]+/gi) || [];
    if (!words.length) return true;
    return words.every(function (word) {
      if (/^\d+$/.test(word)) return true;
      return own(PROPER, word.replace(/[’]/g, "'"));
    });
  }

  function translateText(value, locale) {
    if (typeof value !== 'string' || !value) return typeof value === 'string' ? value : '';
    var lang = normalizeLocale(locale) || currentLocale;
    if (!/[a-zA-ZÀ-ž]/.test(value)) return value;
    if (isProperName(value)) return value;

    var lead = (value.match(/^\s*/) || [''])[0];
    var trail = (value.match(/\s*$/) || [''])[0];
    var body = value.slice(lead.length, value.length - trail.length);
    if (!body) return value;
    if (isForbiddenText(body)) return lead + t('state.unavailable', null, lang) + trail;

    /* Page titles are composed as “Title · Brand”. Translate the individual
       logical parts without touching the brand. */
    if (body.indexOf(' · ') !== -1) {
      var parts = body.split(' · ');
      if (parts.length >= 2 && parts.length <= 4) {
        var translatedParts = parts.map(function (part) { return translateText(part, lang); });
        var compound = translatedParts.join(' · ');
        if (compound !== body) return lead + compound + trail;
      }
    }

    var dict = lang === 'pl' ? EN_PL : PL_EN;
    var patterns = lang === 'pl' ? PATTERNS_EN_PL : PATTERNS_PL_EN;
    var out = own(dict, body) ? dict[body] : null;

    if (out === null) {
      for (var i = 0; i < patterns.length; i++) {
        if (patterns[i][0].test(body)) {
          out = body.replace(patterns[i][0], patterns[i][1]);
          break;
        }
      }
    }

    if (out === null || out === body) return value;
    if (isForbiddenText(out)) return lead + t('state.unavailable', null, lang) + trail;
    return lead + out + trail;
  }

  function setLocale(next, { persist = true } = {}) {
    var lang = normalizeLocale(next);
    if (!lang) return currentLocale;
    currentLocale = lang;
    if (persist) persistLocale(lang);
    if (typeof document !== 'undefined' && document.documentElement) applyDocumentLocale(lang);
    return lang;
  }

  function persistLocale(lang) {
    try { if (root.localStorage) root.localStorage.setItem(STORAGE_KEY, lang); } catch { /* private mode */ }
    try {
      if (root.document) {
        var secure = root.location && root.location.protocol === 'https:' ? '; Secure' : '';
        root.document.cookie = COOKIE_KEY + '=' + encodeURIComponent(lang) + '; Path=/; Max-Age=31536000; SameSite=Lax' + secure;
      }
    } catch { /* cookies disabled */ }
  }

  /* ------------------------------------------------------------- DOM layer */
  var currentLocale = DEFAULT_LOCALE;
  var SKIP_SELECTOR = 'script,style,pre,code,textarea,kbd,samp,[data-no-i18n],[translate="no"],.brand-text,.cell-mono,[data-proper-name]';
  var ATTRS = ['placeholder', 'title', 'aria-label', 'aria-description', 'alt', 'data-confirm'];
  var attrSelector = ATTRS.map(function (a) { return '[' + a + ']'; }).join(',');

  function closestSkip(el) {
    var node = el;
    while (node && node.nodeType === 1) {
      if (node.matches && node.matches(SKIP_SELECTOR)) return true;
      if (node.hasAttribute && (node.hasAttribute('data-no-i18n') || node.getAttribute('translate') === 'no')) return true;
      node = node.parentElement;
    }
    return false;
  }

  function translateDetachedText(text) {
    return translateText(text, currentLocale);
  }

  function localizeMarked(rootEl) {
    if (!rootEl || !rootEl.querySelectorAll) return;
    rootEl.querySelectorAll('[data-i18n]').forEach(function (el) {
      var key = el.getAttribute('data-i18n');
      if (!key || !hasMessage(key)) return;
      var value = t(key);
      if (value) el.textContent = value;
    });
    rootEl.querySelectorAll('[data-i18n-aria-label],[data-i18n-placeholder],[data-i18n-title]').forEach(function (el) {
      [['data-i18n-aria-label', 'aria-label'], ['data-i18n-placeholder', 'placeholder'], ['data-i18n-title', 'title']].forEach(function (pair) {
        var key = el.getAttribute(pair[0]);
        if (!key || !hasMessage(key)) return;
        var value = t(key);
        if (value) el.setAttribute(pair[1], value);
      });
    });
  }

  function walk(rootEl) {
    if (!rootEl || !rootEl.ownerDocument || typeof document === 'undefined') return;
    var whatToShow = typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_TEXT : 4;
    var walker = document.createTreeWalker(rootEl, whatToShow, null);
    var node;
    while ((node = walker.nextNode())) {
      var parent = node.parentElement;
      if (!parent || closestSkip(parent)) continue;
      var out = translateDetachedText(node.nodeValue);
      if (out !== node.nodeValue) node.nodeValue = out;
    }
  }

  function translateAttributes(rootEl) {
    if (!rootEl || !rootEl.querySelectorAll) return;
    rootEl.querySelectorAll(attrSelector).forEach(function (el) {
      if (closestSkip(el)) return;
      ATTRS.forEach(function (name) {
        var value = el.getAttribute(name);
        if (!value) return;
        var out = translateText(value, currentLocale);
        if (out !== value) el.setAttribute(name, out);
      });
    });
    rootEl.querySelectorAll('input[type="submit"][value],input[type="button"][value]').forEach(function (el) {
      var value = el.getAttribute('value');
      if (!value) return;
      var out = translateText(value, currentLocale);
      if (out !== value) el.setAttribute('value', out);
    });
  }

  function applyDocumentLocale(lang) {
    currentLocale = lang;
    var html = document.documentElement;
    if (html) {
      html.setAttribute('lang', lang);
      html.setAttribute('dir', 'ltr');
      html.setAttribute(LOCALE_ATTR, lang);
    }
    localizeMarked(document);
    walk(document.body || document.documentElement);
    translateAttributes(document);
    if (document.title) {
      var title = translateText(document.title, lang);
      if (title !== document.title) document.title = title;
    }
    try {
      document.dispatchEvent(new CustomEvent('oa:locale', { detail: { locale: lang } }));
    } catch { /* older browsers */ }
  }

  function browserLocaleHints() {
    var storageLocale = '';
    try { storageLocale = root.localStorage ? root.localStorage.getItem(STORAGE_KEY) : ''; } catch { /* ignore */ }
    var doc = root.document;
    var isLogin = !!(doc && doc.body && doc.body.classList && doc.body.classList.contains('login-body') &&
      !doc.getElementById('cmdPalette'));
    return {
      search: root.location ? root.location.search : '',
      cookie: doc ? doc.cookie : '',
      storageLocale,
      htmlLang: doc ? doc.documentElement.lang : '',
      languages: root.navigator ? (root.navigator.languages || [root.navigator.language]) : [],
      isLogin
    };
  }

  function initDom() {
    var hints = browserLocaleHints();
    var resolved = resolveLocale(hints);
    var query = parseQuery(hints.search);
    var requested = normalizeLocale(query.lang || query.hl || query.locale);
    currentLocale = resolved;
    if (requested) persistLocale(requested);
    applyDocumentLocale(resolved);

    if (typeof MutationObserver !== 'undefined' && document.body) {
      var observer = new MutationObserver(function (mutations) {
        mutations.forEach(function (mutation) {
          mutation.addedNodes.forEach(function (node) {
            if (node.nodeType === 1) {
              localizeMarked(node);
              walk(node);
              translateAttributes(node);
            } else if (node.nodeType === 3 && node.parentElement) {
              var out = translateDetachedText(node.nodeValue);
              if (out !== node.nodeValue) node.nodeValue = out;
            }
          });
        });
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  /* --------------------------------------------------------------- export */
  var API = {
    locales: LOCALES.slice(),
    messages: MESSAGES,
    dictionaries: { 'en->pl': EN_PL, 'pl->en': PL_EN },
    resolveLocale: resolveLocale,
    normalizeLocale: normalizeLocale,
    hasMessage: hasMessage,
    t: t,
    translate: translateText,
    translateText: translateText,
    formatMessage: function (key, vars, locale) { return t(key, vars, locale); },
    setLocale: setLocale,
    getLocale: function () { return currentLocale; },
    isForbiddenText: isForbiddenText,
    isProperName: isProperName,
    forbidden: FORBIDDEN.slice(),
    applyDocumentLocale: applyDocumentLocale
  };

  currentLocale = normalizeLocale(root.__OA_LOCALE__) || DEFAULT_LOCALE;

  if (typeof document !== 'undefined' && document.documentElement) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initDom, { once: true });
    } else {
      initDom();
    }
  }

  root.OA_I18N = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
