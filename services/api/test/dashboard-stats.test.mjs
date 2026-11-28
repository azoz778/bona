/**
 * The dashboard's numbers, over a seeded store: three sessions, a dozen events, four
 * leads whose first and last touches deliberately disagree, and two days of spend on
 * one campaign.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createStats, dayKey, median, percentile, licenceFlags, expiryMs, platformOf, DAY_MS } from '../lib/dashboard/stats.mjs';
import { createInboxStore } from '../lib/inbox/store.mjs';
import { HANDOVER, DISCLOSURE, FIXED_LINES, LEGACY_DISCLOSURE } from '../lib/dana-wa.mjs';
import { disclosureVariants } from '../lib/persona.mjs';

const NOW = 1_757_200_000_000;
const now = () => NOW;
const day = (back) => dayKey(NOW - back * DAY_MS);
const ANON = (n) => String(n).repeat(32).slice(0, 32);

/** The campaign the paid traffic arrived on. */
const META_TOUCH = { ts: NOW - 3 * DAY_MS, landing: '/properties/x/', utm_source: 'meta', utm_medium: 'paid', utm_campaign: 'villas_sep', utm_id: '1203' };
/** …and the organic search that found the site a week before that. */
const GOOGLE_TOUCH = { ts: NOW - 9 * DAY_MS, referrer: 'https://www.google.com/', landing: '/' };

/** Three listings: one clean, one with a licence about to lapse, one off-plan with no Wafi number. */
const LISTINGS = [
  { id: 'BONA-001', slug: 'beach-villa', title: { en: 'Beach Villa', ar: 'فيلا الشاطئ' }, status: 'available', category: 'buy', licence: { adNumber: '7200123456', adExpiry: dayKey(NOW + 300 * DAY_MS) } },
  { id: 'BONA-002', slug: 'sky-apartment', title: { en: 'Sky Apartment', ar: 'شقة سماء' }, status: 'available', category: 'buy', licence: { adNumber: '7200222222', adExpiry: dayKey(NOW + 10 * DAY_MS) } },
  { id: 'BONA-W003', slug: 'marina-tower', title: { en: 'Marina Tower', ar: 'برج المارينا' }, status: 'available', category: 'off-plan', licence: null },
];

function seeded() {
  const db = openDb(':memory:');

  /* --- sessions --- */
  db.upsertSession({
    session_id: 'sess-aaa1', anon_id: ANON(1), ref: 'K7Q2XR', started: NOW - 3 * DAY_MS, last_seen: NOW - 3 * DAY_MS, pages: 3, locale: 'en',
    first_touch: META_TOUCH, last_touch: META_TOUCH, ip: '2.2.2.2', ua: 'iPhone', country: 'SA', consent_analytics: 1, consent_ads: 1,
  });
  db.upsertSession({
    session_id: 'sess-bbb2', anon_id: ANON(2), ref: 'M4TR7P', started: NOW - 2 * DAY_MS, last_seen: NOW - 2 * DAY_MS, pages: 5, locale: 'ar',
    first_touch: GOOGLE_TOUCH, last_touch: META_TOUCH, ip: '3.3.3.3', ua: 'Android', country: 'SA', consent_analytics: 1, consent_ads: 0,
  });
  db.upsertSession({
    session_id: 'sess-ccc3', anon_id: ANON(3), ref: 'P9WQ2K', started: NOW - 1 * DAY_MS, last_seen: NOW - 1 * DAY_MS, pages: 1, locale: 'en',
    first_touch: null, last_touch: null, ip: '4.4.4.4', ua: 'Desktop', country: 'SA', consent_analytics: 0, consent_ads: 0,
  });

  /* --- events (12) --- */
  const ev = (id, back, name, extra = {}) => db.insertEvent({
    event_id: id, ts: NOW - back * DAY_MS, name, anon_id: extra.anon ?? ANON(1), session_id: extra.session ?? 'sess-aaa1',
    lead_id: extra.lead ?? null, listing_id: extra.listing ?? null, path: extra.path ?? '/', props: extra.props ?? {},
    src_first: extra.first ?? null, src_last: extra.last ?? null, ip: '2.2.2.2', ua: 'iPhone', country: 'SA',
  });
  ev('ev-01', 3, 'page_view', { first: META_TOUCH, last: META_TOUCH });
  ev('ev-02', 3, 'listing_view', { listing: 'BONA-001', path: '/properties/beach-villa/', first: META_TOUCH, last: META_TOUCH });
  ev('ev-03', 3, 'gallery_open', { listing: 'BONA-001', first: META_TOUCH, last: META_TOUCH });
  ev('ev-04', 3, 'whatsapp_click', { listing: 'BONA-001', first: META_TOUCH, last: META_TOUCH });
  ev('ev-05', 2, 'page_view', { session: 'sess-bbb2', anon: ANON(2), first: GOOGLE_TOUCH, last: META_TOUCH });
  ev('ev-06', 2, 'listing_view', { session: 'sess-bbb2', anon: ANON(2), listing: 'BONA-001', first: GOOGLE_TOUCH, last: META_TOUCH });
  ev('ev-07', 2, 'tour_open', { session: 'sess-bbb2', anon: ANON(2), listing: 'BONA-001', first: GOOGLE_TOUCH, last: META_TOUCH });
  ev('ev-08', 2, 'brochure_download', { session: 'sess-bbb2', anon: ANON(2), listing: 'BONA-002', first: GOOGLE_TOUCH, last: META_TOUCH });
  ev('ev-09', 1, 'page_view', { session: 'sess-ccc3', anon: ANON(3) });
  ev('ev-10', 1, 'listing_view', { session: 'sess-ccc3', anon: ANON(3), listing: 'BONA-002' });
  ev('ev-11', 1, 'whatsapp_click', { session: 'sess-ccc3', anon: ANON(3), listing: 'BONA-002' });
  ev('ev-12', 1, 'map_click', { session: 'sess-ccc3', anon: ANON(3) });

  /* --- leads --- */
  // Paid click → enquiry on the same visit: first touch and last touch agree.
  db.insertLead({
    lead_id: 'LEAD-A', created: NOW - 3 * DAY_MS, updated: NOW - 3 * DAY_MS, phone_e164: '966500000001', name: 'Sara Ahmed',
    channel: 'whatsapp', source: 'meta', medium: 'paid', campaign: 'villas_sep', campaign_id: '1203', match_method: 'ref',
    session_id: 'sess-aaa1', anon_id: ANON(1), listing_id: 'BONA-001', first_touch: META_TOUCH, last_touch: META_TOUCH,
    stage: 'new', stage_ts: NOW - 3 * DAY_MS, first_inbound_ts: NOW - 3 * DAY_MS, first_reply_ts: NOW - 3 * DAY_MS + 12 * 60_000,
    consent_ads: 1, consent_analytics: 1,
  });
  // Found by Google a week earlier, converted through the paid campaign: the two differ.
  db.insertLead({
    lead_id: 'LEAD-B', created: NOW - 2 * DAY_MS, updated: NOW - 2 * DAY_MS, phone_e164: '966500000002', name: 'خالد العمري',
    channel: 'whatsapp', source: 'meta', medium: 'paid', campaign: 'villas_sep', campaign_id: '1203', match_method: 'time_window',
    session_id: 'sess-bbb2', anon_id: ANON(2), listing_id: 'BONA-001', first_touch: GOOGLE_TOUCH, last_touch: META_TOUCH,
    stage: 'new', stage_ts: NOW - 2 * DAY_MS, first_inbound_ts: NOW - 2 * DAY_MS, first_reply_ts: NOW - 2 * DAY_MS + 48 * 60_000,
    consent_ads: 0, consent_analytics: 1,
  });
  // A WhatsApp message with no click behind it: one touch, and it is not a campaign.
  db.insertLead({
    lead_id: 'LEAD-C', created: NOW - DAY_MS, updated: NOW - DAY_MS, phone_e164: '966500000003', name: 'Omar',
    channel: 'whatsapp', source: 'whatsapp_organic', medium: '(none)', match_method: 'keyword',
    stage: 'new', stage_ts: NOW - DAY_MS,
  });
  db.insertLead({
    lead_id: 'LEAD-D', created: NOW - DAY_MS, updated: NOW - DAY_MS, phone_e164: '966500000004', name: 'Layla',
    channel: 'form', source: '(direct)', medium: '(none)', match_method: 'form', listing_id: 'BONA-002',
    stage: 'new', stage_ts: NOW - DAY_MS,
  });

  /* --- stages: A is won, B has a viewing booked, D was contacted --- */
  db.setStage('LEAD-A', 'won', { actor: 'owner', valueSar: 2_000_000, now: NOW - 6 * 3_600_000 });
  db.setStage('LEAD-B', 'viewing', { actor: 'owner', now: NOW - DAY_MS });
  db.setStage('LEAD-D', 'contacted', { actor: 'owner', now: NOW - 2 * 3_600_000 });

  /* --- spend: two days on the one campaign --- */
  db.upsertSpend({ day: day(3), platform: 'meta', campaign_id: '1203', campaign_name: 'Villas Sept', spend_sar: 3000, clicks: 120, impressions: 40_000 });
  db.upsertSpend({ day: day(2), platform: 'meta', campaign_id: '1203', campaign_name: 'Villas Sept', spend_sar: 1500, clicks: 60, impressions: 20_000 });

  return { db, stats: createStats({ db, now }) };
}

/* ---------------- daily strip ---------------- */

test('overviewDaily returns one row per day, quiet days included', () => {
  const { stats } = seeded();
  const rows = stats.overviewDaily(14);
  assert.equal(rows.length, 14);
  assert.equal(rows.at(-1).day, day(0));
  assert.equal(rows[0].day, day(13));
  assert.deepEqual(rows.map((r) => r.day), [...rows].sort((a, b) => a.day.localeCompare(b.day)).map((r) => r.day), 'oldest first');

  const by = Object.fromEntries(rows.map((r) => [r.day, r]));
  assert.deepEqual(by[day(3)], { day: day(3), sessions: 1, wa_clicks: 1, leads: 1, viewings: 0 });
  assert.deepEqual(by[day(2)], { day: day(2), sessions: 1, wa_clicks: 0, leads: 1, viewings: 0 });
  assert.deepEqual(by[day(1)], { day: day(1), sessions: 1, wa_clicks: 1, leads: 2, viewings: 1 });
  assert.deepEqual(by[day(0)], { day: day(0), sessions: 0, wa_clicks: 0, leads: 0, viewings: 0 }, 'today is quiet, and says so');
});

test('overviewDaily honours the window it is asked for', () => {
  const { stats } = seeded();
  assert.equal(stats.overviewDaily(3).length, 3);
  assert.equal(stats.overviewDaily(3)[0].day, day(2));
  assert.equal(stats.overviewDaily(0).length, 14, 'a nonsense window falls back to a fortnight');
});

/* ---------------- sources ---------------- */

test('sources counts first touch and last touch separately', () => {
  const { stats } = seeded();
  const rows = stats.sources();
  const meta = rows.find((r) => r.source === 'meta');
  assert.ok(meta, 'the paid campaign must be a row');
  assert.equal(meta.medium, 'paid');
  assert.equal(meta.campaign, 'villas_sep');
  assert.equal(meta.campaign_id, '1203');
  assert.equal(meta.last_touch_leads, 2, 'both paid leads converted on this campaign');
  assert.equal(meta.first_touch_leads, 1, 'only one of them was *found* by it');
  assert.equal(meta.wa_clicks, 1, 'the one click whose last touch was the campaign');

  const google = rows.find((r) => r.source === 'google.com');
  assert.ok(google, 'the organic search that found lead B must appear on its own row');
  assert.equal(google.first_touch_leads, 1);
  assert.equal(google.last_touch_leads, 0);
  assert.equal(google.medium, 'social_or_organic');

  const organic = rows.find((r) => r.source === 'whatsapp_organic');
  assert.equal(organic.first_touch_leads, 1, 'a lead with one touch is counted once on each side');
  assert.equal(organic.last_touch_leads, 1);

  const direct = rows.find((r) => r.source === '(direct)');
  assert.equal(direct.last_touch_leads, 1);
  assert.equal(direct.wa_clicks, 1, 'the click from the session with no campaign');
});

test('sources attaches spend to the campaign id and divides by last-touch leads', () => {
  const { stats } = seeded();
  const meta = stats.sources().find((r) => r.source === 'meta');
  assert.equal(meta.spend_sar, 4500, 'both days of spend on campaign 1203');
  assert.equal(meta.cpl, 2250);

  for (const row of stats.sources().filter((r) => r.source !== 'meta')) {
    assert.equal(row.spend_sar, 0);
    assert.equal(row.cpl, null, `${row.source} has no spend, so no cost per lead`);
  }
});

/* ---------------- match quality, pipeline, response ---------------- */

test('matchQuality splits the leads by how they were tied to their traffic', () => {
  const { stats } = seeded();
  const counts = Object.fromEntries(stats.matchQuality().map((r) => [r.match_method, r.count]));
  assert.deepEqual(counts, { ref: 1, time_window: 1, keyword: 1, form: 1 });
});

test('pipeline lists every stage in order with the median age of the leads in it', () => {
  const { stats } = seeded();
  const rows = stats.pipeline();
  assert.deepEqual(rows.map((r) => r.stage), ['new', 'contacted', 'qualified', 'viewing', 'offer', 'negotiation', 'won', 'lost']);
  const by = Object.fromEntries(rows.map((r) => [r.stage, r]));
  assert.equal(by.new.count, 1, 'lead C never moved');
  assert.equal(by.won.count, 1);
  assert.equal(by.won.median_age_h, 6);
  assert.equal(by.viewing.count, 1);
  assert.equal(by.viewing.median_age_h, 24);
  assert.equal(by.contacted.median_age_h, 2);
  assert.equal(by.qualified.count, 0);
  assert.equal(by.qualified.median_age_h, null, 'an empty stage has no age, not an age of zero');
});

test('responseTimes reports the median and the p90 in minutes', () => {
  const { stats } = seeded();
  assert.deepEqual(stats.responseTimes(), { median_min: 30, p90_min: 48, count: 2 });
});

test('responseTimes is null-safe when nobody has replied yet', () => {
  const db = openDb(':memory:');
  db.insertLead({ lead_id: 'L1', created: NOW, updated: NOW, phone_e164: '966500000009', stage: 'new', stage_ts: NOW, first_inbound_ts: NOW });
  assert.deepEqual(createStats({ db, now }).responseTimes(), { median_min: null, p90_min: null, count: 0 });
});

/* ---------------- listings ---------------- */

test('listingFunnel counts the funnel per listing and flags the licences', () => {
  const { stats } = seeded();
  const rows = stats.listingFunnel(LISTINGS);
  assert.equal(rows.length, 3);
  const by = Object.fromEntries(rows.map((r) => [r.listing_id, r]));

  assert.deepEqual(
    { ...by['BONA-001'], licence: undefined },
    {
      listing_id: 'BONA-001', title: 'Beach Villa', status: 'available', category: 'buy',
      views: 2, gallery: 1, tour: 1, brochure: 0, wa_clicks: 1, leads: 2, licence: undefined, flags: [],
    },
  );
  assert.equal(by['BONA-002'].views, 1);
  assert.equal(by['BONA-002'].brochure, 1);
  assert.equal(by['BONA-002'].wa_clicks, 1);
  assert.equal(by['BONA-002'].leads, 1);
  assert.deepEqual(by['BONA-002'].flags, ['expiring_30d'], 'ten days left is worth a warning');
  assert.deepEqual(by['BONA-W003'].flags, ['no_ad_licence', 'wafi_missing'], 'an off-plan listing needs both numbers');
  assert.equal(by['BONA-W003'].views, 0, 'a listing nobody looked at is still a row');
  assert.equal(rows[0].listing_id, 'BONA-001', 'the listing with the most leads sorts first');
});

test('listingFunnel accepts the inventory holder as well as a plain array', () => {
  const { stats } = seeded();
  const holder = { all: () => LISTINGS };
  assert.deepEqual(stats.listingFunnel(holder).map((r) => r.listing_id), stats.listingFunnel(LISTINGS).map((r) => r.listing_id));
  assert.deepEqual(stats.listingFunnel(null), []);
});

test('licenceFlags reads an expiry as the end of that day', () => {
  const today = dayKey(NOW);
  assert.deepEqual(licenceFlags({ category: 'buy', licence: { adNumber: '1', adExpiry: today } }, NOW), ['expiring_30d'], 'a licence expiring today is still valid today');
  assert.deepEqual(licenceFlags({ category: 'buy', licence: { adNumber: '1', adExpiry: dayKey(NOW - DAY_MS) } }, NOW), ['expired']);
  assert.deepEqual(licenceFlags({ category: 'buy', licence: { adNumber: '  ' } }, NOW), ['no_ad_licence'], 'whitespace is not a licence number');
  assert.deepEqual(licenceFlags({ category: 'off-plan', licence: { adNumber: '1', wafiNumber: '999', adExpiry: dayKey(NOW + 60 * DAY_MS) } }, NOW), []);
  assert.deepEqual(licenceFlags({ category: 'buy' }, NOW), ['no_ad_licence'], 'no licence block at all');
  assert.equal(expiryMs('not-a-date'), null);
  assert.equal(expiryMs(null), null);
});

/* ---------------- spend ---------------- */

test('cplByCampaign shows the money even where the leads are not', () => {
  const { db, stats } = seeded();
  db.upsertSpend({ day: day(1), platform: 'snapchat', campaign_id: '9900', campaign_name: 'Snap test', spend_sar: 800, clicks: 10, impressions: 5000 });
  const rows = stats.cplByCampaign();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    platform: 'meta', campaign_id: '1203', campaign_name: 'Villas Sept',
    spend_sar: 4500, clicks: 180, impressions: 60_000, leads: 2, unmatched_leads: 0, cpl: 2250,
  });
  assert.deepEqual(rows[1], {
    platform: 'snapchat', campaign_id: '9900', campaign_name: 'Snap test',
    spend_sar: 800, clicks: 10, impressions: 5000, leads: 0, unmatched_leads: 0, cpl: null,
  });
});

test('ROI reports date-filtered funnel value, coverage, unknown and spend freshness without invented ROAS', () => {
  const { db, stats } = seeded();
  db.insertLead({
    lead_id: 'LEAD-UNKNOWN', created: NOW - DAY_MS, updated: NOW - DAY_MS, phone_e164: '966500000099',
    channel: 'form', source: '(direct)', medium: '(none)', stage: 'qualified', stage_ts: NOW - DAY_MS,
  });
  db.db.prepare('UPDATE ad_spend SET imported_at = ? WHERE campaign_id = ?').run(NOW - 1000, '1203');

  const roi = stats.roi({ fromDay: day(3), toDay: day(1) });
  assert.deepEqual(roi.range, { from: day(3), to: day(1) });
  assert.equal(roi.totals.leads, 5);
  assert.equal(roi.totals.attributed_leads, 2);
  assert.equal(roi.totals.unknown_leads, 3);
  assert.equal(roi.coverage.percent, 40);
  assert.equal(roi.spend_freshness, NOW - 1000);

  const meta = roi.campaigns.find((r) => r.campaign_id === '1203');
  assert.deepEqual(meta, {
    platform: 'meta', campaign_id: '1203', campaign_name: 'Villas Sept', spend_sar: 4500,
    clicks: 180, impressions: 60000, leads: 2, qualified_leads: 2, won_leads: 1,
    revenue_sar: 2000000, cpl: 2250, roas: 444.44, unmatched_leads: 0,
  });
  const unknown = roi.campaigns.find((r) => r.bucket === 'unknown');
  assert.equal(unknown.leads, 3);
  assert.equal(unknown.qualified_leads, 1);
  assert.equal(unknown.spend_sar, null);
  assert.equal(unknown.roas, null);

  const noValueDb = openDb(':memory:');
  noValueDb.upsertSpend({ day: day(1), platform: 'meta', campaign_id: 'x', spend_sar: 100 });
  noValueDb.insertLead({ lead_id: 'L', created: NOW - DAY_MS, updated: NOW, source: 'meta', campaign_id: 'x', stage: 'won', value_sar: null });
  const noValue = createStats({ db: noValueDb, now }).roi({ fromDay: day(1), toDay: day(1) }).campaigns.find((r) => r.campaign_id === 'x');
  assert.equal(noValue.won_leads, 1);
  assert.equal(noValue.revenue_sar, null);
  assert.equal(noValue.roas, null, 'no won value means unknown ROAS, never zero');
  noValueDb.close();
});

test('ROI accumulates raw platform aliases that fold to the same canonical Meta campaign', () => {
  const db = openDb(':memory:');
  db.upsertSpend({ day: day(1), platform: 'meta', campaign_id: 'alias-1', campaign_name: 'Alias campaign', spend_sar: 20, clicks: 2, impressions: 200 });
  db.upsertSpend({ day: day(1), platform: 'facebook', campaign_id: 'alias-1', campaign_name: 'Alias campaign', spend_sar: 10, clicks: 1, impressions: 100 });
  const row = createStats({ db, now }).roi({ fromDay: day(1), toDay: day(1) }).campaigns.find((r) => r.campaign_id === 'alias-1');
  assert.equal(row.platform, 'meta');
  assert.equal(row.spend_sar, 30);
  assert.equal(row.clicks, 3);
  assert.equal(row.impressions, 300);
  db.close();
});

test('ROI keeps spend metrics unknown when a lead campaign has no imported spend row', () => {
  const db = openDb(':memory:');
  db.insertLead({
    lead_id: 'lead-without-spend', created: NOW - DAY_MS, updated: NOW,
    source: 'meta', campaign_id: 'never-imported', stage: 'qualified',
  });
  const row = createStats({ db, now }).roi({ fromDay: day(1), toDay: day(1) })
    .campaigns.find((campaign) => campaign.campaign_id === 'never-imported');
  assert.equal(row.spend_sar, null);
  assert.equal(row.clicks, null);
  assert.equal(row.impressions, null);
  assert.equal(row.cpl, null);
  assert.equal(row.roas, null);
  db.close();
});

test('a campaign whose platform names did not fold says so instead of reading as a dud', () => {
  const { db, stats } = seeded();
  // The owner filed this spend under "other"; the leads arrived as utm_source=paid_social.
  // Zero leads and "we could not match any" call for opposite actions, so they must not
  // render as the same number.
  db.upsertSpend({ day: day(1), platform: 'other', campaign_id: '7700', campaign_name: 'Newsletter push', spend_sar: 400 });
  db.insertLead({
    lead_id: 'LEAD-F', created: NOW - DAY_MS, updated: NOW - DAY_MS, phone_e164: '966500000006', name: 'Unmatched',
    channel: 'form', source: 'paid_social', medium: 'paid', campaign: 'news', campaign_id: '7700',
    match_method: 'form', stage: 'new', stage_ts: NOW - DAY_MS,
  });
  const row = stats.cplByCampaign().find((r) => r.campaign_id === '7700');
  assert.equal(row.leads, 0, 'the strict pair still finds nothing — that is the honest join');
  assert.equal(row.unmatched_leads, 1, 'but one lead carries this campaign id under another label');
  assert.equal(row.cpl, null);

  const matched = stats.cplByCampaign().find((r) => r.campaign_id === '1203');
  assert.equal(matched.unmatched_leads, 0, 'a row whose pair matched has nothing unexplained');
});

test('two platforms running the same campaign number do not share a budget', () => {
  const { db, stats } = seeded();
  // Snapchat also has a campaign called 1203. Matching on the id alone would hand
  // Meta's 4,500 SAR to Snap's leads, and Snap's 700 to Meta's.
  db.upsertSpend({ day: day(1), platform: 'snapchat', campaign_id: '1203', campaign_name: 'Snap 1203', spend_sar: 700, clicks: 5, impressions: 900 });
  db.insertLead({
    lead_id: 'LEAD-E', created: NOW - DAY_MS, updated: NOW - DAY_MS, phone_e164: '966500000005', name: 'Snap lead',
    channel: 'form', source: 'snapchat', medium: 'paid', campaign: 'snap_sep', campaign_id: '1203',
    match_method: 'form', stage: 'new', stage_ts: NOW - DAY_MS,
  });

  const rows = stats.sources();
  assert.equal(rows.find((r) => r.source === 'meta').spend_sar, 4500);
  assert.equal(rows.find((r) => r.source === 'meta').cpl, 2250);
  assert.equal(rows.find((r) => r.source === 'snapchat').spend_sar, 700);
  assert.equal(rows.find((r) => r.source === 'snapchat').cpl, 700);

  const cpl = Object.fromEntries(stats.cplByCampaign().map((r) => [`${r.platform}|${r.campaign_id}`, r]));
  assert.equal(cpl['meta|1203'].leads, 2);
  assert.equal(cpl['snapchat|1203'].leads, 1);
});

test('platformOf folds the names the two sides use for one platform', () => {
  assert.equal(platformOf('Instagram'), 'meta');
  assert.equal(platformOf('www.facebook.com'), 'meta');
  assert.equal(platformOf('google.com'), 'google');
  assert.equal(platformOf('snap'), 'snapchat');
  assert.equal(platformOf('whatsapp_organic'), 'whatsapp_organic', 'an unknown name passes through and matches no spend');
  assert.equal(platformOf(''), null);
  assert.equal(platformOf('constructor'), 'constructor', 'a prototype member is just a name');
});

/* ---------------- journey ---------------- */

test('leadJourney merges the anonymous browsing, the touchpoints, the stages and the notes', () => {
  const { db, stats } = seeded();
  db.addTouchpoint({ lead_id: 'LEAD-B', ts: NOW - 2 * DAY_MS, channel: 'whatsapp', event_type: 'inbound_message', source: 'meta', medium: 'paid', campaign: 'villas_sep', listing_id: 'BONA-001', meta: { snippet: 'hello' } });
  db.addTouchpoint({ lead_id: 'LEAD-B', ts: NOW - 3_600_000, channel: 'manual', event_type: 'note', meta: { note: 'Wants a sea view', actor: 'owner' } });

  const journey = stats.leadJourney('LEAD-B');
  assert.deepEqual(journey.map((e) => e.ts), [...journey].sort((a, b) => a.ts - b.ts).map((e) => e.ts), 'oldest first');
  const kinds = journey.map((e) => e.kind);
  assert.ok(kinds.includes('event') && kinds.includes('touchpoint') && kinds.includes('stage') && kinds.includes('note'));

  const events = journey.filter((e) => e.kind === 'event');
  assert.deepEqual(events.map((e) => e.name), ['page_view', 'listing_view', 'tour_open', 'brochure_download'],
    'the pages read while the visitor was still anonymous belong to the journey');

  const note = journey.find((e) => e.kind === 'note');
  assert.deepEqual(note, { ts: NOW - 3_600_000, kind: 'note', text: 'Wants a sea view', actor: 'owner' });
  assert.deepEqual(journey.filter((e) => e.kind === 'stage').map((e) => e.stage), ['viewing']);
  assert.deepEqual(stats.leadJourney('nope'), []);
});

test('leadJourney of a lead with no session shows only what that lead did', () => {
  const { stats } = seeded();
  const journey = stats.leadJourney('LEAD-C');
  assert.equal(journey.filter((e) => e.kind === 'event').length, 0);
  assert.deepEqual(journey, [], 'no session, no touchpoints, no stage moves — nothing to show yet');
});

/* ---------------- statistics primitives ---------------- */

test('median and percentile', () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([4, 1, 3]), 3);
  assert.equal(percentile([], 0.9), null);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.equal(percentile([1, 2], 0.9), 2);
});

/* ---------------- the bundle the admin API answers with ---------------- */

test('owner-started leads are not acquisitions: out of the Desk new-lead counts, the sources table and ROI; still on the board and in match quality', () => {
  const { db, stats } = seeded();
  const window = { fromDay: day(3), toDay: day(0) };
  const before = {
    daily: stats.overviewDaily(14), sources: stats.sources(), roi: stats.roi(window), cpl: stats.cplByCampaign(),
    pipeline: Object.fromEntries(stats.pipeline().map((p) => [p.stage, p.count])),
  };
  // A chat the owner started by sending a Bona link, and a number he added on the dashboard
  // that later came back through the paid campaign: neither is a lead the campaign found.
  db.insertLead({
    lead_id: 'LEAD-OUT', created: NOW - DAY_MS, updated: NOW - DAY_MS, phone_e164: '966500000011',
    channel: 'whatsapp', source: 'whatsapp_organic', medium: '(none)', match_method: 'owner_outbound',
    stage: 'new', stage_ts: NOW - DAY_MS, first_reply_ts: NOW - DAY_MS,
  });
  db.insertLead({
    lead_id: 'LEAD-ADD', created: NOW - DAY_MS, updated: NOW - DAY_MS, phone_e164: '966500000012',
    channel: 'whatsapp', source: 'meta', medium: 'paid', campaign: 'villas_sep', campaign_id: '1203', match_method: 'owner_added',
    first_touch: META_TOUCH, last_touch: META_TOUCH, stage: 'qualified', stage_ts: NOW - DAY_MS, first_reply_ts: NOW - DAY_MS,
  });

  assert.deepEqual(stats.overviewDaily(14), before.daily, 'the Desk\'s leads per day, and so its "Leads · N d" and its funnel');
  assert.deepEqual(stats.sources(), before.sources, 'no row, no first or last touch, no share of the spend');
  assert.deepEqual(stats.roi(window), before.roi, 'no campaign, no unknown bucket, no coverage');
  assert.deepEqual(stats.cplByCampaign(), before.cpl, 'the Spend page\'s cost per lead agrees with its ROI');
  assert.deepEqual(stats.overview(14).roi.totals, stats.roi().totals);

  const pipeline = Object.fromEntries(stats.pipeline().map((p) => [p.stage, p.count]));
  assert.equal(pipeline.new, before.pipeline.new + 1, 'still on the pipeline board');
  assert.equal(pipeline.qualified, before.pipeline.qualified + 1);
  const quality = Object.fromEntries(stats.matchQuality().map((r) => [r.match_method, r.count]));
  assert.deepEqual(quality, { ref: 1, time_window: 1, keyword: 1, form: 1, owner_outbound: 1, owner_added: 1 }, 'and in match quality');
  assert.equal(stats.overview(14).totals.leads, 6, 'the book still holds them');
});

test('a lead with no match method is an acquisition: on the Desk, in the sources table and in ROI', () => {
  const { db, stats } = seeded();
  const window = { fromDay: day(3), toDay: day(0) };
  const leadsOf = (rows) => rows.reduce((n, r) => n + r.leads, 0);
  const sourceRow = () => stats.sources().find((r) => r.source === 'meta' && r.campaign_id === '1203');
  const roiRow = () => stats.roi(window).campaigns.find((r) => r.campaign_id === '1203');
  const cplRow = () => stats.cplByCampaign().find((r) => r.campaign_id === '1203');
  const before = {
    daily: leadsOf(stats.overviewDaily(14)), sources: sourceRow().last_touch_leads,
    roi: roiRow().leads, roiTotal: stats.roi(window).totals.leads, cpl: cplRow().leads,
  };
  // A lead from before match methods were recorded (NULL): `NOT IN` alone would drop it.
  db.insertLead({
    lead_id: 'LEAD-NULL', created: NOW - DAY_MS, updated: NOW - DAY_MS, phone_e164: '966500000013',
    channel: 'whatsapp', source: 'meta', medium: 'paid', campaign: 'villas_sep', campaign_id: '1203', match_method: null,
    stage: 'new', stage_ts: NOW - DAY_MS,
  });
  assert.equal(db.getLead('LEAD-NULL').match_method, null);

  assert.equal(leadsOf(stats.overviewDaily(14)), before.daily + 1, 'a new lead on the Desk');
  assert.equal(sourceRow().last_touch_leads, before.sources + 1, 'the campaign\'s lead in the sources table');
  assert.equal(roiRow().leads, before.roi + 1, 'and in ROI');
  assert.equal(stats.roi(window).totals.leads, before.roiTotal + 1);
  assert.equal(cplRow().leads, before.cpl + 1, 'and in the Spend page\'s cost per lead');
});

test('overview() carries every section plus the totals', () => {
  const { stats } = seeded();
  const o = stats.overview(7);
  assert.equal(o.days, 7);
  assert.equal(o.daily.length, 7);
  assert.ok(Array.isArray(o.sources) && Array.isArray(o.match_quality) && Array.isArray(o.pipeline) && Array.isArray(o.cpl_by_campaign));
  assert.equal(o.response_times.count, 2);
  assert.deepEqual(o.totals, { leads: 4, sessions: 3, events: 12 });
});

/* ---------------- the owner's daily summary (PLAN T11, DESIGN §7.3): read-only counts ---------------- */

test('ownerSummary(): new clients by channel, waiting chats, the assistant\'s turns and reply times, viewings, lid-only chats', () => {
  const db = openDb(':memory:');
  const stats = createStats({ db, now });
  const from = NOW - DAY_MS;
  const to = NOW;
  const put = (id, over) => db.insertLead({
    lead_id: id, created: NOW - 30 * DAY_MS, updated: NOW - 30 * DAY_MS, phone_e164: `96650000${id.slice(-4)}`, wa_jid: `96650000${id.slice(-4)}@s.whatsapp.net`,
    channel: 'whatsapp', match_method: 'ref', stage: 'new', inbox_state: 'in', ...over,
  });
  put('LEAD-0001', { created: from + 1000, name: 'Sara Example' });
  put('LEAD-0002', { created: from + 2000, channel: 'form', match_method: 'form' });
  put('LEAD-0003', { created: from + 3000, channel: 'concierge_chat', match_method: 'concierge' });
  put('LEAD-0004', { created: from + 4000, match_method: 'owner_outbound' });
  put('LEAD-0005', { inbox_via: 'own_number', inbox_since: from + 5000 });
  put('LEAD-0006', { created: to, name: 'Too Late Example' });
  put('LEAD-0007', { needs_human: 1 });
  put('LEAD-0008', { needs_human: 1, inbox_state: 'out' });
  const sends = [['LEAD-0001', from + 10_000, from + 30_000], ['LEAD-0001', from + 10_000, from + 31_000], ['LEAD-0005', from + 50_000, from + 60_000],
    ['LEAD-0005', to - 1000, to + 1000]];
  // The assistant's answers, as a brain turn leaves them: bubbles the reply guard passed (`guarded = 1`), taken by WhatsApp.
  for (const [i, [lead, covers, created]] of sends.entries()) {
    db.db.prepare(`INSERT INTO wa_outbox (send_id, lead_id, jid, text, user_id, sender_kind, status, key_id, created, updated, error, covers_ts, guarded)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(`SND-${i}`, lead, 'x@s.whatsapp.net', 't', null, 'dana', 'accepted', null, created, created, null, covers);
  }
  db.db.prepare(`INSERT INTO viewing_bookings (booking_id, lead_id, task_id, listing_id, start_ts, end_ts, event_id, status, client_told, created, updated)
                 VALUES ('BK-1','LEAD-0001','task-BK-1','BONA-W012',?,?,'ev1','booked',1,?,?)`).run(to + 3_600_000, to + 7_200_000, from, from);
  db.db.prepare(`INSERT INTO inbox_candidates (cand_id, jid, lid, phone_e164, name, first_ts, last_ts, hits, words, last_dir, state, updated)
                 VALUES ('CND-1', NULL, '1234@lid', NULL, 'Ahmed Example', ?, ?, 1, 'villa', 'in', 'open', ?)`).run(from + 1, from + 9, from + 9);
  db.db.prepare(`INSERT INTO inbox_candidates (cand_id, jid, lid, phone_e164, name, first_ts, last_ts, hits, words, last_dir, state, updated)
                 VALUES ('CND-2', '966500000099@s.whatsapp.net', NULL, '966500000099', 'Omar Example', ?, ?, 1, 'villa', 'in', 'open', ?)`).run(from + 1, from + 8, from + 8);
  const before = db.db.prepare('SELECT total_changes() AS n').get().n;
  const s = stats.ownerSummary({ from, to, viewingsFrom: to, viewingsTo: to + 2 * DAY_MS });
  assert.equal(db.db.prepare('SELECT total_changes() AS n').get().n, before, 'read-only');
  assert.deepEqual(s.newClients, { total: 4, byChannel: { whatsapp: 2, form: 1, chat: 1 }, booked: 1 });
  assert.equal(s.waiting, 1);
  assert.deepEqual(s.ai, { answers: 2, handovers: 0, medianReplyMs: 15_000 });
  assert.equal(s.notAnswered, 0);
  assert.deepEqual(s.viewings.map((v) => [v.listing_id, v.name]), [['BONA-W012', 'Sara Example']]);
  assert.deepEqual(s.lidOnly, [{ name: 'Ahmed Example', last_ts: from + 9 }]);
  assert.equal(s.candidatesWithPhone, 1);
  assert.deepEqual(s.heldOver, { total: 0, byKind: {} });
  assert.equal(s.oldOutWrote, 0);
  db.close();
});

test("ownerSummary(): only a viewing Google confirmed counts: a reservation still waiting on its insert (no task) is no viewing (Codex T11 r13)", () => {
  const db = openDb(':memory:');
  const stats = createStats({ db, now });
  const from = NOW - DAY_MS;
  const to = NOW;
  db.insertLead({ lead_id: 'LEAD-0901', created: from + 1000, updated: from + 1000, phone_e164: '966500000901', wa_jid: '966500000901@s.whatsapp.net', channel: 'whatsapp', match_method: 'ref', stage: 'new', inbox_state: 'in', name: 'Sara Example' });
  const put = (id, task, status) => db.db.prepare(`INSERT INTO viewing_bookings (booking_id, lead_id, task_id, listing_id, start_ts, end_ts, event_id, status, client_told, created, updated)
                 VALUES (?,'LEAD-0901',?,'BONA-W012',?,?,?,?,1,?,?)`).run(id, task, to + 3_600_000, to + 7_200_000, `ev-${id}`, status, from, from);
  put('BK-HOLD', null, 'booked');
  let s = stats.ownerSummary({ from, to, viewingsFrom: to, viewingsTo: to + 2 * DAY_MS });
  assert.deepEqual([s.viewings.length, s.newClients.booked], [0, 0], 'a reservation is no viewing yet');
  db.db.prepare("UPDATE viewing_bookings SET task_id = 'task-1' WHERE booking_id = 'BK-HOLD'").run();
  s = stats.ownerSummary({ from, to, viewingsFrom: to, viewingsTo: to + 2 * DAY_MS });
  assert.deepEqual([s.viewings.length, s.newClients.booked], [1, 1], 'once Google confirmed it');
  db.close();
});

test('ownerSummary(): only the assistant\'s ANSWERS count, and only their times make the median: never a hand-over or holding line, a pending or uncertain send, or a reply clock a person stamped (Codex r9)', () => {
  const db = openDb(':memory:');
  const stats = createStats({ db, now });
  const from = NOW - DAY_MS;
  const to = NOW;
  const HOLD = 'Thank you — a member of the Bona team will reply to you shortly.';
  const jidOf = (id) => `96650000${id.slice(-4)}@s.whatsapp.net`;
  const put = (id, over = {}) => db.insertLead({
    lead_id: id, created: from + 1000, updated: from + 1000, phone_e164: `96650000${id.slice(-4)}`, wa_jid: jidOf(id),
    channel: 'whatsapp', match_method: 'ref', stage: 'new', inbox_state: 'in', ...over,
  });
  let n = 0;
  const send = (lead, covers, created, { status = 'accepted', guarded = 0, updated = created, text = 'Of course.' } = {}) => {
    n += 1;
    db.db.prepare(`INSERT INTO wa_outbox (send_id, lead_id, jid, text, user_id, sender_kind, status, key_id, created, updated, error, covers_ts, guarded)
                   VALUES (?,?,?,?,NULL,'dana',?,NULL,?,?,NULL,?,?)`).run(`SND-R9-${n}`, lead, jidOf(lead), text, status, created, updated, covers, guarded);
  };
  // 1. A brain turn the reply guard passed, two bubbles: ONE answer, 20 s from the client's message to the first bubble WhatsApp took.
  put('LEAD-0101');
  send('LEAD-0101', from + 10_000, from + 29_000, { guarded: 1, updated: from + 30_000 });
  send('LEAD-0101', from + 10_000, from + 31_000, { guarded: 1, updated: from + 32_000 });
  // 2. The AI was out: a holding line at +12 s; then its first real answer (unguarded, as before T12) to the next message, taken at
  //    +11 s, which stamped the lead's reply clock (lib/dana-wa.mjs `send(…, { answer: true })`).
  put('LEAD-0102', { first_reply_ts: from + 141_000 });
  send('LEAD-0102', from + 100_000, from + 112_000, { text: HOLD });
  send('LEAD-0102', from + 130_000, from + 140_000, { updated: from + 141_000 });
  // 3. Still in flight, and never confirmed: no answer yet, guard or not.
  put('LEAD-0103');
  send('LEAD-0103', from + 200_000, from + 201_000, { status: 'pending', guarded: 1 });
  send('LEAD-0103', from + 300_000, from + 302_000, { status: 'uncertain', guarded: 1 });
  // 4. A holding line, then a person wrote: the reply clock is the person's (lib/wa-send.mjs stamps it too), not the AI's.
  put('LEAD-0104', { first_reply_ts: from + 460_000 });
  send('LEAD-0104', from + 400_000, from + 405_000, { text: HOLD });
  db.db.prepare(`INSERT INTO wa_messages (key_id, lead_id, jid, direction, sender_kind, text, ts, status)
                 VALUES ('OUT-R9-0104', 'LEAD-0104', ?, 'out', 'staff', 'Hello, this is the Bona team.', ?, 'sent')`).run(jidOf('LEAD-0104'), from + 459_000);
  // 5. A holding line and the answer after recovery cover the same message: one answer, at the answer's 30 s, not the line's 5 s.
  put('LEAD-0105');
  send('LEAD-0105', from + 500_000, from + 505_000, { text: HOLD });
  send('LEAD-0105', from + 500_000, from + 530_000, { guarded: 1 });
  // 6. A returning lead (G13): an earlier conversation stamped its reply clock, so today's holding line is no answer.
  put('LEAD-0106', { first_reply_ts: from - 5 * DAY_MS });
  send('LEAD-0106', from + 600_000, from + 603_000, { text: HOLD });
  // 7. A failed send went nowhere.
  put('LEAD-0107');
  send('LEAD-0107', from + 700_000, from + 701_000, { status: 'failed', guarded: 1 });

  const s = stats.ownerSummary({ from, to });
  assert.deepEqual(s.ai, { answers: 3, handovers: 0, medianReplyMs: 20_000 }, 'answers 1, 2 and 5: median of 11 s, 20 s and 30 s');
  // The pacing cap is not this rule: it still counts every turn that may have gone (8: all but the failed one).
  assert.equal(createInboxStore(db, { now }).countDanaTurns({ sinceTs: from }), 8);
  db.close();
});

test('ownerSummary(): a legacy (unguarded) answer counts on every turn, not only the first; the fixed hand-over line never does, with or without the disclosure line (Codex r10)', () => {
  const db = openDb(':memory:');
  const stats = createStats({ db, now });
  const from = NOW - DAY_MS;
  const to = NOW;
  db.insertLead({ lead_id: 'LEAD-0201', created: from - DAY_MS, updated: from - DAY_MS, phone_e164: '966500000201', wa_jid: '966500000201@s.whatsapp.net',
    channel: 'whatsapp', match_method: 'ref', stage: 'new', inbox_state: 'in', first_reply_ts: from - DAY_MS + 30_000 });
  let n = 0;
  const send = (covers, at, text) => {
    n += 1;
    db.db.prepare(`INSERT INTO wa_outbox (send_id, lead_id, jid, text, user_id, sender_kind, status, key_id, created, updated, error, covers_ts, guarded)
                   VALUES (?,'LEAD-0201','966500000201@s.whatsapp.net',?,NULL,'dana','accepted',NULL,?,?,NULL,?,0)`).run(`SND-L-${n}`, text, at, at, covers);
  };
  // Yesterday's first answer stamped the reply clock; today two follow-up questions get two Retell answers.
  send(from + 10_000, from + 25_000, 'The villa has four bedrooms.');
  send(from + 100_000, from + 135_000, 'Yes, it has a private pool.');
  // The hand-over line code sends, alone, after the disclosure line, and in Arabic: never an answer.
  send(from + 200_000, from + 203_000, HANDOVER.en);
  send(from + 300_000, from + 303_000, `${DISCLOSURE.en}\n\n${HANDOVER.en}`);
  send(from + 400_000, from + 403_000, HANDOVER.ar);
  send(from + 500_000, from + 503_000, `${DISCLOSURE.ar}\n\n${HANDOVER.ar}`); // the Arabic first-contact hand-over (multi-byte substr)
  const s = stats.ownerSummary({ from, to });
  assert.deepEqual(s.ai, { answers: 2, handovers: 0, medianReplyMs: 25_000 }, 'the two answers: 15 s and 35 s');
  db.close();
});

test('ownerSummary(): an answer split across 08:00 counts once, in the day of its first bubble; a purged chat keeps its reply time (Codex r10, Claude r11)', () => {
  const db = openDb(':memory:');
  const stats = createStats({ db, now });
  const inbox = createInboxStore(db, { now });
  const a = NOW - DAY_MS;
  const put = (id) => db.insertLead({ lead_id: id, created: a - DAY_MS, updated: a - DAY_MS, phone_e164: `96650000${id.slice(-4)}`,
    wa_jid: `96650000${id.slice(-4)}@s.whatsapp.net`, channel: 'whatsapp', match_method: 'ref', stage: 'new', inbox_state: 'in' });
  let n = 0;
  const send = (lead, covers, at) => {
    n += 1;
    db.db.prepare(`INSERT INTO wa_outbox (send_id, lead_id, jid, text, user_id, sender_kind, status, key_id, created, updated, error, covers_ts, guarded)
                   VALUES (?,?,?,'Of course.',NULL,'dana','accepted',NULL,?,?,NULL,?,1)`).run(`SND-W-${n}`, lead, `96650000${lead.slice(-4)}@s.whatsapp.net`, at, at, covers);
  };
  // Two bubbles of one answer, at 07:59:58 and 08:00:03 (the day boundary `a`).
  put('LEAD-0301');
  send('LEAD-0301', a - 22_000, a - 2_000);
  send('LEAD-0301', a - 22_000, a + 3_000);
  assert.deepEqual(stats.ownerSummary({ from: a - DAY_MS, to: a }).ai, { answers: 1, handovers: 0, medianReplyMs: 20_000 }, 'the day of its first bubble');
  assert.deepEqual(stats.ownerSummary({ from: a, to: NOW }).ai, { answers: 0, handovers: 0, medianReplyMs: null }, 'never again the next day');
  // Two answers today (20 s and 25 s); then the owner taps Not a client on one chat 4 h later: the purge stubs its row
  // (lead_id and text cleared, `updated` rewritten), and the answer keeps its count and its 25 s.
  put('LEAD-0302');
  put('LEAD-0303');
  send('LEAD-0302', a + 60_000, a + 80_000);
  send('LEAD-0303', a + 90_000, a + 115_000);
  const before = stats.ownerSummary({ from: a, to: NOW }).ai;
  assert.deepEqual(before, { answers: 2, handovers: 0, medianReplyMs: 22_500 });
  inbox.leaveInbox('LEAD-0303');
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM wa_outbox WHERE lead_id IS NULL AND sender_kind = 'dana'").get().n, 1, 'a stub is left');
  assert.deepEqual(stats.ownerSummary({ from: a, to: NOW }).ai, before, 'the purge changes neither the count nor the median');
  db.close();
});

test('ownerSummary(): no fixed line PR-B3 sends as a dana row is an answer — each one alone, after the legacy prefix and after every nameless variant (PLAN T12, from T11 r12)', () => {
  assert.equal(FIXED_LINES.length, 14, 'the 4 hand-over variants (variant 0 is also the in-hours outage line), out of hours, the outage and closing lines, both languages');
  for (const line of FIXED_LINES) {
    const db = openDb(':memory:');
    const stats = createStats({ db, now });
    const from = NOW - DAY_MS;
    db.insertLead({ lead_id: 'LEAD-0401', created: from - DAY_MS, updated: from - DAY_MS, phone_e164: '966500000401', wa_jid: '966500000401@s.whatsapp.net',
      channel: 'whatsapp', match_method: 'ref', stage: 'new', inbox_state: 'in' });
    let n = 0;
    const send = (text) => {
      n += 1;
      db.db.prepare(`INSERT INTO wa_outbox (send_id, lead_id, jid, text, user_id, sender_kind, status, key_id, created, updated, error, covers_ts, guarded)
                     VALUES (?,'LEAD-0401','966500000401@s.whatsapp.net',?,NULL,'dana','accepted',NULL,?,?,NULL,?,0)`).run(`SND-F-${n}`, text, from + n * 100_000, from + n * 100_000, from + n * 100_000 - 5_000);
    };
    const lang = /[؀-ۿ]/.test(line) ? 'ar' : 'en';
    send(line);
    send(`${LEGACY_DISCLOSURE[lang]}\n\n${line}`);
    for (const prefix of disclosureVariants(lang)) send(`${prefix}\n\n${line}`);
    assert.deepEqual(stats.ownerSummary({ from, to: NOW }).ai.answers, 0, line);
    send('Yes, it has a private pool.');
    assert.equal(stats.ownerSummary({ from, to: NOW }).ai.answers, 1, `${line}: a real answer still counts`);
    db.close();
  }
});
