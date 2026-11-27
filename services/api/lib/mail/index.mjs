/**
 * Bona's mailbox (DESIGN §9, DESIGN-mail; Track C). STUB (PR-F2b): there is no mail module yet,
 * so nothing is read, sorted or answered, and nothing starts. PR-C2 (task T21) replaces this
 * file with the JMAP poller, the header rules and the classifier call; the interface below is
 * the seam it fills. Its credentials stay in ~/.secrets/bona-mail.env, read by the module
 * itself, never by config.mjs.
 */

/**
 * @typedef {object} Mail
 * @property {() => void} start  (stub: nothing)
 * @property {() => void} stop   (stub: nothing)
 * @property {() => { configured: boolean, ok: boolean, lastErrorCode: string|null, replies: boolean }} health
 *   the /health `mail` keys (DESIGN §5.4): booleans and a fixed error enum, never upstream text
 */

/**
 * @param {object} [deps]  what the real module will need (cfg, db, brain, notes, now, log); the stub reads none
 * @returns {Mail}
 */
export function createMail(deps = {}) {
  void deps;
  return {
    start: () => {},
    stop: () => {},
    health: () => ({ configured: false, ok: false, lastErrorCode: null, replies: false }),
  };
}
