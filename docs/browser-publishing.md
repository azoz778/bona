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
2. Lock `~/bona-data/<channel>/.publish.lock` — dry runs too, since a dry run discards drafts.
   It is a kernel lock: `flock(LOCK_EX|LOCK_NB)` held on an open file descriptor for the whole run
   (taken with util-linux `flock` on our own fd; under the unit, ExecStart takes it on fd 9 and
   node verifies `BONA_LOCK_FD=9` is that file and holds the lock). The kernel releases it when the
   process ends or is killed, so there is no stale lock, takeover or token; the file's contents mean
   nothing. Read the ledger strictly (see below).
3. Choose, build the caption, render media into `~/bona-data/<channel>/assets/<date>/`, copy it to
   `C:\Users\ASUS\AppData\Local\bona-social-upload\<run>\` (the Windows Chrome cannot read WSL paths).
4. Open **our own tab** (`PUT /json/new`), never touching other tabs; closed at the end.
5. Identity first. TikTok: *Edit profile* on `@bonarealestatesa` and TikTok's own session
   endpoint (`/passport/web/account/info/`) must say `bonarealestatesa`. LinkedIn: the composer
   actor is read inside the share modal (its name and its logo's image asset id) and must match
   LinkedIn's own record for company 145349037 (`/voyager/api/organization/companies/145349037`:
   `entityUrn`, `name`, logo `digitalmediaAsset`, `viewerPermissions.canUpdateOrganizationProfile`).
   The baseline is then taken from BOTH places each account lists posts, each only once it shows
   rendered posts or the site's explicit empty state (TikTok profile grid items, or both lines of
   "Upload your first video / Your videos will appear here"; Studio rows, or both lines of "No posts
   yet"; LinkedIn admin feed items; LinkedIn public posts, or "doesn't have any posts"). The
   "Start a post" box is not a signal. A page that does not settle stops the run before upload.
6. Upload, type the caption, read the caption box back and compare (whitespace-normalised).
7. Re-check the window on the real clock, append `intent` (fsync'd before the click), wait for
   the Post button to be enabled, and only then re-check the account / Page actor and the caption
   box and click **Post** once (a dry run runs these same pre-click checks, then discards). A
   caption mismatch at that point records `confirmed-not-published` (nothing was clicked). If TikTok
   answers with its "Post now" confirmation, that is pressed at most once too. Neither is ever
   pressed again.
8. Confirm — only TOP-LEVEL posts are candidates (a reshared/quoted container never is), and each
   new one is read in full first: LinkedIn from its own page `/feed/update/<urn>/` with "…see more"
   expanded, TikTok from `/video/<id>` with the description's "more" expanded. A post counts only if
   it is new (not in the baseline) AND the post's OWN text node
   contains the FULL submitted caption (normalised only for whitespace, emoji, LinkedIn's
   "hashtag#tag" link text and a trailing "…see more") AND the submission's evidence (the listing
   id, or the education topic line). TikTok reads each new video's own description element (not
   comments, not meta tags); LinkedIn reads the commentary block whose nearest post container is
   that post (not a reshared post, not comments). The success toast's URN is taken first when it
   qualifies the same way. The URL keeps the real URN type
   (`urn:li:activity|share|ugcPost`). Anything less → `uncertain`. Append `published` with `url`.

Everything burned into the media (reel hook, subhook, lower third, CTA lines, card slides) goes
through the same refusal as the caption: no `{{…}}` placeholder, never «تقييم مجاني». The reel's
ad-licence line follows the caption's rule exactly (a number with a real expiry); property
outside the Kingdom keeps the developer-authorisation CTA. SIGTERM/SIGINT (stop, unit timeout)
closes our tab, removes the staged copies and releases the lock; an intent already written stays,
so the day is uncertain rather than posted twice.

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

The ledger is read strictly: any line that is not a JSON record stops every run ("line N is not a
ledger record") until it is fixed by hand — a corrupt audit trail never reads as "nothing
published". The one exception is a final line with no newline (a crash mid-write): the run
newline-terminates it, appends `{"status":"uncertain","reason":"truncated final ledger line repaired"}`
for today and stops; settle that day as below.

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

## Voyager fields relied on

The LinkedIn actor check reads LinkedIn's own record for the Page from the logged-in tab:
`GET /voyager/api/organization/companies/145349037` (same-origin `fetch` with the page's cookies,
`csrf-token` = the `JSESSIONID` cookie, `accept: application/vnd.linkedin.normalized+json+2.1`).
Fields used, all under `data`:

| field | must be |
|---|---|
| `entityUrn` | `urn:li:fs_normalized_company:145349037` |
| `name` | `Bona \| بونا` (and equal to the composer actor's name) |
| `logos.logo.digitalmediaAsset` (fallback `logo.image.digitalmediaAsset`) | `urn:li:digitalmediaAsset:<id>` where `<id>` is the asset in the composer actor's `…/dms/image/v2/<id>/company-logo…` picture |
| `viewerPermissions.canUpdateOrganizationProfile` | `true` (the logged-in member administers the Page) |

The record is fetched first; then ONE page evaluation reads the actor inside the share modal,
compares it, and returns the Post button's position, and the only thing after it is the click.
If LinkedIn renames or blocks this endpoint, every LinkedIn run stops before the click.

## What a refusal looks like

A refusal stops the run before anything is sent and lands in `~/bona-data/<channel>/alerts.jsonl`
(and the journal of `systemctl --user status bona-browser@<channel>`), e.g.:

```json
{"channel":"linkedin","status":"needs-attention","kind":"wrong-actor","reason":"LinkedIn: composer actor logo C4E0AQ… is not the logo of company 145349037","at":"2026-10-21T06:31:12.004Z"}
```

```
browser-publish linkedin: LinkedIn: composer actor logo C4E0AQ… is not the logo of company 145349037
```

If the refusal came after `intent` (the pre-click checks), the ledger also gets
`{"status":"confirmed-not-published","evidence":"failed before Post was clicked: …"}` and the next
tick retries; before `intent` nothing is written to the ledger at all. Only `status:"uncertain"`
alerts (exit 2) need the reconciliation above. A busy lock exits 75 from the unit's `flock` (or
`another run holds …` from a hand run) and writes nothing.

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
| `line N is not a ledger record` | hand edit or disk damage | fix that line (keep every real record); nothing runs until then |
| `truncated final ledger line repaired` (exit 2) | a crash mid-write | settle the day as above |
| `TikTok session is @…, not @bonarealestatesa` / `wrong-actor` | another account logged in, or the composer is not the Page | fix the login / Page role; nothing was sent |
| `baseline` (`grid did not load`, `… did not load`) | the account's post list did not load | retries next tick; nothing was sent |
| `another run holds …/.publish.lock` | a live or dry run is in progress | wait; the kernel frees the lock the moment the holder exits or is killed. **Never delete the lock file**: a run holding the old file would overlap with one locking a new file |
| exit 2, `uncertain` | see above | reconcile by hand |

A half-filled draft is discarded on failure, and a leftover "video you were editing wasn't saved"
TikTok draft is discarded before a new upload (never continued).

## Selectors (all in `scripts/social/lib/browser-sites.mjs` → `SELECTORS`)

TikTok Studio (`/tiktokstudio/upload`): `[data-e2e="edit-profile-entrance"]` (own-profile proof),
`/passport/web/account/info/?aid=1988` → `data.username` (account, also right before Post),
`[data-e2e="user-post-item"]` / "Upload your first video" (profile grid loaded), "No posts yet" or
`a[href*="/video/"]` (Studio list loaded), `[data-e2e="browse-video-desc"], [data-e2e="video-desc"]`
+ `og:description` (a video's description, for binding),
`input[type="file"][accept*="video"]`, `[data-e2e="upload_status_container"]` ("Uploaded"),
`[data-e2e="caption_container"] [contenteditable="true"]` (Draft.js editor),
`[data-e2e="post_video_button"]`, `[data-e2e="discard_post_button"]`, `[role="dialog"] button`
("Discard" confirm, "Post now"); popups dismissed by button text "Cancel" (automatic content
checks) and "Got it", only inside `[role="dialog"]`, popover or tooltip containers. Captcha: `#captcha-verify-container`, `.captcha-verify-container`,
`#captcha_container`, `[class*="captcha_verify"]`, `iframe[src*="captcha"]`.

LinkedIn Page admin (`/company/145349037/admin/page-posts/published/`): `main button` with text
"Start a post", `.share-box-v2__modal`, `.share-unified-settings-entry-button` (actor = "Bona | بونا"),
`button[aria-label="Add media"]`, `#media-editor-file-selector__file-input` (multiple, JPEG/GIF),
modal button "Next", `.ql-editor` (Quill), `.share-actions__primary-action` (Post), actor proof:
`.share-unified-settings-entry-button` name + `img[src*="company-logo"]` matched against the admin
rail's logo and `a[href*="/company/145349037/admin/settings"]`,
`button[aria-label="Dismiss"]` + `.artdeco-modal--layer-confirmation` "Discard",
toast `a[href*="/feed/update/"]`; post elements `[data-urn], [data-id], [data-activity-urn]`.

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
installs `npm ci --omit=dev` when `package-lock.json` changes (sharp is needed to render) — in
`~/bona-data/.deps-build`, swapped into the tree only after it succeeded and sharp loads, with
`npm_config_cache=~/bona-data/.npm` (home is read-only in the unit). Photo downloads retry twice on
a network error (the media host resets connections from this box); a hash mismatch never retries. `MemoryMax=3G` for the reel's cross-fades; `/mnt/c/…/bona-social-upload` is the one
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
