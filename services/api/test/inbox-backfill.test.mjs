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
function harness({ serve = router({}), lead = {}, env = {}, injectFind = true, fetchImpl = undefined, ingest = undefined } = {}) {
  const s = openDb(':memory:');
  let clock = NOW;
  const tick = (ms) => { clock += ms; };
  const team = createTeam(s, { now: () => clock });
  const owner = team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const inbox = createInboxStore(s, { now: () => clock });
  const logs = [];
  const log = (o) => logs.push(o);
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
  return { s, inbox, backfill, calls, ingested, logs, tick, now: () => clock, lead: () => s.getLead(LEAD_ID) };
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
  assert.deepEqual(h.ingested, ['K1', 'K2', 'K3', 'K4'], 'each id once, oldest first within each question');
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
  ];
  for (const [err, code] of cases) {
    const h = harness({ serve: throwing(err) });
    assert.deepEqual(await h.backfill.history(h.lead(), { sinceTs: NOW - JOIN_HISTORY_MS }), { error: code });
    assert.deepEqual(await h.backfill.refresh(h.lead()), { error: code });
    const failures = h.logs.filter((e) => e.evt === 'inbox.backfill.failed');
    assert.equal(failures.length, 2, code);
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
