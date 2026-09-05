# Google Business Profile — Bona (Jeddah brokerage) setup checklist

A GBP listing is the strongest local-search asset a brokerage has ("real estate agency near me", "عقارات جدة" map pack, AI Overviews for local queries pull from it). Owner-only: Google requires a real person with a Saudi phone and, usually, a postcard or video verification.

## Before you start (have these ready)
- Business name exactly as on signage/licence: **Bona** (Arabic name field: **بونا**). Do not append "Real Estate Jeddah" — keyword-stuffed names get suspended.
- Address: Al Rawdah District, Jeddah 23432 (use the SPL national address short-code if available; GBP now accepts it). If the office is not customer-facing yet, choose **"I deliver goods and services to my customers"** → hide address → service areas: Jeddah, Makkah Province.
- Phone: +966 59 329 6933 (the WhatsApp line — must be able to receive a call/SMS for verification).
- Website: https://bona.azoz.uk (change to bona.com.sa later — GBP allows edits).
- Category primary: **Real estate agency**. Secondary: *Real estate consultant*, *Property management company* (only if offered), *Real estate rental agency*.
- Licence numbers for the description/attributes: FAL 1100313556 (REGA).
- Photos: logo `public/icon-512.png`, cover `public/og-default.png`, 10+ property/interior photos (JPEG, ≥ 720 px), 1 team photo, 1 exterior of the office.

## Step-by-step
1. business.google.com → **Add business** → name *Bona* → category *Real estate agency*.
2. Location: add address if clients visit; otherwise service-area business (see above). Service areas: **Jeddah**, **Obhur**, **Durrat Al Arous**, **Al Khalidiyah**, **Al Rawdah**, **Al Shati**, **Riyadh** (max 20).
3. Contact: phone + website. Add **WhatsApp** under *Messaging* if offered (Saudi accounts often see the WhatsApp chat button).
4. **Verification**: choose *Video* if offered (fastest — 5 min screen recording showing signage/licence/street) else *Phone/SMS* else *Postcard* (10–14 days to a Saudi address; use the national address).
5. **Hours**: Sunday–Thursday 10:00–19:00; Friday/Saturday closed. Add Ramadan and Eid special hours when announced.
6. **Description** (750 chars max; no URLs, no promo language):
   > Bona is a private luxury real-estate boutique in Jeddah. We represent a curated portfolio of villas, penthouses, waterfront residences and off-market homes across Jeddah, Riyadh and select international destinations, and act for owners who want their home marketed discreetly. REGA-licensed brokerage (FAL 1100313556). Consultations by appointment, in English and Arabic.
   Arabic (add as a second-language edit after the first save):
   > بونا بوتيك عقاري فاخر في جدة. نمثّل محفظة منتقاة من الفلل والبنتهاوس والمساكن الواجهية والعقارات خارج السوق في جدة والرياض ووجهات عالمية مختارة، ونعمل لصالح المُلّاك الذين يفضّلون تسويق منازلهم بخصوصية. وساطة مرخّصة من الهيئة العامة للعقار (رخصة فال 1100313556). الاستشارات بموعد مسبق، بالعربية والإنجليزية.
7. **Attributes**: *Identifies as… (skip)*, *Appointment required: yes*, *Online appointments: yes*, *Language assistance: Arabic, English*.
8. **Services** (add each as a service with a one-line description): Buying representation · Selling & marketing · Luxury rentals · Off-plan advisory · International property · Off-market introductions · Property valuation referrals (to TAQEEM-accredited valuers — Bona does **not** value).
9. **Products** tab: add 6–9 featured listings as "products" (name, photo, price *from* or "Contact for price", link to the listing page). Refresh monthly; remove sold ones.
10. **Photos**: upload logo + cover first (they control how the knowledge panel looks), then interiors. Name files descriptively before uploading (`jeddah-obhur-villa-pool.jpg`).
11. **Q&A**: seed 5 questions yourself (Google allows owner-posted Q&A): licence, viewing process, non-Saudi buyers, fees, areas covered. Short factual answers.
12. **Posts**: publish an *Update* weekly (reuse the content calendar's Sunday post); *Offer* posts are not appropriate for luxury — use *Update* and *Event* (open houses).
13. **Messaging**: turn on; set the welcome message (same text as the Instagram DM auto-reply in `instagram-connect-checklist.md`).
14. **Reviews**: after each completed viewing/transaction, send the short review link (Business Profile → *Ask for reviews*). Reply to every review within 48 h, in the reviewer's language. Target: 10 reviews in the first 90 days — this is the biggest ranking lever.

## Compliance notes (Saudi)
- Do not post asking prices in GBP posts for listings that don't yet have a REGA ad licence number; "price on request" is fine.
- Never post a valuation or "expected to rise" claims (TAQEEM rule) — describe the home, not the market.
- Keep NAP (name, address, phone) byte-identical across GBP, the site footer, Instagram, Apple Business Connect, Bing Places and Aqar/Bayut profiles.

## After verification
- Add the GBP *Place ID* to `src/data/site.json` (e.g. `"googlePlaceId": "ChIJ…"`) → the seo agent can add `hasMap` + a review-link CTA to the Organization schema.
- Connect GBP → **Google Ads** later for Performance Max local assets.
- Also register on **Apple Business Connect** and **Bing Places** (import from GBP) the same day.
