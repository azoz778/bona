/**
 * What Dana's answer becomes once preSend has passed (DESIGN §2, §8.3). STUB (PR-F2b): today an
 * answer is its text and nothing else, one text bubble. PR-B4 (task T13) replaces this file
 * (the brochure document, the code-built booking confirmation through viewing.commitBooking,
 * the booking note), and PR-B3 (task T12) is the one that calls it from lib/dana-wa.mjs; the
 * interface below is the seam they fill.
 *
 * `turn` is the brain's turn (lib/brain.mjs `turn()`), or the Retell completion for a legacy
 * lead until PR-RX (T27) removes that path. Both carry Retell-shaped `messages`; the brain turn
 * also carries `toolCalls`. The stub reads neither.
 */

/**
 * @typedef {object} DanaCommit
 * @property {(o: { lead: object, turn: object, text: string, language: 'ar'|'en', coversTs: number })
 *   => Promise<{ bubbles: Array<{ kind: 'text', text: string }> }>} afterPreSend
 */

/**
 * @param {object} [deps]  what the real module will need (viewing, notes, inventory, sender); the stub reads none
 * @returns {DanaCommit}
 */
export function createDanaCommit(deps = {}) {
  void deps;
  return {
    afterPreSend: async ({ text } = {}) => ({ bubbles: [{ kind: 'text', text }] }),
  };
}
