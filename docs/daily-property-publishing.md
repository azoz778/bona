# Daily property photography

The owner requested daily posts about current Bona website properties, using clear
actual photographs. The existing Instagram and Facebook daily units remain at
20:30 Asia/Riyadh. No second timer or cloud automation is installed. The property
policy replaces the finite editorial pack at the existing entry point; the old
pack, renderer, receipts and publication history remain intact for rollback.

## Current eligibility

On 2 October 2026, all 48 local and deployed catalogue records had no advertising
licence, and the curated licence register was empty. No property is approved for
publication. The policy intentionally skips with a reason instead of using old
editorial cards, filling licence placeholders, or promoting an unverified listing.
The owner's FAL brokerage number is not a property advertisement licence.

The first Al Khalidiyah (BONA-005) draft was withdrawn before publication: the
live catalogue marks it sold while the local checkout still said available.
The draft builder now reads the live feed and refuses unavailable stock. The
replacement private draft is BONA-001, Durrat Al Arous, with original pool,
beach-access and living-room photographs, each 1920×1280. It is available in the
live catalogue but remains blocked by missing advertising-licence evidence.
No generative artwork, crop, stretch, upscaling, ROI or urgency claim is used.

## Admission and publication

- `/social-catalogue.json` exposes only public listing fields and public advertiser
  contact information. It is built by the existing website deployment, including
  its daily 06:00 Riyadh refresh. Data older than 48 hours fails closed.
- `marketing/daily/property-reviews.json` holds explicit reviewed photo selections.
  An empty register means no property post. Do not insert fictional licence data.
- A review binds the current listing, advertiser, bilingual caption, original photo
  URLs and SHA-256 bytes. Three to six actual photographs must pass visual review
  and size/aspect checks. Unseen photos, renders and altered source bytes fail.
- Saudi ready-property sale/rental posts require a valid property ad number and
  expiry, evidence of marketing authority/social channel coverage, matching contact
  details, and verified bilingual disclosures of condition, services and rights.
  Off-plan and non-Saudi listings need a separate verified workflow and are skipped.
- Evidence and visual/copy reviews expire after 30 days. Any changed listing facts
  require renewed review. No invented condition, encumbrance or service statement.
- Each channel rechecks account identity and reads the live catalogue again just
  before upload. Current stock, price, licence and advertiser must still match.
- The existing daily ID is reused, so a previous editorial post occupies that day's
  slot. A per-channel lock, existing ledgers and durable intent prevent duplicates.
  An uncertain send stops retries until reconciled. Published properties rotate
  oldest-first, with a minimum 30-day interval; exhaustion skips, never recycles.
- Runs before 20:30 or from 23:00 onward do nothing. No missed-day backfill.

## Preparing and admitting a property

Run `node scripts/social/build-property-preview.mjs BONA-ID NEW_OUTPUT_DIR 3,6,4`
with verified source image indices. It preserves original JPEG bytes and prepares
a responsive Arabic-first HTML review, captions and a **draft** receipt; it never
publishes, approves content or edits the live register.

Inspect every original image and the Arabic/English captions. Verify the actual
licence, marketing authority, channel coverage, contact match and all mandatory
property disclosures. Record evidence references, verifiedAt, matching adNumber
and adExpiry in licenceEvidence; do not store private contracts in Git. Record
legalDisclosures in both languages and legalDisclosuresVerified only after checking
them. Recompute factsSha256, advertiserSha256 and captionSha256 using the exported
helpers. Only then mark each photograph visuallyApproved, kind photograph, set
reviewedAt and status approved, and add the review under its real listing ID.

The runtime uses the original public JPEGs on Instagram and downloads those same
hash-verified files for native Facebook photo uploads. Captions carry the property
reference, viewing CTA and required verified disclosures. No new asset hosting is
needed. Changed or unavailable photos stop publication.

## Verification and operations

`BONA_DAILY_TEST_NOW=2026-10-02T17:30:00Z node scripts/social/daily-publish.mjs instagram --dry-run`
simulates the slot with read-only provider calls. Use the current date for future
checks. Dry run performs no media creation, publication or journal writes.

Runtime evidence is in `~/bona-data/daily/property.jsonl`; existing IG/FB ledgers
remain authoritative for already-published posts. A failed preflight is recorded
by the existing daily alert path. Never clear an intent to force a retry without
checking the provider and existing ledger for the exact daily ID.

Instagram identity and publishing permissions and Facebook Page identity and
posting permissions were verified live on 2 October. TikTok's Events integration
is configured, but no production Accounts grant or app credentials were found;
the implemented Accounts module explicitly disables publishing. Snapchat's tracked
configuration is blank. Neither channel is enabled by this policy.

Rollback: revert the property-pipeline commit through the normal repository flow.
This restores the original finite pack without altering already-published posts or
the timer. The publisher must remain a clean checkout of origin/main; do not edit
the live detached worktree to bypass guard-main.sh.

Regulatory source checked 2 October 2026: Articles 3, 5 and 6 of
https://www.uqn.gov.sa/decisions-and-regulations/authorities/4000857.
