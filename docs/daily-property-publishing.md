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
- **Reviews** stay valid for `reviewValidDays` (90) while the listing facts, the advertiser and
  the caption are unchanged; any change invalidates a review at once.
- **Rotation:** one property per channel per day, oldest first, 30-day repeat interval. When no
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
   Frames default to `render` for off-plan listings and `photograph` otherwise; a `p` or `r`
   suffix overrides one frame. Selected frames must sit within 15% of the first frame's aspect
   ratio because Instagram crops a carousel to its first frame. The script re-reads the live
   catalogue, refuses anything changed since drafting or not eligible, and leaves an identical,
   still-valid review untouched; an expired one is renewed.
4. **Commit** the register through a PR. The publisher reads it from `origin/main`.

Disclosures written with every review: when the caption shows a price, that prices are asking
prices and may change; for ready stock, that details, condition and services are confirmed at
viewing; for off-plan instead, that delivery dates and specifications are per the developer.
Off-plan captions ask about availability and details and never offer a viewing. Nothing else
is claimed.

When a listing's photos show another project, the listing carries a `photoNote` (see
`src/data/LISTING-SCHEMA.md`), for example Dari II (BONA-026): "Photos show a completed sister
project by the same developer, not Dari II." The caption then opens with that sentence, on the
line under the title and place in both languages, where a feed preview still shows it. The note
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
     Its `at` is the provider's publication time; the 30-day repeat interval counts from it. If
     the post is absent:
     `{"channel":"instagram","date":"YYYY-MM-DD","id":"bona-daily-ig-YYYY-MM-DD","listingId":"BONA-…","status":"confirmed-not-published","evidence":"<what was checked>","at":"<now, ISO>"}`
     or
     `{"channel":"facebook","date":"YYYY-MM-DD","id":"bona-daily-fb-YYYY-MM-DD","listingId":"BONA-…","status":"confirmed-not-published","evidence":"<what was checked>","at":"<now, ISO>"}`.
     Only a line written after the attempt settles it.
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
