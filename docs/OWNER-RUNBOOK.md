# Bona — owner runbook (2026-09-05)

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

## 4. Analytics
Create a GA4 property and (optionally) a Meta Pixel, then put the IDs in `src/data/site.json` → `analytics.ga4` / `analytics.metaPixel`. Push; the head hooks activate automatically.

## 5. Search
- Search Console: azoz.uk is already a verified domain property; add `https://bona.azoz.uk/sitemap-index.xml` (steps in `marketing/search-console.md`). IndexNow pings run after every deploy.
- Google Business Profile: `marketing/google-business-profile.md`.

## 6. Legal / brand
- bona.com.sa needs a Saudi CR or registered trade name (`nic.sa`). When bought: set `url` in `site.json`, add the Cloudflare/GoDaddy CNAME, update `public/CNAME`, push.
- Bona CR number → `site.json.licences.cr`. REGA per-listing advertising licences are required before promoting individual listings (each launch caption has a placeholder line).

## 7. Dana — the AI concierge on the website (chat + call)  — ONE COMMAND to go live
Every page now carries a "Concierge" pill (bottom corner) with two tabs: **Chat** with Dana and **Call** Dana in the browser. Dana runs on your Retell AI account (agents "Bona Dana (voice)" and "Bona Dana (chat)", one Retell LLM on Claude Sonnet 4.6, knowledge base = the site's own `llms-full.txt`, auto-refreshed daily). The small backend she needs (`~/bona/services/api`) runs on this PC (WSL) and must be reachable as `https://api.bona.azoz.uk` through a Cloudflare Tunnel. The agent's permission classifier refuses to create tunnels, so **you** run, once, in a WSL terminal:
```
bash ~/bona/services/deploy/install.sh
```
That creates the tunnel `bona`, points `api.bona.azoz.uk` at it, installs and starts the user services `cloudflared-bona` + `bona-api`, and prints the health check. Until then the pill shows a calm "Dana is resting — reach us on WhatsApp" card, and Dana (if reached) answers from the knowledge base only.
- Costs: Retell bills your balance per call-minute (ElevenLabs voice + LLM) and per chat message; check the Retell dashboard weekly. Leads Dana captures land in `~/bona-data/leads.jsonl` and are WhatsApp'd to your number.
- Ops: `systemctl --user status bona-api cloudflared-bona`, logs `journalctl --user -u bona-api -n 50`. Full contract and runbook: `services/README.md`. Persona text: `services/api/retell/prompt.md` (edit → `node services/api/retell/provision.mjs` to push).
- Off switch: `site.json → concierge.enabled: false` (push) removes the pill; `systemctl --user stop bona-api` stops the backend.

## 8. Publish a property from WhatsApp (PDF → live listing)
1. Your existing owner-only WhatsApp group **"PDF"** is already wired (you will see "Bona intake connected" there). Alternatively create or rename any group so its name contains **"Bona"** (e.g. "Bona Listings") — you must be the group's creator; within ~5 minutes the service posts the same greeting there.
2. Drop a property brochure **PDF** in the group. Optional caption hints: `rent`, `SAR 4,500,000`, `#test` (dry run — summary only), `#brochure` (also publish the PDF). Within a minute it replies "Reading…", then "✅ Live: … https://bona.azoz.uk/properties/<slug>/" once the page is on the site (deploy takes ~3 min).
3. Fix-ups by replying in the group: `remove BONA-W003` · `hero BONA-W003 4` (make photo 4 the cover) · `price BONA-W003 4500000` · `sold BONA-W003`.
Verified 2026-09-06 03:56 KSA: a test brochure sent with `#test` came back in 7 minutes as a dry-run summary (title AR/EN, price from the PDF, 7 photos ranked, cover chosen). Costs ≈ $0.15–0.60 of Claude usage per PDF (60–200 s).
Rules baked in: only PDFs *you* send are processed; prices are taken only if printed in the PDF (otherwise "Price on request" — TAQEEM); invoices/IDs/contracts are rejected and never stored; the cover photo is chosen by the AI against `scripts/curate/IMAGE-RUBRIC.md`. The service (`bona-intake`) runs on this PC — if the PC is off, PDFs wait in the group and are processed when it is back. Ops: `systemctl --user status bona-intake`, `journalctl --user -u bona-intake -f`, manual run: `node ~/bona/services/intake/run-once.mjs <file.pdf> --dry-run`.

## Daily loop (already running once the repo is public)
`.github/workflows/deploy.yml`: every push and every day at 06:00 KSA it re-syncs listing status/prices from TK, regenerates llms.txt, rebuilds, deploys, and pings IndexNow. The dashboard's Integrations board shows live health of the five key URLs.
