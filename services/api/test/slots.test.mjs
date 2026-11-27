/**
 * PR-B1 (PLAN T10 test 2; DESIGN §8.2): the viewing slots, pure. Riyadh time is UTC+3 all year
 * (no daylight saving), so every fixture below is written as a Riyadh wall-clock time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRID_HOURS, MAX_PER_DAY, MAX_TOTAL, bookableDays, checkSlot, freeSlots, isFree, parseSlotId, riyadhDay, searchWindow,
  slotId, slotLabel, slotWhen,
} from '../lib/slots.mjs';

/** A Riyadh wall-clock time as epoch ms. */
const R = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h - 3, min);
const H = 3_600_000;
const M = 60_000;
const busy = (start, end) => ({ start, end });

test('the grid is 10, 12, 14, 16 and 18, and a slot id is the Riyadh wall time with +03:00', () => {
  assert.deepEqual(GRID_HOURS, [10, 12, 14, 16, 18]);
  assert.equal(slotId(R(2026, 11, 29, 10)), '2026-11-29T10:00+03:00');
  assert.equal(slotId(R(2026, 12, 3, 18)), '2026-12-03T18:00+03:00');
  assert.equal(parseSlotId('2026-11-29T10:00+03:00'), R(2026, 11, 29, 10));
  assert.equal(parseSlotId('2026-11-29T14:00+03:00'), R(2026, 11, 29, 14));
  for (const bad of ['2026-11-29T11:00+03:00', '2026-11-29T10:30+03:00', '2026-11-29T20:00+03:00', '2026-11-29T10:00Z',
    '2026-11-29T10:00+04:00', '2026-02-30T10:00+03:00', '2026-11-29 10:00', '', null, undefined, 42, {}]) {
    assert.equal(parseSlotId(bad), null, String(bad));
  }
  assert.equal(riyadhDay(R(2026, 11, 29, 0, 0)), '2026-11-29');
  assert.equal(riyadhDay(R(2026, 11, 29, 23, 59)), '2026-11-29');
});

test('Sun-Thu only, from tomorrow: Wed 23:59 → Thu is the first day; Thu 00:01 → the next Sunday', () => {
  assert.equal(bookableDays(R(2026, 12, 2, 23, 59))[0], '2026-12-03', 'Wednesday night: Thursday is tomorrow');
  assert.deepEqual(bookableDays(R(2026, 12, 3, 0, 1)), [
    '2026-12-06', '2026-12-07', '2026-12-08', '2026-12-09', '2026-12-10', '2026-12-13', '2026-12-14',
  ], 'Thursday just after midnight: Friday and Saturday are skipped, 7 bookable days');
  assert.equal(bookableDays(R(2026, 12, 2, 10)).includes('2026-12-02'), false, 'never today');
  for (const day of bookableDays(R(2026, 12, 2, 10))) {
    assert.ok([0, 1, 2, 3, 4].includes(new Date(`${day}T00:00:00Z`).getUTCDay()), `${day} is Sun-Thu`);
  }
  // A holiday is not a bookable day; the 7 days are found past it.
  const days = bookableDays(R(2026, 12, 3, 0, 1), { holidays: new Set(['2026-12-06', '2026-12-07']) });
  assert.equal(days.length, 7);
  assert.equal(days[0], '2026-12-08');
  assert.equal(days.includes('2026-12-06'), false);
});

test('checkSlot: on the grid, Sun-Thu, from tomorrow, not a holiday, not too far ahead', () => {
  const now = R(2026, 12, 2, 10); // a Wednesday
  assert.equal(checkSlot(R(2026, 12, 3, 10), { now }), null, 'Thursday 10:00 is fine');
  assert.equal(checkSlot(R(2026, 12, 2, 18), { now }), 'too_soon', 'today is never bookable');
  assert.equal(checkSlot(R(2026, 12, 1, 18), { now }), 'too_soon', 'the past is never bookable');
  assert.equal(checkSlot(R(2026, 12, 4, 10), { now }), 'slot', 'Friday');
  assert.equal(checkSlot(R(2026, 12, 5, 10), { now }), 'slot', 'Saturday');
  assert.equal(checkSlot(R(2026, 12, 3, 11), { now }), 'slot', 'off the grid');
  assert.equal(checkSlot(R(2026, 12, 3, 10), { now, holidays: new Set(['2026-12-03']) }), 'holiday');
  assert.equal(checkSlot(R(2027, 1, 31, 10), { now }), 'too_far');
  assert.equal(checkSlot(NaN, { now }), 'slot');
});

test('the buffer is half-open [S-30 min, S+90 min): 09:00-09:30 leaves 10:00 free; 09:00-09:31 and 11:00-11:30 do not', () => {
  const s = R(2026, 12, 6, 10);
  assert.equal(isFree(s, [busy(R(2026, 12, 6, 9, 0), R(2026, 12, 6, 9, 30))]), true);
  assert.equal(isFree(s, [busy(R(2026, 12, 6, 9, 0), R(2026, 12, 6, 9, 31))]), false);
  assert.equal(isFree(s, [busy(R(2026, 12, 6, 11, 0), R(2026, 12, 6, 11, 30))]), false);
  assert.equal(isFree(s, [busy(R(2026, 12, 6, 11, 30), R(2026, 12, 6, 12, 0))]), true, 'a block from S+90 min is outside');
  assert.equal(isFree(s, []), true);
});

test('a booking 10:00-11:00 keeps the 12:00 slot free (and takes 10:00 itself)', () => {
  const booked = [busy(R(2026, 12, 6, 10), R(2026, 12, 6, 11))];
  assert.equal(isFree(R(2026, 12, 6, 12), booked), true);
  assert.equal(isFree(R(2026, 12, 6, 10), booked), false);
  const got = freeSlots({ now: R(2026, 12, 3, 0, 1), busy: booked, maxPerDay: 5, maxTotal: 5 });
  assert.deepEqual(got.map((s) => s.slot_id), [
    '2026-12-06T12:00+03:00', '2026-12-06T14:00+03:00', '2026-12-06T16:00+03:00', '2026-12-06T18:00+03:00', '2026-12-07T10:00+03:00',
  ]);
});

test('an all-day opaque event blocks the day; a holiday blocks the day', () => {
  const now = R(2026, 12, 3, 0, 1);
  const allDay = [busy(R(2026, 12, 6, 0), R(2026, 12, 7, 0))];
  const a = freeSlots({ now, busy: allDay });
  assert.equal(a.some((s) => s.slot_id.startsWith('2026-12-06')), false);
  assert.equal(a[0].slot_id.startsWith('2026-12-07'), true);
  const b = freeSlots({ now, busy: [], holidays: new Set(['2026-12-06']) });
  assert.equal(b.some((s) => s.slot_id.startsWith('2026-12-06')), false);
  assert.equal(b[0].slot_id.startsWith('2026-12-07'), true);
});

test('at most 3 a day and 6 in total, spread over the day; past slots are never offered', () => {
  assert.equal(MAX_PER_DAY, 3);
  assert.equal(MAX_TOTAL, 6);
  const got = freeSlots({ now: R(2026, 12, 3, 0, 1), busy: [] });
  assert.equal(got.length, 6);
  const perDay = {};
  for (const s of got) perDay[s.slot_id.slice(0, 10)] = (perDay[s.slot_id.slice(0, 10)] ?? 0) + 1;
  assert.deepEqual(perDay, { '2026-12-06': 3, '2026-12-07': 3 });
  assert.deepEqual(got.slice(0, 3).map((s) => s.slot_id.slice(11, 16)), ['10:00', '14:00', '18:00'], 'morning, afternoon and evening');
  // With 12:00 and 16:00 left, both are offered.
  const two = freeSlots({
    now: R(2026, 12, 3, 0, 1),
    busy: [busy(R(2026, 12, 6, 9), R(2026, 12, 6, 11)), busy(R(2026, 12, 6, 14), R(2026, 12, 6, 15)), busy(R(2026, 12, 6, 18), R(2026, 12, 6, 19))],
    maxTotal: 2,
  });
  assert.deepEqual(two.map((s) => s.slot_id), ['2026-12-06T12:00+03:00', '2026-12-06T16:00+03:00']);
  const now = R(2026, 12, 6, 13);
  for (const s of freeSlots({ now, busy: [] })) assert.ok(parseSlotId(s.slot_id) > now + 6 * H, s.slot_id);
});

test('the labels come from code: AR "الأحد 29 نوفمبر 10:00 صباحاً", EN "Sunday 29 November, 10:00 am"', () => {
  assert.equal(slotLabel(R(2026, 11, 29, 10), 'ar'), 'الأحد 29 نوفمبر 10:00 صباحاً');
  assert.equal(slotLabel(R(2026, 11, 29, 10), 'en'), 'Sunday 29 November, 10:00 am');
  assert.equal(slotLabel(R(2026, 11, 29, 12), 'ar'), 'الأحد 29 نوفمبر 12:00 ظهراً');
  assert.equal(slotLabel(R(2026, 11, 29, 12), 'en'), 'Sunday 29 November, 12:00 pm');
  assert.equal(slotLabel(R(2026, 11, 29, 14), 'ar'), 'الأحد 29 نوفمبر 2:00 ظهراً');
  assert.equal(slotLabel(R(2026, 12, 3, 16), 'ar'), 'الخميس 3 ديسمبر 4:00 مساءً');
  assert.equal(slotLabel(R(2026, 12, 3, 18), 'en'), 'Thursday 3 December, 6:00 pm');
  // The confirmation's date and time (DESIGN §4.1): "الأحد 29 نوفمبر، 2:00 ظهراً" / "Sunday 29 November, 2:00 pm".
  assert.equal(slotWhen(R(2026, 11, 29, 14), 'ar'), 'الأحد 29 نوفمبر، 2:00 ظهراً');
  assert.equal(slotWhen(R(2026, 11, 29, 14), 'en'), 'Sunday 29 November, 2:00 pm');
  const [first] = freeSlots({ now: R(2026, 11, 26, 9), busy: [] });
  assert.deepEqual(first, { slot_id: '2026-11-29T10:00+03:00', label_ar: 'الأحد 29 نوفمبر 10:00 صباحاً', label_en: 'Sunday 29 November, 10:00 am' });
});

test('the freeBusy window covers the bookable days, Riyadh midnight to midnight', () => {
  assert.deepEqual(searchWindow(['2026-12-06', '2026-12-07', '2026-12-10']), {
    timeMin: '2026-12-06T00:00:00+03:00', timeMax: '2026-12-11T00:00:00+03:00',
  });
  assert.equal(searchWindow([]), null);
  assert.equal(M, 60_000);
});
