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
  // "/m" on a rent caption is per month (per square metre would be "/m2" or "/m²")
  [/(?:\bper|\/)\s*m\b(?![ \t]*[2²^]|\.[ \t]*sq)/i, 'month'],
  [/(شهري|شهريا|شهرياً|\/ ?شهر|في الشهر)/, 'month'],
];

// The caption price overrides the PDF's. The largest figure in the caption is the price, as before,
// once three kinds of figure are dealt with:
// - CERTAIN non-prices are set aside: a figure's own unit (an area, a distance, a rate per square
//   metre), a phone, licence or id number, a date, and metres that cannot be anything else ("12,000 m",
//   "30m x 40m").
// - Anything set aside because of a WORD near it is a guess: a fee, deposit, old-price, rate or area
//   label, or a street, width, height or distance word after a small bare m. A guess can be wrong
//   ("السعر بدون عمولة 4,500,000" is a price, "4.5m Street-facing" too), so if a figure set aside on a
//   guess would be larger than the price finally read, the caption gives no price: a guess can lose a
//   price but never hand its slot to a smaller figure.
// - An UNCLEAR caption gives no price at all: "450 m 2", "4,500, 000", "SAR 4500 000", a street then
//   20m, a currency-only line between two figures.
// Whenever the caption gives no price, the PDF's own price stands; the bot's reply shows the owner
// what was published.
const AR = String.raw`\u0621-\u064A`; // Arabic letters (tanween and other marks are outside it)
const EOL = String.raw`\n`; // every line break is a \n by the time these run (see parsePriceHint)

// Whole words only: "European" is no EUR.
const CURRENCY = String.raw`(?:SAR|AED|EUR|USD|OMR)(?![A-Za-z])|ر\.س|ريال(?:اً|ا)?(?![${AR}])`;

// One figure. Thousands groups are exactly three digits with ONE separator throughout ("4,500,000",
// Arabic "4٬500٬000"), so "4,500,000 4 bedrooms" ends where the price ends. A space never groups
// thousands: it joined phone numbers ("555 226 302") and unit counts into prices. Then an optional
// decimal part ("4.5", Arabic "4٫5").
const FIGURE = String.raw`[0-9]{1,3}(?<sep>[,،٬])[0-9]{3}(?:\k<sep>[0-9]{3})*(?:[.٫][0-9]+)?(?![0-9])|[0-9]+(?:[.٫][0-9]+)?`;

// A Latin multiplier is a whole word (not the m of "10 mins" or "m²", not the k of "15 km"). An Arabic
// one takes its usual endings ("ألفاً") but no further letter, so "الف" in "الفلل" is not one.
const MULTIPLIER = String.raw`(?<lmult>mill?ions?|mill|mln|mil|mn|m|k)(?=$|[^A-Za-z0-9²³${AR}]|${CURRENCY})|(?<amult>مليون|ملايين|[أا]لف)(?:اً|ًا|ا|ً)?(?![${AR}])`;

// A currency between two figures ("Floor 12 AED 2,000,000", "Built 2019 SAR 4,500,000") belongs to the
// figure after it, so a currency after a figure is its own only when no figure follows, or when it is
// written onto the figure ("450,000AED 5 bedrooms").
const PRICE_RE_SOURCE = String.raw`(?:^|[\s(~≈])(?:(?<pre>${CURRENCY})[ \t]*)?(?<num>${FIGURE})(?:[ \t]*(?:${MULTIPLIER}))?(?:(?<post>${CURRENCY})|[ \t]+(?<spacedPost>${CURRENCY})(?![ \t]*[0-9]))?`;

// After a bare m with no currency after it: the first side of a size ("30m x 40m") is metres for
// certain. A street, a width, a height or a distance word only suggests metres ("4.5m Street-facing
// villa" is a price), so below 100 it is a guess; from 100 up ("300m from the beach") it is certain.
const METRES_CERTAIN_AFTER_RE = /^[ \t]*[x×*](?=[ \t]*[0-9.]+[ \t]*m\b)/i;
const METRES_WORD_AFTER_RE = new RegExp(String.raw`^(?:-|[ \t]*)(?:(?:by|and|&)(?=[ \t]*[0-9.]+[ \t]*m\b)|streets?\b|st\b|roads?\b|rd\b|wide\b|width\b|ceilings?\b|height\b|frontage\b|from\b|away\b|walk|high\b|tall\b|deep\b|depth\b|long\b|length\b|شارع|طريق|سقف|ارتفاع)`, 'i');
// Before a bare m: the second side of a size ("30m x 40m") is certain. A dimension label right before
// it ("Height 3m", "Frontage 25m", "ارتفاع السقف 3m") or the second of two widths ("20m and 15m",
// "25m by 40m") is a guess ("sea frontage 3.2m" may be a price).
const METRES_CERTAIN_BEFORE_RE = /[0-9][ \t]*m?[ \t]*[x×*][ \t]*$/i;
const METRES_WORD_BEFORE_RE = new RegExp(String.raw`[0-9][ \t]*m[ \t]*(?:by|and|&|و)[ \t]*$|(?:\b(?:frontage|width|height|depth|length|ceilings?(?:[ \t]+height)?)|عرض[ \t]+(?:ال)?شارع|ارتفاع(?:[ \t]+(?:ال)?سقف)?|(?:ال)?سقف|(?:ال)?واجهة)[ \t:]*$`, 'i');
const STREET_BEFORE_RE = new RegExp(String.raw`(?:\b(?:streets?|st\.?|roads?|rd\.?)|شارع|طريق)[ \t:]*$`, 'i');

// A unit right after a figure with no currency makes it an area ("12,000 sqm", "450m2", "12000 م2")
// or a distance ("15,000 km"). "/m2" or "per sqm" after any figure makes it a rate per square metre,
// unless a number follows the unit ("per sqm 7,200" labels the 7,200).
const AREA_UNIT = String.raw`(?:bua\b|gfa\b|m2(?![0-9])|m[ \t]*²|m[ \t]*\^[ \t]*2(?![0-9])|met(?:er|re)s?2(?![0-9])|sqm|sqft|sq[ .\-]*(?:m|mt|mtr|met(?:er|re)s?|ft|feet|foot|yds?|yards?)\b|square[ \-]*(?:m|met(?:er|re)s?|f(?:ee|oo)t|yards?)\b|ft2(?![0-9])|ft[ \t]*²|m\.?[ \t]*sq\b|met(?:er|re)s?\b|(?:ال)?(?:متر|أمتار|امتار)[ \t]*مربع|(?:ال)?(?:متر|مترا|أمتار|امتار)(?![${AR}])|م[ \t]*[2²](?![0-9])|م(?![${AR}]))`;
const DISTANCE_UNIT = String.raw`(?:kms?|kilomet(?:er|re)s?|كم|كيلو)(?![A-Za-z${AR}])`;
const AREA_AFTER_RE = new RegExp(String.raw`^[ \t]*(?:\([ \t]*)?(?:${AREA_UNIT}|${DISTANCE_UNIT})`, 'i');
// ...unless the unit labels the next figure: "4,500,000 (sqm: 450)", "1.85M (sqm price AED 4,500)",
// "3 مليون (المتر 1500 ريال)", "12,000 sqm: ...", "السعر 900,000 المتر 1500 ريال" (a rate: money follows).
const AREA_LABEL_AFTER_RE = new RegExp(String.raw`^[ \t]*(?:\([ \t]*(?:${AREA_UNIT}|${DISTANCE_UNIT})[^)\n]{0,30}?[0-9]|(?:${AREA_UNIT}|${DISTANCE_UNIT})[ \t]*[:=：]|(?:${AREA_UNIT})[ \t]*(?:(?:${CURRENCY})[ \t]*[0-9]|[0-9][0-9,.٬٫]*[ \t]*(?:${CURRENCY})))`, 'i');
const RATE_AFTER_RE = new RegExp(String.raw`^[ \t]*(?:\([ \t]*)?(?:\/|per\b|لكل|لل)[ \t]*(?=(?<rateUnit>${AREA_UNIT}|m\b|ft\b))\k<rateUnit>(?![ \t]*[:=：]?[ \t]*(?:(?:${CURRENCY})[ \t]*)?[0-9])`, 'i');
// "/m" or "per m" on its own may be per month: in a rent caption it is ("Rent AED 12,000 / m"), elsewhere
// it is only a guess.
const RENT_RE = new RegExp(String.raw`\b(?:rent|rental|lease|leasing)\b|(?:ال|لل)?[إا]يجار`, 'i');
const RATE_PER_M_RE = /^[ \t]*(?:\([ \t]*)?(?:\/|per\b)[ \t]*m\b(?![ \t]*[2²^]|\.[ \t]*sq)/i;
// "450 m 2" or "4.5m 2 floors": a square metre, or 4.5 million and two of something. Unclear, unless
// what follows is a count ("1.2M 2 bedrooms" is 1.2 million).
const SPACED_M2_RE = /^[ \t]*m[ \t]+2(?![0-9])/i;
const SPACED_M2_COUNT_RE = /^[ \t]*m[ \t]+2[ \t]*(?:bed|br\b|bath|room|floor|stor|unit|park|payment|instal|villa|apartment|غرف|دور|أدوار|ادوار|حمام|دورات|دفع|شقق|شقة|موقف)/i;
// A date ("30.06.2027", "2027-06-30", "30/6/2027") is no figure at all.
const DATE_RE = /^[0-9]{1,4}[./\-][0-9]{1,2}[./\-][0-9]{1,4}(?![0-9])/;

// Labels just before a figure, all guesses: an old price ("was", "السعر السابق"), a fee or deposit
// ("Deposit 50,000", "العربون 100 ألف"; not after "without", "incl.", "بدون", "شامل"), a rate per
// square metre ("price per sqm", "سعر المتر") on any figure, an area ("Area:", "plot", "المساحة") on a
// bare one.
const LABEL_END = String.raw`[ \t]*[:：=\-–]?[ \t]*$`;
const RATE_LABEL = String.raw`(?:\bper[ \t]*(?:sqm|sq[ .]*m|m2|m²|met(?:er|re)|square[ \t\-]*(?:m|met(?:er|re)s?|f(?:ee|oo)t))|سعر[ \t]+(?:ال)?متر|للمتر|^[ \t]*(?:ال)?متر)`;
const AREA_LABEL = String.raw`(?:\b(?:area|size|plot|bua)(?:[ \t]*\([^)]*\))?|\b(?:sqm|sq[ .]*m|m2|m²)[ \t]*:|(?:ال)?مساحة)`;
const OLD_PRICE_LABEL = String.raw`(?:\bwas|\bpreviously|\bold[ \t]+price|\binstead[ \t]+of|السعر[ \t]+السابق|(?:^|[^${AR}])(?:سابقا|سابقاً|كان)|بدلا[ \t]+من|بدلاً[ \t]+من)`;
const FEE_LABEL = String.raw`(?:\b(?:deposit|down[ \t]*payment|(?:monthly[ \t]+|annual[ \t]+|yearly[ \t]+)?instal(?:l)?ments?|service[ \t]*charges?|maintenance(?:[ \t]*fees?)?|commission|(?:booking|reservation|agency|brokerage|registration)(?:[ \t]*fees?)?|(?:annual|rental|rent)[ \t]+income|income)|(?:^|[^${AR}])(?:ال)?(?:عربون|قسط(?:[ \t]+(?:ال)?شهري)?|دفعة[ \t]+(?:ال)?أولى|رسوم[ \t]+(?:ال)?(?:خدمة|خدمات|صيانة|حجز|تسجيل)|عمولة|صيانة|حجز|دخل|عائد)(?:[ \t]+(?:ال)?سنوي)?)`;
const FEE_LABEL_BEFORE_RE = new RegExp(FEE_LABEL + LABEL_END, 'i');
const FEE_NEGATED_RE = new RegExp(String.raw`(?:\b(?:without|no|zero|free|incl\.?|including|inclusive|excl\.?|excluding|plus)\b|بدون|بلا|شامل|شاملة|غير|مع|(?:^|[^${AR}])لا(?![${AR}]))[^0-9\n]{0,30}$`, 'i');
const RATE_LABEL_BEFORE_RE = new RegExp(RATE_LABEL + LABEL_END, 'i');
const AREA_LABEL_BEFORE_RE = new RegExp(AREA_LABEL + LABEL_END, 'i');
const OLD_PRICE_LABEL_BEFORE_RE = new RegExp(OLD_PRICE_LABEL + LABEL_END, 'i');
// The line above (blank lines skipped) labels a figure that starts its line only when it ends in a
// colon ("Price per sqm:") or is nothing but a label ("سعر المتر"); "Villa in Al Olaya area" is not.
const LABEL_LINE_RE = new RegExp(String.raw`[:：][ \t]*$|^[^${AR}A-Za-z0-9]*(?:(?:price|asking|السعر|سعر)[ \t]+)?(?:${RATE_LABEL}|${AREA_LABEL}|${OLD_PRICE_LABEL}|${FEE_LABEL})${LABEL_END}`, 'i');

// A currency that ends a line and does not follow a figure ("Price: AED", "Unit A12 price: AED") belongs
// to the figure that starts the next line ("450,000").
const CURRENCY_AT_LINE_END_RE = new RegExp(String.raw`(^|[\n\r\u2028\u2029])([^\n\r\u2028\u2029]*?(?<![0-9][ \t]*(?:mill?ions?|mill|mln|mil|mn|m|k|مليون|ملايين|[أا]لف[اً]*)?[ \t]*)(?:${CURRENCY}))[ \t]*(?:${EOL}[ \t]*)+(?=[0-9])`, 'gi');

// A line that holds nothing but a currency belongs to the figure that ends the line above ("450,000" / "AED"),
// unless a figure also starts the line below ("Floor 3" / "AED" / "450,000"): then it cannot be told whose it is.
const FIGURE_END = String.raw`[0-9](?:[ \t]*(?:mill?ions?|mill|mln|mil|mn|m|k|مليون|ملايين|[أا]لف(?:اً|ًا|ا|ً)?)(?![A-Za-z${AR}]))?`;
const CURRENCY_LINE_RE = new RegExp(String.raw`(${FIGURE_END})[ \t]*(?:${EOL}[ \t]*)+(${CURRENCY})[ \t]*(?=$|${EOL})(?![ \t]*(?:${EOL}[ \t]*)*[0-9])`, 'gi');
const CURRENCY_LINE_BETWEEN_FIGURES_RE = new RegExp(String.raw`${FIGURE_END}[ \t]*(?:${EOL}[ \t]*)+(?:${CURRENCY})[ \t]*(?:${EOL}[ \t]*)+[0-9]`, 'i');

// Two or more currencies in one caption ("SAR 6,200,000 (EUR 1,519,000)", "4.5M AED, instalment 15,000
// SAR"): only a figure with its own written currency counts; the largest of those is the price.
const ANY_CURRENCY_RE = new RegExp(String.raw`(?:(?<![A-Za-z${AR}])|(?<=[0-9](?:mill?ions?|mill|mln|mil|mn|m|k)))(${CURRENCY})`, 'gi');
const normCurrency = (c) => { const u = (c || '').toUpperCase(); return u === 'ر.س' || u.startsWith('ريال') ? 'SAR' : CURRENCIES.includes(u) ? u : null; };

// Direction marks and the tatweel are invisible: م2 behind a right-to-left mark, or م + tatweel + 2, must read as م2.
const INVISIBLE_RE = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069\u0640]/g;

/**
 * A price the OWNER typed in the caption. Never an estimate — this only reads an
 * explicit figure. Returns null when the caption carries no number, or one that cannot
 * be read with certainty.
 */
export function parsePriceHint(caption) {
  // One kind of line break (a \r\n read as one or two breaks made the joins below backtrack exponentially),
  // one space for any run of spaces.
  const plain = westernise(caption || '').replace(INVISIBLE_RE, '').replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/[\u00A0\u2007\u202F]/g, ' ').replace(/[ \t]+/g, ' ');
  if (CURRENCY_LINE_BETWEEN_FIGURES_RE.test(plain)) return null;
  const currencies = new Set([...plain.matchAll(ANY_CURRENCY_RE)].map((c) => normCurrency(c[1])));
  const text = plain.replace(CURRENCY_LINE_RE, '$1 $2').replace(CURRENCY_AT_LINE_END_RE, '$1$2 ');
  // "SAR 4,500,000" | "4.5m sar" | "٤٥٠٠٠٠٠ ريال" | "price 750000"
  const readings = []; // currencies can still move between readings until every line is read
  let guessed = 0; // the largest figure set aside on a guess
  let conflict = false; // one figure claimed by two different currencies it holds firmly
  const consider = (r) => { readings.push(r); };
  // One line at a time: a figure, its unit and its label never reach across a line break.
  const rent = RENT_RE.test(text);
  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    // The figure just before on this line, with no currency of its own: { amount, end, reading }.
    let prev = null;
    let prevEnd = null; // where the figure just before ended, whatever became of it
    for (const m of line.matchAll(new RegExp(PRICE_RE_SOURCE, 'dgi'))) {
      const last = prev;
      prev = null;
      const lastEnd = prevEnd;
      prevEnd = m.index + m[0].length;
      const g = m.groups;
      const post = g.post || g.spacedPost;
      const preCurrency = normCurrency(g.pre);
      // A currency before the figure that sits right after another figure may be that one's ("3500 ريال
      // 2,000,000 AED", "12,000 SAR 20m street").
      const borrowed = Boolean(g.pre) && lastEnd !== null && !line.slice(lastEnd, m.indices.groups.pre[0]).trim();
      // A currency on each side: the one before is the figure's own ("AED 450,000 EUR equivalent: 115,000"),
      // unless it may be borrowed; then the one after is.
      let currency = (preCurrency && !borrowed ? preCurrency : normCurrency(post)) || preCurrency;
      let money = Boolean(g.pre || post);
      // The currency before may be the figure's just before, with only spaces between ("4,500,000 AED 5 bedrooms").
      const between = Boolean(preCurrency && last && !line.slice(last.end, m.indices.groups.pre[0]).trim());
      let handed = false;
      // force: the figure after is an area, a rate or metres, so the currency is surely the one before's,
      // even over a currency that figure took from its left ("2,500,000 AED 2,553,000 SAR 450 sqm").
      const handBack = (force = false) => {
        if (handed) return;
        handed = true;
        const r = last.reading;
        // A currency the figure holds firmly (written after it, or before it and not borrowed) is never replaced:
        // a different one arriving means the caption cannot be read ("SAR 4,500,000 AED 4,400,000").
        if (r && r.firm && r.currency !== preCurrency) conflict = true;
        else if (r) { if (force || !r.explicitCurrency || !r.firm) Object.assign(r, { currency: preCurrency, explicitCurrency: true, firm: true }); }
        else if (last.amount >= 1000) consider({ amount: last.amount, currency: preCurrency, explicitCurrency: true, firm: true });
      };
      if (g.pre && post && between) handBack();
      const [numStart, numEnd] = m.indices.groups.num;
      const afterNum = line.slice(numEnd);
      const tail = line.slice(m.index + m[0].length);
      // A date is no figure; a currency it reached is the figure's before ("450,000 AED 2027-06-30 handover").
      if (DATE_RE.test(line.slice(numStart))) { if (between) handBack(); continue; }

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
      const value = Math.round(amount * factor * 1000) / 1000;
      // Set aside on a guess: remembered, so that it can still veto a smaller price.
      const guess = () => { if (value >= (currency && !between ? 1000 : 10000)) guessed = Math.max(guessed, value); };

      // A rate, an area or metres right after a figure whose currency sits between it and the figure
      // before ("450,000 AED 450/m2", "1,250,000 USD 2,400 sqft"): the currency is the figure's before,
      // and the figure itself is set aside as a guess ("2019 SAR 4,500,000 متر" then reads no price).
      const perM = RATE_PER_M_RE.test(afterNum) || RATE_PER_M_RE.test(tail);
      if ((RATE_AFTER_RE.test(afterNum) || RATE_AFTER_RE.test(tail)) && !(perM && rent)) {
        if (between) handBack(true);
        if (between || perM) guess();
        continue;
      }
      const unitLabelsNext = AREA_LABEL_AFTER_RE.test(afterNum) || AREA_LABEL_AFTER_RE.test(tail);
      if ((AREA_AFTER_RE.test(afterNum) || AREA_AFTER_RE.test(tail)) && !unitLabelsNext) {
        // A unit that starts right at the figure ("450 m ^ 2", "12,000 sqm") makes it an area; one after a
        // multiplier ("Land 1.2m sqm") is unusual enough to be a guess.
        if (!money && (AREA_AFTER_RE.test(afterNum) || (!g.lmult && !g.amult))) continue;
        // Money with an area unit ("SAR 4,500,000 sqm 450", "EUR 1,500 sqft"): its currency is the figure's
        // before if there is one; either way the figure is set aside as a guess.
        if (between) handBack(true);
        guess();
        continue;
      }
      // A figure first on its line (bullets aside) takes its label from the line above, if that is a label.
      const before = line.slice(0, m.index).slice(-100);
      let label = before;
      if (!before.replace(/[^\p{L}\p{N}]+/gu, '')) {
        let j = i - 1;
        while (j >= 0 && !lines[j].trim()) j -= 1;
        if (j >= 0 && LABEL_LINE_RE.test(lines[j].slice(-100))) label = lines[j].slice(-100);
      }
      const bare = !g.lmult && !g.amult && !money;
      const fee = FEE_LABEL_BEFORE_RE.test(label) && !FEE_NEGATED_RE.test(label);
      if (fee || OLD_PRICE_LABEL_BEFORE_RE.test(label) || RATE_LABEL_BEFORE_RE.test(label) || (bare && AREA_LABEL_BEFORE_RE.test(label))) {
        guess();
        continue;
      }
      // A phone, licence or id number: ten or more ungrouped digits, a leading 0, or a Saudi mobile without it.
      if (bare && /^[0-9]+$/.test(g.num) && (g.num.length >= 10 || /^0[0-9]/.test(g.num) || /^5[0-9]{8}$/.test(g.num))) continue;

      if (/^m$/i.test(g.lmult || '')) {
        // A bare m after a figure of 1,000 or more is metres ("Land 12,000 m").
        if (amount >= 1000) { if (between) handBack(true); continue; }
        // A currency after the m makes it money ("4.5m SAR from the developer"); otherwise metres may be meant.
        if (!post) {
          const rest = line.slice(m.indices.groups.lmult[1]);
          const certainMetres = METRES_CERTAIN_AFTER_RE.test(rest) || (!money && METRES_CERTAIN_BEFORE_RE.test(before));
          const wordMetres = METRES_WORD_AFTER_RE.test(rest) || (!money && METRES_WORD_BEFORE_RE.test(before));
          // A currency written before the figure makes it money ("SAR 150m high yield", "AED 4.5m from the
          // developer"), unless that currency sits right after another figure and may be its own ("12,000 SAR
          // 20m street"): then the metre word is a guess.
          if (certainMetres || (wordMetres && amount >= 100 && !money)) { if (between) handBack(true); continue; }
          if (wordMetres && (!money || borrowed)) { if (between) handBack(true); guess(); continue; }
          // After a street, 4.5m is a price ("Olaya Street 4.5m") but 20m may be its width: unclear.
          if (!money && amount >= 10 && STREET_BEFORE_RE.test(before)) return null;
        }
      }
      // A currency between two figures where the second is a small detail (under 10,000: "1,250,000 AED 2027
      // handover") is the first's: the price comes first, its details after. A larger second figure may be
      // money itself ("2.4 million USD 654,000 approx."), so the currency stays with it. (An area, rate or metres
      // after it was dealt with above.)
      if (between && !post && value >= 1000 && value < 10000 && value < last.amount) {
        handBack();
        currency = null;
        money = false;
      }
      amount = value;
      // A count the currency reached ("4,500,000 AED 5 bedrooms"): the currency is the figure's before.
      if (amount < 1000) { if (between) handBack(true); if (!money) prev = { amount, end: m.index + m[0].length, reading: null }; continue; }
      // A bare number only counts as a price when it is plausibly one (>= 10,000) —
      // otherwise "3 bedrooms" would become a price. It is kept as the figure before, in case a
      // currency after it is its own ("8,500 AED 3 bedrooms").
      if (!currency && amount < 10000) { prev = { amount, end: m.index + m[0].length, reading: null }; continue; }
      const reading = { amount, currency: currency || 'SAR', explicitCurrency: Boolean(currency), firm: Boolean(post) || (Boolean(g.pre) && !borrowed) };
      // A figure whose only currency came from its left may still take the one after it (see handBack).
      if (!post) prev = { amount, end: m.index + m[0].length, reading };
      consider(reading);
    }
  }
  let pool = readings;
  let unsure = 0; // several currencies: a figure without its own cannot be told apart, so it can only veto
  if (currencies.size > 1) {
    for (const r of readings) if (!r.explicitCurrency) unsure = Math.max(unsure, r.amount);
    pool = pool.filter((r) => r.explicitCurrency);
  }
  let best = null;
  for (const r of pool) {
    if (!best || r.amount > best.amount || (r.amount === best.amount && r.explicitCurrency && !best.explicitCurrency)) best = r;
  }
  // A figure set aside on a guess that is larger than the price read: the guess may have been wrong.
  if (conflict || (best && (guessed > best.amount || unsure > best.amount))) return null;
  return best && { amount: best.amount, currency: best.currency, explicitCurrency: best.explicitCurrency };
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
