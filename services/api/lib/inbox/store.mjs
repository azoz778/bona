/**
 * Everything the Bona inbox keeps (2026-09-27 design §4.1–4.2): the stored transcript of
 * each inbox chat, the outbox every send from the owner's number is written to before it
 * goes, who has read what, the messages that could not be loaded, and the inbox columns
 * on the lead itself.
 *
 * Only this file writes SQL for `wa_messages`, `wa_outbox`, `inbox_reads`, `wa_gaps` and
 * `inbox_candidates` (the owner's list of real-estate chats to check, D17).
 * Which chat belongs in the inbox is decided in `eligibility.mjs` and by the owner; this
 * file only records the outcome, so a guessed lead can never slip in by being re-derived.
 *
 * Message text is personal data. Nothing here logs, and nothing here puts text into an
 * error message. A login code never reaches the file: a `code` outbox row stores NULL
 * text whatever the caller passes (design §4.2).
 */
import { newId } from '../db.mjs';
import { INBOX_STATES, MAX_PROPERTY_WORDS } from './eligibility.mjs';

/** Transcripts are kept for 5 years after the chat's last message (D11). */
export const RETENTION_MS = Math.round(5 * 365.25 * 86_400_000);
/**
 * A chat's history floor (`leads.history_from`), measured back from when it joined: an
 * automatic join keeps the 24 h before the joining message (design §4.1), an owner-button
 * join (Move to Bona inbox, Add chat by phone number) the last 30 days. lib/inbox/backfill.mjs
 * re-exports both.
 */
export const JOIN_HISTORY_MS = 24 * 3_600_000;
export const OWNER_HISTORY_MS = 30 * 86_400_000;
export const MAX_STORED_TEXT = 8000;
export const SENDER_KINDS = ['client', 'staff', 'dana', 'owner_number'];
export const OUTBOX_KINDS = ['staff', 'dana', 'code', 'note'];
export const OUTBOX_STATUSES = ['pending', 'accepted', 'failed', 'uncertain'];
const DIRECTIONS = ['in', 'out'];
const MAX_ERROR = 200;
/** The day cap's window (lib/wa-send.mjs): a send younger than this still counts against it. */
const SEND_DAY_MS = 86_400_000;
/**
 * A real-estate chat to check (D17) is kept this long after its last property message, and
 * a dismissed one (the owner's "Not a client") this long after he dismissed it, only so it
 * is not listed again. The privacy page states both.
 */
export const CANDIDATE_KEEP_MS = 30 * 86_400_000;
export const DISMISSED_KEEP_MS = 365 * 86_400_000;
/** Longest name kept for a candidate, in code points: what WhatsApp shows, never more. */
const MAX_CANDIDATE_NAME = 100;

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

// A chat is a lead in the inbox that has a WhatsApp id (P2-1): a lead with only a phone
// number (a form lead the owner moved in) is `in` but has nothing to show until that
// person writes.
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
  /**
   * One up on a chat's revision (`revision`). Every caller runs it inside the transaction of
   * the write it counts, so the two are committed or rolled back together.
   */
  const bump = (leadId) => prep('UPDATE leads SET chat_rev = chat_rev + 1 WHERE lead_id = ?').run(String(leadId));

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
   * A message stored for the first time moves the chat's revision on (`revision`); one seen
   * again does not.
   *
   * When a stored `owner_number` message is corrected to `staff`/`dana`, the chat's human
   * clock (`last_human_out_ts`, P4-5) is recomputed from the stored human outbound messages:
   * a Dana message read back before its key arrived was stamped as a human one, and must not
   * leave the clock stamped.
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
      const existing = prep('SELECT lead_id, ts, sender_kind FROM wa_messages WHERE key_id = ?').get(String(key_id));
      prep(`INSERT INTO wa_messages (key_id, lead_id, jid, direction, sender_kind, sender_user_id, text, media_type, ts, status)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(key_id) DO UPDATE SET
              sender_kind = CASE WHEN sender_kind = 'owner_number' AND excluded.sender_kind IN ('staff','dana') THEN excluded.sender_kind ELSE sender_kind END,
              sender_user_id = CASE WHEN sender_kind = 'owner_number' AND excluded.sender_kind IN ('staff','dana') THEN excluded.sender_user_id ELSE sender_user_id END,
              status = COALESCE(excluded.status, status)`)
        .run(String(key_id), String(lead_id), str(jid), direction, sender_kind, str(sender_user_id), capText(text), str(media_type), toTs(ts), str(status));
      const at = existing ?? { lead_id: String(lead_id), ts: toTs(ts) };
      prep('UPDATE leads SET last_msg_ts = MAX(COALESCE(last_msg_ts, 0), ?) WHERE lead_id = ?').run(at.ts, at.lead_id);
      if (!existing) bump(lead_id);
      if (existing?.sender_kind === 'owner_number' && (sender_kind === 'staff' || sender_kind === 'dana')) {
        prep(`UPDATE leads SET last_human_out_ts = (SELECT MAX(m.ts) FROM wa_messages m WHERE m.lead_id = ? AND m.direction = 'out'
                AND m.sender_kind IN ('staff','owner_number')) WHERE lead_id = ?`).run(existing.lead_id, existing.lead_id);
      }
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
  /**
   * The chat's revision: a whole number kept on its lead row (`leads.chat_rev`) that goes up
   * by one, in the same transaction as the write, whenever something a person must see
   * before answering is written to the chat's thread — a message stored for the first time
   * (either direction, whatever its WhatsApp timestamp), a staff or Dana send of any status
   * (one still on its way, or "not sure it went"), such a send leaving `pending`
   * (`updateOutbox` to accepted, uncertain or failed, `markStalePending`: a page drawn while
   * it was on its way does not show what became of it, and "not sure it went" may mean the
   * client already has an answer) and a new gap ("a message could not be loaded") — and
   * whenever rows are taken out of it: `purgeLead` (leaving the inbox, a team or never-list
   * number, the 5-year retention) and the retention purge's delete of old sends. A message
   * seen again (`upsertMessage`'s ON CONFLICT), a gap seen again, a send moving between
   * settled statuses or written again with the same one, a gap taken back (`clearGap`,
   * `clearJoinGaps`, or deleted when its message is stored after all, and the message then
   * counts), read marks and handlers leave it alone.
   *
   * The lead row is never deleted, so the number never goes down and is never handed out
   * twice: two reads that agree mean nothing it counts happened in between (short of
   * restoring the whole file from a backup). The reply form carries the revision its page
   * was drawn at, and the sender sends only while the chat is still at exactly that number
   * (lib/wa-send.mjs `reply`); anything else, lower or higher, is `stale`. Timestamps
   * cannot do this job: WhatsApp stamps whole seconds, a reply is stored at the second its
   * send started, and a message read late can carry any time at all. 0 for a lead that does
   * not exist.
   */
  const revision = (leadId) => prep('SELECT chat_rev FROM leads WHERE lead_id = ?').get(String(leadId ?? ''))?.chat_rev ?? 0;
  const hasMessages = (leadId) => Boolean(prep('SELECT 1 FROM wa_messages WHERE lead_id = ? LIMIT 1').get(String(leadId ?? '')));
  /** Every stored message of one chat, both directions. */
  const countMessages = (leadId) => prep('SELECT COUNT(*) AS n FROM wa_messages WHERE lead_id = ?').get(String(leadId ?? '')).n;
  /**
   * How many of one chat's messages, both directions, are at or after this person's oldest
   * unread one (the rule `listInbox` counts by, P2-8); 0 with nothing unread. The newest
   * that many messages hold every unread one even when replies sit between them — a count
   * of the unread messages alone would not (P4).
   */
  function unreadSpan(leadId, { userId = null, userCreated = 0 } = {}) {
    const id = String(leadId ?? '');
    return prep(`SELECT COUNT(*) AS n FROM wa_messages m
                 WHERE m.lead_id = ?
                   AND m.ts >= (SELECT MIN(u.ts) FROM wa_messages u
                                 WHERE u.lead_id = ? AND u.direction = 'in'
                                   AND u.ts > COALESCE((SELECT r.last_read_ts FROM inbox_reads r WHERE r.user_id = ? AND r.lead_id = u.lead_id), ?))`)
      .get(id, id, str(userId), num(userCreated)).n;
  }
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
   * is left exactly as it is: a double submit gets the row the first submit made. A new
   * staff or Dana row of a chat moves that chat's revision on (`revision`).
   *
   * @returns {{ inserted: boolean, row: object }}
   */
  function insertOutbox({ send_id, lead_id = null, jid, text = null, user_id = null, sender_kind, status = 'pending', covers_ts = null } = {}) {
    if (!send_id) throw new RangeError('send_id is required');
    if (!jid) throw new RangeError('jid is required');
    if (!OUTBOX_KINDS.includes(sender_kind)) throw new RangeError(`unknown outbox kind ${sender_kind}`);
    if (!OUTBOX_STATUSES.includes(status)) throw new RangeError(`unknown outbox status ${status}`);
    const t = now();
    const stored = sender_kind === 'code' ? null : capText(text);
    const chatId = str(lead_id);
    return transaction(() => {
      const { changes } = prep(`INSERT OR IGNORE INTO wa_outbox (send_id, lead_id, jid, text, user_id, sender_kind, status, key_id, created, updated, error, covers_ts)
                                VALUES (?,?,?,?,?,?,?,NULL,?,?,NULL,?)`)
        .run(String(send_id), chatId, String(jid), stored, str(user_id), sender_kind, status, t, t, hasNumber(covers_ts) ? toTs(covers_ts) : null);
      if (changes === 1 && chatId !== null && (sender_kind === 'staff' || sender_kind === 'dana')) bump(chatId);
      return { inserted: changes === 1, row: getOutbox(send_id) };
    });
  }

  /**
   * `key_id`/`error` left out (undefined) are kept as they are; null clears them. A staff or
   * Dana row of a chat leaving `pending` moves that chat's revision on (`revision`), in the
   * same transaction.
   */
  function updateOutbox(sendId, { status, key_id = undefined, error = undefined } = {}) {
    if (!OUTBOX_STATUSES.includes(status)) throw new RangeError(`unknown outbox status ${status}`);
    const sets = ['status = ?', 'updated = ?'];
    const vals = [status, now()];
    if (key_id !== undefined) { sets.push('key_id = ?'); vals.push(str(key_id)); }
    if (error !== undefined) { sets.push('error = ?'); vals.push(error === null ? null : String(error).slice(0, MAX_ERROR)); }
    const id = String(sendId ?? '');
    vals.push(id);
    return transaction(() => {
      const before = prep('SELECT status, lead_id, sender_kind FROM wa_outbox WHERE send_id = ?').get(id);
      const updated = prep(`UPDATE wa_outbox SET ${sets.join(', ')} WHERE send_id = ?`).run(...vals).changes === 1;
      if (updated && before.status === 'pending' && status !== 'pending' && before.lead_id !== null
          && (before.sender_kind === 'staff' || before.sender_kind === 'dana')) bump(before.lead_id);
      return updated;
    });
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

  /**
   * A `pending` row this old belongs to a process that died mid-send: it may have gone. Every
   * chat with a staff or Dana row marked here moves its revision on by one (`revision`), in
   * the same transaction.
   */
  function markStalePending(beforeTs) {
    const cutoff = num(beforeTs);
    return transaction(() => {
      prep(`UPDATE leads SET chat_rev = chat_rev + 1
            WHERE lead_id IN (SELECT lead_id FROM wa_outbox
                              WHERE status = 'pending' AND created < ? AND sender_kind IN ('staff','dana') AND lead_id IS NOT NULL)`)
        .run(cutoff);
      return prep("UPDATE wa_outbox SET status = 'uncertain', error = 'interrupted', updated = ? WHERE status = 'pending' AND created < ?")
        .run(now(), cutoff).changes;
    });
  }

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

  /**
   * `in` chats with nothing stored yet (amendment A3): the chats migration v4 let in
   * without their history, or whose history was empty when they joined. The daily upkeep
   * (index.mjs `inboxMaintenance`) fetches for each what an automatic join would have
   * taken, oldest joiner first, so a long backlog is worked in the order it built up.
   *
   * Known limit: a chat that stays empty after its fetch — its history is empty or all
   * refused, or the retention purge emptied it (it stays `in`) — is on this list for good,
   * asked again every day, and as one of the oldest joiners it sorts first. Only once more
   * than `limit` (200) such chats pile up would a newly joined empty chat never be reached;
   * at 27 leads (2026-09-28) that is years away. The fix then is to remember when a chat
   * was last asked (a column, so it survives restarts) and put never-asked chats first.
   */
  function inChatsWithoutMessages({ limit = 200 } = {}) {
    return prep(`SELECT l.* FROM leads l
                 WHERE ${IN_CHAT} AND NOT EXISTS (SELECT 1 FROM wa_messages m WHERE m.lead_id = l.lead_id)
                 ORDER BY COALESCE(l.inbox_since, l.created) ASC, l.rowid ASC
                 LIMIT ?`)
      .all(clampLimit(limit, 200)).map(leadRow);
  }

  /**
   * Every `in` lead (a chat or not: a lead the owner moved in with no chat yet is swept
   * too, before it ever gets one) and every lead on the Unsure list, with only what the exclusion test
   * reads. The daily upkeep puts out any whose number is a colleague's or on the never list
   * (index.mjs `inboxMaintenance`). No limit: a sweep that stopped part-way would leave the
   * rest listed.
   */
  const listedLeads = () => prep(`SELECT l.lead_id, l.phone_e164, l.wa_jid, l.wa_lid, l.inbox_state FROM leads l
                                  WHERE l.inbox_state = 'in' OR (${UNSURE_CHAT})
                                  ORDER BY l.rowid ASC`).all().map(plain);

  /* -------------------- gaps -------------------- */

  /**
   * A message that could not be read, shown in the thread instead of silently missing. A new
   * gap of a chat moves its revision on (`revision`), in the same transaction: "a message
   * could not be loaded" is a line a replier must see. One already there writes nothing.
   */
  function addGap({ key_id, lead_id, jid = null, ts, reason } = {}) {
    if (!key_id) throw new RangeError('key_id is required');
    const chatId = str(lead_id);
    return transaction(() => {
      const { changes } = prep('INSERT OR IGNORE INTO wa_gaps (key_id, lead_id, jid, ts, reason) VALUES (?,?,?,?,?)')
        .run(String(key_id), chatId, str(jid), hasNumber(ts) ? toTs(ts) : null, reason === null || reason === undefined ? null : String(reason).slice(0, MAX_ERROR));
      if (changes === 1 && chatId !== null) bump(chatId);
      return changes === 1;
    });
  }

  const gapsFor = (leadId) => prep('SELECT * FROM wa_gaps WHERE lead_id = ? ORDER BY ts ASC, rowid ASC').all(String(leadId ?? '')).map(plain);

  /**
   * Take back one gap, by its key: the daily catch-up's `history_failed` gap once a later
   * read of that chat's whole window came back clean (index.mjs `inboxMaintenance`). A
   * message stored after all clears its own `failed` gap in `upsertMessage` instead.
   */
  const clearGap = (keyId) => (keyId ? prep('DELETE FROM wa_gaps WHERE key_id = ?').run(String(keyId)).changes === 1 : false);

  /**
   * Take back every `history_failed` gap a join of this chat left (keyed `join:<lead>:…` by
   * the poller's join and the daily catch-up), once a later per-chat read covered the whole
   * join window (lib/inbox/backfill.mjs). Never a `failed` gap: that one is a message id,
   * and only the message itself, stored after all, clears it (`upsertMessage`).
   * @returns {number} how many were taken back
   */
  function clearJoinGaps(leadId) {
    const id = String(leadId ?? '');
    if (!id) return 0;
    const prefix = `join:${id}:`;
    return prep(`DELETE FROM wa_gaps WHERE lead_id = ? AND reason = 'history_failed' AND substr(key_id, 1, ?) = ?`)
      .run(id, prefix.length, prefix).changes;
  }

  /* -------------------- inbox columns on the lead -------------------- */

  /**
   * Joining keeps the time a chat first joined and the history floor it joined with: a chat
   * already `in` keeps its `inbox_since` and `history_from` (one still missing either gets
   * `since` / `historyFrom`). `historyFrom` is how far back this chat's messages may be
   * stored (lib/inbox/ingest.mjs refuses anything older): the caller's join rule decides it,
   * and without one it is the 24 h before `since` that an automatic join keeps, so no join
   * is ever without a floor. Leaving — `out` or back to `unsure` — clears both.
   */
  function setInboxState(leadId, state, { since = now(), historyFrom = null } = {}) {
    if (!INBOX_STATES.includes(state)) throw new RangeError(`unknown inbox state ${state}`);
    const t = now();
    const id = String(leadId ?? '');
    if (state === 'in') {
      const at = hasNumber(since) ? toTs(since) : t;
      const floor = hasNumber(historyFrom) ? toTs(historyFrom) : at - JOIN_HISTORY_MS;
      return prep(`UPDATE leads SET
                     inbox_since = CASE WHEN inbox_state = 'in' THEN COALESCE(inbox_since, ?) ELSE ? END,
                     history_from = CASE WHEN inbox_state = 'in' THEN COALESCE(history_from, ?) ELSE ? END,
                     inbox_state = 'in', updated = ?
                   WHERE lead_id = ?`)
        .run(at, at, floor, floor, t, id).changes === 1;
    }
    return prep('UPDATE leads SET inbox_state = ?, inbox_since = NULL, history_from = NULL, updated = ? WHERE lead_id = ?').run(state, t, id).changes === 1;
  }

  /** `userId` null clears it. Who may be a handler is the caller's check (an active user). */
  const setHandler = (leadId, userId) => prep('UPDATE leads SET handler_user_id = ? WHERE lead_id = ?')
    .run(userId ? String(userId) : null, String(leadId ?? '')).changes === 1;

  const setNeedsHuman = (leadId, flag) => prep('UPDATE leads SET needs_human = ? WHERE lead_id = ?')
    .run(flag ? 1 : 0, String(leadId ?? '')).changes === 1;

  /**
   * When a human — a team member's reply, the owner's phone, Lisa — last wrote to the client
   * (P4-5). Only ever forward: a history read brings old messages, and they must not make
   * Dana think the team fell silent long ago.
   */
  function noteHumanOutbound(leadId, ts) {
    // NaN would bind as NULL, and MAX(x, NULL) is NULL: that would reset the clock.
    if (!hasNumber(ts)) return false;
    return prep('UPDATE leads SET last_human_out_ts = MAX(COALESCE(last_human_out_ts, 0), ?) WHERE lead_id = ?')
      .run(toTs(ts), String(leadId ?? '')).changes === 1;
  }

  /**
   * Dana's sends since `sinceTs` — one chat's, or everyone's — counted from the outbox so a
   * restart cannot hand out a fresh hour or day (P4-6). A `failed` row sent nothing.
   */
  function countDanaSends({ leadId = null, sinceTs } = {}) {
    // A cap read must never fail open.
    if (!hasNumber(sinceTs)) throw new RangeError('sinceTs is required');
    return prep(`SELECT COUNT(*) AS n FROM wa_outbox WHERE sender_kind = 'dana' AND status <> 'failed' AND created >= ?
                   AND (? IS NULL OR lead_id = ?)`).get(toTs(sinceTs), str(leadId), str(leadId)).n;
  }

  /**
   * Has a person answered this chat after `ts`? A stored staff/owner message stamped later,
   * or a team member's reply still on its way (P4-13: Dana drops her answer then).
   */
  function humanOutboundAfter(leadId, ts) {
    const id = String(leadId ?? '');
    const t = toTs(ts);
    return Boolean(prep(`SELECT 1 FROM wa_messages WHERE lead_id = ? AND direction = 'out' AND sender_kind IN ('staff','owner_number') AND ts > ? LIMIT 1`).get(id, t))
      || Boolean(prep(`SELECT 1 FROM wa_outbox WHERE lead_id = ? AND sender_kind = 'staff' AND status <> 'failed' AND created > ? LIMIT 1`).get(id, t));
  }

  /**
   * What Dana has not answered yet (P4-7): the chat's client messages newer than the newest
   * stored HUMAN outbound (staff/owner_number) and newer than what the newest staff/Dana send
   * in the outbox, not failed, answered — Dana's `covers_ts` (the newest client message of
   * her batch, written with her row before the call), a staff row's `created` (a send on its
   * way is an answer; one that failed is not). Dana's own stored message never bounds it —
   * her row does, through `covers_ts` — so a client message stamped while she composed stays
   * unanswered. A message stamped the same second as the newest one she answered counts as
   * answered (WhatsApp stamps whole seconds; `>=` would re-answer her own batch). The newest
   * `limit`, returned oldest first.
   */
  function unansweredClientMessages(leadId, { limit = 10 } = {}) {
    const id = String(leadId ?? '');
    return prep(`SELECT * FROM wa_messages WHERE lead_id = ? AND direction = 'in'
                   AND ts > COALESCE((SELECT MAX(o.ts) FROM wa_messages o WHERE o.lead_id = ? AND o.direction = 'out' AND o.sender_kind IN ('staff','owner_number')), 0)
                   AND ts > COALESCE((SELECT MAX(COALESCE(x.covers_ts, x.created)) FROM wa_outbox x WHERE x.lead_id = ? AND x.sender_kind IN ('staff','dana') AND x.status <> 'failed'), 0)
                 ORDER BY ts DESC, rowid DESC LIMIT ?`).all(id, id, id, clampLimit(limit, 10)).map(plain).reverse();
  }

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
   * The chat's revision moves on (`revision`), so no page drawn before the purge matches
   * one drawn after it, however the thread fills again.
   *
   * Dana's Retell chat and her introduction are forgotten too (`dana_chat_id`, `dana_chat_ts`,
   * `dana_introduced`): a chat that comes back is a fresh conversation, and she introduces
   * herself again (P4-12).
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
      prep('UPDATE leads SET dana_chat_id = NULL, dana_chat_ts = NULL, dana_introduced = 0 WHERE lead_id = ?').run(id);
      bump(id);
      return counts;
    });
  }

  /**
   * *Not a client*: out of the inbox, transcript gone, nobody handling it, nothing
   * pending, both of Dana's per-chat switches back to 0 (P4-4) — all or nothing, so a failure half-way never leaves a purged chat `in`.
   */
  function leaveInbox(leadId) {
    return transaction(() => {
      setInboxState(leadId, 'out');
      const counts = purgeLead(leadId);
      prep('UPDATE leads SET handler_user_id = NULL, needs_human = 0, dana_off = 0, dana_test = 0 WHERE lead_id = ?').run(String(leadId ?? ''));
      return counts;
    });
  }

  /**
   * D11: the transcript of every chat whose last message is older than `beforeTs`. Lead
   * rows stay. A chat with nothing left to delete is not counted.
   *
   * A staff or Dana send carries text too, and it is not always a message: a reply that
   * failed, or one never read back, is only its outbox row. So a chat with no stored
   * message at all (none ever, or it left the inbox) loses its staff and Dana sends older
   * than `beforeTs` as well, whatever their status. A chat that still has messages keeps
   * its sends with them until its last message is older than the cutoff. Login-code rows
   * hold no text; `pruneCodeRows` removes them. `outbox` counts every send row removed.
   * Every chat that loses a row moves its revision on (`revision`): the purged ones through
   * `purgeLead`, the ones that lose only sends here.
   *
   * @returns {{ leads: number, messages: number, outbox: number }}
   */
  function retentionPurge(beforeTs) {
    return transaction(() => {
      const cutoff = num(beforeTs);
      const ids = prep(`SELECT lead_id FROM leads
                        WHERE last_msg_ts < ? AND EXISTS (SELECT 1 FROM wa_messages m WHERE m.lead_id = leads.lead_id)`)
        .all(cutoff).map((r) => r.lead_id);
      let messages = 0;
      let outbox = 0;
      for (const id of ids) {
        const purged = purgeLead(id);
        messages += purged.messages;
        outbox += purged.outbox;
      }
      const due = `sender_kind IN ('staff','dana') AND created < ?
                   AND NOT EXISTS (SELECT 1 FROM wa_messages m WHERE m.lead_id = wa_outbox.lead_id)`;
      prep(`UPDATE leads SET chat_rev = chat_rev + 1
            WHERE lead_id IN (SELECT lead_id FROM wa_outbox WHERE lead_id IS NOT NULL AND ${due})`).run(cutoff);
      outbox += prep(`DELETE FROM wa_outbox WHERE ${due}`).run(cutoff).changes;
      return { leads: ids.length, messages, outbox };
    });
  }

  /* -------------------- real-estate chats to check (D17) -------------------- */
  //
  // A chat that used property words (lib/inbox/eligibility.mjs `propertyWordsIn`) but gave
  // no sure sign it is about Bona: not a lead, never shown to staff, and never its words —
  // only who, when, how often, which property words and who wrote last.

  const idOf = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const nameOf = (v) => {
    if (typeof v !== 'string') return null;
    return Array.from(v.replace(/\s+/g, ' ').trim()).slice(0, MAX_CANDIDATE_NAME).join('') || null;
  };
  /** Strings only, no commas (the column is comma-joined), each once, at most `MAX_PROPERTY_WORDS`. */
  function wordsOf(list) {
    const out = [];
    for (const w of Array.isArray(list) ? list : []) {
      const v = typeof w === 'string' ? w.replace(/,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
      if (v && !out.includes(v)) out.push(v);
      if (out.length === MAX_PROPERTY_WORDS) break;
    }
    return out;
  }
  const splitWords = (v) => (typeof v === 'string' && v ? v.split(',') : []);
  const candidateRow = (row) => (row ? { ...row, words: splitWords(row.words) } : null);

  /** One chat's row: by number first, then jid, then lid. */
  function findCandidate({ phone, jid, lid }) {
    return (phone ? prep('SELECT * FROM inbox_candidates WHERE phone_e164 = ?').get(phone) : null)
      ?? (jid ? prep('SELECT * FROM inbox_candidates WHERE jid = ?').get(jid) : null)
      ?? (lid ? prep('SELECT * FROM inbox_candidates WHERE lid = ?').get(lid) : null)
      ?? null;
  }

  /**
   * One more property message from a chat that is not a lead. A new chat gets a row; an
   * open row counts it (`hits`), moves `last_ts` forward, adds the words (at most 8), fills
   * a number, jid, lid or name it did not have yet (never one another row holds: each is
   * UNIQUE) and says who wrote last. A dismissed row is left exactly as it is: the owner
   * said "Not a client", and a later message does not ask him again.
   *
   * @returns {{ state: 'open'|'dismissed', cand_id: string, created: boolean }}
   */
  function noteCandidate({ jid = null, lid = null, phone = null, name = null, ts, words = [], dir } = {}) {
    const ids = { phone: idOf(phone), jid: idOf(jid), lid: idOf(lid) };
    if (!ids.phone && !ids.jid && !ids.lid) throw new RangeError('a candidate needs a phone, jid or lid');
    if (!hasNumber(ts)) throw new RangeError('ts is required');
    if (!DIRECTIONS.includes(dir)) throw new RangeError(`unknown direction ${dir}`);
    const at = toTs(ts);
    const said = wordsOf(words);
    const who = nameOf(name);
    return transaction(() => {
      const found = findCandidate(ids);
      if (found?.state === 'dismissed') return { state: 'dismissed', cand_id: found.cand_id, created: false };
      if (found) {
        const free = (col, v) => (found[col] || !v || prep(`SELECT 1 FROM inbox_candidates WHERE ${col} = ?`).get(v) ? found[col] : v);
        const all = wordsOf([...splitWords(found.words), ...said]);
        prep(`UPDATE inbox_candidates SET phone_e164 = ?, jid = ?, lid = ?, name = COALESCE(name, ?),
                first_ts = MIN(first_ts, ?), last_dir = CASE WHEN ? >= last_ts THEN ? ELSE last_dir END,
                last_ts = MAX(last_ts, ?), hits = hits + 1, words = ?, updated = ?
              WHERE cand_id = ?`)
          .run(free('phone_e164', ids.phone), free('jid', ids.jid), free('lid', ids.lid), who,
            at, at, dir, at, all.join(',') || null, now(), found.cand_id);
        return { state: 'open', cand_id: found.cand_id, created: false };
      }
      const candId = newId('CND');
      prep(`INSERT INTO inbox_candidates (cand_id, jid, lid, phone_e164, name, first_ts, last_ts, hits, words, last_dir, state, updated)
            VALUES (?,?,?,?,?,?,?,1,?,?,'open',?)`)
        .run(candId, ids.jid, ids.lid, ids.phone, who, at, at, said.join(',') || null, dir, now());
      return { state: 'open', cand_id: candId, created: true };
    });
  }

  /**
   * Open rows whose chat is not a lead by now: no lead holds the candidate's number, jid or
   * lid (a web form or *Add chat* may have made one since it was noted, and that lead's own
   * inbox state decides the chat). In SQL, so a hidden row never takes a listed one's place.
   */
  const OPEN_NOT_A_LEAD = `c.state = 'open' AND NOT EXISTS (
      SELECT 1 FROM leads l WHERE l.phone_e164 = c.phone_e164 OR l.wa_jid IN (c.jid, c.lid) OR l.wa_lid IN (c.jid, c.lid))`;

  /** The owner's list: open rows of chats that are not leads, the latest message first. `words` comes back as an array. */
  function listCandidates({ limit = 200 } = {}) {
    return prep(`SELECT c.* FROM inbox_candidates c WHERE ${OPEN_NOT_A_LEAD} ORDER BY c.last_ts DESC, c.rowid DESC LIMIT ?`)
      .all(clampLimit(limit, 200)).map(candidateRow);
  }

  /**
   * How many rows `listCandidates` would list with no limit — the store's raw count, with no
   * cap and no team check. Not for the Unsure tab's label: that counts the rows the tab
   * shows, `candidatesShown()` in lib/dashboard/routes.mjs (at most 200, colleagues and
   * never-list numbers left out), so the label and the list never disagree.
   */
  const countCandidates = () => prep(`SELECT COUNT(*) AS n FROM inbox_candidates c WHERE ${OPEN_NOT_A_LEAD}`).get().n;
  const getCandidate = (candId) => candidateRow(prep('SELECT * FROM inbox_candidates WHERE cand_id = ?').get(String(candId ?? '')));

  /**
   * *Not a client*: the row stays only so the chat is not listed again, so everything but
   * its ids goes now — the name, the words, the count, who wrote last, and the times (both
   * become the moment of the dismissal). An unknown or already dismissed id is `false`.
   */
  function dismissCandidate(candId) {
    const t = now();
    return prep(`UPDATE inbox_candidates SET state = 'dismissed', name = NULL, words = NULL, hits = 0, last_dir = NULL,
                   first_ts = ?, last_ts = ?, updated = ?
                 WHERE cand_id = ? AND state = 'open'`).run(t, t, t, String(candId ?? '')).changes === 1;
  }

  const removeCandidate = (candId) => prep('DELETE FROM inbox_candidates WHERE cand_id = ?').run(String(candId ?? '')).changes === 1;

  /**
   * Every row of one chat, open or dismissed, by any of its ids: the chat became a lead (its
   * own inbox state rules from now on), or its number went on the never list. Returns how
   * many rows went.
   */
  function removeCandidatesFor({ phone = null, jid = null, lid = null } = {}) {
    const ids = [idOf(phone), idOf(jid), idOf(lid)];
    if (!ids.some(Boolean)) return 0;
    return prep('DELETE FROM inbox_candidates WHERE phone_e164 = ? OR jid = ? OR lid = ?').run(...ids).changes;
  }

  /**
   * Open rows whose last property message is older than `openBefore`, and dismissed rows
   * dismissed before `dismissedBefore`. Exactly at a cutoff is not older than it; a cutoff
   * that is not a number deletes nothing.
   *
   * @returns {{ open: number, dismissed: number }}
   */
  function pruneCandidates({ openBefore, dismissedBefore } = {}) {
    return transaction(() => ({
      open: prep("DELETE FROM inbox_candidates WHERE state = 'open' AND last_ts < ?").run(num(openBefore)).changes,
      dismissed: prep("DELETE FROM inbox_candidates WHERE state = 'dismissed' AND updated < ?").run(num(dismissedBefore)).changes,
    }));
  }

  return {
    upsertMessage, messagesFor, newestTs, revision, hasMessages, countMessages, unreadSpan, messageByKey,
    insertOutbox, getOutbox, outboxByKey, updateOutbox, resolveUncertain, openOutboxFor, countSentSince, markStalePending, pruneCodeRows,
    markRead, listInbox, unreadTotal, listUnsure, countUnsure, inChatsWithoutMessages, listedLeads,
    addGap, gapsFor, clearGap, clearJoinGaps,
    setInboxState, setHandler, setNeedsHuman, noteHumanOutbound, countDanaSends, humanOutboundAfter, unansweredClientMessages,
    purgeLead, leaveInbox, retentionPurge,
    noteCandidate, listCandidates, countCandidates, getCandidate, dismissCandidate, removeCandidate, removeCandidatesFor, pruneCandidates,
  };
}
