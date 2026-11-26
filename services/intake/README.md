# Bona WhatsApp intake

The owner drops a property brochure PDF into a WhatsApp group on his own phone and, about a
minute later, the property is on bona-real-estate.com. This service is what happens in between.

```
owner's phone ──WhatsApp group "Bona …"──▶ Evolution API (wa-api.azoz.uk, his own instance)
                                                  │  poll every 20 s (read-only)
                                        ┌─────────▼──────────────────────────────┐
                                        │ bona-intake  (systemd --user, WSL)     │
                                        │  PyMuPDF  → text + candidate photos    │
                                        │  gate     → default-deny classifier    │
                                        │  claude -p→ copy (AR+EN) + photo rank  │
                                        │  sharp    → public/listings/<slug>/    │
                                        │  git      → commit + push main         │
                                        │  reply    → "✅ Live: … "               │
                                        └─────────┬──────────────────────────────┘
                                                  ▼
                              GitHub Actions ──▶ https://bona-real-estate.com
```

Nothing about this service is exposed to the internet: it makes outbound calls only.

### The publish pipeline at a glance (unit models, brochure, enrich)

1. **Models extraction**: the model reads the PDF and returns the listing plus its unit models
   (type, beds, areas, prices as printed).
2. **Per-page price confirmation** (`lib/model-prices.mjs`): every model price is confirmed on its
   page image by a second model, one call per page (2 at a time, `BONA_MODEL_PRICE_CONCURRENCY`), at most `BONA_MAX_MODEL_PRICE_PAGES`
   pages (12); a price that is not confirmed is dropped, never taken from the text layer.
3. **Floor plans**: each model's plan is cut from the PDF and saved as `plan-NN.jpg` (flattened on white).
   Before any plan file reaches the repo, a second model checks every plan image (at its published 1600 px
   size, 12 per call, 2 calls at a time; a dry run too) for a phone number, email, website, social handle, QR
   code, logo / brand name or price (`lib/plan-check.mjs`, r4). A flagged plan, or one without exactly one
   well-formed "clean" answer, is left out (its model shows no plan; the listing is never blocked). A check that
   cannot finish publishes without those plans ("try again later"); on `--enrich` it commits nothing
   (retryable; `--force` takes the models without plans on a first enrichment, not after a quota).
   `brochure <id>` and `price <id>` reuse the checked plan files and make no call.
4. **Site section**: the listing page shows "Residences & prices" from `models`.
5. **Brochure** (`brochure_pdf.py`): one bilingual (English + Arabic) A4 PDF drawn from scratch in the
   TK design system, from the published listing, its photos and plans. WeasyPrint is pinned to 70.0 and
   needs the system Pango libraries. A failed build never deletes an existing brochure.
6. **`brochure <id>`** (WhatsApp command): rebuilds that brochure from the listing alone, no source PDF needed.
7. **`run-once.mjs <pdf> --enrich <id>`**: adds models, plans, amenities / nearby / warranties and a new
   brochure to an already published listing, leaving every other field untouched. Headline rules: the
   owner's own price is kept and model prices are cleared; a price on request adopts the models' lowest
   (`from`); an existing price must equal the models' lowest, else the run is refused (then it is marked
   `from: true` when equal). It never writes over a listing with less than it carries: an incomplete
   price check is refused ("try again later") when the listing already has model prices to lose (on a
   first enrichment the models go up without the unchecked prices, with the same "try again later"),
   and a reading with fewer models, fewer confirmed model prices, fewer floor plans or a fact list
   fewer is refused unless `--force`. See "Enriching a published listing" below.
8. **`backfill-enrich.mjs`**: runs `--enrich` over every older listing, one at a time; a listing that
   already carries unit models or a fact list (amenities / nearby / warranties) is skipped as "already enriched" unless `--include-enriched` (no
   `--force` is ever passed on). `--plan-only`
   prints the plan and stops, `--dry-run` runs each job without writing, a live run commits and pushes.
   It stops at the first FAILED job or a quota/usage limit and prints the `--only <ids>` that resumes it.

## How the owner uses it

1. Make (or rename) any WhatsApp group whose **subject contains "Bona"** — e.g. "Bona
   Listings". The bot greets it once.
2. Send a **property brochure PDF** into the group. Optional caption hints:

   | caption | effect |
   |---|---|
   | `rent`, `للإيجار` | category = rent (`per month` sets month, `per year` year; with no period in the caption the brochure's period stands, and `year` when it has none) |
   | `off-plan`, `international` | sets the category |
   | `SAR 4,500,000`, `SAR 4.5m`, `990,000 ر.س`, `٤٥٠٠٠٠٠ ريال سعودي`, `US$ 1.2m`, `rent SAR 45,000 per year` | the asking price (a rent's with its period right after the figure), overriding the PDF — the currency is always written, and flags (`#rent`, `#test` …) go before the price: one after a rent's period, or any other hashtag, means no caption price |
   | `Villa 450 m2`, `Deposit 50,000`, `Villa for sale in Obhur 4.5m`, `SAR 4,500,000 4 bedrooms`, `4.5m (USD 1.2m)`, `٤٥٠٠٠٠٠ ريال` / `Dhs 1.2m` / `$1.2m` (a riyal, dirham or dollar with no country), `rent SAR 45,000` (a rent with no period), `SAR 4.5m?`, `SAR-4.5m` (a minus sign), `4.5m` / `450,000` (no currency written), `للإيجار سنة … ٤٬٥٠٠ ريال سعودي` (a period away from the figure), `€450,000` / `OMR 185,000` (one comma group with no currency, or in euros or rials, may be a decimal comma: write `SAR 450,000`, `SAR 450k`, `€450k` or `€1,450,000`; `price <id> 450,000` asks for the currency on a euro or rial listing) | no caption price: the caption sets a price only when it is nothing but a price — one figure with its multiplier and currency, and only words like price / asking / for sale / rent / per year / negotiable (السعر، للبيع، إيجار، سنوياً). Anything else and the PDF's price stands; send `price <id> …` to set one |
   | `#test` | dry run — the bot replies with the listing it *would* publish and writes nothing |
   | `#nobrochure` | publish the listing with **no** downloadable brochure |
   | `#brochure` | nothing (a no-op alias — every brochure is re-published by default) |
   | `#hidden` | writes the listing but keeps it off the site until `show <id>` |

3. The bot replies `Reading the brochure…`, then either
   `✅ *Title* — https://bona-real-estate.com/properties/<slug>/ · 8 photos · cover: Pool · SAR 4,500,000`
   or one line saying why it was not published.
4. Afterwards, plain text messages in the group act as commands:

   ```
   remove BONA-W001          take the listing off the site (deletes the JSON and the photos)
   hero BONA-W001 4          make photo 4 the cover
   price BONA-W001 4500000   set the asking price   (price BONA-W001 onrequest clears it)
   brochure BONA-W001        rebuild the Bona brochure from the listing and its photos (no PDF needed)
   sold BONA-W001            mark it sold           (also: reserved / available)
   hide BONA-W001            keep it off the site   (show BONA-W001 puts it back)
   licence BONA-W001 7200012345 2027-03-01
                             the REGA advertisement licence and its expiry
                             (licence BONA-W001 clear takes it off again)
   wafi BONA-W001 1234567890 the off-plan project's Wafi licence  (wafi … clear)
   status                    what is published and what the intake is doing
   retry                     re-run the last brochure
   help                      the list above
   ```

   `licence` / `wafi` are the only two that also address a **curated** listing (`BONA-015`):
   a REGA advertisement number belongs to every listing on the site, not just the ones the
   intake published. Where it lands is not the owner's problem — an intake listing keeps it in
   its own `scripts/curate/inbox/<slug>.json`, a curated one in `scripts/curate/licences.json`
   keyed by id, which `scripts/curate/build.mjs` merges back on. Both are checked against
   `scripts/curate/rules.mjs::licenceProblems` — the site validator's own rule — *before*
   anything is written, so a licence that would fail the build never reaches a commit.
   The expiry is accepted as `2027-03-01` or `01/03/2027`, in Western or Arabic-Indic digits,
   and must be a real calendar date (`2027-02-31` is refused, not rounded up). The Arabic verbs
   `ترخيص` and `وافي` do the same thing and are answered in Arabic — the only place the intake
   speaks it, because the licence line is the part of the site a regulator reads.

   > **A curated id only works while the listing is PUBLISHED.** `locateCurated()` looks the
   > id up in the built `src/data/listings.json`, which holds only what `build.mjs` actually
   > published — so a curated listing the build excludes answers `No listing called BONA-002.`
   > even though the id is real. Today that is: a house over the SAR 10,000,000 cap
   > (`rules.mjs::isHousePublic` — BONA-002 and BONA-028), a land plot at or over SAR
   > 50,000,000, and anything missing from TK's live public list. Those need no advertisement
   > licence while they are off the public site; if one goes back on, record its number after
   > the build that republishes it, or edit `scripts/curate/licences.json` by hand.

5. Got a walkthrough clip? Send the **video** into the group — no caption needed. Working out
   which property it belongs to is the bot's job, not the owner's; three answers are tried,
   cheapest first:

   1. **an id in the caption** — `video BONA-W001`, or just `BONA-W001`. Always wins, and it
      is the way to add a clip to a listing published long ago.
   2. **the burst rule** — the brochure sent closest to the clip in time, within
      `BONA_VIDEO_WINDOW_MIN` (15 minutes; `lib/video.mjs` `pickListingForVideo`). The owner
      drops the PDF and its clips in one go, so this is almost always the answer. If the
      brochure is still being published — or has not arrived yet — the clip is parked (one
      line back: "Got the video — it will be added once … is published") and attached the
      moment the listing exists; if two different listings were published from brochures
      equally close, the bot asks which one instead of guessing.
   3. **the content matcher** (`lib/video-match.mjs`), for a clip with no id and no brochure
      anywhere near it: ffmpeg pulls 3–4 evenly spaced frames out of the clip and **one**
      extra `claude -p` — under the same confinement as everything else — looks at them
      beside the hero photos of the last ~15 intake listings, plus anything legible in the
      frame (a hoarding, a gate, a project name). It attaches only at
      `BONA_VIDEO_MATCH_CONFIDENCE` (0.75) or better; below that the group gets **one** line
      saying it could not tell which property this is, naming what it compared against. It
      never guesses, and it costs at most one call per clip (`contentTried` on the job).

   What is stored is **not** the file WhatsApp sent. ffmpeg re-encodes it to H.264 + AAC in
   MP4, capped at 1080p (long side ≤ 1920, short side ≤ 1080, aspect kept), with
   `-movflags +faststart` so the browser can start playing before the file has finished
   arriving, and cuts a poster frame out of it (`v-NN-poster.jpg`, 1600 px via sharp). If the
   result misses `BONA_MAX_VIDEO_MB` (25 MB) it is re-encoded once at 720p/CRF 31, and if it
   still misses, the clip is refused with a line asking for a shorter one — a raw phone clip
   committed into git history cannot be taken back out. Up to 4 clips per listing. The site
   renders `videos[]` on the listing page (`ListingPage.astro`) as `<video>` elements with
   that poster.

Anything else in the group is ignored, silently.

## The rules it enforces

- **Only the owner, only in his own group.** A message is acted on when `key.fromMe === true`
  or the sender resolves to `BONA_OWNER_JID` — including through `key.participantAlt` /
  `senderPn`, which is how the real number arrives in a LID group. And the *group* has to be
  his too: a subject that matches `BONA_WA_GROUP_MATCH` is only trusted when the group's
  `owner` or `subjectOwner` is the owner, because anyone can create a group called "Bona
  Listings" and add him to it. A group that reports no owner fails closed — put its jid in
  `BONA_WA_GROUP_JIDS` if you really do want it (an explicitly configured jid is trusted).
  Messages wrapped in `ephemeralMessage` / `viewOnceMessage(V2)` are unwrapped first, so a
  disappearing-messages group still works.
- **Default deny on PDFs.** Invoices, receipts, IDs, bank/account statements, payslips, tax
  certificates, commercial registrations and anything with no property signal are rejected and
  **never copied into the repo** — the download is deleted too. `lib/classify.mjs` does this
  before the AI ever sees the file; the model is a second, independent gate (`reject: true`).
  The keyword list has two tiers: `passport`, `كشف حساب`, `payslip`, `invoice` and friends are
  **absolute**, while the words that a real developer's brochure legitimately prints — `صك`,
  `رخصة`, `عقد إيجار`, "terms and conditions", his company IBAN — only deny a document that
  has no property content of its own. An IBAN that is the *subject* of the document (in the
  file name, or in the first line) is absolute.
- **A brochure with no text layer still gets a hearing.** A Canva/Illustrator PDF with under
  ~40 characters of text per page is not judged locally at all: every page is rendered at
  1600 px and handed to the AI, which reads the specs and the prices off the pages and
  rejects it if it is not one property for sale. Default-deny simply moves one gate later.
- **A brochure whose pages ARE the pictures gets its photographs cut out of them.** A deck
  designed in Canva/Illustrator and exported one picture per page yields candidates that are
  whole pages — photo plus headline plus logo plus floor plan in one bitmap — and the ranking
  step rightly refuses every one of them ("collage", "text page"), which used to end the run
  at `not enough usable photos — 0 of 4`. When the pages are page-sized composites (the
  bitmap covers ~all of its page, or the PDF has no text layer) **and** the leftovers could
  not fill a gallery on their own, `lib/photo-regions.mjs` renders those pages, sends **one**
  extra `claude -p` — under the same confinement — and gets back the bounding box of every
  photograph printed on them, in 0–1 coordinates. The boxes are cut out with sharp from a
  re-render of the page at crop resolution and go into the candidate list as ordinary
  candidates, so `IMAGE-RUBRIC.md` judges them like any other photograph. A page too long to
  read in one frame (the Sadana cover is 1080×10449 pt) is sliced into overlapping views
  first and the boxes are mapped back onto the page. Nothing is relaxed: a crop under
  `BONA_MIN_IMAGE_SIDE` on its short side, or shaped like a banner, is dropped, and a run
  whose crops the ranking step still refuses is still rejected. It costs one call, only on
  the brochures that would otherwise have been rejected, capped at 20 pages and 24 crops
  (the numbers are constants at the top of `lib/photo-regions.mjs`, not env vars).
  It is also the most memory-hungry thing this service does, and it is bounded on purpose:
  **one page at a time** — render it, cut its regions out, delete the render, move on — with
  a hard 12 MP budget per render (`CROP_MAX_PIXELS`; a page render is decoded twice, once by
  PyMuPDF to make it and once by sharp to cut from it), MuPDF's object store emptied after
  every page, and libvips' cache and worker threads turned off for the loop. Before that, the
  step rendered every page up front at up to 30 MP and the unit was OOM-killed in a restart
  loop inside its 1 GB cgroup on the owner's 2026-09-06 brochures. Measured after: peak RSS
  522 MB for the whole run (five-page Sadana brochure), inside a 1 GB cap.
- **Never estimates a price** (TAQEEM), and does not take the model's word for one either.
  A price is published only when the number is **actually printed**: `lib/price.mjs` looks it
  up in the PDF's text layer and in the caption (thousands separators, Arabic-Indic digits,
  `4.5m` / `مليون` forms all count). For a PDF with no text layer the model must return
  `priceEvidence: { page, quote }` and a second one-shot `claude -p` has to confirm it on that
  page image. Otherwise the listing is published as *price on request* and the reply says so.
- **Prices the text layer cannot read** (2026-11-17, Jeddah Heights / BONA-W023): a PDF can have a
  good text layer and still scramble its digits — the font maps them to letters, so the page shows
  270,425 and the text says `DIB,FDG`. `lib/price-pages.mjs` picks the pages where a line that
  mentions a price has no readable figure within a few lines (or the page has a scrambled one), plus
  every page that mentions subsidy beneficiaries, at most 12; they are rendered and handed to the
  model as page images, and the same `priceEvidence` + second-model check applies (a missing
  `priceEvidence` is looked up in the rendered pages' text).
- **Two printed prices**: NHC-style brochures print a regular price and a lower one for
  housing-subsidy (Sakani) beneficiaries. `amount` = the regular price; `price.subsidisedAmount` =
  the subsidised one, shown on the site as a second line. It is published ONLY after the second
  model has seen it printed as the subsidy beneficiaries' price on a page image — a number found in
  the text layer proves it is printed, not which price it is. A headline price found only on pages
  with subsidy wording is confirmed on the page the same way, with the rule that a price printed
  only for beneficiaries does not count. Dropped when it cannot be confirmed
  (`subsidised-price-not-printed`), when the headline price is not published, and by `price <id> …`.
  The "a price for one of its unit models counts" allowance in that check is only for a whole
  development quoted `from` its cheapest model, never for one unit.
- **Unit-model prices** (`ai.models[].price` / `subsidisedPrice`, `lib/model-prices.mjs`): every
  figure is confirmed on its page image by a second model, never by the text layer (a price table
  puts every model's figures in the text; a match cannot tell whose figure it is). One call per page
  covers every model on it (at most `BONA_MODEL_PRICE_CONCURRENCY` at once, 2 by default; none started after a quota error); a cited page
  that was not rendered for the reading is rendered for this check (never one past the end of the
  PDF), and when that render fails its models are refused — never moved to another page by their
  text, so the page cap holds. A brochure that would need more than `BONA_MAX_MODEL_PRICE_PAGES`
  pages checked gets no model price at all and no call. A figure not confirmed is dropped
  (`model-price-not-printed`) and, like a refused headline, may not stay in the copy — nor in any
  text the run publishes: a model's name, rooms or availability, or a fact list (a bare
  "Buildings G–P, 419,994" counts), on a publish and on `--enrich` alike (which then changes nothing). The reply
  words the two cases apart: "could not be confirmed on the brochure's own pages" for a figure the
  check did not find, "could not be completed (pages …) — try again later" for one whose render or
  call failed. After a quota error no further call is made for the brochure — not for the headline
  or its Sakani price either, which then say "could not be checked … try again later". When any model keeps a price, the headline of a whole
  development becomes the cheapest one, `from` (its period untouched), with the cheapest confirmed
  subsidised price as its Sakani line. A whole development is a `project`, no `unit`, two models or
  more (`rules.mjs headlineFollowsModels`, the same rule the validator applies). A listing for one
  specific `unit`, and a single property (no `project`) with one "model" or per-floor rows, is never
  published "From" its cheapest model: the prompt has its headline be the property's own printed price
  (a villa priced per floor: its printed total) with `models` normally empty, and when a reading still
  takes the headline from the models (the lowest model price as read, `from`), the pipeline clears
  `from` and publishes the figure only once a second model has seen it printed on its page AS THE WHOLE
  PROPERTY'S price (`whole`; the text layer cannot tell a floor's price from the villa's) — otherwise
  "price on request". Its models keep their confirmed prices. "From …" can still appear on a listing
  that is not a whole development in two cases only: a price the brochure itself prints as "starting
  from" that is no model's, and a project with a single model (its own headline check decides). The owner's caption price drops every model price, and so does `price <id> …` later (its
  reply says how many models lost their price: the table then shows "On request").
  **Currency** (TAQEEM covers it: a figure printed in £ is not a price in SAR): model prices are written
  and confirmed in the reading's `price.currency` (`modelPriceCurrency`). It never counts for a property
  in a country whose own currency the site does not print (`homeCurrency`: only SA, AE, OM, US and the
  euro area have one) — amount or not, because the prompt has the model set the headline amount FROM
  the model prices, so that amount is no independent reading: W020's Hampstead brochure printed GBP and a
  reading by the prompt says "from 1,250,000 SAR". Elsewhere it counts beside a headline amount, or — on
  request — when it is that country's own currency (a Saudi brochure is priced in SAR). Otherwise no
  model price is published or checked (`currency-unconfirmed` on a publish, `currency-mismatch` on
  `--enrich`; `model-price-not-printed`), the headline is not aligned, and a figure the copy states
  refuses the run. Every second-model check (unit-model prices and the headline) asks for the figure
  printed IN that currency — its code, symbol or Arabic name (SAR / ر.س / ريال / ﷼ / ⃁ for SAR), beside it
  or heading its table: the same figure in £, $ or any other currency does not count, and a figure with
  no currency shown counts only in the property's own country's currency. The headline's text-layer
  check applies the same rule (`printedInCurrency`): "£1,250,000" is never "1,250,000 SAR", and abroad a
  bare figure in the text does not settle the price.
- **Photo focus points**: the model gives every kept photo a `focus` `{x, y}` (the centre of its
  subject); the site uses it as the crop position, so a tall façade is not cut down to sky.
- **Re-running a published brochure**: `node services/intake/run-once.mjs <pdf> --replace BONA-W023`
  rewrites that listing in place (same id, slug, date and reference; new copy, price, photos and
  brochure). Run it in the publishing clone (`--repo ~/bona-bot`, the default) with git: the clone
  must be clean (it refuses rather than discards) and the listing committed, because the old files
  are deleted first and a failed run is rolled back from the commit. It is refused for a listing that
  has been committed to again since it was published (a hand correction, a WhatsApp edit), or that
  carries anything a re-run would not keep — a hand-added field (`photoNote`, `faq`, `seoTitle`, …),
  videos, a licence, a virtual tour, `hidden`, `featured`, or `_intake.edits` (`price`/`hero`).
  Later `intake: enrich …`, `intake: rebuild brochure …` (backfill) and `intake: branded brochure (<id>)`
  (the WhatsApp `brochure <id>` command) commits do not count as changes (a re-run rebuilds all three);
  none is ever taken for the publish commit.
- **Enriching a published listing** (listings published before the intake read unit models):
  `node services/intake/run-once.mjs <pdf> --enrich BONA-W014 [--dry-run]` reads the brochure again
  and adds ONLY the unit models (every model price confirmed on its page, as on a publish), their
  floor plans (`plan-NN.jpg`, the old plan files are removed), `amenities` / `nearby` / `warranties`
  (a list the new reading does not have is removed) and a new brochure drawn from the merged listing
  and its own folder. Every other key of the inbox JSON — title, copy, photos, location, licence,
  videos, `photoNote`, `faq`, `seoTitle`, `featured`, `_intake` — stays byte for byte, so it works on
  a listing corrected by hand (no history rule). The headline is decided from the listing: the
  owner's own price (`_intake.edits` has `price`) stays and the models publish without prices; model
  prices in another currency than the listing's — or in none the reading established (see Currency
  above) — are not published or checked and the headline stays (`currency-mismatch`); one
  specific `unit` keeps its price, and so does a listing that is not a whole development
  (`single-property`: no `project`, or fewer than two models), its models keeping theirs; a price on request adopts the models' lowest confirmed price
  (`from`, with its Sakani line); a set price is kept only when it IS that price (marked `from`),
  otherwise the run is refused with both figures and nothing changes — send `price <id> …` first, or
  use `--replace`. It must be the very PDF the listing was published from (`_intake.pdfSha256`), the
  clone clean and the listing committed (a failed run is rolled back from git); withdrawn, withheld
  and hidden listings are refused. A brochure that cannot be built keeps the enrichment and the old
  brochure (`brochure-failed`). The commit is `intake: enrich <title> (<id>) — unit models + brochure`.
  Not with `--replace`, `--caption` or `--no-git` (except with `--dry-run`, which prints the models,
  their prices, the headline decision, the comparison with what the listing carries and the plan
  files, and writes nothing). A re-enrichment never degrades a listing: when the unit-model price
  check could not be completed (a page that did not render, a failed call, a quota) on a listing that
  already carries model prices, nothing is written ("try again later", `--force` or not) — a listing
  with no model price to lose gets the models without the unchecked ones, and the reply's "could not be
  completed … try again later"; when the reading has fewer unit models, fewer confirmed model
  prices (regular + Sakani), fewer floor plans or drops a fact list the listing carries, it is refused
  with the difference (`Compared   models 8 → 5 · …`) unless `--force` says the new reading is right.
- **Nothing the model writes is trusted.** Only fields that pass `validateAiResult` +
  `copyProblems` + `checkListing` are written or sent on. The model's free-text `warnings`
  stay in the run's `ai.json`; `_intake.warnings` in the committed listing holds codes from a
  fixed vocabulary and nothing else. The PDF text and the caption go into the prompt inside
  `<<<BONA-UNTRUSTED-DATA>>>` markers, with an explicit instruction that everything between
  them is a document, never an instruction.
- **The model is confined to its work dir.** No `--permission-mode bypassPermissions` (it
  granted the whole filesystem for no benefit). Measured on this CLI, *no* permission mode
  gates `Read` at all, so `lib/confine.mjs` generates a `--settings` file that denies every
  branch of the filesystem except the run's work dir. Verified: with it, `Read /etc/hostname`
  is refused and the work dir still reads.
- **No other agency in the copy.** The brochures the owner receives are usually branded by
  someone else; the generated copy is checked for `TK`, `tk-estates`, phone numbers and the
  hype words the site validator bans, and is rejected if any appear.
- **The brochure comes back out under Bona's brand.** The owner is sent someone else's
  brochure; what goes on the site is a NEW bilingual A4 brochure drawn from scratch by
  `brochure_pdf.py` (TK design system, Bona branded) out of the published listing, its photos
  and floor plans, and `src/data/site.json` — nothing of the developer's PDF is re-published.
  It only ever prints fields the listing already passed the validators with; the developer is
  named as text only. `#nobrochure` publishes the listing with no PDF at all. A rent keeps its
  period wherever a price is printed — the units table, each model page, the "From" headline:
  "SAR 50,000 / year", with the Arabic line "ابتداءً من 50,000 ر.س / سنوياً" (the site's own wording).
- **Real Arabic**, checked for Arabic script in every `ar` field.
- **4–10 photos.** A PDF that yields fewer than four publishable photographs is rejected
  rather than published thin.
- **A withdrawn project stays withdrawn.** When a developer withdraws the permission to
  advertise a project (BONA-W009, Elvira Murjan, 2026-10-20), it is a full takedown, recorded in
  `scripts/curate/rules.mjs` `WITHDRAWN_ADVERTISING` and as a `withdrawnAdvertising` flag on its
  `marketing/daily/property-reviews.json` entry. The intake then refuses the same brochure (by
  its SHA-256, before a page is read), a re-export of it (by the project's name: in the
  brochure's own text layer, metadata, links, file name or caption before a model is asked, then
  anywhere in what the model writes from it — a generic title, a fresh id or a fresh slug does not
  help; a brochure that only mentions the project is refused too, since the intake republishes the
  brochure itself), and `show`, `brochure` and `video` on the listing (and `hero` and `price`,
  which have nothing left to edit, and `available`, `reserved`, `sold`, `licence` and `wafi`,
  which would overwrite the tombstone's status or add to it); `hide` and `remove` still work. Its
  inbox record is a **tombstone** (id, slug, names, brochure hash — no copy, photos or
  brochure link: the repository is public). `build.mjs` and `validate.mjs` leave it out and refuse
  to build while its `public/listings/<slug>/` files exist — `validate.mjs` also for a re-import
  caught by name under a fresh slug — so even an intake that predates the gate cannot put it back.
  Reinstating one needs an explicit owner decision that the developer's permission is renewed:
  delete the rules.mjs record and the register flag by hand, `remove` the tombstone, then send the
  brochure again (it gets a new id).
- **Read-only on WhatsApp apart from replies.** The service never sets a webhook, websocket or
  RabbitMQ binding on the instance — another agent (Lisa) consumes its events and a webhook
  here would steal them.
- **A failure never leaks command output.** The group gets one generic line; the git, build
  and model output goes to the journal, where only the owner can read it.

## The publish order (this is load-bearing)

`build.mjs` rewrites the **tracked** file `src/data/listings.json`, and `git rebase` refuses to
run with unstaged changes. So the order is fixed and nothing pulls mid-flight:

```
assertCleanTree(repo)      git status --porcelain must be empty; a crashed job's leftovers
                           under public/listings and scripts/curate/inbox are cleaned once
                           and re-checked (anything else is a hard stop — it is not ours)
gitPull(repo)              fetch + rebase, BEFORE the first byte is written
processPdf(...)            images AND the branded brochure into <workDir>/publish/<slug>,
                           promoted into the repo only after checkListing() passes;
                           then build.mjs + validate.mjs
gitCommitPush(repo, …)     `git add -A -- <allowlist>` only:
                             public/listings/<slug>, scripts/curate/inbox,
                             scripts/curate/licences.json, src/data/listings.json
                           (a staged path outside that list aborts the commit)
                           push; if the remote moved, re-pull (the tree is clean now) and retry
```

Anything that throws after the first write calls `resetTree()`: it deletes the new listing
directory, then `git checkout --` and `git clean -fd` **only** the allowlisted paths, so
the next job can always pull. It deliberately never touches anything else — a modified tracked
file outside the allowlist means somebody else is working in that clone, and the job stops with
"the publishing clone has N uncommitted path(s)" rather than throwing their work away.
A dry run touches neither git nor the remote.

A **lock file** (`$BONA_DATA/intake.lock`) sits around the whole write phase, shared by the
daemon and `run-once.mjs`, so the two can never write the clone at the same moment. A lock
whose holder died is stolen, not waited on.

**Restarts.** Every PDF is written into the state file as a `pending` job *before* its message
id is marked seen, so a crash between the two replays the job instead of losing the brochure.
`SIGTERM` stops the daemon taking new work and waits up to 40 s for the job in flight
(`TimeoutStopSec=45`) — it never `process.exit()`s in the middle of a git push or a sharp
encode.

**Host storage failures.** The unit retries every 75 s, below its five-starts-per-300-s
budget, so an extended disk-full/startup failure does not permanently disable intake.
Atomic state writes keep the last saved jobs and PDF hashes intact. Before recovery,
check free space and inodes, back up the state, and inspect pending jobs and unseen
messages. Replay only the intended submissions; design supplements for one brochure
must not become separate listings. If an older unit already hit its start limit, install
the updated unit, run `systemctl --user daemon-reload`, then
`systemctl --user reset-failed bona-intake` and start it after reviewing that queue.
A model quota error is separate: the originals stay queued and retry hourly, including
across restarts, without exhausting the three real-failure attempts. The group receives
one quota notice rather than repeated failure replies. No provider limits are bypassed.

## Install

The service runs from `~/bona` and writes to a **separate clone** so that a `git pull` during
a publish can never rewrite the code running the publish.

**Node 24 or newer is required** (`services/package.json` engines, and what CI runs). Node 22
cannot parse the inline regex modifiers `(?-i:…)` in `lib/price.mjs` and `lib/pipeline.mjs`, so
the intake will not even start on it. Check with `node --version` before installing.

```bash
# 1. the publishing clone (once)
gh repo clone azoz778/bona ~/bona-bot
cd ~/bona-bot && npm ci

# 2. the code the service runs (the owner's normal checkout, already there)
cd ~/bona && npm ci

# 3. secrets — already created; only BONA_* live here, Evolution creds stay in their own file
#    (do not print this file)
ls -l ~/.secrets/bona-services.env ~/.secrets/evolution-api.env

# 4. the unit
install -Dm644 ~/bona/services/deploy/bona-intake.service ~/.config/systemd/user/bona-intake.service
systemctl --user daemon-reload
systemctl --user enable --now bona-intake
loginctl enable-linger "$USER"        # keeps it running when no shell is logged in

# 5. watch it
systemctl --user status bona-intake
journalctl --user -u bona-intake -f -o cat | jq .
```

**After a merge that changes the intake.** The daemon rebases only its publishing clone
(`~/bona-bot`) and loads its own code once, from `~/bona`, at start. Nothing updates `~/bona`
by itself, so a change to `services/intake/` or to `scripts/curate/rules.mjs` (which the intake
imports) is not live until both of these have run:

```bash
git -C ~/bona pull --ff-only                  # ~/bona must be clean apart from untracked files
systemctl --user restart bona-intake
journalctl --user -u bona-intake -n 30 -o cat # a clean start: a `start` line, no `fatal` or `config.*` error
```

Until then the old daemon keeps answering with the old rules. `build.mjs` and `validate.mjs` are
the exception: `rebuild()` runs them from `~/bona-bot` after its rebase, so the site-side gates
apply from the merge on.

**Rolling back the unit-models branch** (`feat/intake-brochure-models`): after a revert, the older
`changedSincePublished` knows none of `intake: enrich …`, `intake: rebuild brochure …` and
`intake: branded brochure (<id>)`, so
`run-once --replace` treats a listing enriched or brochure-rebuilt since as hand-edited and refuses it
("changed since it was published"). That is by design — the older code cannot rebuild what those
commits added — so redo such a listing by hand, or roll the listing back too.

## Configuration

`~/.secrets/bona-services.env` (mode 600, shared with `services/api`). Everything has a
default, so only the ones you want to change need to be present.

| variable | default | meaning |
|---|---|---|
| `EVOLUTION_API_URL` / `EVOLUTION_API_KEY` | — | read from `~/.secrets/evolution-api.env` |
| `BONA_WA_INSTANCE` | `abdulaziz-personal` | Evolution instance |
| `BONA_OWNER_JID` | `966593296933@s.whatsapp.net` | the only author whose messages are acted on |
| `BONA_WA_GROUP_MATCH` | `bona` | case-insensitive regex against the group subject |
| `BONA_WA_GROUP_JIDS` | — | extra group jids, comma separated |
| `BONA_REPO` | `~/bona-bot` | the clone that is written to and pushed |
| `BONA_DATA` | `~/bona-data` | downloads, extraction scratch, state |
| `BONA_POLL_MS` | `20000` | message poll interval |
| `BONA_GROUP_SCAN_MS` | `0` when `BONA_WA_GROUP_JIDS` is set, else `300000` | group discovery (`/group/fetchAllGroups`) interval; `0` = one discovery per start (retried every 30 min until it succeeds, so groups found by `BONA_WA_GROUP_MATCH` come back after a restart), then off once every configured group is pollable (every 30 min only while one is not). Each scan costs one WhatsApp `groupMetadata` per group the number is in, so a 5-min scan tripped `rate-overlimit` ~670×/h on the personal number |
| `BONA_CLAUDE_MODEL` | `opus` | the model for the extraction/curation step (owner 2026-11-17: Opus picks the photos; was `sonnet`) |
| `BONA_CLAUDE_FALLBACK_MODEL` | the other one of `opus`/`sonnet` | used for the last attempt if the main model keeps failing the contract (always a different model from the main one unless set explicitly) |
| `BONA_SITE` | `https://bona-real-estate.com` | used for URLs and `brochureUrl` |
| `BONA_MIN_IMAGES` / `BONA_MAX_IMAGES` | `4` / `10` | publishable photo count |
| `BONA_MIN_IMAGE_SIDE` | `700` | smallest long side of a candidate photo |
| `BONA_MAX_PDF_MB` / `BONA_MAX_PDF_PAGES` | `150` / `120` | input limits (developer brochures run 50–80 MB) |
| `BONA_MAX_VIDEO_MB` | `25` | largest **stored** clip, after ffmpeg has re-encoded it; over it the clip is re-encoded smaller once and then refused (see `lib/video.mjs`) |
| `BONA_MAX_VIDEO_INPUT_MB` | `200` | largest clip that may be **downloaded** at all |
| `BONA_FFMPEG_BIN` / `BONA_FFPROBE_BIN` | `~/.local/bin/ffmpeg` / `…/ffprobe` | the static builds the transcode, the poster and the matcher's frames use; spawned with an argv array, never a shell |
| `BONA_FFMPEG_TIMEOUT_MS` | `600000` | how long one ffmpeg may take |
| `BONA_VIDEO_MATCH_CONFIDENCE` | `0.75` | how sure the content matcher must be before it attaches a captionless clip |
| `BONA_VIDEO_MATCH_FRAMES` | `4` | frames pulled out of the clip for it to look at |
| `BONA_VIDEO_MATCH_LISTINGS` | `15` | how many recent intake listings the clip is compared against |
| `BONA_PAGE_READ_LONG_SIDE` | `1600` | long side of the page renders the AI reads (text-free PDFs) |
| `BONA_MAX_MODEL_PRICE_PAGES` | `12` | most pages the unit-model price check may confirm on (one call each); more = no model prices |
| `BONA_MODEL_PRICE_CONCURRENCY` | `2` | unit-model page checks running at once; each is a `claude -p` node process inside the daemon unit's `MemoryMax=2G`, so raise it with care |
| `BONA_LOCK_WAIT_MS` | `900000` | how long a job waits for `$BONA_DATA/intake.lock` |
| `BONA_PY_CMD` | `uv run --with pymupdf --with pillow python` | argv for the extractor; split on spaces, never shelled |
| `BONA_BROCHURE_PY_CMD` | `uv run --with weasyprint==70.0 --with segno --with pillow --with pymupdf python` | argv for the brochure step (WeasyPrint is pinned — the layout checks were tuned on it; it needs the system Pango libraries) |
| `BONA_BROCHURE_TIMEOUT_MS` | `600000` | how long `brochure_pdf.py` may take |
| `BONA_MAX_BROCHURE_MB` | `25` | largest brochure committed into the repo; over it the images are scaled down, and if it still does not fit the listing publishes without one |
| `BONA_SEND_REPLIES` | `true` | set `false` to run completely silent |
| `BONA_DEBUG` | — | any value adds debug logs and stack traces |

## Testing without WhatsApp

```bash
cd ~/bona

# preview only — writes nothing, prints the listing, the ranking and the chosen hero
node services/intake/run-once.mjs ~/brochures/villa.pdf --dry-run --repo ~/bona

# write into a repo and rebuild, but never touch git or the remote
node services/intake/run-once.mjs ~/brochures/villa.pdf --no-git --repo ~/bona --caption "SAR 4,500,000"

# the real thing (commits and pushes, exactly like the daemon)
node services/intake/run-once.mjs ~/brochures/villa.pdf

# the brochure step on its own: a listing JSON + its folder of photos/plans + site.json
uv run --with weasyprint==70.0 --with segno --with pillow --with pymupdf python -I \
  services/intake/brochure_pdf.py ~/bona-bot/scripts/curate/inbox/villa.json \
  ~/bona-bot/public/listings/villa ~/bona-bot/src/data/site.json ~/out/brochure.pdf --work ~/out/work

# unit tests — note the glob: node v24.19.0 on this box does not accept a bare directory
node --test 'services/intake/test/*.test.mjs'

# the video path on one local clip: which listing does it think this is, and what would be
# committed? Writes nothing to the repo and takes no lock.
node --input-type=module -e '
  const { loadConfig } = await import("./services/intake/lib/env.mjs");
  const { candidateListings, matchVideoToListing } = await import("./services/intake/lib/video-match.mjs");
  const { prepareVideo } = await import("./services/intake/lib/video.mjs");
  const cfg = loadConfig({ repo: process.env.PWD });
  const clip = process.argv[1], work = "/tmp/bona-clip";
  console.log(await matchVideoToListing({ videoPath: clip, workDir: work + "/match", candidates: candidateListings(cfg.repo), cfg }));
  console.log(await prepareVideo({ input: clip, outDir: work + "/media", cfg }));
' ~/clips/walkthrough.mp4
```

`brochure_pdf.py` reads only the files it is given and writes only `<out.pdf>` and `--work`, so
it is safe to run while the daemon is up — it is the loop to use when changing the brochure.
Rasterise the pages afterwards and look at every one of them.

Every run leaves its scratch directory behind (`--work`, else `$BONA_DATA/intake/manual/…`)
containing `prompt.txt` (exactly what the model was asked), `ai.json` (exactly what it
answered — including its free-text `warnings`, which are never committed), `images/` (every
candidate, `cNNN.jpg` being the regions cropped out of composite pages), `sheets/` (the
contact sheets it looked at), `pages/` (the page renders, for a PDF with no text layer),
`regions/` (the photo-region step, when it ran: `views/` the page renders it looked at,
`sheets/` their contact sheet, `prompt.txt` what it was asked and `regions.json` the boxes
it drew — `crops/` holds one high-resolution page render at a time and is empty when the
step finishes, because the renders are the memory and disk cost of the step and the crops
themselves are what survive, in `images/cNNN.jpg`) and
`claude-settings.json` (the deny rules that confined it). That is the first place to look
when a listing comes out wrong.

A rescue round — the ranking step calling the candidates collages, so the crop step runs
after it rather than before — overwrites `prompt.txt` and `ai.json` with the second, final
ask; the `intake.cropped` line in the journal says why the crop step ran.

`run-once.mjs` takes the same `$BONA_DATA/intake.lock` as the daemon, so it is safe to run
while the service is up — it waits its turn. `--dry-run` and `--no-git` never call git at all,
so pointing `--repo` at a working checkout with uncommitted changes in it is safe.

## What it writes

| path | what |
|---|---|
| `scripts/curate/inbox/<slug>.json` | the listing (see `src/data/LISTING-SCHEMA.md` § WhatsApp intake) |
| `scripts/curate/inbox/_index.json` | the `BONA-W###` counter |
| `public/listings/<slug>/NN.jpg` | photo, max 1920 px, q82, EXIF stripped |
| `public/listings/<slug>/NN-thumb.webp` | 640 px thumbnail |
| `public/listings/<slug>/plan-NN.jpg` | a unit model's floor plan (NN = the model's 1-based position in `models`), flattened on white, max 1600 px, q85, 4:4:4 colour |
| `public/listings/<slug>/plan-NN-thumb.webp` | its 480 px thumbnail |
| `public/listings/<slug>/v-NN.mp4` | a walkthrough clip, re-encoded (H.264/AAC, ≤1080p, faststart, ≤ `BONA_MAX_VIDEO_MB`) |
| `public/listings/<slug>/v-NN-poster.jpg` | its poster frame, 1600 px |
| `public/listings/<slug>/brochure.pdf` | the Bona-branded brochure — by default, unless `#nobrochure`, and only up to `BONA_MAX_BROCHURE_MB` |
| `$BONA_DATA/intake/<date>/<msgid>.pdf` | the downloaded PDF (outside the repo) |
| `$BONA_DATA/intake/<date>/<msgid>.mp4` | the downloaded clip, exactly as WhatsApp sent it (kept for a replay; never committed) |
| `$BONA_DATA/intake/<date>/<msgid>-video/` | the transcode: `clip.mp4` (deleted once it is in the repo) and `poster.jpg` |
| `$BONA_DATA/intake/<date>/<msgid>-match/` | the content matcher: `frames/`, `listings/` (the candidates' thumbnails, copied in so the confined model can read them), `sheets/`, `prompt.txt`, `match.json` |
| `$BONA_DATA/intake/<date>/<msgid>/` | the run's work dir: `prompt.txt`, `ai.json`, `images/`, `pages/`, `sheets/`, `regions/` (only when photo regions were cropped), `publish/<slug>/` (staging), `claude-settings.json` (the model's confinement) |
| `$BONA_DATA/intake-state.json` | seen message ids, greeted groups, published PDF hashes, job records |
| `$BONA_DATA/intake.lock` | the publish lock (daemon + run-once) |

`scripts/curate/build.mjs` appends the inbox files to `src/data/listings.json` after the TK
live-list filter; intake listings are exempt from that filter because they are owner-authored.
It refuses to build while any site-local file a listing names is missing from `public/` — photos
and thumbnails, clips and posters, floor plans and their thumbnails (`rules.mjs` `localFilesOf`,
which `validate.mjs --head` stat-checks too).

## Failure modes

| symptom | cause | what to do |
|---|---|---|
| `✋ Not published — looks like a private document ("IBAN")` | the default-deny gate | correct: that PDF is not a brochure |
| `✋ … not a property brochure` (AI gate) | a scan, certificate or site plan without property details | send the real brochure |
| `✋ … not enough usable photos — 0 of 4` | the PDF has no extractable photographs (only page renders) or they are all plans/logos | send a brochure with real photos, or the photos themselves |
| `✋ … not enough usable photos — 2 of 4 (even after cutting 3 photo region(s) out of its own pages)` | the pages were composites, the crops were made, and the ranking step still would not publish enough of them | look in the work dir: `regions/regions.json` is where the model said the photographs were, `images/cNNN.jpg` is what came out |
| `⚠️ … You've hit your session limit` | Claude Code quota | the saved job retries hourly; the PDF stays in `$BONA_DATA`, send `retry` |
| `⚠️ Something went wrong …` | any failure: git, build, model | the reason is in the journal — the reply deliberately quotes none of it. The repo is rolled back. |
| `⚠️ The page is still not answering …` | GitHub Pages did not deploy | the listing IS committed; check the Actions run |
| `the publishing clone has N uncommitted path(s)` | something other than the intake wrote to `~/bona-bot` | look at `git status` there yourself; the intake refuses to throw away work that is not its own |
| `another intake job holds intake.lock` | a `run-once.mjs` is still running | wait, or remove the file if its pid is gone |
| `⚠️ … spawn claude ENOENT` | the unit's PATH is missing `~/.local/bin` | fix `PATH=` in the unit, `daemon-reload`, restart |
| listing live but no *Download brochure* button | the brochure was over `BONA_MAX_BROCHURE_MB` even with its images scaled down, or `brochure_pdf.py` failed (`intake.brochure_failed` / `edit.brochure_failed` in the journal) | the reply says which; `_intake.warnings` holds `brochure-too-large` / `brochure-failed`. Raise the cap and send `brochure <id>`, or leave it — the listing itself is fine |
| `✋ Which listing is this video for? …` | a video with no `BONA-W###` in its caption and no brochure within `BONA_VIDEO_WINDOW_MIN` of it (or the nearest brochure was rejected / never finished within `BONA_VIDEO_WAIT_MIN`), and there was nothing published to compare it against | send it again right after the brochure, or captioned `video BONA-W001` |
| `✋ I watched the clip and still cannot tell which property it is …` | the content matcher ran and came back under `BONA_VIDEO_MATCH_CONFIDENCE` | caption it with the id. `video.content_match` in the journal says what it saw and how sure it was; the frames, the contact sheets and `match.json` are in `<msgid>-match/` |
| `✋ Two brochures were sent just as close to this video …` | two different listings were published from brochures within 60 s of each other around the clip | send it again captioned with the id you mean |
| `🎬 Got the video — it will be added once … is published` | the clip landed while its brochure was still in the pipeline (or before the brochure arrived at all); it is parked in the state file (`waitSince`, plus `waitingFor` when a specific brochure is mid-publish) and requeued once that brochure answers, a new brochure arrives, or `BONA_VIDEO_WAIT_MIN` runs out | nothing — if the brochure ends up rejected or never comes, the clip comes back as the "Which listing" line |
| a clip sent before 2026-09-06 never appeared | the old daemon had no video path and marked it seen | stop the unit, `node services/intake/unsee.mjs <messageId…>`, start the unit — it is handled as if just sent |
| `✋ The video is N MB — the limit is …` | over `BONA_MAX_VIDEO_INPUT_MB` (declared length or the actual download, whichever catches it) | trim the clip, or raise the limit |
| `✋ Even re-encoded, the video is N MB …` | two ffmpeg passes and it still misses `BONA_MAX_VIDEO_MB` | send a shorter clip — nothing was committed |
| `✋ That video could not be re-encoded …` | ffmpeg refused the file (not a video, or a container it cannot read) | the journal has the tail of ffmpeg's stderr; try re-sending it as MP4 |
| bot silent, no greeting | no group subject matches `BONA_WA_GROUP_MATCH`, or the group is not the owner's | rename the group; if the journal says `group.rejected_not_owned`, the group was created by somebody else — put its jid in `BONA_WA_GROUP_JIDS` if that is really what you want |
| bot silent on a PDF | the message was not authored by the owner, or was already seen | check `journalctl` for `msg.ignored_not_owner` |
| `Already published: <url>` | the same PDF bytes were sent twice | use `remove <id>` first if you meant to replace it |
| listing published but the page 404s for a while | GitHub Pages deploy takes 2–3 min | the reply says so; the URL is already correct |
| PC off / WSL asleep | the service is not running | WhatsApp keeps the messages; everything queued is processed when it comes back, and a PDF that was already downloaded when the power went is replayed from `intake-state.json` |

The daemon processes **one PDF at a time**. A second PDF sent while the first is being read
waits in the queue; `status` shows the depth.

## Layout

```
services/intake/
  index.mjs             the daemon: group discovery, polling, single-worker queue
  run-once.mjs          the same pipeline on one local PDF, no WhatsApp
  extract_pdf.py        PyMuPDF: page text + candidate photos, whole-page renders (--mode pages)
                        and sliced page views (--mode views); run via `uv run --with pymupdf --with pillow`
  brochure_pdf.py       WeasyPrint + segno: the Bona brochure, drawn from the listing, its photos and plans
  lib/
    env.mjs             config; reads ~/.secrets/*.env inside Node, never through a shell
    log.mjs             one JSON line per event, with secret redaction
    evolution.mjs       Evolution API client (+ the verified response shapes, in comments)
    classify.mjs        the default-deny gate
    pdf.mjs             wrapper around extract_pdf.py
    brochure.mjs        wrapper around brochure_pdf.py: the public listing it is handed, where the file lands
    contact-sheet.mjs   labelled sheets of the candidates, for the model to look at
    photo-regions.mjs   the photographs cut out of pages that are single flattened pictures
    prompt.md           the prompt template (the contract the model must answer with)
    claude.mjs          the `claude -p` runner, contract validation, repair retry
    confine.mjs         the --settings deny rules that lock the model into the work dir
    price.mjs           the TAQEEM cross-check: is this number actually printed?
    lock.mjs            $BONA_DATA/intake.lock — one writer at a time
    shutdown.mjs        wait for the job in flight on SIGTERM
    images.mjs          sharp: NN.jpg + NN-thumb.webp
    video.mjs           ffmpeg: probe, frames, the H.264/AAC transcode, the poster; v-NN.mp4 + v-NN-poster.jpg
                        (plus the burst rule that says which brochure a captionless clip came with)
    video-match.mjs     "which property is this?" answered by LOOKING at the clip — frames +
                        the recent listings' photos in one confined `claude -p`
    listing.mjs         slug/id allocation, listing assembly, local validation, the inbox
    edits.mjs           remove / hero / price / status / hidden / video
    messages.mjs        every reply the bot sends
    pipeline.mjs        the gates, in order
    publish.mjs         clean tree, pull, build + validate, allowlisted commit + push, rollback
    state.mjs           seen ids, greeted groups, published PDF hashes
  test/                 node --test 'services/intake/test/*.test.mjs'
services/deploy/bona-intake.service
```
