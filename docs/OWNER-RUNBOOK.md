# Bona — owner runbook (updated 2026-09-06)

Everything below is something only the account owner can do. The agent has done everything else.

## 1. Go live (30 seconds) — REQUIRED
GitHub Pages on the free plan only serves **public** repositories, and the agent's permission classifier refuses to flip visibility.
```
gh repo edit azoz778/bona --visibility public --accept-visibility-change-consequences
gh workflow run "Build & deploy (GitHub Pages)" -R azoz778/bona     # or just wait for the next push / 06:00 KSA daily run
```
Then: https://bona.azoz.uk/ (EN), https://bona.azoz.uk/ar/ (AR), https://bona.azoz.uk/dashboard/ (ops).
GitHub issues the HTTPS certificate for bona.azoz.uk automatically within ~15 minutes of the first deploy (DNS is already a DNS-only CNAME on Cloudflare). After it appears, tick "Enforce HTTPS" in repo Settings → Pages, or run:
```
gh api -X PUT repos/azoz778/bona/pages -F https_enforced=true
```

## 2. Instagram @bona.com.sa → API posting (5 minutes)
Follow `marketing/instagram-connect-checklist.md`: switch the account to Business, create a Facebook Page "Bona", link both into the existing Meta Business, then read the IG Business ID with the curl in §4 of that file. After that:
```
META_ACCESS_TOKEN=... IG_BUSINESS_ID=... node scripts/instagram-post.mjs whoami
node scripts/instagram-post.mjs post-image --image-url <url> --caption-file marketing/captions/launch-01.txt
```
Bio text, highlights, 9 launch posts and a 30-day calendar are in `marketing/`.

## 3. WhatsApp Business profile (+966 59 329 6933)
Profile text, greeting and away messages are in `marketing/social-bios.md`. Every "Private enquiry" on the site opens a chat to this number with the property reference pre-filled.

## 4. Analytics, pixels and ad accounts — the checklists
The tracking is built in: attribution on every page, a `Ref` code in every WhatsApp message, a lead store and a WhatsApp poller inside `bona-api`, fan-out to Meta / GA4 / Snap, a private dashboard (§9). What only you can create are the accounts — one checklist each, click-by-click:
- `docs/checklists/meta-bona-portfolio.md` — Business Portfolio **"Bona"** (never TK's), Page, Pixel/dataset + Conversions API token, SAR ad account, system-user token, domain verification (~40 min).
- `docs/checklists/google-bona.md` — finish bona.com.sa@gmail.com, GA4 property + Measurement Protocol secret, Search Console, Google Business Profile, Google Ads later (~45 min + verification wait).
- `docs/checklists/snapchat-bona.md` — Snap Pixel + Conversions API token (~15 min).
- `docs/checklists/aqar.md` — Aqar plan, what it enforces, the export.
- `docs/checklists/pdpl.md` — NDGP registration and the rules of conduct (opt-in, 72 h, rights).

Where the values go: secret keys into `~/.secrets/bona-marketing.env` (created empty by `install.sh`; a key left empty = that integration stays off), public ids into `src/data/site.json → analytics` (send them to the agent). Then:
```
node ~/bona/scripts/marketing/verify-integrations.mjs     # probes every integration, updates the Integrations board
systemctl --user restart bona-api                          # picks up the keys
```

## 5. Search
- Search Console: azoz.uk is already a verified domain property; add `https://bona.azoz.uk/sitemap-index.xml` (steps in `marketing/search-console.md`). IndexNow pings run after every deploy.
- Google Business Profile: `marketing/google-business-profile.md`.

## 6. Legal / brand
- Domain: **bona.sa** is registrable by you today (Saudi ID, Nafath at `nic.sa`); bona.com.sa needs the CR. The move is scripted — §11.
- Bona CR number → `site.json.licences.cr`. REGA per-listing advertising licences are required before promoting individual listings — §10.

## 7. Dana — the AI concierge on the website (chat + call)  — ONE COMMAND to go live
Every page now carries a "Concierge" pill (bottom corner) with two tabs: **Chat** with Dana and **Call** Dana in the browser. Dana runs on your Retell AI account (agents "Bona Dana (voice)" and "Bona Dana (chat)", one Retell LLM on Claude Sonnet 4.6, knowledge base = the site's own `llms-full.txt`, auto-refreshed daily). The small backend she needs (`~/bona/services/api`) runs on this PC (WSL) and must be reachable as `https://bona-api.azoz.uk` through a Cloudflare Tunnel. The agent's permission classifier refuses to create tunnels, so **you** run, once, in a WSL terminal:
```
bash ~/bona/services/deploy/install.sh
```
That creates the tunnel `bona`, points `bona-api.azoz.uk` at it, installs and starts the user services `cloudflared-bona` + `bona-api`, and prints the health check. Until then the pill shows a calm "Dana is resting — reach us on WhatsApp" card, and Dana (if reached) answers from the knowledge base only.
- Costs: Retell bills your balance per call-minute (ElevenLabs voice + LLM) and per chat message; check the Retell dashboard weekly. Leads Dana captures land in `~/bona-data/leads.jsonl` and are WhatsApp'd to your number.
- Ops: `systemctl --user status bona-api cloudflared-bona`, logs `journalctl --user -u bona-api -n 50`. Full contract and runbook: `services/README.md`. Persona text: `services/api/retell/prompt.md` (edit → `node services/api/retell/provision.mjs` to push — prompt edits reach Retell **only** through provisioning; it is idempotent).
- PDPL: Dana now opens every **call** with the disclosure "This is Dana, Bona's AI concierge. This call is recorded to handle your enquiry." / "معك دانة، المساعدة الذكية لبونا. هذه المكالمة مسجّلة لمتابعة طلبك." After pulling this change, run `node ~/bona/services/api/retell/provision.mjs` once, then `systemctl --user restart bona-api`. The chat panel keeps its own greeting plus the "conversations are stored" line.
- Off switch: `site.json → concierge.enabled: false` (push) removes the pill; `systemctl --user stop bona-api` stops the backend.

## 8. Publish a property from WhatsApp (PDF → live listing)
1. Your existing owner-only WhatsApp group **"PDF"** is already wired (you will see "Bona intake connected" there). Alternatively create or rename any group so its name contains **"Bona"** (e.g. "Bona Listings") — you must be the group's creator; within ~5 minutes the service posts the same greeting there.
2. Drop a property brochure **PDF** in the group. Optional caption hints: `rent`, `SAR 4,500,000`, `#test` (dry run — summary only), `#brochure` (also publish the PDF). Within a minute it replies "Reading…", then "✅ Live: … https://bona.azoz.uk/properties/<slug>/" once the page is on the site (deploy takes ~3 min).
3. Fix-ups by replying in the group: `remove BONA-W003` · `hero BONA-W003 4` (make photo 4 the cover) · `price BONA-W003 4500000` · `sold BONA-W003` · `hide` / `show BONA-W003` · `brochure BONA-W003` (rebuild the Bona-branded PDF) · `status` · `help`.
4. Every listing also gets a **Bona-branded brochure PDF** (Bona cover, footer on every page with our number and licence, closing enquiry page with a QR code), shrunk to ≤ 25 MB and linked as "Download brochure" on the page. Caption `#nobrochure` skips it. Whole-project brochures (a tower or compound) publish as one project listing with the developer named and a "from" price when printed.
5. Limits: PDFs up to 150 MB / 120 pages. A run takes 3–10 minutes for a big deck and about $0.4–1.0 of Claude usage. If Claude's usage window is exhausted the group gets "Something went wrong"; the job is replayed automatically when the daemon restarts (`systemctl --user restart bona-intake`) after the window resets.
Verified 2026-09-06 03:56 KSA: a test brochure sent with `#test` came back in 7 minutes as a dry-run summary (title AR/EN, price from the PDF, 7 photos ranked, cover chosen). Costs ≈ $0.15–0.60 of Claude usage per PDF (60–200 s).
Rules baked in: only PDFs *you* send are processed; prices are taken only if printed in the PDF (otherwise "Price on request" — TAQEEM); invoices/IDs/contracts are rejected and never stored; the cover photo is chosen by the AI against `scripts/curate/IMAGE-RUBRIC.md`. The service (`bona-intake`) runs on this PC — if the PC is off, PDFs wait in the group and are processed when it is back. Ops: `systemctl --user status bona-intake`, `journalctl --user -u bona-intake -f`, manual run: `node ~/bona/services/intake/run-once.mjs <file.pdf> --dry-run`.

## 9. Private dashboard — https://bona-api.azoz.uk/dashboard
Runs inside `bona-api` on this PC; nothing personal is on the public site.
- **Login**: open the URL → *Send code* → a 6-digit code arrives on your WhatsApp (+966 59 329 6933) within seconds → type it → you stay signed in for 30 days on that device (`BONA_DASH_COOKIE_DAYS`). Codes expire after 10 minutes, 5 wrong tries burn a code, 3 codes per 10 minutes per IP. *Logout* is in the nav.
- **Overview** — the last 14 days: sessions, WhatsApp clicks, leads, viewings; **sources → leads** with first-touch and last-touch side by side; match quality (Ref code / phone / keyword / time-window / concierge / form); cost per lead per campaign once spend is entered.
- **Leads** — the pipeline board by stage (new → contacted → qualified → viewing → offer → won / lost) with age and your response time; a lead's page is its whole journey (pages seen, clicks, messages, calls, stage changes, notes) with a stage form and a deal value.
- **Listings** — per-listing funnel (views → gallery / tour / brochure → WhatsApp clicks → leads) and the REGA flags (§10).
- **Spend** — type the day's spend per platform/campaign (or import the CSV from Ads Manager) so CPL appears.
- **Integrations** — which keys are present, Evolution reachable, Retell ok, poller last run, fan-out failures, last accepted event per platform, links to the checklists.
- If no code arrives: `curl -s https://bona-api.azoz.uk/health | jq .` (Evolution must be `ok`), then `journalctl --user -u bona-api -n 50`.

## 10. REGA advertising licences — one per listing, before any promotion
Full page: `docs/checklists/rega-ad-licences.md`. The short version:
1. On the FAL platform (Nafath): brokerage contract with marketing scope, approved by the owner → *Advertisement licences* → new → contract, deed, purpose, **channels**, price → save (~SAR 50). Off-plan units use the developer's **Wafi** number instead.
2. Record it by replying in the intake WhatsApp group:
   `licence BONA-W003 <adNumber> <YYYY-MM-DD>` · `wafi BONA-W003 <number>`
   The page then shows the licence line and a QR; the Aqar export and the brochure pick it up. (Commands land with the last step of the tracking work; until then send the numbers to the agent.)
3. Until a listing has a number it stays on the site with the advertiser + FAL block only — **no Aqar, no paid ad, no Story naming it**. The dashboard's Listings view flags `no_ad_licence`, `expiring_30d`, `expired`, `wafi_missing`.
4. The advertiser on every ad is **Abdulaziz Zidan — FAL 1100313556** until Bona has its own CR (682010) and establishment FAL; then `site.json → advertiser` changes and everything re-renders.

## 11. bona.sa cutover — owner steps, then one script
Owner (once): register **bona.sa** at https://nic.sa with Nafath → Cloudflare dashboard → *Add a site* → `bona.sa` (Free) → set the two Cloudflare nameservers at nic.sa → wait for the zone to show *Active* → make sure the token in `~/.secrets/cloudflare.env` may edit DNS on `bona.sa` (and redirects on `azoz.uk`).
Then (agent or you):
```
node ~/bona/scripts/domain-cutover.mjs --domain bona.sa --api api.bona.sa --dry-run   # the plan
node ~/bona/scripts/domain-cutover.mjs --domain bona.sa --api api.bona.sa             # DNS, repo edits, GitHub Pages + HTTPS, tunnel, env, redirect
```
It ends with the remaining manual list: review + push the repo edits, `node services/api/retell/provision.mjs`, `systemctl --user restart bona-api cloudflared-bona`, GA4 stream URL, Search Console property, Meta domain verification, IndexNow, bio links. `bona.azoz.uk` keeps answering with a 301 to the same path on bona.sa.

## Daily loop (already running once the repo is public)
`.github/workflows/deploy.yml`: every push and every day at 06:00 KSA it re-syncs listing status/prices from TK, regenerates llms.txt, rebuilds, deploys, and pings IndexNow. The dashboard's Integrations board shows live health of the five key URLs.
