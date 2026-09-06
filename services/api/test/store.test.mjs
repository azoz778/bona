import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, TTL_MS } from '../lib/store.mjs';

const card = (id) => ({ id, slug: id.toLowerCase(), title: { en: id, ar: id } });

test('a session round-trips and carries its locale and page', () => {
  const store = createStore();
  const s = store.createSession({ chatId: 'chat_1', locale: 'ar', page: { url: '/ar/properties/x/' } });
  assert.match(s.sessionId, /^[0-9a-f]{32}$/);
  const found = store.getSession(s.sessionId);
  assert.equal(found.chatId, 'chat_1');
  assert.equal(found.locale, 'ar');
  assert.equal(found.page.url, '/ar/properties/x/');
});

test('an unknown session id is simply not found', () => {
  const store = createStore();
  assert.equal(store.getSession('nope'), null);
  assert.equal(store.endSession('nope'), false);
});

test('sessions and call contexts expire after the 2 hour TTL', () => {
  let t = 0;
  const store = createStore({ now: () => t });
  const s = store.createSession({ chatId: 'chat_1' });
  store.createCall({ callId: 'call_1' });
  t = TTL_MS - 1;
  assert.ok(store.getCall('call_1'), 'still inside the window');
  t = TTL_MS + 1;
  assert.equal(store.getSession(s.sessionId), null);
  assert.equal(store.getCall('call_1'), null);
});

test('reading a session refreshes its TTL', () => {
  let t = 0;
  const store = createStore({ now: () => t });
  const s = store.createSession({ chatId: 'chat_1' });
  t = TTL_MS - 10;
  store.getSession(s.sessionId);
  t = TTL_MS + 10;
  assert.ok(store.getSession(s.sessionId), 'a live conversation must not be dropped mid-sentence');
});

test('cards accumulate newest-first, de-duplicated, and capped', () => {
  const store = createStore();
  store.createCall({ callId: 'call_1' });
  store.addCard('call_1', card('A'));
  store.addCard('call_1', card('B'));
  store.addCard('call_1', card('A'));
  assert.deepEqual(store.getCall('call_1').cards.map((c) => c.id), ['A', 'B']);
  for (let i = 0; i < 30; i += 1) store.addCard('call_1', card(`X${i}`));
  assert.ok(store.getCall('call_1').cards.length <= 12);
});

test('a tool hit for a call we never registered still creates a context', () => {
  const store = createStore();
  store.addCard('call_unseen', card('A'));
  assert.equal(store.getCall('call_unseen').cards[0].id, 'A');
});

test('a tool hit addressed by chat_id reaches the right session', () => {
  const store = createStore();
  const s = store.createSession({ chatId: 'chat_7' });
  store.addCard('chat_7', card('A'));
  assert.equal(store.getSession(s.sessionId).cards[0].id, 'A');
  store.markLead('chat_7');
  assert.equal(store.getSession(s.sessionId).leadCaptured, true);
});

test('ending a session drops it and its external link', () => {
  const store = createStore();
  const s = store.createSession({ chatId: 'chat_1' });
  assert.equal(store.endSession(s.sessionId), true);
  assert.equal(store.getSession(s.sessionId), null);
  assert.equal(store.stats().sessions, 0);
});

test('call contexts are capped like sessions, oldest first', () => {
  let t = 0;
  const store = createStore({ now: () => { t += 1; return t; }, maxEntries: 5 });
  for (let i = 0; i < 20; i += 1) store.createCall({ callId: `call_${i}` });
  const stats = store.stats();
  assert.ok(stats.calls <= 5, `expected the cap to hold, got ${stats.calls}`);
  assert.equal(store.getCall('call_0'), null, 'the oldest call went first');
  assert.ok(store.getCall('call_19'), 'the newest call is still there');
});

test('an authenticated flood of new call ids cannot grow memory without bound', () => {
  let t = 0;
  const store = createStore({ now: () => { t += 1; return t; }, maxEntries: 10 });
  for (let i = 0; i < 500; i += 1) store.addCard(`call_${i}`, card(`A${i}`));
  const stats = store.stats();
  assert.ok(stats.calls <= 10, `calls: ${stats.calls}`);
  assert.ok(stats.external <= 20, `external ids must not outlive their conversations: ${stats.external}`);
});

test('every eviction path takes the external key with it', () => {
  let t = 0;
  const store = createStore({ now: () => t, maxEntries: 5000 });
  const s = store.createSession({ chatId: 'chat_x' });
  store.createCall({ callId: 'call_x' });
  assert.equal(store.stats().external, 2);

  store.endSession(s.sessionId);
  assert.equal(store.stats().external, 1, 'ending a chat drops its chat_id mapping');

  const s2 = store.createSession({ chatId: 'chat_y' });
  t = TTL_MS + 1;
  store.getSession(s2.sessionId);          // expiry path
  store.getCall('call_x');                 // expiry path
  store.createCall({ callId: 'call_z' });  // sweeps
  assert.equal(store.stats().external, 1, 'only the new call is left');
  assert.equal(store.stats().sessions, 0);
});

test('a session evicted by the cap does not leave its chat_id behind', () => {
  let t = 0;
  const store = createStore({ now: () => { t += 1; return t; }, maxEntries: 3 });
  for (let i = 0; i < 30; i += 1) store.createSession({ chatId: `chat_${i}` });
  const stats = store.stats();
  assert.ok(stats.sessions <= 3, `sessions: ${stats.sessions}`);
  assert.ok(stats.external <= 6, `external: ${stats.external}`);
});
