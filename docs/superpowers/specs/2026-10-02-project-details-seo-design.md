# Project details block + per-listing FAQ (SEO audit rec. 1) — design

Date: 2026-10-02 · Owner-approved in chat · First listing: Darco Prime Waterfront (BONA-W014)

## Why

OpenSEO audit (Oct 2, 2026, report 0ccfa15e) found the named-project pages carry ~120 words of
their own text, while people search the project names directly (داركو برايم ≈210 SA searches/mo,
برج ترامب جدة ≈1,000, داري كيو ≈140). The results that rank are social posts and thin
classifieds. Bona was not in the first 20 for any of them. The lead fix is to make each project
page the most complete, factual answer for its name.

Owner decisions (chat, 2026-10-02):
- Darco Prime first. Trump Tower / Dari II / Dari Q wait for the developer documents.
- Unit sheet shown as a **summary by type**, not the 111-row list.
- **Cash prices only.** The sheet's other three price columns (half / year / twoYear) are not
  explained anywhere on disk, so they are not published. One line says instalment plans exist
  and are available on request.

## Facts allowed on the page (TAQEEM / never-invent rule)

Only from:
1. `src/data/units.json`, built from the developer's own inventory sheet dated 2026-09-02:
   unit count, beds, class, area, cash price, delivery `2028-06`, developer name, district.
2. The developer's brochure already published at `/listings/darco-prime-waterfront-al-shati/brochure.pdf`:
   22 buildings, 534 units, gym, infinity pool, yacht club five minutes away.

Nothing else: no ROI, no market claims, no plan terms, no availability beyond the sheet date.

## Components

### 1. `src/lib/units.ts` (new, pure)
- `unitsFor(listingId)` → the `units.json` record for that listing, or `null`.
- `unitSummary(record)` → one row per **bedroom count** (1, 2, 3) for every class except
  `Penthouse` (Standard, Premium, The Jewel and roof apartments all fold into their bedroom row),
  then one **Penthouse** row for class `Penthouse` whatever its bedrooms (label shows the bed range,
  e.g. "Penthouse, 1–2 bed"). Today: 1 bed (64), 2 bed (35), 3 bed (9), Penthouse (3) = 111.
  Each row: `{ key, label{en,ar}, count, areaMin, areaMax, cashFrom }`.
  Sorted by beds. Totals: `{ count, areaMin, areaMax, cashFrom, delivery, updated }`.
- `sheetAgeDays(record, now)` → integer days since `updated`.
- No I/O beyond the static JSON import, so it unit-tests with `node --test`.

### 2. `src/components/ProjectDetails.astro` (new)
Rendered by `ListingPage.astro` after "Highlights" only when `unitsFor(l.id)` is non-null.
- `h2` "Units and prices" / "الوحدات والأسعار".
- Table: Type · Area (sqm) · From (cash) · Available. Numeric columns use `formatNumber` /
  `formatPrice`, and the Arabic version renders RTL with the same order.
- Note under the table: "Cash prices from the developer's unit sheet dated 2 September 2026.
  The developer also offers instalment plans; ask us for the schedule." (+ Arabic).
- "Key facts" `dl`: Developer · Handover (June 2028) · Units available (111 of 534). The "of 534"
  appears only when the listing's `projectFacts.totalUnits` is set.

### 3. Optional listing fields (inbox JSON / listings.json)
- `faq`: `{ id, q{en,ar}, a{en: string[], ar: string[]} }[]`, 3–8 items.
- `seoTitle`: `{ en, ar }`, which replaces the auto-built `metaTitle` when present.
- `projectFacts`: `{ totalUnits?: number, buildings?: number }`, brochure-sourced counts.
`build.mjs` passes them through (it already spreads the inbox object). `validate.mjs` checks the
shapes, rejects empty strings and requires both languages.

### 4. FAQ section + JSON-LD
- `ListingPage` renders the FAQ (`h2` "Questions" / "أسئلة شائعة", `h3` per question, anchor
  `#faq-<id>`) after the project details.
- JSON-LD: a **separate** `FAQPage` node with `@id = <url>#faq`, so it does not replace Head's
  automatic `ItemPage` node, which shares the page `@id`. New helper `listingFaqJsonLd(listing, locale)`
  in `seo.ts` reuses the answer-escaping of `faqPageJsonLd`.
- Note: Google shows FAQ rich results only for a few authority sites. The value here is the
  on-page answers and answer-engine citation, not a SERP feature.

### 5. Darco Prime content (inbox `darco-prime-waterfront-al-shati.json`)
- `seoTitle`: en "Darco Prime Waterfront Apartments for Sale, Al Shati Jeddah",
  ar "شقق داركو برايم للبيع، الشاطئ جدة". (Head appends the brand.)
- `projectFacts`: `{ totalUnits: 534, buildings: 22 }`.
- `faq` (5 items, every answer traceable to the sheet or brochure): developer; handover date;
  unit sizes and bedrooms; starting cash price + sheet date; instalment plans (exist, ask us).

## Staleness guard
`validate.mjs` fails CI when a `units.json` record's `updated` is older than **90 days**. Prices
cannot sit on the site silently out of date. The owner refreshes the sheet, or the record is
removed and the block disappears.

## Error handling
- No units record → no block (all other listings unchanged).
- A record whose units array is empty → no block.
- Missing Arabic in `faq`/`seoTitle` → validator fails (both languages are required).

## Testing
- `scripts/test/units.test.mjs`: grouping, folding of Penthouse/Jewel, min/max/from maths on a
  fixture, sheet-age maths, and the real `units.json` Darco record producing ≥3 rows.
- Validator tests for `faq` / `seoTitle` / `projectFacts` shapes and the 90-day rule.
- `test/seo-jsonld.test.mjs` (dist): the Darco page in both locales has a `FAQPage` node with
  `@id …#faq`, still has its `ItemPage` + `RealEstateListing`, the title tag equals the
  `seoTitle` + brand, and the units table renders with the sheet-date note. A listing without
  units has no table and no FAQ node.
- Live check after deploy: both URLs 200; Google Rich Results / schema parse via curl + JSON parse.

## Out of scope
Trump Tower / Dari II / Dari Q content (waiting for developer docs); the backlink work (rec. 2,
an owner checklist); category-page retitles (audit runner-up); the full 111-unit list.

## Ship
Branch `feat/project-details` → PR → Claude + Codex review → CI green → merge (Developer
autonomy rule) → record the rollback commit → verify live → notify the owner.

## Amendment 2026-10-02 (owner): warn, never hide
After launch the owner decided an old sheet must stay on the page ("it can warn me, but not disappear").
`isSheetCurrent` now only rejects an impossible or future date; age produces validator warnings from day 76
and a Google Calendar reminder for the owner. The table always prints the sheet date. A listing that is not
`available` still hides the block.
