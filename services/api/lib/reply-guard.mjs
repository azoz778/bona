/**
 * The reply guard: "never an unpublished price" in code (brain/DESIGN-brain.md §5.4). It runs
 * on the final text of a brain turn before anything is sent, on WhatsApp, email and (T28) web.
 *
 * Allowed amounts = amounts in THIS turn's tool results ∪ amounts in earlier replies this guard
 * itself passed. The caller hands those earlier replies in: on WhatsApp the `wa_outbox` rows of
 * this lead with `sender_kind='dana'`, `status='accepted'` and `guarded=1` (T12), never a team row
 * (which may carry a negotiated price), a client row, a Retell-era Dana row (`guarded=0`) or the
 * history's assistant role; email and the website chat hand in none. A client's own figure is
 * therefore never allowed back ("within your budget" instead).
 *
 * A number without a currency is an amount from 100,000 on (DESIGN §5.4) or when it shares the currency of
 * a number right next to it ("80,000 – 90,000 SAR", "SAR 90,000 or 85,000", `findAmounts`). A figure further
 * away in the sentence ("SAR 90,000 a year, or 85,000 if paid in one go") stays outside the guard, as §5.4's
 * bare-number threshold leaves it: the prompt rule ("never negotiate, discount or promise") and the eval carry it.
 *
 * Also refused: a unit reference (`B08-19`) no tool returned in this turn, and a link to a home
 * no tool returned in this turn (an earlier guarded reply allows amounts only: yesterday's link to a
 * home that is sold or removed is a hit) or on any site but Bona's (`siteUrl`: the same scheme, host
 * and port; no site URL, no home link), written with a scheme or without one
 * ("www.example.com/properties/x/"). Each hit says only its kind; the text and the amount are never
 * repeated, so a hit can be logged.
 *
 * Every check reads the reply three times (`forms`): as written; as the client sees it (`shown`: the
 * WhatsApp path's own cleanup, then WhatsApp's formatting marks gone), so "*85,000* SAR" is "85,000 SAR";
 * and that with the characters a reader does not see as such read as what they look like (minimise.mjs
 * `readable`), so "85,000<RLM> ريال", "2<thin space>950<thin space>000" and "B08<U+2011>19" are read too.
 * Tool results and earlier replies are read the same way for the amounts and unit refs they allow.
 *
 * `claimsBooking` is the booking-claim check of DESIGN §4.3's safety net, for the commit step.
 */
import { toAsciiDigits } from './inventory.mjs';
import { stripMarkers, plainText } from './actions.mjs';
import { readable } from './brain/minimise.mjs';

export const REPAIR_NOTE = "Your draft quoted an amount or unit that no tool returned in this turn. Write the reply again; quote prices only exactly as this turn's tool results give them, or say a team member will confirm.";

/** Approximate SAR rates, for comparing a reply's amount with a tool's (inventory.mjs uses the same). */
const SAR_RATE = Object.freeze({ SAR: 1, AED: 1.02, USD: 3.75, EUR: 4.05, GBP: 4.75, OMR: 9.75 });

/** "ريال", "ريالا", "ريالاً", "ريالًا" (a mark on a letter stays in every form, minimise.mjs `readable`), "ريالات". */
const RIYAL_AR = String.raw`(?:ريالات|ريال\p{M}*ا?\p{M}*)`;
/** "سعودي", "سعودية", "سعوديه", "سعودياً", "سعوديًا", "سعودى". */
const SAUDI_AR = String.raw`(?:سعود(?:ي[ةه]?|ى)\p{M}*ا?\p{M}*)`;
/**
 * A full name is one currency, tried before its first word, so the amount ends after it and the number joined to it
 * is read from there: in "90,000 ريال سعودي أو 85,000" the "أو 85,000" follows the currency, "سعودي" is not in the way.
 * "ر س" without a dot stands on its own (never the last letter of a word and a lone "س").
 */
const CURRENCIES = [
  ['SAR', String.raw`${RIYAL_AR}\s{0,2}${SAUDI_AR}|saudi\s{0,2}riyals?|sar|s\.\s?r\.?|sr|riyals?|${RIYAL_AR}|ر\.\s?س\.?|(?<![\p{L}\p{M}])ر\sس\.?|﷼`],
  ['AED', String.raw`aed|dhs|dirhams?|درهم|دراهم|د\.\s?إ\.?`],
  ['USD', String.raw`usd|us\$|\$|dollars?|دولارات|دولار`],
  ['EUR', String.raw`eur|€|euros?|يورو`],
  ['GBP', String.raw`gbp|£`],
  ['OMR', String.raw`omr|ر\.\s?ع\.?`],
];
const CUR = CURRENCIES.map(([, re]) => re).join('|');
const currencyOf = (s) => {
  if (!s) return null;
  for (const [code, re] of CURRENCIES) if (new RegExp(`^(?:${re})$`, 'iu').test(s.trim())) return code;
  return null;
};

const SCALE_WORDS = [
  [1e9, String.raw`billions?|bn|مليارات|مليار`],
  [1e6, String.raw`millions?|mln|mn|(?-i:MM)|مليونين|ملايين|مليوناً|مليونا|مليون`], // "MM" in upper case only ("10mm" is millimetres)
  [1e3, String.raw`thousands?|ألفين|الفين|آلاف|الاف|ألوف|ألفاً|ألف|الف`],
];
const SCALE = SCALE_WORDS.map(([, re]) => re).join('|');
const scaleOf = (s) => {
  for (const [mult, re] of SCALE_WORDS) if (new RegExp(`^(?:${re})$`, 'iu').test(s)) return mult;
  return 1;
};

/**
 * One number as written: digits with `,` or `.` between groups (`prepare` has turned "٬", "،" and "'"
 * into ","). Which separator is which is decided in `readNumber`, so "2,5", "2.950.000" and
 * "6,700,000.00" are each one token.
 */
const NUM = String.raw`\d+(?:[.,]\d+)*`;
/** A short scale ("1.2 م", "3.1 ملي", "3 mil", "500 K"): a scale only next to a currency; alone "م" is metres ("شارع 15م"). */
const SHORT_SCALE = String.raw`ملي|م|mil|k`;
// currency? number attached-k/m? scale-word-or-short-scale? currency?  After a colon only the two-digit minutes
// or seconds of a time ("10:30", "10:30:00") are skipped; "Price:2,950,000" and "B08-19:3,100,000" are amounts.
const AMOUNT_RE = new RegExp(
  String.raw`(?<![A-Za-z])(?<cur1>${CUR})?\s{0,2}(?<![\d.,])(?!(?<=\d:)\d{2}(?!\d|[.,]\d))(?<num>${NUM})(?![\d])(?<att>[km](?![\p{L}\d]))?` +
  String.raw`(?:\s{0,2}(?<word>${SCALE})(?![\p{L}])|\s{0,2}(?<short>${SHORT_SCALE})(?![\p{L}\d]))?(?:\s{0,2}(?<cur2>${CUR})(?![\p{L}]))?`,
  'dgiu',
);
/** A million/billion word no amount above used: "مليون", "مليونين", "a million", "بثلاثة ملايين". */
const MILLION_WORD_RE = new RegExp(String.raw`(?<![\p{L}\d])(?<pre>[وفبكل])?(?<word>مليونين|ملايين|مليون|مليارات|مليار|millions?|billions?)(?![\p{L}])`, 'dgiu');
/** A thousand word no amount above used. Alone it is an idiom ("ألف مبروك", "a thousand thanks"). */
const THOUSAND_WORD_RE = new RegExp(String.raw`(?<![\p{L}\d])(?<pre>[وفبكل])?(?<word>ألفين|الفين|آلاف|الاف|ألوف|ألف|الف|thousands?)(?![\p{L}])`, 'dgiu');
const AR_NUMBER_WORDS = String.raw`اثنين|إثنين|اثنان|ثنين|ثلاث|ثلاثة|ثلاثه|تلات|تلاتة|أربع|أربعة|أربعه|اربع|اربعة|اربعه|خمس|خمسة|خمسه|ست|ستة|سته|` +
  String.raw`سبع|سبعة|سبعه|ثمان|ثماني|ثمانية|ثمانيه|تسع|تسعة|تسعه|عشر|عشرة|عشره|عشرين|عشرون|ثلاثين|ثلاثون|أربعين|اربعين|أربعون|خمسين|خمسون|` +
  String.raw`ستين|ستون|سبعين|سبعون|ثمانين|ثمانون|تسعين|تسعون|ميتين|مئتين|مائتين|مئتي|\p{L}{0,6}(?:مية|ميه|مئة|مائة)`;
const EN_NUMBER_WORDS = String.raw`one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|` +
  String.raw`nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?`;
/** A spelled-out number right before a thousand word: "خمسمية ألف", "بمية وخمسين ألف", "five hundred thousand". */
const NUMBER_WORD_BEFORE_RE = new RegExp(String.raw`(?:^|[^\p{L}])[وفبكل]?(?:${AR_NUMBER_WORDS}|${EN_NUMBER_WORDS})[\s-]{1,3}$`, 'iu');
const CURRENCY_AFTER_RE = new RegExp(String.raw`^\s{0,2}(?:${CUR})(?![\p{L}])`, 'iu');
const DIGIT_BEFORE_RE = /\d\s{0,2}$/;
/** A half or a quarter before a scale word ("نص مليون", "بربع مليون", "half a million", "a quarter of a million"). */
const FRACTION_BEFORE_RE = /(?:^|[^\p{L}])[وفبكل]?(?:نص|نصف|ربع|ثلث|ثلاث\s?(?:أرباع|ارباع)|half|quarter|three\s+quarters)(?:[\s-]+of)?(?:[\s-]+an?)?[\s-]{1,2}$/iu;
/** "and a half" / "and a quarter" after a scale word ("مليون ونص", "مليون و نصف", "مليون إلا ربع", "a million and a half"). */
const FRACTION_AFTER_RE = /^[\s-]{0,2}(?:و|and[\s-]+(?:an?[\s-]+)?|(?:إلا|الا)\s{0,2})\s{0,2}(?:نص|نصف|ربع|half|quarter)(?![\p{L}])/iu;
/**
 * The number right after a number, joined by a dash, a slash or a word: "2 and 3 million", "2.9–3.1 million",
 * "2 إلى 3 مليون", "2 و3 ملايين", "2-3m", "500-900k", "80,000–90,000 SAR", "1.2-1.5 م ريال", "80,000 – 90,000 SAR",
 * "80,000/90,000 SAR", "SAR 90,000 or 85,000", "90,000 ريال أو 85,000".
 *   A range (`glued`: a dash glued on both sides, or `conn`: a word) shares its scale, and then its currency, when the
 *   lower bound is below the upper one: "between 2 and 3 million" is 2M and 3M, "SAR 80,000–90,000" both SAR.
 *   A spaced dash or a slash never shares a scale: "Villa 2 – 3.2 million" and "1- 2.5 مليون" are list lines.
 *   Any of them shares a currency, in either order, with a number that is money on its own (`findAmounts`).
 */
const NEXT_AFTER_RE = new RegExp(
  String.raw`^(?:(?<glued>[-–—~])|\s{0,2}[-–—~/]\s{0,2}|\s{0,2}(?<conn>to|and|or|till|until|إلى|الى|حتى|لين|لـ?|و|أو|او)\s{0,2})` +
  String.raw`(?:(?<cur1>${CUR})\s{0,2})?(?<num>${NUM})(?![\d])` +
  String.raw`(?<att>[km](?![\p{L}\d]))?(?:\s{0,2}(?<word>${SCALE})(?![\p{L}])|\s{0,2}(?<short>${SHORT_SCALE})(?![\p{L}\d]))?(?:\s{0,2}(?<cur2>${CUR})(?![\p{L}]))?`,
  'diu',
);
/** A four-digit year ("2026", Hijri "1447"), a phone or licence shape ("0500000000", nine digits or more): never money on its own. */
const notMoneyDigits = (num) => /^(?:14|19|20)\d{2}$/.test(num) || /^0\d/.test(num) || num.length >= 9;
/**
 * Money on its own, the only kind of number that takes the currency of the number next to it across a spaced dash,
 * a slash or a descending "or": thousands-grouped ("85,000", "2.950.000") or 1,000 and over at its own scale, never a
 * year or a phone shape. Areas, percents, times and metres are ruled out by the callers (`findAmounts`, `nextNumber`).
 */
const moneyOnItsOwn = (num, amount) => amount >= 1000 && !(!/[,.]/.test(num) && notMoneyDigits(num));
const AREA_AFTER_RE = /^\s{0,2}(?:m²|m2\b|sqm|sq\.?\s?m|square\s+met|sq\.?\s?ft|م²|م2|متر|مترا|أمتار|امتار)/iu;
const PERCENT_AFTER_RE = /^\s{0,2}(?:%|٪|percent|per\s?cent|بالمية|بالمئة|في\s?المية|في\s?المئة)/iu;
const URL_RE = /https?:\/\/[^\s<>"'`]+/giu;
/** A word that may be a link written without a scheme: brackets end it ("[Villa](example.com/properties/x)"). */
const WORD_RE = /[^\s<>"'`()[\]{}]+/gu;
const HOME_PATH_RE = /\/(?:ar\/)?properties\//i;
const DOT_HOST_RE = /[\p{L}\p{N}-]\.[\p{L}\p{N}]/u;
const UNIT_RE = /(?<![A-Za-z0-9])B\d{2}-\d{2}(?![0-9])/gi;
const PROPERTY_PATH_RE = /\/(?:ar\/)?properties\/([a-z0-9][a-z0-9-]*)/gi;

/**
 * The reply as the client reads it: what dana-wa's `answerFrom` makes of it (actions.mjs `stripMarkers`, then
 * `plainText` over the message: markers out, markdown flattened, spaces collapsed), then without the marks WhatsApp
 * draws as formatting (`*bold*`, `_italic_`, `~strike~`, ``` ```mono``` ```): a pair `plainText` leaves, or a mark
 * it does not know.
 */
const shown = (text) => plainText(stripMarkers(text).text).replace(/[*_~`]/g, '');
/** The three forms a check reads (a hit in any one is a hit): as written, `shown`, and `shown` of minimise.mjs `readable`. */
const forms = (text) => {
  const s = String(text ?? '');
  return [s, shown(s), shown(readable(s))];
};

/**
 * "2 950 000" (a space, NBSP or narrow NBSP between groups of three) is one number. The run is taken whole or
 * not at all; it never starts inside a word or an id ("W014 750 000", "BONA-035 750 000", "B08-19 750 000")
 * and never ends inside a comma or dot number ("Floor 2 750,000"); a decimal tail stays ("2 950 000.00").
 */
const SPACED_GROUPS_RE = /(?<![\p{L}\d.,]|\p{L}\d*-)(?=(\d{1,3}(?:[ \u00A0\u202F]\d{3})+))\1(?!\d|[.,]\d{3}(?!\d))/gu;
const joinSpacedGroups = (s) => s.replace(SPACED_GROUPS_RE, (m) => m.replace(/[ \u00A0\u202F]/g, ''));

function prepare(text) {
  const s = toAsciiDigits(String(text ?? '')).replace(URL_RE, ' ')
    .replace(/(?<=\d)،(?=\d)/g, ',') // the Arabic comma of a phone keyboard: "2،800،000", "2،5 مليون"
    .replace(/(?<=\d)['’](?=\d{3}(?!\d))/g, ','); // "3'100'000"; never feet and inches (5'11")
  return joinSpacedGroups(s);
}

/**
 * The value of one NUM token, or null when its grouping cannot be read.
 *   one separator: "5,000" (a comma before exactly 3 digits) groups thousands; "2,5", "2,95", "2.5" and
 *     "2.950" are decimals (a single dot is always the decimal point);
 *   several of one kind: thousands only ("6,700,000", "2.950.000");
 *   both kinds: the last one is the decimal point, the others group thousands ("6,700,000.00", "6.700.000,00").
 * Thousands groups are a head of 1-3 digits and then exactly 3 digits each; anything else is null.
 */
function readNumber(num) {
  const seps = num.match(/[.,]/g) ?? [];
  if (!seps.length) return Number(num);
  const groups = num.split(/[.,]/);
  const thousands = (g) => g[0].length <= 3 && g.slice(1).every((x) => x.length === 3);
  const last = seps.at(-1);
  if (seps.every((x) => x === last)) {
    if (seps.length === 1 && !(last === ',' && groups[1].length === 3)) return Number(`${groups[0]}.${groups[1]}`);
    return thousands(groups) ? Number(groups.join('')) : null;
  }
  const whole = groups.slice(0, -1);
  if (seps.slice(0, -1).some((x) => x === last) || !thousands(whole)) return null;
  return Number(`${whole.join('')}.${groups.at(-1)}`);
}

/**
 * The number right after a number (`NEXT_AFTER_RE`), read as `findAmounts` reads an amount: its value, its scale
 * ("2 and 3 million" → 1e6, "500-900k" → 1e3, "1.2-1.5 م ريال" → 1e6, else 1), its currency, where its number
 * starts in `after`, `range` (joined so that it may share its scale: a glued dash or a word) and `money` (money on
 * its own, so it may take the other number's currency); null when no number follows or it is an area ("2-3 million
 * m²"). Metres ("200-500m", "1500 م") read as scale 1 and are never money, as they are for the number itself. The
 * caller decides whether it is a range at all: a "lower bound" that is not below the upper one is not ("Villa
 * 3-2.5 million").
 */
function nextNumber(after) {
  const r = NEXT_AFTER_RE.exec(after);
  if (!r) return null;
  const { num, att: rawAtt, word, short, glued, conn } = r.groups;
  const value = readNumber(num);
  const currency = currencyOf(r.groups.cur1) ?? currencyOf(r.groups.cur2);
  // A short scale with no currency is no scale ("15-20 م"): what follows it is read from where it starts.
  const end = short && !currency ? r.indices.groups.short[0] : r[0].length;
  if (value === null || AREA_AFTER_RE.test(after.slice(end))) return null;
  const att = rawAtt?.toLowerCase();
  let scale = 1;
  if (word) scale = scaleOf(word);
  else if (short && currency) scale = short.toLowerCase() === 'k' ? 1e3 : 1e6;
  else if (att === 'k') scale = 1e3;
  else if (att === 'm' && (value < 100 || currency)) scale = 1e6;
  const metres = (att === 'm' || (short && short.toLowerCase() !== 'k')) && scale === 1;
  const money = !metres && !PERCENT_AFTER_RE.test(after.slice(r[0].length)) && moneyOnItsOwn(num, value * scale);
  return { value, scale, currency, at: r.indices.groups.num[0], range: Boolean(glued || conn), money };
}

/**
 * The money amounts in a text.
 * @returns {{ raw: number|null, sar: number|null, currency: string|null }[]}  raw = the number × its
 *   scale word in its own currency; sar = raw at the approximate rate; both null for an amount whose
 *   value cannot be read ("بثلاثة ملايين", "خمسمية ألف", "1,23,45 مليون", "+5 مليون"), which fails closed.
 */
export function findAmounts(text) {
  const s = prepare(text);
  const out = [];
  /** Where the scale words an amount used start: the word passes below skip only those. */
  const used = new Set();
  /** Where a next number starts → the currency it takes from the number before it ("SAR 80,000–90,000", "SAR 90,000 or 85,000"). */
  const shared = new Map();
  for (const m of s.matchAll(AMOUNT_RE)) {
    const { cur1, num, att, word, short, cur2 } = m.groups;
    const [numStart, numEnd] = m.indices.groups.num;
    const use = () => { if (word) used.add(m.indices.groups.word[0]); };
    const before = s[numStart - 1] ?? '';
    const head = s.slice(Math.max(0, numStart - 12), numStart);
    if (!cur1 && /[A-Za-z]/.test(before)) continue; // W012, B08, NOBAL5
    // +966…: a "+" before a phone, never one before an amount with a currency or thousands commas ("+15,000 SAR",
    // a surcharge, Codex r14).
    if (before === '+' && !cur1 && !cur2 && !shared.has(numStart) && !num.includes(',')) continue;
    if (/(?<![\d.,])[A-Za-z]\d*-$/.test(head)) continue; // BONA-014, B08-19 (never the "M" of "2.5M-3M")
    const after = s.slice(numEnd);
    if (PERCENT_AFTER_RE.test(after)) continue;
    if (AREA_AFTER_RE.test(after)) continue;
    if (/^:\d/.test(after)) continue; // 10:00
    const currency = currencyOf(cur1) ?? currencyOf(cur2) ?? shared.get(numStart) ?? null;
    if (word && !currency && AREA_AFTER_RE.test(s.slice(m.index + m[0].length))) { use(); continue; } // "85 ألف متر": an area
    if (word && FRACTION_AFTER_RE.test(s.slice(m.indices.groups.word[1]))) { // "2 مليون ونص": a value the guard cannot read
      use(); out.push({ raw: null, sar: null, currency, at: numStart }); continue;
    }
    const value = readNumber(num);
    if (value === null) {
      // A grouping that cannot be read is money of unknown value next to a currency or a scale.
      if (currency || word || att) { use(); out.push({ raw: null, sar: null, currency, at: numStart }); }
      continue;
    }
    const bare = !/[,.]/.test(num);
    // The next number is read after the whole amount: "80,000 ريال إلى 90,000", "2 million to 3 million SAR", "500k-900k SAR".
    const amountEnd = m.index + m[0].length;
    const next = nextNumber(s.slice(amountEnd));
    const up = next?.range ? next : null;
    const shortScale = short && currency ? (short.toLowerCase() === 'k' ? 1e3 : 1e6) : 0; // "1.2 م ريال"; "15 م" is metres
    let scale = word ? scaleOf(word) : shortScale || 1;
    if (att) {
      if (att.toLowerCase() === 'k') scale = 1e3;
      else if (value < 100 || currency || (up?.currency && value * 1e6 < up.value * up.scale)) scale = 1e6; // "SAR 2.5m", "200m-300m SAR"
      else continue; // "500m from the beach": metres
    }
    const ownScale = Boolean(word || att || shortScale);
    // A range only when this bound is below the upper one, both read at their scale ("2.5 million or 85,000 SAR" is none).
    const range = up && value * (ownScale ? scale : up.scale) < up.value * up.scale ? up : null;
    if (range && !ownScale) scale = range.scale; // "between 2 and 3 million": the 2 is 2,000,000
    let cur = currency ?? range?.currency ?? null; // "80,000–90,000 SAR": the 80,000 is SAR 80,000 too
    // Not a range, or across a spaced dash or a slash: the currency only (never the scale), in either order, to money on its
    // own ("80,000 – 90,000 SAR", "90,000 or 85,000 SAR"); never to "Option 1 – SAR 90,000", metres ("1500 م – SAR 90,000")
    // or the tail of a spaced digit run ("+966 50 000 1000 – SAR 90,000").
    const spacedTail = bare && /\d[ \u00A0\u202F]$/.test(s.slice(0, numStart));
    if (!cur && next?.currency && !short && !spacedTail && moneyOnItsOwn(num, value * scale)) cur = next.currency;
    if (cur && next && !next.currency && (next === range || next.money)) shared.set(amountEnd + next.at, cur); // "SAR 80,000–90,000", "SAR 90,000 or 85,000"
    if (bare && !cur && scale === 1 && (num.length >= 9 || /^0\d/.test(num))) continue; // a phone, an ID or a licence number
    if (!Number.isFinite(value) || value <= 0) { use(); continue; }
    const raw = Math.round(value * scale);
    if (!(cur || scale > 1 || raw >= 100_000)) continue;
    use();
    out.push({ raw, sar: Math.round(raw * SAR_RATE[cur ?? 'SAR']), currency: cur, at: numStart });
  }
  for (const m of s.matchAll(MILLION_WORD_RE)) {
    const [at, end] = m.indices.groups.word;
    if (used.has(at) || AREA_AFTER_RE.test(s.slice(end))) continue;
    const w = m.groups.word.toLowerCase();
    let raw = null;
    // After a digit no amount used ("+5 مليون"), a spelled-out number ("تلاتة مليون", "twenty one million"), or
    // next to a half or a quarter ("مليون ونص", "نص مليون", "half a million"), the word alone says nothing of the value.
    const lead = s.slice(Math.max(0, m.index - 24), m.index);
    const fraction = FRACTION_BEFORE_RE.test(lead) || FRACTION_AFTER_RE.test(s.slice(end));
    if (!fraction && !DIGIT_BEFORE_RE.test(s.slice(Math.max(0, m.index - 6), m.index))) {
      if (w === 'مليون' || w === 'مليونين') {
        if (!NUMBER_WORD_BEFORE_RE.test(lead)) raw = w === 'مليون' ? 1e6 : 2e6;
      } else if (w === 'million') {
        const one = /(?:^|\s)(?:a|one)\s+$/i.exec(lead);
        if (one && !NUMBER_WORD_BEFORE_RE.test(lead.slice(0, one.index + 1))) raw = 1e6;
      }
    }
    out.push({ raw, sar: raw, currency: null, at });
  }
  for (const m of s.matchAll(THOUSAND_WORD_RE)) {
    const [at, end] = m.indices.groups.word;
    const rest = s.slice(end);
    if (used.has(at) || AREA_AFTER_RE.test(rest)) continue;
    const lead = s.slice(Math.max(0, m.index - 24), m.index);
    if (NUMBER_WORD_BEFORE_RE.test(lead) || CURRENCY_AFTER_RE.test(rest) || DIGIT_BEFORE_RE.test(lead)) out.push({ raw: null, sar: null, currency: null, at });
  }
  return out.sort((a, b) => a.at - b.at).map(({ raw, sar, currency }) => ({ raw, sar, currency }));
}

/** The unit references in a text (`B08-19`), upper-case, each once, in order. */
export function unitRefs(text) {
  return [...new Set([...toAsciiDigits(String(text ?? '')).matchAll(UNIT_RE)].map((m) => m[0].toUpperCase()))];
}

const slugsIn = (url) => [...url.matchAll(PROPERTY_PATH_RE)].map((m) => m[1].toLowerCase());
/**
 * The links of a text that may lead to a home: every http(s) URL, and every word with a dot-host before a home
 * path but no scheme ("www.example.com/properties/x/", "example.com/ar/properties/x", "//evil.example/properties/x"),
 * which a WhatsApp app shows as a link all the same. `bare` says the link has no scheme of its own.
 */
function homeLinks(text) {
  const s = String(text ?? '');
  const links = [...s.matchAll(URL_RE)].map((u) => ({ link: u[0], bare: false }));
  for (const w of s.replace(URL_RE, ' ').matchAll(WORD_RE)) {
    const word = w[0].replace(/^[^\p{L}\p{N}]+/u, ''); // "*", "«", "//" before the host
    const at = word.search(HOME_PATH_RE);
    if (at > 0 && DOT_HOST_RE.test(word.slice(0, at))) links.push({ link: word, bare: true });
  }
  return links;
}
const propertySlugs = (text) => homeLinks(text).flatMap((l) => slugsIn(l.link));
/** "https://bona-real-estate.com" for any URL on it (host case and the default port do not matter), else null. */
const originOf = (url) => {
  try { return new URL(String(url)).origin; } catch { return null; }
};
/** Bona's site as `{ origin, scheme }`, or null when `siteUrl` is not an http(s) URL (then no home link passes). */
const siteOf = (siteUrl) => {
  try {
    const u = new URL(String(siteUrl));
    return /^https?:$/.test(u.protocol) ? { origin: u.origin, scheme: u.protocol } : null;
  } catch { return null; }
};

/**
 * A home link the reply may not carry: a home no tool returned, or a home's path on a host that is not
 * exactly Bona's site ("https://evil.example/properties/<a returned slug>/", a look-alike, http, a subdomain).
 * A link without a scheme is read with the site's own ("bona-real-estate.com/properties/x" is on the site,
 * "www.bona-real-estate.com/…" is a subdomain); a word that does not read as a URL is a hit (fail closed).
 */
function badHomeLink(text, slugs, site) {
  for (const { link, bare } of homeLinks(text)) {
    const found = slugsIn(link);
    if (!found.length) continue;
    if (found.some((slug) => !slugs.has(slug))) return true;
    if (!site || originOf(bare ? `${site.scheme}//${link}` : link) !== site.origin) return true;
  }
  return false;
}

/** The words of a JSON key: "cashFrom" → cash, from; "price_two_year" → price, two, year. */
const keyWords = (k) => String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** A key that names a price as the tools write them: price, price_cash, cashFrom, rent, monthly_rent, prices, amount, from. */
const PRICE_WORDS = new Set(['price', 'prices', 'cash', 'rent', 'rents', 'rental', 'amount', 'amounts', 'from']);
/** A key that names a measure or a count, never money: area_sqm, areaMin, count, beds, baths, floor, roof_sqm. */
const MEASURE_WORDS = new Set(['area', 'sqm', 'sqft', 'size', 'count', 'beds', 'bedrooms', 'baths', 'bathrooms', 'floor', 'floors', 'roof', 'rooms']);
const isPriceKey = (k) => keyWords(k).some((w) => PRICE_WORDS.has(w));
const isMeasureKey = (k) => keyWords(k).some((w) => MEASURE_WORDS.has(w));

/**
 * Every string inside a tool result (a JSON string, sometimes encoded twice, or plain text), and every number
 * that sits in a price field: its own key names a price ("price_cash", "cashFrom", "rent"), or it sits under
 * one ("price": { "cash", "twoYear" }) and its own key names no measure. An area, a count, beds or baths
 * (`area_sqm: 1250`) is never an amount a reply may quote.
 */
function leaves(result) {
  let v = result;
  for (let i = 0; i < 2 && typeof v === 'string'; i += 1) {
    try { v = JSON.parse(v); } catch { break; }
  }
  const strings = [];
  const numbers = [];
  const walk = (x, depth, key, underPrice) => {
    if (depth > 20) return;
    if (typeof x === 'string') strings.push(x);
    else if (typeof x === 'number') {
      const priced = key !== null && (isPriceKey(key) || (underPrice && !isMeasureKey(key)));
      if (priced && Number.isFinite(x) && x > 0) numbers.push(x);
    } else if (Array.isArray(x)) for (const y of x) walk(y, depth + 1, key, underPrice);
    else if (x && typeof x === 'object') {
      const priced = key !== null && isPriceKey(key);
      for (const [k, y] of Object.entries(x)) walk(y, depth + 1, k, underPrice || priced);
    }
  };
  walk(v, 0, null, false);
  return { strings, numbers };
}

/**
 * What a reply may quote: amounts (this turn's tool results and the earlier guarded replies), unit refs and
 * property slugs (this turn's tool results only). `amounts` holds keys: `sar:<SAR value>` for
 * every allowed amount, `<CUR>:<figure>` for one written with a currency, and `raw:<figure>` for every figure.
 * A figure with no currency counts as SAR, as `findAmounts` reads it; a JSON number counts only in a price
 * field (`leaves`). Amounts and unit refs are read in every form of a text (`forms`), as the reply is.
 */
export function allowedFrom({ toolResults = [], earlierReplies = [] } = {}) {
  const amounts = new Set();
  const units = new Set();
  const slugs = new Set();
  const addAmounts = (s) => {
    for (const a of findAmounts(s)) {
      if (a.raw === null) continue;
      amounts.add(`sar:${a.sar}`).add(`raw:${a.raw}`);
      if (a.currency) amounts.add(`${a.currency}:${a.raw}`);
    }
  };
  for (const r of Array.isArray(toolResults) ? toolResults : []) {
    const { strings, numbers } = leaves(r);
    for (const n of numbers) amounts.add(`sar:${Math.round(n)}`).add(`raw:${Math.round(n)}`);
    for (const s of strings) {
      for (const t of forms(s)) {
        addAmounts(t);
        for (const u of unitRefs(t)) units.add(u);
      }
      for (const slug of propertySlugs(s)) slugs.add(slug);
    }
  }
  // An earlier guarded reply allows its amounts only; units and home links come from this turn's tools (§5.4).
  for (const r of Array.isArray(earlierReplies) ? earlierReplies : []) {
    for (const t of forms(r)) addAmounts(t);
  }
  return { amounts, units, slugs };
}

/**
 * @param {unknown} text  the reply the model wrote
 * @param {{ toolResults?: string[], earlierReplies?: string[], siteUrl?: string }} [ctx]  siteUrl: Bona's site (cfg.siteUrl)
 * @returns {{ ok: boolean, hits: { kind: 'amount'|'unit'|'link' }[] }}  at most one hit per kind.
 *   An amount written with a currency passes on the same SAR value or the same figure in that currency
 *   ("$750,000" is a hit when the tool said SAR 750,000); a bare figure passes on the same figure.
 */
export function checkReply(text, ctx = {}) {
  if (typeof text !== 'string' || !text.trim()) return { ok: true, hits: [] };
  const allowed = allowedFrom(ctx ?? {});
  const hits = [];
  const allowedAmount = (a) => a.raw !== null
    && (allowed.amounts.has(`sar:${a.sar}`) || allowed.amounts.has(a.currency ? `${a.currency}:${a.raw}` : `raw:${a.raw}`));
  const site = siteOf(ctx?.siteUrl);
  const read = forms(text);
  if (read.some((t) => !findAmounts(t).every(allowedAmount))) hits.push({ kind: 'amount' });
  if (read.some((t) => unitRefs(t).some((u) => !allowed.units.has(u)))) hits.push({ kind: 'unit' });
  if (read.some((t) => badHomeLink(t, allowed.slugs, site))) hits.push({ kind: 'link' });
  return { ok: hits.length === 0, hits };
}

const BOOKING_CLAIM_RE = /(?<![\p{L}])(?:booked|confirmed)(?![\p{L}])|تم\s+(?:ال)?حجز|تم\s+تأكيد|حجزت\s+لك|تأكد\s+(?:ال)?حجز/iu;

/** A text that says a booking is made or confirmed (DESIGN §4.3: only a successful commit may say so). */
export function claimsBooking(text) {
  return typeof text === 'string' && BOOKING_CLAIM_RE.test(text);
}
