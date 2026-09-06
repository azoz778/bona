# listings.json — contract shared by all agents (do not change shape without updating every consumer)

Array of listing objects:

```jsonc
{
  "id": "BONA-001",                 // stable, unique
  "slug": "beachfront-villa-durrat-al-arous",   // URL-safe, unique, English
  "sourceRef": "DAR-01",            // TK reference (optional)
  "status": "available",            // available | reserved | sold
  "category": "buy",                // buy | rent | off-plan | international
  "type": "villa",                  // villa | apartment | penthouse | mansion | land | building | duplex
  "featured": true,                 // show on home page (aim for 6–9 featured)
  "title": { "en": "Private Beach Villa, Durrat Al Arous", "ar": "فيلا بشاطئ خاص، درة العروس" },
  "location": {
    "district": { "en": "Durrat Al Arous", "ar": "درة العروس" },
    "city": { "en": "Jeddah", "ar": "جدة" },
    "country": { "en": "Saudi Arabia", "ar": "المملكة العربية السعودية" },
    "countryCode": "SA"
  },
  "price": {
    "amount": 8000000,              // number or null
    "currency": "SAR",              // SAR | AED | EUR | USD | OMR
    "from": false,                  // true => "From SAR 1,700,000"
    "period": null,                 // null | "year" | "month" (rent)
    "onRequest": false              // true => "Price on request" (amount may be null)
  },
  "specs": { "beds": 5, "baths": 6, "areaSqm": 537, "plotSqm": null, "yearBuilt": null, "floors": null },
  "images": [
    { "src": "https://tk-storage.azoz.uk/tk-estate-media/media/<folder>/<file>", "thumb": "https://tk-storage.azoz.uk/tk-estate-media/website-thumbs/<file>.webp", "alt": { "en": "...", "ar": "..." } }
  ],                                // images[0] is the hero; 4–10 images
  "description": { "en": "2–4 short paragraphs", "ar": "..." },
  "highlights": { "en": ["Private beach", "..."], "ar": ["شاطئ خاص", "..."] },
  "virtualTourUrl": null,
  "brochureUrl": null,
  "videos": [],                     // optional; hosted video URLs (walkthrough clips) — see "Videos" below
  "listedAt": "2026-06-01"
}
```

Rules: prices are asking prices from TK only (never an estimate — TAQEEM rule). Arabic must be real Arabic, not transliteration. Every listing needs at least 4 images with working URLs (HEAD 200).

## Round 2 additions (2026-09-05 17:00)
- `kind`: `"house" | "apartment" | "land" | "building"` — REQUIRED on every listing. Derived from `type`: villa/mansion/duplex/palais → house; apartment/penthouse → apartment; land → land; building → building. The site has separate Houses and Apartments sections driven by this field.
- `virtualTourUrl`: full Matterport URL (`https://my.matterport.com/show/?m=<modelId>`); the site embeds it inline. `scripts/sync-listings.mjs` also syncs this field from TK's API (`virtual_tour_url`).
- Optional `project`: `{ "name": {en,ar}, "developer": {en,ar} }` for units inside a development (e.g. Kian Residence units).
- Optional `unit`: `{ "floor": "1st" | number | null, "block": string | null, "unitRef": string | null }`.
- Optional `map`: `{ "lat": number, "lng": number }` (land plots); land images may be satellite stills.

### Round 2 as implemented (2026-09-05, data agent)
- `kind` is emitted by `scripts/curate/build.mjs` from `type` and enforced by `validate.mjs` (a `kind` that disagrees with `type` fails).
- `project`, `unit`, `map` are always present in the JSON, `null` when not applicable (consumers can test truthiness).
- **Land listings** (`kind: "land"`): `map` is REQUIRED and must be the exact plot pin (never a district-level pin); `specs.plotSqm` required; `images` may be 1–10 and each `src` may be a site-local still `"/land/<PLOT-ID>.jpg"` (served from `public/land/`, `thumb: null`) produced by `scripts/curate/land-stills.mjs` from TK's Esri tile proxy — `images[0]` is z=17 (the plot), `images[1]` is z=15 (context). The z=17 frame carries a small ring at the pin. Consumers must not prefix these with a CDN host.
- **Image sharing**: images are unique across listings EXCEPT between listings that share the same `project.developer.en` (units of one development legitimately reuse the developer's renders). `images[0]` (the hero) is unique across the whole file, so a project's units never render identical cards.
- **Units**: `project.name` matches the parent project page's `title` when the unit belongs to that named project (Kian Residence units in Al Nahda → `kayan-residence-al-nahda`). Units in the same developer's other buildings carry their own `project.name` (e.g. "Kian Al-Masiah — Building 113, Al Nuzhah") and link by `project.developer`. `unit.unitRef` is the TK unit id (also `sourceRef`), `unit.block` the building number, `unit.floor` the floor(s) offered as a string (e.g. `"1st, 2nd or 3rd"`).
- `virtualTourUrl` must be a full `https://my.matterport.com/show/?m=<id>` URL; `scripts/sync-listings.mjs` fills it from the API when local is null and never clears a local value.
- IDs are positional (`BONA-###` = index+1 in `listings.source.mjs`): new listings are appended at the END of the array, never inserted.
- Curation helpers: `node scripts/curate/contact-sheet.mjs <gallery-folder> <out.jpg>` (labelled index sheet) and `node scripts/curate/land-stills.mjs <PLOT-ID> <lat> <lng>`.

## Publication rule (owner, 2026-09-05 20:45)
Only listings whose `sourceRef` exists in TK's live public API (scripts/tk-public-properties.snapshot.json, refreshed from https://dashboard.azoz.uk/api/public/properties) AND whose API status is available are written to listings.json. `scripts/curate/build.mjs` enforces it; anything from the old TK website that is not in the live list is excluded.

### Round 3 as implemented (2026-09-05, data agent)
- Land plots: every `available` LND in the live list that has an exact pin is published (15 plots). Pins for LND-007…024 come from the saved land-register source page `C:\Users\ASUS\TK-LAND-REGISTER-source-2026-08-25.html` (`const PROPS` lat/lng — the values `scripts/import-land-register.js` in the TK repo wrote into `properties.amenities.land`, which the register's gated `/api/public/land/details` serves). LND-004/006 keep their Google-Maps-link pins. **Skipped for lack of a pin: LND-016, LND-019, LND-021** (empty lat/lng at source → null in prod); LND-009/018 are sold.
- Land copy uses only the API `description`/`description_ar` plus the register's tiles (frontages, deeds, street widths, permitted use). LND-024 is priced per 300 sqm plot (`price.amount` = per-plot price, `specs.plotSqm` = 300).
- VIL-043 (Wadi Safar / Rayana mansions) is NOT published: only 2 tk-storage images exist (gallery folder `wadi-safar-trump-mansions-rayana-mansions`); the API/TK-page images are on `le-de.cdn-website.com`, which the MEDIA rule rejects.
- Featured = exactly 8 published listings: 5 houses, 2 apartments, 1 land plot (LND-011, the Corniche waterfront still).

## Land (owner decision 2026-09-05 21:00)
Land plots are curated (13 in listings.source.mjs, stills in public/land/) but NOT published: `LAND_PUBLIC = false` in build.mjs. Share plot details only on enquiry. The /properties/land/ route is not generated while there are no land listings.

## WhatsApp intake (2026-09-05, `services/intake`)
The owner publishes a listing by dropping a property brochure PDF into a WhatsApp group whose
subject contains "Bona". `services/intake` reads it from his own Evolution instance, extracts the
text and photos, has `claude -p` write the copy and rank the photos, and writes the result into
this repo. Nothing else in the pipeline changes.

- **Where the listing lives**: `scripts/curate/inbox/<slug>.json` — one file per listing, holding
  the FINAL listing object (not a `listings.source.mjs` entry). `scripts/curate/build.mjs` appends
  every inbox file to `listings.json` **after** the TK live-list filter. Intake listings are
  owner-authored, not TK stock, so they are **exempt from the TK publication rule** above.
  `scripts/curate/inbox/_index.json` holds `{ nextSeq, listings }` — the `BONA-W###` counter.
- **`id`**: `BONA-W###` (W = WhatsApp), allocated from `_index.json` and never reused. Curated
  listings keep their positional `BONA-###`. `validate.mjs` accepts both.
- **Two intake-only fields, stripped by `build.mjs` and never present in `listings.json`**:
  - `hidden: true` — keep the listing out of the site without deleting it (`hide`/`show` commands).
  - `_intake: { source, messageId, groupJid, pdfSha256, pdfFileName, caption, model, confidence,
    warnings, images[], createdAt, site }` — provenance, so a listing can always be traced back to
    the WhatsApp message and the PDF that produced it. `warnings` is an array of **codes** from a
    fixed vocabulary (`not-enough-photos`, `price-not-printed`, `brochure-too-large`,
    `brochure-failed`, `images-skipped`, `model-flagged`) and never free text: the model's own
    `warnings` are model output about an untrusted document, so they stay in the run's `ai.json`
    and are not committed.
  A `status: "sold"` intake listing stays published and renders with the Sold badge.
- **Images**: stored in this repo at `public/listings/<slug>/<nn>.jpg` (max 1920 px, q82, EXIF
  stripped) with `<nn>-thumb.webp` (640 px). `src` and `thumb` are therefore site-local paths, and
  `validate.mjs` accepts `/^\/(land|listings)\/[A-Za-z0-9-]+(?:\/[A-Za-z0-9-]+)?\.(jpg|webp)$/`
  for both (`/land/` stills remain land-only). Consumers must not prefix them with a CDN host —
  `ListingCard`, `Gallery` and `Head` already pass them through, and `lib/seo.ts::absoluteUrl`
  turns `/listings/<slug>/01.jpg` into a full `https://bona.azoz.uk/...` OG image.
  `images[0]` is the hero, exactly as for curated listings. 4–10 images; a PDF that yields fewer
  than 4 usable photographs is rejected rather than published thin.
- **`sourceRef`**: `WA-<yyyymmdd>-<6 chars of the WhatsApp message id>`. It is deliberately NOT a
  TK reference, and `build.mjs` never looks it up in the TK API.
- **`brochureUrl`**: `https://bona.azoz.uk/listings/<slug>/brochure.pdf` — the **default** for an
  intake listing, not an opt-in. The brochure at that path is not the developer's file: it is
  their document re-published under Bona's branding by `services/intake/rebrand_pdf.py`, with a
  Bona cover in front of it, a footer strip (`bona.azoz.uk · +966 59 329 6933 · FAL 1100313556 ·
  <id>`) on every one of their pages and a closing *Enquire* page carrying the listing URL, a QR
  of it, the WhatsApp link, the opening hours and the licence line. Their own pages and branding
  are left exactly as they are; nothing Bona adds may carry another agency, and any listing fact
  that holds a rival broker, a phone number, an email or a link is dropped rather than printed.
  It is `null` when the owner captioned the PDF `#nobrochure`, or when the branded file could not
  be built or could not be squeezed under `BONA_MAX_BROCHURE_MB` (25 MB) — the listing then also
  carries `brochure-failed` or `brochure-too-large` in `_intake.warnings`, and `brochure <id>` in
  the WhatsApp group rebuilds it. `validate.mjs` still requires an https URL or `null`, so the
  value is absolute even though the file is site-local like the photos.
- **Price**: TAQEEM still applies, and the model's word is not enough. The number must appear in
  the PDF's text layer or in the caption (`services/intake/lib/price.mjs` allows thousands
  separators, Arabic-Indic digits and the `4.5m` / `مليون` forms); for a PDF with no text layer
  the model must cite `priceEvidence: { page, quote }` and a second `claude -p` must confirm it on
  that page image. Anything else becomes `price.onRequest = true`, `price.amount = null`. The
  intake never estimates.

## Videos (2026-09-06, `services/intake`)
A PDF never arrives with a video attached to the same WhatsApp message — a video is added to a
listing that already exists, one clip per message: send the video into the intake group with the
listing's id somewhere in its caption (`video BONA-W001`, or just `BONA-W001`) and it is downloaded
and added, no re-publish command needed. Up to `services/intake/lib/video.mjs::MAX_VIDEOS` (4)
per listing.
- `videos`: always an array on a WhatsApp-intake listing (`[]` until a video is added); optional
  and may be absent on a curated listing that predates this field. Every entry is either a
  site-local path `/listings/<slug>/v-<nn>.mp4` (intake videos: numbered on their OWN sequence,
  separate from `<nn>.jpg` photos, written to `public/listings/<slug>/` and served by GitHub
  Pages exactly like the photos) or a full `https://` URL (for a future non-intake source).
  `scripts/curate/rules.mjs::LOCAL_LISTING_VIDEO` is the local shape; `validate.mjs` and the
  intake's own `checkListing()` share it.
- **Stored as received — no transcoding, no thumbnail.** This service's only media library
  (`sharp`) does not read video; adding one would mean a new native dependency (ffmpeg) for a
  narrow feature, so the video committed to the repo is exactly the file WhatsApp handed over.
  `BONA_MAX_VIDEO_MB` (default 60) caps what is accepted. **Follow-up, not yet built**: raw
  video committed straight into git will bloat the repo as more are added — if that becomes a
  real problem, look at Git LFS or moving intake video (like intake photos today) to a real
  object store instead of the git-and-GitHub-Pages path used now.
