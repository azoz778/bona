/**
 * Attribution helpers shared by the event intake, the WhatsApp poller and the
 * lead model.
 *
 *   parseRef(text)        — the `Ref BONA-W003 · K7Q2XR` line the site appends to a
 *                           prefilled WhatsApp message → { listingId, code }
 *   sourceFromTouch(t)    — one touch bundle → { source, medium, campaign, … }
 *   isExternalTouch(t)    — did this arrival come from outside the site?
 *
 * The site's `attribution.js` mirrors these rules; keep the two in step.
 */
import { DEFAULT_ORIGINS } from './cors.mjs';

/** No 0/O/1/I: a code has to survive being read out loud and typed back. */
export const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** `Ref BONA-W003 · K7Q2XR`, `ref bona - k7q2xr`, `Ref K7Q2X` — the listing part is optional. */
export const REF_RE = /\bRef\s+(BONA(?:-W?\d{3})?)?\s*[·\-:|]?\s*([A-HJ-NP-Z2-9]{5,6})\b/i;

/**
 * @param {unknown} text
 * @returns {{ listingId: string|null, code: string }|null}
 */
export function parseRef(text) {
  const m = REF_RE.exec(String(text ?? ''));
  if (!m) return null;
  return { listingId: m[1] ? m[1].toUpperCase() : null, code: m[2].toUpperCase() };
}

const SOCIAL_OR_SEARCH = /(^|\.)(instagram|facebook|google|tiktok|snapchat|x\.com|twitter|linkedin|youtube|whatsapp)(\.|$)/i;

/** Hostname of a referrer without `www.`; null when it is not a URL. */
export function referrerHost(referrer) {
  const s = String(referrer ?? '').trim();
  if (!s) return null;
  try {
    const host = new URL(s).hostname.toLowerCase();
    return host.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

const str = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, 300) : null;
};

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
const LISTING_RE = /^BONA-W?\d{3}$/;
const CLICK_KEYS = new Set(['fbclid', 'gclid', 'gbraid', 'wbraid', 'gad_source', 'gad_campaignid', 'ttclid', 'ScCid', 'msclkid', 'li_fat_id', 'twclid', 'dclid', 'ctwa_clid']);

/** Canonical, allow-listed touch contract shared by all server-side lead paths. */
export function normaliseTouch(value) {
  const t = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const text = (key, { lower = false } = {}) => {
    const v = str(t[key]);
    return v ? (lower ? v.toLowerCase() : v) : null;
  };
  const rawCampaignId = str(t.utm_id ?? t.campaign_id ?? t.campaignid ?? t.gad_campaignid);
  const campaignId = rawCampaignId && TOKEN_RE.test(rawCampaignId) ? rawCampaignId : null;
  const rawListing = str(t.listing_id)?.toUpperCase() ?? null;
  const click_ids = {};
  if (t.click_ids && typeof t.click_ids === 'object' && !Array.isArray(t.click_ids)) {
    for (const [key, raw] of Object.entries(t.click_ids)) {
      const v = typeof raw === 'string' ? raw.trim() : '';
      if (CLICK_KEYS.has(key) && v && v.length <= 300) click_ids[key] = v;
    }
  }
  const out = {
    ts: Number.isFinite(t.ts) ? Math.round(t.ts) : null,
    landing: text('landing'), referrer: text('referrer'),
    utm_source: text('utm_source', { lower: true }), utm_medium: text('utm_medium', { lower: true }),
    utm_campaign: text('utm_campaign'), utm_content: text('utm_content'), utm_term: text('utm_term'),
    utm_id: campaignId,
    listing_id: rawListing && LISTING_RE.test(rawListing) ? rawListing : null,
    click_ids: Object.keys(click_ids).length ? click_ids : null,
    unavailable_reason: null,
  };
  if (!out.utm_source && !out.utm_medium && !out.utm_campaign && !out.utm_id && !out.referrer && !out.click_ids) {
    out.unavailable_reason = 'direct_or_unknown';
  }
  return out;
}

/** Click ids with a non-empty value, or null when there are none. */
function cleanClickIds(ids) {
  if (!ids || typeof ids !== 'object' || Array.isArray(ids)) return null;
  const out = {};
  for (const [k, v] of Object.entries(ids)) {
    const s = str(v);
    if (s && /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(k)) out[k] = s;
  }
  return Object.keys(out).length ? out : null;
}

const CLICK_ID_PLATFORMS = [
  [/^fbclid$/i, 'meta', 'paid'],
  [/^(gclid|gbraid|wbraid)$/i, 'google', 'cpc'],
  [/^sccid$/i, 'snapchat', 'paid'],
  [/^ttclid$/i, 'tiktok', 'paid'],
];

/**
 * Resolve where a touch came from. UTMs win; then a known click id; then the
 * referrer host; else `(direct)`. `campaign_id` is `utm_id` (the ad platform's own
 * campaign id, which is what spend is keyed on).
 * @returns {{ source: string, medium: string, campaign: string|null, campaign_id: string|null, content: string|null, click_ids: object|null }}
 */
export function sourceFromTouch(touch) {
  const t = normaliseTouch(touch);
  const click_ids = cleanClickIds(t.click_ids);
  const base = { campaign: str(t.utm_campaign), campaign_id: str(t.utm_id), content: str(t.utm_content), click_ids };

  const utmSource = str(t.utm_source);
  if (utmSource) return { source: utmSource, medium: str(t.utm_medium) ?? '(not set)', ...base };

  if (click_ids) {
    for (const key of Object.keys(click_ids)) {
      const hit = CLICK_ID_PLATFORMS.find(([re]) => re.test(key));
      if (hit) return { source: hit[1], medium: hit[2], ...base };
    }
  }

  const host = referrerHost(t.referrer);
  if (host) return { source: host, medium: SOCIAL_OR_SEARCH.test(host) ? 'social_or_organic' : 'referral', ...base };

  return { source: '(direct)', medium: '(none)', ...base };
}

const OWN_HOSTS = DEFAULT_ORIGINS.map((o) => referrerHost(o)).filter(Boolean);

/**
 * True when the touch is a new arrival from outside: a UTM, a click id, or a
 * referrer whose host is not one of ours. A visitor walking between our own pages
 * is not an arrival, and neither is a direct hit with no referrer at all.
 */
export function isExternalTouch(touch, { ownHosts = OWN_HOSTS } = {}) {
  const t = touch && typeof touch === 'object' ? touch : null;
  if (!t) return false;
  if (str(t.utm_source) || str(t.utm_medium) || str(t.utm_campaign) || str(t.utm_id)) return true;
  if (cleanClickIds(t.click_ids)) return true;
  const host = referrerHost(t.referrer);
  if (!host) return false;
  return !ownHosts.some((own) => host === own || host.endsWith(`.${own}`));
}
