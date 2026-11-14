#!/usr/bin/env bash
# Provision a Debian 12 host/container for OpenAdmin (linux provider).
# Run as root. Installs Node, PHP, databases, DNS, mail and web servers.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

apt-get update
apt-get -y install curl ca-certificates gnupg lsb-release sudo nano tar gzip openssl unzip git openssh-server cron locales tzdata
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get -y install nodejs

echo "exim4-config exim4/dc_eximconfig_configtype select internet site" | debconf-set-selections
echo "proftpd-basic shared/proftpd/inetd_or_standalone select standalone" | debconf-set-selections

apt-get -y install nginx apache2 mariadb-server mariadb-client \
  bind9 bind9-utils dnsutils exim4-daemon-heavy dovecot-core dovecot-imapd dovecot-lmtpd \
  opendkim opendkim-tools certbot python3-certbot-nginx proftpd-basic fail2ban \
  php8.2-fpm php8.2-cli php8.2-mysql php8.2-imap php8.2-mbstring php8.2-xml \
  php8.2-zip php8.2-gd php8.2-curl php8.2-intl php8.2-bcmath php8.2-sqlite3 qrencode

# Only nginx should own port 80 after a reboot; the panel starts others on demand.
systemctl disable apache2 2>/dev/null || true
systemctl enable nginx mariadb bind9 exim4 dovecot php8.2-fpm proftpd

# OpenLiteSpeed (optional; comment out to skip)
if ! command -v lshttpd >/dev/null 2>&1; then
  wget -qO /tmp/ols.sh https://repo.litespeed.sh
  bash /tmp/ols.sh
  apt-get -y install openlitespeed
  systemctl disable lsws 2>/dev/null || true
fi

echo "Provisioning complete. Now run:"
echo "  ./install.sh --provider linux --skip-node --with-phpmyadmin --with-roundcube"
