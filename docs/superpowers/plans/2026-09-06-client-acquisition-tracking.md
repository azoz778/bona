# Client Acquisition & Tracking Stack — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Bona client gets a recorded source (UTM / click id / referrer / first+last touch) and journey (pages → listing → CTA → WhatsApp/Dana → pipeline stage), stored in one SQLite file on bona-api, shown in a private dashboard, and echoed to Meta, GA4 and Snapchat — behind a PDPL consent banner.

**Architecture:** An inline attribution script on the static Astro site posts events to bona-api and appends a per-session `Ref` code to every WhatsApp deep link; bona-api (dependency-free Node 24, `node:sqlite`) stores sessions/events/leads, polls the owner's Evolution WhatsApp instance read-only to match `Ref` codes to conversations, fans conversions out to ad platforms idempotently, and serves a WhatsApp-OTP-protected dashboard. Spec: `docs/superpowers/specs/2026-09-06-client-acquisition-tracking-design.md` (authoritative for behaviour; this plan is authoritative for file layout and order).

**Tech Stack:** Astro 7 + Tailwind 4 (site, GitHub Pages), Node 24 `node:http` + `node:sqlite` + `node:test` (bona-api, zero npm deps), Evolution API 2.3.7 (`POST /chat/findMessages`), Retell (metadata passthrough), Meta CAPI v21, GA4 Measurement Protocol, Snap CAPI v3, Cloudflare Tunnel, systemd --user.

---

## 0. Working rules for every workstream agent

1. **Never work in `~/bona`.** A third session has uncommitted WIP there. Create your worktree:
   ```bash
   cd ~/bona && git fetch -q origin && git worktree add -b <branch> ~/bona-wt/<name> origin/main
   cd ~/bona-wt/<name> && npm ci --silent   # site workstreams only; services need no install
   ```
2. **Tests:** API → `cd ~/bona-wt/<name>/services && node --test api/test/*.test.mjs` (194 tests pass today; keep them green). Intake → `node --test intake/test/*.test.mjs` (396 today). Site → `npm run build` and `npm run check` must pass.
3. **Keep intact** (owner rules + concierge session): `?concierge_api=` override stays localhost-only; `/v1/tools/*` auth-before-body + `X-Bona-Token`; CORS allowlist (`lib/cors.mjs`); daily budget counters; Bona copy never mentions TK; prices never invented; Evolution is **never** given a webhook; secrets are read only inside Node (`lib/env.mjs`), never `cat`-ed, never logged.
4. TDD: failing test → minimal code → green → commit, small commits, messages in the repo's style (`api: …`, `site: …`, `ops: …`, `intake: …`). Commit trailer:
   ```
   Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
   Claude-Session: https://claude.ai/code/session_01B1ZPwUTgE3TDXHeauEHZKK
   ```
5. Do not merge, push `main`, restart services, or touch `~/.secrets`. Report back with: branch, commits, test counts, anything in the spec you could not honour and why.
6. Copy, do not call, TK code: `~/tk/src/touchpoints.js`, `~/tk/src/attribution.js`, `~/tk/src/pixel.js`, `~/tk/middleware/capture-attribution.js`, `~/tk/src/share-links.js`, `~/tk/src/ctwa.js` are read-only references (CommonJS, Green API). Take the logic, not the files.

## 1. File structure (locked)

```
services/api/
  index.mjs                      modify: new routes, attr plumbing, poller + fanout + dashboard wiring, health
  lib/db.mjs                     NEW  openDb(file) → DatabaseSync + migrate(); helpers upsertSession, insertEvent, leads CRUD, touchpoints, stages, fanout queue, auth
  lib/phone.mjs                  NEW  normalisePhone(raw) → '9665…' | null ; westernDigits()
  lib/events.mjs                 NEW  EVENT_NAMES, validateEvent(body) → {ok, event} | {ok:false, error}, sessionFromEvent()
  lib/leads.mjs                  modify: keep JSONL append; add createOrMergeLead(db, input, meta), leadNote() gets a source line
  lib/attribution.mjs            NEW  sourceFromTouch(touch) → {source, medium, campaign, campaign_id, content, click_ids}; REF_RE; parseRef(text)
  lib/import-legacy.mjs          NEW  importJsonl(db, dataDir) — idempotent import of leads/chats/calls .jsonl
  lib/wa-poller.mjs              NEW  createPoller({db, evolution, sendWhatsApp, log, now}) → {tick(), start(), stop(), status()}
  lib/evolution.mjs              NEW  findMessagesWindow({baseUrl, apiKey, instance, gte, lte, page, offset, fetchImpl})
  lib/fanout/index.mjs           NEW  createFanout({db, cfg, fetchImpl, log, now}) → {enqueue(eventRow, kind), tick(), status()}
  lib/fanout/meta.mjs            NEW  buildMetaEvent(), sendMeta()
  lib/fanout/ga4.mjs             NEW  buildGa4Payload(), sendGa4()
  lib/fanout/snap.mjs            NEW  buildSnapEvent(), sendSnap()
  lib/fanout/hash.mjs            NEW  sha256Hex(), hashPhone(), hashExternalId()
  lib/dashboard/auth.mjs         NEW  createAuth({db, sendWhatsApp, now, log}) → {requestCode(ip), verify(code, ua), check(cookieToken), logout(token)}
  lib/dashboard/stats.mjs        NEW  SQL for overview / sources / listings funnel / pipeline / match quality / spend CPL
  lib/dashboard/render.mjs       NEW  layout(), pages: overview, leads, leadDetail, listings, spend, integrations, login; inline SVG bars/lines
  lib/dashboard/routes.mjs       NEW  handleDashboard(req,res,ctx) + handleAdmin(req,res,ctx) (cookie + X-Bona-Dash + origin)
  test/*.test.mjs                NEW per module (db, phone, events, attribution, import-legacy, wa-poller, evolution, fanout-*, auth, stats, routes-dashboard) + modify http.test.mjs/tools.test.mjs
services/deploy/
  bona-api.service               modify: EnvironmentFile for bona-marketing.env; BONA_WA_POLL=1
  install.sh                     modify: ensure bona-marketing.env exists (from example), mention poller
  bona-marketing.env.example     NEW
services/intake/lib/commands.mjs + test/commands.test.mjs   modify (WS-F, last): `licence`, `wafi`
services/api/retell/prompt.md   modify: recording/AI disclosure in the opening
src/scripts/attribution.js      NEW  (inline; no imports; ES5-safe)
src/scripts/tags.js             NEW  (inline; consent-gated loaders)
src/components/Consent.astro    NEW
src/components/seo/Head.astro   modify: analytics block → BONA_TAGS + attribution/tags inline scripts + CSP meta + gsc meta
src/layouts/Base.astro          modify: <Consent/>, body data-listing, listing prop
src/components/EnquiryForm.astro modify: Ref line + POST /v1/enquiry
src/components/concierge/client.ts, call.ts, Concierge.astro   modify: attr in POST bodies, notice line, concierge_open event
src/components/pages/ListingPage.astro   modify: REGA block, data-cta/data-track attributes
src/components/{Header,Footer,WhatsAppFloat}.astro, pages/{HomePage,PropertiesPage,ContactPage}.astro   modify: data-cta attributes only
src/components/RegaBlock.astro  NEW
src/lib/listings.ts             modify: `licence?` type
src/lib/qr.ts                   NEW  tiny QR encoder (byte mode, EC level M, vendored, no deps) → SVG path
src/lib/i18n.ts                 modify: new ui keys (consent, rega, notice)
src/data/site.json              modify: analytics {ga4, metaPixel, snapPixel, gscVerification}, advertiser
src/data/privacy.json           modify: sections
src/data/integrations.json      modify: rows
src/pages/dashboard/index.astro + src/components/dashboard/*   modify: drop Leads, add link card
scripts/curate/validate.mjs, build.mjs, licences.json(NEW)   modify: licence shape + merge
scripts/qr-selftest.mjs         NEW  (renders one QR and checks it decodes with the same table — see WS-A Task A7)
scripts/marketing/verify-integrations.mjs   NEW
scripts/portal-export.mjs       NEW
scripts/domain-cutover.mjs      NEW
docs/checklists/{meta-bona-portfolio,google-bona,snapchat-bona,aqar,rega-ad-licences,pdpl}.md   NEW
docs/compliance/pdpl-transfer-risk-assessment.md   NEW
docs/OWNER-RUNBOOK.md           modify
services/README.md              modify: new routes, env, poller, dashboard
```

## 2. Shared contracts (all workstreams code against these)

### C1 Event payload (site → `POST /v1/events`, `Content-Type: text/plain` or `application/json`)
```json
{"v":1,"event_id":"mf3k2a1b-9c4e7f21","ts":1757150000000,"event":"whatsapp_click",
 "anon_id":"9f1c…32 hex","session_id":"mf3k2a-7b1c","ref":"K7Q2XR","page":"/properties/bona-w003/","locale":"en",
 "listing_id":"BONA-W003","props":{"cta":"listing_whatsapp","href":"https://wa.me/…"},
 "attr":{"first":{"ts":1757140000000,"landing":"/…","referrer":"https://l.instagram.com/","utm_source":"meta","utm_medium":"paid","utm_campaign":"villas_sep","utm_content":"reels","utm_term":null,"utm_id":"1203","click_ids":{"fbclid":"IwAR…"}},
         "last":{…same shape…},"fbp":"fb.1.…","fbc":"fb.1.…","ga":{"client_id":"123.456","session_id":"1757149000"},"scid":null,"ttp":null},
 "consent":{"analytics":true,"ads":true}}
```
Rules: `event` ∈ `EVENT_NAMES = ['page_view','listing_view','gallery_open','tour_open','video_play','brochure_download','whatsapp_click','call_click','form_submit','consent_update','concierge_open']` (browser) — server-only names `concierge_chat_start, concierge_call_start, lead_created, lead_stage` are rejected from the browser. `anon_id` `/^[0-9a-f]{32}$/`; `session_id` `/^[a-z0-9-]{6,24}$/`; `ref` `/^[A-HJ-NP-Z2-9]{5,6}$/`; `event_id` `/^[a-z0-9-]{8,40}$/`; `listing_id` `/^BONA-W?\d{3}$/` or null; strings capped at 300 chars, `props` ≤ 2 KB, whole body ≤ 8 KB. Response `204`. Unknown/invalid → `400 {error:'bad_event'}`.

### C2 Ref line and regex
Text appended to every WhatsApp prefilled message (own last line): `Ref <LISTING or BONA> · <CODE>`, e.g. `Ref BONA-W003 · K7Q2XR`.
`REF_RE = /\bRef\s+(BONA(?:-W?\d{3})?)?\s*[·\-:|]?\s*([A-HJ-NP-Z2-9]{5,6})\b/i` → `{listingId|null, code}`. Alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, code length 6 (client mints; server stores `sessions.ref` UNIQUE, `INSERT OR IGNORE`).

### C3 Lead input (internal) and `createOrMergeLead(db, input, meta)`
```js
input = { name, phone, waJid, waLid, interest, budget, timeline, district, listingId, language, notes, snippet }
meta  = { channel: 'whatsapp'|'form'|'concierge_chat'|'concierge_voice'|'manual', matchMethod: 'ref'|'phone'|'keyword'|'time_window'|'concierge'|'form'|'ad_meta',
          sessionId, anonId, ref, eventId, adMeta, now }
→ { lead, created: boolean }   // merges by phone_e164, else by wa_jid/wa_lid; a merge never overwrites a non-empty name/notes; every call writes one touchpoint
```
Source resolution: if `sessionId` resolves a session → `source/medium/campaign/campaign_id/content/click_ids` from `last_touch` via `sourceFromTouch()`, and `first_touch`/`last_touch` copied; consent flags copied. Else `source='whatsapp_organic'|'form'|'concierge'`, `medium='(none)'`. `lead_id` = `LEAD-YYYYMMDD-<4 hex>` (keep the existing format). New leads insert `lead_stage_history(stage='new', actor='system')` and enqueue fan-out `lead_created`.

### C4 Retell metadata
Chat session and call token bodies accept `attr: {anon_id, session_id, ref, listing_id}` (validated with C1 regexes; all optional). Retell `metadata` = `{ locale, page, source:'bona-web', anon_id, session_id, ref, listing_id }`. Tool ctx: `ctx.attr = body.call?.metadata ?? body.chat?.metadata ?? {}`.

### C5 Fan-out queue row and destinations
`fanout(event_id, dest ∈ 'meta'|'ga4'|'snap', status ∈ 'pending'|'sent'|'failed'|'skipped', attempts, next_at, last_error, response, ts)`. `kind` derived from the event name (`whatsapp_click`, `form_submit`, `lead_created`, `lead_stage`). Backoff after failure: attempts 1..5 → +60 s, +5 min, +30 min, +2 h, +6 h; then `failed`. Skips (no key, no consent, no session) are recorded as `skipped` with a reason in `last_error`.

### C6 Environment (all optional; feature off when empty)
`~/.secrets/bona-marketing.env` (loaded by `lib/env.mjs` **after** `bona-services.env`): `META_PIXEL_ID, META_CAPI_TOKEN, META_TEST_EVENT_CODE, GA4_MEASUREMENT_ID, GA4_API_SECRET, SNAP_PIXEL_ID, SNAP_CAPI_TOKEN`. In `bona-services.env`: `BONA_WA_POLL` (`1`), `BONA_WA_POLL_MS` (`45000`), `BONA_FANOUT_MS` (`20000`), `BONA_DB_FILE` (default `${BONA_DATA}/bona.db`), `BONA_DASH_COOKIE_DAYS` (`30`). Site-public IDs live in `src/data/site.json.analytics`.

### C7 Admin JSON (cookie `bona_dash` + header `X-Bona-Dash: 1` + Origin must be the API's own origin or absent)
- `GET /v1/admin/stats?days=14` → `{ daily:[{day, sessions, wa_clicks, leads, viewings}], sources:[{source, medium, campaign, first_touch_leads, last_touch_leads, clicks, spend_sar, cpl}], match:{ref, phone, keyword, time_window, concierge, form, ad_meta}, pipeline:[{stage, count, median_age_h}], response:{median_min, p90_min} }`
- `GET /v1/admin/leads?stage=&q=&limit=100` → `{leads:[…row fields…]}`; `GET /v1/admin/leads/:id` → `{lead, journey:[{ts, kind:'event'|'touchpoint'|'stage'|'note', …}]}`
- `POST /v1/admin/leads/:id/stage {stage, value_sar?, note?}` → `{ok, lead}`; `POST /v1/admin/leads/:id/note {note}` → `{ok}`; `POST /v1/admin/spend {day, platform, campaign_id, campaign_name, spend_sar, clicks?, impressions?}` → `{ok}`
- `GET /v1/admin/listings` → `[{listing_id, title, status, views, gallery, tour, brochure, wa_clicks, leads, licence:{adNumber, adExpiry, wafiNumber, flags:[…]}}]`

---

## WS-B — API store (branch `feat/track-store`, worktree `~/bona-wt/track-store`) — lands first

### Task B1: `lib/phone.mjs`
**Files:** Create `services/api/lib/phone.mjs`, `services/api/test/phone.test.mjs`
- [ ] Test cases: `'+966 59 329 6933'→'966593296933'`, `'0593296933'→'966593296933'`, `'593296933'→'966593296933'`, `'٠٥٩٣٢٩٦٩٣٣'→'966593296933'`, `'00966593296933'→'966593296933'`, `'+971501234567'→'971501234567'`, `'12'→null`, `''→null`, `'abc'→null`.
- [ ] Implement `westernDigits(s)` (Arabic-Indic ٠-٩ and Persian ۰-۹ → 0-9) and `normalisePhone(raw)`: strip everything but digits after westernising; `^00` → drop; `^0(5\d{8})$` → `966$1`; `^5\d{8}$` → `966…`; result must be 8–15 digits else null.
- [ ] Run `node --test api/test/phone.test.mjs` → PASS. Commit `api: phone normaliser (E.164 digits, Saudi mobile forms, Arabic digits)`.

### Task B2: `lib/db.mjs` — schema + helpers
**Files:** Create `services/api/lib/db.mjs`, `services/api/test/db.test.mjs`
- [ ] Tests (use a temp file via `fs.mkdtempSync`): `openDb()` creates the file with mode 0600 and runs migrations idempotently (open twice, `PRAGMA user_version` = 1); `upsertSession()` keeps `first_touch` from the first call and updates `last_touch`, `last_seen`, `pages`, consent; `insertEvent()` ignores a duplicate `event_id` (`INSERT OR IGNORE`, returns `false`); `insertLead/getLeadByPhone/getLeadByJid/updateLead`; `addTouchpoint`; `setStage()` appends history and updates `stage, stage_ts`; `enqueueFanout()` + `dueFanout(now)` + `markFanout()`; `authCodes` create/consume; `authSessions` create/check/delete; `pruneWaSeen(before)`.
- [ ] Implement with `import { DatabaseSync } from 'node:sqlite'`; `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000`. Schema exactly as spec §4.1 (JSON columns are TEXT holding JSON). Migrations array keyed by `user_version`. All helpers are synchronous and take plain objects; JSON columns are stringified/parsed at the boundary. Export `newId(prefix)` = `${prefix}-${Date.now().toString(36)}-${randomHex(4)}`.
- [ ] Run tests → PASS. Commit `api: SQLite store (node:sqlite) — sessions, events, leads, touchpoints, stages, fanout, auth`.

### Task B3: `lib/attribution.mjs`
**Files:** Create `services/api/lib/attribution.mjs`, `services/api/test/attribution.test.mjs`
- [ ] Tests: `parseRef('Hello\nRef BONA-W003 · K7Q2XR')→{listingId:'BONA-W003',code:'K7Q2XR'}`, `parseRef('ref bona - k7q2xr')→{listingId:'BONA',code:'K7Q2XR'}`, `parseRef('Ref K7Q2X')→{listingId:null,code:'K7Q2X'}`, `parseRef('no ref')→null`, `parseRef('Refund 12345')→null`; `sourceFromTouch({utm_source:'meta',utm_medium:'paid',utm_campaign:'villas_sep',utm_id:'1203',click_ids:{fbclid:'x'}})→{source:'meta',medium:'paid',campaign:'villas_sep',campaign_id:'1203',content:null,click_ids:{fbclid:'x'}}`; `sourceFromTouch(null)→{source:'(direct)',medium:'(none)',…}`; referrer-only touch → `{source:'instagram.com', medium:'social_or_organic'}` (host list `instagram|facebook|google|tiktok|snapchat|x\.com|twitter|linkedin|youtube|whatsapp`).
- [ ] Implement `REF_RE` (C2), `parseRef`, `sourceFromTouch`, `isExternalTouch(touch)`.
- [ ] Commit `api: Ref parser and source resolution from touch bundles`.

### Task B4: `lib/events.mjs` + `POST /v1/events`
**Files:** Create `services/api/lib/events.mjs`, `services/api/test/events.test.mjs`; modify `services/api/index.mjs` (dispatcher: route **before** the JSON-only gate; own limiter `events` 240/min per IP; parse body as text then `JSON.parse`; body cap 8 KB), `services/api/test/http.test.mjs` (add: 204 on a valid text/plain event; 400 on unknown event name; 403 on a foreign stated Origin; 413 on 9 KB; server-only names rejected; session row created with `ip`, `ua`, `country` from `CF-IPCountry`).
- [ ] Tests for `validateEvent(body)` per C1 (each regex, caps, unknown keys dropped, `props` size cap, `consent` booleans coerced).
- [ ] Implement `validateEvent` and `recordEvent(db, event, server)`: `upsertSession` (from `attr` + consent), `insertEvent` (`src_first`/`src_last` = JSON of `attr.first/last`), and when `event.event ∈ {whatsapp_click, form_submit}` → `db.enqueueFanout(event_id, ['meta'])` (GA4 excluded for clicks per spec; `form_submit` gets `['meta','ga4','snap']` only after the enquiry lead exists — Task B6 handles that, so here enqueue `meta` for `whatsapp_click` only).
- [ ] Wire in `index.mjs`: `cfg.dbFile` (C6), `const db = openDb(cfg.dbFile)` in `createApp`, route `/v1/events` (POST only). `health()` adds `db:'ok'` (a `SELECT 1`).
- [ ] Commit `api: /v1/events — first-party event intake with session upsert`.

### Task B5: Lead model — `createOrMergeLead`, owner note source line
**Files:** Modify `services/api/lib/leads.mjs`, `services/api/test/leads.test.mjs` (new)
- [ ] Tests: create from WhatsApp with a session → source copied from `last_touch`, first/last touch stored, `touchpoints` row with `event_type:'lead_created'`, `stage:'new'`, history row, fanout queued for `lead_created` with `['meta','ga4','snap']`; second call with same phone → `created:false`, touchpoint `inbound_message`, name not overwritten by empty; jid-only lead (no phone) merges by `wa_jid`; `leadNote()` includes `Source: meta / paid · villas_sep · Ref K7Q2XR · BONA-W003` when present and `Match: inferred (time window)` for `time_window`.
- [ ] Implement per C3; keep `appendLead` (JSONL) and call it from `createOrMergeLead` when `created` (so the raw log continues). `LEAD_FIELDS` unchanged.
- [ ] Commit `api: lead model — create/merge by phone or jid, touchpoints, stage history, source line in the owner note`.

### Task B6: `POST /v1/enquiry`
**Files:** Modify `services/api/index.mjs`, `services/api/test/http.test.mjs`
- [ ] Tests: valid body → `200 {lead_id}`, lead `channel:'form'`, `match_method:'form'`, `listing_id` kept, fanout `lead_created` queued, owner note sent (mock `sendWhatsApp`); invalid phone → 400; 7th request in a minute from one IP → 429; foreign Origin → 403.
- [ ] Implement: JSON route through the existing browser-route path (origin check, 415 gate) but **not** billable; limiter `enquiry` 6/min; fields per spec §3.3; `event_id` from the body (regex) is reused so the client-side `fbq('track','Lead',…,{eventID})` dedupes with CAPI; record a `form_submit` event row if the client did not already send one (`INSERT OR IGNORE` on the same `event_id`).
- [ ] Commit `api: /v1/enquiry — form leads land even when WhatsApp never opens`.

### Task B7: Retell metadata plumbing + concierge events
**Files:** Modify `services/api/index.mjs` (`chatSession`, `callToken`), `services/api/lib/tools.mjs` (`run()` ctx.attr; `create_lead` → `createOrMergeLead` with `channel: ctx.channel==='chat'?'concierge_chat':'concierge_voice'`, `matchMethod:'concierge'`, sessionId/anonId/ref/listingId from `ctx.attr`), tests `tools.test.mjs`, `http.test.mjs`.
- [ ] Tests: session/call bodies with `attr` → Retell mock receives metadata with the four ids; malformed attr ids are dropped (not 400); `create_lead` with `body.call.metadata.session_id` pointing at a stored session → lead source from that session; server records `concierge_chat_start`/`concierge_call_start` events tied to `session_id`.
- [ ] Commit `api: concierge leads inherit the visitor's source via Retell metadata`.

### Task B8: Legacy import
**Files:** Create `services/api/lib/import-legacy.mjs`, `services/api/test/import-legacy.test.mjs`; modify `index.mjs` (run once at startup, log counts).
- [ ] Tests: given `leads.jsonl` with 2 records → 2 leads with `legacy_id`, `channel` from record (`chat`→`concierge_chat`, `voice`→`concierge_voice`), running twice inserts nothing new; `calls.jsonl`/`chats.jsonl` → events `concierge_call_end`/`concierge_chat_end` are **not** created (out of scope) but the lead linking by `conversationId` is attempted when a lead has that id.
- [ ] Commit `api: one-time import of the JSONL leads into SQLite`.

### Task B9: docs + README
- [ ] Update `services/README.md`: routes table (events, enquiry, admin placeholder), env keys (C6), data files (`bona.db`), note that `leads.jsonl` remains the raw log. Commit `docs(api): events/enquiry routes, env, SQLite store`.

**Done when:** `node --test api/test/*.test.mjs` green (≥ 194 + new), `node services/api/index.mjs` boots with an empty `~/bona-data` copy (`BONA_DATA=/tmp/x`), `curl -X POST localhost:4102/v1/events -H 'Content-Type: text/plain' --data '<C1 sample>'` → 204.

---

## WS-A — Site (branch `feat/track-site`, worktree `~/bona-wt/track-site`) — parallel with B; targets the C1/C2/C4 contracts

### Task A1: `site.json` + `Head.astro` tag config
- [ ] `src/data/site.json`: `analytics: {ga4:null, metaPixel:null, snapPixel:null, gscVerification:null}`, `advertiser: {name:{en:'Abdulaziz Zidan', ar:'عبدالعزيز زيدان'}, fal:'1100313556'}`.
- [ ] `Head.astro`: remove the unconditional gtag/fbq blocks; emit `<script is:inline>window.BONA_TAGS={ga4,metaPixel,snapPixel};window.BONA_API='<site.concierge.apiBase>';</script>`, then inline `attribution.js` and `tags.js` (read at build with `fs.readFileSync` + `set:html`, or `?raw` import), `<meta name="google-site-verification">` when set, and the CSP meta (Task A6). Commit `site: tag config moves behind consent; site verification meta`.

### Task A2: `src/scripts/attribution.js`
- [ ] Implement exactly spec §3.1 (based on the research snippet in `docs/research/2026-09-06-attribution-mechanics-research.md` §1.5, adapted): bind-once guard; `astro:page-load` → `page_view` (+ `listing_view` when `document.body.dataset.listing`); consent-aware storage (`bona_consent` present with any `true` → localStorage + `bona_id` cookie, else sessionStorage); ref 6 chars; `event_id` = `Date.now().toString(36)+'-'+8 hex`; `send()` with `text/plain` + `keepalive`; delegated capture-phase click handler (wa.me/api.whatsapp.com rewrite + `whatsapp_click`, `tel:` → `call_click`, `[data-track]`); `window.bonaTrack`; mirror to `gtag`/`fbq`/`snaptr` **only if defined** (Task A3 loads them). Never throw: wrap everything.
- [ ] Manual test: `npm run dev`, open a listing with `?utm_source=test&fbclid=abc`, check `localStorage.bona_attr` (after accepting consent) and that the WhatsApp link's `text` ends with `Ref BONA-… · XXXXXX`; with `BONA_API` pointing at a local bona-api (WS-B) confirm a 204 in the network tab.
- [ ] Commit `site: first-party attribution — touches, session Ref, events, WhatsApp link rewrite`.

### Task A3: consent banner + `tags.js`
- [ ] `src/components/Consent.astro` (mounted in `Base.astro`): AR/EN copy via new `ui` keys (`consentTitle, consentText, consentAccept, consentEssential, consentSettings, consentPrivacy`), fixed bottom sheet, `role="dialog"`, keyboard reachable, hidden once `bona_consent` exists; footer link `data-consent-open` reopens. On choice: write `bona_consent`, fire `consent_update`, call `window.bonaTagsLoad()`.
- [ ] `src/scripts/tags.js`: `window.bonaTagsLoad()` idempotent; reads `bona_consent`; when `analytics` → gtag with `consent default denied` then `update granted` for `analytics_storage` (and `ad_*` when `ads`), `config` with `send_page_view:false`, page views on `astro:page-load`; when `ads` → Meta Pixel (`init`, `track PageView` per navigation) and Snap (`snaptr init` + `PAGE_VIEW`). Exposes `window.bonaTags = {ga4:boolean, meta:boolean, snap:boolean}` for attribution.js mirroring.
- [ ] Commit `site: PDPL consent banner; Google/Meta/Snap tags load only after consent`.

### Task A4: CTAs and data attributes
- [ ] Add `data-cta` to every WhatsApp/tel link per spec §3.1 list (Header, Footer, WhatsAppFloat, HomePage, PropertiesPage off-market, ContactPage, ListingPage, concierge fallback), `data-track="brochure_download"` on the brochure link, `data-track="tour_open"` on "Open in Matterport" + the facade click, `data-track="gallery_open"` on the gallery trigger, `data-track="video_play"` via `play` listener in the video component; `Base.astro` accepts `listingId?: string` → `<body data-listing>`; ListingPage passes it. Commit `site: CTA and journey markers for tracking`.

### Task A5: EnquiryForm + concierge attr
- [ ] `EnquiryForm.astro`: append `Ref <listing|BONA> · <ref>` (read `window.BONA_ATTR.session.ref`); before opening WhatsApp, `fetch(BONA_API+'/v1/enquiry', {method:'POST', headers:{'Content-Type':'application/json'}, body, keepalive:true})` with the C1-style `attr`, `consent`, `event_id` (also used for `fbq Lead`) — failure ignored.
- [ ] `client.ts`/`call.ts`: include `attr: {anon_id, session_id, ref, listing_id}` from `window.BONA_ATTR` in `/v1/chat/session` and `/v1/call/token`; `Concierge.astro` adds the storage notice line under the input (ui keys `conciergeNotice`, link to `/privacy/`); fire `concierge_open` when the panel opens. Commit `site: enquiry form posts the lead; Dana carries the visitor's source`.

### Task A6: CSP meta
- [ ] In `Head.astro` add `<meta http-equiv="Content-Security-Policy" content="…">` with: `default-src 'self'; script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://connect.facebook.net https://sc-static.net; connect-src 'self' <apiBase> https://www.google-analytics.com https://*.google-analytics.com https://www.facebook.com https://tr.snapchat.com https://*.retellai.com wss://*.retellai.com https://*.livekit.cloud wss://*.livekit.cloud; img-src 'self' data: https:; media-src 'self' https:; frame-src https://my.matterport.com; style-src 'self' 'unsafe-inline'; font-src 'self'; worker-src 'self' blob:`. Verify in the browser with a real chat + a real call on `npm run preview` (check console for CSP violations, adjust). Commit `site: content-security-policy`.

### Task A7: REGA advertising block
- [ ] `src/lib/listings.ts`: `licence?: { adNumber?: string|null; adExpiry?: string|null; wafiNumber?: string|null; escrowAccount?: string|null } | null`.
- [ ] `scripts/curate/validate.mjs`: when `licence` present, check shape (`adExpiry` `YYYY-MM-DD`), strings ≤ 64. `scripts/curate/build.mjs`: merge `scripts/curate/licences.json` (`{ "BONA-001": {...} }`, create with `{}`) into curated listings; pass `licence` through for inbox listings.
- [ ] `src/lib/qr.ts`: vendored minimal QR encoder (byte mode, versions 1–10, EC M, mask auto) returning an SVG `<path>` string; `scripts/qr-selftest.mjs` encodes `https://bona.azoz.uk/properties/x/` and asserts module count and finder patterns (no external decoder available; keep the test structural).
- [ ] `src/components/RegaBlock.astro` (EN/AR): advertiser name + `FAL 1100313556` always; `Advertising licence <no> · valid until <date>` when present; `Wafi project licence <no>` when present; QR (SVG) of the listing URL; `ui` keys `regaAdvertiser, regaFal, regaAdLicence, regaValidUntil, regaWafi, regaVerify`. Mount in `ListingPage.astro` under the enquiry block. Commit `site: REGA advertising block on every listing`.

### Task A8: privacy notice, static dashboard, integrations rows
- [ ] `src/data/privacy.json`: add/adjust sections per spec §3.7 (ids `cookies`, `recipients`, `transfers`, `retention`, `recording`); bump `updated`.
- [ ] `src/pages/dashboard/index.astro` + `src/components/dashboard/*`: remove the Leads section and lead KPIs; add a "Private dashboard" card linking to `${apiBase}/dashboard`; delete `src/lib/dashboard/client/leads.ts` + csv if unused.
- [ ] `src/data/integrations.json`: rows `ga4, meta-pixel, meta-capi, snap, gsc, gbp, aqar, bona-sa, rega-licences, pdpl-ndgp` with `status:'pending-owner'` and the checklist link. Commit `site: privacy notice for tracking; static dashboard points at the private one`.

**Done when:** `npm run build && npm run check` green; preview shows the banner, Ref rewrite, events reaching a local bona-api (WS-B branch checked out in another worktree on `:4102` with `BONA_CORS_ORIGINS=http://localhost:4321`).

---

## WS-F — Ops, docs, intake commands (branch `feat/track-ops`, worktree `~/bona-wt/track-ops`) — parallel

### Task F1: env + units
- [ ] `services/deploy/bona-marketing.env.example` (C6 keys, empty values, comments with where each comes from). `bona-api.service`: add `EnvironmentFile=-%h/.secrets/bona-marketing.env` and `Environment=BONA_WA_POLL=1`. `install.sh`: copy the example to `~/.secrets/bona-marketing.env` (mode 0600) if missing; print that the poller is on. `lib/env.mjs`: `defaultEnvFiles()` appends `bona-marketing.env`. Commit `ops: marketing secrets file, poller enabled in the unit`.

### Task F2: owner checklists (`docs/checklists/`)
- [ ] `meta-bona-portfolio.md`: business.facebook.com → create portfolio "Bona" → Page "Bona Real Estate" (category Real Estate Agent, phone +966593296933, WhatsApp button) → link IG @bona.com.sa (Accounts Center) → Events Manager: dataset "Bona web" (get Pixel ID) → generate CAPI token → ad account (SAR, timezone Asia/Riyadh, payment) → Business settings → System users → "bona-bot" (admin) → token with scopes `ads_management ads_read business_management pages_show_list pages_read_engagement instagram_basic instagram_content_publish leads_retrieval` → assets assigned → domain verification (meta tag we already render? add `metaDomainVerification` to site.json if needed) → paste into `~/.secrets/bona-marketing.env` (`META_PIXEL_ID`, `META_CAPI_TOKEN`) and `~/.secrets/bona-meta-graph.env` (`META_ACCESS_TOKEN`, `META_PAGE_ID`, `IG_BUSINESS_ID`, `META_AD_ACCOUNT_ID`) → `node scripts/marketing/verify-integrations.mjs`.
- [ ] `google-bona.md`: finish bona.com.sa@gmail.com verification; GA4 property "Bona" (SAR, Asia/Riyadh) → web stream `https://bona.azoz.uk` (later bona.sa) → Measurement ID → Admin › Data streams › Measurement Protocol API secret → paste (`site.json.analytics.ga4`, `GA4_API_SECRET`); Search Console URL-prefix property → HTML tag → `site.json.analytics.gscVerification` → submit `sitemap-index.xml`; Google Business Profile ("Real estate agent", service area Jeddah, hide address, video verification); Google Ads later (advertiser verification needs CR or Saudi ID).
- [ ] `snapchat-bona.md`: ads.snapchat.com account (SAR), Pixel → `site.json.analytics.snapPixel`, CAPI token → `SNAP_CAPI_TOKEN`.
- [ ] `aqar.md`: individual plan SAR 2,000/yr, needs FAL + per-listing ad licence numbers; use `node scripts/portal-export.mjs` output.
- [ ] `rega-ad-licences.md`: FAL platform 12-step flow, brokerage contract with marketing scope, Wafi numbers for off-plan, `licence`/`wafi` WhatsApp commands, dashboard flags.
- [ ] `pdpl.md`: NDGP registration steps, banner + notice live, transfer risk assessment file, call recording disclosure. Create `docs/compliance/pdpl-transfer-risk-assessment.md` (one page: recipients, data categories, purposes, safeguards, retention, residual risk).
- [ ] Commit `docs: owner checklists for Meta, Google, Snapchat, Aqar, REGA licences, PDPL`.

### Task F3: `scripts/marketing/verify-integrations.mjs`
- [ ] Node script (loads env via `services/api/lib/env.mjs`): GA4 → `POST /debug/mp/collect` with a `test_event` and prints `validationMessages`; Meta → CAPI test event with `test_event_code` (or a `GET /{pixel}?fields=name` when no test code); Snap → `/events/validate`; GSC meta → fetch the live page and grep the tag; Retell/Evolution/bona-api `/health`. Writes statuses into `src/data/integrations.json` (`live`/`pending-owner`/`error` + `detail`), never prints secrets. Commit `ops: verify-integrations updates the integrations board`.

### Task F4: `scripts/portal-export.mjs`
- [ ] For each published listing: `dist/portal/aqar/<id>.txt` with AR then EN title, category, price line ("السعر عند الطلب" when onRequest), specs, district, licence line (ad licence / Wafi / "رخصة الإعلان: قيد الإصدار"), and `https://<site.url>/ar/properties/<slug>/?utm_source=aqar&utm_medium=portal&utm_campaign=listing&utm_content=<id>`. Test with `node --test` on a fixture listing. Commit `ops: Aqar export with tracked links`.

### Task F5: `scripts/domain-cutover.mjs`
- [ ] `--domain bona.sa --api api.bona.sa [--dry-run]`: reads `~/.secrets/cloudflare.env`; steps with clear logs: (1) verify the zone exists in Cloudflare (API `GET /zones?name=`) else print the owner step (add zone at Cloudflare, change NS at nic.sa) and stop; (2) DNS: apex `A` 185.199.108–111.153 + `AAAA` 2606:50c0:8000–8003::153, `www` CNAME `azoz778.github.io` (DNS-only), `api` CNAME `<tunnel-id>.cfargotunnel.com` (proxied) — tunnel id read from `~/.cloudflared/bona.yml`; (3) `site.json` url/futureDomain/concierge.apiBase, `public/CNAME`, `services/api/lib/cors.mjs` defaults; (4) GitHub Pages custom domain `gh api -X PUT repos/azoz778/bona/pages -f cname=bona.sa` then `https_enforced` after the cert; (5) `~/.cloudflared/bona.yml` ingress hostname → `api.bona.sa` and `cloudflared tunnel route dns --overwrite-dns bona api.bona.sa`; (6) `BONA_PUBLIC_API`/`BONA_SITE` in `bona-services.env` via `setEnvValues`; (7) print: run `provision.mjs`, restart units, add redirect rule bona.azoz.uk → bona.sa (owner if token lacks permission), update GA4 stream URL, add GSC property. `--dry-run` prints every call without executing. Commit `ops: bona.sa cutover script`.

### Task F6: Retell prompt disclosure + runbook + README
- [ ] `services/api/retell/prompt.md`: opening rule — first turn on a call states "This call is with Dana, Bona's AI concierge, and is recorded to handle your enquiry" (AR: "هذه المكالمة مع دانة، المساعدة الذكية لبونا، ويتم تسجيلها لمتابعة طلبك"); check `provision.mjs` `BEGIN_MESSAGE` and update both locales. Note in the runbook that provisioning must be re-run.
- [ ] `docs/OWNER-RUNBOOK.md`: replace §4 Analytics with links to the checklists; add §9 "Private dashboard" (URL, WhatsApp code login), §10 "REGA licences per listing", §11 "bona.sa cutover". `services/README.md`: env table additions, poller, dashboard (routes from WS-E once merged — leave a heading).
- [ ] Commit `docs: runbook for tracking, dashboard, licences, domain`.

### Task F7 (last, rebased on main after C/D/E land): intake `licence` / `wafi` commands
- [ ] `services/intake/lib/commands.mjs` `parseCommand`: `licence BONA-W003 <adNumber> <YYYY-MM-DD>` → `{cmd:'licence', id, adNumber, adExpiry}`; `wafi BONA-W003 <number>` → `{cmd:'wafi', id, wafiNumber}`; usage errors like the others. Tests in `services/intake/test/commands.test.mjs`. The command handler (find where `price` is applied to the inbox JSON and committed) sets `listing.licence = {...existing, adNumber, adExpiry}` / `wafiNumber`, commits `intake: licence (BONA-W003)`, replies "✅ Licence recorded…". Update the `help` text. Do **not** restart `bona-intake` (asus-62 owns it; ask the orchestrator).
- [ ] Commit `intake: licence and wafi commands`.

---

## WS-C — WhatsApp poller (branch `feat/track-poller`, from main after B merges)

### Task C1: `lib/evolution.mjs`
- [ ] Tests (mock fetch): `findMessagesWindow()` posts `{where:{messageTimestamp:{gte:'<ISO>', lte:'<ISO>'}}, page, offset}` to `/chat/findMessages/<instance>` with header `apikey`; returns `records` normalised as `{id:key.id, jid:key.remoteJid, jidAlt:key.remoteJidAlt??null, fromMe:!!key.fromMe, ts:<ms>, text:<conversation|extendedTextMessage.text|imageMessage.caption|''>, pushName, contextInfo:<message.extendedTextMessage?.contextInfo ?? record.contextInfo ?? null>}`; handles the two response shapes seen on 2.3.7 (`{messages:{records:[…]}}` and bare array — copy the fixture shape from `services/intake/test/evolution.test.mjs`); `messageTimestamp` in seconds or ISO both → ms; 5-page cap.
- [ ] Commit `api: Evolution findMessages window client`.

### Task C2: `lib/wa-poller.mjs`
- [ ] Fixtures: (a) inbound with `Ref BONA-W003 · K7Q2XR` from an unknown number and a matching session → lead `match_method:'ref'`, `listing_id` from ref, phone from jid, owner note sent with a source line; (b) same number again → merge, touchpoint `inbound_message`, no second note; (c) message "hi" from unknown number, no click nearby → discarded, `status().unmatched` +1, nothing in `events`/`leads`; (d) "مرحبا بونا" → lead `keyword`, `source:'whatsapp_organic'`; (e) `contextInfo.externalAdReply{sourceId:'123', ctwaClid:'x', sourceApp:'instagram'}` → lead `ad_meta`, touchpoint meta stored, source `instagram`/`ad_meta`; (f) unknown number 4 min after a `whatsapp_click` from a session without a lead → `time_window`, note says inferred; (g) `fromMe:true` reply to a lead's jid → `first_reply_ts` set; (h) `@g.us`, `status@broadcast`, own `fromMe` to self → ignored; (i) `key.id` seen twice → processed once; (j) `@lid` jid with `remoteJidAlt` → phone from the alt, both stored.
- [ ] Implement `createPoller`: cursor from `wa_cursor` (first run: now − 10 min); window `gte = cursor − 120 s`; after a tick set `last_ts = max ts seen`, `last_run = now`; `wa_seen` prune 7 days; matching precedence per spec §4.3; snippet ≤ 200 chars only on create; `sendWhatsApp(leadNote(...))` only on create; every tick in try/catch with `log({evt:'wa.poll.failed'})`; `status()` → `{lastRun, lastTs, lagS, unmatched, matchedTotal}`.
- [ ] Wire in `index.mjs`: when `cfg.waPoll` start with `setInterval(cfg.waPollMs).unref()`; `health().poller = poller.status()`; stop on `SIGTERM`.
- [ ] Commit `api: WhatsApp poller — Ref matching, keyword/ad-meta/time-window fallbacks, matched-only storage`.

---

## WS-D — Fan-out (branch `feat/track-fanout`, from main after B merges)

### Task D1: `lib/fanout/hash.mjs` + builders
- [ ] Tests: `hashPhone('966593296933')` = sha256 hex of the digits; `buildMetaEvent({kind:'lead_created', lead, session, event})` → `{event_name:'Lead', event_time:<s>, event_id, action_source:'website', event_source_url:<site+page>, user_data:{ph:[hash], external_id:[hash(anon_id)], fbc, fbp, client_ip_address, client_user_agent, country:[sha256('sa')]}, custom_data:{content_ids:[listing], content_type:'product', currency:'SAR', value:0, lead_source:<channel>}}`; `whatsapp_click` → `Contact` without `ph`; stage `viewing` → `Schedule`; `won` → `Purchase` with `value`. `buildGa4Payload()` → `{client_id, events:[{name:'generate_lead', params:{session_id, engagement_time_msec:1, lead_source, currency:'SAR', value:0}}]}` with `session_id` only when the session is < 72 h old; stages map `qualified→qualify_lead`, `viewing|offer|negotiation→working_lead`, `won→close_convert_lead (value)`, `lost→close_unconvert_lead`. `buildSnapEvent()` → `{event_name:'SIGN_UP', action_source:'WEB', event_time, event_id, event_source_url, user_data:{ph, sc_click_id, sc_cookie1, client_ip_address, client_user_agent}, custom_data:{currency:'SAR', value:0, event_tag:'whatsapp_lead'}}`; `won` → `PURCHASE`.
- [ ] Commit `api: fan-out payload builders (Meta CAPI, GA4 MP, Snap CAPI)`.

### Task D2: senders + worker
- [ ] Tests (mock fetch): `sendMeta` posts to `https://graph.facebook.com/v21.0/<pixel>/events` with `{data:[…], test_event_code?}` and bearer via `access_token` query; `sendGa4` → `https://www.google-analytics.com/mp/collect?measurement_id=&api_secret=`; `sendSnap` → `https://tr.snapchat.com/v3/<pixel>/events` bearer header. Worker `tick()`: due rows only; dest without keys → `skipped:no_key`; consent missing → `skipped:no_consent` (Meta/Snap need `consent_ads`, GA4 `consent_analytics`); no session for a lead → `skipped:no_session`; HTTP 2xx → `sent` with response ≤ 500 chars; failure → attempts+1, `next_at` per C5, `failed` after 5. Idempotent: a `sent` row is never resent.
- [ ] Wire: `createFanout` in `index.mjs`, interval `cfg.fanoutMs`, `health().fanout = {pending, failed}`; `setStage()` callers (WS-E) enqueue `lead_stage` — provide `fanout.enqueueStage(lead, stage)` now so WS-E only calls it.
- [ ] Commit `api: fan-out worker — idempotent, consent-gated, backoff`.

---

## WS-E — Dashboard (branch `feat/track-dashboard`, from main after B merges; D's `enqueueStage` may be stubbed and reconciled at merge)

### Task E1: auth
- [ ] Tests: `requestCode(ip)` sends a 6-digit code to the owner jid via the injected `sendWhatsApp`, stores only `sha256(code)`, expiry 10 min; 4th request in 10 min from one IP → `{ok:false, error:'rate_limited'}`; `verify(wrong)` ×5 → code invalidated; `verify(right)` → `{ok:true, token}` (32 hex), `auth_sessions` stores the hash, `check(token)` true until expiry, `logout(token)` deletes. Global limiter 1 code/min.
- [ ] Implement `lib/dashboard/auth.mjs`; cookie helpers `setCookie(res, token, days)`, `readCookie(req)`; constant-time compare via `crypto.timingSafeEqual`.
- [ ] Commit `api: dashboard auth by WhatsApp one-time code`.

### Task E2: stats queries
- [ ] Seed a temp db with 3 sessions / 12 events / 4 leads / 2 spend rows in the test; assert `overviewDaily(days)`, `sources()` (first-touch vs last-touch counts differ when a lead's first and last touches differ), `matchQuality()`, `pipeline()` (median age hours), `responseTimes()` (from `first_inbound_ts`/`first_reply_ts`), `listingFunnel()` (views/gallery/tour/brochure/wa_clicks/leads per listing + licence flags read from the inventory file: `no_ad_licence`, `expiring_30d`, `expired`, `wafi_missing` for `category==='off-plan'`), `cplByCampaign()` (spend ÷ last-touch leads, `campaign_id` join, null when no leads).
- [ ] Commit `api: dashboard statistics`.

### Task E3: HTML pages + admin JSON
- [ ] `render.mjs`: one `layout({title, body, locale:'en'})` with a small embedded stylesheet (system font, ivory/ink palette like the site, RTL-safe with `dir="auto"` on Arabic cells), nav (Overview · Leads · Listings · Spend · Integrations · Logout), inline SVG bar/line helpers (`bars(series)`, `line(series)`), tables. Pages: `login` (phone-code form, error state), `overview`, `leads` (board columns per stage with cards: name/phone masked as `…6933`, source, listing, age, response; list below with filters), `leadDetail` (fields, journey timeline, stage `<select>` + value + note form posting to `/v1/admin/leads/:id/stage`), `listings`, `spend` (form + table), `integrations` (env presence booleans, poller/fanout status, last accepted per dest, checklist links).
- [ ] `routes.mjs`: `GET /dashboard`, `/dashboard/login`, `POST /dashboard/login/code`, `POST /dashboard/login/verify` (form-encoded), `/dashboard/logout`, `/dashboard/leads`, `/dashboard/leads/:id`, `/dashboard/listings`, `/dashboard/spend`, `/dashboard/integrations`; admin JSON per C7; every non-login route requires a valid cookie (else 302 to login); POSTs require `X-Bona-Dash: 1` (fetch from the page's inline script) or, for the HTML forms, a hidden `_dash=1` field + same-origin `Origin`/`Referer` check; responses carry `Cache-Control: no-store`, `Content-Security-Policy: default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:`, `X-Frame-Options: DENY`. Stage change → `db.setStage` + `fanout.enqueueStage`.
- [ ] Tests in `test/routes-dashboard.test.mjs` through the real `http` server (like `http.test.mjs`): unauthenticated `/dashboard` → 302; login flow end-to-end with a mocked `sendWhatsApp`; `/v1/admin/stats` JSON shape; stage POST without header → 403; with → 200 and history row.
- [ ] Wire in `index.mjs` before the browser routes (`/dashboard` and `/v1/admin` prefixes). Commit `api: private dashboard — overview, pipeline, listings, spend, integrations`.

---

## 3. Orchestrator procedure (this session)

1. Launch **B**, **A**, **F** now (three agents, worktrees). F's Task F7 waits.
2. When **B** reports green: run Claude review + `codex exec` review on the branch diff; fix; merge into `main` locally in a clean worktree (`~/bona-wt/merge`, `git merge --no-ff`), run the full API test suite, push. Then launch **C**, **D**, **E** from the new main.
3. A and F: review (Claude + Codex), rebase on main, `npm run build`, merge, push (site deploys automatically — the banner and Ref rewrite go live before the API changes are deployed; events will 404 harmlessly until step 5).
4. C, D, E: review, rebase, merge in that order; full suite; push. Then F7.
5. Deploy services: `git -C ~/bona pull --ff-only` (if refused because of the third session's WIP, run bona-api from `~/bona-bot` after `git -C ~/bona-bot pull` and point `bona-api.service` there — decide with the owner), `bash ~/bona/services/deploy/install.sh --restart`, `node ~/bona/services/api/retell/provision.mjs`, `curl https://bona-api.azoz.uk/health` → `db:'ok'`, `poller.lastRun` recent.
6. Live verification: real page view on bona.azoz.uk → row in `events`; WhatsApp message with a Ref from the owner's second number → lead + owner note; `/dashboard` login round-trip from the phone; `verify-integrations.mjs` (all pending until the owner pastes keys).
7. Memory + runbook update; hand the owner the checklist links.

## 4. Self-review notes (done while writing)
- Spec §3.1 events ↔ C1 allowlist: identical. §4.4 table ↔ D1 builders: identical after removing GA4 from `whatsapp_click`. §4.5 login ↔ E1. §5 ops ↔ F1–F6. §3.5 REGA ↔ A7 + F7. §4.3 poller rules ↔ C2 fixtures (a)–(j). No "TBD"; the only intentionally deferred items are those the spec lists as out of scope.
- Naming: `createOrMergeLead`, `parseRef`, `sourceFromTouch`, `validateEvent`, `recordEvent`, `createPoller`, `createFanout`, `enqueueStage`, `createAuth`, `openDb` are the cross-task names; agents must keep them.
