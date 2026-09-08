/**
 * The dashboard's numbers, over a seeded store: three sessions, a dozen events, four
 * leads whose first and last touches deliberately disagree, and two days of spend on
 * one campaign.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createStats, dayKey, median, percentile, licenceFlags, expiryMs, platformOf, DAY_MS } from '../lib/dashboard/stats.mjs';

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

test('overview() carries every section plus the totals', () => {
  const { stats } = seeded();
  const o = stats.overview(7);
  assert.equal(o.days, 7);
  assert.equal(o.daily.length, 7);
  assert.ok(Array.isArray(o.sources) && Array.isArray(o.match_quality) && Array.isArray(o.pipeline) && Array.isArray(o.cpl_by_campaign));
  assert.equal(o.response_times.count, 2);
  assert.deepEqual(o.totals, { leads: 4, sessions: 3, events: 12 });
});
