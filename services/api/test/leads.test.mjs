import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../lib/db.mjs';
import { createOrMergeLead, leadNote, appendLead, CHANNELS, MATCH_METHODS } from '../lib/leads.mjs';

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);
const ANON = '9f1c'.repeat(8);
const touch = (over = {}) => ({
  ts: NOW - 10_000, landing: '/properties/bona-w003/', referrer: 'https://l.instagram.com/',
  utm_source: 'meta', utm_medium: 'paid', utm_campaign: 'villas_sep', utm_content: 'reels', utm_term: null, utm_id: '1203',
  click_ids: { fbclid: 'IwAR1' }, ...over,
});

function harness() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-leads-'));
  const db = openDb(':memory:');
  db.upsertSession({
    session_id: 'mf3k2a-7b1c', anon_id: ANON, ref: 'K7Q2XR', started: NOW - 60_000, last_seen: NOW - 1000, pages: 3, locale: 'ar',
    first_touch: touch({ utm_campaign: 'villas_aug', referrer: 'https://www.google.com/' }), last_touch: touch(),
    fbp: 'fb.1.1.2', fbc: 'fb.1.3.IwAR1', ip: '203.0.113.9', ua: 'Mozilla/5.0', country: 'SA', consent_analytics: true, consent_ads: true,
  });
  const jsonl = () => {
    const f = path.join(dataDir, 'leads.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  return { db, dataDir, jsonl, cleanup: () => { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test('the channel and match vocabularies are the ones the spec names', () => {
  assert.deepEqual(CHANNELS, ['whatsapp', 'form', 'concierge_chat', 'concierge_voice', 'manual']);
  assert.deepEqual(MATCH_METHODS, ['ref', 'phone', 'keyword', 'time_window', 'concierge', 'form', 'ad_meta']);
});

test('a WhatsApp lead with a Ref inherits the session: source from the last touch, both touches, consent', () => {
  const h = harness();
  const { lead, created } = createOrMergeLead(h.db,
    { name: 'Sara', phone: '+966 50 000 0000', waJid: '966500000000@s.whatsapp.net', interest: 'villa in Al Shati', listingId: 'BONA-W003', snippet: 'Hi, Ref BONA-W003 · K7Q2XR', notes: 'evenings' },
    { channel: 'whatsapp', matchMethod: 'ref', sessionId: 'mf3k2a-7b1c', ref: 'K7Q2XR', now: NOW, dataDir: h.dataDir });
  assert.equal(created, true);
  assert.match(lead.lead_id, /^LEAD-20260906-[0-9a-f]{8}$/);
  assert.equal(lead.phone_e164, '966500000000');
  assert.equal(lead.wa_jid, '966500000000@s.whatsapp.net');
  assert.equal(lead.name, 'Sara');
  assert.equal(lead.channel, 'whatsapp');
  assert.equal(lead.match_method, 'ref');
  assert.equal(lead.source, 'meta');
  assert.equal(lead.medium, 'paid');
  assert.equal(lead.campaign, 'villas_sep', 'the LAST touch names the campaign');
  assert.equal(lead.campaign_id, '1203');
  assert.equal(lead.content, 'reels');
  assert.deepEqual(lead.click_ids, { fbclid: 'IwAR1' });
  assert.equal(lead.ref, 'K7Q2XR');
  assert.equal(lead.session_id, 'mf3k2a-7b1c');
  assert.equal(lead.anon_id, ANON);
  assert.equal(lead.listing_id, 'BONA-W003');
  assert.equal(lead.first_touch.utm_campaign, 'villas_aug', 'the first touch is kept alongside');
  assert.equal(lead.last_touch.utm_campaign, 'villas_sep');
  assert.equal(lead.consent_ads, 1);
  assert.equal(lead.consent_analytics, 1);
  assert.equal(lead.language, 'ar', 'defaults to the session locale');
  assert.equal(lead.stage, 'new');
  assert.equal(lead.stage_ts, NOW);
  assert.equal(lead.created, NOW);
  assert.equal(lead.first_inbound_ts, NOW);
  assert.equal(lead.notes, 'evenings');

  const tps = h.db.touchpointsForLead(lead.lead_id);
  assert.equal(tps.length, 1);
  assert.equal(tps[0].event_type, 'lead_created');
  assert.equal(tps[0].channel, 'whatsapp');
  assert.equal(tps[0].source, 'meta');
  assert.equal(tps[0].campaign, 'villas_sep');
  assert.equal(tps[0].listing_id, 'BONA-W003');
  assert.equal(tps[0].meta.match_method, 'ref');
  assert.equal(tps[0].meta.snippet, 'Hi, Ref BONA-W003 · K7Q2XR');

  assert.deepEqual(h.db.stageHistory(lead.lead_id).map((r) => [r.stage, r.actor]), [['new', 'system']]);

  const ev = h.db.recentEvents({ name: 'lead_created' });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].lead_id, lead.lead_id);
  assert.equal(ev[0].session_id, 'mf3k2a-7b1c');
  assert.equal(ev[0].anon_id, ANON);
  assert.equal(ev[0].listing_id, 'BONA-W003');
  assert.equal(ev[0].src_last.utm_campaign, 'villas_sep');
  assert.equal(ev[0].ip, '203.0.113.9', 'the session\'s client context rides along for CAPI');
  assert.deepEqual(h.db.dueFanout(NOW).map((f) => [f.event_id, f.dest]), [[ev[0].event_id, 'meta'], [ev[0].event_id, 'ga4'], [ev[0].event_id, 'snap']]);

  const raw = h.jsonl();
  assert.equal(raw.length, 1, 'the append-only raw log continues');
  assert.equal(raw[0].id, lead.lead_id);
  assert.equal(raw[0].phone, '+966 50 000 0000', 'the raw log keeps the number as typed');
  assert.equal(raw[0].channel, 'whatsapp');
  assert.equal(raw[0].source, 'meta');
  assert.equal(raw[0].ref, 'K7Q2XR');
  h.cleanup();
});

test('the same phone, spelled differently, merges: a touchpoint, no second lead, nothing emptied', () => {
  const h = harness();
  const first = createOrMergeLead(h.db, { name: 'Sara', phone: '0500000000', notes: 'evenings', budget: '8m' }, { channel: 'whatsapp', matchMethod: 'ref', sessionId: 'mf3k2a-7b1c', now: NOW, dataDir: h.dataDir });
  const again = createOrMergeLead(h.db, { name: '', phone: '+966500000000', notes: 'Saturday works', interest: 'villa', budget: '' }, { channel: 'whatsapp', matchMethod: 'phone', now: NOW + 5000, dataDir: h.dataDir });
  assert.equal(again.created, false);
  assert.equal(again.lead.lead_id, first.lead.lead_id);
  assert.equal(again.lead.name, 'Sara', 'an empty name never overwrites a real one');
  assert.equal(again.lead.budget, '8m');
  assert.equal(again.lead.interest, 'villa', 'an empty field is filled');
  assert.equal(again.lead.notes, 'evenings\nSaturday works', 'notes accumulate');
  assert.equal(again.lead.updated, NOW + 5000);
  assert.equal(again.lead.source, 'meta', 'the lead\'s own source is fixed at creation');
  assert.equal(again.lead.first_inbound_ts, NOW);
  assert.deepEqual(h.db.touchpointsForLead(first.lead.lead_id).map((t) => t.event_type), ['lead_created', 'inbound_message']);
  assert.equal(h.db.touchpointsForLead(first.lead.lead_id)[1].source, 'whatsapp_organic', 'this touch had no session of its own');
  assert.equal(h.db.recentEvents({ name: 'lead_created' }).length, 1);
  assert.equal(h.db.fanoutCounts().pending, 3, 'no second fan-out');
  assert.equal(h.db.listLeads().length, 1);
  assert.equal(h.jsonl().length, 1, 'the raw log records enquiries, not repeats');
  h.cleanup();
});

test('a lead with no usable phone still merges on its WhatsApp jid or lid', () => {
  const h = harness();
  const a = createOrMergeLead(h.db, { waJid: '12345@lid', waLid: '12345@lid', name: 'Omar' }, { channel: 'whatsapp', matchMethod: 'keyword', now: NOW, dataDir: h.dataDir });
  assert.equal(a.created, true);
  assert.equal(a.lead.phone_e164, null);
  assert.equal(a.lead.source, 'whatsapp_organic');
  assert.equal(a.lead.medium, '(none)');
  const b = createOrMergeLead(h.db, { waJid: '12345@lid', phone: 'abc' }, { channel: 'whatsapp', matchMethod: 'phone', now: NOW + 1 });
  assert.equal(b.created, false);
  assert.equal(b.lead.lead_id, a.lead.lead_id);
  // the same person later shows up with a real number: it is attached, not duplicated
  const c = createOrMergeLead(h.db, { waLid: '12345@lid', phone: '0555555555' }, { channel: 'whatsapp', matchMethod: 'phone', now: NOW + 2 });
  assert.equal(c.created, false);
  assert.equal(c.lead.phone_e164, '966555555555');
  assert.equal(h.db.getLeadByPhone('966555555555').lead_id, a.lead.lead_id);
  h.cleanup();
});

test('merging by phone wins over a jid, and merge by jid also fills a missing phone', () => {
  const h = harness();
  const a = createOrMergeLead(h.db, { phone: '0500000001', name: 'A' }, { channel: 'form', now: NOW });
  const b = createOrMergeLead(h.db, { phone: '0500000001', waJid: '966500000001@s.whatsapp.net' }, { channel: 'whatsapp', now: NOW + 1 });
  assert.equal(b.created, false);
  assert.equal(b.lead.lead_id, a.lead.lead_id);
  assert.equal(b.lead.wa_jid, '966500000001@s.whatsapp.net');
  h.cleanup();
});

test('without a session the source is the channel itself', () => {
  const h = harness();
  const f = createOrMergeLead(h.db, { phone: '0500000002', name: 'Form' }, { channel: 'form', matchMethod: 'form', now: NOW });
  assert.deepEqual([f.lead.source, f.lead.medium, f.lead.campaign, f.lead.session_id], ['form', '(none)', null, null]);
  const c = createOrMergeLead(h.db, { phone: '0500000003', name: 'Chat' }, { channel: 'concierge_chat', matchMethod: 'concierge', now: NOW });
  assert.equal(c.lead.source, 'concierge');
  assert.equal(c.lead.match_method, 'concierge');
  const v = createOrMergeLead(h.db, { phone: '0500000004' }, { channel: 'concierge_voice', matchMethod: 'concierge', now: NOW });
  assert.equal(v.lead.source, 'concierge');
  assert.equal(v.lead.channel, 'concierge_voice');
  const w = createOrMergeLead(h.db, { phone: '0500000005' }, { channel: 'whatsapp', matchMethod: 'keyword', now: NOW });
  assert.equal(w.lead.source, 'whatsapp_organic');
  const m = createOrMergeLead(h.db, { phone: '0500000006' }, { channel: 'bogus', matchMethod: 'bogus', now: NOW });
  assert.equal(m.lead.channel, 'manual');
  assert.equal(m.lead.match_method, 'phone');
  h.cleanup();
});

test('a Ref alone finds the session when no session id was given', () => {
  const h = harness();
  const { lead } = createOrMergeLead(h.db, { phone: '0500000007' }, { channel: 'whatsapp', matchMethod: 'ref', ref: 'k7q2xr', now: NOW });
  assert.equal(lead.session_id, 'mf3k2a-7b1c');
  assert.equal(lead.source, 'meta');
  assert.equal(lead.ref, 'K7Q2XR');
  const unknown = createOrMergeLead(h.db, { phone: '0500000008' }, { channel: 'whatsapp', matchMethod: 'ref', ref: 'ZZZZZZ', now: NOW });
  assert.equal(unknown.lead.session_id, null);
  assert.equal(unknown.lead.ref, 'ZZZZZZ', 'the code the visitor typed is kept even when it matches nothing');
  h.cleanup();
});

test('an event id passed in is linked to the lead, and a lead without any contact is still a lead', () => {
  const h = harness();
  h.db.insertEvent({ event_id: 'mf3k2a1b-form0001', ts: NOW, name: 'form_submit', anon_id: ANON, session_id: 'mf3k2a-7b1c' });
  const { lead } = createOrMergeLead(h.db, { name: 'Only a name' }, { channel: 'concierge_chat', matchMethod: 'concierge', eventId: 'mf3k2a1b-form0001', now: NOW });
  assert.equal(h.db.getEvent('mf3k2a1b-form0001').lead_id, lead.lead_id);
  assert.equal(lead.phone_e164, null);
  const second = createOrMergeLead(h.db, { name: 'Only a name' }, { channel: 'concierge_chat', matchMethod: 'concierge', now: NOW + 1 });
  assert.equal(second.created, true, 'nothing to merge on, so it is another enquiry');
  h.cleanup();
});

test('the owner note carries the source line and flags an inferred match', () => {
  const full = leadNote({
    lead_id: 'LEAD-20260906-abcdef12', name: 'Sara', phone_e164: '966500000000', interest: 'villa', district: 'Al Shati', listing_id: 'BONA-W003',
    source: 'meta', medium: 'paid', campaign: 'villas_sep', ref: 'K7Q2XR', match_method: 'ref', channel: 'whatsapp', created: NOW,
  });
  assert.match(full, /^\*Bona — new enquiry\*/);
  assert.match(full, /Phone: \+966500000000/);
  assert.match(full, /Property: BONA-W003/);
  assert.match(full, /Source: meta \/ paid · villas_sep · Ref K7Q2XR · BONA-W003/);
  assert.doesNotMatch(full, /Match:/);
  assert.match(full, /Channel: whatsapp · 2026-09-06T12:00:00\.000Z/);
  assert.match(full, /bona\.azoz\.uk/);
  assert.ok(!full.includes('{'));

  const inferred = leadNote({ phone_e164: '966500000000', source: 'meta', medium: 'paid', match_method: 'time_window', channel: 'whatsapp', created: NOW });
  assert.match(inferred, /Source: meta \/ paid\n/);
  assert.match(inferred, /Match: inferred \(time window\)/);

  const legacy = leadNote({ name: 'Sara', phone: '+966500000000', interest: 'villa', ts: '2026-09-05T20:00:00Z', source: 'concierge', channel: 'chat' });
  assert.match(legacy, /Source: concierge\n/);
  assert.match(legacy, /Channel: chat · 2026-09-05T20:00:00Z/);

  const plain = leadNote({ name: 'Sara' });
  assert.doesNotMatch(plain, /Source:/);
});

test('appendLead takes an id and a time when the caller already has them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-leads-'));
  const rec = appendLead(dir, { phone: '0500000000' }, { id: 'LEAD-20260906-deadbeef', ts: NOW, channel: 'whatsapp', source: 'meta', extra: { ref: 'K7Q2XR' } });
  assert.equal(rec.id, 'LEAD-20260906-deadbeef');
  assert.equal(rec.ts, '2026-09-06T12:00:00.000Z');
  assert.equal(rec.ref, 'K7Q2XR');
  const auto = appendLead(dir, { phone: '0500000000' });
  assert.match(auto.id, /^LEAD-\d{8}-[0-9a-f]{8}$/);
  fs.rmSync(dir, { recursive: true, force: true });
});
