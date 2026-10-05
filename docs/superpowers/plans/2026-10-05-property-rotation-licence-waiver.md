# Daily Property Rotation Under the Owner's Ad-Licence Waiver — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resume daily Instagram and Facebook posts at 20:30 Riyadh from reviewed Saudi ready and off-plan listings, under the owner's recorded ad-licence waiver, with a Telegram alert when a day is missed.

**Architecture:** The existing daily publisher (`scripts/social/daily-publish.mjs` → `property-publish.mjs`) keeps its locks, ledgers and live re-checks. Eligibility becomes policy-driven (`policyRules()` reads `property-policy.json`), captions gain an always-on advertiser line, a render note and generated hashtags, two CLIs draft and approve per-listing photo reviews into `property-reviews.json`, and a small heartbeat module pushes to Uptime Kuma.

**Tech Stack:** Node 24 ES modules, `node:test`, `sharp`, Instagram/Facebook Graph API (unchanged), Uptime Kuma push monitors.

**Spec:** `docs/superpowers/specs/2026-10-05-property-rotation-licence-waiver-design.md`

---

## Ground rules (every task)

- Lane A works in `~/bona-wt/property-waiver` (branch `feat/property-rotation-waiver-20261005`). Lane B (Task 5 only) works in `~/bona-wt/property-waiver-hb` (branch `feat/property-heartbeat-20261005`, same base). The controller merges lane B into lane A.
- Use Node 24: `export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH`.
- Tests: whole suite `npm test`; one file `node --test scripts/test/<file>.test.mjs`. The suite was 160/160 green at the start.
- Commit after each task with `git add <explicit paths>` only (never `-A` or `.`), message as given, ending with the trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never push, never touch `~/bona`, `~/bona-publish`, `~/bona-data`, systemd units, `~/.secrets`, or any network write.
- Match the surrounding style. `property-daily.mjs` and its tests are compact ES modules with single quotes; `daily-publish.mjs` uses double quotes.
- If plan code turns out wrong, make the smallest fix that satisfies the stated behaviour and report it as a concern.

## File map

| File | Change | Responsibility |
|---|---|---|
| `scripts/social/lib/property-daily.mjs` | modify | policy rules, eligibility, caption, hashtags, rotation, attempt settlement |
| `scripts/social/property-publish.mjs` | modify | pass policy rules through; settlement check |
| `marketing/daily/property-policy.json` | modify | the owner's waiver and scope |
| `scripts/test/property-daily.test.mjs` | modify | tests for all of the above |
| `scripts/social/lib/heartbeat.mjs` | create | route decision and Kuma push |
| `scripts/social/daily-publish.mjs` | modify | fall through to the pack; heartbeats |
| `scripts/test/heartbeat.test.mjs` | create | heartbeat and routing tests |
| `scripts/social/lib/property-review.mjs` | create | frame rules, disclosures, selection parsing, review building, catalogue read, contact sheet |
| `scripts/social/draft-property-reviews.mjs` | create | CLI: draft frames, sheets, drafts.json |
| `scripts/social/approve-property-review.mjs` | create | CLI: write approved reviews into the register |
| `scripts/test/property-review.test.mjs` | create | review tooling tests |
| `docs/daily-property-publishing.md` | rewrite | operator documentation |
| `marketing/daily/README.md` | modify | pack is now the fallback; monitoring pointer |
| `scripts/test/daily-property-doc.test.mjs` | create | the doc's reconciliation lines and verification command, held to the journal readers |

---

### Task 1: Policy rules

**Files:**
- Modify: `scripts/social/lib/property-daily.mjs` (insert after the `fresh()` function, before `export function eligibility`)
- Test: `scripts/test/property-daily.test.mjs`

- [ ] **Step 1: Write the failing tests**

Replace line 6 of `scripts/test/property-daily.test.mjs` (the import from `../social/lib/property-daily.mjs`) with:

```js
import { publicListing,sha256,fingerprint,advertiserFingerprint,eligibility,propertyCaption,chooseProperty,dayState,realDate,policyRules,STRICT_RULES } from '../social/lib/property-daily.mjs';
```

Append to the end of the file:

```js
test('policy rules: no new fields means the strict 2 October behaviour', () => {
  assert.deepEqual({ ...policyRules({}, now) }, { ...STRICT_RULES });
  assert.equal(policyRules({}, now).licenceRequired, true);
});
test('policy rules: an owner waiver with a past or current date lifts the licence requirement', () => {
  const r = policyRules({ adLicence: { requirement: 'waived', by: 'owner', on: '2026-10-02' }, countries: ['SA'], categories: ['buy','rent','off-plan'], renders: 'off-plan-only', reviewValidDays: 90 }, now);
  assert.equal(r.licenceRequired, false);
  assert.deepEqual([...r.categories], ['buy','rent','off-plan']);
  assert.equal(r.renders, 'off-plan-only');
  assert.equal(r.reviewValidDays, 90);
});
test('policy rules: a malformed waiver or scope stops the run', () => {
  const bad = [
    { adLicence: { requirement: 'waived', on: '2026-10-02' } },
    { adLicence: { requirement: 'waived', by: ' ', on: '2026-10-02' } },
    { adLicence: { requirement: 'waived', by: 'owner', on: '2026-10-03' } },
    { adLicence: { requirement: 'waived', by: 'owner', on: '2026-02-31' } },
    { adLicence: { requirement: 'sometimes' } },
    { countries: ['sa'] }, { countries: [] },
    { categories: ['buy','auction'] }, { categories: [] },
    { renders: 'all' },
    { reviewValidDays: 0 }, { reviewValidDays: 181 }, { reviewValidDays: 1.5 },
  ];
  for (const policy of bad) assert.throws(() => policyRules(policy, now), /property policy|waiver/, JSON.stringify(policy));
});
```

(`now` in this file is 2026-10-02 20:30 Riyadh, so a waiver dated 2026-10-03 is in the future.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/test/property-daily.test.mjs`
Expected: FAIL — `SyntaxError: The requested module '../social/lib/property-daily.mjs' does not provide an export named 'STRICT_RULES'`.

- [ ] **Step 3: Implement**

Insert after the `fresh()` function in `scripts/social/lib/property-daily.mjs`:

```js
const CATEGORIES = ['buy', 'rent', 'off-plan'];
/** What a policy without the 2026-10-05 fields means: licensed Saudi sale/rent stock, real photographs, 30-day reviews. */
export const STRICT_RULES = Object.freeze({ licenceRequired: true, countries: Object.freeze(['SA']), categories: Object.freeze(['buy', 'rent']), renders: 'none', reviewValidDays: 30 });
/** property-policy.json → eligibility rules. Anything unreadable throws: no run proceeds on a policy it cannot read. */
export function policyRules(policy = {}, now = new Date()) {
  const licence = policy.adLicence ?? { requirement: 'required' };
  if (!['required', 'waived'].includes(licence.requirement)) throw new Error('Invalid ad-licence requirement in the property policy');
  if (licence.requirement === 'waived' && (typeof licence.by !== 'string' || !licence.by.trim() || !realDate(licence.on) || licence.on > ksaNow(now).date))
    throw new Error('An ad-licence waiver must name who waived it and a date that is not in the future');
  const countries = policy.countries ?? STRICT_RULES.countries;
  if (!Array.isArray(countries) || !countries.length || countries.some(c => !/^[A-Z]{2}$/.test(c))) throw new Error('Invalid countries in the property policy');
  const categories = policy.categories ?? STRICT_RULES.categories;
  if (!Array.isArray(categories) || !categories.length || categories.some(c => !CATEGORIES.includes(c))) throw new Error('Invalid categories in the property policy');
  const renders = policy.renders ?? STRICT_RULES.renders;
  if (!['none', 'off-plan-only'].includes(renders)) throw new Error('Invalid renders rule in the property policy');
  const reviewValidDays = policy.reviewValidDays ?? STRICT_RULES.reviewValidDays;
  if (!Number.isInteger(reviewValidDays) || reviewValidDays < 1 || reviewValidDays > 180) throw new Error('Invalid reviewValidDays in the property policy');
  return Object.freeze({ licenceRequired: licence.requirement === 'required', countries: Object.freeze([...countries]), categories: Object.freeze([...categories]), renders, reviewValidDays });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/test/property-daily.test.mjs` — Expected: all PASS. Then `npm test` — Expected: all PASS (163).

- [ ] **Step 5: Commit**

```bash
git add scripts/social/lib/property-daily.mjs scripts/test/property-daily.test.mjs
git commit -m "property-daily: policyRules() reads the ad-licence waiver and scope from the policy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Caption, render note, hashtags

**Files:**
- Modify: `scripts/social/lib/property-daily.mjs` (replace `propertyCaption`, add `renderShare`, `captionFor`, `propertyHashtags`, change `entryFor`)
- Test: `scripts/test/property-daily.test.mjs`

- [ ] **Step 1: Write the failing tests**

Replace the import line (line 6) with:

```js
import { publicListing,sha256,fingerprint,advertiserFingerprint,eligibility,propertyCaption,chooseProperty,dayState,realDate,policyRules,STRICT_RULES,renderShare,captionFor,propertyHashtags,entryFor } from '../social/lib/property-daily.mjs';
```

Insert directly after the `fixture()` function (before the first `test(`):

```js
function offPlanFixture() {
  const { advertiser } = fixture();
  const listing = { id: 'BONA-OP', slug: 'tower', status: 'available', category: 'off-plan', type: 'apartment',
    location: { countryCode: 'SA', district: { ar: 'الشاطئ، الكورنيش', en: 'Al Shati, Corniche' }, city: { ar: 'جدة', en: 'Jeddah' } },
    title: { ar: 'برج تجريبي', en: 'Fixture Tower' }, price: { amount: 3200000, currency: 'SAR', from: true }, specs: {},
    images: [1,2,3].map(i => ({ src: `/listings/tower/${i}.jpg` })), licence: null };
  return { listing, advertiser };
}
```

Append to the end of the file:

```js
test('caption: advertiser line always, licence line only with a number, renders disclosed', () => {
  const { listing: p, advertiser: a } = fixture();
  const d = { ar: 'إفصاح.', en: 'Disclosure.' };
  const licensed = propertyCaption(p, a, d);
  assert.match(licensed.ar, /المعلن: المعلن التجريبي · فال 1100000000 · \+966500000000/);
  assert.match(licensed.en, /Advertiser: Fixture advertiser · FAL 1100000000 · \+966500000000/);
  assert.match(licensed.ar, /ترخيص الإعلان: 7200000000 · ينتهي 2026-12-31/);
  assert.match(licensed.en, /Ad licence 7200000000 · Expires 2026-12-31/);
  const bare = propertyCaption({ ...p, licence: null }, a, d);
  assert.doesNotMatch(bare.ar, /ترخيص الإعلان/);
  assert.doesNotMatch(bare.en, /Ad licence/);
  assert.match(bare.ar, /المعلن: /);
  assert.match(bare.en, /Advertiser: /);
  assert.doesNotMatch(bare.en, /artist's impressions/);
  assert.match(propertyCaption(p, a, d, { renders: 'all' }).en, /^Images are the developer's artist's impressions\.$/m);
  assert.match(propertyCaption(p, a, d, { renders: 'all' }).ar, /^الصور تصاميم تصوّرية من المطوّر\.$/m);
  assert.match(propertyCaption(p, a, d, { renders: 'some' }).en, /^Some images are the developer's artist's impressions\.$/m);
  assert.match(propertyCaption(p, a, d, { renders: 'some' }).ar, /^بعض الصور تصاميم تصوّرية من المطوّر\.$/m);
});
test('caption: place and deal line, off-plan wording and the from-price exactly as the site shows it', () => {
  const { listing: p, advertiser: a } = offPlanFixture();
  const c = propertyCaption(p, a, {});
  assert.equal(c.ar.split('\n')[0], 'برج تجريبي');
  assert.equal(c.ar.split('\n')[1], 'الشاطئ، الكورنيش، جدة · على الخارطة');
  assert.equal(c.en.split('\n')[0], 'Fixture Tower');
  assert.equal(c.en.split('\n')[1], 'Al Shati, Corniche, Jeddah · Off-plan');
  assert.match(c.ar, /تبدأ الأسعار من 3,200,000 ريال/);
  assert.match(c.en, /From SAR 3,200,000/);
  assert.match(c.ar, /راسل بونا بالرقم BONA-OP/);
  assert.match(c.ar, /https:\/\/bona-real-estate\.com\/properties\/tower\//);
  const ready = propertyCaption(fixture().listing, a, {});
  assert.match(ready.ar.split('\n')[1], /· للبيع$/);
  assert.match(ready.en.split('\n')[1], /· For sale$/);
});
test('renderShare and captionFor follow the reviewed photo kinds', () => {
  const { listing: p, advertiser: a, review: r } = fixture();
  assert.equal(renderShare(r), 'none');
  assert.equal(renderShare({ photos: r.photos.map(x => ({ ...x, kind: 'render' })) }), 'all');
  assert.equal(renderShare({ photos: r.photos.map((x, i) => ({ ...x, kind: i ? 'render' : 'photograph' })) }), 'some');
  assert.equal(renderShare(undefined), 'none');
  assert.deepEqual(captionFor(p, a, r), propertyCaption(p, a, r.legalDisclosures, { renders: 'none' }));
});
test('hashtags: brand, city, type, off-plan, district and luxury, at most twelve, valid characters only', () => {
  const { listing: p } = offPlanFixture();
  assert.deepEqual(propertyHashtags(p), ['#بونا','#BonaRealEstate','#عقارات_جدة','#JeddahRealEstate','#شقق_جدة','#شقق_للبيع','#JeddahApartments','#مشاريع_على_الخارطة','#OffPlan','#الشاطئ','#AlShati','#عقارات_فاخرة']);
  const villa = { ...p, category: 'buy', type: 'villa', location: { ...p.location, district: { ar: 'درة العروس', en: 'Durrat Al Arous' } } };
  assert.deepEqual(propertyHashtags(villa), ['#بونا','#BonaRealEstate','#عقارات_جدة','#JeddahRealEstate','#فلل_جدة','#فلل_للبيع','#JeddahVillas','#درة_العروس','#DurratAlArous','#عقارات_فاخرة']);
  const riyadh = { ...villa, location: { countryCode: 'SA', city: { ar: 'الرياض', en: 'Riyadh' }, district: { ar: 'شمال الرياض الجديد الكبير', en: 'North Riyadh New Big Area' } } };
  const tags = propertyHashtags(riyadh);
  assert.ok(tags.includes('#عقارات_الرياض') && tags.includes('#RiyadhVillas'));
  assert.ok(!tags.some(t => /جدة|Jeddah/.test(t)));
  assert.ok(!tags.includes('#شمال_الرياض_الجديد_الكبير'), 'districts longer than three words are left out');
  for (const t of [...propertyHashtags(p), ...tags]) assert.match(t, /^#[\p{L}\p{N}_]+$/u);
  assert.ok(propertyHashtags(p).length <= 12);
});
test('entryFor carries the reviewed caption and the generated hashtags', () => {
  const { listing: p, advertiser: a, review: r } = fixture();
  const e = entryFor(p, r, a, 'instagram', '2026-10-05', []);
  assert.equal(e.id, 'bona-daily-ig-2026-10-05');
  assert.deepEqual(e.caption, captionFor(p, a, r));
  assert.deepEqual(e.hashtags, propertyHashtags(p));
  assert.deepEqual(e.images, r.photos.map(x => x.url));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/test/property-daily.test.mjs`
Expected: FAIL — `does not provide an export named 'renderShare'`.

- [ ] **Step 3: Implement**

In `scripts/social/lib/property-daily.mjs`, replace the whole `export function propertyCaption(...) { ... }` block with:

```js
/** 'none' | 'some' | 'all' — how many reviewed photographs are developer renders. */
export function renderShare(review) {
  const kinds = (review?.photos ?? []).map(x => x.kind);
  const renders = kinds.filter(k => k === 'render').length;
  return renders === 0 ? 'none' : renders === kinds.length ? 'all' : 'some';
}
const RENDER_NOTE = Object.freeze({
  all: { ar: 'الصور تصاميم تصوّرية من المطوّر.', en: "Images are the developer's artist's impressions." },
  some: { ar: 'بعض الصور تصاميم تصوّرية من المطوّر.', en: "Some images are the developer's artist's impressions." },
});
export function propertyCaption(p, advertiser, disclosures = {}, { renders = 'none' } = {}) {
  const n = x => Number(x).toLocaleString('en-US');
  const ar = [], en = [];
  if (p.specs?.beds) { ar.push(`${n(p.specs.beds)} غرف نوم`); en.push(`${n(p.specs.beds)} bedrooms`); }
  if (p.specs?.plotSqm) { ar.push(`مساحة الأرض ${n(p.specs.plotSqm)} م²`); en.push(`${n(p.specs.plotSqm)} m² plot`); }
  else if (p.specs?.areaSqm) { ar.push(`المساحة ${n(p.specs.areaSqm)} م²`); en.push(`${n(p.specs.areaSqm)} m²`); }
  if (p.price?.amount && p.price?.currency === 'SAR' && !p.price?.onRequest) {
    ar.push(`${p.price.from ? 'تبدأ الأسعار من ' : ''}${n(p.price.amount)} ريال${p.category === 'rent' ? ' — '+(p.price.period ?? 'مدة الإيجار عند الاستفسار') : ''}`);
    en.push(`${p.price.from ? 'From ' : ''}SAR ${n(p.price.amount)}${p.category === 'rent' ? ' / '+(p.price.period ?? 'enquire for rental period') : ''}`);
  }
  const url = `${SITE}/properties/${encodeURIComponent(p.slug)}/`;
  const deal = p.category === 'rent' ? { ar: 'للإيجار', en: 'For rent' } : p.category === 'off-plan' ? { ar: 'على الخارطة', en: 'Off-plan' } : { ar: 'للبيع', en: 'For sale' };
  const place = l => [p.location?.district?.[l], p.location?.city?.[l]].filter(Boolean).join(l === 'ar' ? '، ' : ', ');
  const lines = (...xs) => xs.filter(Boolean).join('\n');
  const blocks = (...xs) => xs.filter(Boolean).join('\n\n');
  const note = RENDER_NOTE[renders] ?? {};
  const licence = p.licence?.adNumber
    ? { ar: `ترخيص الإعلان: ${p.licence.adNumber} · ينتهي ${p.licence.adExpiry}`, en: `Ad licence ${p.licence.adNumber} · Expires ${p.licence.adExpiry}` }
    : {};
  return {
    ar: blocks(
      lines(p.title.ar, [place('ar'), deal.ar].filter(Boolean).join(' · ')),
      ar.join(' · '),
      lines(`تبحث عن منزل بهذه المواصفات؟ راسل بونا بالرقم ${p.id} لمعرفة التوفر وترتيب معاينة.`, url),
      lines(disclosures.ar, `المعلن: ${advertiser.name.ar} · فال ${advertiser.fal} · ${advertiser.phone}`, licence.ar, note.ar)),
    en: blocks(
      lines(p.title.en, [place('en'), deal.en].filter(Boolean).join(' · ')),
      en.join(' · '),
      `Interested? Message Bona with ${p.id} for current availability and a viewing.`,
      lines(disclosures.en, `Advertiser: ${advertiser.name.en} · FAL ${advertiser.fal} · ${advertiser.phone}`, licence.en, note.en)),
  };
}
/** The caption a review binds: its disclosures and whether its photographs are renders. */
export const captionFor = (p, advertiser, review) => propertyCaption(p, advertiser, review?.legalDisclosures ?? {}, { renders: renderShare(review) });

const TYPE_WORDS = Object.freeze({
  villa: { ar: 'فلل', en: 'Villas' }, mansion: { ar: 'قصور', en: 'Mansions' },
  apartment: { ar: 'شقق', en: 'Apartments' }, penthouse: { ar: 'بنتهاوس', en: 'Penthouses' },
  duplex: { ar: 'دوبلكس', en: 'Duplexes' }, townhouse: { ar: 'تاون_هاوس', en: 'Townhouses' },
  land: { ar: 'أراضي', en: 'Land' },
});
const firstPart = s => String(s ?? '').split(/[،,]/)[0].trim();
const wordCount = s => firstPart(s).split(/\s+/).filter(Boolean).length;
const arTag = s => firstPart(s).replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_]/gu, '');
const enTag = s => firstPart(s).split(/[\s-]+/).map(w => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('');
/** Deterministic hashtags from listing facts (bound by the review's factsSha256): at most twelve. */
export function propertyHashtags(p) {
  const city = p.location?.city ?? {}, district = p.location?.district ?? {};
  const cityAr = arTag(city.ar), cityEn = enTag(city.en), word = TYPE_WORDS[p.type];
  const deal = p.category === 'rent' ? 'للإيجار' : 'للبيع';
  const out = ['#بونا', '#BonaRealEstate'];
  if (cityAr) out.push(`#عقارات_${cityAr}`);
  if (cityEn) out.push(`#${cityEn}RealEstate`);
  if (word && cityAr) out.push(`#${word.ar}_${cityAr}`);
  if (word) out.push(`#${word.ar}_${deal}`);
  if (word && cityEn) out.push(`#${cityEn}${word.en}`);
  if (p.category === 'off-plan') out.push('#مشاريع_على_الخارطة', '#OffPlan');
  if (district.ar && wordCount(district.ar) <= 3 && arTag(district.ar)) out.push(`#${arTag(district.ar)}`);
  if (district.en && wordCount(district.en) <= 3 && enTag(district.en)) out.push(`#${enTag(district.en)}`);
  out.push('#عقارات_فاخرة');
  return [...new Set(out)].slice(0, 12);
}
```

Then replace the whole `export function entryFor(...) { ... }` block with:

```js
export function entryFor(p, review, advertiser, channel, date, assets = []) {
  return {id:`bona-daily-${channel==='instagram'?'ig':'fb'}-${date}`,date,time:'20:30',platform:channel,
    listingId:p.id,topic:p.title,format:'carousel',caption:captionFor(p,advertiser,review),hashtags:propertyHashtags(p),
    reviewStatus:'approved',adLicenceRequired:false,adLicenceVerified:true,blocked:false,
    images:review.photos.map(x=>x.url),assets,assetsJpg:assets,alt:review.photos[0].alt,status:'planned'};
}
```

Leave `eligibility` untouched in this task (it still calls `propertyCaption(p,advertiser,review.legalDisclosures)`, which equals `captionFor` for photograph-only reviews).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/test/property-daily.test.mjs` then `npm test`. Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/social/lib/property-daily.mjs scripts/test/property-daily.test.mjs
git commit -m "property-daily: advertiser line on every caption, render note, off-plan wording, generated hashtags

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Policy-driven eligibility and rotation

**Files:**
- Modify: `scripts/social/lib/property-daily.mjs` (`eligibility`, `chooseProperty`)
- Test: `scripts/test/property-daily.test.mjs`

- [ ] **Step 1: Write the failing tests**

In the first test (`'publication eligibility needs a current licence…'`), change two assertions:

```js
  assert.ok(eligibility({...p,category:'off-plan'},r,a,now).includes('outside_policy_scope'));
```
(was `requires_separate_market_or_offplan_review`), and

```js
  assert.ok(eligibility(p,{...r,photos:r.photos.map(x=>({...x,kind:'render'}))},a,now).includes('render_not_allowed'));
```
(was `photo_quality_or_provenance_unverified`).

Insert after `offPlanFixture()`:

```js
const WAIVED = policyRules({ adLicence: { requirement: 'waived', by: 'owner', on: '2026-10-02' }, countries: ['SA'], categories: ['buy','rent','off-plan'], renders: 'off-plan-only', reviewValidDays: 90 }, now);
function waivedReview(p, a, kind = 'photograph') {
  const { review: base } = fixture();
  const review = { ...base, factsSha256: fingerprint(p), advertiserSha256: advertiserFingerprint(a), licenceEvidence: null,
    photos: p.images.map((x, i) => ({ ...base.photos[0], url: 'https://bona-real-estate.com' + x.src, sha256: sha256('fixture ' + i), kind })) };
  review.captionSha256 = sha256(JSON.stringify(captionFor(p, a, review)));
  return review;
}
```

Append to the end of the file:

```js
test('waived policy: an unlicensed Saudi listing with a current review is eligible; the strict policy still refuses it', () => {
  const { listing, advertiser: a } = fixture(); const p = { ...listing, licence: null };
  const r = waivedReview(p, a);
  assert.deepEqual(eligibility(p, r, a, now, WAIVED), []);
  const strict = eligibility(p, r, a, now);
  for (const why of ['missing_ad_licence','missing_or_expired_ad_licence','licence_and_marketing_authority_unverified']) assert.ok(strict.includes(why), why);
});
test('waived policy: off-plan may use renders; ready stock may not; foreign stock is out of scope', () => {
  const { listing: p, advertiser: a } = offPlanFixture();
  assert.deepEqual(eligibility(p, waivedReview(p, a, 'render'), a, now, WAIVED), []);
  const { listing: ready } = fixture(); const bare = { ...ready, licence: null };
  assert.ok(eligibility(bare, waivedReview(bare, a, 'render'), a, now, WAIVED).includes('render_not_allowed'));
  const oman = { ...p, location: { ...p.location, countryCode: 'OM' } };
  assert.ok(eligibility(oman, waivedReview(oman, a, 'render'), a, now, WAIVED).includes('outside_policy_scope'));
  assert.ok(eligibility(p, waivedReview(p, a, 'sketch'), a, now, WAIVED).includes('photo_quality_or_provenance_unverified'));
});
test('waived policy: reviews last reviewValidDays and changed facts or captions still invalidate them', () => {
  const { listing, advertiser: a } = fixture(); const p = { ...listing, licence: null };
  const r = { ...waivedReview(p, a), reviewedAt: '2026-08-10T12:00:00Z' };
  assert.deepEqual(eligibility(p, r, a, now, WAIVED), []);
  assert.ok(eligibility(p, r, a, now).includes('review_expired'));
  assert.ok(eligibility(p, { ...r, reviewedAt: '2026-06-30T12:00:00Z' }, a, now, WAIVED).includes('review_expired'));
  assert.ok(eligibility({ ...p, price: { ...p.price, amount: 2 } }, r, a, now, WAIVED).includes('listing_changed_since_review'));
  assert.ok(eligibility(p, { ...r, captionSha256: 'bad' }, a, now, WAIVED).includes('caption_changed_since_review'));
});
test('rotation applies the policy rules it is given', () => {
  const { listing, advertiser: a } = fixture(); const p = { ...listing, licence: null };
  const reviews = { [p.id]: waivedReview(p, a) };
  assert.equal(chooseProperty([p], reviews, a, [], 'instagram', now).listing, null);
  assert.equal(chooseProperty([p], reviews, a, [], 'instagram', now, 30, WAIVED).listing.id, p.id);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/test/property-daily.test.mjs`
Expected: FAIL — `outside_policy_scope` / `render_not_allowed` not found and the waived assertions fail (eligibility ignores the 5th argument).

- [ ] **Step 3: Implement**

Replace the whole `export function eligibility(...) { ... }` block with:

```js
export function eligibility(p, review, advertiser, now = new Date(), rules = STRICT_RULES) {
  const reasons = [];
  if (p?.status !== 'available') reasons.push('not_available');
  if (!rules.countries.includes(p?.location?.countryCode) || !rules.categories.includes(p?.category)) reasons.push('outside_policy_scope');
  const licence = p?.licence;
  if (rules.licenceRequired) {
    if (!/^\d{8,15}$/.test(licence?.adNumber ?? '')) reasons.push('missing_ad_licence');
    if (!realDate(licence?.adExpiry) || licence.adExpiry < ksaNow(now).date) reasons.push('missing_or_expired_ad_licence');
  }
  if (!review || review.status !== 'approved') reasons.push('photo_and_copy_review_pending');
  if (!review) return reasons;
  if (review.factsSha256 !== fingerprint(p)) reasons.push('listing_changed_since_review');
  if (review.advertiserSha256 !== advertiserFingerprint(advertiser)) reasons.push('advertiser_changed_since_review');
  if (!fresh(review.reviewedAt,now,rules.reviewValidDays)) reasons.push('review_expired');
  if (rules.licenceRequired) {
    const e = review.licenceEvidence;
    if (!e || e.adNumber !== licence?.adNumber || e.adExpiry !== licence?.adExpiry ||
        !e.sourceReference || !e.marketingAuthorizationReference || e.socialMediaAllowed !== true ||
        e.contactMatches !== true || !fresh(e.verifiedAt,now,30)) reasons.push('licence_and_marketing_authority_unverified');
  }
  if (review.legalDisclosuresVerified !== true || !review.legalDisclosures?.ar?.trim() || !review.legalDisclosures?.en?.trim()) reasons.push('property_condition_services_and_rights_disclosures_pending');
  if (!advertiser?.name?.ar || !advertiser?.name?.en || !/^\d{8,15}$/.test(advertiser?.fal ?? '') ||
      !/^\+\d{8,15}$/.test(advertiser?.phone ?? '')) reasons.push('advertiser_details_incomplete');
  const photos = review.photos ?? [];
  if (photos.length < 3 || photos.length > 6 || new Set(photos.map(x=>x.url)).size !== photos.length) reasons.push('need_three_to_six_distinct_photos');
  const allowed = new Set((p.images ?? []).map(x=>{try{return imageUrl(x.src)}catch{return null}}));
  const rendersAllowed = rules.renders === 'off-plan-only' && p?.category === 'off-plan';
  for (const photo of photos) {
    let url; try { url = imageUrl(photo.url); } catch { reasons.push('unapproved_photo_source'); continue; }
    if (photo.kind === 'render' && !rendersAllowed) reasons.push('render_not_allowed');
    if (!allowed.has(url) || !['photograph','render'].includes(photo.kind) || photo.visuallyApproved !== true ||
        !/^[a-f0-9]{64}$/.test(photo.sha256 ?? '') || photo.width < 1080 || photo.height < 720 ||
        photo.width/photo.height < 0.8 || photo.width/photo.height > 1.91 || !photo.alt?.ar || !photo.alt?.en) reasons.push('photo_quality_or_provenance_unverified');
  }
  if (review.captionSha256 !== sha256(JSON.stringify(captionFor(p,advertiser,review)))) reasons.push('caption_changed_since_review');
  return [...new Set(reasons)];
}
```

Replace the `chooseProperty` signature line and its `eligibility` call:

```js
export function chooseProperty(listings, reviews, advertiser, events, channel, now = new Date(), repeatDays = 30, rules = STRICT_RULES) {
```
and inside it
```js
    const why = eligibility(p,reviews[p.id],advertiser,now,rules);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/test/property-daily.test.mjs` then `npm test`. Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/social/lib/property-daily.mjs scripts/test/property-daily.test.mjs
git commit -m "property-daily: eligibility follows the policy — waiver, Saudi scope, off-plan renders, review age

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Publisher plumbing, attempt settlement, the owner's policy

**Files:**
- Modify: `scripts/social/lib/property-daily.mjs` (`dayState`, new `unsettled`)
- Modify: `scripts/social/property-publish.mjs` (import line 6; after the policy validation; the unresolved-attempt check; `chooseProperty` call; preflight `eligibility` call)
- Modify: `marketing/daily/property-policy.json`
- Test: `scripts/test/property-daily.test.mjs`

- [ ] **Step 1: Write the failing tests**

Replace the import line with:

```js
import { publicListing,sha256,fingerprint,advertiserFingerprint,eligibility,propertyCaption,chooseProperty,dayState,realDate,policyRules,STRICT_RULES,renderShare,captionFor,propertyHashtags,entryFor,unsettled } from '../social/lib/property-daily.mjs';
```

Append to the end of the file:

```js
test('a later confirmed-not-published record settles an attempt; an earlier one does not', () => {
  const intent = { channel: 'instagram', date: '2026-10-05', id: 'bona-daily-ig-2026-10-05', status: 'intent' };
  const uncertain = { ...intent, status: 'uncertain' };
  const cleared = { ...intent, status: 'confirmed-not-published', evidence: 'fixture' };
  assert.equal(dayState([intent, uncertain, cleared], 'instagram', '2026-10-05'), 'ready');
  assert.equal(dayState([cleared, intent], 'instagram', '2026-10-05'), 'uncertain');
  assert.equal(unsettled([intent, uncertain], 'instagram'), true);
  assert.equal(unsettled([intent, uncertain, cleared], 'instagram'), false);
  assert.equal(unsettled([cleared, intent], 'instagram'), true);
  assert.equal(unsettled([intent, { ...intent, status: 'published' }], 'instagram'), false);
  assert.equal(unsettled([intent], 'facebook'), false);
});
function writePolicy(root, extra = {}) {
  fs.mkdirSync(path.join(root, 'marketing/daily'), { recursive: true });
  fs.writeFileSync(path.join(root, 'marketing/daily/property-policy.json'), JSON.stringify({ version: 1, mode: 'property-photography', time: '20:30', timezone: 'Asia/Riyadh', repeatDays: 30, catalogueUrl: 'https://bona-real-estate.com/social-catalogue.json', channels: ['instagram', 'facebook'], ...extra }));
}
const WAIVER_POLICY = { adLicence: { requirement: 'waived', by: 'owner', on: '2026-10-02' }, countries: ['SA'], categories: ['buy', 'rent', 'off-plan'], renders: 'off-plan-only', reviewValidDays: 90 };
test('waived policy: an unlicensed off-plan listing with reviewed renders passes the dry preflight without writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-property-waiver-'));
  try {
    writePolicy(root, WAIVER_POLICY);
    const { listing: p, advertiser: a } = offPlanFixture(); const r = waivedReview(p, a, 'render');
    fs.writeFileSync(path.join(root, 'marketing/daily/property-reviews.json'), JSON.stringify({ [p.id]: r }));
    const env = { BONA_DATA: path.join(root, 'data'), META_ACCESS_TOKEN: 'not-a-real-token', IG_BUSINESS_ID: '17841427688957180' };
    const fetchImpl = async (url, opts) => {
      assert.ok(!opts?.method || opts.method === 'GET', 'preflight must never mutate');
      const u = new URL(url);
      if (u.pathname === '/social-catalogue.json') return Response.json({ version: 1, generatedAt: now.toISOString(), advertiser: a, listings: [p] });
      if (u.hostname === 'graph.facebook.com') return Response.json(u.pathname.endsWith('content_publishing_limit') ? { data: [{ quota_usage: 0, config: { quota_total: 100 } }] } : { id: env.IG_BUSINESS_ID, username: 'bonarealestatesa' });
      const i = r.photos.findIndex(x => x.url === url); assert.ok(i >= 0);
      return new Response('fixture ' + i, { headers: { 'content-type': 'image/jpeg' } });
    };
    const ready = await propertyDaily('instagram', { dry: true, now, root, env, fetchImpl });
    assert.equal(ready.status, 'ready');
    assert.equal(ready.entry.listingId, p.id);
    assert.match(ready.entry.caption.en, /artist's impressions/);
    assert.ok(ready.entry.hashtags.includes('#OffPlan'));
    assert.equal(fs.existsSync(env.BONA_DATA), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('a waiver without a name or date stops the run before any network call', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-property-badwaiver-'));
  try {
    writePolicy(root, { adLicence: { requirement: 'waived' } });
    fs.writeFileSync(path.join(root, 'marketing/daily/property-reviews.json'), '{}');
    let calls = 0; const fetchImpl = async () => { calls++; throw new Error('no network expected'); };
    await assert.rejects(propertyDaily('instagram', { dry: true, now, root, env: { BONA_DATA: path.join(root, 'data') }, fetchImpl }), /waiver/);
    assert.equal(calls, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('the repository policy is the owner waiver for Saudi ready and off-plan stock', () => {
  const policy = JSON.parse(fs.readFileSync(new URL('../../marketing/daily/property-policy.json', import.meta.url), 'utf8'));
  const r = policyRules(policy, new Date('2026-10-05T17:30:00Z'));
  assert.equal(r.licenceRequired, false);
  assert.deepEqual([...r.countries], ['SA']);
  assert.deepEqual([...r.categories], ['buy', 'rent', 'off-plan']);
  assert.equal(r.renders, 'off-plan-only');
  assert.equal(r.reviewValidDays, 90);
  assert.equal(policy.adLicence.by, 'owner');
  assert.equal(policy.adLicence.on, '2026-10-05');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/test/property-daily.test.mjs`
Expected: FAIL — `does not provide an export named 'unsettled'`.

- [ ] **Step 3: Implement**

In `scripts/social/lib/property-daily.mjs` replace the `dayState` function with:

```js
export function dayState(events, channel, date) {
  const records = events.filter(x => x.channel === channel && x.date === date);
  if (records.some(x => x.status === 'published')) return 'published';
  if (records.some((x, i) => ['intent', 'uncertain'].includes(x.status) && !records.slice(i + 1).some(y => y.status === 'confirmed-not-published'))) return 'uncertain';
  return 'ready';
}
/** True while an intent/uncertain attempt on this channel has no 'published' record, nor a 'confirmed-not-published' record written after it. */
export function unsettled(events, channel) {
  return events.some((e, i) => e.channel === channel && ['intent', 'uncertain'].includes(e.status) &&
    !events.some((p, j) => p.channel === channel && p.id === e.id && (p.status === 'published' || (p.status === 'confirmed-not-published' && j > i))));
}
```

In `scripts/social/property-publish.mjs`:

1. Line 6 becomes:
```js
import { ACCOUNT, SITE, sha256, fingerprint, eligibility, chooseProperty, dayState, entryFor, policyRules, unsettled } from './lib/property-daily.mjs';
```
2. Directly after the line ending `throw new Error('Invalid property publishing policy');` add:
```js
  const rules=policyRules(policy,now);
```
3. Replace the line starting `    if(history.some(e=>e.channel===channel&&['intent','uncertain']` with:
```js
    if(unsettled(history,channel))throw new Error('Earlier property publication remains uncertain; reconcile it before retrying');
```
4. In the `chooseProperty(` call add `rules` as the last argument:
```js
    const selected=chooseProperty(live.listings,reviews,live.advertiser,history,channel,now,policy.repeatDays,rules);
```
5. In the preflight re-check replace `eligibility(updated,review,current.advertiser,now)` with `eligibility(updated,review,current.advertiser,now,rules)`.

Replace the whole content of `marketing/daily/property-policy.json` with:

```json
{
  "version": 1,
  "mode": "property-photography",
  "time": "20:30",
  "timezone": "Asia/Riyadh",
  "repeatDays": 30,
  "catalogueUrl": "https://bona-real-estate.com/social-catalogue.json",
  "channels": ["instagram", "facebook"],
  "countries": ["SA"],
  "categories": ["buy", "rent", "off-plan"],
  "renders": "off-plan-only",
  "reviewValidDays": 90,
  "adLicence": {
    "requirement": "waived",
    "by": "owner",
    "on": "2026-10-05",
    "note": "Owner instruction 2026-10-05: post current Saudi website properties daily without per-listing REGA ad-licence numbers. The exposure was stated and accepted (2026 advertising bylaw; a Jeddah first offence is a warning or about SAR 5,000). Advertiser name, FAL 1100313556 and phone stay on every post; a listing's ad-licence line appears automatically once it carries a number."
  },
  "noEligibleProperty": "fallback-to-approved-pack-else-skip",
  "missedSlot": "skip-after-23:00-no-backfill",
  "authorization": "Owner requested daily promotion of current website properties with clear actual photographs on 2026-10-02; scope widened to Saudi ready and off-plan stock under the ad-licence waiver on 2026-10-05."
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/test/property-daily.test.mjs` then `npm test`. Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/social/lib/property-daily.mjs scripts/social/property-publish.mjs marketing/daily/property-policy.json scripts/test/property-daily.test.mjs
git commit -m "property-publish: owner's ad-licence waiver policy, rules passed through, confirmed-not-published settles an attempt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5 (lane B): Heartbeat and fall-through to the pack

Work in `~/bona-wt/property-waiver-hb`.

**Files:**
- Create: `scripts/social/lib/heartbeat.mjs`
- Modify: `scripts/social/daily-publish.mjs`
- Test: `scripts/test/heartbeat.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `scripts/test/heartbeat.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { heartbeatFor, pushHeartbeat, continueToPack } from '../social/lib/heartbeat.mjs';

const at = hhmm => new Date(`2026-10-05T${hhmm}:00+03:00`);
test('only a skipped property run continues into the reviewed pack', () => {
  assert.equal(continueToPack({ status: 'skipped-no-eligible-property' }), true);
  for (const status of ['published', 'already-published', 'ready', 'not-due']) assert.equal(continueToPack({ status }), false);
  assert.equal(continueToPack(undefined), false);
});
test('a confirmed publication is always up; silence before 22:30; down in the last two runs', () => {
  assert.deepEqual(heartbeatFor({ status: 'published', now: at('20:31') }), { status: 'up', msg: 'published' });
  assert.deepEqual(heartbeatFor({ status: 'already-published', now: at('22:45') }), { status: 'up', msg: 'already-published' });
  assert.equal(heartbeatFor({ status: 'skipped-no-eligible-property', now: at('20:30') }), null);
  assert.equal(heartbeatFor({ status: 'skipped-no-eligible-property', now: at('22:29') }), null);
  assert.deepEqual(heartbeatFor({ status: 'skipped-no-eligible-property', now: at('22:30') }), { status: 'down', msg: 'skipped-no-eligible-property' });
  assert.equal(heartbeatFor({ status: 'not-due', now: at('23:00') }), null);
  assert.equal(heartbeatFor({ status: 'published', now: at('20:31'), dry: true }), null);
  assert.deepEqual(heartbeatFor({ error: new Error('boom EAAabc123'), now: at('22:45') }), { status: 'down', msg: 'boom [redacted]' });
});
test('push reads the URL outside the repo, adds status and message, and never throws', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-hb-'));
  try {
    const log = () => {};
    const calls = [];
    const ok = async (url, opts) => { calls.push({ url, opts }); return new Response('{"ok":true}'); };
    assert.deepEqual(await pushHeartbeat('instagram', { status: 'up', msg: 'published' }, { dataDir, fetchImpl: ok, log }), { sent: false, reason: 'no-url' });
    assert.equal(calls.length, 0);
    fs.mkdirSync(path.join(dataDir, 'daily'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'daily', 'heartbeat-instagram.url'), 'https://uptime.example/api/push/abc123\n');
    assert.deepEqual(await pushHeartbeat('instagram', { status: 'up', msg: 'published' }, { dataDir, fetchImpl: ok, log }), { sent: true });
    const u = new URL(calls[0].url);
    assert.equal(u.origin + u.pathname, 'https://uptime.example/api/push/abc123');
    assert.equal(u.searchParams.get('status'), 'up');
    assert.equal(u.searchParams.get('msg'), 'instagram: published');
    assert.equal(calls[0].opts.redirect, 'error');
    const boom = async () => { throw new Error('network down'); };
    assert.deepEqual(await pushHeartbeat('instagram', { status: 'down', msg: 'x' }, { dataDir, fetchImpl: boom, log }), { sent: false, reason: 'error' });
    const notFound = async () => new Response('nope', { status: 404 });
    assert.deepEqual(await pushHeartbeat('instagram', { status: 'down', msg: 'x' }, { dataDir, fetchImpl: notFound, log }), { sent: false, reason: 'error' });
    fs.writeFileSync(path.join(dataDir, 'daily', 'heartbeat-instagram.url'), 'http://uptime.example/api/push/abc123');
    assert.deepEqual(await pushHeartbeat('instagram', { status: 'up', msg: 'x' }, { dataDir, fetchImpl: ok, log }), { sent: false, reason: 'error' });
    assert.deepEqual(await pushHeartbeat('instagram', null, { dataDir, fetchImpl: ok, log }), { sent: false, reason: 'nothing-to-say' });
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/test/heartbeat.test.mjs`
Expected: FAIL — `Cannot find module '…/scripts/social/lib/heartbeat.mjs'`.

- [ ] **Step 3: Implement the module**

Create `scripts/social/lib/heartbeat.mjs`:

```js
// Daily-run routing and the Uptime Kuma heartbeat. The push URL lives outside the repo:
// ~/bona-data/daily/heartbeat-<channel>.url (mode 600). A missing file or a failed push is
// logged and never changes the run's outcome.
import fs from 'node:fs';
import path from 'node:path';
import { ksaNow } from './daily-pack.mjs';

const PUBLISHED = new Set(['published', 'already-published']);
/** Only a property run that found nothing eligible continues into the reviewed-pack path. */
export const continueToPack = result => result?.status === 'skipped-no-eligible-property';
/**
 * What Uptime Kuma should hear about this run: { status: 'up'|'down', msg } or null (say nothing).
 * Up on any confirmed publication. Down only from 22:30 to 22:59 Riyadh (the last two timer runs)
 * when the day still has no post, so earlier retries stay quiet. Dry runs never report.
 */
export function heartbeatFor({ status = null, error = null, now = new Date(), dry = false } = {}) {
  if (dry) return null;
  if (PUBLISHED.has(status)) return { status: 'up', msg: status };
  const { time } = ksaNow(now);
  if (time < '22:30' || time >= '23:00') return null;
  const why = error ? (error.message ?? String(error)) : (status ?? 'no publication');
  return { status: 'down', msg: String(why).replace(/EAA[A-Za-z0-9]+/g, '[redacted]').slice(0, 200) };
}
export async function pushHeartbeat(channel, beat, { dataDir, fetchImpl = fetch, log = console.log } = {}) {
  if (!beat) return { sent: false, reason: 'nothing-to-say' };
  const file = path.join(dataDir, 'daily', `heartbeat-${channel}.url`);
  let base;
  try { base = fs.readFileSync(file, 'utf8').trim(); }
  catch { log(`heartbeat: no ${path.basename(file)}; not pushed`); return { sent: false, reason: 'no-url' }; }
  try {
    const u = new URL(base);
    if (u.protocol !== 'https:') throw new Error('heartbeat URL must be https');
    u.search = new URLSearchParams({ status: beat.status, msg: `${channel}: ${beat.msg}` }).toString();
    const res = await fetchImpl(u.href, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    log(`heartbeat: ${channel} ${beat.status}`);
    return { sent: true };
  } catch (e) {
    log(`heartbeat: ${channel} push failed (${String(e.message).slice(0, 120)})`);
    return { sent: false, reason: 'error' };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/test/heartbeat.test.mjs` — Expected: 3 PASS.

- [ ] **Step 5: Wire it into the daily entry point**

Replace the whole content of `scripts/social/daily-publish.mjs` with:

```js
#!/usr/bin/env node
// Daily dispatch: reviewed property posts first; a reviewed finite pack only when no property is eligible and a pack day is due. Never reads the legacy queue/calendar.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {verifyPack,dueToday,ksaNow,verifyPublic,facebookState,ROOT} from "./lib/daily-pack.mjs";
import {withLock,pageToken,publishEntry,appendLedger,captionFromEntry,filesFor} from "./lib/facebook.mjs";
import {continueToPack,heartbeatFor,pushHeartbeat} from "./lib/heartbeat.mjs";
const channel=process.argv[2],dry=process.argv.includes("--dry-run");
if(!["instagram","facebook"].includes(channel))throw new Error("Choose instagram or facebook");
const data=process.env.BONA_DATA||path.join(os.homedir(),"bona-data"),dir=path.join(data,"daily");
fs.mkdirSync(dir,{recursive:true});
const now=dry&&process.env.BONA_DAILY_TEST_NOW?new Date(process.env.BONA_DAILY_TEST_NOW):new Date();
const beat=(status,error=null)=>pushHeartbeat(channel,heartbeatFor({status,error,now,dry}),{dataDir:data});
function record(file,obj){const fd=fs.openSync(file,"a",0o600);try{fs.writeSync(fd,JSON.stringify({...obj,at:new Date().toISOString()})+"\n");fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}
function rows(file){if(!fs.existsSync(file))return [];return fs.readFileSync(file,"utf8").trim().split("\n").filter(Boolean).map(x=>JSON.parse(x))}
try{
 if(fs.existsSync(path.join(ROOT,"marketing/daily/property-policy.json"))){
  const {propertyDaily}=await import("./property-publish.mjs");
  const result=await propertyDaily(channel,{dry,now});
  if(!continueToPack(result)){await beat(result?.status);process.exit(0)}
  console.log("No eligible property today; checking the reviewed daily pack.");
 }
 const pack=verifyPack();
 // Positive isolation: a legacy timer accidentally restored by an installer is a stop.
 if(!dry)for(const name of ["bona-ig-publish.timer","bona-fb-publish.timer"]){
  const check=spawnSync("systemctl",["--user","is-enabled",name],{encoding:"utf8"});
  if(!["disabled","masked","not-found"].includes(check.stdout.trim()))throw new Error(`Legacy timer is not disabled: ${name}`);
  const active=spawnSync("systemctl",["--user","is-active",name],{encoding:"utf8"});
  if(!["inactive","unknown"].includes(active.stdout.trim()))throw new Error(`Legacy timer is active: ${name}`);
 }
 const entry=dueToday(pack[channel],now);
 if(!entry){console.log(`No daily content due (${JSON.stringify(ksaNow(now))}); no backfill or legacy fallback.`);await beat("nothing-due");process.exit(0)}
 if(channel==="instagram"){
  await verifyPublic(entry,pack.manifest);
  if(dry){console.log(`Validated public bytes and reviewed source: ${entry.id}; no publish`);process.exit(0)}
  const r=spawnSync(process.execPath,["scripts/social/publish.mjs","--live","--source","marketing/daily/instagram.json","--grace","2.5","--limit","1"],{cwd:ROOT,stdio:"inherit",env:process.env});
  if(r.status!==0)throw new Error(`Instagram publisher requires attention (exit ${r.status})`);
  const published=rows(path.join(data,"ig/published.jsonl")).some(x=>x.id===entry.id&&x.status==="published");
  if(!published)throw new Error("Instagram did not confirm publication; inspect ledger skip/defer or in-flight reason");
  await beat("published");
 }else{
  if(dry){console.log(`Validated local reviewed assets: ${entry.id}; no publish`);process.exit(0)}
  const journal=path.join(dir,"facebook.jsonl");
  const outcome=await withLock(path.join(dir,".facebook.lock"),async()=>{
   const state=facebookState(rows(journal),entry.id);
   if(state==="published"){console.log("Already published today");return "already-published"}
   if(state==="uncertain")throw new Error(`Uncertain Facebook intent ${entry.id}; manual reconciliation required, no retry`);
   if(!process.env.META_ACCESS_TOKEN||!process.env.FB_PAGE_ID)throw new Error("Facebook credentials unavailable");
   const page=await pageToken({fetch,token:process.env.META_ACCESS_TOKEN,pageId:process.env.FB_PAGE_ID});
   captionFromEntry(entry);
   for(const f of filesFor(entry,ROOT))if(!fs.existsSync(f))throw new Error("Reviewed Facebook asset missing before upload");
   record(journal,{id:entry.id,status:"intent",date:entry.date});
   const result=await publishEntry(entry,{fetch,pageToken:page.token,pageId:process.env.FB_PAGE_ID,root:ROOT});
   record(journal,{id:entry.id,status:"published",...result});
   appendLedger(path.join(data,"fb/published.jsonl"),{id:entry.id,...result,at:new Date().toISOString()});
   console.log(`Published ${entry.id}: ${JSON.stringify(result)}`);
   return "published";
  });
  await beat(outcome);
 }
}catch(e){
 // Errors deliberately contain no token or provider request/response body.
 if(!dry)record(path.join(dir,"alerts.jsonl"),{channel,status:"needs-attention",reason:String(e.message).replace(/EAA[A-Za-z0-9]+/g,"[redacted]").slice(0,800)});
 console.error(`Daily ${channel} failed; see ${path.join(dir,"alerts.jsonl")}. No fallback was used.`);process.exitCode=1;
 await beat(null,e);
}
```

- [ ] **Step 6: Check it parses and the suite is green**

Run: `node --check scripts/social/daily-publish.mjs && npm test`
Expected: no syntax error; all PASS (163).

- [ ] **Step 7: Commit**

```bash
git add scripts/social/lib/heartbeat.mjs scripts/social/daily-publish.mjs scripts/test/heartbeat.test.mjs
git commit -m "daily-publish: fall through to an approved pack when no property is eligible; Uptime Kuma heartbeat

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Review tooling (draft and approve)

**Files:**
- Create: `scripts/social/lib/property-review.mjs`
- Create: `scripts/social/draft-property-reviews.mjs`
- Create: `scripts/social/approve-property-review.mjs`
- Test: `scripts/test/property-review.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `scripts/test/property-review.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { policyRules, eligibility, sha256 } from '../social/lib/property-daily.mjs';
import { frameProblem, aspectConsistent, parseSelection, disclosuresFor, buildReview, sameReview, liveCatalogue } from '../social/lib/property-review.mjs';
import { main as draft } from '../social/draft-property-reviews.mjs';
import { main as approve } from '../social/approve-property-review.mjs';

const now = new Date('2026-10-05T10:00:00Z');
const WAIVER = { version: 1, mode: 'property-photography', time: '20:30', timezone: 'Asia/Riyadh', repeatDays: 30, catalogueUrl: 'https://bona-real-estate.com/social-catalogue.json', channels: ['instagram', 'facebook'], adLicence: { requirement: 'waived', by: 'owner', on: '2026-10-05' }, countries: ['SA'], categories: ['buy', 'rent', 'off-plan'], renders: 'off-plan-only', reviewValidDays: 90 };
const advertiser = { name: { ar: 'المعلن التجريبي', en: 'Fixture advertiser' }, fal: '1100000000', phone: '+966500000000' };
const jpeg = (width, height, background) => sharp({ create: { width, height, channels: 3, background } }).jpeg().toBuffer();
async function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-review-'));
  fs.mkdirSync(path.join(root, 'marketing/daily'), { recursive: true });
  fs.writeFileSync(path.join(root, 'marketing/daily/property-policy.json'), JSON.stringify(WAIVER));
  fs.writeFileSync(path.join(root, 'marketing/daily/property-reviews.json'), '{}\n');
  const images = {
    '/listings/villa/1.jpg': await jpeg(1920, 1280, '#336699'),
    '/listings/villa/2.jpg': await jpeg(1920, 1280, '#669933'),
    '/listings/villa/3.jpg': await jpeg(1800, 1200, '#993366'),
    '/listings/villa/4.jpg': await jpeg(800, 600, '#999999'),
    '/listings/villa/5.jpg': await jpeg(1080, 1350, '#333333'),
  };
  const villa = { id: 'BONA-T1', slug: 'villa', status: 'available', category: 'buy', type: 'villa',
    location: { countryCode: 'SA', district: { ar: 'الشاطئ', en: 'Al Shati' }, city: { ar: 'جدة', en: 'Jeddah' } },
    title: { ar: 'فيلا تجريبية', en: 'Fixture villa' }, price: { amount: 5000000, currency: 'SAR', from: false, onRequest: false }, specs: { beds: 5 },
    images: Object.keys(images).map((src, i) => ({ src, alt: { ar: `صورة ${i + 1}`, en: `Photo ${i + 1}` } })), licence: null };
  const muscat = { ...villa, id: 'BONA-T2', slug: 'muscat', location: { ...villa.location, countryCode: 'OM' } };
  const state = { listings: [villa, muscat] };
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/social-catalogue.json') return Response.json({ version: 1, generatedAt: '2026-10-05T06:00:00Z', advertiser, listings: state.listings });
    const body = images[u.pathname];
    if (!body) return new Response('missing', { status: 404 });
    return new Response(body, { headers: { 'content-type': 'image/jpeg' } });
  };
  return { root, fetchImpl, state, villa, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('frame rules match the publisher: JPEG, at most 8 MB, at least 1080x720, aspect 0.8 to 1.91', () => {
  const ok = { contentType: 'image/jpeg', bytes: 500_000, width: 1920, height: 1280 };
  assert.equal(frameProblem(ok), null);
  assert.equal(frameProblem({ ...ok, contentType: 'image/png' }), 'not_jpeg');
  assert.equal(frameProblem({ ...ok, bytes: 8_000_001 }), 'too_large');
  assert.equal(frameProblem({ ...ok, width: 1024, height: 768 }), 'too_small');
  assert.equal(frameProblem({ ...ok, width: 1484, height: 1920 }), 'aspect');
  assert.equal(frameProblem({ ...ok, width: 1920, height: 960 }), 'aspect');
  assert.equal(frameProblem({ ...ok, width: 1080, height: 1350 }), null);
});
test('a carousel keeps frames within 15% of the first frame aspect, and selections are 3 to 6 distinct frames', () => {
  assert.equal(aspectConsistent([{ width: 1920, height: 1280 }, { width: 1800, height: 1200 }, { width: 1920, height: 1200 }]), true);
  assert.equal(aspectConsistent([{ width: 1920, height: 1280 }, { width: 1080, height: 1350 }]), false);
  assert.deepEqual(parseSelection('BONA-W013:1,2r,5p'), { id: 'BONA-W013', frames: [{ index: 1, kind: null }, { index: 2, kind: 'render' }, { index: 5, kind: 'photograph' }] });
  assert.throws(() => parseSelection('BONA-001:1,2'), /3–6 frames/);
  assert.throws(() => parseSelection('BONA-001:1,2,3,4,5,6,7'), /3–6 frames/);
  assert.throws(() => parseSelection('BONA-001:1,1,2'), /Duplicate/);
});
test('the live catalogue must be fresh JSON', async () => {
  const stale = async () => Response.json({ version: 1, generatedAt: '2026-10-01T00:00:00Z', advertiser, listings: [] });
  await assert.rejects(liveCatalogue(stale, now), /invalid or stale/);
  const html = async () => new Response('<html>', { headers: { 'content-type': 'text/html' } });
  await assert.rejects(liveCatalogue(html, now), /unavailable/);
});
test('a built review passes eligibility under the waiver, renders default for off-plan, and re-approval is idempotent', async () => {
  const w = await world();
  try {
    const rules = policyRules(WAIVER, now);
    const frames = [1, 2, 3].map(index => ({ index, url: `https://bona-real-estate.com/listings/villa/${index}.jpg`, sha256: sha256('x' + index), width: 1920, height: 1280, alt: { ar: 'صورة', en: 'Photo' } }));
    const r = buildReview(w.villa, advertiser, frames, parseSelection('BONA-T1:1,2,3'), { reviewedAt: '2026-10-05T09:00:00Z', reviewer: 'test' });
    assert.deepEqual(eligibility(w.villa, r, advertiser, now, rules), []);
    assert.equal(r.licenceEvidence, null);
    assert.deepEqual(r.legalDisclosures, disclosuresFor(w.villa));
    assert.ok(r.photos.every(x => x.kind === 'photograph' && x.visuallyApproved === true));
    const offPlan = { ...w.villa, category: 'off-plan' };
    const ro = buildReview(offPlan, advertiser, frames, parseSelection('BONA-T1:1,2,3p'), { reviewedAt: '2026-10-05T09:00:00Z', reviewer: 'test' });
    assert.deepEqual(ro.photos.map(x => x.kind), ['render', 'render', 'photograph']);
    assert.match(ro.legalDisclosures.en, /per the developer/);
    assert.deepEqual(eligibility(offPlan, ro, advertiser, now, rules), []);
    assert.throws(() => buildReview(w.villa, advertiser, frames, parseSelection('BONA-T1:1,2,9'), { reviewedAt: 'x', reviewer: 'y' }), /frame 9/);
    assert.equal(sameReview(r, { ...r, reviewedAt: '2026-10-06T09:00:00Z', reviewer: 'someone else' }), true);
    assert.equal(sameReview(r, { ...r, photos: r.photos.slice(0, 3).reverse() }), false);
  } finally { w.cleanup(); }
});
test('drafting writes usable frames, a contact sheet and drafts.json for in-scope listings only, and never touches the register', async () => {
  const w = await world();
  try {
    const out = path.join(w.root, 'drafts');
    const d = await draft(['--out', out], { fetchImpl: w.fetchImpl, now, root: w.root, log: () => {} });
    assert.deepEqual(Object.keys(d.listings), ['BONA-T1']);
    const t1 = d.listings['BONA-T1'];
    assert.deepEqual(t1.frames.map(f => f.index), [1, 2, 3, 5]);
    assert.deepEqual(t1.rejected, [{ index: 4, why: 'too_small', width: 800, height: 600 }]);
    for (const f of t1.frames) { assert.equal(sha256(fs.readFileSync(path.join(out, f.file))), f.sha256); assert.equal(f.buffer, undefined); }
    const sheet = await sharp(path.join(out, t1.sheet)).metadata();
    assert.equal(sheet.format, 'jpeg');
    assert.equal(sheet.width, 1440);
    assert.equal(fs.readFileSync(path.join(w.root, 'marketing/daily/property-reviews.json'), 'utf8'), '{}\n');
    assert.ok(fs.existsSync(path.join(out, 'drafts.json')));
    await assert.rejects(draft(['--out', out], { fetchImpl: w.fetchImpl, now, root: w.root, log: () => {} }), /new output directory/);
  } finally { w.cleanup(); }
});
test('approving writes eligible reviews, refuses rejected frames or changed listings, and re-approval leaves the register alone', async () => {
  const w = await world();
  try {
    const out = path.join(w.root, 'drafts');
    await draft(['--out', out], { fetchImpl: w.fetchImpl, now, root: w.root, log: () => {} });
    const drafts = path.join(out, 'drafts.json');
    const reg = path.join(w.root, 'marketing/daily/property-reviews.json');
    const run = (select, at = now, reviewer = 'test reviewer') => approve(['--drafts', drafts, '--reviewer', reviewer, '--select', select], { fetchImpl: w.fetchImpl, now: at, root: w.root, log: () => {} });
    assert.deepEqual(await run('BONA-T1:1,2,3'), { written: 1, unchanged: 0, refused: [] });
    const saved = JSON.parse(fs.readFileSync(reg, 'utf8'))['BONA-T1'];
    assert.equal(saved.reviewer, 'test reviewer');
    assert.equal(saved.photos.length, 3);
    assert.deepEqual(eligibility(w.villa, saved, advertiser, now, policyRules(WAIVER, now)), []);
    const before = fs.readFileSync(reg, 'utf8');
    assert.deepEqual(await run('BONA-T1:1,2,3', new Date('2026-10-05T11:00:00Z')), { written: 0, unchanged: 1, refused: [] });
    assert.equal(fs.readFileSync(reg, 'utf8'), before);
    const rejected = await run('BONA-T1:1,2,4', now, 'r');
    assert.equal(rejected.written, 0);
    assert.match(rejected.refused[0], /frame 4/);
    assert.match((await run('BONA-T1:1,2,5', now, 'r')).refused[0], /aspect/);
    w.state.listings = [{ ...w.villa, price: { ...w.villa.price, amount: 4900000 } }];
    assert.match((await run('BONA-T1:1,2,3', now, 'r')).refused[0], /changed since drafting/);
    assert.equal(fs.readFileSync(reg, 'utf8'), before);
  } finally { w.cleanup(); }
});
test('every entry in the repository review register is well-formed', () => {
  const reg = JSON.parse(fs.readFileSync(new URL('../../marketing/daily/property-reviews.json', import.meta.url), 'utf8'));
  for (const [id, r] of Object.entries(reg)) {
    assert.match(id, /^BONA-[A-Z]?\d+$/);
    assert.equal(r.status, 'approved', id);
    for (const k of ['factsSha256', 'advertiserSha256', 'captionSha256']) assert.match(r[k], /^[a-f0-9]{64}$/, `${id} ${k}`);
    assert.ok(Number.isFinite(Date.parse(r.reviewedAt)) && typeof r.reviewer === 'string' && r.reviewer.trim(), id);
    assert.equal(r.legalDisclosuresVerified, true, id);
    assert.ok(r.photos.length >= 3 && r.photos.length <= 6, id);
    for (const p of r.photos) {
      assert.match(p.url, /^https:\/\/(bona-real-estate\.com|tk-storage\.azoz\.uk)\/.+\.jpe?g$/i, id);
      assert.ok(['photograph', 'render'].includes(p.kind) && p.visuallyApproved === true && /^[a-f0-9]{64}$/.test(p.sha256), id);
    }
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/test/property-review.test.mjs`
Expected: FAIL — `Cannot find module '…/scripts/social/lib/property-review.mjs'`.

- [ ] **Step 3: Implement the library**

Create `scripts/social/lib/property-review.mjs`:

```js
// Helpers for drafting and approving property photo/caption reviews (docs/daily-property-publishing.md).
// Nothing here publishes; the approve script is the only writer of marketing/daily/property-reviews.json.
import sharp from 'sharp';
import { SITE, sha256, fingerprint, advertiserFingerprint, captionFor } from './property-daily.mjs';

/** The publisher's own photo rules (eligibility() checks the same numbers). */
export const FRAME_RULES = Object.freeze({ minWidth: 1080, minHeight: 720, minAspect: 0.8, maxAspect: 1.91, maxBytes: 8_000_000 });
export const STANDARD_DISCLOSURES = Object.freeze({
  ar: 'الأسعار المعروضة هي الأسعار المطلوبة وقابلة للتغيير. تُؤكَّد التفاصيل والحالة والخدمات عند المعاينة.',
  en: 'Prices shown are asking prices and may change. Details, condition and services are confirmed at viewing.',
});
export const OFF_PLAN_DISCLOSURE = Object.freeze({
  ar: 'مواعيد التسليم والمواصفات حسب المطوّر.',
  en: 'Delivery dates and specifications are per the developer.',
});
export function disclosuresFor(p) {
  if (p?.category !== 'off-plan') return { ...STANDARD_DISCLOSURES };
  return { ar: `${STANDARD_DISCLOSURES.ar} ${OFF_PLAN_DISCLOSURE.ar}`, en: `${STANDARD_DISCLOSURES.en} ${OFF_PLAN_DISCLOSURE.en}` };
}
/** Why a downloaded frame cannot be used, or null. */
export function frameProblem({ contentType, bytes, width, height }) {
  if (!String(contentType ?? '').startsWith('image/jpeg')) return 'not_jpeg';
  if (bytes > FRAME_RULES.maxBytes) return 'too_large';
  if (!(width >= FRAME_RULES.minWidth) || !(height >= FRAME_RULES.minHeight)) return 'too_small';
  const aspect = width / height;
  if (aspect < FRAME_RULES.minAspect || aspect > FRAME_RULES.maxAspect) return 'aspect';
  return null;
}
/** Instagram crops every carousel frame to the first frame's aspect ratio; keep that crop small. */
export function aspectConsistent(photos, tolerance = 0.15) {
  if (!photos.length) return false;
  const first = photos[0].width / photos[0].height;
  return photos.every(p => Math.abs(p.width / p.height - first) / first <= tolerance);
}
/** "BONA-022:1,2r,5p" → { id, frames: [{ index, kind }] }; kind null means the category default. */
export function parseSelection(s) {
  const m = /^([A-Z]+-[A-Z]?\d+):(\d+[pr]?(?:,\d+[pr]?){2,5})$/.exec(String(s));
  if (!m) throw new Error(`Bad selection "${s}" — use BONA-ID:1,2,3 with 3–6 frames; suffix p = photograph, r = render`);
  const frames = m[2].split(',').map(x => ({ index: Number.parseInt(x, 10), kind: x.endsWith('r') ? 'render' : x.endsWith('p') ? 'photograph' : null }));
  if (new Set(frames.map(f => f.index)).size !== frames.length) throw new Error(`Duplicate frame in "${s}"`);
  return { id: m[1], frames };
}
/** An approved review for frames a reviewer has looked at. Throws when a frame is unusable or the set would crop badly. */
export function buildReview(p, advertiser, draftFrames, selection, { reviewedAt, reviewer }) {
  const photos = selection.frames.map(({ index, kind }) => {
    const f = draftFrames.find(x => x.index === index);
    if (!f) throw new Error(`${p.id}: frame ${index} was not a usable draft frame`);
    return { url: f.url, sha256: f.sha256, width: f.width, height: f.height,
      kind: kind ?? (p.category === 'off-plan' ? 'render' : 'photograph'), visuallyApproved: true, alt: f.alt };
  });
  if (!aspectConsistent(photos)) throw new Error(`${p.id}: selected frames differ in aspect ratio by more than 15% (Instagram crops a carousel to its first frame)`);
  const review = { status: 'approved', reviewedAt, reviewer, factsSha256: fingerprint(p), advertiserSha256: advertiserFingerprint(advertiser),
    captionSha256: null, licenceEvidence: null, legalDisclosuresVerified: true, legalDisclosures: disclosuresFor(p), photos };
  review.captionSha256 = sha256(JSON.stringify(captionFor(p, advertiser, review)));
  return review;
}
/** Equal apart from who approved it and when. */
export function sameReview(a, b) {
  const strip = r => JSON.stringify({ ...r, reviewedAt: null, reviewer: null });
  return Boolean(a && b) && strip(a) === strip(b);
}
/** The live public catalogue, with the publisher's freshness and shape checks. */
export async function liveCatalogue(fetchImpl = fetch, now = new Date()) {
  const res = await fetchImpl(`${SITE}/social-catalogue.json`, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) throw new Error('Live catalogue unavailable; do not review from stale local stock');
  const text = await res.text();
  if (Buffer.byteLength(text) > 3_000_000) throw new Error('Live catalogue oversized');
  const d = JSON.parse(text);
  const generated = Date.parse(d.generatedAt);
  if (d.version !== 1 || !Array.isArray(d.listings) || !d.advertiser || new Set(d.listings.map(x => x.id)).size !== d.listings.length ||
      !Number.isFinite(generated) || generated > +now || +now - generated > 48 * 3_600_000) throw new Error('Live catalogue invalid or stale');
  return d;
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** One JPEG grid per listing: each usable frame letterboxed, labelled with its website index, size and aspect. */
export async function contactSheet(frames, { columns = 3, cell = 480, label = 44 } = {}) {
  const rows = Math.ceil(frames.length / columns);
  const composites = [];
  for (const [i, f] of frames.entries()) {
    const left = (i % columns) * cell, top = Math.floor(i / columns) * (cell + label);
    composites.push({ input: await sharp(f.buffer).resize(cell, cell, { fit: 'contain', background: '#111111' }).jpeg().toBuffer(), left, top });
    const text = `#${f.index}  ${f.width}x${f.height}  ${(f.width / f.height).toFixed(2)}  ${String(f.alt?.en ?? '').slice(0, 34)}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${label}"><rect width="100%" height="100%" fill="#f5f1ea"/><text x="8" y="28" font-family="DejaVu Sans, sans-serif" font-size="17" fill="#111111">${esc(text)}</text></svg>`;
    composites.push({ input: Buffer.from(svg), left, top: top + cell });
  }
  return sharp({ create: { width: columns * cell, height: rows * (cell + label), channels: 3, background: '#ffffff' } })
    .composite(composites).jpeg({ quality: 82 }).toBuffer();
}
```

- [ ] **Step 4: Implement the draft CLI**

Create `scripts/social/draft-property-reviews.mjs`:

```js
#!/usr/bin/env node
// Drafts photo/caption reviews for in-scope listings: usable frames, one contact sheet per listing,
// drafts.json with caption previews. Never writes the review register, never uploads anything.
// Usage: node scripts/social/draft-property-reviews.mjs --out NEW_DIR [--ids BONA-001,BONA-022]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { SITE, imageUrl, sha256, fingerprint, advertiserFingerprint, policyRules, eligibility, captionFor } from './lib/property-daily.mjs';
import { frameProblem, contactSheet, disclosuresFor, liveCatalogue } from './lib/property-review.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function parseArgs(argv) {
  const a = { out: null, ids: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--ids') a.ids = String(argv[++i] ?? '').split(',').filter(Boolean);
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  if (!a.out) throw new Error('Usage: draft-property-reviews.mjs --out NEW_DIR [--ids BONA-001,BONA-022]');
  return a;
}
export async function main(argv = process.argv.slice(2), { fetchImpl = fetch, now = new Date(), root = ROOT, log = console.log } = {}) {
  const args = parseArgs(argv);
  const out = path.resolve(args.out);
  if (fs.existsSync(out)) throw new Error('Choose a new output directory; earlier drafts are preserved');
  const rules = policyRules(readJson(path.join(root, 'marketing/daily/property-policy.json')), now);
  const reviews = readJson(path.join(root, 'marketing/daily/property-reviews.json'));
  const live = await liveCatalogue(fetchImpl, now);
  const wanted = args.ids ? new Set(args.ids) : null;
  if (wanted) for (const id of wanted) if (!live.listings.some(p => p.id === id)) throw new Error(`${id} is not in the live catalogue`);
  const inScope = p => p.status === 'available' && rules.countries.includes(p.location?.countryCode) && rules.categories.includes(p.category);
  const listings = live.listings.filter(p => inScope(p) && (wanted ? wanted.has(p.id) : eligibility(p, reviews[p.id], live.advertiser, now, rules).length > 0));
  fs.mkdirSync(out, { recursive: true });
  const drafts = { generatedAt: now.toISOString(), catalogueGeneratedAt: live.generatedAt, advertiserSha256: advertiserFingerprint(live.advertiser), listings: {} };
  for (const p of listings) {
    const frames = [], rejected = [];
    for (const [i, im] of (p.images ?? []).slice(0, 10).entries()) {
      const index = i + 1;
      let url;
      try { url = imageUrl(im.src); } catch { rejected.push({ index, why: 'unapproved_source' }); continue; }
      try {
        const res = await fetchImpl(url, { redirect: 'error', headers: { 'User-Agent': 'BonaPropertyPublisher/1.0' }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) { rejected.push({ index, why: `http_${res.status}` }); continue; }
        const buffer = Buffer.from(await res.arrayBuffer());
        const meta = await sharp(buffer).metadata();
        const why = frameProblem({ contentType: res.headers.get('content-type'), bytes: buffer.length, width: meta.width, height: meta.height });
        if (why) { rejected.push({ index, why, width: meta.width, height: meta.height }); continue; }
        const file = path.join(p.id, `${index}.jpg`);
        fs.mkdirSync(path.join(out, p.id), { recursive: true });
        fs.writeFileSync(path.join(out, file), buffer);
        frames.push({ index, url, sha256: sha256(buffer), width: meta.width, height: meta.height, alt: im.alt, file, buffer });
      } catch (e) { rejected.push({ index, why: `fetch_failed: ${String(e.message).slice(0, 60)}` }); }
    }
    let sheet = null;
    if (frames.length) { sheet = `${p.id}.jpg`; fs.writeFileSync(path.join(out, sheet), await contactSheet(frames)); }
    const preview = { legalDisclosures: disclosuresFor(p), photos: [{ kind: p.category === 'off-plan' ? 'render' : 'photograph' }] };
    drafts.listings[p.id] = { title: p.title, category: p.category, type: p.type ?? null, city: p.location?.city?.en ?? null,
      factsSha256: fingerprint(p), page: `${SITE}/properties/${p.slug}/`, sheet, usable: frames.length,
      frames: frames.map(({ buffer, ...f }) => f), rejected, captionPreview: captionFor(p, live.advertiser, preview) };
    log(`${p.id.padEnd(10)} ${String(frames.length).padStart(2)} usable / ${(p.images ?? []).length}  ${p.title?.en ?? ''}`);
  }
  fs.writeFileSync(path.join(out, 'drafts.json'), JSON.stringify(drafts, null, 2) + '\n');
  log(`Drafted ${listings.length} listing(s) into ${out}; nothing approved, nothing uploaded.`);
  return drafts;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
```

- [ ] **Step 5: Implement the approve CLI**

Create `scripts/social/approve-property-review.mjs`:

```js
#!/usr/bin/env node
// Writes approved reviews into marketing/daily/property-reviews.json for frames a reviewer has looked at.
// Re-reads the live catalogue, refuses anything changed since drafting or not eligible under the policy,
// and leaves an identical existing review untouched.
// Usage: node scripts/social/approve-property-review.mjs --drafts DIR/drafts.json --reviewer "who looked" --select BONA-022:1,3,4 [--select …]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fingerprint, policyRules, eligibility } from './lib/property-daily.mjs';
import { buildReview, liveCatalogue, parseSelection, sameReview } from './lib/property-review.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function parseArgs(argv) {
  const a = { drafts: null, reviewer: null, select: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--drafts') { a.drafts = v; i++; }
    else if (k === '--reviewer') { a.reviewer = v; i++; }
    else if (k === '--select') { a.select.push(v); i++; }
    else throw new Error(`Unknown argument ${k}`);
  }
  if (!a.drafts || !a.reviewer?.trim() || !a.select.length) throw new Error('Usage: approve-property-review.mjs --drafts DIR/drafts.json --reviewer "who looked" --select BONA-ID:1,2,3 [--select …]');
  return a;
}
export async function main(argv = process.argv.slice(2), { fetchImpl = fetch, now = new Date(), root = ROOT, log = console.log } = {}) {
  const args = parseArgs(argv);
  const drafts = readJson(args.drafts);
  const rules = policyRules(readJson(path.join(root, 'marketing/daily/property-policy.json')), now);
  const registerPath = path.join(root, 'marketing/daily/property-reviews.json');
  const register = readJson(registerPath);
  const live = await liveCatalogue(fetchImpl, now);
  const refused = [];
  let written = 0, unchanged = 0;
  for (const raw of args.select) {
    let sel;
    try { sel = parseSelection(raw); } catch (e) { refused.push(e.message); continue; }
    const p = live.listings.find(x => x.id === sel.id), d = drafts.listings?.[sel.id];
    if (!p || !d) { refused.push(`${sel.id}: not in the live catalogue or the drafts`); continue; }
    if (d.factsSha256 !== fingerprint(p)) { refused.push(`${sel.id}: listing changed since drafting — draft it again`); continue; }
    let review;
    try { review = buildReview(p, live.advertiser, d.frames, sel, { reviewedAt: now.toISOString(), reviewer: args.reviewer.trim() }); }
    catch (e) { refused.push(e.message); continue; }
    const why = eligibility(p, review, live.advertiser, now, rules);
    if (why.length) { refused.push(`${sel.id}: ${why.join(', ')}`); continue; }
    if (sameReview(register[sel.id], review)) { unchanged++; continue; }
    register[sel.id] = review; written++;
  }
  if (written) {
    const sorted = Object.fromEntries(Object.keys(register).sort().map(k => [k, register[k]]));
    fs.writeFileSync(registerPath, JSON.stringify(sorted, null, 2) + '\n');
  }
  log(`Approved ${written}, unchanged ${unchanged}, refused ${refused.length}.`);
  for (const r of refused) log(`  refused ${r}`);
  return { written, unchanged, refused };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().then(r => { if (r.refused.length) process.exitCode = 1; }, e => { console.error(e.message); process.exitCode = 1; });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test scripts/test/property-review.test.mjs` then `npm test`. Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/social/lib/property-review.mjs scripts/social/draft-property-reviews.mjs scripts/social/approve-property-review.mjs scripts/test/property-review.test.mjs
git commit -m "social: draft and approve property photo reviews — contact sheets, frame rules, eligibility-checked register writes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Documentation

**Files:**
- Rewrite: `docs/daily-property-publishing.md`
- Modify: `marketing/daily/README.md`
- Create (review fix): `scripts/test/daily-property-doc.test.mjs`

- [ ] **Step 1: Rewrite the operator doc**

Replace the whole content of `docs/daily-property-publishing.md` with:

````markdown
# Daily property posts

One Instagram post and one Facebook post a day at 20:30 Asia/Riyadh, each a carousel of three
to six reviewed images of one current website property. The existing `bona-daily@instagram`
and `bona-daily@facebook` timers run it; there is no other timer.

## Policy (`marketing/daily/property-policy.json`)

- **Ad-licence waiver (owner, 2026-10-05).** The owner instructed daily posting of current
  Saudi website properties without per-listing REGA ad-licence numbers and accepted the stated
  exposure. `adLicence.requirement` is `"waived"` with `by` and `on`; a waiver missing either,
  or dated in the future, stops every run. Setting it back to `"required"` restores the
  licence gate exactly as it was. Every caption still carries the advertiser's name, FAL number
  and phone, and a listing's ad-licence line appears automatically once `licence.adNumber` is set.
- **Scope:** `countries: ["SA"]`, `categories: ["buy","rent","off-plan"]`. International
  listings are out.
- **Renders:** `renders: "off-plan-only"`. Developer renders may illustrate off-plan projects
  only, and the caption then says so in both languages. Ready stock needs real photographs.
- **Reviews** stay valid for `reviewValidDays` (90) while the listing facts, the advertiser and
  the caption are unchanged; any change invalidates a review at once.
- **Rotation:** one property per channel per day, oldest first, 30-day repeat interval. When no
  property is eligible the run falls through to an approved reviewed pack in `marketing/daily/`
  if one is due; otherwise it records a skip. Runs before 20:30 or from 23:00 do nothing, and
  there is no backfill.

## Admitting properties (`marketing/daily/property-reviews.json`)

1. **Draft:** `node scripts/social/draft-property-reviews.mjs --out NEW_DIR` (or add
   `--ids BONA-001,BONA-022`). It reads the live catalogue, downloads up to ten images for each
   in-scope listing that is not currently eligible (no review yet, or one that has expired or no
   longer matches), keeps the ones that meet the publisher's rules (JPEG, at most 8 MB, at least
   1080×720, aspect 0.8–1.91), and writes one contact sheet per listing plus `drafts.json` with a
   caption preview. It never writes the register and never uploads.
2. **Look** at every contact sheet, and at full frames where detail matters. Leave out other
   brokers' watermarks, people, price or text banners, floor plans, duplicates and anything that
   does not show this property. Put the strongest frame first.
3. **Approve:** `node scripts/social/approve-property-review.mjs --drafts NEW_DIR/drafts.json --reviewer "<who looked>" --select BONA-022:1,3,4 --select BONA-001:2,5,1,7`.
   Frames default to `render` for off-plan listings and `photograph` otherwise; a `p` or `r`
   suffix overrides one frame. Selected frames must sit within 15% of the first frame's aspect
   ratio because Instagram crops a carousel to its first frame. The script re-reads the live
   catalogue, refuses anything changed since drafting or not eligible, and leaves an identical,
   still-valid review untouched; an expired one is renewed.
4. **Commit** the register through a PR. The publisher reads it from `origin/main`.

Disclosures written with every review: prices are asking prices and may change; details,
condition and services are confirmed at viewing; for off-plan, delivery dates and
specifications are per the developer. Nothing else is claimed.

## Publication safety

- Each channel re-checks the account identity, downloads the reviewed images and compares their
  SHA-256 with the review, and re-reads the live catalogue just before upload. Any change stops
  that run.
- A per-channel lock, the existing ledgers and a durable `intent` record prevent duplicates. A
  failed or unconfirmed send records `uncertain` and stops automatic retries on that channel.
- **Reconciling an uncertain attempt.** An `intent` or `uncertain` line in
  `~/bona-data/daily/property.jsonl` that no later line settles keeps that channel blocked.
  Settle it by appending lines, never by deleting any:
  1. Work only while no run holds `~/bona-data/daily/.property-<channel>.lock`. The file names the
     run's process id; an `intent` under a live run is an attempt still in progress.
  2. Look for the post with an authenticated API read of the account's Instagram media or the
     Page's Facebook posts that covers the attempt time, and match it on caption and images. Only
     such a read shows the post is absent: a failed or partial query is not absence, and a wrong
     `confirmed-not-published` lets a later run post again, as soon as the same evening.
  3. Append one line to `property.jsonl`, with `date`, `id` and `listingId` copied from the
     attempt's `intent` line. If the post exists:
     `{"channel":"instagram","date":"YYYY-MM-DD","id":"bona-daily-ig-YYYY-MM-DD","listingId":"BONA-…","status":"published","mediaId":"…","permalink":"…","evidence":"<what was checked>","at":"<publication time, ISO>"}`
     or
     `{"channel":"facebook","date":"YYYY-MM-DD","id":"bona-daily-fb-YYYY-MM-DD","listingId":"BONA-…","status":"published","postId":"…","evidence":"<what was checked>","at":"<publication time, ISO>"}`.
     Its `at` is the provider's publication time; the 30-day repeat interval counts from it. If
     the post is absent:
     `{"channel":"instagram","date":"YYYY-MM-DD","id":"bona-daily-ig-YYYY-MM-DD","listingId":"BONA-…","status":"confirmed-not-published","evidence":"<what was checked>","at":"<now, ISO>"}`
     or
     `{"channel":"facebook","date":"YYYY-MM-DD","id":"bona-daily-fb-YYYY-MM-DD","listingId":"BONA-…","status":"confirmed-not-published","evidence":"<what was checked>","at":"<now, ISO>"}`.
     Only a line written after the attempt settles it.
  4. If the post exists, also append the same `published` line to `~/bona-data/ig/published.jsonl`
     or `~/bona-data/fb/published.jsonl`, unless that ledger already has a `published` line for
     the id; Instagram stays blocked without it. If it is absent and
     `~/bona-data/ig/published.jsonl` has a `publishing` line for the id, append
     `{"id":"bona-daily-ig-YYYY-MM-DD","date":"YYYY-MM-DD","status":"error","detail":"<what was checked>","ts":"<now, ISO>"}`
     after it. Without that line Instagram stays blocked; with it, that date stays closed and
     Instagram posts again from the next day's slot.

## Monitoring

- `~/bona-data/daily/heartbeat-instagram.url` and `heartbeat-facebook.url` (mode 600, outside the
  repo) hold the Uptime Kuma push URLs of the monitors "Bona daily post — instagram" and
  "Bona daily post — facebook". A confirmed or already-recorded publication pushes `up`. The
  22:30 and 22:45 runs push `down` with the reason when the day still has no post, which reaches
  the owner's Telegram through the existing Kuma notification. The monitors also go down after
  26 hours without a push. A missing URL file or a failed push is logged and never fails a run.
- The Codex app automations `bona-daily-publishing-checks` (20:45, 21:45, 22:45) and
  `bona-weekly-social-replenishment` (Thursdays 10:00) also inspect this pipeline and report into
  their Codex chat. They are not part of this repository.

## Verification

```bash
( set -a; . ~/.secrets/bona-meta-graph.env; set +a; cd ~/bona-publish &&
  BONA_DAILY_TEST_NOW="$(TZ=Asia/Riyadh date +%F)T17:30:00Z" node scripts/social/daily-publish.mjs instagram --dry-run )
```

simulates today's 20:30 Riyadh slot (17:30Z) in the publisher's checkout with read-only provider
calls; run it again with `facebook`. The subshell keeps the Meta token out of your shell. A slot
that will post prints `Ready after read-only preflight: <entry id>, <listing id>; no post`. Also
normal: `Daily slot already published` once today's post is recorded, or, with no eligible
property, the skip JSON, then `No eligible property today; checking the reviewed daily pack.` and
`No daily content due …` (on a pack day, the pack's `Validated …; no publish` line instead).
Anything else means the slot would not post.

Runtime evidence: `~/bona-data/daily/property.jsonl`, `~/bona-data/ig/published.jsonl`,
`~/bona-data/fb/published.jsonl`, `~/bona-data/daily/alerts.jsonl`.

## Rollback

Set `adLicence.requirement` to `"required"` (or revert the waiver commit). The register is inert
under a licence requirement. Published posts and ledgers are untouched.

Regulatory note: Articles 3, 5 and 6 of https://www.uqn.gov.sa/decisions-and-regulations/authorities/4000857
(checked 2 October 2026) are why the licence gate was built; the waiver above is the owner's
recorded business decision.
````

- [ ] **Step 2: Point the pack README at the new flow**

In `marketing/daily/README.md`, replace the paragraph that starts `- Coordinator has created ACTIVE heartbeats, owned centrally (do not duplicate):` and ends `on unchanged state. These are agent workflows, not evidence that posts are already live.` with:

```markdown
- Since 2026-10-02 the timers run the property policy first (`docs/daily-property-publishing.md`).
  Since 2026-10-05 this reviewed pack is used only when no property is eligible and a pack day
  is due.
- Codex app automations, outside this repo, inspect and replenish this pipeline:
  `bona-weekly-social-replenishment` (Thursdays 10:00 Riyadh) and `bona-daily-publishing-checks`
  (20:45, 21:45, 22:45 Riyadh). They report into their Codex chat; they are not evidence that a
  post is live. Alerting to the owner's phone is the Uptime Kuma heartbeat described in
  `docs/daily-property-publishing.md`.
```

- [ ] **Step 3: Check and commit**

Run: `npm test` — Expected: all PASS (docs only).

```bash
git add docs/daily-property-publishing.md marketing/daily/README.md
git commit -m "docs: daily property posts under the owner's waiver — admission, reconciliation, monitoring

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Controller-only operations (not for implementer subagents)

These need live systems, secrets or judgement and are done by the controlling session.

- **O1 Merge lane B** into lane A (`git merge --no-ff feat/property-heartbeat-20261005`), run `npm test`.
- **O2 Uptime Kuma:** create push monitors "Bona daily post — instagram" / "— facebook" (interval 93600 s, retries 0, notification 1 = Telegram) through the Kuma API with `~/.secrets/uptime-kuma.env`; write the two push URLs to `~/bona-data/daily/heartbeat-<channel>.url` (mode 600); push one `up` from each to prove the path, then let the monitors run.
- **O3 Draft and review:** `draft-property-reviews.mjs --out <scratchpad>/drafts-20261005`; visual review of every contact sheet (workflow: reviewer per listing, adversarial second look per selection); `approve-property-review.mjs` with the agreed selections and an honest `--reviewer`; commit the register.
- **O4 Whole-branch review:** Claude (code-reviewer) and Codex (`codex exec --sandbox read-only -` with the diff on stdin); fix, re-review, record disagreements.
- **O5 Ship:** push, PR, squash merge, record the rollback commit; sync `~/bona-publish` with `ops/systemd/sync-publish-tree.sh`; run both channel dry runs from `~/bona-publish` with `BONA_DAILY_TEST_NOW=<today>T17:30:00Z`; expect `Ready after read-only preflight`.
- **O6 20:30 check:** ledgers and permalinks for both channels, Kuma monitors up; report to the owner.
