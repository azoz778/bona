// Land plot cards (owner, 2026-10-21): a land listing posts a branded card set made from its
// public facts and its satellite stills, never presented as photographs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { policyRules, eligibility, sha256, fingerprint, advertiserFingerprint, reviewedCopy, captionFor, mediaBase, entryFor, CARD_NOTE, STRICT_RULES } from '../social/lib/property-daily.mjs';
import { buildCardReview } from '../social/lib/property-review.mjs';
import { landFacts, landFactsProblems, factsCard, satelliteCard, cardSet, cardStrings } from '../social/lib/property-cards.mjs';
import { photos } from '../social/property-publish.mjs';
import { main as draft } from '../social/draft-property-reviews.mjs';
import { main as approve } from '../social/approve-property-review.mjs';
import { run as browserRun, mediaStyle } from '../social/browser-publish.mjs';

const SITE = 'https://bona-real-estate.com';
const now = new Date('2026-10-21T10:00:00Z');
const POLICY = { version: 1, mode: 'property-photography', time: '20:30', timezone: 'Asia/Riyadh', repeatDays: 14, catalogueUrl: `${SITE}/social-catalogue.json`, channels: ['instagram', 'facebook'], adLicence: { requirement: 'waived', by: 'owner', on: '2026-10-05' }, countries: ['SA'], categories: ['buy', 'rent', 'off-plan'], renders: 'off-plan-only', cards: 'land-only', reviewValidDays: 90 };
const RULES = policyRules(POLICY, now);
const advertiser = { name: { ar: 'المعلن التجريبي', en: 'Fixture advertiser' }, fal: '1100000000', phone: '+966500000000' };
const quiet = () => {};
const jpeg = (width, height, background) => sharp({ create: { width, height, channels: 3, background } }).jpeg({ quality: 95 }).toBuffer();

/** BONA-046's public facts (live catalogue 2026-10-21) under a fixture id. */
function plot(extra = {}) {
  return { id: 'BONA-L1', slug: 'plot-l1', status: 'available', category: 'buy', type: 'land',
    title: { en: 'Residential Plot 285, Al Shati', ar: 'قطعة أرض رقم 285، الشاطئ' },
    location: { district: { en: 'Al Shati', ar: 'الشاطئ' }, city: { en: 'Jeddah', ar: 'جدة' }, country: { en: 'Saudi Arabia', ar: 'المملكة العربية السعودية' }, countryCode: 'SA' },
    price: { amount: 3816000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: 636, yearBuilt: null, floors: null },
    highlights: { en: ['636 sqm', 'North-facing, 21.25 m frontage', '16-metre street', 'SAR 6,000 per sqm net', 'Direct from the owner'],
      ar: ['636 متراً مربعاً', 'واجهة شمالية بطول 21.25 متراً', 'شارع بعرض 16 متراً', '6,000 ريال للمتر صافياً', 'من المالك مباشرة'] },
    images: [{ src: '/land/L1.jpg', thumb: null, alt: { en: 'Satellite view of the plot', ar: 'صورة جوية للقطعة' } },
      { src: '/land/L1-z15.jpg', thumb: null, alt: { en: 'Satellite view of the area', ar: 'صورة جوية للمنطقة' } }],
    licence: null, ...extra };
}
function cardReview(p, mutate = x => x) {
  const card = (kind, i) => mutate({ url: `${mediaBase(p.id)}card-${kind}-${i}.jpg`, sha256: sha256(kind), width: 1080, height: 1350, kind: 'card', card: kind,
    source: kind === 'facts' ? null : { url: SITE + p.images[kind === 'satellite' ? 0 : 1].src, sha256: sha256(`still${i}`), width: 1024, height: 768 },
    visuallyApproved: true, alt: { ar: 'بطاقة', en: 'Card' } }, kind);
  return buildCardReview(p, advertiser, ['satellite', 'facts', 'location'].map(card), { reviewedAt: '2026-10-20T09:00:00Z', reviewer: 'fixture' });
}

test('policy: cards default to none, "land-only" is the one other value, and the repository policy allows them for land', () => {
  assert.equal(STRICT_RULES.cards, 'none');
  assert.equal(policyRules({}, now).cards, 'none');
  assert.equal(RULES.cards, 'land-only');
  assert.throws(() => policyRules({ ...POLICY, cards: 'all' }, now), /cards rule/);
  const repo = JSON.parse(fs.readFileSync(new URL('../../marketing/daily/property-policy.json', import.meta.url), 'utf8'));
  assert.equal(policyRules(repo, now).cards, 'land-only');
});

test('eligibility: a land card set is eligible under land-only; never for other types or without the policy line', () => {
  const p = plot();
  assert.deepEqual(eligibility(p, cardReview(p), advertiser, now, RULES), []);
  assert.ok(eligibility(p, cardReview(p), advertiser, now, policyRules({ ...POLICY, cards: 'none' }, now)).includes('card_not_allowed'));
  const villa = plot({ type: 'villa' });
  assert.ok(eligibility(villa, { ...cardReview(p), factsSha256: fingerprint(villa) }, advertiser, now, RULES).includes('card_not_allowed'));
  assert.throws(() => buildCardReview(villa, advertiser, [], { reviewedAt: 'x', reviewer: 'y' }), /land listings only/);
});

test('eligibility: every card is this listing\'s hosted 1080x1350 JPEG, and a still-based card names a listing still', () => {
  const p = plot();
  const why = mutate => eligibility(p, cardReview(p, mutate), advertiser, now, RULES);
  assert.ok(why((c, k) => (k === 'facts' ? { ...c, url: `${mediaBase('BONA-X')}facts.jpg` } : c)).includes('card_media_unverified'), 'another listing\'s folder');
  assert.ok(why((c, k) => (k === 'facts' ? { ...c, height: 1080 } : c)).includes('card_media_unverified'));
  assert.ok(why((c, k) => (k === 'satellite' ? { ...c, source: null } : c)).includes('card_media_unverified'), 'satellite card without its still');
  assert.ok(why((c, k) => (k === 'location' ? { ...c, source: null } : c)).includes('card_media_unverified'), 'location card without its still');
  assert.ok(why((c, k) => (k === 'facts' ? { ...c, source: { url: SITE + p.images[0].src, sha256: sha256('x'), width: 1, height: 1 } } : c)).includes('card_media_unverified'));
  assert.ok(why((c, k) => (k === 'satellite' ? { ...c, source: { ...c.source, url: `${SITE}/land/OTHER.jpg` } } : c)).includes('card_media_unverified'), 'not one of this listing\'s images');
  assert.ok(why((c, k) => (k === 'facts' ? { ...c, card: 'photo' } : c)).includes('card_media_unverified'));
  const padded = cardReview(p); padded.photos[1].fit = 'pad-4x5';
  assert.ok(eligibility(p, padded, advertiser, now, RULES).includes('card_media_unverified'), 'a card is never also padded');
});

test('caption: a card set says what the images are and never calls them photographs; the Instagram entry posts the card URLs', () => {
  const p = plot(), r = cardReview(p), c = captionFor(p, advertiser, r);
  assert.ok(c.ar.includes(CARD_NOTE.ar) && c.en.includes(CARD_NOTE.en));
  assert.doesNotMatch(c.en, /photograph|artist's impression/i);
  assert.doesNotMatch(c.ar, /صور فوتوغرافية|تصاميم تصوّرية/);
  assert.match(c.en, /636 m² plot · SAR 3,816,000/);
  assert.match(c.ar, /تبحث عن أرض بهذه المواصفات؟/, 'a plot is not called a home');
  assert.doesNotMatch(c.ar, /منزل/);
  assert.deepEqual(entryFor(p, r, advertiser, 'instagram', '2026-10-21').images, r.photos.map(x => x.url));
});

test('land facts: only what the listing states; contradictions and gaps refuse the set', () => {
  const p = plot();
  assert.deepEqual(landFactsProblems(p), []);
  const f = landFacts(p);
  assert.equal(f.area.en, '636 m²');
  assert.equal(f.price.en, 'SAR 3,816,000');
  assert.deepEqual(f.rows.map(r => r.en), ['North-facing, 21.25 m frontage', '16-metre street', 'SAR 6,000 per sqm net', 'Direct from the owner'], 'the bare area line is the headline, not a row');
  const noPer = plot({ highlights: { en: ['636 sqm', 'Two 12-metre streets'], ar: ['636 متراً مربعاً', 'شارعان بعرض 12 متراً'] } });
  assert.ok(!cardStrings(noPer).some(x => /per sqm|للمتر/.test(x)), 'no price per square metre unless a highlight states it');
  const noPrice = plot({ price: { amount: null, currency: 'SAR', onRequest: true } });
  assert.equal(landFacts(noPrice).price, null, 'price on request: no price line');
  assert.deepEqual(landFactsProblems(plot({ specs: { plotSqm: null } })), ['no_plot_area']);
  assert.ok(landFactsProblems(plot({ specs: { plotSqm: 700 } })).includes('area_contradicts_highlights'));
  assert.ok(landFactsProblems(plot({ price: { ...p.price, amount: 4500000 } })).includes('price_per_sqm_contradicts_price'));
  assert.ok(landFactsProblems(plot({ highlights: { en: ['a', 'b'], ar: ['أ'] } })).includes('highlights_do_not_pair'));
  assert.ok(landFactsProblems(plot({ type: 'villa' })).includes('not_land'));
});

test('cards render at 1080x1350; a still is fitted whole and scaled down, never up; a contradictory listing gets no facts card', async () => {
  const p = plot();
  for (const b of [await factsCard(p), await satelliteCard(await jpeg(1024, 768, '#3366aa'), p), await satelliteCard(await jpeg(1024, 768, '#3366aa'), p, { variant: 'area' })]) {
    const m = await sharp(b).metadata();
    assert.deepEqual([m.format, m.width, m.height], ['jpeg', 1080, 1350]);
  }
  // A 640x480 still stays 640 wide (no upscale): blue spans 640 px of the 1080 row through its middle.
  const small = await sharp(await satelliteCard(await jpeg(640, 480, '#0000ff'), p)).raw().toBuffer({ resolveWithObject: true });
  const row = 150 + 240, blue = [...Array(1080).keys()].filter(x => { const o = (row * 1080 + x) * 3; return small.data[o + 2] > 200 && small.data[o] < 60; }).length;
  assert.ok(blue >= 636 && blue <= 644, `still kept at its own width (${blue})`);
  await assert.rejects(factsCard(plot({ specs: { plotSqm: 700 } })), /facts card refused \(area_contradicts_highlights/);
});

async function landWorld({ listing = plot() } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-cards-'));
  fs.mkdirSync(path.join(root, 'marketing/daily'), { recursive: true });
  fs.writeFileSync(path.join(root, 'marketing/daily/property-policy.json'), JSON.stringify(POLICY));
  fs.writeFileSync(path.join(root, 'marketing/daily/property-reviews.json'), '{}\n');
  const images = { '/land/L1.jpg': await jpeg(1024, 768, '#556644'), '/land/L1-z15.jpg': await jpeg(1024, 768, '#445566') };
  const state = { listing };
  const fetchImpl = async url => {
    const u = new URL(url);
    if (u.pathname === '/social-catalogue.json') return Response.json({ version: 1, generatedAt: '2026-10-21T06:00:00Z', advertiser, listings: [state.listing] });
    return images[u.pathname] ? new Response(images[u.pathname], { headers: { 'content-type': 'image/jpeg' } }) : new Response('missing', { status: 404 });
  };
  return { root, state, images, fetchImpl, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('draft lists a land listing\'s stills; approve --cards renders, hosts and approves the set; contradictory facts are refused', async () => {
  const w = await landWorld();
  try {
    const out = path.join(w.root, 'drafts');
    const d = await draft(['--out', out], { fetchImpl: w.fetchImpl, now, root: w.root, log: quiet });
    const L = d.listings['BONA-L1'];
    assert.equal(L.usable, 0, 'too small to post as photographs');
    assert.deepEqual(L.stills.map(s => [s.index, s.width, s.height]), [[1, 1024, 768], [2, 1024, 768]]);
    assert.ok(fs.existsSync(path.join(out, L.sheet)), 'the contact sheet shows the stills');
    const args = ['--drafts', path.join(out, 'drafts.json'), '--reviewer', 'fixture reviewer', '--cards', 'BONA-L1:1,2'];
    const r = await approve(args, { fetchImpl: w.fetchImpl, now, root: w.root, log: quiet });
    assert.deepEqual([r.written, r.refused], [1, []]);
    assert.equal(r.files.length, 3);
    const review = JSON.parse(fs.readFileSync(path.join(w.root, 'marketing/daily/property-reviews.json'), 'utf8'))['BONA-L1'];
    assert.deepEqual(review.photos.map(x => [x.kind, x.card]), [['card', 'satellite'], ['card', 'facts'], ['card', 'location']]);
    assert.deepEqual(review.photos.map(x => x.source?.sha256 ?? null), [sha256(w.images['/land/L1.jpg']), null, sha256(w.images['/land/L1-z15.jpg'])]);
    for (const x of review.photos) {
      assert.ok(x.url.startsWith(`${SITE}/social/property/BONA-L1/card-${x.card}-`));
      assert.equal(sha256(fs.readFileSync(path.join(w.root, 'public', new URL(x.url).pathname))), x.sha256);
    }
    assert.deepEqual(eligibility(w.state.listing, review, advertiser, now, RULES), []);
    assert.equal((await approve(args, { fetchImpl: w.fetchImpl, now, root: w.root, log: quiet })).unchanged, 1, 'deterministic');
    // Facts that contradict each other: drafted fresh, refused with the reason, nothing written.
    w.state.listing = plot({ price: { ...plot().price, amount: 4500000 } });
    const out2 = path.join(w.root, 'drafts2');
    await draft(['--out', out2, '--ids', 'BONA-L1'], { fetchImpl: w.fetchImpl, now, root: w.root, log: quiet });
    const bad = await approve(['--drafts', path.join(out2, 'drafts.json'), '--reviewer', 'x', '--cards', 'BONA-L1:1,2'], { fetchImpl: w.fetchImpl, now, root: w.root, log: quiet });
    assert.equal(bad.written, 0);
    assert.match(bad.refused[0], /no card set \(price_per_sqm_contradicts_price\)/);
  } finally { w.cleanup(); }
});

test('publisher download: a card is checked as itself and as the still it was made from', async () => {
  const p = plot(), still = await jpeg(1024, 768, '#556644');
  const set = await cardSet(p, { plot: { bytes: still, url: SITE + p.images[0].src, sha256: sha256(still), width: 1024, height: 768 },
    area: { bytes: still, url: SITE + p.images[1].src, sha256: sha256(still), width: 1024, height: 768 } });
  const cards = set.map((c, i) => ({ ...c, url: `${mediaBase(p.id)}c${i}.jpg`, sha256: sha256(c.bytes), width: 1080, height: 1350 }));
  const r = buildCardReview(p, advertiser, cards, { reviewedAt: '2026-10-20T09:00:00Z', reviewer: 'x' });
  const served = { [SITE + p.images[0].src]: still, [SITE + p.images[1].src]: still, ...Object.fromEntries(cards.map(c => [c.url, c.bytes])) };
  const seen = [];
  const fetchImpl = async url => { seen.push(url); return new Response(served[url], { headers: { 'content-type': 'image/jpeg' } }); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-cardget-'));
  const files = await photos(r, dir, false, fetchImpl);
  assert.deepEqual(seen, [cards[0].url, SITE + p.images[0].src, cards[1].url, cards[2].url, SITE + p.images[1].src]);
  assert.deepEqual(files.map(f => sha256(fs.readFileSync(f))), cards.map(c => c.sha256), 'the cards are what is posted');
  served[SITE + p.images[1].src] = await jpeg(1024, 768, '#000000');
  await assert.rejects(photos(r, dir, true, fetchImpl), /changed since visual review/, 'a changed still stops the run');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('TikTok and LinkedIn: plot cards go into the reel whole and still, with no hook or lower third, and to LinkedIn without a second mark', async () => {
  const p = plot(), still = await jpeg(1024, 768, '#556644');
  const set = await cardSet(p, { plot: { bytes: still, url: SITE + p.images[0].src, sha256: sha256(still), width: 1024, height: 768 },
    area: { bytes: still, url: SITE + p.images[1].src, sha256: sha256(still), width: 1024, height: 768 } });
  const cards = set.map((c, i) => ({ ...c, url: `${mediaBase(p.id)}c${i}.jpg`, sha256: sha256(c.bytes), width: 1080, height: 1350 }));
  const r = buildCardReview(p, advertiser, cards, { reviewedAt: '2026-10-20T09:00:00Z', reviewer: 'x' });
  assert.deepEqual(mediaStyle(r), { pad: true, cards: true });
  const served = { [SITE + p.images[0].src]: still, [SITE + p.images[1].src]: still, ...Object.fromEntries(cards.map(c => [c.url, c.bytes])) };
  const fetchImpl = async url => new Response(served[url], { headers: { 'content-type': 'image/jpeg' } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-cardrun-'));
  const root = path.join(dir, 'repo');
  fs.mkdirSync(path.join(root, 'marketing/daily'), { recursive: true });
  fs.writeFileSync(path.join(root, 'marketing/daily/property-policy.json'), JSON.stringify(POLICY));
  fs.writeFileSync(path.join(root, 'marketing/daily/property-reviews.json'), JSON.stringify({ [p.id]: r }));
  fs.writeFileSync(path.join(root, 'marketing/daily/content.json'), '[]');
  const calls = [];
  const touch = f => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); return f; };
  const deps = { fal: '1100000000', fetchImpl, catalogue: async () => ({ listings: [p], advertiser }), downloadReviewedPhotos: photos,
    media: {
      propertyReel: (l, frames, lines, out, opts) => { calls.push(['reel', frames.map(f => sha256(fs.readFileSync(f))), opts]); return touch(out); },
      linkedinPropertyImages: async (frames, d, opts) => { calls.push(['li', frames.map(f => sha256(fs.readFileSync(f))), opts]); return frames.map((_, i) => touch(path.join(d, `li-${i}.jpg`))); },
    } };
  const at = { tiktok: new Date('2026-10-21T18:45:00Z'), linkedin: new Date('2026-10-21T06:30:00Z') };
  for (const channel of ['tiktok', 'linkedin'])
    assert.equal((await browserRun(channel, { renderOnly: true, env: { BONA_DATA: path.join(dir, 'data') }, root, now: at[channel], clock: () => at[channel], log: quiet, kind: 'property' }, deps)).status, 'rendered');
  assert.deepEqual(calls[0], ['reel', cards.map(c => c.sha256), { fit: 'pad', plain: true }]);
  assert.deepEqual(calls[1], ['li', cards.map(c => c.sha256), { mark: false }]);
  fs.rmSync(dir, { recursive: true, force: true });
});
