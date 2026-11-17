// Pages whose PRICES the text layer cannot be trusted for.
//
// A brochure exported from Illustrator often embeds its Arabic font with a private digit map:
// the page shows 270,425 but the text layer reads "DIB,FDG" (B=0 … K=9 on the Jeddah Heights
// brochure, 2026-11-17). The Arabic words around the number survive, so the PDF has a perfectly
// readable text layer and is never treated as image-only — the model was handed the scrambled
// digits, could not read a price, and the listing went out "price on request" although every
// unit's price was printed.
//
// The fix is to let the model LOOK at those pages: any page that talks about a price but offers
// no readable price-sized number (or offers a scrambled one) is rendered and handed over as a
// page image. A price read off a page image still has to pass the TAQEEM check in pipeline.mjs
// (`priceEvidence` + a second model confirming the number on that page), so this widens what the
// model can see, not what it may publish.
import { normaliseArabic } from './classify.mjs';
import { westernise } from './price.mjs';

/** Words that say "a price is on this page". Matched on NFKC-folded text (presentation forms -> letters). */
const PRICE_WORD_RE = new RegExp([
  'سعر', 'سعار', 'ريال', 'ر\\.\\s?س', 'ریال', // ﷼ folds to ریال (Farsi yeh) under NFKC
  '\\bprices?\\b', '\\bsar\\b', '\\baed\\b', '\\busd\\b', '\\beur\\b', '\\bgbp\\b', '€', '£',
].join('|'), 'i');

/** A number the size of a price: 10,000 or more, with or without thousands separators. */
const READABLE_PRICE_RE = /(?<![\d.,])(?:\d{1,3}(?:[,٬'’  ]\d{3})+|\d{5,})(?![\d])/;

/** The scrambled form: capital letters standing in for digits, grouped like a price ("DIB,FDG"). */
const SCRAMBLED_PRICE_RE = /(?<![A-Za-z])[A-Z]{1,3}[,٬][A-Z]{3}(?![A-Za-z])/;

/** Upper bound on extra page renders per brochure — each is one more image the model reads. */
export const MAX_PRICE_PAGES = 12;

/**
 * @param {string} text  the text layer of ONE page
 * @returns {boolean} true when the page mentions a price that the text layer cannot be read for
 */
export function pageNeedsPriceRender(text) {
  const raw = String(text ?? '');
  const folded = normaliseArabic(raw);
  if (!PRICE_WORD_RE.test(folded)) return false;
  if (SCRAMBLED_PRICE_RE.test(raw)) return true;
  return !READABLE_PRICE_RE.test(westernise(folded));
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
