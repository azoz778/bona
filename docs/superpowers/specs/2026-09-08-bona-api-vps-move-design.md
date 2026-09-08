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
| Units | `~/.config/systemd/user/{bona-api,cloudflared-bona,bona-repo-sync}.service`, `bona-repo-sync.timer` | rendered from templates in `services/deploy/vps/` |

`bona-api.service` is the repo's hardened unit with these VPS differences set as `Environment=` lines (process env wins over the env files by design in `lib/env.mjs`): `BONA_API_PORT=4120`, `BONA_REPO=/opt/bona`, `BONA_DATA=%h/bona-data`, `EVOLUTION_API_URL=http://127.0.0.1:8085`, `PATH`/`ExecStart` → the Node 24 tarball, `WorkingDirectory=/opt/bona/services`. It still must not set `BONA_WA_POLL`. `bona-repo-sync.service` (+ timer, every 5 min, `OnBootSec=2min`) runs `git -C /opt/bona pull --ff-only` so new listings reach the hot-reload; it does not restart the API (code on disk changes, the running process does not — same as the PC today).

### 3.3 Files added to the repo (`services/deploy/vps/`)

- `install-vps.sh` — idempotent provisioning, run **on the VPS** as `azoz`: Node tarball, cloudflared, `/opt/bona` sparse clone, directories and modes, unit rendering, `daemon-reload`, `enable` (API + sync timer; the tunnel unit is enabled but only ever started by the cutover). `--check` prints what is still missing (secrets, tunnel credentials, data) without changing anything. Never prints secret values.
- `bona-api.service.in`, `cloudflared-bona.service.in`, `bona-repo-sync.service`, `bona-repo-sync.timer`, `bona.yml.in` — templates; `@HOME@`, `@NODE@`, `@PORT@`, `@REPO@` substituted by the installer.
- `deploy.sh` — run on the VPS (`ssh hermes-vps bash /opt/bona/services/deploy/vps/deploy.sh`): `git pull --ff-only`, `node --test api/test/*.test.mjs`, `systemctl --user restart bona-api`, wait for `/health` ok. Tests failing = no restart.
- `cutover.sh` — run on the **PC**, the only script that stops anything: (1) `systemctl --user stop cloudflared-bona bona-api` on the PC and verify both inactive; (2) rsync `~/bona-data/{bona.db,bona.db-wal,bona.db-shm,leads.jsonl,chats.jsonl,calls.jsonl}` (whatever exists) to the VPS; (3) `ssh` start `bona-api` on the VPS and wait for `127.0.0.1:4120/health` `ok:true`; (4) start `cloudflared-bona` on the VPS and wait for `https://api.bona-real-estate.com/health` 200 with `"retell":"ok"`; (5) `systemctl --user disable bona-api cloudflared-bona` on the PC. Any failed step runs the rollback automatically.
- `rollback.sh` — run on the PC: stop the VPS units, optionally copy `bona.db` back, start and re-enable the PC units, wait for public health.
- `sync-secrets.sh` — run on the PC: copies the four env files and the tunnel credentials + rendered `bona.yml` to the VPS with `scp`/`rsync`, modes preserved. Separate so the owner can run it if the agent's copy is blocked.
- Tests `services/api/test/vps-deploy.test.mjs`: templates render with the expected port, paths and the three ingress hostnames; rendered `bona-api.service` has no `Environment=BONA_WA_POLL`; every script passes `bash -n`; `install-vps.sh --check` and `cutover.sh --dry-run` exit 0 in a temp HOME with fake binaries; no script contains a secret-looking value.
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

- VPS: `systemctl --user is-active bona-api cloudflared-bona bona-repo-sync.timer`; journal `listening` line shows port 4120, inventory ≥ 45, `poller` configured; `cloudflared` registered 4 connections.
- Public: `/health` 200 `"retell":"ok"` on `api.bona-real-estate.com` and `bona-api.azoz.uk`; `bona.azoz.uk/x` → 301 to `https://bona-real-estate.com/x`; CORS preflight from `https://bona-real-estate.com` → 204.
- Behaviour: chat session → greeting; a message that triggers `search_properties` returns listing cards (proves Retell → tool URL → token → VPS); `/v1/call/token` 200; `/dashboard` 200; browser end-to-end via `~/.claude/scripts/cdp-concierge-check.mjs` on bona-real-estate.com (EN desktop + AR mobile: cards, navigate, live call).
- Data: lead count in the VPS `bona.db` = PC count at stop time; poller cursor carried over (journal shows no re-processing burst).
- PC: `bona-api`/`cloudflared-bona` inactive **and disabled**; `bona-intake` untouched and active.
- Kuma #25/#26 UP; `cloudflared tunnel list` shows connections from the VPS only.

## 6. Risks and mitigations

- Double-running (API or tunnel) → cutover script stops the PC first and refuses to start the VPS if the PC units are still active.
- Wrong Node → installer verifies `node -v` = v24.19.0 and `node -e "require('node:sqlite')"` before rendering units.
- Secrets copy blocked by the permission classifier → `sync-secrets.sh` is owner-runnable; the design has no other privileged step (no sudo except `install -d -o azoz /opt/bona`, no DNS, no Caddy).
- Sparse checkout missing a file the API needs → test suite runs on the VPS in `deploy.sh`; `install-vps.sh --check` greps `services/api` for reads outside `services/` and `src/data`.
- VPS reboot pending → units are `enable`d under linger, so they come back; verify after the owner's next reboot.
- Tunnel version drift → pinned, checksum-verified; `--no-autoupdate`.

## 7. Review gates

Claude reviewer on the branch, then Codex (`codex exec`) on the same diff; both before anything runs on the VPS. A second Codex pass on the final diff (docs + any fixes from the live run) before the branch is pushed and merged.
