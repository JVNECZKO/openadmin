# Roundcube webmail

OpenAdmin provisions [Roundcube](https://roundcube.net/) from its official release instead of
vendoring it. This note explains the moving parts and how to verify them.

## What the panel does

1. `Admin → Web Apps → Roundcube → Install` downloads the official archive into
   `<data>/apps/roundcube`, extracts it, writes `config/config.inc.php` (SQLite DSN, IMAP host,
   SMTP host, `elastic` skin) and serves it on a loopback PHP listener, proxied at `/roundcube/`.
2. `Admin → Web Apps → Roundcube → Open preflight` checks every requirement against the host:
   PHP CLI, `imap` and `pdo_sqlite` extensions, the IMAP listener, the config file and the install.
3. The panel's own **IMAP service** listens on `127.0.0.1:1143` over the panel mail store
   (IMAP4rev1 subset: LOGIN, LIST, SELECT, FETCH, STORE, APPEND, EXPUNGE, SEARCH, LOGOUT).
   Roundcube defaults to that host. With Dovecot present, set the host to `localhost:143`.

## Requirements

| Requirement | How to provide it |
|---|---|
| PHP CLI | `apt install php-cli` (installer does this) |
| PHP `imap` extension | `apt install php-imap`, then restart PHP-FPM |
| PHP `pdo_sqlite` | `apt install php-sqlite3` |
| IMAP server | panel service :1143, or Dovecot :143 |
| SMTP submission | `sendmail`/`exim`/`msmtp` on the host for outbound mail |

`./install.sh --with-roundcube` installs MariaDB, PHP with `imap`, Dovecot and provisions Roundcube.

## Verification

```bash
# protocol-level check against the panel IMAP service
printf 'a1 LOGIN info@example.com demo\r\na2 SELECT INBOX\r\na3 LOGOUT\r\n' | nc 127.0.0.1 1143
```

The preflight page turns green only when the host satisfies every row; a missing `php-imap`
reports the exact package to install rather than pretending Roundcube works.

## Boundaries

- Roundcube's login requires PHP's `imap` extension. Without it, the container is configured but
  cannot authenticate — the built-in `/webmail` remains fully usable.
- The panel IMAP service is a focused subset (no IDLE, SORT, THREAD, ACL, quotas or STARTTLS); it is
  intended for webmail and basic clients on loopback, not as a public MX-facing IMAP server.
