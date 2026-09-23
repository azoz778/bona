# Bona — active next-session handoff

_Last verified: 2026-09-22 16:49 KSA. This file is the current operating handoff. The superseded 2026-09-09 version is preserved at `docs/checklists/history/2026-09-09-NEXT-SESSION.md`._

## Verified production state

- Website and API are live at `https://bona-real-estate.com/` and `https://api.bona-real-estate.com/health`.
- Current clean-repository validation passed before this handoff: tests, Astro check, and production build.
- GitHub Pages deployment is active; no open production PR remained at the 2026-09-22 audit.
- API health reports database, Retell, WhatsApp poller, and fan-out healthy; fan-out was `0 pending / 0 failed`.
- Instagram and Facebook publisher timers are enabled and active.
- `scripts/marketing/verify-integrations.mjs --no-write --json --strict` currently exits 1 because the Meta CAPI dataset-read probe returns `(#100) Missing Permission`. Do not describe the integration board as fully clean until this is resolved.

## Active work approved by Abdulaziz

1. Repair campaign/listing attribution, import Meta Ads spend, safely backfill deterministic historical attribution, and expose truthful ROI/coverage reporting.
2. Repair the failed North Obhur district-guide media package; present it for approval before publishing.
3. Prepare Saudi National Day 96 packages for Instagram, Facebook, and TikTok; present them for approval before publishing.
4. Keep current status/runbooks aligned with verified production state.
5. Present the genuine waiting-enquiry reply for approval before sending.

## Lead correction

The dashboard showed four WhatsApp records waiting for reply. Reading the actual conversations established that only one is a genuine property enquiry. One is a website vendor pitch and two are Amazon courier/private-message false positives. Nothing has been sent and no lead record has been changed. Lead-stage cleanup remains deferred by owner instruction.

## Deferred by owner

- Bulk stage assignment for the 16 records currently marked `new`.
- REGA advertising-licence/unpublishing decision for Saudi listings.

These remain important, but must not be silently changed while the approved work above is executed.

## Integration truth as of 2026-09-22 16:49 KSA

- **GA4:** site tag live and Measurement Protocol payload accepted; account-side Realtime/report ingestion still requires owner-side confirmation.
- **Meta Pixel:** live on the consented production site.
- **Meta CAPI:** configured, but the dataset-read probe is `error` because the current token lacks the required permission.
- **Google Search Console:** verification tag is live; account-side ownership and sitemap/reporting status still require confirmation in Search Console.
- **Snap Pixel/CAPI:** pending owner credentials/configuration.
- **TikTok Pixel:** pending owner configuration.
- **Bona API, Retell, Evolution:** live.

Run the verifier instead of copying this paragraph forward:

```bash
node scripts/marketing/verify-integrations.mjs --no-write --json --strict
```

## Marketing truth

- Instagram ledger: 19 successful publication records; recent failures include the North Obhur `skipped:no-jpeg` followed by `skipped:missed`.
- Facebook ledger: one opening post recorded.
- Both publisher timers are enabled and active.
- Generated queue currently contains licensed/blocked and unblocked content. A timer being healthy does not prove every planned item published.
- North Obhur and National Day packages are approval-gated. Do not schedule or publish them before Abdulaziz approves the exact assets and captions.

## Compliance and measurement priorities still open

- Current Saudi listing advertising-licence coverage remains the largest compliance gap.
- Ad-spend/lead attribution and ROI are not trustworthy until the active attribution work is merged, deployed, and verified.
- Do not infer campaign IDs, listing IDs, revenue, or ROAS from timing or message wording.

## Operating runbook

1. Work in an isolated worktree based on current `origin/main`.
2. Re-query live state before changing status documentation.
3. For code/automation changes, run tests, Astro check, build, and strict integration verification.
4. Obtain independent Claude and Codex reviews and clear all findings before merge.
5. Announce any production restart before performing it.
6. Merge through a PR, wait for checks, then verify the live behavior and exact target.
7. Record what remains account-side or owner-gated; never report intent as completion.

## Important constraints

- `src/data/listings.json` is generated; do not hand-edit it.
- Bona and TK are separate companies; do not reuse TK private data or branding.
- Never publish a Saudi property advertisement without the required recorded basis/licence.
- Never expose tokens, lead PII, or full message histories in commits or team notes.
- Client messages and social posts require owner approval before sending/publishing.
