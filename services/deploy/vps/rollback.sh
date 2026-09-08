#!/usr/bin/env bash
# Run ON THE PC. Undo cutover.sh: stop the VPS units and VERIFY they are inactive, optionally copy
# bona-data back, then start and re-enable the PC units and wait for the public health.
# Fail-closed: if the VPS cannot be reached or a unit will not stop, nothing is started here and
# nothing is copied (two APIs or two tunnel connectors must never run) — the manual commands are
# printed instead.
#   rollback.sh              bring the service back to this PC (PC data as it was at cutover)
#   rollback.sh --copy-back  also copy the VPS's newer bona-data files back first
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
need ssh; need scp; need curl; need systemctl
vps() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$BONA_VPS_SSH" "$@"; }

say "Stop the VPS copy"
if vps_units_stopped; then
  ok "VPS units stopped and disabled (verified inactive)"
else
  fail_closed
fi

if [ "${1:-}" = --copy-back ]; then
  say "Copy data back from the VPS"
  systemctl --user stop bona-api || true
  for f in $DATA_FILES; do
    vps "test -f ~/bona-data/$f" && scp -q -p "$BONA_VPS_SSH:bona-data/$f" "$DATA_DIR/$f" || true
  done
  chmod 600 "$DATA_DIR"/* 2>/dev/null || true
  ok "copied"
fi

say "Start the PC copy"
systemctl --user enable --now bona-api cloudflared-bona
public() { curl -fsS -m 10 "$BONA_PUBLIC_HEALTH" | grep -q '"retell":"ok"'; }
wait_for 45 2 public || die "public health did not come back on the PC — check: systemctl --user status bona-api cloudflared-bona"
ok "bona-api runs on this PC again"
