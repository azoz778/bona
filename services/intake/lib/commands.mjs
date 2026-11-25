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
// once three kinds of figure are dealt with:
// - CERTAIN non-prices are set aside: a figure's own unit (an area, a distance, a rate per square
//   metre), a phone or licence number, an old price ("was 5m"), a date, and metres that cannot be
//   anything else ("12,000 m", "30m x 40m", "20m street", "3.5m ceilings", "300m from the beach").
// - GUESSES are set aside too (an "Area"/"plot" label on a bare number, a rate label, a small bare m
//   before "from" or "high"), but a guess can be wrong. If a figure set aside on a guess would be
//   larger than the price finally read, the caption gives no price, so a wrong guess can lose a
//   price but never hand its slot to a smaller figure ("4.5m from the owner, service charge 15,000").
// - An UNCLEAR figure ("450 m 2", "4,500, 000", "SAR 4500 000", a street then 20m) means no caption
//   price at all.
// Whenever the caption gives no price, the PDF's own price stands; the bot's reply shows the owner
// what was published.
const AR = String.raw`\u0621-\u064A`; // Arabic letters (tanween and other marks are outside it)
const CURRENCY = String.raw`SAR|AED|EUR|USD|OMR|ر\.س|ريال`;

// One figure. Thousands groups are exactly three digits with ONE separator throughout ("4,500,000",
// Arabic "4٬500٬000"), so "4,500,000 4 bedrooms" ends where the price ends. A space never groups
// thousands: it joined phone numbers ("555 226 302") and unit counts into prices. Then an optional
// decimal part ("4.5", Arabic "4٫5").
const FIGURE = String.raw`[0-9]{1,3}(?<sep>[,،٬])[0-9]{3}(?:\k<sep>[0-9]{3})*(?:[.٫][0-9]+)?(?![0-9])|[0-9]+(?:[.٫][0-9]+)?`;

// A Latin multiplier is a whole word (not the m of "10 mins" or "m²", not the k of "15 km"). An Arabic
// one takes its usual endings ("ألفاً") but no further letter, so "الف" in "الفلل" is not one.
const MULTIPLIER = String.raw`(?<lmult>mill?ions?|mill|mln|mil|mn|m|k)(?=$|[^A-Za-z0-9²³${AR}]|${CURRENCY})|(?<amult>مليون|ملايين|[أا]لف)(?:اً|ًا|ا|ً)?(?![${AR}])`;

// A currency between two figures ("Floor 12 AED 2,000,000", "Built 2019 SAR 4,500,000") belongs to the
// figure after it, so a currency after a figure is its own only when no figure follows.
const PRICE_RE_SOURCE = String.raw`(?:^|[\s(])(?:(?<pre>${CURRENCY})[ \t]*)?(?<num>${FIGURE})(?:[ \t]*(?:${MULTIPLIER}))?(?:[ \t]*(?<post>${CURRENCY})(?![ \t]*[0-9]))?`;

// After a bare m on a figure with no currency: words that make it metres for certain, and words that
// only suggest it ("4.5m from the owner" is a price, "300m from the beach" a distance).
const METRES_CERTAIN_AFTER_RE = new RegExp(String.raw`^[ \t\-]*(?:(?:x|×|\*|by|and)(?=[ \t]*[0-9.]+[ \t]*m\b)|streets?\b|st\b|roads?\b|rd\b|wide\b|width\b|ceilings?\b|height\b|frontage\b|شارع|عرض|طريق|سقف|ارتفاع|واجهة)`, 'i');
const METRES_GUESS_AFTER_RE = /^[ \t\-]*(?:from|away|walk|high|tall|deep|depth|long|length)\b/i;
// Before a bare m: the second side of a size ("30m x 40m", "25m by 40m"), the second of two widths
// ("20m and 15m"), a width label ("Frontage 25m").
const METRES_CERTAIN_BEFORE_RE = new RegExp(String.raw`[0-9][ \t]*m?[ \t]*(?:[x×*]|by)[ \t]*$|[0-9][ \t]*m[ \t]*(?:and|&|,|و)[ \t]*$|(?:\b(?:frontage|width|wide)|واجهة|عرض)[ \t:]*$`, 'i');
const STREET_BEFORE_RE = new RegExp(String.raw`(?:\b(?:streets?|st\.?|roads?|rd\.?)|شارع|طريق)[ \t:]*$`, 'i');

// A unit right after a figure with no currency makes it an area ("12,000 sqm", "450m2", "12000 م2")
// or a distance ("15,000 km"). "/m2" or "per sqm" after any figure makes it a rate per square metre,
// unless a number follows the unit ("per sqm 7,200" labels the 7,200).
const AREA_UNIT = String.raw`(?:m2(?![0-9])|m[ \t]*²|m[ \t]*\^[ \t]*2(?![0-9])|met(?:er|re)s?2(?![0-9])|sqm|sqft|sq[ .\-]*(?:m|mt|mtr|met(?:er|re)s?|ft|feet|foot|yds?|yards?)\b|square[ \-]*(?:m|met(?:er|re)s?|f(?:ee|oo)t|yards?)\b|ft2(?![0-9])|ft[ \t]*²|m\.?[ \t]*sq\b|met(?:er|re)s?\b|(?:ال)?(?:متر|أمتار|امتار)[ \t]*مربع|(?:ال)?(?:متر|مترا|أمتار|امتار)(?![${AR}])|م[ \t]*[2²](?![0-9])|م(?![${AR}]))`;
const DISTANCE_UNIT = String.raw`(?:kms?|kilomet(?:er|re)s?|كم|كيلو)(?![A-Za-z${AR}])`;
const AREA_AFTER_RE = new RegExp(String.raw`^[ \t]*\(?[ \t]*(?:${AREA_UNIT}|${DISTANCE_UNIT})`, 'i');
const RATE_AFTER_RE = new RegExp(String.raw`^[ \t]*\(?[ \t]*(?:\/|per\b|لكل|لل)[ \t]*(?:${AREA_UNIT}|m\b|ft\b)(?![ \t]*[:=]?[ \t]*[0-9])`, 'i');
// "450 m 2" or "4.5m 2 floors": a square metre, or 4.5 million and two of something. Unclear, unless
// what follows is a count ("1.2M 2 bedrooms" is 1.2 million).
const SPACED_M2_RE = /^[ \t]*m[ \t]+2(?![0-9])/i;
const SPACED_M2_COUNT_RE = /^[ \t]*m[ \t]+2[ \t]*(?:bed|br\b|bath|room|floor|stor|unit|park|payment|instal|villa|apartment|غرف|دور|أدوار|ادوار|حمام|دورات|دفع|شقق|شقة|موقف)/i;
// A date ("30.06.2027", "2027-06-30", "30/6/2027") is no figure at all.
const DATE_RE = /^[0-9]{1,4}[./\-][0-9]{1,2}[./\-][0-9]{1,4}(?![0-9])/;

// Labels just before a figure. An old-price label ("was", "السعر السابق") is certain, and so is a fee
// or deposit label. A rate label
// ("price per sqm", "سعر المتر") on any figure and an area label ("Area:", "plot", "المساحة") on a bare
// one are guesses ("Al Olaya area 4,500,000" is a price).
const LABEL_END = String.raw`[ \t]*[:=\-–]?[ \t]*$`;
const RATE_LABEL = String.raw`(?:\bper[ \t]*(?:sqm|sq[ .]*m|m2|m²|met(?:er|re)|square[ \t\-]*(?:m|met(?:er|re)s?|f(?:ee|oo)t))|سعر[ \t]+(?:ال)?متر|للمتر|^[ \t]*(?:ال)?متر)`;
const AREA_LABEL = String.raw`(?:\b(?:area|size|plot|bua)(?:[ \t]*\([^)]*\))?|\b(?:sqm|sq[ .]*m|m2|m²)[ \t]*:|(?:ال)?مساحة)`;
const OLD_PRICE_LABEL = String.raw`(?:\bwas|\bpreviously|\bold[ \t]+price|\binstead[ \t]+of|السعر[ \t]+السابق|(?:^|[^${AR}])(?:سابقا|سابقاً|كان)|بدلا[ \t]+من|بدلاً[ \t]+من)`;
// A fee or deposit label is certain too: "Deposit 50,000", "العربون 100 ألف", "Service charge SAR 12,000".
const FEE_LABEL = String.raw`(?:\b(?:deposit|down[ \t]*payment|service[ \t]*charges?|maintenance(?:[ \t]*fees?)?|commission|fees?|booking|reservation|(?:annual|rental|rent)[ \t]+income|income)|(?:^|[^${AR}])(?:ال)?(?:عربون|دفعة[ \t]+(?:ال)?أولى|رسوم|عمولة|صيانة|حجز|دخل|عائد)(?:[ \t]+(?:ال)?سنوي)?)`;
const FEE_LABEL_BEFORE_RE = new RegExp(FEE_LABEL + LABEL_END, 'i');
const RATE_LABEL_BEFORE_RE = new RegExp(RATE_LABEL + LABEL_END, 'i');
const AREA_LABEL_BEFORE_RE = new RegExp(AREA_LABEL + LABEL_END, 'i');
const OLD_PRICE_LABEL_BEFORE_RE = new RegExp(OLD_PRICE_LABEL + LABEL_END, 'i');
// The line above (blank lines skipped) labels a figure that starts its line only when it ends in a
// colon ("Price per sqm:") or is nothing but a label ("سعر المتر"); "Villa in Al Olaya area" is not.
const LABEL_LINE_RE = new RegExp(String.raw`[:：][ \t]*$|^[^${AR}A-Za-z0-9]*(?:${RATE_LABEL}|${AREA_LABEL}|${OLD_PRICE_LABEL}|${FEE_LABEL})${LABEL_END}`, 'i');

// A currency that ends a line and does not follow a figure ("Price: AED", "Unit A12 price: AED") belongs
// to the figure that starts the next line ("450,000").
const CURRENCY_AT_LINE_END_RE = new RegExp(String.raw`(^|[\n\r\u2028\u2029])([^\n\r\u2028\u2029]*?(?<![0-9][ \t]*(?:[A-Za-z]{1,9}|مليون|ملايين|[أا]لف[اً]*)?[ \t]*)(?:${CURRENCY}))[ \t]*(?:\r\n|[\n\r\u2028\u2029])(?=[ \t]*[0-9])`, 'gi');

// A line that holds nothing but a currency belongs to the figure that ends the line above ("450,000" / "AED"),
// unless a figure also starts the line below ("Floor 3" / "AED" / "450,000"): then it cannot be told whose it is.
const EOL = String.raw`(?:\r\n|[\n\r\u2028\u2029])`;
const CURRENCY_LINE_RE = new RegExp(String.raw`([0-9])[ \t]*${EOL}[ \t]*(${CURRENCY})[ \t]*(?=$|${EOL}(?![ \t]*[0-9]))`, 'gi');
const CURRENCY_LINE_BETWEEN_FIGURES_RE = new RegExp(String.raw`[0-9][ \t]*${EOL}[ \t]*(?:${CURRENCY})[ \t]*${EOL}[ \t]*[0-9]`, 'i');

// Direction marks and the tatweel are invisible: م2 behind a right-to-left mark, or م + tatweel + 2, must read as م2.
const INVISIBLE_RE = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069\u0640]/g;

/**
 * A price the OWNER typed in the caption. Never an estimate — this only reads an
 * explicit figure. Returns null when the caption carries no number, or one that cannot
 * be read with certainty.
 */
export function parsePriceHint(caption) {
  const plain = westernise(caption || '').replace(INVISIBLE_RE, '').replace(/[\u00A0\u2007\u202F]/g, ' ');
  if (CURRENCY_LINE_BETWEEN_FIGURES_RE.test(plain)) return null;
  const text = plain.replace(CURRENCY_LINE_RE, '$1 $2').replace(CURRENCY_AT_LINE_END_RE, '$1$2 ');
  // "SAR 4,500,000" | "4.5m sar" | "٤٥٠٠٠٠٠ ريال" | "price 750000"
  let best = null;
  let guessed = 0; // the largest figure set aside on a guess
  const consider = (r) => {
    if (!best || r.amount > best.amount || (r.amount === best.amount && r.explicitCurrency && !best.explicitCurrency)) best = r;
  };
  // One line at a time: a figure, its unit and its label never reach across a line break.
  const lines = text.split(/\r\n|[\n\r\u2028\u2029]/);
  for (const [i, line] of lines.entries()) {
    // The figure just before on this line, with no currency of its own: { amount, end, reading }.
    let prev = null;
    for (const m of line.matchAll(new RegExp(PRICE_RE_SOURCE, 'dgi'))) {
      const last = prev;
      prev = null;
      const g = m.groups;
      const money = Boolean(g.pre || g.post);
      const norm = (c) => { const u = (c || '').toUpperCase(); return u === 'ر.س' || u === 'ريال' ? 'SAR' : CURRENCIES.includes(u) ? u : null; };
      const preCurrency = norm(g.pre);
      // A currency on each side ("3500 ريال 2,000,000 AED"): the one after is the figure's own.
      const currency = norm(g.post) || preCurrency;
      // The currency before may be the figure's just before, with only spaces between ("4,500,000 AED 5 bedrooms").
      const between = Boolean(preCurrency && last && !line.slice(last.end, m.index).trim());
      const handBack = () => {
        if (last.reading) Object.assign(last.reading, { currency: preCurrency, explicitCurrency: true });
        else if (last.amount >= 1000) consider({ amount: last.amount, currency: preCurrency, explicitCurrency: true });
      };
      if (g.pre && g.post && between) handBack();
      const [numStart, numEnd] = m.indices.groups.num;
      const afterNum = line.slice(numEnd);
      const tail = line.slice(m.index + m[0].length);
      if (DATE_RE.test(line.slice(numStart))) continue;

      // Unclear figures: no caption price at all.
      if (SPACED_M2_RE.test(afterNum) && !SPACED_M2_COUNT_RE.test(afterNum)) return null;
      // "4,5000" or "4500,000": the figure stops short of more digits.
      if (/^[,،٬.٫][0-9]/.test(afterNum)) return null;
      // "4,500, 000", "4,500 000", "SAR 4500 000": three more digits after a grouped figure or after money,
      // carrying no unit of their own.
      const loose = /^[,،٬]?[ \t]+[0-9]{3}(?![0-9])/.exec(afterNum);
      if ((g.sep || money) && loose && !AREA_AFTER_RE.test(afterNum.slice(loose[0].length))) return null;

      let amount = Number(g.num.replace(/[,،٬]/g, '').replace('٫', '.'));
      if (!Number.isFinite(amount)) continue;
      const mult = (g.lmult || g.amult || '').toLowerCase();
      const factor = /^(m|mn|mil|mill|mln|mill?ions?|مليون|ملايين)$/.test(mult) ? 1e6 : /^(k|ألف|الف)$/.test(mult) ? 1e3 : 1;
      const value = amount * factor;
      // Set aside on a guess: remembered, so that it can still veto a smaller price.
      const guess = () => { if (value >= (currency && !between ? 1000 : 10000)) guessed = Math.max(guessed, value); };

      // A rate, an area or metres right after a figure whose currency sits between it and the figure
      // before ("450,000 AED 450/m2", "1,250,000 USD 2,400 sqft"): the currency is the figure's before,
      // and the figure itself is set aside as a guess ("2019 SAR 4,500,000 متر" then reads no price).
      if (RATE_AFTER_RE.test(afterNum) || RATE_AFTER_RE.test(tail)) {
        if (between) { handBack(); guess(); }
        continue;
      }
      if (AREA_AFTER_RE.test(afterNum) || AREA_AFTER_RE.test(tail)) {
        if (!money) continue;
        if (between) { handBack(); guess(); continue; }
      }
      // A figure first on its line (bullets aside) takes its label from the line above, if that is a label.
      const before = line.slice(0, m.index);
      let label = before;
      if (!before.replace(/[^\p{L}\p{N}]+/gu, '')) {
        let j = i - 1;
        while (j >= 0 && !lines[j].trim()) j -= 1;
        if (j >= 0 && LABEL_LINE_RE.test(lines[j])) label = lines[j];
      }
      if (OLD_PRICE_LABEL_BEFORE_RE.test(label) || FEE_LABEL_BEFORE_RE.test(label)) continue;
      const bare = !g.lmult && !g.amult && !money;
      if (RATE_LABEL_BEFORE_RE.test(label) || (bare && AREA_LABEL_BEFORE_RE.test(label))) { guess(); continue; }
      // A phone, licence or id number: ten or more ungrouped digits, a leading 0, or a Saudi mobile without it.
      if (bare && /^[0-9]+$/.test(g.num) && (g.num.length >= 10 || /^0[0-9]/.test(g.num) || /^5[0-9]{8}$/.test(g.num))) continue;

      if (/^m$/i.test(g.lmult || '')) {
        // A bare m after a figure of 1,000 or more is metres ("Land 12,000 m").
        if (amount >= 1000) continue;
        const rest = line.slice(m.indices.groups.lmult[1]);
        const certainMetres = METRES_CERTAIN_AFTER_RE.test(rest);
        // From 100 up, "300m from the beach" is metres; below, "4.5m from the owner" may be a price.
        const guessMetres = METRES_GUESS_AFTER_RE.test(rest);
        if (money) {
          // A figure with a currency is money whatever is around it ("AED 4.5m from the developer"),
          // unless the currency is the figure's before ("850 ألف ريال 3.5m ceilings"), or comes before
          // metres that cannot be anything else ("12,000 SAR 20m street").
          if (between && (certainMetres || guessMetres)) {
            handBack();
            if (!certainMetres) guess();
            continue;
          }
          if (g.pre && !g.post && certainMetres) continue;
        } else {
          if (certainMetres || (guessMetres && amount >= 100) || METRES_CERTAIN_BEFORE_RE.test(before)) continue;
          if (guessMetres) { guess(); continue; }
          // After a street, 4.5m is a price ("Olaya Street 4.5m") but 20m may be its width: unclear.
          if (amount >= 10 && STREET_BEFORE_RE.test(before)) return null;
        }
      }
      amount = value;
      // A count the currency reached ("4,500,000 AED 5 bedrooms"): the currency is the figure's before.
      if (amount < 1000) { if (between) handBack(); if (!money) prev = { amount, end: m.index + m[0].length, reading: null }; continue; }
      // A bare number only counts as a price when it is plausibly one (>= 10,000) —
      // otherwise "3 bedrooms" would become a price. It is kept as the figure before, in case a
      // currency after it is its own ("8,500 AED 3 bedrooms").
      if (!currency && amount < 10000) { prev = { amount, end: m.index + m[0].length, reading: null }; continue; }
      const reading = { amount, currency: currency || 'SAR', explicitCurrency: Boolean(currency) };
      if (!money) prev = { amount, end: m.index + m[0].length, reading };
      consider(reading);
    }
  }
  // A figure set aside on a guess that is larger than the price read: the guess may have been wrong.
  if (best && guessed > best.amount) return null;
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
