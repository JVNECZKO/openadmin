# User and reseller parity after Webuzo/DirectAdmin review

Date: 2026-11-14. Scope: end-user and reseller hosting features, not server
administration.

## User level

Simple mode used to hide nearly everything. It now exposes the full hosting
toolbox; only genuinely technical pages (htaccess, handlers, MIME, protected
dirs, hotlink, Git, terminal, Redis, Unit, Perl, ClamAV, IMAPSync, profile,
system information, SSH keys) stay in **Advanced**.

| Area | Available to a user |
|---|---|
| Domains | add website/domain, edit PHP/SSL, delete, logs, document root |
| Subdomains | add, edit PHP/docroot, delete (DNS record maintained) |
| DNS | full record CRUD with type/priority/TTL, rebuild and validation |
| Pointers / redirects | create, edit, delete 301/302 redirects and domain pointers |
| SSL | issue/renew, upload, self-signed, per-domain certificates |
| E-mail | mailbox CRUD + password/quota, forwarders, autoresponders, vacation, catch-all, lists, spam rules, usage, DKIM/SPF/DMARC display, webmail |
| Files | upload, edit, rename, delete, archives, WebDisk/WebDAV |
| FTP | create, edit password/path/quota, suspend, delete, FTP settings |
| Databases | create, password change, delete, phpMyAdmin SSO, connection details |
| Cron | create, edit, delete, install crontab |
| Backups | create/download/restore/delete |
| PHP | per-domain version, INI, extensions (where available) |
| Applications | unified catalogue: WordPress, Nextcloud, PrestaShop, Joomla, Drupal, Moodle; installed apps list and delete |
| Node/Python apps | create, start, stop, delete |
| Account | password, 2FA, language/simple–advanced, notifications, tickets, help |

The dashboard now has resource cards, onboarding steps, app tiles and an
**All tools** grid. The old two-page app installer was replaced by one visual
catalogue at `/user/app-catalog`; `/user/app-installer` redirects there.

## Reseller level

| Area | Available to a reseller |
|---|---|
| Customers | create, edit, suspend, move, delete, login-as, package assignment |
| Packages | create, edit, copy, delete, feature sets and resource limits |
| Domains | dedicated `/reseller/domains` with customer, package, PHP, SSL, disk and DNS/manage actions |
| DNS | full record CRUD for customer zones, rebuild/apply/audit |
| Applications | `/reseller/apps` installs WordPress, Nextcloud, PrestaShop, Joomla, Drupal or Moodle directly on a customer's domain |
| IPs | delegated IP list, release |
| Backups | customer backup archive list |
| Support | tickets and replies, messages to all users |
| Migration | cPanel importer |
| Branding | skins, security.txt, settings, nameservers |

Reseller navigation no longer duplicates the whole user menu; the **User** pill
switches to the end-user view.

## Application catalogue

One page, six tiles, real installers:

- WordPress — native wp-cli installer
- Nextcloud — native installer
- PrestaShop — official archive + web installer
- Joomla — official archive + web installer
- Drupal — official archive + web installer
- Moodle — CLI attempt, web installer fallback

Each tile has brand-style inline SVG artwork, version, installer type,
install fields (collapsed until “Zainstaluj”), installed-count badge and a
“Twoje instalacje” list. Reseller tiles install against a selected customer
domain; credentials are shown once.

## Verification

`node --test tests/*.test.mjs` — **291/291 passing** (local and Debian). Browser checks:
user dashboard, application catalogue, reseller dashboard, reseller apps, all
without raw escaped HTML; tile layouts responsive at 1440 and mobile widths.

Known intentional limits: country e-mail filtering requires Exim GeoIP;
multi-server is a registry/health monitor; DNS cluster remains deferred; Node/
Python app runtime depends on host services.
