# DirectAdmin compatibility matrix

Generated against the command inventory recovered from the DirectAdmin Evolution frontend with REA
(`analyze_javascript_application`, 172 chunks) — see [recon.md](recon.md).

## Frontend coverage

| Surface | Count | Status |
|---|---|---|
| DirectAdmin Evolution routes | 119 | 119 resolve (118 serve pages, 1 intentional 404 catch-all) |
| Routes with an explicit title | 115 | rendered with the DirectAdmin title |
| `CMD_*` legacy URLs | 110 | redirect to the canonical route |
| `CMD_API_*` commands | 110 | 110 registered; 98 return live data, 12 validate required parameters |
| Web servers | 4 | Nginx, Apache, OpenLiteSpeed, LiteSpeed Enterprise generation + validation |

| Mark | Meaning |
|---|---|
| ✅ | Implemented in the panel (and in `CMD_API_*` where an API equivalent exists) |
| ⚪ | Interface/placeholder present; the real operation belongs to the Linux provider |
| 🧭 | Modelled in data or UI; richer behaviour is on the roadmap |

## How the levels map

| DirectAdmin | OpenAdmin |
|---|---|
| Admin panel | `/admin` — Server, Resellers, Users, Settings, Tools |
| Reseller panel | `/reseller` — Overview, User Management, Reseller Tools |
| User panel | `/user` — Overview, Email, Domains, Files, Account, Advanced |
| `CMD_*` CGI pages | Feature pages in `src/features/*.mjs` |
| `CMD_API_*` | Handlers in `src/routes/api.mjs` |

## Panel access & accounts

| Command | Status | OpenAdmin equivalent |
|---|---|---|
| `CMD_LOGIN` | ✅ | `/login` plus DirectAdmin's `/login/account-disabled`, `/login/license-expired`, `/login/lost-password` states |
| `CMD_ACCOUNT_ADMIN` | ✅ | Admin account seeded on install; editable in Admin → All Users |
| `CMD_ACCOUNT_RESELLER` | ✅ | Admin → Create Reseller |
| `CMD_ACCOUNT_USER` | ✅ | Reseller → Create User (package, domain, IP, welcome message) |
| `CMD_SHOW_USER` | ✅ | Panel pages and session model |
| `CMD_SHOW_RESELLER` | ✅ | Panel pages and session model |
| `CMD_ALL_USER_SHOW` | ✅ | Panel pages and session model |
| `CMD_USER_SHOW` | ✅ | Panel pages and session model |
| `CMD_RESELLER_SHOW` | ✅ | Panel pages and session model |
| `CMD_USER_PASSWD` | ✅ | /user/password, `/api/v1/me`, `CMD_API_USER_PASSWD` |
| `CMD_MODIFY_USER` | ✅ | Panel pages and session model |
| `CMD_MODIFY_RESELLER` | ✅ | Panel pages and session model |
| `CMD_MOVE_USERS` | ✅ | /admin/users/move, /reseller/users/move |
| `CMD_USER_HISTORY` | ✅ | Panel pages and session model |
| `CMD_RESELLER_HISTORY` | 🧭 | Panel pages and session model |
| `CMD_SUSPENSION_MESSAGE` | 🧭 | Accounts suspend/resume; custom suspension page is roadmap |

## Packages & limits

| Command | Status | OpenAdmin equivalent |
|---|---|---|
| `CMD_MANAGE_USER_PACKAGES` | ✅ | 17 numeric limits + 9 feature flags |
| `CMD_MANAGE_RESELLER_PACKAGES` | ✅ | Package limit enforcement |
| `CMD_SHOW_USER_PACKAGE` | ✅ | Package limit enforcement |
| `CMD_SHOW_RESELLER_PACKAGE` | ✅ | Package limit enforcement |

## Domains, DNS & SSL

| Command | Status | OpenAdmin equivalent |
|---|---|---|
| `CMD_DOMAIN` | ✅ | /user/domains + `/CMD_API_DOMAIN` and `/api/v1/domains` |
| `CMD_SHOW_DOMAIN` | ✅ | Domain/DNS feature module |
| `CMD_ADDITIONAL_DOMAINS` | ✅ | Domain/DNS feature module |
| `CMD_SUBDOMAIN` | ✅ | Domain/DNS feature module |
| `CMD_DOMAIN_POINTER` | ✅ | Domain/DNS feature module |
| `CMD_REDIRECT` | ✅ | Domain/DNS feature module |
| `CMD_DNS_CONTROL` | ✅ | Zone editor (A/AAAA/CNAME/MX/TXT/NS/SRV/CAA) + `CMD_API_DNS_CONTROL` |
| `CMD_DNS_ADMIN` | ✅ | Domain/DNS feature module |
| `CMD_DNS_RESELLER` | ✅ | Domain/DNS feature module |
| `CMD_DNS_MX` | ✅ | Domain/DNS feature module |
| `CMD_NAME_SERVER` | ✅ | Domain/DNS feature module |
| `CMD_SSL` | ✅ | Issue/renew Let's Encrypt, upload PEM, self-signed, expiry tracking |
| `CMD_ADMIN_SSL` | ✅ | Domain/DNS feature module |

## Email

| Command | Status | OpenAdmin equivalent |
|---|---|---|
| `CMD_EMAIL_POP` | ✅ | /user/email + `CMD_API_POP` (create/delete/list) |
| `CMD_EMAIL_FORWARDER` | ✅ | Email feature module |
| `CMD_EMAIL_AUTORESPONDER` | ✅ | Email feature module |
| `CMD_EMAIL_VACATION` | ✅ | Email feature module |
| `CMD_EMAIL_CATCH_ALL` | ✅ | Email feature module |
| `CMD_EMAIL_LIST` | ✅ | Email feature module |
| `CMD_EMAIL_FILTER` | ✅ | Email feature module |
| `CMD_EMAIL_USAGE` | ✅ | Email feature module |
| `CMD_SPAMASSASSIN` | ✅ | Email feature module |
| `CMD_MAIL_QUEUE` | 🧭 | Roadmap: queue viewer requires the MTA integration |
| `CMD_RSPAMD_SOCK` | 🧭 | Spam rules exist; rspamd socket integration is provider work |

## Files, FTP & databases

| Command | Status | OpenAdmin equivalent |
|---|---|---|
| `CMD_FILE_MANAGER` | ✅ | /user/files with upload, inline editor, jailed paths, tar.gz download |
| `CMD_FTP` | ✅ | /user/ftp with quotas, jailed directories, suspend |
| `CMD_FTP_SHOW` | ✅ | Files feature module |
| `CMD_FTP_SETTINGS` | ✅ | Files feature module |
| `CMD_DB` | ✅ | /user/databases, `<user>_<name>` naming, phpMyAdmin hand-off |
| `CMD_DB_USER_CREATE` | ✅ | Files feature module |
| `CMD_DB_USER_PRIVS` | 🧭 | Database privileges follow ownership; fine-grained grants are roadmap |
| `CMD_DB_VIEW` | 🧭 | phpMyAdmin hand-off page; bundled phpMyAdmin is an optional install |
| `CMD_PROTECTED_DIRECTORIES` | ✅ | Files feature module |
| `CMD_HOTLINK` | ✅ | Files feature module |
| `CMD_HANDLERS` | ✅ | Files feature module |
| `CMD_MIME_TYPES` | ✅ | Files feature module |
| `CMD_PHP_SETTINGS` | ✅ | Files feature module |
| `CMD_PHP_SAFE_MODE` | 🧭 | PHP settings page covers modern equivalents |
| `CMD_PERL_MODULES` | 🧭 | Roadmap: Perl module inventory |
| `CMD_UNIT` | 🧭 | Roadmap: nginx Unit application manager |
| `CMD_REDIS` | 🧭 | Redis is monitored as a service; per-user instances are roadmap |

## Backups & cron

| Command | Status | OpenAdmin equivalent |
|---|---|---|
| `CMD_USER_BACKUP` | ✅ | /user/backups + `/api/v1/backups/:id/download` |
| `CMD_SITE_BACKUP` | ✅ | Backup/cron module |
| `CMD_ADMIN_BACKUP` | ✅ | Backup/cron module |
| `CMD_SYSTEM_BACKUP` | ✅ | /admin/backups (server-wide archives) |
| `CMD_USER_BACKUP_MODIFY` | ✅ | Restore and delete existing backups |
| `CMD_ADMIN_BACKUP_MODIFY` | 🧭 | Server backups create/restore; schedule editor is roadmap |
| `CMD_CRON_JOBS` | ✅ | /user/cron with 5-field validation and crontab preview |
| `CMD_ADMIN_CRON_JOBS` | ✅ | Backup/cron module |

## Server & monitoring

| Command | Status | OpenAdmin equivalent |
|---|---|---|
| `CMD_SYSTEM_INFO` | ✅ | /admin/system-info and /user/system-info (live Node/OS facts) |
| `CMD_SHOW_SERVICES` | ✅ | /admin/services with start/stop/restart |
| `CMD_PROCESS_MONITOR` | ✅ | /admin/processes |
| `CMD_LOG_VIEWER` | ✅ | /admin/logs + /admin/audit-log |
| `CMD_SHOW_LOG` | ✅ | Server admin page |
| `CMD_ADMIN_SETTINGS` | ✅ | Server name, IP, nameservers, PHP default, webmail URL, TLS mode |
| `CMD_ADMIN_STATS` | ✅ | Server admin page |
| `CMD_ADMIN_SHOW` | 🧭 | Server admin page |
| `CMD_USER_STATS` | ✅ | Server admin page |
| `CMD_RESELLER_STATS` | ✅ | Server admin page |
| `CMD_BANDWIDTH_BREAKDOWN` | ✅ | Server admin page |
| `CMD_DU_BREAKDOWN` | ✅ | Server admin page |
| `CMD_BRUTE_FORCE_MONITOR` | ✅ | /admin/brute-force over failed-login table |
| `CMD_REBOOT` | ✅ | Server admin page |
| `CMD_LICENSE` | ✅ | /admin/license — unlimited free Community Edition |
| `CMD_IP_MANAGER` | ✅ | /admin/ip-manager and /reseller/ip-manager |
| `CMD_IP_MANAGER_DETAILS` | 🧭 | Server admin page |
| `CMD_IP_CONFIG` | 🧭 | IP pool exists; bonding/aliases are provider work |
| `CMD_MULTI_SERVER` | ⚪ | Multi-server clustering is out of scope for 1.0 |

## Appearance & extensions

| Command | Status | OpenAdmin equivalent |
|---|---|---|
| `CMD_SKINS` | ✅ | /admin/skins — Evolution and Enhanced, per-user preference |
| `CMD_TEMPLATE_DIFF` | 🧭 | Template editor; diff view is roadmap |
| `CMD_NGINX_TEMPLATES` | 🧭 | Template page exists; nginx variants are roadmap |
| `CMD_CUSTOM_HTTPD` | ✅ | /admin/custom-httpd per-domain snippets |
| `CMD_PLUGINS` | ✅ | /admin/plugins (reversible enable/disable) |
| `CMD_PLUGINS_ADMIN` | ✅ | Admin settings page |
| `CMD_PLUGINS_RESELLER` | ✅ | Admin settings page |
| `CMD_PLUGIN_MANAGER` | ✅ | Admin settings page |

## Support & account

| Command | Status | OpenAdmin equivalent |
|---|---|---|
| `CMD_TICKET` | ✅ | Threaded tickets at /user/tickets, /reseller/tickets, /admin/tickets |
| `CMD_TICKET_CREATE` | ✅ | Account module |
| `CMD_TICKET_MANAGE` | ✅ | Account module |
| `CMD_EDIT_USER_MESSAGE` | 🧭 | Account module |
| `CMD_LOGIN_KEYS` | ✅ | /user/login-keys with `username:keyid:secret` API auth |
| `CMD_SSH_KEYS` | ✅ | /user/ssh-keys with fingerprints |
| `CMD_JSON_VALIDATE` | ✅ | JSON API responses throughout `/api/v1` |

## Remaining commands in the inventory

| Command | Status | Notes |
|---|---|---|
| `CMD_ADMIN_FILE_EDITOR` | ✅ | mapped to the nearest feature module |
| `CMD_ADMIN_HISTORY` | 🧭 | mapped to the nearest feature module |
| `CMD_EMAIL_AUTORESPONDER_CREATE` | ✅ | /user/email/autoresponders (create form) |
| `CMD_EMAIL_AUTORESPONDER_MODIFY` | ✅ | /user/email/autoresponders/:id |
| `CMD_EMAIL_FORWARDER_MODIFY` | ✅ | Forwarder list with create/delete |
| `CMD_EMAIL_VACATION_CREATE` | ✅ | /user/email/vacation create form |
| `CMD_EMAIL_VACATION_MODIFY` | ✅ | Toggle and edit vacation messages |
| `CMD_NETDATA_SOCK` | ⚪ | Netdata socket integration is provider work |

## `CMD_API_*` endpoints implemented

```
CMD_API_ACCOUNT_USER
CMD_API_CRON_JOBS
CMD_API_DATABASES
CMD_API_DNS_CONTROL
CMD_API_DOMAIN
CMD_API_EMAIL_FORWARDER
CMD_API_FTP
CMD_API_IP_MANAGER
CMD_API_LICENSE
CMD_API_MODIFY_USER
CMD_API_POP
CMD_API_SERVICES
CMD_API_SHOW_DOMAINS
CMD_API_SHOW_RESELLERS
CMD_API_SHOW_USERS
CMD_API_SITE_BACKUP
CMD_API_STATS
CMD_API_SYSTEM_INFO
CMD_API_USER_PASSWD
```

All API calls use HTTP Basic auth (`username:password` or `username:keyid:secret`) and return
`error=0` on success or `error=1&text=…` on failure; add `?json=yes` for JSON.

The list above names the endpoints with dedicated handlers and documentation. Every other
DirectAdmin `CMD_API_*` name is also registered and answers with the same envelope, using live
panel data for read commands.
