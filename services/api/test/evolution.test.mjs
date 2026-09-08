/**
 * The Evolution read client. The real API is never contacted: every test drives a
 * stub `fetch`. Response shapes are the ones the live instance `abdulaziz-personal`
 * answered with on 2026-09-05 (see services/intake/test/evolution.test.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EvolutionError, MAX_PAGES, PAGE_SIZE, bareJid, contextOf, fetchWindow, findMessagesWindow,
  normaliseRecord, oldestFirst, recordsOf, textOf, toMs,
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
