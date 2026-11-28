/**
 * Dana's human timing and her caps by warm-up tier (DESIGN §6.2-6.3; PLAN T12 test 12). A fake
 * clock and a scripted random: nothing waits for real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPacing, tierIndex, BATCH_MIN_MS, BATCH_MAX_MS, BATCH_CAP_MS, TIERS, FIFO_GAP_MIN_MS, FIFO_GAP_MAX_MS } from '../lib/pacing.mjs';

const DAY = 86_400_000;
const LINKED = Date.parse('2026-11-26T02:25:00Z');

/** A fake clock whose sleep moves it; a random that plays a list (then 0.5). */
function rig({ randoms = [], linkedAt = LINKED } = {}) {
  let clock = LINKED + 1000;
  const slept = [];
  const rs = [...randoms];
  const p = createPacing({
    cfg: { waLinkedAt: linkedAt },
    now: () => clock,
    random: () => (rs.length ? rs.shift() : 0.5),
    sleep: async (ms) => { slept.push(ms); clock += ms; },
  });
  return { p, slept, now: () => clock, tick: (ms) => { clock += ms; } };
}

test('pacing: the batch is 4-7 s, restarted per message, never past 15 s after the first wake', () => {
  assert.deepEqual([BATCH_MIN_MS, BATCH_MAX_MS, BATCH_CAP_MS], [4000, 7000, 15_000]);
  const { p } = rig({ randoms: [0, 0.999999, 0.5] });
  assert.equal(p.batchMs(), 4000);
  assert.equal(p.batchMs(), 6999);
  assert.equal(p.batchMs(), 5500);
  // A restart per message: the delay from now, cut so the batch fires at most 15 s after the first wake.
  const r = rig({ randoms: [0.5, 0.5, 0.5] });
  assert.equal(r.p.batchDelay({ firstAt: 1000, at: 1000 }), 5500);
  assert.equal(r.p.batchDelay({ firstAt: 1000, at: 11_000 }), 5000, '15 s after the first wake');
  assert.equal(r.p.batchDelay({ firstAt: 1000, at: 17_000 }), 0, 'past the cap: at once');
});

test('pacing: the typing floor is newest client ts + clamp(2 s + 40 ms a character + U(0,3) s, 8 s, 25 s)', () => {
  const { p, now } = rig({ randoms: [0, 0, 0.5, 1 - 1e-9] });
  const t = now();
  assert.equal(p.typingFloorMs({ chars: 10, newestTs: t }), 8000, 'short: the 8 s floor (2.4 s raw)');
  assert.equal(p.typingFloorMs({ chars: 1000, newestTs: t }), 25_000, 'long: the 25 s ceiling');
  assert.equal(p.typingFloorMs({ chars: 200, newestTs: t }), 11_500, '2 + 8 + 1.5 s');
  assert.equal(p.typingFloorMs({ chars: 200, newestTs: t - 60_000 }), 0, 'long passed while the model answered');
  assert.equal(p.typingFloorMs({ chars: 0, newestTs: null }), 0, 'no client time: no floor');
});

test('pacing: the warm-up tiers by BONA_WA_LINKED_AT (days 0-7, 8-21, 22+); unset → the strictest', () => {
  assert.equal(tierIndex(LINKED, null), 0);
  assert.equal(tierIndex(LINKED + 7 * DAY + DAY - 1, LINKED), 0, 'day 7');
  assert.equal(tierIndex(LINKED + 8 * DAY, LINKED), 1, 'day 8');
  assert.equal(tierIndex(LINKED + 21 * DAY + DAY - 1, LINKED), 1, 'day 21');
  assert.equal(tierIndex(LINKED + 22 * DAY, LINKED), 2, 'day 22');
  assert.equal(tierIndex(LINKED - DAY, LINKED), 0, 'before the link: the strictest');
  const { p } = rig();
  assert.deepEqual(p.tier(LINKED + DAY), TIERS[0]);
  assert.deepEqual(p.tier(LINKED + 10 * DAY), TIERS[1]);
  assert.deepEqual(p.tier(LINKED + 30 * DAY), TIERS[2]);
  assert.deepEqual(rig({ linkedAt: null }).p.tier(LINKED + 30 * DAY), TIERS[0], 'unset: the strictest at any date');
  assert.deepEqual(TIERS.map((t) => t.PER_DAY), [60, 120, 200]);
  assert.deepEqual(TIERS.map((t) => t.SEND_PER_DAY), [100, 180, 300]);
  assert.deepEqual(TIERS.map((t) => t.FIFO_PER_HOUR), [40, 40, 60]);
  for (const t of TIERS) {
    assert.deepEqual([t.PER_CHAT_PER_10MIN, t.PER_CHAT_PER_HOUR, t.PER_CHAT_PER_DAY, t.MAX_LINKS, t.SEND_PER_MIN, t.FIFO_PER_MIN], [10, 20, 40, 2, 8, 8]);
  }
  p.tier(LINKED).PER_DAY = 1;
  assert.equal(p.tier(LINKED).PER_DAY, 60, 'a caller cannot change the caps for the next one');
});

test('pacing: the FIFO keeps a random 4-8 s gap between sends, one at a time, in order', async () => {
  assert.deepEqual([FIFO_GAP_MIN_MS, FIFO_GAP_MAX_MS], [4000, 8000]);
  const { p, slept, now } = rig({ randoms: [0, 0.999999, 0.5] });
  const order = [];
  const runs = [1, 2, 3, 4].map((n) => p.fifo(async () => { order.push([n, now()]); return n; }));
  assert.deepEqual(await Promise.all(runs), [1, 2, 3, 4]);
  assert.deepEqual(order.map(([n]) => n), [1, 2, 3, 4]);
  const gaps = order.slice(1).map(([, t], i) => t - order[i][1]);
  assert.deepEqual(gaps, [4000, 7999, 6000]);
  assert.deepEqual(slept, [4000, 7999, 6000], 'the first send does not wait');
  // A throwing send never jams the queue.
  await assert.rejects(p.fifo(() => { throw new Error('boom'); }));
  assert.equal(await p.fifo(() => 'next'), 'next');
});

test('pacing: the FIFO allows 8 a minute and 40 an hour (60 after day 21)', async () => {
  // Every gap at its minimum (4 s): the minute cap binds before the gap does.
  const { p, now } = rig({ randoms: Array(200).fill(0) });
  const at = [];
  for (let i = 0; i < 10; i += 1) await p.fifo(() => at.push(now()));
  const first = at[0];
  assert.ok(at.slice(0, 8).every((t) => t - first < 60_000), 'eight inside the first minute');
  assert.ok(at[8] - first >= 60_000, 'the ninth waits for the minute to free');
  // The hour: 40 sends, then the 41st waits until the first is an hour old.
  const h = rig({ randoms: Array(200).fill(0) });
  const hs = [];
  for (let i = 0; i < 41; i += 1) await h.p.fifo(() => hs.push(h.now()));
  assert.ok(hs[39] - hs[0] < 3_600_000);
  assert.ok(hs[40] - hs[0] >= 3_600_000, 'the 41st send waits for the hour');
  const late = rig({ randoms: Array(200).fill(0) });
  late.tick(30 * DAY);
  const ls = [];
  for (let i = 0; i < 41; i += 1) await late.p.fifo(() => ls.push(late.now()));
  assert.ok(ls[40] - ls[0] < 3_600_000, 'after day 21: 60 an hour');
});

test('pacing: with no clock of its own the module still answers (no deps)', async () => {
  const p = createPacing();
  const b = p.batchMs();
  assert.ok(b >= 4000 && b < 7000);
  assert.deepEqual(p.tier(Date.now()), TIERS[0], 'no BONA_WA_LINKED_AT: the strictest');
});
