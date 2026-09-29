# Bona services

Back-office processes for [bona-real-estate.com](https://bona-real-estate.com). The site itself is a
static Astro build on GitHub Pages, so anything that needs a server lives here.

| Service | Directory | Unit | What it does |
|---|---|---|---|
| Concierge API (Dana) | `api/` | `bona-api.service` | Chat + voice concierge backend, Retell tool webhooks, first-party events, leads |
| Public HTTPS | — | `cloudflared-bona.service` | Cloudflare tunnel `bona`: `api.bona-real-estate.com` (+ legacy hosts) → `127.0.0.1:4120` on the VPS |
| WhatsApp intake | `intake/` | `bona-intake.service` | PDF brochure → published listing; group commands `remove` / `hero` / `price` / `brochure` / `sold` / `hide` / `licence` / `wafi` (see `intake/README.md`) |

No runtime dependencies: `services/package.json` is `"dependencies": {}` and the API
is built on Node's own `http`. Node ≥ 22.

---

## 1. The concierge, end to end

```
visitor on bona-real-estate.com
        │  fetch (CORS allowlist)
        ▼
api.bona-real-estate.com  ──Cloudflare tunnel "bona"──▶  bona-api on 127.0.0.1:4120 on the VPS
        │                                                          │
        │  POST /create-chat, /create-chat-completion, /v2/create-web-call
        ▼                                                          │
   Retell AI  ── custom tool webhooks ─────────────────────────────┘
   (agent "Dana", one Retell LLM, two agents: voice + chat)
```

Retell hosts the model, so there is no LLM API key here — usage bills to the owner's
Retell balance. The API's job is to broker sessions, answer the three tool webhooks
from Bona's own inventory, and record leads and calls.

The same process is also the site's first-party tracking backend: the site posts one
small event per visitor action to `/v1/events`, the enquiry forms post to
`/v1/enquiry`, and every lead — from WhatsApp, a form, or Dana — lands in one SQLite
store (`bona.db`) with the campaign that brought the visitor. The **ad-platform
fan-out worker** (`lib/fanout.mjs`) re-sends the moments a browser pixel loses — a
WhatsApp click, a lead — to Meta's Conversions API, GA4's Measurement Protocol and
Snap's Conversions API, under the same `event_id` the pixel used, so the two are
counted once. It is entirely optional: a destination with no credentials in
`~/.secrets/bona-marketing.env` has its rows marked `skipped` rather than queued, and
starts flowing the moment the ids and tokens are filled in. A row is sent only for a
session that accepted **ads** in the consent banner (PDPL); the phone never leaves
this process unhashed. `/health` reports `fanout: { pending, sent, failed, skipped,
dests, running }`, and `poller: { lastRun, lastTs, lagS, unmatched, matched, running }`
for the read-only WhatsApp loop that turns a `Ref` code into a lead with its campaign
(§10). The owner dashboard (`/dashboard`, `/v1/admin/*`) builds on the same store and
arrives in its own workstream.

---

## 2. HTTP contract

Every response is `Cache-Control: no-store`, and every response but the dashboard's own
pages is `Content-Type: application/json`. Browser-facing routes are CORS-allowlisted;
Retell-facing routes are token-gated and deliberately **not** CORS-readable, and neither
are the dashboard and its admin JSON.

One thing happens before any of that. A request whose `Host` is a legacy site host —
`bona.azoz.uk`, left stranded because GitHub Pages serves only one
custom domain — is answered with a `301` to the same path and query on `BONA_SITE`,
ahead of CORS, the rate limiters, the token check and the routing table. The old host's
DNS points at this API's tunnel for exactly that reason; see `BONA_LEGACY_HOSTS`.

| Route | Body → Response |
|---|---|
| `GET /health` | → `{ ok, service:"bona-api", version, uptimeS, retell:"ok"\|"error", db:"ok"\|"error", inventory:<count>, budget }` — 503 when `inventory` is 0 |
| `POST /v1/chat/session` | `{ locale, page?, attr? }` → `{ sessionId, greeting }` |
| `POST /v1/chat/message` | `{ sessionId, text, locale?, page? }` → `{ messages, actions, leadCaptured? }` |
| `POST /v1/chat/end` | `{ sessionId }` → `{ ok: true }` |
| `POST /v1/call/token` | `{ locale, page?, attr? }` → `{ accessToken, callId }` |
| `GET /v1/call/:callId/context` | → `{ listings: Card[], updatedAt }` |
| `POST /v1/tools/<name>` | Retell custom tool (`X-Bona-Token:`) → a JSON string result |
| `POST /v1/retell/webhook?token=` | Retell agent events → `calls.jsonl` / `chats.jsonl` |
| `POST /v1/events` | one first-party event (`text/plain` or JSON, ≤ 8 KB) → `204`, or `400 { error:"bad_event", reason }` |
| `POST /v1/enquiry` | `{ form, name, phone, … }` from the site's forms → `{ lead_id }` |
| `GET /dashboard/*` | the owner's private dashboard — HTML, `bona_dash` cookie login by WhatsApp code (§10) |
| `GET`/`POST` `/v1/admin/*` | the same data as JSON and every write, behind the same cookie (§10) |

`page` is `{ url, title }` and becomes the dynamic variables `{{page_url}}` and
`{{page_title}}`; `locale` becomes `{{locale}}`. `attr` is the optional
`{ anon_id, session_id, ref, listing_id }` the widget reads from the site's
attribution script; the ids ride to Retell as `metadata`, come back on every tool
call, and are how a lead Dana saves inherits the campaign that brought the visitor.
Malformed ids are dropped, never a 400.

### Events

The site's `attribution.js` posts one object per visitor action:

```jsonc
{ "v": 1, "event_id": "mf3k2a1b-9c4e7f21", "ts": 1757150000000, "event": "whatsapp_click",
  "anon_id": "9f1c…32 hex", "session_id": "mf3k2a-7b1c", "ref": "K7Q2XR",
  "page": "/properties/bona-w003/", "locale": "en", "listing_id": "BONA-W003",
  "props": { "cta": "listing_whatsapp", "href": "https://wa.me/…" },
  "attr": { "first": { /* touch */ }, "last": { /* touch */ }, "fbp": "fb.1.…", "fbc": "fb.1.…",
            "ga": { "client_id": "123.456", "session_id": "1757149000" }, "scid": null, "ttp": null },
  "consent": { "analytics": true, "ads": true } }
```

A *touch* is `{ ts, landing, referrer, utm_source, utm_medium, utm_campaign,
utm_content, utm_term, utm_id, click_ids: { fbclid, gclid, … } }`. Browser event
names: `page_view listing_view gallery_open tour_open video_play brochure_download
whatsapp_click call_click form_submit consent_update concierge_open`. The server-only
names `concierge_chat_start concierge_call_start lead_created lead_stage` are refused
from a browser. Shapes: `anon_id` 32 hex, `session_id` `[a-z0-9-]{6,24}`, `ref`
`[A-HJ-NP-Z2-9]{5,6}`, `event_id` `[a-z0-9-]{8,40}`, `listing_id` `BONA-W?\d{3}`;
strings are capped at 300 characters, `props` at 2 KB, the body at 8 KB; unknown keys
are dropped; a `ts` more than a week from now is replaced by now. Each event upserts
the session (first touch kept from the first event, last touch and consent moved) and
stores the event with the server's view: client IP, user agent, and Cloudflare's
`CF-IPCountry` (believed only from the tunnel, like the IP). A `whatsapp_click` is
queued for Meta's Conversions API under the same `event_id` the browser pixel sends,
so Meta de-duplicates the pair.

### Ref line

The site appends `Ref BONA-W003 · K7Q2XR` to every prefilled WhatsApp message —
the listing and the session's six-character code (alphabet
`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, no 0/O/1/I). `lib/attribution.mjs` reads it
back out of an inbound message, in any spelling a phone keyboard produces, and
ties the sender to the exact session that produced the click.

### Enquiry

`{ form: "contact"|"sell"|"listing", name, phone, interest, type, budget, location,
message, listing_id, page, locale, event_id, attr, consent }`. Name (≥ 2 characters)
and a phone that normalises (7–15 digits after Arabic digits and punctuation are
folded) are the only hard requirements; everything else is optional and capped. The
route records a `form_submit` event under the browser's own `event_id` (a no-op when
the site already sent it), creates or merges the lead (`channel: "form"`), messages
the owner, and answers `{ lead_id }`. The form posts here *before* it opens WhatsApp,
so a lead lands even when the visitor never sends the message.

### Leads

Every enquiry — WhatsApp, form, or Dana's `create_lead` — goes through one write
path (`createOrMergeLead` in `lib/leads.mjs`). A lead merges on the normalised phone
(`966593296933`, whatever the spelling), or failing that on the WhatsApp jid; a merge
fills what is empty and appends notes, never blanks a name, and leaves a touchpoint.
Source, medium and campaign are resolved once, at creation, from the visitor's
session's **last** touch (UTMs, else a click id, else the referrer host); the first
touch is kept alongside. Stages: `new contacted qualified viewing offer negotiation
won lost`. A new lead also writes a `lead_created` event queued for Meta, GA4 and
Snap, and still appends its line to `leads.jsonl`.

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
  "url":   { "en": "https://bona-real-estate.com/properties/…/", "ar": "https://bona-real-estate.com/ar/properties/…/" }
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
| 400 | malformed JSON, or empty `text`; `bad_event` on `/v1/events`; `bad_request` with a message on `/v1/enquiry` |
| 401 | wrong or missing tool token |
| 403 | `forbidden_origin` — an `Origin` that is not on the allowlist, or no `Origin` at all |
| 404 | unknown route, unknown tool, expired `sessionId` |
| 405 | known route, wrong method |
| 413 | body over 16 KB (8 KB on `/v1/events`) |
| 415 | a browser POST that is not `application/json` (`/v1/events` and `/v1/enquiry` also take `text/plain`) |
| 429 | `rate_limited` (`Retry-After` in seconds), or `session_limit` — this chat hit its turn cap |
| 500 | unexpected failure |
| 502 | `upstream_error` — Retell unreachable or broken |
| 503 | `not_provisioned` · `budget_exhausted` (the day's ceiling) · `billing` (Retell balance empty) |

**Who may call.** Browser routes are origin-checked **fail-closed**, *before* Retell is
contacted, before the body is parsed and before anything is written: an `Origin` that is
not on the allowlist is 403, and so is no `Origin` at all. CORS alone only stops the
browser *reading* the answer — by then the call has already cost money, created a lead and
messaged the owner.

This is defence in depth, not authentication. A non-browser caller sets whatever header it
likes, so what this actually turns away is the accidental and the scripted: a scraper, a
copied curl, a client written without thinking about it. Every legitimate caller is a
cross-origin `fetch` from the site, which the browser always stamps with an `Origin`, so
nothing real loses by it. What bounds a determined caller is the per-IP limiter and the
daily Retell budget below it. The token-gated Retell routes (`/v1/tools/*`,
`/v1/retell/webhook`) are unaffected — Retell sends no origin and authenticates with
`X-Bona-Token`.

The allowlist is `BONA_CORS_ORIGINS`, or `DEFAULT_ORIGINS` in `lib/cors.mjs` when that is
unset — and the site's own origin from `src/data/site.json` is unioned into it either way,
so a domain move cannot lock the browser out of its own API.

**Rate limits**, per IP, per minute: chat 30, `/v1/call/token` 6, `/v1/enquiry` 6,
`/v1/events` 240, call context 120, tool routes 600, and *failed* tool
authentications 10 — so Retell can call tools as freely as a conversation needs while
guessing the token gets you nowhere. Events and enquiries are never charged to the
daily Retell ceilings. Tool routes
authenticate before the body is read, so an unauthenticated caller never gets this
process to parse its JSON.

**Daily ceilings**, counted across everybody and reset at midnight Asia/Riyadh:
`BONA_MAX_CHATS_PER_DAY` (300), `BONA_MAX_CALLS_PER_DAY` (60) → 503
`budget_exhausted`; `BONA_MAX_TURNS_PER_SESSION` (40) → 429 `session_limit`. Each is
logged once when it trips, and `/health` carries the running counters.

---

## 3. curl examples

Every browser-facing route is origin-checked **fail-closed**: a request with an origin that
is not on the allowlist — or with no `Origin` header at all — is `403 forbidden_origin`
before anything is parsed, charged or written. So each example below states one. (The
token-gated Retell routes are the exception: Retell sends no origin, and it authenticates
with `X-Bona-Token` instead.)

```bash
API=https://api.bona-real-estate.com   # or http://localhost:4102 while testing

# health
curl -s $API/health | jq

# open a chat and ask something
SID=$(curl -s -X POST $API/v1/chat/session \
      -H 'Content-Type: application/json' -H 'Origin: https://bona-real-estate.com' \
      -d '{"locale":"ar","page":{"url":"https://bona-real-estate.com/ar/","title":"بونا"}}' | jq -r .sessionId)

curl -s -X POST $API/v1/chat/message \
  -H 'Content-Type: application/json' -H 'Origin: https://bona-real-estate.com' \
  -d "{\"sessionId\":\"$SID\",\"text\":\"أبغى فيلا في الخالدية\"}" | jq

curl -s -X POST $API/v1/chat/end -H 'Content-Type: application/json' \
  -H 'Origin: https://bona-real-estate.com' -d "{\"sessionId\":\"$SID\"}"

# a web-call token (the widget passes accessToken to RetellWebClient.startCall)
curl -s -X POST $API/v1/call/token -H 'Content-Type: application/json' \
  -H 'Origin: https://bona-real-estate.com' -d '{"locale":"en"}' | jq

# what Dana has shown during that call
curl -s $API/v1/call/<callId>/context | jq

# a first-party event, exactly as the site sends it (text/plain, no preflight) -> 204
curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/v1/events \
  -H 'Content-Type: text/plain' -H 'Origin: https://bona-real-estate.com' \
  --data '{"v":1,"event_id":"mf3k2a1b-9c4e7f21","ts":1757150000000,"event":"whatsapp_click","anon_id":"9f1c9f1c9f1c9f1c9f1c9f1c9f1c9f1c","session_id":"mf3k2a-7b1c","ref":"K7Q2XR","page":"/properties/bona-w003/","locale":"en","listing_id":"BONA-W003","props":{"cta":"listing_whatsapp"},"attr":{"first":{"utm_source":"meta","utm_medium":"paid"},"last":{"utm_source":"meta","utm_medium":"paid"}},"consent":{"analytics":true,"ads":true}}'

# an enquiry form -> { lead_id }.  The site posts this as text/plain + keepalive (a CORS
# simple request, no preflight) so the lead survives the hand-off to WhatsApp on mobile;
# application/json is accepted too.  The routes that spend Retell money stay JSON-only.
curl -s -X POST $API/v1/enquiry -H 'Content-Type: text/plain' -H 'Origin: https://bona-real-estate.com' \
  -d '{"form":"listing","name":"Sara","phone":"0500000000","listing_id":"BONA-W003","message":"Still available?","attr":{"anon_id":"9f1c9f1c9f1c9f1c9f1c9f1c9f1c9f1c","session_id":"mf3k2a-7b1c","ref":"K7Q2XR"}}'

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
| `~/.secrets/bona-marketing.env` | `META_PIXEL_ID`, `META_CAPI_TOKEN`, `META_TEST_EVENT_CODE`, `GA4_MEASUREMENT_ID`, `GA4_API_SECRET`, `SNAP_PIXEL_ID`, `SNAP_CAPI_TOKEN` — read last, so it wins among files; every key optional, and a missing one skips that destination rather than failing (the fan-out marks those rows `skipped`). Template: `deploy/bona-marketing.env.example`, copied there by `install.sh` |

| Variable | Default | Notes |
|---|---|---|
| `BONA_API_PORT` | `4102` | `4120` on the VPS (set in its unit; 4102 is taken there) |
| `BONA_API_HOST` | `127.0.0.1` | the tunnel is the only way in |
| `BONA_SITE` | `https://bona-real-estate.com` | used to absolutise image and page URLs |
| `BONA_PUBLIC_API` | `https://api.bona-real-estate.com` | baked into the Retell tool URLs |
| `BONA_TOOL_TOKEN` | *(generated)* | 32 hex; gates `/v1/tools/*` and the webhook |
| `BONA_ALLOW_QUERY_TOKEN` | `0` | `1` also accepts `?token=` on `/v1/tools/*` (the webhook always does) |
| `BONA_TRUSTED_PROXY` | — | comma separated; addresses allowed to set `CF-Connecting-IP` |
| `BONA_DATA` | `~/bona-data` | `bona.db`, `leads.jsonl`, `calls.jsonl`, `chats.jsonl` |
| `BONA_DB_FILE` | `$BONA_DATA/bona.db` | the SQLite store (WAL; created 0600) |
| `BONA_REPO` | `~/bona-bot` | checkout whose `src/data/listings.json` is served |
| `BONA_INVENTORY_FILE` | — | overrides the two rules above outright |
| `BONA_CORS_ORIGINS` | site, Pages, localhost:4321 | comma separated |
| `BONA_LEGACY_HOSTS` | `bona.azoz.uk` | comma separated; each is 301'd to `BONA_SITE`, path and query kept. Anything listed must also be routed to the tunnel via `BONA_EXTRA_HOSTNAMES` |
| `BONA_RETELL_VOICE_AGENT_ID` / `_CHAT_AGENT_ID` | from `ids.json` | env wins |
| `BONA_RETELL_MODEL` / `_MODEL_FALLBACK` | `claude-4.6-sonnet` / `gpt-4.1` | |
| `BONA_RETELL_SEPARATE_CHAT_AGENT` | `1` | `0` reuses the voice agent for chat |
| `BONA_RETELL_MOCK` | `0` | `1` answers chat locally, contacts no one |
| `BONA_WA_NOTIFY` | `1` | `0` stops the WhatsApp lead note and team members' replies from the dashboard inbox; login codes still go |
| `BONA_WA_POLL` | `1` | the in-process WhatsApp poller defaults to ON inside the process (`lib/config.mjs`); opt out with `BONA_WA_POLL=0` in `bona-services.env`. No unit sets it — an `Environment=` line would override the file (§10) |
| `BONA_WA_POLL_MS` | `20000` | poll interval; each tick reads the last 2 minutes of `chat/findMessages`. 20 s since Phase 2 of the team inbox (it was 45 s); the VPS sets it in `bona-services.env`, and a value there wins over this default |
| `BONA_WA_INSTANCE` | `abdulaziz-personal` | the Evolution instance the poller reads and the note is sent from |
| `BONA_OWNER_JID` | `966593296933@s.whatsapp.net` | where the notes go, and the one chat the poller never reads |
| `BONA_FANOUT_MS` | `20000` | fan-out worker interval (Meta CAPI, GA4 MP, Snap CAPI) |
| `BONA_DB_FILE` | `${BONA_DATA}/bona.db` | the SQLite lead store (0600); set only to move it |
| `BONA_DASH_COOKIE_DAYS` | `30` | how long a dashboard login lasts (the `bona_dash` cookie and its row in `auth_sessions`) |
| `BONA_RATE_CHAT` / `BONA_RATE_TOKEN` | `30` / `6` | per IP per minute |
| `BONA_RATE_TOOL` / `BONA_RATE_TOOL_AUTH_FAIL` | `600` / `10` | per IP per minute |
| `BONA_MAX_CHATS_PER_DAY` / `BONA_MAX_CALLS_PER_DAY` | `300` / `60` | reset at midnight Asia/Riyadh |
| `BONA_MAX_TURNS_PER_SESSION` | `40` | one chat cannot run for ever |
| `BONA_RATE_EVENTS` / `BONA_RATE_ENQUIRY` | `240` / `6` | per IP per minute |
| `BONA_FANOUT_MS` | `20000` | ad-platform fan-out worker interval; `0` turns the worker off |
| `BONA_FANOUT_REQUIRE_CONSENT` | `1` | fan out only for a session that accepted ads (PDPL) |

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
node api/retell/provision.mjs --rebuild-kb  # replace the knowledge base after a site move
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
   **After a site move, use `--rebuild-kb`.** Retell has no endpoint that re-points a
   knowledge base at new URLs, so a base created for the old domain keeps auto-refreshing
   URLs that now 404 — a silent decay, since nothing errors. A plain run therefore compares
   the base's `knowledge_base_sources` against `BONA_SITE` and warns; `--rebuild-kb` creates
   the replacement, moves the LLM's `knowledge_base_ids` to it, and only then deletes the old
   one, so a failure anywhere leaves Dana on a stale base rather than on none.
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

After provisioning, restart the service so it picks up the new ids (the live one is on the VPS;
`ids.json` reaches `/opt/bona` with the next `bona-repo-sync` pull, or run `deploy.sh`):

```bash
ssh hermes-vps sudo systemctl restart bona-api
```

---

## 6. Install and run

### Where it runs (since 2026-09-08): the VPS

The live `bona-api` runs on the VPS (`ssh hermes-vps`) as **system** units in `/etc/systemd/system`
that run as user `azoz` (`User=azoz`, driven with `sudo systemctl`, never `systemctl --user`):
`bona-api.service` (port **4120**, loopback) and `cloudflared-bona.service` (tunnel `bona`, hostnames
`api.bona-real-estate.com`, `bona-api.azoz.uk`, `bona.azoz.uk`), from a sparse checkout of this repo
at `/opt/bona` that `bona-repo-sync.timer` fast-forwards every 5 minutes (so listings published by
the intake reach Dana's inventory without a deploy). Data: `~/bona-data`. Secrets: `~/.secrets/*.env`.
Why system units: Ubuntu 24.04 restricts unprivileged user namespaces, and a `systemctl --user` unit
cannot apply the hardening directives (`ProtectSystem`, `PrivateTmp`, …) — it dies with
`218/CAPABILITIES`; the same directives under `User=` in a system unit run fine (first live attempt,
2026-09-08). `azoz` has passwordless sudo, and every script uses `sudo -n` (never a prompt).

| I want to… | Run |
|---|---|
| deploy a code change (pull, test, restart, health) | `ssh hermes-vps bash /opt/bona/services/deploy/vps/deploy.sh` |
| see logs | `ssh hermes-vps sudo journalctl -u bona-api -f` (tunnel: `-u cloudflared-bona`) |
| unit status / restart by hand | `ssh hermes-vps sudo systemctl status bona-api cloudflared-bona` / `… sudo systemctl restart bona-api` |
| is the repo-sync timer ticking | `ssh hermes-vps sudo systemctl list-timers bona-repo-sync.timer` |
| check readiness / what is missing | `ssh hermes-vps bash /opt/bona/services/deploy/vps/install-vps.sh --check` |
| copy changed secrets from the PC | `bash services/deploy/vps/sync-secrets.sh` (on the PC) |
| bring it back to the PC | `bash services/deploy/vps/rollback.sh [--copy-back]` (on the PC) |

`install.sh` in this directory is the **PC/WSL** installer and is kept only for rollback; its units
are disabled on the PC. `bona-intake` (WhatsApp PDF → listing) still runs on the PC — it needs the
owner's Claude login — and never talks to the API. Scripts: the header comment of each script in
`services/deploy/vps/`; the move itself: `docs/superpowers/specs/2026-09-08-bona-api-vps-move-design.md`.

### Legacy / rollback only: the PC installer

Everything in this subsection describes the **PC path, which is no longer live**. It exists
so `rollback.sh` has something to come back to; do not run it to "deploy" — that is
`ssh hermes-vps bash /opt/bona/services/deploy/vps/deploy.sh` (table above).

Running the PC installer is the **owner's** command — creating a Cloudflare tunnel and routing
DNS is refused by the agent's permission classifier:

```bash
bash ~/bona/services/deploy/install.sh        # legacy / rollback only
```

It checks prerequisites, creates the tunnel `bona` (if absent), writes the PC's
`~/.cloudflared/bona.yml` with `bona-api.azoz.uk → http://localhost:4102` plus a
catch-all 404, routes DNS, installs the two systemd `--user` units on the PC, enables linger,
and health-checks both the local and the public endpoint. Safe to re-run; nothing is
duplicated. `--no-dns` installs the units only, `--restart` forces a restart,
`--uninstall` stops and disables both units. While the VPS is live the PC units stay
**disabled**: two APIs or two tunnel connectors must never run (`cutover.sh` / `rollback.sh`
enforce that; a manual `--restart` here would break it).

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

477 tests, no network, no Retell and no WhatsApp: search and Card formatting in EN and AR, price
parsing ("4.5m", "٤ ملايين"), token buckets and the trusted-proxy rules for client IPs,
the CORS allowlist and the origin refusal, tool authentication (header, bearer, and the
auth-failure throttle), the navigation allowlist, lead de-duplication, the daily
budgets and their Riyadh-midnight reset, inventory hot-reload and degraded health,
action extraction from mocked Retell messages, every HTTP route against a scripted
Retell double, the provisioning payloads including the model fallback, the phone
normaliser, the SQLite store and its migrations, the Ref parser and source
resolution, the event validator and intake, the lead model (create, merge by phone
or jid, touchpoints, stages, fan-out), the enquiry route and the text/plain media type
the form actually posts, the fan-out worker (credentials absent, consent absent,
payload shape, hashing, delivery, backoff and giving up, and the stage-move mapping),
the Retell metadata plumbing, the one-time JSONL import, and the dashboard: the login
code's whole life (hashes only, all three rate limits, five wrong guesses, expiry,
cookie flags, and a stranger failing to burn the code the owner is holding), every
statistic over a seeded store, and every route through the real HTTP server — the
redirect when logged out, the login round trip with the code read back out of the
mocked WhatsApp message, the write gates, and a lead named `<script>` rendering as
text.

---

## 8. Runbook

The live service is on the VPS: every `systemctl` / `journalctl` below runs there (`ssh hermes-vps sudo …`
— the units are system units, see §6). On the PC (only after `rollback.sh` has brought the service
back, legacy path) the same commands are `systemctl --user …` / `journalctl --user …` without sudo.

| Symptom | Where to look |
|---|---|
| Widget shows the WhatsApp fallback | `curl https://bona-api.azoz.uk/health`; then `ssh hermes-vps sudo systemctl status bona-api cloudflared-bona` |
| `503 not_provisioned` | `node api/retell/provision.mjs`, then `ssh hermes-vps sudo systemctl restart bona-api` |
| `/health` says `retell: "error"` | Retell key or balance — `ssh hermes-vps sudo journalctl -u bona-api -n 50` |
| Chat works, calls do not | mic permission in the browser, then the voice agent id in `ids.json` |
| Dana quotes a property that is gone | `curl -s https://bona-api.azoz.uk/health \| jq .inventory`; the file reloads within 30 s of a publish |
| No lead reached WhatsApp | the lead is still in `~/bona-data/leads.jsonl`; check `EVOLUTION_API_URL` reachability |
| Tool webhooks 401 | `BONA_TOOL_TOKEN` changed after provisioning — re-run `provision.mjs` so the tools carry the new header |
| `503 budget_exhausted` | the day's chat/call ceiling is spent; `ssh hermes-vps sudo journalctl -u bona-api \| grep budget.exhausted`, raise `BONA_MAX_*` if that is the answer |
| `503 billing` | the owner's Retell balance is empty — top it up; the log line says so loudly |
| `/health` 503, `inventory: 0` | `listings.json` is missing or broken at the path in `redacted` config; fix it, no restart needed |
| Dashboard code never arrives | `/health` → `evolution` must be reachable; `ssh hermes-vps sudo journalctl -u bona-api \| grep dashboard`; the owner JID is `BONA_OWNER_JID` |
| `/health` `poller.lagS` keeps growing | Evolution outage or wrong `EVOLUTION_API_URL`; messages are picked up when it is back. Meanwhile login codes do not arrive, dashboard replies fail or come back uncertain (check WhatsApp before sending again), threads show only what is stored, and an automatic join or the inbox catch-up leaves a gap in the thread (opening the thread later reads the chat again) |
| `/health` `fanout.failed` > 0 | a key is wrong or expired — `node scripts/marketing/verify-integrations.mjs` says which; rows retry ≤ 5 times with backoff |
| PC is off | nothing happens to Dana (she runs on the VPS); only `bona-intake` (PC) pauses — legacy path: everything pauses, the site falls back to WhatsApp and no data is lost |

Logs are one JSON object per line: `ssh hermes-vps sudo journalctl -u bona-api -f`.

Data files under `~/bona-data` (owner-only, mode 0600):

| File | What |
|---|---|
| `bona.db` (+ `-wal`, `-shm`) | the SQLite store: sessions, events, leads, touchpoints, stage history, WhatsApp poller cursor, ad spend, fan-out queue, dashboard logins, the WhatsApp inbox (transcripts, outbox, read marks, gaps). Migrations run on start (`PRAGMA user_version`). Back it up with `sqlite3 bona.db ".backup …"`, not `cp`, while the service runs |
| `leads.jsonl` | the append-only raw log: one line per **new** lead, same `id` as the store's `lead_id`. Imported into `bona.db` once at startup (`import.legacy` in the log; a rerun is a no-op) |
| `calls.jsonl`, `chats.jsonl` | Retell webhook events and transcripts, one line per finished conversation |

- **Dana down, site shows the WhatsApp fallback** → `ssh hermes-vps sudo systemctl status bona-api cloudflared-bona`; `ssh hermes-vps sudo journalctl -u bona-api -n 50`. Uptime Kuma #25 (`api.bona-real-estate.com/health`, keyword `"retell":"ok"`) pages Telegram after ~3 minutes. If the VPS itself is gone: `bash services/deploy/vps/rollback.sh` on the PC restores the previous setup in about a minute.
- **Inventory stale after an intake publish** → `ssh hermes-vps sudo systemctl list-timers bona-repo-sync.timer` and `ssh hermes-vps sudo journalctl -u bona-repo-sync -n 5`; the API re-reads `listings.json` within 30 s of the pull.
- **A client asks for a WhatsApp conversation to be deleted** (the privacy page offers it) →
  the owner's *Not a client* on the chat deletes what this service stored of it — messages,
  gaps, read marks and reply outbox rows (a send of the last 24 h stays as a stub with no
  text and no chat, for the day cap) — and puts the chat `out`, where it never comes back on
  its own. It leaves the lead row (name, number, jids), its touchpoints (the `lead_created`
  one keeps the first ≤ 200 characters of the first message), stage history, notes and its
  line in `leads.jsonl`; no button removes those, so a request that covers the enquiry record
  too is a manual edit of `bona.db` and `leads.jsonl`. The gateway's copy is in Evolution's
  own Postgres, which keeps every message, and nothing here deletes from it
  (`lib/evolution.mjs` only reads, `lib/wa-send.mjs` only sends): remove that chat's messages
  there by hand, under both its jids (the `@lid` and the phone jid) — until then a *Move* or
  *Add* would pull its last 30 days back in. The phones' copy is deleted in WhatsApp on each
  phone.
- **A unit dies with `218/CAPABILITIES`** → it is running under the user manager again (`systemctl --user`), which Ubuntu 24.04's userns restriction forbids for the hardened units; re-run `install-vps.sh` (it retires the user units and reinstalls the system ones), then `cutover.sh` from the PC.

---

## 9. Cost

Retell bills the owner's Retell balance per voice minute and per chat message; there
is no separate LLM key. The knowledge base re-crawls two static text files every 12
hours. Cloudflare Tunnel is free. The tighter budget on `/v1/call/token` (6 per IP per
minute) is the guard against someone opening calls in a loop — a web call is the only
route here that costs money by the minute.

---

## 10. Tracking: WhatsApp poller, fan-out, dashboard

Design: `docs/superpowers/specs/2026-09-06-client-acquisition-tracking-design.md`. Owner
side: `docs/OWNER-RUNBOOK.md` §4, §9–§11 and `docs/checklists/`.

**Store.** `${BONA_DATA}/bona.db` (SQLite, WAL, mode 0600): sessions, events, leads,
touchpoints, stage history, spend, fan-out queue, dashboard auth, the transcripts of the
chats in the Bona inbox ([Dashboard → Inbox](#inbox), below) and the owner's list of
real-estate chats to check (ids, the WhatsApp name and property words, never text). The
JSONL files stay as the append-only raw log and are imported once on start-up. Ad platforms
get hashed identifiers only. The transcripts are shown only to signed-in team members, the
list to check only to the owner, and the
WhatsApp gateway (Evolution) is sent only what a message it delivers needs: your new-lead
note, a login code, a dashboard reply.

**Poller** (`BONA_WA_POLL=1`, every `BONA_WA_POLL_MS`; `lib/wa-poller.mjs` over
`lib/evolution.mjs`). A read-only loop inside this process. Each tick asks Evolution for
`POST /chat/findMessages/{instance}` with `{ messageTimestamp: { gte: <cursor − 2 min>,
lte: <now> } }` — both bounds, because 2.3.7 ignores the filter without them — read by
`readWindow`: pages of 100, newest first, up to 5, and a window whose `total` is larger than
that is split in halves by time instead (below); deduplicated on `key.id` (`wa_seen`,
pruned after 7 days).
Groups, status broadcasts and your own chat are skipped; an `…@lid` chat takes its phone
from `key.remoteJidAlt` and stores both jids. Evolution is **never** given a webhook: the
instance is your personal WhatsApp, and nothing consumes its events (checked 2026-09-27: no
webhook, websocket or queue; Lisa reads on demand and sends only on your request, through
the same API).

*Matched-only storage* (your decision). An incoming message is kept, as a new lead or on the
lead it belongs to, only when one of these claims it, in order — the first hit wins (Phase 2
adds the owner's own ways in, below the table):

| # | `match_method` | What claims it | The source it gets |
|---|---|---|---|
| 1 | `ref` | `Ref BONA-W003 · K7Q2XR`, the code the site prefills into every `wa.me` link | that session's last touch — the real campaign |
| 2 | `phone` | the sender is already a lead (phone, `wa_jid` or `wa_lid`) | unchanged; an `inbound_message` touchpoint is added |
| 3 | `ad_meta` | click-to-WhatsApp context: `externalAdReply`, `conversionSource`, `entryPointConversion*`, `utm` | `instagram` / `facebook` from the app the record names, else `whatsapp_ad`; `paid` when the context says ad (or carries a `ctwaClid`), else `social_or_organic`. The raw metadata is kept on the touchpoint |
| 4 | `keyword` | the text says Bona, بونا, or `BONA-W###` | `whatsapp_organic` |
| 5 | `time_window` | the sender is unknown and a `whatsapp_click` from a session with no lead landed within ±15 min — the closest one | that session's touch; the note says *inferred* |

The order is the rule, not a formality. A Ref code wins over everything, because it is the
only thing that knows the campaign for certain — even from somebody who is already a lead.
Ad context is read **before** the keyword rule, so an ad-originated message that also says
"Bona" is attributed to the ad rather than to organic WhatsApp. And the time window is last
because it is the weakest: two visitors clicking in the same quarter hour are told apart by
nothing, which is why its leads are marked *inferred*.

Everything else — your private conversations, which this loop can also see — is discarded
in memory: counted in `poller.unmatched`, never sent anywhere, and never written to disk,
with one exception (D17): for a message that looks like a property enquiry but is not
clearly for Bona, only the chat's number, the name WhatsApp shows and the property words
are kept, until 30 days after the last such message, on the owner's list of real-estate
chats to check (a chat he marks *Not a client* keeps only its ids, for a year; see
[Dashboard → Inbox](#inbox)). Never its text. No log line here carries a phone number, a
name or message text.

Two exceptions since Phase 2 of the team inbox ([Dashboard → Inbox](#inbox)). Leads are also
made without the table: from the owner's own message when it passes the *Owner-started* rule
(a Bona site link, a listing id or a qualifying document: `owner_outbound`), and by his *Add
chat by phone number* (`owner_added`). And a message discarded here when it arrived can
still be stored later: when its chat joins the inbox, the 24 h before the join (30 days for
the owner's *Move* and *Add*) are fetched from Evolution and stored with it.

Each window is handled oldest-first (Evolution answers the other way round, and judging a
follow-up before the `Ref` line that explains it would discard it), and a message is
remembered as handled only once it is stored — so a transient store failure costs a retry,
not the lead. The cursor is held back to the oldest message it could not store, or that
message would fall out of the window and be lost silently; one that keeps failing is
written off after three tries (`wa.poll.record_failed`), and one the cursor can no longer
reach — after downtime long enough to move the floor past it — is given up on out loud
(`wa.poll.abandoned`). Evolution answers newest-first and 5 pages of 100 is the cap, so a
window holding more than 500 messages would hide its *oldest* ones. Its answer says how many
the window holds (`total`), so `readWindow` (`lib/evolution.mjs`) splits such a window in
halves on whole-second boundaries, at most 4 levels deep (16 pieces: 8,000 messages at most,
and only when they are spread evenly over the pieces), and hands the pieces over
oldest-first. A piece that comes back with fewer messages than its `total` (they slid
between pages while it was read) is split and read again the same way. Only a piece still
over the cap or still short at the deepest level (or one second wide: a single second
holding more than 500 messages cannot be split) is kept partial — a loss, not a deferral,
because asking again returns the same newest pages — and the log says `wa.poll.truncated`
with the number missed where the answer states a total. In practice that takes downtime
long enough for thousands of messages to pile up in one window. An answer without a `total`
is read page by page until a short one, and one still full at the fifth page is split the
same way; at the deepest level it is kept partial with `missing` 0, because nothing says how
many more there were.

A match creates the lead (or merges into the person it already is) **at the message's own
timestamp**, so `first_inbound_ts` is when the enquiry actually happened; the first ≤ 200
characters are kept on the touchpoint of a *new* lead only (a chat in the Bona inbox keeps its
whole conversation as well — [Dashboard → Inbox](#inbox), below). You get the note once, on
create. Your own outbound message to a lead sets `first_reply_ts` — the response time on
the dashboard. Every tick is wrapped: a failure logs `wa.poll.failed` and leaves the cursor
untouched, so an Evolution outage loses nothing and shows up only as growing lag.

`/health` → `poller`:

| Field | |
|---|---|
| `instance` | the Evolution instance being read (`BONA_WA_INSTANCE`) |
| `configured` | `false` when `EVOLUTION_API_URL` / `EVOLUTION_API_KEY` are missing — every tick then skips rather than guessing a URL |
| `lastRun` / `lastTs` | ms: when the last tick ran, and the newest message it saw |
| `lagS` | seconds since the last tick that *finished* — the number to watch. It grows only when Evolution is unreachable; a quiet WhatsApp still reads ~0 |
| `unmatched` | messages discarded since the store was created (it lives in the cursor row, so it survives restarts) |
| `matched` | messages kept since this process started |
| `running` | whether the interval is on |

`ok` never depends on any of it: a poller that is behind is a gap in attribution, not a
site that stopped answering.

**Fan-out** (every `BONA_FANOUT_MS`). Per event, per destination, idempotent by
`event_id`, retried ≤ 5 times with backoff: Meta CAPI `Contact` / `Lead` / `Schedule` /
`Purchase`, GA4 Measurement Protocol `generate_lead` → `close_convert_lead`, Snap
`SIGN_UP` / `PURCHASE`. Consent-gated: every destination — Meta, GA4 and Snap — fires only for sessions that
allowed *advertising* in the banner (the banner grants analytics and advertising together,
so this is the conservative reading of PDPL); a lead without a session gets no ad-platform
event. Keys in `~/.secrets/bona-marketing.env`; `node scripts/marketing/verify-integrations.mjs`
checks each one and updates the site's Integrations board.

### Dashboard

`https://api.bona-real-estate.com/dashboard` — the owner's private view of everything above,
server-rendered by this same process. No CDN, no framework and **no JavaScript at all**:
every page is HTML with one embedded stylesheet, every chart is inline SVG, every filter
is a GET and every write is a form post. That is what lets the response headers be as
tight as they are, on every dashboard and admin answer, HTML or JSON:

```
Cache-Control: no-store
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'
X-Frame-Options: DENY
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
```

Nothing here is CORS-enabled, so no other origin can read a byte of it.

**Login (team accounts, since 2026-09).** `GET /dashboard/login` asks for a WhatsApp number.
`POST /dashboard/login/code` — if the number belongs to an active member of the team
(`users`, managed on the owner-only **Team** page), six digits go to that member's WhatsApp
from the owner's number (the owner's own code goes to his own chat). Any other number gets
the same answer, the same `bona_dash_try` cookie (`Path=/dashboard/login`) and a decoy
challenge no code opens, and all member-only work (the audit row, the send) runs only after
the answer is written, so the login says nothing about who is on the team. A challenge
belongs to one person and one browser (found by the nonce, never by the code); five wrong
guesses burn it; it lives 10 minutes; a new code voids that person's older one. Each person
gets at most 5 real codes an hour and 10 a day (counted in the db, so a restart does not
reset it); past that the request quietly gets a decoy. Limits: 3 per 10 min per number and
per IP (IPv6 by /64), 6 a minute and 200 a day overall; the send also passes the shared gate
in `lib/wa-send.mjs` (Sending switch on the Team page — only the owner's own code skips it;
20/min, 500/day, 6/min per recipient). Known limit: anyone who knows a member's number can
spend that member's code budget and block *new* logins for up to a day; existing sessions
keep working.
Sessions carry the member; deactivating someone deletes their sessions and codes at once, and
every admin write re-checks the person after the body is read. Every stage change and note
records who made it, and `audit_log` records logins, team changes and switches (ids only —
never a phone, name, code or note text). Team numbers (and their learned `@lid` ids) and the
owner's never-a-client list are skipped by the WhatsApp poller. The owner is seeded from
`BONA_OWNER_JID` at start-up and adopts sessions from before team accounts.
Because of that seeding, the `BONA_OWNER_JID` account is re-activated as an owner on every
restart even if another owner switched it off — change the env to retire it. With the Sending
switch off, only that owner's own code still goes out; other members (other owners included)
get the usual neutral answer but no code until Sending is back on.

`POST /dashboard/login/verify` (form-encoded, 5 wrong attempts burn the code) sets
`bona_dash`: `HttpOnly; Secure; SameSite=Lax; Path=/;
Max-Age=BONA_DASH_COOKIE_DAYS`, with only the token's hash in `auth_sessions`.
`POST /dashboard/logout` (the nav button; `_dash=1`, same-origin) deletes the session
server-side and clears the cookie — a GET there only offers the button, because
`SameSite=Lax` sends the cookie on a top-level navigation and a link on any page would
otherwise end the session. Every other `/dashboard/*` route 302s to the login without a
valid cookie; every `/v1/admin/*` route answers 401.

**Writes** — including the logout — carry a marker: `X-Bona-Dash: 1` on a JSON call, a
hidden `_dash=1` field on a form. What actually stops a cross-site write is
`SameSite=Lax` (the cookie does not ride one) plus the `Origin`/`Referer` check; the
header half of the marker is a real barrier on top of that, the form field is not a CSRF
token and is not pretending to be one. A stage change also writes a `lead_stage` event and enqueues the fan-out
(`qualified` → GA4 `qualify_lead`; `viewing`/`offer`/`negotiation` → GA4 `working_lead`
plus Meta `Schedule` for a viewing; `won` → Meta `Purchase` with the value, GA4
`close_convert_lead`, Snap `PURCHASE`; `lost` → GA4 `close_unconvert_lead`; anything else
is recorded and not sent).

Phone numbers are masked to `…6933` in every list — pages and JSON alike — and whole only
on `GET /dashboard/leads/:id`, `GET /v1/admin/leads/:id` and the header of a chat
(`GET /dashboard/inbox/:leadId`).

**Who sees which lead.** An owner sees every lead. A staff member sees only the Bona inbox's
leads — `inbox_state = 'in'` and a number that is neither a colleague's nor on the never list
(`team.isExcludedLead`) — on the Leads board and list (and its total), the Desk's waiting queue
and its count, the lead page, `GET /v1/admin/leads` (and its `total`) and
`GET /v1/admin/leads/:id`, and only such a lead takes their stage change or note. Any other
lead (a guess on the Unsure list, *Not a client*, one no rule has placed, a TK or private chat
that is a lead only for the statistics) answers them exactly as a lead that does not exist:
absent from lists, 404 on its page, its JSON and its writes (a form lands back on
`/dashboard/leads`), so its touchpoints and the first-message snippet they keep are never
shown to them. The aggregates — charts, sources, match quality, pipeline counts (the Leads
rail's stage numbers too), response times — stay as they are for everyone.

| Route | What |
|---|---|
| `GET /dashboard` | Overview — a 14-day strip (sessions, WA clicks, leads, viewings) as inline SVG, `?days=` 1–90. Everything below the strip — sources with first-touch and last-touch columns side by side, match quality, first-reply median and p90 — is **all time**, and the page says so |
| `GET /dashboard/leads` | pipeline board (one column per stage: name, masked phone, source, listing, age, response) and a list below with `?stage=&q=` |
| `GET /dashboard/leads/:id` | the whole record, the journey (events + touchpoints + stage moves + notes, oldest first), the stage form and the note form |
| `GET /dashboard/listings` | per-listing funnel (views → gallery/tour/brochure → WA clicks → leads) and REGA flags: `no_ad_licence`, `expiring_30d`, `expired`, `wafi_missing` (off-plan) |
| `GET /dashboard/spend` | spend entry form, cost per lead per campaign, and the last 90 days of entries |
| `GET /dashboard/integrations` | which keys are present (booleans only, never a value), fan-out counts and last accepted event per destination, poller status when one is running, Retell, and the owner checklists |
| `GET /v1/admin/stats?days=14` | the whole bundle: `daily`, `sources`, `match_quality`, `pipeline`, `response_times`, `cpl_by_campaign`, `totals` |
| `GET /v1/admin/leads?stage=&q=&limit=100` | `{count, total, leads}` — phones masked |
| `GET /v1/admin/leads/:id` | `{lead, journey, stage_history, touchpoints}` — phone in full |
| `GET /v1/admin/listings` | the same funnel rows as the Listings page |
| `POST /v1/admin/leads/:id/stage` | `{stage, value_sar?, note?}` → stage, history row, `lead_stage` event, fan-out |
| `POST /v1/admin/leads/:id/note` | `{note}` → a `note` touchpoint and an appended line on the lead |
| `POST /v1/admin/spend` | `{day, platform, campaign_id, campaign_name, spend_sar, clicks?, impressions?}`, upserted on `(day, platform, campaign_id)` |
| `GET /dashboard/inbox` | the Bona chats, unread first, then newest: name, masked number, last message, stage, handler, *Needs a human*. The owner also gets the **Unsure** tab (`?tab=unsure`; 403 for staff) and *Add chat by phone number* |
| `GET /dashboard/inbox/:leadId` | one chat, refreshed from Evolution first and then marked read: bubbles labelled client / team member / Dana / the owner's number, gaps, sends still open, the reply box and the handler picker; the number in full in the header. 404 unless it is an `in` chat (a `wa_jid` or `wa_lid`) and its number is not excluded |
| `POST /v1/admin/inbox/:leadId/reply` | any member: one reply through the shared gate; its answers, form and JSON, are under *Reply answers* ([Inbox](#inbox)), and none puts message text in a URL |
| `POST /v1/admin/inbox/:leadId/handler` | any member: hand the chat to an active member, or to nobody |
| `POST /v1/admin/inbox/:leadId/move` · `…/out` | owner: *Move to Bona inbox* (pulls 30 days) · *Not a client* (`out`, transcript purged now) |
| `POST /v1/admin/inbox/add` | owner: *Add chat by phone number* — creates or reuses the lead (`owner_added`), puts it `in`, pulls 30 days |
| `POST /v1/admin/inbox/candidates/:candId/move` · `…/dismiss` | owner: a real-estate chat to check → *Move to Bona inbox* (an `owner_added` lead, `in`, pulls 30 days, off the list; a team or never-list number is refused `excluded` and taken off) · *Not a client* (off the list; kept dismissed for a year so it is not listed again) |

Spend is matched to leads on **platform and campaign id together**, never the id alone —
Meta and Snap can both run a campaign `1203`. The two vocabularies are folded by
`PLATFORM_ALIASES` in `lib/dashboard/stats.mjs`, so "instagram" typed on the Spend page
meets a lead that arrived with `utm_source=meta`. A platform name nothing recognises
matches no spend rather than borrowing another platform's budget — and when that
happens, the row carries `unmatched_leads` and the page says "unmatched — check the UTM
source" instead of printing a zero that reads like a dud campaign.

A form post answers `303` back to the page it came from, with two exceptions in the inbox: a
reply or handover for a chat that may not be answered gets the 404 page, and a refused reply
draws the thread again with the text kept ([Inbox](#inbox)). A JSON call answers JSON.

**One thing rate limits cannot fix.** `POST /dashboard/login/code` has to be reachable by
an unauthenticated owner, so it is reachable by everyone. The limits above bound what a
flood costs — sixty WhatsApp messages a day rather than 1,440, and a drained ceiling
delays the owner's next code by about 24 minutes rather than until tomorrow — but they
cannot make the endpoint available to him and not to an attacker. If it is ever actually
attacked, the answer is a rate rule or a Cloudflare Access policy in front of
`/dashboard/login*` on the tunnel, not a smaller number in `lib/dashboard/auth.mjs`.

#### Inbox

Since 2026-09, `GET /dashboard/inbox` is where the team reads and answers the Bona chats on
the owner's number (design §4, 2026-09-27; routes in the table above). A *chat* is a lead
with a `wa_jid` or a `wa_lid`. Whether it belongs is **stored** in `leads.inbox_state`
(`in`, `unsure`, `out`) and never re-derived, so a guess cannot slip in later through the
`phone` rule:

- *Certain*: an inbound message with a Ref line as the site writes it
  (`Ref BONA-W003 · K7Q2XR`, with its listing part) or a code a site session holds,
  click-to-WhatsApp ad evidence, or a listing id (`BONA-###`, `BONA-W###`) puts the chat `in`
  by itself, together with the 24 h of that chat before it (the "Hi" before the Ref line).
  A web-form or concierge lead is not a signal: its phone number is whatever someone typed or
  told Dana, never verified, so it is born with no inbox state and a later form or concierge
  merge never lifts a missing or `unsure` state to `in` (owner rule D9; this replaced planning
  decision P2-6 on 2026-09-29). When that person writes on WhatsApp, the poller matches the
  chat to the lead and judges it like any other: with no certain signal it goes on the Unsure
  tab.
  TK runs no click-to-WhatsApp ads to this number (owner, 2026-09-28, D15), so an ad-origin
  chat here is a Bona client — but only real ad evidence counts (`hasAdEvidence`): a click id
  (`ctwa_clid`), a conversion source, the `ctwa_ad` entry point or an ad source type (the
  token `ad` / `ads`, never `broadcast` or `thread`; migration v4 reads it the same). WhatsApp
  attaches the same kind of context to organic entry points — a wa.me link
  (`click_to_chat_link`), its own search (`global_search_new_chat`), a tapped phone number
  (`phone_number_hyperlink`) — and every live `ad_meta` lead on 2026-09-29 was one of those.
  Such a message still makes an `ad_meta` lead with the same attribution as before; its chat
  goes to the Unsure tab.
- *Unsure*: only the word Bona/بونا, a bare Ref-shaped code no session holds, ad context
  from an organic entry point, or only the ±15-min click window. The lead is kept for the statistics as before and goes to the
  owner-only **Unsure** tab (`?tab=unsure`; staff get 403), where *Move to Bona inbox* or
  *Not a client* settles it.
- *Owner-started*: the owner's own message in a 1:1 chat puts that chat `in` (a new lead gets
  `match_method = 'owner_outbound'`) with the 24 h before it when it carries a Bona site link
  (`bona-real-estate.com`, legacy `bona.azoz.uk`) or a listing id, or when it is a property
  document (D16): a brochure from any developer, on its own; a floor plan, price list,
  payment plan, master plan, fact sheet, booklet (كتيب) or plan (مخطط) only with a property
  word (villa, apartment, unit, project, فيلا, شقة, مشروع …) in the same file name or caption,
  because TK's fit-out work sends those papers too (owner, 2026-09-28); each in English or
  Arabic, named in its file name or caption; or a document whose file name carries a listing
  id or a site link. A document whose file name or caption names TK (`TK`, `T.K.`,
  `tk-estates`, `تي كي` / `تى كى`) never joins, whatever else it says. A document that names
  Bona joins only by a listing id or a site link: Bona AB also makes wood-floor finishes, with
  brochures and price lists of its own, so "Bona Traffic HD brochure.pdf" goes on the owner's
  list of real-estate chats to check instead. A document name cut at 120 characters joins
  only where the whole name would (`fileNameTk` and `fileNameBona` carry whether the whole
  name named TK or Bona). Nothing else he types counts — TK and private chats share the
  number. These leads fan out to no ad platform (no click is behind them), send him no
  new-lead note, and are born answered (`first_reply_ts` set, `first_inbound_ts` empty), so
  neither the waiting queue nor the Hermes `bona-unanswered-leads` watchdog flags them.
- *Owner buttons*: *Move to Bona inbox* (Unsure tab or the lead page) and *Add chat by phone
  number* (`owner_added`) put a chat `in` and pull its last 30 days — he vouched for it.
  An added chat is born answered and starts the reply clock at the client's first message
  after the add; a message from before the add that the poller reads late (behind after an
  outage) does not put it in the waiting queue. *Not a client* puts it `out`: its transcript is purged there and then, and it never comes
  back on its own.
- *Real-estate chats to check* (D17): a chat with no lead behind it where a message sent or
  received uses one of these property words (`PROPERTY_WORD_FORMS`, `propertyWordsIn`:
  villa, apartment, rent / rental / for rent, for sale, real estate, property, duplex,
  penthouse, townhouse; فيلا, شقة, إيجار / للإيجار, للبيع, عقار, دوبلكس, بنتهاوس, تاون هاوس —
  and nothing else: everyday words such as land, flat, plot, compound, bedroom, broker, lease,
  listing, commission, أرض, غرفة, مخطط, صك, سمسار or عمولة never count by themselves, so "My
  flight will land at 9" or "غرفة النوم" keeps nothing), or mentions a property document by
  D16's own test (`mentionsPropertyDocument`, in its text or caption or a document's file
  name): a brochure (بروشور), or a floor plan, plan (مخطط), price list, payment plan, master
  plan, fact sheet or booklet (كتيب) with a property word beside it (unit, project, tower,
  land, مشروع, وحدة, أرض …) — a plan, a price list or a booklet on its own is as often a
  trip's plan (مخطط للسفر), a car's payment plan, a restaurant's price list or a car manual
  (كتيب السيارة) and keeps nothing; or where the owner sends a document whose file name or
  caption has any of those document words (`PROPERTY_DOC_RE`) or names TK, goes on a second
  list on the owner's **Unsure** tab (`inbox_candidates`) — so every property document he
  sends that did not join (one that names Bona, a name cut too close to the word, or a price
  list with no property word beside it) is on it. The privacy page lists exactly these words
  and says the same of documents, and tests hold the page to both. Only a chat with a
  phone number: never a lid alone or a WhatsApp channel. Kept: the number and jid (and lid),
  the name WhatsApp shows for the client (never the name on a message the owner sent), the
  property words, first and last time, how many messages and who wrote last — never the
  text, never a lead, no note to anyone — until 30 days after its last such message.
  *Move to Bona inbox* makes it an `owner_added` lead, puts it `in` and pulls its last 30
  days; *Not a client* keeps only its ids, so it is not listed again. A chat that becomes a
  lead leaves the list, team and never-list numbers are never on it, and staff never see
  it. This is how TK clients who write to this number stay out of the inbox: nothing joins
  without a sure signal.
- *Never*: team numbers and the never-a-client list are not matched, stored or shown.
  Adding a number to the team or to the never list moves its lead `out` and purges its
  transcript at once, the daily upkeep (below) does the same for any chat whose number is
  excluded, and every inbox page, reply, handover, move and add also refuses an excluded
  number.

Schema v4 sorted the leads that already existed: `in` for `ref`, for `ad_meta` only when its
`lead_created` touchpoint's `meta.ad_meta` shows ad evidence (the same test as
`hasAdEvidence`), and for a listing id in the first snippet; everything else — organic
`ad_meta` leads, web-form and concierge leads included — `unsure`, for the owner to settle.
On the live db that is 2 in (the two Ref leads) and every other lead unsure (read-only checks
on 2026-09-28 and 2026-09-29: no `ad_meta` lead carries ad evidence, and only the Ref leads'
first snippets carry a listing id); the Phase 2 deploy checks it.

*What is stored* (`wa_messages`, `in` chats only): every message in both directions and who
sent it — the client, a team member (by user id), Dana (from Phase 4), or `owner_number`
(typed on the owner's phone, or sent for him by Lisa: WhatsApp cannot tell those apart).
Text is capped at 8,000 characters. Media are placeholders only (`[voice note]`, `[audio]`,
`[image]`, `[video]`, `[document: name]`, `[location]`, `[contact]`, `[sticker]`, else
`[message]`) plus the caption, never the file. Reactions, deletes and edits, poll votes and
key-distribution records are noise and are never stored, and neither is a login code, even
in an `in` chat. Evolution files one conversation under two jids — what arrives and what the
owner types under the `@lid`, what the API sends to a number under the phone jid — so every
per-chat read (join history, opening a thread, the check before a reply) asks for both and
de-duplicates on `key.id`. A message the poller writes off after three tries, or gives up on
once the window has moved past it, becomes a `wa_gaps` row, shown in the thread as a message
that could not be loaded, instead of vanishing; so does a failed history read of an
automatic join or of the catch-up. The owner's *Move* and *Add* do not write one yet: their
failed 30-day read is only logged (`inbox.backfill.failed`); if the chat is still empty the
next catch-up asks for the same 30 days (it reads from the chat's history floor, below).
*History floor* (`leads.history_from`): every join records how far back that chat may be
stored — 24 h before the joining message for an automatic join (a certain inbound signal, or
the owner's Bona link or property document), 30 days back for *Move* and *Add* (the Unsure
tab's, a lead page's and a chat to check's), `created − 24 h` for every lead schema v4 put `in`.
A chat already `in` keeps the floor it joined with; `out` and `unsure` clear it. Ingest
refuses any record older than it (`before_floor`: nothing stored, nothing learned), whichever
read brings it — the poller (whose window can reach weeks back after an outage), a join's
history, a thread refresh or the catch-up — and the refresh and the catch-up start from it.
Unread means inbound
messages newer than the newest one that person saw when they last opened the thread (a new
member starts from the day the account was made); the total is the Inbox count in the nav.

*Retention.* Five years after a chat's last message (`leads.last_msg_ts`) its transcript —
messages, reply outbox rows, gaps and read marks — is deleted; the lead row stays for
attribution. *Not a client*, a team add and a never-list add purge at once. A purged send
of the last 24 h is cut to a stub (no text, no chat) that still counts toward the day cap. A
login code's outbox row never holds the code (`text` is NULL); code rows and stubs are
pruned after 2 days. Known limit: the purge finds chats by their stored messages, so a
failed or uncertain reply into a chat with nothing stored keeps its text in `wa_outbox`
until the purge also looks at outbox rows. The privacy page (*WhatsApp conversations with
our team*) tells clients the five years, the at-once purge of a chat that is not about a
Bona enquiry (the first-message snippet stays with the lead), and the copies this retention
does not reach: Evolution's own database — "the WhatsApp gateway server that Bona runs for
this number", which keeps every message with no time limit — and the phones.

*Replies* go out from the owner's number (`BONA_WA_INSTANCE`) and only into `in` chats.
`POST /v1/admin/inbox/:leadId/reply` sends to the lead's **phone** jid (`…@s.whatsapp.net`);
a chat known only by its `@lid` is refused (`lid_only`) and answered from the phone, because
`lid` digits are not a phone number. Every reply passes the gate the login codes pass
(`lib/wa-send.mjs`): the Sending switch, `BONA_WA_NOTIFY` not `0` (§4; a login code does
not need it), 20 a minute overall, 6 a minute per recipient, 30 a minute per person, and
500 a day — counted from `wa_outbox` over a rolling 24 h (messages to the owner's own chat
do not count), so a restart does not reset it. The form
carries a random `send_id`, and its outbox row is written before the HTTP call, so a double
submit gets the first answer back, never a second message. A reply is `accepted` only when
Evolution answers with a `key.id`. A timeout, a network error other than a refused
connection or a failed DNS lookup, any 5xx or a 2xx without an id is `uncertain`: the
thread says to check WhatsApp, the text is not put back (it may have gone), it counts
toward the day cap, and nothing retries it. Only a 4xx or a refused connection / failed
DNS lookup is `failed` (never reached WhatsApp: the text is kept in the box). When the message turns up in a poll the row is settled — by its `key.id`, or
else the same lead and the same text within 2 minutes — and the bubble gets its sender; a
row interrupted by a restart becomes `uncertain` (`interrupted`): at start-up every `pending`
row does, however young (the new process has sent nothing yet). The form also carries the
newest message time the person saw, and the chat is refreshed from Evolution just before
the check — best effort: at most ~3 s, the newest 50 records per question, skipped within
5 s of the last refresh, and a failed read leaves only what is already stored. Anything
newer that is stored by then, in either direction, holds the reply (`stale`) with the text
kept in the box. The first person to reply becomes the chat's handler when it has none (a
reply typed on the owner's phone makes the owner the handler); anyone can hand it to
another active member or to nobody. Audit rows name the chat's lead as their target and
carry little else: `reply_sent` its outcome (`{status}`: `accepted`, `uncertain` or
`failed`), `handler` the new handler's user id (`{to}`, null for nobody), and `inbox_move`,
`inbox_out` and `inbox_add` nothing more — never text or a number. Replies ship
**switched off** (`settings.inbox_replies` = `'0'`): the thread shows "not switched on yet"
in place of the box, and `reply` refuses `replies_off` (503) before anything is written,
until the owner switches *Replies to clients from the dashboard* on from the Team page
(one switch per post, audited `setting`). That is how the first real client reply from the
dashboard is sent with the owner beside it (design D14). Login codes do not wait for it.

*Reply answers.* A form: sent → 303 to the thread `?ok=sent`; uncertain → 303
`?error=send_uncertain` (the text is not kept: it may have gone); a chat that may not be
answered → the same 404 page as the thread; a writer deactivated (or signed out) while the
chat refreshed → 303 to the login, nothing sent or written (the session is asked again after
the refresh, and the sender reads the member again right before its outbox row,
`inactive_user`); any other refusal → the thread again with the
text kept in the box, a fresh `send_id` and the HTTP status listed below. A JSON call:

- 200 `{ok: true, status: 'accepted', send_id}`: sent.
- 202 `{ok: false, error: 'send_uncertain', send_id}`: it may have gone; check WhatsApp.
- 404 `{error: 'not_in_inbox'}`: a chat that may not be answered.
- 401 `{error: 'unauthorised'}`: the writer is no longer signed in; nothing was sent.
- `{error}` with 409 (`stale`, `lid_only`), 400 (`bad_text`, `bad_send_id`), 429
  (`reply_rate_limited`), 503 (`sending_disabled`, `replies_off`) or 502 (`send_failed`: anything else,
  and a resubmit of a send that failed).

*Polling and upkeep.* The poller runs every 20 s (`BONA_WA_POLL_MS`, §4). The VPS sets it in
`~/.secrets/bona-services.env`, and a value there wins over the default — a stale
`BONA_WA_POLL_MS=45000` keeps the old pace. Opening a thread also reads that chat at once,
but only messages since the chat's history floor, and never for more than ~3 s.
Inbox upkeep (`app.inboxMaintenance()`) runs at start-up and then every 24 h: first every
listed chat whose number is a team or never-list number goes `out` with its transcript
(logged `inbox.excluded_out`); then the 5-year purge, code rows and stubs older than 2 days,
and `pending` sends older than 2 minutes marked `uncertain` (a process that died mid-send
cannot know whether the message went; the start-up recovery before it has already marked
every row that was pending when the process started); then every `in` chat with nothing stored yet — at
most 200 a run, the longest-joined first — fetches its history from its history floor (the
24 h an automatic join takes, the 30 days of an owner join), never from before the 5-year
horizon (logged `inbox.catchup`; a read that fails leaves a
gap). That is how the chats schema v4 put `in` get a thread on day one; one whose
history comes back empty stays empty and is asked again on the next run. The upkeep also
prunes the real-estate chats to check: an open one 30 days after its last property message, a
dismissed one a year after it was dismissed (`candidatesExpired`, `dismissalsExpired` in the
`inbox.maintenance` line).
