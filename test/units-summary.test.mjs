/** Pure unit-sheet summarising (src/lib/units-summary.mjs). Runs without dist/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unitSummary, sheetAgeDays, MAX_SHEET_AGE_DAYS } from '../src/lib/units-summary.mjs';

const u = (beds, cls, areaSqm, cash) => ({ beds, class: cls, areaSqm, price: { cash } });
const fixture = { listingId: 'BONA-W999', delivery: '2028-06', updated: '2026-09-02', units: [
  u(1, 'Standard', 60, 800000), u(1, 'Premium', 70, 750000), u(1, 'The Jewel', 85, 1000000),
  u(2, 'Standard', 95, 1100000), u(3, 'Premium', 130, 1400000),
  u(1, 'Penthouse', 58, 900000), u(2, 'Penthouse', 92, 1200000),
] };

test('one row per bedroom count, penthouses in their own row, sorted', () => {
  const s = unitSummary(fixture);
  assert.deepEqual(s.rows.map((r) => [r.key, r.count]), [['1', 3], ['2', 1], ['3', 1], ['penthouse', 2]]);
});

test('row maths: min/max area and the lowest cash price', () => {
  const [one, , , ph] = unitSummary(fixture).rows;
  assert.equal(one.areaMin, 60); assert.equal(one.areaMax, 85); assert.equal(one.cashFrom, 750000);
  assert.equal(ph.areaMin, 58); assert.equal(ph.areaMax, 92); assert.equal(ph.cashFrom, 900000);
});

test('labels are bilingual and the penthouse label carries its bed range', () => {
  const rows = unitSummary(fixture).rows;
  assert.equal(rows[0].label.en, '1 bedroom'); assert.equal(rows[0].label.ar, 'غرفة نوم واحدة');
  assert.equal(rows[1].label.en, '2 bedrooms'); assert.equal(rows[1].label.ar, 'غرفتا نوم');
  assert.equal(rows[2].label.en, '3 bedrooms'); assert.equal(rows[2].label.ar, '3 غرف نوم');
  assert.equal(rows[3].label.en, 'Penthouse, 1–2 bedrooms'); assert.equal(rows[3].label.ar, 'بنتهاوس، 1–2 غرف نوم');
});

test('totals cover every unit', () => {
  const s = unitSummary(fixture);
  assert.deepEqual([s.count, s.areaMin, s.areaMax, s.cashFrom], [7, 58, 130, 750000]);
  assert.equal(s.delivery, '2028-06'); assert.equal(s.updated, '2026-09-02');
});

test('no record or no units gives null', () => {
  assert.equal(unitSummary(null), null);
  assert.equal(unitSummary({ ...fixture, units: [] }), null);
});

test('a unit with no cash price is ignored rather than shown as 0', () => {
  const s = unitSummary({ ...fixture, units: [...fixture.units, u(1, 'Standard', 50, null)] });
  assert.equal(s.count, 7); assert.equal(s.areaMin, 58);
});

test('sheet age in whole days, and the limit is 90', () => {
  assert.equal(sheetAgeDays('2026-09-02', new Date('2026-10-02T12:00:00Z')), 30);
  assert.equal(MAX_SHEET_AGE_DAYS, 90);
});

test('the real Darco sheet summarises to the published figures', () => {
  const rec = JSON.parse(readFileSync(new URL('../src/data/units.json', import.meta.url), 'utf8'));
  const s = unitSummary(rec);
  assert.deepEqual(s.rows.map((r) => [r.key, r.count, r.areaMin, r.areaMax, r.cashFrom]), [
    ['1', 64, 55.45, 85.01, 708164], ['2', 35, 88.94, 106.29, 1036286],
    ['3', 9, 123.49, 139.39, 1346754], ['penthouse', 3, 57.82, 91.56, 881368],
  ]);
  assert.deepEqual([s.count, s.cashFrom], [111, 708164]);
});
