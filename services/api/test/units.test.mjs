import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createUnits, money } from '../lib/units.mjs';

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
      ref: 'B08-22', building: 'B08', unit: '22',
      floor: { en: '3rd', ar: 'الدور الثالث' }, floorIndex: 3,
      facing: { en: 'South', ar: 'جنوبية' }, beds: 1, baths: 2, maidRoom: false,
      class: 'Standard', type: { en: 'Apartment', ar: 'شقة' }, areaSqm: 55.45, roofSqm: 0,
      feature: { en: 'Main garden', ar: 'حديقة رئيسية' },
      price: { cash: 708164, half: 723567, year: 778981, twoYear: 814389 },
    },
    {
      ref: 'B06-2', building: 'B06', unit: '2',
      floor: { en: 'Ground', ar: 'الدور الارضي' }, floorIndex: 0,
      facing: { en: 'South', ar: 'جنوبية' }, beds: 3, baths: 4, maidRoom: true,
      class: 'Standard', type: { en: 'Apartment', ar: 'شقة' }, areaSqm: 123.49, roofSqm: 0,
      feature: { en: 'Street', ar: 'شارع' },
      price: { cash: 1359547, half: 1389117, year: 1495502, twoYear: 1563479 },
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
      assert.equal(row.ref, 'B06-2');
      assert.equal(row.price_en, 'SAR 1,359,547');
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
      assert.equal(row.price_en, 'SAR 814,389');
      assert.equal(row.price_cash_en, 'SAR 708,164', 'cash stays visible for comparison');
    });
  });

  it('matches floor and facing in either language', () => {
    withFile(FIXTURE, (file) => {
      const u = createUnits({ file });
      assert.equal(u.search({ listingId: 'BONA-W014', floor: '3rd' }).total, 1);
      assert.equal(u.search({ listingId: 'BONA-W014', floor: 'الدور الثالث' }).total, 1);
      assert.equal(u.search({ listingId: 'BONA-W014', facing: 'South' }).total, 2);
      assert.equal(u.search({ listingId: 'BONA-W014', building: 'b08' }).total, 1, 'building match is case-insensitive');
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
      assert.equal(s.by_beds[3].from_en, 'SAR 1,359,547');
      assert.equal(s.price_from_en, 'SAR 708,164');
      assert.equal(s.delivery, '2028-06');
      assert.equal(s.updated, '2026-09-02', 'the sheet date, so staleness is visible');
    });
  });

  it('sorts by price and caps the result set', () => {
    withFile(FIXTURE, (file) => {
      const u = createUnits({ file });
      const { units } = u.search({ listingId: 'BONA-W014', limit: 50 });
      assert.deepEqual(units.map((x) => x.ref), ['B08-22', 'B06-2']);
      assert.equal(u.search({ listingId: 'BONA-W014', limit: 1 }).units.length, 1);
    });
  });

  it('survives a missing or broken file instead of taking the API down', () => {
    const u = createUnits({ file: '/nonexistent/units.json' });
    assert.equal(u.summary('BONA-W014'), null);
    assert.deepEqual(u.search({ listingId: 'BONA-W014' }).units, []);
  });

  it('formats money the same way in both locales, Western digits', () => {
    assert.equal(money(708164, 'en'), 'SAR 708,164');
    assert.equal(money(708164, 'ar'), '708,164 ر.س');
    assert.equal(money(null), null);
  });
});
