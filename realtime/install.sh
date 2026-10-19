#!/usr/bin/env bash
#
# Installs the relay of the live claim map (klap-realtime) on a server that
# deploy-wizard.sh set up: Ubuntu, nginx vhost /etc/nginx/sites-available/klap.
# Safe to run again: it rebuilds the binary and leaves a configured vhost as is.
#
#   sudo bash realtime/install.sh [port]        (default port: 8001)
#
# What it does:
#   1. Gets Go into /opt/klap-go (only to build; any other Go is untouched)
#   2. Builds /usr/local/bin/klap-realtime
#   3. Installs klap-realtime.service, bound to 127.0.0.1 only
#   4. Adds "location /_rooms" to the KLAP nginx vhost (backup kept)
#
# Nothing to change in Django: without REALTIME_WS_URL the browser looks for
# the relay at /_rooms on the site's own host.

set -euo pipefail

PORT="${1:-${RELAY_PORT:-8001}}"
HERE="$(cd "$(dirname "$0")" && pwd)"
GO_VERSION="1.22.12"
GO_ROOT="/opt/klap-go"
BIN="/usr/local/bin/klap-realtime"
UNIT="/etc/systemd/system/klap-realtime.service"
VHOST="${VHOST:-/etc/nginx/sites-available/klap}"

say() { echo "  > $1"; }
die() { echo "  ! $1" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root: sudo bash $0"

# 0. the port must be free, or already ours
listener="$(ss -ltnp "sport = :$PORT" 2>/dev/null | tail -n +2 || true)"
if [[ -n "$listener" && "$listener" != *klap-realtime* ]]; then
  die "port $PORT is in use by another program. Run again with a free port: sudo bash $0 8011"
fi

# 1. Go, only for the build
if ! "$GO_ROOT/go/bin/go" version 2>/dev/null | grep -q "go$GO_VERSION"; then
  arch="$(dpkg --print-architecture 2>/dev/null || uname -m)"
  case "$arch" in
    amd64|x86_64) arch=amd64 ;;
    arm64|aarch64) arch=arm64 ;;
    armhf|armv7l) arch=armv6l ;;
    *) die "no Go download for architecture $arch" ;;
  esac
  say "download Go $GO_VERSION ($arch) to $GO_ROOT"
  tmp="$(mktemp -d)"
  curl -fsSL "https://go.dev/dl/go$GO_VERSION.linux-$arch.tar.gz" -o "$tmp/go.tgz"
  rm -rf "$GO_ROOT"
  mkdir -p "$GO_ROOT"
  tar -C "$GO_ROOT" -xzf "$tmp/go.tgz"
  rm -rf "$tmp"
fi

# 2. build
say "build $BIN"
build="$(mktemp -d)"
(
  cd "$HERE"
  # -buildvcs=false: root builds in the checkout of the app user, and git
  # will not read a repository that another user owns
  GOTOOLCHAIN=local GOFLAGS=-mod=vendor GOPROXY=off GOPATH="$build/gopath" GOCACHE="$build/cache" CGO_ENABLED=0 \
    "$GO_ROOT/go/bin/go" build -buildvcs=false -trimpath -ldflags="-s -w" -o "$build/klap-realtime" .
)
install -m 755 "$build/klap-realtime" "$BIN"
rm -rf "$build"

# 3. service
say "install klap-realtime.service on 127.0.0.1:$PORT"
cat > "$UNIT" <<EOF
[Unit]
Description=KLAP live claim map relay (chatb rooms)
After=network.target

[Service]
ExecStart=$BIN -http 127.0.0.1:$PORT
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable klap-realtime >/dev/null 2>&1
systemctl restart klap-realtime
sleep 1
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null ||
  die "the relay does not answer. See: journalctl -u klap-realtime -n 50"

# 4. nginx: one /_rooms location in every server block that proxies KLAP
if [[ ! -f "$VHOST" ]]; then
  say "no $VHOST: add this to your nginx server block yourself:"
  cat <<EOF

    location /_rooms {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
    }

EOF
elif grep -q "location /_rooms" "$VHOST"; then
  say "$VHOST already has /_rooms (not changed)"
else
  backup="$VHOST.bak-$(date +%Y%m%d%H%M%S)"
  cp -p "$VHOST" "$backup"
  awk -v port="$PORT" '
    /^[[:space:]]*location \/ \{/ {
      print "    location /_rooms {"
      print "        proxy_pass http://127.0.0.1:" port ";"
      print "        proxy_http_version 1.1;"
      print "        proxy_set_header Upgrade $http_upgrade;"
      print "        proxy_set_header Connection \"upgrade\";"
      print "        proxy_read_timeout 86400s;"
      print "    }"
      print ""
    }
    { print }
  ' "$backup" > "$VHOST"
  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    say "added /_rooms to $VHOST (backup: $backup)"
  else
    cp -p "$backup" "$VHOST"
    die "nginx -t failed; $VHOST restored from $backup"
  fi
fi

say "done. Logs: journalctl -u klap-realtime -f"
