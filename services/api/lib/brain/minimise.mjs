/**
 * Data minimisation before any provider call (brain/DESIGN-brain.md §11.2). Runs on the
 * history, the batch, the client record and email text. Names stay (a booking needs them).
 *
 *   1. Every decimal digit form (Arabic-Indic, Persian, fullwidth, Devanagari, mathematical, any
 *      `\p{Nd}`) becomes ASCII, and the Arabic decimal and thousands signs `.` and `,` (`asciiDigits`):
 *      the only change made to text left unmasked.
 *   2. The masks read a probe of the text (`probe`): every dash, hyphen or minus (`\p{Pd}`, U+2212,
 *      the soft hyphen, ...) reads as `-`, every space separator (`\p{Zs}`) as a space, the fullwidth
 *      and small forms of `+ ( ) . / _` as those, and zero-width, direction and combining marks
 *      (`\p{Cf}`, `\p{Mn}`, `\p{Me}`) are not there at all, so a phone written with U+2011 between
 *      its groups, or with a direction mark inside, is one run. A mask covers the original characters
 *      of its span (marks inside it included); text outside every mask keeps its own characters.
 *   3. Email addresses → `[email]`; a Saudi IBAN → `[iban]`: `SA` (any case) and 22 digits, with
 *      up to 3 spaces, dashes, dots, slashes or underscores before and between any of them
 *      ("SA 0000…", "sa00-0000-…", "SA00.0000.…").
 *   4. Runs of digit groups joined by spaces, `-`, `.`, `(` or `)` (never a comma, so "2,950,000"
 *      stays a price, and never into or out of a date, so "2026-11-29 10:30" and "29/11/2026 10:30"
 *      stay dates) are read as one number; when that number has a phone shape (+966 / 00966 / 966 /
 *      05 / 5 + 8 digits, a 10-digit local number, any `+`/`00` run of 9-15 digits) it becomes
 *      `[phone]`, and a 10-digit run starting 1 or 2 (a Saudi ID or Iqama) becomes `[id-number]`.
 *      Groups split by `/` or `_` join too, but only into a `[phone]` ("050/000/0000"), so
 *      "2026/2027 12" is never read as an ID.
 *   5. Any other run of 12 or more digits (joined the same way, `/` and `_` included) could be a
 *      bank account, an IBAN without its `SA` or a card number: `[account-number]`. The one shape
 *      left alone is a budget range: two amounts of 4-9 digits on one dash or slash, each written
 *      whole or in thousands ("2950000-3100000", "2.950.000 - 3.100.000", "2950000 / 3100000").
 *   Anything else is left exactly as written, so "3.5 مليون", "12,500 m²", "BONA-W012" and "2026"
 *   are untouched.
 */
import { toAsciiDigits } from '../inventory.mjs';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const IBAN_RE = /(?<![A-Za-z0-9])SA(?:[\s._/-]{0,3}\d){22}(?!\d)/gi;
/** What may sit between two digit groups of one number (in the probe): 1-3 of these. `/` and `_` only ever join into a phone. */
const GAP_RE = /^[\s\-.()/_]{1,3}$/;
const SOFT_GAP_RE = /[/_]/;
const MAX_DIGITS = 15;
/** A run of this many digits or more that is not a phone or an ID: an account or a card number. */
const ACCOUNT_DIGITS = 12;
/** A date (2026-11-29, 29-11-2026, 29.11.2026, 29/11/2026, 2026/11/29): its groups are never part of a phone or an ID. */
const DATE_RE = /(?<!\d)(?:(?:19|20)\d{2}([-./])(?:0?[1-9]|1[0-2])\1(?:0?[1-9]|[12]\d|3[01])|(?:0?[1-9]|[12]\d|3[01])([-./])(?:0?[1-9]|1[0-2])\2(?:19|20)\d{2})(?!\d)/g;

/* ---------------- digits and the probe ---------------- */
const ND_RE = /^\p{Nd}$/u;
const digitCache = new Map();
/** The value of a decimal digit: Unicode encodes every `Nd` set as 10 contiguous code points, 0 to 9. */
function digitValue(cp) {
  let v = digitCache.get(cp);
  if (v === undefined) {
    let first = cp;
    while (first > 0 && ND_RE.test(String.fromCodePoint(first - 1))) first -= 1;
    v = String((cp - first) % 10);
    digitCache.set(cp, v);
  }
  return v;
}
/** Every decimal digit as ASCII ("٠٥٠", "０５０", "𝟎𝟓𝟎" → "050"; "٫" and "٬" as `.` and `,`). */
const asciiDigits = (s) => toAsciiDigits(s).replace(/(?![0-9])\p{Nd}/gu, (d) => digitValue(d.codePointAt(0)));

/** The probe's reading of a character: one ASCII stand-in, '' (not there), or undefined (itself). */
const PROBE_CLASSES = [
  [/^[\p{Pd}\u00AD\u2212\u2796\u207B\u208B\u02D7\u2043]$/u, '-'],
  [/^\p{Zs}$/u, ' '],
  [/^[\p{Cf}\p{Mn}\p{Me}]$/u, ''],
  [/^[\uFF0B\uFE62\u207A\u208A\u2795]$/u, '+'],
  [/^[\uFF08\uFE59\u207D\u208D\uFD3E]$/u, '('],
  [/^[\uFF09\uFE5A\u207E\u208E\uFD3F]$/u, ')'],
  [/^[\u00B7\u2024\u2027\u2219\u22C5\u30FB\uFF0E\uFE52\u06D4\u3002\uFF61]$/u, '.'],
  [/^[\u2044\u2215\u29F8\uFF0F]$/u, '/'],
  [/^[\uFF3F\uFE4D\uFE4E\uFE4F]$/u, '_'],
];
/** Any character one of the classes reads (one test for the common case: a letter of a word). */
const PROBE_ANY = new RegExp(PROBE_CLASSES.map(([re]) => re.source.slice(1, -1)).join('|'), 'u');
const probeOf = (ch) => {
  if (!PROBE_ANY.test(ch)) return undefined;
  for (const [re, to] of PROBE_CLASSES) if (re.test(ch)) return to;
  return undefined;
};

/**
 * The text as the masks read it, with where each of its characters came from: `from[k]`/`to[k]` is the
 * span of `s` that probe character k stands for. Plain ASCII is copied as is.
 */
function probe(s) {
  let text = '';
  const from = [];
  const to = [];
  let at = 0;
  for (const ch of s) {
    const mapped = ch.charCodeAt(0) < 0x80 ? undefined : probeOf(ch);
    const out = mapped ?? ch;
    for (let k = 0; k < out.length; k += 1) { from.push(at); to.push(at + ch.length); }
    text += out;
    at += ch.length;
  }
  return { text, from, to };
}

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

/** One amount of a budget range: 4-9 digits, whole ("2950000") or in thousands ("2.950.000", "2 950 000"). */
function isAmount(groups, gaps) {
  if (!/^[1-9]\d{3,8}$/.test(groups.map((g) => g.digits).join(''))) return false;
  if (groups.length === 1) return true;
  return /^[1-9]\d{0,2}$/.test(groups[0].digits) && groups.slice(1).every((g) => g.digits.length === 3) && gaps.every((g) => /^[ .]$/.test(g));
}

/**
 * A budget range: the whole run is two amounts on ONE dash or slash ("2950000-3100000", "2.950.000 - 3.100.000",
 * "2950000 / 3100000"), never one account number. The index in the run where the second amount starts, else 0.
 * Card and account numbers in dashed groups ("1111-2222-3333-4444") have more than one dash: never a range.
 */
function rangeSplit(run, gaps) {
  const at = gaps.flatMap((g, k) => (/[-/]/.test(g) ? [k] : []));
  if (at.length !== 1 || !/^[\s/-]+$/.test(gaps[at[0]])) return 0;
  const k = at[0];
  return isAmount(run.slice(0, k + 1), gaps.slice(0, k)) && isAmount(run.slice(k + 1), gaps.slice(k + 1)) ? k + 1 : 0;
}

/** Where the phone, ID and account numbers of `s` (a probe text) are: [{ start, end, mask }], in order. */
function numberCuts(s) {
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
    if (!best && digits.length >= ACCOUNT_DIGITS) {
      // A range is left as written; its second amount is then read on its own (it may still be a phone).
      const second = rangeSplit(groups.slice(i, last + 1), gaps);
      if (second) { i += second; continue; }
      best = { j: last, mask: '[account-number]' };
    }
    if (!best) { i += 1; continue; }
    let start = groups[i].start;
    if (s[start - 1] === '(') start -= 1;
    if (s[start - 1] === '+') start -= 1;
    if (s[start - 1] === '(' && s[start] === '+') start -= 1;
    let end = groups[best.j].end;
    if (s[end] === ')' && s.slice(start, end).includes('(')) end += 1;
    cuts.push({ start, end, mask: best.mask });
    i = best.j + 1;
  }
  return cuts;
}

/** Every match of `re` in the probe: its span, then the span blanked so no later mask reads it again. */
function takeMatches(p, re, mask) {
  const found = [...p.text.matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length, mask }));
  for (const c of found) p.text = p.text.slice(0, c.start) + '#'.repeat(c.end - c.start) + p.text.slice(c.end);
  return found;
}

/**
 * @param {unknown} text
 * @returns {string} the text with phone, ID, IBAN, account and email shapes masked ('' for a non-string)
 */
export function minimise(text) {
  if (typeof text !== 'string') return '';
  const s = asciiDigits(text);
  const p = probe(s);
  const cuts = [...takeMatches(p, EMAIL_RE, '[email]'), ...takeMatches(p, IBAN_RE, '[iban]'), ...numberCuts(p.text)].sort((x, y) => x.start - y.start);
  // Each cut covers the original characters of its probe span (a mark inside it goes with it).
  let out = '';
  let at = 0;
  for (const c of cuts) {
    const start = p.from[c.start];
    out += s.slice(at, start) + c.mask;
    at = p.to[c.end - 1];
  }
  return out + s.slice(at);
}
