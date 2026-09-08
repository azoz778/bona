# Bona — next session handoff
_Written 2026-09-09. Supersedes nothing; read alongside `OWNER-NOW-2026-09-08.md` and
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

## STEP 1 — Finish the Meta setup (biggest unlock, ~20 min)

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

## Open questions for the agent to resolve

- `bona-api` and `cloudflared-bona` are **disabled** systemd units and not running on this
  machine, yet `api.bona-real-estate.com` is healthy with hours of uptime — so the origin is
  running somewhere this session does not control. Find out where, and decide whether the
  local units should be enabled or removed.
- Two stray Astro dev servers are running from `~/bona-wt/track-site` (ports 4321, 4399).
- 17 queued posts are for foreign property (Muscat, Dubai, Le Vésinet, Marbella) blocked on a
  Saudi ad licence that can never be issued for them. Decide: separate legal route, or drop.
