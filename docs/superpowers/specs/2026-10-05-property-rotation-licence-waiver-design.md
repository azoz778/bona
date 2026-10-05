# Daily property rotation without per-listing ad licences — design (2026-10-05)

## Decision and context

Since 2 October the daily Instagram/Facebook publisher runs in "property photography"
mode (PR #34). It refuses every listing because none of the 48 catalogue records carries a
REGA advertising-licence number and the review register is empty, and because the property
path exits before the approved editorial pack can run. Nothing has been posted since
1 October.

Owner decision, 5 October 2026 (chat): "We have a lot of properties. Let's just post from
that. No license required." The regulatory exposure was stated once and accepted: the
September research found the 2026 advertising bylaw treats a broker's own listing posts as
advertisements that need a per-property licence number; a Jeddah first offence is a warning
or about SAR 5,000. The owner's FAL number, advertiser name and phone stay on every post,
and an ad-licence line is added automatically whenever a listing carries a number.

Scope chosen by the owner: Saudi ready stock plus Saudi off-plan projects. International
listings stay out. Approach chosen: the waiver plus a visual review of every listing's photo
set and caption before it enters the rotation (approach A).

## Goals

1. Posting resumes at the 20:30 Riyadh slot on 5 October on both channels and continues
   daily with one property per channel per day.
2. Nothing unseen goes out: every rotated listing has a reviewed photo selection (3–6
   frames) and a reviewed caption, bound by SHA-256 hashes to the live catalogue.
3. A missed day alerts the owner's Telegram through Uptime Kuma within the same evening.
4. Rollback is a single revert; already-published posts and ledgers are untouched.

## Non-goals (today)

TikTok, Snapchat, stories, a second daily slot, paid boosts, approval of the education pack
in PR #39 (it stays draft; the publisher merely learns to fall through to an approved pack
when one is due), and any change to the website build.

## Policy file — `marketing/daily/property-policy.json`

New fields; existing fields keep their values.

| Field | Value | Meaning |
|---|---|---|
| `adLicence.requirement` | `"waived"` | `"required"` keeps the old behaviour. |
| `adLicence.by` / `adLicence.on` | `"owner"` / `"2026-10-05"` | Who waived and when. A waiver without both, or with a future date, is an invalid policy and stops the run. |
| `adLicence.note` | text | The decision and the accepted exposure, for the record. |
| `countries` | `["SA"]` | Listing `location.countryCode` must be listed. |
| `categories` | `["buy","rent","off-plan"]` | Listing `category` must be listed. |
| `renders` | `"off-plan-only"` | Photo `kind: "render"` is accepted only for off-plan listings. `"none"` rejects renders everywhere. |
| `reviewValidDays` | `90` | A review stays valid this long while the listing facts, advertiser and caption hashes are unchanged (was a fixed 30). |
| `noEligibleProperty` | `"fallback-to-approved-pack-else-skip"` | Documented fall-through (see flow). |

## Eligibility (`lib/property-daily.mjs#eligibility`)

The function gains a `policy` argument (defaulting to the old strict behaviour so existing
callers and tests keep their meaning).

- Unchanged: `not_available`; `listing_changed_since_review`; `advertiser_changed_since_review`;
  `advertiser_details_incomplete`; `need_three_to_six_distinct_photos`;
  `photo_quality_or_provenance_unverified` (size ≥ 1080×720, aspect 0.8–1.91, 64-hex hash,
  bilingual alt, `visuallyApproved: true`, approved source host);
  `property_condition_services_and_rights_disclosures_pending`; `caption_changed_since_review`.
- Replaced: `requires_separate_market_or_offplan_review` becomes `outside_policy_scope`,
  driven by `policy.countries` and `policy.categories`.
- Skipped under a waiver: `missing_ad_licence`, `missing_or_expired_ad_licence`,
  `licence_and_marketing_authority_unverified`. Under `"required"` they behave exactly as today.
- New: `render_not_allowed` when a photo has `kind: "render"` and the policy or the listing
  category does not allow it. Any other `kind` remains `photo_quality_or_provenance_unverified`.
- `review_expired` uses `policy.reviewValidDays`.

## Caption (`propertyCaption`)

Arabic first, then English, then hashtags (the publishers already join these).

```
{title.ar}
{district.ar}، {city.ar} · للبيع | على الخارطة
{beds} غرف نوم · مساحة الأرض N م² | المساحة N م² · [تبدأ الأسعار من ]N ريال

<existing enquiry line with the listing reference, unchanged>

{legalDisclosures.ar}
المعلن: {advertiser.name.ar} · فال {advertiser.fal} · {advertiser.phone}
ترخيص الإعلان: N · ينتهي YYYY-MM-DD          ← only when the listing carries a number
الصور تصاميم تصوّرية من المطوّر.                ← all photos renders («بعض الصور …» when only some are)
```

English mirrors it (`Advertiser: … · FAL … · …`, `Ad licence N · Expires …`,
`Images are the developer's artist's impressions.` or `Some images are …`). Off-plan listings read "Off-plan" /
"على الخارطة" instead of "For sale". Price stays exactly as the website shows it: asking
price, or "From" when `price.from` is true, omitted when `onRequest`.

Hashtags come from a deterministic builder over listing facts (already bound by the review's
`factsSha256`), at most 12, in this order: brand `#بونا #BonaRealEstate`; city
`#عقارات_<city>` `#<City>RealEstate`; type `#<type>_<city>` `#<type>_للبيع|للإيجار` `#<City><Type>`
(villa فلل/Villas, apartment شقق/Apartments, duplex دوبلكس/Duplexes, townhouse تاون_هاوس/Townhouses,
penthouse, mansion, land); off-plan `#مشاريع_على_الخارطة #OffPlan`; district (first part before a
comma, at most three words) in Arabic and English; `#عقارات_فاخرة`. City-aware because the
in-scope stock includes Riyadh and Madinah projects.

## Review register — `marketing/daily/property-reviews.json`

Keyed by listing id. Entries written only by the approve script.

```json
"BONA-001": {
  "status": "approved",
  "reviewedAt": "2026-10-05T…Z",
  "reviewer": "claude-fable-5-1 — contact sheet and caption inspected",
  "factsSha256": "…", "advertiserSha256": "…", "captionSha256": "…",
  "licenceEvidence": null,
  "legalDisclosuresVerified": true,
  "legalDisclosures": { "ar": "…", "en": "…" },
  "photos": [ { "url": "https://…jpg", "sha256": "…", "width": 1920, "height": 1280,
                "kind": "photograph", "visuallyApproved": true,
                "alt": { "ar": "…", "en": "…" } } ]
}
```

Standard disclosures (no invented condition or service claims):

- ar: «الأسعار المعروضة هي الأسعار المطلوبة وقابلة للتغيير. تُؤكَّد التفاصيل والحالة والخدمات
  عند المعاينة.» Off-plan adds: «مواعيد التسليم والمواصفات حسب المطوّر.»
- en: "Prices shown are asking prices and may change. Details, condition and services are
  confirmed at viewing." Off-plan adds: "Delivery dates and specifications are per the developer."

## Review tooling

`scripts/social/draft-property-reviews.mjs --out DIR [--ids BONA-001,…]`

- Reads the live catalogue and the policy. For every in-scope listing not already approved
  with matching hashes: fetches each image (max 10, JPEG, ≤ 8 MB), records SHA-256 and
  dimensions, keeps the frames that pass the size and aspect rules in website order, and
  writes `DIR/BONA-xxx.jpg`, a labelled contact sheet (index, dimensions, English alt), plus
  `DIR/drafts.json` with the candidate photos, the composed caption and any blocking reasons.
- Never writes the register, never uploads.

`scripts/social/approve-property-review.mjs --drafts DIR/drafts.json --reviewer "who looked" --select BONA-001:1,2,3 …`

- Writes approved entries for the selected frames (3–6, in the given order). `kind` defaults to
  `render` for off-plan listings and `photograph` otherwise; a per-frame suffix overrides it
  (`BONA-022:1,2p,4` marks frame 2 a real photograph, `r` marks a render). Selected frames must
  sit within 15% of the first frame's aspect ratio, because Instagram crops every carousel frame
  to the first one. Stamps `reviewedAt` and the named `reviewer`, fills the standard
  disclosures, computes the hashes, re-reads the live catalogue, refuses a listing whose facts
  changed since drafting, re-runs `eligibility()` with the policy and refuses anything not
  eligible.
- Idempotent: an existing entry that differs only in `reviewedAt`/`reviewer` is left untouched.

The reviewer (Claude, this session) looks at every contact sheet before selecting frames.
A listing with fewer than three acceptable frames is left out and listed in the PR.

## Publisher flow (`daily-publish.mjs`)

1. Property path runs first, as today.
2. Result `published`, `already-published`, `ready` (dry run) or `not-due` → exit 0.
3. Result `skipped-no-eligible-property` → continue into the existing pack path. With no
   approved pack due, the run ends exactly as before ("No daily content due"). Nothing in
   the pack path changes.
4. Errors keep writing `~/bona-data/daily/alerts.jsonl` and exit 1.

Rotation stays oldest-first with a 30-day repeat interval, one post per channel per day.

## Heartbeat

- `~/bona-data/daily/heartbeat-<channel>.url` (mode 600, outside the repo) holds an Uptime
  Kuma push URL per channel. Absent file → no heartbeat, one log line.
- After a confirmed publication the publisher pushes `status=up`. When a run at or after
  22:30 Riyadh ends without a publication for that date it pushes `status=down&msg=<reason>`.
  A failed push is logged and never fails the run.
- Kuma: two push monitors "Bona daily post — instagram/facebook", expected every 24 h with a
  2 h grace, attached to the existing Telegram notification. Created through the Kuma API
  with the credentials in `~/.secrets/uptime-kuma.env`; if that path is blocked, the owner
  creates them (one minute each) and pastes the two URLs.
- Correction (found while planning): the agent heartbeats named in `marketing/daily/README.md`
  are real. They are ACTIVE Codex app automations (`bona-daily-publishing-checks` 20:45/21:45/22:45,
  `bona-weekly-social-replenishment` Thursdays 10:00) that report into a Codex chat thread, not
  Hermes jobs. They stay; the README now says where they live, and the Kuma heartbeat adds the
  path to the owner's Telegram.

## Tests

- `eligibility`: waiver skips exactly the three licence reasons; `required` keeps them;
  `outside_policy_scope` for OM/AE/ES and for categories not listed; `render_not_allowed`
  outside off-plan; `reviewValidDays` honoured; policy validation rejects a waiver without
  `by`/`on` or with a future date.
- `propertyCaption`: advertiser line always present; licence line only with a number; render
  note only with a render; off-plan wording; hashtag builder ≤ 12 and ≤ 30 total.
- Publisher flow: a skipped property result continues into the pack path; published / ready
  / not-due stop. Heartbeat: up on publication, down only at or after 22:30, silent without
  the URL file, never throws.
- Draft/approve scripts: fixture catalogue and sharp-generated JPEGs; size and aspect
  filtering, order, contact-sheet creation, register refusal of ineligible entries,
  idempotent rewrite.
- Live, read-only: `BONA_DAILY_TEST_NOW=2026-10-05T17:30:00Z node scripts/social/daily-publish.mjs instagram --dry-run`
  must print `Ready after read-only preflight: bona-daily-ig-2026-10-05, BONA-…`; same for
  facebook. `npm test` green; `npm run build` unchanged (129 pages).

## Shipping and verification

PR against `main`; Claude review then Codex review (owner rule); squash merge. The timer's
`ExecStartPre` syncs `~/bona-publish` to `origin/main` at 20:30, but the sync is also run by
hand after the merge and the dry run repeated from `~/bona-publish`. At ~20:36 Riyadh the
ledgers (`~/bona-data/ig/published.jsonl`, `~/bona-data/fb/published.jsonl`) and the live
permalinks are checked and reported.

## Rollback

`git revert` of the squash commit restores the licence-gated policy. The review register is
inert under a `required` policy. Published posts and ledgers are untouched.

## Owner actions outside this change

Instagram bio website → `https://bona-real-estate.com/ig/`; GA4 key events for
`lead_created` and `whatsapp_click`; work the 28 leads still in stage "new".

## Additions during planning (2026-10-05)

- **Settling an uncertain attempt.** Today any failure after `intent` blocks the channel until
  someone edits the journal. A `confirmed-not-published` record (channel, date, id, evidence)
  written after the attempt now settles it, so recovery is an append after checking the
  provider, never a deletion and never a false `published`.
- **Meta can fetch the image hosts.** An unpublished Instagram carousel-item container created
  from a `tk-storage.azoz.uk` JPEG reached `FINISHED` (container 18116337718922966; it expires
  unpublished after 24 h). Both hosts answer `facebookexternalhit` with `image/jpeg`.
- **Live inventory probe.** 32 of the 42 in-scope listings have at least three frames that meet
  the photo rules. Out: the eight land plots (1024×768 map images only), BONA-W010 (portrait
  frames at aspect 0.77) and BONA-W016 (two usable frames). That is a month of daily posts
  without a repeat.

