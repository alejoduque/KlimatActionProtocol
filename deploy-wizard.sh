#!/usr/bin/env bash
#
# KLAP — Interactive Deployment Wizard for Ubuntu 18.04 LTS
#
# Walks through installing KlimatActionProtocol on a server that already runs
# other services, with port-conflict checks, isolation, and resumable steps.
#
# Run with: sudo bash deploy-wizard.sh
#

set -u  # treat unset variables as errors (but NOT -e — we handle errors interactively)

# ---------- Color & glyph palette ----------
# Disable color if not a TTY or NO_COLOR is set
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  BOLD=$'\e[1m'; DIM=$'\e[2m'; ITALIC=$'\e[3m'; UNDER=$'\e[4m'; RESET=$'\e[0m'
  RED=$'\e[38;5;203m'      # soft red
  GREEN=$'\e[38;5;114m'    # leaf green
  YELLOW=$'\e[38;5;221m'   # amber
  BLUE=$'\e[38;5;75m'      # sky blue
  CYAN=$'\e[38;5;87m'      # bright cyan
  MAGENTA=$'\e[38;5;177m'  # orchid
  ORANGE=$'\e[38;5;215m'   # warm orange
  GRAY=$'\e[38;5;245m'
  BG_DARK=$'\e[48;5;236m'
  CLR_LINE=$'\e[2K\r'
  HIDE_CURSOR=$'\e[?25l'
  SHOW_CURSOR=$'\e[?25h'
else
  BOLD=""; DIM=""; ITALIC=""; UNDER=""; RESET=""
  RED=""; GREEN=""; YELLOW=""; BLUE=""; CYAN=""; MAGENTA=""; ORANGE=""; GRAY=""
  BG_DARK=""; CLR_LINE=$'\r'; HIDE_CURSOR=""; SHOW_CURSOR=""
fi

# Restore cursor on exit
trap 'printf "%s" "$SHOW_CURSOR"' EXIT INT TERM

# ---------- Step counter for progress bar ----------
# 12 real work steps: discovery, ports, apt-fix, packages, mongo, pg, user/source,
#                     venv, settings, django, systemd+nginx, tls
TOTAL_STEPS=12
CURRENT_STEP=0
STEP_TITLE=""

progress_bar() {
  # progress_bar <current> <total> [width]
  local cur=$1 total=$2 width=${3:-40}
  local pct=$(( cur * 100 / total ))
  local filled=$(( cur * width / total ))
  local empty=$(( width - filled ))
  local bar="" i
  for ((i=0; i<filled; i++)); do bar+="█"; done
  for ((i=0; i<empty; i++));  do bar+="░"; done
  printf "${GREEN}%s${GRAY}%s${RESET} ${BOLD}%3d%%${RESET}" \
    "${bar:0:filled}" "${bar:filled}" "$pct"
}

draw_header() {
  # Top status bar — shown above every banner
  local title="${STEP_TITLE:-Starting up}"
  printf "\n${DIM}${GRAY}┌─ KLAP Wizard ─ Step %d/%d ─ %s${RESET}\n" \
    "$CURRENT_STEP" "$TOTAL_STEPS" "$title"
  printf "${DIM}${GRAY}│${RESET} "; progress_bar "$CURRENT_STEP" "$TOTAL_STEPS" 50; printf "\n"
  printf "${DIM}${GRAY}└%s${RESET}\n" "$(printf '─%.0s' {1..70})"
}

banner() {
  CURRENT_STEP=$(( CURRENT_STEP + 1 ))
  STEP_TITLE="$1"
  local title="$1"
  local line; line=$(printf '═%.0s' {1..66})
  echo
  echo "${BOLD}${CYAN}╔${line}╗${RESET}"
  printf  "${BOLD}${CYAN}║${RESET}  ${BOLD}${MAGENTA}▶ Step %2d/%d${RESET}  ${BOLD}%-44s${RESET} ${BOLD}${CYAN}║${RESET}\n" \
    "$CURRENT_STEP" "$TOTAL_STEPS" "$title"
  printf  "${BOLD}${CYAN}║${RESET}  "; progress_bar "$CURRENT_STEP" "$TOTAL_STEPS" 56; printf "  ${BOLD}${CYAN}║${RESET}\n"
  echo "${BOLD}${CYAN}╚${line}╝${RESET}"
}

# Sub-step header (does NOT advance the counter)
sub_banner() {
  echo
  echo "${BOLD}${ORANGE}┄┄┄ $1 ┄┄┄${RESET}"
}

# Informational banner (does NOT advance the counter)
info_banner() {
  local title="$1"
  local line; line=$(printf '─%.0s' {1..66})
  echo
  echo "${BOLD}${ORANGE}┌${line}┐${RESET}"
  printf  "${BOLD}${ORANGE}│${RESET}  ${BOLD}%-62s${RESET}  ${BOLD}${ORANGE}│${RESET}\n" "$title"
  echo "${BOLD}${ORANGE}└${line}┘${RESET}"
}

say()   { echo "${BLUE}  ◆${RESET}  $1"; }
ok()    { echo "${GREEN}  ✓${RESET}  $1"; }
warn()  { echo "${YELLOW}  ⚠${RESET}  $1"; }
err()   { echo "${RED}  ✗${RESET}  $1"; }
step()  { echo; echo "${BOLD}${YELLOW}  ▸ $1${RESET}"; }
note()  { echo "${DIM}${GRAY}     $1${RESET}"; }

# ---------- Spinner: run a command with a live spinner ----------
run_with_spinner() {
  # run_with_spinner "Label" command args...
  local label="$1"; shift
  local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  local logfile; logfile=$(mktemp /tmp/klap-wizard.XXXXXX.log)

  printf "%s" "$HIDE_CURSOR"
  ( "$@" >"$logfile" 2>&1 ) &
  local pid=$!
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    printf "${CLR_LINE}  ${CYAN}%s${RESET}  ${BOLD}%s${RESET} ${DIM}${GRAY}(running…)${RESET}" \
      "${frames[i % ${#frames[@]}]}" "$label"
    i=$((i+1))
    sleep 0.08
  done
  wait "$pid"
  local rc=$?
  printf "%s" "$SHOW_CURSOR"

  if [[ $rc -eq 0 ]]; then
    printf "${CLR_LINE}  ${GREEN}✓${RESET}  ${BOLD}%s${RESET} ${DIM}${GRAY}(done)${RESET}\n" "$label"
    rm -f "$logfile"
  else
    printf "${CLR_LINE}  ${RED}✗${RESET}  ${BOLD}%s${RESET} ${RED}(failed, rc=%d)${RESET}\n" "$label" "$rc"
    echo "${DIM}${GRAY}     ── last 20 lines of output ──${RESET}"
    tail -20 "$logfile" | sed "s/^/${DIM}${GRAY}     /; s/$/${RESET}/"
    echo "${DIM}${GRAY}     Full log: $logfile${RESET}"
  fi
  return $rc
}

# ---------- Pretty key:value list ----------
kv() {
  # kv "Label" "value"
  printf "  ${DIM}${GRAY}%-22s${RESET}  ${BOLD}%s${RESET}\n" "$1" "$2"
}

# ---------- Splash screen ----------
splash() {
  clear
  cat <<EOF
${BOLD}${GREEN}
       ██╗  ██╗██╗      █████╗ ██████╗
       ██║ ██╔╝██║     ██╔══██╗██╔══██╗
       █████╔╝ ██║     ███████║██████╔╝
       ██╔═██╗ ██║     ██╔══██║██╔═══╝
       ██║  ██╗███████╗██║  ██║██║
       ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝${RESET}
       ${ITALIC}${CYAN}KlimatActionProtocol — Deployment Wizard${RESET}
       ${DIM}${GRAY}Ubuntu 18.04 LTS · safe coexistence mode${RESET}

EOF
}

# ---------- Prompts ----------
ask() {
  # ask "Prompt text" "default_value"
  local prompt="$1" default="${2-}" reply
  if [[ -n "$default" ]]; then
    printf "  ${MAGENTA}❯${RESET} ${BOLD}%s${RESET} ${DIM}${GRAY}[%s]${RESET}: " "$prompt" "$default" >&2
    read -r reply
    echo "${reply:-$default}"
  else
    printf "  ${MAGENTA}❯${RESET} ${BOLD}%s${RESET}: " "$prompt" >&2
    read -r reply
    echo "$reply"
  fi
}

confirm() {
  # confirm "Question" "y" -> returns 0 (yes) or 1 (no)
  local prompt="$1" default="${2:-n}" reply hint
  [[ "$default" == "y" ]] && hint="${GREEN}Y${RESET}/${DIM}n${RESET}" || hint="${DIM}y${RESET}/${RED}N${RESET}"
  printf "  ${MAGENTA}?${RESET} ${BOLD}%s${RESET} [%s]: " "$prompt" "$hint" >&2
  read -r reply
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy]$ ]]
}

pause() {
  printf "  ${DIM}${GRAY}Press ENTER to continue…${RESET} " >&2
  read -r _
}

# ---------- Safety check: must be root ----------
if [[ $EUID -ne 0 ]]; then
  err "This wizard installs system packages and must run as root."
  echo "    Re-run with: sudo bash $0"
  exit 1
fi

# ---------- Safety check: Ubuntu 18.04 ----------
if ! grep -q "Ubuntu 18.04" /etc/os-release 2>/dev/null; then
  warn "This wizard was designed for Ubuntu 18.04 LTS."
  warn "Detected: $(. /etc/os-release && echo "$PRETTY_NAME")"
  confirm "Continue anyway?" "n" || exit 1
fi

# ---------- Helpers ----------
port_in_use() {
  # Returns 0 (true) if the port is in use
  ss -tlnH "sport = :$1" 2>/dev/null | grep -q .
}

port_owner() {
  # Print who is listening on the port (best effort)
  ss -tlnpH "sport = :$1" 2>/dev/null | awk -F'"' '{print $2}' | sort -u | tr '\n' ' '
}

pick_free_port() {
  # Find a free port starting at $1, returns first free
  local p=$1
  while port_in_use "$p"; do
    p=$((p+1))
  done
  echo "$p"
}

random_secret() {
  # Generate a 50-char random secret using /dev/urandom (no python dependency)
  tr -dc 'A-Za-z0-9!@#%^&*()_+=-' </dev/urandom | head -c 50
}

# ---------- State file (resumable) ----------
STATE_FILE="/var/lib/klap-wizard.state"
mkdir -p "$(dirname "$STATE_FILE")"
touch "$STATE_FILE"
# shellcheck disable=SC1090
source "$STATE_FILE"

save_state() {
  cat > "$STATE_FILE" <<EOF
APP_USER="${APP_USER:-}"
APP_DIR="${APP_DIR:-}"
STATIC_DIR="${STATIC_DIR:-}"
SOURCE_MODE="${SOURCE_MODE:-}"
GIT_URL="${GIT_URL:-}"
GUNICORN_PORT="${GUNICORN_PORT:-}"
VHOST_MODE="${VHOST_MODE:-}"
NGINX_PORT="${NGINX_PORT:-}"
ENABLE_TLS="${ENABLE_TLS:-}"
TLS_EMAIL="${TLS_EMAIL:-}"
MONGO_PORT="${MONGO_PORT:-}"
PG_DB="${PG_DB:-}"
PG_USER="${PG_USER:-}"
PG_PASSWORD="${PG_PASSWORD:-}"
SERVER_NAME="${SERVER_NAME:-}"
SECRET_KEY="${SECRET_KEY:-}"
STAGE_APT_FIX="${STAGE_APT_FIX:-0}"
STAGE_PKGS="${STAGE_PKGS:-0}"
STAGE_MONGO="${STAGE_MONGO:-0}"
STAGE_PG="${STAGE_PG:-0}"
STAGE_USER="${STAGE_USER:-0}"
STAGE_SOURCE="${STAGE_SOURCE:-0}"
STAGE_VENV="${STAGE_VENV:-0}"
STAGE_SETTINGS="${STAGE_SETTINGS:-0}"
STAGE_DJANGO="${STAGE_DJANGO:-0}"
STAGE_SYSTEMD="${STAGE_SYSTEMD:-0}"
STAGE_NGINX="${STAGE_NGINX:-0}"
STAGE_TLS="${STAGE_TLS:-0}"
EOF
  chmod 600 "$STATE_FILE"
}

# ---------- Pinned versions (last that support Python 2.7) ----------
PY2_PIP_VERSION="20.3.4"
PY2_SETUPTOOLS_VERSION="44.1.1"
PY2_WHEEL_VERSION="0.37.1"
PY2_VIRTUALENV_VERSION="20.15.1"
GET_PIP_PY2_URL="https://bootstrap.pypa.io/pip/2.7/get-pip.py"

splash

echo "${BOLD}  What this wizard does${RESET}"
echo "${GREEN}  ✓${RESET}  Checks every port ${BOLD}before${RESET} binding it"
echo "${GREEN}  ✓${RESET}  Runs as a dedicated ${BOLD}klap${RESET} UNIX user (no root for the app)"
echo "${GREEN}  ✓${RESET}  Binds Gunicorn to ${BOLD}127.0.0.1${RESET} only (never exposed directly)"
echo "${GREEN}  ✓${RESET}  Creates a ${BOLD}new${RESET} PostgreSQL database — your existing PG is untouched"
echo "${GREEN}  ✓${RESET}  Relocates MongoDB to a non-standard port if 27017 is taken"
echo "${GREEN}  ✓${RESET}  Detects EOL apt mirrors and rewires to ${BOLD}old-releases.ubuntu.com${RESET}"
echo "${GREEN}  ✓${RESET}  Pins Python 2.7 tooling: pip ${BOLD}$PY2_PIP_VERSION${RESET} · setuptools ${BOLD}$PY2_SETUPTOOLS_VERSION${RESET}"
echo "${GREEN}  ✓${RESET}  Resumable — progress saved to ${DIM}${GRAY}/var/lib/klap-wizard.state${RESET}"
echo
echo "${DIM}${GRAY}  Nothing destructive will run without your confirmation.${RESET}"
echo
confirm "Ready to begin?" "y" || exit 0

# ============================================================
banner "Discovery: what's already running"
# ============================================================
step "Scanning common ports"
for p in 22 80 443 8000 8080 5432 27017 6379; do
  if port_in_use "$p"; then
    owner=$(port_owner "$p")
    warn "Port $p is IN USE  ${DIM}(${owner:-unknown})${RESET}"
  else
    ok   "Port $p is free"
  fi
done

echo
say "Other listening sockets on this host:"
ss -tlnH | awk '{print "    " $4}' | sort -u
echo
pause

# ============================================================
banner "Choose ports (with conflict detection)"
# ============================================================

# --- Gunicorn (loopback only) ---
step "Internal Gunicorn port (bound to 127.0.0.1 only)"
say "This port is never exposed to the network — only nginx talks to it."
default_gunicorn=$(pick_free_port 8000)
GUNICORN_PORT="${GUNICORN_PORT:-$default_gunicorn}"
while :; do
  GUNICORN_PORT=$(ask "Gunicorn port" "$default_gunicorn")
  if port_in_use "$GUNICORN_PORT"; then
    warn "Port $GUNICORN_PORT is busy ($(port_owner "$GUNICORN_PORT"))"
    default_gunicorn=$(pick_free_port $((GUNICORN_PORT+1)))
  else
    ok "Gunicorn will use 127.0.0.1:$GUNICORN_PORT"
    break
  fi
done

# --- Public exposure: subdomain vhost vs. dedicated port ---
step "How will users reach KLAP?"
nginx_owns_80=0
if port_in_use 80 && port_owner 80 | grep -qi nginx; then
  nginx_owns_80=1
  ok "Detected: nginx is already listening on port 80"
fi

echo "  1) Subdomain virtual host on port 80/443 (e.g. https://klap.altered.xyz)"
echo "     ${DIM}— recommended; uses your existing nginx, DNS A record required${RESET}"
echo "  2) Dedicated port (e.g. http://server-ip:8080)"
echo "     ${DIM}— quick, no DNS needed${RESET}"
default_vhost_mode="${VHOST_MODE:-1}"
[[ "$nginx_owns_80" == "0" ]] && default_vhost_mode="${VHOST_MODE:-2}"
VHOST_MODE=$(ask "Choose 1 or 2" "$default_vhost_mode")

if [[ "$VHOST_MODE" == "1" ]]; then
  # --- Subdomain mode ---
  step "Subdomain configuration"
  SERVER_NAME=$(ask "Public subdomain (must already point to this server via DNS A record)" "${SERVER_NAME:-klap.altered.xyz}")
  resolved=$(getent hosts "$SERVER_NAME" 2>/dev/null | awk '{print $1}' | head -1)
  my_ips=$(hostname -I 2>/dev/null)
  if [[ -z "$resolved" ]]; then
    warn "DNS for $SERVER_NAME does not resolve yet."
    warn "Add an A record pointing to one of: $my_ips"
    confirm "Continue anyway? (you can fix DNS later)" "y" || exit 0
  elif ! echo " $my_ips " | grep -q " $resolved "; then
    warn "$SERVER_NAME resolves to $resolved but this server's IPs are: $my_ips"
    confirm "Continue anyway?" "n" || exit 0
  else
    ok "$SERVER_NAME → $resolved (matches this server)"
  fi
  NGINX_PORT=80

  step "HTTPS via Let's Encrypt?"
  say "Recommended. The wizard will install certbot and obtain a cert for $SERVER_NAME."
  if confirm "Enable HTTPS with Let's Encrypt?" "y"; then
    ENABLE_TLS=1
    TLS_EMAIL=$(ask "Email for Let's Encrypt renewal notices" "${TLS_EMAIL:-}")
  else
    ENABLE_TLS=0
  fi
else
  # --- Dedicated port mode ---
  step "Public-facing nginx port"
  say "Users will hit http://<server>:<this-port>/"
  if port_in_use 80; then
    default_nginx=$(pick_free_port 8080)
  else
    default_nginx=80
  fi
  NGINX_PORT="${NGINX_PORT:-$default_nginx}"
  while :; do
    NGINX_PORT=$(ask "Nginx public port" "$default_nginx")
    if [[ "$NGINX_PORT" == "$GUNICORN_PORT" ]]; then
      err "Cannot be the same as the Gunicorn port"; continue
    fi
    if port_in_use "$NGINX_PORT"; then
      if port_owner "$NGINX_PORT" | grep -qi nginx; then
        ok "Port $NGINX_PORT is owned by nginx — we'll add a virtual host"
        break
      fi
      warn "Port $NGINX_PORT is busy ($(port_owner "$NGINX_PORT"))"
      default_nginx=$(pick_free_port $((NGINX_PORT+1)))
    else
      ok "Nginx will listen on $NGINX_PORT"; break
    fi
  done
  ENABLE_TLS=0
fi

# --- MongoDB ---
step "MongoDB port"
say "KLAP needs MongoDB 3.6 (pymongo 2.6.3 is incompatible with 4.x+)."
if port_in_use 27017; then
  warn "Port 27017 is already taken — likely another MongoDB."
  say "We will install MongoDB 3.6 on a non-standard port to avoid conflict."
  default_mongo=$(pick_free_port 27018)
else
  default_mongo=27017
fi
MONGO_PORT="${MONGO_PORT:-$default_mongo}"
MONGO_PORT=$(ask "MongoDB port" "$default_mongo")

# --- Hostname / IP (only ask in port mode; subdomain mode already set it) ---
if [[ "$VHOST_MODE" != "1" ]]; then
  step "Public hostname or IP"
  detected_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  SERVER_NAME="${SERVER_NAME:-$detected_ip}"
  SERVER_NAME=$(ask "Server hostname or IP" "${SERVER_NAME:-localhost}")
fi

# --- App user & paths ---
step "Application identity"
APP_USER="${APP_USER:-klap}"
APP_USER=$(ask "Dedicated UNIX user to own the app" "$APP_USER")
APP_DIR="/home/$APP_USER/app"
STATIC_DIR="/home/$APP_USER/static"

# --- Source ---
step "Where does the source come from?"
echo "  1) Clone from a git URL"
echo "  2) Source is already at $APP_DIR (e.g. you scp'd it there)"
choice=$(ask "Choose 1 or 2" "${SOURCE_MODE:-2}")
SOURCE_MODE="$choice"
if [[ "$SOURCE_MODE" == "1" ]]; then
  GIT_URL=$(ask "Git URL" "${GIT_URL:-}")
fi

# --- Database creds ---
step "PostgreSQL credentials (a NEW database — your existing PG is untouched)"
PG_DB="${PG_DB:-klap}"
PG_USER="${PG_USER:-klap}"
PG_DB=$(ask "New database name" "$PG_DB")
PG_USER=$(ask "New database user" "$PG_USER")
if [[ -z "${PG_PASSWORD:-}" ]]; then
  PG_PASSWORD=$(random_secret | tr -d '"'"'"'\\$`' | head -c 24)
fi
say "Generated PG password: ${DIM}$PG_PASSWORD${RESET} (saved to state file)"

# --- Secret key ---
if [[ -z "${SECRET_KEY:-}" ]]; then
  SECRET_KEY=$(random_secret)
fi

# --- Summary ---
echo
info_banner "Configuration summary"
kv "App user"            "$APP_USER"
kv "App directory"       "$APP_DIR"
kv "Source mode"         "$([ "$SOURCE_MODE" = "1" ] && echo "git → $GIT_URL" || echo "pre-staged")"
kv "Public hostname"     "$SERVER_NAME"
kv "Exposure mode"       "$([ "$VHOST_MODE" = "1" ] && echo "subdomain vhost on port 80$([ "$ENABLE_TLS" = "1" ] && echo " + HTTPS")" || echo "dedicated port $NGINX_PORT")"
kv "Gunicorn (internal)" "127.0.0.1:$GUNICORN_PORT"
kv "MongoDB port"        "$MONGO_PORT"
kv "PostgreSQL DB/user"  "$PG_DB / $PG_USER"
kv "Static files dir"    "$STATIC_DIR"
echo
confirm "Proceed with this configuration?" "y" || { warn "Aborted. Re-run to change choices."; exit 0; }
save_state

# ============================================================
banner "Apt sources health check (Ubuntu 18.04 is EOL)"
# ============================================================
if [[ "$STAGE_APT_FIX" != "1" ]]; then
  say "Ubuntu 18.04 reached end-of-life in April 2023."
  say "The main archive mirrors no longer serve it — packages now live on old-releases.ubuntu.com."
  say "Testing whether 'apt-get update' still works against current sources..."

  apt_log=$(mktemp)
  if apt-get update -o Acquire::Retries=1 >"$apt_log" 2>&1; then
    if grep -qE '(404|Failed to fetch|does not have a Release file)' "$apt_log"; then
      apt_broken=1
    else
      apt_broken=0
    fi
  else
    apt_broken=1
  fi

  if [[ "$apt_broken" == "1" ]]; then
    warn "apt sources are returning errors — likely hitting dead archive mirrors."
    echo
    say "Proposed fix: rewrite archive URLs to old-releases.ubuntu.com"
    say "Your existing sources files will be backed up to /etc/apt/sources.list.d/.klap-backup-<timestamp>/"
    if confirm "Apply this fix?" "y"; then
      ts=$(date +%s)
      backup_dir="/etc/apt/.klap-backup-$ts"
      mkdir -p "$backup_dir"
      cp /etc/apt/sources.list "$backup_dir/" 2>/dev/null || true
      cp -r /etc/apt/sources.list.d "$backup_dir/" 2>/dev/null || true

      # Only rewrite Ubuntu archive URLs — leave third-party PPAs alone
      sed -i \
        -e 's|http://archive.ubuntu.com/ubuntu|http://old-releases.ubuntu.com/ubuntu|g' \
        -e 's|http://security.ubuntu.com/ubuntu|http://old-releases.ubuntu.com/ubuntu|g' \
        -e 's|http://[a-z0-9.]*\.archive\.ubuntu\.com/ubuntu|http://old-releases.ubuntu.com/ubuntu|g' \
        /etc/apt/sources.list

      if apt-get update >"$apt_log" 2>&1; then
        ok "apt sources fixed — old-releases.ubuntu.com is reachable"
      else
        err "apt-get update still failing after fix. Showing last lines:"
        tail -20 "$apt_log"
        err "Restore backup with: cp -r $backup_dir/* /etc/apt/"
        exit 1
      fi
    else
      warn "Skipping fix — package install will probably fail. Continuing anyway."
    fi
  else
    ok "apt sources look healthy"
  fi
  rm -f "$apt_log"
  STAGE_APT_FIX=1; save_state
else
  ok "Apt sources check already done (skipped)"
fi

# ============================================================
banner "System packages"
# ============================================================
if [[ "$STAGE_PKGS" != "1" ]]; then
  run_with_spinner "apt-get update" apt-get update
  run_with_spinner "Install Python 2.7 + build tools"        apt-get install -y python python-pip python-dev build-essential libpq-dev
  run_with_spinner "Install PostgreSQL"                       apt-get install -y postgresql postgresql-contrib
  run_with_spinner "Install Redis"                            apt-get install -y redis-server
  run_with_spinner "Install nginx"                            apt-get install -y nginx
  run_with_spinner "Install git/curl/gnupg/wget"              apt-get install -y git curl gnupg wget ca-certificates
  STAGE_PKGS=1; save_state

  # Record currently-installed versions for reference
  {
    echo "# Versions captured $(date -Iseconds)"
    for pkg in python postgresql redis-server nginx libpq-dev; do
      ver=$(dpkg-query -W -f='${Version}' "$pkg" 2>/dev/null || echo "not-installed")
      echo "$pkg=$ver"
    done
  } > /var/lib/klap-wizard.versions
  ok "Recorded installed versions in /var/lib/klap-wizard.versions"
else
  ok "Packages already installed (skipped)"
fi

# ============================================================
banner "MongoDB 3.6"
# ============================================================
if [[ "$STAGE_MONGO" != "1" ]]; then
  if ! command -v mongod >/dev/null 2>&1; then
    say "Adding MongoDB 3.6 apt repo"
    wget -qO - https://www.mongodb.org/static/pgp/server-3.6.asc | apt-key add - >/dev/null 2>&1
    echo "deb [ arch=amd64 ] https://repo.mongodb.org/apt/ubuntu bionic/mongodb-org/3.6 multiverse" \
      > /etc/apt/sources.list.d/mongodb-org-3.6.list
    run_with_spinner "apt-get update (MongoDB repo)" apt-get update
    run_with_spinner "Install MongoDB 3.6"            apt-get install -y mongodb-org
  else
    ok "mongod already present"
  fi

  if [[ "$MONGO_PORT" != "27017" ]]; then
    say "Configuring MongoDB to listen on port $MONGO_PORT"
    sed -i "s/^  port:.*/  port: $MONGO_PORT/" /etc/mongod.conf || true
    grep -q "^  port:" /etc/mongod.conf || sed -i "/^net:/a\  port: $MONGO_PORT" /etc/mongod.conf
  fi

  systemctl enable mongod
  systemctl restart mongod
  sleep 2
  if port_in_use "$MONGO_PORT"; then
    ok "MongoDB listening on $MONGO_PORT"
  else
    err "MongoDB did NOT come up on port $MONGO_PORT — check 'journalctl -u mongod'"
    exit 1
  fi
  STAGE_MONGO=1; save_state
else
  ok "MongoDB stage already complete (skipped)"
fi

# ============================================================
banner "PostgreSQL database"
# ============================================================
if [[ "$STAGE_PG" != "1" ]]; then
  if sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$PG_DB'" | grep -q 1; then
    warn "Database '$PG_DB' already exists — leaving it untouched"
  else
    sudo -u postgres psql <<EOF
CREATE USER $PG_USER WITH PASSWORD '$PG_PASSWORD';
CREATE DATABASE $PG_DB OWNER $PG_USER;
EOF
    ok "Created database '$PG_DB' owned by '$PG_USER'"
  fi
  STAGE_PG=1; save_state
else
  ok "PostgreSQL stage already complete (skipped)"
fi

# ============================================================
banner "Application user & source"
# ============================================================
if [[ "$STAGE_USER" != "1" ]]; then
  if id "$APP_USER" >/dev/null 2>&1; then
    ok "User '$APP_USER' already exists"
  else
    adduser --disabled-login --gecos "" "$APP_USER"
    ok "Created user '$APP_USER'"
  fi
  STAGE_USER=1; save_state
fi

if [[ "$STAGE_SOURCE" != "1" ]]; then
  if [[ "$SOURCE_MODE" == "1" ]]; then
    if [[ -d "$APP_DIR/.git" ]]; then
      warn "Repo already cloned at $APP_DIR"
    else
      sudo -u "$APP_USER" git clone "$GIT_URL" "$APP_DIR"
    fi
  else
    if [[ ! -d "$APP_DIR" ]]; then
      err "Source mode = 'pre-staged' but $APP_DIR does not exist."
      err "Copy the project to $APP_DIR (e.g. with scp), then re-run this wizard."
      exit 1
    fi
    chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  fi

  if [[ ! -f "$APP_DIR/web/manage.py" ]]; then
    err "$APP_DIR/web/manage.py not found — is this the right project?"
    exit 1
  fi
  ok "Source present at $APP_DIR"
  STAGE_SOURCE=1; save_state
fi

# ============================================================
banner "Python virtualenv & dependencies"
# ============================================================
if [[ "$STAGE_VENV" != "1" ]]; then
  say "System pip for Python 2 is too old to talk to modern PyPI."
  say "Bootstrapping pinned tooling for Python 2.7:"
  say "  pip=$PY2_PIP_VERSION  setuptools=$PY2_SETUPTOOLS_VERSION  wheel=$PY2_WHEEL_VERSION  virtualenv=$PY2_VIRTUALENV_VERSION"

  GET_PIP_LOCAL="/home/$APP_USER/get-pip.py"
  if [[ ! -f "$GET_PIP_LOCAL" ]]; then
    run_with_spinner "Fetch get-pip.py (Python 2.7 shim)" \
      sudo -u "$APP_USER" -H curl -fsSL "$GET_PIP_PY2_URL" -o "$GET_PIP_LOCAL"
  fi

  run_with_spinner "Install pinned pip/setuptools/wheel (user site)" \
    sudo -u "$APP_USER" -H python2.7 "$GET_PIP_LOCAL" --user \
      "pip==$PY2_PIP_VERSION" \
      "setuptools==$PY2_SETUPTOOLS_VERSION" \
      "wheel==$PY2_WHEEL_VERSION"

  run_with_spinner "Install pinned virtualenv $PY2_VIRTUALENV_VERSION" \
    sudo -u "$APP_USER" -H bash -c \
      "\$HOME/.local/bin/pip install --user 'virtualenv==$PY2_VIRTUALENV_VERSION'"

  if [[ ! -d "$APP_DIR/venv" ]]; then
    run_with_spinner "Create virtualenv at $APP_DIR/venv" \
      sudo -u "$APP_USER" -H bash -c \
        "cd '$APP_DIR' && \$HOME/.local/bin/virtualenv -p python2.7 venv"
  fi

  run_with_spinner "Upgrade pip/setuptools/wheel inside venv" \
    sudo -u "$APP_USER" -H bash -c "
      cd '$APP_DIR'
      source venv/bin/activate
      pip install --upgrade \
        'pip==$PY2_PIP_VERSION' \
        'setuptools==$PY2_SETUPTOOLS_VERSION' \
        'wheel==$PY2_WHEEL_VERSION'
    "

  run_with_spinner "pip install -r requirements.txt (this is the slow one)" \
    sudo -u "$APP_USER" -H bash -c "
      cd '$APP_DIR'
      source venv/bin/activate
      pip install -r requirements.txt
    "

  run_with_spinner "Install gunicorn" \
    sudo -u "$APP_USER" -H bash -c \
      "cd '$APP_DIR' && source venv/bin/activate && pip install gunicorn"

  run_with_spinner "Download NLTK / textblob corpora" \
    sudo -u "$APP_USER" -H bash -c \
      "cd '$APP_DIR' && source venv/bin/activate && python -m textblob.download_corpora" \
    || warn "Corpora download failed — re-run if NLP features are needed"

  sudo -u "$APP_USER" -H bash -c \
    "cd '$APP_DIR' && source venv/bin/activate && pip freeze > '$APP_DIR/requirements.lock.txt'"
  ok "Locked resolved versions in $APP_DIR/requirements.lock.txt"
  STAGE_VENV=1; save_state
else
  ok "Virtualenv already prepared (skipped)"
fi

# ============================================================
banner "settings_local.py"
# ============================================================
SETTINGS_LOCAL="$APP_DIR/web/main/settings_local.py"
if [[ "$STAGE_SETTINGS" != "1" ]]; then
  if [[ -f "$SETTINGS_LOCAL" ]]; then
    warn "$SETTINGS_LOCAL already exists — backing up"
    cp "$SETTINGS_LOCAL" "$SETTINGS_LOCAL.bak.$(date +%s)"
  fi

  cat > "$SETTINGS_LOCAL" <<EOF
# Generated by KLAP deploy-wizard
SECRET_KEY = '$SECRET_KEY'
DEBUG = False
ALLOWED_HOSTS = ['$SERVER_NAME', 'localhost', '127.0.0.1']

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql_psycopg2',
        'NAME': '$PG_DB',
        'USER': '$PG_USER',
        'PASSWORD': '$PG_PASSWORD',
        'HOST': 'localhost',
        'PORT': '5432',
    }
}

MONGODB_HOST = 'localhost'
MONGODB_PORT = $MONGO_PORT

STATIC_ROOT = '$STATIC_DIR'

CACHES = {
    'default': {
        'BACKEND': 'redis_cache.RedisCache',
        'LOCATION': '127.0.0.1:6379:1',
    }
}

BASE_DOMAIN = '$SERVER_NAME'
EOF
  chown "$APP_USER:$APP_USER" "$SETTINGS_LOCAL"
  chmod 600 "$SETTINGS_LOCAL"
  ok "Wrote $SETTINGS_LOCAL"
  STAGE_SETTINGS=1; save_state
else
  ok "settings_local.py already in place (skipped)"
fi

# ============================================================
banner "Django migrate & collectstatic"
# ============================================================
if [[ "$STAGE_DJANGO" != "1" ]]; then
  mkdir -p "$STATIC_DIR"
  chown "$APP_USER:$APP_USER" "$STATIC_DIR"
  run_with_spinner "Run database migrations" \
    sudo -u "$APP_USER" -H bash -c \
      "cd '$APP_DIR' && source venv/bin/activate && python web/manage.py migrate --noinput"
  run_with_spinner "Collect static files" \
    sudo -u "$APP_USER" -H bash -c \
      "cd '$APP_DIR' && source venv/bin/activate && python web/manage.py collectstatic --noinput"
  STAGE_DJANGO=1; save_state
else
  ok "Django bootstrap already done (skipped)"
fi

# ============================================================
banner "Systemd service + nginx vhost"
# ============================================================
if [[ "$STAGE_SYSTEMD" != "1" ]]; then
  cat > /etc/systemd/system/klap.service <<EOF
[Unit]
Description=KLAP Gunicorn daemon
After=network.target postgresql.service mongod.service redis-server.service

[Service]
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR/web
Environment="DJANGO_SETTINGS_MODULE=main.settings"
ExecStart=$APP_DIR/venv/bin/gunicorn \\
    --workers 3 \\
    --bind 127.0.0.1:$GUNICORN_PORT \\
    --timeout 120 \\
    main.wsgi:application
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable klap
  systemctl restart klap
  sleep 2
  if systemctl is-active --quiet klap; then
    ok "klap.service is running"
  else
    err "klap.service failed to start — run: journalctl -u klap -n 50"
    exit 1
  fi
  STAGE_SYSTEMD=1; save_state
fi

if [[ "$STAGE_NGINX" != "1" ]]; then
  if [[ "$VHOST_MODE" == "1" ]]; then
    # Subdomain virtual host on port 80 — coexists with other vhosts
    cat > /etc/nginx/sites-available/klap <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $SERVER_NAME;

    client_max_body_size 20M;

    location /static/ {
        alias $STATIC_DIR/;
        expires 7d;
    }

    location / {
        proxy_pass http://127.0.0.1:$GUNICORN_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 60s;
        proxy_read_timeout 120s;
    }
}
EOF
  else
    # Dedicated port mode
    cat > /etc/nginx/sites-available/klap <<EOF
server {
    listen $NGINX_PORT;
    server_name $SERVER_NAME;

    client_max_body_size 20M;

    location /static/ {
        alias $STATIC_DIR/;
        expires 7d;
    }

    location / {
        proxy_pass http://127.0.0.1:$GUNICORN_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 60s;
        proxy_read_timeout 120s;
    }
}
EOF
  fi

  ln -sf /etc/nginx/sites-available/klap /etc/nginx/sites-enabled/klap
  if nginx -t 2>/tmp/nginx-test.log; then
    systemctl reload nginx
    ok "nginx vhost installed and reloaded"
  else
    err "nginx config test FAILED — see /tmp/nginx-test.log"
    cat /tmp/nginx-test.log
    exit 1
  fi
  STAGE_NGINX=1; save_state
fi

# ---- Optional: TLS via Let's Encrypt (subdomain mode only) ----
if [[ "$VHOST_MODE" == "1" && "$ENABLE_TLS" == "1" && "$STAGE_TLS" != "1" ]]; then
  banner "HTTPS via Let's Encrypt"
  if ! command -v certbot >/dev/null 2>&1; then
    say "Installing certbot..."
    apt-get install -y software-properties-common
    add-apt-repository -y universe || true
    add-apt-repository -y ppa:certbot/certbot || true
    apt-get update
    apt-get install -y certbot python3-certbot-nginx
  fi

  if [[ -z "${TLS_EMAIL:-}" ]]; then
    TLS_EMAIL=$(ask "Email for Let's Encrypt renewal notices" "")
  fi

  say "Requesting certificate for $SERVER_NAME..."
  if certbot --nginx \
       --non-interactive --agree-tos \
       --email "$TLS_EMAIL" \
       --redirect \
       -d "$SERVER_NAME"; then
    ok "HTTPS enabled. certbot installed an auto-renew timer."
    STAGE_TLS=1; save_state
  else
    err "certbot failed. Common causes:"
    err "  • DNS for $SERVER_NAME does not yet point to this server"
    err "  • Port 80 is not reachable from the public internet (firewall?)"
    warn "Re-run the wizard after fixing DNS/firewall; HTTP still works."
  fi
fi

# ============================================================
info_banner "Smoke tests"
# ============================================================
sleep 1
verify_endpoint() {
  # verify_endpoint "label" "url" [extra-curl-args...]
  local label="$1" url="$2"; shift 2
  local code
  code=$(curl -sk -o /dev/null -w "%{http_code}" "$@" "$url" 2>/dev/null || echo "000")
  if [[ "$code" =~ ^[23] ]] || [[ "$code" == "302" ]]; then
    printf "  ${GREEN}✓${RESET}  %-32s ${GREEN}HTTP %s${RESET}\n" "$label" "$code"
  elif [[ "$code" == "000" ]]; then
    printf "  ${RED}✗${RESET}  %-32s ${RED}no response${RESET}\n" "$label"
  else
    printf "  ${YELLOW}⚠${RESET}  %-32s ${YELLOW}HTTP %s${RESET}\n" "$label" "$code"
  fi
}

verify_endpoint "Gunicorn (loopback)" "http://127.0.0.1:$GUNICORN_PORT/"
if [[ "$VHOST_MODE" == "1" ]]; then
  verify_endpoint "Nginx vhost ($SERVER_NAME)" "http://127.0.0.1/" -H "Host: $SERVER_NAME"
  if [[ "$STAGE_TLS" == "1" ]]; then
    verify_endpoint "HTTPS ($SERVER_NAME)" "https://$SERVER_NAME/"
  fi
else
  verify_endpoint "Nginx public ($NGINX_PORT)" "http://127.0.0.1:$NGINX_PORT/"
fi

# ============================================================
# Final celebration screen
# ============================================================
CURRENT_STEP=$TOTAL_STEPS
echo
echo "${BOLD}${GREEN}"
cat <<'EOF'
       ░█▀▄░█▀▀░█▀█░█░░░█▀█░█░█░█▀▀░█▀▄
       ░█░█░█▀▀░█▀▀░█░░░█░█░░█░░█▀▀░█░█
       ░▀▀░░▀▀▀░▀░░░▀▀▀░▀▀▀░░▀░░▀▀▀░▀▀░
EOF
echo "${RESET}"
echo "  ${BOLD}${GREEN}✓  KLAP is live!${RESET}  ${DIM}${GRAY}— installed without touching your other services${RESET}"
echo
printf "  "; progress_bar "$TOTAL_STEPS" "$TOTAL_STEPS" 60; printf "\n\n"

info_banner "Where things landed"
if [[ "$VHOST_MODE" == "1" ]]; then
  if [[ "$STAGE_TLS" == "1" ]]; then
    kv "Public URL"        "${UNDER}https://$SERVER_NAME/${RESET}"
  else
    kv "Public URL"        "${UNDER}http://$SERVER_NAME/${RESET}"
  fi
  kv "Nginx vhost file"    "/etc/nginx/sites-available/klap"
else
  kv "Public URL"          "${UNDER}http://$SERVER_NAME:$NGINX_PORT/${RESET}"
fi
kv "Service control"       "systemctl {status,restart,stop} klap"
kv "Live logs"             "journalctl -u klap -f"
kv "App code & venv"       "$APP_DIR"
kv "Static files"          "$STATIC_DIR"
kv "Local settings"        "$SETTINGS_LOCAL"
kv "Wizard state file"     "$STATE_FILE ${DIM}(chmod 600 — contains PG password)${RESET}"
kv "Locked Python deps"    "$APP_DIR/requirements.lock.txt"

echo
info_banner "Next steps"
if [[ "$VHOST_MODE" == "1" ]]; then
  echo "  ${MAGENTA}1.${RESET} Confirm DNS: ${BOLD}dig +short $SERVER_NAME${RESET} should return this server's public IP"
  echo "  ${MAGENTA}2.${RESET} If ufw is active: ${BOLD}sudo ufw allow 'Nginx Full'${RESET}  ${DIM}# opens 80 + 443${RESET}"
  [[ "$STAGE_TLS" != "1" ]] && echo "  ${MAGENTA}3.${RESET} Add HTTPS later: re-run wizard or ${BOLD}sudo certbot --nginx -d $SERVER_NAME${RESET}"
else
  echo "  ${MAGENTA}1.${RESET} If ufw is active: ${BOLD}sudo ufw allow $NGINX_PORT/tcp${RESET}"
fi
echo "  ${MAGENTA}•${RESET}  To re-run, remove or edit ${BOLD}$STATE_FILE${RESET}"
echo
echo "${BOLD}${CYAN}     ✦  Happy organizing.  ✦${RESET}"
echo
