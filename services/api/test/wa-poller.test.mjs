/**
 * The WhatsApp poller. Evolution is never contacted: every test injects
 * `findMessages`, except the two that stub `globalThis.fetch` to prove the default
 * wiring builds the request the live instance answers.
 *
 * The fixtures are the ones the design names: a Ref line, a returning sender, a
 * discarded private message, a keyword, click-to-WhatsApp ad context, a time-window
 * inference, a reply, the chats we must not read, a duplicate id and an `@lid` chat.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../lib/db.mjs';
import {
  CLICK_WINDOW_MS, FIRST_RUN_LOOKBACK_MS, MAX_RECORD_ATTEMPTS, MAX_WINDOW_MS, OVERLAP_MS,
  SEEN_TTL_MS, adMetaOf, adSourceOf, createPoller, isIgnorableChat, jidsOf,
} from '../lib/wa-poller.mjs';

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);
const ANON = '9f1c'.repeat(8);
const ANON2 = '4e2b'.repeat(8);
const INSTANCE = 'abdulaziz-personal';
const OWNER = '966593296933@s.whatsapp.net';
const SENDER = '966500000000@s.whatsapp.net';

const touch = (over = {}) => ({
  ts: NOW - 600_000, landing: '/properties/bona-w003/', referrer: 'https://l.instagram.com/',
  utm_source: 'meta', utm_medium: 'paid', utm_campaign: 'villas_sep', utm_content: 'reels', utm_term: null, utm_id: '1203',
  click_ids: { fbclid: 'IwAR1' }, ...over,
});

/** One normalised record, as `lib/evolution.mjs` hands them over. */
const msg = (over = {}) => ({
  id: 'KEY1', jid: SENDER, jidAlt: null, fromMe: false, ts: NOW - 60_000,
  text: '', pushName: 'Sara', contextInfo: null, messageType: 'conversation', ...over,
});

/**
 * A store with the visitor session behind Ref `K7Q2XR`, a poller wired to a queue of
 * windows (one per tick), and the owner's note sender recorded rather than sent.
 */
function harness({ windows = [], env = {}, seedSession = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-poller-'));
  const db = openDb(':memory:');
  if (seedSession) {
    db.upsertSession({
      session_id: 'mf3k2a-7b1c', anon_id: ANON, ref: 'K7Q2XR', started: NOW - 900_000, last_seen: NOW - 600_000, pages: 3, locale: 'ar',
      first_touch: touch({ utm_campaign: 'villas_aug' }), last_touch: touch(),
      ip: '203.0.113.9', ua: 'Mozilla/5.0', country: 'SA', consent_analytics: 1, consent_ads: 1,
    });
  }
  const queue = [...windows];
  const asked = [];
  const sent = [];
  const logs = [];
  let clock = NOW;
  const poller = createPoller({
    db,
    cfg: { env: { BONA_OWNER_JID: OWNER, ...env }, siteUrl: 'https://bona-real-estate.com', dataDir, waPollMs: 0 },
    findMessages: async (window) => { asked.push(window); return { records: queue.length ? queue.shift() : [] }; },
    sendWhatsApp: async (text) => { sent.push(text); return { ok: true }; },
    log: (obj) => logs.push(obj),
    now: () => clock,
  });
  return {
    db, poller, asked, sent, logs, dataDir,
    push: (records) => queue.push(records),
    setClock: (t) => { clock = t; },
    leads: () => db.listLeads({ limit: 50 }),
    jsonl: () => {
      const f = path.join(dataDir, 'leads.jsonl');
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    },
    cleanup: () => { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

/* ---------------- (a) the Ref line ---------------- */

test('(a) a Ref line from an unknown number becomes a lead that knows its campaign, and the owner hears once', async () => {
  const h = harness({ windows: [[msg({ text: 'Hi, is this still available?\n\nRef BONA-W003 · K7Q2XR' })]] });
  const tally = await h.poller.tick();
  assert.deepEqual({ matched: tally.matched, created: tally.created, unmatched: tally.unmatched }, { matched: 1, created: 1, unmatched: 0 });

  const [lead] = h.leads();
  assert.equal(lead.match_method, 'ref');
  assert.equal(lead.ref, 'K7Q2XR');
  assert.equal(lead.channel, 'whatsapp');
  assert.equal(lead.phone_e164, '966500000000', 'the phone comes from the jid');
  assert.equal(lead.wa_jid, SENDER);
  assert.equal(lead.name, 'Sara');
  assert.equal(lead.listing_id, 'BONA-W003', 'the listing comes from the Ref line');
  assert.equal(lead.session_id, 'mf3k2a-7b1c');
  assert.equal(lead.source, 'meta', "the source is the session's last touch, not 'whatsapp'");
  assert.equal(lead.medium, 'paid');
  assert.equal(lead.campaign, 'villas_sep');
  assert.equal(lead.stage, 'new');
  assert.equal(lead.first_inbound_ts, NOW - 60_000, 'measured from when the message was sent');
  assert.equal(lead.first_reply_ts, null);

  const [created] = h.db.touchpointsForLead(lead.lead_id);
  assert.equal(created.event_type, 'lead_created');
  assert.match(created.meta.snippet, /Ref BONA-W003/);

  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /Bona — new enquiry/);
  assert.match(h.sent[0], /Source: meta \/ paid · villas_sep · Ref K7Q2XR · BONA-W003/);
  assert.equal(h.jsonl().length, 1, 'the raw log keeps its one line per new lead');
  h.cleanup();
});

/* ---------------- (b) the same person again ---------------- */

test('(b) the next message from that number merges: a touchpoint, no second note', async () => {
  const h = harness({ windows: [[msg({ text: 'Ref BONA-W003 · K7Q2XR' })], [msg({ id: 'KEY2', ts: NOW - 30_000, text: 'أي جديد؟' })]] });
  await h.poller.tick();
  const tally = await h.poller.tick();

  assert.equal(tally.matched, 1);
  assert.equal(tally.merged, 1);
  assert.equal(tally.created, 0);
  const leads = h.leads();
  assert.equal(leads.length, 1, 'one person, one lead');
  const tps = h.db.touchpointsForLead(leads[0].lead_id);
  assert.deepEqual(tps.map((t) => t.event_type), ['lead_created', 'inbound_message']);
  assert.equal(tps[1].meta.match_method, 'phone');
  assert.equal(tps[1].meta.snippet, null, 'the message body is kept only for a lead we are meeting');
  assert.equal(h.sent.length, 1, 'the owner is told about a new lead, not about every message');
  h.cleanup();
});

/* ---------------- (c) the matched-only policy ---------------- */

test('(c) a private message that matches no rule is discarded in memory — counted, never stored', async () => {
  const h = harness({ windows: [[msg({ text: 'hi' })]] });
  const tally = await h.poller.tick();

  assert.equal(tally.matched, 0);
  assert.equal(tally.unmatched, 1);
  assert.equal(h.db.countLeads(), 0);
  assert.deepEqual(h.db.recentEvents({ limit: 50 }), [], 'nothing about it reaches the event log');
  assert.deepEqual(h.jsonl(), []);
  assert.equal(h.sent.length, 0);
  assert.equal(h.poller.status().unmatched, 1);
  // The counter is the only trace; no log line carries the text or the number.
  assert.equal(h.logs.some((l) => JSON.stringify(l).includes('966500000000') || JSON.stringify(l).includes('"hi"')), false);
  h.cleanup();
});

test('the unmatched counter survives across ticks — it is the cursor row, not a variable', async () => {
  const h = harness({ windows: [[msg({ text: 'hi' })], [msg({ id: 'KEY2', text: 'you there?' })]] });
  await h.poller.tick();
  await h.poller.tick();
  assert.equal(h.poller.status().unmatched, 2);
  assert.equal(h.db.waCursorGet('abdulaziz-personal').unmatched, 2);
  h.cleanup();
});

/* ---------------- (d) the keyword rule ---------------- */

test('(d) a message that names Bona in Arabic is kept as an organic WhatsApp lead', async () => {
  const h = harness({ windows: [[msg({ text: 'مرحبا بونا، عندكم شقق في الشاطئ؟' })]] });
  await h.poller.tick();

  const [lead] = h.leads();
  assert.equal(lead.match_method, 'keyword');
  assert.equal(lead.source, 'whatsapp_organic');
  assert.equal(lead.medium, '(none)');
  assert.equal(lead.session_id, null, 'there is no session behind an organic message');
  assert.equal(h.sent.length, 1);
  h.cleanup();
});

test('a listing id alone is enough, and it becomes the lead\'s property', async () => {
  const h = harness({ windows: [[msg({ text: 'BONA-W012 السعر؟' })]] });
  await h.poller.tick();
  const [lead] = h.leads();
  assert.equal(lead.match_method, 'keyword');
  assert.equal(lead.listing_id, 'BONA-W012');
  h.cleanup();
});

/* ---------------- (e) click-to-WhatsApp ---------------- */

test('(e) an ad-originated chat keeps the ad context and is attributed to the platform, not to "whatsapp"', async () => {
  const contextInfo = {
    externalAdReply: { title: 'Sea-view villas', sourceId: '120210987654321', sourceUrl: 'https://fb.me/ad', sourceType: 'ad', sourceApp: 'instagram', ctwaClid: 'ARZ1xyz' },
    conversionSource: 'FB_Ads',
    entryPointConversionApp: 'instagram',
  };
  const h = harness({ windows: [[msg({ text: 'Interested', contextInfo })]] });
  await h.poller.tick();

  const [lead] = h.leads();
  assert.equal(lead.match_method, 'ad_meta');
  assert.equal(lead.source, 'instagram');
  assert.equal(lead.medium, 'paid');
  assert.equal(lead.campaign_id, '120210987654321');
  assert.deepEqual(lead.click_ids, { ctwa_clid: 'ARZ1xyz' });
  assert.equal(lead.last_touch.utm_source, 'instagram', 'the ad is the lead\'s touch — there is no session to ask');

  const [tp] = h.db.touchpointsForLead(lead.lead_id);
  assert.equal(tp.meta.ad_meta.source_id, '120210987654321');
  assert.equal(tp.meta.ad_meta.ctwa_clid, 'ARZ1xyz');
  assert.equal(tp.meta.ad_meta.source_app, 'instagram');
  assert.equal(tp.meta.ad_meta.title, undefined, 'the ad copy is not ours to keep');
  h.cleanup();
});

test('ad metadata is read from every field Meta uses for it, and a quoted reply is not one', () => {
  assert.equal(adMetaOf({ stanzaId: 'x', quotedMessage: { conversation: 'hi' } }), null);
  assert.equal(adMetaOf(null), null);
  assert.deepEqual(adSourceOf(adMetaOf({ entryPointConversionSource: 'ctwa_ad', entryPointConversionApp: 'facebook' })), {
    source: 'facebook', medium: 'paid', campaign_id: null, click_ids: null, referrer: null,
  });
  // No "Ads" spelled anywhere, but a click-to-WhatsApp click id is still a paid click.
  assert.equal(adSourceOf(adMetaOf({ externalAdReply: { ctwaClid: 'c1' } })).medium, 'paid');
  assert.equal(adSourceOf(adMetaOf({ externalAdReply: { sourceType: 'post', sourceApp: 'instagram' } })).medium, 'social_or_organic');
});

/* ---------------- (f) the time window ---------------- */

test('(f) an unknown number minutes after a WhatsApp click is inferred from that click, and the note says so', async () => {
  const h = harness({ windows: [[msg({ text: 'مرحبا' })]] });
  h.db.upsertSession({
    session_id: 'clk1-9zad', anon_id: ANON2, started: NOW - 700_000, last_seen: NOW - 300_000, pages: 2, locale: 'ar',
    first_touch: touch({ utm_source: 'snapchat' }), last_touch: touch({ utm_source: 'snapchat', utm_campaign: 'jeddah_oct' }),
    consent_analytics: 1, consent_ads: 1,
  });
  h.db.insertEvent({
    event_id: 'ev-click-1', ts: NOW - 300_000, name: 'whatsapp_click', anon_id: ANON2, session_id: 'clk1-9zad',
    listing_id: 'BONA-W007', path: '/ar/properties/bona-w007/',
  });
  await h.poller.tick();

  const [lead] = h.leads();
  assert.equal(lead.match_method, 'time_window');
  assert.equal(lead.session_id, 'clk1-9zad');
  assert.equal(lead.source, 'snapchat');
  assert.equal(lead.listing_id, 'BONA-W007');
  assert.equal(h.db.getEvent('ev-click-1').lead_id, lead.lead_id, 'the click is claimed, so a second message cannot reuse it');
  assert.match(h.sent[0], /Match: inferred \(time window\)/);

  // The lead goes out to the ad platforms under its OWN event id: the click already
  // reached them as `Contact` under `ev-click-1`, and Meta drops a duplicate id.
  const created = h.db.recentEvents({ name: 'lead_created', limit: 5 })[0];
  assert.equal(created.lead_id, lead.lead_id);
  assert.deepEqual(h.db.dueFanout(NOW + 1000).map((r) => r.event_id), [created.event_id, created.event_id, created.event_id]);
  h.cleanup();
});

test('a click whose session already produced a lead is never reused, and a distant click is not a match', async () => {
  const h = harness({ windows: [[msg({ text: 'مرحبا' })], [msg({ id: 'KEY2', jid: '966511111111@s.whatsapp.net', text: 'مرحبا' })]] });
  // One click too old to explain anything, one already spoken for.
  h.db.upsertSession({ session_id: 'old1-9zad', anon_id: ANON2, started: NOW, last_seen: NOW, pages: 1, locale: 'en' });
  h.db.insertEvent({ event_id: 'ev-old', ts: NOW - 60_000 - CLICK_WINDOW_MS - 1000, name: 'whatsapp_click', session_id: 'old1-9zad', anon_id: ANON2 });
  h.db.upsertSession({ session_id: 'used-9zad', anon_id: ANON2, started: NOW, last_seen: NOW, pages: 1, locale: 'en' });
  h.db.insertEvent({ event_id: 'ev-used', ts: NOW - 120_000, name: 'whatsapp_click', session_id: 'used-9zad', anon_id: ANON2, lead_id: 'LEAD-20260906-deadbeef' });

  const tally = await h.poller.tick();
  assert.equal(tally.unmatched, 1);
  assert.equal(h.db.countLeads(), 0);
  h.cleanup();
});

/* ---------------- (g) the reply clock ---------------- */

test('(g) the owner\'s own reply stops the response clock, and only the first one', async () => {
  const h = harness({ windows: [
    [msg({ text: 'Ref BONA-W003 · K7Q2XR' })],
    [msg({ id: 'KEY2', fromMe: true, ts: NOW - 40_000, text: 'Ahlan! Let me check.', pushName: null })],
    [msg({ id: 'KEY3', fromMe: true, ts: NOW - 20_000, text: 'Sending photos now.', pushName: null })],
  ] });
  await h.poller.tick();
  const second = await h.poller.tick();
  const third = await h.poller.tick();

  assert.equal(second.replies, 1);
  assert.equal(third.replies, 0, 'the clock stops once');
  const [lead] = h.leads();
  assert.equal(lead.first_reply_ts, NOW - 40_000);
  assert.equal(h.db.countLeads(), 1, 'an outbound message never creates a lead');
  h.cleanup();
});

test('a reply to somebody who is not a lead is not a lead either', async () => {
  const h = harness({ windows: [[msg({ id: 'KEYX', fromMe: true, jid: '966522222222@s.whatsapp.net', text: 'see you at 6' })]] });
  const tally = await h.poller.tick();
  assert.equal(tally.replies, 0);
  assert.equal(h.db.countLeads(), 0);
  h.cleanup();
});

/* ---------------- (h) the chats we do not read ---------------- */

test('(h) groups, status broadcasts and the owner\'s own chat are never read', async () => {
  const h = harness({ windows: [[
    msg({ id: 'G1', jid: '120363143519616993@g.us', text: 'Ref BONA-W003 · K7Q2XR' }),
    msg({ id: 'S1', jid: 'status@broadcast', text: 'bona' }),
    msg({ id: 'O1', jid: OWNER, fromMe: true, text: 'Bona — new enquiry' }),
    msg({ id: 'O2', jid: OWNER, fromMe: false, text: 'Ref BONA-W003 · K7Q2XR' }),
  ]] });
  const tally = await h.poller.tick();

  assert.equal(tally.ignored, 4);
  assert.equal(tally.matched, 0);
  assert.equal(tally.unmatched, 0, 'a chat we do not read is not a discarded enquiry either');
  assert.equal(h.db.countLeads(), 0);
  assert.equal(h.db.waSeenHas('G1'), false, 'a group message costs no dedupe row');
  h.cleanup();
});

test('the venue rules stand on their own', () => {
  assert.equal(isIgnorableChat('120363143519616993@g.us'), true);
  assert.equal(isIgnorableChat('status@broadcast'), true);
  assert.equal(isIgnorableChat(null), true);
  assert.equal(isIgnorableChat('966593296933@s.whatsapp.net', '966593296933'), true);
  assert.equal(isIgnorableChat('966500000000@s.whatsapp.net', '966593296933'), false);
});

/* ---------------- (i) dedupe ---------------- */

test('(i) the same message id is processed once, however often the window returns it', async () => {
  const one = msg({ text: 'Ref BONA-W003 · K7Q2XR' });
  const h = harness({ windows: [[one], [one]] });
  await h.poller.tick();
  const again = await h.poller.tick();

  assert.equal(again.matched, 0);
  assert.equal(again.ignored, 1);
  assert.equal(h.db.countLeads(), 1);
  assert.equal(h.db.touchpointsForLead(h.leads()[0].lead_id).length, 1);
  assert.equal(h.sent.length, 1);
  h.cleanup();
});

/* ---------------- (j) @lid chats ---------------- */

test('(j) an @lid chat takes its phone from the alt jid and stores both', async () => {
  const h = harness({ windows: [
    [msg({ id: 'L1', jid: '272516946294519@lid', jidAlt: SENDER, pushName: null, text: 'Ref BONA-W003 · K7Q2XR' })],
    [msg({ id: 'L2', jid: '272516946294519@lid', jidAlt: null, ts: NOW - 30_000, pushName: null, text: 'أي جديد؟' })],
  ] });
  await h.poller.tick();

  const [lead] = h.leads();
  assert.equal(lead.phone_e164, '966500000000', 'the @lid digits are not a phone number');
  assert.equal(lead.wa_jid, SENDER);
  assert.equal(lead.wa_lid, '272516946294519@lid');
  assert.equal(lead.name, null, 'a privacy-mode chat has no pushName, and we do not invent one');

  // The follow-up arrives with the lid alone and still finds the same person.
  const second = await h.poller.tick();
  assert.equal(second.merged, 1);
  assert.equal(h.db.countLeads(), 1);
  h.cleanup();
});

test('jidsOf keeps a phone out of an @lid and a group out of everything', () => {
  assert.deepEqual(jidsOf({ jid: '272516946294519@lid', jidAlt: SENDER }), { phone: '966500000000', waJid: SENDER, waLid: '272516946294519@lid' });
  assert.deepEqual(jidsOf({ jid: '272516946294519@lid' }), { phone: null, waJid: null, waLid: '272516946294519@lid' });
  assert.deepEqual(jidsOf({ jid: SENDER }), { phone: '966500000000', waJid: SENDER, waLid: null });
  assert.deepEqual(jidsOf({}), { phone: null, waJid: null, waLid: null });
});

/* ---------------- order within a window ---------------- */

test('a window is handled oldest first, so the Ref line creates the lead its follow-up merges into', async () => {
  // Evolution answers newest-first; this is the order it would hand them over in.
  const h = harness({ windows: [[
    msg({ id: 'NEW', ts: NOW - 20_000, text: 'أي جديد؟' }),
    msg({ id: 'OLD', ts: NOW - 60_000, text: 'Hi — Ref BONA-W003 · K7Q2XR' }),
  ]] });
  const tally = await h.poller.tick();

  assert.deepEqual({ matched: tally.matched, created: tally.created, merged: tally.merged, unmatched: tally.unmatched },
    { matched: 2, created: 1, merged: 1, unmatched: 0 });
  const [lead] = h.leads();
  assert.equal(lead.match_method, 'ref', 'the follow-up did not get judged before the Ref line');
  assert.equal(lead.first_inbound_ts, NOW - 60_000);
  assert.equal(h.sent.length, 1);
  h.cleanup();
});

test('a reply that arrives in the same window as the enquiry still stops the clock', async () => {
  const h = harness({ windows: [[
    msg({ id: 'REPLY', ts: NOW - 10_000, fromMe: true, text: 'Ahlan!', pushName: null }),
    msg({ id: 'IN', ts: NOW - 60_000, text: 'Ref BONA-W003 · K7Q2XR' }),
  ]] });
  const tally = await h.poller.tick();

  assert.equal(tally.created, 1);
  assert.equal(tally.replies, 1);
  assert.equal(h.leads()[0].first_reply_ts, NOW - 10_000);
  h.cleanup();
});

/* ---------------- the loop never reads itself ---------------- */

test('our own new-lead note is never an enquiry, whatever fromMe says', async () => {
  const note = '*Bona — new enquiry*\nName: Sara\nPhone: +966500000000\nSource: meta / paid · Ref K7Q2XR\nChannel: whatsapp';
  const h = harness({ windows: [[msg({ id: 'NOTE', fromMe: false, jid: '272516946294519@lid', text: note })]] });
  const tally = await h.poller.tick();

  assert.equal(tally.ignored, 1);
  assert.equal(tally.matched, 0);
  assert.equal(tally.unmatched, 0);
  assert.equal(h.db.countLeads(), 0, 'the note says "Bona", so only this rule keeps it out');
  h.cleanup();
});

/* ---------------- a record that fails ---------------- */

/** A store that throws on the first `getSessionByRef`, then behaves. */
function flakyDb(db, failures) {
  let left = failures;
  return { ...db, getSessionByRef: (code) => { if (left > 0) { left -= 1; throw new Error('database is locked'); } return db.getSessionByRef(code); } };
}

test('a message that fails to store is retried on the next tick, not written off', async () => {
  const db = openDb(':memory:');
  db.upsertSession({ session_id: 'mf3k2a-7b1c', anon_id: ANON, ref: 'K7Q2XR', started: NOW, last_seen: NOW, pages: 1, locale: 'en', last_touch: touch() });
  const logs = [];
  const poller = createPoller({
    db: flakyDb(db, 1),
    cfg: { env: { BONA_OWNER_JID: OWNER } },
    findMessages: async () => ({ records: [msg({ text: 'Ref BONA-W003 · K7Q2XR' })] }),
    sendWhatsApp: async () => ({ ok: true }),
    log: (o) => logs.push(o),
    now: () => NOW,
  });

  const first = await poller.tick();
  assert.equal(first.matched, 0);
  assert.equal(db.countLeads(), 0);
  assert.equal(db.waSeenHas('KEY1'), false, 'an unhandled message is not remembered as handled');
  assert.equal(logs.find((l) => l.evt === 'wa.poll.record_failed').writtenOff, false);

  const second = await poller.tick();
  assert.equal(second.created, 1, 'the retry lands the lead the failure nearly lost');
  assert.equal(db.waSeenHas('KEY1'), true);
  db.close();
});

test('a record that fails every time is written off after three tries rather than retried for ever', async () => {
  const db = openDb(':memory:');
  const logs = [];
  const poller = createPoller({
    db: flakyDb(db, Infinity),
    cfg: { env: { BONA_OWNER_JID: OWNER } },
    findMessages: async () => ({ records: [msg({ text: 'Ref BONA-W003 · K7Q2XR' })] }),
    log: (o) => logs.push(o),
    now: () => NOW,
  });
  for (let i = 0; i < MAX_RECORD_ATTEMPTS; i += 1) await poller.tick(); // eslint-disable-line no-await-in-loop

  assert.equal(db.waSeenHas('KEY1'), true);
  assert.equal(logs.filter((l) => l.evt === 'wa.poll.record_failed').at(-1).writtenOff, true);
  const after = await poller.tick();
  assert.equal(after.ignored, 1, 'and then it stops costing anything');
  db.close();
});

/** A reader that honours the window it is given, like Evolution does. */
function windowReader(pool) {
  const asked = [];
  return {
    asked,
    find: async ({ gte, lte }) => {
      asked.push({ gte, lte });
      // Newest first, the way the real API answers.
      return { records: pool.filter((r) => r.ts >= gte && r.ts <= lte).sort((a, b) => b.ts - a.ts) };
    },
  };
}

test('a failed record is kept inside the window until it is handled or written off, however new the rest is', async () => {
  // The failing one is minutes older than the message that came after it: if the cursor
  // followed the newest message, the older one would fall out of the window for ever.
  const old = msg({ id: 'OLD', ts: NOW - 300_000, text: 'Ref BONA-W003 · K7Q2XR' });
  const fresh = msg({ id: 'FRESH', ts: NOW - 10_000, text: 'مرحبا بونا' });
  const db = openDb(':memory:');
  const reader = windowReader([old, fresh]);
  const logs = [];
  let clock = NOW;
  const poller = createPoller({
    db: flakyDb(db, Infinity), // every Ref lookup throws; the keyword message is unaffected
    cfg: { env: { BONA_OWNER_JID: OWNER } },
    findMessages: reader.find,
    sendWhatsApp: async () => ({ ok: true }),
    log: (o) => logs.push(o),
    now: () => clock,
  });

  const first = await poller.tick();
  assert.equal(first.created, 1, 'the newer message still becomes its lead');
  assert.equal(db.waSeenHas('OLD'), false);
  assert.ok(db.waCursorGet(INSTANCE).last_ts <= old.ts, 'the cursor waits for the record it could not handle');

  clock = NOW + 45_000;
  const second = await poller.tick();
  assert.ok(reader.asked[1].gte <= old.ts, 'so the next window still reaches it');
  assert.equal(second.scanned >= 1, true);
  assert.equal(logs.filter((l) => l.evt === 'wa.poll.record_failed').length, 2, 'it was tried again');

  clock = NOW + 90_000;
  await poller.tick();
  const failed = logs.filter((l) => l.evt === 'wa.poll.record_failed');
  assert.equal(failed.length, MAX_RECORD_ATTEMPTS);
  assert.equal(failed.at(-1).writtenOff, true, 'three tries and it is written off, not retried for ever');
  assert.equal(db.waSeenHas('OLD'), true);

  clock = NOW + 135_000;
  const fourth = await poller.tick();
  assert.equal(fourth.ignored, db.waSeenHas('FRESH') ? fourth.scanned : fourth.ignored, 'everything in the window is now handled');
  assert.ok(db.waCursorGet(INSTANCE).last_ts > old.ts, 'and the cursor is free to move on');
  db.close();
});

test('a failure the next window can no longer reach is given up on out loud, not remembered for ever', async () => {
  // The hold-back is bounded by the floor, so a long enough gap between ticks — the loop
  // stopped, the PC slept — eventually puts the record out of reach. That is a loss, and
  // it has to be said rather than left as an attempt counter nobody will ever decrement.
  const stale = msg({ id: 'STALE', ts: NOW - 300_000, text: 'Ref BONA-W003 · K7Q2XR' });
  const db = openDb(':memory:');
  const reader = windowReader([stale]);
  const logs = [];
  let clock = NOW;
  const poller = createPoller({
    db: flakyDb(db, Infinity),
    cfg: { env: { BONA_OWNER_JID: OWNER } },
    findMessages: reader.find,
    log: (o) => logs.push(o),
    now: () => clock,
  });
  await poller.tick();
  assert.equal(logs.some((l) => l.evt === 'wa.poll.abandoned'), false, 'while it is still reachable it is still owed a try');

  clock = NOW + 8 * 60_000;
  await poller.tick();

  assert.equal(logs.filter((l) => l.evt === 'wa.poll.record_failed').length, 2, 'it never reached the third try');
  assert.equal(logs.find((l) => l.evt === 'wa.poll.abandoned').count, 1);
  assert.ok(db.waCursorGet(INSTANCE).last_ts >= clock - MAX_WINDOW_MS, 'and the cursor is not held by it any more');
  db.close();
});

/* ---------------- a window too big to read ---------------- */

test('a window that overflowed the page cap says so — its oldest messages are unreachable', async () => {
  const db = openDb(':memory:');
  const logs = [];
  const poller = createPoller({
    db,
    cfg: { env: { BONA_OWNER_JID: OWNER } },
    findMessages: async () => ({ records: [msg({ text: 'hi' })], truncated: true }),
    log: (o) => logs.push(o),
    now: () => NOW,
  });
  await poller.tick();
  const warned = logs.find((l) => l.evt === 'wa.poll.truncated');
  assert.equal(warned.level, 'warn');
  assert.equal(warned.scanned, 1);
  db.close();
});

/* ---------------- (k) an Evolution outage ---------------- */

test('(k) an Evolution failure logs and leaves the cursor exactly where it was', async () => {
  const h = harness({ windows: [[msg({ text: 'Ref BONA-W003 · K7Q2XR' })]] });
  await h.poller.tick();
  const before = h.db.waCursorGet(INSTANCE);

  const broken = createPoller({
    db: h.db,
    cfg: { env: { BONA_OWNER_JID: OWNER }, siteUrl: 'https://bona-real-estate.com', waPollMs: 0 },
    findMessages: async () => { throw new Error('HTTP 502'); },
    sendWhatsApp: async () => ({ ok: true }),
    log: (o) => h.logs.push(o),
    now: () => NOW + 600_000,
  });
  const out = await broken.tick();

  assert.equal(out.error, 'HTTP 502', 'the tick reports the failure instead of throwing it');
  assert.deepEqual(h.db.waCursorGet(INSTANCE), before, 'nothing is lost: the window simply widens next time');
  const failure = h.logs.find((l) => l.evt === 'wa.poll.failed');
  assert.equal(failure.level, 'warn');
  // The lag the outage produces is what /health publishes: ten minutes with no tick that
  // finished, while a quiet WhatsApp with a healthy loop would still read 0.
  assert.equal(broken.status().lagS, 600);
  h.cleanup();
});

test('a note that cannot be sent never loses the lead', async () => {
  const db = openDb(':memory:');
  const logs = [];
  const poller = createPoller({
    db,
    cfg: { env: { BONA_OWNER_JID: OWNER } },
    findMessages: async () => ({ records: [msg({ text: 'مرحبا بونا' })] }),
    sendWhatsApp: async () => { throw new Error('evolution down'); },
    log: (o) => logs.push(o),
    now: () => NOW,
  });
  const tally = await poller.tick();
  assert.equal(tally.created, 1);
  assert.equal(db.countLeads(), 1);
  assert.equal(logs.some((l) => l.evt === 'wa.note.failed'), true);
  db.close();
});

/* ---------------- the cursor ---------------- */

test('the first window looks back ten minutes; every later one overlaps the cursor by two', async () => {
  const h = harness({ windows: [[msg({ text: 'hi' })], []] });
  await h.poller.tick();
  assert.deepEqual(h.asked[0], { gte: NOW - FIRST_RUN_LOOKBACK_MS - OVERLAP_MS, lte: NOW, instance: INSTANCE });

  const cursor = h.db.waCursorGet(INSTANCE);
  assert.equal(cursor.last_ts, NOW - 60_000, 'the cursor is the newest message seen');
  assert.equal(cursor.last_run, NOW);

  h.setClock(NOW + 45_000);
  await h.poller.tick();
  assert.deepEqual(h.asked[1], { gte: NOW - 60_000 - OVERLAP_MS, lte: NOW + 45_000, instance: INSTANCE });
  const after = h.db.waCursorGet(INSTANCE);
  assert.equal(after.last_ts, NOW + 45_000, 'an empty window still moves the cursor to now');
  h.cleanup();
});

test('a lone stale message can never freeze the cursor and widen the window for ever', async () => {
  // The same old message comes back inside the overlap on every tick, so "the newest
  // thing we saw" never moves. Half an hour of that must not turn into a half-hour query.
  const stale = msg({ id: 'STALE', ts: NOW - 60_000, text: 'hi' });
  const h = harness();
  for (let i = 0; i < 40; i += 1) {
    h.push([stale]);
    h.setClock(NOW + i * 45_000);
    await h.poller.tick(); // eslint-disable-line no-await-in-loop
  }
  const last = h.asked.at(-1);
  assert.ok(last.lte - last.gte <= MAX_WINDOW_MS + OVERLAP_MS + 45_000, `window is ${(last.lte - last.gte) / 60_000} minutes`);
  assert.equal(h.db.countLeads(), 0);
  h.cleanup();
});

test('a week-old dedupe row is pruned; a fresh one is not', async () => {
  const h = harness({ windows: [[msg({ text: 'hi' })]] });
  h.db.waSeenAdd('ANCIENT', NOW - SEEN_TTL_MS - 1000);
  h.db.waSeenAdd('RECENT', NOW - 86_400_000);
  await h.poller.tick();
  assert.equal(h.db.waSeenHas('ANCIENT'), false);
  assert.equal(h.db.waSeenHas('RECENT'), true);
  h.cleanup();
});

test('a tick that is already in flight is never run twice over the same window', async () => {
  const db = openDb(':memory:');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reads = 0;
  const poller = createPoller({
    db,
    cfg: { env: { BONA_OWNER_JID: OWNER } },
    findMessages: async () => { reads += 1; await gate; return { records: [] }; },
    now: () => NOW,
  });
  const first = poller.tick();
  const second = await poller.tick();
  assert.deepEqual(second, { busy: true });
  release();
  await first;
  assert.equal(reads, 1);
  db.close();
});

test('status() is what /health publishes', async () => {
  const h = harness({ windows: [[msg({ text: 'Ref BONA-W003 · K7Q2XR' })]] });
  const before = h.poller.status();
  assert.deepEqual(
    { lastRun: before.lastRun, lastTs: before.lastTs, lagS: before.lagS, unmatched: before.unmatched, matched: before.matched, running: before.running },
    { lastRun: null, lastTs: null, lagS: null, unmatched: 0, matched: 0, running: false },
  );

  await h.poller.tick();
  h.setClock(NOW + 30_000);
  const after = h.poller.status();
  assert.equal(after.lastRun, NOW);
  assert.equal(after.lastTs, NOW - 60_000);
  assert.equal(after.lagS, 30, 'the lag is the age of the last completed tick, not of the newest message');
  assert.equal(after.matched, 1);
  assert.equal(after.instance, INSTANCE);
  assert.equal(after.running, false, 'status says whether the loop is on a timer, and nothing started one');
  h.cleanup();
});

test('start() puts the tick on an unref\'d timer and stop() takes it off', async () => {
  const h = harness({ windows: [[]] });
  assert.equal(h.poller.start({ intervalMs: 60_000 }), true);
  assert.equal(h.poller.started, true);
  assert.equal(h.poller.status().running, true);
  assert.equal(h.poller.start({ intervalMs: 60_000 }), false, 'starting twice is a no-op');
  h.poller.stop();
  assert.equal(h.poller.started, false);
  h.cleanup();
});

test('with no Evolution credentials the loop does nothing at all — it does not guess a URL', async () => {
  const db = openDb(':memory:');
  const logs = [];
  const poller = createPoller({ db, cfg: { env: {} }, log: (o) => logs.push(o), now: () => NOW });
  const out = await poller.tick();
  assert.deepEqual(out, { skipped: 'not_configured' });
  assert.equal(poller.status().configured, false);
  assert.equal(db.waCursorGet(INSTANCE), null);
  assert.equal(logs[0].evt, 'wa.poll.skipped');

  await poller.tick();
  await poller.tick();
  assert.equal(logs.length, 1, 'a missing key is a standing state, not news every 45 seconds');
  db.close();
});

/* ---------------- (l) the default wiring, both response shapes ---------------- */

/** Evolution's own reply, as the live instance sends it. */
const wire = (over = {}) => ({
  key: { id: 'W1', fromMe: false, remoteJid: SENDER },
  pushName: 'Sara',
  messageType: 'extendedTextMessage',
  message: { extendedTextMessage: { text: 'Ref BONA-W003 · K7Q2XR' } },
  messageTimestamp: Math.floor((NOW - 60_000) / 1000),
  ...over,
});

async function withStubbedFetch(body, fn) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  try { await fn(calls); } finally { globalThis.fetch = real; }
}

test('(l) without an injected reader the poller talks to Evolution itself — boxed shape, seconds', async () => {
  const db = openDb(':memory:');
  const sent = [];
  const poller = createPoller({
    db,
    cfg: { env: { EVOLUTION_API_URL: 'https://wa-api.example/', EVOLUTION_API_KEY: 'evo-key', BONA_OWNER_JID: OWNER }, siteUrl: 'https://bona-real-estate.com' },
    sendWhatsApp: async (t) => { sent.push(t); return { ok: true }; },
    now: () => NOW,
  });
  await withStubbedFetch({ messages: { total: 1, pages: 1, currentPage: 1, records: [wire()] } }, async (calls) => {
    const tally = await poller.tick();
    assert.equal(calls[0].url, 'https://wa-api.example/chat/findMessages/abdulaziz-personal');
    assert.equal(calls[0].headers.apikey, 'evo-key');
    assert.deepEqual(calls[0].body.where, {
      messageTimestamp: { gte: new Date(NOW - FIRST_RUN_LOOKBACK_MS - OVERLAP_MS).toISOString(), lte: new Date(NOW).toISOString() },
    });
    assert.equal(tally.matched, 1);
  });
  const [lead] = db.listLeads({ limit: 5 });
  assert.equal(lead.match_method, 'ref');
  assert.equal(lead.first_inbound_ts, NOW - 60_000, 'unix seconds became milliseconds');
  assert.equal(sent.length, 1);
  db.close();
});

test('(l) the bare-array shape and an ISO timestamp are read the same way', async () => {
  const db = openDb(':memory:');
  const poller = createPoller({
    db,
    cfg: { env: { EVOLUTION_API_URL: 'https://wa-api.example', EVOLUTION_API_KEY: 'evo-key', BONA_OWNER_JID: OWNER } },
    now: () => NOW,
  });
  await withStubbedFetch([wire({ messageTimestamp: new Date(NOW - 90_000).toISOString(), key: { id: 'W2', fromMe: false, remoteJid: SENDER } })], async () => {
    const tally = await poller.tick();
    assert.equal(tally.matched, 1);
  });
  const [lead] = db.listLeads({ limit: 5 });
  assert.equal(lead.first_inbound_ts, NOW - 90_000);
  db.close();
});
