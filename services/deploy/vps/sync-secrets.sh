#!/usr/bin/env bash
# Run ON THE PC. Copies the four ~/.secrets/*.env files and the tunnel credentials JSON to the VPS,
# mode 0600, without ever printing their contents. Re-run any time a secret changes on the PC.
#   sync-secrets.sh            copy
#   sync-secrets.sh --dry-run  list what would be copied
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
need scp; need ssh

DRY=0; [ "${1:-}" = --dry-run ] && DRY=1
files=()
for f in $SECRET_FILES; do
  [ -f "$SECRETS_DIR/$f" ] || die "missing $SECRETS_DIR/$f on this machine"
  files+=("$SECRETS_DIR/$f")
done
[ -f "$CF_DIR/$BONA_TUNNEL_ID.json" ] || die "missing tunnel credentials $CF_DIR/$BONA_TUNNEL_ID.json"

say "Secrets to copy to $BONA_VPS_SSH"
for f in "${files[@]}" "$CF_DIR/$BONA_TUNNEL_ID.json"; do echo "  $f ($(stat -c %s "$f") bytes)"; done
[ "$DRY" = 1 ] && { ok "dry run, nothing copied"; exit 0; }

ssh "$BONA_VPS_SSH" 'install -d -m 700 ~/.secrets ~/.cloudflared'
scp -q -p "${files[@]}" "$BONA_VPS_SSH:.secrets/"
scp -q -p "$CF_DIR/$BONA_TUNNEL_ID.json" "$BONA_VPS_SSH:.cloudflared/"
ssh "$BONA_VPS_SSH" "chmod 600 ~/.secrets/*.env ~/.cloudflared/$BONA_TUNNEL_ID.json && ls -l ~/.secrets ~/.cloudflared | sed 's/^/  /'"
ok "copied; now run install-vps.sh --check on the VPS"
