# Bona — lead capture / analytics / attribution / dashboard code audit (2026-09-06)

Produced by an Explore agent over `~/bona` at commit 8197c4f. Read-only. `path:line` refs are as of that commit.

## 1. Lead paths & CTAs

**Deep-link builder:** `src/lib/i18n.ts:48-50` — `waLink(wa, message)` → `https://wa.me/${wa}?text=${encodeURIComponent(message)}`. Number from `src/data/site.json:12`. **No UTM, no click-id, no page param, no source tag is ever appended.**

| CTA | Where rendered | Message content |
|---|---|---|
| Header WhatsApp icon + mobile drawer button | `src/components/Header.astro:21,52,75` | `ui.formGreeting` = "Hello Bona," (`i18n.ts:220`) — generic |
| Footer WhatsApp + `tel:` | `src/components/Footer.astro:11,43` | generic |
| Floating WA button / concierge cluster | `src/components/WhatsAppFloat.astro:9-11` | generic or passed `message` |
| Home hero "Private enquiry", contact band WA + `tel:` | `src/components/pages/HomePage.astro:25,52,170,171` | generic |
| **Listing "Enquire on WhatsApp"** | `src/components/pages/ListingPage.astro:19-20,130` | `ui.listingWaMessage` (`i18n.ts:173`) = `Hello Bona, I'm interested in {title} ({id}) — {url}` → carries listing title, `BONA-###` id, absolute URL, locale. **The only attribution signal in the system.** |
| Listing `tel:` | `ListingPage.astro:131` | — |
| Off-market land CTA | `src/components/pages/PropertiesPage.astro:34,96` | `ui.landOffMarketMessage` (`i18n.ts:258`) static |
| Brochure download | `ListingPage.astro:111-113` → `/listings/<slug>/brochure.pdf` (written by `services/intake/lib/publish.mjs:175`) | plain `<a target=_blank>`, no event |
| Matterport tour | `src/components/TourEmbed.astro:14,20,42-49` click-to-load facade + external link | no event |
| Enquiry forms (`contact`, `sell`, `listing`) | `src/components/EnquiryForm.astro`; mounted at `ContactPage.astro:77`, `SellPage.astro:85`, `ListingPage.astro:119` | Client-side only (`EnquiryForm.astro:104-134`): greeting, `Reference: {title} ({id})` (hidden input line 29), name, phone, interest/type/budget/location, message, `Sent from {pageUrl}` (124-125), opens `wa.me` (126). **Nothing POSTed or stored** (`src/data/privacy.json:56`). |
| Dana chat + voice call | `src/components/concierge/Concierge.astro`, `client.ts:310,320`, `call.ts:82` | sends `{ locale, page: pathname }` to bona-api; WA fallback (`Concierge.astro:98`), `tel:` (`:148`) |
| Instagram link | `HomePage.astro:155`, `ContactPage.astro:47` | — |
| Email | `ContactPage.astro:42` — dead: `site.json:14` `"email": null` | — |

## 2. Analytics head hooks

Consumed only in `src/components/seo/Head.astro:77-79`, emitted at `:149-168`: GA4 `gtag/js` + `gtag('config', ga4, { anonymize_ip: true })` (page_view only); Meta Pixel `fbq('init')` + `PageView` + noscript. **Both null** (`src/data/site.json:32`).

- **Custom events: none.** No `gtag(`/`fbq(`/`dataLayer`/`snaptr`/`ttq` outside `Head.astro`.
- **UTM / click-id capture: none.** No `utm_`, `fbclid`, `gclid`, `ttclid`, `ScCid`, `msclkid` anywhere in `src/`, `scripts/`, `services/`. No `document.referrer` capture. `localStorage` used only by the dashboard (`src/lib/dashboard/client/storage.ts:4-9`).
- **Consent banner: none.** No cookies set (`src/data/privacy.json:38`). Policy promises a decline option *before* tags are enabled → enabling GA4/Pixel without a banner breaks the published policy.
- **CSP: none.** No headers, no `http-equiv`, no `public/_headers` (GitHub Pages ignores it). Nothing would block GA4/Meta/Snap/TikTok.

## 3. `/dashboard/`

`src/pages/dashboard/index.astro` — static, `noindex` (`:97`), excluded from sitemap (`astro.config.mjs:21`) and robots (`public/robots.txt:6`). **No auth.** Sections (`:48-56`): Overview, Leads, Inventory, Content calendar, Integrations, Launch checklist, Quick links.

- Data 100% build-time: `listings.json` → `src/lib/dashboard/stats.ts`, `integrations.json`, `launch-checklist.json`, `content-calendar.json` serialised into `<script id="dash-data">` (`:75-92,109`), read by `src/lib/dashboard/client/data.ts:31`. **Zero fetches to bona-api.**
- Leads = manual localStorage CRM: `src/components/dashboard/Leads.astro` + `src/lib/dashboard/client/leads.ts`. Schema (`leads.ts:15-18`): `id, name, phone, source, interest, propertyId, budget, stage, notes, createdAt, updatedAt`. `SOURCE` enum of 5 (`leads.ts:9`). No medium/campaign/referrer/landing/click-id. CSV import/export (`Leads.astro:18-21`, `csv.ts`). Not read from `~/bona-data/leads.jsonl`.
- Overview KPIs (`Overview.astro:48-49`) from the same localStorage array. No source breakdown, no funnel.
- Integrations board (`Integrations.astro`): `src/data/integrations.json` (hand-maintained; `ga4`, `meta-pixel`, `instagram`, `gbp` all `pending-owner`) + browser `fetch()` checks (`src/lib/dashboard/client/checks.ts:20-36`) of 9 URLs (`index.astro:36-46`). Does not check bona-api `/health`, GA4, Pixel, IG, GBP.

## 4. `services/api` (bona-api)

Entry `services/api/index.mjs`. Routes (`:9-16`, dispatcher `:390-479`):

| Route | Auth |
|---|---|
| `GET /health`, `/` | none |
| `POST /v1/chat/session` · `/message` · `/end`, `POST /v1/call/token` | CORS-allowlist origin (`:430`) + JSON required (`:434`) + per-IP rate limit + daily budget |
| `GET /v1/call/:callId/context` | none, 120/min |
| `POST /v1/tools/{search_properties,show_property,create_lead}` | `X-Bona-Token` / Bearer, constant-time (`lib/tools.mjs:30-54`); no CORS by design |
| `POST /v1/retell/webhook?token=` | same token (`:369`) |

`create_lead` (`lib/tools.mjs:130-171`): accepts `name, phone|phone_number|mobile, interest|enquiry, budget, timeline, notes, language, district|area|location, listing_id|property_id|id`. Rejects without phone or name (`:138`). Dedupe = conversationId + last-9 digits, 10-min window (`:22,61-67`). `appendLead` → `lib/leads.mjs:25-39`: `${BONA_DATA:-~/bona-data}/leads.jsonl` (0700/0600), record `{ id: "LEAD-YYYYMMDD-xxxx", ts, source:'concierge', channel:'chat'|'voice', …LEAD_FIELDS, conversationId, page }`. `page` = pathname only.

Owner notification: `lib/wa.mjs:35-61` — Evolution API `POST /message/sendText/{instance}` to `966593296933@s.whatsapp.net` (`wa.mjs:11`), fallback `BONA_WA_GROUP_JID`. Body from `leadNote()` (`leads.mjs:50-62`).

No analytics/event endpoint. `chats.jsonl` / `calls.jsonl` written by `chatEnd` (`index.mjs:279-283`) and `retellWebhook` (`index.mjs:314-336`, incl. transcript, sentiment, `metadata.page`).

CORS allowlist `lib/cors.mjs:7-14`: bona.azoz.uk, bona.com.sa, www.bona.com.sa, azoz778.github.io, localhost:4321, 127.0.0.1:4321. Rate limits `lib/config.mjs:66-72`; body cap 16 KB; daily budget chats 300 / calls 60 (`lib/budget.mjs`).

Retell tool defs `services/api/retell/provision.mjs:78-152`, persona `retell/prompt.md:72-77`. `create_lead` schema: `phone` (required), `name`, `interest`, `budget`, `timeline`, `district`, `listing_id`, `notes`, `language`. Dynamic variables to agent: `locale, page_url, page_title, session_id` (`index.mjs:179-186`).

## 5. Listing metadata a CRM needs

`src/data/LISTING-SCHEMA.md`: `id` (`BONA-###` curated; `BONA-W###` WhatsApp-published, allocated `services/intake/lib/listing.mjs:103-125`), `slug` (`listing.mjs:15-39`), `status` available|reserved|sold, `category` buy|rent|off-plan|international, `type`, `kind` house|apartment|land|building (`src/data/kind-map.json`), `price {amount,currency,from,period,onRequest}` (`listing.mjs:185-192`), `featured`, `location`, `specs`, `virtualTourUrl`, `brochureUrl`, `listedAt`.

## 6. SEO / discovery

`src/lib/seo.ts` JSON-LD graph (`Head.astro:35-75`): `RealEstateAgent`+`Organization` (`seo.ts:156`), `Person` (`:207`), `WebSite` (`:238`), page types (`:269`), `BreadcrumbList`, `CollectionPage`+`ItemList` (`:320`), `RealEstateListing` + `House`/`Apartment`/`ApartmentComplex` + `Offer` (`:418-504`), `3DModel` (`:391`). No `FAQPage`, `Review`, `AggregateRating`. Sitemap via `@astrojs/sitemap` (`astro.config.mjs:19-24`), hreflang (`Head.astro:99-101`), robots, `llms.txt` regenerated in CI (`deploy.yml:34,53`), IndexNow (`deploy.yml:54-55`), single default OG image + listing hero.

## 7. Open owner-gated items (PLAN.md / OWNER-RUNBOOK.md / marketing/)

- Instagram Business but not linked to a Page inside an accessible Meta Business (`marketing/instagram-status.md:4,10-12`).
- GA4 + Pixel IDs → `site.json.analytics` (`OWNER-RUNBOOK.md:28-29`).
- Search Console sitemap never submitted (`OWNER-RUNBOOK.md:32`, `marketing/search-console.md`).
- Google Business Profile unclaimed (`marketing/google-business-profile.md`).
- bona.com.sa needs Saudi CR (`OWNER-RUNBOOK.md:36`).
- Bona CR + per-listing REGA ad licences before paid promotion (`PLAN.md:31`, `OWNER-RUNBOOK.md:37`, `marketing/launch-posts.md:5`).
- WhatsApp Business profile not configured (`OWNER-RUNBOOK.md:25-26`).
- Dashboard "zero backend; upgrade path = TK CRM or Supabase later" (`PLAN.md:15`).
- Nothing anywhere about lead routing, ad accounts, campaign structure, conversion tracking.

## GAP LIST

**(a) Where the client came from — effectively zero.** No UTM/click-id parser, no first-touch persistence, no referrer capture. `waLink()` appends nothing; prefilled text is the only carrier and holds listing id only on listing pages. `EnquiryForm` sends page but not source. `create_lead` has no source/medium/campaign/click_id/referrer; `appendLead` hardcodes `source:'concierge'`. No CAPI / offline-conversion path.

**(b) Where they went — near zero.** GA4 off; when on, page_view only. No `whatsapp_click`, `brochure_download`, `tour_view`, `call_start`, `chat_start`, `form_submit`, `phone_click`, gallery/filter events. No visitor/session id, no multi-page path.

**(c) Dashboard — missing.** Hand-typed localStorage table, single-browser, wiped by clearing site data. No ingestion of `leads.jsonl`/`chats.jsonl`/`calls.jsonl`; bona-api has no read endpoint. No funnel, no source chart, no response-time SLA. **Unauthenticated on a public host.** Integrations board does not check bona-api/GA4/Pixel/IG/GBP.

**(d) Meta — not connected.** No Pixel/dataset/CAPI/`_fbc`/`_fbp`. No Facebook Page → no IG Graph publishing, no lead ads, no Business asset, no catalogue. No ad account. IG "Message on WhatsApp" CTA would send untagged traffic.

**(e) Google — not connected.** No GA4, GTM, key events, consent mode. Search Console sitemap not submitted; no Bona URL-prefix property; no GBP. No `Review`/`FAQPage` schema; no per-page OG beyond listing hero.

**Smallest high-leverage fixes:** (1) `src/lib/attribution.ts` reading UTM+click-ids+referrer on first hit, persisting first/last touch, appending a short token to every `waLink()` message and the `EnquiryForm` body; (2) delegated click listener emitting the six missing events; (3) `source/medium/campaign/clickId/landingPage` on `create_lead` + `LEAD_FIELDS` (`leads.mjs:10`) + dashboard `Lead` (`leads.ts:15`); (4) token-gated `GET /v1/leads` on bona-api so the dashboard reads real data.
