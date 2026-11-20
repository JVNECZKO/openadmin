# Changelog

All notable changes to OpenAdmin are recorded here. The project follows
[Semantic Versioning](https://semver.org/).

## 1.1.0 — 2026-11-20

UX and accessibility release. No breaking API or data migration; existing
installations update the panel version automatically on boot.

- Mobile card layouts for mailboxes, customer domains and Security Center summaries.
- Readable row actions with labelled overflow menus; no wrapped “Run now” button.
- Polish topbar, help and high-traffic screens; language regression test.
- One-page quick account creation with an optional site and mailbox.
- Package builder presets, collapsible sections, sticky summary and unlimited toggles.
- File manager search/sort/quota/multi-select/bulk download/delete/preview.
- E-mail all-domain view, search, bulk suspend/delete and labelled actions.
- Command palette entities and recents.
- Server-side account pagination; scoped pagination for domains, mailboxes and files.
- Direct bulk selection, dirty-form guard, password reveal/copy, inline mailbox errors.
- Shared terminology dictionary, contextual help links and collapsible dashboard/health/automation sections.
- Full verification: 327 tests and 405 QA route/width checks.

## 1.0.0 — 2026-11-14

First public release.

- Admin, Reseller and User panels with package limits enforced in the UI and API.
- 119 DirectAdmin frontend routes and 110 published <code>CMD_API_*</code> commands.
- Nginx, Apache, OpenLiteSpeed and LiteSpeed Enterprise vhost generation and validation.
- Domains, subdomains, pointers, redirects and a BIND zone editor with DKIM.
- Mailboxes, forwarders, autoresponders, vacation, catch-all, spam filters and webmail.
- Dovecot passwd-file and Exim map generation, Maildir storage and IMAP4rev1.
- File manager, FTP accounts, backups and restore, cron, MariaDB and SQL console.
- OpenSSL and Let's Encrypt certificates, PEM validation and TLS vhosts.
- WordPress, Nextcloud, phpMyAdmin and Roundcube provisioning.
- TOTP two-factor authentication, audit log, login throttling and health checks.
- cPanel and DirectAdmin migration import.
- REST API at <code>/api/v1</code> with an OpenAPI 3 document.
- English and Polish landing site at <https://openadmin.live>.
