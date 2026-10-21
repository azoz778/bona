// Fixes from the Claude + Codex review of the padding / W010 / plot-card branch (2026-10-21).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { policyRules, eligibility, sha256, fingerprint, advertiserFingerprint, reviewedCopy, captionFor, mediaBase, chooseProperty, familyOf,
  CARD_NOTE, CARD_NOTE_TEXT, PAD_FIT, MEDIA_SIZE } from '../social/lib/property-daily.mjs';
import { buildCardReview } from '../social/lib/property-review.mjs';
import { numbersIn, landFacts, landFactsProblems, cardSet } from '../social/lib/property-cards.mjs';
import { segmentFilter } from '../social/lib/reel-motion.mjs';
import { padFrame } from '../social/lib/property-media.mjs';
import { propertyDaily, photos, MEDIA_FALLBACK_CANDIDATES } from '../social/property-publish.mjs';
import { main as draft } from '../social/draft-property-reviews.mjs';
import { main as approve } from '../social/approve-property-review.mjs';
import { run as browserRun } from '../social/browser-publish.mjs';

const SITE = 'https://bona-real-estate.com';
const now = new Date('2026-10-21T17:30:00Z'); // 20:30 Riyadh
const POLICY = { version: 1, mode: 'property-photography', time: '20:30', timezone: 'Asia/Riyadh', repeatDays: 14, catalogueUrl: `${SITE}/social-catalogue.json`, channels: ['instagram', 'facebook'], adLicence: { requirement: 'waived', by: 'owner', on: '2026-10-05' }, countries: ['SA'], categories: ['buy', 'rent', 'off-plan'], renders: 'off-plan-only', cards: 'land-only', reviewValidDays: 90 };
const RULES = policyRules(POLICY, now);
const advertiser = { name: { ar: 'المعلن التجريبي', en: 'Fixture advertiser' }, fal: '1100000000', phone: '+966500000000' };
const quiet = () => {};
const jpeg = (w, h, bg) => sharp({ create: { width: w, height: h, channels: 3, background: bg } }).jpeg({ quality: 95 }).toBuffer();
function plot(extra = {}, highlights = null) {
  return { id: 'BONA-L1', slug: 'plot-l1', status: 'available', category: 'buy', type: 'land',
    title: { en: 'Residential Plot 285, Al Shati', ar: 'قطعة أرض رقم 285، الشاطئ' },
    location: { district: { en: 'Al Shati', ar: 'الشاطئ' }, city: { en: 'Jeddah', ar: 'جدة' }, country: { en: 'Saudi Arabia', ar: 'المملكة العربية السعودية' }, countryCode: 'SA' },
    price: { amount: 3816000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: 636, yearBuilt: null, floors: null },
    highlights: highlights ?? { en: ['636 sqm', 'North-facing, 21.25 m frontage', '16-metre street', 'SAR 6,000 per sqm net', 'Direct from the owner'],
      ar: ['636 متراً مربعاً', 'واجهة شمالية بطول 21.25 متراً', 'شارع بعرض 16 متراً', '6,000 ريال للمتر صافياً', 'من المالك مباشرة'] },
    images: [{ src: '/land/L1.jpg', thumb: null, alt: { en: 'Satellite view of the plot', ar: 'صورة جوية للقطعة' } },
      { src: '/land/L1-z15.jpg', thumb: null, alt: { en: 'Satellite view of the area', ar: 'صورة جوية للمنطقة' } }], licence: null, ...extra };
}
const hl = (en, ar) => ({ en: ['636 sqm', ...en], ar: ['636 متراً مربعاً', ...ar] });

// ---------------------------------------------------------------- 1. bilingual numbers, parseable highlights
test('fix 1: Arabic-Indic digits and Arabic separators read as numbers; Arabic and English numbers must agree', () => {
  assert.deepEqual(numbersIn('٢١٫٢٥ متراً و ٦٬٠٠٠ ريال'), [21.25, 6000]);
  assert.deepEqual(numbersIn('SAR 6,000 per sqm, 21.25 m'), [21.25, 6000]);
  assert.deepEqual(landFactsProblems(plot({}, hl(['North-facing, 21.25 m frontage'], ['واجهة شمالية بطول ٢١٫٢٥ متراً']))), [], 'Arabic-Indic digits are the same numbers');
  assert.ok(landFactsProblems(plot({}, hl(['North-facing, 21.25 m frontage'], ['واجهة شمالية بطول 21.5 متراً']))).includes('arabic_and_english_numbers_differ'));
  assert.ok(landFactsProblems(plot({ title: { en: 'Residential Plot 285, Al Shati', ar: 'قطعة أرض رقم 258، الشاطئ' } })).includes('arabic_and_english_numbers_differ'), 'the title too');
});
test('fix 1: a numeric highlight the card cannot read refuses the set; common unit forms are read and checked', () => {
  assert.ok(landFactsProblems(plot({}, hl(['Block 7 of the scheme'], ['المربع 7 من المخطط']))).includes('highlight_unparseable'));
  assert.deepEqual(landFactsProblems(plot({}, hl(['SAR 6,000/m²'], ['6,000 ريال للمتر']))), [], 'SAR x/m² is a price per square metre');
  assert.ok(landFactsProblems(plot({}, hl(['SAR 7,000/m²'], ['7,000 ريال للمتر']))).includes('price_per_sqm_contradicts_price'));
  assert.ok(landFactsProblems(plot({}, hl(['SAR 7,000 per square metre'], ['7,000 ريال للمتر المربع']))).includes('price_per_sqm_contradicts_price'));
  assert.ok(landFactsProblems(plot({}, hl(['640 m²'], ['640 م²']))).includes('area_contradicts_highlights'));
  assert.ok(landFactsProblems(plot({}, hl(['SAR 3,900,000'], ['3,900,000 ريال']))).includes('total_price_contradicts_price'), 'a total price that is not the listing price');
  assert.ok(landFactsProblems(plot({}, hl(['30 m by 30 m'], ['30 في 30 متراً']))).includes('dimensions_contradict_area'));
  assert.deepEqual(landFactsProblems(plot({}, hl(['24 m by 26.5 m'], ['24 في 26.5 متراً']))), [], 'dimensions within 2% of the area');
});

// ---------------------------------------------------------------- 2 + 7. price qualifications on the facts card
test('fix 2: the facts card states the price exactly as qualified: from-price, rental period, on request, per plot', () => {
  const from = landFacts(plot({ price: { amount: 3816000, currency: 'SAR', from: true, period: null, onRequest: false } }));
  assert.equal(from.price.en, 'From SAR 3,816,000');
  assert.match(from.price.ar, /^ابتداءً من .*3,816,000.* ريال$/);
  const rent = plot({ category: 'rent', price: { amount: 250000, currency: 'SAR', from: false, period: 'year', onRequest: false } }, { en: ['636 sqm'], ar: ['636 متراً مربعاً'] });
  assert.deepEqual([landFacts(rent).price.label.en, landFacts(rent).price.en], ['Rent', 'SAR 250,000 / year']);
  assert.match(landFacts(rent).price.ar, /ريال سنوياً$/);
  assert.equal(landFacts(rent).deal.en, 'LAND FOR RENT');
  assert.ok(landFactsProblems({ ...rent, price: { ...rent.price, period: 'weekly' } }).includes('unsupported_price_shape'));
  const ask = plot({ price: { amount: 3816000, currency: 'SAR', from: false, period: null, onRequest: true } }, { en: ['636 sqm', 'North-facing'], ar: ['636 متراً مربعاً', 'واجهة شمالية'] });
  assert.equal(landFacts(ask).price, null, 'price on request: no price line');
  assert.deepEqual(landFactsProblems(ask), []);
  assert.ok(landFactsProblems({ ...ask, highlights: hl(['SAR 3,816,000'], ['3,816,000 ريال']) }).includes('total_price_contradicts_price'), 'a price highlight on a price-on-request listing');
});
test('fix 7: a listing priced per plot says "per plot" on the price label, and the row is not repeated', () => {
  const p = plot({ title: { en: 'Plots of 300 sqm, Al Khalidiyah', ar: 'قطع أراضٍ بمساحة 300 متر مربع، الخالدية' }, price: { amount: 2150000, currency: 'SAR', from: false, period: null, onRequest: false }, specs: { plotSqm: 300 } },
    { en: ['300 sqm per plot', 'Twelve plots, ten remaining', 'SAR 2,150,000 per plot', 'About SAR 7,167 per sqm'], ar: ['300 متر مربع للقطعة', 'اثنتا عشرة قطعة، تبقّت عشر', '2,150,000 ريال سعودي للقطعة', 'نحو 7,167 ريالاً للمتر المربع'] });
  assert.deepEqual(landFactsProblems(p), []);
  const f = landFacts(p);
  assert.deepEqual(f.price.label, { ar: 'السعر للقطعة', en: 'Asking price per plot' });
  assert.ok(!f.rows.some(r => r.en === 'SAR 2,150,000 per plot'));
});

// ---------------------------------------------------------------- 3. no Ken Burns on padded frames
test('fix 3: a padded reel segment has no zoom and no pan; a cover segment keeps its move; make-reel passes --fit pad through', () => {
  const pad = segmentFilter({ W: 1080, H: 1920, SS: 2, FPS: 30, index: 2, frames: 100, still: true });
  assert.match(pad, /zoompan=z='1':x='0':y='0':d=1:s=1080x1920/);
  const cover = segmentFilter({ W: 1080, H: 1920, SS: 2, FPS: 30, index: 2, frames: 100, still: false });
  assert.match(cover, /zoompan=z='min\(1\.1600/);
  const src = fs.readFileSync(new URL('../social/make-reel.mjs', import.meta.url), 'utf8');
  assert.match(src, /segmentFilter\(\{[^}]*still: pad \}\)/);
  assert.doesNotMatch(src, /kenBurns\(/, 'make-reel builds no motion of its own');
});

// ---------------------------------------------------------------- 4. no mixed card + photo sets
test('fix 4: a set is all plot cards or none, at eligibility and at approval', () => {
  const p = plot();
  const card = k => ({ url: `${mediaBase(p.id)}${k}.jpg`, sha256: sha256(k), width: 1080, height: 1350, kind: 'card', card: k,
    source: k === 'facts' ? null : { url: SITE + p.images[0].src, sha256: sha256('s'), width: 1024, height: 768 }, visuallyApproved: true, alt: { ar: 'ب', en: 'c' } });
  const r = buildCardReview(p, advertiser, ['satellite', 'facts', 'location'].map(card), { reviewedAt: '2026-10-20T09:00:00Z', reviewer: 'x' });
  assert.deepEqual(eligibility(p, r, advertiser, now, RULES), []);
  r.photos[1] = { url: SITE + p.images[1].src, sha256: sha256('p'), width: 1080, height: 1350, kind: 'photograph', visuallyApproved: true, alt: { ar: 'ص', en: 'p' } };
  assert.ok(eligibility(p, r, advertiser, now, RULES).includes('mixed_cards_and_photos'));
  assert.throws(() => buildCardReview(p, advertiser, [{ url: 'x' }], { reviewedAt: 'x', reviewer: 'y' }), /plot cards only/);
});

// ---------------------------------------------------------------- 5. media fallback before intent
function listing(id, extra = {}) {
  return { id, slug: id.toLowerCase(), status: 'available', category: 'buy', type: 'apartment',
    location: { countryCode: 'SA', district: { ar: 'الروضة', en: 'Al Rawdah' }, city: { ar: 'جدة', en: 'Jeddah' } },
    title: { ar: `شقة ${id}`, en: `Apartment ${id}` }, price: { amount: 1000000, currency: 'SAR', from: false, onRequest: false }, specs: { beds: 3 },
    images: [1, 2, 3].map(i => ({ src: `/listings/${id.toLowerCase()}/${i}.jpg`, alt: { ar: 'صورة', en: 'Photo' } })), licence: null, ...extra };
}
async function world() {
  const A = listing('BONA-A1'), B = listing('BONA-B1'), C = listing('BONA-C1');
  const bytes = {}, reviews = {};
  let k = 0;
  for (const p of [A, B, C]) for (const im of p.images) { k++; bytes[SITE + im.src] = await jpeg(1920, 1280, { r: 20 * k, g: 200 - 10 * k, b: 7 * k }); }
  const pads = {};
  for (const p of [A, B, C]) {
    const padded = p.id === 'BONA-A1';
    const photosR = await Promise.all(p.images.map(async (im, i) => {
      const src = SITE + im.src, ph = { url: src, sha256: sha256(bytes[src]), width: 1920, height: 1280, kind: 'photograph', visuallyApproved: true, alt: im.alt };
      if (padded) { const b = await padFrame(bytes[src]); const u = `${mediaBase(p.id)}pad-${i}.jpg`; pads[u] = b; Object.assign(ph, { fit: PAD_FIT, media: { url: u, sha256: sha256(b), ...MEDIA_SIZE } }); }
      return ph;
    }));
    const r = { status: 'approved', reviewedAt: '2026-10-20T09:00:00Z', reviewer: 'x', factsSha256: fingerprint(p), advertiserSha256: advertiserFingerprint(advertiser),
      captionSha256: null, licenceEvidence: null, legalDisclosuresVerified: true, legalDisclosures: { ar: 'إفصاح', en: 'Disclosure' }, photos: photosR };
    r.captionSha256 = sha256(JSON.stringify(reviewedCopy(p, advertiser, r)));
    reviews[p.id] = r;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-fallback-'));
  fs.mkdirSync(path.join(root, 'marketing/daily'), { recursive: true });
  fs.writeFileSync(path.join(root, 'marketing/daily/property-policy.json'), JSON.stringify(POLICY));
  fs.writeFileSync(path.join(root, 'marketing/daily/property-reviews.json'), JSON.stringify(reviews));
  fs.writeFileSync(path.join(root, 'marketing/daily/content.json'), '[]');
  const served = { ...bytes, ...pads }, missing = new Set(), seen = [];
  const fetchImpl = async url => {
    const u = new URL(url);
    if (u.pathname === '/social-catalogue.json') return Response.json({ version: 1, generatedAt: '2026-10-21T06:00:00Z', advertiser, listings: [A, B, C] });
    if (u.hostname === 'graph.facebook.com') return Response.json(u.pathname.endsWith('content_publishing_limit') ? { data: [{ quota_usage: 0, config: { quota_total: 100 } }] } : { id: '17841427688957180', username: 'bonarealestatesa' });
    seen.push(url);
    if (missing.has(url) || !served[url]) return new Response('missing', { status: 404 });
    return new Response(served[url], { headers: { 'content-type': 'image/jpeg' } });
  };
  const env = { BONA_DATA: path.join(root, 'data'), META_ACCESS_TOKEN: 'not-a-real-token', IG_BUSINESS_ID: '17841427688957180' };
  return { root, env, fetchImpl, served, missing, seen, reviews, A, B, C, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
test('fix 5: Instagram/Facebook: a 404 on a padded file before intent moves to the next candidate; nothing is recorded in a dry run', async () => {
  const w = await world();
  try {
    assert.equal((await propertyDaily('instagram', { dry: true, now, root: w.root, env: w.env, fetchImpl: w.fetchImpl })).entry.listingId, 'BONA-A1', 'A1 is first in the rotation');
    w.missing.add(w.reviews['BONA-A1'].photos[1].media.url);
    const r = await propertyDaily('instagram', { dry: true, now, root: w.root, env: w.env, fetchImpl: w.fetchImpl });
    assert.equal(r.status, 'ready');
    assert.equal(r.entry.listingId, 'BONA-B1', 'the next candidate is prepared');
    assert.equal(fs.existsSync(w.env.BONA_DATA), false, 'a dry run writes nothing');
    assert.equal(MEDIA_FALLBACK_CANDIDATES, 3);
  } finally { w.cleanup(); }
});
test('fix 5: changed source bytes (a re-cropped photo not yet deployed) move to the next candidate; three bad candidates stop the run before any record', async () => {
  const w = await world();
  try {
    w.served[w.reviews['BONA-A1'].photos[0].url] = await jpeg(1920, 1280, '#000000');
    assert.equal((await propertyDaily('instagram', { dry: true, now, root: w.root, env: w.env, fetchImpl: w.fetchImpl })).entry.listingId, 'BONA-B1');
    for (const id of ['BONA-B1', 'BONA-C1']) w.missing.add(w.reviews[id].photos[2].url);
    await assert.rejects(propertyDaily('instagram', { dry: true, now, root: w.root, env: w.env, fetchImpl: w.fetchImpl }), /No candidate's reviewed media is usable on instagram \(BONA-A1: .*changed since visual review.*BONA-B1: .*http 404.*BONA-C1/);
  } finally { w.cleanup(); }
});
test('fix 5: live run: the fallback is logged to alerts and happens before the intent record', async () => {
  const w = await world();
  try {
    w.missing.add(w.reviews['BONA-A1'].photos[0].media.url);
    // The live run stops at the legacy-timer gate, which comes after the media checks and before intent.
    await assert.rejects(propertyDaily('instagram', { dry: false, now, root: w.root, env: w.env, fetchImpl: w.fetchImpl, legacyTimersDisabled: () => false, clock: () => now }), /Legacy publisher must remain disabled/);
    const alerts = fs.readFileSync(path.join(w.env.BONA_DATA, 'daily/alerts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(alerts.map(a => [a.status, a.listingId]), [['media-fallback', 'BONA-A1']]);
    const journal = path.join(w.env.BONA_DATA, 'daily/property.jsonl');
    assert.ok(!fs.existsSync(journal) || !fs.readFileSync(journal, 'utf8').includes('"intent"'), 'no intent was recorded');
  } finally { w.cleanup(); }
});
test('fix 5: TikTok/LinkedIn: unusable media moves to the next candidate before anything is staged', async () => {
  const w = await world();
  try {
    w.missing.add(w.reviews['BONA-A1'].photos[0].media.url);
    const calls = [];
    const touch = f => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); return f; };
    const deps = { fal: '1100000000', fetchImpl: w.fetchImpl, catalogue: async () => ({ listings: [w.A, w.B, w.C], advertiser }), downloadReviewedPhotos: photos,
      media: { propertyReel: (l, fr, li, out) => { calls.push(l.id); return touch(out); }, linkedinPropertyImages: async (fr, d) => fr.map((_, i) => touch(path.join(d, `li-${i}.jpg`))) } };
    const at = new Date('2026-10-21T18:45:00Z');
    const r = await browserRun('tiktok', { renderOnly: true, env: { BONA_DATA: path.join(w.root, 'bdata') }, root: w.root, now: at, clock: () => at, log: quiet, kind: 'property' }, deps);
    assert.equal(r.status, 'rendered');
    assert.equal(r.choice.itemId, 'BONA-B1');
    assert.deepEqual(calls, ['BONA-B1'], 'the unusable listing was never rendered');
  } finally { w.cleanup(); }
});

// ---------------------------------------------------------------- 6. family spacing
test('fix 6: a family (shared images, or all plot cards) is not posted on consecutive days when another candidate exists', () => {
  const mk = (id, shas, card = false) => ({ photos: shas.map(s => ({ url: `${SITE}/x/${id}${s}.jpg`, sha256: sha256(s), kind: card ? 'card' : 'render' })) });
  const fam = familyOf({ 'BONA-W003': mk('a', ['m1', 'm2', 'x']), 'BONA-W004': mk('b', ['m1', 'm2', 'y']), 'BONA-W005': mk('c', ['m2', 'z']), 'BONA-001': mk('d', ['q']),
    'BONA-046': mk('e', ['l1'], true), 'BONA-047': mk('f', ['l2'], true) });
  assert.equal(fam.get('BONA-W004'), 'BONA-W003'); assert.equal(fam.get('BONA-W005'), 'BONA-W003');
  assert.equal(fam.get('BONA-047'), 'BONA-046'); assert.equal(fam.get('BONA-001'), 'BONA-001');
  return fam;
});
test('fix 6: the rotation skips a listing whose family went out on this channel yesterday, deterministically, unless it is the only candidate', async () => {
  const w = await world();
  try {
    const reviews = { ...w.reviews, 'BONA-X1': { photos: [{ sha256: w.reviews['BONA-A1'].photos[0].sha256, kind: 'render' }] } };
    const listings = [w.A, w.B, w.C];
    const yesterday = [{ channel: 'instagram', status: 'published', listingId: 'BONA-X1', at: '2026-10-20T17:31:00Z', id: 'x' }];
    const choose = (events, ls = listings, channel = 'instagram') => chooseProperty(ls, reviews, advertiser, events, channel, now, 14, RULES).listing?.id;
    assert.equal(choose([]), 'BONA-A1');
    assert.equal(choose(yesterday), 'BONA-B1', 'A1 shares an image with yesterday\'s post');
    assert.equal(choose(yesterday), 'BONA-B1', 'deterministic');
    assert.equal(choose(yesterday, [w.A]), 'BONA-A1', 'the only candidate still goes out');
    assert.equal(choose(yesterday, listings, 'facebook'), 'BONA-A1', 'per channel');
    assert.equal(choose([{ ...yesterday[0], at: '2026-10-19T17:31:00Z' }]), 'BONA-A1', 'two days ago is not consecutive');
  } finally { w.cleanup(); }
});

// ---------------------------------------------------------------- 8. satellite imagery optional
test('fix 8: policy satellite (default true); with false, satellite cards are refused and a facts + text-only location pair is a valid set', async () => {
  assert.equal(policyRules({}, now).satellite, true);
  assert.equal(RULES.satellite, true);
  assert.throws(() => policyRules({ ...POLICY, satellite: 'no' }, now), /satellite rule/);
  const repo = JSON.parse(fs.readFileSync(new URL('../../marketing/daily/property-policy.json', import.meta.url), 'utf8'));
  assert.equal(policyRules(repo, now).satellite, true, 'the repository keeps the satellite cards for now');
  const OFF = policyRules({ ...POLICY, satellite: false }, now);
  const p = plot(), still = await jpeg(1024, 768, '#556644');
  const st = i => ({ bytes: still, url: SITE + p.images[i].src, sha256: sha256(still), width: 1024, height: 768 });
  const host = set => set.map((c, i) => ({ ...c, url: `${mediaBase(p.id)}c${i}.jpg`, sha256: sha256(c.bytes), width: 1080, height: 1350 }));
  const withStills = buildCardReview(p, advertiser, host(await cardSet(p, { plot: st(0), area: st(1) })), { reviewedAt: '2026-10-20T09:00:00Z', reviewer: 'x' });
  assert.deepEqual(eligibility(p, withStills, advertiser, now, RULES), []);
  assert.ok(eligibility(p, withStills, advertiser, now, OFF).includes('satellite_imagery_off'), 'existing satellite sets stop under satellite: false');
  const pair = await cardSet(p, { satellite: false });
  assert.deepEqual(pair.map(c => [c.card, c.source]), [['facts', null], ['location', null]]);
  for (const c of pair) assert.deepEqual([(await sharp(c.bytes).metadata()).width, (await sharp(c.bytes).metadata()).height], [1080, 1350]);
  const text = buildCardReview(p, advertiser, host(pair), { reviewedAt: '2026-10-20T09:00:00Z', reviewer: 'x' });
  assert.deepEqual(eligibility(p, text, advertiser, now, OFF), [], 'a two-card text-only land set is allowed');
  const c = captionFor(p, advertiser, text);
  assert.ok(c.ar.includes(CARD_NOTE_TEXT.ar) && c.en.includes(CARD_NOTE_TEXT.en) && !c.en.includes(CARD_NOTE.en) && !/[Ss]atellite/.test(c.en));
  assert.ok(captionFor(p, advertiser, withStills).en.includes(CARD_NOTE.en), 'a satellite set keeps its caption (and captionSha256)');
});
test('fix 8: approve --cards under satellite: false renders the pair without stills; stills are refused, and required while satellite is true', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-sat-'));
  try {
    fs.mkdirSync(path.join(root, 'marketing/daily'), { recursive: true });
    fs.writeFileSync(path.join(root, 'marketing/daily/property-reviews.json'), '{}\n');
    const p = plot(), images = { '/land/L1.jpg': await jpeg(1024, 768, '#556644'), '/land/L1-z15.jpg': await jpeg(1024, 768, '#445566') };
    const fetchImpl = async url => { const u = new URL(url);
      if (u.pathname === '/social-catalogue.json') return Response.json({ version: 1, generatedAt: '2026-10-21T06:00:00Z', advertiser, listings: [p] });
      return images[u.pathname] ? new Response(images[u.pathname], { headers: { 'content-type': 'image/jpeg' } }) : new Response('x', { status: 404 }); };
    const run = async (policy, cards) => {
      fs.writeFileSync(path.join(root, 'marketing/daily/property-policy.json'), JSON.stringify(policy));
      const out = fs.mkdtempSync(path.join(root, 'd-')); fs.rmSync(out, { recursive: true });
      await draft(['--out', out], { fetchImpl, now, root, log: quiet });
      return approve(['--drafts', path.join(out, 'drafts.json'), '--reviewer', 'x', '--cards', cards], { fetchImpl, now, root, log: quiet });
    };
    assert.match((await run(POLICY, 'BONA-L1')).refused[0], /name the plot and area stills/);
    assert.match((await run({ ...POLICY, satellite: false }, 'BONA-L1:1,2')).refused[0], /policy satellite is false/);
    const ok = await run({ ...POLICY, satellite: false }, 'BONA-L1');
    assert.deepEqual([ok.written, ok.refused, ok.files.length], [1, [], 2]);
    const r = JSON.parse(fs.readFileSync(path.join(root, 'marketing/daily/property-reviews.json'), 'utf8'))['BONA-L1'];
    assert.deepEqual(r.photos.map(x => x.card), ['facts', 'location']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('fix 4: approval refuses --select and --cards for the same listing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-mixed-'));
  try {
    fs.mkdirSync(path.join(root, 'marketing/daily'), { recursive: true });
    fs.writeFileSync(path.join(root, 'marketing/daily/property-reviews.json'), '{}\n');
    fs.writeFileSync(path.join(root, 'marketing/daily/property-policy.json'), JSON.stringify(POLICY));
    const p = plot(), images = { '/land/L1.jpg': await jpeg(1024, 768, '#556644'), '/land/L1-z15.jpg': await jpeg(1024, 768, '#445566') };
    const fetchImpl = async url => { const u = new URL(url);
      if (u.pathname === '/social-catalogue.json') return Response.json({ version: 1, generatedAt: '2026-10-21T06:00:00Z', advertiser, listings: [p] });
      return images[u.pathname] ? new Response(images[u.pathname], { headers: { 'content-type': 'image/jpeg' } }) : new Response('x', { status: 404 }); };
    const out = path.join(root, 'd');
    await draft(['--out', out], { fetchImpl, now, root, log: quiet });
    const r = await approve(['--drafts', path.join(out, 'drafts.json'), '--reviewer', 'x', '--cards', 'BONA-L1:1,2', '--select', 'BONA-L1:1,2,3'], { fetchImpl, now, root, log: quiet });
    assert.equal(r.written, 0);
    assert.ok(r.refused.some(x => /a set is all cards or all photographs/.test(x)), r.refused.join(' | '));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- round 2
test('round 2, fix 1: Arabic-Indic digits are normalised before parsing, so an Arabic-digit rate is checked against the price', () => {
  assert.ok(landFactsProblems(plot({}, hl(['SAR ٧٬٠٠٠/m²'], ['٧٬٠٠٠ ريال للمتر']))).includes('price_per_sqm_contradicts_price'));
  assert.deepEqual(landFactsProblems(plot({}, hl(['SAR 6,000 per sqm net'], ['٦٬٠٠٠ ريال للمتر صافياً']))), [], 'the same rate in Arabic-Indic digits');
});
test('round 2, fix 1: the Arabic must state the same typed facts as the English, and an Arabic numeric highlight must be readable', () => {
  assert.ok(landFactsProblems(plot({}, hl(['SAR 6,000 per sqm'], ['6,000 ريال للقطعة']))).includes('arabic_and_english_facts_differ'), 'a rate is not a per-plot price');
  assert.ok(landFactsProblems(plot({}, hl(['16-metre street'], ['شارع رقم 16']))).includes('highlight_unparseable'), 'Arabic states a number the card cannot type');
  assert.ok(landFactsProblems(plot({}, hl(['636 sqm plot'], ['شارع بعرض 636 متراً']))).includes('arabic_and_english_facts_differ'), 'an area is not a length');
  assert.deepEqual(landFactsProblems(plot({}, hl(['24 m by 26.5 m'], ['24 في 26.5 متراً']))), []);
});
test('round 3: a price per linear metre is never read as a price per square metre (Codex)', () => {
  assert.ok(landFactsProblems(plot({}, hl(['SAR 6,000 per sqm'], ['٦٬٠٠٠ ريال للمتر الطولي']))).includes('highlight_unparseable'), 'Arabic per linear metre');
  assert.ok(landFactsProblems(plot({}, hl(['SAR 6,000 per linear metre'], ['6,000 ريال للمتر']))).includes('highlight_unparseable'), 'English per linear metre');
  assert.deepEqual(landFactsProblems(plot({}, hl(['North-facing, 21.25 m frontage'], ['واجهة شمالية بطول 21.25 متراً']))), [], 'a length (بطول) is still fine');
});
test('round 2, fix 2: a transient network error is retried; the same listing goes out and no fallback is alerted', async () => {
  const w = await world();
  try {
    const url = w.reviews['BONA-A1'].photos[0].url;
    let resets = 0;
    const flaky = async (u, o) => { if (u === url && resets++ === 0) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); return w.fetchImpl(u, o); };
    await assert.rejects(propertyDaily('instagram', { dry: false, now, root: w.root, env: w.env, fetchImpl: flaky, legacyTimersDisabled: () => false, clock: () => now }), /Legacy publisher must remain disabled/);
    assert.equal(resets, 2, 'reset once, then fetched again');
    assert.equal(fs.existsSync(path.join(w.env.BONA_DATA, 'daily/alerts.jsonl')), false, 'no fallback alert');
    resets = 0;
    assert.equal((await propertyDaily('instagram', { dry: true, now, root: w.root, env: w.env, fetchImpl: flaky })).entry.listingId, 'BONA-A1');
    // A 404 is final at once: no retry, straight to the next candidate.
    w.missing.add(url);
    w.seen.length = 0;
    assert.equal((await propertyDaily('instagram', { dry: true, now, root: w.root, env: w.env, fetchImpl: w.fetchImpl })).entry.listingId, 'BONA-B1');
    assert.equal(w.seen.filter(u => u === url).length, 1);
  } finally { w.cleanup(); }
});
test('round 2, fix 3: a live browser run renders each candidate in its own directory and removes the failed one', async () => {
  const w = await world();
  try {
    w.missing.add(w.reviews['BONA-A1'].photos[0].media.url);
    const touch = f => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); return f; };
    const deps = { fal: '1100000000', fetchImpl: w.fetchImpl, catalogue: async () => ({ listings: [w.A, w.B, w.C], advertiser }), downloadReviewedPhotos: photos,
      media: { propertyReel: (l, fr, li, out) => touch(out), linkedinPropertyImages: async (fr, d) => fr.map((_, i) => touch(path.join(d, `li-${i}.jpg`))) } };
    const at = new Date('2026-10-21T18:45:00Z'), data = path.join(w.root, 'bdata');
    const r = await browserRun('tiktok', { renderOnly: true, dry: false, env: { BONA_DATA: data }, root: w.root, now: at, clock: () => at, log: quiet, kind: 'property' }, deps);
    assert.equal(r.choice.itemId, 'BONA-B1');
    const day = path.join(data, 'tiktok/assets/2026-10-21');
    assert.deepEqual(fs.readdirSync(day), ['BONA-B1'], 'only the candidate that rendered keeps a directory');
    assert.ok(r.files.every(f => f.startsWith(path.join(day, 'BONA-B1') + path.sep)));
  } finally { w.cleanup(); }
});
