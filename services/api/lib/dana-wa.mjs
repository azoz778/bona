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
 * A run that throws after Dana's outbox row is written leaves that row `pending`; start-up or daily
 * upkeep turns it `uncertain` (it may have gone), the batch counts as answered and the chat is not
 * flagged — exactly like a staff reply cut off mid-send. Her answer is the chat's first reply when it has
 * none yet (2026-10-05 design R1); a fixed line (FIXED_LINES) never is.
 *
 * Never logged: message text, a name, a number, a Retell chat id. Never rejects.
 */
import { ensureHandoff, cleanNeeds } from './lead-tasks.mjs';
import { extractActions, plainText } from './actions.mjs';
import { replyJidFor } from './wa-send.mjs';
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
/** The outage line's texts (DESIGN-brain §4.2): inside office hours HANDOVER variant 0, outside the shortened one. */
const OUTAGE_TEXTS = Object.freeze([HANDOVER.en, HANDOVER.ar, OUTAGE_OUT_OF_HOURS.en, OUTAGE_OUT_OF_HOURS.ar]);
const isOutageText = (t) => typeof t === 'string' && OUTAGE_TEXTS.some((l) => t === l || t.endsWith(`\n\n${l}`));
export const FIXED_LINES = fixedLinesFrom({ bookingFailed: danaCommitModule.BOOKING_FAILED_LINE });

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const LINE_MAX = 300;
const CONTEXT_MAX = 3000;
const FACT_MAX = 120;
const BATCH_MAX = 4000;
const LATENCY_RING = 500;
const ARABIC_RE = /[؀-ۿ]/;
const LATIN_RE = /[A-Za-z]/;
const PLACEHOLDER_RE = /^\[[^\]\n]{1,40}\]$/;
const LISTING_ID_RE = /\bBONA-W?\d{3}\b/i;
const LINK_RE = /https?:\/\/[^\s<>"'`]+/giu;
/** The code-built maps link (DESIGN §4.1, §6.5): the one off-site URL a reply may carry. */
const MAPS_RE = /^https:\/\/maps\.google\.com\/\?q=-?\d{1,3}(?:\.\d+)?,-?\d{1,3}(?:\.\d+)?$/;
/** Acknowledgements the loop guard never counts as a repeat (brain chats): at most 3 words, every one of them here. */
const ACK_WORDS = new Set(['ok', 'okay', 'okey', 'k', 'thanks', 'thank', 'you', 'thx', 'ty', 'تمام', 'اوك', 'اوكي', 'شكرا', 'طيب', 'تم', '👍']);
/** Holds for a sender refusal back off (brain chats): 60 s, then twice as long each time, at most 30 min. */
const RATE_HOLD_MAX_MS = 30 * 60_000;
const STOP_KINDS = new Set(['stop', 'privacy', 'deletion']);
/** The raw lead fields the brain's client record reads (lib/brain/prompt.mjs clientTurn masks each before its clip). */
const FACT_FIELDS = ['name', 'interest', 'budget', 'district', 'listing_id', 'stage', 'timeline'];
/** Evolution's answers (wa-send `failure: 'evolution'`), as the outbox keeps them. */
const EVOLUTION_ERRORS_SQL = "(error LIKE 'http\\_%' ESCAPE '\\' OR error IN ('network','timeout','no_ack'))";
/** Skips worth a log line; the rest are states, not events (P4-15). */
const LOGGED_SKIPS = new Set(['human_recent', 'needs_human', 'lid_only', 'old', 'cap_chat', 'nothing', 'dropped_human', 'hold', 'backlog', 'loop', 'identity', 'rule_off', 'no_open_chat']);
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
export function brainInput({ rows = [], batch = [] } = {}) {
  const exclude = new Set(batch.map((m) => m?.key_id));
  const t = inboxTurn(rows, { exclude });
  const own = t.batchParts.length ? t : inboxTurn(batch, { exclude });
  const out = { history: t.history, batchText: own.batchText };
  if (own.batchParts.length) out.batchParts = own.batchParts;
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
  const latencies = [];           // the newest LATENCY_RING answers' latencies (ms)
  const rateStreak = new Map();  // leadId → the sender refusals in a row (the rate hold's back-off)
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

  const activeHold = (lead, t) => {
    const reason = lead?.dana_hold_reason;
    if (typeof reason !== 'string' || !reason) return null;
    const until = lead.dana_hold_until;
    return until === null || until === undefined || t < Number(until) ? { reason, until: until ?? null } : null;
  };
  const setHold = (leadId, reason, until) => db.updateLead(leadId, { dana_hold_reason: reason, dana_hold_until: until });
  const clearHold = (leadId) => db.updateLead(leadId, { dana_hold_reason: null, dana_hold_until: null });
  /** A timed hold never replaces one that waits for a person (send_failed, loop, booking_unconfirmed; r3). */
  function setTimedHold(leadId, reason, until) {
    const l = db.getLead(leadId);
    if (l?.dana_hold_reason && (l.dana_hold_until === null || l.dana_hold_until === undefined)) return false;
    setHold(leadId, reason, until);
    return true;
  }
  /** An ended timed hold, whatever its reason, is cleared (a hold with no time is never touched here; r3 N4). */
  function clearEnded(leadId, t = now()) {
    const l = db.getLead(leadId);
    const until = l?.dana_hold_until;
    if (l?.dana_hold_reason && until !== null && until !== undefined && Number(until) <= t) clearHold(leadId);
  }
  /** The breaker is open: the system's own switch-off (DESIGN §4.2). It binds a per-chat test too (r3). */
  const breakerOpen = () => {
    const row = safely(() => prep('breaker', "SELECT value, updated_by FROM settings WHERE key = 'dana_enabled'").get());
    return row?.value === '0' && row?.updated_by === 'system';
  };

  /** How far back an outage of one chat reaches: past 2 h its message is `missed` (so the episode ends). */
  const outageWindow = (t) => t - FRESH_MS - BRAIN_OUT_HOLD_MS;
  /** Did this chat's holding line go in this outage? Read from the outbox, so a restart forgets nothing (r2 N1). */
  const outageLineSince = (leadId, sinceTs) => prep('outRowsSince', `SELECT text FROM wa_outbox WHERE lead_id = ? AND sender_kind = 'dana'
      AND status <> 'failed' AND created >= ?`).all(String(leadId), sinceTs).some((r) => isOutageText(r.text));

  /**
   * The messages she has not answered (the store's rule). During a brain outage (a brain_out hold) the
   * holding line is no answer (DESIGN-brain §4.2 step 4): the boundary leaves out this outage's line rows,
   * so the recovery answers what it covered, unless a person answered meanwhile. From the database: a
   * restart loses no message (r2 N1). A hand-over line of the same text inside the window reads as the
   * outage's own: its messages are answered by the recovery too.
   */
  function waitingFor(leadId, lead = db.getLead(leadId)) {
    if (lead?.dana_hold_reason !== 'brain_out') return inbox.unansweredClientMessages(leadId, { limit: CONTEXT_MESSAGES });
    const id = String(leadId);
    const t = now();
    const since = outageWindow(t);
    // Bounded to the last 24 h (r3): an older message can never be answered (never first), so no older row matters.
    let bound = Math.max(t - DAY_MS, Number(prep('humanTs', `SELECT MAX(ts) AS ts FROM wa_messages WHERE lead_id = ? AND direction = 'out'
        AND sender_kind IN ('staff','owner_number')`).get(id)?.ts ?? 0) || 0);
    for (const r of prep('outRows', `SELECT sender_kind, covers_ts, created, text FROM wa_outbox WHERE lead_id = ?
        AND sender_kind IN ('staff','dana') AND status <> 'failed' AND created >= ?`).all(id, t - DAY_MS)) {
      if (r.sender_kind === 'dana' && Number(r.created) >= since && isOutageText(r.text)) continue;
      bound = Math.max(bound, Number(r.covers_ts ?? r.created));
    }
    return prep('since', `SELECT * FROM wa_messages WHERE lead_id = ? AND direction = 'in' AND ts > ?
        ORDER BY ts DESC, rowid DESC LIMIT ?`).all(id, bound, CONTEXT_MESSAGES).reverse();
  }

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

  function eligible(leadId, { ts = null, coversTs = null } = {}) {
    const lead = db.getLead(leadId);
    if (autoState(lead) === null) return { ok: false, reason: 'not_configured' };
    const viaBrain = useBrain(lead);
    if (!(viaBrain ? brainConfigured : retellConfigured)) return { ok: false, reason: 'not_configured' };
    if (identityBlocked()) return { ok: false, reason: 'identity' };
    if (!lead || lead.inbox_state !== 'in' || isExcludedLead(lead)) return { ok: false, reason: 'not_in_inbox' };
    if (ruleOff(lead)) return { ok: false, reason: 'rule_off' };
    if (breakerOpen() || !(team.danaEnabled() || Number(lead.dana_test) === 1)) return { ok: false, reason: 'off' };
    if (Number(lead.dana_off) === 1) return { ok: false, reason: 'chat_off' };
    // Every send stops with the Sending switch; asking for an answer that cannot go would only
    // spend money and end in a hand-over.
    if (!team.sendingEnabled()) return { ok: false, reason: 'sending_off' };
    const auto = autoOf(lead);
    // In auto mode an open hand-over is the dashboard's flag, not a gate (DESIGN §4.2).
    if (!auto && Number(lead.needs_human) === 1) return { ok: false, reason: 'needs_human' };
    const t = now();
    if (activeHold(lead, t)) return { ok: false, reason: 'hold' };
    if (Number.isFinite(lead.last_human_out_ts) && t - lead.last_human_out_ts < HUMAN_QUIET_MS) return { ok: false, reason: 'human_recent' };
    if (!replyJidFor(lead)) return { ok: false, reason: 'lid_only' };
    if (coversTs !== null && coversTs !== undefined && !openChat(lead.lead_id, coversTs, t)) return { ok: false, reason: 'no_open_chat' };
    if (ts != null && Number.isFinite(Number(ts)) && Number(ts) < t - (viaBrain ? FRESH_MS : LEGACY_FRESH_MS)) return { ok: false, reason: 'old' };
    const cap = capFor(lead, t, viaBrain);
    if (cap) return cap;
    return { ok: true, lead, brain: viaBrain, auto };
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
  async function session(lead, batch, language, { fresh = false } = {}) {
    const t = now();
    if (!fresh && lead.dana_chat_id && Number.isFinite(lead.dana_chat_ts) && t - lead.dana_chat_ts < SESSION_IDLE_MS) return { chatId: lead.dana_chat_id, created: false };
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
  async function complete(lead, batch, language) {
    const content = batchText(batch);
    const ask = async (chatId) => {
      const completion = await retell.createChatCompletion({ chat_id: chatId, content });
      funded();
      return completion;
    };
    const failed = (err) => {
      refused(err);
      say({ level: 'warn', evt: 'dana.retell_failed', leadId: lead.lead_id, ...failure(err) });
    };
    let s = await session(lead, batch, language);
    if (s.error) return s;
    try {
      return { completion: await ask(s.chatId), newChat: s.created };
    } catch (err) {
      failed(err);
      if (s.created) return { error: 'retell_error' };
    }
    s = await session(lead, batch, language, { fresh: true });
    if (s.error) return s;
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

  async function think(lead, batch, language, auto) {
    const rows = inbox.messagesFor(lead.lead_id, { limit: CONTEXT_MESSAGES + batch.length });
    const input = brainInput({ rows, batch });
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
  async function send(lead, text, language, coversTs, { answer = false, viaBrain = false, guarded = false, document = null } = {}) {
    // Introduced = the flag OR any Dana row for this chat that is not `failed` (P4-12): a run
    // that crashed after its row was written may have sent her first message without setting
    // the flag. Read before this run's own row goes in. A purge stubs rows with lead_id NULL,
    // so a chat that comes back is introduced again.
    const introduced = introducedOf(lead);
    const prefix = viaBrain ? disclosureFor(lead.lead_id, language) : LEGACY_DISCLOSURE[language];
    const body = (introduced ? text : `${prefix}\n\n${text}`).replace(/\r\n?/g, '\n').trim();
    const jid = replyJidFor(lead);
    const sendId = `SND-${now().toString(36)}-${randomId(8)}`;
    const ins = inbox.insertOutbox({
      send_id: sendId, lead_id: lead.lead_id, jid, text: body, user_id: null, sender_kind: 'dana', status: 'pending', covers_ts: coversTs,
      media_kind: document ? 'document' : null,
    });
    if (!ins.inserted) return { sent: false, error: 'bad_send_id', failure: 'local' };
    if (guarded) prep('guard', 'UPDATE wa_outbox SET guarded = 1 WHERE send_id = ?').run(sendId);
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
      WHERE sender_kind = 'dana' AND created >= ? AND status IN ('failed','uncertain') AND ${EVOLUTION_ERRORS_SQL}
      AND lead_id = ?`).get(sinceTs, String(leadId)).n;
  /** The brain chats' counted failures since `sinceTs`, from the outbox (the breaker is brain/auto only; a restart forgets none). */
  function brainFailuresSince(sinceTs) {
    return prep('failsBy', `SELECT lead_id, COUNT(*) AS n FROM wa_outbox WHERE sender_kind = 'dana' AND created >= ?
        AND status IN ('failed','uncertain') AND ${EVOLUTION_ERRORS_SQL} AND lead_id IS NOT NULL GROUP BY lead_id`).all(sinceTs)
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
    if (brainFailuresSince(t - 30 * MINUTE_MS) >= SEND_FAILS_BREAKER && team.danaEnabled()) {
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
  async function sendFixed(lead, text, language, coversTs, viaBrain, { closing = false } = {}) {
    if (!viaBrain) return send(lead, text, language, coversTs);
    const wait = safely(() => pace.typingFloorMs({ chars: text.length, newestTs: coversTs })) ?? 0;
    if (wait > 0) await sleep(wait);
    const r = await pace.fifo(() => {
      // Re-checked in the queue (r2): a person who wrote meanwhile, Dana or Sending switched off, the chat
      // stopped (the closing line itself excepted), out of the inbox or lid-only: the line does not go.
      const l = db.getLead(lead.lead_id);
      if (!l || l.inbox_state !== 'in' || isExcludedLead(l)) return { sent: false, stopped: 'not_in_inbox' };
      if (identityBlocked()) return { sent: false, stopped: 'identity' };
      if (ruleOff(l)) return { sent: false, stopped: 'rule_off' };
      if (breakerOpen() || !(team.danaEnabled() || Number(l.dana_test) === 1)) return { sent: false, stopped: 'off' };
      if (!team.sendingEnabled()) return { sent: false, stopped: 'sending_off' };
      if (!closing && Number(l.dana_off) === 1) return { sent: false, stopped: 'chat_off' };
      if (inbox.humanOutboundAfter(lead.lead_id, coversTs)) return { sent: false, stopped: 'dropped_human' };
      if (!replyJidFor(l)) return { sent: false, stopped: 'lid_only' };
      return send(l, text, language, coversTs, { viaBrain: true });
    });
    if (r.uncertain || (!r.sent && r.failure === 'evolution')) afterFailure(lead, { alert: true });
    return r;
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
  async function handover(leadId, language, why, coversTs, { checked = false, details = {}, line = 'handover', stop = false, note = null, viaBrain = false } = {}) {
    if (!checked) {
      const pre = await preSend(leadId, coversTs);
      if (!pre.ok && HANDOVER_SKIPS.has(pre.reason)) return skip(leadId, pre.reason);
    }
    const fresh = db.getLead(leadId);
    if (!fresh || fresh.inbox_state !== 'in') return skip(leadId, 'not_in_inbox');
    const auto = autoOf(fresh);
    const already = Number(fresh.needs_human) === 1;
    db.transaction(() => {
      if (!already) inbox.setNeedsHuman(leadId, 1);
      ensureHandoff(db, { leadId, source: 'dana', reason: why, details, now: now() });
      if (stop) db.updateLead(leadId, { dana_off: 1 });
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
    const sent = !text || noJid ? false : (await sendFixed(fresh, text, language, coversTs, viaBrain, { closing: line === 'closing' })).sent;
    await notifyHandoff(leadId);
    say({ evt: 'dana.handover', leadId, why, sent });
    return { handover: why, sent };
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
    const t = now();
    // The same outage: this chat's brain_out hold, ended within the last hold span (the sweep's retry).
    // One that ended long ago (a person answered, nothing woke it since) is a past outage: start again.
    const until = Number(fresh.dana_hold_until);
    const sameOutage = fresh.dana_hold_reason === 'brain_out' && Number.isFinite(until) && t - until < BRAIN_OUT_HOLD_MS;
    // From the outbox (r2 N1): true = the line went in this outage, false = owed, undefined = a new outage.
    const lined = sameOutage ? outageLineSince(leadId, outageWindow(t)) : undefined;
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
      const r = await sendFixed(fresh, outageLine({ language, at: t }), language, coversTs, true);
      sent = Boolean(r.sent);
    }
    // A line owed (refused here, or no phone jid for now): a short hold, so the sweep tries the line again soon.
    if (!sent) setTimedHold(leadId, 'brain_out', t + RATE_HOLD_MS);
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
    // The backlog first-answers of the last hour, from the outbox (a restart forgets none): brain answers
    // (guarded=1) sent more than 30 min after the message they answered; plus the ones on their way now.
    const sent = prep('backlogSent', `SELECT COUNT(*) AS n FROM (SELECT DISTINCT lead_id, covers_ts FROM wa_outbox
        WHERE sender_kind = 'dana' AND status <> 'failed' AND guarded = 1 AND covers_ts IS NOT NULL AND created >= ?
          AND created - covers_ts > ?)`).get(t - HOUR_MS, BACKLOG_MS).n;
    const onTheirWay = [...backlogReserved].filter((id) => id !== except).length;
    return sent + onTheirWay < BACKLOG_PER_HOUR;
  }
  /** DESIGN §6.5: the first message carries a link only when the client sent a Ref, a listing id or a site URL. */
  function clientPointed(batch) {
    const host = safely(() => new URL(siteUrl).host);
    return batch.some((m) => {
      const s = typeof m.text === 'string' ? m.text : '';
      return REF_RE.test(s) || LISTING_ID_RE.test(s) || /bona-real-estate\.com/i.test(s) || (host ? s.toLowerCase().includes(host.toLowerCase()) : false);
    });
  }

  /** Bona's own site (cfg.siteUrl's host, and bona-real-estate.com): the only hosts a reply may link to, besides the maps link. */
  function onSite(url) {
    let host = '';
    try { host = new URL(url).host.toLowerCase(); } catch { return false; }
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
      let out = line;
      let cut = false;
      for (const url of line.match(LINK_RE) ?? []) {
        const clean = url.replace(/[).,;:!?»”]+$/u, '');
        const codeMaps = MAPS_RE.test(clean) && !String(modelText).includes(clean);
        if ((onSite(clean) || codeMaps) && kept < allowed) { kept += 1; continue; }
        out = out.replace(url, ' ');
        cut = true;
        stripped = true;
      }
      return cut ? trimWeakTail(out.replace(/\s{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1')) : out;
    });
    const out = lines.filter((l, i) => l.trim() || !/https?:\/\//i.test(orig[i])).join('\n').replace(/\n{3,}/g, '\n\n').trim();
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
    if (cap.reason === 'cap_day' && Number.isFinite(cap.until) && !out.skipped) setTimedHold(leadId, 'cap_day', cap.until);
    return out;
  }

  /** A brain chat refused by the sender's own limit: a timed hold that backs off (60 s, doubling, at most 30 min). */
  function rateHold(leadId) {
    const n = (rateStreak.get(leadId) ?? 0) + 1;
    rateStreak.set(leadId, n);
    setTimedHold(leadId, 'cap_chat', now() + Math.min(RATE_HOLD_MAX_MS, RATE_HOLD_MS * 2 ** (n - 1)));
  }

  /* ---------------- one run ---------------- */
  async function refusedRun(leadId, e) {
    if (e.reason === 'identity') {
      const t = now();
      if (t - identityAlertAt >= HOUR_MS) {
        identityAlertAt = t;
        safely(() => alerts?.notifyOwners?.({ reason: 'identity_mismatch' }));
      }
      return skip(leadId, 'identity');
    }
    if (e.reason === 'cap_chat' || CAP_HANDOVERS.has(e.reason)) {
      const lead = db.getLead(leadId);
      const viaBrain = useBrain(lead);
      // A brain chat's waiting messages include those an outage line covered (r3), like the run's batch.
      const waiting = viaBrain ? waitingFor(leadId, lead) : inbox.unansweredClientMessages(leadId, { limit: CONTEXT_MESSAGES });
      // A cap acts only for a client who is waiting: with nothing unanswered (a wake for a
      // batch another run answered) there is nobody to hand over — no flag, alert or line.
      if (!waiting.length) {
        if (viaBrain) clearEnded(leadId);
        return skip(leadId, 'nothing');
      }
      const language = languageOf({ lead, texts: waiting.map((m) => m.text) });
      const coversTs = waiting[waiting.length - 1].ts;
      // Past 2 h a brain chat's message is a person's, capped or not: `missed` once, and its hold ends (r3 N4).
      if (viaBrain && now() - coversTs > FRESH_MS) {
        clearEnded(leadId);
        if (db.getLead(leadId)?.dana_hold_reason === 'brain_out') clearHold(leadId);
        return handover(leadId, language, 'missed', coversTs, { line: 'none', note: { kind: 'missed' }, viaBrain });
      }
      return capped(leadId, language, e, coversTs, viaBrain);
    }
    return skip(leadId, e.reason);
  }

  async function run(leadId, ts, { wokeAt = null } = {}) {
    const started = now();
    // A legacy chat keeps main's freshness rule (the woken message, 30 min, a silent `old` skip); a brain
    // chat's is the batch's own (2 h, backlog, missed: below).
    const peek = db.getLead(leadId);
    const e = eligible(leadId, useBrain(peek) ? {} : { ts });
    if (!e.ok) {
      // An ended brain_out hold of a chat refused for another reason (Dana off, the chat stopped, Sending off,
      // lid-only, a rule off): the outage is over for it, so the sweep stops waking it every minute (r2 N2).
      // r3 N4: an ended timed hold of any reason (cap_day included), not only brain_out.
      if (!['cap_chat', 'cap_day', 'cap_chat_day', 'hold'].includes(e.reason)) clearEnded(leadId, started);
      return refusedRun(leadId, e);
    }
    const viaBrain = e.brain;
    const batch = viaBrain ? waitingFor(leadId, e.lead) : inbox.unansweredClientMessages(leadId, { limit: CONTEXT_MESSAGES });
    if (!batch.length) {
      backlog.delete(leadId);
      if (viaBrain && e.lead.dana_hold_reason) clearHold(leadId);
      return skip(leadId, 'nothing');
    }
    const lead = e.lead;
    const language = languageOf({ lead, texts: batch.map((m) => m.text) });
    const coversTs = batch[batch.length - 1].ts;
    if (!openChat(leadId, coversTs, started)) {
      if (viaBrain) clearEnded(leadId, started);
      return skip(leadId, 'no_open_chat');
    }
    let isBacklog = false;
    if (viaBrain) {
      // Freshness (DESIGN §4.2, §6.4): over 2 h is a person's; 30 min to 2 h waits for a stable link.
      const age = started - coversTs;
      if (age > FRESH_MS) {
        backlog.delete(leadId);
        clearEnded(leadId, started);
        if (lead.dana_hold_reason === 'brain_out') clearHold(leadId);
        return handover(leadId, language, 'missed', coversTs, { line: 'none', note: { kind: 'missed' }, viaBrain });
      }
      if (age > BACKLOG_MS) {
        if (!backlogAllowed(started)) {
          backlog.set(leadId, coversTs);
          return skip(leadId, 'backlog');
        }
        isBacklog = true;
      }
      backlog.delete(leadId);
    }
    // The code stop-word check, before any model call (DESIGN §4.1; both paths).
    const stopHit = batch.map((m) => (typeof m.text === 'string' ? matchStopWords(m.text) : null)).find(Boolean);
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

    // The model.
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
      turn = await think(lead, batch, language, e.auto);
      if (!turn.ok) {
        if (turn.code === 'refusal') return handover(leadId, language, 'brain_refusal', coversTs, { note: { kind: 'other', reason: 'brain_refusal' }, viaBrain });
        if (turn.code === 'guard') return handover(leadId, language, 'price_guard', coversTs, { note: { kind: 'price_guard' }, viaBrain });
        if (e.auto) return lastResort(lead, language, coversTs, turn.code, batch);
        // A legacy chat on the brain (dana_brain '1'): today's hand-over.
        return handover(leadId, language, turn.code, coversTs, { viaBrain });
      }
      // The brain answered: an outage hold of this chat is over.
      if (db.getLead(leadId)?.dana_hold_reason === 'brain_out') clearHold(leadId);
    } else {
      const c = await complete(lead, batch, language);
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
      const open = Number(db.getLead(leadId)?.needs_human) === 1;
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
          const real = lim.text.trim() && (/https?:\/\//i.test(lim.text) || !lim.text.split('\n').filter((l) => l.trim()).every(weakLine));
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
    const links = viaBrain ? bubbles.reduce((n, b) => n + (b.kind === 'text' ? (b.text.match(LINK_RE) ?? []).length : 0), 0) : cardLinks;
    // Documents (DESIGN §6.3): DOCS_PER_CHAT_PER_DAY per chat and DOCS_PER_DAY overall (days 0-21) in the rolling
    // day, from the outbox; a document over either goes as its link instead (a belt for PR-B4's own cap; r3).
    {
      const caps = tierAt(now());
      const since = now() - DAY_MS;
      let chatDocs = prep('docsChat', `SELECT COUNT(*) AS n FROM wa_outbox WHERE lead_id = ? AND sender_kind = 'dana' AND media_kind = 'document'
          AND status <> 'failed' AND created >= ?`).get(String(leadId), since).n;
      let allDocs = prep('docsAll', `SELECT COUNT(*) AS n FROM wa_outbox WHERE sender_kind = 'dana' AND media_kind = 'document'
          AND status <> 'failed' AND created >= ?`).get(since).n;
      bubbles = bubbles.map((b) => {
        if (b.kind !== 'document') return b;
        const over = chatDocs >= caps.DOCS_PER_CHAT_PER_DAY || (caps.DOCS_PER_DAY !== null && allDocs >= caps.DOCS_PER_DAY);
        if (!over) { chatDocs += 1; allDocs += 1; return b; }
        say({ evt: 'dana.document_as_link', leadId });
        return { kind: 'text', text: `${String(b.caption).trim()} — ${b.url}` };
      });
    }
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
      const go = async () => {
        // In the queue a person may have written: preSend ran before the wait, so the cheap re-check goes here.
        if ((viaBrain || i > 0) && inbox.humanOutboundAfter(leadId, coversTs)) return { stopped: 'dropped_human' };
        const fresh = db.getLead(leadId);
        if (i > 0 || viaBrain) {
          const again = eligible(leadId, { coversTs });
          // Only a continuation of a turn already counted (a bubble of it went) may pass a cap; a first bubble
          // that a cap now stops (another chat's turn filled it in the queue) does not go (Codex T12 r1).
          const cap = again.reason === 'cap_chat' || CAP_HANDOVERS.has(again.reason);
          if (!again.ok && !(cap && sentAny)) return { stopped: again.reason, cap: cap ? again : null };
        }
        // The first bubble of a brain turn re-reads the message's age at send time (DESIGN §6.4; r3): past 2 h it
        // is missed; past 30 min it is backlog even when it was not before the model call. A backlog turn's first
        // bubble re-checks the ten-an-hour allowance and holds a place while it goes, so two turns that both
        // passed before the model call cannot both go (r2).
        const age = now() - Number(coversTs);
        if (viaBrain && !sentAny && age > FRESH_MS) return { stopped: 'missed' };
        const reserve = viaBrain && !sentAny && (isBacklog || age > BACKLOG_MS);
        if (reserve) {
          if (!backlogAllowed(now(), { except: leadId })) return { stopped: 'backlog' };
          backlogReserved.add(leadId);
        }
        try {
          return await send(fresh ?? pre.lead, b.kind === 'text' ? b.text : b.caption, language, coversTs, {
            answer: b.kind === 'text' && !sentAny && !commitKind && !b.neutral, viaBrain, guarded: bubbleGuarded && !b.neutral,
            ...(b.kind === 'document' ? { document: { url: b.url, fileName: typeof b.fileName === 'string' ? b.fileName : 'brochure.pdf' } } : {}),
          });
        } finally {
          if (reserve) backlogReserved.delete(leadId);
        }
      };
      const r = viaBrain ? await pace.fifo(go) : await go();
      if (b.bookingId) told = r.accepted === true;
      if (r.stopped) {
        if (r.stopped === 'backlog' && !sentAny) backlog.set(leadId, coversTs);
        if (r.stopped === 'missed' && !sentAny) {
          backlog.delete(leadId);
          clearEnded(leadId);
          outcome = await handover(leadId, language, 'missed', coversTs, { checked: true, line: 'none', note: { kind: 'missed' }, viaBrain });
          break;
        }
        if (!sentAny) outcome = r.cap ? await capped(leadId, language, r.cap, coversTs, viaBrain, { checked: true }) : skip(leadId, r.stopped);
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
        await handover(leadId, language, 'send_failed', coversTs, { checked: true, line: 'none', note: held ? { kind: 'send_failed' } : null, viaBrain });
        outcome = { handover: 'send_failed', sent: false };
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
      if (viaBrain && r.error === 'rate_limited') rateHold(leadId);
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
    // An ended timed hold is over once she answered: no stale reason stays on the row (r2).
    const after = db.getLead(leadId);
    // (A hold with no time waits for a person: never cleared here. Number(null) is 0, so null is ruled out first.)
    const ends = after?.dana_hold_until;
    if (after?.dana_hold_reason && ends !== null && ends !== undefined && Number(ends) <= now()) clearHold(leadId);
    const doneAt = now();
    const latencyMs = Math.max(0, doneAt - coversTs);
    latencies.push(latencyMs);
    if (latencies.length > LATENCY_RING) latencies.shift();
    const woke = Number.isFinite(wokeAt) ? wokeAt : started;
    const stages = {
      poll: Math.max(0, woke - coversTs), batch: Math.max(0, started - woke), brain: brainMs, guard: guardMs, hold: Math.max(0, doneAt - holdAt),
    };
    say({ evt: 'dana.answered', leadId, batch: batch.length, chars, links, newChat, latencyMs, stages });
    return { answered: true, chars, links, newChat };
  }

  /**
   * One run per chat at a time: a call made while a run is in flight waits for it, so two
   * runs never read the same batch. Never rejects.
   */
  function answer(leadId, { ts = null, wokeAt = null } = {}) {
    const id = String(leadId ?? '');
    const prev = inflight.get(id) ?? Promise.resolve();
    const p = prev.then(() => run(id, ts, { wokeAt })).catch((err) => {
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
    try {
      const ended = prep('ended', `SELECT lead_id, dana_hold_reason FROM leads WHERE inbox_state = 'in' AND dana_hold_reason IS NOT NULL
          AND dana_hold_until IS NOT NULL AND dana_hold_until <= ? ORDER BY dana_hold_until`).all(t);
      const capDay = [];
      for (const r of ended) {
        const waiting = waitingFor(r.lead_id);
        // Nothing waits, or what waits is past 24 h (never answered: never first): the hold ends, no wake (r3 N4).
        if (!waiting.length || Number(waiting[waiting.length - 1].ts) < t - DAY_MS) { clearHold(r.lead_id); continue; }
        // The day cap: each freed turn wakes one waiting chat, the oldest first (below); its hold reason stays
        // so a chat still capped only waits again, with no repeat hand-over (r2).
        if (r.dana_hold_reason === 'cap_day') { capDay.push({ id: r.lead_id, oldest: Number(waiting[0].ts), ts: waiting[waiting.length - 1].ts }); continue; }
        if (r.dana_hold_reason !== 'brain_out') clearHold(r.lead_id);
        answer(r.lead_id, { ts: waiting[waiting.length - 1].ts });
        woken += 1;
      }
      if (capDay.length) {
        const caps = tierAt(t);
        let free = Math.max(0, caps.PER_DAY - inbox.countDanaTurns({ sinceTs: t - DAY_MS }));
        for (const c of capDay.sort((a, b) => a.oldest - b.oldest)) {
          if (free > 0) {
            free -= 1;
            answer(c.id, { ts: c.ts });
            woken += 1;
          } else {
            setTimedHold(c.id, 'cap_day', dayFreesAt(t, caps.PER_DAY));
          }
        }
      }
      for (const [id, ts] of [...backlog].sort((a, b) => a[1] - b[1])) {
        backlog.delete(id);
        answer(id, { ts });
        woken += 1;
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
  const latency = () => ({ n: latencies.length, p50: percentile(latencies, 50), p90: percentile(latencies, 90) });
  /** For /health (PR-INT): the breaker is the system's own switch-off (DESIGN §4.2). Booleans only. */
  function health() {
    return { breaker: breakerOpen() };
  }

  return { configured, eligible, wake, answer, flush, stop, status, sweep, latency, health };
}
