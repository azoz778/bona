#!/usr/bin/env bash
# Run ON THE PC. Copies the four ~/.secrets/*.env files and the tunnel credentials JSON to the VPS,
# mode 0600, without ever printing their contents. Re-run any time a secret changes on the PC.
# bona-services.env keeps the VPS's own lines for $VPS_KEEP_KEYS (lib.sh): since 2026-11-19 the
# VPS reads Bona's own WhatsApp while the PC copy keeps the owner's personal one for bona-intake.
# Those lines are read from the VPS first; when they cannot be read, nothing is copied.
#   sync-secrets.sh            copy
#   sync-secrets.sh --dry-run  list what would be copied
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
need scp; need ssh; need awk

DRY=0; [ "${1:-}" = --dry-run ] && DRY=1
files=()
for f in $SECRET_FILES; do
  [ -f "$SECRETS_DIR/$f" ] || die "missing $SECRETS_DIR/$f on this machine"
  [ "$f" = "$VPS_KEEP_FILE" ] || files+=("$SECRETS_DIR/$f")
done
[ -f "$CF_DIR/$BONA_TUNNEL_ID.json" ] || die "missing tunnel credentials $CF_DIR/$BONA_TUNNEL_ID.json"

say "Secrets to copy to $BONA_VPS_SSH"
for f in "${files[@]}" "$SECRETS_DIR/$VPS_KEEP_FILE" "$CF_DIR/$BONA_TUNNEL_ID.json"; do echo "  $f ($(stat -c %s "$f") bytes)"; done
echo "  $VPS_KEEP_FILE keeps the VPS's own lines for: $VPS_KEEP_KEYS"
[ "$DRY" = 1 ] && { ok "dry run, nothing copied"; exit 0; }

umask 077
keep=$(mktemp "$SECRETS_DIR/.vps-keep.XXXXXX")
merged=$(mktemp "$SECRETS_DIR/.$VPS_KEEP_FILE.sync.XXXXXX")
trap 'rm -f "$keep" "$merged"' EXIT

ssh "$BONA_VPS_SSH" 'install -d -m 700 ~/.secrets ~/.cloudflared'
# The VPS's own lines for the kept keys, into a 0600 file: never echoed, never logged.
ssh "$BONA_VPS_SSH" "$(vps_keep_grep)" > "$keep" || die "could not read the VPS's own $VPS_KEEP_FILE lines; nothing copied"
keep_vps_keys "$SECRETS_DIR/$VPS_KEEP_FILE" "$keep" "$merged"
kept=$(grep -c . "$keep" || true)
scp -q -p "${files[@]}" "$BONA_VPS_SSH:.secrets/"
scp -q -p "$merged" "$BONA_VPS_SSH:.secrets/$VPS_KEEP_FILE"
scp -q -p "$CF_DIR/$BONA_TUNNEL_ID.json" "$BONA_VPS_SSH:.cloudflared/"
remote=""
for f in $SECRET_FILES; do remote="$remote ~/.secrets/$f"; done   # only the files this script copies, never a glob
ssh "$BONA_VPS_SSH" "chmod 600$remote ~/.cloudflared/$BONA_TUNNEL_ID.json && ls -l ~/.secrets ~/.cloudflared | sed 's/^/  /'"
ok "copied ($kept line(s) of $VPS_KEEP_FILE kept from the VPS); now run install-vps.sh --check on the VPS"
