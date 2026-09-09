#!/usr/bin/env bash
# ExecStartPre for bona-ig-publish.service: refuse to run unless the publish tree is exactly
# origin/main (a detached worktree, which is how install.sh makes it) or on the main branch,
# with no local modifications to tracked files. The calendar is read from that tree; a feature
# branch, a stray edit or a stale checkout must not feed the timer. Read-only; exit 1 fails the
# unit before ExecStart, with the reason in the journal.
set -u
tree="${1:-$HOME/bona-publish}"
refuse() { echo "bona-ig-publish: refusing to run — $tree $*" >&2; exit 1; }
head="$(git -C "$tree" rev-parse -q --verify HEAD 2>/dev/null)" || refuse "is not a git checkout (run ops/systemd/install.sh)"
branch="$(git -C "$tree" symbolic-ref --short -q HEAD 2>/dev/null || echo detached)"
want="$(git -C "$tree" rev-parse -q --verify refs/remotes/origin/main 2>/dev/null || true)"
if [ "$branch" != "main" ] && { [ -z "$want" ] || [ "$head" != "$want" ]; }; then
  refuse "is on '$branch' at ${head:0:9}, not origin/main${want:+ (${want:0:9})} — git -C $tree checkout --detach origin/main"
fi
git -C "$tree" diff --quiet HEAD -- 2>/dev/null || refuse "has local modifications to tracked files — git -C $tree status"
label=main; [ "$branch" = "main" ] || label=origin/main
echo "bona-ig-publish: $tree at ${head:0:9} ($label), clean"
