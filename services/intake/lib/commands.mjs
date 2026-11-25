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

// The caption price overrides the PDF's, so it is read STRICTLY: the caption sets a price only when it
// is nothing but a price. That is one figure ("4.5m", "SAR 4,500,000", "٤٫٥ مليون ريال"), with its
// multiplier and currency, and words from a short list:
// - price words (price, asking, السعر, المطلوب);
// - rent or sale (#rent, للبيع, إيجار);
// - a period (per year, شهرياً);
// - only, cash, negotiable.
// Any other word (a place, a feature, a label such as "Deposit" or "Area", a unit such as "m2"),
// a second figure, two currencies or one the site does not price in, and the caption sets no price.
// Then the PDF's own price stands, the bot's reply shows what was published, and `price <id> …` sets
// a price by hand. (Readers that picked a figure out of free text kept misreading captions through
// twelve review rounds; the owner's captions so far carry no price at all.)
const AR = String.raw`\u0621-\u064A`; // Arabic letters (tanween and other marks are outside it)
// The currencies the site prices in, as codes, symbols and words ("ريال" alone is the Saudi riyal).
const CURRENCY_WORDS = [
  ['OMR', String.raw`OMR|RO|ر\.ع|(?:بال|ال)?ريال(?:ا)? (?:ال)?عماني|omani (?:riyals?|rials?)`],
  ['SAR', String.raw`SAR|SR|saudi (?:riyals?|rials?)|riyals?|ر\.س|(?:بال|ال)?ريال(?:ا)?(?: (?:ال)?سعودي)?`],
  ['AED', String.raw`AED|DHS?|dirhams?|د\.إ|(?:بال|ال)?درهم(?:ا)?(?: (?:ال)?إماراتي)?`],
  ['USD', String.raw`USD|US\$|\$|(?:us )?dollars?|(?:بال|ال)?دولار(?:ا)?(?: (?:ال)?أمريكي)?`],
  ['EUR', String.raw`EUR|€|euros?|(?:بال|ال)?يورو`],
];
// A currency token: a whole word (or a symbol), so "European" is no EUR.
const tokenRe = (body) => String.raw`(?<![A-Za-z${AR}])(?:${body})(?![A-Za-z${AR}])`;
const CURRENCY_TOKEN_RE = new RegExp(CURRENCY_WORDS.map(([, re]) => tokenRe(re)).join('|'), 'gi');
// The words a price-only caption may hold besides the figure, its multiplier and its currency.
const ALLOWED_WORD_RE = new RegExp(tokenRe(String.raw`price|prices|asking|total|for|sale|rent|rental|lease|is|of|at|a|an|per|year|years|yearly|annum|annually|month|monthly|only|net|cash|final|firm|negotiable|السعر|سعر|بسعر|المطلوب|هو|ب|للبيع|بيع|للإيجار|للايجار|إيجار|ايجار|الإيجار|الايجار|في|سنة|السنة|سنوي|سنويا|سنوية|شهر|الشهر|شهري|شهريا|شهرية|فقط|كاش|نهائي|قابل|للتفاوض`), 'gi');
// Every run of digits, with the separators that join it, is one figure.
const DIGIT_RUN_RE = /[0-9]+(?:[,،٬.٫][0-9]+)*/g;
// A figure written as a price: thousands in groups of three with one separator, or no separator; a
// decimal part. "4,5000", "4.500.000", ".5" and "-450,000" are not read.
const FIGURE_RE = /^(?:[0-9]{1,3}([,،٬])[0-9]{3}(?:\1[0-9]{3})*|[0-9]+)(?:[.٫][0-9]+)?$/;
// A multiplier right after the figure ("4.5m", "1.2 million", "850k", "٤٫٥ مليون", "٨٥٠ ألف").
const MULTIPLIER_RE = new RegExp(String.raw`^ ?(?:(?<lmult>millions?|mln|mil|mn|m|thousands?|k)|(?<amult>مليون|ملايين|ألف|الف)(?:ا)?)(?:(?![A-Za-z0-9${AR}])|(?=(?:SAR|AED|USD|EUR|OMR|SR|RO|DHS?)(?![A-Za-z])|[$€]))`, 'i');
const OTHER_SYMBOL_RE = /[£₹₺¥₩₽₪]/;
const FLAG_TAG_RE = /#(?:test|dry|draft|brochure|pdf|nobrochure|nopdf|no-brochure|no-pdf|hidden|private|rent|rental|forrent|for-rent|sale|forsale|for-sale|buy|offplan|off-plan|international|overseas)(?![A-Za-z0-9_-])/gi;
// Direction marks, the tatweel and the vowel marks are invisible ("عُماني" is "عماني", "بـ" is "ب").
const INVISIBLE_RE = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069\u0640\u064B-\u0652]/g;

/**
 * A price the OWNER typed in the caption. Never an estimate — this only reads an explicit
 * figure. Returns null unless the caption is nothing but that price (see above).
 */
export function parsePriceHint(caption) {
  // NFKC turns fullwidth and other compatibility digits into 0-9; any other digit is not ours to
  // read. All white space, line breaks included, is one space. The bot's flags and categories
  // ("#test", "#rent") are read by parseCaption and are not words here; any other hashtag is its
  // word ("#Deposit 50,000" is a deposit).
  const text = westernise(String(caption || '').normalize('NFKC')).replace(INVISIBLE_RE, '')
    .replace(FLAG_TAG_RE, ' ').replace(/#/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\p{Nd}/u.test(text.replace(/[0-9]/g, '')) || OTHER_SYMBOL_RE.test(text)) return null;
  const runs = [...text.matchAll(DIGIT_RUN_RE)];
  if (runs.length !== 1) return null;
  const [run] = runs;
  const num = run[0];
  if (!FIGURE_RE.test(num)) return null;
  // "4,500.000" is a typo for something, not 4,500 (OMR 175,000.125 is fine).
  if (/[,،٬][0-9]{3}[.٫]000$/.test(num)) return null;
  // ".5 million", "-450,000": a mark or a sign glued to the figure (a hyphen after a word is a
  // separator: "Price-4,500,000").
  const before = text.slice(0, run.index);
  if (new RegExp(String.raw`[.٫,،٬]$|(?:^|[^A-Za-z${AR}])[+\-−–]$`).test(before)) return null;
  let after = text.slice(run.index + num.length);
  const mult = MULTIPLIER_RE.exec(after);
  if (mult) after = after.slice(mult[0].length);

  // Nothing else: once the currencies and the allowed words are taken out, only punctuation is left.
  const currencies = new Set();
  const rest = (before + ' ' + after).replace(CURRENCY_TOKEN_RE, (c) => {
    currencies.add((CURRENCY_WORDS.find(([, re]) => new RegExp(String.raw`^(?:${re})$`, 'i').test(c)) || ['?'])[0]);
    return ' ';
  }).replace(ALLOWED_WORD_RE, ' ');
  if (new RegExp(String.raw`[0-9A-Za-z${AR}]`).test(rest)) return null;
  if (currencies.size > 1 || currencies.has('?')) return null;
  const currency = currencies.size ? [...currencies][0] : null;

  const digits = num.replace(/[,،٬]/g, '').replace('٫', '.');
  // A phone or id number: no price starts with 0; ten or more bare digits, or a Saudi mobile without
  // its 0, is never one. A year is no price either ("2027").
  if (!mult && /^0[0-9]/.test(digits)) return null;
  if (!mult && !currency && (/^[0-9]{10,}$/.test(digits) || /^5[0-9]{8}$/.test(digits))) return null;
  if (!mult && /^(?:19|20)[0-9]{2}$/.test(num)) return null;
  const word = (mult?.groups.lmult || mult?.groups.amult || '').toLowerCase();
  const factor = /^(m|mn|mil|mln|millions?|مليون|ملايين)$/.test(word) ? 1e6 : /^(k|thousands?|ألف|الف)$/.test(word) ? 1e3 : 1;
  const amount = Number(digits);
  // A bare "450 m" is as likely metres as millions: with no currency, it is millions only below 100.
  if (word === 'm' && !currency && amount >= 100) return null;
  // The amount as typed; a multiplier's float noise (2.05 x 1e6 = 2049999.9999999998) rounded away.
  const value = factor === 1 ? amount : Math.round(amount * factor * 1000) / 1000;
  if (!Number.isFinite(value) || value > 1e11) return null;
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
