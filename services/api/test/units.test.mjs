import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createUnits, money, WORKTREE_UNITS } from '../lib/units.mjs';
import { liveSummary, unitSummary } from '../lib/units-summary.mjs';

// Refs and amounts are made up: the public repo must not carry a real unit's unpublished prices in a fixture
// (the last test checks them against the real sheet).
const FIXTURE = {
  listingId: 'BONA-W014',
  project: { en: 'Darco Prime Waterfront', ar: 'داركو برايم' },
  district: { en: 'Al-Shati District', ar: 'حي الشاطئ' },
  city: { en: 'Jeddah', ar: 'جدة' },
  delivery: '2028-06',
  currency: 'SAR',
  updated: '2026-09-02',
  units: [
    {
      ref: 'B91-22', building: 'B91', unit: '22',
      floor: { en: '3rd', ar: 'الدور الثالث' }, floorIndex: 3,
      facing: { en: 'South', ar: 'جنوبية' }, beds: 1, baths: 2, maidRoom: false,
      class: 'Standard', type: { en: 'Apartment', ar: 'شقة' }, areaSqm: 54.25, roofSqm: 0,
      feature: { en: 'Main garden', ar: 'حديقة رئيسية' },
      price: { cash: 701500, half: 716500, year: 771500, twoYear: 806500 },
    },
    {
      ref: 'B92-2', building: 'B92', unit: '2',
      floor: { en: 'Ground', ar: 'الدور الارضي' }, floorIndex: 0,
      facing: { en: 'South', ar: 'جنوبية' }, beds: 3, baths: 4, maidRoom: true,
      class: 'Standard', type: { en: 'Apartment', ar: 'شقة' }, areaSqm: 121.75, roofSqm: 0,
      feature: { en: 'Street', ar: 'شارع' },
      price: { cash: 1351500, half: 1381500, year: 1486500, twoYear: 1554500 },
    },
    {
      // no cash price — must never be published or counted
      ref: 'B99-1', building: 'B99', unit: '1',
      floor: { en: '1st', ar: 'الدور الاول' }, floorIndex: 1,
      facing: { en: 'North', ar: 'شمالية' }, beds: 2, baths: 3, maidRoom: false,
      class: 'Premium', type: { en: 'Apartment', ar: 'شقة' }, areaSqm: 90, roofSqm: 0,
      feature: { en: 'Street', ar: 'شارع' },
      price: { cash: null, half: null, year: null, twoYear: null },
    },
  ],
};

function withFile(doc, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-units-'));
  const file = path.join(dir, 'units.json');
  fs.writeFileSync(file, JSON.stringify(doc));
  try { return fn(file, dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('units', () => {
  it('drops a unit with no published price — the sheet is the only source (TAQEEM)', () => {
    withFile(FIXTURE, (file) => {
      const u = createUnits({ file });
      const s = u.summary('BONA-W014');
      assert.equal(s.available, 2, 'the priceless unit is not stock we can quote');
      assert.equal(u.search({ listingId: 'BONA-W014' }).total, 2);
    });
  });

  it('answers "which units and how much" by beds and budget', () => {
    withFile(FIXTURE, (file) => {
      const u = createUnits({ file });
      const { units, total } = u.search({ listingId: 'BONA-W014', beds: 3 });
      assert.equal(total, 1);
      const row = u.toRow(units[0], 'cash');
      assert.equal(row.ref, 'B92-2');
      assert.equal(row.price_en, 'SAR 1,351,500');
      assert.equal(row.maid_room, true);
      assert.equal(u.search({ listingId: 'BONA-W014', maxPrice: 800000 }).total, 1);
    });
  });

  it('quotes the plan that was asked for, not always cash', () => {
    withFile(FIXTURE, (file) => {
      const u = createUnits({ file });
      const { units } = u.search({ listingId: 'BONA-W014', beds: 1, plan: 'twoYear' });
      const row = u.toRow(units[0], 'twoYear');
      assert.equal(row.plan, 'twoYear');
      assert.equal(row.price_en, 'SAR 806,500');
      assert.equal(row.price_cash_en, 'SAR 701,500', 'cash stays visible for comparison');
    });
  });

  it('matches floor and facing in either language', () => {
    withFile(FIXTURE, (file) => {
      const u = createUnits({ file });
      assert.equal(u.search({ listingId: 'BONA-W014', floor: '3rd' }).total, 1);
      assert.equal(u.search({ listingId: 'BONA-W014', floor: 'الدور الثالث' }).total, 1);
      assert.equal(u.search({ listingId: 'BONA-W014', facing: 'South' }).total, 2);
      assert.equal(u.search({ listingId: 'BONA-W014', building: 'b91' }).total, 1, 'building match is case-insensitive');
    });
  });

  it('returns nothing for a listing that has no stock list, rather than another project\'s units', () => {
    withFile(FIXTURE, (file) => {
      const u = createUnits({ file });
      assert.equal(u.summary('BONA-005'), null);
      assert.equal(u.search({ listingId: 'BONA-005' }).total, 0);
    });
  });

  it('summarises availability per bedroom count for "what do you have?"', () => {
    withFile(FIXTURE, (file) => {
      const u = createUnits({ file });
      const s = u.summary('BONA-W014');
      assert.deepEqual(s.beds_available, [1, 3]);
      assert.equal(s.by_beds[1].count, 1);
      assert.equal(s.by_beds[3].from_en, 'SAR 1,351,500');
      assert.equal(s.price_from_en, 'SAR 701,500');
      assert.equal(s.delivery, '2028-06');
      assert.equal(s.updated, '2026-09-02', 'the sheet date, so staleness is visible');
    });
  });

  it('sorts by price and caps the result set', () => {
    withFile(FIXTURE, (file) => {
      const u = createUnits({ file });
      const { units } = u.search({ listingId: 'BONA-W014', limit: 50 });
      assert.deepEqual(units.map((x) => x.ref), ['B91-22', 'B92-2']);
      assert.equal(u.search({ listingId: 'BONA-W014', limit: 1 }).units.length, 1);
    });
  });

  it('survives a missing or broken file instead of taking the API down', () => {
    const u = createUnits({ file: '/nonexistent/units.json' });
    assert.equal(u.summary('BONA-W014'), null);
    assert.deepEqual(u.search({ listingId: 'BONA-W014' }).units, []);
  });

  it('formats money the same way in both locales, Western digits', () => {
    assert.equal(money(701500, 'en'), 'SAR 701,500');
    assert.equal(money(701500, 'ar'), '701,500 ر.س');
    assert.equal(money(null), null);
  });
});

// lib/units-summary.mjs: the copy of the site's per-bedroom summary that search_units publishes (DESIGN §4.5).
// These run everywhere, the VPS included, where the parity test against src/lib is skipped (NO_SRC_LIB).
describe('units-summary (the published per-bedroom "from" rows)', () => {
  const NOW = new Date('2026-11-27T09:00:00Z');
  const AVAILABLE = { id: 'BONA-W014', status: 'available' };
  const PENTHOUSE = {
    ref: 'B07-31', building: 'B07', unit: '31', floor: { en: 'Roof', ar: 'السطح' }, floorIndex: 7,
    facing: { en: 'West', ar: 'غربية' }, beds: 2, baths: 3, maidRoom: true, class: 'Penthouse',
    type: { en: 'Penthouse', ar: 'بنتهاوس' }, areaSqm: 210.5, roofSqm: 80, feature: { en: 'Sea', ar: 'بحر' },
    price: { cash: 2100000, half: 2145000, year: 2310000, twoYear: 2415000 },
  };

  it('gives one row per bedroom count, penthouses apart, with the lowest cash price and the area range', () => {
    const s = unitSummary({ ...FIXTURE, units: [...FIXTURE.units, PENTHOUSE] });
    assert.deepEqual(s.rows, [
      { key: '1', label: { en: '1 bedroom', ar: 'غرفة نوم واحدة' }, count: 1, areaMin: 54.25, areaMax: 54.25, cashFrom: 701500 },
      { key: '3', label: { en: '3 bedrooms', ar: '3 غرف نوم' }, count: 1, areaMin: 121.75, areaMax: 121.75, cashFrom: 1351500 },
      { key: 'penthouse', label: { en: 'Penthouse, 2 bedrooms', ar: 'بنتهاوس، غرفتا نوم' }, count: 1, areaMin: 210.5, areaMax: 210.5, cashFrom: 2100000 },
    ]);
    assert.equal(s.count, 3, 'the unit with no cash price is not counted');
    assert.equal(s.delivery, '2028-06');
    assert.equal(s.updated, '2026-09-02');
  });

  it('publishes nothing for a listing that is not available, or a sheet dated in the future or impossible', () => {
    assert.ok(liveSummary(FIXTURE, AVAILABLE, NOW), 'a current sheet on an available listing is published');
    assert.equal(liveSummary(FIXTURE, { ...AVAILABLE, status: 'sold' }, NOW), null);
    assert.equal(liveSummary(FIXTURE, null, NOW), null, 'no listing, nothing published');
    assert.equal(liveSummary(null, AVAILABLE, NOW), null);
    assert.equal(liveSummary({ ...FIXTURE, updated: '2026-12-30' }, AVAILABLE, NOW), null, 'a future sheet date');
    assert.equal(liveSummary({ ...FIXTURE, updated: '2026-02-30' }, AVAILABLE, NOW), null, 'an impossible sheet date');
    assert.ok(liveSummary({ ...FIXTURE, updated: '2025-01-01' }, AVAILABLE, NOW), 'an old sheet still shows (owner decision 2026-10-02)');
  });

  it('drops an impossible delivery date instead of rolling it over', () => {
    assert.equal(unitSummary({ ...FIXTURE, delivery: '2028-13' }).delivery, null);
    assert.equal(unitSummary({ ...FIXTURE, delivery: '2028-02-30' }).delivery, null);
    assert.equal(unitSummary({ ...FIXTURE, delivery: '2028-02-29' }).delivery, '2028-02-29');
  });

  it('summarises the record units.mjs serves (priced units only) exactly like the raw sheet', () => {
    withFile(FIXTURE, (file) => {
      const served = createUnits({ file }).forListing('BONA-W014');
      assert.deepEqual(liveSummary(served, AVAILABLE, NOW), liveSummary(FIXTURE, AVAILABLE, NOW));
      assert.equal(createUnits({ file }).forListing('BONA-005'), null);
    });
  });

  it('reads units.json as an array of sheets, one per project, like the listing page (src/lib recordFor)', () => {
    const other = { ...FIXTURE, listingId: 'BONA-W999', updated: '2026-10-01', units: [{ ...FIXTURE.units[1], ref: 'B93-14' }] };
    withFile([other, FIXTURE], (file) => {
      const u = createUnits({ file });
      const w014 = u.forListing('BONA-W014');
      assert.equal(w014?.listingId, 'BONA-W014', 'the second record of the array');
      assert.deepEqual(w014.units.map((x) => x.ref), ['B91-22', 'B92-2'], 'priced units only');
      assert.deepEqual(liveSummary(w014, AVAILABLE, NOW), liveSummary(FIXTURE, AVAILABLE, NOW));
      assert.equal(u.forListing('BONA-W999')?.updated, '2026-10-01', 'each project its own sheet');
      assert.equal(u.forListing('BONA-005'), null);
      assert.equal(u.forListing(''), null);
      // The veto path reads the same records.
      assert.equal(u.summary('BONA-W014').available, 2);
      assert.equal(u.summary('BONA-W999').available, 1);
      assert.equal(u.summary('BONA-005'), null);
      assert.equal(u.search({ listingId: 'BONA-W014' }).total, 2);
      assert.deepEqual(u.search({ listingId: 'BONA-W999' }).units.map((x) => x.ref), ['B93-14']);
      assert.equal(u.search({ listingId: 'BONA-005' }).total, 0);
    });
  });

  it('the fixture is made up: no unit ref or price of it is on the real sheet (src/data/units.json)', () => {
    const real = [JSON.parse(fs.readFileSync(WORKTREE_UNITS, 'utf8'))].flat().flatMap((r) => r?.units ?? []);
    assert.ok(real.length > 0, 'the real sheet has units');
    const refs = new Set(real.map((x) => x.ref));
    const amounts = new Set(real.flatMap((x) => Object.values(x.price ?? {})).filter((n) => typeof n === 'number'));
    for (const x of [...FIXTURE.units, PENTHOUSE]) {
      assert.ok(!refs.has(x.ref), `${x.ref} is a real unit reference`);
      for (const [plan, amount] of Object.entries(x.price)) assert.ok(!amounts.has(amount), `${x.ref} ${plan} ${amount} is a real price`);
    }
  });
});
