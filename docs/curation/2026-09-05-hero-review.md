# Hero-image review — every Bona listing, 2026-09-05

Owner's brief: *"the website's images are not all done correctly — the best image should be
the first image people see."*

**What was done.** Every gallery folder behind every non-land listing was rendered as a
labelled contact sheet and looked at frame by frame — 1,086 photographs across 36 folders,
not just the ones already in the listing. Each listing then got a hero and an ordered set of
6–10 images chosen against the new house standard, [`scripts/curate/IMAGE-RUBRIC.md`](../../scripts/curate/IMAGE-RUBRIC.md).
Close hero calls were opened at full resolution before deciding.

| | |
|---|---|
| Listings reviewed | **45** (all non-land; the 15 land plots are untouched by design — their satellite stills are the correct first frame) |
| Heroes changed | **26** |
| Galleries reordered or re-cut | **45** |
| Published on the site today | 26 listings, of which **16 have a new hero** |
| Featured (home-page slideshow) | 7, of which **4 have a new hero** — BONA-001, 004, 005, 006 |
| Validator | `validate.mjs --head` green — 322 image URLs HEAD-checked, 0 failures |

Eyeball every change in one image: [`hero-before-after.jpg`](hero-before-after.jpg) (old hero left, new hero right).
Machine-readable record of every decision: [`decisions.json`](decisions.json).

---

## The five changes that matter most

1. **BONA-005 Contemporary Villa, Al Khalidiyah (featured, home slideshow).** Led with a tight
   daylight crop of a courtyard pool wall — a detail, not a house. Now the whole villa lit at
   night, centred and crop-safe. On a 111-photo folder this was the single biggest miss.
2. **BONA-001 Private Beach Villa, Durrat Al Arous (featured, home slideshow).** The old hero
   had a drone sitting on the pool deck and a water jet slicing the right edge. Now the villa
   at twilight seen from its own beach, lit steps dead centre — the frame that says
   "private beach villa" without a word of copy.
3. **Cars, watermarks and other people's branding removed from the first frame.** Six listings
   led with, or carried, a photograph whose subject was a parked car (BONA-024's hero was a
   silver SUV; BONA-044's a carport with two cars; BONA-018 and BONA-021 had night street shots
   built around parked cars). BONA-031 carried a frame stamped **`tkestate.sa`** and BONA-012 a
   street shot with the developer's **"ayan"** advertising banner. BONA-027's hero carried a
   **"Marriott AIDA Oman" text overlay**. All gone.
4. **The eleven Kian Al-Masiah listings no longer look like one listing repeated.** They share a
   single 19-photo folder, so each now leads with a different frame — day exterior, night
   façade, lobby, café terrace, roof terrace, gym, coffee bar, the double-height void, the
   view window, the covered entrance — and none leads with a kitchen or a bedroom any more
   (three did). In a grid of cards they now read as eleven different homes.
5. **Room keys that were simply wrong.** BONA-002 labelled a grand piano "majlis" and a
   staircase "bedroom"; BONA-018 labelled a car-park-and-towers view "sea view"; BONA-017
   labelled a tiled roof terrace "façade at night". Alt text is what a screen reader and Google
   read, so these were corrected across the file.

## Patterns fixed across the inventory

- **Twilight beats noon.** Fourteen listings owned a blue-hour or golden-hour frame of the same
  façade the old hero showed in flat midday light. Where the twilight frame was sharp, it won
  (BONA-004, 006, 008, 010, 014, 015, 017, 018, 019, 021, 034 …). The daylight frame stays as
  image two, which is exactly the contrast the rubric asks for.
- **A pool or a view outranks a façade; a façade outranks any interior.** Applied consistently —
  BONA-007 and BONA-043 moved from a building elevation to the pool; BONA-027 from a branded
  render to the tower-with-pool; BONA-013 (a penthouse with no exterior of its own) to the widest
  reception with the city through the corner glazing.
- **No bathroom, plan or text slide in the first five images.** BONA-045 had a bathroom at
  position 5; BONA-009 had two bathrooms back to back. Bathrooms are now one per listing at
  most, and always late.
- **Near-duplicates removed.** Same room, same angle, one stop apart — kept the better frame only
  (BONA-030, 031, 011, 004 …). Galleries got shorter and better rather than longer.
- **Aerials close the set** instead of sitting at position 2 or 4 (BONA-029, 030, 032, 043, 045).
- **People and lifestyle stock are out of property galleries** (BONA-023's café courtyard with
  diners; the crowded "golden cube" landmark in BONA-032). Neighbourhood stock — a Tiffany
  shopfront, the F1 circuit, a Starbucks car park — was already excluded and stays excluded.
- **A real photograph beats a render when both exist.** BONA-013 now shows the actual building
  at position 2 instead of the developer's CGI.

## Where the material fights back

Three galleries are genuinely thin and the result is only as good as the photography allows:
**BONA-020** (17 frames, a dated terracotta pool deck is still the best outdoor asset),
**BONA-014** (19 frames, mostly identical empty beige rooms, so two bathrooms sit at the tail),
and **BONA-042** (the last Kian unit, which gets the building's covered entrance because the
ten better frames are already other units' heroes). New photography would move these more than
any re-ordering can.

## Per-listing table

★ = featured on the home page · `·hidden` = curated but not published today (not in TK's live
list, or sold). Index numbers are positions within the listing's gallery folder, matching
`scripts/curate/contact-sheet.mjs` output.

| ID | Listing | Old hero | New hero | Changed | Why |
|---|---|---|---|---|---|
| BONA-001 | `private-beach-villa-durrat-al-arous` ★ | 13 · pool | **23 · facade_night** | **yes** | Twilight frame of the villa seen from its own beach, lit steps dead centre — beats the hazy day pool (13), whose deck carries a drone and a water jet cutting the right edge. |
| BONA-002 | `classic-mansion-al-shati-6` ★ | 27 · pool | **27 · pool** | no | Kept: pool, palms and the arcaded façade in one clean daylight frame is already the best in the folder; the gallery below it was rebuilt (a piano close-up was labelled majlis, a staircase was labelled bedroom). |
| BONA-003 | `andalus-mansion-jeddah` ·hidden | 6 · pool | **6 · pool** | no | Kept: pool with the mansion and palms behind is the only wide exterior that sells the house; dropped the street frame with the road in the foreground. |
| BONA-004 | `private-villa-al-murjan` ★ ·hidden | 6 · exterior | **2 · facade_night** | **yes** | Blue-hour façade with lit boundary wall and glowing pool — the day frame (6) is lower resolution, has a blown sky and a car at the edge. |
| BONA-005 | `contemporary-villa-al-khalidiyah` ★ | 8 · pool | **16 · facade_night** | **yes** | The whole villa lit at night, centred and crop-safe, states "ultra-modern villa" instantly; the old hero was a tight daylight crop of the courtyard pool wall. |
| BONA-006 | `modern-villa-al-zahra` ★ ·hidden | 0 · pool | **27 · pool** | **yes** | Rooftop pool at dusk with the lit waterfall — golden hour beats the flat midday pool (0) with its patchy deck. |
| BONA-007 | `rooftop-view-villa-al-mohammadiyah` ·hidden | 6 · exterior | **8 · pool** | **yes** | Pool filling the courtyard with the glazed façade above and no cars in frame; the old hero (6) was a low water-level angle with barely any sky. |
| BONA-008 | `timber-villa-al-mohammadiyah` ·hidden | 9 · exterior | **34 · facade_night** | **yes** | Warm-lit timber façade at dusk — the signature of a "timber-detailed" villa; the old day frame was a snapshot with wires. |
| BONA-009 | `garden-facing-villa-al-sheraa-north-obhur` ★ ·hidden | 38 · pool | **38 · pool** | no | Kept: dusk pool with the lit entrance canopy behind is the strongest frame in a 49-photo folder; the two back-to-back bathrooms and the bare roof deck were replaced. |
| BONA-010 | `modern-villa-south-obhur` ·hidden | 3 · facade_night | **3 · facade_night** | no | Kept: dusk façade; added a cleaner daylight architectural frame (13) as the second image. |
| BONA-011 | `villa-near-the-corniche-al-lulu-obhur` ·hidden | 5 · pool | **39 · exterior** | **yes** | Dusk courtyard with the pool and a warm-lit double-height glazed wall — far stronger than the flat daylight pool. |
| BONA-012 | `al-bandar-villas-north-obhur` ·hidden | 20 · pool | **20 · pool** | no | Kept: pool with the stone waterfall wall. Removed the street frame carrying the developer's "ayan" advertising banner. |
| BONA-013 | `duplex-penthouse-al-salamah` ·hidden | 0 · exterior | **5 · living** | **yes** | Penthouse rule: the widest reception with corner glazing and the city view; the real building photo (32) replaces the CGI render at slot two. |
| BONA-014 | `nobal-five-al-rawdah` | 0 · exterior | **1 · facade_night** | **yes** | Building at dusk with warm-lit windows — the daylight frame (0) is flattened by a neighbouring older block. |
| BONA-015 | `al-zahra-residences` | 10 · exterior | **21 · facade_night** | **yes** | The stacked window frames glowing at blue hour — the single best architectural frame; the daylight version moves to second. |
| BONA-016 | `villa-al-shati-1` ·hidden | 9 · pool | **9 · pool** | no | Kept: pool with the mansion and palms. Removed the night street frame whose subject is a parked Mercedes. |
| BONA-017 | `park-facing-villa-al-khalidiyah` ·hidden | 85 · exterior | **102 · facade_night** | **yes** | Twilight façade, warm lit, clean street — the old hero was a daylight frame with a wet road and a lamp post through the roofline. |
| BONA-018 | `villa-for-rent-al-shati-2` ·hidden | 0 · exterior | **25 · facade_night** | **yes** | Classical façade lit at night. Also removed a city/car-park view mislabelled "sea view" and two frames dominated by parked cars. |
| BONA-019 | `villa-for-rent-al-murjan` ·hidden | 13 · exterior | **0 · facade_night** | **yes** | Modern villa lit at blue hour from the street; the old hero was a flat daylight frame of a boundary wall and gates. |
| BONA-020 | `renovated-villa-for-rent-al-murjan` ·hidden | 1 · pool | **1 · pool** | no | Kept: the pool is the only outdoor asset in a thin 17-photo folder; replaced the dated corner-jacuzzi and the street snapshot at the tail. |
| BONA-021 | `villa-for-rent-al-mohammadiyah` ·hidden | 2 · entrance | **4 · entrance** | **yes** | Symmetrical dusk elevation with the timber door lit — the old second image was a night street shot with two parked cars. |
| BONA-022 | `trump-tower-jeddah` ★ | 9 · tower | **9 · tower** | no | Kept: the tower above the Red Sea shoreline is the money shot; the lobby now precedes the interiors and the gym closes the set. |
| BONA-023 | `trump-plaza-jeddah` | 6 · exterior | **6 · exterior** | no | Kept: the branded glass façade is the identity shot; swapped the café courtyard (people in frame) for the landscaped courtyard. |
| BONA-024 | `nobal-arista-al-khalidiyah` | 1 · render | **2 · entrance** | **yes** | Developer render rule — cleanest exterior render wins: the old hero had a silver SUV parked across the foreground. |
| BONA-025 | `kayan-residence-al-nahda` ·hidden | 17 · exterior | **17 · exterior** | no | Kept: the building by day is the right cover for the project page; the dark bathroom at the tail is replaced by the rooftop terrace. |
| BONA-026 | `dari-ii-al-salamah` | 7 · aerial | **7 · aerial** | no | Kept: the aerial of the courtyard pool is the distinctive frame; the very dark night pool (13) is replaced by the lit one (14). |
| BONA-027 | `marriott-residences-aida-muscat` | 0 · render | **5 · pool** | **yes** | Tower with the pool and palms, clean and crop-safe; the old hero carried the developer's "Marriott AIDA Oman" text overlay. |
| BONA-028 | `palais-rose-le-vesinet` ★ | 10 · exterior | **10 · exterior** | no | Kept: the entrance façade with the fountain and parterre. The grand salon is promoted over a lesser one and the cinema drops for the indoor pool. |
| BONA-029 | `palais-venitien-cannes` ·hidden | 27 · pool | **27 · pool** | no | Kept: the palais reflected in the long pool. The two aerials no longer sit at positions 2 and 4 — one closes the set, per the rubric. |
| BONA-030 | `da-vinci-tower-by-pagani-dubai` ·hidden | 17 · tower | **17 · tower** | no | Kept: the tower through its sculptural frame is the brand. Removed a near-duplicate living room and a near-duplicate pool; the aerial closes. |
| BONA-031 | `painite-villas-by-lamborghini-benahavis` ★ | 1 · render | **1 · render** | no | Kept: golden-hour villa with the infinity pool over the valley. Removed a frame carrying a "tkestate.sa" watermark and a duplicate car-lift render. |
| BONA-032 | `trump-cliff-villas-aida-muscat` | 6 · render | **6 · render** | no | Kept: the cliff villa lit at dusk above the sea. The aerial moves to the end and the crowded "golden cube" landmark stays out. |
| BONA-033 | `kayan-residence-al-nahda-unit-128a` | 18 · exterior | **18 · exterior** | no | Kept: the developer's building by day. Night façade and lobby move up so the first five are arrival, not kitchen and bathroom. |
| BONA-034 | `kayan-residence-al-nahda-unit-127a` | 13 · facade_night | **13 · facade_night** | no | Kept: the building at night. Added the daylight exterior and the lobby so the card and the first five read as a building, not a kitchen. |
| BONA-035 | `kian-building-113-unit-a-al-nuzhah` | 0 · living | **16 · lobby** | **yes** | Lobby with its chandelier — a distinct hero for this unit; the old hero was a plain double-height void shared with the sister units. |
| BONA-036 | `kian-building-113-unit-b-al-nuzhah` | 3 · living | **0 · living** | **yes** | The double-height living void, the most architectural interior in the folder, given to the largest unit (182 sqm). |
| BONA-037 | `kian-building-113-unit-c-al-nuzhah` | 16 · lobby | **10 · cafe** | **yes** | Rooftop café terrace — the amenity that sells this development; the old hero (the lobby) now belongs to unit 113A. |
| BONA-038 | `kian-building-114-unit-b-al-nuzhah` | 2 · kitchen | **11 · terrace** | **yes** | Rooftop pergola terrace. Rubric: a kitchen is never a hero — this unit led with one. |
| BONA-039 | `kian-building-114-unit-c-al-nuzhah` | 4 · kitchen | **14 · gym** | **yes** | The fitness hub. Rubric: a kitchen is never a hero — this unit led with one. |
| BONA-040 | `kian-building-117-unit-b-al-nuzhah` | 10 · cafe | **12 · cafe** | **yes** | The coffee bar counter, so this unit does not repeat 113C's café terrace. |
| BONA-041 | `kian-building-117-unit-c-al-nuzhah` | 11 · terrace | **7 · view** | **yes** | The room with the full-height window and the outlook — the only "view" frame in the folder. |
| BONA-042 | `kian-building-115-unit-a-al-rayyan` | 7 · bedroom | **9 · entrance** | **yes** | The building's covered entrance. Rubric: a bedroom is never a hero — this unit led with one. |
| BONA-043 | `dari-q-al-salamah` | 1 · exterior | **6 · rooftop_pool** | **yes** | The rooftop pool, clean and blue — the amenity that sells the building; the old hero was the beige tower with a row of parked cars along the bottom. |
| BONA-044 | `neptune-villas-north-riyadh` | 0 · exterior | **2 · exterior** | **yes** | The golden-hour street of villas; the old hero had two cars parked under the carport. |
| BONA-045 | `trump-international-hotel-residences-aida-muscat` ★ | 0 · pool | **0 · pool** | no | Kept: the infinity pool at sunset over the sea is exactly the rubric's first choice. A bathroom sat at position 5 — it now sits at 9, and the aerial closes. |

## Method and reproducibility

```bash
node scripts/curate/contact-sheet.mjs <gallery-folder> <out.jpg> [cols]   # labelled index sheet
node scripts/curate/build.mjs && node scripts/curate/validate.mjs --head  # regenerate + verify
```

The 86 contact sheets used for this pass total ~21 MB, over the ~15 MB budget for the repo, so
they were **not** committed; they live in the session scratch directory
(`…/scratchpad/hero/sheets/`) and are reproducible in a few minutes with the command above.
`decisions.json` carries the full old and new image list for every listing, so any single
decision can be re-argued without re-rendering anything.
