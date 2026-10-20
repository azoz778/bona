# Daily property posts

One Instagram post and one Facebook post a day at 20:30 Asia/Riyadh, each a carousel of three
to six reviewed images of one current website property. The existing `bona-daily@instagram`
and `bona-daily@facebook` timers run it; there is no other timer.

## Policy (`marketing/daily/property-policy.json`)

- **Ad-licence waiver (owner, 2026-10-05).** The owner instructed daily posting of current
  Saudi website properties without per-listing REGA ad-licence numbers and accepted the stated
  exposure. `adLicence.requirement` is `"waived"` with `by` and `on`; a waiver missing either,
  or dated in the future, stops every run. Setting it back to `"required"` restores the
  licence gate exactly as it was. Every caption still carries the advertiser's name, FAL number
  and phone, and a listing's ad-licence line appears automatically once `licence.adNumber` is set.
- **Scope:** `countries: ["SA"]`, `categories: ["buy","rent","off-plan"]`. International
  listings are out.
- **Renders:** `renders: "off-plan-only"`. Developer renders may illustrate off-plan projects
  only, and the caption then says so in both languages. Ready stock needs real photographs.
- **Plot cards:** `cards: "land-only"` (owner, 2026-10-21). A land listing has only two 1024x768
  satellite stills, too small to post as photographs, so it may post a branded card set instead:
  (a) the plot still fitted whole (scaled down, never up) and labelled «صورة جوية، الموقع تقريبي» /
  "Satellite view, approximate" with the imagery source (Esri World Imagery), the title and place;
  (b) a facts card: the plot area, the asking price when the caption shows one, then the listing's
  highlights in both languages (frontage, street widths, orientation, a price per square metre
  only when a highlight states it; nothing computed, missing fields simply absent); (c) the area
  still with the district, city and country. Every word comes from the listing's public facts,
  which `factsSha256` binds, so a changed fact invalidates the cards with the review. A card is a
  frame of kind `card` (`card`: `satellite` | `facts` | `location`; a still-based card names its
  `source` still and hash) hosted like a padded frame; any other listing type with a card is
  refused (`card_not_allowed`). The caption then closes with «الصور الجوية تقريبية، والبطاقات معدّة
  من بيانات الإعلان.» / "Satellite views are approximate; the cards are made from the listing
  details." and never calls them photographs. TikTok's reel shows each card whole on 9:16 with no
  motion and no hook or lower third (`make-reel.mjs --fit pad --plain`); LinkedIn re-encodes them.
- **Reviews** stay valid for `reviewValidDays` (90) while the listing facts, the advertiser and
  the caption are unchanged; any change invalidates a review at once.
- **Rotation:** one property per channel per day. Never-posted listings go first (a newly approved
  listing is next on every channel), then the one posted least recently on that channel. A listing
  repeats on a channel after `repeatDays` (14) Riyadh calendar days: posted on the 6th, it may
  return on the 20th. `repeatDays` is the one interval for Instagram, Facebook, TikTok and LinkedIn;
  `policyRules()` refuses a value outside 14–90 (14 is the Instagram publisher's duplicate window).
- **Repeats look different.** A repeat carries the same reviewed caption (its `captionSha256` still
  binds it) and the same approved frames, under another cover and in another order: the reviewed
  order the first time, then each approved frame as the cover in turn with the rest following,
  then the same covers with the rest reversed. The sequence starts at how many times the listing
  has been published on that channel and takes the first order whose image sequence differs from
  the one it was last posted with there (the last `published` line's `images`, else its
  `frameOrder`, else the reviewed order), so a re-review that adds or removes frames never repeats
  the last post. Orders whose frames would not all sit within 15% of the new cover's aspect are
  never used, so Instagram's crop stays small; the reviewed order always qualifies. No frame is
  ever added. The order used is logged (`Frames for BONA-… on instagram: 2,3,1`) and written as
  `frameOrder` (1-based review positions) and `images` (URLs) on the journal's `intent` and
  `published` lines.
- **Duplicate guard.** The same images in the same order with the same caption as a post published
  in the last 14×24 hours never goes out. Instagram: publish.mjs's own content-hash check against
  `ig/published.jsonl` (`skipped:duplicate`). Facebook: the same hash, kept on the `published`
  lines of `fb/published.jsonl`. A live run that hits it records `confirmed-not-published` and fails
  with an alert ("Instagram post not sent (… skipped:duplicate)" / "Facebook post not sent: same
  images and caption as …"); a dry run says "would repeat …". When no
  property is eligible the run falls through to an approved reviewed pack in `marketing/daily/`
  if one is due; otherwise it records a skip. Runs before 20:30 or from 23:00 do nothing, and
  there is no backfill.

## Admitting properties (`marketing/daily/property-reviews.json`)

1. **Draft:** `node scripts/social/draft-property-reviews.mjs --out NEW_DIR` (or add
   `--ids BONA-001,BONA-022`). It reads the live catalogue, downloads up to ten images for each
   in-scope listing that is not currently eligible (no review yet, or one that has expired or no
   longer matches), keeps the ones that meet the publisher's rules (JPEG, at most 8 MB, at least
   1080×720, aspect 0.8–1.91), and writes one contact sheet per listing plus `drafts.json` with a
   caption preview. It never writes the register and never uploads.
2. **Look** at every contact sheet, and at full frames where detail matters. Leave out other
   brokers' watermarks, people, price or text banners, floor plans, duplicates and anything that
   does not show this property. Put the strongest frame first.
3. **Approve:** `node scripts/social/approve-property-review.mjs --drafts NEW_DIR/drafts.json --reviewer "<who looked>" --select BONA-022:1,3,4 --select BONA-001:2,5,1,7`.
   Frames default to `render` for off-plan listings and `photograph` otherwise, and always to
   `photograph` for a listing with a `photoNote` (photos of another project, see below); a `p`
   or `r` suffix overrides one frame. Selected frames must sit within 15% of the first frame's aspect
   ratio because Instagram crops a carousel to its first frame. The script re-reads the live
   catalogue, refuses anything changed since drafting or not eligible, and leaves an identical,
   still-valid review untouched; an expired one is renewed.
   **Plot cards:** `--cards BONA-046:1,2` (the plot still, then the area still, by website index;
   the draft lists a land listing's stills under `stills` and on its contact sheet) renders the
   set with `lib/property-cards.mjs` and approves it without any `--select`. It is refused when
   the plot area is missing, the highlights do not pair up in the two languages, a stated area or
   price per square metre contradicts the listing (more than 1% from the asking price), or any
   card text fails the caption refusal. Look at the three cards before committing them.
   **Padded frames (owner, 2026-10-21):** add `--pad BONA-014` to publish every selected frame of
   that listing padded to 4:5 instead (`"fit": "pad-4x5"` on each frame). The script renders each
   frame whole and centred on a 1080x1350 ink canvas above a small BONA mark (no crop, no stretch,
   a brochure's white margin trimmed; `lib/property-media.mjs padFrame()`, deterministic) and writes
   it to `public/social/property/<id>/pad-<source sha8>-<sha12>.jpg`, which the site serves at
   `https://bona-real-estate.com/social/property/<id>/…`: Instagram fetches carousel images from a
   public URL and the publisher uploads nothing, the same path as the reviewed daily pack's cards.
   The frame keeps its source `url`/`sha256`/size and gains `media` {url, sha256, 1080, 1350}. Every
   slide is then 4:5, so frames of mixed aspect can share a carousel, and a portrait source down
   to 9:16 (0.56) may be approved; the draft keeps such a frame and marks it `padOnly` (`PAD ONLY`
   on the contact sheet), and approving it without `--pad` is refused. The size floor (1080x720)
   and the 8 MB limit still apply to the source. Before publication every channel downloads the
   source and the padded file and checks both hashes; Instagram and Facebook post the padded file,
   TikTok's reel pads each source photo to 9:16 (`make-reel.mjs --fit pad`) and LinkedIn re-encodes
   the padded files without a second mark. `--local-public public` (draft and approve) reads the
   site's own images from the repository instead of the live site, for images committed but not yet
   deployed; the publishers always check the live bytes.
4. **Commit** the register through a PR, with any `public/social/property/` files it names. The
   publisher reads the register from `origin/main`; until the site deploy has served the new files a
   run stops before any record ("Reviewed source photo unavailable" or "changed since visual review").

Disclosures written with every review: when the caption shows a price, that prices are asking
prices and may change; for ready stock, that details, condition and services are confirmed at
viewing; for off-plan instead, that delivery dates and specifications are per the developer.
Off-plan captions ask about availability and details and never offer a viewing. Nothing else
is claimed.

When a listing's photos show another project, the listing carries a `photoNote` (see
`src/data/LISTING-SCHEMA.md`), for example Dari II (BONA-026): "Photos show a completed sister
project by the same developer, not Dari II." The caption then opens with that sentence: it is
the first line of each language block, and the Arabic block is the first thing a feed preview
shows. The note
is part of the reviewed facts. Frames of such a listing default to photographs even when it is
off-plan; the publisher refuses one marked as a render (`photo_note_conflicts_with_renders`), a
malformed note (`photo_note_malformed`) and a caption without the note
(`photo_note_not_in_caption`).

## Publication safety

- Each channel re-checks the account identity, downloads the reviewed images and compares their
  SHA-256 with the review, and re-reads the live catalogue just before upload. Any change stops
  that run. Just before the `intent` record the slot is checked again on the real clock, so a run
  whose preflight ends at or after 23:00 records nothing and posts nothing.
- A per-channel lock, the existing ledgers and a durable `intent` record prevent duplicates.
- A failure that provably sent nothing is recorded as `confirmed-not-published` automatically,
  and the next run retries. On Instagram that means no `publishing` or `published` line for the
  day's id in `~/bona-data/ig/published.jsonl`: the publisher writes the `publishing` line before
  `media_publish`, the only call that makes a post visible. A missing Instagram ledger file is
  treated as unknown, so the attempt stays `uncertain`. On Facebook it means a failure before the
  Page feed request, when only unpublished photo uploads were made (the Page token is fetched
  before the `intent` record, so failing to get it records no intent and sends nothing). Such a
  run still fails and alerts ("Instagram post not sent …" or "Facebook post not sent …"). Only an
  unknown outcome records `uncertain`, which stops automatic retries on that channel until it is
  reconciled.
- **Reconciling an uncertain attempt.** An `intent` or `uncertain` line in
  `~/bona-data/daily/property.jsonl` that no later line settles keeps that channel blocked.
  Settle it by appending lines, never by deleting any:
  1. Work only while no run holds `~/bona-data/daily/.property-<channel>.lock`. The file names the
     run's process id; an `intent` under a live run is an attempt still in progress.
  2. Look for the post with an authenticated API read of the account's Instagram media or the
     Page's Facebook posts that covers the attempt time, and match it on caption and images. Only
     such a read shows the post is absent: a failed or partial query is not absence, and a wrong
     `confirmed-not-published` lets a later run post again, as soon as the same evening.
  3. Append one line to `property.jsonl`, with `date`, `id` and `listingId` copied from the
     attempt's `intent` line. If the post exists:
     `{"channel":"instagram","date":"YYYY-MM-DD","id":"bona-daily-ig-YYYY-MM-DD","listingId":"BONA-…","status":"published","mediaId":"…","permalink":"…","evidence":"<what was checked>","at":"<publication time, ISO>"}`
     or
     `{"channel":"facebook","date":"YYYY-MM-DD","id":"bona-daily-fb-YYYY-MM-DD","listingId":"BONA-…","status":"published","postId":"…","evidence":"<what was checked>","at":"<publication time, ISO>"}`.
     Its `at` is the provider's publication time; the repeat interval (`repeatDays`) counts from its Riyadh date. If
     the post is absent:
     `{"channel":"instagram","date":"YYYY-MM-DD","id":"bona-daily-ig-YYYY-MM-DD","listingId":"BONA-…","status":"confirmed-not-published","evidence":"<what was checked>","at":"<now, ISO>"}`
     or
     `{"channel":"facebook","date":"YYYY-MM-DD","id":"bona-daily-fb-YYYY-MM-DD","listingId":"BONA-…","status":"confirmed-not-published","evidence":"<what was checked>","at":"<now, ISO>"}`.
     Only a line written after the attempt settles it. A hand-written `published` line must carry
     `listingId` (the repeat interval and rotation read it) and, if known, the `frameOrder` that
     was posted (else the next repeat assumes the reviewed order).
  4. If the post exists, also append the same `published` line to `~/bona-data/ig/published.jsonl`
     or `~/bona-data/fb/published.jsonl`, unless that ledger already has a `published` line for
     the id; Instagram stays blocked without it. If it is absent and
     `~/bona-data/ig/published.jsonl` has a `publishing` line for the id, append
     `{"id":"bona-daily-ig-YYYY-MM-DD","date":"YYYY-MM-DD","status":"error","detail":"<what was checked>","ts":"<now, ISO>"}`
     after it. Without that line Instagram stays blocked; with it, that date stays closed and
     Instagram posts again from the next day's slot.

## Monitoring

- `~/bona-data/daily/heartbeat-instagram.url` and `heartbeat-facebook.url` (mode 600, outside the
  repo) hold the Uptime Kuma push URLs of the monitors "Bona daily post — instagram" and
  "Bona daily post — facebook". A confirmed or already-recorded publication pushes `up`. The
  22:30 and 22:45 runs push `down` with the reason when the day still has no post, which reaches
  the owner's Telegram through the existing Kuma notification. The monitors also go down after
  26 hours without a push. A missing URL file or a failed push is logged and never fails a run.
- The Codex app automations `bona-daily-publishing-checks` (20:45, 21:45, 22:45) and
  `bona-weekly-social-replenishment` (Thursdays 10:00) also inspect this pipeline and report into
  their Codex chat. They are not part of this repository.

## Verification

```bash
( set -a; . ~/.secrets/bona-meta-graph.env; set +a; cd ~/bona-publish &&
  BONA_DAILY_TEST_NOW="$(TZ=Asia/Riyadh date +%F)T17:30:00Z" node scripts/social/daily-publish.mjs instagram --dry-run )
```

simulates today's 20:30 Riyadh slot (17:30Z) in the publisher's checkout with read-only provider
calls; run it again with `facebook`. The subshell keeps the Meta token out of your shell. A slot
that will post prints `Ready after read-only preflight: <entry id>, <listing id>; no post`. Also
normal: `Daily slot already published` once today's post is recorded, or, with no eligible
property, the skip JSON, then `No eligible property today; checking the reviewed daily pack.` and
`No daily content due …` (on a pack day, the pack's `Validated …; no publish` line instead).
Anything else means the slot would not post.

Runtime evidence: `~/bona-data/daily/property.jsonl`, `~/bona-data/ig/published.jsonl`,
`~/bona-data/fb/published.jsonl`, `~/bona-data/daily/alerts.jsonl`.

## Rollback

Set `adLicence.requirement` to `"required"` (or revert the waiver commit). The register is inert
under a licence requirement. Published posts and ledgers are untouched.

Regulatory note: Articles 3, 5 and 6 of https://www.uqn.gov.sa/decisions-and-regulations/authorities/4000857
(checked 2 October 2026) are why the licence gate was built; the waiver above is the owner's
recorded business decision.
