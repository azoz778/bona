/**
 * PR-BR (PLAN T25; brain/DESIGN-brain.md §5.1): the site-facts block that replaces Retell's
 * knowledge base. Built from site.json, about.json, faq.json and a price-less one-line-per-listing
 * index from listings.json, one plain-text block per language, deterministic, within 6k tokens,
 * with no price, no unit, no privacy text and no name, reloaded when a file's mtime changes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFacts, createSiteFacts, estimateTokens, MAX_FACT_TOKENS, FACT_FILES, STAT_MS } from '../lib/site-facts.mjs';
import { findAmounts, unitRefs } from '../lib/reply-guard.mjs';
import { WORKTREE_LISTINGS } from '../lib/inventory.mjs';

const SITE = {
  name: 'Bona', nameAr: 'بونا', legalName: 'Bona Real Estate',
  description: { en: 'Bona is a private real estate boutique in Jeddah.', ar: 'بونا بوتيك عقاري خاص في جدة.' },
  url: 'https://bona-real-estate.com',
  whatsapp: { e164: '+966576267694', display: '+966 57 626 7694', wa: '966576267694' },
  phone: { e164: '+966576267694', display: '+966 57 626 7694' },
  email: 'info@bona-real-estate.com',
  address: { en: { street: 'Al Rawdah District', city: 'Jeddah', region: 'Makkah Province', country: 'Saudi Arabia' },
    ar: { street: 'حي الروضة', city: 'جدة', region: 'منطقة مكة المكرمة', country: 'المملكة العربية السعودية' } },
  licences: { fal: '1100313556', cr: null },
  hours: { en: 'Sunday – Thursday, 10:00 – 19:00', ar: 'الأحد – الخميس، 10:00 – 19:00' },
  markets: { en: ['Jeddah', 'Riyadh'], ar: ['جدة', 'الرياض'] },
  concierge: { enabled: true, name: { en: 'Dana', ar: 'دانة' } },
  advertiser: { name: { en: 'Advertiser Example', ar: 'معلن تجريبي' }, phone: '+966500000000' },
};
const ABOUT = {
  story: { en: ['Bona was founded in Jeddah in 2026.', 'We represent a handful of homes at a time.'], ar: ['تأسست بونا في جدة عام 2026.', 'نمثّل عدداً محدوداً من المنازل.'] },
  values: [{ title: { en: 'Discretion', ar: 'التحفّظ' }, text: { en: 'Nothing is shared without consent.', ar: 'لا يُشارك شيء دون إذن.' } }],
  team: [{ name: { en: 'Founder Example', ar: 'مؤسس تجريبي' }, licence: '1100313556' }],
  stats: [{ label: { en: 'Residences represented', ar: 'مساكن' }, value: '29' }],
};
const FAQ = {
  updated: '2026-11-26', title: { en: 'Questions', ar: 'أسئلة' },
  items: [
    { id: 'viewing', q: { en: 'How does a viewing work?', ar: 'كيف تتم المعاينة؟' },
      a: { en: ['We arrange it with you on WhatsApp.', 'A fee of SAR 5,000 applies to nothing.'], ar: ['نرتبها معك على واتساب.', 'الوحدة B08-19 مثال.'] } },
    { id: 'licence', q: { en: 'Is Bona licensed?', ar: 'هل بونا مرخصة؟' }, a: { en: ['Yes, REGA FAL licence 1100313556.'], ar: ['نعم، رخصة فال 1100313556.'] } },
  ],
};
const listing = (id, over = {}) => ({
  id, slug: `slug-${id.toLowerCase()}`, status: 'available', category: 'buy', type: 'villa', kind: 'house',
  title: { en: `Sea View Villa ${id}`, ar: `فيلا بإطلالة ${id}` },
  location: { district: { en: 'Al Shati', ar: 'الشاطئ' }, city: { en: 'Jeddah', ar: 'جدة' } },
  price: { amount: 6_700_000, currency: 'SAR', onRequest: false },
  description: { en: 'Asking SAR 6,700,000; unit B08-19.', ar: 'السعر 6,700,000 ريال' },
  unit: { ref: 'B08-19', price: 6_700_000 },
  ...over,
});
const LISTINGS = [listing('BONA-902'), listing('BONA-901', { status: 'sold', title: { en: 'Sadana Villa', ar: 'فيلا سدانة' } }),
  listing('BONA-W903', { category: 'off-plan', kind: 'apartment', price: { onRequest: true } })];

function fixtureDir(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-facts-'));
  const files = { 'site.json': SITE, 'about.json': ABOUT, 'faq.json': FAQ, 'listings.json': LISTINGS, 'privacy.json': { secret: 'PRIVACY-MARKER' }, ...over };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  return dir;
}
const data = (over = {}) => ({ site: SITE, about: ABOUT, faq: FAQ, listings: LISTINGS, ...over });

test('the block holds who Bona is, the licence, office and hours, the public number, info@, markets, the FAQ and a listing index', () => {
  const en = buildFacts(data(), 'en');
  for (const s of ['Bona (بونا)', 'Bona Real Estate', 'Bona is a private real estate boutique in Jeddah.', 'Bona was founded in Jeddah in 2026.',
    'Discretion', '1100313556', 'Al Rawdah District, Jeddah', 'Sunday – Thursday, 10:00 – 19:00', '+966 57 626 7694', 'info@bona-real-estate.com',
    'https://bona-real-estate.com', 'Jeddah, Riyadh', 'How does a viewing work?', 'We arrange it with you on WhatsApp.', 'Is Bona licensed?',
    'BONA-902 · Sea View Villa BONA-902 · Al Shati, Jeddah · house · buy', 'BONA-W903 · Sea View Villa BONA-W903 · Al Shati, Jeddah · apartment · off-plan']) {
    assert.ok(en.includes(s), `EN block has ${s}`);
  }
  assert.match(en, /BONA-901 · Sadana Villa · Al Shati, Jeddah · house · buy · sold/);
  const ar = buildFacts(data(), 'ar');
  for (const s of ['بونا', 'حي الروضة، جدة', 'الأحد – الخميس، 10:00 – 19:00', '+966 57 626 7694', 'جدة، الرياض', 'كيف تتم المعاينة؟', 'نرتبها معك على واتساب.',
    'BONA-902 · فيلا بإطلالة BONA-902 · الشاطئ، جدة']) {
    assert.ok(ar.includes(s), `AR block has ${s}`);
  }
  assert.ok(en.indexOf('BONA-901') < en.indexOf('BONA-902') && en.indexOf('BONA-902') < en.indexOf('BONA-W903'), 'the index is sorted by id');
  assert.equal(buildFacts(data(), 'en'), en, 'deterministic');
});

test('no price, no unit, no privacy text, no personal name and no client-facing name in the block', () => {
  for (const lang of ['en', 'ar']) {
    const block = buildFacts(data(), lang);
    assert.deepEqual(findAmounts(block), [], `${lang}: no money amount`);
    assert.deepEqual(unitRefs(block), [], `${lang}: no unit reference`);
    for (const s of ['6,700,000', '6700000', 'SAR 5,000', 'PRIVACY-MARKER', 'Advertiser Example', 'معلن تجريبي', '+966500000000', 'Founder Example']) {
      assert.equal(block.includes(s), false, `${lang}: ${s}`);
    }
    assert.doesNotMatch(block, /(?<![\p{L}])(?:dana|دانة)(?![\p{L}])/iu, `${lang}: whole-word "Dana" absent`);
  }
  assert.ok(buildFacts(data(), 'en').includes('Sadana Villa'), 'whole words only: "Sadana" stays');
  assert.ok(buildFacts(data(), 'ar').includes('فيلا سدانة'));
});

test('the token estimate is a fixed bound (Arabic 2 chars a token, everything else 3); the real site data fits 6k tokens a language', () => {
  assert.equal(MAX_FACT_TOKENS, 6000);
  assert.equal(estimateTokens('a'.repeat(300)), 100);
  assert.equal(estimateTokens('ب'.repeat(200)), 100);
  assert.equal(estimateTokens(''), 0);
  const dir = path.dirname(WORKTREE_LISTINGS);
  const facts = createSiteFacts({ dir });
  assert.equal(facts.ok(), true);
  for (const lang of ['en', 'ar']) {
    const block = facts.block(lang);
    assert.ok(estimateTokens(block) <= MAX_FACT_TOKENS, `${lang}: ${estimateTokens(block)} tokens`);
    assert.ok(block.length > 2000, `${lang}: the block is not empty`);
    assert.deepEqual(findAmounts(block), [], `${lang}: no price in the real block`);
    assert.deepEqual(unitRefs(block), [], `${lang}: no unit in the real block`);
    assert.ok(block.includes('BONA-001'), 'the real listings are indexed');
  }
});

test('an over-long block is cut to the budget and keeps the firm facts first', () => {
  const long = { ...FAQ, items: Array.from({ length: 400 }, (_, i) => ({ id: `q${i}`, q: { en: `Question ${i}?`, ar: `سؤال ${i}؟` }, a: { en: ['x'.repeat(400)], ar: ['ب'.repeat(300)] } })) };
  for (const lang of ['en', 'ar']) {
    const block = buildFacts(data({ faq: long }), lang);
    assert.ok(estimateTokens(block) <= MAX_FACT_TOKENS, `${lang}: ${estimateTokens(block)}`);
    assert.ok(block.includes('1100313556') && block.includes('+966 57 626 7694'));
  }
});

test('the four files are re-read when one changes (a stat at most every 30 s); a broken file keeps the last good block', () => {
  assert.deepEqual(FACT_FILES, ['site.json', 'about.json', 'faq.json', 'listings.json']);
  assert.equal(STAT_MS, 30_000);
  const dir = fixtureDir();
  try {
    let t = 1_000_000;
    const facts = createSiteFacts({ dir, now: () => t });
    const v1 = facts.version();
    const first = facts.block('en');
    const faq2 = { ...FAQ, items: [{ id: 'new', q: { en: 'A new question?', ar: 'سؤال جديد؟' }, a: { en: ['A new answer.'], ar: ['جواب جديد.'] } }] };
    fs.writeFileSync(path.join(dir, 'faq.json'), JSON.stringify(faq2));
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(dir, 'faq.json'), future, future);
    t += 10_000;
    assert.equal(facts.block('en'), first, 'no stat inside 30 s');
    t += 30_000;
    assert.ok(facts.block('en').includes('A new question?'), 'reloaded after the mtime changed');
    assert.notEqual(facts.version(), v1);
    fs.writeFileSync(path.join(dir, 'faq.json'), '{ broken');
    const later = new Date(Date.now() + 120_000);
    fs.utimesSync(path.join(dir, 'faq.json'), later, later);
    t += 31_000;
    assert.ok(facts.block('en').includes('A new question?'), 'a broken file keeps the last good copy');
    assert.equal(facts.ok(), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing or broken file at start: not ok and an empty block (the brain then stays unconfigured)', () => {
  const dir = fixtureDir({ 'about.json': '{ nope' });
  try {
    const facts = createSiteFacts({ dir });
    assert.equal(facts.ok(), false);
    assert.equal(facts.block('en'), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const none = createSiteFacts({ dir: path.join(os.tmpdir(), 'bona-facts-does-not-exist') });
  assert.equal(none.ok(), false);
});
