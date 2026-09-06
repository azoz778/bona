// Map pins from a brochure's PDF link annotations.
//
// A developer's brochure almost never prints coordinates in its text layer, but it very
// often carries a "see it on the map" hyperlink behind a location page. `extract_pdf.py`
// now returns those link URIs; this module turns them into a pin.
//
// The catch: a brochure links to landmarks too. One Bona brochure links King Abdulaziz
// airport and a city-level view of Jeddah — neither is the property. So a single link is
// never enough: two independent links must agree to within PIN_AGREE_M before we publish a
// pin. Anything less stays `map: null` and the listing shows its district only. We never
// guess a home's position.

/** Two links must fall within this many metres of each other to corroborate a pin. */
export const PIN_AGREE_M = 500;

const GEO_HOST = /(?:^|\.)(?:google\.[a-z.]{2,6}|goo\.gl|maps\.app\.goo\.gl)$/i;

/** Is this URL worth resolving/parsing as a map link? */
export function isGeoUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!GEO_HOST.test(u.hostname)) return false;
  return /maps/i.test(u.hostname) || /\/maps?\b|\/maps\//i.test(u.pathname) || u.hostname.endsWith('goo.gl');
}

/** Shortlinks carry no coordinates until they are followed. */
export const isShortLink = (url) => typeof url === 'string' && /(?:^|\/\/)(?:maps\.app\.goo\.gl|goo\.gl)\//i.test(url);

const inRange = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) &&
  Math.abs(lat) <= 90 && Math.abs(lng) <= 180 &&
  // 0,0 is Null Island: a placeholder in every mapping tool, never a Saudi property.
  !(Math.abs(lat) < 1e-6 && Math.abs(lng) < 1e-6);

const pt = (lat, lng) => (inRange(lat, lng) ? { lat, lng } : null);

/**
 * Coordinates out of a Google Maps URL, or null.
 *
 * Three shapes, in order of trust:
 *   !3d<lat>!4d<lng>   the place's own pin      (most precise)
 *   ?q=<lat>,<lng>     an explicit query pin    (what a resolved shortlink returns)
 *   @<lat>,<lng>,<z>   the viewport centre      (weakest — where the map was scrolled)
 */
export function parseMapUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  let decoded = url;
  try { decoded = decodeURIComponent(url); } catch { /* keep the raw form */ }
  if (!isGeoUrl(url)) return null;

  const pin = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(decoded);
  if (pin) { const p = pt(Number(pin[1]), Number(pin[2])); if (p) return p; }

  const q = /[?&]q=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/.exec(decoded);
  if (q) { const p = pt(Number(q[1]), Number(q[2])); if (p) return p; }

  const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(decoded);
  if (at) { const p = pt(Number(at[1]), Number(at[2])); if (p) return p; }

  return null;
}

/** Great-circle distance in metres. */
export function haversineM(a, b) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 6 decimals ≈ 0.1 m. More digits than that is false precision. */
const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * The property pin, or null.
 *
 * Clusters the candidates and returns the centroid of the largest cluster — but only when
 * that cluster holds at least two links. One link on its own could be a landmark, so it is
 * refused rather than published.
 *
 * @param {{lat:number,lng:number}[]} candidates
 * @returns {{lat:number,lng:number}|null}
 */
export function pickPin(candidates) {
  const pts = (Array.isArray(candidates) ? candidates : []).filter((c) => c && inRange(c.lat, c.lng));
  if (pts.length < 2) return null;

  let best = null;
  for (const seed of pts) {
    const near = pts.filter((p) => haversineM(seed, p) <= PIN_AGREE_M);
    if (!best || near.length > best.length) best = near;
  }
  if (!best || best.length < 2) return null;

  const lat = best.reduce((s, p) => s + p.lat, 0) / best.length;
  const lng = best.reduce((s, p) => s + p.lng, 0) / best.length;
  return { lat: round6(lat), lng: round6(lng) };
}

/** Follow a Google shortlink to the URL that carries the coordinates. */
export async function resolveShortLink(url, { timeoutMs = 8000, fetchImpl = fetch } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'HEAD', redirect: 'follow', signal: ctl.signal });
    return res?.url || url;
  } finally {
    clearTimeout(timer);
  }
}

/** Max links we will follow over the network for one brochure. */
const MAX_RESOLVE = 6;

// Per-share decoration Google hangs off a Maps URL. Two links that differ only here are one
// link shared twice, and must not count as two opinions in pickPin.
const TRACKING_PARAMS = ['entry', 'g_ep', 'g_st', 'lucs', 'skid', 'ttu', 'shorturl', 'hl', 'gl', 'ucbcb', 'coh', 'source'];

/**
 * A stable identity for a map URL: host + path + the params that carry meaning, with the
 * tracking noise stripped. Used only to tell links apart, never to read coordinates.
 */
export function mapUrlIdentity(url) {
  try {
    const u = new URL(url);
    for (const k of TRACKING_PARAMS) u.searchParams.delete(k);
    u.hash = '';
    u.searchParams.sort();
    return `${u.hostname.replace(/^www\./i, '').toLowerCase()}${decodeURIComponent(u.pathname).replace(/\/+$/, '')}?${u.searchParams}`;
  } catch {
    return String(url ?? '');
  }
}

/**
 * The property pin from a brochure's link annotations, or null.
 *
 * Deduplicates by URI first: `extract_pdf.py` reports a link once per page it appears on,
 * and the same link on five pages is one source, not five — it must not corroborate
 * itself past the two-link bar in `pickPin`.
 *
 * @param {{page:number,uri:string}[]} links  from extract_pdf.py
 * @param {{resolve?: (url:string)=>Promise<string>}} [opts]  injectable for tests
 */
export async function pinFromLinks(links, { resolve = resolveShortLink } = {}) {
  // Dedupe twice. Once on the annotation itself, so the same link on five pages is one
  // source; and again on what it RESOLVES to, so two shortlinks that land on one target —
  // or one URL wearing two sets of tracking params — cannot corroborate each other.
  const seenSource = new Set();
  const seenTarget = new Set();
  const candidates = [];
  let resolved = 0;
  for (const l of Array.isArray(links) ? links : []) {
    const uri = l?.uri;
    if (!isGeoUrl(uri)) continue;
    const sourceId = mapUrlIdentity(uri);
    if (seenSource.has(sourceId)) continue;
    seenSource.add(sourceId);

    let target = uri;
    if (isShortLink(uri) && resolved < MAX_RESOLVE) {
      resolved += 1;
      // A dead shortlink is normal (expired, offline, rate-limited): drop it, never throw.
      try { target = await resolve(uri); } catch { continue; }
    }
    const targetId = mapUrlIdentity(target);
    if (seenTarget.has(targetId)) continue;
    seenTarget.add(targetId);

    const p = parseMapUrl(target);
    if (p) candidates.push(p);
  }
  return pickPin(candidates);
}
