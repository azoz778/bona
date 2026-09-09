# Bona — social content engine

Turns `src/data/listings.json` into vertical video, carousels and story cards, and schedules
them across seven platforms. Faceless by design: property only, no person on camera.

Everything is rendered locally with **sharp** (stills, all text) and **ffmpeg** (motion). No
paid API, no image model, no cost.

```
scripts/social/
  make-reel.mjs        one listing -> 9:16 1080x1920 MP4, 12-25 s, silent
  make-carousel.mjs    one listing -> 4-6 slides, 1080x1350 (or 1080x1080), PNG + JPEG
  make-story.mjs       1080x1920 story cards: new / price / sold / district / editorial
  queue.mjs            builds marketing/queue/queue.json — 30 days, 7 platforms
  publish.mjs          the unattended Instagram publisher (timer-driven; see "Publishing — Instagram")
  lib/                 fonts, design system, listing copy, photo resolution, cards
  lib/graph.mjs        the Instagram Graph API client shared with scripts/instagram-post.mjs
  fonts/               the six brand faces as .ttf (see fonts/README.md)
```

---

## The hard part: Arabic

`ffmpeg`'s `drawtext` does **not** shape or join Arabic. It draws isolated letterforms in
logical order, which is unreadable — `مرحبا` comes out as four unconnected glyphs, backwards.
There is no `drawtext` flag that fixes this.

So **no Arabic is ever given to ffmpeg.** Every Arabic string is rendered to a transparent
RGBA PNG by `lib/brand.mjs::text()`, which goes through sharp → **Pango 1.58 → HarfBuzz 14.3 →
FriBidi 1.0.16**. That stack does real shaping (initial/medial/final/isolated forms, lam-alef
ligatures) and real bidi reordering. ffmpeg only ever composites the finished pixels.

Three details that took a while to get right and are easy to break:

- **Pango's `foreground` rejects `rgba()`.** It takes `#rrggbb` or a colour name and errors
  with `text: invalid markup in text` otherwise. `splitColor()` splits any `rgba()` into a hex
  colour plus a span `alpha`.
- **Base direction.** Pango picks direction from the first strong character, so an Arabic line
  that opens with a digit lays out left-to-right. Every string is prefixed with U+200F (RLM)
  or U+200E (LRM) by `rtl()` / `ltr()`.
- **Numbers inside Arabic.** `iso()` wraps a Latin/numeric run in U+2066…U+2069 so bidi cannot
  reorder it against neighbouring punctuation. Without it `{{AD_LICENCE}}` and phone numbers
  land at the wrong end of the line. A slide counter like `1 / 3` is rendered LTR outright,
  because in an RTL run bidi turns it into `3 / 1` and silently reverses its meaning.

**Verify by looking.** After any change to type or layout:

```bash
node scripts/social/make-reel.mjs --listing BONA-001
~/.local/bin/ffmpeg -ss 1.2 -i marketing/queue/reels/reel-BONA-001.mp4 -frames:v 1 /tmp/f.png
# then actually open /tmp/f.png
```

Connected script, right-aligned, reading right to left. If letters are separated or the line
reads backwards, the Pango path is not being used.

---

## Running them

```bash
# one reel (12-25 s, silent, 9:16)
node scripts/social/make-reel.mjs --listing BONA-001
node scripts/social/make-reel.mjs --listing rihab-villas --photos 6 --seconds 18 --centre

# one carousel (6 slides by default: hook, 3 features, details, CTA)
node scripts/social/make-carousel.mjs --listing BONA-001
node scripts/social/make-carousel.mjs --listing BONA-W003 --slides 5 --square

# story cards
node scripts/social/make-story.mjs --listing BONA-001 --kind new
node scripts/social/make-story.mjs --listing BONA-004 --kind price
node scripts/social/make-story.mjs --listing BONA-012 --kind sold          # refuses unless status is sold
node scripts/social/make-story.mjs --district "Al Khalidiyah" --kind district
node scripts/social/make-story.mjs --editorial edu-ad-licence --ratio 4:5

# the queue (plan only, then plan + render everything it references)
node scripts/social/queue.mjs --start 2026-09-09 --days 30
node scripts/social/queue.mjs --start 2026-09-09 --days 30 --render
node scripts/social/queue.mjs --only-publishable      # just the entries that are not REGA-blocked
```

Common flags: `--out` to redirect, `--centre` to force a predictable centre crop instead of
sharp's attention crop, `--keep-work` (reel only) to keep the ffmpeg intermediates.

Output lands in `marketing/queue/`:

```
marketing/queue/
  queue.json          <- committed
  (the Instagram publisher's ledger and lock are NOT here — ~/bona-data/ig/, see below)
  reels/reel-<ID>.mp4
  carousels/<ID>/01..06.png + .jpg
  stories/*.png + .jpg
  posts/*.png + .jpg
```

Only `queue.json` is committed. The media is gitignored — it is large
and fully reproducible from `queue.mjs --render`.

**PNG and JPEG twins.** Every still is written both ways. PNG is the master; the JPEG exists
because Instagram's Graph API rejects PNG outright. `queue.json` carries `assets` (PNG) and
`assetsJpg` so a publisher can pick.

---

## No music. On purpose.

Reels are rendered with **no audio stream at all** (`-an`).

- **Licensing.** A commercial property advert cannot ride on a track we hold no licence for,
  and "it was trending on TikTok" is not a licence.
- **Reach.** A rights claim mutes the post on Instagram or gets it Content-ID'd on YouTube,
  which is worse than having no audio. Meanwhile Instagram, TikTok and Snapchat all rank
  their **own** in-app audio higher — and that library is licensed for you at post time.

So: pick a trending track **inside the app** when posting. Every reel entry in `queue.json`
carries that instruction in its `audio` field.

---

## Compliance — the three rules that are not negotiable

**1. TAQEEM — never invent a price.** `lib/listing.mjs::priceText()` is the only place a price
becomes words, and it prints the asking price from `listings.json` or
`السعر عند الطلب / Price on request`. Nothing estimates, rounds or ranges. `--kind price`
refuses a listing with no printed price, and prints no struck-through "was" figure at all:
`listings.json` holds no price history, and a previous price typed on the command line is a
number with no source. If that line is ever wanted it must come from a real field and go
through `priceText()` like every other price.

`queue.mjs` asserts all three on the finished queue and **exits 4** rather than write a
`queue.json` that breaks any of them: every entry with a `listingRef` must carry
`{{AD_LICENCE}}` in both captions and `blocked: true`; a listing with no printed price must
say so in both languages; no caption may mention TK. This caught a real bug — X captions are
capped at 280 characters, and truncating from the top silently dropped the licence line,
which is the last line of a listing caption. X captions are now *rebuilt* with the licence
line and link reserved first, and the body is what gets cut.

**2. REGA — a property advert needs an advertising licence.** Every post that promotes a
*specific* property carries the literal placeholder `{{AD_LICENCE}}` — in the caption **and
burned into the CTA card** — and is marked `blocked: true` in the queue. When the per-listing
licences are issued: replace the placeholder in the caption, **re-render the asset** (the
card carries it too), then set `blocked: false`.

Brand, education, market-fact and district posts promote no specific property and carry no
such requirement. They are `blocked: false` and can go out today —
`node scripts/social/queue.mjs --only-publishable` lists them. The district card is
deliberately built with no ref, no price and no specs so it stays editorial.

The FAL brokerage licence (`1100313556`) is a real, separate number and appears on everything.

**3. Zero mention of TK Estates**, anywhere, in any output.

---

## The schedule, and what it is based on

All times are **Asia/Riyadh**. The Saudi week runs Sunday–Thursday; Friday and Saturday are
the weekend.

| Platform | Cadence | Slots |
|---|---|---|
| Instagram | reel Sun/Tue/Thu, carousel Mon/Wed, post Sat, 1–2 stories daily | 21:30 · 20:45 · 13:30 / 21:05 |
| TikTok | reel Sun/Tue/Thu, photo carousel Mon/Wed/Fri | 22:15 · 15:30 |
| YouTube Shorts | Mon/Wed/Sat | 20:15 (17:00 weekend) |
| Snapchat | story Sun/Tue/Thu, Spotlight Mon/Wed | 07:45 · 22:45 |
| X | post Sun, video Tue, carousel Thu | 21:15 · 21:40 · 14:00 |
| LinkedIn | Sun/Wed, editorial only | 08:30 |
| Facebook | carousel Sun, reel Tue, post Thu | 19:45 / 20:00 |

Reasoning: Saudi social use skews later than almost anywhere — the evening peak is
21:00–24:00 and TikTok and Snapchat keep climbing past midnight — with a secondary midday
peak around 13:00–15:00. Snapchat is the one app with a real morning peak (07:30–08:30) and
has the deepest penetration in the Kingdom, so it gets a commute slot. LinkedIn is a
working-hours network: Sunday–Thursday mornings only, and never a listing (a price on
LinkedIn reads as spam) — brand, market and education there.

Two windows are avoided everywhere and `respectAvoid()` nudges any slot out of them:
Maghrib–Isha (~18:15–20:10 in Jeddah this season) and Friday Jumuʿah (11:15–13:45).

> **These are documented heuristics, not measurements of this account.** After 30 days of
> real data, replace the `PLATFORMS` slot table in `queue.mjs` with what Instagram and TikTok
> Insights actually show for @bona.com.sa. Treat the table as a starting hypothesis.

**Format mix.** No platform's feed carries the same format twice running; `queue.mjs`
verifies this on the finished queue and lists any violation in `queue.json.warnings`
(currently zero). `--strict-mix` makes a violation a non-zero exit. Stories are a separate
surface and alternate pillar instead. Channels that are structurally single-format
(YouTube Shorts) are listed in `queue.json.notes` rather than warned about.

---

## Publishing — Instagram

Instagram is the one platform that publishes **unattended**. `scripts/social/publish.mjs` runs
from a systemd user timer every 15 minutes between 17:00 and 23:59 Asia/Riyadh, posts what the
calendar says is due, writes what happened to a ledger, and exits. No token lives in the repo.

### What it reads, and why that file

The source of truth is **`src/data/content-calendar.json`**, written by
`scripts/og/gen-social.mjs` — *not* `marketing/queue/queue.json`. Three reasons:

- it is the Instagram calendar: one entry per post with the AR+EN caption, hashtags, alt text,
  `adLicenceRequired`, a stable `id` and a KSA `time`;
- its images are already **public HTTPS URLs** (the site's own `/listings/…` files and the media
  host). `queue.json` points at locally rendered files under `marketing/queue/` that are not
  hosted anywhere, and the publisher never uploads anything;
- the dashboard (`/dashboard`) reads the same file, so what the owner sees is what goes out.

`--source` accepts another file (it understands `queue.json`'s shape too), but those assets
would have to be hosted first.

### How it picks entries

For every Instagram entry, in slot order:

1. **Due** = `date` + `time` (KSA) is at or before now, and not more than `--grace` hours ago
   (default 6). Earlier: wait. Later: `skipped:missed`, written once, and it is gone — the
   evening's slot is the point.
2. **Never automated**: `adLicenceRequired` / `blocked` entries (REGA per-ad licence not
   issued) log `skipped:ad-licence` and are re-checked every run until the calendar says
   otherwise; `reel` entries log `skipped:manual` once (hosted video + an in-app audio pick
   are a human's job).
3. **Caption**: launch posts use `marketing/captions/launch-0N.txt`; everything else is
   AR — EN + hashtags from the entry (cut to 30). Over 2,200 characters → `skipped:caption`.
   A caption still carrying a licence placeholder — `{{AD_LICENCE}}`, `[add number before
   publishing]` or `[يُضاف قبل النشر]` — is a **hard stop**, `skipped:ad-licence-placeholder`,
   even with `--force-id`.
4. **Image**: a site-relative path is prefixed with `https://bona-real-estate.com`; a PNG (or
   anything not `.jpg/.jpeg`) is swapped for its `.jpg` / `.jpeg` twin if one is served; every
   URL is HEAD-checked (200 + `image/jpeg`) before a container is created. No twin served →
   `skipped:no-jpeg` with the URLs it tried in the log — **not** terminal: a 404 (or a 5xx, or
   the wrong content type) is a deploy away from a 200, so the entry is checked again every run
   for as long as its slot is inside the grace window, and the line is written once per status
   change. Only the structural cases are terminal, as `skipped:no-image`: no image on the entry,
   a local (unhosted) path, a non-https URL. (`og-default.jpg` ships with this branch so the
   two posts that use `og-default.png` go out once it is deployed.)
5. **Limits**: at most **3 publishes per run**, **60 s apart**, and the run reads
   `GET /{ig-id}/content_publishing_limit` first and stops at **20 of 25** for the rolling day.
6. **Publish**: `post` → single image container, `carousel` → 2–10 child containers + parent,
   `story` → `media_type=STORIES`. The flow and the error hints are the same code the CLI uses
   (`lib/graph.mjs`).

### The ledger — `~/bona-data/ig/published.jsonl`

The ledger lives **outside the git working tree**, at `~/bona-data/ig/published.jsonl`
(`BONA_IG_LEDGER` or `--ledger` override; the lock file sits beside it). It used to be
`marketing/queue/published.jsonl`, committed — but a branch switch in `~/bona` hid it and
swapped the calendar under the timer, and a repo copy went stale the moment the timer wrote a
line. `ops/systemd/install.sh` creates the directory and seeds the file once (from the legacy
in-repo copy if it is still on disk, else from `ops/systemd/ledger-seed.jsonl`, which holds the
hand-published launch post #9); an existing ledger is never touched.

One JSON line per outcome, keyed by the entry `id`; the **last line for an id is its state**:

```json
{"id":"ig-2026-09-10-story-poll-villa-or-penthouse","date":"2026-09-10","slot":"17:15","kind":"story","status":"published","mediaId":"1789…","permalink":"https://www.instagram.com/…","ts":"2026-09-10T14:15:41.120Z","imageUrl":"https://…jpg"}
```

- **Terminal, never retried**: `published`, `skipped:manual`, `skipped:no-image`,
  `skipped:ad-licence-placeholder`, `skipped:missed`, `skipped:gave-up`.
- **`published` is irrevocable.** Once any line for an id says so, nothing appended after it
  (a hand edit, a merge, a recovery script writing `error`) re-opens it — not even
  `--force-id`. An entry the calendar itself marks `status: "published"` is settled the same way.
- **Retried**: `error` on later runs, three times, then `skipped:gave-up`.
  `skipped:ad-licence`, `skipped:caption`, `skipped:quota`, `skipped:no-jpeg` are re-evaluated
  every run and only re-written when the status changes.
- **`publishing` = in flight.** Written *before* `media_publish`, with the `containerId`. If
  the run dies after that line (a crash, a SIGKILL, a 5xx with the post already live) the id
  is never a candidate again on its own: every live run starts by asking Instagram what became
  of the container — `PUBLISHED` → a `published` line (mediaId unknown; fill it by hand from
  the app if you care), `FINISHED` → `media_publish` again with the **same** `creation_id`,
  `ERROR`/`EXPIRED` → an `error` line (the post never went live, so it may be retried with a new
  container). If that lookup fails, or the container is still processing, the line stays in
  flight and the log carries a loud `needs-reconcile` line — the unit exits 2 so it shows in
  `systemctl --user --failed`. The publisher never re-posts an in-flight id blind. To settle
  one by hand, append a `published` or `error` line for the id.
- `SIGTERM`/`SIGINT` (`systemctl --user stop`, the unit's timeouts, Ctrl-C on a hand run) set
  a flag that is read *between* entries: the publish in progress always completes, the rest is
  deferred to the next run. The unit gives that 3 minutes (`TimeoutStopSec`).
- A post published **by hand** is recorded here too (`"manual": true`, `ts` null until the
  human fills it) — that is what keeps the timer from posting it again. Launch post #9 on
  2026-09-09 is the first such line; `gen-social.mjs` renders it "published by hand" whether or
  not a time is known.
- **It is not committed.** It is the audit trail of what went out under Bona's name, so back it
  up with the rest of `~/bona-data`; `gen-social.mjs` reads it back so a regenerated calendar
  shows `status: "published"` instead of `planned`, and a missing file simply means nothing has
  gone out yet.

### The timer

`ops/systemd/bona-ig-publish.{service,timer}` + `ops/systemd/install.sh` (systemd **user**
units; no root). The token file is `~/.secrets/bona-meta-graph.env`, mode 600:

```
META_ACCESS_TOKEN=EAAB…        # system-user token: instagram_basic, instagram_content_publish, pages_read_engagement
IG_BUSINESS_ID=17841427688957180
FB_PAGE_ID=1245646955305748
```

```bash
bash ~/bona/ops/systemd/install.sh                 # once the token file exists: seed the ledger, copy, daemon-reload, enable
systemctl --user list-timers bona-ig-publish.timer # next elapse
journalctl --user -u bona-ig-publish -o cat -f     # watch a run
systemctl --user start bona-ig-publish.service     # run once, now
systemctl --user stop  bona-ig-publish.timer       # PAUSE (start to resume; the service can still be run by hand)
```

`OnCalendar=*-*-* 17..23:00/15 Asia/Riyadh` — the zone is written into the expression, so the
schedule holds whatever `timedatectl` says (this box is Asia/Riyadh anyway). `Persistent=true`
runs once at boot if a tick was missed; the grace window decides whether anything is still
worth posting. Two overlapping runs cannot double-post: `~/bona-data/ig/.publish.lock` is
taken with `O_EXCL` and a lock older than 20 minutes, or whose process is gone, is taken over.
`node` is nvm-managed on this machine, so the unit sets `PATH` explicitly. `ExecStartPre` runs
`ops/systemd/guard-main.sh`, which fails the unit (with a clear journal line) unless `~/bona`
has `main` checked out — the calendar is read from the working tree, and a feature branch left
checked out must not feed the timer.

### Running it by hand

```bash
node scripts/social/publish.mjs --dry-run                      # what the next run would do (default when no token)
node scripts/social/publish.mjs --dry-run --now 2026-09-09T18:30   # pretend it is that KSA time
node scripts/social/publish.mjs --force-id ig-2026-09-14-carousel-district-guide-north-obhur-al-sheraa-al-bandar
node scripts/social/publish.mjs --json --limit 1
```

`--force-id` publishes one entry regardless of its slot and re-opens a `missed` / `gave-up` /
`no-jpeg` / `no-image` line; it still refuses REGA-blocked entries, placeholder captions, reels and anything
already `published` (delete the ledger line if you really mean it). Without a token every
invocation is a dry-run: requests are printed, nothing is sent, nothing is written.
Exit codes: 0 ok / nothing due · 1 config error · 2 a publish error was recorded.

### What is never automated

- **Reels** — video must be hosted and the audio picked in the app. Post from the rendered
  `marketing/queue/reels/` file by hand; the ledger line is written the first time it is due.
- **Anything about a specific property** until its REGA advertising licence is in the caption
  (`adLicenceRequired: false` in the calendar). No licence, no post — there is no flag for it.
- **Other platforms.** See below.

The dry-run before install: `node scripts/social/publish.mjs --dry-run --now 2026-09-09T18:30`.
Tests: `scripts/test/publish.test.mjs`, `scripts/test/graph.test.mjs` (`npm test`).

---

## Publishing — other platforms

**Nothing here publishes anything except Instagram (above).** No other token exists in this
repo and no other account has been claimed yet (`marketing/social-bios.md` lists the handles to
register). Entries carry `accountStatus: "to-claim"` until they are. The commands below are what
to run once the credentials are in place.

Every API below needs a **public HTTPS URL** for the media, not a local path. Upload the
asset first (the site's own storage, or any bucket) and substitute the URL.

### Instagram + Facebook — Meta Graph API
The repo already ships a poster for one-off posts: `scripts/instagram-post.mjs` (needs
`META_ACCESS_TOKEN` and `IG_BUSINESS_ID`; image URLs must be public **JPEG**, which is why the
JPEG twins exist). It shares `lib/graph.mjs` with the unattended publisher.

```bash
export META_ACCESS_TOKEN=... IG_BUSINESS_ID=...
node scripts/instagram-post.mjs whoami
node scripts/instagram-post.mjs post-image \
  --image-url https://<host>/editorial-edu-ad-licence-4x5.jpg \
  --caption-file /tmp/caption.ar.txt --alt-text "…" --dry-run
node scripts/instagram-post.mjs post-carousel \
  --image-urls https://<host>/01.jpg,https://<host>/02.jpg,https://<host>/03.jpg \
  --caption-file /tmp/caption.ar.txt
```

Stories: `post-story --image-url …`. Reels are not supported by that script — two raw calls:

```bash
curl -X POST "https://graph.facebook.com/v21.0/$IG_BUSINESS_ID/media" \
  -d media_type=REELS -d video_url="https://<host>/reel-BONA-001.mp4" \
  -d caption="$(cat /tmp/caption.ar.txt)" -d access_token=$META_ACCESS_TOKEN
# poll GET /<container-id>?fields=status_code until FINISHED, then:
curl -X POST "https://graph.facebook.com/v21.0/$IG_BUSINESS_ID/media_publish" \
  -d creation_id=<container-id> -d access_token=$META_ACCESS_TOKEN
```

Facebook Page equivalent: `POST /{page-id}/photos` (`url=`, `message=`) and
`POST /{page-id}/videos` for a reel, with a Page token.

### TikTok — Content Posting API v2
Needs an approved app with the `video.publish` / `video.upload` scope.

```bash
curl -X POST https://open.tiktokapis.com/v2/post/publish/video/init/ \
  -H "Authorization: Bearer $TIKTOK_ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"post_info":{"title":"<AR caption>","privacy_level":"PUBLIC_TO_EVERYONE"},
       "source_info":{"source":"PULL_FROM_URL","video_url":"https://<host>/reel-BONA-001.mp4"}}'
# then poll:
curl -X POST https://open.tiktokapis.com/v2/post/publish/status/fetch/ \
  -H "Authorization: Bearer $TIKTOK_ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"publish_id":"<id>"}'
```

Photo carousels use `/v2/post/publish/content/init/` with `media_type: "PHOTO"` and
`post_mode: "DIRECT_POST"`.

### YouTube Shorts — Data API v3
A vertical video of 3 minutes or less is treated as a Short automatically.

```bash
curl -X POST "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status" \
  -H "Authorization: Bearer $YT_ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"snippet":{"title":"<AR title> #Shorts","description":"<caption>","categoryId":"22"},
       "status":{"privacyStatus":"public","selfDeclaredMadeForKids":false}}'
# then PUT the MP4 bytes to the Location header returned above
```

### X — media upload v1.1 + tweets v2
```bash
# video: INIT / APPEND / FINALIZE against upload.twitter.com/1.1/media/upload.json
# images: a single POST with media_data
curl -X POST https://api.x.com/2/tweets \
  -H "Authorization: Bearer $X_ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"<AR caption, <=280 chars>","media":{"media_ids":["<id>"]}}'
```
`queue.mjs` already trims X captions to fit 280 characters and cuts the hashtag block to
three tags.

### LinkedIn — Posts API
```bash
curl -X POST "https://api.linkedin.com/rest/images?action=initializeUpload" \
  -H "Authorization: Bearer $LI_ACCESS_TOKEN" -H 'LinkedIn-Version: 202605' \
  -d '{"initializeUploadRequest":{"owner":"urn:li:organization:<ORG_ID>"}}'
# PUT the JPEG to uploadUrl, then:
curl -X POST https://api.linkedin.com/rest/posts \
  -H "Authorization: Bearer $LI_ACCESS_TOKEN" -H 'LinkedIn-Version: 202605' \
  -d '{"author":"urn:li:organization:<ORG_ID>","commentary":"<caption>",
       "visibility":"PUBLIC","distribution":{"feedDistribution":"MAIN_FEED"},
       "content":{"media":{"id":"<image-urn>"}},"lifecycleState":"PUBLISHED"}'
```

### Snapchat — manual
Snapchat has **no public organic posting API** for a Public Profile. Stories and Spotlight
posts go up by hand through the Snapchat app or Snapchat Business Manager. The queue still
schedules them so the day's plan is complete; treat those rows as a to-do list.

---

## Notes and gotchas

- **`node_modules`.** If you work in a git worktree, symlink it:
  `ln -s ~/bona/node_modules ~/bona-wt/<name>/node_modules`. sharp is a native module and
  re-installing it per worktree is a waste.
- **Photo order is not decided here.** `listing.images` is already ranked — the intake
  pipeline (`services/intake`) had a model look at a labelled contact sheet and put the hero
  at index 0. `lib/photos.mjs` resolves that order and drops what will not decode. Do not
  re-sort on filesize or entropy; that throws the ranking away.
- **Remote photos are cached** in `~/.cache/bona-social/photos/`. About half the listings
  still point at the media host rather than `public/listings/`, and the first cold run of a
  reel spends most of its time downloading. A warm reel takes ~25 s; a cold one, minutes.
- **Ken Burns, and why the cross-fades are pairwise.** One ffmpeg per segment, then one
  ffmpeg per cross-fade, then one overlay pass — never a single graph. `xfade` buffers its
  **entire first input**, so chaining six segments in one filtergraph peaked at **2.3 GB** on
  a 20 s reel (measured with `/usr/bin/time -f %M`); doing it two at a time holds it to
  ~1.4 GB and turns one long ffmpeg into several 2-second ones, so a spike in load costs a
  retry rather than the whole reel. Intermediates are CRF 12, visually transparent, so the
  repeated encodes do not accumulate. Same reasoning as `services/intake/lib/video.mjs`,
  which runs one ffmpeg per extracted frame. `zoompan` runs on a 2× supersampled still
  because it crops on integer input pixels; at 1× the pan visibly steps.
- **Timeouts.** Every ffmpeg call is capped (10 min) and every `--render` child is capped
  (15 min, `BONA_SOCIAL_RENDER_TIMEOUT_MS`). This box is shared; a loaded box turned a 2 s
  encode into a 5 min one and killed five reels on the first batch run.
- **Downloads are capped** at 40 MB and streamed, so a bad or hostile URL cannot exhaust
  memory before sharp's pixel limit ever runs.
- **Safe areas.** `SAFE` in `lib/brand.mjs` is the union of the chrome Instagram Reels,
  TikTok and YouTube Shorts paint over a 1080×1920 frame — deepest bottom (TikTok's caption
  block) and widest right (Reels' action rail). Stories carry far less chrome and use their
  own, shallower bottom.
- **ffmpeg** is the static build at `~/.local/bin/ffmpeg`, the same one `services/intake`
  uses. Override with `BONA_FFMPEG_BIN`.
- Redirect all output with `BONA_SOCIAL_OUT=/some/dir`.
