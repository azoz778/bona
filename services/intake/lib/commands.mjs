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
// is nothing but a price. That is one figure ("4.5m", "SAR 4,500,000", "٤٫٥ مليون ريال سعودي"), with its
// multiplier and currency, and words from a short list:
// - price words (price, asking, السعر, المطلوب);
// - rent or sale (#rent, للبيع, إيجار);
// - a period (per year, شهرياً);
// - only, negotiable.
// Any other word (a place, a feature, a label such as "Deposit" or "Area", a unit such as "m2"),
// a second figure, two currencies or one the site does not price in, and the caption sets no price.
// Then the PDF's own price stands, the bot's reply shows what was published, and `price <id> …` sets
// a price by hand. (Readers that picked a figure out of free text kept misreading captions through
// twelve review rounds; the owner's captions so far carry no price at all.)
const AR = String.raw`\u0621-\u064A`; // Arabic letters (tanween and other marks are outside it)
// The currencies the site prices in, as codes, symbols and words. A riyal, a dirham or a dollar with no
// country ("ريال", "riyals", "درهم", "Dhs", "$", "dollars") may be Saudi or Omani, Emirati or Moroccan, US or
// Canadian: no caption price (the PDF's stands; `price <id> 4.5m` keeps the listing's own currency).
const CURRENCY_WORDS = [
  ['OMR', String.raw`OMR|RO|ر\.ع|(?:بال|ال)?ريال(?:ا)? (?:ال)?عماني|omani (?:riyals?|rials?)`],
  ['SAR', String.raw`SAR|SR|saudi (?:riyals?|rials?)|ر\.س|(?:بال|ال)?ريال(?:ا)? (?:ال)?سعودي`],
  ['AED', String.raw`AED|د\.إ|(?:uae|emirati) dirhams?|(?:بال|ال)?درهم(?:ا)? (?:ال)?إماراتي`],
  ['USD', String.raw`USD|US ?\$|us dollars?|(?:بال|ال)?دولار(?:ا)? (?:ال)?[أا]م(?:ريكي|يركي)(?:ا)?`],
  ['EUR', String.raw`EUR|€|euros?|(?:بال|ال)?يورو`],
  // Last, so "ريال سعودي" and "درهم إماراتي" are read whole first.
  ['?', String.raw`riyals?|rials?|(?:بال|ال)?ريال(?:ا)?|dhs?|dirhams?|(?:بال|ال)?درهم(?:ا)?|\$|dollars?|(?:بال|ال)?دولار(?:ا)?`],
  // (US$, $ and € are also matched as bare symbols, see CURRENCY_TOKEN_RE)
];
// A currency token: a whole word, so "European" is no EUR; a symbol stands anywhere ("Price$450,000").
const tokenRe = (body) => String.raw`(?<![A-Za-z${AR}])(?:${body})(?![A-Za-z${AR}])`;
const CURRENCY_SYMBOL = String.raw`US ?\$|\$|€`;
const CURRENCY_WHOLE = CURRENCY_WORDS.map(([code, re]) => [code, new RegExp(String.raw`^(?:${re})$`, 'i')]);
const CURRENCY_TOKEN_RE = new RegExp(String.raw`${CURRENCY_SYMBOL}|` + CURRENCY_WORDS.map(([, re]) => tokenRe(re)).join('|'), 'gi');
// A figure glued to a mark or a sign ("4.500.000" read from its end, "-450,000"), or a sign before its currency
// ("-SAR 50,000", "-US dollars 450,000", "-ر.س 450,000"): no price. Built from every currency token above.
const SIGN_BEFORE_RE = new RegExp(String.raw`[.٫,،٬]$|(?:^|[^A-Za-z${AR}])[+\-−–]$|(?:^|[^A-Za-z${AR}0-9])[+\-−–] ?(?:${CURRENCY_TOKEN_RE.source}) ?$`, 'i');
// The words a price-only caption may hold besides the figure, its multiplier and its currency.
const ALLOWED_WORD_RE = new RegExp(tokenRe(String.raw`price|prices|asking|for|sale|rent|rental|of|at|a month|a year|per|year|years|yearly|yr|annum|annually|month|monthly|mo|only|final|firm|negotiable|السعر|سعر|بسعر|المطلوب|هو|ب|للبيع|للإيجار|للايجار|إيجار|ايجار|الإيجار|الايجار|في|سنة|السنة|سنوي|سنويا|سنوية|شهر|الشهر|شهري|شهريا|شهرية|فقط|نهائي|قابل|للتفاوض`), 'gi');
// Every run of digits, with the separators that join it, is one figure.
const DIGIT_RUN_RE = /[0-9]+(?:[,،٬.٫][0-9]+)*/g;
// A figure written as a price: thousands in groups of three with one separator, or no separator; a
// decimal part. "4,5000", "4.500.000", ".5" and "-450,000" are not read.
// A grouped figure starts with 1-9: "0,850" is a decimal comma (€0.85m), not 850 thousand.
const FIGURE_RE = /^(?:[1-9][0-9]{0,2}([,،٬])[0-9]{3}(?:\1[0-9]{3})*|[0-9]+)(?:[.٫][0-9]+)?$/;
// A multiplier right after the figure ("4.5m", "1.2 million", "850k", "٤٫٥ مليون", "٨٥٠ ألف"); not "mil",
// a thousand in Spanish and Portuguese ("€450 mil").
const MULTIPLIER_RE = new RegExp(String.raw`^ ?(?:(?<lmult>millions?|mln|mn|m|thousands?|k)|(?<amult>مليون|ملايين|ألف|الف)(?:ا)?)(?:(?![A-Za-z0-9${AR}])|(?=(?:SAR|AED|USD|EUR|OMR|SR|RO|DHS?)(?![A-Za-z])|[$€]))`, 'i');
// What may be left once the figure, its multiplier, its currency and the allowed words are taken out:
// white space and ordinary punctuation. Any other letter (in any script), symbol or emoji ("฿", "📏")
// means the caption says more than a price.
// Not "~" (WhatsApp strikethrough, or "about"), "≈" or "+" ("4.5m+"): those qualify the figure; nor
// "?" or "؟": a question ("Is rent €4,500 a month?") states no price; nor "-" or "–", which may be a minus
// sign wherever it stands ("(- 4,500)", "AED-450,000"), nor the em dash "—" ("(— 4,500)").
const LEFTOVER_OK_RE = /^[\s.,،;؛:!()[\]{}"'`«»“”‘’_/\\|*•·…=&]*$/;
// A period ("per year", "شهرياً") makes the figure a rent; on a caption with no rent word it is an
// instalment or an income ("3,500 ريال شهرياً فقط", "Net SAR 450,000 per year"), not the price.
const PERIOD_WORD_RE = new RegExp(tokenRe(String.raw`per|year|years|yearly|yr|annum|annually|month|monthly|mo|سنة|السنة|سنوي|سنويا|سنوية|شهر|الشهر|شهري|شهريا|شهرية`), 'i');
const MONTH_WORD_RE = new RegExp(tokenRe(String.raw`month|monthly|mo|شهر|الشهر|شهري|شهريا|شهرية`), 'i');
const YEAR_WORD_RE = new RegExp(tokenRe(String.raw`year|years|yearly|yr|annum|annually|سنة|السنة|سنوي|سنويا|سنوية`), 'i');
const RENT_WORD_RE = new RegExp(String.raw`(?<![A-Za-z])(?:rent|rental|lease|for-?rent)(?![A-Za-z])|(?:لل|ال)?[إا]يجار`, 'i');
const SALE_WORD_RE = new RegExp(String.raw`(?<![A-Za-z])(?:sale|for-?sale|buy)(?![A-Za-z])|للبيع|(?<![${AR}])بيع(?![${AR}])`, 'i');
// Dollars of other countries ("A$ 1.2m", "AUS$", "HK$"): letters on a "$" are US, or an allowed word
// of three letters or more ("Price$450,000"); anything else is no caption price.
const ALLOWED_WHOLE_RE = new RegExp(String.raw`^(?:${ALLOWED_WORD_RE.source})$`, 'i');
// (Anchored at the start of the letter run: from every letter it would rescan the run, in square time.)
// A letter right after the "$" ("$A1.2m") is another dollar too.
const otherDollar = (text) => /\$[A-Za-z]/.test(text) || [...text.matchAll(/(?<![A-Za-z])([A-Za-z]+)\$/g)]
  .some(([, w]) => !/^us$/i.test(w) && !(w.length >= 3 && ALLOWED_WHOLE_RE.test(w)));
const FLAG_TAG_RE = /#(?:test|dry|draft|brochure|pdf|nobrochure|nopdf|no-brochure|no-pdf|hidden|private|rent|rental|forrent|for-rent|sale|forsale|for-sale|buy|offplan|off-plan|international|overseas)(?![A-Za-z0-9_-])/gi;
// Direction marks, the tatweel ("بـ" is "ب") and the tanween of "شهرياً" are invisible. Any other vowel
// mark stays, and so is no price: it can make one word another ("بِيعَ", was sold, is not "بيع").
const INVISIBLE_RE = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069\u0640\u064B]/g;

/**
 * A price the OWNER typed in the caption. Never an estimate — this only reads an explicit
 * figure. Returns null unless the caption is nothing but that price (see above).
 */
export function parsePriceHint(caption, { command = false } = {}) {
  // Fullwidth characters ("４．５m") become their ASCII forms; any other non-ASCII digit, a superscript
  // or a footnote mark ("450000¹") included, is not ours to read. All white space, line breaks included,
  // is one space. The bot's flags and categories ("#test", "#rent") are read by parseCaption and are not
  // words here, nor is a hashtag holding a digit ("#250000", "#2BR"); any other hashtag is its word
  // ("#Deposit 50,000" is a deposit).
  // A fullwidth "＃" ("＃test") is a flag parseCaption does not read: no caption price beside it.
  if (/＃/.test(String(caption || ''))) return null;
  const raw = String(caption || '');
  const fold = (s) => s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const folded = fold(raw);
  // The flags come out of the RAW caption, as parseCaption reads them: a tag only the cleaning below makes a
  // flag ("#inter" + a direction mark + "national", "#ｉｎｔｅｒｎａｔｉｏｎａｌ") is a word, so no price.
  const unflagged = westernise(fold(raw.replace(FLAG_TAG_RE, ' '))).replace(INVISIBLE_RE, '');
  const text = unflagged.replace(/#/g, ' ').replace(/\s+/g, ' ').trim();
  // A hashtag holding a digit ("#1stPayment", "#250000", "#2BR") may label or be the figure: no price.
  if (/#[^\s#]*[0-9]/.test(unflagged)) return null;
  if (/[\p{Nd}\p{No}]/u.test(text.replace(/[0-9]/g, '')) || otherDollar(text)) return null;
  // Rent and sale words are read on the cleaned text ("للإيـجار" is "للإيجار"), hashtags still on.
  const clean = westernise(folded).replace(INVISIBLE_RE, '');
  const rent = RENT_WORD_RE.test(clean);
  const sale = SALE_WORD_RE.test(clean);
  if (PERIOD_WORD_RE.test(text) && !rent) return null;
  if (rent && sale) return null;
  // The rent period, read from this closed caption ("Rent SAR 4,500 month"); both words ("a month for a
  // year") leave it unclear: no price.
  const month = MONTH_WORD_RE.test(text), year = YEAR_WORD_RE.test(text);
  if (month && year) return null;
  const period = month ? 'month' : year ? 'year' : null;
  // A rent caption must say its period: "Rent SAR 45,000" may be a year's or a month's (the price command
  // keeps the listing's own period).
  if (rent && !period && !command) return null;
  const runs = [...text.matchAll(DIGIT_RUN_RE)];
  if (runs.length !== 1) return null;
  const [run] = runs;
  const num = run[0];
  if (!FIGURE_RE.test(num)) return null;
  // "4,500.000" is a typo for something, not 4,500 ("OMR 1,175,000.125" is read).
  if (/[,،٬][0-9]{3}[.٫]000$/.test(num)) return null;
  // ".5 million", "-450,000": a mark or a sign glued to the figure (a dash anywhere else is no allowed
  // leftover either: "Price-4,500,000" is no price).
  const before = text.slice(0, run.index);
  if (SIGN_BEFORE_RE.test(before)) return null;
  let after = text.slice(run.index + num.length);
  const mult = MULTIPLIER_RE.exec(after);
  if (mult) after = after.slice(mult[0].length);

  // Nothing else: once the currencies and the allowed words are taken out, only punctuation is left.
  const currencies = new Set();
  const rest = (before + ' ' + after).replace(CURRENCY_TOKEN_RE, (c) => {
    currencies.add((CURRENCY_WHOLE.find(([, re]) => re.test(c)) || ['?'])[0]);
    return ' ';
  }).replace(ALLOWED_WORD_RE, ' ');
  if (!LEFTOVER_OK_RE.test(rest)) return null;
  if (currencies.size > 1 || currencies.has('?')) return null;
  const currency = currencies.size ? [...currencies][0] : null;

  const digits = num.replace(/[,،٬]/g, '').replace('٫', '.');
  // A phone or id number: no price starts with 0; ten or more bare digits, or a Saudi mobile without
  // its 0, is never one. A year is no price either ("2027").
  if (!mult && /^0[0-9]/.test(digits)) return null;
  if (!mult && !currency && (/^[0-9]{10,}$/.test(digits) || /^5[0-9]{8}$/.test(digits))) return null;
  if (!mult && /^(?:19|20)[0-9]{2}$/.test(num)) return null;
  const word = (mult?.groups.lmult || mult?.groups.amult || '').toLowerCase();
  const factor = /^(m|mn|mln|millions?|مليون|ملايين)$/.test(word) ? 1e6 : /^(k|thousands?|ألف|الف)$/.test(word) ? 1e3 : 1;
  const amount = Number(digits);
  // A bare "450 m" is as likely metres as millions: with no currency, it is millions only below 100
  // and written onto the figure ("25m"; "#sale 25 m" may be a frontage); "SAR 950 m" is no price either.
  if (word === 'm' && ((!currency && (amount >= 100 || /^ /.test(mult[0]))) || (amount >= 100 && /^ /.test(mult[0])))) return null;
  // The amount as typed; a multiplier's float noise (2.05 x 1e6 = 2049999.9999999998) rounded away.
  // A grouped figure with a multiplier is a decimal comma as often ("€15,500k" may be €15,500): no price.
  if (factor !== 1 && /[,،٬]/.test(num)) return null;
  // …and three decimals before a thousand are dot grouping as often ("€15.500k" may be €15,500,000).
  if (factor === 1e3 && /[.٫][0-9]{3}$/.test(num)) return null;
  if ((factor === 1e6 && amount >= 1000) || (factor === 1e3 && amount >= 100000)) return null;
  const value = factor === 1 ? amount : Math.round(amount * factor * 1000) / 1000;
  if (!Number.isFinite(value) || value > 1e10) return null;
  // One comma group ("175,125", "4,500") is a decimal comma as often in euros (4,5) and Omani rials, which
  // count three decimals (175.125): no price there. Two groups or more ("1,200,000") are thousands. With no
  // currency written the figure takes the listing's, which a caption cannot know: no caption price either
  // (the price command names its listing: setPrice refuses it there on a euro or rial listing).
  const oneGroup = /^[0-9]{1,3}[,،][0-9]{3}(?:[.٫][0-9]+)?$/.test(num);
  if (oneGroup && (currency === 'EUR' || currency === 'OMR' || (!currency && !command))) return null;
  // A bare number only counts as a price when it is plausibly one (>= 10,000) —
  // otherwise "3 bedrooms" would become a price.
  if (!currency && factor === 1 && value < 10000) return null;
  if (value < 1000) return null;
  // Under 10,000 is a rent at most: on any other caption it is a rate per metre or a fee, not the price
  // (the price command may set a rent's figure: the listing is named there).
  if (!command && !rent && value < 10000) return null;
  return { amount: value, currency: currency || 'SAR', explicitCurrency: Boolean(currency), rent, sale, period, oneGroup };
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
  let price = parsePriceHint(text);
  // The price reader and the category reader must agree on a rent ("#rent_monthly AED 5,000", "Lease
  // AED 2,000", "Rent45,000" are one to the first only), and a sale word must have made a sale category
  // ("بيع SAR 450,000" sets none, so a rental brochure would publish it as its rent): else no caption price.
  if (price && (price.rent !== (category === 'rent') || (price.sale && (category === null || category === 'rent')))) price = null;
  // A caption price brings its own period, read from its closed word list (a rent caption price always
  // has one). With no period in the caption it stays null, so the brochure's own period stands and a year
  // only when it has none (buildListing, and the pipeline's listingPeriod: caption, reading, year); a
  // "year" set here would turn a monthly brochure's rent into a yearly one.
  if (price) period = price.period;
  // A caption with a figure that is no caption price ("Rent $3,000 per month": a dollar with no country)
  // sets no period either: its period belongs to that figure, and on the brochure's own it would turn a
  // yearly rent into a monthly one.
  else if (/[\p{Nd}\p{No}]/u.test(text)) period = null;
  if (category !== 'rent') period = null;
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
    // A currency only when the owner wrote one: otherwise the brochure's own currency stands (an AED
    // listing priced "4.5m" stays in AED).
    price: price ? { amount: price.amount, currency: price.explicitCurrency ? price.currency : null } : null,
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
      const p = parsePriceHint(rest, { command: true });
      // setPrice changes neither the category nor the rent period, so a figure with a rent or sale word or
      // a period is refused (it would be published as the listing's own: a sale's price, a yearly rent).
      if (!p || p.period || p.rent || p.sale) return { cmd: 'error', message: 'usage: price BONA-W001 4500000  |  price BONA-W001 onrequest' };
      // A currency only when the owner wrote one: setPrice keeps the listing's own otherwise.
      // `oneGroup`: "450,000" with no currency; setPrice refuses it on a euro or rial listing (a decimal comma there).
      return { cmd: 'price', id, amount: p.amount, currency: p.explicitCurrency ? p.currency : null, ...(p.oneGroup && !p.explicitCurrency ? { oneGroup: true } : {}), onRequest: false };
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
