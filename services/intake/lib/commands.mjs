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

// The caption price overrides the PDF's. The largest figure in the caption is the price, as before,
// but only after every figure that is CERTAINLY not a price is set aside (an area, a rate per square
// metre, a distance, a phone or licence number, an old price), and a figure that cannot be read with
// certainty means no caption price at all: the PDF's price stands. Skipping an unclear figure instead
// would hand the slot to a smaller one ("4.5m 2 floors, maintenance 6,000 SAR" must not read 6,000).
const AR = String.raw`\u0621-\u064A`; // Arabic letters (tanween and other marks are outside it)
const CURRENCY = String.raw`SAR|AED|EUR|USD|OMR|ر\.س|ريال`;

// One figure. Thousands groups are exactly three digits with ONE separator throughout ("4,500,000",
// Arabic "4٬500٬000"), so "4,500,000 4 bedrooms" ends where the price ends. A space never groups
// thousands: it joined phone numbers ("555 226 302") and unit counts into prices. Then an optional
// decimal part ("4.5", Arabic "4٫5").
const FIGURE = String.raw`[0-9]{1,3}(?<sep>[,،٬])[0-9]{3}(?:\k<sep>[0-9]{3})*(?:[.٫][0-9]+)?(?![0-9])|[0-9]+(?:[.٫][0-9]+)?`;

// A Latin multiplier is a whole word, so the m of "10 mins" and the k of "15 km" are not one. A bare m
// followed by a street, a width, a height, a distance or a size ("20m street", "20m-wide", "3.5m
// ceilings", "300m from the beach", "30m x 40m") is metres. An Arabic multiplier takes its usual endings ("ألفاً") but no further letter,
// so "الف" in "الفلل" is not one.
const METRES_AFTER = String.raw`[ \t\-]*(?:streets?|st\b|roads?|rd\b|wide|width|from|away|walk|and\b|x\b|×|by\b|ceilings?|high|height|tall|deep|depth|long|length|frontage|شارع|عرض|طريق|سقف|ارتفاع|واجهة)`;
const MULTIPLIER = String.raw`(?<lmult>mill?ions?|mill|mln|mil|mn|m(?!${METRES_AFTER})|k)(?=$|[^A-Za-z0-9${AR}]|${CURRENCY})|(?<amult>مليون|ملايين|[أا]لف)(?:اً|ًا|ا|ً)?(?![${AR}])`;

// A currency between two figures ("Floor 12 AED 2,000,000", "Built 2019 SAR 4,500,000") belongs to the
// figure after it, so a currency after a figure is its own only when no figure follows.
const PRICE_RE_SOURCE = String.raw`(?:^|[\s(])(?:(?<pre>${CURRENCY})[ \t]*)?(?<num>${FIGURE})(?:[ \t]*(?:${MULTIPLIER}))?(?:[ \t]*(?<post>${CURRENCY})(?![ \t]*[0-9]))?`;

// A unit right after a figure with no currency makes it an area ("12,000 sqm", "450m2", "12000 م2")
// or a distance ("15,000 km"); "/m2" or "per sqm" after any figure makes it a rate per square metre.
const AREA_UNIT = String.raw`(?:m2(?![0-9])|m[ \t]*²|m[ \t]*\^[ \t]*2(?![0-9])|met(?:er|re)s?2(?![0-9])|sqm|sqft|sq[ .\-]*(?:m|mt|mtr|met(?:er|re)s?|ft|feet|foot|yds?|yards?)\b|square[ \-]*(?:m|met(?:er|re)s?|f(?:ee|oo)t|yards?)\b|ft2(?![0-9])|ft[ \t]*²|m\.?[ \t]*sq\b|met(?:er|re)s?\b|(?:ال)?(?:متر|أمتار|امتار)[ \t]*مربع|(?:ال)?(?:متر|مترا|أمتار|امتار)(?![${AR}])|م[ \t]*[2²](?![0-9])|م(?![${AR}]))`;
const DISTANCE_UNIT = String.raw`(?:kms?|kilomet(?:er|re)s?|كم|كيلو)(?![A-Za-z${AR}])`;
const AREA_AFTER_RE = new RegExp(String.raw`^[ \t]*\(?[ \t]*(?:${AREA_UNIT}|${DISTANCE_UNIT})`, 'i');
const RATE_AFTER_RE = new RegExp(String.raw`^[ \t]*\(?[ \t]*(?:\/|per\b|لكل|لل)[ \t]*(?:${AREA_UNIT}|m\b|ft\b)`, 'i');
// "4.5m 2 floors" or "450 m 2": a square metre or 4.5 million and two of something. Unclear.
const SPACED_M2_RE = /^[ \t]*m[ \t]+2(?![0-9])/i;

// Labels just before a figure. A rate label ("price per sqm", "سعر المتر") marks any figure; an area
// label ("Area:", "Sqm:", "المساحة") only a bare one, because "Al Olaya area SAR 1,200,000" is a price.
// An old-price label ("was", "السعر السابق") marks the price that no longer holds.
const LABEL_END = String.raw`[ \t]*[:=\-–]?[ \t]*$`;
const RATE_LABEL_BEFORE_RE = new RegExp(String.raw`(?:\bper[ \t]*(?:sqm|sq[ .]*m|m2|m²|met(?:er|re)|square[ \t\-]*(?:m|met(?:er|re)s?|f(?:ee|oo)t))|\b(?:sqm|m2)[ \t]+price|سعر[ \t]+(?:ال)?متر|للمتر|(?:ال)?متر[ \t]+(?:ال)?مربع|^[ \t]*(?:ال)?متر)${LABEL_END}`, 'i');
const AREA_LABEL_BEFORE_RE = new RegExp(String.raw`(?:\b(?:area|size|plot|bua)(?:[ \t]*\([^)]*\))?|\b(?:sqm|sq[ .]*m|m2|m²)[ \t]*:|(?:ال)?مساحة)${LABEL_END}`, 'i');
const OLD_PRICE_LABEL_BEFORE_RE = new RegExp(String.raw`(?:\bwas|\bpreviously|\bold[ \t]+price|\binstead[ \t]+of|السعر[ \t]+السابق|سابقا|سابقاً|بدلا[ \t]+من|بدلاً[ \t]+من|كان)${LABEL_END}`, 'i');

// A currency that ends a line with no figure of its own ("Price: AED") belongs to the figure that
// starts the next line ("450,000").
const CURRENCY_AT_LINE_END_RE = new RegExp(String.raw`(^|[\n\r\u2028\u2029])([^0-9\n\r\u2028\u2029]*?(?:${CURRENCY}))[ \t]*(?:\r\n|[\n\r\u2028\u2029])(?=[ \t]*[0-9])`, 'gi');

// Direction marks and the tatweel are invisible: م2 behind a right-to-left mark, or م + tatweel + 2, must read as م2.
const INVISIBLE_RE = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069\u0640]/g;

/**
 * A price the OWNER typed in the caption. Never an estimate — this only reads an
 * explicit figure. Returns null when the caption carries no number, or one that cannot
 * be read with certainty.
 */
export function parsePriceHint(caption) {
  const text = westernise(caption || '').replace(INVISIBLE_RE, '').replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(CURRENCY_AT_LINE_END_RE, '$1$2 ');
  // "SAR 4,500,000" | "4.5m sar" | "٤٥٠٠٠٠٠ ريال" | "price 750000"
  let best = null;
  // One line at a time: a figure, its unit and its label never reach across a line break.
  const lines = text.split(/\r\n|[\n\r\u2028\u2029]/);
  for (const [i, line] of lines.entries()) {
    let prev = null; // the figure read just before on this line, while nothing else came between
    for (const m of line.matchAll(new RegExp(PRICE_RE_SOURCE, 'dgi'))) {
      const last = prev;
      prev = null;
      const g = m.groups;
      const numEnd = m.indices.groups.num[1];
      const afterNum = line.slice(numEnd);
      const tail = line.slice(m.index + m[0].length);
      // Unclear figures: no caption price at all.
      if (SPACED_M2_RE.test(afterNum)) return null;
      // "4,5000" or "4500,000": the figure stops short of more digits.
      if (/^[,،٬.٫][0-9]/.test(afterNum)) return null;
      // "4,500, 000" or "4,500 000": three more digits after a comma-grouped figure, carrying no unit of their own.
      const loose = /^[,،٬]?[ \t]+[0-9]{3}(?![0-9])/.exec(afterNum);
      if (g.sep && loose && !AREA_AFTER_RE.test(afterNum.slice(loose[0].length))) return null;

      if (RATE_AFTER_RE.test(afterNum) || RATE_AFTER_RE.test(tail)) continue;
      if (!g.pre && !g.post && (AREA_AFTER_RE.test(afterNum) || AREA_AFTER_RE.test(tail))) continue;
      // A figure first on its line takes its label from the end of the line above ("Price per sqm:" / "SAR 3,500").
      const before = line.slice(0, m.index);
      const label = before.trim() || i === 0 ? before : lines[i - 1];
      const bare = !g.lmult && !g.amult && !g.pre && !g.post;
      if (RATE_LABEL_BEFORE_RE.test(label) || OLD_PRICE_LABEL_BEFORE_RE.test(label)) continue;
      if (bare && AREA_LABEL_BEFORE_RE.test(label)) continue;
      // A phone, licence or id number: ten or more ungrouped digits, a leading 0, or a Saudi mobile without it.
      if (!g.lmult && !g.amult && /^[0-9]+$/.test(g.num) && (g.num.length >= 10 || /^0[0-9]/.test(g.num) || /^5[0-9]{8}$/.test(g.num))) continue;

      let amount = Number(g.num.replace(/[,،٬]/g, '').replace('٫', '.'));
      if (!Number.isFinite(amount)) continue;
      if (/^m$/i.test(g.lmult || '')) {
        // A bare m after a figure of 1,000 or more is metres ("Land 12,000 m"), and so is the second
        // side of a size ("30m x 40m") or the second of two widths ("20m and 15m").
        // A figure with a currency is money whatever comes before it ("Land 30m x 40m, SAR 2.5m").
        const money = Boolean(g.pre || g.post);
        if (amount >= 1000 || (!money && /[0-9][ \t]*m?[ \t]*[x×*][ \t]*$|[0-9][ \t]*m[ \t]*(?:and|&|,|و)[ \t]*$/i.test(before))) continue;
        // After a street, 4.5m is a price ("Olaya Street 4.5m") but 20m may be its width: unclear.
        if (!money && amount >= 10 && /(?:\b(?:streets?|st\.?|roads?|rd\.?|width)|شارع|طريق|عرض)[ \t:]*$/i.test(before)) return null;
      }
      const mult = (g.lmult || g.amult || '').toLowerCase();
      if (/^(m|mn|mil|mill|mln|mill?ions?|مليون|ملايين)$/.test(mult)) amount *= 1e6;
      else if (/^(k|ألف|الف)$/.test(mult)) amount *= 1e3;
      const cur = (g.pre || g.post || '').toUpperCase();
      const currency = cur === 'ر.س' || cur === 'ريال' ? 'SAR' : CURRENCIES.includes(cur) ? cur : null;
      // "4,500,000 AED 5 bedrooms": the currency reached the count after it, but it is the price's.
      if (g.pre && amount < 1000 && last && last.end === m.index && !last.reading.explicitCurrency) {
        Object.assign(last.reading, { currency, explicitCurrency: true });
        continue;
      }
      // A bare number only counts as a price when it is plausibly one (>= 10,000) —
      // otherwise "3 bedrooms" would become a price.
      if (!currency && amount < 10000) continue;
      if (amount < 1000) continue;
      const reading = { amount, currency: currency || 'SAR', explicitCurrency: Boolean(currency) };
      prev = { reading, end: m.index + m[0].length };
      if (!best || amount > best.amount || (amount === best.amount && currency && !best.explicitCurrency)) best = reading;
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
