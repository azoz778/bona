import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../lib/db.mjs';
import { createFanout, configuredDests, buildMeta, buildGa4, buildSnap, backoffMs, isRetryable, MAX_ATTEMPTS } from '../lib/fanout.mjs';

const NOW = 1_757_200_000_000;
const ANON = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

const CFG = {
  siteUrl: 'https://bona-real-estate.com',
  metaPixelId: '111', metaCapiToken: 'meta-token', metaTestEventCode: '',
  ga4MeasurementId: 'G-TEST', ga4ApiSecret: 'ga-secret',
  snapPixelId: 'snap-1', snapCapiToken: 'snap-token',
  fanoutMs: 0,
};

/** A store with one consented session, one lead and one queued event on it. */
function seeded({ consentAds = 1, name = 'lead_created', dests = ['meta', 'ga4', 'snap'] } = {}) {
  const db = openDb(':memory:');
  db.upsertSession({
    session_id: 'mf3k2a-7b1c', anon_id: ANON, ref: 'K7Q2XR', started: NOW, last_seen: NOW, pages: 1, locale: 'ar',
    first_touch: { ts: NOW, utm_source: 'meta', utm_medium: 'paid', utm_campaign: 'villas_sep' }, last_touch: null,
    fbp: 'fb.1.1.2', fbc: 'fb.1.1.IwAR1', ga_client_id: '123.456', ga_session_id: '999', scid: 'sc-1', ttp: null,
    ip: '2.2.2.2', ua: 'Mozilla/5.0', country: 'SA', consent_analytics: 1, consent_ads: consentAds,
  });
  db.insertLead({
    lead_id: 'LEAD-20260908-abcdef01', created: NOW, updated: NOW, phone_e164: '966500000000', name: 'Sara Ahmed',
    channel: 'form', source: 'meta', medium: 'paid', campaign: 'villas_sep', session_id: 'mf3k2a-7b1c', anon_id: ANON,
    listing_id: 'BONA-W003', stage: 'new', stage_ts: NOW,
  });
  db.insertEvent({
    event_id: 'ev-1', ts: NOW, name, anon_id: ANON, session_id: 'mf3k2a-7b1c', lead_id: 'LEAD-20260908-abcdef01',
    listing_id: 'BONA-W003', path: '/ar/properties/bona-w003/', props: { form: 'listing' },
    ip: '2.2.2.2', ua: 'Mozilla/5.0', country: 'SA',
  });
  db.enqueueFanout('ev-1', dests, { now: NOW });
  return db;
}

/** A fetch that records every call and answers from a queue of canned responses. */
function recorder(responses = []) {
  const calls = [];
  let i = 0;
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = responses[Math.min(i++, responses.length - 1)] ?? { status: 200, body: '{}' };
    if (r.throw) throw new Error(r.throw);
    return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => r.body ?? '' };
  };
  return { fetch, calls };
}

/* ---------------- credentials ---------------- */

test('a destination with no credentials is skipped, not queued forever', async () => {
  const db = seeded();
  const { fetch, calls } = recorder();
  const fanout = createFanout({ db, cfg: { ...CFG, metaCapiToken: '', ga4ApiSecret: '', snapPixelId: '' }, fetch, now: () => NOW });
  assert.deepEqual(fanout.dests(), { meta: false, ga4: false, snap: false });

  const out = await fanout.drainOnce();
  assert.deepEqual(out, { sent: 0, skipped: 3, retried: 0, failed: 0 });
  assert.equal(calls.length, 0, 'nothing is sent to a platform we have no key for');
  assert.deepEqual(db.fanoutCounts(), { pending: 0, sent: 0, failed: 0, skipped: 3 });
  // A skipped row is terminal: the next pass has nothing due, so /health stays honest.
  assert.deepEqual(db.dueFanout(NOW + 86_400_000), []);
  db.close();
});

test('configuredDests needs both halves of every credential pair', () => {
  assert.deepEqual(configuredDests({}), { meta: false, ga4: false, snap: false });
  assert.deepEqual(configuredDests({ metaPixelId: '1' }), { meta: false, ga4: false, snap: false });
  assert.deepEqual(configuredDests(CFG), { meta: true, ga4: true, snap: true });
});

/* ---------------- consent ---------------- */

test('without the visitor\'s ads consent nothing reaches an ad platform', async () => {
  const db = seeded({ consentAds: 0 });
  const { fetch, calls } = recorder();
  const fanout = createFanout({ db, cfg: CFG, fetch, now: () => NOW });
  const out = await fanout.drainOnce();
  assert.equal(calls.length, 0);
  assert.equal(out.skipped, 3);
  const row = db.dueFanout(NOW + 1, { limit: 10 });
  assert.deepEqual(row, [], 'skipped rows do not come round again');
  db.close();
});

test('a deployment with another legal basis can lift the consent gate', async () => {
  const db = seeded({ consentAds: 0 });
  const { fetch, calls } = recorder();
  const fanout = createFanout({ db, cfg: { ...CFG, fanoutRequireConsent: false }, fetch, now: () => NOW });
  const out = await fanout.drainOnce();
  assert.equal(out.sent, 3);
  assert.equal(calls.length, 3);
  db.close();
});

/* ---------------- payloads ---------------- */

test('the Meta payload carries the browser\'s event id, its cookies and a hashed phone — never a raw one', () => {
  const db = seeded();
  const event = db.getEvent('ev-1');
  const built = buildMeta(event, { session: db.getSession('mf3k2a-7b1c'), lead: db.getLead('LEAD-20260908-abcdef01'), cfg: CFG });
  const d = built.body.data[0];
  assert.equal(d.event_name, 'Lead');
  assert.equal(d.event_id, 'ev-1', 'the pixel sent the same id, so Meta counts the pair once');
  assert.equal(d.event_time, Math.floor(NOW / 1000));
  assert.equal(d.event_source_url, 'https://bona-real-estate.com/ar/properties/bona-w003/');
  assert.equal(d.user_data.fbp, 'fb.1.1.2');
  assert.equal(d.user_data.ph, crypto.createHash('sha256').update('966500000000').digest('hex'));
  assert.ok(!JSON.stringify(built.body).includes('966500000000'), 'no unhashed phone number leaves this process');
  assert.ok(!JSON.stringify(built.body).includes('Sara'), 'no unhashed name either');
  assert.deepEqual(d.custom_data.content_ids, ['BONA-W003']);
  assert.equal(built.body.access_token, 'meta-token');
  assert.equal(built.body.test_event_code, undefined, 'an empty test code is left out entirely');
  db.close();
});

test('the GA4 payload stitches onto the browser\'s own client id', () => {
  const db = seeded();
  const built = buildGa4(db.getEvent('ev-1'), { session: db.getSession('mf3k2a-7b1c'), lead: db.getLead('LEAD-20260908-abcdef01'), cfg: CFG });
  assert.match(built.url, /measurement_id=G-TEST&api_secret=ga-secret$/);
  assert.equal(built.body.client_id, '123.456');
  assert.equal(built.body.non_personalized_ads, false);
  assert.equal(built.body.events[0].name, 'generate_lead');
  assert.equal(built.body.events[0].params.listing_id, 'BONA-W003');
  assert.equal(built.body.events[0].params.campaign, 'villas_sep');
  db.close();
});

test('a session with no GA cookie still gets a stable client id from the anon id', () => {
  const db = seeded();
  const session = { ...db.getSession('mf3k2a-7b1c'), ga_client_id: null };
  const a = buildGa4(db.getEvent('ev-1'), { session, lead: null, cfg: CFG });
  const b = buildGa4(db.getEvent('ev-1'), { session, lead: null, cfg: CFG });
  assert.equal(a.body.client_id, b.body.client_id, 'the same visitor must not become two users');
  assert.match(a.body.client_id, /^\d+\.\d+$/);
  db.close();
});

test('the Snap payload is a bearer-token POST with a hashed phone', () => {
  const db = seeded();
  const built = buildSnap(db.getEvent('ev-1'), { session: db.getSession('mf3k2a-7b1c'), lead: db.getLead('LEAD-20260908-abcdef01'), cfg: CFG });
  assert.equal(built.headers.Authorization, 'Bearer snap-token');
  assert.equal(built.body.data[0].event_name, 'SIGN_UP');
  assert.equal(built.body.data[0].user_data.hashed_phone_number, crypto.createHash('sha256').update('966500000000').digest('hex'));
  db.close();
});

test('an event no destination has a name for is skipped rather than guessed at', async () => {
  const db = seeded({ name: 'gallery_open', dests: ['meta'] });
  const { fetch, calls } = recorder();
  const fanout = createFanout({ db, cfg: CFG, fetch, now: () => NOW });
  const out = await fanout.drainOnce();
  assert.equal(calls.length, 0);
  assert.equal(out.skipped, 1);
  assert.deepEqual(db.fanoutCounts(), { pending: 0, sent: 0, failed: 0, skipped: 1 });
  db.close();
});

/* ---------------- delivery, retries, giving up ---------------- */

test('a delivered row is marked sent, with the platform\'s answer kept for the audit', async () => {
  const db = seeded({ dests: ['meta'] });
  const { fetch, calls } = recorder([{ status: 200, body: '{"events_received":1}' }]);
  const fanout = createFanout({ db, cfg: CFG, fetch, now: () => NOW });
  assert.deepEqual(await fanout.drainOnce(), { sent: 1, skipped: 0, retried: 0, failed: 0 });
  assert.match(calls[0].url, /graph\.facebook\.com\/v21\.0\/111\/events$/);
  assert.deepEqual(db.fanoutCounts(), { pending: 0, sent: 1, failed: 0, skipped: 0 });
  // Sent rows never come back round, so a second pass is a no-op.
  assert.deepEqual(await fanout.drainOnce(), { sent: 0, skipped: 0, retried: 0, failed: 0 });
  assert.equal(calls.length, 1);
  db.close();
});

test('a throttle or an outage is retried with a growing backoff; a bad request is not', async () => {
  const db = seeded({ dests: ['meta'] });
  const { fetch } = recorder([{ status: 429, body: 'slow down' }]);
  let t = NOW;
  const fanout = createFanout({ db, cfg: CFG, fetch, now: () => t });
  assert.deepEqual(await fanout.drainOnce(), { sent: 0, skipped: 0, retried: 1, failed: 0 });
  assert.deepEqual(db.fanoutCounts(), { pending: 1, sent: 0, failed: 0, skipped: 0 });
  assert.deepEqual(db.dueFanout(t), [], 'the retry is in the future, not immediately');
  assert.equal(db.dueFanout(t + backoffMs(1)).length, 1);

  // A 400 is the platform saying the payload or the token is wrong: re-sending never helps.
  const other = seeded({ dests: ['meta'] });
  const bad = recorder([{ status: 400, body: '{"error":{"message":"Invalid parameter"}}' }]);
  const f2 = createFanout({ db: other, cfg: CFG, fetch: bad.fetch, now: () => NOW });
  assert.deepEqual(await f2.drainOnce(), { sent: 0, skipped: 0, retried: 0, failed: 1 });
  assert.deepEqual(other.fanoutCounts(), { pending: 0, sent: 0, failed: 1, skipped: 0 });
  db.close();
  other.close();
});

test('a network error is retryable, and the row gives up after MAX_ATTEMPTS', async () => {
  const db = seeded({ dests: ['meta'] });
  const { fetch } = recorder([{ throw: 'ECONNRESET' }]);
  let t = NOW;
  const fanout = createFanout({ db, cfg: CFG, fetch, now: () => t });
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    await fanout.drainOnce();
    t += backoffMs(i + 1) + 1;
  }
  assert.deepEqual(db.fanoutCounts(), { pending: 0, sent: 0, failed: 1, skipped: 0 });
  db.close();
});

test('retry classification', () => {
  for (const s of [0, 429, 500, 503]) assert.equal(isRetryable(s), true, String(s));
  for (const s of [400, 401, 403, 404]) assert.equal(isRetryable(s), false, String(s));
  assert.ok(backoffMs(1) < backoffMs(3));
  assert.ok(backoffMs(50) <= 6 * 3_600_000, 'the backoff is capped');
});

test('a queued row whose event has gone is skipped, not retried until it gives up', async () => {
  const db = openDb(':memory:');
  db.enqueueFanout('ev-missing', ['meta'], { now: NOW });
  const { fetch, calls } = recorder();
  const fanout = createFanout({ db, cfg: CFG, fetch, now: () => NOW });
  assert.deepEqual(await fanout.drainOnce(), { sent: 0, skipped: 1, retried: 0, failed: 0 });
  assert.equal(calls.length, 0);
  db.close();
});

test('start() is a no-op with no interval and never holds the process open', async () => {
  const db = seeded();
  const { fetch } = recorder();
  const off = createFanout({ db, cfg: { ...CFG, fanoutMs: 0 }, fetch });
  assert.equal(off.start(), false);
  assert.equal(off.started, false);

  const on = createFanout({ db, cfg: { ...CFG, fanoutMs: 5_000 }, fetch });
  assert.equal(on.start(), true);
  assert.equal(on.start(), false, 'starting twice does not give the queue two drains');
  on.stop();
  assert.equal(on.started, false);
  db.close();
});
