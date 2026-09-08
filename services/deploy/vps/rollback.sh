#!/usr/bin/env bash
# Run ON THE PC. Undo cutover.sh: stop the VPS units and VERIFY they are inactive, optionally copy
# bona-data back, then start and re-enable the PC units and wait for the public health.
# Fail-closed: if the VPS cannot be reached or a unit will not stop, nothing is started here and
# nothing is copied (two APIs or two tunnel connectors must never run) — the manual commands are
# printed instead. The VPS units are system units (`sudo -n systemctl`, via vps_units_stopped in
# lib.sh); the PC units stay `systemctl --user`.
#   rollback.sh              bring the service back to this PC (PC data as it was at cutover)
#   rollback.sh --copy-back  also copy the VPS's newer bona-data files back first. All or nothing:
#                            the files land in a temp dir under ~/bona-data, bona.db must arrive and
#                            its lead count must match the VPS's, and only then do they replace the
#                            PC's files and the PC units start. Any failure leaves the PC data as it
#                            was, removes the temp dir and starts nothing (Codex review 2026-09-08:
#                            a swallowed scp error must not start the service on stale data).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
need ssh; need scp; need curl; need systemctl
vps() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$BONA_VPS_SSH" "$@"; }

COPY_BACK=0
case "${1:-}" in
  "") ;;
  --copy-back) COPY_BACK=1 ;;
  *) die "usage: rollback.sh [--copy-back]" ;;
esac

# Everything --copy-back needs on the PC is checked before anything is stopped anywhere.
if [ "$COPY_BACK" = 1 ]; then
  PC_NODE=${PC_NODE:-$(command -v node || true)}
  [ -x "$PC_NODE" ] || die "node not found on the PC (set PC_NODE)"
  "$PC_NODE" -e 'require("node:sqlite")' >/dev/null 2>&1 || die "PC node lacks node:sqlite (set PC_NODE)"
  [ -d "$DATA_DIR" ] || die "no $DATA_DIR on this PC"
fi

say "Stop the VPS copy"
if vps_units_stopped; then
  ok "VPS units stopped and disabled (verified inactive)"
else
  fail_closed
fi

if [ "$COPY_BACK" = 1 ]; then
  say "Copy data back from the VPS"
  # The PC API must not hold the database open while its files are replaced.
  if systemctl --user is-active --quiet bona-api; then systemctl --user stop bona-api; fi
  tmp=$(mktemp -d "$DATA_DIR/.copy-back.XXXXXX")
  # Whatever happens from here on, the staging dir goes; the PC's own files are touched only by the mv below.
  trap 'rm -rf "$tmp"' EXIT
  # bona.db is not optional: fetched outright, and a failed or empty-handed copy stops the rollback.
  scp -q -p "$BONA_VPS_SSH:bona-data/bona.db" "$tmp/" || die "could not copy bona.db from the VPS — PC data left as it was, nothing started"
  [ -f "$tmp/bona.db" ] || die "bona.db did not arrive from the VPS — PC data left as it was, nothing started"
  copied="bona.db"; absent=""
  for f in $DATA_FILES; do
    [ "$f" = bona.db ] && continue
    if vps "test -f ~/bona-data/$f"; then
      scp -q -p "$BONA_VPS_SSH:bona-data/$f" "$tmp/" || die "could not copy $f from the VPS — PC data left as it was, nothing started"
      [ -f "$tmp/$f" ] || die "$f did not arrive from the VPS — PC data left as it was, nothing started"
      copied="$copied $f"
    else
      echo "absent on the VPS: $f"; absent="$absent $f"
    fi
  done
  # Copy-integrity check: the staged bona.db must hold what the VPS's does.
  vps_leads=$(vps_count_leads)
  pc_leads=$(count_leads "$PC_NODE" "$tmp/bona.db")
  [ "$vps_leads" = "$pc_leads" ] || die "lead count mismatch: VPS $vps_leads vs copied $pc_leads — PC data left as it was, nothing started"
  # Only now do the staged files replace the PC's.
  for f in $copied; do mv -f "$tmp/$f" "$DATA_DIR/$f"; chmod 600 "$DATA_DIR/$f"; done
  # A WAL/SHM pair the VPS no longer has belongs to the PC's OLD database: SQLite would replay those
  # frames over the fresh bona.db. The VPS's file is self-contained, so they carry nothing to keep.
  for f in $absent; do
    case "$f" in bona.db-wal | bona.db-shm) [ -f "$DATA_DIR/$f" ] && { rm -f "$DATA_DIR/$f"; echo "removed stale $f (the VPS database has no WAL)"; } ;; esac
  done
  rm -rf "$tmp"; trap - EXIT
  ok "copied: $copied ($pc_leads leads)"
fi

say "Start the PC copy"
systemctl --user enable --now bona-api cloudflared-bona
public() { curl -fsS -m 10 "$BONA_PUBLIC_HEALTH" | grep -q '"retell":"ok"'; }
wait_for 45 2 public || die "public health did not come back on the PC — check: systemctl --user status bona-api cloudflared-bona"
ok "bona-api runs on this PC again"
