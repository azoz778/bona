# TK Estates audit — what Bona can reuse for client tracking (2026-09-06)

Produced by an Explore agent over `~/tk`. Read-only.

**Stack correction:** TK is Node 20 + Express 5 (CommonJS), PM2 on Hostinger, self-hosted Supabase over PostgREST (`src/memory.js: supabaseQuery`), served at `dashboard.azoz.uk`. No `.codegraph`, no ORM; schema = idempotent `.sql` migrations. Green API for WhatsApp.

## 1. Lead / client data model

- Attribution columns on `leads` — `scripts/migrate-meta-attribution.sql:11-32`: `utm_source/medium/campaign/content/term`, `fbclid`, `gclid`, `meta_lead_id` (UNIQUE), `meta_ad_id`, `meta_adset_id`, `meta_campaign_id`, `meta_form_id`, `first_touch_at/source/campaign_id`, `last_touch_at/source/campaign_id`, `qualification_status`, `disqualification_reason`, `engagement_tier`, `lifecycle_value`. No `ctwa_clid` column on leads — only inside `lead_touchpoints.meta` JSONB (`src/ctwa.js:232`).
- CRM columns (`src/db.js:74-113`): `name, interest, budget, timeline, location, status (hot/warm/cold), score, source, email, agent, stage, notes, last_follow_up, next_follow_up, assigned_to, assigned_at, sla_warned_at, sla_escalated_at`.
- **`lead_touchpoints`** (`scripts/migrate-meta-attribution.sql:53-77`) is the spine: `lead_phone, channel, event_type, campaign_id, ad_id, creative_id, form_id, utm_*, fbclid, gclid, cost_attributed, occurred_at, meta jsonb` + `resolved_property_id`, `resolution_source` (`scripts/migrate-ctwa-property-resolution.sql:97-102`).
- Pipeline stages (`public/js/pipeline-board.js:77`): New, Contacted, Qualified, Viewing Scheduled, Offer, Negotiation, Signed, Lost (AR labels `:70-72`).
- Channel vocabulary (`src/touchpoints.js:25-26`): `meta_lead_ad | facebook_dm | instagram_dm | whatsapp | widget | property_page | pixel | voice | ctwa | email | referral`; rolled up at `src/cac.js:48-59`.
- **No brand/tenant column anywhere.** Single-tenant.

## 2. CTWA Phase 1 (`src/ctwa.js`, 242 lines; called from `src/webhook.js:1143-1145`)

- `extractReferral()` (`:47`) scans: (a) `externalAdReply` under 12 Green-API wrappers (`:33-46`, `:56-64`); (b) flat Green-API envelope `extendedTextMessageData.{sourceType,sourceId,conversionSource,showAdAttribution,title}` (`:83-96`, `attributionOnly:true`, gated from auto property card `webhook.js:1156-1162`); (c) `messageData.referral`; (d) Cloud API `referral` (`:111`, never exercised).
- `detectAndRecordCTWA()`: resolves `ad_id → campaign_id` via `ad_creatives` (`:145-152`), parses property codes from ad prefill via `src/ad-property-code.js:21` (regex `/([A-Z]{2,5})-?(\d{2,5})/gi`), validates against `properties.id`, self-learns ad→property with corroboration guard (`:186-206`), writes `channel:'ctwa', eventType:'ctwa_click', source:'meta_ctwa'`, `ctwa_clid` in `meta` (`:225-240`).
- Second path `src/webhook.js:2058-2072` sets source from `entryPointConversionApp`.
- `migrate-ctwa-property-resolution.sql:1-16`: `properties.name_aliases` + trigram `title_norm` with Arabic-folding trigger (`:41-70`), `ad_creatives.property_id`, resolution cache, `bot_intent_unresolved` (`:112-126`), `search_properties_by_name()` RPC (`:134-152`).
- Green-API-specific ≈ 60% of `extractReferral`; everything downstream is provider-agnostic. Evolution emits raw Baileys `message.extendedTextMessage.contextInfo.externalAdReply` → new extractor branch, keep `detectAndRecordCTWA` body.

## 3. Meta integration

- Pixel + CAPI: `src/pixel.js` — SHA-256 (`:29`), `fb.1.<ts>.<fbclid>` fbc synthesis (`:35`), persists to `meta_pixel_events` (`migrate-meta-attribution.sql:145-160`), relays to Graph v21.0, bumps `leads.score` per `config/pixel-scoring.json`. Gated on `META_PIXEL_ID` + `META_PIXEL_ACCESS_TOKEN` (`:28`).
- Lead Ads: polling `src/meta-leads.js:5-11` with cursors in `meta_sync_state`; webhook `src/meta-webhook.js` HMAC (`:26-35`).
- Graph API at 17 call sites (`src/meta.js`, `creatives.js`, `ad-fatigue.js`, `meta-breakdowns.js`, `audiences.js`, `ig-insights.js`, `ig-comment-miner.js`, `meta-inbox.js`, `wa-templates.js`).
- Env names: `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_APP_ID`, `META_APP_SECRET`, `META_PIXEL_ID`, `META_PIXEL_ACCESS_TOKEN`, `META_VERIFY_TOKEN`, `META_PAGE_ID`, `META_INSTAGRAM_ACCOUNT_ID`, `META_WHATSAPP_PHONE_NUMBER_ID`, `META_WHATSAPP_BUSINESS_ACCOUNT_ID`. Runbook `docs/meta-setup.md:19-36` (scopes `ads_management, ads_read, business_management, pages_show_list, pages_read_engagement, leads_retrieval`).
- No Meta MCP; Instagram read/DM only, no publishing.

## 4. Google — zero. No GA4/GTM/Search Console/GBP code. Only `src/google-ads.js` conversions, Calendar, Sheets.

## 5. Dashboard analytics views

- `GET /api/funnel`, `/api/funnel/:propertyId` (`src/dashboard.js:3044,3052`) via `src/funnel.js:4-20` — visitors → messages → viewings → contracts, `cac_snapshots` `dimension='property_funnel'`.
- `GET /api/attribution` (`:4731`) — 5 models (`src/attribution.js:8-13`: first_touch, last_touch, linear, position, time_decay; half-life 7d).
- `GET /api/cac?dimension=` (`:4701`) — `src/cac.js:11-19` dimensions campaign|channel|property_type|district|price_tier|agent|creative.
- `/api/marketing/*` = expense bookkeeping only (`:4838-4936`), `public/marketing.html`.
- Richest UI `public/cac.html`.
- Best clone target: `src/journey.js:4-8` (merges touchpoints + activity + calls + viewings + contracts chronologically).

## 6. Public API + inquiry — can Bona POST leads?

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /api/public/properties` | none | `src/public-properties.js` allow-list (`:16-53`) |
| `POST /api/public/inquiry` | none, 10/10min per IP | `src/public-listings.js:103`, `source:'app'` |
| `POST /api/v1/leads` | `x-api-key` scope `write:leads` | `src/public-api.js:743`; fires `lead.created` webhook |

**No CORS anywhere** (`src/chat-widget-api.js:33-36` TODO). No brand column; `leads.phone` unique (`scripts/migrate-leads-phone-unique.sql`) so a shared contact collides; `channelForLead()` buckets `'bona'` into `'other'`. **→ Bona gets its own DB; do not co-tenant.**

## 7. WhatsApp inbound → lead

`src/webhook.js` (Green API poll + webhook `:304-306`). Dedupe by phone via PostgREST `on_conflict=phone` merge (`src/db.js:113` preserves agent fields; `:74-81` guards). Owner alerts via `cfg.alertPhone`/`ADMIN_PHONE`/`OWNER_AZIZ` (`:2278,2292,1097,2593-2600`). Auto-assign `src/assigner.js`.
Reference-code parsers: (1) `TK-<6>` share codes `src/share-links.js:39` → `webhook.js:1616-1617`, `source:'shared_link_inbound'` (`:1686`); (2) `[src:<slug>]` from `/track` (`dashboard.js:417-429`) parsed `webhook.js:2084-2088`; (3) property codes via `ad-property-code.js:21`.

## 8. UTM / short-link / QR

`src/share-links.js` — `buildShareLink({agentId, propertyId, utmCampaign, utmContent})` → 6-char base36 → `wa.me/<num>?text=…TK-abc123`, table `share_links` (`:15-30`), click-counted, writes touchpoint; admin routes `dashboard.js:2948-2985`. `/track?s=` (`dashboard.js:417`). `/l/:slug` landing pages, `/r/:token`, `/s/:token`, `/p/:id`. No marketing QR (qrcode only for 2FA).

## Reuse table

| TK capability | Verdict | Why |
|---|---|---|
| `lead_touchpoints` + `recordTouchpoint()` (`src/touchpoints.js`) | Copy | Provider-agnostic, ~150 lines. Highest-value copy. |
| `middleware/capture-attribution.js` | Copy | UTM/click-id capture, first-touch-preserving merge, `writeLeadAttribution()`. Add ttclid/ScCid. |
| `ctwa.js` body | Copy, rewrite extractor | Swap Green-API wrapper scan for Baileys `externalAdReply`. |
| `ad-property-code.js` | Copy | 40 lines, dependency-free. |
| `migrate-ctwa-property-resolution.sql` (partial) | Copy | Arabic-folding `title_norm` + trigram + RPC. |
| `attribution.js` (5 models) | Copy | Pure function over touchpoints. |
| `share-links.js` | Copy | Prefix `BN-`, Bona number. |
| `pixel.js` (CAPI relay) | Copy | Needs Bona pixel/token. |
| `public-properties.js` sanitizer | Copy | Allow-list discipline. |
| `journey.js` + `/api/funnel` + `/api/attribution` | Copy | Best "where from / where to" template. |
| `cac.js` | Copy, simplify | channel + campaign only. |
| `POST /api/v1/leads` into TK | **Not reusable** | No tenant column, phone-unique collision, CAC pollution. |
| `GET /api/public/properties` | Call server-side only | No CORS. |
| Green API send/receive | Not reusable | Hard-coded Green API. |
| GA4/GTM/GSC/GBP, IG posting | Nothing to reuse | Absent in TK. |

**Open first:** `src/touchpoints.js`, `src/ctwa.js` (`:47-124`), `scripts/migrate-meta-attribution.sql`, `middleware/capture-attribution.js`, `src/public-api.js` (`:14-48`, `:96-137`, `:743`).
