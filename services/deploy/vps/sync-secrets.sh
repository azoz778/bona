#!/usr/bin/env bash
# Run ON THE PC. Copies the four ~/.secrets/*.env files and the tunnel credentials JSON to the VPS,
# mode 0600, without ever printing their contents. Re-run any time a secret changes on the PC.
# Two guards, both read from the VPS before anything is copied; when a read fails, nothing is copied:
# - Kept keys (lib.sh vps_keep_keys): in bona-services.env and bona-marketing.env the VPS's own line
#   wins for the keys that are set on the VPS on purpose (its WhatsApp instance and number since
#   2026-11-19, its poll interval, the dashboard push keys, the TikTok keys).
# - Missing keys (2026-11-27): a key the VPS copy of a file has, that the PC copy lacks and that is not
#   kept, would be deleted on the VPS by the copy. Then nothing is copied, and the key NAMES are printed
#   (never a value). Add each one to the PC file (or keep it, lib.sh), or run with --force to drop them.
#   sync-secrets.sh            copy
#   sync-secrets.sh --dry-run  list what would be copied (contacts nothing, so neither guard runs)
#   sync-secrets.sh --force    copy even though the VPS has keys the PC lacks (they are removed there)
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"

DRY=0; FORCE=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --force) FORCE=1 ;;
    *) die "usage: sync-secrets.sh [--dry-run] [--force]" ;;
  esac
done
need scp; need ssh; need awk; need sed

files=()
for f in $SECRET_FILES; do
  [ -f "$SECRETS_DIR/$f" ] || die "missing $SECRETS_DIR/$f on this machine"
  files+=("$SECRETS_DIR/$f")
done
[ -f "$CF_DIR/$BONA_TUNNEL_ID.json" ] || die "missing tunnel credentials $CF_DIR/$BONA_TUNNEL_ID.json"

say "Secrets to copy to $BONA_VPS_SSH"
for f in "${files[@]}" "$CF_DIR/$BONA_TUNNEL_ID.json"; do echo "  $f ($(stat -c %s "$f") bytes)"; done
for f in $VPS_KEEP_FILES; do echo "  $f keeps the VPS's own lines for: $(vps_keep_keys "$f")"; done
[ "$DRY" = 1 ] && { ok "dry run, nothing copied (the VPS is not contacted, so the missing-key check did not run)"; exit 0; }

umask 077
work=$(mktemp -d "$SECRETS_DIR/.vps-sync.XXXXXX")
trap 'rm -rf "$work"' EXIT

ssh "$BONA_VPS_SSH" 'install -d -m 700 ~/.secrets ~/.cloudflared'
# The VPS's key names (names only) for the missing-key guard, and its own kept-key lines (values) into
# 0600 files under $work: never echoed, never logged.
ssh "$BONA_VPS_SSH" "$(vps_key_names_cmd)" > "$work/vps-names" || die "could not read the key names on the VPS; nothing copied"
for f in $VPS_KEEP_FILES; do
  ssh "$BONA_VPS_SSH" "$(vps_keep_grep "$f")" > "$work/keep.$f" || die "could not read the VPS's own $f lines; nothing copied"
done

say "Keys on the VPS that the PC lacks"
lost=$(vps_only_keys "$work/vps-names")
if [ -n "$lost" ]; then
  {
    echo "The VPS has these keys and the PC copies do not, so this copy would delete them on the VPS (file, key):"
    printf '%s\n' "$lost" | sed 's/^/  /'
  } >&2
  if [ "$FORCE" = 1 ]; then
    warn "--force: copying anyway; the keys above are removed from the VPS files"
  else
    die "refused, nothing copied: add each key to the PC file (or keep it: lib.sh vps_keep_keys), or run again with --force to remove them on the VPS"
  fi
else
  ok "none (every VPS key is in the PC copy or kept)"
fi

kept=""
for f in $VPS_KEEP_FILES; do
  keep_vps_keys "$SECRETS_DIR/$f" "$work/keep.$f" "$work/$f" "$(vps_keep_keys "$f")"
  kept="$kept, $(grep -c . "$work/keep.$f" || true) in $f"
done
copy=()
for f in $SECRET_FILES; do
  case " $VPS_KEEP_FILES " in *" $f "*) copy+=("$work/$f") ;; *) copy+=("$SECRETS_DIR/$f") ;; esac
done
scp -q -p "${copy[@]}" "$BONA_VPS_SSH:.secrets/"
scp -q -p "$CF_DIR/$BONA_TUNNEL_ID.json" "$BONA_VPS_SSH:.cloudflared/"
remote=""
for f in $SECRET_FILES; do remote="$remote ~/.secrets/$f"; done   # only the files this script copies, never a glob
ssh "$BONA_VPS_SSH" "chmod 600$remote ~/.cloudflared/$BONA_TUNNEL_ID.json && ls -l ~/.secrets ~/.cloudflared | sed 's/^/  /'"
ok "copied (VPS lines kept: ${kept#, }); now run install-vps.sh --check on the VPS"
