// One PDF -> one published listing. Shared by run-once.mjs (manual) and index.mjs (daemon).
//
// Gates, in order — each one can stop the run with a one-line reason the owner reads on
// WhatsApp, and nothing is written to the repo until every gate has passed:
//   0. withdrawn advertising (the brochure's bytes — before anything else, rules.mjs)
//   1. size/pages           (cheap, local)
//   2. classifyPdf          (default-deny keyword gate — invoices/IDs/statements never reach the AI)
//   2a. withdrawn advertising (the project's name in the brochure's own words: its text layer,
//       metadata, links, the file name it was sent under, the caption — before a model is paid)
//   2b. photo-region crop  (only when the pages ARE the pictures — see lib/photo-regions.mjs)
//   3. AI contract          (validateAiResult + copyProblems)  <- the real brochure/not-brochure gate
//   3b. withdrawn advertising (the project's name, as the model read it off the brochure — in the
//       title, the project, or anywhere in the copy it wrote: a brochure with no text layer)
//   4. TAQEEM cross-check   (a price is published only when the NUMBER is actually printed;
//                            every unit-model price is confirmed on its page image, model-prices.mjs)
//   5. checkListing         (mirror of scripts/curate/validate.mjs)
//   5b. the Bona brochure (brochure_pdf.py, from the staged listing) — best effort, never fatal
//   6. build.mjs + validate.mjs in the repo (the real thing)
//
// The caller is responsible for the git side and MUST have brought the clone up to date
// BEFORE calling: build.mjs rewrites the tracked src/data/listings.json, and `git rebase`
// refuses to run with unstaged changes.
//
// Files are written into a staging directory inside the work dir and promoted into the repo
// only once checkListing() has passed; if the repo-side rebuild then fails, resetTree()
// puts the clone back exactly as it was, so the next job starts clean.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { BROCHURE_FILE, brochureFileIn, brochureUrlFor, buildBrandedBrochure } from './brochure.mjs';
import { classifyPdf } from './classify.mjs';
import { writeConfinement } from './confine.mjs';
import { buildContactSheets } from './contact-sheet.mjs';
import { askPlanContacts, buildPrompt, confirmModelPrices, confirmPriceEvidence, runListingAi } from './claude.mjs';
import { floorPlanTargets, removeListingImages, writeFloorPlans, writeListingImages } from './images.mjs';
import {
  addWarningCode, buildListing, checkListing, enrichHeadline, enrichMetaFor, findByPdfSha, findInbox, inboxIds, isSlug, listingDirProblem, mergeEnrichment, recordFileProblem,
  modelsAndFacts, nextListingId, orderedPicks, readIndex, seqAfter, slugify, takenSlugs, todayRiyadh, uniqueSlug, writeIndex,
  writeInboxListing,
} from './listing.mjs';
import { log } from './log.mjs';
import { checkPlanImages } from './plan-check.mjs';
import { ABROAD_CURRENCIES, alignHeadline, checkModelPrices, countryCurrency, homeCurrency, isFigure, modelPriceCurrency } from './model-prices.mjs';
import { extractPdf, renderPdfPages } from './pdf.mjs';
import { compositePages, cropPhotoRegions, modelFlagsComposites } from './photo-regions.mjs';
import { figureMatches, priceAppearsIn, printedInCurrency, westernise } from './price.mjs';
import { isSubsidyPricePage, pricePagesToRender } from './price-pages.mjs';
import { pinFromLinks } from './geo.mjs';
import { changedSincePublished, committedUnchanged, rebuild, resetTree } from './publish.mjs';
import { FACT_LISTS, headlineFollowsModels, loadRegisterWithdrawals, withdrawnAdvertising, withdrawnNamedIn, withdrawnNotice } from '../../../scripts/curate/rules.mjs';

/** Words that make a figure in the copy a price: a currency, "price", "from"-style openers. */
const PRICE_CONTEXT_RE = /سعر|أسعار|اسعار|ريال|ر\.\s?س|ثمن|قيمة(?!\s*المضافة)|ابتداء|تبدأ|يبدأ|\b(?:SAR|SR|AED|USD|EUR|GBP|riyals?|prices?|priced|costs?|starting|starts)\b|[$€£﷼\u20c1]/i;

/**
 * Rent or income wording (r6 #3): on a listing for sale, a headline printed on a line that says one of these, or
 * quoted with one, may be a rent, a rental income or a yield — never settled by the text layer, only on its page.
 */
const RENT_WORDING_RE = /\b(?:rent(?:al|als|s|ed|ing)?|leas(?:e|es|ed|ing)|yields?|incomes?|per\s+(?:month|year|annum))\b|\/\s*(?:month|year)\b|[إاأ]يجار|شهري|سنوي|دخل|عائد/i;
/**
 * Does `s` speak of rent or income (RENT_WORDING_RE)? Folded first as classify.mjs does: NFKC (a text layer's Arabic
 * presentation forms, "اﻹﻳﺠﺎر", become letters) and no tatweel ("الإيـجار").
 */
const rentWorded = (s) => typeof s === 'string' && RENT_WORDING_RE.test(s.normalize('NFKC').replace(/ـ/g, ''));

/** A "starting from" word: from / starting / starts, ابتداءً من / إبتداء, يبدأ / تبدأ من. */
const FROM_WORD = String.raw`\b(?:from|starting|starts)\b|بتداء|[يت]بد[أا]`;
/** …leading to what follows it: at most 25 characters on, none of them a digit (final review M2). */
const FROM_LEADS_RE = new RegExp(`(?:${FROM_WORD})\\D{0,25}$`, 'i');
const LETTER_RE = /[A-Za-z\u0620-\u065f\u066e-\u06d3\u06d5-\u06ff]/;
/** Characters a quote is not shown with: controls, zero-width and direction marks. */
const UNSHOWN_G = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/**
 * The "starting from" wording a price's evidence ties to `amount`: the words from a from-word through the figure
 * ("Starting from SAR 4,400,000", "تبدأ من 4,400,000"), or null. The from-word must lead to the figure — at most
 * 25 characters before it, no other figure between — so "10 minutes from the airport", "(from the developer)" or
 * the other end of "from 3,900,000 to 4,400,000" is not this price's (final review M2).
 */
function fromWordingOf(quote, amount) {
  const q = westernise(String(quote ?? '').normalize('NFKC'));
  for (const { index, end } of figureMatches(q, amount)) {
    const hit = FROM_LEADS_RE.exec(q.slice(0, index));
    if (!hit) continue;
    let start = hit.index;
    while (start > 0 && LETTER_RE.test(q[start - 1])) start -= 1; // the whole word: "ابتداءً", not "بتداءً"
    return q.slice(start, end).replace(UNSHOWN_G, ' ').replace(/\s+/g, ' ').trim();
  }
  return null;
}

/**
 * A measurement or a count: ONE figure followed straight away by its unit — "3 million square
 * metres", "120 m²", "1,710 units", "a 20 m street", "٣ ملايين متر مربع" (after westernise). These
 * are cut out of a sentence before a refused price is looked for in it, so only the mention that IS
 * the figure is excused, never a sentence that merely has an area in it somewhere. The digit run has
 * no spaces, so "from 319,015, 1,710 units" cannot swallow the price into the measurement. A bare
 * "m" is metres only with a space before it ("20 m"): written solid ("4.5m") it is millions, the
 * same rule priceAppearsIn applies.
 */
const MEASURE_G = new RegExp(String.raw`(?<![\d.,٫٬])\d+(?:[.,٫٬]\d{3})*(?:[.٫]\d+)?\s*(?:(?:million|thousand|mn|m|k|مليون|ملايين|ألف|آلاف|الف)\s*)?`
  + String.raw`(?:m²|m2(?!\d)|sq\.?\s?(?:m|ft)\b|square\s+(?:met|feet|foot)|met(?:re|er)s?\b|(?<=\s)m(?![a-z²\d])|ft\b|feet\b|hectares?\b|km\b|units?\b|buildings?\b|residents?\b|visitors?\b|trees?\b|`
  + String.raw`م²|م2|متر|هكتار|كم(?![\u0600-\u06ff])|م(?![\u0600-\u06ff])|وحد(?:ة|ات)|مبن[ىي]|مباني|ساكن|سكان|زائر|شجر)`, 'gi');
const withoutMeasures = (seg) => westernise(seg).replace(MEASURE_G, ' ');

export const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Every string in a model answer's listing (title, project, copy, highlights, …), for the name check. */
const stringsIn = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(stringsIn) : []);

/** A sentence ends at . ! ? ; and a line break — not at the dot of "sq." ("15,000 sq. m" is one measurement: r3 #1). */
const SENTENCE_END = /(?<!\bsq)[.!?؟؛;\n]+(?=\s|$)/i;
const pairText = (v) => [v?.en, v?.ar];
const listText = (v) => ['en', 'ar'].flatMap((k) => (Array.isArray(v?.[k]) ? v[k] : []));

/**
 * The copy a run publishes from the reading, cut into sentences, each `{ seg, where }`: the listing's
 * title, description and highlights (`listingCopy`, a publish — "the copy"). A unit model's rooms and
 * availability and the fact lists are not here: any money in them is dropped first (dropMoneyText, r3 #2),
 * and a model name stating a reading's price refuses the run there.
 */
function publishedText(ai, { listingCopy = true } = {}) {
  const l = ai?.listing;
  const groups = [
    ['the copy', listingCopy ? [...pairText(l?.title), ...listText(l?.description), ...listText(l?.highlights)] : []],
  ];
  return groups.flatMap(([where, texts]) => texts.filter((x) => typeof x === 'string' && x)
    .flatMap((x) => x.split(SENTENCE_END)).map((seg) => ({ seg, where })));
}

/**
 * The copy guard: the first refused figure (`refused`, not among `published`) that a published text
 * still states as a price — `{ n, where }` — or null. A sentence with price wording counts whole;
 * otherwise only what is left once the measurements are cut out ("3 million square metres" is an area,
 * "the asking figure is 1,250,000 for a 120 m² flat" is still the refused price). A bare figure counts:
 * "Buildings G–P, 419,994 / 356,024" states 419,994.
 */
function refusedFigureIn(segments, refused, published) {
  const shown = new Set(published.filter((n) => typeof n === 'number' && n > 0));
  for (const n of refused) {
    if (shown.has(n)) continue;
    const hit = segments.find(({ seg }) => priceAppearsIn(seg, n) && (PRICE_CONTEXT_RE.test(seg) || priceAppearsIn(withoutMeasures(seg), n)));
    if (hit) return { n, where: hit.where };
  }
  return null;
}

/** A currency's code, name or symbol (r3 #1), and the marks price.mjs MARKS reads too: S.R, Dhs, ر.ق, د.إ, د.ك (r6 #1). */
const CUR = String.raw`(?:(?<![A-Za-z])(?:SAR|SR|S\.\s?R|AED|Dhs?|USD|EUR|GBP|OMR|QAR|KWD|BHD|EGP|riyals?|rials?|dirhams?|dollars?|euros?|pounds?|sterling)(?![A-Za-z])|ريال|ر\.\s?س|ر\.\s?ع|ر\.\s?ق|د\.\s?إ|د\.\s?ك|درهم|دولار|يورو|جنيه|دينار|[$€£﷼\u20c1])`;
/**
 * A currency next to a figure: "SAR 1,500", "1,500 riyals", "$ 750", "750 SR", "4500SAR" (r5 #1: a code glued to its
 * figure), "750 Saudi Riyals" (r6 #1: a country between the figure and its currency).
 */
const CURRENCY_BY_FIGURE_RE = new RegExp(String.raw`${CUR}\s*[:\-–—=]?\s*\d|\d(?:[.,٫]\d{1,2})?\s*(?:\/-\s*)?`
  + String.raw`(?:(?:saudi|omani|qatari|emirati|uae|kuwaiti|bahraini|us)\s+)?${CUR}`, 'i');
/**
 * A dotted currency mark — "ر.س", "ر. س.", "ر.ع", "ر.ق", "د.إ", "د.ك", "S.R.", "SR." — whose dot would end the sentence
 * and part the mark from its figure (Codex r5 #1). statesMoney reads it as " SAR " before the split. The Arabic letters
 * stand alone, as in price.mjs: "ر. سعيد" is a name, "الدار. سعر" a sentence end (r6 #1).
 */
const DOTTED_MARK_G = new RegExp(String.raw`(?<![\u0600-\u06ff])(?:ر\.\s?[سعق]|د\.\s?[إك])(?:\.|(?![\u0620-\u065f\u066e-\u06d3\u06d5-\u06ff]))`
  + String.raw`|(?<![A-Za-z])(?:S\.\s?R\.?|SR\.)(?![A-Za-z])`, 'gi');
/** "approx." / "incl." / "excl." — an abbreviation's dot is no sentence end ("Deposit approx. 750": r6 #1). */
const ABBREVIATION_DOT_G = /(?<![A-Za-z])(approx|incl|excl)\./gi;
/**
 * A currency's name or symbol anywhere, or its code by a figure — what a model NAME may not carry (r2 #4). Only a LETTER
 * continues a code or a name, as in CUR: "Studio 4500SAR", "Studio SAR4500", "Villa 1,250,000SAR" (r6 #2).
 */
const NAME_CURRENCY_RE = new RegExp(String.raw`(?<![A-Za-z])(?:SAR|SR|AED|USD|EUR|GBP|OMR|QAR|KWD|BHD|EGP)(?![A-Za-z])\s*\d|\d\s*(?<![A-Za-z])(?:SAR|SR|AED|USD|EUR|GBP|OMR|QAR|KWD|BHD|EGP)(?![A-Za-z])|(?<![A-Za-z])(?:riyals?|rials?|dirhams?|dollars?|euros?|sterling)(?![A-Za-z])|ريال|ر\.\s?س|ر\.\s?ع|درهم|دولار|يورو|جنيه|دينار|[$€£﷼\u20c1]`, 'i');
/**
 * Arabic words as whole words, with the clitics و / ف, ب / ل / لل and ال in front (a tatweel may follow one:
 * "فـحجز"): "السعر", "بسعر", "للإيجار" — never inside another word ("رسوم" is not in "رسومات"). Only a LETTER
 * before or after continues the word: Arabic punctuation (، ؛ ؟ ٪) ends it, like a space (r5 #1).
 */
const AR_LETTER = String.raw`[\u0621-\u064a\u066e-\u06d3\u06d5\u06fa-\u06ff]`;
const arabicWords = (words) => String.raw`(?<!${AR_LETTER})[وف]?\u0640?(?:لل|[بل])?\u0640?(?:ال)?(?:${words})(?!${AR_LETTER})`;
/** A payment (r3 #1): what a model NAME may not carry, and, with any number, money in free text. "مقدم" alone is not one. */
const PAYMENT_EN = String.raw`\b(?:down\s*-?\s*payments?|payments?|pay|pays|paid|deposits?|fees?|instal{1,2}ments?|service\s+charges?)\b`;
const PAYMENT_AR = arabicWords('دفع|دفعة|دفعات|عربون|رسوم|قسط|أقساط|اقساط');
const PAYMENT_RE = new RegExp(`${PAYMENT_EN}|${PAYMENT_AR}`, 'i');
/** A rent period (r6 #1): "4500 per month", "monthly", "a year", "/month", "٤٥٠٠ شهرياً", "سنوي", "في الشهر". */
const RENT_PERIOD_EN = String.raw`\b(?:per\s+(?:month|year)|monthly|yearly|annually|a\s+(?:month|year))\b|\/\s*(?:month|year)\b`;
const RENT_PERIOD_AR = arabicWords(String.raw`شهري|شهريا|سنوي|سنويا|في\s+الشهر|في\s+السنة`);
/** A price word, a payment or a rent period: with ANY number in the same clause, the clause states money (r3 #1). */
const PRICE_WORD_RE = new RegExp([
  String.raw`\b(?:prices?|priced|pricing|rents?|rental|rentals|booking|book|costs?)\b`, arabicWords('سعر|أسعار|اسعار|إيجار|ايجار|حجز'), PAYMENT_EN, PAYMENT_AR,
  RENT_PERIOD_EN, RENT_PERIOD_AR,
].join('|'), 'i');
/** "starting / starts / from / يبدأ / ابتداء": money beside a figure of four digits or more (r3 #1). */
const FROM_WORD_RE = new RegExp(String.raw`\b(?:starting|starts?|from)\b|` + arabicWords('يبدأ|تبدأ|ابتداء|ابتداءً|إبتداء|ابتداءا'), 'i');
/** A figure of four digits or more, ungrouped. */
const FOUR_PLUS_RE = /(?<![\d.,٫٬])\d{4,}/;
/**
 * A money-sized figure: thousands grouped by a comma, an Arabic comma (r6 #1, as price.mjs SEP), a dot, a space, a
 * no-break or a thin space ("50,000", "50 000", "٤،٥٠٠،٠٠٠"); five digits or more; a scaled amount ("4.5m", "1.2 million",
 * "مليون", "ألف", "990k"). A whole number written solid with "m" ("15m", "500m") is metres here, never millions; "5k"
 * beside a distance word in the same comma sub-clause is a distance.
 */
const GROUPED_RE = /(?<![\d.,٫٬])\d{1,3}(?:[,٬.'’ \u00a0\u202f\u2009\u060c]\d{3})+(?!\d)/;
const SCALED_RE = new RegExp([
  String.raw`(?<![\d.,٫٬])\d+(?:[.,٫]\d+)?\s*(?:million|mn|thousand|billion|bn|مليون|ملايين|مليار|ألف|الف|آلاف|الاف)(?![a-z])`,
  String.raw`(?<![\d.,٫٬])\d+[.,٫]\d+m(?![a-z²\d])`,
].join('|'), 'i');
const SOLID_K_RE = /(?<![\d.,٫٬])\d+(?:[.,٫]\d+)?k(?![a-z²\d])/i;
const DISTANCE_WORD_RE = /\b(?:run|runs|running|jog|jogging|walk|walking|track|trail|race|route|loop|path|cycling|cycle)\b|ممشى|مضمار|مسار|جري/i;
/** Cut out before the test (r3 #1): a duration right after its number, and a year 1900–2099 standing alone. */
const DURATION_G = /(?<![\d.,٫٬])\d+(?:[.,٫]\d+)?\s*(?:years?|yrs?|months?|weeks?|days?|hours?|hrs?|minutes?|mins?|سنة|سنوات|سنين|عام|أعوام|اعوام|شهر|شهور|أشهر|اشهر|أسبوع|أسابيع|يوم|أيام|ايام|ساعة|ساعات|دقيقة|دقائق)(?![a-z\u0600-\u06ff])/gi;
const YEAR_G = /(?<![\d.,٫٬])(?:19|20)\d{2}(?![\d]|[.,٫٬]\d)/g;

/**
 * Does `text` state money? THE rule for free text — a unit model's rooms and availability, every amenities /
 * nearby / warranties item (r3 #1, r5 #1, r6 #1; its whole contract is one table in price-pages.test.mjs). Tatweel
 * goes first, and a dotted mark or "approx." / "incl." / "excl." never ends a sentence. Sentence by sentence:
 *   - a currency next to a figure ("Club fee SAR 1,500"), looked for BEFORE anything is cut ("SAR 4.5 M" is no
 *     4.5 metres, "SAR 4,500 month" no duration: r6 #1);
 * then, once measurements (withoutMeasures) and durations ("2 years", "24 ساعة") are cut out (a lone year, "2027",
 * only from the "from" test):
 *   - a price or payment word or a rent period with ANY number ("Price 4500", "Deposit 750", "حجز 5000",
 *     "4500 per month", "٤٥٠٠ شهرياً");
 *   - "starting / from / يبدأ / ابتداء" with a figure of four digits or more ("Starting from 4500");
 *   - grouped thousands ("Down payment 50 000", "Parking for 1,200 cars" — a count, dropped all the same:
 *     TAQEEM first), five digits or more, or a scaled amount ("4.5m", "1.2 million");
 *   - a solid-k figure, unless a distance word shares its comma sub-clause ("A 5k jogging track").
 * Prices are published from the price fields only, so no free text may carry one.
 */
export function statesMoney(text) {
  // Sentences only — a comma never sets a figure apart from its word ("Deposit, 750": r5 #1). Tatweel out, and a dotted
  // mark or an abbreviation closed up first, so no dot parts "ر. س" / "S.R." / "approx." from its figure (r6 #1).
  const folded = String(text ?? '').replace(/\u0640/g, '').replace(DOTTED_MARK_G, ' SAR ').replace(ABBREVIATION_DOT_G, '$1 ');
  return folded.split(SENTENCE_END).some((clause) => {
    const w = westernise(clause);
    // The currency before any cut: "SAR 4.5 M" is no 4.5 metres, "SAR 4,500 month" no duration (r6 #1).
    if (CURRENCY_BY_FIGURE_RE.test(w)) return true;
    const t = withoutMeasures(w).replace(DURATION_G, ' ');
    if (CURRENCY_BY_FIGURE_RE.test(t)) return true;
    if (PRICE_WORD_RE.test(t) && /\d/.test(t)) return true;
    // A lone year is cut from the "from" test only ("Handover starts 2027"), never before the others ("SAR 2000").
    if (FROM_WORD_RE.test(t) && FOUR_PLUS_RE.test(t.replace(YEAR_G, ' '))) return true;
    if (GROUPED_RE.test(t) || /(?<![\d.,٫٬])\d{5,}/.test(t) || SCALED_RE.test(t)) return true;
    // The distance exception per comma sub-clause: "from 850k, walking distance to the mall" is still a price (r6 #1).
    return t.split(/[,،]\s*/).some((c) => SOLID_K_RE.test(c) && !DISTANCE_WORD_RE.test(c));
  });
}

/**
 * Does `text` state one of `figures` (the prices the reading carries) in any form the price matcher knows —
 * "4500", "4,500", "4.5k", "4.5m" (priceAppearsIn), measurements cut out first (r5 #2, r5 #3)?
 */
const statesFigure = (text, figures) => figures.length > 0 && typeof text === 'string'
  && figures.some((n) => priceAppearsIn(withoutMeasures(westernise(text)), n));
/**
 * A scaled token in a model NAME (r6 #2, Claude r5 B4, Codex r5 #1): its digits — "." or "٫" as the decimal mark,
 * trailing zeros or not, thousands grouped by "," or "٬" — then m / mn / million / مليون / ملايين or k / thousand /
 * ألف / الف / آلاف / الاف. "m" and "k" only written solid ("20 m" is metres, as in price.mjs). The word ends at a
 * letter, never at Arabic punctuation ("٤٫٥ مليون،"). Name-only: price.mjs, which also confirms prices, is unchanged.
 */
const NAME_SCALED_G = new RegExp(String.raw`(?<!\d[.,٫٬]?)(\d{1,3}(?:[,٬]\d{3})+|\d+)(?:[.٫](\d+))?`
  + String.raw`(?:(m|k)|\s*(million|mn|thousand|مليون|ملايين|ألف|الف|آلاف|الاف))(?![a-z²\d]|[\u0620-\u065f\u066e-\u06d3\u06d5-\u06ff])`, 'gi');
const NAME_SCALE = { m: 1e6, mn: 1e6, million: 1e6, 'مليون': 1e6, 'ملايين': 1e6, k: 1e3, thousand: 1e3, 'ألف': 1e3, 'الف': 1e3, 'آلاف': 1e3, 'الاف': 1e3 };
/** Does a scaled token in `text` come to one of `figures` ("Penthouse 4.50m", "Townhouse 0.95m", "Penthouse 4500K": r6 #2)? */
const statesScaledFigure = (text, figures) => figures.length > 0 && typeof text === 'string'
  && [...withoutMeasures(text).matchAll(NAME_SCALED_G)].some(([, whole, frac, solid, word]) => {
    const n = Math.round(Number(`${whole.replace(/[,٬]/g, '')}.${frac ?? '0'}`) * NAME_SCALE[(solid ?? word).toLowerCase()]);
    return figures.some((f) => Math.round(f) === n);
  });
/**
 * A model NAME states money by a currency or a payment word, or by a price the reading carries (`figures`: its
 * model prices, Sakani prices and headline — r3 #3), in any form ("Penthouse 4.5m" against 4,500,000: r5 #3;
 * "4.50m", "0.95m", "4500K", "٤٫٥ مليون،": r6 #2). "Villa 15m", "Plot 10000", "Penthouse 4,250" are names when the
 * reading has no such price.
 */
const nameStatesMoney = (text, figures = []) => typeof text === 'string'
  && (NAME_CURRENCY_RE.test(westernise(text)) || PAYMENT_RE.test(text) || statesFigure(text, figures) || statesScaledFigure(text, figures));

/**
 * The money guard over a reading's free text (r2 #4, Codex r1 #3): a unit model's rooms or availability that
 * state money (statesMoney) are dropped (null), and so is every fact-list item (amenities / nearby /
 * warranties) that does — in both languages, the lists being parallel — in place, on `holder` (the AI answer,
 * right after the reading: 3c). A model name cannot be dropped: the first one that states money (nameStatesMoney:
 * a currency or payment word, or one of `figures` — the prices the reading carries, r3 #3) is returned, and the
 * run is refused.
 * @returns {{ dropped: string[], name: string|null }}
 */
export function dropMoneyText(holder, { figures = [] } = {}) {
  const dropped = [];
  let name = null;
  // Money by the rule (statesMoney), or one of the reading's own price figures in any form (r5 #2).
  const money = (t) => typeof t === 'string' && (statesMoney(t) || statesFigure(t, figures));
  (Array.isArray(holder?.models) ? holder.models : []).forEach((m, i) => {
    if (!m || typeof m !== 'object') return;
    if (name === null && pairText(m.name).some((t) => nameStatesMoney(t, figures))) name = `models[${i}].name`;
    if (listText(m.rooms).some(money)) { m.rooms = null; dropped.push(`models[${i}].rooms`); }
    if (pairText(m.availability).some(money)) { m.availability = null; dropped.push(`models[${i}].availability`); }
  });
  for (const k of Object.keys(FACT_LISTS)) {
    const list = holder?.[k];
    if (!list || !Array.isArray(list.en) || !Array.isArray(list.ar)) continue;
    const bad = new Set([...list.en.keys(), ...list.ar.keys()].filter((j) => money(list.en[j]) || money(list.ar[j])));
    if (!bad.size) continue;
    for (const j of [...bad].sort((x, y) => x - y)) dropped.push(`${k}[${j}]`);
    holder[k] = { en: list.en.filter((_, j) => !bad.has(j)), ar: list.ar.filter((_, j) => !bad.has(j)) };
  }
  return { dropped, name };
}

/**
 * A warning the WhatsApp reply ranks ahead of the rest (r6 #8): it shows only the first 3 (messages.mjs
 * orderedWarnings), so the price ones (`price`: the headline, Sakani and unit-model prices) come first, then the one
 * floor-plan line (`plan`), then every other warning, each group in the order it was pushed.
 */
const rankedWarning = (report, rank, text) => {
  report.warnings.push(text);
  report.warningPriority[rank].push(text);
};

/** The warning for dropMoneyText's dropped fields and items (none: null). */
const moneyTextWarning = (dropped) => (dropped.length
  ? `${dropped.length} text field(s) or list item(s) stated a price or a payment, which the site shows only in the price fields, so they were left off (${dropped.join(', ')})`
  : null);
/** dropMoneyText's warning and code on the report. */
const reportMoneyText = (report, dropped) => {
  if (!dropped.length) return;
  if (dropped.some((f) => f.startsWith('models[')) && !report.warningCodes.includes('model-price-not-printed')) report.warningCodes.push('model-price-not-printed');
  report.warnings.push(moneyTextWarning(dropped));
  log.warn('intake.text_money_dropped', { fields: dropped });
};

/**
 * The withdrawal a model's reading of the brochure falls under, or null: by the listing's own fields
 * (rules.mjs withdrawnAdvertising: title, project name, slug) or by a withdrawn name anywhere in the
 * copy it wrote — a model can title a re-export generically and leave `project` empty.
 */
const withdrawnInAnswer = (listing, sha256, withdrawals) =>
  withdrawnAdvertising({ ...listing, _intake: { pdfSha256: sha256 } }, withdrawals)
  ?? withdrawnNamedIn(stringsIn(listing), withdrawals);

export class RejectError extends Error {
  constructor(reason, stage) {
    super(reason);
    this.name = 'RejectError';
    this.reason = reason;
    this.stage = stage;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.pdfPath
 * @param {object} opts.cfg          loadConfig() result
 * @param {object} opts.caption      parseCaption() result
 * @param {string} opts.workDir      scratch dir for extraction + sheets + staging
 * @param {boolean} [opts.dryRun]    stop before writing to the repo
 * @param {object} [opts.meta]       messageId / groupJid / pdfFileName; or, for run-once --replace,
 *                                   { replace: true, id, slug, listedAt, sourceRef } of the listing to rewrite;
 *                                   or, for run-once --enrich, { enrich: { id, slug } } of the listing to
 *                                   add unit models, floor plans, fact lists and a new brochure to
 * @returns {Promise<object>} run report
 */
export async function processPdf({ pdfPath, cfg, caption = {}, workDir, dryRun = false, meta = {} }) {
  const started = Date.now();
  // `warnings` are OUR sentences (safe to send to WhatsApp); `warningCodes` are the fixed
  // vocabulary written into the listing. Model free text belongs in neither. `warningPriority`: the warnings the
  // WhatsApp reply puts first (rankedWarning).
  const report = { pdf: pdfPath, dryRun, stage: 'start', warnings: [], warningCodes: [], warningPriority: { price: [], plan: [] } };
  const stat = fs.statSync(pdfPath);
  report.bytes = stat.size;
  report.sha256 = sha256File(pdfPath);

  // --- replace: checked first, before a page is read or a model is paid ------------
  // `meta.replace` (run-once --replace <id>): re-run a brochure over the listing it already
  // published — same id, slug, date and reference, new copy, price and photos. Used after a fix to
  // the intake itself (2026-11-17: W023's prices were on pages the first run could not read).
  if (meta.replace) {
    if (!meta.id || !meta.slug) throw new Error('replace needs the id and slug of the listing it replaces');
    // Before the slug is joined into a path: its folder is deleted and rewritten (r2 #6).
    const dirProblem = listingDirProblem(cfg.repo, meta.slug);
    if (dirProblem) throw new Error(`replace ${meta.id}: ${dirProblem} — nothing was touched`);
    const current = findInbox(cfg.repo, meta.id);
    if (!current || current.listing.slug !== meta.slug) throw new Error(`${meta.id} is not in the inbox under ${meta.slug} — nothing to replace`);
    const recordProblem = recordFileProblem(cfg.repo, current.file);
    if (recordProblem) throw new Error(`replace ${meta.id}: ${recordProblem} — nothing was touched`);
    // The old photos are deleted before the new ones are copied in, and a failed run is rolled
    // back from git: so the listing as it stands must BE in git, unchanged, or it is lost.
    if (!dryRun && !(await committedUnchanged(cfg.repo, [path.join('public', 'listings', meta.slug), path.relative(cfg.repo, current.file)]))) {
      throw new Error(`${meta.id} has uncommitted changes (or is not in git) — commit or discard them before --replace`);
    }
    // A re-run rebuilds title, place, copy, photos and labels from the brochure, so any later
    // commit to the listing or its photos — a district corrected by hand, an Arabic name fixed, a
    // photo re-cropped, a WhatsApp edit made before edits were recorded — would be undone
    // silently. Only the commit that published it, and earlier replacements, may be in its history.
    if (!dryRun) {
      const changed = await changedSincePublished(cfg.repo, [path.relative(cfg.repo, current.file), path.join('public', 'listings', meta.slug)]);
      if (changed) throw new Error(`${meta.id} has been changed since it was published (${changed}) — a re-run would undo that; do it by hand`);
    }
  }

  // --- enrich: checked first too, before a page is read or a model is paid ------------
  // `meta.enrich` (run-once --enrich <id>): add the unit models, their floor plans, the fact lists and
  // a new brochure to a listing published before the intake could read them — and change nothing else
  // in it (enrichListing below). Hand corrections are kept, so there is no history rule; but it must be
  // the very PDF the listing was published from, and the listing must be in git, unchanged, because a
  // failed run is rolled back from the commit.
  const enrich = meta.enrich ? { id: meta.enrich.id, slug: meta.enrich.slug, force: meta.enrich.force === true } : null;
  let enrichTarget = null;
  if (enrich) {
    if (meta.replace) throw new Error('--enrich and --replace do not go together');
    if (!enrich.id || !enrich.slug) throw new Error('enrich needs the id and slug of the listing it enriches');
    // Before the slug is joined into any path — the staging folder is deleted even on a dry run (Codex r1 #6a) —
    // and before a file is written or deleted in a listing folder that is a symlink or outside the repo (r2 #6).
    if (!isSlug(enrich.slug)) throw new Error(`enrich: ${JSON.stringify(enrich.slug)} is not a valid slug (lowercase-hyphenated) — nothing was touched`);
    const dirProblem = listingDirProblem(cfg.repo, enrich.slug);
    if (dirProblem) throw new Error(`enrich ${enrich.id}: ${dirProblem} — nothing was touched`);
    if (caption.price) throw new Error('--enrich takes no caption price: the headline is decided from the listing (`price <id> …` changes it)');
    // enrichMetaFor()'s refusals again, on the listing as it stands now: unknown, withdrawn, withheld, hidden, no PDF hash.
    const { existing } = enrichMetaFor(cfg.repo, enrich.id).enrich;
    enrichTarget = findInbox(cfg.repo, enrich.id);
    if (!enrichTarget || existing.slug !== enrich.slug) throw new Error(`${enrich.id} is not in the inbox under ${enrich.slug} — nothing to enrich`);
    // The record is rewritten in place: never through a symlink (r3 #9).
    const recordProblem = recordFileProblem(cfg.repo, enrichTarget.file);
    if (recordProblem) throw new Error(`enrich ${enrich.id}: ${recordProblem} — nothing was touched`);
    if (existing._intake.pdfSha256 !== report.sha256) {
      throw new RejectError(`this PDF is not the one ${existing.id} was published from (it has sha ${report.sha256.slice(0, 12)}…, the listing records ${existing._intake.pdfSha256.slice(0, 12)}…) — nothing was changed`, 'enrich');
    }
    if (!dryRun && !(await committedUnchanged(cfg.repo, [path.join('public', 'listings', enrich.slug), path.relative(cfg.repo, enrichTarget.file)]))) {
      throw new Error(`${enrich.id} has uncommitted changes (or is not in git) — commit or discard them before --enrich`);
    }
  }

  // --- 0. withdrawn advertising -------------------------------------------------
  // A brochure whose project the developer withdrew from advertising (rules.mjs
  // WITHDRAWN_ADVERTISING, or a flag in the clone's review register) is refused before a page of
  // it is read: no extraction, no model call, nothing staged. The same bytes are caught here; a
  // re-export is caught by name in its own words (2a) or in the model's reading of it (3b).
  const withdrawals = loadRegisterWithdrawals(cfg.repo);
  const withdrawnPdf = withdrawnAdvertising({ _intake: { pdfSha256: report.sha256 } }, withdrawals);
  if (withdrawnPdf) throw new RejectError(withdrawnNotice(withdrawnPdf), 'withdrawn');

  if (stat.size > cfg.maxPdfMb * 1024 * 1024) {
    throw new RejectError(`PDF is ${(stat.size / 1048576).toFixed(1)} MB — the limit is ${cfg.maxPdfMb} MB`, 'size');
  }

  // --- 1. extract -------------------------------------------------------------
  report.stage = 'extract';
  fs.mkdirSync(workDir, { recursive: true });
  const extraction = await extractPdf(pdfPath, workDir, {
    pyCmd: cfg.pyCmd, minSide: cfg.minImageSide, maxPages: cfg.maxPdfPages,
  });
  if (extraction.ok === false) throw new RejectError(extraction.error, 'extract');
  report.pages = extraction.pages;
  report.candidates = extraction.candidates.length;
  report.rendered = extraction.rendered;
  log.info('intake.extracted', { pages: extraction.pages, candidates: extraction.candidates.length, rendered: extraction.rendered });

  // --- 2. default-deny gate ---------------------------------------------------
  report.stage = 'classify';
  const verdict = classifyPdf(extraction, { fileName: meta.pdfFileName || path.basename(pdfPath) });
  report.classify = verdict;
  log.info('intake.classified', verdict);
  if (!verdict.ok) throw new RejectError(verdict.reason, 'classify');

  // --- 2a. withdrawn advertising, by the brochure's own words ------------------------
  // A re-export has new bytes, so gate 0 cannot see it, and the model can title it generically and
  // leave `project` empty, so 3b alone is not enough. What the document says about itself is read
  // here, before a model is paid to read it: its text layer, its metadata (title, subject, …), its
  // links, the file name it was sent under and the caption. Any mention is refused — the intake
  // republishes the brochure itself, so even a page that only names the project would advertise it.
  // Refused in a dry run too. After the classify gate, so a private document keeps its own answer.
  const namedInSource = withdrawnNamedIn([
    extraction.text, ...(extraction.pageText ?? []), ...stringsIn(extraction.meta ?? {}),
    ...(extraction.links ?? []).map((l) => l?.uri), meta.pdfFileName, caption.text,
  ], withdrawals);
  if (namedInSource) {
    throw new RejectError(`${withdrawnNotice(namedInSource)}. The brochure (its text, metadata, links or file name) or its caption names the project`, 'withdrawn');
  }

  // A brochure with no text layer is NOT accepted locally: every page is rendered and the
  // AI reads them. Default-deny still holds — it just happens one gate later.
  let pageImages = [];
  let pageReason = 'no-text';
  if (verdict.imageOnly) {
    report.stage = 'page-renders';
    const pages = await renderPdfPages(pdfPath, workDir, {
      pyCmd: cfg.pyCmd, maxPages: cfg.maxPdfPages, longSide: cfg.pageReadLongSide,
    });
    if (pages.ok === false) throw new RejectError(pages.error, 'extract');
    pageImages = pages.pageImages || [];
    report.pageImages = pageImages.length;
    log.info('intake.page_renders', { pages: pageImages.length, longSide: cfg.pageReadLongSide });
  } else {
    // A readable text layer can still be unreadable exactly where it matters: a font that maps
    // its digits to letters prints 270,425 on the page and "DIB,FDG" in the text. The pages that
    // talk about a price without a readable one are rendered so the model can look (price-pages.mjs).
    // A failed render costs only the price (it stays on request), never the listing.
    const pricePages = pricePagesToRender(extraction.pageText, { maxPages: cfg.maxPricePages });
    if (pricePages.length) {
      report.stage = 'page-renders';
      const pages = await renderPdfPages(pdfPath, workDir, {
        pyCmd: cfg.pyCmd, maxPages: cfg.maxPdfPages, longSide: cfg.pageReadLongSide,
        pages: pricePages, dir: 'price-pages',
      });
      if (pages.ok === false) {
        log.warn('intake.price_pages_failed', { pages: pricePages, error: pages.error });
      } else {
        pageImages = pages.pageImages || [];
        pageReason = 'price-pages';
        report.pricePages = pageImages.map((p) => p.page);
        log.info('intake.price_pages', { pages: report.pricePages, longSide: cfg.pageReadLongSide });
      }
    }
  }

  const confinement = writeConfinement(workDir);
  // The rule count is one per sibling of every directory on the way to the work dir. Under
  // $BONA_DATA it is ~320; a work dir under a directory with thousands of siblings makes a
  // much larger settings file, which is still correct but slower for the CLI to load.
  const confineLog = confinement.ruleCount > 5000 ? log.warn : log.info;
  confineLog('intake.confined', { settings: confinement.file, denyRules: confinement.ruleCount });

  // --- 2b. photo-region cropping ------------------------------------------------
  // A deck exported one picture per page yields candidates that are whole pages: photo,
  // headline, logo and floor plan in one bitmap. Every one of them is rightly excluded by
  // the ranking step, and the run then dies at the photo gate. So when the pages ARE the
  // pictures, one extra confined call marks where the photographs are on them and they are
  // cut out; the crops go into the candidate list and are ranked like any other photograph.
  const composites = compositePages(extraction, { imageOnly: verdict.imageOnly });
  const ordinaryCandidates = extraction.candidates.length - composites.indices.length;
  let cropped = null;

  const runCrop = async (why) => {
    report.stage = 'crop';
    log.info('intake.cropping', { why, pages: composites.pages, ordinaryCandidates });
    const out = await cropPhotoRegions({
      pdfPath, workDir, pages: composites.pages, startIndex: extraction.candidates.length,
      cfg, settingsPath: confinement.file, logger: log,
    });
    log.info('intake.cropped', {
      why,
      pages: out.pages.length,
      views: out.views,
      boxes: out.boxes,
      crops: out.crops.length,
      dropped: out.dropped.length,
      costUsd: out.meta?.costUsd ?? null,
      error: out.error ?? null,
      rooms: out.crops.map((c) => c.room),
    });
    report.cropped = {
      why,
      pages: out.pages,
      views: out.views,
      boxes: out.boxes,
      crops: out.crops.map((c) => ({ index: c.index, page: c.page, w: c.width, h: c.height, room: c.room, note: c.note })),
      dropped: out.dropped,
      error: out.error ?? null,
    };
    if (out.crops.length) {
      extraction.candidates.push(...out.crops);
      report.candidates = extraction.candidates.length;
      report.warningCodes.push('photos-cropped');
      report.warnings.push(`${out.crops.length} photo(s) were cut out of the brochure's own pages — check the gallery`);
    }
    return out;
  };

  // Only when the brochure could not pass the photo gate on its own candidates: an ordinary
  // brochure with real photographs in it never pays for this call. Never for an enrichment, which
  // publishes no photograph (and so has no photo gate to pass).
  if (!enrich && composites.pages.length && ordinaryCandidates < cfg.minImages) {
    cropped = await runCrop(composites.reason);
  }

  // --- 3. AI ------------------------------------------------------------------
  report.stage = 'ai';
  const rubricPath = path.join(cfg.repo, 'scripts', 'curate', 'IMAGE-RUBRIC.md');
  const askModel = async () => {
    const sheets = await buildContactSheets(extraction.candidates, path.join(workDir, 'sheets'));
    report.sheets = sheets.map((s) => s.file);
    const prompt = buildPrompt({ extraction, sheets, caption, pageImages, pageReason, rubricPath: fs.existsSync(rubricPath) ? rubricPath : null });
    fs.writeFileSync(path.join(workDir, 'prompt.txt'), prompt);
    return runListingAi({
      prompt,
      cwd: workDir,
      model: cfg.claudeModel,
      fallbackModel: cfg.claudeFallbackModel,
      bin: cfg.claudeBin,
      addDirs: [workDir],
      settingsPath: confinement.file,
      timeoutMs: cfg.claudeTimeoutMs,
      candidateCount: extraction.candidates.length,
      candidates: extraction.candidates,
      logger: log,
    });
  };
  let { result: ai, meta: aiMeta, attempt } = await askModel();
  fs.writeFileSync(path.join(workDir, 'ai.json'), `${JSON.stringify(ai, null, 2)}\n`);
  report.ai = ai;
  report.aiMeta = { ...aiMeta, attempt, model: cfg.claudeModel };
  log.info('intake.ai_done', { round: 1, attempt, costUsd: aiMeta.costUsd, durationMs: aiMeta.durationMs, reject: ai.reject, confidence: ai.confidence });
  if (ai.reject) throw new RejectError(ai.rejectReason || 'not a publishable property brochure', 'ai');
  // --- 3b. withdrawn advertising, by name ----------------------------------------
  // A re-exported brochure has new bytes but the same project: the title, project name or copy the
  // model wrote from it still names it — the one check that sees a brochure with no text layer.
  // Refused in a dry run too — there is nothing to preview.
  const withdrawnName = withdrawnInAnswer(ai.listing, report.sha256, withdrawals);
  if (withdrawnName) throw new RejectError(withdrawnNotice(withdrawnName), 'withdrawn');

  // The rescue round. The geometry did not think this brochure needed cropping, but the
  // ranking step has just said in its own words that the candidates it refused are collages
  // and text pages — which is the same finding, arrived at by reading them. Crop and ask
  // once more, but only when the run would otherwise be rejected for want of photographs.
  let picks = orderedPicks(ai.images, { maxImages: cfg.maxImages });
  if (!enrich && picks.length < cfg.minImages && !cropped && composites.pages.length
      && modelFlagsComposites(ai.images, composites.indices)) {
    cropped = await runCrop('the ranking step called the page-sized candidates collages');
    if (cropped.crops.length) {
      report.stage = 'ai';
      ({ result: ai, meta: aiMeta, attempt } = await askModel());
      fs.writeFileSync(path.join(workDir, 'ai.json'), `${JSON.stringify(ai, null, 2)}\n`);
      report.ai = ai;
      report.aiMeta = { ...aiMeta, attempt, model: cfg.claudeModel };
      log.info('intake.ai_done', { round: 2, attempt, costUsd: aiMeta.costUsd, durationMs: aiMeta.durationMs, reject: ai.reject, confidence: ai.confidence });
      if (ai.reject) throw new RejectError(ai.rejectReason || 'not a publishable property brochure', 'ai');
      const withdrawnAgain = withdrawnInAnswer(ai.listing, report.sha256, withdrawals);
      if (withdrawnAgain) throw new RejectError(withdrawnNotice(withdrawnAgain), 'withdrawn');
      picks = orderedPicks(ai.images, { maxImages: cfg.maxImages });
    }
  }

  // The model's `warnings` are free text from a model that just read an untrusted document.
  // They stay in ai.json: not in the listing, not in the reply.
  if (Array.isArray(ai.warnings) && ai.warnings.length) {
    report.warningCodes.push('model-flagged');
    report.warnings.push(`the model flagged ${ai.warnings.length} thing(s) to check by hand — they are in ai.json in the run's work dir`);
  }

  // --- 3c. money in free text --------------------------------------------------
  // No price or payment in a unit model's rooms or availability, or in a fact list, at all (r2 #4, r3 #1): those
  // fields and items are dropped here, BEFORE any price check (r3 #2) — so the copy guard below sees only the
  // listing's own copy, and a figure whose check could not finish cannot turn a retryable run into a refused
  // one. A model name that states money refuses the run (it cannot be dropped).
  // Every price the reading carries — model and Sakani prices, the headline — as read, before any check.
  const readingFigures = [...(Array.isArray(ai.models) ? ai.models : []).flatMap((m) => [m?.price, m?.subsidisedPrice]),
    ai.listing?.price?.amount, ai.listing?.price?.subsidisedAmount].filter(isFigure);
  const money = dropMoneyText(ai, { figures: readingFigures });
  if (money.name) {
    throw new RejectError(`${money.name} states a price or a payment — prices go in the price fields only; send it again, the next reading may leave it out`, enrich ? 'enrich' : 'price');
  }
  reportMoneyText(report, money.dropped);

  // --- 4. TAQEEM cross-check ---------------------------------------------------
  // A price may only be published when the number is really printed. The model is not
  // trusted to have read one: look it up in the text layer and in the caption, and for a
  // brochure with no text layer make a second `claude -p` look at the page it cited.
  report.stage = 'price';
  const price = ai.listing?.price;
  const pageText = extraction.pageText ?? [];
  // A page that mentions subsidy beneficiaries prints TWO prices per unit. A number found in its
  // text layer proves the number is printed, not WHICH price it is — so text found only on such
  // pages never settles a price; the page image does (those pages are always rendered, see
  // price-pages.mjs). The caption is the owner's own words and always counts.
  const plainText = pageText.length ? pageText.filter((t) => !isSubsidyPricePage(t)).join('\n') : (extraction.text || '');
  const haystack = `${plainText}\n${caption.text || ''}`;
  // The country the property is in — the listing's own on an enrichment — and the currency it prices in,
  // when the site prints that one (model-prices.mjs homeCurrency). A figure printed with no currency at all
  // is taken for that currency only; a property abroad needs its currency printed beside the figure.
  const country = (enrichTarget ? enrichTarget.listing.location : ai.listing?.location)?.countryCode ?? ai.listing?.location?.countryCode;
  const home = homeCurrency(country);
  // The country's own currency, printed by the site or not: on its pages a bare "ريال" / ﷼ is ITS riyal —
  // an Omani "190,000 ريال" is 190,000 OMR, never 190,000 SAR (price.mjs riyalOf, claude.mjs currencyRule).
  const local = countryCurrency(country);
  // The rent period the prices are published for (Codex r1 #2, r2 #3) — the site and the brochure print the
  // headline and every model row with the listing's period: on an enrichment the listing's own; on a publish
  // what buildListing() gives it (the owner's caption period, else the reading's, else a year). A sale has
  // none. Every figure a second model checks is confirmed FOR that period, the headline's too, and an
  // enrichment whose reading has another period keeps no model price. The reading's period counts only on a
  // rental: a sale's stray period is no period at all — no page-only check, no prompt (r5 #9).
  const readingPeriod = (enrichTarget ? enrichTarget.listing.category : (caption.category || ai.listing?.category)) === 'rent' ? (price?.period ?? null) : null;
  const listingPeriod = enrichTarget
    ? (enrichTarget.listing.category === 'rent' ? (enrichTarget.listing.price?.period ?? null) : null)
    : (caption.category || ai.listing?.category) === 'rent' ? (caption.period || readingPeriod || 'year') : null;
  // The "a price for one of its unit models counts" allowance is for a whole development quoted
  // "from" its cheapest model — never for one specific unit, and never for a price not marked `from`.
  const wholeDevelopment = Boolean(ai.listing?.project) && !ai.listing?.unit && price?.from === true;
  // Set by the first second-model call that hits a quota or session limit (the unit-model check, or
  // a printed() call below): every later call would fail the same way, so none is made, and what
  // could not be checked is worded "try again later" — the brochure is not blamed for our quota.
  let quotaHit = false;
  /**
   * Is `amount` printed as THIS price? In the plain text layer (headline only), or — confirmed by a
   * second model — on a rendered page. Evidence the model forgot is looked for in the rendered
   * pages' text, so a price it read from the text layer is still checked on its page. After a quota
   * error no call is made: `unchecked: true`, never confirmed. `uncheckedWhy` says why: 'quota', or
   * 'render' — a whole-property check whose page could not be rendered (printedWhole) — or 'call', one whose
   * second-model call failed (a timeout, a crash: printedWhole, r2 #2).
   */
  const printed = async (amount, evidence, { subsidised = false, whole = false, pageCheck = false, sale = false } = {}) => {
    // In the text: printed IN the price's currency, or bare where bare figures are in it (printedInCurrency).
    // "£1,250,000" is a price in pounds, never "1,250,000 SAR". `whole`: the figure must be the whole
    // property's price — which the text layer cannot tell from a floor's or a model's, so only a page can.
    // `pageCheck`: only a page settles it, the same way, without the whole-property wording — a rental's headline,
    // whose period the text layer cannot tell (r3 #4); `sale`, a sale's headline that may be a rent, asked as a sale (r6 #3).
    const out = { inText: subsidised || whole || pageCheck ? false : printedInCurrency(haystack, amount, price.currency, { bareCounts: home === price.currency, home: local }), confirmed: null };
    if (out.inText) return out;
    if (whole || pageCheck) return printedWhole(amount, evidence, { subsidised, out, whole, sale });
    if (!pageImages.length) return out;
    // The model's citation when it names a rendered page; otherwise the rendered page whose text
    // carries the number. Either way the second model looks at the page before anything counts.
    const citedRendered = evidence && pageImages.some((p) => p.page === evidence.page) ? evidence : null;
    const cited = citedRendered ?? (() => {
      const hit = pageImages.find((p) => priceAppearsIn(pageText[p.page - 1] ?? '', amount));
      return hit ? { page: hit.page, quote: String(amount) } : null; // the model's quote was about another page
    })();
    const page = cited && pageImages.find((p) => p.page === cited.page);
    if (!page) return out;
    if (quotaHit) {
      log.info('intake.price_evidence_skipped', { page: cited.page, subsidised, reason: 'quota' });
      return { ...out, unchecked: true, uncheckedWhy: 'quota' };
    }
    const check = await askPage(page, amount, cited.quote, { subsidised, whole, inferred: cited !== evidence });
    out.confirmed = check.confirmed;
    if (check.fatal) return { ...out, unchecked: true, uncheckedWhy: 'quota' };
    return out;
  };
  /** One second-model look at a rendered page (confirmPriceEvidence). A quota error sets quotaHit. */
  const askPage = async (page, amount, quote, { subsidised, whole, inferred, sale = false }) => {
    const check = await confirmPriceEvidence({
      pageImage: page.abs,
      amount,
      currency: price.currency,
      quote,
      subsidised,
      bareCounts: home === price.currency,
      home: local,
      project: wholeDevelopment,
      whole,
      subject: ai.listing?.title?.en,
      unit: ai.listing?.unit ?? null,
      period: listingPeriod,
      sale,
      bin: cfg.claudeBin,
      model: cfg.claudeModel,
      cwd: workDir,
      addDirs: [workDir],
      settingsPath: confinement.file,
    });
    log.info('intake.price_evidence', { page: page.page, subsidised, whole, inferred, confirmed: check.confirmed, error: check.error ?? null, fatal: check.fatal === true });
    if (check.fatal) quotaHit = true;
    return check;
  };
  /**
   * A whole-property check: only a page can settle it, so each page it looks at (wholeCheckPages) is rendered
   * when it was not, as the model check renders a model's cited page (final review S2r), and the first page a
   * second model confirms it on settles it. A render that fails means that page was not looked at: unless
   * another page confirms it, unchecked ("try again later"), never "the brochure does not print it". So is a
   * check after a quota error, rendered page or not (final review M5): nothing more can be looked at.
   */
  const printedWhole = async (amount, evidence, { subsidised, out, whole = true, sale = false }) => {
    const pages = wholeCheckPages(amount, evidence);
    // A quota first, page or no page (r3 #10): nothing more can be looked at — "try again later".
    if (quotaHit) {
      log.info('intake.price_evidence_skipped', { page: pages[0] ?? null, subsidised, whole, reason: 'quota' });
      return { ...out, unchecked: true, uncheckedWhy: 'quota' };
    }
    if (!pages.length) {
      // No page to pick, and the model check that would have looked at the figure's page did not finish: that
      // check failed, not the brochure (r3 #10).
      if ((report.modelPrices?.incomplete ?? []).includes(amount)) return { ...out, unchecked: true, uncheckedWhy: 'call' };
      return out;
    }
    let unrendered = null;
    let failedCall = null;
    for (const n of pages) {
      if (!(await renderForWholeCheck(n))) {
        unrendered ??= n;
        continue;
      }
      const page = pageImages.find((p) => p.page === n);
      const check = await askPage(page, amount, n === evidence?.page ? evidence.quote : String(amount), { subsidised, whole, inferred: n !== evidence?.page, sale });
      out.confirmed = check.confirmed;
      if (check.fatal) return { ...out, unchecked: true, uncheckedWhy: 'quota' };
      if (check.confirmed) return out;
      if (check.error) failedCall ??= n;
    }
    if (unrendered !== null) {
      log.info('intake.price_evidence_skipped', { page: unrendered, subsidised, whole: true, reason: 'render' });
      return { ...out, unchecked: true, uncheckedWhy: 'render' };
    }
    // A call that failed (a timeout, a crash) did not look at the page: not "not printed" (r2 #2).
    if (failedCall !== null) return { ...out, unchecked: true, uncheckedWhy: 'call' };
    return out;
  };
  /** Why printed() could not check a figure, in words for the owner. */
  const uncheckedWhy = (ev) => (ev?.uncheckedWhy === 'render' ? 'its page could not be rendered for the check'
    : ev?.uncheckedWhy === 'call' ? 'the check of its page failed' : 'the AI quota ran out');
  // Pages rendered for a whole-property check that failed: not tried twice in one run.
  const unrenderable = new Set();
  const pageCount = Number(extraction.pages);
  const inPdf = (n) => Number.isInteger(n) && n >= 1 && (!Number.isInteger(pageCount) || pageCount < 1 || n <= pageCount);
  const isRendered = (n) => pageImages.some((p) => p.page === n);
  /**
   * The pages a whole-property check looks at, in order: the evidence's page when it cites one of the PDF's
   * pages and its text carries the figure (or no page's text does). A citation whose page's text lacks the
   * figure while another page's text has it is as likely a page off (final review M4): that page first — a
   * rendered one whose text carries the figure, else the first page whose text does — then the cited one,
   * which may print it as an image. No usable citation: that page alone. None at all: nothing printed it.
   */
  const wholeCheckPages = (amount, evidence) => {
    const carries = (n) => priceAppearsIn(pageText[n - 1] ?? '', amount);
    const cited = inPdf(evidence?.page) ? evidence.page : null;
    if (cited !== null && carries(cited)) return [cited];
    const rendered = pageImages.find((p) => carries(p.page));
    const i = pageText.findIndex((t) => priceAppearsIn(t ?? '', amount));
    const inText = rendered ? rendered.page : i === -1 ? null : i + 1;
    return [inText, cited].filter((n, k, all) => n !== null && all.indexOf(n) === k);
  };
  /**
   * Makes sure page `want` is among the rendered pages: renders it (into `headline-pages`) when it is not
   * there yet. false only when that render failed (or failed before, this run).
   */
  const renderForWholeCheck = async (want) => {
    if (isRendered(want)) return true;
    if (unrenderable.has(want)) return false;
    try {
      const more = await renderPdfPages(pdfPath, workDir, {
        pyCmd: cfg.pyCmd, maxPages: cfg.maxPdfPages, longSide: cfg.pageReadLongSide, pages: [want], dir: 'headline-pages',
      });
      const added = more.ok === false ? [] : (more.pageImages || []).filter((p) => p && p.page === want && typeof p.abs === 'string');
      if (!added.length) {
        log.warn('intake.headline_pages_failed', { pages: [want], error: more.ok === false ? more.error : 'page not returned' });
        unrenderable.add(want);
        return false;
      }
      pageImages.push(...added);
      report.headlinePages = [...(report.headlinePages ?? []), want];
      log.info('intake.headline_pages', { pages: [want], longSide: cfg.pageReadLongSide });
      return true;
    } catch (e) {
      log.warn('intake.headline_pages_failed', { pages: [want], error: String(e?.message || e) });
      unrenderable.add(want);
      return false;
    }
  };
  const rejectedPrices = [];
  // Every text the run publishes, sentence by sentence, each with where it comes from: the listing's
  // copy (a publish only — an enrichment keeps the listing's own), and the unit models' names, rooms
  // and availability and the fact lists, which both publish. A refused figure is looked for in all of it.
  const copySegments = publishedText(ai, { listingCopy: !enrich });
  const inCopy = (n) => copySegments.some(({ seg }) => priceAppearsIn(seg, n));

  // --- 4a. unit-model prices ------------------------------------------------------
  // A development sold as unit models prints a price (and often a Sakani price) per model. Each
  // figure is confirmed ON ITS PAGE IMAGE by a second model — one call per page, covering every
  // model on it, at most cfg.modelPriceConcurrency at once and at most cfg.maxModelPricePages pages — and never by the text
  // layer, which cannot tell which model a figure belongs to (model-prices.mjs). When any model keeps
  // a price, the headline of a whole development becomes the cheapest one, "from", and its own checks
  // below are skipped: its figures ARE confirmed model figures. The owner's caption price replaces them all,
  // and so does the price he set by WhatsApp on a listing being enriched (enrichHeadline): no figure is
  // checked that will not be published.
  const figuresOf = (m) => [m?.price, m?.subsidisedPrice].filter(isFigure);
  const ownerPriceEdit = Boolean(enrichTarget) && Array.isArray(enrichTarget.listing._intake?.edits) && enrichTarget.listing._intake.edits.includes('price');
  const modelFigures = Array.isArray(ai.models) ? ai.models.flatMap(figuresOf) : [];
  // The lowest model price AS READ, before any check takes one away: a reading that set its headline from
  // it (prompt.md: a whole development is "from" its cheapest model) carries exactly this figure, `from`.
  const readModelPrices = Array.isArray(ai.models) ? ai.models.map((m) => m?.price).filter(isFigure) : [];
  const readLowest = readModelPrices.length ? Math.min(...readModelPrices) : null;
  // The currency: the model prices are written and confirmed IN the reading's `price.currency`, which
  // counts only when model-prices.mjs modelPriceCurrency establishes it — for a property abroad (a country
  // whose currency the site does not print) only USD or EUR beside a price, elsewhere any beside a price,
  // on request only the country's own currency. When it is not established — or, on an enrichment, it is not the listing's
  // own currency (the site prints every model price in `price.currency`) — the models keep no price, and
  // none is checked: no figure is checked that will not be published. A figure the copy states is then
  // an unconfirmed one (the guard below).
  let currencyDrop = null;
  let readingCurrency = null;
  if (modelFigures.length && !caption.price && !ownerPriceEdit) {
    const listingCurrency = enrichTarget ? (enrichTarget.listing.price?.currency ?? null) : null;
    readingCurrency = modelPriceCurrency(price, country);
    const currency = { reading: price?.currency ?? null, established: readingCurrency !== null, listing: listingCurrency };
    if (enrich && (readingCurrency === null || readingCurrency !== listingCurrency)) currencyDrop = { decision: 'currency-mismatch', currency };
    else if (!enrich && readingCurrency === null) currencyDrop = { decision: 'currency-unconfirmed', currency };
    // Only a rental's period, and only when the reading names another one (r2 #10): a reading with no period is
    // checked for the listing's, and a sale's stray period means nothing.
    else if (enrich && listingPeriod && readingPeriod && readingPeriod !== listingPeriod) {
      currencyDrop = { decision: 'period-mismatch', currency, period: { reading: readingPeriod, listing: listingPeriod } };
    }
  }
  // The owner's own figure — his caption price, or the price he set by WhatsApp on a listing being enriched.
  const ownerAmount = caption.price ? caption.price.amount : ownerPriceEdit ? (enrichTarget.listing.price?.amount ?? null) : null;
  let headlineFromModels = false;
  if (Array.isArray(ai.models) && ai.models.length && (caption.price || ownerPriceEdit || currencyDrop)) {
    for (const m of ai.models) {
      // Same rule as the model's own headline figure under a caption price: dropped, and refused
      // outright only if the copy states it (the owner's own figure excepted).
      for (const n of figuresOf(m)) if (currencyDrop || (n !== ownerAmount && inCopy(n))) rejectedPrices.push(n);
      if (m && typeof m === 'object') { m.price = null; m.subsidisedPrice = null; }
    }
    if (currencyDrop) {
      const { decision, currency } = currencyDrop;
      report.modelPrices = { models: ai.models.length, calls: 0, refused: [], incomplete: [], incompletePages: [], fatal: false, tooMany: null, decision, currency, dropped: modelFigures };
      log.info('intake.model_prices_dropped', { decision, ...currency, figures: modelFigures.length });
      report.warningCodes.push('model-price-not-printed');
      // Why the reading's currency does not count (model-prices.mjs modelPriceCurrency), as it is: abroad only
      // USD or EUR beside a price the reading read itself; at home a currency with no price of its own counts
      // only when it is the country's own. A USD reading abroad is not called "the default" (final review C2).
      const ownAmount = price?.onRequest === false && isFigure(price?.amount);
      const why = home === null
        ? `the property is in ${country ?? 'no recorded country'}, whose own currency the site does not print: there the models are priced only in ${ABROAD_CURRENCIES.join(' or ')}, beside a price the reading read itself — this reading has ${currency.reading ?? 'no currency'}${ownAmount ? '' : ' and no price of its own'}`
        : `${currency.reading ?? 'none'} is only the default — the reading has no price of its own, and it is not the currency of the country the property is in`;
      const per = (p) => (p ? `per ${p}` : 'with no rent period');
      rankedWarning(report, 'price', decision === 'period-mismatch'
        ? `the brochure's unit-model prices read as ${per(currencyDrop.period.reading)}, but the listing's price is ${per(currencyDrop.period.listing)}, so the models were published without prices — a figure is never shown for another period`
        : decision === 'currency-mismatch'
          ? `the brochure's unit-model prices are not in the listing's currency (${currency.listing ?? 'none'}): ${currency.established ? `they read as ${currency.reading}` : `the reading established no currency (${why})`}, so the models were published without prices`
          : `the unit-model prices were left off: their currency could not be established from the brochure (${why}) — the models show without them`);
    }
  } else if (modelFigures.length) {
    const mp = await checkModelPrices(ai.models, {
      pageImages,
      pageText,
      pageCount: Number(extraction.pages),
      maxPages: cfg.maxModelPricePages,
      concurrency: cfg.modelPriceConcurrency,
      // A page a model's evidence cites that was not rendered for the reading is rendered now, so
      // the second model can look at it. A failed render — or a throw — costs the models citing
      // those pages their prices ("try again later"), not the run: they are not moved to another page.
      render: async (pages) => {
        try {
          const more = await renderPdfPages(pdfPath, workDir, {
            pyCmd: cfg.pyCmd, maxPages: cfg.maxPdfPages, longSide: cfg.pageReadLongSide, pages, dir: 'model-pages',
          });
          if (more.ok === false) {
            log.warn('intake.model_pages_failed', { pages, error: more.error });
            return [];
          }
          const have = new Set(pageImages.map((p) => p.page));
          const added = (more.pageImages || []).filter((p) => !have.has(p.page));
          // Kept in pageImages on purpose: when every model price is refused, the headline's own
          // check below may confirm its figure on one of these pages — a second model still has to
          // see it printed there, exactly as on a page rendered for the reading.
          pageImages.push(...added);
          report.modelPages = added.map((p) => p.page);
          log.info('intake.model_pages', { pages: report.modelPages, longSide: cfg.pageReadLongSide });
          return added;
        } catch (e) {
          log.warn('intake.model_pages_failed', { pages, error: String(e?.message || e) });
          return [];
        }
      },
      confirm: async ({ page, abs, items }) => {
        // IN the currency the reading established, the figures printed in another one refused; a bare
        // figure counts only in the property's own country's currency. A rental's: FOR the listing's period.
        const res = await confirmModelPrices({
          pageImage: abs, items, currency: readingCurrency, bareCounts: readingCurrency !== null && readingCurrency === home, home: local, period: listingPeriod,
          bin: cfg.claudeBin, model: cfg.claudeModel, cwd: workDir, addDirs: [workDir], settingsPath: confinement.file,
        });
        log.info('intake.model_price_evidence', { page, models: items.length, answers: res.answers.length, error: res.error, fatal: res.fatal });
        return res;
      },
    });
    ai.models = mp.models;
    rejectedPrices.push(...mp.refused);
    if (mp.fatal) quotaHit = true;
    // Two kinds of refusal, two warnings. `mp.incomplete`: figures whose check could not be done for
    // a reason that is ours, not the brochure's — their page did not render, the second model's call
    // failed, or nothing more was sent after a quota error ("try again later"). The rest of
    // `mp.refused` were looked at and not found printed, or had no page to look at.
    const { incomplete, incompletePages } = mp;
    const notPrinted = mp.refused.length - incomplete.length;
    report.modelPrices = { models: ai.models.length, calls: mp.calls, refused: mp.refused, incomplete, incompletePages, fatal: mp.fatal, tooMany: mp.tooMany };
    log.info('intake.model_prices', { models: ai.models.length, calls: mp.calls, refused: mp.refused.length, incomplete: incomplete.length, incompletePages, fatal: mp.fatal, tooMany: mp.tooMany });
    if (mp.refused.length) {
      report.warningCodes.push('model-price-not-printed');
      if (mp.tooMany) {
        rankedWarning(report, 'price', `the brochure prices its unit models on too many pages to check (${mp.tooMany.pages}; at most ${mp.tooMany.max} are looked at), so no unit-model price was published — the models show without them`);
      } else {
        if (notPrinted > 0) {
          rankedWarning(report, 'price', `${notPrinted} unit-model price(s) could not be confirmed on the brochure's own pages, so they were left off — the models show without them`);
        }
        if (incomplete.length) {
          rankedWarning(report, 'price', `the check of ${incomplete.length} unit-model price(s) could not be completed (page${incompletePages.length === 1 ? '' : 's'} ${incompletePages.join(', ')}), so they were left off for now — try again later`);
        }
      }
    }
    // "From the cheapest model" is the price of a whole development (rules.mjs headlineFollowsModels: a
    // project, no specific unit, two models or more): a single property — one "model", per-floor rows —
    // and one specific unit keep their own price and the headline checks below; their models keep the
    // prices confirmed above. (An enrichment decides its headline from the listing.)
    if (!enrich && price && headlineFollowsModels({ project: ai.listing?.project, unit: ai.listing?.unit, models: ai.models })
        && ai.models.some((m) => isFigure(m?.price))) {
      const before = { amount: price.amount, subsidised: price.subsidisedAmount };
      alignHeadline(price, ai.models);
      headlineFromModels = true;
      report.priceEvidence = { inText: priceAppearsIn(haystack, price.amount), confirmed: true, fromModels: true };
      // The model's own headline figures are replaced here, not checked. One that is not a
      // confirmed model figure but is stated in the copy must still be printed (the copy guard).
      const kept = new Set(ai.models.flatMap(figuresOf));
      for (const [n, evidence, subsidised] of [[before.amount, ai.priceEvidence, false], [before.subsidised, ai.subsidisedPriceEvidence, true]]) {
        if (!isFigure(n) || kept.has(n) || mp.refused.includes(n) || !inCopy(n)) continue;
        const check = await printed(n, evidence, { subsidised });
        if (!check.inText && !check.confirmed) rejectedPrices.push(n);
      }
    }
  }
  // "From the cheapest model" is for a whole development only. A single property (no project) or one
  // specific unit whose reading took its headline from its models — the lowest model price as read,
  // `from` — is not published "From …" (a villa priced per floor is not "From" its ground floor): `from`
  // is cleared, and the figure must be confirmed on its page AS THE WHOLE PROPERTY'S PRICE by a second
  // model (`whole`: never by the text layer, which cannot tell a floor's price from the villa's), else
  // the listing is on request. A figure the brochure itself prints "starting from" that no model carries
  // keeps its `from`. (A project with one model is left to its own headline check, `from` and all.)
  // A single property (no project) with two models or more whose headline IS the lowest model price takes
  // the same path whatever `from` says (final review S1g): a villa read per floor with its headline = the
  // ground floor and `from` not set would otherwise pass the text layer on the floor's own line. Two
  // models, not two priced ones (final review M3): with the first floor "on request" the ground floor is
  // the only priced row, and still a floor's price, not the villa's.
  // One specific unit is left out of that: priced like one of its project's models, `from` not set, the
  // figure is as likely the unit's own price, and its check asks for the unit's price on the page anyway.
  let ownPriceOnly = false;
  const readFrom = price?.from === true;
  const fromLowestModel = readFrom && (!ai.listing?.project || Boolean(ai.listing?.unit));
  const lowestOfSeveral = !ai.listing?.project && Array.isArray(ai.models) && ai.models.length >= 2;
  if (!enrich && !caption.price && !headlineFromModels && price && !price.onRequest
      && isFigure(price.amount) && price.amount === readLowest && (fromLowestModel || lowestOfSeveral)) {
    price.from = false;
    ownPriceOnly = true;
    log.info('intake.headline_not_from_models', { amount: price.amount, from: fromLowestModel, project: Boolean(ai.listing?.project), unit: Boolean(ai.listing?.unit), models: readModelPrices.length });
  }
  // A single property (no project) with exactly ONE unit model whose price the brochure itself words
  // "starting from" (final review S2m) gets its `from` back — but only after a second model has
  // confirmed the figure on its page as the whole property's price, and only when the reading's own
  // evidence for it carries the from-wording. With one model there is no cheaper row to be "From", so the
  // from-wording is the brochure's; with two or more (floors, parts, layouts) `from` stays cleared,
  // whatever the evidence says. The least risky of the reviewer's two options: the evidence quote is the
  // model's, so it may only ADD the "From" a confirmed own price already earned, never a price. The from-word
  // must lead to the figure in that quote (fromWordingOf): "10 minutes from the airport" is not price wording.
  // Returns the words that earned it, for the warning — or null.
  const startingFromWords = () => (readFrom && !ai.listing?.project && Array.isArray(ai.models) && ai.models.length === 1
    && report.priceEvidence?.confirmed === true ? fromWordingOf(ai.priceEvidence?.quote, price.amount) : null);
  // --- 4c. the floor-plan contact check (r4, owner decision 2026-11-21) — defined here, run after the price
  // checks: before enrichListing on --enrich, after the photo staging on a publish (r5 #4, r6 #6) ---------
  // A plan cut from a developer's PDF can carry the developer's phone, website, QR code, logo or a price table
  // in its pixels. Every plan the run would publish is looked at by a second model — the same pixels, at the same
  // size (writeFloorPlans into the work dir), up to 12 per call, 2 calls at a time (plan-check.mjs) — before any
  // plan file reaches the repo; a dry run asks too. A plan is kept only on one well-formed "clean" answer: one
  // that shows a contact, a logo or a price is left out (its model shows no plan; the listing is never blocked),
  // and one that could not be checked (a quota, a failed call) is left out "for now" — on an enrichment that is
  // an unfinished check (enrichListing). Nothing after a quota error.
  const PLAN_WORDS = { phone: 'a phone number', email: 'an email address', website: 'a website', social: 'a social-media handle', qr: 'a QR code', logo: 'a logo or brand name', price: 'a price' };
  const modelName = (i) => String(ai.models?.[i]?.name?.en ?? `model ${i + 1}`).replace(/\s+/g, ' ').trim().slice(0, 60);
  // Why each model's plan was left out, by model position — for the named plan losses of an enrichment (r6 #5).
  const planWhy = new Map();
  const checkFloorPlans = async () => {
    const models = Array.isArray(ai.models) ? ai.models : [];
    if (!floorPlanTargets(extraction.candidates, models, 'plan-check').some((t) => t.cand)) return;
    report.stage = 'plan-check';
    const dir = path.join(workDir, 'plan-check');
    fs.rmSync(dir, { recursive: true, force: true });
    const written = await writeFloorPlans(extraction.candidates, models, dir, 'plan-check');
    // A plan that could not be prepared here was never checked: it is left out now, so a later write that
    // succeeds can never stage it and a dry run never previews it (r5 #6).
    if (written.skipped?.length) {
      for (const { model } of written.skipped) { models[model].floorPlan = null; planWhy.set(model, 'could not be prepared'); }
      if (!report.warningCodes.includes('images-skipped')) report.warningCodes.push('images-skipped');
      log.warn('intake.floor_plans_skipped', { skipped: written.skipped });
    }
    const ask = async (images) => {
      if (quotaHit) return { reply: '', error: 'the AI quota ran out', fatal: true };
      const res = await askPlanContacts({
        images, bin: cfg.claudeBin, model: cfg.claudeModel, cwd: workDir, addDirs: [workDir], settingsPath: confinement.file,
      });
      log.info('intake.plan_check', { plans: images.length, error: res.error, fatal: res.fatal });
      if (res.fatal) quotaHit = true;
      return res;
    };
    const res = await checkPlanImages(written.map((p) => ({ model: p.model, file: p.file })), { ask });
    for (const { model } of res.dirty) models[model].floorPlan = null;
    for (const model of res.unchecked) { models[model].floorPlan = null; planWhy.set(model, 'not checked'); }
    report.planCheck = {
      plans: written.length, clean: res.clean.length, calls: res.calls, fatal: res.fatal, errors: res.errors,
      leftOut: res.dirty.map(({ model, found }) => ({ model, found })), unchecked: res.unchecked,
    };
    log.info('intake.plan_checked', { plans: written.length, clean: res.clean.length, leftOut: res.dirty.length, unchecked: res.unchecked.length, fatal: res.fatal });
    // Every plan it left out in ONE warning, by model name, grouped by reason (r5 #10, r6 #8): could not be prepared,
    // flagged ("shows …" only for a plan really flagged; a duplicate or malformed answer is no clear answer, r5 #5)
    // or not checked. The WhatsApp reply shows only 3 warnings and ranks this line right after the price ones
    // (rankedWarning): a second plan line, or one per plan, would push the model names out.
    const lineWhy = new Map();
    for (const { model } of written.skipped ?? []) lineWhy.set(model, 'could not be prepared');
    for (const { model, found, flagged } of res.dirty) {
      const what = !flagged ? 'no clear answer from the check'
        : `shows ${found.length ? found.map((w) => PLAN_WORDS[w]).join(', ') : 'contact or brand details'}`;
      lineWhy.set(model, what);
      planWhy.set(model, flagged ? `flagged: ${what}` : what);
    }
    // An enrichment's unchecked plan is an unfinished check, which enrichListing reports: not in this line.
    if (res.unchecked.length && !enrich) {
      // On the listing too (r5 #11): the backfill plans such a listing for enrich, which adds the plans once checked.
      report.warningCodes.push('plans-unchecked');
      // With the listing's real id (Claude r5 NB8); a dry run publishes nothing, so it has no listing to enrich yet.
      const retry = `try again later${dryRun ? '' : ` with \`run-once --enrich ${report.id}\``}`;
      for (const model of res.unchecked) lineWhy.set(model, `could not be checked (${res.fatal ? 'the AI quota ran out' : 'the check failed'}), ${retry}`);
    }
    if (lineWhy.size) {
      const byReason = new Map();
      for (const [model, what] of [...lineWhy].sort(([a], [b]) => a - b)) byReason.set(what, [...(byReason.get(what) ?? []), modelName(model)]);
      const n = lineWhy.size;
      rankedWarning(report, 'plan', `${n} floor plan${n === 1 ? '' : 's'} left out by the contact check (${[...byReason].map(([what, names]) => `${names.join(', ')}: ${what}`).join('; ')})`);
    }
  };

  // An enrichment publishes none of the model's copy, map pin or photos, and decides its headline from
  // the listing (enrichHeadline): the model's own headline and Sakani checks, the copy guard, the map
  // and the photo steps below are for a publish only. Its unit-model prices are checked above, the same.
  if (enrich) {
    // An enrichment publishes none of the listing copy, and the money in its models' text and fact lists was
    // dropped before the checks (3c): there is no copy guard to run. Its plans are checked here, after its
    // (model) price checks, before anything is staged (r5 #4).
    await checkFloorPlans();
    return enrichListing({ report, ai, extraction, cfg, caption, workDir, dryRun, withdrawals, target: enrichTarget, started, currencyDrop, force: enrich.force, planWhy });
  }

  // Under the owner's caption price the model's own figure is not published as the price — but if
  // it also wrote it into the copy, that figure must be printed in the brochure too.
  if (caption.price && price && typeof price.amount === 'number' && price.amount > 0
      && price.amount !== caption.price.amount && inCopy(price.amount)) {
    const check = await printed(price.amount, ai.priceEvidence);
    if (!check.inText && !check.confirmed) rejectedPrices.push(price.amount);
  }
  if (!headlineFromModels && !caption.price && price && !price.onRequest && typeof price.amount === 'number' && price.amount > 0) {
    // Codex r1 #1: the text layer cannot tie a figure to one unit model or one unit. A headline that IS a
    // model figure the page check refused — looked at and not found, or whose check could not be done
    // (`incomplete`: a timeout, a render, a quota — r2 #2) — and the headline of one specific unit read with
    // unit models beside it, are settled only on a page, as the whole listing's own price — else "on
    // request", and "try again later" when that check cannot run either.
    const refusedAsModel = (report.modelPrices?.refused ?? []).includes(price.amount);
    const unitAmongModels = Boolean(ai.listing?.unit) && Array.isArray(ai.models) && ai.models.length > 0;
    const pageOnly = ownPriceOnly || refusedAsModel || unitAmongModels;
    // A rental's headline (a caption period, a period read, a rent listing) is settled only on a page, FOR its
    // period — with unit models or without (r3 #4). An ordinary sale without models keeps the text layer.
    const rentHeadline = Boolean(caption.period || readingPeriod || listingPeriod);
    // A sale's headline that may be a rent (r6 #3, Codex r5 #3): the reading gives it a period, or a line of the
    // text printing it, or the reading's quote of it, speaks of rent or income. The text layer cannot tell a rent
    // from an asking price: only its page settles it, asked as a sale's price. A sale with no period, printed on a
    // line with no such words, keeps the text layer.
    const saleMayBeRent = !listingPeriod && (Boolean(price.period) || rentWorded(ai.priceEvidence?.quote)
      || haystack.split('\n').some((line) => rentWorded(line) && priceAppearsIn(line, price.amount)));
    report.priceEvidence = await printed(price.amount, ai.priceEvidence, { whole: pageOnly, pageCheck: rentHeadline || saleMayBeRent, sale: saleMayBeRent });
    const fromWords = ownPriceOnly ? startingFromWords() : null;
    if (!report.priceEvidence.inText && !report.priceEvidence.confirmed) {
      log.warn('intake.price_unevidenced', { amount: price.amount, currency: price.currency, unchecked: report.priceEvidence.unchecked === true, why: report.priceEvidence.uncheckedWhy ?? null, whole: pageOnly });
      rejectedPrices.push(price.amount);
      price.amount = null;
      price.onRequest = true;
      price.from = false;
      report.warningCodes.push('price-not-printed');
      rankedWarning(report, 'price', report.priceEvidence.unchecked
        ? `the price could not be checked on the brochure (${uncheckedWhy(report.priceEvidence)}), so the listing says "price on request" for now — try again later, or send \`price <id> <amount>\` to set one`
        : ownPriceOnly
          ? 'the price read was the lowest unit-model price, which the brochure does not print as this single property\'s own price (a property is not "From" its cheapest model), so the listing says "price on request" — send `price <id> <amount>` to set one'
          : 'the price was not printed in the brochure, so the listing says "price on request" — send `price <id> <amount>` to set one');
    } else if (fromWords) {
      price.from = true;
      rankedWarning(report, 'price', `the price read was its one unit model's; confirmed on its page as the property's own price, and shown "From" as the brochure words it (its evidence: "${fromWords}")`);
    } else if (ownPriceOnly) {
      rankedWarning(report, 'price', 'the price read was the lowest unit-model price; a single property is not "From" its cheapest model, so it is shown as the property\'s own price (confirmed on its page)');
    }
  }
  // The subsidised (Sakani) price rides on the headline price: it is published only beside a
  // published brochure price, and only when a second model has seen it printed AS the subsidy
  // beneficiaries' price on a page image. The owner's caption price replaces both.
  if (!headlineFromModels && price && typeof price.subsidisedAmount === 'number') {
    const headline = !caption.price && !price.onRequest && typeof price.amount === 'number' && price.amount > 0;
    // Checked even under the owner's caption price: the price field drops the figure then (the
    // caption replaces both), but if the model also wrote it into the copy it must be a printed one.
    const evidence = (headline || (caption.price && inCopy(price.subsidisedAmount)))
      ? await printed(price.subsidisedAmount, ai.subsidisedPriceEvidence, { subsidised: true, whole: ownPriceOnly }) : null;
    report.subsidisedPriceEvidence = evidence;
    if (!evidence?.confirmed) {
      if (headline) {
        log.warn('intake.subsidised_price_unevidenced', { amount: price.subsidisedAmount, currency: price.currency, unchecked: evidence?.unchecked === true });
        report.warningCodes.push('subsidised-price-not-printed');
        rankedWarning(report, 'price', evidence?.unchecked
          ? `the subsidised (Sakani) price could not be checked on the brochure (${uncheckedWhy(evidence)}), so only the regular price is shown for now — try again later`
          : 'the subsidised (Sakani) price could not be confirmed on the brochure, so only the regular price is shown');
      }
      if (price.subsidisedAmount > 0) rejectedPrices.push(price.subsidisedAmount);
      price.subsidisedAmount = null;
    }
  }

  // A price the check took away must not survive in the words: the site prints `price`, but a
  // figure in the title, description or highlights would still be read as a price (a model's rooms and
  // availability and the fact lists lost theirs at 3c). The same matcher that looks for the number in the
  // brochure looks for it in that copy, mention by mention (refusedFigureIn).
  // A figure that IS published — the headline, its Sakani price, a model price a second model saw
  // printed — is not a refused one, even when the same figure was refused for another model.
  const stated = refusedFigureIn(copySegments, rejectedPrices, caption.price
    ? [caption.price.amount]
    : [price && !price.onRequest ? price.amount : null, price?.subsidisedAmount, ...(Array.isArray(ai.models) ? ai.models : []).flatMap(figuresOf)]);
  if (stated) {
    const n = stated.n.toLocaleString('en-US');
    throw new RejectError(caption.price
      ? `${stated.where} states the price ${n}, which could not be confirmed on the brochure — send it again; the next reading may leave it out`
      : `${stated.where} states the price ${n}, which could not be confirmed on the brochure — resend with the price in the caption, or without it`, 'price');
  }

  // --- 4b. map pin --------------------------------------------------------------
  // A brochure almost never prints coordinates, but it very often hides a Google Maps link
  // behind its location page. Two independent links must agree before we publish a pin —
  // brochures link landmarks too (one links King Abdulaziz airport), and a wrong pin is
  // worse than none. No pin here is not a failure: the site falls back to the district.
  report.stage = 'map';
  let mapPin = null;
  try {
    mapPin = await pinFromLinks(extraction.links);
  } catch (e) {
    log.warn('intake.map_failed', { error: String(e?.message || e) });
  }
  report.map = mapPin;
  log.info('intake.map', { links: (extraction.links || []).length, pin: mapPin });
  if (!mapPin && (extraction.links || []).some((l) => /maps/i.test(l.uri || ''))) {
    report.warningCodes.push('map-unconfirmed');
    report.warnings.push('the brochure has a map link but no two links agreed on one point, so the listing shows its district only');
  }

  // --- 5. images + listing ----------------------------------------------------
  report.stage = 'listing';
  report.picks = picks;
  report.excluded = (ai.images || []).filter((im) => im.exclude).map((im) => ({ index: im.index, reason: im.reason }));
  if (picks.length < cfg.minImages) {
    const why = cropped
      ? `even after cutting ${cropped.crops.length} photo region(s) out of its own pages`
      : (extraction.rendered ? 'the PDF has no extractable photographs, only page renders' : 'the rest were floor plans, logos or duplicates');
    const reason = `not enough usable photos — ${picks.length} of ${cfg.minImages} needed (${why})`;
    // A dry run is a preview: show the owner what WOULD have been published and why it
    // cannot be, instead of hiding the listing behind an early exit.
    if (!dryRun) throw new RejectError(reason, 'images');
    report.blocked = reason;
    report.warnings.push(reason);
    report.warningCodes.push('not-enough-photos');
  }

  // The last word on "have we published this before?", asked of the pulled repo itself and
  // therefore proof against a lost state file or a publish that `run-once.mjs` made. The
  // caller's own sha dedupe runs first and answers more kindly; this one is the backstop
  // that stands between a replay and a second listing id.
  if (!dryRun) {
    const twin = findByPdfSha(cfg.repo, report.sha256);
    if (twin && !(meta.replace && twin.id === meta.id)) {
      const err = new RejectError(`this brochure is already published as ${twin.id} — ${cfg.site}/properties/${twin.slug}/`, 'duplicate');
      err.published = { id: twin.id, slug: twin.slug, url: `${cfg.site}/properties/${twin.slug}/` };
      throw err;
    }
  }

  // The floor-plan contact check (4c) runs after EVERY price check (models, headline, Sakani) — so its quota or
  // failure can never change a price — and after the copy guard, the photo gate and the duplicate check, so no
  // call is spent on a run that fails those (r5 #4). A dry run asks here, unless it would not publish; a publish
  // asks once its photos are staged and counted (6., r6 #6).
  if (dryRun && !report.blocked) await checkFloorPlans();

  const index = readIndex(cfg.repo);
  const id = meta.id || nextListingId(index, inboxIds(cfg.repo));
  const baseSlug = slugify(ai.listing.title.en) || slugify(ai.listing.location?.district?.en, ai.listing.type) || `listing-${id.toLowerCase()}`;
  const slug = meta.slug || uniqueSlug(baseSlug, takenSlugs(cfg.repo));
  report.id = id;
  report.slug = slug;
  report.url = `${cfg.site}/properties/${slug}/`;

  const day = (meta.listedAt || todayRiyadh()).replace(/-/g, '');
  const tail = meta.messageId ? String(meta.messageId).replace(/[^A-Za-z0-9]/g, '').slice(0, 6) : report.sha256.slice(0, 6);
  const sourceRef = (meta.replace && meta.sourceRef) || `WA-${day}-${tail.toUpperCase()}`;

  if (dryRun) {
    report.stage = 'dry-run';
    // The paths writeFloorPlans() would write, for every plan whose candidate exists — no file is made.
    let floorPlans = floorPlanTargets(extraction.candidates, ai.models ?? [], slug).filter((t) => t.cand)
      .map(({ model, index, src, thumb }) => ({ model, index, src, thumb }));
    // A blocked dry run skipped the contact check: none of its plans was looked at, so none is previewed (r6 #6).
    if (report.blocked && !report.planCheck && floorPlans.length) {
      rankedWarning(report, 'plan', `${floorPlans.length} floor plan(s) were not checked for contact details because the run would not publish, so the preview shows none`);
      floorPlans = [];
    }
    report.floorPlans = floorPlans.map((p) => ({ model: p.model, candidate: p.index, src: p.src }));
    report.listingPreview = buildListing({
      ai,
      images: picks.map((p) => ({ ...p, n: p.rank, src: `/listings/${slug}/${String(p.rank).padStart(2, '0')}.jpg`, thumb: `/listings/${slug}/${String(p.rank).padStart(2, '0')}-thumb.webp` })),
      floorPlans,
      slug, id, repo: cfg.repo, caption, site: cfg.site,
      meta: { ...meta, sourceRef, pdfSha256: report.sha256, model: cfg.claudeModel, warningCodes: report.warningCodes, map: mapPin },
    });
    const problems = checkListing(report.listingPreview, { minImages: cfg.minImages, maxImages: cfg.maxImages, withdrawals });
    if (problems.length) report.warnings.push(...problems);
    report.durationMs = Date.now() - started;
    report.ok = true;
    return report;
  }

  // --- 6. stage the files OUTSIDE the repo -------------------------------------
  report.stage = 'write';
  const stageDir = path.join(workDir, 'publish', slug);
  fs.rmSync(stageDir, { recursive: true, force: true });
  const images = await writeListingImages(extraction.candidates, picks, stageDir, slug);
  if (images.skipped?.length) {
    report.warningCodes.push('images-skipped');
    report.warnings.push(`${images.skipped.length} photo(s) could not be processed and were left out`);
    log.warn('intake.images_skipped', { skipped: images.skipped });
  }
  report.images = images.map((im) => ({ n: im.n, candidate: im.index, room: im.room, src: im.src, w: im.width, h: im.height, reason: im.reason }));
  // A photo staging could not decode can leave the run under the minimum: refused here, before the plan check
  // spends a call on it (r6 #6) — the same refusal checkListing would give below.
  if (images.length < cfg.minImages) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    throw new RejectError(`not enough usable photos (${images.length} of ${cfg.minImages} needed)`, 'validate');
  }
  // The plan check (4c) on a publish: after the photos are staged and counted, before any plan is staged.
  await checkFloorPlans();
  report.stage = 'write';
  // Each unit model's floor plan, staged beside the photos (plan-NN.jpg, NN = the model's position),
  // so it is promoted — and rolled back — with them. One that cannot be decoded costs that model its
  // plan, never the listing.
  const floorPlans = await writeFloorPlans(extraction.candidates, ai.models ?? [], stageDir, slug);
  if (floorPlans.skipped?.length) {
    if (!report.warningCodes.includes('images-skipped')) report.warningCodes.push('images-skipped');
    report.warnings.push(`${floorPlans.skipped.length} floor plan(s) could not be processed and were left out`);
    log.warn('intake.floor_plans_skipped', { skipped: floorPlans.skipped });
  }
  report.floorPlans = floorPlans.map((p) => ({ model: p.model, candidate: p.index, src: p.src }));

  const listing = buildListing({
    ai, images, floorPlans, slug, id, repo: cfg.repo, caption, site: cfg.site,
    meta: { ...meta, sourceRef, brochureUrl: null, pdfSha256: report.sha256, model: cfg.claudeModel, hidden: caption.hidden, warningCodes: report.warningCodes, map: mapPin },
  });
  const problems = checkListing(listing, { minImages: cfg.minImages, maxImages: cfg.maxImages, withdrawals });
  if (problems.length) {
    fs.rmSync(stageDir, { recursive: true, force: true });   // nothing reached the repo
    throw new RejectError(problems[0], 'validate');
  }

  // --- 5b. the Bona brochure ---------------------------------------------------
  // Default ON: the owner's whole point is that a brochure he is sent comes back out under
  // his own brand. It is drawn from scratch (brochure_pdf.py) out of the FINAL listing and the
  // photos and floor plans just staged, into the staging dir, so it is promoted with them and
  // rolled back with them. Nothing of the developer's PDF is re-published.
  // A failure here never costs the listing — it publishes without a downloadable document.
  report.stage = 'brochure';
  if (caption.noBrochure) {
    report.brochure = { skipped: 'nobrochure' };
    log.info('intake.brochure_skipped', { slug, reason: 'nobrochure' });
  } else {
    const built = await buildBrandedBrochure({
      listing, filesDir: stageDir, outPath: brochureFileIn(stageDir), workDir, cfg,
    });
    report.brochure = built;
    if (built.ok) {
      listing.brochureUrl = brochureUrlFor(cfg.site, slug);
      log.info('intake.brochure_built', { slug, bytes: built.bytes, pages: built.pages, steps: built.steps });
    } else {
      const code = built.reason === 'too-large' ? 'brochure-too-large' : 'brochure-failed';
      report.warningCodes.push(code);
      addWarningCode(listing, code);
      report.warnings.push(built.reason === 'too-large'
        ? `${built.error} — the listing was published without a downloadable brochure`
        : 'the Bona-branded brochure could not be built, so the listing was published without one (the reason is in the journal)');
      log.warn('intake.brochure_failed', { slug, reason: built.reason, error: built.error, detail: built.detail });
    }
  }

  // --- 7. promote into the repo, then rebuild ----------------------------------
  report.stage = 'promote';
  const dirProblem = listingDirProblem(cfg.repo, slug) ?? recordFileProblem(cfg.repo, path.join(cfg.repo, 'scripts', 'curate', 'inbox', `${slug}.json`));
  if (dirProblem) {
    fs.rmSync(stageDir, { recursive: true, force: true });   // nothing reached the repo
    throw new Error(`${dirProblem} — nothing was written to the repo`);
  }
  const publicDir = path.join(cfg.repo, 'public', 'listings', slug);
  const listingDirs = [path.join('public', 'listings', slug)];
  try {
    fs.mkdirSync(path.dirname(publicDir), { recursive: true });
    // A replacement starts from an empty folder: a photo (or brochure) the new run did not
    // publish must not stay reachable by URL. The rollback below restores the old files from git.
    if (meta.replace) removeListingImages(path.join(cfg.repo, 'public'), slug);
    // The branded brochure was staged alongside the photos, so it is promoted — and rolled
    // back — with them; nothing is copied into the repo out of band.
    fs.cpSync(stageDir, publicDir, { recursive: true });
    report.file = writeInboxListing(cfg.repo, listing);
    // Never wind the counter back: a replacement re-uses an id older than the newest one.
    writeIndex(cfg.repo, { ...index, nextSeq: Math.max(Number(index.nextSeq) || 0, seqAfter(id)), listings: { ...index.listings, [slug]: id } });
    report.listing = listing;

    report.stage = 'rebuild';
    report.rebuild = await rebuild(cfg.repo);
  } catch (err) {
    // Anything from here on leaves the clone dirty; put it back so the NEXT job can pull.
    const clean = await resetTree(cfg.repo, { dirs: listingDirs });
    log.error('intake.rolled_back', { slug, stage: report.stage, clean, error: err.message, detail: err.detail });
    err.rolledBack = true;
    throw err;
  }
  report.durationMs = Date.now() - started;
  report.ok = true;
  report.stage = 'done';
  return report;
}

/**
 * What an enrichment would take away from the listing as it stands: `built` (modelsAndFacts() of the new
 * reading, its model prices and floor plans as they will be published) against `existing`. `before` /
 * `after` count the unit models, their published price figures (regular and Sakani) and their floor
 * plans, and name the fact lists carried; `losses` says, in words, every count that would go down, every
 * fact list that would go and, when the plan count does not go down, every model that would lose its plan,
 * and why: `why` maps a new model's position to the reason its plan was left out (r6 #5).
 */
export function compareEnrichment(existing, built, why = new Map()) {
  const list = (models) => (Array.isArray(models) ? models : []);
  const figures = (models) => list(models).flatMap((m) => [m?.price, m?.subsidisedPrice]).filter(isFigure).length;
  const hasPlan = (m) => Boolean(m?.floorPlan && typeof m.floorPlan === 'object' && typeof m.floorPlan.src === 'string');
  const plans = (models) => list(models).filter(hasPlan).length;
  const facts = (l) => Object.keys(FACT_LISTS).filter((k) => ['en', 'ar'].some((lang) => Array.isArray(l?.[k]?.[lang]) && l[k][lang].length > 0));
  const side = (l) => ({ models: list(l?.models).length, prices: figures(l?.models), plans: plans(l?.models), facts: facts(l) });
  const before = side(existing);
  const after = side(built);
  const losses = [];
  if (after.models < before.models) losses.push(`unit models ${before.models} → ${after.models}`);
  if (after.prices < before.prices) losses.push(`confirmed model prices ${before.prices} → ${after.prices}`);
  // Plans are lost per model (Codex r4 #6): a model that carries a plan and would have none (flagged, unchecked,
  // skipped, not found, or the model itself gone) is a loss even when another model gains one and the count holds.
  // A new model with a plan covers an old one (r6 #5) when their English names are equal and each unique on its
  // side ("Al Zumurrud 2" is "Zumurrud 2"), or their Arabic names are, or English, Arabic and area are all equal;
  // it covers one at most. A loss says why: the reason its new model's plan was left out, else no plan was read.
  const olds = list(existing?.models);
  const news = list(built?.models);
  const en = (m) => String(m?.name?.en ?? '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/^(?:al |al-|the )/, '');
  const ar = (m) => String(m?.name?.ar ?? '').replace(/\u0640/g, '').trim().replace(/\s+/g, ' ');
  const tally = (models, f) => models.reduce((n, m) => n.set(f(m), (n.get(f(m)) ?? 0) + 1), new Map());
  const [oldEn, newEn, oldAr, newAr] = [tally(olds, en), tally(news, en), tally(olds, ar), tally(news, ar)];
  const same = (o, n) => (en(o) !== '' && en(o) === en(n) && oldEn.get(en(o)) === 1 && newEn.get(en(n)) === 1)
    || (ar(o) !== '' && ar(o) === ar(n) && oldAr.get(ar(o)) === 1 && newAr.get(ar(n)) === 1)
    || (en(o) === en(n) && ar(o) === ar(n) && (o?.areaSqm ?? null) === (n?.areaSqm ?? null));
  const used = new Set();
  const planDropped = [];
  olds.forEach((m, i) => {
    if (!hasPlan(m)) return;
    const j = news.findIndex((n, k) => !used.has(k) && hasPlan(n) && same(m, n));
    if (j >= 0) { used.add(j); return; }
    const k = news.findIndex((n) => !hasPlan(n) && same(m, n));
    const lost = `${String(m?.name?.en ?? '').trim() || `model ${i + 1}`} (${(k >= 0 && why.get(k)) || 'no plan in the new reading'})`;
    if (!planDropped.includes(lost)) planDropped.push(lost);
  });
  if (after.plans < before.plans) losses.push(`floor plans ${before.plans} → ${after.plans}`);
  else if (planDropped.length) losses.push(`floor plan${planDropped.length === 1 ? '' : 's'} dropped: ${planDropped.join(', ')}`);
  const dropped = before.facts.filter((k) => !after.facts.includes(k));
  if (dropped.length) losses.push(`fact list${dropped.length === 1 ? '' : 's'} dropped: ${dropped.join(', ')}`);
  return { before, after, losses };
}

/** A floor-plan file in a listing's folder (rules.mjs LOCAL_PLAN_SRC / LOCAL_PLAN_THUMB). */
const PLAN_FILE_RE = /^plan-\d{2,3}(?:\.jpg|-thumb\.webp)$/;

/**
 * The rest of `run-once --enrich <id>`, once the brochure has been read and its unit-model prices
 * checked: build the models (with their floor plans) and the fact lists exactly as a publish would,
 * decide the headline from the EXISTING listing (enrichHeadline — a refusal changes nothing), merge
 * ONLY those into the listing (mergeEnrichment), check it like a publish (checkListing), then: replace
 * the floor-plan files in public/listings/<slug>/, draw the brochure from the merged listing and that
 * folder, write the inbox JSON and rebuild. Anything that fails after the first file is touched is
 * rolled back from git (resetTree), so the listing is exactly as it was. A dry run reports what would
 * change and writes nothing.
 */
async function enrichListing({ report, ai, extraction, cfg, caption, workDir, dryRun, withdrawals, target, started, currencyDrop = null, force = false, planWhy = new Map() }) {
  report.stage = 'enrich';
  const existing = target.listing;
  const { id, slug } = existing;
  report.id = id;
  report.slug = slug;
  report.url = `${cfg.site}/properties/${slug}/`;
  const publicDir = path.join(cfg.repo, 'public', 'listings', slug);
  const oldPlans = (fs.existsSync(publicDir) ? fs.readdirSync(publicDir) : []).filter((f) => PLAN_FILE_RE.test(f)).sort();

  // The floor plans, staged in the work dir (a dry run only names them), so nothing reaches the repo
  // before checkListing() has passed. A plan that cannot be decoded costs that model its plan.
  const stageDir = path.join(workDir, 'enrich', slug);
  fs.rmSync(stageDir, { recursive: true, force: true });
  let floorPlans;
  if (dryRun) {
    floorPlans = floorPlanTargets(extraction.candidates, ai.models ?? [], slug).filter((t) => t.cand)
      .map(({ model, index, src, thumb }) => ({ model, index, src, thumb }));
  } else {
    floorPlans = await writeFloorPlans(extraction.candidates, ai.models ?? [], stageDir, slug);
    if (floorPlans.skipped?.length) {
      for (const { model } of floorPlans.skipped) planWhy.set(model, 'could not be prepared');
      report.warningCodes.push('images-skipped');
      report.warnings.push(`${floorPlans.skipped.length} floor plan(s) could not be processed and were left out`);
      log.warn('intake.floor_plans_skipped', { skipped: floorPlans.skipped });
    }
  }
  report.floorPlans = floorPlans.map((p) => ({ model: p.model, candidate: p.index, src: p.src }));

  // What a publish writes for the models and the facts — under the listing's OWN category (a rental's
  // models keep no Sakani price), whatever the model read this time.
  const built = modelsAndFacts(ai, floorPlans, { rent: existing.category === 'rent' });
  const models = built.models ?? [];
  const aligned = models.some((m) => isFigure(m.price)) && existing.price && typeof existing.price === 'object'
    ? alignHeadline(structuredClone(existing.price), models) : null;
  const head = enrichHeadline(existing, models, aligned, { currencyMismatch: currencyDrop?.decision === 'currency-mismatch' });
  if (head.dropModelPrices) for (const m of models) { m.price = null; m.subsidisedPrice = null; }
  const priceChanged = !isDeepStrictEqual(head.price, existing.price);
  const compare = compareEnrichment(existing, built, planWhy);
  // Never write over a listing with less than it carries. An incomplete price check (a page that did
  // not render, a failed call, a quota) is ours, not the brochure's: when the listing already carries
  // model prices it could lose, nothing changes — try again later; a listing with none to lose gets the
  // model prices it could lose, nothing changes — try again later; and so on a first enrichment too, whatever
  // cut the check short (a quota: Codex r1 #9; a page that did not render, a failed call: r2 #9) — nothing is
  // committed and the run is retryable, so the backfill enriches the listing again from scratch instead of
  // finding it "already enriched" by the plans and fact lists a cut-short run would have committed.
  // A reading with fewer models, fewer confirmed model prices, fewer floor plans (or a model's plan) or a fact list fewer is
  // refused unless --force says it is right (the brochure really changed, or the old reading was wrong).
  const mp = report.modelPrices;
  // The way out of a check that keeps failing (r3 #7): --force accepts a FIRST enrichment (no model price to
  // lose) whose check could not finish for a reason that is not a quota — published without those prices.
  const incompleteCount = mp?.incomplete?.length ?? 0;
  const forcedUnchecked = Boolean(mp) && !mp.fatal && incompleteCount > 0 && force && compare.before.prices === 0;
  if (forcedUnchecked) {
    report.warnings.push(`--force: published without the ${incompleteCount} unit-model price(s) whose check could not be completed (page${mp.incompletePages.length === 1 ? '' : 's'} ${mp.incompletePages.join(', ')}) — run --enrich again later to add them`);
  }
  const priceUnchecked = mp && (mp.fatal || (incompleteCount > 0 && !forcedUnchecked))
    ? `${mp.fatal ? 'the AI quota ran out during the unit-model price check' : `the check of ${mp.incomplete.length} unit-model price(s) could not be completed (page${mp.incompletePages.length === 1 ? '' : 's'} ${mp.incompletePages.join(', ')})`} — nothing was changed; try again later`
    : null;
  // The floor-plan contact check (r4) is a check like the price check: one cut short commits nothing (retryable).
  // --force takes the models without those plans only on a first enrichment (no plan to lose) and not after a quota.
  const pc = report.planCheck;
  const plansUnchecked = pc?.unchecked?.length ?? 0;
  const forcedPlans = plansUnchecked > 0 && !pc.fatal && force && compare.before.plans === 0;
  if (forcedPlans) report.warnings.push(`--force: published without the ${plansUnchecked} floor plan(s) the contact check could not complete — run --enrich again later to add them`);
  const planUnchecked = plansUnchecked > 0 && !forcedPlans
    ? `${pc.fatal ? 'the AI quota ran out during the floor-plan contact check' : `the floor-plan contact check of ${plansUnchecked} plan(s) could not be completed`} — nothing was changed; try again later`
    : null;
  const unchecked = priceUnchecked ?? planUnchecked;
  const degraded = compare.losses.length && !force
    ? `${id} already carries more than this reading: ${compare.losses.join('; ')} — nothing was changed; re-run with --force if the new reading is right`
    : null;
  const refuse = unchecked ?? head.refuse ?? degraded;
  report.enrich = {
    models: models.length,
    pricedModels: models.filter((m) => isFigure(m.price)).length,
    keptPrices: models.flatMap((m) => [m.price, m.subsidisedPrice]).filter(isFigure).length,
    refusedPrices: report.modelPrices?.refused ?? [],
    headline: head.decision,
    price: head.price,
    previousPrice: existing.price,
    priceChanged,
    refuse,
    currency: currencyDrop?.currency ?? null,
    compare: { ...compare, forced: compare.losses.length > 0 && force },
    facts: Object.keys(built).filter((k) => k !== 'models'),
    plans: floorPlans.map((p) => p.src),
    removedPlans: oldPlans,
  };
  log.info('intake.enrich', {
    id, models: models.length, kept: report.enrich.keptPrices, refused: report.enrich.refusedPrices.length,
    headline: head.decision, priceChanged, plans: floorPlans.length, removedPlans: oldPlans.length,
    losses: compare.losses, forced: report.enrich.compare.forced, unchecked: Boolean(unchecked),
  });
  if (refuse) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    if (!dryRun) {
      const err = new RejectError(refuse, 'enrich');
      // An unfinished check is ours, not the listing's: run-once reports it as a failure to retry (r2 #9).
      if (refuse === unchecked) err.retryable = true;
      throw err;
    }
    report.blocked = refuse;
  }

  const merged = mergeEnrichment(existing, built, priceChanged ? { price: head.price } : {});
  // `plans-unchecked` (r5 #11) is what makes the backfill enrich the listing again: --force taking the models
  // without their unchecked plans sets it; a reading whose plans were all checked clears it.
  if (forcedPlans) addWarningCode(merged, 'plans-unchecked');
  else if (Array.isArray(merged._intake?.warnings)) merged._intake.warnings = merged._intake.warnings.filter((c) => c !== 'plans-unchecked');
  // The listing already has a brochure, printed from the data the enrichment replaces (r2 #8): if the new one
  // cannot be built, nothing is committed — the old PDF would contradict the new data, whichever row moved.
  const hadBrochure = Boolean(existing.brochureUrl) || fs.existsSync(brochureFileIn(publicDir));
  report.enrich.hadBrochure = hadBrochure;
  const problems = checkListing(merged, { minImages: cfg.minImages, maxImages: cfg.maxImages, withdrawals });
  if (dryRun) {
    report.stage = 'dry-run';
    report.listingPreview = merged;
    if (problems.length) {
      report.warnings.push(...problems);
      report.blocked ??= problems[0];
    }
    report.durationMs = Date.now() - started;
    report.ok = true;
    return report;
  }
  if (problems.length) {
    fs.rmSync(stageDir, { recursive: true, force: true });   // nothing reached the repo
    throw new RejectError(problems[0], 'validate');
  }
  // Every other key is written back exactly as it was read; a file the intake did not write itself
  // (other indentation, escaped Arabic) comes back in the intake's own JSON layout, values unchanged.
  if (fs.readFileSync(target.file, 'utf8') !== `${JSON.stringify(existing, null, 2)}\n`) {
    report.warnings.push(`${path.basename(target.file)} was not in the intake's own JSON layout; it is rewritten in it (no value other than the enrichment changes)`);
  }

  try {
    report.stage = 'promote';
    fs.mkdirSync(publicDir, { recursive: true });
    // Every old plan goes first: a model the new reading numbers differently must not leave a plan
    // reachable by URL. The rollback below brings them back from git.
    for (const f of oldPlans) fs.rmSync(path.join(publicDir, f), { force: true });
    if (fs.existsSync(stageDir)) fs.cpSync(stageDir, publicDir, { recursive: true });

    // The brochure prints the merged listing, out of the listing's own folder (its photos as they are
    // now, the new plans). Drawn in the work dir and moved in whole, so a half-written file is never
    // served. A failure on a listing that has a brochure commits nothing (r2 #8); one that has none keeps the
    // enrichment without a brochure, and says so (as on a publish).
    report.stage = 'brochure';
    if (caption.noBrochure) {
      report.brochure = { skipped: 'nobrochure' };
      log.info('intake.brochure_skipped', { slug, reason: 'nobrochure' });
    } else {
      const out = path.join(workDir, 'enrich-brochure', BROCHURE_FILE);
      fs.rmSync(path.dirname(out), { recursive: true, force: true });
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const brochure = await buildBrandedBrochure({ listing: merged, filesDir: publicDir, outPath: out, workDir, cfg });
      report.brochure = brochure;
      if (brochure.ok) {
        const tmp = path.join(publicDir, `.${BROCHURE_FILE}.tmp`);
        // Whatever is at the temp name — a symlink too — goes first, and the copy creates a new file (r2 #6).
        fs.rmSync(tmp, { force: true });
        fs.copyFileSync(out, tmp, fs.constants.COPYFILE_EXCL);
        fs.renameSync(tmp, brochureFileIn(publicDir));
        merged.brochureUrl = brochureUrlFor(cfg.site, slug);
        // As `brochure <id>`: a stale "could not build" note does not outlive a brochure that built.
        const w = merged._intake?.warnings;
        if (Array.isArray(w) && w.some((c) => c === 'brochure-failed' || c === 'brochure-too-large')) {
          merged._intake.warnings = w.filter((c) => c !== 'brochure-failed' && c !== 'brochure-too-large');
        }
        log.info('intake.brochure_built', { slug, bytes: brochure.bytes, pages: brochure.pages, steps: brochure.steps });
      } else {
        log.warn('intake.brochure_failed', { slug, reason: brochure.reason, error: brochure.error, detail: brochure.detail });
        // The old brochure prints the old data: it may not stay up beside the new listing, so nothing is committed
        // (Codex r1 #8, r2 #8) — the catch below rolls every file back. A listing with none gets the enrichment.
        if (hadBrochure) {
          throw new Error(`the Bona brochure could not be rebuilt${brochure.reason === 'too-large' ? ` (${brochure.error})` : ''}, and the listing's `
            + 'old brochure would contradict the enriched listing (its models, prices and plans), so nothing was changed; '
            + 'run --enrich again once the brochure builds');
        }
        const code = brochure.reason === 'too-large' ? 'brochure-too-large' : 'brochure-failed';
        report.warningCodes.push(code);
        addWarningCode(merged, code);
        report.warnings.push(brochure.reason === 'too-large'
          ? `${brochure.error} — the listing was enriched without a downloadable brochure`
          : 'the Bona-branded brochure could not be built, so the listing was enriched without one (the reason is in the journal)');
      }
    }

    report.stage = 'write';
    fs.writeFileSync(target.file, `${JSON.stringify(merged, null, 2)}\n`);
    report.file = target.file;
    report.listing = merged;

    report.stage = 'rebuild';
    report.rebuild = await rebuild(cfg.repo);
  } catch (err) {
    // The listing was committed and unchanged (checked first), so git puts every file back as it was.
    const clean = await resetTree(cfg.repo);
    log.error('intake.rolled_back', { slug, stage: report.stage, clean, error: err.message, detail: err.detail });
    err.rolledBack = true;
    throw err;
  }
  report.durationMs = Date.now() - started;
  report.ok = true;
  report.stage = 'done';
  return report;
}
