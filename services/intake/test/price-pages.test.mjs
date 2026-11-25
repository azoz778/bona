// Prices the text layer cannot read (owner's Jeddah Heights brochure, 2026-11-17): the PDF's font
// maps its digits to letters, so the page shows 270,425 and the text layer says "DIB,FDG". The
// pages that talk about a price are rendered for the model to read, and every number it reads off
// them still has to be confirmed on the page before it is published.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hasSubsidyWording, pageNeedsPriceRender, pricePagesToRender, MAX_PRICE_PAGES } from '../lib/price-pages.mjs';
import { execFileSync } from 'node:child_process';
import { checkListing, replaceMetaFor, writeInboxListing } from '../lib/listing.mjs';
import { compareEnrichment, dropMoneyText, processPdf, statesMoney } from '../lib/pipeline.mjs';
import { copyProblems } from '../lib/claude.mjs';
import { priceAppearsIn, printedInCurrency } from '../lib/price.mjs';
import { classifyRun, planBackfill } from '../lib/backfill.mjs';
import * as msg from '../lib/messages.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Verbatim from the brochure's text layer: Arabic presentation forms + the scrambled digits.
const PRICE_PAGE = [
  'اﻟﺴﻌﺮ ﳌﺴﺘﻔﻴﺪي اﻟﺪﻋﻢ', // السعر لمستفيدي الدعم
  'DIB,FDG ',
  'اﻟﺴﻌﺮ ﻟﻐﲑ ﻣﺴﺘﻔﻴﺪي اﻟﺪﻋﻢ', // السعر لغير مستفيدي الدعم
  'ECK,BCG',
].join('\n');
const LOCATION_PAGE = [
  'دﻗﺎﺋﻖ BH', // دقائق 17 — scrambled, but not a price
  'ﻣﺪﻳﻨﺔ اﳌﻠﻚ ﻋﺒﺪﷲ اﻟﺮﻳﺎﺿﻴﺔ',
].join('\n');

describe('pageNeedsPriceRender', () => {
  it('flags a price page whose digits are scrambled into letters', () => {
    assert.equal(pageNeedsPriceRender(PRICE_PAGE), true);
  });
  it('leaves a page with no price word alone, scrambled numbers or not', () => {
    assert.equal(pageNeedsPriceRender(LOCATION_PAGE), false);
    assert.equal(pageNeedsPriceRender('Five-bedroom villa, 450 sqm, sea view'), false);
  });
  it('leaves a price page alone when its price is readable', () => {
    assert.equal(pageNeedsPriceRender('السعر 1,250,000 ريال'), false);
    assert.equal(pageNeedsPriceRender('Price: SAR 4500000'), false);
    assert.equal(pageNeedsPriceRender('السعر ١٬٢٥٠٬٠٠٠ ريال'), false); // Arabic-Indic digits are readable
  });
  it('flags a price page that has no price-sized number at all', () => {
    assert.equal(pageNeedsPriceRender('الأسعار\nغرفة نوم 02\nدورة مياه 01'), true);
    assert.equal(pageNeedsPriceRender('Prices — see the table'), true);
  });
  it('a scrambled price wins over an unrelated readable number on the same page', () => {
    assert.equal(pageNeedsPriceRender(`${PRICE_PAGE}\n920032546`), true);
  });
  it('a phone number next to the price word does not make an unseparated scrambled price readable', () => {
    assert.equal(pageNeedsPriceRender('السعر\nDIBFDG\nللتواصل 920032546'), true);
  });
  it('a figure far from the price word does not count for it', () => {
    assert.equal(pageNeedsPriceRender('السعر\nDIBFDG\n.\n.\n.\n.\nالمساحة 1,250 م²'), true);
  });
  it('knows other ways a price is labelled', () => {
    assert.equal(pageNeedsPriceRender('قيمة الوحدة DIB,FDG'), true);
    assert.equal(pageNeedsPriceRender('SR DIB,FDG'), true);
  });
  it('every price line needs its own readable figure', () => {
    assert.equal(pageNeedsPriceRender('السعر 1,250,000 ريال\n.\n.\n.\n.\n.\nسعر الدفعة الأولى\nKLMNOP'), true);
  });
  it('knows the other ways a brochure says "subsidised"', () => {
    for (const t of ['السعر قبل الدعم 350,000 ريال', 'السعر بعد الدعم 270,425 ريال', 'السعر مع الدعم 270,425', 'سعر الوحدة المدعومة 270,425', 'Price after support SAR 270,425', 'Price for beneficiaries SAR 270,425']) {
      assert.equal(pageNeedsPriceRender(t), true, t);
    }
  });
  it('a Sakani logo with no price on the page is not a price page', () => {
    assert.equal(pageNeedsPriceRender('بالشراكة مع منصة سكني\nIn partnership with Sakani'), false);
  });
  it('round-3 cases: tables without a price word, wrapped labels, decimals, other labels', () => {
    assert.equal(pageNeedsPriceRender('لمستفيدي الدعم\n270,425\nلغير مستفيدي الدعم\n319,015'), true, 'a subsidy table needs no price word');
    assert.equal(pageNeedsPriceRender('قيمة\nالوحدة\nDIB,FDG'), true, 'a label wrapped over two lines');
    assert.equal(pageNeedsPriceRender('السعر\nDIBFDG\nالمساحة 123.456 م²'), true, 'a three-decimal area is not a price');
    assert.equal(pageNeedsPriceRender('القيمة البيعية DIB,FDG'), true);
    assert.equal(pageNeedsPriceRender('ثمن الوحدة\nDIBFDG'), true);
    assert.equal(pageNeedsPriceRender('المستحقين للدعم السكني 270,425'), true);
  });
  it('a VAT line is not a price word, and a spaced phone number is not a readable price', () => {
    assert.equal(pageNeedsPriceRender('ضريبة القيمة المضافة 15%'), false);
    assert.equal(pageNeedsPriceRender('السعر\nDIBFDG\nجوال 0555 123 456'), true);
  });
  it('always renders a page that prints prices for subsidy beneficiaries, readable or not', () => {
    assert.equal(pageNeedsPriceRender('السعر لمستفيدي الدعم 270,425 ريال\nالسعر لغير مستفيدي الدعم 319,015 ريال'), true);
    assert.equal(hasSubsidyWording('Price for Sakani beneficiaries'), true);
    assert.equal(hasSubsidyWording('مجمع سكني متكامل'), false, '"residential" alone is not subsidy wording');
  });
});

// r3 #1 — THE money rule for free text (unit-model rooms / availability, amenities / nearby / warranties items).
// One table: every MONEY case is dropped from the site and the brochure, every NOT MONEY case survives. Change the
// rule only by changing this table.
describe('r3 #1: the free-text money rule (statesMoney) — the whole contract in one table', () => {
  const MONEY = [
    'Price 4500', 'Monthly rent 4500', 'Annual rent 9500', 'Booking 5000', 'Starting from 4500', 'Rent 8500 per month',
    'السعر 4500', 'إيجار شهري 4500', 'حجز 5000', 'Down payment 50 000', 'Deposit 750', 'Club fee SAR 1,500',
    // the same rules, other spellings
    'بسعر 4500', 'الإيجار 4500', 'دفعة مقدمة 5000', 'عربون 750', 'رسوم الخدمة 25 للمتر', 'أقساط 1200', 'Service charge 25 per sqm',
    'Booking fee 500, refundable', 'Cost 3000', '1,500 riyals', '$ 750', 'Buildings G–P, 419,994', 'Down payment 50\u00a0000', 'Down payment 50\u202f000',
    'from 4.5m', '1.2 million', '3 ملايين', '5 آلاف', 'Parking for 1,200 cars',
    // r5 #1: a year-like figure is cut only from the "from" test; a comma never splits a clause; a code glued to its
    // figure; Arabic words end at a letter, not at Arabic punctuation; the فـ clitic.
    'SAR 2000', '2000 ريال', 'Monthly rent: SAR 1900', 'Rent 2000 SAR/month', 'رسوم الخدمة 2000 ريال', 'Booking amount 2000 riyals',
    'Price 2000', 'Down payment 2000', 'عربون 2000',
    'Down payment, 4500', 'Deposit, 750', 'عربون، 5000', 'Monthly installments, 3500',
    '4500SAR', '4500SR', 'فـحجز 5000', 'Club fee SAR 2000',
    // r6 #1 (B11): the r5 #1 rules pinned — Arabic punctuation ends a word, a code glued to its figure.
    'ملاحظة،عربون 5000', '؛رسوم 2000', 'SAR4500', 'Club SAR4500',
    // r6 #1 (B1): a distance word clears a solid-k figure only in its own comma sub-clause.
    'Apartments from 850k, walking distance to the mall', 'Club membership 5k, near the jogging track',
    // r6 #1 (B2a): the currency is looked for before measures and durations are cut out.
    'Upper floors, SAR 4.5 M', 'SR 4.5 M', 'Rent SAR 4,500 month', 'SAR 45,000 year',
    // r6 #1 (B2b, Codex r5 #1): a dotted mark, "approx.", "incl." or "excl." never ends the sentence; the marks price.mjs knows.
    'ر. س 2000', '2000 ر. س', 'ر.س. 2000', 'ر. س. 2000', 'ر. ع 750', 'S.R. 2000', 'S.R 2000', 'SR. 750', 'Club fee S.R. 750',
    'Deposit approx. 750', 'Rent incl. VAT 4500', 'Price excl. VAT 4500', 'رسوم الخدمة ر. س 2000', 'عربون ر. س 5000',
    'د.إ 2000', 'د. إ 2000', 'ر.ق 2000', 'د.ك 750', 'Dhs 750', '750 Dhs',
    // r6 #1 (B3): a rent period is a price word; a country between figure and currency; "،" groups digits; tatweel.
    'Floors 1–3, 4500 per month', 'الأدوار 1–3، 4500 شهرياً', 'Club membership 750 Saudi Riyals a year',
    'Club membership 750 Saudi Riyals', 'الأدوار العليا ٤،٥٠٠،٠٠٠', 'متاح الآن، الـحجز 5000', 'السعـر 2000',
    // r7 #2 (Codex r6 #3): Arabic punctuation (، ؛ ؟ ٪ ۔) and digits before a dotted mark end a word, like a space.
    'ملاحظة،ر. س 2000', 'ملاحظة؛ر. س 2000', 'ملاحظة،ر.س. 2000', '٢٠٠٠ر. س', 'عربون،ر. س 750',
    'ملاحظة؟ر. س 2000', 'ملاحظة٪ر. س 2000', 'ملاحظة۔ر. س 2000',
    'ملاحظة،ر. ع 2000', 'ملاحظة،ر. ق 2000', 'ملاحظة،د. إ 2000', 'ملاحظة،د. ك 2000',
    // r7 #2 (Claude r6 B5c): the marks price.mjs MARKS reads — undotted "رس" / "ر س", the Farsi-yeh ریال, "US$" after a figure.
    'رس 2000', '2000 ر س', 'ریال 2000', '2000 US$',
    // r7 #4 (Claude r6 B5a): a distance word clears a solid-k figure only when it comes within two words AFTER that
    // figure, in the same sub-clause — and a dash (– — -) or a bracket ends a sub-clause too, like a comma.
    'From 850k – walking distance to the beach', '850k (walking distance…)', 'Studios 850k near the jogging track',
    'Apartments from 850k — walking distance to the mall', 'Apartments from 850k - walking distance to the mall',
    'Apartments from 850k [walking distance to the mall]', 'Units 850k near the walking track',
    'Apartments from 850k and a short walk to the mall', 'شقق من 850k - ممشى قريب', 'Golf membership 5k – next to the walking trail',
    'A 5k jogging track and membership 850k', 'Walking track 2.5k',
    // r7 #4 (Claude r6 B5b): a dot, then a space, then a digit never ends the sentence ("min. 2000", "est. 750", "... 750").
    'Booking fee min. 2000', 'Deposit est. 750', 'Deposit... 750', 'Down payment max. 5000', 'Service fee avg. 1500',
    'Deposit e.g. 750', 'العربون... 750', 'العربون... ٧٥٠',
    // r7 #4 (Codex r6 #8, not fixed): the leaks a narrower comma split or a bounded د.إ would reopen.
    'Club membership 5k,5 min walk', 'Club membership 2000 د.إسنوياً',
    // r7 #5 (Claude r6 B1b / B8): every rent-period wording of the one shared list, English and Arabic, pinned alone.
    'Floors 1–3, 4500 per year', 'Floors 1–3, 4500 per annum', 'Floors 1–3, 4500 per yr', 'Floors 1–3, 4500 per mo',
    'Floors 1–3, 4500 monthly', 'Floors 1–3, 4500 yearly', 'Floors 1–3, 4500 annually', 'Floors 1–3, 4500 a month',
    'Floors 1–3, 4500 a year', 'Floors 1–3, 4500 every month', 'Floors 1–3, 4500 every year', 'Floors 1–3, 4500 p.a.',
    'Floors 1–3, 4500 p.a', 'Floors 1–3, 4500/month', 'Floors 1–3, 4500 / year', 'Floors 1–3, 4500/mo', 'Floors 1–3, 4500/yr',
    'الأدوار 1–3، 4500 شهري', 'الأدوار 1–3، 4500 شهرية', 'الأدوار 1–3، 4500 شهريه', 'الأدوار 1–3، 4500 شهريا', 'الأدوار 1–3، 4500 شهريًا',
    'الأدوار 1–3، 4500 سنوي', 'الأدوار 1–3، 4500 سنوية', 'الأدوار 1–3، 4500 سنويه', 'الأدوار 1–3، 4500 سنوياً',
    'الأدوار 1–3، 4500 في الشهر', 'الأدوار 1–3، 4500 في السنة', 'الأدوار 1–3، 4500 في العام', 'الأدوار 1–3، 4500 بالشهر',
    'الأدوار 1–3، 4500 بالسنة', 'الأدوار 1–3، 4500 للشهر', 'الأدوار 1–3، 4500 للسنة', 'الأدوار 1–3، 4500 كل شهر',
    'الأدوار 1–3، 4500 كل سنة', 'الأدوار 1–3، 4500 / شهر', 'الأدوار 1–3، 4500/سنة',
    // r8 #2 (Codex r7 #4): a tight dotted mark glued to the word before it is a mark when a figure follows.
    'الاشتراكر.س 2000', 'الاشتراكر.س2000', 'الاشتراكر.س. 2000', 'الاشتراكر.ع 750', 'الاشتراكر.ق 750', 'الاشتراكد.إ 750',
    'الاشتراكد.ك 750',
    // r8 #4 (Claude r7 NB1): one dot may stand between a Latin code and its figure, as in the name and copy guards.
    'Gym membership Dhs. 4500', 'SAR.750', 'USD. 750',
    // r8 #4 (Codex r7 NB2): a spaced "p. a." is one rent period, never a sentence end between "p." and "a".
    'Floors 1–3, 4500 p. a.', 'Floors 1–3, 4500 p. a', 'Floors 1–3, 4500 P. A.', 'Club membership 4500 p.  a.',
    // r8 #4 (Codex r7 #7 = Claude r7 NB6, not fixed): a known over-drop, kept on the TAQEEM-safe side. A dot before a
    // figure joins two sentences (r7 #4); narrowing that join reopens the two leaks after it.
    'No booking required. 3 tennis courts.', 'Deposit required. 75', 'Down payment required. 10% on signing',
    // r8 #5 (Claude r7 B1b): the short-stay periods of the one shared list, English (bare "annual" right after its
    // figure) and Arabic, and the ه / ى / ی spellings (ى and ی fold to ي first).
    'Floors 1–3, 4500 per night', 'Floors 1–3, 4500 nightly', 'Floors 1–3, 4500/night', 'Floors 1–3, 4500 per week',
    'Floors 1–3, 4500 weekly', 'Floors 1–3, 4500 / week', 'Floors 1–3, 4500 pa', 'Floors 1–3, 4500 p/a', 'Floors 1–3, 4500/annum',
    'Floors 1–3, 4500 pcm', 'Floors 1–3, 4500 annual',
    'الأدوار 1–3، 4500 يوميا', 'الأدوار 1–3، 4500 يومياً', 'الأدوار 1–3، 4500 يوميًا', 'الأدوار 1–3، 4500 في اليوم',
    'الأدوار 1–3، 4500 لليلة', 'الأدوار 1–3، 4500 لليله', 'الأدوار 1–3، 4500 أسبوعيا', 'الأدوار 1–3، 4500 اسبوعياً',
    'الأدوار 1–3، 4500 في السنه', 'الأدوار 1–3، 4500 للسنه', 'الأدوار 1–3، 4500 بالسنه', 'الأدوار 1–3، 4500 كل سنه',
    'الأدوار 1–3، 4500 / سنه', 'الأدوار 1–3، 4500 سنوى', 'الأدوار 1–3، 4500 شهرى', 'الأدوار 1–3، 4500 سنوی', 'الأدوار 1–3، 4500 شهری',
    'الأدوار 1–3، 4500 فى الشهر', 'إیجار 4500',
  ];
  const NOT_MONEY = [
    'Handover starts 2027', 'No maintenance fees for 2 years', 'ضمان 10 سنوات … مقدم من المطور', 'خدمات مقدمة … 24 ساعة',
    'رسومات هندسية', 'Area 15,000 sq. m', '3 bedrooms, 2 bathrooms', 'A 5k jogging track',
    // the same rules, other spellings
    'Area 15,000 sq m', 'Plot 1,200 m²', '120 sqm', 'المساحة 1,500 م²', '15 km to the airport', 'Villa 15m frontage', 'Beach 500m away',
    'King Abdulaziz Airport — 15 minutes', 'Mall — 1.2 million visitors a year', 'Structure — 10 years', 'خدمة 24 ساعة',
    'Gym', 'رسومات معمارية لكل نموذج', 'Living room 4.2 x 5.1 m', 'Built in 1998',
    // r6 #1: a dotted mark is a mark only where its letters stand alone.
    'ر. سعيد', 'ر. سعيد 2000', 'الدار. سعر الوحدة', 'د. إبراهيم 2000',
    // r7 #2: after Arabic punctuation too — and a vowel mark is part of the word before ("مُر.").
    '،د. إبراهيم', 'الدور 2،د. إبراهيم', '،ر. سعيد 2000', 'مُر. سعيد 2000',
    // r7 #4: a distance word one or two words after the k-figure, in its sub-clause, is a distance; a dot before a
    // figure joins two sentences, which still state no money here.
    'A 5k fun run', 'A 5k jogging track (lit at night)', '5k run – every Friday', 'Area 120 sqm. 3 bedrooms, 2 bathrooms',
    'Ground to sixth floor. 2 lifts',
    // r8 #2: a glued tight pair with no figure right after it is a word; a spaced pair after a letter is a sentence end.
    'مُر.سعيد 2000', 'الدار. س 2: هل يوجد موقف؟',
    // r8 #4: the dot before a figure follows a Latin CODE only — after a letter or a currency word it ends a sentence;
    // only a standalone "p." joins a spaced "a".
    'Tower B. 12 floors', 'Quoted in US dollars. 2027 handover', 'Gym on the top floor. A pool with 2 lanes', 'Step. A 3 bedroom plan',
    // r8 #5: bare "annual" before a word is no period, "pa" only a word of its own, and ى folds to no period word.
    'Annual maintenance — 2 visits', 'Spa with 2 pools', 'مستوى 2 من المواقف',
  ];
  it('MONEY', () => { for (const t of MONEY) assert.equal(statesMoney(t), true, t); });
  it('NOT MONEY', () => { for (const t of NOT_MONEY) assert.equal(statesMoney(t), false, t); });
});

// r6 #2 (Claude r5 B4, Codex r5 #1b/c) — the model-NAME guard (dropMoneyText's `name`): a currency code glued to its
// figure, and a reading's price in a scaled form — trailing zeros, under a million, "4500K", an Arabic comma after.
describe('r6 #2: the model-name guard — glued currency codes and scaled reading prices', () => {
  const nameOf = (en, ar, figures) => dropMoneyText({ models: [{ name: { en, ar } }] }, { figures }).name;
  it('a currency code glued to its figure refuses the name, whatever the figure', () => {
    for (const en of ['Studio 4500SAR', 'Studio SAR4500', 'Villa 1,250,000SAR']) assert.equal(nameOf(en, 'نموذج', []), 'models[0].name', en);
  });
  it('every mark the money rule reads refuses the name too: S.R, Dhs, pounds, ر.ق, د.إ, د.ك (r6 verifier)', () => {
    for (const [en, ar] of [
      ['Villa S.R. 4500', 'نموذج'], ['Villa S.R 4500', 'نموذج'], ['Studio Dhs 4500', 'نموذج'], ['Studio 4500Dhs', 'نموذج'],
      ['Studio 4500 pounds', 'نموذج'], ['Studio', 'نموذج ر.ق 2000'], ['Studio', 'نموذج د.إ 2000'], ['Studio', 'نموذج د. ك 2000'],
    ]) assert.equal(nameOf(en, ar, []), 'models[0].name', `${en} / ${ar}`);
    // the letters standing alone: "د. إبراهيم" is a name, as in the money rule.
    assert.equal(nameOf('Villa Ibrahim', 'فيلا د. إبراهيم 2', []), null);
  });
  it('a reading price as a scaled token refuses the name: trailing zeros, under a million, K, an Arabic comma after it', () => {
    for (const [en, ar, n] of [
      ['Penthouse 4.50m', 'بنتهاوس', 4500000], ['Townhouse 0.95m', 'تاون هاوس', 950000], ['Penthouse 4500K', 'بنتهاوس', 4500000],
      ['Penthouse', 'بنتهاوس ٤٫٥ مليون، إطلالة', 4500000],
    ]) assert.equal(nameOf(en, ar, [n]), 'models[0].name', `${en} / ${ar}`);
  });
  it('"Villa 15m" with no 15,000,000 in the reading, and the 8 real W023 names, are names', () => {
    assert.equal(nameOf('Villa 15m', 'فيلا 15م', [4500000]), null);
    // enrich-dry6/work/ai.json: the names and every price the reading carries (models, Sakani, headline).
    const W023 = [
      ['Lulu 2', 'نموذج لؤلؤ 2', 319015, 270425], ['Nawras 2', 'نموذج نورس 2', 419994, 356024], ['Saif 2', 'نموذج سيف 2', 491819, 416910],
      ['Saif 3', 'نموذج سيف 3', 511615, 433690], ['Marafi 3', 'نموذج مرافئ 3', 593719, 503288], ['Zumurrud 2', 'نموذج الزمرد 2', 673245, 559261],
      ['Fairouz 1', 'نموذج الفيروز 1', 636245, 519928], ['Kahraman 2', 'نموذج كهرمان 2', 752914, 625442],
    ];
    const figures = W023.flatMap(([, , p, s]) => [p, s]);
    for (const [en, ar] of W023) assert.equal(nameOf(en, ar, figures), null, en);
  });
});

// r7 #2 (Claude r6 B3 / B5c, Codex r6 #3) — ONE currency-mark list (price.mjs MONEY_MARKS) for the guards that keep
// money OUT of the text: the free-text money rule, the model-name guard and the listing-copy guard read every mark
// price.mjs MARKS reads (MARKS decides a confirmed figure's currency; a mark these guards miss is published). A row per mark.
describe('r7 #2: one currency-mark list — every guard reads every mark price.mjs MARKS reads', () => {
  const MARKS_READ = [
    // codes
    'SAR', 'SR', 'S.R', 'S.R.', 'AED', 'Dh', 'Dhs', 'USD', 'US$', 'EUR', 'GBP', 'OMR', 'QAR', 'KWD', 'BHD', 'EGP', 'JOD', 'TRY', 'CHF',
    'CAD', 'AUD', 'INR', 'PKR', 'CNY', 'JPY', 'RUB', 'BGN', 'HRK', 'TL', 'A$', 'HK$', 'kn',
    // words
    'riyals', 'riyal', 'rials', 'Saudi Riyals', 'omani rials', 'dirhams', 'dirham', 'dollars', 'euros', 'pounds', 'pounds sterling', 'sterling',
    // Arabic names and abbreviations
    'ريال', 'ریال', 'ريالات', 'ريال سعودي', 'ريال عماني', 'ريال قطري', 'درهم', 'دولار', 'يورو', 'جنيه', 'دينار', 'ليرة', 'ليره', 'إسترليني', 'استرليني',
    'ر.س', 'ر.س.', 'ر. س', 'ر س', 'رس', 'ر.ع', 'ر. ع', 'ر ع', 'ر.ق', 'ر. ق', 'رق', 'د.إ', 'د. إ', 'د إ', 'د.ك', 'د. ك', 'د ك',
    // symbols
    '$', '€', '£', '﷼', '⃁', '₺', 'лв',
  ];
  const nameOf = (en, ar) => dropMoneyText({ models: [{ name: { en, ar } }] }, { figures: [] }).name;
  it('the list above is what price.mjs MARKS reads: beside 750, a SAR mark makes it SAR, any other makes it never a bare figure', () => {
    const marksRead = (t) => printedInCurrency(t, 750, 'SAR', { bareCounts: false }) || !printedInCurrency(t, 750, 'SAR', { bareCounts: true });
    assert.equal(marksRead('Note 750'), false, 'a bare figure');
    for (const m of MARKS_READ) for (const t of [`Note 750 ${m}`, `Note ${m} 750`]) assert.ok(marksRead(t), t);
  });
  it('the free-text money rule (statesMoney) reads each one beside a figure, before or after it, in either language', () => {
    for (const t of ['Note 750', 'ملاحظة 750']) assert.equal(statesMoney(t), false, t);
    for (const m of MARKS_READ) {
      for (const t of [`Note ${m} 750`, `Note 750 ${m}`, `ملاحظة ${m} 750`, `ملاحظة 750 ${m}`]) assert.equal(statesMoney(t), true, t);
    }
  });
  it('the model-name guard refuses each one beside a figure, in either name', () => {
    for (const m of MARKS_READ) {
      for (const [en, ar] of [[`Studio ${m} 4500`, 'نموذج'], [`Studio 4500 ${m}`, 'نموذج'], ['Studio', `نموذج ${m} 4500`], ['Studio', `نموذج 4500 ${m}`]]) {
        assert.equal(nameOf(en, ar), 'models[0].name', `${en} / ${ar}`);
      }
    }
  });
  it('the name guard: Arabic punctuation before ر.ق / د.إ / د.ك ends a word too (Codex r6 #3); "د. إبراهيم" stays a name', () => {
    for (const ar of ['نموذج أ،د. إ 2000', 'نموذج أ،ر. ق 2000', 'نموذج أ؛د. ك 2000']) assert.equal(nameOf('Studio', ar), 'models[0].name', ar);
    for (const ar of ['فيلا،د. إبراهيم 2', 'فيلا د. إبراهيم 2']) assert.equal(nameOf('Villa Ibrahim', ar), null, ar);
  });
  it('the listing-copy guard (copyProblems) refuses each one beside a price, in English and in Arabic copy', () => {
    for (const m of MARKS_READ) {
      for (const [en, ar] of [[`Townhouses from 650,000 ${m}.`, `تاون هاوس تبدأ من 650,000 ${m}.`], [`Townhouses from ${m} 650,000.`, `تاون هاوس تبدأ من ${m} 650,000.`]]) {
        const bad = copyProblems({ description: { en: [en], ar: [ar] } });
        assert.ok(bad.some((p) => p.startsWith('description.en[0] states a price')), en);
        assert.ok(bad.some((p) => p.startsWith('description.ar[0] states a price')), ar);
      }
    }
  });
});

// r7 #3 (Codex r6 #2, Claude r6 B4 / B5d) — the model-name guard: a dot may stand between a code and its figure; a Latin
// code beside a figure counts only when the figure is amount-shaped (3+ digits, grouped, decimal, scaled), so the unit
// codes a brochure prints ("Type SR2", "Villa DH 1") are names again; and a reading price as "4500 K", "4.5 millions",
// ".95m" or "0,95m" refuses the name. Arabic marks and currency words stay refused anywhere.
describe('r7 #3: the model-name guard — dotted codes, amount-shaped figures beside a code, more scaled forms', () => {
  const nameOf = (en, ar, figures = []) => dropMoneyText({ models: [{ name: { en, ar } }] }, { figures }).name;
  // enrich-dry6/work/ai.json: the 8 names and all 18 figures the reading carries (models, Sakani, headline).
  const W023 = [
    ['Lulu 2', 'نموذج لؤلؤ 2', 319015, 270425], ['Nawras 2', 'نموذج نورس 2', 419994, 356024], ['Saif 2', 'نموذج سيف 2', 491819, 416910],
    ['Saif 3', 'نموذج سيف 3', 511615, 433690], ['Marafi 3', 'نموذج مرافئ 3', 593719, 503288], ['Zumurrud 2', 'نموذج الزمرد 2', 673245, 559261],
    ['Fairouz 1', 'نموذج الفيروز 1', 636245, 519928], ['Kahraman 2', 'نموذج كهرمان 2', 752914, 625442],
  ];
  const W023_FIGURES = [...W023.flatMap(([, , p, s]) => [p, s]), 319015, 270425];
  it('a dot between a code and its figure refuses the name: "Studio SR. 750", "Studio SAR. 750" (Codex r6 #2)', () => {
    for (const [en, ar] of [
      ['Studio SR. 750', 'نموذج'], ['Studio SR.750', 'نموذج'], ['Studio SAR. 750', 'نموذج'], ['Studio AED. 750', 'نموذج'],
      ['Studio Dhs. 750', 'نموذج'], ['Studio', 'نموذج SR. 750'],
    ]) assert.equal(nameOf(en, ar), 'models[0].name', `${en} / ${ar}`);
  });
  it('a printed unit code beside a short figure is a name: "Type SR2", "Villa DH 1", "Unit 2 DH" (Claude r6 B4)', () => {
    for (const code of ['Type SR2', 'Villa DH 1', 'Duplex DH 3', 'Type 2SR', 'Unit 2 DH', 'Type EUR3', 'Villa S.R. 2']) {
      for (const [en, ar] of [[code, 'نموذج'], ['Studio', `نموذج ${code}`]]) {
        assert.equal(nameOf(en, ar), null, `${en} / ${ar}`);
        assert.equal(nameOf(en, ar, W023_FIGURES), null, `${en} / ${ar} (W023 figures)`);
      }
    }
  });
  it('a Latin code beside an amount-shaped figure still refuses the name: 3+ digits, grouped, decimal, scaled', () => {
    for (const en of [
      'Studio 4500SAR', 'Studio SAR4500', 'Villa 1,250,000SAR', 'Penthouse SR 4.5m', 'Studio SR. 750', 'Studio SR 750', 'Studio 750 SR',
      'Villa SAR 1 250 000', 'Villa SR 0,95', 'Villa 4.5 SR', 'Villa SR 2m', 'Villa SR 5 k', 'Villa SR 2 million', 'Villa 2m SAR',
      'Villa 2 million SAR', 'Villa SR .95m', 'Villa .95 SR',
    ]) assert.equal(nameOf(en, 'نموذج'), 'models[0].name', en);
  });
  it('Arabic marks and currency words stay refused anywhere, whatever the figure', () => {
    for (const [en, ar] of [
      ['Villa riyals', 'نموذج'], ['Villa 2 dirhams', 'نموذج'], ['Studio', 'نموذج ريال'], ['Studio', 'نموذج ر.س 2'], ['Studio', 'نموذج 2 درهم'],
      ['Studio', 'نموذج د.إ 2'], ['Studio $2', 'نموذج'],
    ]) assert.equal(nameOf(en, ar), 'models[0].name', `${en} / ${ar}`);
  });
  it('a reading price as "4500 K", "4.5 millions", ".95m" or "0,95m" refuses the name (Claude r6 B5d)', () => {
    for (const [en, n] of [
      ['Penthouse 4500 K', 4500000], ['Penthouse 4500 k', 4500000], ['Penthouse 4.5 millions', 4500000], ['Penthouse 4.5 Millions', 4500000],
      ['Studio 750 thousands', 750000], ['Townhouse .95m', 950000], ['Townhouse 0,95m', 950000], ['Penthouse 4,5m', 4500000],
    ]) assert.equal(nameOf(en, 'نموذج', [n]), 'models[0].name', en);
    // a comma between digits is read both ways: as grouping too ("4,500k" is 4,500,000).
    assert.equal(nameOf('Penthouse 4,500k', 'نموذج', [4500000]), 'models[0].name');
  });
  it('still names: "Villa 15m", "Plot 10000", "Penthouse 4,250", "Block SR-2", "Tower B. 12 floors", "د. إبراهيم", the 8 W023 names', () => {
    for (const [en, ar] of [
      ['Villa 15m', 'فيلا 15م'], ['Plot 10000', 'نموذج'], ['Penthouse 4,250', 'نموذج'], ['Type A 12m frontage', 'نموذج'], ['Block SR-2', 'نموذج'],
      ['Tower B. 12 floors', 'نموذج'], ['Villa Ibrahim', 'فيلا د. إبراهيم 2'], ['Villa 20 m', 'نموذج'], ['Townhouse 95m', 'نموذج'],
    ]) assert.equal(nameOf(en, ar, [4500000, 950000, ...W023_FIGURES]), null, `${en} / ${ar}`);
    for (const [en, ar] of W023) assert.equal(nameOf(en, ar, W023_FIGURES), null, en);
  });
});

// r8 #2 (Codex r7 #4 / #5a, Claude r7 NB4 / NB5) — a tight dotted Arabic mark glued to the word before it is a mark when
// a figure follows (every guard: it is in the one list); in a model NAME, the codes the site prints keep r7 #3's amount
// rule, the other codes are read as printed (case-sensitive) and need a stronger amount (4+ digits, grouped, decimal,
// scaled), and a glued dotted pair counts only where the word ends or a figure follows ("د.إبراهيم" is a name).
describe('r8 #2: glued dotted marks before a figure; site and other codes and glued initials in a model name', () => {
  const nameOf = (en, ar, figures = []) => dropMoneyText({ models: [{ name: { en, ar } }] }, { figures }).name;
  it('a fact-list item with a glued tight mark before its figure is dropped (Codex r7 #4)', () => {
    const holder = { amenities: { en: ['Club membership', 'Gym'], ar: ['الاشتراكر.س 2000', 'نادي رياضي'] } };
    assert.deepEqual(dropMoneyText(holder, { figures: [450000] }).dropped, ['amenities[0]']);
    assert.deepEqual(holder.amenities, { en: ['Gym'], ar: ['نادي رياضي'] });
  });
  it('the copy guard reads a glued tight mark before its figure: "تبدأ الأسعار منر.س 850,000" (Codex r7 #4)', () => {
    const bad = copyProblems({ description: { en: ['Townhouses with gardens.'], ar: ['تبدأ الأسعار منر.س 850,000'] } });
    assert.ok(bad.some((p) => p.startsWith('description.ar[0] states a price')), JSON.stringify(bad));
  });
  it('names kept: other codes by a short or lower-case figure, glued Arabic initials (Codex r7 #5a, Claude r7 NB4 / NB5)', () => {
    for (const code of ['Villa TL 120', 'Type tl 120', 'Villa kn 120', 'Block CHF 300', 'Unit CAD 120', 'Type INR 500', 'Villa TL 120 m²', 'Block CHF 3']) {
      for (const [en, ar] of [[code, 'نموذج'], ['Studio', `نموذج ${code}`]]) assert.equal(nameOf(en, ar), null, `${en} / ${ar}`);
    }
    for (const [en, ar] of [['Villa Ibrahim', 'فيلا د.إبراهيم'], ['Type Qasim 2', 'نموذج ر.قاسم 2']]) assert.equal(nameOf(en, ar), null, ar);
  });
  it('still refused: site codes by 3+ digits, other codes by a money-sized figure, symbols, Arabic marks at a word end or before a figure', () => {
    for (const code of [
      'Villa TL 1,250,000', 'Villa 1,250,000 TL', 'Villa 1 250 000 TL', 'Villa TL 4.5m', 'Type TL1200', 'Studio TL 4500', 'Villa ₺120',
      'Villa SR 120', 'Villa DH 120', 'Studio SR. 750', 'Studio 750 SR', 'Villa kn 4500',
    ]) {
      for (const [en, ar] of [[code, 'نموذج'], ['Studio', `نموذج ${code}`]]) assert.equal(nameOf(en, ar), 'models[0].name', `${en} / ${ar}`);
    }
    // a tatweel draws the mark out, it does not make it a word: "ر.سـ 2000" stays refused.
    for (const ar of ['نموذج ر.س 2000', 'نموذجر.س 2000', 'نموذج ر.س', 'نموذج ر.سـ 2000']) assert.equal(nameOf('Studio', ar), 'models[0].name', ar);
  });
});

// r8 #3 (Claude r7 B2 / NB3, Codex r7 #5b) — the listing-copy guard (claude.mjs PRICE_IN_COPY_RE) reads the figure shapes
// brochures print: digits grouped by "،", a space or a no-break space; "/-" after a figure; "SAR:" / "SAR -" before one;
// plural scales ("4.5 millions"), which price.mjs figurePatterns reads too, so refusedFigureIn finds a refused figure
// written that way. "m²", "m2", "m³" after a figure are an area, never "m" for million (in the name guard too). A dot
// after a mark belongs to a code only: "in US dollars. 2027 handover" is a sentence end.
describe('r8 #3: the copy guard — "،" / space grouping, "/-", "SAR:", plural scales; m² is no scale; a dot after a code only', () => {
  const copyStates = (en, ar) => {
    const bad = copyProblems({ description: { en: [en], ar: [ar] } });
    return [bad.some((p) => p.startsWith('description.en[0] states a price')), bad.some((p) => p.startsWith('description.ar[0] states a price'))];
  };
  const nameOf = (en, ar, figures = []) => dropMoneyText({ models: [{ name: { en, ar } }] }, { figures }).name;
  it('a price in the copy in each shape brochures print, in English and in Arabic copy (Claude r7 B2)', () => {
    for (const [en, ar] of [
      ['Villas from 850،000 SAR.', 'فلل بسعر ٨٥٠،٠٠٠ ر.س'],
      ['Villas from SAR 850،000.', 'فلل تبدأ من ر.س ٨٥٠،٠٠٠.'],
      ['Villas from 850 000 SAR.', 'فلل تبدأ من 850 000 ريال.'],
      ['Villas from 850 000 SAR.', 'فلل تبدأ من ٨٥٠ ٠٠٠ ريال.'],
      ['Villas from 1 250 000 dirhams.', 'فلل تبدأ من 1 250 000 درهم.'],
      ['Townhouses from 850,000/- SAR.', 'تاون هاوس تبدأ من 850,000/- ريال.'],
      ['Townhouses from 850000/- SAR.', 'تاون هاوس تبدأ من 850000 /- ر.س'],
      ['Villas from SAR: 850,000.', 'فلل تبدأ من ر.س: 850,000.'],
      ['Villas from SAR - 850,000.', 'فلل تبدأ من ريال - 850,000.'],
      ['Villas from SR. = 850,000.', 'فلل تبدأ من ريال: ٨٥٠٠٠٠.'],
      ['Townhouses from SAR 4.5 millions.', 'تاون هاوس تبدأ من SAR 4.5 millions.'],
      ['Townhouses from 4.5 millions SAR.', 'تاون هاوس تبدأ من 4.5 millions ريال.'],
      ['Studios from SAR 850 thousands.', 'استوديو يبدأ من 850 thousands ريال.'],
      ['Studios from SAR 850 thousand.', 'استوديو يبدأ من ر.س 850 thousand.'],
      ['Land from SAR 1.2 billions.', 'أرض تبدأ من 1.2 billions ريال.'],
    ]) assert.deepEqual(copyStates(en, ar), [true, true], `${en} / ${ar}`);
  });
  it('a refused figure written with a plural scale is found in the copy: "4.5 millions", "850 thousands" (Claude r7 B2)', () => {
    assert.ok(priceAppearsIn('Townhouses from SAR 4.5 millions.', 4500000));
    assert.ok(priceAppearsIn('Townhouses from 4.5 Millions.', 4500000));
    assert.ok(priceAppearsIn('Studios from 850 thousands.', 850000));
    assert.equal(priceAppearsIn('Townhouses from 14.5 millions.', 4500000), false);
  });
  it('an area after a code is no price: "SR. 120 m²", "SAR 2 m²", "SR 2 m2", "S.R. 120 m²", "AED 120 m²", "SR 120 m³" (Codex r7 #5b)', () => {
    for (const en of [
      'Studio SR. 120 m² of living space.', 'Studio SR 120 m² of living space.', 'Plots of SAR 2 m² each.', 'SAR. 2 m²', 'plots of SR 2 m2',
      'plots of SR. 2 m2', 'Studio S.R. 120 m² of living space.', 'Studio AED 120 m² of living space.', 'Studio Dhs. 120 m² of living space.',
      'Type SR 120 m³ of storage.', 'Studio TL 120 m² of living space.',
    ]) assert.deepEqual(copyStates(en, 'اثنان.'), [false, false], en);
    // …in a model name too: the name guard keeps it, and the copy guard (which reads names) raises nothing.
    for (const name of ['Villa SR 2 m²', 'Villa SR 2 m2', 'Villa SR 2 m³', 'Villa TL 120 m²']) {
      assert.equal(nameOf(name, 'نموذج'), null, name);
      assert.deepEqual(copyProblems({}, { models: [{ name: { en: name, ar: 'نموذج' } }] }), [], name);
    }
  });
  it('…and a scaled or grouped figure after a code is still a price (Codex r7 #5b)', () => {
    for (const en of [
      'From SAR 2.5m', 'From AED. 2.5m', 'From SAR 2 m.', 'From SAR 4.5 m', 'AED 2.5 million', 'SAR 3m, ready now', 'From SR. 850,000',
      'From SR 2 mn', 'SAR 1,200 m²', 'From SR 2m', 'from Dhs. 850,000', 'From SAR 1.2m 2-bedroom flats',
    ]) assert.deepEqual(copyStates(en, 'اثنان.'), [true, false], en);
    for (const name of ['Villa SR 2m', 'Villa SR 2 million', 'Villa SR 4.5 m']) assert.equal(nameOf(name, 'نموذج'), 'models[0].name', name);
  });
  it('a dot after a currency word or symbol is a sentence end, after a code it is the code\'s (Claude r7 NB3)', () => {
    for (const [en, ar] of [
      ['Prices are quoted in US dollars. 2027 handover is planned.', 'الأسعار بالريال. 2026 موعد التسليم.'],
      ['Prices are in riyals. 2026 handover.', 'الأسعار بالدولار. 2027 موعد التسليم.'],
      ['Prices are in euros. 2027 handover.', 'الأسعار بالدرهم. 2027 موعد التسليم.'],
    ]) assert.deepEqual(copyStates(en, ar), [false, false], `${en} / ${ar}`);
    for (const en of ['From SR. 850,000', 'Dhs. 850,000', 'From USD. 850,000', 'Club membership SAR.4500 a year.']) {
      assert.deepEqual(copyStates(en, 'اثنان.'), [true, false], en);
    }
  });
});

// r9 #1 (Codex r8 #1): the text layer settles a sale's headline (pipeline.mjs printed()) when printedInCurrency finds the
// figure, a bare one too on a Saudi listing in SAR. A figure with a measure straight after it is an area, never that
// evidence: "4.5 million square feet", "4,500,000 sq ft", "٤٫٥ ملايين م²". Only its page can settle it.
describe('r9 #1: printedInCurrency — a figure followed by a measure is no printed price', () => {
  const inText = (t) => printedInCurrency(t, 4500000, 'SAR', { bareCounts: true, home: 'SAR' });
  it('an area is not the price: square feet, sq ft, m², m2, متر, م²', () => {
    for (const t of [
      'The development spans 4.5 millions of square feet', 'The development spans 4.5 million square feet', '4.5 million square feet',
      'Total built-up area 4,500,000 sq ft', 'مساحة المشروع 4.5 مليون متر مربع', 'Total area 4.5m sq ft', 'Total area 4.5 millions sq ft',
      'مساحة المشروع ٤٫٥ ملايين م²', 'Land of 4,500,000 m2',
    ]) assert.equal(inText(t), false, t);
  });
  it('…and a price is still a price, with an area elsewhere on its line or none', () => {
    for (const t of [
      'Prices from SAR 4.5 millions', 'Price 4,500,000', 'السعر 4.5 مليون ريال', 'Price SAR 4,500,000 for a 450 m² villa',
      '4,500,000 SAR / 450 m²', 'SAR 4,500,000.00',
    ]) assert.equal(inText(t), true, t);
  });
});

// r10 #2: three more ways an area passed for a printed price, or a price for an area. A model code after a price is no
// m² (Codex r9 #2 = Claude r9 NB6): "M2A" is a code, "m2" with no letter or digit after it a measure. The solid million
// "m" and thousand "k" do not take the "m" of m² / m2 / m³ (Codex r9 NB1 = Claude r9 NB2): "4.5m²" is no 4.5 million.
// A measure right BEFORE the figure (Claude r9 NB1): the Arabic text layer comes in visual order, "² م1,000,000" for
// "1,000,000 م²" (AC53D4FF p5), so the unit stands before the area.
describe('r10 #2: printedInCurrency — a model code is no m², m² is no million, a unit before the figure is an area', () => {
  const sar = (t, n) => printedInCurrency(t, n, 'SAR', { bareCounts: true, home: 'SAR' });
  it('C#2 / NB6: "M2A" after a price is a model code, not m²', () => {
    assert.equal(sar('Sale price SAR 450,000 M2A Villa', 450000), true);
    assert.equal(sar('Sale price SAR 450,000 m2a Villa', 450000), true);
    assert.equal(sar('Sale price SAR 450,000 M22 Villa', 450000), true);
    for (const t of ['Land of 450,000 m2', 'Land of 450,000 M2', 'Land of 450,000 m2.', 'Land of 450,000 m2 in all', 'Land of 450,000 M²']) {
      assert.equal(sar(t, 450000), false, t);
    }
  });
  it('C-NB1 / NB2: the solid "m" of m² / m2 / m³ is no million', () => {
    for (const [t, n] of [['Total area 4.5m²', 4.5e6], ['Bathroom 4.5m²', 4.5e6], ['Plot 136m2', 136e6], ['Tank 4.5m³', 4.5e6], ['المساحة136m2', 136e6]]) {
      assert.equal(sar(t, n), false, t);
      assert.equal(priceAppearsIn(t, n), false, `${t} (priceAppearsIn)`);
    }
    for (const t of ['SAR 4.5m', 'SAR 4.5m.', '4.5m SAR', 'Price 4.5m', 'SAR 4.5M, all in']) assert.equal(sar(t, 4.5e6), true, t);
    for (const t of ['SAR 990k', 'SAR 990k.', '990k SAR']) assert.equal(sar(t, 990000), true, t);
  });
  it('NB1: a measure right before the figure — unit first in the visual-order text layer — is an area', () => {
    for (const t of ['² م1,000,000', 'م² 1,000,000', 'متر مربع 1,000,000', 'على مساحة ² م1,000,000', 'م2 1,000,000', '2م 1,000,000',
      'المساحة متر 1,000,000', 'Area m² 1,000,000', 'Area sqm: 1,000,000', 'Area sq. m 1,000,000', 'هكتار 1,000,000']) {
      assert.equal(sar(t, 1e6), false, t);
    }
    for (const t of ['السعر 1,000,000 ريال', 'Price SAR 1,000,000', 'ريال 1,000,000', 'Price 1,000,000', 'Villa 450 m², SAR 1,000,000']) {
      assert.equal(sar(t, 1e6), true, t);
    }
  });
  it('r10 #4 (r10 verifier): a unit with its own figure before it, a model code or a year is no measure of the next figure', () => {
    // A table row Model | Area | Price: the unit belongs to the area before it, not to the price after it. "M2" typed as
    // a model code (the mirror of C#2), "Item2" and the year suffix in "2022م" are no unit either.
    for (const [t, n] of [
      ['Villa A 250 m² 1,250,000 SAR', 1.25e6], ['Villa A 250 m2 1,250,000 SAR', 1.25e6], ['Villa A 250 sqm 1,250,000', 1.25e6],
      ['Type B 180 m² - 450,000 SAR', 450000], ['فيلا أ 250 م² 1,250,000 ريال', 1.25e6], ['فيلا أ 250 متر مربع 1,250,000 ريال', 1.25e6],
      ['فيلا أ ٢٥٠ م² 1,250,000 ريال', 1.25e6], ['Villa M2 450,000 SAR', 450000], ['Type M2 450,000', 450000], ['Item2 450,000 ريال', 450000],
      ['تسليم 2022م 1,500,000 ريال', 1.5e6],
    ]) assert.equal(sar(t, n), true, t);
  });
  it('r11 #2 (Claude r10 B2 / NB1 / NB5 / NB6, Codex r10 #2 / #3 / #4 / NB1): m² glued to a word, a visual unit after a lot number, a per-m² price; a word ending in م, a unit on its own line', () => {
    // An area: m² glued to the next word (a one-letter tail is a model code, a word the next cell); the visual-order
    // "² م" glued to its figure whatever stands before it; a price per m² is no total; "SQM" in capitals is a unit.
    for (const [t, n] of [
      ['Land 30,000 m²Built-up 12,000 m²', 30000], ['Plot area: 450,000 m²of land', 450000], ['GFA 4.5 million m²Total', 4.5e6],
      ['Land 30,000 m2Built-up', 30000], ['قطعة 12 ² م1,000,000', 1e6], ['ريال 15,000,000 ² م30,000', 30000],
      ['SAR 4,500 / m²', 4500], ['Price SAR 4,500 per sqm', 4500], ['سعر المتر 4,500 / م²', 4500], ['Area SQM 1,000,000', 1e6],
    ]) assert.equal(sar(t, n), false, t);
    // A price: a model code with one letter (and a digit) after m2; "رقم 2" before the figure is no m2; a unit on a
    // line of its own, or at the end of the line above, measures nothing on the next line; a price per villa.
    for (const [t, n] of [
      ['Sale price SAR 450,000 M2A Villa', 450000], ['Sale price SAR 450,000 M2B2 villa', 450000], ['فيلا رقم 2 1,250,000 ريال', 1.25e6],
      ['Villa A\n250\nm²\n1,250,000 SAR', 1.25e6], ['Built-up area sqm\n1,250,000 SAR', 1.25e6], ['SAR 4,500,000 / villa', 4.5e6],
    ]) assert.equal(sar(t, n), true, t);
  });
  it('r12 #2 (Codex r11 #1 / #3 / NB1): a bare figure under a unit label is an area; a column after "/ sqm:" or a code "M2AB" keeps the total; a per-area price with its currency between', () => {
    for (const [t, n] of [
      ['Plot area sqm\n450,000', 450000], ['المساحة م²\n450,000', 450000], ['Built-up area (sqm)\n450,000', 450000],
      ['4,500 SAR / m²', 4500], ['4,500 ريال لكل متر مربع', 4500], ['4,500 ريال / م²', 4500], ['AED 4,500 per sqm', 4500],
    ]) assert.equal(sar(t, n), false, t);
    for (const [t, n] of [
      ['Sale price SAR 1,250,000 / sqm: 250', 1.25e6], ['Sale price SAR 1,250,000 M2AB Villa', 1.25e6], ['Plot area sqm\n450,000 SAR', 450000],
      ['Villa A 250 m² 1,250,000 SAR', 1.25e6], ['Land 30,000 m²Built-up 12,000 m²', 0],
    ].filter(([, n]) => n)) assert.equal(sar(t, n), true, t);
    assert.equal(sar('Land 30,000 m²Built-up 12,000 m²', 30000), false);
    assert.equal(sar('GFA 4.5 million m²Total', 4.5e6), false);
  });
  it('r13 #1 (Claude r11 B1 / B2 / NB1 / NB4 / NB7): المتر with its article or clitic, a stacked unit label in visual order, a per-area label before the figure, m² glued to digits', () => {
    for (const [t, n] of [
      ['أرض للبيع\nسعر المتر: 2,500 ريال', 2500], ['السعر بالمتر 4,500 ريال', 4500], ['للمتر 4,500 ريال', 4500], ['قيمة المتر 3,500 ريال', 3500],
      ['المساحة بالمتر: 1,000,000\nالسعر عند الطلب', 1e6], ['مساحة الأرض بالم2 1,000,000', 1e6], ['سعر المتر 4,500 ريال', 4500],
      ['Land for sale, Al Shati\nPlot area m²\n450,000\nPrice on request', 450000], ['مساحة الأرض متر مربع\n1,000,000', 1e6], ['² م\n1,000,000', 1e6],
      ['6,000 ريال للمتر المربع', 6000], ['Price per m²: SAR 4,500', 4500], ['4,500 لكل م²', 4500], ['Land 30,000 m²12,000 m²', 30000],
    ]) assert.equal(sar(t, n), false, t);
    for (const [t, n] of [
      ['فيلا رقم 2 1,250,000 ريال', 1.25e6], ['حمام 2\n1,250,000 ريال', 1.25e6], ['Villa A\n250\nm²\n1,250,000 SAR', 1.25e6],
      ['المساحة م²\n1,250,000 ريال', 1.25e6], ['Price\n450,000', 450000],
    ]) assert.equal(sar(t, n), true, t);
  });
});

// r9 #3 (Codex r8 #2): in a model NAME a tight dotted pair with letters glued after it is initials ("د.إبراهيم": r8 #2),
// unless a figure stands right before it, spaces between or not: "نموذج ٧٥٠ر.سشهريًا" is 750 riyals a month, whatever
// follows the pair. The guard reads westernised digits, so Arabic and Latin figures alike.
describe('r9 #3: a glued dotted pair right after a figure refuses a model name', () => {
  const nameOf = (en, ar, figures = []) => dropMoneyText({ models: [{ name: { en, ar } }] }, { figures }).name;
  it('refused: a figure, then the pair with letters glued after it, the figure not among the reading\'s prices', () => {
    for (const ar of [
      'نموذج ٧٥٠ر.سشهريًا', 'نموذج 750ر.سشهريا', 'نموذج ٧٥٠ر.سـشهريًا', 'نموذج ٧٥٠ ر.سشهريًا', 'نموذج ٧٥٠د.إشهريًا', 'نموذج ٧٥ر.سسنويًا',
      'نموذج ٧٥٠ ر.سشهريًا', 'نموذج ٧٥٠ ر.سشهريًا',
    ]) {
      for (const figures of [[], [850000]]) assert.equal(nameOf('Studio', ar, figures), 'models[0].name', `${ar} ${figures}`);
    }
  });
  it('still names: glued initials with no figure before them, an undotted pair inside a word after a figure', () => {
    for (const ar of ['فيلا د.إبراهيم', 'نموذج ر.قاسم 2', 'نموذج ر.سعيد', 'نموذج ٢رسومات']) {
      for (const figures of [[], [850000]]) assert.equal(nameOf('Studio', ar, figures), null, `${ar} ${figures}`);
    }
  });
});

// r10 #3 (Codex r9 #4 = Claude r9 NB7): that pair counts after a figure of two digits or more only, so a one-digit model
// number before a person's initials is a name, "فيلا ٣ د.إبراهيم" — refusing it refused the whole run. A pair whose
// word ends still refuses after any figure ("نموذج ٣ ر.س").
describe('r11 #3 (Codex r10 #5 = Claude r10 NB4): a decimal figure right before a glued dotted pair refuses a model name', () => {
  const nameOf = (en, ar, figures = []) => dropMoneyText({ models: [{ name: { en, ar } }] }, { figures }).name;
  it('the figure counts whole, its decimal part too; a one-digit model number before initials stays a name', () => {
    // (r12 #3: "7.5" before the pair is the shape of a model number like "١٫٢" — Codex r11 #4 — so it is no amount.)
    for (const ar of ['نموذج ٧٥٠٫٥ر.سشهريًا', 'نموذج ١٬٢٥٠٫٥ر.سشهريًا']) assert.equal(nameOf('Studio', ar, [850000]), 'models[0].name', ar);
    for (const ar of ['فيلا ٣ د.إبراهيم', 'نموذج 2 ر.قاسم']) assert.equal(nameOf('Villa', ar, [850000]), null, ar);
  });
  it('r12 #3 (Codex r11 #4): a dotted model number before initials stays a name; an amount-sized figure before the pair refuses it', () => {
    for (const ar of ['فيلا ١٫٢ د.إبراهيم', 'فيلا 1.2 د.إبراهيم', 'نموذج ٢٫٣ ر.قاسم', 'Villa 3,4 د.كمال']) assert.equal(nameOf('Villa', ar, [850000]), null, ar);
    for (const ar of ['نموذج ٧٥ر.سسنويًا', 'نموذج ٧٥٠٫٥ر.سشهريًا', 'نموذج 1.25ر.سشهريا', 'نموذج ١٬٢٥٠ر.سشهريًا']) assert.equal(nameOf('Studio', ar, [850000]), 'models[0].name', ar);
  });
});

describe('r10 #3: a glued dotted pair after a one-digit model number is initials', () => {
  const nameOf = (en, ar, figures = []) => dropMoneyText({ models: [{ name: { en, ar } }] }, { figures }).name;
  it('still refused: two digits or more, then the pair with letters glued after it; a pair whose word ends', () => {
    for (const ar of ['نموذج ٧٥ر.سسنويًا', 'نموذج ٧٥٠ر.سشهريًا', 'نموذج 75 ر.سسنويا', 'نموذج ٣ ر.س', 'نموذج 3ر.س']) {
      for (const figures of [[], [850000]]) assert.equal(nameOf('Studio', ar, figures), 'models[0].name', `${ar} ${figures}`);
    }
  });
  it('names: a one-digit model number, then a person\'s initials', () => {
    for (const ar of ['فيلا ٣ د.إبراهيم', 'نموذج 2 ر.قاسم', 'فيلا 3 د.إبراهيم', 'فيلا ٣د.إبراهيم', 'نموذج ٢ ر.قاسم']) {
      for (const figures of [[], [850000]]) assert.equal(nameOf('Studio', ar, figures), null, `${ar} ${figures}`);
    }
  });
});

describe('pricePagesToRender', () => {
  it('returns the 1-based pages that need a look, in order', () => {
    assert.deepEqual(pricePagesToRender([LOCATION_PAGE, 'شقة بغرفتين', PRICE_PAGE, '', PRICE_PAGE]), [3, 5]);
  });
  it('is capped', () => {
    const many = Array.from({ length: 40 }, () => PRICE_PAGE);
    assert.equal(pricePagesToRender(many).length, MAX_PRICE_PAGES);
    assert.deepEqual(pricePagesToRender(many, { maxPages: 2 }), [1, 2]);
  });
  it('copes with no page text', () => {
    assert.deepEqual(pricePagesToRender(undefined), []);
  });
});

// ---- end to end: processPdf with a fake extractor and a fake `claude` ---------------------------

const FAKE_PY = `import fs from 'node:fs';
import path from 'node:path';
const cfg = JSON.parse(fs.readFileSync(new URL('./fake.json', import.meta.url), 'utf8'));
const [, , , , outDir, ...rest] = process.argv;
const opt = (k) => { const i = rest.indexOf(k); return i === -1 ? null : rest[i + 1]; };
const mode = opt('--mode') ?? 'extract';
const pages = (opt('--pages') ?? '').split(',').filter(Boolean).map(Number);
const put = (rel) => { const abs = path.join(outDir, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.copyFileSync(cfg.photo, abs); return abs; };
fs.appendFileSync(new URL('./calls.jsonl', import.meta.url), JSON.stringify({ tool: 'py-' + mode, pages, dir: opt('--page-dir') }) + '\\n');
let out;
if (mode === 'extract') {
  const brokenFiles = [];
  const candidates = Array.from({ length: cfg.candidateCount ?? 6 }, (_, index) => {
    const file = 'images/c' + String(index).padStart(3, '0') + '.jpg';
    // cfg.broken: candidates written as bytes no decoder reads (a truncated or hostile image).
    const abs = (cfg.broken ?? []).includes(index) ? (put(file), fs.writeFileSync(path.join(outDir, file), 'not an image'), brokenFiles.push(path.join(outDir, file)), path.join(outDir, file)) : put(file);
    return { index, file, abs, width: 1200, height: 900, page: 1 + index, source: 'embedded', coverage: 0.5 };
  });
  fs.writeFileSync(new URL('./broken.json', import.meta.url), JSON.stringify(brokenFiles));
  out = { ok: true, pages: cfg.pageText.length, text: cfg.pageText.join('\\n'), pageText: cfg.pageText, candidates,
    rendered: false, embeddedImageCount: candidates.length, links: cfg.links ?? [], meta: {} };
} else if ([].concat(cfg.failPageDir ?? []).includes(opt('--page-dir'))) {
  // cfg.failPageDir: a page folder (or a list of them) whose render fails.
  out = { ok: false, error: 'extract_pdf.py failed (exit 1): cannot render' };
} else {
  const dir = opt('--page-dir') ?? 'pages';
  const want = pages.length ? pages : cfg.pageText.map((_, i) => i + 1);
  out = { ok: true, pageImages: want.map((page) => ({ page, abs: put(dir + '/p' + page + '.jpg'), width: 1600, height: 1131 })) };
}
process.stdout.write(JSON.stringify(out) + '\\n');
`;

const FAKE_CLAUDE = `import fs from 'node:fs';
const cfg = JSON.parse(fs.readFileSync(new URL('./fake.json', import.meta.url), 'utf8'));
const log = new URL('./calls.jsonl', import.meta.url);
const prompt = fs.readFileSync(0, 'utf8');
// The currency each page prints its figures in, as the page shows it (cfg.printedIn: a code, null =
// no currency shown at all, or { page: code|null }; 'SAR' by default). A second model that follows its
// prompt (claude.mjs currencyRule) says yes only to a figure printed IN the currency it was asked about —
// or, when the prompt allows it, to a figure printed with no currency at all.
const printedOn = (page) => {
  const p = cfg.printedIn === undefined ? 'SAR' : cfg.printedIn;
  return p !== null && typeof p === 'object' ? (String(page) in p ? p[page] : 'SAR') : p;
};
const inCurrency = (page, asked) => {
  const printed = printedOn(page);
  return asked !== null && (printed === asked || (printed === null && /may be taken as/.test(prompt)));
};
// cfg.facts — a second model that follows its prompt to the letter (review 2026-11-17): { [page]: [{ fig, mark,
// header, kind, model, sub }] } is what each page really prints. mark: the currency mark printed beside the figure,
// header: the one heading its table (null = none shown); kind: 'whole' (a price for the whole listing) | 'model' |
// 'floor'; model: the row's name; sub: a price for subsidy beneficiaries. A figure is IN the currency asked only when
// its mark is one the PROMPT lists for that currency (claude.mjs currencyRule), or it shows none and the prompt lets
// a bare figure be taken as that currency. When set, it decides every confirm answer (confirm / printedIn do not).
const facts = (page) => (cfg.facts ?? {})[page] ?? [];
const marksOf = (code) => {
  const head = 'printed IN ' + code + ' — ' + code + "'s code, symbol or name";
  const at = prompt.indexOf(head);
  if (at < 0) return [];
  const open = prompt.indexOf('(', at + head.length);
  return prompt.slice(open + 1, prompt.indexOf(')', open)).split(/,| or |[/]/).map((s) => s.trim()).filter(Boolean);
};
const factIn = (e, asked) => {
  if (!asked) return false;
  const shown = e.mark ?? e.header ?? null;
  return shown === null ? /may be taken as/.test(prompt) : marksOf(asked).some((t) => t === shown || t.endsWith(' ' + shown));
};
let answer;
let rawResult = null;
if (prompt.includes('the floor-plan images to check>>>')) {
  // r4: the floor-plan contact check — one JSON line per image. cfg.planCheck: null = every plan clean;
  // 'quota' / true = the call fails (a quota, or another error); { 'plan-03': 'phone' } = that plan shows it.
  // cfg.planReply: 'duplicate' / 'malformed' = the first image's record comes twice / malformed; 'by-file-name'
  // (r7 #1) = each record numbered by the number in the file name shown, not by its index, and none about the last;
  // 'from-one' (r8 #1, Codex r7 C#1) = each record numbered index + 1 whatever the file names, and none about the last;
  // 'second-fails' (r9 #5, Claude r8 NB14) = every call but the first (each call not showing plan-01) fails like true.
  const fenced = prompt.split('<<<BONA-UNTRUSTED-DATA: the floor-plan images to check>>>')[1].split('<<<END ')[0];
  const images = fenced.split('\\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  // Which plan each file shown is, as its pixels would tell a model (r7 #1: the check reads a link named by its index
  // in the call): the plan-NN.jpg with the same inode in its folder or the one above it.
  const planOf = (file) => {
    const ino = fs.statSync(file).ino;
    for (let dir = file.slice(0, file.lastIndexOf('/')), up = 0; up < 2; up += 1, dir = dir.slice(0, dir.lastIndexOf('/'))) {
      const hit = fs.readdirSync(dir).find((f) => /^plan-\\d+\\.jpg$/.test(f) && fs.statSync(dir + '/' + f).ino === ino);
      if (hit) return hit;
    }
    return file.split('/').pop();
  };
  const plans = images.map((im) => planOf(im.file));
  fs.appendFileSync(log, JSON.stringify({ tool: 'claude-plan-check', files: plans, shown: images.map((im) => im.file), indexes: images.map((im) => im.index) }) + '\\n');
  // cfg.healOnPlanCheck: the candidates cfg.broken made unreadable read fine from this call on (a failure that
  // passed: the plan check could not prepare them, a staging after it can).
  if (cfg.healOnPlanCheck) for (const f of JSON.parse(fs.readFileSync(new URL('./broken.json', import.meta.url), 'utf8'))) fs.copyFileSync(cfg.photo, f);
  if (cfg.planCheck === 'quota' || cfg.planCheck === true || (cfg.planReply === 'second-fails' && !plans.includes('plan-01.jpg'))) {
    const quota = cfg.planCheck === 'quota';
    process.stdout.write(JSON.stringify({ is_error: true, api_error_status: quota ? 429 : null, result: quota ? "You've hit your session limit" : 'boom' }));
    process.exit(1);
  }
  const dirty = (cfg.planCheck && typeof cfg.planCheck === 'object') ? cfg.planCheck : {};
  const lines = images.map((im, k) => {
    const base = plans[k].replace(/\\.jpg$/, '');
    const index = cfg.planReply === 'by-file-name' ? Number(im.file.match(/(\\d+)\\.jpg$/)[1]) : cfg.planReply === 'from-one' ? im.index + 1 : im.index;
    return JSON.stringify({ index, clean: !dirty[base], found: dirty[base] ?? '' });
  });
  if (cfg.planReply === 'by-file-name' || cfg.planReply === 'from-one') lines.pop();
  if (cfg.planReply === 'duplicate') lines.push(lines[0]);
  if (cfg.planReply === 'malformed') lines[0] = JSON.stringify({ index: 0, clean: 'yes', found: '' });
  if (cfg.planReply === 'missing') lines.shift();
  rawResult = cfg.planReply === 'prose' ? 'All the plans look fine to me.' : lines.join('\\n');
} else if (prompt.includes('For each numbered model')) {
  // The unit-model check (claude.mjs confirmModelPrices): one call per page, every model on it,
  // one JSON line per model inside the fence.
  const page = Number((prompt.match(/\\/p(\\d+)\\.jpg/) || [])[1]);
  const currency = (prompt.match(/figures to check, in ([A-Z]{3})/) || [])[1] ?? null;
  const fenced = prompt.split('<<<BONA-UNTRUSTED-DATA: the models and figures to check>>>')[1].split('<<<END ')[0];
  const items = fenced.split('\\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))
    .map(({ i, price, subsidisedPrice }) => ({ i, price, subsidisedPrice }));
  // The rent period the prompt asks the figures to be printed for (Codex r1 #2), or null: not asked, any counts.
  const per = (prompt.match(/Every figure is a rent per (month|year)/) || [])[1] ?? null;
  // r7 #6: the prompt says the listing is for sale (a rent, an income, a fee, a deposit or an instalment is not its price).
  const sale = /The listing is for sale: a rent/.test(prompt);
  fs.appendFileSync(log, JSON.stringify({ tool: 'claude-model-confirm', page, items, currency, period: per, bare: /may be taken as/.test(prompt), sale }) + '\\n');
  // modelConfirmDelayMs: the call takes this long, and records when it ran (the concurrency test).
  if (cfg.modelConfirmDelayMs) {
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, cfg.modelConfirmDelayMs));
    fs.appendFileSync(log, JSON.stringify({ tool: 'model-confirm-span', page, t0, t1: Date.now() }) + '\\n');
  }
  if (cfg.modelConfirmFail) {
    const quota = cfg.modelConfirmFail === 'quota';
    process.stdout.write(JSON.stringify({ is_error: true, api_error_status: quota ? 429 : null, result: quota ? "You've hit your session limit" : 'boom' }));
    process.exit(1);
  }
  // modelConfirm: null = every figure confirmed; [figures] = only those; { i: {price, subsidisedPrice} } = per model.
  const mc = cfg.modelConfirm ?? null;
  answer = items.map((it) => (Array.isArray(mc)
    ? { i: it.i, price: mc.includes(it.price), subsidisedPrice: mc.includes(it.subsidisedPrice) }
    : { i: it.i, price: true, subsidisedPrice: true, ...((mc ?? {})[it.i] ?? {}) }));
  if (!inCurrency(page, currency)) answer = answer.map((a) => ({ ...a, price: false, subsidisedPrice: false }));
  if (cfg.facts) {
    const names = Object.fromEntries(fenced.split('\\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).map((it) => [it.i, String(it.name).split(' / ')[0]]));
    // e.per: the rent period printed for the figure ('month' | 'year'; none = the page shows none).
    const on = (it, sub, fig) => facts(page).some((e) => !!e.sub === sub && e.fig === fig && e.model === names[it.i] && factIn(e, currency) && (!per || !e.per || e.per === per));
    answer = items.map((it) => ({ i: it.i, price: on(it, false, it.price), subsidisedPrice: on(it, true, it.subsidisedPrice) }));
  }
  // cfg.rents (r7 #6): figures the page prints as a rent or an income — a second model told the listing is for sale
  // refuses them; one not told takes them for the model's price, as \`modelConfirm\` says.
  if (sale) {
    const rent = (fig) => (cfg.rents ?? []).includes(fig);
    answer = answer.map((a) => {
      const it = items.find((x) => x.i === a.i) ?? {};
      return { ...a, price: a.price && !rent(it.price), subsidisedPrice: a.subsidisedPrice && !rent(it.subsidisedPrice) };
    });
  }
} else if (prompt.includes('VISIBLY PRINT')) {
  const [, amountText, currency = null] = prompt.match(/VISIBLY PRINT[^\\d]*(\\d+)(?: ([A-Z]{3}))?/) || [];
  const amount = Number(amountText);
  const page = Number((prompt.match(/\\/p(\\d+)\\.jpg/) || [])[1]);
  const subsidised = /VISIBLY PRINT the price for housing-subsidy/.test(prompt);
  fs.appendFileSync(log, JSON.stringify({ tool: 'claude-confirm', amount, currency, bare: /may be taken as/.test(prompt), subsidised, page, project: /unit models/.test(prompt), mirror: /only the price for everyone else counts/.test(prompt),
    whole: /only a price printed for the whole property counts/.test(prompt),
    period: (prompt.match(/The price is the rent per (month|year)/) || [])[1] ?? null,
    sale: /The listing is for sale: a rent/.test(prompt),
    subject: (prompt.match(/listing this price is for[^\\n]*\\n([^\\n]*)/) || [])[1] ?? null }) + '\\n');
  if (cfg.confirmFail === 'quota') {
    process.stdout.write(JSON.stringify({ is_error: true, api_error_status: 429, result: "You've hit your session limit" }));
    process.exit(1);
  }
  // confirmFail: true — the call fails for a reason of its own (a timeout, a crash): not a quota.
  if (cfg.confirmFail === true) {
    process.stdout.write(JSON.stringify({ is_error: true, api_error_status: null, result: 'boom' }));
    process.exit(1);
  }
  answer = { confirmed: ((subsidised ? cfg.confirmSub : null) ?? cfg.confirm ?? []).includes(amount) && inCurrency(page, currency) };
  if (cfg.facts) {
    // A whole development: a model's price counts as the property's; otherwise only a price for the whole listing.
    const project = /unit models counts as the property/.test(prompt);
    // r2 #3: the rent period the prompt asks the headline to be printed for (none = not asked: any counts).
    const per = (prompt.match(/The price is the rent per (month|year)/) || [])[1] ?? null;
    answer = { confirmed: facts(page).some((e) => !!e.sub === subsidised && e.fig === amount && factIn(e, currency) && (e.kind === 'whole' || (project && e.kind === 'model'))
      && (!per || !e.per || e.per === per)) };
  }
  // cfg.rents (r7 #6): a figure the page prints as a rent or an income — refused by a second model told the listing is for sale.
  if ((cfg.rents ?? []).includes(amount) && /The listing is for sale: a rent/.test(prompt)) answer = { confirmed: false };
} else {
  fs.appendFileSync(log, JSON.stringify({ tool: 'claude-listing', prompt }) + '\\n');
  answer = cfg.listing;
}
process.stdout.write(JSON.stringify({ is_error: false, result: rawResult ?? JSON.stringify(answer), total_cost_usd: 0, duration_ms: 1, num_turns: 1, session_id: 'fake' }));
`;

// A stand-in for brochure_pdf.py, run through the real spawn (cfg.brochurePyCmd = [node, this]):
// records what it was handed — the listing JSON, the files folder AS IT WAS at that moment, the
// site.json path — and answers with the script's JSON line.
const FAKE_BROCHURE = `import fs from 'node:fs';
const cfg = JSON.parse(fs.readFileSync(new URL('./fake.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
const i = args.findIndex((a) => a.endsWith('brochure_pdf.py'));
const [listingJson, filesDir, siteJson, out] = args.slice(i + 1, i + 5);
fs.appendFileSync(new URL('./calls.jsonl', import.meta.url), JSON.stringify({ tool: 'brochure', args, filesDir, siteJson, out,
  listing: JSON.parse(fs.readFileSync(listingJson, 'utf8')), files: fs.readdirSync(filesDir).sort() }) + '\\n');
if (cfg.brochureFail) {
  process.stdout.write(JSON.stringify({ ok: false, reason: 'error', error: 'layout does not fit: page 4' }) + '\\n');
  process.exit(1);
}
fs.writeFileSync(out, '%PDF-1.7 fake brochure\\n');
process.stdout.write(JSON.stringify({ ok: true, out, bytes: 23, pages: 12, steps: ['measure', 'render', 'write'] }) + '\\n');
`;

const PLACE = {
  district: { en: 'Al Hamdaniyah', ar: 'الحمدانية' }, city: { en: 'Jeddah', ar: 'جدة' },
  country: { en: 'Saudi Arabia', ar: 'المملكة العربية السعودية' }, countryCode: 'SA',
};
const answer = ({ price, priceEvidence = null, subsidisedPriceEvidence = null, unit = null }) => ({
  reject: false, rejectReason: null, confidence: 0.8, warnings: [],
  listing: {
    title: { en: 'Jeddah Heights, Al Hamdaniyah', ar: 'جدة هايتس، الحمدانية' }, type: 'apartment', category: 'off-plan', location: PLACE,
    price,
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: null, yearBuilt: null, floors: null },
    description: { en: ['One.', 'Two.'], ar: ['واحد.', 'اثنان.'] },
    highlights: { en: ['A', 'B', 'C', 'D'], ar: ['أ', 'ب', 'ج', 'د'] },
    project: { name: { en: 'Jeddah Heights', ar: 'جدة هايتس' }, developer: { en: 'NHC', ar: 'الوطنية للإسكان' } },
    unit,
  },
  images: Array.from({ length: 6 }, (_, index) => ({
    index, room: ['exterior', 'living', 'kitchen', 'master', 'garden', 'gym'][index], rank: index + 1, hero: index === 0, exclude: false,
    reason: 'photograph', focus: { x: 0.5, y: index === 1 ? 0.8 : 0.5 },
  })),
  priceEvidence,
  subsidisedPriceEvidence,
});

const PRICE = { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false, subsidisedAmount: 270425 };
const BROCHURE = ['مشروع سكني — شقق بغرفتي نوم وثلاث غرف نوم في حي الحمدانية', LOCATION_PAGE, PRICE_PAGE, 'غرفة نوم 03', PRICE_PAGE];

async function rig({ pageText = BROCHURE, listing, confirm = [], confirmSub = null, confirmFail = null, modelConfirm = null, modelConfirmFail = null, modelConfirmDelayMs = 0, failPageDir = null, broken = [], brochureFail = false, printedIn = 'SAR', facts = null, cfgExtra = {}, build = '', candidateCount = 6, planCheck = null, planReply = null, healOnPlanCheck = false, links = [], rents = [] }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bona-price-pages-')));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const photo = path.join(bin, 'photo.jpg');
  const sharp = (await import('sharp')).default;
  await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#4a6b8a' } }).jpeg().toFile(photo);
  fs.writeFileSync(path.join(bin, 'fake.json'), JSON.stringify({ photo, pageText, listing, confirm, confirmSub, confirmFail, modelConfirm, modelConfirmFail, modelConfirmDelayMs, failPageDir, broken, brochureFail, printedIn, facts, candidateCount, planCheck, planReply, healOnPlanCheck, links, rents }));
  fs.writeFileSync(path.join(bin, 'fake-py.mjs'), FAKE_PY);
  fs.writeFileSync(path.join(bin, 'fake-claude.mjs'), FAKE_CLAUDE);
  fs.writeFileSync(path.join(bin, 'fake-brochure.mjs'), FAKE_BROCHURE);
  const claude = path.join(bin, 'claude');
  fs.writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(claude, 0o755);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'src', 'data'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'src', 'data', 'kind-map.json'), path.join(repo, 'src', 'data', 'kind-map.json'));
  for (const f of ['build.mjs', 'validate.mjs']) {
    fs.mkdirSync(path.join(repo, 'scripts', 'curate'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'scripts', 'curate', f), f === 'build.mjs' && build ? build : '// stand-in: the real build is not under test here\n');
  }
  const pdfPath = path.join(dir, 'brochure.pdf');
  fs.writeFileSync(pdfPath, `%PDF-1.4 jeddah heights ${crypto.randomUUID()}`);
  const cfg = {
    repo, site: 'https://bona-real-estate.com', maxPdfMb: 50, maxPdfPages: 60, minImageSide: 100, minImages: 4, maxImages: 10,
    pageReadLongSide: 1600, pyCmd: [process.execPath, path.join(bin, 'fake-py.mjs')], claudeBin: claude,
    brochurePyCmd: [process.execPath, path.join(bin, 'fake-brochure.mjs')], maxBrochureMb: 25,
    claudeModel: 'opus', claudeFallbackModel: null, claudeTimeoutMs: 60000, ...cfgExtra,
  };
  const calls = () => fs.readFileSync(path.join(bin, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const run = () => processPdf({ pdfPath, cfg, caption: {}, workDir: path.join(dir, 'work'), dryRun: true });
  const publish = (meta = {}, caption = { noBrochure: true }) => processPdf({ pdfPath, cfg, caption, workDir: path.join(dir, 'work'), meta });
  return { run, publish, calls, repo, pdfPath, cfg, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('processPdf: prices on pages whose digits are scrambled', { timeout: 120000 }, () => {
  it('renders exactly the price pages and tells the model why', async () => {
    const r = await rig({ listing: answer({ price: { amount: null, currency: 'SAR', from: false, period: null, onRequest: true } }) });
    try {
      await r.run();
      const calls = r.calls();
      const renders = calls.filter((c) => c.tool === 'py-pages');
      assert.equal(renders.length, 1, 'one page-render call');
      assert.deepEqual(renders[0].pages, [3, 5]);
      const { prompt } = calls.find((c) => c.tool === 'claude-listing');
      assert.match(prompt, /digits are missing or scrambled/);
      assert.match(prompt, /page 3: .*p3\.jpg/);
      assert.match(prompt, /page 5: .*p5\.jpg/);
      assert.doesNotMatch(prompt, /no usable text layer/);
    } finally { r.cleanup(); }
  });

  it('publishes both prices once each is confirmed on its page', async () => {
    const r = await rig({
      listing: answer({
        price: PRICE,
        priceEvidence: { page: 3, quote: '319,015' },
        subsidisedPriceEvidence: { page: 3, quote: '270,425' },
      }),
      confirm: [319015, 270425],
    });
    try {
      const report = await r.run();
      assert.deepEqual(report.listingPreview.price, { ...PRICE });
      const confirms = r.calls().filter((c) => c.tool === 'claude-confirm');
      assert.deepEqual(confirms.map((c) => [c.amount, c.subsidised, c.project]), [[319015, false, true], [270425, true, true]]);
      assert.ok(!report.warningCodes.includes('price-not-printed'));
    } finally { r.cleanup(); }
  });

  it('carries each photo\'s focus point into the listing', async () => {
    const r = await rig({ listing: answer({ price: { amount: null, currency: 'SAR', from: false, period: null, onRequest: true } }) });
    try {
      const report = await r.run();
      assert.deepEqual(report.listingPreview.images[1].focus, { x: 0.5, y: 0.8 });
    } finally { r.cleanup(); }
  });

  it('drops an unconfirmed subsidised price but keeps the confirmed headline price', async () => {
    const r = await rig({
      listing: answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' }, subsidisedPriceEvidence: { page: 3, quote: '270,425' } }),
      confirm: [319015],
    });
    try {
      const report = await r.run();
      assert.equal(report.listingPreview.price.amount, 319015);
      assert.equal('subsidisedAmount' in report.listingPreview.price, false);
      assert.ok(report.warningCodes.includes('subsidised-price-not-printed'));
    } finally { r.cleanup(); }
  });

  it('a subsidised price with no evidence at all is dropped', async () => {
    const r = await rig({ listing: answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' } }), confirm: [319015, 270425] });
    try {
      const report = await r.run();
      assert.equal(report.listingPreview.price.amount, 319015);
      assert.equal('subsidisedAmount' in report.listingPreview.price, false);
    } finally { r.cleanup(); }
  });

  it('an unconfirmed headline price takes the subsidised one down with it', async () => {
    const r = await rig({
      listing: answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' }, subsidisedPriceEvidence: { page: 3, quote: '270,425' } }),
      confirm: [270425],
    });
    try {
      const report = await r.run();
      const p = report.listingPreview.price;
      assert.equal(p.onRequest, true);
      assert.equal(p.amount, null);
      assert.equal('subsidisedAmount' in p, false);
      assert.ok(report.warningCodes.includes('price-not-printed'));
    } finally { r.cleanup(); }
  });

  it('evidence pointing at a page that was not rendered is not confirmed', async () => {
    const r = await rig({ listing: answer({ price: PRICE, priceEvidence: { page: 4, quote: '319,015' } }), confirm: [319015, 270425] });
    try {
      const report = await r.run();
      assert.equal(report.listingPreview.price.onRequest, true);
      assert.equal(r.calls().filter((c) => c.tool === 'claude-confirm').length, 0);
    } finally { r.cleanup(); }
  });

  it('a brochure whose single price is readable renders nothing extra and needs no second model', async () => {
    const pageText = ['مشروع سكني — شقق بغرفتي نوم — شقة سكنية بمساحة واسعة وتشطيبات حديثة في موقع مميز قريب من الخدمات', 'السعر 319,015 ريال\nشقة سكنية بمساحة واسعة وتشطيبات حديثة في موقع مميز قريب من الخدمات'];
    const price = { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false };
    const r = await rig({ pageText, listing: answer({ price }), confirm: [] });
    try {
      const report = await r.run();
      assert.equal(r.calls().filter((c) => c.tool === 'py-pages').length, 0);
      assert.deepEqual(report.listingPreview.price, price);
      assert.equal(r.calls().filter((c) => c.tool === 'claude-confirm').length, 0);
    } finally { r.cleanup(); }
  });

  it('readable prices beside subsidy wording are still confirmed on the page, evidence or not', async () => {
    const pageText = ['مشروع سكني — شقق بغرفتي نوم', 'السعر لمستفيدي الدعم 270,425 ريال\nالسعر لغير مستفيدي الدعم 319,015 ريال'];
    const r = await rig({ pageText, listing: answer({ price: PRICE }), confirm: [319015, 270425] });
    try {
      const report = await r.run();
      assert.deepEqual(r.calls().filter((c) => c.tool === 'py-pages').map((c) => c.pages), [[2]]);
      assert.deepEqual(report.listingPreview.price, PRICE);
      const confirms = r.calls().filter((c) => c.tool === 'claude-confirm');
      assert.deepEqual(confirms.map((c) => [c.amount, c.subsidised, c.mirror]), [[319015, false, true], [270425, true, false]]);
    } finally { r.cleanup(); }
  });

  it('a Sakani figure taken as the headline price is refused by the page check', async () => {
    const pageText = ['مشروع سكني — شقق بغرفتي نوم', 'السعر لمستفيدي الدعم 270,425 ريال\nالسعر لغير مستفيدي الدعم 319,015 ريال'];
    const price = { amount: 270425, currency: 'SAR', from: true, period: null, onRequest: false };
    const r = await rig({ pageText, listing: answer({ price }), confirm: [319015] });
    try {
      const report = await r.run();
      assert.equal(report.listingPreview.price.onRequest, true, 'the number is printed, but not as the price everyone pays');
      assert.ok(report.warningCodes.includes('price-not-printed'));
    } finally { r.cleanup(); }
  });

  it('a printed number that is not labelled as the subsidised price is not published as one', async () => {
    // Reviewer repro: a down payment the model mistook for the Sakani price, in a readable brochure.
    const pageText = ['فيلا للبيع في حي الشاطئ — شقة سكنية بمساحة واسعة وتشطيبات حديثة في موقع مميز قريب من الخدمات', 'السعر 1,500,000 ريال\nالدفعة الأولى 300,000 ريال\nشقة سكنية بمساحة واسعة وتشطيبات حديثة في موقع مميز قريب من الخدمات'];
    const price = { amount: 1500000, currency: 'SAR', from: false, period: null, onRequest: false, subsidisedAmount: 300000 };
    const r = await rig({ pageText, listing: answer({ price }), confirm: [1500000, 300000] });
    try {
      const report = await r.run();
      assert.equal(report.listingPreview.price.amount, 1500000);
      assert.equal('subsidisedAmount' in report.listingPreview.price, false);
      assert.ok(report.warningCodes.includes('subsidised-price-not-printed'));
    } finally { r.cleanup(); }
  });

  it('the "any unit model counts" allowance is only for a whole development quoted "from"', async () => {
    for (const [label, opts, project] of [
      ['whole development, from', { price: PRICE }, true],
      ['one unit of it', { price: PRICE, unit: { floor: 3, block: 'H', unitRef: null } }, false],
      ['not marked from', { price: { ...PRICE, from: false } }, false],
    ]) {
      const r = await rig({ listing: answer({ ...opts, priceEvidence: { page: 3, quote: '319,015' } }), confirm: [319015, 270425] });
      try {
        await r.run();
        const first = r.calls().find((c) => c.tool === 'claude-confirm');
        assert.equal(first.project, project, label);
      } finally { r.cleanup(); }
    }
  });
});

describe('processPdf: replacing a published listing in place (run-once --replace)', { timeout: 120000 }, () => {
  const SLUG = 'jeddah-heights-residential-community-jeddah';
  const git = (r, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: r.repo, stdio: 'pipe' }).toString();
  /** Seed the repo with the listing as the first run published it (same PDF, six photos and a stray seventh), committed. */
  const seed = (r, { nextSeq = 30, commit = true } = {}) => {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(r.pdfPath)).digest('hex');
    const inbox = path.join(r.repo, 'scripts', 'curate', 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, `${SLUG}.json`), JSON.stringify({
      id: 'BONA-W023', slug: SLUG, status: 'available', listedAt: '2026-11-17', sourceRef: 'WA-20261117-AC7D06',
      price: { amount: null, currency: 'SAR', from: false, period: null, onRequest: true }, videos: [], licence: null,
      _intake: { source: 'whatsapp', pdfSha256: sha },
    }));
    fs.writeFileSync(path.join(inbox, '_index.json'), JSON.stringify({ nextSeq, listings: { [SLUG]: 'BONA-W023' } }));
    const pub = path.join(r.repo, 'public', 'listings', SLUG);
    fs.mkdirSync(pub, { recursive: true });
    for (const f of ['01.jpg', '06.jpg', '07.jpg', '07-thumb.webp', 'brochure.pdf']) fs.writeFileSync(path.join(pub, f), 'old');
    if (commit) { git(r, 'init', '-q'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'intake: Jeddah Heights (BONA-W023)'); }
    return pub;
  };
  const META = { id: 'BONA-W023', slug: SLUG, listedAt: '2026-11-17', sourceRef: 'WA-20261117-AC7D06', replace: true };

  it('the same PDF is still refused as a duplicate without --replace', async () => {
    const r = await rig({ listing: answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' }, subsidisedPriceEvidence: { page: 3, quote: '270,425' } }), confirm: [319015, 270425] });
    try {
      seed(r);
      await assert.rejects(r.publish(), (err) => err.stage === 'duplicate' && /already published as BONA-W023/.test(err.reason));
    } finally { r.cleanup(); }
  });

  it('rewrites the listing under its own id, slug, date and reference, and drops the old photos', async () => {
    const r = await rig({ listing: answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' }, subsidisedPriceEvidence: { page: 3, quote: '270,425' } }), confirm: [319015, 270425] });
    try {
      const pub = seed(r);
      const report = await r.publish(META);
      assert.equal(report.id, 'BONA-W023');
      assert.equal(report.slug, SLUG);
      const saved = JSON.parse(fs.readFileSync(path.join(r.repo, 'scripts', 'curate', 'inbox', `${SLUG}.json`), 'utf8'));
      assert.equal(saved.id, 'BONA-W023');
      assert.equal(saved.listedAt, '2026-11-17');
      assert.equal(saved.sourceRef, 'WA-20261117-AC7D06');
      assert.deepEqual(saved.price, PRICE);
      assert.deepEqual(saved.images[1].focus, { x: 0.5, y: 0.8 });
      assert.deepEqual(fs.readdirSync(pub).filter((f) => f.endsWith('.jpg')).sort(), ['01.jpg', '02.jpg', '03.jpg', '04.jpg', '05.jpg', '06.jpg']);
      assert.equal(fs.existsSync(path.join(pub, '07-thumb.webp')), false, 'a photo the new run did not publish is gone');
      assert.equal(fs.existsSync(path.join(pub, 'brochure.pdf')), false, 'the old brochure is not left behind');
      const index = JSON.parse(fs.readFileSync(path.join(r.repo, 'scripts', 'curate', 'inbox', '_index.json'), 'utf8'));
      assert.equal(index.nextSeq, 30, 'replacing an old id never winds the counter back');
    } finally { r.cleanup(); }
  });

  it('refuses to replace a listing that is not there', async () => {
    const r = await rig({ listing: answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' } }), confirm: [319015] });
    try {
      await assert.rejects(r.publish(META), /BONA-W023.*not in the inbox|no inbox listing/i);
    } finally { r.cleanup(); }
  });
});

describe('processPdf --replace: what it refuses and how it rolls back', { timeout: 120000 }, () => {
  const SLUG = 'jeddah-heights-residential-community-jeddah';
  const META = { id: 'BONA-W023', slug: SLUG, listedAt: '2026-11-17', sourceRef: 'WA-20261117-AC7D06', replace: true };
  const git = (r, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: r.repo, stdio: 'pipe' }).toString();
  const seed = (r, { commit = true } = {}) => {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(r.pdfPath)).digest('hex');
    const inbox = path.join(r.repo, 'scripts', 'curate', 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, `${SLUG}.json`), JSON.stringify({ id: 'BONA-W023', slug: SLUG, listedAt: '2026-11-17', _intake: { pdfSha256: sha } }));
    fs.writeFileSync(path.join(inbox, '_index.json'), JSON.stringify({ nextSeq: 24, listings: { [SLUG]: 'BONA-W023' } }));
    const pub = path.join(r.repo, 'public', 'listings', SLUG);
    fs.mkdirSync(pub, { recursive: true });
    for (const f of ['01.jpg', '07.jpg', 'brochure.pdf']) fs.writeFileSync(path.join(pub, f), 'old');
    if (commit) { git(r, 'init', '-q'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'intake: Jeddah Heights (BONA-W023)'); }
    return pub;
  };
  const listing = () => answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' }, subsidisedPriceEvidence: { page: 3, quote: '270,425' } });

  it('refuses when the listing is not committed, before the model is paid', async () => {
    const r = await rig({ listing: listing(), confirm: [319015, 270425] });
    try {
      const pub = seed(r, { commit: false });
      git(r, 'init', '-q');
      await assert.rejects(r.publish(META), /uncommitted changes \(or is not in git\)/);
      assert.equal(fs.readFileSync(path.join(pub, '07.jpg'), 'utf8'), 'old', 'nothing was deleted');
      assert.equal(fs.existsSync(path.join(r.repo, '..', 'bin', 'calls.jsonl')), false, 'no extraction, no model call');
    } finally { r.cleanup(); }
  });

  it('refuses when the committed listing has local edits', async () => {
    const r = await rig({ listing: listing(), confirm: [319015, 270425] });
    try {
      const pub = seed(r);
      fs.writeFileSync(path.join(pub, '01.jpg'), 'edited by hand');
      await assert.rejects(r.publish(META), /uncommitted changes/);
    } finally { r.cleanup(); }
  });

  it('a failed rebuild puts the old listing back exactly', async () => {
    const r = await rig({ listing: listing(), confirm: [319015, 270425], build: 'process.exit(1);\n' });
    try {
      const pub = seed(r);
      const before = git(r, 'status', '--porcelain');
      await assert.rejects(r.publish(META));
      assert.equal(git(r, 'status', '--porcelain'), before, 'the clone is back to the commit');
      assert.equal(fs.readFileSync(path.join(pub, '07.jpg'), 'utf8'), 'old');
      assert.equal(fs.readFileSync(path.join(pub, 'brochure.pdf'), 'utf8'), 'old');
      assert.equal(fs.existsSync(path.join(pub, '02.jpg')), false, 'none of the new photos stayed');
    } finally { r.cleanup(); }
  });
});

describe('processPdf: round-2 review cases', { timeout: 120000 }, () => {
  const PAD = ' — شقة سكنية بمساحة واسعة وتشطيبات حديثة في موقع مميز قريب من الخدمات';

  it('"before/after subsidy" wording: the subsidised figure taken as the headline is refused on the page', async () => {
    const pageText = [`مشروع سكني${PAD}`, `السعر قبل الدعم 350,000 ريال\nالسعر بعد الدعم 270,425 ريال\n${PAD}`];
    const price = { amount: 270425, currency: 'SAR', from: true, period: null, onRequest: false };
    const r = await rig({ pageText, listing: answer({ price }), confirm: [350000] });
    try {
      const report = await r.run();
      assert.deepEqual(r.calls().filter((c) => c.tool === 'py-pages').map((c) => c.pages), [[2]]);
      assert.equal(report.listingPreview.price.onRequest, true);
    } finally { r.cleanup(); }
  });

  it('a Sakani footer on every page does not push the real price page out of the render budget', async () => {
    const pageText = Array.from({ length: 13 }, () => `مشروع سكني${PAD}\nبالشراكة مع منصة سكني`);
    pageText.push(`السعر 319,015 ريال\n${PAD}`);
    const price = { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false };
    const r = await rig({ pageText, listing: answer({ price }), confirm: [] });
    try {
      const report = await r.run();
      assert.equal(r.calls().filter((c) => c.tool === 'py-pages').length, 0);
      assert.equal(report.listingPreview.price.amount, 319015);
    } finally { r.cleanup(); }
  });

  it('evidence citing a page that was not rendered falls back to the rendered page carrying the number', async () => {
    const pageText = [`مشروع سكني${PAD}`, `السعر لمستفيدي الدعم 270,425 ريال\nالسعر لغير مستفيدي الدعم 319,015 ريال\n${PAD}`];
    const price = { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false };
    const r = await rig({ pageText, listing: answer({ price, priceEvidence: { page: 1, quote: '319,015' } }), confirm: [319015] });
    try {
      const report = await r.run();
      assert.equal(report.listingPreview.price.amount, 319015);
      assert.equal(r.calls().filter((c) => c.tool === 'claude-confirm').length, 1);
    } finally { r.cleanup(); }
  });

  it('the page check is told which listing — and which unit — the price is for', async () => {
    const r = await rig({ listing: answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' }, unit: { floor: 3, block: 'H', unitRef: 'H-12' } }), confirm: [319015, 270425] });
    try {
      await r.run();
      const first = r.calls().find((c) => c.tool === 'claude-confirm');
      assert.equal(first.subject, 'Jeddah Heights, Al Hamdaniyah — unit H-12, block H, floor 3');
    } finally { r.cleanup(); }
  });
});

describe('processPdf --replace: history and the CLI', { timeout: 120000 }, () => {
  const SLUG = 'jeddah-heights-residential-community-jeddah';
  const META = { id: 'BONA-W023', slug: SLUG, listedAt: '2026-11-17', sourceRef: 'WA-20261117-AC7D06', replace: true };
  const git = (r, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: r.repo, stdio: 'pipe' }).toString();
  const seed = (r) => {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(r.pdfPath)).digest('hex');
    const inbox = path.join(r.repo, 'scripts', 'curate', 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    const file = path.join(inbox, `${SLUG}.json`);
    fs.writeFileSync(file, JSON.stringify({ id: 'BONA-W023', slug: SLUG, listedAt: '2026-11-17', location: { district: { en: 'Al Rawabi' } }, _intake: { pdfSha256: sha } }));
    fs.writeFileSync(path.join(inbox, '_index.json'), JSON.stringify({ nextSeq: 24, listings: { [SLUG]: 'BONA-W023' } }));
    fs.mkdirSync(path.join(r.repo, 'public', 'listings', SLUG), { recursive: true });
    fs.writeFileSync(path.join(r.repo, 'public', 'listings', SLUG, '01.jpg'), 'old');
    git(r, 'init', '-q'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'intake: Jeddah Heights (BONA-W023)');
    return file;
  };

  it('refuses a listing that was corrected by hand after it was published', async () => {
    const r = await rig({ listing: answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' } }), confirm: [319015] });
    try {
      const file = seed(r);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Al Rawabi', 'Al Rehab'));
      git(r, 'commit', '-qam', 'district fix by hand');
      await assert.rejects(r.publish(META), /changed since it was published \(1 later commit\(s\), e\.g\. "district fix by hand"\)/);
    } finally { r.cleanup(); }
  });

  it('run-once --replace refuses a dirty publishing clone instead of discarding its changes', async () => {
    const r = await rig({ listing: answer({ price: PRICE }), confirm: [] });
    try {
      const file = seed(r);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Al Rawabi', 'Al Rehab (unsaved fix)'));
      const data = path.join(r.repo, '..', 'data');
      fs.mkdirSync(data);
      let out = '';
      try {
        execFileSync(process.execPath, [path.join(REPO, 'services', 'intake', 'run-once.mjs'), r.pdfPath, '--repo', r.repo, '--replace', 'BONA-W023', '--work', path.join(data, 'work')], {
          env: { ...process.env, BONA_DATA: data }, stdio: 'pipe',
        });
      } catch (err) { out = `${err.stdout}${err.stderr}`; }
      assert.match(out, /has uncommitted changes, which --replace will not discard/);
      assert.match(fs.readFileSync(file, 'utf8'), /unsaved fix/, 'the change is still there');
    } finally { r.cleanup(); }
  });

  it('run-once refuses --replace with --no-git', () => {
    let out = '';
    try {
      execFileSync(process.execPath, [path.join(REPO, 'services', 'intake', 'run-once.mjs'), path.join(REPO, 'package.json'), '--no-git', '--replace', 'BONA-W023'], { stdio: 'pipe' });
    } catch (err) { out = `${err.stdout}${err.stderr}`; }
    assert.match(out, /--replace needs git/);
  });

  it('run-once treats `--replace --dry-run` as a usage error, not as the id', () => {
    for (const flag of ['--replace', '--enrich']) {
      let out = '';
      let code = 0;
      try {
        execFileSync(process.execPath, [path.join(REPO, 'services', 'intake', 'run-once.mjs'), path.join(REPO, 'package.json'), flag, '--dry-run'], { stdio: 'pipe' });
      } catch (err) { out = `${err.stdout}${err.stderr}`; code = err.status; }
      assert.equal(code, 2, flag);
      assert.match(out, new RegExp(`${flag} needs a listing id`));
    }
  });
});

describe('processPdf: round-3 review cases', { timeout: 120000 }, () => {
  const PAD = ' — شقة سكنية بمساحة واسعة وتشطيبات حديثة في موقع مميز قريب من الخدمات';
  const SLUG = 'jeddah-heights-residential-community-jeddah';
  const META = { id: 'BONA-W023', slug: SLUG, listedAt: '2026-11-17', sourceRef: 'WA-20261117-AC7D06', replace: true };
  const git = (r, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: r.repo, stdio: 'pipe' }).toString();
  const seed = (r, { init = true } = {}) => {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(r.pdfPath)).digest('hex');
    const inbox = path.join(r.repo, 'scripts', 'curate', 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, `${SLUG}.json`), JSON.stringify({ id: 'BONA-W023', slug: SLUG, listedAt: '2026-11-17', _intake: { pdfSha256: sha } }));
    fs.writeFileSync(path.join(inbox, '_index.json'), JSON.stringify({ nextSeq: 24, listings: { [SLUG]: 'BONA-W023' } }));
    const pub = path.join(r.repo, 'public', 'listings', SLUG);
    fs.mkdirSync(pub, { recursive: true });
    fs.writeFileSync(path.join(pub, '01.jpg'), 'old');
    if (init) { git(r, 'init', '-q'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'intake: Jeddah Heights (BONA-W023)'); }
    return pub;
  };
  const listing = () => answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' }, subsidisedPriceEvidence: { page: 3, quote: '270,425' } });

  it('a subsidy table with no price word: the subsidised figure as headline is refused on the page', async () => {
    const pageText = [`مشروع سكني${PAD}`, `لمستفيدي الدعم\n270,425\nلغير مستفيدي الدعم\n319,015\n${PAD}`];
    const r = await rig({ pageText, listing: answer({ price: { amount: 270425, currency: 'SAR', from: true, period: null, onRequest: false } }), confirm: [319015] });
    try {
      const report = await r.run();
      assert.deepEqual(r.calls().filter((c) => c.tool === 'py-pages').map((c) => c.pages), [[2]]);
      assert.equal(report.listingPreview.price.onRequest, true);
    } finally { r.cleanup(); }
  });

  it('a price the check took away cannot stay in the copy', async () => {
    const pageText = [`مشروع سكني${PAD}`, `غرفتا نوم ودورتا مياه${PAD}`];
    const a = answer({ price: { amount: 1250000, currency: 'SAR', from: false, period: null, onRequest: false } });
    a.listing.description.en = ['The asking figure is 1,250,000 for this unit.', 'Two.']; // no price word: still the refused price
    const r = await rig({ pageText, listing: a, confirm: [] });
    try {
      await assert.rejects(r.run(), (err) => err.stage === 'price' && /copy states the price 1,250,000/.test(err.reason));
    } finally { r.cleanup(); }
  });

  it('r8 #3 (Claude r7 B2): …nor written with a plural scale, "from 4.5 millions"', async () => {
    const pageText = [`مشروع سكني${PAD}`, `غرفتا نوم ودورتا مياه${PAD}`];
    const a = answer({ price: { amount: 4500000, currency: 'SAR', from: true, period: null, onRequest: false } });
    a.listing.description.en = ['Townhouses from 4.5 millions.', 'Two.']; // no currency: the copy guard lets it by, refusedFigureIn must not
    const r = await rig({ pageText, listing: a, confirm: [] });
    try {
      await assert.rejects(r.run(), (err) => err.stage === 'price' && /copy states the price 4,500,000/.test(err.reason));
    } finally { r.cleanup(); }
  });

  it('refuses a listing whose photos were fixed by hand after it was published', async () => {
    const r = await rig({ listing: listing(), confirm: [319015, 270425] });
    try {
      const pub = seed(r);
      fs.writeFileSync(path.join(pub, '01.jpg'), 're-cropped');
      git(r, 'commit', '-qam', 'W023 re-crop');
      await assert.rejects(r.publish(META), /1 later commit\(s\), e\.g\. "W023 re-crop"/);
    } finally { r.cleanup(); }
  });

  it('a listing that was only ever replaced by the intake can be replaced again', async () => {
    const r = await rig({ listing: listing(), confirm: [319015, 270425] });
    try {
      const pub = seed(r);
      fs.writeFileSync(path.join(pub, '01.jpg'), 'first replacement');
      git(r, 'commit', '-qam', 'intake: replace Jeddah Heights (BONA-W023)');
      const report = await r.publish(META);
      assert.equal(report.id, 'BONA-W023');
    } finally { r.cleanup(); }
  });

  it('a --replace dry run does not need git', async () => {
    const r = await rig({ listing: listing(), confirm: [319015, 270425] });
    try {
      seed(r, { init: false });
      const report = await processPdf({ pdfPath: r.pdfPath, cfg: { ...JSON.parse('{}'), ...r.cfg }, caption: {}, workDir: path.join(r.repo, '..', 'work'), dryRun: true, meta: META });
      assert.equal(report.id, 'BONA-W023');
    } finally { r.cleanup(); }
  });
});

describe('processPdf: round-4 review cases', { timeout: 120000 }, () => {
  const PAD = ' — شقة سكنية بمساحة واسعة وتشطيبات حديثة في موقع مميز قريب من الخدمات';
  const SLUG = 'jeddah-heights-residential-community-jeddah';
  const META = { id: 'BONA-W023', slug: SLUG, listedAt: '2026-11-17', sourceRef: 'WA-20261117-AC7D06', replace: true };
  const git = (r, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: r.repo, stdio: 'pipe' }).toString();

  for (const [form, a, b] of [['space', '270 425', '319 015'], ['dot', '270.425', '319.015'], ['decimals', '270,425.00', '319,015.00']]) {
    it(`a subsidy table written with ${form} grouping is still checked on the page`, async () => {
      const pageText = [`مشروع سكني${PAD}`, `لمستفيدي الدعم\n${a}\nلغير مستفيدي الدعم\n${b}\n${PAD}`];
      const r = await rig({ pageText, listing: answer({ price: { amount: 270425, currency: 'SAR', from: true, period: null, onRequest: false } }), confirm: [319015] });
      try {
        const report = await r.run();
        assert.deepEqual(r.calls().filter((c) => c.tool === 'py-pages').map((c) => c.pages), [[2]]);
        assert.equal(report.listingPreview.price.onRequest, true);
      } finally { r.cleanup(); }
    });
  }

  it('a refused price stated with a price word is caught too', async () => {
    const pageText = [`مشروع سكني${PAD}`, `غرفتا نوم ودورتا مياه${PAD}`];
    const a = answer({ price: { amount: 1250000, currency: 'SAR', from: false, period: null, onRequest: false } });
    a.listing.description.ar = ['قيمة الوحدة 1,250,000 فقط.', 'اثنان.'];
    const r = await rig({ pageText, listing: a, confirm: [] });
    try {
      await assert.rejects(r.run(), (err) => err.stage === 'price');
    } finally { r.cleanup(); }
  });

  it('a refused price that only matches an area in the copy does not reject the run', async () => {
    const pageText = [`مشروع سكني${PAD}`, `غرفتا نوم ودورتا مياه${PAD}`];
    const a = answer({ price: { amount: 3000000, currency: 'SAR', from: false, period: null, onRequest: false } });
    a.listing.description.en = ['The master plan spans more than 3 million square metres.', 'Two.'];
    const r = await rig({ pageText, listing: a, confirm: [] });
    try {
      const report = await r.run();
      assert.equal(report.listingPreview.price.onRequest, true);
    } finally { r.cleanup(); }
  });

  const withCopy = async (r, line) => {
    const f = path.join(r.repo, '..', 'bin', 'fake.json');
    const a = JSON.parse(fs.readFileSync(f, 'utf8'));
    a.listing.listing.highlights.en[0] = line;
    fs.writeFileSync(f, JSON.stringify(a));
  };
  const captioned = (r) => processPdf({ pdfPath: r.pdfPath, cfg: r.cfg, caption: { price: { amount: 300000, currency: 'SAR' }, text: '300000' }, workDir: path.join(r.repo, '..', 'work'), dryRun: true });

  it('under the owner\'s caption price, an unconfirmed Sakani figure in the copy is still refused', async () => {
    const r = await rig({ listing: answer({ price: PRICE }), confirm: [] });
    try {
      await withCopy(r, 'Sakani beneficiaries: 270,425');
      await assert.rejects(captioned(r), (err) => err.stage === 'price' && /270,425.*send it again/.test(err.reason));
    } finally { r.cleanup(); }
  });

  it('under the owner\'s caption price, a Sakani figure confirmed on the page may stay in the copy', async () => {
    const r = await rig({ listing: answer({ price: PRICE, subsidisedPriceEvidence: { page: 3, quote: '270,425' } }), confirm: [], confirmSub: [270425] });
    try {
      await withCopy(r, 'Sakani beneficiaries: 270,425');
      const report = await captioned(r);
      assert.equal(report.listingPreview.price.amount, 300000);
      assert.equal('subsidisedAmount' in report.listingPreview.price, false, 'the caption price replaces both');
    } finally { r.cleanup(); }
  });

  for (const line of ['Two-bedroom apartments from 319,015 in phase one.', 'Villas from 1.2 million in phase one.', 'فلل من 1.2 مليون في المرحلة الأولى.', 'Units go for 319,015 each']) {
    it(`a refused price in the copy is caught however it is worded: ${line}`, async () => {
      const amount = /1\.2/.test(line) ? 1200000 : 319015;
      const r = await rig({ listing: answer({ price: { amount, currency: 'SAR', from: true, period: null, onRequest: false } }), confirm: [] });
      try {
        await withCopy(r, line);
        await assert.rejects(r.run(), (err) => err.stage === 'price');
      } finally { r.cleanup(); }
    });
  }

  it('refuses a listing whose history does not start at the intake\'s publish commit (a hand rename)', async () => {
    const r = await rig({ listing: answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' } }), confirm: [319015, 270425] });
    try {
      const sha = crypto.createHash('sha256').update(fs.readFileSync(r.pdfPath)).digest('hex');
      const inbox = path.join(r.repo, 'scripts', 'curate', 'inbox');
      fs.mkdirSync(inbox, { recursive: true });
      fs.writeFileSync(path.join(inbox, `${SLUG}.json`), JSON.stringify({ id: 'BONA-W023', slug: SLUG, listedAt: '2026-11-17', _intake: { pdfSha256: sha } }));
      fs.mkdirSync(path.join(r.repo, 'public', 'listings', SLUG), { recursive: true });
      fs.writeFileSync(path.join(r.repo, 'public', 'listings', SLUG, '01.jpg'), 'old');
      git(r, 'init', '-q'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'Rename W023 and fix its district by hand');
      await assert.rejects(r.publish(META), /history starts at "Rename W023/);
    } finally { r.cleanup(); }
  });
});

describe('processPdf: round-6 review cases', { timeout: 120000 }, () => {
  const PAD = ' — شقة سكنية بمساحة واسعة وتشطيبات حديثة في موقع مميز قريب من الخدمات';
  const pageText = [`مشروع سكني${PAD}`, `غرفتا نوم ودورتا مياه${PAD}`];
  const withLine = (amount, line) => {
    const a = answer({ price: { amount, currency: 'SAR', from: true, period: null, onRequest: false } });
    a.listing.description.en = [line, 'Two.'];
    return a;
  };

  for (const [line, amount] of [
    ['The asking figure is 1,250,000 for a 120 m² apartment', 1250000],
    ['Two-bedroom apartments of 120 m² from 319,015', 319015],
    ['1,710 units from 319,015 each', 319015],
    ['Villas of 400 m² from 1.2 million', 1200000],
    ['Four-bedroom villas from 4.5m.', 4500000],
    ['Townhouses from 2.8M, ready in 2027.', 2800000],
  ]) {
    it(`an area elsewhere in the sentence does not excuse a refused price: ${line}`, async () => {
      const r = await rig({ pageText, listing: withLine(amount, line), confirm: [] });
      try {
        await assert.rejects(r.run(), (err) => err.stage === 'price');
      } finally { r.cleanup(); }
    });
  }

  for (const [line, amount] of [['يمتد المخطط على ٣ ملايين متر مربع', 3000000], ['The project plants 1 million trees', 1000000], ['Every plot faces a 20 m street', 20000000]]) {
    it(`a measurement that equals the refused price is not the price: ${line}`, async () => {
      const r = await rig({ pageText, listing: withLine(amount, line), confirm: [] });
      try {
        const report = await r.run();
        assert.equal(report.listingPreview.price.onRequest, true);
      } finally { r.cleanup(); }
    });
  }

  it('under the owner\'s caption price, the model\'s own unprinted figure in the copy is refused', async () => {
    const r = await rig({ pageText, listing: withLine(319015, 'Two-bedroom apartments from 319,015 in phase one.'), confirm: [] });
    try {
      await assert.rejects(
        processPdf({ pdfPath: r.pdfPath, cfg: r.cfg, caption: { price: { amount: 300000, currency: 'SAR' }, text: '300000' }, workDir: path.join(r.repo, '..', 'work'), dryRun: true }),
        (err) => err.stage === 'price' && /319,015/.test(err.reason),
      );
    } finally { r.cleanup(); }
  });
});

describe('processPdf: unit-model prices (every figure confirmed on its page, one call per page)', { timeout: 120000 }, () => {
  const ON_REQUEST = { amount: null, currency: 'SAR', from: false, period: null, onRequest: true };
  const model = (en, price, subsidisedPrice, page) => ({
    name: { en, ar: `نموذج ${en}` }, bedrooms: 2, bathrooms: 2, areaSqm: 105, rooms: null, availability: null,
    price, subsidisedPrice, evidence: page ? { page, quote: String(price) } : null, floorPlan: null,
  });
  const withModels = (models, opts = {}) => ({ ...answer({ price: ON_REQUEST, ...opts }), models });
  const modelCalls = (r) => r.calls().filter((c) => c.tool === 'claude-model-confirm');

  it('two models on the scrambled price page: ONE check, headline = the cheaper model, from', async () => {
    const r = await rig({ listing: withModels([model('Nawras', 419994, 356024, 3), model('Lulu', 319015, 270425, 3)]) });
    try {
      const report = await r.run();
      const checks = modelCalls(r);
      assert.equal(checks.length, 1, 'one call for the page, however many models are on it');
      assert.equal(checks[0].page, 3);
      assert.deepEqual(checks[0].items, [{ i: 0, price: 419994, subsidisedPrice: 356024 }, { i: 1, price: 319015, subsidisedPrice: 270425 }]);
      assert.deepEqual(report.listingPreview.price, { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false, subsidisedAmount: 270425 });
      assert.deepEqual(report.ai.models.map((m) => [m.price, m.subsidisedPrice]), [[419994, 356024], [319015, 270425]]);
      assert.equal(r.calls().filter((c) => c.tool === 'claude-confirm').length, 0, 'the headline is the confirmed model figure: no second check');
      assert.ok(!report.warningCodes.includes('model-price-not-printed'));
      assert.deepEqual(report.modelPrices, { models: 2, calls: 1, refused: [], incomplete: [], incompletePages: [], fatal: false, tooMany: null });
      assert.deepEqual(report.priceEvidence, { inText: false, confirmed: true, fromModels: true }, 'the { inText, confirmed } shape stays');
    } finally { r.cleanup(); }
  });

  it('a model price the page check refuses is dropped, and the headline comes from the other model', async () => {
    const r = await rig({
      listing: withModels([model('Nawras', 419994, 356024, 3), model('Lulu', 319015, 270425, 3)]),
      modelConfirm: [419994, 356024, 270425],
    });
    try {
      const report = await r.run();
      assert.deepEqual(report.ai.models.map((m) => [m.price, m.subsidisedPrice]), [[419994, 356024], [null, null]], 'a Sakani price never outlives its model\'s price');
      assert.deepEqual(report.listingPreview.price, { amount: 419994, currency: 'SAR', from: true, period: null, onRequest: false, subsidisedAmount: 356024 });
      assert.ok(report.warningCodes.includes('model-price-not-printed'));
      assert.ok(report.listingPreview._intake.warnings.includes('model-price-not-printed'));
      assert.deepEqual(report.modelPrices.refused.sort(), [270425, 319015]);
    } finally { r.cleanup(); }
  });

  it('evidence citing a page that was not rendered (no price on it in the text) renders that page and checks it', async () => {
    const r = await rig({ listing: withModels([model('Lulu', 319015, 270425, 3), model('Corner', 299000, null, 2)]) });
    try {
      const report = await r.run();
      assert.deepEqual(r.calls().filter((c) => c.tool === 'py-pages').map((c) => c.pages), [[3, 5], [2]]);
      assert.deepEqual(report.modelPages, [2]);
      assert.deepEqual(modelCalls(r).map((c) => c.page).sort(), [2, 3]);
      assert.deepEqual(modelCalls(r).find((c) => c.page === 2).items, [{ i: 1, price: 299000, subsidisedPrice: null }]);
      assert.equal(report.listingPreview.price.amount, 299000);
      assert.equal(report.listingPreview.price.subsidisedAmount, 270425);
    } finally { r.cleanup(); }
  });

  it('the owner\'s caption price drops every model price, with no page check', async () => {
    const r = await rig({ listing: withModels([model('Nawras', 419994, 356024, 3), model('Lulu', 319015, 270425, 3)]) });
    try {
      const report = await processPdf({ pdfPath: r.pdfPath, cfg: r.cfg, caption: { price: { amount: 300000, currency: 'SAR' }, text: '300000' }, workDir: path.join(r.repo, '..', 'work'), dryRun: true });
      assert.equal(modelCalls(r).length, 0);
      assert.deepEqual(report.ai.models.map((m) => [m.price, m.subsidisedPrice]), [[null, null], [null, null]]);
      assert.equal(report.listingPreview.price.amount, 300000);
      assert.ok(!report.warningCodes.includes('model-price-not-printed'));
    } finally { r.cleanup(); }
  });

  it('a refused model price stated in the copy refuses the run', async () => {
    const a = withModels([model('Nawras', 419994, null, 3), model('Lulu', 319015, null, 3)]);
    a.listing.description.en = ['Two-bedroom apartments from 319,015 in phase one.', 'Two.'];
    const r = await rig({ listing: a, modelConfirm: [419994] });
    try {
      await assert.rejects(r.run(), (err) => err.stage === 'price' && /copy states the price 319,015/.test(err.reason));
    } finally { r.cleanup(); }
  });

  it('a figure refused for one model but confirmed for another may stay in the copy', async () => {
    const a = withModels([model('Lulu', 319015, null, 3), model('Lulu corner', 319015, null, 3)]);
    a.listing.description.en = ['Two-bedroom apartments from 319,015 in phase one.', 'Two.'];
    const r = await rig({ listing: a, modelConfirm: { 1: { price: false } } });
    try {
      const report = await r.run();
      assert.deepEqual(report.ai.models.map((m) => m.price), [319015, null]);
      assert.equal(report.listingPreview.price.amount, 319015);
      assert.ok(report.warningCodes.includes('model-price-not-printed'));
    } finally { r.cleanup(); }
  });

  it('the model\'s own headline figure, replaced by the models, must still be printed if the copy states it', async () => {
    const a = withModels([model('Lulu', 319015, null, 3)], { price: { amount: 300000, currency: 'SAR', from: true, period: null, onRequest: false } });
    a.listing.description.en = ['Two-bedroom apartments from 300,000 in phase one.', 'Two.'];
    const r = await rig({ listing: a });
    try {
      await assert.rejects(r.run(), (err) => err.stage === 'price' && /copy states the price 300,000/.test(err.reason));
    } finally { r.cleanup(); }
  });

  it('a reading on request whose currency is only the default (a property abroad): no model price, no page check, decision logged', async () => {
    const a = withModels([model('Nawras', 419994, null, 3), model('Lulu', 319015, null, 3)]);
    a.listing.location = {
      district: { en: 'Hampstead', ar: 'هامبستيد' }, city: { en: 'London', ar: 'لندن' },
      country: { en: 'United Kingdom', ar: 'المملكة المتحدة' }, countryCode: 'GB',
    };
    const r = await rig({ listing: a });
    try {
      const report = await r.run();
      assert.equal(modelCalls(r).length, 0, 'no figure is checked that will not be published');
      assert.deepEqual(report.ai.models.map((m) => [m.price, m.subsidisedPrice]), [[null, null], [null, null]]);
      assert.deepEqual(report.listingPreview.price, ON_REQUEST, 'the headline is not aligned with the models');
      assert.equal(report.modelPrices.decision, 'currency-unconfirmed');
      assert.deepEqual(report.modelPrices.currency, { reading: 'SAR', established: false, listing: null });
      assert.ok(report.warningCodes.includes('model-price-not-printed'));
      assert.ok(report.warnings.some((w) => /their currency could not be established/.test(w)), report.warnings.join(' | '));
    } finally { r.cleanup(); }
  });

  it('…and a copy that states one of those figures refuses the run (it was never confirmed)', async () => {
    const a = withModels([model('Nawras', 419994, null, 3), model('Lulu', 319015, null, 3)]);
    a.listing.location = { ...a.listing.location, countryCode: 'GB' };
    a.listing.description.en = ['Two-bedroom apartments from 319,015 in phase one.', 'Two.'];
    const r = await rig({ listing: a });
    try {
      await assert.rejects(r.run(), (err) => err.stage === 'price' && /copy states the price 319,015/.test(err.reason));
    } finally { r.cleanup(); }
  });

  it('a reading with a headline price in its own currency keeps that currency for the models (AED), confirmed IN AED', async () => {
    // By the prompt: the headline is the cheapest model, from, in the brochure's currency.
    const reading = () => withModels([model('Nawras', 419994, null, 3), model('Lulu', 319015, null, 3)], { price: { amount: 319015, currency: 'AED', from: true, period: null, onRequest: false } });
    const r = await rig({ listing: reading(), printedIn: 'AED' });
    try {
      const report = await r.run();
      assert.equal(modelCalls(r).length, 1);
      assert.equal(modelCalls(r)[0].currency, 'AED');
      assert.equal(modelCalls(r)[0].bare, false, 'a bare figure is not AED on a Saudi listing');
      assert.deepEqual(report.listingPreview.price, { amount: 319015, currency: 'AED', from: true, period: null, onRequest: false });
      assert.equal(report.modelPrices.decision, undefined);
    } finally { r.cleanup(); }
    // The same reading of a brochure that prints riyals: no figure is an AED price.
    const sar = await rig({ listing: reading(), printedIn: 'SAR' });
    try {
      const report = await sar.run();
      assert.deepEqual(report.ai.models.map((m) => m.price), [null, null]);
      assert.equal(report.listingPreview.price.onRequest, true);
    } finally { sar.cleanup(); }
  });

  it('r3 #2: a refused model price, or a refused headline, left bare in a model\'s rooms / availability or a fact list is DROPPED before the copy guard — the run goes on', async () => {
    const a = withModels([model('Nawras', 419994, 356024, 3), model('Lulu', 319015, 270425, 3)]);
    a.models[0].availability = { en: 'Buildings G–P, 419,994 / 356,024', ar: 'المباني G–P، 419,994' };
    a.models[0].rooms = { en: ['Maid room', 'Paid 419,994'], ar: ['غرفة خادمة', 'غرفة'] };
    a.amenities = { en: ['Club fee SAR 1,500', 'Gym'], ar: ['رسوم النادي 1,500 ريال', 'نادٍ'] };
    const r = await rig({ listing: a, modelConfirm: [319015, 270425, 356024] });
    try {
      const report = await r.run();
      assert.deepEqual(report.listingPreview.models.map((m) => [m.price, m.availability, m.rooms]), [[null, null, null], [319015, null, null]]);
      assert.deepEqual(report.listingPreview.amenities, { en: ['Gym'], ar: ['نادٍ'] }, '"Club fee SAR 1,500" no longer fails the AI contract: it is dropped');
    } finally { r.cleanup(); }
    const b = answer({ price: { amount: 50000, currency: 'SAR', from: false, period: null, onRequest: false } });
    b.amenities = { en: ['Down payment 50,000', 'Pool'], ar: ['دفعة أولى 50,000', 'مسبح'] };
    const t = await rig({ listing: b });
    try {
      const report = await t.run();
      assert.equal(report.listingPreview.price.onRequest, true);
      assert.deepEqual(report.listingPreview.amenities, { en: ['Pool'], ar: ['مسبح'] });
    } finally { t.cleanup(); }
  });

  it('r2 #4: even a CONFIRMED model figure is not published in its availability — prices live in the price fields only', async () => {
    // (Before r2 #4 it was kept: then `price <id> onrequest` cleared the price and left the figure in the text.)
    const a = withModels([model('Nawras', 419994, 356024, 3), model('Lulu', 319015, 270425, 3)]);
    a.models[0].availability = { en: 'Buildings G–P, 419,994 / 356,024', ar: 'المباني G–P، 419,994' };
    const r = await rig({ listing: a });
    try {
      const report = await r.run();
      assert.equal(report.listingPreview.models[0].price, 419994);
      assert.equal(report.listingPreview.models[0].availability, null);
    } finally { r.cleanup(); }
  });

  it('Codex r1 #2: a rental\'s model figure printed per another period is refused — the listing\'s period is the one confirmed', async () => {
    const reading = (period) => {
      const a = withModels([model('Studio', 5000, null, 3), model('Villa', 60000, null, 3)], { price: { amount: 5000, currency: 'SAR', from: true, period, onRequest: false } });
      a.listing.category = 'rent';
      return a;
    };
    // One layout at SAR 5,000 a month, another at SAR 60,000 a year, on one page.
    const facts = { 3: [{ fig: 5000, mark: 'SAR', kind: 'model', model: 'Studio', per: 'month' }, { fig: 60000, mark: 'SAR', kind: 'model', model: 'Villa', per: 'year' }] };
    const r = await rig({ listing: reading('month'), facts });
    try {
      const report = await r.run();
      assert.deepEqual(modelCalls(r).map((c) => c.period), ['month']);
      assert.deepEqual(report.listingPreview.models.map((m) => m.price), [5000, null], 'SAR 60,000 a year is never published as SAR 60,000 a month');
      assert.deepEqual(report.listingPreview.price, { amount: 5000, currency: 'SAR', from: true, period: 'month', onRequest: false });
      assert.deepEqual(checkListing(report.listingPreview), []);
    } finally { r.cleanup(); }
    // The owner's caption says yearly: the listing is published per year, so that is the period checked.
    const y = await rig({ listing: reading('month'), facts });
    try {
      const report = await processPdf({ pdfPath: y.pdfPath, cfg: y.cfg, caption: { category: 'rent', period: 'year', text: '' }, workDir: path.join(y.repo, '..', 'work'), dryRun: true });
      assert.deepEqual(modelCalls(y).map((c) => c.period), ['year']);
      assert.deepEqual(report.listingPreview.models.map((m) => m.price), [null, 60000]);
      assert.deepEqual(report.listingPreview.price, { amount: 60000, currency: 'SAR', from: true, period: 'year', onRequest: false });
    } finally { y.cleanup(); }
  });

  it('r3 #4: a rental\'s headline is never settled by the text layer — with or without unit models, it needs the page, for the period', async () => {
    const textPages = (p3) => [`Overview\n${'A residential compound for rent. '.repeat(4)}`, 'Location', p3, 'Specification', 'Contact'];
    const rental = (models = []) => {
      const a = withModels(models, { price: { amount: 60000, currency: 'SAR', from: false, period: 'year', onRequest: false }, priceEvidence: { page: 3, quote: 'SAR 60,000' } });
      a.listing.category = 'rent';
      return a;
    };
    const yearly = { 3: [{ fig: 60000, mark: 'SAR', kind: 'whole', per: 'year' }] };
    const run = (r, caption) => processPdf({ pdfPath: r.pdfPath, cfg: r.cfg, caption, workDir: path.join(r.repo, '..', 'work'), dryRun: true });
    for (const models of [[], [{ ...model('Studio', null, null, null), price: null }]]) {
      // Caption "rent per month"; the brochure prints SAR 60,000 a year, in its text layer too: never SAR 60,000 a month.
      const r = await rig({ listing: rental(models), pageText: textPages('Annual rent SAR 60,000'), facts: yearly });
      try {
        const report = await run(r, { category: 'rent', period: 'month', text: '' });
        assert.equal(report.priceEvidence.inText, false, `${models.length} model(s): the text layer cannot say which period`);
        assert.equal(report.listingPreview.price.onRequest, true, `${models.length} model(s)`);
      } finally { r.cleanup(); }
      // No caption: the reading's own period (a year) is the one checked — and published.
      const y = await rig({ listing: rental(models), pageText: textPages('Annual rent SAR 60,000'), facts: yearly });
      try {
        const report = await run(y, {});
        assert.deepEqual(report.listingPreview.price, { amount: 60000, currency: 'SAR', from: false, period: 'year', onRequest: false });
        assert.ok(y.calls().some((c) => c.tool === 'claude-confirm' && c.amount === 60000), 'a page check, not the text layer');
      } finally { y.cleanup(); }
    }
  });

  it('r5 #9 (r6 #3): a reading period on a sale is never a rent period in a prompt — it sends the headline to its page, asked as a sale', async () => {
    const sale = (period, amount, quote) => {
      const a = withModels([], { price: { amount, currency: 'SAR', from: false, period, onRequest: false }, priceEvidence: { page: 3, quote } });
      a.listing.category = 'buy';
      return a;
    };
    const outcome = async (opts) => {
      const r = await rig(opts);
      try {
        const report = await r.run();
        return { evidence: report.priceEvidence, price: report.listingPreview.price, warnings: report.warningCodes, checks: r.calls().filter((c) => c.tool === 'claude-confirm') };
      } finally { r.cleanup(); }
    };
    // Printed in the text layer: settled there, no page check.
    const textPages = ['Overview\nA residential compound for sale. A residential compound for sale.', 'Location', 'Price SAR 60,000', 'Specification', 'Contact'];
    const plain = await outcome({ listing: sale(null, 60000, 'SAR 60,000'), pageText: textPages, confirm: [60000] });
    assert.deepEqual(plain.evidence, { inText: true, confirmed: null });
    assert.deepEqual(plain.checks, []);
    assert.deepEqual(plain.price, { amount: 60000, currency: 'SAR', from: false, period: null, onRequest: false });
    // The same sale read "per year" (r6 #3): the reading says it may be a rent, so only its page settles it — asked
    // as a sale's price, with no rent period — and published as a sale, with no period.
    const yearly = await outcome({ listing: sale('year', 60000, 'SAR 60,000'), pageText: textPages, confirm: [60000] });
    assert.deepEqual(yearly.evidence, { inText: false, confirmed: true });
    assert.deepEqual(yearly.checks.map((c) => [c.amount, c.period, c.whole, c.sale]), [[60000, null, false, true]]);
    assert.deepEqual(yearly.price, plain.price);
    // r7 #6 (Claude r6 B8): the comparisons the r6 #3 rewrite dropped — the period adds no warning.
    assert.deepEqual(yearly.warnings, plain.warnings);
    // Printed on a page only: the page check is the ordinary one, with no rent period in its prompt — and, like every
    // price check on a listing for sale, asked as a sale (r7 #6, Claude r6 B2a: before, only a reading with a period was).
    const paged = await outcome({ listing: sale(null, 319015, '319015'), confirm: [319015] });
    assert.deepEqual(paged.checks.map((c) => [c.amount, c.period, c.whole, c.sale]), [[319015, null, false, true]]);
    assert.equal(paged.price.amount, 319015);
    const monthly = await outcome({ listing: sale('month', 319015, '319015'), confirm: [319015] });
    assert.deepEqual(monthly.checks.map((c) => [c.amount, c.period, c.whole, c.sale]), [[319015, null, false, true]]);
    assert.deepEqual(monthly.price, paged.price);
    // r7 #6 (Claude r6 B8): …and the same evidence and warnings as without the period.
    assert.deepEqual(monthly.evidence, paged.evidence);
    assert.deepEqual(monthly.warnings, paged.warnings);
  });

  it('r6 #3: a sale headline read with a period, or printed or quoted as a rent or income, is settled only on its page, asked as a sale', async () => {
    const sale = (period, quote, category = 'buy', amount = 60000) => {
      const a = withModels([], { price: { amount, currency: 'SAR', from: false, period, onRequest: false }, priceEvidence: { page: 3, quote } });
      a.listing.category = category;
      return a;
    };
    const pages = (p3) => ['Overview\nA residential compound for sale. A residential compound for sale.', 'Location', p3, 'Specification', 'Contact'];
    const outcome = async (opts) => {
      const r = await rig(opts);
      try {
        const report = await r.run();
        return { evidence: report.priceEvidence, price: report.listingPreview.price, warnings: report.warningCodes, checks: r.calls().filter((c) => c.tool === 'claude-confirm') };
      } finally { r.cleanup(); }
    };
    // buy + "year" + "Annual rent SAR 60,000": the second model refuses — on request, "not printed".
    const refused = await outcome({ listing: sale('year', 'Annual rent SAR 60,000'), pageText: pages('Annual rent SAR 60,000'), confirm: [] });
    assert.equal(refused.evidence.inText, false, 'the text layer never settles it');
    assert.deepEqual(refused.checks.map((c) => [c.amount, c.period, c.sale]), [[60000, null, true]]);
    assert.equal(refused.price.onRequest, true);
    assert.equal(refused.price.amount, null);
    assert.ok(refused.warnings.includes('price-not-printed'));
    // …and when the second model confirms it on its page, the price is kept (as a sale: no period).
    const kept = await outcome({ listing: sale('year', 'Annual rent SAR 60,000'), pageText: pages('Annual rent SAR 60,000'), confirm: [60000] });
    assert.equal(kept.checks.length, 1);
    assert.deepEqual(kept.price, { amount: 60000, currency: 'SAR', from: false, period: null, onRequest: false });
    // No period: the line printing the figure says rent or income, or names a rent period (one list with the free-text
    // rule: r7 #5), or the reading's quote does — a page check, which refuses here. Off-plan is a sale too.
    for (const [p3, quote, category] of [
      ['Annual rent SAR 60,000', 'SAR 60,000', 'buy'],
      ['الإيجار السنوي 60,000 ريال', '60,000 ريال', 'buy'],
      // The same in a text layer's Arabic presentation forms (as W023's), the riyal as ﷼.
      ['اﻹﻳﺠﺎر اﻟﺴﻨﻮي 60,000 ﷼', '60,000', 'buy'],
      ['Expected yield: SAR 60,000', 'SAR 60,000', 'buy'],
      // A monthly instalment: the period word (شهرية, "monthly") sends it — an instalment word alone is no rent wording
      // (Claude r6 NB6, the owner's call).
      ['أقساط شهرية تبدأ من 60,000 ريال', '60,000 ريال', 'off-plan'],
      ['Monthly instalments from SAR 60,000', 'SAR 60,000', 'off-plan'],
      ['Price SAR 60,000', 'Rental income SAR 60,000', 'buy'],
      // r7 #5 (Claude r6 B1a / B8): one row per rent or income word, English…
      ['Rent SAR 60,000', 'SAR 60,000', 'buy'], ['Rental SAR 60,000', 'SAR 60,000', 'buy'], ['Rented at SAR 60,000', 'SAR 60,000', 'buy'],
      ['Lease SAR 60,000', 'SAR 60,000', 'buy'], ['Leased at SAR 60,000', 'SAR 60,000', 'buy'], ['Leasing price SAR 60,000', 'SAR 60,000', 'buy'],
      ['Income SAR 60,000', 'SAR 60,000', 'buy'], ['Tenanted, SAR 60,000', 'SAR 60,000', 'buy'], ['Let at SAR 60,000', 'SAR 60,000', 'buy'],
      // …one per period wording, English…
      ['SAR 60,000 per month', 'SAR 60,000', 'buy'], ['SAR 60,000 per year', 'SAR 60,000', 'buy'], ['SAR 60,000 per annum', 'SAR 60,000', 'buy'],
      ['SAR 60,000 per yr', 'SAR 60,000', 'buy'], ['SAR 60,000 p.a.', 'SAR 60,000', 'buy'], ['SAR 60,000 monthly', 'SAR 60,000', 'buy'],
      ['SAR 60,000 yearly', 'SAR 60,000', 'buy'], ['SAR 60,000 annually', 'SAR 60,000', 'buy'], ['SAR 60,000 a month', 'SAR 60,000', 'buy'],
      ['SAR 60,000 a year', 'SAR 60,000', 'buy'], ['SAR 60,000 every month', 'SAR 60,000', 'buy'], ['SAR 60,000/month', 'SAR 60,000', 'buy'],
      ['SAR 60,000 / year', 'SAR 60,000', 'buy'], ['SAR 60,000/mo', 'SAR 60,000', 'buy'], ['SAR 60,000/yr', 'SAR 60,000', 'buy'],
      // …the Arabic rent and income words, with their clitics…
      ['إيجار 60,000 ريال', '60,000 ريال', 'buy'], ['ايجار 60,000 ريال', '60,000 ريال', 'buy'], ['للإيجار 60,000 ريال', '60,000 ريال', 'buy'],
      ['دخل إيجاري 60,000 ريال', '60,000 ريال', 'buy'], ['أجرة 60,000 ريال', '60,000 ريال', 'buy'], ['مؤجر بـ 60,000 ريال', '60,000 ريال', 'buy'],
      ['مؤجرة بـ 60,000 ريال', '60,000 ريال', 'buy'], ['للتأجير 60,000 ريال', '60,000 ريال', 'buy'], ['دخل 60,000 ريال', '60,000 ريال', 'buy'],
      ['الدخل 60,000 ريال', '60,000 ريال', 'buy'], ['بالدخل 60,000 ريال', '60,000 ريال', 'buy'], ['للدخل 60,000 ريال', '60,000 ريال', 'buy'],
      ['ودخل 60,000 ريال', '60,000 ريال', 'buy'], ['عائد 60,000 ريال', '60,000 ريال', 'buy'], ['العائد 60,000 ريال', '60,000 ريال', 'buy'],
      // …their other forms and spellings (ة / ا / tanween, no hamza), and "tenanted" in Arabic (مستأجرة).
      ['Tenants in place, SAR 60,000', 'SAR 60,000', 'buy'], ['Tenancy SAR 60,000', 'SAR 60,000', 'buy'],
      ['قيمة إيجارية 60,000 ريال', '60,000 ريال', 'buy'], ['إيجارها 60,000 ريال', '60,000 ريال', 'buy'], ['إيجارات 60,000 ريال', '60,000 ريال', 'buy'],
      ['استئجار 60,000 ريال', '60,000 ريال', 'buy'], ['تاجير 60,000 ريال', '60,000 ريال', 'buy'], ['اجرة 60,000 ريال', '60,000 ريال', 'buy'],
      ['مؤجره بـ 60,000 ريال', '60,000 ريال', 'buy'], ['موجرة بـ 60,000 ريال', '60,000 ريال', 'buy'], ['مستأجرة بـ 60,000 ريال', '60,000 ريال', 'buy'],
      ['يحقق دخلاً 60,000 ريال', '60,000 ريال', 'buy'], ['يحقق عائداً 60,000 ريال', '60,000 ريال', 'buy'], ['عائدات 60,000 ريال', '60,000 ريال', 'buy'],
      ['عوائد 60,000 ريال', '60,000 ريال', 'buy'],
      // …the Arabic period wordings…
      ['60,000 ريال شهري', '60,000 ريال', 'buy'], ['60,000 ريال شهرية', '60,000 ريال', 'buy'], ['60,000 ريال شهرياً', '60,000 ريال', 'buy'],
      ['60,000 ريال سنوي', '60,000 ريال', 'buy'], ['60,000 ريال سنوية', '60,000 ريال', 'buy'], ['60,000 ريال سنوياً', '60,000 ريال', 'buy'],
      ['60,000 ريال في الشهر', '60,000 ريال', 'buy'], ['60,000 ريال في السنة', '60,000 ريال', 'buy'], ['60,000 ريال في العام', '60,000 ريال', 'buy'],
      ['60,000 ريال بالشهر', '60,000 ريال', 'buy'], ['60,000 ريال للسنة', '60,000 ريال', 'buy'], ['60,000 ريال كل شهر', '60,000 ريال', 'buy'],
      ['60,000 ريال / شهر', '60,000 ريال', 'buy'],
      // …and with tatweel and harakat, which are folded out first ("الدَّخل" is الدخل).
      ['الإيـجار 60,000 ريال', '60,000 ريال', 'buy'], ['الدَّخل 60,000 ريال', '60,000 ريال', 'buy'], ['الدَّخل السنوي 60,000 ريال', '60,000 ريال', 'buy'],
      ['الإيجَار 60,000 ريال', '60,000 ريال', 'buy'], ['مؤجَّرة بـ 60,000 ريال', '60,000 ريال', 'buy'], ['Price SAR 60,000', 'الإيـجار 60,000 ريال', 'buy'],
      // r8 #5 (Claude r7 B1a, the r7 #5 regression): the forms e892790 caught — a pronoun suffix on دخل / عائد / إيجار
      // (ه ها هم هما نا ات اتها), a ك clitic, a final ى (folded to ي, as ی is).
      ['عمارة للبيع دخلها 60,000 ريال', '60,000 ريال', 'buy'], ['صافي دخلها 60,000 ريال', '60,000 ريال', 'buy'],
      ['دخله 60,000 ريال', '60,000 ريال', 'buy'], ['دخلهما 60,000 ريال', '60,000 ريال', 'buy'], ['دخلهم 60,000 ريال', '60,000 ريال', 'buy'],
      ['دخلنا 60,000 ريال', '60,000 ريال', 'buy'], ['عائدها 60,000 ريال', '60,000 ريال', 'buy'], ['عائده 60,000 ريال', '60,000 ريال', 'buy'],
      ['عائدهم 60,000 ريال', '60,000 ريال', 'buy'], ['عائدهما 60,000 ريال', '60,000 ريال', 'buy'], ['عائدنا 60,000 ريال', '60,000 ريال', 'buy'],
      ['عائداتها 60,000 ريال', '60,000 ريال', 'buy'], ['إيجاراتها 60,000 ريال', '60,000 ريال', 'buy'], ['إيجارهم 60,000 ريال', '60,000 ريال', 'buy'],
      ['إيجارهما 60,000 ريال', '60,000 ريال', 'buy'], ['إيجارنا 60,000 ريال', '60,000 ريال', 'buy'], ['كإيجار 60,000 ريال', '60,000 ريال', 'buy'],
      ['كدخل 60,000 ريال', '60,000 ريال', 'buy'], ['كعائد 60,000 ريال', '60,000 ريال', 'buy'], ['كأجرة 60,000 ريال', '60,000 ريال', 'buy'],
      ['كالدخل 60,000 ريال', '60,000 ريال', 'buy'], ['إيجارى 60,000 ريال', '60,000 ريال', 'buy'],
      ['القيمة الإيجارى 60,000 ريال', '60,000 ريال', 'buy'], ['دخلها الشهرى 60,000 ريال', '60,000 ريال', 'buy'],
      // r8 #5 (Claude r7 B1b): the spellings السنه / أجره, ى-final and Farsi-yeh (ی) forms…
      ['60,000 ريال في السنه', '60,000 ريال', 'buy'], ['60,000 ريال للسنه', '60,000 ريال', 'buy'], ['أجره 60,000 ريال', '60,000 ريال', 'buy'],
      ['اجره 60,000 ريال', '60,000 ريال', 'buy'], ['60,000 ريال سنوى', '60,000 ريال', 'buy'], ['60,000 ريال شهرى', '60,000 ريال', 'buy'],
      ['إیجار 60,000 ريال', '60,000 ريال', 'buy'], ['60,000 ريال سنوی', '60,000 ريال', 'buy'],
      // …the short-stay periods and the income words, English (bare "annual" right after its figure)…
      ['SAR 60,000 per night', 'SAR 60,000', 'buy'], ['SAR 60,000 nightly', 'SAR 60,000', 'buy'], ['SAR 60,000/night', 'SAR 60,000', 'buy'],
      ['SAR 60,000 per week', 'SAR 60,000', 'buy'], ['SAR 60,000 weekly', 'SAR 60,000', 'buy'], ['SAR 60,000/week', 'SAR 60,000', 'buy'],
      ['SAR 60,000 pa', 'SAR 60,000', 'buy'], ['SAR 60,000 p/a', 'SAR 60,000', 'buy'], ['SAR 60,000/annum', 'SAR 60,000', 'buy'],
      ['SAR 60,000 pcm', 'SAR 60,000', 'buy'], ['SAR 60,000 annual', 'SAR 60,000', 'buy'], ['Return SAR 60,000', 'SAR 60,000', 'buy'],
      ['Returns of SAR 60,000', 'SAR 60,000', 'buy'], ['ROI SAR 60,000', 'SAR 60,000', 'buy'], ['Revenue SAR 60,000', 'SAR 60,000', 'buy'],
      // …and Arabic.
      ['إيراد 60,000 ريال', '60,000 ريال', 'buy'], ['الإيرادات 60,000 ريال', '60,000 ريال', 'buy'], ['ايراد 60,000 ريال', '60,000 ريال', 'buy'],
      ['ريع 60,000 ريال', '60,000 ريال', 'buy'], ['الريع 60,000 ريال', '60,000 ريال', 'buy'], ['مردود 60,000 ريال', '60,000 ريال', 'buy'],
      ['60,000 ريال يوميا', '60,000 ريال', 'buy'], ['60,000 ريال يومياً', '60,000 ريال', 'buy'], ['60,000 ريال يوميًا', '60,000 ريال', 'buy'],
      ['60,000 ريال في اليوم', '60,000 ريال', 'buy'], ['60,000 ريال لليلة', '60,000 ريال', 'buy'], ['60,000 ريال أسبوعيا', '60,000 ريال', 'buy'],
      ['60,000 ريال اسبوعياً', '60,000 ريال', 'buy'],
      // r9 #2 (Claude r8 B1a): the rest of the forms e892790 caught — the suffixes اته / اتهم, ك / كم and ي on دخل / عائد /
      // إيجار…
      ['مجمع للبيع إيجاراته 60,000 ريال', '60,000 ريال', 'buy'], ['عائداته 60,000 ريال', '60,000 ريال', 'buy'],
      ['إيجاراتهم 60,000 ريال', '60,000 ريال', 'buy'], ['دخلك 60,000 ريال', '60,000 ريال', 'buy'], ['إيجارك 60,000 ريال', '60,000 ريال', 'buy'],
      ['عائدكم 60,000 ريال', '60,000 ريال', 'buy'], ['عائدك المتوقع 60,000 ريال', '60,000 ريال', 'buy'], ['دخلي 60,000 ريال', '60,000 ريال', 'buy'],
      // …(B1b) the income words r8 #5 added, with the same suffixes and the ا of tanween, and أجرت- with its pronoun…
      ['عمارة للبيع إيراداتها 60,000 ريال', '60,000 ريال', 'buy'], ['إيراداته 60,000 ريال', '60,000 ريال', 'buy'],
      ['ريعها 60,000 ريال', '60,000 ريال', 'buy'], ['مردودها 60,000 ريال', '60,000 ريال', 'buy'], ['عوائدها 60,000 ريال', '60,000 ريال', 'buy'],
      ['أجرتها 60,000 ريال', '60,000 ريال', 'buy'], ['أجرته 60,000 ريال', '60,000 ريال', 'buy'], ['اجرتها 60,000 ريال', '60,000 ريال', 'buy'],
      ['يحقق إيراداً 60,000 ريال', '60,000 ريال', 'buy'],
      // …and (B1c) the short-stay variants: "a night", "a week", بالليلة, في الليلة, كل ليلة, "/ ليلة", باليوم, في الأسبوع,
      // بالأسبوع.
      ['SAR 60,000 a night', 'SAR 60,000', 'buy'], ['SAR 60,000 a week', 'SAR 60,000', 'buy'], ['60,000 ريال بالليلة', '60,000 ريال', 'buy'],
      ['60,000 ريال بالليله', '60,000 ريال', 'buy'], ['60,000 ريال في الليلة', '60,000 ريال', 'buy'], ['60,000 ريال كل ليلة', '60,000 ريال', 'buy'],
      ['60,000 ريال / ليلة', '60,000 ريال', 'buy'], ['60,000 ريال/ليلة', '60,000 ريال', 'buy'], ['60,000 ريال باليوم', '60,000 ريال', 'buy'],
      ['60,000 ريال في الأسبوع', '60,000 ريال', 'buy'], ['60,000 ريال في الاسبوع', '60,000 ريال', 'buy'], ['60,000 ريال بالأسبوع', '60,000 ريال', 'buy'],
      ['60,000 ريال بالاسبوع', '60,000 ريال', 'buy'],
    ]) {
      const o = await outcome({ listing: sale(null, quote, category), pageText: pages(p3), confirm: [] });
      assert.deepEqual(o.checks.map((c) => [c.amount, c.period, c.sale]), [[60000, null, true]], p3);
      assert.equal(o.price.onRequest, true, p3);
    }
    // An ordinary sale line, no period: the text layer settles it, no check — as before.
    const plain = await outcome({ listing: sale(null, 'SAR 60,000'), pageText: pages('Price SAR 60,000'), confirm: [] });
    assert.deepEqual(plain.evidence, { inText: true, confirmed: null });
    assert.deepEqual(plain.checks, []);
    assert.deepEqual(plain.price, { amount: 60000, currency: 'SAR', from: false, period: null, onRequest: false });
    // r7 #5 (Codex r6 #7 = Claude r6 B1c): an Arabic word that only CONTAINS a rent word is none — مدخل (an entrance),
    // يدخل / تدخل / ادخل (enters), شهرين (two months), عائدة / عائدية (belongs to), harakat or not; nor "Current price".
    for (const [p3, quote, amount] of [
      ['مدخل مستقل — سعر البيع 450,000 ريال', '450,000 ريال', 450000], ['فيلا بمدخلين 60,000 ريال', '60,000 ريال', 60000],
      ['التسليم خلال شهرين 60,000 ريال', '60,000 ريال', 60000], ['الأرض عائدة للمطور 60,000 ريال', '60,000 ريال', 60000],
      ['Current price SAR 450,000', 'SAR 450,000', 450000], ['المدخل الرئيسي — السعر 60,000 ريال', '60,000 ريال', 60000],
      ['فيلا بمدخل خاص — السعر 60,000 ريال', '60,000 ريال', 60000], ['تدخل الشمس كل الغرف — السعر 60,000 ريال', '60,000 ريال', 60000],
      ['يدخل الضوء — السعر 60,000 ريال', '60,000 ريال', 60000], ['ادخل عالم الفخامة بسعر 60,000 ريال', '60,000 ريال', 60000],
      ['الملكية عائدية للمطور — 60,000 ريال', '60,000 ريال', 60000], ['فيلا بمَدخل خاص — السعر 60,000 ريال', '60,000 ريال', 60000],
      ['السعر 60,000 ريال', 'فيلا بمدخل خاص 60,000 ريال', 60000],
      // r8 #5 (Claude r7 B1): a suffix never reaches inside another word — مدخلها (its entrance), تدخلها (enters it),
      // سريع (quick, ريع inside); a final ى folds to no rent word (مستوى); bare "annual" before a word is no period
      // ("Annual maintenance"), and "pa" counts only as a word of its own ("Spa").
      ['فيلا مدخلها مستقل — السعر 60,000 ريال', '60,000 ريال', 60000], ['تدخلها الشمس — السعر 60,000 ريال', '60,000 ريال', 60000],
      ['وصول سريع للطريق — السعر 60,000 ريال', '60,000 ريال', 60000], ['مستوى فاخر — السعر 60,000 ريال', '60,000 ريال', 60000],
      ['Annual maintenance included — Price SAR 60,000', 'SAR 60,000', 60000], ['Spa and gym — Price SAR 60,000', 'SAR 60,000', 60000],
    ]) {
      const o = await outcome({ listing: sale(null, quote, 'buy', amount), pageText: pages(p3), confirm: [] });
      assert.deepEqual(o.evidence, { inText: true, confirmed: null }, p3);
      assert.deepEqual(o.checks, [], p3);
      assert.deepEqual(o.price, { amount, currency: 'SAR', from: false, period: null, onRequest: false }, p3);
    }
    // r8 #5 (Claude r7 B1b): the owner's brochure AC51D2 p11 prints a nightly rate, "Return Rates / 700 - 1300 / ريال
    // لليلة الواحدة". A reading period is only a year or a month, so it arrives as a sale of 700 with no period: the
    // words beside it send it to its page — refused there, on request, never "SAR 700".
    for (const p3 of ['Return Rates\n700 - 1300\nريال لليلة الواحدة', 'Return Rates 700 - 1300 ريال لليلة الواحدة']) {
      const o = await outcome({ listing: sale(null, '700 - 1300', 'buy', 700), pageText: pages(p3), confirm: [] });
      assert.deepEqual(o.checks.map((c) => [c.amount, c.period, c.sale]), [[700, null, true]], p3);
      assert.equal(o.price.onRequest, true, p3);
      assert.equal(o.price.amount, null, p3);
    }
    // A rental keeps the r3 #4 rule: its page, for its period, with no sale line.
    const rental = await outcome({ listing: sale('year', 'Annual rent SAR 60,000', 'rent'), pageText: pages('Annual rent SAR 60,000'), confirm: [60000] });
    assert.deepEqual(rental.checks.map((c) => [c.amount, c.period, c.sale]), [[60000, 'year', false]]);
    assert.deepEqual(rental.price, { amount: 60000, currency: 'SAR', from: false, period: 'year', onRequest: false });
  });

  it('r7 #6 (Claude r6 B2a): on a listing for sale every headline check of a page is asked as a sale — unreadable digits, the whole property, the Sakani price', async () => {
    const sale = (amount, quote, category = 'buy') => {
      const period = category === 'rent' ? 'year' : null;
      const a = withModels([], { price: { amount, currency: 'SAR', from: false, period, onRequest: false }, priceEvidence: { page: 3, quote } });
      a.listing.category = category;
      return a;
    };
    const pages = (p3) => ['Overview\nA residential compound for sale. A residential compound for sale.', 'Location', p3, 'Specification', 'Contact'];
    const outcome = async (opts, run = (r) => r.run()) => {
      const r = await rig(opts);
      try {
        const report = await run(r);
        return { evidence: report.priceEvidence, price: report.listingPreview.price, codes: report.warningCodes, texts: report.warnings, checks: r.calls().filter((c) => c.tool === 'claude-confirm') };
      } finally { r.cleanup(); }
    };
    // The W023 font: "Annual rent SAR DIB,FDG" — the text layer cannot show the figure beside its rent words, so the
    // page is checked. The second model, told the listing is for sale, refuses the rent: on request, never SAR 60,000.
    const scrambled = await outcome({ listing: sale(60000, '60,000'), pageText: pages('Annual rent SAR DIB,FDG'), confirm: [60000], rents: [60000] });
    assert.deepEqual(scrambled.checks.map((c) => [c.amount, c.period, c.whole, c.sale]), [[60000, null, false, true]]);
    assert.equal(scrambled.price.onRequest, true);
    assert.equal(scrambled.price.amount, null);
    assert.ok(scrambled.codes.includes('price-not-printed'));
    // Nothing tied the figure to a rent wording, so the reply does not say it may be one.
    assert.ok(!scrambled.texts.some((w) => /may be a rent/.test(w)), scrambled.texts.join(' | '));
    // An image-only page (the default brochure's scrambled price pages), off-plan: the headline and its Sakani price.
    const w023 = await outcome({ listing: answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' }, subsidisedPriceEvidence: { page: 3, quote: '270,425' } }), confirm: [319015, 270425] });
    assert.deepEqual(w023.checks.map((c) => [c.amount, c.subsidised, c.sale]), [[319015, false, true], [270425, true, true]]);
    assert.deepEqual(w023.price, { ...PRICE });
    // A single villa priced per floor: its headline, the lowest floor, is checked as the whole villa's price — as a sale.
    const floors = withModels([model('Ground floor', 60000, null, 3), model('First floor', 75000, null, 3)], {
      price: { amount: 60000, currency: 'SAR', from: true, period: null, onRequest: false }, priceEvidence: { page: 3, quote: '60,000' },
    });
    floors.listing.category = 'buy';
    floors.listing.project = null;
    const whole = await outcome({ listing: floors, confirm: [60000] });
    assert.deepEqual(whole.checks.map((c) => [c.amount, c.period, c.whole, c.sale]), [[60000, null, true, true]]);
    // A rental: its page, for its period, never the sale line.
    const rental = await outcome({ listing: sale(60000, '60,000', 'rent'), pageText: pages('Annual rent SAR DIB,FDG'), confirm: [60000], rents: [60000] });
    assert.deepEqual(rental.checks.map((c) => [c.amount, c.period, c.sale]), [[60000, 'year', false]]);
    assert.equal(rental.price.amount, 60000);
  });

  it('r7 #6 (Claude r6 B2c, r5 NB2): the unit-model check on a listing for sale is asked as a sale — rents printed per model are no model prices and no "From" headline', async () => {
    const reading = (category) => {
      const a = withModels([{ ...model('Type A', 60000, null, 3), evidence: { page: 3, quote: 'Annual rent SAR 60,000' } },
        { ...model('Type B', 75000, null, 3), evidence: { page: 3, quote: 'Annual rent SAR 75,000' } }]);
      a.listing.category = category;
      return a;
    };
    const pageText = ['Overview', 'Location', 'Annual rent\nType A SAR 60,000\nType B SAR 75,000', 'Specification', 'Contact'];
    const r = await rig({ listing: reading('buy'), pageText, rents: [60000, 75000] });
    try {
      const report = await r.run();
      assert.deepEqual(modelCalls(r).map((c) => [c.page, c.period, c.sale]), [[3, null, true]], 'one call, as before: the sale line costs none');
      assert.deepEqual(report.listingPreview.models.map((m) => m.price), [null, null]);
      assert.equal(report.listingPreview.price.onRequest, true, 'no SAR 60,000 "From" headline');
      assert.ok(report.warningCodes.includes('model-price-not-printed'));
    } finally { r.cleanup(); }
    // Off-plan is a sale too; a rental's models are its rents, for its period, with no sale line.
    for (const [category, sale, period] of [['off-plan', true, null], ['rent', false, 'year']]) {
      const o = await rig({ listing: reading(category), pageText });
      try {
        await o.run();
        assert.deepEqual(modelCalls(o).map((c) => [c.period, c.sale]), [[period, sale]], category);
      } finally { o.cleanup(); }
    }
  });

  it('r7 #6 (Claude r6 B2b = Codex r6 NB1): a rent label on the line above or below the figure, with no figure of its own, sends a sale headline to its page', async () => {
    const sale = (amount) => {
      const a = withModels([], { price: { amount, currency: 'SAR', from: false, period: null, onRequest: false }, priceEvidence: null });
      a.listing.category = 'buy';
      return a;
    };
    const pages = (p3) => ['Overview\nA residential compound for sale. A residential compound for sale.', 'Location', p3, 'Specification', 'Contact'];
    const outcome = async (opts) => {
      const r = await rig(opts);
      try {
        const report = await r.run();
        return { evidence: report.priceEvidence, price: report.listingPreview.price, codes: report.warningCodes, texts: report.warnings, checks: r.calls().filter((c) => c.tool === 'claude-confirm') };
      } finally { r.cleanup(); }
    };
    // Period null, no quote: the label and the figure on two text-layer lines (a card, a table cell), either order,
    // a blank line between or not — one page check, asked as a sale, which refuses: on request, and the reply says why.
    for (const p3 of [
      'Annual rent\nSAR 60,000', 'SAR 60,000\nAnnual rent', 'الإيجار السنوي\n60,000 ريال', '60,000 ريال\nالإيجار السنوي',
      'Annual rent\n\nSAR 60,000', 'SAR 60,000\n\nAnnual rent', 'الإيجار السنوي\n\n60,000 ريال', '60,000 ريال\n\nالإيجار السنوي',
    ]) {
      const o = await outcome({ listing: sale(60000), pageText: pages(p3), confirm: [] });
      assert.equal(o.evidence.inText, false, p3);
      assert.deepEqual(o.checks.map((c) => [c.amount, c.period, c.sale]), [[60000, null, true]], p3);
      assert.equal(o.price.onRequest, true, p3);
      assert.ok(o.codes.includes('price-not-printed'), p3);
      // Claude r6 NB1: the figure read may be a rent, not a price the brochure forgot.
      const line = o.texts.find((w) => /price on request/.test(w)) ?? '';
      assert.match(line, /the figure read may be a rent or income, not the sale price/, p3);
      assert.match(line, /send `price <id> <amount>`/, p3);
    }
    // Controls: a plain price label, and a rent line that prints a figure of its own — the text layer settles it.
    for (const p3 of ['Price\nSAR 450,000', 'Annual rent 12,000\nPrice SAR 450,000']) {
      const o = await outcome({ listing: sale(450000), pageText: pages(p3), confirm: [] });
      assert.deepEqual(o.evidence, { inText: true, confirmed: null }, p3);
      assert.deepEqual(o.checks, [], p3);
      assert.deepEqual(o.price, { amount: 450000, currency: 'SAR', from: false, period: null, onRequest: false }, p3);
    }
  });

  it('r8 #6 (Codex r7 #2 = Claude r7 NB8): a rent label counts unless it prints an AMOUNT of its own — a unit, a year, a bedroom count or a yield is no amount', async () => {
    const sale = (amount, priceEvidence = null) => {
      const a = withModels([], { price: { amount, currency: 'SAR', from: false, period: null, onRequest: false }, priceEvidence });
      a.listing.category = 'buy';
      return a;
    };
    const pages = (p3) => ['Overview\nA residential compound for sale. A residential compound for sale.', 'Location', p3, 'Specification', 'Contact'];
    const outcome = async (opts) => {
      const r = await rig(opts);
      try {
        const report = await r.run();
        return { evidence: report.priceEvidence, price: report.listingPreview.price, codes: report.warningCodes, texts: report.warnings, checks: r.calls().filter((c) => c.tool === 'claude-confirm') };
      } finally { r.cleanup(); }
    };
    // A label carrying a figure that is no amount — a unit, a bedroom count, a year, a yield — is still the rent label of
    // the figure beside it: one page check, asked as a sale, which refuses — on request, and the reply says why.
    const labels = [
      ['Annual rent — Unit 4', 'SAR 60,000'], ['Annual rent (2 BR)', 'SAR 60,000'], ['Year 1 rental income', 'SAR 60,000'],
      ['Annual rent 2025', 'SAR 60,000'], ['Annual rent — Unit 104', 'SAR 60,000'], ['Rental yield 7%', 'SAR 60,000'],
      ['الإيجار السنوي – الوحدة 4', '60,000 ريال'], ['الإيجار السنوي — وحدة ٤', '60,000 ريال'], ['الإيجار السنوي (2 غرف)', '60,000 ريال'],
      ['دخل الإيجار — السنة 1', '60,000 ريال'], ['الإيجار السنوي 2025', '60,000 ريال'], ['الإيجار السنوي — الوحدة 104', '60,000 ريال'],
      ['العائد الإيجاري 7%', '60,000 ريال'],
    ];
    const rows = [...labels.flatMap(([label, fig]) => [[`${label}\n${fig}`, null], [`${fig}\n${label}`, null]]),
      // …with the reading's quote of the figure alone.
      ['Annual rent — Unit 4\nSAR 60,000', { page: 3, quote: 'SAR 60,000' }], ['Annual rent — Unit 4\nSAR 60,000', { page: 3, quote: '60,000' }]];
    for (const [p3, evidence] of rows) {
      const o = await outcome({ listing: sale(60000, evidence), pageText: pages(p3), confirm: [] });
      assert.equal(o.evidence.inText, false, p3);
      assert.deepEqual(o.checks.map((c) => [c.amount, c.period, c.sale]), [[60000, null, true]], p3);
      assert.equal(o.price.onRequest, true, p3);
      assert.equal(o.price.amount, null, p3);
      const line = o.texts.find((w) => /price on request/.test(w)) ?? '';
      assert.match(line, /the figure read may be a rent or income, not the sale price/, p3);
    }
    // Controls: a neighbour that prints an amount of its own (a currency by a figure, grouped thousands, a scaled figure)
    // labels that amount, and a plain price label is none — the text layer settles it, no check.
    for (const p3 of [
      'Annual rent 12,000\nPrice SAR 450,000', 'Price\nSAR 450,000', 'Annual rent SAR 12,000\nSAR 450,000', 'Annual income 1.2m\nPrice SAR 450,000',
      'الإيجار السنوي 12,000 ريال\nالسعر 450,000 ريال', 'A S K I N G P R I C E\nSAR 450,000\nالسعر المطلوب',
    ]) {
      const o = await outcome({ listing: sale(450000), pageText: pages(p3), confirm: [] });
      assert.deepEqual(o.evidence, { inText: true, confirmed: null }, p3);
      assert.deepEqual(o.checks, [], p3);
      assert.deepEqual(o.price, { amount: 450000, currency: 'SAR', from: false, period: null, onRequest: false }, p3);
    }
    // The cost, pinned: a rent label with no amount beside a real sale price costs one check, asked as a sale — which
    // confirms it, so the price is published.
    const yieldBeside = await outcome({ listing: sale(450000), pageText: pages('Rental yield 7%\nPrice SAR 450,000'), confirm: [450000] });
    assert.deepEqual(yieldBeside.checks.map((c) => [c.amount, c.period, c.sale]), [[450000, null, true]]);
    assert.deepEqual(yieldBeside.price, { amount: 450000, currency: 'SAR', from: false, period: null, onRequest: false });
  });

  it('r8 #6 (Codex r7 #3, Claude r7 NB9): the rent-label neighbour is looked for on the figure\'s own page (or in the caption), never across a page break', async () => {
    const sale = (amount) => {
      const a = withModels([], { price: { amount, currency: 'SAR', from: false, period: null, onRequest: false }, priceEvidence: null });
      a.listing.category = 'buy';
      return a;
    };
    const overview = 'Overview\nA residential compound for sale. A residential compound for sale.';
    const outcome = async (opts, caption = {}) => {
      const r = await rig(opts);
      try {
        const report = await processPdf({ pdfPath: r.pdfPath, cfg: r.cfg, caption, workDir: path.join(r.repo, '..', 'work'), dryRun: true });
        return { evidence: report.priceEvidence, price: report.listingPreview.price, checks: r.calls().filter((c) => c.tool === 'claude-confirm') };
      } finally { r.cleanup(); }
    };
    // A page ends with a rent line and the next one starts with the sale price (or the other way round, or in Arabic,
    // or with an image-only page between): no neighbours — the text layer settles it, no check, so a spent quota never
    // sends it on request.
    for (const [pageText, caption] of [
      [[overview, 'Investment\nRental income', 'Sale price SAR 450,000', 'Specification', 'Contact'], {}],
      [[overview, 'Sale price SAR 450,000', 'Rental income\nInvestment', 'Specification', 'Contact'], {}],
      [[overview, 'الاستثمار\nالدخل الإيجاري', 'سعر البيع 450,000 ريال', 'Specification', 'Contact'], {}],
      [[overview, 'Investment\nRental income', '', 'Sale price SAR 450,000', 'Contact'], {}],
      // …and the owner's caption is no neighbour of the last page.
      [[overview, 'Location', 'Specification', 'Contact', 'Sale price SAR 450,000'], { text: 'Rental income' }],
    ]) {
      const o = await outcome({ listing: sale(450000), pageText, confirm: [], confirmFail: 'quota' }, caption);
      const why = JSON.stringify([pageText, caption]);
      assert.deepEqual(o.evidence, { inText: true, confirmed: null }, why);
      assert.deepEqual(o.checks, [], why);
      assert.deepEqual(o.price, { amount: 450000, currency: 'SAR', from: false, period: null, onRequest: false }, why);
    }
    // On the same page the label still sends it to its page: one sale check (here the quota is spent: on request).
    const same = await outcome({ listing: sale(60000), pageText: [overview, 'Location', 'Annual rent\nSAR 60,000', 'Specification', 'Contact'], confirm: [], confirmFail: 'quota' });
    assert.equal(same.evidence.inText, false);
    assert.deepEqual(same.checks.map((c) => [c.amount, c.period, c.sale]), [[60000, null, true]]);
    assert.equal(same.price.onRequest, true);
  });

  it('r9 #1 (Codex r8 #1): a headline that is an area figure ("4.5 million square feet") is not settled by the text layer — its page refuses it, on request', async () => {
    const sale = (amount, priceEvidence) => {
      const a = withModels([], { price: { amount, currency: 'SAR', from: false, period: null, onRequest: false }, priceEvidence });
      a.listing.category = 'buy';
      return a;
    };
    const overview = 'Overview\nA residential compound for sale. A residential compound for sale.';
    const outcome = async (opts) => {
      const r = await rig(opts);
      try {
        const report = await r.run();
        return { evidence: report.priceEvidence, price: report.listingPreview.price, codes: report.warningCodes, checks: r.calls().filter((c) => c.tool === 'claude-confirm') };
      } finally { r.cleanup(); }
    };
    // Page 2 prints the area; its "Prices on request" line (no figure near it) has it rendered for the reading.
    for (const area of [
      'The development spans 4.5 millions of square feet', 'The development spans 4.5 million square feet',
      'Total built-up area 4,500,000 sq ft', 'مساحة المشروع 4.5 مليون متر مربع',
    ]) {
      const p2 = `${area}\nMasterplan\nAmenities\nLocation\nPrices on request`;
      const o = await outcome({ listing: sale(4500000, { page: 2, quote: area }), pageText: [overview, p2, 'Specification', 'Contact'], confirm: [] });
      assert.equal(o.evidence.inText, false, area);
      assert.deepEqual(o.checks.map((c) => [c.amount, c.page, c.sale]), [[4500000, 2, true]], area);
      assert.equal(o.price.onRequest, true, area);
      assert.equal(o.price.amount, null, area);
      assert.ok(o.codes.includes('price-not-printed'), area);
    }
    // Control: a price printed with an area further along its line is still settled by the text layer, no check.
    const priced = 'Price SAR 4,500,000 for a 450 m² villa';
    const o = await outcome({ listing: sale(4500000, { page: 2, quote: priced }), pageText: [overview, priced, 'Specification', 'Contact'], confirm: [] });
    assert.deepEqual(o.evidence, { inText: true, confirmed: null });
    assert.deepEqual(o.checks, []);
    assert.deepEqual(o.price, { amount: 4500000, currency: 'SAR', from: false, period: null, onRequest: false });
  });

  it('r9 #2 (Codex r8 #3 / NB1, Claude r8 NB6 / NB13), r10 #1: a frequency word or an income word beside a sale figure makes a rent label, a percentage is no amount, and every ownAmount branch is pinned', async () => {
    const sale = (amount) => {
      const a = withModels([], { price: { amount, currency: 'SAR', from: false, period: null, onRequest: false }, priceEvidence: null });
      a.listing.category = 'buy';
      return a;
    };
    const pages = (p3) => ['Overview\nA residential compound for sale. A residential compound for sale.', 'Location', p3, 'Specification', 'Contact'];
    const outcome = async (opts) => {
      const r = await rig(opts);
      try {
        const report = await r.run();
        return { evidence: report.priceEvidence, price: report.listingPreview.price, texts: report.warnings, checks: r.calls().filter((c) => c.tool === 'claude-confirm') };
      } finally { r.cleanup(); }
    };
    // An amenity with a frequency word (weekly, nightly, PA, أسبوعياً) beside a correct sale price is a rent label again
    // (r10 #1, Claude r9 B1 = Codex r9 #1: r9 #2's weak-word cut unmade card labels such as "Weekly rate (SAR)", so a
    // nightly or weekly rate settled as the sale price with 0 checks). It costs one sale check, which confirms the price
    // here and publishes it — under a spent quota the listing goes on request: the TAQEEM-safe side (a recorded
    // disagreement with Codex r8 #3).
    for (const amenity of ['Weekly housekeeping included', 'Nightly security patrols', 'PA system in the lobby', 'تنظيف أسبوعياً']) {
      for (const p3 of [`${amenity}\nSale price SAR 450,000`, `Sale price SAR 450,000\n${amenity}`]) {
        const o = await outcome({ listing: sale(450000), pageText: pages(p3), confirm: [450000] });
        assert.deepEqual(o.checks.map((c) => [c.amount, c.period, c.sale]), [[450000, null, true]], p3);
        assert.deepEqual(o.price, { amount: 450000, currency: 'SAR', from: false, period: null, onRequest: false }, p3);
      }
    }
    // Still rent labels: a frequency word alone or with only a rate or price word (a card label), a rent wording, an
    // income heading — return, ROI, revenue, مردود (r9 verifier: "Expected return" over a lone figure is an income card)
    // — a yield with three decimals or a spaced "%" (a percentage is no amount: Codex r8 NB1), and a rent label whose
    // only figure is an area (the measure cut: Claude r8 NB13). One sale check, which refuses: on request, and why.
    const labels = [
      ['Nightly rate', 'SAR 60,000'], ['Weekly', 'SAR 60,000'], ['Return Rates', 'SAR 60,000'], ['Per night', 'SAR 60,000'],
      ['لليلة الواحدة', '60,000 ريال'], ['أسبوعياً', '60,000 ريال'], ['Rental yield 7.125%', 'SAR 60,000'], ['Net yield 6.875 %', 'SAR 60,000'],
      ['العائد الإيجاري ٧.١٢٥٪', '60,000 ريال'], ['Rental income — Building 2 (10,500 sqm)', 'SAR 60,000'],
      ['Expected return', 'SAR 60,000'], ['Annual return', 'SAR 60,000'], ['Annual revenue', 'SAR 60,000'], ['Net ROI', 'SAR 60,000'],
      ['Investment Returns', 'SAR 60,000'], ['صافي المردود', '60,000 ريال'], ['المردود المتوقع', '60,000 ريال'],
    ];
    for (const p3 of labels.flatMap(([label, fig]) => [`${label}\n${fig}`, `${fig}\n${label}`])) {
      const o = await outcome({ listing: sale(60000), pageText: pages(p3), confirm: [] });
      assert.equal(o.evidence.inText, false, p3);
      assert.deepEqual(o.checks.map((c) => [c.amount, c.period, c.sale]), [[60000, null, true]], p3);
      assert.equal(o.price.onRequest, true, p3);
      assert.equal(o.price.amount, null, p3);
      const line = o.texts.find((w) => /price on request/.test(w)) ?? '';
      assert.match(line, /the figure read may be a rent or income, not the sale price/, p3);
    }
    // A selling point with an income word beside a correct sale price costs one sale check, which confirms it: the
    // price is published (Claude r8 NB6 — the cost is accepted; the TAQEEM-safe side of "Expected return").
    for (const point of ['High ROI', 'Guaranteed returns of 8%', 'العربون غير مردود']) {
      const p3 = `${point}\nSale price SAR 450,000`;
      const o = await outcome({ listing: sale(450000), pageText: pages(p3), confirm: [450000] });
      assert.deepEqual(o.checks.map((c) => [c.amount, c.period, c.sale]), [[450000, null, true]], p3);
      assert.deepEqual(o.price, { amount: 450000, currency: 'SAR', from: false, period: null, onRequest: false }, p3);
    }
    // Controls: a rent line that prints an amount of its own labels that amount — beside its yield (the percentage cut
    // leaves the amount), and through each ownAmount branch (Claude r8 NB13): a currency by its figure read before
    // anything is cut ("SAR 4.5 M" is no 4.5 metres), five digits or more, a solid k. No check, the text layer settles it.
    for (const p3 of [
      'Annual rent 12,000 (7.125%)\nPrice SAR 450,000', 'Annual rent SAR 4.5 M\nPrice SAR 450,000', 'Annual rent SAR 900\nPrice SAR 450,000',
      'Annual rent 12000\nPrice SAR 450,000', 'Annual rent 12k\nPrice SAR 450,000',
    ]) {
      const o = await outcome({ listing: sale(450000), pageText: pages(p3), confirm: [], confirmFail: 'quota' });
      assert.deepEqual(o.evidence, { inText: true, confirmed: null }, p3);
      assert.deepEqual(o.checks, [], p3);
      assert.deepEqual(o.price, { amount: 450000, currency: 'SAR', from: false, period: null, onRequest: false }, p3);
    }
  });

  it('r10 #1 (Claude r9 B1 / B2 / NB4 / NB5, Codex r9 #1 / #3 / NB2): every frequency word makes a rent label, ات takes a pronoun after it, "a night" / "a week" / "per day" / "كل يوم" count only after a figure, and the short-stay siblings count on the figure\'s own line', async () => {
    const sale = (amount, quote = null) => {
      const a = withModels([], { price: { amount, currency: 'SAR', from: false, period: null, onRequest: false }, priceEvidence: quote ? { page: 3, quote } : null });
      a.listing.category = 'buy';
      return a;
    };
    const pages = (p3) => ['Overview\nA residential compound for sale. A residential compound for sale.', 'Location', p3, 'Specification', 'Contact'];
    const outcome = async (opts) => {
      const r = await rig(opts);
      try {
        const report = await r.run();
        return { evidence: report.priceEvidence, price: report.listingPreview.price, checks: r.calls().filter((c) => c.tool === 'claude-confirm') };
      } finally { r.cleanup(); }
    };
    // One sale check, which refuses: on request — never the rate published as the sale price.
    const sentToPage = async (p3, amount, quote = null) => {
      const o = await outcome({ listing: sale(amount, quote), pageText: pages(p3), confirm: [] });
      assert.equal(o.evidence.inText, false, p3);
      assert.deepEqual(o.checks.map((c) => [c.amount, c.period, c.sale]), [[amount, null, true]], p3);
      assert.equal(o.price.onRequest, true, p3);
      assert.equal(o.price.amount, null, p3);
    };
    // No check under a spent quota: the text layer settles the correct sale price.
    const settled = async (p3) => {
      const o = await outcome({ listing: sale(450000), pageText: pages(p3), confirm: [], confirmFail: 'quota' });
      assert.deepEqual(o.evidence, { inText: true, confirmed: null }, p3);
      assert.deepEqual(o.checks, [], p3);
      assert.deepEqual(o.price, { amount: 450000, currency: 'SAR', from: false, period: null, onRequest: false }, p3);
    };
    // B1 = Codex r9 #1: card labels and table headers with a frequency word and a qualifier — a currency, "from", a
    // bracket, a second column word — are rent labels, in either order (r9 #2's weak-word cut made them none).
    const labels = [
      ['Weekly rate (SAR)', 'SAR 60,000'], ['Nightly price (AED)', 'SAR 60,000'], ['Nightly rate (SAR)', 'SAR 60,000'],
      ['Weekly rates from', 'SAR 60,000'], ['Weekly rate (excl. VAT)', 'SAR 60,000'], ['Nightly rate per villa', 'SAR 60,000'],
      ['أسبوعياً ابتداءً من', '60,000 ريال'], ['تبدأ الأسعار أسبوعياً من', '60,000 ريال'],
      ['Unit type Nightly Weekly', 'SAR 60,000'], ['Season | Nightly | Weekly', 'SAR 60,000'],
      ['Weekly price', 'SAR 60,000'], ['Nightly tariff', 'SAR 60,000'], ['Daily rate', 'SAR 60,000'], ['Daily', 'SAR 60,000'],
      ['Rental yield 7.125 percent', 'SAR 60,000'],
    ];
    for (const p3 of labels.flatMap(([label, fig]) => [`${label}\n${fig}`, `${fig}\n${label}`])) await sentToPage(p3, 60000);
    // B2: ات with a pronoun after it, on إيجار and عائد — on the figure's own line and as its label.
    for (const form of ['عائداتك', 'عائداتكم', 'عائداتنا', 'عائداتي', 'عائداتهما', 'إيجاراتك', 'إيجاراتكم', 'إيجاراتنا', 'إيجاراتي']) {
      await sentToPage(`${form} المتوقعة 60,000 ريال`, 60000, '60,000 ريال');
      await sentToPage(`${form} المتوقعة\n60,000 ريال`, 60000);
    }
    // …and a word that only contains one is still none (عائدة: belongs to; مدخلها: its entrance), on the line or beside it.
    for (const p3 of [
      'الأرض عائدة للمطور — سعر البيع 450,000 ريال', 'الأرض عائدة للمطور\nسعر البيع 450,000 ريال',
      'فيلا مدخلها مستقل — سعر البيع 450,000 ريال', 'فيلا مدخلها مستقل\nسعر البيع 450,000 ريال',
    ]) await settled(p3);
    // C#3 / NB5: "a night" / "a week" are rates only after a figure on the same line…
    await sentToPage('SAR 700 a night', 700, 'SAR 700');
    await sentToPage('700 SAR a week', 700, '700 SAR');
    // …so a timeline or a frequency in prose beside a correct sale price is no rent label — nor "per day" / "كل يوم"
    // with no figure before them.
    for (const prose of ['Move in within a week', 'Housekeeping twice a week', 'Housekeeping once per day', 'تنظيف كل يوم']) {
      await settled(`${prose}\nSale price SAR 450,000`);
      await settled(`Sale price SAR 450,000\n${prose}`);
    }
    // NB4 = Codex r9 NB2: the short-stay siblings on the figure's own line — "daily", "per day" and "كل يوم" after the
    // figure, the others before it or after.
    for (const [p3, quote] of [
      ['SAR 60,000 daily', 'SAR 60,000'], ['SAR 60,000 per day', 'SAR 60,000'], ['60,000 ريال كل يوم', '60,000 ريال'],
      ...['سعر الليلة', 'لليوم', 'للأسبوع', 'للاسبوع', 'ليلياً', 'القيمة التأجيرية']
        .flatMap((form) => [[`${form} 60,000 ريال`, '60,000 ريال'], [`60,000 ريال ${form}`, '60,000 ريال']]),
    ]) await sentToPage(p3, 60000, quote);
    // r11 #1 (Claude r10 B1 = Codex r10 #1, Claude r10 NB2 / NB3 = Codex r10 NB2): "a night" / "a week" / "a day" are
    // rates on a label line or before the figure too — only a prose lead-in ("within", "in", "twice", "days", "hours")
    // makes them a timeline or a frequency; "per day" / "كل يوم" count with a figure before or after them on the line,
    // or alone on their line; and the other per-period forms.
    for (const [p3, amount, quote] of [
      ['SAR 1,200\na night', 1200], ['SAR 4,500\na week', 4500], ['a night\nSAR 1,200', 1200], ['A week in the chalet from SAR 4,500', 4500, 'SAR 4,500'],
      ['A week from SAR 4,500', 4500, 'SAR 4,500'], ["A night's stay from SAR 60,000", 60000, 'SAR 60,000'], ['SAR 1,200 (incl. breakfast) a night', 1200, 'SAR 1,200'],
      ['Chalet A\nSAR 60,000\na night', 60000], ['SAR 700 a day', 700, 'SAR 700'], ['60,000 ريال للعام', 60000, '60,000 ريال'],
      ['60,000 ريال كل عام', 60000, '60,000 ريال'], ['4,500 ريال / أسبوع', 4500, '4,500 ريال'], ['4,500 ريال لكل أسبوع', 4500, '4,500 ريال'],
      ['60,000 ريال / عام', 60000, '60,000 ريال'], ['700 ريال / الليلة', 700, '700 ريال'], ['700 ريال / اليوم', 700, '700 ريال'],
      ['SAR 700/day', 700, 'SAR 700'], ['السعر اليومي 700 ريال', 700, '700 ريال'], ['Weekend rate\nSAR 60,000', 60000],
      ['Per day\nSAR 60,000', 60000], ['ريال كل يوم1,500', 1500, '1,500'], ['كل يوم 1,500 ريال', 1500, '1,500 ريال'],
    ]) await sentToPage(p3, amount, quote ?? null);
    for (const prose of ['Open 7 days a week', 'Gym open 24 hours a day, 7 days a week', 'Handover in a week', '2BR ready in a week']) {
      await settled(`${prose}\nSale price SAR 450,000`);
      await settled(`Sale price SAR 450,000\n${prose}`);
    }
    // r12 #1 (Codex r11 #2): on a line with a money-sized figure the prose lead-in excuses nothing — a short-stay package.
    for (const [p3, amount] of [['SAR 1,200 for 2 nights a week', 1200], ['1,200 ريال — SAR 1,200 in a week', 1200], ['SAR 4,500 for 3 days a week', 4500]]) {
      await sentToPage(p3, amount, `SAR ${amount.toLocaleString('en-US')}`);
    }
    // r13 #2 (Claude r11 B3 / NB2 / NB3 / NB7): the same before the figure; "per day" as a label; the other short-stay
    // labels; Arabic-Indic digits near كل يوم; كل يوم and "Per day" with a figure on the line.
    for (const [p3, amount, quote] of [
      ['Stay 2 nights a week from SAR 1,200', 1200, 'SAR 1,200'], ['Earn up to SAR 450,000 in a week', 450000, 'SAR 450,000'],
      ['Price per day\nSAR 700', 700], ['Per day:\nSAR 700', 700], ['Per day (SAR)\n700', 700], ['(incl. VAT & breakfast) per day\nSAR 700', 700],
      ['Weekday rate\nSAR 700', 700], ['Night rate\nSAR 700', 700], ['SAR 700 every night', 700, 'SAR 700'], ['SAR 700 for one night', 700, 'SAR 700'],
      ['السعر الأسبوعي\n4,500 ريال', 4500], ['سعر الأسبوع\n4,500 ريال', 4500], ['ليلة واحدة\n700 ريال', 700],
      ['٦٠٬٠٠٠ ريال كل يوم', 60000, '٦٠٬٠٠٠ ريال'], ['Per day SAR 60,000', 60000, 'SAR 60,000'], ['كل يوم\n60,000 ريال', 60000],
    ]) await sentToPage(p3, amount, quote ?? null);
    for (const prose of ['Housekeeping once per day', 'Cleaning thrice a week', 'Two times a week', 'Every day a day of joy', 'Two nights a week of live music']) {
      await settled(`${prose}\nSale price SAR 450,000`);
    }
  });

  it('r2 #3: caption "rent per month", the brochure prints only SAR 60,000 a year — no monthly headline', async () => {
    const a = withModels([model('Villa', 60000, null, 3)], { price: { amount: 60000, currency: 'SAR', from: true, period: 'year', onRequest: false }, priceEvidence: { page: 3, quote: 'SAR 60,000 per year' } });
    a.listing.category = 'rent';
    const facts = { 3: [{ fig: 60000, mark: 'SAR', kind: 'model', model: 'Villa', per: 'year' }, { fig: 60000, mark: 'SAR', kind: 'whole', per: 'year' }] };
    const r = await rig({ listing: a, facts });
    try {
      const report = await processPdf({ pdfPath: r.pdfPath, cfg: r.cfg, caption: { category: 'rent', period: 'month', text: '' }, workDir: path.join(r.repo, '..', 'work'), dryRun: true });
      assert.deepEqual(report.listingPreview.models.map((m) => m.price), [null], 'the row is a year\'s rent');
      assert.equal(report.listingPreview.price.onRequest, true, 'never "SAR 60,000 / month"');
      assert.equal(report.listingPreview.price.period, 'month');
    } finally { r.cleanup(); }
    // Printed per month too: published per month.
    const m = await rig({ listing: structuredClone(a), facts: { 3: [...facts[3], { fig: 60000, mark: 'SAR', kind: 'whole', per: 'month' }] } });
    try {
      const report = await processPdf({ pdfPath: m.pdfPath, cfg: m.cfg, caption: { category: 'rent', period: 'month', text: '' }, workDir: path.join(m.repo, '..', 'work'), dryRun: true });
      assert.deepEqual(report.listingPreview.price, { amount: 60000, currency: 'SAR', from: true, period: 'month', onRequest: false });
    } finally { m.cleanup(); }
  });

  it('r2 #4 (Codex r1 #3): money in a model\'s rooms or availability, or in a fact-list item, is dropped with a warning — whoever\'s price it is', async () => {
    const a = withModels([model('Nawras', 419994, null, 3), model('Lulu', 319015, null, 3)]);
    a.models[1].availability = { en: 'Down payment 50 000', ar: 'دفعة أولى 50 000' };      // space-grouped, never claimed
    a.models[1].rooms = { en: ['Maid room', 'Deposit 750'], ar: ['غرفة خادمة', 'عربون ٧٥٠'] }; // a payment word, any number
    a.models[0].availability = { en: 'Buildings G–P, 419,994', ar: 'المباني G–P، 419,994' }; // its own confirmed price
    a.models[0].rooms = { en: ['Living room 4.2 x 5.1 m', 'Terrace 1,200 sq ft'], ar: ['صالة', 'شرفة'] };
    a.amenities = { en: ['Health club', 'Service charge 25 per sqm', 'Pool'], ar: ['نادٍ صحي', 'رسوم الخدمة 25 للمتر', 'مسبح'] };
    a.nearby = { en: ['King Abdulaziz Airport — 15 minutes', 'Mall — 1.2 million visitors a year'], ar: ['المطار — 15 دقيقة', 'مول'] };
    a.warranties = { en: ['Structure — 10 years', 'Booking fee 500, refundable'], ar: ['الهيكل — 10 سنوات', 'رسوم حجز 500 مستردة'] };
    const r = await rig({ listing: a });
    try {
      const report = await r.run();
      const [nawras, lulu] = report.listingPreview.models;
      assert.deepEqual([nawras.price, lulu.price], [419994, 319015]);
      assert.equal(lulu.availability, null, '"Down payment 50 000"');
      assert.equal(lulu.rooms, null, '"Deposit 750"');
      assert.equal(nawras.availability, null, 'its own price too: prices go in the price fields only');
      assert.deepEqual(nawras.rooms, a.models[0].rooms, 'measurements are not money');
      assert.deepEqual(report.listingPreview.amenities, { en: ['Health club', 'Pool'], ar: ['نادٍ صحي', 'مسبح'] }, 'the item goes in both languages');
      assert.deepEqual(report.listingPreview.nearby, a.nearby, 'minutes and visitors are not money');
      assert.deepEqual(report.listingPreview.warranties, { en: ['Structure — 10 years'], ar: ['الهيكل — 10 سنوات'] });
      const w = report.warnings.join(' | ');
      for (const f of ['models[0].availability', 'models[1].availability', 'models[1].rooms', 'amenities[1]', 'warranties[1]']) assert.ok(w.includes(f), `${f}: ${w}`);
      assert.ok(report.warningCodes.includes('model-price-not-printed'));
      assert.deepEqual(checkListing(report.listingPreview), []);
    } finally { r.cleanup(); }
  });

  it('r5 #2: a model\'s text or a fact item that states one of the reading\'s own price figures is dropped — the price matcher\'s forms, which statesMoney alone lets through', async () => {
    const a = withModels([model('Studio', 4500, null, 3), model('Loft', 6000, null, 3)]);
    a.models[0].availability = { en: 'Floors 1–3, 4500 per month', ar: 'الأدوار 1–3' };
    a.models[1].rooms = { en: ['Terrace', 'Maid room 6000'], ar: ['شرفة', 'غرفة'] };
    a.amenities = { en: ['Gym', 'Club 4500 a year'], ar: ['نادٍ', 'نادي'] };
    const r = await rig({ listing: a, modelConfirm: [6000] });
    try {
      const report = await r.run();
      assert.deepEqual(report.listingPreview.models.map((m) => [m.availability, m.rooms]), [[null, null], [null, null]]);
      assert.deepEqual(report.listingPreview.amenities, { en: ['Gym'], ar: ['نادٍ'] });
    } finally { r.cleanup(); }
  });

  it('r5 #3: a model NAME carrying a reading price in its scaled form ("Penthouse 4.5m" against 4,500,000) refuses the run; "Villa 15m" does not', async () => {
    const a = withModels([model('Penthouse 4.5m', 4500000, null, 3), model('Villa 15m', 6000000, null, 3)]);
    const r = await rig({ listing: a });
    try {
      await assert.rejects(r.run(), (err) => err.stage === 'price' && /^models\[0\]\.name states/.test(err.reason));
    } finally { r.cleanup(); }
    const b = withModels([model('Penthouse', 4500000, null, 3), model('Villa 15m', 6000000, null, 3)]);
    const t = await rig({ listing: b });
    try {
      assert.deepEqual((await t.run()).listingPreview.models.map((m) => m.name.en), ['Penthouse', 'Villa 15m']);
    } finally { t.cleanup(); }
  });

  it('r6 #2: a model NAME with a reading price as "4.50m" or "٤٫٥ مليون،", or a code glued to a figure ("Studio 4500SAR"), refuses the run end to end', async () => {
    for (const [en, ar] of [['Penthouse 4.50m', 'بنتهاوس'], ['Penthouse', 'بنتهاوس ٤٫٥ مليون، إطلالة']]) {
      const a = withModels([model('Penthouse', 4500000, null, 3), model('Villa 15m', 6000000, null, 3)]);
      a.models[0].name = { en, ar };
      const r = await rig({ listing: a });
      try {
        await assert.rejects(r.run(), (err) => err.stage === 'price' && /^models\[0\]\.name states/.test(err.reason), `${en} / ${ar}`);
      } finally { r.cleanup(); }
    }
    // A glued code is not one of the reading's prices: the reading contract (claude.mjs copyProblems) refuses it first.
    const g = withModels([model('Studio 4500SAR', null, null, null), model('Villa 15m', 6000000, null, 3)]);
    const u = await rig({ listing: g });
    try {
      await assert.rejects(u.run(), /models\[0\]\.name\.en states a price/);
    } finally { u.cleanup(); }
  });

  it('r3 #3: a model NAME that carries a price the reading carries — a model price, a Sakani price, the headline — refuses the run', async () => {
    for (const [i, name] of [[0, 'Nawras 419,994'], [1, 'Lulu 270425'], [1, 'Type ٣١٩٬٠١٥']]) {
      const a = withModels([model('Nawras', 419994, 356024, 3), model('Lulu', 319015, 270425, 3)], { price: { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false, subsidisedAmount: 270425 } });
      a.models[i].name = { en: name, ar: 'نموذج' };
      const r = await rig({ listing: a });
      try {
        await assert.rejects(r.run(), (err) => err.stage === 'price' && new RegExp(`^models\\[${i}\\]\\.name states`).test(err.reason), name);
        assert.equal(r.calls().filter((c) => c.tool === 'claude-model-confirm').length, 0, 'refused before a check is paid for');
      } finally { r.cleanup(); }
    }
    // A figure no price of the reading has is a name: "Plot 10000", "Penthouse 4,250", "Villa 15m".
    const ok = withModels([model('Plot 10000', 419994, null, 3), model('Penthouse 4,250', 319015, null, 3), model('Villa 15m', null, null, null)]);
    const r = await rig({ listing: ok });
    try {
      assert.deepEqual((await r.run()).listingPreview.models.map((m) => m.name.en), ['Plot 10000', 'Penthouse 4,250', 'Villa 15m']);
    } finally { r.cleanup(); }
  });

  it('r2 #4: a model NAME refuses the run only for a currency or a payment word — "Villa 15m", "Plot 10000", "Penthouse 4,250" are names', async () => {
    const a = withModels([model('Villa 15m', 419994, null, 3), model('Type A 12m frontage', 319015, null, 3), model('Plot 10000', null, null, null), model('Penthouse 4,250', null, null, null)]);
    const r = await rig({ listing: a });
    try {
      const report = await r.run();
      assert.deepEqual(report.listingPreview.models.map((m) => m.name.en), ['Villa 15m', 'Type A 12m frontage', 'Plot 10000', 'Penthouse 4,250']);
    } finally { r.cleanup(); }
    for (const name of ['Lulu — 10% down payment', 'Lulu, prices in riyals', 'Lulu دفعة أولى']) {
      const n = withModels([model('Nawras', 419994, null, 3), model('Lulu', 319015, null, 3)]);
      n.models[1].name = { en: name, ar: 'نموذج لؤلؤ' };
      const u = await rig({ listing: n });
      try {
        await assert.rejects(u.run(), (err) => err.stage === 'price' && /^models\[1\]\.name states a price or a payment/.test(err.reason), name);
      } finally { u.cleanup(); }
    }
  });

  it('a single villa (no project) with one priced model: the model keeps its price, the headline is checked as its own — never "from"', async () => {
    const own = { amount: 4500000, currency: 'SAR', from: false, period: null, onRequest: false };
    const a = { ...answer({ price: own, priceEvidence: { page: 3, quote: '4,500,000' } }), models: [model('Villa', 4400000, null, 3)] };
    a.listing.project = null;
    const r = await rig({ listing: a, confirm: [4500000] });
    try {
      const report = await r.run();
      assert.equal(modelCalls(r).length, 1, 'the model price is still confirmed on its page');
      assert.deepEqual(report.listingPreview.models.map((m) => m.price), [4400000]);
      assert.deepEqual(report.listingPreview.price, own, 'not aligned with the model: not "from", its own figure');
      assert.equal(r.calls().filter((c) => c.tool === 'claude-confirm').length, 1, 'the headline is checked the ordinary way');
      assert.equal(report.priceEvidence.fromModels, undefined);
      assert.deepEqual(checkListing(report.listingPreview), [], 'the validator passes');
    } finally { r.cleanup(); }
  });

  it('per-floor rows of a single villa, or a project with one model, are not aligned either', async () => {
    const own = { amount: 4500000, currency: 'SAR', from: false, period: null, onRequest: false };
    const floors = { ...answer({ price: own, priceEvidence: { page: 3, quote: '4,500,000' } }), models: [model('Ground floor', 2000000, null, 3), model('First floor', 2500000, null, 3)] };
    floors.listing.project = null;
    const one = { ...answer({ price: own, priceEvidence: { page: 3, quote: '4,500,000' } }), models: [model('Lulu', 319015, null, 3)] };
    for (const [label, listing] of [['per-floor rows', floors], ['a project with one model', one]]) {
      const r = await rig({ listing, confirm: [4500000] });
      try {
        const report = await r.run();
        assert.deepEqual(report.listingPreview.price, own, label);
        assert.deepEqual(checkListing(report.listingPreview), [], label);
      } finally { r.cleanup(); }
    }
  });

  it('when every model price is refused, the headline falls back to its own checks', async () => {
    const r = await rig({
      listing: withModels([model('Lulu', 319015, 270425, 3)], { price: PRICE, priceEvidence: { page: 3, quote: '319,015' }, subsidisedPriceEvidence: { page: 3, quote: '270,425' } }),
      modelConfirm: [], confirm: [319015, 270425],
    });
    try {
      const report = await r.run();
      assert.deepEqual(report.ai.models.map((m) => [m.price, m.subsidisedPrice]), [[null, null]]);
      assert.equal(r.calls().filter((c) => c.tool === 'claude-confirm').length, 2, 'headline + Sakani checked the old way');
      assert.deepEqual(report.listingPreview.price, PRICE);
    } finally { r.cleanup(); }
  });
});

describe('processPdf: unit-model prices — failures, bounds and the headline fallback', { timeout: 120000 }, () => {
  const ON_REQUEST = { amount: null, currency: 'SAR', from: false, period: null, onRequest: true };
  const model = (en, price, subsidisedPrice, page) => ({
    name: { en, ar: `نموذج ${en}` }, bedrooms: 2, bathrooms: 2, areaSqm: 105, rooms: null, availability: null,
    price, subsidisedPrice, evidence: page ? { page, quote: String(price) } : null, floorPlan: null,
  });
  const withModels = (models, opts = {}) => ({ ...answer({ price: ON_REQUEST, ...opts }), models });
  const modelCalls = (r) => r.calls().filter((c) => c.tool === 'claude-model-confirm');
  const renders = (r) => r.calls().filter((c) => c.tool === 'py-pages').map((c) => c.pages);

  it('(a) a model page that fails to render costs only the models on it; the run goes on', async () => {
    const r = await rig({ listing: withModels([model('Lulu', 319015, 270425, 3), model('Corner', 299000, null, 2)]), failPageDir: 'model-pages' });
    try {
      const report = await r.run();
      assert.deepEqual(renders(r), [[3, 5], [2]], 'the cited page was asked for');
      assert.equal(report.modelPages, undefined);
      assert.deepEqual(modelCalls(r).map((c) => c.page), [3], 'nothing to look at for Corner: no call');
      assert.deepEqual(report.ai.models.map((m) => [m.price, m.subsidisedPrice]), [[319015, 270425], [null, null]]);
      assert.deepEqual(report.listingPreview.price, { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false, subsidisedAmount: 270425 });
      assert.ok(report.warningCodes.includes('model-price-not-printed'));
      assert.deepEqual(report.modelPrices.incompletePages, [2]);
      assert.ok(report.warnings.some((w) => /could not be completed/.test(w) && /try again later/.test(w)), report.warnings.join(' | '));
    } finally { r.cleanup(); }
  });

  it('(b) the model check failing (claude -p exits non-zero): refused, and the warning says the check could not be completed', async () => {
    const r = await rig({ listing: withModels([model('Nawras', 419994, 356024, 3), model('Lulu', 319015, 270425, 3)]), modelConfirmFail: true });
    try {
      const report = await r.run();
      assert.equal(modelCalls(r).length, 1);
      assert.deepEqual(report.ai.models.map((m) => [m.price, m.subsidisedPrice]), [[null, null], [null, null]]);
      assert.deepEqual(report.listingPreview.price, ON_REQUEST, 'no model price kept and no headline figure of its own');
      assert.ok(report.warningCodes.includes('model-price-not-printed'));
      assert.ok(report.warnings.some((w) => /could not be completed/.test(w) && /try again later/.test(w)), report.warnings.join(' | '));
      assert.ok(!report.warnings.some((w) => /could not be confirmed on the brochure's own pages/.test(w)), 'the brochure is not blamed');
      assert.deepEqual(report.modelPrices.incompletePages, [3]);
    } finally { r.cleanup(); }
  });

  it('(b) a quota error (fatal): refused, and the same warning (the stop after a fatal error is pinned in model-prices.test.mjs)', async () => {
    const r = await rig({ listing: withModels([model('Nawras', 419994, null, 3), model('Lulu', 319015, null, 5)]), modelConfirmFail: 'quota', cfgExtra: { maxModelPricePages: 12 } });
    try {
      const report = await r.run();
      assert.ok(modelCalls(r).length <= 2);
      assert.deepEqual(report.ai.models.map((m) => m.price), [null, null]);
      assert.deepEqual(report.modelPrices.incompletePages, [3, 5]);
      assert.ok(report.warnings.some((w) => /could not be completed/.test(w)));
    } finally { r.cleanup(); }
  });

  it('the page checks run at most cfg.modelPriceConcurrency at once (BONA_MODEL_PRICE_CONCURRENCY)', async () => {
    const five = () => withModels([1, 2, 3, 4, 5].map((p) => model(`M${p}`, 300000 + p, null, p)));
    const peakOf = (r) => {
      const spans = r.calls().filter((c) => c.tool === 'model-confirm-span');
      assert.equal(spans.length, 5);
      return Math.max(...spans.map((a) => spans.filter((b) => b.t0 < a.t1 && a.t0 < b.t1).length));
    };
    for (const [limit, check] of [[1, (peak) => assert.equal(peak, 1)], [2, (peak) => assert.ok(peak <= 2, String(peak))]]) {
      const r = await rig({ listing: five(), modelConfirmDelayMs: 400, cfgExtra: { modelPriceConcurrency: limit } });
      try {
        const report = await r.run();
        assert.equal(report.modelPrices.calls, 5);
        check(peakOf(r));
      } finally { r.cleanup(); }
    }
  });

  it('a refusal and a check that could not be done get separate warnings', async () => {
    const r = await rig({
      listing: withModels([model('Nawras', 419994, null, 3), model('Lulu', 319015, null, 3), model('Corner', 299000, null, 2)]),
      modelConfirm: [319015], failPageDir: 'model-pages',
    });
    try {
      const report = await r.run();
      assert.deepEqual(report.ai.models.map((m) => m.price), [null, 319015, null]);
      assert.deepEqual(report.modelPrices.incompletePages, [2]);
      assert.deepEqual(report.modelPrices.incomplete, [299000]);
      assert.ok(report.warnings.some((w) => /^1 unit-model price\(s\) could not be confirmed on the brochure's own pages/.test(w)), report.warnings.join(' | '));
      const later = report.warnings.filter((w) => /try again later/.test(w));
      assert.equal(later.length, 1, report.warnings.join(' | '));
      assert.match(later[0], /the check of 1 unit-model price\(s\) could not be completed \(page 2\)/);
    } finally { r.cleanup(); }
  });

  it('after a quota error in the model check, the headline and Sakani checks make no call and say "try again later"', async () => {
    const r = await rig({
      listing: withModels([model('Lulu', 319015, 270425, 3)], { price: PRICE, priceEvidence: { page: 3, quote: '319,015' }, subsidisedPriceEvidence: { page: 3, quote: '270,425' } }),
      modelConfirmFail: 'quota', confirm: [319015, 270425],
    });
    try {
      const report = await r.run();
      assert.equal(modelCalls(r).length, 1);
      assert.equal(r.calls().filter((c) => c.tool === 'claude-confirm').length, 0, 'no call after a quota error');
      assert.equal(report.modelPrices.fatal, true);
      assert.equal(report.listingPreview.price.onRequest, true);
      assert.equal(report.listingPreview.price.amount, null);
      assert.deepEqual(report.priceEvidence, { inText: false, confirmed: null, unchecked: true, uncheckedWhy: 'quota' });
      assert.ok(report.warnings.some((w) => /^the price could not be checked/.test(w) && /try again later/.test(w)), report.warnings.join(' | '));
      assert.ok(!report.warnings.some((w) => /was not printed in the brochure/.test(w)), 'the brochure is not blamed');
    } finally { r.cleanup(); }
  });

  it('a quota error on the headline check stops the Sakani check too', async () => {
    const r = await rig({
      listing: answer({ price: PRICE, priceEvidence: { page: 3, quote: '319,015' }, subsidisedPriceEvidence: { page: 3, quote: '270,425' } }),
      confirmFail: 'quota',
    });
    try {
      const report = await r.run();
      assert.deepEqual(r.calls().filter((c) => c.tool === 'claude-confirm').map((c) => c.amount), [319015], 'the Sakani check is never sent');
      assert.equal(report.listingPreview.price.onRequest, true);
      assert.ok(report.warnings.some((w) => /^the price could not be checked/.test(w) && /try again later/.test(w)), report.warnings.join(' | '));
      assert.ok(!report.warnings.some((w) => /was not printed in the brochure/.test(w)));
    } finally { r.cleanup(); }
  });

  it('after a quota error, a headline that IS the unchecked model figure is not taken off the text layer — "try again later" (r2 #2)', async () => {
    // Before r2 #2 this headline was published off the text layer ("مشروع سكني من 319,015 ريال"): the model
    // check that would have tied 319,015 to a row never ran, so the text layer cannot say whose price it is.
    const PAD = ' — شقة سكنية بمساحة واسعة وتشطيبات حديثة في موقع مميز قريب من الخدمات';
    const pageText = [`مشروع سكني من 319,015 ريال${PAD}`, `السعر لمستفيدي الدعم 270,425 ريال\nالسعر لغير مستفيدي الدعم 319,015 ريال\n${PAD}`];
    const r = await rig({
      pageText,
      listing: withModels([model('Lulu', 319015, 270425, 2)], { price: PRICE, subsidisedPriceEvidence: { page: 2, quote: '270,425' } }),
      modelConfirmFail: 'quota', confirm: [319015, 270425],
    });
    try {
      const report = await r.run();
      assert.equal(r.calls().filter((c) => c.tool === 'claude-confirm').length, 0, 'no call after the quota error');
      assert.equal(report.priceEvidence.inText, false);
      assert.equal(report.priceEvidence.unchecked, true);
      assert.equal(report.listingPreview.price.onRequest, true);
      assert.equal(report.listingPreview.price.subsidisedAmount ?? null, null);
      assert.ok(report.warnings.some((w) => /^the price could not be checked/.test(w) && /try again later/.test(w)), report.warnings.join(' | '));
      assert.ok(!report.warnings.some((w) => /was not printed in the brochure/.test(w)), 'the brochure is not blamed');
    } finally { r.cleanup(); }
  });

  it('r3 #10: a headline no page text carries, whose model check did not finish: "try again later", never "not printed"', async () => {
    // The figure is printed only as an image on page 3 (no text layer for it), the model cites page 3, the headline
    // cites nothing: the whole-property check has no page to pick — the model check that would have looked failed.
    const listing = () => withModels([model('A', 1250000, null, 3), model('B', 1500000, null, 3)], { price: { amount: 1250000, currency: 'SAR', from: true, period: null, onRequest: false } });
    const pageText = ['Palm Compound', 'x', 'Unit types', 'y', 'z'];
    for (const fail of ['quota', true]) {
      const r = await rig({ pageText, listing: listing(), modelConfirmFail: fail });
      try {
        const report = await r.run();
        assert.equal(report.listingPreview.price.onRequest, true, String(fail));
        assert.equal(report.priceEvidence.unchecked, true, String(fail));
        const w = report.warnings.find((x) => /price on request/.test(x)) ?? '';
        assert.match(w, /could not be checked/, String(fail));
        assert.match(w, /try again later/, String(fail));
        assert.doesNotMatch(w, /was not printed/, String(fail));
      } finally { r.cleanup(); }
    }
  });

  it('r2 #2: a model check that timed out leaves its figure to a page check as the whole development\'s price — never the text layer', async () => {
    const project = () => withModels([model('A', 1250000, null, 3), model('B', 1500000, null, 3)], { price: { amount: 1250000, currency: 'SAR', from: true, period: null, onRequest: false }, priceEvidence: { page: 3, quote: '1,250,000' } });
    const pageText = ['Palm Compound', 'x', 'A 1,250,000\nB 1,500,000', 'y', 'z'];
    const headline = (r) => r.calls().filter((c) => c.tool === 'claude-confirm').map((c) => [c.amount, c.whole]);
    // The page does not print it as the development's own price: on request.
    const no = await rig({ pageText, listing: project(), modelConfirmFail: true });
    try {
      const report = await no.run();
      assert.deepEqual(report.modelPrices.incomplete.sort(), [1250000, 1500000]);
      assert.equal(report.priceEvidence.inText, false, 'the bare "A 1,250,000" in the text layer is a row, not the headline');
      assert.deepEqual(headline(no), [[1250000, true]]);
      assert.equal(report.listingPreview.price.onRequest, true);
    } finally { no.cleanup(); }
    // It does: published, "from".
    const ok = await rig({ pageText, listing: project(), modelConfirmFail: true, confirm: [1250000] });
    try {
      assert.deepEqual((await ok.run()).listingPreview.price, { amount: 1250000, currency: 'SAR', from: true, period: null, onRequest: false });
    } finally { ok.cleanup(); }
    // The page check cannot run either (its call fails too): "try again later", not "not printed".
    const down = await rig({ pageText, listing: project(), modelConfirmFail: true, confirmFail: true });
    try {
      const report = await down.run();
      assert.equal(report.listingPreview.price.onRequest, true);
      assert.equal(report.priceEvidence.unchecked, true);
      const w = report.warnings.find((x) => /price on request/.test(x)) ?? '';
      assert.match(w, /could not be checked/);
      assert.match(w, /try again later/);
    } finally { down.cleanup(); }
  });

  it('(c) a cited page past the end of the PDF: refused without a render or a call', async () => {
    const r = await rig({ listing: withModels([model('Lulu', 319015, null, 3), model('Ghost', 288000, null, 9)]) });
    try {
      const report = await r.run();
      assert.deepEqual(renders(r), [[3, 5]], 'page 9 of a 5-page PDF is never rendered');
      assert.deepEqual(modelCalls(r).map((c) => c.page), [3]);
      assert.deepEqual(modelCalls(r)[0].items.map((it) => it.i), [0]);
      assert.deepEqual(report.ai.models.map((m) => m.price), [319015, null]);
      assert.deepEqual(report.modelPrices.refused, [288000]);
      assert.ok(report.warnings.some((w) => /could not be confirmed on the brochure's own pages/.test(w)));
    } finally { r.cleanup(); }
  });

  it('(d) every model price refused: the headline\'s own check may confirm it on a page rendered for the models', async () => {
    const r = await rig({
      listing: withModels([model('Corner', 319015, null, 2)], { price: { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false }, priceEvidence: { page: 2, quote: '319,015' } }),
      modelConfirm: [], confirm: [319015],
    });
    try {
      const report = await r.run();
      assert.deepEqual(report.modelPages, [2]);
      assert.deepEqual(report.ai.models.map((m) => m.price), [null]);
      const headline = r.calls().filter((c) => c.tool === 'claude-confirm');
      assert.deepEqual(headline.map((c) => [c.amount, c.page]), [[319015, 2]], 'the second model looked at the model page');
      assert.deepEqual(report.priceEvidence, { inText: false, confirmed: true });
      assert.deepEqual(report.listingPreview.price, { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false });
    } finally { r.cleanup(); }
  });

  it('more priced pages than BONA_MAX_MODEL_PRICE_PAGES: every model price refused, nothing rendered, no call', async () => {
    const r = await rig({
      listing: withModels([model('Nawras', 419994, null, 3), model('Lulu', 319015, null, 5), model('Corner', 299000, null, 2)]),
      cfgExtra: { maxModelPricePages: 2 },
    });
    try {
      const report = await r.run();
      assert.deepEqual(renders(r), [[3, 5]], 'page 2 is not rendered for the models');
      assert.equal(modelCalls(r).length, 0);
      assert.deepEqual(report.ai.models.map((m) => m.price), [null, null, null]);
      assert.deepEqual(report.modelPrices.tooMany, { pages: 3, max: 2 });
      assert.ok(report.warningCodes.includes('model-price-not-printed'));
      assert.ok(report.warnings.some((w) => /too many pages/.test(w) && /3/.test(w) && /2/.test(w)), report.warnings.join(' | '));
    } finally { r.cleanup(); }
  });

  it('one specific unit is not "from the cheapest model": the headline keeps its own checks', async () => {
    const a = withModels([model('Lulu', 319015, null, 3)], {
      price: { amount: 350000, currency: 'SAR', from: false, period: null, onRequest: false }, priceEvidence: { page: 3, quote: '350,000' },
      unit: { unitRef: 'A-12', block: null, floor: 3 },
    });
    const r = await rig({ listing: a, confirm: [350000] });
    try {
      const report = await r.run();
      assert.deepEqual(report.ai.models.map((m) => m.price), [319015], 'the model price is still checked and kept');
      assert.deepEqual(r.calls().filter((c) => c.tool === 'claude-confirm').map((c) => c.amount), [350000], 'the unit\'s own price is checked the old way');
      assert.deepEqual(report.listingPreview.price, { amount: 350000, currency: 'SAR', from: false, period: null, onRequest: false });
      assert.deepEqual(report.priceEvidence, { inText: false, confirmed: true });
    } finally { r.cleanup(); }
  });

  it('the headline taken from the models keeps the period the model read (a monthly rent stays monthly)', async () => {
    const a = withModels([model('Studio', 4500, null, 3), model('One-bed', 6000, null, 3)], { price: { amount: null, currency: 'SAR', from: false, period: 'month', onRequest: true } });
    a.listing.category = 'rent';
    const r = await rig({ listing: a });
    try {
      const report = await r.run();
      assert.equal(report.listingPreview.price.amount, 4500);
      assert.equal(report.listingPreview.price.from, true);
      assert.equal(report.listingPreview.price.period, 'month', 'not reset, and so not turned into a yearly rent');
    } finally { r.cleanup(); }
  });
});

// The currency is part of the price (review 2026-11-17). Every reading here FOLLOWS THE PROMPT
// (prompt.md, unit models): when the models carry prices, the headline is the lowest model price,
// `from: true`, in `price.currency` — so the headline amount is not an independent reading of the
// currency, and a brochure priced in £ comes back "from 1,250,000 SAR". The second model follows its
// prompt too: it confirms a figure only when the page prints it IN the currency asked (rig printedIn).
describe('processPdf: TAQEEM currency — a figure printed in another currency is never published as the reading\'s', { timeout: 120000 }, () => {
  const model = (en, price, page) => ({
    name: { en, ar: `نموذج ${en}` }, bedrooms: 2, bathrooms: 2, areaSqm: 105, rooms: null, availability: null,
    price, subsidisedPrice: null, evidence: { page, quote: String(price) }, floorPlan: null,
  });
  const modelCalls = (r) => r.calls().filter((c) => c.tool === 'claude-model-confirm');
  const headlineCalls = (r) => r.calls().filter((c) => c.tool === 'claude-confirm');
  const ON_REQUEST = { amount: null, currency: 'SAR', from: false, period: null, onRequest: true };
  const ABROAD = {
    district: { en: 'Hampstead', ar: 'هامبستيد' }, city: { en: 'London', ar: 'لندن' },
    country: { en: 'United Kingdom', ar: 'المملكة المتحدة' }, countryCode: 'GB',
  };
  /** A reading that follows prompt.md: the headline IS the lowest model price, from, in `currency`. */
  const byThePrompt = (models, currency, quote) => {
    const low = Math.min(...models.map((m) => m.price));
    return { ...answer({ price: { amount: low, currency, from: true, period: null, onRequest: false }, priceEvidence: { page: 3, quote } }), models };
  };
  const london = () => {
    const a = byThePrompt([model('Flat A', 1250000, 3), model('Flat B', 2000000, 3)], 'SAR', '£1,250,000');
    a.listing.location = ABROAD;
    a.listing.category = 'international';
    return a;
  };

  it('P1: a Hampstead brochure printing £1,250,000 / £2,000,000, read "from 1,250,000 SAR" — no SAR price anywhere (image-only pages)', async () => {
    // Image-only: every page is rendered, so the headline goes to the second model — which sees £, not SAR.
    const r = await rig({ listing: london(), pageText: ['Hampstead', 'x', 'Flat A £1,250,000\nFlat B £2,000,000', 'y', 'z'], printedIn: 'GBP', confirm: [1250000, 2000000] });
    try {
      const report = await r.run();
      assert.equal(modelCalls(r).length, 0, 'GB prices in a currency the site does not print: no model figure is checked');
      assert.equal(report.modelPrices.decision, 'currency-unconfirmed');
      assert.deepEqual(report.listingPreview.models.map((m) => [m.price, m.subsidisedPrice]), [[null, null], [null, null]]);
      assert.deepEqual(headlineCalls(r).map((c) => [c.amount, c.currency, c.page, c.bare]), [[1250000, 'SAR', 3, false]], 'asked IN SAR, a bare figure not allowed abroad');
      assert.deepEqual(report.listingPreview.price, ON_REQUEST, 'no SAR price published');
      assert.ok(report.warningCodes.includes('price-not-printed') && report.warningCodes.includes('model-price-not-printed'));
      assert.ok(report.warnings.some((w) => /their currency could not be established/.test(w) && /GB/.test(w)), report.warnings.join(' | '));
    } finally { r.cleanup(); }
  });

  it('P1 with a readable text layer: "£1,250,000" is a price in pounds, not "1,250,000 SAR" — and no bare figure counts abroad', async () => {
    const text = (rows) => ['Hampstead Residences — a development of two and three bedroom flats in Hampstead, London, with a concierge, gym and gardens',
      'Location — minutes from Hampstead Heath, the Underground and the village high street, with schools and parks nearby', rows,
      'Specification — oak floors, underfloor heating, comfort cooling and a private terrace or balcony for every apartment',
      'Completion — the second quarter of 2027; viewings by appointment with the sales team on site'];
    for (const rows of ['Flat A two bedrooms £1,250,000\nFlat B three bedrooms £2,000,000', 'Prices in pounds sterling\nFlat A two bedrooms 1,250,000\nFlat B three bedrooms 2,000,000']) {
      const r = await rig({ listing: london(), pageText: text(rows), printedIn: 'GBP', confirm: [1250000, 2000000] });
      try {
        const report = await r.run();
        assert.equal(report.priceEvidence.inText, false, rows);
        assert.deepEqual(report.listingPreview.price, ON_REQUEST, rows);
        assert.deepEqual(report.listingPreview.models.map((m) => m.price), [null, null]);
      } finally { r.cleanup(); }
    }
  });

  it('a Saudi brochure priced in USD that the reading reports as SAR: the page check refuses every figure, and the headline too', async () => {
    const pageText = [BROCHURE[0], LOCATION_PAGE, 'نموذج نورس $419,994\nنموذج لؤلؤ $319,015', 'غرفة نوم 03', 'x'];
    const reading = () => byThePrompt([model('Nawras', 419994, 3), model('Lulu', 319015, 3)], 'SAR', '$319,015');
    const r = await rig({ listing: reading(), pageText, printedIn: 'USD', confirm: [419994, 319015] });
    try {
      const report = await r.run();
      assert.deepEqual(modelCalls(r).map((c) => [c.page, c.currency, c.bare]), [[3, 'SAR', true]], 'checked IN SAR (a bare figure would do in Saudi Arabia)');
      assert.deepEqual(report.ai.models.map((m) => m.price), [null, null], 'printed in $, so not SAR prices');
      assert.equal(report.priceEvidence.inText, false, '"$319,015" in the text layer is not 319,015 SAR');
      assert.deepEqual(headlineCalls(r).map((c) => [c.amount, c.currency]), [[319015, 'SAR']]);
      assert.deepEqual(report.listingPreview.price, ON_REQUEST);
      assert.deepEqual(report.modelPrices.refused.sort(), [319015, 419994]);
    } finally { r.cleanup(); }
    // The same brochure read truthfully, in USD: every figure is confirmed IN USD and the headline is "from" the cheaper one.
    const usd = reading();
    usd.listing.price.currency = 'USD';
    usd.priceEvidence.quote = '$319,015';
    const ok = await rig({ listing: usd, pageText, printedIn: 'USD' });
    try {
      const report = await ok.run();
      assert.deepEqual(modelCalls(ok).map((c) => [c.currency, c.bare]), [['USD', false]]);
      assert.deepEqual(report.ai.models.map((m) => m.price), [419994, 319015]);
      assert.deepEqual(report.listingPreview.price, { amount: 319015, currency: 'USD', from: true, period: null, onRequest: false });
    } finally { ok.cleanup(); }
  });

  it('a Saudi price table that shows no currency at all is in riyals: confirmed IN SAR', async () => {
    const r = await rig({ listing: byThePrompt([model('Nawras', 419994, 3), model('Lulu', 319015, 3)], 'SAR', '319,015'), printedIn: null });
    try {
      const report = await r.run();
      assert.deepEqual(report.ai.models.map((m) => m.price), [419994, 319015]);
      assert.equal(report.listingPreview.price.amount, 319015);
    } finally { r.cleanup(); }
  });

  // C2 (final review 2026-11-17): abroad, in a country whose own currency the site does not print, a reading in
  // USD or EUR beside its own headline price establishes the models' currency — every figure is then confirmed
  // IN it on its page by a second model that follows its prompt (rig `facts`), a bare figure never counting there.
  const ISTANBUL = { district: { en: 'Besiktas', ar: 'بشيكتاش' }, city: { en: 'Istanbul', ar: 'إسطنبول' }, country: { en: 'Turkey', ar: 'تركيا' }, countryCode: 'TR' };
  const istanbul = (currency) => {
    const a = byThePrompt([model('1+1', 250000, 3), model('2+1', 400000, 3)], currency, '$250,000');
    a.listing.location = ISTANBUL;
    a.listing.category = 'international';
    return a;
  };
  const rows = (mark) => ({ 3: [{ fig: 250000, mark, kind: 'model', model: '1+1' }, { fig: 400000, mark, kind: 'model', model: '2+1' }] });

  it('C2: an Istanbul development printing "$" beside every row, read in USD: the model prices are checked IN USD and published', async () => {
    const r = await rig({ listing: istanbul('USD'), pageText: ['Istanbul', 'x', '1+1 apartments $250,000\n2+1 apartments $400,000', 'y', 'z'], facts: rows('$') });
    try {
      const report = await r.run();
      assert.equal(report.modelPrices.decision, undefined, 'established: no currency drop');
      assert.deepEqual(modelCalls(r).map((c) => [c.page, c.currency, c.bare]), [[3, 'USD', false]], 'IN USD; a bare figure does not count abroad');
      assert.deepEqual(report.ai.models.map((m) => m.price), [250000, 400000]);
      assert.deepEqual(report.listingPreview.price, { amount: 250000, currency: 'USD', from: true, period: null, onRequest: false });
      assert.deepEqual(checkListing(report.listingPreview), []);
    } finally { r.cleanup(); }
  });

  it('C2: …but the same reading over rows printed in Turkish lira, or with no currency at all, publishes no model price', async () => {
    for (const mark of ['TL', '₺', null]) {
      const r = await rig({ listing: istanbul('USD'), pageText: ['Istanbul', 'x', 'y', 'z', 'w'], facts: rows(mark) });
      try {
        const report = await r.run();
        assert.deepEqual(modelCalls(r).map((c) => [c.currency, c.bare]), [['USD', false]], String(mark));
        assert.deepEqual(report.ai.models.map((m) => m.price), [null, null], String(mark));
        assert.deepEqual(report.listingPreview.price, { ...ON_REQUEST, currency: 'USD' }, String(mark));
      } finally { r.cleanup(); }
    }
  });

  it('C2: abroad, SAR (the contract\'s default) or a reading with no price of its own still establishes nothing — and the warning says why, truthfully', async () => {
    const sar = await rig({ listing: istanbul('SAR'), pageText: ['Istanbul', 'x', 'y', 'z', 'w'], facts: rows('$') });
    try {
      const report = await sar.run();
      assert.equal(report.modelPrices.decision, 'currency-unconfirmed');
      assert.equal(modelCalls(sar).length, 0);
      const w = report.warnings.find((x) => /their currency could not be established/.test(x)) ?? '';
      assert.match(w, /TR/);
      assert.match(w, /only in USD or EUR/);
      assert.match(w, /this reading has SAR/);
    } finally { sar.cleanup(); }
    const onRequest = istanbul('USD');
    onRequest.listing.price = { amount: null, currency: 'USD', from: false, period: null, onRequest: true };
    const none = await rig({ listing: onRequest, pageText: ['Istanbul', 'x', 'y', 'z', 'w'], facts: rows('$') });
    try {
      const report = await none.run();
      assert.equal(report.modelPrices.decision, 'currency-unconfirmed');
      const w = report.warnings.find((x) => /their currency could not be established/.test(x)) ?? '';
      assert.match(w, /this reading has USD and no price of its own/);
      assert.doesNotMatch(w, /contract's default or a conversion/, 'a USD reading is not called the default');
    } finally { none.cleanup(); }
  });

  it('M7: a Bulgarian villa printing "125,000 лв.", read as 125,000 EUR, is on request — leva are not euros, though Bulgaria now prices in EUR', async () => {
    const long = (s) => `${s}\nA residential villa for sale. This page of the brochure describes the property in detail: its location, finishes, amenities, parking, security and the neighbourhood around it.`;
    const sofia = (text) => {
      const a = { ...answer({ price: { amount: 125000, currency: 'EUR', from: false, period: null, onRequest: false }, priceEvidence: { page: 3, quote: text } }), models: [] };
      a.listing.project = null;
      a.listing.type = 'villa';
      a.listing.category = 'international';
      a.listing.location = { district: { en: 'Lozenets', ar: 'لوزينتس' }, city: { en: 'Sofia', ar: 'صوفيا' }, country: { en: 'Bulgaria', ar: 'بلغاريا' }, countryCode: 'BG' };
      return a;
    };
    for (const [text, mark] of [['Цена 125,000 лв.', 'лв.'], ['Price 125,000 BGN', 'BGN']]) {
      const r = await rig({ listing: sofia(text), pageText: [long('Sofia'), long('x'), long(text), long('y'), long('z')], facts: { 3: [{ fig: 125000, mark, kind: 'whole' }] } });
      try {
        const report = await r.run();
        assert.equal(report.priceEvidence.inText, false, text);
        assert.deepEqual(report.listingPreview.price, { amount: null, currency: 'EUR', from: false, period: null, onRequest: true }, text);
      } finally { r.cleanup(); }
    }
    // The same villa printing its price in euros is published as such.
    const ok = await rig({ listing: sofia('Price €125,000'), pageText: [long('Sofia'), long('x'), long('Price €125,000'), long('y'), long('z')] });
    try {
      assert.deepEqual((await ok.run()).listingPreview.price, { amount: 125000, currency: 'EUR', from: false, period: null, onRequest: false });
    } finally { ok.cleanup(); }
  });
});

// OM1 / QA1 (final review 2026-11-17): a bare "ريال" / ﷼ is the riyal of the country the property is in — the
// Omani rial in Oman (about ten Saudi riyals each), the Qatari riyal in Qatar (a currency the site does not print)
// — and the Saudi riyal anywhere else. Readings and the second model follow their prompts (rig `facts`: the
// second model counts a figure IN a currency only by the marks its prompt lists for that currency).
describe('processPdf: a bare riyal is the riyal of the country the property is in', { timeout: 120000 }, () => {
  const place = (countryCode, en) => ({ district: { en: 'Al Khuwair', ar: 'الخوير' }, city: { en, ar: 'مدينة' }, country: { en, ar: 'دولة' }, countryCode });
  const OMAN = place('OM', 'Muscat');
  const QATAR = place('QA', 'Doha');
  const SAUDI = place('SA', 'Jeddah');
  const long = (s) => `${s}\nA residential villa for sale (فيلا سكنية للبيع). This page of the brochure describes the property in detail: its location, finishes, amenities, parking, security and the neighbourhood around it.`;
  const textPages = (p3) => [long('Overview'), long('Location'), long(p3), long('Specification'), long('Contact the sales team')];
  const headlineCalls = (r) => r.calls().filter((c) => c.tool === 'claude-confirm');
  const modelCalls = (r) => r.calls().filter((c) => c.tool === 'claude-model-confirm');
  const ON_REQUEST = (currency) => ({ amount: null, currency, from: false, period: null, onRequest: true });
  const villa = (amount, currency, location) => {
    const a = { ...answer({ price: { amount, currency, from: false, period: null, onRequest: false }, priceEvidence: { page: 3, quote: `${amount.toLocaleString('en-US')} ريال` } }), models: [] };
    a.listing.project = null;
    a.listing.type = 'villa';
    a.listing.category = 'buy';
    a.listing.location = location;
    return a;
  };

  it('OM1: an Omani villa printing "190,000 ريال", read as SAR, is never published as 190,000 SAR — the text layer settles nothing', async () => {
    const r = await rig({ listing: villa(190000, 'SAR', OMAN), pageText: textPages('السعر 190,000 ريال') });
    try {
      const report = await r.run();
      assert.equal(report.priceEvidence.inText, false, 'a bare ريال in Oman is the Omani rial');
      assert.deepEqual(report.listingPreview.price, ON_REQUEST('SAR'));
      assert.ok(report.warningCodes.includes('price-not-printed'));
    } finally { r.cleanup(); }
    // OM2: read truthfully, in OMR, it is published as such.
    const ok = await rig({ listing: villa(190000, 'OMR', OMAN), pageText: textPages('السعر 190,000 ريال') });
    try {
      const report = await ok.run();
      assert.equal(report.priceEvidence.inText, true);
      assert.deepEqual(report.listingPreview.price, { amount: 190000, currency: 'OMR', from: false, period: null, onRequest: false });
      assert.deepEqual(checkListing(report.listingPreview), []);
    } finally { ok.cleanup(); }
  });

  it('QA1: a Qatari villa printing "1,250,000 ريال", read as SAR, is on request (Qatari riyals, which the site does not print)', async () => {
    const r = await rig({ listing: villa(1250000, 'SAR', QATAR), pageText: textPages('السعر 1,250,000 ريال') });
    try {
      const report = await r.run();
      assert.equal(report.priceEvidence.inText, false);
      assert.deepEqual(report.listingPreview.price, ON_REQUEST('SAR'));
    } finally { r.cleanup(); }
  });

  it('I1: an abbreviation with an Arabic comma or a word straight after it is still its currency — never a bare figure taken for the reading\'s', async () => {
    for (const [amount, currency, location, text, mark] of [
      [850000, 'OMR', OMAN, 'تبدأ الأسعار من 850,000 ر.س، شاملة الضريبة', 'ر.س'],
      [850000, 'OMR', OMAN, 'تبدأ الأسعار من 850,000 ر.سشاملة الضريبة', 'ر.س'],
      [1250000, 'SAR', SAUDI, 'السعر 1,250,000 د.إ، شامل', 'د.إ'],
      [125000, 'SAR', SAUDI, 'السعر 125,000 ر.ع، شامل', 'ر.ع.'],
    ]) {
      const r = await rig({ listing: villa(amount, currency, location), pageText: textPages(text), facts: { 3: [{ fig: amount, mark, kind: 'whole' }] } });
      try {
        const report = await r.run();
        assert.equal(report.priceEvidence.inText, false, text);
        assert.deepEqual(report.listingPreview.price, ON_REQUEST(currency), `${text} is not ${amount} ${currency}`);
      } finally { r.cleanup(); }
    }
    // Read truthfully, in SAR, the Omani villa's Saudi price is published as such.
    const ok = await rig({ listing: villa(850000, 'SAR', OMAN), pageText: textPages('تبدأ الأسعار من 850,000 ر.س، شاملة الضريبة') });
    try {
      const report = await ok.run();
      assert.equal(report.priceEvidence.inText, true);
      assert.deepEqual(report.listingPreview.price, { amount: 850000, currency: 'SAR', from: false, period: null, onRequest: false });
    } finally { ok.cleanup(); }
  });

  it('a Saudi villa printing "1,250,000 ريال" is still 1,250,000 SAR off the text layer', async () => {
    const r = await rig({ listing: villa(1250000, 'SAR', SAUDI), pageText: textPages('السعر 1,250,000 ريال') });
    try {
      const report = await r.run();
      assert.equal(report.priceEvidence.inText, true);
      assert.equal(headlineCalls(r).length, 0, 'settled by the text layer, no second model');
      assert.deepEqual(report.listingPreview.price, { amount: 1250000, currency: 'SAR', from: false, period: null, onRequest: false });
    } finally { r.cleanup(); }
  });

  it('OM3: an Omani development whose page rows print a bare "ريال" (image-only), read "from 190,000 SAR" — the second model is told the rows are Omani rials', async () => {
    const model = (en, price) => ({
      name: { en, ar: `نموذج ${en}` }, bedrooms: 2, bathrooms: 2, areaSqm: 105, rooms: null, availability: null,
      price, subsidisedPrice: null, evidence: { page: 3, quote: `${price.toLocaleString('en-US')} ريال` }, floorPlan: null,
    });
    const reading = (currency) => {
      const a = { ...answer({ price: { amount: 190000, currency, from: true, period: null, onRequest: false }, priceEvidence: { page: 3, quote: '190,000 ريال' } }), models: [model('A', 190000), model('B', 250000)] };
      a.listing.location = OMAN;
      return a;
    };
    const facts = { 3: [{ fig: 190000, mark: 'ريال', kind: 'model', model: 'A' }, { fig: 250000, mark: 'ريال', kind: 'model', model: 'B' }] };
    const pageText = ['a', 'b', 'c', 'd', 'e'];
    const r = await rig({ listing: reading('SAR'), pageText, facts });
    try {
      const report = await r.run();
      assert.deepEqual(modelCalls(r).map((c) => [c.page, c.currency, c.bare]), [[3, 'SAR', false]]);
      assert.deepEqual(report.ai.models.map((m) => m.price), [null, null], 'Omani rials are not SAR');
      assert.deepEqual(headlineCalls(r).map((c) => [c.amount, c.currency, c.bare]), [[190000, 'SAR', false]]);
      assert.deepEqual(report.listingPreview.price, ON_REQUEST('SAR'));
    } finally { r.cleanup(); }
    // Read truthfully, in OMR: every row is confirmed IN OMR and the headline is "from" the cheaper one.
    const ok = await rig({ listing: reading('OMR'), pageText, facts });
    try {
      const report = await ok.run();
      assert.deepEqual(modelCalls(ok).map((c) => [c.currency, c.bare]), [['OMR', true]]);
      assert.deepEqual(report.ai.models.map((m) => m.price), [190000, 250000]);
      assert.deepEqual(report.listingPreview.price, { amount: 190000, currency: 'OMR', from: true, period: null, onRequest: false });
    } finally { ok.cleanup(); }
  });
});

// A single property is never "From" its cheapest model (review 2026-11-17, P3 / P3e). prompt.md keeps
// "headline = the lowest model price, from" for a whole development (a project, no unit, two models or
// more); a single property's headline is its own printed price, and its models are normally none. The
// readings below follow that prompt — and the ones marked "old habit" still take the headline from the
// models, which the pipeline must not publish as "From …": `from` is cleared and the figure must be
// confirmed on its page AS THE WHOLE PROPERTY'S price (never by the text layer, which cannot tell a
// floor's price from the villa's), else "price on request".
describe('processPdf: a single property is never "From" its cheapest model', { timeout: 120000 }, () => {
  const model = (en, price, page) => ({
    name: { en, ar: `نموذج ${en}` }, bedrooms: 5, bathrooms: 6, areaSqm: 450, rooms: null, availability: null,
    price, subsidisedPrice: null, evidence: { page, quote: `SAR ${price.toLocaleString('en-US')}` }, floorPlan: null,
  });
  const ON_REQUEST = { amount: null, currency: 'SAR', from: false, period: null, onRequest: true };
  const headlineCalls = (r) => r.calls().filter((c) => c.tool === 'claude-confirm');
  const villa = ({ amount, from, quote, models = [] }) => {
    const a = { ...answer({ price: { amount, currency: 'SAR', from, period: null, onRequest: false }, priceEvidence: { page: 3, quote } }), models };
    a.listing.project = null;
    a.listing.type = 'villa';
    a.listing.category = 'buy';
    return a;
  };

  it('P3e: one villa, one priced "model" — by the prompt its own price; by the old habit never "From SAR 4,400,000"', async () => {
    const pageText = ['Villa', 'x', 'Villa SAR 4,400,000', 'y', 'z'];
    // By the prompt: the villa's own printed price, no `from`, no models.
    const ok = await rig({ listing: villa({ amount: 4400000, from: false, quote: 'SAR 4,400,000' }), pageText, confirm: [4400000] });
    try {
      const report = await ok.run();
      assert.deepEqual(report.listingPreview.price, { amount: 4400000, currency: 'SAR', from: false, period: null, onRequest: false });
      assert.deepEqual(checkListing(report.listingPreview), []);
    } finally { ok.cleanup(); }
    // The old habit: headline = its one model, from. Published as the villa's own price once a second model
    // has seen it printed AS the villa's price — never "From".
    const old = await rig({ listing: villa({ amount: 4400000, from: true, quote: 'SAR 4,400,000', models: [model('Villa', 4400000, 3)] }), pageText, confirm: [4400000] });
    try {
      const report = await old.run();
      assert.deepEqual(report.listingPreview.price, { amount: 4400000, currency: 'SAR', from: false, period: null, onRequest: false });
      assert.deepEqual(headlineCalls(old).map((c) => [c.amount, c.whole, c.project]), [[4400000, true, false]], 'asked as the whole property\'s price');
      assert.deepEqual(report.listingPreview.models.map((m) => m.price), [4400000]);
      assert.ok(report.warnings.some((w) => /not "From"/.test(w)), report.warnings.join(' | '));
      assert.deepEqual(checkListing(report.listingPreview), []);
    } finally { old.cleanup(); }
    // …and when the page does not print it as the villa's price: on request, still never "From".
    const no = await rig({ listing: villa({ amount: 4400000, from: true, quote: 'SAR 4,400,000', models: [model('Villa', 4400000, 3)] }), pageText });
    try {
      const report = await no.run();
      assert.deepEqual(report.listingPreview.price, ON_REQUEST);
      assert.equal(report.priceEvidence.inText, false, 'the text layer cannot say whose price "SAR 4,400,000" is');
      assert.ok(report.warningCodes.includes('price-not-printed'));
    } finally { no.cleanup(); }
  });

  it('P3: a villa priced per floor (2,000,000 + 2,500,000, total 4,500,000) — the printed total, never "From 2,000,000"', async () => {
    const pageText = ['Villa', 'x', 'Ground floor SAR 2,000,000\nFirst floor SAR 2,500,000\nTotal SAR 4,500,000', 'y', 'z'];
    // By the prompt: the headline is the villa's printed total, and its floors are not models.
    const ok = await rig({ listing: villa({ amount: 4500000, from: false, quote: 'Total SAR 4,500,000' }), pageText, confirm: [4500000] });
    try {
      const report = await ok.run();
      assert.deepEqual(report.listingPreview.price, { amount: 4500000, currency: 'SAR', from: false, period: null, onRequest: false });
      assert.equal('models' in report.listingPreview, false);
    } finally { ok.cleanup(); }
    // The old habit: the floors as models, the headline "from" the cheaper floor. The second model, asked
    // for the whole villa's price, does not take a floor's for it: on request — never "From SAR 2,000,000",
    // nor "SAR 2,000,000" off the text layer.
    const floors = () => [model('Ground floor', 2000000, 3), model('First floor', 2500000, 3)];
    const old = await rig({ listing: villa({ amount: 2000000, from: true, quote: 'SAR 2,000,000', models: floors() }), pageText, confirm: [4500000] });
    try {
      const report = await old.run();
      assert.deepEqual(report.listingPreview.price, ON_REQUEST);
      assert.deepEqual(headlineCalls(old).map((c) => [c.amount, c.whole]), [[2000000, true]]);
      assert.deepEqual(report.listingPreview.models.map((m) => m.price), [2000000, 2500000], 'the floors keep their confirmed prices');
      assert.deepEqual(checkListing(report.listingPreview), []);
    } finally { old.cleanup(); }
  });

  it('one specific unit is not "From" its models either; a project of two models or more still is', async () => {
    const unit = villa({ amount: 2000000, from: true, quote: 'SAR 2,000,000', models: [model('A', 2000000, 3), model('B', 2500000, 3)] });
    unit.listing.project = { name: { en: 'Palm Compound', ar: 'مجمع النخيل' }, developer: { en: 'Palm', ar: 'النخيل' } };
    unit.listing.unit = { unitRef: '12', block: null, floor: null };
    const pageText = ['Villa', 'x', 'A SAR 2,000,000\nB SAR 2,500,000', 'y', 'z'];
    const r = await rig({ listing: unit, pageText });
    try {
      const report = await r.run();
      assert.deepEqual(report.listingPreview.price, ON_REQUEST);
      assert.deepEqual(headlineCalls(r).map((c) => [c.amount, c.whole]), [[2000000, true]]);
    } finally { r.cleanup(); }
    const project = villa({ amount: 2000000, from: true, quote: 'SAR 2,000,000', models: [model('A', 2000000, 3), model('B', 2500000, 3)] });
    project.listing.project = unit.listing.project;
    const p = await rig({ listing: project, pageText });
    try {
      const report = await p.run();
      assert.deepEqual(report.listingPreview.price, { amount: 2000000, currency: 'SAR', from: true, period: null, onRequest: false });
      assert.equal(headlineCalls(p).length, 0, 'a whole development\'s headline IS its confirmed cheapest model');
    } finally { p.cleanup(); }
  });

  it('a single property whose brochure itself says "starting from" a figure no model has keeps `from`', async () => {
    const a = villa({ amount: 3900000, from: true, quote: 'starting from SAR 3,900,000', models: [model('Ground floor', 2000000, 3), model('First floor', 2500000, 3)] });
    const r = await rig({ listing: a, pageText: ['Villa', 'x', 'starting from SAR 3,900,000', 'y', 'z'], confirm: [3900000] });
    try {
      const report = await r.run();
      assert.deepEqual(report.listingPreview.price, { amount: 3900000, currency: 'SAR', from: true, period: null, onRequest: false });
    } finally { r.cleanup(); }
  });

  // Final review 2026-11-17 (the second model follows its prompt: rig `facts`; the text layer is a readable one).
  const long = (s) => `${s}\nA residential villa for sale (فيلا سكنية للبيع). This page of the brochure describes the property in detail: its location, finishes, amenities, parking, security and the neighbourhood around it.`;
  const textPages = (p3) => [long('Overview'), long('Location'), long(p3), long('Specification'), long('Contact the sales team')];
  const floorText = 'Ground floor SAR 2,000,000\nFirst floor SAR 2,500,000\nTotal SAR 4,500,000';
  const floorFacts = (whole = 4500000) => ({ 3: [
    { fig: 2000000, mark: 'SAR', kind: 'floor', model: 'Ground floor' }, { fig: 2500000, mark: 'SAR', kind: 'floor', model: 'First floor' },
    { fig: whole, mark: 'SAR', kind: 'whole' },
  ] });

  it('S1g: floors as models, `from` NOT set, the headline = the cheaper floor — still checked as the whole villa\'s price, never off the text layer', async () => {
    const floors = () => [model('Ground floor', 2000000, 3), model('First floor', 2500000, 3)];
    const r = await rig({ listing: villa({ amount: 2000000, from: false, quote: 'SAR 2,000,000', models: floors() }), pageText: textPages(floorText), facts: floorFacts() });
    try {
      const report = await r.run();
      assert.equal(report.priceEvidence.inText, false, '"SAR 2,000,000" in the text layer is the ground floor\'s, as far as anything local can tell');
      assert.deepEqual(headlineCalls(r).map((c) => [c.amount, c.whole]), [[2000000, true]]);
      assert.deepEqual(report.listingPreview.price, ON_REQUEST, 'never "SAR 2,000,000" for the whole villa');
      assert.deepEqual(report.listingPreview.models.map((m) => m.price), [2000000, 2500000], 'the floors keep their confirmed prices');
      assert.ok(report.warningCodes.includes('price-not-printed'));
    } finally { r.cleanup(); }
    // When the page does print that figure as the whole property's price, it is published — as its own price.
    const ok = await rig({ listing: villa({ amount: 2000000, from: false, quote: 'SAR 2,000,000', models: floors() }), pageText: textPages(floorText), facts: floorFacts(2000000) });
    try {
      const report = await ok.run();
      assert.deepEqual(report.listingPreview.price, { amount: 2000000, currency: 'SAR', from: false, period: null, onRequest: false });
      assert.deepEqual(checkListing(report.listingPreview), []);
    } finally { ok.cleanup(); }
  });

  it('S1g (final review M3): two floors as models, only ONE priced, `from` not set, the headline = that floor — still checked as the whole villa\'s price', async () => {
    const floors = () => [model('Ground floor', 2000000, 3), { ...model('First floor', 2500000, 3), price: null, evidence: null }];
    const text = 'Ground floor SAR 2,000,000\nFirst floor (price on request)\nTotal SAR 4,500,000';
    const facts = (whole) => ({ 3: [{ fig: 2000000, mark: 'SAR', kind: 'floor', model: 'Ground floor' }, { fig: whole, mark: 'SAR', kind: 'whole' }] });
    const r = await rig({ listing: villa({ amount: 2000000, from: false, quote: 'SAR 2,000,000', models: floors() }), pageText: textPages(text), facts: facts(4500000) });
    try {
      const report = await r.run();
      assert.equal(report.priceEvidence.inText, false, '"SAR 2,000,000" in the text layer is the ground floor\'s');
      assert.deepEqual(headlineCalls(r).map((c) => [c.amount, c.whole]), [[2000000, true]]);
      assert.deepEqual(report.listingPreview.price, ON_REQUEST, 'never "SAR 2,000,000" for the whole villa');
      assert.deepEqual(report.listingPreview.models.map((m) => m.price), [2000000, null]);
    } finally { r.cleanup(); }
    const ok = await rig({ listing: villa({ amount: 2000000, from: false, quote: 'SAR 2,000,000', models: floors() }), pageText: textPages(text), facts: facts(2000000) });
    try {
      assert.deepEqual((await ok.run()).listingPreview.price, { amount: 2000000, currency: 'SAR', from: false, period: null, onRequest: false });
    } finally { ok.cleanup(); }
  });

  it('S1g: the guard is for a single property with two models or more — not one model, not one specific unit, not a figure no model has', async () => {
    // One priced model, `from` not set: its own price, settled as before (here off the text layer).
    const one = await rig({ listing: villa({ amount: 4400000, from: false, quote: 'SAR 4,400,000', models: [model('Villa', 4400000, 3)] }),
      pageText: textPages('Villa price SAR 4,400,000'), facts: { 3: [{ fig: 4400000, mark: 'SAR', kind: 'whole', model: 'Villa' }] } });
    try {
      const report = await one.run();
      assert.equal(report.priceEvidence.inText, true);
      assert.equal(headlineCalls(one).length, 0);
      assert.deepEqual(report.listingPreview.price, { amount: 4400000, currency: 'SAR', from: false, period: null, onRequest: false });
    } finally { one.cleanup(); }
    // One specific unit of a project, `from` not set, priced like its model (Codex r1 #1c): the text layer cannot tie
    // "A SAR 2,000,000" to unit 12, so only a page that prints it as the unit's own price settles it — a row labelled
    // only "A" does not: on request.
    const unit = villa({ amount: 2000000, from: false, quote: 'SAR 2,000,000', models: [model('A', 2000000, 3), model('B', 2500000, 3)] });
    unit.listing.project = { name: { en: 'Palm Compound', ar: 'مجمع النخيل' }, developer: { en: 'Palm', ar: 'النخيل' } };
    unit.listing.unit = { unitRef: '12', block: null, floor: null };
    const u = await rig({ listing: unit, pageText: textPages('A SAR 2,000,000\nB SAR 2,500,000'), facts: { 3: [{ fig: 2000000, mark: 'SAR', kind: 'model', model: 'A' }, { fig: 2500000, mark: 'SAR', kind: 'model', model: 'B' }] } });
    try {
      const report = await u.run();
      assert.equal(report.priceEvidence.inText, false, 'the text layer cannot say "SAR 2,000,000" is unit 12\'s');
      assert.deepEqual(headlineCalls(u).map((c) => [c.amount, c.whole, c.page]), [[2000000, true, 3]]);
      assert.deepEqual(report.listingPreview.price, ON_REQUEST);
      assert.deepEqual(report.listingPreview.models.map((m) => m.price), [2000000, 2500000], 'the models keep their confirmed prices');
    } finally { u.cleanup(); }
    // The page prints it as unit 12's own price: published, as the unit's own (no `from`).
    const u12 = await rig({ listing: structuredClone(unit), pageText: textPages('A SAR 2,000,000\nB SAR 2,500,000\nUnit 12: SAR 2,000,000'),
      facts: { 3: [{ fig: 2000000, mark: 'SAR', kind: 'model', model: 'A' }, { fig: 2500000, mark: 'SAR', kind: 'model', model: 'B' }, { fig: 2000000, mark: 'SAR', kind: 'whole' }] } });
    try {
      const report = await u12.run();
      assert.deepEqual(report.listingPreview.price, { amount: 2000000, currency: 'SAR', from: false, period: null, onRequest: false });
    } finally { u12.cleanup(); }
    // A unit with no models: its own price off the text layer, as before (pre-existing behaviour, PR #68).
    const plain = structuredClone(unit);
    plain.models = [];
    const p = await rig({ listing: plain, pageText: textPages('Unit 12 SAR 2,000,000') });
    try {
      const report = await p.run();
      assert.equal(report.priceEvidence.inText, true);
      assert.equal(headlineCalls(p).length, 0);
      assert.deepEqual(report.listingPreview.price, { amount: 2000000, currency: 'SAR', from: false, period: null, onRequest: false });
    } finally { p.cleanup(); }
    // The printed total, no `from`, floors as models: not the lowest model price, so its own check, off the text layer.
    const total = await rig({ listing: villa({ amount: 4500000, from: false, quote: 'Total SAR 4,500,000', models: [model('Ground floor', 2000000, 3), model('First floor', 2500000, 3)] }),
      pageText: textPages(floorText), facts: floorFacts() });
    try {
      const report = await total.run();
      assert.equal(report.priceEvidence.inText, true);
      assert.deepEqual(report.listingPreview.price, { amount: 4500000, currency: 'SAR', from: false, period: null, onRequest: false });
    } finally { total.cleanup(); }
  });

  it('Codex r1 #1a: a development whose model prices the page check refused never gets that figure back as its headline off the text layer', async () => {
    const project = { name: { en: 'Palm Compound', ar: 'مجمع النخيل' }, developer: { en: 'Palm', ar: 'النخيل' } };
    const reading = () => {
      const a = villa({ amount: 1250000, from: true, quote: '1,250,000', models: [model('A', 1250000, 3), model('B', 1500000, 3)] });
      a.listing.project = project;
      return a;
    };
    // The page prints the rows in dirhams; the text layer has the figures bare (the mark is an image), so a Saudi
    // property's bare figure would pass the text-layer shortcut. The model check refused both in SAR.
    const aed = { 3: [{ fig: 1250000, mark: 'AED', kind: 'model', model: 'A' }, { fig: 1500000, mark: 'AED', kind: 'model', model: 'B' }] };
    const r = await rig({ listing: reading(), pageText: textPages('A 1,250,000\nB 1,500,000'), facts: aed });
    try {
      const report = await r.run();
      assert.deepEqual(report.modelPrices.refused.sort(), [1250000, 1500000]);
      assert.equal(report.priceEvidence.inText, false, 'a refused model figure is never settled by the text layer');
      assert.deepEqual(headlineCalls(r).map((c) => [c.amount, c.whole, c.page]), [[1250000, true, 3]], 'asked as the whole development\'s own price');
      assert.deepEqual(report.listingPreview.price, ON_REQUEST);
      assert.ok(report.warningCodes.includes('price-not-printed'));
    } finally { r.cleanup(); }
    // The Codex example as printed: "AED 1,250,000" and, a line on, "SAR prices on request".
    const c = await rig({ listing: reading(), pageText: textPages('A AED 1,250,000\nB AED 1,500,000\nSAR prices on request'), facts: aed });
    try {
      const report = await c.run();
      assert.equal(report.priceEvidence.inText, false);
      assert.deepEqual(report.listingPreview.price, ON_REQUEST);
    } finally { c.cleanup(); }
    // A row the model check refused (it read the figure for the wrong model) is not the development's own price either.
    const wrongRow = { 3: [{ fig: 1250000, mark: 'SAR', kind: 'model', model: 'C' }, { fig: 1500000, mark: 'SAR', kind: 'model', model: 'D' }] };
    const w = await rig({ listing: reading(), pageText: textPages('C SAR 1,250,000\nD SAR 1,500,000'), facts: wrongRow });
    try {
      const report = await w.run();
      assert.deepEqual(report.listingPreview.price, ON_REQUEST);
    } finally { w.cleanup(); }
    // The page does print it as the development's own "from" price: published, `from`.
    const ok = await rig({ listing: reading(), pageText: textPages('Starting from SAR 1,250,000\nC SAR 1,250,000\nD SAR 1,500,000'),
      facts: { 3: [...wrongRow[3], { fig: 1250000, mark: 'SAR', kind: 'whole' }] } });
    try {
      const report = await ok.run();
      assert.deepEqual(report.listingPreview.price, { amount: 1250000, currency: 'SAR', from: true, period: null, onRequest: false });
      assert.deepEqual(report.listingPreview.models.map((m) => m.price), [null, null]);
    } finally { ok.cleanup(); }
  });

  it('S2r: a whole-property check whose page was not rendered renders it, like the model check; a render that fails is "try again later", not "not printed"', async () => {
    const reading = () => villa({ amount: 4400000, from: true, quote: 'SAR 4,400,000', models: [model('Villa', 4400000, 3)] });
    const facts = { 3: [{ fig: 4400000, mark: 'SAR', kind: 'whole' }] };
    const pageText = textPages('Villa price SAR 4,400,000');
    const renders = (r) => r.calls().filter((c) => c.tool === 'py-pages').map((c) => [c.dir, c.pages]);
    // The model check's render fails; the headline's own render of the cited page works: confirmed there.
    const r = await rig({ listing: reading(), pageText, facts, failPageDir: 'model-pages' });
    try {
      const report = await r.run();
      assert.deepEqual(renders(r), [['model-pages', [3]], ['headline-pages', [3]]]);
      assert.deepEqual(headlineCalls(r).map((c) => [c.amount, c.whole, c.page]), [[4400000, true, 3]]);
      assert.deepEqual(report.listingPreview.price, { amount: 4400000, currency: 'SAR', from: false, period: null, onRequest: false });
      assert.ok(report.warnings.some((w) => /unit-model price\(s\) could not be completed/.test(w)), report.warnings.join(' | '));
    } finally { r.cleanup(); }
    // Both renders fail: nothing was looked at — "could not be checked, try again later", never "the brochure does not print it".
    const no = await rig({ listing: reading(), pageText, facts, failPageDir: ['model-pages', 'headline-pages'] });
    try {
      const report = await no.run();
      assert.deepEqual(renders(no), [['model-pages', [3]], ['headline-pages', [3]]]);
      assert.equal(headlineCalls(no).length, 0);
      assert.deepEqual(report.listingPreview.price, ON_REQUEST);
      assert.equal(report.priceEvidence.unchecked, true);
      const w = report.warnings.find((x) => /price on request/.test(x)) ?? '';
      assert.match(w, /could not be checked/);
      assert.match(w, /try again later/);
      assert.doesNotMatch(w, /does not print|not printed|quota/);
    } finally { no.cleanup(); }
    // A page rendered for the reading is used as it is: no extra render.
    const image = await rig({ listing: reading(), pageText: ['Villa', 'x', 'Villa price SAR 4,400,000', 'y', 'z'], facts });
    try {
      const report = await image.run();
      assert.ok(!renders(image).some(([dir]) => dir === 'headline-pages'), JSON.stringify(renders(image)));
      assert.equal(report.listingPreview.price.amount, 4400000);
    } finally { image.cleanup(); }
  });

  it('S2r (final review M4): a whole-property check whose citation is a page off — the page whose text prints the figure is looked at too', async () => {
    const reading = () => {
      const a = villa({ amount: 2000000, from: false, quote: 'SAR 2,000,000', models: [model('Ground floor', 2000000, 3), model('First floor', 2500000, 3)] });
      a.priceEvidence = { page: 2, quote: 'SAR 2,000,000' };
      return a;
    };
    const pageText = textPages('Ground floor SAR 2,000,000\nFirst floor SAR 2,500,000\nThe villa as one: SAR 2,000,000');
    const floorsOn3 = [{ fig: 2000000, mark: 'SAR', kind: 'floor', model: 'Ground floor' }, { fig: 2500000, mark: 'SAR', kind: 'floor', model: 'First floor' }];
    const asked = (r) => headlineCalls(r).map((c) => [c.amount, c.whole, c.page]);
    // Cites page 2 (whose text has no such figure); page 3 prints it as the villa's price: confirmed there.
    const r = await rig({ listing: reading(), pageText, facts: { 3: [...floorsOn3, { fig: 2000000, mark: 'SAR', kind: 'whole' }] } });
    try {
      const report = await r.run();
      assert.deepEqual(asked(r), [[2000000, true, 3]], 'the page whose text carries the figure first');
      assert.deepEqual(report.listingPreview.price, { amount: 2000000, currency: 'SAR', from: false, period: null, onRequest: false });
    } finally { r.cleanup(); }
    // Page 3 prints it only as a floor's; the cited page 2 (an image) prints it as the villa's: both are looked at.
    const both = await rig({ listing: reading(), pageText, facts: { 3: floorsOn3, 2: [{ fig: 2000000, mark: 'SAR', kind: 'whole' }] } });
    try {
      const report = await both.run();
      assert.deepEqual(asked(both), [[2000000, true, 3], [2000000, true, 2]]);
      assert.deepEqual(report.listingPreview.price, { amount: 2000000, currency: 'SAR', from: false, period: null, onRequest: false });
    } finally { both.cleanup(); }
    // Neither prints it as the villa's price: on request, "not printed" — after looking at both.
    const none = await rig({ listing: reading(), pageText, facts: { 3: floorsOn3 } });
    try {
      const report = await none.run();
      assert.deepEqual(asked(none), [[2000000, true, 3], [2000000, true, 2]]);
      assert.deepEqual(report.listingPreview.price, ON_REQUEST);
      assert.notEqual(report.priceEvidence.unchecked, true);
    } finally { none.cleanup(); }
  });

  it('S2r (final review M5): a whole-property check after a quota error, its page not rendered — "could not be checked, try again later", never "not printed"', async () => {
    const a = villa({ amount: 2000000, from: false, quote: 'SAR 2,000,000', models: [model('Ground floor', 2000000, 3), model('First floor', 2500000, 3)] });
    a.priceEvidence = { page: 4, quote: 'SAR 2,000,000' };
    // Page 3 (a price table the text layer cannot read) is rendered for the reading; page 4 is not.
    const pageText = [long('Overview'), long('Location'), long('Floor price table'), long('Ground floor SAR 2,000,000'), long('Contact the sales team')];
    const facts = { 3: [{ fig: 2000000, mark: 'SAR', kind: 'floor', model: 'Ground floor' }, { fig: 2500000, mark: 'SAR', kind: 'floor', model: 'First floor' }],
      4: [{ fig: 2000000, mark: 'SAR', kind: 'whole' }] };
    const r = await rig({ listing: a, pageText, facts, modelConfirmFail: 'quota' });
    try {
      const report = await r.run();
      assert.ok(report.modelPrices.fatal, 'the model check hit the quota');
      assert.equal(headlineCalls(r).length, 0, 'no call after a quota error');
      assert.ok(!r.calls().some((c) => c.tool === 'py-pages' && c.dir === 'headline-pages'), 'nothing rendered that cannot be looked at');
      assert.deepEqual(report.listingPreview.price, ON_REQUEST);
      assert.equal(report.priceEvidence.unchecked, true);
      assert.equal(report.priceEvidence.uncheckedWhy, 'quota');
      const w = report.warnings.find((x) => /price on request/.test(x)) ?? '';
      assert.match(w, /could not be checked/);
      assert.match(w, /quota/);
      assert.match(w, /try again later/);
      assert.doesNotMatch(w, /does not print|not printed/);
    } finally { r.cleanup(); }
  });

  it('S2m: ONE model carrying a price the brochure words "starting from" keeps `from` once confirmed as the whole property\'s price', async () => {
    const one = (quote) => villa({ amount: 4400000, from: true, quote, models: [model('Villa', 4400000, 3)] });
    const facts = { 3: [{ fig: 4400000, mark: 'SAR', kind: 'whole', model: 'Villa' }] };
    // The warning quotes the words that made it "From": the from-word through the figure (final review M2).
    for (const [quote, text, words] of [['Starting from SAR 4,400,000', 'Starting from SAR 4,400,000', 'Starting from SAR 4,400,000'],
      ['ابتداءً من 4,400,000 ريال', 'السعر ابتداءً من 4,400,000 ريال', 'ابتداءً من 4,400,000'],
      ['الأسعار تبدأ من 4,400,000 ر.س', 'الأسعار تبدأ من 4,400,000 ر.س', 'تبدأ من 4,400,000'], ['Prices from SAR 4,400,000', 'Prices from SAR 4,400,000', 'from SAR 4,400,000'],
      ['Villa — starting from SAR 4,400,000 incl. VAT', 'Villa — starting from SAR 4,400,000 incl. VAT', 'starting from SAR 4,400,000']]) {
      const r = await rig({ listing: one(quote), pageText: textPages(text), facts });
      try {
        const report = await r.run();
        assert.deepEqual(headlineCalls(r).map((c) => [c.amount, c.whole]), [[4400000, true]], quote);
        assert.deepEqual(report.listingPreview.price, { amount: 4400000, currency: 'SAR', from: true, period: null, onRequest: false }, quote);
        assert.deepEqual(checkListing(report.listingPreview), []);
        const w = report.warnings.find((x) => /shown "From"/.test(x)) ?? '';
        assert.ok(w.includes(`(its evidence: "${words}")`), `${quote}: ${w}`);
      } finally { r.cleanup(); }
    }
    // M2: a from-word that is not the figure's — after it, far before it, or before another figure — is no "From".
    for (const quote of ['Villa price SAR 4,400,000 — 10 minutes from the airport', 'SAR 4,400,000 (from the developer)',
      'From the developer: villa price SAR 4,400,000', 'from SAR 3,900,000 to SAR 4,400,000', 'السعر 4,400,000 ريال، يبعد 10 دقائق ابتداءً من المطار', 'Starting from']) {
      const r = await rig({ listing: one(quote), pageText: textPages('Villa price SAR 4,400,000'), facts });
      try {
        const report = await r.run();
        assert.deepEqual(report.listingPreview.price, { amount: 4400000, currency: 'SAR', from: false, period: null, onRequest: false }, quote);
        assert.ok(!report.warnings.some((x) => /shown "From"/.test(x)), quote);
      } finally { r.cleanup(); }
    }
    // No from-wording in the evidence (the old habit's "from" its one model): its own price, no `from` (P3e).
    const plain = await rig({ listing: one('Villa price SAR 4,400,000'), pageText: textPages('Villa price SAR 4,400,000'), facts });
    try {
      assert.deepEqual((await plain.run()).listingPreview.price, { amount: 4400000, currency: 'SAR', from: false, period: null, onRequest: false });
    } finally { plain.cleanup(); }
    // Not confirmed as the whole property's price: on request, from-wording or not.
    const unconfirmed = await rig({ listing: one('Starting from SAR 4,400,000'), pageText: textPages('Starting from SAR 4,400,000'), facts: { 3: [{ fig: 4400000, mark: 'SAR', kind: 'floor', model: 'Villa' }] } });
    try {
      assert.deepEqual((await unconfirmed.run()).listingPreview.price, ON_REQUEST);
    } finally { unconfirmed.cleanup(); }
    // Two models or more (floors, parts): never "From" its cheapest one, whatever the evidence says.
    const floors = villa({ amount: 2000000, from: true, quote: 'from SAR 2,000,000', models: [model('Ground floor', 2000000, 3), model('First floor', 2500000, 3)] });
    const two = await rig({ listing: floors, pageText: textPages(floorText), facts: floorFacts(2000000) });
    try {
      assert.deepEqual((await two.run()).listingPreview.price, { amount: 2000000, currency: 'SAR', from: false, period: null, onRequest: false });
    } finally { two.cleanup(); }
  });
});

describe('processPdf: unit models and their floor plans reach the repo', { timeout: 120000 }, () => {
  const ON_REQUEST = { amount: null, currency: 'SAR', from: false, period: null, onRequest: true };
  const SLUG = 'jeddah-heights-al-hamdaniyah';
  const PLAN = { src: `/listings/${SLUG}/plan-01.jpg`, thumb: `/listings/${SLUG}/plan-01-thumb.webp` };
  const git = (r, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: r.repo, stdio: 'pipe' }).toString();
  const seedGit = (r) => { git(r, 'init', '-q'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'seed'); };
  const inboxJson = (r) => JSON.parse(fs.readFileSync(path.join(r.repo, 'scripts', 'curate', 'inbox', `${SLUG}.json`), 'utf8'));
  /** Two priced models on page 3; Nawras's floor plan is candidate 5, which the ranking excluded from the gallery. */
  const withPlans = () => {
    const a = {
      ...answer({ price: ON_REQUEST }),
      models: [
        {
          name: { en: 'Nawras', ar: 'نموذج Nawras' }, bedrooms: 3, bathrooms: 2, areaSqm: 105.02, rooms: { en: ['Laundry'], ar: ['غرفة غسيل'] }, availability: null,
          price: 419994, subsidisedPrice: 356024, evidence: { page: 3, quote: '419994' }, floorPlan: 5,
        },
        {
          name: { en: 'Lulu', ar: 'نموذج Lulu' }, bedrooms: 2, bathrooms: 2, areaSqm: 88, rooms: null, availability: null,
          price: 319015, subsidisedPrice: 270425, evidence: { page: 3, quote: '319015' }, floorPlan: null,
        },
      ],
      amenities: { en: ['Health club'], ar: ['نادٍ صحي'] },
      nearby: { en: [], ar: [] },
      warranties: { en: ['Structure — 10 years'], ar: ['الهيكل الإنشائي — 10 سنوات'] },
    };
    a.images[5] = { ...a.images[5], rank: null, hero: false, exclude: true, reason: 'floor plan', focus: null };
    return a;
  };

  it('publishes plan-01.jpg + its thumbnail beside the photos, and the inbox JSON carries both models', async () => {
    const r = await rig({ listing: withPlans() });
    try {
      seedGit(r);
      const report = await r.publish();
      assert.equal(report.slug, SLUG);
      const pub = path.join(r.repo, 'public', 'listings', SLUG);
      assert.deepEqual(fs.readdirSync(pub).sort(), [...[1, 2, 3, 4, 5].flatMap((n) => [`0${n}-thumb.webp`, `0${n}.jpg`]), 'plan-01-thumb.webp', 'plan-01.jpg']);
      const sharp = (await import('sharp')).default;
      assert.equal((await sharp(path.join(pub, 'plan-01.jpg')).metadata()).format, 'jpeg');
      assert.equal((await sharp(path.join(pub, 'plan-01-thumb.webp')).metadata()).format, 'webp');
      assert.deepEqual(report.floorPlans, [{ model: 0, candidate: 5, src: PLAN.src }]);

      const saved = inboxJson(r);
      assert.deepEqual(saved.models.map((m) => m.floorPlan), [PLAN, null]);
      assert.deepEqual(saved.models.map((m) => [m.name.en, m.price, m.subsidisedPrice]), [['Nawras', 419994, 356024], ['Lulu', 319015, 270425]]);
      assert.deepEqual(saved.price, { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false, subsidisedAmount: 270425 });
      assert.deepEqual(saved.amenities, { en: ['Health club'], ar: ['نادٍ صحي'] });
      assert.deepEqual(saved.warranties, { en: ['Structure — 10 years'], ar: ['الهيكل الإنشائي — 10 سنوات'] });
      assert.equal('nearby' in saved, false);
      assert.ok(!JSON.stringify(saved).includes('evidence'), 'the model\'s citation is never committed');
      assert.deepEqual(saved._intake.images.map((im) => im.candidate), [0, 1, 2, 3, 4], 'the floor plan never enters the gallery');
      assert.deepEqual(checkListing(saved), [], 'the committed listing passes the shared rules');
      // New files under the allowlisted public/listings, so the intake's own commit carries them.
      const status = git(r, 'status', '--porcelain', '--untracked-files=all', '--', 'public/listings');
      assert.match(status, new RegExp(`^\\?\\? public/listings/${SLUG}/plan-01\\.jpg$`, 'm'));
      assert.match(status, new RegExp(`^\\?\\? public/listings/${SLUG}/plan-01-thumb\\.webp$`, 'm'));
    } finally { r.cleanup(); }
  });

  it('a dry run previews the plan paths without writing a file', async () => {
    const r = await rig({ listing: withPlans() });
    try {
      const report = await r.run();
      assert.deepEqual(report.listingPreview.models.map((m) => m.floorPlan), [PLAN, null]);
      assert.deepEqual(checkListing(report.listingPreview), []);
      assert.equal(fs.existsSync(path.join(r.repo, 'public', 'listings')), false);
      assert.equal(fs.existsSync(path.join(r.repo, '..', 'work', 'publish')), false, 'nothing staged either');
    } finally { r.cleanup(); }
  });

  it('a floor plan that cannot be decoded is left out with a warning; the listing still publishes', async () => {
    const r = await rig({ listing: withPlans(), broken: [5] });
    try {
      seedGit(r);
      const report = await r.publish();
      const pub = path.join(r.repo, 'public', 'listings', SLUG);
      assert.equal(fs.readdirSync(pub).some((f) => f.startsWith('plan-')), false);
      const saved = inboxJson(r);
      assert.deepEqual(saved.models.map((m) => m.floorPlan), [null, null]);
      assert.ok(report.warnings.includes('1 floor plan not published (Nawras: could not be prepared)'), report.warnings.join(' | '));
      assert.ok(saved._intake.warnings.includes('images-skipped'));
    } finally { r.cleanup(); }
  });

  // The new brochure is drawn from the STAGED folder (photos + floor plans), after both are
  // written and before anything is promoted, so it lands in the repo with them in one commit.
  it('builds the brochure from the staged photos and plans and publishes it beside them', async () => {
    const r = await rig({ listing: withPlans() });
    try {
      seedGit(r);
      const report = await r.publish({}, {});
      const [call, ...more] = r.calls().filter((c) => c.tool === 'brochure');
      assert.equal(more.length, 0, 'one brochure build');
      assert.equal(call.filesDir, path.join(r.repo, '..', 'work', 'publish', SLUG), 'the staging folder, not the repo');
      assert.ok(call.files.includes('plan-01.jpg') && call.files.includes('01.jpg'), call.files.join(' '));
      assert.equal(call.siteJson, path.join(r.repo, 'src', 'data', 'site.json'));
      assert.equal(call.out, path.join(call.filesDir, 'brochure.pdf'));
      assert.equal('_intake' in call.listing, false, 'the intake\'s bookkeeping never reaches the page');
      assert.equal('hidden' in call.listing, false);
      assert.deepEqual(call.listing.models.map((m) => m.floorPlan?.src ?? null), [PLAN.src, null]);
      assert.equal(call.args[call.args.indexOf('--max-mb') + 1], '25');

      assert.deepEqual({ ok: report.brochure.ok, pages: report.brochure.pages, bytes: report.brochure.bytes }, { ok: true, pages: 12, bytes: 23 });
      const pub = path.join(r.repo, 'public', 'listings', SLUG, 'brochure.pdf');
      assert.equal(fs.readFileSync(pub, 'utf8'), '%PDF-1.7 fake brochure\n');
      const saved = inboxJson(r);
      assert.equal(saved.brochureUrl, `https://bona-real-estate.com/listings/${SLUG}/brochure.pdf`);
      assert.ok(!saved._intake.warnings.some((w) => w.startsWith('brochure-')), saved._intake.warnings.join(' '));
    } finally { r.cleanup(); }
  });

  it('a brochure that cannot be built costs the listing nothing but the download button', async () => {
    const r = await rig({ listing: withPlans(), brochureFail: true });
    try {
      seedGit(r);
      const report = await r.publish({}, {});
      assert.equal(report.ok, true);
      assert.equal(report.brochure.ok, false);
      assert.equal(fs.existsSync(path.join(r.repo, 'public', 'listings', SLUG, 'brochure.pdf')), false);
      assert.ok(fs.existsSync(path.join(r.repo, 'public', 'listings', SLUG, 'plan-01.jpg')), 'the rest still publishes');
      const saved = inboxJson(r);
      assert.equal(saved.brochureUrl, null);
      assert.ok(saved._intake.warnings.includes('brochure-failed'));
      assert.ok(report.warnings.some((w) => /brochure could not be built/.test(w)), report.warnings.join(' | '));
    } finally { r.cleanup(); }
  });

  it('a failed rebuild takes the plan files away with the photos', async () => {
    const r = await rig({ listing: withPlans(), build: 'process.exit(1);\n' });
    try {
      seedGit(r);
      await assert.rejects(r.publish());
      assert.equal(fs.existsSync(path.join(r.repo, 'public', 'listings', SLUG)), false);
      assert.equal(git(r, 'status', '--porcelain'), '', 'the clone is back to the commit');
    } finally { r.cleanup(); }
  });
});

// r4 (owner decision 2026-11-21): every floor plan a run would publish is checked by a second model for a phone, an
// email, a website, a social handle, a QR code, a logo / brand name or a price, before any plan file reaches the repo.
describe('processPdf: the floor-plan contact check (r4)', { timeout: 120000 }, () => {
  const ON_REQUEST = { amount: null, currency: 'SAR', from: false, period: null, onRequest: true };
  /** A W023-shaped reading: `n` unit models, each with its own floor plan (candidates 6…6+n-1, excluded from the gallery). */
  const withPlans = (n) => {
    const a = { ...answer({ price: ON_REQUEST }), models: Array.from({ length: n }, (_, k) => ({
      name: { en: `Type ${String.fromCharCode(65 + k)}`, ar: `نموذج ${k + 1}` }, bedrooms: 2, bathrooms: 2, areaSqm: 100 + k, rooms: null, availability: null,
      price: null, subsidisedPrice: null, evidence: null, floorPlan: 6 + k,
    })) };
    for (let k = 0; k < n; k += 1) a.images.push({ index: 6 + k, room: 'view', rank: null, hero: false, exclude: true, reason: 'floor plan', focus: null });
    return a;
  };
  const planCalls = (r) => r.calls().filter((c) => c.tool === 'claude-plan-check');
  const plansOf = (report) => report.listingPreview.models.map((m) => m.floorPlan?.src ?? null);

  it('a W023-shaped brochure: 8 plans, one call, 8 clean answers — all 8 kept, and the reply says so', async () => {
    const r = await rig({ listing: withPlans(8), candidateCount: 14 });
    try {
      const report = await r.run();
      assert.equal(planCalls(r).length, 1, 'one call for all the plans, a dry run too');
      assert.deepEqual(planCalls(r)[0].files, Array.from({ length: 8 }, (_, k) => `plan-0${k + 1}.jpg`));
      assert.equal(plansOf(report).filter(Boolean).length, 8);
      assert.deepEqual([report.planCheck.plans, report.planCheck.leftOut.length, report.planCheck.unchecked.length], [8, 0, 0]);
      assert.equal(msg.planCheckLine(report.planCheck), '8 floor plans · 0 left out by the contact check');
    } finally { r.cleanup(); }
  });

  it('a reply that flags one plan drops only that plan, and the warning names the model and what it shows', async () => {
    const r = await rig({ listing: withPlans(3), candidateCount: 9, planCheck: { 'plan-02': 'phone, logo' } });
    try {
      const report = await r.run();
      assert.deepEqual(plansOf(report).map(Boolean), [true, false, true]);
      assert.ok(report.warnings.some((w) => /Type B/.test(w) && /a phone number/.test(w) && /a logo or brand name/.test(w)), report.warnings.join(' | '));
      assert.equal(msg.planCheckLine(report.planCheck), '3 floor plans · 1 left out by the contact check');
      assert.equal(report.blocked, undefined, 'never blocks the listing');
    } finally { r.cleanup(); }
  });

  it('a duplicate or malformed record drops that plan', async () => {
    for (const planReply of ['duplicate', 'malformed']) {
      const r = await rig({ listing: withPlans(2), candidateCount: 8, planReply });
      try {
        assert.deepEqual(plansOf(await r.run()).map(Boolean), [false, true], planReply);
      } finally { r.cleanup(); }
    }
  });

  it('r5 #5: a reply that says nothing about a plan leaves it unchecked ("try again later"), never "contact details"', async () => {
    // 'missing' (no record about Type A): the whole call is unchecked, Type B too (r8 #1, Codex r7 C#1: a reply that
    // leaves out an image asked cannot be trusted to number the rest; r5 #5's per-plan rule kept Type B, [false, true]).
    for (const [planReply, plans] of [['prose', [false, false]], ['missing', [false, false]]]) {
      const r = await rig({ listing: withPlans(2), candidateCount: 8, planReply });
      try {
        const report = await r.run();
        assert.deepEqual(plansOf(report).map(Boolean), plans, planReply);
        assert.ok(report.warnings.some((w) => /could not be checked/.test(w) && /try again later/.test(w)), report.warnings.join(' | '));
        assert.ok(!report.warnings.some((w) => /contact or brand details|shows/.test(w)), report.warnings.join(' | '));
      } finally { r.cleanup(); }
    }
    // A duplicate or malformed record: left out, worded as no clear answer — not as a flagged plan.
    const d = await rig({ listing: withPlans(2), candidateCount: 8, planReply: 'duplicate' });
    try {
      const report = await d.run();
      assert.ok(report.warnings.some((w) => /no clear answer/.test(w) && /Type A/.test(w)), report.warnings.join(' | '));
      assert.ok(!report.warnings.some((w) => /shows/.test(w)), report.warnings.join(' | '));
    } finally { d.cleanup(); }
  });

  it('r7 #1 (B6a): the check reads each plan under a name carrying its index in that call (image-0.jpg, …), two calls never sharing a file', async () => {
    const r = await rig({ listing: withPlans(13), candidateCount: 19 });
    try {
      const report = await r.run();
      const calls = planCalls(r);
      assert.equal(calls.length, 2);
      for (const c of calls) assert.deepEqual(c.shown.map((f) => path.basename(f)), c.indexes.map((i) => `image-${i}.jpg`), c.shown.join(' '));
      assert.deepEqual(calls.flatMap((c) => c.files).sort(), Array.from({ length: 13 }, (_, k) => `plan-${String(k + 1).padStart(2, '0')}.jpg`));
      assert.equal(new Set(calls.flatMap((c) => c.shown)).size, 13, 'no file shown twice');
      assert.equal(plansOf(report).filter(Boolean).length, 13);
    } finally { r.cleanup(); }
  });

  it('r7 #1 (B6a): a reply numbered by the file names that says nothing about the last plan never publishes the plan with a phone number', async () => {
    // With the plans shown as plan-01..03 this reply was {1 clean}, {2 phone}: Type B's phone plan went up as clean.
    const r = await rig({ listing: withPlans(3), candidateCount: 9, planCheck: { 'plan-02': 'phone' }, planReply: 'by-file-name' });
    try {
      const report = await r.publish();
      assert.equal(report.ok, true);
      assert.equal(report.listing.models[1].floorPlan, null, 'Type B shows a phone number');
      assert.ok(report.planCheck.leftOut.some((l) => l.model === 1) || report.planCheck.unchecked.includes(1), JSON.stringify(report.planCheck));
      const files = fs.readdirSync(path.join(r.repo, 'public', 'listings', report.slug));
      assert.ok(!files.includes('plan-02.jpg'), files.join(' '));
    } finally { r.cleanup(); }
  });

  it('r8 #1 (Codex r7 C#1): a reply numbered from 1 whatever the file names, that says nothing about the last plan, leaves the whole call unchecked — no plan goes up', async () => {
    // At ef8352d this reply ({1 clean}, {2 phone} for images 0..2) published plan-02.jpg, Type B's phone plan, as clean.
    const r = await rig({ listing: withPlans(3), candidateCount: 9, planCheck: { 'plan-02': 'phone' }, planReply: 'from-one' });
    try {
      const report = await r.publish();
      assert.equal(report.ok, true);
      assert.deepEqual(planCalls(r)[0].indexes, [0, 1, 2]);
      assert.deepEqual(report.listing.models.map((m) => m.floorPlan), [null, null, null]);
      assert.deepEqual([report.planCheck.clean, report.planCheck.leftOut, report.planCheck.unchecked], [0, [], [0, 1, 2]], JSON.stringify(report.planCheck));
      const files = fs.readdirSync(path.join(r.repo, 'public', 'listings', report.slug));
      assert.ok(!files.some((f) => /^plan-/.test(f)), files.join(' '));
      assert.ok(!report.warnings.some((w) => /shows/.test(w)), report.warnings.join(' | '));
    } finally { r.cleanup(); }
  });

  it('a quota (or a failed call) on publish: the listing goes up WITHOUT plans, "try again later"', async () => {
    for (const planCheck of ['quota', true]) {
      const r = await rig({ listing: withPlans(2), candidateCount: 8, planCheck });
      try {
        const report = await r.publish();
        assert.equal(report.ok, true);
        assert.deepEqual(report.listing.models.map((m) => m.floorPlan), [null, null]);
        const files = fs.readdirSync(path.join(r.repo, 'public', 'listings', report.slug));
        assert.ok(!files.some((f) => f.startsWith('plan-')), files.join(' '));
        assert.ok(report.warnings.includes(`2 floor plans not published (Type A, Type B: could not be checked (${planCheck === 'quota' ? 'the AI quota ran out' : 'the check failed'}), try again later with \`run-once --enrich ${report.id}\`)`), report.warnings.join(' | '));
        assert.match(msg.planCheckLine(report.planCheck), /2 not checked — try again later/);
        // r7 #9 (Claude r6 B7a): the reply never says "0 left out by the contact check" on the 🔎 line and then
        // "2 floor plans left out by the contact check" on the plan line: the plan line's head is neutral.
        const reply = msg.published(report);
        assert.match(reply, /^🔎 2 floor plans · 0 left out by the contact check · 2 not checked — try again later$/m, reply);
        assert.match(reply, /^⚠️ 2 floor plans not published \(Type A, Type B: could not be checked /m, reply);
        assert.equal(reply.match(/left out by the contact check/g).length, 1, reply);
      } finally { r.cleanup(); }
    }
  });

  it('r5 #11: a publish that goes up without plans because their check did not finish says so on the listing (`plans-unchecked`); a finished check does not', async () => {
    for (const planCheck of ['quota', true]) {
      const r = await rig({ listing: withPlans(2), candidateCount: 8, planCheck });
      try {
        const report = await r.publish();
        assert.ok(report.listing._intake.warnings.includes('plans-unchecked'), `${planCheck}: ${report.listing._intake.warnings}`);
        const saved = JSON.parse(fs.readFileSync(path.join(r.repo, 'scripts', 'curate', 'inbox', `${report.slug}.json`), 'utf8'));
        assert.ok(saved._intake.warnings.includes('plans-unchecked'), 'in the committed record');
      } finally { r.cleanup(); }
    }
    const d = await rig({ listing: withPlans(2), candidateCount: 8, planCheck: 'quota' });
    try {
      assert.ok((await d.run()).listingPreview._intake.warnings.includes('plans-unchecked'), 'a dry run previews it');
    } finally { d.cleanup(); }
    // Every plan checked — clean, or flagged and left out: nothing unchecked to say.
    for (const planCheck of [null, { 'plan-01': 'qr' }]) {
      const c = await rig({ listing: withPlans(2), candidateCount: 8, planCheck });
      try {
        const report = await c.publish();
        assert.ok(!report.listing._intake.warnings.includes('plans-unchecked'), JSON.stringify(planCheck));
      } finally { c.cleanup(); }
    }
  });

  it('a live publish never stages a flagged plan', async () => {
    const r = await rig({ listing: withPlans(2), candidateCount: 8, planCheck: { 'plan-01': 'qr' } });
    try {
      const report = await r.publish();
      const files = fs.readdirSync(path.join(r.repo, 'public', 'listings', report.slug)).filter((f) => f.startsWith('plan-'));
      assert.deepEqual(files.sort(), ['plan-02-thumb.webp', 'plan-02.jpg']);
      assert.deepEqual(report.listing.models.map((m) => m.floorPlan?.src ?? null), [null, `/listings/${report.slug}/plan-02.jpg`]);
    } finally { r.cleanup(); }
  });

  it('r5 #6: a plan the check could not prepare is left out before staging — never published unchecked', async () => {
    // Type A's plan cannot be read while the check prepares the plans, and reads fine when the publish stages them.
    const r = await rig({ listing: withPlans(2), candidateCount: 8, broken: [6], healOnPlanCheck: true });
    try {
      const report = await r.publish();
      assert.deepEqual(planCalls(r).map((c) => c.files), [['plan-02.jpg']], 'only the plan it could prepare was checked');
      assert.deepEqual(report.listing.models.map((m) => m.floorPlan?.src ?? null), [null, `/listings/${report.slug}/plan-02.jpg`]);
      const files = fs.readdirSync(path.join(r.repo, 'public', 'listings', report.slug)).filter((f) => f.startsWith('plan-'));
      assert.deepEqual(files.sort(), ['plan-02-thumb.webp', 'plan-02.jpg']);
      assert.ok(report.warnings.includes('1 floor plan not published (Type A: could not be prepared)'), report.warnings.join(' | '));
      assert.ok(report.warningCodes.includes('images-skipped'));
    } finally { r.cleanup(); }
  });

  it('r5 #6: a dry run never previews a plan the check could not prepare as publishable, and says it was left out', async () => {
    const d = await rig({ listing: withPlans(2), candidateCount: 8, broken: [6] });
    try {
      const report = await d.run();
      assert.deepEqual(plansOf(report).map(Boolean), [false, true]);
      assert.deepEqual(report.floorPlans.map((p) => p.model), [1]);
      assert.ok(report.warnings.includes('1 floor plan not published (Type A: could not be prepared)'), report.warnings.join(' | '));
    } finally { d.cleanup(); }
  });

  it('r5 #4: the plan check comes after every price check — its quota never costs a headline or a Sakani price', async () => {
    // A rental headline that needs its page check (r3 #4), then a plan check that hits the quota.
    const rent = withPlans(2);
    rent.listing.category = 'rent';
    rent.listing.price = { amount: 60000, currency: 'SAR', from: false, period: 'year', onRequest: false };
    rent.priceEvidence = { page: 3, quote: 'SAR 60,000' };
    const pageText = ['Overview', 'Location', 'Annual rent SAR 60,000', 'Specification', 'Contact'];
    const r = await rig({ listing: rent, candidateCount: 8, pageText, facts: { 3: [{ fig: 60000, mark: 'SAR', kind: 'whole', per: 'year' }] }, planCheck: 'quota' });
    try {
      const report = await r.run();
      assert.deepEqual(report.listingPreview.price, { amount: 60000, currency: 'SAR', from: false, period: 'year', onRequest: false });
      assert.deepEqual(plansOf(report), [null, null], 'the plans are left out, unchecked');
      assert.equal(report.planCheck.fatal, true);
    } finally { r.cleanup(); }
    // A Sakani price confirmed on its page, then a plan check that hits the quota.
    const sale = withPlans(2);
    sale.listing.price = { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false, subsidisedAmount: 270425 };
    sale.priceEvidence = { page: 3, quote: '319,015' };
    sale.subsidisedPriceEvidence = { page: 3, quote: '270,425' };
    const t = await rig({ listing: sale, candidateCount: 8, confirm: [319015, 270425], planCheck: 'quota' });
    try {
      const report = await t.run();
      assert.deepEqual(report.listingPreview.price, { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false, subsidisedAmount: 270425 });
      assert.deepEqual(plansOf(report), [null, null]);
    } finally { t.cleanup(); }
    // The price checks hit the quota first: no plan call at all, the plans are unchecked.
    const q = await rig({ listing: structuredClone(sale), candidateCount: 8, confirmFail: 'quota' });
    try {
      const report = await q.run();
      assert.equal(planCalls(q).length, 0);
      assert.deepEqual(report.planCheck.unchecked.sort(), [0, 1]);
    } finally { q.cleanup(); }
  });

  it('r5 #4: no plan call is spent on a publish the photo gate or the duplicate check refuses', async () => {
    const few = withPlans(2);
    for (const im of few.images.slice(0, 6)) { im.exclude = true; im.rank = null; im.hero = false; }
    const r = await rig({ listing: few, candidateCount: 8 });
    try {
      await assert.rejects(r.publish(), (err) => err.stage === 'images');
      assert.equal(planCalls(r).length, 0);
      const dry = await r.run();
      assert.ok(dry.blocked);
      assert.equal(planCalls(r).length, 0, 'a dry run that would not publish spends no plan call either');
    } finally { r.cleanup(); }
  });

  it('r6 #6: no plan call is spent on a publish the duplicate check refuses (enough photos, a twin in the inbox)', async () => {
    const r = await rig({ listing: withPlans(2), candidateCount: 8 });
    try {
      const sha = crypto.createHash('sha256').update(fs.readFileSync(r.pdfPath)).digest('hex');
      writeInboxListing(r.repo, { id: 'BONA-W001', slug: 'jeddah-heights-twin', title: { en: 'Twin', ar: 'توأم' }, _intake: { source: 'whatsapp', pdfSha256: sha } });
      await assert.rejects(r.publish(), (err) => err.stage === 'duplicate');
      assert.equal(planCalls(r).length, 0);
    } finally { r.cleanup(); }
  });

  it('r6 #6: no plan call is spent on a publish whose photo staging drops a corrupt photo below the minimum', async () => {
    // Exactly 4 picks (the minimum) pass the pick-count gate; one cannot be decoded when the photos are staged.
    const four = withPlans(2);
    for (const im of four.images.slice(4, 6)) { im.exclude = true; im.rank = null; im.hero = false; }
    const r = await rig({ listing: four, candidateCount: 8, broken: [2] });
    try {
      await assert.rejects(r.publish(), (err) => err.stage === 'validate' && err.message === 'not enough usable photos (3 of 4 needed)');
      assert.equal(planCalls(r).length, 0);
      assert.deepEqual(fs.readdirSync(path.join(path.dirname(r.pdfPath), 'work', 'publish')), [], 'the stage dir is removed');
      assert.equal(fs.existsSync(path.join(r.repo, 'public', 'listings')), false);
    } finally { r.cleanup(); }
  });

  it('r6 #6: a blocked dry run that skipped the plan check never previews a plan, and says they were not checked', async () => {
    const few = withPlans(2);
    for (const im of few.images.slice(0, 6)) { im.exclude = true; im.rank = null; im.hero = false; }
    const r = await rig({ listing: few, candidateCount: 8, planCheck: { 'plan-01': 'phone' } });
    try {
      const dry = await r.run();
      assert.ok(dry.blocked);
      assert.equal(planCalls(r).length, 0);
      assert.deepEqual(plansOf(dry), [null, null]);
      assert.deepEqual(dry.floorPlans, []);
      assert.ok(dry.warnings.some((w) => /2 floor plan\(s\)/.test(w) && /not checked/.test(w)), dry.warnings.join(' | '));
    } finally { r.cleanup(); }
  });

  it('r5 #10: the WhatsApp reply keeps the price warnings in its first 3 lines, then ONE line for every plan left out', async () => {
    // Two price warnings compete for the reply's 3 warning lines: two unit-model prices not confirmed on their page,
    // and a Sakani price not confirmed beside a confirmed headline. Then the contact check flags two plans.
    const sale = withPlans(3);
    sale.listing.price = { ...PRICE };
    sale.priceEvidence = { page: 3, quote: '319,015' };
    sale.subsidisedPriceEvidence = { page: 3, quote: '270,425' };
    Object.assign(sale.models[0], { price: 400000, evidence: { page: 3, quote: '400000' } });
    Object.assign(sale.models[1], { price: 450000, evidence: { page: 3, quote: '450000' } });
    const warningsOf = (reply) => reply.split('\n').filter((l) => l.startsWith('⚠️ '));
    const expectReply = (reply, planLine) => {
      const shown = warningsOf(reply);
      assert.equal(shown.length, 3, reply);
      assert.match(shown[0], /2 unit-model price\(s\) could not be confirmed/, reply);
      assert.match(shown[1], /subsidised \(Sakani\) price could not be confirmed/, reply);
      assert.equal(shown[2], `⚠️ ${planLine}`, reply);
      assert.equal(shown.filter((l) => /floor plan/.test(l)).length, 1, reply);
    };
    const r = await rig({ listing: sale, candidateCount: 9, modelConfirm: [], confirm: [319015], planCheck: { 'plan-01': 'phone', 'plan-03': 'phone' } });
    try {
      const dry = await r.run();
      assert.deepEqual(plansOf(dry).map(Boolean), [false, true, false]);
      expectReply(msg.dryRunSummary(dry), '2 floor plans not published (Type A, Type C: shows a phone number)');
      const live = await r.publish();
      assert.deepEqual(live.listing.models.map((m) => Boolean(m.floorPlan)), [false, true, false]);
      expectReply(msg.published(live), '2 floor plans not published (Type A, Type C: shows a phone number)');
    } finally { r.cleanup(); }
    // Different reasons: grouped by reason, still one line — a plan with no clear answer is never said to show anything.
    const d = await rig({ listing: structuredClone(sale), candidateCount: 9, modelConfirm: [], confirm: [319015], planCheck: { 'plan-02': 'logo', 'plan-03': 'phone' }, planReply: 'duplicate' });
    try {
      const dry = await d.run();
      assert.deepEqual(plansOf(dry).map(Boolean), [false, false, false]);
      expectReply(msg.dryRunSummary(dry),
        '3 floor plans not published (Type A: no clear answer from the check; Type B: shows a logo or brand name; Type C: shows a phone number)');
    } finally { d.cleanup(); }
  });

  it('r6 #8: the FINAL reply to a reading with model warnings: the price warnings first, ONE plan line naming every model, then the rest', async () => {
    // Like the real W023 reading (10 model warnings), with two price warnings, a money-text drop (a club fee in the
    // amenities), a map link no second link agrees with (Codex r5 #9), and a plan reply that says nothing about Type A
    // and flags Type C. Since r8 #1 (Codex r7 C#1) a reply that leaves out an image asked leaves the WHOLE call
    // unchecked, so the one plan line names all three as not checked (it was Type A not checked, Type C flagged).
    const sale = withPlans(3);
    sale.warnings = Array.from({ length: 10 }, (_, k) => `check item ${k + 1} by hand`);
    sale.listing.price = { ...PRICE };
    sale.priceEvidence = { page: 3, quote: '319,015' };
    sale.subsidisedPriceEvidence = { page: 3, quote: '270,425' };
    Object.assign(sale.models[0], { price: 400000, evidence: { page: 3, quote: '400000' } });
    Object.assign(sale.models[1], { price: 450000, evidence: { page: 3, quote: '450000' } });
    sale.amenities = { en: ['Gym', 'Club fee SAR 2000'], ar: ['نادٍ رياضي', 'رسوم النادي 2000 ريال'] };
    const warningsOf = (reply) => reply.split('\n').filter((l) => l.startsWith('⚠️ '));
    const expectReply = (report, reply, hint) => {
      const shown = warningsOf(reply);
      assert.equal(shown.length, 3, reply);
      assert.match(shown[0], /2 unit-model price\(s\) could not be confirmed/, reply);
      assert.match(shown[1], /subsidised \(Sakani\) price could not be confirmed/, reply);
      assert.equal(shown[2], '⚠️ 3 floor plans not published (Type A, Type B, Type C: could not be checked (the check failed), try again later'
        + `${hint})`, reply);
      assert.doesNotMatch(reply, /<id>/, reply);
      assert.equal(report.warnings.filter((w) => /floor plan/.test(w)).length, 1, `ONE plan line: ${report.warnings.join(' | ')}`);
      assert.match(reply, /^🔎 3 floor plans · 0 left out by the contact check · 3 not checked — try again later$/m, reply);
      // r7 #9 (Claude r6 B7a): only the 🔎 line counts the plans the contact check left out; the plan line's head is
      // neutral, so the reply never gives two counts for the same words.
      assert.equal(reply.match(/left out by the contact check/g).length, 1, reply);
      // The rest keep their order after it: the model's flags, the money-text drop, the map.
      const order = msg.orderedWarnings(report);
      const at = (re) => order.findIndex((w) => re.test(w));
      assert.ok(at(/floor plan/) === 2 && at(/the model flagged 10 thing/) === 3 && at(/stated a price or a payment/) === 4
        && at(/map link but no two links agreed/) === 5, order.join(' | '));
    };
    const links = [{ page: 2, uri: 'https://www.google.com/maps/@21.5433,39.1728,15z' }];
    const r = await rig({ listing: sale, candidateCount: 9, modelConfirm: [], confirm: [319015], planCheck: { 'plan-03': 'phone' }, planReply: 'missing', links });
    try {
      const dry = await r.run();
      assert.deepEqual(plansOf(dry).map(Boolean), [false, false, false]);
      // A dry run publishes nothing: there is no listing to enrich yet, so no --enrich hint.
      expectReply(dry, msg.dryRunSummary(dry), '');
      const live = await r.publish();
      assert.equal(live.id, 'BONA-W001');
      assert.deepEqual(live.listing.models.map((m) => Boolean(m.floorPlan)), [false, false, false]);
      for (const code of ['plans-unchecked', 'model-flagged', 'map-unconfirmed']) assert.ok(live.warningCodes.includes(code), live.warningCodes.join(' '));
      // The real listing id in the hint (Claude r5 NB8), never `<id>`.
      expectReply(live, msg.published(live), ' with `run-once --enrich BONA-W001`');
    } finally { r.cleanup(); }
    // A plan the check could not prepare is in the same line, by name (Claude r5 B9 scenario 2): never a nameless
    // line of its own ahead of it.
    const p = await rig({ listing: structuredClone(sale), candidateCount: 9, modelConfirm: [], confirm: [319015], planCheck: { 'plan-03': 'phone' }, broken: [6] });
    try {
      const dry = await p.run();
      assert.deepEqual(plansOf(dry).map(Boolean), [false, true, false]);
      const shown = warningsOf(msg.dryRunSummary(dry));
      assert.equal(shown[2], '⚠️ 2 floor plans not published (Type A: could not be prepared; Type C: shows a phone number)', shown.join('\n'));
      assert.equal(dry.warnings.filter((w) => /floor plan/.test(w)).length, 1, dry.warnings.join(' | '));
      assert.ok(dry.warningCodes.includes('images-skipped'), 'the code stays');
      assert.match(msg.dryRunSummary(dry), /^🔎 2 floor plans · 1 left out by the contact check$/m);
    } finally { p.cleanup(); }
    // The headline price not printed (r7 #9, Claude r6 B8): ranked with the price warnings, so it leads the reply,
    // ahead of the plan line and the model's flags — never pushed out of the 3 lines the reply shows. The models carry
    // no price here (a confirmed model price would become the headline), and the page refuses the headline.
    const headline = structuredClone(sale);
    for (const m of headline.models) Object.assign(m, { price: null, evidence: null });
    const h = await rig({ listing: headline, candidateCount: 9, confirm: [], planCheck: { 'plan-03': 'phone' } });
    try {
      const dry = await h.run();
      assert.equal(dry.listingPreview.price.onRequest, true);
      assert.ok(dry.warningCodes.includes('price-not-printed'), dry.warningCodes.join(' '));
      const shown = warningsOf(msg.dryRunSummary(dry));
      assert.equal(shown.length, 3, shown.join('\n'));
      assert.match(shown[0], /^⚠️ the price was not printed in the brochure.*"price on request"/, shown.join('\n'));
      assert.equal(shown[1], '⚠️ 1 floor plan not published (Type C: shows a phone number)', shown.join('\n'));
      assert.match(shown[2], /the model flagged 10 thing/, shown.join('\n'));
    } finally { h.cleanup(); }
  });

  it('r9 #5 (Claude r8 NB14): 13 plans, the first call flags Type C and the second fails — ONE plan line names both reasons, and the 🔎 line counts both', async () => {
    // r8 #1 turned the r6 #8 reply into an all-unchecked one, so no test kept a plan line that mixes a flagged plan and
    // a plan not checked. 13 plans take two calls (PLAN_CHECK_BATCH 12), each judged on its own: plans 1-12 come back
    // with Type C flagged, and the call for Type M fails. The plan line must still name Type M with its --enrich hint
    // beside Type C (not only when no plan was flagged), and the 🔎 line must still count it as not checked.
    const r = await rig({ listing: withPlans(13), candidateCount: 19, planCheck: { 'plan-03': 'phone' }, planReply: 'second-fails' });
    const expectReply = (report, reply, hint) => {
      assert.deepEqual([report.planCheck.plans, report.planCheck.clean, report.planCheck.leftOut, report.planCheck.unchecked, report.planCheck.fatal],
        [13, 11, [{ model: 2, found: ['phone'] }], [12], false], JSON.stringify(report.planCheck));
      const line = `2 floor plans not published (Type C: shows a phone number; Type M: could not be checked (the check failed), try again later${hint})`;
      assert.deepEqual(report.warnings.filter((w) => /floor plan/.test(w)), [line], report.warnings.join(' | '));
      assert.equal(msg.planCheckLine(report.planCheck), '13 floor plans · 1 left out by the contact check · 1 not checked — try again later');
      assert.ok(reply.split('\n').includes(`⚠️ ${line}`), reply);
      assert.match(reply, /^🔎 13 floor plans · 1 left out by the contact check · 1 not checked — try again later$/m, reply);
      assert.equal(reply.match(/left out by the contact check/g).length, 1, reply);
    };
    try {
      const dry = await r.run();
      assert.equal(planCalls(r).length, 2);
      assert.deepEqual(plansOf(dry).map(Boolean), Array.from({ length: 13 }, (_, k) => k !== 2 && k !== 12));
      // A dry run publishes nothing: no --enrich hint.
      expectReply(dry, msg.dryRunSummary(dry), '');
      const live = await r.publish();
      assert.equal(live.id, 'BONA-W001');
      assert.deepEqual(live.listing.models.map((m) => Boolean(m.floorPlan)), Array.from({ length: 13 }, (_, k) => k !== 2 && k !== 12));
      assert.ok(live.warningCodes.includes('plans-unchecked'), live.warningCodes.join(' '));
      expectReply(live, msg.published(live), ' with `run-once --enrich BONA-W001`');
    } finally { r.cleanup(); }
  });

  it('no plans: no call', async () => {
    const a = withPlans(2);
    for (const m of a.models) m.floorPlan = null;
    const r = await rig({ listing: a, candidateCount: 8 });
    try {
      const report = await r.run();
      assert.equal(planCalls(r).length, 0);
      assert.equal(report.planCheck ?? null, null);
    } finally { r.cleanup(); }
  });
});

describe('processPdf --enrich: unit models + brochure on a published listing, nothing else touched', { timeout: 120000 }, () => {
  const SLUG = 'jeddah-heights-residential-community-jeddah';
  const ON_REQUEST = { amount: null, currency: 'SAR', from: false, period: null, onRequest: true };
  const PRICED = { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false, subsidisedAmount: 270425 };
  const git = (r, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: r.repo, stdio: 'pipe' }).toString();
  const inboxFile = (r) => path.join(r.repo, 'scripts', 'curate', 'inbox', `${SLUG}.json`);
  const pubDir = (r) => path.join(r.repo, 'public', 'listings', SLUG);
  const META = { enrich: { id: 'BONA-W023', slug: SLUG } };
  const ENRICHED = ['models', 'amenities', 'nearby', 'warranties', 'brochureUrl'];
  const PHOTOS = [1, 2, 3, 4].flatMap((n) => [`0${n}.jpg`, `0${n}-thumb.webp`]);
  /** Two models priced on page 3 (Lulu is the cheaper), Nawras's floor plan = candidate 5 — the brochure as read today. */
  const reading = () => {
    const a = {
      ...answer({ price: { amount: 999999, currency: 'SAR', from: false, period: null, onRequest: false } }),
      models: [
        { name: { en: 'Nawras', ar: 'نموذج نورس' }, bedrooms: 3, bathrooms: 2, areaSqm: 105, rooms: null, availability: null, price: 419994, subsidisedPrice: 356024, evidence: { page: 3, quote: '419994' }, floorPlan: 5 },
        { name: { en: 'Lulu', ar: 'نموذج لؤلؤ' }, bedrooms: 2, bathrooms: 2, areaSqm: 88, rooms: null, availability: null, price: 319015, subsidisedPrice: 270425, evidence: { page: 3, quote: '319015' }, floorPlan: null },
      ],
      amenities: { en: ['Health club'], ar: ['نادٍ صحي'] },
      nearby: { en: [], ar: [] },
      warranties: { en: ['Structure — 10 years'], ar: ['الهيكل الإنشائي — 10 سنوات'] },
    };
    a.listing.title = { en: 'A brand new title the model wrote', ar: 'عنوان جديد' };
    a.images[5] = { ...a.images[5], rank: null, hero: false, exclude: true, reason: 'floor plan', focus: null };
    return a;
  };
  /**
   * The listing as published by the first run and then corrected by hand: its own title, district,
   * photos, licence, video, photo note, FAQ, SEO title, featured flag — and an old floor plan file
   * and brochure that the new run must replace. Committed, like the publishing clone holds it.
   */
  const seed = (r, { price = PRICED, sha = null, intake = {}, unit = null, location = null, extra = {} } = {}) => {
    const pdfSha256 = sha ?? crypto.createHash('sha256').update(fs.readFileSync(r.pdfPath)).digest('hex');
    const img = (n) => ({ src: `/listings/${SLUG}/0${n}.jpg`, thumb: `/listings/${SLUG}/0${n}-thumb.webp`, alt: { en: `Photo ${n}`, ar: `صورة ${n}` } });
    const listing = {
      id: 'BONA-W023', slug: SLUG, sourceRef: 'WA-20261101-AC7D06', status: 'reserved', category: 'off-plan', type: 'apartment', kind: 'apartment',
      featured: true, title: { en: 'Jeddah Heights — corrected by hand', ar: 'جدة هايتس — تصحيح يدوي' },
      location: location ?? { ...PLACE, district: { en: 'Al Rehab', ar: 'الرحاب' } }, price,
      specs: { beds: 2, baths: 2, areaSqm: 88, plotSqm: null, yearBuilt: null, floors: null },
      images: [1, 2, 3, 4].map(img), videos: [{ src: `/listings/${SLUG}/v-01.mp4`, poster: null }],
      description: { en: 'Hand-written one.\n\nHand-written two.', ar: 'فقرة أولى.\n\nفقرة ثانية.' },
      highlights: { en: ['A', 'B', 'C', 'D'], ar: ['أ', 'ب', 'ج', 'د'] }, virtualTourUrl: null,
      brochureUrl: `https://bona-real-estate.com/listings/${SLUG}/brochure.pdf`,
      project: { name: { en: 'Jeddah Heights', ar: 'جدة هايتس' }, developer: { en: 'NHC', ar: 'الوطنية للإسكان' } }, unit,
      map: null, mapPrecision: null, listedAt: '2026-11-01', hidden: false,
      licence: { adNumber: '7200123', adExpiry: null, wafiNumber: null, escrowAccount: null },
      photoNote: { en: 'Photos show the sister project', ar: 'الصور للمشروع الشقيق' },
      faq: [{ q: { en: 'Q1', ar: 'س١' }, a: { en: 'A1', ar: 'ج١' } }], seoTitle: { en: 'SEO', ar: 'عنوان' },
      _intake: { source: 'whatsapp', pdfSha256, model: 'opus', confidence: 0.8, warnings: ['map-unconfirmed'], images: [], createdAt: '2026-11-01T10:00:00.000Z', site: 'https://bona-real-estate.com', ...intake },
      ...extra,
    };
    fs.mkdirSync(path.dirname(inboxFile(r)), { recursive: true });
    fs.writeFileSync(inboxFile(r), `${JSON.stringify(listing, null, 2)}\n`);
    fs.writeFileSync(path.join(r.repo, 'scripts', 'curate', 'inbox', '_index.json'), `${JSON.stringify({ nextSeq: 30, listings: { [SLUG]: 'BONA-W023' } }, null, 2)}\n`);
    fs.mkdirSync(pubDir(r), { recursive: true });
    for (const f of [...PHOTOS, 'v-01.mp4']) fs.writeFileSync(path.join(pubDir(r), f), `first run ${f}`);
    for (const f of ['plan-03.jpg', 'plan-03-thumb.webp']) fs.writeFileSync(path.join(pubDir(r), f), 'old plan');
    fs.writeFileSync(path.join(pubDir(r), 'brochure.pdf'), 'old brochure');
    git(r, 'init', '-q'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'intake: Jeddah Heights (BONA-W023)');
    // Corrected by hand afterwards — exactly what --replace refuses to undo.
    for (const f of [...PHOTOS, 'v-01.mp4']) fs.writeFileSync(path.join(pubDir(r), f), `hand-made ${f}`);
    git(r, 'commit', '-qam', 'photos re-cropped by hand');
    return listing;
  };
  const without = (l, keys) => Object.fromEntries(Object.entries(l).filter(([k]) => !keys.includes(k)));
  const saved = (r) => JSON.parse(fs.readFileSync(inboxFile(r), 'utf8'));
  const enrich = (r, { dryRun = false, caption = {}, force = false } = {}) => processPdf({
    pdfPath: r.pdfPath, cfg: r.cfg, caption, workDir: path.join(r.repo, '..', 'work'), dryRun, meta: { enrich: { ...META.enrich, ...(force ? { force } : {}) } },
  });

  it('(a) adds the models, plan and brochure to a hand-corrected listing; its photos, copy and every other key stay byte for byte', async () => {
    const r = await rig({ listing: reading() });
    try {
      const before = seed(r);
      const rawBefore = fs.readFileSync(inboxFile(r), 'utf8');
      const report = await enrich(r);
      assert.equal(report.ok, true);
      assert.equal(report.id, 'BONA-W023');
      assert.equal(report.enrich.headline, 'kept');
      // Photos, video: the same bytes.
      for (const f of [...PHOTOS, 'v-01.mp4']) assert.equal(fs.readFileSync(path.join(pubDir(r), f), 'utf8'), `hand-made ${f}`, f);
      // The old plan is gone, the new one is a real JPEG + WebP; the brochure is the new one.
      const files = fs.readdirSync(pubDir(r)).sort();
      assert.deepEqual(files.filter((f) => f.startsWith('plan-')), ['plan-01-thumb.webp', 'plan-01.jpg']);
      const sharp = (await import('sharp')).default;
      assert.equal((await sharp(path.join(pubDir(r), 'plan-01.jpg')).metadata()).format, 'jpeg');
      assert.equal(fs.readFileSync(path.join(pubDir(r), 'brochure.pdf'), 'utf8'), '%PDF-1.7 fake brochure\n');
      assert.ok(!files.some((f) => f.includes('.tmp')), files.join(' '));
      // The brochure was drawn from the MERGED listing, out of the repo's own folder.
      const call = r.calls().find((c) => c.tool === 'brochure');
      assert.equal(call.filesDir, pubDir(r));
      assert.equal(call.listing.title.en, 'Jeddah Heights — corrected by hand');
      assert.ok(call.files.includes('plan-01.jpg') && !call.files.includes('plan-03.jpg'), call.files.join(' '));
      assert.equal(call.listing.models.length, 2);
      // The inbox JSON: models, fact lists, brochureUrl — and nothing else.
      const after = saved(r);
      assert.deepEqual(after.models.map((m) => [m.name.en, m.price, m.subsidisedPrice, m.floorPlan?.src ?? null]),
        [['Nawras', 419994, 356024, `/listings/${SLUG}/plan-01.jpg`], ['Lulu', 319015, 270425, null]]);
      assert.deepEqual(after.amenities, { en: ['Health club'], ar: ['نادٍ صحي'] });
      assert.equal('nearby' in after, false);
      assert.equal(after.brochureUrl, `https://bona-real-estate.com/listings/${SLUG}/brochure.pdf`);
      assert.equal(JSON.stringify(without(after, ENRICHED), null, 2), JSON.stringify(without(before, ENRICHED), null, 2), 'every other key, in order, unchanged');
      const lines = (s) => new Set(s.split('\n'));
      const kept = [...lines(rawBefore)].filter((l) => !lines(fs.readFileSync(inboxFile(r), 'utf8')).has(l));
      assert.deepEqual(kept, [], 'every line of the old file is still in the new one');
      assert.deepEqual(checkListing(after), []);
      // Commit-ready: only the intake's own paths changed, the index untouched.
      const status = git(r, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).map((l) => l.slice(3));
      assert.ok(status.length > 0);
      for (const p of status) assert.match(p, new RegExp(`^(public/listings/${SLUG}/|scripts/curate/inbox/${SLUG}\\.json$)`), p);
      // No headline check and no photo-region call: the copy and photos are not published. The new plan is
      // checked for contact details (r4) before it reaches the repo.
      assert.deepEqual(r.calls().filter((c) => c.tool.startsWith('claude')).map((c) => c.tool), ['claude-listing', 'claude-model-confirm', 'claude-plan-check']);
    } finally { r.cleanup(); }
  });

  it('(b) a price that is not the models\' lowest is refused with both figures, and nothing is changed', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r, { price: { amount: 350000, currency: 'SAR', from: false, period: null, onRequest: false } });
      await assert.rejects(enrich(r), (err) => err.stage === 'enrich'
        && /BONA-W023 shows SAR 350,000 but the brochure's lowest model price is SAR 319,015/.test(err.reason)
        && /send `price BONA-W023 …` or re-run with --replace/.test(err.reason));
      assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '');
      assert.equal(fs.readFileSync(path.join(pubDir(r), 'plan-03.jpg'), 'utf8'), 'old plan');
      assert.equal(r.calls().filter((c) => c.tool === 'brochure').length, 0);
    } finally { r.cleanup(); }
  });

  it('(c) a listing on request adopts the models\' confirmed headline', async () => {
    const r = await rig({ listing: reading() });
    try {
      const before = seed(r, { price: { ...ON_REQUEST } });
      const report = await enrich(r);
      assert.equal(report.enrich.headline, 'adopted');
      const after = saved(r);
      assert.deepEqual(after.price, PRICED);
      assert.equal(JSON.stringify(without(after, [...ENRICHED, 'price'])), JSON.stringify(without(before, [...ENRICHED, 'price'])));
      assert.deepEqual(checkListing(after), []);
    } finally { r.cleanup(); }
  });

  it('(c2) r7 #6 (Claude r5 NB2 / r6 B2c): a listing for sale on request never adopts rents printed per model — the model check is asked as a sale', async () => {
    // The page prints every model figure as a rent: a second model told the listing is for sale refuses them all.
    const r = await rig({ listing: reading(), rents: [419994, 356024, 319015, 270425] });
    try {
      seed(r, { price: { ...ON_REQUEST } });
      const report = await enrich(r);
      assert.deepEqual(r.calls().filter((c) => c.tool === 'claude-model-confirm').map((c) => [c.page, c.period, c.sale]), [[3, null, true]], 'one call, as before');
      assert.notEqual(report.enrich.headline, 'adopted');
      assert.deepEqual(saved(r).price, ON_REQUEST);
      assert.deepEqual(saved(r).models.map((m) => [m.price ?? null, m.subsidisedPrice ?? null]), [[null, null], [null, null]]);
    } finally { r.cleanup(); }
  });

  it('(d) the owner\'s own price stays; the models are published without prices and never checked', async () => {
    const r = await rig({ listing: reading() });
    try {
      const own = { amount: 300000, currency: 'SAR', from: false, period: null, onRequest: false };
      seed(r, { price: own, intake: { edits: ['price'] } });
      const report = await enrich(r);
      assert.equal(report.enrich.headline, 'owner-price');
      const after = saved(r);
      assert.deepEqual(after.price, own);
      assert.deepEqual(after.models.map((m) => [m.price, m.subsidisedPrice]), [[null, null], [null, null]]);
      assert.equal(r.calls().filter((c) => c.tool === 'claude-model-confirm').length, 0, 'no figure is checked that will not be published');
      assert.deepEqual(after._intake.edits, ['price']);
      assert.deepEqual(checkListing(after), []);
    } finally { r.cleanup(); }
  });

  it('(e) a PDF that is not the one the listing was published from is refused before anything is read', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r, { sha: 'b'.repeat(64) });
      await assert.rejects(enrich(r), /this PDF is not the one BONA-W023 was published from/);
      assert.equal(fs.existsSync(path.join(r.repo, '..', 'bin', 'calls.jsonl')), false, 'no extraction, no model call');
      assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '');
    } finally { r.cleanup(); }
  });

  it('(f) a failed rebuild rolls everything back: the old plan and brochure return, the new plan goes', async () => {
    const r = await rig({ listing: reading(), build: 'process.exit(1);\n' });
    try {
      seed(r);
      const raw = fs.readFileSync(inboxFile(r), 'utf8');
      await assert.rejects(enrich(r), (err) => err.rolledBack === true);
      assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '', 'the clone is back to the commit');
      assert.equal(fs.readFileSync(path.join(pubDir(r), 'plan-03.jpg'), 'utf8'), 'old plan');
      assert.equal(fs.readFileSync(path.join(pubDir(r), 'brochure.pdf'), 'utf8'), 'old brochure');
      assert.equal(fs.existsSync(path.join(pubDir(r), 'plan-01.jpg')), false);
      assert.equal(fs.readFileSync(inboxFile(r), 'utf8'), raw);
    } finally { r.cleanup(); }
  });

  it('r2 #8 (Codex r1 #8): a brochure that cannot be built over an existing one commits nothing — the old PDF would contradict the new data', async () => {
    const swapped = [
      { name: { en: 'Nawras', ar: 'نموذج نورس' }, bedrooms: 3, bathrooms: 2, areaSqm: 105, rooms: null, availability: null, price: 319015, subsidisedPrice: 270425, floorPlan: null },
      { name: { en: 'Lulu', ar: 'نموذج لؤلؤ' }, bedrooms: 2, bathrooms: 2, areaSqm: 88, rooms: null, availability: null, price: 419994, subsidisedPrice: 356024, floorPlan: null },
    ];
    // PRICED: the models gain prices; ON_REQUEST: the headline is adopted; `swapped`: the same amounts, A's and B's
    // exchanged (the sorted amounts and the headline do not change); no price at all: the models and plans still do.
    for (const [price, extra, modelConfirm] of [[PRICED, {}, null], [ON_REQUEST, {}, null], [PRICED, { models: swapped }, null], [PRICED, {}, []]]) {
      const r = await rig({ listing: reading(), brochureFail: true, modelConfirm });
      try {
        seed(r, { price, extra });
        const raw = fs.readFileSync(inboxFile(r), 'utf8');
        await assert.rejects(enrich(r, { force: true }), (err) => err.rolledBack === true
          && /brochure could not be rebuilt/.test(err.message) && /old brochure/.test(err.message) && /nothing was changed/.test(err.message));
        assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '');
        assert.equal(fs.readFileSync(inboxFile(r), 'utf8'), raw);
        assert.equal(fs.readFileSync(path.join(pubDir(r), 'brochure.pdf'), 'utf8'), 'old brochure');
      } finally { r.cleanup(); }
    }
  });

  it('r2 #8: a brochure that cannot be built on a listing that has none: the enrichment goes up without one, and says so', async () => {
    const r = await rig({ listing: reading(), brochureFail: true });
    try {
      seed(r, { extra: { brochureUrl: null } });
      fs.rmSync(path.join(pubDir(r), 'brochure.pdf'));
      git(r, 'add', '-A'); git(r, 'commit', '-qm', 'no brochure');
      const report = await enrich(r);
      assert.equal(report.brochure.ok, false);
      assert.ok(report.warnings.some((w) => /brochure could not be built/.test(w)), report.warnings.join(' | '));
      const after = saved(r);
      assert.deepEqual(after.models.map((m) => m.price), [419994, 319015]);
      assert.equal(after.brochureUrl, null);
      assert.deepEqual(after._intake.warnings, ['map-unconfirmed', 'brochure-failed']);
      assert.equal(fs.existsSync(path.join(pubDir(r), 'brochure.pdf')), false);
      assert.equal(report.enrich.hadBrochure, false);
      assert.match(msg.enrichBrochureLine(report), /no brochure/, 'the CLI says it has none (r3 #11)');
    } finally { r.cleanup(); }
  });

  it('a dry run says what would change and writes nothing', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r, { price: { ...ON_REQUEST } });
      const report = await enrich(r, { dryRun: true });
      assert.equal(report.dryRun, true);
      assert.equal(report.enrich.models, 2);
      assert.equal(report.enrich.headline, 'adopted');
      assert.deepEqual(report.enrich.price, PRICED);
      assert.deepEqual(report.enrich.plans, [`/listings/${SLUG}/plan-01.jpg`]);
      assert.deepEqual(report.enrich.removedPlans, ['plan-03-thumb.webp', 'plan-03.jpg']);
      assert.deepEqual(report.listingPreview.price, PRICED);
      assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '');
      assert.equal(r.calls().filter((c) => c.tool === 'brochure').length, 0);
    } finally { r.cleanup(); }
  });

  it('a dry run of a refused headline shows the refusal instead of throwing', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r, { price: { amount: 350000, currency: 'SAR', from: false, period: null, onRequest: false } });
      const report = await enrich(r, { dryRun: true });
      assert.equal(report.enrich.headline, 'refused');
      assert.match(report.blocked, /shows SAR 350,000/);
    } finally { r.cleanup(); }
  });

  it('a listing with local edits is refused before the model is paid', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r);
      fs.writeFileSync(path.join(pubDir(r), '01.jpg'), 'edited, not committed');
      await assert.rejects(enrich(r), /uncommitted changes \(or is not in git\)/);
      assert.equal(fs.existsSync(path.join(r.repo, '..', 'bin', 'calls.jsonl')), false);
    } finally { r.cleanup(); }
  });

  it('r2 #6: a listing folder that is a committed symlink is refused before any file is touched — a dry run too', async () => {
    for (const dryRun of [false, true]) {
      const r = await rig({ listing: reading() });
      try {
        seed(r);
        // The folder moved out of the repo and a symlink committed in its place.
        const outside = path.join(r.repo, '..', 'outside-folder');
        fs.renameSync(pubDir(r), outside);
        fs.symlinkSync(outside, pubDir(r));
        git(r, 'add', '-A'); git(r, 'commit', '-qm', 'folder moved by hand');
        const before = fs.readdirSync(outside).sort();
        const err = await enrich(r, { dryRun }).then(() => null, (e) => e);
        assert.deepEqual(fs.readdirSync(outside).sort(), before, `dryRun ${dryRun}: nothing outside the repo is deleted or written`);
        assert.equal(fs.readFileSync(path.join(outside, 'brochure.pdf'), 'utf8'), 'old brochure');
        assert.match(String(err?.message), /symbolic link/);
        assert.equal(fs.existsSync(path.join(r.repo, '..', 'bin', 'calls.jsonl')), false, 'refused before the model is paid');
      } finally { r.cleanup(); }
    }
  });

  it('r3 #9: an inbox record that is a committed symlink is refused before anything is written — --enrich and --replace', async () => {
    for (const meta of [{ enrich: { id: 'BONA-W023', slug: SLUG } }, { replace: true, id: 'BONA-W023', slug: SLUG }]) {
      for (const dryRun of [false, true]) {
        const r = await rig({ listing: reading() });
        try {
          seed(r);
          const outside = path.join(r.repo, '..', 'outside-record.json');
          fs.renameSync(inboxFile(r), outside);
          fs.symlinkSync(outside, inboxFile(r));
          git(r, 'add', '-A'); git(r, 'commit', '-qm', 'record moved by hand');
          const before = fs.readFileSync(outside, 'utf8');
          const err = await processPdf({ pdfPath: r.pdfPath, cfg: r.cfg, caption: {}, workDir: path.join(r.repo, '..', 'work'), dryRun, meta }).then(() => null, (e) => e);
          assert.equal(fs.readFileSync(outside, 'utf8'), before, `${Object.keys(meta)[0]} dryRun ${dryRun}`);
          assert.match(String(err?.message), /symbolic link/, `${Object.keys(meta)[0]} dryRun ${dryRun}`);
        } finally { r.cleanup(); }
      }
    }
  });

  it('r2 #6: a symlink at the brochure\'s temp name is not written through', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r);
      const target = path.join(r.repo, '..', 'elsewhere.pdf');
      fs.writeFileSync(target, 'not the brochure');
      fs.symlinkSync(target, path.join(pubDir(r), '.brochure.pdf.tmp'));
      git(r, 'add', '-A'); git(r, 'commit', '-qm', 'a stray link');
      await enrich(r);
      assert.equal(fs.readFileSync(target, 'utf8'), 'not the brochure');
      assert.equal(fs.lstatSync(path.join(pubDir(r), 'brochure.pdf')).isSymbolicLink(), false);
      assert.equal(fs.readFileSync(path.join(pubDir(r), 'brochure.pdf'), 'utf8'), '%PDF-1.7 fake brochure\n');
    } finally { r.cleanup(); }
  });

  it('r2 #6: --replace checks the slug and the listing folder too, before anything is read or written', async () => {
    for (const [setup, re] of [
      [(r) => { const l = JSON.parse(fs.readFileSync(inboxFile(r), 'utf8')); fs.writeFileSync(inboxFile(r), `${JSON.stringify({ ...l, slug: '../../outside' }, null, 2)}\n`); return '../../outside'; }, /not a valid slug/],
      [(r) => { const out = path.join(r.repo, '..', 'outside-folder'); fs.renameSync(pubDir(r), out); fs.symlinkSync(out, pubDir(r)); return SLUG; }, /symbolic link/],
    ]) {
      const r = await rig({ listing: reading() });
      try {
        seed(r);
        const slug = setup(r);
        const err = await processPdf({ pdfPath: r.pdfPath, cfg: r.cfg, caption: {}, workDir: path.join(r.repo, '..', 'work'), dryRun: true, meta: { replace: true, id: 'BONA-W023', slug } })
          .then(() => null, (e) => e);
        assert.match(String(err?.message), re);
        assert.equal(fs.existsSync(path.join(r.repo, '..', 'bin', 'calls.jsonl')), false);
      } finally { r.cleanup(); }
    }
    assert.throws(() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-replace-slug-'));
      try {
        const f = writeInboxListing(dir, { id: 'BONA-W050', slug: 'x', title: { en: 'X', ar: 'س' }, _intake: {} });
        fs.writeFileSync(f, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), slug: 'a/b' }, null, 2)}\n`);
        replaceMetaFor(dir, 'BONA-W050');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }, /not a valid slug/);
  });

  it('Codex r1 #6a: an inbox record whose slug is not a slug is refused before any file is touched — a dry run too', async () => {
    for (const dryRun of [true, false]) {
      const r = await rig({ listing: reading() });
      try {
        const bad = '../../outside';
        seed(r, { extra: { slug: bad } });
        // What a recursive delete of the work dir's enrich/<slug> would reach: <tmp>/outside.
        const outside = path.join(r.repo, '..', 'outside');
        fs.mkdirSync(outside, { recursive: true });
        fs.writeFileSync(path.join(outside, 'canary.txt'), 'keep me');
        const err = await processPdf({
          pdfPath: r.pdfPath, cfg: r.cfg, caption: {}, workDir: path.join(r.repo, '..', 'work'), dryRun, meta: { enrich: { id: 'BONA-W023', slug: bad } },
        }).then(() => null, (e) => e);
        assert.equal(fs.existsSync(path.join(outside, 'canary.txt')), true, `dryRun ${dryRun}: nothing outside the work dir is deleted`);
        assert.match(String(err?.message), /slug/);
        assert.equal(fs.existsSync(path.join(r.repo, '..', 'bin', 'calls.jsonl')), false, 'refused before the model is paid');
      } finally { r.cleanup(); }
    }
  });

  it('a hidden listing is refused', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r, { intake: {} });
      const l = JSON.parse(fs.readFileSync(inboxFile(r), 'utf8'));
      fs.writeFileSync(inboxFile(r), `${JSON.stringify({ ...l, hidden: true }, null, 2)}\n`);
      git(r, 'commit', '-qam', 'hide (BONA-W023)');
      await assert.rejects(enrich(r), /it is hidden/);
    } finally { r.cleanup(); }
  });

  it('one specific unit keeps its own price while its models keep theirs', async () => {
    const r = await rig({ listing: reading() });
    try {
      const own = { amount: 350000, currency: 'SAR', from: false, period: null, onRequest: false };
      seed(r, { price: own, unit: { floor: 3, block: 'H', unitRef: null } });
      await enrich(r);
      const after = saved(r);
      assert.deepEqual(after.price, own);
      assert.deepEqual(after.models.map((m) => m.price), [419994, 319015]);
      assert.deepEqual(checkListing(after), []);
    } finally { r.cleanup(); }
  });

  it('r2 #10: --enrich drops model prices for the period only on a rental whose reading names another period', async () => {
    const calls = (r) => r.calls().filter((c) => c.tool === 'claude-model-confirm');
    // A rental listed per month, a reading that names no period: the prices are checked per month and kept.
    const a = reading();
    a.listing.category = 'rent';
    for (const m of a.models) m.subsidisedPrice = null;
    a.listing.price = { amount: null, currency: 'SAR', from: false, period: null, onRequest: true };
    const monthly = { amount: 319015, currency: 'SAR', from: true, period: 'month', onRequest: false };
    const r = await rig({ listing: a });
    try {
      seed(r, { price: monthly, extra: { category: 'rent' } });
      await enrich(r);
      assert.deepEqual(calls(r).map((c) => c.period), ['month']);
      assert.deepEqual(saved(r).models.map((m) => m.price), [419994, 319015]);
    } finally { r.cleanup(); }
    // A sale whose reading carries a stray period: not a rental, nothing to compare — kept, and no period asked.
    const b = reading();
    b.listing.price = { amount: 319015, currency: 'SAR', from: true, period: 'year', onRequest: false };
    const s = await rig({ listing: b });
    try {
      seed(s);
      await enrich(s);
      assert.deepEqual(calls(s).map((c) => c.period), [null]);
      assert.deepEqual(saved(s).models.map((m) => m.price), [419994, 319015]);
    } finally { s.cleanup(); }
  });

  it('Codex r1 #2: --enrich of a rental — a reading whose period is not the listing\'s refuses the model prices (warn); the listing\'s period is the one checked', async () => {
    const rental = (period) => {
      const a = reading();
      a.listing.category = 'rent';
      a.listing.price = { amount: 319015, currency: 'SAR', from: true, period, onRequest: false };
      for (const m of a.models) m.subsidisedPrice = null;
      return a;
    };
    const monthly = { amount: 319015, currency: 'SAR', from: true, period: 'month', onRequest: false };
    const calls = (r) => r.calls().filter((c) => c.tool === 'claude-model-confirm');
    const r = await rig({ listing: rental('year') });
    try {
      seed(r, { price: monthly, extra: { category: 'rent' } });
      const report = await enrich(r);
      const after = saved(r);
      assert.equal(calls(r).length, 0, 'figures of another period are not checked: they are not published');
      assert.deepEqual(after.models.map((m) => m.price), [null, null]);
      assert.deepEqual(after.price, monthly, 'the listing keeps its own price and period');
      assert.ok(report.warnings.some((w) => /per year/.test(w) && /per month/.test(w)), report.warnings.join(' | '));
      assert.ok(report.warningCodes.includes('model-price-not-printed'));
    } finally { r.cleanup(); }
    // The same period: checked FOR that period, and kept.
    const same = await rig({ listing: rental('month') });
    try {
      seed(same, { price: monthly, extra: { category: 'rent' } });
      await enrich(same);
      assert.deepEqual(calls(same).map((c) => c.period), ['month']);
      assert.deepEqual(saved(same).models.map((m) => m.price), [419994, 319015]);
      assert.deepEqual(saved(same).price, monthly);
    } finally { same.cleanup(); }
  });

  it('r2 #4 (Codex r1 #3): on --enrich too, money in a model\'s text or a fact-list item is dropped — its own price included', async () => {
    const a = reading();
    a.models[1].availability = { en: 'Down payment 50 000', ar: 'دفعة أولى 50 000' };
    a.models[0].availability = { en: 'Buildings G–P, 419,994', ar: 'المباني G–P، 419,994' };
    a.amenities = { en: ['Health club', 'Deposit 750'], ar: ['نادٍ صحي', 'عربون 750'] };
    const r = await rig({ listing: a });
    try {
      seed(r);
      const report = await enrich(r);
      const after = saved(r);
      assert.deepEqual(after.models.map((m) => m.price), [419994, 319015]);
      assert.deepEqual(after.models.map((m) => m.availability), [null, null]);
      assert.deepEqual(after.amenities, { en: ['Health club'], ar: ['نادٍ صحي'] });
      const w = report.warnings.join(' | ');
      for (const f of ['models[0].availability', 'models[1].availability', 'amenities[1]']) assert.ok(w.includes(f), `${f}: ${w}`);
      assert.deepEqual(checkListing(after), []);
    } finally { r.cleanup(); }
  });

  it('r3 #2: on --enrich a figure in a model\'s text or a fact list is dropped first — a refused one, an unchecked one, one under the owner\'s price', async () => {
    // Refused on its page: dropped, the enrichment goes on.
    const a = reading();
    a.models[0].availability = { en: 'Buildings G–P, 419,994 / 356,024', ar: 'المباني G–P، 419,994' };
    a.amenities = { en: ['Down payment 50,000', 'Health club'], ar: ['دفعة أولى 50,000', 'نادٍ صحي'] };
    const r = await rig({ listing: a, modelConfirm: [319015, 270425, 356024] });
    try {
      seed(r);
      await enrich(r, { force: true });
      assert.deepEqual(saved(r).models.map((m) => [m.price, m.availability]), [[null, null], [319015, null]]);
      assert.deepEqual(saved(r).amenities, { en: ['Health club'], ar: ['نادٍ صحي'] });
    } finally { r.cleanup(); }
    // Its check timed out: the copy guard does not turn the retryable refusal into a "rejected" one (Codex r3 #3).
    const t = await rig({ listing: structuredClone(a), modelConfirmFail: true });
    try {
      seed(t);
      const err = await enrich(t).then(() => null, (e) => e);
      assert.equal(err?.retryable, true, String(err?.reason ?? err));
      assert.match(String(err?.reason), /could not be completed/);
    } finally { t.cleanup(); }
    // Under the owner's own price nothing is checked: the figure goes all the same.
    const o = reading();
    o.models[0].availability = { en: 'Buildings G–P, 419,994', ar: 'المباني G–P، 419,994' };
    const u = await rig({ listing: o });
    try {
      seed(u, { price: { amount: 300000, currency: 'SAR', from: false, period: null, onRequest: false }, intake: { edits: ['price'] } });
      await enrich(u);
      assert.equal(u.calls().filter((c) => c.tool === 'claude-model-confirm').length, 0);
      assert.deepEqual(saved(u).models.map((m) => m.availability), [null, null]);
    } finally { u.cleanup(); }
  });

  it('the reading\'s own copy is not looked at by an enrichment (it publishes none of it)', async () => {
    const a = reading();
    a.listing.description.en = ['Two-bedroom apartments from 319,015 in phase one.', 'Two.'];
    const r = await rig({ listing: a, modelConfirm: [419994, 356024] });
    try {
      seed(r, { price: { ...ON_REQUEST } });
      const report = await enrich(r);
      assert.equal(report.ok, true);
      assert.deepEqual(report.modelPrices.refused.sort(), [270425, 319015]);
      assert.equal(saved(r).price.amount, 419994);
    } finally { r.cleanup(); }
  });

  it('a single property (no project) keeps its own price on --enrich; its models keep their confirmed prices (single-property)', async () => {
    const r = await rig({ listing: reading() });
    try {
      const own = { amount: 350000, currency: 'SAR', from: false, period: null, onRequest: false };
      const before = seed(r, { price: own });
      const l = JSON.parse(fs.readFileSync(inboxFile(r), 'utf8'));
      fs.writeFileSync(inboxFile(r), `${JSON.stringify({ ...l, project: null }, null, 2)}\n`);
      git(r, 'commit', '-qam', 'not a project (BONA-W023)');
      const report = await enrich(r);
      assert.equal(report.enrich.headline, 'single-property');
      const after = saved(r);
      assert.deepEqual(after.price, before.price);
      assert.deepEqual(after.models.map((m) => m.price), [419994, 319015]);
      assert.deepEqual(checkListing(after), []);
    } finally { r.cleanup(); }
  });

  /** Unit models a listing already carries (an earlier enrichment). */
  const prior = (n, { priced = true, sakani = false } = {}) => Array.from({ length: n }, (_, i) => ({
    name: { en: `Old ${i + 1}`, ar: `نموذج قديم ${i + 1}` }, bedrooms: 2, bathrooms: 2, areaSqm: 90, rooms: null, availability: null,
    price: priced ? 319015 + i * 1000 : null, subsidisedPrice: priced && sakani ? 270425 + i * 1000 : null, floorPlan: null,
  }));

  it('re-enrich: a reading with fewer models or a fact list fewer is refused, with what it would take away, and nothing is changed', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r, { price: { ...ON_REQUEST }, extra: { models: prior(3), nearby: { en: ['Airport'], ar: ['المطار'] } } });
      const raw = fs.readFileSync(inboxFile(r), 'utf8');
      await assert.rejects(enrich(r), (err) => err.stage === 'enrich'
        && /^BONA-W023 already carries more than this reading: unit models 3 → 2; fact list dropped: nearby — nothing was changed; re-run with --force if the new reading is right$/.test(err.reason));
      assert.equal(fs.readFileSync(inboxFile(r), 'utf8'), raw);
      assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '');
      assert.equal(r.calls().filter((c) => c.tool === 'brochure').length, 0);
      // A dry run says the same and writes nothing.
      const dry = await enrich(r, { dryRun: true });
      assert.match(dry.blocked, /already carries more than this reading: unit models 3 → 2/);
      assert.deepEqual(dry.enrich.compare, {
        before: { models: 3, prices: 3, plans: 0, facts: ['nearby'] }, after: { models: 2, prices: 4, plans: 1, facts: ['amenities', 'warranties'] },
        losses: ['unit models 3 → 2', 'fact list dropped: nearby'], forced: false,
      });
    } finally { r.cleanup(); }
  });

  it('re-enrich: --force accepts a reading with less than the listing carries', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r, { price: { ...ON_REQUEST }, extra: { models: prior(3), nearby: { en: ['Airport'], ar: ['المطار'] } } });
      const report = await enrich(r, { force: true });
      assert.equal(report.ok, true);
      assert.equal(report.enrich.compare.forced, true);
      const after = saved(r);
      assert.deepEqual(after.models.map((m) => m.name.en), ['Nawras', 'Lulu']);
      assert.equal('nearby' in after, false);
    } finally { r.cleanup(); }
  });

  it('re-enrich: fewer confirmed model prices than the listing carries is refused', async () => {
    const r = await rig({ listing: reading(), modelConfirm: [419994, 356024] });
    try {
      seed(r, { price: { ...ON_REQUEST }, extra: { models: prior(2, { sakani: true }) } });
      await assert.rejects(enrich(r), (err) => err.stage === 'enrich' && /already carries more than this reading: confirmed model prices 4 → 2 —/.test(err.reason));
      assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '');
    } finally { r.cleanup(); }
  });

  it('P6d: re-enrich — the same models but a floor plan fewer is a loss: refused, --force accepts it', async () => {
    const a = reading();
    a.models[0].floorPlan = null; // this reading found no plan for Nawras
    const withPlan = () => {
      const m = prior(2);
      m[0].floorPlan = { src: `/listings/${SLUG}/plan-03.jpg`, thumb: `/listings/${SLUG}/plan-03-thumb.webp` };
      return m;
    };
    const r = await rig({ listing: a });
    try {
      seed(r, { price: { ...ON_REQUEST }, extra: { models: withPlan() } });
      const raw = fs.readFileSync(inboxFile(r), 'utf8');
      await assert.rejects(enrich(r), (err) => err.stage === 'enrich'
        && /^BONA-W023 already carries more than this reading: floor plans 1 → 0: Old 1 \(no plan in the new reading\) — nothing was changed; re-run with --force if the new reading is right$/.test(err.reason), 'refused');
      assert.equal(fs.readFileSync(inboxFile(r), 'utf8'), raw);
      assert.equal(fs.readFileSync(path.join(pubDir(r), 'plan-03.jpg'), 'utf8'), 'old plan', 'the plan file is still there');
      const dry = await enrich(r, { dryRun: true });
      assert.deepEqual(dry.enrich.compare.before, { models: 2, prices: 2, plans: 1, facts: [] });
      assert.deepEqual(dry.enrich.compare.after, { models: 2, prices: 4, plans: 0, facts: ['amenities', 'warranties'] });
      assert.deepEqual(dry.enrich.compare.losses, ['floor plans 1 → 0: Old 1 (no plan in the new reading)']);
      const forced = await enrich(r, { force: true });
      assert.equal(forced.ok, true);
      assert.equal(saved(r).models.filter((m) => m.floorPlan).length, 0);
    } finally { r.cleanup(); }
  });

  it('an incomplete unit-model price check refuses the enrichment of a listing with model prices to lose — try again later — even with --force', async () => {
    for (const [fail, re] of [[true, /^the check of 4 unit-model price\(s\) could not be completed \(page 3\) — nothing was changed; try again later$/],
      ['quota', /^the AI quota ran out during the unit-model price check — nothing was changed; try again later$/]]) {
      const r = await rig({ listing: reading(), modelConfirmFail: fail });
      try {
        seed(r, { price: { ...ON_REQUEST }, extra: { models: prior(2) } });
        const raw = fs.readFileSync(inboxFile(r), 'utf8');
        await assert.rejects(enrich(r, { force: true }), (err) => err.stage === 'enrich' && re.test(err.reason), String(fail));
        assert.equal(fs.readFileSync(inboxFile(r), 'utf8'), raw);
        assert.equal(fs.readFileSync(path.join(pubDir(r), 'plan-03.jpg'), 'utf8'), 'old plan');
        assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '');
        const dry = await enrich(r, { dryRun: true });
        assert.match(dry.blocked, re);
      } finally { r.cleanup(); }
    }
  });

  it('Codex r1 #9: a first-time enrichment whose price check hit the quota commits nothing and says "quota" — so the backfill\'s resume runs it again from scratch', async () => {
    const r = await rig({ listing: reading(), modelConfirmFail: 'quota' });
    try {
      seed(r, { price: { ...ON_REQUEST } });
      const raw = fs.readFileSync(inboxFile(r), 'utf8');
      const err = await enrich(r).then(() => null, (e) => e);
      assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '', 'no plan, fact list or brochure written');
      assert.equal(fs.readFileSync(inboxFile(r), 'utf8'), raw);
      assert.equal(err?.stage, 'enrich');
      assert.match(String(err?.reason), /^the AI quota ran out during the unit-model price check — nothing was changed; try again later$/);
      // The backfill reads that as a quota stop, and its resume plans the listing again — not "already enriched".
      assert.equal(classifyRun({ code: 1, output: `FAILED: ${err.reason}\n` }).outcome, 'quota');
      const [row] = planBackfill([saved(r)], { findPdf: () => r.pdfPath });
      assert.equal(row.action, 'enrich', row.reason);
      assert.match((await enrich(r, { dryRun: true })).blocked, /quota/);
    } finally { r.cleanup(); }
  });

  it('r4: a plan check cut short on a first enrichment commits nothing and is retryable; --force (not a quota) takes the models without plans', async () => {
    for (const planCheck of ['quota', true]) {
      const r = await rig({ listing: reading(), planCheck });
      try {
        seed(r, { price: { ...ON_REQUEST } });
        const raw = fs.readFileSync(inboxFile(r), 'utf8');
        const err = await enrich(r).then(() => null, (e) => e);
        assert.equal(err?.retryable, true, String(planCheck));
        assert.match(String(err?.reason), /floor-plan contact check/);
        assert.match(String(err?.reason), planCheck === 'quota' ? /quota/ : /could not be completed/);
        assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '', 'nothing committed');
        assert.equal(fs.readFileSync(inboxFile(r), 'utf8'), raw);
        assert.match((await enrich(r, { dryRun: true })).blocked, /floor-plan contact check/, 'a dry run asks too, and shows it');
      } finally { r.cleanup(); }
    }
    // --force, the check failed (not a quota), the listing has no plan to lose: the models go up without plans.
    const f = await rig({ listing: reading(), planCheck: true });
    try {
      seed(f, { price: { ...ON_REQUEST } });
      fs.rmSync(path.join(pubDir(f), 'plan-03.jpg')); fs.rmSync(path.join(pubDir(f), 'plan-03-thumb.webp'));
      git(f, 'add', '-A'); git(f, 'commit', '-qm', 'no plan yet');
      const report = await enrich(f, { force: true });
      assert.equal(report.ok, true);
      assert.deepEqual(saved(f).models.map((m) => m.floorPlan), [null, null]);
      assert.ok(report.warnings.some((w) => /--force/.test(w) && /floor plan/.test(w)), report.warnings.join(' | '));
    } finally { f.cleanup(); }
    // A quota, --force or not: retryable.
    const q = await rig({ listing: reading(), planCheck: 'quota' });
    try {
      seed(q, { price: { ...ON_REQUEST } });
      assert.equal((await enrich(q, { force: true }).then(() => null, (e) => e))?.retryable, true);
    } finally { q.cleanup(); }
  });

  it('r5 #11: an enrichment --force takes without its unchecked plans carries `plans-unchecked`; one whose plans were all checked clears it', async () => {
    const f = await rig({ listing: reading(), planCheck: true });
    try {
      seed(f, { price: { ...ON_REQUEST } });
      fs.rmSync(path.join(pubDir(f), 'plan-03.jpg')); fs.rmSync(path.join(pubDir(f), 'plan-03-thumb.webp'));
      git(f, 'add', '-A'); git(f, 'commit', '-qm', 'no plan yet');
      assert.equal((await enrich(f, { force: true })).ok, true);
      assert.deepEqual(saved(f)._intake.warnings, ['map-unconfirmed', 'plans-unchecked']);
      const [row] = planBackfill([saved(f)], { findPdf: () => f.pdfPath });
      assert.equal(row.action, 'enrich', row.reason);
      // r6 #9: the plans were left out of the published listing, never published unchecked.
      assert.equal(saved(f).models.some((m) => m.floorPlan), false, 'no plan went up');
      assert.match(row.reason, /published without the floor plans whose contact check did not finish — enriched again\)$/);
      assert.doesNotMatch(row.reason, /published unchecked/);
    } finally { f.cleanup(); }
    // Published without its plans earlier; this time every plan is checked (one clean, or flagged and left out).
    for (const planCheck of [null, { 'plan-01': 'website' }]) {
      const r = await rig({ listing: reading(), planCheck });
      try {
        seed(r, { price: { ...ON_REQUEST }, intake: { warnings: ['map-unconfirmed', 'plans-unchecked'] } });
        const dry = await enrich(r, { dryRun: true });
        assert.equal(dry.ok, true);
        assert.equal((await enrich(r)).ok, true);
        assert.deepEqual(saved(r)._intake.warnings, ['map-unconfirmed'], JSON.stringify(planCheck));
        const [row] = planBackfill([saved(r)], { findPdf: () => r.pdfPath });
        assert.equal(row.action, 'skip', row.reason);
      } finally { r.cleanup(); }
    }
  });

  it('r4: a re-enrichment whose plans cannot be checked keeps the never-degrade rule — refused, --force or not', async () => {
    const r = await rig({ listing: reading(), planCheck: true });
    try {
      const plan = { src: `/listings/${SLUG}/plan-03.jpg`, thumb: `/listings/${SLUG}/plan-03-thumb.webp` };
      seed(r, { price: { ...ON_REQUEST }, extra: { models: [{ ...prior(1, { priced: false })[0], floorPlan: plan }] } });
      const err = await enrich(r, { force: true }).then(() => null, (e) => e);
      assert.equal(err?.retryable, true);
      assert.equal(fs.readFileSync(path.join(pubDir(r), 'plan-03.jpg'), 'utf8'), 'old plan');
    } finally { r.cleanup(); }
  });

  it('r4: a plan the contact check flags is left out of the enrichment, the rest goes up', async () => {
    const r = await rig({ listing: reading(), planCheck: { 'plan-01': 'website' } });
    try {
      seed(r);
      const report = await enrich(r);
      assert.deepEqual(saved(r).models.map((m) => m.floorPlan), [null, null]);
      assert.ok(!fs.readdirSync(pubDir(r)).some((f) => f.startsWith('plan-')));
      assert.ok(report.warnings.some((w) => /Nawras/.test(w) && /a website/.test(w)), report.warnings.join(' | '));
      assert.equal(msg.planCheckLine(report.planCheck), '1 floor plan · 1 left out by the contact check');
    } finally { r.cleanup(); }
  });

  /** r5 #6: Nawras's plan = candidate 5, Lulu's = candidate 6 (both excluded from the gallery). */
  const twoPlans = () => {
    const a = reading();
    a.models[1].floorPlan = 6;
    a.images.push({ index: 6, room: 'view', rank: null, hero: false, exclude: true, reason: 'floor plan', focus: null });
    return a;
  };

  it('r5 #6: a plan the check could not prepare never reaches the repo on --enrich', async () => {
    // Nawras's plan cannot be read while the check prepares the plans, and reads fine when the enrichment stages them.
    const r = await rig({ listing: twoPlans(), candidateCount: 7, broken: [5], healOnPlanCheck: true });
    try {
      seed(r);
      const report = await enrich(r);
      assert.equal(report.ok, true);
      assert.deepEqual(r.calls().filter((c) => c.tool === 'claude-plan-check').map((c) => c.files), [['plan-02.jpg']]);
      assert.deepEqual(saved(r).models.map((m) => m.floorPlan?.src ?? null), [null, `/listings/${SLUG}/plan-02.jpg`]);
      assert.deepEqual(fs.readdirSync(pubDir(r)).filter((f) => f.startsWith('plan-')).sort(), ['plan-02-thumb.webp', 'plan-02.jpg']);
      assert.ok(report.warnings.includes('1 floor plan not published (Nawras: could not be prepared)'), report.warnings.join(' | '));
    } finally { r.cleanup(); }
  });

  it('r5 #6: an --enrich dry run never previews a plan the check could not prepare', async () => {
    const d = await rig({ listing: twoPlans(), candidateCount: 7, broken: [5] });
    try {
      seed(d);
      const report = await enrich(d, { dryRun: true });
      assert.deepEqual(report.enrich.plans, [`/listings/${SLUG}/plan-02.jpg`]);
      assert.deepEqual(report.floorPlans.map((p) => p.model), [1]);
    } finally { d.cleanup(); }
  });

  it('r5 #7 (Codex r4 #6): re-enrich counts plan losses per model — a published plan flagged now is a loss though another model gains one; --force takes it', async () => {
    // The listing carries Nawras's plan; this reading's plan for Nawras is flagged and Lulu gains a clean one: 1 → 1.
    const carried = () => {
      const m = prior(2);
      m[0].name = { en: 'Nawras', ar: 'نموذج نورس' };
      m[1].name = { en: 'Lulu', ar: 'نموذج لؤلؤ' };
      m[0].floorPlan = { src: `/listings/${SLUG}/plan-03.jpg`, thumb: `/listings/${SLUG}/plan-03-thumb.webp` };
      return m;
    };
    const r = await rig({ listing: twoPlans(), candidateCount: 7, planCheck: { 'plan-01': 'phone' } });
    try {
      seed(r, { price: { ...ON_REQUEST }, extra: { models: carried() } });
      const raw = fs.readFileSync(inboxFile(r), 'utf8');
      await assert.rejects(enrich(r), (err) => err.stage === 'enrich' && !err.retryable
        && /^BONA-W023 already carries more than this reading: floor plan dropped: Nawras \(flagged: shows a phone number\) — nothing was changed; re-run with --force if the new reading is right$/.test(err.reason), 'refused');
      assert.equal(fs.readFileSync(inboxFile(r), 'utf8'), raw);
      assert.equal(fs.readFileSync(path.join(pubDir(r), 'plan-03.jpg'), 'utf8'), 'old plan', 'the plan file is still there');
      assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '');
      const dry = await enrich(r, { dryRun: true });
      assert.deepEqual([dry.enrich.compare.before.plans, dry.enrich.compare.after.plans], [1, 1]);
      assert.deepEqual(dry.enrich.compare.losses, ['floor plan dropped: Nawras (flagged: shows a phone number)']);
      assert.match(dry.blocked, /floor plan dropped: Nawras/);
      const forced = await enrich(r, { force: true });
      assert.equal(forced.ok, true);
      assert.equal(forced.enrich.compare.forced, true);
      assert.deepEqual(saved(r).models.map((m) => [m.name.en, m.floorPlan?.src ?? null]), [['Nawras', null], ['Lulu', `/listings/${SLUG}/plan-02.jpg`]]);
    } finally { r.cleanup(); }
    // Not found this time, or the model itself gone: a loss all the same. The same model keeping a plan is none.
    const plan = (n) => ({ src: `/listings/${SLUG}/plan-0${n}.jpg`, thumb: `/listings/${SLUG}/plan-0${n}-thumb.webp` });
    const m = (en, floorPlan = null) => ({ name: { en, ar: en }, floorPlan });
    assert.deepEqual(compareEnrichment({ models: [m('Nawras', plan(3)), m('Lulu')] }, { models: [m('Nawras'), m('Lulu', plan(2))] }).losses, ['floor plan dropped: Nawras (no plan in the new reading)']);
    assert.deepEqual(compareEnrichment({ models: [m('Nawras', plan(3)), m('Lulu')] }, { models: [m('Lulu'), m('Saif', plan(2))] }).losses, ['floor plan dropped: Nawras (no plan in the new reading)']);
    assert.deepEqual(compareEnrichment({ models: [m('Nawras', plan(3)), m('Lulu')] }, { models: [m('Nawras', plan(1)), m('Lulu', plan(2))] }).losses, []);
  });

  /** A published plan, as the listing JSON carries it. */
  const planAt = (n) => ({ src: `/listings/${SLUG}/plan-${String(n).padStart(2, '0')}.jpg`, thumb: `/listings/${SLUG}/plan-${String(n).padStart(2, '0')}-thumb.webp` });

  it('r6 #5 (Claude r5 B5): plans are matched per model by the English OR the Arabic name — the real W023 re-readings lose nothing', () => {
    // The 8 models as enrich-dry4 and enrich-dry6 read them (work/ai.json); enrich-dry5 reads "Fairuz 1", and the
    // first reading (enrich-dry) "Al Zumurrud 2" and "Al Fairouz 1". The Arabic names are the same every time.
    const W023 = [
      ['Lulu 2', 'نموذج لؤلؤ 2', 79.77], ['Nawras 2', 'نموذج نورس 2', 105.02], ['Saif 2', 'نموذج سيف 2', 122.98], ['Saif 3', 'نموذج سيف 3', 127.93],
      ['Marafi 3', 'نموذج مرافئ 3', 148.46], ['Zumurrud 2', 'نموذج الزمرد 2', 156.84], ['Fairouz 1', 'نموذج الفيروز 1', 160.05], ['Kahraman 2', 'نموذج كهرمان 2', 175.4],
    ];
    const readings = { dry4: {}, dry5: { 'Fairouz 1': 'Fairuz 1' }, dry6: {}, dry: { 'Zumurrud 2': 'Al Zumurrud 2', 'Fairouz 1': 'Al Fairouz 1' } };
    const models = (renamed, planned = () => true) => W023.map(([en, ar, areaSqm], i) => ({ name: { en: renamed[en] ?? en, ar }, areaSqm, floorPlan: planned(i) ? planAt(i + 1) : null }));
    for (const [a, was] of Object.entries(readings)) {
      for (const [b, now] of Object.entries(readings)) {
        assert.deepEqual(compareEnrichment({ models: models(was) }, { models: models(now) }).losses, [], `${a} → ${b}`);
        // The r5 #11 path: published with one plan left out unchecked, re-read with every plan.
        assert.deepEqual(compareEnrichment({ models: models(was, (i) => i !== 6) }, { models: models(now) }).losses, [], `${a} (7 plans) → ${b}`);
      }
    }
    // "Al Zumurrud 2" / "Al-Zumurrud 2" / "The Zumurrud 2" is "Zumurrud 2" when the Arabic differs too; a tatweel or a
    // double space in the Arabic name is the same name when the English differs too.
    const one = (en, ar, floorPlan = null) => ({ name: { en, ar }, areaSqm: 156.84, floorPlan });
    for (const en of ['Al Zumurrud 2', 'Al-Zumurrud 2', 'The  zumurrud 2']) {
      assert.deepEqual(compareEnrichment({ models: [one(en, 'نموذج الزمرد 2', planAt(6))] }, { models: [one('Zumurrud 2', 'الزمرد 2', planAt(1))] }).losses, [], en);
    }
    assert.deepEqual(compareEnrichment({ models: [one('Emerald 2', 'نموذج  الزمـرد 2', planAt(6))] }, { models: [one('Zumurrud 2', 'نموذج الزمرد 2', planAt(1))] }).losses, []);
    // A name that is neither is another model: its plan is lost.
    assert.deepEqual(compareEnrichment({ models: [one('Emerald 2', 'زمرد', planAt(6))] }, { models: [one('Zumurrud 2', 'نموذج الزمرد 2', planAt(1))] }).losses,
      ['floor plan dropped: Emerald 2 (no plan in the new reading)']);
  });

  it('r6 #5 (Codex r5 #5): a name shared by two models matches only by its full identity (English, Arabic, area)', () => {
    const t = (ar, areaSqm, floorPlan = null) => ({ name: { en: 'Type A', ar }, areaSqm, floorPlan });
    const [GROUND, UPPER] = ['نموذج أ - الدور الأرضي', 'نموذج أ - الدور العلوي'];
    // Codex's twins: one English name, two Arabic names and areas; the first loses its plan, the second gains one.
    assert.deepEqual(compareEnrichment({ models: [t(GROUND, 120, planAt(3)), t(UPPER, 95)] }, { models: [t(GROUND, 120), t(UPPER, 95, planAt(2))] }).losses,
      ['floor plan dropped: Type A (no plan in the new reading)']);
    // One English AND one Arabic name ("نموذج Type A"), told apart by the area only: a loss too.
    assert.deepEqual(compareEnrichment({ models: [t('نموذج Type A', 120, planAt(3)), t('نموذج Type A', 95)] }, { models: [t('نموذج Type A', 120), t('نموذج Type A', 95, planAt(2))] }).losses,
      ['floor plan dropped: Type A (no plan in the new reading)']);
    // Both keep their plans, in a new order; and two identical twins both keeping theirs: no loss.
    assert.deepEqual(compareEnrichment({ models: [t(GROUND, 120, planAt(3)), t(UPPER, 95, planAt(4))] }, { models: [t(UPPER, 95, planAt(1)), t(GROUND, 120, planAt(2))] }).losses, []);
    assert.deepEqual(compareEnrichment({ models: [t('نموذج Type A', 95, planAt(3)), t('نموذج Type A', 95, planAt(4))] }, { models: [t('نموذج Type A', 95, planAt(1)), t('نموذج Type A', 95, planAt(2))] }).losses, []);
    // One new model covers one old model at most: two identical twins with plans, one plan now.
    assert.deepEqual(compareEnrichment({ models: [t(GROUND, 95, planAt(3)), t(GROUND, 95, planAt(4)), t(UPPER, 80)] }, { models: [t(GROUND, 95, planAt(1)), t(GROUND, 95), t(UPPER, 80, planAt(2))] }).losses,
      ['floor plan dropped: Type A (no plan in the new reading)']);
  });

  it('r6 #5: Codex r5 #5 end to end — the first "Type A" loses its plan to a phone number, the second gains one: refused, says why; --force takes it', async () => {
    const [GROUND, UPPER] = ['نموذج أ - الدور الأرضي', 'نموذج أ - الدور العلوي'];
    const twins = () => {
      const a = twoPlans();
      a.models[0].name = { en: 'Type A', ar: GROUND };
      a.models[1].name = { en: 'Type A', ar: UPPER };
      return a;
    };
    const carried = () => {
      const m = prior(2);
      m[0].name = { en: 'Type A', ar: GROUND };
      m[0].areaSqm = 105;
      m[0].floorPlan = planAt(3);
      m[1].name = { en: 'Type A', ar: UPPER };
      m[1].areaSqm = 88;
      return m;
    };
    const r = await rig({ listing: twins(), candidateCount: 7, planCheck: { 'plan-01': 'phone' } });
    try {
      seed(r, { price: { ...ON_REQUEST }, extra: { models: carried() } });
      const raw = fs.readFileSync(inboxFile(r), 'utf8');
      await assert.rejects(enrich(r), (err) => err.stage === 'enrich' && !err.retryable
        && /^BONA-W023 already carries more than this reading: floor plan dropped: Type A \(flagged: shows a phone number\) — nothing was changed; re-run with --force if the new reading is right$/.test(err.reason), 'refused');
      assert.equal(fs.readFileSync(inboxFile(r), 'utf8'), raw);
      assert.equal(fs.readFileSync(path.join(pubDir(r), 'plan-03.jpg'), 'utf8'), 'old plan', 'the plan file is still there');
      assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '');
      const forced = await enrich(r, { force: true });
      assert.equal(forced.ok, true);
      assert.equal(forced.enrich.compare.forced, true);
      assert.deepEqual(saved(r).models.map((m) => [m.name.ar, m.floorPlan?.src ?? null]), [[GROUND, null], [UPPER, `/listings/${SLUG}/plan-02.jpg`]]);
    } finally { r.cleanup(); }
  });

  it('r6 #5 (B5): a re-reading that words the English names differently ("Al Zumurrud 2" → "Zumurrud 2", "Fairouz 1" → "Fairuz 1") keeps the plans, not refused', async () => {
    const renamed = () => {
      const a = twoPlans();
      a.models[0].name = { en: 'Zumurrud 2', ar: 'نموذج الزمرد 2' };
      a.models[1].name = { en: 'Fairuz 1', ar: 'نموذج الفيروز 1' };
      return a;
    };
    const carried = () => {
      const m = prior(2);
      m[0].name = { en: 'Al Zumurrud 2', ar: 'نموذج الزمرد 2' };
      m[0].floorPlan = planAt(3);
      m[1].name = { en: 'Fairouz 1', ar: 'نموذج الفيروز 1' };
      m[1].floorPlan = planAt(4);
      return m;
    };
    const r = await rig({ listing: renamed(), candidateCount: 7 });
    try {
      seed(r, { price: { ...ON_REQUEST }, extra: { models: carried() } });
      for (const f of ['plan-04.jpg', 'plan-04-thumb.webp']) fs.writeFileSync(path.join(pubDir(r), f), 'old plan');
      git(r, 'add', '-A'); git(r, 'commit', '-qm', 'second plan');
      const dry = await enrich(r, { dryRun: true });
      assert.deepEqual([dry.enrich.compare.before.plans, dry.enrich.compare.after.plans, dry.enrich.compare.losses], [2, 2, []]);
      const report = await enrich(r);
      assert.equal(report.ok, true);
      assert.equal(report.enrich.compare.forced, false);
      assert.deepEqual(saved(r).models.map((m) => [m.name.en, m.floorPlan?.src ?? null]),
        [['Zumurrud 2', `/listings/${SLUG}/plan-01.jpg`], ['Fairuz 1', `/listings/${SLUG}/plan-02.jpg`]]);
    } finally { r.cleanup(); }
  });

  it('r6 #5 (Claude r5 NB3): each named plan loss says why — flagged, no clear answer, not checked, could not be prepared, no plan in the new reading', async () => {
    // As r5 #7: the listing carries Nawras's plan, the reading gives Lulu one; Nawras's is lost for the reason given.
    const carried = () => {
      const m = prior(2);
      m[0].name = { en: 'Nawras', ar: 'نموذج نورس' };
      m[0].floorPlan = planAt(3);
      m[1].name = { en: 'Lulu', ar: 'نموذج لؤلؤ' };
      return m;
    };
    const noPlan = () => { const a = twoPlans(); a.models[0].floorPlan = null; return a; };
    // `after`: the new reading's plans kept. 'missing' (no record about Nawras's image) leaves the whole call unchecked
    // since r8 #1 (Codex r7 C#1), so Lulu's plan is not kept either (it was 1 under r5 #5's per-plan rule), and the
    // loss is worded as the count that fell, with the same reason.
    for (const [opts, why, after = 1] of [
      [{ listing: twoPlans(), planCheck: { 'plan-01': 'phone, logo' } }, 'flagged: shows a phone number, a logo or brand name'],
      [{ listing: twoPlans(), planReply: 'duplicate' }, 'no clear answer from the check'],
      [{ listing: twoPlans(), planReply: 'missing' }, 'not checked', 0],
      [{ listing: twoPlans(), broken: [5] }, 'could not be prepared'],
      [{ listing: noPlan() }, 'no plan in the new reading'],
    ]) {
      const r = await rig({ candidateCount: 7, ...opts });
      try {
        seed(r, { price: { ...ON_REQUEST }, extra: { models: carried() } });
        const dry = await enrich(r, { dryRun: true });
        assert.deepEqual([dry.enrich.compare.before.plans, dry.enrich.compare.after.plans], [1, after], why);
        assert.deepEqual(dry.enrich.compare.losses, [`${after === 1 ? 'floor plan dropped' : `floor plans 1 → ${after}`}: Nawras (${why})`], why);
      } finally { r.cleanup(); }
    }
  });

  const MIXED = "names mixed up with another model's in the new reading";

  it('r7 #7 (Codex r6 #4): a model whose English name names one new model and its Arabic name another is no match — the swapped Arabic names cost Type A its plan, in every row order', () => {
    const one = (en, ar, areaSqm, floorPlan = null) => ({ name: { en, ar }, areaSqm, floorPlan });
    // Codex's case: the re-reading keeps English and area, swaps the Arabic names, leaves A's plan out and gives B one.
    const A = one('Type A', 'نموذج أ', 120, planAt(3));
    const B = one('Type B', 'نموذج ب', 95);
    const A2 = one('Type A', 'نموذج ب', 120);
    const B2 = one('Type B', 'نموذج أ', 95, planAt(2));
    for (const olds of [[A, B], [B, A]]) {
      for (const news of [[A2, B2], [B2, A2]]) {
        for (const why of [new Map(), new Map([[news.indexOf(A2), 'flagged: shows a phone number']])]) {
          const got = compareEnrichment({ models: olds }, { models: news }, why);
          assert.deepEqual([got.before.plans, got.after.plans], [1, 1]);
          assert.deepEqual(got.losses, [`floor plan dropped: Type A (${MIXED})`], `${olds.map((m) => m.name.ar)} → ${news.map((m) => m.name.ar)}`);
        }
      }
    }
    // Without the swap, the same reading says the plan was flagged.
    assert.deepEqual(compareEnrichment({ models: [A, B] }, { models: [one('Type A', 'نموذج أ', 120), one('Type B', 'نموذج ب', 95, planAt(2))] }, new Map([[0, 'flagged: shows a phone number']])).losses,
      ['floor plan dropped: Type A (flagged: shows a phone number)']);
    // The crossed greedy case: one result in every order (each name listed in the listing's own order).
    const X = one('Villa A', 'فيلا أ', 200, planAt(3));
    const Y = one('Villa B', 'فيلا ب', 300, planAt(4));
    const N1 = one('Villa B', 'فيلا أ', 300, planAt(1));
    const N2 = one('Villa A', 'فيلا ج', 200, planAt(2));
    for (const olds of [[X, Y], [Y, X]]) {
      for (const news of [[N1, N2], [N2, N1]]) {
        assert.deepEqual(compareEnrichment({ models: olds }, { models: news }).losses,
          [`floor plans dropped: ${olds.map((m) => `${m.name.en} (${MIXED})`).join(', ')}`], `${olds.map((m) => m.name.en)} → ${news.map((m) => m.name.ar)}`);
      }
    }
    // The same contradiction seen from the new side: one new model carries Saif's English name and Marafi's Arabic
    // name. It covers neither, whichever comes first (with the rule on the old side only, the first one took it).
    const S = one('Saif 2', 'نموذج سيف 2', 122.98, planAt(3));
    const M = one('Marafi 3', 'نموذج مرافئ 3', 148.46, planAt(5));
    const SM = one('Saif 2', 'نموذج مرافئ 3', 122.98, planAt(1));
    const K = one('Kahraman 2', 'نموذج كهرمان 2', 175.4, planAt(2));
    for (const olds of [[S, M], [M, S]]) {
      for (const news of [[SM, K], [K, SM]]) {
        assert.deepEqual(compareEnrichment({ models: olds }, { models: news }).losses,
          [`floor plans dropped: ${olds.map((m) => `${m.name.en} (${MIXED})`).join(', ')}`], `${olds.map((m) => m.name.en)} → ${news.map((m) => m.name.en)}`);
      }
    }
  });

  it('r7 #7: Codex r6 #4 end to end — the Arabic names swapped, Type A\'s plan flagged, Type B given one: refused, plan-03 stays; --force takes it', async () => {
    const swapped = () => {
      const a = twoPlans();
      a.models[0].name = { en: 'Type A', ar: 'نموذج ب' };
      a.models[1].name = { en: 'Type B', ar: 'نموذج أ' };
      return a;
    };
    const carried = () => {
      const m = prior(2);
      m[0].name = { en: 'Type A', ar: 'نموذج أ' };
      m[0].areaSqm = 105;
      m[0].floorPlan = planAt(3);
      m[1].name = { en: 'Type B', ar: 'نموذج ب' };
      m[1].areaSqm = 88;
      return m;
    };
    const r = await rig({ listing: swapped(), candidateCount: 7, planCheck: { 'plan-01': 'phone' } });
    try {
      seed(r, { price: { ...ON_REQUEST }, extra: { models: carried() } });
      const raw = fs.readFileSync(inboxFile(r), 'utf8');
      await assert.rejects(enrich(r), (err) => err.stage === 'enrich' && !err.retryable
        && err.reason === `BONA-W023 already carries more than this reading: floor plan dropped: Type A (${MIXED}) — nothing was changed; re-run with --force if the new reading is right`, 'refused');
      assert.equal(fs.readFileSync(inboxFile(r), 'utf8'), raw);
      assert.equal(fs.readFileSync(path.join(pubDir(r), 'plan-03.jpg'), 'utf8'), 'old plan', 'the plan file is still there');
      assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '');
      const forced = await enrich(r, { force: true });
      assert.equal(forced.ok, true);
      assert.equal(forced.enrich.compare.forced, true);
      assert.deepEqual(saved(r).models.map((m) => [m.name.en, m.floorPlan?.src ?? null]), [['Type A', null], ['Type B', `/listings/${SLUG}/plan-02.jpg`]]);
    } finally { r.cleanup(); }
  });

  it('r7 #7 (Codex r6 NB3a, Claude r6 B7b): a plan count that goes down names the plans dropped and why', async () => {
    const one = (en, floorPlan = null) => ({ name: { en, ar: `نموذج ${en}` }, areaSqm: 100, floorPlan });
    assert.deepEqual(compareEnrichment({ models: [one('Type A', planAt(3)), one('Type B', planAt(4))] }, { models: [one('Type A'), one('Type B', planAt(2))] },
      new Map([[0, 'flagged: shows a phone number']])).losses, ['floor plans 2 → 1: Type A (flagged: shows a phone number)']);
    assert.deepEqual(compareEnrichment({ models: [one('Type A', planAt(3)), one('Type B', planAt(4))] }, { models: [one('Type B')] }).losses,
      ['unit models 2 → 1', 'floor plans 2 → 0: Type A (no plan in the new reading), Type B (no plan in the new reading)']);
    // End to end: Nawras and Lulu carry plans, the re-reading's plan for Nawras shows a phone number.
    const carried = () => {
      const m = prior(2);
      m[0].name = { en: 'Nawras', ar: 'نموذج نورس' };
      m[0].floorPlan = planAt(3);
      m[1].name = { en: 'Lulu', ar: 'نموذج لؤلؤ' };
      m[1].floorPlan = planAt(4);
      return m;
    };
    const r = await rig({ listing: twoPlans(), candidateCount: 7, planCheck: { 'plan-01': 'phone' } });
    try {
      seed(r, { price: { ...ON_REQUEST }, extra: { models: carried() } });
      for (const f of ['plan-04.jpg', 'plan-04-thumb.webp']) fs.writeFileSync(path.join(pubDir(r), f), 'old plan');
      git(r, 'add', '-A'); git(r, 'commit', '-qm', 'second plan');
      await assert.rejects(enrich(r), (err) => err.stage === 'enrich' && !err.retryable
        && err.reason === 'BONA-W023 already carries more than this reading: floor plans 2 → 1: Nawras (flagged: shows a phone number) — nothing was changed; re-run with --force if the new reading is right', 'refused');
      assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '');
    } finally { r.cleanup(); }
  });

  it('r3 #7: --force accepts a first enrichment whose check failed for a reason that is not a quota — without those prices, and says so', async () => {
    const r = await rig({ listing: reading(), modelConfirmFail: true });
    try {
      seed(r, { price: { ...ON_REQUEST } });
      const report = await enrich(r, { force: true });
      assert.equal(report.ok, true);
      assert.deepEqual(saved(r).models.map((m) => [m.name.en, m.price]), [['Nawras', null], ['Lulu', null]]);
      assert.ok(report.warnings.some((w) => /--force/.test(w) && /without/.test(w) && /4 unit-model price/.test(w)), report.warnings.join(' | '));
    } finally { r.cleanup(); }
    // A quota stays "try again later", --force or not; and so does a listing with model prices to lose.
    for (const [fail, extra] of [['quota', {}], [true, { models: prior(2) }]]) {
      const q = await rig({ listing: reading(), modelConfirmFail: fail });
      try {
        seed(q, { price: { ...ON_REQUEST }, extra });
        const err = await enrich(q, { force: true }).then(() => null, (e) => e);
        assert.equal(err?.retryable, true, String(fail));
      } finally { q.cleanup(); }
    }
  });

  it('P6b (r2 #9): a first-time enrichment whose price check failed for any reason commits nothing and exits retryable — the backfill reruns it', async () => {
    const r = await rig({ listing: reading(), modelConfirmFail: true });
    try {
      seed(r, { price: { ...ON_REQUEST } });
      const raw = fs.readFileSync(inboxFile(r), 'utf8');
      const err = await enrich(r).then(() => null, (e) => e);
      assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '', 'no plan, fact list or brochure written');
      assert.equal(fs.readFileSync(inboxFile(r), 'utf8'), raw);
      assert.equal(err?.stage, 'enrich');
      assert.equal(err?.retryable, true);
      assert.match(String(err?.reason), /^the check of 4 unit-model price\(s\) could not be completed \(page 3\) — nothing was changed; try again later$/);
      // run-once prints a retryable refusal as FAILED: the backfill stops there (or, with --continue-on-error, lists
      // it under "retry the failed ones"), and its resume plans the listing again — not "already enriched".
      assert.equal(classifyRun({ code: 1, output: `FAILED: ${err.reason}\n` }).outcome, 'failed');
      const runOnce = fs.readFileSync(path.join(REPO, 'services', 'intake', 'run-once.mjs'), 'utf8');
      assert.match(runOnce, /err instanceof RejectError && !err\.retryable/);
      const [row] = planBackfill([saved(r)], { findPdf: () => r.pdfPath });
      assert.equal(row.action, 'enrich', row.reason);
      assert.match((await enrich(r, { dryRun: true })).blocked, /try again later/);
    } finally { r.cleanup(); }
  });

  const ABROAD = {
    district: { en: 'Hampstead', ar: 'هامبستيد' }, city: { en: 'London', ar: 'لندن' },
    country: { en: 'United Kingdom', ar: 'المملكة المتحدة' }, countryCode: 'GB',
  };

  it('model prices read in another currency (AED on a SAR listing on request): published without prices, currency-mismatch, no page check', async () => {
    const a = reading();
    a.listing.price = { amount: 1250000, currency: 'AED', from: true, period: null, onRequest: false };
    const r = await rig({ listing: a });
    try {
      const before = seed(r, { price: { ...ON_REQUEST } });
      const report = await enrich(r);
      assert.equal(report.enrich.headline, 'currency-mismatch');
      assert.deepEqual(report.enrich.currency, { reading: 'AED', established: true, listing: 'SAR' });
      assert.equal(report.modelPrices.decision, 'currency-mismatch');
      assert.equal(r.calls().filter((c) => c.tool === 'claude-model-confirm').length, 0, 'no figure is checked that will not be published');
      const after = saved(r);
      assert.deepEqual(after.price, before.price, 'the headline is not adopted');
      assert.deepEqual(after.models.map((m) => [m.name.en, m.price, m.subsidisedPrice]), [['Nawras', null, null], ['Lulu', null, null]]);
      assert.ok(report.warnings.some((w) => /not in the listing's currency \(SAR\): they read as AED/.test(w)), report.warnings.join(' | '));
      assert.deepEqual(checkListing(after), []);
    } finally { r.cleanup(); }
  });

  it('a reading on request whose "SAR" is only the default (W020: a brochure abroad priced in GBP): currency-mismatch, no prices', async () => {
    const a = reading();
    a.listing.price = { ...ON_REQUEST };
    a.listing.location = ABROAD;
    const r = await rig({ listing: a });
    try {
      const before = seed(r, { price: { ...ON_REQUEST }, location: ABROAD });
      const report = await enrich(r);
      assert.equal(report.enrich.headline, 'currency-mismatch');
      assert.deepEqual(report.enrich.currency, { reading: 'SAR', established: false, listing: 'SAR' });
      assert.equal(r.calls().filter((c) => c.tool === 'claude-model-confirm').length, 0);
      const after = saved(r);
      assert.deepEqual(after.price, before.price);
      assert.deepEqual(after.models.map((m) => m.price), [null, null]);
      assert.ok(report.warnings.some((w) => /the reading established no currency/.test(w)), report.warnings.join(' | '));
    } finally { r.cleanup(); }
  });

  it('P2: W020-shaped — the reading follows the prompt (headline = its cheapest model, from, "SAR"): an amount abroad establishes no currency, nothing adopted', async () => {
    const a = reading();
    a.listing.location = ABROAD;
    a.listing.price = { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false, subsidisedAmount: 270425 };
    a.priceEvidence = { page: 3, quote: '£319,015' };
    const r = await rig({ listing: a, printedIn: 'GBP' });
    try {
      const before = seed(r, { price: { ...ON_REQUEST }, location: ABROAD });
      const report = await enrich(r);
      assert.equal(report.enrich.headline, 'currency-mismatch');
      assert.deepEqual(report.enrich.currency, { reading: 'SAR', established: false, listing: 'SAR' });
      assert.equal(r.calls().filter((c) => c.tool === 'claude-model-confirm').length, 0, 'no figure checked that will not be published');
      const after = saved(r);
      assert.deepEqual(after.price, before.price, 'still on request: no "From SAR 319,015" for a brochure priced in pounds');
      assert.deepEqual(after.models.map((m) => [m.price, m.subsidisedPrice]), [[null, null], [null, null]]);
      assert.ok(report.warnings.some((w) => /the reading established no currency/.test(w) && /GB/.test(w)), report.warnings.join(' | '));
    } finally { r.cleanup(); }
  });

  it('a reading on request in the listing\'s home currency (a Saudi brochure) still adopts the models\' headline', async () => {
    const a = reading();
    a.listing.price = { ...ON_REQUEST };
    const r = await rig({ listing: a });
    try {
      seed(r, { price: { ...ON_REQUEST } });
      const report = await enrich(r);
      assert.equal(report.enrich.headline, 'adopted');
      assert.equal(report.enrich.currency, null);
      assert.deepEqual(saved(r).price, PRICED);
    } finally { r.cleanup(); }
  });

  /** run-once.mjs itself, pointed at the rig's fake extractor, `claude` and brochure renderer. */
  const runOnce = (r, ...args) => {
    const bin = path.join(r.repo, '..', 'bin');
    const data = path.join(r.repo, '..', 'data');
    fs.mkdirSync(data, { recursive: true });
    const env = {
      ...process.env, BONA_DATA: data, BONA_REPO: r.repo, BONA_CLAUDE_BIN: r.cfg.claudeBin, BONA_MIN_IMAGE_SIDE: '100',
      BONA_PY_CMD: r.cfg.pyCmd.join(' '), BONA_BROCHURE_PY_CMD: r.cfg.brochurePyCmd.join(' '), BONA_SITE: 'https://bona-real-estate.com',
      // The rig's own bare remote, whatever ~/.secrets/bona-services.env says.
      BONA_GIT_REMOTE: 'origin', BONA_GIT_BRANCH: 'main',
    };
    assert.ok(fs.existsSync(bin));
    try {
      const out = execFileSync(process.execPath, [path.join(REPO, 'services', 'intake', 'run-once.mjs'), r.pdfPath, '--repo', r.repo, '--work', path.join(data, 'work'), ...args], { env, stdio: 'pipe' });
      return { status: 0, out: out.toString() };
    } catch (err) { return { status: err.status, out: `${err.stdout}${err.stderr}` }; }
  };

  it('run-once --enrich --dry-run prints the models, the headline decision and the plan files, and writes nothing', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r, { price: { ...ON_REQUEST } });
      const { status, out } = runOnce(r, '--enrich', 'BONA-W023', '--dry-run');
      assert.equal(status, 0, out);
      assert.match(out, /Models {5}2 — 2 priced · prices kept 4 \/ refused 0/);
      assert.match(out, /Headline {3}adopted — was on request: the models' confirmed headline is adopted/);
      assert.match(out, /after {2}SAR 319,015 \(from\) · Sakani beneficiaries SAR 270,425/);
      assert.match(out, new RegExp(`Plans {6}/listings/${SLUG}/plan-01\\.jpg {2}\\(removing plan-03-thumb\\.webp plan-03\\.jpg\\)`));
      assert.match(out, /DRY RUN — nothing written/);
      assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '');
    } finally { r.cleanup(); }
  });

  it('run-once --enrich --dry-run names a currency mismatch and both currencies', async () => {
    const a = reading();
    a.listing.price = { amount: 1250000, currency: 'AED', from: true, period: null, onRequest: false };
    const r = await rig({ listing: a });
    try {
      seed(r, { price: { ...ON_REQUEST } });
      const { status, out } = runOnce(r, '--enrich', 'BONA-W023', '--dry-run');
      assert.equal(status, 0, out);
      assert.match(out, /Headline {3}currency-mismatch — the brochure prices its models in AED, the listing is in SAR: the models are published without prices/);
      assert.match(out, /Nawras {18} on request/);
    } finally { r.cleanup(); }
  });

  it('run-once --enrich --dry-run compares with what the listing carries; --force accepts less', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r, { price: { ...ON_REQUEST }, extra: { models: prior(3), nearby: { en: ['Airport'], ar: ['المطار'] } } });
      const refused = runOnce(r, '--enrich', 'BONA-W023', '--dry-run');
      assert.equal(refused.status, 0, refused.out);
      assert.match(refused.out, /Compared {3}models 3 → 2 · model prices 3 → 4 · floor plans 0 → 1 · fact lists nearby → amenities, warranties {2}\(LESS than the listing carries\)/);
      assert.match(refused.out, /WOULD BE REJECTED — BONA-W023 already carries more than this reading: unit models 3 → 2; fact list dropped: nearby/);
      const forced = runOnce(r, '--enrich', 'BONA-W023', '--dry-run', '--force');
      assert.equal(forced.status, 0, forced.out);
      assert.match(forced.out, /\(LESS than the listing carries — accepted with --force\)/);
      assert.doesNotMatch(forced.out, /WOULD BE REJECTED/);
    } finally { r.cleanup(); }
  });

  it('run-once --enrich commits "intake: enrich <title> (<id>) — unit models + brochure" with the listing\'s own paths, and pushes', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r);
      const remote = path.join(r.repo, '..', 'remote.git');
      execFileSync('git', ['init', '-q', '--bare', remote]);
      git(r, 'branch', '-M', 'main');
      git(r, 'remote', 'add', 'origin', remote);
      git(r, 'push', '-q', 'origin', 'main');
      const { status, out } = runOnce(r, '--enrich', 'BONA-W023');
      assert.equal(status, 0, out);
      assert.match(out, /Headline {3}kept — equals the lowest model price: kept/);
      const line = out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j?.event === 'intake.enrich');
      assert.deepEqual([line.models, line.kept, line.refused, line.headline], [2, 4, 0, 'kept'], 'one JSON log line says what the run did');
      assert.match(out, /brochure rebuilt/);
      assert.match(out, /Pushed [0-9a-f]+/);
      const log = execFileSync('git', ['log', '-1', '--format=%s', 'main'], { cwd: remote }).toString().trim();
      assert.equal(log, 'intake: enrich Jeddah Heights — corrected by hand (BONA-W023) — unit models + brochure');
      const files = execFileSync('git', ['show', '--name-only', '--format=', 'main'], { cwd: remote }).toString().split('\n').filter(Boolean).sort();
      assert.deepEqual(files, [
        `public/listings/${SLUG}/brochure.pdf`, `public/listings/${SLUG}/plan-01-thumb.webp`, `public/listings/${SLUG}/plan-01.jpg`,
        `public/listings/${SLUG}/plan-03-thumb.webp`, `public/listings/${SLUG}/plan-03.jpg`, `scripts/curate/inbox/${SLUG}.json`,
      ]);
      assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '');
    } finally { r.cleanup(); }
  });

  it('run-once --enrich: a refused headline is "WOULD BE REJECTED" in a dry run and "REJECTED at enrich" for real, with nothing written', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r, { price: { amount: 350000, currency: 'SAR', from: false, period: null, onRequest: false } });
      const dry = runOnce(r, '--enrich', 'BONA-W023', '--dry-run');
      assert.equal(dry.status, 0, dry.out);
      assert.match(dry.out, /Headline {3}refused — REFUSED/);
      assert.match(dry.out, /WOULD BE REJECTED — BONA-W023 shows SAR 350,000 but the brochure's lowest model price is SAR 319,015/);
      const remote = path.join(r.repo, '..', 'remote.git');
      execFileSync('git', ['init', '-q', '--bare', remote]);
      git(r, 'branch', '-M', 'main'); git(r, 'remote', 'add', 'origin', remote); git(r, 'push', '-q', 'origin', 'main');
      const real = runOnce(r, '--enrich', 'BONA-W023');
      assert.equal(real.status, 1);
      assert.match(real.out, /REJECTED at "enrich": BONA-W023 shows SAR 350,000/);
      assert.equal(git(r, 'status', '--porcelain', '--untracked-files=all'), '');
      assert.equal(git(r, 'rev-parse', 'HEAD'), execFileSync('git', ['rev-parse', 'main'], { cwd: remote }).toString(), 'nothing committed or pushed');
    } finally { r.cleanup(); }
  });

  it('run-once --enrich refuses a dirty publishing clone instead of discarding its changes', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r);
      fs.writeFileSync(path.join(r.repo, 'scripts', 'curate', 'inbox', '_index.json'), '{"unsaved": true}\n');
      const { status, out } = runOnce(r, '--enrich', 'BONA-W023');
      assert.equal(status, 1);
      assert.match(out, /has uncommitted changes, which --enrich will not discard/);
      assert.match(fs.readFileSync(path.join(r.repo, 'scripts', 'curate', 'inbox', '_index.json'), 'utf8'), /unsaved/);
    } finally { r.cleanup(); }
  });

  it('a listing the intake enriched can still be replaced later (an enrich commit is the intake\'s own)', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r);
      git(r, 'reset', '-q', '--hard', 'HEAD~1'); // drop the hand-fix commit: a listing only the intake ever touched
      await enrich(r);
      git(r, 'add', '-A'); git(r, 'commit', '-qm', 'intake: enrich Jeddah Heights (BONA-W023) — unit models + brochure');
      const { changedSincePublished } = await import('../lib/publish.mjs');
      assert.equal(await changedSincePublished(r.repo, [path.join('scripts', 'curate', 'inbox', `${SLUG}.json`), path.join('public', 'listings', SLUG)]), null);
    } finally { r.cleanup(); }
  });

  it('a WhatsApp `brochure <id>` rebuild ("intake: branded brochure (<id>)", index.mjs) is the intake\'s own too; it is never the publish commit', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r);
      git(r, 'reset', '-q', '--hard', 'HEAD~1'); // a listing only the intake ever touched
      fs.writeFileSync(path.join(pubDir(r), 'brochure.pdf'), 'rebuilt by `brochure BONA-W023`');
      const l = JSON.parse(fs.readFileSync(inboxFile(r), 'utf8'));
      fs.writeFileSync(inboxFile(r), `${JSON.stringify({ ...l, _intake: { ...l._intake, warnings: [] } }, null, 2)}\n`);
      git(r, 'commit', '-qam', 'intake: branded brochure (BONA-W023)');
      const { changedSincePublished } = await import('../lib/publish.mjs');
      const paths = [path.join('scripts', 'curate', 'inbox', `${SLUG}.json`), path.join('public', 'listings', SLUG)];
      assert.equal(await changedSincePublished(r.repo, paths), null);
      // A hand fix after it still counts.
      fs.writeFileSync(path.join(pubDir(r), '01.jpg'), 're-cropped by hand');
      git(r, 'commit', '-qam', 'W023 re-crop');
      assert.match(await changedSincePublished(r.repo, paths), /1 later commit\(s\), e\.g\. "W023 re-crop"/);
      // History that starts at a brochure rebuild is not a publish commit.
      const fresh = await rig({ listing: reading() });
      try {
        seed(fresh);
        git(fresh, 'reset', '-q', '--hard', 'HEAD~1');
        git(fresh, 'commit', '-q', '--amend', '-m', 'intake: branded brochure (BONA-W023)');
        assert.match(await changedSincePublished(fresh.repo, paths), /its history starts at "intake: branded brochure \(BONA-W023\)"/);
      } finally { fresh.cleanup(); }
    } finally { r.cleanup(); }
  });

  it('a backfill brochure rebuild ("intake: rebuild brochure <id>") is the intake\'s own too; it is never the publish commit', async () => {
    const r = await rig({ listing: reading() });
    try {
      seed(r);
      git(r, 'reset', '-q', '--hard', 'HEAD~1'); // a listing only the intake ever touched
      fs.writeFileSync(path.join(pubDir(r), 'brochure.pdf'), 'rebuilt by the backfill');
      git(r, 'commit', '-qam', 'intake: rebuild brochure BONA-W023');
      const { changedSincePublished } = await import('../lib/publish.mjs');
      const paths = [path.join('scripts', 'curate', 'inbox', `${SLUG}.json`), path.join('public', 'listings', SLUG)];
      assert.equal(await changedSincePublished(r.repo, paths), null);
      // A hand fix after it still counts.
      fs.writeFileSync(path.join(pubDir(r), '01.jpg'), 're-cropped by hand');
      git(r, 'commit', '-qam', 'W023 re-crop');
      assert.match(await changedSincePublished(r.repo, paths), /1 later commit\(s\), e\.g\. "W023 re-crop"/);
      // History that starts at a rebuild is not a publish commit.
      const fresh = await rig({ listing: reading() });
      try {
        seed(fresh);
        git(fresh, 'reset', '-q', '--hard', 'HEAD~1');
        git(fresh, 'commit', '-q', '--amend', '-m', 'intake: rebuild brochure BONA-W023');
        assert.match(await changedSincePublished(fresh.repo, paths), /its history starts at "intake: rebuild brochure BONA-W023"/);
      } finally { fresh.cleanup(); }
    } finally { r.cleanup(); }
  });
});

describe('run-once --enrich: the CLI guards', () => {
  const cli = (...args) => {
    try {
      execFileSync(process.execPath, [path.join(REPO, 'services', 'intake', 'run-once.mjs'), path.join(REPO, 'package.json'), ...args], { stdio: 'pipe' });
      return { status: 0, out: '' };
    } catch (err) { return { status: err.status, out: `${err.stdout}${err.stderr}` }; }
  };

  it('--enrich and --replace together: exit 2', () => {
    const r = cli('--enrich', 'BONA-W023', '--replace', 'BONA-W023', '--dry-run');
    assert.equal(r.status, 2);
    assert.match(r.out, /--enrich and --replace do not go together/);
  });

  it('--enrich with --no-git (and no --dry-run) is refused', () => {
    const r = cli('--no-git', '--enrich', 'BONA-W023');
    assert.equal(r.status, 2);
    assert.match(r.out, /--enrich needs git/);
  });

  it('--force without --enrich is a usage error', () => {
    const r = cli('--force', '--dry-run');
    assert.equal(r.status, 2);
    assert.match(r.out, /--force goes with --enrich only/);
  });

  it('--enrich takes no caption: the price comes from the listing', () => {
    const r = cli('--enrich', 'BONA-W023', '--caption', 'SAR 300000', '--dry-run');
    assert.equal(r.status, 2);
    assert.match(r.out, /--enrich takes no --caption/);
  });

  it('--enrich with no id is a usage error — also when the next word is another flag', () => {
    for (const args of [['--dry-run', '--enrich'], ['--enrich', '--dry-run']]) {
      const r = cli(...args);
      assert.equal(r.status, 2, args.join(' '));
      assert.match(r.out, /--enrich needs a listing id/);
    }
  });
});
