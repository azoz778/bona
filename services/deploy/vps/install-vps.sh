#!/usr/bin/env bash
# Provision THIS machine (the VPS, as the service user) to run bona-api. Idempotent; safe to re-run.
#
#   install-vps.sh                 install/upgrade node + cloudflared, clone/refresh /opt/bona (sparse),
#                                  create dirs, retire the user units of the first attempt, render the
#                                  SYSTEM units into /etc/systemd/system (sudo -n) + ~/.cloudflared/bona.yml,
#                                  daemon-reload. Enables NOTHING and starts NOTHING — cutover.sh does
#                                  that, on purpose: a second running copy of the API or of the tunnel
#                                  is the one thing this move must never produce.
#                                  System units, not `systemctl --user`: see lib.sh (BONA_UNIT_DIR) and
#                                  templates/bona-api.service.in — Ubuntu 24.04's userns restriction
#                                  kills the sandboxed user unit with 218/CAPABILITIES.
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

# The units render User=/Group=/HOME= from the invoking user: running this as root would bake root in.
[ "$(id -u)" != 0 ] || die "run install-vps.sh as the service user (azoz), not as root"
# Attempt 1 (2026-09-08) installed the units under this user's own manager; they must be gone before
# a system unit of the same name runs, or two copies could exist side by side.
LEGACY_USER_UNIT_DIR="$HOME_DIR/.config/systemd/user"

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
# PIDs of API / tunnel processes for the service user that are NOT the system units' own main
# processes — i.e. leftovers from the attempt-1 user units or a stray hand-started copy. After the
# cutover the live units match the same command lines, so their MainPIDs are excluded (Codex, 2026-09-08).
legacy_procs() {
  local live pid args=()
  live=$(sudo -n systemctl show -p MainPID --value bona-api cloudflared-bona 2>/dev/null | tr '\n' ' ')
  for pid in $live; do [ "$pid" != 0 ] && args+=(-e "$pid"); done
  { pgrep -u "$VPS_USER" -f "^[^ ]*/node $BONA_VPS_REPO/services/api/index[.]mjs"
    pgrep -u "$VPS_USER" -f "^[^ ]*/cloudflared .*tunnel run $BONA_TUNNEL_ID"; } 2>/dev/null | grep -vxF -e __none__ "${args[@]}" || true
}
# Runs in THIS shell: a `bash -c` child would not see VPS_USER/BONA_VPS_REPO/BONA_TUNNEL_ID and would
# probe for nothing (Codex, final pass 2026-09-08).
no_legacy_procs() { [ -z "$(legacy_procs)" ]; }

check_state() { # prints one line per item; returns the number of missing items
  local missing=0 f u
  # Every item line is the report itself: ok lines and plain "MISSING: <item>" lines both go to stdout
  # (machine-readable, no colour prefix), only the final summary uses warn/ok.
  item() { if "$@"; then ok "$_label"; else printf 'MISSING: %s\n' "$_label"; missing=$((missing + 1)); fi; }
  _label="node $NODE_VERSION at $NODE_BIN/node";            item test -x "$NODE_BIN/node"
  _label="node reports $NODE_VERSION";                       item bash -c "[ -x '$NODE_BIN/node' ] && [ \"\$('$NODE_BIN/node' -v)\" = '$NODE_VERSION' ]"
  _label="node:sqlite loads";                                item bash -c "[ -x '$NODE_BIN/node' ] && '$NODE_BIN/node' -e 'require(\"node:sqlite\")'"
  _label="cloudflared $CLOUDFLARED_VERSION at $CLOUDFLARED_BIN"; item bash -c "[ -x '$CLOUDFLARED_BIN' ] && '$CLOUDFLARED_BIN' --version 2>/dev/null | grep -q '$CLOUDFLARED_VERSION'"
  _label="git at $GIT_BIN (bona-repo-sync.service execs that path)"; item test -x "$GIT_BIN"
  _label="repo checkout $BONA_VPS_REPO (services/api/index.mjs)"; item test -f "$BONA_VPS_REPO/services/api/index.mjs"
  _label="repo has src/data/listings.json";                  item test -f "$BONA_VPS_REPO/src/data/listings.json"
  _label="repo has src/data/site.json";                      item test -f "$BONA_VPS_REPO/src/data/site.json"
  _label="repo has services/api/retell/ids.json";            item test -f "$BONA_VPS_REPO/services/api/retell/ids.json"
  for f in $SECRET_FILES; do _label="secret file $SECRETS_DIR/$f (0600)"; item bash -c "[ -f '$SECRETS_DIR/$f' ] && [ \"\$(stat -c %a '$SECRETS_DIR/$f')\" = 600 ]"; done
  _label="tunnel credentials $CF_DIR/$BONA_TUNNEL_ID.json (0600)"; item bash -c "[ -f '$CF_DIR/$BONA_TUNNEL_ID.json' ] && [ \"\$(stat -c %a '$CF_DIR/$BONA_TUNNEL_ID.json')\" = 600 ]"
  _label="tunnel config $CF_DIR/bona.yml";                   item test -f "$CF_DIR/bona.yml"
  _label="data dir $DATA_DIR (0700)";                        item bash -c "[ -d '$DATA_DIR' ] && [ \"\$(stat -c %a '$DATA_DIR')\" = 700 ]"
  for u in $UNITS; do _label="unit $BONA_UNIT_DIR/$u"; item test -f "$BONA_UNIT_DIR/$u"; done
  # System units are installed and driven with `sudo -n`; the VPS has passwordless sudo, and -n
  # means a missing rule fails here instead of prompting inside cutover.sh's ssh.
  _label="passwordless sudo for systemctl (sudo -n systemctl --version)"; item bash -c "command -v sudo >/dev/null && sudo -n systemctl --version >/dev/null 2>&1"
  _label="no legacy user unit files in $LEGACY_USER_UNIT_DIR";   item bash -c "! ls '$LEGACY_USER_UNIT_DIR'/bona-api.service '$LEGACY_USER_UNIT_DIR'/cloudflared-bona.service '$LEGACY_USER_UNIT_DIR'/bona-repo-sync.service '$LEGACY_USER_UNIT_DIR'/bona-repo-sync.timer >/dev/null 2>&1"
  _label="no legacy bona-api / tunnel processes for $VPS_USER";  item no_legacy_procs
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
  port=$((BONA_VPS_PORT + 1))
  if ss -ltn 2>/dev/null | grep -q ":$port "; then die "port $port is already listening — refusing the smoke run (an earlier smoke still up?)"; fi
  tmp=$(mktemp -d)
  say "Smoke: API on 127.0.0.1:$port, data in $tmp, poller OFF, 15 s"
  # exec: $pid is then node itself, not a subshell around it, so the kill below stops the API.
  ( cd "$BONA_VPS_REPO/services" && BONA_API_PORT=$port BONA_DATA=$tmp BONA_REPO=$BONA_VPS_REPO BONA_WA_POLL=0 \
      EVOLUTION_API_URL=$BONA_VPS_EVOLUTION_URL NODE_ENV=production exec "$NODE_BIN/node" api/index.mjs ) &
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
need curl; need sha256sum; need tar; need git; need systemctl; need sudo
# Before anything is downloaded or probed: the pinned node tarball and cloudflared binary are x86_64 builds.
[ "$(uname -m)" = x86_64 ] || die "install-vps.sh supports x86_64 only (pinned node linux-x64 + cloudflared amd64); this machine is $(uname -m)"
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
install -d -m 755 "$HOME_DIR/.local/bin"
ok "$DATA_DIR $SECRETS_DIR $CF_DIR"

say "Retire user units from the first attempt"
# The first live cutover (2026-09-08) installed these as `systemctl --user` units; they died with
# 218/CAPABILITIES (templates/bona-api.service.in says why). A leftover copy would sit next to the
# system unit of the same name, so: disable + stop whatever may still be flapping, delete the file,
# reload the user manager. Idempotent — nothing to do once they are gone. This is the ONLY
# `systemctl --user` this installer runs, and it never enables or starts anything.
retired=0
for u in $UNITS; do
  if [ -f "$LEGACY_USER_UNIT_DIR/$u" ]; then
    systemctl --user disable --now "$u" 2>/dev/null || true
    # Never delete the file while the unit is still running: it would live on as a fileless unit that
    # nothing here can see (review, 2026-09-08). An unreachable user manager answers "inactive".
    if systemctl --user is-active --quiet "$u" 2>/dev/null; then die "user unit $u is still active after disable --now — stop it from a login shell, then re-run"; fi
    rm -f "$LEGACY_USER_UNIT_DIR/$u"
    retired=$((retired + 1))
  fi
done
if [ "$retired" -gt 0 ]; then
  systemctl --user daemon-reload 2>/dev/null || true
  ok "removed $retired user unit file(s) from $LEGACY_USER_UNIT_DIR"
else
  ok "none left in $LEGACY_USER_UNIT_DIR"
fi

say "Units and tunnel config"
tmp=$(mktemp -d)
render_all "$tmp"
# System units land in $BONA_UNIT_DIR (/etc/systemd/system) through `sudo -n install` — root-owned,
# 0644 — and the system manager reloads through $VPS_SYSTEMCTL. A directory the current user can
# write (the tests' temp dir) takes a plain install and a plain daemon-reload instead.
if [ -w "$BONA_UNIT_DIR" ]; then
  for u in $UNITS; do install -m 644 "$tmp/$u" "$BONA_UNIT_DIR/$u"; done
  systemctl daemon-reload
else
  for u in $UNITS; do sudo -n install -m 644 "$tmp/$u" "$BONA_UNIT_DIR/$u" || die "cannot install $u into $BONA_UNIT_DIR (needs passwordless sudo)"; done
  $VPS_SYSTEMCTL daemon-reload || die "daemon-reload failed (needs passwordless sudo)"
fi
install -m 600 "$tmp/bona.yml" "$CF_DIR/bona.yml"
rm -rf "$tmp"
ok "installed $UNITS into $BONA_UNIT_DIR (User=$VPS_USER) and $CF_DIR/bona.yml (nothing enabled, nothing started)"

say "Status"
if check_state; then ok "ready for cutover.sh (run it on the PC)"; else warn "still missing items above (secrets/credentials come from sync-secrets.sh on the PC)"; fi
