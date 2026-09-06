# Bona — client acquisition & tracking stack (design, 2026-09-06)

Owner decisions (2026-09-06, all confirmed): advertise now under the owner's personal FAL (Abdulaziz Zidan / عبدالعزيز زيدان, FAL 1100313556) while the Bona CR is pursued; keep the personal WhatsApp number on Evolution (ads land on the site, attribution via Ref codes); new "Bona" Meta Business Portfolio; own lead store + dashboard on bona-api (no SaaS CRM); GA4 + Meta Pixel + first-party store with server fan-out, behind an AR/EN consent banner; channels: Instagram/Facebook, Snapchat, Google Search + Business Profile, Aqar; register **bona.sa** now and make it canonical; Google assets under bona.com.sa@gmail.com; WhatsApp poller reads **matched messages only**; dashboard login by **WhatsApp one-time code**.

Research behind this: `docs/research/2026-09-06-*.md` (gap report, code audit, TK reuse audit, Saudi compliance/channels, attribution mechanics).

## 1. Goal

Know, for every client, **where they came from** (source / medium / campaign / click id / referrer / landing page, first and last touch) and **where they went** (pages, listing, gallery, tour, brochure, CTA, chat, call, WhatsApp conversation, pipeline stage), in one private dashboard, with the same signals sent back to Meta, Google and Snapchat so ads can optimise. Everything is config-driven: each integration switches on when its key lands in the secrets file.

Out of scope today: running campaigns, Meta Lead Ads retrieval, TikTok, Cloud API WhatsApp number, Chatwoot. The schema leaves room for all of them.

## 2. Architecture

```
ads / IG organic / search / referrals  →  site (Astro static, GitHub Pages)
   attribution.js (inline, <head>): UTMs + click ids + referrer + landing → first/last touch (90 d)
   → session {id, ref} → POST text/plain keepalive → bona-api /v1/events
   → every wa.me link rewritten at click: "...\nRef BONA-W003 · K7Q2XR"
   → EnquiryForm: same Ref line + POST /v1/enquiry (lead exists even if WhatsApp never opens)
   → Concierge: session bundle ids → Retell metadata → create_lead attaches source server-side
WhatsApp (personal number, Evolution 2.3.7 / Baileys) ← visitor sends the prefilled text
   → bona-api wa-poller (read-only findMessages, every 45 s, matched messages only) → lead
bona-api  SQLite (node:sqlite, ~/bona-data/bona.db): sessions, events, leads, touchpoints, stages, ad_spend, fanout, auth
   → fan-out worker: Meta CAPI · GA4 Measurement Protocol · Snap CAPI (idempotent per event_id, consent-gated)
   → owner WhatsApp note (exists) now with a source line
   → /dashboard (server-rendered, WhatsApp OTP login) + /v1/admin/* JSON
```

Constraints honoured: GitHub Pages sets no headers (CSP via `<meta>`); bona-api stays **dependency-free** (Node 24 → built-in `node:sqlite`); Evolution is polled read-only, **never** given a webhook (Lisa depends on that); Bona copy never mentions TK; prices never invented.

## 3. Site (workstream A)

### 3.1 Attribution script — `src/scripts/attribution.js`, injected `is:inline` in `Head.astro`
- Binds once (`window.__bonaAttr` guard); page views fire on `astro:page-load` (initial + view transitions).
- Reads `utm_source/medium/campaign/content/term/id`, click ids `fbclid gclid gbraid wbraid gad_source gad_campaignid ttclid ScCid msclkid li_fat_id twclid dclid`, `document.referrer`, landing path+query. Derives source/medium when UTMs are absent (fbclid→meta/paid, gclid→google/cpc, ScCid→snapchat/paid, ttclid→tiktok/paid, referrer host→`social_or_organic`|`referral`, else `(direct)/(none)`).
- Store `bona_attr` v1: `{anon_id (32 hex), created, first, last, session{id, ref, start, last_seen, pages}, fbp, fbc, ga{client_id, session_id}, scid, ttp}`. First touch is never overwritten; last touch updates on any external arrival (UTM, click id, or external referrer). Session = 30 min inactivity; **ref = 6 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`** minted per session.
- `fbc` synthesised as `fb.1.<ms>.<fbclid>` when the pixel is absent; `fbp` from `_fbp` cookie or synthesised; GA ids parsed from `_ga` / `_ga_<ID>` cookies when present.
- **Consent-aware storage:** consent `analytics` or `ads` granted → `localStorage` (90 d) + cookie `bona_id`; declined or undecided → `sessionStorage` only (dies with the tab). Ref codes work either way.
- Events posted as `text/plain` JSON (no preflight, `keepalive`) to `${apiBase}/v1/events`. Payload:
  ```json
  {"v":1,"event_id":"<ts36>-<8hex>","ts":1757150000000,"event":"whatsapp_click","anon_id":"…","session_id":"…","ref":"K7Q2XR",
   "page":"/properties/bona-w003/","locale":"en","listing_id":"BONA-W003","props":{"cta":"listing_whatsapp","href":"…"},
   "attr":{"first":{…},"last":{…},"fbp":"…","fbc":"…","ga":{"client_id":"…","session_id":"…"},"scid":null,"ttp":null},
   "consent":{"analytics":true,"ads":true}}
  ```
- Event taxonomy (allowlist, shared with the API in `services/api/lib/events.mjs` and mirrored in `src/scripts/attribution.js`): `page_view, listing_view, gallery_open, tour_open, video_play, brochure_download, whatsapp_click, call_click, form_submit, consent_update, concierge_open` (browser); `concierge_chat_start, concierge_call_start, lead_created, lead_stage` (server).
- Delegated click listener (capture phase): `a[href*="wa.me"], a[href*="api.whatsapp.com"]` → rewrite `text` to end with `Ref <listing|BONA> · <ref>` (unless already present) + `whatsapp_click`; `a[href^="tel:"]` → `call_click`; `[data-track]` → that event. Listing pages set `<body data-listing="BONA-W003">`; CTAs carry `data-cta` (`listing_whatsapp, header_whatsapp, drawer_whatsapp, footer_whatsapp, float_whatsapp, hero_enquiry, contact_band, offmarket_land, concierge_fallback, tel_*`).
- `window.bonaTrack(event, props)` for components (gallery open, video play, concierge open).
- Tag mirroring when loaded: `whatsapp_click` → `fbq('track','Contact',{content_ids:[listing],content_type:'product'},{eventID})`, `gtag('event','whatsapp_click',{listing_id})`; `listing_view` → `fbq ViewContent`, `snaptr VIEW_CONTENT`; `form_submit` → `fbq Lead` with the same `event_id` as the server enquiry. Same `event_id` on client and server = dedupe.

### 3.2 Consent banner — `src/components/Consent.astro`
- AR/EN, bottom sheet, two buttons: **Accept all** / **Essential only**, link to `/privacy/#cookies`; `bona_consent` = `{v:1, analytics, ads, ts}`; footer link "Cookie settings" reopens it. Fires `consent_update`.
- Third-party tags load **only after** consent: `src/scripts/tags.js` reads `window.BONA_TAGS = {ga4, metaPixel, snapPixel}` (inline from `site.json.analytics`) and injects gtag (Consent Mode v2: default all denied, then `update` granted), Meta Pixel (`init` + `PageView`, with `fbq('consent','grant')`), Snap Pixel (`init` + `PAGE_VIEW`). Page views re-fire per view transition. Without consent nothing from Google/Meta/Snap is requested.
- `site.json.analytics` becomes `{ga4, metaPixel, snapPixel, gscVerification}`; `gscVerification` renders `<meta name="google-site-verification">`.
- `<meta http-equiv="Content-Security-Policy">` allowing self, the API origin (`connect-src`), Google/Meta/Snap tag hosts, Matterport, tk-storage media, Retell/LiveKit for calls (copy the current implicit needs; verified with the live widget before merge).

### 3.3 Enquiry form
- Adds the Ref line; POSTs JSON to `/v1/enquiry` (`{form, name, phone, interest, type, budget, location, message, listing_id, page, locale, event_id, attr, consent}`) **before** opening WhatsApp; failure is silent (WhatsApp still opens).

### 3.4 Concierge
- `client.ts` / `call.ts` send `attr: {anon_id, session_id, ref, listing_id}` with `/v1/chat/session` and `/v1/call/token`. Chat panel gets a one-line notice "Conversations are stored to serve your enquiry · Privacy".

### 3.5 REGA advertising block on listing pages
- `site.json.advertiser = {name:{en:"Abdulaziz Zidan",ar:"عبدالعزيز زيدان"}, fal:"1100313556"}`.
- Listing schema (optional, validator checks shape only): `licence: {adNumber, adExpiry (YYYY-MM-DD), wafiNumber, escrowAccount} | null`. Curated (TK-synced) listings get overrides from `scripts/curate/licences.json` keyed by id, merged in `build.mjs`.
- `ListingPage.astro` renders under the enquiry block: advertiser name + FAL; when `adNumber`: "Advertising licence <no> · valid until <date>"; when `wafiNumber`: "Wafi project licence <no>"; plus a build-time SVG QR (`scripts/qr.mjs`, no dependency, or a vendored tiny encoder) of the listing URL. Without any licence: block shows advertiser + FAL only; the dashboard flags it.
- `services/intake`: commands `licence BONA-W003 <adNumber> <YYYY-MM-DD>` and `wafi BONA-W003 <number>` update the inbox JSON and commit (same pattern as `price`).

### 3.6 Static `/dashboard/`
- Remove the localStorage Leads section and lead KPIs; keep Integrations/Launch checklist; add a card linking to the private dashboard. Still `noindex`.

### 3.7 Privacy notice (`src/data/privacy.json`)
- New/updated sections: cookies & consent (categories, how to change), recipients (Google, Meta, Snap, Retell, WhatsApp/Meta, Cloudflare, GitHub), transfers outside KSA under contractual safeguards, retention (events 13 months; leads while the enquiry is live, then 3 years), call recording & AI disclosure, rights/contact. Arabic authoritative.

## 4. bona-api (workstreams B–E)

### 4.1 Store — `lib/db.mjs` (node:sqlite `DatabaseSync`, WAL, `${BONA_DATA}/bona.db`, mode 0600)
```sql
sessions(session_id TEXT PK, anon_id, ref TEXT UNIQUE, started INT, last_seen INT, pages INT, locale,
  first_touch JSON, last_touch JSON, fbp, fbc, ga_client_id, ga_session_id, scid, ttp, ip, ua, country,
  consent_analytics INT, consent_ads INT)
events(event_id TEXT PK, ts INT, name, anon_id, session_id, lead_id, listing_id, path, props JSON,
  src_first JSON, src_last JSON, ip, ua, country)            -- idx: ts, (listing_id,name), anon_id, session_id
leads(lead_id TEXT PK, created INT, updated INT, phone_e164 TEXT UNIQUE, wa_jid, wa_lid, name, channel, source, medium,
  campaign, campaign_id, content, click_ids JSON, ref, match_method, session_id, anon_id, listing_id,
  first_touch JSON, last_touch JSON, interest, budget, timeline, district, language, notes,
  stage, stage_ts INT, value_sar REAL, first_inbound_ts INT, first_reply_ts INT, legacy_id, consent_ads INT, consent_analytics INT)
touchpoints(id TEXT PK, lead_id, ts INT, channel, event_type, source, medium, campaign, campaign_id, listing_id, meta JSON)
lead_stage_history(id TEXT PK, lead_id, stage, ts INT, actor, note)
wa_cursor(instance TEXT PK, last_ts INT, last_run INT, unmatched INT)    wa_seen(key_id TEXT PK, ts INT)
ad_spend(day TEXT, platform, campaign_id, campaign_name, spend_sar REAL, clicks INT, impressions INT, PK(day,platform,campaign_id))
fanout(event_id TEXT, dest TEXT, status, attempts INT, next_at INT, last_error, response, ts INT, PK(event_id,dest))
auth_codes(code_hash TEXT PK, created INT, expires INT, used INT, attempts INT)
auth_sessions(token_hash TEXT PK, created INT, expires INT, ua)
```
- Stages: `new, contacted, qualified, viewing, offer, negotiation, won, lost`.
- `channel`: `whatsapp | form | concierge_chat | concierge_voice | manual`. `source/medium/campaign` come from the session's **last touch** at lead creation; first touch kept alongside. `match_method`: `ref | phone | keyword | time_window | concierge | form | ad_meta`.
- Phone normaliser `lib/phone.mjs`: Arabic-Indic digits → Western; `+966…`/`00966…`/`05…`/`5…` → `9665xxxxxxxx`; other countries digits only; invalid → null (lead still allowed with jid).
- Existing JSONL stays as the append-only raw log; on startup `leads.jsonl`/`chats.jsonl`/`calls.jsonl` are imported once (`legacy_id`), idempotent.

### 4.2 Routes
| Route | Auth / limits | Behaviour |
|---|---|---|
| `POST /v1/events` (text/plain or JSON — exempt from the JSON-only 415 gate and from the Retell budget) | origin allowlist if stated; 240/min per IP; body ≤ 8 KB | validate allowlisted event + shapes; upsert session (first touch wins, last touch/consent update); insert event with server `{ip, ua, country (CF-IPCountry), received}`; `204` |
| `POST /v1/enquiry` (JSON) | origin allowlist; 6/min per IP | validate name ≥ 2, phone regex; create/merge lead (`channel:'form'`, `match_method:'form'`); touchpoint; owner note; `{lead_id}` |
| `POST /v1/chat/session`, `/v1/call/token` | existing | accept `attr`; Retell `metadata` gains `anon_id, session_id, ref, listing_id`; server records `concierge_chat_start` / `concierge_call_start` |
| `POST /v1/tools/create_lead` | existing token | `ctx.attr` from `body.call.metadata ?? body.chat.metadata`; lead gets session source; `match_method:'concierge'` |
| `POST /v1/retell/webhook` | existing | unchanged + link call/chat ids to lead when present |
| `GET /dashboard/*`, `POST /dashboard/login/*` | see 4.5 | HTML |
| `GET /v1/admin/stats`, `GET /v1/admin/leads`, `GET /v1/admin/leads/:id`, `POST /v1/admin/leads/:id/stage`, `POST /v1/admin/leads/:id/note`, `POST /v1/admin/spend` | dashboard cookie + `X-Bona-Dash: 1` + origin check | JSON |
| `GET /health` | existing | adds `db: ok`, `poller: {lastRun, lag}`, `fanout: {pending, failed}` |

### 4.3 WhatsApp poller — `lib/wa-poller.mjs` (in-process loop, `BONA_WA_POLL=1`, `BONA_WA_POLL_MS=45000`)
- `POST /chat/findMessages/{instance}` `{where:{messageTimestamp:{gte:<cursor−120 s>, lte:<now>}}, page, offset:100}`, up to 5 pages; dedupe by `key.id` (`wa_seen`, pruned after 7 days). Evolution quirks: `fromMe` filter ignored → filter client-side; both `gte` and `lte` required; text = `message.conversation ?? extendedTextMessage.text ?? imageMessage.caption`.
- Candidates: `!key.fromMe`, jid not `@g.us` / `status@broadcast`; phone from `key.remoteJidAlt ?? key.remoteJid` (store both when `@lid`).
- **Matched-only policy** (owner decision): a message is kept only if one of: (1) Ref line `/\bRef\s+(BONA(?:-W?\d{3})?)?\s*[·\-:|]?\s*([A-HJ-NP-Z2-9]{5,6})\b/i`; (2) sender already a lead; (3) mentions `Bona|بونا` or a listing id `BONA-W?\d{3}`; (4) `contextInfo.externalAdReply` / `conversionSource` / `entryPointConversionSource` / `utm` present (`match_method:'ad_meta'`, meta stored); (5) a `whatsapp_click` event within ±15 min whose session has no lead yet and the sender is unknown (`match_method:'time_window'`, closest click, marked inferred). Anything else is **discarded in memory** (counter only).
- On match: create lead (or attach touchpoint `inbound_message` to the existing one); store first inbound snippet (≤ 200 chars) only for new leads; `first_inbound_ts`; `fromMe` messages to that jid set `first_reply_ts` (response time). Owner note via existing `sendText` with a source line, e.g. `Source: instagram / paid · villas_sep · Ref K7Q2XR · BONA-W003`.
- Failure isolation: every tick in try/catch; Evolution outage → `health.poller.lag` grows, nothing else affected.

### 4.4 Fan-out — `lib/fanout/{index,meta,ga4,snap}.mjs` (worker every 20 s; per-destination modules with injectable `fetch`)
| Trigger | Meta CAPI | GA4 MP | Snap CAPI |
|---|---|---|---|
| `whatsapp_click` | `Contact` (website) | — (browser gtag sends it; MP has no dedupe) | — |
| `form_submit`/enquiry | `Lead` | `generate_lead` | `SIGN_UP` |
| `lead_created` (WhatsApp/concierge) | `Lead` | `generate_lead` | `SIGN_UP` |
| stage `qualified` | — | `qualify_lead` | — |
| stage `viewing` | `Schedule` | `working_lead` | — |
| stage `won` / `lost` | `Purchase` (value) / — | `close_convert_lead` / `close_unconvert_lead` | `PURCHASE` / — |
- Meta: `action_source:'website'`, `event_source_url`, `client_user_agent`+`client_ip_address` from the click/session, `fbc/fbp`, `ph` = sha256(`9665…`), `external_id` = sha256(anon_id), `event_id` = client id, `test_event_code` from env. GA4: `client_id` + `session_id` + `engagement_time_msec:1` when the session is < 72 h old, else user-level. Snap v3: `sc_click_id`, `sc_cookie1`, hashed `ph`.
- **Consent gate:** Meta/Snap only when the lead's session had `consent_ads`; GA4 only with `consent_analytics`; leads without a session (keyword/ad_meta) → no ad-platform fan-out. Retries ≤ 5 with backoff 1 m → 6 h; `fanout` rows `pending|sent|failed|skipped` with truncated responses. Env: `META_PIXEL_ID, META_CAPI_TOKEN, META_TEST_EVENT_CODE, GA4_MEASUREMENT_ID, GA4_API_SECRET, SNAP_PIXEL_ID, SNAP_CAPI_TOKEN` in `~/.secrets/bona-marketing.env` (loaded by `lib/env.mjs` alongside the existing file).

### 4.5 Dashboard — `lib/dashboard/*` (server-rendered HTML + small CSS; charts as inline SVG rendered server-side, no CDN dependency; CSP header set by bona-api)
- **Login:** `GET /dashboard/login` → `POST /dashboard/login/code` (3 per 10 min per IP, 1 per minute globally) generates a 6-digit code, stores sha256 + 10-min expiry, sends "Bona dashboard code: 123456 (valid 10 min)" to the owner JID via `sendText`; `POST /dashboard/login/verify` (5 attempts per code) → cookie `bona_dash` (HttpOnly, Secure, SameSite=Lax, 30 d, token hashed in `auth_sessions`); `/dashboard/logout`.
- Pages: **Overview** (14-day strip: sessions, WA clicks, leads, viewings; sources → leads with first-touch and last-touch columns side by side; match-quality split ref/phone/keyword/time_window/concierge/form; CPL per campaign when spend exists), **Leads** (pipeline board by stage with age and response time; list filters; detail page = journey timeline of events + touchpoints + stage history + notes, stage change form, value), **Listings** (per-listing funnel views → gallery/tour/brochure → WA clicks → leads; compliance flags: no ad licence / expiring ≤ 30 d / Wafi missing on off-plan), **Spend** (manual entry per day/platform/campaign + CSV import), **Integrations** (which keys are present, Evolution reachable, Retell ok, poller last run, fan-out failures, GA4/Meta/Snap last accepted event, links to owner checklists).
- Locale: EN UI with Arabic names/text shown as stored; RTL-safe.

### 4.6 Retell / Dana
- `retell/prompt.md` + provision: voice `begin_message` announces "…Dana, Bona's AI concierge. This call is recorded to handle your enquiry." (AR equivalent); chat greeting keeps the AI disclosure. Provision re-run (`node services/api/retell/provision.mjs`) after merge.

## 5. Ops, accounts, domain (workstream F)

- `docs/OWNER-RUNBOOK.md` rewritten sections + `docs/checklists/`: **meta-bona-portfolio.md** (portfolio "Bona", Page "Bona Real Estate", link IG @bona.com.sa, dataset/pixel, ad account SAR + payment, system user + token scopes `ads_management ads_read business_management pages_show_list pages_read_engagement instagram_basic instagram_content_publish leads_retrieval`, domain verification for bona.sa/bona.azoz.uk, where to paste ids), **google-bona.md** (finish bona.com.sa@gmail.com verification; GA4 property + web stream + MP api secret; Search Console URL-prefix property via the meta tag we render; Google Business Profile "Real estate agent", video verification, hidden address; Google Ads account + advertiser verification later), **snapchat-bona.md** (Snap Ads account, pixel, CAPI token), **aqar.md** (plan, ad-licence requirement, export usage), **rega-ad-licences.md** (FAL platform flow per listing, Wafi numbers for off-plan, `licence`/`wafi` commands), **pdpl.md** (NDGP registration, transfer risk assessment one-pager at `docs/compliance/pdpl-transfer-risk-assessment.md`).
- `~/.secrets/bona-marketing.env.example` committed under `services/deploy/`; `install.sh` loads it into the units; `BONA_WA_POLL=1` added.
- `scripts/marketing/verify-integrations.mjs`: probes GA4 MP debug endpoint, Meta CAPI test event, Snap validate, Search Console meta presence, updates `src/data/integrations.json` statuses.
- `scripts/portal-export.mjs`: per-listing Aqar text (AR/EN, price, specs, licence line) with tracked URL `?utm_source=aqar&utm_medium=portal&utm_campaign=listing&utm_content=<id>`; written to `dist/portal/aqar/`.
- `scripts/domain-cutover.mjs --domain bona.sa --api api.bona.sa [--dry-run]`: updates `site.json` (url, futureDomain, concierge.apiBase), `public/CNAME`, CORS origins env, tunnel ingress + `tunnel route dns`, Cloudflare DNS (apex A/AAAA to GitHub Pages, `www` CNAME), GitHub Pages custom domain + https enforcement, re-provisions Retell tool URLs, prints the remaining owner steps (redirect rule bona.azoz.uk → bona.sa, GSC/GA4 stream URL). Runs only after the owner has registered bona.sa and added the zone to Cloudflare.
- `src/data/integrations.json` gains rows: ga4, meta-pixel, meta-capi, snap, gsc, gbp, aqar, bona-sa, rega-licences, pdpl-ndgp.

## 6. Data flow examples
1. Instagram ad → `bona.azoz.uk/properties/x/?utm_source=meta&utm_medium=paid&utm_campaign=villas_sep&utm_id=1203&fbclid=…` → first touch stored, `listing_view` → visitor taps "Enquire on WhatsApp" → `whatsapp_click` (Meta `Contact` via CAPI, `fbq Contact` in browser, same event_id) → WhatsApp opens with "…Ref BONA-W003 · K7Q2XR" → poller matches ref → lead (source meta/paid/villas_sep, listing BONA-W003, match ref) → Meta `Lead`, GA4 `generate_lead`, Snap skipped (no ScCid, but SIGN_UP still sent if consent_ads and pixel configured), owner note with source → dashboard shows it under Sources and in the pipeline.
2. Google search → site → Dana chat → `create_lead` → metadata carries session → lead source google/organic, match concierge.
3. Friend forwards a listing link (no UTM) → `(direct)` first touch → visitor deletes the Ref line → poller time-window match (inferred) → dashboard match-quality shows it as inferred.

## 7. Error handling & privacy
- Site script never throws to the page; all network calls are fire-and-forget with try/catch. API validation rejects unknown events, oversize bodies, foreign origins. Poller and fan-out isolate failures per tick/row; `health` exposes lag and failures; Uptime Kuma already watches `/health`.
- Raw phone numbers, names and message snippets stay in `~/bona-data/bona.db` (0600) on this PC; only hashed identifiers go to Meta/Snap; GA4 receives no PII. Unmatched WhatsApp messages are never written anywhere. Consent declined → no third-party tags, no ad fan-out, session-scoped id.

## 8. Testing
- `node --test services/api/test/*.test.mjs`: db migrations + import idempotency; events validation/upsert; enquiry; phone normaliser; poller (fixtures for Ref / keyword / ad_meta / time_window / discard, Evolution quirks, `@lid`); fan-out payload builders + consent gate + retry state (mock fetch); dashboard auth (code lifecycle, rate limits, cookie) + stats queries on seeded data.
- Site: `npm run build` + existing checks; a Playwright/CDP smoke on the preview: consent banner, Ref rewrite on a listing CTA, `whatsapp_click` reaching a local bona-api, enquiry form POST.
- Reviews: Claude + Codex on every workstream before merge (owner rule). Live verification after deploy: real page view → event row; real WhatsApp message with Ref → lead + owner note; dashboard login round-trip.

## 9. Workstreams, order, ownership
| WS | Branch | Scope | Depends on |
|---|---|---|---|
| B | `feat/track-store` | db, events, enquiry, lead model, Retell metadata, JSONL import, owner note | — (lands first) |
| A | `feat/track-site` | attribution.js, consent, tags, CTAs/data attrs, EnquiryForm, concierge attr, REGA block + schema, privacy, static dashboard | contract in §3–4 |
| F | `feat/track-ops` | checklists, runbook, env example, install.sh, verify-integrations, portal export, domain cutover, integrations.json, intake `licence`/`wafi` commands, Retell prompt | — |
| C | `feat/track-poller` | wa-poller | B |
| D | `feat/track-fanout` | Meta/GA4/Snap fan-out | B |
| E | `feat/track-dashboard` | auth + pages + admin JSON | B |
Merge order: B → A → F → C → D → E. Deploy: push `main` (site), `bash services/deploy/install.sh --restart` (services), `node services/api/retell/provision.mjs` (Dana), then live verification.
