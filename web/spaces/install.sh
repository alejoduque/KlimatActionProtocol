#!/usr/bin/env bash
#
# Prepares a server that deploy-wizard.sh set up before spaces existed. Run
# it once from the KLAP checkout, after git pull, migrate and collectstatic.
# Safe to run again.
#
#   sudo bash web/spaces/install.sh
#
# What it does:
#   1. Makes the directory of the shared files, for the owner of the checkout
#   2. Adds "location /_space_files/" to the KLAP nginx vhost (backup kept)
#   3. Adds SPACE_FILES_ACCEL to settings_local.py
#   4. Restarts klap.service

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$HERE/../.." && pwd)"
FILES="$APP_DIR/space_files"
LOCAL="$APP_DIR/web/main/settings_local.py"
VHOST="${VHOST:-/etc/nginx/sites-available/klap}"

say() { echo "  > $1"; }
die() { echo "  ! $1" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root: sudo bash $0"
[[ -f "$LOCAL" ]] || die "no $LOCAL"
[[ -f "$VHOST" ]] || die "no $VHOST: see docs/spaces.md to set up nginx yourself"

owner="$(stat -c %U "$APP_DIR")"
say "directory of the files: $FILES ($owner)"
install -d -o "$owner" -g "$owner" -m 755 "$FILES"

python3 "$HERE/nginx_files.py" "$FILES" "$VHOST" | sed 's/^/  > /' ||
  die "location /_space_files/ was not added to $VHOST (see above)"

if ! grep -q '^SPACE_FILES_ACCEL' "$LOCAL"; then
  say "add SPACE_FILES_ACCEL to settings_local.py"
  printf "\n# files of the spaces: nginx sends them after Django checks the secret link\nSPACE_FILES_ACCEL = '/_space_files/'\n" >> "$LOCAL"
fi

if systemctl list-unit-files klap.service >/dev/null 2>&1; then
  systemctl restart klap
fi

say "done. See docs/spaces.md, also for the TURN server that calls between networks need."
