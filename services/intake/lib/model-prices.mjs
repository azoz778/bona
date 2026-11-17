// TAQEEM for unit-model prices: a figure the model read off the brochure for one of its unit models
// (ai.models[i].price / subsidisedPrice) is published only when a second model, looking at the
// page image, confirms that the page prints THAT figure FOR THAT model.
//
// There is no text-layer shortcut here, unlike the headline price (pipeline.mjs `printed()`): a
// brochure that prints a table of models carries every model's figures in its text layer, and a
// match there cannot tell which model a figure belongs to — nor, on a Sakani page, which of the
// two prices it is. The text is used only to find a page to look at when the model's own citation
// names a page that was not rendered.
//
// One confirmation call per page, covering every model on it: a 12-model price table is one call,
// not twelve. The confirm function is injected (pipeline.mjs passes claude.mjs confirmModelPrices),
// so this module is pure logic and tested without a model.
import { priceAppearsIn } from './price.mjs';

const isFigure = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Is figure `key` of item `i` confirmed? Only by a well-formed `true`, and only when every answer
 * the model gave about that item agrees: a missing answer, a non-boolean or a contradiction is a no.
 */
function confirmed(answers, i, key) {
  const mine = answers.filter((a) => a && typeof a === 'object' && a.i === i);
  return mine.length > 0 && mine.every((a) => a[key] === true);
}

/**
 * @param {Array<object>} models  ai.models (never mutated: a structuredClone comes back)
 * @param {{pageImages:Array<{page:number,abs:string}>, pageText:string[],
 *          confirm:(arg:{page:number, abs:string, items:Array<{i:number,name:object,price:number|null,subsidisedPrice:number|null}>})
 *            => Promise<Array<{i:number,price:boolean,subsidisedPrice:boolean}>>}} ctx
 * @returns {Promise<{models:Array<object>, refused:number[], calls:number}>}
 *   `refused` lists every figure taken away (for the copy guard); `calls` = confirm calls made.
 */
export async function checkModelPrices(models, { pageImages = [], pageText = [], confirm }) {
  const out = structuredClone(Array.isArray(models) ? models : []);
  const refused = [];
  const refuse = (m, key) => {
    if (isFigure(m[key])) refused.push(m[key]);
    m[key] = null;
  };
  const images = Array.isArray(pageImages) ? pageImages : [];
  const texts = Array.isArray(pageText) ? pageText : [];

  // Which page each priced model is checked on: its own citation when that page was rendered,
  // otherwise the first rendered page whose text carries one of its figures, otherwise none.
  const byPage = new Map();
  for (const [i, m] of out.entries()) {
    if (!m || typeof m !== 'object') continue;
    const price = isFigure(m.price) ? m.price : null;
    const subsidisedPrice = isFigure(m.subsidisedPrice) ? m.subsidisedPrice : null;
    if (price === null && subsidisedPrice === null) continue;
    const cited = Number.isInteger(m.evidence?.page) ? images.find((p) => p.page === m.evidence.page) : null;
    const page = cited ?? images.find((p) => [price, subsidisedPrice].some((v) => v !== null && priceAppearsIn(texts[p.page - 1] ?? '', v)));
    if (!page) {
      refuse(m, 'price');
      refuse(m, 'subsidisedPrice');
      continue;
    }
    if (!byPage.has(page.page)) byPage.set(page.page, { abs: page.abs, items: [] });
    byPage.get(page.page).items.push({ i, name: m.name, price, subsidisedPrice });
  }

  let calls = 0;
  for (const [page, { abs, items }] of byPage) {
    calls += 1;
    let answers = [];
    try {
      const got = await confirm({ page, abs, items });
      answers = Array.isArray(got) ? got : [];
    } catch {
      answers = [];
    }
    for (const it of items) {
      const m = out[it.i];
      if (it.price !== null && !confirmed(answers, it.i, 'price')) refuse(m, 'price');
      if (it.subsidisedPrice !== null && !confirmed(answers, it.i, 'subsidisedPrice')) refuse(m, 'subsidisedPrice');
    }
  }

  // The subsidised price rides on the regular one: published only beside it, and only below it.
  for (const m of out) {
    if (!m || typeof m !== 'object' || (m.subsidisedPrice ?? null) === null) continue;
    if (!isFigure(m.price) || !isFigure(m.subsidisedPrice) || m.subsidisedPrice >= m.price) refuse(m, 'subsidisedPrice');
  }
  return { models: out, refused, calls };
}

/**
 * The headline price of a development sold as unit models = its cheapest confirmed model, quoted
 * "from"; its Sakani price = the cheapest confirmed subsidised model price, when below that.
 * Mutates and returns `price`. When no model kept a price, `price` is left exactly as it was.
 */
export function alignHeadline(price, models) {
  const list = Array.isArray(models) ? models : [];
  const prices = list.map((m) => m?.price).filter(isFigure);
  if (!price || !prices.length) return price;
  const subs = list.map((m) => m?.subsidisedPrice).filter(isFigure);
  price.amount = Math.min(...prices);
  price.from = true;
  price.onRequest = false;
  price.period = null;
  const sub = subs.length ? Math.min(...subs) : null;
  if (sub !== null && sub < price.amount) price.subsidisedAmount = sub;
  else delete price.subsidisedAmount;
  return price;
}
