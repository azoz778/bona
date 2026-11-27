/**
 * Viewing bookings on the owner's calendar (DESIGN §8). STUB (PR-F2b): booking does not exist
 * yet, so the stub keeps today's behaviour: nothing is bookable, nothing is booked, and every
 * viewing request is handed to the team as it is today. PR-B1 (task T10) replaces this file
 * (with lib/gcal.mjs and lib/slots.mjs behind it); the interface below is the seam it fills.
 *
 * Callers, once wired: the concierge tools (slots, validate), dana-commit (commitBooking, after
 * preSend), the dashboard hooks (onTaskChange: a task set to cancelled; onLeadLeaving: Not a
 * client and a number that became a colleague's or a never-list one), the inbox store's
 * `onPurge` seam (purgeLead, inside its transaction: rows only, never the network), and the
 * worker's timer (tick). No method here reads the network or writes a row.
 */

/**
 * @typedef {object} Viewing
 * @property {boolean} configured   a calendar is set up (stub: false)
 * @property {(o?: object) => Promise<{ bookable: false }|object>} slots  the bookable slots (stub: none)
 * @property {(o?: object) => { ok: false, reason: 'off' }|object} validate  a booking request checked (stub: refused, off)
 * @property {(o?: object) => Promise<{ ok: false, reason: 'off' }|object>} commitBooking  (stub: refused, off)
 * @property {(leadId: string) => number} cancelForLead  marks a lead's booked rows for cancelling (stub: none, 0)
 * @property {(task: object, patch: object) => void} onTaskChange  (stub: nothing)
 * @property {(leadId: string) => void} onLeadLeaving  (stub: nothing)
 * @property {(leadId: string) => void} onPurge  (stub: nothing)
 * @property {() => Promise<void>|void} tick  (stub: nothing)
 * @property {() => { enabled: boolean, gcal: { configured: boolean, ok: boolean, lastErrorCode: string|null } }} health
 */

/**
 * @param {object} [deps]  what the real module will need (db, cfg, gcal, team, lead tasks, log); the stub reads none
 * @returns {Viewing}
 */
export function createViewing(deps = {}) {
  void deps;
  const nothing = () => {};
  return {
    configured: false,
    slots: async () => ({ bookable: false }),
    validate: () => ({ ok: false, reason: 'off' }),
    commitBooking: async () => ({ ok: false, reason: 'off' }),
    cancelForLead: () => 0,
    onTaskChange: nothing,
    onLeadLeaving: nothing,
    onPurge: nothing,
    tick: nothing,
    health: () => ({ enabled: false, gcal: { configured: false, ok: false, lastErrorCode: null } }),
  };
}
