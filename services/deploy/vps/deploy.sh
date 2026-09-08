#!/usr/bin/env bash
# Run ON THE VPS (or: ssh hermes-vps bash /opt/bona/services/deploy/vps/deploy.sh).
# Pull main, run the API test suite with the pinned node, restart the unit, wait for /health.
# Tests failing = the running service is left untouched.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
need git; need systemctl; need curl
[ -x "$NODE_BIN/node" ] || die "node $NODE_VERSION missing — run install-vps.sh"

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
