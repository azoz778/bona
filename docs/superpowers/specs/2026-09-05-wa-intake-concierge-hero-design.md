# Bona — WhatsApp→listing intake, AI concierge (chat + call), hero-image curation

Date: 2026-09-05 (evening). Owner brief (verbatim intent): *"make a group on my WhatsApp — once I put PDFs inside it, it takes that property and puts it on the website directly, from my phone number, fully automated. A bot like Lisa answering on the website: a button to call it online, and one that helps you navigate the website, see inventory, ask questions. Multiple agents, done today, on a loop. Luxury real estate. An AI that chooses the right images — the best image must be the first one people see."*

Design decisions below were made autonomously by the orchestrator (owner pre-authorised: "don't stop until you're done"). Every decision is reversible via config.

## 0. Facts that shaped the design (verified 2026-09-05 23:10 KSA)

| Fact | Consequence |
|---|---|
| Bona site = Astro static on GitHub Pages (`azoz778/bona`, main → deploy ~2–3 min). No server. | Anything dynamic needs a separate always-on process + public HTTPS. |
| Owner's **personal WhatsApp (+966 59 329 6933 — also Bona's number)** is already paired to a self-hosted **Evolution API** (`https://wa-api.azoz.uk`, instance `abdulaziz-personal`, state `open`, Baileys). No webhook configured on it. Groups "PDF", "Pdf 2", "Tk pdf" already exist. Creds: `~/.secrets/evolution-api.env` (`EVOLUTION_API_URL`, `EVOLUTION_API_KEY`). | "From my phone number" is literally satisfied: poll the owner's own instance for PDFs in a Bona group. **Read-only polling, never set a webhook** (would steal events from Lisa). |
| **Retell AI** account (creds `~/.secrets/retell.env`: `RETELL_API_KEY`, `TOOLTOKEN`). Existing agent "Lisa – TK Prime Estate (AR/EN)" = retell-llm gpt-4.1, voice `11labs-Nyla` (eleven_flash_v2_5), language `["ar-SA","en-US"]`, custom tools `search_properties` + `create_lead` (webhooks), web page lisa.azoz.uk uses `retell-client-js-sdk@2` + `POST /token`. | "A bot like Lisa" = a Retell agent. Retell also has **chat** (`POST /create-chat`, `POST /create-chat-completion`) and **web calls** (`POST /v2/create-web-call` → `access_token`). Retell hosts the LLM (billing on the owner's Retell balance) — no LLM API key needed. |
| Anthropic **API** key has no credits (eval CI red). `claude -p --model sonnet` (Claude Code subscription) works headless here in ~10 s. | Server-side AI in the intake pipeline runs through `claude -p` on this WSL box. The website concierge's LLM runs inside Retell. |
| **Cloudflare**: `~/.cloudflared/cert.pem` (account-level tunnel cert) + zone-scoped API token. `cloudflared tunnel list` works. Existing tunnel `jarvis-hud-laptop` (not running). | Public HTTPS for a WSL-hosted API = new tunnel `bona` → `bona-api.azoz.uk`. No VPS SSH needed (classifier blocks it). |
| WSL is the owner's always-on box (hermes-gateway, ollama etc. run here as systemd **user** services). | Services here = systemd user units. Documented risk: PC off ⇒ intake pauses (WhatsApp keeps the PDFs; processed on resume) and concierge shows a graceful WhatsApp fallback. |
| Images today come from TK's MinIO (`tk-storage.azoz.uk`). Gallery index `scripts/tk-gallery-data.json` (1,490 photos, 64 folders). Curation = `scripts/curate/listings.source.mjs` (`images: [[galleryIndex, roomKey], …]`, `images[0]` = hero) → `build.mjs` → `src/data/listings.json`. Land plots already use site-local stills `/land/*.jpg`. | New WhatsApp listings store images **in the repo** under `public/listings/<slug>/` (GitHub Pages serves them). Validator/schema extended for that path. |
| `uv run --with pymupdf` works (PyMuPDF 1.28). `sharp` is a root dependency. `gh` is authenticated (azoz778). | PDF text+image extraction in Python, image processing in Node, git push via gh token. |
| Owner rules already in force: never estimate prices (TAQEEM), no TK mentions in Bona copy, no hype words (validator), Arabic must be real Arabic, publish only what the owner intends. | Intake: price only if printed in the PDF, else "Price on request". Default-deny gate for non-brochure PDFs. |

## 1. Architecture

```
Owner's phone ──WhatsApp group "Bona …"──▶ Evolution API (wa-api.azoz.uk, owner's own instance)
                                                    │ poll every 20 s (read-only)
                                          ┌─────────▼──────────┐
                                          │ bona-intake        │  systemd --user, WSL
                                          │ PDF → PyMuPDF →    │  ~/bona/services/intake
                                          │ claude -p (sonnet) │  → extraction + image ranking
                                          │ → sharp → repo →   │  → commit/push main
                                          │ reply in group     │
                                          └─────────┬──────────┘
                                                    ▼
                               GitHub Actions deploy ──▶ bona.azoz.uk (static, Astro)
                                                              │  Concierge widget (chat + call)
                                                              ▼
                     Cloudflare Tunnel "bona" ──▶ bona-api (systemd --user, WSL, :4102)
                     bona-api.azoz.uk                 │  /v1/chat/*  → Retell chat (agent "Dana", chat channel)
                                                      │  /v1/call/*  → Retell web call (agent "Dana", voice)
                                                      │  /v1/tools/* ← Retell custom tools (search/show/lead)
                                                      └─ leads → ~/bona-data/leads.jsonl + WhatsApp note to owner
```

Persona: **Dana (دانة)** — "large pearl", a Gulf name, bilingual, short. Calm, precise, luxury tone. Never says "TK".

Model choices (builders): Opus for all four build agents (integration-heavy, taste-heavy). Sonnet inside the intake pipeline (`claude -p`, cost/quota) with Opus fallback flag. Retell LLM: prefer `claude-4.6-sonnet` if the API accepts it, else `gpt-4.1` (proven with Lisa).

## 2. Workstream A — WhatsApp PDF intake (`services/intake/`)

**Owner UX.** Owner creates (or renames) any WhatsApp group whose name contains "Bona" (case-insensitive, e.g. "Bona Listings"). The bot posts once: "Bona intake connected — send a property brochure PDF here to publish it. Add a caption with hints (e.g. `rent`, `SAR 4,500,000`, `#test`, `#brochure`)." Owner drops a PDF → within ~1 min the bot replies "Reading…", then after publish "✅ Live: *Title* — https://bona.azoz.uk/properties/<slug>/ · 9 photos · cover: Pool · Reply `remove BONA-W003` / `hero BONA-W003 4` / `price BONA-W003 4500000` / `sold BONA-W003`." Failures reply with a one-line reason. Non-brochure PDFs (invoice, ID, contract, statement, <2 pages, no property signals) are rejected and never stored in the repo.

**Group discovery.** Every 5 min: `group/fetchAllGroups/{instance}?getParticipants=false`; select subjects matching `BONA_WA_GROUP_MATCH` (default `/bona/i`) — plus any explicit `BONA_WA_GROUP_JIDS`. Announce once per group (state file).

**Message polling.** Every `BONA_POLL_MS` (20 s) per selected group: Evolution v2 `POST /chat/findMessages/{instance}` (`{ where: { key: { remoteJid } }, limit }` — verify exact shape against the live API; fall back to `/chat/findMessages` variants; sort by `messageTimestamp`). Accept only messages authored by the owner (`key.fromMe === true` or participant/`key.participant` = `BONA_OWNER_JID`, default `966593296933@s.whatsapp.net`). Handle `documentMessage` and `documentWithCaptionMessage` with `application/pdf`; text messages for commands (`remove|hero|price|sold <id> …`, `retry`). Dedupe by message id (state) and PDF sha256 (already-published → reply with the live URL).

**Download.** `POST /chat/getBase64FromMediaMessage/{instance}` `{ message: { key: {...} }, convertToMp4: false }` → save `~/bona-data/intake/<date>/<msgid>.pdf` (≤ 40 MB, ≤ 60 pages).

**Extraction** (`services/intake/extract_pdf.py`, run via `uv run --with pymupdf`): per-page text; embedded images with min side ≥ 700 px, dedupe by hash, drop obvious logos/icons; if < 3 usable images, render pages at ~150 dpi as candidates (flag `render: true`). Cap 40 candidates. Output JSON + files under the intake dir.

**AI step** (`claude -p`): build one labelled contact sheet of all candidates (reuse the sharp logic from `scripts/curate/contact-sheet.mjs`, local files) and pass the sheet + page text. Invocation: `env -u CLAUDECODE claude -p --model $BONA_CLAUDE_MODEL --output-format json --allowedTools Read --permission-mode bypassPermissions` (verify flags with `claude --help`; if `--json-schema` exists, use it). Prompt = strict JSON contract:

```jsonc
{ "reject": false, "rejectReason": null,
  "listing": { "title": {en,ar}, "type": "villa|apartment|penthouse|mansion|land|building|duplex", "category": "buy|rent|off-plan|international",
    "location": { "district": {en,ar}, "city": {en,ar}, "country": {en,ar}, "countryCode": "SA" },
    "price": { "amount": null|number, "currency": "SAR", "from": false, "period": null|"year"|"month", "onRequest": true|false },
    "specs": { "beds", "baths", "areaSqm", "plotSqm", "yearBuilt", "floors" }, // null when absent — never guess
    "description": { "en": ["p1","p2"], "ar": ["…"] }, "highlights": { "en": [..6], "ar": [..6] },
    "project": null|{...}, "unit": null|{...} },
  "images": [ { "index": 3, "room": "pool", "rank": 1, "hero": true, "exclude": false, "reason": "wide golden-hour pool + façade" }, … ],
  "confidence": 0.0-1.0, "warnings": ["…"] }
```
Rules baked into the prompt: TAQEEM (price only if printed; else onRequest); real Arabic; no hype words (see validator list); no TK/other-agency names or phone numbers in copy; room keys from `scripts/curate/rooms.mjs` (extend the vocabulary if a key is missing); floor plans/renders/text pages never hero (and excluded unless nothing else); hero = the image that best sells a luxury property (read `scripts/curate/IMAGE-RUBRIC.md` at runtime if present — Workstream C writes it — else an embedded default rubric). Second pass: view the top-3 hero candidates at full resolution and confirm/adjust the hero. Caption hints override (e.g. `rent`, explicit price, `#test` = dry run → reply with the summary only, `#brochure` = also publish the PDF at `/listings/<slug>/brochure.pdf`).

**Output.** `public/listings/<slug>/<nn>.jpg` (max 1920 px, q82, metadata stripped) + `<nn>-thumb.webp` (640 px) for kept images in rank order (8–10, min 4 — otherwise reject with "not enough usable photos"). Listing JSON → `scripts/curate/inbox/<slug>.json` with `id: "BONA-W###"` (counter in `scripts/curate/inbox/_index.json`), `source: "whatsapp"`, `sourceRef: "WA-<yyyymmdd>-<6 chars of msg id>"`, `messageId`, `pdfSha256`, `listedAt` = today, `featured: false`, `kind` from `src/data/kind-map.json`. `build.mjs`: after the TK live-list filter, append every `inbox/*.json` (they are exempt from the TK rule; a `hidden: true` flag or `status: "sold"` keeps them out / marks sold). `validate.mjs`: accept `LOCAL` images `/^\/(land|listings)\/[A-Za-z0-9-]+(?:\/[A-Za-z0-9-]+)?\.(jpg|webp)$/` for `src` and `thumb`; keep every other rule. Update `src/data/LISTING-SCHEMA.md` (new section "WhatsApp intake"). Site components already render `thumb ?? src` and don't prefix local paths — verify `ListingCard`, `Gallery`, `Head` OG image (make OG absolute with `site.url` if not already).

**Publish.** Dedicated clone `~/bona-bot` (created by `services/deploy/install.sh`, `git clone` via gh auth). Steps: `git pull --rebase origin main` → write files → `node scripts/curate/build.mjs && node scripts/curate/validate.mjs` → `git add -A && git commit -m "intake: <title> (<id>)"` → `git push origin main` (retry once after re-pull). Then poll `https://bona.azoz.uk/properties/<slug>/` until 200 (max 10 min; report "published, going live in a few minutes" if still 404) → reply in group (`POST /message/sendText/{instance}` `{ number: <groupJid>, text }`). Commands edit the inbox JSON (`remove` deletes JSON + images; `hero <id> <n>` reorders; `price`, `sold`) and republish the same way.

**Ops.** `services/deploy/bona-intake.service` (systemd user, `Restart=always`, `EnvironmentFile=%h/.secrets/bona-services.env`, `ExecStart=/home/azoz778/.nvm/versions/node/v24.19.0/bin/node %h/bona/services/intake/index.mjs`, PATH includes `~/.local/bin` for `claude`/`uv`). One PDF at a time (queue). Structured JSON logs to journal. `services/intake/run-once.mjs <file.pdf> [--dry-run] [--caption "…"]` for local testing without WhatsApp. Unit tests (`node --test services/intake/test/*.test.mjs`) for: caption parsing, owner-only filter, hash dedupe, JSON contract validation, slug generation, command parsing. Env file `~/.secrets/bona-services.env` (create if missing): `BONA_WA_INSTANCE=abdulaziz-personal`, `BONA_OWNER_JID`, `BONA_WA_GROUP_MATCH=bona`, `BONA_REPO=/home/azoz778/bona-bot`, `BONA_DATA=/home/azoz778/bona-data`, `BONA_POLL_MS=20000`, `BONA_CLAUDE_MODEL=sonnet`, `BONA_SITE=https://bona.azoz.uk`, `BONA_API_PORT=4102`, `BONA_TOOL_TOKEN=<random 32 hex>`. The service loads `~/.secrets/evolution-api.env` itself.

**Acceptance.** `run-once.mjs ~/kian-pipeline/brochures/TK-Kian-p113-A.pdf --dry-run` yields a valid listing JSON + ranked images (Kian brochure is a real-estate PDF; note it is TK-branded — the copy must still contain no "TK"). Unit tests green. Service unit installs and stays up. End-to-end (orchestrator): a PDF sent into the Bona group with `#test` produces a summary reply; without it, a live page.

## 3. Workstream B1 — Concierge backend + Retell agent + tunnel (`services/api/`)

**Retell objects (create via API, idempotent script `services/api/retell/provision.mjs`, ids saved to `services/api/retell/ids.json` — committed, not secret).**
- Knowledge base "Bona site": `knowledge_base_urls: ["https://bona.azoz.uk/llms-full.txt", "https://bona.azoz.uk/llms.txt"]`, `enable_auto_refresh: true`.
- Retell LLM "Bona Dana": model `claude-4.6-sonnet` if accepted else `gpt-4.1`; `start_speaker: agent`; `begin_message` bilingual ("مرحباً، أنا دانة من بونا. كيف أقدر أساعدك؟ Hello, I'm Dana from Bona — how can I help?"); `knowledge_base_ids: [kb]`; `general_prompt` = Dana persona (AR Hijazi-flavoured/EN, detect language, luxury calm tone, short sentences, one question at a time; **never invent listings or prices; never estimate a price — if not in inventory, offer a specialist**; use `search_properties` before any inventory answer; use `show_property` whenever you mention a specific property so the visitor sees it; capture leads with `create_lead` when a phone/name is offered or a viewing is requested; offer WhatsApp +966 59 329 6933 for humans; hours Sunday–Thursday 10:00–19:00; FAL 1100313556; never mention TK; if asked, honest about being an AI assistant of Bona). Dynamic variables: `{{locale}}`, `{{page_url}}`, `{{page_title}}`.
- Custom tools (webhooks, `POST https://bona-api.azoz.uk/v1/tools/<name>?token=<BONA_TOOL_TOKEN>`): `search_properties(kind?, district?, category?, minPrice?, maxPrice?, beds?, query?)`, `show_property(id|slug)`, `create_lead(name?, phone, interest, budget?, timeline?, notes?, language)`. Verify Retell's webhook body shape (`{ call: {...}, args: {...} }` or `{ chat: …, args }`) and respond with a JSON string result.
- Agents: **voice** "Bona Dana (voice)" — `voice_id: 11labs-Nyla` (or a better Arabic-capable ElevenLabs voice if `list-voices` offers one), `voice_model: eleven_flash_v2_5` (try `eleven_turbo_v2_5` for warmth if latency OK), `language: ["ar-SA","en-US"]`, `responsiveness 1`, `interruption_sensitivity 0.8`, `enable_backchannel true`, `end_call_after_silence_ms 30000`, `max_call_duration_ms 900000`, `webhook_url` → `/v1/retell/webhook?token=…` (call_ended → store transcript summary in `~/bona-data/calls.jsonl`). **Chat**: verify whether Retell needs a separate agent with `channel: "chat"` (Lisa's agent object exposes `channel`); create one on the same LLM if required. Publish both if `create-web-call`/`create-chat` require published agents (test; if drafts work, skip publishing).

**HTTP API** (Node ≥ 22, no framework or a tiny one — keep deps minimal in `services/package.json`), port `BONA_API_PORT` (4102), CORS allowlist `https://bona.azoz.uk`, `https://azoz778.github.io`, `http://localhost:4321`, `http://127.0.0.1:4321`; JSON only; per-IP token buckets (chat 30/min, token 6/min, tools unlimited but token-gated); request bodies ≤ 16 KB; every response `Cache-Control: no-store`.

| Route | Body → Response |
|---|---|
| `GET /health` | `{ ok, service: "bona-api", version, uptimeS, retell: "ok"|"error", inventory: <count> }` |
| `POST /v1/chat/session` | `{ locale, page? }` → `{ sessionId, greeting }` (Retell `create-chat` with dynamic vars) |
| `POST /v1/chat/message` | `{ sessionId, text, locale?, page? }` → `{ messages: [{ role: "agent", text }], actions: [ { type: "show_listing", listing: Card } \| { type: "navigate", path } \| { type: "whatsapp", message } ], leadCaptured?: true }` — built from `create-chat-completion` messages + tool calls; strip any `[[…]]` markers. |
| `POST /v1/chat/end` | `{ sessionId }` → `{ ok }` |
| `POST /v1/call/token` | `{ locale, page? }` → `{ accessToken, callId }` (`/v2/create-web-call`, dynamic vars, `metadata: { locale, page }`) |
| `GET /v1/call/:callId/context` | `{ listings: Card[], updatedAt }` — filled by `show_property`/`search_properties` tool hits during that call (in-memory, TTL 2 h) |
| `POST /v1/tools/search_properties` `?token=` | Retell tool → JSON string of up to 5 matches (id, title en/ar, district, price text, beds, baths, area, url) |
| `POST /v1/tools/show_property` `?token=` | Retell tool → records the Card into call/chat context → `"shown"` |
| `POST /v1/tools/create_lead` `?token=` | Retell tool → append `~/bona-data/leads.jsonl` + WhatsApp text to the owner (`sendText` to `BONA_OWNER_JID` via Evolution — "message yourself"; if that fails, to the Bona group) → `"saved"` |
| `POST /v1/retell/webhook` `?token=` | Retell events (call_started/ended/analyzed) → `calls.jsonl` |

`Card = { id, slug, title: {en,ar}, district: {en,ar}, price: {en,ar} (formatted), beds, baths, areaSqm, image: { src, thumb }, url: { en, ar } }`. Inventory source: `src/data/listings.json` from the repo checkout the service runs in (`~/bona` at first; `~/bona-bot` once intake exists — configurable `BONA_REPO`), reloaded every 10 min or on file change. Search: simple filters + token match on title/district/highlights (both languages), price parsing of "4.5m"/"٤ ملايين" best-effort.

**Tunnel + systemd** (`services/deploy/`): `install.sh` (idempotent) — `cloudflared tunnel create bona` (skip if exists) → `~/.cloudflared/bona.yml` (`ingress: bona-api.azoz.uk → http://localhost:4102`, catch-all 404) → `cloudflared tunnel route dns bona bona-api.azoz.uk` → units `cloudflared-bona.service` and `bona-api.service` (user, `Restart=always`) → `systemctl --user daemon-reload && enable --now` → `curl https://bona-api.azoz.uk/health`. Optional: add an Uptime Kuma HTTP monitor for `/health` using `~/.secrets/uptime-kuma.env` (only if a simple REST/socket path exists; skip otherwise).

**Acceptance.** `node --test services/api/test` green (search, card formatting, rate limit, CORS, tool auth). `curl -X POST https://bona-api.azoz.uk/v1/chat/session -d '{"locale":"ar"}'` returns a greeting; a follow-up message asking for "villa in Al Khalidiyah" returns a `show_listing` action; `/v1/call/token` returns a token; provisioning script is re-runnable. Document all ids + curl examples in `services/README.md`.

## 4. Workstream B2 — Concierge UI in the site (`src/components/concierge/`)

**Placement.** Replace the lone `WhatsAppFloat` with a floating **concierge cluster** (bottom-end): primary pill "Concierge / الكونسيرج" that opens a panel, plus the existing WhatsApp icon kept as a secondary circle (WhatsApp deep-link behaviour unchanged, `waMessage` prop preserved). Panel = bottom-end drawer on desktop (≈ 400×640), full-height sheet on mobile; ivory/ink/champagne tokens, Cormorant display + IBM Plex Arabic; RTL mirrored; view-transition safe (idempotent init on `astro:page-load`, cleanup on `astro:before-swap`); focus trap, Esc closes, `aria-live` for new messages; respects `prefers-reduced-motion`.

**Tabs.** *Chat* and *Call*. Header shows "Dana — Bona concierge" with a subtle champagne status dot.
- **Chat**: greeting bubble from `/v1/chat/session`; input + send; typing indicator; agent messages; **listing cards inline** (image, title, district, price, "View →" link to `url[locale]`) from `actions.show_listing`; `navigate` action → soft-navigate (`location.assign`) after a 600 ms "Opening…" note (never navigate without showing what happens); `whatsapp` action → button. Quick replies on first open: Houses · Apartments · Book a viewing · Talk to a person. Session persisted in `sessionStorage` (`bona.chat.<locale>`) so it survives page navigation; "New conversation" link. Error/offline → calm fallback card: "Dana is resting — reach us on WhatsApp" with the wa link.
- **Call**: large circular Call button (ink with champagne ring) → mic permission → `/v1/call/token` → `RetellWebClient.startCall({ accessToken })`; states: connecting / listening / Dana speaking (pulse animation driven by `agent_start_talking`/`agent_stop_talking`) / ended; timer; Mute + End; live **"Mentioned properties"** cards by polling `/v1/call/:callId/context` every 3 s during the call; live captions from `update` events (optional, small); on `error` or unsupported browser → phone/WhatsApp fallback. Pin `retell-client-js-sdk` in `package.json` and import it in the component script (bundled by Astro, no CDN).
- **Entry points**: on listing pages the panel opens with the listing context (`page` = path; quick reply "Ask Dana about this home"). A discreet text link "Ask Dana" in the Contact page hero and in the mobile drawer.

**Config**: `src/data/site.json` → `"concierge": { "enabled": true, "apiBase": "https://bona-api.azoz.uk", "name": {"en":"Dana","ar":"دانة"} }`. All strings in `src/lib/i18n.ts` (`ui.concierge*`). Privacy: add one paragraph to `src/data/privacy.json` (both languages) — conversations/calls are processed by our AI concierge provider (Retell AI, US) to answer questions and register enquiries. `noindex` not needed (widget only).

**Acceptance.** `npm run build` clean, `astro check` no new errors, zero console errors with the API mocked (`apiBase` → a local stub in tests) and with the API down (fallback card). Works in EN (LTR) and AR (RTL), 375 px and 1440 px. Lighthouse-style: the widget script is deferred and adds < 60 KB gz (Retell SDK loaded lazily only when Call tab is opened — `await import()`).

## 5. Workstream C — Hero-image curation for the whole inventory (`scripts/curate/`)

1. Write `scripts/curate/IMAGE-RUBRIC.md` — the house standard for choosing and ordering photos of a luxury property (hero = one wide, sharp, well-lit exterior/pool/waterfront/skyline shot that states the property's strongest selling point; landscape ≥ 3:2; no people, cars, clutter, text, watermarks, split screens; no floor plans/renders when real photos exist — for developer units (Kian) pick the cleanest exterior/lobby render; apartments: view or living space or façade; land: keep satellite z17 first; golden hour beats noon; interiors follow in the order a guest walks the home: entrance/hall → living/majlis → dining/kitchen → master → bathrooms → terrace/garden/amenities → aerial last; 8–10 images, dedupe near-duplicates; every image gets the right `room` key). Include a 10-point scoring rubric so a model can score candidates consistently. The intake pipeline reads this file at runtime.
2. For **every** listing in `listings.source.mjs` (published 26 + curated hidden ones), render a contact sheet of its gallery folder (`contact-sheet.mjs`, 5–6 cols, ≥ 400 px tiles; several sheets if > 30 photos), **look at them**, and choose the hero + ordered set per the rubric. Consider the *whole folder*, not just today's picks. Respect: hero unique across the file; units of one developer may share non-hero images; land untouched.
3. Apply to `listings.source.mjs` (`images` arrays + `room` keys; extend `rooms.mjs` only if a room is missing), run `build.mjs` + `validate.mjs --head`, `npm run build`.
4. Deliverables: `docs/curation/2026-09-05-hero-review.md` (table: listing · old hero (index/room) · new hero · one-line reason · changed? ) and `docs/curation/hero-before-after.jpg` (old vs new hero per listing, labelled) so the owner can eyeball it.

**Acceptance.** Validator green; at least the top-of-home heroes (`heroListings(3)`, featured) are wide exterior/pool/view shots; report present.

## 6. Integration, review, QA, ops (orchestrator)

- Branches/worktrees: `feat/wa-intake` (A), `feat/concierge-api` (B1), `feat/concierge-ui` (B2), `feat/hero-curation` (C) under `~/bona-wt/<name>`. File ownership as above; only B2 touches `Base.astro`, `i18n.ts`, `global.css`, `site.json`, root `package.json`; only C touches `listings.source.mjs`/`rooms.mjs`; only A touches `build.mjs`/`validate.mjs`/`LISTING-SCHEMA.md`; B1 owns `services/package.json`, `services/deploy/install.sh`, tunnel units; A owns `services/deploy/bona-intake.service`. `src/data/listings.json` is generated — the merger re-runs `build.mjs`.
- Merge order: C → A → B1 → B2. After each merge: `node scripts/curate/build.mjs && node scripts/curate/validate.mjs && npm run build`.
- Reviews (owner rule): Claude reviewer pass + Codex (`codex exec`) second opinion per workstream; disagreements reported explicitly. Fix, re-run tests/build.
- Deploy: push main → Pages. Start services (`services/deploy/install.sh`), verify `/health` via tunnel, live browser QA (Windows Chrome CDP) of chat + call on bona.azoz.uk EN/AR, end-to-end WhatsApp test (`#test` PDF sent through the owner's instance to the Bona group by the orchestrator, then one real publish if a suitable brochure exists).
- Docs: `docs/OWNER-RUNBOOK.md` new sections (WhatsApp intake how-to + commands; concierge; costs — Retell per-minute/message on the owner's balance; what to do if the PC is off), `services/README.md`, memory note.

## 7. Out of scope today (explicitly)
Moving services to the VPS (needs owner SSH), Bona's own WhatsApp Business number, human live-chat handover, multi-PDF merges, Instagram auto-posting of new listings (hook point: after publish, call `scripts/instagram-post.mjs` once IG API access exists).
