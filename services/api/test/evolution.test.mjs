/**
 * The Evolution read client. The real API is never contacted: every test drives a
 * stub `fetch`. Response shapes are the ones the live instance `abdulaziz-personal`
 * answered with on 2026-09-05 (see services/intake/test/evolution.test.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EvolutionError, MAX_PAGES, MAX_SPLIT_DEPTH, PAGE_SIZE, bareJid, contextOf, fetchWindow,
  findMessagesPage, findMessagesWindow, isNoise, mediaOf, normaliseRecord, oldestFirst,
  readWindow, recordsOf, textOf, toMs,
} from '../lib/evolution.mjs';
import { isTkDocument, namesBona, namesTk, ownerOutboundJoins } from '../lib/inbox/eligibility.mjs';

const GTE = Date.UTC(2026, 8, 6, 11, 58, 0);
const LTE = Date.UTC(2026, 8, 6, 12, 0, 0);
const OPTS = { baseUrl: 'https://wa-api.example/', apiKey: 'evo-key', instance: 'abdulaziz-personal', gte: GTE, lte: LTE };

/** A record as Evolution wraps it: `{ messages: { records: [...] } }`. */
const boxed = (records) => ({ messages: { total: records.length, pages: 1, currentPage: 1, records } });

const textRecord = (over = {}) => ({
  id: 'row-1',
  key: { id: 'KEY1', fromMe: false, remoteJid: '966500000000@s.whatsapp.net' },
  pushName: 'Sara',
  messageType: 'conversation',
  message: { conversation: 'Hello Bona', messageContextInfo: {} },
  messageTimestamp: Math.floor(LTE / 1000) - 30,
  ...over,
});

/** A fetch double: records every call, answers from a queue (last answer repeats). */
function recorder(responses = [{ status: 200, body: boxed([]) }]) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (r.throw) throw Object.assign(new Error('boom'), { name: r.throw });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
  return { fetchImpl, calls };
}

/* ---------------- the request ---------------- */

test('findMessagesWindow posts the window body Evolution 2.3.7 actually honours', async () => {
  const { fetchImpl, calls } = recorder([{ status: 200, body: boxed([textRecord()]) }]);
  await findMessagesWindow({ ...OPTS, fetchImpl });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://wa-api.example/chat/findMessages/abdulaziz-personal');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.apikey, 'evo-key', 'the key rides in the apikey header, never in the URL');
  assert.deepEqual(calls[0].body, {
    where: { messageTimestamp: { gte: new Date(GTE).toISOString(), lte: new Date(LTE).toISOString() } },
    page: 1,
    offset: PAGE_SIZE,
  });
  // The server ignores a fromMe filter, so sending one would only be a lie in the log.
  assert.equal('key' in calls[0].body.where, false);
});

test('both bounds are required — the timestamp filter is ignored without them', async () => {
  const { fetchImpl, calls } = recorder();
  await assert.rejects(() => findMessagesWindow({ ...OPTS, lte: null, fetchImpl }), TypeError);
  await assert.rejects(() => findMessagesWindow({ ...OPTS, gte: undefined, fetchImpl }), TypeError);
  // The message comes from `toIso`, which turns every bound into what is sent (readWindow's
  // too, after readWindow's own check of both bounds), so it names no caller.
  await assert.rejects(() => findMessagesWindow({ ...OPTS, lte: 'soon', fetchImpl }), { name: 'TypeError', message: 'evolution: both gte and lte are required' });
  assert.equal(calls.length, 0, 'a half-open window is never sent');
});

test('an HTTP error becomes an EvolutionError carrying the status; a network failure is status 0', async () => {
  const bad = recorder([{ status: 401, body: { status: 401, error: 'Unauthorized' } }]);
  await assert.rejects(() => findMessagesWindow({ ...OPTS, fetchImpl: bad.fetchImpl }), (err) => {
    assert.ok(err instanceof EvolutionError);
    assert.equal(err.status, 401);
    return true;
  });

  const down = recorder([{ throw: 'TypeError' }]);
  await assert.rejects(() => findMessagesWindow({ ...OPTS, fetchImpl: down.fetchImpl }), (err) => {
    assert.ok(err instanceof EvolutionError);
    assert.equal(err.status, 0);
    return true;
  });
});

/* ---------------- the two response shapes ---------------- */

test('records are read from { messages: { records } } and from a bare array alike', async () => {
  const boxedFetch = recorder([{ status: 200, body: boxed([textRecord()]) }]);
  const one = await findMessagesWindow({ ...OPTS, fetchImpl: boxedFetch.fetchImpl });
  assert.equal(one.records.length, 1);
  assert.equal(one.records[0].id, 'KEY1');

  const bareFetch = recorder([{ status: 200, body: [textRecord({ key: { id: 'KEY2', fromMe: false, remoteJid: '966500000001@s.whatsapp.net' } })] }]);
  const two = await findMessagesWindow({ ...OPTS, fetchImpl: bareFetch.fetchImpl });
  assert.equal(two.records.length, 1);
  assert.equal(two.records[0].id, 'KEY2');

  assert.deepEqual(recordsOf(null), []);
  assert.deepEqual(recordsOf({ messages: {} }), []);
});

/* ---------------- normalisation ---------------- */

test('timestamps arrive as seconds, milliseconds, numeric strings, ISO or a Baileys Long', () => {
  assert.equal(toMs(1_788_318_317), 1_788_318_317_000);
  assert.equal(toMs('1788318317'), 1_788_318_317_000);
  assert.equal(toMs(1_788_318_317_000), 1_788_318_317_000);
  assert.equal(toMs('2026-09-06T12:00:00.000Z'), Date.UTC(2026, 8, 6, 12, 0, 0));
  assert.equal(toMs({ low: 1_788_318_317, high: 0, unsigned: true }), 1_788_318_317_000);
  assert.equal(toMs(null), null);
  assert.equal(toMs('not a date'), null);
  assert.equal(toMs(0), null);
});

test('a text message flattens to the shape the poller reasons about', () => {
  const rec = normaliseRecord(textRecord());
  assert.deepEqual(rec, {
    id: 'KEY1',
    jid: '966500000000@s.whatsapp.net',
    jidAlt: null,
    fromMe: false,
    ts: (Math.floor(LTE / 1000) - 30) * 1000,
    text: 'Hello Bona',
    pushName: 'Sara',
    contextInfo: null,
    messageType: 'conversation',
    media: null,
    fileName: null,
    fileNameTruncated: false,
    fileNameTk: false,
    fileNameBona: false,
    noise: false,
  });
});

test('an @lid chat keeps both jids and survives a null pushName', () => {
  const rec = normaliseRecord(textRecord({
    key: { id: 'KEY3', fromMe: false, remoteJid: '272516946294519@lid', remoteJidAlt: '966500000000@s.whatsapp.net' },
    pushName: null,
  }));
  assert.equal(rec.jid, '272516946294519@lid');
  assert.equal(rec.jidAlt, '966500000000@s.whatsapp.net');
  assert.equal(rec.pushName, null);
});

test('the text is read from conversation, extendedTextMessage, a caption or an ephemeral wrapper', () => {
  assert.equal(textOf({ message: { conversation: 'plain' } }), 'plain');
  assert.equal(textOf({ message: { extendedTextMessage: { text: 'extended' } } }), 'extended');
  assert.equal(textOf({ message: { imageMessage: { caption: 'a caption' } } }), 'a caption');
  assert.equal(textOf({ message: { ephemeralMessage: { message: { conversation: 'disappearing' } } } }), 'disappearing');
  assert.equal(textOf({ message: {} }), '');
  assert.equal(textOf(null), '');
});

test('the ad context is found on the message part that carries it, or at the top level', () => {
  const inner = { externalAdReply: { sourceId: '120210', ctwaClid: 'ARZ1', sourceApp: 'instagram' } };
  assert.deepEqual(contextOf({ message: { extendedTextMessage: { text: 'hi', contextInfo: inner } } }), inner);
  assert.deepEqual(contextOf({ message: { imageMessage: { caption: 'hi', contextInfo: inner } } }), inner);
  assert.deepEqual(contextOf({ message: { conversation: 'hi' }, contextInfo: inner }), inner);
  assert.equal(contextOf({ message: { conversation: 'hi' } }), null);
  // `messageContextInfo` is device metadata, not this: a plain message has no ad context.
  assert.equal(contextOf({ message: { conversation: 'hi', messageContextInfo: { deviceListMetadata: {} } } }), null);
});

test('bareJid strips the device suffix and the domain', () => {
  assert.equal(bareJid('966593296933:12@s.whatsapp.net'), '966593296933');
  assert.equal(bareJid('120363143519616993@g.us'), '120363143519616993');
  assert.equal(bareJid(null), '');
});

test('oldestFirst reverses what Evolution hands over, and puts records with no clock last', () => {
  const recs = [{ id: 'c', ts: 300 }, { id: 'b', ts: 200 }, { id: 'a', ts: 100 }];
  assert.deepEqual(oldestFirst(recs).map((r) => r.id), ['a', 'b', 'c']);
  // Timestamps and no-timestamps in one batch: the dated ones order by date, the rest
  // follow in reversed API order. Never a mix of the two rules.
  assert.deepEqual(
    oldestFirst([{ id: 'n2', ts: null }, { id: 'c', ts: 300 }, { id: 'n1', ts: undefined }, { id: 'a', ts: 100 }]).map((r) => r.id),
    ['a', 'c', 'n1', 'n2'],
  );
  assert.deepEqual(oldestFirst([{ id: 'y', ts: null }, { id: 'x', ts: null }]).map((r) => r.id), ['x', 'y']);
  assert.deepEqual(oldestFirst([]), []);
  assert.deepEqual(oldestFirst(null), []);
});

/* ---------------- paging ---------------- */

test('fetchWindow pages while a page comes back full and stops at the 5-page cap', async () => {
  const full = (n) => boxed(Array.from({ length: 3 }, (_, i) => textRecord({ key: { id: `P${n}-${i}`, fromMe: false, remoteJid: '966500000000@s.whatsapp.net' } })));
  const { fetchImpl, calls } = recorder([{ status: 200, body: full(1) }, { status: 200, body: full(2) }, { status: 200, body: full(3) },
    { status: 200, body: full(4) }, { status: 200, body: full(5) }, { status: 200, body: full(6) }]);

  const out = await fetchWindow({ ...OPTS, offset: 3, fetchImpl });
  assert.equal(out.pages, MAX_PAGES);
  assert.equal(out.truncated, true);
  assert.equal(calls.length, MAX_PAGES, 'never more than five requests for one window');
  assert.deepEqual(calls.map((c) => c.body.page), [1, 2, 3, 4, 5]);
  assert.equal(out.records.length, 15);
});

test('fetchWindow stops on the first short page and drops ids seen twice', async () => {
  const page1 = boxed([textRecord({ key: { id: 'A', fromMe: false, remoteJid: '966500000000@s.whatsapp.net' } }),
    textRecord({ key: { id: 'B', fromMe: false, remoteJid: '966500000000@s.whatsapp.net' } })]);
  // The window keeps moving under a poll, so the same message can come back on page 2.
  const page2 = boxed([textRecord({ key: { id: 'B', fromMe: false, remoteJid: '966500000000@s.whatsapp.net' } })]);
  const { fetchImpl, calls } = recorder([{ status: 200, body: page1 }, { status: 200, body: page2 }]);

  const out = await fetchWindow({ ...OPTS, offset: 2, fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(out.truncated, false);
  assert.deepEqual(out.records.map((r) => r.id), ['A', 'B']);
});

/* ---------------- Phase 2: reads with any filter, and no silent loss ---------------- */

const BASE = { baseUrl: 'https://wa-api.example/', apiKey: 'evo-key', instance: 'abdulaziz-personal' };
const T0 = Date.UTC(2026, 8, 28, 9, 0, 0);
const S0 = T0 / 1000;
const CLIENT = '966500000000@s.whatsapp.net';
const iso = (ms) => new Date(ms).toISOString();

/** A stored record as Evolution keeps it: `messageTimestamp` in whole seconds. */
const stored = (id, sec, key = {}) => ({
  key: { id, fromMe: false, remoteJid: CLIENT, ...key },
  messageType: 'conversation',
  message: { conversation: 'hi' },
  messageTimestamp: sec,
});

/**
 * A stand-in for the live instance, answering `POST /chat/findMessages` the way Evolution
 * 2.3.7 does: both time bounds cut down to whole seconds and inclusive (and only applied
 * when both are given), `key.remoteJid` matched exactly (or, without it, `key.remoteJidAlt`),
 * newest first, `offset` records per page from `page` 1 — boxed as
 * `{ messages: { total, pages, currentPage, records } }`, or a bare array when `bare`.
 *
 * Evolution orders by `messageTimestamp` alone and pages with LIMIT/OFFSET, and PostgreSQL
 * does not keep records that share a second in one order across different LIMIT/OFFSET
 * values (a top-N heapsort orders ties differently for N = 100 and N = 200). `unstable`
 * plays that at its worst: ties come in id order when skip + take is an odd number of pages,
 * in reverse id order when it is an even one — so a same-second group that straddles a page
 * boundary comes back partly twice and partly never. Without it, ties keep one order.
 */
function fakeEvolution(records, { bare = false, unstable = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const { where = {}, page = 1, offset = 50 } = body;
    const w = where.messageTimestamp;
    const both = Boolean(w?.gte && w?.lte);
    const lo = both ? Math.floor(Date.parse(w.gte) / 1000) : -Infinity;
    const hi = both ? Math.floor(Date.parse(w.lte) / 1000) : Infinity;
    const key = where.key ?? {};
    const topN = offset * page; // skip + take: how many rows the query has to order
    const tieSign = (topN / offset) % 2 === 1 ? 1 : -1;
    const byId = (a, b) => tieSign * (a.r.key.id < b.r.key.id ? -1 : a.r.key.id > b.r.key.id ? 1 : 0);
    const hits = records
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.messageTimestamp >= lo && r.messageTimestamp <= hi)
      .filter(({ r }) => (key.remoteJid ? r.key.remoteJid === key.remoteJid
        : !key.remoteJidAlt || r.key.remoteJidAlt === key.remoteJidAlt))
      .sort((a, b) => b.r.messageTimestamp - a.r.messageTimestamp || (unstable ? byId(a, b) : b.i - a.i))
      .map(({ r }) => r);
    const slice = hits.slice(offset * (page - 1), offset * page);
    const payload = bare ? slice
      : { messages: { total: hits.length, pages: Math.ceil(hits.length / offset), currentPage: page, records: slice } };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  return { fetchImpl, calls };
}

/** `[from - T0, to - T0, page]` for every request — which piece was read, in what order. */
const asked = (calls) => calls.map((c) => [
  Date.parse(c.body.where.messageTimestamp.gte) - T0,
  Date.parse(c.body.where.messageTimestamp.lte) - T0,
  c.body.page,
]);
/** Ids `M<to>` down to `M<from>`: one piece as Evolution hands it over, newest first. */
const desc = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, k) => `${prefix}${to - k}`);

test('findMessagesPage sends any where filter as given and reads total and pages off the boxed answer', async () => {
  const evo = fakeEvolution([
    stored('A', S0 + 1),
    stored('B', S0 + 2, { remoteJid: '272516946294519@lid', remoteJidAlt: '966500000001@s.whatsapp.net' }),
    stored('C', S0 + 3),
  ]);
  const one = await findMessagesPage({ ...BASE, where: { key: { remoteJid: CLIENT } }, offset: 1, fetchImpl: evo.fetchImpl });
  assert.equal(evo.calls[0].url, 'https://wa-api.example/chat/findMessages/abdulaziz-personal');
  assert.equal(evo.calls[0].headers.apikey, 'evo-key');
  assert.deepEqual(evo.calls[0].body, { where: { key: { remoteJid: CLIENT } }, page: 1, offset: 1 });
  assert.deepEqual(one.records.map((r) => r.id), ['C'], 'one chat only, newest first');
  assert.equal(one.total, 2, 'the size of everything the filter matched, not of this page');
  assert.equal(one.pages, 2);
  assert.equal(one.raw.messages.currentPage, 1);

  const alt = await findMessagesPage({ ...BASE, where: { key: { remoteJidAlt: '966500000001@s.whatsapp.net' } }, page: 1, fetchImpl: evo.fetchImpl });
  assert.equal(evo.calls[1].body.offset, PAGE_SIZE);
  assert.deepEqual(alt.records.map((r) => r.id), ['B'], 'a lid chat found through its phone jid');
  assert.equal(alt.records[0].jid, '272516946294519@lid');

  const both = await findMessagesPage({
    ...BASE, fetchImpl: evo.fetchImpl,
    where: { key: { remoteJid: CLIENT }, messageTimestamp: { gte: iso(T0), lte: iso(T0 + 2000) } },
  });
  assert.deepEqual(both.records.map((r) => r.id), ['A'], 'a chat and a window together');
  assert.equal(both.total, 1);
});

test('total and pages are null when the answer does not state them', async () => {
  const bare = await findMessagesPage({ ...BASE, where: { key: { remoteJid: CLIENT } }, fetchImpl: fakeEvolution([stored('A', S0)], { bare: true }).fetchImpl });
  assert.deepEqual(bare.records.map((r) => r.id), ['A']);
  assert.equal(bare.total, null);
  assert.equal(bare.pages, null);

  const odd = recorder([{ status: 200, body: { messages: { total: '1', pages: -1, records: [textRecord()] } } }]);
  const out = await findMessagesPage({ ...BASE, where: { key: { remoteJid: CLIENT } }, fetchImpl: odd.fetchImpl });
  assert.equal(out.records.length, 1);
  assert.equal(out.total, null, 'a size that is not a whole number is not a size');
  assert.equal(out.pages, null);
});

test('findMessagesPage refuses a missing or empty filter, which would read every chat', async () => {
  const { fetchImpl, calls } = recorder();
  await assert.rejects(() => findMessagesPage({ ...BASE, fetchImpl }), TypeError);
  await assert.rejects(() => findMessagesPage({ ...BASE, where: {}, fetchImpl }), TypeError);
  await assert.rejects(() => findMessagesPage({ ...BASE, where: [], fetchImpl }), TypeError);
  await assert.rejects(() => findMessagesPage({ ...BASE, baseUrl: '', where: { key: { remoteJid: CLIENT } }, fetchImpl }), TypeError);
  assert.equal(calls.length, 0);

  // Evolution drops a key filter whose value is falsy and ignores a one-sided time filter, so
  // each of these would page through every chat. A null jid from a lead with neither a lid
  // nor a phone jid is the likely slip; a time window beside it would still read every chat
  // in that window.
  const window = { gte: iso(T0), lte: iso(T0 + 60_000) };
  const wide = [
    { key: { remoteJid: null } },
    { key: { remoteJid: '' } },
    { key: { remoteJidAlt: undefined, remoteJid: null } },
    { key: { id: '' } },
    { key: { remoteJid: 42 } },
    { key: {} },
    { key: null },
    { key: [] },
    { key: { fromMe: true } },
    { fromMe: true },
    { messageTimestamp: { gte: iso(T0) } },
    { messageTimestamp: { lte: iso(T0) } },
    { messageTimestamp: { gte: 'not a date', lte: iso(T0) } },
    { messageTimestamp: { gte: T0, lte: T0 + 60_000 } },
    // Bounds are ISO 8601 date-times, not whatever Date.parse happens to read.
    { messageTimestamp: { gte: '2026', lte: iso(T0) } },
    { messageTimestamp: { gte: 'Sep 1 2026', lte: 'Sep 2 2026' } },
    { messageTimestamp: { gte: '0', lte: iso(T0) } },
    { messageTimestamp: { gte: '2026-09-06', lte: iso(T0) } },
    { messageTimestamp: { gte: '2026-13-45T00:00:00Z', lte: iso(T0) } },
    { messageTimestamp: { gte: iso(T0), lte: '2026-09-06T12:00:00' } },
    { messageTimestamp: null },
    { key: { remoteJid: null }, messageTimestamp: window },
    { key: { remoteJid: CLIENT }, messageTimestamp: { gte: iso(T0) } },
    { key: { remoteJid: CLIENT, remoteJidAlt: null } },
    // Anything Evolution does not read is refused too, even beside a filter that does narrow:
    // a chat named at the top level instead of under `key` is ignored, and the window beside
    // it then reads every chat — which a per-chat caller would file into one lead's thread.
    { remoteJid: CLIENT, messageTimestamp: window },
    { remoteJidAlt: CLIENT, messageTimestamp: window },
    { key: { remoteJid: CLIENT }, messageType: 'conversation' },
    { key: { remoteJid: CLIENT, fromMe: true } },
    { key: { remoteJid: CLIENT, participants: 'x' } },
    { key: { remoteJid: CLIENT }, messageTimestamp: { ...window, gt: iso(T0) } },
    // key.id was never verified live to narrow a read, and nothing needs it.
    { key: { id: 'KEY1' } },
    { key: { remoteJid: CLIENT, id: 'KEY1' } },
  ];
  const refused = (err) => {
    assert.ok(err instanceof TypeError);
    assert.equal(err.message, 'evolution: where must name a chat (key.remoteJid or key.remoteJidAlt) or a whole window (messageTimestamp gte and lte), and hold nothing else');
    return true;
  };
  for (const where of wide) {
    await assert.rejects(() => findMessagesPage({ ...BASE, where, fetchImpl }), refused, JSON.stringify(where));
  }
  assert.equal(calls.length, 0, 'nothing that would widen to every chat is ever sent');

  // A filter that does narrow the read goes through as given.
  const ok = recorder();
  const narrow = [
    { key: { remoteJid: CLIENT } },
    { key: { remoteJidAlt: CLIENT } },
    { key: { remoteJid: CLIENT, remoteJidAlt: CLIENT } },
    { messageTimestamp: window },
    { key: { remoteJid: CLIENT }, messageTimestamp: window },
    { key: { remoteJidAlt: CLIENT }, messageTimestamp: window },
    { messageTimestamp: { gte: '2026-09-06T12:00:00Z', lte: '2026-09-06T15:00:00+03:00' } },
  ];
  for (const where of narrow) await findMessagesPage({ ...BASE, where, fetchImpl: ok.fetchImpl });
  assert.deepEqual(ok.calls.map((c) => c.body.where), narrow);

  const bad = recorder([{ status: 500, body: { error: 'boom' } }]);
  await assert.rejects(() => findMessagesPage({ ...BASE, where: { key: { remoteJid: CLIENT } }, fetchImpl: bad.fetchImpl }), (err) => {
    assert.ok(err instanceof EvolutionError);
    assert.equal(err.status, 500);
    return true;
  });
});

test('findMessagesPage checks the filter it sends, not the object it was handed', async () => {
  // JSON.stringify sends only an object's own enumerable fields, and runs toJSON: a filter that
  // looks narrow through ordinary property reads can still go out as `{"key":{}}`, which
  // Evolution reads as every chat.
  const { fetchImpl, calls } = recorder();
  const inherited = { key: Object.create({ remoteJid: CLIENT }) };
  const hidden = { key: {} };
  Object.defineProperty(hidden.key, 'remoteJid', { value: CLIENT, enumerable: false });
  const rewritten = { key: { remoteJid: CLIENT, toJSON: () => ({}) } };
  for (const where of [inherited, hidden, rewritten]) {
    await assert.rejects(() => findMessagesPage({ ...BASE, where, fetchImpl }), TypeError);
  }
  assert.equal(calls.length, 0);

  // What does go out is exactly what was checked: a getter's value, no undefined fields.
  const getter = { key: { get remoteJid() { return CLIENT; } } };
  await findMessagesPage({ ...BASE, where: getter, fetchImpl });
  await findMessagesPage({ ...BASE, where: { key: { remoteJid: CLIENT, id: undefined } }, fetchImpl });
  assert.deepEqual(calls.map((c) => c.body.where), [{ key: { remoteJid: CLIENT } }, { key: { remoteJid: CLIENT } }]);
});

test('findMessagesPage refuses a page or page size that is not a whole number of at least 1', async () => {
  // offset 0 would quietly page by Evolution's default of 50, and a page below 1 or a fraction
  // names no page: either way the caller would get something other than what it asked for.
  const { fetchImpl, calls } = recorder();
  const where = { key: { remoteJid: CLIENT } };
  const bad = [
    { page: 0 }, { page: -1 }, { page: 1.5 }, { page: '1' }, { page: null }, { page: Number.NaN }, { page: Infinity },
    { offset: 0 }, { offset: -100 }, { offset: 2.5 }, { offset: '100' }, { offset: null },
  ];
  for (const opts of bad) {
    await assert.rejects(() => findMessagesPage({ ...BASE, where, ...opts, fetchImpl }), (err) => {
      assert.ok(err instanceof TypeError, String(Object.entries(opts)));
      assert.match(err.message, /^evolution: (page|offset) must be a whole number of at least 1$/);
      return true;
    });
    await assert.rejects(() => findMessagesWindow({ ...OPTS, ...opts, fetchImpl }), TypeError);
  }
  assert.equal(calls.length, 0, 'nothing is asked for with a nonsense page');

  await findMessagesPage({ ...BASE, where, page: 3, offset: 1, fetchImpl });
  assert.deepEqual(calls.map((c) => [c.body.page, c.body.offset]), [[3, 1]]);
});

test('a 2xx answer that cannot be read, is not JSON or holds no records throws, and is never taken for an empty window', async () => {
  const answer = (text) => async () => ({ ok: true, status: 200, text });
  const cutOff = answer(async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); });
  const dropped = answer(async () => { throw new TypeError('terminated'); });
  const proxyPage = answer(async () => '<html>502 Bad Gateway</html>');
  const noRecords = answer(async () => JSON.stringify({ status: 'ok' }));
  const nothing = answer(async () => '');
  const cases = [
    [cutOff, /failed: timeout$/], [dropped, /failed: network$/],
    [proxyPage, /not JSON/], [noRecords, /no records/], [nothing, /not JSON/],
  ];
  for (const [fetchImpl, message] of cases) {
    const check = (err) => {
      assert.ok(err instanceof EvolutionError);
      assert.equal(err.status, 200);
      assert.equal(err.body, null, 'what came back is not kept');
      assert.match(err.message, message);
      return true;
    };
    await assert.rejects(() => findMessagesPage({ ...BASE, where: { key: { remoteJid: CLIENT } }, fetchImpl }), check);
    await assert.rejects(() => findMessagesWindow({ ...OPTS, fetchImpl }), check);
    await assert.rejects(() => readWindow({ ...BASE, gte: T0, lte: T0 + 60_000, fetchImpl }), check);
    await assert.rejects(() => fetchWindow({ ...OPTS, fetchImpl }), check);
  }

  // Evolution's own empty answer, and an empty bare array, are an empty window.
  const empty = await readWindow({ ...BASE, gte: T0, lte: T0 + 60_000, fetchImpl: answer(async () => JSON.stringify({ messages: { total: 0, pages: 0, records: [] } })) });
  assert.deepEqual(empty, { records: [], pieces: 1, truncated: false, missing: 0 });
  const bare = await findMessagesPage({ ...BASE, where: { key: { remoteJid: CLIENT } }, fetchImpl: answer(async () => '[]') });
  assert.deepEqual(bare.records, []);
});

test('an EvolutionError keeps the upstream body readable but out of anything that serialises the error', async () => {
  const bad = recorder([{ status: 400, body: { error: 'Bad Request', response: { message: ['where.key.remoteJid 966500000000'] } } }]);
  const err = await findMessagesPage({ ...BASE, where: { key: { remoteJid: CLIENT } }, fetchImpl: bad.fetchImpl }).catch((e) => e);
  assert.ok(err instanceof EvolutionError);
  assert.equal(err.body.error, 'Bad Request', 'a caller that asks for it still gets it');
  assert.equal(JSON.stringify(err).includes('966500000000'), false);
  assert.equal(JSON.stringify({ ...err }).includes('966500000000'), false);
  assert.equal(Object.keys(err).includes('body'), false);
});

test('findMessagesWindow is the window case of findMessagesPage and passes the sizes through', async () => {
  const { fetchImpl } = recorder([{ status: 200, body: boxed([textRecord()]) }]);
  const out = await findMessagesWindow({ ...OPTS, fetchImpl });
  assert.equal(out.records[0].id, 'KEY1');
  assert.equal(out.total, 1);
  assert.equal(out.pages, 1);
});

test('readWindow: a window that fits is one piece, one request, complete', async () => {
  const evo = fakeEvolution([stored('A', S0 + 5), stored('B', S0 + 10), stored('LATER', S0 + 120)]);
  const out = await readWindow({ ...BASE, gte: T0, lte: T0 + 60_000, fetchImpl: evo.fetchImpl });
  assert.deepEqual(out.records.map((r) => r.id), ['B', 'A']);
  assert.equal(out.pieces, 1);
  assert.equal(out.truncated, false);
  assert.equal(out.missing, 0);
  assert.deepEqual(evo.calls.map((c) => c.body), [
    { where: { messageTimestamp: { gte: iso(T0), lte: iso(T0 + 60_000) } }, page: 1, offset: PAGE_SIZE },
  ]);
});

test('readWindow pages a window of exactly what one read can reach, without splitting it', async () => {
  const evo = fakeEvolution(Array.from({ length: 500 }, (_, i) => stored(`M${i}`, S0 + i)));
  const out = await readWindow({ ...BASE, gte: T0, lte: T0 + 600_000, fetchImpl: evo.fetchImpl });
  assert.deepEqual(asked(evo.calls), [1, 2, 3, 4, 5].map((p) => [0, 600_000, p]), '500 is not more than 500');
  assert.deepEqual(out.records.map((r) => r.id), desc('M', 0, 499));
  assert.equal(out.pieces, 1);
  assert.equal(out.truncated, false);
  assert.equal(out.missing, 0);
});

test('readWindow splits 1,200 messages into complete pieces on whole seconds, older piece first, each message once', async () => {
  // One message a second for 20 minutes: more than the 500 one read can reach.
  const evo = fakeEvolution(Array.from({ length: 1200 }, (_, i) => stored(`M${i}`, S0 + i)));
  const out = await readWindow({ ...BASE, gte: T0, lte: T0 + 1_199_000, fetchImpl: evo.fetchImpl });

  assert.deepEqual(asked(evo.calls), [
    [0, 1_199_000, 1], // 1,200: too many — cut at 599 s
    [0, 598_999, 1], // 599: still too many — cut at 299 s
    [0, 298_999, 1], [0, 298_999, 2], [0, 298_999, 3],
    [299_000, 598_999, 1], [299_000, 598_999, 2], [299_000, 598_999, 3],
    [599_000, 1_199_000, 1], // 601: cut at 899 s
    [599_000, 898_999, 1], [599_000, 898_999, 2], [599_000, 898_999, 3],
    [899_000, 1_199_000, 1], [899_000, 1_199_000, 2], [899_000, 1_199_000, 3], [899_000, 1_199_000, 4],
  ]);
  assert.ok(evo.calls.every((c) => c.body.page <= MAX_PAGES));
  assert.deepEqual(out.records.map((r) => r.id), [
    ...desc('M', 0, 298), ...desc('M', 299, 598), ...desc('M', 599, 898), ...desc('M', 899, 1199),
  ]);
  assert.equal(new Set(out.records.map((r) => r.id)).size, 1200, 'every message exactly once');
  assert.equal(out.pieces, 4);
  assert.equal(out.truncated, false);
  assert.equal(out.missing, 0);
});

test('readWindow stops cutting at the depth cap and says exactly how many it could not read', async () => {
  // 5,000 messages inside one second (a restored backup, say) with one message either side.
  const burst = Array.from({ length: 5000 }, (_, i) => stored(`B${i}`, S0 + 30));
  const evo = fakeEvolution([stored('EARLY', S0 + 5), ...burst, stored('LATE', S0 + 50)]);
  const out = await readWindow({ ...BASE, gte: T0, lte: T0 + 60_000, fetchImpl: evo.fetchImpl });

  assert.equal(MAX_SPLIT_DEPTH, 4);
  assert.deepEqual(asked(evo.calls), [
    [0, 60_000, 1],
    [0, 29_999, 1], // depth 1: EARLY, complete
    [30_000, 60_000, 1],
    [30_000, 44_999, 1],
    [30_000, 36_999, 1],
    // depth 4 = the cap: the burst's piece is read partially, newest five pages
    [30_000, 32_999, 1], [30_000, 32_999, 2], [30_000, 32_999, 3], [30_000, 32_999, 4], [30_000, 32_999, 5],
    [33_000, 36_999, 1],
    [37_000, 44_999, 1],
    [45_000, 60_000, 1], // LATE, complete
  ]);
  assert.deepEqual(out.records.map((r) => r.id), ['EARLY', ...desc('B', 4500, 4999), 'LATE']);
  assert.equal(out.pieces, 5);
  assert.equal(out.truncated, true);
  assert.equal(out.missing, 4500);
});

test('readWindow cuts on whole seconds, so two seconds under 2,000 ms wide are cut; one second and maxDepth 0 never are', async () => {
  // Evolution compares whole seconds: [T0, T0 + 1999] takes in two of them, S0 and S0 + 1,
  // and a cut at T0 + 1000 separates them, though the window is only 1,999 ms wide. Cutting
  // routinely makes such pieces: [0, 5999] halves into [0, 1999] and [2000, 5999].
  const two = [...Array.from({ length: 300 }, (_, i) => stored(`X${i}`, S0)), ...Array.from({ length: 300 }, (_, i) => stored(`Y${i}`, S0 + 1))];
  const narrow = fakeEvolution(two);
  const a = await readWindow({ ...BASE, gte: T0, lte: T0 + 1_999, fetchImpl: narrow.fetchImpl });
  assert.deepEqual(asked(narrow.calls), [
    [0, 1_999, 1], // 600 in two seconds: cut at S0 + 1
    [0, 999, 1], [0, 999, 2], [0, 999, 3],
    [1_000, 1_999, 1], [1_000, 1_999, 2], [1_000, 1_999, 3],
  ]);
  assert.deepEqual(new Set(a.records.map((r) => r.id)), new Set(two.map((r) => r.key.id)));
  assert.equal(a.records.length, 600);
  assert.equal(a.pieces, 2);
  assert.equal(a.truncated, false);
  assert.equal(a.missing, 0);

  // Bounds off whole seconds: [T0 + 999, T0 + 1000] is 1 ms wide and still two seconds.
  const tight = fakeEvolution(two);
  const t = await readWindow({ ...BASE, gte: T0 + 999, lte: T0 + 1_000, fetchImpl: tight.fetchImpl });
  assert.deepEqual(asked(tight.calls).filter(([, , page]) => page === 1), [[999, 1_000, 1], [999, 999, 1], [1_000, 1_000, 1]]);
  assert.equal(t.records.length, 600);
  assert.equal(t.missing, 0);

  // One whole second, however wide in ms, has nothing to cut at: read partially and counted.
  const one = fakeEvolution(Array.from({ length: 600 }, (_, i) => stored(`Z${i}`, S0)));
  const o = await readWindow({ ...BASE, gte: T0, lte: T0 + 999, fetchImpl: one.fetchImpl });
  assert.equal(one.calls.length, MAX_PAGES);
  assert.equal(o.pieces, 1);
  assert.equal(o.records.length, 500);
  assert.equal(o.truncated, true);
  assert.equal(o.missing, 100);

  const flat = fakeEvolution(Array.from({ length: 1200 }, (_, i) => stored(`M${i}`, S0 + i)));
  const b = await readWindow({ ...BASE, gte: T0, lte: T0 + 1_199_000, maxDepth: 0, fetchImpl: flat.fetchImpl });
  assert.equal(flat.calls.length, MAX_PAGES);
  assert.deepEqual(b.records.map((r) => r.id), desc('M', 700, 1199), 'the newest 500');
  assert.equal(b.pieces, 1);
  assert.equal(b.truncated, true);
  assert.equal(b.missing, 700);
});

test('readWindow falls back to paging until a short page when the answer is a bare array', async () => {
  const small = fakeEvolution(Array.from({ length: 250 }, (_, i) => stored(`M${i}`, S0 + i)), { bare: true });
  const a = await readWindow({ ...BASE, gte: T0, lte: T0 + 300_000, fetchImpl: small.fetchImpl });
  assert.deepEqual(small.calls.map((c) => c.body.page), [1, 2, 3], 'the third page is short: done');
  assert.equal(a.records.length, 250);
  assert.equal(a.pieces, 1);
  assert.equal(a.truncated, false);
  assert.equal(a.missing, 0);

  // No size to decide a cut on up front, so a piece is paged to the cap first; a last page
  // still full there means more lies beyond it, and a piece that can still be cut is.
  const big = fakeEvolution(Array.from({ length: 1200 }, (_, i) => stored(`M${i}`, S0 + i)), { bare: true });
  const b = await readWindow({ ...BASE, gte: T0, lte: T0 + 1_199_000, fetchImpl: big.fetchImpl });
  const pages = (from, to, n) => Array.from({ length: n }, (_, k) => [from, to, k + 1]);
  assert.deepEqual(asked(big.calls), [
    ...pages(0, 1_199_000, 5), // five full pages: cut at 599 s
    ...pages(0, 598_999, 5), // 599, five full pages: cut at 299 s
    ...pages(0, 298_999, 3), // 299: the third page is short
    ...pages(299_000, 598_999, 4), // 300: the third page is full, the fourth empty
    ...pages(599_000, 1_199_000, 5), // 601: cut at 899 s
    ...pages(599_000, 898_999, 4),
    ...pages(899_000, 1_199_000, 4),
  ]);
  assert.deepEqual(b.records.map((r) => r.id), [
    ...desc('M', 0, 298), ...desc('M', 299, 598), ...desc('M', 599, 898), ...desc('M', 899, 1199),
  ]);
  assert.equal(b.pieces, 4);
  assert.equal(b.truncated, false);
  assert.equal(b.missing, 0);

  // Where it cannot be cut, the newest pages are kept and the cut-off is flagged, but it adds
  // nothing to `missing`: nobody can count what a bare array left out.
  const flat = fakeEvolution(Array.from({ length: 1200 }, (_, i) => stored(`M${i}`, S0 + i)), { bare: true });
  const c = await readWindow({ ...BASE, gte: T0, lte: T0 + 1_199_000, maxDepth: 0, fetchImpl: flat.fetchImpl });
  assert.deepEqual(asked(flat.calls), pages(0, 1_199_000, 5));
  assert.deepEqual(c.records.map((r) => r.id), desc('M', 700, 1199));
  assert.equal(c.pieces, 1);
  assert.equal(c.truncated, true);
  assert.equal(c.missing, 0);

  const burst = fakeEvolution(Array.from({ length: 600 }, (_, i) => stored(`Z${i}`, S0)), { bare: true });
  const d = await readWindow({ ...BASE, gte: T0, lte: T0 + 999, fetchImpl: burst.fetchImpl });
  assert.equal(burst.calls.length, MAX_PAGES, 'one second: nothing to cut at');
  assert.equal(d.records.length, 500);
  assert.equal(d.truncated, true);
  assert.equal(d.missing, 0);
});

/**
 * readWindow over scripted answers: two a page, and never cut — canned answers ignore the
 * window, so its halves would only be handed the same canned pages again.
 */
const SCRIPTED = { ...OPTS, offset: 2, maxDepth: 0 };

test('readWindow drops an id seen twice, keeps records that have no id, and reads on for the one a late arrival pushed down', async () => {
  const k = (id) => textRecord({ key: { id, fromMe: false, remoteJid: CLIENT } });
  const noId = textRecord({ key: { fromMe: false, remoteJid: CLIENT } });
  // Four messages, two a page: A, B, the one with no id, C. A message arriving after page 1
  // at the top of the window pushes every older record one place down, so B comes back at
  // the top of page 2 and C falls past the two pages the first answer stated.
  const answers = [
    { status: 200, body: { messages: { total: 4, pages: 2, currentPage: 1, records: [k('A'), k('B')] } } },
    { status: 200, body: { messages: { total: 5, pages: 3, currentPage: 2, records: [k('B'), noId] } } },
    { status: 200, body: { messages: { total: 5, pages: 3, currentPage: 3, records: [k('C')] } } },
  ];
  const { fetchImpl, calls } = recorder(answers);
  const out = await readWindow({ ...SCRIPTED, fetchImpl });
  assert.deepEqual(calls.map((c) => c.body.page), [1, 2, 3], 'two full pages kept three of four: one page more');
  assert.deepEqual(out.records.map((r) => r.id), ['A', 'B', null, 'C']);
  // The newcomer sits on page 1, which was read before it came: five stated, four kept. The
  // caller's next window may not reach back that far, so it is counted, not assumed found.
  assert.equal(out.missing, 1);
  assert.equal(out.truncated, true);

  // With no page left under the cap, C is unread as well: both are counted.
  const capped = recorder(answers);
  const short = await readWindow({ ...SCRIPTED, maxPages: 2, fetchImpl: capped.fetchImpl });
  assert.equal(capped.calls.length, 2);
  assert.deepEqual(short.records.map((r) => r.id), ['A', 'B', null]);
  assert.equal(short.missing, 2);
  assert.equal(short.truncated, true);
});

test('readWindow reads on when a late delivery lands inside the piece, so the oldest record is not dropped quietly', async () => {
  const k = (id) => textRecord({ key: { id, fromMe: false, remoteJid: CLIENT } });
  // Stored A, B, C, D (newest first), two a page. Between page 1 and page 2 the phone
  // reconnects and delivers X, which keeps its sender's timestamp — between B and C — so
  // page 2 is X, C and D slides to page 3. Both records on page 2 are new, so the kept count
  // reaches the first answer's total (4) with D still unread; page 2's own total (5) says
  // there is one more.
  const answers = [
    { status: 200, body: { messages: { total: 4, pages: 2, currentPage: 1, records: [k('A'), k('B')] } } },
    { status: 200, body: { messages: { total: 5, pages: 3, currentPage: 2, records: [k('X'), k('C')] } } },
    { status: 200, body: { messages: { total: 5, pages: 3, currentPage: 3, records: [k('D')] } } },
  ];
  const full = recorder(answers);
  const out = await readWindow({ ...SCRIPTED, fetchImpl: full.fetchImpl });
  assert.deepEqual(full.calls.map((c) => c.body.page), [1, 2, 3]);
  assert.deepEqual(out.records.map((r) => r.id), ['A', 'B', 'X', 'C', 'D']);
  assert.equal(out.truncated, false);
  assert.equal(out.missing, 0);

  // When the page cap comes first, D is unread and the piece says so: five stated, four kept.
  const capped = recorder(answers);
  const short = await readWindow({ ...SCRIPTED, maxPages: 2, fetchImpl: capped.fetchImpl });
  assert.equal(capped.calls.length, 2);
  assert.deepEqual(short.records.map((r) => r.id), ['A', 'B', 'X', 'C']);
  assert.equal(short.truncated, true, 'never passed off as complete');
  assert.equal(short.missing, 1);

  // A record with no id pushed from the bottom of page 1 to the top of page 2 is kept (and
  // counted) twice — nothing tells the two apart — and the newcomer that pushed it raised the
  // total by the same one, so the piece still reads on to D. That double count is also why
  // the newcomer itself, on page 1, goes uncounted: a record with no id cannot be told from
  // one that arrived. Evolution gives every stored record an id; this is the fallback.
  const noId = textRecord({ key: { fromMe: false, remoteJid: CLIENT } });
  const pushed = recorder([
    { status: 200, body: { messages: { total: 4, pages: 2, currentPage: 1, records: [k('A'), noId] } } },
    { status: 200, body: { messages: { total: 5, pages: 3, currentPage: 2, records: [noId, k('C')] } } },
    { status: 200, body: { messages: { total: 5, pages: 3, currentPage: 3, records: [k('D')] } } },
  ]);
  const twice = await readWindow({ ...SCRIPTED, fetchImpl: pushed.fetchImpl });
  assert.deepEqual(pushed.calls.map((c) => c.body.page), [1, 2, 3]);
  assert.deepEqual(twice.records.map((r) => r.id), ['A', null, null, 'C', 'D']);
  assert.equal(twice.truncated, false);
  assert.equal(twice.missing, 0);
});

test('readWindow re-reads a piece late deliveries left short, and counts what they push out of a piece it cannot cut', async () => {
  /** The fake instance, with `arrive(records)` delivered straight after the first request is answered. */
  const deliverAfterFirst = (records, arrive) => {
    const evo = fakeEvolution(records);
    const fetchImpl = async (url, init) => {
      const res = await evo.fetchImpl(url, init);
      if (evo.calls.length === 1) records.push(...arrive);
      return res;
    };
    return { fetchImpl, calls: evo.calls };
  };
  const ids = (out) => new Set(out.records.map((r) => r.id));
  const late30 = () => Array.from({ length: 30 }, (_, j) => stored(`L${j}`, S0 + 200 + j));

  // Where the piece can still be cut, a short read is not accepted: its halves are read again
  // and between them hold every record, the late ones included.
  for (const [before, arrive] of [
    [Array.from({ length: 500 }, (_, i) => stored(`M${i}`, S0 + i)), [stored('LATE', S0 + 250)]],
    [Array.from({ length: 480 }, (_, i) => stored(`M${i}`, S0 + i)), late30()],
    [Array.from({ length: 250 }, (_, i) => stored(`M${i}`, S0 + i)), [stored('LATE', S0 + 245)]],
  ]) {
    const all = [...before, ...arrive].map((r) => r.key.id);
    const out = await readWindow({ ...BASE, gte: T0, lte: T0 + 600_000, ...deliverAfterFirst(before, arrive) });
    assert.equal(out.records.length, all.length, 'each record once');
    assert.deepEqual(ids(out), new Set(all));
    assert.equal(out.truncated, false);
    assert.equal(out.missing, 0);
  }

  // A piece that cannot be cut (maxDepth 0 here) is accepted short, and what it did not
  // return is counted against the largest total any of its pages stated.
  const uncut = { ...BASE, gte: T0, lte: T0 + 600_000, maxDepth: 0 };

  // Exactly one read's worth, and one late delivery stamped mid-window: every page after the
  // first states 501, the oldest record slides to a sixth page the cap never reads.
  const full = Array.from({ length: 500 }, (_, i) => stored(`M${i}`, S0 + i));
  const a = await readWindow({ ...uncut, ...deliverAfterFirst(full, [stored('LATE', S0 + 250)]) });
  assert.equal(a.records.length, 500);
  assert.equal(ids(a).has('LATE'), true);
  assert.equal(ids(a).has('M0'), false);
  assert.equal(a.truncated, true);
  assert.equal(a.missing, 1, 'M0 is counted, not dropped quietly');

  // 480 and 30 late ones: the ten oldest slide past the cap.
  const most = Array.from({ length: 480 }, (_, i) => stored(`M${i}`, S0 + i));
  const late = late30();
  const b = await readWindow({ ...uncut, ...deliverAfterFirst(most, late) });
  const unread = [...most, ...late].filter((r) => !ids(b).has(r.key.id)).length;
  assert.equal(unread, 10);
  assert.equal(b.truncated, true);
  assert.equal(b.missing, 10);

  // A delivery stamped among the newest records lands on the page already read: every other
  // record is returned, and the one this read never saw is counted.
  const some = Array.from({ length: 250 }, (_, i) => stored(`M${i}`, S0 + i));
  const c = await readWindow({ ...uncut, ...deliverAfterFirst(some, [stored('LATE', S0 + 245)]) });
  assert.equal(c.records.length, 250);
  assert.equal(ids(c).has('LATE'), false);
  assert.equal(c.truncated, true);
  assert.equal(c.missing, 1);

  // Nothing arriving: nothing counted, nothing flagged.
  const quiet = Array.from({ length: 250 }, (_, i) => stored(`M${i}`, S0 + i));
  const d = await readWindow({ ...uncut, ...deliverAfterFirst(quiet, []) });
  assert.equal(d.records.length, 250);
  assert.equal(d.truncated, false);
  assert.equal(d.missing, 0);
});

/* ---- records that share one second, which Evolution does not keep in one order ---- */

/**
 * 90 older messages a second apart, 20 sent in the same second (a photo album), 90 newer:
 * newest first, the album takes places 90–109, across the boundary between page 1 and page 2.
 */
const albumOnTheBoundary = () => [
  ...Array.from({ length: 90 }, (_, i) => stored(`O${String(i).padStart(2, '0')}`, S0 + 1 + i)),
  ...Array.from({ length: 20 }, (_, i) => stored(`P${String(i).padStart(2, '0')}`, S0 + 100)),
  ...Array.from({ length: 90 }, (_, i) => stored(`N${String(i).padStart(2, '0')}`, S0 + 201 + i)),
];
const albumIds = () => albumOnTheBoundary().map((r) => r.key.id);

test('an album that straddles a page boundary is read exactly once, though Evolution orders its photos differently on each page', async () => {
  // The trap, shown on the fake: two plain pages repeat ten of the photos and never show ten.
  const naive = fakeEvolution(albumOnTheBoundary(), { unstable: true });
  const where = { messageTimestamp: { gte: iso(T0), lte: iso(T0 + 300_000) } };
  const p1 = await findMessagesPage({ ...BASE, where, page: 1, fetchImpl: naive.fetchImpl });
  const p2 = await findMessagesPage({ ...BASE, where, page: 2, fetchImpl: naive.fetchImpl });
  assert.equal(p1.total, 200);
  assert.equal(new Set([...p1.records, ...p2.records].map((r) => r.id)).size, 190, 'ten repeated, ten never returned');

  const evo = fakeEvolution(albumOnTheBoundary(), { unstable: true });
  const out = await readWindow({ ...BASE, gte: T0, lte: T0 + 300_000, fetchImpl: evo.fetchImpl });
  assert.deepEqual(asked(evo.calls), [
    [0, 300_000, 1], [0, 300_000, 2], // 190 different ids for a stated 200: short, so cut at 150 s
    [0, 149_999, 1], [0, 149_999, 2], // the album and the older 90: the album fits on page 1
    [150_000, 300_000, 1], // the newer 90
  ]);
  assert.equal(out.records.length, 200);
  assert.deepEqual(new Set(out.records.map((r) => r.id)), new Set(albumIds()), 'every message exactly once');
  assert.equal(out.pieces, 2);
  assert.equal(out.truncated, false);
  assert.equal(out.missing, 0);
});

test('an album that straddles a page boundary is read exactly once on the bare-array path too', async () => {
  const evo = fakeEvolution(albumOnTheBoundary(), { unstable: true, bare: true });
  const out = await readWindow({ ...BASE, gte: T0, lte: T0 + 300_000, fetchImpl: evo.fetchImpl });
  assert.deepEqual(asked(evo.calls), [
    // Two full pages and an empty one: 200 rows, 190 different ids — short, so cut at 150 s.
    [0, 300_000, 1], [0, 300_000, 2], [0, 300_000, 3],
    [0, 149_999, 1], [0, 149_999, 2],
    [150_000, 300_000, 1],
  ]);
  assert.equal(out.records.length, 200);
  assert.deepEqual(new Set(out.records.map((r) => r.id)), new Set(albumIds()));
  assert.equal(out.pieces, 2);
  assert.equal(out.truncated, false);
  assert.equal(out.missing, 0);
});

test('a same-second group bigger than a page is cut down to the depth cap, then reported with the exact count not returned', async () => {
  // 250 messages in one second, one message either side: no cut can separate the 250, and
  // across three pages the unstable order hands back only 200 different ones.
  const burst = Array.from({ length: 250 }, (_, i) => stored(`B${String(i).padStart(3, '0')}`, S0 + 30));
  const records = [stored('EARLY', S0 + 5), ...burst, stored('LATE', S0 + 50)];
  const notReturned = (out) => burst.filter((r) => !out.records.some((x) => x.id === r.key.id)).length;

  const evo = fakeEvolution(records, { unstable: true });
  const out = await readWindow({ ...BASE, gte: T0, lte: T0 + 60_000, fetchImpl: evo.fetchImpl });
  // The burst's piece at depth 4 is the last word on it: read in full, then accepted short.
  assert.deepEqual(asked(evo.calls).filter(([from, to]) => from === 30_000 && to === 32_999), [
    [30_000, 32_999, 1], [30_000, 32_999, 2], [30_000, 32_999, 3],
  ]);
  assert.equal(out.records.filter((r) => r.id.startsWith('B')).length, 200);
  assert.equal(out.records.filter((r) => !r.id.startsWith('B')).map((r) => r.id).join(), 'EARLY,LATE');
  assert.equal(new Set(out.records.map((r) => r.id)).size, out.records.length, 'nothing twice');
  assert.equal(out.truncated, true);
  assert.equal(notReturned(out), 50);
  assert.equal(out.missing, 50, 'exactly the ones never returned');
  assert.equal(out.pieces, 5);

  // A window one second wide cannot be cut at all: the same honest short read, at once.
  const one = fakeEvolution(records, { unstable: true });
  const narrow = await readWindow({ ...BASE, gte: T0 + 30_000, lte: T0 + 30_999, fetchImpl: one.fetchImpl });
  assert.equal(one.calls.length, 3);
  assert.equal(narrow.pieces, 1);
  assert.equal(narrow.truncated, true);
  assert.equal(narrow.missing, notReturned(narrow));
  assert.equal(narrow.missing, 50);
});

test('two rows with one id on the same page are a stored duplicate, not a slide: the piece is complete', async () => {
  // One LIMIT/OFFSET page cannot return one row twice, so an id repeated on a page is two rows
  // Evolution stored under one key.id (an API send stored by the send path and again by the
  // Baileys echo, say). Counted as a shortfall, it would cut every window holding it down to
  // the depth cap and flag a loss that never happened, on every poll that overlaps it.
  const rows = [stored('A', S0 + 5), stored('DUP', S0 + 10), stored('DUP', S0 + 10)];
  for (const bare of [false, true]) {
    const evo = fakeEvolution(rows, { bare });
    const out = await readWindow({ ...BASE, gte: T0, lte: T0 + 20_000, fetchImpl: evo.fetchImpl });
    assert.deepEqual(asked(evo.calls), [[0, 20_000, 1]], bare ? 'bare array' : 'boxed');
    assert.deepEqual(out.records.map((r) => r.id), ['DUP', 'A'], 'each id once');
    assert.equal(out.pieces, 1);
    assert.equal(out.truncated, false);
    assert.equal(out.missing, 0);
  }

  // On two pages the two rows look just like a slide, so the piece is cut until they share a
  // page (or fall in different pieces) — and then nothing is reported lost.
  const straddle = fakeEvolution([...rows, stored('N', S0 + 17)]);
  const s = await readWindow({ ...BASE, gte: T0, lte: T0 + 20_000, offset: 2, fetchImpl: straddle.fetchImpl });
  assert.deepEqual(asked(straddle.calls), [
    [0, 20_000, 1], [0, 20_000, 2], // N, DUP | DUP, A: three ids for four rows — cut at 10 s
    [0, 9_999, 1], // A
    [10_000, 20_000, 1], [10_000, 20_000, 2], // N, DUP | DUP: still on two pages — cut at 15 s
    [10_000, 14_999, 1], // DUP, DUP on one page: complete
    [15_000, 20_000, 1], // N
  ]);
  assert.deepEqual(s.records.map((r) => r.id), ['A', 'DUP', 'N']);
  assert.equal(s.pieces, 3);
  assert.equal(s.truncated, false);
  assert.equal(s.missing, 0);

  // An id is credited with the most rows it had on any ONE page, never the sum over pages:
  // X, X on page 1 and X, X again on page 2 may be the same two rows slid, so four rows stated
  // and only the two Xs seen leaves two unread (Y and Z), not one.
  const x = textRecord({ key: { id: 'X', fromMe: false, remoteJid: CLIENT } });
  const twice = recorder([
    { status: 200, body: { messages: { total: 4, pages: 2, currentPage: 1, records: [x, x] } } },
    { status: 200, body: { messages: { total: 4, pages: 2, currentPage: 2, records: [x, x] } } },
  ]);
  const t = await readWindow({ ...SCRIPTED, fetchImpl: twice.fetchImpl });
  assert.deepEqual(t.records.map((r) => r.id), ['X']);
  assert.equal(t.truncated, true);
  assert.equal(t.missing, 2);
});

test('readWindow makes at most maxPages × (2^(maxDepth+1) − 1) requests, even when every piece comes back short', async () => {
  // Every answer states 500 in five pages and hands over the same 100 ids: each piece reads
  // all five pages, comes up short, and is cut, down to the depth cap.
  const same = Array.from({ length: 100 }, (_, i) => textRecord({ key: { id: `S${i}`, fromMe: false, remoteJid: CLIENT } }));
  const { fetchImpl, calls } = recorder([{ status: 200, body: { messages: { total: 500, pages: 5, records: same } } }]);
  const out = await readWindow({ ...BASE, gte: T0, lte: T0 + 60_000, fetchImpl });
  assert.equal(calls.length, MAX_PAGES * (2 ** (MAX_SPLIT_DEPTH + 1) - 1));
  assert.equal(calls.length, 155);
  assert.equal(out.pieces, 2 ** MAX_SPLIT_DEPTH);
  assert.equal(out.records.length, 100, 'each id once across all pieces');
  assert.equal(out.truncated, true);
  assert.equal(out.missing, 16 * 400, 'every piece: 500 stated, 100 different ids');
});

test('readWindow returns nothing partial when a request fails midway: the caller keeps its cursor', async () => {
  const evo = fakeEvolution(Array.from({ length: 1200 }, (_, i) => stored(`M${i}`, S0 + i)));
  // Page 3 of the second piece is cut off while its body is read.
  const fetchImpl = async (url, init) => {
    const res = await evo.fetchImpl(url, init);
    const { where, page } = JSON.parse(init.body);
    if (where.messageTimestamp.gte === iso(T0 + 299_000) && page === 3) {
      return { ok: true, status: 200, text: async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); } };
    }
    return res;
  };
  let out;
  await assert.rejects(async () => { out = await readWindow({ ...BASE, gte: T0, lte: T0 + 1_199_000, fetchImpl }); }, EvolutionError);
  assert.equal(out, undefined, 'no records from the pieces read before the failure');
  assert.deepEqual(asked(evo.calls).at(-1), [299_000, 598_999, 3], 'and nothing is asked after it');
  assert.equal(evo.calls.length, 8);
});

test('readWindow cuts a window whose bounds are off whole seconds without overlap or a second left out', async () => {
  const evo = fakeEvolution(Array.from({ length: 1200 }, (_, i) => stored(`M${i}`, S0 + i)));
  // Evolution cuts both bounds down to the second, so T0 + 500 still takes in second S0.
  const out = await readWindow({ ...BASE, gte: T0 + 500, lte: T0 + 1_199_500, fetchImpl: evo.fetchImpl });
  assert.deepEqual(asked(evo.calls), [
    [500, 1_199_500, 1], // 1,200: cut at 600 s
    [500, 599_999, 1], // 600: cut at 300 s
    [500, 299_999, 1], [500, 299_999, 2], [500, 299_999, 3],
    [300_000, 599_999, 1], [300_000, 599_999, 2], [300_000, 599_999, 3],
    [600_000, 1_199_500, 1], // 600: cut at 899 s
    [600_000, 898_999, 1], [600_000, 898_999, 2], [600_000, 898_999, 3],
    [899_000, 1_199_500, 1], [899_000, 1_199_500, 2], [899_000, 1_199_500, 3], [899_000, 1_199_500, 4],
  ]);
  assert.deepEqual(out.records.map((r) => r.id), [
    ...desc('M', 0, 299), ...desc('M', 300, 599), ...desc('M', 600, 898), ...desc('M', 899, 1199),
  ]);
  assert.equal(new Set(out.records.map((r) => r.id)).size, 1200, 'every message exactly once');
  assert.equal(out.pieces, 4);
  assert.equal(out.truncated, false);
  assert.equal(out.missing, 0);
});

test('readWindow refuses a page size, page cap or depth that is not a whole number', async () => {
  const { fetchImpl, calls } = recorder();
  const bad = [
    { offset: 0 }, { offset: -100 }, { offset: 2.5 }, { offset: '100' }, { offset: null },
    { maxPages: 0 }, { maxPages: 1.5 }, { maxPages: Infinity },
    { maxDepth: -1 }, { maxDepth: 0.5 }, { maxDepth: Number.NaN },
  ];
  for (const opts of bad) {
    await assert.rejects(() => readWindow({ ...OPTS, ...opts, fetchImpl }), (err) => {
      assert.ok(err instanceof TypeError, String(Object.entries(opts)));
      assert.match(err.message, /^evolution: (offset|maxPages|maxDepth) must be a whole number of at least [01]$/);
      return true;
    });
  }
  assert.equal(calls.length, 0, 'nothing is read with a nonsense page size');
});

test('readWindow needs both bounds', async () => {
  const { fetchImpl, calls } = recorder();
  const oneSided = { name: 'TypeError', message: 'evolution: readWindow needs both gte and lte' };
  await assert.rejects(() => readWindow({ ...BASE, gte: T0, fetchImpl }), oneSided);
  await assert.rejects(() => readWindow({ ...BASE, lte: T0, fetchImpl }), oneSided);
  assert.equal(calls.length, 0);
});

/* ---------------- media placeholders and noise ---------------- */

test('media become placeholders: a voice note is not just audio, a round video is a video', () => {
  const m = (message) => mediaOf({ message });
  assert.equal(m({ audioMessage: { ptt: true, seconds: 7 } }), '[voice note]');
  assert.equal(m({ audioMessage: { ptt: false, seconds: 7 } }), '[audio]');
  assert.equal(m({ audioMessage: {} }), '[audio]');
  assert.equal(m({ imageMessage: { caption: 'the view' } }), '[image]');
  assert.equal(m({ videoMessage: {} }), '[video]');
  assert.equal(m({ ptvMessage: {} }), '[video]');
  assert.equal(m({ documentMessage: { fileName: 'Brochure BONA-W014.pdf' } }), '[document: Brochure BONA-W014.pdf]');
  assert.equal(m({ documentMessage: {} }), '[document]');
  assert.equal(m({ documentMessage: { fileName: 42 } }), '[document]');
  assert.equal(m({ locationMessage: { degreesLatitude: 21.5, degreesLongitude: 39.2 } }), '[location]');
  assert.equal(m({ liveLocationMessage: {} }), '[location]');
  assert.equal(m({ contactMessage: { displayName: 'x' } }), '[contact]');
  assert.equal(m({ contactsArrayMessage: { contacts: [] } }), '[contact]');
  assert.equal(m({ stickerMessage: {} }), '[sticker]');
  assert.equal(m({ viewOnceMessageV2: { message: { imageMessage: {} } } }), '[image]');
  assert.equal(m({ conversation: 'hello' }), null);
  assert.equal(m({ extendedTextMessage: { text: 'hello' } }), null);
  assert.equal(m({ someFutureMessage: {} }), null, 'unknown kinds are left to the caller ([message])');
  assert.equal(mediaOf({}), null);
  assert.equal(mediaOf(null), null);
});

test('a document name loses control and bidi characters, is capped at 120 code points, and is found inside wrappers', () => {
  const doc = (fileName) => ({ documentMessage: { fileName, caption: 'the plan' } });
  // ephemeral (disappearing messages) around documentWithCaption around the document
  const wrapped = (fileName) => ({ message: { ephemeralMessage: { message: { documentWithCaptionMessage: { message: doc(fileName) } } } } });

  const spoof = 'Villa\u202Efdp.exe  \t plan\u0000.pdf';
  assert.equal(mediaOf(wrapped(spoof)), '[document: Villafdp.exe plan.pdf]');
  const arabic = '\u2067مخطط\u2069 \u200Fالفيلا\u061C\u202A.pdf\u202C\n';
  assert.equal(mediaOf(wrapped(arabic)), '[document: مخطط الفيلا.pdf]');
  assert.equal(mediaOf({ message: doc('floor\tplan\nv2.pdf') }), '[document: floor plan v2.pdf]', 'a tab or line break still separates words');
  assert.equal(mediaOf(wrapped('\u202E\u0007 \u2066 ')), '[document]', 'nothing usable left');

  const long = '📄'.repeat(50) + 'a'.repeat(150);
  assert.equal(Array.from(long).length, 200);
  const capped = '📄'.repeat(50) + 'a'.repeat(70);
  assert.equal(mediaOf({ message: doc(long) }), `[document: ${capped}]`);
  assert.equal(Array.from(normaliseRecord({ key: { id: 'D1' }, message: doc(long) }).fileName).length, 120);
  assert.equal(normaliseRecord({ key: { id: 'D1' }, message: doc(long) }).fileNameTruncated, true, 'the record says the name was cut');

  // Invisible formatting characters, which let two different names look the same, go as
  // well; the joiners that Persian text and emoji need stay.
  assert.equal(mediaOf({ message: doc('a\u200Bb\u2060c\u206Ad\u00ADe\uFFF9f\u2064g\u206Fh.pdf') }), '[document: abcdefgh.pdf]');
  const joined = 'می\u200Cخواهم 👨\u200D👩\u200D👧.pdf';
  assert.equal(mediaOf({ message: doc(joined) }), `[document: ${joined}]`);

  // The cap never cuts a character in half: a flag is two code points, a letter with its vowel
  // mark two, a family emoji five. What does not fit whole is left out whole.
  const nameOf = (fileName) => normaliseRecord({ key: { id: 'D2' }, message: doc(fileName) }).fileName;
  const family = '👨\u200D👩\u200D👧';
  assert.equal(nameOf('a'.repeat(119) + '🇸🇦'), 'a'.repeat(119));
  assert.equal(nameOf('a'.repeat(119) + '\u0628\u064E'), 'a'.repeat(119));
  assert.equal(nameOf('a'.repeat(115) + family), 'a'.repeat(115) + family, 'exactly 120 code points: kept whole');
  assert.equal(normaliseRecord({ key: { id: 'D2' }, message: doc('a'.repeat(115) + family) }).fileNameTruncated, false, 'kept whole is not cut');
  assert.equal(normaliseRecord({ key: { id: 'D2' }, message: doc(' ' + 'a'.repeat(120) + ' \u202E') }).fileNameTruncated, false, 'what cleaning removes is not a cut');
  assert.equal(nameOf('a'.repeat(116) + family + 'b'), 'a'.repeat(116));

  // Every other invisible character goes too: they are found by category (control, format,
  // default-ignorable), not from a hand list. Among them the Mongolian vowel separator, the
  // combining grapheme joiner, the Hangul fillers, the tag characters (which can spell out
  // hidden text), the variation selectors outside the emoji range, the Arabic prepended
  // marks and the byte-order mark.
  const invisible = ['\u180E', '\u034F', '\u115F', '\u1160', '\u3164', '\uFFA0', '\u{E0001}', '\u{E0041}', '\u{E007F}',
    '\u{E0100}', '\u{E01EF}', '\u0600', '\u0605', '\uFEFF', '\u2065', '\u17B4'];
  assert.equal(mediaOf({ message: doc(`plan${invisible.join('')}.pdf`) }), '[document: plan.pdf]');
  for (const ch of invisible) assert.equal(nameOf(`a${ch}b.pdf`), 'ab.pdf', `U+${ch.codePointAt(0).toString(16)}`);
  // The emoji variation selector stays: it only picks how the heart before it is drawn.
  assert.equal(nameOf('\u2764\uFE0F villa.pdf'), '\u2764\uFE0F villa.pdf');
});

test('the placeholder and the record name the same file, and say it was cut only when it was', () => {
  const doc = (fileName) => ({ key: { id: 'D3' }, message: { documentMessage: { fileName } } });
  for (const [fileName, cut] of [
    ['Villa\u202Efdp.exe  \t plan\u0000.pdf', false],
    ['\u2067مخطط\u2069 \u200Fالفيلا\u061C\u202A.pdf\u202C\n', false],
    ['📄'.repeat(50) + 'a'.repeat(150), true],
    ['a'.repeat(119) + ' b', true],
    [`${'a'.repeat(118)}\u202E\u202E\u202Ebc`, false],
    ['a'.repeat(116) + '👨\u200D👩\u200D👧' + 'b', true],
    [' ' + 'a'.repeat(120) + ' \u202E', false],
    ['\u202E\u0007 \u2066 ', false],
    ['', false],
    [42, false],
    [undefined, false],
  ]) {
    const rec = normaliseRecord(doc(fileName));
    assert.equal(rec.media, rec.fileName === null ? '[document]' : `[document: ${rec.fileName}]`, JSON.stringify(fileName));
    assert.equal(rec.fileNameTruncated, cut, JSON.stringify(fileName));
    assert.equal(mediaOf(doc(fileName)), rec.media);
  }
});

test('fileNameTk and fileNameBona say whether the whole name names TK or Bona, even where the cut hides it (D16)', () => {
  const rec = (fileName) => normaliseRecord({ key: { id: 'D4' }, message: { documentMessage: { fileName } } });
  // TK after the 120th code point: the name the record carries no longer shows it.
  const hidden = rec(`Villa Brochure ${'x'.repeat(120)} TK.pdf`);
  assert.equal(hidden.fileNameTruncated, true);
  assert.ok(!hidden.fileName.includes('TK'), 'the cut hides it');
  assert.equal(hidden.fileNameTk, true, 'but the record still says so');
  assert.equal(hidden.fileNameBona, false);
  const bona = rec(`Villa Brochure ${'x'.repeat(120)} Bona.pdf`);
  assert.ok(!bona.fileName.includes('Bona'), 'the cut hides our name too');
  assert.deepEqual([bona.fileNameBona, bona.fileNameTk], [true, false], 'and the record says so');
  for (const [fileName, tk] of [
    ['TK Brochure Villa.pdf', true],
    ['T.K. Estates brochure.pdf', true],
    ['tk-estates price list.pdf', true],
    ['TKEstates_floorplan.pdf', true],
    ['بروشور تي كي.pdf', true],
    ['بروشور تى كى.pdf', true],
    ['بروشور تي كى.pdf', true],
    ['بروشور تي - كي.pdf', true],
    // An invisible character cannot hide it: the name is cleaned before it is shown, and the
    // two joiners the shown name keeps (U+200C, U+200D) are read through as well.
    ['T\u200BK Brochure.pdf', true],
    ['T\u200CK Brochure.pdf', true],
    ['T\u200DK Brochure.pdf', true],
    ['بروشور تي\u200Cكي.pdf', true],
    [`Villa Brochure ${'x'.repeat(120)}.pdf`, false],
    ['TKO brochure.pdf', false],
    ['Stock2TK9.pdf', false],
    ['بلاستيكي.pdf', false],
    ['بلاستيكى.pdf', false],
    ['Knightsbridge_Phase 2_Brochure_EN.pdf', false],
  ]) {
    assert.equal(rec(fileName).fileNameTk, tk, JSON.stringify(fileName));
  }
  for (const [fileName, named] of [
    ['Bona Traffic HD brochure.pdf', true],
    ['BONA-W003 brochure.pdf', true],
    ['بونا - فيلا الشاطئ.pdf', true],
    ['B\u200Cona Villa brochure.pdf', true],
    ['Bona Fide Purchaser Declaration.pdf', false],
    ['Bonanza brochure.pdf', false],
    ['Knightsbridge_Phase 2_Brochure_EN.pdf', false],
  ]) {
    assert.equal(rec(fileName).fileNameBona, named, JSON.stringify(fileName));
  }
  assert.ok(rec('T\u200CK Brochure.pdf').fileName.includes('\u200C'), 'the shown name keeps its joiner');
  // A first grapheme longer than the whole cap leaves no name to show, but the whole name
  // still named TK or Bona, and the record says so.
  const zalgoTk = rec(`a${'\u0301'.repeat(120)} TK.pdf`);
  assert.deepEqual([zalgoTk.fileName, zalgoTk.fileNameTruncated, zalgoTk.fileNameTk, zalgoTk.fileNameBona], [null, false, true, false]);
  const zalgoBona = rec(`a${'\u0301'.repeat(120)} Bona.pdf`);
  assert.deepEqual([zalgoBona.fileName, zalgoBona.fileNameTk, zalgoBona.fileNameBona], [null, false, true]);
  for (const r of [rec(''), normaliseRecord(textRecord())]) {
    assert.deepEqual([r.fileNameTk, r.fileNameBona], [false, false], 'no usable name, or no document');
  }
});

test('a file name is read both ways for TK and Bona, as a caption is: the same string gets the same answer (D16)', () => {
  // "X​TK" reads "XTK" with the invisible character gone and "X TK" with it keeping
  // the words apart. A caption is read both ways (namesTk, namesBona) and names TK when
  // either reading does; a file name used to be read only with it gone, so the same string
  // joined as a file name and stayed out as a caption.
  const asName = (s) => normaliseRecord({ key: { id: 'N', fromMe: true }, message: { documentMessage: { fileName: s } } });
  const asCaption = (s) => normaliseRecord({ key: { id: 'C', fromMe: true }, message: { documentMessage: { fileName: 'document.pdf', caption: s } } });
  for (const [s, tk, bona] of [
    ['Villa brochure X​TK.pdf', true, false],
    ['Villa brochure X‎TK.pdf', true, false],
    ['Villa brochure X‏TK.pdf', true, false],
    ['Villa brochure X­TK.pdf', true, false],
    ['Villa brochure X﻿TK.pdf', true, false],
    ['Villa brochure TK⁠X.pdf', true, false],
    ['بروشور فيلا​تي كي.pdf', true, false],
    ['بروشور تي كي​فيلا.pdf', true, false],
    ['Villa brochure X​Bona.pdf', false, true],
    ['Bona​fide villa brochure.pdf', false, true],
    // Neither reading names TK or Bona: both join, by the brochure.
    ['Villa brochure X​Y.pdf', false, false],
    ['Villa brochure XTK.pdf', false, false],
    ['Bona fide villa brochure.pdf', false, false],
  ]) {
    const name = asName(s);
    const caption = asCaption(s);
    assert.equal(caption.text, s, 'the caption is read as it was sent');
    assert.deepEqual([namesTk(caption.text), namesBona(caption.text)], [tk, bona], `caption ${JSON.stringify(s)}`);
    assert.deepEqual([name.fileNameTk, name.fileNameBona], [tk, bona], `file name ${JSON.stringify(s)}`);
    const joins = !tk && !bona;
    assert.equal(ownerOutboundJoins(name), joins, `joins as a file name ${JSON.stringify(s)}`);
    assert.equal(ownerOutboundJoins(caption), joins, `joins as a caption ${JSON.stringify(s)}`);
    assert.equal(isTkDocument(name), tk, `TK document by its file name ${JSON.stringify(s)}`);
    assert.equal(isTkDocument(caption), tk, `TK document by its caption ${JSON.stringify(s)}`);
  }
});

test('reactions, deletes and edits, poll votes and key-distribution records are noise; a message is not', () => {
  const n = (message, messageType) => isNoise({ message, messageType });
  assert.equal(n({ reactionMessage: { text: '👍', key: { id: 'X' } } }), true);
  assert.equal(n({ protocolMessage: { type: 0, key: { id: 'X' } } }), true, 'a delete for everyone');
  assert.equal(n({ protocolMessage: { type: 14, editedMessage: { conversation: 'fixed' } } }), true, 'an edit');
  assert.equal(n({ editedMessage: { message: { protocolMessage: { type: 14 } } } }), true, 'an edit, wrapped');
  assert.equal(n({ pollUpdateMessage: { vote: {} } }), true);
  assert.equal(n({ ephemeralMessage: { message: { reactionMessage: { text: '❤' } } } }), true);
  assert.equal(n({ senderKeyDistributionMessage: { groupId: 'g' }, messageContextInfo: {} }), true, 'key distribution only');
  assert.equal(n({ senderKeyDistributionMessage: { groupId: 'g' } }), true);
  assert.equal(n({ messageContextInfo: { deviceListMetadata: {} } }), true, 'device metadata only');
  for (const type of ['reactionMessage', 'protocolMessage', 'pollUpdateMessage']) {
    assert.equal(n(undefined, type), true, `${type} by messageType alone`);
  }
  // A record that says it is an edit is one, whatever its wrapper holds. A record that says
  // nothing about its own kind is judged by the edit wrapper (unwrapping takes it off, so it
  // is looked for on the way in, not on what is left). A record that names a kind of its own
  // is the next test.
  assert.equal(n({ editedMessage: { message: { conversation: 'fixed' } } }, 'editedMessage'), true, 'an edit carrying its text');
  assert.equal(n({ editedMessage: { message: { conversation: 'fixed' } } }), true, 'an edit, by its wrapper alone');
  assert.equal(n({ ephemeralMessage: { message: { editedMessage: { message: { extendedTextMessage: { text: 'fixed' } } } } } }), true, 'an edit in a disappearing chat');
  assert.equal(n({ editedMessage: { message: { protocolMessage: { type: 14 } } } }, 'conversation'), true, 'an edit event is noise by its content, whatever its type says');
  assert.equal(n({ albumMessage: { expectedImageCount: 3 } }), true, 'an album header: the photos arrive as records of their own');
  assert.equal(n({ pinInChatMessage: { type: 1 } }), true, 'a pin');
  assert.equal(n({ keepInChatMessage: { keepType: 1 } }), true, 'keep in a disappearing chat');
  assert.equal(n({ encReactionMessage: { encPayload: 'x' } }), true, 'an encrypted reaction');
  for (const type of ['editedMessage', 'albumMessage', 'pinInChatMessage', 'keepInChatMessage', 'encReactionMessage']) {
    assert.equal(n(undefined, type), true, `${type} by messageType alone`);
  }
  assert.equal(n({ documentWithCaptionMessage: { message: { documentMessage: {} } } }), false, 'other wrappers are not edits');
  assert.equal(n({ viewOnceMessageV2: { message: { imageMessage: {} } } }), false);

  assert.equal(n({ conversation: 'hello', messageContextInfo: {} }, 'conversation'), false);
  assert.equal(n({ extendedTextMessage: { text: 'x' }, senderKeyDistributionMessage: {} }), false, 'a real message riding with a key');
  assert.equal(n({ imageMessage: {} }, 'imageMessage'), false);
  assert.equal(n({ someFutureMessage: {} }), false, 'an unknown kind shows as [message], never vanishes');
  assert.equal(n({}), false, 'no body at all may be a message the phone could not decrypt');
  assert.equal(n(null), false);
});

test('a record that names its own kind is kept, with its new content, when an edit wrapper holds it', () => {
  // Baileys reports an edit as an update to the ORIGINAL message, its content set to
  // `{ editedMessage: { message: <new content> } }`. Whether Evolution 2.3.7 ever stores an
  // original that way is not verified; if it does, the record keeps its own id and says what
  // it is, and it is the client's message: dropping it as noise would lose it silently.
  const edited = normaliseRecord(textRecord({
    key: { id: 'ORIG1', fromMe: false, remoteJid: '966500000000@s.whatsapp.net' },
    messageType: 'conversation',
    message: { editedMessage: { message: { conversation: 'x' } } },
  }));
  assert.equal(edited.noise, false);
  assert.equal(edited.text, 'x');
  assert.equal(edited.id, 'ORIG1');

  const n = (message, messageType) => isNoise({ message, messageType });
  assert.equal(n({ editedMessage: { message: { extendedTextMessage: { text: 'x' } } } }, 'extendedTextMessage'), false);
  assert.equal(n({ ephemeralMessage: { message: { editedMessage: { message: { conversation: 'x' } } } } }, 'ephemeralMessage'), false,
    'an original from a disappearing chat keeps the type it was stored with');
  assert.equal(n({ editedMessage: { message: { conversation: 'x' } } }, 'unknown'), false, 'Evolution\'s "unknown" is not a claim to be an edit');

  const photo = normaliseRecord(textRecord({
    messageType: 'imageMessage',
    message: { editedMessage: { message: { imageMessage: { caption: 'the view, corrected' } } } },
  }));
  assert.equal(photo.noise, false);
  assert.equal(photo.media, '[image]');
  assert.equal(photo.text, 'the view, corrected');
});

test('normaliseRecord carries the placeholder, the cleaned file name and the noise flag', () => {
  const voice = normaliseRecord(textRecord({ messageType: 'audioMessage', message: { audioMessage: { ptt: true }, messageContextInfo: {} } }));
  assert.equal(voice.media, '[voice note]');
  assert.equal(voice.text, '');
  assert.equal(voice.fileName, null);
  assert.equal(voice.fileNameTruncated, false);
  assert.equal(voice.fileNameTk, false);
  assert.equal(voice.fileNameBona, false);
  assert.equal(voice.noise, false);

  const brochure = normaliseRecord(textRecord({
    messageType: 'documentWithCaptionMessage',
    message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: 'BONA-W014\u202E.pdf', caption: 'as promised' } } } },
  }));
  assert.equal(brochure.media, '[document: BONA-W014.pdf]');
  assert.equal(brochure.fileName, 'BONA-W014.pdf');
  assert.equal(brochure.fileNameTruncated, false);
  assert.equal(brochure.fileNameTk, false);
  assert.equal(brochure.fileNameBona, true, 'a listing id names Bona too (it joins by the id)');
  assert.equal(brochure.text, 'as promised');
  assert.equal(brochure.noise, false);

  const reaction = normaliseRecord(textRecord({ messageType: 'reactionMessage', message: { reactionMessage: { text: '👍' } } }));
  assert.equal(reaction.noise, true);
  assert.equal(reaction.media, null);
  assert.equal(reaction.fileName, null);
});
