#!/usr/bin/env bash
# Run ON THE PC. Moves the live bona-api from this machine to the VPS in five steps, and rolls
# back by itself if any step fails:
#   1. stop cloudflared-bona + bona-api here (one API, one tunnel connector — never two)
#   2. copy ~/bona-data/{bona.db,…jsonl} to the VPS (PC service is stopped, so the copy is consistent)
#      and compare lead counts before anything on the VPS opens the database (copy integrity)
#   3. start bona-api on the VPS, wait for 127.0.0.1:4120/health, then enable the repo-sync timer
#      (new listings reach the inventory hot-reload)
#   4. start cloudflared-bona on the VPS, wait for the public /health
#   5. disable the two units here (files stay for rollback.sh)
# The automatic rollback is fail-closed: the PC units come back ONLY after the VPS units are
# verified inactive; if the VPS cannot be reached or refuses to stop, nothing starts here and the
# manual commands are printed (two APIs or two tunnel connectors must never run).
#   cutover.sh --dry-run   print the plan, touch nothing, call nothing.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"

DRY=0; [ "${1:-}" = --dry-run ] && DRY=1
PC_NODE=${PC_NODE:-$(command -v node || true)}

if [ "$DRY" = 1 ]; then
  say "Dry run — the cutover would:"
  echo "  1. stop cloudflared-bona and bona-api on this PC (systemctl --user)"
  echo "  2. copy $DATA_DIR/{$(echo $DATA_FILES | tr ' ' ',')} to $BONA_VPS_SSH:bona-data/ (whichever exist), compare lead counts"
  echo "  3. start bona-api on the VPS and wait for http://127.0.0.1:$BONA_VPS_PORT/health, enable bona-repo-sync.timer"
  echo "  4. start cloudflared-bona on the VPS and wait for $BONA_PUBLIC_HEALTH"
  echo "  5. disable bona-api and cloudflared-bona on this PC (rollback.sh re-enables them)"
  ok "nothing done"
  exit 0
fi

need ssh; need scp; need curl; need systemctl
[ -x "$PC_NODE" ] || die "node not found on the PC (set PC_NODE)"
"$PC_NODE" -e 'require("node:sqlite")' >/dev/null 2>&1 || die "PC node lacks node:sqlite (set PC_NODE)"
vps() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$BONA_VPS_SSH" "$@"; }

say "Preflight"
vps true || die "cannot ssh to $BONA_VPS_SSH"
vps "bash $BONA_VPS_DEPLOY_DIR/install-vps.sh --check" || die "VPS is not ready (install-vps.sh --check failed)"
for u in bona-api cloudflared-bona; do
  if vps "systemctl --user is-active --quiet $u"; then die "$u is ALREADY running on the VPS — refusing to start a second copy"; fi
done
ok "VPS ready, nothing running there yet"

FINISHED=0
VPS_STARTED=0   # 1 once anything was enabled on the VPS; rollback() must then stop it first
# Fail-closed rollback: the PC units are started again ONLY after the VPS units are verified
# inactive. If the VPS cannot be reached or a unit will not stop, nothing starts here (a second
# API or connector is worse than an outage) and the manual commands are printed instead.
rollback() {
  [ "$FINISHED" = 1 ] && return 0
  warn "cutover did not finish — rolling back to the PC"
  if [ "$VPS_STARTED" = 1 ]; then
    if vps_units_stopped; then ok "VPS units stopped and disabled (verified inactive)"; else fail_closed; fi
  else
    ok "nothing was started on the VPS"
  fi
  systemctl --user enable --now bona-api cloudflared-bona || warn "could not start the PC units — run: systemctl --user enable --now bona-api cloudflared-bona"
  warn "PC units started again; check: systemctl --user status bona-api cloudflared-bona"
}
# EXIT (not ERR): `die` exits, and an ERR trap would not fire for it. Armed only after the
# preflight, so a refused preflight never stops a VPS copy that is legitimately live.
trap rollback EXIT

say "1/5 Stop the PC copy"
systemctl --user stop cloudflared-bona bona-api
wait_for 30 1 bash -c '! systemctl --user is-active --quiet bona-api && ! systemctl --user is-active --quiet cloudflared-bona' || die "PC units did not stop"
ok "stopped"

say "2/5 Copy data"
pc_leads=$(count_leads "$PC_NODE" "$DATA_DIR/bona.db")
files=()
for f in $DATA_FILES; do [ -f "$DATA_DIR/$f" ] && files+=("$DATA_DIR/$f"); done
[ "${#files[@]}" -gt 0 ] || die "no data files in $DATA_DIR"
vps "install -d -m 700 ~/bona-data"
scp -q -p "${files[@]}" "$BONA_VPS_SSH:bona-data/"
vps "chmod 600 ~/bona-data/*"
# Copy-integrity check, taken before the VPS API (and its poller) can open the database.
vps_leads=$(vps_count_leads)
[ "$vps_leads" = "$pc_leads" ] || die "lead count mismatch: PC $pc_leads vs VPS $vps_leads"
ok "copied ${#files[@]} files, $vps_leads leads carried over"

say "3/5 Start bona-api on the VPS"
VPS_STARTED=1
vps "systemctl --user enable --now bona-api"
wait_for 30 1 vps "curl -fsS http://127.0.0.1:$BONA_VPS_PORT/health | grep -q '\"ok\":true'" || { vps "journalctl --user -u bona-api -n 30 --no-pager" || true; die "VPS bona-api is not healthy"; }
vps "systemctl --user enable --now bona-repo-sync.timer"
ok "healthy; bona-repo-sync.timer enabled"

say "4/5 Start the tunnel connector on the VPS"
vps "systemctl --user enable --now cloudflared-bona"
public() { curl -fsS -m 10 "$BONA_PUBLIC_HEALTH" | grep -q '"retell":"ok"'; }
wait_for 45 2 public || { vps "journalctl --user -u cloudflared-bona -n 30 --no-pager" || true; die "public health did not come back"; }
ok "$BONA_PUBLIC_HEALTH answers from the VPS"

say "5/5 Disable the PC units"
systemctl --user disable bona-api cloudflared-bona
FINISHED=1
ok "done — bona-api now runs on $BONA_VPS_SSH; rollback.sh brings it back here"
