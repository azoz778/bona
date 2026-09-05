/**
 * CORS allowlist. The concierge widget is served from the static site, so only a
 * fixed set of origins may talk to this API from a browser. Anything else gets no
 * `Access-Control-Allow-Origin` header at all (the browser then blocks the read).
 */

export const DEFAULT_ORIGINS = [
  'https://bona.azoz.uk',
  'https://bona.com.sa',
  'https://www.bona.com.sa',
  'https://azoz778.github.io',
  'http://localhost:4321',
  'http://127.0.0.1:4321',
];

/** Parse `BONA_CORS_ORIGINS` (comma separated) or fall back to the defaults. */
export function parseOrigins(value) {
  if (!value) return [...DEFAULT_ORIGINS];
  const list = String(value)
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return list.length ? list : [...DEFAULT_ORIGINS];
}

export function isAllowedOrigin(origin, allowlist) {
  if (!origin) return false;
  const normalised = String(origin).trim().replace(/\/+$/, '');
  return allowlist.includes(normalised);
}

/**
 * Headers for a request. Unknown/absent origins get `Vary` only — never a wildcard,
 * because the tool routes are token-gated and must not be readable cross-origin.
 */
export function corsHeaders(origin, allowlist) {
  const headers = { Vary: 'Origin' };
  if (isAllowedOrigin(origin, allowlist)) {
    headers['Access-Control-Allow-Origin'] = String(origin).trim().replace(/\/+$/, '');
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Bona-Token';
    headers['Access-Control-Max-Age'] = '86400';
  }
  return headers;
}
