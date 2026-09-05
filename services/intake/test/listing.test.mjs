import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildListing, checkListing, nextListingId, orderedPicks, readIndex, slugify,
  takenSlugs, todayRiyadh, uniqueSlug, writeIndex, writeInboxListing, findInbox, listInbox,
} from '../lib/listing.mjs';
import * as edits from '../lib/edits.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const AI = {
  reject: false,
  confidence: 0.8,
  warnings: ['check the floor'],
  listing: {
    title: { en: 'Five-Bedroom Villa, Al Khalidiyah', ar: 'فيلا بخمس غرف نوم، الخالدية' },
    type: 'villa',
    category: 'buy',
    location: {
      district: { en: 'Al Khalidiyah', ar: 'الخالدية' },
      city: { en: 'Jeddah', ar: 'جدة' },
      country: { en: 'Saudi Arabia', ar: 'المملكة العربية السعودية' },
      countryCode: 'SA',
    },
    price: { amount: 4500000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 5, baths: 6, areaSqm: 537, plotSqm: null, yearBuilt: null, floors: null },
    description: { en: ['One.', 'Two.'], ar: ['واحد.', 'اثنان.'] },
    highlights: { en: ['Private pool', 'Roof terrace', 'Covered parking', 'Smart home'], ar: ['مسبح خاص', 'تراس علوي', 'مواقف مغطاة', 'منزل ذكي'] },
    project: null,
    unit: null,
  },
  images: [
    { index: 4, room: 'pool', rank: 1, hero: true, exclude: false, reason: 'wide pool' },
    { index: 1, room: 'living', rank: 2, hero: false, exclude: false, reason: 'main living' },
    { index: 7, room: 'kitchen', rank: 3, hero: false, exclude: false, reason: 'kitchen' },
    { index: 2, room: 'master', rank: 4, hero: false, exclude: false, reason: 'master' },
    { index: 0, room: 'render', rank: null, hero: false, exclude: true, reason: 'floor plan' },
  ],
};

const imagesFor = (slug, picks) => picks.map((p) => ({
  n: p.rank, index: p.index, room: p.room, reason: p.reason,
  src: `/listings/${slug}/${String(p.rank).padStart(2, '0')}.jpg`,
  thumb: `/listings/${slug}/${String(p.rank).padStart(2, '0')}-thumb.webp`,
}));

describe('slugify / uniqueSlug', () => {
  it('makes a URL-safe English slug', () => {
    assert.equal(slugify('Five-Bedroom Villa, Al Khalidiyah'), 'five-bedroom-villa-al-khalidiyah');
    assert.equal(slugify("Villa d'Été — Côte d'Azur"), 'villa-dete-cote-dazur');
    assert.equal(slugify('  Multiple   spaces  '), 'multiple-spaces');
  });
  it('returns empty for pure Arabic so the caller can fall back', () => {
    assert.equal(slugify('فيلا في الخالدية'), '');
  });
  it('never collides with a section route', () => {
    assert.equal(uniqueSlug('houses', new Set()), 'houses-property');
  });
  it('appends a counter on collision', () => {
    const taken = new Set(['villa', 'villa-2']);
    assert.equal(uniqueSlug('villa', taken), 'villa-3');
    assert.equal(uniqueSlug('villa', new Set()), 'villa');
  });
  it('knows the slugs already in the repo', () => {
    const taken = takenSlugs(REPO);
    assert.ok(taken.size > 20, 'should see the curated listings');
  });
});

describe('nextListingId', () => {
  it('formats BONA-W###', () => {
    assert.equal(nextListingId({ nextSeq: 1 }), 'BONA-W001');
    assert.equal(nextListingId({ nextSeq: 42 }), 'BONA-W042');
    assert.equal(nextListingId({}), 'BONA-W001');
  });
});

describe('orderedPicks', () => {
  it('drops excluded images and renumbers by rank', () => {
    const picks = orderedPicks(AI.images);
    assert.deepEqual(picks.map((p) => p.index), [4, 1, 7, 2]);
    assert.deepEqual(picks.map((p) => p.rank), [1, 2, 3, 4]);
  });
  it('caps at maxImages', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ index: i, room: 'view', rank: i + 1, exclude: false }));
    assert.equal(orderedPicks(many, { maxImages: 10 }).length, 10);
  });
  it('falls back to a known room key', () => {
    const picks = orderedPicks([{ index: 0, room: 'not-a-room', rank: 1, exclude: false }]);
    assert.equal(picks[0].room, 'view');
  });
});

describe('buildListing', () => {
  const slug = 'five-bedroom-villa-al-khalidiyah';
  const picks = orderedPicks(AI.images);
  const base = () => buildListing({
    ai: structuredClone(AI), images: imagesFor(slug, picks), slug, id: 'BONA-W007',
    repo: REPO, caption: {}, site: 'https://bona.azoz.uk',
    meta: { sourceRef: 'WA-20260906-ABC123', messageId: 'ABC123', pdfSha256: 'deadbeef' },
  });

  it('produces a listing that passes the local checks', () => {
    assert.deepEqual(checkListing(base()), []);
  });

  it('derives kind from type and never features itself', () => {
    const l = base();
    assert.equal(l.kind, 'house');
    assert.equal(l.featured, false);
    assert.equal(l.status, 'available');
  });

  it('writes bilingual alt text from the room key', () => {
    const l = base();
    assert.equal(l.images[0].alt.en, 'Swimming pool — Five-Bedroom Villa, Al Khalidiyah');
    assert.match(l.images[0].alt.ar, /المسبح/);
  });

  it('marks a developer unit\'s photos as illustrative', () => {
    const ai = structuredClone(AI);
    ai.listing.project = { name: { en: 'Kian Residence', ar: 'كيان رزيدنس' }, developer: { en: 'Kian', ar: 'كيان' } };
    ai.listing.unit = { floor: '1st', block: 'K', unitRef: null };
    const l = buildListing({ ai, images: imagesFor(slug, picks), slug, id: 'BONA-W008', repo: REPO, caption: {}, meta: {} });
    assert.match(l.images[0].alt.en, /^Illustrative — developer's finished unit at Kian Residence/);
    assert.match(l.images[0].alt.ar, /صورة توضيحية/);
  });

  it('lets the caption override the price and the category', () => {
    const l = buildListing({
      ai: structuredClone(AI), images: imagesFor(slug, picks), slug, id: 'BONA-W009', repo: REPO,
      caption: { price: { amount: 300000, currency: 'SAR' }, category: 'rent', period: 'year' }, meta: {},
    });
    assert.equal(l.price.amount, 300000);
    assert.equal(l.price.onRequest, false);
    assert.equal(l.category, 'rent');
    assert.equal(l.price.period, 'year');
  });

  it('keeps price.period null outside rentals', () => {
    const ai = structuredClone(AI);
    ai.listing.price.period = 'year';
    assert.equal(buildListing({ ai, images: imagesFor(slug, picks), slug, id: 'BONA-W010', repo: REPO, caption: {}, meta: {} }).price.period, null);
  });

  it('carries provenance in _intake and the hidden flag at the top level', () => {
    const l = buildListing({
      ai: structuredClone(AI), images: imagesFor(slug, picks), slug, id: 'BONA-W011', repo: REPO,
      caption: { text: 'rent #hidden' }, meta: { hidden: true, messageId: 'MSG1', pdfSha256: 'abc', model: 'sonnet' },
    });
    assert.equal(l.hidden, true);
    assert.equal(l._intake.source, 'whatsapp');
    assert.equal(l._intake.messageId, 'MSG1');
    assert.equal(l._intake.model, 'sonnet');
    assert.deepEqual(l._intake.warnings, ['check the floor']);
    assert.equal(l._intake.images.length, 4);
  });

  it('dates the listing in Riyadh', () => {
    assert.match(todayRiyadh(new Date('2026-09-05T22:30:00Z')), /^2026-09-06$/);
    assert.equal(base().listedAt, todayRiyadh());
  });
});

describe('checkListing — mirrors scripts/curate/validate.mjs', () => {
  const slug = 'five-bedroom-villa-al-khalidiyah';
  const picks = orderedPicks(AI.images);
  const make = (mutate) => {
    const l = buildListing({ ai: structuredClone(AI), images: imagesFor(slug, picks), slug, id: 'BONA-W007', repo: REPO, caption: {}, meta: {} });
    mutate?.(l);
    return l;
  };

  it('refuses fewer than 4 photos with a message the owner can read', () => {
    const problems = checkListing(make((l) => { l.images = l.images.slice(0, 2); }));
    assert.match(problems[0], /not enough usable photos \(2 of 4 needed\)/);
  });
  it('refuses a bad id', () => {
    assert.ok(checkListing(make((l) => { l.id = 'BONA-001'; })).some((p) => /BONA-W###/.test(p)));
  });
  it('refuses a remote image src', () => {
    assert.ok(checkListing(make((l) => { l.images[0].src = 'https://tk-storage.azoz.uk/x/y.jpg'; })).some((p) => /images\[0\].src/.test(p)));
  });
  it('refuses a priced listing with no amount', () => {
    assert.ok(checkListing(make((l) => { l.price = { amount: null, currency: 'SAR', from: false, period: null, onRequest: false }; })).some((p) => /onRequest/.test(p)));
  });
  it('accepts price on request with no amount', () => {
    assert.deepEqual(checkListing(make((l) => { l.price = { amount: null, currency: 'SAR', from: false, period: null, onRequest: true }; })), []);
  });
  it('refuses a one-paragraph description', () => {
    assert.ok(checkListing(make((l) => { l.description.en = 'One paragraph only.'; })).some((p) => /2 paragraphs/.test(p)));
  });
});

describe('inbox + edits', () => {
  let tmp;
  const slug = 'tmp-villa-test';
  const listing = () => ({
    id: 'BONA-W001', slug, status: 'available', hidden: false,
    title: { en: 'Temp Villa', ar: 'فيلا مؤقتة' },
    price: { amount: 1000000, currency: 'SAR', from: false, period: null, onRequest: false },
    images: [1, 2, 3, 4].map((n) => ({ src: `/listings/${slug}/0${n}.jpg`, thumb: null, alt: { en: 'x', ar: 'س' } })),
    _intake: { images: [1, 2, 3, 4].map((n) => ({ n, room: 'view' })) },
  });

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-inbox-'));
    fs.mkdirSync(path.join(tmp, 'scripts', 'curate', 'inbox'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'public', 'listings', slug), { recursive: true });
    for (const n of [1, 2, 3, 4]) fs.writeFileSync(path.join(tmp, 'public', 'listings', slug, `0${n}.jpg`), 'x');
    writeInboxListing(tmp, listing());
    writeIndex(tmp, { nextSeq: 2, listings: { [slug]: 'BONA-W001' } });
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('reads the index back', () => {
    assert.equal(readIndex(tmp).nextSeq, 2);
    assert.equal(nextListingId(readIndex(tmp)), 'BONA-W002');
  });

  it('lists and finds by id, case-insensitively', () => {
    assert.equal(listInbox(tmp).length, 1);
    assert.equal(findInbox(tmp, 'bona-w001').listing.slug, slug);
    assert.equal(findInbox(tmp, 'BONA-W999'), null);
  });

  it('hero moves the nth photo to the front', () => {
    const res = edits.setHero(tmp, 'BONA-W001', 3);
    assert.equal(res.listing.images[0].src, `/listings/${slug}/03.jpg`);
    assert.equal(res.listing.images[1].src, `/listings/${slug}/01.jpg`);
    assert.equal(res.listing._intake.images[0].n, 3);
    edits.setHero(tmp, 'BONA-W001', 2); // put 01 back in front
    assert.equal(findInbox(tmp, 'BONA-W001').listing.images[0].src, `/listings/${slug}/01.jpg`);
  });

  it('hero refuses a photo number that does not exist', () => {
    assert.match(edits.setHero(tmp, 'BONA-W001', 9).error, /does not exist/);
    assert.equal(edits.setHero(tmp, 'BONA-W404', 1), null);
  });

  it('price sets an amount or on-request', () => {
    assert.equal(edits.setPrice(tmp, 'BONA-W001', { amount: 2500000, currency: 'SAR' }).listing.price.amount, 2500000);
    const onReq = edits.setPrice(tmp, 'BONA-W001', { onRequest: true }).listing.price;
    assert.equal(onReq.onRequest, true);
    assert.equal(onReq.amount, null);
  });

  it('status and hidden are persisted', () => {
    assert.equal(edits.setStatus(tmp, 'BONA-W001', 'sold').listing.status, 'sold');
    assert.match(edits.setStatus(tmp, 'BONA-W001', 'nonsense').error, /unknown status/);
    assert.equal(edits.setHidden(tmp, 'BONA-W001', true).listing.hidden, true);
    assert.equal(findInbox(tmp, 'BONA-W001').listing.hidden, true);
  });

  it('remove deletes the JSON and the images', () => {
    const removed = edits.removeListing(tmp, 'BONA-W001');
    assert.equal(removed.slug, slug);
    assert.equal(listInbox(tmp).length, 0);
    assert.equal(fs.existsSync(path.join(tmp, 'public', 'listings', slug)), false);
    assert.equal(edits.removeListing(tmp, 'BONA-W001'), null);
  });
});
