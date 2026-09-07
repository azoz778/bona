# Bona — social channel signup checklist

**For:** Abdulaziz Zidan · **Prepared:** 2026-09-08 · **Availability checked:** 2026-09-08

Everything below is copy-paste. Work top to bottom. Do not improvise handles —
they were checked one by one and the ones listed are the ones that were free.

---

## 0. The handle decision (read this first)

**There is no single string that works on all eight platforms.** X, LinkedIn and
Pinterest do not allow dots in a handle, so `bona.com.sa` is *impossible* there —
not taken, structurally illegal. So we use two handles:

| | Handle | Where |
|---|---|---|
| **Primary** | `bona.com.sa` | Instagram (owned), Threads (auto), TikTok, YouTube, Snapchat |
| **Dot-free twin** | `bonarealestate` | X, LinkedIn, Pinterest |

**Why this split and not the reverse:** `bonarealestate` is **already taken on
TikTok** (a dormant account, "Bona Real Estate", 6 followers). TikTok and Snapchat
are the two biggest platforms in Saudi Arabia — losing the primary handle there
would be far worse than losing dot-consistency on X. `bona.com.sa` is free on
TikTok, YouTube and Snapchat, and it already matches the Instagram account, which
is the flagship. This split gets the exact Instagram handle on 5 of 8 platforms.

**Handles that were rejected, with reasons:**

| Candidate | Verdict |
|---|---|
| `bonaksa` | **Dead.** Taken on YouTube, Snapchat, Pinterest ("Bona Perry") and X ("7amood"). |
| `bona.sa` | Taken on TikTok ("Bana.sa"). `bona_sa` and `bonasa` also taken on X. |
| `bonaproperties` | Taken on X by **"Bona Properties"** — another real-estate firm. Avoid: direct name collision. |
| `bona.jeddah` | Free most places, but locks the brand to one city. Rejected on brand grounds, not availability. |
| `bona.realestate` | Free on TikTok/YouTube/Snapchat, but illegal on X/LinkedIn/Pinterest — solves nothing that `bona.com.sa` doesn't. |

### Availability evidence

| Platform | `bona.com.sa` | `bonarealestate` | How checked |
|---|---|---|---|
| TikTok | **FREE** | TAKEN (6 followers) | oEmbed API `code:400` + browser "Couldn't find this account" |
| YouTube | **FREE** | FREE | HTTP 404 + `<title>404 Not Found</title>`; control: `@bonaksa` → 200 "bonaksa - YouTube" |
| Snapchat | **FREE** | FREE | HTTP 404 + browser "Sorry, This content was not found"; control: `bonaksa` → 200 |
| X / Twitter | *illegal (dot)* | **FREE** | HTTP 404 "User Profile Not Found" + browser "this page doesn't exist" |
| LinkedIn | *illegal (dot)* | **FREE** | `/company/bonarealestate` → bare `<title>LinkedIn</title>`; control: `bona-real-estate` → 200 "Bona Real Estate \| LinkedIn" |
| Pinterest | *illegal (dot)* | **FREE** | Browser: "We can't find that idea!"; control: `bonasa` → 200 "Bona (bonasa)" |
| Threads | **inherited** | — | Threads takes the Instagram username automatically; nothing to claim |

> ### ⚠️ Two things you need to know before you start
>
> **1. `linkedin.com/company/bona-real-estate` is already taken — by a real company
> with our exact name.** "Bona Real Estate", 8700 Reseda Blvd, Northridge,
> California, 60 followers, 36 employees, `gmartine.realtor`. Different country,
> different market, no KSA trademark conflict expected — but the obvious LinkedIn
> URL is gone, and people searching "Bona Real Estate" on LinkedIn will find them.
> Use `bonarealestate` as the slug and **"Bona | بونا"** as the page name so we are
> not competing head-on with an identically-named US firm in LinkedIn search.
>
> **2. We do not own the domain `bona.com.sa`.** The handle looks like a domain we
> don't control (our site is `bona-real-estate.com`). This is cosmetically fine and
> reads well in Saudi (`.com.sa` signals a Saudi commercial entity), but a `.com.sa`
> registration requires a Saudi CR + trademark. Worth putting on the list once the CR
> exists, so nobody else registers a domain matching our handle.

---

## 1. Before you touch any signup form

Have these open / ready — every form below asks for some of them:

| Field | Value |
|---|---|
| Email | `bona.com.sa@gmail.com` |
| Phone (SMS verification) | `+966 59 329 6933` |
| Website | `https://bona-real-estate.com` |
| Business name | `Bona` |
| Legal name | `Bona Real Estate` |
| Arabic name | `بونا` |
| Category | Real Estate / Real Estate Agent |
| Address | Al Rawdah District, Jeddah 23432, Saudi Arabia |
| Hours | Sunday–Thursday, 10:00–19:00 |
| REGA licence | `FAL 1100313556` |

**Profile art** — all files are in `~/bona/marketing/brand/`:

| File | Use it for |
|---|---|
| `avatar-320.png` | Instagram, TikTok, Threads |
| `avatar-400.png` | LinkedIn, Pinterest, Snapchat |
| `avatar-800.png` | YouTube, X (they downscale; give them the big one) |
| `avatar-dark-*.png` | Alternate — ink background. Use only if you want the dark look; **pick one and stay with it.** |
| `youtube-banner-2560x1440.png` | YouTube channel banner |
| `x-header-1500x500.png` | X header |
| `linkedin-cover-1128x191.png` | LinkedIn company cover |
| `snapchat-hero-1080x1920.png` | Snapchat public profile hero |

> **One warning about the phone number.** `+966 59 329 6933` is also the WhatsApp
> Business number. Some platforms (X, TikTok, Snapchat) bind a phone number to an
> account and will not let you reuse it. Verify by **email** wherever the form
> offers the choice, and keep the phone for the two platforms that force it
> (Snapchat, and X if it challenges you).

---

## 2. TikTok

**This is the highest-value account on this list for Jeddah. Do it first.**

| Field | Value |
|---|---|
| Signup URL | https://www.tiktok.com/signup |
| Then switch to Business | Profile → ☰ → Settings and privacy → Account → **Switch to Business Account** |
| Username | `bona.com.sa` |
| Display name | `Bona · بونا` |
| Category | Real Estate |
| Website | `https://bona-real-estate.com` |
| Avatar | `avatar-320.png` |

**Bio (80 char limit) — Arabic primary (64 chars):**
```
عقارات فاخرة في جدة. فلل وبنتهاوس وواجهات بحرية. المعاينة بموعد.
```
**English alternative (69 chars):**
```
Private luxury real estate, Jeddah. Villas · penthouses · waterfront.
```

**Verification you will hit:** email code, then a slider captcha. If it asks for a
phone, use email instead — TikTok binds phone numbers hard.

**Note:** a Business Account gets the website link field and analytics; a Creator
account does not get the link. Take Business.

---

## 3. Snapchat

**Second-highest value in Saudi. Do it second.**

| Field | Value |
|---|---|
| Signup URL | https://accounts.snapchat.com/accounts/signup |
| Then create the Public Profile | https://business.snapchat.com → Public Profiles → Create |
| Username | `bona.com.sa` |
| Display name | `Bona · بونا` |
| Category | Real Estate |
| Website | `https://bona-real-estate.com` |
| Avatar | `avatar-400.png` |
| Hero image | `snapchat-hero-1080x1920.png` |

**Bio (80 char limit) — Arabic (55 chars):**
```
بونا — عقارات فاخرة في جدة. فلل وبنتهاوس وواجهات بحرية.
```
**English (60 chars):**
```
Bona — private luxury real estate in Jeddah. By appointment.
```

**Verification you will hit:** **phone SMS is mandatory** — Snapchat will not let
you finish on email alone. Use `+966 59 329 6933`. This is the one platform where
you must spend the number.

---

## 4. YouTube

| Field | Value |
|---|---|
| Signup URL | https://www.youtube.com/create_channel (sign in as `bona.com.sa@gmail.com` first) |
| Create a **Brand Account**, not a personal one | YouTube → Settings → Add or manage your channel(s) → Create a channel |
| Handle | `@bona.com.sa` |
| Channel name | `Bona · بونا` |
| Avatar | `avatar-800.png` |
| Banner | `youtube-banner-2560x1440.png` |
| Website link | `https://bona-real-estate.com` |
| Links to add | Website · Instagram · WhatsApp (`https://wa.me/966593296933`) |

**Channel description (1000 char limit) — paste both, Arabic first:**
```
بونا بوتيك عقاري فاخر في جدة، المملكة العربية السعودية. في هذه القناة: جولات سينمائية في الفلل والبنتهاوس والمنازل الواجهية في جدة والرياض، أدلّة الأحياء، وشروحات مبسّطة عن شراء وبيع وتأجير العقار في المملكة. وساطة مرخّصة من الهيئة العامة للعقار، رخصة فال 1100313556. للاستفسار: واتساب 966593296933+

Bona is a private luxury real-estate boutique in Jeddah, Saudi Arabia. On this channel: cinematic walkthroughs of villas, penthouses and waterfront homes in Jeddah and Riyadh, district guides, and plain-language explainers on buying, selling and letting property in the Kingdom. A REGA-licensed brokerage, FAL 1100313556.

Enquiries: WhatsApp +966 59 329 6933 · https://bona-real-estate.com
Viewings by appointment, Sunday–Thursday 10:00–19:00 KSA, in Arabic or English.
```

**Verification you will hit:** phone verification is required before you can upload
videos longer than 15 minutes or use custom thumbnails. Do it now
(https://www.youtube.com/verify) so it is not blocking you later.

**Create a Brand Account, not a personal channel** — a Brand Account can have
multiple managers and can be transferred. A personal channel is tied to one Google
login forever. This matters when you hire someone.

---

## 5. X (Twitter)

| Field | Value |
|---|---|
| Signup URL | https://x.com/i/flow/signup |
| Username | `bonarealestate` ← **not** `bona.com.sa`; X allows only letters, numbers and `_` |
| Display name | `Bona · بونا` |
| Location | `Jeddah, Saudi Arabia` |
| Website | `https://bona-real-estate.com` |
| Avatar | `avatar-800.png` |
| Header | `x-header-1500x500.png` |

**Bio (160 char limit) — Arabic (141 chars):**
```
بونا — عقارات فاخرة خاصة في جدة. فلل، بنتهاوس، وواجهات بحرية وعقارات خارج السوق. المعاينة بموعد. رخصة فال 1100313556. واتساب +966 59 329 6933
```
**English (125 chars):**
```
Private luxury real estate in Jeddah. Villas, penthouses, waterfront & off-market homes — by appointment. REGA FAL 1100313556
```

**Verification you will hit:** email code; X often adds a phone challenge on new
accounts from a fresh IP. Have the phone ready but try email first.

---

## 6. LinkedIn (company page)

You need a **personal LinkedIn profile** to create a company page. You have one —
use it. The company page is separate from your profile.

| Field | Value |
|---|---|
| Create URL | https://www.linkedin.com/company/setup/new/ |
| Page name | `Bona \| بونا` ← **not** "Bona Real Estate" (a US firm of that exact name already owns that identity on LinkedIn) |
| Public URL | `linkedin.com/company/` **`bonarealestate`** |
| Industry | Real Estate |
| Company size | 2–10 employees |
| Company type | Privately held |
| Website | `https://bona-real-estate.com` |
| HQ | Jeddah, Makkah Province, Saudi Arabia |
| Founded | 2026 |
| Logo | `avatar-400.png` |
| Cover | `linkedin-cover-1128x191.png` |

**Tagline (120 char limit) — 113 chars:**
```
Private luxury real estate boutique in Jeddah — villas, penthouses, waterfront and off-market homes. FAL 1100313556
```

**Specialties (add each as a separate tag):**
```
Luxury residential brokerage · Off-market sales · Waterfront property · Off-plan advisory · International property · Jeddah · Riyadh
```

**About (2000 char limit) — paste both:**
```
بونا بوتيك عقاري فاخر في جدة. نمثّل محفظة منتقاة من الفلل والبنتهاوس والمساكن الواجهية والعقارات خارج السوق في جدة والرياض ووجهات عالمية مختارة، ونعمل لصالح المُلّاك الذين يفضّلون تسويق منازلهم بخصوصية. وساطة مرخّصة من الهيئة العامة للعقار (رخصة فال 1100313556). كل منزل يُعرض بموعد مسبق، بالعربية أو الإنجليزية.

Bona is a private luxury real-estate boutique in Jeddah. We represent a curated portfolio of villas, penthouses, waterfront residences and off-market homes across Jeddah, Riyadh and select international destinations, and we act for owners who prefer their home to be marketed with discretion.

We are a REGA-licensed brokerage (FAL 1100313556). Every home is shown by appointment, in Arabic or English.

Sunday–Thursday, 10:00–19:00 KSA · WhatsApp +966 59 329 6933 · https://bona-real-estate.com
```

**Verification you will hit:** none for the page itself. LinkedIn may later ask you
to verify the company by email on a matching domain — that will need a
`@bona-real-estate.com` mailbox, which does not exist yet. Not blocking.

---

## 7. Pinterest

Lower priority than the others, but genuinely strong for interiors and it feeds
Google Images. Fifteen minutes.

| Field | Value |
|---|---|
| Signup URL | https://www.pinterest.com/business/create/ (create a **Business** account directly) |
| Username | `bonarealestate` ← dots are illegal on Pinterest |
| Display name | `Bona \| Luxury Real Estate` |
| Website | `https://bona-real-estate.com` (claim it — see below) |
| Avatar | `avatar-400.png` |

**About (500 char limit) — 197 chars:**
```
Bona is a private luxury real-estate boutique in Jeddah, Saudi Arabia. Villas, penthouses, waterfront residences and off-market homes, shown by appointment. REGA-licensed brokerage, FAL 1100313556.
```

**Claim the website** (Settings → Claimed accounts → Claim website): Pinterest gives
you an HTML `<meta>` tag. Send it to the dev session and it goes into the site head —
claiming makes every image on `bona-real-estate.com` attributable to us and unlocks
analytics.

---

## 8. Threads

**Nothing to sign up for.** Threads is created from the Instagram account and takes
the **same username automatically** — `bona.com.sa` is already reserved for you.

1. Open Instagram → Profile → ☰ → **Threads**
2. It offers to import name, bio and avatar from Instagram — accept.
3. Then replace the bio with the version below (Threads allows 150 chars).

**Bio (97 chars):**
```
بونا — عقارات فاخرة خاصة في جدة. فلل، بنتهاوس، وواجهات بحرية. المعاينة بموعد. رخصة فال 1100313556
```

Link: `https://bona-real-estate.com`

---

## 9. WhatsApp Channel

A Channel is a broadcast feed — separate from the WhatsApp Business chat number.
Channel names are **not unique handles**, so nothing to check; you just create it.

1. WhatsApp → **Updates** tab → ➕ → **New channel**
2. Name: `Bona · بونا`
3. Icon: `avatar-320.png`

**Description (500 char limit) — 223 chars:**
```
بونا — بوتيك عقاري فاخر في جدة. فلل وبنتهاوس وواجهات بحرية وعقارات خارج السوق، بموعد مسبق. رخصة فال 1100313556.
Bona — private luxury real estate, Jeddah. Villas, penthouses, waterfront and off-market homes, by appointment.
```

After creating it, WhatsApp gives you a link like `https://whatsapp.com/channel/XXXX`.
**Send that link back** — it goes in the site footer and in every other bio.

---

## 10. Order to do these in

| # | Platform | Time | Why this order |
|---|---|---|---|
| 1 | TikTok | 10 min | Biggest reach in KSA; the handle is the one at risk |
| 2 | Snapchat | 10 min | Second-biggest in KSA; needs the phone, do it while you have it out |
| 3 | YouTube | 15 min | Brand Account + phone verification takes longest |
| 4 | X | 5 min | Quick |
| 5 | LinkedIn page | 10 min | Needs your personal profile logged in |
| 6 | Threads | 3 min | Just an import from Instagram |
| 7 | WhatsApp Channel | 3 min | Send back the link |
| 8 | Pinterest | 15 min | Lowest urgency; do it when the others are done |

---

## 11. Automated posting — what is actually possible

Honest assessment. **Two of these six are realistically automatable. The rest stay manual.**

| Platform | Automatable? | Reality |
|---|---|---|
| **YouTube** | ✅ **Yes — easiest** | We already have a working OAuth pattern |
| **Pinterest** | ✅ Yes | Free API, straightforward |
| **LinkedIn** | ⚠️ Possible but slow | Needs partner approval |
| **TikTok** | ⚠️ Possible, degraded | Unaudited apps post *private-only* |
| **X** | ❌ Not worth it | Paid tiers only |
| **Snapchat** | ❌ No | No organic posting API exists |

### YouTube — do this one

We have a proven pattern in the TK project:

- `~/scripts/tk-youtube-oauth-setup.py` — the OAuth device/loopback flow
- `~/scripts/tk-youtube-post.py` — the upload script
- Credentials: `~/.secrets/tk-youtube-oauth-client.json` + `~/.secrets/tk-youtube-token.json`

**A Bona equivalent needs exactly four things:**
1. A **new Google Cloud project** for Bona (do not reuse TK's — separate brands, separate quota, separate consent screen).
2. YouTube Data API v3 enabled on it.
3. An **OAuth 2.0 Desktop client** → download as `~/.secrets/bona-youtube-oauth-client.json`.
4. Run the setup script once, signed in as `bona.com.sa@gmail.com`, granting `youtube.upload` → writes `~/.secrets/bona-youtube-token.json`.

Then `tk-youtube-post.py` works against Bona by pointing it at the Bona credential
files. **Quota reality:** the default 10,000 units/day allows roughly **6 uploads
per day** (1,600 units each) — far more than we need. No API audit required for
uploading to your own channel.

### TikTok — the audit is the catch

TikTok **Content Posting API** (developers.tiktok.com → create app → add
`video.publish` scope). The important detail:

- **Unaudited app:** you can only post to **private / self-only** visibility. Useless for marketing.
- **Audited app:** public posting. Requires submitting the app for review, a demo video of the integration, and a privacy policy URL. Takes weeks and is often rejected for small single-brand use cases.

**Recommendation: post TikTok manually.** The audit cost is not worth it for one
brand account, and TikTok's algorithm treats natively-uploaded video better anyway.

### LinkedIn — the MCP cannot do it

**I checked the LinkedIn MCP installed on this machine** (`mcp-server-linkedin`, run
Windows-side via `uvx.exe`/mcporter). It exposes 19 tools. **None of them create a
post.** The full write surface is `connect_with_person` and `send_message` (DMs).
Everything else is read-only scraping: `get_person_profile`, `get_company_profile`,
`get_company_posts`, `get_feed`, `search_*`, `get_inbox`.

> **It cannot post to a company page. Not "not configured" — the capability does not exist in the tool.**

The real path is the official LinkedIn **Marketing Developer Platform** (`w_organization_social`
scope), which requires applying for partner access with a company page you already
admin. Approval is discretionary and typically takes 2–6 weeks. Worth applying for
*after* the page has some history — a brand-new page with no posts is usually rejected.

### X — cost reality in 2026

The free tier is **write-only, 500 posts/month, no read access**. That is technically
enough to auto-post, but the Basic tier ($200/month) is what you need for anything
beyond blind posting. **At our volume this is not worth $200/month.** Post manually
or via a scheduler.

### Snapchat

There is **no public API for organic posting** to a Public Profile. The Snapchat
Marketing API is for **paid ads only**. Stories and Spotlight are manual, from the
phone, permanently. Plan for that.

### Practical recommendation

Automate **YouTube** (cheap, proven, we have the pattern) and **Pinterest**. Treat
TikTok, Snapchat, X and LinkedIn as manual posting with a scheduling tool. The
content pipeline should produce the assets; a human posts them.

---

## 12. After you finish — send these back

So the site, schema and every other bio can be updated in one pass:

- [ ] TikTok URL
- [ ] Snapchat URL
- [ ] YouTube channel URL + channel ID
- [ ] X URL
- [ ] LinkedIn company page URL
- [ ] Pinterest URL
- [ ] Threads URL
- [ ] WhatsApp Channel invite link

---

## Appendix — known follow-ups

1. **`marketing/social-bios.md` and `public/og-default.png` still say `bona.azoz.uk` / `bona.com.sa`.** The live domain is `bona-real-estate.com`. The bios in *this* file are corrected; `og-default.png` still renders the old domain in the image itself and should be regenerated.
2. **Instagram `@bona.com.sa` is still a personal account**, not Business/Creator — see `marketing/instagram-access.md`. That blocks the Meta posting API and Threads' business features. Unrelated to this checklist but on the critical path.
3. **Register `bona.com.sa` as a domain** once the CR exists, so the handle and a real domain match.
4. **Do not use `bonaproperties` anywhere** — an active X account "Bona Properties" already uses that name in real estate.
