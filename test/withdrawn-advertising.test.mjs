/**
 * Withdrawn advertising over the BUILT site (dist/): what actually ships to GitHub Pages.
 *
 *   npm run build && node --test test/withdrawn-advertising.test.mjs      (or: npm run test:dist)
 *
 * BONA-W009 (Elvira Murjan): the developer withdrew permission to advertise it (Tarek, 2026-10-20)
 * and the owner ordered a full takedown. The deploy runs this before it uploads the artifact, so a
 * withdrawn listing that comes back by any route — a sync, an intake push, a hand edit, a stale
 * public/ file — stops the deploy instead of going live. The records come from the same two places
 * every other route reads: rules.mjs WITHDRAWN_ADVERTISING and the review register's
 * `withdrawnAdvertising` flags.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadRegisterWithdrawals, withdrawnAdvertising, WITHDRAWN_ADVERTISING } from '../scripts/curate/rules.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
assert.ok(existsSync(path.join(dist, 'index.html')), `dist/ is missing — run \`npm run build\` first (looked in ${dist})`);

const records = [...WITHDRAWN_ADVERTISING, ...loadRegisterWithdrawals(root)];
const TEXT = /\.(html?|xml|json|txt|js|mjs|css|svg|webmanifest|md)$/i;
function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p); else yield p;
  }
}
/** The same folding rules.mjs matches names with: case, Arabic alef forms and diacritics, punctuation as spaces. */
const fold = (v) => ` ${String(v ?? '').normalize('NFKC').toLowerCase()
  .replace(/[ً-ٰٟـ]/g, '').replace(/[آأإٱ]/g, 'ا')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

test('the withdrawal records include BONA-W009, so this check can never pass vacuously', () => {
  assert.ok(records.some((w) => w.id === 'BONA-W009'));
});

test('no withdrawn listing has a page, a photo, a brochure or derived social media in dist/', () => {
  for (const w of records) {
    for (const rel of [w.slug && `properties/${w.slug}`, w.slug && `ar/properties/${w.slug}`, w.slug && `listings/${w.slug}`, `social/property/${w.id}`].filter(Boolean)) {
      assert.equal(existsSync(path.join(dist, rel)), false, `${w.id}: dist/${rel}`);
    }
  }
});

test('no page, index, sitemap, feed, llms.txt or script in dist/ names a withdrawn listing', () => {
  const terms = records.flatMap((w) => [w.id, w.slug, ...(w.names ?? [])]).filter(Boolean).map(fold).filter((t) => t.trim());
  const hits = [];
  for (const file of files(dist)) {
    if (!TEXT.test(file)) continue;
    const text = fold(readFileSync(file, 'utf8'));
    const term = terms.find((t) => text.includes(t));
    if (term) hits.push(`${path.relative(dist, file)} (${term.trim()})`);
  }
  assert.deepEqual(hits, []);
});

test('the social catalogue the publishers read carries no withdrawn listing', () => {
  const catalogue = JSON.parse(readFileSync(path.join(dist, 'social-catalogue.json'), 'utf8'));
  const flagged = loadRegisterWithdrawals(root);
  assert.deepEqual(catalogue.listings.filter((l) => withdrawnAdvertising(l, flagged)).map((l) => l.id), []);
});
