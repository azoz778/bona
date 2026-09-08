# services/deploy/vps/lib.sh — shared by every script in this directory. Sourced, never executed.
# Constants first (only BONA_VPS_REPO, BONA_VPS_SSH, BONA_HOSTNAMES, BONA_REPO_URL, BONA_VPS_EVOLUTION_URL, BONA_PUBLIC_HEALTH and BONA_TUNNEL_NAME may be overridden from the environment; the rest are pinned), then small helpers. Never echo a secret.

BONA_TUNNEL_ID=9022fbec-de4f-44b9-805e-8fff285d6263
BONA_TUNNEL_NAME=${BONA_TUNNEL_NAME:-bona}
# One entry per public hostname; all of them proxy to the same local port. Keep the legacy
# hostnames: brochure QR codes and indexed links point at them (memory 2026-09-08).
BONA_HOSTNAMES=${BONA_HOSTNAMES:-"api.bona-real-estate.com bona-api.azoz.uk bona.azoz.uk"}
# 4102 is taken on the VPS (obsidian-mcp)
BONA_VPS_PORT=4120
BONA_VPS_REPO=${BONA_VPS_REPO:-/opt/bona}
BONA_REPO_URL=${BONA_REPO_URL:-https://github.com/azoz778/bona}
BONA_VPS_EVOLUTION_URL=${BONA_VPS_EVOLUTION_URL:-http://127.0.0.1:8085}   # the same Evolution API as wa-api.azoz.uk, one hop shorter
BONA_VPS_SSH=${BONA_VPS_SSH:-hermes-vps}
BONA_PUBLIC_HEALTH=${BONA_PUBLIC_HEALTH:-https://api.bona-real-estate.com/health}
# Multiplied into every wait_for pause (integer). The tests set 0 so retries do not sleep.
BONA_WAIT_SCALE=${BONA_WAIT_SCALE:-1}

NODE_VERSION=v24.19.0
NODE_SHA256=14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647
CLOUDFLARED_VERSION=2026.8.3
CLOUDFLARED_SHA256=f29324fe934d1e100617484c78deef803c4dc2cd351d645bbde42e96b4fccc5e

SECRET_FILES="retell.env evolution-api.env bona-services.env bona-marketing.env"
DATA_FILES="bona.db bona.db-wal bona.db-shm leads.jsonl chats.jsonl calls.jsonl"
UNITS="bona-api.service cloudflared-bona.service bona-repo-sync.service bona-repo-sync.timer"
# Stop order on the VPS: the tunnel connector first (no more public traffic), then the API, then the timer.
VPS_UNITS="cloudflared-bona bona-api bona-repo-sync.timer"

HOME_DIR=${HOME:?HOME is not set}
NODE_DIR="$HOME_DIR/.local/opt/node-$NODE_VERSION-linux-x64"
NODE_BIN="$NODE_DIR/bin"
CLOUDFLARED_BIN="$HOME_DIR/.local/bin/cloudflared"
# For commands sent over ssh: the VPS home differs from the PC home, so let the REMOTE shell expand ~.
REMOTE_NODE='~/.local/opt/node-'"$NODE_VERSION"'-linux-x64/bin/node'
UNIT_DIR="$HOME_DIR/.config/systemd/user"
DATA_DIR="$HOME_DIR/bona-data"
SECRETS_DIR="$HOME_DIR/.secrets"
CF_DIR="$HOME_DIR/.cloudflared"
VPS_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TEMPLATE_DIR="$VPS_LIB_DIR/templates"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ok \033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mfail\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

# render TEMPLATE  → stdout, with every @PLACEHOLDER@ substituted; refuses to leave one behind.
render() {
  local out
  out=$(sed -e "s|@HOME@|$HOME_DIR|g" -e "s|@REPO@|$BONA_VPS_REPO|g" -e "s|@PORT@|$BONA_VPS_PORT|g" \
            -e "s|@NODE_BIN@|$NODE_BIN|g" -e "s|@TUNNEL_ID@|$BONA_TUNNEL_ID|g" \
            -e "s|@EVOLUTION_URL@|$BONA_VPS_EVOLUTION_URL|g" "$1")
  if printf '%s\n' "$out" | grep -q '@[A-Z_][A-Z_]*@'; then die "unrendered placeholder in $1"; fi
  printf '%s\n' "$out"
}

# render_tunnel_config → stdout: the cloudflared ingress for every hostname → the local API port.
render_tunnel_config() {
  local h
  echo "# Managed by services/deploy/vps/install-vps.sh — re-running rewrites this file."
  echo "tunnel: $BONA_TUNNEL_ID"
  echo "credentials-file: $CF_DIR/$BONA_TUNNEL_ID.json"
  echo
  echo "ingress:"
  for h in $BONA_HOSTNAMES; do
    printf '  - hostname: %s\n    service: http://127.0.0.1:%s\n    originRequest:\n      connectTimeout: 10s\n' "$h" "$BONA_VPS_PORT"
  done
  echo "  - service: http_status:404"
}

# wait_for TRIES SLEEP_SECONDS CMD... → runs CMD until it succeeds; returns 1 after TRIES attempts.
wait_for() {
  local tries=$1 pause=$2 i; shift 2
  for ((i = 1; i <= tries; i++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep "$((pause * BONA_WAIT_SCALE))"
  done
  return 1
}

# count_leads NODE_BINARY DB_FILE → prints the number of rows in `leads` (read-only; WAL-safe).
count_leads() {
  "$1" -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); console.log(db.prepare("select count(*) as n from leads").get().n)' "$2"
}

# vps_units_stopped → over ssh: disable + stop every VPS unit, then VERIFY the API and the tunnel
# connector are inactive. Returns non-zero when ssh fails or a unit is still active — and then the
# caller must NOT start the PC units (fail closed: two APIs or two connectors is the one thing the
# move must never produce). Needs the caller's `vps` ssh wrapper.
vps_units_stopped() {
  vps "systemctl --user disable --now $VPS_UNITS" || return 1
  vps "! systemctl --user is-active --quiet bona-api && ! systemctl --user is-active --quiet cloudflared-bona"
}

# fail_closed → the VPS units could not be verified inactive: say so loudly, print the manual
# commands in the order to run them, start NOTHING on the PC, exit 1.
fail_closed() {
  cat >&2 <<EOF

!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
!!  The VPS units could NOT be verified inactive (ssh failed, or a unit is still active).
!!  NOTHING was started on this PC: a second API or a second tunnel connector must never run.
!!  Finish the rollback by hand, in this order:
!!    1. ssh $BONA_VPS_SSH systemctl --user disable --now $VPS_UNITS
!!    2. ssh $BONA_VPS_SSH systemctl --user is-active bona-api cloudflared-bona   # both: inactive
!!    3. systemctl --user enable --now bona-api cloudflared-bona
!!    4. curl -fsS $BONA_PUBLIC_HEALTH
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

EOF
  exit 1
}
