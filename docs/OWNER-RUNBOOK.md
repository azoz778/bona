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

## Daily loop (already running once the repo is public)
`.github/workflows/deploy.yml`: every push and every day at 06:00 KSA it re-syncs listing status/prices from TK, regenerates llms.txt, rebuilds, deploys, and pings IndexNow. The dashboard's Integrations board shows live health of the five key URLs.
