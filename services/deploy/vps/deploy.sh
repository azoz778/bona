#!/usr/bin/env bash
# Run ON THE VPS (or: ssh hermes-vps bash /opt/bona/services/deploy/vps/deploy.sh).
# Pause the repo-sync timer, pull main, run the API test suite with the pinned node, restart the
# unit, wait for /health; the timer starts again on exit whatever happened in between.
# Tests failing = the running service is left untouched.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
need git; need systemctl; need curl
[ -x "$NODE_BIN/node" ] || die "node $NODE_VERSION missing — run install-vps.sh"

say "Pause bona-repo-sync.timer"
# The timer's own `git pull` must not collide with this one (or run mid-test): stop it now and
# start it again on exit — the EXIT trap also runs after a `die`.
systemctl --user stop bona-repo-sync.timer
trap 'systemctl --user start bona-repo-sync.timer || warn "bona-repo-sync.timer did not start again — run: systemctl --user start bona-repo-sync.timer"' EXIT
ok "paused until this script exits"

say "Pull"
before=$(git -C "$BONA_VPS_REPO" rev-parse --short HEAD)
git -C "$BONA_VPS_REPO" pull --ff-only --quiet
after=$(git -C "$BONA_VPS_REPO" rev-parse --short HEAD)
ok "$before -> $after"

say "Tests"
( cd "$BONA_VPS_REPO/services" && "$NODE_BIN/node" --test api/test/*.test.mjs ) || die "tests failed — service NOT restarted (still on $before)"
ok "tests green"

say "Restart bona-api"
systemctl --user restart bona-api.service
health() { curl -fsS "http://127.0.0.1:$BONA_VPS_PORT/health" | grep -q '"ok":true'; }
wait_for 30 1 health || { journalctl --user -u bona-api -n 30 --no-pager; die "bona-api did not become healthy"; }
curl -sS "http://127.0.0.1:$BONA_VPS_PORT/health"; echo
ok "deployed $after"
