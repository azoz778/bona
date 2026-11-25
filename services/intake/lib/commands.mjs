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

// The caption price overrides the PDF's, so every rule below errs towards reading NO price (the PDF's
// is used) rather than a wrong one.
const AR = String.raw`\u0621-\u064A`; // Arabic letters (tanween and other marks are outside it)
const CURRENCY = String.raw`SAR|AED|EUR|USD|OMR|ر\.س|ريال`;

// One figure. Thousands groups are exactly three digits with ONE separator throughout ("4,500,000",
// "٤٬٥٠٠٬٠٠٠", "4 500 000"), so "4,500,000 4 bedrooms" and "950,000 120 units" end where the price ends.
// Then an optional decimal part ("4.5", "٤٫٥").
const FIGURE = String.raw`[0-9]{1,3}(?<sep>[,،٬ \u00A0])[0-9]{3}(?:\k<sep>[0-9]{3})*(?:[.٫][0-9]+)?(?![0-9])|[0-9]+(?:[.٫][0-9]+)?`;

// A Latin multiplier is a whole word, so the m of "10 mins" and the k of "15 km" are not one; the
// m of a street width ("20m street") is not one either. An Arabic one takes its usual endings
// ("ألفاً") but no further letter, so "الف" in "الفلل" is not one.
const MULTIPLIER = String.raw`(?<lmult>millions?|mln|mil|mn|m(?![ \t]*(?:street|st\b|road|rd\b|wide|width|شارع|عرض|طريق))|k)(?=$|[^A-Za-z0-9${AR}]|${CURRENCY})|(?<amult>مليون|ملايين|[أا]لف)(?:اً|ًا|ا|ً)?(?![${AR}])`;

const PRICE_RE_SOURCE = String.raw`(?:^|[\s(])(?:(?<pre>${CURRENCY})[ \t]*)?(?<num>${FIGURE})[ \t]*(?:${MULTIPLIER})?[ \t]*(?<post>${CURRENCY})?`;

// A unit right after a figure makes it an area ("12,000 sqm", "450 m 2", "12000 م2") or a distance
// ("15,000 km"), and "/m2" or "per sqm" after it makes it a rate per square metre: none of them is
// the price, however large.
const AREA_UNIT = String.raw`(?:m[ \t]*[2²]|m\^2|met(?:er|re)s?[ \t]*2|sqm|sqft|sq[ .\-]*(?:m|mt|mtr|met(?:er|re)s?|ft|feet|foot|yds?|yards?)\b|square[ \-]*(?:m|met(?:er|re)s?|f(?:ee|oo)t|yards?)\b|ft[ \t]*[2²]|m\.?[ \t]*sq\b|met(?:er|re)s?\b|(?:ال)?(?:متر|أمتار|امتار)[ \t]*مربع|(?:ال)?(?:متر|مترا|أمتار|امتار)(?![${AR}])|م[ \t]*[2²]|م(?![${AR}]))`;
const DISTANCE_UNIT = String.raw`(?:kms?|kilomet(?:er|re)s?|كم|كيلو)(?![A-Za-z${AR}])`;
const UNIT_AFTER_RE = new RegExp(String.raw`^[ \t]*\(?[ \t]*(?:(?:\/|per\b|لكل|لل)[ \t]*)?${AREA_UNIT}|^[ \t]*${DISTANCE_UNIT}`, 'i');

// A label just before the figure that says area or rate per metre: "Area: 12,000", "Sqm: 12,000",
// "سعر المتر: 3500", "Price per sqm SAR 3,500".
const AREA_LABEL_BEFORE_RE = new RegExp(String.raw`(?:\b(?:area|size|plot|bua)|\bper[ \t]*(?:sqm|sq[ .]*m|m2|m²|met(?:er|re))|\b(?:sqm|sq[ .]*m|m2|m²)[ \t]*:|(?:ال)?مساحة|سعر[ \t]+(?:ال)?متر|للمتر|(?:ال)?متر[ \t]+(?:ال)?مربع)[ \t]*[:=\-–]?[ \t]*$`, 'i');

// The text before a figure ends in a number of its own (not a unit such as "m2"): "+966 55 522 6302".
const NUMBER_BEFORE_RE = new RegExp(String.raw`(?:^|[^A-Za-z0-9${AR}])[0-9][0-9.,،٬]*[ \t]*$`);

// Direction marks and the tatweel are invisible: م2 behind a right-to-left mark, or م + tatweel + 2, must read as م2.
const INVISIBLE_RE = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069\u0640]/g;

/**
 * A price the OWNER typed in the caption. Never an estimate — this only reads an
 * explicit figure. Returns null when the caption carries no number.
 */
export function parsePriceHint(caption) {
  const text = westernise(caption || '').replace(INVISIBLE_RE, '').replace(/\u00A0/g, ' ');
  // "SAR 4,500,000" | "4.5m sar" | "٤٥٠٠٠٠٠ ريال" | "price 750000"
  let best = null;
  // One line at a time: a figure, its unit and its label never reach across a line break.
  for (const line of text.split(/\r\n|[\n\r\u2028\u2029]/)) {
    for (const m of line.matchAll(new RegExp(PRICE_RE_SOURCE, 'dgi'))) {
      const g = m.groups;
      const numEnd = m.indices.groups.num[1];
      if (UNIT_AFTER_RE.test(line.slice(numEnd)) || UNIT_AFTER_RE.test(line.slice(m.index + m[0].length))) continue;
      const before = line.slice(0, m.index);
      if (AREA_LABEL_BEFORE_RE.test(before)) continue;
      // A figure straight after another figure is part of a longer number: "+966 55 522 6302", "0555 226 302".
      if (NUMBER_BEFORE_RE.test(before)) continue;
      // "4,5000" or "4500,000": the figure stops short of more digits, so it is not clear what was meant.
      if (/^[,،٬.٫][0-9]/.test(line.slice(numEnd))) continue;
      const digits = g.num.replace(/[,،٬ \u00A0]/g, '').replace('٫', '.');
      // A phone, licence or id number is a long run of digits, or starts with 0: never a price.
      if (!g.lmult && !g.amult && /^[0-9]+$/.test(digits) && (digits.length >= 10 || /^0[0-9]/.test(digits))) continue;
      let amount = Number(digits);
      if (!Number.isFinite(amount)) continue;
      // A bare m is metres, not millions, after a figure of 1,000 or more ("Land 12,000 m") or a street ("street 20m").
      if (/^m$/i.test(g.lmult || '') && (amount >= 1000 || /(?:street|road|width|شارع|عرض|طريق)[ \t:]*$/i.test(before))) continue;
      const mult = (g.lmult || g.amult || '').toLowerCase();
      if (/^(m|mn|mil|mln|millions?|مليون|ملايين)$/.test(mult)) amount *= 1e6;
      else if (/^(k|ألف|الف)$/.test(mult)) amount *= 1e3;
      const cur = (g.pre || g.post || '').toUpperCase();
      const currency = cur === 'ر.س' || cur === 'ريال' ? 'SAR' : CURRENCIES.includes(cur) ? cur : null;
      // A bare number only counts as a price when it is plausibly one (>= 10,000) —
      // otherwise "3 bedrooms" would become a price.
      if (!currency && amount < 10000) continue;
      if (amount < 1000) continue;
      if (!best || amount > best.amount) best = { amount, currency: currency || 'SAR', explicitCurrency: Boolean(currency) };
    }
  }
  return best;
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
