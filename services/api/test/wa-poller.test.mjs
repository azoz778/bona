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
import { createTeam } from '../lib/team.mjs';
import {
  CLICK_WINDOW_MS, FIRST_RUN_LOOKBACK_MS, MAX_RECORD_ATTEMPTS, MAX_WINDOW_MS, OVERLAP_MS,
  SEEN_TTL_MS, adMetaOf, adSourceOf, createPoller, isIgnorableChat, jidsOf,
} from '../lib/wa-poller.mjs';
import { JOIN_HISTORY_MS, createBackfill } from '../lib/inbox/backfill.mjs';
import { ownerOutboundJoins } from '../lib/inbox/eligibility.mjs';
import { createIngest } from '../lib/inbox/ingest.mjs';
import { createInboxStore } from '../lib/inbox/store.mjs';
import { leadNote } from '../lib/leads.mjs';

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
 * Evolution's per-chat read (`findMessages` with a `key` filter) over a fixed pool: the
 * `remoteJid` / `remoteJidAlt` filters and the time window honoured the way the live
 * instance honours them (2026-09-28 pre-work), newest first, paged by `offset`. `fail`
 * records the question and then throws, the way a read does while Evolution is down.
 */
function chatReader(pool, { fail = false } = {}) {
  const calls = [];
  const find = async ({ where = {}, page = 1, offset = 100 } = {}) => {
    calls.push({ where, page, offset });
    if (fail) throw new Error('connect ECONNREFUSED 127.0.0.1:8085');
    const key = where.key ?? {};
    const t = where.messageTimestamp ?? null;
    const hits = pool
      .filter((r) => (key.remoteJid === undefined || r.jid === key.remoteJid)
        && (key.remoteJidAlt === undefined || r.jidAlt === key.remoteJidAlt)
        && (!t || (r.ts >= Date.parse(t.gte) && r.ts <= Date.parse(t.lte))))
      .sort((a, b) => b.ts - a.ts);
    return { records: hits.slice((page - 1) * offset, page * offset), total: hits.length, pages: Math.max(1, Math.ceil(hits.length / offset)) };
  };
  return { calls, find };
}

/** The Bona inbox wired the way index.mjs wires it, with the owner seeded and the per-chat reader spied on. */
function inboxWiring({ db, history, historyFails = false, logs, now }) {
  const team = createTeam(db, { now });
  const owner = team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const inbox = createInboxStore(db, { now });
  const log = (obj) => logs.push(obj);
  const ingestor = createIngest({ db, inbox, ownerUserId: () => owner.user_id, log, now });
  const ingest = (lead, rec) => ingestor.ingest(lead, rec);
  const reader = chatReader(history, { fail: historyFails });
  const backfill = createBackfill({ env: {}, db, ingest, find: reader.find, log, now });
  return { team, owner, inbox, ingest, backfill, findCalls: reader.calls };
}

/**
 * A store with the visitor session behind Ref `K7Q2XR`, a poller wired to a queue of
 * windows (one per tick), and the owner's note sender recorded rather than sent.
 *
 * `inbox: true` also wires the Bona inbox (`inboxWiring` above): the real inbox store,
 * ingest and backfill over the same db, except that the backfill's per-chat reader is a
 * spy over `history`, so no test reaches Evolution; `historyFails` makes that reader throw,
 * as it does when Evolution is down. `ingestOverride` replaces only the poller's ingest
 * (the backfill keeps the real one), for a store that fails.
 */
function harness({ windows = [], env = {}, seedSession = true, isExcluded, inbox = false, history = [], historyFails = false, ingestOverride = null } = {}) {
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
  const wiring = inbox ? inboxWiring({ db, history, historyFails, logs, now: () => clock }) : null;
  const poller = createPoller({
    db,
    cfg: { env: { BONA_OWNER_JID: OWNER, ...env }, siteUrl: 'https://bona-real-estate.com', dataDir, waPollMs: 0 },
    findMessages: async (window) => { asked.push(window); return { records: queue.length ? queue.shift() : [] }; },
    sendWhatsApp: async (text) => { sent.push(text); return { ok: true }; },
    ...(isExcluded ? { isExcluded } : {}),
    ...(wiring ? { inboxStore: wiring.inbox, ingest: ingestOverride ?? wiring.ingest, backfill: wiring.backfill } : {}),
    log: (obj) => logs.push(obj),
    now: () => clock,
  });
  return {
    db, poller, asked, sent, logs, dataDir,
    inbox: wiring?.inbox ?? null, team: wiring?.team ?? null, owner: wiring?.owner ?? null, findCalls: wiring?.findCalls ?? [],
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
  assert.deepEqual(h.db.dueFanout(NOW + 1000).map((r) => r.event_id), Array(4).fill(created.event_id));
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

/* ---------------- (m) team and never-list numbers ---------------- */

test('(m) a team or never-a-client number is never a lead or a reply, even with "Bona" or a Ref line', async () => {
  const excluded = new Set(['966500000000']);
  const h = harness({
    isExcluded: (digits) => excluded.has(digits),
    windows: [[
      msg({ id: 'K-code', fromMe: true, text: 'Bona dashboard code: 123456 (valid 10 min)' }),
      msg({ id: 'K-word', text: 'I am handling the Bona client today' }),
      msg({ id: 'K-ref', text: 'Ref BONA-W003 · K7Q2XR' }),
    ]],
  });
  const tally = await h.poller.tick();
  assert.equal(tally.matched, 0);
  assert.equal(tally.replies, 0);
  assert.equal(tally.ignored, 3);
  assert.equal(h.leads().length, 0);
  assert.equal(h.sent.length, 0, 'no new-lead note either');
  h.cleanup();
});

test('with no isExcluded passed at all, team/never-list exclusion simply does not run (older wiring)', async () => {
  const h = harness({ windows: [[msg({ text: 'Ref BONA-W003 · K7Q2XR' })]] });
  const tally = await h.poller.tick();
  assert.equal(tally.matched, 1);
  assert.equal(h.leads().length, 1);
  h.cleanup();
});

/* ---------------- (n) the @lid gap: a team number without a phone ---------------- */

test('(n) an @lid chat is uncaught but counted, never logged with the lid, until its phone has paired with it', async () => {
  const excluded = new Set(['966500000000']);
  const h = harness({
    isExcluded: (digits) => excluded.has(digits),
    windows: [[msg({ id: 'LID-ONLY', jid: '272516946294519@lid', jidAlt: null, pushName: null, text: 'I am handling the Bona client today' })]],
  });
  const tally = await h.poller.tick();
  // The gap, honestly: with only the lid to go on, isExcluded (phone-only) cannot rule
  // this out, so the keyword rule still gets to it and makes it a lead.
  assert.equal(tally.lidOnlyUnexcludable, 1);
  assert.equal(tally.matched, 1);
  assert.equal(h.leads().length, 1);

  const dump = JSON.stringify(h.logs);
  assert.ok(dump.includes('poll.lid_only_unexcludable'));
  assert.ok(!dump.includes('272516946294519'), 'the lid itself is never in a log line');
  h.cleanup();
});

test('(n) once a team phone pairs with its @lid via jidAlt, a later lid-only message from it is excluded too', async () => {
  // A real `users` row is what `learnTeamLid` actually writes `wa_lid` onto — a bare
  // closure over a Set (as `isExcluded` is everywhere else in this file) has nothing
  // for it to update. Production always has this row: `isExcluded` there IS
  // `team.isExcludedPhone`, backed by the same `users` table.
  const h = harness({
    isExcluded: (digits) => digits === '966500000000',
    windows: [
      // First message carries both: the phone (via jidAlt) is a team number, so it is
      // dropped — and the pairing with the lid is learned in the same step.
      [msg({ id: 'PAIR', jid: '272516946294519@lid', jidAlt: SENDER, pushName: null, text: 'Bona dashboard code: 123456' })],
      // Second message carries the lid alone. Without the learning above this would be
      // test (n)'s gap; with it, the same person is still recognised and stays excluded.
      [msg({ id: 'LID-ONLY', jid: '272516946294519@lid', jidAlt: null, ts: NOW - 30_000, pushName: null, text: 'Ref BONA-W003 · K7Q2XR' })],
    ],
  });
  createTeam(h.db, { now: () => NOW }).addUser({ name: 'Sara', phone: '966500000000', role: 'staff' });

  const first = await h.poller.tick();
  assert.equal(first.ignored, 1);
  assert.equal(first.matched, 0);
  assert.equal(h.leads().length, 0);

  const second = await h.poller.tick();
  assert.equal(second.ignored, 1, 'the learned lid excludes it on its own, even carrying a Ref line');
  assert.equal(second.matched, 0);
  assert.equal(second.lidOnlyUnexcludable, 0, 'no longer a gap for this lid');
  assert.equal(h.leads().length, 0);
  h.cleanup();
});

test('(n) with no team wired, a lid-only chat is judged exactly as before — no counter, no gap log', async () => {
  const h = harness({ windows: [[msg({ id: 'LID-ONLY', jid: '272516946294519@lid', jidAlt: null, pushName: null, text: 'Ref BONA-W003 · K7Q2XR' })]] });
  const tally = await h.poller.tick();
  assert.equal(tally.lidOnlyUnexcludable, 0);
  assert.equal(tally.matched, 1);
  assert.ok(!h.logs.some((l) => l.evt === 'poll.lid_only_unexcludable'));
  h.cleanup();
});

/* ---------------- (o) a lid-learning lookup that fails does not stall the loop ---------------- */

/**
 * Makes any statement touching `users.wa_lid` throw, as if the column were missing —
 * exactly what `learnTeamLid`/`isTeamLid` (lib/team.mjs) run, and nothing else: the
 * `leads` table's own (unrelated) `wa_lid` column is left alone.
 */
function withoutUsersWaLid(store) {
  const real = store.db.prepare.bind(store.db);
  store.db.prepare = (sql) => {
    if (/\busers\b/.test(sql) && /wa_lid/.test(sql)) throw new Error('no such column: wa_lid');
    return real(sql);
  };
  return store;
}

test('(o) a learnTeamLid failure is logged, never numbers or lids, and the record after it still gets processed', async () => {
  const excluded = new Set(['966500000000']);
  const h = harness({
    isExcluded: (digits) => excluded.has(digits),
    windows: [[
      // A team phone paired with its lid — this is exactly where `learnTeamLid` runs.
      msg({ id: 'TEAM-PAIR', jid: '272516946294519@lid', jidAlt: SENDER, pushName: null, ts: NOW - 90_000, text: 'Bona dashboard code: 123456' }),
      // An unrelated message right after it: proof the tick did not stall on the failure.
      msg({ id: 'AFTER', jid: '966511111111@s.whatsapp.net', ts: NOW - 30_000, text: 'Ref BONA-W003 · K7Q2XR' }),
    ]],
  });
  withoutUsersWaLid(h.db);

  const tally = await h.poller.tick();
  assert.equal(tally.error, undefined, 'the tick itself must not fail over this');
  assert.equal(tally.ignored, 1, 'the team-phone record is still excluded, learning failure or not');
  assert.equal(tally.matched, 1, 'the record behind it in the same window is still reached');
  assert.equal(h.leads().length, 1);

  const warned = h.logs.find((l) => l.evt === 'poll.lid_learn_failed');
  assert.ok(warned, 'the failure is logged');
  assert.equal(warned.level, 'warn');
  const dump = JSON.stringify(warned);
  assert.ok(!dump.includes('272516946294519') && !dump.includes('966500000000'), 'no lid, no phone in the log');
  h.cleanup();
});

test('(o) an isTeamLid failure is treated as uncheckable rather than crashing the tick', async () => {
  const h = harness({
    isExcluded: (digits) => digits === '966500000000',
    windows: [[
      // Lid-only: no phone to hand `isExcluded`, so the poller falls back to `isTeamLid`
      // — the call this test makes fail.
      msg({ id: 'LID-ONLY', jid: '272516946294519@lid', jidAlt: null, pushName: null, ts: NOW - 90_000, text: 'مرحبا بونا' }),
      msg({ id: 'AFTER', jid: '966511111111@s.whatsapp.net', ts: NOW - 30_000, text: 'Ref BONA-W003 · K7Q2XR' }),
    ]],
  });
  withoutUsersWaLid(h.db);

  const tally = await h.poller.tick();
  assert.equal(tally.error, undefined);
  assert.equal(tally.lidOnlyUnexcludable, 1, 'counted as uncheckable, not thrown');
  assert.equal(tally.matched, 2, 'both the lid-only record and the one after it are still judged');
  assert.equal(h.leads().length, 2);
  assert.ok(!h.logs.some((l) => l.evt === 'poll.lid_learn_failed'), 'a lookup failure is quiet, not another noisy warn');
  h.cleanup();
});

/* ---------------- (p) a lid is learned only from a message we received ---------------- */

test('(p) a fromMe record pairing a team phone with a lid does not teach the pairing', async () => {
  const h = harness({
    isExcluded: (digits) => digits === '966500000000',
    windows: [
      // Outbound: our own message to a team member, whose alt happens to carry their
      // number. `jidAlt` on a `fromMe` record is not trusted for learning (see
      // lib/wa-poller.mjs, and lib/evolution.mjs's `normaliseRecord` for why).
      [msg({ id: 'OUT-PAIR', jid: '272516946294519@lid', jidAlt: SENDER, fromMe: true, pushName: null, text: 'Bona dashboard code: 123456' })],
      // The same lid, alone, on a later tick.
      [msg({ id: 'LID-ONLY', jid: '272516946294519@lid', jidAlt: null, ts: NOW - 30_000, pushName: null, text: 'Ref BONA-W003 · K7Q2XR' })],
    ],
  });

  const first = await h.poller.tick();
  assert.equal(first.ignored, 1);
  assert.equal(first.replies, 0);
  assert.equal(h.leads().length, 0);

  const second = await h.poller.tick();
  assert.equal(second.lidOnlyUnexcludable, 1, 'no pairing was learned, so this is still the ordinary uncheckable gap');
  assert.equal(second.matched, 1, 'and it is judged normally — the Ref line makes it a lead');
  assert.equal(h.leads().length, 1);
  h.cleanup();
});

/* ---------------- (q) the owner's own self-chat lid ---------------- */

test('(q) once the owner\'s self-chat lid pairs with his number, a later lid-only self-chat message is recognised too', async () => {
  const h = harness({
    isExcluded: () => false, // wires the team system without excluding anyone else
    windows: [
      // The owner's self-chat, showing up as a lid whose alt is his own number.
      [msg({ id: 'SELF-PAIR', jid: '999888777@lid', jidAlt: OWNER, fromMe: false, pushName: null, text: 'reminder to myself' })],
      // The same self-chat, now arriving as the lid alone.
      [msg({ id: 'SELF-LID', jid: '999888777@lid', jidAlt: null, ts: NOW - 30_000, pushName: null, text: 'Ref BONA-W003 · K7Q2XR' })],
    ],
  });
  createTeam(h.db, { now: () => NOW }).ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });

  const first = await h.poller.tick();
  assert.equal(first.ignored, 1, 'the self-chat message is ignored, as any owner-chat message is');
  assert.equal(h.leads().length, 0);

  const second = await h.poller.tick();
  assert.equal(second.ignored, 1, 'the lid-only follow-up is now recognised as the same self-chat');
  assert.equal(second.lidOnlyUnexcludable, 0, 'no longer a gap for this lid');
  assert.equal(second.matched, 0);
  assert.equal(h.leads().length, 0);
  h.cleanup();
});

/* ---------------- status() carries the running lid-gap total ---------------- */

test('status() carries a running total of poll.lid_only_unexcludable across ticks', async () => {
  const h = harness({
    isExcluded: () => false,
    windows: [
      [msg({ id: 'LID-1', jid: '111@lid', jidAlt: null, pushName: null, text: 'مرحبا بونا' })],
      [msg({ id: 'LID-2', jid: '222@lid', jidAlt: null, ts: NOW - 30_000, pushName: null, text: 'BONA-W004' })],
    ],
  });
  assert.equal(h.poller.status().lidOnlyUnexcludable, 0);
  await h.poller.tick();
  assert.equal(h.poller.status().lidOnlyUnexcludable, 1);
  await h.poller.tick();
  assert.equal(h.poller.status().lidOnlyUnexcludable, 2, 'it accumulates, like matched does');
  h.cleanup();
});

/* ---------------- (r) a lid known from a lead is checked against the team and never lists ---------------- */

test('(r) an outbound lid-only record for a never-listed lead is ignored — no reply stamp', async () => {
  // Codex repro: the lead's phone was later put on the never list, but the lid on its own
  // still slipped through, because only `users.wa_lid` (team pairings) was ever consulted
  // — a lead's own `wa_lid` → `phone_e164` mapping was not.
  const h = harness({ isExcluded: (digits) => digits === '966500000001' });
  h.db.insertLead({
    lead_id: 'LEAD-test', phone_e164: '966500000001', wa_lid: '123456789@lid',
    created: NOW - 3_600_000, updated: NOW - 3_600_000,
  });
  h.push([msg({ id: 'OUT-LID', jid: '123456789@lid', jidAlt: null, fromMe: true, pushName: null, text: 'Ahlan!' })]);

  const tally = await h.poller.tick();
  assert.equal(tally.ignored, 1);
  assert.equal(tally.replies, 0, 'a never-listed contact is not a reply target, however the message arrives');
  assert.equal(h.db.getLead('LEAD-test').first_reply_ts, null);
  h.cleanup();
});

test('(r) an inbound lid-only record for a never-listed lead is ignored — no new lead, no touchpoint', async () => {
  const h = harness({ isExcluded: (digits) => digits === '966500000001' });
  h.db.insertLead({
    lead_id: 'LEAD-test', phone_e164: '966500000001', wa_lid: '123456789@lid',
    created: NOW - 3_600_000, updated: NOW - 3_600_000,
  });
  h.push([msg({ id: 'IN-LID', jid: '123456789@lid', jidAlt: null, pushName: null, text: 'Ref BONA-W003 · K7Q2XR' })]);

  const tally = await h.poller.tick();
  assert.equal(tally.matched, 0);
  assert.equal(tally.ignored, 1);
  assert.equal(h.db.countLeads(), 1, 'the pre-existing lead is the only one — none created for the never-listed contact');
  assert.equal(h.db.touchpointsForLead('LEAD-test').length, 0);
  h.cleanup();
});

test("(r) a normal client's lid-only record still merges as before, and is not counted toward the uncheckable gap", async () => {
  const h = harness({ isExcluded: () => false });
  h.db.insertLead({
    lead_id: 'LEAD-client', phone_e164: '966500000002', wa_lid: '987654321@lid',
    created: NOW - 3_600_000, updated: NOW - 3_600_000,
  });
  h.push([msg({ id: 'CLIENT-LID', jid: '987654321@lid', jidAlt: null, pushName: null, text: 'أي جديد؟' })]);

  const tally = await h.poller.tick();
  assert.equal(tally.merged, 1);
  assert.equal(tally.lidOnlyUnexcludable, 0, 'resolved via the lead mapping, so it is not part of the gap');
  assert.equal(h.db.countLeads(), 1);
  h.cleanup();
});

/* ---------------- (s) an isExcluded failure defers the record, never fails the whole window ---------------- */

test('(s) an isExcluded failure defers just that record; the tick completes and later records are processed', async () => {
  let calls = 0;
  const h = harness({
    isExcluded: (digits) => {
      if (digits === '966500000000' && calls++ === 0) throw new Error('team lookup exploded');
      return false;
    },
    windows: [[
      msg({ id: 'THROWS', ts: NOW - 90_000, text: 'Ref BONA-W003 · K7Q2XR' }),
      msg({ id: 'AFTER', jid: '966511111111@s.whatsapp.net', ts: NOW - 30_000, text: 'Ref BONA-W003 · K7Q2XR' }),
    ]],
  });

  const tally = await h.poller.tick();
  assert.equal(tally.error, undefined, 'the tick itself must not fail over this');
  assert.equal(tally.ignored, 0, 'not misfiled as excluded');
  assert.equal(tally.matched, 1, 'the record behind the throwing one is still processed in the same tick');
  assert.equal(h.db.countLeads(), 1);
  assert.equal(h.db.waSeenHas('THROWS'), false, 'not marked seen — it is retried, not lost');

  const warned = h.logs.find((l) => l.evt === 'poll.exclusion_check_failed');
  assert.ok(warned, 'the failure is logged');
  assert.equal(warned.level, 'warn');
  assert.ok(!JSON.stringify(warned).includes('966500000000'), 'no phone number in the log');

  // Retried: the cursor was held back to include it, and this time the lookup succeeds.
  h.push([msg({ id: 'THROWS', ts: NOW - 90_000, text: 'Ref BONA-W003 · K7Q2XR' })]);
  const second = await h.poller.tick();
  assert.equal(second.matched, 1, 'the deferred record is picked up and judged normally next time');
  assert.equal(h.db.countLeads(), 2);
  h.cleanup();
});

/* ---------------- (l) the default reader trusts the size Evolution states ---------------- */

test('(l) one full page that says it is the whole window is read once, not paged to the cap', async () => {
  const db = openDb(':memory:');
  const logs = [];
  const poller = createPoller({
    db,
    cfg: { env: { EVOLUTION_API_URL: 'https://wa-api.example', EVOLUTION_API_KEY: 'evo-key', BONA_OWNER_JID: OWNER } },
    log: (o) => logs.push(o),
    now: () => NOW,
  });
  const page = Array.from({ length: 100 }, (_, i) => wire({ key: { id: `P${i}`, fromMe: false, remoteJid: SENDER }, message: { conversation: 'hi' } }));
  await withStubbedFetch({ messages: { total: 100, pages: 1, currentPage: 1, records: page } }, async (calls) => {
    const tally = await poller.tick();
    assert.equal(calls.length, 1, 'total says 100 on one page, so there is no page 2 to ask for');
    assert.equal(tally.scanned, 100);
  });
  assert.equal(logs.some((l) => l.evt === 'wa.poll.truncated'), false);
  db.close();
});

test('a truncated window says how many messages it could not read', async () => {
  const db = openDb(':memory:');
  const logs = [];
  const poller = createPoller({
    db,
    cfg: { env: { BONA_OWNER_JID: OWNER } },
    findMessages: async () => ({ records: [msg({ text: 'hi' })], truncated: true, missing: 42 }),
    log: (o) => logs.push(o),
    now: () => NOW,
  });
  await poller.tick();
  const warned = logs.find((l) => l.evt === 'wa.poll.truncated');
  assert.equal(warned.level, 'warn');
  assert.equal(warned.missing, 42);
  db.close();
});

/* ---------------- (t) the Bona inbox (2026-09-27 design §4) ---------------- */

const iso = (ms) => new Date(ms).toISOString();
const STRANGER = '966522222222@s.whatsapp.net';
const STRANGER2 = '966533333333@s.whatsapp.net';
/** A chat's stored transcript, oldest first, as [id, direction, sender]. */
const rows = (h, leadId) => h.inbox.messagesFor(leadId).map((m) => [m.key_id, m.direction, m.sender_kind]);
/** Every per-chat read the backfill made asked for exactly the 24 h before the join. */
function assertHistoryWindow(h, joinTs) {
  assert.ok(h.findCalls.length > 0, 'the history before the join was asked for');
  for (const c of h.findCalls) assert.deepEqual(c.where.messageTimestamp, { gte: iso(joinTs - JOIN_HISTORY_MS), lte: iso(joinTs) });
}
/** A lead already in the inbox, as a certain match (or the migration) would have left it. */
const seedInLead = (h, over = {}) => h.db.insertLead({
  lead_id: 'LEAD-in', phone_e164: '966500000000', wa_jid: SENDER, inbox_state: 'in', inbox_since: NOW - 3_600_000,
  created: NOW - 3_600_000, updated: NOW - 3_600_000, ...over,
});

test('(t) with no inbox wired the poller stays the Phase 1 poller: no state, no transcript', async () => {
  const h = harness({ windows: [[
    msg({ text: 'Ref BONA-W003 · K7Q2XR' }),
    msg({ id: 'OUT', fromMe: true, ts: NOW - 30_000, pushName: null, text: 'Ahlan!' }),
  ]] });
  const tally = await h.poller.tick();
  const [lead] = h.leads();
  assert.equal(lead.inbox_state, null);
  assert.equal(lead.first_reply_ts, NOW - 30_000);
  assert.equal(createInboxStore(h.db).hasMessages(lead.lead_id), false);
  assert.deepEqual({ joined: tally.joined, stored: tally.stored }, { joined: 0, stored: 0 });
  h.cleanup();
});

test('(t) an inbox ingest without the inbox store is a wiring mistake, refused at once', () => {
  const db = openDb(':memory:');
  assert.throws(() => createPoller({ db, ingest: () => ({ stored: false }) }), TypeError);
  db.close();
});

test('(t) a Ref line puts the chat in the inbox: stored, with the 24 h before it', async () => {
  const hi = msg({ id: 'HI', ts: NOW - 3_600_000, text: 'Hi' });
  const ref = msg({ id: 'REF', ts: NOW - 60_000, text: 'Ref BONA-W003 · K7Q2XR' });
  const h = harness({ inbox: true, history: [hi, ref], windows: [[ref]] });
  const tally = await h.poller.tick();

  const [lead] = h.leads();
  assert.equal(lead.inbox_state, 'in');
  assert.equal(lead.inbox_since, NOW - 60_000, 'in since the message that joined it');
  assertHistoryWindow(h, NOW - 60_000);
  assert.deepEqual(rows(h, lead.lead_id), [['HI', 'in', 'client'], ['REF', 'in', 'client']], 'the "Hi" before the Ref line is there too, and nothing twice');
  assert.deepEqual(h.inbox.gapsFor(lead.lead_id), [], 'a history that was read leaves no gap');
  assert.deepEqual({ joined: tally.joined, stored: tally.stored }, { joined: 1, stored: 1 });
  assert.equal(h.sent.length, 1, 'a client-started lead still tells the owner');
  const joined = h.logs.find((l) => l.evt === 'inbox.join');
  assert.equal(joined.leadId, lead.lead_id);
  assert.equal(joined.via, 'inbound');
  h.cleanup();
});

test('(t) the word "bona" alone is a guess: the Unsure list, nothing stored, no history pulled', async () => {
  const h = harness({ inbox: true, windows: [[msg({ text: 'مرحبا بونا، عندكم شقق في الشاطئ؟' })]] });
  const tally = await h.poller.tick();
  const [lead] = h.leads();
  assert.equal(lead.match_method, 'keyword', 'still a lead, for the stats');
  assert.equal(lead.inbox_state, 'unsure');
  assert.equal(lead.inbox_since, null);
  assert.equal(h.inbox.hasMessages(lead.lead_id), false);
  assert.equal(h.findCalls.length, 0);
  assert.deepEqual({ joined: tally.joined, stored: tally.stored }, { joined: 0, stored: 0 });
  h.cleanup();
});

test('(t) a join whose history Evolution cannot give leaves a gap where that history belongs, and keeps the joining message', async () => {
  const hi = msg({ id: 'HI', ts: NOW - 3_600_000, text: 'Hi' });
  const ref = msg({ id: 'REF', ts: NOW - 60_000, text: 'Ref BONA-W003 · K7Q2XR' });
  const h = harness({ inbox: true, history: [hi, ref], historyFails: true, windows: [[ref]] });
  const tally = await h.poller.tick();

  const [lead] = h.leads();
  assert.equal(lead.inbox_state, 'in');
  assert.equal(tally.joined, 1);
  assert.ok(h.findCalls.length > 0, 'the history was asked for');
  assert.deepEqual(rows(h, lead.lead_id), [['REF', 'in', 'client']], 'the joining message is kept; the "Hi" before it could not be read');
  assert.deepEqual(h.inbox.gapsFor(lead.lead_id).map((g) => [g.key_id, g.lead_id, g.jid, g.ts, g.reason]), [
    [`join:${lead.lead_id}:${NOW - 60_000}`, lead.lead_id, null, NOW - 60_001, 'history_failed'],
  ], 'the chat now has a message, so the daily catch-up will not ask again: the thread has to say what is missing, just before the joining message');
  const warned = h.logs.find((l) => l.evt === 'inbox.join_history_failed');
  assert.deepEqual([warned.level, warned.leadId, warned.error], ['warn', lead.lead_id, 'failed']);
  assert.equal(JSON.stringify(h.logs).includes('966500000000'), false, 'no number in any log line');
  h.cleanup();
});

test('(t) a listing id is certain: in, and stored', async () => {
  const h = harness({ inbox: true, windows: [[msg({ text: 'BONA-W012 السعر؟' })]] });
  await h.poller.tick();
  const [lead] = h.leads();
  assert.equal(lead.match_method, 'keyword');
  assert.equal(lead.inbox_state, 'in');
  assert.deepEqual(rows(h, lead.lead_id), [['KEY1', 'in', 'client']]);
  h.cleanup();
});

test('(t) a click-window match is a guess too: Unsure, nothing stored', async () => {
  const h = harness({ inbox: true, windows: [[msg({ text: 'مرحبا' })]] });
  h.db.upsertSession({ session_id: 'clk1-9zad', anon_id: ANON2, started: NOW - 700_000, last_seen: NOW - 300_000, pages: 2, locale: 'ar' });
  h.db.insertEvent({ event_id: 'ev-click-1', ts: NOW - 300_000, name: 'whatsapp_click', anon_id: ANON2, session_id: 'clk1-9zad', listing_id: 'BONA-W007' });
  await h.poller.tick();
  const [lead] = h.leads();
  assert.equal(lead.match_method, 'time_window');
  assert.equal(lead.inbox_state, 'unsure');
  assert.equal(h.inbox.hasMessages(lead.lead_id), false);
  h.cleanup();
});

test('(t) an Unsure chat that later sends a Ref line joins, and its earlier messages come with it', async () => {
  const guess = msg({ id: 'W1', ts: NOW - 120_000, text: 'مرحبا بونا' });
  const ref = msg({ id: 'W2', ts: NOW - 30_000, text: 'Ref BONA-W003 · K7Q2XR' });
  const h = harness({ inbox: true, history: [guess, ref], windows: [[guess], [ref]] });
  await h.poller.tick();
  const [before] = h.leads();
  assert.equal(before.inbox_state, 'unsure');
  assert.equal(h.inbox.hasMessages(before.lead_id), false);

  const tally = await h.poller.tick();
  const [lead] = h.leads();
  assert.equal(lead.inbox_state, 'in');
  assert.equal(lead.inbox_since, NOW - 30_000);
  assert.equal(tally.joined, 1);
  assertHistoryWindow(h, NOW - 30_000);
  assert.deepEqual(rows(h, lead.lead_id), [['W1', 'in', 'client'], ['W2', 'in', 'client']], 'the message the poller already saw as a guess is pulled back in');
  h.cleanup();
});

test('(t) an out chat never comes back on its own — not on a Ref line, not on a Bona link', async () => {
  const h = harness({ inbox: true });
  seedInLead(h, { lead_id: 'LEAD-out', inbox_state: 'out', inbox_since: null });
  h.push([
    msg({ id: 'O-IN', ts: NOW - 60_000, text: 'Ref BONA-W003 · K7Q2XR' }),
    msg({ id: 'O-OUT', fromMe: true, ts: NOW - 30_000, pushName: null, text: 'https://bona-real-estate.com/properties/bona-w003/' }),
  ]);
  const tally = await h.poller.tick();
  assert.equal(h.db.getLead('LEAD-out').inbox_state, 'out');
  assert.equal(h.inbox.hasMessages('LEAD-out'), false);
  assert.equal(h.findCalls.length, 0);
  assert.deepEqual({ joined: tally.joined, stored: tally.stored }, { joined: 0, stored: 0 });
  h.cleanup();
});

test("(t) an in chat is stored both ways; the owner's own reply is 'owner_number', makes him the handler, and still stops the clock", async () => {
  const h = harness({ inbox: true, windows: [
    [msg({ id: 'IN1', ts: NOW - 60_000, text: 'Ref BONA-W003 · K7Q2XR' })],
    [
      msg({ id: 'IN2', ts: NOW - 50_000, text: 'أي جديد؟' }),
      msg({ id: 'OUT1', fromMe: true, ts: NOW - 40_000, pushName: 'Abdulaziz', text: 'Ahlan! Let me check.' }),
    ],
  ] });
  await h.poller.tick();
  const second = await h.poller.tick();
  assert.equal(second.replies, 1);
  assert.equal(second.stored, 2);
  const [lead] = h.leads();
  assert.equal(lead.first_reply_ts, NOW - 40_000, 'the reply clock stops exactly as before — the Hermes watchdog reads it');
  assert.equal(lead.handler_user_id, h.owner.user_id, 'his number answered first, so the chat is his until someone takes it');
  assert.deepEqual(h.inbox.messagesFor(lead.lead_id).map((m) => [m.key_id, m.direction, m.sender_kind, m.text]), [
    ['IN1', 'in', 'client', 'Ref BONA-W003 · K7Q2XR'],
    ['IN2', 'in', 'client', 'أي جديد؟'],
    ['OUT1', 'out', 'owner_number', 'Ahlan! Let me check.'],
  ]);
  h.cleanup();
});

test('(t) a Bona link the owner sends to a stranger starts a chat: in, no note, already answered, no ad fan-out', async () => {
  const opener = msg({ id: 'OPEN', fromMe: true, jid: STRANGER, pushName: 'Abdulaziz', ts: NOW - 600_000, text: 'Salam, this is Abdulaziz from Bona' });
  const link = msg({ id: 'LINK', fromMe: true, jid: STRANGER, pushName: 'Abdulaziz', ts: NOW - 60_000, text: 'Here it is: https://bona-real-estate.com/properties/bona-w003/' });
  const h = harness({ inbox: true, history: [opener, link], windows: [[link]] });
  const tally = await h.poller.tick();

  const [lead] = h.leads();
  assert.equal(lead.match_method, 'owner_outbound');
  assert.equal(lead.channel, 'whatsapp');
  assert.equal(lead.phone_e164, '966522222222');
  assert.equal(lead.name, null, "a fromMe pushName is the owner's own, never the client's");
  assert.equal(lead.listing_id, 'BONA-W003');
  assert.equal(lead.inbox_state, 'in');
  assert.equal(lead.inbox_since, NOW - 60_000);
  assert.equal(lead.first_inbound_ts, null);
  assert.equal(lead.first_reply_ts, NOW - 60_000, 'he wrote first, so nobody is waiting on him');
  assert.equal(lead.handler_user_id, h.owner.user_id);
  assert.equal(h.db.countWaitingLeads(), 0);
  assert.equal(h.sent.length, 0, 'no new-lead note: the owner started this chat himself');
  assert.deepEqual(h.db.dueFanout(NOW + 1000), [], 'no click behind it, so the ad platforms hear nothing');
  assertHistoryWindow(h, NOW - 60_000);
  assert.deepEqual(rows(h, lead.lead_id), [['OPEN', 'out', 'owner_number'], ['LINK', 'out', 'owner_number']], 'his opening line comes with it');
  assert.equal(tally.joined, 1);
  const joined = h.logs.find((l) => l.evt === 'inbox.join');
  assert.deepEqual({ leadId: joined.leadId, via: joined.via, created: joined.created }, { leadId: lead.lead_id, via: 'owner_outbound', created: true });
  h.cleanup();
});

test('(t) nothing else the owner types to a stranger counts — not chat, not even the word Bona', async () => {
  const h = harness({ inbox: true, windows: [[
    msg({ id: 'P1', fromMe: true, jid: STRANGER, pushName: null, text: 'see you at 6' }),
    msg({ id: 'P2', fromMe: true, jid: STRANGER2, pushName: null, ts: NOW - 30_000, text: 'I work at Bona now' }),
  ]] });
  const tally = await h.poller.tick();
  assert.equal(h.db.countLeads(), 0);
  assert.equal(h.findCalls.length, 0);
  assert.deepEqual({ joined: tally.joined, stored: tally.stored }, { joined: 0, stored: 0 });
  h.cleanup();
});

test('(t) a Bona brochure the owner sends starts a chat; a file that only looks like one does not', async () => {
  const h = harness({ inbox: true, windows: [[
    msg({ id: 'DOC', fromMe: true, jid: STRANGER, pushName: null, messageType: 'documentMessage', media: '[document: Bona Brochure.pdf]', fileName: 'Bona Brochure.pdf' }),
    msg({ id: 'NOTDOC', fromMe: true, jid: STRANGER2, pushName: null, ts: NOW - 30_000, messageType: 'documentMessage', media: '[document: Bonanza menu.pdf]', fileName: 'Bonanza menu.pdf' }),
  ]] });
  await h.poller.tick();
  assert.equal(h.db.countLeads(), 1);
  const [lead] = h.leads();
  assert.equal(lead.phone_e164, '966522222222');
  assert.equal(lead.match_method, 'owner_outbound');
  assert.equal(lead.inbox_state, 'in');
  assert.deepEqual(h.inbox.messagesFor(lead.lead_id).map((m) => [m.key_id, m.direction, m.sender_kind, m.text, m.media_type]), [
    ['DOC', 'out', 'owner_number', null, '[document: Bona Brochure.pdf]'],
  ]);
  h.cleanup();
});

test("(t) an outbound record carrying our own outbox row's WhatsApp id is the staff member's, not the owner's", async () => {
  const h = harness({ inbox: true, windows: [[msg({ id: 'IN1', ts: NOW - 60_000, text: 'Ref BONA-W003 · K7Q2XR' })]] });
  await h.poller.tick();
  const [lead] = h.leads();
  const mona = h.team.addUser({ name: 'Mona', phone: '0511112222', role: 'staff' });
  h.inbox.insertOutbox({ send_id: 'SND-test-0001', lead_id: lead.lead_id, jid: SENDER, text: 'Welcome to Bona', user_id: mona.user_id, sender_kind: 'staff' });
  h.inbox.updateOutbox('SND-test-0001', { status: 'accepted', key_id: 'K-STAFF' });
  h.push([msg({ id: 'K-STAFF', fromMe: true, ts: NOW - 30_000, pushName: null, text: 'Welcome to Bona' })]);

  const tally = await h.poller.tick();
  assert.equal(tally.stored, 1);
  const row = h.inbox.messagesFor(lead.lead_id).find((m) => m.key_id === 'K-STAFF');
  assert.equal(row.direction, 'out');
  assert.equal(row.sender_kind, 'staff');
  assert.equal(row.sender_user_id, mona.user_id);
  assert.equal(h.db.getLead(lead.lead_id).first_reply_ts, NOW - 30_000, 'a staff reply stops the clock too');
  h.cleanup();
});

test('(t) a team or never-list number is never stored, even when its lead is in the inbox', async () => {
  const h = harness({ inbox: true, isExcluded: (digits) => digits === '966500000000' });
  seedInLead(h);
  h.push([
    msg({ id: 'X-IN', ts: NOW - 60_000, text: 'Ref BONA-W003 · K7Q2XR' }),
    msg({ id: 'X-OUT', fromMe: true, ts: NOW - 30_000, pushName: null, text: 'https://bona-real-estate.com/properties/bona-w003/' }),
  ]);
  const tally = await h.poller.tick();
  assert.equal(tally.ignored, 2);
  assert.equal(tally.stored, 0);
  assert.equal(h.inbox.hasMessages('LEAD-in'), false);
  assert.equal(h.findCalls.length, 0);
  h.cleanup();
});

test('(t) a record of an in chat that is written off leaves a gap in the thread, not silence', async () => {
  const h = harness({ inbox: true, ingestOverride: () => { throw new Error('disk I/O error'); } });
  seedInLead(h);
  const bad = msg({ id: 'BAD', ts: NOW - 60_000, text: 'أي جديد؟' });
  for (let i = 1; i <= MAX_RECORD_ATTEMPTS; i += 1) {
    h.push([bad]);
    await h.poller.tick(); // eslint-disable-line no-await-in-loop
    if (i < MAX_RECORD_ATTEMPTS) assert.deepEqual(h.inbox.gapsFor('LEAD-in'), [], 'while it is still owed a retry it is not a gap');
  }
  assert.equal(h.logs.filter((l) => l.evt === 'wa.poll.record_failed').at(-1).writtenOff, true);
  assert.deepEqual(h.inbox.gapsFor('LEAD-in').map((g) => [g.key_id, g.lead_id, g.jid, g.ts, g.reason]), [['BAD', 'LEAD-in', SENDER, NOW - 60_000, 'failed']]);
  assert.equal(h.inbox.hasMessages('LEAD-in'), false);
  h.cleanup();
});

test('(t) the inbox never puts a number, a name or a message into a log line', async () => {
  const lid = '272516946294519@lid';
  const h = harness({ inbox: true, windows: [[
    msg({ id: 'L-IN', jid: lid, jidAlt: SENDER, ts: NOW - 90_000, text: 'Hi there, Ref BONA-W003 · K7Q2XR' }),
    msg({ id: 'L-OUT', jid: lid, jidAlt: SENDER, fromMe: true, pushName: 'Abdulaziz', ts: NOW - 60_000, text: 'Ahlan Sara, sending photos' }),
    msg({ id: 'S-OUT', fromMe: true, jid: STRANGER, pushName: 'Abdulaziz', ts: NOW - 30_000, text: 'Here it is: https://bona-real-estate.com/properties/bona-w003/' }),
  ]] });
  const tally = await h.poller.tick();
  assert.equal(tally.joined, 2, 'both kinds of join happened, so both kinds of log line were written');
  assert.equal(tally.stored, 3);
  const dump = JSON.stringify(h.logs);
  for (const secret of ['966500000000', '966522222222', '272516946294519', 'Hi there', 'Ahlan', 'Here it is', 'Sara', 'Abdulaziz']) {
    assert.ok(!dump.includes(secret), `a log line carries ${secret}`);
  }
  h.cleanup();
});

/* ---------------- (t) amendments A5–A8 (2026-09-28 quality reviews of Task 3) ---------------- */

test('(t) a bare Ref code that a site session holds is certain: in, stored, with the 24 h before it (A6)', async () => {
  const h = harness({ inbox: true, windows: [[msg({ id: 'BARE', text: 'Ref K7Q2XR' })]] });
  const tally = await h.poller.tick();
  const [lead] = h.leads();
  assert.equal(lead.match_method, 'ref');
  assert.equal(lead.session_id, 'mf3k2a-7b1c', 'the code is a real visit');
  assert.equal(lead.inbox_state, 'in');
  assertHistoryWindow(h, NOW - 60_000);
  assert.deepEqual(rows(h, lead.lead_id), [['BARE', 'in', 'client']]);
  assert.equal(tally.joined, 1);
  h.cleanup();
});

test('(t) the same bare Ref code with no session behind it is a guess: Unsure, nothing stored, no history pulled (A6)', async () => {
  const h = harness({ inbox: true, seedSession: false, windows: [[msg({ id: 'BARE', text: 'Ref K7Q2XR' })]] });
  const tally = await h.poller.tick();
  const [lead] = h.leads();
  assert.equal(lead.match_method, 'ref', 'still a lead, for the stats');
  assert.equal(lead.session_id, null);
  assert.equal(lead.inbox_state, 'unsure', '"TK booking Ref ABCDEF" has this shape too');
  assert.equal(h.inbox.hasMessages(lead.lead_id), false);
  assert.equal(h.findCalls.length, 0);
  assert.deepEqual({ joined: tally.joined, stored: tally.stored }, { joined: 0, stored: 0 });
  h.cleanup();
});

test('(t) "coupons" and "bona fide" are not our name: no lead at all (A5, A8)', async () => {
  const h = harness({ inbox: true, windows: [[
    msg({ id: 'C1', text: 'عندكم كوبونات؟' }),
    msg({ id: 'C2', jid: STRANGER, ts: NOW - 30_000, text: 'Is this a bona fide offer?' }),
  ]] });
  const tally = await h.poller.tick();
  assert.equal(tally.unmatched, 2);
  assert.equal(h.db.countLeads(), 0);
  h.cleanup();
});

test("(t) our own new-lead note would pass as a Bona chat, but the owner's chat never reaches that rule (A7)", async () => {
  const note = leadNote({
    name: 'Sara', phone_e164: '966500000000', listing_id: 'BONA-W003', source: 'meta', medium: 'paid', ref: 'K7Q2XR', channel: 'whatsapp', created: NOW,
  }, { siteUrl: 'https://bona-real-estate.com' });
  assert.equal(ownerOutboundJoins({ text: note }), true, 'it carries a Bona link, a listing id and a Ref line');
  const notes = [
    msg({ id: 'N-OUT', fromMe: true, jid: OWNER, pushName: 'Abdulaziz', ts: NOW - 90_000, text: note }),
    msg({ id: 'N-LID', fromMe: true, jid: '101010101010101@lid', jidAlt: OWNER, pushName: 'Abdulaziz', ts: NOW - 60_000, text: note }),
    msg({ id: 'N-IN', jid: OWNER, pushName: 'Abdulaziz', ts: NOW - 30_000, text: note }),
  ];

  // The owner's own chat is skipped before anything else: the note is sent there.
  const own = harness({ inbox: true, windows: [notes] });
  const first = await own.poller.tick();
  assert.equal(first.ignored, 3);
  assert.equal(own.db.countLeads(), 0);
  assert.equal(own.findCalls.length, 0);
  assert.deepEqual({ joined: first.joined, stored: first.stored }, { joined: 0, stored: 0 });
  own.cleanup();

  // With no owner chat configured, his number is still a team number, so the team check skips it.
  let team = null;
  const bare = harness({ inbox: true, env: { BONA_OWNER_JID: '' }, isExcluded: (digits) => team.isExcludedPhone(digits), windows: [notes] });
  team = bare.team;
  const second = await bare.poller.tick();
  assert.equal(second.ignored, 3);
  assert.equal(bare.db.countLeads(), 0);
  assert.equal(bare.findCalls.length, 0);
  assert.deepEqual({ joined: second.joined, stored: second.stored }, { joined: 0, stored: 0 });
  bare.cleanup();
});

test('(t) a document name cut at 120 characters starts a chat only where the whole name would (A8)', async () => {
  // What is left of "… Bonanza menu.pdf" and of a real brochure's long name after the cut.
  const cutBonanza = `${'x'.repeat(115)} Bona`;
  const cutBrochure = `Bona Villa brochure ${'x'.repeat(100)}`;
  const h = harness({ inbox: true, windows: [[
    msg({ id: 'CUT1', fromMe: true, jid: STRANGER, pushName: null, ts: NOW - 60_000, messageType: 'documentMessage', media: `[document: ${cutBonanza}]`, fileName: cutBonanza, fileNameTruncated: true }),
    msg({ id: 'CUT2', fromMe: true, jid: STRANGER2, pushName: null, ts: NOW - 30_000, messageType: 'documentMessage', media: `[document: ${cutBrochure}]`, fileName: cutBrochure, fileNameTruncated: true }),
  ]] });
  const tally = await h.poller.tick();
  assert.equal(h.db.countLeads(), 1, 'only the brochure');
  const [lead] = h.leads();
  assert.equal(lead.phone_e164, '966533333333');
  assert.equal(lead.inbox_state, 'in');
  assert.deepEqual(rows(h, lead.lead_id), [['CUT2', 'out', 'owner_number']]);
  assert.equal(tally.joined, 1);
  h.cleanup();
});
