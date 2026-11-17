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
 * The currency marks a brochure prints beside a price, and the currencies each can stand for —
 * matched on NFKC-folded text (Arabic presentation forms -> letters; ﷼ folds to "ریال", Farsi yeh).
 * The specific ones come first: "ريال عماني" is Omani, a bare "ريال" or ﷼ any riyal.
 */
const MARKS = [
  ['ر[يی]ال\\s*(?:عماني|عُماني)', ['OMR']],
  ['ر[يی]ال\\s*قطري', ['QAR']],
  ['ر[يی]ال\\s*سعودي', ['SAR']],
  ['ر[يی]الا?ت?|riyals?|rials?', ['SAR', 'OMR', 'QAR']],
  // ر.س / ر.ع — not the end of a word ("مدارس", "شارع").
  ['(?<![\\u0600-\\u06ff])ر\\.?\\s?س\\.?', ['SAR']],
  ['(?<![\\u0600-\\u06ff])ر\\.?\\s?ع\\.?', ['OMR']],
  ['\\bSAR\\b|\\bS\\.?R\\b\\.?|\u20c1', ['SAR']],
  ['\\bAED\\b|\\bDhs?\\b\\.?|dirhams?|درهم|د\\.?\\s?إ', ['AED']],
  ['US\\$|\\bUSD\\b|\\$|dollars?|دولار', ['USD']],
  ['\\bEUR\\b|€|euros?|يورو', ['EUR']],
  ['\\bOMR\\b', ['OMR']],
  ['\\bGBP\\b|£|pounds?(?:\\s+sterling)?|sterling|إسترليني|استرليني', ['GBP']],
  ['جنيه', ['GBP', 'EGP']],
  ['\\b(?:QAR|KWD|BHD|EGP|JOD|TRY|CHF|CAD|AUD|INR|PKR|CNY|JPY|RUB)\\b', ['OTHER']],
];
const GAP = '[\\s:：\\-–—=]*';
const MARK_BEFORE = MARKS.map(([src, cs]) => [new RegExp(`(?:${src})${GAP}$`, 'i'), cs]);
const MARK_AFTER = MARKS.map(([src, cs]) => [new RegExp(`^(?:[.,٫]\\d{1,2})?${GAP}(?:\\/-)?${GAP}(?:${src})`, 'i'), cs]);
const marksIn = (slice, table) => {
  const folded = slice.normalize('NFKC');
  const hit = table.find(([re]) => re.test(folded));
  return hit ? hit[1] : [];
};

/**
 * Is `amount` printed in `text` AS a price in `currency`? Some occurrence of it (priceAppearsIn's
 * figure rules) must carry a mark of that currency right beside it — its code, symbol or name — or,
 * when `bareCounts`, no currency mark at all. An occurrence marked with any other currency ("£1,250,000",
 * "$1,250,000", "1,250,000 AED") is that other currency's price, never this one's. The pipeline passes
 * `bareCounts: false` when a bare figure cannot be taken for `currency` — the property is not in the
 * country whose currency it is (pipeline.mjs printed()).
 * @returns {boolean}
 */
export function printedInCurrency(text, amount, currency, { bareCounts = true } = {}) {
  if (!Number.isFinite(amount) || amount <= 0 || typeof currency !== 'string' || !currency) return false;
  const t = westernise(text || '');
  if (!t) return false;
  for (const re of figurePatterns(amount, 'g')) {
    for (const m of t.matchAll(re)) {
      const before = marksIn(t.slice(Math.max(0, m.index - 24), m.index), MARK_BEFORE);
      const after = marksIn(t.slice(m.index + m[0].length, m.index + m[0].length + 32), MARK_AFTER);
      const marks = [...before, ...after];
      if (marks.includes(currency) || (bareCounts && marks.length === 0)) return true;
    }
  }
  return false;
}
