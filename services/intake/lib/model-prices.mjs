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
// not twelve; at most 3 run at once, none start after a quota error, and a brochure that would need
// more than `maxPages` pages checked has every model price refused without a call. The render and
// confirm functions are injected (pipeline.mjs passes renderPdfPages and claude.mjs
// confirmModelPrices), so this module is pure logic and tested without a model.
import { priceAppearsIn } from './price.mjs';

/** A price figure: a positive finite number. */
export const isFigure = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** At most this many pages are checked for one brochure (cfg.maxModelPricePages overrides it). */
export const MAX_MODEL_PRICE_PAGES = 12;

const priced = (m) => Boolean(m) && typeof m === 'object' && (isFigure(m.price) || isFigure(m.subsidisedPrice));

/**
 * The pages the models' evidence cites that have to be rendered before they can be looked at: a
 * page cited by a model with a price figure, a page of the PDF (1..pageCount; any positive page
 * when the count is unknown), not among `renderedPages`. Sorted, each once.
 */
export function pagesToRenderFor(models, renderedPages = [], pageCount = Infinity) {
  const last = Number.isInteger(pageCount) && pageCount > 0 ? pageCount : Infinity;
  const have = new Set(renderedPages);
  const want = (Array.isArray(models) ? models : []).filter(priced).map((m) => m.evidence?.page)
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= last && !have.has(n));
  return [...new Set(want)].sort((a, b) => a - b);
}

/**
 * Is figure `key` of item `i` confirmed? Only by a well-formed `true`, and only when every answer
 * the model gave about that item agrees: a missing answer, a non-boolean or a contradiction is a no.
 */
function confirmed(answers, i, key) {
  const mine = answers.filter((a) => a && typeof a === 'object' && a.i === i);
  return mine.length > 0 && mine.every((a) => a[key] === true);
}

/**
 * Which page each priced model is checked on, given the pages that can be looked at: its own
 * citation when that page is one of them, otherwise the first of them whose text carries one of
 * its figures. `byPage` maps a page to the items checked on it; `none` = indices with no page.
 */
function assignPages(models, pages, texts) {
  const have = new Set(pages);
  const byPage = new Map();
  const none = [];
  for (const [i, m] of models.entries()) {
    if (!priced(m)) continue;
    const price = isFigure(m.price) ? m.price : null;
    const subsidisedPrice = isFigure(m.subsidisedPrice) ? m.subsidisedPrice : null;
    const cited = Number.isInteger(m.evidence?.page) && have.has(m.evidence.page) ? m.evidence.page : null;
    const page = cited ?? pages.find((p) => [price, subsidisedPrice].some((v) => v !== null && priceAppearsIn(texts[p - 1] ?? '', v)));
    if (page === undefined) { none.push(i); continue; }
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push({ i, name: m.name, price, subsidisedPrice });
  }
  return { byPage, none };
}

/** What a confirm call said: an array of answers, or `{ answers, error, fatal }`. Anything else = no answers. */
function settle(got) {
  if (Array.isArray(got)) return { answers: got, error: null, fatal: false };
  if (got && typeof got === 'object' && Array.isArray(got.answers)) {
    return { answers: got.answers, error: got.error ? String(got.error) : null, fatal: got.fatal === true };
  }
  return { answers: [], error: null, fatal: false };
}

/**
 * Run `worker` over `jobs`, at most `limit` at a time; results stay in job order. Once a result is
 * `fatal` (a quota or session limit: the next call would fail the same way) nothing new starts —
 * those jobs have no result (undefined). `worker` must not throw.
 */
async function pool(jobs, limit, worker) {
  const results = new Array(jobs.length);
  let next = 0;
  let stop = false;
  const lane = async () => {
    while (!stop && next < jobs.length) {
      const k = next;
      next += 1;
      results[k] = await worker(jobs[k]);
      if (results[k].fatal) stop = true;
    }
  };
  const lanes = Number.isInteger(limit) && limit > 0 ? limit : 1;
  await Promise.all(Array.from({ length: Math.min(lanes, jobs.length) }, lane));
  return results;
}

/**
 * @param {Array<object>} models  ai.models (never mutated: a structuredClone comes back)
 * @param {object} ctx
 * @param {Array<{page:number,abs:string}>} ctx.pageImages  the pages already rendered
 * @param {string[]} ctx.pageText                            the text layer, per page
 * @param {number} [ctx.pageCount]                           pages in the PDF (a citation past it is never rendered)
 * @param {(pages:number[]) => Promise<Array<{page:number,abs:string}>>} [ctx.render]
 *   renders cited pages that are not in `pageImages` yet; a throw or a page it did not return costs
 *   only the models on those pages
 * @param {(arg:{page:number, abs:string, items:Array<{i:number,name:object,price:number|null,subsidisedPrice:number|null}>})
 *   => Promise<Array<{i:number,price:boolean,subsidisedPrice:boolean}> | {answers:Array, error?:string|null, fatal?:boolean}>} ctx.confirm
 *   one call per page; a throw counts as an error (fatal when the error says so)
 * @param {number} [ctx.maxPages]     more pages to check than this -> every model price refused, nothing rendered, no call
 * @param {number} [ctx.concurrency]  page checks running at once
 * @returns {Promise<{models:Array<object>, refused:number[], calls:number, rendered:number[], unrendered:number[],
 *   failed:Array<{page:number,error:string}>, skipped:number[], tooMany:{pages:number,max:number}|null}>}
 *   `refused` lists every figure taken away (for the copy guard); `calls` = confirm calls made;
 *   `rendered` / `unrendered` = cited pages the render did / did not deliver; `failed` = pages whose
 *   check errored; `skipped` = pages never checked after a fatal error.
 */
export async function checkModelPrices(models, {
  pageImages = [], pageText = [], pageCount = Infinity, render = null, confirm, maxPages = MAX_MODEL_PRICE_PAGES, concurrency = 3,
} = {}) {
  const out = structuredClone(Array.isArray(models) ? models : []);
  const refused = [];
  const refuse = (m, key) => {
    if (isFigure(m[key])) refused.push(m[key]);
    m[key] = null;
  };
  const refuseModel = (i) => { refuse(out[i], 'price'); refuse(out[i], 'subsidisedPrice'); };
  const images = (Array.isArray(pageImages) ? pageImages : []).filter((p) => p && Number.isInteger(p.page));
  const texts = Array.isArray(pageText) ? pageText : [];
  const res = { models: out, refused, calls: 0, rendered: [], unrendered: [], failed: [], skipped: [], tooMany: null };

  // The cost bound comes first, counting the pages rendering would add: past it, nothing is
  // rendered and no model is paid to look — every model price is refused.
  const toRender = typeof render === 'function' ? pagesToRenderFor(out, images.map((p) => p.page), pageCount) : [];
  const planned = assignPages(out, [...images.map((p) => p.page), ...toRender], texts).byPage.size;
  if (planned > maxPages) {
    out.forEach((m, i) => { if (priced(m)) refuseModel(i); });
    res.tooMany = { pages: planned, max: maxPages };
    return res;
  }

  if (toRender.length) {
    let got = [];
    try {
      got = await render(toRender);
    } catch {
      got = [];
    }
    const have = new Set(images.map((p) => p.page));
    const added = (Array.isArray(got) ? got : []).filter((p) => p && toRender.includes(p.page) && !have.has(p.page) && typeof p.abs === 'string');
    images.push(...added);
    res.rendered = added.map((p) => p.page);
    res.unrendered = toRender.filter((n) => !res.rendered.includes(n));
  }

  const { byPage, none } = assignPages(out, images.map((p) => p.page), texts);
  for (const i of none) refuseModel(i);
  const jobs = [...byPage].map(([page, items]) => ({ page, abs: images.find((p) => p.page === page).abs, items }));
  const settled = await pool(jobs, concurrency, async (job) => {
    res.calls += 1;
    try {
      return settle(await confirm(job));
    } catch (err) {
      return { answers: [], error: String(err?.message || err), fatal: err?.fatal === true };
    }
  });
  jobs.forEach((job, k) => {
    const s = settled[k];
    if (!s) res.skipped.push(job.page);
    else if (s.error) res.failed.push({ page: job.page, error: s.error });
    const answers = s?.answers ?? [];
    for (const it of job.items) {
      const m = out[it.i];
      if (it.price !== null && !confirmed(answers, it.i, 'price')) refuse(m, 'price');
      if (it.subsidisedPrice !== null && !confirmed(answers, it.i, 'subsidisedPrice')) refuse(m, 'subsidisedPrice');
    }
  });

  // The subsidised price rides on the regular one: published only beside it, and only below it.
  for (const m of out) {
    if (!m || typeof m !== 'object' || (m.subsidisedPrice ?? null) === null) continue;
    if (!isFigure(m.price) || !isFigure(m.subsidisedPrice) || m.subsidisedPrice >= m.price) refuse(m, 'subsidisedPrice');
  }
  return res;
}

/**
 * The headline price of a development sold as unit models = its cheapest confirmed model, quoted
 * "from"; its Sakani price = the cheapest confirmed subsidised model price, when below that.
 * Mutates and returns `price`. When no model kept a price, `price` is left exactly as it was. The
 * period is never touched: a rent read "per month" stays monthly. For a whole development only —
 * the caller skips this for one specific unit (`listing.unit`).
 */
export function alignHeadline(price, models) {
  const list = Array.isArray(models) ? models : [];
  const prices = list.map((m) => m?.price).filter(isFigure);
  if (!price || !prices.length) return price;
  const subs = list.map((m) => m?.subsidisedPrice).filter(isFigure);
  price.amount = Math.min(...prices);
  price.from = true;
  price.onRequest = false;
  const sub = subs.length ? Math.min(...subs) : null;
  if (sub !== null && sub < price.amount) price.subsidisedAmount = sub;
  else delete price.subsidisedAmount;
  return price;
}
