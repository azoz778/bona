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
 *     the row came to be `in` — a Ref lead from before its number joined the team, say. The
 *     check is made here, not left to each caller: the poller screens its records, but a
 *     per-chat read (join history, catch-up, refresh) goes straight to a lead. The numbers a
 *     received record shows are checked too: a lid-only chat first shows its phone there.
 *   - a record with no id cannot be de-duplicated, and noise — reactions, deletes and edits,
 *     poll votes, key-distribution records — is never a bubble (P2-14). Neither is stored.
 *   - a login code the sender sent is never stored (§4.2: the code lives only in the WhatsApp
 *     message). Its outbox row keeps the message id for the day's count, so the record is
 *     recognised by that id and refused before anything is written.
 *   - who sent an outbound record (P2-17). The dashboard's own sends are found by the
 *     WhatsApp message id their send came back with. A send that never came back
 *     (`uncertain`, or `pending` when a restart cut it off) is found by its exact text within
 *     two minutes, anywhere in the LEAD's chat — the reply went to the phone jid, but
 *     Evolution may file the record under the chat's `@lid`. Anything else was typed on the
 *     owner's phone or sent by Lisa for him, which cannot be told apart: `owner_number`.
 *   - a human outbound seen for the first time clears "needs a human" (P2-16) and gives a
 *     chat nobody handles a handler (P2-15): the staff member who replied, or the owner for
 *     his own number. Only the first time — a refresh reads old records again, and must not
 *     undo a later "needs a human" or somebody's reassignment of the chat to nobody.
 *   - a lead learns its lid, phone jid and phone from a record it RECEIVED, into empty
 *     fields only.
 *
 * Nothing here logs text, a phone number, a lid or a name — ids and field names only.
 */
import { createTeam, isTeamLid } from '../team.mjs';
import { jidsOf } from '../wa-poller.mjs';

/** How far apart an unconfirmed send and the record that confirms it may be (P2-17). */
export const RESOLVE_WINDOW_MS = 120_000;

/** Outbound senders that are a person answering — as opposed to Dana. */
const HUMAN_SENDERS = new Set(['staff', 'owner_number']);

/**
 * A team member's or a never-list number, however the lead row holds it: its phone, the
 * number in its phone jid, or a lid the poller learned for a team member. `createTeam` only
 * prepares statements when they are first used, so this second instance costs nothing.
 */
function excludedByTeam(db) {
  const team = createTeam(db);
  return (lead) => team.isExcludedPhone(lead.phone_e164)
    || team.isExcludedPhone(jidsOf({ jid: lead.wa_jid }).phone)
    || isTeamLid(db, lead.wa_lid);
}

/**
 * The lead as an inbound record shows it: the record's lid, phone jid and phone over the
 * row's own. A lid-only chat read by its lid (join history, catch-up, refresh) first shows
 * whose it is in a record's alt, so that number is checked before anything is stored or
 * learned. Never for a record we sent: its alt can be the owner's own number, a team number.
 */
function shownBy(lead, rec) {
  const { phone, waJid, waLid } = jidsOf(rec);
  return { ...lead, phone_e164: phone ?? lead.phone_e164, wa_jid: waJid ?? lead.wa_jid, wa_lid: waLid ?? lead.wa_lid };
}

/**
 * @param {object} o
 * @param {ReturnType<import('../db.mjs').openDb>} o.db
 * @param {ReturnType<import('./store.mjs').createInboxStore>} o.inbox
 * @param {() => string|null} [o.ownerUserId] the env owner's `users.user_id`: the handler of a
 *        chat his own phone answers first
 * @param {((lead: object) => boolean)|null} [o.isExcludedLead] true for a chat that is never a
 *        client's; defaults to the team and never-list tables in `db`
 * @param {(e: object) => void} [o.log]
 * @param {() => number} [o.now]
 */
export function createIngest({
  db, inbox, ownerUserId = () => null, isExcludedLead = null, log = () => {}, now = () => Date.now(),
} = {}) {
  if (!db || !inbox) throw new TypeError('createIngest needs the store and the inbox store');
  const isExcluded = isExcludedLead ?? excludedByTeam(db);

  /** The outbox row an outbound record is, when the dashboard sent it; `via` says how it was found. */
  function outboxRowFor(leadId, rec, body, ts) {
    const byKey = inbox.outboxByKey(rec.id);
    if (byKey) return { row: byKey, via: 'key' };
    if (!body) return null;
    const byText = inbox.resolveUncertain({ leadId, text: body, ts, windowMs: RESOLVE_WINDOW_MS });
    return byText ? { row: byText, via: 'text' } : null;
  }

  /**
   * Fill the lead's empty lid / phone jid / phone from a record it received. Not from one we
   * sent: lib/evolution.mjs folds `key.senderPn` into the same `jidAlt`, and on an outbound
   * record that can be our own number — the same caution as the poller's team pairing. Never
   * a value another lead already holds: `phone_e164` is unique, and two leads on one jid would
   * make every later lookup by that jid a coin toss.
   */
  function learn(lead, rec) {
    const { phone, waJid, waLid } = jidsOf(rec);
    const free = (holder) => !holder || holder.lead_id === lead.lead_id;
    const patch = {};
    if (waLid && !lead.wa_lid && free(db.getLeadByJid(waLid))) patch.wa_lid = waLid;
    if (waJid && !lead.wa_jid && free(db.getLeadByJid(waJid))) patch.wa_jid = waJid;
    if (phone && !lead.phone_e164 && free(db.getLeadByPhone(phone))) patch.phone_e164 = phone;
    const fields = Object.keys(patch);
    if (!fields.length) return;
    db.updateLead(lead.lead_id, { ...patch, updated: now() });
    log({ evt: 'inbox.learned', leadId: lead.lead_id, fields });
  }

  /**
   * @param {object|null} lead  a `leads` row; only its `lead_id` is trusted, the row is read again
   * @param {import('../evolution.mjs').NormalisedRecord} rec
   * @returns {{ stored: false, reason: 'not_in_inbox'|'excluded'|'no_id'|'noise'|'code' }
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
      if (!rec.fromMe && isExcluded(shownBy(current, rec))) return { stored: false, reason: 'excluded' };

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
        match = outboxRowFor(current.lead_id, rec, body, ts);
        // Refused before anything is written, the row's status included.
        if (match?.row.sender_kind === 'code') return { stored: false, reason: 'code' };
        const kind = match?.row.sender_kind;
        senderKind = kind === 'staff' || kind === 'dana' ? kind : 'owner_number';
        senderUserId = senderKind === 'owner_number' ? null : (match.row.user_id ?? null);
      } else {
        learn(current, rec);
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
