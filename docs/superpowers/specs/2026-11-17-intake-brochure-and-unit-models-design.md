# Intake: unit models on the site + a Bona brochure rebuilt from scratch — design

Date: 2026-11-17 · Owner decisions taken in chat the same day · Branch `feat/intake-brochure-models`

## Why

The owner sent the Jeddah Heights brochure (BONA-W023): eight apartment models, each with its own area,
rooms, floor plan and two printed prices. After PR #68 the listing shows one headline price and a
Sakani line, but:

- the website does not show the eight models, their sizes or their prices;
- the "branded brochure" the intake publishes is the developer's own PDF with a plain Bona cover, a
  footer strip and a QR page — every developer logo and the developer's sales contacts are still on it.

The owner wants a professional Bona brochure that lists everything, built the same way on every run,
and the same treatment for every listing already published from a WhatsApp PDF.

## Owner decisions (2026-11-17)

1. **Rebuild the brochure from scratch.** Reuse only the developer's photographs and floor plans; none
   of their pages, logos or contact details.
2. **Design: the TK brochure system** (`tk-property-brochure` skill: black and white, A4 portrait,
   Cormorant Garamond / Montserrat / Amiri / Tajawal, 0.4pt hairlines, 20mm margins), branded Bona.
3. **One bilingual PDF**, English left and Arabic right on every page, as TK does. (This replaces the
   earlier "two PDFs" answer, which the owner revised after seeing the TK-style sample.)
4. **Developer named as text** ("Developer: Araco"), never as a logo.
5. **Backfill every intake listing** (BONA-W###) with unit models and the new brochure.

## Scope

In: intake extraction of unit models and supporting facts; their TAQEEM check; floor-plan images;
listing schema + validators; a "Residences & prices" section on the listing page; the new brochure
generator; pipeline + `brochure <id>` + `run-once` wiring; a backfill path that keeps hand-corrected copy.

Out: curated listings (BONA-0xx — not from PDFs), the daily social posts, Dana's inventory API (they read
`price` only and keep working), redesigning the listing page itself.

## 1. Data: what the model extracts

New optional fields in the AI contract (`services/intake/lib/prompt.md`, `validateAiResult`):

```jsonc
"models": [                         // one entry per unit model / layout the brochure prints; [] when none
  { "name": { "en": "Nawras 2", "ar": "نورس 2" },
    "bedrooms": 3, "bathrooms": 2,  // null when not printed
    "areaSqm": 105.02,              // null when not printed
    "rooms": { "en": ["Laundry"], "ar": ["غرفة غسيل"] },   // other rooms printed for the model
    "availability": { "en": "Buildings G–P, first to seventh floor", "ar": "المباني G–P، من الأول إلى السابع" }, // or null
    "price": 419994, "subsidisedPrice": 356024,            // null when not printed
    "evidence": { "page": 10, "quote": "419,994 / 356,024" },  // REQUIRED when any price is set
    "floorPlan": 14 }               // candidate index of its floor plan, or null
],
"amenities":  { "en": ["Health club", …], "ar": ["نادٍ صحي", …] },      // same length; [] when none
"nearby":     { "en": ["King Abdulaziz International Airport", …], "ar": [...] },
"warranties": { "en": ["Structure — 10 years", …], "ar": [...] }
```

Rules (prompt + validator): names and lists bilingual with equal lengths; every string passes
`copyProblems` (no agency, phone, hype, price in prose); at most 24 models, 16 amenities, 8 nearby,
8 warranties; `floorPlan` must be the index of an extracted candidate that the ranking EXCLUDED (floor plans
never enter the gallery) and is used by at most one model; a model price obeys the same "printed, never
estimated" rule as `price`.

**Headline price consistency:** after the TAQEEM step (§2), when any model keeps a confirmed price, the
pipeline sets the headline from the models — `price.amount` = the lowest confirmed model `price` with
`from: true`, `price.subsidisedAmount` = the lowest confirmed `subsidisedPrice` (or none) — and the
validators require exactly that on the final listing, so the "From" figure and the table can never disagree.
(Both are printed figures; "lowest printed starting price" is already the project-price rule.) No caption
price may coexist with model prices from the brochure: under a caption price the model prices are dropped.

## 2. TAQEEM for model prices

Every model price is published only when printed. Text-layer match → accepted only if the figure is in
the plain (non-subsidy) text; otherwise the page is rendered (`price-pages.mjs` already renders pages with
price words, scrambled figures or subsidy wording) and a second model confirms. To keep the cost flat, the
confirmation is **one call per page**: "does this page print each of these figures as the price (or the
subsidy beneficiaries' price) of the named model?" → `{confirmed: [{model, price: bool, subsidisedPrice: bool}]}`.
An unconfirmed figure is set to null (the model stays, marked "on request"); if every model price is gone,
the headline follows the existing rules. The refused-price copy guard covers model figures too.

## 3. Floor plans and the extraction fix

`extract_pdf.py` extracts embedded images without their soft mask, so transparent floor plans come out on
black (seen on W023). Fix: apply the image's SMask (`fitz.Pixmap(pix, mask)`) and flatten onto white
before writing the candidate. Published as `public/listings/<slug>/plan-NN.jpg` (white ground, ≤1600px,
q85) + `plan-NN-thumb.webp`; `models[i].floorPlan` in the listing becomes `{ src, thumb }`.
Floor plans never enter the photo gallery (unchanged: the ranking still excludes them).

## 4. Website

`ListingPage.astro` gets a **Residences & prices** section (new `UnitModels.astro`) when `models` is
non-empty, placed after the description, EN + AR:

| Layout | Bedrooms | Bathrooms | Area | Price | Sakani price | Plan |

- One row per model; "Price on request" for a null figure; the Sakani column only when any model has one.
- The plan thumbnail links to the full-size plan image (opens in a new tab).
- Mobile: rows become stacked cards (name, area, rooms line, prices, "View plan").
- The headline price and Sakani line stay as they are (they equal the table's lowest figures).
- `rules.mjs` gets `modelsProblems(listing)` used by `checkListing` and `validate.mjs`; `listings.ts` types.

## 5. The brochure

New `services/intake/brochure_pdf.py` (WeasyPrint + segno + Pillow, run through `uv` like the other
scripts), replacing `rebrand_pdf.py` in the pipeline. Input: the final listing JSON + the listing's
published files; output `public/listings/<slug>/brochure.pdf`. Fonts (OFL) copied into
`services/intake/assets/fonts/`. Logo: `public/logo.svg` recoloured pure black / pure white.

Page order (fixed canvases, TK geometry):

1. **Flysheet** — black, white Bona wordmark, "Exceptional homes, quietly" / "منازل استثنائية، بهدوء".
2. **Cover** — hero photo full-bleed (its `focus` as background-position), eyebrow (type · category),
   title EN + AR, meta line (district · city · From price | Arabic).
3. **The property / The project** — bilingual narrative in two columns; text that does not fit continues
   on a second narrative page (never overflows into the ledger); ledger: up to 6 cells from specs or, for
   projects, models count, bedroom and bathroom ranges, smallest/largest area, warranty.
4. **Residences & prices** — the model table (bilingual headers), paginated at 10 rows; note on where
   prices come from and what the Sakani price means. Only when `models` is non-empty.
5. **One page per model** — name EN + AR, floor plan plate, ledger (area, bedrooms, bathrooms), terms row
   (price, Sakani price, availability). Only models with a floor plan get a page; the table lists all.
6. **Photo pages** — hero + pair (or quad), captions from the room keys, "Illustrative" where the listing's
   photos are developer renders. Every published photo appears once.
7. **Amenities & terms** — amenities / nearby / warranties lists (bilingual rows), terms row (from price,
   Sakani from, developer). Omitted when all three lists are empty.
8. **Location & enquiries** — QR to the listing page, facts (district, nearby, reference + FAL), "View on
   bona-real-estate.com" (or Google Maps when the listing has an exact pin), black enquiry block: phone /
   WhatsApp, email, hours (site.json), white logo.

Rules: black and white only (photos in colour); Western digits everywhere; every number from the listing,
never computed except ranges (min–max of printed values); no developer logo, phone, email, URL or address;
the developer named only as "Developer: <name>"; footer: black Bona mark + "Jeddah · page n". Size target
1.5–4 MB (photos at ~300dpi of printed size); hard cap stays `BONA_MAX_BROCHURE_MB`.

Failure: as today — a brochure that cannot be built never costs the listing (`brochure-failed`).

## 6. Pipeline wiring

- `processPdf`: builds the brochure from the final listing (after `checkListing`), same staging/rollback.
- `brochure <id>` (WhatsApp) and `edits.rebuildBrochure`: rebuild from the listing + repo files only — no
  source PDF needed any more.
- `run-once --replace` unchanged; new **`run-once <pdf> --enrich <id>`** for the backfill: runs the AI and
  TAQEEM steps, then writes ONLY `models`, `amenities`, `nearby`, `warranties`, floor-plan files and the new
  brochure into the existing listing (title, copy, photos, price kept — they may be hand-corrected); refuses
  when the model's headline price disagrees with the listing's current `price` (prints both, changes nothing).
  Same clean-clone / lock / commit-push rules as `--replace`.

## 7. Backfill

A script lists every inbox listing, finds its source PDF by `_intake.pdfSha256`, and runs `--enrich` one
at a time (Opus, ≈$1 each, ≈20 listings). Listings without a source PDF or with no models get only the new
brochure (`brochure <id>` path). A dry run first prints what each listing would gain.

## 8. Testing and review

Unit tests for the contract, validators, headline consistency, per-page confirmation, floor-plan
extraction (SMask), the brochure builder (page count, no developer strings, every model price present,
bilingual pairs, size), `--enrich` field isolation; site test for `UnitModels`. A real dry run on W023
and one single-property brochure. Two-model review (Claude + Codex) until both say SHIP.

## 9. Rollout

PR → owner merges → pull `~/bona`, restart `bona-intake` → `run-once --enrich BONA-W023` → check live →
backfill the rest → check a sample live. Rollback: revert the PR; listings keep their old fields (the new
ones are optional) and the old brochures can be rebuilt with the previous code.

## 10. Decisions made during the build (2026-11-17)

- **One bilingual PDF** (the owner revised the earlier two-file idea): English and Arabic in the same brochure.
- **Model prices are always confirmed on the page image**: no text-layer shortcut, since a price table puts every model's figures in the text.
- **Page cap 12, concurrency 3** for the per-page confirmation (`BONA_MAX_MODEL_PRICE_PAGES`).
- **Enrich headline rules**: the owner-set price is kept and model prices are cleared; a price on request adopts the models' lowest; an existing price must match the models' lowest or the run is refused; `from: true` is set when they are equal.
- **Floor plans are flattened on white** (the SMask fix), so transparent plans do not print black.
- **Arabic bracket font fix**: Amiri is restricted with `unicode-range` so brackets and digits do not fall into the wrong font.
- **Copy rules extended**: Saudi phone formats (including Arabic-Indic digits), URLs, emails, handles and domains are all rejected from generated copy.
- **Off-plan photos are labelled "Illustrative"**.
- **Floor-plan contact check (owner, 2026-11-21)**: every plan image is checked by a second model for a phone, email, website, social handle, QR code, logo / brand name or price before it reaches the repo; a flagged or unclear plan is left out (never blocking the listing), and a check that cannot finish publishes without plans (retryable on `--enrich`).
