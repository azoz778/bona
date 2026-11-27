/**
 * The WhatsApp link probe and the instance identity guard (DESIGN §5.3). STUB (PR-F2b). PR-L
 * (task T09) replaces this file; the interface below is the seam it fills.
 *
 * `identityOk()` is false here, fail closed: nothing may treat the instance as Bona's own,
 * checked number until the real guard has looked (BONA_WA_INSTANCE set explicitly, not a
 * personal instance, and the live instance's connected number equal to BONA_WA_INSTANCE_JID).
 * Today nothing reads it, so false changes nothing; the own-number rule and the test switch
 * (PR-A1, PR-A2) need it true, which is why PR-L merges first in wave 1.
 *
 * `linkOk()` is true: today nothing probes the link, and nothing is held back for it. The real
 * probe (`POST /chat/whatsappNumbers/<inst>` every 10 min) can only take that away.
 * Neither ever sends a message; start() and stop() arm no timer here.
 */

/**
 * @typedef {object} WaLink
 * @property {() => boolean} identityOk  (stub: false, fail closed)
 * @property {() => boolean} linkOk      (stub: true)
 * @property {() => void} start          (stub: nothing)
 * @property {() => void} stop           (stub: nothing)
 * @property {() => { linkOk: boolean, identityOk: boolean }} health  booleans only
 */

/**
 * @param {object} [deps]  what the real module will need (env, fetchImpl, alerts, now, log); the stub reads none
 * @returns {WaLink}
 */
export function createWaLink(deps = {}) {
  void deps;
  return {
    identityOk: () => false,
    linkOk: () => true,
    start: () => {},
    stop: () => {},
    health: () => ({ linkOk: true, identityOk: false }),
  };
}
