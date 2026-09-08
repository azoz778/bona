#!/usr/bin/env bash
# Provision THIS machine (the VPS, as the service user) to run bona-api. Idempotent; safe to re-run.
#
#   install-vps.sh                 install/upgrade node + cloudflared, clone/refresh /opt/bona (sparse),
#                                  create dirs, render units + ~/.cloudflared/bona.yml, daemon-reload.
#                                  Enables NOTHING and starts NOTHING — cutover.sh does that, on purpose:
#                                  a second running copy of the API or of the tunnel is the one thing
#                                  this move must never produce.
#   install-vps.sh --check         report what is still missing (exit 0 = ready, 2 = not yet); no changes.
#   install-vps.sh --render-only D render units + bona.yml into directory D only (tests use this).
#   install-vps.sh --smoke         start the API in the foreground for 15 s on a throw-away port and
#                                  data dir with the poller OFF, curl /health, stop. Proves node:sqlite,
#                                  secrets and the sparse checkout without touching real data.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"

MODE=install
RENDER_DIR=""
case "${1:-}" in
  "" | --install) ;;
  --check) MODE=check ;;
  --render-only) MODE=render; RENDER_DIR=${2:?usage: install-vps.sh --render-only DIR} ;;
  --smoke) MODE=smoke ;;
  *) die "usage: install-vps.sh [--check | --render-only DIR | --smoke]" ;;
esac

# ---------------------------------------------------------------- render (pure; used by every mode)
render_all() { # render_all DIR
  local dir=$1 u
  install -d -m 700 "$dir"
  for u in bona-api.service cloudflared-bona.service bona-repo-sync.service; do
    render "$TEMPLATE_DIR/$u.in" > "$dir/$u.tmp" && install -m 600 "$dir/$u.tmp" "$dir/$u" && rm -f "$dir/$u.tmp"
  done
  install -m 600 "$TEMPLATE_DIR/bona-repo-sync.timer" "$dir/bona-repo-sync.timer"
  render_tunnel_config > "$dir/bona.yml.tmp" && install -m 600 "$dir/bona.yml.tmp" "$dir/bona.yml" && rm -f "$dir/bona.yml.tmp"
}

if [ "$MODE" = render ]; then
  render_all "$RENDER_DIR"
  ok "rendered into $RENDER_DIR"
  exit 0
fi

# ---------------------------------------------------------------- check (read-only)
check_state() { # prints one line per item; returns the number of missing items
  local missing=0 f u
  # Every item line is the report itself, so MISSING goes to stdout like ok (warn alone would send it to stderr).
  item() { if "$@"; then ok "$_label"; else warn "MISSING: $_label" 2>&1; missing=$((missing + 1)); fi; }
  _label="node $NODE_VERSION at $NODE_BIN/node";            item test -x "$NODE_BIN/node"
  _label="node reports $NODE_VERSION";                       item bash -c "[ -x '$NODE_BIN/node' ] && [ \"\$('$NODE_BIN/node' -v)\" = '$NODE_VERSION' ]"
  _label="node:sqlite loads";                                item bash -c "[ -x '$NODE_BIN/node' ] && '$NODE_BIN/node' -e 'require(\"node:sqlite\")'"
  _label="cloudflared $CLOUDFLARED_VERSION at $CLOUDFLARED_BIN"; item bash -c "[ -x '$CLOUDFLARED_BIN' ] && '$CLOUDFLARED_BIN' --version 2>/dev/null | grep -q '$CLOUDFLARED_VERSION'"
  _label="repo checkout $BONA_VPS_REPO (services/api/index.mjs)"; item test -f "$BONA_VPS_REPO/services/api/index.mjs"
  _label="repo has src/data/listings.json";                  item test -f "$BONA_VPS_REPO/src/data/listings.json"
  _label="repo has src/data/site.json";                      item test -f "$BONA_VPS_REPO/src/data/site.json"
  _label="repo has services/api/retell/ids.json";            item test -f "$BONA_VPS_REPO/services/api/retell/ids.json"
  for f in $SECRET_FILES; do _label="secret file $SECRETS_DIR/$f (0600)"; item bash -c "[ -f '$SECRETS_DIR/$f' ] && [ \"\$(stat -c %a '$SECRETS_DIR/$f')\" = 600 ]"; done
  _label="tunnel credentials $CF_DIR/$BONA_TUNNEL_ID.json (0600)"; item bash -c "[ -f '$CF_DIR/$BONA_TUNNEL_ID.json' ] && [ \"\$(stat -c %a '$CF_DIR/$BONA_TUNNEL_ID.json')\" = 600 ]"
  _label="tunnel config $CF_DIR/bona.yml";                   item test -f "$CF_DIR/bona.yml"
  _label="data dir $DATA_DIR (0700)";                        item bash -c "[ -d '$DATA_DIR' ] && [ \"\$(stat -c %a '$DATA_DIR')\" = 700 ]"
  for u in $UNITS; do _label="unit $UNIT_DIR/$u"; item test -f "$UNIT_DIR/$u"; done
  _label="linger enabled for $(id -un)";                     item bash -c "command -v loginctl >/dev/null && loginctl show-user '$(id -un)' -p Linger 2>/dev/null | grep -q '=yes'"
  return "$missing"
}

if [ "$MODE" = check ]; then
  say "Checking $(hostname) for bona-api"
  if check_state; then ok "ready: nothing missing"; exit 0; fi
  warn "not ready — see MISSING lines above (copy secrets with sync-secrets.sh from the PC; the rest is install-vps.sh)"
  exit 2
fi

# ---------------------------------------------------------------- smoke
if [ "$MODE" = smoke ]; then
  need curl
  [ -x "$NODE_BIN/node" ] || die "run install-vps.sh first (node missing)"
  [ -f "$BONA_VPS_REPO/services/api/index.mjs" ] || die "run install-vps.sh first (repo missing)"
  tmp=$(mktemp -d) ; port=$((BONA_VPS_PORT + 1))
  say "Smoke: API on 127.0.0.1:$port, data in $tmp, poller OFF, 15 s"
  ( cd "$BONA_VPS_REPO/services" && BONA_API_PORT=$port BONA_DATA=$tmp BONA_REPO=$BONA_VPS_REPO BONA_WA_POLL=0 \
      EVOLUTION_API_URL=$BONA_VPS_EVOLUTION_URL NODE_ENV=production "$NODE_BIN/node" api/index.mjs ) &
  pid=$!
  if wait_for 15 1 curl -fsS "http://127.0.0.1:$port/health"; then
    curl -sS "http://127.0.0.1:$port/health"; echo
    ok "smoke passed"
    rc=0
  else
    warn "smoke FAILED: /health never answered"; rc=1
  fi
  kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
  rm -rf "$tmp"
  exit "$rc"
fi

# ---------------------------------------------------------------- install
need curl; need sha256sum; need tar; need git; need systemctl
say "Node $NODE_VERSION"
if [ -x "$NODE_BIN/node" ] && [ "$("$NODE_BIN/node" -v)" = "$NODE_VERSION" ]; then
  ok "already installed"
else
  tmp=$(mktemp -d)
  tarball="node-$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL --retry 3 -o "$tmp/$tarball" "https://nodejs.org/dist/$NODE_VERSION/$tarball"
  echo "$NODE_SHA256  $tmp/$tarball" | sha256sum -c - >/dev/null || die "node tarball checksum mismatch"
  install -d "$HOME_DIR/.local/opt"
  tar -xJf "$tmp/$tarball" -C "$HOME_DIR/.local/opt"
  rm -rf "$tmp"
  [ "$("$NODE_BIN/node" -v)" = "$NODE_VERSION" ] || die "node did not install correctly"
  ok "installed to $NODE_DIR"
fi
"$NODE_BIN/node" -e 'require("node:sqlite")' || die "node:sqlite is not available in $NODE_VERSION"

say "cloudflared $CLOUDFLARED_VERSION"
if [ -x "$CLOUDFLARED_BIN" ] && "$CLOUDFLARED_BIN" --version 2>/dev/null | grep -q "$CLOUDFLARED_VERSION"; then
  ok "already installed"
else
  tmp=$(mktemp -d)
  curl -fsSL --retry 3 -o "$tmp/cloudflared" "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-linux-amd64"
  echo "$CLOUDFLARED_SHA256  $tmp/cloudflared" | sha256sum -c - >/dev/null || die "cloudflared checksum mismatch"
  install -d "$HOME_DIR/.local/bin"
  install -m 755 "$tmp/cloudflared" "$CLOUDFLARED_BIN"
  rm -rf "$tmp"
  ok "installed to $CLOUDFLARED_BIN ($("$CLOUDFLARED_BIN" --version 2>/dev/null | head -1))"
fi

say "Repo checkout $BONA_VPS_REPO (sparse: services + src/data)"
if [ ! -d "$BONA_VPS_REPO/.git" ]; then
  if [ ! -d "$BONA_VPS_REPO" ]; then
    sudo -n install -d -o "$(id -un)" -g "$(id -gn)" -m 755 "$BONA_VPS_REPO" || die "cannot create $BONA_VPS_REPO (needs passwordless sudo once)"
  fi
  git clone --quiet --filter=blob:none --no-checkout "$BONA_REPO_URL" "$BONA_VPS_REPO"
  git -C "$BONA_VPS_REPO" sparse-checkout init --cone
  git -C "$BONA_VPS_REPO" sparse-checkout set services src/data
  git -C "$BONA_VPS_REPO" checkout --quiet main
  ok "cloned"
else
  git -C "$BONA_VPS_REPO" sparse-checkout set services src/data
  git -C "$BONA_VPS_REPO" pull --ff-only --quiet
  ok "refreshed ($(git -C "$BONA_VPS_REPO" rev-parse --short HEAD))"
fi
for f in services/api/index.mjs src/data/listings.json src/data/site.json services/api/retell/ids.json; do
  [ -f "$BONA_VPS_REPO/$f" ] || die "sparse checkout is missing $f"
done

say "Directories"
install -d -m 700 "$DATA_DIR" "$SECRETS_DIR" "$CF_DIR"
install -d -m 755 "$UNIT_DIR" "$HOME_DIR/.local/bin"
ok "$DATA_DIR $SECRETS_DIR $CF_DIR $UNIT_DIR"

say "Units and tunnel config"
tmp=$(mktemp -d)
render_all "$tmp"
for u in $UNITS; do install -m 644 "$tmp/$u" "$UNIT_DIR/$u"; done
install -m 600 "$tmp/bona.yml" "$CF_DIR/bona.yml"
rm -rf "$tmp"
systemctl --user daemon-reload
ok "installed $UNITS and $CF_DIR/bona.yml (nothing enabled, nothing started)"

say "Status"
if check_state; then ok "ready for cutover.sh (run it on the PC)"; else warn "still missing items above (secrets/credentials come from sync-secrets.sh on the PC)"; fi
