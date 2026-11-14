#!/usr/bin/env bash
# OpenAdmin installer — free, open-source hosting control panel.
# Supports Debian/Ubuntu and RHEL/Rocky/AlmaLinux. Run as root:
#   curl -fsSL https://get.openadmin.dev/install.sh | bash
# or from a checkout:
#   sudo ./install.sh --port 2222
set -euo pipefail

PORT="${OA_PORT:-2222}"
HOST="${OA_HOST:-0.0.0.0}"
PREFIX="/usr/local/openadmin"
DATA_DIR="/var/lib/openadmin"
SERVICE_USER="openadmin"
PROVIDER="sandbox"
NODE_MIN="22.5.0"
NO_SERVICE=0
DEMO=0
NODE_VERSION="24.22.3"
SKIP_NODE=0
WITH_MARIADB=0
WITH_PHPMYADMIN=0
WITH_ROUNDCUBE=0

usage() {
  cat <<EOF
OpenAdmin installer

  --port <n>        Panel port (default: 2222)
  --host <addr>     Bind address (default: 0.0.0.0)
  --prefix <dir>    Install directory (default: /usr/local/openadmin)
  --data <dir>      Data directory (default: /var/lib/openadmin)
  --demo            Seed demo accounts (demouser/demoreseller/demoadmin, password: demo)
  --with-mariadb    Install and start MariaDB
  --with-phpmyadmin Install phpMyAdmin (downloaded from phpmyadmin.net)
  --with-roundcube  Install Roundcube + PHP IMAP support (needs Dovecot)
  --no-service      Do not install a systemd unit
  --skip-node       Use the Node.js already on PATH
  --provider <p>    sandbox (default) or linux for real system integration
  --uninstall       Remove the service (keeps data)
  -h, --help        Show this help

OpenAdmin is licensed under the AGPL-3.0. There are no license fees and no
paid add-ons. Every feature is included for every installation.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2;;
    --host) HOST="$2"; shift 2;;
    --prefix) PREFIX="$2"; shift 2;;
    --data) DATA_DIR="$2"; shift 2;;
    --demo) DEMO=1; shift;;
    --with-mariadb) WITH_MARIADB=1; shift;;
    --with-phpmyadmin) WITH_PHPMYADMIN=1; shift;;
    --with-roundcube) WITH_ROUNDCUBE=1; WITH_PHPMYADMIN=1; shift;;
    --no-service) NO_SERVICE=1; shift;;
    --skip-node) SKIP_NODE=1; shift;;
    --provider) PROVIDER="$2"; shift 2;;
    --uninstall) UNINSTALL=1; shift;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown option: $1"; usage; exit 1;;
  esac
done

log()  { printf '\033[1;34m[openadmin]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[openadmin]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[openadmin]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Please run as root (sudo ./install.sh)"

if [[ "${UNINSTALL:-0}" == "1" ]]; then
  systemctl stop openadmin 2>/dev/null || true
  systemctl disable openadmin 2>/dev/null || true
  rm -f /etc/systemd/system/openadmin.service
  systemctl daemon-reload || true
  log "OpenAdmin service removed. Data in ${DATA_DIR} was kept."
  exit 0
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "${SRC_DIR}/src/server.mjs" ]] || die "Run this script from the OpenAdmin source directory."

detect_pm() {
  if command -v apt-get >/dev/null 2>&1; then echo apt
  elif command -v dnf >/dev/null 2>&1; then echo dnf
  elif command -v yum >/dev/null 2>&1; then echo yum
  else echo none; fi
}
PM="$(detect_pm)"
log "Package manager: ${PM}"

install_base() {
  [[ "$PM" == "none" ]] && { warn "No supported package manager found; skipping base packages."; return; }
  local pkgs=(curl ca-certificates tar gzip)
  if [[ "$PM" == "apt" ]]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq "${pkgs[@]}" >/dev/null
  else
    "$PM" install -y -q "${pkgs[@]}" >/dev/null
  fi
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e "const [maj,min]=process.versions.node.split('.').map(Number); process.exit((maj>22)||(maj===22&&min>=5)?0:1)" 2>/dev/null
}

install_node() {
  local arch node_arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) node_arch="x64";;
    aarch64|arm64) node_arch="arm64";;
    armv7l) node_arch="armv7l";;
    *) die "Unsupported CPU architecture: ${arch}";;
  esac
  local url="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
  log "Installing Node.js ${NODE_VERSION} (${node_arch})…"
  tmp="$(mktemp -d)"
  curl -fsSL "$url" -o "${tmp}/node.tar.xz" || die "Could not download Node.js from ${url}"
  tar -xJf "${tmp}/node.tar.xz" -C "$tmp"
  install -d /usr/local/lib/nodejs
  rm -rf /usr/local/lib/nodejs/node-v${NODE_VERSION}
  mv "${tmp}/node-v${NODE_VERSION}-linux-${node_arch}" /usr/local/lib/nodejs/
  ln -sf /usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-${node_arch}/bin/node ${NODE_BIN}
  ln -sf /usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-${node_arch}/bin/npm /usr/local/bin/npm
  ln -sf /usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-${node_arch}/bin/npx /usr/local/bin/npx
  rm -rf "$tmp"
}

install_base
if [[ "$WITH_MARIADB" == "1" || "$WITH_PHPMYADMIN" == "1" || "$WITH_ROUNDCUBE" == "1" ]]; then
  log "Installing PHP and database packages…"
  if [[ "$PM" == "apt" ]]; then
    pkgs=(mariadb-server php-cli php-mysql php-sqlite3 php-mbstring php-xml php-zip php-gd php-curl)
    [[ "$WITH_ROUNDCUBE" == "1" ]] && pkgs+=(php-imap)
    apt-get install -y -qq "${pkgs[@]}" >/dev/null
    systemctl enable --now mariadb >/dev/null 2>&1 || true
  elif [[ "$PM" == "dnf" || "$PM" == "yum" ]]; then
    pkgs=(mariadb-server php-cli php-mysqlnd php-pdo php-sqlite3 php-mbstring php-xml php-zip php-gd php-curl)
    [[ "$WITH_ROUNDCUBE" == "1" ]] && pkgs+=(php-imap)
    "$PM" install -y -q "${pkgs[@]}" >/dev/null
    systemctl enable --now mariadb >/dev/null 2>&1 || true
  fi
fi
if [[ "$WITH_ROUNDCUBE" == "1" ]]; then
  log "Installing Dovecot (IMAP) for Roundcube…"
  if [[ "$PM" == "apt" ]]; then apt-get install -y -qq dovecot-imapd >/dev/null || true
  elif [[ "$PM" == "dnf" || "$PM" == "yum" ]]; then "$PM" install -y -q dovecot >/dev/null || true; fi
fi
if [[ "$SKIP_NODE" == "0" ]]; then
  if node_ok; then
    log "Node.js $(node -v) already available."
  else
    install_node
  fi
fi
node_ok || die "Node.js >= ${NODE_MIN} is required. Install it and re-run with --skip-node."
NODE_BIN="$(command -v node)"
log "Node.js $(node -v) ready (${NODE_BIN})."

if [[ "$PROVIDER" == "linux" ]]; then
  SERVICE_USER="root"
  log "Linux provider selected: the panel runs as root to manage system services."
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating system user ${SERVICE_USER}…"
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null || \
      useradd -r -d "$DATA_DIR" -s /sbin/nologin "$SERVICE_USER"
  fi
fi

log "Installing files to ${PREFIX}…"
install -d -m 0755 "$PREFIX"
rm -rf "${PREFIX}/src" "${PREFIX}/bin" "${PREFIX}/docs"
cp -R "${SRC_DIR}/src" "${PREFIX}/src"
cp -R "${SRC_DIR}/bin" "${PREFIX}/bin"
[[ -d "${SRC_DIR}/docs" ]] && cp -R "${SRC_DIR}/docs" "${PREFIX}/docs"
cp "${SRC_DIR}/package.json" "${PREFIX}/package.json"
cp "${SRC_DIR}/README.md" "${PREFIX}/README.md" 2>/dev/null || true
cp "${SRC_DIR}/LICENSE" "${PREFIX}/LICENSE" 2>/dev/null || true
chmod +x "${PREFIX}/bin/openadmin.mjs"

install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR/homes"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR/backups"

if [[ ! -f "${DATA_DIR}/openadmin.env" ]]; then
  ADMIN_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 16)"
  cat > "${DATA_DIR}/openadmin.env" <<EOF
# OpenAdmin configuration — edit and restart the service after changes.
OA_PORT=${PORT}
OA_HOST=${HOST}
OA_DATA_DIR=${DATA_DIR}
OA_PROVIDER=${PROVIDER}
OA_ADMIN_USER=admin
OA_ADMIN_PASSWORD=${ADMIN_PASSWORD}
OA_ADMIN_EMAIL=admin@$(hostname -f 2>/dev/null || hostname)
OA_SERVER_NAME=$(hostname -f 2>/dev/null || hostname)
OA_DEMO=$([[ "$DEMO" == "1" ]] && echo 1 || echo 0)
EOF
  chmod 0600 "${DATA_DIR}/openadmin.env"
  chown "$SERVICE_USER":"$SERVICE_USER" "${DATA_DIR}/openadmin.env"
else
  log "Keeping existing configuration at ${DATA_DIR}/openadmin.env"
  sed -i "s/^OA_PORT=.*/OA_PORT=${PORT}/" "${DATA_DIR}/openadmin.env"
fi

chown -R "$SERVICE_USER":"$SERVICE_USER" "$DATA_DIR"

if [[ "$WITH_PHPMYADMIN" == "1" || "$WITH_ROUNDCUBE" == "1" ]]; then
  log "Provisioning web applications (this downloads official releases)…"
  if [[ "$WITH_PHPMYADMIN" == "1" ]]; then
    env OA_DATA_DIR="$DATA_DIR" OA_PROVIDER="$PROVIDER" ${NODE_BIN} "${PREFIX}/bin/openadmin.mjs" apps install phpmyadmin || warn "phpMyAdmin provisioning failed"
  fi
  if [[ "$WITH_ROUNDCUBE" == "1" ]]; then
    env OA_DATA_DIR="$DATA_DIR" OA_PROVIDER="$PROVIDER" ${NODE_BIN} "${PREFIX}/bin/openadmin.mjs" apps install roundcube || warn "Roundcube provisioning failed"
  fi
fi

if [[ "$NO_SERVICE" == "0" ]] && command -v systemctl >/dev/null 2>&1; then
  log "Installing systemd service…"
  cat > /etc/systemd/system/openadmin.service <<EOF
[Unit]
Description=OpenAdmin hosting control panel
Documentation=https://github.com/openadmin/openadmin
After=network.target mariadb.service mysql.service
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
EnvironmentFile=${DATA_DIR}/openadmin.env
WorkingDirectory=${PREFIX}
ExecStart=${NODE_BIN} ${PREFIX}/src/server.mjs
Restart=always
RestartSec=3
LimitNOFILE=65535
$([[ "$PROVIDER" == "linux" ]] && echo "# Linux provider needs root for /etc, service reloads and system users" || echo "NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=${DATA_DIR}")

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable openadmin >/dev/null 2>&1 || true
  systemctl restart openadmin
  sleep 1
  systemctl --no-pager --lines=0 status openadmin || true
else
  warn "Skipping systemd. Start manually with:"
  warn "  env \$(cat ${DATA_DIR}/openadmin.env | xargs) node ${PREFIX}/src/server.mjs"
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[[ -z "$IP" ]] && IP="$(hostname -f 2>/dev/null || echo 127.0.0.1)"
PASS="$(grep '^OA_ADMIN_PASSWORD=' "${DATA_DIR}/openadmin.env" | cut -d= -f2-)"

cat <<EOF

  ┌──────────────────────────────────────────────────────────────┐
  │  OpenAdmin is installed                                      │
  ├──────────────────────────────────────────────────────────────┤
  │  Panel URL : http://${IP}:${PORT}
  │  Admin user: admin
  │  Password  : ${PASS}
  │  Data dir  : ${DATA_DIR}
  │  Config    : ${DATA_DIR}/openadmin.env
  └──────────────────────────────────────────────────────────────┘

  Free forever · unlimited domains · no paid add-ons · AGPL-3.0
  Change the password after your first login: /user/password
EOF
if [[ "$DEMO" == "1" ]]; then
  cat <<EOF
  Demo accounts: demouser / demoreseller / demoadmin (password: demo)
EOF
fi
