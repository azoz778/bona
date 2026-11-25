import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildListing, checkListing, enrichHeadline, enrichMetaFor, ENRICH_KEYS, inboxIds, mergeEnrichment, nextListingId, orderedPicks,
  readIndex, replaceMetaFor, seqAfter, slugify, takenSlugs, todayRiyadh, uniqueSlug, writeIndex, writeInboxListing, findInbox,
  findByPdfSha, listInbox,
} from '../lib/listing.mjs';
import * as edits from '../lib/edits.mjs';
import { PLAN_JPEG_QUALITY, THUMB_QUALITY, writeFloorPlans } from '../lib/images.mjs';
import * as msg from '../lib/messages.mjs';
import { alignHeadline } from '../lib/model-prices.mjs';
import {
  headlineFollowsModels, isLocalSrc, licenceProblems, LOCAL_LISTING_SRC, LOCAL_PLAN_SRC, LOCAL_PLAN_THUMB, modelsProblems, WITHHELD_LISTINGS,
} from '../../../scripts/curate/rules.mjs';

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

  // Finding 13 — _index.json is a file in a repo other clones push to. A listing already in
  // the inbox with a higher number wins, so an id is never handed out twice.
  it('never reuses an id that is already in the inbox', () => {
    assert.equal(nextListingId({ nextSeq: 1 }, ['BONA-W001', 'BONA-W004', 'BONA-W002']), 'BONA-W005');
    assert.equal(nextListingId({ nextSeq: 3 }, ['BONA-W007']), 'BONA-W008');
    assert.equal(nextListingId({ nextSeq: 9 }, ['BONA-W004']), 'BONA-W009', 'a higher counter still wins');
  });

  it('ignores anything that is not an intake id', () => {
    assert.equal(nextListingId({ nextSeq: 1 }, ['BONA-004', null, undefined, 'nonsense']), 'BONA-W001');
  });

  it('stores the counter one past whatever was allocated', () => {
    assert.equal(seqAfter('BONA-W004'), 5);
    assert.equal(seqAfter('BONA-W0120'), 121);
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
  it('carries a valid focus point, rounded, and nothing else', () => {
    const picks = orderedPicks([
      { index: 0, room: 'exterior', rank: 1, exclude: false, focus: { x: 0.5, y: 0.8234 } },
      { index: 1, room: 'living', rank: 2, exclude: false, focus: { x: 2, y: 0.5 } },
      { index: 2, room: 'kitchen', rank: 3, exclude: false },
    ]);
    assert.deepEqual(picks.map((p) => p.focus), [{ x: 0.5, y: 0.82 }, null, null]);
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

  it('writes a photo\'s focus point, and leaves the key out when there is none', () => {
    const images = imagesFor(slug, picks).map((im, i) => (i === 0 ? { ...im, focus: { x: 0.5, y: 0.8 } } : im));
    const l = buildListing({ ai: structuredClone(AI), images, slug, id: 'BONA-W007', repo: REPO, caption: {}, meta: {} });
    assert.deepEqual(l.images[0].focus, { x: 0.5, y: 0.8 });
    assert.equal('focus' in l.images[1], false);
    assert.deepEqual(checkListing(l), []);
    l.images[1].focus = { x: -0.1, y: 0.5 };
    assert.ok(checkListing(l).some((p) => /images\[1\]\.focus/.test(p)));
  });

  it('keeps a subsidised price only under a published headline price', () => {
    const ai = structuredClone(AI);
    ai.listing.price = { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false, subsidisedAmount: 270425 };
    const l = buildListing({ ai, images: imagesFor(slug, picks), slug, id: 'BONA-W023', repo: REPO, caption: {}, meta: {} });
    assert.equal(l.price.subsidisedAmount, 270425);
    assert.deepEqual(checkListing(l), []);

    const onReq = structuredClone(AI);
    onReq.listing.price = { amount: null, currency: 'SAR', from: false, period: null, onRequest: true, subsidisedAmount: 270425 };
    assert.equal('subsidisedAmount' in buildListing({ ai: onReq, images: imagesFor(slug, picks), slug, id: 'BONA-W023', repo: REPO, caption: {}, meta: {} }).price, false);

    const owner = buildListing({ ai: structuredClone(ai), images: imagesFor(slug, picks), slug, id: 'BONA-W023', repo: REPO, caption: { price: { amount: 300000, currency: 'SAR' } }, meta: {} });
    assert.equal('subsidisedAmount' in owner.price, false, 'the owner\'s own price replaces both brochure prices');

    const plain = base();
    assert.equal('subsidisedAmount' in plain.price, false, 'an ordinary listing gets no new key');
  });

  it('the local checks refuse a subsidised price that is not below the headline price', () => {
    const l = base();
    l.price.subsidisedAmount = l.price.amount;
    assert.ok(checkListing(l).some((p) => /subsidisedAmount/.test(p)));
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

  it('carries a map pin found in the brochure, marked exact', () => {
    const l = buildListing({
      ai: structuredClone(AI), images: imagesFor(slug, picks), slug, id: 'BONA-W011', repo: REPO,
      caption: {}, meta: { map: { lat: 21.338, lng: 39.304778 } },
    });
    assert.deepEqual(l.map, { lat: 21.338, lng: 39.304778 });
    assert.equal(l.mapPrecision, 'exact');
    assert.deepEqual(checkListing(l), []);
  });

  it('leaves map null and precision null when the brochure carries no pin', () => {
    const l = base();
    assert.equal(l.map, null);
    assert.equal(l.mapPrecision, null);
  });

  it('refuses a WITHHELD listing before anything is written', () => {
    // Codex review 2026-09-08: filtering only in build.mjs still let the intake commit
    // public/listings/<slug>/*.jpg and brochure.pdf, which GitHub Pages serves directly —
    // the home would be off the site but its photos and full brochure still fetchable.
    // The rule this guards changed from a price cap to a named list the same day; the
    // "refuse before writing" property is what must survive that change.
    // A withheld id must still be a well-formed intake id, or the id rule fires too and the
    // assertion stops being about withholding. Today's withheld list holds only curated
    // BONA-### ids, so stand one up for the length of the test.
    const ai = structuredClone(AI);
    WITHHELD_LISTINGS.add('BONA-W099');
    try {
      const l = buildListing({ ai, images: imagesFor(slug, picks), slug, id: 'BONA-W099', repo: REPO, caption: {}, meta: {} });
      const problems = checkListing(l);
      assert.equal(problems.length, 1, JSON.stringify(problems));
      assert.match(problems[0], /withheld/i);
    } finally {
      WITHHELD_LISTINGS.delete('BONA-W099');
    }
  });

  it('accepts an expensive house — price alone never withholds one', () => {
    // The regression this guards: a standing SAR 10,000,000 cap silently refused the most
    // valuable homes a luxury brand publishes. Owner correction 2026-09-08.
    const dear = structuredClone(AI);
    dear.listing.price = { amount: 18_000_000, currency: 'SAR', from: false, period: null, onRequest: false };
    assert.deepEqual(checkListing(buildListing({ ai: dear, images: imagesFor(slug, picks), slug, id: 'BONA-W020', repo: REPO, caption: {}, meta: {} })), []);

    const under = structuredClone(AI);
    under.listing.price = { amount: 9_000_000, currency: 'SAR', from: false, period: null, onRequest: false };
    assert.deepEqual(checkListing(buildListing({ ai: under, images: imagesFor(slug, picks), slug, id: 'BONA-W021', repo: REPO, caption: {}, meta: {} })), []);

    const onReq = structuredClone(AI);
    onReq.listing.price = { amount: null, currency: 'SAR', from: false, period: null, onRequest: true };
    assert.deepEqual(checkListing(buildListing({ ai: onReq, images: imagesFor(slug, picks), slug, id: 'BONA-W022', repo: REPO, caption: {}, meta: {} })), []);
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
      caption: { text: 'rent #hidden' },
      meta: { hidden: true, messageId: 'MSG1', pdfSha256: 'abc', model: 'sonnet', warningCodes: ['price-not-printed', 'nonsense'] },
    });
    assert.equal(l.hidden, true);
    assert.equal(l._intake.source, 'whatsapp');
    assert.equal(l._intake.messageId, undefined, 'WhatsApp identifiers are never committed');
    assert.equal(l._intake.groupJid, undefined);
    assert.equal(l._intake.caption, undefined);
    assert.equal(l._intake.pdfSha256, 'abc');
    assert.ok(l._intake.images.every((im) => !('reason' in im)), 'no model reasons in the committed JSON');
    assert.equal(l._intake.model, 'sonnet');
    assert.equal(l._intake.images.length, 4);
    // Finding 5: the model's free-text warnings are NEVER committed — only known codes.
    assert.deepEqual(l._intake.warnings, ['price-not-printed'], 'unknown codes and model prose are dropped');
    assert.ok(!JSON.stringify(l).includes('check the floor'), 'no model free text anywhere in the listing');
  });

  it('commits no model free text at all when no codes are passed', () => {
    const l = buildListing({
      ai: structuredClone(AI), images: imagesFor(slug, picks), slug, id: 'BONA-W012', repo: REPO, meta: {},
    });
    assert.deepEqual(l._intake.warnings, []);
  });

  it('dates the listing in Riyadh', () => {
    assert.match(todayRiyadh(new Date('2026-09-05T22:30:00Z')), /^2026-09-06$/);
    assert.equal(base().listedAt, todayRiyadh());
  });

  // A PDF never arrives with a video already attached — videos.mjs/edits.addVideo() populate
  // this AFTER publish (see the "video attaches..." describe below) — but every WhatsApp
  // listing carries the field from the moment it is built, same as `images`.
  it('always carries an empty videos array — a PDF never arrives with one attached', () => {
    assert.deepEqual(base().videos, []);
  });
});

// ---- unit models, floor plans and the project fact lists (2026-11-17) --------------------------
describe('buildListing + checkListing — unit models, floor plans, amenities / nearby / warranties', () => {
  const slug = 'jeddah-heights-al-hamdaniyah';
  const picks = orderedPicks(AI.images);
  const PLAN = { model: 0, src: `/listings/${slug}/plan-01.jpg`, thumb: `/listings/${slug}/plan-01-thumb.webp` };
  const models = () => [
    {
      name: { en: 'Nawras 2', ar: 'نورس 2' }, bedrooms: 3, bathrooms: 2, areaSqm: 105.02,
      rooms: { en: ['Laundry', 'Maid room'], ar: ['غرفة غسيل', 'غرفة خادمة'] },
      availability: { en: 'Buildings G–P, first to seventh floor', ar: 'المباني G–P، من الأول إلى السابع' },
      price: 419994, subsidisedPrice: 356024, evidence: { page: 10, quote: '419,994 / 356,024' }, floorPlan: 0,
    },
    {
      name: { en: 'Lulu', ar: 'لؤلؤ' }, bedrooms: 2, bathrooms: 2, areaSqm: 88, rooms: null, availability: null,
      price: 319015, subsidisedPrice: 270425, evidence: { page: 11, quote: '319,015' }, floorPlan: null,
    },
  ];
  const projectAi = () => {
    const ai = structuredClone(AI);
    ai.listing.category = 'off-plan';
    ai.listing.type = 'apartment';
    ai.listing.project = { name: { en: 'Jeddah Heights', ar: 'جدة هايتس' }, developer: { en: 'NHC', ar: 'الوطنية للإسكان' } };
    // What alignHeadline() leaves after the model-price check: the cheapest model, "from", and its Sakani price.
    ai.listing.price = { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false, subsidisedAmount: 270425 };
    ai.models = models();
    ai.amenities = { en: ['Health club', 'Kids play area'], ar: ['نادٍ صحي', 'منطقة ألعاب للأطفال'] };
    ai.nearby = { en: [], ar: [] };
    ai.warranties = { en: ['Structure — 10 years'], ar: ['الهيكل الإنشائي — 10 سنوات'] };
    return ai;
  };
  const build = (ai = projectAi(), floorPlans = [PLAN]) => buildListing({
    ai, images: imagesFor(slug, picks), slug, id: 'BONA-W023', repo: REPO, caption: {}, meta: {}, floorPlans,
  });

  it('publishes each model\'s checked fields, its floor plan as { src, thumb }, and never the evidence', () => {
    const l = build();
    assert.deepEqual(l.models, [
      {
        name: { en: 'Nawras 2', ar: 'نورس 2' }, bedrooms: 3, bathrooms: 2, areaSqm: 105.02,
        rooms: { en: ['Laundry', 'Maid room'], ar: ['غرفة غسيل', 'غرفة خادمة'] },
        availability: { en: 'Buildings G–P, first to seventh floor', ar: 'المباني G–P، من الأول إلى السابع' },
        price: 419994, subsidisedPrice: 356024, floorPlan: { src: PLAN.src, thumb: PLAN.thumb },
      },
      {
        name: { en: 'Lulu', ar: 'لؤلؤ' }, bedrooms: 2, bathrooms: 2, areaSqm: 88, rooms: null, availability: null,
        price: 319015, subsidisedPrice: 270425, floorPlan: null,
      },
    ]);
    const json = JSON.stringify(l);
    assert.ok(!json.includes('evidence') && !json.includes('419,994 / 356,024'), 'the model\'s citation is internal and never published');
    assert.deepEqual(checkListing(l), []);
  });

  it('copies the answer: editing the AI result afterwards does not reach the listing', () => {
    const ai = projectAi();
    const l = build(ai);
    ai.models[0].name.en = 'changed';
    ai.models[0].rooms.en.push('Study');
    ai.amenities.en.push('Spa');
    assert.equal(l.models[0].name.en, 'Nawras 2');
    assert.deepEqual(l.models[0].rooms.en, ['Laundry', 'Maid room']);
    assert.deepEqual(l.amenities.en, ['Health club', 'Kids play area']);
  });

  it('leaves `models` out when the brochure prints none, and each fact list out when it is empty', () => {
    for (const none of [undefined, null, []]) {
      const ai = projectAi();
      ai.models = none;
      assert.equal('models' in build(ai, []), false, `models: ${JSON.stringify(none)}`);
    }
    const l = build();
    assert.deepEqual(l.amenities, { en: ['Health club', 'Kids play area'], ar: ['نادٍ صحي', 'منطقة ألعاب للأطفال'] });
    assert.deepEqual(l.warranties, { en: ['Structure — 10 years'], ar: ['الهيكل الإنشائي — 10 سنوات'] });
    assert.equal('nearby' in l, false, 'an empty list is left out');
    const plain = buildListing({ ai: structuredClone(AI), images: imagesFor(slug, picks), slug, id: 'BONA-W007', repo: REPO, caption: {}, meta: {} });
    for (const k of ['models', 'amenities', 'nearby', 'warranties']) assert.equal(k in plain, false, `an ordinary listing gets no ${k} key`);
  });

  it('a model whose floor plan was not written gets null; a plan for a model that does not exist is ignored', () => {
    const l = build(projectAi(), [{ model: 5, src: `/listings/${slug}/plan-06.jpg`, thumb: `/listings/${slug}/plan-06-thumb.webp` }]);
    assert.deepEqual(l.models.map((m) => m.floorPlan), [null, null]);
    assert.equal(l.models.length, 2);
  });

  it('a rental never carries a Sakani price, on a model any more than on the headline', () => {
    const ai = projectAi();
    ai.listing.category = 'rent';
    ai.listing.price = { amount: 319015, currency: 'SAR', from: true, period: 'year', onRequest: false, subsidisedAmount: 270425 };
    const l = build(ai);
    assert.deepEqual(l.models.map((m) => m.subsidisedPrice), [null, null]);
    assert.deepEqual(l.models.map((m) => m.price), [419994, 319015]);
    assert.deepEqual(checkListing(l), []);
  });

  it('accepts models with no price beside a headline of its own, and one specific unit beside priced models', () => {
    const ai = projectAi();
    for (const m of ai.models) { m.price = null; m.subsidisedPrice = null; m.evidence = null; }
    ai.listing.price = { amount: null, currency: 'SAR', from: false, period: null, onRequest: true };
    assert.deepEqual(checkListing(build(ai)), []);
    // The pipeline never aligns one specific unit's price with the models (price-pages.test.mjs).
    const unit = projectAi();
    unit.listing.unit = { floor: 3, block: null, unitRef: 'A-12' };
    unit.listing.price = { amount: 350000, currency: 'SAR', from: false, period: null, onRequest: false };
    assert.deepEqual(checkListing(build(unit)), []);
  });

  it('a single villa (no project) with one priced model keeps its own headline: not "from", and the validator agrees', () => {
    const ai = structuredClone(AI);   // a single villa: project null, SAR 4,500,000, not "from"
    ai.models = [{ ...models()[1], name: { en: 'Villa', ar: 'فيلا' }, price: 4400000, subsidisedPrice: null }];
    const l = build(ai, []);
    assert.deepEqual(l.price, { amount: 4500000, currency: 'SAR', from: false, period: null, onRequest: false });
    assert.equal(l.models[0].price, 4400000);
    assert.deepEqual(checkListing(l), []);
    assert.deepEqual(modelsProblems(l), []);
  });

  it('per-floor rows of a single property, and a project with ONE model, are not a development: the headline rule does not apply', () => {
    const floors = structuredClone(AI);
    floors.models = [{ ...models()[1], name: { en: 'Ground floor', ar: 'الدور الأرضي' }, price: 2000000, subsidisedPrice: null },
      { ...models()[1], name: { en: 'First floor', ar: 'الدور الأول' }, price: 2500000, subsidisedPrice: null }];
    assert.deepEqual(checkListing(build(floors, [])), []);
    const one = projectAi();
    one.models = [{ ...models()[0], floorPlan: null }];
    one.listing.price = { amount: 450000, currency: 'SAR', from: false, period: null, onRequest: false };
    assert.deepEqual(checkListing(build(one, [])), []);
  });

  it('headlineFollowsModels: a project, no unit, two models or more', () => {
    const base = { project: { name: { en: 'P', ar: 'م' } }, unit: null, models: [{}, {}] };
    assert.equal(headlineFollowsModels(base), true);
    assert.equal(headlineFollowsModels({ ...base, models: [{}, {}, {}] }), true);
    for (const [label, over] of [['no project', { project: null }], ['a unit', { unit: { floor: 3 } }], ['one model', { models: [{}] }],
      ['no models', { models: undefined }], ['models not a list', { models: { 0: {}, 1: {} } }]]) {
      assert.equal(headlineFollowsModels({ ...base, ...over }), false, label);
    }
    assert.equal(headlineFollowsModels(null), false);
  });

  it('the headline rule is alignHeadline\'s: a lowest Sakani price at or above the lowest price leaves none on the headline', () => {
    const ai = projectAi();
    ai.models = [{ ...models()[1], price: 300000, subsidisedPrice: null }, models()[0]];
    ai.listing.price = alignHeadline({ amount: null, currency: 'SAR', from: false, period: null, onRequest: true }, ai.models);
    const l = build(ai, []);
    assert.deepEqual(l.price, { amount: 300000, currency: 'SAR', from: true, period: null, onRequest: false });
    assert.deepEqual(checkListing(l), []);
  });

  const refusals = [
    ['a model price of 0', (l) => { l.models[1].price = 0; }, /models\[1\]\.price must be null or a number above 0/],
    ['a negative model price', (l) => { l.models[1].price = -5; }, /models\[1\]\.price must be null or a number above 0/],
    ['a model price written as text', (l) => { l.models[1].price = '319015'; }, /models\[1\]\.price must be null or a number above 0/],
    ['a Sakani price equal to the price', (l) => { l.models[0].subsidisedPrice = 419994; }, /models\[0\]\.subsidisedPrice must be lower than its price/],
    ['a Sakani price above the price', (l) => { l.models[0].subsidisedPrice = 500000; }, /models\[0\]\.subsidisedPrice must be lower than its price/],
    ['a Sakani price with no price', (l) => { l.models[0].price = null; }, /models\[0\]\.subsidisedPrice needs the model's regular price/],
    ['a floor plan of another listing', (l) => { l.models[0].floorPlan.src = '/listings/other-listing/plan-01.jpg'; }, /models\[0\]\.floorPlan\.src is not \/listings\/jeddah-heights-al-hamdaniyah\/plan-nn\.jpg/],
    ['a floor plan in the photo shape', (l) => { l.models[0].floorPlan.src = `/listings/${slug}/01.jpg`; }, /models\[0\]\.floorPlan\.src/],
    ['a remote floor plan', (l) => { l.models[0].floorPlan.src = 'https://example.org/listings/x/plan-01.jpg'; }, /models\[0\]\.floorPlan\.src/],
    ['a floor-plan thumb in the plan shape', (l) => { l.models[0].floorPlan.thumb = `/listings/${slug}/plan-01.jpg`; }, /models\[0\]\.floorPlan\.thumb is not \/listings\/jeddah-heights-al-hamdaniyah\/plan-nn-thumb\.webp/],
    ['a floor-plan thumb of another listing', (l) => { l.models[0].floorPlan.thumb = '/listings/other-listing/plan-01-thumb.webp'; }, /models\[0\]\.floorPlan\.thumb/],
    ['a floor plan that is still a candidate index', (l) => { l.models[1].floorPlan = 3; }, /models\[1\]\.floorPlan must be null or \{ src, thumb \}/],
    ['one floor plan shared by two models', (l) => { l.models[1].floorPlan = { ...l.models[0].floorPlan }; }, /models\[1\]\.floorPlan .*plan-01\.jpg is already used by another model/],
    ['a floor-plan thumb of another plan', (l) => { l.models[0].floorPlan.thumb = `/listings/${slug}/plan-02-thumb.webp`; }, /models\[0\]\.floorPlan\.thumb \/listings\/jeddah-heights-al-hamdaniyah\/plan-02-thumb\.webp is not the thumbnail of \/listings\/jeddah-heights-al-hamdaniyah\/plan-01\.jpg/],
    ['one floor-plan thumb shared by two models', (l) => { l.models[1].floorPlan = { src: `/listings/${slug}/plan-02.jpg`, thumb: l.models[0].floorPlan.thumb }; }, /models\[1\]\.floorPlan .*plan-01-thumb\.webp is already used by another model/],
    ['the model\'s evidence, published', (l) => { l.models[0].evidence = { page: 10, quote: '419,994' }; }, /models\[0\] has an unknown field "evidence"/],
    ['a headline that is not the lowest model price', (l) => { l.price.amount = 300000; }, /price\.amount must be the lowest unit-model price \(319,015\)/],
    ['a headline on request beside model prices', (l) => { l.price = { amount: null, currency: 'SAR', from: false, period: null, onRequest: true }; }, /price\.amount must be the lowest unit-model price \(319,015\).*on request/],
    ['a headline not marked "from"', (l) => { l.price.from = false; }, /price\.from must be true/],
    ['a Sakani headline that is not the lowest model Sakani price', (l) => { l.price.subsidisedAmount = 280000; }, /price\.subsidisedAmount must be the lowest unit-model Sakani price \(270,425\)/],
    ['no Sakani headline beside model Sakani prices', (l) => { delete l.price.subsidisedAmount; }, /price\.subsidisedAmount must be the lowest unit-model Sakani price \(270,425\), not absent/],
    ['a Sakani headline when no model has one', (l) => { for (const m of l.models) m.subsidisedPrice = null; }, /price\.subsidisedAmount must be absent: no unit model has a Sakani price/],
    ['rooms of unequal length', (l) => { l.models[0].rooms.ar.pop(); }, /models\[0\]\.rooms\.en and \.ar must have the same length/],
    ['amenities of unequal length', (l) => { l.amenities.ar.pop(); }, /amenities\.en and \.ar must have the same length/],
    ['more than 8 nearby places', (l) => { l.nearby = { en: Array(9).fill('Airport'), ar: Array(9).fill('المطار') }; }, /nearby has 9 items — at most 8/],
    ['more than 16 amenities', (l) => { l.amenities = { en: Array(17).fill('Gym'), ar: Array(17).fill('نادٍ') }; }, /amenities has 17 items — at most 16/],
    ['a warranty over 80 characters', (l) => { l.warranties.en[0] = 'x'.repeat(81); }, /warranties\.en\[0\] is 81 characters — at most 80/],
    ['a warranty list that is not { en, ar }', (l) => { l.warranties = ['Structure — 10 years']; }, /warranties must be \{ en:\[strings\], ar:\[strings\] \}/],
    ['a model name with no Arabic', (l) => { l.models[0].name.ar = 'Nawras'; }, /models\[0\]\.name must be \{ en, ar \}/],
    ['a model name over 60 characters', (l) => { l.models[0].name.en = 'N'.repeat(61); }, /models\[0\]\.name\.en is 61 characters — at most 60/],
    ['a fractional bedroom count', (l) => { l.models[0].bedrooms = 2.5; }, /models\[0\]\.bedrooms must be null or a whole number 0–20/],
    ['an area written as text', (l) => { l.models[0].areaSqm = '105'; }, /models\[0\]\.areaSqm must be null or a number between 10 and 100000/],
    ['an availability with no Arabic', (l) => { l.models[0].availability.ar = 'Buildings G–P'; }, /models\[0\]\.availability must be \{ en, ar \}/],
    ['more than 24 models', (l) => { l.models = Array.from({ length: 25 }, () => ({ ...l.models[1] })); }, /models has 25 entries — at most 24/],
    ['models that are not an array', (l) => { l.models = { 0: l.models[0] }; }, /models must be an array/],
    ['a Sakani model price on a rental', (l) => { l.category = 'rent'; l.price.period = 'year'; delete l.price.subsidisedAmount; }, /models\[0\]\.subsidisedPrice is for sales only/],
  ];
  for (const [label, mutate, re] of refusals) {
    it(`checkListing refuses ${label}`, () => {
      const l = build();
      mutate(l);
      const problems = checkListing(l);
      assert.ok(problems.some((p) => re.test(p)), problems.join(' | ') || '(no problems)');
    });
  }

  it('a Sakani price that is not valid against its own model price is ONE problem: it never sets the headline\'s Sakani price', () => {
    const l = build();
    l.models[0].price = null;
    l.models[0].subsidisedPrice = 200000; // below the headline, but it has no price of its own
    const problems = modelsProblems(l);
    assert.ok(problems.some((p) => /models\[0\]\.subsidisedPrice needs the model's regular price/.test(p)), problems.join(' | '));
    assert.ok(!problems.some((p) => /price\.subsidisedAmount/.test(p)), problems.join(' | '));
    const above = build();
    above.models[1].subsidisedPrice = 400000; // above its own 319,015
    above.models[0].subsidisedPrice = null;
    above.price.subsidisedAmount = undefined;
    delete above.price.subsidisedAmount;
    const p2 = modelsProblems(above);
    assert.ok(p2.some((p) => /models\[1\]\.subsidisedPrice must be lower than its price/.test(p)), p2.join(' | '));
    assert.ok(!p2.some((p) => /price\.subsidisedAmount/.test(p)), p2.join(' | '));
  });

  it('a headline with no amount beside model prices says "absent", never "undefined"', () => {
    const l = build();
    delete l.price.amount;
    const problems = modelsProblems(l);
    assert.ok(problems.some((p) => /price\.amount must be the lowest unit-model price \(319,015\) when the models carry prices, not absent/.test(p)), problems.join(' | '));
    assert.ok(!problems.some((p) => /undefined/.test(p)), problems.join(' | '));
  });

  // Hand edits and the backfill never pass the AI step's copyProblems(), so the shared rule checks
  // every model string and list item itself.
  const leaks = [
    ['a phone number in a model name', (l) => { l.models[0].name.en = 'Nawras 0551234567'; }, /models\[0\]\.name\.en mentions a contact detail or another brand: 0551234567/],
    ['a phone number in Arabic-Indic digits in the rooms', (l) => { l.models[0].rooms.ar[0] = 'جوال ٠٥٥١٢٣٤٥٦٧'; }, /models\[0\]\.rooms\.ar\[0\] mentions a contact detail or another brand/],
    ['a web address in the availability', (l) => { l.models[0].availability.en = 'See www.example.com'; }, /models\[0\]\.availability\.en mentions a contact detail or another brand: www\./],
    ['the old brand in the amenities', (l) => { l.amenities.en[0] = 'TK Estates lounge'; }, /amenities\.en\[0\] mentions a contact detail or another brand/],
    ['an e-mail address in a warranty', (l) => { l.warranties.en[0] = 'Claims: care@example.com'; }, /warranties\.en\[0\] mentions a contact detail or another brand: care@example\.com/],
    ['hype in the nearby list', (l) => { l.nearby = { en: ['Stunning corniche'], ar: ['الكورنيش'] }; }, /nearby\.en\[0\] uses hype wording: "Stunning"/],
    ['hype in a model name', (l) => { l.models[1].name.en = 'Dream home'; }, /models\[1\]\.name\.en uses hype wording/],
  ];
  for (const [label, mutate, re] of leaks) {
    it(`checkListing refuses ${label}`, () => {
      const l = build();
      mutate(l);
      const problems = checkListing(l);
      assert.ok(problems.some((p) => re.test(p)), problems.join(' | ') || '(no problems)');
    });
  }

  it('modelsProblems: a listing with none of the new fields is fine', () => {
    assert.deepEqual(modelsProblems({ slug, price: { amount: 1, currency: 'SAR', from: false, period: null, onRequest: false } }), []);
    assert.deepEqual(modelsProblems({ slug, models: null, amenities: null }), []);
    assert.deepEqual(modelsProblems({ slug, models: [], nearby: { en: [], ar: [] } }), []);
  });

  it('LOCAL_PLAN_SRC / LOCAL_PLAN_THUMB: exactly the plan shapes, and a plan is never a gallery photo', () => {
    for (const ok of ['/listings/jeddah-heights/plan-01.jpg', '/listings/a/plan-123.jpg']) assert.ok(LOCAL_PLAN_SRC.test(ok), ok);
    for (const bad of ['/listings/a/plan-1.jpg', '/listings/a/01.jpg', '/listings/A/plan-01.jpg', '/listings/a/plan-01-thumb.webp', '/listings/a/plan-01.png', 'https://x/listings/a/plan-01.jpg']) {
      assert.ok(!LOCAL_PLAN_SRC.test(bad), bad);
    }
    assert.ok(LOCAL_PLAN_THUMB.test('/listings/jeddah-heights/plan-01-thumb.webp'));
    for (const bad of ['/listings/a/plan-01.jpg', '/listings/a/01-thumb.webp', '/listings/a/plan-01-thumb.jpg']) assert.ok(!LOCAL_PLAN_THUMB.test(bad), bad);
    assert.ok(!LOCAL_LISTING_SRC.test('/listings/a/plan-01.jpg') && !isLocalSrc('/listings/a/plan-01.jpg'), 'a floor plan cannot be passed off as a photo');
  });
});

// ---- the floor-plan files ------------------------------------------------------------------------
describe('writeFloorPlans', () => {
  let dir; let plan; let photo; let sharp;
  before(async () => {
    sharp = (await import('sharp')).default;
    // Under ~/.cache, not /tmp (RAM on this host).
    const base = path.join(os.homedir(), '.cache', 'bona-tests');
    fs.mkdirSync(base, { recursive: true });
    dir = fs.mkdtempSync(path.join(base, 'plans-'));
    // A transparent plan, 2400 × 1200: the kind of image that came out on black before the extraction fix.
    plan = path.join(dir, 'c007.png');
    await sharp({ create: { width: 2400, height: 1200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(plan);
    photo = path.join(dir, 'c003.jpg');
    await sharp({ create: { width: 800, height: 600, channels: 3, background: '#4a6b8a' } }).jpeg().toFile(photo);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes plan-NN.jpg on white and plan-NN-thumb.webp, NN = the model\'s 1-based position', async () => {
    const out = path.join(dir, 'publish', 'jeddah-heights');
    const plans = await writeFloorPlans([{ index: 3, abs: photo }, { index: 7, abs: plan }], [{ floorPlan: null }, { floorPlan: 7 }, { floorPlan: 3 }], out, 'jeddah-heights');
    assert.deepEqual(plans.map(({ model, index, src, thumb }) => ({ model, index, src, thumb })), [
      { model: 1, index: 7, src: '/listings/jeddah-heights/plan-02.jpg', thumb: '/listings/jeddah-heights/plan-02-thumb.webp' },
      { model: 2, index: 3, src: '/listings/jeddah-heights/plan-03.jpg', thumb: '/listings/jeddah-heights/plan-03-thumb.webp' },
    ]);
    assert.deepEqual(plans.skipped, []);
    assert.equal(plans[0].file, path.join(out, 'plan-02.jpg'));
    assert.equal(plans[0].thumbFile, path.join(out, 'plan-02-thumb.webp'));
    assert.deepEqual(fs.readdirSync(out).sort(), ['plan-02-thumb.webp', 'plan-02.jpg', 'plan-03-thumb.webp', 'plan-03.jpg']);
    const big = await sharp(path.join(out, 'plan-02.jpg')).metadata();
    assert.deepEqual([big.format, big.width, big.height, big.hasAlpha], ['jpeg', 1600, 800, false], 'inside 1600, no alpha');
    assert.equal(big.chromaSubsampling, '4:4:4', 'full-resolution colour: thin coloured lines and small text stay sharp');
    const { data } = await sharp(path.join(out, 'plan-02.jpg')).raw().toBuffer({ resolveWithObject: true });
    assert.ok(data[0] > 245 && data[1] > 245 && data[2] > 245, `the transparent ground is white, not black (got ${data[0]},${data[1]},${data[2]})`);
    const thumb = await sharp(path.join(out, 'plan-02-thumb.webp')).metadata();
    assert.deepEqual([thumb.format, thumb.width], ['webp', 480]);
    assert.equal((await sharp(path.join(out, 'plan-03.jpg')).metadata()).width, 800, 'never enlarged');
  });

  it('names its qualities: plans JPEG q85, every thumbnail WebP q78', () => {
    assert.deepEqual([PLAN_JPEG_QUALITY, THUMB_QUALITY], [85, 78]);
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'images.mjs'), 'utf8');
    assert.doesNotMatch(src, /quality: \d/, 'no bare quality number left in a sharp call');
  });

  it('skips a candidate it cannot decode, or that does not exist, and still writes the rest', async () => {
    const bad = path.join(dir, 'c009.jpg');
    fs.writeFileSync(bad, 'not an image');
    const out = path.join(dir, 'publish', 'skips');
    const plans = await writeFloorPlans([{ index: 9, abs: bad }, { index: 3, abs: photo }], [{ floorPlan: 9 }, { floorPlan: 3 }, { floorPlan: 42 }], out, 'skips');
    assert.deepEqual(plans.map((p) => [p.model, p.src]), [[1, '/listings/skips/plan-02.jpg']]);
    assert.deepEqual(plans.skipped.map((s) => [s.model, s.index]), [[0, 9], [2, 42]]);
    assert.ok(plans.skipped.every((s) => typeof s.error === 'string' && s.error));
    assert.deepEqual(fs.readdirSync(out).sort(), ['plan-02-thumb.webp', 'plan-02.jpg'], 'no half-written file is left behind');
  });

  it('writes nothing, and makes no folder, when no model has a floor plan', async () => {
    const out = path.join(dir, 'publish', 'none');
    for (const models of [[], [{ floorPlan: null }, {}], undefined]) {
      const plans = await writeFloorPlans([{ index: 3, abs: photo }], models, out, 'none');
      assert.deepEqual([...plans], []);
      assert.deepEqual(plans.skipped, []);
    }
    assert.equal(fs.existsSync(out), false);
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
    assert.equal(nextListingId(readIndex(tmp), inboxIds(tmp)), 'BONA-W002');
  });

  it('reads the ids actually present in the inbox', () => {
    assert.deepEqual(inboxIds(tmp), ['BONA-W001']);
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

  it('price and hero record that the owner edited the listing by hand', () => {
    const fresh = listing();
    fresh.id = 'BONA-W005'; fresh.slug = 'edit-marker-test';
    writeInboxListing(tmp, fresh);
    edits.setPrice(tmp, 'BONA-W005', { amount: 900000, currency: 'SAR' });
    edits.setHero(tmp, 'BONA-W005', 2);
    edits.setPrice(tmp, 'BONA-W005', { onRequest: true });
    assert.deepEqual(findInbox(tmp, 'BONA-W005').listing._intake.edits, ['price', 'hero']);
    edits.removeListing(tmp, 'BONA-W005'); // the suite below counts the inbox
  });

  it('price clears a subsidised price read from the brochure', () => {
    const found = findInbox(tmp, 'BONA-W001');
    found.listing.price = { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false, subsidisedAmount: 270425 };
    fs.writeFileSync(found.file, `${JSON.stringify(found.listing, null, 2)}\n`);
    const p = edits.setPrice(tmp, 'BONA-W001', { amount: 330000, currency: 'SAR' }).listing.price;
    assert.equal(p.amount, 330000);
    assert.equal('subsidisedAmount' in p, false);
  });

  it('price also clears the unit-model prices: the owner\'s figure replaces the brochure\'s, as a caption price does', () => {
    const found = findInbox(tmp, 'BONA-W001');
    const before = structuredClone(found.listing);
    found.listing.price = { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false, subsidisedAmount: 270425 };
    found.listing.models = [
      { name: { en: 'Lulu', ar: 'لؤلؤ' }, bedrooms: 2, bathrooms: 2, areaSqm: 88, rooms: null, availability: null, price: 319015, subsidisedPrice: 270425, floorPlan: null },
      { name: { en: 'Nawras', ar: 'نورس' }, bedrooms: 3, bathrooms: 2, areaSqm: 105, rooms: null, availability: null, price: 419994, subsidisedPrice: null, floorPlan: null },
    ];
    fs.writeFileSync(found.file, `${JSON.stringify(found.listing, null, 2)}\n`);
    try {
      for (const [args, cleared] of [[{ amount: 330000, currency: 'SAR' }, 2], [{ onRequest: true }, 0]]) {
        const r = edits.setPrice(tmp, 'BONA-W001', args);
        const l = r.listing;
        assert.deepEqual(l.models.map((m) => [m.price, m.subsidisedPrice]), [[null, null], [null, null]]);
        assert.deepEqual(l.models.map((m) => m.name.en), ['Lulu', 'Nawras'], 'the models themselves stay');
        assert.deepEqual(modelsProblems(l), [], 'the shared rule accepts the edited listing (no headline left to align)');
        assert.equal(r.modelPricesCleared, cleared, 'how many models lost their price (the second call finds none left)');
      }
    } finally {
      fs.writeFileSync(found.file, `${JSON.stringify(before, null, 2)}\n`);
    }
  });

  it('the price reply says when it took the unit-model prices off, and is unchanged otherwise', () => {
    const sar = { currency: 'SAR', amount: 330000 };
    assert.equal(msg.priceChange(sar), 'Price set to SAR 330,000');
    assert.equal(msg.priceChange(sar, { modelPricesCleared: 0 }), 'Price set to SAR 330,000');
    assert.equal(msg.priceChange(sar, { modelPricesCleared: 8 }), 'Price set to SAR 330,000 — 8 unit-model prices removed; the table now shows On request');
    assert.equal(msg.priceChange(sar, { modelPricesCleared: 1 }), 'Price set to SAR 330,000 — 1 unit-model price removed; the table now shows On request');
    assert.equal(msg.priceChange({ currency: 'SAR', amount: null }, { onRequest: true, modelPricesCleared: 2 }), 'Price on request — 2 unit-model prices removed; the table now shows On request');
    const index = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs'), 'utf8');
    const priceCase = index.slice(index.indexOf("case 'price': {"), index.indexOf("case 'brochure': {"));
    assert.match(priceCase, /msg\.priceChange\(r\.listing\.price, \{ onRequest: command\.onRequest, modelPricesCleared: r\.modelPricesCleared, brochure: r\.brochure, id: command\.id \}\)/, 'index.mjs replies with it');
    // Codex r1 #8: the command rebuilds the brochure in the same edit (and commit), never setPrice alone.
    assert.match(priceCase, /edits\.setPriceWithBrochure\(cfg\.repo, command\.id, command, \{ cfg, workDir \}\)/);
    assert.doesNotMatch(priceCase, /edits\.setPrice\(/);
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

// `licence BONA-W003 7200012345 2027-03-01` / `wafi BONA-W003 1234567890` — the REGA numbers
// the owner reads off the FAL platform and types into the group. The command has to land in
// one of TWO files depending on the id (docs/OWNER-RUNBOOK.md §10):
//   BONA-W###  the listing's own inbox JSON, beside its price and status
//   BONA-###   scripts/curate/licences.json, because a curated listing is generated code
// and in both cases it is validated with the SITE's rule before anything is written, so the
// daemon can never push a licence that then fails the build it runs on the next job.
describe('edits.setLicence / setWafi — REGA advertising licences', () => {
  let tmp;
  const slug = 'licence-villa';
  const inboxListing = () => ({
    id: 'BONA-W001',
    slug,
    status: 'available',
    title: { en: 'Licence Villa', ar: 'فيلا الترخيص' },
    price: { amount: 1000000, currency: 'SAR', from: false, period: null, onRequest: false },
    images: [1, 2, 3, 4].map((n) => ({ src: `/listings/${slug}/0${n}.jpg`, thumb: null, alt: { en: 'x', ar: 'س' } })),
  });
  // The curated set as it exists on disk: the built src/data/listings.json, which is the only
  // place BONA-### listings are data rather than a module to execute.
  const CURATED = [{ id: 'BONA-015', slug: 'curated-tower', title: { en: 'Curated Tower', ar: 'برج منسق' }, licence: null }];
  const inboxFile = () => path.join(tmp, 'scripts', 'curate', 'inbox', `${slug}.json`);
  const readInboxFile = () => JSON.parse(fs.readFileSync(inboxFile(), 'utf8'));
  const readLicences = () => JSON.parse(fs.readFileSync(path.join(tmp, 'scripts', 'curate', 'licences.json'), 'utf8'));

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-licence-'));
    fs.mkdirSync(path.join(tmp, 'scripts', 'curate', 'inbox'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'src', 'data'), { recursive: true });
    writeInboxListing(tmp, inboxListing());
    fs.writeFileSync(path.join(tmp, 'scripts', 'curate', 'licences.json'), '{}\n');
    fs.writeFileSync(path.join(tmp, 'src', 'data', 'listings.json'), `${JSON.stringify(CURATED, null, 2)}\n`);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('writes the advertisement number and its expiry into the listing\'s own JSON', () => {
    const res = edits.setLicence(tmp, 'bona-w001', { adNumber: '7200012345', adExpiry: '2027-03-01' });
    assert.equal(res.curated, false);
    assert.deepEqual(res.licence, { adNumber: '7200012345', adExpiry: '2027-03-01', wafiNumber: null, escrowAccount: null });
    // On DISK, not just in the returned object — the daemon commits the file.
    assert.deepEqual(readInboxFile().licence, res.licence);
    // …and in a shape the site build accepts, checked with the site's own rule.
    assert.deepEqual(licenceProblems(readInboxFile().licence), []);
  });

  it('never writes a partial block — every field the site knows about is present', () => {
    edits.setWafi(tmp, 'BONA-W001', { wafiNumber: '1234567890' });
    assert.deepEqual(Object.keys(readInboxFile().licence).sort(), ['adExpiry', 'adNumber', 'escrowAccount', 'wafiNumber']);
  });

  it('merges: an off-plan unit can carry both an ad licence and a Wafi number', () => {
    edits.setLicence(tmp, 'BONA-W001', { adNumber: '7200012345', adExpiry: '2027-03-01' });
    const res = edits.setWafi(tmp, 'BONA-W001', { wafiNumber: '1234567890' });
    assert.deepEqual(res.licence, { adNumber: '7200012345', adExpiry: '2027-03-01', wafiNumber: '1234567890', escrowAccount: null });
    assert.deepEqual(readInboxFile().licence, res.licence);
  });

  it('clear takes back only its own fields, and the block becomes null once nothing is left', () => {
    edits.setLicence(tmp, 'BONA-W001', { adNumber: '7200012345', adExpiry: '2027-03-01' });
    edits.setWafi(tmp, 'BONA-W001', { wafiNumber: '1234567890' });
    const cleared = edits.setLicence(tmp, 'BONA-W001', { clear: true });
    assert.equal(cleared.licence.adNumber, null);
    assert.equal(cleared.licence.adExpiry, null);
    assert.equal(cleared.licence.wafiNumber, '1234567890', 'the Wafi number is a different command\'s');
    const empty = edits.setWafi(tmp, 'BONA-W001', { clear: true });
    assert.equal(empty.licence, null, 'an all-null licence is no licence');
    assert.equal(readInboxFile().licence, null);
  });

  it('answers null for an id that is neither in the inbox nor in the curated set', () => {
    assert.equal(edits.setLicence(tmp, 'BONA-W404', { adNumber: '7200012345', adExpiry: '2027-03-01' }), null);
    assert.equal(edits.setWafi(tmp, 'BONA-404', { wafiNumber: '1234567890' }), null);
    assert.equal(edits.locateCurated(tmp, 'BONA-015').listing.slug, 'curated-tower');
    assert.equal(edits.locateCurated(tmp, 'BONA-404'), null);
  });

  it('puts a CURATED listing\'s numbers in licences.json instead, keyed by id', () => {
    const res = edits.setLicence(tmp, 'bona-015', { adNumber: '7200099999', adExpiry: '2028-01-31' });
    assert.equal(res.curated, true);
    assert.equal(res.listing.title.en, 'Curated Tower', 'the reply needs the listing, not just the id');
    assert.deepEqual(readLicences(), {
      'BONA-015': { adNumber: '7200099999', adExpiry: '2028-01-31', wafiNumber: null, escrowAccount: null },
    });
    // build.mjs merges this file onto the built listing; nothing was written to the inbox.
    assert.equal(readInboxFile().licence, undefined);
  });

  it('drops the key entirely when a curated listing\'s licence is cleared', () => {
    edits.setLicence(tmp, 'BONA-015', { adNumber: '7200099999', adExpiry: '2028-01-31' });
    const res = edits.setLicence(tmp, 'BONA-015', { clear: true });
    assert.equal(res.licence, null);
    assert.deepEqual(readLicences(), {}, 'no empty husk left behind for build.mjs to merge');
  });

  // Review finding (MEDIUM): a licences.json that is corrupt or half-written used to read
  // back as `{}`, and the next `licence BONA-016 …` would then rewrite the file with only
  // that one key — silently deleting every other listing's number. Nothing about a broken
  // file is recoverable HERE, so it throws: index.mjs::publishEdit rolls the clone back with
  // resetTree(), the reason goes to the journal, and the group gets the generic failure line.
  it('throws rather than rewriting a corrupt licences.json down to one key', () => {
    const file = path.join(tmp, 'scripts', 'curate', 'licences.json');
    const corrupt = '{"BONA-014":{"adNumber":"7200011111","adExpiry":"2027-01-01"},,,';
    fs.writeFileSync(file, corrupt);
    assert.throws(
      () => edits.setLicence(tmp, 'BONA-015', { adNumber: '7200099999', adExpiry: '2028-01-31' }),
      (err) => {
        assert.match(err.message, /not valid JSON — refusing to overwrite it/);
        // `err.message` is read back to the group by `status`; only `err.detail` (journal) may
        // carry the parser's account of the file — publish.mjs::must()'s rule.
        assert.ok(!err.message.includes('BONA-014'), `the file's bytes leaked into the reply: ${err.message}`);
        assert.ok(err.detail, 'the reason still reaches the journal');
        return true;
      },
    );
    assert.equal(fs.readFileSync(file, 'utf8'), corrupt, 'the file the owner still has to fix is untouched');
  });

  it('throws on a licences.json that parses but is not an object of listings', () => {
    const file = path.join(tmp, 'scripts', 'curate', 'licences.json');
    for (const body of ['[]', '"BONA-015"', 'null', '42']) {
      fs.writeFileSync(file, body);
      assert.throws(() => edits.setWafi(tmp, 'BONA-015', { wafiNumber: '1234567890' }), body);
      assert.equal(fs.readFileSync(file, 'utf8'), body, body);
    }
  });

  it('bootstraps only when the file is genuinely absent', () => {
    fs.rmSync(path.join(tmp, 'scripts', 'curate', 'licences.json'));
    const res = edits.setLicence(tmp, 'BONA-015', { adNumber: '7200099999', adExpiry: '2028-01-31' });
    assert.equal(res.curated, true);
    assert.deepEqual(Object.keys(readLicences()), ['BONA-015']);
  });

  it('keeps every other listing\'s numbers when it writes a new one', () => {
    fs.writeFileSync(path.join(tmp, 'scripts', 'curate', 'licences.json'), JSON.stringify({
      'BONA-014': { adNumber: '7200011111', adExpiry: '2027-01-01', wafiNumber: null, escrowAccount: null },
    }));
    edits.setLicence(tmp, 'BONA-015', { adNumber: '7200099999', adExpiry: '2028-01-31' });
    assert.deepEqual(Object.keys(readLicences()).sort(), ['BONA-014', 'BONA-015']);
  });

  // Review finding: `setLicence(repo, id, {})` used to reach nextLicence as an all-undefined
  // patch, which looked exactly like a clear and wiped the block. `clear` is its own argument
  // and its own command; a patch that sets nothing is a caller bug, so it throws.
  it('never reads an empty patch as a clear', () => {
    edits.setLicence(tmp, 'BONA-W001', { adNumber: '7200012345', adExpiry: '2027-03-01' });
    assert.throws(() => edits.setLicence(tmp, 'BONA-W001', {}), /no field to set/);
    assert.throws(() => edits.setWafi(tmp, 'BONA-W001', {}), /no field to set/);
    assert.throws(() => edits.setLicence(tmp, 'BONA-W001'), /no field to set/);
    assert.equal(readInboxFile().licence.adNumber, '7200012345', 'the licence he recorded is still there');
  });

  it('sets only the fields it was given, leaving the rest of the block alone', () => {
    edits.setLicence(tmp, 'BONA-W001', { adNumber: '7200012345', adExpiry: '2027-03-01' });
    edits.setWafi(tmp, 'BONA-W001', { wafiNumber: '1234567890' });
    // `wafi` must not blank the ad licence just because its patch has no adNumber in it.
    assert.deepEqual(readInboxFile().licence, {
      adNumber: '7200012345', adExpiry: '2027-03-01', wafiNumber: '1234567890', escrowAccount: null,
    });
  });

  // Prototype-key hardening: the file is JSON from the repo, and `all[id]` is a lookup by a
  // string that came off a WhatsApp message. A null-prototype object cannot answer that
  // lookup with something off Object.prototype.
  it('reads licences.json into an object with no prototype', () => {
    fs.writeFileSync(path.join(tmp, 'scripts', 'curate', 'licences.json'), '{"BONA-015":{"adNumber":"7200099999"}}');
    const all = edits.readLicences(tmp);
    assert.equal(Object.getPrototypeOf(all), null);
    assert.equal(all.constructor, undefined, 'a lookup can never fall through to Object.prototype');
    assert.deepEqual(all['BONA-015'], { adNumber: '7200099999' });
  });

  it('refuses a licence the site validator would reject, and writes nothing', () => {
    // An expiry with no number is the one combination validate.mjs singles out — it would
    // print "valid until …" on a page with no licence to be valid.
    const res = edits.setLicence(tmp, 'BONA-W001', { adExpiry: '2027-03-01' });
    assert.match(res.error, /adExpiry without/);
    assert.equal(readInboxFile().licence, undefined, 'the file was left exactly as it was');
  });

  // The daemon's own wiring (index.mjs::publishEdit) is: apply -> rebuild -> commit -> reply,
  // with the commit rolled back if anything throws. The commit is stubbed here; what is being
  // pinned is the message it is given and the line that goes back to the group.
  it('composes the commit message and the group reply the owner sees', () => {
    const commits = [];
    const commit = (message) => commits.push(message);
    const licence = edits.setLicence(tmp, 'BONA-W001', { adNumber: '7200012345', adExpiry: '2027-03-01' });
    commit(`intake: licence (BONA-W001)`);
    assert.equal(
      msg.licenceRecorded('BONA-W001', licence.licence),
      '✅ Licence recorded for BONA-W001: 7200012345, valid until 2027-03-01. Live in ~3 min.',
    );
    const wafi = edits.setWafi(tmp, 'BONA-W001', { wafiNumber: '1234567890' });
    commit(`intake: wafi (BONA-W001)`);
    assert.equal(
      msg.wafiRecorded('BONA-W001', wafi.licence),
      '✅ Wafi licence recorded for BONA-W001: 1234567890. Live in ~3 min.',
    );
    assert.deepEqual(commits, ['intake: licence (BONA-W001)', 'intake: wafi (BONA-W001)']);
    // He asked in Arabic, he is answered in Arabic (lib/commands.mjs sets `lang` off the verb).
    assert.match(msg.licenceRecorded('BONA-W001', licence.licence, 'ar'), /^✅ تم تسجيل رخصة الإعلان لـ BONA-W001: 7200012345/);
    assert.match(msg.wafiRecorded('BONA-W001', wafi.licence, 'ar'), /^✅ تم تسجيل رخصة وافي لـ BONA-W001: 1234567890/);
    assert.match(msg.licenceRecorded('BONA-W001', null, 'ar'), /^✅ تم حذف رخصة الإعلان من BONA-W001/);
    assert.equal(msg.licenceRecorded('BONA-W001', null), '✅ Licence cleared for BONA-W001. Live in ~3 min.');
  });
});

// The fix for "videos aren't getting added": a video is downloaded by the daemon
// (index.mjs::handleVideo, not exercised here — see evolution.test.mjs/commands.test.mjs for
// the pieces that recognize and address it), re-encoded by lib/video.mjs prepareVideo(), and
// handed to edits.addVideo() as PATHS — never as a Buffer: the stored clip is up to 25 MB and
// the daemon shares a 2 GB cgroup with a `claude` process.
describe('edits.addVideo — a video attaches to a listing that already exists', () => {
  let tmp;
  const slug = 'tmp-video-villa';
  const preparedDirs = [];
  /** Stand-in for what prepareVideo() leaves behind: a transcoded clip, optionally a poster. */
  const prepared = (name, bytes, poster = null) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-prepared-'));
    preparedDirs.push(dir);
    const file = path.join(dir, `${name}.mp4`);
    fs.writeFileSync(file, bytes);
    let posterFile = null;
    if (poster) { posterFile = path.join(dir, `${name}.jpg`); fs.writeFileSync(posterFile, poster); }
    return { file, poster: posterFile };
  };
  const seed = () => ({
    id: 'BONA-W001', slug, status: 'available', hidden: false,
    title: { en: 'Temp Villa', ar: 'فيلا مؤقتة' },
    price: { amount: 1000000, currency: 'SAR', from: false, period: null, onRequest: false },
    images: [1, 2, 3, 4].map((n) => ({ src: `/listings/${slug}/0${n}.jpg`, thumb: null, alt: { en: 'x', ar: 'س' } })),
    videos: [],
    _intake: { images: [1, 2, 3, 4].map((n) => ({ n, room: 'view' })) },
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-video-'));
    fs.mkdirSync(path.join(tmp, 'scripts', 'curate', 'inbox'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'public', 'listings', slug), { recursive: true });
    writeInboxListing(tmp, seed());
    writeIndex(tmp, { nextSeq: 2, listings: { [slug]: 'BONA-W001' } });
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const dir of preparedDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('copies the clip AND its poster in, and records both site-local paths on the listing', () => {
    const bytes = Buffer.from('fake mp4 bytes');
    const res = edits.addVideo(tmp, 'BONA-W001', prepared('clip', bytes, Buffer.from('fake jpg')));
    assert.equal(res.video.n, 1);
    assert.equal(res.video.src, `/listings/${slug}/v-01.mp4`);
    assert.equal(res.video.poster, `/listings/${slug}/v-01-poster.jpg`);
    assert.equal(res.video.bytes, bytes.length);
    assert.deepEqual(res.listing.videos, [{ src: `/listings/${slug}/v-01.mp4`, poster: `/listings/${slug}/v-01-poster.jpg` }]);
    assert.deepEqual(fs.readFileSync(path.join(tmp, 'public', 'listings', slug, 'v-01.mp4')), bytes);
    assert.ok(fs.existsSync(path.join(tmp, 'public', 'listings', slug, 'v-01-poster.jpg')));
    // persisted, not just returned
    assert.deepEqual(findInbox(tmp, 'BONA-W001').listing.videos, [{ src: `/listings/${slug}/v-01.mp4`, poster: `/listings/${slug}/v-01-poster.jpg` }]);
  });

  it('a clip ffmpeg could not cut a poster out of still publishes, with poster null', () => {
    const res = edits.addVideo(tmp, 'BONA-W001', prepared('clip', Buffer.from('no poster for this one')));
    assert.deepEqual(res.listing.videos, [{ src: `/listings/${slug}/v-01.mp4`, poster: null }]);
    assert.equal(fs.existsSync(path.join(tmp, 'public', 'listings', slug, 'v-01-poster.jpg')), false);
  });

  it('numbers a second video after the first, on its own sequence from the photos', () => {
    edits.addVideo(tmp, 'BONA-W001', prepared('a', Buffer.from('one'), Buffer.from('p1')));
    const res = edits.addVideo(tmp, 'BONA-W001', prepared('b', Buffer.from('two'), Buffer.from('p2')));
    assert.deepEqual(res.listing.videos.map((v) => v.src), [`/listings/${slug}/v-01.mp4`, `/listings/${slug}/v-02.mp4`]);
    assert.deepEqual(res.listing.videos.map((v) => v.poster), [`/listings/${slug}/v-01-poster.jpg`, `/listings/${slug}/v-02-poster.jpg`]);
    assert.deepEqual(res.listing.images.map((im) => im.src), [1, 2, 3, 4].map((n) => `/listings/${slug}/0${n}.jpg`), 'photo numbering untouched');
  });

  it('refuses past MAX_VIDEOS rather than growing forever', () => {
    for (let i = 0; i < 4; i += 1) assert.ok(!edits.addVideo(tmp, 'BONA-W001', prepared(`v${i}`, Buffer.from(`v${i}`))).error);
    const res = edits.addVideo(tmp, 'BONA-W001', prepared('extra', Buffer.from('one-too-many')));
    assert.match(res.error, /the limit is 4/);
    assert.equal(findInbox(tmp, 'BONA-W001').listing.videos.length, 4, 'the 5th write never happened');
  });

  it('returns null for a listing that does not exist, like the other edits', () => {
    assert.equal(edits.addVideo(tmp, 'BONA-W404', prepared('x', Buffer.from('x'))), null);
  });

  it('says so rather than throwing when the prepared file has already been cleaned up', () => {
    const media = prepared('gone', Buffer.from('x'));
    fs.rmSync(media.file, { force: true });
    assert.match(edits.addVideo(tmp, 'BONA-W001', media).error, /not on disk/);
  });

  it('works on a listing published before this field existed (no videos key at all)', () => {
    const legacy = seed();
    delete legacy.videos;
    writeInboxListing(tmp, legacy);
    const res = edits.addVideo(tmp, 'BONA-W001', prepared('x', Buffer.from('x')));
    assert.deepEqual(res.listing.videos, [{ src: `/listings/${slug}/v-01.mp4`, poster: null }]);
  });
});

// This is the "(b)" scenario end to end: a brochure PDF publishes a listing (buildListing() is
// exactly what processPdf() calls to do that), then a video sent afterward — captioned with
// the new listing's id, per handleVideo()/findListingId() — attaches to it. Two WhatsApp
// messages, because WhatsApp cannot carry a PDF and a video in one message; the combination's
// END STATE is one published listing whose videos field is populated, which is what this
// asserts.
describe('a PDF + a video together — the combination the owner actually sends', () => {
  it('publishes from the PDF, then the video attaches to that same listing', () => {
    const slug = 'obhur-waterfront-villa';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-pdf-video-'));
    const media = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-prepared-'));
    try {
      fs.mkdirSync(path.join(tmp, 'scripts', 'curate', 'inbox'), { recursive: true });
      const picks = orderedPicks(AI.images);
      // Step 1 — the PDF: exactly what processPdf() does after writeListingImages().
      const listing = buildListing({
        ai: structuredClone(AI), images: imagesFor(slug, picks), slug, id: 'BONA-W020',
        repo: REPO, caption: {}, site: 'https://bona.azoz.uk',
        meta: { sourceRef: 'WA-20260906-VID001', messageId: 'VID001', pdfSha256: 'f'.repeat(64) },
      });
      assert.deepEqual(checkListing(listing), [], 'the PDF-derived listing publishes cleanly');
      assert.deepEqual(listing.videos, [], 'nothing yet — the video has not arrived');
      writeInboxListing(tmp, listing);
      fs.mkdirSync(path.join(tmp, 'public', 'listings', slug), { recursive: true });

      // Step 2 — the video, captioned "video BONA-W020" (see findListingId in commands.mjs),
      // after lib/video.mjs prepareVideo() has re-encoded it and cut a poster out of it.
      fs.writeFileSync(path.join(media, 'clip.mp4'), 'a whole walkthrough clip');
      fs.writeFileSync(path.join(media, 'poster.jpg'), 'its first frame');
      const res = edits.addVideo(tmp, listing.id, { file: path.join(media, 'clip.mp4'), poster: path.join(media, 'poster.jpg') });

      assert.equal(res.error, undefined);
      const expected = [{ src: `/listings/${slug}/v-01.mp4`, poster: `/listings/${slug}/v-01-poster.jpg` }];
      assert.deepEqual(res.listing.videos, expected);
      assert.deepEqual(checkListing(res.listing), [], 'still a valid listing once the video is on it');
      // The repo, not just the return value, is what a re-publish/rebuild would see.
      assert.deepEqual(findInbox(tmp, listing.id).listing.videos, expected);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(media, { recursive: true, force: true });
    }
  });
});

// After a push the listing JSON is committed, and it carries the sha256 of the PDF it came
// from. That makes the repo the durable answer to "have we published this brochure?" — the
// one that survives a state file being lost or rolled back, and the one that catches a
// listing `run-once.mjs` published without touching the daemon's state at all.
describe('findByPdfSha — the repo remembers which PDF made which listing', () => {
  const SHA = 'a'.repeat(64);
  const entry = (id, slug, sha) => ({
    id, slug, status: 'available', hidden: false,
    title: { en: slug, ar: slug }, images: [],
    _intake: { source: 'whatsapp', pdfSha256: sha },
  });
  let tmp;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-pdfsha-'));
    fs.mkdirSync(path.join(tmp, 'scripts', 'curate', 'inbox'), { recursive: true });
    writeInboxListing(tmp, entry('BONA-W007', 'obhur-villa', SHA));
    writeInboxListing(tmp, entry('BONA-W008', 'khalidiyah-flat', 'b'.repeat(64)));
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('finds the listing a brochure already produced', () => {
    assert.equal(findByPdfSha(tmp, SHA).id, 'BONA-W007');
    assert.equal(findByPdfSha(tmp, SHA).slug, 'obhur-villa');
  });

  it('says nothing for a brochure that has never been published', () => {
    assert.equal(findByPdfSha(tmp, 'c'.repeat(64)), null);
    assert.equal(findByPdfSha(tmp, null), null, 'a missing sha is not a match for a listing that has none');
  });

  it('is quiet on a repo with no inbox at all', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-pdfsha-empty-'));
    try { assert.equal(findByPdfSha(empty, SHA), null); } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  });
});

describe('replaceMetaFor (run-once --replace)', () => {
  let tmp;
  const base = (over = {}) => ({
    id: 'BONA-W023', slug: 'jeddah-heights', status: 'available', category: 'off-plan', type: 'apartment', kind: 'apartment',
    featured: false, title: { en: 'X', ar: 'س' }, location: {}, price: { amount: null, currency: 'SAR', from: false, period: null, onRequest: true },
    specs: {}, images: [], videos: [], description: {}, highlights: {}, virtualTourUrl: null, brochureUrl: null, project: null, unit: null,
    map: null, mapPrecision: null, listedAt: '2026-11-17', hidden: false, licence: null, sourceRef: 'WA-20261117-AC7D06',
    _intake: { source: 'whatsapp' }, ...over,
  });
  const put = (l) => { fs.rmSync(path.join(tmp, 'scripts', 'curate', 'inbox'), { recursive: true, force: true }); writeInboxListing(tmp, l); };
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-replace-')); });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('keeps the id, slug, date, reference and status of a listing the intake built', () => {
    put(base({ status: 'reserved' }));
    assert.deepEqual(replaceMetaFor(tmp, 'BONA-W023'), {
      replace: true, id: 'BONA-W023', slug: 'jeddah-heights', listedAt: '2026-11-17', sourceRef: 'WA-20261117-AC7D06', status: 'reserved',
    });
  });

  const refused = [
    ['a photo note', { photoNote: { en: 'Photos show the sister project', ar: 'الصور للمشروع الشقيق' } }, /hand-added field\(s\) photoNote/],
    ['an FAQ, SEO title and project facts', { faq: [], seoTitle: { en: 'a', ar: 'ب' }, projectFacts: { buildings: 2 } }, /faq, seoTitle, projectFacts/],
    ['videos', { videos: [{ src: '/listings/jeddah-heights/v-01.mp4', poster: null }] }, /1 video/],
    ['a licence', { licence: { adNumber: '7200123', adExpiry: null, wafiNumber: null, escrowAccount: null } }, /a licence/],
    ['hidden', { hidden: true }, /hidden: true/],
    ['featured', { featured: true }, /featured: true/],
    ['a virtual tour', { virtualTourUrl: 'https://my.matterport.com/show/?m=abc' }, /a virtual tour/],
    ['the owner\'s own price', { _intake: { edits: ['price'] } }, /owner's own price/],
  ];
  for (const [label, over, re] of refused) {
    it(`refuses a listing with ${label}`, () => {
      put(base(over));
      assert.throws(() => replaceMetaFor(tmp, 'BONA-W023'), re);
    });
  }

  it('refuses an id that is not in the inbox', () => {
    put(base());
    assert.throws(() => replaceMetaFor(tmp, 'BONA-W999'), /no inbox listing/);
  });

  it('unit models and the fact lists are rebuilt by the re-run, so they never block one', () => {
    put(base({
      models: [{ name: { en: 'Lulu', ar: 'لؤلؤ' }, bedrooms: 2, bathrooms: 2, areaSqm: 88, rooms: null, availability: null, price: null, subsidisedPrice: null, floorPlan: null }],
      amenities: { en: ['Gym'], ar: ['نادٍ رياضي'] }, nearby: { en: ['Airport'], ar: ['المطار'] }, warranties: { en: ['Structure — 10 years'], ar: ['الهيكل — 10 سنوات'] },
    }));
    assert.equal(replaceMetaFor(tmp, 'BONA-W023').replace, true);
  });
});

describe('run-once --enrich: enrichMetaFor, mergeEnrichment, enrichHeadline', () => {
  let tmp;
  const SHA = 'a'.repeat(64);
  const PRICED = { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false, subsidisedAmount: 270425 };
  const ON_REQUEST = { amount: null, currency: 'SAR', from: false, period: null, onRequest: true };
  /** A published listing that was corrected by hand afterwards: every key a hand edit can add. */
  const existing = (over = {}) => ({
    id: 'BONA-W023', slug: 'jeddah-heights', sourceRef: 'WA-20261117-AC7D06', status: 'reserved', category: 'off-plan', type: 'apartment',
    kind: 'apartment', featured: true, title: { en: 'Jeddah Heights (hand-fixed)', ar: 'جدة هايتس' },
    location: { district: { en: 'Al Rehab', ar: 'الرحاب' }, city: { en: 'Jeddah', ar: 'جدة' } },
    price: { ...ON_REQUEST }, specs: { beds: 2 }, images: [{ src: '/listings/jeddah-heights/01.jpg', thumb: null, alt: { en: 'a', ar: 'ب' } }],
    videos: [{ src: '/listings/jeddah-heights/v-01.mp4', poster: null }], description: { en: 'One.\n\nTwo.', ar: 'واحد.\n\nاثنان.' },
    highlights: { en: ['A', 'B', 'C', 'D'], ar: ['أ', 'ب', 'ج', 'د'] }, virtualTourUrl: null,
    brochureUrl: 'https://bona-real-estate.com/listings/jeddah-heights/brochure.pdf',
    project: { name: { en: 'Jeddah Heights', ar: 'جدة هايتس' } }, unit: null, map: null, mapPrecision: null, listedAt: '2026-11-01', hidden: false,
    licence: { adNumber: '7200123', adExpiry: null, wafiNumber: null, escrowAccount: null },
    photoNote: { en: 'Photos show the sister project', ar: 'الصور للمشروع الشقيق' }, faq: [{ q: 'x' }], seoTitle: { en: 'S', ar: 'س' },
    _intake: { source: 'whatsapp', pdfSha256: SHA, warnings: ['map-unconfirmed'], edits: ['hero'] },
    ...over,
  });
  const model = (en, price, subsidisedPrice = null) => ({
    name: { en, ar: `نموذج ${en}` }, bedrooms: 2, bathrooms: 2, areaSqm: 88, rooms: null, availability: null, price, subsidisedPrice, floorPlan: null,
  });
  const put = (l) => { fs.rmSync(path.join(tmp, 'scripts', 'curate', 'inbox'), { recursive: true, force: true }); writeInboxListing(tmp, l); };
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-enrich-')); });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('names the listing to enrich: id, slug and the listing as it stands — hand-added fields are no obstacle', () => {
    put(existing());
    const meta = enrichMetaFor(tmp, 'bona-w023');
    assert.deepEqual(Object.keys(meta), ['enrich']);
    assert.equal(meta.enrich.id, 'BONA-W023');
    assert.equal(meta.enrich.slug, 'jeddah-heights');
    assert.deepEqual(meta.enrich.existing, existing());
  });

  const refused = [
    ['an id that is not in the inbox', null, 'BONA-W999', /--enrich BONA-W999: no inbox listing/],
    ['a withdrawn listing (its record)', { status: 'withdrawn' }, 'BONA-W023', /--enrich BONA-W023: .*withdrawn/],
    ['a withdrawn project (rules.mjs)', { id: 'BONA-W009', slug: 'elvira-murjan-townhouses-in-al-murjan' }, 'BONA-W009', /--enrich BONA-W009: marketing permission withdrawn/],
    ['a hidden listing', { hidden: true }, 'BONA-W023', /--enrich BONA-W023: it is hidden/],
    ['a listing that records no source PDF', { _intake: { source: 'whatsapp' } }, 'BONA-W023', /--enrich BONA-W023: .*no source PDF/],
  ];
  for (const [label, over, id, re] of refused) {
    it(`refuses ${label}`, () => {
      put(existing(over ?? {}));
      assert.throws(() => enrichMetaFor(tmp, id), re);
    });
  }

  it('ENRICH_KEYS: the unit models and the three fact lists, nothing else', () => {
    assert.deepEqual(ENRICH_KEYS, ['models', 'amenities', 'nearby', 'warranties']);
  });

  describe('mergeEnrichment', () => {
    /** A buildListing() result for the same brochure: its copy, photos and price all differ from the listing's. */
    const built = () => buildListing({
      ai: {
        ...AI,
        listing: { ...AI.listing, category: 'off-plan', type: 'apartment', price: { ...PRICED } },
        models: [model('Lulu', 319015, 270425)],
        amenities: { en: ['Gym'], ar: ['نادٍ رياضي'] }, nearby: { en: [], ar: [] }, warranties: { en: ['Structure — 10 years'], ar: ['الهيكل — 10 سنوات'] },
      },
      images: imagesFor('jeddah-heights', [{ rank: 1, index: 4, room: 'pool' }]), slug: 'jeddah-heights', id: 'BONA-W023', repo: REPO, site: 'https://x',
    });

    it('changes ONLY the unit models and the fact lists; every other key is the listing\'s own, unchanged', () => {
      const before = existing();
      const b = built();
      const merged = mergeEnrichment(before, b);
      assert.deepEqual(before, existing(), 'the listing passed in is not changed');
      assert.deepEqual(merged.models, b.models);
      assert.deepEqual(merged.amenities, { en: ['Gym'], ar: ['نادٍ رياضي'] });
      assert.deepEqual(merged.warranties, b.warranties);
      assert.equal('nearby' in merged, false, 'an empty fact list is left out');
      for (const k of Object.keys(before)) assert.deepEqual(merged[k], before[k], k);
      assert.deepEqual(Object.keys(merged).filter((k) => !ENRICH_KEYS.includes(k)), Object.keys(before), 'same keys, same order');
      merged.models[0].name.en = 'changed';
      assert.equal(b.models[0].name.en, 'Lulu', 'nothing is shared with the built listing');
      merged.title.en = 'changed';
      assert.equal(before.title.en, 'Jeddah Heights (hand-fixed)', 'nothing is shared with the listing either');
    });

    it('puts new keys after the highlights, where a publish puts them, so the file keeps its shape', () => {
      const keys = Object.keys(mergeEnrichment(existing(), built()));
      const at = keys.indexOf('highlights');
      assert.deepEqual(keys.slice(at, at + 4), ['highlights', 'models', 'amenities', 'warranties']);
    });

    it('replaces models and fact lists already there in their own place, and removes those the new run does not have', () => {
      const before = existing({ nearby: { en: ['Airport'], ar: ['المطار'] }, models: [model('Old', null)] });
      const merged = mergeEnrichment(before, built());
      assert.equal('nearby' in merged, false);
      assert.deepEqual(merged.models.map((m) => m.name.en), ['Lulu']);
      const none = mergeEnrichment(before, { ...built(), models: undefined, amenities: undefined, warranties: undefined });
      for (const k of ENRICH_KEYS) assert.equal(k in none, false, k);
    });

    it('takes the price only when told to, and never the built listing\'s brochureUrl', () => {
      const b = built();
      assert.deepEqual(mergeEnrichment(existing(), b).price, ON_REQUEST);
      const adopted = mergeEnrichment(existing(), b, { price: { ...PRICED } });
      assert.deepEqual(adopted.price, PRICED);
      assert.equal(adopted.brochureUrl, existing().brochureUrl);
      assert.deepEqual(adopted._intake, existing()._intake);
    });
  });

  describe('enrichHeadline', () => {
    const models = [model('Nawras', 419994, 356024), model('Lulu', 319015, 270425)];
    const aligned = () => alignHeadline({ ...ON_REQUEST }, models);

    it('the owner set the price by WhatsApp: his price stays and the models lose theirs', () => {
      const l = existing({ price: { amount: 300000, currency: 'SAR', from: false, period: null, onRequest: false }, _intake: { pdfSha256: SHA, edits: ['hero', 'price'] } });
      const h = enrichHeadline(l, models, aligned());
      assert.equal(h.refuse, null);
      assert.equal(h.dropModelPrices, true);
      assert.deepEqual(h.price, l.price);
    });

    it('a listing on request adopts the models\' confirmed headline', () => {
      const h = enrichHeadline(existing(), models, aligned());
      assert.deepEqual(h, { price: PRICED, dropModelPrices: false, refuse: null, decision: 'adopted' });
    });

    it('a price that equals the lowest model price (and its Sakani line) is kept', () => {
      const l = existing({ price: { ...PRICED } });
      const h = enrichHeadline(l, models, aligned());
      assert.deepEqual(h, { price: PRICED, dropModelPrices: false, refuse: null, decision: 'kept' });
    });

    it('the same figure not yet marked "from" is kept and marked "from" (the validator\'s rule)', () => {
      const l = existing({ price: { ...PRICED, from: false } });
      const h = enrichHeadline(l, models, aligned());
      assert.equal(h.refuse, null);
      assert.deepEqual(h.price, PRICED);
    });

    it('a different price is refused with both figures', () => {
      const l = existing({ price: { amount: 350000, currency: 'SAR', from: false, period: null, onRequest: false } });
      const h = enrichHeadline(l, models, aligned());
      assert.equal(h.decision, 'refused');
      assert.match(h.refuse, /BONA-W023 shows SAR 350,000 but the brochure's lowest model price is SAR 319,015/);
      assert.match(h.refuse, /send `price BONA-W023 …` or re-run with --replace/);
      assert.deepEqual(h.price, l.price, 'nothing changes');
    });

    it('the same price with a different Sakani line is refused too', () => {
      for (const sub of [undefined, 280000]) {
        const price = { ...PRICED };
        if (sub === undefined) delete price.subsidisedAmount; else price.subsidisedAmount = sub;
        const h = enrichHeadline(existing({ price }), models, aligned());
        assert.equal(h.decision, 'refused', String(sub));
        assert.match(h.refuse, /Sakani SAR 270,425/);
      }
    });

    it('no model kept a price: the listing\'s price stays as it is, set or on request', () => {
      const unpriced = [model('Lulu', null)];
      for (const price of [{ ...ON_REQUEST }, { amount: 350000, currency: 'SAR', from: false, period: null, onRequest: false }]) {
        const h = enrichHeadline(existing({ price }), unpriced, null);
        assert.deepEqual(h, { price, dropModelPrices: false, refuse: null, decision: 'no-model-prices' });
      }
    });

    it('one specific unit keeps its own price, and its models keep theirs (the validator exempts units)', () => {
      const l = existing({ price: { amount: 350000, currency: 'SAR', from: false, period: null, onRequest: false }, unit: { floor: 3, block: 'H', unitRef: null } });
      const h = enrichHeadline(l, models, aligned());
      assert.deepEqual(h, { price: l.price, dropModelPrices: false, refuse: null, decision: 'unit' });
    });

    it('a single property (no project, or one model) keeps its own price and its models keep theirs (single-property)', () => {
      const own = { amount: 350000, currency: 'SAR', from: false, period: null, onRequest: false };
      for (const [label, l, m] of [['no project', existing({ price: own, project: null }), models], ['one model', existing({ price: own }), [models[1]]]]) {
        const one = m.length === 1 ? alignHeadline({ ...ON_REQUEST }, m) : aligned();
        assert.deepEqual(enrichHeadline(l, m, one), { price: own, dropModelPrices: false, refuse: null, decision: 'single-property' }, label);
      }
      // On request too: nothing is adopted from a single property's models.
      const onReq = existing({ project: null });
      assert.equal(enrichHeadline(onReq, models, aligned()).decision, 'single-property');
      assert.equal(enrichHeadline(onReq, [model('Lulu', null)], null).decision, 'no-model-prices');
    });

    it('model prices in another currency than the listing\'s: the price stays and the models lose theirs (currency-mismatch)', () => {
      for (const l of [existing(), existing({ price: { ...PRICED } }), existing({ price: { ...PRICED }, unit: { floor: 3, block: 'H', unitRef: null } })]) {
        const h = enrichHeadline(l, models, aligned(), { currencyMismatch: true });
        assert.deepEqual(h, { price: l.price, dropModelPrices: true, refuse: null, decision: 'currency-mismatch' });
      }
      // The owner's own price says more: his price stays, the models lose theirs, whatever their currency.
      const own = existing({ price: { amount: 300000, currency: 'SAR', from: false, period: null, onRequest: false }, _intake: { pdfSha256: SHA, edits: ['price'] } });
      assert.equal(enrichHeadline(own, models, aligned(), { currencyMismatch: true }).decision, 'owner-price');
    });
  });
});

describe('r3 #9: an inbox record that is a symlink, or a listing folder that is one — no edit writes through it', () => {
  const slug = 'link-villa-test';
  let tmp;
  const record = () => path.join(tmp, 'repo', 'scripts', 'curate', 'inbox', `${slug}.json`);
  const folder = () => path.join(tmp, 'repo', 'public', 'listings', slug);
  const setup = ({ linkRecord = false, linkFolder = false } = {}) => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-link-'));
    const repo = path.join(tmp, 'repo');
    const l = {
      id: 'BONA-W001', slug, status: 'available', hidden: false, title: { en: 'Link Villa', ar: 'فيلا' },
      price: { amount: 1000000, currency: 'SAR', from: false, period: null, onRequest: false }, brochureUrl: null, videos: [],
      images: [1, 2, 3, 4].map((n) => ({ src: `/listings/${slug}/0${n}.jpg`, thumb: null, alt: { en: 'x', ar: 'س' } })),
      _intake: { images: [1, 2, 3, 4].map((n) => ({ n, room: 'view' })) },
    };
    writeInboxListing(repo, l);
    fs.mkdirSync(folder(), { recursive: true });
    for (const n of [1, 2, 3, 4]) fs.writeFileSync(path.join(folder(), `0${n}.jpg`), 'x');
    if (linkRecord) {
      fs.renameSync(record(), path.join(tmp, 'outside.json'));
      fs.symlinkSync(path.join(tmp, 'outside.json'), record());
    }
    if (linkFolder) {
      fs.renameSync(folder(), path.join(tmp, 'outside-folder'));
      fs.symlinkSync(path.join(tmp, 'outside-folder'), folder());
    }
    return repo;
  };
  const snapshot = () => fs.readdirSync(tmp, { recursive: true }).sort().map((f) => {
    const p = path.join(tmp, String(f));
    return fs.lstatSync(p).isFile() ? `${f}:${fs.readFileSync(p, 'utf8')}` : String(f);
  }).join('\n');
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('the record is a symlink: hero, price, status, hide, video, brochure, remove refuse — nothing changes', async () => {
    const repo = setup({ linkRecord: true });
    const clip = path.join(tmp, 'clip.mp4');
    fs.writeFileSync(clip, 'mp4');
    const before = snapshot();
    const results = [
      edits.setHero(repo, 'BONA-W001', 2), edits.setPrice(repo, 'BONA-W001', { amount: 5, currency: 'SAR' }),
      await edits.setPriceWithBrochure(repo, 'BONA-W001', { onRequest: true }, { cfg: {}, workDir: path.join(tmp, 'w') }),
      edits.setStatus(repo, 'BONA-W001', 'sold'), edits.setHidden(repo, 'BONA-W001', true), edits.addVideo(repo, 'BONA-W001', { file: clip }),
      await edits.rebuildBrochure(repo, 'BONA-W001', { cfg: {}, workDir: path.join(tmp, 'w') }), edits.removeListing(repo, 'BONA-W001'),
      edits.setLicence(repo, 'BONA-W001', { adNumber: '7200123456', adExpiry: '2027-01-01' }),
    ];
    for (const [i, r] of results.entries()) assert.match(String(r?.error), /symbolic link/, `call ${i}`);
    assert.equal(snapshot(), before);
  });

  it('the listing folder is a symlink: hero, video and remove refuse — nothing changes', () => {
    const repo = setup({ linkFolder: true });
    const clip = path.join(tmp, 'clip.mp4');
    fs.writeFileSync(clip, 'mp4');
    const before = snapshot();
    for (const r of [edits.setHero(repo, 'BONA-W001', 2), edits.addVideo(repo, 'BONA-W001', { file: clip }), edits.removeListing(repo, 'BONA-W001')]) {
      assert.match(String(r?.error), /symbolic link/);
    }
    assert.equal(snapshot(), before);
  });

  it('index.mjs answers a refused `remove` instead of committing it', () => {
    const index = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs'), 'utf8');
    const removeCase = index.slice(index.indexOf("case 'remove': {"), index.indexOf("case 'hero': {"));
    assert.match(removeCase, /res\?\.error/);
  });
});
