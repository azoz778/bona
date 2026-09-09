#!/usr/bin/env bash
# Install (or refresh) the Bona Instagram publisher timer for the current user.
# Run it once the token file exists:  bash ~/bona/ops/systemd/install.sh
# Idempotent: creates the publish worktree and seeds the ledger only if missing, copies the
# units again, reloads, and (re)enables the timer.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
dest="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
env_file="$HOME/.secrets/bona-meta-graph.env"
publish_tree="$HOME/bona-publish"

if [ ! -f "$env_file" ]; then
  echo "error: $env_file does not exist — the service refuses to start without it." >&2
  echo "       Expected layout: META_ACCESS_TOKEN=… IG_BUSINESS_ID=17841427688957180 FB_PAGE_ID=1245646955305748" >&2
  exit 1
fi
if ! grep -q '^META_ACCESS_TOKEN=.\+' "$env_file"; then
  echo "error: META_ACCESS_TOKEN is empty in $env_file — the unit passes --live and would fail every 15 min." >&2
  exit 1
fi
if [ "$(stat -c %a "$env_file")" != "600" ]; then
  echo "note: tightening $env_file to mode 600"; chmod 600 "$env_file"
fi
for tool in node git timeout; do command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool is not on PATH" >&2; exit 1; }; done

# ---- the publish tree -------------------------------------------------------------------
# The unit runs from ~/bona-publish, a worktree of this repository pinned (detached) to
# origin/main — ~/bona is a shared tree on feature branches most evenings, and the calendar is
# read from the working tree. Detached on purpose: a worktree that held `main` would stop
# ~/bona (or any other worktree) from checking main out. sync-publish-tree.sh refreshes it
# before every run. The publisher needs no node_modules (Node builtins + scripts/social/lib),
# so there is no npm step here.
if [ ! -e "$publish_tree/.git" ]; then
  git -C "$repo" fetch --quiet origin main || echo "note: could not fetch origin/main — pinning to the local main for now; the sync step will move it" >&2
  if git -C "$repo" rev-parse -q --verify refs/remotes/origin/main >/dev/null; then base=refs/remotes/origin/main; else base=refs/heads/main; fi
  git -C "$repo" worktree add --detach "$publish_tree" "$base"
  echo "publish tree: created $publish_tree at $(git -C "$publish_tree" rev-parse --short HEAD) ($base)"
else
  bash "$here/sync-publish-tree.sh" "$publish_tree" || true
  echo "publish tree: $publish_tree at $(git -C "$publish_tree" rev-parse --short HEAD)"
fi
if [ ! -f "$publish_tree/ops/systemd/guard-main.sh" ]; then
  echo "warning: origin/main does not carry the publisher yet (no ops/systemd/guard-main.sh in $publish_tree)." >&2
  echo "         The unit will refuse to run until main is merged AND pushed; then re-run this script." >&2
fi

# ---- the ledger -------------------------------------------------------------------------
# It lives outside every repo (scripts/social/lib/ledger.mjs). Create its directory — the
# unit's ReadWritePaths needs it to exist — and seed it exactly once: from the legacy in-repo
# copy if one is still on disk, else from ledger-seed.jsonl (the hand-published launch post
# #9, which the timer must never re-post). An existing ledger is never touched.
ledger="${BONA_IG_LEDGER:-$HOME/bona-data/ig/published.jsonl}"
ledger_dir="$(dirname "$ledger")"
legacy="$repo/marketing/queue/published.jsonl"
install -d -m 700 "$ledger_dir"
if [ ! -e "$ledger" ]; then
  if [ -s "$legacy" ]; then
    cp "$legacy" "$ledger"; echo "ledger: migrated $legacy -> $ledger"
  else
    cp "$here/ledger-seed.jsonl" "$ledger"; echo "ledger: seeded $ledger from ledger-seed.jsonl"
  fi
  chmod 600 "$ledger"
else
  echo "ledger: $ledger exists ($(grep -c . "$ledger") line(s)) — left as is"
fi
if [ -n "${BONA_IG_LEDGER:-}" ]; then
  echo "note: BONA_IG_LEDGER=$BONA_IG_LEDGER is set in this shell; the unit only sees $env_file — add it there and to ReadWritePaths if you mean it." >&2
fi

# ---- the units --------------------------------------------------------------------------
# Installed from the publish tree when it has them (that is what the timer runs), else from
# this checkout for a first install ahead of the push.
units="$here"; [ -f "$publish_tree/ops/systemd/bona-ig-publish.service" ] && units="$publish_tree/ops/systemd"
install -d "$dest"
install -m 644 "$units/bona-ig-publish.service" "$dest/bona-ig-publish.service"
install -m 644 "$units/bona-ig-publish.timer" "$dest/bona-ig-publish.timer"
systemctl --user daemon-reload
systemctl --user enable --now bona-ig-publish.timer
echo
systemctl --user list-timers bona-ig-publish.timer --no-pager
echo
echo "installed (units from $units). Useful:"
echo "  journalctl --user -u bona-ig-publish -o cat -f      # watch a run"
echo "  systemctl --user start bona-ig-publish.service      # run once, now"
echo "  systemctl --user stop bona-ig-publish.timer         # pause (start to resume)"
echo "  git -C $publish_tree log -1 --oneline               # what the timer runs (origin/main)"
echo "  (cd ~/bona && node scripts/social/publish.mjs --dry-run)   # what the next run would do"
echo "  ledger: $ledger"
