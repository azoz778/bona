// scripts/sync-listings.mjs runs in every deploy against TK's public list, and its catch-all turns
// any crash into "sync skipped" with exit code 0, so a broken branch never fails CI: it silently
// stops every status and price update. These tests run the real script in a scratch tree, with the
// TK list served as a data: URL, so its update and removal paths actually execute. (2026-10-06: the over-cap branch
// referenced an undefined variable; the first plot priced over the cap would have frozen the sync.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function tree(listings) {
  // realpath: the script runs main() only when argv[1] equals its own resolved path (a symlinked tmp dir would not).
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bona-sync-')));
  // The script's whole import chain. If any of these gains an import, the tests fail with
  // ERR_MODULE_NOT_FOUND naming the missing file (every test fails): add it to this list.
  for (const f of ['scripts/sync-listings.mjs', 'scripts/curate/rules.mjs', 'src/lib/units-summary.mjs']) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
  fs.mkdirSync(path.join(dir, 'src/data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/data/listings.json'), JSON.stringify(listings, null, 2) + '\n');
  return dir;
}
const sync = (dir, rows) => execFileSync(process.execPath, [path.join(dir, 'scripts/sync-listings.mjs')], {
  encoding: 'utf8', env: { ...process.env, TK_PUBLIC_API: `data:application/json,${encodeURIComponent(JSON.stringify({ data: rows }))}` } });
const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'src/data/listings.json'), 'utf8'));
const listing = (id, sourceRef, extra) => ({ id, slug: id.toLowerCase(), sourceRef, status: 'available', category: 'buy',
  price: { amount: 1_000_000, currency: 'SAR', from: false, onRequest: false }, virtualTourUrl: null, ...extra });

test('a plot whose TK price crosses the land cap is removed, and the other updates still land', () => {
  const dir = tree([
    listing('BONA-T1', 'LND-1', { type: 'land', kind: 'land', price: { amount: 40_000_000, currency: 'SAR', from: false, onRequest: false } }),
    listing('BONA-T2', 'APT-2', { type: 'apartment', kind: 'apartment' }),
  ]);
  try {
    const out = sync(dir, [
      { id: 'LND-1', status: 'available', price: 'SAR 55,000,000' },
      { id: 'APT-2', status: 'sold', price: 'SAR 1,000,000' },
    ]);
    assert.doesNotMatch(out, /sync skipped/, out);
    assert.match(out, /BONA-T1 REMOVED — land at\/above the SAR 50,000,000 cap/);
    const after = read(dir);
    assert.deepEqual(after.map((l) => l.id), ['BONA-T2'], 'the over-cap plot is off the site');
    assert.equal(after[0].status, 'sold', 'and the sold flag from the same run is written');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an ordinary run updates status and price in place and removes nothing', () => {
  const dir = tree([listing('BONA-T3', 'VIL-3', { type: 'villa', kind: 'house' })]);
  try {
    const out = sync(dir, [{ id: 'VIL-3', status: 'reserved', price: 'SAR 1,250,000' }]);
    assert.doesNotMatch(out, /sync skipped|REMOVED/, out);
    const [l] = read(dir);
    assert.equal(l.status, 'reserved');
    assert.equal(l.price.amount, 1_250_000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a withheld listing is removed and the file rewritten even when TK changed nothing else', () => {
  const dir = tree([listing('BONA-002', 'VIL-2', { type: 'villa', kind: 'house' }), listing('BONA-T4', 'APT-4', { type: 'apartment', kind: 'apartment' })]);
  try {
    const out = sync(dir, [{ id: 'VIL-2', status: 'available', price: 'SAR 1,000,000' }, { id: 'APT-4', status: 'available', price: 'SAR 1,000,000' }]);
    assert.doesNotMatch(out, /sync skipped/, out);
    assert.match(out, /BONA-002 REMOVED — withheld from the public site by owner decision/);
    assert.deepEqual(read(dir).map((l) => l.id), ['BONA-T4'], 'the only change is the removal, and it is written');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// BONA-W009 (Elvira): the developer withdrew permission to advertise it. The deploy's sync edits
// listings.json in place without rebuilding, so it must drop a withdrawn listing on its own —
// whether the permanent record in rules.mjs names it or only its review-register entry is flagged.
test('a withdrawn listing (BONA-W009) is removed by the deploy sync', () => {
  const dir = tree([
    listing('BONA-W009', null, { slug: 'elvira-murjan-townhouses-in-al-murjan', type: 'villa', kind: 'house', category: 'off-plan' }),
    listing('BONA-T5', 'APT-5', { type: 'apartment', kind: 'apartment' }),
  ]);
  try {
    const out = sync(dir, [{ id: 'APT-5', status: 'available', price: 'SAR 1,000,000' }]);
    assert.doesNotMatch(out, /sync skipped/, out);
    assert.match(out, /BONA-W009 REMOVED — advertising permission withdrawn/);
    assert.deepEqual(read(dir).map((l) => l.id), ['BONA-T5']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a listing whose review-register entry carries the withdrawnAdvertising flag is removed by the deploy sync', () => {
  const dir = tree([listing('BONA-T6', 'VIL-6', { type: 'villa', kind: 'house' }), listing('BONA-T7', 'APT-7', { type: 'apartment', kind: 'apartment' })]);
  try {
    fs.mkdirSync(path.join(dir, 'marketing/daily'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'marketing/daily/property-reviews.json'), JSON.stringify({
      'BONA-T6': { status: 'withdrawn', reviewedAt: '2026-11-10T09:00:00Z', reviewer: 'test',
        withdrawnAdvertising: { at: '2026-11-10T09:00:00Z', requestedBy: 'test', reason: 'fixture', channels: ['website'] } },
    }));
    const out = sync(dir, [{ id: 'VIL-6', status: 'available', price: 'SAR 1,000,000' }, { id: 'APT-7', status: 'available', price: 'SAR 1,000,000' }]);
    assert.doesNotMatch(out, /sync skipped/, out);
    assert.match(out, /BONA-T6 REMOVED — advertising permission withdrawn/);
    assert.deepEqual(read(dir).map((l) => l.id), ['BONA-T7']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The deploy workflow (.github/workflows/deploy.yml, step "Sync listings from TK") counts a run as today's
// listings refresh only when this summary line is printed, because the script also exits 0 when TK cannot be
// read. If the line changes, change the workflow's grep with it (this test checks both).
const SUMMARY = /^sync: [0-9]+ API rows, /m;
test('the summary line the deploy workflow greps for: printed after a fetch, absent when TK cannot be read', () => {
  const dir = tree([listing('BONA-T8', 'APT-8', { type: 'apartment', kind: 'apartment' })]);
  try {
    const ok = sync(dir, [{ id: 'APT-8', status: 'available', price: 'SAR 1,000,000' }]);
    assert.match(ok, SUMMARY, 'a fetch that changes nothing still counts');
    const failed = execFileSync(process.execPath, [path.join(dir, 'scripts/sync-listings.mjs')], {
      encoding: 'utf8', env: { ...process.env, TK_PUBLIC_API: 'data:application/json,not-json' } });
    assert.match(failed, /sync skipped/, failed);
    assert.doesNotMatch(failed, SUMMARY, failed);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
  assert.ok(wf.includes("grep -Eq '^sync: [0-9]+ API rows, '"), 'deploy.yml greps the same summary line');
});

test('deploy.yml: the gate looks for the refresh marker step by its exact name', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
  const marker = 'Refresh marker (TK sync + Pages deploy)';
  assert.ok(wf.includes(`REFRESH_STEP: '${marker}'`), 'the gate searches for this step name');
  assert.ok(wf.includes(`- name: '${marker}'`), 'the deploy job has a step with exactly this name');
});
