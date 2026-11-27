/**
 * Data minimisation before any provider call (brain/DESIGN-brain.md §11.2). Runs on the
 * history, the batch, the client record and email text. Names stay (a booking needs them).
 *
 *   1. Arabic-Indic digits become ASCII (`toAsciiDigits`).
 *   2. Email addresses → `[email]`; a Saudi IBAN → `[iban]`: `SA` (any case) and 22 digits, with
 *      up to 3 spaces, dashes, dots, slashes or underscores before and between any of them
 *      ("SA 0000…", "sa00-0000-…", "SA00.0000.…").
 *   3. Runs of digit groups joined by spaces, NBSP, `-`, `.`, `(` or `)` (never a comma, so
 *      "2,950,000" stays a price, and never into or out of a date, so "2026-11-29 10:30" and
 *      "29/11/2026 10:30" stay dates) are read as one number; when that number has a phone shape
 *      (+966 / 00966 / 966 / 05 / 5 + 8 digits, a 10-digit local number, any `+`/`00` run of 9-15
 *      digits) it becomes `[phone]`, and a 10-digit run starting 1 or 2 (a Saudi ID or Iqama)
 *      becomes `[id-number]`. Groups split by `/` or `_` join too, but only into a `[phone]`
 *      ("050/000/0000"), so "2026/2027 12" is never read as an ID.
 *   4. Any other run of 12 or more digits (joined the same way, `/` and `_` included) could be a
 *      bank account, an IBAN without its `SA` or a card number: `[account-number]`. The one shape
 *      left alone is a range of two amounts on a dash ("2950000-3100000").
 *   Anything else is left exactly as written, so "3.5 مليون", "12,500 m²", "BONA-W012" and "2026"
 *   are untouched.
 */
import { toAsciiDigits } from '../inventory.mjs';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const IBAN_RE = /(?<![A-Za-z0-9])SA(?:[\s  ._/-]{0,3}\d){22}(?!\d)/gi;
/** What may sit between two digit groups of one number: 1-3 of these. `/` and `_` only ever join into a phone. */
const GAP_RE = /^[\s  \-.()/_]{1,3}$/;
const SOFT_GAP_RE = /[/_]/;
const MAX_DIGITS = 15;
/** A run of this many digits or more that is not a phone or an ID: an account or a card number. */
const ACCOUNT_DIGITS = 12;
/** A date (2026-11-29, 29-11-2026, 29.11.2026, 29/11/2026, 2026/11/29): its groups are never part of a phone or an ID. */
const DATE_RE = /(?<!\d)(?:(?:19|20)\d{2}([-./])(?:0?[1-9]|1[0-2])\1(?:0?[1-9]|[12]\d|3[01])|(?:0?[1-9]|[12]\d|3[01])([-./])(?:0?[1-9]|1[0-2])\2(?:19|20)\d{2})(?!\d)/g;

/** The mask for a run of digits, or null when it is not a phone or an ID. */
function maskFor(digits, plus) {
  if (plus && /^\d{9,15}$/.test(digits)) return '[phone]';
  if (/^00\d{9,13}$/.test(digits)) return '[phone]';
  if (/^966\d{8,9}$/.test(digits)) return '[phone]';
  if (/^0\d{9}$/.test(digits)) return '[phone]';
  if (/^5\d{8}$/.test(digits)) return '[phone]';
  if (/^[12]\d{9}$/.test(digits)) return '[id-number]';
  return null;
}

/** Two amounts on a dash ("2950000-3100000", "2950000 - 3100000"): a budget range, not one account number. */
const amountRange = (run, gaps) => run.length === 2 && gaps[0].includes('-') && run.every((g) => /^[1-9]\d{3,8}$/.test(g.digits));

function maskNumbers(s) {
  const dates = [...s.matchAll(DATE_RE)].map((m) => [m.index, m.index + m[0].length]);
  const inDate = (at) => dates.some(([a, b]) => at >= a && at < b);
  const groups = [...s.matchAll(/\d+/g)].map((m) => ({ start: m.index, end: m.index + m[0].length, digits: m[0], date: inDate(m.index) }));
  const cuts = [];
  for (let i = 0; i < groups.length;) {
    // A group glued to a comma number ("2,950,000") is part of a price, never a phone; only a
    // group that can be one counts: exactly 3 digits after a comma (1-3 before one, below).
    const before = s[groups[i].start - 1];
    if (groups[i].date || (before === ',' && /\d/.test(s[groups[i].start - 2] ?? '') && groups[i].digits.length === 3)) { i += 1; continue; }
    const plus = before === '+' || (before === '(' && s[groups[i].start - 2] === '+');
    let digits = '';
    let soft = false;
    let best = null;
    const gaps = [];
    let last = i;
    for (let j = i; j < groups.length; j += 1) {
      if (j > i) {
        const gap = s.slice(groups[j - 1].end, groups[j].start);
        if (groups[j].date || !GAP_RE.test(gap)) break;
        gaps.push(gap);
        if (SOFT_GAP_RE.test(gap)) soft = true;
      }
      digits += groups[j].digits;
      last = j;
      // Too long for a phone: with one found, the run ends here (the rest is read on its own); without, it goes on for the account rule.
      if (digits.length > MAX_DIGITS + 2) { if (best) break; continue; }
      const after = s[groups[j].end];
      const glued = !plus && !digits.startsWith('00') && groups[j].digits.length <= 3 && after === ',' && /\d/.test(s[groups[j].end + 1] ?? '');
      const mask = glued ? null : maskFor(digits, plus);
      if (mask && (!soft || mask === '[phone]')) best = { j, mask };
    }
    if (!best && digits.length >= ACCOUNT_DIGITS && !amountRange(groups.slice(i, last + 1), gaps)) best = { j: last, mask: '[account-number]' };
    if (!best) { i += 1; continue; }
    let start = groups[i].start;
    if (s[start - 1] === '(' ) start -= 1;
    if (s[start - 1] === '+') start -= 1;
    if (s[start - 1] === '(' && s[start] === '+') start -= 1;
    let end = groups[best.j].end;
    if (s[end] === ')' && s.slice(start, end).includes('(')) end += 1;
    cuts.push({ start, end, mask: best.mask });
    i = best.j + 1;
  }
  let out = '';
  let at = 0;
  for (const c of cuts) {
    out += s.slice(at, c.start) + c.mask;
    at = c.end;
  }
  return out + s.slice(at);
}

/**
 * @param {unknown} text
 * @returns {string} the text with phone, ID, IBAN, account and email shapes masked ('' for a non-string)
 */
export function minimise(text) {
  if (typeof text !== 'string') return '';
  const s = toAsciiDigits(text).replace(EMAIL_RE, '[email]').replace(IBAN_RE, '[iban]');
  return maskNumbers(s);
}
