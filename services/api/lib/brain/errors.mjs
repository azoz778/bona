/**
 * The brain's one error enum (brain/DESIGN-brain.md §4.1). Every failure a turn can end with is
 * one of these codes; the provider's own words (error messages, bodies) are never kept, logged
 * or passed on, so nothing upstream can reach a client, the owner or the journal.
 *
 *   quota         429 insufficient_quota or 402: the credit ran out (no retry; the brain is `out`)
 *   auth          401 / 403: the key is refused (the brain is `out`; the models probe can clear it)
 *   rate          another 429: a rate limit (one short retry, else the backup model)
 *   down          5xx or a network error (the backup model; the breaker counts it)
 *   timeout       no answer in time (the backup model)
 *   bad_response  an unparsable body, a bad tool call, no text, a cut-off answer, too many rounds, another 4xx
 *   refusal       the model refused (never retried on another model)
 *   guard         the reply guard failed again after its one repair call
 *   budget        a runaway stop (day or month) is reached, at a turn's start or by any of its requests
 *   off           no brain: no key, no prompt, an unknown host, a route not offered
 */

export const CODES = Object.freeze(['quota', 'auth', 'rate', 'down', 'timeout', 'bad_response', 'refusal', 'guard', 'budget', 'off']);

/** A failure the backup model (same key) may cover. */
export const BACKUP_CODES = new Set(['rate', 'down', 'timeout', 'bad_response']);

/** A failure that marks the brain `out` for a while (no model call meanwhile). */
export const OUT_CODES = new Set(['quota', 'auth']);

/**
 * @param {number} status  the HTTP status of a response that was not a 2xx
 * @param {object|null} body  its parsed JSON, if any (read for the error type only)
 */
export function codeFromHttp(status, body) {
  const err = body && typeof body === 'object' ? body.error : null;
  const kind = [err?.code, err?.type].map((v) => String(v ?? '').toLowerCase());
  if (status === 402) return 'quota';
  if (status === 429) return kind.includes('insufficient_quota') ? 'quota' : 'rate';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'down';
  return 'bad_response';
}

/** A thrown fetch: an abort (our timeout) is `timeout`; anything else (DNS, TLS, reset) is `down`. */
export function codeFromThrown(err) {
  return err?.name === 'AbortError' || err?.name === 'TimeoutError' ? 'timeout' : 'down';
}
