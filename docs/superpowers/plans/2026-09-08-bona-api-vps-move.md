# bona-api → VPS move — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Dana's API (`bona-api`) on the VPS instead of the owner's PC, same hostnames and data, with a one-command deploy, and stop/disable the PC copy.

**Architecture:** New `services/deploy/vps/` holds one shared `lib.sh` (constants + helpers), unit/tunnel templates, an idempotent VPS installer, a deploy script, and PC-side `sync-secrets.sh` / `cutover.sh` / `rollback.sh`. The VPS runs the repo's hardened `systemctl --user` units under `azoz` with a pinned Node 24 tarball and a `cloudflared` connector for the **existing** tunnel `bona` (no DNS/Caddy change). A timer pulls the sparse repo checkout every 5 min so inventory follows the WhatsApp intake. Spec: `docs/superpowers/specs/2026-09-08-bona-api-vps-move-design.md`.

**Tech Stack:** bash (set -euo pipefail), systemd user units, cloudflared 2026.8.3, Node 24.19.0 (`node:sqlite`), `node --test` for tests. No new npm dependencies.

**Working copy:** `~/bona-wt/api-vps` on branch `feat/api-vps` (never edit `~/bona` — the PC service runs from that tree). Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

**Facts every task relies on** (from the 2026-09-08 surveys):
- VPS ssh alias `hermes-vps`, user `azoz` (uid 1001), passwordless sudo, linger already on, only Node 20 system-wide (must stay), port 4102 taken → API port on the VPS is **4120**, Evolution API local at `http://127.0.0.1:8085`.
- Tunnel id `9022fbec-de4f-44b9-805e-8fff285d6263`, name `bona`, hostnames `api.bona-real-estate.com bona-api.azoz.uk bona.azoz.uk`, credentials JSON at `~/.cloudflared/9022fbec-de4f-44b9-805e-8fff285d6263.json` on the PC.
- Node 24.19.0 linux-x64 tarball SHA256 `14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647`; cloudflared 2026.8.3 `cloudflared-linux-amd64` SHA256 `f29324fe934d1e100617484c78deef803c4dc2cd351d645bbde42e96b4fccc5e` (from the GitHub release notes).
- The API reads `services/**` and `src/data/{site,listings}.json` only; `lib/env.mjs` loads `~/.secrets/{retell,evolution-api,bona-services,bona-marketing}.env` and `process.env` wins. The `leads` table lives in `~/bona-data/bona.db` (WAL).

---

## File structure

```
services/deploy/vps/
  lib.sh                          constants (tunnel, hostnames, port, versions+SHA256), say/ok/warn/die, render(), render_tunnel_config(), wait_for(), count_leads()
  templates/bona-api.service.in   hardened unit, @HOME@ @REPO@ @PORT@ @NODE_BIN@ @EVOLUTION_URL@ placeholders
  templates/cloudflared-bona.service.in
  templates/bona-repo-sync.service.in
  templates/bona-repo-sync.timer
  install-vps.sh                  ON THE VPS: node, cloudflared, /opt/bona sparse clone, dirs, render units + bona.yml; --check / --render-only DIR / --smoke
  deploy.sh                       ON THE VPS: pull, test, restart, health
  sync-secrets.sh                 ON THE PC: copy the 4 env files + tunnel credentials to the VPS
  cutover.sh                      ON THE PC: stop PC → copy data → start VPS api → start VPS tunnel → disable PC; auto-rollback; --dry-run
  rollback.sh                     ON THE PC: stop VPS units, optional --copy-back, start + enable PC units
services/api/test/vps-deploy.test.mjs   renders templates, checks constants, bash -n, --check exit code, --dry-run, secret scan
services/README.md                      §6 install + §8 runbook: runtime is on the VPS
```

---

### Task 1: `lib.sh` + templates + rendering test

**Files:**
- Create: `services/deploy/vps/lib.sh`
- Create: `services/deploy/vps/templates/bona-api.service.in`
- Create: `services/deploy/vps/templates/cloudflared-bona.service.in`
- Create: `services/deploy/vps/templates/bona-repo-sync.service.in`
- Create: `services/deploy/vps/templates/bona-repo-sync.timer`
- Test: `services/api/test/vps-deploy.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// services/api/test/vps-deploy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VPS = path.resolve(HERE, '../../deploy/vps');
const SCRIPTS = ['lib.sh', 'install-vps.sh', 'deploy.sh', 'sync-secrets.sh', 'cutover.sh', 'rollback.sh'];

function bash(args, opts = {}) {
  return spawnSync('bash', args, { encoding: 'utf8', env: { PATH: process.env.PATH, ...opts.env }, cwd: VPS });
}

test('every script parses (bash -n)', () => {
  for (const s of SCRIPTS) {
    const r = bash(['-n', path.join(VPS, s)]);
    assert.equal(r.status, 0, `${s}: ${r.stderr}`);
  }
});

test('lib.sh pins versions with real checksums and the three public hostnames', () => {
  const lib = readFileSync(path.join(VPS, 'lib.sh'), 'utf8');
  assert.match(lib, /^NODE_VERSION=v24\.19\.0$/m);
  assert.match(lib, /^NODE_SHA256=[0-9a-f]{64}$/m);
  assert.match(lib, /^CLOUDFLARED_VERSION=2026\.8\.3$/m);
  assert.match(lib, /^CLOUDFLARED_SHA256=[0-9a-f]{64}$/m);
  assert.match(lib, /^BONA_TUNNEL_ID=9022fbec-de4f-44b9-805e-8fff285d6263$/m);
  for (const h of ['api.bona-real-estate.com', 'bona-api.azoz.uk', 'bona.azoz.uk']) assert.ok(lib.includes(h), h);
  assert.match(lib, /^BONA_VPS_PORT=4120$/m);
});

test('install-vps.sh --render-only renders units and tunnel config for the VPS', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'bona-home-'));
  const out = mkdtempSync(path.join(tmpdir(), 'bona-render-'));
  const r = bash([path.join(VPS, 'install-vps.sh'), '--render-only', out], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr + r.stdout);

  const api = readFileSync(path.join(out, 'bona-api.service'), 'utf8');
  assert.match(api, /^Environment=BONA_API_PORT=4120$/m);
  assert.match(api, /^Environment=BONA_REPO=\/opt\/bona$/m);
  assert.match(api, new RegExp(`^Environment=BONA_DATA=${home}/bona-data$`, 'm'));
  assert.match(api, /^Environment=EVOLUTION_API_URL=http:\/\/127\.0\.0\.1:8085$/m);
  assert.match(api, new RegExp(`^ExecStart=${home}/\\.local/opt/node-v24\\.19\\.0-linux-x64/bin/node /opt/bona/services/api/index\\.mjs$`, 'm'));
  assert.match(api, /^WorkingDirectory=\/opt\/bona\/services$/m);
  assert.match(api, new RegExp(`^ReadWritePaths=${home}/bona-data$`, 'm'));
  assert.doesNotMatch(api, /^Environment=.*BONA_WA_POLL/m, 'the unit must never force the poller on or off');
  assert.doesNotMatch(api, /@[A-Z_]+@/, 'unrendered placeholder');

  const cf = readFileSync(path.join(out, 'cloudflared-bona.service'), 'utf8');
  assert.match(cf, /--no-autoupdate/);
  assert.match(cf, /tunnel run 9022fbec-de4f-44b9-805e-8fff285d6263$/m);
  assert.match(cf, /^After=.*bona-api\.service/m);

  const sync = readFileSync(path.join(out, 'bona-repo-sync.service'), 'utf8');
  assert.match(sync, /^ExecStart=\/usr\/bin\/git -C \/opt\/bona pull --ff-only --quiet$/m);
  const timer = readFileSync(path.join(out, 'bona-repo-sync.timer'), 'utf8');
  assert.match(timer, /^OnUnitActiveSec=5min$/m);
  assert.match(timer, /^Persistent=true$/m);

  const yml = readFileSync(path.join(out, 'bona.yml'), 'utf8');
  assert.match(yml, /^tunnel: 9022fbec-de4f-44b9-805e-8fff285d6263$/m);
  assert.match(yml, new RegExp(`^credentials-file: ${home}/\\.cloudflared/9022fbec-de4f-44b9-805e-8fff285d6263\\.json$`, 'm'));
  for (const h of ['api.bona-real-estate.com', 'bona-api.azoz.uk', 'bona.azoz.uk']) assert.match(yml, new RegExp(`^  - hostname: ${h.replace(/\./g, '\\.')}$`, 'm'), h);
  assert.equal((yml.match(/service: http:\/\/127\.0\.0\.1:4120/g) || []).length, 3);
  assert.match(yml.trimEnd(), /- service: http_status:404$/);
  for (const f of readdirSync(out)) assert.equal(statSync(path.join(out, f)).mode & 0o777, 0o600, `${f} mode`);
});

test('install-vps.sh --check on an empty HOME reports what is missing and exits 2', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'bona-home-'));
  const r = bash([path.join(VPS, 'install-vps.sh'), '--check'], { env: { HOME: home, BONA_VPS_REPO: path.join(home, 'repo') } });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  for (const s of ['retell.env', 'evolution-api.env', 'bona-services.env', 'bona-marketing.env', '9022fbec-de4f-44b9-805e-8fff285d6263.json', 'node', 'cloudflared', 'bona-api.service']) {
    assert.ok(r.stdout.includes(s), `--check should mention ${s}\n${r.stdout}`);
  }
});

test('cutover.sh --dry-run prints the five steps and touches nothing', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'bona-home-'));
  const r = bash([path.join(VPS, 'cutover.sh'), '--dry-run'], { env: { HOME: home, BONA_VPS_SSH: 'ssh-must-not-be-called' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const s of ['stop', 'copy', 'start bona-api', 'start cloudflared-bona', 'disable']) assert.ok(r.stdout.toLowerCase().includes(s), s);
  assert.equal(readdirSync(home).length, 0, 'dry run must not create files');
});

test('no script under deploy/vps carries a secret-looking value', () => {
  for (const f of readdirSync(VPS)) {
    const p = path.join(VPS, f);
    if (!statSync(p).isFile()) continue;
    const text = readFileSync(p, 'utf8');
    assert.doesNotMatch(text, /(key|token|secret|password)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{24,}/i, f);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/bona-wt/api-vps/services && node --test api/test/vps-deploy.test.mjs`
Expected: FAIL — `bash -n` cannot find `lib.sh` (ENOENT / status 127) and the render test fails because `install-vps.sh` does not exist.

- [ ] **Step 3: Create `lib.sh`**

```bash
# services/deploy/vps/lib.sh — shared by every script in this directory. Sourced, never executed.
# Constants first (override any of them from the environment), then small helpers. Never echo a secret.

BONA_TUNNEL_ID=${BONA_TUNNEL_ID:-9022fbec-de4f-44b9-805e-8fff285d6263}
BONA_TUNNEL_NAME=${BONA_TUNNEL_NAME:-bona}
# One entry per public hostname; all of them proxy to the same local port. Keep the legacy
# hostnames: brochure QR codes and indexed links point at them (memory 2026-09-08).
BONA_HOSTNAMES=${BONA_HOSTNAMES:-"api.bona-real-estate.com bona-api.azoz.uk bona.azoz.uk"}
BONA_VPS_PORT=${BONA_VPS_PORT:-4120}                 # 4102 is taken on the VPS (obsidian-mcp)
BONA_VPS_REPO=${BONA_VPS_REPO:-/opt/bona}
BONA_REPO_URL=${BONA_REPO_URL:-https://github.com/azoz778/bona}
BONA_VPS_EVOLUTION_URL=${BONA_VPS_EVOLUTION_URL:-http://127.0.0.1:8085}   # the same Evolution API as wa-api.azoz.uk, one hop shorter
BONA_VPS_SSH=${BONA_VPS_SSH:-hermes-vps}
BONA_PUBLIC_HEALTH=${BONA_PUBLIC_HEALTH:-https://api.bona-real-estate.com/health}

NODE_VERSION=v24.19.0
NODE_SHA256=14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647
CLOUDFLARED_VERSION=2026.8.3
CLOUDFLARED_SHA256=f29324fe934d1e100617484c78deef803c4dc2cd351d645bbde42e96b4fccc5e

SECRET_FILES="retell.env evolution-api.env bona-services.env bona-marketing.env"
DATA_FILES="bona.db bona.db-wal bona.db-shm leads.jsonl chats.jsonl calls.jsonl"
UNITS="bona-api.service cloudflared-bona.service bona-repo-sync.service bona-repo-sync.timer"

HOME_DIR=${HOME:?HOME is not set}
NODE_DIR="$HOME_DIR/.local/opt/node-$NODE_VERSION-linux-x64"
NODE_BIN="$NODE_DIR/bin"
CLOUDFLARED_BIN="$HOME_DIR/.local/bin/cloudflared"
# For commands sent over ssh: the VPS home differs from the PC home, so let the REMOTE shell expand ~.
REMOTE_NODE='~/.local/opt/node-'"$NODE_VERSION"'-linux-x64/bin/node'
UNIT_DIR="$HOME_DIR/.config/systemd/user"
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

# render TEMPLATE  → stdout, with every @PLACEHOLDER@ substituted; refuses to leave one behind.
render() {
  local out
  out=$(sed -e "s|@HOME@|$HOME_DIR|g" -e "s|@REPO@|$BONA_VPS_REPO|g" -e "s|@PORT@|$BONA_VPS_PORT|g" \
            -e "s|@NODE_BIN@|$NODE_BIN|g" -e "s|@TUNNEL_ID@|$BONA_TUNNEL_ID|g" \
            -e "s|@EVOLUTION_URL@|$BONA_VPS_EVOLUTION_URL|g" "$1")
  if printf '%s\n' "$out" | grep -q '@[A-Z_][A-Z_]*@'; then die "unrendered placeholder in $1"; fi
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
    sleep "$pause"
  done
  return 1
}

# count_leads NODE_BINARY DB_FILE → prints the number of rows in `leads` (read-only; WAL-safe).
count_leads() {
  "$1" -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); console.log(db.prepare("select count(*) as n from leads").get().n)' "$2"
}
```

- [ ] **Step 4: Create the four templates**

`services/deploy/vps/templates/bona-api.service.in` — the repo's `services/deploy/bona-api.service` with the VPS paths; keep every hardening line:

```ini
[Unit]
Description=Bona concierge API (Dana) — chat, web calls, Retell tools, WhatsApp poller, dashboard
Documentation=https://github.com/azoz778/bona/blob/main/services/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# Secrets are read by the process itself from ~/.secrets/*.env (lib/env.mjs); these two files
# are optional so the unit starts either way.
EnvironmentFile=-@HOME@/.secrets/bona-services.env
EnvironmentFile=-@HOME@/.secrets/bona-marketing.env
Environment=NODE_ENV=production
# VPS-only overrides. process.env wins over the env files by design (lib/env.mjs), so the
# PC paths carried inside bona-services.env are harmless here.
Environment=BONA_API_PORT=@PORT@
Environment=BONA_REPO=@REPO@
Environment=BONA_DATA=@HOME@/bona-data
Environment=EVOLUTION_API_URL=@EVOLUTION_URL@
# The WhatsApp poller runs inside this process and is ON by default (lib/config.mjs). Set
# BONA_WA_POLL=0 in bona-services.env to stop it — and nothing here may set it: an Environment=
# line after EnvironmentFile= would win over the file and silently re-enable the poller
# (Codex review, 2026-09-08).
Environment=PATH=@NODE_BIN@:@HOME@/.local/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=@REPO@/services
ExecStart=@NODE_BIN@/node @REPO@/services/api/index.mjs
Restart=always
RestartSec=5
TimeoutStopSec=15
KillSignal=SIGTERM

StandardOutput=journal
StandardError=journal
SyslogIdentifier=bona-api

# Reads the repo (@REPO@, read-only under ProtectSystem=strict) and ~/.secrets; writes one directory.
PrivateTmp=true
NoNewPrivileges=true
ProtectHostname=true
RestrictSUIDSGID=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=@HOME@/bona-data
PrivateDevices=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictNamespaces=true
RestrictRealtime=true
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
MemoryMax=512M

[Install]
WantedBy=default.target
```

`services/deploy/vps/templates/cloudflared-bona.service.in`:

```ini
[Unit]
Description=Cloudflare tunnel "bona" — api.bona-real-estate.com (+ legacy hosts) -> 127.0.0.1:@PORT@
Documentation=https://github.com/azoz778/bona/blob/main/services/README.md
After=network-online.target bona-api.service
Wants=network-online.target

[Service]
Type=simple
Environment=PATH=@HOME@/.local/bin:/usr/local/bin:/usr/bin:/bin
# Run by tunnel ID, not name: name lookup picked the wrong tunnel on the PC once (2026-09-08).
ExecStart=@HOME@/.local/bin/cloudflared --no-autoupdate --config @HOME@/.cloudflared/bona.yml tunnel run @TUNNEL_ID@
Restart=always
RestartSec=10
TimeoutStopSec=15

StandardOutput=journal
StandardError=journal
SyslogIdentifier=cloudflared-bona

NoNewPrivileges=true
MemoryMax=256M

[Install]
WantedBy=default.target
```

`services/deploy/vps/templates/bona-repo-sync.service.in`:

```ini
[Unit]
Description=Bona: pull the repo so Dana's inventory follows the WhatsApp intake
Documentation=https://github.com/azoz778/bona/blob/main/services/README.md
After=network-online.target

[Service]
Type=oneshot
# Fast-forward only: the checkout is never edited by hand. The running API hot-reloads
# src/data/listings.json on mtime; code changes on disk take effect at the next restart (deploy.sh).
ExecStart=/usr/bin/git -C @REPO@ pull --ff-only --quiet
StandardOutput=journal
StandardError=journal
SyslogIdentifier=bona-repo-sync
```

`services/deploy/vps/templates/bona-repo-sync.timer` (no placeholders):

```ini
[Unit]
Description=Bona: pull the repo every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
RandomizedDelaySec=30
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 5: Run the tests**

Run: `cd ~/bona-wt/api-vps/services && node --test api/test/vps-deploy.test.mjs`
Expected: the `lib.sh` constants test PASSES; `bash -n` still FAILS for the five missing scripts; render/check/dry-run tests FAIL (no `install-vps.sh` yet). That is the expected state after Task 1.

- [ ] **Step 6: Commit**

```bash
cd ~/bona-wt/api-vps && git add services/deploy/vps/lib.sh services/deploy/vps/templates services/api/test/vps-deploy.test.mjs
git commit -m "deploy(vps): shared constants, unit and tunnel templates, deploy tests

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `install-vps.sh`

**Files:**
- Create: `services/deploy/vps/install-vps.sh` (mode 755)
- Test: `services/api/test/vps-deploy.test.mjs` (already written)

- [ ] **Step 1: Run the render and check tests to see them fail**

Run: `cd ~/bona-wt/api-vps/services && node --test --test-name-pattern="install-vps" api/test/vps-deploy.test.mjs`
Expected: FAIL (`install-vps.sh` missing).

- [ ] **Step 2: Write `install-vps.sh`**

```bash
#!/usr/bin/env bash
# Provision THIS machine (the VPS, as the service user) to run bona-api. Idempotent; safe to re-run.
#
#   install-vps.sh                 install/upgrade node + cloudflared, clone/refresh /opt/bona (sparse),
#                                  create dirs, render units + ~/.cloudflared/bona.yml, daemon-reload.
#                                  Enables NOTHING and starts NOTHING — cutover.sh does that, on purpose:
#                                  a second running copy of the API or of the tunnel is the one thing
#                                  this move must never produce.
#   install-vps.sh --check         report what is still missing (exit 0 = ready, 2 = not yet); no changes.
#   install-vps.sh --render-only D render units + bona.yml into directory D only (tests use this).
#   install-vps.sh --smoke         start the API in the foreground for 15 s on a throw-away port and
#                                  data dir with the poller OFF, curl /health, stop. Proves node:sqlite,
#                                  secrets and the sparse checkout without touching real data.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"

MODE=install
RENDER_DIR=""
case "${1:-}" in
  "" | --install) ;;
  --check) MODE=check ;;
  --render-only) MODE=render; RENDER_DIR=${2:?usage: install-vps.sh --render-only DIR} ;;
  --smoke) MODE=smoke ;;
  *) die "usage: install-vps.sh [--check | --render-only DIR | --smoke]" ;;
esac

# ---------------------------------------------------------------- render (pure; used by every mode)
render_all() { # render_all DIR
  local dir=$1 u
  install -d -m 700 "$dir"
  for u in bona-api.service cloudflared-bona.service bona-repo-sync.service; do
    render "$TEMPLATE_DIR/$u.in" > "$dir/$u.tmp" && install -m 600 "$dir/$u.tmp" "$dir/$u" && rm -f "$dir/$u.tmp"
  done
  install -m 600 "$TEMPLATE_DIR/bona-repo-sync.timer" "$dir/bona-repo-sync.timer"
  render_tunnel_config > "$dir/bona.yml.tmp" && install -m 600 "$dir/bona.yml.tmp" "$dir/bona.yml" && rm -f "$dir/bona.yml.tmp"
}

if [ "$MODE" = render ]; then
  render_all "$RENDER_DIR"
  ok "rendered into $RENDER_DIR"
  exit 0
fi

# ---------------------------------------------------------------- check (read-only)
check_state() { # prints one line per item; returns the number of missing items
  local missing=0 f u
  item() { if "$@"; then ok "$_label"; else warn "MISSING: $_label"; missing=$((missing + 1)); fi; }
  _label="node $NODE_VERSION at $NODE_BIN/node";            item test -x "$NODE_BIN/node"
  _label="node reports $NODE_VERSION";                       item bash -c "[ -x '$NODE_BIN/node' ] && [ \"\$('$NODE_BIN/node' -v)\" = '$NODE_VERSION' ]"
  _label="node:sqlite loads";                                item bash -c "[ -x '$NODE_BIN/node' ] && '$NODE_BIN/node' -e 'require(\"node:sqlite\")'"
  _label="cloudflared $CLOUDFLARED_VERSION at $CLOUDFLARED_BIN"; item bash -c "[ -x '$CLOUDFLARED_BIN' ] && '$CLOUDFLARED_BIN' --version 2>/dev/null | grep -q '$CLOUDFLARED_VERSION'"
  _label="repo checkout $BONA_VPS_REPO (services/api/index.mjs)"; item test -f "$BONA_VPS_REPO/services/api/index.mjs"
  _label="repo has src/data/listings.json";                  item test -f "$BONA_VPS_REPO/src/data/listings.json"
  _label="repo has src/data/site.json";                      item test -f "$BONA_VPS_REPO/src/data/site.json"
  _label="repo has services/api/retell/ids.json";            item test -f "$BONA_VPS_REPO/services/api/retell/ids.json"
  for f in $SECRET_FILES; do _label="secret file $SECRETS_DIR/$f (0600)"; item bash -c "[ -f '$SECRETS_DIR/$f' ] && [ \"\$(stat -c %a '$SECRETS_DIR/$f')\" = 600 ]"; done
  _label="tunnel credentials $CF_DIR/$BONA_TUNNEL_ID.json (0600)"; item bash -c "[ -f '$CF_DIR/$BONA_TUNNEL_ID.json' ] && [ \"\$(stat -c %a '$CF_DIR/$BONA_TUNNEL_ID.json')\" = 600 ]"
  _label="tunnel config $CF_DIR/bona.yml";                   item test -f "$CF_DIR/bona.yml"
  _label="data dir $DATA_DIR (0700)";                        item bash -c "[ -d '$DATA_DIR' ] && [ \"\$(stat -c %a '$DATA_DIR')\" = 700 ]"
  for u in $UNITS; do _label="unit $UNIT_DIR/$u"; item test -f "$UNIT_DIR/$u"; done
  _label="linger enabled for $(id -un)";                     item bash -c "command -v loginctl >/dev/null && loginctl show-user '$(id -un)' -p Linger 2>/dev/null | grep -q '=yes'"
  return "$missing"
}

if [ "$MODE" = check ]; then
  say "Checking $(hostname) for bona-api"
  if check_state; then ok "ready: nothing missing"; exit 0; fi
  warn "not ready — see MISSING lines above (copy secrets with sync-secrets.sh from the PC; the rest is install-vps.sh)"
  exit 2
fi

# ---------------------------------------------------------------- smoke
if [ "$MODE" = smoke ]; then
  need curl
  [ -x "$NODE_BIN/node" ] || die "run install-vps.sh first (node missing)"
  [ -f "$BONA_VPS_REPO/services/api/index.mjs" ] || die "run install-vps.sh first (repo missing)"
  tmp=$(mktemp -d) ; port=$((BONA_VPS_PORT + 1))
  say "Smoke: API on 127.0.0.1:$port, data in $tmp, poller OFF, 15 s"
  ( cd "$BONA_VPS_REPO/services" && BONA_API_PORT=$port BONA_DATA=$tmp BONA_REPO=$BONA_VPS_REPO BONA_WA_POLL=0 \
      EVOLUTION_API_URL=$BONA_VPS_EVOLUTION_URL NODE_ENV=production "$NODE_BIN/node" api/index.mjs ) &
  pid=$!
  if wait_for 15 1 curl -fsS "http://127.0.0.1:$port/health"; then
    curl -sS "http://127.0.0.1:$port/health"; echo
    ok "smoke passed"
    rc=0
  else
    warn "smoke FAILED: /health never answered"; rc=1
  fi
  kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
  rm -rf "$tmp"
  exit "$rc"
fi

# ---------------------------------------------------------------- install
need curl; need sha256sum; need tar; need git; need systemctl
say "Node $NODE_VERSION"
if [ -x "$NODE_BIN/node" ] && [ "$("$NODE_BIN/node" -v)" = "$NODE_VERSION" ]; then
  ok "already installed"
else
  tmp=$(mktemp -d)
  tarball="node-$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL --retry 3 -o "$tmp/$tarball" "https://nodejs.org/dist/$NODE_VERSION/$tarball"
  echo "$NODE_SHA256  $tmp/$tarball" | sha256sum -c - >/dev/null || die "node tarball checksum mismatch"
  install -d "$HOME_DIR/.local/opt"
  tar -xJf "$tmp/$tarball" -C "$HOME_DIR/.local/opt"
  rm -rf "$tmp"
  [ "$("$NODE_BIN/node" -v)" = "$NODE_VERSION" ] || die "node did not install correctly"
  ok "installed to $NODE_DIR"
fi
"$NODE_BIN/node" -e 'require("node:sqlite")' || die "node:sqlite is not available in $NODE_VERSION"

say "cloudflared $CLOUDFLARED_VERSION"
if [ -x "$CLOUDFLARED_BIN" ] && "$CLOUDFLARED_BIN" --version 2>/dev/null | grep -q "$CLOUDFLARED_VERSION"; then
  ok "already installed"
else
  tmp=$(mktemp -d)
  curl -fsSL --retry 3 -o "$tmp/cloudflared" "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-linux-amd64"
  echo "$CLOUDFLARED_SHA256  $tmp/cloudflared" | sha256sum -c - >/dev/null || die "cloudflared checksum mismatch"
  install -d "$HOME_DIR/.local/bin"
  install -m 755 "$tmp/cloudflared" "$CLOUDFLARED_BIN"
  rm -rf "$tmp"
  ok "installed to $CLOUDFLARED_BIN ($("$CLOUDFLARED_BIN" --version 2>/dev/null | head -1))"
fi

say "Repo checkout $BONA_VPS_REPO (sparse: services + src/data)"
if [ ! -d "$BONA_VPS_REPO/.git" ]; then
  if [ ! -d "$BONA_VPS_REPO" ]; then
    sudo -n install -d -o "$(id -un)" -g "$(id -gn)" -m 755 "$BONA_VPS_REPO" || die "cannot create $BONA_VPS_REPO (needs passwordless sudo once)"
  fi
  git clone --quiet --filter=blob:none --no-checkout "$BONA_REPO_URL" "$BONA_VPS_REPO"
  git -C "$BONA_VPS_REPO" sparse-checkout init --cone
  git -C "$BONA_VPS_REPO" sparse-checkout set services src/data
  git -C "$BONA_VPS_REPO" checkout --quiet main
  ok "cloned"
else
  git -C "$BONA_VPS_REPO" sparse-checkout set services src/data
  git -C "$BONA_VPS_REPO" pull --ff-only --quiet
  ok "refreshed ($(git -C "$BONA_VPS_REPO" rev-parse --short HEAD))"
fi
for f in services/api/index.mjs src/data/listings.json src/data/site.json services/api/retell/ids.json; do
  [ -f "$BONA_VPS_REPO/$f" ] || die "sparse checkout is missing $f"
done

say "Directories"
install -d -m 700 "$DATA_DIR" "$SECRETS_DIR" "$CF_DIR"
install -d -m 755 "$UNIT_DIR" "$HOME_DIR/.local/bin"
ok "$DATA_DIR $SECRETS_DIR $CF_DIR $UNIT_DIR"

say "Units and tunnel config"
tmp=$(mktemp -d)
render_all "$tmp"
for u in $UNITS; do install -m 644 "$tmp/$u" "$UNIT_DIR/$u"; done
install -m 600 "$tmp/bona.yml" "$CF_DIR/bona.yml"
rm -rf "$tmp"
systemctl --user daemon-reload
ok "installed $UNITS and $CF_DIR/bona.yml (nothing enabled, nothing started)"

say "Status"
if check_state; then ok "ready for cutover.sh (run it on the PC)"; else warn "still missing items above (secrets/credentials come from sync-secrets.sh on the PC)"; fi
```

- [ ] **Step 3: Make it executable and run the tests**

Run: `chmod 755 ~/bona-wt/api-vps/services/deploy/vps/install-vps.sh && cd ~/bona-wt/api-vps/services && node --test api/test/vps-deploy.test.mjs`
Expected: `lib.sh` constants, render, and `--check` tests PASS. `bash -n`, dry-run and secret-scan tests still FAIL only because `deploy.sh`, `sync-secrets.sh`, `cutover.sh`, `rollback.sh` do not exist yet.

- [ ] **Step 4: Commit**

```bash
cd ~/bona-wt/api-vps && git add services/deploy/vps/install-vps.sh
git commit -m "deploy(vps): idempotent installer with --check, --render-only and --smoke

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `sync-secrets.sh` and `deploy.sh`

**Files:**
- Create: `services/deploy/vps/sync-secrets.sh` (755)
- Create: `services/deploy/vps/deploy.sh` (755)

- [ ] **Step 1: Write `sync-secrets.sh`**

```bash
#!/usr/bin/env bash
# Run ON THE PC. Copies the four ~/.secrets/*.env files and the tunnel credentials JSON to the VPS,
# mode 0600, without ever printing their contents. Re-run any time a secret changes on the PC.
#   sync-secrets.sh            copy
#   sync-secrets.sh --dry-run  list what would be copied
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
need scp; need ssh

DRY=0; [ "${1:-}" = --dry-run ] && DRY=1
files=()
for f in $SECRET_FILES; do
  [ -f "$SECRETS_DIR/$f" ] || die "missing $SECRETS_DIR/$f on this machine"
  files+=("$SECRETS_DIR/$f")
done
[ -f "$CF_DIR/$BONA_TUNNEL_ID.json" ] || die "missing tunnel credentials $CF_DIR/$BONA_TUNNEL_ID.json"

say "Secrets to copy to $BONA_VPS_SSH"
for f in "${files[@]}" "$CF_DIR/$BONA_TUNNEL_ID.json"; do echo "  $f ($(stat -c %s "$f") bytes)"; done
[ "$DRY" = 1 ] && { ok "dry run, nothing copied"; exit 0; }

ssh "$BONA_VPS_SSH" 'install -d -m 700 ~/.secrets ~/.cloudflared'
scp -q -p "${files[@]}" "$BONA_VPS_SSH:.secrets/"
scp -q -p "$CF_DIR/$BONA_TUNNEL_ID.json" "$BONA_VPS_SSH:.cloudflared/"
ssh "$BONA_VPS_SSH" "chmod 600 ~/.secrets/*.env ~/.cloudflared/$BONA_TUNNEL_ID.json && ls -l ~/.secrets ~/.cloudflared | sed 's/^/  /'"
ok "copied; now run install-vps.sh --check on the VPS"
```

- [ ] **Step 2: Write `deploy.sh`**

```bash
#!/usr/bin/env bash
# Run ON THE VPS (or: ssh hermes-vps bash /opt/bona/services/deploy/vps/deploy.sh).
# Pull main, run the API test suite with the pinned node, restart the unit, wait for /health.
# Tests failing = the running service is left untouched.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
need git; need systemctl; need curl
[ -x "$NODE_BIN/node" ] || die "node $NODE_VERSION missing — run install-vps.sh"

say "Pull"
before=$(git -C "$BONA_VPS_REPO" rev-parse --short HEAD)
git -C "$BONA_VPS_REPO" pull --ff-only --quiet
after=$(git -C "$BONA_VPS_REPO" rev-parse --short HEAD)
ok "$before -> $after"

say "Tests"
( cd "$BONA_VPS_REPO/services" && "$NODE_BIN/node" --test api/test/*.test.mjs ) || die "tests failed — service NOT restarted (still on $before)"
ok "tests green"

say "Restart bona-api"
systemctl --user restart bona-api.service
health() { curl -fsS "http://127.0.0.1:$BONA_VPS_PORT/health" | grep -q '"ok":true'; }
wait_for 30 1 health || { journalctl --user -u bona-api -n 30 --no-pager; die "bona-api did not become healthy"; }
curl -sS "http://127.0.0.1:$BONA_VPS_PORT/health"; echo
ok "deployed $after"
```

- [ ] **Step 3: Run the tests**

Run: `chmod 755 ~/bona-wt/api-vps/services/deploy/vps/{sync-secrets.sh,deploy.sh} && cd ~/bona-wt/api-vps/services && node --test api/test/vps-deploy.test.mjs`
Expected: everything PASSES except `bash -n` for `cutover.sh`/`rollback.sh` and the `--dry-run` test.

- [ ] **Step 4: Commit**

```bash
cd ~/bona-wt/api-vps && git add services/deploy/vps/sync-secrets.sh services/deploy/vps/deploy.sh
git commit -m "deploy(vps): secrets sync from the PC and pull-test-restart deploy on the VPS

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `cutover.sh` and `rollback.sh`

**Files:**
- Create: `services/deploy/vps/cutover.sh` (755)
- Create: `services/deploy/vps/rollback.sh` (755)

- [ ] **Step 1: Write `cutover.sh`**

```bash
#!/usr/bin/env bash
# Run ON THE PC. Moves the live bona-api from this machine to the VPS in five steps, and rolls
# back by itself if any step fails:
#   1. stop cloudflared-bona + bona-api here (one API, one tunnel connector — never two)
#   2. copy ~/bona-data/{bona.db,…jsonl} to the VPS (PC service is stopped, so the copy is consistent)
#   3. start bona-api on the VPS, wait for 127.0.0.1:4120/health, compare lead counts
#   4. start cloudflared-bona on the VPS, wait for the public /health
#   5. disable the two units here (files stay for rollback.sh)
#   cutover.sh --dry-run   print the plan, touch nothing, call nothing.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"

DRY=0; [ "${1:-}" = --dry-run ] && DRY=1
PC_NODE=${PC_NODE:-$(command -v node || true)}

if [ "$DRY" = 1 ]; then
  say "Dry run — the cutover would:"
  echo "  1. stop cloudflared-bona and bona-api on this PC (systemctl --user)"
  echo "  2. copy $DATA_DIR/{$(echo $DATA_FILES | tr ' ' ',')} to $BONA_VPS_SSH:bona-data/ (whichever exist)"
  echo "  3. start bona-api on the VPS and wait for http://127.0.0.1:$BONA_VPS_PORT/health, compare lead counts"
  echo "  4. start cloudflared-bona on the VPS and wait for $BONA_PUBLIC_HEALTH"
  echo "  5. disable bona-api and cloudflared-bona on this PC (rollback.sh re-enables them)"
  ok "nothing done"
  exit 0
fi

need ssh; need scp; need curl; need systemctl
[ -x "$PC_NODE" ] || die "node not found on the PC (set PC_NODE)"
vps() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$BONA_VPS_SSH" "$@"; }

say "Preflight"
vps true || die "cannot ssh to $BONA_VPS_SSH"
vps "bash $BONA_VPS_REPO/services/deploy/vps/install-vps.sh --check" || die "VPS is not ready (install-vps.sh --check failed)"
for u in bona-api cloudflared-bona; do
  if vps "systemctl --user is-active --quiet $u"; then die "$u is ALREADY running on the VPS — refusing to start a second copy"; fi
done
ok "VPS ready, nothing running there yet"

FINISHED=0
rollback() {
  [ "$FINISHED" = 1 ] && return 0
  warn "cutover did not finish — rolling back to the PC"
  vps "systemctl --user disable --now cloudflared-bona bona-api" || true
  systemctl --user enable --now bona-api cloudflared-bona || true
  warn "PC units started again; check: systemctl --user status bona-api cloudflared-bona"
}
# EXIT (not ERR): `die` exits, and an ERR trap would not fire for it. Armed only after the
# preflight, so a refused preflight never stops a VPS copy that is legitimately live.
trap rollback EXIT

say "1/5 Stop the PC copy"
systemctl --user stop cloudflared-bona bona-api
wait_for 30 1 bash -c '! systemctl --user is-active --quiet bona-api && ! systemctl --user is-active --quiet cloudflared-bona' || die "PC units did not stop"
ok "stopped"

say "2/5 Copy data"
pc_leads=$(count_leads "$PC_NODE" "$DATA_DIR/bona.db")
files=()
for f in $DATA_FILES; do [ -f "$DATA_DIR/$f" ] && files+=("$DATA_DIR/$f"); done
[ "${#files[@]}" -gt 0 ] || die "no data files in $DATA_DIR"
vps "install -d -m 700 ~/bona-data"
scp -q -p "${files[@]}" "$BONA_VPS_SSH:bona-data/"
vps "chmod 600 ~/bona-data/*"
ok "copied ${#files[@]} files (PC leads: $pc_leads)"

say "3/5 Start bona-api on the VPS"
vps "systemctl --user enable --now bona-api"
wait_for 30 1 vps "curl -fsS http://127.0.0.1:$BONA_VPS_PORT/health | grep -q '\"ok\":true'" || { vps "journalctl --user -u bona-api -n 30 --no-pager" || true; die "VPS bona-api is not healthy"; }
vps_leads=$(vps "$REMOTE_NODE -e 'const {DatabaseSync}=require(\"node:sqlite\");const db=new DatabaseSync(process.argv[1],{readOnly:true});console.log(db.prepare(\"select count(*) as n from leads\").get().n)' ~/bona-data/bona.db")
[ "$vps_leads" = "$pc_leads" ] || die "lead count mismatch: PC $pc_leads vs VPS $vps_leads"
ok "healthy, $vps_leads leads carried over"

say "4/5 Start the tunnel connector on the VPS"
vps "systemctl --user enable --now cloudflared-bona"
public() { curl -fsS -m 10 "$BONA_PUBLIC_HEALTH" | grep -q '"retell":"ok"'; }
wait_for 45 2 public || { vps "journalctl --user -u cloudflared-bona -n 30 --no-pager" || true; die "public health did not come back"; }
ok "$BONA_PUBLIC_HEALTH answers from the VPS"

say "5/5 Disable the PC units"
systemctl --user disable bona-api cloudflared-bona
FINISHED=1
ok "done — bona-api now runs on $BONA_VPS_SSH; rollback.sh brings it back here"
```

- [ ] **Step 2: Write `rollback.sh`**

```bash
#!/usr/bin/env bash
# Run ON THE PC. Undo cutover.sh: stop the VPS units, optionally copy bona.db back, start and
# re-enable the PC units, wait for the public health.
#   rollback.sh              bring the service back to this PC (PC data as it was at cutover)
#   rollback.sh --copy-back  also copy the VPS's newer bona-data files back first
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
need ssh; need scp; need curl; need systemctl
vps() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$BONA_VPS_SSH" "$@"; }

say "Stop the VPS copy"
vps "systemctl --user disable --now cloudflared-bona bona-api" || warn "could not reach the VPS — continuing; make sure nothing runs there"
ok "VPS units stopped and disabled"

if [ "${1:-}" = --copy-back ]; then
  say "Copy data back from the VPS"
  systemctl --user stop bona-api || true
  for f in $DATA_FILES; do
    vps "test -f ~/bona-data/$f" && scp -q -p "$BONA_VPS_SSH:bona-data/$f" "$DATA_DIR/$f" || true
  done
  chmod 600 "$DATA_DIR"/* 2>/dev/null || true
  ok "copied"
fi

say "Start the PC copy"
systemctl --user enable --now bona-api cloudflared-bona
public() { curl -fsS -m 10 "$BONA_PUBLIC_HEALTH" | grep -q '"retell":"ok"'; }
wait_for 45 2 public || die "public health did not come back on the PC — check: systemctl --user status bona-api cloudflared-bona"
ok "bona-api runs on this PC again"
```

- [ ] **Step 3: Run all tests**

Run: `chmod 755 ~/bona-wt/api-vps/services/deploy/vps/{cutover.sh,rollback.sh} && cd ~/bona-wt/api-vps/services && node --test api/test/vps-deploy.test.mjs && node --test api/test/*.test.mjs 2>&1 | tail -5`
Expected: all `vps-deploy` tests PASS; the full suite still passes (no regressions).

- [ ] **Step 4: Commit**

```bash
cd ~/bona-wt/api-vps && git add services/deploy/vps/cutover.sh services/deploy/vps/rollback.sh
git commit -m "deploy(vps): cutover with automatic rollback, and rollback script

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: README

**Files:**
- Modify: `services/README.md` §6 "Install and run" (line ~411) and §8 "Runbook" (line ~464)

- [ ] **Step 1: Add a "Where it runs" subsection at the top of §6**

Insert after the `## 6. Install and run` heading:

```markdown
### Where it runs (since 2026-09-08): the VPS

The live `bona-api` runs on the VPS (`ssh hermes-vps`, user `azoz`) as `systemctl --user` units
`bona-api.service` (port **4120**, loopback) and `cloudflared-bona.service` (tunnel `bona`, hostnames
`api.bona-real-estate.com`, `bona-api.azoz.uk`, `bona.azoz.uk`), from a sparse checkout of this repo
at `/opt/bona` that `bona-repo-sync.timer` fast-forwards every 5 minutes (so listings published by
the intake reach Dana's inventory without a deploy). Data: `~/bona-data`. Secrets: `~/.secrets/*.env`.

| I want to… | Run |
|---|---|
| deploy a code change (pull, test, restart, health) | `ssh hermes-vps bash /opt/bona/services/deploy/vps/deploy.sh` |
| see logs | `ssh hermes-vps journalctl --user -u bona-api -f` (tunnel: `-u cloudflared-bona`) |
| check readiness / what is missing | `ssh hermes-vps bash /opt/bona/services/deploy/vps/install-vps.sh --check` |
| copy changed secrets from the PC | `bash services/deploy/vps/sync-secrets.sh` (on the PC) |
| bring it back to the PC | `bash services/deploy/vps/rollback.sh [--copy-back]` (on the PC) |

`install.sh` in this directory is the **PC/WSL** installer and is kept only for rollback; its units
are disabled on the PC. `bona-intake` (WhatsApp PDF → listing) still runs on the PC — it needs the
owner's Claude login — and never talks to the API. Scripts: `services/deploy/vps/README` header
comments; the move itself: `docs/superpowers/specs/2026-09-08-bona-api-vps-move-design.md`.
```

- [ ] **Step 2: Add a runbook entry in §8**

Append to §8:

```markdown
- **Dana down, site shows the WhatsApp fallback** → `ssh hermes-vps systemctl --user status bona-api cloudflared-bona`; `journalctl --user -u bona-api -n 50`. Uptime Kuma #25 (`api.bona-real-estate.com/health`, keyword `"retell":"ok"`) pages Telegram after ~3 minutes. If the VPS itself is gone: `bash services/deploy/vps/rollback.sh` on the PC restores the previous setup in about a minute.
- **Inventory stale after an intake publish** → `ssh hermes-vps systemctl --user list-timers bona-repo-sync.timer` and `journalctl --user -u bona-repo-sync -n 5`; the API re-reads `listings.json` within 30 s of the pull.
```

- [ ] **Step 3: Run the tests and commit**

Run: `cd ~/bona-wt/api-vps/services && node --test api/test/*.test.mjs 2>&1 | tail -3`
Expected: all pass.

```bash
cd ~/bona-wt/api-vps && git add services/README.md
git commit -m "docs(services): bona-api runs on the VPS — deploy, logs, rollback

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Review gate (Claude reviewer, then Codex) — before anything runs on the VPS

- [ ] Claude code-reviewer subagent on `git diff origin/main...feat/api-vps` against the spec; fix findings; commit.
- [ ] Codex: `cd ~/bona-wt/api-vps && git diff origin/main...HEAD > /tmp/claude-1001/-mnt-c-Users-ASUS/5efd892d-ebff-43bc-b634-657a89204d74/scratchpad/api-vps.diff && codex exec --skip-git-repo-check "Review this diff (a set of bash scripts + systemd templates + a node test that move a Node service to a VPS). Spec: <paste key constraints>. Look for: anything that could start two copies of the API or two tunnel connectors, data loss in the copy, unquoted paths, set -e pitfalls with trap/ERR, checksum or download mistakes, secrets leaking to stdout, and systemd hardening that would block the API from reading /opt/bona or writing ~/bona-data. Verdict SHIP or DO-NOT-SHIP with findings." < api-vps.diff`. Fix findings; commit. Record which model found what.

### Task 7: Provision the VPS (no service starts)

- [ ] `scp -r ~/bona-wt/api-vps/services/deploy/vps hermes-vps:/tmp/bona-vps && ssh hermes-vps bash /tmp/bona-vps/install-vps.sh` — first run installs node, cloudflared and clones `/opt/bona` (the branch is not on GitHub yet, so the checkout is `main`; the deploy dir on the VPS is used from `/tmp/bona-vps` until the branch merges, after which `deploy.sh` pulls it into `/opt/bona`).
- [ ] `bash ~/bona-wt/api-vps/services/deploy/vps/sync-secrets.sh` on the PC (if the classifier blocks it, the owner runs that exact line).
- [ ] `ssh hermes-vps bash /tmp/bona-vps/install-vps.sh --check` → exit 0.
- [ ] `ssh hermes-vps bash /tmp/bona-vps/install-vps.sh --smoke` → `/health` JSON with `"ok":true` and `inventory` ≥ 45.
- [ ] `ssh hermes-vps 'cd /opt/bona/services && ~/.local/opt/node-v24.19.0-linux-x64/bin/node --test api/test/*.test.mjs 2>&1 | tail -3'` → all pass on the VPS.

### Task 8: Cutover

- [ ] Pause Kuma #25/#26 (owner is not paged for a planned window); message the peer session.
- [ ] `bash ~/bona-wt/api-vps/services/deploy/vps/cutover.sh --dry-run`, then `bash ~/bona-wt/api-vps/services/deploy/vps/cutover.sh`.
- [ ] Verification (spec §5) by a fresh subagent: VPS units active; journal `listening` line (port 4120, inventory, poller); public `/health` on both API hostnames; `bona.azoz.uk/x` → 301; CORS preflight 204; chat session + a message that returns cards; `/v1/call/token` 200; `/dashboard` 200; `~/.claude/scripts/cdp-concierge-check.mjs` EN desktop + AR mobile on bona-real-estate.com; PC units inactive+disabled, `bona-intake` active; `cloudflared tunnel info 9022fbec-…` shows VPS connections only.
- [ ] Resume Kuma; confirm #25/#26 UP.

### Task 9: Ship

- [ ] Update memory (`bona-intake-concierge-2026-09-05.md` + index): runtime on VPS, deploy command, rollback, what stays on the PC.
- [ ] Final Codex pass on the full diff (docs included), then `git push -u origin feat/api-vps`, `gh pr create`, CI green, merge to main (owner rule: green CI → merge allowed), then `ssh hermes-vps bash /opt/bona/services/deploy/vps/deploy.sh` so `/opt/bona` carries the merged scripts.
- [ ] Notify the peer session; final report to the owner.


---

## Review fixes (2026-09-08, after the Claude + Codex pass on the first cut)

What changed versus the task text above (the code on the branch is the source of truth):

1. `templates/bona-api.service.in` has no `EnvironmentFile=` lines — systemd gives environment-file values precedence over `Environment=` regardless of order, which would have cancelled the VPS port/path overrides (Claude C1). The process reads the env files itself.
2. `cutover.sh` rollback is fail-closed: `VPS_STARTED` flag; PC units start only after the VPS units are verified inactive over ssh, otherwise manual commands + exit 1 (Codex #1). `rollback.sh` same rule; `--copy-back` only after that verification.
3. `cutover.sh` enables `bona-repo-sync.timer` after the local health wait; the timer is `OnCalendar=*:0/5` (+`RandomizedDelaySec=30`, `Persistent=true`) instead of monotonic (Codex #2, Claude C2/M2).
4. `lib.sh` gained `BONA_VPS_DEPLOY_DIR` (default `$BONA_VPS_REPO/services/deploy/vps`; `/tmp/bona-vps` before the branch is merged) used by the preflight `--check`; the preflight verifies the PC node has `node:sqlite`; the VPS lead count is taken right after the copy, before the VPS API starts (Claude I1, I2, M1).
5. Hardening: `--smoke` uses `exec` and refuses a busy port; `sync-secrets.sh` chmods the four named files only; `deploy.sh` pauses the timer around its pull; `render()` uses bash substitution instead of sed; `uname -m` guard; README fixes (Claude M3, M5, M7, M8, M9, M10).
6. Tests: shim-based cutover scenarios (happy path, refused PC node, public health never back, VPS unit refuses to stop, ssh dies after start), `--check` ready path with plain `MISSING:` lines, "install mode never enables/starts", hardening parity with the PC unit, secret scan over templates and shims (Codex #4, Claude M6). Suite: 469 tests.
7. Accepted deviation (Codex #3): cone sparse checkout of the whole `src/data` directory is kept — it holds only a few small JSON files; the two-file non-cone pattern buys nothing.
