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
  'Action Center': 'Centrum uwagi', 'Mail Operations': 'Operacje poczty', 'Live transfer': 'Migracja na żywo',
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
