/**
 * What the assistant's answer becomes once preSend has passed (DESIGN §4.3 "commit after preSend",
 * §8.3; PLAN T13, PR-B4). It replaces the PR-F2b stub behind the same seam: PR-B3 (T12, lib/dana-wa.mjs)
 * calls `afterPreSend` after preSend passes and sends the bubbles it answers, in order (text, then
 * any document), then calls `afterSend` once the confirmation bubble's send has an answer.
 *
 * `turn` is the brain's turn (lib/brain.mjs `turn()`: `toolCalls:[{name, args, result, ok}]`), or the
 * Retell completion for a legacy lead until PR-RX (T27) removes that path (the same calls as Retell-shaped
 * `tool_call_invocation` / `tool_call_result` messages). The tools only read, validate or save needs;
 * everything that is sent or booked is done here, from the SAME turn's calls and results (no intent store,
 * no held rows: nothing of a dropped turn is ever committed later):
 *   - book_viewing: the LAST invocation whose result says `reserved: true` → viewing.commitBooking(); ok →
 *     the code-built confirmation REPLACES the model's text (only code states a booked time); a failure →
 *     BOOKING_FAILED_LINE and a `booking_failed` hand-over for the caller (non-sticky);
 *   - send_brochure with `will_send: 'pdf'` → a document bubble after the text, its URL read again from the
 *     inventory (never the model's string), never a held brochure (BLOCKED_BROCHURES);
 *   - send_location with `precision: 'exact'` (and an exact pin in the inventory) → a maps link at the end of
 *     the text, only while the text has fewer than MAX_LINKS links and not with a booking (the confirmation
 *     carries its own);
 *   - the safety net: a brain answer that claims a booking (reply-guard claimsBooking: booked, confirmed,
 *     تم الحجز, تم تأكيد …) with no successful commit → BOOKING_FAILED_LINE and the hand-over. Only on a brain
 *     turn: a legacy Retell completion has no booking tool and keeps today's behaviour (the same-release rule).
 * The hand-over itself (needs_human, the alert, notes.handover) stays dana-wa's: `afterPreSend` answers it as
 * `handover: { kind }`, and dana-wa applies it as any other.
 *
 * After the send (`afterSend`, DESIGN §8.3 steps 8-9): the confirmation accepted → viewing.markTold and the
 * booking note (notes.booking told); not accepted (failed or uncertain) → the event stays, the "client NOT
 * told" note, and a `booking_unconfirmed` hand-over for the caller.
 *
 * INERT until a lead is in auto mode: the tools commit nothing outside it (they answer reserved:false,
 * will_send:false, precision none), and before D1 only the owner's test chat is answered by the brain.
 * Logs carry lead ids, booking ids and codes only, never the text.
 */
import { claimsBooking } from './reply-guard.mjs';
import { exactListing, pinOf } from './inventory.mjs';
import { BLOCKED_BROCHURES } from './tools.mjs';
import { MAX_LINKS } from './dana-wa.mjs';

/** Instead of a model text, when a booking could not be made or was claimed without one (DESIGN §4.3, §8.3 step 5). */
export const BOOKING_FAILED_LINE = Object.freeze({
  en: 'Thank you — the Bona team will confirm a time for your viewing with you here.',
  ar: 'شكراً لك، فريق بونا بيأكد معك موعد المعاينة هنا.',
});
/** Brochure documents one answer may carry (one per home asked for). */
export const MAX_DOCUMENTS = 2;

const LINK_RE = /https?:\/\/[^\s<>"'`]+/giu;

/** A tool result or arguments as an object: JSON parsed once or twice (a Retell result may be encoded twice). */
function parsed(v) {
  let x = v;
  for (let i = 0; i < 2 && typeof x === 'string'; i += 1) {
    try { x = JSON.parse(x); } catch { return null; }
  }
  return x && typeof x === 'object' ? x : null;
}

/**
 * The turn's tool calls, in order, as `{ name, args, result, ok }` (args `{}` and result `null` when
 * unreadable): the brain's `toolCalls`, else the Retell-shaped messages paired by `tool_call_id`.
 */
export function turnToolCalls(turn) {
  if (Array.isArray(turn?.toolCalls)) {
    return turn.toolCalls.filter((c) => c && typeof c.name === 'string')
      .map((c) => ({ name: c.name, args: parsed(c.args) ?? {}, result: parsed(c.result), ok: c.ok !== false }));
  }
  const messages = Array.isArray(turn?.messages) ? turn.messages : [];
  const results = new Map();
  for (const m of messages) if (m?.role === 'tool_call_result') results.set(m.tool_call_id, m.content);
  return messages.filter((m) => m?.role === 'tool_call_invocation' && typeof m.name === 'string')
    .map((m) => ({ name: m.name, args: parsed(m.arguments) ?? {}, result: parsed(results.get(m.tool_call_id)), ok: results.has(m.tool_call_id) }));
}

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const errClass = (err) => (err && typeof err === 'object' && typeof err.name === 'string' ? err.name : typeof err);

/**
 * @typedef {{ kind: 'text', text: string, bookingId?: string }
 *   | { kind: 'document', url: string, caption: string, fileName: string, mediaKind: 'document', listingId: string }} Bubble
 * @typedef {object} DanaCommit
 * @property {(o: { lead: object, turn: object, text: string, language: 'ar'|'en', coversTs?: number })
 *   => Promise<{ bubbles: Bubble[], booking?: { bookingId: string, listingId: string, startTs: number }, handover?: { kind: 'booking_failed' } }>} afterPreSend
 *   no tool call and no claim: exactly `{ bubbles: [{ kind: 'text', text }] }` (the stub's answer)
 * @property {(o: { lead: object, booking: { bookingId: string }|null, accepted: boolean })
 *   => Promise<{ told?: boolean, handover?: { kind: 'booking_unconfirmed' } }>} afterSend
 */

/**
 * @param {{ viewing?: object, notes?: object, inventory?: object, sender?: object, maxLinks?: number,
 *           blockedBrochures?: string[], log?: Function }} [deps]  `sender` is unused: dana-wa sends the bubbles
 * @returns {DanaCommit}
 */
export function createDanaCommit(deps = {}) {
  const { viewing = null, notes = null, inventory = null, maxLinks = MAX_LINKS, log = () => {} } = deps;
  const blocked = new Set(deps.blockedBrochures ?? BLOCKED_BROCHURES);
  const exact = (ref) => {
    if (typeof inventory?.exact === 'function') return inventory.exact(ref);
    return exactListing(typeof inventory?.all === 'function' ? inventory.all() ?? [] : [], ref);
  };
  const say = (o) => { try { log(o); } catch { /* a log sink never stops a send */ } };

  async function commit(lead, call, lang) {
    if (!viewing || typeof viewing.commitBooking !== 'function') return { ok: false, reason: 'off' };
    try {
      return await viewing.commitBooking({
        lead, listingId: text(call.args.listing_id)?.toUpperCase() ?? null, slotId: text(call.args.slot_id),
        name: text(call.args.name) ?? undefined, language: lang,
      });
    } catch (err) {
      say({ level: 'error', evt: 'dana.commit_error', leadId: lead?.lead_id ?? null, error: errClass(err) });
      return { ok: false, reason: 'error' };
    }
  }

  /** The brochure documents the turn's send_brochure calls asked for as PDFs, by the inventory's URL. */
  function documents(calls) {
    const out = [];
    for (const c of calls) {
      if (c.name !== 'send_brochure' || !c.ok || c.result?.will_send !== 'pdf') continue;
      const listing = exact(c.args.listing_id);
      const url = typeof listing?.brochureUrl === 'string' && /^https:\/\//i.test(listing.brochureUrl.trim()) ? listing.brochureUrl.trim() : null;
      if (!url || blocked.has(listing.id) || out.some((d) => d.listingId === listing.id)) continue;
      out.push({ kind: 'document', url, caption: `${listing.id} brochure`, fileName: `${listing.id}-brochure.pdf`, mediaKind: 'document', listingId: listing.id });
      if (out.length >= MAX_DOCUMENTS) break;
    }
    return out;
  }

  /** The text with the exact pin's maps link of the last send_location that said `exact`, within MAX_LINKS. */
  function withLocation(body, calls, lang) {
    const call = calls.filter((c) => c.name === 'send_location' && c.ok && c.result?.precision === 'exact').at(-1);
    if (!call) return body;
    const listing = exact(call.args.listing_id);
    if (!listing || pinOf(listing) !== 'exact') return body;
    const link = `https://maps.google.com/?q=${Number(listing.map.lat)},${Number(listing.map.lng)}`;
    if (body.includes(link) || (body.match(LINK_RE) ?? []).length >= maxLinks) return body;
    return `${body.trimEnd()}\n\n${lang === 'en' ? 'Location' : 'الموقع'}: ${link}`;
  }

  async function afterPreSend({ lead = null, turn = null, text: answer = '', language = 'ar' } = {}) {
    const lang = language === 'en' ? 'en' : 'ar';
    const calls = turnToolCalls(turn);
    const brainTurn = Array.isArray(turn?.toolCalls);
    const leadId = lead?.lead_id ?? null;
    let body = answer;
    let booking = null;
    let handover = null;
    const book = calls.filter((c) => c.name === 'book_viewing' && c.ok && c.result?.reserved === true).at(-1);
    if (book) {
      const r = await commit(lead, book, lang);
      if (r?.ok === true && typeof r.text === 'string' && r.text) {
        body = r.text;
        booking = { bookingId: r.bookingId, listingId: r.listingId, startTs: r.startTs };
        say({ evt: 'dana.commit', leadId, booking: 'ok', bookingId: r.bookingId });
      } else {
        body = BOOKING_FAILED_LINE[lang];
        handover = { kind: 'booking_failed' };
        say({ evt: 'dana.commit', leadId, booking: 'failed', reason: typeof r?.reason === 'string' ? r.reason : 'error' });
      }
    } else if (brainTurn && claimsBooking(body)) {
      // The safety net (DESIGN §4.3): only a commit may say a viewing is booked.
      body = BOOKING_FAILED_LINE[lang];
      handover = { kind: 'booking_failed' };
      say({ evt: 'dana.commit', leadId, booking: 'claim' });
    }
    if (!booking && !handover) body = withLocation(body, calls, lang);
    const first = booking ? { kind: 'text', text: body, bookingId: booking.bookingId } : { kind: 'text', text: body };
    return {
      bubbles: [first, ...documents(calls)],
      ...(booking ? { booking } : {}),
      ...(handover ? { handover } : {}),
    };
  }

  async function afterSend({ lead = null, booking = null, accepted = false } = {}) {
    const id = typeof booking?.bookingId === 'string' && booking.bookingId ? booking.bookingId : null;
    if (!id) return {};
    const leadId = lead?.lead_id ?? null;
    if (accepted === true) {
      try { viewing?.markTold?.(id); } catch (err) { say({ level: 'error', evt: 'dana.commit_told_failed', bookingId: id, error: errClass(err) }); }
      try { notes?.booking?.(id, { told: true }); } catch (err) { say({ level: 'error', evt: 'dana.commit_note_failed', bookingId: id, error: errClass(err) }); }
      return { told: true };
    }
    // The event stays (DESIGN §8.3 step 9): the owner is told the client was not.
    try { notes?.booking?.(id, { told: false }); } catch (err) { say({ level: 'error', evt: 'dana.commit_note_failed', bookingId: id, error: errClass(err) }); }
    say({ level: 'warn', evt: 'dana.commit_untold', leadId, bookingId: id });
    return { told: false, handover: { kind: 'booking_unconfirmed' } };
  }

  return { afterPreSend, afterSend };
}
