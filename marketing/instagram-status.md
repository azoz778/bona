# Instagram @bonarealestatesa — current operating status

_Last verified: 2026-09-22 16:49 KSA. The superseded 2026-09-05 setup note is preserved at `marketing/history/2026-09-05-instagram-status.md`._

## Account and publication state

- Public profile: `https://www.instagram.com/bonarealestatesa/`
- Account is operating as a business profile and is linked to the live Bona website.
- Automated Instagram publisher timer: **enabled and active**.
- Publication ledger: **19 successful publication records** as of this verification.
- Public audit observed six feed posts; ledger totals also include Stories and should not be presented as feed-post count.
- Listing content that requires a Saudi advertising licence remains blocked by the queue’s licence controls.

## Current incident

The 2026-09-21 North Obhur district-guide carousel was not published:

1. publisher recorded `skipped:no-jpeg`;
2. the later retry window recorded `skipped:missed`.

A repaired package is being prepared. It must be visually validated and shown to Abdulaziz with its caption before any reschedule or publication.

## Facebook

- Bona Facebook publisher timer: **enabled and active**.
- Facebook publication ledger contains one opening post as of this verification.
- Timer health does not imply content volume or audience growth.

## Approval-gated content

- Repaired North Obhur carousel and caption.
- Saudi National Day 96 packages for Instagram, Facebook, and TikTok.

Do not publish or schedule these items until Abdulaziz approves the exact outputs.

## Verification commands

```bash
systemctl --user is-enabled bona-ig-publish.timer bona-fb-publish.timer
systemctl --user is-active bona-ig-publish.timer bona-fb-publish.timer
systemctl --user list-timers bona-ig-publish.timer bona-fb-publish.timer --all --no-pager
python ~/.hermes/profiles/bona/cache/audit_marketing.py
```

## Known distinction

- Publisher operational health, successful ledger rows, public feed count, and follower growth are different measurements.
- Do not claim a scheduled item published until the provider response and publication ledger both confirm it.
- Do not use TK-hosted/private creative material as a Bona-owned source unless its rights and cross-company use are explicitly established.
