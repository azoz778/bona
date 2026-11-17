// TAQEEM cross-check: a price may only be published when the NUMBER is actually printed in
// the brochure (or typed by the owner). The model is not trusted to have read one — this
// module looks the figure up in the PDF's text layer and in the caption.
const ARABIC_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };

/** Arabic-Indic / Persian digits -> ASCII. */
export const westernise = (s) => String(s ?? '').replace(/[٠-٩۰-۹]/g, (d) => ARABIC_DIGITS[d] ?? d);

const SEP = '[\\s.,،\'’ ٫٬  ]*';

/**
 * Every way `amount` can be printed, as a regular expression over westernised text: the exact digit
 * run with any thousands separators between digits, then "4.5m" / "4.5 million" / "٤٫٥ مليون" /
 * "990k" / "٩٩٠ ألف". `flags` adds `g` for the callers that want every occurrence.
 */
function figurePatterns(amount, flags = '') {
  const out = [];
  const body = String(Math.round(amount)).split('').join(SEP);
  // Not part of a longer figure on either side: 450,000 is not "printed" inside 1,450,000, nor
  // 319,015 inside 319,015,000.
  // ("SAR 1,250,000.00" and "ر.س.1,250,000" still count: a decimal tail or a dot before the figure is not more digits.)
  out.push(new RegExp(`(?<!\\d[.,٫٬'’]?)${body}(?![\\d]|[,٬'’]\\d|[.٫]\\d{3})`, flags));
  for (const [div, words] of [[1e6, ['m', 'mn', 'million', 'مليون', 'ملايين']], [1e3, ['k', 'thousand', 'ألف', 'الف', 'آلاف', 'الاف']]]) {
    const v = amount / div;
    if (!(v >= 1 && v < 1000)) continue;
    const s = Number(v.toFixed(3)).toString().replace('.', '[.,٫]');
    for (const w of words) {
      // "4.5m" / "990k" only written solid: "20 m" is twenty metres, not twenty million.
      const gap = w === 'm' || w === 'k' ? '' : '\\s*';
      out.push(new RegExp(`(?<![\\d.,٫])${s}${gap}${w}(?![a-z\\u0600-\\u06ff])`, `i${flags}`));
    }
  }
  return out;
}

/**
 * @param {string} text   PDF text layer and/or caption
 * @param {number} amount the price the model returned
 * @returns {boolean} true when the number is genuinely printed
 */
export function priceAppearsIn(text, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const t = westernise(text || '');
  if (!t) return false;
  return figurePatterns(amount).some((re) => re.test(t));
}

/**
 * Every place `amount` is printed in `text`, by priceAppearsIn's figure rules: `{ index, end }` offsets into
 * the text (westernise turns one digit into one digit, so they hold for the text as given), leftmost first.
 */
export function figureMatches(text, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return [];
  const t = westernise(text || '');
  const out = [];
  for (const re of figurePatterns(amount, 'g')) for (const m of t.matchAll(re)) out.push({ index: m.index, end: m.index + m[0].length });
  return out.sort((x, y) => x.index - y.index);
}

/**
 * The currency marks a brochure prints beside a price, and the currencies each can stand for —
 * matched on NFKC-folded text (Arabic presentation forms -> letters; ﷼ folds to "ریال", Farsi yeh).
 * The specific ones come first: "ريال عماني" is Omani, "ريال سعودي" Saudi; a bare "ريال", ﷼ or
 * "riyal" is RIYAL — the riyal of the country the property is in (riyalOf).
 */
const RIYAL = 'RIYAL';
/** An Arabic abbreviation's letters stand alone: nothing of the Arabic block right before the first ("مدارس", "شارع"). */
const ABBR = '(?<![\\u0600-\\u06ff])';
/**
 * The word goes on: an Arabic letter, a vowel mark or a tatweel follows — not Arabic punctuation (، ؛ ؟ ٪ ۔),
 * which ends a word like a space does (final review I1: the whole Arabic block here lost "ر.س،" its mark).
 */
const WORD_GOES_ON = '[\\u0620-\\u065f\\u066e-\\u06d3\\u06d5-\\u06ff]';
/**
 * ر.س / ر.ع / ر.ق / د.ك / د.إ — the letters `a` and `b` standing on their own. Dotted ("ر.س", "ر. س") they are
 * the mark whatever follows: "ر.س،", "ر.سـ", even "ر.سشاملة" with the space lost. Undotted ("رس", "ر س") only
 * when the word ends there: "رسوم" (fees), "رسمي", "رعاية", "رقم" are words, not marks.
 */
const abbr = (a, b) => `${ABBR}${a}(?:\\.\\s?${b}\\.?|\\s?${b}(?:\\.|(?!${WORD_GOES_ON})))`;
const MARKS = [
  ['ر[يی]ال\\s*(?:عماني|عُماني)|omani\\s+(?:riyals?|rials?)', ['OMR']],
  ['ر[يی]ال\\s*قطري|qatari\\s+riyals?', ['QAR']],
  ['ر[يی]ال\\s*سعودي|saudi\\s+riyals?', ['SAR']],
  ['ر[يی]الا?ت?|riyals?|rials?', [RIYAL]],
  [abbr('ر', 'س'), ['SAR']],
  [abbr('ر', 'ع'), ['OMR']],
  ['\\bSAR\\b|\\bS\\.?R\\b\\.?|\u20c1', ['SAR']],
  [`\\bAED\\b|\\bDhs?\\b\\.?|dirhams?|درهم|${abbr('د', 'إ')}`, ['AED']],
  // Other dollars, named by their prefix: Australian, Canadian, Hong Kong, New Zealand, Singapore, Taiwan dollars,
  // the Brazilian real (R$), the Mexican peso (MX$). Before USD, which takes every other "$" — "US$", "$" alone,
  // and a "$" written straight after a word ("price$1,250,000", "from$…": final review M1).
  ['(?<![A-Za-z])(?:A|AU|C|CA|HK|NZ|S|SG|NT|R|MX)\\$', ['OTHER']],
  ['US\\$|\\bUSD\\b|\\$|dollars?|دولار', ['USD']],
  ['\\bEUR\\b|€|euros?|يورو', ['EUR']],
  ['\\bOMR\\b', ['OMR']],
  ['\\bGBP\\b|£|pounds?(?:\\s+sterling)?|sterling|إسترليني|استرليني', ['GBP']],
  ['جنيه', ['GBP', 'EGP']],
  [abbr('ر', 'ق'), ['QAR']],
  // Currencies the site does not print: never this price's, and never a bare figure either. ("XY$" here only
  // counts after a figure, "1,250,000 XY$": before one, USD above has already taken the "$".)
  // Bulgarian leva (лв) and Croatian kuna (kn, a word of its own): a euro-area property's old-currency price (final review M7).
  ['\\b(?:QAR|KWD|BHD|EGP|JOD|TRY|CHF|CAD|AUD|INR|PKR|CNY|JPY|RUB|BGN|HRK)\\b|(?<![A-Za-z])[A-Z]{1,3}\\$|\\bTL\\b|₺|دينار|لير[ةه]'
    + `|${abbr('د', 'ك')}|(?<![\\u0400-\\u04ff])лв(?![\\u0400-\\u04ff])|\\bkn\\b`, ['OTHER']],
];
const GAP = '[\\s:：\\-–—=]*';
const MARK_BEFORE = MARKS.map(([src, cs]) => [new RegExp(`(?:${src})${GAP}$`, 'i'), cs]);
const MARK_AFTER = MARKS.map(([src, cs]) => [new RegExp(`^(?:[.,٫]\\d{1,2})?${GAP}(?:\\/-)?${GAP}(?:${src})`, 'i'), cs]);
const marksIn = (slice, table) => {
  const folded = slice.normalize('NFKC');
  const hit = table.find(([re]) => re.test(folded));
  return hit ? hit[1] : [];
};

/** The countries where a bare riyal is not the Saudi one: their own currency is a riyal or rial too. */
const OWN_RIYALS = Object.freeze(['OMR', 'QAR', 'YER', 'IRR']);

/**
 * The currency a bare "ريال" / ﷼ / "riyal" stands for on the pages of a property whose own country prices
 * in `home` (model-prices.mjs countryCurrency): that country's riyal in Oman (OMR — worth about ten Saudi
 * riyals), Qatar (QAR, which the site does not print), Yemen and Iran; the Saudi riyal anywhere else,
 * and when the country is not known.
 */
export function riyalOf(home) {
  return OWN_RIYALS.includes(home) ? home : 'SAR';
}

/**
 * Is `amount` printed in `text` AS a price in `currency`? Some occurrence of it (priceAppearsIn's
 * figure rules) must carry a mark of that currency right beside it — its code, symbol or name — or,
 * when `bareCounts`, no currency mark at all. An occurrence marked with any other currency ("£1,250,000",
 * "$1,250,000", "1,250,000 AED") is that other currency's price, never this one's. The pipeline passes
 * `bareCounts: false` when a bare figure cannot be taken for `currency` — the property is not in the
 * country whose currency it is (pipeline.mjs printed()). `home` is the currency of the country the
 * property is in, printed by the site or not (model-prices.mjs countryCurrency): a bare "ريال" / ﷼ is
 * that country's riyal (riyalOf) — an Omani "190,000 ريال" is 190,000 OMR, never 190,000 SAR — and a
 * marked figure, so never a bare one.
 * @returns {boolean}
 */
export function printedInCurrency(text, amount, currency, { bareCounts = true, home = null } = {}) {
  if (!Number.isFinite(amount) || amount <= 0 || typeof currency !== 'string' || !currency) return false;
  const t = westernise(text || '');
  if (!t) return false;
  const riyal = riyalOf(home);
  for (const re of figurePatterns(amount, 'g')) {
    for (const m of t.matchAll(re)) {
      const before = marksIn(t.slice(Math.max(0, m.index - 24), m.index), MARK_BEFORE);
      const after = marksIn(t.slice(m.index + m[0].length, m.index + m[0].length + 32), MARK_AFTER);
      const marks = [...before, ...after].map((c) => (c === RIYAL ? riyal : c));
      if (marks.includes(currency) || (bareCounts && marks.length === 0)) return true;
    }
  }
  return false;
}
