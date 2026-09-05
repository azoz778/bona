import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInventory, WORKTREE_LISTINGS, formatPrice, parsePriceValue, toCard, toToolRow,
  search, findOne, normalise, tokenise, absoluteUrl, kindOf, resolveInventoryFile,
} from '../lib/inventory.mjs';

const inv = createInventory({ file: WORKTREE_LISTINGS, siteUrl: 'https://bona.azoz.uk' });
const all = inv.all();

test('inventory loads the generated listings.json', () => {
  assert.ok(all.length >= 20, `expected a real portfolio, got ${all.length}`);
  assert.ok(all.every((l) => l.id && l.slug && l.title?.en && l.title?.ar));
});

test('resolveInventoryFile honours BONA_INVENTORY_FILE, then BONA_REPO, then the worktree', () => {
  assert.equal(resolveInventoryFile({ BONA_INVENTORY_FILE: '/tmp/x.json' }), '/tmp/x.json');
  assert.equal(
    resolveInventoryFile({ BONA_REPO: '/home/x/bona-bot' }, { exists: () => true }),
    '/home/x/bona-bot/src/data/listings.json',
  );
  assert.equal(resolveInventoryFile({ BONA_REPO: '/nope' }, { exists: () => false }), WORKTREE_LISTINGS);
});

test('formatPrice mirrors src/lib/i18n.ts in both locales', () => {
  const p = { amount: 6_700_000, currency: 'SAR', from: false, period: null, onRequest: false };
  assert.equal(formatPrice(p, 'en'), 'SAR 6,700,000');
  assert.equal(formatPrice(p, 'ar'), '6,700,000 ر.س');
  assert.equal(formatPrice({ ...p, from: true }, 'en'), 'From SAR 6,700,000');
  assert.equal(formatPrice({ ...p, period: 'year' }, 'ar'), '6,700,000 ر.س / سنوياً');
  assert.equal(formatPrice({ amount: 1_200_000, currency: 'EUR' }, 'en'), '€1,200,000');
});

test('never invents a price: on-request and null amounts stay on request', () => {
  assert.equal(formatPrice({ amount: null, currency: 'SAR' }, 'en'), 'Price on request');
  assert.equal(formatPrice({ amount: null, currency: 'SAR' }, 'ar'), 'السعر عند الطلب');
  assert.equal(formatPrice({ amount: 5, currency: 'SAR', onRequest: true }, 'ar'), 'السعر عند الطلب');
  assert.equal(formatPrice(null, 'en'), 'Price on request');
});

test('price parsing: latin shorthand, grouped digits, Arabic words and Arabic-Indic digits', () => {
  assert.equal(parsePriceValue('4.5m'), 4_500_000);
  assert.equal(parsePriceValue('750k'), 750_000);
  assert.equal(parsePriceValue('4,500,000'), 4_500_000);
  assert.equal(parsePriceValue('SAR 1.2 billion'), 1_200_000_000);
  assert.equal(parsePriceValue('5 million'), 5_000_000);
  assert.equal(parsePriceValue('٤ ملايين'), 4_000_000);
  assert.equal(parsePriceValue('٤٫٥ مليون'), 4_500_000);
  assert.equal(parsePriceValue('٥٠٠ الف'), 500_000);
  assert.equal(parsePriceValue('بمليونين'), 2_000_000);
  assert.equal(parsePriceValue(1_750_000), 1_750_000);
});

test('price parsing refuses to guess', () => {
  for (const junk of [null, undefined, '', '   ', 'abc', 'فيلا في الخالدية', NaN]) {
    assert.equal(parsePriceValue(junk), null, `expected null for ${JSON.stringify(junk)}`);
  }
});

test('normalise folds Arabic orthography and Arabic-Indic digits', () => {
  assert.equal(normalise('الخالديّة'), normalise('الخالدية'));
  assert.equal(normalise('إبحر'), normalise('ابحر'));
  assert.equal(normalise('٢٠٢٦'), '2026');
  assert.deepEqual(tokenise('villa in Al Khalidiyah'), ['villa', 'khalidiyah']);
  assert.ok(tokenise('ابغى شقة في النزهة').includes('نزهه'));
});

test('search: English free text finds the right district', () => {
  const hits = search(all, { query: 'villa in Al Khalidiyah' });
  assert.ok(hits.length > 0);
  assert.equal(hits[0].location.district.en, 'Al Khalidiyah');
  assert.ok(hits.length <= 5, 'default limit is 5');
});

test('search: Arabic free text finds the right district', () => {
  const hits = search(all, { query: 'شقة في النزهة' });
  assert.ok(hits.length > 0);
  assert.ok(hits.every((l) => l.location.district.ar === 'النزهة'));
});

test('search: structured filters compose', () => {
  const apartments = search(all, { kind: 'apartment', category: 'buy', maxPrice: '1m', limit: 20 });
  assert.ok(apartments.length > 0);
  assert.ok(apartments.every((l) => l.kind === 'apartment' && l.category === 'buy' && l.price.amount <= 1_000_000));

  const beds = search(all, { beds: 5, limit: 20 });
  assert.ok(beds.length > 0);
  assert.ok(beds.every((l) => (l.specs.beds ?? 0) >= 5));

  assert.deepEqual(search(all, { district: 'Atlantis' }), []);
});

test('search: sold listings are hidden unless asked for', () => {
  const withSold = [...all, { ...all[0], id: 'X-SOLD', slug: 'x-sold', status: 'sold' }];
  assert.ok(!search(withSold, { query: all[0].title.en, limit: 20 }).some((l) => l.id === 'X-SOLD'));
  assert.ok(search(withSold, { query: all[0].title.en, includeSold: true, limit: 20 }).some((l) => l.id === 'X-SOLD'));
});

test('findOne resolves id, slug and a trailing-slash URL path', () => {
  const l = all[0];
  assert.equal(findOne(all, l.id)?.slug, l.slug);
  assert.equal(findOne(all, l.slug)?.id, l.id);
  assert.equal(findOne(all, l.id.toLowerCase())?.id, l.id);
  assert.equal(findOne(all, `/properties/${l.slug}/`)?.id, l.id);
  assert.equal(findOne(all, 'no-such-thing-at-all'), null);
});

test('Card has the exact shape the widget consumes, in both locales', () => {
  const l = all.find((x) => x.id === 'BONA-005') ?? all[0];
  const card = toCard(l, { siteUrl: 'https://bona.azoz.uk' });
  assert.deepEqual(Object.keys(card).sort(),
    ['areaSqm', 'baths', 'beds', 'district', 'id', 'image', 'price', 'slug', 'title', 'url'].sort());
  assert.equal(card.url.en, `https://bona.azoz.uk/properties/${l.slug}/`);
  assert.equal(card.url.ar, `https://bona.azoz.uk/ar/properties/${l.slug}/`);
  assert.equal(typeof card.price.en, 'string');
  assert.equal(typeof card.price.ar, 'string');
  assert.ok(card.title.ar && card.district.ar);
  assert.ok(/^https?:\/\//.test(card.image.src));
});

test('local /listings and /land images become absolute; remote ones are untouched', () => {
  assert.equal(absoluteUrl('/listings/x/01.jpg', 'https://bona.azoz.uk/'), 'https://bona.azoz.uk/listings/x/01.jpg');
  assert.equal(absoluteUrl('/land/plot-1.jpg', 'https://bona.azoz.uk'), 'https://bona.azoz.uk/land/plot-1.jpg');
  assert.equal(absoluteUrl('https://cdn.example/a.jpg', 'https://bona.azoz.uk'), 'https://cdn.example/a.jpg');
  assert.equal(absoluteUrl(null, 'https://bona.azoz.uk'), null);

  const local = { ...all[0], images: [{ src: '/listings/demo/01.jpg', thumb: '/listings/demo/01-thumb.webp' }] };
  const card = toCard(local, { siteUrl: 'https://bona.azoz.uk' });
  assert.equal(card.image.src, 'https://bona.azoz.uk/listings/demo/01.jpg');
  assert.equal(card.image.thumb, 'https://bona.azoz.uk/listings/demo/01-thumb.webp');
});

test('tool rows stay small and carry both languages', () => {
  const row = toToolRow(all[0], { siteUrl: 'https://bona.azoz.uk' });
  assert.ok(row.title_en && row.title_ar && row.price_en && row.price_ar && row.url_en);
  assert.ok(JSON.stringify([row, row, row, row, row]).length < 4000, 'five rows must fit Retell’s ~4000 char tool result cap');
});

test('kindOf prefers the explicit kind and falls back to the type map', () => {
  assert.equal(kindOf({ kind: 'apartment', type: 'villa' }), 'apartment');
  assert.equal(kindOf({ type: 'penthouse' }), 'apartment');
  assert.equal(kindOf({ type: 'plot' }), 'land');
  assert.equal(kindOf({ type: 'nonsense' }), 'house');
});

test('inventory hot-reloads when the file changes after the interval', () => {
  let payload = [{ id: 'A', slug: 'a', title: { en: 'A', ar: 'أ' }, location: { district: {} }, price: {}, specs: {}, images: [] }];
  let t = 0;
  const hot = createInventory({ file: '/virtual.json', reloadMs: 1000, now: () => t, read: () => payload });
  assert.equal(hot.count(), 1);
  payload = [...payload, { ...payload[0], id: 'B', slug: 'b' }];
  t = 500;
  assert.equal(hot.count(), 1, 'no reload before the interval');
  t = 2000;
  assert.equal(hot.count(), 2, 'reloaded after the interval');
});

test('a broken listings.json keeps the last good copy', () => {
  let ok = true;
  let t = 0;
  const hot = createInventory({
    file: '/virtual.json', reloadMs: 10, now: () => t,
    read: () => { if (!ok) throw new Error('bad json'); return [{ id: 'A', slug: 'a', title: {}, location: { district: {} }, price: {}, specs: {}, images: [] }]; },
  });
  assert.equal(hot.count(), 1);
  ok = false; t = 100;
  assert.equal(hot.count(), 1);
  assert.match(String(hot.lastError?.message), /bad json/);
});
