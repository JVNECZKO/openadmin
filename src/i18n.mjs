// Lightweight UI translation for the user-facing navigation and laik flows.
// Advanced/DirectAdmin-compatible pages stay in English until translated.
const PL = {
  'Overview': 'Przegląd', 'Dashboard': 'Pulpit', 'Statistics': 'Statystyki', 'Messages': 'Wiadomości',
  'Email Management': 'Poczta', 'E-mail Accounts': 'Skrzynki e-mail', 'Forwarders': 'Przekierowania',
  'Autoresponders': 'Autoodpowiedzi', 'Vacation Messages': 'Urlop', 'Catch-All E-mail': 'Catch-all',
  'Mailing Lists': 'Listy mailingowe', 'SPAM Filters': 'Filtry spamu', 'Email Usage': 'Użycie poczty',
  'Domain Management': 'Strony i domeny', 'Domains': 'Domeny', 'Subdomain Management': 'Subdomeny',
  'DNS Management': 'Strefy DNS', 'Domain Pointers': 'Aliasy domen', 'Site Redirects': 'Przekierowania strony',
  'SSL/TLS Certificates': 'Certyfikaty SSL', 'WordPress Manager': 'WordPress',
  'File Management': 'Pliki', 'File Manager': 'Menedżer plików', 'FTP Management': 'Konta FTP',
  'FTP Settings': 'Ustawienia FTP', 'Backups': 'Kopie zapasowe', 'Cron Jobs': 'Zadania cron',
  'Account': 'Konto', 'Password': 'Hasło', 'Login Keys': 'Klucze logowania', 'Two-Factor Auth': 'Weryfikacja dwuetapowa',
  'SSH Keys': 'Klucze SSH', 'Tickets': 'Zgłoszenia', 'Language & view': 'Język i widok',
  'Advanced': 'Zaawansowane', 'Databases': 'Bazy danych', 'PHP Settings': 'Ustawienia PHP',
  'Error Pages': 'Strony błędów', 'htaccess': 'htaccess', 'Apache Handlers': 'Handlery Apache',
  'MIME types': 'Typy MIME', 'Password Protected Directories': 'Katalogi chronione',
  'Hotlink Protection': 'Ochrona hotlink', 'App Installer': 'Instalator aplikacji',
  'Node.js / Python Apps': 'Aplikacje Node/Python', 'Git': 'Git', 'Terminal': 'Terminal',
  'ClamAV': 'Antywirus', 'IMAPSync Migrations': 'Migracja IMAP', 'ModSecurity': 'ModSecurity',
  'Nginx Templates': 'Szablony Nginx', 'Perl Modules': 'Moduły Perl', 'Redis': 'Redis',
  'Nginx Unit': 'Nginx Unit', 'User Profile': 'Profil', 'System Information': 'Informacje o systemie',
  'Action Center': 'Centrum uwagi',
  'Disabling this stops scheduled runs; manual Run now still works.': 'Wyłączenie zatrzymuje harmonogram; ręczne „Uruchom teraz” nadal działa.',
  'Off by default. When enabled, each mail.queue run retries at most 10 failed or deferred messages.': 'Domyślnie wyłączone. Po włączeniu każde uruchomienie kolejki ponawia maksymalnie 10 nieudanych lub wstrzymanych wiadomości.',
  'Seconds or a suffix such as 30s, 15m, 24h. Minimum 15 seconds, maximum 30 days.': 'Sekundy lub sufiks, np. 30s, 15m, 24h. Minimum 15 sekund, maksimum 30 dni.',
  'Edit job': 'Edytuj zadanie', 'Interval': 'Interwał', 'Save job': 'Zapisz zadanie',
  'Scheduler tick source: src/scheduler.mjs. Job definitions and run history are stored in automation_jobs and automation_runs.': 'Źródło harmonogramu: src/scheduler.mjs. Definicje i historia są w automation_jobs i automation_runs.',

  'Scheduled jobs, run history and global controls': 'Zaplanowane zadania, historia uruchomień i sterowanie',
  'global scheduler active': 'globalny harmonogram aktywny', 'paused globally': 'wstrzymana globalnie',
  'jobs waiting for the next tick': 'zadania czekające na kolejny cykl', 'enabled / total': 'włączone / wszystkie',
  'wynik kontroli, nie tylko wykonanie': 'wynik kontroli, nie tylko wykonanie', 'skumulowane próby': 'skumulowane próby',
  'Disabled jobs stay in the list and keep their history.': 'Wyłączone zadania pozostają na liście i zachowują historię.',
  'due now': 'teraz', 'in': 'za', 'never': 'nigdy', 'disabled': 'wyłączone',
  'Daily server backup': 'Dzienny backup serwera', 'Backup retention': 'Retencja backupów',
  'Panel temp cleanup': 'Czyszczenie temp panelu', 'Disk usage check': 'Kontrola zajętości dysku',
  'Health check': 'Kontrola stanu', 'Mail queue check': 'Kontrola kolejki poczty', 'SSL renewal': 'Odnowienie SSL',
  'Skipped': 'Pominięte', 'Running': 'W toku', 'Failed': 'Niepowodzenie', 'Pending': 'Oczekuje',
  'Unavailable': 'Niedostępne', 'Unknown': 'Nieznane', 'Warning': 'Ostrzeżenie', 'CRITICAL': 'KRYTYCZNE',

  'Automation': 'Automatyzacja', 'Automation settings': 'Ustawienia automatyzacji',
  'Global automation': 'Globalna automatyzacja', 'Disk alert threshold (%)': 'Próg alertu dysku (%)',
  'Remove panel temp/cache older than (days)': 'Usuwaj temp/cache panelu starsze niż (dni)',
  'Retry failed/deferred mail queue items': 'Ponawiaj nieudane/wstrzymane wiadomości kolejki',
  'Scheduled jobs': 'Zaplanowane zadania', 'Due now': 'Do uruchomienia', 'Failures': 'Niepowodzenia',
  'Krytyczne obserwacje': 'Krytyczne obserwacje', 'Nieudane wykonania': 'Nieudane wykonania',
  'Jobs': 'Zadania', 'Recent runs': 'Ostatnie uruchomienia', 'Save settings': 'Zapisz ustawienia',
  'Run now': 'Uruchom teraz', 'Edit': 'Edytuj', 'Disable': 'Wyłącz', 'Enable': 'Włącz',
  'Job': 'Zadanie', 'Status': 'Status', 'Interval': 'Interwał', 'Next run': 'Następne uruchomienie',
  'Runs / failures': 'Uruchomienia / błędy', 'Actions': 'Akcje', 'Started': 'Start', 'Duration': 'Czas',
  'Output / error': 'Wynik / błąd', 'Never': 'Nigdy', 'never': 'nigdy', 'disabled': 'wyłączone',

  'List Resellers': 'Lista resellerów', 'Manage Reseller Packages': 'Pakiety resellerów',
  'Reseller Statistics': 'Statystyki resellerów', 'Reseller Tools': 'Narzędzia resellerów',
  'Show All Users': 'Wszyscy użytkownicy', 'User Tools': 'Narzędzia użytkowników',
  'Add New User': 'Dodaj użytkownika', 'Manage User Packages': 'Pakiety użytkowników',
  'Plans & Limits': 'Plany i limity', 'User Statistics': 'Statystyki użytkowników',
  'Message System': 'System wiadomości', 'Support Access': 'Dostęp supportu',
  'Audit Log': 'Dziennik audytu', 'System Cron': 'Cron systemowy', 'Bulk actions': 'Operacje masowe',
 'Mail Operations': 'Operacje poczty', 'Live transfer': 'Migracja na żywo',
  'System Services': 'Usługi systemowe', 'Web Server': 'Serwer WWW', 'Web Apps': 'Aplikacje WWW',
  'Process Monitor': 'Monitor procesów', 'Log Center': 'Centrum logów', 'Administrator Settings': 'Ustawienia administratora',
  'API Keys & MCP': 'Klucze API i MCP', 'Panel Configuration': 'Konfiguracja panelu', 'Licensing': 'Licencje',
  'CustomBuild': 'CustomBuild', 'System Packages': 'Pakiety systemowe', 'Update Center': 'Centrum aktualizacji',
  'Mail Queue': 'Kolejka poczty', 'Maintenance': 'Konserwacja', 'DB Monitor': 'Monitor bazy', 'Multi Server': 'Wiele serwerów',
  'Netdata': 'Netdata', 'Rspamd': 'Rspamd', 'Login Customization': 'Personalizacja logowania', 'Reboot': 'Restart serwera',
  'Resellers': 'Resellerzy', 'Reseller Statistics': 'Statystyki resellerów', 'Reseller Tools': 'Narzędzia resellerów',
  'Users': 'Użytkownicy', 'User Tools': 'Narzędzia użytkowników', 'Create Reseller': 'Dodaj resellera',
  'Manage Reseller Packages': 'Pakiety resellerów', 'Show All Users': 'Wszyscy użytkownicy',
  'Add New User': 'Dodaj użytkownika', 'Manage User Packages': 'Pakiety użytkowników', 'Plans & Limits': 'Plany i limity',
  'User Statistics': 'Statystyki użytkowników', 'Move Users': 'Przenoszenie kont', 'IP Management': 'Zarządzanie IP',
  'DNS Administration': 'Administracja DNS', 'Name Servers': 'Serwery nazw', 'AutoSSL Center': 'Centrum AutoSSL',
  'Skins & Themes': 'Motywy i skórki', 'Plugins': 'Wtyczki', 'Templates': 'Szablony', 'Custom HTTPD': 'Własny HTTPD',
  'Backup Center': 'Centrum backupów', 'Tickets': 'Zgłoszenia', 'Message System': 'System wiadomości',
  'Notifications': 'Powiadomienia', 'Support Access': 'Dostęp supportu', 'Audit Log': 'Dziennik audytu',
  'File Editor': 'Edytor plików', 'System Cron': 'Cron systemowy', 'Brute Force Monitor': 'Monitor brute force',
  'Automation': 'Automatyzacja', 'Bulk actions': 'Operacje masowe', 'Security Center': 'Centrum bezpieczeństwa',
  'Stan serwera': 'Stan serwera', 'Kreator konfiguracji': 'Kreator konfiguracji', 'Certyfikat panelu': 'Certyfikat panelu',

};

export function t(lang, text) {
  if (lang !== 'pl') return text;
  return PL[text] || text;
}

export function htmlLang(lang) {
  return lang === 'pl' ? 'pl' : 'en';
}

export const LANGUAGES = [{ id: 'pl', label: 'Polski' }, { id: 'en', label: 'English' }];
export const UI_MODES = [{ id: 'simple', label: 'Prosty (dla początkujących)' }, { id: 'advanced', label: 'Zaawansowany (wszystkie funkcje)' }];
