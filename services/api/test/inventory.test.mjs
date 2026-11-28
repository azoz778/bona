import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createInventory, WORKTREE_LISTINGS, formatPrice, parsePriceValue, toCard, toToolRow,
  search, findOne, normalise, tokenise, absoluteUrl, kindOf, resolveInventoryFile, STAT_MS, pinOf, DETAILS_MAX_CHARS, typeLabel,
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

test('a publish is picked up from the file\'s mtime, within half a minute', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-inv-'));
  const file = path.join(dir, 'listings.json');
  const row = (id) => ({ id, slug: id.toLowerCase(), title: { en: id, ar: id }, location: { district: {} }, price: {}, specs: {}, images: [] });
  fs.writeFileSync(file, JSON.stringify([row('A')]));

  let t = 0;
  let stats = 0;
  const hot = createInventory({
    file,
    reloadMs: 10 * 60 * 1000,
    now: () => t,
    read: (f) => { stats += 1; return JSON.parse(fs.readFileSync(f, 'utf8')); },
  });
  assert.equal(hot.count(), 1);

  // The intake publishes a second listing, well inside the 10 minute interval.
  fs.writeFileSync(file, JSON.stringify([row('A'), row('B')]));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));

  assert.equal(hot.count(), 1, 'the mtime is not stat-ed on every single request');
  t = STAT_MS + 1;
  assert.equal(hot.count(), 2, 'one cheap stat later, the new listing is live');

  const before = stats;
  t += 1;
  hot.count();
  assert.equal(stats, before, 'and it does not re-read the file on every call after that');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an inventory whose first load produced nothing reports itself unhealthy', () => {
  const broken = createInventory({ file: '/virtual.json', read: () => { throw new Error('bad json'); } });
  assert.equal(broken.count(), 0);
  assert.equal(broken.ok(), false, 'serving an empty portfolio quietly is the failure mode');

  const empty = createInventory({ file: '/virtual.json', read: () => [] });
  assert.equal(empty.ok(), false);
});

test('a healthy inventory says so, and recovers if the file arrives late', () => {
  assert.equal(inv.ok(), true);

  let rows = [];
  let t = 0;
  const late = createInventory({ file: '/virtual.json', reloadMs: 100, now: () => t, read: () => rows });
  assert.equal(late.ok(), false);
  rows = [{ id: 'A', slug: 'a', title: {}, location: { district: {} }, price: {}, specs: {}, images: [] }];
  t = 200;
  assert.equal(late.ok(), true, 'once the publisher finishes, health comes back on its own');
});

/* ---------------- PR-B4 (PLAN T13 tests 1 and 3; DESIGN §4.3, brain/DESIGN-brain.md §5.2) ---------------- */

/** main 7165b3a's toToolRow, copied: the row every caller but the brain route still gets (PR-B4 r2, Codex r1 P0). */
const mainRow = (listing, { siteUrl = 'https://bona.azoz.uk' } = {}) => {
  const card = toCard(listing, { siteUrl });
  return {
    id: card.id, slug: card.slug, title_en: card.title.en, title_ar: card.title.ar, type: typeLabel(listing.type, 'en'), category: listing.category,
    district_en: card.district.en, district_ar: card.district.ar, city: listing.location?.city?.en ?? null, price_en: card.price.en,
    price_ar: card.price.ar, beds: card.beds, baths: card.baths, area_sqm: card.areaSqm, url_en: card.url.en, url_ar: card.url.ar,
  };
};

test("toToolRow without the assistant flag is main's row byte for byte, for every real listing (the concierge, the legacy WhatsApp agent, the phone line)", () => {
  const site = { siteUrl: 'https://bona.azoz.uk' };
  for (const l of all) {
    assert.equal(JSON.stringify(toToolRow(l, site)), JSON.stringify(mainRow(l, site)), l.id);
    assert.equal(JSON.stringify(inv.row(l)), JSON.stringify(mainRow(l, site)), `${l.id} through inventory.row`);
  }
  assert.deepEqual(Object.keys(toToolRow(all[0], site)), ['id', 'slug', 'title_en', 'title_ar', 'type', 'category', 'district_en', 'district_ar', 'city',
    'price_en', 'price_ar', 'beds', 'baths', 'area_sqm', 'url_en', 'url_ar']);
});

test('toToolRow gains has_brochure, pin, lat/lng only for an exact pin, and city (no brochure_mb: listings.json has no size, #18)', () => {
  const site = { siteUrl: 'https://bona.azoz.uk', assistant: true };
  const exact = all.find((l) => l.mapPrecision === 'exact' && l.map);
  const district = all.find((l) => l.mapPrecision === 'district' && l.map);
  const none = all.find((l) => !l.mapPrecision);
  const withBrochure = all.find((l) => l.brochureUrl);
  const without = all.find((l) => !l.brochureUrl);
  const e = toToolRow(exact, site);
  assert.equal(e.pin, 'exact');
  assert.equal(e.lat, exact.map.lat);
  assert.equal(e.lng, exact.map.lng);
  assert.equal(e.city, exact.location.city.en);
  const d = toToolRow(district, site);
  assert.equal(d.pin, 'district');
  assert.equal('lat' in d || 'lng' in d, false, 'a district centroid is never a pin');
  const n = toToolRow(none, site);
  assert.equal(n.pin, 'none');
  assert.equal('lat' in n || 'lng' in n, false);
  assert.equal(toToolRow(withBrochure, site).has_brochure, true);
  assert.equal(toToolRow(without, site).has_brochure, false);
  for (const l of all) {
    const row = toToolRow(l, site);
    assert.equal('brochure_mb' in row || 'brochureUrl' in row || 'brochure_url' in row, false, l.id);
    assert.ok(['exact', 'district', 'none'].includes(row.pin), l.id);
  }
  // An "exact" pin without usable coordinates is no pin.
  assert.equal(pinOf({ mapPrecision: 'exact', map: null }), 'none');
  assert.equal(pinOf({ mapPrecision: 'exact', map: { lat: 'x', lng: 39 } }), 'none');
  assert.equal(pinOf({ mapPrecision: 'exact', map: { lat: 99, lng: 39 } }), 'none');
  assert.equal(pinOf({ mapPrecision: 'district', map: null }), 'district');
  assert.equal(pinOf(null), 'none');
  // The worst five rows still fit the 4,000-character tool result.
  const widest = [...all].map((l) => JSON.stringify(toToolRow(l, site))).sort((a, b) => b.length - a.length).slice(0, 5);
  assert.ok(`[${widest.join(',')}]`.length < 4000, 'five rows fit the tool result cap');
  assert.deepEqual(Object.keys(inv.row(exact, { assistant: true })).slice(-4), ['has_brochure', 'pin', 'lat', 'lng'], 'inventory.row passes the flag');
});

test('pinOf is the same rule as the booking confirmation (lib/viewing.mjs pinOf) on every real listing', async () => {
  const { pinOf: viewingPin } = await import('../lib/viewing.mjs');
  for (const l of all) assert.equal(pinOf(l), viewingPin(l), l.id);
});

/** Field names verified on the real src/data/listings.json (PLAN T13 test 1: "[verify the field names on the real file]"). */
test('the listing fields listing_details reads exist on the real listings.json under these names', () => {
  const has = (k) => all.filter((l) => l[k] != null);
  for (const l of all) {
    for (const k of ['id', 'slug', 'kind', 'status']) assert.equal(typeof l[k], 'string', `${l.id}.${k}`);
    for (const k of ['title', 'description', 'highlights']) assert.ok(l[k]?.en != null && l[k]?.ar != null, `${l.id}.${k}.{en,ar}`);
    assert.ok(l.location?.district?.en && l.location?.city?.en, `${l.id}.location.district / .city`);
  }
  assert.ok(has('amenities').length > 0 && has('amenities').every((l) => Array.isArray(l.amenities.en) && Array.isArray(l.amenities.ar)));
  assert.ok(has('nearby').length > 0 && has('nearby').every((l) => Array.isArray(l.nearby.en) && Array.isArray(l.nearby.ar)));
  assert.ok(has('projectFacts').length > 0 && has('projectFacts').every((l) => typeof l.projectFacts === 'object'));
  assert.ok(has('faq').length > 0 && has('faq').every((l) => Array.isArray(l.faq) && l.faq.every((f) => f.q?.en && Array.isArray(f.a?.en))));
});

test('listing_details: one published listing in the requested language, listings.json only; clipped to 3,800 characters; unknown → {found:false}', () => {
  const w003 = all.find((l) => l.id === 'BONA-W003');
  const en = inv.details('BONA-W003', 'en');
  assert.deepEqual(Object.keys(en), ['found', 'id', 'title', 'district', 'city', 'kind', 'status', 'description', 'highlights', 'amenities', 'projectFacts', 'nearby', 'faq', 'url']);
  assert.equal(en.found, true);
  assert.equal(en.title, w003.title.en);
  assert.equal(en.district, w003.location.district.en);
  assert.equal(en.city, w003.location.city.en);
  assert.equal(en.kind, w003.kind);
  assert.equal(en.status, w003.status);
  assert.equal(en.description, w003.description.en);
  assert.deepEqual(en.highlights, w003.highlights.en);
  assert.deepEqual(en.amenities, w003.amenities.en);
  assert.deepEqual(en.nearby, w003.nearby.en);
  assert.equal(en.url, toCard(w003, { siteUrl: 'https://bona.azoz.uk' }).url.en);
  const ar = inv.details('bona-w003', 'ar');
  assert.equal(ar.title, w003.title.ar);
  assert.equal(ar.district, w003.location.district.ar);
  assert.deepEqual(ar.highlights, w003.highlights.ar);
  assert.equal(ar.url, toCard(w003, { siteUrl: 'https://bona.azoz.uk' }).url.ar);
  assert.equal(inv.details('BONA-W003').title, w003.title.en, 'English unless Arabic is asked for');
  // The project facts and the FAQ (today only BONA-W014 has them). An answer that needs the unit sheet's figures
  // ({sheetDate}, {cashFrom}, …) is dropped whole, as the site drops it without a sheet: units.json is never read.
  const w014 = all.find((l) => l.id === 'BONA-W014');
  const p = inv.details('BONA-W014', 'en');
  assert.deepEqual(p.projectFacts, w014.projectFacts);
  const plain = w014.faq.filter((f) => !/\{\w+\}/.test(f.a.en.join(' ')));
  assert.ok(plain.length > 0 && plain.length < w014.faq.length, 'the fixture has both kinds');
  assert.deepEqual(p.faq, plain.map((f) => ({ q: f.q.en, a: f.a.en.join(' ') })));
  assert.equal(inv.details('BONA-W014', 'ar').faq[0].q, plain[0].q.ar);
  // Unknown, blank, a title, a slug-less entry: not found.
  for (const id of ['BONA-W999', '', null, undefined, 'Al Shati', 'BONA-W00']) assert.deepEqual(inv.details(id, 'en'), { found: false }, String(id));
  const noSlug = createInventory({ file: '/v.json', read: () => [{ ...w003, slug: '' }] });
  assert.deepEqual(noSlug.details('BONA-W003', 'en'), { found: false }, 'no page, not published');
});

test('listing_details on every real listing, both languages: ≤ 3,800 characters, no unit ref, no plan key, no unfilled placeholder, nothing of units.json', () => {
  const units = JSON.parse(fs.readFileSync(new URL('../../../src/data/units.json', import.meta.url), 'utf8'));
  const sheet = [units].flat().flatMap((r) => r?.units ?? []);
  // Every unit price of the sheet except a cash price equal to the listing's own published "from" price (the
  // description quotes that one, as the page does). Booleans only: these are real figures (public CI logs).
  const unitPrices = (l) => new Set(sheet.flatMap((u) => Object.entries(u.price ?? {}))
    .filter(([plan, n]) => typeof n === 'number' && !(plan === 'cash' && n === l.price?.amount)).map(([, n]) => n.toLocaleString('en-US')));
  for (const l of all) {
    for (const lang of ['en', 'ar']) {
      const d = inv.details(l.id, lang);
      const raw = JSON.stringify(d);
      assert.equal(d.found, true, l.id);
      assert.ok(raw.length <= 3800, `${l.id} ${lang}: ${raw.length} characters`);
      assert.ok(!/\bB\d{2}-\d+\b/.test(raw), `${l.id} ${lang}: a unit reference`);
      assert.ok(!/"(plan|plans|cash|half|year|twoYear|price|price_en|price_ar|units|availability)"\s*:/.test(raw), `${l.id} ${lang}: a plan or price key`);
      assert.ok(!/\{(?:cashFrom|count|areaMin|areaMax|sheetDate|delivery)\}/.test(raw), `${l.id} ${lang}: an unfilled sheet placeholder`);
      for (const price of unitPrices(l)) assert.ok(!raw.includes(price), `${l.id} ${lang}: an unpublished units.json price`);
    }
  }
});

test('listing_details clips a long listing to 3,800 characters: the FAQ, then the lists, then the description, never the title or the link', () => {
  const big = { ...all.find((l) => l.id === 'BONA-W003'), id: 'BONA-W950', slug: 'example-big',
    description: { en: 'Word '.repeat(2000), ar: 'كلمة '.repeat(2000) },
    highlights: { en: Array.from({ length: 40 }, (_, i) => `Highlight number ${i} of a long list`), ar: [] },
    faq: Array.from({ length: 30 }, (_, i) => ({ id: `q${i}`, q: { en: `Question ${i}?`, ar: `سؤال ${i}؟` }, a: { en: ['An answer. '.repeat(20)], ar: ['جواب. '.repeat(20)] } })) };
  const huge = createInventory({ file: '/v.json', read: () => [big] });
  for (const lang of ['en', 'ar']) {
    const d = huge.details('BONA-W950', lang);
    const raw = JSON.stringify(d);
    assert.ok(raw.length <= 3800, `${lang}: ${raw.length}`);
    assert.equal(d.found, true);
    assert.equal(d.title, big.title[lang]);
    assert.ok(d.url.endsWith(lang === 'ar' ? '/ar/properties/example-big/' : '/properties/example-big/'));
    assert.ok(d.description.length > 200, 'the description keeps a real part');
    assert.ok(d.description.endsWith('…'), 'a clipped description says so');
  }
  assert.equal(DETAILS_MAX_CHARS, 3800);
});
