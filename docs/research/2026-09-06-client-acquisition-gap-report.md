# Bona — what is still missing to acquire and track clients (2026-09-06)

Consolidated from four reports in this folder: `2026-09-06-bona-code-audit.md`, `2026-09-06-tk-reuse-audit.md`, `2026-09-06-saudi-re-acquisition-research.md`, `2026-09-06-attribution-mechanics-research.md`. Live checks the same day: site 200, `bona-api` healthy (43 listings in inventory, 3 chats + 1 call today), `leads.jsonl` does not exist yet (zero stored leads), Meta connector sees only TK assets (business "TKEstate", ad account "Tarek Shams" with no payment method, zero Pages).

## A. Legal and compliance (gates paid promotion)

1. **REGA advertising bylaw (1 May 2026, 12 articles).** Every advert on every channel (site, Instagram, Snapchat, WhatsApp groups, brochures) needs its own **ad licence issued on the FAL platform** (~SAR 50; requires an owner-approved brokerage contract with marketing scope + deed number). Mandatory content: advertiser name, FAL number, ad-licence number + expiry, contact data matching the licence, description/location/price. A **QR code may substitute** for the text block. Fines up to SAR 200k (SAR 1M for platforms).
2. **Off-plan projects (NHC, Bin Saedan…)** are exempt from per-ad licences but must cite the project's **Wafi** licence number. Marketing SME off-plan needs the Wafi broker registry (CR required) + a written developer marketing contract.
3. **Brand vs licence.** An individual FAL holder can issue ad licences without a CR, but the ad must carry the *licensed person's* name and contacts. To advertise *as* "Bona": reserve trade name → sole-establishment CR (activity 682010) → establishment FAL (~SAR 1,000/yr). The CR also unlocks Ejar, bona.com.sa, Meta/WhatsApp Business Verification, Google Ads advertiser verification and a business bank account. **bona.sa is registrable today by a Saudi individual with national ID.**
4. **PDPL.** Consent banner + AR/EN privacy notice required in practice before GA4/Pixel go live (the published policy already promises a decline option). GA4/Meta/Snap/Retell are cross-border transfers: keep a short risk assessment + safeguards note, register on SDAIA's NDGP. Dana must announce recording/AI at call start and log consent. Marketing messages need opt-in.
5. **Tax/finance.** VAT registration above SAR 375k with e-invoicing from day one, RETT 5%, 15% VAT on commission, 2.5% commission cap.

## B. Tracking on the site — nothing exists

- No UTM / `fbclid` / `gclid` / `ttclid` / `ScCid` capture, no referrer, no first/last-touch persistence, no visitor/session id.
- GA4 + Pixel hooks exist in `Head.astro` but IDs are null; when enabled they emit page_view only.
- No custom events (whatsapp_click, call_click, brochure_download, tour_open, chat_start, call_start, form_submit).
- No consent banner, no CSP.
- Every WhatsApp CTA except the listing page sends a generic "Hello Bona," — an ad click and an organic visitor are indistinguishable.

## C. Getting attribution into WhatsApp

- The personal number on Evolution API (Baileys) **cannot be a Click-to-WhatsApp ad destination** (Meta requires a WhatsApp Business account linked to the Page) and cannot send `business_messaging` Conversions API events.
- Therefore the carrier is the **prefilled text**: a short reference code minted per session, registered on bona-api before the chat opens, and matched by a read-only Evolution poller (fallback: ±15-min time window vs. `whatsapp_click`, flagged "inferred").
- Baileys does expose `contextInfo.externalAdReply{sourceId, ctwaClid, ref, sourceApp}` + `entryPointConversionSource`, so organic Instagram/Facebook profile-button chats can still be recognised. Verify on the installed Evolution build (some versions stripped it).
- Evolution `findMessages` quirks: `fromMe:false` ignored, time filter needs `gte` and `lte`, `extendedTextMessage.text` flattened to `conversation`, paging via `offset`.

## D. Lead store, CRM, dashboard

- Dana's `create_lead` writes `leads.jsonl` with `source:'concierge'` hardcoded and `page` as the only journey field. No read endpoint.
- `/dashboard/` is a static page with a localStorage "CRM" typed by hand, no auth, on a public host.
- No funnel, no source breakdown, no response-time view.
- Recommended: SQLite (better-sqlite3) on bona-api, `lead_touchpoints` spine copied from TK, server-rendered dashboard on bona-api behind Cloudflare Access (one-time PIN to the owner's email). Do **not** post Bona leads into TK's CRM (single-tenant, phone-unique, would pollute TK CAC).

## E. Meta / Instagram

- No Facebook Page, no Pixel/dataset, no ad account, no Business Portfolio for Bona. IG @bona.com.sa is a Business account but not linked to a Page inside an accessible portfolio → no Graph API publishing, no lead ads, no catalogue ads.
- Website CAPI events (Lead/Contact/Schedule, `action_source: website`, `fbc/fbp`, hashed phone, `event_id` dedupe) work without Cloud API.

## F. Google

- No GA4 property, no key events, no Consent Mode. Search Console: azoz.uk verified but Bona sitemap never submitted. No Google Business Profile ("Real estate agent", video verification, hidden address). Google Ads advertiser verification needs CR or Saudi ID.

## G. Channels that produce Jeddah luxury leads (ranked by research)

Must-haves: referrals + developer allocations, Instagram, **Snapchat** (73% reach, cheapest CPMs; a Saudi RE case cut CPL 38% with CAPI), Google Search + Business Profile, Meta Click-to-WhatsApp (needs a Cloud API number), **Aqar** (SAR 2,000/yr). Defer TikTok (min $50/day, younger skew). Skip Haraj. Indicative KSA: Instagram RE CPC SAR 1.2–2.5, CPM SAR 25–45, CPA SAR 90–180; luxury RE CPL $180–450 (blog sources).

## H. What competitors do on-site

Knight Frank KSA: short form + gated reports + "book a consultation". Mada Properties: floating WhatsApp + "Request a property" + "List your property". Worth copying: register-interest per off-plan project, seller-side valuation form, phone-gated brochures, FAL/ad-licence/QR block on every listing. Matterport is a real local differentiator.

## I. Reusable from TK (copy, not call)

`src/touchpoints.js`, `middleware/capture-attribution.js`, `src/ctwa.js` body (new Baileys extractor), `src/ad-property-code.js`, `src/attribution.js` (5 models), `src/share-links.js`, `src/pixel.js` (CAPI relay), `src/journey.js` + `/api/funnel` + `/api/attribution` views. Nothing to reuse for Google or Instagram publishing (absent in TK).

## J. Recommended end-to-end architecture

```
visitor → site (inline attribution snippet: UTMs, click ids, referrer, landing, first/last touch,
          session, fbp/fbc synth, consent) 
        → events POST text/plain keepalive → bona-api (SQLite: sessions, events, leads, touchpoints)
        → every wa.me link rewritten at click: "… Ref BONA-W003 · K7Q2X"
        → Evolution poller (read-only findMessages, 30–60 s) matches Ref → lead + touchpoint
        → Dana create_lead carries {anon_id, session_id, ref, listing_id} via Retell metadata
        → fan-out (idempotent): Meta CAPI website events, GA4 Measurement Protocol, later Snap/TikTok
        → owner WhatsApp note (exists) + server-rendered dashboard behind Cloudflare Access
```

## K. Decisions needed from the owner

1. Ads legal path: personal FAL now vs wait for Bona CR vs TK entity.
2. WhatsApp number: keep personal (ref codes) vs add Cloud API number vs both.
3. Meta portfolio: new "Bona" portfolio vs inside TKEstate.
4. Lead store: own SQLite + dashboard vs + Chatwoot vs Zoho vs HubSpot.
5. Analytics stack: GA4 + Pixel + consent + first-party store vs first-party only.
6. Channels to wire first (Instagram/Facebook, Snapchat, Google, Aqar, TikTok).
7. Domain: register bona.sa now vs wait for bona.com.sa.
8. Google account for GA4/GBP/Ads (bona.com.sa@gmail.com created 2026-09-05) and monthly ad budget.
