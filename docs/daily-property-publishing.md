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
   `--ids BONA-001,BONA-022`). It reads the live catalogue, downloads up to ten images per
   in-scope listing that is not already approved, keeps the ones that meet the publisher's rules
   (JPEG, at most 8 MB, at least 1080×720, aspect 0.8–1.91), and writes one contact sheet per
   listing plus `drafts.json` with a caption preview. It never writes the register and never
   uploads.
2. **Look** at every contact sheet, and at full frames where detail matters. Leave out other
   brokers' watermarks, people, price or text banners, floor plans, duplicates and anything that
   does not show this property. Put the strongest frame first.
3. **Approve:** `node scripts/social/approve-property-review.mjs --drafts NEW_DIR/drafts.json --reviewer "<who looked>" --select BONA-022:1,3,4 --select BONA-001:2,5,1,7`.
   Frames default to `render` for off-plan listings and `photograph` otherwise; a `p` or `r`
   suffix overrides one frame. Selected frames must sit within 15% of the first frame's aspect
   ratio because Instagram crops a carousel to its first frame. The script re-reads the live
   catalogue, refuses anything changed since drafting or not eligible, and leaves an identical
   existing review untouched.
4. **Commit** the register through a PR. The publisher reads it from `origin/main`.

Disclosures written with every review: prices are asking prices and may change; details,
condition and services are confirmed at viewing; for off-plan, delivery dates and
specifications are per the developer. Nothing else is claimed.

## Publication safety

- Each channel re-checks the account identity, downloads the reviewed images and compares their
  SHA-256 with the review, and re-reads the live catalogue just before upload. Any change stops
  that run.
- A per-channel lock, the existing ledgers and a durable `intent` record prevent duplicates. A
  failed or unconfirmed send records `uncertain` and stops automatic retries on that channel.
- **Reconciling an uncertain attempt.** Check the provider (Instagram media, Facebook Page posts)
  for that channel and date. If the post exists, append a `published` record with its ids. If it
  conclusively does not, append
  `{"channel":"instagram","date":"YYYY-MM-DD","id":"bona-daily-ig-YYYY-MM-DD","status":"confirmed-not-published","evidence":"<what was checked>","at":"<ISO time>"}`
  to `~/bona-data/daily/property.jsonl`. Only a record written after the attempt settles it.
  For Instagram, also settle any `publishing` line for that id in `~/bona-data/ig/published.jsonl`
  with a `published` line (post exists) or an `error` line (it does not); until then Instagram
  stays blocked. Never delete journal lines.

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
set -a; . ~/.secrets/bona-meta-graph.env; set +a
BONA_DAILY_TEST_NOW=2026-10-05T17:30:00Z node scripts/social/daily-publish.mjs instagram --dry-run
```

simulates the slot with read-only provider calls and prints
`Ready after read-only preflight: <entry id>, <listing id>; no post`.

Runtime evidence: `~/bona-data/daily/property.jsonl`, `~/bona-data/ig/published.jsonl`,
`~/bona-data/fb/published.jsonl`, `~/bona-data/daily/alerts.jsonl`.

## Rollback

Set `adLicence.requirement` to `"required"` (or revert the waiver commit). The register is inert
under a licence requirement. Published posts and ledgers are untouched.

Regulatory note: Articles 3, 5 and 6 of https://www.uqn.gov.sa/decisions-and-regulations/authorities/4000857
(checked 2 October 2026) are why the licence gate was built; the waiver above is the owner's
recorded business decision.
