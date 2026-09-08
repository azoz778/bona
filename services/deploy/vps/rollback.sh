#!/usr/bin/env bash
# Run ON THE PC. Undo cutover.sh: stop the VPS units, optionally copy bona.db back, start and
# re-enable the PC units, wait for the public health.
#   rollback.sh              bring the service back to this PC (PC data as it was at cutover)
#   rollback.sh --copy-back  also copy the VPS's newer bona-data files back first
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
need ssh; need scp; need curl; need systemctl
vps() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$BONA_VPS_SSH" "$@"; }

say "Stop the VPS copy"
vps "systemctl --user disable --now cloudflared-bona bona-api" || warn "could not reach the VPS — continuing; make sure nothing runs there"
ok "VPS units stopped and disabled"

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
