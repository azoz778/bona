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
 *     HOUR bucket and folds into that hour's `brain_out` alert, which lists the chats: one note
 *     an hour however many chats wait.
 *   - booking `bk:<id>` / `bk-untold:<id>`, stopped `stop:<lead>:<ts>` (auto mode only).
 *   - summary `sum:<day>` / `sumtest:<ts>` (only while owner_as_client or own_inbox is '1';
 *     lib/daily-summary.mjs).
 *   - command `cmd:<record id>` (the `#dana` reply; its text is held in memory only, so a reply
 *     queued when the process stops is dropped, never stored).
 *   - alert `al:<code>:<hour>` (a fixed sentence per code; ALERT_CODES), `al:old_out_wrote:<lead
 *     or candidate>:<day>`. Link-down and identity alerts go by web push and Kuma only, never
 *     as a WhatsApp note through another instance: they are refused here.
 *   - mail `mail:<message id>` (Track C; sender and subject read at send time from mail_seen).
 * Same-release rule (DESIGN §2): hand-over, booking and stopped notes go only for a lead in auto
 * mode (checked when queued and again when sent); new_client, command and alert notes always
 * go, a new client outside auto mode with today's lines plus the Lead link only.
 *
 * Sending (DESIGN §7.1):
 *   - everything due within 2 min goes as ONE message (at most 3,500 characters; what does not
 *     fit waits for the next send): the first row `sent`, the others `merged` into it;
 *   - at least 25 s between two sends, read back from the ledger so a restart cannot skip it;
 *   - at most 40 sends a (Riyadh) day while a summary is on to carry the rest: the overflow is
 *     kept for the summary (`merged`, `over`), except the summary itself and a command reply;
 *   - each send's rows are marked `uncertain` BEFORE the call: a process that dies mid-send
 *     leaves them so, and they are never sent again. The answer then decides: ok → sent; the
 *     Sending switch off or the note's minute used up → back to queued, held (30 s / 15 s, or
 *     at once when Sending is back on), sent later, nothing lost; an answer that may have gone
 *     (timeout, 5xx, a throw, no ack) → uncertain, never retried; any other refusal (BONA_WA_NOTIFY
 *     =0, Evolution not configured, a 4xx) → retried once after 2 min, then failed;
 *   - the `owner_notes` switch '0' drops new and queued notes.
 * Form enquiries (critic round 2 #17b): the form path's note is due at once and the request
 * awaits the first attempt for up to 4 s, as before; `enquiry_receipts.notify_status` follows the
 * ledger: held → pending, sent → sent, failed or uncertain → uncertain (a later send moves it on),
 * dropped → dropped, a merge → skipped. enquiry-receipt.mjs leaves a receipt whose note is still
 * queued alone at start-up.
 *
 * The transport is the injected `sendNote(text)` → `{ ok, error?, uncertain?, sendId? }`. index.mjs
 * hands in today's (lib/wa.mjs sendText to the owner's chat); PR-INT (T14) moves it onto the one
 * sender's kind 'note' (lib/wa-send.mjs: the owner's jid only, its own `note:to:` limit, an outbox
 * row without text or lead), whose refusals this file already holds or retries as above.
 *
 * The module wakes itself for its next due note (one unref'd timer, at most a minute ahead), so a
 * held or delayed note goes out without PR-INT's tick; PR-INT's 5 s tick is welcome (one run at a
 * time). Nothing here logs a note's text, a name or a number: ids and codes only. A purge deletes
 * a lead's rows through the store's `onPurge` seam (rows only, never the network).
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
/** Not held back by the 40-a-day limit. */
const CAP_EXEMPT = new Set(['summary', 'command']);
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
 * @param {{ db?: object|null, siteUrl?: string, publicApi?: string,
 *           sendNote?: ((text: string) => Promise<{ ok?: boolean, error?: string, uncertain?: boolean, sendId?: string }>)|null,
 *           team?: object|null, ownerTest?: object|null, inventory?: object|null, brain?: object|null, viewing?: object|null,
 *           waLink?: object|null, mail?: object|null, log?: Function, now?: () => number, formWaitMs?: number,
 *           tzOffsetMs?: number, setTimer?: Function|null, clearTimer?: Function }} [o]
 * @returns {OwnerNotes}
 */
export function createOwnerNotes({
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
  function armNext() {
    if (!db || halted) return;
    const next = prep("SELECT MIN(due_ts) AS d FROM owner_notes WHERE status = 'queued'").get()?.d;
    if (!Number.isFinite(next)) return;
    let at = Math.max(next, lastSendTs() + MIN_GAP_MS);
    if (hold) at = Math.max(at, hold.until);
    arm(at, 1000);
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
    if (inserted && status === 'queued') arm(due);
    return { inserted, noteId: inserted ? id : null, status: inserted ? status : 'exists' };
  }

  const firstAnswerSince = (leadId, since) => prep(`SELECT MIN(created) AS t FROM wa_outbox
      WHERE lead_id = ? AND sender_kind = 'dana' AND status <> 'failed' AND created >= ?`).get(String(leadId), Math.trunc(since))?.t ?? null;
  const firstClientMessage = (leadId, since) => prep(`SELECT text, media_type, ts FROM wa_messages
      WHERE lead_id = ? AND direction = 'in' AND ts >= ? ORDER BY ts ASC, rowid ASC LIMIT 1`).get(String(leadId), Math.trunc(since)) ?? null;
  const lastClientMessage = (leadId, upTo) => (Number.isFinite(upTo)
    ? prep(`SELECT text, media_type, ts FROM wa_messages WHERE lead_id = ? AND direction = 'in' AND ts <= ? ORDER BY ts DESC, rowid DESC LIMIT 1`).get(String(leadId), Math.trunc(upTo))
    : prep(`SELECT text, media_type, ts FROM wa_messages WHERE lead_id = ? AND direction = 'in' ORDER BY ts DESC, rowid DESC LIMIT 1`).get(String(leadId))) ?? null;
  const quote = (m) => {
    const text = oneLine(m?.text, QUOTE_CHARS);
    return text ? `"${text}"` : (oneLine(m?.media_type, 20) || '[message]');
  };

  /** When a queued row is due: a WhatsApp client's note comes forward to its first answer + 20 s. */
  function effectiveDue(r) {
    if (r.kind === 'new_client' && r.lead_id && ANSWERED_WHYS.has(r.meta.why)) {
      const answered = firstAnswerSince(r.lead_id, Number.isFinite(r.meta.ts) ? r.meta.ts : r.created);
      if (Number.isFinite(answered)) return Math.min(r.due_ts, answered + ANSWER_GRACE_MS);
    }
    return r.due_ts;
  }
  const isBrainAlert = (r) => r.kind === 'alert' && r.meta.alert === 'brain_out';
  const isBrainHandover = (r) => r.kind === 'handover' && r.meta.kind === 'brain';

  function lastSendTs() {
    const fromLedger = prep("SELECT MAX(updated) AS t FROM owner_notes WHERE send_id IS NOT NULL OR status = 'uncertain'").get()?.t ?? 0;
    return Math.max(lastAttemptAt, Number(fromLedger) || 0);
  }
  const sendsToday = (t) => prep('SELECT COUNT(DISTINCT send_id) AS n FROM owner_notes WHERE send_id IS NOT NULL AND updated >= ?')
    .get(dayStart(dayKey(t, off), off))?.n ?? 0;

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
    if (listing) lines.push(listing.mapPrecision === 'exact' ? 'Meeting point: map link sent' : 'Meeting point: NEEDED (district only)');
    if (!r.meta.told) lines.push('Booked, but the client was NOT told; please write to them.');
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

  function renderAlert(r, queued) {
    const sentence = alertSentence(r.meta.alert, r.meta);
    if (!sentence) return null;
    const lines = [HEADERS.alert, sentence];
    const folded = [];
    const drop = [];
    if (r.meta.alert === 'brain_out') {
      const chats = [];
      for (const h of queued) {
        if (!isBrainHandover(h) || h.meta.alertHour !== r.meta.hour) continue;
        const lead = leadOf(h.lead_id);
        if (!lead || !auto(lead)) { drop.push(h); continue; }
        folded.push(h);
        chats.push(who(lead));
      }
      if (chats.length) {
        lines.push(`Chats waiting: ${chats.length} → ${link('/dashboard/inbox?filter=needs_human')}`);
        const more = chats.length - MAX_LISTED_CHATS;
        lines.push(`${chats.slice(0, MAX_LISTED_CHATS).join(' · ')}${more > 0 ? ` · and ${more} more` : ''}`);
      }
    }
    if (r.meta.alert === 'old_out_wrote') lines.push(`Chats to check: ${link('/dashboard/inbox?tab=unsure')}`);
    return { text: clipUnits(lines.join('\n'), MAX_NOTE_CHARS), folded, drop };
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
      case 'handover': return renderHandover(r);
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

  /** Rows that will not be sent: dropped (no longer sendable) or held over for the summary. */
  function settle(rows, status, t, extra = {}) {
    if (!rows.length) return;
    db.transaction(() => {
      for (const r of rows) {
        prep('UPDATE owner_notes SET status = ?, meta = ?, updated = ? WHERE note_id = ? AND status = ?')
          .run(status, JSON.stringify({ ...r.meta, ...extra }), t, r.note_id, 'queued');
        if (r.kind === 'new_client' && r.meta.ev) setReceipt(r.meta.ev, 'dropped');
        texts.delete(r.note_id);
      }
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
    db.transaction(() => {
      for (const m of members) prep("UPDATE owner_notes SET status = 'uncertain', updated = ? WHERE note_id = ? AND status = 'queued'").run(t, m.note_id);
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
    const sendId = typeof res?.sendId === 'string' && res.sendId ? res.sendId : `NB-${t2.toString(36)}-${randomId(6)}`;
    const forms = [];
    db.transaction(() => {
      for (const m of members) {
        const meta = { ...m.meta };
        let status;
        let sid = null;
        let due = m.due_ts;
        let receipt = RECEIPT[outcome];
        if (outcome === 'sent') {
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

  /** One pass: drop what is off, send at most one message, then stop (the next pass is 25 s away at best). */
  async function step() {
    const t = now();
    if (!notesOn()) { dropQueued(t); return; }
    if (hold) {
      if (t < hold.until && !(hold.reason === 'sending_disabled' && sendingOn())) return;
      hold = null;
    }
    const queued = prep("SELECT * FROM owner_notes WHERE status = 'queued' ORDER BY due_ts, created, rowid").all().map(rowOf);
    if (!queued.length) return;
    // A brain hand-over waits for its hour's brain_out alert, which lists it.
    const brainHours = new Set(queued.filter(isBrainAlert).map((r) => r.meta.hour));
    const candidates = queued
      .filter((r) => !(isBrainHandover(r) && brainHours.has(r.meta.alertHour)))
      .map((r) => {
        try { return { row: r, due: effectiveDue(r) }; } catch { return { row: r, due: r.due_ts }; }
      })
      .sort((a, b) => a.due - b.due || a.row.created - b.row.created);
    if (!candidates.some((c) => c.due <= t)) return;
    const last = lastSendTs();
    if (t - last < MIN_GAP_MS) return;
    // The overflow goes into the summary, so the limit holds notes back only while there is one
    // to carry them (before go-live, with the summary off, nothing is lost into it).
    const capped = summaryOn(team) && sendsToday(t) >= MAX_PER_DAY;
    const parts = [];
    const dropped = [];
    const over = [];
    let size = 0;
    for (const c of candidates) {
      if (c.due > t + MERGE_WINDOW_MS) break;
      if (capped && !CAP_EXEMPT.has(c.row.kind)) {
        if (c.due <= t) over.push(c.row);
        continue;
      }
      let out = null;
      try {
        out = render(c.row, t, queued);
      } catch (err) {
        // One note that cannot be drawn must not hold back every note behind it.
        say({ level: 'error', evt: 'notes.render_failed', kind: c.row.kind, error: errName(err) });
      }
      if (!out) { dropped.push(c.row); continue; }
      dropped.push(...(out.drop ?? []));
      const extra = (parts.length ? 2 : 0) + out.text.length;
      if (parts.length && size + extra > MAX_NOTE_CHARS) break;
      parts.push({ row: c.row, due: c.due, text: out.text, folded: out.folded ?? [] });
      size += extra;
    }
    settle(dropped, 'dropped', t);
    settle(over, 'merged', t, { over: dayKey(t, off) });
    if (!parts.some((p) => p.due <= t)) return;
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
        armNext();
      } catch (err) {
        say({ level: 'error', evt: 'notes.tick_failed', error: errName(err) });
      } finally {
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
    if (timedOut && inflight.has(r.noteId)) {
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
      // One note an hour for an outage: this hour's brain_out alert lists the chat, or the next
      // hour's when this hour's already went.
      const hour = Math.floor(t / HOUR_MS);
      const current = byKey(`al:brain_out:${hour}`);
      const alertHour = current && current.status !== 'queued' ? hour + 1 : hour;
      const due = alertHour === hour ? t : alertHour * HOUR_MS;
      enqueue({ kind: 'alert', key: `al:brain_out:${alertHour}`, due, meta: { alert: 'brain_out', code: 'down', hour: alertHour } });
      return answer(enqueue({ kind: 'handover', leadId: l.lead_id, key: `ho:${l.lead_id}:brain:${hour}`, due, meta: { ...meta, alertHour } }));
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
      const why = Object.hasOwn(BRAIN_OUT, m.code) ? m.code : 'down';
      const key = `al:brain_out:${hour}`;
      const r = enqueue({ kind: 'alert', key, due: t, meta: { alert: c, code: why, hour } });
      if (!r.inserted) {
        // A hand-over may have opened this hour's note without the cause; the alert brings it.
        const row = byKey(key);
        if (row?.status === 'queued' && row.meta.code !== why) {
          prep("UPDATE owner_notes SET meta = ? WHERE note_id = ? AND status = 'queued'").run(JSON.stringify({ ...row.meta, code: why }), row.note_id);
        }
      }
      return answer(r);
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

  /** Inside purgeLead's transaction (store.mjs `onPurge`): the lead's rows go; nothing else, no network. */
  function onPurge(leadId) {
    if (!db) return;
    prep('DELETE FROM owner_notes WHERE lead_id = ?').run(String(leadId ?? ''));
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
    try {
      const next = prep("SELECT MIN(due_ts) AS d FROM owner_notes WHERE status = 'queued'").get()?.d;
      if (Number.isFinite(next)) arm(next, 1000);
    } catch { /* no ledger to read: nothing to pick up */ }
  }

  return { leadEvent, handover, booking, stopped, alert, mail: mailNote, command, summary, onPurge, tick, stop, health };
}
