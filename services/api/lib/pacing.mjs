/**
 * Dana's human timing and her caps by warm-up tier (DESIGN §6.2-6.3). STUB (PR-F2b): it keeps
 * today's numbers. PR-B3 (task T12) replaces this file and is the one that wires it into
 * lib/dana-wa.mjs; the interface below is the seam it fills. Injected, so tests pin it.
 *
 * Today: a fixed 2 s batch (dana-wa.mjs BATCH_MS), no typing floor, no global send queue
 * (`fifo` runs the send at once), and one set of caps whatever the date (`tier`). The values
 * are written out here rather than imported, so lib/dana-wa.mjs can import this file without a
 * cycle; test/seams.test.mjs pins them to today's exported constants.
 */

/** Today's caps (dana-wa.mjs PER_DAY, PER_CHAT_PER_HOUR, MAX_LINKS; wa-send.mjs SEND_PER_MIN, SEND_PER_DAY). */
const TODAY = Object.freeze({ PER_DAY: 200, PER_CHAT_PER_HOUR: 6, MAX_LINKS: 3, SEND_PER_MIN: 20, SEND_PER_DAY: 500 });

/**
 * @typedef {object} Pacing
 * @property {() => number} batchMs        how long a batch waits for more messages (stub: 2000)
 * @property {(o?: object) => number} typingFloorMs  how long before a send may go (stub: 0)
 * @property {<T>(fn: () => T) => T} fifo  runs a send in the global send queue (stub: at once)
 * @property {(ts?: number) => typeof TODAY} tier  the caps in force at `ts` (stub: today's, at any date)
 */

/**
 * @param {object} [deps]  what the real module will need (cfg: BONA_WA_LINKED_AT, random, now); the stub reads none
 * @returns {Pacing}
 */
export function createPacing(deps = {}) {
  void deps;
  return {
    batchMs: () => 2000,
    typingFloorMs: () => 0,
    fifo: (fn) => fn(),
    tier: () => ({ ...TODAY }),
  };
}
