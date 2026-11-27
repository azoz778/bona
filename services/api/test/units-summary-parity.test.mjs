// lib/units-summary.mjs is a copy of the site's src/lib/units-summary.mjs (unitSummary, liveSummary and the
// date checks they use), because the VPS runs bona-api from a sparse checkout (services + src/data) with no
// src/lib (DESIGN §4.5). The copy must publish exactly what the listing page publishes, so this test runs
// both on the W014 sheet and on the edge cases the site already handles. On the VPS sparse checkout it is
// skipped (NO_SRC_LIB); anywhere else (the PC, a worktree, CI) a missing src/lib fails the import below.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
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

const W014 = JSON.parse(readFileSync(WORKTREE_UNITS, 'utf8'));
const LISTINGS = JSON.parse(readFileSync(path.join(REPO_ROOT, 'src/data/listings.json'), 'utf8'));
const LISTING = LISTINGS.find((l) => l.id === W014.listingId) ?? { id: W014.listingId, status: 'available' };
const NOW = new Date('2026-11-27T09:00:00Z');

/** Variants of the W014 sheet that hit each branch of the site's code. */
function cases() {
  const units = W014.units;
  const penthouse = (beds, cash, ref) => ({ ...units[0], ref, class: 'Penthouse', beds, areaSqm: 210.5, price: { ...units[0].price, cash } });
  return [
    ['the W014 sheet', W014, { ...LISTING, status: 'available' }],
    ['the W014 sheet on a listing that is not available', W014, { ...LISTING, status: 'sold' }],
    ['a sheet dated in the future', { ...W014, updated: '2026-12-30' }, { ...LISTING, status: 'available' }],
    ['an impossible sheet date', { ...W014, updated: '2026-02-30' }, { ...LISTING, status: 'available' }],
    ['an impossible delivery', { ...W014, delivery: '2028-13' }, { ...LISTING, status: 'available' }],
    ['a delivery given as a day', { ...W014, delivery: '2028-02-29' }, { ...LISTING, status: 'available' }],
    ['units without a cash price or an area', { ...W014, units: [...units.slice(0, 5), { ...units[0], price: { ...units[0].price, cash: null } }, { ...units[1], areaSqm: null }, { ...units[2], price: { ...units[2].price, cash: 0 } }] }, { ...LISTING, status: 'available' }],
    ['penthouses of one size', { ...W014, units: [...units.slice(0, 4), penthouse(2, 2_100_000, 'B07-31'), penthouse(2, 2_450_000, 'B07-32')] }, { ...LISTING, status: 'available' }],
    ['penthouses of 1–2 bedrooms', { ...W014, units: [...units.slice(0, 4), penthouse(1, 1_900_000, 'B07-31'), penthouse(2, 2_450_000, 'B07-32')] }, { ...LISTING, status: 'available' }],
    ['penthouses of 3–11 bedrooms', { ...W014, units: [...units.slice(0, 4), penthouse(3, 3_100_000, 'B07-31'), penthouse(11, 9_450_000, 'B07-32')] }, { ...LISTING, status: 'available' }],
    ['a sheet with no priced unit', { ...W014, units: [] }, { ...LISTING, status: 'available' }],
    ['no sheet at all', null, { ...LISTING, status: 'available' }],
  ];
}

test('lib/units-summary.mjs publishes exactly what src/lib/units-summary.mjs publishes (W014 sheet and edge cases)', { skip: NO_SRC_LIB ? 'NO_SRC_LIB' : false }, async () => {
  const site = await import(pathToFileURL(SITE_LIB).href);
  assert.ok(W014.units.length > 0, 'the W014 sheet has units');
  for (const [name, record, listing] of cases()) {
    assert.deepEqual(api.unitSummary(record), site.unitSummary(record), `unitSummary: ${name}`);
    assert.deepEqual(api.liveSummary(record, listing, NOW), site.liveSummary(record, listing, NOW), `liveSummary: ${name}`);
    for (const s of [record?.updated, record?.delivery]) {
      assert.equal(api.isSheetDate(s), site.isSheetDate(s), `isSheetDate(${s}): ${name}`);
      assert.equal(api.isDeliveryDate(s), site.isDeliveryDate(s), `isDeliveryDate(${s}): ${name}`);
    }
    assert.equal(api.isSheetCurrent(record, NOW), site.isSheetCurrent(record, NOW), `isSheetCurrent: ${name}`);
  }
  // units.json as one record today, an array once a second project has a sheet.
  for (const data of [W014, [{ listingId: 'BONA-W999', units: [] }, W014]]) {
    assert.deepEqual(api.recordFor(data, W014.listingId), site.recordFor(data, W014.listingId));
    assert.deepEqual(api.recordFor(data, 'BONA-005'), site.recordFor(data, 'BONA-005'));
  }
  // What bona-api actually summarises is units.mjs's copy of the record (priced units only): it must give the
  // page's summary of the raw file.
  const served = createUnits({ file: WORKTREE_UNITS }).forListing(W014.listingId);
  const live = { ...LISTING, status: 'available' };
  assert.deepEqual(api.liveSummary(served, live, NOW), site.liveSummary(W014, live, NOW));
  // The same through the production loader once units.json is an array (a second project has a sheet).
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bona-units-array-'));
  try {
    const data = [{ ...W014, listingId: 'BONA-W999', units: W014.units.slice(0, 3) }, W014];
    const file = path.join(dir, 'units.json');
    writeFileSync(file, JSON.stringify(data));
    const loader = createUnits({ file });
    for (const id of [W014.listingId, 'BONA-W999']) {
      assert.deepEqual(api.liveSummary(loader.forListing(id), { id, status: 'available' }, NOW),
        site.liveSummary(site.recordFor(data, id), { id, status: 'available' }, NOW), `array units.json: ${id}`);
    }
    assert.equal(loader.forListing('BONA-005'), site.recordFor(data, 'BONA-005'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
