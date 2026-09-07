import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeBoard, checkSiteTag, checkGsc, checkGa4, checkSnap, checkMetaCapi, checkApi, buildUserAgent, healthLink } from '../marketing/verify-integrations.mjs';

test('mergeBoard updates rows by id and appends unknown ids with their metadata', () => {
  const board = [
    { id: 'website', name: 'Website', status: 'live', owner: 'agent', action: 'x', link: 'https://bona.azoz.uk/' },
    { id: 'ga4', name: 'Google Analytics 4', status: 'pending-owner', owner: 'owner', action: 'paste the id', link: 'https://analytics.google.com/' },
  ];
  const merged = mergeBoard(board, [
    { id: 'ga4', status: 'live', detail: 'accepted' },
    { id: 'bona-api', status: 'error', detail: 'down' },
  ], '2026-09-06T00:00:00.000Z');
  assert.equal(merged.length, 3);
  assert.deepEqual(merged[0], board[0], 'untouched rows are kept as they were');
  assert.equal(merged[1].status, 'live');
  assert.equal(merged[1].detail, 'accepted');
  assert.equal(merged[1].checkedAt, '2026-09-06T00:00:00.000Z');
  assert.equal(merged[1].action, 'paste the id', 'existing owner text survives');
  assert.equal(merged[2].id, 'bona-api');
  assert.equal(merged[2].name, 'Concierge API (bona-api)');
  assert.equal(merged[2].status, 'error');
  assert.equal(board.length, 2, 'input is not mutated');
});

test('a site tag is pending-owner when absent, live when served, error when in site.json but not on the page', () => {
  const base = { id: 'meta-pixel', label: 'Meta Pixel', siteKey: 'metaPixel', checklist: 'docs/x.md' };
  assert.equal(checkSiteTag({ ...base, value: null, homeHtml: '<html></html>' }).status, 'pending-owner');
  assert.equal(checkSiteTag({ ...base, value: '123456', homeHtml: '<script>fbq("init","123456")</script>' }).status, 'live');
  assert.equal(checkSiteTag({ ...base, value: '123456', homeHtml: '<html>nothing</html>' }).status, 'error');
});

test('the Search Console tag is found in either attribute order and compared with site.json', () => {
  const site = { url: 'https://bona.azoz.uk', analytics: { gscVerification: 'abc' } };
  assert.equal(checkGsc({ site, homeHtml: '<meta name="google-site-verification" content="abc">' }).status, 'live');
  assert.equal(checkGsc({ site, homeHtml: '<meta content="abc" name="google-site-verification">' }).status, 'live');
  assert.equal(checkGsc({ site, homeHtml: '<meta name="google-site-verification" content="zzz">' }).status, 'error');
  assert.equal(checkGsc({ site: { url: 'https://bona.azoz.uk', analytics: {} }, homeHtml: '<html></html>' }).status, 'pending-owner');
});

/* A stand-in for probe(): records every call and answers from a canned map, so the GA4 check can be
   driven through all four of its outcomes without a byte leaving the machine. */
function fakeProbe(answers = {}) {
  const calls = [];
  const probe = async (url, init) => {
    calls.push({ url, init });
    const key = url.includes('/debug/mp/collect') ? 'debug' : 'collect';
    return answers[key] ?? (key === 'debug' ? { status: 200, ok: true, text: '{}', json: {} } : { status: 204, ok: true, text: '', json: null });
  };
  return { calls, probe };
}

const GA4_ENV = { GA4_MEASUREMENT_ID: 'G-TEST123', GA4_API_SECRET: 'sekrit-value' };
const GA4_SITE = { url: 'https://example.test', analytics: { ga4: 'G-TEST123' } };

test('GA4 without credentials is the owner\'s to fix and never touches the network', async () => {
  const { calls, probe } = fakeProbe();
  const r = await checkGa4({ env: {}, site: GA4_SITE, homeHtml: '<script>G-TEST123</script>', probe });
  assert.equal(r.status, 'pending-owner');
  assert.match(r.detail, /GA4_MEASUREMENT_ID empty/);
  assert.equal(calls.length, 0);
});

test('GA4 validation messages are an error and stop the run before the real event is sent', async () => {
  const { calls, probe } = fakeProbe({
    debug: { status: 200, ok: true, json: { validationMessages: [{ validationCode: 'VALUE_INVALID', description: 'measurement_id is not valid' }] } },
  });
  const r = await checkGa4({ env: GA4_ENV, site: GA4_SITE, homeHtml: '<script>G-TEST123</script>', probe });
  assert.equal(r.status, 'error');
  assert.match(r.detail, /VALUE_INVALID/);
  assert.equal(calls.length, 1, 'nothing is sent to the production endpoint once the payload is rejected');
});

test('a clean validation is not enough for live: the live page must actually serve the tag', async () => {
  for (const homeHtml of ['<html>no tag here</html>', null]) {
    const { calls, probe } = fakeProbe();
    const r = await checkGa4({ env: GA4_ENV, site: GA4_SITE, homeHtml, probe });
    assert.notEqual(r.status, 'live', `homeHtml ${JSON.stringify(homeHtml)} proves nothing about the tag`);
    assert.equal(r.status, 'error');
    assert.equal(calls.length, 2, 'both endpoints are still called — the ping is the point');
  }
  // No id in site.json at all: nothing is deployed yet, so it is the owner's move, not a failure.
  const { probe } = fakeProbe();
  const r = await checkGa4({ env: GA4_ENV, site: { url: 'https://example.test', analytics: {} }, homeHtml: '<html></html>', probe });
  assert.equal(r.status, 'pending-owner');
});

test('GA4 is live only with a clean validation and the tag served, and says acceptance is not ingestion', async () => {
  const { calls, probe } = fakeProbe();
  const r = await checkGa4({ env: GA4_ENV, site: GA4_SITE, homeHtml: '<script src="/gtag/js?id=G-TEST123">', probe });
  assert.equal(r.status, 'live');
  assert.deepEqual(calls.map((c) => new URL(c.url).pathname), ['/debug/mp/collect', '/mp/collect']);
  assert.equal(JSON.parse(calls[1].init.body).events[0].name, 'verify_ping');
  assert.equal(JSON.parse(calls[1].init.body).events[0].params.engagement_time_msec, 1);
  assert.ok(JSON.parse(calls[1].init.body).client_id, 'a client_id is required or GA4 drops the event');
  assert.match(r.detail, /NOT proof of ingestion/);
  assert.match(r.detail, /Realtime/);
  assert.ok(!r.detail.includes('sekrit-value'), 'the api_secret is scrubbed out of every detail line');
});

test('the User-Agent and the API row link are derived from site.json, never from a literal domain', () => {
  assert.equal(buildUserAgent({ url: 'https://example.test/' }), 'bona-verify-integrations/1.0 (+https://example.test)');
  assert.equal(buildUserAgent({}), 'bona-verify-integrations/1.0', 'no site.json url: a domain-free UA beats a stale one');
  assert.equal(healthLink({ concierge: { apiBase: 'https://api.example.test/' } }), 'https://api.example.test/health');
  assert.equal(healthLink({ concierge: {} }), null);
});

test('with no concierge.apiBase in site.json the API and Retell rows say so instead of probing a guess', async () => {
  let called = 0;
  const probe = async () => { called++; return { status: 200, ok: true, json: { ok: true } }; };
  const { api, retell } = await checkApi({ site: { url: 'https://example.test' }, probe });
  assert.equal(called, 0);
  assert.equal(api.status, 'pending-owner');
  assert.match(api.detail, /concierge\.apiBase/);
  assert.equal(retell.status, 'pending-owner');
  assert.match(retell.detail, /concierge\.apiBase/);
});

test('a declared apiBase is the host that gets probed', async () => {
  const seen = [];
  const probe = async (url) => { seen.push(url); return { status: 200, ok: true, json: { ok: true, version: '1.2.3', retell: 'ok' } }; };
  const { api, retell } = await checkApi({ site: { concierge: { apiBase: 'https://api.example.test/' } }, probe });
  assert.deepEqual(seen, ['https://api.example.test/health']);
  assert.equal(api.status, 'live');
  assert.equal(retell.status, 'live');
});

/* ---------------- Snap and Meta: the same endpoint honesty as GA4 ---------------- */

const SNAP_ENV = { SNAP_PIXEL_ID: 'snap-1', SNAP_CAPI_TOKEN: 'snap-token' };
const SNAP_SITE = { url: 'https://example.test', analytics: { snapPixel: 'snap-1' } };
const okSnap = async () => ({ status: 200, ok: true, text: '{}', json: {} });

test('Snap: a validated payload is not a served pixel — live needs the tag on the live page', async () => {
  // /events/validate is Snap's debug endpoint: it checks the token and the shape and ingests nothing.
  for (const homeHtml of [null, '<html>no pixel here</html>']) {
    const r = await checkSnap({ env: SNAP_ENV, site: SNAP_SITE, homeHtml, probe: okSnap });
    assert.notEqual(r.status, 'live', `homeHtml ${homeHtml === null ? 'not fetched' : 'without the id'}`);
    assert.equal(r.status, 'error');
  }
  const served = await checkSnap({ env: SNAP_ENV, site: SNAP_SITE, homeHtml: '<script>snap-1</script>', probe: okSnap });
  assert.equal(served.status, 'live');
  assert.match(served.detail, /ingests nothing/);
  assert.ok(!served.detail.includes('snap-token'), 'the token is never printed');
});

test('Snap with no pixel id in site.json is the owner\'s to paste, not an error', async () => {
  const r = await checkSnap({ env: SNAP_ENV, site: { url: 'https://example.test', analytics: {} }, homeHtml: '<html></html>', probe: okSnap });
  assert.equal(r.status, 'pending-owner');
  assert.match(r.detail, /analytics\.snapPixel/);
});

test('Snap refusing the payload is an error whatever the page serves', async () => {
  const bad = async () => ({ status: 401, ok: false, text: '{"reason":"BAD_TOKEN"}', json: { reason: 'BAD_TOKEN' } });
  const r = await checkSnap({ env: SNAP_ENV, site: SNAP_SITE, homeHtml: '<script>snap-1</script>', probe: bad });
  assert.equal(r.status, 'error');
  assert.match(r.detail, /BAD_TOKEN/);
});

const META_SITE = { url: 'https://example.test' };

test('Meta CAPI: a readable dataset proves the credentials, not that events arrive', async () => {
  const readable = async () => ({ status: 200, ok: true, text: '{}', json: { id: '111', name: 'Bona' } });
  const r = await checkMetaCapi({ env: { META_PIXEL_ID: '111', META_CAPI_TOKEN: 'tok' }, site: META_SITE, probe: readable });
  assert.equal(r.status, 'pending-owner', 'reading a dataset is not measuring one');
  assert.match(r.detail, /META_TEST_EVENT_CODE/);
  assert.ok(!r.detail.includes('tok'), 'the token is never printed');
});

test('Meta CAPI is live only when the dataset says it received the test event', async () => {
  const received = async () => ({ status: 200, ok: true, text: '{}', json: { events_received: 1 } });
  const env = { META_PIXEL_ID: '111', META_CAPI_TOKEN: 'tok', META_TEST_EVENT_CODE: 'TEST123' };
  const live = await checkMetaCapi({ env, site: META_SITE, probe: received });
  assert.equal(live.status, 'live');

  const nothing = async () => ({ status: 200, ok: true, text: '{}', json: { events_received: 0 } });
  const r = await checkMetaCapi({ env, site: META_SITE, probe: nothing });
  assert.equal(r.status, 'error');
});
