/**
 * The code stop-word check (DESIGN §4.1 "It does not rest on the model alone", critic round 2 #7;
 * DESIGN §9.2 step 12; PLAN T12, PR-B3). It runs on a client's text BEFORE any model call: a
 * WhatsApp batch (lib/dana-wa.mjs) and, from PR-C2 (T21), an email's subject and first 600
 * characters. T21 imports this file and never edits it (PLAN §1.13).
 *
 * Three lists:
 *   - the stop list: phrases anywhere in a message (STOP_PHRASES), and a bare stop word only in a
 *     short message of at most BARE_STOP_MAX_WORDS words (STOP_WORDS), because "does the bus stop near
 *     the villa?" is an enquiry;
 *   - the data list (DATA_PHRASES): a request about the client's data, anywhere in a message.
 *     Deliberately NOT the bare words privacy / خصوصية / بياناتي / رقمي / my number: "فيلا فيها
 *     خصوصية" (a villa with privacy) and "هذه بياناتي" (here are my details) are everyday enquiry
 *     text, and a match silences the assistant in a real client's chat;
 *   - the person list (PERSON_PHRASES, email only, `{ person: true }`): phrases only, never the bare
 *     "agent" or «شخص», which enquiries use.
 * Whole words only: a phrase matches a run of whole words, never part of one ("nonstop", «موقف»).
 * Arabic is read after folding the alef and hamza forms, taa marbuta, alef maqsura, tatweel and the
 * short-vowel marks, and every text after NFKC and lower case.
 *
 * Anything subtler ("what do you do with what I sent?") rests on the model's request_human (kind
 * privacy), the second net. Nothing here logs, and nothing here reads a setting or the network.
 */

/** A bare stop word counts only in a message of at most this many words. */
export const BARE_STOP_MAX_WORDS = 4;

/** Arabic letters folded to one form; marks and tatweel dropped. */
const FOLD = [[/[آأإٱ]/g, 'ا'], [/ة/g, 'ه'], [/ى/g, 'ي'], [/ؤ/g, 'و'], [/ئ/g, 'ي']];
const MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

/** The text as the lists read it: NFKC, lower case, Arabic folded, whitespace runs to one space. */
export function normalise(text) {
  if (typeof text !== 'string') return '';
  let s = text.normalize('NFKC').toLowerCase().replace(/[‘’ʼ`]/g, "'").replace(MARKS, '');
  for (const [re, to] of FOLD) s = s.replace(re, to);
  return s.replace(/\s+/g, ' ').trim();
}

/** Whole words: letters and digits (an apostrophe inside a word stays: "don't"). */
const words = (text) => normalise(text).split(/[^\p{L}\p{N}']+/u).map((w) => w.replace(/^'+|'+$/g, '')).filter(Boolean);

export const STOP_PHRASES = Object.freeze([
  'stop replying', 'stop messaging', "don't message", 'dont message', 'do not message', 'do not contact', 'unsubscribe',
  'لا ترد', 'لا تراسل', 'توقف عن الرد', 'لا تتواصل',
]);
export const STOP_WORDS = Object.freeze(['stop', 'إيقاف', 'وقف', 'توقف', 'كفى']);
/** [phrase, kind]: a deletion request first (it holds "my data"), then the privacy phrases. */
const DATA = Object.freeze([
  ...['delete my data', 'remove my data', 'erase my data', 'delete my number', 'احذف بياناتي', 'امسح بياناتي', 'حذف بياناتي', 'احذفوا رقمي']
    .map((p) => [p, 'deletion']),
  ...['my personal data', 'personal data', 'my data', 'privacy policy', 'pdpl', 'بياناتي الشخصية', 'معلوماتي الشخصية', 'سياسة الخصوصية',
    'حماية البيانات', 'خصوصيتي'].map((p) => [p, 'privacy']),
]);
export const DATA_PHRASES = Object.freeze(DATA.map(([p]) => p));
export const PERSON_PHRASES = Object.freeze([
  'speak to a person', 'talk to a person', 'a real person', 'someone from your team', 'call me',
  'أكلم شخص', 'أتكلم مع شخص', 'التحدث إلى شخص', 'أحد من الفريق', 'موظف', 'اتصل بي', 'اتصلوا بي',
]);

const tokens = (list) => list.map((p) => words(p));
const STOP_T = tokens(STOP_PHRASES);
const STOP_W = new Set(STOP_WORDS.map((w) => normalise(w)));
const DATA_T = DATA.map(([p, kind]) => [words(p), kind]);
const PERSON_T = tokens(PERSON_PHRASES);

/** Does `phrase` (words) occur as a run of whole words in `ws`? */
function hasRun(ws, phrase) {
  if (!phrase.length || phrase.length > ws.length) return false;
  for (let i = 0; i + phrase.length <= ws.length; i += 1) {
    let ok = true;
    for (let j = 0; j < phrase.length && ok; j += 1) ok = ws[i + j] === phrase[j];
    if (ok) return true;
  }
  return false;
}

/**
 * The first list one message's text matches, or null.
 * @param {unknown} text
 * @param {{ person?: boolean }} [o]  `person: true` also reads the person list (email, DESIGN §9.2)
 * @returns {{ list: 'stop'|'data'|'person', kind: 'stop'|'privacy'|'deletion'|'person' } | null}
 */
export function matchStopWords(text, { person = false } = {}) {
  const ws = words(text);
  if (!ws.length) return null;
  for (const [phrase, kind] of DATA_T) if (hasRun(ws, phrase)) return { list: 'data', kind };
  if (STOP_T.some((p) => hasRun(ws, p))) return { list: 'stop', kind: 'stop' };
  if (ws.length <= BARE_STOP_MAX_WORDS && ws.some((w) => STOP_W.has(w))) return { list: 'stop', kind: 'stop' };
  if (person && PERSON_T.some((p) => hasRun(ws, p))) return { list: 'person', kind: 'person' };
  return null;
}
