#!/usr/bin/env bash
# ExecStartPre for bona-browser@.service: the browser publisher renders with sharp, so the publish
# tree needs node_modules (the Graph publishers do not). Installs only when package-lock.json has
# changed since the last install; node_modules is gitignored, so guard-main.sh is unaffected.
set -euo pipefail
tree="${1:-$HOME/bona-publish}"
cd "$tree"
want="$(sha256sum package-lock.json | cut -d' ' -f1)"
stamp="node_modules/.bona-lock-sha256"
if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ] && node -e 'import("sharp")' >/dev/null 2>&1; then
  echo "bona-browser deps: up to date (${want:0:9})"; exit 0
fi
echo "bona-browser deps: npm ci --omit=dev (lock ${want:0:9})"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
echo "$want" > "$stamp"
