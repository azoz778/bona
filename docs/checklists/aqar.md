# Aqar (sa.aqar.fm) — listing Bona's portfolio with tracked links

Aqar is where Saudi buyers search first (self-reported 1.8 M visits/month, ahead of
Bayut KSA). It carries the REGA ad-licence field natively, so a listing that is legal on
Aqar is legal everywhere. The export script writes one ready-to-paste text per listing;
you paste, Aqar publishes, and the link inside carries the attribution back to the
dashboard.

## 1. Account and plan (10 min)

1. https://sa.aqar.fm → **دخول / تسجيل** with your mobile **+966 59 329 6933** → OTP.
2. Profile → **حسابي › التحقق** → verify with **نفاذ (Nafath)**; then **رخصة فال** →
   enter **1100313556** — Aqar checks it against REGA and shows the *وسيط معتمد* badge.
3. **الاشتراكات (Subscriptions)** → **اشتراك الوسطاء** → **Individual plan
   (فردي) — SAR 2,000 / year, 1 user** (the 5-user plan is SAR 6,000). Pay by card
   or mada. FAQ: https://help.aqar.fm/en/articles/8761341-broker-subscriptions-faqs
4. Profile name **Bona — بونا**, phone the WhatsApp line, city Jeddah, logo
   `public/icon-512.png`. Keep name / phone identical to the site footer and Google
   Business Profile (NAP consistency).

## 2. What every listing needs before it can go up

| Field on Aqar | Value | Where it comes from |
|---|---|---|
| **رقم رخصة الإعلان العقاري** (REGA ad-licence number) | one per listing | issued on the FAL platform — `rega-ad-licences.md`; Aqar validates it live |
| **رقم رخصة فال** | 1100313556 | your individual FAL |
| **المُعلن** (advertiser) | عبدالعزيز زيدان | must match the licence until Bona has its own CR + FAL |
| **رخصة وافي** (off-plan projects) | the developer's Wafi number | in the brochure or from the developer; replaces the ad licence for off-plan |

Aqar will not let you publish a sale/rent listing without a valid ad-licence number
(**رقم الترخيص غير صالح** = the number is wrong or expired). Off-plan units of a
Wafi-licensed project go in with the project licence number in the Wafi field.

## 3. Export the texts (agent or you, 10 s)

```bash
cd ~/bona && node scripts/portal-export.mjs        # → dist/portal/aqar/<id>.txt for every available listing
node scripts/portal-export.mjs --id BONA-W003      # one listing
node scripts/portal-export.mjs --list              # table: id, title, licence status
```

Each file has an **Arabic block** then an **English block**: title, category
(للبيع / للإيجار / على الخارطة), price line (**السعر عند الطلب** when the site shows
price on request; **يبدأ من** for a *from* price), specs (غرف / دورات مياه / م²),
district and city, the **licence line** (ad licence + expiry, or the Wafi number, or
**رخصة الإعلان: قيد الإصدار** when none is recorded yet — do **not** publish that
listing until the number exists), the **advertiser line**
(المُعلن: عبدالعزيز زيدان — رخصة فال 1100313556) and the **tracked link**.

## 4. Post a listing (5 min each)

1. Aqar → **أضف إعلان** → property type (فيلا / شقة / أرض / عمارة), purpose (للبيع /
   للإيجار), city **جدة**, district as in the text.
2. Paste the **Arabic block** into **الوصف**; if the form offers an English description,
   paste the **English block** there, otherwise append it under the Arabic.
3. Fill the structured fields from the same text: السعر (leave the "price on
   request / على السوم" option on when the text says السعر عند الطلب — never type a
   guessed number, TAQEEM), المساحة, غرف النوم, دورات المياه, الواجهة / الشارع if known.
4. **رقم رخصة الإعلان** → the number from the licence line. Off-plan: the Wafi number.
5. Photos: download the listing's photos from the site page (or
   `public/listings/<slug>/01.jpg …` for WhatsApp-intake listings). Hero first. No
   text overlays, no other agency's branding.
6. **Keep the tracked link in the description exactly as exported**:
   `https://bona.azoz.uk/ar/properties/<slug>/?utm_source=aqar&utm_medium=portal&utm_campaign=listing&utm_content=<id>`
   — it is how a visit from Aqar shows up as *aqar / portal* in the dashboard, and how a
   WhatsApp message that starts on our site gets its Ref code.
7. Location pin: use the district only for homes (exact pins are for land plots with a
   published pin).
8. Publish → note the Aqar listing id in the dashboard's lead notes when the first
   enquiry arrives (Aqar calls/WhatsApps that never touch the site are **unattributed**:
   ask "where did you see it?" and set the source by hand on the lead).

## 5. Keep it honest and current

- Re-run the export after every `price` / `sold` / `licence` command; edit the Aqar
  listing the same day. A sold home stays on Aqar = a REGA violation (fake listing).
- The dashboard's **Listings** view flags *no ad licence*, *expiring ≤ 30 days* and
  *expired*; take the Aqar listing down before the expiry date or renew the licence.
- Never add TK's name, TK photos with TK branding, a valuation or "expected to rise"
  language.
- Bayut KSA (Bronze ≈ SAR 6,990/yr) and Property Finder KSA are secondary
  (English/expat audience); the same export text works there with
  `utm_source=bayut` — ask the agent for a second export target when you sign up.
