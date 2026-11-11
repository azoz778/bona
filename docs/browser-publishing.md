# Daily TikTok and LinkedIn posts (browser publisher)

One TikTok video a day and one LinkedIn Page post each working day, fully automatic, posted
through Bona's own Windows Chrome (CDP `:9230`), which is logged in to both accounts. Owner decision
2026-10-20: same approved Saudi property register as Instagram/Facebook (under the 2026-10-05
ad-licence waiver), no per-post approval. Since 2026-10-21 a property every day, with
licence-free education only when no property is eligible.

| | TikTok `@bonarealestatesa` | LinkedIn Page "Bona \| بونا" (company 145349037) |
|---|---|---|
| When (Riyadh) | daily 21:45, retries 22:15, 22:45 (window 21:30–23:30, after Isha) | Sun–Thu 09:30, retries 10:00, 10:30 (window 09:00–12:00) |
| Media | a 9:16 silent reel rendered for TikTok | its own JPEGs (never the Instagram/Facebook files) |
| Caption | Arabic-led, one short English line, hashtags incl. `#عقارات_جدة #جدة #بونا` (≤ 2,200) | English-led, Arabic title and advertiser line, ≤ 5 hashtags (≤ 3,000) |
| Ledger | `~/bona-data/tiktok/published.jsonl` | `~/bona-data/linkedin/published.jsonl` |

Why a browser: TikTok's Content Posting API publishes private-only until an app audit, and
LinkedIn's posting API needs partner approval.

## Bona's own Chrome (`:9230`)

Both accounts are logged in in a Chrome that only this publisher drives:
`ops/systemd/bona-chrome.sh` starts it (profile `C:\Users\ASUS\AppData\Local\bona-social-chrome`,
CDP `http://localhost:9230`, a normal visible window started minimised, with the no-throttling
switches so a minimised window keeps rendering). The unit sets `BONA_CDP_URL=http://localhost:9230`
and `BONA_CHROME_ENSURE=…/ops/systemd/bona-chrome.sh`, so a run starts it when it is not running
(after a reboot, say). DevTools listens on 127.0.0.1 without `--remote-allow-origins=*`, so no web
page can open a DevTools socket to this profile.

Until 2026-11-08 the publisher used the shared automation Chrome on `:9222`
(`~/.claude/scripts/chrome-debug.sh`). Other bots browse with that one (LinkedIn job search and
applications) and it runs headless (user agent `HeadlessChrome`). On 2026-11-08 LinkedIn served it
a Cloudflare "Sorry, you have been blocked" page and TikTok had logged it out and showed a captcha.
Never point the publisher back at it.

Log in (once, and whenever a run reports `not logged in`):

```bash
bash ~/bona-publish/ops/systemd/bona-chrome.sh show https://www.tiktok.com/login     # @bonarealestatesa
bash ~/bona-publish/ops/systemd/bona-chrome.sh show https://www.linkedin.com/login   # a Page admin of company 145349037
```

## Monitoring (Uptime Kuma → owner's Telegram)

Push monitors "Bona daily post — tiktok" and "Bona daily post — linkedin" (next to — instagram /
— facebook), created with `ops/systemd/add-browser-monitors.py`; their push URLs are secrets in
`~/bona-data/daily/heartbeat-<channel>.url` (0600, never logged). Each live run reports
(`browserBeat()` in `browser-publish.mjs`, same rules as `heartbeatFor()`):

- **up** on a publication or "already published today" (also from an `--any-time` run);
- **down at once** while the channel is blocked by an `uncertain` post (no retry can clear it; also
  from an `--any-time` run);
- **down when the day's last run has no post**: a run that ENDED at or after the last timer time
  (`CHANNELS.<channel>.lastRun`: TikTok 22:45, LinkedIn 10:30 — the timers' last `OnCalendar`, a test
  keeps them equal). A run still going at that time absorbs the timer's start, so it is the last
  one; a missed earlier run caught up late (`Persistent=true`) that ends before it is not;
- nothing for dry runs, or for any other outcome of a run started outside the channel's window or days.

The monitors are created paused. Start them once the channel is posting:
`uv run --exclude-newer 2026-10-09 --with uptime-kuma-api==1.2.1 python3 ops/systemd/add-browser-monitors.py --resume`
(with `ssh -f -N -L 13010:127.0.0.1:3010 hermes-vps` open); re-running it only rewrites the URL files.

Backstops when no run reports at all: TikTok 26 h, LinkedIn 76 h (Thursday 09:30 → Sunday 10:30 is
73 h). A missing URL file or a failed push is logged and never changes the run's outcome. Before
2026-11-08 there were no monitors for these two channels: the 2026-10-21 posts went `uncertain` and
both channels sat blocked for 18 days with the alerts only in `<channel>/alerts.jsonl`.

## What gets posted

`scripts/social/browser-publish.mjs <tiktok|linkedin>` picks one item per channel per day
(`lib/browser-daily.mjs`):

- **Property every day** (owner, 2026-10-21: "posting properties all the time"; until then property
  on odd days and education on even days). Education is only the fallback when no property is
  eligible; if neither has anything, the run records `skipped-nothing-eligible` once and exits 0.
- **Property:** the live `social-catalogue.json` and `marketing/daily/property-reviews.json`
  through the same `chooseProperty()` / `eligibility()` as the Instagram/Facebook daily posts:
  fingerprinted listing facts, the advertiser fingerprint, approved frames, the review's
  `captionSha256`, the review age, the policy scope and the policy's `repeatDays` (14 Riyadh calendar days, read through
  `policyRules()`, the same value Instagram and Facebook use), counted **per channel** (TikTok and
  LinkedIn have their own ledgers). Never-posted first, then least recently posted on that channel. The catalogue is
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
  `make-reel.mjs --listing-json … --frames …` with the approved frames in this post's order and the
  advertiser/FAL pair on the closing card (no placeholder); TikTok education is a slideshow of
  the 1080x1920 cards. LinkedIn property images are the approved frames re-encoded at 1200 px with
  a small BONA mark. A listing approved padded to 4:5 (`"fit": "pad-4x5"`,
  docs/daily-property-publishing.md) gets a reel rendered with `--fit pad` from the source photos
  (each whole on a 9:16 ink canvas, no cover crop) and LinkedIn images re-encoded from the padded
  files without a second mark; both hashes of every frame are checked first. A land listing's plot
  cards go into the reel whole and still (`--fit pad --plain`: no Ken Burns move, no hook or lower
  third, which would cover the card's own text) and to LinkedIn re-encoded. A padded reel has no Ken
  Burns move either: each frame stays whole on its 9:16 canvas (`lib/reel-motion.mjs segmentFilter`).
  If a property's reviewed media is unavailable or changed before the intent record, the run logs it
  to `<channel>/alerts.jsonl` (`media-fallback`) and renders the next candidate, up to three; the
  spacing rule (no same family on consecutive days) applies as on Instagram. LinkedIn education uses the dark 1080x1350 card variant (Instagram had the
  light 1080x1350, Facebook the 1080x1080). Reels are silent by design.
- **Repeats look different:** a listing's second and later posts on a channel use another cover
  and frame order of the same approved frames (`pickFrames()`, the rule in
  docs/daily-property-publishing.md: never the sequence last posted on this channel),
  so TikTok gets a freshly rendered reel and LinkedIn re-encodes the frames in that order. The
  caption stays the reviewed one. The order is logged and written as `frameOrder` and `images` on
  the `intent` / `published` lines. A hand-written `published` line (see below) must carry
  `listingId`, and `frameOrder` if known.

## How a run goes

1. Outside the channel's window (or on a Friday/Saturday for LinkedIn) it does nothing.
2. Lock `~/bona-data/<channel>/.publish.lock` — dry runs too, since a dry run discards drafts.
   It is a kernel lock: `flock(LOCK_EX|LOCK_NB)` held on an open file descriptor for the whole run
   (taken with util-linux `flock` on our own fd; under the unit, ExecStart takes it on fd 9 and
   node verifies `BONA_LOCK_FD=9` is that file and holds the lock). The kernel releases it when the
   process ends or is killed, so there is no stale lock, takeover or token; the file's contents mean
   nothing. Read the ledger strictly (see below).
3. Choose, build the caption, render media into `~/bona-data/<channel>/assets/<date>/<item id>/` (a fallback candidate gets its own, the failed one's is removed), copy it to
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
   "hashtag#tag" link text, a trailing "…see more", and links: the caption's OWN web addresses
   (with or without the scheme, without punctuation right after them such as a full stop or «،»,
   found after emoji are removed) and — on LinkedIn only — LinkedIn's `lnkd.in` short links compare
   as one token, because LinkedIn swaps a link for its own short link; TikTok never makes lnkd.in
   links, so a video carrying one is not ours; any other address stays literal, so a post linking
   elsewhere never matches) AND the submission's evidence (the listing
   id, or the education topic line). TikTok reads each new video's own description element (not
   comments, not meta tags); LinkedIn reads the commentary block whose nearest post container is
   that post (not a reshared post, not comments). The success toast's URN is taken first when it
   qualifies the same way. The URL keeps the real URN type
   (`urn:li:activity|share|ugcPost`). A post whose id shows it was created before this run started
   (10 min clock slack) is never ours either, even when the baseline missed it — a repeat of the same
   listing carries the same caption: LinkedIn ids hold epoch ms (`id >> 22`), TikTok video ids epoch
   seconds (`id >> 32`); an id that does not decode to a plausible time is judged by the baseline only.
   Anything less → `uncertain`. Append `published` with `url`.
   If a page the confirmation needed (a list, or a new post's own page) was still a login, captcha or
   block page at the end — each page is tracked by its URL and forgotten only when THAT page later
   loads normally — the `uncertain` line and the alert carry `blocked` with the reasons (2026-10-21:
   TikTok answered "Access denied / HTTP 403"). A new post's own page that never shows the post is
   checked the same way, because a block page with a body (Cloudflare on `/feed/update/…`, a TikTok
   captcha) loads without any navigation error. Block pages are recognised by their structure only:
   an empty-body HTTP error fails the navigation itself (`net::ERR_HTTP_RESPONSE_CODE_FAILURE`) and
   Chrome's error page shows the status (read only once that error page is the document, never from
   the page before it). On it, and on any `chrome-error://` page, HTTP 401/403/429 or 999 (LinkedIn's
   "Request denied"), or `ERR_BLOCKED_BY_RESPONSE`, is `blocked`; any other status (404, 410, an empty
   500/503) is "answered HTTP nnn" and a network error (`ERR_INTERNET_DISCONNECTED`, …) "did not
   load", both `navigation` (one rule, `isRefusalStatus()` in `lib/cdp.mjs`). Cloudflare's page is
   matched by its title ("Attention Required! | Cloudflare", or "… used Cloudflare to restrict
   access"), or by text that BEGINS with "Sorry, you have been blocked" and carries a "Cloudflare Ray
   ID"; LinkedIn's security check by its `/checkpoint/` URL, a title that BEGINS with "Security
   Verification", or text that BEGINS with its heading (after at most the "LinkedIn" wordmark) — a
   post or comment quoting any of those lines inside a feed (or a post page whose title is the post's
   text) is not a block page. A new post's own page is checked only when the post is not on it at all.

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
| `Chrome DevTools not reachable` | Bona's Chrome not running and `bona-chrome.sh` could not start it | `bash ~/bona-publish/ops/systemd/bona-chrome.sh`; then `systemctl --user start bona-browser@tiktok.service` |
| `not logged in` / no "Edit profile" | Bona's Chrome lost the session | log in again: `bona-chrome.sh show https://www.tiktok.com/login` (or the LinkedIn login). Before a click nothing was recorded and the next tick retries; if it is the `blocked` reason of an `uncertain` line (the session went during the confirmation), the channel stays blocked until that day is settled as above |
| `captcha` / `verification` / `checkpoint` | the site wants a human check | solve it once in a `bona-chrome.sh show` window. Before a click nothing was recorded and the next tick retries; after one (it is the `blocked` reason of an `uncertain` line, e.g. a captcha on the new post's own page), also settle that day as above — the channel stays blocked until then |
| `refused this browser` (`blocked`) | the site served its block page (TikTok "Access denied / HTTP 403", Cloudflare "Sorry, you have been blocked") | look in a `bona-chrome.sh show` window; if the site keeps refusing, stop the timers and tell the owner — do not retry in a loop. Before a click nothing was sent; after one, settle the `uncertain` day as above |
| `Could not open <url>: net::ERR_…` / `Timed out loading <url>` / `did not load (Chrome error page: ERR_…)` / `answered HTTP nnn` (`navigation`: 404, 410, 5xx) | a network error on this PC, or the site failing | retries next tick; nothing was sent |
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
endpoint and the staging folder (defaults: Bona's own Chrome `http://localhost:9230`, started by
`ops/systemd/bona-chrome.sh` of the same checkout).

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

systemd runs its own COPY of the unit, so every change to `bona-browser@.service` (or its drop-in or
timers) reaches the timers only when `install-browser.sh` is run again; the code itself goes live on
the next run, because each run syncs `~/bona-publish` to `origin/main`.

**Rolling out a change to the units** (e.g. the 2026-11-08 move to Bona's own Chrome, which added
`BONA_CDP_URL` / `BONA_CHROME_ENSURE`), in this order, after the merge:

1. Bring the publish tree to the merge first — `install-browser.sh` installs from `~/bona-publish`
   as it stands, and its guard compares it with the LOCAL `origin/main` ref without fetching:
   `bash ~/bona-publish/ops/systemd/sync-publish-tree.sh ~/bona-publish` must end "now at" (or
   "already at") `origin/main (<the merge commit>)`. Then `bash ~/bona-publish/ops/systemd/install-browser.sh`
   (without `--enable` when the timers are already on); `systemctl --user cat bona-browser@.service | grep BONA_`
   must show `BONA_CDP_URL=http://localhost:9230`.
2. `bash ~/bona-publish/ops/systemd/bona-chrome.sh`, and a human logs in to both accounts in it
   (see "Log in" above: `bona-chrome.sh show https://www.linkedin.com/login`, the same for TikTok).
   A fresh profile is logged out, so a dry run before this fails with `not logged in`.
3. Settle any `uncertain` day (above) OUTSIDE both windows (TikTok 21:30–23:30, LinkedIn Sun–Thu
   09:00–12:00), or with both timers stopped (`systemctl --user stop bona-browser@tiktok.timer
   bona-browser@linkedin.timer`): once the blocking line is settled, the next in-window tick posts
   live. Then a dry run per channel and a look at its screenshots; start stopped timers again after.
4. Resume the Kuma monitors (`add-browser-monitors.py --resume`).

**Rollback:** revert the merge on `main` and push; then `sync-publish-tree.sh` (as in step 1, it must
end at the revert commit) and `install-browser.sh` AGAIN, and `systemctl --user cat
bona-browser@.service | grep BONA_` must print nothing. Without the reinstall the installed unit keeps
the new `Environment=` lines, and the reverted code still obeys them: it drives `:9230` with
`BONA_CHROME_ENSURE` pointing at the `bona-chrome.sh` the revert removed, so after the next reboot no
run can start a Chrome. With it, the reverted code goes back to the shared `:9222` Chrome that
LinkedIn blocks and TikTok logged out (see above) — so also STOP both timers
(`systemctl --user stop bona-browser@tiktok.timer bona-browser@linkedin.timer`) until a fix lands again.

Note: `marketing/daily/property-policy.json` still lists `channels: ["instagram","facebook"]`
because `property-publish.mjs` checks that list exactly; the TikTok/LinkedIn scope is this
document and the owner's 2026-10-20 instruction. The older LinkedIn rule in
`scripts/social/README.md` ("never a listing") is superseded by that instruction.
