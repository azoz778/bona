# Bona WhatsApp intake

The owner drops a property brochure PDF into a WhatsApp group on his own phone and, about a
minute later, the property is on bona.azoz.uk. This service is what happens in between.

```
owner's phone ──WhatsApp group "Bona …"──▶ Evolution API (wa-api.azoz.uk, his own instance)
                                                  │  poll every 20 s (read-only)
                                        ┌─────────▼──────────────────────────────┐
                                        │ bona-intake  (systemd --user, WSL)     │
                                        │  PyMuPDF  → text + candidate photos    │
                                        │  gate     → default-deny classifier    │
                                        │  claude -p→ copy (AR+EN) + photo rank  │
                                        │  sharp    → public/listings/<slug>/    │
                                        │  git      → commit + push main         │
                                        │  reply    → "✅ Live: … "               │
                                        └─────────┬──────────────────────────────┘
                                                  ▼
                              GitHub Actions ──▶ https://bona.azoz.uk
```

Nothing about this service is exposed to the internet: it makes outbound calls only.

## How the owner uses it

1. Make (or rename) any WhatsApp group whose **subject contains "Bona"** — e.g. "Bona
   Listings". The bot greets it once.
2. Send a **property brochure PDF** into the group. Optional caption hints:

   | caption | effect |
   |---|---|
   | `rent`, `للإيجار` | category = rent (period defaults to `year`; `per month` sets month) |
   | `off-plan`, `international` | sets the category |
   | `SAR 4,500,000`, `4.5m`, `990,000 ر.س`, `٤٥٠٠٠٠٠ ريال` | the asking price, overriding the PDF |
   | `#test` | dry run — the bot replies with the listing it *would* publish and writes nothing |
   | `#nobrochure` | publish the listing with **no** downloadable brochure |
   | `#brochure` | nothing (a no-op alias — every brochure is re-published by default) |
   | `#hidden` | writes the listing but keeps it off the site until `show <id>` |

3. The bot replies `Reading the brochure…`, then either
   `✅ *Title* — https://bona.azoz.uk/properties/<slug>/ · 8 photos · cover: Pool · SAR 4,500,000`
   or one line saying why it was not published.
4. Afterwards, plain text messages in the group act as commands:

   ```
   remove BONA-W001          take the listing off the site (deletes the JSON and the photos)
   hero BONA-W001 4          make photo 4 the cover
   price BONA-W001 4500000   set the asking price   (price BONA-W001 onrequest clears it)
   brochure BONA-W001        rebuild the Bona-branded PDF from the developer's original
   sold BONA-W001            mark it sold           (also: reserved / available)
   hide BONA-W001            keep it off the site   (show BONA-W001 puts it back)
   status                    what is published and what the intake is doing
   retry                     re-run the last brochure
   help                      the list above
   ```

5. Got a walkthrough clip? Send the **video** into the group right after its brochure — no
   caption needed. The clip is matched to the brochure sent closest to it in time (within
   `BONA_VIDEO_WINDOW_MIN`, 15 minutes; `lib/video.mjs` `pickListingForVideo`) and added to
   that listing, up to 4 per listing, no re-publish command needed. If the brochure is still
   being published — or has not arrived yet — the clip is parked (one line back: "Got the
   video — it will be added once … is published") and attached the moment the listing exists;
   if two different listings were published from brochures equally close, the bot asks which
   one instead of guessing. An id in the caption always wins — `video BONA-W001`, or just
   `BONA-W001` — and is the way to add a clip to a listing published long ago. A clip with no
   id and no brochure near it gets one line back asking; it is never silently dropped (before
   2026-09-06 it was — see `unsee.mjs` for replaying clips an older daemon swallowed). The
   file is stored exactly as WhatsApp sent it (no transcoding, no thumbnail — this service has
   no video library), so `BONA_MAX_VIDEO_MB` is the only thing capping it. The site renders
   `videos[]` on the listing page (`ListingPage.astro`) as plain `<video>` elements.

Anything else in the group is ignored, silently.

## The rules it enforces

- **Only the owner, only in his own group.** A message is acted on when `key.fromMe === true`
  or the sender resolves to `BONA_OWNER_JID` — including through `key.participantAlt` /
  `senderPn`, which is how the real number arrives in a LID group. And the *group* has to be
  his too: a subject that matches `BONA_WA_GROUP_MATCH` is only trusted when the group's
  `owner` or `subjectOwner` is the owner, because anyone can create a group called "Bona
  Listings" and add him to it. A group that reports no owner fails closed — put its jid in
  `BONA_WA_GROUP_JIDS` if you really do want it (an explicitly configured jid is trusted).
  Messages wrapped in `ephemeralMessage` / `viewOnceMessage(V2)` are unwrapped first, so a
  disappearing-messages group still works.
- **Default deny on PDFs.** Invoices, receipts, IDs, bank/account statements, payslips, tax
  certificates, commercial registrations and anything with no property signal are rejected and
  **never copied into the repo** — the download is deleted too. `lib/classify.mjs` does this
  before the AI ever sees the file; the model is a second, independent gate (`reject: true`).
  The keyword list has two tiers: `passport`, `كشف حساب`, `payslip`, `invoice` and friends are
  **absolute**, while the words that a real developer's brochure legitimately prints — `صك`,
  `رخصة`, `عقد إيجار`, "terms and conditions", his company IBAN — only deny a document that
  has no property content of its own. An IBAN that is the *subject* of the document (in the
  file name, or in the first line) is absolute.
- **A brochure with no text layer still gets a hearing.** A Canva/Illustrator PDF with under
  ~40 characters of text per page is not judged locally at all: every page is rendered at
  1600 px and handed to the AI, which reads the specs and the prices off the pages and
  rejects it if it is not one property for sale. Default-deny simply moves one gate later.
- **A brochure whose pages ARE the pictures gets its photographs cut out of them.** A deck
  designed in Canva/Illustrator and exported one picture per page yields candidates that are
  whole pages — photo plus headline plus logo plus floor plan in one bitmap — and the ranking
  step rightly refuses every one of them ("collage", "text page"), which used to end the run
  at `not enough usable photos — 0 of 4`. When the pages are page-sized composites (the
  bitmap covers ~all of its page, or the PDF has no text layer) **and** the leftovers could
  not fill a gallery on their own, `lib/photo-regions.mjs` renders those pages, sends **one**
  extra `claude -p` — under the same confinement — and gets back the bounding box of every
  photograph printed on them, in 0–1 coordinates. The boxes are cut out with sharp from a
  re-render of the page at crop resolution and go into the candidate list as ordinary
  candidates, so `IMAGE-RUBRIC.md` judges them like any other photograph. A page too long to
  read in one frame (the Sadana cover is 1080×10449 pt) is sliced into overlapping views
  first and the boxes are mapped back onto the page. Nothing is relaxed: a crop under
  `BONA_MIN_IMAGE_SIDE` on its short side, or shaped like a banner, is dropped, and a run
  whose crops the ranking step still refuses is still rejected. It costs one call, only on
  the brochures that would otherwise have been rejected, capped at 20 pages and 24 crops
  (the numbers are constants at the top of `lib/photo-regions.mjs`, not env vars).
- **Never estimates a price** (TAQEEM), and does not take the model's word for one either.
  A price is published only when the number is **actually printed**: `lib/price.mjs` looks it
  up in the PDF's text layer and in the caption (thousands separators, Arabic-Indic digits,
  `4.5m` / `مليون` forms all count). For a PDF with no text layer the model must return
  `priceEvidence: { page, quote }` and a second one-shot `claude -p` has to confirm it on that
  page image. Otherwise the listing is published as *price on request* and the reply says so.
- **Nothing the model writes is trusted.** Only fields that pass `validateAiResult` +
  `copyProblems` + `checkListing` are written or sent on. The model's free-text `warnings`
  stay in the run's `ai.json`; `_intake.warnings` in the committed listing holds codes from a
  fixed vocabulary and nothing else. The PDF text and the caption go into the prompt inside
  `<<<BONA-UNTRUSTED-DATA>>>` markers, with an explicit instruction that everything between
  them is a document, never an instruction.
- **The model is confined to its work dir.** No `--permission-mode bypassPermissions` (it
  granted the whole filesystem for no benefit). Measured on this CLI, *no* permission mode
  gates `Read` at all, so `lib/confine.mjs` generates a `--settings` file that denies every
  branch of the filesystem except the run's work dir. Verified: with it, `Read /etc/hostname`
  is refused and the work dir still reads.
- **No other agency in the copy.** The brochures the owner receives are usually branded by
  someone else; the generated copy is checked for `TK`, `tk-estates`, phone numbers and the
  hype words the site validator bans, and is rejected if any appear.
- **The brochure comes back out under Bona's brand.** The owner is sent someone else's
  brochure; what goes on the site is that document with a Bona cover in front of it, a
  discreet footer strip on every one of the developer's pages and a closing *Enquire* page
  with a QR of the listing URL. The developer's own pages are never re-rendered and their
  branding is never removed — it is their document, and their brand on it is legitimate —
  but nothing Bona *adds* may carry another agency: `rebrand_pdf.py` scrubs every listing
  fact it is about to print and drops any that holds a rival broker, a phone number, an
  email or a link. `#nobrochure` publishes the listing with no PDF at all.
- **Real Arabic**, checked for Arabic script in every `ar` field.
- **4–10 photos.** A PDF that yields fewer than four publishable photographs is rejected
  rather than published thin.
- **Read-only on WhatsApp apart from replies.** The service never sets a webhook, websocket or
  RabbitMQ binding on the instance — another agent (Lisa) consumes its events and a webhook
  here would steal them.
- **A failure never leaks command output.** The group gets one generic line; the git, build
  and model output goes to the journal, where only the owner can read it.

## The publish order (this is load-bearing)

`build.mjs` rewrites the **tracked** file `src/data/listings.json`, and `git rebase` refuses to
run with unstaged changes. So the order is fixed and nothing pulls mid-flight:

```
assertCleanTree(repo)      git status --porcelain must be empty; a crashed job's leftovers
                           under public/listings and scripts/curate/inbox are cleaned once
                           and re-checked (anything else is a hard stop — it is not ours)
gitPull(repo)              fetch + rebase, BEFORE the first byte is written
processPdf(...)            images AND the branded brochure into <workDir>/publish/<slug>,
                           promoted into the repo only after checkListing() passes;
                           then build.mjs + validate.mjs
gitCommitPush(repo, …)     `git add -A -- <allowlist>` only:
                             public/listings/<slug>, scripts/curate/inbox, src/data/listings.json
                           (a staged path outside that list aborts the commit)
                           push; if the remote moved, re-pull (the tree is clean now) and retry
```

Anything that throws after the first write calls `resetTree()`: it deletes the new listing
directory, then `git checkout --` and `git clean -fd` **only** the three allowlisted paths, so
the next job can always pull. It deliberately never touches anything else — a modified tracked
file outside the allowlist means somebody else is working in that clone, and the job stops with
"the publishing clone has N uncommitted path(s)" rather than throwing their work away.
A dry run touches neither git nor the remote.

A **lock file** (`$BONA_DATA/intake.lock`) sits around the whole write phase, shared by the
daemon and `run-once.mjs`, so the two can never write the clone at the same moment. A lock
whose holder died is stolen, not waited on.

**Restarts.** Every PDF is written into the state file as a `pending` job *before* its message
id is marked seen, so a crash between the two replays the job instead of losing the brochure.
`SIGTERM` stops the daemon taking new work and waits up to 40 s for the job in flight
(`TimeoutStopSec=45`) — it never `process.exit()`s in the middle of a git push or a sharp
encode.

## Install

The service runs from `~/bona` and writes to a **separate clone** so that a `git pull` during
a publish can never rewrite the code running the publish.

```bash
# 1. the publishing clone (once)
gh repo clone azoz778/bona ~/bona-bot
cd ~/bona-bot && npm ci

# 2. the code the service runs (the owner's normal checkout, already there)
cd ~/bona && npm ci

# 3. secrets — already created; only BONA_* live here, Evolution creds stay in their own file
#    (do not print this file)
ls -l ~/.secrets/bona-services.env ~/.secrets/evolution-api.env

# 4. the unit
install -Dm644 ~/bona/services/deploy/bona-intake.service ~/.config/systemd/user/bona-intake.service
systemctl --user daemon-reload
systemctl --user enable --now bona-intake
loginctl enable-linger "$USER"        # keeps it running when no shell is logged in

# 5. watch it
systemctl --user status bona-intake
journalctl --user -u bona-intake -f -o cat | jq .
```

## Configuration

`~/.secrets/bona-services.env` (mode 600, shared with `services/api`). Everything has a
default, so only the ones you want to change need to be present.

| variable | default | meaning |
|---|---|---|
| `EVOLUTION_API_URL` / `EVOLUTION_API_KEY` | — | read from `~/.secrets/evolution-api.env` |
| `BONA_WA_INSTANCE` | `abdulaziz-personal` | Evolution instance |
| `BONA_OWNER_JID` | `966593296933@s.whatsapp.net` | the only author whose messages are acted on |
| `BONA_WA_GROUP_MATCH` | `bona` | case-insensitive regex against the group subject |
| `BONA_WA_GROUP_JIDS` | — | extra group jids, comma separated |
| `BONA_REPO` | `~/bona-bot` | the clone that is written to and pushed |
| `BONA_DATA` | `~/bona-data` | downloads, extraction scratch, state |
| `BONA_POLL_MS` | `20000` | message poll interval |
| `BONA_GROUP_SCAN_MS` | `300000` | group discovery interval |
| `BONA_CLAUDE_MODEL` | `sonnet` | the model for the extraction/curation step |
| `BONA_CLAUDE_FALLBACK_MODEL` | `opus` | used for the last attempt if sonnet keeps failing the contract |
| `BONA_SITE` | `https://bona.azoz.uk` | used for URLs and `brochureUrl` |
| `BONA_MIN_IMAGES` / `BONA_MAX_IMAGES` | `4` / `10` | publishable photo count |
| `BONA_MIN_IMAGE_SIDE` | `700` | smallest long side of a candidate photo |
| `BONA_MAX_PDF_MB` / `BONA_MAX_PDF_PAGES` | `150` / `120` | input limits (developer brochures run 50–80 MB) |
| `BONA_MAX_VIDEO_MB` | `60` | largest walkthrough video accepted; stored exactly as received (no downsampling like the brochure gets — see `lib/video.mjs`) |
| `BONA_PAGE_READ_LONG_SIDE` | `1600` | long side of the page renders the AI reads (text-free PDFs) |
| `BONA_LOCK_WAIT_MS` | `900000` | how long a job waits for `$BONA_DATA/intake.lock` |
| `BONA_PY_CMD` | `uv run --with pymupdf python` | argv for the extractor; split on spaces, never shelled |
| `BONA_BROCHURE_PY_CMD` | `uv run --with pymupdf --with segno --with fonttools --with brotli python` | argv for the brochure step (segno draws the QR, fontTools+brotli turn `public/fonts/*.woff2` into TTF) |
| `BONA_BROCHURE_TIMEOUT_MS` | `600000` | how long `rebrand_pdf.py` may take |
| `BONA_MAX_BROCHURE_MB` | `25` | largest **branded** PDF committed into the repo; over it the images are downsampled, and if it still does not fit the listing publishes without one |
| `BONA_SEND_REPLIES` | `true` | set `false` to run completely silent |
| `BONA_DEBUG` | — | any value adds debug logs and stack traces |

## Testing without WhatsApp

```bash
cd ~/bona

# preview only — writes nothing, prints the listing, the ranking and the chosen hero
node services/intake/run-once.mjs ~/brochures/villa.pdf --dry-run --repo ~/bona

# write into a repo and rebuild, but never touch git or the remote
node services/intake/run-once.mjs ~/brochures/villa.pdf --no-git --repo ~/bona --caption "SAR 4,500,000"

# the real thing (commits and pushes, exactly like the daemon)
node services/intake/run-once.mjs ~/brochures/villa.pdf

# the brochure step on its own: rebrand a local PDF and print what went on the Bona pages
node services/intake/rebrand-once.mjs ~/brochures/villa.pdf ~/bona-bot/scripts/curate/inbox/villa.json /tmp/out.pdf
node services/intake/rebrand-once.mjs ~/brochures/villa.pdf ~/facts.json /tmp/out.pdf --max-mb 12 --json

# unit tests — note the glob: node v24.19.0 on this box does not accept a bare directory
node --test 'services/intake/test/*.test.mjs'
```

`rebrand-once.mjs` takes either a full listing (`scripts/curate/inbox/<slug>.json`) or a bare
facts object `{ id, titleEn, titleAr, place, priceEn, project, developer, url }`. It writes no
state, takes no lock and never touches git, so it is safe to run while the daemon is up — it is
the loop to use when changing anything in `rebrand_pdf.py`. Rasterise a page or two afterwards
and look at them; `docs/qa/brochure/` holds the reference renders (portrait, 16:9 deck, and the
709x510 half-spread the owner's Nuzul Khayala brochure opens on).

Every run leaves its scratch directory behind (`--work`, else `$BONA_DATA/intake/manual/…`)
containing `prompt.txt` (exactly what the model was asked), `ai.json` (exactly what it
answered — including its free-text `warnings`, which are never committed), `images/` (every
candidate, `cNNN.jpg` being the regions cropped out of composite pages), `sheets/` (the
contact sheets it looked at), `pages/` (the page renders, for a PDF with no text layer),
`regions/` (the photo-region step, when it ran: `views/` the page renders it looked at,
`sheets/` their contact sheet, `prompt.txt` what it was asked, `regions.json` the boxes it
drew and `crops/` the high-resolution page renders they were cut from) and
`claude-settings.json` (the deny rules that confined it). That is the first place to look
when a listing comes out wrong.

A rescue round — the ranking step calling the candidates collages, so the crop step runs
after it rather than before — overwrites `prompt.txt` and `ai.json` with the second, final
ask; the `intake.cropped` line in the journal says why the crop step ran.

`run-once.mjs` takes the same `$BONA_DATA/intake.lock` as the daemon, so it is safe to run
while the service is up — it waits its turn. `--dry-run` and `--no-git` never call git at all,
so pointing `--repo` at a working checkout with uncommitted changes in it is safe.

## What it writes

| path | what |
|---|---|
| `scripts/curate/inbox/<slug>.json` | the listing (see `src/data/LISTING-SCHEMA.md` § WhatsApp intake) |
| `scripts/curate/inbox/_index.json` | the `BONA-W###` counter |
| `public/listings/<slug>/NN.jpg` | photo, max 1920 px, q82, EXIF stripped |
| `public/listings/<slug>/NN-thumb.webp` | 640 px thumbnail |
| `public/listings/<slug>/brochure.pdf` | the Bona-branded brochure — by default, unless `#nobrochure`, and only up to `BONA_MAX_BROCHURE_MB` |
| `$BONA_DATA/intake/<date>/<msgid>.pdf` | the downloaded PDF (outside the repo) |
| `$BONA_DATA/intake/<date>/<msgid>/` | the run's work dir: `prompt.txt`, `ai.json`, `images/`, `pages/`, `sheets/`, `regions/` (only when photo regions were cropped), `publish/<slug>/` (staging), `claude-settings.json` (the model's confinement) |
| `$BONA_DATA/intake-state.json` | seen message ids, greeted groups, published PDF hashes, job records |
| `$BONA_DATA/intake.lock` | the publish lock (daemon + run-once) |

`scripts/curate/build.mjs` appends the inbox files to `src/data/listings.json` after the TK
live-list filter; intake listings are exempt from that filter because they are owner-authored.

## Failure modes

| symptom | cause | what to do |
|---|---|---|
| `✋ Not published — looks like a private document ("IBAN")` | the default-deny gate | correct: that PDF is not a brochure |
| `✋ … not a property brochure` (AI gate) | a scan, certificate or site plan without property details | send the real brochure |
| `✋ … not enough usable photos — 0 of 4` | the PDF has no extractable photographs (only page renders) or they are all plans/logos | send a brochure with real photos, or the photos themselves |
| `✋ … not enough usable photos — 2 of 4 (even after cutting 3 photo region(s) out of its own pages)` | the pages were composites, the crops were made, and the ranking step still would not publish enough of them | look in the work dir: `regions/regions.json` is where the model said the photographs were, `images/cNNN.jpg` is what came out |
| `⚠️ … You've hit your session limit` | Claude Code quota | wait for the reset; the PDF stays in `$BONA_DATA`, send `retry` |
| `⚠️ Something went wrong …` | any failure: git, build, model | the reason is in the journal — the reply deliberately quotes none of it. The repo is rolled back. |
| `⚠️ The page is still not answering …` | GitHub Pages did not deploy | the listing IS committed; check the Actions run |
| `the publishing clone has N uncommitted path(s)` | something other than the intake wrote to `~/bona-bot` | look at `git status` there yourself; the intake refuses to throw away work that is not its own |
| `another intake job holds intake.lock` | a `run-once.mjs` is still running | wait, or remove the file if its pid is gone |
| `⚠️ … spawn claude ENOENT` | the unit's PATH is missing `~/.local/bin` | fix `PATH=` in the unit, `daemon-reload`, restart |
| listing live but no *Download brochure* button | the branded PDF was over `BONA_MAX_BROCHURE_MB` even after downsampling, or `rebrand_pdf.py` failed | the reply says which; `_intake.warnings` holds `brochure-too-large` / `brochure-failed`. Raise the cap and send `brochure <id>`, or leave it — the listing itself is fine |
| `✋ the original PDF for BONA-W00x is not in …` | `brochure <id>` after the download was cleaned out of `$BONA_DATA` | send the brochure again |
| `✋ Which listing is this video for? …` | a video with no `BONA-W###` in its caption and no brochure within `BONA_VIDEO_WINDOW_MIN` of it (or the nearest brochure was rejected / never finished within `BONA_VIDEO_WAIT_MIN`) | send it again right after the brochure, or captioned `video BONA-W001` |
| `✋ Two brochures were sent just as close to this video …` | two different listings were published from brochures within 60 s of each other around the clip | send it again captioned with the id you mean |
| `🎬 Got the video — it will be added once … is published` | the clip landed while its brochure was still in the pipeline (or before the brochure arrived at all); it is parked in the state file (`waitSince`, plus `waitingFor` when a specific brochure is mid-publish) and requeued once that brochure answers, a new brochure arrives, or `BONA_VIDEO_WAIT_MIN` runs out | nothing — if the brochure ends up rejected or never comes, the clip comes back as the "Which listing" line |
| a clip sent before 2026-09-06 never appeared | the old daemon had no video path and marked it seen | stop the unit, `node services/intake/unsee.mjs <messageId…>`, start the unit — it is handled as if just sent |
| `✋ The video is N MB — the limit is …` | over `BONA_MAX_VIDEO_MB` (declared length or the actual download, whichever catches it) | trim the clip, or raise the limit |
| bot silent, no greeting | no group subject matches `BONA_WA_GROUP_MATCH`, or the group is not the owner's | rename the group; if the journal says `group.rejected_not_owned`, the group was created by somebody else — put its jid in `BONA_WA_GROUP_JIDS` if that is really what you want |
| bot silent on a PDF | the message was not authored by the owner, or was already seen | check `journalctl` for `msg.ignored_not_owner` |
| `Already published: <url>` | the same PDF bytes were sent twice | use `remove <id>` first if you meant to replace it |
| listing published but the page 404s for a while | GitHub Pages deploy takes 2–3 min | the reply says so; the URL is already correct |
| PC off / WSL asleep | the service is not running | WhatsApp keeps the messages; everything queued is processed when it comes back, and a PDF that was already downloaded when the power went is replayed from `intake-state.json` |

The daemon processes **one PDF at a time**. A second PDF sent while the first is being read
waits in the queue; `status` shows the depth.

## Layout

```
services/intake/
  index.mjs             the daemon: group discovery, polling, single-worker queue
  run-once.mjs          the same pipeline on one local PDF, no WhatsApp
  extract_pdf.py        PyMuPDF: page text + candidate photos, whole-page renders (--mode pages)
                        and sliced page views (--mode views); run via `uv run --with pymupdf`
  rebrand_pdf.py        PyMuPDF + segno: the Bona cover, the footer strip, the Enquire page, the shrink
  rebrand-once.mjs      the brochure step alone, on one local PDF — the loop for changing rebrand_pdf.py
  lib/
    env.mjs             config; reads ~/.secrets/*.env inside Node, never through a shell
    log.mjs             one JSON line per event, with secret redaction
    evolution.mjs       Evolution API client (+ the verified response shapes, in comments)
    classify.mjs        the default-deny gate
    pdf.mjs             wrapper around extract_pdf.py
    brochure.mjs        wrapper around rebrand_pdf.py: the facts it prints, where the file lands
    contact-sheet.mjs   labelled sheets of the candidates, for the model to look at
    photo-regions.mjs   the photographs cut out of pages that are single flattened pictures
    prompt.md           the prompt template (the contract the model must answer with)
    claude.mjs          the `claude -p` runner, contract validation, repair retry
    confine.mjs         the --settings deny rules that lock the model into the work dir
    price.mjs           the TAQEEM cross-check: is this number actually printed?
    lock.mjs            $BONA_DATA/intake.lock — one writer at a time
    shutdown.mjs        wait for the job in flight on SIGTERM
    images.mjs          sharp: NN.jpg + NN-thumb.webp
    video.mjs           a walkthrough video, stored exactly as received: v-NN.mp4
    listing.mjs         slug/id allocation, listing assembly, local validation, the inbox
    edits.mjs           remove / hero / price / status / hidden / video
    messages.mjs        every reply the bot sends
    pipeline.mjs        the gates, in order
    publish.mjs         clean tree, pull, build + validate, allowlisted commit + push, rollback
    state.mjs           seen ids, greeted groups, published PDF hashes
  test/                 node --test 'services/intake/test/*.test.mjs'
services/deploy/bona-intake.service
```
