/**
 * First-party events (`POST /v1/events`).
 *
 * The site posts one small JSON object per thing a visitor does — page view,
 * gallery open, WhatsApp click… — as `text/plain` so there is no preflight and
 * `keepalive` survives the tab closing. This module is the contract: the allowlist
 * of names, the shape of every id, the caps, and the two writes each event makes
 * (a session upsert and an event row).
 *
 * The site's `attribution.js` mirrors `EVENT_NAMES` and the id shapes; keep them in step.
 */

/** What a browser may send. */
export const EVENT_NAMES = [
  'page_view', 'listing_view', 'gallery_open', 'tour_open', 'video_play', 'brochure_download',
  'whatsapp_click', 'call_click', 'form_submit', 'consent_update', 'concierge_open',
];

/** What only this server writes. A browser sending one of these is refused. */
export const SERVER_EVENT_NAMES = ['concierge_chat_start', 'concierge_call_start', 'lead_created', 'lead_stage'];

export const ID_RE = {
  anon_id: /^[0-9a-f]{32}$/,
  session_id: /^[a-z0-9-]{6,24}$/,
  ref: /^[A-HJ-NP-Z2-9]{5,6}$/,
  event_id: /^[a-z0-9-]{8,40}$/,
  listing_id: /^BONA-W?\d{3}$/,
};

export const MAX_STRING = 300;
export const MAX_PROPS_BYTES = 2 * 1024;
export const MAX_BODY_BYTES = 8 * 1024;
/** A client clock more than a week out is not believed. */
export const TS_WINDOW_MS = 7 * 86_400_000;

const TOUCH_STRINGS = ['landing', 'referrer', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'];
const CLICK_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A string capped at `max`, or null for anything that is not a non-empty string. */
function str(v, max = MAX_STRING) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

function id(kind, v, { upper = false } = {}) {
  let s = str(v, 64);
  if (!s) return null;
  if (upper) s = s.toUpperCase();
  return ID_RE[kind].test(s) ? s : null;
}

/**
 * The four ids the concierge routes and the enquiry form may carry alongside an
 * event. Malformed or missing values become null — never an error — because these
 * are hints for attribution, not the request itself.
 */
export function cleanAttrIds(obj) {
  const o = isObject(obj) ? obj : {};
  return {
    anon_id: id('anon_id', o.anon_id),
    session_id: id('session_id', o.session_id),
    ref: id('ref', o.ref, { upper: true }),
    listing_id: id('listing_id', o.listing_id, { upper: true }),
  };
}

function cleanClickIds(v) {
  if (!isObject(v)) return null;
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    const s = str(val);
    if (s && CLICK_KEY_RE.test(k)) out[k] = s;
  }
  return Object.keys(out).length ? out : null;
}

/** One touch bundle (`attr.first` / `attr.last`): known keys only, strings capped. */
export function cleanTouch(v) {
  if (!isObject(v)) return null;
  const out = { ts: Number.isFinite(v.ts) ? Math.round(v.ts) : null };
  for (const k of TOUCH_STRINGS) out[k] = str(v[k]);
  out.click_ids = cleanClickIds(v.click_ids);
  return out;
}

/** The `attr` bundle: the two touches plus the ad-platform ids. */
export function cleanAttr(v) {
  const a = isObject(v) ? v : {};
  const ga = isObject(a.ga) ? { client_id: str(a.ga.client_id, 64), session_id: str(a.ga.session_id, 64) } : null;
  return {
    first: cleanTouch(a.first),
    last: cleanTouch(a.last),
    fbp: str(a.fbp, 64),
    fbc: str(a.fbc, 500),
    ga,
    scid: str(a.scid, 200),
    ttp: str(a.ttp, 200),
  };
}

export function cleanConsent(v) {
  const c = isObject(v) ? v : {};
  return { analytics: Boolean(c.analytics), ads: Boolean(c.ads) };
}

/** Flat props: strings (capped), finite numbers, booleans, null. Anything else is dropped. */
function cleanProps(v) {
  if (!isObject(v)) return {};
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (!CLICK_KEY_RE.test(k)) continue;
    if (typeof val === 'string') out[k] = val.slice(0, MAX_STRING);
    else if (typeof val === 'number' && Number.isFinite(val)) out[k] = val;
    else if (typeof val === 'boolean' || val === null) out[k] = val;
  }
  return out;
}

/**
 * Validate and normalise one browser event.
 * @returns {{ ok: true, event: object } | { ok: false, error: 'bad_event', reason: string }}
 */
export function validateEvent(body, { now = Date.now() } = {}) {
  const bad = (reason) => ({ ok: false, error: 'bad_event', reason });
  if (!isObject(body)) return bad('not_an_object');
  if (body.v !== undefined && body.v !== null && body.v !== 1) return bad('version');

  const name = typeof body.event === 'string' ? body.event : '';
  if (SERVER_EVENT_NAMES.includes(name)) return bad('server_only');
  if (!EVENT_NAMES.includes(name)) return bad('event');

  const event_id = id('event_id', body.event_id);
  if (!event_id) return bad('event_id');
  const anon_id = id('anon_id', body.anon_id);
  if (!anon_id) return bad('anon_id');
  const session_id = id('session_id', body.session_id);
  if (!session_id) return bad('session_id');

  let ref = null;
  if (body.ref !== undefined && body.ref !== null) {
    ref = id('ref', body.ref, { upper: true });
    if (!ref) return bad('ref');
  }
  let listing_id = null;
  if (body.listing_id !== undefined && body.listing_id !== null) {
    listing_id = id('listing_id', body.listing_id, { upper: true });
    if (!listing_id) return bad('listing_id');
  }

  const props = cleanProps(body.props);
  if (JSON.stringify(props).length > MAX_PROPS_BYTES) return bad('props_too_large');

  const ts = Number.isFinite(body.ts) && Math.abs(body.ts - now) <= TS_WINDOW_MS ? Math.round(body.ts) : now;
  const locale = String(body.locale ?? '').toLowerCase().startsWith('ar') ? 'ar' : 'en';

  return {
    ok: true,
    event: {
      v: 1, event_id, ts, event: name, anon_id, session_id, ref,
      page: str(body.page), locale, listing_id, props,
      attr: cleanAttr(body.attr), consent: cleanConsent(body.consent),
    },
  };
}

/**
 * Write one validated event: the session upsert (first touch kept, last touch and
 * consent moved, ids refreshed) and the event row carrying the server's view of the
 * request. A WhatsApp click is queued for Meta's Conversions API; the browser pixel
 * sends the same `event_id`, so Meta de-duplicates the pair.
 * @param {ReturnType<import('./db.mjs').openDb>} db
 * @param {object} event  from `validateEvent().event`
 * @param {{ ip?: string|null, ua?: string|null, country?: string|null, received?: number }} server
 * @returns {{ inserted: boolean }}
 */
export function recordEvent(db, event, server = {}) {
  const ip = server.ip ?? null;
  const ua = server.ua ? String(server.ua).slice(0, MAX_STRING) : null;
  const country = server.country ?? null;
  const received = server.received ?? Date.now();
  const a = event.attr ?? cleanAttr(null);
  return db.transaction(() => {
    db.upsertSession({
      session_id: event.session_id, anon_id: event.anon_id, ref: event.ref,
      started: event.ts, last_seen: event.ts, pages: event.event === 'page_view' ? 1 : 0, locale: event.locale,
      first_touch: a.first, last_touch: a.last, fbp: a.fbp, fbc: a.fbc,
      ga_client_id: a.ga?.client_id ?? null, ga_session_id: a.ga?.session_id ?? null, scid: a.scid, ttp: a.ttp,
      ip, ua, country, consent_analytics: event.consent.analytics, consent_ads: event.consent.ads,
    });
    const inserted = db.insertEvent({
      event_id: event.event_id, ts: event.ts, name: event.event, anon_id: event.anon_id, session_id: event.session_id,
      lead_id: null, listing_id: event.listing_id, path: event.page, props: event.props,
      src_first: a.first, src_last: a.last, ip, ua, country,
    });
    if (inserted && event.event === 'whatsapp_click') db.enqueueFanout(event.event_id, ['meta'], { now: received });
    return { inserted };
  });
}
