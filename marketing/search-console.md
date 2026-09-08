# Search Console, Bing Webmaster & IndexNow — setup

**Rewritten 2026-09-08 for the live domain `bona-real-estate.com`.** Everything below was checked against the
live site on that date. The previous version of this file described `bona.azoz.uk` and a planned
`bona.com.sa`; both are obsolete.

## Where things actually stand (verified 2026-09-08)

| Thing | State | Evidence |
|---|---|---|
| `https://bona-real-estate.com/` | Live, HTTP 200 | `curl -I` |
| `https://bona.azoz.uk/` → new domain | **301, correct** | `curl` no-follow → `301 https://bona-real-estate.com/` |
| `https://www.bona-real-estate.com/` → apex | **301, correct** | same |
| Canonical tags | **Correct on the new domain** | `<link rel="canonical" href="https://bona-real-estate.com/">` |
| hreflang en / ar / x-default | **Correct, reciprocal** | present in HTML on every indexable page |
| `sitemap-index.xml` → `sitemap-0.xml` | Live, **124 URLs** (62 EN + 62 AR) | fetched |
| `robots.txt` | Live, sitemap referenced | fetched |
| `llms.txt` (15.9 KB) / `llms-full.txt` (179 KB) | Live, all URLs on the new domain | fetched |
| IndexNow key file | Live, HTTP 200, correct contents | `/b0na7c3f9e2d4a1b8f6e5c4d3b2a1908.txt` |
| **IndexNow submission** | **Working — HTTP 200 from api.indexnow.org** | live POST, 2026-09-08 |
| Google Search Console | **Not verified yet** — no TXT record on the zone | Cloudflare API: zero TXT records |
| Bing Webmaster Tools | Not set up | — |

The domain cutover was done properly. The one thing missing is that **Google has never been told the site
exists**, because there is no Search Console property. That is step 1 and it is the highest-value 15 minutes
in this file.

---

## 1. Google Search Console — Domain property (owner, 10 min)

A *Domain* property covers `bona-real-estate.com`, `www.`, every subdomain and both protocols at once, and is
verified with one DNS TXT record. Do this rather than a URL-prefix property.

### Step 1a — get the TXT value
1. Go to <https://search.google.com/search-console>
2. **Add property** → left-hand box, **Domain**
3. Type `bona-real-estate.com` (no `https://`, no `www.`) → **Continue**
4. Google shows a TXT value like `google-site-verification=XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`
5. **Copy the whole string** and paste it into the chat.

### Step 1b — Claude adds it to Cloudflare
The DNS-edit token in `~/.secrets/cloudflare.env` was tested against this zone on 2026-09-08 and works
(zone `bona-real-estate.com`, id `790f2dde2e03e7055f88ae4b6c05579b`, status `active`).

```bash
# Replace PASTE_VALUE_HERE with the value from step 1a, then run:
set -a; . ~/.secrets/cloudflare.env; set +a
curl -sS -X POST \
  "https://api.cloudflare.com/client/v4/zones/790f2dde2e03e7055f88ae4b6c05579b/dns_records" \
  -H "Authorization: Bearer $CLOUDFLARE_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "type": "TXT",
    "name": "@",
    "content": "PASTE_VALUE_HERE",
    "ttl": 300,
    "comment": "Google Search Console domain verification (added 2026-09-08)"
  }' | python3 -m json.tool
```

`"success": true` means it is in. Confirm propagation before clicking Verify:

```bash
dig +short TXT bona-real-estate.com @1.1.1.1
```

Then back in Search Console → **Verify**. It usually passes within a minute at TTL 300.

> `ZID` inside `cloudflare.env` is the **tk-estates.com** zone, not this one. Always pass the Bona zone id
> `790f2dde2e03e7055f88ae4b6c05579b` explicitly, as the command above does.

### Step 1c — immediately after verifying
1. **Sitemaps** → add `sitemap-index.xml` → Submit. (Enter just that path; GSC prefixes the domain.)
2. **URL Inspection** → paste each of these and click *Request indexing*. Google allows roughly 10 a day, so
   this is the whole first day's budget — spend it on the pages that earn:

   ```
   https://bona-real-estate.com/
   https://bona-real-estate.com/ar/
   https://bona-real-estate.com/properties/
   https://bona-real-estate.com/ar/properties/
   https://bona-real-estate.com/properties/for-sale/
   https://bona-real-estate.com/faq/
   https://bona-real-estate.com/ar/faq/
   https://bona-real-estate.com/about/
   https://bona-real-estate.com/sell/
   https://bona-real-estate.com/contact/
   ```

3. Day 2, spend the next ten on the strongest individual listings — the ones with real photography and a price.

### Step 1d — week 1 checks
- **Pages** report: indexed count should climb from 0. Watch for *"Duplicate without user-selected canonical"*
  on `/ar/` pages. It should not appear — hreflang was verified reciprocal on 2026-09-08 — but if it does, the
  pairing is being ignored and needs investigating.
- **Rich results test** on `https://bona-real-estate.com/faq/` → expect a valid **FAQPage** with 12 questions.
  On a listing page expect `RealEstateListing`, `RealEstateAgent`/`Organization`, `BreadcrumbList` and
  `ItemPage` to parse without errors. (`RealEstateListing` earns no rich result in Google; parsing cleanly is
  the goal, and being extractable by answer engines is the actual payoff.)
- **Core Web Vitals** needs 28 days of field data. Nothing to look at until October.

---

## 2. Bing Webmaster Tools (owner, 5 min)

Bing matters more than its market share suggests: it is the retrieval index behind **Microsoft Copilot** and
part of **ChatGPT search**. Getting into Bing is getting into AI answers.

1. <https://www.bing.com/webmasters> → sign in with the same Google account.
2. **Import from Google Search Console** — one click, reuses the GSC OAuth, no second DNS record.
   Do this *after* step 1 or there is nothing to import.
3. Sitemaps → add `https://bona-real-estate.com/sitemap-index.xml`.
4. Left nav → **IndexNow** → confirm the key `b0na7c3f9e2d4a1b8f6e5c4d3b2a1908` shows as active. It should:
   a live submission returned HTTP 200 on 2026-09-08.

---

## 3. IndexNow — already working, do not touch

Verified end to end on 2026-09-08:

```
GET /b0na7c3f9e2d4a1b8f6e5c4d3b2a1908.txt   → HTTP 200, text/plain, correct key
POST https://api.indexnow.org/indexnow       → HTTP 200
```

- Key lives in `src/data/site.json` → `indexNowKey`; the file is served out of `public/`.
- It already runs after every deploy: `.github/workflows/deploy.yml`, step *"IndexNow ping (non-fatal)"*,
  running `node scripts/indexnow.mjs --dir dist`. Nothing to add.
- Manual run, e.g. after publishing a single listing:
  ```bash
  node scripts/indexnow.mjs --only /properties/foo/,/ar/properties/foo/
  node scripts/indexnow.mjs --dry-run     # inspect without sending
  ```
- Reaches Bing, Yandex, Seznam and Naver. **Google ignores IndexNow entirely** and relies on the sitemap and
  internal links — which is exactly why step 1 is not optional.

---

## 4. The other free discovery surfaces

| Surface | Why | Where |
|---|---|---|
| **Google Business Profile** | Highest-intent free channel a local brokerage has. Own deliverable. | `google-business-profile.md` |
| **Apple Business Connect** | Feeds Apple Maps and Siri. Free. Same NAP. | <https://register.apple.com> |
| **Bing Places** | Imports from GBP in one click once GBP is verified. | <https://www.bingplaces.com> |
| **WhatsApp Channel** | Free broadcast surface, strong in Saudi. | `broadcast-copy.md` |

Keep name, address and phone **byte-identical** across all of them and the site footer. Inconsistent NAP is
the most common reason a local listing under-ranks.

---

## 5. Monitoring cadence

| When | What |
|---|---|
| Daily, first 2 weeks | GSC **Pages** → indexed count rising; no *"Duplicate without user-selected canonical"* on `/ar/` |
| Weekly | GSC **Performance** — at this stage impressions and queries are the signal, not clicks; Bing **Search performance**; IndexNow submission count |
| Monthly | Ask ChatGPT, Perplexity and Gemini: *"best luxury real estate agent in Jeddah"*, *"villas for sale in Al Shati"*, *"can a foreigner buy property in Jeddah"*, *"أفضل مكتب عقاري فاخر في جدة"*, *"فلل للبيع في الشاطئ جدة"*. Log whether Bona is cited and from which page. That third query is the one `/faq/` was built to win. |

---

## 6. Known gaps, deliberately left

- **No GA4 and no Meta Pixel.** `site.json` → `analytics` is `{ga4: null, metaPixel: null}`; another agent owns
  those fields and this file does not touch them. Until GA4 exists there is no way to see which pages convert
  into a WhatsApp click — only which pages get impressions.
- **Sitemap carries no `lastmod` and no `x-default`.** The HTML carries `x-default` correctly, which is what
  Google reads, so that part is cosmetic. `lastmod` would help Google re-crawl changed listings sooner, but it
  needs a per-listing modified date that the listing data does not yet carry.
- **No `bona.sa` domain.** Prior research established `bona.sa` is registrable by a Saudi natural person with a
  national ID, while `bona.com.sa` needs a CR or trademark. Not required — `bona-real-estate.com` is live and
  should not be moved again. Moving domain twice in one quarter is how sites lose rankings.
