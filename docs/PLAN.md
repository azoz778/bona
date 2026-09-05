# Bona — launch plan (2026-09-05)

Owner brief: new luxury real-estate company **Bona** (بونا). Reuse TK Estate's photos, listings and copy. Luxury site, bilingual AR/EN, test domain **bona.azoz.uk** (real domain bona.com.sa to be bought later). Instagram **@bona.com.sa** exists. WhatsApp **+966 59 329 6933**. Everything connected (Instagram, social, SEO), an ops dashboard, a recurring loop, multiple agents, done today.

## Decisions (made autonomously — change any in `src/data/site.json`)
| Topic | Decision | Why |
|---|---|---|
| Stack | Astro 7 static + Tailwind 4, self-hosted fonts (Cormorant / Montserrat / IBM Plex Arabic / Amiri from TK land pages) | Fast, SEO-perfect static HTML, bilingual i18n built in, zero runtime cost |
| Hosting | GitHub Pages via Actions, repo `azoz778/bona`, custom domain `bona.azoz.uk` (Cloudflare CNAME → `azoz778.github.io`, DNS-only until GitHub issues the cert) | VPS SSH and Vercel/Netlify are not available to the agent; GitHub + Cloudflare DNS are |
| Leads | WhatsApp deep link (`wa.me/966593296933`) with pre-filled property reference is the primary CTA on every listing + contact form. No email shown until bona.com.sa mailbox exists | TK's inquiry API has no CORS and JSON-only body; static hosting has no server. WhatsApp is how Saudi luxury buyers actually enquire |
| Data | `src/data/listings.json` curated from TK's public API (50 live listings) + TK photo library (1,490 images, 64 folders on tk-storage.azoz.uk). `scripts/sync-listings.mjs` refreshes from TK daily in CI (non-fatal if TK is down) | Real inventory, real photos, self-updating |
| Brand | Ivory / ink / champagne palette, editorial serif display, generous whitespace, photography-led | Luxury positioning; deliberately different from TK's Duda template |
| Licences | Site footer shows FAL 1100313556 (owner's own REGA broker licence). CR number blank until Bona's CR exists | Legal to show; REGA ad rules still require per-listing ad licences before paid promotion (dashboard flags this) |
| Instagram | Site links to @bona.com.sa. Launch kit in `marketing/` (bio, 30-day calendar, 9 launch posts AR/EN with image URLs, hashtag sets). Posting script ready for the Meta Graph API — needs the owner to convert @bona.com.sa to a Business account and link it to a Facebook Page in TK's Meta Business (5 min, owner-only) | API posting is gated on account linking, which only the account owner can do |
| Dashboard | `/dashboard/` (noindex): lead tracker (local + CSV export), inventory, content calendar, integration status board, launch checklist | Zero backend; upgrade path = TK CRM or Supabase later |
| Loop | GitHub Actions: daily 06:00 KSA rebuild (fresh listings) + link/health check; weekly content-calendar refresh issue. Session loop: agent swarm iterates until QA + two-model review pass | Durable without a chat session |
| Review | Claude reviewer agent + Codex second opinion before "shipped" | Owner rule 2026-09-01 |

## Work breakdown (parallel agents)
1. **data** — build `src/data/listings.json` (20–30 best listings, AR+EN, 4–10 photos each from the TK gallery), `scripts/sync-listings.mjs`.
2. **site** — layouts, components, pages (home, properties + filters, listing detail, about, contact, sell/list-with-us, 404), AR mirror, WhatsApp CTAs, contact form → WhatsApp.
3. **seo-social** — metadata, hreflang, JSON-LD (RealEstateAgent, per-listing Residence + Offer), OG, sitemap, robots, llms.txt, IndexNow key file, GA4 hook, Instagram launch kit, Google Business Profile + Search Console checklist.
4. **dashboard** — `/dashboard/` ops page.
5. **qa** — real-browser QA (Windows Chrome over CDP), link check, Lighthouse-style checks; then Claude + Codex review.

## Owner-only items (cannot be done by the agent)
- Create GitHub repo (`gh repo create azoz778/bona --public`) if the classifier keeps blocking it.
- Instagram: switch @bona.com.sa to Business, link to a Facebook Page under the TK Meta Business, then the posting script works unattended.
- Buy bona.com.sa (Saudi .com.sa needs a CR / trade name), then flip `site.url` and DNS.
- GA4 property + Meta Pixel IDs → `site.json.analytics`.
- Bona CR + FAL company licence + REGA ad licences before paid promotion.

## Status 2026-09-05 16:40 KSA
- Built, reviewed and pushed to `main` (commit 0a69426): 84 pages (EN+AR), /dashboard/, SEO layer, Instagram kit, daily CI loop.
- Reviews: Codex #1 (SEO/data/dashboard) 4 findings fixed · Claude reviewer (site) 1 critical + 8 important fixed · Codex #2 (site) 1 high (regression from the plural fix) fixed. Browser QA: filters/sort EN+AR, gallery, Arabic-digit form, zero console errors.
- Blocked on owner: repo visibility → see docs/OWNER-RUNBOOK.md §1.

## Round 2 — 2026-09-05 20:20 KSA (owner request: more properties, houses vs apartments, about us, privacy, immersive, Matterport)
- LIVE (main @ 66bccff): 47 listings (24 houses, 21 apartments incl. 10 Kian Residence units, 2 land plots with Esri satellite stills), sections /properties/houses/ · /apartments/ · /land/, /tours/ (Matterport inline embed; 1 tour today, more arrive via the 06:00 sync of TK's virtual_tour_url), /about/ from src/data/about.json (story, values, founder, stats), /privacy/ (PDPL policy AR/EN, 13 sections), immersive layer (hero slideshow + Ken Burns, view transitions, reveals, parallax, marquee, gallery strip), dashboard kind/tour views. 124 pages, 0 broken links, 0 console errors.
- Instagram: @bona.com.sa is still a personal account (business_discovery: not found) → owner brief in marketing/instagram-access.md (Path A no password / Path B password).
- Reviews: Claude reviewer + Codex on the round-2 diff in progress; findings applied in follow-up commits.
