import test from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, clientIp } from '../lib/ratelimit.mjs';

test('a bucket allows exactly `capacity` requests per window', () => {
  let t = 0;
  const limiter = createLimiter({ capacity: 3, perMs: 60_000, now: () => t });
  assert.deepEqual([1, 2, 3].map(() => limiter.take('ip').ok), [true, true, true]);
  const blocked = limiter.take('ip');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterS >= 1);
});

test('tokens refill over time', () => {
  let t = 0;
  const limiter = createLimiter({ capacity: 3, perMs: 60_000, now: () => t });
  for (let i = 0; i < 3; i += 1) limiter.take('ip');
  assert.equal(limiter.take('ip').ok, false);
  t = 20_000; // one third of the window => one token back
  assert.equal(limiter.take('ip').ok, true);
  assert.equal(limiter.take('ip').ok, false);
  t = 120_000; // full window and then some => back to capacity, never above it
  assert.deepEqual([1, 2, 3].map(() => limiter.take('ip').ok), [true, true, true]);
  assert.equal(limiter.take('ip').ok, false);
});

test('buckets are per key, so one visitor cannot lock out another', () => {
  let t = 0;
  const limiter = createLimiter({ capacity: 1, perMs: 60_000, now: () => t });
  assert.equal(limiter.take('a').ok, true);
  assert.equal(limiter.take('a').ok, false);
  assert.equal(limiter.take('b').ok, true);
});

test('idle buckets are swept so memory cannot grow without bound', () => {
  let t = 0;
  const limiter = createLimiter({ capacity: 5, perMs: 1000, now: () => t, maxKeys: 10 });
  for (let i = 0; i < 10; i += 1) limiter.take(`ip-${i}`);
  assert.equal(limiter.size(), 10);
  t = 100_000;
  for (let i = 10; i < 40; i += 1) limiter.take(`ip-${i}`);
  assert.ok(limiter.size() <= 31, `expected the sweep to bound growth, got ${limiter.size()}`);
});

test('capacity and window must be positive', () => {
  assert.throws(() => createLimiter({ capacity: 0, perMs: 1000 }), TypeError);
  assert.throws(() => createLimiter({ capacity: 5, perMs: 0 }), TypeError);
});

test('clientIp trusts CF-Connecting-IP first, then the first XFF hop', () => {
  assert.equal(clientIp({ headers: { 'cf-connecting-ip': '2.2.2.2', 'x-forwarded-for': '9.9.9.9' }, socket: {} }), '2.2.2.2');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '1.1.1.1, 10.0.0.1' }, socket: {} }), '1.1.1.1');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1');
  assert.equal(clientIp({ headers: {}, socket: {} }), 'unknown');
});
