/**
 * One WhatsApp record of a Bona inbox chat → one stored message (2026-09-27 design §4.2–§4.3).
 *
 * The poller, the join backfill and the thread refresh all hand records over here, so what
 * a stored message says about itself is decided in one place:
 *
 *   - only a chat that is `in` the inbox is stored (P2-1). The lead is read again first: a
 *     chat the owner marked *Not a client* a moment ago has just had its transcript purged,
 *     and a caller still holding the old row must not write it back.
 *   - a team member's or a never-list number is never a client's chat (§3.5, P2-7), however
 *     the row came to be `in`. Checked here, not left to callers: the poller screens its
 *     records, but a per-chat read (join history, catch-up, refresh) goes straight to a lead.
 *     The row is checked, and so is every number and lid the record names, sent or received
 *     (a lid-only chat first shows whose it is there) — except the instance's own number as a
 *     sent record's alt, which names the sender, not the chat. That number is the instance's
 *     own (`ownerPhone`: `BONA_WA_INSTANCE_JID`, the owner's number while that is unset), not
 *     read from the owner's account, so it is still known while his row is deactivated or
 *     demoted. Such a record stores nothing.
 *     A received one may teach a row that holds no number yet that number, when it then
 *     excludes the row by itself; nothing else is learned from it, so a client's chat never
 *     excludes itself. Ingest never moves a chat out: the never-list add (P2-7) and the
 *     maintenance sweep (P2-20) do.
 *   - a record with no id cannot be de-duplicated, and noise — reactions, deletes and edits,
 *     poll votes, key-distribution records — is never a bubble (P2-14). Neither is stored.
 *   - nothing older than the chat's history floor (`leads.history_from`, set when it joined:
 *     24 h before an automatic join, 30 days before the owner's Move or Add) is stored or
 *     learned from, whichever read brings it — the poller (whose window can reach weeks back
 *     after an outage), a join's history, a thread refresh or the daily catch-up. A record
 *     with no time of its own is stored at now(), inside any floor.
 *   - a login code is never stored (§4.2: the code lives only in the WhatsApp message, P2-21).
 *     Its outbox row keeps the message id for the day's count, so the record is recognised
 *     by that id — however it is filed, sent or received — and refused before anything is
 *     written or learned. A send that went uncertain never recorded an id, and the daily
 *     upkeep prunes code rows, so a record whose text is a login code's own message is
 *     refused as well, whichever way it went.
 *   - nor is an owner note (DESIGN §7.1, critic C2): our notes to the owner sit in his own
 *     chat, which joins the inbox under his test switch (PR-A2). Its outbox row has no lead and
 *     no text, so it is recognised by its message id alone, and refused before anything is
 *     written or learned: ahead of the record-names-an-excluded-number check too, whose lesson
 *     (the owner's number onto a lid-only row) would be taught by our own note, not by the chat.
 *     (One whose send went uncertain never recorded an id; the poller's own-note header check,
 *     wa-poller.mjs `OWN_NOTE_RE`, is that case's net.)
 *   - who sent an outbound record (P2-17). The dashboard's own sends are found by the
 *     WhatsApp message id their send came back with. A send that never came back
 *     (`uncertain`, or `pending` when a restart cut it off) is found by its exact text within
 *     two minutes, anywhere in the LEAD's chat — the reply went to the phone jid, but
 *     Evolution may file the record under the chat's `@lid`. Only a record seen for the first
 *     time, that carries its own time, and not one stamped before the send was written: a
 *     record read again, or typed just before an identical reply, must not mark a reply that
 *     may never have gone as sent, and a record with no time is stored at now(), which says
 *     nothing about when it was sent.
 *     Anything else was typed on the owner's phone or sent by Lisa for him, which cannot be
 *     told apart: `owner_number`.
 *   - a human outbound seen for the first time clears "needs a human" (P2-16) and gives a
 *     chat nobody handles a handler (P2-15): the staff member who replied, or the owner for
 *     his own number. Only the first time — a refresh reads old records again, and must not
 *     undo a later "needs a human" or somebody's reassignment of the chat to nobody.
 *     A human outbound seen for the first time also stamps `last_human_out_ts`, the clock
 *     Dana's 24 h silence runs on (P4-5); only forward, so a history read never moves it back.
 *   - a lead learns its lid, phone jid and phone from a record it RECEIVED, into empty
 *     fields only, from a record of its own chat only, and never a number another lead
 *     holds as a phone or as a phone jid.
 *
 * The own-number inbox and the owner's test switch (2026-11-27 DESIGN §3.2, PR-A2):
 *   - the rollback guard: a chat that joined by the own rule or the test (`inbox_via` set) is
 *     refused (`rule_off`) while `ownerTest.ownNumberOk()` is false (no switch handed in reads as
 *     false), so the poller and a thread refresh alike stop storing it the moment Bona's own
 *     number is not checked, or the personal-number rollback is in place (DESIGN §13.2);
 *   - an owner command (`#dana …`) is never a message, in any chat, either way it went
 *     (`command`), whichever read brings it; nor is any `#dana` line the parser does not take
 *     (owner-test.mjs isDanaCommandText: DANA_COMMAND_RE on the text as typed and as the parser
 *     reads it, and a `#dana` line through format marks, no-break spaces or fullwidth forms);
 *   - in the owner's test chat (`inbox_via` 'owner_test') a sent record is stored only when a
 *     staff or Dana outbox row is its send. Anything else (a note whose send went uncertain,
 *     call_alert.py's lines, a command's confirmation, anything typed on the Fold) is
 *     `test_chat_untracked`: it is not his chat, and as `owner_number` it would mute the
 *     assistant for a day (critic C3). So a human on the Fold cannot be tested there; the
 *     dashboard's staff reply covers that test;
 *   - the Greeting/Away detector: one untracked sent text, of any length, seen in two or more
 *     chats within 24 h means WhatsApp Business's greeting or away message is on, which mutes
 *     the assistant: ONE `notes.alert('greeting_away')` a (Riyadh) day, raised after the
 *     record's transaction. No shortest text: an away message can be two words ("Back
 *     tomorrow"); the same short reply typed into two chats raises it too, at most once a day,
 *     and the alert says the messages "look" on. A record with no text (a photo without a
 *     caption) never counts. A text is remembered as a hash only; the stored copies of other
 *     chats count too, and so does a copy the owner's test chat dropped, kept as a mark in the
 *     `greeting_seen` setting (a hash of the text, a hash of the chat, the copy's time: never
 *     the text, a number or a lead id; as many as the in-memory memory keeps, GREETING_MEMORY,
 *     each until it can no longer count), so a
 *     restart forgets nothing (Codex T07 r5), and a day's alert already in the owner-notes
 *     ledger is not raised again;
 *   - a human message seen for the first time also ends a hold that waits for a person
 *     (`dana_hold_reason` with no `dana_hold_until`), when it was written after the hold: newer
 *     than every assistant send of the chat (store.mjs clearHumanHold), so an old reply a
 *     refresh finds only now leaves it, and a client message stored before it was found never
 *     keeps the hold; a timed hold runs to its end. So does
 *     WhatsApp's copy of a dashboard reply, matched by its key to the staff row, though the
 *     sender stored the reply on its 2xx before the copy came (the same freshness bound). And
 *     the hold is asked again when an unsure or cut-off assistant send is accepted here: its
 *     bound drops from when it went unsure to when it was written, so a person's reply stored
 *     earlier and written in between now ends it, as it would have had the copy been read
 *     first (store.mjs recheckHumanHold; Codex T07 r4);
 *   - a brochure the assistant sent (a Dana row with media_kind 'document') is found by its id,
 *     by its caption (a document record's text, matched to such rows only, never to a staff or
 *     text send with the same words, and a text record never to a brochure), or by the fallback:
 *     the lead's oldest unresolved such row within two minutes (`via: 'document'`). It is Dana's,
 *     never the owner's. A photo's or a video's caption matches no send at all: only a plain
 *     text record is matched to a text send by its words.
 *
 * Nothing here logs text, a phone number, a lid or a name — ids and field names only.
 */
import { createHash } from 'node:crypto';
import { isCodeMessage } from '../dashboard/auth.mjs';
import { isDanaCommandText } from '../owner-test.mjs';
import { normalisePhone } from '../phone.mjs';
import { createTeam, isExcludedLead as sharedIsExcludedLead } from '../team.mjs';
import { jidsOf } from '../wa-poller.mjs';

/** How far apart an unconfirmed send and the record that confirms it may be (P2-17). */
export const RESOLVE_WINDOW_MS = 120_000;

/**
 * How much older than its outbox row a send's record may be stamped. The row is written
 * before the HTTP call and the record stamped after it, on the Evolution host; the record's
 * time is whole seconds, so it can read up to a second early. A few seconds covers that.
 */
export const SEND_SKEW_MS = 5_000;

/** Distinct lead/reason pairs a refusal is logged for before the memory of them starts over. */
const WARNED_MAX = 1000;

/** The Greeting/Away detector (DESIGN §3.2): the window two chats' copies must fall in. */
export const GREETING_WINDOW_MS = 24 * 3_600_000;
/** Distinct texts it remembers (as hashes) before the oldest is forgotten. */
const GREETING_MEMORY = 500;
/**
 * The setting that remembers, across a restart, the copies the owner's test chat drops
 * (lib/team.mjs `greeting_seen`): `<text hash>.<chat hash>.<ms>` marks, comma-separated. A
 * client's chat stores its copy, and the stored copies are read already; the test chat stores
 * none, so without its mark a restart between its copy and a client's would hide the pair.
 */
export const GREETING_SEEN_KEY = 'greeting_seen';
/**
 * Marks the setting keeps: the newest, by the copy's time. As many as the in-memory memory keeps texts
 * (GREETING_MEMORY), so a restart never forgets a copy sooner than the running process would (Codex T07 r6).
 */
export const GREETING_MARKS = GREETING_MEMORY;
const GREETING_MARK_RE = /^([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{11})\.(\d{1,16})$/;
/** What a mark keeps of a text (its SHA-256, the memory's key) and of a chat: truncated hashes, never either. */
const textMark = (key) => key.slice(0, 16);
const chatMark = (leadId) => createHash('sha256').update(`greeting-chat\0${leadId}`).digest('base64url').slice(0, 11);
/** The alert is once a day by Riyadh's calendar (UTC+3, no daylight saving). */
const RIYADH_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;
const riyadhDay = (t) => Math.floor((t + RIYADH_OFFSET_MS) / DAY_MS);

/** A record whose media is a document (lib/evolution.mjs `mediaOf`: `[document]` or `[document: name]`). */
const isDocument = (rec) => typeof rec?.media === 'string' && rec.media.startsWith('[document');
/** A plain text record: no media of any kind (a photo's or a video's caption is not a text send). */
const isPlainText = (rec) => rec?.media === null || rec?.media === undefined;

/** Outbound senders that are a person answering — as opposed to Dana. */
const HUMAN_SENDERS = new Set(['staff', 'owner_number']);

/**
 * Every number (with its phone jid) and every lid a record names, each once. `jidsOf` keeps
 * only the first of each: right for learning from a record that names one person, but a
 * second, different one would go unchecked.
 */
function namedBy(rec) {
  const numbers = new Map();
  const lids = new Set();
  for (const j of [rec.jid, rec.jidAlt]) {
    const { phone, waJid, waLid } = jidsOf({ jid: j });
    if (waLid) lids.add(waLid);
    if (waJid) numbers.set(phone ?? waJid, { phone, waJid });
  }
  return { numbers: [...numbers.values()], lids: [...lids] };
}

/**
 * True when a number or lid the record names is excluded. Each is checked as the row would
 * be if it held that identifier, so whatever decides exclusion for a row (`isExcluded`)
 * decides for the record too. On a record we sent, the owner's own number as the alt is left
 * out: there it names the sender, not the chat (lib/evolution.mjs no longer takes a sent
 * record's `key.senderPn` as the alt; this still covers an alt that is our number anyway).
 */
function recordNamesExcluded(lead, rec, isExcluded, ownerPhone) {
  const senderAlt = rec.fromMe && ownerPhone && jidsOf({ jid: rec.jidAlt }).phone === ownerPhone;
  const { numbers, lids } = namedBy(senderAlt ? { jid: rec.jid } : rec);
  return numbers.some(({ phone, waJid }) => isExcluded({ ...lead, phone_e164: phone ?? lead.phone_e164, wa_jid: waJid }))
    || lids.some((waLid) => isExcluded({ ...lead, wa_lid: waLid }));
}

/**
 * True when a record can be of this row's chat: it names at most one number and one lid, its
 * lid is the row's when both have one, and its number the row's (its phone, else the number
 * in its phone jid) when both have one. A record that names two people, or another chat's
 * lid or number, teaches the row nothing.
 */
function sameChat(lead, rec) {
  const { numbers, lids } = namedBy(rec);
  if (numbers.length > 1 || lids.length > 1) return false;
  if (lids[0] && lead.wa_lid && lids[0] !== lead.wa_lid) return false;
  const rowNumber = lead.phone_e164 ?? jidsOf({ jid: lead.wa_jid }).phone;
  const recNumber = numbers[0]?.phone ?? null;
  return !rowNumber || !recNumber || rowNumber === recNumber;
}

/**
 * @param {object} o
 * @param {ReturnType<import('../db.mjs').openDb>} o.db
 * @param {ReturnType<import('./store.mjs').createInboxStore>} o.inbox
 * @param {() => string|null} [o.ownerUserId] the env owner's `users.user_id`: the handler of a
 *        chat his own phone answers first
 * @param {string|(() => string|null)|null} [o.ownerPhone] the instance's own number (digits,
 *        from `BONA_WA_INSTANCE_JID`, else `BONA_OWNER_JID`): a sent record's alt that is this number names the sender, not
 *        the chat. Left out, it is read from the `ownerUserId` account, which a deactivated or
 *        demoted owner row no longer yields
 * @param {((lead: object) => boolean)|null} [o.isExcludedLead] true for a chat that is never a
 *        client's; defaults to lib/team.mjs `isExcludedLead` over the team and never-list
 *        tables in `db`. Called with per-identifier views of a lead, so it must decide from
 *        the `phone_e164`, `wa_jid` and `wa_lid` it is handed, never by re-reading the row
 * @param {{ ownNumberOk?: () => boolean }|null} [o.ownerTest] lib/owner-test.mjs: the rollback
 *        guard reads `ownNumberOk()` (left out, it reads as false), and the default exclusion
 *        takes its test override (lib/team.mjs `createTeam`'s `ownerTest`)
 * @param {{ alert?: (code: string, meta?: object) => unknown }|null} [o.notes] lib/owner-notes.mjs,
 *        for the Greeting/Away alert; left out, the detector raises nothing
 * @param {(e: object) => void} [o.log]
 * @param {() => number} [o.now]
 */
export function createIngest({
  db, inbox, ownerUserId = () => null, ownerPhone = null, isExcludedLead = null, ownerTest = null, notes = null,
  log = () => {}, now = () => Date.now(),
} = {}) {
  if (!db || !inbox) throw new TypeError('createIngest needs the store and the inbox store');
  // `createTeam` only prepares statements when they are first used: this instance costs nothing.
  const team = createTeam(db, { ownerTest, now });
  /** Bona's own number, identity checked (DESIGN §5.3); no switch, or one that throws, is false. */
  const ownNumberOk = () => {
    try { return ownerTest?.ownNumberOk?.() === true; } catch { return false; }
  };
  // The inbox's one exclusion rule (lib/team.mjs `isExcludedLead`) unless a caller hands one in.
  const isExcluded = isExcludedLead ?? ((l) => sharedIsExcludedLead(team, db, l));
  const givenOwnerPhone = typeof ownerPhone === 'function' ? ownerPhone : () => ownerPhone;
  /** The owner's own number: the instance's, when given; else his account's, as before. */
  const ownersNumber = () => normalisePhone(givenOwnerPhone()) ?? team.getUser(ownerUserId())?.phone_e164 ?? null;

  /**
   * The outbox row an outbound record is, when the dashboard sent it; `via` says how it was
   * found. Its message id always counts. Its text only for a record not stored yet — one
   * already stored was judged when first read, and a send it did not match then was not its
   * own — and only for a send written no later than the record was stamped (SEND_SKEW_MS).
   * `resolveUncertain` returns the oldest match, so when that one is too new, all are. A
   * record with no time of its own is never matched by text: `ts` is then now(), and a send
   * written in the last two minutes would match a record that could be days old. A document's
   * caption is matched to a Dana brochure row only, and a plain text record's text to a text row
   * only (store.mjs `resolveUncertain`'s `document`): a PDF whose caption is an unsure staff
   * reply's words is not that reply. Any other media (a photo, a video: only the phone sends
   * them) matches nothing by its caption, so a photo captioned with an unsure dashboard text's
   * words neither settles that text nor reads as the staff member's. `byKey` is the row the
   * caller already looked up by the record's id.
   */
  function outboxRowFor(leadId, rec, body, ts, byKey) {
    if (byKey) return { row: byKey, via: 'key' };
    if (!Number.isFinite(rec.ts) || inbox.messageByKey(rec.id)) return null;
    if (body && (isPlainText(rec) || isDocument(rec))) {
      const byText = inbox.resolveUncertain({ leadId, text: body, ts, windowMs: RESOLVE_WINDOW_MS, document: isDocument(rec) });
      if (byText && ts >= byText.created - SEND_SKEW_MS) return { row: byText, via: 'text' };
    }
    // A brochure whose caption did not come back as it went (or at all): the same rules, by its
    // media kind (PR-A2). Only a document record, and only a Dana row with media_kind 'document'.
    if (isDocument(rec) && typeof inbox.resolveUncertainDocument === 'function') {
      const byDoc = inbox.resolveUncertainDocument({ leadId, ts, windowMs: RESOLVE_WINDOW_MS });
      if (byDoc && ts >= byDoc.created - SEND_SKEW_MS) return { row: byDoc, via: 'document' };
    }
    return null;
  }

  /* ---------- the Greeting/Away detector (DESIGN §3.2) ---------- */

  /** text hash → Map(lead id → the newest time that chat's copy was sent). Hashes only, never the text. */
  const untracked = new Map();
  let alertedDay = null;
  let otherCopies = null;
  let ledgerToday = null;

  /** The test chat's dropped copies, as the `greeting_seen` setting keeps them; junk reads as none. */
  function readMarks(raw = team.getSetting(GREETING_SEEN_KEY)) {
    const marks = [];
    for (const part of String(raw ?? '').split(',')) {
      const m = GREETING_MARK_RE.exec(part);
      if (m) marks.push({ text: m[1], chat: m[2], at: Number(m[3]) });
    }
    return marks;
  }

  /**
   * Remember a copy the transcript drops: one mark per text and chat (that chat's newest copy),
   * the newest GREETING_MARKS by the copy's time, and none that can no longer count. A copy
   * counts with one sent within GREETING_WINDOW_MS of it, and a record only while it is at most
   * that old, so a mark older than twice the window never counts again. Written inside the
   * record's transaction; a write that fails is logged (no text, no id) and never fails the
   * record. Returns the marks now kept, or null when they could not be read or written.
   */
  function rememberDropped(key, leadId, ts, t) {
    try {
      const text = textMark(key);
      const chat = chatMark(leadId);
      const marks = readMarks();
      const same = (m) => m.text === text && m.chat === chat;
      const at = Math.max(Math.trunc(ts), ...marks.filter(same).map((m) => m.at));
      // A mark counts only between twice the window ago and one window ahead (a copy WhatsApp dated in the future
      // never takes the place of a real one).
      const counts = (m) => m.at >= t - 2 * GREETING_WINDOW_MS && m.at <= t + GREETING_WINDOW_MS;
      const kept = marks.filter((m) => !same(m) && counts(m));
      if (counts({ at })) kept.push({ text, chat, at });
      kept.sort((a, b) => a.at - b.at);
      const next = kept.slice(-GREETING_MARKS);
      team.setSetting(GREETING_SEEN_KEY, next.map((m) => `${m.text}.${m.chat}.${m.at}`).join(','));
      return next;
    } catch (err) {
      log({ level: 'warn', evt: 'inbox.greeting_mark_failed', error: String(err?.code ?? err?.name ?? 'error').slice(0, 40) });
      return null;
    }
  }

  /**
   * One untracked sent text, seen for the first time in this chat. True when the same text is
   * now in two or more chats within GREETING_WINDOW_MS of this copy and today's alert has not
   * been raised yet (by this process, or by an earlier one: the ledger's row). `dropped` is a
   * copy the transcript does not keep (the owner's test chat): it is marked in the store too.
   * Chats are counted by their mark (`chatMark`), whichever memory names them, so one chat is
   * never two.
   */
  function noteUntracked(leadId, body, ts, { dropped = false } = {}) {
    const text = typeof body === 'string' ? body.trim() : '';
    const t = now();
    // Any length counts (an away message can be "Back tomorrow"); only no text at all does not.
    if (!text || !Number.isFinite(ts) || ts < t - GREETING_WINDOW_MS) return false;
    const key = createHash('sha256').update(text).digest('base64url');
    let chats = untracked.get(key);
    if (!chats) {
      if (untracked.size >= GREETING_MEMORY) untracked.delete(untracked.keys().next().value);
      chats = new Map();
      untracked.set(key, chats);
    }
    chats.set(leadId, Math.max(chats.get(leadId) ?? -Infinity, ts));
    const near = (at) => Math.abs(at - ts) <= GREETING_WINDOW_MS;
    const seen = new Set([...chats].filter(([, at]) => near(at)).map(([id]) => chatMark(id)));
    // A copy nothing stores is marked before anything decides, so a restart after it forgets nothing.
    let marks = dropped ? rememberDropped(key, leadId, ts, t) : null;
    if (seen.size < 2) {
      // The stored copies (other chats' owner_number messages) remember what a restart forgot.
      try {
        otherCopies ??= db.db.prepare(`SELECT lead_id, text FROM wa_messages
                                        WHERE direction = 'out' AND sender_kind = 'owner_number' AND lead_id <> ?
                                          AND ts >= ? AND ts <= ? AND text IS NOT NULL
                                        ORDER BY ts DESC LIMIT 200`);
        for (const r of otherCopies.all(String(leadId), ts - GREETING_WINDOW_MS, ts + GREETING_WINDOW_MS)) {
          if (String(r.text).trim() === text) seen.add(chatMark(r.lead_id));
        }
      } catch { /* nothing stored to read: the other memories decide */ }
    }
    if (seen.size < 2) {
      // And the test chat's dropped copies, which nothing stores: their marks.
      try {
        marks ??= readMarks();
        const mark = textMark(key);
        for (const m of marks) if (m.text === mark && near(m.at)) seen.add(m.chat);
      } catch { /* no marks to read: the other memories decide */ }
    }
    if (seen.size < 2) return false;
    const day = riyadhDay(t);
    if (alertedDay === day) return false;
    alertedDay = day;
    // Raised already today by an earlier process: the ledger's `al:greeting_away:<hour>` row (DESIGN §7.2).
    try {
      ledgerToday ??= db.db.prepare(`SELECT 1 FROM owner_notes WHERE kind = 'alert' AND substr(dedupe_key, 1, 17) = 'al:greeting_away:'
                                       AND created >= ? LIMIT 1`);
      if (ledgerToday.get(day * DAY_MS - RIYADH_OFFSET_MS)) return false;
    } catch { /* no ledger to read: raise it */ }
    return true;
  }

  /** After the record's transaction: a notes module that throws never undoes the record. */
  function raiseGreeting() {
    try {
      notes?.alert?.('greeting_away');
      log({ level: 'warn', evt: 'inbox.greeting_away' });
    } catch (err) {
      log({ level: 'warn', evt: 'inbox.greeting_away_failed', error: String(err?.code ?? err?.name ?? 'error').slice(0, 40) });
    }
  }

  /**
   * What the lead may learn from a record it received: its empty lid / phone jid / phone. Not
   * from one we sent: on an outbound record the alt can be our own number (lib/evolution.mjs
   * leaves out a sent record's `key.senderPn`, which always is) — the same caution as the
   * poller's team pairing. Only from a record of the row's own chat (`sameChat`). Never a value another
   * lead already holds: `phone_e164` is unique, and two leads on one jid would make every
   * later lookup by that jid a coin toss. A phone jid and its number name one person, so
   * when another lead holds either — a form lead's phone alone, say — neither is learned:
   * lookups by jid and by phone would otherwise find two different leads.
   */
  function learnable(lead, rec) {
    if (!sameChat(lead, rec)) return {};
    const { phone, waJid, waLid } = jidsOf(rec);
    const free = (holder) => !holder || holder.lead_id === lead.lead_id;
    const numberFree = free(db.getLeadByJid(waJid)) && free(db.getLeadByPhone(phone));
    const patch = {};
    if (waLid && !lead.wa_lid && free(db.getLeadByJid(waLid))) patch.wa_lid = waLid;
    if (waJid && !lead.wa_jid && numberFree) patch.wa_jid = waJid;
    if (phone && !lead.phone_e164 && numberFree) patch.phone_e164 = phone;
    return patch;
  }

  /**
   * What a refused record teaches its row — `{ patch }` — or why it teaches nothing —
   * `{ reason }`. Only the one number it names (phone and phone jid), only to a row that
   * holds no number yet, and only when that number then excludes the row by itself. A row
   * that holds a number is somebody else's chat as far as it knows: taught the excluded
   * number, or that number's lid, a client's chat would exclude itself.
   */
  function lessonOfRefused(lead, rec) {
    if (lead.phone_e164 || lead.wa_jid) return { reason: 'row_has_number' };
    if (!sameChat(lead, rec)) return { reason: 'other_chat' };
    const { phone_e164: phone, wa_jid: waJid } = learnable(lead, rec);
    const patch = { ...(phone && { phone_e164: phone }), ...(waJid && { wa_jid: waJid }) };
    if (isExcluded({ ...lead, ...patch })) return { patch };
    // A number of the row's own chat goes unlearned only when another lead holds it.
    return { reason: !waJid && jidsOf(rec).waJid ? 'held_by_other_lead' : 'nothing_to_learn' };
  }

  /**
   * Once per lead and reason while this process runs: a refresh or catch-up reads the same
   * chat again and again, and the lead id is all whoever looks into it needs.
   */
  const warned = new Set();
  function warnRefused(leadId, reason) {
    const key = `${leadId} ${reason}`;
    if (warned.has(key)) return;
    if (warned.size >= WARNED_MAX) warned.clear();
    warned.add(key);
    log({ level: 'warn', evt: 'inbox.refused_excluded', leadId, reason });
  }

  function learn(lead, patch) {
    const fields = Object.keys(patch);
    if (!fields.length) return;
    db.updateLead(lead.lead_id, { ...patch, updated: now() });
    log({ evt: 'inbox.learned', leadId: lead.lead_id, fields });
  }

  /**
   * @param {object|null} lead  a `leads` row; only its `lead_id` is trusted, the row is read again
   * @param {import('../evolution.mjs').NormalisedRecord} rec
   * @returns {{ stored: false, reason: 'not_in_inbox'|'rule_off'|'excluded'|'no_id'|'noise'|'before_floor'|'code'|'note'|'command'|'test_chat_untracked' }
   *          | { stored: true, inserted: boolean, senderKind: 'client'|'staff'|'dana'|'owner_number' }}
   */
  function ingest(lead, rec) {
    const leadId = lead?.lead_id ?? null;
    // Set inside the transaction, raised once it has committed (raiseGreeting).
    let greeting = false;
    const out = db.transaction(() => {
      const current = leadId ? db.getLead(leadId) : null;
      if (current?.inbox_state !== 'in') return { stored: false, reason: 'not_in_inbox' };
      // The rollback guard (critic round 2 #13): a chat the own rule or the test let in is not
      // stored while Bona's own number is not checked out, whichever read brings the record.
      if (current.inbox_via && !ownNumberOk()) return { stored: false, reason: 'rule_off' };
      if (isExcluded(current)) return { stored: false, reason: 'excluded' };
      if (!rec?.id) return { stored: false, reason: 'no_id' };
      if (rec.noise) return { stored: false, reason: 'noise' };
      if (Number.isFinite(rec.ts) && Number.isFinite(current.history_from) && rec.ts < current.history_from) {
        return { stored: false, reason: 'before_floor' };
      }
      // The outbox row its id names, if any: read here because an owner note is refused before
      // the exclusion check below can learn a number from it, and reused further down.
      const byKey = inbox.outboxByKey(rec.id);
      // An owner note, by the same id rule as a code: never a bubble in the owner's test chat.
      if (byKey?.sender_kind === 'note') return { stored: false, reason: 'note' };
      if (recordNamesExcluded(current, rec, isExcluded, rec.fromMe ? ownersNumber() : null)) {
        // A row that learns the number excludes itself from then on; otherwise the lead id is
        // logged. Learning is from a received record only (see `learnable`).
        const lesson = rec.fromMe ? { reason: 'outbound' } : lessonOfRefused(current, rec);
        if (lesson.patch) learn(current, lesson.patch);
        else warnRefused(current.lead_id, lesson.reason);
        return { stored: false, reason: 'excluded' };
      }
      // Whichever way it went, and whether or not an outbox row still names its id.
      if (isCodeMessage(rec.text)) return { stored: false, reason: 'code' };
      // And by the id its outbox row keeps, however the record is filed: refused before the
      // direction is looked at, so a code record filed as received is neither stored nor
      // learned from. The row is reused below to find who sent an outbound record.
      if (byKey?.sender_kind === 'code') return { stored: false, reason: 'code' };
      // An owner command (`#dana …`) is never a message, whichever way it went (DESIGN §3.2).
      if (isDanaCommandText(rec.text)) return { stored: false, reason: 'command' };

      const direction = rec.fromMe ? 'out' : 'in';
      const ts = Number.isFinite(rec.ts) ? rec.ts : now();
      const body = typeof rec.text === 'string' ? rec.text : '';
      const text = body || null;
      // A photo keeps its caption as text; a record with neither text nor a known media
      // type still shows up as a bubble, so the team knows something arrived.
      const mediaType = rec.media ?? (text ? null : '[message]');

      let senderKind = 'client';
      let senderUserId = null;
      let match = null;
      if (direction === 'out') {
        // A code row was refused above; the text match cannot find one (no lead, no text).
        match = outboxRowFor(current.lead_id, rec, body, ts, byKey);
        const kind = match?.row.sender_kind;
        const tracked = kind === 'staff' || kind === 'dana';
        // The owner's test chat keeps only what the dashboard or the assistant sent (DESIGN §3.2).
        if (!tracked && current.inbox_via === 'owner_test') {
          greeting = noteUntracked(current.lead_id, body, rec.ts, { dropped: true });
          return { stored: false, reason: 'test_chat_untracked' };
        }
        senderKind = tracked ? kind : 'owner_number';
        senderUserId = senderKind === 'owner_number' ? null : (match.row.user_id ?? null);
      } else {
        learn(current, learnable(current, rec));
      }

      const { inserted } = inbox.upsertMessage({
        key_id: rec.id, lead_id: current.lead_id, jid: rec.jid ?? null, direction,
        sender_kind: senderKind, sender_user_id: senderUserId, text, media_type: mediaType, ts,
      });

      if (match && match.row.status !== 'accepted') {
        inbox.updateOutbox(match.row.send_id, { status: 'accepted', key_id: rec.id });
        log({ evt: 'inbox.outbox.resolved', leadId: current.lead_id, sendId: match.row.send_id, via: match.via });
        // An assistant send that went: its bound in clearHumanHold drops from when it went unsure
        // (its `updated` before this) to when it was written, so a person's reply stored before
        // this copy was read and written in between ends the hold now, as it would have had the
        // copy come first (Codex T07 r4). `match.row` is the row as it was before the accept.
        if (match.row.sender_kind === 'dana' && current.dana_hold_reason && current.dana_hold_until == null) {
          inbox.recheckHumanHold?.(current.lead_id, { after: match.row.created, upTo: match.row.updated });
        }
      }

      // A hold that waits for a person ends with one written after it (store.mjs
      // clearHumanHold: newer than every assistant send of the chat; an older reply a refresh
      // finds now leaves it, a client message stored before the reply was found does not keep
      // it, and a record with no time of its own says nothing of when it was written); a timed
      // hold runs to its end.
      // A human message seen for the first time asks; so does WhatsApp's copy of a dashboard
      // reply, matched by its key to the staff row, though it is already stored: wa-send.mjs
      // `reply` stores it on the 2xx, before the poller reads the copy, and does not end the
      // hold itself (Claude T07 r3). Asked again on every read of it, which the freshness
      // bound keeps safe: an old reply read after a newer hold leaves that hold.
      const dashboardCopy = !inserted && senderKind === 'staff' && match?.via === 'key';
      if ((inserted || dashboardCopy) && HUMAN_SENDERS.has(senderKind)
          && current.dana_hold_reason && current.dana_hold_until == null) {
        inbox.clearHumanHold?.(current.lead_id, { ts: Number.isFinite(rec.ts) ? rec.ts : NaN });
      }
      if (inserted && HUMAN_SENDERS.has(senderKind)) {
        inbox.noteHumanOutbound(current.lead_id, ts);
        if (current.needs_human) inbox.setNeedsHuman(current.lead_id, 0);
        if (!current.handler_user_id) {
          const handler = senderKind === 'staff' ? senderUserId : ownerUserId();
          if (handler) inbox.setHandler(current.lead_id, handler);
        }
      }
      if (inserted && senderKind === 'owner_number') greeting = noteUntracked(current.lead_id, body, rec.ts);
      return { stored: true, inserted, senderKind };
    });
    if (greeting) raiseGreeting();
    return out;
  }

  return { ingest };
}
