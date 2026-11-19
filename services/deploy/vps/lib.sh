# services/deploy/vps/lib.sh — shared by every script in this directory. Sourced, never executed.
# Constants first (only BONA_VPS_REPO, BONA_VPS_DEPLOY_DIR, BONA_VPS_SSH, BONA_HOSTNAMES, BONA_REPO_URL, BONA_VPS_EVOLUTION_URL, BONA_PUBLIC_HEALTH, BONA_TUNNEL_NAME, BONA_WAIT_SCALE, GIT_BIN, VPS_USER and BONA_UNIT_DIR may be overridden from the environment; the rest are pinned), then small helpers. Never echo a secret.

BONA_TUNNEL_ID=9022fbec-de4f-44b9-805e-8fff285d6263
BONA_TUNNEL_NAME=${BONA_TUNNEL_NAME:-bona}
# One entry per public hostname; all of them proxy to the same local port. Keep the legacy
# hostnames: brochure QR codes and indexed links point at them (memory 2026-09-08).
BONA_HOSTNAMES=${BONA_HOSTNAMES:-"api.bona-real-estate.com bona-api.azoz.uk bona.azoz.uk"}
# 4102 is taken on the VPS (obsidian-mcp)
BONA_VPS_PORT=4120
BONA_VPS_REPO=${BONA_VPS_REPO:-/opt/bona}
# Where install-vps.sh lives on the VPS; /tmp/bona-vps before the branch is merged (cutover.sh's preflight).
BONA_VPS_DEPLOY_DIR=${BONA_VPS_DEPLOY_DIR:-$BONA_VPS_REPO/services/deploy/vps}
BONA_REPO_URL=${BONA_REPO_URL:-https://github.com/azoz778/bona}
BONA_VPS_EVOLUTION_URL=${BONA_VPS_EVOLUTION_URL:-http://127.0.0.1:8085}   # the same Evolution API as wa-api.azoz.uk, one hop shorter
BONA_VPS_SSH=${BONA_VPS_SSH:-hermes-vps}
BONA_PUBLIC_HEALTH=${BONA_PUBLIC_HEALTH:-https://api.bona-real-estate.com/health}
# Multiplied into every wait_for pause (integer). The tests set 0 so retries do not sleep.
BONA_WAIT_SCALE=${BONA_WAIT_SCALE:-1}

# The absolute git the rendered bona-repo-sync.service execs (a unit's ExecStart takes no PATH
# lookup). install-vps.sh --check verifies it exists; the tests point it at a shim.
GIT_BIN=${GIT_BIN:-/usr/bin/git}

# The VPS units are SYSTEM units (/etc/systemd/system) that run as the service user, NOT
# `systemctl --user` units: Ubuntu 24.04 sets kernel.apparmor_restrict_unprivileged_userns=1, and under
# it a user-manager unit cannot apply the sandbox directives (ProtectSystem, PrivateTmp, ProtectHostname,
# ProtectKernelModules, …) — the service dies with 218/CAPABILITIES. The first live cutover failed exactly
# there (2026-09-08) and rolled back; the same directives under User= in a system unit run fine.
# VPS_USER: the user the units run as = whoever runs install-vps.sh on the VPS (azoz), rendered into
# User=/Group=. BONA_UNIT_DIR: where the rendered units go; the tests point it at a temp dir. The PC side
# is untouched and stays `systemctl --user`.
VPS_USER=${VPS_USER:-$(id -un)}
BONA_UNIT_DIR=${BONA_UNIT_DIR:-/etc/systemd/system}
# How the VPS units are driven — on the VPS (deploy.sh, install-vps.sh) and inside the remote command
# strings cutover.sh / rollback.sh send over ssh. Passwordless sudo exists there; -n means "never prompt".
VPS_SYSTEMCTL="sudo -n systemctl"
VPS_JOURNALCTL="sudo -n journalctl"

NODE_VERSION=v24.19.0
NODE_SHA256=14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647
CLOUDFLARED_VERSION=2026.8.3
CLOUDFLARED_SHA256=f29324fe934d1e100617484c78deef803c4dc2cd351d645bbde42e96b4fccc5e

SECRET_FILES="retell.env evolution-api.env bona-services.env bona-marketing.env"
# bona-services.env is not copied verbatim (2026-11-19): the PC copy keeps the owner's personal
# WhatsApp instance for bona-intake, while the VPS reads Bona's own. For these keys the VPS's
# own line wins; a verbatim copy would silently undo the move (A2Z go-live item 7).
VPS_KEEP_FILE="bona-services.env"
VPS_KEEP_KEYS="BONA_WA_INSTANCE BONA_WA_INSTANCE_JID"
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

# The remote command that prints the VPS's own VPS_KEEP_KEYS lines of VPS_KEEP_FILE: nothing
# when the file is missing or has none, a non-zero status when grep itself fails.
vps_keep_grep() {
  local alt; alt=$(printf '%s' "$VPS_KEEP_KEYS" | tr ' ' '|')
  printf '%s' "f=~/.secrets/$VPS_KEEP_FILE; [ -e \"\$f\" ] || exit 0; grep -E '^[[:space:]]*(export[[:space:]]+)?($alt)=' \"\$f\"; [ \$? -le 1 ]"
}

# keep_vps_keys PC_FILE VPS_LINES OUT: OUT is PC_FILE, except that a VPS_KEEP_KEYS line the VPS
# has (VPS_LINES) stands in place of the PC's line for that key, or is appended when the PC has
# none; a kept key the VPS lacks keeps the PC's line. Prints nothing.
# (FILENAME == vpsfile, not NR == FNR: with an empty VPS_LINES the classic idiom would read the
# PC's lines as the VPS's.)
keep_vps_keys() {
  awk -v keys="$VPS_KEEP_KEYS" -v vpsfile="$2" '
    function key(line,  k) { k = line; sub(/^[ \t]*(export[ \t]+)?/, "", k); if (k !~ /=/) return ""; sub(/[ \t]*=.*/, "", k); return k }
    BEGIN { n = split(keys, list, " "); for (i = 1; i <= n; i++) want[list[i]] = 1 }
    FILENAME == vpsfile { k = key($0); if (k in want) vps[k] = $0; next }
    { k = key($0)
      if ((k in want) && (k in vps)) { if (!(k in done)) { print vps[k]; done[k] = 1 }; next }
      print }
    END { for (i = 1; i <= n; i++) { k = list[i]; if ((k in vps) && !(k in done)) print vps[k] } }
  ' "$2" "$1" > "$3"
}

# ---- The PC bona-api twin's WhatsApp drop-in (A2Z go-live item 7, 2026-11-19) -------------------
# The PC's bona-services.env keeps the owner's personal instance for bona-intake, so the twin that
# rollback.sh starts must load a later env file that names Bona's own instance and number
# (services/README.md, "The PC bona-api twin since the WhatsApp move"). A later EnvironmentFile=
# wins in systemd, and the process env wins over the files lib/env.mjs loads itself.
PC_WA_ENV="$SECRETS_DIR/bona-api-pc-wa.env"
PC_WA_DROPIN="$HOME_DIR/.config/systemd/user/bona-api.service.d/wa-own-number.conf"
PC_PERSONAL_INSTANCE=abdulaziz-personal   # lib/wa.mjs: the instance when BONA_WA_INSTANCE is unset

# env_value FILE KEY → prints KEY's value as lib/env.mjs parseEnvText reads it (the last KEY= line,
# `export ` stripped, one pair of quotes stripped); nothing when the file or the key is not there.
# For comparisons in this script only: never echo what it returns.
env_value() {
  [ -r "$1" ] || return 0
  awk -v k="$2" -v q="'" '
    { line = $0; sub(/\r$/, "", line); gsub(/^[ \t]+|[ \t]+$/, "", line)
      if (line == "" || substr(line, 1, 1) == "#") next
      if (substr(line, 1, 7) == "export ") { line = substr(line, 8); sub(/^[ \t]+/, "", line) }
      eq = index(line, "="); if (eq <= 1) next
      key = substr(line, 1, eq - 1); sub(/[ \t]+$/, "", key); if (key != k) next
      v = substr(line, eq + 1); gsub(/^[ \t]+|[ \t]+$/, "", v)
      f = substr(v, 1, 1); l = substr(v, length(v), 1)
      if (length(v) > 1 && f == l && (f == "\"" || f == q)) v = substr(v, 2, length(v) - 2)
      val = v; found = 1 }
    END { if (found) print val }' "$1"
}

# pc_wa_dropin_ok → 0 when the PC bona-api unit loads $PC_WA_ENV after bona-services.env and that
# file sets BONA_WA_INSTANCE (not the owner's personal instance) and BONA_WA_INSTANCE_JID, both
# non-empty. Otherwise 1, with the reason in PC_WA_WHY (paths only, never a value).
pc_wa_dropin_ok() {
  local files wa_at shared_at inst jid
  PC_WA_WHY=
  if ! files=$(systemctl --user show bona-api -p EnvironmentFiles --value 2>/dev/null); then
    PC_WA_WHY="systemctl --user show bona-api failed"; return 1
  fi
  files=$(printf '%s\n' "$files" | sed 's/ (ignore_errors=[a-z]*)$//')
  wa_at=$(printf '%s\n' "$files" | grep -nxF "$PC_WA_ENV" | tail -n 1 | cut -d: -f1 || true)
  if [ -z "$wa_at" ]; then PC_WA_WHY="the PC bona-api unit does not load $PC_WA_ENV (no drop-in)"; return 1; fi
  shared_at=$(printf '%s\n' "$files" | grep -nxF "$SECRETS_DIR/bona-services.env" | tail -n 1 | cut -d: -f1 || true)
  if [ -n "$shared_at" ] && [ "$wa_at" -lt "$shared_at" ]; then
    PC_WA_WHY="$PC_WA_ENV is loaded before $SECRETS_DIR/bona-services.env, so it does not win"; return 1
  fi
  if [ ! -f "$PC_WA_ENV" ]; then PC_WA_WHY="$PC_WA_ENV is missing"; return 1; fi
  inst=$(env_value "$PC_WA_ENV" BONA_WA_INSTANCE)
  jid=$(env_value "$PC_WA_ENV" BONA_WA_INSTANCE_JID)
  if [ -z "$inst" ] || [ -z "$jid" ]; then
    PC_WA_WHY="$PC_WA_ENV does not set both BONA_WA_INSTANCE and BONA_WA_INSTANCE_JID"; return 1
  fi
  if [ "$inst" = "$PC_PERSONAL_INSTANCE" ]; then
    PC_WA_WHY="$PC_WA_ENV names the owner's personal instance"; return 1
  fi
}

# pc_wa_dropin_help → stderr: how to give the twin its drop-in (as in services/README.md).
pc_wa_dropin_help() {
  cat >&2 <<HELP
The PC bona-api twin would poll and send from the owner's personal WhatsApp ($PC_PERSONAL_INSTANCE)
while the site sends clients to Bona's own number, which nothing on the PC would read (A2Z go-live
item 7). See services/README.md, "The PC bona-api twin since the WhatsApp move". Give it a drop-in:

  # $PC_WA_DROPIN
  [Service]
  EnvironmentFile=%h/.secrets/bona-api-pc-wa.env

  # $PC_WA_ENV (mode 0600)
  BONA_WA_INSTANCE=bona
  BONA_WA_INSTANCE_JID=966576267694@s.whatsapp.net

then \`systemctl --user daemon-reload\` and run rollback.sh again. Only when the VPS env and the
site are back on the personal number (runbook R1 + R2): rollback.sh --personal-instance
HELP
}

# render TEMPLATE  → stdout, with every @PLACEHOLDER@ substituted; refuses to leave one behind.
# Bash parameter substitution, not sed: a `|` or `&` in a value would break or corrupt a sed
# expression. The replacements are quoted because bash ≥ 5.2 (patsub_replacement) would otherwise
# expand an unquoted `&` to the matched placeholder.
render() {
  local out
  [ -f "$1" ] || die "template missing: $1"
  out=$(<"$1")
  out=${out//@HOME@/"$HOME_DIR"}
  out=${out//@USER@/"$VPS_USER"}
  out=${out//@REPO@/"$BONA_VPS_REPO"}
  out=${out//@PORT@/"$BONA_VPS_PORT"}
  out=${out//@NODE_BIN@/"$NODE_BIN"}
  out=${out//@TUNNEL_ID@/"$BONA_TUNNEL_ID"}
  out=${out//@EVOLUTION_URL@/"$BONA_VPS_EVOLUTION_URL"}
  out=${out//@GIT@/"$GIT_BIN"}
  if printf '%s\n' "$out" | grep '@[A-Z_][A-Z_]*@' >/dev/null; then die "unrendered placeholder in $1"; fi
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

# vps_count_leads → prints the number of rows in `leads` of ~/bona-data/bona.db ON THE VPS, using the
# pinned node there (read-only). Needs the caller's `vps` ssh wrapper. Used as the copy-integrity
# check in both directions: cutover.sh (PC → VPS) and rollback.sh --copy-back (VPS → PC).
vps_count_leads() {
  vps "$REMOTE_NODE -e 'const {DatabaseSync}=require(\"node:sqlite\");const db=new DatabaseSync(process.argv[1],{readOnly:true});console.log(db.prepare(\"select count(*) as n from leads\").get().n)' ~/bona-data/bona.db"
}

# vps_units_stopped → over ssh: disable + stop every VPS unit, then VERIFY the API and the tunnel
# connector are inactive. Returns non-zero when ssh fails or a unit is still active — and then the
# caller must NOT start the PC units (fail closed: two APIs or two connectors is the one thing the
# move must never produce). Needs the caller's `vps` ssh wrapper. The units are system units, so
# every systemctl in the remote string is $VPS_SYSTEMCTL (sudo -n systemctl).
vps_units_stopped() {
  vps "$VPS_SYSTEMCTL disable --now $VPS_UNITS" || return 1
  vps "! $VPS_SYSTEMCTL is-active --quiet bona-api && ! $VPS_SYSTEMCTL is-active --quiet cloudflared-bona"
}

# fail_closed → the VPS units could not be verified inactive: say so loudly, print the manual
# commands in the order to run them, start NOTHING on the PC, exit 1.
fail_closed() {
  cat >&2 <<EOF

!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
!!  The VPS units could NOT be verified inactive (ssh failed, or a unit is still active).
!!  NOTHING was started on this PC: a second API or a second tunnel connector must never run.
!!  Finish the rollback by hand, in this order:
!!    1. ssh $BONA_VPS_SSH $VPS_SYSTEMCTL disable --now $VPS_UNITS
!!    2. ssh $BONA_VPS_SSH $VPS_SYSTEMCTL is-active bona-api cloudflared-bona   # both: inactive
!!    3. systemctl --user enable --now bona-api cloudflared-bona                # PC: user units
!!    4. curl -fsS $BONA_PUBLIC_HEALTH
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

EOF
  exit 1
}
