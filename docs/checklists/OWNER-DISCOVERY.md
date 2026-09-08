# Owner checklist — getting Bona found

**Written 2026-09-08.** Everything here needs you, Abdulaziz, because it needs a real person, a Saudi phone,
a payment card or a government login. Work top to bottom — the order is deliberate.

Anything marked **→ paste into chat** means Claude finishes it for you once you hand over the value.

---

## 0. First, the one that is a legal exposure

### ☐ 0.1 Confirm what licence 1100313556 actually is — 5 minutes

Log in to **<https://eservicesredp.rega.gov.sa>** and confirm two things:

1. That **1100313556** is a **brokerage-and-marketing (فال) licence**, not another licence class.
2. That its scope **includes التسويق (marketing)** — the advertising-licence flow will not run without it.

*Why:* the number is printed in the site footer, in the JSON-LD on every page, and will go on the Google
Business Profile and every portal account. An Aqar guidance article describes a numbering convention under
which brokerage licences start with 6 and advertising licences with 7 — and 1100313556 fits neither. That
guidance is unverified and may simply be wrong, but five minutes now beats a blocked listing later.

### ☐ 0.2 Understand that the website itself needs advertising licences

**This is the most consequential finding in the research and the easiest to miss.**

Under the Regulatory Bylaw on Real Estate Marketing and Advertising (in force **1 May 2026, no grace
period**), `bona-real-estate.com` is an **advertising channel**. The exemption for "electronic real-estate
platforms" applies to licensed third-party marketplaces like Aqar and Bayut — not to a brokerage publishing
its own listings.

So every listing page on the site must carry:

- the **advertising licence number**, displayed prominently
- the **licence expiry date**
- the FAL number (already there)
- contact details **identical to those on the licence application** — the site's +966 59 329 6933 must be the
  number on every ad licence

**Right now the site shows none of the per-listing licence data.** As built, it does not satisfy the bylaw.

**What you do:** obtain advertising licences for the listings that are publicly published (see 0.3), then
paste the numbers and expiry dates into the chat — the site can then render them. The bylaw permits a compact
form: **the licence number plus a QR code** linking to the full disclosure, which keeps the pages clean.

**Interim option if you would rather not licence all of them at once:** unpublish the listings you are not
ready to licence, and keep the rest. Fewer compliant listings is a better position than many non-compliant ones.

### ☐ 0.3 The route to an advertising licence, per property

1. Register a **brokerage contract (عقد وساطة)** with the owner on REGA e-services — choose the
   **«وسيط فرد» (individual broker)** role. Your individual FAL is sufficient; **no Commercial Registration is
   required.** You will need the **electronic title-deed number** and the **owner's ID number**. REGA verifies
   the deed automatically, then sends the contract to the owner to approve.
2. Make sure the contract's scope includes **«التسويق» (marketing)** — this is what enables the ad licence.
3. Issue the **advertising licence** for the ad, declaring the channels it covers. **Include "social media
   platforms"** if the property will appear on Instagram — social is in scope under the same bylaw.
4. Note the **expiry date**. Ad licences expire and must be renewed; this becomes a recurring chore.

---

## 1. Google Search Console — do this today (10 min)

The site is live, correct and completely unknown to Google. There is no Search Console property, so Google has
never been told it exists. This is the highest-value 15 minutes in this document.

### ☐ 1.1 Get the verification value
1. <https://search.google.com/search-console>
2. **Add property** → the left-hand **Domain** box
3. Type `bona-real-estate.com` — no `https://`, no `www.` → **Continue**
4. Copy the whole TXT string it shows: `google-site-verification=XXXXXXXX…`
5. **→ paste into chat.** Claude adds it to Cloudflare (the DNS token was tested against this zone on
   2026-09-08 and works), tells you when it has propagated, and you click **Verify**.

### ☐ 1.2 Straight after verifying
- **Sitemaps** → add `sitemap-index.xml` → Submit
- **URL Inspection** → *Request indexing* on these ten (Google allows about ten a day):

```
https://bona-real-estate.com/
https://bona-real-estate.com/ar/
https://bona-real-estate.com/properties/
https://bona-real-estate.com/ar/properties/
https://bona-real-estate.com/properties/for-sale/
https://bona-real-estate.com/faq/
https://bona-real-estate.com/ar/faq/
https://bona-real-estate.com/about/
https://bona-real-estate.com/sell/
https://bona-real-estate.com/contact/
```

- **Tomorrow:** spend the next ten on your strongest individual listings.

---

## 2. Bing Webmaster Tools (5 min, after step 1)

Bing is the index behind **Microsoft Copilot** and part of **ChatGPT search**. Being in Bing is being in AI
answers.

### ☐ 2.1
1. <https://www.bing.com/webmasters> → sign in with the same Google account
2. **Import from Google Search Console** — one click, no second DNS record
3. Sitemaps → add `https://bona-real-estate.com/sitemap-index.xml`
4. Left nav → **IndexNow** → confirm key `b0na7c3f9e2d4a1b8f6e5c4d3b2a1908` shows active

**IndexNow itself needs nothing from you.** It was tested end to end on 2026-09-08 — the key file returns
HTTP 200 and a live submission returned HTTP 200 — and it already runs automatically after every deploy.

---

## 3. Google Business Profile — the biggest free win (45 min + verification)

Full detail, including the ten ready-to-paste posts, is in **`marketing/google-business-profile.md`**.

### ☐ 3.1 Before you start, have ready
- The **FAL certificate, printed** (you will need to show it on camera)
- Logo `public/icon-512.png`, cover `public/og-default.png`
- 10+ property photos, **renamed descriptively** before upload (`jeddah-al-shati-mansion-pool.jpg`, not
  `IMG_4821.jpg`)

### ☐ 3.2 Create it
1. <https://business.google.com> → **Add business**
2. Name: **Bona** — Arabic field **بونا**. **Nothing else.** Do not add "Real Estate Jeddah" or any keyword;
   keyword-stuffed names are the most common cause of Saudi GBP suspension.
3. Primary category: **Real estate agency**
4. If the Al Rawdah office is not a place clients walk into unannounced, choose *"I deliver goods and services
   to my customers"* → hide the address → set service areas (the district list is in the GBP doc)
5. Phone **+966 59 329 6933**, website **https://bona-real-estate.com**
6. Hours: Sunday–Thursday 10:00–19:00

### ☐ 3.3 Expect video verification — this is the Saudi reality

For Saudi real-estate categories Google usually skips postcard and phone and asks for a **video call or
recording**. Prepare rather than improvise:

- Record **during working hours, from the actual office.** Not from a car, not from home.
- In one unbroken take, show: the **street and building exterior** → **signage or nameplate** → **inside the
  office** → **evidence you run the business**: the printed FAL certificate, headed paper, a business card, and
  the phone you registered ringing when they call it.
- **The printed FAL certificate is the strongest single artefact for this category.** Have it in shot.
- A failure gives you a second attempt. A second failure locks the profile for weeks. Do not attempt it
  unprepared.

### ☐ 3.4 Once verified
- Paste in the description, attributes and services from the GBP doc (Arabic description as a second-language
  edit after the first save)
- Upload photos in the documented order — logo and cover first, they govern the knowledge panel
- Add 6–9 listings to the **Products** tab (table of names, prices and links is in the GBP doc)
- Seed the five **Q&A** entries yourself
- Turn on **Messaging** with the supplied welcome message
- Publish **Post 1** — one a week thereafter, all ten written and ready
- **→ paste the Place ID into chat** (<https://developers.google.com/maps/documentation/places/web-service/place-id>)
  so the site's Organization schema can carry `hasMap` and a review link

### ☐ 3.5 Reviews — the single biggest ranking lever
Ten genuine reviews in 90 days will move this profile further than anything else. Ask on WhatsApp after every
completed viewing. Reply to every review within 48 hours in the reviewer's language. **Never offer anything in
exchange** — that is the second most common suspension cause.

---

## 4. Portals — spend SAR 6,990, and not a riyal more

Full comparison with sources in **`docs/research/2026-09-08-portals.md`**.

### ☐ 4.1 Bayut.sa — BUY. Call **920035076**

**Expected: Bronze at SAR 6,990/year.** Bayut is the only portal with real Jeddah *luxury* inventory —
**90+ villas at SAR 5m or above, 31 in Al Shati and 30 in Al Rawdah**, exactly the districts your portfolio
sits in. It accepts your **individual FAL with no CR** (it takes "a commercial registration number **or**
national identity number, depending on which you used to issue your FAL"). Its "REGA Verified Information"
panel is the best compliance presentation of any portal — useful credibility for a new name.

**Get these in writing before you pay:**
- [ ] The annual fee (SAR 6,990 is expected, **not confirmed** — Bayut publishes no prices publicly, and that
      figure comes from a prior quote to a different brand)
- [ ] How many **credits** the package includes
- [ ] The **SAR value of one credit**
- [ ] **How many Jeddah villa listings Bronze actually supports for a year** — ask this explicitly. Bayut's
      credit consumption is dynamic: a 1–2M property in a popular area costs **24 credits** basic and **144**
      signature, against the "10 credits" on the public page. A Jeddah luxury villa burns roughly **2.4×** the
      advertised cost. **If the answer is fewer than about 15 live listings, Bronze is the wrong tier** — talk
      about Silver, or walk and buy Aqar instead.

### ☐ 4.2 Haraj — post free, buy nothing
Free to post, needs only a Saudi mobile number. Put the land plots and the lower end of the portfolio there.
**Buy no boosts.** Luxury buyers do not shortlist from Haraj, but land does move there.
Note: free does **not** exempt the ad from needing a REGA advertising licence.

### ☐ 4.3 Do not do these
- **dubizzle Saudi — skip.** It has essentially zero property listings nationally, and it is the same group as
  Bayut, so you would buy the same demand twice.
- **Amakkn — drop it.** Site returns 504s; both apps are delisted.
- **Wasalt — later, and only with a written fee schedule.** Its main listing route is a **success fee on
  completed deals at an undisclosed rate.** Never sign that without the percentage in writing.
- **Property Finder KSA — skip year 1.** Harshest contract terms, unpublished price, thinnest Saudi audience.

### ☐ 4.4 Review in 3 months
Reconsider **Aqar at SAR 1,999/yr** (verified individual tier, no CR, no success fee, and — for a limited
period — it issues your REGA advertising licences **free**) if Bayut's lead quality disappoints, or if that
free-licence promotion is still running. It is the best raw value in the research; it lost only on
positioning.

---

## 5. WhatsApp Channel — free, 10 minutes

Full setup and the first ten broadcasts are in **`marketing/whatsapp-channel.md`**.

### ☐ 5.1
1. WhatsApp on **+966 59 329 6933** → **Updates** tab → **＋** → **New channel**
2. Name `Bona | بونا`, photo `public/icon-512.png`, description from the doc (Arabic first)
3. **→ paste the invite link into chat** (`https://whatsapp.com/channel/…`) so it can go in the site footer
4. Add it yourself to: Instagram bio, email signature, and a GBP post
5. Post two to three times a week. **Never daily.**

**Understand what it is:** follower phone numbers are hidden from you and from each other. It is a broadcast
surface, **not a lead list** — you can never export it or message a follower directly. Every conversation
still starts with them tapping through to `wa.me/966593296933`.

---

## 6. Also free, 15 minutes total

- ☐ **Apple Business Connect** — <https://register.apple.com> — same name/address/phone. Feeds Apple Maps and Siri.
- ☐ **Bing Places** — <https://www.bingplaces.com> — one-click import from GBP once GBP is verified.

Keep name, address and phone **byte-identical** everywhere. Inconsistent NAP is the most common reason a local
listing under-ranks.

---

## 7. What Claude already fixed (no action needed)

Committed on branch `feat/discovery`:

- **Listing hero images** were serving the full-size JPEG (~400 KB) to phones with no `srcset`, despite a 15 KB
  WebP existing at a path the code already knew. That image is the LCP element on every listing page.
- **Every meta description was cut mid-word** ("The house is arr") — that fragment is what Google and the AI
  answer engines quote. Now breaks on a word boundary, in Arabic too.
- **Listing titles** said neither what you could do with the home nor which city it is in. Now
  *"Classic Mansion, Al Shati 6 — For Sale in Jeddah | Bona"*, and international listings no longer claim to be
  in Jeddah.
- **A new `/faq/` page** in both languages with `FAQPage` structured data — including whether a non-Saudi may
  buy in Jeddah (the law came into force **22 January 2026**, which makes this a question people are asking
  right now and almost nobody in Jeddah has answered well online). Every answer names its authority — REGA,
  ZATCA, TAQEEM, Ejar, Najiz, Wafi — and refuses to guess where the answer depends on a specific deed.
- **`robots.txt`** now names the answer-engine crawlers explicitly instead of relying on the wildcard.
- **`llms.txt` / `llms-full.txt`** now carry the full FAQ in both languages, so an AI answering
  *"can a foreigner buy property in Jeddah"* has Bona's sourced answer in front of it. Also fixed a line that
  advertised a "future domain" identical to the current one.

**Verified working and needing nothing:** the domain cutover (canonicals, hreflang, 301s from `bona.azoz.uk`
and `www`), the sitemap, and IndexNow.

---

## 8. Still blocked on you

| # | Blocked item | What unblocks it |
|---|---|---|
| 1 | Advertising licence numbers on listing pages | You obtain them (§0.3), then paste them in |
| 2 | Search Console verification | Paste the TXT value (§1.1) |
| 3 | GBP — everything | Only you can verify it (§3) |
| 4 | Bayut account | Your call and card (§4.1) |
| 5 | WhatsApp Channel link in the footer | Paste the invite link (§5.1) |
| 6 | GBP Place ID in the site schema | Paste it after verification (§3.4) |
| 7 | **No GA4** | Another agent owns `site.json`'s analytics fields. Until GA4 exists, nobody can see which pages turn into WhatsApp enquiries — only which pages get impressions. |
