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
 *     (a lid-only chat first shows whose it is there) — except the owner's own number as a
 *     sent record's alt, which names the sender, not the chat. That number is the instance's
 *     own (`ownerPhone`), not read from the owner's account, so it is still known while his
 *     row is deactivated or demoted. Such a record stores nothing.
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
 *   - a lead learns its lid, phone jid and phone from a record it RECEIVED, into empty
 *     fields only, from a record of its own chat only, and never a number another lead
 *     holds as a phone or as a phone jid.
 *
 * Nothing here logs text, a phone number, a lid or a name — ids and field names only.
 */
import { isCodeMessage } from '../dashboard/auth.mjs';
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
 * out: lib/evolution.mjs folds `key.senderPn` into `jidAlt`, and there it names the sender.
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
 *        from `BONA_OWNER_JID`): a sent record's alt that is this number names the sender, not
 *        the chat. Left out, it is read from the `ownerUserId` account, which a deactivated or
 *        demoted owner row no longer yields
 * @param {((lead: object) => boolean)|null} [o.isExcludedLead] true for a chat that is never a
 *        client's; defaults to lib/team.mjs `isExcludedLead` over the team and never-list
 *        tables in `db`. Called with per-identifier views of a lead, so it must decide from
 *        the `phone_e164`, `wa_jid` and `wa_lid` it is handed, never by re-reading the row
 * @param {(e: object) => void} [o.log]
 * @param {() => number} [o.now]
 */
export function createIngest({
  db, inbox, ownerUserId = () => null, ownerPhone = null, isExcludedLead = null, log = () => {}, now = () => Date.now(),
} = {}) {
  if (!db || !inbox) throw new TypeError('createIngest needs the store and the inbox store');
  // `createTeam` only prepares statements when they are first used: this instance costs nothing.
  const team = createTeam(db);
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
   * written in the last two minutes would match a record that could be days old. `byKey` is
   * the row the caller already looked up by the record's id.
   */
  function outboxRowFor(leadId, rec, body, ts, byKey) {
    if (byKey) return { row: byKey, via: 'key' };
    if (!body || !Number.isFinite(rec.ts) || inbox.messageByKey(rec.id)) return null;
    const byText = inbox.resolveUncertain({ leadId, text: body, ts, windowMs: RESOLVE_WINDOW_MS });
    return byText && ts >= byText.created - SEND_SKEW_MS ? { row: byText, via: 'text' } : null;
  }

  /**
   * What the lead may learn from a record it received: its empty lid / phone jid / phone. Not
   * from one we sent: lib/evolution.mjs folds `key.senderPn` into the same `jidAlt`, and on an
   * outbound record that can be our own number — the same caution as the poller's team
   * pairing. Only from a record of the row's own chat (`sameChat`). Never a value another
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
   * @returns {{ stored: false, reason: 'not_in_inbox'|'excluded'|'no_id'|'noise'|'before_floor'|'code' }
   *          | { stored: true, inserted: boolean, senderKind: 'client'|'staff'|'dana'|'owner_number' }}
   */
  function ingest(lead, rec) {
    const leadId = lead?.lead_id ?? null;
    return db.transaction(() => {
      const current = leadId ? db.getLead(leadId) : null;
      if (current?.inbox_state !== 'in') return { stored: false, reason: 'not_in_inbox' };
      if (isExcluded(current)) return { stored: false, reason: 'excluded' };
      if (!rec?.id) return { stored: false, reason: 'no_id' };
      if (rec.noise) return { stored: false, reason: 'noise' };
      if (Number.isFinite(rec.ts) && Number.isFinite(current.history_from) && rec.ts < current.history_from) {
        return { stored: false, reason: 'before_floor' };
      }
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
      const byKey = inbox.outboxByKey(rec.id);
      if (byKey?.sender_kind === 'code') return { stored: false, reason: 'code' };

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
        senderKind = kind === 'staff' || kind === 'dana' ? kind : 'owner_number';
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
      }

      if (inserted && HUMAN_SENDERS.has(senderKind)) {
        if (current.needs_human) inbox.setNeedsHuman(current.lead_id, 0);
        if (!current.handler_user_id) {
          const handler = senderKind === 'staff' ? senderUserId : ownerUserId();
          if (handler) inbox.setHandler(current.lead_id, handler);
        }
      }
      return { stored: true, inserted, senderKind };
    });
  }

  return { ingest };
}
