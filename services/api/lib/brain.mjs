/**
 * Bona's AI assistant on the OpenAI API (brain/DESIGN-brain.md §3). STUB (PR-F2b): there is no
 * brain yet, so it is not configured and every turn is `off`. Nothing here reads a key file or
 * the network. PR-BR (task T25) replaces this file with the real loop (`createBrain({cfg,
 * runTool, siteFacts, guard, minimise, prices, team, fetchImpl, now, log})`); the interface
 * below is the seam it fills, and its `turn()` contract (DESIGN-brain §3.2) is what dana-wa,
 * the mail reply and later the website chat read:
 *
 *   turn({ route, leadId, language, autoMode, history, batchText, leadFacts, turnContext, toolNames, deadlineMs })
 *     → { ok: true, model, backup, rounds, ms, usd, usage, toolCalls, messages }   (Retell-shaped messages)
 *     | { ok: false, code: 'quota'|'auth'|'rate'|'down'|'timeout'|'bad_response'|'refusal'|'guard'|'budget'|'off' }
 *
 * index.mjs builds it with `runTool` (the concierge tool handlers, built before Dana for this),
 * and hands it to Dana beside Retell. Dana reads none of it until PR-B3 (task T12), and before
 * then no lead takes the brain path (DESIGN §2 `useBrain`).
 */

/**
 * @typedef {object} Brain
 * @property {boolean} configured  a key and a model are there (stub: false)
 * @property {(o?: object) => Promise<{ ok: false, code: 'off' }|object>} turn
 * @property {(o?: object) => Promise<{ error: 'off' }|object>} classify  the mail classifier (no tools)
 * @property {() => { configured: boolean, ok: boolean, backup: boolean }} health  feeds /health `dana.brainOk` / `dana.brainBackup`
 * @property {() => object} ops  the owner-only Ops panel's rows (stub: none)
 */

/**
 * @param {object} [deps]  what the real module will need; the stub reads none, and never calls `runTool` or `fetchImpl`
 * @returns {Brain}
 */
export function createBrain(deps = {}) {
  void deps;
  return {
    configured: false,
    turn: async () => ({ ok: false, code: 'off' }),
    classify: async () => ({ error: 'off' }),
    health: () => ({ configured: false, ok: false, backup: false }),
    ops: () => ({}),
  };
}
