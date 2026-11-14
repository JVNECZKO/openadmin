# CRUD audit — OpenAdmin after Webuzo-parity phase

Date: 2026-11-14. Scope: every primary admin/reseller/user resource, route
inventory, rendered forms, ownership checks, CSRF, apply/audit side effects.

## Bugs found and fixed

1. **Form fields rendered as literal HTML.** `form()` expected field descriptors
   but many new pages passed `field()` results, so descriptors were escaped into
   input values. Fixed centrally in `form()`; regression test scans 30+ pages for
   `value="&lt;div class="field"`.
2. **Admin DNS had no edit.** Added record editor at
   `/admin/dns?domain=…&edit=…` plus `POST /admin/dns/:id/update`; add/delete now
   rebuild the zone, apply DNS and write audit. Reseller DNS got the same editor;
   user DNS update is audited.
3. **DNS Operations had no path to edit records.** The zone table now links to the
   record editor.
4. **Table row actions lacked a server-rendered CSRF field.** Added a CSRF meta
   tag plus JS injection for all POST forms (including compact icon forms). This
   fixes submit-without-token failures in the browser.
5. **Admin backup archives could not be deleted.** Added delete action/route with
   file and row removal plus audit.
6. **Missing update operations** added for: domains, subdomains, mailboxes,
   forwarders, vacation replies, mailing lists, spam rules, FTP accounts, cron
   jobs, database passwords, redirects, pointers, handlers, MIME types, protected
   directories, WebDisk passwords, API key metadata, notification channels,
   storage paths, reseller plans, backup servers/jobs, security IP blocks, DNS
   templates, feature sets, mail filters, remote SMTP, PostgreSQL passwords and
   multi-server nodes.
7. **Tickets** now support status/priority update; **messages** and mail
   routing/remote SMTP got delete actions.

## Matrix (primary resources)

Legend: C create · R read/list/detail · U update · D delete/revoke.

| Resource | C | R | U | D | Notes |
|---|---|---|---|---|---|
| Users / resellers | ✅ | ✅ | ✅ | ✅ | package, quota, suspend, move, login-as |
| Packages / reseller plans | ✅ | ✅ | ✅ | ✅ | feature sets and resource limits |
| Domains | ✅ | ✅ | ✅ | ✅ | PHP/SSL edit; delete removes zone/mail |
| Subdomains | ✅ | ✅ | ✅ | ✅ | PHP/docroot edit |
| DNS records (admin/reseller/user) | ✅ | ✅ | ✅ | ✅ | rebuild/apply/audit on all writes |
| Mailboxes | ✅ | ✅ | ✅ | ✅ | password/quota edit; toggle |
| Forwarders / autoresponders / vacation | ✅ | ✅ | ✅ | ✅ | vacation dates/subject/body |
| Mailing lists / spam rules / catch-all | ✅ | ✅ | ✅ | ✅ | catch-all is upsert |
| FTP accounts | ✅ | ✅ | ✅ | ✅ | password/path/quota |
| Databases | ✅ | ✅ | ✅ | ✅ | password update calls MariaDB |
| Cron jobs | ✅ | ✅ | ✅ | ✅ | crontab rebuilt |
| Files | ✅ | ✅ | ✅ | ✅ | upload/save/rename/delete |
| SSL certificates | ✅ | ✅ | ✅ | ✅ | replace via upload/renew/issue |
| Backups (user/admin/center) | ✅ | ✅ | ✅ | ✅ | restore is a separate operation |
| Redirects / pointers | ✅ | ✅ | ✅ | ✅ | pointer is a DNS record |
| Handlers / MIME / protected dirs | ✅ | ✅ | ✅ | ✅ | entries are JSON-backed |
| Tickets / messages | ✅ | ✅ | ✅ | ✅ | status/priority; message delete |
| IP manager | ✅ | ✅ | ✅ | ✅ | owner/status/note |
| API keys | ✅ | ✅ | ✅ | ✅ | scopes/IPs editable; secret rotates only by recreate |
| Notification channels / inbox | ✅ | ✅ | ✅ | ✅ | channel edit; inbox read state |
| Storage / WebDisk | ✅ | ✅ | ✅ | ✅ | WebDisk password edit |
| Backup servers / jobs | ✅ | ✅ | ✅ | ✅ | edit, run, retention |
| Security IP / country / SSH keys | ✅ | ✅ | ✅ | ✅ | keys rotate by create/delete |
| DNS templates / feature sets | ✅ | ✅ | ✅ | ✅ | edit/apply |
| Mail filters / routing / remote SMTP | ✅ | ✅ | ✅ | ✅ | routing upsert; SMTP edit |
| PostgreSQL / multi-server | ✅ | ✅ | ✅ | ✅ | password / node edit |

## Deliberately not mutable

- Audit log, mail events, access logs, process action log: append-only by design.
- SSH private keys are shown once; rotate by deleting and generating a new key.
- Support-access token expiry is immutable; revoke and create a new link.
- SSL private keys are replaced through upload/renew, never edited in place.
- Application-internal settings (WordPress/Nextcloud/Joomla/Drupal/PrestaShop/
  Moodle) are managed by the application itself; the panel owns install/delete.
- DNS cluster is not implemented (explicitly deferred in the roadmap), so there is
  no fake CRUD entry for it.

## Remaining known gaps

- Table-row action forms rely on the injected CSRF token; a browser with
  JavaScript disabled cannot submit them. Server-rendered forms include the token.
- Country e-mail filtering stores policy only unless Exim has GeoIP.
- Mail routing/split delivery is limited to router generation; delivery itself is
  performed by Exim.
- Multi-server is a registry/health check, not a deployment orchestrator.
- Full translations remain PL/EN + client layer; see PLATFORM-FEATURES.md.

## Verification

`node --test tests/` — **104/104 passing** (local and Debian). The suite includes
form-leak scans, DNS edit/update, primary CRUD update paths and read-only support
sessions.
