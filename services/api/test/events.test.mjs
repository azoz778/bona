import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent, cleanAttrIds, recordEvent, EVENT_NAMES, SERVER_EVENT_NAMES, MAX_BODY_BYTES, MAX_PROPS_BYTES } from '../lib/events.mjs';
import { openDb } from '../lib/db.mjs';

const NOW = 1757150000000;
const ANON = '9f1c'.repeat(8);
const touch = (over = {}) => ({
  ts: NOW - 10_000, landing: '/properties/bona-w003/', referrer: 'https://l.instagram.com/',
  utm_source: 'meta', utm_medium: 'paid', utm_campaign: 'villas_sep', utm_content: 'reels', utm_term: null, utm_id: '1203',
  click_ids: { fbclid: 'IwAR1' }, ...over,
});
const sample = (over = {}) => ({
  v: 1, event_id: 'mf3k2a1b-9c4e7f21', ts: NOW, event: 'whatsapp_click',
  anon_id: ANON, session_id: 'mf3k2a-7b1c', ref: 'K7Q2XR', page: '/properties/bona-w003/', locale: 'en',
  listing_id: 'BONA-W003', props: { cta: 'listing_whatsapp', href: 'https://wa.me/966593296933' },
  attr: { first: touch(), last: touch({ ts: NOW - 1000 }), fbp: 'fb.1.1.2', fbc: 'fb.1.3.IwAR1', ga: { client_id: '123.456', session_id: '1757149000' }, scid: null, ttp: null },
  consent: { analytics: true, ads: true },
  ...over,
});

test('the taxonomy is split between what a browser may send and what only the server writes', () => {
  assert.deepEqual(EVENT_NAMES, ['page_view', 'listing_view', 'gallery_open', 'tour_open', 'video_play', 'brochure_download', 'whatsapp_click', 'call_click', 'form_submit', 'consent_update', 'concierge_open']);
  assert.deepEqual(SERVER_EVENT_NAMES, ['concierge_chat_start', 'concierge_call_start', 'lead_created', 'lead_stage']);
  assert.equal(MAX_BODY_BYTES, 8 * 1024);
  assert.equal(MAX_PROPS_BYTES, 2 * 1024);
});

test('the C1 sample validates and comes back normalised', () => {
  const r = validateEvent(sample(), { now: NOW });
  assert.equal(r.ok, true);
  const e = r.event;
  assert.equal(e.event, 'whatsapp_click');
  assert.equal(e.event_id, 'mf3k2a1b-9c4e7f21');
  assert.equal(e.ts, NOW);
  assert.equal(e.anon_id, ANON);
  assert.equal(e.session_id, 'mf3k2a-7b1c');
  assert.equal(e.ref, 'K7Q2XR');
  assert.equal(e.listing_id, 'BONA-W003');
  assert.equal(e.page, '/properties/bona-w003/');
  assert.equal(e.locale, 'en');
  assert.deepEqual(e.props, { cta: 'listing_whatsapp', href: 'https://wa.me/966593296933' });
  assert.equal(e.attr.first.utm_campaign, 'villas_sep');
  assert.deepEqual(e.attr.first.click_ids, { fbclid: 'IwAR1' });
  assert.equal(e.attr.last.ts, NOW - 1000);
  assert.deepEqual(e.attr.ga, { client_id: '123.456', session_id: '1757149000' });
  assert.equal(e.attr.scid, null);
  assert.deepEqual(e.consent, { analytics: true, ads: true });
});

test('every browser event name is accepted, every server-only name is refused', () => {
  for (const name of EVENT_NAMES) assert.equal(validateEvent(sample({ event: name }), { now: NOW }).ok, true, name);
  for (const name of SERVER_EVENT_NAMES) {
    const r = validateEvent(sample({ event: name }), { now: NOW });
    assert.equal(r.ok, false, name);
    assert.equal(r.error, 'bad_event');
    assert.equal(r.reason, 'server_only');
  }
  assert.equal(validateEvent(sample({ event: 'purchase' }), { now: NOW }).ok, false);
  assert.equal(validateEvent(sample({ event: '' }), { now: NOW }).ok, false);
});

test('each id has to match its shape', () => {
  const bad = (over) => assert.equal(validateEvent(sample(over), { now: NOW }).ok, false, JSON.stringify(over));
  bad({ anon_id: 'ABC' });
  bad({ anon_id: 'g'.repeat(32) });
  bad({ anon_id: undefined });
  bad({ session_id: 'ab' });
  bad({ session_id: 'a'.repeat(25) });
  bad({ session_id: 'UPPER-1' });
  bad({ ref: 'K7Q2XRZZ' });
  bad({ ref: '0O1I' });
  bad({ event_id: 'short' });
  bad({ event_id: 'a'.repeat(41) });
  bad({ listing_id: 'TK-001' });
  bad({ listing_id: 'BONA-W0003' });
  bad({ v: 2 });
  assert.equal(validateEvent(null, { now: NOW }).ok, false);
  assert.equal(validateEvent([], { now: NOW }).ok, false);
  assert.equal(validateEvent('str', { now: NOW }).ok, false);
  // …and the optional ones may be absent or null.
  const r = validateEvent(sample({ ref: null, listing_id: null, page: undefined, locale: undefined, props: undefined, attr: undefined, consent: undefined, v: undefined }), { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.event.ref, null);
  assert.equal(r.event.listing_id, null);
  assert.equal(r.event.page, null);
  assert.equal(r.event.locale, 'en');
  assert.deepEqual(r.event.props, {});
  assert.deepEqual(r.event.consent, { analytics: false, ads: false });
  assert.equal(r.event.attr.first, null);
  assert.equal(validateEvent(sample({ ref: 'k7q2xr', listing_id: 'bona-w003' }), { now: NOW }).event.ref, 'K7Q2XR', 'lower case is folded, not refused');
  assert.equal(validateEvent(sample({ ref: 'k7q2xr', listing_id: 'bona-w003' }), { now: NOW }).event.listing_id, 'BONA-W003');
});

test('strings are capped, unknown keys are dropped, consent is coerced', () => {
  const r = validateEvent(sample({
    page: `/${'x'.repeat(500)}`, locale: 'ar-SA', evil: 'x', consent: { analytics: 'yes', ads: 0, other: true },
    props: { cta: 'x'.repeat(500), n: 3, b: false, z: null, nested: { a: 1 }, arr: [1], fn: 'y' },
    attr: { first: touch({ utm_source: 'u'.repeat(400), evil: 1, click_ids: { fbclid: 'f', 'bad key!': 'x', gclid: '' } }), last: 'nope', fbp: 42, ga: { client_id: 'c', extra: 1 }, evil: 1 },
  }), { now: NOW });
  assert.equal(r.ok, true);
  const e = r.event;
  assert.equal(e.page.length, 300);
  assert.equal(e.locale, 'ar');
  assert.equal('evil' in e, false);
  assert.deepEqual(e.consent, { analytics: true, ads: false });
  assert.deepEqual(e.props, { cta: 'x'.repeat(300), n: 3, b: false, z: null, fn: 'y' });
  assert.equal(e.attr.first.utm_source.length, 300);
  assert.equal('evil' in e.attr.first, false);
  assert.deepEqual(e.attr.first.click_ids, { fbclid: 'f' });
  assert.equal(e.attr.last, null, 'a touch that is not an object is dropped');
  assert.equal(e.attr.fbp, null, 'a non-string id is dropped');
  assert.deepEqual(e.attr.ga, { client_id: 'c', session_id: null });
  assert.equal('evil' in e.attr, false);
});

test('props over 2 KB serialised are refused', () => {
  const r = validateEvent(sample({ props: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'v'.repeat(200)])) }), { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'props_too_large');
});

test('a timestamp far from now is replaced by now', () => {
  assert.equal(validateEvent(sample({ ts: NOW - 6 * 86_400_000 }), { now: NOW }).event.ts, NOW - 6 * 86_400_000);
  assert.equal(validateEvent(sample({ ts: NOW - 8 * 86_400_000 }), { now: NOW }).event.ts, NOW);
  assert.equal(validateEvent(sample({ ts: NOW + 8 * 86_400_000 }), { now: NOW }).event.ts, NOW);
  assert.equal(validateEvent(sample({ ts: 'yesterday' }), { now: NOW }).event.ts, NOW);
  assert.equal(validateEvent(sample({ ts: undefined }), { now: NOW }).event.ts, NOW);
});

test('cleanAttrIds keeps what matches and silently drops the rest', () => {
  assert.deepEqual(cleanAttrIds({ anon_id: ANON, session_id: 'mf3k2a-7b1c', ref: 'k7q2xr', listing_id: 'BONA-W003', evil: 1 }), { anon_id: ANON, session_id: 'mf3k2a-7b1c', ref: 'K7Q2XR', listing_id: 'BONA-W003' });
  assert.deepEqual(cleanAttrIds({ anon_id: 'nope', session_id: 42, ref: 'K7Q2XRZZ', listing_id: 'TK-1' }), { anon_id: null, session_id: null, ref: null, listing_id: null });
  assert.deepEqual(cleanAttrIds(null), { anon_id: null, session_id: null, ref: null, listing_id: null });
  assert.deepEqual(cleanAttrIds('x'), { anon_id: null, session_id: null, ref: null, listing_id: null });
});

test('recordEvent upserts the session, stores the event with the server context, and queues Meta for a WhatsApp click', () => {
  const db = openDb(':memory:');
  const server = { ip: '203.0.113.9', ua: 'Mozilla/5.0', country: 'SA', received: NOW + 5 };
  const view = validateEvent(sample({ event: 'page_view', event_id: 'mf3k2a1b-view0001', ts: NOW - 5000, consent: { analytics: false, ads: false } }), { now: NOW }).event;
  assert.deepEqual(recordEvent(db, view, server), { inserted: true });
  const click = validateEvent(sample(), { now: NOW }).event;
  assert.deepEqual(recordEvent(db, click, server), { inserted: true });
  assert.deepEqual(recordEvent(db, click, server), { inserted: false }, 'a keepalive retry does not double count');

  const s = db.getSession('mf3k2a-7b1c');
  assert.equal(s.anon_id, ANON);
  assert.equal(s.ref, 'K7Q2XR');
  assert.equal(s.pages, 1, 'only page views count as pages');
  assert.equal(s.started, NOW - 5000);
  assert.equal(s.last_seen, NOW);
  assert.equal(s.first_touch.utm_campaign, 'villas_sep');
  assert.equal(s.last_touch.ts, NOW - 1000);
  assert.equal(s.fbp, 'fb.1.1.2');
  assert.equal(s.ga_client_id, '123.456');
  assert.equal(s.ip, '203.0.113.9');
  assert.equal(s.ua, 'Mozilla/5.0');
  assert.equal(s.country, 'SA');
  assert.equal(s.consent_ads, 1, 'consent moved to granted on the later event');
  assert.equal(s.locale, 'en');

  const rows = db.eventsForSession('mf3k2a-7b1c');
  assert.deepEqual(rows.map((r) => r.name), ['page_view', 'whatsapp_click']);
  assert.equal(rows[1].event_id, 'mf3k2a1b-9c4e7f21');
  assert.equal(rows[1].listing_id, 'BONA-W003');
  assert.equal(rows[1].path, '/properties/bona-w003/');
  assert.deepEqual(rows[1].props, { cta: 'listing_whatsapp', href: 'https://wa.me/966593296933' });
  assert.equal(rows[1].src_first.utm_campaign, 'villas_sep');
  assert.equal(rows[1].src_last.ts, NOW - 1000);
  assert.equal(rows[1].ip, '203.0.113.9');
  assert.equal(rows[1].country, 'SA');
  assert.equal(rows[1].lead_id, null);

  assert.deepEqual(db.dueFanout(NOW + 5).map((f) => [f.event_id, f.dest]), [['mf3k2a1b-9c4e7f21', 'meta']], 'only the click fans out, and only to Meta');
  db.close();
});
