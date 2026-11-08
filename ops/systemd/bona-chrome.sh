#!/usr/bin/env bash
# Bona's own Windows Chrome for the daily TikTok / LinkedIn publisher (docs/browser-publishing.md).
#
# Why not the shared automation Chrome on :9222 (~/.claude/scripts/chrome-debug.sh): other bots
# browse with it (LinkedIn job search and applications), it runs headless (its user agent says
# "HeadlessChrome"), and on 2026-11-08 LinkedIn answered it with a Cloudflare "Sorry, you have been
# blocked" page while TikTok logged it out and showed a captcha. This one is an ordinary, visible
# Chrome with its own profile that only the publisher drives. It starts minimised; the
# no-throttling switches keep a minimised window rendering, so uploads, timers and screenshots
# behave as in a window on screen.
#
#   ops/systemd/bona-chrome.sh              start it on :9230 if it is not running (idempotent; the unit calls this)
#   ops/systemd/bona-chrome.sh show [URL]   open a visible window in it (log in, look at the accounts)
#
# DevTools listens on 127.0.0.1 only and, unlike the shared :9222, without --remote-allow-origins=*, so a web
# page cannot open a DevTools socket to this profile (it holds the Bona TikTok and LinkedIn sessions).
set -u
PORT="${BONA_CHROME_PORT:-9230}"
CHROME="${BONA_CHROME_EXE:-C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe}"
PROFILE="${BONA_CHROME_PROFILE:-C:\\Users\\ASUS\\AppData\\Local\\bona-social-chrome}"
CMD=/mnt/c/Windows/System32/cmd.exe
FLAGS=(--remote-debugging-port="$PORT" --user-data-dir="$PROFILE"
  --no-first-run --no-default-browser-check
  --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding)

up() { curl -s --max-time 2 "http://localhost:${PORT}/json/version" >/dev/null 2>&1; }
# cmd.exe 'start' through WSL interop holds the pipe until Chrome exits unless it is detached.
launch() { "$CMD" /c start "" "$@" </dev/null >/dev/null 2>&1 & }

if [ "${1:-}" = "show" ]; then
  url="${2:-https://www.tiktok.com/login}"
  case "$url" in *'&'*|*'^'*|*'|'*|*'<'*|*'>'*|*'"'*) echo "bona-chrome: URL has characters cmd.exe would mangle; open it from the window instead" >&2; exit 2 ;; esac
  # A running instance of this profile takes the request and opens a new window; otherwise it starts here.
  launch "$CHROME" "${FLAGS[@]}" --new-window "$url"
  if timeout 25 curl -s --retry 25 --retry-connrefused --retry-delay 1 "http://localhost:${PORT}/json/version" >/dev/null 2>&1; then
    echo "bona-chrome: window open on :${PORT} ($url)"; exit 0
  fi
  echo "bona-chrome: FAILED to reach :${PORT}" >&2; exit 1
fi

if up; then echo "bona-chrome: already up on :${PORT}"; exit 0; fi
launch /min "$CHROME" "${FLAGS[@]}" about:blank
if timeout 25 curl -s --retry 25 --retry-connrefused --retry-delay 1 "http://localhost:${PORT}/json/version" >/dev/null 2>&1; then
  echo "bona-chrome: started on :${PORT} (minimised)"; exit 0
fi
echo "bona-chrome: FAILED to reach :${PORT}" >&2
exit 1
