#!/usr/bin/env bash
# Install the daily TikTok / LinkedIn browser publisher units (systemd --user). Run from the
# clean origin/main publish tree (~/bona-publish) once this branch is merged and pushed.
# It does NOT enable the timers unless --enable is given; docs/browser-publishing.md.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
dest="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
data="${BONA_DATA:-$HOME/bona-data}"
bash "$here/guard-main.sh" "$repo"
bash "$here/ensure-deps.sh" "$repo"
mkdir -p "$data/tiktok" "$data/linkedin" "$dest/bona-browser@.service.d" /mnt/c/Users/ASUS/AppData/Local/bona-social-upload
install -m 644 "$here/bona-browser@.service" "$dest/bona-browser@.service"
install -m 644 "$here/bona-browser@.service.d/ipv4first.conf" "$dest/bona-browser@.service.d/ipv4first.conf"
install -m 644 "$here/bona-browser@tiktok.timer" "$dest/bona-browser@tiktok.timer"
install -m 644 "$here/bona-browser@linkedin.timer" "$dest/bona-browser@linkedin.timer"
systemctl --user daemon-reload
if [ "${1:-}" = "--enable" ]; then
  systemctl --user enable --now bona-browser@tiktok.timer bona-browser@linkedin.timer
  systemctl --user list-timers 'bona-browser@*' --no-pager
else
  echo "Installed, not enabled. Dry run first:  (cd $repo && node scripts/social/browser-publish.mjs tiktok --dry-run --any-time)"
  echo "Then enable:  systemctl --user enable --now bona-browser@tiktok.timer bona-browser@linkedin.timer"
fi
