// TAQEEM cross-check: a price may only be published when the NUMBER is actually printed in
// the brochure (or typed by the owner). The model is not trusted to have read one — this
// module looks the figure up in the PDF's text layer and in the caption.
const ARABIC_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };

/** Arabic-Indic / Persian digits -> ASCII. */
export const westernise = (s) => String(s ?? '').replace(/[٠-٩۰-۹]/g, (d) => ARABIC_DIGITS[d] ?? d);

const SEP = '[\\s.,،\'’ ٫٬  ]*';

/** Does the exact digit run appear, allowing any thousands separators between digits? */
function digitsAppear(text, digits) {
  const body = digits.split('').join(SEP);
  return new RegExp(`(?<![\\d])${body}(?![\\d])`).test(text);
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
  if (digitsAppear(t, String(Math.round(amount)))) return true;
  // "4.5m" / "4.5 million" / "٤٫٥ مليون" / "990k" / "٩٩٠ ألف"
  for (const [div, words] of [[1e6, ['m', 'mn', 'million', 'مليون']], [1e3, ['k', 'thousand', 'ألف', 'الف']]]) {
    const v = amount / div;
    if (!(v >= 1 && v < 1000)) continue;
    const s = Number(v.toFixed(3)).toString().replace('.', '[.,٫]');
    for (const w of words) {
      if (new RegExp(`(?<!\\d)${s}\\s*${w}(?![a-z\\u0600-\\u06ff])`, 'i').test(t)) return true;
    }
  }
  return false;
}
