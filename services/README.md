# Bona services

Back-office processes for [bona.azoz.uk](https://bona.azoz.uk). The site itself is a
static Astro build on GitHub Pages, so anything that needs a server lives here.

| Service | Directory | Unit | What it does |
|---|---|---|---|
| Concierge API (Dana) | `api/` | `bona-api.service` | Chat + voice concierge backend, Retell tool webhooks, leads |
| Public HTTPS | — | `cloudflared-bona.service` | Cloudflare tunnel `bona`: `api.bona.azoz.uk` → `localhost:4102` |
| WhatsApp intake | `intake/` | `bona-intake.service` | PDF brochure → published listing (separate workstream) |

No runtime dependencies: `services/package.json` is `"dependencies": {}` and the API
is built on Node's own `http`. Node ≥ 22.

---

## 1. The concierge, end to end

```
visitor on bona.azoz.uk
        │  fetch (CORS allowlist)
        ▼
api.bona.azoz.uk  ──Cloudflare tunnel──▶  bona-api on 127.0.0.1:4102 (WSL)
        │                                          │
        │  POST /create-chat, /create-chat-completion, /v2/create-web-call
        ▼                                          │
   Retell AI  ── custom tool webhooks ─────────────┘
   (agent "Dana", one Retell LLM, two agents: voice + chat)
```

Retell hosts the model, so there is no LLM API key here — usage bills to the owner's
Retell balance. The API's job is to broker sessions, answer the three tool webhooks
from Bona's own inventory, and record leads and calls.

---

## 2. HTTP contract

Every response is `Content-Type: application/json` and `Cache-Control: no-store`.
Browser-facing routes are CORS-allowlisted; Retell-facing routes are token-gated and
deliberately **not** CORS-readable.

| Route | Body → Response |
|---|---|
| `GET /health` | → `{ ok, service:"bona-api", version, uptimeS, retell:"ok"\|"error", inventory:<count>, budget }` — 503 when `inventory` is 0 |
| `POST /v1/chat/session` | `{ locale, page? }` → `{ sessionId, greeting }` |
| `POST /v1/chat/message` | `{ sessionId, text, locale?, page? }` → `{ messages, actions, leadCaptured? }` |
| `POST /v1/chat/end` | `{ sessionId }` → `{ ok: true }` |
| `POST /v1/call/token` | `{ locale, page? }` → `{ accessToken, callId }` |
| `GET /v1/call/:callId/context` | → `{ listings: Card[], updatedAt }` |
| `POST /v1/tools/<name>` | Retell custom tool (`X-Bona-Token:`) → a JSON string result |
| `POST /v1/retell/webhook?token=` | Retell agent events → `calls.jsonl` / `chats.jsonl` |

`page` is `{ url, title }` and becomes the dynamic variables `{{page_url}}` and
`{{page_title}}`; `locale` becomes `{{locale}}`.

### Card

Returned inside `actions[].listing` and in the call context.

```jsonc
{
  "id": "BONA-005",
  "slug": "contemporary-villa-al-khalidiyah",
  "title":    { "en": "Contemporary Villa, Al Khalidiyah", "ar": "فيلا عصرية، الخالدية" },
  "district": { "en": "Al Khalidiyah", "ar": "الخالدية" },
  "price":    { "en": "SAR 6,700,000", "ar": "6,700,000 ر.س" },   // formatted, never computed
  "beds": 5, "baths": 8, "areaSqm": 640,
  "image": { "src": "https://…", "thumb": "https://…" },          // always absolute
  "url":   { "en": "https://bona.azoz.uk/properties/…/", "ar": "https://bona.azoz.uk/ar/properties/…/" }
}
```

Prices come straight from `listings.json` through the same formatter as
`src/lib/i18n.ts`. A listing with no printed price formats as "Price on request" /
"السعر عند الطلب" — the API never estimates one (TAQEEM).

### Actions

`POST /v1/chat/message` returns `actions`, in this order:

```jsonc
{ "type": "show_listing", "listing": { /* Card */ } }   // Dana named a property
{ "type": "whatsapp", "message": "…" }                  // offer a WhatsApp button
{ "type": "navigate", "path": "/properties/houses/" }   // same-site path, validated
```

They are built from Dana's tool calls (`show_property`, `search_properties`) plus any
`[[navigate:…]]` / `[[whatsapp:…]]` / `[[show:…]]` marker in her reply. Markers are
stripped from the text before it reaches `messages`, so the widget never renders one.

### Errors

| Status | Meaning |
|---|---|
| 400 | malformed JSON, or empty `text` |
| 401 | wrong or missing tool token |
| 403 | `forbidden_origin` — an `Origin` header that is not on the allowlist |
| 404 | unknown route, unknown tool, expired `sessionId` |
| 405 | known route, wrong method |
| 413 | body over 16 KB |
| 415 | a browser POST that is not `application/json` |
| 429 | `rate_limited` (`Retry-After` in seconds), or `session_limit` — this chat hit its turn cap |
| 500 | unexpected failure |
| 502 | `upstream_error` — Retell unreachable or broken |
| 503 | `not_provisioned` · `budget_exhausted` (the day's ceiling) · `billing` (Retell balance empty) |

**Who may call.** A browser route with an `Origin` header that is not on the allowlist
is refused with 403 *before* Retell is contacted — CORS alone only stops the browser
*reading* the answer, and the call would already have cost money. A request with no
`Origin` at all (curl, the widget's own server-side probes) is allowed through.

**Rate limits**, per IP, per minute: chat 30, `/v1/call/token` 6, call context 120,
tool routes 600, and *failed* tool authentications 10 — so Retell can call tools as
freely as a conversation needs while guessing the token gets you nowhere. Tool routes
authenticate before the body is read, so an unauthenticated caller never gets this
process to parse its JSON.

**Daily ceilings**, counted across everybody and reset at midnight Asia/Riyadh:
`BONA_MAX_CHATS_PER_DAY` (300), `BONA_MAX_CALLS_PER_DAY` (60) → 503
`budget_exhausted`; `BONA_MAX_TURNS_PER_SESSION` (40) → 429 `session_limit`. Each is
logged once when it trips, and `/health` carries the running counters.

---

## 3. curl examples

```bash
API=https://api.bona.azoz.uk        # or http://localhost:4102 while testing

# health
curl -s $API/health | jq

# open a chat and ask something
SID=$(curl -s -X POST $API/v1/chat/session \
      -H 'Content-Type: application/json' -H 'Origin: https://bona.azoz.uk' \
      -d '{"locale":"ar","page":{"url":"https://bona.azoz.uk/ar/","title":"بونا"}}' | jq -r .sessionId)

curl -s -X POST $API/v1/chat/message \
  -H 'Content-Type: application/json' -H 'Origin: https://bona.azoz.uk' \
  -d "{\"sessionId\":\"$SID\",\"text\":\"أبغى فيلا في الخالدية\"}" | jq

curl -s -X POST $API/v1/chat/end -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SID\"}"

# a web-call token (the widget passes accessToken to RetellWebClient.startCall)
curl -s -X POST $API/v1/call/token -H 'Content-Type: application/json' \
  -H 'Origin: https://bona.azoz.uk' -d '{"locale":"en"}' | jq

# what Dana has shown during that call
curl -s $API/v1/call/<callId>/context | jq

# a tool webhook, exactly as Retell sends it
TOKEN=$(grep '^BONA_TOOL_TOKEN=' ~/.secrets/bona-services.env | cut -d= -f2)
curl -s -X POST "$API/v1/tools/search_properties" \
  -H "X-Bona-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"call":{"call_id":"c1"},"name":"search_properties","args":{"district":"Al Khalidiyah"}}'
```

The tool response body is a **JSON string** whose content is compact JSON — the shape
Retell's own example returns (`res.json("…")`). Retell truncates tool results at
~4000 characters, which is why `search_properties` returns at most five slim rows.

---

## 4. Environment

Secrets are read by the process itself from `~/.secrets/*.env` (mode 0600) and are
never logged. `process.env` always wins over a file.

| File | Keys used |
|---|---|
| `~/.secrets/retell.env` | `RETELL_API_KEY` |
| `~/.secrets/evolution-api.env` | `EVOLUTION_API_URL`, `EVOLUTION_API_KEY` |
| `~/.secrets/bona-services.env` | everything below |

| Variable | Default | Notes |
|---|---|---|
| `BONA_API_PORT` | `4102` | |
| `BONA_API_HOST` | `127.0.0.1` | the tunnel is the only way in |
| `BONA_SITE` | `https://bona.azoz.uk` | used to absolutise image and page URLs |
| `BONA_PUBLIC_API` | `https://api.bona.azoz.uk` | baked into the Retell tool URLs |
| `BONA_TOOL_TOKEN` | *(generated)* | 32 hex; gates `/v1/tools/*` and the webhook |
| `BONA_ALLOW_QUERY_TOKEN` | `0` | `1` also accepts `?token=` on `/v1/tools/*` (the webhook always does) |
| `BONA_TRUSTED_PROXY` | — | comma separated; addresses allowed to set `CF-Connecting-IP` |
| `BONA_DATA` | `~/bona-data` | `leads.jsonl`, `calls.jsonl`, `chats.jsonl` |
| `BONA_REPO` | `~/bona-bot` | checkout whose `src/data/listings.json` is served |
| `BONA_INVENTORY_FILE` | — | overrides the two rules above outright |
| `BONA_CORS_ORIGINS` | site, Pages, localhost:4321 | comma separated |
| `BONA_RETELL_VOICE_AGENT_ID` / `_CHAT_AGENT_ID` | from `ids.json` | env wins |
| `BONA_RETELL_MODEL` / `_MODEL_FALLBACK` | `claude-4.6-sonnet` / `gpt-4.1` | |
| `BONA_RETELL_SEPARATE_CHAT_AGENT` | `1` | `0` reuses the voice agent for chat |
| `BONA_RETELL_MOCK` | `0` | `1` answers chat locally, contacts no one |
| `BONA_WA_NOTIFY` | `1` | `0` stops the WhatsApp lead note |
| `BONA_RATE_CHAT` / `BONA_RATE_TOKEN` | `30` / `6` | per IP per minute |
| `BONA_RATE_TOOL` / `BONA_RATE_TOOL_AUTH_FAIL` | `600` / `10` | per IP per minute |
| `BONA_MAX_CHATS_PER_DAY` / `BONA_MAX_CALLS_PER_DAY` | `300` / `60` | reset at midnight Asia/Riyadh |
| `BONA_MAX_TURNS_PER_SESSION` | `40` | one chat cannot run for ever |

Inventory resolution order: `BONA_INVENTORY_FILE` → `$BONA_REPO/src/data/listings.json`
→ the checkout the service is running from. The file's mtime is checked with one cheap
`stat`, at most every 30 seconds, and the file is re-read as soon as it changes — so a
WhatsApp-intake publish is being served within half a minute, without a restart. Failing
that it is re-read every 10 minutes anyway. A broken `listings.json` keeps the last good
copy in memory; a *first* load that yields nothing makes `/health` answer
`503 { ok: false, inventory: 0 }` rather than quietly serving an empty portfolio.

---

## 5. Provisioning Retell

```bash
cd ~/bona/services

node api/retell/provision.mjs --dry-run   # prints every payload, calls nothing
node api/retell/provision.mjs             # creates or updates, writes retell/ids.json
node api/retell/provision.mjs --publish   # also publishes both agent versions
node api/retell/provision.mjs --ensure-env  # only create ~/.secrets/bona-services.env
```

Idempotent: it reads `api/retell/ids.json` (committed — ids are not secrets), verifies
each object still exists in Retell, and updates it in place. An id that has been
deleted upstream is recreated; a knowledge base created by hand is adopted by name.
Re-running never leaves duplicate agents in the account.

What it creates:

1. **Knowledge base "Bona site"** — `knowledge_base_urls: [/llms-full.txt, /llms.txt]`,
   `enable_auto_refresh: true` (Retell re-fetches every 12 h). `POST /create-knowledge-base`
   is `multipart/form-data`, and an array field is **one** field holding a JSON-encoded
   array — verified against the live API on 2026-09-06: repeating the field name gives a
   500, and so does sending a JSON body.
2. **Retell LLM "Bona Dana"** — `general_prompt` from `api/retell/prompt.md`, bilingual
   `begin_message`, `start_speaker: agent`, `knowledge_base_ids`, and three custom
   tools pointing at `${BONA_PUBLIC_API}/v1/tools/<name>`, each carrying the token in an
   `X-Bona-Token` header (Retell's `CustomTool` takes a `headers` object, so the token
   never enters a URL). The agent `webhook_url` still carries `?token=`: Retell sends no
   custom headers with agent webhooks, only its own `X-Retell-Signature`.
   Model `claude-4.6-sonnet`, falling back to `gpt-4.1` on any 4xx.
3. **Voice agent "Bona Dana (voice)"** — `11labs-Nyla` / `eleven_flash_v2_5`,
   `language: ["ar-SA","en-US"]`, responsiveness 1, interruption sensitivity 0.8,
   backchannel on, 30 s silence hang-up, 15 min cap, webhook → `/v1/retell/webhook`.
4. **Chat agent "Bona Dana (chat)"** — the same LLM through `POST /create-chat-agent`.

**Why two agents.** Retell models chat agents as their own object: `/create-chat-agent`
and `/update-chat-agent/{id}` are separate endpoints from `/create-agent`, an agent
carries a read-only `channel` field (`"voice"` on the existing "Lisa" agent), and
`POST /create-chat` documents `agent_id` as "the chat agent to use for the chat" — a
voice agent id is not accepted. Both agents share one Retell LLM, so the persona,
prompt and tools live in exactly one place. Set
`BONA_RETELL_SEPARATE_CHAT_AGENT=0` to fall back to a single agent if that ever
changes.

**Publishing.** Not required: the existing "Lisa" agent runs unpublished (draft
version 0) and `create-web-call` / `create-chat` accept it. `--publish` is there if a
future account setting demands a published version.

After provisioning, restart the service so it picks up the new ids:

```bash
systemctl --user restart bona-api
```

---

## 6. Install and run

Deployment is the **owner's** command — creating a Cloudflare tunnel and routing DNS
is refused by the agent's permission classifier:

```bash
bash ~/bona/services/deploy/install.sh
```

It checks prerequisites, creates the tunnel `bona` (if absent), writes
`~/.cloudflared/bona.yml` with `api.bona.azoz.uk → http://localhost:4102` plus a
catch-all 404, routes DNS, installs the two systemd `--user` units, enables linger,
and health-checks both the local and the public endpoint. Safe to re-run; nothing is
duplicated. `--no-dns` installs the units only, `--restart` forces a restart,
`--uninstall` stops and disables both units.

Run it in the foreground instead, for a quick look:

```bash
cd ~/bona/services && node api/index.mjs
BONA_RETELL_MOCK=1 node api/index.mjs      # no Retell traffic at all
```

---

## 7. Tests

```bash
cd ~/bona/services && node --test api/test/*.test.mjs
```

184 tests, no network and no Retell: search and Card formatting in EN and AR, price
parsing ("4.5m", "٤ ملايين"), token buckets and the trusted-proxy rules for client IPs,
the CORS allowlist and the origin refusal, tool authentication (header, bearer, and the
auth-failure throttle), the navigation allowlist, lead de-duplication, the daily
budgets and their Riyadh-midnight reset, inventory hot-reload and degraded health,
action extraction from mocked Retell messages, every HTTP route against a scripted
Retell double, and the provisioning payloads including the model fallback.

---

## 8. Runbook

| Symptom | Where to look |
|---|---|
| Widget shows the WhatsApp fallback | `curl https://api.bona.azoz.uk/health`; then `systemctl --user status bona-api cloudflared-bona` |
| `503 not_provisioned` | `node api/retell/provision.mjs`, then `systemctl --user restart bona-api` |
| `/health` says `retell: "error"` | Retell key or balance — `journalctl --user -u bona-api -n 50` |
| Chat works, calls do not | mic permission in the browser, then the voice agent id in `ids.json` |
| Dana quotes a property that is gone | `curl -s https://api.bona.azoz.uk/health \| jq .inventory`; the file reloads within 30 s of a publish |
| No lead reached WhatsApp | the lead is still in `~/bona-data/leads.jsonl`; check `EVOLUTION_API_URL` reachability |
| Tool webhooks 401 | `BONA_TOOL_TOKEN` changed after provisioning — re-run `provision.mjs` so the tools carry the new header |
| `503 budget_exhausted` | the day's chat/call ceiling is spent; `journalctl … \| grep budget.exhausted`, raise `BONA_MAX_*` if that is the answer |
| `503 billing` | the owner's Retell balance is empty — top it up; the log line says so loudly |
| `/health` 503, `inventory: 0` | `listings.json` is missing or broken at the path in `redacted` config; fix it, no restart needed |
| PC is off | everything pauses; the site falls back to WhatsApp and no data is lost |

Logs are one JSON object per line: `journalctl --user -u bona-api -f`.

Data files, all append-only JSON lines under `~/bona-data`:
`leads.jsonl` (every enquiry), `calls.jsonl` (voice events and transcripts),
`chats.jsonl` (one line per finished chat).

---

## 9. Cost

Retell bills the owner's Retell balance per voice minute and per chat message; there
is no separate LLM key. The knowledge base re-crawls two static text files every 12
hours. Cloudflare Tunnel is free. The tighter budget on `/v1/call/token` (6 per IP per
minute) is the guard against someone opening calls in a loop — a web call is the only
route here that costs money by the minute.
