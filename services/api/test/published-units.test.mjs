// lib/published-units.mjs: search_units quotes what the LIVE listing page publishes (DESIGN §4.5), read from the
// page's data-units-summary attribute (src/components/ProjectDetails.astro). Fake fetch only: no test touches the
// network. Every figure here is made up (example.com site, invented areas and prices).
import assert from 'node:assert/strict';
import test from 'node:test';
import * as publishedUnitsModule from '../lib/published-units.mjs';
import {
  createPublishedUnits, decodeEntities, isBedLabel, listingPageUrl, parsePublishedUnits,
  DEFAULT_SITE, FETCH_TIMEOUT_MS, MAX_PAGE_BYTES,
} from '../lib/published-units.mjs';

const SITE = 'https://site.example.com';
const LISTING = { id: 'BONA-W014', slug: 'darco-prime-waterfront-fixture', status: 'available' };
const URL_W014 = `${SITE}/properties/darco-prime-waterfront-fixture/`;
const OTHER_LISTING = { id: 'BONA-W999', slug: 'other-fixture', status: 'available' };
const URL_OTHER = `${SITE}/properties/other-fixture/`;

/** What the page's attribute carries: the table it prints, and nothing else. */
const DATA = {
  listingId: 'BONA-W014', count: 5, areaMin: 54.25, areaMax: 230.25, cashFrom: 701500, delivery: '2028-06', updated: '2026-09-02',
  rows: [
    { label: { en: '1 bedroom', ar: 'غرفة نوم واحدة' }, count: 2, areaMin: 54.25, areaMax: 60.1, cashFrom: 701500 },
    { label: { en: '3 bedrooms', ar: '3 غرف نوم' }, count: 1, areaMin: 121.75, areaMax: 121.75, cashFrom: 1351500 },
    { label: { en: 'Penthouse, 2 bedrooms', ar: 'بنتهاوس، غرفتا نوم' }, count: 2, areaMin: 210.5, areaMax: 230.25, cashFrom: 2100000 },
  ],
};
const OTHER = {
  ...DATA, listingId: 'BONA-W999', count: 1, areaMin: 88.5, areaMax: 88.5, cashFrom: 655500,
  rows: [{ label: { en: '2 bedrooms', ar: 'غرفتا نوم' }, count: 1, areaMin: 88.5, areaMax: 88.5, cashFrom: 655500 }],
};
/** The same listing after a Pages deploy changed a starting price (made-up figure). */
const CHANGED = {
  ...DATA, cashFrom: 689750, updated: '2026-11-20',
  rows: [{ ...DATA.rows[0], cashFrom: 689750 }, ...DATA.rows.slice(1)],
};

/** Astro's attribute escaping (html-escaper): & < > ' " become entities. */
const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
const attr = (data) => (typeof data === 'string' ? data : JSON.stringify(data));
/** A listing page as the site builds it: the units table's container carries the summary it prints. */
const page = (...summaries) => `<!doctype html><html lang="en"><head><title>Darco</title></head><body><main>
<section id="units" class="scroll-mt-28" data-project-details>${summaries.map((s) => `
<div class="mt-5 overflow-x-auto" data-units-summary="${escapeAttr(attr(s))}"><table><tbody><tr><th scope="row">1 bedroom</th></tr></tbody></table></div>`).join('')}
</section></main></body></html>`;
const PLAIN_PAGE = '<!doctype html><html lang="en"><body><main><h1>A villa</h1></main></body></html>';

function html(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
}

/** A fake site: `answer(url, init, callNo)` returns a Response, a string (a 200 page) or an Error (thrown). */
function fakeSite(answer) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const a = await answer(String(url), init, calls.length);
    if (a instanceof Error) throw a;
    return typeof a === 'string' ? html(a) : a;
  };
  return { fetch, calls };
}

function harness(answer, opts = {}) {
  const site = fakeSite(answer);
  const logs = [];
  const pub = createPublishedUnits({ siteUrl: SITE, fetch: site.fetch, log: (o) => logs.push(o), ...opts });
  return { pub, site, logs, get: (listing = LISTING) => pub.get(listing) };
}

/** Lets every pending callback run (the fetches that calls arriving together started). */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** The failures a harness logged: their reasons, and the log keys (a reason and a count, never a page value). */
function failures(h) {
  const failed = h.logs.filter((l) => l.evt === 'units.page_failed');
  for (const l of failed) assert.deepEqual(Object.keys(l).sort(), ['evt', 'failures', 'level', 'listing', 'reason'], 'the log keys');
  return failed;
}

test('the limits: an 8 s timeout, a 2 MB body cap, the live site by default, and no cache or last-good window at all', () => {
  assert.equal(FETCH_TIMEOUT_MS, 8_000);
  assert.equal(MAX_PAGE_BYTES, 2 * 1024 * 1024);
  assert.equal(DEFAULT_SITE, 'https://bona-real-estate.com');
  for (const gone of ['PAGE_TTL_MS', 'LAST_GOOD_MS']) {
    assert.ok(!(gone in publishedUnitsModule), `${gone} is gone: no cached answer and no last-good fallback`);
  }
});

test('listingPageUrl is the English listing route (src/pages/properties/[slug].astro), or null for a slug or site it cannot trust', () => {
  assert.equal(listingPageUrl(SITE, 'darco-prime-waterfront-fixture'), URL_W014);
  assert.equal(listingPageUrl(`${SITE}/`, 'darco-prime-waterfront-fixture'), URL_W014, 'a trailing slash on the site');
  assert.equal(listingPageUrl('http://localhost:4321', 'a-b'), 'http://localhost:4321/properties/a-b/');
  for (const slug of ['', null, undefined, 42, '../admin', 'a/b', 'a b', 'A-B', '-a', 'a?x=1', 'a#b', 'a%2f', 'x'.repeat(200)]) {
    assert.equal(listingPageUrl(SITE, slug), null, `slug ${JSON.stringify(slug)}`);
  }
  for (const base of ['', null, undefined, 'ftp://site.example.com', 'site.example.com', 'javascript:alert(1)', 'https://user:pw@site.example.com']) {
    assert.equal(listingPageUrl(base, 'a-b'), null, `site ${JSON.stringify(base)}`);
  }
});

test('decodeEntities undoes the escaping of an attribute in one pass', () => {
  assert.equal(decodeEntities('&quot;a&quot;:&#39;b&#39; &lt;c&gt; &amp;'), `"a":'b' <c> &`);
  assert.equal(decodeEntities('&#34;&#x22;&#X27;&apos;'), `""''`);
  assert.equal(decodeEntities('&amp;quot;'), '&quot;', 'one pass: an escaped entity stays an entity');
  assert.equal(decodeEntities('&nosuch; &#xD800; &#1114112;'), '&nosuch; &#xD800; &#1114112;', 'unknown or invalid entities are left as they are');
  assert.equal(decodeEntities('غرفة نوم – 1'), 'غرفة نوم – 1');
});

test('parsePublishedUnits reads exactly the page\'s summary, built key by key', () => {
  const got = parsePublishedUnits(page(DATA), 'BONA-W014');
  assert.deepEqual(got, DATA);
  assert.deepEqual(Object.keys(got).sort(), ['areaMax', 'areaMin', 'cashFrom', 'count', 'delivery', 'listingId', 'rows', 'updated']);
  for (const r of got.rows) {
    assert.deepEqual(Object.keys(r).sort(), ['areaMax', 'areaMin', 'cashFrom', 'count', 'label']);
    assert.deepEqual(Object.keys(r.label).sort(), ['ar', 'en']);
  }
  // A delivery the sheet does not give is null on the page, and that is fine.
  assert.deepEqual(parsePublishedUnits(page({ ...DATA, delivery: null }), 'BONA-W014'), { ...DATA, delivery: null });
  // A blank bedroom cell on a penthouse: the page prints "Penthouse, 0–2 bedrooms", a whole-count label.
  const blank = { ...DATA, rows: [...DATA.rows.slice(0, 2), { ...DATA.rows[2], label: { en: 'Penthouse, 0–2 bedrooms', ar: 'بنتهاوس، من 0 إلى 2 غرف نوم' } }] };
  assert.deepEqual(parsePublishedUnits(page(blank), 'BONA-W014'), blank);
  // The same summary twice (one table per locale block, say) is still one summary.
  assert.deepEqual(parsePublishedUnits(page(DATA, DATA), 'BONA-W014'), DATA);
  // Single quotes around the attribute value are read too.
  assert.deepEqual(parsePublishedUnits(`<div data-units-summary='${JSON.stringify(DATA).replace(/'/g, '&#39;')}'></div>`, 'BONA-W014'), DATA);
});

test('parsePublishedUnits: no attribute (a sold or hidden listing, a page without a sheet, an older build) → null', () => {
  assert.equal(parsePublishedUnits(PLAIN_PAGE, 'BONA-W014'), null);
  assert.equal(parsePublishedUnits('<section data-project-details><table></table></section>', 'BONA-W014'), null, 'a table without the attribute');
  assert.equal(parsePublishedUnits('<div data-units-summary=""></div>', 'BONA-W014'), null, 'an empty attribute');
  assert.equal(parsePublishedUnits('<p>data-units-summary=&quot;{}&quot;</p>', 'BONA-W014'), null, 'escaped text is not an attribute');
  for (const bad of [null, undefined, 42, {}, Buffer.from(page(DATA))]) assert.equal(parsePublishedUnits(bad, 'BONA-W014'), null);
});

test('parsePublishedUnits: anything but the exact allow-listed shape → null (malformed, extra or missing keys, bad numbers, odd labels)', () => {
  const row0 = DATA.rows[0];
  const withRow = (r) => ({ ...DATA, rows: [r, ...DATA.rows.slice(1)] });
  const { cashFrom: _c, ...noCash } = DATA;
  const { updated: _u, ...noUpdated } = DATA;
  const { cashFrom: _rc, ...rowNoCash } = row0;
  const bad = {
    'broken JSON': '{"listingId":"BONA-W014","rows":[',
    'an array': [DATA],
    'a string': 'BONA-W014',
    'JSON null': 'null',
    'an extra top-level key (per-unit rows)': { ...DATA, units: [] },
    'an extra top-level key (the highest cash price)': { ...DATA, price_to_en: 'SAR 1' },
    'an extra top-level key (plans)': { ...DATA, plans: [] },
    'a missing top-level key': noCash,
    'no sheet date': noUpdated,
    'an extra row key (a unit ref)': withRow({ ...row0, ref: 'B91-22' }),
    'an extra row key (the site\'s internal key)': withRow({ ...row0, key: '1' }),
    'an extra row key (a two-year price)': withRow({ ...row0, twoYear: 806500 }),
    'an extra row key (a plan price)': withRow({ ...row0, half: 716500 }),
    'a missing row key': withRow(rowNoCash),
    'an extra label key': withRow({ ...row0, label: { ...row0.label, fr: '1 chambre' } }),
    'a label without Arabic': withRow({ ...row0, label: { en: '1 bedroom' } }),
    'a number label': withRow({ ...row0, label: { en: 1, ar: 'غرفة نوم واحدة' } }),
    'a unit ref as the label': withRow({ ...row0, label: { en: 'B91-22 bedrooms', ar: 'B91-22 غرف نوم' } }),
    'a blank bedroom count as the label': withRow({ ...row0, label: { en: 'null bedrooms', ar: 'null غرف نوم' } }),
    'a fractional bedroom count as the label': withRow({ ...row0, label: { en: '1.5 bedrooms', ar: '1.5 غرف نوم' } }),
    'a label in English only matching': withRow({ ...row0, label: { en: '1 bedroom', ar: '3 غرف نوم' } }),
    'a negative price': withRow({ ...row0, cashFrom: -701500 }),
    'a negative area': { ...DATA, areaMin: -1 },
    'a price as text': withRow({ ...row0, cashFrom: '701500' }),
    'a price that is null (NaN on the page)': withRow({ ...row0, cashFrom: null }),
    'an infinite price': JSON.stringify(DATA).replace('"cashFrom":701500', '"cashFrom":1e999'),
    'a fractional count': withRow({ ...row0, count: 1.5 }),
    'a negative count': { ...DATA, count: -5 },
    'no rows': { ...DATA, rows: [] },
    'rows not a list': { ...DATA, rows: { 0: row0 } },
    'too many rows': { ...DATA, rows: Array.from({ length: 40 }, () => row0) },
    'an impossible sheet date': { ...DATA, updated: '2026-02-30' },
    'a sheet date that is not a date': { ...DATA, updated: 'yesterday' },
    'an impossible delivery': { ...DATA, delivery: '2028-13' },
    'a delivery that is a number': { ...DATA, delivery: 2028 },
    'another listing\'s summary': { ...DATA, listingId: 'BONA-W015' },
    'the id in lower case': { ...DATA, listingId: 'bona-w014' },
    'no listing id': { ...DATA, listingId: null },
  };
  for (const [name, data] of Object.entries(bad)) {
    assert.equal(parsePublishedUnits(page(data), 'BONA-W014'), null, name);
  }
  assert.ok(bad['an infinite price'].includes('1e999'), 'the infinite case really carries 1e999');
  // Two summaries that differ: the page is not one answer.
  assert.equal(parsePublishedUnits(page(DATA, { ...DATA, cashFrom: 700000 }), 'BONA-W014'), null, 'two different summaries');
  // The listing asked for must be named: no id is no answer.
  assert.equal(parsePublishedUnits(page(DATA), ''), null);
  assert.equal(parsePublishedUnits(page(DATA), undefined), null);
});

test('isBedLabel accepts the labels the page builds from whole bedroom counts, and nothing else', () => {
  for (const ok of [
    { en: '1 bedroom', ar: 'غرفة نوم واحدة' }, { en: '2 bedrooms', ar: 'غرفتا نوم' }, { en: '0 bedrooms', ar: '0 غرف نوم' },
    { en: '11 bedrooms', ar: '11 غرفة نوم' }, { en: 'Penthouse, 1–2 bedrooms', ar: 'بنتهاوس، من غرفة إلى غرفتي نوم' },
    { en: 'Penthouse, 3 bedrooms', ar: 'بنتهاوس، 3 غرف نوم' },
  ]) assert.equal(isBedLabel(ok), true, ok.en);
  for (const no of [
    null, {}, { en: '1 bedroom' }, { en: 'B91-22 bedrooms', ar: 'B91-22 غرف نوم' }, { en: '21 bedrooms', ar: '21 غرفة نوم' },
    { en: '-1 bedrooms', ar: '-1 غرف نوم' }, { en: 'Penthouse, NaN–NaN bedrooms', ar: 'بنتهاوس، من NaN إلى NaN غرف نوم' },
  ]) assert.equal(isBedLabel(no), false, JSON.stringify(no));
});

test('get: a live page with the attribute → exactly its summary, from one GET of the English listing page', async () => {
  const h = harness(() => page(DATA));
  assert.deepEqual(await h.get(), DATA);
  assert.equal(h.site.calls.length, 1);
  const [{ url, init }] = h.site.calls;
  assert.equal(url, URL_W014);
  assert.equal(init.method, 'GET');
  assert.ok(init.signal instanceof AbortSignal, 'the request can be aborted (the 8 s timeout)');
  assert.match(init.headers.accept, /text\/html/);
});

test('get: the live site by default, and the site the service is configured with (BONA_SITE) otherwise', async () => {
  const calls = [];
  const fetch = async (url) => { calls.push(String(url)); return html(PLAIN_PAGE); };
  await createPublishedUnits({ fetch }).get(LISTING);
  await createPublishedUnits({ fetch, siteUrl: 'https://staging.example.com/' }).get(LISTING);
  assert.deepEqual(calls, [
    'https://bona-real-estate.com/properties/darco-prime-waterfront-fixture/',
    'https://staging.example.com/properties/darco-prime-waterfront-fixture/',
  ]);
});

test('get: a page without the attribute (sold, hidden, no sheet, an older build) → null', async () => {
  const h = harness(() => PLAIN_PAGE);
  assert.equal(await h.get(), null);
  assert.equal(h.site.calls.length, 1);
});

test('get: a malformed summary, extra keys, a negative price or another listing\'s summary → null', async () => {
  for (const data of [
    '{"listingId":"BONA-W014","rows":[', { ...DATA, units: [] }, { ...DATA, cashFrom: -1 },
    { ...DATA, rows: [{ ...DATA.rows[0], cashFrom: null }] }, { ...DATA, listingId: 'BONA-W999' },
  ]) {
    const h = harness(() => page(data));
    assert.equal(await h.get(), null, attr(data).slice(0, 60));
  }
});

test('get: no cache: every call reads the live page, so the next call quotes what the page shows now', async () => {
  let shown = DATA;
  const h = harness(() => page(shown));
  assert.deepEqual(await h.get(), DATA);
  assert.deepEqual(await h.get(), DATA, 'the same page, read again');
  assert.equal(h.site.calls.length, 2, 'two calls in sequence, two fetches');
  // A Pages deploy changes a starting price: the very next call quotes the new one, never the one before it.
  shown = CHANGED;
  assert.deepEqual(await h.get(), CHANGED, 'the changed price, at once');
  assert.equal(h.site.calls.length, 3);
  shown = DATA;
  assert.deepEqual(await h.get(), DATA, 'and back');
  assert.ok(h.site.calls.every((c) => c.url === URL_W014), 'every fetch is the W014 page');
  assert.deepEqual(failures(h), [], 'a page that answers is not logged');
  // Each listing has its own page.
  const two = harness((url) => (url === URL_W014 ? page(DATA) : page(OTHER)));
  assert.deepEqual(await two.get(OTHER_LISTING), OTHER);
  assert.deepEqual(await two.get(), DATA);
  assert.deepEqual(two.site.calls.map((c) => c.url), [URL_OTHER, URL_W014]);
});

test('get: the page answering without a summary on the next call (the attribute removed, a bad one, another listing\'s, a 404 or 410) → null at once', async () => {
  for (const [name, gone, reason] of [
    ['the attribute removed', () => PLAIN_PAGE, 'no_summary'],
    ['a malformed summary', () => page('{"listingId":'), 'bad_summary'],
    ['a summary that is not the allow-listed shape', () => page({ ...DATA, units: [] }), 'bad_summary'],
    ['two different summaries', () => page(DATA, CHANGED), 'bad_summary'],
    ['another listing\'s summary', () => page(OTHER), 'other_listing'],
    ['a 404', () => html('not found', { status: 404 }), 'http_404'],
    ['a 410', () => html('gone', { status: 410 }), 'http_410'],
  ]) {
    let up = true;
    const h = harness(() => (up ? page(DATA) : gone()));
    assert.deepEqual(await h.get(), DATA, name);
    up = false;
    assert.equal(await h.get(), null, `${name}: null on the very next call`);
    assert.equal(h.site.calls.length, 2, `${name}: one fetch per call`);
    const failed = failures(h);
    assert.deepEqual(failed.map((l) => [l.level, l.listing, l.reason, l.failures]), [['warn', 'BONA-W014', reason, 1]], `${name}: logged as ${reason}`);
    assert.ok(!JSON.stringify(h.logs).includes('701500'), `${name}: no page figure in the log`);
  }
});

test('get: a failure on the next call (an HTTP error, a network error, a body over the cap) → null, never the summary before it (no last-good fallback)', async () => {
  const big = `<!doctype html>${' '.repeat(4096)}`;
  for (const [name, answer, reason] of [
    ['an HTTP 500', () => html('oops', { status: 500 }), 'http_500'],
    ['an HTTP 503', () => html('busy', { status: 503 }), 'http_503'],
    ['an HTTP 403', () => html('denied', { status: 403 }), 'http_403'],
    ['a network error', () => new TypeError('fetch failed'), 'network'],
    ['a fetch that rejects at once', () => { throw new TypeError('bad'); }, 'network'],
    ['a body over the cap', () => big, 'too_big'],
    ['a body over the cap by its header', () => html('short', { headers: { 'content-length': String(1024 * 1024 * 1024) } }), 'too_big'],
  ]) {
    let up = true;
    const h = harness(() => (up ? page(DATA) : answer()), { maxBytes: 4096 });
    assert.deepEqual(await h.get(), DATA, name);
    up = false;
    assert.equal(await h.get(), null, `${name}: null, not the summary of the call before`);
    assert.equal(await h.get(), null, `${name}: null while it keeps failing`);
    // The site comes back: the next call quotes the page again.
    up = true;
    assert.deepEqual(await h.get(), DATA, `${name}: back`);
    assert.equal(h.site.calls.length, 4, `${name}: one fetch per call, failures included`);
    // Failures are counted per listing until a page answers; only the reason and the count are logged.
    assert.deepEqual(failures(h).map((l) => [l.reason, l.failures]), [[reason, 1], [reason, 2]], `${name}: logged as ${reason}`);
    up = false;
    assert.equal(await h.get(), null);
    assert.equal(failures(h).at(-1).failures, 1, `${name}: the count starts again after a page answered`);
    assert.ok(!JSON.stringify(h.logs).includes('701500'), `${name}: no page figure in the log`);
    // Never fetched before: null too.
    const cold = harness(answer, { maxBytes: 4096 });
    assert.equal(await cold.get(), null, `${name}: never answered, null`);
  }
});

test('get: a timeout on the next call (no answer, a signal that is ignored, a body that never ends) → null within the timeout, no fallback', async () => {
  for (const hang of ['headers', 'headers, signal ignored', 'body']) {
    let up = true;
    const h = harness((url, init) => {
      if (up) return page(DATA);
      if (hang === 'headers') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
      if (hang === 'headers, signal ignored') return new Promise(() => {});
      const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('<!doctype html><html>')); } });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
    }, { timeoutMs: 20 });
    assert.deepEqual(await h.get(), DATA, hang);
    up = false;
    const started = Date.now();
    assert.equal(await h.get(), null, `${hang}: null, not the summary of the call before`);
    assert.ok(Date.now() - started < 5_000, `${hang}: the timeout ends the wait`);
    assert.deepEqual(failures(h).map((l) => l.reason), ['timeout'], `${hang}: logged as a timeout`);
    up = true;
    assert.deepEqual(await h.get(), DATA, `${hang}: back`);
  }
});

test('get: calls that arrive together share one fetch; once it settles, the next call fetches again', async () => {
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  let shown = DATA;
  const h = harness(async () => { await gate; return page(shown); });
  const together = [h.get(), h.get(), h.get()];
  await settle();
  assert.equal(h.site.calls.length, 1, 'three calls in flight, one fetch');
  open();
  assert.deepEqual(await Promise.all(together), [DATA, DATA, DATA]);
  // Nothing is kept once it settled: the next call is a fetch of its own, and sees the page as it is now.
  shown = CHANGED;
  assert.deepEqual(await h.get(), CHANGED);
  assert.equal(h.site.calls.length, 2);
  // A shared fetch that fails is null for every caller, and the next call tries again.
  const down = harness(() => html('oops', { status: 500 }));
  assert.deepEqual(await Promise.all([down.get(), down.get()]), [null, null]);
  assert.equal(down.site.calls.length, 1, 'two calls together, one failed fetch');
  assert.equal(failures(down).length, 1, 'one failure logged for the one fetch');
  assert.equal(await down.get(), null);
  assert.equal(down.site.calls.length, 2);
  // Two listings at once: one fetch each.
  const two = harness((url) => (url === URL_W014 ? page(DATA) : page(OTHER)));
  assert.deepEqual(await Promise.all([two.get(), two.get(OTHER_LISTING), two.get(), two.get(OTHER_LISTING)]), [DATA, OTHER, DATA, OTHER]);
  assert.deepEqual(two.site.calls.map((c) => c.url).sort(), [URL_W014, URL_OTHER].sort(), 'one fetch per listing');
});

test('get: nothing to fetch (no listing, no id, no slug, an untrusted slug or site) → null without a request', async () => {
  const h = harness(() => page(DATA));
  for (const listing of [null, undefined, {}, { id: 'BONA-W014' }, { slug: 'a-b' }, { id: 'BONA-W014', slug: '../admin' }, { id: 42, slug: 'a-b' }]) {
    assert.equal(await h.pub.get(listing), null, String(JSON.stringify(listing)));
  }
  assert.equal(h.site.calls.length, 0);
  const bad = harness(() => page(DATA), { siteUrl: 'ftp://site.example.com' });
  assert.equal(await bad.get(), null);
  assert.equal(bad.site.calls.length, 0);
});
