/**
 * Per-chat reads for the Bona inbox. Evolution is never contacted: every test injects
 * `find` and records each question it is asked (`where`, `page`, `offset`, and a refresh's
 * `timeoutMs`), except the last, which stubs `fetchImpl` to prove the default wiring builds
 * the request the live instance answered on 2026-09-28. Records go through the real ingest
 * into a real store. The clock is injected; a slow Evolution is a `find` that moves it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createTeam } from '../lib/team.mjs';
import { EvolutionError, PAGE_SIZE } from '../lib/evolution.mjs';
import { createInboxStore, RETENTION_MS } from '../lib/inbox/store.mjs';
import { createIngest } from '../lib/inbox/ingest.mjs';
import {
  BACKFILL_MAX_PAGES, JOIN_HISTORY_MS, OWNER_HISTORY_MS, REFRESH_LIMIT, createBackfill, phoneJidOf,
} from '../lib/inbox/backfill.mjs';

const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const LEAD_ID = 'LEAD-20260928-0000aaaa';
const PHONE = '966500000001';
const PHONE_JID = `${PHONE}@s.whatsapp.net`;
const LID = '111222333444555@lid';
/** `messageTimestamp` for a 24 h join ending now. */
const DAY = { gte: '2026-09-27T12:00:00.000Z', lte: '2026-09-28T12:00:00.000Z' };

const LEAD = {
  lead_id: LEAD_ID, created: NOW - 3_600_000, updated: NOW - 3_600_000, phone_e164: PHONE, wa_jid: PHONE_JID, wa_lid: LID,
  channel: 'whatsapp', match_method: 'ref', stage: 'new', inbox_state: 'in', inbox_since: NOW - 3_600_000,
};
/** LEAD's history floor (amendment A1): 24 h before it joined the inbox. */
const FLOOR = LEAD.inbox_since - JOIN_HISTORY_MS;
/** `messageTimestamp` for a refresh of LEAD at NOW: from its floor to now. */
const SINCE_JOIN = { gte: '2026-09-27T11:00:00.000Z', lte: '2026-09-28T12:00:00.000Z' };

/** One normalised record, as lib/evolution.mjs hands them over: inbound, under the lid, phone as alt. */
const rec = (over = {}) => ({
  id: 'K1', jid: LID, jidAlt: PHONE_JID, fromMe: false, ts: NOW - 600_000, text: 'Hi', pushName: 'Sara',
  contextInfo: null, messageType: 'conversation', media: null, fileName: null, noise: false, ...over,
});

/** Answers each question from a table: `alt:<jid>` / `jid:<jid>` → pages of records, newest first. */
function router(table) {
  return ({ where, page }) => {
    const k = where.key.remoteJidAlt ? `alt:${where.key.remoteJidAlt}` : `jid:${where.key.remoteJid}`;
    const pages = table[k] ?? [];
    return { records: pages[page - 1] ?? [], total: pages.flat().length, pages: pages.length };
  };
}

/**
 * Evolution's per-chat read over one pool of records, answered the way the live instance
 * answered it on 2026-09-28: the key clause, the `messageTimestamp` window (both bounds),
 * newest first, `offset` records a page, with the sizes stated.
 */
function pool(records) {
  return ({ where, page, offset }) => {
    const { key, messageTimestamp: span } = where;
    const hits = records
      .filter((r) => (key.remoteJidAlt ? r.jidAlt === key.remoteJidAlt : r.jid === key.remoteJid))
      .filter((r) => !span || (r.ts >= Date.parse(span.gte) && r.ts <= Date.parse(span.lte)))
      .sort((a, b) => b.ts - a.ts);
    return { records: hits.slice((page - 1) * offset, page * offset), total: hits.length, pages: Math.ceil(hits.length / offset) };
  };
}

/** `serve(q, { tick })` answers each question; `tick(ms)` moves the one clock every part reads. */
function harness({ serve = router({}), lead = {}, env = {}, injectFind = true, fetchImpl = undefined, ingest = undefined, logImpl = undefined } = {}) {
  const s = openDb(':memory:');
  let clock = NOW;
  const tick = (ms) => { clock += ms; };
  const team = createTeam(s, { now: () => clock });
  const owner = team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const inbox = createInboxStore(s, { now: () => clock });
  const logs = [];
  const log = logImpl ?? ((o) => logs.push(o));
  const real = createIngest({ db: s, inbox, ownerUserId: () => owner.user_id, log, now: () => clock });
  const ingested = [];
  const calls = [];
  const backfill = createBackfill({
    env, db: s, log, now: () => clock,
    ingest: ingest ?? ((l, r) => { ingested.push(r.id); return real.ingest(l, r); }),
    ...(injectFind ? { find: async (q) => { calls.push(q); return serve(q, { tick }); } } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  s.insertLead({ ...LEAD, ...lead });
  return { s, team, owner, inbox, backfill, calls, ingested, logs, tick, now: () => clock, lead: () => s.getLead(LEAD_ID) };
}

/** Every phone number, lid and name these tests use. None may reach a log line. */
const PERSONAL = [PHONE, '111222333444555', '966593296933', 'Sara', 'Abdulaziz'];
function assertClean(logs) {
  const out = JSON.stringify(logs);
  for (const needle of PERSONAL) assert.equal(out.includes(needle), false, 'a log line carries personal data');
}

test("phoneJidOf: the lead's phone jid without its device, else one built from a real international phone", () => {
  assert.equal(phoneJidOf({ wa_jid: '966500000001:12@s.whatsapp.net', phone_e164: '966599999999' }), PHONE_JID);
  assert.equal(phoneJidOf({ wa_jid: null, phone_e164: PHONE }), PHONE_JID);
  assert.equal(phoneJidOf({ wa_jid: LID, phone_e164: PHONE }), PHONE_JID, 'a lid in the jid column is not a phone');
  assert.equal(phoneJidOf({ wa_jid: '0500000001@s.whatsapp.net', phone_e164: null }), null, 'local trunk format');
  for (const phone of ['0500000001', '1234567', '1234567890123456', 'abc', '', null]) {
    assert.equal(phoneJidOf({ wa_jid: null, phone_e164: phone }), null, String(phone));
  }
  assert.equal(phoneJidOf({ wa_jid: null, wa_lid: LID, phone_e164: null }), null, 'lid-only: no phone to build');
  assert.equal(phoneJidOf(null), null);
  const h = harness();
  assert.equal(h.backfill.phoneJidOf(h.lead()), PHONE_JID);
  assert.equal(h.backfill.configured, true);
  h.s.close();
});

test('history asks the three questions in the join window, de-duplicates by id and stores each record once', async () => {
  const h = harness({
    serve: router({
      [`alt:${PHONE_JID}`]: [[rec({ id: 'K2', ts: NOW - 300_000 }), rec({ id: 'K1', ts: NOW - 600_000 })]],
      // Sent through the API to the phone number: filed under the phone jid itself.
      [`jid:${PHONE_JID}`]: [[rec({ id: 'K3', jid: PHONE_JID, jidAlt: null, fromMe: true, text: 'Welcome', ts: NOW - 420_000 })]],
      [`jid:${LID}`]: [[rec({ id: 'K4', jidAlt: null, ts: NOW - 120_000 }), rec({ id: 'K2', ts: NOW - 300_000 })]],
    }),
  });
  const out = await h.backfill.history(h.lead(), { sinceTs: NOW - JOIN_HISTORY_MS });
  assert.deepEqual(out, { stored: 4, scanned: 5, truncated: false });
  assert.deepEqual(h.calls, [
    { where: { key: { remoteJidAlt: PHONE_JID }, messageTimestamp: DAY }, page: 1, offset: PAGE_SIZE },
    { where: { key: { remoteJid: PHONE_JID }, messageTimestamp: DAY }, page: 1, offset: PAGE_SIZE },
    { where: { key: { remoteJid: LID }, messageTimestamp: DAY }, page: 1, offset: PAGE_SIZE },
  ]);
  assert.deepEqual(h.ingested, ['K1', 'K3', 'K2', 'K4'], 'each id once: the two phone questions oldest first together, then the lid');
  const stored = h.inbox.messagesFor(LEAD_ID);
  assert.deepEqual(stored.map((m) => m.key_id), ['K1', 'K3', 'K2', 'K4']);
  assert.equal(stored.find((m) => m.key_id === 'K3').sender_kind, 'owner_number');
  // Asking again stores nothing new.
  assert.deepEqual(await h.backfill.history(h.lead(), { sinceTs: NOW - JOIN_HISTORY_MS }), { stored: 0, scanned: 5, truncated: false });
  h.s.close();
});

test('a lid learned from the remoteJidAlt question is then asked for; with no lid there are only two questions', async () => {
  const learns = harness({
    lead: { wa_lid: null },
    serve: router({
      [`alt:${PHONE_JID}`]: [[rec({ id: 'K1' })]],
      [`jid:${LID}`]: [[rec({ id: 'K9', jidAlt: null, ts: NOW - 60_000 })]],
    }),
  });
  const out = await learns.backfill.history(learns.lead(), { sinceTs: NOW - JOIN_HISTORY_MS });
  assert.equal(learns.lead().wa_lid, LID);
  assert.equal(learns.calls.length, 3);
  assert.deepEqual(learns.calls[2].where.key, { remoteJid: LID });
  assert.deepEqual(learns.ingested, ['K1', 'K9']);
  assert.equal(out.stored, 2);
  learns.s.close();

  const none = harness({ lead: { wa_lid: null } });
  await none.backfill.history(none.lead(), { sinceTs: NOW - JOIN_HISTORY_MS });
  assert.deepEqual(none.calls.map((c) => c.where.key), [{ remoteJidAlt: PHONE_JID }, { remoteJid: PHONE_JID }]);
  none.s.close();
});

test('a lid-only chat is asked for by its lid alone, here over the 30 days an owner join reads', async () => {
  const h = harness({
    lead: { phone_e164: null, wa_jid: null },
    serve: router({ [`jid:${LID}`]: [[rec({ id: 'K5', jidAlt: null })]] }),
  });
  const out = await h.backfill.history(h.lead(), { sinceTs: NOW - OWNER_HISTORY_MS, untilTs: NOW });
  assert.deepEqual(h.calls, [{
    where: { key: { remoteJid: LID }, messageTimestamp: { gte: '2026-08-29T12:00:00.000Z', lte: '2026-09-28T12:00:00.000Z' } },
    page: 1, offset: PAGE_SIZE,
  }]);
  assert.deepEqual(out, { stored: 1, scanned: 1, truncated: false });
  h.s.close();
});

test('paging follows the stated page count up to the cap, and says so — in counts — when a question has more', async () => {
  const pages = (n, prefix) => Array.from({ length: n }, (_, i) => [rec({ id: `${prefix}-${i}`, ts: NOW - 100_000 + i })]);
  const altPages = (h) => h.calls.filter((c) => c.where.key.remoteJidAlt).map((c) => c.page);

  const short = harness({ serve: router({ [`alt:${PHONE_JID}`]: pages(3, 'S') }) });
  assert.deepEqual(await short.backfill.history(short.lead(), { sinceTs: NOW - JOIN_HISTORY_MS }), { stored: 3, scanned: 3, truncated: false });
  assert.deepEqual(altPages(short), [1, 2, 3]);
  assert.equal(short.logs.some((e) => e.evt === 'inbox.backfill.truncated'), false);
  short.s.close();

  const long = harness({ serve: router({ [`alt:${PHONE_JID}`]: pages(12, 'L') }) });
  const out = await long.backfill.history(long.lead(), { sinceTs: NOW - JOIN_HISTORY_MS });
  assert.deepEqual(out, { stored: BACKFILL_MAX_PAGES, scanned: BACKFILL_MAX_PAGES, truncated: true });
  assert.deepEqual(altPages(long), Array.from({ length: BACKFILL_MAX_PAGES }, (_, i) => i + 1));
  assert.deepEqual(long.logs.find((e) => e.evt === 'inbox.backfill.truncated'), {
    level: 'warn', evt: 'inbox.backfill.truncated', leadId: LEAD_ID, clause: 'phone_alt', pages: 12, total: 12, maxPages: BACKFILL_MAX_PAGES,
  });
  assertClean(long.logs);
  long.s.close();

  // An answer that does not state its pages is read until a short page.
  const full = Array.from({ length: PAGE_SIZE }, (_, i) => rec({ id: `F-${i}`, ts: NOW - 500_000 + i }));
  const unsized = ({ where, page }) => {
    if (!where.key.remoteJidAlt) return { records: [], total: null, pages: null };
    return { records: page === 1 ? full : [rec({ id: 'F-last', ts: NOW - 600_000 })], total: null, pages: null };
  };
  const bare = harness({ serve: unsized });
  assert.deepEqual(await bare.backfill.history(bare.lead(), { sinceTs: NOW - JOIN_HISTORY_MS }), { stored: PAGE_SIZE + 1, scanned: PAGE_SIZE + 1, truncated: false });
  assert.deepEqual(altPages(bare), [1, 2]);
  bare.s.close();
  const capped = harness({ serve: unsized });
  assert.equal((await capped.backfill.history(capped.lead(), { sinceTs: NOW - JOIN_HISTORY_MS, maxPages: 1 })).truncated, true, 'a full last page may hide more');
  assert.deepEqual(altPages(capped), [1]);
  capped.s.close();
});

test('maxPages never goes past BACKFILL_MAX_PAGES, and a window that ends before it starts is refused', async () => {
  // A chat that always states more pages than anyone should read.
  const endless = ({ where, page }) => (where.key.remoteJidAlt
    ? { records: [rec({ id: `E-${page}`, ts: NOW - 100_000 + page })], total: 1_000, pages: 1_000 }
    : { records: [], total: 0, pages: 0 });
  for (const maxPages of [Infinity, 11, 0, -3, 1.5, Number.NaN, '3', null]) {
    const h = harness({ serve: endless });
    const out = await h.backfill.history(h.lead(), { sinceTs: NOW - JOIN_HISTORY_MS, maxPages });
    assert.deepEqual(out, { stored: BACKFILL_MAX_PAGES, scanned: BACKFILL_MAX_PAGES, truncated: true }, String(maxPages));
    assert.equal(h.calls.filter((c) => c.where.key.remoteJidAlt).length, BACKFILL_MAX_PAGES, String(maxPages));
    h.s.close();
  }
  const three = harness({ serve: endless });
  await three.backfill.history(three.lead(), { sinceTs: NOW - JOIN_HISTORY_MS, maxPages: 3 });
  assert.equal(three.calls.filter((c) => c.where.key.remoteJidAlt).length, 3);
  three.s.close();

  const inverted = harness({ serve: endless });
  assert.deepEqual(await inverted.backfill.history(inverted.lead(), { sinceTs: NOW, untilTs: NOW - 1 }), { error: 'bad_window' });
  assert.equal(inverted.calls.length, 0);
  assert.deepEqual(await inverted.backfill.history(inverted.lead(), { sinceTs: NOW, untilTs: NOW, maxPages: 1 }), { stored: 1, scanned: 1, truncated: true },
    'one instant is still a window');
  inverted.s.close();
});

test('groups and broadcasts are skipped whatever they carry', async () => {
  const h = harness({
    serve: router({
      [`alt:${PHONE_JID}`]: [[
        rec({ id: 'G1', jid: '120363135705763548@g.us' }),
        rec({ id: 'B1', jid: 'status@broadcast' }),
        rec({ id: 'K1' }),
      ]],
    }),
  });
  const out = await h.backfill.history(h.lead(), { sinceTs: NOW - JOIN_HISTORY_MS });
  assert.deepEqual(h.ingested, ['K1']);
  assert.deepEqual(out, { stored: 1, scanned: 3, truncated: false });
  h.s.close();
});

test('a record that does not answer the question asked is never stored, and the count of them is logged', async () => {
  // An Evolution that ignores the key filter (an upgrade that renames it, a proxy, a cache):
  // every question gets the same page, holding other people's private chats beside our own.
  const OTHER = '966511111111';
  const page = [
    rec({ id: 'K1' }),
    rec({ id: 'X-PHONE', jid: `${OTHER}@s.whatsapp.net`, jidAlt: null, text: 'private to someone else', pushName: 'Nour' }),
    rec({ id: 'X-LID', jid: '999888777666555@lid', jidAlt: `${OTHER}@s.whatsapp.net`, fromMe: true, text: 'also private' }),
  ];
  const ignoresKey = () => ({ records: page, total: page.length, pages: 1 });
  const needles = [OTHER, '999888777666555', 'Nour', 'private'];

  const h = harness({ serve: ignoresKey });
  const out = await h.backfill.history(h.lead(), { sinceTs: NOW - JOIN_HISTORY_MS });
  assert.deepEqual(out, { stored: 1, scanned: 9, truncated: false });
  assert.deepEqual(h.ingested, ['K1'], 'nothing of another chat reaches ingest');
  assert.deepEqual(h.inbox.messagesFor(LEAD_ID).map((m) => m.key_id), ['K1']);
  // K1 answers the remoteJidAlt and the lid questions; under remoteJid = phone jid it does not.
  assert.deepEqual(h.logs.filter((e) => e.evt === 'inbox.backfill.foreign'), [
    { level: 'warn', evt: 'inbox.backfill.foreign', leadId: LEAD_ID, clause: 'phone_alt', count: 2 },
    { level: 'warn', evt: 'inbox.backfill.foreign', leadId: LEAD_ID, clause: 'phone', count: 3 },
    { level: 'warn', evt: 'inbox.backfill.foreign', leadId: LEAD_ID, clause: 'lid', count: 2 },
  ]);
  assertClean(h.logs);
  for (const needle of needles) assert.equal(JSON.stringify(h.logs).includes(needle), false, needle);

  h.logs.length = 0;
  assert.deepEqual(await h.backfill.refresh(h.lead()), { stored: 0, scanned: 9, truncated: false });
  assert.deepEqual(h.inbox.messagesFor(LEAD_ID).map((m) => m.key_id), ['K1']);
  assert.equal(h.logs.filter((e) => e.evt === 'inbox.backfill.foreign').length, 3);
  h.s.close();

  // A record under the phone jid answers the remoteJidAlt question too: the normaliser drops
  // an alt equal to the jid, so such a record has no alt to compare.
  const same = harness({ serve: router({ [`alt:${PHONE_JID}`]: [[rec({ id: 'K7', jid: PHONE_JID, jidAlt: null })]] }) });
  assert.deepEqual(await same.backfill.history(same.lead(), { sinceTs: NOW - JOIN_HISTORY_MS }), { stored: 1, scanned: 1, truncated: false });
  assert.equal(same.logs.some((e) => e.evt === 'inbox.backfill.foreign'), false);
  same.s.close();
});

test('the two phone questions are stored together, oldest first: an older staff send is matched before a newer owner-phone line', async () => {
  const h = harness({
    serve: pool([
      // Typed on the owner's phone: filed under the lid, the client's phone as alt.
      rec({ id: 'OWN', fromMe: true, text: 'On my way', ts: NOW - 30_000 }),
      // A dashboard reply whose send came back uncertain: filed under the phone jid.
      rec({ id: 'API', jid: PHONE_JID, jidAlt: null, fromMe: true, text: 'Welcome', ts: NOW - 60_000 }),
    ]),
  });
  const staff = h.team.addUser({ name: 'Mona Staff', phone: '0500000009', role: 'staff' });
  h.tick(-70_000); // the send was written just before WhatsApp stamped it
  h.inbox.insertOutbox({
    send_id: 'SND-0000000000000001', lead_id: LEAD_ID, jid: PHONE_JID, text: 'Welcome', user_id: staff.user_id, sender_kind: 'staff', status: 'uncertain',
  });
  h.tick(70_000);
  await h.backfill.history(h.lead(), { sinceTs: NOW - JOIN_HISTORY_MS });
  assert.deepEqual(h.ingested, ['API', 'OWN']);
  const stored = Object.fromEntries(h.inbox.messagesFor(LEAD_ID).map((m) => [m.key_id, m.sender_kind]));
  assert.deepEqual(stored, { API: 'staff', OWN: 'owner_number' });
  assert.equal(h.lead().handler_user_id, staff.user_id, 'the first human to answer is the handler');
  h.s.close();
});

test('refresh reads only from 24 h before the chat joined: every question carries the window, nothing older is stored', async () => {
  const h = harness({
    serve: pool([
      // Private conversation from before the chat had anything to do with Bona.
      rec({ id: 'OLD', ts: FLOOR - 60_000 }),
      rec({ id: 'EDGE', ts: FLOOR }),
      rec({ id: 'NEW', ts: NOW - 60_000 }),
      // Sent through the API to the phone number: filed under the phone jid itself.
      rec({ id: 'API', jid: PHONE_JID, jidAlt: null, fromMe: true, text: 'Welcome', ts: NOW - 30_000 }),
    ]),
  });
  const out = await h.backfill.refresh(h.lead());
  assert.equal(Date.parse(SINCE_JOIN.gte), FLOOR);
  assert.deepEqual(h.calls, [
    { where: { key: { remoteJidAlt: PHONE_JID }, messageTimestamp: SINCE_JOIN }, page: 1, offset: REFRESH_LIMIT, timeoutMs: 2_500 },
    { where: { key: { remoteJid: PHONE_JID }, messageTimestamp: SINCE_JOIN }, page: 1, offset: REFRESH_LIMIT, timeoutMs: 2_500 },
    { where: { key: { remoteJid: LID }, messageTimestamp: SINCE_JOIN }, page: 1, offset: REFRESH_LIMIT, timeoutMs: 2_500 },
  ]);
  assert.deepEqual(out, { stored: 3, scanned: 5, truncated: false });
  assert.deepEqual(h.ingested, ['EDGE', 'NEW', 'API']);
  assert.deepEqual(h.inbox.messagesFor(LEAD_ID).map((m) => m.key_id), ['EDGE', 'NEW', 'API'], 'OLD never reaches the store');
  h.s.close();
});

test('the floor never reaches past the retention horizon, and is 24 h before now for a row with no join time', async () => {
  const old = harness({ lead: { inbox_since: NOW - 6 * 365 * 86_400_000 } });
  await old.backfill.refresh(old.lead());
  const horizon = { gte: new Date(NOW - RETENTION_MS).toISOString(), lte: SINCE_JOIN.lte };
  assert.deepEqual(old.calls.map((c) => c.where.messageTimestamp), [horizon, horizon, horizon],
    'a transcript the five-year purge emptied is not stored again');
  old.s.close();

  const unset = harness({ lead: { inbox_since: null } });
  await unset.backfill.refresh(unset.lead());
  assert.deepEqual(unset.calls.map((c) => c.where.messageTimestamp), [DAY, DAY, DAY]);
  unset.s.close();
});

test('a long chat is read for its newest 50 per question, and that is not truncation news', async () => {
  const many = Array.from({ length: REFRESH_LIMIT + 1 }, (_, i) => rec({ id: `R-${i}`, ts: NOW - 100_000 + i }));
  const h = harness({ serve: pool(many) });
  const out = await h.backfill.refresh(h.lead());
  assert.deepEqual(out, { stored: REFRESH_LIMIT, scanned: 2 * REFRESH_LIMIT, truncated: true });
  const stored = h.inbox.messagesFor(LEAD_ID);
  assert.equal(stored.length, REFRESH_LIMIT);
  assert.equal(stored[0].key_id, 'R-1', 'the 51st newest is not fetched');
  assert.equal(h.logs.some((e) => e.evt === 'inbox.backfill.truncated'), false, 'reading only the newest page is the point');
  h.s.close();
});

test('a second refresh within 5 s asks nothing; at 5 s it reads again; 1,000 chats are remembered, the stalest forgotten', async () => {
  const h = harness();
  assert.deepEqual(await h.backfill.refresh(h.lead()), { stored: 0, scanned: 0, truncated: false });
  assert.equal(h.calls.length, 3);
  h.tick(4_999);
  assert.deepEqual(await h.backfill.refresh(h.lead()), { skipped: 'recent' });
  assert.equal(h.calls.length, 3, 'the thread page and the reply right after it: one read');
  h.tick(1);
  assert.deepEqual(await h.backfill.refresh(h.lead()), { stored: 0, scanned: 0, truncated: false });
  assert.equal(h.calls.length, 6);
  await h.backfill.refresh(h.lead(), { minIntervalMs: 0 });
  assert.equal(h.calls.length, 9, 'a caller may ask for no pause');

  // 1,000 other chats refreshed since (no phone and no lid, so nothing is asked for them):
  // this one is forgotten, and is read again at once.
  for (let i = 0; i < 1_000; i += 1) {
    const id = `LEAD-20260928-${String(i).padStart(8, '0')}`;
    h.s.insertLead({ lead_id: id, created: NOW, updated: NOW, channel: 'whatsapp', match_method: 'ref', stage: 'new', inbox_state: 'in', inbox_since: NOW });
    await h.backfill.refresh({ lead_id: id });
  }
  assert.equal(h.calls.length, 9);
  await h.backfill.refresh(h.lead());
  assert.equal(h.calls.length, 12);
  h.s.close();
});

test('refresh keeps to its budget: each question waits at most 2.5 s or what is left, and a spent budget skips the rest', async () => {
  const answer = pool([
    rec({ id: 'K1' }),
    rec({ id: 'API', jid: PHONE_JID, jidAlt: null, fromMe: true, text: 'Welcome', ts: NOW - 30_000 }),
  ]);
  // Evolution takes 1.5 s over every question.
  const slow = harness({ serve: (q, { tick }) => { tick(1_500); return answer(q); } });
  const out = await slow.backfill.refresh(slow.lead());
  assert.deepEqual(slow.calls.map((c) => [c.where.key, c.timeoutMs]), [
    [{ remoteJidAlt: PHONE_JID }, 2_500],
    [{ remoteJid: PHONE_JID }, 1_500],
  ], 'the lid question was never asked');
  assert.deepEqual(out, { stored: 2, scanned: 2, truncated: false, partial: true });
  assert.equal(slow.now() - NOW, 3_000, 'the page waited no longer than the budget');
  assert.deepEqual(slow.logs.find((e) => e.evt === 'inbox.refresh.partial'), {
    level: 'warn', evt: 'inbox.refresh.partial', leadId: LEAD_ID, budgetMs: 3_000,
  });
  assertClean(slow.logs);
  slow.s.close();

  const tight = harness({ serve: (q, { tick }) => { tick(1_000); return answer(q); } });
  assert.deepEqual(await tight.backfill.refresh(tight.lead(), { budgetMs: 1_000 }), { stored: 1, scanned: 1, truncated: false, partial: true });
  assert.deepEqual(tight.calls.map((c) => c.timeoutMs), [1_000]);
  tight.s.close();
});

/**
 * Evolution taking `latency` over every question, the way lib/evolution.mjs meets it: a
 * question whose own timeout comes first is aborted there and thrown as a timeout.
 */
const slowEvolution = (latency, answer) => (q, { tick }) => {
  if (latency > q.timeoutMs) {
    tick(q.timeoutMs);
    throw new EvolutionError('POST /chat/findMessages/abdulaziz-personal failed: timeout', 0, null);
  }
  tick(latency);
  return answer(q);
};

test('a refresh question that runs out of time makes the read partial, keeps what earlier questions brought, and never fails it', async () => {
  const answer = pool([
    rec({ id: 'K1' }),
    rec({ id: 'API', jid: PHONE_JID, jidAlt: null, fromMe: true, text: 'Welcome', ts: NOW - 30_000 }),
  ]);
  // 1.6 s a question: the first answers; the second has 1.4 s left and is cut off there.
  const cut = harness({ serve: slowEvolution(1_600, answer) });
  assert.deepEqual(await cut.backfill.refresh(cut.lead()), { stored: 1, scanned: 1, truncated: false, partial: true });
  assert.deepEqual(cut.calls.map((c) => [c.where.key, c.timeoutMs]), [
    [{ remoteJidAlt: PHONE_JID }, 2_500],
    [{ remoteJid: PHONE_JID }, 1_400],
  ]);
  assert.equal(cut.now() - NOW, 3_000);
  assert.deepEqual(cut.inbox.messagesFor(LEAD_ID).map((m) => m.key_id), ['K1']);
  assert.deepEqual(cut.logs.find((e) => e.evt === 'inbox.refresh.partial'), {
    level: 'warn', evt: 'inbox.refresh.partial', leadId: LEAD_ID, budgetMs: 3_000,
  });
  assert.equal(cut.logs.some((e) => e.evt === 'inbox.backfill.failed'), false);
  assertClean(cut.logs);
  cut.s.close();

  // 2.8 s a question: the first is cut at its 2.5 s cap, the next gets the 0.5 s still left.
  const capped = harness({ serve: slowEvolution(2_800, answer) });
  assert.deepEqual(await capped.backfill.refresh(capped.lead()), { stored: 0, scanned: 0, truncated: false, partial: true });
  assert.deepEqual(capped.calls.map((c) => c.timeoutMs), [2_500, 500]);
  assert.equal(capped.now() - NOW, 3_000);
  capped.s.close();

  // A history read has no budget: a timeout there is a failed read, as before.
  const joined = harness({ serve: (q) => { if (q.where.key.remoteJid === PHONE_JID) throw new EvolutionError('POST /chat/findMessages/abdulaziz-personal failed: timeout', 0, null); return answer(q); } });
  assert.deepEqual(await joined.backfill.history(joined.lead(), { sinceTs: NOW - JOIN_HISTORY_MS }), { error: 'timeout' });
  assert.deepEqual(joined.inbox.messagesFor(LEAD_ID).map((m) => m.key_id), ['K1'], 'what the first question brought is kept');
  joined.s.close();
});

test('a chat outside the inbox, an unknown lead, or no Evolution configured: nothing is read', async () => {
  const unsure = harness({ lead: { inbox_state: 'unsure' } });
  const skip = { stored: 0, scanned: 0, truncated: false };
  assert.deepEqual(await unsure.backfill.history(unsure.lead(), { sinceTs: NOW - JOIN_HISTORY_MS }), { ...skip, skipped: 'not_in_inbox' });
  assert.deepEqual(await unsure.backfill.refresh(unsure.lead()), { ...skip, skipped: 'not_in_inbox' });
  assert.deepEqual(await unsure.backfill.refresh({ lead_id: 'LEAD-20260928-00000000' }), { ...skip, skipped: 'not_found' });
  assert.deepEqual(await unsure.backfill.refresh(null), { ...skip, skipped: 'not_found' });
  assert.equal(unsure.calls.length, 0);
  unsure.s.close();

  const fetched = [];
  const off = harness({ injectFind: false, env: {}, fetchImpl: async (...args) => { fetched.push(args); throw new Error('must not be called'); } });
  assert.equal(off.backfill.configured, false);
  assert.deepEqual(await off.backfill.history(off.lead(), { sinceTs: NOW - JOIN_HISTORY_MS }), { ...skip, skipped: 'not_configured' });
  assert.deepEqual(await off.backfill.refresh(off.lead()), { ...skip, skipped: 'not_configured' });
  assert.equal(fetched.length, 0);
  off.s.close();
});

test('a failed read never throws: it comes back as { error } and logs inbox.backfill.failed without numbers', async () => {
  const throwing = (err) => () => { throw err; };
  const cases = [
    [new Error(`boom for ${PHONE_JID} and ${LID}`), 'failed'],
    [new EvolutionError('POST /chat/findMessages/abdulaziz-personal -> HTTP 500', 500, { detail: PHONE }), 'http_500'],
    [new EvolutionError('POST /chat/findMessages/abdulaziz-personal failed: network', 0, null), 'network'],
    [new EvolutionError('POST /chat/findMessages/abdulaziz-personal failed: timeout', 0, null), 'timeout'],
    // A 2xx whose body broke off while it was read, or was not an answer.
    [new EvolutionError('POST /chat/findMessages/abdulaziz-personal failed: timeout', 200, null), 'timeout'],
    [new EvolutionError('POST /chat/findMessages/abdulaziz-personal failed: network', 200, null), 'network'],
    [new EvolutionError('POST /chat/findMessages/abdulaziz-personal -> HTTP 200 but the answer is not JSON', 200, null), 'http_200'],
    // An instance whose name says "timeout" does not turn an HTTP error into one.
    [new EvolutionError('POST /chat/findMessages/timeout-test -> HTTP 502', 502, null), 'http_502'],
  ];
  for (const [err, code] of cases) {
    const h = harness({ serve: throwing(err) });
    assert.deepEqual(await h.backfill.history(h.lead(), { sinceTs: NOW - JOIN_HISTORY_MS }), { error: code });
    // A refresh that runs out of time is partial, not failed (see the budget tests).
    assert.deepEqual(await h.backfill.refresh(h.lead()),
      code === 'timeout' ? { stored: 0, scanned: 0, truncated: false, partial: true } : { error: code });
    const failures = h.logs.filter((e) => e.evt === 'inbox.backfill.failed');
    assert.equal(failures.length, code === 'timeout' ? 1 : 2, code);
    assert.deepEqual([failures[0].leadId, failures[0].error, failures[0].level], [LEAD_ID, code, 'warn']);
    assertClean(h.logs);
    assert.equal(JSON.stringify(h.logs).includes('boom'), false, 'the thrown message is not logged');
    h.s.close();
  }

  // A store failure inside ingest is caught the same way.
  const broken = harness({
    serve: router({ [`alt:${PHONE_JID}`]: [[rec()]] }),
    ingest: () => { throw new Error(`SQLITE_BUSY while storing ${PHONE}`); },
  });
  assert.deepEqual(await broken.backfill.history(broken.lead(), { sinceTs: NOW - JOIN_HISTORY_MS }), { error: 'failed' });
  assertClean(broken.logs);
  broken.s.close();

  // An error's name is logged only when it is one of the kinds this code meets: an injected
  // one could carry anything.
  const named = (name) => Object.assign(new Error('boom'), { name });
  for (const [err, name] of [
    [new TypeError('boom'), 'TypeError'], [new RangeError('boom'), 'RangeError'], [named('SqliteError'), 'SqliteError'],
    [named(`Error for ${PHONE}`), undefined], [named(`Sara${'Error'}`), undefined], [named({ toString: () => PHONE }), undefined],
  ]) {
    const h = harness({ serve: throwing(err) });
    assert.deepEqual(await h.backfill.history(h.lead(), { sinceTs: NOW - JOIN_HISTORY_MS }), { error: 'failed' });
    assert.equal(h.logs.find((e) => e.evt === 'inbox.backfill.failed').name, name);
    assertClean(h.logs);
    h.s.close();
  }

  // A logger that throws never makes a read throw.
  const angry = () => { throw new Error('log sink down'); };
  const loud = harness({ serve: throwing(new EvolutionError('POST /chat/findMessages/abdulaziz-personal failed: network', 0, null)), logImpl: angry });
  assert.deepEqual(await loud.backfill.history(loud.lead(), { sinceTs: NOW - JOIN_HISTORY_MS }), { error: 'network' });
  assert.deepEqual(await loud.backfill.refresh(loud.lead()), { error: 'network' });
  assert.deepEqual(await loud.backfill.history(loud.lead()), { error: 'bad_window' });
  loud.s.close();
  const pages = Array.from({ length: 12 }, (_, i) => [rec({ id: `L-${i}`, ts: NOW - 100_000 + i })]);
  const loudOk = harness({ serve: router({ [`alt:${PHONE_JID}`]: pages }), logImpl: angry });
  assert.deepEqual(await loudOk.backfill.history(loudOk.lead(), { sinceTs: NOW - JOIN_HISTORY_MS }), { stored: BACKFILL_MAX_PAGES, scanned: BACKFILL_MAX_PAGES, truncated: true },
    'a truncation note that cannot be logged does not stop the read');
  loudOk.s.close();

  // A window that is not two times is refused before anything is asked.
  const window = harness();
  assert.deepEqual(await window.backfill.history(window.lead()), { error: 'bad_window' });
  assert.deepEqual(await window.backfill.history(window.lead(), { sinceTs: NOW - JOIN_HISTORY_MS, untilTs: 'now' }), { error: 'bad_window' });
  assert.equal(window.calls.length, 0);
  window.s.close();
});

test('default wiring: the real findMessages request body, answered and stored through the normaliser', async () => {
  const requests = [];
  const raw = {
    key: { id: 'WIRE-1', fromMe: false, remoteJid: LID, remoteJidAlt: PHONE_JID },
    pushName: 'Sara', messageType: 'conversation',
    message: { conversation: 'Hello from the site' },
    messageTimestamp: Math.floor((NOW - 60_000) / 1000),
  };
  const fetchImpl = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const first = requests.length === 1;
    const body = { messages: { total: first ? 1 : 0, pages: first ? 1 : 0, currentPage: 1, records: first ? [raw] : [] } };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const h = harness({ injectFind: false, env: { EVOLUTION_API_URL: 'http://evo.test/', EVOLUTION_API_KEY: 'k' }, fetchImpl });
  assert.equal(h.backfill.configured, true);
  assert.deepEqual(await h.backfill.history(h.lead(), { sinceTs: NOW - JOIN_HISTORY_MS }), { stored: 1, scanned: 1, truncated: false });
  assert.equal(requests.length, 3);
  assert.equal(requests[0].url, 'http://evo.test/chat/findMessages/abdulaziz-personal');
  assert.equal(requests[0].headers.apikey, 'k');
  assert.deepEqual(requests[0].body, { where: { key: { remoteJidAlt: PHONE_JID }, messageTimestamp: DAY }, page: 1, offset: PAGE_SIZE });
  assert.deepEqual(requests[1].body.where.key, { remoteJid: PHONE_JID });
  assert.deepEqual(requests[2].body.where.key, { remoteJid: LID });
  const [m] = h.inbox.messagesFor(LEAD_ID);
  assert.deepEqual([m.key_id, m.text, m.ts, m.sender_kind], ['WIRE-1', 'Hello from the site', NOW - 60_000, 'client']);

  requests.length = 0;
  await h.backfill.refresh(h.lead());
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0].body, { where: { key: { remoteJidAlt: PHONE_JID }, messageTimestamp: SINCE_JOIN }, page: 1, offset: REFRESH_LIMIT });
  assert.ok(requests.every((r) => r.body.where.messageTimestamp.gte === SINCE_JOIN.gte), 'no request reaches before the floor');
  h.s.close();
});
