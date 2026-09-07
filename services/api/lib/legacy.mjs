/**
 * The hosts the site used to answer on, and the 301 that carries them to the new one.
 *
 * Bona moved from bona.azoz.uk to bona-real-estate.com. GitHub Pages serves exactly one
 * custom domain, so the old host stopped being a site at all — every link ever shared,
 * every search result, every QR code printed on a brochure now points at a 404. The
 * azoz.uk zone cannot carry a Cloudflare redirect rule either (the token there is
 * DNS-edit only; /rulesets answers 403), so the old host is pointed at this API's tunnel
 * instead and the redirect is served here.
 *
 * This lives beside `cors.mjs` rather than inside it because the two lists are not the
 * same kind of thing and will not age together: CORS holds *origins* — scheme included —
 * naming who may read an answer, while these are bare `Host` headers naming callers who
 * get no answer at all. bona.azoz.uk leaves the CORS allowlist the day nothing is served
 * from it, and stays a legacy host for as long as old links exist.
 */

/**
 * Only the bare host. `www.bona.azoz.uk` is deliberately absent: Cloudflare's Universal
 * SSL covers azoz.uk and *.azoz.uk but not a second label under it, so that name could
 * never present a valid certificate through this tunnel — listing it would advertise a
 * redirect that dies at the TLS handshake. Add hosts via BONA_LEGACY_HOSTS if one ever
 * gets a certificate of its own; whatever is listed must also be routed to the tunnel
 * (services/deploy/install.sh, BONA_EXTRA_HOSTNAMES).
 */
export const DEFAULT_LEGACY_HOSTS = ['bona.azoz.uk'];

/**
 * A `Host` header reduced to the name alone: lower-cased, port dropped, root dot dropped.
 * `bona.azoz.uk`, `BONA.AZOZ.UK:443` and `bona.azoz.uk.` are one host to a resolver and
 * must be one host here too, or a redirect that works through the tunnel stops working
 * the moment someone reaches the service by another route.
 */
export function normaliseHost(value) {
  const host = String(value ?? '').trim().toLowerCase();
  if (!host) return '';
  // An IPv6 literal is bracketed and full of colons, so only a colon after `]` is a port.
  const afterLiteral = host.startsWith('[') ? host.indexOf(']') + 1 : 0;
  const colon = host.indexOf(':', afterLiteral);
  return (colon === -1 ? host : host.slice(0, colon)).replace(/\.$/, '');
}

/** Parse `BONA_LEGACY_HOSTS` (comma separated) or fall back to the defaults. */
export function parseLegacyHosts(value) {
  if (!value) return [...DEFAULT_LEGACY_HOSTS];
  const list = String(value).split(',').map(normaliseHost).filter(Boolean);
  return list.length ? list : [...DEFAULT_LEGACY_HOSTS];
}

/**
 * The configured list minus the host the redirect itself points at. `BONA_SITE` is where
 * legacy traffic is sent, and on a box that missed the cutover — a stale
 * `bona-services.env`, the built-in default — that is still an old host. Without this
 * guard the service would bounce every visitor back to itself until the browser gave up.
 */
export function resolveLegacyHosts(value, siteUrl) {
  let target = '';
  try { target = normaliseHost(new URL(String(siteUrl)).host); } catch { /* unparseable: nothing to guard against */ }
  return parseLegacyHosts(value).filter((host) => host !== target);
}

/** Defaulted on purpose: a config written before this list existed still redirects rather than 404s. */
export function isLegacyHost(host, hosts = DEFAULT_LEGACY_HOSTS) {
  const bare = normaliseHost(host);
  return Boolean(bare) && Array.isArray(hosts) && hosts.includes(bare);
}

/**
 * Where a legacy request goes. The request target is passed through byte for byte — path,
 * query, escaping and all — so a deep link into the old site lands on the same page of the
 * new one rather than on its homepage. Anything that is not an origin-form target
 * (`OPTIONS *`, the absolute form a misbehaving proxy may send, control characters that
 * have no business in a `Location` header) becomes the homepage instead of being echoed.
 */
export function legacyRedirectUrl(siteUrl, target) {
  const base = String(siteUrl ?? '').replace(/\/+$/, '');
  const path = String(target ?? '');
  return `${base}${/^\/[^\s\u0000-\u001f\u007f]*$/.test(path) ? path : '/'}`;
}
