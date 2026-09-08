# WhatsApp Channel (قناة واتساب) — setup and the first ten broadcasts

**Written 2026-09-08.** Listings and prices below were taken from `https://bona-real-estate.com/llms.txt` on
that date. Re-check before posting anything with a number in it.

## Why this channel and not another feed

A WhatsApp Channel is a one-way broadcast inside the app Saudi buyers already have open. It is free, it needs
no ad budget, it does not depend on an algorithm deciding to show you, and in Saudi it reaches an audience
that will never open Instagram for property. For a brokerage whose entire enquiry funnel already ends in
WhatsApp, it is the shortest possible distance between "saw the home" and "asked about the home".

**What it is not — read this before you set expectations:**

- **You cannot see who follows you.** Follower phone numbers are hidden from the admin and from each other.
  A Channel is a broadcast surface, **not a lead list**. You will never be able to export it or message a
  follower directly from it.
- **Followers cannot reply**, only react with an emoji. Every conversation still has to start with them
  tapping through to `wa.me/966593296933`.
- Following a channel is public-ish to the follower's own contacts in some views, which for a *luxury* audience
  is a reason some people will not follow. That is fine. This channel is a top-of-funnel surface, not the
  discreet one — discretion lives in the one-to-one chat.

---

## 1. Setup (owner, 10 minutes, on the phone)

1. Open WhatsApp on the phone holding **+966 59 329 6933** → **Updates** tab → **＋** → **New channel**.
2. **Name:** `Bona | بونا`
   (Both scripts in one name — this is the only field followers see in a list, and the audience is bilingual.)
3. **Profile photo:** `public/icon-512.png` from the repo. Send it to yourself first so it is in the camera
   roll at full resolution; do not screenshot it.
4. **Description** — paste both languages, Arabic first:

   > عقارات فاخرة في جدة — فلل وبنتهاوس ومنازل على الواجهة البحرية وأراضٍ، تُعرض بموعد مسبق.
   > وساطة مرخّصة من الهيئة العامة للعقار، رخصة فال 1100313556. للاستفسار: wa.me/966593296933
   >
   > Private luxury real estate in Jeddah — villas, penthouses, waterfront homes and land, shown by
   > appointment. REGA-licensed, FAL 1100313556. Enquiries: wa.me/966593296933

5. **Create.** Then open the channel → name → **Copy link**. It looks like
   `https://whatsapp.com/channel/XXXXXXXXXXXXXXXXXX`.
6. **Paste that link into the chat** so it can be added to the site footer, and put it in these places
   yourself the same day:
   - Instagram bio and the Instagram link-in-bio block
   - Google Business Profile → website field stays the site; put the channel in a **Post** instead
   - Email signature
   - The WhatsApp auto-reply / welcome message
   - `src/data/site.json` — hand the link over and it can be wired into the footer properly

### Cadence

**Two to three a week. Never daily.** A luxury brokerage that posts every day reads like a listings spammer,
and on WhatsApp the cost of over-posting is a mute or an unfollow, not just a scroll-past. Tuesday and
Saturday mornings (Saudi time) are a sensible rhythm; add a third only when there is a genuinely new home.

### Format rule

Channels have no per-follower language setting, so every post goes out to Arabic and English readers at once.
**Post Arabic first, then one short English line beneath it**, exactly as laid out below. Keep the whole thing
to two to four lines — a broadcast that has to be scrolled is one nobody reads.

---

## 2. The first ten broadcasts

### 1 — Launch / welcome
**Media:** the cover image `public/og-default.png` · **Link:** `https://bona-real-estate.com/`

> قناة بونا للعقارات الفاخرة في جدة.
> فلل، وبنتهاوس، ومنازل على الواجهة البحرية، وأراضٍ — تُعرض بموعد مسبق.
> وساطة مرخّصة، فال 1100313556.
>
> Bona — private luxury real estate in Jeddah. New homes here first.
> bona-real-estate.com

---

### 2 — A featured home
**Media:** pool photo from the Classic Mansion listing · **Link:** `/properties/classic-mansion-al-shati-6/`

> قصر كلاسيكي في الشاطئ 6، على أرض 2,227.5 م².
> 4 غرف نوم، 8 دورات مياه، ومساحة مبنية 2,300 م².
> السعر المطلوب 18,000,000 ريال. المعاينة بموعد.
>
> Classic Mansion, Al Shati 6 — SAR 18,000,000. By appointment.

---

### 3 — District spotlight: Al Shati
**Media:** a wide exterior or waterfront shot · **Link:** `/properties/for-sale/`

> لماذا يسأل أغلب المشترين عن الشاطئ أولاً؟
> بُني مبكراً، وقطعه واسعة، وهو على الواجهة البحرية لا بالقرب منها.
> لدينا فيه اليوم منازل وأراضٍ من 450 م² إلى 2,227 م².
>
> Al Shati — homes and land, 450 to 2,227 sqm.

---

### 4 — The 3D tour
**Media:** a still from the Al Zahra tour · **Link:** `/properties/al-zahra-residences/`

> تجوّل في مساكن الزهراء ثلاثية الأبعاد قبل أن تزورها — غرفةً غرفة، من هاتفك.
> 3 غرف نوم، 200 م². تبدأ من 1,450,000 ريال.
>
> Al Zahra Residences — walk it in 3D before you visit. From SAR 1,450,000.

---

### 5 — Just listed: waterfront
**Media:** the beach frontage photo · **Link:** `/properties/private-beach-villa-durrat-al-arous/`

> فيلا في درة العروس تُطلّ مباشرة على شاطئها الخاص، ومسبحها في مواجهة الماء.
> 5 غرف نوم، 8 دورات مياه، 537 م².
> السعر المطلوب 8,000,000 ريال.
>
> Private beach villa, Durrat Al Arous — SAR 8,000,000.

---

### 6 — The quiet list (off-market)
**Media:** none — text only, deliberately · **Link:** `https://wa.me/966593296933`

> ليس كل ما نمثّله معروضاً هنا.
> بعض المُلّاك يفضّلون ألّا يُعلن منزلهم، فيُعرض على قائمة قصيرة فقط.
> إن كنت تبحث عن شيء بعينه، أرسل لنا ما تبحث عنه.
>
> Not everything we represent is listed publicly. Tell us what you are looking for.

---

### 7 — Preparing a home for sale
**Media:** an elegant interior · **Link:** `/sell/`

> ثلاثة أشياء تُحدث فرقاً حقيقياً قبل تصوير المنزل: إضاءة طبيعية بلا ستائر ثقيلة،
> ومساحات خالية من الأثاث الزائد، ومسبح وحديقة في حالتهما.
> التصوير والمخططات والترخيص الإعلاني نتولّاها نحن.
>
> Selling? We handle photography, floor plans and the advertising licence.

---

### 8 — Land
**Media:** aerial/satellite still of an Al Shati plot · **Link:** `/properties/land/`

> ثماني قطع سكنية في جدة — الشاطئ، والخالدية، ودرة البساتين.
> من 300 م² إلى 1,200 م²، وأسعارها المطلوبة منشورة مع كل قطعة.
> الفرق بين قطعة وأخرى ملاصقة لها في الاتجاه والمدخل والتنظيم، ولا يظهر في صورة.
>
> Eight residential plots in Jeddah, 300 to 1,200 sqm.

---

### 9 — Off-plan and Wafi
**Media:** a Trump Tower Jeddah render · **Link:** `/properties/off-plan/`

> قبل الشراء على الخارطة، اسأل سؤالاً واحداً: هل المشروع مرخّص من وافي؟
> الترخيص يعني أن دفعاتك تذهب إلى حساب ضمان مرتبط بنسب الإنجاز، لا إلى المطوّر مباشرة.
> ونُطلعك على الترخيص لكل مشروع نمثّله.
>
> Off-plan: always ask for the Wafi licence. We show you ours.

---

### 10 — Book a viewing this week
**Media:** the strongest exterior in the portfolio · **Link:** `https://wa.me/966593296933`

> المعاينات هذا الأسبوع من الأحد إلى الخميس، 10:00 – 19:00.
> أرسل رقم العقار الذي يهمّك ونؤكد لك موعداً.
>
> Viewings Sunday to Thursday, 10:00–19:00. Send us the reference.

---

## 3. Rules for everything posted here

- **Never invent or round a price.** Every number above came from `llms.txt` on 2026-09-08. If a home has no
  published price, write *السعر عند الطلب* / *Price on request*.
- **Never post a valuation or a market prediction.** No "prices are rising", no "good investment", no
  estimates. That is TAQEEM's regulated territory and it is the fastest way to a complaint.
- **Do not post a specific property with a price** until that property has its REGA advertising licence number.
- No exclamation marks, no "amazing", no emoji strings. The tone that sells an SAR 18m mansion is the tone of
  someone who does not need to sell it.
- When a home sells, post nothing triumphant. Quietly stop featuring it.
