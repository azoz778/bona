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
