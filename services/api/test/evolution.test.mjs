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
 */
function fakeEvolution(records, { bare = false } = {}) {
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
    const hits = records
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.messageTimestamp >= lo && r.messageTimestamp <= hi)
      .filter(({ r }) => (key.remoteJid ? r.key.remoteJid === key.remoteJid
        : !key.remoteJidAlt || r.key.remoteJidAlt === key.remoteJidAlt))
      .sort((a, b) => b.r.messageTimestamp - a.r.messageTimestamp || b.i - a.i)
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

  const bad = recorder([{ status: 500, body: { error: 'boom' } }]);
  await assert.rejects(() => findMessagesPage({ ...BASE, where: { key: { remoteJid: CLIENT } }, fetchImpl: bad.fetchImpl }), (err) => {
    assert.ok(err instanceof EvolutionError);
    assert.equal(err.status, 500);
    return true;
  });
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

test('readWindow never cuts a window under two seconds wide, and maxDepth 0 never cuts at all', async () => {
  const two = [...Array.from({ length: 300 }, (_, i) => stored(`X${i}`, S0)), ...Array.from({ length: 300 }, (_, i) => stored(`Y${i}`, S0 + 1))];
  const narrow = fakeEvolution(two);
  const a = await readWindow({ ...BASE, gte: T0, lte: T0 + 1_999, fetchImpl: narrow.fetchImpl });
  assert.equal(narrow.calls.length, MAX_PAGES, 'no whole second inside the window to cut at');
  assert.equal(a.pieces, 1);
  assert.equal(a.records.length, 500);
  assert.equal(a.truncated, true);
  assert.equal(a.missing, 100);

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

  const big = fakeEvolution(Array.from({ length: 1200 }, (_, i) => stored(`M${i}`, S0 + i)), { bare: true });
  const b = await readWindow({ ...BASE, gte: T0, lte: T0 + 1_199_000, fetchImpl: big.fetchImpl });
  assert.deepEqual(asked(big.calls), [1, 2, 3, 4, 5].map((p) => [0, 1_199_000, p]), 'no size to decide a cut on');
  assert.deepEqual(b.records.map((r) => r.id), desc('M', 700, 1199));
  assert.equal(b.pieces, 1);
  assert.equal(b.truncated, true);
  assert.equal(b.missing, 0, 'nobody can count what a bare array left out');
});

test('readWindow drops an id seen twice, keeps records that have no id, and reads on for the one a late arrival pushed down', async () => {
  const k = (id) => textRecord({ key: { id, fromMe: false, remoteJid: CLIENT } });
  const noId = textRecord({ key: { fromMe: false, remoteJid: CLIENT } });
  // Four messages, two a page: A, B, the one with no id, C. A message arriving after page 1
  // pushes every older record one place down, so B comes back at the top of page 2 and C
  // falls past the two pages the first answer stated.
  const answers = [
    { status: 200, body: { messages: { total: 4, pages: 2, currentPage: 1, records: [k('A'), k('B')] } } },
    { status: 200, body: { messages: { total: 5, pages: 3, currentPage: 2, records: [k('B'), noId] } } },
    { status: 200, body: { messages: { total: 5, pages: 3, currentPage: 3, records: [k('C')] } } },
  ];
  const { fetchImpl, calls } = recorder(answers);
  const out = await readWindow({ ...OPTS, offset: 2, fetchImpl });
  assert.deepEqual(calls.map((c) => c.body.page), [1, 2, 3], 'two full pages kept three of four: one page more');
  assert.deepEqual(out.records.map((r) => r.id), ['A', 'B', null, 'C']);
  assert.equal(out.missing, 0);
  assert.equal(out.truncated, false);

  // With no page left under the cap, the record pushed out is counted, never lost quietly.
  const capped = recorder(answers);
  const short = await readWindow({ ...OPTS, offset: 2, maxPages: 2, fetchImpl: capped.fetchImpl });
  assert.equal(capped.calls.length, 2);
  assert.deepEqual(short.records.map((r) => r.id), ['A', 'B', null]);
  assert.equal(short.missing, 1);
  assert.equal(short.truncated, true);
});

test('readWindow needs both bounds', async () => {
  const { fetchImpl, calls } = recorder();
  await assert.rejects(() => readWindow({ ...BASE, gte: T0, fetchImpl }), TypeError);
  await assert.rejects(() => readWindow({ ...BASE, lte: T0, fetchImpl }), TypeError);
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

  assert.equal(n({ conversation: 'hello', messageContextInfo: {} }, 'conversation'), false);
  assert.equal(n({ extendedTextMessage: { text: 'x' }, senderKeyDistributionMessage: {} }), false, 'a real message riding with a key');
  assert.equal(n({ imageMessage: {} }, 'imageMessage'), false);
  assert.equal(n({ someFutureMessage: {} }), false, 'an unknown kind shows as [message], never vanishes');
  assert.equal(n({}), false, 'no body at all may be a message the phone could not decrypt');
  assert.equal(n(null), false);
});

test('normaliseRecord carries the placeholder, the cleaned file name and the noise flag', () => {
  const voice = normaliseRecord(textRecord({ messageType: 'audioMessage', message: { audioMessage: { ptt: true }, messageContextInfo: {} } }));
  assert.equal(voice.media, '[voice note]');
  assert.equal(voice.text, '');
  assert.equal(voice.fileName, null);
  assert.equal(voice.noise, false);

  const brochure = normaliseRecord(textRecord({
    messageType: 'documentWithCaptionMessage',
    message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: 'BONA-W014\u202E.pdf', caption: 'as promised' } } } },
  }));
  assert.equal(brochure.media, '[document: BONA-W014.pdf]');
  assert.equal(brochure.fileName, 'BONA-W014.pdf');
  assert.equal(brochure.text, 'as promised');
  assert.equal(brochure.noise, false);

  const reaction = normaliseRecord(textRecord({ messageType: 'reactionMessage', message: { reactionMessage: { text: '👍' } } }));
  assert.equal(reaction.noise, true);
  assert.equal(reaction.media, null);
  assert.equal(reaction.fileName, null);
});
