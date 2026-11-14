// Navigation model. Mirrors the DirectAdmin information architecture:
// the same groups, page names and flows for User, Reseller and Admin.

import { t } from '../i18n.mjs';

const U = (key, label, href, icon, extra = {}) => ({ key, label, href, icon, ...extra });
const SIMPLE_USER = new Set(['home', 'stats', 'messages', 'email', 'email-new', 'forwarders', 'autoresponders', 'vacation', 'catchall', 'lists', 'spam', 'usage', 'domains', 'websites', 'subdomains', 'dns', 'pointers', 'redirects', 'ssl', 'wordpress', 'files', 'webdisk', 'ftp', 'backups', 'cron', 'databases', 'php', 'installer', 'app-catalog', 'hosted-apps', 'notifications', 'password', 'twofa', 'tickets', 'interface', 'help']);

export function navFor(level, caps = {}, opts = {}) {
  const lang = opts.lang || 'pl';
  let userGroups = [
    { title: 'Overview', items: [
      U('home', 'Dashboard', '/user', 'home'),
      U('stats', 'Statistics', '/user/statistics', 'chart'),
      U('messages', 'Messages', '/user/messages', 'bell'),
    ] },
    { title: 'Email Management', items: [
      U('email', 'E-mail Accounts', '/user/email', 'mail', { cap: caps.emails }),
      U('email-new', 'Dodaj pocztę', '/user/email/new', 'plus', { cap: caps.emails }),
      U('forwarders', 'Forwarders', '/user/email/forwarders', 'arrowRight', { cap: caps.emails }),
      U('autoresponders', 'Autoresponders', '/user/email/autoresponders', 'refresh', { cap: caps.emailResponders }),
      U('vacation', 'Vacation Messages', '/user/email/vacation', 'sun', { cap: caps.emails }),
      U('catchall', 'Catch-All E-mail', '/user/email/catch-all', 'filter', { cap: caps.catchAll }),
      U('lists', 'Mailing Lists', '/user/email/lists', 'list', { cap: caps.mailingLists }),
      U('spam', 'SPAM Filters', '/user/email/spam', 'shield', { cap: caps.spam }),
      U('usage', 'Email Usage', '/user/email/usage', 'chart', { cap: caps.emails }),
    ] },
    { title: 'Domain Management', items: [
      U('domains', 'Domains', '/user/domains', 'globe', { cap: caps.domains }),
      U('websites', 'Dodaj stronę', '/user/websites/new', 'plus', { cap: caps.domains }),
      U('subdomains', 'Subdomain Management', '/user/subdomains', 'network', { cap: caps.subdomains }),
      U('dns', 'DNS Management', '/user/dns', 'dns', { cap: caps.dns }),
      U('pointers', 'Domain Pointers', '/user/pointers', 'tag', { cap: caps.domains }),
      U('redirects', 'Site Redirects', '/user/redirects', 'arrowRight', { cap: caps.domains }),
      U('ssl', 'SSL/TLS Certificates', '/user/ssl', 'lock', { cap: caps.ssl }),
      U('wordpress', 'WordPress Manager', '/user/wordpress', 'paint', { cap: caps.wordpress }),
    ] },
    { title: 'File Management', items: [
      U('files', 'File Manager', '/user/files', 'folder'),
      U('webdisk', 'WebDisk', '/user/webdisk', 'folder'),
      U('ftp', 'FTP Management', '/user/ftp', 'upload', { cap: caps.ftp }),
      U('ftp-settings', 'FTP Settings', '/user/ftp/settings', 'settings', { cap: caps.ftp }),
      U('backups', 'Backups', '/user/backups', 'archive'),
      U('cron', 'Cron Jobs', '/user/cron', 'clock', { cap: caps.cron }),
    ] },
    { title: 'Bazy i aplikacje', items: [
      U('databases', 'Bazy danych', '/user/databases', 'database', { cap: caps.databases }),
      U('php', 'Ustawienia PHP', '/user/php', 'php'),
      U('installer', 'Aplikacje', '/user/app-catalog', 'cart'),
      U('hosted-apps', 'Node.js / Python Apps', '/user/apps', 'code', { cap: caps.nodejs || caps.python || true }),
    ] },
    { title: 'Account', items: [
      U('password', 'Password', '/user/password', 'key'),
      U('login-keys', 'Login Keys', '/user/login-keys', 'key', { cap: caps.loginKeys }),
      U('twofa', 'Two-Factor Auth', '/user/2fa', 'shield'),
      U('interface', 'Language & view', '/user/interface', 'settings'),
      U('help', 'Pomoc', '/user/help', 'info'),
      U('notifications', 'Powiadomienia', '/user/notifications', 'bell'),
      U('ssh', 'SSH Keys', '/user/ssh-keys', 'terminal', { cap: caps.ssh }),
      U('tickets', 'Tickets', '/user/tickets', 'ticket'),
    ] },
    { title: 'Advanced', items: [
      U('error-pages', 'Error Pages', '/user/error-pages', 'file'),
      U('htaccess', 'htaccess', '/user/htaccess', 'lock'),
      U('handlers', 'Apache Handlers', '/user/handlers', 'server'),
      U('mime', 'MIME types', '/user/mime-types', 'file'),
      U('protected', 'Password Protected Directories', '/user/protected-directories', 'shield'),
      U('hotlink', 'Hotlink Protection', '/user/hotlink-protection', 'link'),
      U('git', 'Git', '/user/git', 'tag', { cap: caps.git }),
      U('terminal', 'Terminal', '/user/terminal', 'terminal', { cap: caps.ssh }),
      U('clamav', 'ClamAV', '/user/clamav', 'shield', { cap: caps.spam }),
      U('imapsync', 'IMAPSync Migrations', '/user/imapsync', 'refresh', { cap: caps.emails }),
      U('waf', 'ModSecurity', '/user/modsecurity', 'shield'),
      U('nginx', 'Nginx Templates', '/user/nginx-templates', 'server'),
      U('perl', 'Perl Modules', '/user/perl-modules', 'terminal'),
      U('redis', 'Redis', '/user/redis', 'database'),
      U('unit', 'Nginx Unit', '/user/unit', 'play'),
      U('profile', 'User Profile', '/user/profile', 'user'),
      U('sysinfo', 'System Information', '/user/system-info', 'monitor'),
    ] },
  ];

  if (opts.mode === 'simple') {
    userGroups = userGroups
      .map((g) => ({ ...g, items: g.items.filter((i) => SIMPLE_USER.has(i.key)) }))
      .filter((g) => g.items.length);
  }
  userGroups = userGroups.map((g) => ({ ...g, title: t(lang, g.title), items: g.items.map((i) => ({ ...i, label: t(lang, i.label) })) }));

  const resellerGroups = [
    { title: 'Przegląd resellera', items: [
      U('r-home', 'Pulpit', '/reseller', 'home'),
      U('r-stats', 'Statystyki resellera', '/reseller/statistics', 'chart'),
      U('r-messages', 'Wiadomości', '/reseller/messages', 'bell'),
    ] },
    { title: 'Zarządzanie użytkownikami', items: [
      U('r-users', 'Moi użytkownicy', '/reseller/users', 'users'),
      U('r-create', 'Dodaj użytkownika', '/reseller/users/create', 'plus'),
      U('r-suspended', 'Zawieszeni użytkownicy', '/reseller/users/suspended', 'alert'),
      U('r-domains', 'Domeny klientów', '/reseller/domains', 'globe'),
      U('r-apps', 'Aplikacje klientów', '/reseller/apps', 'cart'),
      U('r-packages', 'Pakiety użytkowników', '/reseller/packages', 'archive'),
      U('r-move', 'Przenoszenie kont', '/reseller/users/move', 'arrowRight'),
    ] },
    { title: 'Narzędzia resellera', items: [
      U('r-ips', 'Zarządzanie IP', '/reseller/ip-manager', 'network'),
      U('r-dns', 'Administracja DNS', '/reseller/dns', 'dns'),
      U('r-ns', 'Serwery nazw', '/reseller/nameservers', 'server'),
      U('r-backups', 'Kopie zapasowe', '/reseller/backups', 'archive'),
      U('r-tickets', 'Zgłoszenia', '/reseller/tickets', 'ticket'),
      U('r-import', 'Import cPanel', '/reseller/cpanel-import', 'download'),
      U('r-passwords', 'Zmiana haseł', '/reseller/passwords', 'key'),
      U('r-message', 'Wiadomość do wszystkich', '/reseller/message-users', 'bell'),
      U('r-security', 'Security.txt', '/reseller/security-txt', 'shield'),
      U('r-skins', 'Motywy', '/reseller/customize-skin', 'paint'),
      U('r-settings', 'Ustawienia resellera', '/reseller/settings', 'settings'),
    ] },
  ];

  const adminGroups = [
    { title: 'Serwer', items: [
      U('a-home', 'Dashboard', '/admin', 'home'),
      U('a-sysinfo', 'System Information', '/admin/system-info', 'monitor'),
      U('a-health', 'Stan serwera', '/admin/health', 'check'),
      U('a-security', 'Security Center', '/admin/security', 'shield'),
      U('a-mailops', 'Mail Operations', '/admin/mail', 'mail'),
      U('a-setup', 'Kreator konfiguracji', '/admin/setup', 'settings'),
      U('a-import', 'Migracja backupów', '/admin/import', 'download'),
      U('a-import-live', 'Live transfer', '/admin/import-live', 'refresh'),
      U('a-services', 'System Services', '/admin/services', 'server'),
      U('a-webserver', 'Web Server', '/admin/web-server', 'globe'),
      U('a-php', 'PHP / Web Stack', '/admin/php', 'php'),
      U('a-mariadb', 'MariaDB', '/admin/mariadb', 'database'),
      U('a-postgres', 'PostgreSQL', '/admin/postgres', 'database'),
      U('a-apps', 'Web Apps', '/admin/web-apps', 'plug'),
      U('a-processes', 'Process Monitor', '/admin/processes', 'cpu'),
      U('a-logs', 'Log Viewer', '/admin/logs', 'file'),
      U('a-log-center', 'Log Center', '/admin/log-center', 'file'),
      U('a-settings', 'Administrator Settings', '/admin/settings', 'settings'),
      U('a-api-keys', 'API Keys & MCP', '/admin/api-keys', 'key'),
      U('a-panel-config', 'Panel Configuration', '/admin/panel-config', 'settings'),
      U('a-license', 'Licensing', '/admin/license', 'gift'),
      U('a-custombuild', 'CustomBuild', '/admin/custombuild', 'archive'),
      U('a-packages', 'System Packages', '/admin/system-packages', 'archive'),
      U('a-updates', 'Updates', '/admin/updates', 'download'),
      U('a-updates-center', 'Update Center', '/admin/updates-center', 'refresh'),
      U('a-queues', 'Mail Queue', '/admin/mail-queue', 'mail'),
      U('a-maintenance', 'Maintenance', '/admin/maintenance', 'alert'),
      U('a-dbmon', 'DB Monitor', '/admin/db-monitor', 'database'),
      U('a-multiserver', 'Multi Server', '/admin/multi-server', 'network'),
      U('a-multiserver2', 'Multi Server Registry', '/admin/multiserver', 'network'),
      U('a-netdata', 'Netdata', '/compat/admin/netdata', 'chart'),
      U('a-rspamd', 'Rspamd', '/compat/admin/rspamd', 'shield'),
      U('a-logincustom', 'Login Customization', '/admin/customize-skin/login-page', 'paint'),
      U('a-reboot', 'Reboot', '/admin/reboot', 'refresh'),
    ] },
    { title: 'Resellerzy', items: [
      U('a-resellers', 'List Resellers', '/admin/resellers', 'users'),
      U('a-reseller-create', 'Create Reseller', '/admin/resellers/create', 'plus'),
      U('a-reseller-packages', 'Manage Reseller Packages', '/admin/reseller-packages', 'archive'),
      U('a-reseller-stats', 'Reseller Statistics', '/admin/reseller-statistics', 'chart'),
      U('a-reseller-tools', 'Reseller Tools', '/admin/reseller-tools', 'users'),
    ] },
    { title: 'Użytkownicy', items: [
      U('a-users', 'Show All Users', '/admin/users', 'user'),
      U('a-user-tools', 'User Tools', '/admin/user-tools', 'users'),
      U('a-user-create', 'Add New User', '/admin/users/create', 'plus'),
      U('a-packages', 'Manage User Packages', '/admin/user-packages', 'archive'),
      U('a-plans', 'Plans & Limits', '/admin/plans', 'sliders'),
      U('a-user-stats', 'User Statistics', '/admin/user-statistics', 'chart'),
      U('a-move', 'Move Users', '/admin/users/move', 'arrowRight'),
    ] },
    { title: 'Ustawienia', items: [
      U('a-ips', 'IP Management', '/admin/ip-manager', 'network'),
      U('a-storage', 'Storage', '/admin/storage', 'database'),
      U('a-dns', 'DNS Administration', '/admin/dns', 'dns'),
      U('a-dns-ops', 'DNS Operations', '/admin/dns-ops', 'network'),
      U('a-ns', 'Name Servers', '/admin/nameservers', 'server'),
      U('a-ssl', 'Server SSL', '/admin/ssl', 'lock'),
      U('a-ssl-center', 'AutoSSL Center', '/admin/ssl-center', 'lock'),
      U('a-skins', 'Skins & Themes', '/admin/skins', 'paint'),
      U('a-plugins', 'Plugins', '/admin/plugins', 'plug'),
      U('a-templates', 'Templates', '/admin/templates', 'copy'),
      U('a-custom-httpd', 'Custom HTTPD', '/admin/custom-httpd', 'code'),
    ] },
    { title: 'Narzędzia', items: [
      U('a-backups', 'Backup / Restore', '/admin/backups', 'archive'),
      U('a-backup-center', 'Backup Center', '/admin/backup-center', 'archive'),
      U('a-tickets', 'Tickets', '/admin/tickets', 'ticket'),
      U('a-messages', 'Message System', '/admin/messages', 'bell'),
      U('a-notifications', 'Notifications', '/admin/notifications', 'bell'),
      U('a-support-access', 'Support Access', '/admin/support-access', 'shield'),
      U('a-audit', 'Audit Log', '/admin/audit-log', 'list'),
      U('a-file-editor', 'File Editor', '/admin/file-editor', 'file'),
      U('a-cron', 'System Cron', '/admin/cron', 'clock'),
      U('a-bfm', 'Brute Force Monitor', '/admin/brute-force', 'shield'),
      U('a-automation', 'Automation', '/admin/automation', 'refresh'),
    ] },
  ];

  const groups = [];
  // Each level gets its own information architecture only. The top-level
  // Admin/Reseller/User switch is the only way to reach another level's menu;
  // never append prefixed copies of another level's groups here.
  if (level === 'admin') groups.push(...adminGroups);
  else if (level === 'reseller') groups.push(...resellerGroups);
  else groups.push(...userGroups);

  return groups.map((g) => ({ ...g, items: g.items.filter((i) => i.cap !== false) }));
}

export function isActive(itemHref, path) {
  if (itemHref === path) return true;
  if (itemHref === '/user' || itemHref === '/reseller' || itemHref === '/admin') return false;
  return path.startsWith(itemHref + '/') || path === itemHref;
}

const BREADCRUMB_LABELS = {
  '2fa': '2FA', 'dns': 'DNS', 'ftp': 'FTP', 'php': 'PHP', 'ssl': 'SSL', 'api': 'API',
  'mcp': 'MCP', 'cron': 'Cron', 'ssh-keys': 'SSH keys', 'login-keys': 'Login keys',
  'webdisk': 'WebDisk', 'app-catalog': 'App catalog', 'log-center': 'Log center',
  'mail-ops': 'Mail operations', 'mail-operations': 'Mail operations', 'os': 'OS',
};

export function breadcrumbFor(path) {
  const parts = path.split('/').filter(Boolean);
  const label = (s) => {
    const clean = decodeURIComponent(s);
    if (BREADCRUMB_LABELS[clean]) return BREADCRUMB_LABELS[clean];
    return clean.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  };
  return parts.map((p, i) => ({ label: label(p), href: '/' + parts.slice(0, i + 1).join('/') }));
}
