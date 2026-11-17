// TAQEEM for unit-model prices: every figure a model reads off the brochure for one of its unit
// models is confirmed on its page image by a second model — one call per page, whatever the
// number of models on it. A text-layer match never settles a model price: it cannot tell which
// model a figure belongs to.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isFigure as rulesIsFigure } from '../../../scripts/curate/rules.mjs';
import {
  alignHeadline, checkModelPrices, isFigure, MAX_MODEL_PRICE_PAGES, MODEL_PRICE_CONCURRENCY, modelPriceCurrency, pagesToRenderFor,
} from '../lib/model-prices.mjs';

const pages = [{ page: 9, abs: '/x/p9.jpg' }, { page: 10, abs: '/x/p10.jpg' }];
const M = (name, price, sub, page) => ({
  name: { en: name, ar: `نموذج ${name}` }, bedrooms: 2, bathrooms: 2, areaSqm: 120, rooms: null, availability: null,
  price, subsidisedPrice: sub, evidence: page ? { page, quote: String(price) } : null, floorPlan: null,
});
/** A confirm that says yes to every figure except the ones listed. */
const allBut = (calls, ...no) => async ({ page, abs, items }) => {
  calls.push({ page, abs, items });
  return items.map((it) => ({ i: it.i, price: !no.includes(it.price), subsidisedPrice: !no.includes(it.subsidisedPrice) }));
};

describe('checkModelPrices', () => {
  it('checks every model on one page in ONE call (3 models over 2 pages -> 2 calls)', async () => {
    const calls = [];
    const models = [M('A', 319015, 270425, 9), M('B', 349000, null, 9), M('C', 419994, 356024, 10)];
    const res = await checkModelPrices(models, { pageImages: pages, pageText: [], confirm: allBut(calls) });
    assert.equal(res.calls, 2);
    assert.deepEqual(calls.map((c) => [c.page, c.abs]).sort(), [[10, '/x/p10.jpg'], [9, '/x/p9.jpg']]);
    const p9 = calls.find((c) => c.page === 9);
    assert.deepEqual(p9.items, [
      { i: 0, name: models[0].name, price: 319015, subsidisedPrice: 270425 },
      { i: 1, name: models[1].name, price: 349000, subsidisedPrice: null },
    ]);
    assert.deepEqual(res.models.map((m) => [m.price, m.subsidisedPrice]), [[319015, 270425], [349000, null], [419994, 356024]]);
    assert.deepEqual(res.refused, []);
  });

  it('a refused figure becomes null and is listed in `refused`', async () => {
    const calls = [];
    const res = await checkModelPrices([M('A', 319015, 270425, 9), M('B', 999999, null, 9)], { pageImages: pages, pageText: [], confirm: allBut(calls, 999999) });
    assert.equal(res.models[1].price, null);
    assert.equal(res.models[0].price, 319015);
    assert.deepEqual(res.refused, [999999]);
  });

  it('a text-layer match alone does NOT confirm: the page check still runs and a "no" refuses', async () => {
    const calls = [];
    const pageText = Array.from({ length: 10 }, () => '');
    pageText[8] = 'Lulu 2 — السعر 319,015 ريال — لمستفيدي الدعم 270,425 ريال';
    const res = await checkModelPrices([M('A', 319015, 270425, 9)], { pageImages: pages, pageText, confirm: allBut(calls, 319015, 270425) });
    assert.equal(res.calls, 1);
    assert.equal(calls[0].items[0].price, 319015, 'the figure printed in the text is still sent to the page check');
    assert.equal(res.models[0].price, null);
    assert.equal(res.models[0].subsidisedPrice, null);
    assert.deepEqual(res.refused.sort(), [270425, 319015]);
  });

  it('evidence on a page that was not rendered falls back to the rendered page whose text carries the figure', async () => {
    const calls = [];
    const pageText = Array.from({ length: 10 }, () => '');
    pageText[9] = 'C — 419,994';
    const res = await checkModelPrices([M('C', 419994, null, 4)], { pageImages: pages, pageText, confirm: allBut(calls) });
    assert.deepEqual(calls.map((c) => c.page), [10]);
    assert.equal(res.models[0].price, 419994);
  });

  it('evidence on an unrendered page and no rendered page carrying the figure -> refused, no call', async () => {
    const calls = [];
    const res = await checkModelPrices([M('A', 319015, 270425, 4)], { pageImages: pages, pageText: [], confirm: allBut(calls) });
    assert.equal(res.calls, 0);
    assert.equal(calls.length, 0);
    assert.equal(res.models[0].price, null);
    assert.equal(res.models[0].subsidisedPrice, null);
    assert.deepEqual(res.refused.sort(), [270425, 319015]);
  });

  it('no evidence and no rendered pages at all -> refused', async () => {
    const res = await checkModelPrices([M('A', 319015, null, null)], { pageImages: [], pageText: ['319,015'], confirm: async () => { throw new Error('must not be called'); } });
    assert.equal(res.models[0].price, null);
    assert.deepEqual(res.refused, [319015]);
  });

  it('a confirm that throws refuses every item of its page, and only those', async () => {
    const confirm = async ({ page, items }) => {
      if (page === 9) throw new Error('claude -p timed out');
      return items.map((it) => ({ i: it.i, price: true, subsidisedPrice: true }));
    };
    const res = await checkModelPrices([M('A', 319015, 270425, 9), M('B', 349000, null, 9), M('C', 419994, 356024, 10)], { pageImages: pages, pageText: [], confirm });
    assert.equal(res.calls, 2);
    assert.deepEqual(res.models.map((m) => [m.price, m.subsidisedPrice]), [[null, null], [null, null], [419994, 356024]]);
    assert.deepEqual(res.refused.sort(), [270425, 319015, 349000]);
  });

  it('a missing, malformed or contradictory answer is not a confirmation', async () => {
    const confirm = async () => [
      { i: 0, price: 'yes', subsidisedPrice: true }, // not a boolean
      { i: 2, price: true, subsidisedPrice: false }, { i: 2, price: false, subsidisedPrice: false }, // contradicts itself
      // nothing about i: 1
    ];
    const res = await checkModelPrices([M('A', 319015, null, 9), M('B', 349000, null, 9), M('C', 419994, null, 9)], { pageImages: pages, pageText: [], confirm });
    assert.deepEqual(res.models.map((m) => m.price), [null, null, null]);
    assert.deepEqual(res.refused.sort(), [319015, 349000, 419994]);
  });

  it('a non-array answer refuses everything on the page', async () => {
    const res = await checkModelPrices([M('A', 319015, null, 9)], { pageImages: pages, pageText: [], confirm: async () => ({ confirmed: true }) });
    assert.equal(res.models[0].price, null);
  });

  it('a subsidised price at or above the price is refused, and so is one left without a price', async () => {
    const calls = [];
    const res = await checkModelPrices([M('A', 319015, 319015, 9), M('B', 349000, 270425, 9)], { pageImages: pages, pageText: [], confirm: allBut(calls, 349000) });
    assert.equal(res.models[0].price, 319015);
    assert.equal(res.models[0].subsidisedPrice, null, 'not lower than the price');
    assert.equal(res.models[1].price, null);
    assert.equal(res.models[1].subsidisedPrice, null, 'confirmed, but the price beside it was not');
    assert.deepEqual(res.refused.sort(), [270425, 319015, 349000]);
  });

  it('models without a price cost nothing and are returned as they were', async () => {
    const res = await checkModelPrices([M('A', null, null, null)], { pageImages: pages, pageText: [], confirm: async () => { throw new Error('must not be called'); } });
    assert.equal(res.calls, 0);
    assert.deepEqual(res.models, [M('A', null, null, null)]);
    const none = await checkModelPrices(undefined, { pageImages: pages, pageText: [], confirm: async () => [] });
    assert.deepEqual([none.models, none.refused, none.calls, none.rendered, none.unrendered, none.failed, none.skipped, none.tooMany], [[], [], 0, [], [], [], [], null]);
    assert.deepEqual([none.incomplete, none.incompletePages, none.fatal], [[], [], false]);
  });

  it('never mutates its input', async () => {
    const models = [M('A', 319015, 270425, 9), M('B', 999999, null, 4)];
    const before = structuredClone(models);
    const res = await checkModelPrices(models, { pageImages: pages, pageText: [], confirm: allBut([], 319015) });
    assert.deepEqual(models, before);
    assert.notEqual(res.models, models);
    assert.notEqual(res.models[0], models[0]);
  });
});

describe('alignHeadline', () => {
  it('sets the headline from the lowest kept model prices, and never touches the period', () => {
    const price = { amount: 1, currency: 'SAR', from: false, period: 'year', onRequest: true };
    const out = alignHeadline(price, [M('A', 419994, 356024), M('B', 319015, 270425), M('C', null, null)]);
    assert.equal(out, price, 'mutated in place and returned');
    assert.deepEqual(price, { amount: 319015, currency: 'SAR', from: true, period: 'year', onRequest: false, subsidisedAmount: 270425 });
  });

  it('takes the lowest subsidised price from any model, and drops a stale one when none is lower', () => {
    const a = { amount: 1, currency: 'SAR', from: false, period: null, onRequest: false, subsidisedAmount: 5 };
    alignHeadline(a, [M('A', 419994, 300000), M('B', 319015, null)]);
    assert.equal(a.amount, 319015);
    assert.equal(a.subsidisedAmount, 300000);
    const b = { amount: 1, currency: 'SAR', from: false, period: null, onRequest: false, subsidisedAmount: 5 };
    alignHeadline(b, [M('A', 419994, null), M('B', 319015, null)]);
    assert.equal('subsidisedAmount' in b, false);
  });

  it('takes a Sakani price only from a model whose own price it is below', () => {
    const a = { amount: 1, currency: 'SAR', from: false, period: null, onRequest: false };
    alignHeadline(a, [{ ...M('A', null, 250000) }, M('B', 300000, null), { ...M('C', 400000, 420000) }]);
    assert.equal(a.amount, 300000);
    assert.equal('subsidisedAmount' in a, false, 'A has no price of its own, C\'s is above its own price');
    const b = { amount: 1, currency: 'SAR', from: false, period: null, onRequest: false };
    alignHeadline(b, [{ ...M('A', null, 250000) }, M('B', 300000, 270000)]);
    assert.equal(b.subsidisedAmount, 270000);
  });

  it('leaves the headline alone when no model kept a price', () => {
    const price = { amount: null, currency: 'SAR', from: false, period: null, onRequest: true, subsidisedAmount: 270425 };
    const before = structuredClone(price);
    alignHeadline(price, [M('A', null, null), M('B', null, null)]);
    assert.deepEqual(price, before);
    alignHeadline(price, undefined);
    assert.deepEqual(price, before);
  });
});

describe('modelPriceCurrency — the currency a reading\'s unit-model prices are in', () => {
  const P = (currency, amount, onRequest = amount === null) => ({ amount, currency, from: !onRequest, period: null, onRequest });

  it('beside a headline amount: the reading\'s own currency, wherever the property is', () => {
    assert.equal(modelPriceCurrency(P('SAR', 319015), 'SA'), 'SAR');
    assert.equal(modelPriceCurrency(P('AED', 1250000), 'SA'), 'AED');
    assert.equal(modelPriceCurrency(P('EUR', 900000), 'GB'), 'EUR');
  });

  it('on request: only the home currency of the country the property is in (the contract\'s "SAR" default is not a reading)', () => {
    assert.equal(modelPriceCurrency(P('SAR', null), 'SA'), 'SAR', 'a Saudi brochure is priced in SAR');
    assert.equal(modelPriceCurrency(P('SAR', null), 'sa'), 'SAR');
    assert.equal(modelPriceCurrency(P('SAR', null), 'GB'), null, 'W020: a Hampstead brochure printed GBP and came back on request in "SAR"');
    assert.equal(modelPriceCurrency(P('AED', null), 'AE'), 'AED');
    assert.equal(modelPriceCurrency(P('AED', null), 'SA'), null);
    assert.equal(modelPriceCurrency(P('EUR', null), 'ES'), 'EUR');
    assert.equal(modelPriceCurrency(P('SAR', null), undefined), null);
    assert.equal(modelPriceCurrency({ ...P('SAR', 319015), onRequest: true }, 'GB'), null, 'an amount marked on request is not a reading');
  });

  it('a currency the site does not take never counts, and nothing is not a price', () => {
    assert.equal(modelPriceCurrency(P('GBP', 17950000), 'GB'), null);
    assert.equal(modelPriceCurrency(P('sar', 319015), 'SA'), null);
    assert.equal(modelPriceCurrency(null, 'SA'), null);
    assert.equal(modelPriceCurrency(undefined, 'SA'), null);
  });
});

describe('isFigure', () => {
  it('is the one definition in scripts/curate/rules.mjs', () => {
    assert.equal(isFigure, rulesIsFigure);
  });
  it('is a positive finite number, nothing else', () => {
    for (const v of [1, 319015, 0.5]) assert.equal(isFigure(v), true, String(v));
    for (const v of [0, -1, NaN, Infinity, '319015', null, undefined, {}]) assert.equal(isFigure(v), false, String(v));
  });
});

describe('pagesToRenderFor', () => {
  it('lists the cited pages of priced models that are not rendered yet, once each, in order', () => {
    const models = [M('A', 319015, null, 9), M('B', 349000, null, 4), M('C', null, 270425, 2), M('D', 419994, null, 4), M('E', 1, null, 10)];
    assert.deepEqual(pagesToRenderFor(models, [9, 10], 12), [2, 4]);
  });
  it('ignores models with no figure, and citations that are not a page of the PDF', () => {
    const models = [
      M('A', null, null, 3), // no figure: nothing to check
      M('B', 319015, null, 13), M('C', 319015, null, 0), M('D', 319015, null, -1), { ...M('E', 319015, null, null), evidence: { page: 2.5 } },
      { ...M('F', 319015, null, null), evidence: { page: '5' } }, M('G', 319015, null, null), null, 'x',
    ];
    assert.deepEqual(pagesToRenderFor(models, [], 12), []);
  });
  it('without a page count, any positive page may be asked for', () => {
    assert.deepEqual(pagesToRenderFor([M('A', 319015, null, 40)], [], undefined), [40]);
    assert.deepEqual(pagesToRenderFor([M('A', 319015, null, 40)], [], 0), [40]);
    assert.deepEqual(pagesToRenderFor(undefined, [], 5), []);
  });
});

describe('checkModelPrices: rendering cited pages', () => {
  it('renders the cited pages that are missing and checks each model on its own page', async () => {
    const calls = [];
    const renders = [];
    const render = async (wanted) => { renders.push(wanted); return wanted.map((page) => ({ page, abs: `/x/model-pages/p${page}.jpg` })); };
    const res = await checkModelPrices([M('A', 319015, null, 9), M('B', 299000, null, 2)], { pageImages: pages, pageText: [], pageCount: 12, render, confirm: allBut(calls) });
    assert.deepEqual(renders, [[2]]);
    assert.deepEqual(res.rendered, [2]);
    assert.deepEqual(res.unrendered, []);
    assert.deepEqual(calls.map((c) => [c.page, c.abs]).sort(), [[2, '/x/model-pages/p2.jpg'], [9, '/x/p9.jpg']]);
    assert.deepEqual(res.models.map((m) => m.price), [319015, 299000]);
  });

  it('a render that throws or returns nothing costs only the models on those pages', async () => {
    for (const render of [async () => { throw new Error('extract_pdf.py timed out'); }, async () => [], async () => null]) {
      const calls = [];
      const res = await checkModelPrices([M('A', 319015, null, 9), M('B', 299000, null, 2)], { pageImages: pages, pageText: [], pageCount: 12, render, confirm: allBut(calls) });
      assert.deepEqual(calls.map((c) => c.page), [9]);
      assert.deepEqual(res.models.map((m) => m.price), [319015, null]);
      assert.deepEqual(res.refused, [299000]);
      assert.deepEqual(res.rendered, []);
      assert.deepEqual(res.unrendered, [2], 'reported: the check could not look at it');
      assert.deepEqual(res.incomplete, [299000], 'refused because the check could not be done, not because the page said no');
      assert.deepEqual(res.incompletePages, [2]);
    }
  });

  it('a model whose cited page did not render is never moved to another page by its text (the page cap holds)', async () => {
    // The reviewer's probe: one page allowed, three models cite page 7, the render throws, and pages
    // 1-3 (rendered for the reading) carry the three figures in their text. Falling back to them
    // would check three pages under a cap of one.
    const pageImages = [1, 2, 3].map((page) => ({ page, abs: `/x/p${page}.jpg` }));
    const pageText = ['A — 300,000', 'B — 310,000', 'C — 320,000', '', '', '', '', ''];
    for (const render of [async () => { throw new Error('extract_pdf.py timed out'); }, async () => [], async () => null]) {
      const calls = [];
      const res = await checkModelPrices([M('A', 300000, null, 7), M('B', 310000, null, 7), M('C', 320000, null, 7)], {
        pageImages, pageText, pageCount: 8, maxPages: 1, render, confirm: allBut(calls),
      });
      assert.equal(res.tooMany, null, 'one page planned: within the cap');
      assert.equal(calls.length, 0, 'no confirm call at all');
      assert.equal(res.calls, 0);
      assert.deepEqual(res.models.map((m) => m.price), [null, null, null]);
      assert.deepEqual(res.refused, [300000, 310000, 320000]);
      assert.deepEqual(res.incomplete, [300000, 310000, 320000]);
      assert.deepEqual(res.incompletePages, [7]);
      assert.deepEqual(res.unrendered, [7]);
    }
  });

  it('a model with no usable citation may still be checked on a rendered page whose text carries its figure', async () => {
    const calls = [];
    const pageText = ['', 'B — 310,000'];
    const res = await checkModelPrices([M('A', 300000, null, 7), M('B', 310000, null, null)], {
      pageImages: [{ page: 2, abs: '/x/p2.jpg' }], pageText, pageCount: 8, render: async () => [], confirm: allBut(calls),
    });
    assert.deepEqual(calls.map((c) => [c.page, c.items.map((it) => it.i)]), [[2, [1]]]);
    assert.deepEqual(res.models.map((m) => m.price), [null, 310000]);
    assert.deepEqual(res.incomplete, [300000]);
  });

  it('a page the render did not ask for is not used', async () => {
    const calls = [];
    const render = async () => [{ page: 2, abs: '/x/p2.jpg' }, { page: 7, abs: '/x/p7.jpg' }];
    const res = await checkModelPrices([M('A', 319015, null, 7)], { pageImages: pages, pageText: [], pageCount: 12, render: async (w) => (w.includes(7) ? render() : []), confirm: allBut(calls) });
    assert.deepEqual(res.rendered, [7]);
    assert.deepEqual(calls.map((c) => c.page), [7]);
  });

  it('a citation beyond the PDF is never rendered and, with no page to look at, refused without a call', async () => {
    const calls = [];
    const renders = [];
    const res = await checkModelPrices([M('A', 319015, 270425, 99)], { pageImages: pages, pageText: [], pageCount: 12, render: async (w) => { renders.push(w); return []; }, confirm: allBut(calls) });
    assert.deepEqual(renders, []);
    assert.equal(res.calls, 0);
    assert.deepEqual(res.refused.sort(), [270425, 319015]);
  });
});

describe('checkModelPrices: cost bounds', () => {
  const many = (n) => Array.from({ length: n }, (_, k) => M(`M${k}`, 300000 + k, null, k + 1));
  const rendered = (n) => Array.from({ length: n }, (_, k) => ({ page: k + 1, abs: `/x/p${k + 1}.jpg` }));

  it('defaults to 12 pages', () => {
    assert.equal(MAX_MODEL_PRICE_PAGES, 12);
  });

  it('more pages than allowed: every model price refused, no render, no call', async () => {
    const calls = [];
    const renders = [];
    const res = await checkModelPrices(many(4), {
      pageImages: rendered(2), pageText: [], pageCount: 12, maxPages: 3,
      render: async (w) => { renders.push(w); return w.map((page) => ({ page, abs: `/x/p${page}.jpg` })); }, confirm: allBut(calls),
    });
    assert.deepEqual(res.tooMany, { pages: 4, max: 3 }, 'the pages rendering would add count too');
    assert.equal(res.calls, 0);
    assert.equal(calls.length, 0);
    assert.deepEqual(renders, []);
    assert.deepEqual(res.models.map((m) => m.price), [null, null, null, null]);
    assert.deepEqual(res.refused.sort(), [300000, 300001, 300002, 300003]);
  });

  it('exactly the limit is fine', async () => {
    const calls = [];
    const res = await checkModelPrices(many(3), { pageImages: rendered(3), pageText: [], maxPages: 3, confirm: allBut(calls) });
    assert.equal(res.tooMany, null);
    assert.equal(res.calls, 3);
    assert.deepEqual(res.refused, []);
  });

  it('runs at most 2 page checks at once by default (MODEL_PRICE_CONCURRENCY), and `concurrency` changes it', async () => {
    assert.equal(MODEL_PRICE_CONCURRENCY, 2);
    for (const [opts, want] of [[{}, 2], [{ concurrency: 1 }, 1], [{ concurrency: 4 }, 4]]) {
      let inFlight = 0;
      let peak = 0;
      const confirm = async ({ items }) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight -= 1;
        return items.map((it) => ({ i: it.i, price: true, subsidisedPrice: false }));
      };
      const res = await checkModelPrices(many(6), { pageImages: rendered(6), pageText: [], confirm, ...opts });
      assert.equal(peak, want, JSON.stringify(opts));
      assert.equal(res.calls, 6);
    }
  });

  it('runs at most 3 page checks at once when asked to, and keeps every page\'s answers with its own models', async () => {
    let inFlight = 0;
    let peak = 0;
    const started = [];
    // Later pages answer first: the results must still land on the right models.
    const confirm = async ({ page, items }) => {
      started.push(page);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 30 - page * 3));
      inFlight -= 1;
      return items.map((it) => ({ i: it.i, price: page % 2 === 1, subsidisedPrice: false }));
    };
    const res = await checkModelPrices(many(7), { pageImages: rendered(7), pageText: [], confirm, concurrency: 3 });
    assert.equal(peak, 3);
    assert.equal(res.calls, 7);
    assert.deepEqual(started.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(res.models.map((m) => m.price), [300000, null, 300002, null, 300004, null, 300006]);
  });

  it('stops launching page checks after a fatal error (quota, session limit); the rest are refused', async () => {
    const started = [];
    const confirm = async ({ page, items }) => {
      started.push(page);
      if (page === 1) { const e = new Error("claude -p failed: You've hit your session limit"); e.fatal = true; throw e; }
      await new Promise((r) => setTimeout(r, 20));
      return items.map((it) => ({ i: it.i, price: true, subsidisedPrice: false }));
    };
    const res = await checkModelPrices(many(6), { pageImages: rendered(6), pageText: [], confirm, concurrency: 3 });
    assert.deepEqual(started, [1, 2, 3], 'the two already running finish; nothing new starts');
    assert.equal(res.calls, 3);
    assert.deepEqual(res.models.map((m) => m.price), [null, 300001, 300002, null, null, null]);
    assert.deepEqual(res.failed, [{ page: 1, error: "claude -p failed: You've hit your session limit" }]);
    assert.deepEqual(res.skipped, [4, 5, 6]);
    assert.equal(res.fatal, true, 'carried out, so the caller makes no more calls either');
    assert.deepEqual(res.incomplete, [300000, 300003, 300004, 300005]);
    assert.deepEqual(res.incompletePages, [1, 4, 5, 6]);
  });

  it('a fatal error reported as { answers, error, fatal } stops it the same way', async () => {
    const started = [];
    // Two at a time: page 1 ends at 10 ms and page 3 starts in its place; page 2 fails at 20 ms,
    // while page 3 is still running — it finishes, but neither page 4 nor 5 is started.
    const confirm = async ({ page, items }) => {
      started.push(page);
      await new Promise((r) => setTimeout(r, { 1: 10, 2: 20 }[page] ?? 30));
      if (page === 2) return { answers: [], error: 'claude -p failed: rate limit', fatal: true };
      return { answers: items.map((it) => ({ i: it.i, price: true, subsidisedPrice: false })), error: null };
    };
    const res = await checkModelPrices(many(5), { pageImages: rendered(5), pageText: [], confirm, concurrency: 2 });
    assert.deepEqual(started, [1, 2, 3]);
    assert.deepEqual(res.skipped, [4, 5]);
    assert.deepEqual(res.failed, [{ page: 2, error: 'claude -p failed: rate limit' }]);
    assert.deepEqual(res.models.map((m) => m.price), [300000, null, 300002, null, null]);
  });

  it('an ordinary failed check is recorded and refuses its page, and the rest go on', async () => {
    const confirm = async ({ page, items }) => (page === 1
      ? { answers: [], error: 'claude -p exited 1: boom' }
      : { answers: items.map((it) => ({ i: it.i, price: true, subsidisedPrice: false })), error: null });
    const res = await checkModelPrices(many(4), { pageImages: rendered(4), pageText: [], confirm });
    assert.equal(res.calls, 4);
    assert.deepEqual(res.failed, [{ page: 1, error: 'claude -p exited 1: boom' }]);
    assert.deepEqual(res.skipped, []);
    assert.deepEqual(res.models.map((m) => m.price), [null, 300001, 300002, 300003]);
    assert.equal(res.fatal, false);
    assert.deepEqual(res.incomplete, [300000]);
    assert.deepEqual(res.incompletePages, [1]);
  });

  it('answers sent beside an error are dropped: a failed call confirms nothing', async () => {
    const confirm = async ({ items }) => ({ answers: items.map((it) => ({ i: it.i, price: true, subsidisedPrice: true })), error: 'claude -p exited 1: half an answer' });
    const res = await checkModelPrices([M('A', 319015, 270425, 9)], { pageImages: pages, pageText: [], confirm });
    assert.deepEqual(res.models.map((m) => [m.price, m.subsidisedPrice]), [[null, null]]);
    assert.deepEqual(res.failed, [{ page: 9, error: 'claude -p exited 1: half an answer' }]);
    assert.deepEqual(res.incomplete.sort(), [270425, 319015]);
  });

  it('a page that said no, or a model with no page at all, is a genuine refusal, not an incomplete check', async () => {
    const res = await checkModelPrices([M('A', 319015, null, 9), M('B', 999999, null, 9), M('C', 288000, null, 99)], {
      pageImages: pages, pageText: [], pageCount: 12, render: async () => [], confirm: allBut([], 999999),
    });
    assert.deepEqual(res.models.map((m) => m.price), [319015, null, null]);
    assert.deepEqual(res.refused.sort(), [288000, 999999]);
    assert.deepEqual(res.incomplete, []);
    assert.deepEqual(res.incompletePages, []);
    assert.equal(res.fatal, false);
  });

  it('too many pages is a refusal by rule, not an incomplete check', async () => {
    const res = await checkModelPrices(many(4), { pageImages: rendered(4), pageText: [], maxPages: 3, confirm: allBut([]) });
    assert.ok(res.tooMany);
    assert.equal(res.refused.length, 4);
    assert.deepEqual(res.incomplete, []);
  });
});
