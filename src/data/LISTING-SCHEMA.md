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
