/**
 * The brain's one error enum (brain/DESIGN-brain.md §4.1). Every failure a turn can end with is
 * one of these codes; the provider's own words (error messages, bodies) are never kept, logged
 * or passed on, so nothing upstream can reach a client, the owner or the journal.
 *
 *   quota         429 insufficient_quota or 402: the credit ran out (no retry; the brain is `out`)
 *   auth          401 / 403: the key is refused (the brain is `out`; the models probe can clear it)
 *   rate          another 429, or a 200 that failed with rate_limit_exceeded: a rate limit (one short retry, else
 *                 the backup model)
 *   down          5xx, a network error, or a 200 that failed on OpenAI's side (codeFromFailed; the backup model;
 *                 the breaker counts it)
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

/**
 * The Responses API's `error.code` values of a 200 body with `status:'failed'` that put the fault on OpenAI's side,
 * and their code: `server_error` and `vector_store_timeout` are `down`, as a 5xx (the backup model, the outage
 * breaker; never brain_bug); `rate_limit_exceeded` is `rate`, as an HTTP 429 (the short retry, the backup model, the
 * main model's cooldown). Every other code is about our request (`invalid_prompt`, the image codes) or unknown, and
 * stays `bad_response`.
 */
export const FAILED_CODES = Object.freeze({ server_error: 'down', vector_store_timeout: 'down', rate_limit_exceeded: 'rate' });

/** @param {unknown} error  the `error` object of a 200 body with status 'failed' (read for its code only) */
export function codeFromFailed(error) {
  const code = error && typeof error === 'object' ? String(error.code ?? '').toLowerCase() : '';
  return Object.hasOwn(FAILED_CODES, code) ? FAILED_CODES[code] : 'bad_response';
}
