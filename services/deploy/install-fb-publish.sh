#!/usr/bin/env bash
# Install (or refresh) the Bona Facebook publisher timer for the current user.
#
#   bash ~/bona/services/deploy/install-fb-publish.sh            # install + enable
#   bash ~/bona/services/deploy/install-fb-publish.sh --uninstall
#
# Run it once ~/.secrets/bona-meta-graph.env holds META_ACCESS_TOKEN and FB_PAGE_ID and the
# code is on origin/main (the unit runs from the publish worktree, which tracks origin/main).
# Idempotent: creates the publish worktree only if missing, syncs the rendered assets into
# ~/bona-data/queue only when this checkout has some, copies the units again, reloads, and
# (re)enables the timer. Nothing here needs root.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
dest="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
env_file="$HOME/.secrets/bona-meta-graph.env"
publish_tree="$HOME/bona-publish"
data="${BONA_DATA:-$HOME/bona-data}"

if [ "${1:-}" = --uninstall ]; then
  systemctl --user disable --now bona-fb-publish.timer 2>/dev/null || true
  rm -f "$dest/bona-fb-publish.timer" "$dest/bona-fb-publish.service"
  systemctl --user daemon-reload
  echo "bona-fb-publish: timer disabled and units removed (publish tree, assets and ledger left alone)"
  exit 0
fi

[ -f "$env_file" ] || { echo "error: $env_file does not exist — bona-secret META_ACCESS_TOKEN 'EAA…' meta" >&2; exit 1; }
grep -q '^META_ACCESS_TOKEN=.\+' "$env_file" || { echo "error: META_ACCESS_TOKEN is empty in $env_file" >&2; exit 1; }
grep -q '^FB_PAGE_ID=.\+' "$env_file" || echo "note: FB_PAGE_ID not in $env_file — the publisher falls back to the Bona Real Estate Page id"
[ "$(stat -c %a "$env_file")" = "600" ] || { echo "note: tightening $env_file to mode 600"; chmod 600 "$env_file"; }
for tool in node git timeout rsync; do command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool is not on PATH" >&2; exit 1; }; done

# ---- the publish tree (shared with the Instagram publisher) ----------------------------
if [ ! -e "$publish_tree/.git" ]; then
  git -C "$repo" fetch --quiet origin main || echo "note: could not fetch origin/main — pinning to the local main; the sync step will move it" >&2
  if git -C "$repo" rev-parse -q --verify refs/remotes/origin/main >/dev/null; then base=refs/remotes/origin/main; else base=refs/heads/main; fi
  git -C "$repo" worktree add --detach "$publish_tree" "$base"
  echo "publish tree: created $publish_tree at $(git -C "$publish_tree" rev-parse --short HEAD)"
else
  bash "$here/publish-tree.sh" sync "$publish_tree" || true
fi
if [ ! -f "$publish_tree/scripts/social/facebook-post.mjs" ]; then
  echo "error: $publish_tree has no scripts/social/facebook-post.mjs — merge the branch that adds it into main first" >&2; exit 1
fi

# ---- assets + data dir --------------------------------------------------------------------
install -d -m 700 "$data/fb" "$data/queue"
if [ -d "$repo/marketing/queue" ] && [ "$(find "$repo/marketing/queue" -type f ! -name queue.json ! -name README.md | head -1)" ]; then
  rsync -a --exclude queue.json --exclude README.md "$repo/marketing/queue/" "$data/queue/"
  echo "assets: synced $repo/marketing/queue → $data/queue ($(du -sh "$data/queue" | cut -f1))"
else
  echo "note: $repo/marketing/queue has no rendered assets to sync; $data/queue holds $(find "$data/queue" -type f | wc -l) files"
fi

# ---- units -------------------------------------------------------------------------------
install -d "$dest"
install -m 644 "$here/bona-fb-publish.service" "$dest/bona-fb-publish.service"
install -m 644 "$here/bona-fb-publish.timer" "$dest/bona-fb-publish.timer"
systemctl --user daemon-reload
systemctl --user enable --now bona-fb-publish.timer
echo
systemctl --user list-timers bona-fb-publish.timer --no-pager
echo
echo "dry run of what is due right now (nothing is sent):"
( cd "$publish_tree" && BONA_QUEUE_ASSETS="$data/queue" BONA_DATA="$data" node scripts/social/facebook-post.mjs queue --dry-run --grace 3 ) || true
echo
echo "logs: journalctl --user -u bona-fb-publish -o cat -n 50"
