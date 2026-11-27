# services/deploy/vps/lib.sh — shared by every script in this directory. Sourced, never executed.
# Constants first (only BONA_VPS_REPO, BONA_VPS_DEPLOY_DIR, BONA_VPS_SSH, BONA_HOSTNAMES, BONA_REPO_URL, BONA_VPS_EVOLUTION_URL, BONA_PUBLIC_HEALTH, BONA_TUNNEL_NAME, BONA_WAIT_SCALE, GIT_BIN, VPS_USER and BONA_UNIT_DIR may be overridden from the environment; the rest are pinned), then small helpers. Never echo a secret.

BONA_TUNNEL_ID=9022fbec-de4f-44b9-805e-8fff285d6263
BONA_TUNNEL_NAME=${BONA_TUNNEL_NAME:-bona}
# One entry per public hostname; all of them proxy to the same local port. Keep the legacy
# hostnames: brochure QR codes and indexed links point at them (memory 2026-09-08).
BONA_HOSTNAMES=${BONA_HOSTNAMES:-"api.bona-real-estate.com bona-api.azoz.uk bona.azoz.uk"}
# 4102 is taken on the VPS (obsidian-mcp)
BONA_VPS_PORT=4120
BONA_VPS_REPO=${BONA_VPS_REPO:-/opt/bona}
# Where install-vps.sh lives on the VPS; /tmp/bona-vps before the branch is merged (cutover.sh's preflight).
BONA_VPS_DEPLOY_DIR=${BONA_VPS_DEPLOY_DIR:-$BONA_VPS_REPO/services/deploy/vps}
BONA_REPO_URL=${BONA_REPO_URL:-https://github.com/azoz778/bona}
BONA_VPS_EVOLUTION_URL=${BONA_VPS_EVOLUTION_URL:-http://127.0.0.1:8085}   # the same Evolution API as wa-api.azoz.uk, one hop shorter
BONA_VPS_SSH=${BONA_VPS_SSH:-hermes-vps}
BONA_PUBLIC_HEALTH=${BONA_PUBLIC_HEALTH:-https://api.bona-real-estate.com/health}
# Multiplied into every wait_for pause (integer). The tests set 0 so retries do not sleep.
BONA_WAIT_SCALE=${BONA_WAIT_SCALE:-1}

# The absolute git the rendered bona-repo-sync.service execs (a unit's ExecStart takes no PATH
# lookup). install-vps.sh --check verifies it exists; the tests point it at a shim.
GIT_BIN=${GIT_BIN:-/usr/bin/git}

# The VPS units are SYSTEM units (/etc/systemd/system) that run as the service user, NOT
# `systemctl --user` units: Ubuntu 24.04 sets kernel.apparmor_restrict_unprivileged_userns=1, and under
# it a user-manager unit cannot apply the sandbox directives (ProtectSystem, PrivateTmp, ProtectHostname,
# ProtectKernelModules, …) — the service dies with 218/CAPABILITIES. The first live cutover failed exactly
# there (2026-09-08) and rolled back; the same directives under User= in a system unit run fine.
# VPS_USER: the user the units run as = whoever runs install-vps.sh on the VPS (azoz), rendered into
# User=/Group=. BONA_UNIT_DIR: where the rendered units go; the tests point it at a temp dir. The PC side
# is untouched and stays `systemctl --user`.
VPS_USER=${VPS_USER:-$(id -un)}
BONA_UNIT_DIR=${BONA_UNIT_DIR:-/etc/systemd/system}
# How the VPS units are driven — on the VPS (deploy.sh, install-vps.sh) and inside the remote command
# strings cutover.sh / rollback.sh send over ssh. Passwordless sudo exists there; -n means "never prompt".
VPS_SYSTEMCTL="sudo -n systemctl"
VPS_JOURNALCTL="sudo -n journalctl"

NODE_VERSION=v24.19.0
NODE_SHA256=14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647
CLOUDFLARED_VERSION=2026.8.3
CLOUDFLARED_SHA256=f29324fe934d1e100617484c78deef803c4dc2cd351d645bbde42e96b4fccc5e

SECRET_FILES="retell.env evolution-api.env bona-services.env bona-marketing.env"
# Kept keys: in these files the VPS's own line wins for the keys below (sync-secrets.sh); the other lines and
# the other files are copied from the PC as they are. A verbatim copy would silently undo or delete them:
# - bona-services.env (2026-11-19): BONA_WA_INSTANCE / BONA_WA_INSTANCE_JID, because the PC copy keeps the
#   owner's personal WhatsApp instance for bona-intake while the VPS reads Bona's own (A2Z go-live item 7);
#   (2026-11-27, PR-INFRA) BONA_WA_POLL_MS, the VPS's own poll interval, and BONA_VAPID_PUBLIC /
#   BONA_VAPID_PRIVATE, the dashboard push keys, which exist only on the VPS.
# - bona-marketing.env (2026-11-27): TIKTOK_PIXEL_ID, TIKTOK_EVENTS_ACCESS_TOKEN, TIKTOK_TEST_EVENT_CODE (only
#   on the VPS).
# A key name belongs to one file only. Any OTHER key the VPS has and the PC lacks stops the copy (the guard).
VPS_KEEP_FILES="bona-services.env bona-marketing.env"
VPS_KEEP_SERVICES_KEYS="BONA_WA_INSTANCE BONA_WA_INSTANCE_JID BONA_WA_POLL_MS BONA_VAPID_PUBLIC BONA_VAPID_PRIVATE"
VPS_KEEP_MARKETING_KEYS="TIKTOK_PIXEL_ID TIKTOK_EVENTS_ACCESS_TOKEN TIKTOK_TEST_EVENT_CODE"
DATA_FILES="bona.db bona.db-wal bona.db-shm leads.jsonl chats.jsonl calls.jsonl"
UNITS="bona-api.service cloudflared-bona.service bona-repo-sync.service bona-repo-sync.timer"
# Stop order on the VPS: the tunnel connector first (no more public traffic), then the API, then the timer.
VPS_UNITS="cloudflared-bona bona-api bona-repo-sync.timer"

HOME_DIR=${HOME:?HOME is not set}
NODE_DIR="$HOME_DIR/.local/opt/node-$NODE_VERSION-linux-x64"
NODE_BIN="$NODE_DIR/bin"
CLOUDFLARED_BIN="$HOME_DIR/.local/bin/cloudflared"
# For commands sent over ssh: the VPS home differs from the PC home, so let the REMOTE shell expand ~.
REMOTE_NODE='~/.local/opt/node-'"$NODE_VERSION"'-linux-x64/bin/node'
DATA_DIR="$HOME_DIR/bona-data"
SECRETS_DIR="$HOME_DIR/.secrets"
CF_DIR="$HOME_DIR/.cloudflared"
VPS_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TEMPLATE_DIR="$VPS_LIB_DIR/templates"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ok \033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mfail\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

# vps_keep_keys FILE → the kept keys of FILE, space-separated; nothing for a file copied verbatim.
vps_keep_keys() {
  case "$1" in
    bona-services.env) printf '%s' "$VPS_KEEP_SERVICES_KEYS" ;;
    bona-marketing.env) printf '%s' "$VPS_KEEP_MARKETING_KEYS" ;;
  esac
}

# ---- How the shell reads a key line, on both machines: lib/env.mjs parseEnvText, as ONE awk function ---
# parseEnvText trims each line with String.prototype.trim(), which strips the ASCII blanks (space, \t, \v, \f, \r) and
# the Unicode white space: U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and the BOM U+FEFF.
# Then `export ` (exactly "export" and one ASCII space) and a trim again, then the name before the first `=`, trimmed.
# key(line) does the same on the UTF-8 bytes and returns "" for a line that sets no key: so `export<TAB>KEY=` and
# `export =` are no keys, as in the API. Every read of a key line goes through it: the PC's names, both VPS reads,
# the check of their answers and the merge, so no two of them can read a line differently (fix round 2; the r1
# sed/awk pair did: Claude r2, Codex r2). Every awk that uses it runs with LC_ALL=C, so gawk reads bytes as mawk does
# (the VPS and the CI runner have mawk, this PC gawk; vps-deploy.test.mjs holds it to parseEnvText for each white
# space character). nobom(line) is the line without a leading BOM. No single quote in it: the remote commands
# carry it inside single quotes.
KEY_AWK='function key(line,  k, n, r) { k = line; sub("^" WS "+", "", k); if (substr(k, 1, 7) == "export ") { k = substr(k, 8); sub("^" WS "+", "", k) }; if (!match(k, /^[A-Za-z_][A-Za-z0-9_]*/)) return ""; n = substr(k, 1, RLENGTH); r = substr(k, RLENGTH + 1); sub("^" WS "+", "", r); return substr(r, 1, 1) == "=" ? n : "" }; function nobom(line) { return index(line, BOM) == 1 ? substr(line, 4) : line }; BEGIN { BOM = "\357\273\277"; WS = "([[:space:]]|\302\240|\341\232\200|\342\200[\200\201\202\203\204\205\206\207\210\211\212\250\251\257]|\342\201\237|\343\200\200|" BOM ")" }'
# The answers of the two VPS reads: rows, then for every file it was asked about a record, "= FILE N" (N = its rows)
# or "= FILE -" (the file is not there), and last "= end". A record cannot be a key line (it starts with `=`). So an
# answer that exits 0 but lost its rows, a record or its end is told apart from a VPS without the file (Codex r2).

# vps_keep_grep FILE → the remote command that prints the VPS's own kept-key lines of FILE (a leading BOM dropped),
# then "= FILE N" and "= end"; "= FILE -" and "= end" when the file is not there; a non-zero status when awk fails.
# It dies when FILE keeps no key, and it runs inside "$(…)", where die only leaves the subshell: the caller stops on
# its status (`cmd=$(vps_keep_grep "$f") || exit 1`; Claude r1).
vps_keep_grep() {
  local keys; keys=$(vps_keep_keys "$1")
  [ -n "$keys" ] || die "vps_keep_grep: $1 has no kept keys"
  printf '%s' "f=~/.secrets/$1; if [ -e \"\$f\" ]; then LC_ALL=C awk -v f=$1 -v keys=\"$keys\" '$KEY_AWK; BEGIN { n = split(keys, l, \" \"); for (i = 1; i <= n; i++) want[l[i]] = 1 } (key(\$0) in want) { print nobom(\$0); c++ } END { print \"=\", f, c + 0; print \"= end\" }' \"\$f\" || exit 1; else echo '= $1 -'; echo '= end'; fi"
}

# keep_vps_keys PC_FILE VPS_LINES OUT KEYS: OUT is PC_FILE, except that a line for one of KEYS
# (space-separated) the VPS has (VPS_LINES) stands in place of the PC's line for that key, or is
# appended when the PC has none; a kept key the VPS lacks keeps the PC's line. Prints nothing.
# Both files are read with key() (KEY_AWK); the records in VPS_LINES set no key, so they are not lines here.
# (FILENAME == vpsfile, not NR == FNR: with an empty VPS_LINES the classic idiom would read the
# PC's lines as the VPS's.)
keep_vps_keys() {
  LC_ALL=C awk -v keys="$4" -v vpsfile="$2" "$KEY_AWK"'
    BEGIN { n = split(keys, list, " "); for (i = 1; i <= n; i++) want[list[i]] = 1 }
    FILENAME == vpsfile { k = key($0); if (k in want) vps[k] = $0; next }
    { k = key($0)
      if ((k in want) && (k in vps)) { if (!(k in done)) { print vps[k]; done[k] = 1 }; next }
      print }
    END { for (i = 1; i <= n; i++) { k = list[i]; if ((k in vps) && !(k in done)) print vps[k] } }
  ' "$2" "$1" > "$3"
}

# ---- The missing-key guard (PR-INFRA, 2026-11-27) ------------------------------------------------
# env_key_names FILE → the key names FILE sets, one per line (repeats as they come); never a value. Nothing when
# FILE cannot be read; a non-zero status when awk fails.
env_key_names() {
  [ -r "$1" ] || return 0
  LC_ALL=C awk "$KEY_AWK"'; { k = key($0); if (k != "") print k }' "$1"
}

# vps_key_names_cmd → the remote command that prints "FILE KEY" for every key line of every SECRET_FILES file on the
# VPS (never a value), "= FILE -" for a file that is not there, "= FILE N" for one that is, and "= end"; a non-zero
# status when ~/.secrets cannot be entered (sync-secrets.sh has just made it) or awk fails.
vps_key_names_cmd() {
  printf '%s' "cd ~/.secrets || exit 1; set --; for f in $SECRET_FILES; do if [ -e \"\$f\" ]; then set -- \"\$@\" \"\$f\"; else echo \"= \$f -\"; fi; done; if [ \$# -gt 0 ]; then LC_ALL=C awk '$KEY_AWK; { k = key(\$0); if (k != \"\") { print FILENAME, k; c[FILENAME]++ } } END { for (i = 1; i < ARGC; i++) print \"=\", ARGV[i], c[ARGV[i]] + 0 }' \"\$@\" || exit 1; fi; echo '= end'"
}

# vps_only_keys NAMES → "FILE KEY" for every key NAMES (vps_key_names_cmd's answer) lists that the PC copy of FILE
# does not set and that is not a kept key of FILE: the keys a copy would delete on the VPS. Names only, in the VPS's
# order. One awk per file reads both sides (key() for the PC file); status 1 when it fails: never "no keys" (Codex
# r1). No sort or other unchecked step in between (Codex r2).
vps_only_keys() {
  local f
  for f in $SECRET_FILES; do
    LC_ALL=C awk -v f="$f" -v kept="$(vps_keep_keys "$f")" -v names="$1" "$KEY_AWK"'
      BEGIN { n = split(kept, l, " "); for (i = 1; i <= n; i++) keep[l[i]] = 1 }
      FILENAME == names { if (NF == 2 && $1 == f && $2 ~ /^[A-Za-z_][A-Za-z0-9_]*$/ && !($2 in vps)) { vps[$2] = 1; order[++m] = $2 }; next }
      { k = key($0); if (k != "") pc[k] = 1 }
      END { for (i = 1; i <= m; i++) if (!(order[i] in pc) && !(order[i] in keep)) print f, order[i] }
    ' "$1" "$SECRETS_DIR/$f" || return 1
  done
}

# vps_reads_check DIR → 0 when sync-secrets.sh's two VPS reads in DIR are whole and look like what the commands above
# print. DIR/vps-names: only "FILE KEY" rows of SECRET_FILES files and records, one record per file, after its rows,
# with the right count, and "= end" last. DIR/keep.FILE: only lines that set a kept key of FILE (key()), the record of
# FILE with their count, and "= end" last. And the two reads agree: on whether FILE is there, and on its kept keys
# (the same names, the same number of lines). Otherwise 1, with the reason on stderr (counts and key names, never a
# line). A zero ssh exit alone proves nothing: a banner or a profile script on stdout, an answer that lost its tail,
# or a file that changed between the two reads would let the guard pass and the PC's values replace the VPS's own
# (Codex r1, r2). Every step's status is checked (it runs on the left of `||`, where errexit is off; Codex r2).
vps_reads_check() {
  local dir=$1 f why
  why=$(LC_ALL=C awk -v files="$SECRET_FILES" '
    BEGIN { n = split(files, l, " "); for (i = 1; i <= n; i++) known[l[i]] = 1 }
    why != "" { next }
    ended { why = "a line after the end marker"; next }
    $0 == "= end" { ended = 1; next }
    $1 == "=" && NF == 3 && $0 == "= " $2 " " $3 && ($2 in known) && ($3 == "-" || $3 ~ /^[0-9]+$/) {
      if ($2 in rec) why = "two records for " $2; else rec[$2] = $3; next }
    NF == 2 && $0 == $1 " " $2 && ($1 in known) && $2 ~ /^[A-Za-z_][A-Za-z0-9_]*$/ {
      if ($1 in rec) why = "a row of " $1 " after its record"; else rows[$1]++; next }
    { why = "line " NR " is not \"FILE KEY\" or a record" }
    END {
      if (why == "" && !ended) why = "no end marker (the answer is not whole)"
      for (i = 1; why == "" && i <= n; i++) {
        f = l[i]
        if (!(f in rec)) why = "no record for " f
        else if (rec[f] == "-" && rows[f] > 0) why = f " has rows but its record says it is not there"
        else if (rec[f] != "-" && rows[f] + 0 != rec[f] + 0) why = f " has " rows[f] + 0 " row(s), its record says " rec[f]
      }
      if (why != "") { print why; exit 1 }
    }' "$dir/vps-names") || { warn "the key-name read from the VPS: ${why:-awk failed}"; return 1; }
  for f in $VPS_KEEP_FILES; do
    why=$(LC_ALL=C awk -v f="$f" -v keys="$(vps_keep_keys "$f")" -v names="$dir/vps-names" "$KEY_AWK"'
      BEGIN { n = split(keys, l, " "); for (i = 1; i <= n; i++) want[l[i]] = 1 }
      FILENAME == names {
        if (NF == 2 && $1 == f && ($2 in want)) { listed[$2]++; nlisted++ }
        else if ($1 == "=" && $2 == f) there = ($3 != "-")
        next }
      why != "" { next }
      ended { why = "a line after the end marker"; next }
      $0 == "= end" { ended = 1; next }
      $1 == "=" && NF == 3 && $0 == "= " f " " $3 && ($3 == "-" || $3 ~ /^[0-9]+$/) {
        if (rec != "") why = "two records"; else rec = $3; next }
      { k = key($0)
        if (rec != "") why = "a line after its record"
        else if (k in want) { got[k]++; ngot++ }
        else why = "line " FNR " sets no kept key of " f }
      END {
        if (why == "" && !ended) why = "no end marker (the answer is not whole)"
        if (why == "" && rec == "") why = "no record for " f
        if (why == "" && rec == "-" && ngot > 0) why = "kept lines, but its record says the file is not there"
        if (why == "" && rec != "-" && ngot + 0 != rec + 0) why = ngot + 0 " kept line(s), its record says " rec
        if (why == "" && (rec != "-") != there) why = "the two reads disagree on whether " f " is there"
        for (i = 1; why == "" && i <= n; i++) if (listed[l[i]] + 0 != got[l[i]] + 0) {
          for (j = 1; j <= n; j++) { if (listed[l[j]]) a = a " " l[j]; if (got[l[j]]) b = b " " l[j] }
          why = "the two reads of the VPS'"'"'s " f " disagree on its kept keys (names:" a "; lines:" b ")"
        }
        if (why != "") { print why; exit 1 }
      }' "$dir/vps-names" "$dir/keep.$f") || { warn "the read of the VPS's own $f lines: ${why:-awk failed}"; return 1; }
  done
}

# kept_count KEEP_FILE FILE → N from the "= FILE N" record of a checked kept-lines answer (0 for "= FILE -").
kept_count() {
  LC_ALL=C awk -v f="$2" '$1 == "=" && $2 == f && NF == 3 { print ($3 == "-" ? 0 : $3) }' "$1"
}

# ---- The PC bona-api twin's WhatsApp drop-in (A2Z go-live item 7, 2026-11-19) -------------------
# The PC's bona-services.env keeps the owner's personal instance for bona-intake, so the twin that
# rollback.sh starts must load a later env file that names Bona's own instance and number
# (services/README.md, "The PC bona-api twin since the WhatsApp move"). A later EnvironmentFile=
# wins in systemd, and the process env wins over the files lib/env.mjs loads itself.
PC_WA_ENV="$SECRETS_DIR/bona-api-pc-wa.env"
PC_WA_DROPIN="$HOME_DIR/.config/systemd/user/bona-api.service.d/wa-own-number.conf"
PC_PERSONAL_INSTANCE=abdulaziz-personal   # lib/wa.mjs: the instance when BONA_WA_INSTANCE is unset

# ---- The PC bona-api twin's lock (owner decision 2026-11-19, "Lock the PC backup") --------------
# At the WhatsApp cutover (runbook B5a) the twin gets the drop-in bona-api.service.d/locked.conf,
# `AssertPathExists=!%h/.config/systemd/user/bona-api.service.d/LOCKED`, and that LOCKED file beside
# it. While the file exists systemd refuses every start of the unit (a reboot, `systemctl --user
# start`, any script, an older checkout's included), and install.sh and rollback.sh refuse before
# they write, stop or start anything. After the switch the fall-back is the VPS env (runbook R1),
# not this PC. Unlock only with the owner: rm the file (the drop-in alone changes nothing).
PC_TWIN_LOCK="$HOME_DIR/.config/systemd/user/bona-api.service.d/LOCKED"

# pc_twin_lock_check → returns when the twin is not locked; when it is, says why and dies.
pc_twin_lock_check() {
  [ -e "$PC_TWIN_LOCK" ] || return 0
  cat >&2 <<HELP
The PC bona-api twin is LOCKED ($PC_TWIN_LOCK).
Since the WhatsApp move it must not start, from this script or any other way: its env reads the
owner's personal WhatsApp (A2Z go-live item 7). The fall-back is the VPS, not this PC: the two env
lines back, then \`ssh $BONA_VPS_SSH sudo systemctl restart bona-api\` (cutover runbook R1).
Unlock only together with the owner: rm $PC_TWIN_LOCK
HELP
  die "refused: the PC bona-api twin is locked. Nothing was written, stopped, copied or started."
}

# env_value FILE KEY → prints KEY's value as lib/env.mjs parseEnvText reads it (the last KEY= line,
# `export ` stripped, one pair of quotes stripped); nothing when the file or the key is not there.
# For comparisons in this script only: never echo what it returns.
env_value() {
  [ -r "$1" ] || return 0
  awk -v k="$2" -v q="'" '
    { line = $0; sub(/\r$/, "", line); gsub(/^[ \t]+|[ \t]+$/, "", line)
      if (line == "" || substr(line, 1, 1) == "#") next
      if (substr(line, 1, 7) == "export ") { line = substr(line, 8); sub(/^[ \t]+/, "", line) }
      eq = index(line, "="); if (eq <= 1) next
      key = substr(line, 1, eq - 1); sub(/[ \t]+$/, "", key); if (key != k) next
      v = substr(line, eq + 1); gsub(/^[ \t]+|[ \t]+$/, "", v)
      f = substr(v, 1, 1); l = substr(v, length(v), 1)
      if (length(v) > 1 && f == l && (f == "\"" || f == q)) v = substr(v, 2, length(v) - 2)
      val = v; found = 1 }
    END { if (found) print val }' "$1"
}

# pc_wa_files → PC_WA_FILES = the PC bona-api unit's EnvironmentFiles, one path per line, in the
# order systemd reads them. 1 when systemctl cannot say, with the reason in PC_WA_WHY.
pc_wa_files() {
  PC_WA_FILES=
  if ! PC_WA_FILES=$(systemctl --user show bona-api -p EnvironmentFiles --value 2>/dev/null); then
    PC_WA_WHY="systemctl --user show bona-api failed"; return 1
  fi
  PC_WA_FILES=$(printf '%s\n' "$PC_WA_FILES" | sed 's/ (ignore_errors=[a-z]*)$//')
}

# pc_wa_dropin_ok → 0 when the PC bona-api unit loads $PC_WA_ENV after bona-services.env and that
# file sets BONA_WA_INSTANCE (not the owner's personal instance) and BONA_WA_INSTANCE_JID, both
# non-empty, the JID a phone JID by lib/wa.mjs PHONE_JID_RE (bona-api treats any other value as
# unset and falls back to the owner's number, "invalid" on /health). Otherwise 1, with the reason
# in PC_WA_WHY (paths only, never a value).
pc_wa_dropin_ok() {
  local files wa_at shared_at inst jid
  PC_WA_WHY=
  pc_wa_files || return 1
  files=$PC_WA_FILES
  wa_at=$(printf '%s\n' "$files" | grep -nxF "$PC_WA_ENV" | tail -n 1 | cut -d: -f1 || true)
  if [ -z "$wa_at" ]; then PC_WA_WHY="the PC bona-api unit does not load $PC_WA_ENV (no drop-in)"; return 1; fi
  shared_at=$(printf '%s\n' "$files" | grep -nxF "$SECRETS_DIR/bona-services.env" | tail -n 1 | cut -d: -f1 || true)
  if [ -n "$shared_at" ] && [ "$wa_at" -lt "$shared_at" ]; then
    PC_WA_WHY="$PC_WA_ENV is loaded before $SECRETS_DIR/bona-services.env, so it does not win"; return 1
  fi
  if [ ! -f "$PC_WA_ENV" ]; then PC_WA_WHY="$PC_WA_ENV is missing"; return 1; fi
  inst=$(env_value "$PC_WA_ENV" BONA_WA_INSTANCE)
  jid=$(env_value "$PC_WA_ENV" BONA_WA_INSTANCE_JID)
  if [ -z "$inst" ] || [ -z "$jid" ]; then
    PC_WA_WHY="$PC_WA_ENV does not set both BONA_WA_INSTANCE and BONA_WA_INSTANCE_JID"; return 1
  fi
  if [ "$inst" = "$PC_PERSONAL_INSTANCE" ]; then
    PC_WA_WHY="$PC_WA_ENV names the owner's personal instance"; return 1
  fi
  # Only systemd reads this file (EnvironmentFile=; lib/env.mjs never does). Every line must be blank, a
  # comment (# or ;), or one plain KEY=value on that line: no `export` (systemd ignores such a line), no
  # backslash or carriage return (escapes, continuation, a CR line break), and quotes only around the whole
  # value with none inside. Anything else systemd may read differently from env_value (Codex r1+r2, Claude r2).
  if awk -v q="'" '
      BEGIN { plain = "^[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*=[ \t]*([^\"" q "\\\\\r]*|\"[^\"\\\\\r]*\"|" q "[^" q "\\\\\r]*" q ")[ \t]*$" }
      { l = $0; sub(/\r$/, "", l)
        if (index(l, "\r")) { bad = 1; next }   # systemd ends a comment at a CR too: what follows is live
        if (l ~ /^[ \t]*$/ || l ~ /^[ \t]*[#;]/) next
        if (l !~ plain) bad = 1 }
      END { exit !bad }' "$PC_WA_ENV"; then
    PC_WA_WHY="$PC_WA_ENV has a line that is not a plain KEY=value (no export, no backslash, quotes only around the whole value), which systemd could read differently"; return 1
  fi
  # Same test as PHONE_JID_RE in services/api/lib/wa.mjs: digits[:device][@s.whatsapp.net], ASCII digits,
  # one line (grep -x matches line by line, so a newline is refused first).
  if [[ $jid == *$'\n'* ]] || ! printf '%s' "$jid" | LC_ALL=C grep -Eqx '[0-9]{8,15}(:[0-9]+)?(@s\.whatsapp\.net)?'; then
    PC_WA_WHY="$PC_WA_ENV sets BONA_WA_INSTANCE_JID to something that is not a phone JID (digits@s.whatsapp.net)"; return 1
  fi
}

# pc_wa_dropin_help → stderr: how to give the twin its drop-in (as in services/README.md).
pc_wa_dropin_help() {
  cat >&2 <<HELP
The PC bona-api twin would poll and send from the owner's personal WhatsApp ($PC_PERSONAL_INSTANCE)
while the site sends clients to Bona's own number, which nothing on the PC would read (A2Z go-live
item 7). See services/README.md, "The PC bona-api twin since the WhatsApp move". Give it a drop-in:

  # $PC_WA_DROPIN
  [Service]
  EnvironmentFile=%h/.secrets/bona-api-pc-wa.env

  # $PC_WA_ENV (mode 0600)
  BONA_WA_INSTANCE=bona2
  BONA_WA_INSTANCE_JID=966576267694@s.whatsapp.net

then \`systemctl --user daemon-reload\` and run this again. Only when the VPS env and the site are
back on the personal number (runbook R1 + R2): run it with --personal-instance
HELP
}

# pc_wa_preflight PERSONAL → the PC bona-api twin's WhatsApp route, checked before the caller stops,
# copies or starts anything (A2Z go-live item 7); dies with the reason (paths only, never a value).
#   PERSONAL=0  the unit must load the Bona drop-in (pc_wa_dropin_ok).
#   PERSONAL=1  (--personal-instance) the unit must NOT load $PC_WA_ENV: after R1 + R2 the twin would
#               otherwise still poll and send through Bona's instance while the site and the VPS are
#               back on the owner's number (Codex review r1, 2026-11-19).
pc_wa_preflight() {
  PC_WA_WHY=
  if [ "$1" != 1 ]; then
    pc_wa_dropin_ok && return 0
    pc_wa_dropin_help
    die "refused: $PC_WA_WHY. Nothing was stopped, copied or started."
  fi
  pc_wa_files || die "refused: $PC_WA_WHY, so the route --personal-instance asks for cannot be checked. Nothing was stopped, copied or started."
  if printf '%s\n' "$PC_WA_FILES" | grep -qxF "$PC_WA_ENV"; then
    cat >&2 <<HELP
--personal-instance: the PC bona-api unit still loads $PC_WA_ENV, so it would poll and
send through Bona's own instance while the site and the VPS are back on the owner's personal number.
Take the drop-in away first (services/README.md, "The PC bona-api twin since the WhatsApp move"):

  rm $PC_WA_DROPIN
  systemctl --user daemon-reload

then run this again with --personal-instance.
HELP
    die "refused: the Bona drop-in is still active. Nothing was stopped, copied or started."
  fi
  warn "--personal-instance: the PC bona-api will poll and send from the owner's personal WhatsApp ($PC_PERSONAL_INSTANCE). A2Z go-live item 7 is undone; the site must be back on that number too (runbook R1 + R2)."
}

# render TEMPLATE  → stdout, with every @PLACEHOLDER@ substituted; refuses to leave one behind.
# Bash parameter substitution, not sed: a `|` or `&` in a value would break or corrupt a sed
# expression. The replacements are quoted because bash ≥ 5.2 (patsub_replacement) would otherwise
# expand an unquoted `&` to the matched placeholder.
render() {
  local out
  [ -f "$1" ] || die "template missing: $1"
  out=$(<"$1")
  out=${out//@HOME@/"$HOME_DIR"}
  out=${out//@USER@/"$VPS_USER"}
  out=${out//@REPO@/"$BONA_VPS_REPO"}
  out=${out//@PORT@/"$BONA_VPS_PORT"}
  out=${out//@NODE_BIN@/"$NODE_BIN"}
  out=${out//@TUNNEL_ID@/"$BONA_TUNNEL_ID"}
  out=${out//@EVOLUTION_URL@/"$BONA_VPS_EVOLUTION_URL"}
  out=${out//@GIT@/"$GIT_BIN"}
  if printf '%s\n' "$out" | grep '@[A-Z_][A-Z_]*@' >/dev/null; then die "unrendered placeholder in $1"; fi
  printf '%s\n' "$out"
}

# render_tunnel_config → stdout: the cloudflared ingress for every hostname → the local API port.
render_tunnel_config() {
  local h
  echo "# Managed by services/deploy/vps/install-vps.sh — re-running rewrites this file."
  echo "tunnel: $BONA_TUNNEL_ID"
  echo "credentials-file: $CF_DIR/$BONA_TUNNEL_ID.json"
  echo
  echo "ingress:"
  for h in $BONA_HOSTNAMES; do
    printf '  - hostname: %s\n    service: http://127.0.0.1:%s\n    originRequest:\n      connectTimeout: 10s\n' "$h" "$BONA_VPS_PORT"
  done
  echo "  - service: http_status:404"
}

# wait_for TRIES SLEEP_SECONDS CMD... → runs CMD until it succeeds; returns 1 after TRIES attempts.
wait_for() {
  local tries=$1 pause=$2 i; shift 2
  for ((i = 1; i <= tries; i++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep "$((pause * BONA_WAIT_SCALE))"
  done
  return 1
}

# count_leads NODE_BINARY DB_FILE → prints the number of rows in `leads` (read-only; WAL-safe).
count_leads() {
  "$1" -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); console.log(db.prepare("select count(*) as n from leads").get().n)' "$2"
}

# vps_count_leads → prints the number of rows in `leads` of ~/bona-data/bona.db ON THE VPS, using the
# pinned node there (read-only). Needs the caller's `vps` ssh wrapper. Used as the copy-integrity
# check in both directions: cutover.sh (PC → VPS) and rollback.sh --copy-back (VPS → PC).
vps_count_leads() {
  vps "$REMOTE_NODE -e 'const {DatabaseSync}=require(\"node:sqlite\");const db=new DatabaseSync(process.argv[1],{readOnly:true});console.log(db.prepare(\"select count(*) as n from leads\").get().n)' ~/bona-data/bona.db"
}

# vps_units_stopped → over ssh: disable + stop every VPS unit, then VERIFY the API and the tunnel
# connector are inactive. Returns non-zero when ssh fails or a unit is still active — and then the
# caller must NOT start the PC units (fail closed: two APIs or two connectors is the one thing the
# move must never produce). Needs the caller's `vps` ssh wrapper. The units are system units, so
# every systemctl in the remote string is $VPS_SYSTEMCTL (sudo -n systemctl).
vps_units_stopped() {
  vps "$VPS_SYSTEMCTL disable --now $VPS_UNITS" || return 1
  vps "! $VPS_SYSTEMCTL is-active --quiet bona-api && ! $VPS_SYSTEMCTL is-active --quiet cloudflared-bona"
}

# fail_closed → the VPS units could not be verified inactive: say so loudly, print the manual
# commands in the order to run them, start NOTHING on the PC, exit 1.
fail_closed() {
  cat >&2 <<EOF

!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
!!  The VPS units could NOT be verified inactive (ssh failed, or a unit is still active).
!!  NOTHING was started on this PC: a second API or a second tunnel connector must never run.
!!  Finish the rollback by hand, in this order:
!!    1. ssh $BONA_VPS_SSH $VPS_SYSTEMCTL disable --now $VPS_UNITS
!!    2. ssh $BONA_VPS_SSH $VPS_SYSTEMCTL is-active bona-api cloudflared-bona   # both: inactive
!!    3. systemctl --user enable --now bona-api cloudflared-bona                # PC: user units
!!    4. curl -fsS $BONA_PUBLIC_HEALTH
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

EOF
  exit 1
}
