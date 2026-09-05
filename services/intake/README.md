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
   | `#brochure` | also publishes the PDF at `/listings/<slug>/brochure.pdf` |
   | `#hidden` | writes the listing but keeps it off the site until `show <id>` |

3. The bot replies `Reading the brochure…`, then either
   `✅ *Title* — https://bona.azoz.uk/properties/<slug>/ · 8 photos · cover: Pool · SAR 4,500,000`
   or one line saying why it was not published.
4. Afterwards, plain text messages in the group act as commands:

   ```
   remove BONA-W001          take the listing off the site (deletes the JSON and the photos)
   hero BONA-W001 4          make photo 4 the cover
   price BONA-W001 4500000   set the asking price   (price BONA-W001 onrequest clears it)
   sold BONA-W001            mark it sold           (also: reserved / available)
   hide BONA-W001            keep it off the site   (show BONA-W001 puts it back)
   status                    what is published and what the intake is doing
   retry                     re-run the last brochure
   help                      the list above
   ```

Anything else in the group is ignored, silently.

## The rules it enforces

- **Only the owner.** A message is acted on only when `key.fromMe === true` or the sender is
  `BONA_OWNER_JID`. Another group member cannot publish to the website.
- **Default deny on PDFs.** Invoices, receipts, IDs, contracts, bank/account statements, tax
  certificates, commercial registrations and anything with no property signal are rejected and
  **never copied into the repo** — the download is deleted too. `lib/classify.mjs` does this
  before the AI ever sees the file; the model is a second, independent gate (`reject: true`).
- **Never estimates a price** (TAQEEM). A price is used only when it is printed in the PDF or
  typed in the caption; otherwise `price.onRequest = true` and no number is shown.
- **No other agency in the copy.** The brochures the owner receives are usually branded by
  someone else; the generated copy is checked for `TK`, `tk-estates`, phone numbers and the
  hype words the site validator bans, and is rejected if any appear.
- **Real Arabic**, checked for Arabic script in every `ar` field.
- **4–10 photos.** A PDF that yields fewer than four publishable photographs is rejected
  rather than published thin.
- **Read-only on WhatsApp apart from replies.** The service never sets a webhook, websocket or
  RabbitMQ binding on the instance — another agent (Lisa) consumes its events and a webhook
  here would steal them.

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
| `BONA_MAX_PDF_MB` / `BONA_MAX_PDF_PAGES` | `40` / `60` | input limits |
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

# unit tests — note the glob: node v24.19.0 on this box does not accept a bare directory
node --test 'services/intake/test/*.test.mjs'
```

Every run leaves its scratch directory behind (`--work`, else `$BONA_DATA/intake/manual/…`)
containing `prompt.txt` (exactly what the model was asked), `ai.json` (exactly what it
answered), `images/` (every candidate) and `sheets/` (the contact sheets it looked at). That
is the first place to look when a listing comes out wrong.

## What it writes

| path | what |
|---|---|
| `scripts/curate/inbox/<slug>.json` | the listing (see `src/data/LISTING-SCHEMA.md` § WhatsApp intake) |
| `scripts/curate/inbox/_index.json` | the `BONA-W###` counter |
| `public/listings/<slug>/NN.jpg` | photo, max 1920 px, q82, EXIF stripped |
| `public/listings/<slug>/NN-thumb.webp` | 640 px thumbnail |
| `public/listings/<slug>/brochure.pdf` | only with `#brochure` |
| `$BONA_DATA/intake/<date>/<msgid>.pdf` | the downloaded PDF (outside the repo) |
| `$BONA_DATA/intake-state.json` | seen message ids, greeted groups, published PDF hashes |

`scripts/curate/build.mjs` appends the inbox files to `src/data/listings.json` after the TK
live-list filter; intake listings are exempt from that filter because they are owner-authored.

## Failure modes

| symptom | cause | what to do |
|---|---|---|
| `✋ Not published — looks like a private document ("IBAN")` | the default-deny gate | correct: that PDF is not a brochure |
| `✋ … only 1 page — too short for a brochure` | a scan or a certificate | send the real brochure |
| `✋ … not enough usable photos — 0 of 4` | the PDF has no extractable photographs (only page renders) or they are all plans/logos | send a brochure with real photos, or the photos themselves |
| `⚠️ … You've hit your session limit` | Claude Code quota | wait for the reset; the PDF stays in `$BONA_DATA`, send `retry` |
| `⚠️ … git push failed` | the remote moved or gh auth expired | `cd ~/bona-bot && git pull --rebase && gh auth status` |
| `⚠️ … spawn claude ENOENT` | the unit's PATH is missing `~/.local/bin` | fix `PATH=` in the unit, `daemon-reload`, restart |
| bot silent, no greeting | no group subject matches `BONA_WA_GROUP_MATCH` | rename the group, or set `BONA_WA_GROUP_JIDS` |
| bot silent on a PDF | the message was not authored by the owner, or was already seen | check `journalctl` for `msg.ignored_not_owner` |
| `Already published: <url>` | the same PDF bytes were sent twice | use `remove <id>` first if you meant to replace it |
| listing published but the page 404s for a while | GitHub Pages deploy takes 2–3 min | the reply says so; the URL is already correct |
| PC off / WSL asleep | the service is not running | WhatsApp keeps the messages; everything queued is processed when it comes back |

The daemon processes **one PDF at a time**. A second PDF sent while the first is being read
waits in the queue; `status` shows the depth.

## Layout

```
services/intake/
  index.mjs             the daemon: group discovery, polling, single-worker queue
  run-once.mjs          the same pipeline on one local PDF, no WhatsApp
  extract_pdf.py        PyMuPDF: page text + candidate photos (run via `uv run --with pymupdf`)
  lib/
    env.mjs             config; reads ~/.secrets/*.env inside Node, never through a shell
    log.mjs             one JSON line per event, with secret redaction
    evolution.mjs       Evolution API client (+ the verified response shapes, in comments)
    classify.mjs        the default-deny gate
    pdf.mjs             wrapper around extract_pdf.py
    contact-sheet.mjs   labelled sheets of the candidates, for the model to look at
    prompt.md           the prompt template (the contract the model must answer with)
    claude.mjs          the `claude -p` runner, contract validation, repair retry
    images.mjs          sharp: NN.jpg + NN-thumb.webp
    listing.mjs         slug/id allocation, listing assembly, local validation, the inbox
    edits.mjs           remove / hero / price / status / hidden
    messages.mjs        every reply the bot sends
    pipeline.mjs        the gates, in order
    publish.mjs         build + validate + git + live check
    state.mjs           seen ids, greeted groups, published PDF hashes
  test/                 node --test 'services/intake/test/*.test.mjs'
services/deploy/bona-intake.service
```
