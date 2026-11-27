/**
 * Published units: what the LIVE listing page shows of a developer unit sheet, which is all search_units may quote
 * (DESIGN §4.5: "published" = what the live site shows). The page's units table carries a machine-readable copy of
 * exactly the summary it prints (src/components/ProjectDetails.astro, data-units-summary on the table container):
 *   {listingId, count, areaMin, areaMax, cashFrom, delivery, updated, rows:[{label:{en,ar}, count, areaMin, areaMax, cashFrom}]}
 * bona-api reads it from the live English listing page instead of summarising units.json itself, so it can never
 * quote a sheet before (or after) the page shows it: a push build that failed, a build still running, a sold
 * listing, an older build without the attribute.
 *
 * One outbound GET per listing per PAGE_TTL_MS at most (failures wait too), timeout FETCH_TIMEOUT_MS, body cap
 * MAX_PAGE_BYTES. Fail closed:
 * - The page answered (200, or 404/410): its summary, or null when it has none, a bad one or another listing's.
 *   That answer replaces the last good one at once.
 * - It did not (network error, timeout, another HTTP status, a body over the cap): the last good summary for at most
 *   LAST_GOOD_MS after it was fetched, then null.
 * Zero dependencies: global fetch, AbortController, TextDecoder.
 */
import { propertyPath } from './inventory.mjs';
import { isDeliveryDate, isSheetDate, unitSummary } from './units-summary.mjs';

export const DEFAULT_SITE = 'https://bona-real-estate.com';
export const FETCH_TIMEOUT_MS = 8_000;
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const PAGE_TTL_MS = 15 * 60 * 1000;
export const LAST_GOOD_MS = 6 * 60 * 60 * 1000;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
/** The most rows a page prints: one per bedroom count 0..MAX_BEDS and the penthouse row, with room to spare. */
const MAX_ROWS = 32;
const MAX_LABEL = 80;
/** The most bedrooms a real unit has; a larger count is some other figure in the wrong column. */
const MAX_BEDS = 20;

/** The English listing page (src/pages/properties/[slug].astro) on `siteUrl`, or null for a site or slug it cannot trust. */
export function listingPageUrl(siteUrl, slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug) || typeof siteUrl !== 'string') return null;
  let base;
  try { base = new URL(siteUrl); } catch { return null; }
  if ((base.protocol !== 'https:' && base.protocol !== 'http:') || base.username || base.password) return null;
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}${propertyPath(slug, 'en')}`;
}

const NAMED = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
/** Undo an attribute's HTML escaping in one pass (so "&amp;quot;" stays "&quot;"); unknown or invalid entities stay. */
export function decodeEntities(s) {
  return String(s).replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] !== '#') return NAMED[e] ?? m;
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
  });
}

let bedLabels = null;
/** True for a row label the listing page builds from whole bedroom counts 0..MAX_BEDS (one count, or a penthouse
    range), taken from lib/units-summary.mjs (the site's labels; the parity test keeps them in step). A malformed
    sheet's label (a unit ref, "null bedrooms", a fraction) is outside this set, so it is never quoted. */
export function isBedLabel(label) {
  if (!bedLabels) {
    const unit = (beds, cls) => ({ beds, class: cls, areaSqm: 1, price: { cash: 1 } });
    const labels = [];
    for (let lo = 0; lo <= MAX_BEDS; lo++) {
      labels.push(unitSummary({ units: [unit(lo, 'Standard')] }).rows[0].label);
      for (let hi = lo; hi <= MAX_BEDS; hi++) labels.push(unitSummary({ units: [unit(lo, 'Penthouse'), unit(hi, 'Penthouse')] }).rows[0].label);
    }
    bedLabels = new Set(labels.map((l) => JSON.stringify([l.en, l.ar])));
  }
  return Boolean(label) && typeof label === 'object' && bedLabels.has(JSON.stringify([label.en, label.ar]));
}

const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const hasKeys = (o, keys) => isPlain(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const amount = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const whole = (n) => Number.isSafeInteger(n) && n >= 0;
const TOP_KEYS = ['listingId', 'count', 'areaMin', 'areaMax', 'cashFrom', 'delivery', 'updated', 'rows'];
const ROW_KEYS = ['label', 'count', 'areaMin', 'areaMax', 'cashFrom'];

function row(r) {
  if (!hasKeys(r, ROW_KEYS) || !hasKeys(r.label, ['en', 'ar'])) return null;
  const { en, ar } = r.label;
  if (typeof en !== 'string' || typeof ar !== 'string' || en.length > MAX_LABEL || ar.length > MAX_LABEL) return null;
  if (!isBedLabel(r.label) || !whole(r.count) || !amount(r.areaMin) || !amount(r.areaMax) || !amount(r.cashFrom)) return null;
  return { label: { en, ar }, count: r.count, areaMin: r.areaMin, areaMax: r.areaMax, cashFrom: r.cashFrom };
}

/** The one summary the page carries for `listingId`, rebuilt key by key from the allow-list; null for anything else. */
function summaryOf(d, listingId) {
  if (!hasKeys(d, TOP_KEYS) || d.listingId !== listingId) return null;
  if (!whole(d.count) || !amount(d.areaMin) || !amount(d.areaMax) || !amount(d.cashFrom)) return null;
  if (!isSheetDate(d.updated) || !(d.delivery === null || isDeliveryDate(d.delivery))) return null;
  if (!Array.isArray(d.rows) || d.rows.length === 0 || d.rows.length > MAX_ROWS) return null;
  const rows = d.rows.map(row);
  if (rows.some((r) => r === null)) return null;
  return {
    listingId: d.listingId, count: d.count, areaMin: d.areaMin, areaMax: d.areaMax, cashFrom: d.cashFrom,
    delivery: d.delivery, updated: d.updated, rows,
  };
}

const ATTR_RE = /\sdata-units-summary\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** The summary a listing page's HTML publishes for `listingId`: its data-units-summary attribute, validated; null
    when there is none, when it is malformed or not exactly the allow-listed shape, when it names another listing,
    or when the page carries two that differ. */
export function parsePublishedUnits(html, listingId) {
  if (typeof html !== 'string' || typeof listingId !== 'string' || !listingId) return null;
  const values = new Set([...html.matchAll(ATTR_RE)].map((m) => m[1] ?? m[2]));
  if (values.size !== 1) return null;
  let data;
  try { data = JSON.parse(decodeEntities([...values][0])); } catch { return null; }
  return summaryOf(data, listingId);
}

class PageError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

/** The body as text, at most `maxBytes` (by its header, then by what arrives). */
async function readCapped(res, maxBytes) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.body?.cancel?.().catch(() => {});
    throw new PageError('too_big');
  }
  if (!res.body?.getReader) {
    const text = await res.text();
    if (Buffer.byteLength(text) > maxBytes) throw new PageError('too_big');
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      reader.cancel().catch(() => {});
      throw new PageError('too_big');
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

/**
 * @param {{ siteUrl?: string, fetch?: typeof fetch, now?: () => number, timeoutMs?: number, maxBytes?: number,
 *   ttlMs?: number, lastGoodMs?: number, log?: (o: object) => void }} [opts]
 *   siteUrl: the live site (bona-api's cfg.siteUrl: BONA_SITE, else src/data/site.json url; DEFAULT_SITE without one).
 * @returns {{ get(listing: {id: string, slug: string}): Promise<null | object> }}
 */
export function createPublishedUnits({
  siteUrl = DEFAULT_SITE, fetch = globalThis.fetch, now = Date.now, timeoutMs = FETCH_TIMEOUT_MS,
  maxBytes = MAX_PAGE_BYTES, ttlMs = PAGE_TTL_MS, lastGoodMs = LAST_GOOD_MS, log = () => {},
} = {}) {
  /** listing id → { checkedAt, answered, good, goodAt, pending }. Bounded by the inventory: only a listing it
      resolved is ever asked for. */
  const cache = new Map();

  /** One GET of the page: { answered: true, value } when the page answered, { answered: false, reason } otherwise. */
  async function check(url, listingId) {
    const ac = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { ac.abort(); reject(new PageError('timeout')); }, timeoutMs);
    });
    timeout.catch(() => {});
    let res = null;
    try {
      res = await Promise.race([
        Promise.resolve().then(() => fetch(url, {
          method: 'GET', redirect: 'follow', signal: ac.signal,
          headers: { accept: 'text/html', 'user-agent': 'bona-api (search_units)' },
        })),
        timeout,
      ]);
      if (res.status === 404 || res.status === 410) {
        res.body?.cancel?.().catch(() => {});
        return { answered: true, value: null };
      }
      if (!res.ok) {
        res.body?.cancel?.().catch(() => {});
        return { answered: false, reason: `http_${res.status}` };
      }
      const html = await Promise.race([readCapped(res, maxBytes), timeout]);
      return { answered: true, value: parsePublishedUnits(html, listingId) };
    } catch (err) {
      if (ac.signal.aborted) res?.body?.cancel?.().catch(() => {});
      return { answered: false, reason: err instanceof PageError ? err.reason : ac.signal.aborted ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  function serve(e, t) {
    if (e.good === null) return null;
    if (e.answered) return e.good;
    return t >= e.goodAt && t - e.goodAt <= lastGoodMs ? e.good : null;
  }

  async function get(listing) {
    const id = listing?.id;
    const url = typeof id === 'string' && id ? listingPageUrl(siteUrl, listing?.slug) : null;
    if (!url) return null;
    let e = cache.get(id);
    if (!e) {
      e = { checkedAt: -Infinity, answered: false, good: null, goodAt: -Infinity, pending: null };
      cache.set(id, e);
    }
    const t = now();
    // A clock behind the last check (it went back) refetches rather than trusting that check for longer.
    if (!(t >= e.checkedAt && t - e.checkedAt < ttlMs)) {
      e.pending ??= check(url, id).then((r) => {
        const at = now();
        e.checkedAt = at;
        e.answered = r.answered;
        if (r.answered) {
          e.good = r.value;
          e.goodAt = at;
        } else {
          log({ level: 'warn', evt: 'units.page_failed', listing: id, reason: r.reason });
        }
      }).finally(() => { e.pending = null; });
      await e.pending;
    }
    return serve(e, now());
  }

  return { get };
}
