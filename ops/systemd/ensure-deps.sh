#!/usr/bin/env bash
# ExecStartPre for bona-browser@.service: the browser publisher renders with sharp, so the publish
# tree needs node_modules (the Graph publishers do not). Nothing is done while package-lock.json is
# unchanged since the last good install. Otherwise the install happens in a scratch directory under
# ~/bona-data and is swapped in only when it completed, so a failed or interrupted npm ci never
# leaves the tree without node_modules. node_modules is gitignored; guard-main.sh is unaffected.
set -euo pipefail
tree="${1:-$HOME/bona-publish}"
data="${BONA_DATA:-$HOME/bona-data}"
export npm_config_cache="${npm_config_cache:-$data/.npm}"
cd "$tree"
want="$(sha256sum package-lock.json | cut -d' ' -f1)"
stamp="node_modules/.bona-lock-sha256"
if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ] && node -e 'import("sharp")' >/dev/null 2>&1; then
  echo "bona-browser deps: up to date (${want:0:9})"; exit 0
fi
build="$data/.deps-build"
rm -rf "$build"; mkdir -p "$build"
cp package.json package-lock.json "$build/"
[ -f .npmrc ] && cp .npmrc "$build/"
echo "bona-browser deps: npm ci --omit=dev in $build (lock ${want:0:9})"
( cd "$build" && npm ci --omit=dev --no-audit --no-fund --loglevel=error )
( cd "$build" && node -e 'import("sharp")' ) || { echo "bona-browser deps: sharp does not load after install; keeping the old node_modules" >&2; exit 1; }
echo "$want" > "$build/node_modules/.bona-lock-sha256"
# Same filesystem (both under $HOME): two renames, the old tree removed only after the new one is in place.
[ -d node_modules ] && mv node_modules ".node_modules.old.$$"
mv "$build/node_modules" node_modules
rm -rf ".node_modules.old.$$" "$build"
echo "bona-browser deps: installed (${want:0:9})"
