# Daily TikTok and LinkedIn posts (browser publisher)

One TikTok video a day and one LinkedIn Page post each working day, fully automatic, posted
through the Windows Chrome that is already logged in to both accounts. Owner decision
2026-10-20: same approved Saudi property register as Instagram/Facebook (under the 2026-10-05
ad-licence waiver), interleaved with licence-free education, no per-post approval.

| | TikTok `@bonarealestatesa` | LinkedIn Page "Bona \| بونا" (company 145349037) |
|---|---|---|
| When (Riyadh) | daily 21:45, retries 22:15, 22:45 (window 21:30–23:30, after Isha) | Sun–Thu 09:30, retries 10:00, 10:30 (window 09:00–12:00) |
| Media | a 9:16 silent reel rendered for TikTok | its own JPEGs (never the Instagram/Facebook files) |
| Caption | Arabic-led, one short English line, hashtags incl. `#عقارات_جدة #جدة #بونا` (≤ 2,200) | English-led, Arabic title and advertiser line, ≤ 5 hashtags (≤ 3,000) |
| Ledger | `~/bona-data/tiktok/published.jsonl` | `~/bona-data/linkedin/published.jsonl` |

Why a browser: TikTok's Content Posting API publishes private-only until an app audit, and
LinkedIn's posting API needs partner approval. Both accounts are logged in in the shared
debug Chrome (CDP `http://localhost:9222`, started by `~/.claude/scripts/chrome-debug.sh`).

## What gets posted

`scripts/social/browser-publish.mjs <tiktok|linkedin>` picks one item per channel per day
(`lib/browser-daily.mjs`):

- **Property on odd days, education on even days** (day number since the epoch, so it alternates
  across month ends). If the preferred kind has nothing eligible, the other one is used; if
  neither has anything, the run records `skipped-nothing-eligible` once and exits 0.
- **Property:** the live `social-catalogue.json` and `marketing/daily/property-reviews.json`
  through the same `chooseProperty()` / `eligibility()` as the Instagram/Facebook daily posts:
  fingerprinted listing facts, the advertiser fingerprint, approved frames, the review's
  `captionSha256`, the review age, the policy scope and the 30-day repeat interval, counted **per
  channel** (TikTok and LinkedIn have their own ledgers). Oldest-unposted-first. The catalogue is
  read again just before upload; a changed listing stops the run before anything is sent. If the
  catalogue is unavailable or stale, property is off for that run and education is used.
- **Captions** are built from the reviewed copy itself (`reviewedCopy()`, checked against the
  review's `captionSha256`), so the disclosures are the Instagram ones: price disclaimer, viewing
  or off-plan disclaimer, `المعلن … · فال 1100313556 · phone`, the ad-licence line once a listing
  carries a number, the render note for developer renders, and the photo note when set.
  `refuseText()` runs on every caption (no `{{AD_LICENCE}}`, never «تقييم مجاني»).
- **Education:** the reviewed daily-pack notes in `marketing/daily/content.json`, then the
  education cards in `lib/editorial.mjs` (minus `edu-ad-licence`, which explains the per-ad licence
  the waiver does without). Oldest-unposted-first per channel; an item repeats after 28 days.
- **Media, never the same file on two platforms:** TikTok property reels come from
  `make-reel.mjs --listing-json … --frames …` with the approved frames in review order and the
  advertiser/FAL pair on the closing card (no placeholder); TikTok education is a slideshow of
  the 1080x1920 cards. LinkedIn property images are the approved frames re-encoded at 1200 px with
  a small BONA mark; LinkedIn education uses the dark 1080x1350 card variant (Instagram had the
  light 1080x1350, Facebook the 1080x1080). Reels are silent by design.

## How a run goes

1. Outside the channel's window (or on a Friday/Saturday for LinkedIn) it does nothing.
2. Lock `~/bona-data/<channel>/.publish.lock`; read the ledger. `published` today → "already
   published", exit 0. Anything `intent`/`uncertain` without a later settling line → stop (exit 1).
3. Choose, build the caption, render media into `~/bona-data/<channel>/assets/<date>/`, copy it to
   `C:\Users\ASUS\AppData\Local\bona-social-upload\<run>\` (the Windows Chrome cannot read WSL paths).
4. Open **our own tab** (`PUT /json/new`), never touching other tabs; closed at the end.
5. Identity first: TikTok must show *Edit profile* on `@bonarealestatesa` (only the owner sees
   it); LinkedIn must show *Start a post* on the Page admin and the composer must say it posts
   as **Bona | بونا** (not the personal profile). Existing video ids / post URNs are noted.
6. Upload, type the caption, read the caption box back and compare (whitespace-normalised).
7. Re-check the window on the real clock, append `intent`, click **Post**.
8. Confirm: TikTok — a new `/@bonarealestatesa/video/<id>` on the profile or Studio content
   list; LinkedIn — the "View post" toast URN or a new activity URN whose post shows the caption's
   first line, on the Page's admin post list or public posts page. Append `published` with `url`.

Screenshots of every stage land in `~/bona-data/<channel>/shots/`; failures also go to
`~/bona-data/<channel>/alerts.jsonl`.

## Ledger and the `uncertain` block

One JSON line per event, `{channel, date, id: "bona-<channel>-<date>", kind, itemId, listingId?, status, url?, at}`:

| status | meaning | next run |
|---|---|---|
| `intent` | written right before Post was clicked | blocks (a crash here is unknown) |
| `published` | the new post was seen on the account; `url` recorded | "already published" |
| `uncertain` | Post was clicked but the post was not seen within the confirmation window | **blocks the channel**, every later day too |
| `confirmed-not-published` | failed before any click reached Post (button disabled/vanished), or a human settled an uncertain one | retries |
| `skipped-nothing-eligible` | nothing to post today | — |

**To unblock `uncertain`** (exit 2, `systemctl --user --failed` shows it):

1. Look at the account: TikTok Studio → Posts (`https://www.tiktok.com/tiktokstudio/content`) or
   the LinkedIn Page → Page posts. Check the screenshots in `~/bona-data/<channel>/shots/`.
2. If the post **is live**, append the URL so it is never posted again:
   ```bash
   echo '{"channel":"tiktok","date":"2026-10-21","id":"bona-tiktok-2026-10-21","kind":"property","itemId":"BONA-001","listingId":"BONA-001","status":"published","url":"https://www.tiktok.com/@bonarealestatesa/video/…","manual":true,"at":"'$(date -u +%FT%TZ)'"}' >> ~/bona-data/tiktok/published.jsonl
   ```
3. If it is **not** live (and no half-posted draft is processing), append:
   ```bash
   echo '{"channel":"tiktok","date":"2026-10-21","id":"bona-tiktok-2026-10-21","status":"confirmed-not-published","evidence":"checked Studio by hand","at":"'$(date -u +%FT%TZ)'"}' >> ~/bona-data/tiktok/published.jsonl
   ```
   The next tick (inside the window) posts again. Use the same `id` and `date` as the blocking line.

## Failure modes

| Symptom (journal / alerts.jsonl) | Cause | Fix |
|---|---|---|
| `Chrome DevTools not reachable` | debug Chrome not running and `chrome-debug.sh` could not start it | `~/.claude/scripts/chrome-debug.sh`; then `systemctl --user start bona-browser@tiktok.service` |
| `not logged in` / no "Edit profile" | the debug profile lost the session | log in again in that Chrome (`chrome-debug.sh headed`) |
| `captcha` / `verification` / `checkpoint` | the site wants a human check | solve it once in the headed debug Chrome; the next tick retries (nothing was recorded) |
| `not an admin of this Page` / `posts as "…", not the Page` | LinkedIn member lost Page admin, or the composer defaulted to the person | fix the role / actor; nothing was sent |
| `Caption box does not hold the caption` | a popup stole focus mid-typing (retried 3×) or the editor changed | look at `failed-before-post.png`; adjust `lib/browser-sites.mjs` |
| `upload-timeout` | slow upload / processing | retries next tick |
| `caption refused` / `caption changed since review` | compliance stop | fix the review or the copy; nothing was sent |
| exit 2, `uncertain` | see above | reconcile by hand |

A half-filled draft is discarded on failure, and a leftover "video you were editing wasn't saved"
TikTok draft is discarded before a new upload (never continued).

## Selectors (all in `scripts/social/lib/browser-sites.mjs` → `SELECTORS`)

TikTok Studio (`/tiktokstudio/upload`): `[data-e2e="edit-profile-entrance"]` (own-profile proof),
`input[type="file"][accept*="video"]`, `[data-e2e="upload_status_container"]` ("Uploaded"),
`[data-e2e="caption_container"] [contenteditable="true"]` (Draft.js editor),
`[data-e2e="post_video_button"]`, `[data-e2e="discard_post_button"]`, `[role="dialog"] button`
("Discard" confirm, "Post now"); popups dismissed by button text "Cancel" (automatic content
checks) and "Got it". Captcha: `#captcha-verify-container`, `.captcha-verify-container`,
`#captcha_container`, `[class*="captcha_verify"]`, `iframe[src*="captcha"]`.

LinkedIn Page admin (`/company/145349037/admin/page-posts/published/`): `main button` with text
"Start a post", `.share-box-v2__modal`, `.share-unified-settings-entry-button` (actor = "Bona | بونا"),
`button[aria-label="Add media"]`, `#media-editor-file-selector__file-input` (multiple, JPEG/GIF),
modal button "Next", `.ql-editor` (Quill), `.share-actions__primary-action` (Post),
`button[aria-label="Dismiss"]` + `.artdeco-modal--layer-confirmation` "Discard",
toast `a[href*="/feed/update/"]`; confirmation by `urn:li:activity:<id>` in the page markup.

Typing goes through `Input.insertText` line by line with Shift+Enter between lines (both editors
make paragraphs; a plain Enter would pick a hashtag suggestion). Clicks are real mouse events at
the element's centre (`Input.dispatchMouseEvent`), so React/Ember handlers fire.

## Running it by hand

```bash
cd ~/bona-publish   # or any checkout with node_modules (sharp)
node scripts/social/browser-publish.mjs tiktok   --render-only --any-time   # choose + render only, no browser
node scripts/social/browser-publish.mjs tiktok   --dry-run --any-time        # fill the real form, screenshot, DISCARD
node scripts/social/browser-publish.mjs linkedin --dry-run --any-time --kind education --shots /tmp/shots
node scripts/social/browser-publish.mjs tiktok                               # live (inside the window)
```

`--dry-run` writes nothing to the ledger. `--any-time` ignores the window (a live run with it
posts now). `--kind property|education` forces a kind (no fallback). `BONA_DATA` moves the data
directory; `BONA_CDP_URL`, `BONA_UPLOAD_DIR_WSL` / `BONA_UPLOAD_DIR_WIN` override the browser
endpoint and the staging folder.

## Install

Units: `ops/systemd/bona-browser@.service` (+ `bona-browser@.service.d/ipv4first.conf`),
`bona-browser@tiktok.timer`, `bona-browser@linkedin.timer`. They run from `~/bona-publish`
exactly like `bona-daily@` (sync to `origin/main`, `guard-main.sh`), plus `ensure-deps.sh`, which
runs `npm ci --omit=dev` in the publish tree when `package-lock.json` changes (sharp is needed to
render). `MemoryMax=3G` for the reel's cross-fades; `/mnt/c/…/bona-social-upload` is the one
writable path outside home.

```bash
bash ~/bona-publish/ops/systemd/install-browser.sh            # install units, do not enable
(cd ~/bona-publish && node scripts/social/browser-publish.mjs tiktok --dry-run --any-time)
systemctl --user enable --now bona-browser@tiktok.timer bona-browser@linkedin.timer
systemctl --user list-timers 'bona-browser@*'
journalctl --user -u 'bona-browser@*' -o cat -f
systemctl --user stop bona-browser@tiktok.timer                 # pause one channel
```

Note: `marketing/daily/property-policy.json` still lists `channels: ["instagram","facebook"]`
because `property-publish.mjs` checks that list exactly; the TikTok/LinkedIn scope is this
document and the owner's 2026-10-20 instruction. The older LinkedIn rule in
`scripts/social/README.md` ("never a listing") is superseded by that instruction.
