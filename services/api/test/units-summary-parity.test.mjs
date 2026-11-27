// lib/units-summary.mjs is a copy of the site's src/lib/units-summary.mjs (unitSummary, liveSummary and the
// date checks they use), because the VPS runs bona-api from a sparse checkout (services + src/data) with no
// src/lib (DESIGN §4.5). search_units quotes what the LIVE listing page carries in its data-units-summary
// attribute (lib/published-units.mjs), and checks it against this copy (row labels, dates). So this test checks
// that the copy matches the site on the W014 sheet and on the edge cases the site already handles, that the
// attribute the page builds (src/lib unitsSummaryData) is read back exactly, and that the labels the API accepts
// are the site's. On the VPS sparse checkout it is skipped (NO_SRC_LIB); anywhere else (the PC, a worktree, CI)
// a missing src/lib fails the import below. Every comparison is a boolean: the values are the real sheet's
// (public CI logs).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspect, isDeepStrictEqual } from 'node:util';
import test from 'node:test';
import { isBedLabel, parsePublishedUnits } from '../lib/published-units.mjs';
import * as api from '../lib/units-summary.mjs';
import { createUnits, WORKTREE_UNITS } from '../lib/units.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const SITE_LIB = path.join(REPO_ROOT, 'src/lib/units-summary.mjs');
/** True when the checkout at `root` is sparse. A linked worktree's `.git` is a file ("gitdir: <path>") naming its
    own git dir, and that is where `git sparse-checkout` keeps the pattern file. */
function isSparseCheckout(root) {
  const dotGit = path.join(root, '.git');
  let gitDir = dotGit;
  try {
    if (statSync(dotGit).isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
      if (m) gitDir = path.resolve(root, m[1]);
    }
  } catch { return false; }
  return existsSync(path.join(gitDir, 'info', 'sparse-checkout'));
}
const SPARSE = isSparseCheckout(REPO_ROOT);
const NO_SRC_LIB = SPARSE && !existsSync(SITE_LIB);

// units.json is one record today and an array once a second project has a sheet: the W014 record from either.
const UNITS_FILE = JSON.parse(readFileSync(WORKTREE_UNITS, 'utf8'));
const W014 = [UNITS_FILE].flat().find((r) => r?.listingId === 'BONA-W014');
const LISTINGS = JSON.parse(readFileSync(path.join(REPO_ROOT, 'src/data/listings.json'), 'utf8'));
const LISTING = LISTINGS.find((l) => l.id === 'BONA-W014') ?? { id: 'BONA-W014', status: 'available' };
const DAY = 24 * 3_600_000;
/** The clock the checks run at: two days after the real sheet's date, and never before 2026-11-27T09:00Z (a sheet
    without a real date keeps that). A refreshed sheet, whatever its date, is then one the page shows, and the cases
    that move the date (a sheet dated in the future) are built from this clock, not a fixed day. */
function sheetClock(updated) {
  const fixed = Date.parse('2026-11-27T09:00:00Z');
  return api.isSheetDate(updated) ? Math.max(fixed, Date.parse(`${updated}T00:00:00Z`) + 2 * DAY) : fixed;
}
const NOW = new Date(sheetClock(W014?.updated));
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
/** Astro's attribute escaping (html-escaper): & < > ' " become entities. */
const escapeAttr = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
const ATTR_KEYS = ['areaMax', 'areaMin', 'cashFrom', 'count', 'delivery', 'listingId', 'rows', 'updated'];
const ATTR_ROW_KEYS = ['areaMax', 'areaMin', 'cashFrom', 'count', 'label'];

/** Every value compared here comes from the real W014 sheet (unit refs, unpublished instalment prices), and a failing
    assertion prints in a public CI log: compare to a boolean, so a failure shows its message and never either value. */
function assertSame(a, b, what) {
  assert.ok(isDeepStrictEqual(a, b), `${what}: the API side differs from the site`);
}

/** Variants of the W014 sheet that hit each branch of the site's code, and whether the page then publishes a summary
    search_units reads back (no table: nothing; a row label that is not a whole bedroom count: refused). */
function cases() {
  const units = W014.units;
  const penthouse = (beds, cash, ref) => ({ ...units[0], ref, class: 'Penthouse', beds, areaSqm: 210.5, price: { ...units[0].price, cash } });
  const standard = units.find((x) => x.class !== 'Penthouse');
  const available = { ...LISTING, status: 'available' };
  return [
    ['the W014 sheet', W014, available, true],
    ['the W014 sheet on a listing that is not available', W014, { ...LISTING, status: 'sold' }, false],
    ['a sheet dated in the future', { ...W014, updated: isoDay(NOW.getTime() + 30 * DAY) }, available, false],
    ['an impossible sheet date', { ...W014, updated: '2026-02-30' }, available, false],
    ['an impossible delivery', { ...W014, delivery: '2028-13' }, available, true],
    ['a delivery given as a day', { ...W014, delivery: '2028-02-29' }, available, true],
    ['units without a cash price or an area', { ...W014, units: [...units.slice(0, 5), { ...units[0], price: { ...units[0].price, cash: null } }, { ...units[1], areaSqm: null }, { ...units[2], price: { ...units[2].price, cash: 0 } }] }, available, true],
    ['penthouses of one size', { ...W014, units: [...units.slice(0, 4), penthouse(2, 2_100_000, 'B07-31'), penthouse(2, 2_450_000, 'B07-32')] }, available, true],
    ['penthouses of 1–2 bedrooms', { ...W014, units: [...units.slice(0, 4), penthouse(1, 1_900_000, 'B07-31'), penthouse(2, 2_450_000, 'B07-32')] }, available, true],
    ['penthouses of 3–11 bedrooms', { ...W014, units: [...units.slice(0, 4), penthouse(3, 3_100_000, 'B07-31'), penthouse(11, 9_450_000, 'B07-32')] }, available, true],
    // build-units.py writes beds: null for a blank bedroom cell. On a penthouse the page keeps the unit in the penthouse
    // row (and its price can be the row's "from"): the API reads that same row.
    ['a penthouse with a blank bedroom cell', { ...W014, units: [...units, penthouse(null, 1_000, 'B07-33')] }, available, true],
    // On any other unit the page prints a "null bedrooms" row: the API refuses that label and quotes nothing.
    ['a standard unit with a blank bedroom cell', { ...W014, units: [...units, { ...standard, ref: 'B07-34', beds: null }] }, available, false],
    ['a sheet with no priced unit', { ...W014, units: [] }, available, false],
    ['no sheet at all', null, available, false],
  ];
}

test('assertSame fails without printing either value (public CI logs)', () => {
  const unit = W014.units[0];
  let err = null;
  try { assertSame(W014, { ...W014, units: [] }, 'a record'); } catch (e) { err = e; }
  assert.ok(err instanceof assert.AssertionError, 'a difference fails');
  const shown = `${err.message}\n${inspect(err)}`;
  assert.ok(![unit.ref, ...Object.values(unit.price).filter(Number.isFinite).map(String)].some((v) => shown.includes(v)),
    'the failure output shows no unit ref or price');
});

test('lib/units-summary.mjs publishes exactly what src/lib/units-summary.mjs publishes (W014 sheet and edge cases)', { skip: NO_SRC_LIB ? 'NO_SRC_LIB' : false }, async () => {
  const site = await import(pathToFileURL(SITE_LIB).href);
  assert.ok(W014?.units?.length > 0, 'units.json has a W014 sheet with units');
  // The page reads the file as it stands, whichever shape: the same record the API copy finds.
  assertSame(api.recordFor(UNITS_FILE, W014.listingId), site.recordFor(UNITS_FILE, W014.listingId), 'recordFor on units.json');
  for (const [name, record, listing] of cases()) {
    assertSame(api.unitSummary(record), site.unitSummary(record), `unitSummary: ${name}`);
    assertSame(api.liveSummary(record, listing, NOW), site.liveSummary(record, listing, NOW), `liveSummary: ${name}`);
    for (const [i, s] of [record?.updated, record?.delivery].entries()) {
      assert.equal(api.isSheetDate(s), site.isSheetDate(s), `isSheetDate(date #${i}): ${name}`);
      assert.equal(api.isDeliveryDate(s), site.isDeliveryDate(s), `isDeliveryDate(date #${i}): ${name}`);
    }
    assert.equal(api.isSheetCurrent(record, NOW), site.isSheetCurrent(record, NOW), `isSheetCurrent: ${name}`);
  }
  // units.json as one record today, an array once a second project has a sheet.
  for (const data of [W014, [{ listingId: 'BONA-W999', units: [] }, W014]]) {
    assertSame(api.recordFor(data, W014.listingId), site.recordFor(data, W014.listingId), 'recordFor W014');
    assertSame(api.recordFor(data, 'BONA-005'), site.recordFor(data, 'BONA-005'), 'recordFor a listing without a sheet');
  }
  // The same through the production loader once units.json is an array (a second project has a sheet).
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bona-units-array-'));
  try {
    const data = [{ ...W014, listingId: 'BONA-W999', units: W014.units.slice(0, 3) }, W014];
    const file = path.join(dir, 'units.json');
    writeFileSync(file, JSON.stringify(data));
    const loader = createUnits({ file });
    for (const id of [W014.listingId, 'BONA-W999']) {
      assertSame(api.liveSummary(loader.forListing(id), { id, status: 'available' }, NOW),
        site.liveSummary(site.recordFor(data, id), { id, status: 'available' }, NOW), `array units.json: ${id}`);
    }
    assert.ok(loader.forListing('BONA-005') === null && site.recordFor(data, 'BONA-005') === null, 'array units.json: no sheet for BONA-005');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the attribute the listing page builds (src/lib unitsSummaryData) is read back by lib/published-units.mjs exactly, or refused; its labels are the site\'s', { skip: NO_SRC_LIB ? 'NO_SRC_LIB' : false }, async () => {
  const site = await import(pathToFileURL(SITE_LIB).href);
  for (const [name, record, listing, published] of cases()) {
    const live = site.liveSummary(record, listing, NOW);
    const data = live ? site.unitsSummaryData(live, W014.listingId) : null;
    assert.equal(data !== null, live !== null, `${name}: an attribute exactly when the page shows the table`);
    if (data) {
      assert.ok(isDeepStrictEqual(Object.keys(data).sort(), ATTR_KEYS), `${name}: the attribute's keys`);
      assert.ok(data.rows.every((r) => isDeepStrictEqual(Object.keys(r).sort(), ATTR_ROW_KEYS)), `${name}: the attribute's row keys`);
    }
    // The page as Astro writes it: the JSON in a double-quoted, entity-escaped attribute on the table's container.
    const html = data
      ? `<section data-project-details><div class="mt-5 overflow-x-auto" data-units-summary="${escapeAttr(JSON.stringify(data))}"><table></table></div></section>`
      : '<main><h1>No table</h1></main>';
    const read = parsePublishedUnits(html, W014.listingId);
    assert.equal(read !== null, published, `${name}: read back`);
    if (published) assertSame(read, data, `${name}: read back exactly`);
    assert.equal(parsePublishedUnits(html, 'BONA-W999'), null, `${name}: never as another listing's`);
  }
  // The row labels the reader accepts are the site's own: every whole bedroom count 0..20 and penthouse range, and
  // not the label a blank, a unit ref, a fraction or a negative count gives.
  const unit = (beds, cls) => ({ beds, class: cls, areaSqm: 1, price: { cash: 1 } });
  for (let lo = 0; lo <= 20; lo++) {
    assert.ok(isBedLabel(site.unitSummary({ units: [unit(lo, 'Standard')] }).rows[0].label), `${lo} bedrooms`);
    for (let hi = lo; hi <= 20; hi++) {
      assert.ok(isBedLabel(site.unitSummary({ units: [unit(lo, 'Penthouse'), unit(hi, 'Penthouse')] }).rows[0].label), `penthouse ${lo}–${hi}`);
    }
  }
  for (const beds of [null, 'B91-24', 1.5, -1, 21]) {
    assert.ok(!isBedLabel(site.unitSummary({ units: [unit(beds, 'Standard')] }).rows[0].label), `the site's label for beds ${String(beds)} is refused`);
  }
});

test('the NO_SRC_LIB check finds a sparse checkout in a plain clone and in a linked worktree (.git is a file)', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'bona-sparse-'));
  try {
    const plain = path.join(base, 'plain');
    mkdirSync(path.join(plain, '.git', 'info'), { recursive: true });
    assert.equal(isSparseCheckout(plain), false, 'a full clone');
    writeFileSync(path.join(plain, '.git', 'info', 'sparse-checkout'), '/services/\n');
    assert.equal(isSparseCheckout(plain), true, 'a sparse clone');
    const wtGit = path.join(plain, '.git', 'worktrees', 'wt');
    mkdirSync(path.join(wtGit, 'info'), { recursive: true });
    for (const [name, gitdir] of [['abs', wtGit], ['rel', path.relative(path.join(base, 'rel'), wtGit)]]) {
      const wt = path.join(base, name);
      mkdirSync(wt, { recursive: true });
      writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`);
      assert.equal(isSparseCheckout(wt), false, `${name}: a full linked worktree`);
      writeFileSync(path.join(wtGit, 'info', 'sparse-checkout'), '/services/\n');
      assert.equal(isSparseCheckout(wt), true, `${name}: a sparse linked worktree`);
      rmSync(path.join(wtGit, 'info', 'sparse-checkout'));
    }
    assert.equal(isSparseCheckout(path.join(base, 'none')), false, 'no git at all');
  } finally { rmSync(base, { recursive: true, force: true }); }
});
