// lib/units-summary.mjs is a copy of the site's src/lib/units-summary.mjs (unitSummary, liveSummary and the
// date checks they use), because the VPS runs bona-api from a sparse checkout (services + src/data) with no
// src/lib (DESIGN §4.5). The copy must publish exactly what the listing page publishes, so this test runs
// both on the W014 sheet and on the edge cases the site already handles, and checks that search_units
// (units.mjs → tools.mjs quotableSummary) quotes the page's rows or nothing, never before the page's build. On
// the VPS sparse checkout it is skipped (NO_SRC_LIB); anywhere else (the PC, a worktree, CI) a missing src/lib
// fails the import below. Every comparison is a boolean: the values are the real sheet's (public CI logs).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspect, isDeepStrictEqual } from 'node:util';
import test from 'node:test';
import { publishedUnitsCut, quotableSummary, SHEET_SETTLE_MS } from '../lib/tools.mjs';
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
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The clock the checks run at: two days after the real sheet's date, and never before 2026-11-27T09:00Z (a sheet
    without a real date keeps that). A refreshed sheet, whatever its date, is then one the page shows and the API
    quotes, and the cases that move the date (a sheet dated in the future) are built from this clock, not a fixed day. */
function sheetClock(updated) {
  const fixed = Date.parse('2026-11-27T09:00:00Z');
  return api.isSheetDate(updated) ? Math.max(fixed, Date.parse(`${updated}T00:00:00Z`) + 2 * DAY) : fixed;
}
const NOW = new Date(sheetClock(W014?.updated));
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Every value compared here comes from the real W014 sheet (unit refs, unpublished instalment prices), and a failing
    assertion prints in a public CI log: compare to a boolean, so a failure shows its message and never either value. */
function assertSame(a, b, what) {
  assert.ok(isDeepStrictEqual(a, b), `${what}: the API side differs from the site`);
}

/** The listing page's newest scheduled build at or before t (.github/workflows/deploy.yml: cron '0 3 * * *', 03:00 UTC). */
function lastCronBuild(t) {
  const d = new Date(t);
  const build = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 3);
  return build <= t ? build : build - DAY;
}

/** Variants of the W014 sheet that hit each branch of the site's code, and whether search_units quotes it at NOW. */
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
    // row (and its price can be the row's "from"): the API quotes that same row.
    ['a penthouse with a blank bedroom cell', { ...W014, units: [...units, penthouse(null, 1_000, 'B07-33')] }, available, true],
    // On any other unit the page prints a "null bedrooms" row: the API quotes nothing rather than that label.
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

/**
 * The merge that brings a sheet starts a push build of the page, and repo-sync (git pull every 5 minutes) lands the
 * file on the VPS up to 5 minutes after the merge, while that build may still run (Codex r4: a sheet dated D merged
 * at 20:58 UTC on D, quoted at 21:00). For a merge every hour from a day before the sheet's date to a day after it,
 * and at 20:58 UTC on its date, nothing is quoted before a build that started after the merge is live and shows the
 * sheet: the push build, live within SHEET_SETTLE_MS of its start (it takes minutes), or a daily 03:00 UTC build.
 * A push build that FAILS is the residual quotableSummary documents: this sweep assumes it deploys.
 */
function pushBuildSweep(site, name, served, record, listing, base) {
  const SYNC = 5 * 60_000;
  const merges = [base + 20 * HOUR + 58 * 60_000];
  for (let m = base - DAY; m <= base + DAY; m += HOUR) merges.push(m);
  for (const merge of merges) {
    const landed = merge + SYNC;
    const asks = [landed, landed + SHEET_SETTLE_MS - 1, landed + SHEET_SETTLE_MS];
    for (let t = merge; t <= merge + 2 * DAY; t += HOUR) asks.push(t);
    for (const t of asks) {
      const quoted = quotableSummary(served, listing, t, landed);
      if (!quoted) continue;
      // The builds that started after the merge and are live at t: the push build, and every daily build since.
      const live = [];
      if (merge + SHEET_SETTLE_MS <= t) live.push(merge);
      for (let b = lastCronBuild(t); b >= merge; b -= DAY) live.push(b);
      assert.ok(live.length, `${name}: merged ${new Date(merge).toISOString()}, quoted at ${new Date(t).toISOString()} before any build after the merge is live`);
      const page = site.liveSummary(record, listing, new Date(Math.max(...live)));
      assert.ok(page, `${name}: merged ${new Date(merge).toISOString()}, quoted at ${new Date(t).toISOString()}, before the live build shows the sheet`);
      assertSame(publishedUnitsCut(quoted), publishedUnitsCut(page), `${name}: rows quoted at ${new Date(t).toISOString()} after a merge at ${new Date(merge).toISOString()}`);
    }
    // Never within the settle hour of the file landing, whatever the sheet's date.
    assert.equal(quotableSummary(served, listing, landed + SHEET_SETTLE_MS - 1, landed), null, `${name}: quoted inside the hour after a merge at ${new Date(merge).toISOString()}`);
  }
}

test('search_units quotes what the page shows or nothing, and never before the page\'s build shows it (file → units.mjs → quotableSummary)', { skip: NO_SRC_LIB ? 'NO_SRC_LIB' : false }, async () => {
  const site = await import(pathToFileURL(SITE_LIB).href);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bona-units-quote-'));
  try {
    for (const [i, [name, record, listing, quotesNow]] of cases().entries()) {
      // What bona-api actually summarises: units.mjs's copy of the record, read from the file the page builds from.
      const base = api.isSheetDate(record?.updated) ? Date.parse(`${record.updated}T00:00:00Z`) : NOW.getTime();
      const file = path.join(dir, `units-${i}.json`);
      writeFileSync(file, JSON.stringify(record));
      // repo-sync landed the file two days before anything below asks: its settle hour (SHEET_SETTLE_MS) is over, so
      // this sweep checks the date gate against the daily build. The push build is the sweep further down.
      const landed = Math.min(base, NOW.getTime()) - 2 * DAY;
      utimesSync(file, landed / 1000, landed / 1000);
      const loader = createUnits({ file });
      const served = loader.forListing(W014.listingId);
      const changed = loader.changedAt();
      assert.equal(changed, landed, `${name}: the loader dates the sheet by its file`);
      assertSame(api.liveSummary(served, listing, NOW), site.liveSummary(record, listing, NOW), `served record: ${name}`);
      assert.equal(Boolean(quotableSummary(served, listing, NOW.getTime(), changed)), quotesNow, `quoted at NOW: ${name}`);
      // Every hour from a day before the sheet's date to three days after it: nothing, or the page's rows as the
      // newest daily build shows them. A push can build the page earlier, never later than that build.
      let first = null;
      for (let t = base - DAY; t <= base + 3 * DAY; t += HOUR) {
        const quoted = quotableSummary(served, listing, t, changed);
        if (!quoted) continue;
        first ??= t;
        const page = site.liveSummary(record, listing, new Date(lastCronBuild(t)));
        assert.ok(page, `${name}: quoted at ${new Date(t).toISOString()}, before the page's build shows the sheet`);
        assertSame(publishedUnitsCut(quoted), publishedUnitsCut(page), `${name}: rows quoted at ${new Date(t).toISOString()}`);
        assert.equal(quoted.count, page.count, `${name}: count quoted at ${new Date(t).toISOString()}`);
      }
      // A current sheet is quoted from 00:00 Riyadh the day after its date (21:00 UTC), less than a day after the page.
      if (quotesNow) assert.equal(first, base + 21 * HOUR, `${name}: first quoted at 21:00 UTC on the sheet's date`);
      if (quotesNow) pushBuildSweep(site, name, served, record, listing, base);
    }
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
