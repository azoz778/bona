# Search Console, Bing Webmaster & IndexNow — setup

## Google Search Console
`azoz.uk` is already a **Domain property** (verified via DNS TXT), so `bona.azoz.uk` and every path under it are covered automatically — no new verification needed.

### Day 1 (after the first deploy)
1. search.google.com/search-console → property **azoz.uk** → **Sitemaps** → add `https://bona.azoz.uk/sitemap-index.xml` → Submit.
2. **URL Inspection** → paste `https://bona.azoz.uk/` → *Request indexing*. Repeat for `/ar/`, `/properties/`, `/ar/properties/`, `/about/`, `/sell/` (Google allows ~10 manual requests/day).
3. **Settings → Crawl stats** will start populating within 48 h; **Pages** report confirms indexing.
4. Filter reports by *Page → URLs containing `bona.azoz.uk`* to see Bona separately from other azoz.uk subdomains. (Optional: also add a **URL-prefix property** `https://bona.azoz.uk/` — it auto-verifies through the domain property — to get a Bona-only dashboard and a clean Performance report.)

### Week 1
- **Enhancements → hreflang**: no dedicated report; check *International targeting* is absent (it was retired) and rely on the Pages report showing both `/x/` and `/ar/x/` indexed.
- **Rich results**: run https://search.google.com/test/rich-results on one listing page and the home page — expect `RealEstateListing` (no rich result type, but must parse without errors), `Organization`, `BreadcrumbList`.
- Check **Core Web Vitals** once field data exists (28 days).

### When bona.com.sa goes live
1. Add **Domain property** `bona.com.sa` (DNS TXT at the .sa registrar / Cloudflare).
2. Flip `site.url` in `src/data/site.json`, rebuild, deploy; keep `bona.azoz.uk` serving **301s** to the same paths on bona.com.sa (Cloudflare redirect rule) for ≥ 6 months.
3. In the *old* property (azoz.uk) → **Settings → Change of address** is not available for subdomain-only moves; the 301s + sitemap on the new domain are sufficient.
4. Submit `https://bona.com.sa/sitemap-index.xml` on the new property; re-run IndexNow with `SITE_URL=https://bona.com.sa` (the key file is copied automatically because it lives in `public/`).

## Bing Webmaster Tools (also feeds Copilot/ChatGPT search)
1. bing.com/webmasters → **Import from Google Search Console** (one click, uses the GSC OAuth) → pick azoz.uk.
2. Sitemaps → add `https://bona.azoz.uk/sitemap-index.xml`.
3. IndexNow status shows under **IndexNow** in the left nav once the first submission lands.

## IndexNow
- Key: `site.indexNowKey` = `b0na7c3f9e2d4a1b8f6e5c4d3b2a1908`, served at `https://bona.azoz.uk/b0na7c3f9e2d4a1b8f6e5c4d3b2a1908.txt` (file lives in `public/`).
- Submit after every deploy:
  ```bash
  node scripts/indexnow.mjs            # reads dist/sitemap-index.xml, POSTs all URLs
  node scripts/indexnow.mjs --dry-run  # inspect
  ```
- CI: add a step after `npm run build` in `.github/workflows/deploy.yml`: `- run: node scripts/indexnow.mjs` (non-fatal by design, always exits 0).
- Expected responses: `200 OK` or `202 Accepted` on the first call (key validation), `403/422` means the key file isn't reachable yet — wait for the deploy to finish and re-run.
- Google ignores IndexNow; it relies on the sitemap + internal links.

## Other free discovery surfaces (15 min total)
- **Google Business Profile** — see `google-business-profile.md` (this is the single most important local signal).
- **Apple Business Connect** (register.apple.com) — same NAP; feeds Apple Maps / Siri.
- **Bing Places** — import from GBP.
- **Yandex Webmaster** — optional (Russian-speaking buyers on the Côte d'Azur/Costa del Sol inventory); it accepts the same IndexNow key.

## Monitoring cadence
| When | What |
|---|---|
| Daily (first 2 weeks) | GSC *Pages* → indexed count trending up; no "Duplicate without user-selected canonical" for AR pages |
| Weekly | GSC *Performance* filtered to Bona; Bing *Search performance*; IndexNow submissions count |
| Monthly | Manual AI-visibility check: ask ChatGPT / Perplexity / Gemini "luxury real estate agency in Jeddah", "فلل فاخرة للبيع في جدة" — log whether Bona is cited |
