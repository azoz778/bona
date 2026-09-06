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

/** Loopback peers: cloudflared runs beside us, so only it may name the real client. */
const LOOPBACK_RE = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

/** Strip the IPv6-mapped-IPv4 prefix and any zone id, so `::ffff:127.0.0.1` == `127.0.0.1`. */
export function normaliseAddr(addr) {
  const s = String(addr ?? '').trim().replace(/%.*$/, '');
  return s.startsWith('::ffff:') && s.includes('.') ? s.slice(7) : s;
}

export function isLoopback(addr) {
  const s = String(addr ?? '').trim().replace(/%.*$/, '');
  return LOOPBACK_RE.test(s) || LOOPBACK_RE.test(normaliseAddr(s));
}

/** Parse `BONA_TRUSTED_PROXY` (comma separated addresses). */
export function parseTrustedProxies(value) {
  return String(value ?? '').split(',').map((s) => normaliseAddr(s)).filter(Boolean);
}

/**
 * The client's IP.
 *
 * `CF-Connecting-IP` is honoured ONLY when the socket peer is loopback (the
 * cloudflared tunnel runs beside this process) or is listed in
 * `BONA_TRUSTED_PROXY`. `X-Forwarded-For` is never consulted: anything on the path
 * may append to it, so a spoofed hop would hand an attacker a fresh rate-limit
 * bucket per request. Everything else keys on the socket address.
 */
export function clientIp(req, { trustedProxies = [] } = {}) {
  const socketAddr = req?.socket?.remoteAddress ?? '';
  const peer = normaliseAddr(socketAddr);
  const trusted = isLoopback(socketAddr) || (peer && trustedProxies.includes(peer));
  if (trusted) {
    const cf = req?.headers?.['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.trim()) return cf.trim();
  }
  return peer || 'unknown';
}
