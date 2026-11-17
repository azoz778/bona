// TAQEEM for unit-model prices: a figure the model read off the brochure for one of its unit models
// (ai.models[i].price / subsidisedPrice) is published only when a second model, looking at the
// page image, confirms that the page prints THAT figure FOR THAT model.
//
// There is no text-layer shortcut here, unlike the headline price (pipeline.mjs `printed()`): a
// brochure that prints a table of models carries every model's figures in its text layer, and a
// match there cannot tell which model a figure belongs to — nor, on a Sakani page, which of the
// two prices it is. The text is used only to find a page to look at when the model's own citation
// cannot be looked at and was never asked for (no citation, a page past the end of the PDF, or no
// renderer): a model whose cited page was asked for and NOT delivered is not moved to another page
// by its text — that could add pages past the cost bound, and the page its figure is on is the one
// that failed — so its prices are refused as "could not be checked".
//
// One confirmation call per page, covering every model on it: a 12-model price table is one call,
// not twelve; at most MODEL_PRICE_CONCURRENCY (2, cfg.modelPriceConcurrency) run at once — each is a
// `claude -p`, a node process of its own, inside the daemon's MemoryMax — none start after a quota
// error, and a brochure that would need
// more than `maxPages` pages checked has every model price refused without a call. The render and
// confirm functions are injected (pipeline.mjs passes renderPdfPages and claude.mjs
// confirmModelPrices), so this module is pure logic and tested without a model.
import { isFigure } from '../../../scripts/curate/rules.mjs';
import { CURRENCIES } from './claude.mjs';
import { priceAppearsIn } from './price.mjs';

/** A price figure: a positive finite number. ONE definition, in scripts/curate/rules.mjs. */
export { isFigure };

const EURO_AREA = ['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK'];
/** The currency prices are quoted in at home, for the countries whose currency the site takes (CURRENCIES). */
const HOME_CURRENCY = Object.freeze({ SA: 'SAR', AE: 'AED', OM: 'OMR', US: 'USD', ...Object.fromEntries(EURO_AREA.map((c) => [c, 'EUR'])) });

/**
 * The currency a property's own country prices in, when it is one the site prints (CURRENCIES): SA, AE,
 * OM, US and the euro area. null for any other country (GB, QA, EG, …) and for no country at all.
 */
export function homeCurrency(countryCode) {
  return typeof countryCode === 'string' ? HOME_CURRENCY[countryCode.toUpperCase()] ?? null : null;
}

/** Countries whose own currency the site does not print, but whose bare "ريال" is theirs (price.mjs riyalOf). */
const RIYAL_COUNTRIES = Object.freeze({ QA: 'QAR', YE: 'YER', IR: 'IRR' });

/**
 * The currency a property's own country prices in, printed by the site or not, as far as reading a page
 * needs to know it: homeCurrency's, plus the riyal countries the site does not print (QA, YE, IR) — on
 * their pages, as on an Omani one, a bare "ريال" is not the Saudi riyal (price.mjs riyalOf, claude.mjs
 * currencyRule). null for any other country, and for no country at all.
 */
export function countryCurrency(countryCode) {
  if (typeof countryCode !== 'string') return null;
  const cc = countryCode.toUpperCase();
  return HOME_CURRENCY[cc] ?? RIYAL_COUNTRIES[cc] ?? null;
}

/**
 * The currency a reading's unit-model prices are in, or null when the reading does not establish one.
 * prompt.md has the model write every model price in `listing.price.currency`, and the page check asks
 * for the figures IN it (confirmModelPrices). That field is the model's own claim, and not an
 * independent one: prompt.md also has it set the headline amount FROM the model prices, so an amount
 * beside it proves nothing about the currency. So:
 *   - a currency outside CURRENCIES never counts;
 *   - a property in a country whose own currency the site does not print (homeCurrency null: GB, …)
 *     never establishes one, amount or not — its brochure prints £ or another currency the contract
 *     cannot hold, and the model writes the contract's default "SAR" or another it can (W020's Hampstead
 *     brochure printed GBP and came back in "SAR"; read by the prompt it is "from 1,250,000 SAR");
 *   - beside a headline amount, the reading's currency counts — the page check then confirms every
 *     figure IN that currency, so a figure printed in another one is refused there;
 *   - on request it counts only when it is that country's own currency (a Saudi brochure is priced in
 *     SAR whether or not the model settled a headline).
 */
export function modelPriceCurrency(price, countryCode) {
  if (!price || typeof price !== 'object' || !CURRENCIES.includes(price.currency)) return null;
  const home = homeCurrency(countryCode);
  if (home === null) return null;
  if (price.onRequest === false && isFigure(price.amount)) return price.currency;
  return home === price.currency ? price.currency : null;
}

/** At most this many pages are checked for one brochure (cfg.maxModelPricePages overrides it). */
export const MAX_MODEL_PRICE_PAGES = 12;

/** Page checks running at once (cfg.modelPriceConcurrency, BONA_MODEL_PRICE_CONCURRENCY, overrides it). */
export const MODEL_PRICE_CONCURRENCY = 2;

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
 * its figures — unless its citation is one of the `lost` pages (asked for, not delivered): those
 * models go to `lost`, never to another page. `byPage` maps a page to the items checked on it;
 * `none` = indices with no page to look at; `lost` = indices whose cited page failed to render.
 */
function assignPages(models, pages, texts, lostPages = new Set()) {
  const have = new Set(pages);
  const byPage = new Map();
  const none = [];
  const lost = [];
  for (const [i, m] of models.entries()) {
    if (!priced(m)) continue;
    const price = isFigure(m.price) ? m.price : null;
    const subsidisedPrice = isFigure(m.subsidisedPrice) ? m.subsidisedPrice : null;
    const citation = Number.isInteger(m.evidence?.page) ? m.evidence.page : null;
    if (citation !== null && lostPages.has(citation)) { lost.push(i); continue; }
    const cited = citation !== null && have.has(citation) ? citation : null;
    const page = cited ?? pages.find((p) => [price, subsidisedPrice].some((v) => v !== null && priceAppearsIn(texts[p - 1] ?? '', v)));
    if (page === undefined) { none.push(i); continue; }
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push({ i, name: m.name, price, subsidisedPrice });
  }
  return { byPage, none, lost };
}

/**
 * What a confirm call said: an array of answers, or `{ answers, error, fatal }`. Anything else = no
 * answers. A call that reports an error has no answers, whatever it sent beside the error.
 */
function settle(got) {
  if (Array.isArray(got)) return { answers: got, error: null, fatal: false };
  if (got && typeof got === 'object' && Array.isArray(got.answers)) {
    const error = got.error ? String(got.error) : null;
    return { answers: error ? [] : got.answers, error, fatal: got.fatal === true };
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
 *   only the models citing those pages — they are refused, never moved to another page by their text
 * @param {(arg:{page:number, abs:string, items:Array<{i:number,name:object,price:number|null,subsidisedPrice:number|null}>})
 *   => Promise<Array<{i:number,price:boolean,subsidisedPrice:boolean}> | {answers:Array, error?:string|null, fatal?:boolean}>} ctx.confirm
 *   one call per page; a throw counts as an error (fatal when the error says so); an error drops its answers
 * @param {number} [ctx.maxPages]     more pages to check than this -> every model price refused, nothing rendered, no call
 * @param {number} [ctx.concurrency]  page checks running at once
 * @returns {Promise<{models:Array<object>, refused:number[], incomplete:number[], incompletePages:number[], calls:number,
 *   rendered:number[], unrendered:number[], failed:Array<{page:number,error:string}>, skipped:number[], fatal:boolean,
 *   tooMany:{pages:number,max:number}|null}>}
 *   `refused` lists every figure taken away (for the copy guard); `incomplete` = the refused figures
 *   whose check could not be done (their page did not render, its call failed, or it was never sent
 *   after a quota error) — the rest of `refused` were looked at and not found, or had no page to look
 *   at; `incompletePages` = the pages of those figures; `calls` = confirm calls made; `rendered` /
 *   `unrendered` = cited pages the render did / did not deliver; `failed` = pages whose check errored;
 *   `skipped` = pages never checked after a fatal error; `fatal` = a call hit a quota or session limit,
 *   so the caller's own checks would fail the same way.
 */
export async function checkModelPrices(models, {
  pageImages = [], pageText = [], pageCount = Infinity, render = null, confirm, maxPages = MAX_MODEL_PRICE_PAGES, concurrency = MODEL_PRICE_CONCURRENCY,
} = {}) {
  const out = structuredClone(Array.isArray(models) ? models : []);
  const refused = [];
  const incomplete = [];
  const incompletePages = new Set();
  const refuse = (m, key, unchecked = null) => {
    if (isFigure(m[key])) {
      refused.push(m[key]);
      if (unchecked !== null) { incomplete.push(m[key]); incompletePages.add(unchecked); }
    }
    m[key] = null;
  };
  const refuseModel = (i, unchecked = null) => { refuse(out[i], 'price', unchecked); refuse(out[i], 'subsidisedPrice', unchecked); };
  const images = (Array.isArray(pageImages) ? pageImages : []).filter((p) => p && Number.isInteger(p.page));
  const texts = Array.isArray(pageText) ? pageText : [];
  const res = {
    models: out, refused, incomplete, incompletePages: [], calls: 0, rendered: [], unrendered: [], failed: [], skipped: [], fatal: false, tooMany: null,
  };

  // The cost bound comes first, counting the pages rendering would add: past it, nothing is
  // rendered and no model is paid to look — every model price is refused. The pages checked below
  // are always among the pages counted here: a cited page that does not render takes its models
  // out (assignPages `lost`), it never sends them to a page the count did not include.
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

  const { byPage, none, lost } = assignPages(out, images.map((p) => p.page), texts, new Set(res.unrendered));
  for (const i of none) refuseModel(i);
  for (const i of lost) refuseModel(i, out[i].evidence.page);
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
    if (s?.fatal) res.fatal = true;
    // A page never checked, or whose check failed, refuses its figures as "could not be checked".
    const unchecked = !s || s.error ? job.page : null;
    const answers = s?.answers ?? [];
    for (const it of job.items) {
      const m = out[it.i];
      if (it.price !== null && !confirmed(answers, it.i, 'price')) refuse(m, 'price', unchecked);
      if (it.subsidisedPrice !== null && !confirmed(answers, it.i, 'subsidisedPrice')) refuse(m, 'subsidisedPrice', unchecked);
    }
  });

  // The subsidised price rides on the regular one: published only beside it, and only below it.
  for (const m of out) {
    if (!m || typeof m !== 'object' || (m.subsidisedPrice ?? null) === null) continue;
    if (!isFigure(m.price) || !isFigure(m.subsidisedPrice) || m.subsidisedPrice >= m.price) refuse(m, 'subsidisedPrice');
  }
  res.incompletePages = [...incompletePages].sort((a, b) => a - b);
  return res;
}

/**
 * The headline price of a development sold as unit models = its cheapest confirmed model, quoted
 * "from"; its Sakani price = the cheapest confirmed subsidised model price, when below that. Only a
 * subsidised price below its OWN model's price counts (the rule rules.mjs modelsProblems applies).
 * Mutates and returns `price`. When no model kept a price, `price` is left exactly as it was. The
 * period is never touched: a rent read "per month" stays monthly. For a whole development only —
 * the caller skips this for one specific unit (`listing.unit`).
 */
export function alignHeadline(price, models) {
  const list = Array.isArray(models) ? models : [];
  const prices = list.map((m) => m?.price).filter(isFigure);
  if (!price || !prices.length) return price;
  const subs = list.filter((m) => isFigure(m?.price) && isFigure(m?.subsidisedPrice) && m.subsidisedPrice < m.price).map((m) => m.subsidisedPrice);
  price.amount = Math.min(...prices);
  price.from = true;
  price.onRequest = false;
  const sub = subs.length ? Math.min(...subs) : null;
  if (sub !== null && sub < price.amount) price.subsidisedAmount = sub;
  else delete price.subsidisedAmount;
  return price;
}
