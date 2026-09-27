#!/usr/bin/env bash
# Run from the deployed clean origin/main checkout after Pages assets are live.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
dest="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
data="${BONA_DATA:-$HOME/bona-data}"
bash "$here/guard-main.sh" "$repo"
test -s "$HOME/.secrets/bona-meta-graph.env"
cd "$repo"
node --input-type=module -e 'import {verifyPack,verifyPublic} from "./scripts/social/lib/daily-pack.mjs"; const p=verifyPack(); for(const e of p.instagram)await verifyPublic(e,p.manifest); console.log("Reviewed pack and every public JPEG verified");'
mkdir -p "$data/daily/legacy-unit-backups" "$data/ig" "$data/fb" "$dest"
systemctl --user stop bona-ig-publish.timer bona-fb-publish.timer bona-ig-publish.service bona-fb-publish.service
for timer in bona-ig-publish.timer bona-fb-publish.timer; do
  state="$(systemctl --user is-enabled "$timer" 2>/dev/null || true)"
  if [ "$state" != masked ]; then systemctl --user disable "$timer"; fi
done
stamp="$(date -u +%Y%m%dT%H%M%S)"
for unit in bona-ig-publish.timer bona-fb-publish.timer bona-ig-publish.service bona-fb-publish.service; do
  file="$dest/$unit"
  if [ -f "$file" ] && [ ! -L "$file" ]; then
    mv -- "$file" "$data/daily/legacy-unit-backups/$stamp-$unit"
  fi
  systemctl --user mask "$unit"
done
install -m 644 "$here/bona-daily@.service" "$dest/bona-daily@.service"
install -m 644 "$here/bona-daily@.timer" "$dest/bona-daily@.timer"
systemctl --user daemon-reload
systemctl --user enable --now bona-daily@instagram.timer bona-daily@facebook.timer
systemctl --user list-timers 'bona-daily@*' --no-pager
