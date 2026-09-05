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
