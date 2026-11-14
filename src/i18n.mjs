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
