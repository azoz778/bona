// scripts/sync-listings.mjs runs in every deploy against TK's public list, and its catch-all turns
// any crash into "sync skipped" with exit code 0, so a broken branch never fails CI: it silently
// stops every status and price update. These tests run the real script in a scratch tree, with the
// TK list served as a data: URL, so each branch actually executes. (2026-10-06: the over-cap branch
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-sync-'));
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
