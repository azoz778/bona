/**
 * Everything the dashboard counts.
 *
 * One broker's site produces a few thousand rows a year, so these are plain queries
 * against `bona.db` run per request — no materialised views, no cache to go stale.
 * The JSON columns (`first_touch`, `src_last`, …) are resolved in JavaScript through
 * `sourceFromTouch`, the same function the lead model used when it wrote them, so a
 * campaign is named identically wherever it appears.
 *
 * Days are Jeddah days. The owner reads this on a phone in Riyadh time and asks "how
 * did yesterday go"; bucketing on UTC would move every evening's traffic into
 * tomorrow. Asia/Riyadh has no DST, so a fixed +03:00 is exact rather than
 * approximate.
 *
 * First touch vs last touch is reported side by side and never blended: the campaign
 * that *found* someone and the one they came back through are different questions,
 * and a single "source" column silently answers only one of them.
 */
import { STAGES } from '../db.mjs';
import { sourceFromTouch } from '../attribution.mjs';

/** Asia/Riyadh, permanently UTC+3. */
export const TZ_OFFSET_MS = 3 * 3_600_000;
export const DAY_MS = 86_400_000;
/** A REGA advertising licence this close to its expiry is a job for this week. */
export const EXPIRY_WARN_MS = 30 * DAY_MS;

/** `YYYY-MM-DD` for an instant, in Jeddah. */
export const dayKey = (ts, offsetMs = TZ_OFFSET_MS) => new Date(Number(ts) + offsetMs).toISOString().slice(0, 10);
/** The instant a Jeddah day begins. */
export const dayStart = (day, offsetMs = TZ_OFFSET_MS) => Date.parse(`${day}T00:00:00Z`) - offsetMs;
/** …and the last millisecond of it, which is when a licence dated that day stops being valid. */
export const dayEnd = (day, offsetMs = TZ_OFFSET_MS) => dayStart(day, offsetMs) + DAY_MS - 1;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;

/** Middle value; the mean of the two middles for an even count. Null for nothing. */
export function median(values) {
  const s = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Nearest-rank percentile (`p` in 0..1). Null for nothing. */
export function percentile(values, p) {
  const s = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const rank = Math.max(1, Math.ceil(p * s.length));
  return s[Math.min(rank, s.length) - 1];
}

/**
 * Ad-platform names arrive from two directions and have to be made to agree: a spend
 * row carries whatever the owner typed on the Spend page, and a lead carries whatever
 * the UTM said — or the referrer host, or the click id it was recognised by.
 *
 * This matters because a campaign id is unique only *inside* one platform. Meta and
 * Snap can both run a campaign `1203`, and matching on the id alone would hand one
 * platform's money to the other's leads. So spend is matched on the pair, and a name
 * nothing recognises matches nothing rather than borrowing someone else's budget.
 */
export const PLATFORM_ALIASES = {
  meta: 'meta', facebook: 'meta', 'facebook.com': 'meta', fb: 'meta', instagram: 'meta', 'instagram.com': 'meta', ig: 'meta',
  google: 'google', 'google.com': 'google', googleads: 'google', adwords: 'google', youtube: 'google', 'youtube.com': 'google',
  snapchat: 'snapchat', snap: 'snapchat', 'snapchat.com': 'snapchat',
  tiktok: 'tiktok', 'tiktok.com': 'tiktok',
  x: 'x', twitter: 'x', 'x.com': 'x', 'twitter.com': 'x',
};

/** A source or a typed platform name, folded to one label. Unknown names pass through. */
export function platformOf(name) {
  const s = String(name ?? '').trim().toLowerCase().replace(/^www\./, '');
  if (!s) return null;
  return Object.hasOwn(PLATFORM_ALIASES, s) ? PLATFORM_ALIASES[s] : s;
}

/** The key spend and leads are joined on: one platform, one campaign id. */
const campaignKey = (platform, campaignId) => `${platformOf(platform) ?? ''}|${campaignId ?? ''}`;

/** The four columns that name a campaign, from one stored touch bundle. */
export function touchKey(touch) {
  const s = sourceFromTouch(touch);
  return { source: s.source, medium: s.medium, campaign: s.campaign, campaign_id: s.campaign_id };
}

const keyOf = (k) => `${k.source ?? ''}|${k.medium ?? ''}|${k.campaign ?? ''}|${k.campaign_id ?? ''}`;

/** A JSON column that may already be an object (db helpers) or still be text (raw SQL). */
function asObject(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

/** `YYYY-MM-DD` (or anything Date can parse) → the instant it stops being valid. */
export function expiryMs(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return dayEnd(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * REGA compliance, per listing. An advertisement without a licence number is the one
 * that costs money — the flags are ordered by how soon the owner has to act.
 * @returns {string[]} any of `no_ad_licence`, `expired`, `expiring_30d`, `wafi_missing`
 */
export function licenceFlags(listing, now = Date.now()) {
  const licence = listing?.licence ?? null;
  const flags = [];
  const adNumber = licence?.adNumber == null ? '' : String(licence.adNumber).trim();
  if (!adNumber) flags.push('no_ad_licence');
  const expires = expiryMs(licence?.adExpiry);
  if (expires !== null) {
    if (expires < now) flags.push('expired');
    else if (expires - now <= EXPIRY_WARN_MS) flags.push('expiring_30d');
  }
  // Off-plan advertising also needs the Wafi (off-plan sales) project number.
  const wafi = licence?.wafiNumber == null ? '' : String(licence.wafiNumber).trim();
  if (listing?.category === 'off-plan' && !wafi) flags.push('wafi_missing');
  return flags;
}

/**
 * @param {object} o
 * @param {ReturnType<import('../db.mjs').openDb>} o.db
 * @param {() => number} [o.now]
 * @param {number} [o.tzOffsetMs]
 */
export function createStats({ db, now = () => Date.now(), tzOffsetMs = TZ_OFFSET_MS } = {}) {
  const cache = new Map();
  /** Same statement cache the store keeps: each query text is compiled once. */
  const prep = (text) => {
    let stmt = cache.get(text);
    if (!stmt) { stmt = db.db.prepare(text); cache.set(text, stmt); }
    return stmt;
  };
  const all = (text, ...params) => prep(text).all(...params).map((r) => ({ ...r }));
  const one = (text, ...params) => { const r = prep(text).get(...params); return r ? { ...r } : null; };

  // The only value this module ever interpolates into SQL rather than binding, so it is
  // forced to a number here and cannot be anything else by the time it reaches a query.
  const offset = Number.isFinite(Number(tzOffsetMs)) ? Math.trunc(Number(tzOffsetMs)) : TZ_OFFSET_MS;
  /** SQLite integer division floors, which is what a day bucket wants. */
  const DAY_EXPR = (col) => `date((${col} + ${offset}) / 1000, 'unixepoch')`;

  /**
   * The strip across the top of the Overview: one row per day, oldest first, days with
   * nothing on them included so the shape of a quiet week is visible.
   * @returns {{day: string, sessions: number, wa_clicks: number, leads: number, viewings: number}[]}
   */
  function overviewDaily(days = 14) {
    const span = Math.max(1, Math.min(365, Math.floor(Number(days) || 14)));
    const t = now();
    const today = dayKey(t, offset);
    const from = dayStart(today, offset) - (span - 1) * DAY_MS;

    const blank = () => ({ sessions: 0, wa_clicks: 0, leads: 0, viewings: 0 });
    const byDay = new Map();
    for (let i = 0; i < span; i += 1) byDay.set(dayKey(from + i * DAY_MS, offset), blank());

    for (const r of all(
      `SELECT ${DAY_EXPR('ts')} AS day, COUNT(DISTINCT session_id) AS sessions,
              SUM(CASE WHEN name = 'whatsapp_click' THEN 1 ELSE 0 END) AS wa_clicks
       FROM events WHERE ts >= ? GROUP BY day`, from)) {
      const row = byDay.get(r.day);
      if (row) { row.sessions = num(r.sessions); row.wa_clicks = num(r.wa_clicks); }
    }
    for (const r of all(`SELECT ${DAY_EXPR('created')} AS day, COUNT(*) AS n FROM leads WHERE created >= ? GROUP BY day`, from)) {
      const row = byDay.get(r.day);
      if (row) row.leads = num(r.n);
    }
    for (const r of all(
      `SELECT ${DAY_EXPR('ts')} AS day, COUNT(DISTINCT lead_id) AS n FROM lead_stage_history
       WHERE stage = 'viewing' AND ts >= ? GROUP BY day`, from)) {
      const row = byDay.get(r.day);
      if (row) row.viewings = num(r.n);
    }
    return [...byDay.entries()].map(([day, v]) => ({ day, ...v }));
  }

  /** Spend summed per platform and campaign id — see `PLATFORM_ALIASES` for why both. */
  function spendByCampaign() {
    const out = new Map();
    for (const r of all('SELECT platform, campaign_id, SUM(spend_sar) AS spend FROM ad_spend GROUP BY platform, campaign_id')) {
      if (!r.campaign_id) continue;
      const key = campaignKey(r.platform, r.campaign_id);
      out.set(key, round2((out.get(key) ?? 0) + num(r.spend)));
    }
    return out;
  }

  /**
   * Where the leads came from, counted twice on purpose.
   *
   * `last_touch_leads` is the campaign the lead's own columns record — the visit the
   * enquiry happened on. `first_touch_leads` is the campaign that brought the person
   * to the site in the first place, resolved from the stored first-touch bundle. A
   * lead whose two touches differ appears in one row for each; the columns are not
   * meant to add up to the same total, and the difference is the point.
   *
   * A lead with no session behind it (a WhatsApp match with no click to tie it to)
   * has one touch, not two: its first-touch row is its last-touch row.
   */
  function sources() {
    const rows = new Map();
    const row = (k) => {
      const key = keyOf(k);
      let r = rows.get(key);
      if (!r) {
        r = { ...k, first_touch_leads: 0, last_touch_leads: 0, wa_clicks: 0, spend_sar: 0, cpl: null };
        rows.set(key, r);
      }
      return r;
    };

    for (const l of all('SELECT source, medium, campaign, campaign_id, first_touch FROM leads')) {
      const last = {
        source: l.source ?? '(direct)', medium: l.medium ?? '(none)',
        campaign: l.campaign ?? null, campaign_id: l.campaign_id ?? null,
      };
      row(last).last_touch_leads += 1;
      const first = asObject(l.first_touch);
      row(first ? touchKey(first) : last).first_touch_leads += 1;
    }

    for (const e of all("SELECT src_last, src_first FROM events WHERE name = 'whatsapp_click'")) {
      row(touchKey(asObject(e.src_last) ?? asObject(e.src_first))).wa_clicks += 1;
    }

    const spend = spendByCampaign();
    for (const r of rows.values()) {
      const key = r.campaign_id ? campaignKey(r.source, r.campaign_id) : null;
      if (key && spend.has(key)) r.spend_sar = spend.get(key);
      // Cost per lead is spend over the leads that *converted* on this campaign, so it
      // pairs with the money; it stays null when either half is missing rather than
      // printing a zero or an Infinity the owner would have to interpret.
      r.cpl = r.spend_sar > 0 && r.last_touch_leads > 0 ? round2(r.spend_sar / r.last_touch_leads) : null;
    }

    return [...rows.values()].sort((a, b) =>
      b.last_touch_leads - a.last_touch_leads ||
      b.first_touch_leads - a.first_touch_leads ||
      b.wa_clicks - a.wa_clicks ||
      String(a.source).localeCompare(String(b.source)));
  }

  /**
   * How the leads were tied to their traffic. `time_window` is an inference, not a
   * fact, so the split is the honesty check on every number above it.
   */
  function matchQuality() {
    return all(`SELECT COALESCE(match_method, '(unknown)') AS match_method, COUNT(*) AS count
                FROM leads GROUP BY match_method ORDER BY count DESC, match_method ASC`)
      .map((r) => ({ match_method: r.match_method, count: num(r.count) }));
  }

  /**
   * The board, in stage order, with how long the leads in each stage have been sitting
   * there. A large median on `contacted` is the dashboard saying nobody followed up.
   */
  function pipeline() {
    const t = now();
    const ages = new Map(STAGES.map((s) => [s, []]));
    for (const l of all('SELECT stage, stage_ts, updated, created FROM leads')) {
      const bucket = ages.get(l.stage);
      if (!bucket) continue;
      bucket.push(Math.max(0, t - num(l.stage_ts ?? l.updated ?? l.created)));
    }
    return STAGES.map((stage) => {
      const bucket = ages.get(stage);
      const m = median(bucket);
      return { stage, count: bucket.length, median_age_h: m === null ? null : round1(m / 3_600_000) };
    });
  }

  /**
   * How long the owner takes to answer a first WhatsApp message. Only leads with both
   * timestamps count; a reply logged before the inbound message is a clock artefact
   * and is dropped rather than reported as a negative minute.
   * @returns {{median_min: number|null, p90_min: number|null, count: number}}
   */
  function responseTimes() {
    const deltas = all(`SELECT (first_reply_ts - first_inbound_ts) AS d FROM leads
                        WHERE first_inbound_ts IS NOT NULL AND first_reply_ts IS NOT NULL AND first_reply_ts >= first_inbound_ts`)
      .map((r) => num(r.d));
    const m = median(deltas);
    const p90 = percentile(deltas, 0.9);
    return {
      median_min: m === null ? null : round1(m / 60_000),
      p90_min: p90 === null ? null : round1(p90 / 60_000),
      count: deltas.length,
    };
  }

  /**
   * Per listing: how far down the funnel its visitors got, and whether it is legal to
   * be advertising it at all.
   * @param {Array|{all: () => Array}} inventory  the listings, or the inventory holder
   */
  function listingFunnel(inventory) {
    const listings = typeof inventory?.all === 'function' ? inventory.all() : (Array.isArray(inventory) ? inventory : []);
    const t = now();

    const events = new Map();
    for (const r of all('SELECT listing_id, name, COUNT(*) AS n FROM events WHERE listing_id IS NOT NULL GROUP BY listing_id, name')) {
      const byName = events.get(r.listing_id) ?? new Map();
      byName.set(r.name, num(r.n));
      events.set(r.listing_id, byName);
    }
    const leads = new Map();
    for (const r of all('SELECT listing_id, COUNT(*) AS n FROM leads WHERE listing_id IS NOT NULL GROUP BY listing_id')) {
      leads.set(r.listing_id, num(r.n));
    }

    return listings.map((l) => {
      const byName = events.get(l.id) ?? new Map();
      const count = (name) => byName.get(name) ?? 0;
      return {
        listing_id: l.id,
        title: l.title?.en || l.title?.ar || l.slug || l.id,
        status: l.status ?? null,
        category: l.category ?? null,
        views: count('listing_view'),
        gallery: count('gallery_open'),
        tour: count('tour_open'),
        brochure: count('brochure_download'),
        wa_clicks: count('whatsapp_click'),
        leads: leads.get(l.id) ?? 0,
        licence: l.licence ?? null,
        flags: licenceFlags(l, t),
      };
    }).sort((a, b) => b.leads - a.leads || b.wa_clicks - a.wa_clicks || b.views - a.views || String(a.listing_id).localeCompare(String(b.listing_id)));
  }

  /**
   * Money against leads, per campaign. Rows come from `ad_spend`, so a campaign that
   * has taken money and produced nothing still appears — that is the row worth seeing.
   */
  function cplByCampaign() {
    const leads = new Map();
    for (const r of all("SELECT source, campaign_id, COUNT(*) AS n FROM leads WHERE campaign_id IS NOT NULL AND campaign_id != '' GROUP BY source, campaign_id")) {
      const key = campaignKey(r.source, r.campaign_id);
      leads.set(key, (leads.get(key) ?? 0) + num(r.n));
    }
    return all(`SELECT platform, campaign_id, MAX(campaign_name) AS campaign_name,
                       SUM(spend_sar) AS spend_sar, SUM(clicks) AS clicks, SUM(impressions) AS impressions
                FROM ad_spend GROUP BY platform, campaign_id`)
      .map((r) => {
        const spend = round2(num(r.spend_sar));
        const n = leads.get(campaignKey(r.platform, r.campaign_id)) ?? 0;
        return {
          platform: r.platform,
          campaign_id: r.campaign_id ?? null,
          campaign_name: r.campaign_name ?? null,
          spend_sar: spend,
          clicks: r.clicks === null ? null : num(r.clicks),
          impressions: r.impressions === null ? null : num(r.impressions),
          leads: n,
          cpl: spend > 0 && n > 0 ? round2(spend / n) : null,
        };
      })
      .sort((a, b) => b.spend_sar - a.spend_sar || String(a.campaign_id).localeCompare(String(b.campaign_id)));
  }

  /**
   * One lead's whole history in one list: the pages they looked at, every touch, every
   * stage move and every note the owner wrote, oldest first.
   *
   * Browser events are pulled by the lead's session as well as by `lead_id`, because
   * the interesting half of the journey — the six properties they read before saying
   * anything — happened while they were still anonymous.
   */
  function leadJourney(leadId) {
    const id = String(leadId ?? '');
    const lead = db.getLead(id);
    if (!lead) return [];
    const out = [];

    const events = lead.session_id
      ? all('SELECT * FROM events WHERE lead_id = ? OR session_id = ? ORDER BY ts ASC, rowid ASC', id, lead.session_id)
      : all('SELECT * FROM events WHERE lead_id = ? ORDER BY ts ASC, rowid ASC', id);
    for (const e of events) {
      out.push({
        ts: num(e.ts), kind: 'event', name: e.name,
        listing_id: e.listing_id ?? null, path: e.path ?? null, props: asObject(e.props) ?? {},
      });
    }

    for (const tp of db.touchpointsForLead(id)) {
      const meta = tp.meta ?? {};
      if (tp.event_type === 'note') {
        out.push({ ts: num(tp.ts), kind: 'note', text: meta.note ?? '', actor: meta.actor ?? 'owner' });
        continue;
      }
      out.push({
        ts: num(tp.ts), kind: 'touchpoint', channel: tp.channel, event_type: tp.event_type,
        source: tp.source ?? null, medium: tp.medium ?? null, campaign: tp.campaign ?? null,
        listing_id: tp.listing_id ?? null, meta,
      });
    }

    for (const s of db.stageHistory(id)) {
      out.push({ ts: num(s.ts), kind: 'stage', stage: s.stage, actor: s.actor ?? null, note: s.note ?? null });
    }

    // A stage move and the touchpoint that caused it share a millisecond; the order
    // within one instant is events → touchpoints → stages → notes, which reads as cause
    // before effect.
    const rank = { event: 0, touchpoint: 1, stage: 2, note: 3 };
    return out.sort((a, b) => a.ts - b.ts || rank[a.kind] - rank[b.kind]);
  }

  /** Everything `GET /v1/admin/stats` answers with. */
  function overview(days = 14) {
    return {
      days: Math.max(1, Math.min(365, Math.floor(Number(days) || 14))),
      generated: now(),
      daily: overviewDaily(days),
      sources: sources(),
      match_quality: matchQuality(),
      pipeline: pipeline(),
      response_times: responseTimes(),
      cpl_by_campaign: cplByCampaign(),
      totals: {
        leads: num(one('SELECT COUNT(*) AS n FROM leads')?.n),
        sessions: num(one('SELECT COUNT(*) AS n FROM sessions')?.n),
        events: num(one('SELECT COUNT(*) AS n FROM events')?.n),
      },
    };
  }

  return { overviewDaily, sources, matchQuality, pipeline, responseTimes, listingFunnel, cplByCampaign, leadJourney, overview };
}
