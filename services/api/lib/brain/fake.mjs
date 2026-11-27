/**
 * A scripted fake brain for tests (brain/DESIGN-brain.md §3.1): it replaces "fake Retell" in the
 * T12, T13, T14, T21 and T22 tests. Same interface as lib/brain.mjs (`configured`, `turn`,
 * `classify`, `probe`, `health`, `ops`) and the same result shapes, so code tested on it reads
 * the real brain the same way. Never a network call.
 *
 *   const brain = createFakeBrain({ turns: [brainReply('Hi.'), brainError('quota'), (input) => brainReply(...)] });
 *   ... brain.calls  (every turn() input, in order; an empty list means "the brain was never called")
 *
 * Past the end of the script a turn is `off` and a classify `{ error: 'off' }`.
 */
import { retellMessages } from '../brain.mjs';
import { CODES } from './errors.mjs';

let n = 0;

/**
 * An ok turn, shaped like the real one.
 * @param {string} text  the answer ('' = no words, which dana-wa treats as the empty hand-over)
 * @param {{ tools?: { name: string, args?: object, result?: string|object, ok?: boolean, id?: string }[], model?: string, backup?: boolean, usd?: number }} [o]
 */
export function brainReply(text, { tools = [], model = 'fake-model', backup = false, usd = 0 } = {}) {
  const toolCalls = tools.map((t) => ({
    id: t.id ?? `fake_${n += 1}`, name: t.name, args: t.args ?? {},
    result: typeof t.result === 'string' ? t.result : JSON.stringify(t.result ?? { ok: true }), ok: t.ok ?? true,
  }));
  return {
    ok: true, model, backup, rounds: toolCalls.length ? 2 : 1, ms: 0, usd, usage: { in: 0, cached: 0, out: 0, reasoning: 0 },
    toolCalls, messages: retellMessages(toolCalls, text), guard: { repaired: false },
  };
}

/** A failed turn with one of the brain's codes (lib/brain/errors.mjs). */
export function brainError(code) {
  if (!CODES.includes(code)) throw new TypeError(`unknown brain code: ${code}`);
  return { ok: false, code };
}

/**
 * @param {{ turns?: Array<object|Function>, classify?: Array<object|Function>, configured?: boolean, health?: object }} [o]
 */
export function createFakeBrain({ turns = [], classify = [], configured = true, health = null } = {}) {
  const queue = [...turns];
  const classifyQueue = [...classify];
  const calls = [];
  const classifyCalls = [];
  const next = async (q, input, none) => {
    const item = q.shift();
    if (item === undefined) return none;
    return typeof item === 'function' ? item(input) : item;
  };
  return {
    get configured() { return configured; },
    calls,
    classifyCalls,
    async turn(input = {}) {
      calls.push(input);
      return configured ? next(queue, input, { ok: false, code: 'off' }) : { ok: false, code: 'off' };
    },
    async classify(input = {}) {
      classifyCalls.push(input);
      return configured ? next(classifyQueue, input, { error: 'off' }) : { error: 'off' };
    },
    async probe() { return configured ? { ok: true } : { ok: false, code: 'off' }; },
    health() { return health ?? (configured ? { configured: true, ok: true, backup: false } : { configured: false, ok: false, backup: false }); },
    ops() { return {}; },
  };
}
