#!/usr/bin/env bash
# The publish worktree (~/bona-publish) that the unattended publishers run from.
#
#   publish-tree.sh sync  [tree]   bring it to origin/main (best effort: no network = run what is there)
#   publish-tree.sh guard [tree]   refuse unless it IS origin/main (or the main branch) and clean
#
# The tree is a `git worktree` of ~/bona pinned DETACHED to origin/main — detached on purpose,
# because a worktree that held `main` would stop ~/bona (or any other worktree) from checking
# main out. The publishers read queue.json / the calendar from the working tree, so a feature
# branch, a stray edit or a stale checkout must never feed a timer: `guard` exits 1 and the
# unit fails before ExecStart, with the reason in the journal. Both modes are read-only apart
# from the checkout itself and never touch anything outside the tree.
set -u
mode="${1:-guard}"
tree="${2:-$HOME/bona-publish}"
tag="bona-publish"
say() { echo "$tag: $*"; }
refuse() { echo "$tag: refusing to run — $tree $*" >&2; exit 1; }

case "$mode" in
  sync)
    [ -e "$tree/.git" ] || { say "$tree is not a git worktree — run services/deploy/install-fb-publish.sh"; exit 1; }
    if ! git -C "$tree" diff --quiet HEAD -- 2>/dev/null; then
      say "$tree has local modifications to tracked files — not touching it (guard will refuse)"; exit 1
    fi
    if ! git -C "$tree" fetch --quiet origin main; then
      say "fetch failed — running the tree as it is ($(git -C "$tree" rev-parse --short HEAD))"; exit 1
    fi
    want="$(git -C "$tree" rev-parse refs/remotes/origin/main)"
    if [ "$(git -C "$tree" rev-parse HEAD)" = "$want" ]; then say "already at origin/main (${want:0:9})"; exit 0; fi
    git -C "$tree" checkout --quiet --detach refs/remotes/origin/main || { say "checkout of origin/main failed"; exit 1; }
    say "now at origin/main (${want:0:9})"
    ;;
  guard)
    head="$(git -C "$tree" rev-parse -q --verify HEAD 2>/dev/null)" || refuse "is not a git checkout (run services/deploy/install-fb-publish.sh)"
    branch="$(git -C "$tree" symbolic-ref --short -q HEAD 2>/dev/null || echo detached)"
    want="$(git -C "$tree" rev-parse -q --verify refs/remotes/origin/main 2>/dev/null || true)"
    if [ "$branch" != "main" ] && { [ -z "$want" ] || [ "$head" != "$want" ]; }; then
      refuse "is on '$branch' at ${head:0:9}, not origin/main${want:+ (${want:0:9})} — git -C $tree checkout --detach origin/main"
    fi
    git -C "$tree" diff --quiet HEAD -- 2>/dev/null || refuse "has local modifications to tracked files — git -C $tree status"
    label=main; [ "$branch" = "main" ] || label=origin/main
    say "$tree at ${head:0:9} ($label), clean"
    ;;
  *) echo "usage: publish-tree.sh sync|guard [tree]" >&2; exit 2 ;;
esac
