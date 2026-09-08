# Bona — move the Dana API (bona-api) from the owner's PC to the VPS (design, 2026-09-08)

Owner order (2026-09-08): "Move it to the VPS. Sub-agents do the work, you delegate. Make sure everything is working. Before you push, double-check with Codex."

Why: `bona-api` (Dana's chat/voice API, the WhatsApp Ref-code poller, the ad fan-out and the private dashboard — one Node process) runs inside WSL on the owner's desktop and is published through Cloudflare tunnel `bona`. PC asleep, rebooting or updating = Dana offline and the site falls back to WhatsApp. The VPS (`hermes-vps`, 187.124.222.162) already hosts everything else and is up 104 days.

## 1. Goal and non-goals

Goal: the same API, same hostnames, same Retell objects, same data, running on the VPS; the PC copy stopped and disabled; a documented one-command deploy for future code changes; nothing else on either machine changes.

Non-goals: no DNS change, no Caddy change, no new Retell provisioning, no change to `services/api` logic, no move of `bona-intake` (it needs the owner's Claude login and stays on the PC), no change to the site.

## 2. Facts that shape the design (surveyed 2026-09-08)

- `bona-api` = `node services/api/index.mjs`, zero npm dependencies, needs **Node 24** (`node:sqlite`). Reads only `services/**` and `src/data/{site,listings}.json` from the repo, `~/.secrets/{retell,evolution-api,bona-services,bona-marketing}.env`, and writes only `~/bona-data/` (`bona.db` WAL + `leads/chats/calls.jsonl`). Listens on `127.0.0.1:$BONA_API_PORT`. Inventory hot-reloads on `listings.json` mtime (≤30 s), so the checkout must stay fresh; `bona-intake` on the PC publishes listings by committing to GitHub.
- The poller keeps its cursor in `bona.db`. **Two copies of the API must never run at once** (double WhatsApp processing, diverging databases) and **one tunnel = one connector at a time** (Cloudflare balances across connectors).
- VPS: Ubuntu 24.04, 4 vCPU, ~6.9 GB RAM free, 69 GB disk free, user `azoz` (passwordless sudo, linger on, `systemctl --user` precedent), Node **20** only (must not change: TK apps pin it), no `cloudflared`, port **4102 taken** (obsidian-mcp) → use **4120**. Evolution API runs on the VPS at `127.0.0.1:8085` (= `wa-api.azoz.uk`). Outbound HTTPS unrestricted. A reboot is pending on the VPS.
- Cloudflare: `api.bona-real-estate.com`, `bona-api.azoz.uk`, `bona.azoz.uk` are proxied CNAMEs to tunnel `9022fbec-de4f-44b9-805e-8fff285d6263` (`bona`). Its credentials JSON and `bona.yml` are on the PC. `ids.json.publicApi` and the Retell tool URLs already say `api.bona-real-estate.com`.
- Constraints carried over: never set an Evolution webhook; never touch Lisa's Retell objects; keep the legacy hostnames (brochure QR codes); Uptime Kuma #25/#26 watch the hostnames, not the box.

## 3. Design

### 3.1 Exposure: reuse tunnel `bona` on the VPS (decision)

Run a `cloudflared` connector for the **same** tunnel on the VPS, with the same three ingress hostnames pointing at `http://127.0.0.1:4120`. No DNS edit (the classifier blocks DNS edits), no root Caddy edit, TLS and Cloudflare proxying identical to today, and rollback is "stop the VPS connector, start the PC connector". The alternative (Caddy site + DNS flip to proxied A records) matches house convention but needs two owner-typed privileged changes and a different trusted-proxy setup; it can be done later as a consolidation, not today.

### 3.2 Layout on the VPS (user `azoz`)

| What | Where | Notes |
|---|---|---|
| Node 24.19.0 | `~/.local/opt/node-v24.19.0-linux-x64/` | official tarball, SHA256 verified against `SHASUMS256.txt`; same version as the PC |
| cloudflared | `~/.local/bin/cloudflared` | pinned release (2026.8.3), SHA256 verified |
| Repo | `/opt/bona` | `git clone --filter=blob:none --no-checkout` + cone sparse-checkout of `services` and `src/data` (the 258 MB of site images never land); `azoz:azoz` |
| Data | `~/bona-data/` (0700) | `bona.db`, `leads.jsonl`, `chats.jsonl`, `calls.jsonl` migrated from the PC |
| Secrets | `~/.secrets/*.env` (0600) | the four files copied verbatim from the PC |
| Tunnel | `~/.cloudflared/bona.yml`, `~/.cloudflared/9022fbec-….json` (0600) | ingress → `127.0.0.1:4120` |
| Units | `/etc/systemd/system/{bona-api,cloudflared-bona,bona-repo-sync}.service`, `bona-repo-sync.timer` | **system units** with `User=azoz`, `Group=azoz`, `Environment=HOME=/home/azoz`, root-owned 0644, rendered from templates in `services/deploy/vps/` and installed with `sudo -n install`; driven with `sudo -n systemctl …` (`VPS_SYSTEMCTL` in `lib.sh`), logs via `sudo -n journalctl -u …` |

**System units, not `systemctl --user` (decision 2026-09-08, after the first live attempt).** Ubuntu 24.04 sets `kernel.apparmor_restrict_unprivileged_userns=1`; under it a user-manager unit cannot apply the sandbox directives (`ProtectSystem`, `PrivateTmp`, `ProtectHostname`, `ProtectKernelModules`, …) and the service dies with `status=218/CAPABILITIES` ("Failed to drop capabilities: Operation not permitted"). That is exactly where the first cutover failed ("start bona-api on the VPS"); it rolled back cleanly. A transient **system** service with `User=azoz` and the identical hardening set ran fine (exit 0, wrote to `/home/azoz/bona-data`, `node:sqlite` loaded). So the three units keep every hardening directive and run under the system manager as the service user; `install-vps.sh` puts them in `/etc/systemd/system` through the passwordless sudo the VPS already has, retires the user units of the first attempt (`systemctl --user disable --now`, file removed, user-manager reload — idempotent), and every script addresses them with `sudo -n systemctl` (never a prompt: `-n`). `[Install]` is `WantedBy=multi-user.target` for the two services (the timer keeps `timers.target`), so they come back on boot without linger. The PC side is untouched and stays `systemctl --user`.

`bona-api.service` is the repo's hardened unit with these VPS differences set as `Environment=` lines: `BONA_API_PORT=4120`, `BONA_REPO=/opt/bona`, `BONA_DATA=~/bona-data`, `EVOLUTION_API_URL=http://127.0.0.1:8085`, `PATH`/`ExecStart` → the Node 24 tarball, `WorkingDirectory=/opt/bona/services`. The unit has **no `EnvironmentFile=`** lines: systemd lets environment-file values override `Environment=` regardless of order (review finding 2026-09-08), and the process reads the four `~/.secrets/*.env` files itself (`lib/env.mjs`, `process.env` wins) — which is exactly why the overrides work and why the unit must never set `BONA_WA_POLL`. `bona-repo-sync.service` + timer (`OnCalendar=*:0/5`, `Persistent=true`) runs `git -C /opt/bona pull --ff-only` so new listings reach the hot-reload; it does not restart the API (code on disk changes, the running process does not — same as the PC today). The timer is enabled by `cutover.sh`, never by the installer.

### 3.3 Files added to the repo (`services/deploy/vps/`)

- `install-vps.sh` — idempotent provisioning, run **on the VPS** as `azoz`: Node tarball (sha256-pinned, x86_64 only), cloudflared, `/opt/bona` sparse clone, directories and modes, retiring the user units of the first attempt, unit rendering into `/etc/systemd/system` (`sudo -n install -m 644`; `BONA_UNIT_DIR` lets the tests point at a temp dir), `sudo -n systemctl daemon-reload`. It **enables nothing and starts nothing** — `cutover.sh` is the only script that starts a unit on the VPS (a second running API or tunnel connector is the one thing the move must never produce). `--check` prints one line per item (`ok` / `MISSING: …` — node, node:sqlite, cloudflared, `git at $GIT_BIN`, repo files, the four secret files at 0600, tunnel credentials, `bona.yml`, data dir, the four unit files under `/etc/systemd/system`, passwordless sudo (`sudo -n systemctl --version`)) and exits 0 = ready / 2 = not yet, without changing anything; `--render-only DIR` renders the units + `bona.yml` into DIR (tests); `--smoke` runs the API for 15 s on a throw-away port and data dir with the poller off. Never prints secret values.
- `templates/bona-api.service.in`, `cloudflared-bona.service.in`, `bona-repo-sync.service.in`, `bona-repo-sync.timer` — rendered by `render()` in `lib.sh` (bash substitution, refuses a leftover placeholder); placeholders `@HOME@ @USER@ @REPO@ @PORT@ @NODE_BIN@ @TUNNEL_ID@ @EVOLUTION_URL@ @GIT@` (`@USER@` = `VPS_USER`, whoever runs the installer, into `User=`/`Group=`). `~/.cloudflared/bona.yml` is not a template: `render_tunnel_config` in `lib.sh` generates the ingress from `BONA_HOSTNAMES` (all three hostnames → `127.0.0.1:4120`, then `http_status:404`).
- `deploy.sh` — run on the VPS (`ssh hermes-vps bash /opt/bona/services/deploy/vps/deploy.sh`): notes whether `bona-repo-sync.timer` is active, stops the timer and its service, `git pull --ff-only`, `node --test api/test/*.test.mjs` with the pinned node, `sudo -n systemctl restart bona-api`, wait for `/health` ok (on failure `sudo -n journalctl -u bona-api -n 30`); the EXIT trap starts the timer again only if it was active. Tests failing = no restart.
- `cutover.sh` — run on the **PC**, the only script that starts anything on the VPS: preflight (ssh, `install-vps.sh --check` on the VPS via `BONA_VPS_DEPLOY_DIR`, VPS units not running, PC node has `node:sqlite`); (1) `systemctl --user stop cloudflared-bona bona-api` on the PC and verify both inactive; (2) copy `~/bona-data/{bona.db,bona.db-wal,bona.db-shm,leads.jsonl,chats.jsonl,calls.jsonl}` (whatever exists) to the VPS and compare lead counts; (3) start `bona-api` on the VPS (`ssh hermes-vps sudo -n systemctl enable --now bona-api`), wait for `127.0.0.1:4120/health` `ok:true`, enable `bona-repo-sync.timer`; (4) start `cloudflared-bona` on the VPS and wait for `https://api.bona-real-estate.com/health` 200 with `"retell":"ok"`; (5) `systemctl --user disable bona-api cloudflared-bona` on the PC. Any failure after the preflight runs the rollback automatically, and the rollback is **fail-closed**: the PC units are started only after the VPS units are verified inactive over ssh; if that cannot be verified it prints the manual commands and exits 1 rather than risk two copies.
- `rollback.sh` — run on the PC: stop the VPS units and verify them inactive (fail-closed, same as the cutover's rollback), then start and re-enable the PC units and wait for public health. `--copy-back` (after that verification) is all-or-nothing: PC node checked for `node:sqlite` first, PC API stopped, files `scp`'d into `mktemp -d ~/bona-data/.copy-back.XXXXXX` — `bona.db` unconditionally (a failed or empty-handed copy aborts), the WAL/SHM pair and the jsonl files where the VPS has them (`absent on the VPS: …` otherwise) — VPS lead count compared with the staged copy's, and only then `mv -f` + `chmod 600` into `~/bona-data` and the PC units start; any failure leaves the PC data as it was, removes the temp dir and starts nothing. A PC `bona.db-wal`/`-shm` the VPS no longer has is removed (SQLite would replay it over the fresh database).
- `sync-secrets.sh` — run on the PC: copies the four env files and the tunnel credentials to the VPS with `scp -p` and chmods the named files there. Separate so the owner can run it if the agent's copy is blocked.
- Tests `services/api/test/vps-deploy.test.mjs` (shim-driven: `fixtures/vps-shims/` fakes `ssh`, `scp`, `systemctl`, `sudo`, `curl`, `node`, `git`, `cloudflared`, `uname`; every call lands in a log, scenarios are switched with `SHIM_*` variables, nothing real is touched; the `ssh` shim answers only `sudo -n systemctl …` remote strings, so a regression to user units fails loudly): every script passes `bash -n`; templates render with the expected port, paths, `GIT_BIN` and the three ingress hostnames, no `Environment=BONA_WA_POLL`, no `EnvironmentFile=`; `render()` keeps `&`/`|` verbatim; `--check` on an empty HOME lists `MISSING:` lines and exits 2, on a fully provisioned fake HOME every item is ok and it exits 0; the rendered `bona-api.service` keeps every `[Service]` directive of the PC unit; install mode never enables/starts a unit; `--smoke` refuses a busy port; non-x86_64 is refused before any download. Cutover scenarios: happy path (order: PC node check, remote `--check`, PC stop, PC units verified inactive, scp, VPS lead count, VPS API, timer, tunnel, public health, PC disable), PC node without `node:sqlite`, preflight refused (VPS unit already active; `--check` fails) touching nothing on either side, public health never back (VPS stopped and verified before the PC restarts), VPS unit refuses to stop and ssh dies after the start (fail closed, manual commands printed). Rollback scenarios: plain, `--copy-back` success (files and modes in the temp HOME, temp dir gone, stale WAL removed), scp fails, `bona.db` missing on the VPS, VPS refuses to stop — never a local `enable --now` on failure. `deploy.sh`: timer + service stopped, restarted only on green tests, timer resumed only if it was active. `sync-secrets.sh` chmods the named files, not a glob. No script, template or shim carries a secret-looking value.
- `services/README.md` §6/§8: "the runtime lives on the VPS"; deploy, logs, rollback, and what stays on the PC.

### 3.4 Cutover order (downtime ≈ 1–2 min)

1. Provision the VPS (`install-vps.sh`), copy secrets, run `install-vps.sh --check` → nothing missing. Smoke-test on the VPS with `BONA_WA_POLL=0` against a throw-away copy of the data, then stop it and delete that copy.
2. Pause Kuma #25/#26 (so the owner is not paged by a planned window), tell the peer session.
3. `cutover.sh` on the PC.
4. Verify (§5). Resume Kuma. Notify the peer. Update memory and docs.

Rollback at any point: `rollback.sh`. The PC keeps every file it has today; only the units are disabled.

## 4. Deploys after the move

`ssh hermes-vps bash /opt/bona/services/deploy/vps/deploy.sh` (pull, test, restart, health). The PC's `install.sh --restart` no longer touches the live service. Listings keep flowing automatically: intake (PC) → GitHub → Pages (site) and → `bona-repo-sync.timer` (VPS) → inventory hot-reload within ~6 min.

## 5. Verification (must all pass before "done")

- VPS: `sudo systemctl is-active bona-api cloudflared-bona bona-repo-sync.timer`; journal `listening` line shows port 4120, inventory ≥ 45, `poller` configured; `cloudflared` registered 4 connections.
- Public: `/health` 200 `"retell":"ok"` on `api.bona-real-estate.com` and `bona-api.azoz.uk`; `bona.azoz.uk/x` → 301 to `https://bona-real-estate.com/x`; CORS preflight from `https://bona-real-estate.com` → 204.
- Behaviour: chat session → greeting; a message that triggers `search_properties` returns listing cards (proves Retell → tool URL → token → VPS); `/v1/call/token` 200; `/dashboard` 200; browser end-to-end via `~/.claude/scripts/cdp-concierge-check.mjs` on bona-real-estate.com (EN desktop + AR mobile: cards, navigate, live call).
- Data: lead count in the VPS `bona.db` = PC count at stop time; poller cursor carried over (journal shows no re-processing burst).
- PC: `bona-api`/`cloudflared-bona` inactive **and disabled**; `bona-intake` untouched and active.
- Kuma #25/#26 UP; `cloudflared tunnel list` shows connections from the VPS only.

## 6. Risks and mitigations

- Double-running (API or tunnel) → cutover script stops the PC first and refuses to start the VPS if the PC units are still active.
- Wrong Node → installer verifies `node -v` = v24.19.0 and `node -e "require('node:sqlite')"` before rendering units.
- Secrets copy blocked by the permission classifier → `sync-secrets.sh` is owner-runnable; the only privileged steps are the passwordless `sudo -n` the VPS already grants `azoz` (`install -d -o azoz /opt/bona`, the unit files into `/etc/systemd/system`, `systemctl`/`journalctl` on those units) — no DNS, no Caddy.
- Sparse checkout missing a file the API needs → test suite runs on the VPS in `deploy.sh`; `install-vps.sh --check` greps `services/api` for reads outside `services/` and `src/data`.
- VPS reboot pending → system units `enable`d under `multi-user.target` (no linger needed), so they come back; verify after the owner's next reboot.
- Tunnel version drift → pinned, checksum-verified; `--no-autoupdate`.

## 7. Review gates

Claude reviewer on the branch, then Codex (`codex exec`) on the same diff; both before anything runs on the VPS. A second Codex pass on the final diff (docs + any fixes from the live run) before the branch is pushed and merged.
