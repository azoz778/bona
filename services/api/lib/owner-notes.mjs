/**
 * The owner's WhatsApp notes (DESIGN §7). STUB (PR-F2b): it keeps today's behaviour. PR-B2
 * (task T11) replaces this file with the ledger (`owner_notes`), the pacing, the kinds and the
 * daily summary; the interface below is the seam it fills.
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
 * Only index.mjs's form path calls it in this PR; the poller and the concierge tool still send
 * their own copy until their files move to it (PR-A1, PR-B4). Every other method is a no-op:
 * no hand-over, booking, stopped, alert, mail or command note is sent today.
 *
 * `sendNote(text)` is the transport, and the only one: index.mjs hands in its `sendWhatsApp`
 * (the one given to createApp when there is one, else lib/wa.mjs `sendText` to the owner's chat
 * and only there), the very function the form path called at 13e4954. It answers `{ ok, error? }`,
 * and that answer stands: nothing here tries a second way. So this PR is inert for the form's
 * note: no Sending switch, no per-minute limit, no length cap and no outbox row, as today.
 *
 * For T11 (PR-B2), the rollout decision on PR-F2b (Codex r1b #1 against r2 P1): moving the
 * form's note onto the one sender's kind 'note' (lib/wa-send.mjs: the owner's jid only, its own
 * `note:to:` limit, a row without text or lead) is T11's change, made together with the ledger,
 * so that a note the one sender refuses for now (Sending off, its minute used up) is held and
 * sent later (receipt `pending`), never lost and never sent around the gate. The kind is in
 * place and no production caller uses it yet.
 * Nothing here logs a note's text, a name or a number: ids and error codes only.
 */
import { leadNote } from './leads.mjs';

/** How long the form request waits for its note (today's index.mjs value). */
export const FORM_NOTIFY_WAIT_MS = 4000;

/**
 * @typedef {object} OwnerNotes
 * @property {(lead: object, o: { why: string, created?: boolean, eventId?: string|null }) => Promise<void>} leadEvent
 * @property {(lead: object, o: { kind: string, coversTs?: number }) => void} handover   (stub: nothing)
 * @property {(bookingId: string, o: { told: boolean }) => void} booking               (stub: nothing)
 * @property {(lead: object, reason: string) => void} stopped                           (stub: nothing)
 * @property {(code: string, meta?: object) => void} alert                              (stub: nothing)
 * @property {(item: object) => void} mail                                              (stub: nothing)
 * @property {(recId: string, text: string) => void} command                            (stub: nothing)
 * @property {(leadId: string) => void} onPurge   inside purgeLead's transaction (store.mjs `onPurge`); rows only, no network (stub: nothing)
 * @property {() => Promise<void>|void} tick      the queue's timer step (stub: nothing)
 * @property {() => { enabled: boolean, ok: boolean }} health  the /health `notes` keys
 */

/**
 * @param {{ db?: object|null, siteUrl?: string, sendNote?: ((text: string) => Promise<{ ok?: boolean, error?: string }>)|null,
 *           log?: Function, formWaitMs?: number }} [o]
 * @returns {OwnerNotes}
 */
export function createOwnerNotes({
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
    // Today's new-enquiry note goes at once, with no queue behind it: nothing can be stuck.
    health: () => ({ enabled: true, ok: true }),
  };
}
