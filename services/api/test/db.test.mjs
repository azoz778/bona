import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, newId, STAGES, FANOUT_DESTS, SCHEMA_VERSION } from '../lib/db.mjs';

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-db-'));
  const file = path.join(dir, 'data', 'bona.db');
  return { dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const touch = (over = {}) => ({
  ts: 1757140000000, landing: '/properties/bona-w003/', referrer: 'https://l.instagram.com/',
  utm_source: 'meta', utm_medium: 'paid', utm_campaign: 'villas_sep', utm_content: 'reels', utm_term: null, utm_id: '1203',
  click_ids: { fbclid: 'IwAR1' }, ...over,
});

/* ---------------- opening, files, migrations ---------------- */

test('openDb creates an owner-only file inside an owner-only directory and migrates once', function (t) {
  const { file, cleanup } = tmp();
  const a = openDb(file);
  assert.equal(a.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.equal(a.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the database holds personal data');
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  }
  a.close();
  const b = openDb(file);
  assert.equal(b.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION, 'a second open is a no-op');
  const tables = b.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  for (const name of ['sessions', 'events', 'leads', 'touchpoints', 'lead_stage_history', 'wa_cursor', 'wa_seen', 'ad_spend', 'fanout', 'auth_codes', 'auth_sessions']) {
    assert.ok(tables.includes(name), name);
  }
  assert.equal(b.ping(), true);
  b.close();
  cleanup();
});

test('newId is prefix, base-36 time and four hex characters', () => {
  const id = newId('ev');
  assert.match(id, /^ev-[0-9a-z]{6,10}-[0-9a-f]{4}$/);
  assert.notEqual(id, newId('ev'));
  assert.deepEqual(STAGES, ['new', 'contacted', 'qualified', 'viewing', 'offer', 'negotiation', 'won', 'lost']);
  assert.deepEqual(FANOUT_DESTS, ['meta', 'ga4', 'snap']);
});

/* ---------------- sessions ---------------- */

test('a session keeps its first touch and moves its last touch, count and consent', () => {
  const s = openDb(':memory:');
  const first = touch();
  s.upsertSession({
    session_id: 'mf3k2a-7b1c', anon_id: 'a'.repeat(32), ref: 'K7Q2XR', started: 1000, last_seen: 1000, pages: 1, locale: 'en',
    first_touch: first, last_touch: first, fbp: 'fb.1.1', fbc: 'fb.1.2', ga_client_id: '1.2', ga_session_id: '3',
    ip: '1.2.3.4', ua: 'UA', country: 'SA', consent_analytics: false, consent_ads: false,
  });
  const later = touch({ ts: 2000, utm_campaign: 'villas_oct', referrer: 'https://www.google.com/' });
  s.upsertSession({ session_id: 'mf3k2a-7b1c', anon_id: 'a'.repeat(32), started: 2000, last_seen: 2000, pages: 1, last_touch: later, consent_analytics: true, consent_ads: true, ua: 'UA2' });
  const row = s.getSession('mf3k2a-7b1c');
  assert.equal(row.started, 1000, 'the start never moves');
  assert.equal(row.last_seen, 2000);
  assert.equal(row.pages, 2, 'pages count up');
  assert.deepEqual(row.first_touch, first, 'first touch is never overwritten');
  assert.deepEqual(row.last_touch, later);
  assert.equal(row.consent_analytics, 1);
  assert.equal(row.consent_ads, 1);
  assert.equal(row.ref, 'K7Q2XR');
  assert.equal(row.fbp, 'fb.1.1', 'ids the second call did not send are kept');
  assert.equal(row.ua, 'UA2', 'ids the second call did send are updated');
  assert.equal(s.getSessionByRef('k7q2xr').session_id, 'mf3k2a-7b1c', 'ref lookup is case-blind');
  assert.equal(s.getSession('nope'), null);
  assert.equal(s.getSessionByRef('ZZZZZZ'), null);
  s.close();
});

test('a ref that another session already owns is not stolen — the newer session simply has none', () => {
  const s = openDb(':memory:');
  s.upsertSession({ session_id: 'first0', anon_id: 'a'.repeat(32), ref: 'K7Q2XR', started: 1, last_seen: 1 });
  s.upsertSession({ session_id: 'second', anon_id: 'b'.repeat(32), ref: 'K7Q2XR', started: 2, last_seen: 2 });
  assert.equal(s.getSession('second').ref, null);
  assert.equal(s.getSessionByRef('K7Q2XR').session_id, 'first0');
  // …and a session that had no ref picks one up on a later call.
  s.upsertSession({ session_id: 'second', anon_id: 'b'.repeat(32), ref: 'ABCDEF', started: 3, last_seen: 3 });
  assert.equal(s.getSession('second').ref, 'ABCDEF');
  s.close();
});

/* ---------------- events ---------------- */

test('events insert once per event_id and can be read back by session, by name and by time', () => {
  const s = openDb(':memory:');
  const base = { anon_id: 'a'.repeat(32), session_id: 'sess-1', listing_id: 'BONA-W003', path: '/p/', props: { cta: 'x' }, src_first: touch(), src_last: touch(), ip: '1.1.1.1', ua: 'UA', country: 'SA' };
  assert.equal(s.insertEvent({ event_id: 'ev-1', ts: 100, name: 'page_view', ...base }), true);
  assert.equal(s.insertEvent({ event_id: 'ev-1', ts: 100, name: 'page_view', ...base }), false, 'a retry is ignored');
  assert.equal(s.insertEvent({ event_id: 'ev-2', ts: 200, name: 'whatsapp_click', ...base }), true);
  assert.equal(s.insertEvent({ event_id: 'ev-3', ts: 300, name: 'whatsapp_click', ...base, session_id: 'sess-2' }), true);
  const forSession = s.eventsForSession('sess-1');
  assert.deepEqual(forSession.map((e) => e.event_id), ['ev-1', 'ev-2']);
  assert.deepEqual(forSession[0].props, { cta: 'x' });
  assert.equal(forSession[0].src_last.utm_campaign, 'villas_sep');
  assert.deepEqual(s.recentEvents({ name: 'whatsapp_click', sinceTs: 150, untilTs: 250 }).map((e) => e.event_id), ['ev-2']);
  assert.deepEqual(s.recentEvents({ name: 'whatsapp_click', sinceTs: 0 }).map((e) => e.event_id), ['ev-3', 'ev-2'], 'newest first');
  assert.equal(s.getEvent('ev-2').name, 'whatsapp_click');
  assert.equal(s.getEvent('nope'), null);
  s.close();
});

/* ---------------- leads ---------------- */

test('leads round-trip, are found by phone or jid, and update without losing fields', () => {
  const s = openDb(':memory:');
  const lead = s.insertLead({
    lead_id: 'LEAD-20260906-abcd1234', created: 1, updated: 1, phone_e164: '966593296933', wa_jid: '966593296933@s.whatsapp.net', wa_lid: '1234@lid',
    name: 'Sara', channel: 'whatsapp', source: 'meta', medium: 'paid', campaign: 'villas_sep', campaign_id: '1203', content: 'reels',
    click_ids: { fbclid: 'x' }, ref: 'K7Q2XR', match_method: 'ref', session_id: 'sess-1', anon_id: 'a'.repeat(32), listing_id: 'BONA-W003',
    first_touch: touch(), last_touch: touch(), interest: 'villa', budget: '8m', timeline: 'soon', district: 'Al Shati', language: 'ar', notes: 'evenings',
    stage: 'new', stage_ts: 1, consent_ads: true, consent_analytics: true,
  });
  assert.equal(lead.lead_id, 'LEAD-20260906-abcd1234');
  assert.deepEqual(s.getLead('LEAD-20260906-abcd1234').click_ids, { fbclid: 'x' });
  assert.equal(s.getLeadByPhone('966593296933').name, 'Sara');
  assert.equal(s.getLeadByPhone('0593296933'), null, 'callers normalise before they ask');
  assert.equal(s.getLeadByJid('966593296933@s.whatsapp.net').name, 'Sara');
  assert.equal(s.getLeadByJid('1234@lid').name, 'Sara', 'the lid alias finds the same person');
  assert.equal(s.getLeadByJid('nope@lid'), null);
  s.updateLead('LEAD-20260906-abcd1234', { budget: '9m', updated: 5, not_a_column: 'x' });
  const after = s.getLead('LEAD-20260906-abcd1234');
  assert.equal(after.budget, '9m');
  assert.equal(after.name, 'Sara');
  assert.equal(after.updated, 5);
  assert.throws(() => s.insertLead({ lead_id: 'LEAD-2', phone_e164: '966593296933', created: 2, updated: 2 }), /UNIQUE/, 'one phone, one lead');
  s.close();
});

test('listLeads filters by stage and by a search term', () => {
  const s = openDb(':memory:');
  s.insertLead({ lead_id: 'L1', created: 1, updated: 1, phone_e164: '966500000001', name: 'Sara Ahmed', stage: 'new', stage_ts: 1 });
  s.insertLead({ lead_id: 'L2', created: 2, updated: 2, phone_e164: '966500000002', name: 'Omar', stage: 'viewing', stage_ts: 2, notes: 'wants Al Shati' });
  s.insertLead({ lead_id: 'L3', created: 3, updated: 3, wa_jid: 'x@lid', name: 'Nobody', stage: 'lost', stage_ts: 3 });
  assert.deepEqual(s.listLeads().map((l) => l.lead_id), ['L3', 'L2', 'L1'], 'newest first');
  assert.deepEqual(s.listLeads({ stage: 'viewing' }).map((l) => l.lead_id), ['L2']);
  assert.deepEqual(s.listLeads({ q: 'shati' }).map((l) => l.lead_id), ['L2']);
  assert.deepEqual(s.listLeads({ q: '0000001' }).map((l) => l.lead_id), ['L1']);
  assert.deepEqual(s.listLeads({ limit: 1 }).map((l) => l.lead_id), ['L3']);
  s.close();
});

test('touchpoints and stage history accumulate on a lead', () => {
  const s = openDb(':memory:');
  s.insertLead({ lead_id: 'L1', created: 1, updated: 1, phone_e164: '966500000001', stage: 'new', stage_ts: 1 });
  const tp = s.addTouchpoint({ lead_id: 'L1', ts: 10, channel: 'whatsapp', event_type: 'lead_created', source: 'meta', medium: 'paid', campaign: 'villas_sep', campaign_id: '1203', listing_id: 'BONA-W003', meta: { ref: 'K7Q2XR' } });
  assert.match(tp.id, /^tp-/);
  s.addTouchpoint({ id: 'tp-custom', lead_id: 'L1', ts: 20, channel: 'whatsapp', event_type: 'inbound_message' });
  const tps = s.touchpointsForLead('L1');
  assert.deepEqual(tps.map((t) => t.event_type), ['lead_created', 'inbound_message']);
  assert.deepEqual(tps[0].meta, { ref: 'K7Q2XR' });

  const h = s.setStage('L1', 'viewing', { actor: 'owner', note: 'Sat 4pm', now: 30 });
  assert.equal(h.stage, 'viewing');
  s.setStage('L1', 'won', { actor: 'owner', valueSar: 6700000, now: 40 });
  const lead = s.getLead('L1');
  assert.equal(lead.stage, 'won');
  assert.equal(lead.stage_ts, 40);
  assert.equal(lead.value_sar, 6700000);
  assert.equal(lead.updated, 40);
  assert.deepEqual(s.stageHistory('L1').map((r) => [r.stage, r.actor, r.note]), [['viewing', 'owner', 'Sat 4pm'], ['won', 'owner', null]]);
  assert.throws(() => s.setStage('L1', 'closed', {}), /stage/);
  assert.throws(() => s.setStage('nope', 'won', {}), /lead/);
  s.close();
});

/* ---------------- fan-out ---------------- */

test('fan-out rows are queued once per destination, come due in order, and record their outcome', () => {
  const s = openDb(':memory:');
  assert.equal(s.enqueueFanout('ev-1', ['meta', 'ga4', 'snap'], { now: 100 }), 3);
  assert.equal(s.enqueueFanout('ev-1', ['meta'], { now: 100 }), 0, 'already queued');
  assert.throws(() => s.enqueueFanout('ev-2', ['pinterest']), /dest/);
  assert.equal(s.dueFanout(99).length, 0, 'nothing is due before it was queued');
  assert.deepEqual(s.dueFanout(100).map((r) => r.dest), ['meta', 'ga4', 'snap']);
  s.markFanout('ev-1', 'meta', { status: 'sent', attempts: 1, response: '{"events_received":1}' });
  s.markFanout('ev-1', 'ga4', { status: 'pending', attempts: 1, nextAt: 5000, lastError: 'http_500' });
  s.markFanout('ev-1', 'snap', { status: 'skipped', attempts: 0, lastError: 'no_consent' });
  assert.deepEqual(s.dueFanout(100), []);
  const retry = s.dueFanout(5000);
  assert.equal(retry.length, 1);
  assert.equal(retry[0].dest, 'ga4');
  assert.equal(retry[0].attempts, 1);
  assert.equal(retry[0].last_error, 'http_500');
  assert.deepEqual(s.fanoutCounts(), { pending: 1, sent: 1, failed: 0, skipped: 1 });
  assert.throws(() => s.markFanout('ev-1', 'ga4', { status: 'lost' }), /status/);
  s.close();
});

/* ---------------- dashboard auth ---------------- */

test('a login code is one-shot, expires, and five wrong guesses burn it', () => {
  const s = openDb(':memory:');
  s.createAuthCode('123456', { now: 1000, ttlMs: 600_000 });
  assert.equal(s.consumeAuthCode('000000', { now: 1001 }).ok, false);
  assert.equal(s.consumeAuthCode('123456', { now: 1002 }).ok, true);
  assert.equal(s.consumeAuthCode('123456', { now: 1003 }).ok, false, 'used once');

  s.createAuthCode('222222', { now: 2000, ttlMs: 600_000 });
  assert.equal(s.consumeAuthCode('222222', { now: 2000 + 600_001 }).ok, false, 'expired');

  s.createAuthCode('333333', { now: 3000, ttlMs: 600_000 });
  for (let i = 0; i < 5; i += 1) assert.equal(s.consumeAuthCode('999999', { now: 3001 + i }).ok, false);
  const burnt = s.consumeAuthCode('333333', { now: 3010 });
  assert.equal(burnt.ok, false, 'five wrong guesses and the right code no longer works');
  assert.equal(burnt.reason, 'attempts');
  assert.ok(!s.db.prepare('SELECT code_hash FROM auth_codes').all().some((r) => r.code_hash.includes('333333')), 'codes are stored hashed');
  s.close();
});

test('a dashboard session is checked by token hash and can be deleted or expire', () => {
  const s = openDb(':memory:');
  s.createAuthSession('tok_secret', { now: 1000, ttlMs: 30 * 86_400_000, ua: 'UA' });
  assert.equal(s.checkAuthSession('tok_secret', { now: 2000 }).ua, 'UA');
  assert.equal(s.checkAuthSession('tok_other', { now: 2000 }), null);
  assert.equal(s.checkAuthSession('tok_secret', { now: 1000 + 31 * 86_400_000 }), null, 'expired');
  s.createAuthSession('tok_two', { now: 1000, ttlMs: 1000 });
  assert.equal(s.deleteAuthSession('tok_two'), true);
  assert.equal(s.deleteAuthSession('tok_two'), false);
  assert.ok(!s.db.prepare('SELECT token_hash FROM auth_sessions').all().some((r) => r.token_hash.includes('tok_')), 'tokens are stored hashed');
  s.close();
});

/* ---------------- WhatsApp poller state, spend ---------------- */

test('the poller cursor and the seen-set persist, and old keys are pruned', () => {
  const s = openDb(':memory:');
  assert.equal(s.waCursorGet('abdulaziz-personal'), null);
  s.waCursorSet('abdulaziz-personal', { lastTs: 100, lastRun: 110, unmatched: 3 });
  s.waCursorSet('abdulaziz-personal', { lastTs: 200, lastRun: 210, unmatched: 4 });
  assert.deepEqual(s.waCursorGet('abdulaziz-personal'), { instance: 'abdulaziz-personal', last_ts: 200, last_run: 210, unmatched: 4 });
  assert.equal(s.waSeenHas('k1'), false);
  assert.equal(s.waSeenAdd('k1', 100), true);
  assert.equal(s.waSeenAdd('k1', 100), false);
  s.waSeenAdd('k2', 500);
  assert.equal(s.waSeenHas('k1'), true);
  assert.equal(s.pruneWaSeen(300), 1);
  assert.equal(s.waSeenHas('k1'), false);
  assert.equal(s.waSeenHas('k2'), true);
  s.close();
});

test('ad spend upserts per day, platform and campaign', () => {
  const s = openDb(':memory:');
  s.upsertSpend({ day: '2026-09-01', platform: 'meta', campaign_id: '1203', campaign_name: 'villas_sep', spend_sar: 100, clicks: 10, impressions: 1000 });
  s.upsertSpend({ day: '2026-09-01', platform: 'meta', campaign_id: '1203', campaign_name: 'villas_sep', spend_sar: 120, clicks: 12, impressions: 1200 });
  s.upsertSpend({ day: '2026-09-02', platform: 'snap', campaign_id: 's1', campaign_name: 'snap_sep', spend_sar: 50, clicks: 5, impressions: 500 });
  const all = s.listSpend();
  assert.equal(all.length, 2);
  assert.equal(all.find((r) => r.platform === 'meta').spend_sar, 120, 'the later entry replaces the earlier one');
  assert.deepEqual(s.listSpend({ fromDay: '2026-09-02' }).map((r) => r.platform), ['snap']);
  assert.deepEqual(s.listSpend({ platform: 'meta' }).map((r) => r.day), ['2026-09-01']);
  s.close();
});
