/**
 * Which WhatsApp chats belong in the Bona inbox (2026-09-27 design §4.1, D9, D12, D16).
 *
 * The team reads and answers these chats from the dashboard, and they arrive on the
 * owner's personal number, which his TK clients and private conversations share. So a
 * chat joins only on something that can only be about Bona:
 *
 *   - a client's message carrying a site Ref line (with its listing part, or a code a site
 *     session holds), click-to-WhatsApp ad context or a listing id (`BONA-W003`) is certain.
 *     TK runs no click-to-WhatsApp ads to this number (owner, D15), so ad context stays
 *     certain;
 *   - a client's message that only says "bona" / "بونا", or carries a bare Ref-shaped code
 *     no session holds, is a guess. It goes to the owner's Unsure list, never into the
 *     inbox by itself. The other guess, the ±15-min click window, arrives here as the
 *     lead's match method (`time_window`);
 *   - a message the OWNER sends joins a chat when it carries a Bona site link or a listing
 *     id, or when it is a property document (D16), by its file name or caption: a brochure,
 *     from any developer, on its own; a floor plan, price list, payment plan, master plan,
 *     fact sheet, booklet (كتيب) or plan (مخطط) only with a property word (villa, unit,
 *     فيلا, شقة …) in the same name or caption, because TK's fit-out work sends those too
 *     (owner, 2026-09-28). A document that names TK (`TK`, `T.K.`, `tk-estates`, `تي كي`)
 *     never joins, whatever else it carries (even a listing id or a site link): TK chats
 *     stay out (D17). Nor does a document that names Bona without a listing id or a site
 *     link: Bona AB makes wood-floor finishes, so "Bona Traffic HD brochure.pdf" to a TK
 *     contractor proves nothing (the poller puts such a chat on the owner's list to check,
 *     D17). Nothing else he sends counts, and the word "Bona" joins nothing by itself.
 *
 * The answer is stored on the lead (`leads.inbox_state`), and a message only ever moves it
 * forward: a guess can become certain, but `in` is never demoted by a later message and
 * `out` (the owner said "not a client") is never left automatically. Only the owner's
 * buttons move a chat out of either (lib/inbox/store.mjs `setInboxState`).
 *
 * Pure functions, no I/O and no logging: the poller asks, the store records.
 */
import { parseRef } from '../attribution.mjs';

/**
 * A whole listing id: `BONA-W003`, `bona-005` — not `BONA-W0031`, not `XBONA-W003`, and not
 * `BONA-W003٤` (`\b` knows only ASCII digits, so the Arabic-Indic and Persian ones are named).
 */
export const LISTING_ID_RE = /\bBONA-W?\d{3}(?![\w٠-٩۰-۹])/i;
/**
 * Our name as a word, in either script. A guess on its own: TK and private chats say it too.
 * Both scripts are bounded by anything that is not a letter or a mark, so `_`, digits and
 * punctuation end the word (`Bona_Villa`, `Bona2026`, `(بونا)`) while `Bonanza`, `Bonaé` and
 * the Arabic words that only contain the four letters do not count: كوبونات (coupons),
 * أبونا (our father), طلبونا, زبوناً … A clitic form (وبونا) is missed on purpose: that
 * fails safe, the owner still has the Move button.
 *
 * "bona fide" / "bona fides" is Latin, common in English real-estate papers ("Bona Fide
 * Purchaser Declaration"), and never our name.
 *
 * The bounds are `\p{…}` classes, which mean something only with the `u` flag: reuse this
 * pattern by calling `.test()` on it, or rebuild it with `'iu'`, never `'i'` alone.
 */
export const BONA_WORD_RE = /(?<![\p{L}\p{M}])(?:bona(?![\p{L}\p{M}])(?![\s_.-]*fides?(?![\p{L}\p{M}]))|بونا(?![\p{L}\p{M}]))/iu;
/**
 * The site (or its legacy host) as a link, with or without a scheme and `www.`. The
 * characters either side must not carry on a host name, so `notbona-real-estate.com`,
 * `bona-real-estate.company`, `bona-real-estate.com.evil.example`, `….com.السعودية`,
 * `bona.azoz.uk。evil.example` (browsers read `。．｡` as a dot in a host), `bona.azoz.uk_evil…`
 * and the user part of `bona.azoz.uk@evil.example`, `bona.azoz.uk.@evil.example` or
 * `bona.azoz.uk:443@evil.example` are not ours. A full stop that ends the text or is
 * followed by anything but a host character is allowed: a sentence can end with the link.
 * So is a port (`bona-real-estate.com:443/ar/`).
 *
 * After a colon, the `@` of user-info is looked for only within 256 characters, and a colon
 * followed by more than 256 characters with no space, `/` or `@` is refused as well (fewer
 * joins, never more). Unbounded, that look-ahead re-read the rest of the text from every
 * copy of the host in it (`bona.azoz.uk:bona.azoz.uk:…@`), quadratic in the text's length.
 */
export const SITE_LINK_RE = /(?:^|[^a-z0-9.-])(?:www\.)?(?:bona-real-estate\.com|bona\.azoz\.uk)(?![\p{L}\p{M}\p{N}_@-]|[.。．｡][\p{L}\p{M}\p{N}@]|:(?:[^\s/@]{0,256}@|[^\s/@]{257}))/iu;
export const INBOX_STATES = Object.freeze(['in', 'unsure', 'out']);

/**
 * The kinds of property document a developer or an agent sends (D16), in English and
 * Arabic, each a whole word: bounded, like `BONA_WORD_RE`, by anything that is not a letter
 * or a mark, so `_`, `-`, digits and punctuation end it (`Phase 2_Brochure_EN.pdf`,
 * `brochure2.pdf`) while `brochureX` does not count. Two English words may be written with a
 * space, `-`, `_` or nothing between them (`Floor-Plan`, `floorplan`, `price_list`). The
 * Arabic single words also count with the article (البروشور, المخطط); a clitic before them
 * (وبروشور) is missed on purpose, which fails safe like وبونا. `كتيّب` may carry its shadda,
 * and a price list may be `قائمة أسعار` (of the apartments) as well as `قائمة الأسعار`.
 *
 * Two kinds (owner, 2026-09-28). A brochure (`BROCHURE_WORDS`) is a property document on
 * its own. The other words (`QUALIFIED_WORDS`) are TK fit-out papers as often ("Payment
 * plan - kitchen works.pdf", "مخطط الكهرباء.pdf", "كتيب الصيانة.pdf"), so they count only
 * with a property word (`PROPERTY_NOUN_WORDS`) in the same file name or caption, or a
 * listing id or a site link, which join any document by themselves.
 *
 * Every alternative starts with a fixed word and repeats nothing, so a failed match costs a
 * bounded amount at each position: linear in the text's length.
 */
const BROCHURE_WORDS = String.raw`(?:brochures?|(?:ال)?بروشور(?:ات)?)`;
const QUALIFIED_WORDS = String.raw`(?:floor[\s_-]?plans?|price[\s_-]?lists?|payment[\s_-]?plans?|master[\s_-]?plans?|fact[\s_-]?sheets?`
  + String.raw`|(?:ال)?كتي\u0651?ب|(?:ال)?مخطط(?:ات)?`
  + String.raw`|(?:قائمة|جدول)[\s_-]?(?:ال)?[أا]سعار|خطة[\s_-]?(?:الدفع|السداد)|جدول[\s_-]?(?:الدفعات|السداد))`;
/**
 * The property words that let a `QUALIFIED_WORDS` document join (owner, 2026-09-28). The
 * Arabic nouns also count with the article (الشقق, المشروع), except أرض / أراضي and عمارة:
 * with it, الأرض is also "the ground" (and الأرضي the ground floor), and العمارة is also
 * architecture (العمارة الداخلية, the interior architecture TK's design work draws). `فله` and
 * `شقه` are how people type فلة and شقة.
 */
const PROPERTY_NOUN_WORDS = String.raw`(?:villas?|apartments?|units?|projects?|towers?|residences?|town[\s_-]?houses?|duplex|penthouses?`
  + String.raw`|compound|plots?|land|propert(?:y|ies)`
  + String.raw`|(?:ال)?(?:فيلا|فلل|فله|فلة)|(?:ال)?(?:شقة|شقق|شقه)|(?:ال)?(?:مشروع|مشاريع)|(?:ال)?(?:وحدة|وحدات)|(?:ال)?(?:برج|أبراج)`
  + String.raw`|عمارة|(?:ال)?دوبلكس|(?:ال)?بنتهاوس|تاون[\s_-]?هاوس|مجمع[\s_-]?سكني|[أا]رض|[أا]راضي|(?:ال)?عقار(?:ات)?)`;
/** `words` as a whole word: nothing that is a letter or a mark on either side. */
const wholeWord = (words) => new RegExp(String.raw`(?<![\p{L}\p{M}])${words}(?![\p{L}\p{M}])`, 'iu');
/**
 * `words` inside a cut document name, where the end of what is read is not the end of the
 * name: a word counts only when something that is not a letter or a mark follows it inside
 * what is read, so `…brochure` cut from `…brochureX` is never read as `brochure`.
 */
const wholeWordInCut = (words) => new RegExp(String.raw`(?<![\p{L}\p{M}])${words}(?=[^\p{L}\p{M}])`, 'iu');
/** A brochure: a property document on its own. */
export const BROCHURE_RE = wholeWord(BROCHURE_WORDS);
/**
 * A floor plan, price list, payment plan, master plan, fact sheet, booklet or plan: a property
 * document only next to a property word (`PROPERTY_NOUN_RE`), a listing id or a site link.
 */
export const QUALIFIED_DOC_RE = wholeWord(QUALIFIED_WORDS);
/** A property word (villa, unit, فيلا, شقة …), which lets a `QUALIFIED_DOC_RE` document join. */
export const PROPERTY_NOUN_RE = wholeWord(PROPERTY_NOUN_WORDS);
/**
 * Any property-document word, either kind (`BROCHURE_RE` or `QUALIFIED_DOC_RE`). It does not
 * decide a join by itself; the owner's list of real-estate chats to check notes it (D17).
 */
export const PROPERTY_DOC_RE = wholeWord(`(?:${BROCHURE_WORDS}|${QUALIFIED_WORDS})`);
const BROCHURE_CUT_RE = wholeWordInCut(BROCHURE_WORDS);
const QUALIFIED_DOC_CUT_RE = wholeWordInCut(QUALIFIED_WORDS);
const PROPERTY_NOUN_CUT_RE = wholeWordInCut(PROPERTY_NOUN_WORDS);
/**
 * A listing id in a file name, where `_` stands for a space (`Villa_BONA-W003_EN.pdf`):
 * `LISTING_ID_RE` with `_` allowed on either side. `XBONA-W003` and `BONA-W0031` still do
 * not count. The second is the same inside a cut name: something that cannot carry the id
 * on follows it inside what is read.
 */
const LISTING_ID_NAME_RE = /(?<![A-Za-z0-9])BONA-W?\d{3}(?![A-Za-z0-9٠-٩۰-۹])/i;
const LISTING_ID_NAME_CUT_RE = /(?<![A-Za-z0-9])BONA-W?\d{3}(?=[^A-Za-z0-9٠-٩۰-۹])/i;

/**
 * TK Estate & Design, the owner's other company, named on a document: `TK` as a word
 * (bounded by anything that is not a letter or a digit, so `TK_Villa` and `TK-Estates`
 * count and `TKO` or `TK2` do not), `T.K.` / `T.K`, `tk-estates` / `TKEstates`, or `تي كي`
 * as its own word, with ي or ى in either place (Saudi typing often ends a word with ى: تى
 * كى), bounded like `بونا` (بلاستيكي, بلاستيكى and أوتوماتيكي only contain the letters). The
 * two Arabic words may be written together or apart by up to four spaces, `_`, `.` or `-`
 * (`تي  كي` typed with two spaces, `تي - كي`); a longer run is cleaned to one space first
 * (`namesTk`). A document that matches never joins a chat, whatever else it carries, even a
 * listing id or a site link (D16, D17). Every alternative starts with a fixed letter and
 * repeats nothing unbounded, so a failed match costs a bounded amount at each position:
 * linear in the text.
 */
export const TK_RE = /(?<![\p{L}\p{N}])tk(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])t\.k\.?(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])tk[\s_-]?estates?|(?<![\p{L}\p{M}])ت[يى][\s_.-]{0,4}ك[يى](?![\p{L}\p{M}])/iu;

/**
 * Runs of whitespace, and every invisible character (controls, format characters and the
 * rest of Unicode's default-ignorable set). JavaScript counts U+FEFF as whitespace, but it is
 * a zero-width no-break space: it goes with the invisible characters instead of becoming a
 * space. Unlike a shown file name (lib/evolution.mjs), nothing is spared: the zero-width
 * joiner and non-joiner go too.
 */
const SPACES_RE = /[\s--\u{FEFF}]+/gv;
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * `s` as it reads for the TK and Bona checks: every run of whitespace one space and every
 * invisible character gone. A caption is never cleaned the way a file name is, and a file
 * name keeps U+200C and U+200D, so "تي  كي" typed with two spaces, "T\u200BK" or "T\u200CK"
 * would otherwise not read as TK. Whitespace first, so a line break between two words leaves
 * a space, not a join.
 */
function readsAs(s) {
  return s.replace(SPACES_RE, ' ').replace(INVISIBLE_RE, '').replace(SPACES_RE, ' ');
}

/**
 * Does `s` (a caption or a file name) name TK (`TK_RE`) / Bona (`BONA_WORD_RE`), as it is or
 * as it reads (`readsAs`)? Both readings are asked because cleaning can also end a word
 * ("X\u200BTK" reads "XTK", "Bona\u200Bfide" reads "Bonafide"), and these checks only ever
 * keep a chat out: either one saying so means fewer joins, never more. lib/evolution.mjs asks
 * the same of the whole file name before it is cut (`fileNameTk`, `fileNameBona`).
 * @param {string} s
 * @returns {boolean}
 */
export const namesTk = (s) => TK_RE.test(s) || TK_RE.test(readsAs(s));
/** @see namesTk */
export const namesBona = (s) => BONA_WORD_RE.test(s) || BONA_WORD_RE.test(readsAs(s));

/**
 * A document's own extension, which is not part of a host in its name:
 * `bona-real-estate.com.pdf`. Only the kinds of file a brochure or a plan comes as, and none
 * that is also a top-level domain (`.zip` is one, so `bona-real-estate.com.zip` is a longer
 * host and stays one). Any other label after a full stop is read as in a text, so
 * `bona-real-estate.com.sa` is still not ours (A7).
 */
const DOC_EXTENSION_RE = /\.(?:pdf|docx?|xlsx?|pptx?|jpe?g|png|heic|txt|csv)$/i;

/**
 * `SITE_LINK_RE` for a file name, where `_` stands for a space as it does for a listing id:
 * the host may also be followed by `_` and a run with no full stop, `@` or `:` in it up to the
 * next space or the end (`bona-real-estate.com_brochure`, `Villa_bona.azoz.uk_EN`). Such a
 * run could only make a top-level domain no one can have (`com_brochure`). A run with one of
 * them could carry the host on or make it the user part of another, so there `_` is a host
 * character, as in a text: `bona.azoz.uk_evil.example` and `bona.azoz.uk_x@evil.example` are
 * not ours, nor (fewer joins) `bona-real-estate.com_brochure.v2`. The run stops at the first
 * full stop, and every copy of the host holds one, so this stays linear in the name's length.
 */
const SITE_LINK_NAME_RE = new RegExp(
  String.raw`(?:${SITE_LINK_RE.source})|(?:^|[^a-z0-9.-])(?:www\.)?(?:bona-real-estate\.com|bona\.azoz\.uk)_[^\s.。．｡@:]*(?:\s|$)`,
  'iu',
);

/**
 * Does a whole file name carry a site link (`SITE_LINK_NAME_RE`)? The name is read with and
 * without a document's own extension (`DOC_EXTENSION_RE`), so `bona-real-estate.com.pdf` and
 * `bona-real-estate.com_brochure.pdf` are ours, while `bona-real-estate.company_profile.pdf`,
 * `bona-real-estate.com.evil.pdf`, `bona-real-estate.com.sa` and
 * `bona.azoz.uk_evil.example.pdf` are not. Never asked of a cut name.
 */
function nameHasSiteLink(name) {
  return SITE_LINK_NAME_RE.test(name) || SITE_LINK_NAME_RE.test(name.replace(DOC_EXTENSION_RE, ''));
}

/**
 * Words that say a chat is about property, each with the one form the owner's list shows
 * (D17). English and Arabic, bounded like `BONA_WORD_RE` by anything that is not a letter or
 * a mark (`3villas` and `villa2` count, `villager` does not). Arabic words written with ه
 * for ة (فله, شقه) count too, as people type them, and most Arabic nouns also with the
 * article (الفيلا, العقار); أرض and غرفة do not, because with it they are everyday words (the
 * ground, the room). A clitic before a word (والفيلا, بالإيجار) is missed: that only means
 * the owner does not see that chat on his list, never that anything joins.
 *
 * A match only ever puts a chat on the owner's list of chats to check; it never joins one.
 * Every alternative starts with a fixed word and repeats nothing: linear in the text.
 */
const PROPERTY_WORDS = [
  ['villa', 'villas?'],
  ['apartment', 'apartments?'],
  ['flat', 'flats?'],
  ['rent', 'rent(?:al)?s?'],
  ['lease', 'leases?'],
  ['land', 'lands?'],
  ['plot', 'plots?'],
  ['property', 'propert(?:y|ies)'],
  ['real estate', String.raw`real[\s_-]?estate`],
  ['duplex', 'duplex(?:es)?'],
  ['penthouse', 'penthouses?'],
  ['townhouse', String.raw`town[\s_-]?houses?`],
  ['compound', 'compounds?'],
  ['bedroom', 'bedrooms?'],
  ['sqm', 'sqm|m²'],
  ['listing', 'listings?'],
  ['broker', 'brokers?'],
  ['commission', 'commissions?'],
  ['فيلا', '(?:ال)?(?:فيلا|فلل|فلة|فله)'],
  ['شقة', '(?:ال)?(?:شقة|شقه|شقق)'],
  ['إيجار', '(?:ال|لل)?[إا]يجار'],
  ['للبيع', 'للبيع'],
  ['أرض', '[أا]رض|(?:ال)?[أا]راضي'],
  ['عقار', '(?:ال)?عقارات?'],
  ['دوبلكس', '(?:ال)?دوبلكس'],
  ['بنتهاوس', '(?:ال)?بنتهاوس'],
  ['تاون هاوس', String.raw`تاون[\s_-]?هاوس`],
  ['مجمع سكني', String.raw`مجمع[\s_-]?سكني`],
  ['غرفة', 'غرفة|غرفه|غرف'],
  ['صك', '(?:ال)?صك'],
  ['سمسار', '(?:ال)?سمسار'],
  ['عمولة', '(?:ال)?(?:عمولة|عموله)'],
  ['مخطط', '(?:ال)?مخطط'],
];
const WORDS_SOURCE = String.raw`(?<![\p{L}\p{M}])(?:${PROPERTY_WORDS.map(([, src]) => `(${src})`).join('|')})(?![\p{L}\p{M}])`;
/**
 * Any property word (one capture group per word, in `PROPERTY_WORDS` order). No `g`, like
 * every pattern here, so `.test()` never carries a position over; `propertyWordsIn` scans
 * with its own global copy.
 */
export const PROPERTY_WORD_RE = new RegExp(WORDS_SOURCE, 'iu');
const PROPERTY_WORDS_ALL = new RegExp(WORDS_SOURCE, 'giu');
/** At most this many words are kept for one chat. */
export const MAX_PROPERTY_WORDS = 8;

/**
 * The property words a text uses, as the forms the owner's list shows (`villa`, `شقة`,
 * `إيجار` …): lower case, each once, in the order they first appear, at most
 * `MAX_PROPERTY_WORDS`. Never the text itself. Anything that is not a string has none.
 * @param {unknown} text
 * @returns {string[]}
 */
export function propertyWordsIn(text) {
  const out = [];
  if (typeof text !== 'string' || !text) return out;
  for (const m of text.matchAll(PROPERTY_WORDS_ALL)) {
    const word = PROPERTY_WORDS[m.findIndex((g, i) => i > 0 && g !== undefined) - 1][0];
    if (!out.includes(word)) out.push(word);
    if (out.length === MAX_PROPERTY_WORDS) break;
  }
  return out;
}

/**
 * Code points left out at the end of a document name that was cut (`fileNameTruncated`):
 * nothing close to the cut is read.
 */
const CUT_MARGIN = 16;

/** What a cut document name can be read by: all but its last `CUT_MARGIN` code points. */
function readableCutName(name) {
  return Array.from(name).slice(0, -CUT_MARGIN).join('');
}

/**
 * A Ref line exactly as the site writes it: `Ref BONA-W003 · K7Q2XR`, or `Ref BONA · K7Q2XR`
 * from a page without a listing (`refLine()` in src/scripts/attribution.js, EnquiryForm.astro).
 * The listing part and a separator are always there, and nothing carries the code on.
 * `parseRef` is looser — no separator needed, ASCII bounds — so it also reads "Ref bona
 * please" as listing BONA + code PLEASE. Every line this matches, parseRef reads too.
 */
const SITE_REF_RE = /\bRef\s+BONA(?:-W?\d{3})?\s*[·:|-]\s*[A-HJ-NP-Z2-9]{5,6}(?![\p{L}\p{N}_])/iu;

/** Anything that is not a string reads as empty: a record's text or caption may be null. */
const str = (v) => (typeof v === 'string' ? v : '');
const isDocument = (media) => str(media).startsWith('[document');

/**
 * Does the document's file name name TK (`namesTk`) or Bona (`namesBona`)? A name cut at
 * 120 code points hides its end, so for a cut name the answer comes from what
 * lib/evolution.mjs worked out on the whole name before it was cut (`fileNameTk`,
 * `fileNameBona`: `wholeSays`); a cut name without that answer may name it in the part
 * nobody saw, and is read as if it did. What is left of the name is read as well, cut or
 * not ("…TK" cut from "…TKO" reads as TK): either way that only ever means fewer joins.
 * A `wholeSays` of exactly `true` counts for a name that was not cut too.
 */
function nameSays(says, name, fileNameTruncated, wholeSays) {
  return (fileNameTruncated ? wholeSays !== false : wholeSays === true) || says(name);
}

/**
 * Is `s` (one file name or one caption) a property document by its words: a brochure, or a
 * `QUALIFIED_DOC_RE` word with a property word beside it in the same `s`? `cut` reads a cut
 * name's readable part, where a word counts only when something follows it there.
 */
function namesPropertyDocument(s, cut) {
  if ((cut ? BROCHURE_CUT_RE : BROCHURE_RE).test(s)) return true;
  return (cut ? QUALIFIED_DOC_CUT_RE : QUALIFIED_DOC_RE).test(s) && (cut ? PROPERTY_NOUN_CUT_RE : PROPERTY_NOUN_RE).test(s);
}

/**
 * What one message from a client says about the chat.
 *
 * A Ref line is certain only in the shape the site writes it (`SITE_REF_RE`), or when the
 * poller found a site session holding the code (`refKnown`, from `db.getSessionByRef`).
 * `parseRef` checks only the shape, so a bare `Ref K7Q2X` is also "ref please", "Ref check
 * done" or a TK booking reference: a guess, never a join by itself. `hasAdMeta` and
 * `refKnown` count only when exactly `true`, like the text, never coerced. A site link
 * with no listing id is only a guess too (spec §4.1 does not name it); the owner decides.
 * @param {{ text?: unknown, hasAdMeta?: boolean, refKnown?: boolean }|null} [o]
 * @returns {'certain'|'unsure'|null}
 */
export function inboundSignal(o) {
  const { text = '', hasAdMeta = false, refKnown = false } = o ?? {};
  const t = str(text);
  const ref = parseRef(t);
  if (SITE_REF_RE.test(t) || (ref && refKnown === true)) return 'certain';
  if (hasAdMeta === true || LISTING_ID_RE.test(t)) return 'certain';
  if (ref || BONA_WORD_RE.test(t)) return 'unsure';
  return null;
}

/**
 * Is this a document that names TK, by its file name or its caption (D16)? The poller
 * puts such a chat on the owner's list of real-estate chats to check instead of joining
 * it (D17). Takes a normalised record (lib/evolution.mjs); a cut name is judged as in
 * `nameSays`.
 * @param {{ text?: unknown, fileName?: unknown, fileNameTruncated?: boolean, fileNameTk?: boolean, media?: unknown }|null} [o]
 * @returns {boolean}
 */
export function isTkDocument(o) {
  const { text = '', fileName = null, fileNameTruncated = false, fileNameTk = null, media = null } = o ?? {};
  if (!isDocument(media)) return false;
  return namesTk(str(text)) || nameSays(namesTk, str(fileName), Boolean(fileNameTruncated), fileNameTk);
}

/**
 * Does a message the owner sent make this a Bona chat (D12, D16)? Takes a normalised
 * record (lib/evolution.mjs): `text` is the body or the caption, `media` the placeholder
 * (`[document: name]`, `[image]`, …), `fileName` a document's cleaned name, and
 * `fileNameTk` / `fileNameBona` whether the whole name named TK / Bona.
 *
 * Any message: a Bona site link or a listing id in the text or caption joins. A document
 * that names TK (`namesTk`) in its file name or caption never joins, whatever else it says.
 * Otherwise a document joins by a site link or a listing id in its caption or file name
 * (`nameHasSiteLink`), or by its words (`namesPropertyDocument`), read in the caption and
 * in the file name each on its own: a brochure, or a floor plan, price list … with a
 * property word beside it — but a document that names Bona (`namesBona`) joins only by a
 * site link or a listing id: "Bona Traffic HD brochure.pdf" is Bona AB's floor finish as
 * often as ours, and the poller puts it on the owner's list to check instead (D17). The
 * word "Bona" joins nothing by itself.
 *
 * A name cut at 120 code points (`fileNameTruncated`) may go on past the cut: "…Brochure"
 * may be "…BrochureX", "…BONA-W003" may be "…BONA-W0031", "…Land" may be "…Landscape". So a
 * cut name is read without its last 16 code points (`CUT_MARGIN`), and there a word or an
 * id counts only when a character that cannot carry it on follows it inside what is read;
 * a site link, whose look-ahead reaches much further, is not read in a cut name at all.
 * Whatever is then found in it is found in the whole name too, and TK and Bona are judged
 * on the whole name (`fileNameTk`, `fileNameBona`) as well as on what is left of it, so a
 * cut name joins only where the whole name would join. Any truthy flag counts as cut: that
 * only ever means fewer joins.
 * @param {{ text?: unknown, fileName?: unknown, fileNameTruncated?: boolean, fileNameTk?: boolean, fileNameBona?: boolean, media?: unknown }|null} [o]
 * @returns {boolean}
 */
export function ownerOutboundJoins(o) {
  const { text = '', fileName = null, fileNameTruncated = false, fileNameTk = null, fileNameBona = null, media = null } = o ?? {};
  const t = str(text);
  if (!isDocument(media)) return SITE_LINK_RE.test(t) || LISTING_ID_RE.test(t);
  const name = str(fileName);
  const cut = Boolean(fileNameTruncated);
  if (namesTk(t) || nameSays(namesTk, name, cut, fileNameTk)) return false;
  const readable = cut ? readableCutName(name) : name;
  if (SITE_LINK_RE.test(t) || LISTING_ID_RE.test(t)) return true;
  if (cut ? LISTING_ID_NAME_CUT_RE.test(readable) : (LISTING_ID_NAME_RE.test(name) || nameHasSiteLink(name))) return true;
  if (namesBona(t) || nameSays(namesBona, name, cut, fileNameBona)) return false;
  return namesPropertyDocument(t, false) || namesPropertyDocument(readable, cut);
}

/**
 * The chat's inbox state after one inbound message. `in` and `out` stay as they are; an
 * undecided or unsure chat becomes `in` on anything certain and `unsure` on a guess (the
 * word, or a lead the poller matched only by keyword or click window); otherwise it is
 * left as it was. A `current` that is not one of the three states reads as undecided
 * (the store's CHECK allows only those and NULL), so the answer is always a state or null.
 * @param {'in'|'unsure'|'out'|null|undefined} current
 * @param {{ signal?: 'certain'|'unsure'|null, method?: string|null }|null} [o]
 * @returns {'in'|'unsure'|'out'|null}
 */
export function nextInboxState(current, o) {
  const { signal = null, method = null } = o ?? {};
  const cur = INBOX_STATES.includes(current) ? current : null;
  if (cur === 'out' || cur === 'in') return cur;
  if (signal === 'certain') return 'in';
  if (signal === 'unsure' || method === 'keyword' || method === 'time_window') return 'unsure';
  return cur;
}
