# OpenAdmin platform features (v1.1)

This document covers the advanced operations added in the second phase. Each
feature states what is real, what the host must provide, and what is explicitly
reported as unsupported rather than simulated.

## Security Center (`/admin/security`)

- IP block list (IPv4/IPv6, CIDR, expiry), applied with `nftables`; rules are
  persisted in `/etc/openadmin/firewall.nft` and an `openadmin-firewall.service`
  unit. Requires `nft` and root.
- SSH drop-in (`/etc/ssh/sshd_config.d/99-openadmin.conf`): port, password auth,
  root login, `MaxAuthTries`; validated with `sshd -t` before reload.
- Root SSH keys: import, generate (private key shown once), remove; managed block
  in `/root/.ssh/authorized_keys`.
- Password policy (`pwquality` drop-in) and panel-side validation helper.
- Country blocks download aggregated CIDR lists from ipdeny and add them to the
  nft set. If download fails, the error is shown; the list is not faked.
- Compiler group / sudo group membership and optional compiler permission
  restriction.
- Fork-bomb limits in `/etc/security/limits.d/99-openadmin.conf`.
- SMTP egress restrictions (nftables OUTPUT; root and Exim exempt).
- ModSecurity policy editor; only applies when Apache `mod_security2` is present,
  validated with `apache2ctl configtest`.

## Mail Operations Center (`/admin/mail`)

- Address diagnosis: domain, MX, SPF, DKIM, DMARC, mailbox, IMAP 993, SMTP 25/587.
  Local zones are queried through the local resolver; the server IP is used for
  port checks.
- Exim queue via `exim -bp`, retry (`-M`) and delete (`-Mrm`). Falls back to the
  panel queue table when Exim is unavailable.
- Delivery events parsed incrementally from the Exim mainlog. Duplicate lines
  are skipped.
- Sender-domain blacklist, RBL macros, custom ACL include, remote SMTP
  (smarthost + `passwd.client`), routing/split-delivery router generation.
- Greylisting is offered only when rspamd/postgrey is detected; otherwise the
  UI says it is unavailable and does not claim it is active.
- Country sender filtering stores the policy; enforcement requires an Exim
  build with GeoIP. Without it the UI says so.
- Mailbox permission repair and Dovecot config are represented by their real
  files/services, with validation, not by a success message.

## Backup Center (`/admin/backup-center`)

- Destinations: local directory, FTP/SFTP via curl, S3 via AWS CLI.
- Test connection, job scheduler (hourly/daily/weekly/monthly), scope server or
  one user, retention days, history.
- Server archives contain homes and the panel SQLite snapshot; user archives
  contain the home and per-user SQL dumps.
- Restore: dry-run lists the archive without touching files; real restore makes
  a pre-restore server backup, restores homes, and restores the SQLite tables
  (sessions and login attempts are intentionally excluded). S3/FTP require the
  corresponding CLI at restore time.

## PHP / Web Stack (`/admin/php`)

- MultiPHP discovery under `/etc/php/*/fpm`, default version, per-version INI
  drop-in, extension enable/disable (`phpenmod`/`phpdismod`), per-user PHP-FPM
  settings, Apache module management.
- Hard CPU/RAM/task limits: accounts with a package CPU or memory limit get a
  dedicated `openadmin-php-<user>.service` running in an
  `openadmin-user-<user>.slice` cgroup, with their own FPM master and socket.
  Accounts without limits keep using the global FPM pool.
- IO bandwidth is not hard-capped by this release; disk/inode quota is attempted
  with `setquota` and reported as skipped if the filesystem does not support it.

## Plans & limits (`/admin/plans`)

- Feature sets, global feature disabling, per-package resource fields
  (CPU %, memory MB, IO MB/s, processes, inodes).
- `limitsFor()` merges package limits, reseller plan limits and global feature
  switches; `capabilities()` reflects the result.
- Limit application writes limits.conf, a systemd slice, quota, and FPM sizing;
  each skipped part is reported.

## DNS Operations (`/admin/dns-ops`)

- Per-zone TTL, MX entry, templates (JSON records, apply/merge or replace),
  duplicate/empty cleanup with dry-run and rebuild.
- DNS cluster is deliberately not implemented yet; the page says so instead of
  showing a fake cluster.

## Live transfer (`/admin/import-live`)

- cPanel/DirectAdmin file transfer over SSH + rsync, single or batch (max 10),
  status/progress/log per job, sandbox simulation, encrypted credentials.
- Current scope is files/webroots; databases should be migrated with the archive
  importer. This limitation is stated in the UI.

## Update Center (`/admin/updates-center`)

- Panel update check against GitHub, staged download, backup of `src/bin/package.json`,
  dry-run and explicit apply. OS updates use `apt-get -s upgrade` for dry-run and
  `apt-get -y upgrade` only after confirmation.

## API keys & MCP (`/admin/api-keys`, `/mcp`)

- Scoped API keys (read/write/admin), IP allowlist, revocation, last-used time.
- `X-API-Key` or `Authorization: Bearer oa_...` works for REST/CMD API.
- MCP JSON-RPC endpoint with 14 read-only tools (`initialize`, `tools/list`,
  `tools/call`). A read-scoped key may POST JSON-RPC but cannot mutate data.
- Keys are hashed; the secret is shown once.

## Notifications (`/admin/notifications`, `/user/notifications`)

- In-app inbox, unread count, read-all.
- Channels: e-mail, generic webhook, Slack, Discord, Telegram; test sends.
- Scheduler notifications dispatch to enabled channels; otherwise in-app + MTA.

## Reseller tools (`/admin/reseller-tools`)

- Privilege plans with limits, assignment to resellers, delegated IPs and shared
  IP setting, ownership transfer, mass package/suspend changes.
- Shared IP is stored per reseller; automatic assignment to new accounts is not
  yet wired into user creation (stated in UI).

## Support access (`/admin/support-access`)

- Time-limited `oas_...` link, hashed in the database, read-only admin session,
  max 12h session, last-used logging, revocation deletes sessions.
- POST requests from support sessions return 403.

## AutoSSL (`/admin/ssl-center`)

- Key type (RSA 2048/4096, ECDSA P-256), issue/renew, log, service certificate
  installation for Exim/Dovecot with validation. Certbot is optional; self-signed
  fallback is logged.

## Log Center (`/admin/log-center`)

- Bounded tail/search of Nginx/Apache/Exim/mail/auth/syslog/ModSecurity/panel
  logs and simulated test logs; full-file download; logrotate drop-in with
  `logrotate -d` validation.

## Process Monitor (`/admin/processes`)

- Kill (SIGTERM), trace (`strace` snapshot or `/proc` fallback), kill-all by user,
  process action log. Protected PIDs (1, panel, parent) cannot be killed.

## Storage (`/admin/storage`)

- Multiple storage paths, capacity/usage, alert threshold, default path setting.
  Existing accounts are not moved automatically.

## Panel Configuration (`/admin/panel-config`)

- Branding (name, subtitle, logo, footer, webmail name, support URL, timezone),
  ACL toggles that feed `capabilities()`, network hostname/port/alias settings,
  export/import of a whitelisted settings document, panel restart.
- Alias requires external reverse proxy; port change requires restart.

## P2 additions

- **WebDisk**: per-user WebDAV account under `/webdisk/`, Basic auth, PROPFIND,
  GET/PUT/MKCOL/DELETE/MOVE/LOCK; live-tested with curl.
- **Application catalogue**: Joomla, Drupal, PrestaShop, Moodle; official
  downloads, MariaDB provisioning, native WP/Nextcloud installers, web
  installers where the project does not offer a CLI, CLI attempt for Moodle;
  state and installer URL are returned honestly. `/user/app-installer` redirects
  to the catalogue. Resellers install the same apps for a customer domain.
- **PostgreSQL**: optional manager; detects service and reports installation
  command when absent.
- **Multi-server**: node registry and `/api/v1/ping` health check. It is a
  registry/monitor, not a deployment orchestrator.
- **User tools**: demo accounts, shell enable/disable (`usermod -s`), skeleton
  directory for new accounts.
- **Country e-mail filter**: policy storage/UI; enforcement requires Exim GeoIP.
- **Enduser apps**: existing Node/Python app manager remains available.

## Translation status

Polish and English are the supported UI languages. New laik flows are Polish;
the client-side `i18n.js` layer translates many remaining labels on legacy pages.
Full 17-language packs are **not** included; the language registry is ready for
translation resources, but claiming complete translations would be false.

## Verification

- `node --test tests/*.test.mjs` — 301/301 passing locally and on the Debian container.
- Live checks: Security Center tabs, Mail diagnosis 100%, queue/events, backup
  job + dry-run restore, backup actual restore in test DB, PHP-FPM hard-limit
  unit (CPU 50%, memory 256 MB, TasksMax 40), API key + MCP, support read-only,
  WebDisk PUT/GET/PROPFIND, Joomla/PrestaShop web installers, Nextcloud,
  WordPress, health "Wszystko działa".
