#!/usr/bin/env bash
# Run ON THE VPS (or: ssh hermes-vps bash /opt/bona/services/deploy/vps/deploy.sh).
# Pause the repo-sync timer, pull main, run the API test suite with the pinned node, restart the
# unit, wait for /health; on exit — whatever happened in between — the timer starts again IF it was
# active when this script began (a timer the owner had paused stays paused).
# Tests failing = the running service is left untouched.
# The units are SYSTEM units (lib.sh: BONA_UNIT_DIR, the userns restriction on Ubuntu 24.04), so
# every systemctl/journalctl here goes through $VPS_SYSTEMCTL / $VPS_JOURNALCTL (sudo -n …).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
need git; need systemctl; need curl; need sudo
[ -x "$NODE_BIN/node" ] || die "node $NODE_VERSION missing — run install-vps.sh"

say "Pause bona-repo-sync.timer"
# The timer's own `git pull` must not collide with this one (or run mid-test): stop the timer AND
# its service (a pull already in flight) now, and start the timer again on exit — the EXIT trap
# also runs after a `die` — but only if it was active to begin with: deploy.sh must not switch on
# a timer the owner paused, nor one the cutover has not enabled yet.
TIMER_WAS_ACTIVE=0
if $VPS_SYSTEMCTL is-active --quiet bona-repo-sync.timer; then TIMER_WAS_ACTIVE=1; fi
resume_timer() {
  [ "$TIMER_WAS_ACTIVE" = 1 ] || return 0
  $VPS_SYSTEMCTL start bona-repo-sync.timer || warn "bona-repo-sync.timer did not start again — run: $VPS_SYSTEMCTL start bona-repo-sync.timer"
}
trap resume_timer EXIT   # armed before the stop: a half-failed stop still hands the timer back
$VPS_SYSTEMCTL stop bona-repo-sync.timer bona-repo-sync.service
if [ "$TIMER_WAS_ACTIVE" = 1 ]; then ok "paused until this script exits"; else ok "was not active; it stays off"; fi

say "Pull"
before=$(git -C "$BONA_VPS_REPO" rev-parse --short HEAD)
git -C "$BONA_VPS_REPO" pull --ff-only --quiet
after=$(git -C "$BONA_VPS_REPO" rev-parse --short HEAD)
ok "$before -> $after"

say "Tests"
( cd "$BONA_VPS_REPO/services" && "$NODE_BIN/node" --test api/test/*.test.mjs ) || die "tests failed — service NOT restarted (still on $before)"
ok "tests green"

say "Restart bona-api"
$VPS_SYSTEMCTL restart bona-api.service
health() { curl -fsS "http://127.0.0.1:$BONA_VPS_PORT/health" | grep -q '"ok":true'; }
wait_for 30 1 health || { $VPS_JOURNALCTL -u bona-api -n 30 --no-pager || true; die "bona-api did not become healthy"; }
curl -sS "http://127.0.0.1:$BONA_VPS_PORT/health"; echo
ok "deployed $after"
