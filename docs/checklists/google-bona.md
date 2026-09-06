# Google for Bona — account, GA4, Search Console, Business Profile, Ads

Everything here is done as **bona.com.sa@gmail.com** (created 2026-09-05). Add
**azoz778@gmail.com** as a manager on each product at the end so nothing depends on one
login. Budget ~45 minutes; the GA4 and Search Console parts feed the tracking stack the
same day, Business Profile takes a few days to verify, Ads waits for the CR.

## 0. Finish the Google account (2 min)

1. https://accounts.google.com → sign in as **bona.com.sa@gmail.com**.
2. The pending prompt is the **recovery phone**: enter **+966 59 329 6933** → type the
   SMS code → Done. Add **azoz778@gmail.com** as recovery email while you are there
   (Security › Recovery email).
3. Turn on 2-Step Verification (Security › 2-Step Verification) with the same phone —
   Google Ads will insist on it later.

## 1. Google Analytics 4 property (8 min)

1. https://analytics.google.com → **Start measuring** (or Admin ⚙ → **Create › Property**).
2. Property name **Bona** · Reporting time zone **Saudi Arabia — (GMT+03:00) Riyadh** ·
   Currency **Saudi Riyal (SAR)** → Next.
3. Business details: Industry **Real Estate**, size **Small** → Business objectives
   **Generate leads** → Create → accept the terms (choose *Saudi Arabia* in the
   country dropdown of the terms dialog).
4. Data collection → **Web** → Website URL **https://bona.azoz.uk** (change to
   **https://bona.sa** at the cutover: Admin › Data streams › the stream › edit URL),
   Stream name **Bona web**, leave *Enhanced measurement* on → **Create stream**.
5. Copy the **Measurement ID** (`G-XXXXXXXXXX`) from the stream details. → goes to
   `src/data/site.json → analytics.ga4` (agent) **and** `GA4_MEASUREMENT_ID` in
   `~/.secrets/bona-marketing.env`.
6. Same stream page → **Measurement Protocol API secrets** → **Create** → nickname
   **bona-api** → copy the **Secret value** → `GA4_API_SECRET` in
   `~/.secrets/bona-marketing.env`. This lets bona-api send `generate_lead` and the
   later stages server-side.
7. Admin › **Data settings › Data retention** → Event data retention **14 months** → Save.
8. Admin › **Data streams › Bona web › Configure tag settings › Define internal traffic**
   (optional): add your home IP so your own visits are excluded.
9. **Key event**: after the first lead, Admin › **Events** → find `generate_lead` →
   toggle **Mark as key event** (or Admin › Key events › **New key event** → type
   `generate_lead`). Do the same for `whatsapp_click` if you want a softer goal; only
   `generate_lead` is later imported into Google Ads.

## 2. Search Console — URL-prefix property for Bona (5 min)

`azoz.uk` is a verified *domain* property in azoz778's account; Bona gets its own
URL-prefix property in the Bona account so reports are Bona-only and survive the domain
move.

1. https://search.google.com/search-console → **Add property** → **URL prefix** →
   `https://bona.azoz.uk/` → Continue.
2. Verification → **HTML tag** → you see
   `<meta name="google-site-verification" content="XYZ…" />` → copy only the
   `content` value → send it to the agent ("GSC tag: XYZ…"). The agent writes it to
   `src/data/site.json → analytics.gscVerification` and deploys (~3 min).
3. Back in Search Console → **Verify**.
4. **Sitemaps** (left menu) → enter `sitemap-index.xml` → Submit (full URL
   `https://bona.azoz.uk/sitemap-index.xml`).
5. **URL inspection** → paste `https://bona.azoz.uk/` → *Request indexing*; repeat for
   `/ar/`, `/properties/`, `/ar/properties/`.
6. After the cutover: add `https://bona.sa/` the same way (the same meta tag is
   rendered on every domain the site is served from) and submit its sitemap; keep the
   old property — the 301s carry the signals over.

## 3. Google Business Profile (10 min + verification wait)

1. https://business.google.com → **Manage now / Add your business**.
2. Business name **Bona Real Estate** (Arabic name later, via *Edit profile › Business
   name › add language*: **بونا العقارية**). Do not stuff keywords into the name.
3. Business category → type *real estate* → pick **Real estate agent** (secondary,
   added later: *Real estate consultant*).
4. "Do you want to add a location customers can visit?" → **No** → service area →
   **Jeddah** (add *Obhur*, *Al Khalidiyah*, *Al Shati*, *Al Rawdah* as extra areas) →
   this is a **service-area business with the address hidden**.
5. Contact: Phone **+966 59 329 6933** · Website **https://bona.azoz.uk**.
6. **Verification** → choose **Video verification** when offered (fastest): record in
   one take, phone in hand — your FAL licence card/certificate (1100313556), the
   street outside, a business document with the name, you at work. Google reviews it in
   1–5 days. Fallback: phone/SMS, then postcard (needs the national address).
7. While it verifies, fill the profile: **Logo** `public/icon-512.png`, **Cover**
   `public/og-default.png`, 10+ photos (JPEG ≥ 720 px, named like
   `jeddah-obhur-villa-pool.jpg`), **Hours** Sunday–Thursday 10:00–19:00, Friday and
   Saturday closed, **Description** (EN + AR texts in `marketing/google-business-profile.md`
   §6), **Attributes** *Appointment required*, *Online appointments*, languages.
8. **Messaging / chat**: turn on *Chat*; under **Contact › Add link → WhatsApp** (where
   offered in KSA) paste `https://wa.me/966593296933`.
9. Services and products: see `marketing/google-business-profile.md` §8–9 (no prices on
   listings without a REGA ad-licence number — "price on request" is fine).
10. After verification, send the agent the **Place ID** (Business Profile settings ›
    Advanced settings › *Place ID*) → `site.json.googlePlaceId` → schema `hasMap`.

## 4. Google Ads (later — needs the CR or your Saudi ID)

1. https://ads.google.com → **New Google Ads account** → *Switch to Expert Mode* →
   *Create an account without a campaign* → Country **Saudi Arabia**, Time zone
   **Riyadh**, Currency **SAR** → Submit.
2. **Billing** → payment profile → *Individual* until the CR exists, then a new
   *Organization* profile in the CR name (a payments profile type cannot be changed).
3. **Advertiser verification** (Tools › Billing › Advertiser verification): individual
   = Saudi national ID that matches the payments profile; organisation = CR extract.
   Ads pause if this is not completed within 30 days of the request.
4. Link GA4: GA4 Admin › **Product links › Google Ads links › Link** → pick the account;
   then Google Ads → Tools › **Conversions › Import › Google Analytics 4 › generate_lead**.
5. First campaign only after the REGA ad licences exist — Google does not check, REGA
   does (`rega-ad-licences.md`).

## 5. Give azoz778@gmail.com access (3 min)

| Product | Where |
|---|---|
| GA4 | Admin › **Property access management** › + › `azoz778@gmail.com` · role **Administrator** |
| Search Console | Settings › **Users and permissions** › Add user › **Owner** |
| Business Profile | Business Profile settings › **People and access** › Add › **Manager** |
| Google Ads | Tools › **Access and security** › + › **Admin** |

## 6. Where each value goes

| Value | Copy from | Goes to |
|---|---|---|
| Measurement ID `G-…` | §1 step 5 | `site.json → analytics.ga4` (agent) and `GA4_MEASUREMENT_ID` in `~/.secrets/bona-marketing.env` |
| MP API secret | §1 step 6 | `GA4_API_SECRET` in `~/.secrets/bona-marketing.env` |
| GSC meta `content` | §2 step 2 | send to the agent → `site.json → analytics.gscVerification` |
| Place ID | §3 step 10 | send to the agent → `site.json.googlePlaceId` |

```bash
nano ~/.secrets/bona-marketing.env && chmod 600 ~/.secrets/bona-marketing.env
node ~/bona/scripts/marketing/verify-integrations.mjs    # ga4 → live means the debug endpoint accepted a test event
systemctl --user restart bona-api
```
