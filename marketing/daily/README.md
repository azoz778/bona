# Reviewed daily publishing

Owner authorization on 2026-09-28 covers ongoing daily quality-controlled organic posting,
review/implementation/deployment, and activation. No paid ads, new property claims, or TikTok
posting permission is inferred. This release is the first reserve, Sept 28–Oct 4.

## Schedule and continuation
- One IG post and one FB post per day at 20:30 Asia/Riyadh. Retry checks at quarter-hour
  intervals until 22:45. At/after 23:00 no new post, no backfill, no date shifting.
- Only `marketing/daily/instagram.json` and `facebook.json` are read. No legacy source flags.
- New `bona-daily@instagram.timer` and `bona-daily@facebook.timer` own daily dispatch.
  Old bona-ig-publish.timer / bona-fb-publish.timer must stay masked AND inactive; runner
  refuses otherwise. No missing-source, empty-batch or exhausted-batch fallback exists.
- Since 2026-10-02 the timers run the property policy first (`docs/daily-property-publishing.md`).
  Since 2026-10-05 this reviewed pack is used only when no property is eligible and a pack day
  is due.
- Codex app automations, outside this repo, inspect and replenish this pipeline:
  `bona-weekly-social-replenishment` (Thursdays 10:00 Riyadh) and `bona-daily-publishing-checks`
  (20:45, 21:45, 22:45 Riyadh). They report into their Codex chat; they are not evidence that a
  post is live. Alerting to the owner's phone is the Uptime Kuma heartbeat described in
  `docs/daily-property-publishing.md`.

## Exact-release approval
`build-daily.mjs` creates 24 original typographic JPEGs and seven posts per channel. No
synthetic/property photos. `manifest.json` hashes source copy, schedule/channel JSON and
local JPEGs. `release.json` must be written only AFTER visual and Fable reviews pass,
with matching SHA256 of manifest, status approved, review model and evidence filenames.
Renderer output alone does not authorize execution. Public JPEG bytes are fetched and
compared with the reviewed hash immediately before every due Instagram invocation.
Instagram success-without-published-ledger also alerts. Guard/permission/transport failures fail closed and write `~/bona-data/daily/alerts.jsonl`.
The heartbeat alerts the owner/coordinator, with repeated identical states suppressed.

## Deployment ownership
API integration chat owns its main/API/Pages release first. Social chat then fetches/rebases,
reruns relevant tests, pushes its reviewed PR and deploys Pages assets. Verify every public
JPEG byte hash, sync actual `~/bona-publish` to clean origin/main, install dedicated units,
run ops/systemd/install-daily.sh from that checkout (hash-checks public assets, backs up and masks legacy timer/service units, installs and enables only new units), then validate current-time no-op and systemd schedule. Old installers now refuse; live legacy CLI sources also refuse.
If review/deploy misses a day, leave its original slot missed and notify; no manual force
or automatic catch-up. Rollback: disable both new timers first; preserve all ledgers/assets.

## Facebook uncertain intent
A stable channel/date id is checked under a daily Facebook lock. Before network publication,
a durable fsynced intent is written to `~/bona-data/daily/facebook.jsonl`. On success record
provider result there and append the legacy published ledger for history. A timeout/crash/
unknown outcome leaves intent and MUST NOT retry automatically. IG is an independent unit.
Owner/coordinator is notified through alerts + the configured publishing-check heartbeat.
Reconcile by reading the Page posts through the authenticated API and checking exact time,
copy and assets, not merely title. If found: under the same lock append status published,
id and actual postId (and append the history ledger if absent). If conclusively absent,
append confirmed-not-published with supporting evidence; only then can the SAME DATE/SLOT
retry within the window. If uncertain keep blocked. Do not infer absence from a failed API
query. Every new unresolved intent blocks again, even after an earlier resolved attempt.

## Licence and content
REGA listing guard remains unchanged. Editorial is limited to practical viewing and
preparation prompts: no specific listing, no invented inventory/price/valuation/access.
Future photography needs verified source/location and actual visual curation. Missing
facts stay unknown. Exact artwork is inspected, not accepted on test counts alone.
