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
 *   4. Runs of digit groups joined by 1-3 spaces, `-`, `.`, `(` or `)` (never a comma, so "2,950,000"
 *      stays a price, and never into or out of a date, so "2026-11-29 10:30" and "29/11/2026 10:30"
 *      stay dates) are read as one number; when that number has a phone shape (+966 / 00966 / 966 /
 *      05 / 5 + 8 digits, a 10-digit local number, any `+`/`00` run of 9-15 digits) it becomes
 *      `[phone]`, and a 10-digit run starting 1 or 2 (a Saudi ID or Iqama) becomes `[id-number]`.
 *      Groups split by `/` or `_`, by a `+`, or by any run of up to 6 of these separators (format
 *      marks are not there at all, step 2) join too, but only into a `[phone]` ("050/000/0000",
 *      "(050) - 000 - 0000", "+ 44 (113) - 000 - 0000"), so "2026/2027 12" is never read as an ID
 *      and a wide run never makes an ID, an account number or a range. A `+` counts for the number
 *      when it sits in the separator run just before its first group ("+ (44) ...").
 *   5. Any other run of 12 or more digits (joined the same way, `/` and `_` included) could be a
 *      bank account, an IBAN without its `SA` or a card number: `[account-number]`. The one shape
 *      left alone is a budget range: two amounts of 4-9 digits on one dash or slash, each written
 *      whole or in thousands ("2950000-3100000", "2.950.000 - 3.100.000", "2950000 / 3100000").
 *   Anything else is left exactly as written, so "3.5 مليون", "12,500 m²", "BONA-W012" and "2026"
 *   are untouched.
 */
import { toAsciiDigits } from '../inventory.mjs';

// The part before "@" is at most 64 characters (RFC 5321): a long run of letters with no "@" is read in linear time (Claude r13 F5).
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const IBAN_RE = /(?<![A-Za-z0-9])SA(?:[\s._/-]{0,3}\d){22}(?!\d)/gi;
/** What may sit between two digit groups of one number (in the probe): 1-3 of these. `/` and `_` only ever join into a phone. */
const GAP_RE = /^[\s\-.()/_]{1,3}$/;
const SOFT_GAP_RE = /[/_]/;
/** A gap only a phone may cross: any run of up to 6 separators, `+` included ("(050) - 000 - 0000"). */
const PHONE_GAP_RE = /^[\s\-.()/_+]{1,6}$/;
const PHONE_SEP_RE = /^[\s\-.()/_+]$/;
const PHONE_GAP_MAX = 6;
const MAX_DIGITS = 15;
/** A run of this many digits or more that is not a phone or an ID: an account or a card number. */
const ACCOUNT_DIGITS = 12;
/** A phone whose first digits say so: 0 then 1-9 (10 digits), 00 then a country code, or 966. Never "000" (an amount's tail). */
/** Text right before a WhatsApp link's number: wa.me/, api.whatsapp.com/send?phone=, whatsapp://send?phone=. */
const WA_LINK_BEFORE_RE = /(?:wa\.me\/|[?&]phone=)$/i;
const CLEAR_PHONE_RE = /^(?:0[1-9]\d{8}|00[1-9]\d{8,12}|966\d{8,9})$/;
/** A phone that is already whole: a Saudi number (0 + 9, 966 + 9, 00966 + 9) or a 00 international one (Claude r15). */
const COMPLETE_PHONE_RE = /^(?:0[1-9]\d{8}|(?:00)?966\d{9}|00(?!966)[1-9]\d{8,12})$/;
/** Between two of a client's messages (minimiseParts): a paragraph separator, so a message boundary is told from a line break inside one. */
const PART_SEP = '\u2029';
/** A date (2026-11-29, 29-11-2026, 29.11.2026, 29/11/2026, 2026/11/29): its groups are never part of a phone or an ID. */
const DATE_RE = /(?<!\d)(?:(?:19|20|13|14)\d{2}([-./])(?:0?[1-9]|1[0-2])\1(?:0?[1-9]|[12]\d|3[01])|(?:0?[1-9]|[12]\d|3[01])([-./])(?:0?[1-9]|1[0-2])\2(?:19|20|13|14)\d{2})(?!\d)/g;

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

const IGNORABLE_RE = /^[\p{Cf}\p{Default_Ignorable_Code_Point}]$/u;
const MARK_RE = /^\p{M}$/u;
const LETTER_RE = /^\p{L}$/u;
/**
 * The text as a reader sees it, for the reply guard (reply-guard.mjs): every digit ASCII (`asciiDigits`) and every
 * other character as the probe reads it (a dash `-`, a space separator a space, ...), with two differences: a
 * combining mark on a letter stays, so "ريالاً" is still a currency word (on anything else, a digit or a space, it
 * goes); and every format or default-ignorable character (a direction or zero-width mark, a word joiner, a BOM, a
 * bidi isolate, the soft hyphen, a variation selector) goes, wherever it is.
 */
export function readable(text) {
  let out = '';
  let onLetter = false;
  for (const ch of asciiDigits(String(text ?? ''))) {
    if (ch.charCodeAt(0) < 0x80) { out += ch; onLetter = /[A-Za-z]/.test(ch); continue; } // plain ASCII is itself
    if (IGNORABLE_RE.test(ch)) continue;
    if (MARK_RE.test(ch)) { if (onLetter) out += ch; continue; }
    const mapped = probeOf(ch);
    out += mapped ?? ch;
    onLetter = mapped === undefined && LETTER_RE.test(ch);
  }
  return out;
}

/** The mask for a run of digits, or null when it is not a phone or an ID. */
function maskFor(digits, plus) {
  if (plus && /^\d{9,15}$/.test(digits)) return '[phone]';
  if (/^00\d{9,13}$/.test(digits)) return '[phone]';
  if (/^966\d{8,9}$/.test(digits)) return '[phone]';
  if (/^0[1-9]\d{8}$/.test(digits)) return '[phone]';
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

/** The last group of an amount written in thousands groups (2 or 3 groups: "500.000", "1 200 000") that starts at run[k], else -1. */
function thousandsEnd(run, gaps, k) {
  let end = k;
  while (end + 1 < run.length && /^[ .]$/.test(gaps[end]) && run[end + 1].digits.length === 3) end += 1;
  return end > k && isAmount(run.slice(k, end + 1), gaps.slice(k, end)) ? end : -1;
}

/**
 * Two amounts written in thousands groups on one dash, slash or `+` at the start of a run ("500.000 - 600.000",
 * "500 000  -  750 000", "(500 000) - (600 000)", "500 000 + 600 000"): [the index of the second amount's first
 * group, of its last], else null. Whole amounts ("500000000 - 500000001") are never one: they may be two phones.
 */
function thousandsRange(run, gaps) {
  const aEnd = thousandsEnd(run, gaps, 0);
  if (aEnd < 0 || aEnd + 1 >= run.length || !/^[\s()/+-]+$/.test(gaps[aEnd]) || !/[-/+]/.test(gaps[aEnd])) return null;
  const bEnd = thousandsEnd(run, gaps, aEnd + 1);
  return bEnd < 0 ? null : [aEnd + 1, bEnd];
}

/**
 * Whether the groups from `j` on, within one line, start a phone or ID of their own (maskFor): a line break before
 * such a group starts the next number (Claude r13 F1).
 */
function lineStartsNumber(s, groups, j, plus = false) {
  let d = '';
  for (let m = j; m < groups.length; m += 1) {
    if (m > j) {
      const gap = s.slice(groups[m - 1].end, groups[m].start);
      if (groups[m].date || !PHONE_GAP_RE.test(gap) || /[\r\n\u2028\u2029]/.test(gap)) break;
    }
    d += groups[m].digits;
    if (d.length > MAX_DIGITS) break;
    if (maskFor(d, plus)) return true;
  }
  return false;
}

/**
 * Whether the groups from `j` on, within one line, complete `digits` (a phone already found before a line break)
 * into a longer phone with a clear prefix: "+966 50 000 00" then "00" is one Saudi number (Codex r9).
 */
function lineCompletes(s, groups, j, digits) {
  let d = digits;
  for (let m = j; m < groups.length; m += 1) {
    if (m > j) {
      const gap = s.slice(groups[m - 1].end, groups[m].start);
      if (groups[m].date || !PHONE_GAP_RE.test(gap) || /[\r\n\u2028\u2029]/.test(gap)) break;
    }
    d += groups[m].digits;
    if (d.length > MAX_DIGITS) break;
    if (CLEAR_PHONE_RE.test(d)) return true;
  }
  return false;
}

/** Whether the groups from `j` on start an amount written in thousands groups ("600.000", "1 200 000"). */
function startsThousands(s, groups, j) {
  const run = [groups[j]];
  const gs = [];
  for (let m = j + 1; m < groups.length && run.length < 4; m += 1) {
    const gap = s.slice(groups[m - 1].end, groups[m].start);
    if (!/^[ .]$/.test(gap) || groups[m].digits.length !== 3) break;
    run.push(groups[m]);
    gs.push(gap);
  }
  return run.length >= 2 && thousandsEnd(run, gs, 0) >= 1;
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
    // A `+` in the separator run just before the group ("+966", "(+966)", "+ (44)"), never one before an earlier number's end.
    const floor = Math.max(i > 0 ? groups[i - 1].end : 0, cuts.length ? cuts.at(-1).end : 0, groups[i].start - PHONE_GAP_MAX);
    let plusAt = -1;
    for (let k = groups[i].start - 1; k >= floor && PHONE_SEP_RE.test(s[k]); k -= 1) if (s[k] === '+') plusAt = k;
    // A WhatsApp link's number is international without its "+" ("wa.me/12025550123", "...send?phone=447700900123"): read as one after a "+" (Codex r20).
    const plus = plusAt >= 0 || WA_LINK_BEFORE_RE.test(s.slice(Math.max(0, groups[i].start - 40), groups[i].start));
    // The 3-digit tail of an amount no mask took ("2.950.000", "500 000") never starts a run across a wide gap:
    // "2.950.000  -  3.100.000" is two amounts, never "000" plus "3100000".
    const prevEnd = i > 0 ? groups[i - 1].end : -1;
    const tail = i > 0 && groups[i].digits.length === 3 && groups[i].start === prevEnd + 1 && (before === ' ' || before === '.')
      && !(cuts.length && cuts.at(-1).end >= prevEnd);
    let digits = '';
    let soft = false;
    let best = null;
    const gaps = [];
    // Past a gap only a phone may cross (`wide`), the run is read for a phone only: the account rule reads it up to `acctLast`.
    let wide = false;
    let acctLast = i;
    let acctDigits = 0;
    for (let j = i; j < groups.length; j += 1) {
      if (j > i) {
        const gap = s.slice(groups[j - 1].end, groups[j].start);
        if (groups[j].date || !PHONE_GAP_RE.test(gap)) break;
        // A line break starts the next number when a number ended before it ("+966 50 000 0000\n+44 7700 900000",
        // Codex r7) or the next line starts its own ("ميزانيتي 500.000\n055 123 4567"); otherwise it is a number a
        // line break split, as a plain-text email wraps one ("055 123\n4567", Claude r13 F1).
        // ...and a phone found before the break goes on when the next line completes it into a longer clear one
        // ("+966 50 000 00\n00", Codex r9).
        if (/[\r\n\u2028\u2029]/.test(gap)) {
          // A number that is already whole never takes the next line (COMPLETE_PHONE_RE: "00966 55 123 4567\n3
          // bedrooms" keeps its count, Claude r15 F1).
          // A `+` number of another country goes on while it is still short of a whole one (under 11 digits: an
          // international mobile has 11-13), "+44 7700 900\n001" (Codex r10); "+44 7700 900123\n3 bedrooms" keeps its count.
          const goesOn = best && !COMPLETE_PHONE_RE.test(digits) && (lineCompletes(s, groups, j, digits)
            || (plus && digits.length < 11 && digits.length + groups[j].digits.length <= MAX_DIGITS));
          // Two of a client's messages that are each an amount in thousands groups stay two amounts ("ميزانيتي
          // 500.000", our question, "600.000", Claude r15 F2); a line break inside one message joins as before.
          // A whole clear phone the two make together wins ("966.551" then "234.567", Codex r13).
          const apart = gap.includes(PART_SEP) && !plus && thousandsEnd(groups.slice(i, j), gaps, 0) === j - 1 - i && startsThousands(s, groups, j)
            && !lineCompletes(s, groups, j, digits);
          if (lineStartsNumber(s, groups, j, gap.includes('+')) || (best && !goesOn) || apart) break;
        }
        if (!GAP_RE.test(gap)) { if (tail) break; wide = true; }
        gaps.push(gap);
        if (wide || SOFT_GAP_RE.test(gap)) soft = true;
      }
      digits += groups[j].digits;
      if (!wide) { acctLast = j; acctDigits = digits.length; }
      // Too long for a phone: with one found (or past a wide gap), the run ends here (the rest is read on its own); without, it goes on for the account rule.
      if (digits.length > MAX_DIGITS + 2) { if (best || wide) break; continue; }
      const after = s[groups[j].end];
      const glued = !plus && !digits.startsWith('00') && groups[j].digits.length <= 3 && after === ',' && /\d/.test(s[groups[j].end + 1] ?? '');
      const mask = glued ? null : maskFor(digits, plus);
      if (mask && (!soft || mask === '[phone]')) best = { j, mask };
    }
    if (best && !plus) {
      // A phone or ID shape read from the first amount of a thousands range into the second is a budget, never a phone
      // ("500.000 - 600.000" is 500000600 then ".000"; "20.000 - 30.000" is 2000030000): left as written, and the text
      // after it read on its own (the second amount too when it is a phone shape itself, "500 000 000"). A run that is a
      // phone from end to end ("966 551 - 234 567", "5.000 - 10.000") stays one, and so does one after a `+`.
      const at = best.j - i;
      const range = thousandsRange(groups.slice(i, i + gaps.length + 1), gaps);
      if (range && at >= range[0] && at <= range[1] && !(at === range[1] && best.mask === '[phone]')) {
        // The second amount is read from its own start: it may be the start of a longer number ("20.000 - 55 123
        // 4567"), never skipped past (Claude r12 F1).
        i += range[0];
        continue;
      }
    }
    if (!best && acctDigits >= ACCOUNT_DIGITS) {
      // A range is left as written; its second amount is then read on its own (it may still be a phone).
      const second = rangeSplit(groups.slice(i, acctLast + 1), gaps.slice(0, acctLast - i));
      if (second) { i += second; continue; }
      best = { j: acctLast, mask: '[account-number]' };
    }
    if (!best) { i += 1; continue; }
    {
      // A number that starts inside this cut and runs past its end is one the cut would split: "500.000 055 123 4567"
      // is 500000055 then "123 4567", "+966 50 000 0000 +44 7700 900000" took "44". From a group inside the cut, read
      // on over the groups joined to it (as a phone is, never across a line break or a date): a phone with a clear
      // prefix (CLEAR_PHONE_RE), or, after a `+`, after an amount the cut took whole (groups i..k-1 are one budget) or
      // after a complete number (groups i..k-1 are a phone or ID themselves), any phone or ID shape. The cut goes on to that number's end; it only grows, so it never unmasks anything
      // (Claude r12 F2, Codex r7). "551 234 567 - 1 000" is a phone and an amount: the amount stays.
      // Read again from every group the cut took on, so a number that starts there is not split either: a group past
      // the main cut (k > own) was taken because a number runs through it, so a number read from it carries the cut
      // on too, whatever its shape (three numbers on one line, Claude r14).
      const own = best.j;
      let far = best.j;
      for (let k = i + 1; k <= far; k += 1) {
        const lead = s.slice(groups[k - 1].end, groups[k].start);
        // An amount has at most 9 digits and a phone 15, so only that many groups are ever looked at: linear time
        // on a long run of short groups (Claude r13 F2). A complete number before group k counts too: a `+` phone's
        // longest match may take the first group of the next number (Codex r8).
        const before = k - i <= MAX_DIGITS ? groups.slice(i, k) : null;
        const weak = lead.includes('+') || k > own || (before !== null && ((k - i <= 9 && isAmount(before, gaps.slice(0, k - 1 - i)))
          || maskFor(before.map((g) => g.digits).join(''), plus) !== null));
        let d = '';
        for (let m = k; m < groups.length; m += 1) {
          if (m > k) {
            const gap = s.slice(groups[m - 1].end, groups[m].start);
            if (groups[m].date || !PHONE_GAP_RE.test(gap) || /[\r\n\u2028\u2029]/.test(gap)) break;
          }
          d += groups[m].digits;
          if (d.length > MAX_DIGITS) break;
          if (m > far && (CLEAR_PHONE_RE.test(d) || (weak && maskFor(d, lead.includes('+'))))) far = m;
        }
      }
      if (far > best.j) best = { j: far, mask: best.mask === '[account-number]' ? best.mask : '[phone]' };
    }
    let start = groups[i].start;
    if (plusAt >= 0) start = plusAt;
    else if (s[start - 1] === '(') start -= 1;
    if (s[start - 1] === '(' && s[start] === '+') start -= 1;
    let end = groups[best.j].end;
    if (s[end] === ')' && s.slice(start, end).includes('(')) end += 1;
    cuts.push({ start, end, mask: best.mask });
    i = best.j + 1;
  }
  return residual(s, groups, cuts);
}

/**
 * Groups joined to `groups[k]` from it on, as a phone joins them, within one line, never across a date or into a
 * group a cut covers (`cov`): their indexes.
 */
function joinedRun(s, groups, k, cov) {
  const run = [k];
  for (let m = k + 1; m < groups.length; m += 1) {
    const gap = s.slice(groups[m - 1].end, groups[m].start);
    if (cov[m] || groups[m].date || !PHONE_GAP_RE.test(gap) || /[\r\n\u2028\u2029]/.test(gap)) break;
    run.push(m);
  }
  return run;
}

/**
 * The net under the cuts (Codex r10): what a number split elsewhere (across messages, a clip, a cut that took only
 * part of it) leaves in clear is masked too:
 *   - R1: digits no cut took, joined as a phone is, 7 or more and starting with 0 (no amount starts with 0);
 *   - R2: what can be a phone's tail right after a phone, ID or account mask: 4-8 digits that are no amount (one in
 *     thousands groups, one bare group led by 1-9) and do not start with one (a range): "[phone] 234 5678" goes;
 *     "551 234 567 - 1 000", "0551234567 - 500.000 - 600.000", "- 1500000 riyals", "- 1200 sqm" keep theirs (Claude r16).
 * It only adds masks, in one pass over the sorted cuts (linear time).
 */
function residual(s, groups, cuts) {
  const n = groups.length;
  const cov = new Array(n).fill(false);
  for (let k = 0, ci = 0; k < n; k += 1) {
    while (ci < cuts.length && cuts[ci].end <= groups[k].start) ci += 1;
    cov[k] = ci < cuts.length && cuts[ci].start < groups[k].end;
  }
  const isThousands = (rg, rgaps) => rg.length >= 2 && isAmount(rg, rgaps);
  // R2: the digits right after a phone, ID or account mask.
  let k0 = 0;
  for (const c of cuts) {
    while (k0 < n && groups[k0].start < c.end) k0 += 1;
    let k = k0;
    while (k < n && groups[k].date) k += 1;
    if (k >= n || cov[k]) continue;
    const gap = s.slice(c.end, groups[k].start);
    if (!PHONE_GAP_RE.test(gap) || /[\r\n\u2028\u2029]/.test(gap)) continue;
    const run = joinedRun(s, groups, k, cov);
    const rg = run.map((m) => groups[m]);
    const rgaps = run.slice(1).map((m) => s.slice(groups[m - 1].end, groups[m].start));
    const digits = rg.map((g) => g.digits).join('');
    const amountish = isThousands(rg, rgaps) || (run.length === 1 && /^[1-9]/.test(digits)) || thousandsEnd(rg, rgaps, 0) >= 0;
    if (digits.length >= 4 && digits.length <= 8 && !amountish) {
      c.end = groups[run.at(-1)].end;
      for (const m of run) cov[m] = true;
    }
  }
  // R1: a run no cut took, 7+ digits, starting with 0.
  const out = cuts.slice();
  for (let k = 0; k < n;) {
    if (groups[k].date || cov[k]) { k += 1; continue; }
    const run = joinedRun(s, groups, k, cov);
    const digits = run.map((m) => groups[m].digits).join('');
    if (digits.length >= 7 && digits.startsWith('0')) out.push({ start: groups[run[0]].start, end: groups[run.at(-1)].end, mask: '[phone]' });
    k = run.at(-1) + 1;
  }
  return out.sort((x, y) => x.start - y.start);
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
  return minimiseParts([text])[0];
}

/**
 * Several texts of one writer, in order (a client's messages), masked as ONE text with `sep` (a paragraph separator,
 * PART_SEP) between them: a number
 * split across two of them ("my number is 050", then "000 0000") is masked in both pieces, never left whole across
 * the two (Codex r9). Each part comes back as minimise() would give it, plus the masks of such a number. A non-string
 * part is ''.
 * @param {unknown[]} parts
 * @param {string} [sep]
 * @returns {string[]}
 */
export function minimiseParts(parts, sep = PART_SEP) {
  const list = (Array.isArray(parts) ? parts : []).map((x) => (typeof x === 'string' ? asciiDigits(x) : ''));
  const s = list.join(sep);
  const p = probe(s);
  const cuts = [...takeMatches(p, EMAIL_RE, '[email]'), ...takeMatches(p, IBAN_RE, '[iban]'), ...numberCuts(p.text)].sort((x, y) => x.start - y.start);
  // Each cut covers the original characters of its probe span (a mark inside it goes with it); a cut across a
  // boundary masks its piece in each part.
  const spans = cuts.map((c) => ({ start: p.from[c.start], end: p.to[c.end - 1], mask: c.mask }));
  const out = [];
  let lo = 0;
  for (const part of list) {
    const hi = lo + part.length;
    let o = '';
    let at = lo;
    for (const c of spans) {
      if (c.end <= lo || c.start >= hi) continue;
      const a = Math.max(c.start, lo);
      if (a < at) continue;
      o += s.slice(at, a) + c.mask;
      at = Math.min(c.end, hi);
    }
    out.push(o + s.slice(at, hi));
    lo = hi + sep.length;
  }
  return out;
}
