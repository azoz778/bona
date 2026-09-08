# Google Business Profile — Bona

**Rewritten 2026-09-08.** The website field is now `https://bona-real-estate.com` (the previous version of
this file said `bona.azoz.uk` / `bona.com.sa` — both obsolete). The ten posts in section 8 are written and
ready to paste.

GBP is the highest-intent free channel a local brokerage has. Someone typing *"real estate agency near me"*,
*"عقارات جدة"* or *"luxury villa Jeddah"* on a phone gets the map pack before they get any website, and AI
Overviews for local queries pull from GBP too. It is also the one channel here that **only the owner can
complete** — Google requires a real person with a Saudi phone, and increasingly a video call.

---

## 0. Have these ready before you start

| Field | Value |
|---|---|
| Business name | **Bona** — Arabic name field: **بونا**. Nothing else. |
| Category (primary) | **Real estate agency** |
| Categories (secondary) | Real estate consultant · Real estate rental agency |
| Phone | **+966 59 329 6933** — must be able to receive a call or SMS |
| Website | **https://bona-real-estate.com** |
| Address | Al Rawdah District, Jeddah 23432 |
| Hours | Sunday–Thursday 10:00–19:00; Friday & Saturday closed |
| Licence | REGA FAL **1100313556** |
| Logo file | `public/icon-512.png` |
| Cover file | `public/og-default.png` |

> **Do not** put "Real Estate Jeddah" or any keyword into the name field. Keyword-stuffed names are the most
> common cause of Saudi GBP suspensions, and a suspension costs weeks.

---

## 1. Create the profile

1. <https://business.google.com> → **Add business** → name **Bona** → category **Real estate agency**.
2. **The address question.** If the Al Rawdah office is not a place clients walk into unannounced, answer
   *"I deliver goods and services to my customers"* → **hide the address** → set service areas instead. A
   hidden address is not a downgrade; a staffed-address claim you cannot evidence on a video call is.
3. **Service areas** (max 20 — use them all):
   Jeddah · Al Shati · Al Khalidiyah · Al Rawdah · Al Salamah · Al Nahda · Al Nuzhah · Al Zahra ·
   Al Basateen · Al Murjan · North Obhur · Durrat Al Arous · Durrat Al Basateen · Al Hamra · Obhur ·
   Al Rayyan · Makkah Province · Riyadh
4. Contact: phone + website exactly as in section 0.

---

## 2. Verification — the Saudi reality

**Expect video verification.** For Saudi real-estate categories Google very often skips postcard and phone and
asks for a live or recorded video call. Plan for it rather than being surprised by it:

- You will be asked to show, in one unbroken recording: the **street and building exterior**, then **signage or
  a nameplate**, then **inside the office**, then **evidence you run the business** — the FAL licence document,
  headed paper, a business card, the phone you registered ringing when they call it.
- **Have the FAL certificate printed and to hand.** It is the strongest single artefact for this category.
- Record during working hours, from the actual office. Not from a car, not from home.
- A failure gives you a second attempt; a second failure locks the profile for weeks. Do not attempt it
  unprepared.
- Postcard, where offered, takes 10–14 days — use the SPL national address short code.

---

## 3. Fill the profile out completely, in one sitting

Google ranks complete profiles above incomplete ones.

**Description** (750 char max; no URLs, no promotional language):

> Bona is a private luxury real-estate boutique in Jeddah. We represent a curated portfolio of villas,
> penthouses, waterfront residences and off-market homes across Jeddah, Riyadh and select international
> destinations, and act for owners who want their home marketed discreetly. REGA-licensed brokerage
> (FAL 1100313556). Consultations by appointment, in English and Arabic.

Arabic (add as a second-language edit after the first save):

> بونا بوتيك عقاري فاخر في جدة. نمثّل محفظة منتقاة من الفلل والبنتهاوس والمساكن الواجهية والعقارات خارج
> السوق في جدة والرياض ووجهات عالمية مختارة، ونعمل لصالح المُلّاك الذين يفضّلون تسويق منازلهم بخصوصية.
> وساطة مرخّصة من الهيئة العامة للعقار (رخصة فال 1100313556). الاستشارات بموعد مسبق، بالعربية والإنجليزية.

**Attributes**: Appointment required — yes · Online appointments — yes · Language assistance — Arabic, English.

**Services** (each with a one-line description):
Buying representation · Selling & marketing · Luxury rentals · Off-plan advisory · International property ·
Off-market introductions · Property valuation referrals.

> On that last one the description must read *"referral to a TAQEEM-accredited valuer"*. Bona does **not**
> value property, and implying otherwise on a public profile is a regulatory problem, not a marketing flourish.

**Messaging**: turn it on. Welcome message:

> Thank you for contacting Bona. Send the reference of the home you are interested in and we will reply
> personally, Sunday to Thursday 10:00–19:00.
> شكراً لتواصلك مع بونا. أرسل رقم العقار الذي يهمّك وسنردّ عليك شخصياً، من الأحد إلى الخميس 10:00–19:00.

---

## 4. Photos — upload in this order

The first logo and cover you upload govern how the knowledge panel looks, so order matters.

1. **Logo** — `public/icon-512.png`
2. **Cover** — `public/og-default.png`
3. **Exterior** — the office from the street (doubles as verification evidence)
4. **Interior** — 2–3 of the office
5. **Team** — one of Abdulaziz
6. **Property photos — 10 or more.** Real files already in the repo under `public/listings/`:
   - `public/listings/classic-mansion-al-shati-6/` — best exterior and pool shots
   - `public/listings/private-beach-villa-durrat-al-arous/` — beach frontage, the strongest single image
   - `public/listings/contemporary-villa-al-khalidiyah/`
   - `public/listings/nobal-five-al-rawdah/` — interiors
   - `public/listings/al-zahra-residences/`

   Every image URL in the portfolio is also listed in `public/llms-full.txt` if you want to pull from the CDN.

**Rename each file descriptively before uploading** — `jeddah-al-shati-mansion-pool.jpg`, not `IMG_4821.jpg`.
Google reads filenames. Minimum 720 px, JPEG.

Add 3–5 new photos monthly. Photo freshness is a live ranking input in this category.

---

## 5. Products — put the portfolio inside the profile

The **Products** tab is under-used by Saudi agencies and renders as a carousel in the knowledge panel. Add
6–9 listings: name, photo, price, link.

Prices below are exactly as published on the site on 2026-09-08. **Never round, never estimate.**

| Product name | Price field | Link (prefix `https://bona-real-estate.com`) |
|---|---|---|
| Classic Mansion, Al Shati 6 | SAR 18,000,000 | `/properties/classic-mansion-al-shati-6/` |
| Plot of 1,200 sqm behind the Corniche, Al Shati | SAR 10,200,000 | `/properties/plot-1200-sqm-al-shati/` |
| Private Beach Villa, Durrat Al Arous | SAR 8,000,000 | `/properties/private-beach-villa-durrat-al-arous/` |
| Contemporary Villa, Al Khalidiyah | SAR 6,700,000 | `/properties/contemporary-villa-al-khalidiyah/` |
| Trump Tower Jeddah | From SAR 3,200,000 | `/properties/trump-tower-jeddah/` |
| NOBAL Five, Al Rawdah | SAR 1,800,000 | `/properties/nobal-five-al-rawdah/` |
| Al Zahra Residences | From SAR 1,450,000 | `/properties/al-zahra-residences/` |
| Modern Villa in Al Shati | Contact for price | `/properties/modern-villa-in-al-shati-jeddah/` |

Refresh monthly. **Remove sold homes the week they sell** — a stale price on a public profile is something
both buyers and REGA notice.

---

## 6. Q&A — seed it yourself

Google lets the owner post and answer questions, and an empty Q&A gets filled in by strangers instead. Post
these from a second Google account, then answer from the business account. Short and factual — `/faq/` on the
site is the deep version.

1. *Is Bona licensed?* → Yes, REGA FAL licence 1100313556, verifiable on rega.gov.sa.
2. *Can a non-Saudi buy through you in Jeddah?* → Yes, within the designated zones under the law in force
   since 22 January 2026. Whether a specific property qualifies depends on its deed — send the reference and
   we will check it.
3. *Do you charge for a viewing?* → No. Viewings are by appointment, Sunday–Thursday.
4. *Do you value properties?* → No. Valuation is a TAQEEM-accredited profession; we refer you to an
   accredited valuer.
5. *Which areas do you cover?* → Al Shati, Al Khalidiyah, Al Rawdah, Al Salamah, Al Nahda, Al Nuzhah,
   Al Zahra, Al Basateen, Al Murjan, North Obhur and Durrat Al Arous, plus Riyadh and selected international
   markets.

---

## 7. Reviews — the biggest ranking lever

Ten genuine reviews in the first 90 days will move this profile further than anything else in this document.

- After every completed viewing or transaction, send the short review link (Business Profile → *Ask for
  reviews*) with a one-line personal message. Ask on WhatsApp, not by email.
- **Reply to every review within 48 hours, in the reviewer's language.** Replies are indexed.
- Never offer anything in exchange for a review — against Google's policy, and the second most common
  suspension cause after keyword-stuffed names.

---

## 8. The first ten Posts

One a week for ten weeks. Post type **Update** throughout (*Offer* posts are wrong for luxury; use *Event*
only for an actual open house).

These obey GBP's rules: no URL in the body — the CTA button carries the link; no discount language; no emoji;
front-loaded, because GBP truncates at roughly 150 characters behind a "Read more".

---

### Post 1 — Who Bona is · Week 1
**CTA:** Learn more → `https://bona-real-estate.com/about/` · **Photo:** office exterior, or the cover image

**EN**
> Bona is a private real-estate boutique in Jeddah, working with a deliberately small portfolio: villas,
> penthouses, waterfront homes and land in Al Shati, Al Khalidiyah, Al Rawdah and Durrat Al Arous. Licensed by
> the Real Estate General Authority under FAL 1100313556. Every enquiry is answered by the principal, not
> passed down a call centre.

**AR**
> بونا بوتيك عقاري خاص في جدة، يعمل بمحفظة صغيرة عن قصد: فلل وبنتهاوس ومنازل على الواجهة البحرية وأراضٍ في
> الشاطئ والخالدية والروضة ودرة العروس. مرخّص من الهيئة العامة للعقار برقم فال 1100313556. ويردّ على كل
> استفسار الشريك المسؤول، لا مركز اتصال.

---

### Post 2 — Al Shati · Week 2
**CTA:** Learn more → `https://bona-real-estate.com/properties/for-sale/` · **Photo:** Classic Mansion exterior

**EN**
> Al Shati remains the address most Jeddah buyers ask for first, and the reason is simple: it was built out
> early, the plots are generous, and it sits on the northern waterfront rather than near it. We currently
> represent homes and land there ranging from a 450 square metre plot to a mansion on 2,227 square metres.
> Ask us what is available quietly as well as publicly.

**AR**
> يبقى حي الشاطئ أول عنوان يسأل عنه أغلب مشتري جدة، والسبب بسيط: بُني مبكراً، وقطعه واسعة، وهو على الواجهة
> البحرية الشمالية لا بالقرب منها. ونمثّل فيه اليوم منازل وأراضي تبدأ من قطعة بمساحة 450 متراً مربعاً وتصل
> إلى قصر على 2,227 متراً مربعاً. اسألنا عمّا هو متاح بهدوء كما عمّا هو معروض علناً.

---

### Post 3 — A featured home · Week 3
**CTA:** Learn more → `https://bona-real-estate.com/properties/classic-mansion-al-shati-6/` · **Photo:** the pool shot

**EN**
> A classic mansion in Al Shati 6, on a plot of 2,227.5 square metres, arranged around a garden with a pool.
> Four bedrooms, eight bathrooms, 2,300 square metres built. Asking SAR 18,000,000. Shown by appointment, to
> buyers we have spoken to first.

**AR**
> قصر كلاسيكي في الشاطئ 6، على أرض بمساحة 2,227.5 متراً مربعاً، يلتفّ حول حديقة فيها مسبح. أربع غرف نوم
> وثماني دورات مياه، ومساحة مبنية 2,300 متر مربع. السعر المطلوب 18,000,000 ريال. يُعرض بموعد مسبق، على
> مشترين نتحدث إليهم أولاً.

---

### Post 4 — How a viewing works · Week 4
**CTA:** Call now → `+966 59 329 6933` · **Photo:** an interior (NOBAL Five living space)

**EN**
> How a viewing with Bona works: you send the reference of the home, we confirm it is still available and
> agree a time with the owner, and one of us meets you there — not a junior nobody has briefed. Sunday to
> Thursday, 10:00 to 19:00, by appointment. Some of our sellers ask that their home is shown only to buyers
> whose position we already understand, so we may ask a few questions first.

**AR**
> كيف تتم المعاينة مع بونا: ترسل لنا رقم العقار، فنؤكد أنه ما يزال متاحاً ونتفق مع المالك على موعد، ثم يلقاك
> أحدنا هناك — لا موظف لم يُطلعه أحد على شيء. من الأحد إلى الخميس، 10:00 إلى 19:00، بموعد مسبق. ويشترط بعض
> بائعينا ألّا يُعرض منزلهم إلا على مشترٍ نفهم وضعه سلفاً، ولذلك قد نسأل بضعة أسئلة أولاً.

---

### Post 5 — Selling discreetly · Week 5
**CTA:** Learn more → `https://bona-real-estate.com/sell/` · **Photo:** an elegant interior — this post is aimed at owners

**EN**
> Not every owner wants a sign outside the house. We market homes two ways: openly, or quietly to a shortlist
> of buyers we already know, with no listing, no portal and no sign. Discreet marketing is not a lesser
> service — it is why a number of our sellers came to us. We arrange photography, floor plans, and the
> advertising licence the property needs.

**AR**
> ليس كل مالك يرغب بلوحة أمام منزله. ونسوّق المنازل بطريقتين: علناً، أو بهدوء على قائمة قصيرة من مشترين
> نعرفهم سلفاً، بلا إعلان ولا منصة ولا لوحة. والتسويق المتحفّظ ليس خدمة أقل — بل هو سبب لجوء عدد من بائعينا
> إلينا. ونتولّى نحن التصوير والمخططات واستخراج الترخيص الإعلاني الذي يحتاجه العقار.

---

### Post 6 — Waterfront · Week 6
**CTA:** Learn more → `https://bona-real-estate.com/properties/private-beach-villa-durrat-al-arous/` · **Photo:** beach frontage

**EN**
> A villa at Durrat Al Arous that opens directly onto its own stretch of beach, with a pool facing the water.
> Five bedrooms, eight bathrooms, 537 square metres. Asking SAR 8,000,000. Homes with genuine private beach
> frontage north of Jeddah are a short list, and it does not lengthen often.

**AR**
> فيلا في درة العروس تُطلّ مباشرة على شاطئها الخاص، ومسبحها في مواجهة الماء. خمس غرف نوم وثماني دورات مياه،
> بمساحة 537 متراً مربعاً. السعر المطلوب 8,000,000 ريال. والمنازل ذات الواجهة الشاطئية الخاصة فعلاً شمال جدة
> قائمة قصيرة، ولا تطول كثيراً.

---

### Post 7 — Virtual tours · Week 7
**CTA:** Learn more → `https://bona-real-estate.com/tours/` · **Photo:** a still from the Al Zahra Residences tour

**EN**
> Some of our homes can be walked in 3D before you visit — room by room, on a phone, at whatever hour suits
> you. Al Zahra Residences is the first, and we add tours as we photograph each home. It saves you an
> afternoon on a house that was never going to be right, which is the point.

**AR**
> بعض منازلنا يمكن التجوّل فيها بتقنية ثلاثية الأبعاد قبل زيارتها — غرفةً غرفة، من الهاتف، في أي وقت يناسبك.
> ومساكن الزهراء أولها، ونضيف الجولات تباعاً مع تصوير كل منزل. وهذا يوفّر عليك بعد ظهر يوم في منزل لم يكن
> ليناسبك أصلاً، وهذا هو المقصود.

> **Honesty note:** there is exactly **one** published tour today (Al Zahra Residences), confirmed against
> `llms.txt` on 2026-09-08. The copy says "some" and "the first" deliberately. Do not promise a library of
> tours until there is one — this post sits at week 7 partly to give time to add more.

---

### Post 8 — Buying as a non-Saudi · Week 8
**CTA:** Learn more → `https://bona-real-estate.com/faq/` · **Photo:** Al Khalidiyah contemporary villa exterior

**EN**
> Can a non-Saudi buy in Jeddah? Since 22 January 2026, yes — within the geographic zones designated under the
> Law of Real Estate Ownership by Non-Saudis, and Jeddah is one of the cities covered. Whether one particular
> home qualifies depends on where its deed sits on the official REGA zone map, so the honest answer for any
> specific property is that we will check it for you before you spend an afternoon on it.

**AR**
> هل يستطيع غير السعودي الشراء في جدة؟ منذ 22 يناير 2026، نعم — ضمن النطاقات الجغرافية المحددة بموجب نظام
> تملّك غير السعوديين للعقار، وجدة من المدن التي يشملها. أما إن كان منزل بعينه مؤهلاً فيتوقف على موقع صكّه من
> خريطة النطاقات الرسمية لدى الهيئة العامة للعقار، ولذلك فالإجابة الصادقة عن أي عقار محدد هي أننا نتحقق منه
> لك قبل أن تصرف فيه بعد ظهر يوم.

> **Never** state a blanket yes or no on an individual case, and never name a zone from memory. REGA's
> Saudi Properties portal (`saudiproperties.rega.gov.sa`) is the only authority.

---

### Post 9 — Off-plan and branded residences · Week 9
**CTA:** Learn more → `https://bona-real-estate.com/properties/off-plan/` · **Photo:** a Trump Tower Jeddah render

**EN**
> Buying off-plan in Saudi Arabia comes with a protection worth knowing about: under the Wafi programme, a
> licensed project must take buyer payments into a supervised escrow account tied to construction progress,
> rather than straight to the developer. So the first question about any off-plan home is whether the project
> holds a Wafi licence. We show you that licence for every off-plan project we represent.

**AR**
> للشراء على الخارطة في المملكة حماية تستحق المعرفة: فبموجب برنامج وافي، يجب أن تُودَع دفعات المشتري في
> المشروع المرخّص في حساب ضمان خاضع للإشراف ومرتبط بنسب الإنجاز، لا أن تذهب إلى المطوّر مباشرة. ولذلك فالسؤال
> الأول عن أي وحدة على الخارطة هو: هل يحمل المشروع ترخيص وافي؟ ونحن نُطلعك على ذلك الترخيص لكل مشروع على
> الخارطة نمثّله.

---

### Post 10 — Land and plots · Week 10
**CTA:** Learn more → `https://bona-real-estate.com/properties/land/` · **Photo:** aerial/satellite still of an Al Shati plot

**EN**
> We currently represent eight residential plots in Jeddah — in Al Shati, Al Khalidiyah and Durrat Al
> Basateen — from 300 to 1,200 square metres, with the asking price published on each. Land is the part of the
> market where the difference between a good plot and the one next to it is orientation, access and zoning,
> none of which shows in a photograph. Ask us before you commit.

**AR**
> نمثّل حالياً ثماني قطع سكنية في جدة — في الشاطئ والخالدية ودرة البساتين — تتراوح بين 300 و1,200 متر مربع،
> وسعرها المطلوب منشور مع كل قطعة. والأراضي هي الجزء من السوق الذي يكون فيه الفرق بين قطعة جيدة وأخرى ملاصقة
> لها في الاتجاه والمدخل والتنظيم، ولا يظهر أيٌّ من ذلك في صورة. اسألنا قبل أن تلتزم.

---

## 9. Compliance notes (Saudi)

- Every property advertisement in Saudi Arabia needs its own **advertising licence number** tied to the deed
  and to the broker. Do not post a specific property with a price to GBP until that property has one.
  "Price on request" is always safe.
- **Never post a valuation, a market forecast, or "prices are rising" language.** Describe the home, not the
  market. Valuation is TAQEEM's regulated territory.
- Keep name, address and phone byte-identical across GBP, the site footer, Instagram, Apple Business Connect,
  Bing Places and any portal profile.

---

## 10. After verification

- [ ] Get the **Place ID** (<https://developers.google.com/maps/documentation/places/web-service/place-id>) and
      paste it into the chat — it can then go into `src/data/site.json` as `googlePlaceId`, letting the
      Organization schema carry `hasMap` and a review-link CTA.
- [ ] Register **Apple Business Connect** (<https://register.apple.com>) — same NAP, feeds Apple Maps and Siri.
- [ ] Register **Bing Places** (<https://www.bingplaces.com>) — one-click import from GBP.
- [ ] Consider linking GBP → Google Ads later, if Performance Max local campaigns are ever wanted.
