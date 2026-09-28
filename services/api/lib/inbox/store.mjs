/**
 * Everything the Bona inbox keeps (2026-09-27 design §4.1–4.2): the stored transcript of
 * each inbox chat, the outbox every send from the owner's number is written to before it
 * goes, who has read what, the messages that could not be loaded, and the inbox columns
 * on the lead itself.
 *
 * Only this file writes SQL for `wa_messages`, `wa_outbox`, `inbox_reads` and `wa_gaps`.
 * Which chat belongs in the inbox is decided in `eligibility.mjs` and by the owner; this
 * file only records the outcome, so a guessed lead can never slip in by being re-derived.
 *
 * Message text is personal data. Nothing here logs, and nothing here puts text into an
 * error message. A login code never reaches the file: a `code` outbox row stores NULL
 * text whatever the caller passes (design §4.2).
 */
import { INBOX_STATES } from './eligibility.mjs';

/** Transcripts are kept for 5 years after the chat's last message (D11). */
export const RETENTION_MS = Math.round(5 * 365.25 * 86_400_000);
export const MAX_STORED_TEXT = 8000;
export const SENDER_KINDS = ['client', 'staff', 'dana', 'owner_number'];
export const OUTBOX_KINDS = ['staff', 'dana', 'code', 'note'];
export const OUTBOX_STATUSES = ['pending', 'accepted', 'failed', 'uncertain'];
const DIRECTIONS = ['in', 'out'];
const MAX_ERROR = 200;
/** The day cap's window (lib/wa-send.mjs): a send younger than this still counts against it. */
const SEND_DAY_MS = 86_400_000;

/** JSON columns of `leads` — the same three `db.mjs` parses — so a list row reads like `getLead()`. */
const LEAD_JSON = ['click_ids', 'first_touch', 'last_touch'];

const plain = (row) => (row ? { ...row } : null);
const str = (v) => (v === null || v === undefined ? null : String(v));
const hasNumber = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const toTs = (v) => Math.trunc(Number(v));
/**
 * A cutoff or a start time. Anything unusable becomes 0, the harmless end for every caller
 * here: a purge, prune or stale-mark given garbage touches nothing, and the day-cap count
 * counts everything (so it refuses rather than overspends).
 */
const num = (v) => (hasNumber(v) ? Number(v) : 0);
// A fractional LIMIT is truncated rather than passed through, the same as `waitingLeads()`
// in db.mjs.
const clampLimit = (limit, fallback) => Math.trunc(Math.max(1, Math.min(1000, Number(limit) || fallback)));

function leadRow(row) {
  if (!row) return null;
  const out = { ...row };
  for (const col of LEAD_JSON) {
    if (out[col] === null || out[col] === undefined) { out[col] = null; continue; }
    try { out[col] = JSON.parse(out[col]); } catch { out[col] = null; }
  }
  return out;
}

/**
 * At most `MAX_STORED_TEXT` code points, never splitting a surrogate pair. That many code
 * points always fit in the first 2 × MAX_STORED_TEXT UTF-16 units, so a huge string is
 * never spread into an array whole.
 */
function capText(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (s.length <= MAX_STORED_TEXT) return s;
  return Array.from(s.slice(0, MAX_STORED_TEXT * 2)).slice(0, MAX_STORED_TEXT).join('');
}

// A chat is a lead in the inbox that has a WhatsApp id (P2-1): a form lead with only a
// phone number is `in` but has nothing to show until that person writes.
const IN_CHAT = "l.inbox_state = 'in' AND (l.wa_jid IS NOT NULL OR l.wa_lid IS NOT NULL)";
// NULL counts as unsure: a WhatsApp lead the poller has not placed yet is a guess until
// the owner decides.
const UNSURE_CHAT = "(l.inbox_state = 'unsure' OR l.inbox_state IS NULL) AND (l.wa_jid IS NOT NULL OR l.wa_lid IS NOT NULL)";

/**
 * @param {ReturnType<import('../db.mjs').openDb>} store
 * @param {{ now?: () => number }} [o]
 */
export function createInboxStore(store, { now = () => Date.now() } = {}) {
  const { db, transaction } = store;
  const stmts = new Map();
  const prep = (sql) => {
    let s = stmts.get(sql);
    if (!s) { s = db.prepare(sql); stmts.set(sql, s); }
    return s;
  };

  /* -------------------- messages -------------------- */

  /**
   * Store one message of an inbox chat, once. A message seen again (a re-poll, a thread
   * refresh, the dashboard's own write after a send) changes only two things:
   *
   *   - the sender, and only from `owner_number` to `staff`/`dana`. The poller can read a
   *     sent message back before the send that made it has recorded its key (both wait on
   *     the network) and store it as the owner's number; the send's own write corrects
   *     that. Never the other way: a later poll that cannot find the outbox row must not
   *     demote a known sender, and a client's message is never anyone else's.
   *   - `status`, when the new write carries one.
   *
   * The chat's `last_msg_ts` only ever moves forward, and a message seen again counts with
   * the time it was first stored at, so it cannot push the chat anywhere new.
   *
   * A message stored after all (a thread refresh re-reads one the poller gave up on) clears
   * the `failed` gap its failure left under the same WhatsApp id, in the same transaction:
   * otherwise the thread shows the message and "a message could not be loaded" for it.
   * Only that one row: a join's `history_failed` gap is keyed `join:…`, never a message id.
   *
   * @returns {{ inserted: boolean }}
   */
  function upsertMessage({ key_id, lead_id, jid = null, direction, sender_kind, sender_user_id = null, text = null, media_type = null, ts, status = null } = {}) {
    if (!key_id) throw new RangeError('key_id is required');
    if (!lead_id) throw new RangeError('lead_id is required');
    if (!hasNumber(ts)) throw new RangeError('ts is required');
    if (!DIRECTIONS.includes(direction)) throw new RangeError(`unknown direction ${direction}`);
    if (!SENDER_KINDS.includes(sender_kind)) throw new RangeError(`unknown sender_kind ${sender_kind}`);
    // Only the client writes `in`. The schema's CHECK holds the same rule; refusing here
    // keeps a mismatch a RangeError like every other bad argument, not a raw SQLite error.
    if ((direction === 'in') !== (sender_kind === 'client')) throw new RangeError(`sender_kind ${sender_kind} cannot write direction ${direction}`);
    return transaction(() => {
      const existing = prep('SELECT lead_id, ts FROM wa_messages WHERE key_id = ?').get(String(key_id));
      prep(`INSERT INTO wa_messages (key_id, lead_id, jid, direction, sender_kind, sender_user_id, text, media_type, ts, status)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(key_id) DO UPDATE SET
              sender_kind = CASE WHEN sender_kind = 'owner_number' AND excluded.sender_kind IN ('staff','dana') THEN excluded.sender_kind ELSE sender_kind END,
              sender_user_id = CASE WHEN sender_kind = 'owner_number' AND excluded.sender_kind IN ('staff','dana') THEN excluded.sender_user_id ELSE sender_user_id END,
              status = COALESCE(excluded.status, status)`)
        .run(String(key_id), String(lead_id), str(jid), direction, sender_kind, str(sender_user_id), capText(text), str(media_type), toTs(ts), str(status));
      const at = existing ?? { lead_id: String(lead_id), ts: toTs(ts) };
      prep('UPDATE leads SET last_msg_ts = MAX(COALESCE(last_msg_ts, 0), ?) WHERE lead_id = ?').run(at.ts, at.lead_id);
      prep('DELETE FROM wa_gaps WHERE key_id = ?').run(String(key_id));
      return { inserted: !existing };
    });
  }

  /** The newest `limit` messages of a chat, returned oldest first (how a thread reads). */
  function messagesFor(leadId, { limit = 200 } = {}) {
    return prep('SELECT * FROM wa_messages WHERE lead_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?')
      .all(String(leadId ?? ''), clampLimit(limit, 200)).map(plain).reverse();
  }

  const newestTs = (leadId) => prep('SELECT MAX(ts) AS ts FROM wa_messages WHERE lead_id = ?').get(String(leadId ?? '')).ts ?? null;
  const hasMessages = (leadId) => Boolean(prep('SELECT 1 FROM wa_messages WHERE lead_id = ? LIMIT 1').get(String(leadId ?? '')));
  /** The stored message with this WhatsApp id, or null. */
  const messageByKey = (keyId) => (keyId ? plain(prep('SELECT * FROM wa_messages WHERE key_id = ?').get(String(keyId))) : null);

  /* -------------------- outbox -------------------- */

  const getOutbox = (sendId) => plain(prep('SELECT * FROM wa_outbox WHERE send_id = ?').get(String(sendId ?? '')));
  // A NULL key never matches: a row still waiting for its key is not "the row for" anything.
  const outboxByKey = (keyId) => (keyId
    ? plain(prep('SELECT * FROM wa_outbox WHERE key_id = ? ORDER BY created ASC, rowid ASC LIMIT 1').get(String(keyId)))
    : null);

  /**
   * Written before the HTTP call, so a send that dies half-way still counts against the
   * day cap and can still be matched to the message it became. A `send_id` already there
   * is left exactly as it is: a double submit gets the row the first submit made.
   *
   * @returns {{ inserted: boolean, row: object }}
   */
  function insertOutbox({ send_id, lead_id = null, jid, text = null, user_id = null, sender_kind, status = 'pending' } = {}) {
    if (!send_id) throw new RangeError('send_id is required');
    if (!jid) throw new RangeError('jid is required');
    if (!OUTBOX_KINDS.includes(sender_kind)) throw new RangeError(`unknown outbox kind ${sender_kind}`);
    if (!OUTBOX_STATUSES.includes(status)) throw new RangeError(`unknown outbox status ${status}`);
    const t = now();
    const stored = sender_kind === 'code' ? null : capText(text);
    const { changes } = prep(`INSERT OR IGNORE INTO wa_outbox (send_id, lead_id, jid, text, user_id, sender_kind, status, key_id, created, updated, error)
                              VALUES (?,?,?,?,?,?,?,NULL,?,?,NULL)`)
      .run(String(send_id), str(lead_id), String(jid), stored, str(user_id), sender_kind, status, t, t);
    return { inserted: changes === 1, row: getOutbox(send_id) };
  }

  /** `key_id`/`error` left out (undefined) are kept as they are; null clears them. */
  function updateOutbox(sendId, { status, key_id = undefined, error = undefined } = {}) {
    if (!OUTBOX_STATUSES.includes(status)) throw new RangeError(`unknown outbox status ${status}`);
    const sets = ['status = ?', 'updated = ?'];
    const vals = [status, now()];
    if (key_id !== undefined) { sets.push('key_id = ?'); vals.push(str(key_id)); }
    if (error !== undefined) { sets.push('error = ?'); vals.push(error === null ? null : String(error).slice(0, MAX_ERROR)); }
    vals.push(String(sendId ?? ''));
    return prep(`UPDATE wa_outbox SET ${sets.join(', ')} WHERE send_id = ?`).run(...vals).changes === 1;
  }

  /**
   * The send an outbound record most likely is, when its key was never recorded (a
   * timeout, a restart mid-send): the oldest unresolved row of the same LEAD with the
   * identical text, created within `windowMs` of the record either way. Lead-level, not
   * jid-level, because the record may carry the chat's lid while the row carries its
   * phone jid (P2-17). Read-only: the caller decides to resolve it.
   */
  function resolveUncertain({ leadId, text, ts, windowMs = 120_000 } = {}) {
    if (!leadId || text === null || text === undefined || text === '' || !hasNumber(ts)) return null;
    return plain(prep(`SELECT * FROM wa_outbox
                       WHERE lead_id = ? AND status IN ('uncertain','pending') AND key_id IS NULL
                         AND text = ? AND ABS(created - ?) <= ?
                       ORDER BY created ASC, rowid ASC LIMIT 1`)
      .get(String(leadId), capText(text), toTs(ts), num(windowMs)));
  }

  /** Staff and Dana sends of one chat that did not (surely) go: the newest 20, oldest first. */
  function openOutboxFor(leadId, { sinceTs = 0 } = {}) {
    return prep(`SELECT * FROM wa_outbox
                 WHERE lead_id = ? AND status IN ('pending','uncertain','failed') AND sender_kind IN ('staff','dana') AND created >= ?
                 ORDER BY created DESC, rowid DESC LIMIT 20`)
      .all(String(leadId ?? ''), num(sinceTs)).map(plain).reverse();
  }

  /**
   * Sends that may have gone since `sinceTs` — the durable day cap (P2-4). A failed send
   * never reached WhatsApp, so it does not count; an uncertain one may have. `excludeJid`
   * leaves the owner's own chat out: messages to himself cost nothing.
   */
  function countSentSince(sinceTs, { excludeJid = null } = {}) {
    const ex = str(excludeJid);
    return prep(`SELECT COUNT(*) AS n FROM wa_outbox
                 WHERE status IN ('pending','accepted','uncertain') AND created >= ? AND (? IS NULL OR jid != ?)`)
      .get(num(sinceTs), ex, ex).n;
  }

  /** A `pending` row this old belongs to a process that died mid-send: it may have gone. */
  const markStalePending = (beforeTs) => prep("UPDATE wa_outbox SET status = 'uncertain', error = 'interrupted', updated = ? WHERE status = 'pending' AND created < ?")
    .run(now(), num(beforeTs)).changes;

  /**
   * Rows that only ever feed the day cap go once they are out of its window: login codes,
   * and the stubs `purgeLead` leaves of a purged chat's sends (no text, no chat).
   */
  const pruneCodeRows = (beforeTs) => prep(`DELETE FROM wa_outbox
                                            WHERE (sender_kind = 'code' OR (sender_kind IN ('staff','dana') AND lead_id IS NULL))
                                              AND created < ?`).run(num(beforeTs)).changes;

  /* -------------------- read marks -------------------- */

  /**
   * Mark a chat read up to `ts` for one person. Never moves backwards (two tabs, an old
   * page submitted late). Opening a chat with nothing in it has nothing to mark, so an
   * unusable `ts` or id is `false`, never a thrown error on a page load.
   */
  function markRead(userId, leadId, ts) {
    if (!userId || !leadId || !hasNumber(ts)) return false;
    prep(`INSERT INTO inbox_reads (user_id, lead_id, last_read_ts) VALUES (?,?,?)
          ON CONFLICT(user_id, lead_id) DO UPDATE SET last_read_ts = MAX(last_read_ts, excluded.last_read_ts)`)
      .run(String(userId), String(leadId), toTs(ts));
    return true;
  }

  /* -------------------- lists -------------------- */

  /**
   * The inbox list for one person: every chat, unread first, then the most recent. A chat
   * with no stored message yet sorts by when it joined. Unread counts inbound messages
   * after this person's read mark or, with none, after their account was made (P2-8) —
   * a new colleague does not start with every old message unread. `handler_name` is null
   * for a handler who has been deactivated: the chat has nobody on it now.
   */
  function listInbox({ userId = null, userCreated = 0, limit = 200 } = {}) {
    return prep(`SELECT l.*,
                   (SELECT COUNT(*) FROM wa_messages m
                     WHERE m.lead_id = l.lead_id AND m.direction = 'in'
                       AND m.ts > COALESCE((SELECT r.last_read_ts FROM inbox_reads r WHERE r.user_id = ? AND r.lead_id = l.lead_id), ?)) AS unread,
                   lm.text AS last_text, lm.media_type AS last_media, lm.direction AS last_direction, lm.sender_kind AS last_sender_kind,
                   u.name AS handler_name
                 FROM leads l
                 LEFT JOIN wa_messages lm ON lm.rowid = (SELECT m2.rowid FROM wa_messages m2 WHERE m2.lead_id = l.lead_id ORDER BY m2.ts DESC, m2.rowid DESC LIMIT 1)
                 LEFT JOIN users u ON u.user_id = l.handler_user_id AND u.active = 1
                 WHERE ${IN_CHAT}
                 ORDER BY (unread > 0) DESC, COALESCE(l.last_msg_ts, l.inbox_since, l.created) DESC, l.rowid DESC
                 LIMIT ?`)
      .all(str(userId), num(userCreated), clampLimit(limit, 200)).map(leadRow);
  }

  /** The nav badge: the same unread rule as `listInbox`, summed over every chat (not just a page of them). */
  function unreadTotal({ userId = null, userCreated = 0 } = {}) {
    return prep(`SELECT COUNT(*) AS n FROM wa_messages m
                 JOIN leads l ON l.lead_id = m.lead_id
                 LEFT JOIN inbox_reads r ON r.user_id = ? AND r.lead_id = m.lead_id
                 WHERE ${IN_CHAT} AND m.direction = 'in' AND m.ts > COALESCE(r.last_read_ts, ?)`)
      .get(str(userId), num(userCreated)).n;
  }

  /**
   * The owner's Unsure list, newest first, each with the first message's snippet so he
   * can decide without opening WhatsApp. The snippet comes from the `lead_created`
   * touchpoint; a row whose meta is not valid JSON shows none rather than failing the page.
   */
  function listUnsure({ limit = 200 } = {}) {
    return prep(`SELECT l.*,
                   (SELECT CASE WHEN json_valid(t.meta) THEN json_extract(t.meta, '$.snippet') END
                      FROM touchpoints t WHERE t.lead_id = l.lead_id AND t.event_type = 'lead_created'
                      ORDER BY t.ts ASC, t.rowid ASC LIMIT 1) AS snippet
                 FROM leads l
                 WHERE ${UNSURE_CHAT}
                 ORDER BY l.created DESC, l.rowid DESC
                 LIMIT ?`)
      .all(clampLimit(limit, 200)).map(leadRow);
  }

  const countUnsure = () => prep(`SELECT COUNT(*) AS n FROM leads l WHERE ${UNSURE_CHAT}`).get().n;

  /* -------------------- gaps -------------------- */

  /** A message that could not be read, shown in the thread instead of silently missing. */
  function addGap({ key_id, lead_id, jid = null, ts, reason } = {}) {
    if (!key_id) throw new RangeError('key_id is required');
    return prep('INSERT OR IGNORE INTO wa_gaps (key_id, lead_id, jid, ts, reason) VALUES (?,?,?,?,?)')
      .run(String(key_id), str(lead_id), str(jid), hasNumber(ts) ? toTs(ts) : null, reason === null || reason === undefined ? null : String(reason).slice(0, MAX_ERROR)).changes === 1;
  }

  const gapsFor = (leadId) => prep('SELECT * FROM wa_gaps WHERE lead_id = ? ORDER BY ts ASC, rowid ASC').all(String(leadId ?? '')).map(plain);

  /* -------------------- inbox columns on the lead -------------------- */

  /**
   * Joining keeps the time a chat first joined: a chat already `in` keeps its
   * `inbox_since` (one still missing it gets `since`). Leaving — `out` or back to
   * `unsure` — clears it.
   */
  function setInboxState(leadId, state, { since = now() } = {}) {
    if (!INBOX_STATES.includes(state)) throw new RangeError(`unknown inbox state ${state}`);
    const t = now();
    const id = String(leadId ?? '');
    if (state === 'in') {
      const at = hasNumber(since) ? toTs(since) : t;
      return prep("UPDATE leads SET inbox_since = CASE WHEN inbox_state = 'in' THEN COALESCE(inbox_since, ?) ELSE ? END, inbox_state = 'in', updated = ? WHERE lead_id = ?")
        .run(at, at, t, id).changes === 1;
    }
    return prep('UPDATE leads SET inbox_state = ?, inbox_since = NULL, updated = ? WHERE lead_id = ?').run(state, t, id).changes === 1;
  }

  /** `userId` null clears it. Who may be a handler is the caller's check (an active user). */
  const setHandler = (leadId, userId) => prep('UPDATE leads SET handler_user_id = ? WHERE lead_id = ?')
    .run(userId ? String(userId) : null, String(leadId ?? '')).changes === 1;

  const setNeedsHuman = (leadId, flag) => prep('UPDATE leads SET needs_human = ? WHERE lead_id = ?')
    .run(flag ? 1 : 0, String(leadId ?? '')).changes === 1;

  /* -------------------- purge -------------------- */

  /**
   * Delete a chat's transcript: its messages, its staff and Dana sends, its gaps and read
   * marks, in one transaction. The lead row stays (attribution data), and so do login-code
   * rows, which hold no text and only feed the day cap.
   *
   * A send of the last 24 hours is not deleted but cut down to a stub — its text and its
   * chat gone, its send id, number, status and time kept — because it still has two jobs:
   * it counts against the day cap (a purge must not hand out fresh sends, least of all
   * for one still in flight), and its send id must never go out a second time (an old
   * form submitted again after the chat was moved back in is `bad_send_id`, since the
   * stub belongs to no chat). `pruneCodeRows` removes stubs once the day is over.
   *
   * @returns {{ messages: number, outbox: number, gaps: number, reads: number }}
   */
  function purgeLead(leadId) {
    const id = String(leadId ?? '');
    return transaction(() => {
      const t = now();
      const sends = "lead_id = ? AND sender_kind IN ('staff','dana')";
      const counts = {
        messages: prep('DELETE FROM wa_messages WHERE lead_id = ?').run(id).changes,
        outbox: prep(`DELETE FROM wa_outbox WHERE ${sends} AND created < ?`).run(id, t - SEND_DAY_MS).changes
          + prep(`UPDATE wa_outbox SET text = NULL, lead_id = NULL, updated = ? WHERE ${sends}`).run(t, id).changes,
        gaps: prep('DELETE FROM wa_gaps WHERE lead_id = ?').run(id).changes,
        reads: prep('DELETE FROM inbox_reads WHERE lead_id = ?').run(id).changes,
      };
      prep('UPDATE leads SET last_msg_ts = NULL WHERE lead_id = ?').run(id);
      return counts;
    });
  }

  /**
   * *Not a client*: out of the inbox, transcript gone, nobody handling it, nothing
   * pending — all or nothing, so a failure half-way never leaves a purged chat `in`.
   */
  function leaveInbox(leadId) {
    return transaction(() => {
      setInboxState(leadId, 'out');
      const counts = purgeLead(leadId);
      prep('UPDATE leads SET handler_user_id = NULL, needs_human = 0 WHERE lead_id = ?').run(String(leadId ?? ''));
      return counts;
    });
  }

  /**
   * D11: the transcript of every chat whose last message is older than `beforeTs`. Lead
   * rows stay. A chat with nothing left to delete is not counted.
   *
   * @returns {{ leads: number, messages: number }}
   */
  function retentionPurge(beforeTs) {
    return transaction(() => {
      const ids = prep(`SELECT lead_id FROM leads
                        WHERE last_msg_ts < ? AND EXISTS (SELECT 1 FROM wa_messages m WHERE m.lead_id = leads.lead_id)`)
        .all(num(beforeTs)).map((r) => r.lead_id);
      let messages = 0;
      for (const id of ids) messages += purgeLead(id).messages;
      return { leads: ids.length, messages };
    });
  }

  return {
    upsertMessage, messagesFor, newestTs, hasMessages, messageByKey,
    insertOutbox, getOutbox, outboxByKey, updateOutbox, resolveUncertain, openOutboxFor, countSentSince, markStalePending, pruneCodeRows,
    markRead, listInbox, unreadTotal, listUnsure, countUnsure,
    addGap, gapsFor,
    setInboxState, setHandler, setNeedsHuman,
    purgeLead, leaveInbox, retentionPurge,
  };
}
