#!/usr/bin/env bash
#
# ============================================================================
#  RUN THIS YOURSELF, IN YOUR OWN TERMINAL:
#
#      bash ~/bona/services/deploy/install.sh
#
#  It is NOT run by the agent. Creating a Cloudflare tunnel and routing DNS is
#  refused by the agent's permission classifier, so the owner has to type this
#  one command. Everything the script does is idempotent and safe to re-run:
#  existing tunnels, DNS routes, config files and units are detected and left
#  alone (or updated in place), never duplicated.
# ============================================================================
#
# What it does, in order:
#   1. checks node, cloudflared and the secrets file
#   2. creates the Cloudflare tunnel "bona" (skipped if it already exists)
#   3. writes ~/.cloudflared/bona.yml  — api.bona.azoz.uk -> http://localhost:4102
#   4. routes DNS api.bona.azoz.uk -> the tunnel (skipped if already routed)
#   5. installs and enables the systemd --user units bona-api + cloudflared-bona
#   6. health-checks http://localhost:4102/health and https://api.bona.azoz.uk/health
#
# Flags:
#   --no-dns      skip tunnel creation and DNS routing (units only)
#   --restart     restart both units even if they were already running
#   --uninstall   stop and disable both units (leaves the tunnel and DNS alone)
#
set -euo pipefail

REPO="${BONA_REPO_DIR:-$HOME/bona}"
SERVICES="$REPO/services"
DEPLOY="$SERVICES/deploy"
UNIT_DIR="$HOME/.config/systemd/user"
CF_DIR="$HOME/.cloudflared"
CF_CONFIG="$CF_DIR/bona.yml"
TUNNEL="bona"
HOSTNAME_API="${BONA_API_HOSTNAME:-api.bona.azoz.uk}"
PORT="${BONA_API_PORT:-4102}"
SECRETS="$HOME/.secrets/bona-services.env"
CLOUDFLARED="${CLOUDFLARED:-$(command -v cloudflared || echo "$HOME/.local/bin/cloudflared")}"

DO_DNS=1
DO_RESTART=0
DO_UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --no-dns) DO_DNS=0 ;;
    --restart) DO_RESTART=1 ;;
    --uninstall) DO_UNINSTALL=1 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# Scratch space for this run only: predictable /tmp names are a symlink race and are
# shared with every other run on the machine.
TMP="$(mktemp -d "${TMPDIR:-/tmp}/bona-install.XXXXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m  %s\n' "$*"; }
die()  { printf '\n\033[31mfailed:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- uninstall
if [ "$DO_UNINSTALL" = 1 ]; then
  say "Stopping and disabling the units"
  systemctl --user disable --now cloudflared-bona.service 2>/dev/null || true
  systemctl --user disable --now bona-api.service 2>/dev/null || true
  systemctl --user daemon-reload
  ok "units stopped. The tunnel \"$TUNNEL\" and its DNS record were left in place."
  exit 0
fi

# ---------------------------------------------------------------- 1. checks
say "Checking prerequisites"
[ -d "$SERVICES" ] || die "$SERVICES not found. Clone the repo to $REPO first (or set BONA_REPO_DIR)."
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "node not on PATH."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "node >= 22 required, found $(node -v)."
ok "node $(node -v) at $NODE_BIN"

if [ ! -f "$SECRETS" ]; then
  warn "$SECRETS is missing — creating it now"
  node "$SERVICES/api/retell/provision.mjs" --ensure-env
fi
grep -q '^BONA_TOOL_TOKEN=..' "$SECRETS" || die "BONA_TOOL_TOKEN is empty in $SECRETS."
ok "secrets present at $SECRETS (contents not shown)"

if [ ! -f "$SERVICES/api/retell/ids.json" ]; then
  warn "services/api/retell/ids.json not found — run 'node $SERVICES/api/retell/provision.mjs' before the concierge can answer."
else
  ok "Retell ids.json present"
fi

# The unit files hard-code the node path; keep them honest on this machine.
UNIT_NODE="$(grep -oP '(?<=^ExecStart=)\S+' "$DEPLOY/bona-api.service")"
UNIT_NODE="${UNIT_NODE/\%h/$HOME}"
if [ ! -x "$UNIT_NODE" ]; then
  warn "bona-api.service points at $UNIT_NODE which is not executable here; it will be rewritten to $NODE_BIN"
fi

# ---------------------------------------------------------------- 2. tunnel
if [ "$DO_DNS" = 1 ]; then
  say "Cloudflare tunnel \"$TUNNEL\""
  [ -x "$CLOUDFLARED" ] || die "cloudflared not found (looked at $CLOUDFLARED). Install it, or re-run with --no-dns."
  [ -f "$CF_DIR/cert.pem" ] || die "$CF_DIR/cert.pem missing — run '$CLOUDFLARED tunnel login' once."

  if "$CLOUDFLARED" tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$TUNNEL"; then
    ok "tunnel \"$TUNNEL\" already exists"
  else
    "$CLOUDFLARED" tunnel create "$TUNNEL"
    ok "tunnel \"$TUNNEL\" created"
  fi

  TUNNEL_ID="$("$CLOUDFLARED" tunnel list --output json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).find(x=>x.name===process.argv[1]);process.stdout.write(t?t.id:"")})' "$TUNNEL")"
  [ -n "$TUNNEL_ID" ] || die "could not resolve the id of tunnel \"$TUNNEL\"."
  CREDS="$CF_DIR/$TUNNEL_ID.json"
  [ -f "$CREDS" ] || die "credentials file $CREDS not found."
  ok "tunnel id $TUNNEL_ID"

  # ------------------------------------------------------------- 3. config
  say "Writing $CF_CONFIG"
  mkdir -p "$CF_DIR"
  NEW_CONFIG="$(cat <<YAML
# Managed by services/deploy/install.sh — re-running the script rewrites this file.
tunnel: $TUNNEL_ID
credentials-file: $CREDS

ingress:
  - hostname: $HOSTNAME_API
    service: http://localhost:$PORT
    originRequest:
      connectTimeout: 10s
      noTLSVerify: false
  - service: http_status:404
YAML
)"
  if [ -f "$CF_CONFIG" ] && [ "$(cat "$CF_CONFIG")" = "$NEW_CONFIG" ]; then
    ok "config unchanged"
  else
    printf '%s\n' "$NEW_CONFIG" > "$CF_CONFIG"
    ok "config written ($HOSTNAME_API -> http://localhost:$PORT, catch-all 404)"
  fi

  # ------------------------------------------------------------- 4. DNS
  say "Routing DNS $HOSTNAME_API"
  # --config: with a default ~/.cloudflared/config.yml present (another tunnel), cloudflared routed the
  # hostname to THAT tunnel id on 2026-09-06. Pin the config, and --overwrite-dns so a re-run repairs a
  # wrong record instead of failing on "record already exists".
  if "$CLOUDFLARED" --config "$CF_CONFIG" tunnel route dns --overwrite-dns "$TUNNEL" "$HOSTNAME_API" 2>&1 | tee "$TMP/dns.log"; then
    ok "DNS routed"
  elif grep -qiE 'already exists|record with that host' "$TMP/dns.log"; then
    ok "DNS record already points at this tunnel"
  else
    warn "DNS routing failed. Fix it in the Cloudflare dashboard (CNAME $HOSTNAME_API -> $TUNNEL_ID.cfargotunnel.com) and re-run; the output above is the whole story."
  fi

  # Verify what the public resolvers see: the CNAME must point at THIS tunnel, or the API is unreachable.
  EXPECT="$TUNNEL_ID.cfargotunnel.com"
  GOT="$(node -e 'const {Resolver}=require("dns").promises;const r=new Resolver();r.setServers(["1.1.1.1","8.8.8.8"]);r.resolveCname(process.argv[1]).then(a=>console.log(a[0]||"")).catch(()=>console.log(""))' "$HOSTNAME_API" 2>/dev/null || true)"
  if [ -n "$GOT" ] && [ "$GOT" != "$EXPECT" ]; then
    warn "DNS mismatch: $HOSTNAME_API -> $GOT (expected $EXPECT). Run: $CLOUDFLARED --config $CF_CONFIG tunnel route dns --overwrite-dns $TUNNEL $HOSTNAME_API"
  elif [ -n "$GOT" ]; then
    ok "DNS: $HOSTNAME_API -> $GOT"
  fi
else
  say "Skipping tunnel and DNS (--no-dns)"
fi

# ---------------------------------------------------------------- 5. units
say "Installing systemd --user units"
mkdir -p "$UNIT_DIR"
for unit in bona-api.service cloudflared-bona.service; do
  src="$DEPLOY/$unit"
  dst="$UNIT_DIR/$unit"
  [ -f "$src" ] || die "$src not found."
  # Point the unit at the node and cloudflared this machine actually has. The staging
  # file is created beside its destination (unpredictable name, same filesystem) so the
  # install is one atomic rename.
  tmp_unit="$(mktemp "$dst.XXXXXXXX")"
  sed -e "s#^ExecStart=%h/.nvm/versions/node/[^/]*/bin/node#ExecStart=$NODE_BIN#" \
      -e "s#^Environment=PATH=%h/.nvm/versions/node/[^/]*/bin:#Environment=PATH=$(dirname "$NODE_BIN"):#" \
      -e "s#^ExecStart=%h/.local/bin/cloudflared#ExecStart=$CLOUDFLARED#" \
      -e "s#%h/bona/services#$SERVICES#g" \
      "$src" > "$tmp_unit"
  if [ -f "$dst" ] && cmp -s "$dst" "$tmp_unit"; then
    rm -f "$tmp_unit"
    ok "$unit unchanged"
  else
    mv "$tmp_unit" "$dst"
    ok "$unit installed"
  fi
done
systemctl --user daemon-reload

# Keep the services alive when the owner is not logged in.
if command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger "$USER" >/dev/null 2>&1 || warn "could not enable linger; services stop when you log out"
fi

for unit in bona-api.service cloudflared-bona.service; do
  if [ "$unit" = cloudflared-bona.service ] && [ "$DO_DNS" = 0 ]; then
    warn "skipping $unit (--no-dns)"
    continue
  fi
  if systemctl --user is-active --quiet "$unit"; then
    if [ "$DO_RESTART" = 1 ]; then systemctl --user restart "$unit"; ok "$unit restarted"; else ok "$unit already running"; fi
    systemctl --user enable "$unit" >/dev/null 2>&1 || true
  else
    systemctl --user enable --now "$unit"
    ok "$unit started"
  fi
done

# ---------------------------------------------------------------- 6. health
say "Health check"
LOCAL_OK=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 3 "http://localhost:$PORT/health" >"$TMP/health.json" 2>/dev/null; then LOCAL_OK=1; break; fi
  sleep 1
done
if [ "$LOCAL_OK" = 1 ]; then
  ok "local  http://localhost:$PORT/health -> $(cat "$TMP/health.json")"
else
  warn "local health check failed. Logs: journalctl --user -u bona-api -n 50 --no-pager"
fi

if [ "$DO_DNS" = 1 ]; then
  PUBLIC_OK=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if curl -fsS --max-time 5 "https://$HOSTNAME_API/health" >"$TMP/health-public.json" 2>/dev/null; then PUBLIC_OK=1; break; fi
    sleep 5
  done
  if [ "$PUBLIC_OK" = 1 ]; then
    ok "public https://$HOSTNAME_API/health -> $(cat "$TMP/health-public.json")"
  else
    warn "public health check failed (DNS can take a couple of minutes). Logs: journalctl --user -u cloudflared-bona -n 50 --no-pager"
  fi
fi

say "Done"
cat <<TXT
    Status:   systemctl --user status bona-api cloudflared-bona
    Logs:     journalctl --user -u bona-api -f
    Restart:  systemctl --user restart bona-api
    Remove:   bash $DEPLOY/install.sh --uninstall

    If the concierge answers 503 "not_provisioned", run:
      node $SERVICES/api/retell/provision.mjs
    then restart:  systemctl --user restart bona-api
TXT
