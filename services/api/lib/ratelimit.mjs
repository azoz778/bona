/**
 * Per-IP token buckets. Small, in-memory, no dependencies — enough to stop a single
 * visitor (or a scraper) from burning the owner's Retell balance.
 */

export function createLimiter({ capacity, perMs, now = () => Date.now(), maxKeys = 10_000 }) {
  if (!(capacity > 0) || !(perMs > 0)) throw new TypeError('capacity and perMs must be > 0');
  const refillPerMs = capacity / perMs;
  /** @type {Map<string, { tokens: number, last: number }>} */
  const buckets = new Map();

  function sweep(t) {
    if (buckets.size <= maxKeys) return;
    for (const [key, b] of buckets) {
      if (t - b.last > perMs * 4) buckets.delete(key);
      if (buckets.size <= maxKeys) break;
    }
  }

  /**
   * Consume one token.
   * @returns {{ ok: boolean, remaining: number, retryAfterS: number }}
   */
  function take(key, cost = 1) {
    const t = now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: capacity, last: t };
      buckets.set(key, b);
      sweep(t);
    }
    b.tokens = Math.min(capacity, b.tokens + (t - b.last) * refillPerMs);
    b.last = t;
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { ok: true, remaining: Math.floor(b.tokens), retryAfterS: 0 };
    }
    const deficit = cost - b.tokens;
    return { ok: false, remaining: 0, retryAfterS: Math.max(1, Math.ceil(deficit / refillPerMs / 1000)) };
  }

  return { take, size: () => buckets.size, reset: () => buckets.clear() };
}

/** Client IP behind cloudflared: CF-Connecting-IP, then the first X-Forwarded-For hop. */
export function clientIp(req) {
  const h = req.headers ?? {};
  const cf = h['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const xff = h['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}
