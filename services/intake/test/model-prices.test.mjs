// TAQEEM for unit-model prices: every figure a model reads off the brochure for one of its unit
// models is confirmed on its page image by a second model — one call per page, whatever the
// number of models on it. A text-layer match never settles a model price: it cannot tell which
// model a figure belongs to.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { alignHeadline, checkModelPrices } from '../lib/model-prices.mjs';

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
    assert.deepEqual(await checkModelPrices(undefined, { pageImages: pages, pageText: [], confirm: async () => [] }), { models: [], refused: [], calls: 0 });
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
  it('sets the headline from the lowest kept model prices', () => {
    const price = { amount: 1, currency: 'SAR', from: false, period: 'year', onRequest: true };
    const out = alignHeadline(price, [M('A', 419994, 356024), M('B', 319015, 270425), M('C', null, null)]);
    assert.equal(out, price, 'mutated in place and returned');
    assert.deepEqual(price, { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false, subsidisedAmount: 270425 });
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

  it('leaves the headline alone when no model kept a price', () => {
    const price = { amount: null, currency: 'SAR', from: false, period: null, onRequest: true, subsidisedAmount: 270425 };
    const before = structuredClone(price);
    alignHeadline(price, [M('A', null, null), M('B', null, null)]);
    assert.deepEqual(price, before);
    alignHeadline(price, undefined);
    assert.deepEqual(price, before);
  });
});
