# Bona — next session handoff
_Written 2026-09-09, updated ~15:00 KSA with the resolved API location, the secrets-sync gap and the wiring runbook. Supersedes nothing; read alongside `OWNER-NOW-2026-09-08.md` and
`OWNER-SOCIAL-SIGNUP.md`._

## Where things stand

**Code: done and live.** The tracking stack, the SEO fixes + `/faq/`, the content engine,
the brand assets, and the house-cap correction are all merged and deployed. `main` is clean
and equal to origin.

**Business: nothing is switched on yet.** `src/data/site.json → analytics` is still all
`null`, `~/.secrets/bona-meta-graph.env` does not exist, and `~/.secrets/bona-marketing.env`
has zero values filled. So the site measures nothing and no social account can be posted to
by a script. Everything below is about closing that gap.

**Content ready to go:** `marketing/queue/queue.json` — 169 entries over 30 days across 7
platforms. **66 are publishable immediately** (brand / education / district — these need no
REGA advertising licence). 103 are blocked on `{{AD_LICENCE}}` and must not go out until
licence numbers exist.

## STEP 1 — Meta setup — DONE 2026-09-15 except the dataset/pixel (see "Still open")

Already done: business portfolio `bona.com.sa`, Facebook Page **Bona Real Estate**, and
Accounts Center holds Facebook + Instagram `bona.com.sa`. Instagram is already a Business
account (IG id `17841427688957180`).

You were stopped at **Edit business details**, which is what greys out the "Add system user"
button. Complete it at
`business.facebook.com` → Settings → Business info → Edit:

| Field | Value |
|---|---|
| Legal name of business | `Abdulaziz Zidan` — your legal name, NOT "Bona" (no CR exists yet, and REGA expects the advertiser's real name) |
| Country / City | Saudi Arabia / Jeddah |
| Street + postal code | your real address |
| Phone | `+966593296933` |
| Business website | `https://bona-real-estate.com` |
| Tax ID / VAT | leave blank |

Then, in the `bona.com.sa` portfolio:
1. Page → Settings → Linked accounts → Instagram → connect `bona.com.sa`.
2. Settings → Accounts → **Pages** → Add → *Bona Real Estate*.
3. Settings → Accounts → **Instagram accounts** → Add → `bona.com.sa`.
4. Settings → **Data Sources → Datasets** → Add → name it *Bona Pixel* → copy the 15–16 digit ID.
5. Settings → Accounts → **Ad accounts** → Create → *Bona Ads*, currency **SAR**, timezone **Asia/Riyadh**.
6. `developers.facebook.com/apps` → Create app → type **Business** → name *Bona Publisher* →
   portfolio `bona.com.sa` → add product **Instagram Graph API**.
7. Settings → Users → **System users** → Add → `bona-poster`, role **Admin** →
   **Assign assets**: Page, Instagram, Pixel, Ad account — all *full control* →
   **Generate new token** → app *Bona Publisher* → expiry **Never** → scopes:
   `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`,
   `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`,
   `pages_manage_posts`, `business_management`, `ads_management`, `ads_read`.

Save the token (it is shown once):
```
bona-secret META_ACCESS_TOKEN 'EAA...' meta
bona-secret META_CAPI_TOKEN 'EAA...'
```

## STEP 2 — Google Analytics (~5 min)

`analytics.google.com` → Admin → Create → Property *Bona*, timezone **Riyadh**, currency **SAR**
→ Data collection → Web → `https://bona-real-estate.com`, stream *Bona Site*.
- Copy the **Measurement ID** `G-XXXXXXXXXX` — this is NOT a secret, paste it in chat.
- Same screen → Measurement Protocol API secrets → Create → then:
  `bona-secret GA4_API_SECRET 'value'` and `bona-secret GA4_MEASUREMENT_ID 'G-XXXXXXXXXX'`

## STEP 3 — Search Console (~2 min)

`search.google.com/search-console` → Add property → **Domain** → `bona-real-estate.com`.
Paste the TXT value in chat — the agent adds the Cloudflare DNS record (the token has
DNS-edit on zone `790f2dde2e03e7055f88ae4b6c05579b`), then you click Verify.

## STEP 4 — Claim the social handles (~20 min, time-sensitive)

Handles were free on 2026-09-08 but are NOT reserved. Full copy-paste detail (bios in AR+EN,
categories, every field) is in `docs/checklists/OWNER-SOCIAL-SIGNUP.md`.

- **TikTok** `bona.com.sa` — sign up with **email, not phone**; then Settings → Switch to Business Account.
- **Snapchat** `bona.com.sa` — phone SMS is mandatory, use +966 59 329 6933.
- **YouTube** `@bona.com.sa` — sign in as `bona.com.sa@gmail.com`, create a **Brand Account**, not a personal channel.
- Then X / LinkedIn / Pinterest as **`bonarealestate`** (those three forbid dots in handles).

## STEP 5 — Portals and licences

- **Bayut.sa Bronze, SAR 6,990/yr** (verified live price) — call **920035076**. Ask how many
  live listings 3,000 credits really supports for Al Shati / Obhur stock; walk if under ~15.
- **Haraj** — post free, buy **no** boosts. Put your FAL number in the ad body yourself.
- **REGA advertising licences** on your 5–7 best listings via the FAL platform. This is what
  unblocks the 103 blocked queue entries. Record them with
  `licence BONA-W### <number> <expiry>` in the WhatsApp group.
- **Lawyer:** does FAL 1100313556 cover التسويق/الإعلانات or only الوساطة? Does GAMR's
  Mawthooq licence bind a broker advertising their own listings?

## What the next session should do first

1. Read `~/.claude/projects/-mnt-c-Users-ASUS/memory/bona-growth-social-2026-09-08.md`.
2. `git -C ~/bona pull --ff-only` — several sessions push to this repo continuously.
3. Check what the owner has supplied: `site.json → analytics`, and whether the two
   `~/.secrets/bona-*.env` files have values.
4. For each value present, wire it, push, and **verify it end to end** — a GA4 Realtime hit,
   a Meta `whoami`, a live pixel fire after consent. Do not assume.
5. With a Meta token: `node scripts/instagram-post.mjs whoami`, then start publishing the 66
   unblocked queue entries.

## Wiring runbook — what the agent does the moment a value arrives

Work in a worktree off `origin/main` (`~/bona` is often checked out on another session's branch).

| Value | Where it goes | Then |
|---|---|---|
| GA4 `G-…` | `src/data/site.json → analytics.ga4` **and** `bona-secret GA4_MEASUREMENT_ID 'G-…'` | push → GitHub Pages deploy (~3 min) |
| GA4 MP secret | `bona-secret GA4_API_SECRET '…'` (owner types) | helper syncs to VPS + restarts bona-api |
| Meta Dataset/Pixel id | `site.json → analytics.metaPixel` **and** `bona-secret META_PIXEL_ID '…'` | push |
| Meta CAPI token | `bona-secret META_CAPI_TOKEN 'EAA…'` (owner) | helper syncs + restarts |
| Meta Graph token | `bona-secret META_ACCESS_TOKEN 'EAA…' meta` (owner) | `IG_BUSINESS_ID=17841427688957180 node scripts/instagram-post.mjs whoami` |
| GSC TXT value | Cloudflare TXT on zone `790f2dde…`, name `bona-real-estate.com` | owner clicks Verify |

GSC TXT (the token stays in the env file, never on the command line):

    set -a; . ~/.secrets/cloudflare.env; set +a
    curl -s "https://api.cloudflare.com/client/v4/zones/790f2dde2e03e7055f88ae4b6c05579b/dns_records" \
      -H "Authorization: Bearer $CLOUDFLARE_TOKEN" -H 'Content-Type: application/json' \
      --data '{"type":"TXT","name":"bona-real-estate.com","content":"google-site-verification=VALUE","ttl":300}'

Verify, in this order — no assumptions:

1. `node scripts/marketing/verify-integrations.mjs` on the PC — every configured row `live`.
2. `ssh hermes-vps 'curl -s localhost:4120/health'` → `fanout.dests` shows `ga4:true` / `meta:true`.
3. Browser: open the live site, accept the consent banner, confirm a `collect?v=2&tid=G-…` request
   and a `facebook.com/tr?id=…` request in the network log → GA4 **Realtime** shows the visit within
   a minute; Events Manager → the dataset → **Test events** shows a PageView.
4. `node scripts/instagram-post.mjs whoami` returns the `bona.com.sa` IG id `17841427688957180`.

## Traps that have already bitten

- **`bona-api` must be restarted after any deploy that changes it.** A merge alone leaves
  Node running old code; both new routes 404'd until it was restarted.
- **`src/data/listings.json` is GENERATED.** Never hand-merge it — run
  `node scripts/curate/build.mjs`, which reads `listings.source.mjs` + `scripts/curate/inbox/`.
- **Three writers push to this repo** (this session, another session on intake, and the intake
  daemon on every brochure). Prepare merges in a worktree; run pull+merge+push as ONE command.
- **Never restart `bona-intake`** — another session owns it.
- **Never write «تقييم مجاني»** (free valuation) anywhere — Valuers Law Art. 34(5), criminal.
- Only **Instagram, Facebook, YouTube, Pinterest** can be automated. **Snapchat has no organic
  posting API at all**; TikTok's unaudited API posts private-only. Budget ~30 min/day of manual
  posting for TikTok and Snapchat — the two platforms that matter most in Saudi.

## Resolved 2026-09-09

- **Where bona-api runs: hermes-vps**, as *system* units (`User=azoz`, `/opt/bona` sparse clone
  tracking `origin/main`, port 4120, tunnel `9022fbec…` → `api.bona-real-estate.com`).
  `bona-repo-sync.timer` pulls `main` there every 5 minutes; `bona-api` itself is only restarted
  by `services/deploy/vps/deploy.sh` or by hand:
  `ssh hermes-vps 'sudo -n systemctl restart bona-api.service'`.
  The PC's `bona-api` / `cloudflared-bona` user units are **disabled on purpose and must stay
  installed but disabled**: `services/deploy/vps/rollback.sh` re-enables them as the fail-back path.
  Never enable them (two APIs / two tunnel connectors must never run); do not delete them either.
- **Secrets entered on the PC do not reach the API by themselves.** `bona-secret` writes
  `~/.secrets/bona-marketing.env` on the PC; bona-api reads `/home/azoz/.secrets/…` on the VPS and
  loads its config once at startup. `~/.local/bin/bona-secret` now runs
  `services/deploy/vps/sync-secrets.sh` and restarts `bona-api` after every marketing key
  (`BONA_SECRET_NO_SYNC=1` to defer until the last key). `bona-meta-graph.env` is read only by the
  PC-side posting scripts and is not synced.
- **Cloudflare:** the token in `~/.secrets/cloudflare.env` can edit the `bona-real-estate.com` zone
  `790f2dde2e03e7055f88ae4b6c05579b`, but `ZID` in that file is the **tk-estates.com** zone — always
  pass the Bona zone id explicitly. The Bona zone has no TXT records yet.
- The two stray Astro dev servers (pids 1873662, 1890450 → ports 4321/4399) are orphans of the
  deleted `~/bona-wt/track-site` worktree (ppid 1). Agents may not kill processes in auto mode;
  owner: `kill 1873662 1890450`. (`:4323` is a 3-day-old preview server from another session's
  scratchpad — same treatment.)
- `docs/checklists/google-bona.md` still says `bona.azoz.uk` / `bona.sa` and a URL-prefix property.
  The live domain is `bona-real-estate.com` and the plan is a **Domain** property verified by DNS
  TXT, which also covers `api.`.
- **Concurrency, 2026-09-09 ~14:00 KSA:** four Claude sessions were active on this repo at once. One
  drives the Bona Chrome (`:9223`) through the Meta app + system-user flow and owns
  `feat/ig-calendar-publisher` (`~/bona` is checked out on it). Never drive `:9223` from two
  sessions; do other sessions' work in a worktree off `origin/main`.

## Still open

- **Foreign property stays in the queue and is unblocked (owner decision 2026-09-09 ~14:50 KSA).**
  The owner holds a marketing authorisation from the developer for the Muscat / Marbella / Dubai
  stock, so those posts are marketed on that basis, not on a REGA per-ad licence (which binds to a
  Saudi deed and can never be issued for them). Implemented in `scripts/social/lib/listing.mjs`
  `adLicence()`: `developer-authorisation` (outside the Kingdom: developer line in caption + CTA
  card, never blocked) · `rega-ad-licence` (a recorded, unexpired `listing.licence.adNumber`:
  the number is printed, entry publishable) · `rega-pending` (placeholder, blocked). Every queue
  entry now carries `licenceBasis`. So the moment the owner records a REGA number with
  `licence BONA-### <number> <YYYY-MM-DD>` in the WhatsApp group, a rebuild + `queue.mjs --render`
  unblocks that listing's posts with the real number on caption and card — no hand edits.
  Ask the lawyer to confirm the foreign-marketing basis explicitly (developer mandate vs a REGA
  permit for marketing property outside the Kingdom) alongside the two FAL questions.
- **Queue re-planned from 2026-09-10.** `listings.json` gained five listings after the first plan,
  so the generator is not a like-for-like regeneration (103 entries re-assigned). Nothing had been
  posted, so the new plan is the plan. Rendered assets (≈205 MB, gitignored) live in
  `~/bona-wt/ops/marketing/queue/` — NOT in `~/bona`, which only ever had `queue.json`. The older
  render in `~/bona-wt/social/marketing/queue/` is stale (foreign CTA cards carry the REGA
  placeholder there). A worktree needs `npm ci` before `--render` works (sharp is native).
- **Facebook is LIVE (2026-09-15 06:38 KSA).** The app now has the use case *Manage everything on
  your Page* (added from the owner's Chrome :9223 with `~/.claude/scripts/cdp-bona.mjs`), the
  system user `claude` holds a never-expiring token with all 20 scopes (incl. `pages_manage_posts`,
  `business_management`; NOT `ads_management`), the opening brand post q-046 is on the Page
  (`~/bona-data/fb/published.jsonl`), and `bona-fb-publish.timer` is enabled next to the Instagram
  one (both 17:00–23:45 KSA, from `~/bona-publish`). `journalctl --user -u bona-fb-publish -o cat -n 50`.
- **Meta connector (claude.ai "Meta ads" MCP) is connected in the owner's Claude session** and
  answers read-only questions: portfolio 3210786215773541 has **no dataset/pixel** and **no Bona ad
  account** (only a personal ad account "Tarek Shams", no business, no payment method). The agent
  may not create the dataset (classifier: real-world transaction) — the owner types this once:

      ! set -a; . ~/.secrets/bona-meta-graph.env; set +a; curl -s -X POST -H "Authorization: Bearer $META_ACCESS_TOKEN" "https://graph.facebook.com/v23.0/$META_BUSINESS_ID/adspixels" --data-urlencode "name=Bona web"

  → `{"id":"<15–16 digits>"}` = `META_PIXEL_ID` = `site.json → analytics.metaPixel`. Then the CAPI
  token: Events Manager → *Bona web* → Settings → Conversions API → **Generate access token** →
  `bona-secret META_CAPI_TOKEN 'EAA…'` (the system-user token lacks `ads_management`, so it cannot
  send CAPI events itself).

## 2026-09-16 — tracking verified end to end; one owner action left

- **Wired on 09-15 (PRs #5–#8):** GA4 `G-861TD74EW1`, Meta dataset **1102591712117129** ("Bona
  Real Estate Website", owner bona.com.sa), Search Console HTML tag; PC marketing env holds the pixel
  id, CAPI token, GA4 id + secret; VPS fan-out reports `dests:{meta:true,ga4:true}`.
- **Proven, not assumed:** after "Accept all" the live page requests
  `google-analytics.com/g/collect?…tid=G-861TD74EW1` and `facebook.com/tr/?id=1102591712117129&ev=PageView`;
  a Conversions API POST answers `events_received: 1`; `verify-integrations.mjs` → 7 live · 0 error
  (its probe needed a browser id — PR #12). Only Snap and TikTok are pending, by design.
- **Fan-out scope:** only `lead_created`, `form_submit`, `whatsapp_click` (+ stages viewing/won) are
  forwarded server-side; page views are browser-only. The 15 `skipped` rows are leads from before the
  keys existed.
- 🔴 **Owner: clear the test code.** While `META_TEST_EVENT_CODE` is set the fan-out sends every real
  lead as a *test* event (visible only under Test events, never in reporting or ad optimisation):

      bona-secret META_TEST_EVENT_CODE ''

  (the helper accepts an empty value now; it syncs the VPS and restarts the API.)
- Owner-only confirmations: GA4 → Reports → Realtime shows visits; Search Console property verified
  and `sitemap-index.xml` submitted.
- Facebook publisher: unit sandbox fix (PR #11) — the sync step could not write the shared git dir;
  the installed unit is already refreshed. Nothing publishable on Facebook until 09-24 unless REGA
  numbers are recorded (`licence BONA-### <number> <YYYY-MM-DD>` in WhatsApp, then a rebuild and
  `queue.mjs --render`).
