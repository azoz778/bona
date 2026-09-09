#!/usr/bin/env bash
# Install (or refresh) the Bona Instagram publisher timer for the current user.
# Run it once the token file exists:  bash ~/bona/ops/systemd/install.sh
# Idempotent: re-running copies the units again, reloads, and (re)enables the timer.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
env_file="$HOME/.secrets/bona-meta-graph.env"

if [ ! -f "$env_file" ]; then
  echo "error: $env_file does not exist — the service refuses to start without it." >&2
  echo "       Expected layout: META_ACCESS_TOKEN=… IG_BUSINESS_ID=17841427688957180 FB_PAGE_ID=1245646955305748" >&2
  exit 1
fi
if ! grep -q '^META_ACCESS_TOKEN=.\+' "$env_file"; then
  echo "error: META_ACCESS_TOKEN is empty in $env_file — the publisher would run in dry-run mode forever." >&2
  exit 1
fi
if [ "$(stat -c %a "$env_file")" != "600" ]; then
  echo "note: tightening $env_file to mode 600"; chmod 600 "$env_file"
fi
if ! command -v node >/dev/null 2>&1; then echo "error: node is not on PATH" >&2; exit 1; fi

# The ledger lives outside the repo (scripts/social/lib/ledger.mjs). Create its directory —
# the unit's ReadWritePaths needs it to exist — and seed it exactly once: from the legacy
# in-repo copy if one is still on disk, else from ledger-seed.jsonl (the hand-published
# launch post #9, which the timer must never re-post). An existing ledger is never touched.
ledger_dir="${BONA_IG_LEDGER:+$(dirname "$BONA_IG_LEDGER")}"
ledger="${BONA_IG_LEDGER:-$HOME/bona-data/ig/published.jsonl}"
ledger_dir="${ledger_dir:-$HOME/bona-data/ig}"
legacy="$here/../../marketing/queue/published.jsonl"
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
if [ "$(git -C "$here/../.." symbolic-ref --short -q HEAD || echo detached)" != "main" ]; then
  echo "note: ~/bona is not on main — the unit's ExecStartPre guard will refuse to run until it is." >&2
fi

install -d "$dest"
install -m 644 "$here/bona-ig-publish.service" "$dest/bona-ig-publish.service"
install -m 644 "$here/bona-ig-publish.timer" "$dest/bona-ig-publish.timer"
systemctl --user daemon-reload
systemctl --user enable --now bona-ig-publish.timer
echo
systemctl --user list-timers bona-ig-publish.timer --no-pager
echo
echo "installed. Useful:"
echo "  journalctl --user -u bona-ig-publish -o cat -f      # watch a run"
echo "  systemctl --user start bona-ig-publish.service      # run once, now"
echo "  systemctl --user stop bona-ig-publish.timer         # pause (start to resume)"
echo "  (cd ~/bona && node scripts/social/publish.mjs --dry-run)   # what the next run would do"
echo "  ledger: $ledger"
