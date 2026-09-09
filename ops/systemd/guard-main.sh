#!/usr/bin/env bash
# ExecStartPre for bona-ig-publish.service: refuse to run the publisher unless ~/bona has
# `main` checked out. The timer reads src/data/content-calendar.json from the working tree;
# a feature branch left checked out would silently feed it a different calendar.
# Read-only (works under ProtectHome=read-only); exit 1 fails the unit before ExecStart.
set -u
repo="${1:-$HOME/bona}"
if ! branch="$(git -C "$repo" symbolic-ref --short -q HEAD 2>/dev/null)"; then
  echo "bona-ig-publish: refusing to run — $repo is not on a branch (detached HEAD or not a git checkout)" >&2
  exit 1
fi
if [ "$branch" != "main" ]; then
  echo "bona-ig-publish: refusing to run — $repo is on branch '$branch', not main (git -C $repo checkout main)" >&2
  exit 1
fi
exit 0
