/**
 * Web Push without a payload (2026-09-27 design §5, Phase 3).
 *
 * A push here carries NOTHING: an empty POST to the device's push service (Google's FCM,
 * Apple's, Mozilla's, Microsoft's), so no client text, name or number ever passes through
 * them, and there is no RFC 8291 encryption to get wrong. The service worker shows the same
 * fixed notification for every push, and the tap asks the dashboard where to go.
 *
 * The request is authorised with VAPID (RFC 8292): an ES256 JWT for the push service's
 * origin, signed with the server's P-256 key through `node:crypto`, plus the public key the
 * browser subscribed with. Keys are base64url: the public key the 65-byte uncompressed point
 * the browser's `applicationServerKey` takes, the private key the 32-byte scalar.
 *
 * The server POSTs to whatever endpoint a signed-in member's browser posted, so only real
 * push services are accepted (`pushEndpoint`): anything else would let a member make this
 * process call any host. An endpoint is a bearer capability for that device: never logged.
 */
import crypto from 'node:crypto';

export const PUSH_TTL_S = 3600;
export const PUSH_TIMEOUT_MS = 10_000;
export const JWT_TTL_S = 12 * 3600;
export const JWT_REUSE_MS = 3_600_000;
export const MAX_ENDPOINT_LEN = 1024;
const MAX_KEY_TEXT = 200;

const EXACT_HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
const HOST_SUFFIXES = ['.push.apple.com', '.notify.windows.com'];

const b64u = (buf) => Buffer.from(buf).toString('base64url');
/** Bytes from base64url text, or null for anything that is not (padding tolerated). */
function fromB64u(s) {
  if (typeof s !== 'string' || !s || s.length > MAX_KEY_TEXT || !/^[A-Za-z0-9_-]+={0,2}$/.test(s)) return null;
  return Buffer.from(s, 'base64url');
}

/** A fresh P-256 pair, as the env file keeps it. */
export function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey(null, 'uncompressed')), privateKey: b64u(ecdh.getPrivateKey()) };
}

/**
 * The env's two strings as a usable pair, or null. The public key is derived again from the
 * private scalar and must equal the one given: a mismatched pair would sign JWTs every push
 * service refuses, while the browsers subscribed with the other key.
 */
export function vapidKeys(pair) {
  const { publicKey, privateKey } = pair ?? {};
  const pub = fromB64u(publicKey);
  const d = fromB64u(privateKey);
  if (!pub || pub.length !== 65 || pub[0] !== 4 || !d || d.length !== 32) return null;
  try {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(d);
    if (!ecdh.getPublicKey(null, 'uncompressed').equals(pub)) return null;
    const key = crypto.createPrivateKey({
      key: { kty: 'EC', crv: 'P-256', d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) },
      format: 'jwk',
    });
    return { publicKey: b64u(pub), key };
  } catch {
    return null; // a scalar outside the curve's range (zero, too large)
  }
}

/** The VAPID JWT for one push service origin. */
export function vapidJwt({ audience, subject, key, nowMs }) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: audience, exp: Math.floor(nowMs / 1000) + JWT_TTL_S, sub: subject }));
  const input = `${header}.${claims}`;
  const sig = crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64u(sig)}`;
}

/** The endpoint as a URL string when it is a real push service's, else null (P3-6). */
export function pushEndpoint(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_ENDPOINT_LEN) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname;
  const known = EXACT_HOSTS.has(host) || HOST_SUFFIXES.some((s) => host.endsWith(s) && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(host.slice(0, -s.length)));
  return known && u.href.length <= MAX_ENDPOINT_LEN ? u.href : null;
}

/** The browser's `keys`, checked: a 65-byte uncompressed P-256 point and a 16-byte secret. */
export function subscriptionKeys(keys) {
  const p = fromB64u(keys?.p256dh);
  const a = fromB64u(keys?.auth);
  if (!p || p.length !== 65 || p[0] !== 4 || !a || a.length !== 16) return null;
  return { p256dh: b64u(p), auth: b64u(a) };
}

/**
 * Sends one empty push to one endpoint. `send` never rejects: it answers the push
 * service's status, or the kind of failure (`timeout`, `network`, `bad_endpoint`) — never an error's
 * message, which could carry the endpoint.
 */
export function createPusher({ keys, subject, fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = PUSH_TIMEOUT_MS }) {
  const jwts = new Map(); // push service origin → { jwt, at }
  function jwtFor(audience) {
    const t = now();
    const hit = jwts.get(audience);
    if (hit && t - hit.at < JWT_REUSE_MS) return hit.jwt;
    const jwt = vapidJwt({ audience, subject, key: keys.key, nowMs: t });
    jwts.set(audience, { jwt, at: t });
    return jwt;
  }
  async function send(endpoint) {
    const url = pushEndpoint(endpoint);
    if (!url) return { error: 'bad_endpoint' };
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { TTL: String(PUSH_TTL_S), Urgency: 'high', Authorization: `vapid t=${jwtFor(new URL(url).origin)}, k=${keys.publicKey}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      try { await res.arrayBuffer?.(); } catch { /* the body is read only to hand the socket back to the pool */ }
      return { status: Number(res.status) };
    } catch (err) {
      return { error: err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network' };
    }
  }
  return { publicKey: keys.publicKey, send };
}
