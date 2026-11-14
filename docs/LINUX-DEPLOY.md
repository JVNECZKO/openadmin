# Production deployment on Debian 12 (verified)

This is the exact layout used for the live end-to-end verification: a Proxmox LXC
container running Debian 12, OpenAdmin under the `linux` provider as root.

## Container

| Item | Value used in verification |
|---|---|
| Proxmox host | 192.168.3.149 (PVE 9.1) |
| Container | VMID 310, hostname `openadmin`, Debian 12 |
| Resources | 4 vCPU, 4 GB RAM, 20 GB disk |
| Network | `192.168.3.240/24`, gateway 192.168.3.1 |
| Panel | **https://192.168.3.240:2222** (admin user `admin`, password set in the setup wizard) |

## Packages

```bash
apt-get update
apt-get -y install curl ca-certificates gnupg lsb-release sudo nano tar gzip \
  openssl unzip git openssh-server cron locales tzdata

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get -y install nodejs

apt-get -y install nginx apache2 mariadb-server mariadb-client \
  bind9 bind9-utils dnsutils \
  exim4-daemon-heavy dovecot-core dovecot-imapd dovecot-lmtpd \
  opendkim opendkim-tools certbot python3-certbot-nginx proftpd-basic fail2ban \
  php8.2-fpm php8.2-cli php8.2-mysql php8.2-imap php8.2-mbstring php8.2-xml \
  php8.2-zip php8.2-gd php8.2-curl php8.2-intl php8.2-bcmath php8.2-sqlite3

# OpenLiteSpeed (optional)
wget -qO - https://repo.litespeed.sh | bash
apt-get -y install openlitespeed
```

## Panel

```bash
cd /opt/src
./install.sh --port 2222 --host 0.0.0.0 \
  --prefix /usr/local/openadmin --data /var/lib/openadmin \
  --provider linux --skip-node --with-phpmyadmin --with-roundcube
```

The installer runs the panel as root for the Linux provider (it must write `/etc`,
create system users and reload daemons). `OA_PROVIDER=linux` is written to
`/var/lib/openadmin/openadmin.env`.

## Post-install (from the panel)

1. **Settings** – set `server_ip` to the public/LAN address, `ns1`/`ns2`, default senders.
2. **Web Server** – choose nginx/Apache/OpenLiteSpeed and **Deploy**. The panel now:
   * generates per-account PHP-FPM pools in `/etc/php/8.2/fpm/pool.d/openadmin-*.conf`,
   * installs vhosts, validates the live config and stops the previously active server,
   * writes certificates to `/etc/openadmin/ssl/<domain>`.
3. **DNS** – **Rebuild all** then **Deploy**. Zone files go to `/etc/bind/*.db` and an
   `include` stanza is added to `named.conf.local`.
4. **Email** – create a mailbox, then **E-mail Summary → Deploy**. This writes:
   * `/etc/dovecot/openadmin.passwd` and `conf.d/99-openadmin.conf`,
   * `/etc/exim4/openadmin/*` plus Exim routers/transports,
   * Dovecot LMTP on `127.0.0.1:24`, Exim on `0.0.0.0:25`.
5. **DKIM** – on the domain's spam page press **Generate DKIM key**; it creates a 2048-bit
   key, publishes the TXT record and reloads Exim signing transports.
6. **SSL** – issue a self-signed certificate or upload a PEM, then redeploy the web server.
7. **Web Apps** – phpMyAdmin and Roundcube are proxied at `/phpmyadmin/` and `/roundcube/`.
   phpMyAdmin SSO is enabled under Web Apps with **Enable SSO**.

## Verified on the live container

| Check | Result |
|---|---|
| Panel login / all admin pages | 200 |
| nginx + PHP-FPM per user | `PHP_OK 8.2.35` |
| Apache + proxy_fcgi + SSL | `PHP_OK 8.2.35`, HTTPS 200 |
| OpenLiteSpeed + lsphp 8.3 + HTTPS | `PHP_OK 8.3.36`, HTTPS 200 |
| DNS | `dig @192.168.3.240 demo.openadmin.local A/MX/TXT` correct |
| SMTP → Exim → LMTP → Dovecot | delivered to Maildir, exported via IMAP |
| Roundcube | login, inbox, 4 messages |
| phpMyAdmin SSO | signed link logs in without password |
| DKIM | `DKIM-Signature` present in delivered message |
| SSL | HTTPS with `/etc/openadmin/ssl` certificate |
| User backup | tar.gz with home + DB dump, no panel DB; download 200 |
| Cron | `crontab -l -u klient1` contains the job |
| FTP | login + upload as `klient1_ftpuser`, file owned by `klient1` |
| Node app | systemd unit active, nginx proxy `/app` returns `NODE_APP_OK` |
| Setup wizard | first-run wizard completed, HTTPS enabled, HTTP port closed |
| Real WordPress | `sklep.openadmin.local`: WordPress 6.x installed with MariaDB, site + `/wp-admin` respond |
| Password reset | link delivered by Exim to a mailbox, reset succeeded, old link invalidated |
| Health page | “Wszystko działa” after certificate/backup cleanup |
| Autoconfig | `/mail/config-v1.1.xml` and `/autodiscover/autodiscover.xml` answer correctly |
| 2FA | QR code rendered with `qrencode`, secret fallback |
| Polish UI | dashboard and laik flows in Polish; `i18n.js` translates remaining labels |
| Mobile | 390×844 dashboard screenshot checked, compact table + actions visible |
| Migration | imported a synthetic cPanel `cpmove` archive: files, DNS A record and MySQL table landed correctly |
| Nextcloud | 30.0.17 installed on `cloud.openadmin.local` (PHP 8.2 pinned), login and dashboard work |
| Quotas | 2 MB over 1 MB package → upload blocked, account suspended |
| 2FA | enrollment, challenge, recovery page |

## Boundaries

- **LiteSpeed Enterprise** needs a license; the panel generates the same vhosts but the
  Enterprise binary is not installed. OpenLiteSpeed is fully working.
- **Internet mail** needs public DNS, PTR, port 25 reachability and a real TLS certificate.
  The container was verified on the LAN.
- **Root service**: intended for a dedicated hosting server; run the panel only on a
  network you control.
