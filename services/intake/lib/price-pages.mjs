// Pages whose PRICES the text layer cannot be trusted for.
//
// A brochure exported from Illustrator often embeds its Arabic font with a private digit map:
// the page shows 270,425 but the text layer reads "DIB,FDG" (B=0 … K=9 on the Jeddah Heights
// brochure, 2026-11-17). The Arabic words around the number survive, so the PDF has a perfectly
// readable text layer and is never treated as image-only — the model was handed the scrambled
// digits, could not read a price, and the listing went out "price on request" although every
// unit's price was printed.
//
// The fix is to let the model LOOK at those pages. A page is rendered when
//   - a line that talks about a price has no readable price-sized number near it (or the page
//     carries a scrambled one), or
//   - it mentions housing-subsidy (Sakani) beneficiaries: such a page prints two prices per unit,
//     and which one is which can only be settled by looking (pipeline.mjs accepts neither the
//     subsidised price nor a headline price that appears only on such pages from text alone).
// A price read off a page image still has to pass the TAQEEM check in pipeline.mjs (evidence +
// a second model confirming the number and its label on that page), so this widens what the
// model can see, not what it may publish. A needless render costs one page image; a missed one
// costs the price.
import { normaliseArabic } from './classify.mjs';
import { westernise } from './price.mjs';

/** Words that say "a price is on this line". Matched on NFKC-folded text (presentation forms -> letters). */
const PRICE_WORD_RE = new RegExp([
  'سعر', 'سعار', 'ريال', 'ر\\.\\s?س', 'ریال', // ﷼ folds to ریال (Farsi yeh) under NFKC
  'قيمة', // "قيمة الوحدة" — the unit's value, a common way to print a price
  '\\bprices?\\b', '\\bsar\\b', '\\bsr\\b', '\\baed\\b', '\\busd\\b', '\\beur\\b', '\\bgbp\\b', '€', '£',
].join('|'), 'i');

/** Housing-subsidy wording: "السعر لمستفيدي الدعم" / "غير مستفيدي الدعم" / "منصة سكني" / "Sakani". */
export const SUBSIDY_RE = /مستفيد|الدعم السكني|(?:منصة|برنامج|مستفيدي)\s+سكني|\bsakani\b|subsid/i;

/**
 * A number the size of a price: 10,000 or more, grouped in thousands, or 5–8 digits written
 * solid. A solid run of 9+ digits is a phone, CR or licence number (920032546, 05xxxxxxxx,
 * 70xxxxxxxx), not a price a brochure prints.
 */
const READABLE_PRICE_RE = /(?<![\d.,])(?:\d{1,3}(?:[,٬'’  ]\d{3})+|\d{5,8})(?![\d])/;

/** The scrambled form: capital letters standing in for digits, grouped like a price ("DIB,FDG"). */
const SCRAMBLED_PRICE_RE = /(?<![A-Za-z])[A-Z]{1,3}[,٬][A-Z]{3}(?![A-Za-z])/;

/** How far from a price word (in lines of the text layer) its number may sit: labels and values are often split. */
const WINDOW_BEFORE = 2;
const WINDOW_AFTER = 3;

/** Upper bound on extra page renders per brochure — each is one more image the model reads. */
export const MAX_PRICE_PAGES = 12;

/** Does this page's text mention subsidy beneficiaries? */
export function hasSubsidyWording(text) {
  return SUBSIDY_RE.test(normaliseArabic(text));
}

/**
 * @param {string} text  the text layer of ONE page
 * @returns {boolean} true when the page should be rendered for the model to read its prices
 */
export function pageNeedsPriceRender(text) {
  const raw = String(text ?? '');
  const folded = normaliseArabic(raw);
  if (SUBSIDY_RE.test(folded)) return true;
  const lines = westernise(folded).split('\n');
  const priceLines = lines.map((l, i) => (PRICE_WORD_RE.test(l) ? i : -1)).filter((i) => i >= 0);
  if (!priceLines.length) return false;
  if (SCRAMBLED_PRICE_RE.test(raw)) return true;
  // EVERY line that talks about a price needs a readable figure close by. A phone number, a
  // CR number or an area elsewhere on the page does not make its prices readable.
  return priceLines.some((i) => {
    const near = lines.slice(Math.max(0, i - WINDOW_BEFORE), i + WINDOW_AFTER + 1).join('\n');
    return !READABLE_PRICE_RE.test(near);
  });
}

/**
 * @param {string[]} pageText  the text layer, one entry per page (extract_pdf.py `pageText`)
 * @param {{maxPages?:number}} [opts]
 * @returns {number[]} 1-based page numbers to render, in order, at most `maxPages`
 */
export function pricePagesToRender(pageText, { maxPages = MAX_PRICE_PAGES } = {}) {
  const out = [];
  for (const [i, text] of (Array.isArray(pageText) ? pageText : []).entries()) {
    if (out.length >= maxPages) break;
    if (pageNeedsPriceRender(text)) out.push(i + 1);
  }
  return out;
}
