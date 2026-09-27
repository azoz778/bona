import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { buildTiktok } from '../lib/tiktok.mjs';
import { createFanout, configuredDests } from '../lib/fanout.mjs';
import { loadConfig, redacted } from '../lib/config.mjs';
const cfg = { siteUrl: 'https://example.test', tiktokPixelId: 'pixel-test', tiktokEventsToken: 'private-test-token', fanoutMs: 0 };
const ts = 1790540000000;
const session = { session_id: 'session', consent_ads: 1, ip: '192.0.2.1', ua: 'test', ttp: 'cookie', last_touch: { click_ids: { ttclid: 'click' } } };
const event = { event_id: 'browser-id', name: 'form_submit', ts, session_id: 'session', path: '/listing/?phone=secret#name', props: { message: 'never send this' } };

function harness({ consent = 1, config = cfg, response = { status: 200, ok: true, text: '{"code":0}' }, name = event.name } = {}) {
  const db = openDb(':memory:');
  db.upsertSession({ ...session, started: ts, last_seen: ts, consent_ads: consent });
  db.insertEvent({ ...event, name });
  db.enqueueFanout(event.event_id, ['tiktok'], { now: ts });
  const calls = [];
  const worker = createFanout({ db, cfg: config, now: () => ts, fetch: async (url, init) => {
    calls.push({ url, init });
    if (response.throw) throw new Error(response.throw);
    return { ...response, text: async () => response.text };
  } });
  return { db, calls, worker };
}

test('TikTok deduplicates using browser event name/id and minimizes payload', () => {
  const req = buildTiktok(event, { session, lead: { phone_e164: 'secret-phone' }, cfg: { ...cfg, tiktokTestEventCode: 'test-code' } });
  assert.equal(req.body.event_source, 'web');
  assert.equal(req.body.event_source_id, cfg.tiktokPixelId);
  assert.equal(req.body.test_event_code, 'test-code');
  assert.equal(req.body.data[0].event, 'SubmitForm');
  assert.equal(req.body.data[0].event_id, event.event_id);
  assert.equal(req.body.data[0].event_time, ts / 1000);
  assert.deepEqual(req.body.data[0].user, { ip: session.ip, user_agent: 'test', ttp: 'cookie', ttclid: 'click' });
  assert.equal(req.body.data[0].page.url, 'https://example.test/listing/');
  assert.ok(!JSON.stringify(req.body).includes('secret'));
  assert.equal(req.headers['Access-Token'], cfg.tiktokEventsToken);
  assert.equal(buildTiktok({ ...event, name: 'lead_stage' }, { session, cfg }), null);
  assert.equal(buildTiktok({ ...event, name: 'lead_created' }, { session, lead: { channel: 'whatsapp' }, cfg }), null);
  assert.equal(buildTiktok(event, { session: null, cfg }), null);
});

test('missing keys and absent ads consent never send, even with the legacy consent override', async () => {
  for (const opts of [{ config: {} }, { consent: 0 }, { consent: 0, config: { ...cfg, fanoutRequireConsent: false } }]) {
    const h = harness(opts);
    try { assert.equal((await h.worker.drainOnce()).skipped, 1); assert.equal(h.calls.length, 0); }
    finally { h.db.close(); }
  }
  assert.equal(configuredDests({ tiktokPixelId: 'x', tiktokEventsToken: ' ' }).tiktok, false);
});

test('HTTP 200 needs code zero; errors cannot leak response secrets into the DB', async () => {
  for (const [text, sent] of [['{"code":0}', 1], ['{"code":40002,"message":"private-test-token"}', 0], ['{}', 0], ['bad json', 0]]) {
    const h = harness({ response: { status: 200, ok: true, text } });
    try {
      const tally = await h.worker.drainOnce();
      assert.equal(tally.sent, sent); assert.equal(tally.failed, 1 - sent);
      const row = h.db.db.prepare('SELECT * FROM fanout').get();
      assert.ok(!JSON.stringify(row).includes(cfg.tiktokEventsToken));
      assert.equal(h.calls.length, 1);
      await h.worker.drainOnce(); assert.equal(h.calls.length, 1, 'terminal events do not resend');
    } finally { h.db.close(); }
  }
});

test('transport errors retry with the same id and bounded backoff', async () => {
  for (const response of [{ status: 429, ok: false, text: 'rate limit' }, { status: 503, ok: false, text: 'unavailable' }, { throw: cfg.tiktokEventsToken }]) {
    const h = harness({ response });
    try {
      assert.equal((await h.worker.drainOnce()).retried, 1);
      const row = h.db.db.prepare('SELECT * FROM fanout').get();
      assert.equal(row.event_id, event.event_id); assert.ok(row.next_at > ts);
      assert.ok(!row.last_error.includes(cfg.tiktokEventsToken));
      await h.worker.drainOnce(); assert.equal(h.calls.length, 1);
    } finally { h.db.close(); }
  }
});

test('config loads server token without putting it in redacted diagnostics', () => {
  const loaded = loadConfig({ env: { TIKTOK_PIXEL_ID: 'pixel', TIKTOK_EVENTS_ACCESS_TOKEN: cfg.tiktokEventsToken }, ids: {} });
  assert.equal(loaded.tiktokEventsToken, cfg.tiktokEventsToken);
  assert.equal(redacted(loaded).hasTiktokEventsToken, true);
  assert.ok(!JSON.stringify(redacted(loaded)).includes(cfg.tiktokEventsToken));
});
