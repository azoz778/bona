#!/usr/bin/env bash
# Bring the publish worktree (~/bona-publish) to origin/main before a run. Best-effort by
# design: the unit runs it with "-" and a 60 s timeout, so no network / no credentials means
# "run what is there" — guard-main.sh still insists that what is there IS origin/main and clean.
set -u
tree="${1:-$HOME/bona-publish}"
say() { echo "bona-ig-publish sync: $*"; }
[ -e "$tree/.git" ] || { say "$tree is not a git worktree — run ops/systemd/install.sh"; exit 1; }
if ! git -C "$tree" diff --quiet HEAD -- 2>/dev/null; then
  say "$tree has local modifications to tracked files — not touching it (the guard will refuse)"; exit 1
fi
if ! git -C "$tree" fetch --quiet origin main; then
  say "fetch failed — running the tree as it is ($(git -C "$tree" rev-parse --short HEAD))"; exit 1
fi
want="$(git -C "$tree" rev-parse refs/remotes/origin/main)"
if [ "$(git -C "$tree" rev-parse HEAD)" = "$want" ]; then say "already at origin/main (${want:0:9})"; exit 0; fi
git -C "$tree" checkout --quiet --detach refs/remotes/origin/main || { say "checkout of origin/main failed"; exit 1; }
say "now at origin/main (${want:0:9})"
