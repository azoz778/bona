import * as R from '../lib/dashboard/render.mjs';

/**
 * Render every dashboard page with deliberately hostile, null-heavy input.
 *
 * Templates receive real DB rows, and in this schema almost every column is nullable.
 * A page that throws is a 500 on the owner's phone; a page that emits raw markup is an
 * XSS; a page that prints "undefined" or a 1970 date is lying to him. None of those
 * should be possible, so this asserts all three across every exported page.
 */
const now = Date.now();
let bad = 0;
const ok = (label, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) bad += 1;
};

const EVIL = '<img src=x onerror=alert(1)>';
const ATTR = '" onmouseover="alert(1)" x="';

const hostile = {
  lead_id: 'x"><script>alert(1)</script>', name: EVIL, phone_e164: 'javascript:alert(1)//966500000000',
  stage: "'; DROP TABLE leads;--", stage_ts: null, created: null, updated: null,
  first_inbound_ts: null, first_reply_ts: null, source: ATTR, medium: ATTR, campaign: ATTR,
  campaign_id: ATTR, listing_id: ATTR, district: ATTR, language: null, notes: EVIL,
  value_sar: null, match_method: ATTR, interest: EVIL, timeline: ATTR, channel: ATTR, wa_jid: null,
};
const allNull = Object.fromEntries(Object.keys(hostile).map((k) => [k, null]));
allNull.lead_id = 'n';

const pages = {
  overviewPage: () => R.overviewPage({
    daily: [], sources: [{ source: ATTR, medium: ATTR, campaign: ATTR, campaign_id: ATTR,
      first_touch_leads: null, last_touch_leads: null, wa_clicks: null, spend_sar: null, cpl: null }],
    matchQuality: [{ match_method: ATTR, count: null }],
    responseTimes: { median_min: null, p90_min: null, count: 0 },
    pipeline: [{ stage: ATTR, count: null, median_age_h: null }],
    days: 14, waiting: [hostile, allNull], waitingTotal: null, now,
  }),
  'overviewPage (missing sections)': () => R.overviewPage({
    daily: [], sources: [], matchQuality: [],
    responseTimes: { median_min: null, p90_min: null, count: 0 }, days: 14,
  }),
  leadsPage: () => R.leadsPage({
    board: { new: [hostile, allNull] }, counts: { new: '99', contacted: 7n },
    leads: [hostile, allNull], stage: ATTR, q: EVIL, now, total: 106,
  }),
  'leadsPage (null leads)': () => R.leadsPage({ board: {}, counts: null, leads: null, total: 0, now }),
  leadDetailPage: () => R.leadDetailPage({ lead: hostile, journey: [], now }),
  'leadDetailPage (all null)': () => R.leadDetailPage({ lead: allNull, journey: [], now }),
  // Shapes below mirror what the ROUTE actually passes (statistics.listingFunnel /
  // keyPresence), not an invented shape — a fixture that lies proves nothing.
  listingsPage: () => R.listingsPage({ rows: [{ listing_id: ATTR, title: EVIL, category: ATTR,
    status: ATTR, views: null, gallery: null, tour: null, brochure: null, wa_clicks: null,
    leads: null, licence: null, flags: [ATTR] }] }),
  spendPage: () => R.spendPage({ rows: [{ day: null, platform: ATTR, campaign_id: ATTR,
    campaign_name: EVIL, spend_sar: null }], campaigns: [ATTR], today: null, windowDays: 90 }),
  integrationsPage: () => R.integrationsPage({
    keys: [{ label: ATTR, present: false, note: EVIL }],
    fanout: { counts: { pending: null, sent: null, failed: null, skipped: null }, dests: { meta: false, ga4: false, snap: false } },
    retell: ATTR, poller: { lastRun: null, lag: null, unmatched: null }, lastAccepted: null, db: false }),
  loginPage: () => R.loginPage({ step: 'code', error: ATTR, sent: true }),
  logoutPage: () => R.logoutPage(),
  messagePage: () => R.messagePage({ title: EVIL, message: ATTR }),
};

for (const [name, fn] of Object.entries(pages)) {
  let html;
  try {
    html = fn();
  } catch (err) {
    ok(`${name} renders`, false, err.message);
    continue;
  }
  const problems = [];
  if (/<img|<script/i.test(html)) problems.push('raw markup');
  if (/\son[a-z]+\s*=\s*"/i.test(html.replace(/&quot;/g, ''))) problems.push('inline handler');
  if (/href\s*=\s*"javascript:/i.test(html)) problems.push('javascript: href');
  if (/undefined|NaN/.test(html)) problems.push('undefined/NaN');
  if (/1970-01-01/.test(html)) problems.push('epoch date');
  if (/\d{4,}[\s\u00a0]d\b/.test(html)) problems.push('absurd duration');
  ok(`${name} renders clean`, problems.length === 0, problems.join(', '));
}

// The Integrations page exists to report which subsystems are down, so it must survive
// those subsystems answering with nothing at all. A 500 here removes the only screen
// that would have explained the outage.
for (const [label, args] of [
  ['integrations: everything null', { keys: null, fanout: null, retell: null, poller: null, lastAccepted: null, db: null }],
  ['integrations: empty object', {}],
]) {
  try {
    const h = R.integrationsPage(args);
    ok(`${label} renders`, typeof h === 'string' && h.length > 0);
  } catch (err) { ok(`${label} renders`, false, err.message); }
}

// The route wraps each aggregate in its own try/catch, so any one of them can arrive
// as null after a failed query. A default parameter only fires on `undefined`, so an
// explicit null sails straight past it. The overview is the first page the owner opens:
// one failed aggregate must degrade one section, never 500 the whole screen.
const overviewBase = {
  daily: [], sources: [], matchQuality: [],
  responseTimes: { median_min: null, p90_min: null, count: 0 },
  pipeline: [], days: 14, waiting: [], waitingTotal: 0, now,
};
for (const key of ['daily', 'sources', 'matchQuality', 'pipeline', 'responseTimes', 'waiting']) {
  for (const val of [null, undefined]) {
    try {
      const h = R.overviewPage({ ...overviewBase, [key]: val });
      ok(`overview survives ${key}=${val}`, typeof h === 'string' && h.length > 0);
    } catch (err) { ok(`overview survives ${key}=${val}`, false, err.message); }
  }
}

console.log(bad ? `\n${bad} FAILURE(S)` : '\nALL PAGES RENDER CLEAN UNDER HOSTILE INPUT');
process.exit(bad ? 1 : 0);
