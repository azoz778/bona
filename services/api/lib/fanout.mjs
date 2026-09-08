/**
 * Server-side fan-out: the events the browser cannot be trusted to deliver.
 *
 * A pixel in a browser is blocked, throttled and consent-gated; the interesting
 * moments (a WhatsApp click, a lead) are exactly the ones an ad blocker eats. So
 * `db.enqueueFanout()` queues those events here and this worker re-sends them from the
 * server, carrying the same `event_id` the browser pixel used — Meta, GA4 and Snap all
 * de-duplicate on it, so a person who saw both is counted once.
 *
 * Everything is optional. A destination with no credentials is not an error and not a
 * backlog: its rows are marked `skipped` the first time they come due, so the queue
 * stays empty and `/health` keeps telling the truth. Fill the ids and tokens into
 * `~/.secrets/bona-marketing.env` and the same rows start flowing on the next event —
 * no code change, no restart beyond the service picking up the env file.
 *
 * Consent: ad-platform destinations are for advertising, so a row is sent only when the
 * visitor's session recorded `consent_ads`. No session, or no ads consent, and the row
 * is `skipped` with the reason on it. `BONA_FANOUT_REQUIRE_CONSENT=0` lifts that for a
 * deployment whose legal basis is different; the default is to require it (PDPL).
 */
import crypto from 'node:crypto';
import { newId } from './db.mjs';

/** Where a queued event goes, per destination. An event with no mapping is skipped. */
export const META_EVENT = {
  lead_created: 'Lead',
  form_submit: 'Lead',
  whatsapp_click: 'Contact',
  call_click: 'Contact',
  concierge_chat_start: 'Contact',
  concierge_call_start: 'Contact',
  listing_view: 'ViewContent',
};

export const GA4_EVENT = {
  lead_created: 'generate_lead',
  form_submit: 'generate_lead',
  whatsapp_click: 'whatsapp_click',
  call_click: 'call_click',
  concierge_chat_start: 'concierge_open',
  concierge_call_start: 'concierge_open',
  listing_view: 'view_item',
};

export const SNAP_EVENT = {
  lead_created: 'SIGN_UP',
  form_submit: 'SIGN_UP',
  whatsapp_click: 'CUSTOM_EVENT_1',
  listing_view: 'VIEW_CONTENT',
};

/**
 * A pipeline move is one event name — `lead_stage` — carrying the stage in its props,
 * so the mapping is by stage rather than by event name.
 *
 * The point of sending these at all is that the ad platforms optimise on what they are
 * told is *good*. A campaign judged on `Lead` buys the cheapest leads there are; the
 * same campaign judged on `Purchase` buys the ones that close. So the stages that mean
 * something commercially travel, and the intermediate ones the owner uses for his own
 * bookkeeping (`new`, `contacted`) stay here — a platform that hears about every
 * clerical move learns nothing from any of them.
 *
 * Google's lead-lifecycle vocabulary (`qualify_lead` -> `working_lead` ->
 * `close_convert_lead` / `close_unconvert_lead`) is a chain, so GA4 hears the whole
 * pipeline; Meta and Snap have names only for the two moments they can bid on.
 */
export const STAGE_META = { viewing: 'Schedule', won: 'Purchase' };
export const STAGE_GA4 = {
  qualified: 'qualify_lead',
  viewing: 'working_lead', offer: 'working_lead', negotiation: 'working_lead',
  won: 'close_convert_lead', lost: 'close_unconvert_lead',
};
export const STAGE_SNAP = { won: 'PURCHASE' };

/** A mapping lookup that cannot answer with a prototype member. */
const mapped = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : null);

/** Which destinations have a name for this stage. `[]` means the move stays private. */
export function stageDests(stage) {
  const out = [];
  if (mapped(STAGE_META, stage)) out.push('meta');
  if (mapped(STAGE_GA4, stage)) out.push('ga4');
  if (mapped(STAGE_SNAP, stage)) out.push('snap');
  return out;
}

/** Give up after this many tries; the row then reads `failed` on the Integrations board. */
export const MAX_ATTEMPTS = 6;
/** 1 min, 2, 4, 8, 16, 32 — capped, so a long outage does not push a row a day out. */
export const backoffMs = (attempts) => Math.min(2 ** Math.max(0, attempts) * 60_000, 6 * 3_600_000);

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
/** Meta/Snap want lower-cased, whitespace-stripped values, hashed. Digits only for a phone. */
const hashPhone = (v) => {
  const digits = String(v ?? '').replace(/\D/g, '');
  return digits ? sha256(digits) : null;
};
const hashText = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  return s ? sha256(s) : null;
};
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''));

/**
 * The platform's name for this event: by stage for `lead_stage`, by event name
 * otherwise. Both lookups go through `mapped`, so a row carrying `constructor` where a
 * name belongs is an event nobody has a name for rather than a function.
 */
const nameFor = (byEvent, byStage, event) =>
  (event.name === 'lead_stage' ? mapped(byStage, event.props?.stage) : mapped(byEvent, event.name));

/** The deal value a `won` move carries, in SAR. Anything else has none. */
function stageValue(event) {
  if (event.name !== 'lead_stage') return null;
  const v = Number(event.props?.value_sar);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * A retryable failure is one that could plausibly work later: a network error, a
 * throttle, or anything 5xx. A 4xx is the platform telling us the payload or the token
 * is wrong, and re-sending it a hundred times will not change that.
 */
export const isRetryable = (status) => status === 0 || status === 429 || status >= 500;

/* ------------------------------------------------------------------ payloads */

/**
 * The client context a Conversions API needs to match the event to a person: the
 * platform's own cookie ids where the browser handed them over, plus the lead's phone,
 * hashed. Nothing unhashed but the ids the platform itself set.
 */
function userData(session, lead, dest) {
  const ip = session?.ip ?? null;
  const ua = session?.ua ?? null;
  if (dest === 'meta') {
    return compact({
      client_ip_address: ip, client_user_agent: ua,
      fbp: session?.fbp ?? null, fbc: session?.fbc ?? null,
      ph: hashPhone(lead?.phone_e164), fn: hashText(lead?.name?.split(' ')[0]),
      country: hashText(session?.country),
    });
  }
  if (dest === 'snap') {
    return compact({
      client_ip_address: ip, client_user_agent: ua,
      hashed_phone_number: hashPhone(lead?.phone_e164),
      uuid_c1: session?.scid ?? null,
    });
  }
  return compact({ client_ip_address: ip, client_user_agent: ua });
}

/** `https://<site>/<path>` for the page the event happened on, when it happened on one. */
function sourceUrl(event, siteUrl) {
  const path = typeof event.path === 'string' && event.path.startsWith('/') ? event.path : null;
  if (!siteUrl) return null;
  return path ? `${String(siteUrl).replace(/\/+$/, '')}${path}` : `${String(siteUrl).replace(/\/+$/, '')}/`;
}

export function buildMeta(event, { session, lead, cfg }) {
  const name = nameFor(META_EVENT, STAGE_META, event);
  if (!name) return null;
  const value = stageValue(event);
  return {
    url: `https://graph.facebook.com/v21.0/${encodeURIComponent(cfg.metaPixelId)}/events`,
    body: compact({
      data: [compact({
        event_name: name,
        event_time: Math.floor(event.ts / 1000),
        event_id: event.event_id,
        action_source: 'website',
        event_source_url: sourceUrl(event, cfg.siteUrl),
        user_data: userData(session, lead, 'meta'),
        custom_data: compact({
          content_ids: event.listing_id ? [event.listing_id] : undefined,
          content_type: event.listing_id ? 'product' : undefined,
          content_category: event.props?.form ?? event.props?.stage ?? undefined,
          // A Purchase with no value is an optimisation target Meta cannot rank, so the
          // deal size travels with the won stage. Everything else has none, and sending
          // a zero would be worse than sending nothing.
          value: value ?? undefined,
          currency: value ? 'SAR' : undefined,
        }),
      })],
      test_event_code: cfg.metaTestEventCode || undefined,
      access_token: cfg.metaCapiToken,
    }),
  };
}

export function buildGa4(event, { session, lead, cfg }) {
  const name = nameFor(GA4_EVENT, STAGE_GA4, event);
  if (!name) return null;
  const value = stageValue(event);
  // GA4 needs a client id. The browser's `_ga` value is the one that stitches this
  // event onto the same user the gtag pixel reported; the anon id is the fallback so a
  // consented visitor with no GA cookie yet is still counted once, consistently.
  const clientId = session?.ga_client_id || (event.anon_id ? `${parseInt(event.anon_id.slice(0, 8), 16)}.${Math.floor(event.ts / 1000)}` : null);
  if (!clientId) return null;
  return {
    url: `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(cfg.ga4MeasurementId)}&api_secret=${encodeURIComponent(cfg.ga4ApiSecret)}`,
    body: {
      client_id: String(clientId),
      non_personalized_ads: !(session?.consent_ads === 1),
      events: [{
        name,
        params: compact({
          engagement_time_msec: 1,
          // GA4 does not de-duplicate a Measurement Protocol hit against a gtag hit the way
          // Meta does — but it cannot even be done downstream (in BigQuery, or by a report
          // filter) unless the id travels. The browser sends the same value as an event
          // parameter, so the pair is at least recognisable as one event.
          event_id: event.event_id,
          session_id: session?.ga_session_id ?? undefined,
          listing_id: event.listing_id ?? undefined,
          ref: session?.ref ?? undefined,
          source: lead?.source ?? undefined,
          medium: lead?.medium ?? undefined,
          campaign: lead?.campaign ?? undefined,
          lead_stage: event.props?.stage ?? undefined,
          value: value ?? undefined,
          currency: value ? 'SAR' : undefined,
        }),
      }],
    },
  };
}

export function buildSnap(event, { session, lead, cfg }) {
  const name = nameFor(SNAP_EVENT, STAGE_SNAP, event);
  if (!name) return null;
  const value = stageValue(event);
  return {
    url: `https://tr.snapchat.com/v3/${encodeURIComponent(cfg.snapPixelId)}/events`,
    headers: { Authorization: `Bearer ${cfg.snapCapiToken}` },
    body: {
      data: [compact({
        event_name: name,
        event_time: event.ts,
        event_id: event.event_id,
        action_source: 'WEB',
        event_source_url: sourceUrl(event, cfg.siteUrl),
        user_data: userData(session, lead, 'snap'),
        custom_data: value ? { price: value, currency: 'SAR' } : undefined,
      })],
    },
  };
}

const BUILDERS = { meta: buildMeta, ga4: buildGa4, snap: buildSnap };

/** Which destinations have everything they need. Missing credentials are normal. */
export function configuredDests(cfg) {
  return {
    meta: Boolean(cfg.metaPixelId && cfg.metaCapiToken),
    ga4: Boolean(cfg.ga4MeasurementId && cfg.ga4ApiSecret),
    snap: Boolean(cfg.snapPixelId && cfg.snapCapiToken),
  };
}

/* ------------------------------------------------------------------ stage moves */

/**
 * Record a pipeline move and queue it for whichever platforms have a name for it.
 *
 * The dashboard is the only caller: the owner drags a lead to `won`, and this is what
 * turns that click into a `Purchase` at Meta and a `close_convert_lead` at Google. The
 * event row is written whatever the stage is — it is the lead's own history and the
 * dashboard reads it back — but only the mapped stages are queued, so `contacted` costs
 * one insert and no outbound request.
 *
 * The event carries the lead's session context (ip, ua, the touch bundles) so the
 * Conversions APIs can still match the person months after the click that found them.
 *
 * @param {ReturnType<import('./db.mjs').openDb>} db
 * @param {object} lead                              a `leads` row
 * @param {{ stage: string, valueSar?: number|null, now?: number }} o
 * @returns {{ event: object, dests: string[], queued: number }}
 */
export function enqueueStage(db, lead, { stage, valueSar = null, now = Date.now() } = {}) {
  const session = lead?.session_id ? db.getSession(lead.session_id) : null;
  const value = Number(valueSar);
  const event = {
    event_id: newId('ev'),
    ts: now,
    name: 'lead_stage',
    anon_id: lead?.anon_id ?? session?.anon_id ?? null,
    session_id: lead?.session_id ?? null,
    lead_id: lead?.lead_id ?? null,
    listing_id: lead?.listing_id ?? null,
    path: null,
    props: compact({ stage, value_sar: Number.isFinite(value) && value > 0 ? value : null }),
    src_first: lead?.first_touch ?? session?.first_touch ?? null,
    src_last: lead?.last_touch ?? session?.last_touch ?? null,
    ip: session?.ip ?? null,
    ua: session?.ua ?? null,
    country: session?.country ?? null,
  };
  db.insertEvent(event);
  const dests = stageDests(stage);
  const queued = dests.length ? db.enqueueFanout(event.event_id, dests, { now }) : 0;
  return { event, dests, queued };
}

/* ------------------------------------------------------------------ worker */

/**
 * @param {object} o
 * @param {ReturnType<import('./db.mjs').openDb>} o.db
 * @param {object} o.cfg                 loadConfig() — ids and tokens, all optional
 * @param {(obj: object) => void} [o.log]
 * @param {typeof globalThis.fetch} [o.fetch]
 * @param {() => number} [o.now]
 */
export function createFanout({ db, cfg, log = () => {}, fetch: doFetch = globalThis.fetch, now = () => Date.now(), timeoutMs = 10_000 } = {}) {
  const requireConsent = cfg.fanoutRequireConsent !== false;
  let timer = null;
  let running = false;

  const dests = () => configuredDests(cfg);

  /** Is this destination allowed to hear about this event at all? */
  function verdict(dest, event, session) {
    if (!dests()[dest]) return { skip: 'no_credentials' };
    if (!BUILDERS[dest]) return { skip: 'unknown_dest' };
    if (requireConsent && session?.consent_ads !== 1) return { skip: 'no_ads_consent' };
    return { skip: null };
  }

  async function post({ url, body, headers }) {
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text().catch(() => '');
      return { status: res.status, ok: res.ok, text: text.slice(0, 2000) };
    } catch (err) {
      return { status: 0, ok: false, text: String(err?.message ?? err).slice(0, 500) };
    }
  }

  /**
   * Send every row that is due. Safe to call at any time; a second call while the first
   * is still in flight returns immediately rather than sending anything twice.
   * @returns {Promise<{ sent: number, skipped: number, retried: number, failed: number }>}
   */
  async function drainOnce({ limit = 100 } = {}) {
    if (running) return { sent: 0, skipped: 0, retried: 0, failed: 0, busy: true };
    running = true;
    const tally = { sent: 0, skipped: 0, retried: 0, failed: 0 };
    try {
      const t = now();
      for (const row of db.dueFanout(t, { limit })) {
        const event = db.getEvent(row.event_id);
        if (!event) {
          db.markFanout(row.event_id, row.dest, { status: 'skipped', lastError: 'event_missing' });
          tally.skipped += 1;
          continue;
        }
        const session = event.session_id ? db.getSession(event.session_id) : null;
        const lead = event.lead_id ? db.getLead(event.lead_id) : null;

        const { skip } = verdict(row.dest, event, session);
        if (skip) {
          db.markFanout(row.event_id, row.dest, { status: 'skipped', lastError: skip });
          tally.skipped += 1;
          continue;
        }
        const req = BUILDERS[row.dest](event, { session, lead, cfg });
        if (!req) {
          db.markFanout(row.event_id, row.dest, { status: 'skipped', lastError: 'no_mapping' });
          tally.skipped += 1;
          continue;
        }

        const res = await post(req);
        const attempts = (row.attempts ?? 0) + 1;
        if (res.ok) {
          db.markFanout(row.event_id, row.dest, { status: 'sent', attempts, lastError: null, response: res.text });
          tally.sent += 1;
          continue;
        }
        const retry = isRetryable(res.status) && attempts < MAX_ATTEMPTS;
        db.markFanout(row.event_id, row.dest, {
          status: retry ? 'pending' : 'failed',
          attempts,
          nextAt: retry ? t + backoffMs(attempts) : undefined,
          lastError: `HTTP ${res.status} ${res.text}`.slice(0, 500),
        });
        if (retry) tally.retried += 1; else tally.failed += 1;
        log({ level: retry ? 'warn' : 'error', evt: 'fanout.failed', dest: row.dest, eventId: row.event_id, status: res.status, attempts, retry });
      }
    } finally {
      running = false;
    }
    if (tally.sent || tally.failed || tally.retried) log({ evt: 'fanout.drain', ...tally });
    return tally;
  }

  function start({ intervalMs = cfg.fanoutMs ?? 20_000 } = {}) {
    if (timer || !(intervalMs > 0)) return false;
    timer = setInterval(() => { drainOnce().catch((err) => log({ level: 'error', evt: 'fanout.drain_failed', error: String(err?.message ?? err) })); }, intervalMs);
    // The queue must never be the reason the process stays alive.
    if (typeof timer.unref === 'function') timer.unref();
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    drainOnce, start, stop, dests,
    /** The dashboard's stage form goes through here so the queueing rules live in one place. */
    enqueueStage: (lead, opts) => enqueueStage(db, lead, { now: now(), ...opts }),
    counts: () => db.fanoutCounts(),
    get started() { return Boolean(timer); },
  };
}
