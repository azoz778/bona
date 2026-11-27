/**
 * The owner's WhatsApp notes (DESIGN §7.1-7.2; PLAN T11, PR-B2; DESIGN-brain §4.2, §10). It
 * replaces the PR-F2b stub with the ledger `owner_notes` (db v8).
 *
 * A note is first a ROW: `queued`, one per `dedupe_key` ever, `meta` = JSON of codes only (a
 * kind, a reason code, a booking id, an event id, a test flag), never a name, a number or a
 * client's words. It is rendered from the database WHEN IT IS SENT, so a name changed meanwhile
 * shows the new name, and its text is never stored anywhere. Only the transport writes an
 * outbox row, at send time (lib/wa-send.mjs kind 'note': no lead, no text), so a queued note is
 * never a `pending` outbox row that the start-up recovery or the stale-pending upkeep could
 * strand.
 *
 * The kinds (DESIGN §7.2), each with its trigger key:
 *   - new_client `new:<lead>`: a lead CREATED by a form, a concierge chat, the poller or email,
 *     or a chat that first JOINED the inbox under the own-number rule (why 'joined', which also
 *     covers a returning lead, G13). A merge (created false) sends nothing. Due at once for a
 *     form or a concierge chat; a WhatsApp or email client at min(first answer + 20 s, first
 *     message + 3 min). Today's leadNote() lines byte for byte, then (auto mode only) Wants,
 *     First message and the AI line, then the Lead link.
 *   - handover `ho:<lead>:<kind>:<10-min bucket>` (auto mode only): the only dedupe, so the same
 *     kind 11 min later alerts again (critic round 2 #11). Kind `brain` (an AI outage) takes an
 *     HOUR bucket and folds into that hour's `brain_out` alert, which lists the chats (the next
 *     hour's once this hour's went, and that one never goes before its hour): one note an hour
 *     however many chats wait. Its sentence is chosen when it goes, from the outage's LATEST
 *     cause (below, `brain_out:cause`), and the row then keeps the code it went with. An outage
 *     alert dropped while owner notes were off is queued again by the next hand-over or alert once
 *     they are on; with notes off a brain hand-over opens no alert. A chat already handed over in
 *     the hour (a duplicate) opens none either; its row dropped while notes were off is queued
 *     again by its next hand-over that hour. An alert that alert('brain_out') asked for goes even
 *     with no chat to list (the outage's own news); one only a hand-over opened goes only with
 *     chats (its chats purged or out of auto mode: dropped at its hour, never sent empty).
 *     THE INVARIANT: a brain hand-over is never sent on its own nor drawn with the hand-over
 *     header. It comes to whatever its alert comes to (sent: merged into it; uncertain, failed,
 *     dropped or held over the day's 40 alike), a chat that joined between two of the alert's
 *     attempts too; a stray one (no queued alert for its hour) joins the next open hour's alert,
 *     or is dropped when none is left, and is logged by count.
 *   - booking `bk:<id>` / `bk-untold:<id>`, stopped `stop:<lead>:<ts>` (auto mode only).
 *   - summary `sum:<day>` / `sumtest:<ts>` (only while owner_as_client or own_inbox is '1';
 *     lib/daily-summary.mjs).
 *   - command `cmd:<record id>` (the `#dana` reply; its text is held in memory only, so a reply
 *     queued when the process stops is dropped, never stored).
 *   - alert `al:<code>:<hour>` (a fixed sentence per code; ALERT_CODES), `al:old_out_wrote:<lead
 *     or candidate>:<day>`. Link-down and identity alerts go by web push and Kuma only, never
 *     as a WhatsApp note through another instance: they are refused here.
 *   - mail `mail:<message id>` (Track C; sender and subject read at send time from mail_seen).
 *   - one row that is never a note: `brain_out:cause` (kind alert, always `dropped`, no lead, no
 *     send), whose meta holds only the outage cause code the last alert('brain_out', {code})
 *     brought (quota/auth/down/budget), recorded even when that call was a duplicate or owner
 *     notes were off. Never queued, sent, counted or purged.
 * Same-release rule (DESIGN §2): hand-over, booking and stopped notes go only for a lead in auto
 * mode (checked when queued and again when sent); new_client, command and alert notes always
 * go, a new client outside auto mode with today's lines plus the Lead link only.
 *
 * Sending (DESIGN §7.1):
 *   - everything due within 2 min goes as ONE message (at most 3,500 characters; what does not
 *     fit waits for the next send): the first row `sent`, the others `merged` into it. A summary
 *     always goes on its own (nothing joins it, and it joins nothing);
 *   - at least 25 s between two sends, read back from the ledger so a restart cannot skip it;
 *   - at most 40 sends a (Riyadh) day, every kind counted, the summary included, a send that may
 *     have gone too (a restart mid-call), and a purged lead's (onPurge below): the overflow is
 *     kept for the summary (`merged`, `over`; an outage alert with the chats it lists, each
 *     `into` it, so none of them goes alone when the next day's 40 begins), but never while
 *     Sending is off (nothing goes then, so a note stays queued and held, and the day it goes in
 *     decides once Sending is back on).
 *     While summaries are on and the day's 08:00 summary
 *     has not gone yet, one of the 40 is kept for it, so the note that carries the overflow is
 *     never itself held back (DESIGN §7.3: exactly one a day) and the total stays at 40;
 *   - each send's rows are marked `uncertain`, with the send's id, BEFORE the call: a process that dies mid-send
 *     leaves them so, and they are never sent again. The answer then decides: ok → sent; the
 *     Sending switch off or the note's minute used up → back to queued, held (30 s / 15 s, or
 *     at once when Sending is back on), sent later, nothing lost; an answer that may have gone
 *     (timeout, 5xx, a throw, no ack) → uncertain, never retried; any other refusal (BONA_WA_NOTIFY
 *     =0, Evolution not configured, a 4xx) → retried once, 2 min after the failure (never sooner:
 *     an answer no longer brings it forward, and no earlier send takes it along), then failed;
 *   - the `owner_notes` switch '0' drops new and queued notes.
 * Form enquiries (critic round 2 #17b): the form path's note is due at once and the request
 * awaits the first attempt for up to 4 s, as before; `enquiry_receipts.notify_status` follows the
 * ledger: held → pending, sent → sent, failed or uncertain → uncertain (a later send moves it on),
 * dropped → dropped, held over the day's limit → over, a merge → skipped. enquiry-receipt.mjs
 * leaves a receipt whose own note (by its event id) is still queued alone at start-up.
 *
 * The transport is the injected `sendNote(text)` → `{ ok, error?, uncertain?, sendId? }`. index.mjs
 * hands in today's (lib/wa.mjs sendText to the owner's chat); PR-INT (T14) moves it onto the one
 * sender's kind 'note' (lib/wa-send.mjs: the owner's jid only, its own `note:to:` limit, an outbox
 * row without text or lead), whose refusals this file already holds or retries as above.
 *
 * The module wakes itself when its next note is really due (one unref'd timer, at most a minute
 * ahead): the answer-adjusted time, the 25 s gap and a hold taken into account, and every 5 s
 * while a WhatsApp client's note waits for the assistant's first answer, so an answer is seen in
 * time. Only an answer WhatsApp took (outbox `accepted`) counts, from the time it was taken; one
 * still in flight does not.
 * A pass that throws still re-arms the timer. PR-INT's 5 s tick is welcome (one run at a time).
 * Nothing here logs a note's text, a name or a number: ids and codes only. A purge deletes a
 * lead's rows through the store's `onPurge` seam (rows only, never the network); a row holding
 * one of today's sends is kept for the count with nothing of the lead left on it.
 *
 * INERT until PR-INT (PLAN §0, the INERT rule; Codex r1 P0 on PR-B2): all of the above runs only
 * when the caller opts in with `createOwnerNotes({ ledger: true, … })`, which PR-INT (T14, the
 * owner of index.mjs) passes. Without it the module is today's path, kept byte for byte below
 * (`createTodaysNotes`, the PR-F2b stub): the form's note sent at once through the given
 * `sendNote`, merges told too, the receipt `sent` or `uncertain`; no queue, no timer, no pick-up
 * at start, no switch; every other kind a no-op.
 */
import { leadNote } from './leads.mjs';
import { randomId } from './store.mjs';
import { dayKey, dayStart, TZ_OFFSET_MS } from './dashboard/stats.mjs';
import {
  renderSummary, summaryOn, SUMMARY_HEADER, DEFAULT_PUBLIC_API, oneLine, displayName, dayLabel, clockLabel, formatDuration,
} from './daily-summary.mjs';

/** How long the form request waits for its note's first attempt (today's index.mjs value). */
export const FORM_NOTIFY_WAIT_MS = 4000;
/** Notes due within this much of a due note go in the same message. */
export const MERGE_WINDOW_MS = 2 * 60_000;
/** The least time between two sends. */
export const MIN_GAP_MS = 25_000;
/** Sends a Riyadh day; the rest is held for the summary. */
export const MAX_PER_DAY = 40;
/** The longest message (wa-send.mjs refuses over 4,096). */
export const MAX_NOTE_CHARS = 3500;
/** A definite failure is tried once more after this. */
export const RETRY_AFTER_MS = 2 * 60_000;
/** A WhatsApp client's note: this long after the assistant's first answer… */
export const ANSWER_GRACE_MS = 20_000;
/** …and at the latest this long after their first message. */
export const FIRST_MESSAGE_WAIT_MS = 3 * 60_000;
/** A queued note this overdue makes /health notes.ok false. */
export const STUCK_MS = 15 * 60_000;
/** The hand-over dedupe bucket (kind `brain`: an hour). */
export const HANDOVER_BUCKET_MS = 10 * 60_000;
/** A transport that has not answered by then is taken as uncertain (its rows are never sent again). */
export const SEND_TIMEOUT_MS = 30_000;
/** How often the module looks for the assistant's first answer while a WhatsApp client's note waits for one. */
export const ANSWER_POLL_MS = 5_000;

const HOUR_MS = 3_600_000;
const HOLD_MS = { sending_disabled: 30_000, rate_limited: 15_000 };
const MAX_TIMER_MS = 60_000;
const QUOTE_CHARS = 80;
const SUBJECT_CHARS = 60;
const MAX_LISTED_CHATS = 10;

/** The first line of each kind. wa-poller's OWN_NOTE_RE knows every one (DESIGN §7.1). */
export const HEADERS = Object.freeze({
  new_client: '*Bona — new enquiry*', // leadNote()'s own first line
  handover: '*Bona — hand-over*',
  booking: '*Bona — viewing booked*',
  stopped: '*Bona — assistant stopped*',
  summary: SUMMARY_HEADER,
  command: '*Bona — test mode*',
  alert: '*Bona — alert*',
  mail: '*Bona — email*',
});

/** The alert codes a WhatsApp note may carry. */
export const ALERT_CODES = Object.freeze(['breaker', 'greeting_away', 'turns_month', 'gcal', 'mail', 'brain_out', 'brain_spend', 'brain_bug', 'old_out_wrote']);
/** Never by WhatsApp: the link is down, or the instance may not be Bona's (DESIGN §5.3, §7.2). */
const PUSH_ONLY_ALERTS = new Set(['link_down', 'identity']);
/** The only upstream error codes a note prints (DESIGN §5.4's enum): never upstream text. */
const ERROR_CODES = new Set(['auth', 'forbidden', 'not_found', 'timeout', 'quota', 'network', 'bad_response']);
const BRAIN_OUT = Object.freeze({
  quota: "OpenAI credit ran out. Lisa's voice and the Bona phone line use the same balance and are affected too. Top up at platform.openai.com.",
  auth: 'OpenAI refused the Bona key (auth). Clients get a holding line and are handed to you until it is fixed.',
  down: 'The AI service (OpenAI) is not answering. Clients get a holding line and are handed to you.',
  budget: 'The AI spend stop was reached. Clients get a holding line until the day or the month rolls over.',
});

/**
 * A hand-over's reason in words, by its code: request_human's kinds (DESIGN §4.3) and the
 * assistant's own reasons. Never the model's words.
 */
export const HANDOVER_REASONS = Object.freeze({
  person: 'the client asked for a person',
  offer: 'the client wants to make an offer',
  complaint: 'the client has a complaint',
  contract: 'the client asked about a contract',
  selling: 'the client wants to sell a property',
  viewing: 'the client wants a viewing',
  other: 'the client needs a person',
  stop: 'the client asked the assistant to stop',
  privacy: 'the client asked about their privacy',
  deletion: 'the client asked for their data to be deleted',
  cap_day: "the assistant reached today's answer limit",
  cap_chat: "the assistant reached this chat's hourly limit",
  missed: 'a message waited more than 2 hours without an answer',
  loop: 'the conversation was going in circles',
  send_failed: "WhatsApp did not take the assistant's messages",
  brain: 'the AI service is not answering',
  price_guard: 'the answer named a price that is not published, so it was not sent',
  booking_failed: 'a viewing could not be booked',
  brain_refusal: 'the AI would not answer this message',
  empty: 'the assistant had no answer',
  retell_error: 'the assistant could not answer',
  budget: "the assistant's budget for today is used up",
});
const STOP_REASONS = Object.freeze({
  stop: 'the client asked the assistant to stop',
  privacy: 'the client asked about their privacy',
  deletion: 'the client asked for their data to be deleted',
  loop: 'the conversation was going in circles',
});
const MAIL_WHAT = Object.freeze({
  possible_client: 'Possibly a client: the AI did not answer it; please check.',
  platform: 'A platform or security email: please read it.',
  over_cap: 'A client wrote again after the AI reached its reply limit: please answer them.',
  stop: 'The sender asked us to stop emailing them.',
});
const CHANNEL_WORDS = Object.freeze({
  whatsapp: 'WhatsApp', form: 'website form', concierge_chat: 'website chat', chat: 'website chat', concierge_voice: 'phone', voice: 'phone', email: 'email',
});
const WHYS = new Set(['form', 'concierge', 'wa', 'joined', 'email']);
/** Due at once (a person filled in a form or a chat on the site). */
const QUICK_WHYS = new Set(['form', 'concierge']);
/** A WhatsApp client: the assistant's first answer pulls the note forward, and its line says how fast. */
const ANSWERED_WHYS = new Set(['wa', 'joined']);
/** Answers that may mean the message went: never sent again. */
const UNCERTAIN_ERRORS = new Set(['', 'timeout', 'no_ack', 'network', 'threw', 'duplicate']);
/** What a note may carry as an id (a lead, a candidate, a booking, a record, a message, an event). */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const DAY_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

const defaultSetTimer = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return handle;
};
const defaultClearTimer = (handle) => clearTimeout(handle);

/** At most `max` UTF-16 units (what wa-send.mjs measures), never splitting a surrogate pair. */
function clipUnits(s, max) {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return out;
}
/** A leadNote() block and its tail, cut before the tail (with "…") when the whole is too long. */
function fit(block, tail) {
  const whole = `${block}\n${tail}`;
  if (whole.length <= MAX_NOTE_CHARS) return whole;
  return `${clipUnits(block, Math.max(0, MAX_NOTE_CHARS - tail.length - 2))}…\n${tail}`;
}
const channelWords = (channel) => CHANNEL_WORDS[String(channel ?? '').toLowerCase()] ?? (oneLine(channel, 20) || 'unknown channel');
const who = (lead) => `${displayName(lead)} (${channelWords(lead?.channel)})`;
const errName = (err) => (typeof err?.code === 'string' && /^[A-Z_a-z]{1,40}$/.test(err.code) ? err.code
  : typeof err?.name === 'string' && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'Error');
const errMessage = (err) => {
  const m = String(err?.message ?? '');
  // A short plain message, as the form path logged before; never one carrying a number.
  return /^[\w .,:'()-]{1,80}$/.test(m) && !/\d{5}/.test(m) ? m : 'error';
};

/**
 * @typedef {object} OwnerNotes
 * @property {(lead: object, o: { why: string, created?: boolean, eventId?: string|null, ts?: number|null }) => Promise<void>} leadEvent
 * @property {(lead: object|string, o: { kind: string, coversTs?: number|null, reason?: string|null }) => { queued: boolean, reason?: string }} handover
 * @property {(bookingId: string, o: { told: boolean }) => { queued: boolean, reason?: string }} booking
 * @property {(lead: object|string, reason: string) => { queued: boolean, reason?: string }} stopped
 * @property {(code: string, meta?: object) => { queued: boolean, reason?: string }} alert
 * @property {(item: { messageId: string, what: string }) => { queued: boolean, reason?: string }} mail
 * @property {(recId: string, text: string) => { queued: boolean, reason?: string }} command
 * @property {(o: { day?: string, days?: number, test?: boolean, ts?: number }) => { queued: boolean, reason?: string }} summary
 * @property {(leadId: string) => void} onPurge   inside purgeLead's transaction; rows only, no network
 * @property {() => Promise<void>} tick           send what is due (one run at a time; never rejects)
 * @property {() => void} stop                    no more timers, no more sends
 * @property {() => { enabled: boolean, ok: boolean }} health  the /health `notes` keys
 */

/**
 * `ledger: true` (PR-INT) is the ledger described above; anything else is today's path.
 * @param {{ ledger?: boolean, db?: object|null, siteUrl?: string, publicApi?: string,
 *           sendNote?: ((text: string) => Promise<{ ok?: boolean, error?: string, uncertain?: boolean, sendId?: string }>)|null,
 *           team?: object|null, ownerTest?: object|null, inventory?: object|null, brain?: object|null, viewing?: object|null,
 *           waLink?: object|null, mail?: object|null, log?: Function, now?: () => number, formWaitMs?: number,
 *           tzOffsetMs?: number, setTimer?: Function|null, clearTimer?: Function }} [o]
 * @returns {OwnerNotes}
 */
export function createOwnerNotes(o = {}) {
  return o?.ledger === true ? createLedgerNotes(o) : createTodaysNotes(o ?? {});
}

/** The ledger (DESIGN §7.1-7.2): what PR-INT turns on with `ledger: true`. */
function createLedgerNotes({
  db = null, siteUrl, publicApi = DEFAULT_PUBLIC_API, sendNote = null, team = null, ownerTest = null,
  inventory = null, brain = null, viewing = null, waLink = null, mail = null,
  log = () => {}, now = () => Date.now(), formWaitMs = FORM_NOTIFY_WAIT_MS, tzOffsetMs = TZ_OFFSET_MS,
  setTimer = defaultSetTimer, clearTimer = defaultClearTimer,
} = {}) {
  const off = tzOffsetMs;
  const api = String(publicApi || DEFAULT_PUBLIC_API).replace(/\/+$/, '');
  const link = (path) => `${api}${path}`;
  const leadLine = (id) => `Lead: ${link(`/dashboard/leads/${encodeURIComponent(id)}`)}`;
  const say = (entry) => { try { log(entry); } catch { /* a logger never stops a note */ } };
  const summaryDeps = { db, team, ownerTest, brain, viewing, waLink, mail, publicApi: api, tzOffsetMs: off };

  const texts = new Map();     // note_id → a command reply's text (memory only)
  const inflight = new Set();  // note ids whose send is out
  let timer = null;
  let timerAt = Infinity;
  let halted = false;
  let running = null;
  let again = false;
  let lastAttemptAt = 0;
  let hold = null;             // { until, reason }: the transport said "not now"

  const cache = new Map();
  const prep = (sql) => {
    let stmt = cache.get(sql);
    if (!stmt) { stmt = db.db.prepare(sql); cache.set(sql, stmt); }
    return stmt;
  };
  const parseMeta = (raw) => {
    try {
      const m = JSON.parse(raw ?? '{}');
      return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
    } catch {
      return {};
    }
  };
  const rowOf = (r) => (r ? { ...r, meta: parseMeta(r.meta) } : null);
  const byKey = (key) => rowOf(prep('SELECT * FROM owner_notes WHERE dedupe_key = ?').get(key));
  const notesOn = () => {
    if (!team || typeof team.ownerNotesEnabled !== 'function') return true;
    try { return team.ownerNotesEnabled() === true; } catch { return false; }
  };
  const sendingOn = () => {
    try { return team?.sendingEnabled?.() === true; } catch { return false; }
  };
  /** The Sending switch is known to be off (a team that cannot tell is not "off": the transport decides). */
  const sendingOff = () => {
    if (typeof team?.sendingEnabled !== 'function') return false;
    try { return team.sendingEnabled() !== true; } catch { return false; }
  };
  const auto = (lead) => {
    try { return Boolean(lead) && ownerTest?.autoMode?.(lead) === true; } catch { return false; }
  };
  const leadOf = (x) => {
    const id = typeof x === 'string' ? x : x?.lead_id;
    if (!db || !id) return null;
    try { return db.getLead(String(id)); } catch { return null; }
  };
  const setReceipt = (eventId, status) => {
    if (!db || !eventId) return;
    prep('UPDATE enquiry_receipts SET notify_status = ? WHERE event_id = ?').run(status, String(eventId));
  };
  const answer = (r) => (r.inserted && r.status === 'queued' ? { queued: true }
    : { queued: false, reason: r.inserted ? 'dropped' : 'duplicate' });
  /** The note's lead was purged since the row was read: a record with its own key (onPurge), or gone. */
  const purgedNote = (noteId) => {
    const r = prep('SELECT dedupe_key FROM owner_notes WHERE note_id = ?').get(String(noteId));
    return !r || r.dedupe_key === `purged:${noteId}`;
  };

  /* ---------------- the timer ---------------- */

  function arm(at, floorMs = 0) {
    if (!setTimer || halted || !Number.isFinite(at)) return;
    const t = now();
    const delay = Math.max(floorMs, Math.min(MAX_TIMER_MS, Math.ceil(at - t)));
    if (timer && timerAt <= t + delay) return;
    if (timer) { try { clearTimer(timer); } catch { /* replaced below */ } }
    timerAt = t + delay;
    timer = setTimer(() => { timer = null; timerAt = Infinity; return tick(); }, delay);
  }
  /**
   * When to look next: the earliest real due time of a queued note (an answer brings a WhatsApp
   * client's forward), or 5 s ahead while one still waits for its answer; never inside the 25 s
   * gap or a hold. Infinity when nothing is queued.
   */
  function wakeAt(t) {
    const queued = prep("SELECT * FROM owner_notes WHERE status = 'queued'").all().map(rowOf);
    const brainHours = new Set(queued.filter(isBrainAlert).map((r) => r.meta.hour));
    let at = Infinity;
    for (const r of queued) {
      // A brain hand-over goes with its hour's alert, whose own time stands for it (a stray one, with
      // no queued alert, wakes the pass that gives it one: adoptStrays).
      if (isBrainHandover(r) && brainHours.has(r.meta.alertHour)) continue;
      let when;
      try { when = timing(r); } catch { when = { due: r.due_ts, waiting: false }; }
      at = Math.min(at, when.due);
      if (when.waiting && when.due > t) at = Math.min(at, t + ANSWER_POLL_MS);
    }
    if (!Number.isFinite(at)) return Infinity;
    at = Math.max(at, lastSendTs() + MIN_GAP_MS);
    if (hold) at = Math.max(at, hold.until);
    return at;
  }
  /** `dueFloorMs`: how long a note already due waits (after a pass: a second, never a busy loop). */
  function armNext(dueFloorMs = 1000) {
    if (!db || halted || !setTimer) return;
    const t = now();
    const at = wakeAt(t);
    if (Number.isFinite(at)) arm(at, at > t ? 0 : dueFloorMs);
  }

  /* ---------------- the ledger ---------------- */

  function enqueue({ kind, leadId = null, key, due, meta = {} }) {
    const t = now();
    const status = notesOn() ? 'queued' : 'dropped';
    const id = `NOTE-${t.toString(36)}-${randomId(6)}`;
    const ins = prep(`INSERT INTO owner_notes (note_id, kind, lead_id, dedupe_key, due_ts, status, send_id, meta, created, updated)
                      VALUES (?,?,?,?,?,?,NULL,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING`)
      .run(id, kind, leadId, key, Math.trunc(due), status, JSON.stringify(meta), t, t);
    const inserted = ins.changes === 1;
    if (inserted && status === 'queued') armNext(0);
    return { inserted, noteId: inserted ? id : null, status: inserted ? status : 'exists' };
  }

  /** An outage alert that went, or may have; a dropped one has not (it can be queued again). */
  const BRAIN_GONE = new Set(['sent', 'merged', 'uncertain', 'failed']);
  const brainCode = (code) => (Object.hasOwn(BRAIN_OUT, code) ? code : 'down');
  /** The one row that holds the outage's latest cause (a code only): never queued, so never a note. */
  const BRAIN_CAUSE_KEY = 'brain_out:cause';
  /** alert('brain_out', {code}) records its cause here every time, a duplicate or not, notes on or off. */
  function recordBrainCause(why) {
    const t = now();
    prep(`INSERT INTO owner_notes (note_id, kind, lead_id, dedupe_key, due_ts, status, send_id, meta, created, updated)
          VALUES (?, 'alert', NULL, ?, ?, 'dropped', NULL, ?, ?, ?)
          ON CONFLICT(dedupe_key) DO UPDATE SET meta = excluded.meta, updated = excluded.updated`)
      .run(`NOTE-${t.toString(36)}-${randomId(6)}`, BRAIN_CAUSE_KEY, t, JSON.stringify({ cause: why }), t, t);
  }
  /** The latest cause an outage alert recorded, or null when none ever was. */
  const latestBrainCause = () => {
    const c = byKey(BRAIN_CAUSE_KEY)?.meta.cause;
    return typeof c === 'string' && Object.hasOwn(BRAIN_OUT, c) ? c : null;
  };
  /**
   * The first hour, from `hour` on (at most a day ahead), whose brain_out alert has not gone: none
   * yet, queued, or dropped while owner notes were off (never counted as gone, or each hand-over
   * made while notes were off would push the next chat another hour). `row` is that hour's alert
   * if there is one.
   */
  function openBrainHour(hour) {
    let alertHour = hour;
    let row = byKey(`al:brain_out:${alertHour}`);
    for (let i = 0; i < 24 && row && BRAIN_GONE.has(row.status); i += 1) {
      alertHour += 1;
      row = byKey(`al:brain_out:${alertHour}`);
    }
    return { alertHour, row };
  }
  /**
   * Hour `alertHour`'s brain_out alert, due at `due`, with the cause `code` (only a fallback: the
   * sentence is the latest cause when it goes): a new row, or a dropped one queued again (owner
   * notes are on). A queued one or one that went is left as it is. True when this call queued it.
   * `asked`: alert('brain_out') asked for this hour's alert (meta `asked`), which then goes even
   * with no chat to list (the outage's own news); one only a hand-over opened goes only with chats
   * (renderAlert). An alert() of the hour whose alert a hand-over already queued marks it so.
   */
  function openBrainAlert(alertHour, due, code, asked = false) {
    if (!notesOn()) return false;
    const t = now();
    const key = `al:brain_out:${alertHour}`;
    const id = `NOTE-${t.toString(36)}-${randomId(6)}`;
    const meta = JSON.stringify({ alert: 'brain_out', code: brainCode(code), hour: alertHour, ...(asked ? { asked: 1 } : {}) });
    const r = prep(`INSERT INTO owner_notes (note_id, kind, lead_id, dedupe_key, due_ts, status, send_id, meta, created, updated)
                    VALUES (?, 'alert', NULL, ?, ?, 'queued', NULL, ?, ?, ?)
                    ON CONFLICT(dedupe_key) DO UPDATE SET status = 'queued', due_ts = excluded.due_ts, meta = excluded.meta, updated = excluded.updated
                    WHERE owner_notes.status = 'dropped' AND owner_notes.send_id IS NULL`)
      .run(id, key, Math.trunc(due), meta, t, t);
    if (r.changes === 1) { armNext(0); return true; }
    if (asked) {
      const row = byKey(key);
      if (row?.status === 'queued' && !row.meta.asked) {
        prep("UPDATE owner_notes SET meta = ? WHERE note_id = ? AND status = 'queued'").run(JSON.stringify({ ...row.meta, asked: 1 }), row.note_id);
      }
    }
    return false;
  }

  // Only an answer WhatsApp took: a `pending` row is still in flight (and may yet fail). Its time is
  // when it was TAKEN (the row's `updated`, written as it turns `accepted`: lib/wa-send.mjs, or the
  // poller matching WhatsApp's copy; an accepted row is never written again), not when it began.
  const firstAnswerSince = (leadId, since) => prep(`SELECT MIN(updated) AS t FROM wa_outbox
      WHERE lead_id = ? AND sender_kind = 'dana' AND status = 'accepted' AND created >= ?`).get(String(leadId), Math.trunc(since))?.t ?? null;
  const firstClientMessage = (leadId, since) => prep(`SELECT text, media_type, ts FROM wa_messages
      WHERE lead_id = ? AND direction = 'in' AND ts >= ? ORDER BY ts ASC, rowid ASC LIMIT 1`).get(String(leadId), Math.trunc(since)) ?? null;
  const lastClientMessage = (leadId, upTo) => (Number.isFinite(upTo)
    ? prep(`SELECT text, media_type, ts FROM wa_messages WHERE lead_id = ? AND direction = 'in' AND ts <= ? ORDER BY ts DESC, rowid DESC LIMIT 1`).get(String(leadId), Math.trunc(upTo))
    : prep(`SELECT text, media_type, ts FROM wa_messages WHERE lead_id = ? AND direction = 'in' ORDER BY ts DESC, rowid DESC LIMIT 1`).get(String(leadId))) ?? null;
  const quote = (m) => {
    const text = oneLine(m?.text, QUOTE_CHARS);
    return text ? `"${text}"` : (oneLine(m?.media_type, 20) || '[message]');
  };

  /** A retry after a definite failure: due exactly at its stored time (DESIGN §7.1, 2 min after). */
  const isRetry = (r) => Number(r.meta.tries) >= 1;
  /**
   * When a queued row is due, and whether it still waits for an answer: a WhatsApp client's note
   * comes forward to the assistant's first answer + 20 s (never a retry's).
   */
  function timing(r) {
    if (r.kind === 'new_client' && r.lead_id && ANSWERED_WHYS.has(r.meta.why) && !isRetry(r)) {
      const answered = firstAnswerSince(r.lead_id, Number.isFinite(r.meta.ts) ? r.meta.ts : r.created);
      if (Number.isFinite(answered)) return { due: Math.min(r.due_ts, answered + ANSWER_GRACE_MS), waiting: false };
      return { due: r.due_ts, waiting: true };
    }
    return { due: r.due_ts, waiting: false };
  }
  const effectiveDue = (r) => timing(r).due;
  const isBrainAlert = (r) => r.kind === 'alert' && r.meta.alert === 'brain_out';
  const isBrainHandover = (r) => r.kind === 'handover' && r.meta.kind === 'brain';

  /*
   * THE INVARIANT (T11): a brain hand-over is never a note of its own. It is a chat its hour's
   * outage alert lists, so it is never a send candidate and never drawn with the hand-over header
   * (render), and it comes to whatever that alert comes to: once the alert settles (sent, merged,
   * uncertain, failed, dropped, or held over the day's 40), every chat still queued for its hour
   * settles with it (settleBrainGroup: the same status, a sent alert's chats `merged`, the same
   * send, `into` the alert), however many attempts each chat itself was in. A queued one with no
   * queued alert for its hour, which no path leaves, is taken in by the next open hour's alert, or
   * dropped (adoptStrays).
   */
  /** The chats still queued for an outage alert's hour. */
  const brainGroup = (a) => prep("SELECT * FROM owner_notes WHERE status = 'queued' AND kind = 'handover'").all().map(rowOf)
    .filter((h) => isBrainHandover(h) && h.meta.alertHour === a.meta.hour);
  /** Inside the caller's transaction: the chats still queued for outage alert `a` come to its final `status`. */
  function settleBrainGroup(a, status, sid, t, extra = {}) {
    if (status === 'queued') return;
    const st = status === 'sent' ? 'merged' : status;
    for (const h of brainGroup(a)) {
      prep("UPDATE owner_notes SET status = ?, send_id = ?, meta = ?, updated = ? WHERE note_id = ? AND status = 'queued'")
        .run(st, sid, JSON.stringify({ ...h.meta, ...extra, into: a.note_id }), t, h.note_id);
    }
  }

  function lastSendTs() {
    const fromLedger = prep("SELECT MAX(updated) AS t FROM owner_notes WHERE send_id IS NOT NULL OR status = 'uncertain'").get()?.t ?? 0;
    return Math.max(lastAttemptAt, Number(fromLedger) || 0);
  }
  const sendsToday = (t) => prep('SELECT COUNT(DISTINCT send_id) AS n FROM owner_notes WHERE send_id IS NOT NULL AND updated >= ?')
    .get(dayStart(dayKey(t, off), off))?.n ?? 0;
  /** Today's 08:00 summary has been tried (or settled): no slot is kept for it any more. */
  const daySummaryDone = (t) => Boolean(prep("SELECT 1 FROM owner_notes WHERE dedupe_key = ? AND status <> 'queued'").get(`sum:${dayKey(t, off)}`));
  const isDaySummary = (r) => r.kind === 'summary' && !r.meta.test;

  /* ---------------- rendering (at send time) ---------------- */

  function notAnsweredWhy(lead) {
    if (Number(lead.dana_off) === 1) return 'the client asked it to stop';
    if (lead.dana_hold_reason) return `on hold (${oneLine(lead.dana_hold_reason, 24)})`;
    if (Number(lead.needs_human) === 1) return 'handed to you';
    return 'not yet';
  }

  function renderNewClient(r) {
    const lead = leadOf(r.lead_id);
    if (!lead) return null;
    const tail = [];
    if (auto(lead)) {
      const wants = [lead.interest, lead.district, lead.budget, String(lead.listing_id ?? '').replace(/^BONA-/i, '')].map((v) => oneLine(v, 40)).filter(Boolean);
      tail.push(`Wants: ${wants.length ? wants.join(' · ') : 'not said yet'}`);
      const since = Number.isFinite(r.meta.ts) ? r.meta.ts : r.created;
      const first = firstClientMessage(lead.lead_id, ANSWERED_WHYS.has(r.meta.why) ? since : 0);
      if (first) tail.push(`First message: ${quote(first)}`);
      if (ANSWERED_WHYS.has(r.meta.why)) {
        const from = Number.isFinite(first?.ts) ? first.ts : since;
        const answered = firstAnswerSince(lead.lead_id, from);
        tail.push(Number.isFinite(answered) ? `AI: answered in ${formatDuration(answered - from)}` : `AI: not answered: ${notAnsweredWhy(lead)}`);
      }
    }
    tail.push(leadLine(lead.lead_id));
    return { text: fit(leadNote(lead, { siteUrl }), tail.join('\n')) };
  }

  function renderHandover(r) {
    const lead = leadOf(r.lead_id);
    if (!lead || !auto(lead)) return null;
    const words = HANDOVER_REASONS[r.meta.reason] ?? HANDOVER_REASONS[r.meta.kind] ?? HANDOVER_REASONS.other;
    const lines = [HEADERS.handover, who(lead), `Reason: ${words}`];
    const last = lastClientMessage(lead.lead_id, Number.isFinite(r.meta.covers) ? r.meta.covers : null);
    if (last) lines.push(`Last message: ${quote(last)}`);
    lines.push('The AI keeps answering simple questions until someone writes.', leadLine(lead.lead_id));
    return { text: clipUnits(lines.join('\n'), MAX_NOTE_CHARS) };
  }

  function renderBooking(r) {
    const b = prep('SELECT * FROM viewing_bookings WHERE booking_id = ?').get(String(r.meta.booking ?? ''));
    if (!b) return null;
    const lead = leadOf(b.lead_id);
    if (!lead || !auto(lead)) return null;
    let listing = null;
    try { listing = inventory?.find?.(b.listing_id) ?? null; } catch { listing = null; }
    const title = oneLine(listing?.title?.en || listing?.title?.ar, 80);
    const phone = /^[1-9]\d{7,14}$/.test(String(lead.phone_e164 ?? '')) ? `+${lead.phone_e164}` : null;
    const lines = [
      HEADERS.booking,
      `${dayLabel(dayKey(b.start_ts, off))} ${clockLabel(b.start_ts, off)}-${clockLabel(b.end_ts, off)}`,
      title ? `${b.listing_id} · ${title}` : String(b.listing_id),
      [oneLine(lead.name, 60) || 'a client', phone].filter(Boolean).join(' · '),
    ];
    const told = Boolean(r.meta.told);
    // Untold: the confirmation (and its map link) did not reach the client, so nothing says it was sent.
    if (listing) {
      lines.push(listing.mapPrecision !== 'exact' ? 'Meeting point: NEEDED (district only)'
        : told ? 'Meeting point: map link sent' : 'Meeting point: exact pin, map link NOT sent');
    }
    if (!told) lines.push('Booked, but the client was NOT told; please write to them.');
    lines.push(leadLine(lead.lead_id));
    return { text: clipUnits(lines.join('\n'), MAX_NOTE_CHARS) };
  }

  function renderStopped(r) {
    const lead = leadOf(r.lead_id);
    if (!lead || !auto(lead)) return null;
    return { text: [HEADERS.stopped, who(lead), `Reason: ${STOP_REASONS[r.meta.reason] ?? STOP_REASONS.stop}`, leadLine(lead.lead_id)].join('\n') };
  }

  function alertSentence(code, meta) {
    const level = meta.level === '100' ? '100' : '80';
    const errCode = ERROR_CODES.has(meta.code) ? ` (code: ${meta.code})` : '';
    switch (code) {
      case 'breaker': return 'The AI assistant stopped answering on WhatsApp: 3 of its messages failed within 30 minutes. Switch it back on from the Team page once WhatsApp works again.';
      case 'greeting_away': return 'WhatsApp Business has a greeting or away message switched on. Switch it off in the WhatsApp Business app, or clients get two replies.';
      case 'turns_month': return `The AI assistant passed ${level}% of this month's answer alert level. The Team page has the numbers.`;
      case 'gcal': return `The calendar is not answering${errCode}. Viewings are handed to you until it works again.`;
      case 'mail': return `The mailbox is not answering${errCode}. Emails wait until it works again.`;
      case 'brain_out': return BRAIN_OUT[meta.code] ?? BRAIN_OUT.down;
      case 'brain_spend': return meta.level === 'stop'
        ? 'The AI spend stop was reached: clients get a holding line until the day or the month rolls over. Check the Team page for a fault or abuse.'
        : `AI spend this month passed ${level}% of the check-in level. This OpenAI balance also pays Lisa's voice, the Bona phone line and TK's AI fallback; check it.`;
      case 'brain_bug': return 'The AI gave 3 or more unusable answers in the last hour; the backup model took over. Worth a look on the Team page.';
      case 'old_out_wrote': return 'A chat you marked Not a client before the move wrote to Bona; the AI does not answer it.';
      default: return null;
    }
  }

  /**
   * An outage alert's chats: its hour's queued brain hand-overs, `folded` (listed, and settled
   * with the alert, whether it goes or is held over the day's 40) with their leads, or `drop`
   * (purged, or out of auto mode: never listed or counted).
   */
  function brainChats(r, queued) {
    const folded = [];
    const leads = [];
    const drop = [];
    for (const h of queued) {
      if (!isBrainHandover(h) || h.meta.alertHour !== r.meta.hour) continue;
      const lead = leadOf(h.lead_id);
      if (!lead || !auto(lead)) { drop.push(h); continue; }
      folded.push(h);
      leads.push(lead);
    }
    return { folded, leads, drop };
  }

  function renderAlert(r, queued) {
    // An outage alert says the outage's latest cause as it goes (a later alert() may have brought
    // a new one, even as a duplicate), and its row keeps the code it went with (`meta`, below).
    const brainOut = r.meta.alert === 'brain_out';
    const meta = brainOut ? { ...r.meta, code: latestBrainCause() ?? brainCode(r.meta.code) } : r.meta;
    const sentence = alertSentence(r.meta.alert, meta);
    if (!sentence) return null;
    const lines = [HEADERS.alert, sentence];
    let folded = [];
    let drop = [];
    if (r.meta.alert === 'brain_out') {
      const got = brainChats(r, queued);
      ({ folded, drop } = got);
      const chats = got.leads.map(who);
      if (chats.length) {
        lines.push(`Chats waiting: ${chats.length} → ${link('/dashboard/inbox?filter=needs_human')}`);
        const more = chats.length - MAX_LISTED_CHATS;
        lines.push(`${chats.slice(0, MAX_LISTED_CHATS).join(' · ')}${more > 0 ? ` · and ${more} more` : ''}`);
      } else if (!r.meta.asked) {
        // Opened by a hand-over only, and its chats are gone (purged, out of auto mode): nothing to
        // say, so it is dropped, never sent empty (a later chat this hour queues it again).
        return { none: true, drop };
      }
    }
    if (r.meta.alert === 'old_out_wrote') lines.push(`Chats to check: ${link('/dashboard/inbox?tab=unsure')}`);
    return { text: clipUnits(lines.join('\n'), MAX_NOTE_CHARS), folded, drop, ...(brainOut ? { meta } : {}) };
  }

  function renderMail(r) {
    const what = MAIL_WHAT[r.meta.what] ?? MAIL_WHAT.possible_client;
    let seen = null;
    // mail_seen is db v9 (PR-C2): until then there is no sender or subject to show.
    try { seen = db.db.prepare('SELECT from_addr, subject_short FROM mail_seen WHERE message_id = ?').get(String(r.meta.mid ?? '')) ?? null; } catch { seen = null; }
    const lines = [HEADERS.mail];
    if (oneLine(seen?.from_addr)) lines.push(`From: ${oneLine(seen.from_addr, 120)}`);
    if (oneLine(seen?.subject_short)) lines.push(`Subject: ${oneLine(seen.subject_short, SUBJECT_CHARS)}`);
    lines.push(what, `Email: ${link('/dashboard/email')}`);
    return { text: clipUnits(lines.join('\n'), MAX_NOTE_CHARS) };
  }

  function renderCommand(r) {
    const text = texts.get(r.note_id);
    if (typeof text !== 'string' || !text.trim()) return null;
    return { text: clipUnits(text.trimStart().startsWith('*Bona — ') ? text : `${HEADERS.command}\n${text}`, MAX_NOTE_CHARS) };
  }

  function renderSummaryRow(r, t) {
    if (!summaryOn(team)) return null;
    return { text: clipUnits(renderSummary(summaryDeps, r.meta, t), MAX_NOTE_CHARS) };
  }

  function render(r, t, queued) {
    switch (r.kind) {
      case 'new_client': return renderNewClient(r);
      // A brain hand-over has no note of its own (the invariant): it is only ever a line of its alert.
      case 'handover': return isBrainHandover(r) ? null : renderHandover(r);
      case 'booking': return renderBooking(r);
      case 'stopped': return renderStopped(r);
      case 'alert': return renderAlert(r, queued);
      case 'mail': return renderMail(r);
      case 'command': return renderCommand(r);
      case 'summary': return renderSummaryRow(r, t);
      default: return null;
    }
  }

  /* ---------------- sending ---------------- */

  function classify(res) {
    if (res?.ok === true) return 'sent';
    const e = String(res?.error ?? '');
    if (Object.hasOwn(HOLD_MS, e)) return 'held';
    if (res?.uncertain === true || UNCERTAIN_ERRORS.has(e) || /^http_5\d\d$/.test(e)) return 'uncertain';
    return 'failed';
  }
  const RECEIPT = { sent: 'sent', held: 'pending', uncertain: 'uncertain', failed: 'uncertain', dropped: 'dropped' };

  /**
   * Rows that will not be sent: dropped (no longer sendable; receipt `dropped`) or held over the
   * day's limit for the summary (`merged` + `over`; receipt `over`).
   */
  function settle(rows, status, t, extra = {}, receipt = 'dropped') {
    if (!rows.length) return;
    db.transaction(() => {
      for (const r of rows) {
        prep('UPDATE owner_notes SET status = ?, meta = ?, updated = ? WHERE note_id = ? AND status = ?')
          .run(status, JSON.stringify({ ...r.meta, ...extra }), t, r.note_id, 'queued');
        if (r.kind === 'new_client' && r.meta.ev) setReceipt(r.meta.ev, receipt);
        texts.delete(r.note_id);
      }
      // An outage alert dropped or held over takes the chats still queued for its hour with it.
      for (const r of rows) if (isBrainAlert(r)) settleBrainGroup(r, status, null, t, extra);
    });
  }

  function dropQueued(t) {
    const rows = prep("SELECT * FROM owner_notes WHERE status = 'queued'").all().map(rowOf);
    settle(rows, 'dropped', t);
  }

  async function sendBatch(parts, t) {
    const carrier = parts[0].row;
    const members = parts.flatMap((p) => [p.row, ...p.folded]);
    const text = parts.map((p) => p.text).join('\n\n');
    // The send's id is written with the `uncertain` mark, BEFORE the call: a process that dies
    // after WhatsApp took the message still leaves this send counted in the day's 40.
    const provisional = `NB-${t.toString(36)}-${randomId(6)}`;
    db.transaction(() => {
      for (const m of members) {
        prep("UPDATE owner_notes SET status = 'uncertain', send_id = ?, updated = ? WHERE note_id = ? AND status = 'queued'").run(provisional, t, m.note_id);
      }
    });
    for (const m of members) inflight.add(m.note_id);
    let res;
    let thrown = null;
    let limit = null;
    try {
      res = await Promise.race([
        Promise.resolve().then(() => sendNote(text)),
        new Promise((resolve) => {
          limit = setTimeout(() => resolve({ ok: false, error: 'timeout', uncertain: true }), SEND_TIMEOUT_MS);
          limit.unref?.();
        }),
      ]);
    } catch (err) {
      thrown = err;
      res = { ok: false, error: 'threw', uncertain: true };
    } finally {
      clearTimeout(limit);
      for (const m of members) inflight.delete(m.note_id);
    }
    const outcome = classify(res);
    const t2 = now();
    if (outcome !== 'held') lastAttemptAt = Math.max(lastAttemptAt, t2);
    const sendId = typeof res?.sendId === 'string' && res.sendId ? res.sendId : provisional;
    const forms = [];
    // A chat an outage alert lists comes to what the alert comes to (the invariant above), whatever
    // its own attempts: its row follows the alert's, which is decided first (members: alert, chats).
    const groupOf = new Map();
    for (const p of parts) for (const f of p.folded) groupOf.set(f.note_id, p.row.note_id);
    const decided = new Map();
    db.transaction(() => {
      for (const m of members) {
        // Purged while the send was out (onPurge): `m` is the copy from before the purge, so it
        // must not be written back. The record only settles: its send stays counted, nothing of
        // the lead or its form returns, no receipt is written, and it never goes again.
        if (purgedNote(m.note_id)) {
          let status = 'dropped';
          if (outcome === 'sent') status = m.note_id === carrier.note_id ? 'sent' : 'merged';
          else if (outcome === 'uncertain') status = 'uncertain';
          else if (outcome === 'failed' && Number(m.meta.tries) >= 1) status = 'failed';
          prep("UPDATE owner_notes SET status = ?, send_id = ?, updated = ? WHERE note_id = ? AND substr(dedupe_key, 1, 7) = 'purged:'")
            .run(status, sendId, t2, m.note_id);
          texts.delete(m.note_id);
          continue;
        }
        const meta = { ...m.meta };
        let status;
        let sid = null;
        let due = m.due_ts;
        let receipt = RECEIPT[outcome];
        const group = decided.get(groupOf.get(m.note_id));
        if (group) {
          status = group.status === 'sent' ? 'merged' : group.status;
          sid = group.sid;
          due = group.due;
          if (group.tries === undefined) delete meta.tries; else meta.tries = group.tries;
          if (status !== 'queued') meta.into = group.id;
        } else if (outcome === 'sent') {
          status = m.note_id === carrier.note_id ? 'sent' : 'merged';
          if (status === 'merged') meta.into = carrier.note_id;
          sid = sendId;
        } else if (outcome === 'uncertain') {
          status = 'uncertain';
          sid = sendId;
        } else if (outcome === 'held') {
          status = 'queued';
        } else {
          meta.tries = (Number(meta.tries) || 0) + 1;
          if (meta.tries > 1) { status = 'failed'; sid = sendId; } else { status = 'queued'; due = t2 + RETRY_AFTER_MS; }
        }
        if (status === 'queued') receipt = outcome === 'held' ? 'pending' : 'uncertain';
        prep('UPDATE owner_notes SET status = ?, send_id = ?, due_ts = ?, meta = ?, updated = ? WHERE note_id = ?')
          .run(status, sid, due, JSON.stringify(meta), t2, m.note_id);
        if (status !== 'queued') texts.delete(m.note_id);
        if (m.kind === 'new_client' && meta.ev) { setReceipt(meta.ev, receipt); forms.push(m); }
        if (isBrainAlert(m)) {
          decided.set(m.note_id, { id: m.note_id, status, sid, due, tries: meta.tries });
          // Any chat of its hour still queued that this send did not carry settles with it too.
          settleBrainGroup(m, status, sid, t2);
        }
      }
    });
    const kinds = [...new Set(members.map((m) => m.kind))];
    if (outcome === 'sent') say({ evt: 'notes.sent', kinds, n: members.length });
    else say({ level: 'warn', evt: `notes.${outcome}`, kinds, n: members.length, error: String(res?.error ?? 'unknown').slice(0, 40) });
    // The form path's own lines, as before (index.mjs at 13e4954): ids and error codes only.
    if (outcome !== 'sent') {
      for (const m of forms) {
        if (thrown) say({ evt: 'lead.wa_error', id: m.lead_id, error: errMessage(thrown) });
        else say({ evt: outcome === 'held' ? 'lead.wa_held' : 'lead.wa_failed', id: m.lead_id, error: String(res?.error ?? 'unknown').slice(0, 40) });
      }
    }
    if (outcome === 'held') hold = { until: t2 + HOLD_MS[res.error], reason: res.error };
  }

  /**
   * The guard behind the invariant: a queued brain hand-over whose hour has no queued outage alert
   * (no path leaves one; an older build or a fault might) is never sent on its own. It is listed in
   * the first open hour's alert from its own hour or this one, whichever is later (openBrainHour,
   * as handover() does: owner notes are on here, step() dropped everything otherwise), or dropped
   * when none is left to open. Logged as an error, by count only. True when it changed a row.
   */
  function adoptStrays(queued, t) {
    const open = new Set(queued.filter(isBrainAlert).map((r) => r.meta.hour));
    const strays = queued.filter((r) => isBrainHandover(r) && !open.has(r.meta.alertHour));
    if (!strays.length) return false;
    const hour = Math.floor(t / HOUR_MS);
    let dropped = 0;
    for (const h of strays) {
      const own = Number(h.meta.alertHour);
      const { alertHour, row } = openBrainHour(Number.isSafeInteger(own) ? Math.max(own, hour) : hour);
      const due = alertHour <= hour ? t : alertHour * HOUR_MS;
      openBrainAlert(alertHour, due, latestBrainCause() ?? row?.meta.code);
      if (byKey(`al:brain_out:${alertHour}`)?.status === 'queued') {
        prep("UPDATE owner_notes SET due_ts = ?, meta = ?, updated = ? WHERE note_id = ? AND status = 'queued'")
          .run(Math.trunc(due), JSON.stringify({ ...h.meta, alertHour }), t, h.note_id);
      } else {
        settle([h], 'dropped', t);
        dropped += 1;
      }
    }
    say({ level: 'error', evt: 'notes.brain_orphan', n: strays.length, dropped });
    return true;
  }

  /** One pass: drop what is off, send at most one message, then stop (the next pass is 25 s away at best). */
  async function step() {
    const t = now();
    if (!notesOn()) { dropQueued(t); return; }
    if (hold) {
      if (t < hold.until && !(hold.reason === 'sending_disabled' && sendingOn())) return;
      hold = null;
    }
    const readQueued = () => prep("SELECT * FROM owner_notes WHERE status = 'queued' ORDER BY due_ts, created, rowid").all().map(rowOf);
    let queued = readQueued();
    if (!queued.length) return;
    if (adoptStrays(queued, t)) queued = readQueued();
    // A brain hand-over is never a candidate: it goes only in its hour's brain_out alert, which lists it.
    const candidates = queued
      .filter((r) => !isBrainHandover(r))
      .map((r) => {
        try { return { row: r, due: effectiveDue(r) }; } catch { return { row: r, due: r.due_ts }; }
      })
      .sort((a, b) => a.due - b.due || a.row.created - b.row.created);
    if (!candidates.some((c) => c.due <= t)) return;
    const last = lastSendTs();
    if (t - last < MIN_GAP_MS) return;
    // At most 40 sends a day, every kind counted (DESIGN §7.1; PLAN T11 test 2). The overflow is
    // held for the summary, so while summaries are on and today's has not gone yet, one of the 40
    // is kept for it (DESIGN §7.3, exactly one a day): the others get 39 until it went.
    const sends = sendsToday(t);
    const kept = summaryOn(team) && !daySummaryDone(t) ? 1 : 0;
    const room = (r) => sends < MAX_PER_DAY - (isDaySummary(r) ? 0 : kept);
    const parts = [];
    const dropped = [];
    const over = [];
    let size = 0;
    for (const c of candidates) {
      if (c.due > t + MERGE_WINDOW_MS) break;
      // A retry goes when it is due, never earlier along with another send.
      if (isRetry(c.row) && c.due > t) continue;
      // An outage alert is its hour's one note: never before its hour along with another send,
      // or a chat handed over later in the hour would find it gone and go alone.
      if (isBrainAlert(c.row) && c.due > t) continue;
      if (!room(c.row)) {
        if (c.due > t) continue;
        if (isBrainAlert(c.row)) {
          // Its chats wait for it (never a hand-over of their own), so they share its outcome: held
          // over with it, none can go alone once a new day's 40 begins. One with no chat left that
          // alert() did not ask for would not go at all: dropped, as at its send (renderAlert).
          const { folded, drop } = brainChats(c.row, queued);
          dropped.push(...drop);
          if (!folded.length && !c.row.meta.asked) dropped.push(c.row);
          else over.push(c.row, ...folded.map((h) => ({ ...h, meta: { ...h.meta, into: c.row.note_id } })));
        } else {
          over.push(c.row);
        }
        continue;
      }
      // A summary is a message of its own: it goes first and alone, or waits for the next pass.
      if (c.row.kind === 'summary' && (parts.length || c.due > t)) continue;
      let out = null;
      try {
        out = render(c.row, t, queued);
      } catch (err) {
        // One note that cannot be drawn must not hold back every note behind it.
        say({ level: 'error', evt: 'notes.render_failed', kind: c.row.kind, error: errName(err) });
      }
      if (!out || out.none) { dropped.push(c.row, ...(out?.drop ?? [])); continue; }
      dropped.push(...(out.drop ?? []));
      const extra = (parts.length ? 2 : 0) + out.text.length;
      if (parts.length && size + extra > MAX_NOTE_CHARS) break;
      // A rendered meta (an outage alert's cause) is what sendBatch writes back with the outcome.
      parts.push({ row: out.meta ? { ...c.row, meta: out.meta } : c.row, due: c.due, text: out.text, folded: out.folded ?? [] });
      size += extra;
      if (c.row.kind === 'summary') break;
    }
    settle(dropped, 'dropped', t);
    const sending = parts.some((p) => p.due <= t);
    // While Sending is off nothing goes, so nothing goes over the day's 40 either: a note over the
    // limit stays queued (a form's receipt `pending`) and the day it goes in decides once Sending is
    // back on (DESIGN §7.1; T11 test 3). With nothing else to send it is held as the transport holds
    // one (30 s, or at once when Sending is back on); otherwise the transport's answer holds.
    if (over.length && sendingOff()) {
      if (!sending) {
        hold = { until: t + HOLD_MS.sending_disabled, reason: 'sending_disabled' };
        say({ level: 'warn', evt: 'notes.held', kinds: [...new Set(over.map((r) => r.kind))], n: over.length, error: 'sending_disabled' });
        return;
      }
    } else {
      settle(over, 'merged', t, { over: dayKey(t, off) }, 'over');
    }
    if (!sending) return;
    await sendBatch(parts, t);
  }

  /** Send what is due. One run at a time: a call while one runs makes it look once more. Never rejects. */
  function tick() {
    if (!db || !sendNote || halted) return Promise.resolve();
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        do {
          again = false;
          await step();
        } while (again && !halted);
      } catch (err) {
        say({ level: 'error', evt: 'notes.tick_failed', error: errName(err) });
      } finally {
        // Re-armed whatever the pass did, so a throw never leaves the notes behind it asleep.
        try { armNext(); } catch (err) { say({ level: 'error', evt: 'notes.arm_failed', error: errName(err) }); }
        running = null;
      }
    })();
    return running;
  }

  /* ---------------- the kinds ---------------- */

  async function leadEvent(lead, { why, created = false, eventId = null, ts = null } = {}) {
    if (!lead || !db || !sendNote) return;
    const id = String(lead.lead_id ?? '');
    if (!ID_RE.test(id)) return;
    const form = why === 'form';
    const ev = typeof eventId === 'string' && eventId && eventId.length <= 128 ? eventId : null;
    // A merge is not a new client (DESIGN §7.2, critic C11); an own-number join always is (G13).
    if (!(created === true || why === 'joined')) {
      if (form) setReceipt(ev, 'skipped');
      return;
    }
    const t = now();
    const first = Number.isFinite(Number(ts)) && ts !== null ? Math.trunc(Number(ts)) : t;
    const quick = QUICK_WHYS.has(why);
    const meta = { why: WHYS.has(why) ? why : 'wa' };
    if (!quick) meta.ts = first;
    if (form && ev) meta.ev = ev;
    const r = enqueue({ kind: 'new_client', leadId: id, key: `new:${id}`, due: quick ? t : first + FIRST_MESSAGE_WAIT_MS, meta });
    if (!form) return;
    if (r.status === 'dropped') { setReceipt(ev, 'dropped'); return; }
    if (!r.inserted) { setReceipt(ev, 'skipped'); return; }
    // The request waits for the first attempt, at most formWaitMs (as before).
    let wait = null;
    const timedOut = await Promise.race([
      tick().then(() => false, () => false),
      new Promise((resolve) => { wait = setTimeout(() => resolve(true), formWaitMs); wait.unref?.(); }),
    ]).finally(() => clearTimeout(wait));
    if (timedOut && inflight.has(r.noteId) && !purgedNote(r.noteId)) {
      setReceipt(ev, 'uncertain');
      say({ evt: 'lead.wa_error', id, error: 'owner notification unconfirmed' });
    }
  }

  function handover(lead, { kind = 'other', coversTs = null, reason = null } = {}) {
    if (!db) return { queued: false, reason: 'no_ledger' };
    const l = leadOf(lead);
    if (!l) return { queued: false, reason: 'no_lead' };
    if (!auto(l)) return { queued: false, reason: 'not_auto' };
    const k = typeof kind === 'string' && Object.hasOwn(HANDOVER_REASONS, kind) ? kind : 'other';
    const meta = { kind: k };
    if (typeof reason === 'string' && Object.hasOwn(HANDOVER_REASONS, reason)) meta.reason = reason;
    if (coversTs !== null && Number.isFinite(Number(coversTs))) meta.covers = Math.trunc(Number(coversTs));
    const t = now();
    if (k === 'brain') {
      // One note an hour for an outage: the chat is listed in the first hour's brain_out alert,
      // from this one on, that has not gone (openBrainHour), so it is never a hand-over of its
      // own. A later hour's alert never goes before its hour (step); its sentence is the
      // outage's latest cause when it goes (renderAlert), however many hours on.
      // Owner notes off: only the hand-over, dropped; no hour's alert is opened or stepped past.
      // The chat's dedupe key is checked first: a chat already handed over this hour (listed, or
      // waiting to be) opens no alert; only a new row, or one dropped while owner notes were off
      // (never sent, queued again now that they are on), opens or queues its hour's alert.
      const hour = Math.floor(t / HOUR_MS);
      const key = `ho:${l.lead_id}:brain:${hour}`;
      if (!notesOn()) return answer(enqueue({ kind: 'handover', leadId: l.lead_id, key, due: t, meta: { ...meta, alertHour: hour } }));
      const seen = byKey(key);
      if (seen && !(seen.status === 'dropped' && seen.send_id === null)) return { queued: false, reason: 'duplicate' };
      const { alertHour, row } = openBrainHour(hour);
      const due = alertHour === hour ? t : alertHour * HOUR_MS;
      const hoMeta = { ...meta, alertHour };
      if (seen) {
        const up = prep("UPDATE owner_notes SET status = 'queued', due_ts = ?, meta = ?, updated = ? WHERE note_id = ? AND status = 'dropped' AND send_id IS NULL")
          .run(Math.trunc(due), JSON.stringify(hoMeta), t, seen.note_id);
        if (up.changes !== 1) return { queued: false, reason: 'duplicate' };
      } else {
        const r = enqueue({ kind: 'handover', leadId: l.lead_id, key, due, meta: hoMeta });
        if (!(r.inserted && r.status === 'queued')) return answer(r);
      }
      openBrainAlert(alertHour, due, latestBrainCause() ?? row?.meta.code);
      armNext(0);
      return { queued: true };
    }
    return answer(enqueue({ kind: 'handover', leadId: l.lead_id, key: `ho:${l.lead_id}:${k}:${Math.floor(t / HANDOVER_BUCKET_MS)}`, due: t, meta }));
  }

  function booking(bookingId, { told = false } = {}) {
    if (!db) return { queued: false, reason: 'no_ledger' };
    const id = String(bookingId ?? '');
    if (!ID_RE.test(id)) return { queued: false, reason: 'no_booking' };
    const b = prep('SELECT booking_id, lead_id FROM viewing_bookings WHERE booking_id = ?').get(id);
    if (!b) return { queued: false, reason: 'no_booking' };
    const l = leadOf(b.lead_id);
    if (!l || !auto(l)) return { queued: false, reason: 'not_auto' };
    const yes = told === true;
    return answer(enqueue({ kind: 'booking', leadId: l.lead_id, key: `${yes ? 'bk' : 'bk-untold'}:${id}`, due: now(), meta: { booking: id, told: yes ? 1 : 0 } }));
  }

  function stopped(lead, reason = 'stop') {
    if (!db) return { queued: false, reason: 'no_ledger' };
    const l = leadOf(lead);
    if (!l) return { queued: false, reason: 'no_lead' };
    if (!auto(l)) return { queued: false, reason: 'not_auto' };
    const t = now();
    const r = typeof reason === 'string' && Object.hasOwn(STOP_REASONS, reason) ? reason : 'stop';
    return answer(enqueue({ kind: 'stopped', leadId: l.lead_id, key: `stop:${l.lead_id}:${t}`, due: t, meta: { reason: r } }));
  }

  function alert(code, meta = {}) {
    if (!db) return { queued: false, reason: 'no_ledger' };
    const c = String(code ?? '');
    if (PUSH_ONLY_ALERTS.has(c)) return { queued: false, reason: 'push_only' };
    if (!ALERT_CODES.includes(c)) {
      say({ level: 'warn', evt: 'notes.alert_unknown' });
      return { queued: false, reason: 'unknown_code' };
    }
    const m = meta && typeof meta === 'object' ? meta : {};
    const t = now();
    if (c === 'old_out_wrote') {
      const leadId = typeof m.leadId === 'string' && ID_RE.test(m.leadId) ? m.leadId : null;
      const candId = !leadId && typeof m.candId === 'string' && ID_RE.test(m.candId) ? m.candId : null;
      if (!leadId && !candId) return { queued: false, reason: 'bad_meta' };
      return answer(enqueue({
        kind: 'alert', leadId, key: `al:old_out_wrote:${leadId ?? candId}:${dayKey(t, off)}`, due: t,
        meta: { alert: c, ...(candId ? { candId } : {}) },
      }));
    }
    const hour = Math.floor(t / HOUR_MS);
    if (c === 'brain_out') {
      const why = brainCode(m.code);
      // The outage's latest cause, whatever this call returns: the next alert to go says it.
      recordBrainCause(why);
      if (!notesOn()) return answer(enqueue({ kind: 'alert', key: `al:brain_out:${hour}`, due: t, meta: { alert: c, code: why, hour } }));
      // This hour's note: new, or queued again when it was dropped while owner notes were off.
      // Otherwise (queued already, or gone, with the next hour's opened by a hand-over or not
      // yet) a duplicate: the recorded cause is what a note not gone yet will say.
      const { alertHour } = openBrainHour(hour);
      if (alertHour === hour && openBrainAlert(hour, t, why, true)) return { queued: true };
      return { queued: false, reason: 'duplicate' };
    }
    const out = { alert: c };
    if (c === 'gcal' || c === 'mail') { if (ERROR_CODES.has(m.code)) out.code = m.code; }
    let level = '';
    if (c === 'brain_spend') { out.level = ['80', '100', 'stop'].includes(String(m.level)) ? String(m.level) : '80'; level = `:${out.level}`; }
    if (c === 'turns_month') { out.level = String(m.level) === '100' ? '100' : '80'; level = `:${out.level}`; }
    return answer(enqueue({ kind: 'alert', key: `al:${c}${level}:${hour}`, due: t, meta: out }));
  }

  function mailNote(item = {}) {
    if (!db) return { queued: false, reason: 'no_ledger' };
    const mid = String(item?.messageId ?? '');
    if (!ID_RE.test(mid)) return { queued: false, reason: 'bad_item' };
    const what = Object.hasOwn(MAIL_WHAT, item?.what) ? item.what : 'possible_client';
    return answer(enqueue({ kind: 'mail', key: `mail:${mid}`, due: now(), meta: { what, mid } }));
  }

  function command(recId, text) {
    if (!db) return { queued: false, reason: 'no_ledger' };
    const id = String(recId ?? '');
    if (!ID_RE.test(id) || typeof text !== 'string' || !text.trim()) return { queued: false, reason: 'bad_command' };
    const r = enqueue({ kind: 'command', key: `cmd:${id}`, due: now(), meta: {} });
    if (r.inserted && r.status === 'queued') texts.set(r.noteId, text);
    return answer(r);
  }

  function summary({ day = null, days = 1, test = false, ts = null } = {}) {
    if (!db) return { queued: false, reason: 'no_ledger' };
    if (!summaryOn(team)) return { queued: false, reason: 'off' };
    const t = now();
    if (test) {
      const at = ts !== null && Number.isFinite(Number(ts)) ? Math.trunc(Number(ts)) : t;
      return answer(enqueue({ kind: 'summary', key: `sumtest:${at}`, due: t, meta: { test: 1, ts: at } }));
    }
    if (!DAY_RE.test(String(day ?? ''))) return { queued: false, reason: 'bad_day' };
    const span = Math.max(1, Math.min(7, Math.trunc(Number(days)) || 1));
    return answer(enqueue({ kind: 'summary', key: `sum:${day}`, due: t, meta: { day, days: span } }));
  }

  /**
   * Inside purgeLead's transaction (store.mjs `onPurge`): the lead's rows go; nothing else, no
   * network. A row that carries one of TODAY's sends stays as a record with nothing of the lead
   * (no lead id, a dedupe key of its own note id, no meta), as purgeLead keeps the day's outbox
   * rows: the day's 40 and the 25 s gap count it still, so a purge never hands a send back. Such
   * records go at the next purge once their day is over. A send still out when the purge lands
   * only settles its record when it answers (sendBatch): never queued again, nothing written back.
   */
  function onPurge(leadId) {
    if (!db) return;
    const id = String(leadId ?? '');
    const today = dayStart(dayKey(now(), off), off);
    prep('DELETE FROM owner_notes WHERE lead_id = ? AND (send_id IS NULL OR updated < ?)').run(id, today);
    prep("UPDATE owner_notes SET lead_id = NULL, dedupe_key = 'purged:' || note_id, meta = '{}' WHERE lead_id = ?").run(id);
    prep("DELETE FROM owner_notes WHERE lead_id IS NULL AND substr(dedupe_key, 1, 7) = 'purged:' AND updated < ?").run(today);
  }

  function stop() {
    halted = true;
    if (timer) { try { clearTimer(timer); } catch { /* gone anyway */ } }
    timer = null;
    timerAt = Infinity;
  }

  function health() {
    const enabled = notesOn();
    if (!db) return { enabled, ok: true };
    try {
      const stuck = prep("SELECT 1 FROM owner_notes WHERE status = 'queued' AND due_ts <= ? LIMIT 1").get(now() - STUCK_MS);
      return { enabled, ok: !stuck };
    } catch {
      return { enabled, ok: false };
    }
  }

  // A note left queued by the last process (a retry, a held one) is picked up without waiting for a new one.
  if (db && setTimer) {
    try { armNext(); } catch { /* no ledger to read: nothing to pick up */ }
  }

  return { leadEvent, handover, booking, stopped, alert, mail: mailNote, command, summary, onPurge, tick, stop, health };
}

/**
 * Today's path, the PR-F2b stub byte for byte (PLAN §0, the INERT rule): what createOwnerNotes
 * gives without `ledger: true`, which is what index.mjs builds until PR-INT (T14) opts in.
 *
 * Today the owner hears about one thing only: a new enquiry, as `leadNote()`'s text, sent
 * straight away. Three places send it, each its own way, and `leadEvent` keeps each one byte
 * for byte, chosen by `why`:
 *
 *   - 'form' (index.mjs, the site's forms): every accepted enquiry, created or merged. The
 *     request waits for the send for up to 4 s; `enquiry_receipts.notify_status` becomes
 *     'sent' on an ok answer and 'uncertain' otherwise (a failure, a throw, or no answer in
 *     time). Logged `lead.wa_failed` / `lead.wa_error`.
 *   - 'concierge' (tools.mjs create_lead): every saved lead, created or merged. Logged
 *     `lead.wa_failed` / `lead.wa_error`.
 *   - anything else, 'wa' (wa-poller.mjs, a WhatsApp lead) and 'joined' (the own-number join,
 *     PR-A1) included: only a lead that was just created. Logged `wa.note.failed` (warn).
 *
 * `sendNote(text)` is the transport, and the only one; its answer `{ ok, error? }` stands:
 * nothing here tries a second way, holds, queues or retries. No Sending or owner_notes switch,
 * no per-minute limit, no length cap and no outbox row, as today. Every other method is a
 * no-op, and there is no `summary` (createDailySummary refuses this object, loudly).
 */
function createTodaysNotes({
  db = null, siteUrl, sendNote = null, log = () => {}, formWaitMs = FORM_NOTIFY_WAIT_MS,
} = {}) {
  const setStatus = (status, eventId) => {
    if (db && eventId) db.db.prepare('UPDATE enquiry_receipts SET notify_status=? WHERE event_id=?').run(status, eventId);
  };

  /** index.mjs:781-792 at 13e4954, moved here unchanged. */
  async function formNote(lead, eventId) {
    try {
      let timer;
      const res = await Promise.race([
        sendNote(leadNote(lead, { siteUrl })),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('owner notification unconfirmed')), formWaitMs); }),
      ]).finally(() => clearTimeout(timer));
      setStatus(res?.ok ? 'sent' : 'uncertain', eventId);
      if (!res?.ok) log({ evt: 'lead.wa_failed', id: lead.lead_id, error: res?.error ?? 'unknown' });
    } catch (err) {
      setStatus('uncertain', eventId);
      log({ evt: 'lead.wa_error', id: lead.lead_id, error: String(err?.message ?? err) });
    }
  }

  /** tools.mjs:256-263 at 13e4954 (create_lead). */
  async function conciergeNote(lead) {
    try {
      const res = await sendNote(leadNote(lead, { siteUrl }));
      if (!res?.ok) log({ evt: 'lead.wa_failed', id: lead.lead_id, error: res?.error ?? 'unknown' });
    } catch (err) {
      log({ evt: 'lead.wa_error', id: lead.lead_id, error: String(err?.message ?? err) });
    }
  }

  /** wa-poller.mjs:608-615 at 13e4954 (a lead the poller created). */
  async function whatsappNote(lead) {
    try {
      const res = await sendNote(leadNote(lead, { siteUrl }));
      if (res && res.ok === false) log({ level: 'warn', evt: 'wa.note.failed', leadId: lead.lead_id, error: res.error ?? 'unknown' });
    } catch (err) {
      log({ level: 'warn', evt: 'wa.note.failed', leadId: lead.lead_id, error: String(err?.message ?? err) });
    }
  }

  async function leadEvent(lead, { why, created = false, eventId = null } = {}) {
    if (!lead || !sendNote) return;
    if (why === 'form') return formNote(lead, eventId);
    if (why === 'concierge') return conciergeNote(lead);
    if (created) return whatsappNote(lead);
  }

  const nothing = () => {};
  return {
    leadEvent,
    handover: nothing,
    booking: nothing,
    stopped: nothing,
    alert: nothing,
    mail: nothing,
    command: nothing,
    onPurge: nothing,
    tick: nothing,
    stop: nothing,
    // Today's new-enquiry note goes at once, with no queue behind it: nothing can be stuck.
    health: () => ({ enabled: true, ok: true }),
  };
}
