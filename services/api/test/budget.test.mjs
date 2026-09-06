import test from 'node:test';
import assert from 'node:assert/strict';
import { createBudget, riyadhDay, RIYADH_OFFSET_MS } from '../lib/budget.mjs';

const HOUR = 60 * 60 * 1000;

test('the day boundary is midnight in Jeddah, not midnight UTC', () => {
  // 2026-09-06 21:30 UTC is already 2026-09-07 in Riyadh (UTC+3).
  assert.equal(riyadhDay(Date.parse('2026-09-06T21:30:00Z')), '2026-09-07');
  assert.equal(riyadhDay(Date.parse('2026-09-06T20:59:59Z')), '2026-09-06');
  assert.equal(RIYADH_OFFSET_MS, 3 * HOUR);
});

test('a budget spends exactly its ceiling, then refuses', () => {
  const budget = createBudget({ maxChats: 2, maxCalls: 1, now: () => 0 });
  assert.deepEqual([budget.takeChat(), budget.takeChat(), budget.takeChat()], [true, true, false]);
  assert.deepEqual([budget.takeCall(), budget.takeCall()], [true, false]);
  const c = budget.counters();
  assert.equal(c.chats, 2);
  assert.equal(c.calls, 1);
});

test('chat and call ceilings are independent', () => {
  const budget = createBudget({ maxChats: 1, maxCalls: 5, now: () => 0 });
  assert.equal(budget.takeChat(), true);
  assert.equal(budget.takeChat(), false);
  assert.equal(budget.takeCall(), true, 'a spent chat budget must not close voice as well');
});

test('an exhausted budget is logged once, not once per rejected request', () => {
  const lines = [];
  const budget = createBudget({ maxChats: 1, now: () => 0, log: (o) => lines.push(o) });
  budget.takeChat();
  for (let i = 0; i < 5; i += 1) budget.takeChat();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].evt, 'budget.exhausted');
  assert.equal(lines[0].kind, 'chats');
  assert.equal(lines[0].level, 'warn');
});

test('counters reset at the Riyadh midnight, and can trip again the next day', () => {
  let t = Date.parse('2026-09-06T12:00:00Z');
  const lines = [];
  const budget = createBudget({ maxChats: 1, now: () => t, log: (o) => lines.push(o) });
  assert.equal(budget.takeChat(), true);
  assert.equal(budget.takeChat(), false);
  t = Date.parse('2026-09-06T20:59:00Z');
  assert.equal(budget.takeChat(), false, 'still the same day in Jeddah');
  t = Date.parse('2026-09-06T21:01:00Z');
  assert.equal(budget.takeChat(), true, 'a new day in Jeddah, a fresh budget');
  assert.equal(budget.counters().day, '2026-09-07');
  assert.equal(budget.takeChat(), false);
  assert.equal(lines.length, 2, 'each day gets its own warning');
});
