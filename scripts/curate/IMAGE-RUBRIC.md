# Bona — house standard for property photography (hero choice + gallery order)

The first image is the whole advertisement. A visitor sees it in a 3:2 card, a 4:5 card and,
for featured homes, full-bleed across the home page. It has one job: state the property's
single strongest selling point, instantly, from across a room.

This file is the standard for both human curators and the AI intake pipeline
(`services/intake` reads it at runtime). Bona is edited to the taste of Sotheby's /
Knight Frank picture desks: architecture and light, never estate-agent inventory shots.

---

## 1. What a Bona hero is

A hero is **one wide, sharp, well-lit frame of the property's best exterior asset**, in this
order of preference:

1. Pool or terrace **looking out to water / horizon / skyline** (the view is the product).
2. Wide **exterior façade** at golden hour or blue-hour twilight, whole building in frame.
3. **Aerial / drone** frame that shows the plot, the shoreline or the setting.
4. Only when no usable exterior exists: the **best view-facing living space** — floor-to-ceiling
   glass, the outside visible through it.

Format: landscape, **3:2 or wider**, subject centred with breathing room on all four edges.
The card crops to 3:2 **and** 4:5 — anything critical within ~12 % of any edge will be cut.
Never choose a portrait frame, a square, or a shot whose subject is jammed against one side.

## 2. Hard exclusions — never the hero, under any circumstance

- Bathrooms, WCs, closets, laundry, maid's rooms, garages, stairwells, corridors.
- Bedrooms (a bed is the least differentiating object in luxury real estate).
- Kitchens (a hero kitchen reads as a rental listing).
- Floor plans, site plans, price tables, text/title slides, logos, watermarks, brochure pages.
- Screenshots, split screens, collages, photo-of-a-photo, phone-camera vertical frames.
- Clutter and life: shoes, bins, cables, laundry, food, plastic chairs, hoses, unmade beds,
  construction debris, protective film still on the glass.
- People, faces, agents, workmen, number plates, other agencies' branding.
- Blur, heavy noise, blown highlights, hard flash, extreme fish-eye, visible HDR halos.
- Anything already used as another listing's hero (heroes are unique across the whole file).

## 3. The ten-point score

Score every candidate 0–10; the hero is the highest total, ties broken by criterion 1 then 3.

| # | Criterion | 1 point when… |
|---|---|---|
| 1 | **Selling point** | The frame shows *why this home costs what it costs* (sea, pool, plot, skyline, architecture). |
| 2 | **Wide** | Landscape ≥ 3:2, the whole subject in frame, not a detail crop. |
| 3 | **Light** | Golden hour, twilight, or even soft daylight. No blown sky, no dark muddy midday shadows. |
| 4 | **Sharp** | In focus at full size, no motion blur, no upscaling mush. |
| 5 | **Clean** | No clutter, cables, bins, cars, people, text, watermarks. |
| 6 | **Composed** | Verticals straight, horizon level, one clear subject, generous margins. |
| 7 | **Depth** | Foreground → subject → background; water, sky or garden gives the eye somewhere to go. |
| 8 | **Colour** | Coherent palette, natural white balance, no green/orange cast. |
| 9 | **Crop-safe** | Survives both 3:2 and 4:5 with the subject still centred and complete. |
| 10 | **Distinct** | Not a near-duplicate of another frame in this gallery, and unused elsewhere on the site. |

**Score ≥ 8 → hero material. 6–7 → gallery. ≤ 5 → drop.**
An interior can never beat an 8+ exterior, however handsome the interior is.

## 4. Ordering — walk the guest through the home

After the hero, the set reads as an arrival, not a slideshow of rooms:

1. **Hero** (best exterior / view).
2. **Second exterior**, deliberately different: night façade if the hero is day, day if the hero
   is night; or the pool from the opposite side; or an aerial. Never a near-duplicate.
3. **Arrival** — entrance, courtyard, lobby, great hall, staircase.
4. **Living / majlis** — the main reception space; the best interior of the set goes here.
5. **Dining, then kitchen.**
6. **Master suite**, then a second bedroom if the set has room.
7. **One** bathroom, at most, and only if it is genuinely photogenic.
8. **Terrace / garden / roof / balcony.**
9. **Amenities** — gym, spa, cinema, lounge, café, event hall, tennis, golf, parking.
10. **Aerial or night pool** as the closing frame.

Rules that override the walk: 8–10 images per listing (minimum 4). The **first five must
carry no bathroom, no floor plan, no text slide, no amenity shot**. Never two consecutive
frames of the same room. Drop near-duplicates — same room, same angle, one stop apart — and
keep only the best one. Every image gets its correct `room` key from `scripts/curate/rooms.mjs`.

## 5. Special cases

- **Developer renders (Kian, Nobal, Painite, Marriott, Trump off-plan).** When the listing is
  a unit or off-plan, the developer's material is all there is. Hero = the cleanest **exterior
  or lobby** render; never a bedroom or a bathroom render. Prefer photographs over CGI when
  both exist. Units of one developer legitimately share non-hero renders, but **each unit's
  hero must be a different frame** — rotate through exterior, night façade, lobby, café,
  terrace, gym, entrance, parking so cards never look identical in a grid.
- **Apartments and penthouses.** No private pool or plot to sell, so the ranking is:
  view from inside → building façade (twilight best) → rooftop pool / amenity terrace →
  main living space. A tower shot is a hero only if the tower is the brand (Trump, Da Vinci).
- **Land.** Untouched: `images[0]` is the z=17 satellite still with the plot ring,
  `images[1]` the z=15 context frame. Never crop, reorder or add a render.
- **Night shots.** A blue-hour façade or lit pool is a superb *second* frame and a legitimate
  hero when the day equivalents are weak. True night (black sky, hard lamp glare) is not.
- **Drone / aerial.** Hero only when it reads as one property — a plot on a shoreline, a villa
  in its grounds. A top-down frame of a whole neighbourhood is context, so it closes the set.
- **Twilight.** Beats every other treatment of the same façade. If a twilight frame exists and
  is sharp, it wins the hero or the number-two slot.
- **Sold / reserved listings.** Curated to the same standard — they stay in the archive and
  still carry the brand.

## 6. Checklist before committing a set

- [ ] Hero is landscape, wide, sharp, exterior-or-view, and unique across `listings.source.mjs`.
- [ ] Hero survives a 4:5 crop with the subject intact.
- [ ] No bathroom, plan or text slide in the first five images.
- [ ] 8–10 images, no near-duplicates, no repeated room back to back.
- [ ] Room keys correct; `.png` renders never sit in `images[0]` of a featured listing
      (`heroListings()` in `src/lib/listings.ts` skips PNG heroes on the home slideshow).
- [ ] `node scripts/curate/build.mjs && node scripts/curate/validate.mjs` green.
