/**
 * What an inbox log line may say about an error. Never its message: one could carry a jid, a
 * phone number or a word of a client's message. Only its name, when it is one of the kinds
 * this code meets, and its code, when it is shaped like one. lib/inbox/backfill.mjs and
 * index.mjs's inbox upkeep both log through these, so every inbox log line keeps one rule.
 */

/** The error names worth logging. Any other name is dropped: an injected error's name could carry anything. */
const LOGGED_ERROR_NAMES = new Set([
  'Error', 'EvolutionError', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'SqliteError', 'AbortError', 'TimeoutError',
]);

/** An error's name if it is one of those, else null. */
export const loggableName = (err) => (typeof err?.name === 'string' && LOGGED_ERROR_NAMES.has(err.name) ? err.name : null);

/**
 * An error's code when it is shaped like one (`ERR_SQLITE_ERROR`, `ECONNREFUSED`): capitals
 * and underscores only, so it cannot carry a number. Else null.
 */
export const loggableCode = (err) => (typeof err?.code === 'string' && /^[A-Z_]{1,64}$/.test(err.code) ? err.code : null);
