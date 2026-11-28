/**
 * What the assistant's answer becomes once preSend has passed (DESIGN §4.3 "commit after preSend",
 * §8.3; PLAN T13, PR-B4). It replaces the PR-F2b stub behind the same seam: PR-B3 (T12, lib/dana-wa.mjs)
 * calls `afterPreSend` after preSend passes and sends the bubbles it answers, in order (text, then
 * any document), then calls `afterSend` once the confirmation bubble's send has an answer.
 *
 * `turn` is the brain's turn (lib/brain.mjs `turn()`: `toolCalls:[{name, args, result, ok}]`), or the
 * Retell completion for a legacy lead until PR-RX (T27) removes that path (the same calls as Retell-shaped
 * `tool_call_invocation` / `tool_call_result` messages). The tools only read, validate or save needs;
 * everything that is sent or booked is done here, from the SAME turn's calls and results (no intent store,
 * no held rows: nothing of a dropped turn is ever committed later):
 *   - book_viewing: the LAST invocation decides. Only when its result says `reserved: true` →
 *     viewing.commitBooking(); ok → the code-built confirmation REPLACES the model's text (only code states a
 *     booked time); a failure → BOOKING_FAILED_LINE and a `booking_failed` hand-over for the caller
 *     (non-sticky). An earlier reserved call never books when a later one was refused (the client moved on),
 *     and with two homes in one turn only the last is booked: a lead has one active booking (DESIGN §8.4);
 *   - send_brochure with `will_send: 'pdf'` → a document bubble after the text, its URL read again from the
 *     inventory (never the model's string), only https on Bona's site, never a held brochure (BLOCKED_BROCHURES);
 *   - send_location with `precision: 'exact'` (and an exact pin in the inventory) → a maps link at the end of
 *     the text, only while the text has fewer than MAX_LINKS links and not with a booking (the confirmation
 *     carries its own);
 *   - a reserved book_viewing followed by one that never ran (the brain's tool limit, a thrown tool): the outcome
 *     is unknown, so nothing is committed and the model's "booking it" never goes out alone: BOOKING_FAILED_LINE
 *     and the hand-over;
 *   - the safety net: with no successful commit, a brain answer with a booking claim → BOOKING_FAILED_LINE and
 *     the hand-over (claimsABooking; every sentence the reviews raised is a row of the corpus test in
 *     test/dana-commit.test.mjs). Sentence by sentence (. ! ? ; ؟ ؛ newline):
 *       0. future, conditional and general forms are cut out ("once it's scheduled", "can be booked", "viewings
 *          are scheduled …", «يتم / بيتم الحجز», «يتأكد الحجز», «راح يكون محجوز»): how booking works, or a slot
 *          offer that mentions the confirmation, is no claim;
 *       1. a denial is cut out only where it governs the claim word ("isn't booked", "I haven't reserved it yet",
 *          "hasn't been confirmed", «لم يتم الحجز», «ما تم الحجز», «ما حجزت لك», «الحجز غير مؤكد»); a negative word
 *          about anything else ("the meeting point isn't set yet", «ولسه ما أرسلت لك الموقع», «وهذا ما تم الاتفاق
 *          عليه») cuts nothing, and «بعد ما» + a past verb is "after", never "not";
 *       2. a personal claim form fires on its own ("you're booked", "see you on Sunday", «تم الحجز», «تم التأكيد»,
 *          «حجزت لك», «ثبتنا لك», «انحجز لك», «نشوفك الأحد»), at a word start;
 *       3. a claim word (booked, confirmed, reserved, scheduled, locked in, set for, محجوز, انحجز, تم تأكيد …, or
 *          "you're all set") fires with a booking sign in its own sentence (a viewing word, a weekday or tomorrow, a
 *          clock time, a second-person object such as "booked you in", "your slot", or "today"), or with a viewing
 *          tool in the turn or a sign anywhere in the answer unless its own sentence is about stock, price, delivery
 *          or the home's features ("Sunday at 10 works. It's booked!" fires; «الشقة محجوزة» does not). Office hours
 *          ("Sunday to Thursday, 10:00–19:00") are no sign.
 *     The claim usually comes in the turn after the slots were offered, with no viewing tool in it. "The developer
 *     has confirmed delivery in Q4 2027", "fully booked" or "You're all set: I've sent you the brochure" is no
 *     claim. A needless hand-over is the accepted cost; a phantom booking is not. Only on a brain turn: a legacy
 *     Retell completion has no booking tool and keeps today's behaviour (the same-release rule).
 * The hand-over itself (needs_human, the alert, notes.handover) stays dana-wa's: `afterPreSend` answers it as
 * `handover: { kind }`, and dana-wa applies it as any other.
 *
 * After the send (`afterSend`, DESIGN §8.3 steps 8-9): the confirmation accepted → viewing.markTold and the
 * booking note (notes.booking told); not accepted (failed or uncertain) → the event stays, the "client NOT
 * told" note, and a `booking_unconfirmed` hand-over for the caller.
 *
 * INERT until a lead is in auto mode: the tools commit nothing outside it (they answer reserved:false,
 * will_send:false, precision none), and before D1 only the owner's test chat is answered by the brain.
 * Logs carry lead ids, booking ids and codes only, never the text.
 */
import { claimsBooking } from './reply-guard.mjs';
import { exactListing, pinOf, toAsciiDigits } from './inventory.mjs';
import { BLOCKED_BROCHURES, brochureUrlOn } from './tools.mjs';
// Not lib/dana-wa.mjs: dana-wa imports BOOKING_FAILED_LINE from here, so the link cap comes in through deps.

/** Instead of a model text, when a booking could not be made or was claimed without one (DESIGN §4.3, §8.3 step 5). */
export const BOOKING_FAILED_LINE = Object.freeze({
  en: 'Thank you — the Bona team will confirm a time for your viewing with you here.',
  ar: 'شكراً لك، فريق بونا بيأكد معك موعد المعاينة هنا.',
});
/** Brochure documents one answer may carry (one per home asked for). */
export const MAX_DOCUMENTS = 2;
/** Links one answer may carry when the caller passes no `maxLinks` (DESIGN §6.5: MAX_LINKS goes from 3 to 2). */
export const DEFAULT_MAX_LINKS = 2;

/** A word that names a viewing (the booking intent of a claim with no viewing tool in the turn). */
const VIEWING_WORD_RE = /(?<![\p{L}])(?:viewings?|visits?|appointments?|bookings?)(?![\p{L}])|معاين|زيار|موعدك|حجزك/iu;
/**
 * A weekday or tomorrow (Arabic weekdays only with the article: «أحد» alone is "someone"). Not "today": viewings
 * are booked from tomorrow (lib/slots.mjs), and "fully booked today" is about stock.
 */
const DAY_RE = /(?<![\p{L}])(?:(?:sun|mon|tues|wednes|thurs|fri|satur)day|tomorrow)(?![\p{L}])|(?<![\p{L}])ال(?:أحد|احد|اثنين|إثنين|ثلاثاء|أربعاء|اربعاء|خميس|جمعة|جمعه|سبت)(?![\p{L}])|(?<![\p{L}])(?:بكرة|بكره|غدا|غداً)(?![\p{L}])/iu;
/** A clock time: 10 am, 2:00 pm, 14:00, at 10, noon, الساعة 2, 2 ظهراً. */
const TIME_RE = /(?<![\d:])\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)(?![\p{L}])|(?<![\d:])\d{1,2}:\d{2}(?![\d:])|(?<![\p{L}])at\s+\d{1,2}(?!\d|[,.]\d)|(?<![\p{L}])(?:noon|o'clock)(?![\p{L}])|الساعة\s*\d|(?<![\d:])\d{1,2}\s*(?:صباح|مساء|ظهر|عصر|الصبح|الظهر|العصر)/iu;
const WEEKDAY_AR = String.raw`ال(?:أحد|احد|اثنين|إثنين|ثلاثاء|أربعاء|اربعاء|خميس)`;
/** "today" is a sign only in a sentence that is not about stock: a claim for today is itself a phantom (no viewing is same-day). */
const TODAY_RE = /(?<![\p{L}])(?:today|tonight)(?![\p{L}])|(?<![\p{L}])اليوم(?![\p{L}])/iu;
/** A second-person object on the claim word: "booked you (in)", "reserved you a place", "booked it for you", «حجزنا لك». */
const OBJECT_RE = /(?<![\p{L}])(?:booked|confirmed|reserved|scheduled)\s+you(?:r)?(?![\p{L}])|(?<![\p{L}])(?:booked|confirmed|reserved|scheduled)\s+(?:it|this|that|one)\s+for\s+you(?![\p{L}])|(?:حجزت|حجزنا|أكدت|أكدنا|اكدت|اكدنا)\s*(?:لك|لكم|عليك)/iu;
/** The client's own slot: "your slot / place / spot / appointment / viewing time / time slot" (Codex r5), never a bare "your time". */
const YOUR_SLOT_RE = /(?<![\p{L}])your\s+(?:slot|place|spot|appointment|viewing\s+time|time\s+slot)(?![\p{L}])/iu;
const ANY_WEEKDAY_EN = String.raw`(?:sun|mon|tues|wednes|thurs|fri|satur)day`;
const ANY_WEEKDAY_AR = String.raw`ال(?:أحد|احد|اثنين|إثنين|ثلاثاء|أربعاء|اربعاء|خميس|جمعة|جمعه|سبت)`;
/** A weekday range ("Sunday to Thursday", «من الأحد إلى الخميس»): office hours, never a viewing (Claude r5 P3-2). */
const WEEKDAY_RANGE_RE = new RegExp(String.raw`(?<![\p{L}])(?:from\s+)?${ANY_WEEKDAY_EN}\s*(?:to|through|till|until|-|–|—)\s*${ANY_WEEKDAY_EN}(?![\p{L}])|(?:من\s+)?(?:يوم\s+)?${ANY_WEEKDAY_AR}\s*(?:إلى|الى|لين|لغاية|حتى|-|–|—)\s*(?:يوم\s+)?${ANY_WEEKDAY_AR}`, 'giu');
/** A time range ("10:00–19:00", "10 am to 7 pm"); only one longer than two hours is dropped (a viewing is one hour). */
const TIME_RANGE_RE = /(?<![\d:])(\d{1,2})(?::\d{2})?\s*(am|pm)?\s*(?:-|–|—|to|till|until|إلى|الى|لين|حتى)\s*(\d{1,2})(?::\d{2})?\s*(am|pm)?(?![\d:])/giu;
const hour24 = (h, ap) => {
  const n = Number(h) % 12;
  return ap && ap.toLowerCase() === 'pm' ? n + 12 : (ap ? n : Number(h));
};
/** The sentence without office-hours ranges, for the sign check. */
function withoutRanges(s) {
  return s.replace(WEEKDAY_RANGE_RE, ' ').replace(TIME_RANGE_RE, (m, h1, a1, h2, a2) => {
    const from = hour24(h1, a1);
    let to = hour24(h2, a2);
    if (to <= from) to += 12;
    return to - from > 2 ? ' ' : m;
  });
}
/**
 * Future and conditional booking forms, cut out before the claim check like a denial (Claude r5 P2-1): how booking
 * works, or a slot offer that mentions the confirmation, is no claim. «يتم / بيتم / ويتم / راح يتم / سيتم الحجز|التأكيد»,
 * «يتأكد الحجز|الموعد», "once / when / after / until it's (the viewing is) booked|confirmed", "will / 'll be booked|
 * confirmed". «وتم الحجز» (and) stays a claim.
 */
const FUTURE_RE = new RegExp([
  String.raw`(?<![\p{L}])[وفل]?(?:ي|بي|راح\s+ي|رح\s+ي|حي|سي)تم\s+(?:ال)?(?:حجز|تأكيد|تثبيت|تسجيل)\S*`,
  String.raw`(?<![\p{L}])[وفل]?(?:ي|بي|راح\s+ي|رح\s+ي)(?:تأكد|تثبت|تسجل|نحجز|تحجز)\s+(?:ال)?(?:حجز|موعد|معاين)\S*`,
  // «يكون / بيكون / راح يكون (موعدك) محجوز|مؤكد|مثبت»
  String.raw`(?<![\p{L}])[وفل]?(?:ي|بي|راح\s+ي|رح\s+ي|حي|سي)كون\s+(?:\S+\s+){0,2}?(?:محجوز|مؤكد|مثبت)\S*`,
  // every claim word: "once / when / after / until / if it's (your viewing is) booked|confirmed|reserved|scheduled|set|locked in"
  String.raw`(?<![\p{L}])(?:once|when|after|as\s+soon\s+as|until|if)\s+(?:it['’]s|it\s+is|it\s+has\s+been|(?:a|the|your)\s+(?:\w+\s+)?(?:is|has\s+been))\s+(?:booked|confirmed|reserved|scheduled|set|locked\s+in)(?![\p{L}])`,
  // "will / can / could / may / should / must be booked …" (Claude r6 P3-2)
  String.raw`(?<![\p{L}])(?:will|would|can|could|may|might|should|must|['’]ll)\s+be\s+(?:booked|confirmed|reserved|scheduled|set|locked\s+in)(?![\p{L}])`,
  // how viewings work, in general ("Viewings are scheduled Sunday to Thursday"), never "your viewings are booked"
  String.raw`(?<![\p{L}])(?<!your\s+)(?:viewings|visits|appointments|bookings)\s+(?:are|get)\s+(?:usually\s+|normally\s+|only\s+)?(?:booked|scheduled|confirmed|reserved|set)(?![\p{L}])`,
].join('|'), 'giu');
/**
 * A sentence about stock, price, delivery or the home's features: its claim needs its sign in that same sentence, even
 * with a viewing tool in the turn ("fully booked", "confirmed delivery", "the private pool is confirmed").
 */
const STOCK_RE = /(?<![\p{L}])(?:units?|apartments?|flats?|villas?|homes?|price|prices|delivery|handover|completion|project|pools?|gardens?|parking|elevators?|lifts?|terraces?|balcon(?:y|ies)|amenities|finish(?:ing|es)?|specifications?)(?![\p{L}])|الشقق|الشقة|الوحدات|الوحدة|السعر|الأسعار|التسليم|المشروع|الفلل|مسبح|حديقة|موقف|مواقف|مصعد|التشطيب/iu;
/** Claim words beyond reply-guard claimsBooking (booked, confirmed, تم الحجز, تم تأكيد, حجزت لك, تأكد الحجز); Claude r5 P3-1. */
const EXTRA_CLAIM_RE = /(?<![\p{L}])(?:reserved|scheduled|locked\s+in|set\s+for)(?![\p{L}])|(?<![\p{L}])[وف]?(?:محجوز(?:ة|ه)?|انحجز(?:ت)?)(?![\p{L}])/iu;
/**
 * A personal claim form: a claim AND a booking sign on its own (Codex r3, Claude r4). "you're / you are (all)
 * booked|confirmed", "see(ing) you then|on|at|there|tomorrow|<weekday>" (never "see you soon"), «تم الحجز»,
 * «تم التأكيد», «حجزت لك», «حجزنا لك», «تأكد (ال)حجز», «تم تأكيد الحجز», «(ب)نشوفك» + up to three words + a
 * weekday, tomorrow, a time, «هناك» or «في المعاينة|الموعد» (never «نشوفك على خير»).
 */
const PERSONAL_CLAIM_RE = new RegExp([
  String.raw`(?<![\p{L}])you(?:'re|’re|\s+are)\s+(?:all\s+)?(?:booked|confirmed)(?![\p{L}])`,
  String.raw`(?<![\p{L}])see(?:ing)?\s+you\s+(?:then|on|at|there|tomorrow|(?:sun|mon|tues|wednes|thurs|fri|satur)day)(?![\p{L}])`,
  // At a word start (with «و» / «ف»): «يتم الحجز» and «يتأكد الحجز» are not «تم الحجز» / «تأكد الحجز».
  String.raw`(?<![\p{L}])[وف]?(?:تم\s+الحجز|تم\s+التأكيد|حجز(?:ت|نا)\s*لك|تأكد\s+(?:ال)?حجز|تم\s+تأكيد\s+الحجز|تم\s+تثبيت\s+(?:ال)?(?:موعد|حجز|معاين)|تم\s+تسجيل\s+(?:ال)?موعد|ثبت(?:نا|ت)?\s*لك|(?:سجلت|سجّلت|سجلنا|سجّلنا)\s*لك\s+(?:ال)?موعد|انحجز\s*لك)`,
  String.raw`(?<![\p{L}])ب?نشوفك(?:م)?(?:\s+\S+){0,3}?\s+(?:يوم\s+)?(?:${WEEKDAY_AR}|بكرة|بكره|غدا|غداً|الساعة|هناك|في\s+(?:المعاينة|الموعد))`,
].join('|'), 'iu');
/** "You're all set": a claim, but it needs a booking sign ("You're all set: I've sent you the brochure" is no booking). */
const ALL_SET_RE = /(?<![\p{L}])you(?:'re|’re|\s+are)\s+all\s+set(?![\p{L}])/iu;
/**
 * A denial that governs the claim word, cut out before the claim check (Claude r3, r4; Codex r4): "isn't / aren't /
 * wasn't / is not / not (yet) / haven't / hasn't / have not / has not (been) / didn't / did not … booked|confirmed|
 * book|confirm (it|this|the …) (yet)", «لم يتم / ما تم / لسه ما (تم) / للحين ما (تم) + الحجز|التأكيد|تأكد», «ما +
 * حجزت|أكدت|انحجز|تأكد», «الحجز / موعدك / المعاينة لسه ما تأكد», «… غير مؤكد». «بعد ما» is "after" in Hijazi, so
 * «بعد ما تم الحجز» / «بعد ما حجزت لك» are no denials (the lookbehinds), and «ما تم الاتفاق عليه» ("what was agreed")
 * is none either.
 */
const GOVERNED_DENIAL_RE = new RegExp([
  String.raw`(?<![\p{L}])(?:isn['’]t|aren['’]t|wasn['’]t|(?:hasn['’]t|haven['’]t|has\s+not|have\s+not)(?:\s+been)?|didn['’]t|did\s+not|(?:is|are|was)\s+not|not)\s+(?:yet\s+|been\s+|fully\s+|actually\s+)?(?:booked|confirmed|reserved|scheduled|book|confirm|reserve|schedule)(?![\p{L}])(?:\s+(?:it|this|that|the\s+\S+|your\s+\S+))?(?:\s+yet)?`,
  String.raw`(?:لم\s+يتم|(?<!بعد\s+)(?<![\p{L}])ما\s+تم|(?:لسه|لسا|للحين)\s+ما(?:\s+تم)?)\s+(?:ال)?(?:حجز|تأكيد|تأكد|انحجز)\S*`,
  String.raw`(?<!بعد\s+)(?<![\p{L}])ما\s+(?:حجزت|أكدت|انحجز|تأكد)\S*`,
  String.raw`(?:الحجز|موعدك|المعاينة)\s+(?:(?:لسه|لسا|للحين)\s+ما\s+(?:تأكد|تم)|غير\s+مؤكد)`,
  // «(لسه) مو / غير / مش محجوز|مؤكد» (Codex r6)
  String.raw`(?<![\p{L}])(?:(?:لسه|لسا|للحين)\s+)?(?:مو|مب|مش|غير|ليس|ليست|مهو|ماهو|مهي|ماهي)\s+(?:محجوز|مؤكد)\S*`,
].join('|'), 'giu');
/** Sentences: a denial and a claim are read one sentence at a time. */
const SENTENCE_SPLIT_RE = /[.!?;؟؛\n]+/u;

/**
 * A booking sign in one sentence: a viewing word, a weekday or tomorrow, a clock time, a second-person object, "your
 * slot", or today (not about stock). Office-hours ranges are no sign.
 */
const signIn = (sentence) => {
  const s = withoutRanges(sentence);
  return VIEWING_WORD_RE.test(s) || DAY_RE.test(s) || TIME_RE.test(s) || OBJECT_RE.test(s) || YOUR_SLOT_RE.test(s) || (TODAY_RE.test(s) && !STOCK_RE.test(s));
};

/**
 * Whether the answer claims a booking (the safety net; Claude's r4 rule, Codex r1-r4). Sentence by sentence, after the
 * governed denials are cut out: a personal claim form fires on its own; a claim word (or "you're all set") fires with
 * a viewing tool anywhere in the turn, a booking sign in its own sentence, or a sign anywhere in the answer when its
 * own sentence is not about stock, price or delivery ("Sunday at 10 works. It's booked!").
 */
function claimsABooking(calls, body) {
  const viewingTool = calls.some((c) => c.name === 'viewing_slots' || c.name === 'book_viewing');
  const sentences = String(body ?? '').split(SENTENCE_SPLIT_RE).map((x) => toAsciiDigits(x.replace(FUTURE_RE, ' ').replace(GOVERNED_DENIAL_RE, ' ')));
  const answerSign = sentences.some(signIn);
  return sentences.some((s) => {
    if (PERSONAL_CLAIM_RE.test(s)) return true;
    if (!claimsBooking(s) && !EXTRA_CLAIM_RE.test(s) && !ALL_SET_RE.test(s)) return false;
    // A stock sentence needs its own sign, with a viewing tool in the turn too (Claude r6 P3-1).
    return signIn(s) || ((viewingTool || answerSign) && !STOCK_RE.test(s));
  });
}

const LINK_RE = /https?:\/\/[^\s<>"'`]+/giu;

/** A tool result or arguments as an object: JSON parsed once or twice (a Retell result may be encoded twice). */
function parsed(v) {
  let x = v;
  for (let i = 0; i < 2 && typeof x === 'string'; i += 1) {
    try { x = JSON.parse(x); } catch { return null; }
  }
  return x && typeof x === 'object' ? x : null;
}

/**
 * The turn's tool calls, in order, as `{ name, args, result, ok }` (args `{}` and result `null` when
 * unreadable): the brain's `toolCalls`, else the Retell-shaped messages paired by `tool_call_id`.
 */
export function turnToolCalls(turn) {
  if (Array.isArray(turn?.toolCalls)) {
    return turn.toolCalls.filter((c) => c && typeof c.name === 'string')
      .map((c) => ({ name: c.name, args: parsed(c.args) ?? {}, result: parsed(c.result), ok: c.ok !== false }));
  }
  const messages = Array.isArray(turn?.messages) ? turn.messages : [];
  const results = new Map();
  for (const m of messages) if (m?.role === 'tool_call_result') results.set(m.tool_call_id, m.content);
  return messages.filter((m) => m?.role === 'tool_call_invocation' && typeof m.name === 'string')
    .map((m) => ({ name: m.name, args: parsed(m.arguments) ?? {}, result: parsed(results.get(m.tool_call_id)), ok: results.has(m.tool_call_id) }));
}

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const errClass = (err) => (err && typeof err === 'object' && typeof err.name === 'string' ? err.name : typeof err);

/**
 * @typedef {{ kind: 'text', text: string, bookingId?: string }
 *   | { kind: 'document', url: string, caption: string, fileName: string, mediaKind: 'document', listingId: string }} Bubble
 * @typedef {object} DanaCommit
 * @property {(o: { lead: object, turn: object, text: string, language: 'ar'|'en', coversTs?: number })
 *   => Promise<{ bubbles: Bubble[], booking?: { bookingId: string, listingId: string, startTs: number }, handover?: { kind: 'booking_failed' } }>} afterPreSend
 *   no tool call and no claim: exactly `{ bubbles: [{ kind: 'text', text }] }` (the stub's answer)
 * @property {(o: { lead: object, booking: { bookingId: string }|null, accepted: boolean })
 *   => Promise<{ told?: boolean, handover?: { kind: 'booking_unconfirmed' } }>} afterSend
 */

/**
 * @param {{ viewing?: object, notes?: object, inventory?: object, sender?: object, maxLinks?: number,
 *           siteUrl?: string, blockedBrochures?: string[], log?: Function }} [deps]  `sender` is unused: dana-wa
 *   sends the bubbles; `maxLinks` is the caller's link cap (dana-wa MAX_LINKS), DEFAULT_MAX_LINKS without it;
 *   `siteUrl` (or inventory.siteUrl) is the one host a brochure may have besides bona-real-estate.com
 * @returns {DanaCommit}
 */
export function createDanaCommit(deps = {}) {
  const { viewing = null, notes = null, inventory = null, maxLinks = DEFAULT_MAX_LINKS, log = () => {} } = deps;
  const siteUrl = deps.siteUrl ?? inventory?.siteUrl ?? null;
  const blocked = new Set(deps.blockedBrochures ?? BLOCKED_BROCHURES);
  const exact = (ref) => {
    if (typeof inventory?.exact === 'function') return inventory.exact(ref);
    return exactListing(typeof inventory?.all === 'function' ? inventory.all() ?? [] : [], ref);
  };
  const say = (o) => { try { log(o); } catch { /* a log sink never stops a send */ } };

  async function commit(lead, call, lang) {
    if (!viewing || typeof viewing.commitBooking !== 'function') return { ok: false, reason: 'off' };
    try {
      return await viewing.commitBooking({
        lead, listingId: text(call.args.listing_id)?.toUpperCase() ?? null, slotId: text(call.args.slot_id),
        name: text(call.args.name) ?? undefined, language: lang,
      });
    } catch (err) {
      say({ level: 'error', evt: 'dana.commit_error', leadId: lead?.lead_id ?? null, error: errClass(err) });
      return { ok: false, reason: 'error' };
    }
  }

  /** The brochure documents the turn's send_brochure calls asked for as PDFs, by the inventory's URL. */
  function documents(calls) {
    const out = [];
    for (const c of calls) {
      if (c.name !== 'send_brochure' || !c.ok || c.result?.will_send !== 'pdf') continue;
      const listing = exact(c.args.listing_id);
      const url = listing ? brochureUrlOn(listing.brochureUrl, siteUrl) : null;
      if (!url || blocked.has(listing.id) || out.some((d) => d.listingId === listing.id)) continue;
      out.push({ kind: 'document', url, caption: `${listing.id} brochure`, fileName: `${listing.id}-brochure.pdf`, mediaKind: 'document', listingId: listing.id });
      if (out.length >= MAX_DOCUMENTS) break;
    }
    return out;
  }

  /** The text with the exact pin's maps link of the last send_location that said `exact`, within MAX_LINKS. */
  function withLocation(body, calls, lang) {
    const call = calls.filter((c) => c.name === 'send_location' && c.ok && c.result?.precision === 'exact').at(-1);
    if (!call) return body;
    const listing = exact(call.args.listing_id);
    if (!listing || pinOf(listing) !== 'exact') return body;
    const link = `https://maps.google.com/?q=${Number(listing.map.lat)},${Number(listing.map.lng)}`;
    const s = String(body ?? '');
    if (s.includes(link) || (s.match(LINK_RE) ?? []).length >= maxLinks) return body;
    return `${s.trimEnd()}\n\n${lang === 'en' ? 'Location' : 'الموقع'}: ${link}`;
  }

  async function afterPreSend({ lead = null, turn = null, text: answer = '', language = 'ar' } = {}) {
    const lang = language === 'en' ? 'en' : 'ar';
    const calls = turnToolCalls(turn);
    const brainTurn = Array.isArray(turn?.toolCalls);
    const leadId = lead?.lead_id ?? null;
    let body = answer;
    let booking = null;
    let handover = null;
    // The LAST book_viewing decides (Codex + Claude r1): a refused later call never books an earlier slot.
    const books = calls.filter((c) => c.name === 'book_viewing');
    const last = books.at(-1);
    const book = last && last.ok && last.result?.reserved === true ? last : null;
    // A reserved call, then one that never ran or answered (the tool limit, a throw): nothing is committed, and the
    // model's "booking it" is not sent unbacked (Claude r2 P3-1). A last call that ran and refused is the model's to answer.
    const unbacked = !book && Boolean(last) && !last.ok && books.some((c) => c.ok && c.result?.reserved === true);
    if (book) {
      const r = await commit(lead, book, lang);
      if (r?.ok === true && typeof r.text === 'string' && r.text) {
        body = r.text;
        booking = { bookingId: r.bookingId, listingId: r.listingId, startTs: r.startTs };
        say({ evt: 'dana.commit', leadId, booking: 'ok', bookingId: r.bookingId });
      } else {
        body = BOOKING_FAILED_LINE[lang];
        handover = { kind: 'booking_failed' };
        say({ evt: 'dana.commit', leadId, booking: 'failed', reason: typeof r?.reason === 'string' ? r.reason : 'error' });
      }
    } else if (unbacked) {
      body = BOOKING_FAILED_LINE[lang];
      handover = { kind: 'booking_failed' };
      say({ evt: 'dana.commit', leadId, booking: 'unbacked' });
    } else if (brainTurn && claimsABooking(calls, body)) {
      // The safety net (DESIGN §4.3): only a commit may say a viewing is booked.
      body = BOOKING_FAILED_LINE[lang];
      handover = { kind: 'booking_failed' };
      say({ evt: 'dana.commit', leadId, booking: 'claim' });
    }
    if (!booking && !handover) body = withLocation(body, calls, lang);
    const first = booking ? { kind: 'text', text: body, bookingId: booking.bookingId } : { kind: 'text', text: body };
    return {
      bubbles: [first, ...documents(calls)],
      ...(booking ? { booking } : {}),
      ...(handover ? { handover } : {}),
    };
  }

  async function afterSend({ lead = null, booking = null, accepted = false } = {}) {
    const id = typeof booking?.bookingId === 'string' && booking.bookingId ? booking.bookingId : null;
    if (!id) return {};
    const leadId = lead?.lead_id ?? null;
    if (accepted === true) {
      try { viewing?.markTold?.(id); } catch (err) { say({ level: 'error', evt: 'dana.commit_told_failed', bookingId: id, error: errClass(err) }); }
      try { notes?.booking?.(id, { told: true }); } catch (err) { say({ level: 'error', evt: 'dana.commit_note_failed', bookingId: id, error: errClass(err) }); }
      return { told: true };
    }
    // The event stays (DESIGN §8.3 step 9): the owner is told the client was not.
    try { notes?.booking?.(id, { told: false }); } catch (err) { say({ level: 'error', evt: 'dana.commit_note_failed', bookingId: id, error: errClass(err) }); }
    say({ level: 'warn', evt: 'dana.commit_untold', leadId, bookingId: id });
    return { told: false, handover: { kind: 'booking_unconfirmed' } };
  }

  return { afterPreSend, afterSend };
}
