/**
 * Dana on WhatsApp (2026-09-27 design §6, Phase 4; plan P4-6..P4-16), with PR-B3's gates, holds,
 * pacing, caps, stop words and the brain branch (DESIGN §4.1-4.2, §6; DESIGN-brain §3.5, §4; PLAN T12).
 *
 * The poller wakes this module once per client message it stores in a Bona inbox chat (`wake`,
 * never awaited); a batch timer turns a burst into one run. A run decides whether she may answer at
 * all, in this order (`eligible`): configured (by the chat's path: the brain or Retell), the instance
 * identity (once PR-INT hands in the link), the chat `in` and nobody's colleague, the own-number and
 * test rules (`rule_off`), the owner's global switch (or his test flag on this one chat), the chat's own
 * switch, the Sending switch, an open hand-over (legacy chats only), a hold, no human answer in 24 h,
 * a phone jid, a message she may answer (never first), and her caps. Then the batch: the unanswered
 * messages. On a brain chat older than 2 h it is a `missed` hand-over, 30 min to 2 h it is backlog (only on
 * a stable link, ten an hour, read from the outbox). Then, before any model call, the code stop-word check
 * (both paths) and, on a brain chat, the loop guard. Then the model, the hand-over or the answer, the reply
 * guard (brain turns), the pre-send check LAST, the commit hook (lib/dana-commit.mjs) and the bubbles
 * through the one sender (kind `dana`).
 *
 * Two paths (DESIGN-brain §3.5): `useBrain(lead) = autoMode(lead) || setting('dana_brain') === '1'`.
 *   - The brain (lib/brain.mjs `turn()`): the history from the inbox store as real role turns, masked
 *     with the batch as one series (`inboxTurn`), the batch as parts, the client record as raw fields,
 *     the earlier replies the guard passed (wa_outbox dana rows with guarded=1). No Retell chat, no
 *     `budget.take('chats')`, no `dana_chat_id`. A brain path with no configured brain is
 *     `not_configured`: it never falls back to Retell. Its sends wait for the typing floor and go through
 *     the global FIFO (lib/pacing.mjs); a turn whose text passed the guard marks its bubbles guarded=1.
 *     Its fixed lines (hand-over, closing, outage) go through the FIFO too, re-checked in the queue. Every
 *     link of its text obeys DESIGN §6.5 (`limitLinks`). Its wording is nameless (lib/persona.mjs): the
 *     disclosure by hash of the lead id; in auto mode the hand-over line is HANDOVER variant 0 inside
 *     office hours and the out-of-hours text outside them.
 *   - Retell, for legacy chats until PR-RX (T27): main's path (PLAN §2 row 7, the T12 r1/r2 rulings):
 *     main's wording (the "Dana — " disclosure, the one HANDOVER line), timing (the 2 s batch, no typing
 *     floor, no queue), freshness (30 min, a silent `old` skip), caps (6 sends an hour, 200 a day, a
 *     hand-over with the line), links (up to 3 cards, any message) and a `rate_limited` send as a
 *     send_failed hand-over (with the sender's day full, before the paid Retell call). What changes for
 *     it: the stop-word check, the sender's limits, other local refusals as a skip, and the recentContext
 *     label of her own rows, `Assistant (you)`, so the model sees no name to repeat.
 *
 * Auto mode (the owner's test chat; every stranger after go-live): an open hand-over (needs_human) is
 * the dashboard's flag and the alert's trigger, not a gate; a repeated request_human sends the model's
 * text and alerts again; a brain failure is the last resort (one holding line per outage, a 10-minute
 * `brain_out` hold that the sweep extends while the brain stays out, then an answer once it is back).
 * Notes (lib/owner-notes.mjs) are asked for in auto mode only; the ledger checks again.
 *
 * Holds of brain chats (db v8 `dana_hold_reason` / `dana_hold_until`; a reason with no time waits for a
 * person): cap_chat (her per-chat caps; the sender's rate limit, 60 s doubling to 30 min), cap_day (until
 * the day frees a turn), loop, send_failed, booking_unconfirmed, brain_out. `sweep()` (PR-INT runs it every
 * minute) re-wakes a chat whose timed hold ended (one cap_day chat per freed turn, the oldest first) and the
 * backlog that waited; an ended brain_out hold of a chat refused for another reason is cleared.
 *
 * Send failures of brain chats: only Evolution's answers count (wa-send `failure: 'evolution'`: a 4xx, a
 * 5xx, a network error, an uncertain send), read back from the outbox so a restart forgets none. Two in one
 * chat in 24 h hold it (`send_failed`, with an alert); three over the brain chats in 30 min trip the breaker
 * (dana_enabled '0' by `system`, an owner push and a note). A local refusal (the switches, bad_*) is a skip.
 * A legacy chat keeps main's send_failed hand-over and has no hold or breaker.
 *
 * A `missed` hand-over keeps what it covered with its hand-off task (`details.missed_rid`, `details.missed_at`;
 * taskMissed, r16 G4). Known gap: lib/dashboard/render-tasks.mjs (T08's file) prints `details` raw, so both show
 * on the task card until T14 hides them.
 *
 * A run that throws after Dana's outbox row is written leaves that row `pending`; start-up or daily
 * upkeep turns it `uncertain` (it may have gone), the batch counts as answered and the chat is not
 * flagged — exactly like a staff reply cut off mid-send. Her answer is the chat's first reply when it has
 * none yet (2026-10-05 design R1); a fixed line (FIXED_LINES) never is.
 *
 * Never logged: message text, a name, a number, a Retell chat id. Never rejects.
 */
import { ensureHandoff, cleanNeeds } from './lead-tasks.mjs';
import { extractActions, plainText } from './actions.mjs';
import { replyJidFor, splitMark } from './wa-send.mjs';
import { HANDOVER_TOOL } from './tools.mjs';
import { randomId } from './store.mjs';
import { REF_RE } from './attribution.mjs';
import { inboxTurn } from './brain.mjs';
import { checkReply } from './reply-guard.mjs';
import { matchStopWords, normalise } from './stop-words.mjs';
import { TIERS } from './pacing.mjs';
import {
  DISCLOSURE as NAMELESS_DISCLOSURE, HANDOVER as PERSONA_HANDOVER, HANDOVER_VARIANTS, OUT_OF_HOURS, OUTAGE_OUT_OF_HOURS,
  disclosure, disclosureFor, inOfficeHours, outageLine,
} from './persona.mjs';
// A namespace import: main's stub has no BOOKING_FAILED_LINE (it reads as undefined), PR-B4's has. Neither imports this file.
import * as danaCommitModule from './dana-commit.mjs';

export const HUMAN_QUIET_MS = 24 * 3_600_000;
export const SESSION_IDLE_MS = 23 * 3_600_000;
/** The legacy (Retell) batch window; brain chats take lib/pacing.mjs's 4-7 s. */
export const BATCH_MS = 2_000;
/** Older than this, a brain chat's message is never answered by her: a `missed` hand-over (DESIGN §4.2). */
export const FRESH_MS = 2 * 3_600_000;
/** A legacy (Retell) chat keeps main's rule until go-live (PLAN §2 row 7): older than this is a silent `old` skip. */
export const LEGACY_FRESH_MS = 30 * 60_000;
/** A legacy chat keeps main's caps (sends, not turns): 6 an hour in a chat, 200 a day; a cap is a hand-over with the line. */
export const LEGACY_PER_CHAT_PER_HOUR = 6;
export const LEGACY_PER_DAY = 200;
/** Older than this (and under FRESH_MS), a message is backlog (DESIGN §6.4). */
export const BACKLOG_MS = 30 * 60_000;
/** Backlog first-answers a rolling hour may carry (DESIGN §6.4). */
export const BACKLOG_PER_HOUR = 10;
/** Her caps per TURN (DESIGN §6.3; lib/pacing.mjs TIERS). PER_DAY is the strictest tier's, the one in force while BONA_WA_LINKED_AT is unset. */
export const PER_DAY_TIERS = Object.freeze(TIERS.map((t) => t.PER_DAY));
export const PER_DAY = PER_DAY_TIERS[0];
export const PER_CHAT_PER_10MIN = TIERS[0].PER_CHAT_PER_10MIN;
export const PER_CHAT_PER_HOUR = TIERS[0].PER_CHAT_PER_HOUR;
export const PER_CHAT_PER_DAY = TIERS[0].PER_CHAT_PER_DAY;
export const CONTEXT_MESSAGES = 10;
/** A brain chat's links (DESIGN §6.5). A legacy chat keeps main's handling: up to LEGACY_MAX_LINKS cards, any message. */
export const MAX_LINKS = TIERS[0].MAX_LINKS;
export const LEGACY_MAX_LINKS = 3;
export const MAX_ANSWER_LEN = 1500;
/** The loop guard (DESIGN §6.3): the same text this often in an hour, or more than LOOP_BURST messages in 10 min. */
export const LOOP_SAME_TEXT = 3;
export const LOOP_BURST = 20;
/** Counted send failures (DESIGN §4.2): this many in one chat in 24 h hold it; this many overall in 30 min trip the breaker. */
export const SEND_FAILS_PER_CHAT = 2;
export const SEND_FAILS_BREAKER = 3;
/** A brain outage holds a chat this long, then the sweep tries again (DESIGN-brain §4.2). */
export const BRAIN_OUT_HOLD_MS = 10 * 60_000;
/** The sender's rate limit holds a chat this long (DESIGN §4.2). */
export const RATE_HOLD_MS = 60_000;
/** request_human's kinds (DESIGN §4.3); anything else is `other`. */
export const REQUEST_KINDS = Object.freeze(['person', 'offer', 'complaint', 'contract', 'selling', 'viewing', 'other', 'stop', 'privacy', 'deletion']);
/** The label of her own rows in text-built history (the legacy Retell path): no name to repeat. */
export const ASSISTANT_LABEL = 'Assistant (you)';

/** Prefixed, in code, to her first message in a brain chat (variant 0; the others by hash, lib/persona.mjs). Nameless. */
export const DISCLOSURE = NAMELESS_DISCLOSURE;
/** Today's prefix, kept for legacy (Retell) chats until the flip: "keep Dana" in lib/persona.mjs's terms. */
export const LEGACY_DISCLOSURE = Object.freeze({ en: disclosure('en', { name: { en: 'Dana', ar: 'دانة' } }), ar: disclosure('ar', { name: { en: 'Dana', ar: 'دانة' } }) });
/** The one line a hand-over sends (P4-11); variant 0 of lib/persona.mjs, today's constant. */
export const HANDOVER = PERSONA_HANDOVER;
/** The closing line of a stop, privacy or deletion request in auto mode (DESIGN §4.1). */
export const CLOSING = Object.freeze({
  en: "Okay — I'll stop replying here; a member of our team will handle your request.",
  ar: 'حاضر، بوقف الرد هنا، وأحد أعضاء فريق بونا بيتابع طلبك.',
});
/**
 * A brain chat's answer whose links were all stripped and left no real words (DESIGN §6.5; PR-B3 r2): a short
 * neutral line instead of an `empty` hand-over. A fixed line: never an answer.
 */
export const NEUTRAL = Object.freeze({
  en: 'Happy to help — what would you like to know?',
  ar: 'حياك الله، وش تحب تعرف؟',
});
/**
 * Every fixed line code sends as a `dana` row, alone or after a disclosure line: none is an answer
 * (lib/dashboard/stats.mjs NOT_ANSWER_LINES). `bookingFailed` is lib/dana-commit.mjs's BOOKING_FAILED_LINE
 * (PR-B4), its one definition, listed whenever that module defines it. A task that adds such a line adds it here.
 * HANDOVER_VARIANTS 1-3 (lib/persona.mjs) are no longer sent (in office hours the hand-over is variant 0, PLAN T12
 * test 8); they stay listed because persona.mjs still exports them and a row with one of them is never an answer.
 */
export function fixedLinesFrom({ bookingFailed = null } = {}) {
  const extra = bookingFailed && typeof bookingFailed === 'object' ? Object.values(bookingFailed).filter((v) => typeof v === 'string' && v) : [];
  return Object.freeze([...new Set([...['en', 'ar'].flatMap((l) => [
    ...HANDOVER_VARIANTS[l], OUT_OF_HOURS[l], OUTAGE_OUT_OF_HOURS[l], CLOSING[l], NEUTRAL[l],
  ]), ...extra])]);
}

export const FIXED_LINES = fixedLinesFrom({ bookingFailed: danaCommitModule.BOOKING_FAILED_LINE });

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const LINE_MAX = 300;
const CONTEXT_MAX = 3000;
const FACT_MAX = 120;
const BATCH_MAX = 4000;
const LATENCY_RING = 500;
/** The rows masked together for one brain turn (r17): the chat's newest, before the history's 10-row cut. */
const MASK_ROWS = 200;
const ARABIC_RE = /[؀-ۿ]/;
const LATIN_RE = /[A-Za-z]/;
const PLACEHOLDER_RE = /^\[[^\]\n]{1,40}\]$/;
const LISTING_ID_RE = /\bBONA-W?\d{3}\b/i;
const LINK_RE = /https?:\/\/[^\s<>"'`]+/giu;
/**
 * The link matcher below is a SAFETY NET behind the model's own rules (prompt and the reply guard), not the gate: it
 * stops a link the model should not have written. Any new single-token edge case (an abbreviation read as a domain,
 * a domain read as text) goes to the T26 eval, not into this regex (r21: the last change to it).
 *
 * A brain chat's links (r17-r19). A candidate is a URL with a scheme, or a bare host (every dot label, the WHOLE host,
 * so `bona-real-estate.com.au` is never read as `bona-real-estate.com`) with its port and path; never inside an
 * e-mail address or another host (the lookbehind). ONE rule (r19, r20) makes a bare candidate a link when any holds:
 *   (a) it starts with `www.`;
 *   (b) its last label is 2 letters. With a path or a port (r21): a link in any case unless its first label is in
 *       LINK_ABBREVIATIONS (`Lender.co/apply` yes, `Sun.Mo/Tue` no). Without (r20): it is in LINK_TLDS (gTLDs and a
 *       curated ccTLD list that leaves out the codes that collide with abbreviations and words: no, al, mo, so, ft,
 *       ok, us, co), or the host has 3+ labels (`x.com.au`), or the host is all lowercase and the label before the
 *       last has 4+ characters (`lender.co`, `homes.us`; accepted P3s: "plot.no" is a link, "Lender.co" is text);
 *   (c) its last label is 3-24 letters with a path or a port (any TLD: `example.finance/contact`) and its first label
 *       is no abbreviation (r22: `Sun.Thu/9:00`, `Ref.BONA/001` stay text), or the last label is in LINK_TLDS;
 * and some label before the last has 2+ characters ("e.g.", "a.m.to", "U.S." stay text). Otherwise it is text:
 * `sq.ft`, `ref.no`, `Tel.no`, `Dr.Al`, `Sun.Mo`, `ok.so`, `vs.us`, `Inc.co`, `Sun.Mo/Tue`, `ref.no:12`.
 */
const LINK_TLDS = new Set(('com net org info biz io me ai app dev gov edu xyz online site store tech link page realestate properties homes '
  + 'shop estate club top live world group agency website space news blog cloud digital media house land '
  + 'sa ae qa kw bh om eg jo uk eu de fr in au ca tv ly gl to cc ws').split(' '));
/** First labels that make "x.yz/…" an abbreviation, not a link (r21): days, and the short forms property text uses. */
const LINK_ABBREVIATIONS = new Set(('sun mon tue wed thu fri sat mo tu we th fr sa su '
  + 'ref tel no sq dr mr mrs ms inc ltd co vs apt bldg flr rd st qty ph ok per plot flat unit lot blk ext pg approx al of').split(' '));
const LINK_CANDIDATE_RE = new RegExp(String.raw`https?:\/\/[^\s<>"'\x60]+|(?<![@\w./-])[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d{1,5})?(?:[/?#][^\s<>"'\x60]*)?`, 'giu');
function bareLink(candidate) {
  const rawHost = candidate.split(/[:/?#]/)[0];
  const host = rawHost.toLowerCase();
  const labels = host.split('.');
  if (labels[0] === 'www') return true;
  const last = labels[labels.length - 1];
  if (!labels.slice(0, -1).some((l) => l.length >= 2)) return false;
  // A 2-letter last label, with a path or port or without (r20): the curated list, or 3+ labels, or an all-lowercase
  // host whose label before it has 4+ characters (`lender.co`, `homes.us`; never `Inc.co`, `Sun.Mo/Tue`, `ref.no:12`).
  if (/^[a-z]{2}$/.test(last)) {
    // With a path or a port (r21): a link in any case (`Lender.co/apply`, `Finn.no/home`) unless its first label is a
    // known abbreviation (`Sun.Mo/Tue`, `ref.no/123`, `sq.ft/year`, `ref.no:12`).
    if (candidate.length > host.length) return !LINK_ABBREVIATIONS.has(labels[0]);
    return LINK_TLDS.has(last) || labels.length >= 3 || (rawHost === host && labels[labels.length - 2].length >= 4);
  }
  // A path or a port with any 3-24-letter TLD (`example.finance/contact`); otherwise the list.
  if (candidate.length > host.length && /^[a-z]{3,24}$/.test(last) && !LINK_ABBREVIATIONS.has(labels[0])) return true;
  return LINK_TLDS.has(last);
}
/** Every link of a brain chat's text, with its position (r19: removed by position, never by its first occurrence). */
function linkSpans(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(LINK_CANDIDATE_RE)) {
    if (/^https?:\/\//i.test(m[0]) || bareLink(m[0])) out.push({ index: m.index, raw: m[0] });
  }
  return out;
}
/** Every link a brain chat's text carries (r17-r19), as written (a trailing stop included). */
export const linksIn = (text) => linkSpans(text).map((l) => l.raw);
const hasLink = (text) => linksIn(text).length > 0;
/** The code-built maps link (DESIGN §4.1, §6.5): the one off-site URL a reply may carry. */
const MAPS_RE = /^https:\/\/maps\.google\.com\/\?q=-?\d{1,3}(?:\.\d+)?,-?\d{1,3}(?:\.\d+)?$/;
/** Acknowledgements the loop guard never counts as a repeat (brain chats): at most 3 words, every one of them here. */
const ACK_WORDS = new Set(['ok', 'okay', 'okey', 'k', 'thanks', 'thank', 'you', 'thx', 'ty', 'تمام', 'اوك', 'اوكي', 'شكرا', 'طيب', 'تم', '👍']);
/** Holds for a sender refusal back off (brain chats): 60 s, then twice as long each time, at most 30 min. */
const RATE_HOLD_MAX_MS = 30 * 60_000;
/** An owed line's retries while the link has not held back off the same way, at most 10 min (bounded by its 2-h mark). */
const OWED_BACKOFF_MAX_MS = 10 * 60_000;
const STOP_KINDS = new Set(['stop', 'privacy', 'deletion']);
/** Hand-overs that RECORD what already happened (r25 N14): a send that failed, a booking made but not told. Always
 * written (all `line: 'none'`): the commit point never drops them. */
const RECORDED = new Set(['send_failed', 'booking_unconfirmed', 'booking_failed']);
/** The raw lead fields the brain's client record reads (lib/brain/prompt.mjs clientTurn masks each before its clip). */
const FACT_FIELDS = ['name', 'interest', 'budget', 'district', 'listing_id', 'stage', 'timeline'];
/**
 * A counted send failure as the outbox keeps it (wa-send `failure: 'evolution'`): any `uncertain` row (only Evolution's
 * answer, or a send cut off, makes one), or a `failed` one with an Evolution error (a local refusal is `failed` too).
 */
const COUNTED_SQL = "(status = 'uncertain' OR (status = 'failed' AND (error LIKE 'http\\_%' ESCAPE '\\' OR error IN ('network','timeout','no_ack'))))";
/** The outage line's own outbox row says so in `error` (read only for failed rows elsewhere): it answers nothing (r5 N6). */
const OUTAGE_MARK = 'outage_line';
/**
 * Every other brain row says in `error` which stored client message it covers: `cov:<rowid>` (r12). On a brain chat
 * "stored after the covered message" is insertion order (rowid) ALONE (r13): Evolution stamps whole seconds, and a
 * backfill can store a message with an older ts after the batch was read. A row without it (Retell-era, or written
 * before this) covers by ts, the store's rule. The ts stays the 24-h window. Accepted limit: restoring the database
 * with VACUUM INTO may renumber rowids; the next message re-bounds it. A mark and an unsure send's reason share one
 * `error` (`<mark>|<reason>`), parsed only by wa-send's splitMark.
 */
const COV_PREFIX = 'cov:';
const covRidOf = (error) => {
  const m = splitMark(error).mark;
  return m && m.startsWith(COV_PREFIX) ? Number(m.slice(COV_PREFIX.length)) : null;
};
const isOutageRow = (error) => splitMark(error).mark === OUTAGE_MARK;
/** Skips worth a log line; the rest are states, not events (P4-15). */
const LOGGED_SKIPS = new Set(['human_recent', 'needs_human', 'lid_only', 'old', 'cap_chat', 'nothing', 'dropped_human', 'hold', 'backlog', 'loop', 'identity', 'rule_off', 'no_open_chat', 'stop_request', 'not_brain']);
/** A hand-over re-check that finds one of these does nothing at all: no flag, no alert, no line. */
// `human_recent`: a person active in the chat within 24 h owns it — no hand-over over their head.
// `sending_off`: the owner's Sending switch stops every send, the hand-over line included.
const HANDOVER_SKIPS = new Set(['dropped_human', 'human_recent', 'not_in_inbox', 'off', 'chat_off', 'sending_off', 'not_configured', 'identity', 'rule_off', 'hold', 'no_open_chat']);
/** Caps that are a hand-over with no line (DESIGN §6.3). */
const CAP_HANDOVERS = new Set(['cap_day', 'cap_chat_day']);

/** Whitespace folded, cut on whole characters. */
const oneLine = (v, max) => Array.from(String(v ?? '').replace(/\s+/g, ' ').trim()).slice(0, max).join('');
const textOrMedia = (m) => (typeof m?.text === 'string' && m.text.trim() ? m.text.trim() : (m?.media_type ?? '[message]'));
const errName = (err) => (typeof err?.name === 'string' && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'Error');
const realSleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

/** The client's language (P4-9). */
export function languageOf({ lead = null, texts = [] } = {}) {
  // A media placeholder ('[voice note]', '[image]') is not the client's writing: no language.
  const all = (Array.isArray(texts) ? texts : []).filter((t) => typeof t === 'string' && !PLACEHOLDER_RE.test(t.trim())).join('\n');
  if (ARABIC_RE.test(all)) return 'ar';
  if (LATIN_RE.test(all)) return 'en';
  return lead?.language === 'en' ? 'en' : 'ar';
}

/** What Bona knows about the client, for the legacy prompt — never the phone number (P4-8). */
export function leadFacts(lead) {
  if (!lead || typeof lead !== 'object') return '';
  const facts = [['Name', lead.name], ['Interest', lead.interest], ['Budget', lead.budget], ['District', lead.district],
    ['Listing', lead.listing_id], ['Stage', lead.stage], ['Timeline', lead.timeline]];
  return facts.filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => `${k}: ${oneLine(v, FACT_MAX)}`).join('\n');
}

const speaker = (m) => (m.direction === 'in' ? 'Client' : m.sender_kind === 'dana' ? ASSISTANT_LABEL : 'Team');

/** The conversation so far as prompt context: the newest lines that fit (P4-8). */
export function recentContext(messages, { exclude = new Set() } = {}) {
  const rows = (Array.isArray(messages) ? messages : []).filter((m) => m && !exclude.has(m.key_id));
  const lines = rows.slice(-CONTEXT_MESSAGES).map((m) => `${speaker(m)}: ${oneLine(textOrMedia(m), LINE_MAX)}`);
  while (lines.length > 1 && lines.join('\n').length > CONTEXT_MAX) lines.shift();
  return lines.join('\n').slice(0, CONTEXT_MAX);
}

/** The unanswered messages as the one message Retell is asked. */
export function batchText(messages) {
  return (Array.isArray(messages) ? messages : []).map(textOrMedia).join('\n').slice(0, BATCH_MAX);
}

/**
 * What a brain turn gets from the inbox (PLAN T12, T25 notes): `history` and `batchText` from
 * lib/brain.mjs `inboxTurn` over the chat's rows with the batch's keys excluded (the client's rows and
 * the batch masked as ONE series before any clip), and `batchParts`, one per batch message, so two of
 * them keep their boundary through the brain's own masking. When the rows read missed the batch (a
 * newer message pushed it out of the window), the batch's own rows are its parts. `batchParts` is left
 * out when there is no batch row at all: turn() takes an array over batchText even when it is empty.
 */
export function brainInput({ rows = [], batch = [], pending = batch, hideBefore = null } = {}) {
  // Every pending message (the batch, past the cap, expired) is never history (r14 I2).
  const pend = new Map();
  for (const m of [...(Array.isArray(pending) ? pending : []), ...batch]) if (m && !pend.has(m.key_id)) pend.set(m.key_id, m);
  const history = (Array.isArray(rows) ? rows : []).filter((m) => m && !pend.has(m.key_id));
  // A client row sent before the last "answer again" (r16 follow-up) is masked with its neighbours but never shown
  // to the model, not even as history: a judged stop request there must not read as one. Staff and assistant rows
  // before it stay.
  const hidden = hideBefore === null || hideBefore === undefined ? []
    : history.filter((m) => m.direction === 'in' && Number(m.ts) < Number(hideBefore)).map((m) => m.key_id);
  const exclude = new Set([...pend.keys(), ...hidden]);
  // The masking series in TRUE SEND ORDER (r16 G1): the history window's rows and every pending message, by (ts,
  // rowid), never history then batch, so a backfilled middle message stays next to its neighbours and a number split
  // across them is masked in every piece (and across the batch cap, r15). History and batch are taken from it only
  // after masking.
  const series = [...history, ...pend.values()].map((m, i) => ({ m, i }))
    .sort((a, b) => Number(a.m.ts) - Number(b.m.ts) || (Number(a.m.rid ?? NaN) - Number(b.m.rid ?? NaN)) || a.i - b.i)
    .map(({ m }) => m);
  const t = inboxTurn(series, { exclude });
  const masked = new Map();
  series.filter((m) => exclude.has(m.key_id) && m.direction === 'in').forEach((m, i) => masked.set(m.key_id, t.batchParts[i]));
  const parts = batch.map((m) => masked.get(m?.key_id)).filter((x) => typeof x === 'string');
  const out = { history: t.history, batchText: parts.join('\n') };
  if (parts.length) out.batchParts = parts;
  return out;
}

/** Cards become link lines in the client's language; a URL already in the text is not repeated (P4-10). */
export function withLinks(text, cards, language, { max = MAX_LINKS } = {}) {
  const lang = language === 'ar' ? 'ar' : 'en';
  let out = String(text ?? '').trim();
  let links = 0;
  for (const card of Array.isArray(cards) ? cards : []) {
    if (links >= max) break;
    const url = card?.url?.[lang] ?? card?.url?.en;
    if (!url) continue;
    if ([card.url?.en, card.url?.ar].some((u) => u && out.includes(u))) continue;
    const title = oneLine(card?.title?.[lang] ?? card?.title?.en ?? card?.id ?? '', 80);
    out += `${out ? '\n\n' : ''}${title ? `${title} — ` : ''}${url}`;
    links += 1;
  }
  return { text: out, links };
}

/** At most `max` characters, cut at whitespace when there is some in the second half. */
export function clip(text, max = MAX_ANSWER_LEN) {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  // Whole characters only: a surrogate pair is never split (the sender measures `.length`).
  let cut = '';
  for (const ch of s) {
    if (cut.length + ch.length > max) break;
    cut += ch;
  }
  const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return (at > max / 2 ? cut.slice(0, at) : cut).trim();
}

/** Ids and slugs the completion's tool results carried (the content is JSON, sometimes encoded twice). */
function resultIds(messages) {
  const ids = new Set();
  for (const m of messages) {
    if (m?.role !== 'tool_call_result') continue;
    let payload = m.content;
    for (let i = 0; i < 2 && typeof payload === 'string'; i += 1) {
      try { payload = JSON.parse(payload); } catch { payload = null; }
    }
    const rows = Array.isArray(payload) ? payload : payload?.results;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (typeof row?.id === 'string' && row.id) ids.add(row.id);
      if (typeof row?.slug === 'string' && row.slug) ids.add(row.slug);
    }
  }
  return ids;
}

export function handoffDetails(completion) {
  const call=(completion?.messages??[]).find(m=>m?.role==='tool_call_invocation'&&m?.name===HANDOVER_TOOL);
  let args=call?.arguments;
  try { if(typeof args==='string')args=JSON.parse(args); } catch { args=null; }
  return cleanNeeds(args&&typeof args==='object'?args:{});
}

/**
 * request_human's `kind` from the RAW tool call (DESIGN §4.2, critic round 2 #6): the brain turn's
 * normalised `toolCalls`, else the Retell completion's invocation. handoffDetails passes the arguments
 * through cleanNeeds, which strips `kind`, so it never comes from there. Not one of REQUEST_KINDS → other.
 */
export function requestKind(turn) {
  let args = null;
  const call = (Array.isArray(turn?.toolCalls) ? turn.toolCalls : []).find((c) => c?.name === HANDOVER_TOOL);
  if (call) args = call.args;
  else args = (Array.isArray(turn?.messages) ? turn.messages : []).find((m) => m?.role === 'tool_call_invocation' && m?.name === HANDOVER_TOOL)?.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = null; }
  }
  const k = args && typeof args === 'object' && typeof args.kind === 'string' ? args.kind.trim().toLowerCase() : '';
  return REQUEST_KINDS.includes(k) ? k : 'other';
}

/** The completion as WhatsApp text, and whether the model asked for a person (P4-10, P4-11). */
export function answerFrom(completion, { inventory, siteUrl, language, maxLinks = MAX_LINKS }) {
  const messages = Array.isArray(completion?.messages) ? completion.messages : [];
  const handover = messages.some((m) => m?.role === 'tool_call_invocation' && m?.name === HANDOVER_TOOL);
  const r = extractActions(messages, { inventory, siteUrl, maxCards: Math.max(MAX_LINKS, maxLinks) });
  const body = clip(plainText(r.messages.map((m) => m.text).join('\n\n')));
  // Links never go out alone: no words is the `empty` hand-over.
  if (!body) return { text: '', handover, links: 0 };
  // Only homes a tool actually returned — never the widget's local fallback search, which
  // would link homes Dana never described.
  const returned = resultIds(messages);
  const cards = r.actions.filter((a) => a.type === 'show_listing').map((a) => a.listing)
    .filter((c) => returned.has(c?.id) || returned.has(c?.slug));
  const { text, links } = withLinks(body, cards, language, { max: maxLinks });
  return { text, handover, links };
}

/** The 50th and 90th percentile (the brain's rule). */
const percentile = (values, p) => {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

/**
 * @param {object} o
 * @param {ReturnType<import('./db.mjs').openDb>} o.db
 * @param {ReturnType<import('./inbox/store.mjs').createInboxStore>} o.inbox
 * @param {ReturnType<import('./team.mjs').createTeam>} o.team
 * @param {{ sendTo: Function }} o.sender  the ONE sender (app.sender)
 * @param {{ createChat: Function, createChatCompletion: Function }|null} o.retell
 * @param {{ notify: Function, notifyOwners?: Function }|null} [o.alerts]
 * @param {object} o.inventory
 * @param {string} o.siteUrl
 * @param {string|null} o.agentId  the WhatsApp chat agent (cfg.waChatAgentId)
 * @param {(lead: object) => boolean} o.isExcludedLead
 * @param {{ refresh: Function }|null} [o.backfill]
 * @param {{ take: Function, refund: Function }|null} [o.budget]
 * @param {{ out: Function, ok: Function }|null} [o.funds]  Retell's out-of-credit watch (lib/dana-funds.mjs)
 * @param {object|null} [o.brain]  lib/brain.mjs createBrain(): `configured`, `turn()`
 * @param {object|null} [o.ownerTest]  lib/owner-test.mjs: `autoMode(lead)`, `active()`, `ownNumberOk()`
 * @param {object|null} [o.pacing]  lib/pacing.mjs createPacing()
 * @param {object|null} [o.commit]  lib/dana-commit.mjs createDanaCommit(): `afterPreSend()`
 * @param {object|null} [o.notes]  lib/owner-notes.mjs: `handover`, `stopped`, `alert`
 * @param {object|null} [o.link]  lib/wa-link.mjs: `identityOk()`, `linkStable()` (PR-INT hands it in)
 * @param {{ ownNumberFrom?: string }|null} [o.wa]  lib/wa.mjs waConfig() (PR-INT hands it in)
 * @param {number} [o.batchMs]  a test-only fixed batch window (overrides both paths' windows)
 */
export function createDana({
  db, inbox, team, sender, retell, alerts = null, inventory, siteUrl, agentId, isExcludedLead, backfill = null, budget = null, funds = null,
  now = () => Date.now(), log = () => {}, batchMs = undefined, notifyHandoff = async () => {},
  brain = null, ownerTest = null, pacing = null, commit = null, notes = null, link = null, wa = null, sleep = realSleep,
  later = (ms, fn) => { const t = setTimeout(() => { Promise.resolve().then(fn).catch(() => {}); }, ms); t.unref?.(); },
} = {}) {
  if (!db || !inbox || !team) throw new TypeError('createDana needs the store, the inbox store and the team');
  if (!sender || typeof sender.sendTo !== 'function') throw new TypeError('createDana needs the one sender (app.sender)');
  if (typeof isExcludedLead !== 'function') throw new TypeError('createDana needs isExcludedLead (lib/team.mjs)');
  const retellConfigured = Boolean(agentId && retell && typeof retell.createChat === 'function' && typeof retell.createChatCompletion === 'function');
  const brainConfigured = Boolean(brain && brain.configured === true && typeof brain.turn === 'function');
  const configured = retellConfigured || brainConfigured;
  const pace = {
    batchDelay: () => BATCH_MS, typingFloorMs: () => 0, fifo: (fn) => fn(), tier: () => ({ ...TIERS[0] }),
    ...(pacing && typeof pacing === 'object' ? pacing : {}),
  };
  const say = (entry) => { try { log(entry); } catch { /* a logger never stops an answer */ } };
  /** A collaborator that throws never stops an answer or a hand-over. */
  const safely = (fn) => { try { return fn(); } catch { return undefined; } };
  const timers = new Map();       // leadId → { timer, ts, firstAt, done, settle }
  const inflight = new Map();     // leadId → the run's promise
  const pendingAgain = new Map(); // leadId → the newest ts woken while a run was in flight
  const backlog = new Map();      // leadId → the backlog message that waits for a stable link (DESIGN §6.4)
  const backlogReserved = new Set(); // leadIds whose backlog first bubble is on its way (the 10-an-hour race)
  const latencies = [];           // the newest LATENCY_RING answers: { at, ms } (at = when it went; latency() reads 24 h)
  const rateStreak = new Map();  // leadId → the sender refusals in a row (the rate hold's back-off)
  const owedStreak = new Map();  // leadId → an owed line's backlog deferrals in a row (its back-off)
  // leadId → the message an owed line was owed for (r10): it covers that one only, never a newer message. After a
  // restart the oldest waiting message stands in (it can only leave a newer one waiting, never swallow it).
  const owedFor = new Map();
  // leadId → the covered message of the step now running ({ ts, rid }): runs of one chat never overlap (r12).
  const turnCover = new Map();
  // leadIds whose needs_human this very run set with no line (the expired set's `missed`, r15): the fresh batch's own
  // hand-over still owes the client its line, so that flag is not "a hand-over line went already".
  const silentFlag = new Set();
  // leadId → the route the running turn was made on (r27): 'legacy', 'brain' (not in auto mode) or 'auto'. The mode is
  // part of the route: an auto chat that leaves auto mode mid-turn is a flip, like a provider change.
  const turnRoute = new Map();
  let identityAlertAt = -Infinity;
  let stopped = false;            // stop() is final: no wake arms a run after it
  const stmts = {};
  const prep = (k, sql) => (stmts[k] ??= db.db.prepare(sql));

  /* ---------------- who answers, and how ---------------- */
  /** true or false; null when the owner test throws: then she does not answer at all (never a Retell fallback). */
  function autoState(lead) {
    if (!lead || !ownerTest || typeof ownerTest.autoMode !== 'function') return false;
    try { return ownerTest.autoMode(lead) === true; } catch { return null; }
  }
  const autoOf = (lead) => autoState(lead) === true;
  const brainSwitch = () => safely(() => team.getSetting('dana_brain')) === '1';
  /** DESIGN-brain §3.5: never `brain.configured` in it, so a missing key file is `not_configured`, not Retell. */
  const useBrain = (lead) => autoOf(lead) || brainSwitch();
  /** A chat's route with its mode (r27): 'legacy' (Retell), 'brain' (the brain, not in auto mode) or 'auto'. */
  const routeKey = (lead) => (!useBrain(lead) ? 'legacy' : autoOf(lead) ? 'auto' : 'brain');
  const tierAt = (t) => ({ ...TIERS[0], ...(safely(() => pace.tier(t)) ?? {}) });

  function ruleOff(lead) {
    if (lead.inbox_via === 'own_number') return safely(() => ownerTest?.ownNumberOk?.()) !== true;
    if (lead.inbox_via === 'owner_test') return safely(() => ownerTest?.active?.()) !== true;
    return false;
  }
  /** DESIGN §5.3: the instance claims Bona's own number but its identity is not proven. Only once PR-INT hands the link in. */
  const identityBlocked = () => wa?.ownNumberFrom === 'instance' && Boolean(link) && safely(() => link.identityOk?.()) !== true;

  /** Never first (DESIGN §6.1): `coversTs` is a stored client message of this chat under 24 h old. */
  function openChat(leadId, coversTs, t = now()) {
    const ts = Number(coversTs);
    if (!Number.isFinite(ts) || ts < t - DAY_MS) return false;
    return Boolean(prep('open', "SELECT 1 FROM wa_messages WHERE lead_id = ? AND direction = 'in' AND ts = ? LIMIT 1").get(String(leadId), ts));
  }

  const setHold = (leadId, reason, until) => db.updateLead(leadId, { dana_hold_reason: reason, dana_hold_until: until });
  const clearHold = (leadId) => db.updateLead(leadId, { dana_hold_reason: null, dana_hold_until: null });
  /**
   * THE one way a step ends a hold it set itself (r7): only while the chat still holds THAT reason, so a person-wait
   * hold (send_failed after a counted failure, loop, booking_unconfirmed) that replaced it meanwhile always stays.
   */
  function endOwnHold(leadId, reason) {
    if (db.getLead(leadId)?.dana_hold_reason === reason) clearHold(leadId);
  }
  /**
   * THE covered message's insertion order (r12): the running step's (turnCover), else the newest stored client message
   * of that second. Messages of the same second stored after it are newer, everywhere this boundary is read.
   */
  function coverRid(leadId, coversTs) {
    const c = turnCover.get(String(leadId));
    if (c && Number(c.ts) === Number(coversTs) && Number.isFinite(Number(c.rid))) return Number(c.rid);
    const r = prep('coverRid', "SELECT MAX(rowid) AS rid FROM wa_messages WHERE lead_id = ? AND direction = 'in' AND ts = ?").get(String(leadId), Number(coversTs));
    return Number.isFinite(Number(r?.rid)) ? Number(r.rid) : Infinity;
  }
  /** Every stored client message of the last 24 h stored after the covered one (rowid alone, r13), in insertion order. */
  function messagesAfter(leadId, coversTs, rid = coverRid(leadId, coversTs)) {
    if (!Number.isFinite(rid)) return [];
    return prep('afterRows', `SELECT rowid AS rid, * FROM wa_messages WHERE lead_id = ? AND direction = 'in' AND rowid > ? AND ts >= ?
        ORDER BY rowid`).all(String(leadId), rid, now() - DAY_MS);
  }

  /**
   * Client messages newer than `coversTs` still waiting in a brain chat get their own run (r11): when a hold ends, or
   * a bubble is dropped for a stop request, nothing newer is stranded; each reaches an answer, or its own `missed`
   * at its own 2-h mark. Inside a run the wake is queued behind it (pendingAgain), else armed now.
   */
  function rewakeNewer(leadId, coversTs) {
    if (coversTs === null || coversTs === undefined) return;
    const id = String(leadId);
    const lead = db.getLead(id);
    if (!useBrain(lead)) return;
    const rid = coverRid(id, coversTs);
    const newer = pendingFor(id, lead, { all: true }).filter((m) => Number(m.rid) > rid);
    if (!newer.length) return;
    const ts = Number(newer[newer.length - 1].ts);
    if (inflight.has(id)) pendingAgain.set(id, Math.max(pendingAgain.get(id) ?? 0, ts));
    else wake(id, ts);
  }
  /**
   * THE one way an owed or timed hold ends after the step that owned it (r11): its own reason only (endOwnHold's rule:
   * a person-wait hold that replaced it stays), the owed message forgotten, and newer waiting messages re-woken.
   */
  function endHold(leadId, { own, coversTs = null } = {}) {
    endOwnHold(leadId, own);
    owedFor.delete(String(leadId));
    rewakeNewer(leadId, coversTs);
  }
  /** A timed hold never replaces one that waits for a person (send_failed, loop, booking_unconfirmed; r3). */
  function setTimedHold(leadId, reason, until) {
    const l = db.getLead(leadId);
    if (l?.dana_hold_reason && (l.dana_hold_until === null || l.dana_hold_until === undefined)) return false;
    setHold(leadId, reason, until);
    return true;
  }
  const isOwed = (reason) => reason === 'owed_handover' || reason === 'owed_closing';
  /**
   * An ended timed hold (its deadline, holdDeadline), whatever its reason, is cleared; a hold with no time never is
   * (r3 N4). An owed line's hold (owed_*) only with `owed: true`: it ends through sendOwed, its 2-h mark or the 24-h
   * horizon, a person writing, or Dana or Sending switched off; an ordinary wake never ends it (r8).
   */
  function clearEnded(leadId, t = now(), { owed = false } = {}) {
    const l = db.getLead(leadId);
    if (isOwed(l?.dana_hold_reason) && !owed) return;
    const d = holdDeadline(l, t);
    if (d !== null && d !== Infinity && d <= t) clearHold(leadId);
  }
  /** The breaker is open: the system's own switch-off (DESIGN §4.2). It binds a per-chat test too (r3). */
  const breakerOpen = () => {
    const row = safely(() => prep('breaker', "SELECT value, updated_by FROM settings WHERE key = 'dana_enabled'").get());
    return row?.value === '0' && row?.updated_by === 'system';
  };

  /** How far back an outage of one chat reaches: past 2 h its message is `missed` (so the episode ends). */
  const outageWindow = (t) => t - FRESH_MS - BRAIN_OUT_HOLD_MS;
  /** Did this chat's holding line go in this outage? Read from the outbox, so a restart forgets nothing (r2 N1). */
  /**
   * Is an outage of this chat OPEN (r6)? Its marked holding line went inside the outage window AND after her last
   * accepted brain answer (guarded=1): a recovery reply closes the outage, so a later outage gets its own line and
   * alert. "Already lined" and "this run is a recovery" are both read here, from the outbox, never from the hold.
   */
  function openOutage(leadId, t = now()) {
    const id = String(leadId);
    const lastAnswer = Number(prep('lastGuarded', `SELECT MAX(created) AS at FROM wa_outbox WHERE lead_id = ? AND sender_kind = 'dana'
        AND status = 'accepted' AND guarded = 1`).get(id)?.at ?? 0) || 0;
    return Boolean(prep('openOutage', `SELECT 1 FROM wa_outbox WHERE lead_id = ? AND sender_kind = 'dana' AND status <> 'failed'
        AND (error = ? OR error LIKE ?) AND created >= ? AND created > ? LIMIT 1`).get(id, OUTAGE_MARK, `${OUTAGE_MARK}|%`, outageWindow(t), lastAnswer));
  }

  /** The newest stored message of a person in this chat (staff, the owner's number), or null. */
  function humanTs(leadId) {
    const v = prep('humanTs', `SELECT MAX(ts) AS ts FROM wa_messages WHERE lead_id = ? AND direction = 'out'
        AND sender_kind IN ('staff','owner_number')`).get(String(leadId))?.ts;
    return v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);
  }
  /**
   * A person active in the chat (r16 G3): the human_recent rule, a person wrote in the last 24 h (HUMAN_QUIET_MS), by
   * the lead's stamp or a stored message of his. Then no closing line goes, whatever hold the chat is on.
   */
  function personActive(lead, t = now()) {
    if (!lead) return false;
    if (Number.isFinite(lead.last_human_out_ts) && t - lead.last_human_out_ts < HUMAN_QUIET_MS) return true;
    const h = humanTs(lead.lead_id);
    return h !== null && t - h < HUMAN_QUIET_MS;
  }

  /**
   * THE waiting messages of a chat (r4 A): every reader takes them from here (the run's batch, refusedRun, the
   * sweep, a hold's deadline). A legacy chat: the store's rule, as on main. A brain chat: its client messages of
   * the last 24 h (an older one can never be answered: never first) newer than a person's answer and than every
   * row that answered them. The one row that answers nothing is an outage line (OUTAGE_MARK) inside its outage
   * window (2 h 10 min), whatever hold the chat has moved to: what it covered still waits for the recovery. A
   * hand-over, closing or neutral line answers what it covered, as on main (r5 N6). From the database: a restart
   * loses no message.
   */
  function pendingFor(leadId, lead = db.getLead(leadId), { all = false } = {}) {
    if (!useBrain(lead)) return inbox.unansweredClientMessages(leadId, { limit: all ? 1000 : CONTEXT_MESSAGES });
    const id = String(leadId);
    const t = now();
    // Two bounds (r13): the rowid of the newest message a marked brain row covered (insertion order alone), and the
    // ts a person's answer, a staff send or an unmarked row reaches (the store's rule). Waiting = after both, in 24 h.
    let ridBound = 0;
    let tsBound = t - DAY_MS;
    const human = humanTs(id);
    if (human !== null) tsBound = Math.max(tsBound, human);
    // "Let the AI answer again" (r16 G2, Claude N10): the person who pressed it judged everything before it, so nothing
    // sent before its second is waiting again (nor shown to the model again as the batch).
    const again = againFloor(id);
    if (again !== null) tsBound = Math.max(tsBound, again - 1);
    const window = outageWindow(t);
    for (const r of prep('outRows', `SELECT sender_kind, covers_ts, created, error FROM wa_outbox WHERE lead_id = ?
        AND sender_kind IN ('staff','dana') AND status <> 'failed' AND created >= ?`).all(id, t - DAY_MS)) {
      if (r.sender_kind === 'dana' && isOutageRow(r.error) && Number(r.created) >= window) continue;
      if (r.sender_kind === 'staff') { tsBound = Math.max(tsBound, Number(r.created)); continue; }
      const rid = covRidOf(r.error);
      if (rid !== null) ridBound = Math.max(ridBound, rid);
      else tsBound = Math.max(tsBound, Number(r.covers_ts ?? r.created));
    }
    const rows = prep('pendRows', `SELECT rowid AS rid, * FROM wa_messages WHERE lead_id = ? AND direction = 'in' AND rowid > ? AND ts > ?
        ORDER BY rowid`).all(id, ridBound, tsBound);
    // Coverage is a prefix (r14 I2): the batch is the FIRST messages in rowid order; the rest waits for the next turn.
    return all ? rows : rows.slice(0, CONTEXT_MESSAGES);
  }

  /**
   * THE batch builder of a brain chat (r14 I2): the pending list in rowid order; the batch is its prefix of at most
   * CONTEXT_MESSAGES (every pending message with a lower rowid than the last one taken is in it), presented in ts
   * order; it is aged by the NEWEST ts it holds and covered by its HIGHEST rowid, so the mark covers exactly that
   * prefix and anything past the cap stays pending. A legacy chat: the store's batch, as on main.
   */
  function batchOf(leadId, lead = db.getLead(leadId)) {
    if (!useBrain(lead)) {
      const batch = inbox.unansweredClientMessages(leadId, { limit: CONTEXT_MESSAGES });
      return { all: batch, batch, expired: [], coversTs: batch.length ? batch[batch.length - 1].ts : null, rid: null, expiredTs: null };
    }
    const all = pendingFor(leadId, lead, { all: true });
    // A message past its 2-h mark is a person's (r15): never in a batch, so an expired prefix never strands a fresh
    // question; the run hands the expired set over as `missed` once.
    const t = now();
    const expired = all.filter((m) => t - Number(m.ts) > FRESH_MS);
    const taken = all.filter((m) => t - Number(m.ts) <= FRESH_MS).slice(0, CONTEXT_MESSAGES);
    const batch = [...taken].sort((a, b) => Number(a.ts) - Number(b.ts) || Number(a.rid) - Number(b.rid));
    return {
      all, batch, expired,
      coversTs: taken.length ? Math.max(...taken.map((m) => Number(m.ts))) : null,
      rid: taken.length ? Math.max(...taken.map((m) => Number(m.rid))) : null,
      expiredTs: expired.length ? Math.max(...expired.map((m) => Number(m.ts))) : null,
    };
  }

  /**
   * THE deadline of a chat's hold (r4 B): null with no hold, Infinity for one that waits for a person, else its
   * time; on a brain chat no later than the waiting message's 2-h mark, so `missed` is recorded at 2 h however long
   * the hold (a day-long cap_day included). The sweep selects on it; eligible's hold gate reads it.
   */
  function holdDeadline(lead, t = now()) {
    if (!lead?.dana_hold_reason) return null;
    const until = lead.dana_hold_until;
    if (until === null || until === undefined) return Infinity;
    let d = Number(until);
    if (useBrain(lead) && d > t) {
      const { coversTs, expiredTs } = batchOf(lead.lead_id, lead);
      const mark = coversTs ?? expiredTs;
      if (mark !== null) d = Math.min(d, Number(mark) + FRESH_MS);
    }
    return d;
  }
  const activeHold = (lead, t) => {
    const d = holdDeadline(lead, t);
    return d !== null && t < d;
  };

  /** This chat's turns of the last 24 h: when each began (its first row), oldest first. */
  const turnTimes = (leadId, t) => prep('turns', `SELECT MIN(created) AS at FROM wa_outbox
      WHERE lead_id = ? AND sender_kind = 'dana' AND status <> 'failed' AND created >= ?
      GROUP BY COALESCE(covers_ts, send_id) ORDER BY at`).all(String(leadId), t - DAY_MS).map((r) => Number(r.at));

  /** When the rolling day over every chat frees a turn again (the cap's oldest turn turns 24 h old). */
  function dayFreesAt(t, cap) {
    const times = prep('dayTurns', `SELECT MIN(created) AS at FROM wa_outbox
        WHERE sender_kind = 'dana' AND status <> 'failed' AND created >= ?
        GROUP BY COALESCE(lead_id, 'jid:' || jid), COALESCE(covers_ts, send_id) ORDER BY at`).all(t - DAY_MS).map((r) => Number(r.at));
    // +1: countDanaTurns counts a turn created exactly 24 h ago as still in the day.
    return times.length >= cap ? times[times.length - cap] + DAY_MS + 1 : t + MINUTE_MS;
  }

  /**
   * Her caps. A brain chat's count TURNS by tier (DESIGN §6.3): the day over every chat, then this chat's day,
   * 10 minutes and hour. A legacy (Retell) chat keeps main's: sends, 6 an hour in the chat and 200 a day.
   */
  function capFor(lead, t, viaBrain) {
    if (!viaBrain) {
      if (inbox.countDanaSends({ leadId: lead.lead_id, sinceTs: t - HOUR_MS }) >= LEGACY_PER_CHAT_PER_HOUR) return { ok: false, reason: 'cap_chat' };
      if (inbox.countDanaSends({ sinceTs: t - DAY_MS }) >= LEGACY_PER_DAY) return { ok: false, reason: 'cap_day' };
      return null;
    }
    const caps = tierAt(t);
    if (inbox.countDanaTurns({ sinceTs: t - DAY_MS }) >= caps.PER_DAY) return { ok: false, reason: 'cap_day', until: dayFreesAt(t, caps.PER_DAY) };
    const day = turnTimes(lead.lead_id, t);
    if (day.length >= caps.PER_CHAT_PER_DAY) return { ok: false, reason: 'cap_chat_day' };
    let until = null;
    for (const [win, cap] of [[10 * MINUTE_MS, caps.PER_CHAT_PER_10MIN], [HOUR_MS, caps.PER_CHAT_PER_HOUR]]) {
      const inWin = day.filter((at) => at > t - win);
      if (inWin.length >= cap) until = Math.max(until ?? 0, inWin[inWin.length - cap] + win);
    }
    return until === null ? null : { ok: false, reason: 'cap_chat', until };
  }

  /** The gates (DESIGN §4.1). Its result only: eligibleRead() also says which route it read (r30). */
  function eligible(leadId, opts = {}) {
    return eligibleRead(leadId, opts).e;
  }
  function eligibleRead(leadId, { ts = null, coversTs = null } = {}) {
    const lead = db.getLead(leadId);
    if (autoState(lead) === null) return { e: { ok: false, reason: 'not_configured' }, route: null };
    const viaBrain = useBrain(lead);
    // The mode, read once with the provider (r30): the route this call read, and its auto gate, are the same read.
    const auto = autoOf(lead);
    const route = !viaBrain ? 'legacy' : auto ? 'auto' : 'brain';
    const out = (e) => ({ e, route });
    if (!(viaBrain ? brainConfigured : retellConfigured)) return out({ ok: false, reason: 'not_configured' });
    if (identityBlocked()) return out({ ok: false, reason: 'identity' });
    if (!lead || lead.inbox_state !== 'in' || isExcludedLead(lead)) return out({ ok: false, reason: 'not_in_inbox' });
    if (ruleOff(lead)) return out({ ok: false, reason: 'rule_off' });
    if (breakerOpen() || !(team.danaEnabled() || Number(lead.dana_test) === 1)) return out({ ok: false, reason: 'off' });
    if (Number(lead.dana_off) === 1) return out({ ok: false, reason: 'chat_off' });
    // Every send stops with the Sending switch; asking for an answer that cannot go would only
    // spend money and end in a hand-over.
    if (!team.sendingEnabled()) return out({ ok: false, reason: 'sending_off' });
    // In auto mode an open hand-over is the dashboard's flag, not a gate (DESIGN §4.2).
    if (!auto && Number(lead.needs_human) === 1) return out({ ok: false, reason: 'needs_human' });
    const t = now();
    // Holds gate the brain route only (r29): a legacy chat writes none and main has none, so a brain-route hold an owner
    // switch left behind never gates Retell.
    if (viaBrain && activeHold(lead, t)) return out({ ok: false, reason: 'hold' });
    if (Number.isFinite(lead.last_human_out_ts) && t - lead.last_human_out_ts < HUMAN_QUIET_MS) return out({ ok: false, reason: 'human_recent' });
    if (!replyJidFor(lead)) return out({ ok: false, reason: 'lid_only' });
    if (coversTs !== null && coversTs !== undefined && !openChat(lead.lead_id, coversTs, t)) return out({ ok: false, reason: 'no_open_chat' });
    if (ts != null && Number.isFinite(Number(ts)) && Number(ts) < t - (viaBrain ? FRESH_MS : LEGACY_FRESH_MS)) return out({ ok: false, reason: 'old' });
    const cap = capFor(lead, t, viaBrain);
    if (cap) return out(cap);
    return out({ ok: true, lead, brain: viaBrain, auto });
  }

  /* ---------------- Retell (legacy chats, until PR-RX) ---------------- */
  const failure = (err) => (Number.isInteger(err?.status) ? { status: err.status } : { error: err?.name === 'RetellError' ? 'request' : 'error' });
  // The funds watch (R2): a 402 from any Retell call is `out`, only a completion that worked
  // is `ok`. It never throws, and is guarded anyway.
  const funded = () => { try { funds?.ok(); } catch { /* the answer goes on */ } };
  const refused = (err) => {
    if (err?.status !== 402) return;
    try { funds?.out(); } catch { /* the hand-over goes on */ }
  };

  /**
   * The Retell chat for this WhatsApp chat: the stored one while fresh, else a new one (P4-8).
   * `fresh` forces a new one (the stored chat just failed). `created` says a chat was made.
   */
  async function session(lead, batch, language, { fresh = false, gate = null } = {}) {
    const t = now();
    if (!fresh && lead.dana_chat_id && Number.isFinite(lead.dana_chat_ts) && t - lead.dana_chat_ts < SESSION_IDLE_MS) return { chatId: lead.dana_chat_id, created: false };
    // The route before the Retell request (r27): nothing goes to Retell once the chat left this route.
    const gated = gate?.();
    if (gated) return { gated };
    if (budget && !budget.take('chats')) return { error: 'budget' };
    try {
      const exclude = new Set(batch.map((m) => m.key_id));
      const chat = await retell.createChat({
        agent_id: agentId,
        retell_llm_dynamic_variables: {
          channel: 'whatsapp',
          language,
          lead_facts: leadFacts(lead),
          recent_messages: recentContext(inbox.messagesFor(lead.lead_id, { limit: CONTEXT_MESSAGES + batch.length }), { exclude }),
        },
        metadata: { source: 'bona-whatsapp', lead_id: lead.lead_id },
      });
      if (typeof chat?.chat_id !== 'string' || !chat.chat_id) throw new Error('no chat id');
      db.updateLead(lead.lead_id, { dana_chat_id: chat.chat_id, dana_chat_ts: t });
      say({ evt: 'dana.session', leadId: lead.lead_id, renewed: Boolean(lead.dana_chat_id) });
      return { chatId: chat.chat_id, created: true };
    } catch (err) {
      if (budget) budget.refund('chats');
      refused(err);
      say({ level: 'warn', evt: 'dana.retell_failed', leadId: lead.lead_id, ...failure(err) });
      return { error: 'retell_error' };
    }
  }

  /** Ask the model; a reused chat that fails (ended on Retell's side, say) is replaced once. */
  async function complete(lead, batch, language, gate = null) {
    const content = batchText(batch);
    const ask = async (chatId) => {
      const completion = await retell.createChatCompletion({ chat_id: chatId, content });
      funded();
      return completion;
    };
    // THE route and eligibility, synchronously before every Retell request (r27): createChat, the completion, and the
    // retry with a new session. `gated` ends the turn with nothing sent to Retell.
    const failed = (err) => {
      refused(err);
      say({ level: 'warn', evt: 'dana.retell_failed', leadId: lead.lead_id, ...failure(err) });
    };
    let s = await session(lead, batch, language, { gate });
    if (s.error || s.gated) return s;
    const g1 = gate?.();
    if (g1) return { gated: g1 };
    try {
      return { completion: await ask(s.chatId), newChat: s.created };
    } catch (err) {
      failed(err);
      if (s.created) return { error: 'retell_error' };
    }
    const g2 = gate?.();
    if (g2) return { gated: g2 };
    s = await session(lead, batch, language, { fresh: true, gate });
    if (s.error || s.gated) return s;
    const g3 = gate?.();
    if (g3) return { gated: g3 };
    try {
      return { completion: await ask(s.chatId), newChat: true };
    } catch (err) {
      failed(err);
      return { error: 'retell_error' };
    }
  }

  /* ---------------- the brain ---------------- */
  const introducedOf = (lead) => Number(lead.dana_introduced) === 1 || inbox.countDanaSends({ leadId: lead.lead_id, sinceTs: 0 }) > 0;
  /** The texts of this lead's earlier replies the guard passed (DESIGN-brain §5.4): guarded=1 dana rows WhatsApp took. */
  const guardedReplies = (leadId) => prep('guarded', `SELECT text FROM wa_outbox WHERE lead_id = ? AND sender_kind = 'dana' AND status = 'accepted'
      AND guarded = 1 AND text IS NOT NULL ORDER BY created DESC LIMIT 50`).all(String(leadId)).map((r) => r.text);
  const rawFacts = (lead) => Object.fromEntries(FACT_FIELDS.map((k) => [k, typeof lead[k] === 'string' ? lead[k] : null]));

  async function think(lead, batch, language, auto, pendingAll = batch) {
    // History never holds a pending message (one past the cap included); the batch is passed whole (r14 I2).
    const pendingKeys = new Set(pendingAll.map((m) => m.key_id));
    // The MASKING window, with each row's rowid (true send order, r16 G1): the chat's newest MASK_ROWS rows (every client
    // row of 24 h in all but a flood), never only the model's 10 history rows (r17): inboxTurn masks them all as one
    // series with every pending message, and only then takes the 10 history rows, so the LIMIT never cuts a number.
    const rows = prep('ctxRows', 'SELECT rowid AS rid, * FROM wa_messages WHERE lead_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?')
      .all(String(lead.lead_id), MASK_ROWS).map((r) => ({ ...r })).reverse()
      .filter((m) => !pendingKeys.has(m.key_id));
    const input = brainInput({ rows, batch, pending: pendingAll, hideBefore: againFloor(lead.lead_id) });
    try {
      const turn = await brain.turn({
        route: 'wa', leadId: lead.lead_id, language, autoMode: auto, ...input, leadFacts: rawFacts(lead),
        turnContext: { firstReply: !introducedOf(lead) }, earlierReplies: guardedReplies(lead.lead_id), deadlineMs: 40_000,
      });
      return turn && typeof turn === 'object' ? turn : { ok: false, code: 'bad_response' };
    } catch {
      return { ok: false, code: 'bad_response' };
    }
  }

  /* ---------------- sending ---------------- */
  /**
   * One message out through the one sender (P4-12, P4-14). Her outbox row goes in FIRST, with
   * `covers_ts` = the newest client message this answers and the text normalised the way a
   * staff reply is (the poller matches an unconfirmed send by exact text), so a client message
   * stamped while she composed is not counted as answered, and a crash mid-send leaves a row.
   * `answer` says it is her answer, not a fixed line: only an answer that went is the chat's
   * first reply (R1). `viaBrain` picks the nameless disclosure and leaves the Retell chat alone;
   * `guarded` marks the row as a reply the guard passed; `document` sends a brochure.
   */
  async function send(lead, text, language, coversTs, { answer = false, viaBrain = false, guarded = false, document = null, mark = null } = {}) {
    // Introduced = the flag OR any Dana row for this chat that is not `failed` (P4-12): a run
    // that crashed after its row was written may have sent her first message without setting
    // the flag. Read before this run's own row goes in. A purge stubs rows with lead_id NULL,
    // so a chat that comes back is introduced again.
    const introduced = introducedOf(lead);
    const prefix = viaBrain ? disclosureFor(lead.lead_id, language) : LEGACY_DISCLOSURE[language];
    const body = (introduced ? text : `${prefix}\n\n${text}`).replace(/\r\n?/g, '\n').trim();
    const jid = replyJidFor(lead);
    const sendId = `SND-${now().toString(36)}-${randomId(8)}`;
    // The outage line's mark, or (any other brain row) the covered message by insertion order (r12), written with the
    // row in one transaction; an unsure answer keeps it in wa-send's own write (`<mark>|<reason>`, r13).
    const cov = viaBrain ? coverRid(lead.lead_id, coversTs) : Infinity;
    const markVal = mark ?? (viaBrain && Number.isFinite(cov) ? `${COV_PREFIX}${cov}` : null);
    const ins = db.transaction(() => {
      const r0 = inbox.insertOutbox({
        send_id: sendId, lead_id: lead.lead_id, jid, text: body, user_id: null, sender_kind: 'dana', status: 'pending', covers_ts: coversTs,
        media_kind: document ? 'document' : null,
      });
      if (r0.inserted && guarded) prep('guard', 'UPDATE wa_outbox SET guarded = 1 WHERE send_id = ?').run(sendId);
      if (r0.inserted && markVal) prep('mark', 'UPDATE wa_outbox SET error = ? WHERE send_id = ?').run(markVal, sendId);
      return r0;
    });
    if (!ins.inserted) return { sent: false, error: 'bad_send_id', failure: 'local' };
    const out = await sender.sendTo({ jid, text: body, kind: 'dana', leadId: lead.lead_id, sendId, ...(document ? { document } : {}) });
    const t = now();
    const ownChat = viaBrain ? {} : { dana_chat_ts: t };
    if (out.ok) {
      const startedAt = Number.isFinite(ins.row?.created) ? ins.row.created : t;
      try {
        db.transaction(() => {
          const fresh = db.getLead(lead.lead_id);
          if (fresh?.inbox_state !== 'in') return;
          inbox.upsertMessage({
            key_id: out.keyId, lead_id: lead.lead_id, jid, direction: 'out', sender_kind: 'dana', text: body,
            media_type: document ? '[document]' : null, ts: Math.floor(startedAt / 1000) * 1000, status: 'sent',
          });
          // The client was answered: the Hermes `bona-unanswered-leads` watchdog reads this
          // column (same rule as a staff reply, lib/wa-send.mjs). Never a fixed line.
          const firstReply = answer && fresh.first_reply_ts == null ? { first_reply_ts: t } : {};
          db.updateLead(lead.lead_id, { ...ownChat, dana_introduced: 1, ...firstReply });
        });
      } catch (err) {
        say({ level: 'error', evt: 'dana.record_failed', leadId: lead.lead_id, name: errName(err) });
      }
      return { sent: true, accepted: true, chars: body.length };
    }
    if (out.uncertain) {
      db.transaction(() => {
        if (db.getLead(lead.lead_id)?.inbox_state !== 'in') return;
        db.updateLead(lead.lead_id, { ...ownChat, dana_introduced: 1 });
      });
      return { sent: true, chars: body.length, uncertain: true };
    }
    const error = /^[a-z0-9_-]{1,40}$/.test(String(out.error ?? '')) ? out.error : 'error';
    say({ level: 'warn', evt: 'dana.send_failed', leadId: lead.lead_id, error });
    return { sent: false, error, failure: out.failure === 'evolution' ? 'evolution' : 'local' };
  }

  /** One chat's counted send failures (DESIGN §4.2): Evolution's answers only, read back from the outbox. */
  const chatFailures = (leadId, sinceTs) => prep('failsChat', `SELECT COUNT(*) AS n FROM wa_outbox
      WHERE sender_kind = 'dana' AND created >= ? AND ${COUNTED_SQL}
      AND lead_id = ?`).get(sinceTs, String(leadId)).n;
  /** The brain chats' counted failures since `sinceTs`, from the outbox (the breaker is brain/auto only; a restart forgets none). */
  function brainFailuresSince(sinceTs) {
    return prep('failsBy', `SELECT lead_id, COUNT(*) AS n FROM wa_outbox WHERE sender_kind = 'dana' AND created >= ?
        AND ${COUNTED_SQL} AND lead_id IS NOT NULL GROUP BY lead_id`).all(sinceTs)
      .reduce((n, r) => n + (safely(() => useBrain(db.getLead(r.lead_id))) === true ? Number(r.n) : 0), 0);
  }

  /**
   * After a counted failure on a brain chat (DESIGN §4.2; legacy chats keep main's hand-over only): the chat's
   * hold at the second in 24 h, with its alert (an uncertain send included), then the breaker at the third in
   * 30 min over the brain chats. True when the chat is now held.
   */
  function afterFailure(lead, { alert = false } = {}) {
    const t = now();
    let held = false;
    if (chatFailures(lead.lead_id, t - DAY_MS) >= SEND_FAILS_PER_CHAT) {
      setHold(lead.lead_id, 'send_failed', null);
      held = true;
      say({ level: 'warn', evt: 'dana.hold', leadId: lead.lead_id, reason: 'send_failed' });
      if (alert) {
        if (alerts) safely(() => alerts.notify(lead.lead_id, { reason: 'needs_human' }));
        if (autoOf(lead)) noteHandover(lead, { kind: 'send_failed' });
      }
    }
    // It trips whatever the global switch says (r4 D): with it owner-off, test chats still send, and the
    // breaker then blocks them too (breakerOpen).
    if (brainFailuresSince(t - 30 * MINUTE_MS) >= SEND_FAILS_BREAKER && !breakerOpen()) {
      team.setSetting('dana_enabled', '0', { by: 'system' });
      say({ level: 'error', evt: 'dana.breaker' });
      safely(() => alerts?.notifyOwners?.({ reason: 'dana_paused' }));
      safely(() => notes?.alert?.('breaker', {}));
    }
    return held;
  }

  /**
   * The pre-send check (P4-13), for an answer and a hand-over alike: the chat as WhatsApp has
   * it now, then a person's answer since the batch, then the lead again (freshness aside), never
   * first included.
   */
  async function preSend(leadId, coversTs) {
    const lead = db.getLead(leadId);
    if (lead && backfill && typeof backfill.refresh === 'function') {
      try { await backfill.refresh(lead); } catch { /* the checks below read what is stored */ }
    }
    // A person's answer stored by the refresh also stamps `last_human_out_ts`, so the re-check
    // alone would say `human_recent`; it is named for what happened — `dropped_human`.
    if (inbox.humanOutboundAfter(leadId, coversTs)) return { ok: false, reason: 'dropped_human' };
    return eligible(leadId, { coversTs });
  }

  const skip = (leadId, reason) => {
    if (LOGGED_SKIPS.has(reason)) say({ evt: 'dana.skipped', leadId, reason });
    return { skipped: reason };
  };

  /** The owner's hand-over note (auto mode; the ledger checks again). */
  const noteHandover = (lead, o) => safely(() => notes?.handover?.(lead, o));

  /**
   * A fixed line (hand-over, closing, outage). A brain chat's goes through the global FIFO and its send
   * failures count like an answer's (DESIGN §6.2, §4.2); a legacy chat's goes at once, as on main.
   */
  async function sendFixed(lead, text, language, coversTs, viaBrain, { closing = false, mark = null, owed = null, legacyText = null } = {}) {
    if (!viaBrain) return send(lead, text, language, coversTs);
    const wait = safely(() => pace.typingFloorMs({ chars: text.length, newestTs: coversTs })) ?? 0;
    if (wait > 0) await sleep(wait);
    const r = await pace.fifo(async (release) => {
      const g = sendGate(lead.lead_id, coversTs, { fixed: true, closing, owed });
      if (!g.ok) {
        release?.();
        return { sent: false, stopped: g.stopped, cap: g.cap ?? null };
      }
      if (g.reserve) backlogReserved.add(lead.lead_id);
      try {
        return await send(db.getLead(lead.lead_id), text, language, coversTs, { viaBrain: true, mark });
      } finally {
        if (g.reserve) backlogReserved.delete(lead.lead_id);
      }
    });
    // A hand-over or closing line decided on the brain route whose chat left it while the line waited (r23 P3): it goes
    // the legacy way (main's line, at once), so the client is not left without it. Never an outage or owed line.
    if (r.stopped === 'not_brain' && legacyText) {
      // Through the commit point first (r24): the legacy route still, and the chat's own checks, right before the send.
      // The 2-h mark binds the closing line too (r26), as the brain gate's own check does: the stop stays recorded.
      const cp = commitPoint(lead.lead_id, false, coversTs, { closing, deadline: true });
      // Past the 2-h mark in the queue: `missed` (handover() marks the task and notes it; r25), never the line.
      if (cp) return { sent: false, stopped: cp.skipped === 'missed' ? 'missed' : 'not_brain', legacy: cp.skipped !== 'missed' };
      return { ...(await send(db.getLead(lead.lead_id) ?? lead, legacyText, language, coversTs)), legacy: true };
    }
    if (r.uncertain || (!r.sent && r.failure === 'evolution')) afterFailure(lead, { alert: true });
    return r;
  }

  /**
   * THE send-time gate of a brain chat (r4 C), run inside the FIFO right before each send: model bubbles, fixed
   * lines (hand-over, closing, outage) and documents alike. It re-checks, at that moment:
   *   - the chat: in the inbox and nobody's colleague, the instance identity, the own-number/test rules, the
   *     breaker and the switches (Dana, Sending), the chat's own stop (a closing line excepted), a person who
   *     wrote since the batch, a phone jid, never first;
   *   - the message's age: past 2 h `missed` (a first bubble or any fixed line: no client line then); past 30 min
   *     the backlog allowance for a first bubble (stable link, ten an hour, a place held while it goes);
   *   - a model bubble only (a fixed line goes as part of the action that set its own hold or stop): an active
   *     hold, an open hand-over on a non-auto chat, a person active in 24 h, and for a first bubble the caps
   *     (a continuation of a turn already counted passes them);
   *   - a document: the per-chat and the global day caps, from the outbox (the FIFO serialises the sends, so the
   *     count is exact); over either it goes as its link (`asLink`).
   * @returns {{ ok: true, reserve?: true, asLink?: true } | { ok: false, stopped: string, cap?: object }}
   */
  function sendGate(leadId, coversTs, { fixed = false, closing = false, first = false, backlog: isBacklogTurn = false, document = false, owed = null } = {}) {
    const t = now();
    const no = (stopped, extra = {}) => ({ ok: false, stopped, ...extra });
    const l = db.getLead(leadId);
    if (!l || l.inbox_state !== 'in' || isExcludedLead(l)) return no('not_in_inbox');
    // A stop, privacy or deletion request stored after what this bubble covers wins (r11): the bubble does not go
    // (the closing line itself excepted), and the chat is woken so the stop flow runs.
    if (!closing) {
      // Every message after the covered one (by insertion order, never ts alone), within 24 h, however many (r12).
      const later = messagesAfter(leadId, coversTs);
      const hit = later.find((m) => typeof m.text === 'string' && matchStopWords(m.text));
      if (hit) {
        const id = String(leadId);
        pendingAgain.set(id, Math.max(pendingAgain.get(id) ?? 0, Number(later[later.length - 1].ts)));
        return no('stop_request');
      }
    }
    // An owed retry goes only while its own hold is still on the row and due: a send_failed set meanwhile, or a
    // back-off extended by another retry, stops a stale queued one (r8).
    // Due = its deadline (holdDeadline: its time or the 2-h mark, whichever first), the same clock the sweep wakes on (r9).
    if (owed && (l.dana_hold_reason !== owed || holdDeadline(l, t) > t)) return no('hold');
    // A hold that waits for a person (send_failed, loop, booking_unconfirmed) stops a fixed line too (r8).
    if (fixed && l.dana_hold_reason && (l.dana_hold_until === null || l.dana_hold_until === undefined)) return no('hold');
    // The chat's own checks, whatever its route (chatRefusal: identity, a rule off, Dana off, Sending off, the chat
    // stopped, a person's answer after what this covers).
    const refused = chatRefusal(l, coversTs, { closing, deadline: fixed && !closing });
    if (refused) return no(refused);
    // A person active in the chat: no closing line over him (r16 G3), the same 24-h rule as stopFirst's.
    if (closing && personActive(l, t)) return no('human_recent');
    if (!replyJidFor(l)) return no('lid_only');
    // The chat left the turn's route while the bubble was queued (dana_brain off, out of auto mode; r11), the mode
    // included (r30: an auto-only line, the outage line, the auto closing or NEUTRAL line, never goes once the chat is
    // 'brain'). Checked only AFTER the chat's own checks (r24), so not_brain (a re-queue, or a hand-over line's legacy
    // fallback, which checks its own route) means the chat could take a line on its new route.
    const turnKey = turnRoute.get(String(leadId));
    const nowKey = routeKey(l);
    if (nowKey === 'legacy' || (turnKey && turnKey !== 'legacy' && nowKey !== turnKey)) return no('not_brain');
    if (!openChat(leadId, coversTs, t)) return no('no_open_chat');
    const age = t - Number(coversTs);
    if ((first || fixed) && age > FRESH_MS) return no('missed');
    let reserve = false;
    if (!fixed) {
      if (activeHold(l, t)) return no('hold');
      if (!autoOf(l) && Number(l.needs_human) === 1) return no('needs_human');
      if (Number.isFinite(l.last_human_out_ts) && t - l.last_human_out_ts < HUMAN_QUIET_MS) return no('human_recent');
    }
    // A first bubble and every fixed line (a turn of its own) take the caps and the backlog gate (r5).
    if (first || fixed) {
      const cap = capFor(l, t, true);
      if (cap) return no(cap.reason, { cap });
      if (isBacklogTurn || age > BACKLOG_MS) {
        if (!backlogAllowed(t, { except: leadId })) return no('backlog');
        reserve = true;
      }
    }
    if (document) {
      const caps = tierAt(t);
      const since = t - DAY_MS;
      const chatDocs = prep('docsChat', `SELECT COUNT(*) AS n FROM wa_outbox WHERE lead_id = ? AND sender_kind = 'dana' AND media_kind = 'document'
          AND status <> 'failed' AND created >= ?`).get(String(leadId), since).n;
      const allDocs = prep('docsAll', `SELECT COUNT(*) AS n FROM wa_outbox WHERE sender_kind = 'dana' AND media_kind = 'document'
          AND status <> 'failed' AND created >= ?`).get(since).n;
      if (chatDocs >= caps.DOCS_PER_CHAT_PER_DAY || (caps.DOCS_PER_DAY !== null && allDocs >= caps.DOCS_PER_DAY)) return { ok: true, reserve, asLink: true };
    }
    return { ok: true, reserve };
  }

  /** In auto mode inside office hours the hand-over line is HANDOVER variant 0 (PLAN T12 test 8); outside, the out-of-hours text. */
  const autoHandoverLine = (language, at) => (inOfficeHours(at) ? HANDOVER[language] : OUT_OF_HOURS[language]);

  /**
   * The hand-over (P4-11): the flag first, then the alert, then the one line — unless it went
   * already. A person who answered meanwhile, or the chat leaving the inbox or switched off,
   * means nothing at all happens. `line`: 'handover' (today's constant on a legacy chat, the
   * time-aware line in auto mode), 'closing' (a stop request in auto mode: it goes even with a
   * hand-over open) or 'none'. `stop` also sets dana_off; `note` is what the owner's note is
   * (`{ kind, reason }` for a hand-over note, `{ stopped }` for a stopped one; auto mode only).
   */
  async function handover(leadId, language, why, coversTs, { checked = false, details = {}, line = 'handover', stop = false, note = null, viaBrain = false, rid = null } = {}) {
    if (!checked) {
      const pre = await preSend(leadId, coversTs);
      if (!pre.ok && HANDOVER_SKIPS.has(pre.reason)) return skip(leadId, pre.reason);
    }
    const fresh = db.getLead(leadId);
    if (!fresh || fresh.inbox_state !== 'in') return skip(leadId, 'not_in_inbox');
    // THE commit point before any state write (r24): the route (a flip writes nothing and re-queues) and, on a brain
    // chat, its own checks. A stop request is always recorded, on any route and with no line when they fail (r15).
    // A legacy chat: the route only, so it is main's hand-over when nothing flips.
    // A hand-over that records what already happened (RECORDED, r25 N14) is exempt too: dropping it leaves nobody told.
    const record = stop || RECORDED.has(why);
    const cp = commitPoint(leadId, viaBrain, coversTs, { route: !record, chat: viaBrain && !record });
    if (cp) return cp;
    // Past the 2-h mark a brain chat's message is a person's: the hand-over is `missed`, with no line (r5).
    // A stop request still stops the chat.
    // A RECORDED hand-over (a send that failed, a booking not told; r26) keeps its own reason past 2 h: only a
    // prospective hand-over becomes `missed`.
    if (viaBrain && !stop && !RECORDED.has(why) && why !== 'missed' && now() - Number(coversTs) > FRESH_MS) {
      return handover(leadId, language, 'missed', coversTs, { checked: true, line: 'none', note: { kind: 'missed' }, viaBrain });
    }
    const auto = autoOf(fresh);
    const already = Number(fresh.needs_human) === 1 && !silentFlag.has(String(leadId));
    let taskId = null; // the hand-off task actually used (a reused open one keeps its id, r7)
    db.transaction(() => {
      if (!already) inbox.setNeedsHuman(leadId, 1);
      taskId = ensureHandoff(db, { leadId, source: 'dana', reason: why, details, now: now() })?.task_id ?? null;
      // A `missed` hand-over marks the task actually used, a reused open one included (r8).
      if (why === 'missed') taskMissed(taskId, { leadId, rid: rid ?? coverRid(leadId, coversTs) });
      if (stop) db.updateLead(leadId, { dana_off: 1 });
      // A run that ends in a hand-over ends an outage hold: no re-run of a paid turn every minute (r5 N5).
      endOwnHold(leadId, 'brain_out');
    });
    if (alerts) safely(() => alerts.notify(leadId, { reason: 'needs_human' }));
    if (auto && note?.stopped) safely(() => notes?.stopped?.(fresh, note.stopped));
    else if (auto && note) noteHandover(fresh, { kind: note.kind, coversTs, ...(note.reason ? { reason: note.reason } : {}) });
    // A chat that turned lid-only meanwhile has no phone jid to send to: flagged and alerted
    // like any hand-over, but no line — as if it had gone already (Task 6 re-review).
    const noJid = !replyJidFor(fresh);
    let text = null;
    if (line === 'closing') text = auto ? CLOSING[language] : HANDOVER[language];
    else if (line === 'handover' && !already) text = auto ? autoHandoverLine(language, now()) : HANDOVER[language];
    const r = !text || noJid ? { sent: false } : await sendFixed(fresh, text, language, coversTs, viaBrain, { closing: line === 'closing', legacyText: HANDOVER[language] });
    const sent = Boolean(r.sent);
    let outcome = why;
    if (r.stopped === 'missed') {
      // The line reached the queue past the 2-h mark: recorded as missed (the task too, r6), no line (r5).
      outcome = 'missed';
      taskMissed(taskId, { leadId, rid: rid ?? coverRid(leadId, coversTs) });
      if (auto) noteHandover(fresh, { kind: 'missed', coversTs });
    } else if (viaBrain && !r.legacy) {
      // Deferred by the backlog gate, a cap or the sender's rate limit: the line is OWED (r6), like an outage line; the
      // sweep sends it itself. A brain chat's only (r8 N7): a legacy line goes at once or not at all, as on main.
      oweLine(leadId, line === 'closing' ? 'owed_closing' : 'owed_handover', r, coversTs);
    }
    await notifyHandoff(leadId);
    say({ evt: 'dana.handover', leadId, why: outcome, sent });
    return { handover: outcome, sent };
  }

  /**
   * Was this expired set handed over as `missed` already (r16 G4)? By the messages a `missed` covered, never by a
   * task's update time: each hand-off task of the chat (open or closed) keeps the highest rowid its `missed` covered
   * and when (details.missed_rid, missed_at; taskMissed). A message is recorded when one of them covers its rowid and
   * it was already past its 2-h mark then. A message stored later (a backfill) has a higher rowid, so it gets its own
   * `missed`; one that was still fresh then too. From the database: a restart repeats nothing.
   */
  function missedRecorded(leadId, expired) {
    const recs = prep('missedRecs', "SELECT details FROM lead_tasks WHERE lead_id = ? AND kind = 'handoff'").all(String(leadId)).map((r) => {
      try { const d = JSON.parse(r.details ?? '{}') ?? {}; return { rid: Number(d.missed_rid), at: Number(d.missed_at) }; } catch { return null; }
    }).filter((r) => r && Number.isFinite(r.rid) && Number.isFinite(r.at));
    return expired.every((m) => recs.some((r) => Number(m.rid) <= r.rid && Number(m.ts) + FRESH_MS <= r.at));
  }
  /**
   * The messages past their 2-h mark (batchOf's `expired`, r15) are a person's: handed over as `missed` once (the open
   * task reused and marked, the note, no line), never answered. Null when there are none, or they were already.
   */
  async function missedExpired(leadId, lead, built, viaBrain) {
    if (!viaBrain || !built.expired?.length || missedRecorded(leadId, built.expired)) return null;
    const language = languageOf({ lead, texts: built.expired.map((m) => m.text) });
    const rid = Math.max(...built.expired.map((m) => Number(m.rid)));
    return handover(leadId, language, 'missed', built.expiredTs, { line: 'none', note: { kind: 'missed' }, viaBrain, rid });
  }
  /**
   * When a person last let the assistant answer this chat again (dana_off set to 0 on the dashboard: "Let the AI
   * answer again", or the chat's switch), from the audit log, floored to its second (r16 G2): WhatsApp stamps whole
   * seconds, so a message of that same second counts as after it. Null when never.
   */
  function againFloor(leadId) {
    const r = safely(() => prep('again', `SELECT MAX(ts) AS ts FROM audit_log WHERE action = 'dana_chat' AND target = ?
        AND meta LIKE '%"dana_off":0%'`).get(String(leadId)));
    return r?.ts !== null && r?.ts !== undefined && Number.isFinite(Number(r.ts)) ? Math.floor(Number(r.ts) / 1000) * 1000 : null;
  }
  /**
   * THE stop scope (r16 G2): every client message of the last 24 h sent at or after the last "answer again", in
   * insertion order. Never bounded by coverage or by a staff reply: a stop request a person answered, or one an answer
   * covered, is still a stop request. (stopFirst runs only while dana_off = 0.)
   */
  function firstStop(leadId) {
    const again = againFloor(leadId);
    const rows = prep('stopScope', `SELECT rowid AS rid, * FROM wa_messages WHERE lead_id = ? AND direction = 'in' AND ts > ? AND ts >= ?
        ORDER BY rowid`).all(String(leadId), now() - DAY_MS, again ?? -Infinity);
    for (const m of rows) {
      const hit = typeof m.text === 'string' ? matchStopWords(m.text) : null;
      if (hit) return { row: m, kind: hit.kind };
    }
    return null;
  }

  /** The hand-off task actually used becomes `missed` (the queue crossed 2 h; by its id, whatever its reason: r6, r7). */
  function taskMissed(taskId, { leadId = null, rid = null } = {}) {
    const t = now();
    if (taskId) prep('taskMissed', "UPDATE lead_tasks SET reason = 'missed', updated = ? WHERE task_id = ?").run(t, String(taskId));
    // What it covered (r16 G4): the highest rowid and when, with the task (the chat's newest hand-off task when no
    // task is open: one a person closed meanwhile), so missedRecorded dedupes by the messages, never by a time.
    const target = taskId ?? (leadId === null ? null : prep('lastTask', `SELECT task_id FROM lead_tasks WHERE lead_id = ? AND kind = 'handoff'
        ORDER BY created DESC, rowid DESC LIMIT 1`).get(String(leadId))?.task_id);
    if (!target || rid === null || !Number.isFinite(Number(rid))) return;
    const row = prep('taskDetails', 'SELECT details FROM lead_tasks WHERE task_id = ?').get(String(target));
    let d = {};
    try { d = JSON.parse(row?.details ?? '{}') ?? {}; } catch { d = {}; }
    d.missed_rid = Math.max(Number(d.missed_rid) || 0, Number(rid));
    d.missed_at = t;
    prep('taskDetailsSet', 'UPDATE lead_tasks SET details = ? WHERE task_id = ?').run(JSON.stringify(d), String(target));
  }
  const openTaskId = (leadId) => prep('openTask', "SELECT task_id FROM lead_tasks WHERE lead_id = ? AND kind = 'handoff' AND status = 'open'")
    .get(String(leadId))?.task_id ?? null;
  /** Does this refusal defer the line (it stays owed) rather than end it? The backlog gate, a cap, the sender's rate limit. */
  const defers = (r) => r?.stopped === 'backlog' || Boolean(r?.cap && r.cap.reason !== 'cap_chat_day') || r?.error === 'rate_limited';
  /**
   * A fixed line deferred (`defers`): owed, on a timed hold the sweep turns into the line itself (r6). Its retry time
   * backs off: the backlog gate 60 s doubling to 10 min (r7), the sender's rate limit the rate hold's back-off, a cap
   * until it frees. The hold's 2-h mark bounds all of it (holdDeadline). True when it is owed.
   */
  function oweLine(leadId, reason, r, coversTs = null) {
    if (!defers(r)) return false;
    // An owed line's hold is written after the line's await: through the commit point (r28); a flip owes nothing.
    if (commitPoint(leadId, true, coversTs, { chat: false })) return false;
    if (coversTs !== null && coversTs !== undefined && !owedFor.has(leadId)) owedFor.set(leadId, { ts: Number(coversTs), rid: coverRid(leadId, coversTs) });
    let until;
    if (r.stopped === 'backlog') {
      const n = (owedStreak.get(leadId) ?? 0) + 1;
      owedStreak.set(leadId, n);
      until = now() + Math.min(OWED_BACKOFF_MAX_MS, RATE_HOLD_MS * 2 ** (n - 1));
    } else if (r.error === 'rate_limited') {
      const n = (rateStreak.get(leadId) ?? 0) + 1;
      rateStreak.set(leadId, n);
      until = now() + Math.min(RATE_HOLD_MAX_MS, RATE_HOLD_MS * 2 ** (n - 1));
    } else {
      until = Number.isFinite(r.cap.until) ? r.cap.until : now() + MINUTE_MS;
    }
    return setTimedHold(leadId, reason, until);
  }
  /**
   * The sweep's send of an owed hand-over or closing line (r6): the line itself, through the same gate, never a new
   * model turn (which would stop at chat_off, or skip the line at needs_human). Waits again while the gate defers it.
   */
  async function sendOwed(leadId, reason) {
    const lead = db.getLead(leadId);
    if (!lead || lead.inbox_state !== 'in') return skip(leadId, 'not_in_inbox');
    // A stale retry (its hold replaced meanwhile) does nothing.
    if (lead.dana_hold_reason !== reason) return skip(leadId, 'hold');
    const forget = (coversTs = null) => endHold(leadId, { own: reason, coversTs });
    // The chat left the brain path meanwhile (dana_brain off, out of auto mode): the owed line ends unsent (r10).
    if (!useBrain(lead)) { forget(); return skip(leadId, 'not_brain'); }
    const waiting = pendingFor(leadId, lead, { all: true });
    if (!waiting.length) { forget(); return skip(leadId, 'nothing'); }
    // A stop, privacy or deletion request among the waiting messages wins over an owed hand-over, before it is due or
    // after (r10): the stop flow (closing line, dana_off, the stopped note) replaces it; it is never sent first.
    const stopHit = reason === 'owed_handover' ? firstStop(leadId) : null;
    if (stopHit) {
      forget();
      return stopChat(lead, languageOf({ lead, texts: waiting.map((m) => m.text) }), stopHit.kind, waiting[waiting.length - 1].ts, { viaBrain: true });
    }
    // One not due yet waits. Due is the hold's deadline, the clock the sweep wakes on (r9: never the raw time).
    const t = now();
    if (holdDeadline(lead, t) > t) return skip(leadId, 'hold');
    // It covers the message it was owed for, never a newer one (r10).
    const o = owedFor.get(leadId);
    const target = (o && (waiting.find((m) => Number(m.ts) === o.ts && Number(m.rid) === o.rid) ?? waiting.find((m) => Number(m.ts) === o.ts))) ?? waiting[0];
    const coversTs = target.ts;
    turnCover.set(String(leadId), { ts: Number(target.ts), rid: Number(target.rid) });
    const language = languageOf({ lead, texts: waiting.filter((m) => Number(m.ts) <= Number(coversTs)).map((m) => m.text) });
    const auto = autoOf(lead);
    // Past the 2-h mark: straight to `missed` (the hold ends, the task used reads missed, the note), no line (r9).
    if (t - Number(coversTs) > FRESH_MS) {
      forget(coversTs); // newer messages get their own run (r11)
      taskMissed(openTaskId(leadId), { leadId, rid: Number(target.rid) });
      if (auto) noteHandover(lead, { kind: 'missed', coversTs });
      say({ evt: 'dana.owed_line', leadId, sent: false, missed: true });
      return { handover: 'missed', sent: false };
    }
    const closing = reason === 'owed_closing';
    const text = closing ? (auto ? CLOSING[language] : HANDOVER[language]) : (auto ? autoHandoverLine(language, now()) : HANDOVER[language]);
    const taskId = openTaskId(leadId);
    const r = await sendFixed(lead, text, language, coversTs, true, { closing, owed: reason });
    if (r.sent) {
      // Only its own owed hold ends: a send_failed hold afterFailure just set (an unsure send) stays (r7). What came
      // after the owed message still waits: answered as usual, by the next run (r10, r11).
      forget(coversTs);
      owedStreak.delete(leadId);
      rateStreak.delete(leadId);
      say({ evt: 'dana.owed_line', leadId, sent: true });
      return { handover: 'owed', sent: true };
    }
    // Deferred again (the backlog gate, a cap, the sender's rate limit): still owed, the hold kept (r7).
    if (oweLine(leadId, reason, r)) return skip(leadId, r.stopped ?? r.error);
    forget(coversTs);
    if (r.stopped === 'missed') {
      taskMissed(taskId, { leadId, rid: Number(target.rid) });
      if (auto) noteHandover(lead, { kind: 'missed', coversTs });
    }
    return skip(leadId, r.stopped ?? r.error ?? 'nothing');
  }

  /** A stop, privacy or deletion request (DESIGN §4.1): no more answers in this chat. */
  const stopChat = (lead, language, kind, coversTs, { checked = false, viaBrain = false } = {}) => handover(lead.lead_id, language, kind, coversTs, {
    checked, line: 'closing', stop: true, note: { stopped: kind }, viaBrain,
  });

  /**
   * The last resort of an auto-mode chat (DESIGN-brain §4.2): the outage line once per outage (the
   * `brain_out` hold and whether its line went, not needs_human, decide), the 10-minute hold, needs_human
   * for the dashboard, the brain_out alert BEFORE the hand-over note. Whether the line went is read from the
   * outbox (a restart forgets nothing, r2 N1): owed when it was refused (the sender's limit, a switch), so the
   * next retry sends it; the notes go once per outage. With the line gone and a brain_out hold that ended
   * within the last span (the sweep's retry, the brain still out): the hold is extended, no line.
   */
  async function lastResort(lead, language, coversTs, code, batch) {
    const leadId = lead.lead_id;
    const pre = await preSend(leadId, coversTs);
    if (!pre.ok && HANDOVER_SKIPS.has(pre.reason)) return skip(leadId, pre.reason);
    const fresh = db.getLead(leadId);
    if (!fresh || fresh.inbox_state !== 'in') return skip(leadId, 'not_in_inbox');
    // THE commit point before its writes (r24): a flip during preSend's refresh re-queues; the chat's own checks.
    const cp = commitPoint(leadId, true, coversTs);
    if (cp) return cp;
    const t = now();
    // The same outage: this chat's brain_out hold, ended within the last hold span (the sweep's retry).
    // One that ended long ago (a person answered, nothing woke it since) is a past outage: start again.
    const until = Number(fresh.dana_hold_until);
    // "Already lined" is the outbox's outage row inside the window, whatever hold the chat has moved to (a cap
    // between two retries included; r5). Owed: this chat's brain_out hold of the last span, with no line yet.
    const lineWent = openOutage(leadId, t);
    const sameOutage = lineWent || (fresh.dana_hold_reason === 'brain_out' && Number.isFinite(until) && t - until < BRAIN_OUT_HOLD_MS);
    const lined = lineWent ? true : sameOutage ? false : undefined;
    db.transaction(() => {
      setTimedHold(leadId, 'brain_out', t + BRAIN_OUT_HOLD_MS);
      if (Number(fresh.needs_human) !== 1) inbox.setNeedsHuman(leadId, 1);
      ensureHandoff(db, { leadId, source: 'dana', reason: 'brain', now: t });
    });
    if (lined === true) {
      say({ evt: 'dana.brain_out', leadId, code, line: false });
      return { held: 'brain_out', sent: false };
    }
    void batch;
    if (lined === undefined) {
      safely(() => notes?.alert?.('brain_out', { code }));
      noteHandover(fresh, { kind: 'brain', coversTs });
      if (alerts) safely(() => alerts.notify(leadId, { reason: 'needs_human' }));
    }
    let sent = false;
    if (replyJidFor(fresh)) {
      const r = await sendFixed(fresh, outageLine({ language, at: t }), language, coversTs, true, { mark: OUTAGE_MARK });
      // Past 2 h by the time it reached the queue: `missed`, and no client line (r4 C).
      if (r.stopped === 'missed') {
        clearHold(leadId);
        return handover(leadId, language, 'missed', coversTs, { checked: true, line: 'none', note: { kind: 'missed' }, viaBrain: true });
      }
      sent = Boolean(r.sent);
    }
    // A line owed (refused here, or no phone jid for now): a short hold, so the sweep tries the line again soon.
    // The short hold after the line's await goes through the commit point (r28): a flip re-queues instead, and the
    // outage hold this step set for the auto route ends with it (r30: it must not gate the new route). The flag and
    // the task stay (facts).
    if (!sent) {
      const flipped = commitPoint(leadId, true, coversTs, { chat: false });
      if (flipped) {
        endOwnHold(leadId, 'brain_out');
        return flipped;
      }
      setTimedHold(leadId, 'brain_out', t + RATE_HOLD_MS);
    }
    if (lined === undefined) await notifyHandoff(leadId);
    say({ evt: 'dana.brain_out', leadId, code, line: sent });
    return { held: 'brain_out', sent };
  }

  /* ---------------- the guards before any model call ---------------- */
  /** An acknowledgement ("ok", «تمام», 👍; emoji only): never a repeat for the loop guard. */
  function isAck(text) {
    const s = normalise(text).replace(/[!?.,،؟…\-_*~]+/g, ' ').trim();
    if (!s) return true;
    if (!/[\p{L}\p{N}]/u.test(s)) return true; // emoji or punctuation only
    const words = s.split(/\s+/);
    return words.length <= 3 && words.every((w) => ACK_WORDS.has(w));
  }
  /** The loop guard of a brain chat (DESIGN §6.3): the same text 3 times in an hour (acknowledgements aside), or more than 20 messages in 10 min. */
  function looping(leadId, t) {
    const rows = inbox.messagesFor(leadId, { limit: 200 }).filter((m) => m.direction === 'in' && Number(m.ts) > t - HOUR_MS);
    if (rows.filter((m) => Number(m.ts) > t - 10 * MINUTE_MS).length > LOOP_BURST) return true;
    const seen = new Map();
    for (const m of rows) {
      if (typeof m.text !== 'string' || isAck(m.text)) continue;
      const k = m.text.replace(/\s+/g, ' ').trim().toLowerCase();
      seen.set(k, (seen.get(k) ?? 0) + 1);
      if (seen.get(k) >= LOOP_SAME_TEXT) return true;
    }
    return false;
  }
  /** DESIGN §6.4: a stable link, and fewer than ten backlog first-answers in the last hour. */
  function backlogAllowed(t, { except = null } = {}) {
    if (safely(() => link?.linkStable?.()) !== true) return false;
    // The backlog first-answers of the last hour, from the outbox (a restart forgets none): every Dana turn sent
    // more than 30 min after the message it answered, a fixed line included (r6); plus the ones on their way now.
    const sent = prep('backlogSent', `SELECT COUNT(*) AS n FROM (SELECT DISTINCT lead_id, covers_ts FROM wa_outbox
        WHERE sender_kind = 'dana' AND status <> 'failed' AND covers_ts IS NOT NULL AND created >= ?
          AND created - covers_ts > ?)`).get(t - HOUR_MS, BACKLOG_MS).n;
    const onTheirWay = [...backlogReserved].filter((id) => id !== except).length;
    return sent + onTheirWay < BACKLOG_PER_HOUR;
  }
  /** DESIGN §6.5: the first message carries a link only when the client sent a Ref, a listing id or a site URL. */
  function clientPointed(batch) {
    // A Ref, a listing id, or a link to Bona's site by the whole-host matcher (r18): never an e-mail address.
    return batch.some((m) => {
      const s = typeof m.text === 'string' ? m.text : '';
      return REF_RE.test(s) || LISTING_ID_RE.test(s) || linksIn(s).some((u) => onSite(u.replace(/[).,;:!?»”]+$/u, '')));
    });
  }

  /** Bona's own site (cfg.siteUrl's host, and bona-real-estate.com): the only hosts a reply may link to, besides the maps link. */
  function onSite(url) {
    let host = '';
    try { host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).host.toLowerCase(); } catch { return false; }
    const own = safely(() => new URL(siteUrl).host.toLowerCase());
    return host === own || host === 'bona-real-estate.com' || host === 'www.bona-real-estate.com';
  }
  /** A line with no real words: under 4 words, or a pointer left dangling (it ends with ':' '—' '-' '(' ','). */
  const weakLine = (l) => {
    const t = String(l).trim();
    const words = t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
    return words.length < 4 || /[:—–\-(\[,]$/u.test(t);
  };
  /** A stripped line loses its weak tail ("… More at", "Details (", "Here it is:"). */
  function trimWeakTail(line) {
    let t = String(line).replace(/[\s(\[]+$/u, '').trim();
    for (;;) {
      const parts = t.split(/(?<=[.!?؟])\s+/u);
      if (!parts.length || !weakLine(parts[parts.length - 1])) break;
      parts.pop();
      t = parts.join(' ').trim();
      if (!t) break;
    }
    return t;
  }
  /**
   * DESIGN §6.5 on EVERY link of a brain chat's outgoing text (a legacy chat keeps main's link handling): a link
   * that is not on Bona's site and is not the code-built maps link goes (a maps link the model wrote itself is
   * not code-built: only one the commit added, absent from the model's text); then only the first `allowed`
   * links stay (0 on a first message, 1 when the client pointed at a home, else MAX_LINKS). A stripped line
   * loses its weak tail, and goes when nothing real is left. `stripped`: anything was removed.
   */
  function limitLinks(text, allowed, modelText = '') {
    let kept = 0;
    let stripped = false;
    const orig = String(text).split('\n');
    const lines = orig.map((line) => {
      // By position (r19): the very link the matcher found goes, never the first occurrence of its text (one inside
      // an e-mail address).
      let out = '';
      let at = 0;
      let cut = false;
      for (const { index, raw } of linkSpans(line)) {
        const clean = raw.replace(/[).,;:!?»”]+$/u, '');
        const codeMaps = MAPS_RE.test(clean) && !String(modelText).includes(clean);
        out += line.slice(at, index);
        at = index + raw.length;
        if ((onSite(clean) || codeMaps) && kept < allowed) { kept += 1; out += raw; continue; }
        out += ' ';
        cut = true;
        stripped = true;
      }
      out += line.slice(at);
      return cut ? trimWeakTail(out.replace(/\s{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1')) : out;
    });
    const out = lines.filter((l, i) => l.trim() || !hasLink(orig[i])).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text: out, stripped };
  }

  /** The commit's hand-over (booking_failed, booking_unconfirmed): no line of its own, the bubble said it. */
  async function commitHandover(leadId, language, kind, coversTs, viaBrain) {
    if (kind === 'booking_unconfirmed') setHold(leadId, 'booking_unconfirmed', null);
    return handover(leadId, language, kind, coversTs, {
      checked: true, line: 'none', note: kind === 'booking_failed' ? { kind: 'booking_failed' } : null, viaBrain,
    });
  }

  /**
   * A cap. A legacy chat: main's hand-over with the line. A brain chat (DESIGN §6.3): cap_chat is a timed hold
   * until the window frees (the sweep re-wakes it, no line, no alert); cap_day and cap_chat_day are a hand-over
   * with no line plus, for cap_day, a timed hold until the day frees a turn, so the sweep revisits the chat.
   */
  async function capped(leadId, language, cap, coversTs, viaBrain, { checked = false } = {}) {
    if (!viaBrain) return handover(leadId, language, cap.reason, coversTs, { checked });
    if (cap.reason === 'cap_chat') {
      setTimedHold(leadId, 'cap_chat', cap.until);
      return skip(leadId, 'cap_chat');
    }
    // A chat already handed over for the day cap (its hold) only waits again: no repeat hand-over (r2).
    if (cap.reason === 'cap_day' && db.getLead(leadId)?.dana_hold_reason === 'cap_day') {
      setTimedHold(leadId, 'cap_day', Number.isFinite(cap.until) ? cap.until : now() + MINUTE_MS);
      return skip(leadId, 'cap_day');
    }
    const out = await handover(leadId, language, cap.reason, coversTs, { checked, line: 'none', note: { kind: 'cap_day' }, viaBrain });
    // The hold after the hand-over's notifier await goes through the commit point (r28): on a flip the escalation stays
    // (the task and the flag are facts), the brain-route hold is not written, and the batch is re-queued.
    if (cap.reason === 'cap_day' && Number.isFinite(cap.until) && !out.skipped && !commitPoint(leadId, viaBrain, coversTs, { chat: false })) {
      setTimedHold(leadId, 'cap_day', cap.until);
    }
    return out;
  }

  /** A brain chat refused by the sender's own limit: a timed hold that backs off (60 s, doubling, at most 30 min). */
  function rateHold(leadId) {
    const n = (rateStreak.get(leadId) ?? 0) + 1;
    rateStreak.set(leadId, n);
    setTimedHold(leadId, 'cap_chat', now() + Math.min(RATE_HOLD_MAX_MS, RATE_HOLD_MS * 2 ** (n - 1)));
  }

  /**
   * A route flip (r22, r23): the chat's route now (brain or Retell, read from the lead) is not the one the turn was made
   * on. Checked at every point where the turn commits to an outcome (the model's return, preSend, the send queue);
   * a flip writes and sends nothing more and re-queues the batch (pendingAgain, at its newest ts) on the new route.
   * Null when the route held.
   */
  function routeFlip(leadId, viaBrain, coversTs) {
    // The turn's route with its mode (turnRoute, captured at the run's start) when it is the same provider as
    // `viaBrain`; else the provider alone (a legacy fallback of a brain line checks 'legacy').
    const k = turnRoute.get(String(leadId));
    const expected = k && (k !== 'legacy') === Boolean(viaBrain) ? k : viaBrain ? null : 'legacy';
    const nowKey = routeKey(db.getLead(leadId));
    if (expected === null ? nowKey !== 'legacy' : nowKey === expected) return null;
    return requeue(leadId, coversTs, nowKey !== 'legacy');
  }
  /**
   * Re-queue a chat's batch on its new route (r22-r25): woken at the newest of the covered message and the chat's newest
   * client message (a legacy re-run reads the woken ts for its freshness, so an expired set's ts would read `old`).
   */
  function requeue(leadId, coversTs, routeNow = useBrain(db.getLead(leadId))) {
    const id = String(leadId);
    const newest = Number(prep('newestIn', "SELECT MAX(ts) AS ts FROM wa_messages WHERE lead_id = ? AND direction = 'in'").get(id)?.ts ?? 0) || 0;
    pendingAgain.set(id, Math.max(pendingAgain.get(id) ?? 0, Number(coversTs) || 0, newest));
    say({ evt: 'dana.route_changed', leadId, brain: routeNow });
    return skip(leadId, 'route_changed');
  }

  /**
   * The chat's own checks, whatever its route (r24): out of the inbox, identity, a rule off, Dana off (the breaker),
   * Sending off, the chat stopped (dana_off; a closing line excepted), a person's answer after the covered message.
   * The reason, or null.
   */
  function chatRefusal(l, coversTs, { closing = false, deadline = false } = {}) {
    if (!l || l.inbox_state !== 'in' || isExcludedLead(l)) return 'not_in_inbox';
    if (identityBlocked()) return 'identity';
    if (ruleOff(l)) return 'rule_off';
    if (breakerOpen() || !(team.danaEnabled() || Number(l.dana_test) === 1)) return 'off';
    if (!team.sendingEnabled()) return 'sending_off';
    if (!closing && Number(l.dana_off) === 1) return 'chat_off';
    if (coversTs !== null && coversTs !== undefined && inbox.humanOutboundAfter(l.lead_id, coversTs)) return 'dropped_human';
    // A non-closing fixed line past its message's 2-h mark (r25): `missed`, whatever its route (the legacy fallback too).
    if (deadline && now() - Number(coversTs) > FRESH_MS) return 'missed';
    return null;
  }
  /**
   * THE commit point (r24): a turn writes state or sends only after this, synchronously, with no await in between. It
   * re-checks the route (routeFlip: a flip re-queues the batch on the new route) and, with `chat`, the chat's own
   * checks (chatRefusal). Null when the turn may go on; else the skip it ends with. Used before handover()'s state
   * writes (its line then goes through sendGate, or at once on a legacy chat), before lastResort's, before every
   * legacy bubble (a brain bubble's is sendGate, in the queue), and before the legacy fallback of a hand-over line.
   */
  function commitPoint(leadId, viaBrain, coversTs, { route = true, chat = true, closing = false, deadline = false } = {}) {
    if (route) {
      const flipped = routeFlip(leadId, viaBrain, coversTs);
      if (flipped) return flipped;
    }
    if (!chat) return null;
    const why = chatRefusal(db.getLead(leadId), coversTs, { closing, deadline });
    return why ? skip(leadId, why) : null;
  }

  /** What only delays a stop's closing line, never the stop (r14 I1): its line goes over them. */
  const STOP_OVERRIDES = new Set(['hold', 'cap_chat', 'cap_day', 'cap_chat_day', 'old', 'needs_human', 'no_open_chat', 'backlog']);
  /**
   * STOP FIRST (r14 I1): on the brain path, before freshness, missed, backlog, caps, holds and owed lines, the stop /
   * privacy / deletion scan of EVERY waiting message. A match is ALWAYS recorded (r15): dana_off, needs_human, the
   * hand-off task and the stopped note (auto mode), covering everything waiting; an owed line is replaced. Before the
   * closing line, preSend's refresh and person check run; the line goes only when nothing but a delay (STOP_OVERRIDES)
   * stands in the way. A person active in the chat (an answer found by the refresh, or a recent one), Dana or Sending
   * off, the breaker, a rule off, identity, not configured, no phone jid: the stop is recorded with no line. Only a
   * chat out of the inbox (or excluded) is left alone. A person active in the last 24 h means no line whatever the
   * hold (r16 G3). The scan is firstStop's scope (r16 G2): every client message of 24 h after the last "answer again",
   * never bounded by coverage or a staff reply; "Let the AI answer again" undoes a false positive. Null when there is
   * no stop request.
   */
  async function stopFirst(leadId) {
    const lead = db.getLead(leadId);
    if (!lead || !useBrain(lead) || Number(lead.dana_off) === 1) return null;
    const outOfInbox = (l) => !l || l.inbox_state !== 'in' || isExcludedLead(l);
    if (outOfInbox(lead)) return null;
    const hit = firstStop(leadId);
    if (!hit) return null;
    if (isOwed(lead.dana_hold_reason)) endHold(leadId, { own: lead.dana_hold_reason });
    // It covers everything waiting and the request itself (one a staff reply or an answer covered included).
    const covered = [...pendingFor(leadId, lead, { all: true }), hit.row];
    const coversTs = Math.max(...covered.map((m) => Number(m.ts)));
    turnCover.set(String(leadId), { ts: coversTs, rid: Math.max(...covered.map((m) => Number(m.rid))) });
    const language = languageOf({ lead, texts: covered.map((m) => m.text) });
    // The refresh and the person check before the closing line (r15): a person who answered meanwhile gets no line
    // over him, but the stop is still recorded.
    const pre = await preSend(leadId, coversTs);
    const fresh = db.getLead(leadId);
    if (outOfInbox(fresh)) return skip(leadId, 'not_in_inbox');
    // A person active in the last 24 h: no line, whatever the hold (r16 G3).
    const line = !personActive(fresh) && (pre.ok || STOP_OVERRIDES.has(pre.reason)) ? 'closing' : 'none';
    return handover(leadId, language, hit.kind, coversTs, { checked: true, line, stop: true, note: { stopped: hit.kind }, viaBrain: true });
  }

  /* ---------------- one run ---------------- */
  async function refusedRun(leadId, e) {
    if (e.reason === 'identity') {
      const t = now();
      // An alert only for news (PR-INT r1, Codex P0-2): Dana on (the switch, or this chat's test flag) and a mismatch a
      // probe established (lib/wa-link.mjs identityMismatch). An identity merely unproven (a 503, an error, before the
      // first answer) refuses the send all the same and raises nothing; the link probe has its own Kuma line for it.
      const lead = safely(() => db.getLead(leadId));
      const on = safely(() => team.danaEnabled()) === true || Number(lead?.dana_test) === 1;
      if (on && safely(() => link?.identityMismatch?.()) === true && t - identityAlertAt >= HOUR_MS) {
        identityAlertAt = t;
        safely(() => alerts?.notifyOwners?.({ reason: 'identity_mismatch' }));
      }
      return skip(leadId, 'identity');
    }
    if (e.reason === 'cap_chat' || CAP_HANDOVERS.has(e.reason)) {
      const lead = db.getLead(leadId);
      const viaBrain = useBrain(lead);
      // A brain chat's waiting messages include those an outage line covered (r3), from the one builder (r14).
      const built = batchOf(leadId, lead);
      const waiting = built.batch;
      // Past 2 h a brain chat's message is a person's, capped or not: the expired set `missed` once (r15), its hold
      // ends (r3 N4); what is still fresh keeps the cap below.
      if (viaBrain && built.expired.length && !waiting.length) {
        clearEnded(leadId, now(), { owed: true });
        if (db.getLead(leadId)?.dana_hold_reason === 'brain_out') clearHold(leadId);
        return (await missedExpired(leadId, lead, built, viaBrain)) ?? skip(leadId, 'nothing');
      }
      // The cap this step applies: the start's, or the one eligible() reads again after an await (r28).
      let cap = e;
      if (viaBrain) {
        const m = await missedExpired(leadId, lead, built, viaBrain);
        if (m?.skipped === 'route_changed') return m;
        // The route and eligibility after that await, before capped writes its hold (r27): a flip re-queues; a refusal
        // that is no cap any more skips; a cap that freed meanwhile is answered by a re-run.
        const f = routeFlip(leadId, viaBrain, built.coversTs ?? built.expiredTs);
        if (f) return f;
        const eNow = eligible(leadId);
        if (eNow.ok) {
          const id = String(leadId);
          pendingAgain.set(id, Math.max(pendingAgain.get(id) ?? 0, Number(built.coversTs ?? built.expiredTs) || 0));
          return skip(leadId, 'nothing');
        }
        if (eNow.reason !== 'cap_chat' && !CAP_HANDOVERS.has(eNow.reason)) return skip(leadId, eNow.reason);
        cap = eNow;
      }
      // A cap acts only for a client who is waiting: with nothing unanswered (a wake for a
      // batch another run answered) there is nobody to hand over — no flag, alert or line.
      if (!waiting.length) {
        if (viaBrain) clearEnded(leadId);
        return skip(leadId, 'nothing');
      }
      const language = languageOf({ lead, texts: waiting.map((m) => m.text) });
      const coversTs = built.coversTs;
      // Past 2 h a brain chat's message is a person's, capped or not: `missed` once, and its hold ends (r3 N4).
      if (viaBrain && now() - coversTs > FRESH_MS) {
        clearEnded(leadId, now(), { owed: true });
        if (db.getLead(leadId)?.dana_hold_reason === 'brain_out') clearHold(leadId);
        return handover(leadId, language, 'missed', coversTs, { line: 'none', note: { kind: 'missed' }, viaBrain });
      }
      return capped(leadId, language, cap, coversTs, viaBrain);
    }
    return skip(leadId, e.reason);
  }

  async function run(leadId, ts, { wokeAt = null, owed = null } = {}) {
    // The route this turn is made on, with its mode (r27): every routeFlip of this run compares against it.
    // The route, read ONCE for this run (r30): the owed-line choice and the eligibility below go by it.
    const route = routeKey(db.getLead(leadId));
    turnRoute.set(String(leadId), route);
    // Stop first (r14 I1), before an owed line and before every other check.
    const stopped = await stopFirst(leadId);
    if (stopped) return stopped;
    // (An owed line is a brain-route line: a legacy run answers its batch as main does, r29.)
    if (owed && route !== 'legacy') return sendOwed(leadId, owed);
    // A chat that owes a line sends it (when due) before anything else, and starts no model turn in this run (r9): an
    // inbound wake never answers over, or covers up, the owed hand-over or closing line. Not due yet: it waits.
    const owing = db.getLead(leadId)?.dana_hold_reason;
    if (isOwed(owing) && route !== 'legacy') return sendOwed(leadId, owing);
    const started = now();
    // A legacy chat keeps main's freshness rule (the woken message, 30 min, a silent `old` skip); a brain
    // chat's is the batch's own (2 h, backlog, missed: below).
    const { e, route: read } = eligibleRead(leadId, route !== 'legacy' ? {} : { ts });
    // Eligibility read another route than the run's first read (a flip, or a read that failed once; r30): re-queued,
    // nothing written. So hygiene never clears a brain hold, and an owed line is never lost, on one bad read.
    if (read !== null && read !== route) return requeue(leadId, ts, read !== 'legacy');
    // A chat that runs on legacy, by both reads, loses a brain-only TIMED hold an owner switch left behind (r29: no
    // stale "paused until…" on the dashboard); a person-wait hold (no time) stays with its flag. None otherwise.
    if (route === 'legacy' && read === 'legacy') {
      const l = db.getLead(leadId);
      if (l?.dana_hold_reason && l.dana_hold_until !== null && l.dana_hold_until !== undefined) clearHold(leadId);
    }
    if (!e.ok) {
      // An ended brain_out hold of a chat refused for another reason (Dana off, the chat stopped, Sending off,
      // lid-only, a rule off): the outage is over for it, so the sweep stops waking it every minute (r2 N2).
      // r3 N4: an ended timed hold of any reason (cap_day included), not only brain_out; an owed line's only when
      // Dana or Sending is off (r8: chat_off after a stop must not lose its owed closing line).
      if (!['cap_chat', 'cap_day', 'cap_chat_day', 'hold'].includes(e.reason)) clearEnded(leadId, started, { owed: e.reason === 'off' || e.reason === 'sending_off' });
      return refusedRun(leadId, e);
    }
    const viaBrain = e.brain;
    const built = batchOf(leadId, e.lead);
    const batch = built.batch;
    // The messages past their 2-h mark (r15): `missed` once, never in the batch, so a fresh question after them gets
    // its own batch and its own answer. A chat not in auto mode then waits for the person (needs_human, as on main).
    if (viaBrain && built.expired.length) {
      if (!batch.length) {
        backlog.delete(leadId);
        clearEnded(leadId, started, { owed: true });
        if (e.lead.dana_hold_reason === 'brain_out') clearHold(leadId);
        return (await missedExpired(leadId, e.lead, built, viaBrain)) ?? skip(leadId, 'nothing');
      }
      const flagged = Number(e.lead.needs_human) === 1;
      const m = await missedExpired(leadId, e.lead, built, viaBrain);
      // Any sub-step's route_changed ends the run at once (r25): the batch is re-queued on the new route.
      if (m?.skipped === 'route_changed') return m;
      if (m && !e.auto) return m;
      if (m?.handover && !flagged) silentFlag.add(String(leadId));
    }
    // THE route (with its mode) and eligibility right after the expired block's await (r26, r27), before anything this
    // run writes (a backlog entry, the loop hold and note, a rate hold) or the model call: no await from here to the
    // model. A flip re-queues; a refusal ends the run as at its start. (A legacy chat has no await before it: the same
    // answer as its start, so main's when nothing flips.)
    const flippedBefore = routeFlip(leadId, viaBrain, built.coversTs ?? built.expiredTs);
    if (flippedBefore) return flippedBefore;
    const eNow = eligible(leadId, viaBrain ? {} : { ts });
    if (!eNow.ok) return refusedRun(leadId, eNow);
    if (!batch.length) {
      backlog.delete(leadId);
      if (viaBrain && e.lead.dana_hold_reason) clearHold(leadId);
      return skip(leadId, 'nothing');
    }
    const lead = e.lead;
    // The covered prefix by insertion order, for every boundary this run reads (r12, r14).
    if (viaBrain) turnCover.set(String(leadId), { ts: Number(built.coversTs), rid: Number(built.rid) });
    // A recovery run: an outage of this chat is open, read from its marked line, whatever hold it has now (r6).
    const recovering = viaBrain && openOutage(leadId, started);
    const language = languageOf({ lead, texts: batch.map((m) => m.text) });
    // The batch's age is its NEWEST ts (r14 I2), its coverage its highest rowid (a brain chat).
    const coversTs = viaBrain ? built.coversTs : batch[batch.length - 1].ts;
    if (!openChat(leadId, coversTs, started)) {
      if (viaBrain) clearEnded(leadId, started, { owed: true });
      return skip(leadId, 'no_open_chat');
    }
    let isBacklog = false;
    if (viaBrain) {
      // Freshness (DESIGN §4.2, §6.4): over 2 h is a person's; 30 min to 2 h waits for a stable link.
      const age = started - coversTs;
      if (age > FRESH_MS) {
        backlog.delete(leadId);
        clearEnded(leadId, started, { owed: true });
        if (lead.dana_hold_reason === 'brain_out') clearHold(leadId);
        return handover(leadId, language, 'missed', coversTs, { line: 'none', note: { kind: 'missed' }, viaBrain });
      }
      if (age > BACKLOG_MS) {
        if (!backlogAllowed(started)) {
          backlog.set(leadId, coversTs);
          if (lead.dana_hold_reason !== 'brain_out') clearEnded(leadId, started);
          return skip(leadId, 'backlog');
        }
        isBacklog = true;
      }
      backlog.delete(leadId);
    }
    // The code stop-word check of a legacy chat, on its batch (the store's newest ten), before the model call (DESIGN
    // §4.1). A brain chat's ran first (stopFirst, r14 I1).
    const stopHit = viaBrain ? null : batch.map((m) => (typeof m.text === 'string' ? matchStopWords(m.text) : null)).find(Boolean);
    if (stopHit) return stopChat(lead, language, stopHit.kind, coversTs, { viaBrain });
    // The loop guard of a brain chat (sticky): held until a person writes; the owner hears "looks automated".
    if (viaBrain && looping(leadId, started)) {
      setHold(leadId, 'loop', null);
      if (e.auto) safely(() => notes?.stopped?.(lead, 'loop'));
      return skip(leadId, 'loop');
    }

    // The sender's day is full: nothing could go (r2 R2). A legacy chat hands over as main did when its
    // answer was refused, without paying for the Retell call first; a brain chat waits on a backed-off hold.
    if (safely(() => sender.dayFull?.()) === true) {
      if (!viaBrain) return handover(leadId, language, 'send_failed', coversTs, { checked: true, line: 'none' });
      rateHold(leadId);
      return skip(leadId, 'cap_chat');
    }

    // The model. (The route and eligibility were checked right after the expired block, with no await since; r26, r27.)
    const thinkAt = now();
    let turn;
    let newChat = false;
    if (viaBrain) {
      // The read receipt, 1-3 s after the batch fired (DESIGN §6.2; T00): best effort, never awaited by the
      // run, never a send failure. The phone jid even for an @lid chat (Evolution drops @lid keys, T00 finding 4).
      const readJid = replyJidFor(lead);
      if (readJid && typeof sender.markRead === 'function') {
        const keyIds = batch.map((m) => m.key_id).filter((k) => typeof k === 'string' && k);
        safely(() => later(safely(() => pace.readDelayMs?.()) ?? 1500, () => sender.markRead({ jid: readJid, keyIds }).catch(() => {})));
      }
      turn = await think(lead, batch, language, e.auto, built.all);
      // A route flip while the model ran (r23): before any branch (a hand-over, a refusal, the reply) writes or sends.
      const flipped = routeFlip(leadId, viaBrain, coversTs);
      if (flipped) return flipped;
      if (!turn.ok) {
        if (turn.code === 'refusal') return handover(leadId, language, 'brain_refusal', coversTs, { note: { kind: 'other', reason: 'brain_refusal' }, viaBrain });
        if (turn.code === 'guard') return handover(leadId, language, 'price_guard', coversTs, { note: { kind: 'price_guard' }, viaBrain });
        if (e.auto) return lastResort(lead, language, coversTs, turn.code, batch);
        // A legacy chat on the brain (dana_brain '1'): today's hand-over.
        return handover(leadId, language, turn.code, coversTs, { viaBrain });
      }
      // (An outage hold ends only once a reply of this turn was accepted: the post-send clear below, r4 A.)
    } else {
      // The gate before each Retell request (r27): the route (routeFlip re-queues) and eligibility, as at the start.
      // eligible() WITHOUT ts, as main's preSend does (r28): legacy freshness stays main's, decided once at the start.
      const gate = () => routeFlip(leadId, false, coversTs) ?? (() => { const eNow = eligible(leadId); return eNow.ok ? null : { refused: eNow }; })();
      const c = await complete(lead, batch, language, gate);
      if (c.gated) return c.gated.refused ? refusedRun(leadId, c.gated.refused) : c.gated;
      // The same check on a Retell turn (r23): a flip to the brain while Retell answered writes and sends nothing.
      const flipped = routeFlip(leadId, viaBrain, coversTs);
      if (flipped) return flipped;
      if (c.error) return handover(leadId, language, c.error, coversTs);
      turn = c.completion;
      newChat = c.newChat;
    }
    const brainMs = now() - thinkAt;
    // Links (DESIGN §6.5): a brain chat's first message carries none unless the client pointed at a home; a
    // legacy chat keeps main's handling (up to LEGACY_MAX_LINKS cards, any message; r2 R1).
    const firstMessage = !introducedOf(lead);
    const maxLinks = !viaBrain ? LEGACY_MAX_LINKS : firstMessage ? (clientPointed(batch) ? 1 : 0) : MAX_LINKS;
    const { text, handover: asked, links: cardLinks } = answerFrom(turn, { inventory, siteUrl, language, maxLinks });
    if (asked) {
      const kind = requestKind(turn);
      if (STOP_KINDS.has(kind)) return stopChat(lead, language, kind, coversTs, { viaBrain });
      const open = Number(db.getLead(leadId)?.needs_human) === 1 && !silentFlag.has(String(leadId));
      if (!(e.auto && open && text)) {
        return handover(leadId, language, 'request_human', coversTs, { details: handoffDetails(turn), note: { kind }, viaBrain });
      }
      // Auto mode with a hand-over open: her sentence goes as a normal answer, and the owner hears
      // of it again (the ledger's 10-minute bucket is the only dedupe, critic round 2 #11).
      noteHandover(lead, { kind, coversTs });
      safely(() => alerts?.notify?.(leadId, { reason: 'needs_human' }));
    }
    if (!text) return handover(leadId, language, 'empty', coversTs, { viaBrain });
    // The reply guard (DESIGN-brain §5.4) on her words, before preSend: an amount, unit or home link
    // no tool of this turn returned, and no earlier guarded reply of this chat carried.
    const guardAt = now();
    let guarded = false;
    if (viaBrain) {
      const words = answerFrom(turn, { inventory, siteUrl, language, maxLinks: 0 }).text;
      const toolResults = (Array.isArray(turn.toolCalls) ? turn.toolCalls : []).map((c) => c?.result).filter((r) => typeof r === 'string');
      const v = checkReply(words, { toolResults, earlierReplies: guardedReplies(leadId), siteUrl });
      if (!v.ok) {
        for (const hit of v.hits) say({ evt: 'dana.guard', leadId, kind: hit.kind });
        return handover(leadId, language, 'price_guard', coversTs, { note: { kind: 'price_guard' }, viaBrain });
      }
      guarded = true;
    }
    const guardMs = now() - guardAt;
    const holdAt = now();
    if (viaBrain) {
      const wait = safely(() => pace.typingFloorMs({ chars: text.length, newestTs: coversTs })) ?? 0;
      // "composing" only when at least 2 s of the floor remain (DESIGN §6.2; T00): never awaited, never a failure.
      const jid = replyJidFor(lead);
      if (wait >= 2000 && jid && typeof sender.presence === 'function') {
        safely(() => later(0, () => sender.presence({ jid, delayMs: wait }).catch(() => {})));
      }
      if (wait > 0) await sleep(wait);
    }
    const pre = await preSend(leadId, coversTs);
    // The route flipped while the turn ran (#dana brain on / off, auto mode on / off; r22): the reply was made for the
    // other path, so it is dropped (no commit hook, no send) and the chat is re-woken to answer the batch on the new
    // route.
    // Read from the lead itself, so a refusal on the new route (a cap, a switch) is never handled on the old one.
    const flippedAtSend = routeFlip(leadId, viaBrain, coversTs);
    if (flippedAtSend) return flippedAtSend;
    // A stop, privacy or deletion request stored while she worked (preSend's refresh included) wins before anything
    // else this step would decide (r13, r14 I1): no booking, no bubble; the chat is woken so the stop flow runs.
    if (viaBrain) {
      const late = messagesAfter(leadId, coversTs);
      if (late.some((m) => typeof m.text === 'string' && matchStopWords(m.text))) {
        pendingAgain.set(String(leadId), Math.max(pendingAgain.get(String(leadId)) ?? 0, Number(late[late.length - 1].ts)));
        return skip(leadId, 'stop_request');
      }
    }
    if (!pre.ok) {
      // A cap reached meanwhile: the client is waiting (P4-6).
      if (pre.reason === 'cap_chat' || CAP_HANDOVERS.has(pre.reason)) return capped(leadId, language, pre, coversTs, viaBrain, { checked: true });
      return skip(leadId, pre.reason);
    }
    // The commit hook (DESIGN §8.3; lib/dana-commit.mjs): only after preSend passed. It answers the bubbles
    // in the order they go (text, brochure, confirmation), maybe the booking it made, maybe a hand-over.
    let bubbles;
    let committed;
    let strippedAny = false;
    try {
      committed = commit && typeof commit.afterPreSend === 'function'
        ? await commit.afterPreSend({ lead: pre.lead, turn, text, language, coversTs })
        : { bubbles: [{ kind: 'text', text }] };
      bubbles = (Array.isArray(committed?.bubbles) ? committed.bubbles : []).filter((b) => b && (b.kind === 'text' ? typeof b.text === 'string' && b.text.trim()
        : b.kind === 'document' && typeof b.url === 'string' && typeof b.caption === 'string' && b.caption.trim()))
        // A brain chat: every link of a text obeys this message's allowance (DESIGN §6.5), a booking confirmation
        // keeping its own; a bubble left with no real words goes (r2). A legacy chat's bubbles stay as main sent them.
        .map((b) => {
          if (!viaBrain || b.kind !== 'text' || b.bookingId) return b;
          const lim = limitLinks(b.text, maxLinks, text);
          if (lim.stripped) strippedAny = true;
          const real = lim.text.trim() && (hasLink(lim.text) || !lim.text.split('\n').filter((l) => l.trim()).every(weakLine));
          return lim.stripped && !real ? null : { ...b, text: lim.text };
        })
        .filter((b) => b && (b.kind !== 'text' || b.text.trim()));
      // Nothing left once the links went: a short neutral line, never an `empty` hand-over (r2).
      if (viaBrain && strippedAny && !bubbles.some((b) => b.kind === 'text')) bubbles.unshift({ kind: 'text', text: NEUTRAL[language], neutral: true });
    } catch (err) {
      say({ level: 'error', evt: 'dana.commit_failed', leadId, name: errName(err) });
      return handover(leadId, language, 'commit_failed', coversTs, { checked: true, viaBrain });
    }
    if (!bubbles.length) return handover(leadId, language, 'empty', coversTs, { checked: true, viaBrain });
    let linksSent = 0; // a brain chat's links, counted as they go (a brochure turned into its link included; r4 E)
    // A commit hand-over (booking_failed) means its text is a fixed line, not a reply the guard passed.
    const commitKind = typeof committed?.handover?.kind === 'string' ? committed.handover.kind : null;
    const bubbleGuarded = guarded && !commitKind;
    const booking = committed?.booking && typeof committed.booking === 'object' ? committed.booking : null;
    let told = null; // the confirmation bubble's answer: accepted or not
    let outcome = null; // how the run ends when the bubbles did not all go
    let chars = 0;
    let sentAny = false;
    for (let i = 0; i < bubbles.length; i += 1) {
      const b = bubbles[i];
      const go = async (release) => {
        let bubble = b;
        let reserve = false;
        if (viaBrain) {
          // THE send-time gate (r4 C): every check of this moment, for this bubble.
          const g = sendGate(leadId, coversTs, { first: !sentAny, backlog: isBacklog, document: b.kind === 'document' });
          if (!g.ok) {
            release?.();
            return { stopped: g.stopped, cap: g.cap ?? null };
          }
          reserve = Boolean(g.reserve);
          if (g.asLink) {
            // Over a document cap: the brochure goes as its link, within this message's link allowance (r4 E).
            const lim = limitLinks(`${String(b.caption).trim()} — ${b.url}`, Math.max(0, maxLinks - linksSent), '');
            if (lim.stripped || !lim.text.trim()) {
              release?.();
              return { dropped: 'document_cap' };
            }
            say({ evt: 'dana.document_as_link', leadId });
            bubble = { kind: 'text', text: lim.text };
          }
        } else {
          // THE commit point of a legacy bubble (r24): the route only (a flip during the commit hook re-queues), so a
          // legacy chat is main's when nothing flips.
          if (commitPoint(leadId, false, coversTs, { chat: false })) return { stopped: 'route_changed' };
          if (i > 0) {
            // A legacy chat, as before: only a later bubble is re-checked.
            if (inbox.humanOutboundAfter(leadId, coversTs)) return { stopped: 'dropped_human' };
            const again = eligible(leadId, { coversTs });
            const cap = again.reason === 'cap_chat' || CAP_HANDOVERS.has(again.reason);
            if (!again.ok && !cap) return { stopped: again.reason, cap: null };
          }
        }
        if (reserve) backlogReserved.add(leadId);
        try {
          const r0 = await send(db.getLead(leadId) ?? pre.lead, bubble.kind === 'text' ? bubble.text : bubble.caption, language, coversTs, {
            answer: bubble.kind === 'text' && !sentAny && !commitKind && !bubble.neutral, viaBrain, guarded: bubbleGuarded && !bubble.neutral,
            ...(bubble.kind === 'document' ? { document: { url: bubble.url, fileName: typeof bubble.fileName === 'string' ? bubble.fileName : 'brochure.pdf' } } : {}),
          });
          if (r0.sent && bubble.kind === 'text') linksSent += (viaBrain ? linksIn(bubble.text) : (bubble.text.match(LINK_RE) ?? [])).length;
          return r0;
        } finally {
          if (reserve) backlogReserved.delete(leadId);
        }
      };
      const r = viaBrain ? await pace.fifo(go) : await go();
      if (b.bookingId) told = r.accepted === true;
      if (r.dropped) continue;
      if (r.stopped) {
        if (r.stopped === 'backlog' && !sentAny) {
          backlog.set(leadId, coversTs);
          // An outage hold stays until a reply is accepted (r4 A); any other ended hold ends here.
          if (db.getLead(leadId)?.dana_hold_reason !== 'brain_out') clearEnded(leadId);
        }
        if (r.stopped === 'missed' && !sentAny) {
          backlog.delete(leadId);
          clearEnded(leadId, now(), { owed: true });
          outcome = await handover(leadId, language, 'missed', coversTs, { checked: true, line: 'none', note: { kind: 'missed' }, viaBrain });
          break;
        }
        // The chat left the brain path while the reply waited in the queue (r23 N13): nothing went, so the batch is
        // re-queued on the new route. Once a bubble went, the new route sees nothing unanswered: nothing twice.
        if (r.stopped === 'not_brain' && !sentAny) {
          // Always re-queued (r24 P3-b), whatever a second read says: the re-run decides on a fresh read.
          outcome = requeue(leadId, coversTs);
          break;
        }
        if (!sentAny) outcome = r.cap ? await capped(leadId, language, r.cap, coversTs, viaBrain, { checked: true }) : skip(leadId, r.stopped);
        break;
      }
      if (r.sent && r.uncertain && recovering && !sentAny) {
        // The recovery's first bubble may not have gone (r5): never sent again, but never counted as recovered
        // either. The outage hold ends and the chat is handed over like a failed send (the flag, the note, no line).
        afterFailure(pre.lead, { alert: true });
        // Only the outage hold ends (handover() does it); a person-wait hold afterFailure just set stays (r6).
        const ho = await handover(leadId, language, 'send_failed', coversTs, { checked: true, line: 'none', note: { kind: 'send_failed' }, viaBrain });
        outcome = ho?.skipped ? ho : { handover: 'send_failed', sent: false };
        sentAny = true;
        break;
      }
      if (r.sent) {
        sentAny = true;
        chars += r.chars;
        if (viaBrain) {
          rateStreak.delete(leadId);
          if (r.uncertain) afterFailure(pre.lead, { alert: true });
        }
        continue;
      }
      if (r.failure === 'evolution') {
        // A continuation that fails has no hand-over after it: its hold alerts by itself (r2).
        const held = viaBrain ? afterFailure(pre.lead, { alert: sentAny }) : false;
        if (sentAny) break;
        // Main's send_failed hand-over (the flag, the task, the push); a brain chat's owner note once it is held.
        const ho = await handover(leadId, language, 'send_failed', coversTs, { checked: true, line: 'none', note: held ? { kind: 'send_failed' } : null, viaBrain });
        // The outcome says a hand-over happened only when it did (r25; a legacy chat's as on main).
        outcome = viaBrain && ho?.skipped ? ho : { handover: 'send_failed', sent: false };
        break;
      }
      // A local refusal is no send failure (DESIGN §4.2; PLAN §2 row 7): a skip. A brain chat's rate limit is a
      // timed hold the sweep revisits, backing off; a legacy chat's is main's send_failed hand-over (r2 R2).
      if (r.error === 'rate_limited' && !viaBrain) {
        if (!sentAny) {
          await handover(leadId, language, 'send_failed', coversTs, { checked: true, line: 'none' });
          outcome = { handover: 'send_failed', sent: false };
        }
        break;
      }
      // The rate hold after the send's await goes through the commit point (r28): a flip re-queues instead.
      if (viaBrain && r.error === 'rate_limited' && !commitPoint(leadId, true, coversTs, { chat: false })) rateHold(leadId);
      if (!sentAny) outcome = skip(leadId, viaBrain && r.error === 'rate_limited' ? 'cap_chat' : r.error);
      break;
    }
    // After the send (DESIGN §8.3 steps 8-9), whatever became of it: the commit hears whether the
    // confirmation was accepted (one never sent, refused or dropped is not: the event stays and the owner
    // is told the client was not), then its hand-overs are applied as any other.
    const followUps = [];
    if (commitKind && sentAny) followUps.push(commitKind);
    if (booking && commit && typeof commit.afterSend === 'function') {
      try {
        const after = await commit.afterSend({ lead: db.getLead(leadId) ?? pre.lead, booking, accepted: told === true });
        if (typeof after?.handover?.kind === 'string') followUps.push(after.handover.kind);
      } catch (err) {
        say({ level: 'error', evt: 'dana.commit_failed', leadId, name: errName(err) });
      }
    }
    for (const kind of followUps) await commitHandover(leadId, language, kind, coversTs, viaBrain);
    if (outcome) return outcome;
    if (!sentAny) return skip(leadId, 'nothing');
    // Messages past the batch cap (or stored after it) still waiting get their own turn (r14 I2).
    if (viaBrain) rewakeNewer(leadId, coversTs);
    // An ended timed hold is over once she answered: no stale reason stays on the row (r2).
    const after = db.getLead(leadId);
    // (A hold with no time waits for a person: never cleared here. Number(null) is 0, so null is ruled out first.)
    const ends = after?.dana_hold_until;
    if (after?.dana_hold_reason && ends !== null && ends !== undefined && Number(ends) <= now()) clearHold(leadId);
    const doneAt = now();
    const latencyMs = Math.max(0, doneAt - coversTs);
    latencies.push({ at: now(), ms: latencyMs });
    if (latencies.length > LATENCY_RING) latencies.shift();
    const woke = Number.isFinite(wokeAt) ? wokeAt : started;
    const stages = {
      poll: Math.max(0, woke - coversTs), batch: Math.max(0, started - woke), brain: brainMs, guard: guardMs, hold: Math.max(0, doneAt - holdAt),
    };
    const links = viaBrain ? linksSent : cardLinks;
    say({ evt: 'dana.answered', leadId, batch: batch.length, chars, links, newChat, latencyMs, stages });
    return { answered: true, chars, links, newChat };
  }

  /**
   * One run per chat at a time: a call made while a run is in flight waits for it, so two
   * runs never read the same batch. Never rejects.
   */
  function answer(leadId, { ts = null, wokeAt = null, owed = null } = {}) {
    const id = String(leadId ?? '');
    const prev = inflight.get(id) ?? Promise.resolve();
    const p = prev.then(() => run(id, ts, { wokeAt, owed })).finally(() => { silentFlag.delete(id); turnRoute.delete(id); }).catch((err) => {
      say({ level: 'error', evt: 'dana.failed', name: errName(err) });
      return { error: 'failed' };
    });
    inflight.set(id, p);
    p.then(() => {
      if (inflight.get(id) !== p) return; // a later call chained on; it cleans up
      inflight.delete(id);
      if (pendingAgain.has(id)) {
        const t = pendingAgain.get(id);
        pendingAgain.delete(id);
        wake(id, t);
      }
    });
    return p;
  }

  function fire(id) {
    const entry = timers.get(id);
    timers.delete(id);
    if (!entry) return;
    answer(id, { ts: entry.ts, wokeAt: entry.firstAt }).then(() => entry.settle());
  }

  /** The batch window: the test's fixed one, else the brain path's 4-7 s (restarted, capped at 15 s), else today's 2 s. */
  function windowFor(id, entry) {
    if (Number.isFinite(batchMs)) return batchMs;
    const viaBrain = safely(() => useBrain(db.getLead(id))) === true;
    if (!viaBrain) return BATCH_MS;
    const d = safely(() => pace.batchDelay({ firstAt: entry.firstAt, at: now() }));
    return Number.isFinite(d) && d >= 0 ? d : BATCH_MS;
  }

  /** Called by the poller for every client message it stores (P4-7, P4-16). Synchronous, never throws. */
  function wake(leadId, ts) {
    if (!configured || stopped) return;
    const id = String(leadId ?? '');
    const t = Number.isFinite(Number(ts)) ? Number(ts) : now();
    if (inflight.has(id)) {
      pendingAgain.set(id, Math.max(t, pendingAgain.get(id) ?? 0));
      return;
    }
    let entry = timers.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      entry.ts = Math.max(entry.ts, t);
    } else {
      entry = { ts: t, firstAt: now() };
      entry.done = new Promise((resolve) => { entry.settle = resolve; });
      timers.set(id, entry);
    }
    entry.timer = setTimeout(() => fire(id), windowFor(id, entry));
  }

  /**
   * The hold and backlog sweep (DESIGN §4.2, §6.4; PR-INT runs it every minute): a chat whose timed
   * hold has ended is woken for its newest unanswered message (a `brain_out` hold stays until the
   * brain answers, so a retry that fails again extends it with no line); a backlog chat is tried
   * again, oldest first. A chat with nothing waiting loses its ended hold. Never throws.
   */
  function sweep() {
    if (!configured || stopped) return { woken: 0 };
    const t = now();
    let woken = 0;
    const seen = new Set(); // one sweep runs a chat at most once (r4 E)
    const wakeOnce = (id, ts, owed = null) => {
      if (seen.has(id)) return;
      seen.add(id);
      answer(id, { ts, owed });
      woken += 1;
    };
    try {
      // Every timed hold, selected on ITS deadline (holdDeadline: its time, or the waiting message's 2-h mark).
      const held = prep('held', `SELECT lead_id, dana_hold_reason FROM leads WHERE inbox_state = 'in'
          AND dana_hold_reason IS NOT NULL AND dana_hold_until IS NOT NULL ORDER BY dana_hold_until`).all();
      const capDay = [];
      for (const r of held) {
        const lead = db.getLead(r.lead_id);
        const built = batchOf(r.lead_id, lead);
        const waiting = built.batch.length ? built.batch : built.expired;
        const newestTs = built.coversTs ?? built.expiredTs;
        // Nothing waits, or what waits is past 24 h (never answered: never first): the hold ends, no wake (r3 N4).
        if (!waiting.length || Number(newestTs) < t - DAY_MS) { clearHold(r.lead_id); continue; }
        if (t < holdDeadline(lead, t)) continue;
        const newest = { ts: newestTs };
        const pastMark = t - Number(newest.ts) > FRESH_MS;
        // The day cap: each freed turn wakes one waiting chat, the oldest first (below); its reason stays so a
        // chat still capped only waits again, with no repeat hand-over (r2). Past the 2-h mark it goes now (missed).
        if (r.dana_hold_reason === 'cap_day' && !pastMark) { capDay.push({ id: r.lead_id, oldest: Number(waiting[0].ts), ts: newest.ts }); continue; }
        // An owed line is sent by the sweep itself (r6); its hold stays until the line goes or is given up.
        if (r.dana_hold_reason === 'owed_handover' || r.dana_hold_reason === 'owed_closing') { wakeOnce(r.lead_id, newest.ts, r.dana_hold_reason); continue; }
        // A brain_out reason stays until a reply is accepted (r4 A); the run clears what ends.
        if (r.dana_hold_reason !== 'brain_out' && r.dana_hold_reason !== 'cap_day') clearHold(r.lead_id);
        wakeOnce(r.lead_id, newest.ts);
      }
      if (capDay.length) {
        const caps = tierAt(t);
        let free = Math.max(0, caps.PER_DAY - inbox.countDanaTurns({ sinceTs: t - DAY_MS }));
        for (const c of capDay.sort((a, b) => a.oldest - b.oldest)) {
          if (seen.has(c.id)) continue;
          if (free > 0) {
            free -= 1;
            wakeOnce(c.id, c.ts);
          } else {
            setTimedHold(c.id, 'cap_day', dayFreesAt(t, caps.PER_DAY));
          }
        }
      }
      for (const [id, ts] of [...backlog].sort((a, b) => a[1] - b[1])) {
        backlog.delete(id);
        wakeOnce(id, ts);
      }
    } catch (err) {
      say({ level: 'error', evt: 'dana.sweep_failed', name: errName(err) });
    }
    return { woken };
  }

  /** Every armed batch fired and every run landed — including runs an `again` started meanwhile (tests, shutdown). */
  async function flush() {
    for (;;) {
      const waits = [...timers.values()].map((e) => e.done).concat([...inflight.values()]);
      if (!waits.length) return;
      await Promise.allSettled(waits);
    }
  }

  /** Drop every armed batch, forget every `again`, wait for the runs in flight (shutdown). */
  async function stop() {
    stopped = true;
    for (const [id, e] of timers) {
      clearTimeout(e.timer);
      timers.delete(id);
      e.settle();
    }
    pendingAgain.clear();
    backlog.clear();
    await Promise.allSettled([...inflight.values()]);
  }

  const status = () => ({ configured, enabled: team.danaEnabled(), pending: timers.size, inflight: inflight.size });
  /** The answers' latency ring (DESIGN §15): p50 / p90 of the newest answers, in ms. */
  const latency = () => {
    // DESIGN §5.4's "24 h ring" (PR-INT r1): an answer older than a day no longer speaks for the latency.
    const since = now() - DAY_MS;
    const ms = latencies.filter((x) => x.at >= since).map((x) => x.ms);
    return { n: ms.length, p50: percentile(ms, 50), p90: percentile(ms, 90) };
  };
  /** For /health (PR-INT): the breaker is the system's own switch-off (DESIGN §4.2). Booleans only. */
  function health() {
    return { breaker: breakerOpen() };
  }

  return { configured, eligible, wake, answer, flush, stop, status, sweep, latency, health };
}
