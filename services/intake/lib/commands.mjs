// Caption hints (sent with the PDF) and text commands (sent afterwards).
// Everything here is pure — the unit tests own this file.

import { INTAKE_ID_RE, LICENCE_NUMBER_RE, LISTING_ID_RE as SITE_LISTING_ID_RE, isCalendarDate } from '../../../scripts/curate/rules.mjs';
import { westernise } from './price.mjs';

export const CURRENCIES = ['SAR', 'AED', 'EUR', 'USD', 'OMR'];

// JavaScript's \b is ASCII-only, so Arabic alternatives must live in their own patterns
// without word boundaries — "للإيجار" would never match inside a \b(...)\b group.
const CATEGORY_HINTS = [
  [/#?\b(for[- ]?rent|rent|rental)\b/i, 'rent'],
  [/(إيجار|للإيجار|للايجار|ايجار)/, 'rent'],
  [/#?\b(off[- ]?plan|under[- ]?construction)\b/i, 'off-plan'],
  [/(على ?الخارطة|تحت الإنشاء|على الخريطة)/, 'off-plan'],
  [/#?\b(international|overseas)\b/i, 'international'],
  [/(خارج المملكة|عقار دولي)/, 'international'],
  [/#?\b(for[- ]?sale|sale|buy)\b/i, 'buy'],
  [/(للبيع)/, 'buy'],
];

const PERIOD_HINTS = [
  [/\b(per|\/)\s*(year|yr|annum)\b/i, 'year'],
  [/(سنوي|سنويا|سنوياً|\/ ?سنة|في السنة)/, 'year'],
  [/\b(per|\/)\s*(month|mo)\b/i, 'month'],
  [/(شهري|شهريا|شهرياً|\/ ?شهر|في الشهر)/, 'month'],
];

// The caption price overrides the PDF's, so it is read STRICTLY. The caption sets a price only when
// it holds exactly ONE figure, written as a price: "4.5m", "SAR 4,500,000", "#rent 120,000 per year",
// "٤٫٥ مليون ريال". Any of these and the caption sets no price:
// - a second figure anywhere (an area, a room count, a phone, a second price);
// - two different currencies;
// - a unit after the figure ("450 m2", "12,000 sqm", "3,500/m2", "15 km");
// - a label before it that says what else it is ("Area:", "Deposit", "was", "Call", "سعر المتر").
// Then the PDF's own price stands, the bot's reply shows what was published, and `price <id> …` sets
// a price by hand. (A free-text reader that picked the likeliest figure kept misreading captions
// through nine review rounds; the owner's captions so far carry no price at all.)
const AR = String.raw`\u0621-\u064A`; // Arabic letters (tanween and other marks are outside it)
const CURRENCY = String.raw`(?:SAR|AED|EUR|USD|OMR)(?![A-Za-z])|ر\.س|ريال(?:اً|ا)?(?![${AR}])`;
const CURRENCY_RE = new RegExp(String.raw`(?<![A-Za-z${AR}])(?:${CURRENCY})`, 'gi');
// Every run of digits, with the separators that join it, is one figure.
const DIGIT_RUN_RE = /[0-9]+(?:[,،٬.٫][0-9]+)*/g;
// A figure written as a price: thousands in groups of three with one separator, or no separator; a
// decimal part. "4,5000", "4.500.000" and the like are not read.
const FIGURE_RE = /^(?:[0-9]{1,3}([,،٬])[0-9]{3}(?:\1[0-9]{3})*|[0-9]+)(?:[.٫][0-9]+)?$/;
// A multiplier right after the figure, as a whole word ("4.5m", "1.2 million", "850k", "٤٫٥ مليون",
// "٨٥٠ ألفاً"); not the m of "m2" or "mins", not the k of "km".
const MULTIPLIER_RE = new RegExp(String.raw`^[ \t]*(?:(?<lmult>mill?ions?|mill|mln|mil|mn|m|k)(?=$|[^A-Za-z0-9²³^${AR}]|${CURRENCY})|(?<amult>مليون|ملايين|[أا]لف)(?:اً|ًا|ا|ً)?(?![${AR}]))`, 'i');
// A unit after the figure: an area, a distance, or a rate per square metre or per month ("/m").
const UNIT_AFTER_RE = new RegExp(String.raw`^[ \t]*(?:\([ \t]*)?(?:(?:\/|per\b|لكل|لل)[ \t]*)?(?:m[ \t]*[2²]|m[ \t]*\^[ \t]*2|m\.?[ \t]*sq\b|m\b|sq[ .\-]*(?:m|mt|mtr|ft|feet|foot|yds?|yards?)\b|sqm|sqft|square|met(?:er|re)s?\b|ft[ \t]*[2²]|bua\b|gfa\b|kms?\b|kilomet|(?:ال)?(?:متر|مترا|أمتار|امتار)|م[ \t]*[2²]|م(?![${AR}])|كم(?![${AR}])|كيلو)`, 'i');
// A label right before the figure that says it is not the price.
const NOT_PRICE_LABEL_RE = new RegExp(String.raw`(?:\b(?:area|size|plot|bua|sqm|m2|deposit|down[ \t]*payment|service[ \t]*charges?|maintenance|commission|instal(?:l)?ments?|booking|income|was|previously|old[ \t]+price|ref(?:erence)?|no\.?|number|phone|tel|mobile|call|whatsapp|licen[cs]e|permit|id|floor|built|year|handover|street|road|width|height|frontage|per[ \t]*(?:sqm|m2|m²|met(?:er|re)|square[ \t]*(?:m|met(?:er|re)s?|f(?:ee|oo)t)))|(?:^|[^${AR}])(?:ال)?(?:مساحة|عربون|عمولة|صيانة|قسط|رسوم|دور|تسليم|شارع|عرض|ارتفاع|واجهة|ترخيص|رخصة|هوية|جوال|هاتف|رقم)|سعر[ \t]+(?:ال)?متر|للمتر|السعر[ \t]+السابق|سابقاً?|اتصال|واتساب|بناء|سنة|عام)[^0-9A-Za-z${AR}]*$`, 'i');
// ...unless the fee word is negated: "السعر بدون عمولة 4,500,000", "Price incl. commission: 2.5m".
const NEGATED_RE = new RegExp(String.raw`(?:\b(?:without|no|zero|free|incl\.?|including|inclusive|excl\.?|excluding)\b|بدون|بلا|شامل|شاملة|غير|(?:^|[^${AR}])لا(?![${AR}]))[^0-9]{0,30}$`, 'i');
// Direction marks and the tatweel are invisible: م2 behind a right-to-left mark, or م + tatweel + 2, must read as م2.
const INVISIBLE_RE = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069\u0640]/g;

/**
 * A price the OWNER typed in the caption. Never an estimate — this only reads an
 * explicit figure. Returns null when the caption carries no figure, or anything that
 * makes the one figure doubtful (see above).
 */
export function parsePriceHint(caption) {
  const text = westernise(caption || '').replace(INVISIBLE_RE, '').replace(/[\u00A0\u2007\u202F]/g, ' ')
    // hashtags and listing or unit ids ("#rent", "BONA-W023", "A-12") are not figures; a neutral word
    // keeps a label before them ("Ref: BONA-W123, 1,850,000") from reaching the figure
    .replace(/#[^\s#]+/g, ' tag ').replace(/\b[A-Za-z]+-[A-Za-z]*[0-9]+\b/g, ' listing ');
  const runs = [...text.matchAll(DIGIT_RUN_RE)];
  if (runs.length !== 1) return null;
  const [run] = runs;
  const num = run[0];
  if (!FIGURE_RE.test(num)) return null;
  const currencies = new Set([...text.matchAll(CURRENCY_RE)].map((c) => {
    const u = c[0].toUpperCase();
    return u === 'ر.س' || u.startsWith('ريال') ? 'SAR' : u;
  }));
  if (currencies.size > 1) return null;
  const currency = currencies.size ? [...currencies][0] : null;

  // A currency between a label and the figure ("Service charge SAR 12,000"), or between the figure and
  // its unit ("3,500 SAR per sqm"), does not hide them.
  const CURRENCY_END_RE = new RegExp(String.raw`(?:${CURRENCY})[ \t]*$`, 'i');
  const CURRENCY_START_RE = new RegExp(String.raw`^[ \t]*(?:${CURRENCY})`, 'i');
  const before = text.slice(0, run.index).slice(-60).replace(CURRENCY_END_RE, '');
  if (NOT_PRICE_LABEL_RE.test(before) && !NEGATED_RE.test(before)) return null;
  let after = text.slice(run.index + num.length);
  if (UNIT_AFTER_RE.test(after) && !MULTIPLIER_RE.exec(after)?.groups.lmult) return null;
  const mult = MULTIPLIER_RE.exec(after);
  if (mult) after = after.slice(mult[0].length);
  // "4.5m2" or "450 m 2" is an area, not 4.5 million; "4.5m sqm" too.
  if (mult && (/^[ \t]*[2²^]/.test(after) || UNIT_AFTER_RE.test(after))) return null;
  const afterCurrency = after.replace(CURRENCY_START_RE, '');
  if (afterCurrency !== after && UNIT_AFTER_RE.test(afterCurrency) && !/^[ \t]*m\b(?![ \t]*[2²^.])/i.test(afterCurrency)) return null;

  const digits = num.replace(/[,،٬]/g, '').replace('٫', '.');
  // A phone, licence or id number: no price starts with 0, and a bare run of ten or more digits
  // (or a Saudi mobile without its 0) is never one.
  if (!mult && /^0[0-9]/.test(digits)) return null;
  if (!mult && !currency && (/^[0-9]{10,}$/.test(digits) || /^5[0-9]{8}$/.test(digits))) return null;
  const word = (mult?.groups.lmult || mult?.groups.amult || '').toLowerCase();
  const factor = /^(m|mn|mil|mill|mln|mill?ions?|مليون|ملايين)$/.test(word) ? 1e6 : /^(k|ألف|الف)$/.test(word) ? 1e3 : 1;
  const amount = Number(digits);
  if (!Number.isFinite(amount)) return null;
  // A bare "450 m" is as likely metres as millions: with no currency, only below 100 is it millions.
  if (word === 'm' && !currency && amount >= 100) return null;
  const value = Math.round(amount * factor * 1000) / 1000;
  // A bare number only counts as a price when it is plausibly one (>= 10,000) —
  // otherwise "3 bedrooms" would become a price.
  if (!currency && factor === 1 && value < 10000) return null;
  if (value < 1000) return null;
  return { amount: value, currency: currency || 'SAR', explicitCurrency: Boolean(currency) };
}

/**
 * Parse the caption sent with the PDF.
 * @returns {{dryRun:boolean, publishBrochure:boolean, hidden:boolean, category:string|null,
 *            price:{amount:number,currency:string}|null, period:'year'|'month'|null,
 *            tags:string[], text:string}}
 *
 * `publishBrochure` (`#brochure` / `#pdf`) is a NO-OP ALIAS: every accepted brochure is
 * re-published under Bona's branding by default, so the tag only says out loud what already
 * happens. `#nobrochure` (`#nopdf`) is the flag that changes anything — it is how to publish
 * a listing with no downloadable document at all. Both together: `#nobrochure` wins.
 */
export function parseCaption(caption) {
  const text = String(caption || '').trim();
  const tags = [...text.matchAll(/#([A-Za-z0-9_-]{1,32})/g)].map((m) => m[1].toLowerCase());
  const has = (t) => tags.includes(t);
  let category = null;
  for (const [re, value] of CATEGORY_HINTS) {
    if (re.test(text)) { category = value; break; }
  }
  let period = null;
  for (const [re, value] of PERIOD_HINTS) {
    if (re.test(text)) { period = value; break; }
  }
  if (category === 'rent' && !period) period = 'year';
  if (category !== 'rent') period = null;
  const price = parsePriceHint(text);
  return {
    text,
    tags,
    dryRun: has('test') || has('dry') || has('draft'),
    // Kept for the reply/summary wording and for old captions; the pipeline does not branch
    // on it any more (see the doc comment).
    publishBrochure: has('brochure') || has('pdf'),
    noBrochure: has('nobrochure') || has('nopdf') || has('no-brochure') || has('no-pdf'),
    hidden: has('hidden') || has('private'),
    category,
    price: price ? { amount: price.amount, currency: price.currency } : null,
    period,
  };
}

// Both patterns are the SITE's own rules re-flagged, never re-typed: a second copy of an id
// pattern is a copy that drifts. The only difference is `i`, because the owner types on a
// phone keyboard that likes to capitalise.
//
// INTAKE_ID_RE (BONA-W###) is what every verb takes: they all edit an inbox JSON, which only
// an intake listing has. LISTING_ID_RE (BONA-### as well) is what `licence` and `wafi` take —
// a REGA advertisement number belongs to every listing on the site, not just the ones the
// intake published, and the curated ones keep theirs in scripts/curate/licences.json.
export const LISTING_ID_RE = new RegExp(INTAKE_ID_RE.source, 'i');
export const ANY_LISTING_ID_RE = new RegExp(SITE_LISTING_ID_RE.source, 'i');

// Unanchored version of LISTING_ID_RE, for pulling an id out of free text — a video's
// caption, e.g. "video BONA-W001" or just "BONA-W001" on its own.
const LISTING_ID_SEARCH_RE = /BONA-W\d{3,5}/i;

const LICENCE_USAGE = 'usage: licence BONA-W001 7200012345 2027-03-01  |  licence BONA-W001 clear';
const WAFI_USAGE = 'usage: wafi BONA-W001 1234567890  |  wafi BONA-W001 clear';

/** `clear` / `none` / `مسح` — take the number off the listing again. */
const CLEAR_RE = /^(clear|none|مسح)$/i;

/**
 * The expiry date on a REGA advertisement licence, as `YYYY-MM-DD`.
 *
 * Accepts what the owner actually types: the ISO form, or the `DD/MM/YYYY` his phone's
 * keyboard and every Saudi form use (also with `-` or `.` between the parts), in Western or
 * Arabic-Indic digits. Day-first is the ONLY two-digit reading offered — guessing between
 * `03/01` as January 3rd and March 1st is exactly the ambiguity that would put a wrong expiry
 * on a licence line, so an American-style date simply does not parse here.
 * @returns {string|null} the ISO date, or null when it is not a real calendar date
 */
export function parseExpiryDate(text) {
  const s = westernise(text || '').trim();
  let iso = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) iso = s;
  else {
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
    if (m) iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return iso && isCalendarDate(iso) ? iso : null;
}

/**
 * Find a listing id anywhere in a string. Used for a WhatsApp VIDEO message: unlike the PDF
 * (which always mints a new listing) or the text commands above (one exact verb + id), a
 * video only ever attaches to a listing that already exists, so its caption just needs to
 * mention the id — `video BONA-W001`, `BONA-W001`, `add this to BONA-W001`, all work.
 * @returns {string|null} the id, uppercased, or null when the text carries none.
 */
export function findListingId(text) {
  const m = LISTING_ID_SEARCH_RE.exec(String(text || ''));
  return m ? m[0].toUpperCase() : null;
}

/**
 * Parse a text message as a command. Returns { cmd: null } for ordinary chatter so the
 * daemon stays silent instead of replying to everything.
 * Supported: remove <id> | hero <id> <n> | price <id> <amount> [currency] | price <id> onrequest
 *            sold <id> | available <id> | hide <id> | show <id> | brochure <id>
 *            licence <id> <adNumber> <YYYY-MM-DD> | wafi <id> <number> | either with `clear`
 *            retry | help | status
 *
 * `lang` rides along on the two licence commands: the owner who asks in Arabic (`ترخيص`,
 * `وافي`) is answered in Arabic. Nothing else in the intake speaks Arabic yet.
 */
export function parseCommand(text) {
  const raw = String(text || '').trim();
  if (!raw) return { cmd: null };
  const parts = raw.split(/\s+/);
  const verb = parts[0].toLowerCase().replace(/^[/!]/, '');
  const arg = (i) => parts[i] ?? '';
  const idAt = (i) => (LISTING_ID_RE.test(arg(i)) ? arg(i).toUpperCase() : null);
  const anyIdAt = (i) => (ANY_LISTING_ID_RE.test(arg(i)) ? arg(i).toUpperCase() : null);
  // The verb tells us which language to answer in — he typed it.
  const lang = /[\u0600-\u06FF]/.test(verb) ? 'ar' : 'en';

  switch (verb) {
    case 'help':
    case 'commands':
      return { cmd: 'help' };
    case 'status':
      return { cmd: 'status' };
    case 'retry':
      return { cmd: 'retry' };
    case 'remove':
    case 'delete':
    case 'unpublish': {
      const id = idAt(1);
      return id ? { cmd: 'remove', id } : { cmd: 'error', message: 'usage: remove BONA-W001' };
    }
    case 'hero': {
      const id = idAt(1);
      const n = Number(arg(2));
      if (!id || !Number.isInteger(n) || n < 1) return { cmd: 'error', message: 'usage: hero BONA-W001 4  (4 = the photo number to promote)' };
      return { cmd: 'hero', id, index: n };
    }
    case 'price': {
      const id = idAt(1);
      if (!id) return { cmd: 'error', message: 'usage: price BONA-W001 4500000  |  price BONA-W001 onrequest' };
      const rest = parts.slice(2).join(' ');
      if (/^\s*(on ?request|onrequest|عند الطلب)\s*$/i.test(rest)) return { cmd: 'price', id, onRequest: true };
      const p = parsePriceHint(rest);
      if (!p) return { cmd: 'error', message: 'usage: price BONA-W001 4500000  |  price BONA-W001 onrequest' };
      return { cmd: 'price', id, amount: p.amount, currency: p.currency, onRequest: false };
    }
    case 'brochure':
    case 'pdf': {
      const id = idAt(1);
      return id ? { cmd: 'brochure', id } : { cmd: 'error', message: 'usage: brochure BONA-W001' };
    }
    // REGA advertisement licence — the number and its expiry, straight off the FAL platform.
    // Nothing about it is guessed: a licence line on a page the owner cannot show REGA is
    // worse than no line at all, so anything that does not parse comes back as a usage error.
    case 'licence':
    case 'license':
    case 'ترخيص': {
      const id = anyIdAt(1);
      if (!id) return { cmd: 'error', message: LICENCE_USAGE };
      if (CLEAR_RE.test(arg(2))) return { cmd: 'licence', id, clear: true, lang };
      const adNumber = westernise(arg(2)).trim();
      if (!LICENCE_NUMBER_RE.test(adNumber)) return { cmd: 'error', message: LICENCE_USAGE };
      if (!arg(3)) return { cmd: 'error', message: `${LICENCE_USAGE}  (the expiry date is part of the licence)` };
      const adExpiry = parseExpiryDate(arg(3));
      if (!adExpiry) return { cmd: 'error', message: `"${arg(3)}" is not a real date — ${LICENCE_USAGE}` };
      return { cmd: 'licence', id, adNumber, adExpiry, lang };
    }
    // The off-plan counterpart: the developer's Wafi project licence, which stands in for a
    // per-listing advertisement number on an off-plan unit. No expiry — Wafi numbers carry none.
    case 'wafi':
    case 'وافي': {
      const id = anyIdAt(1);
      if (!id) return { cmd: 'error', message: WAFI_USAGE };
      if (CLEAR_RE.test(arg(2))) return { cmd: 'wafi', id, clear: true, lang };
      const wafiNumber = westernise(arg(2)).trim();
      if (!LICENCE_NUMBER_RE.test(wafiNumber)) return { cmd: 'error', message: WAFI_USAGE };
      return { cmd: 'wafi', id, wafiNumber, lang };
    }
    case 'sold':
      return idAt(1) ? { cmd: 'status-set', id: idAt(1), status: 'sold' } : { cmd: 'error', message: 'usage: sold BONA-W001' };
    case 'reserved':
      return idAt(1) ? { cmd: 'status-set', id: idAt(1), status: 'reserved' } : { cmd: 'error', message: 'usage: reserved BONA-W001' };
    case 'available':
      return idAt(1) ? { cmd: 'status-set', id: idAt(1), status: 'available' } : { cmd: 'error', message: 'usage: available BONA-W001' };
    case 'hide':
      return idAt(1) ? { cmd: 'hidden-set', id: idAt(1), hidden: true } : { cmd: 'error', message: 'usage: hide BONA-W001' };
    case 'show':
    case 'publish':
      return idAt(1) ? { cmd: 'hidden-set', id: idAt(1), hidden: false } : { cmd: 'error', message: 'usage: show BONA-W001' };
    default:
      return { cmd: null };
  }
}

export const HELP_TEXT = [
  'Bona intake — commands',
  '',
  'Send a property brochure PDF here to publish it — the brochure is re-published under',
  'Bona branding and appears on the page as "Download brochure".',
  'Caption hints: rent · off-plan · SAR 4,500,000 · #test (dry run) · #nobrochure (no PDF on the page) · #hidden',
  '',
  'Got a walkthrough clip? Just send the VIDEO here — it works out which property it is:',
  'the brochure you sent it with, or failing that, by looking at the clip itself. Caption it',
  '`video BONA-W001` only if it asks. Up to 4 per listing, no re-publish needed.',
  '',
  'remove BONA-W001        take the listing off the site',
  'hero BONA-W001 4        make photo 4 the cover',
  'price BONA-W001 4500000 set the asking price (or: price BONA-W001 onrequest)',
  'brochure BONA-W001      rebuild the Bona brochure (after a price, photo or title change)',
  'sold BONA-W001          mark it sold   (also: reserved / available)',
  'hide BONA-W001          keep it off the site  (show BONA-W001 puts it back)',
  'status                  what the intake is doing',
  '',
  'REGA numbers — before any promotion (works on BONA-015 too, not just BONA-W###):',
  'licence BONA-W001 7200012345 2027-03-01   the advertisement licence and its expiry',
  'wafi BONA-W001 1234567890                 the off-plan project\'s Wafi licence',
  'Arabic works and answers in Arabic: `ترخيص` · `وافي`. `clear` instead of the number',
  'takes it off again.',
].join('\n');
