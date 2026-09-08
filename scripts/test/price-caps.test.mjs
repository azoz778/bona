// The two publication price caps, and the three routes that must all enforce them:
// scripts/curate/build.mjs (the curated build), scripts/sync-listings.mjs (the daily deploy
// updates prices IN PLACE and never rebuilds) and scripts/curate/validate.mjs (the gate the
// deploy runs last). Codex review 2026-09-08: the land cap lived only in build.mjs, so a plot
// whose TK price crossed SAR 50M would have been republished by the next scheduled deploy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { HOUSE_PRICE_CAP, LAND_PRICE_CAP, isHousePublic, isLandPublic } from '../curate/rules.mjs';

const land = (amount, extra = {}) => ({ kind: 'land', type: 'land', price: { amount, currency: 'SAR', onRequest: false }, ...extra });

test('land: under SAR 50M publishes, at or above does not, unknown price does not', () => {
  assert.equal(LAND_PRICE_CAP, 50_000_000);
  assert.equal(isLandPublic(land(3_816_000)), true);
  assert.equal(isLandPublic(land(49_999_999)), true);
  assert.equal(isLandPublic(land(50_000_000)), false, 'exactly the cap is off-market');
  assert.equal(isLandPublic(land(198_000_000)), false);
  assert.equal(isLandPublic(land(null)), false, 'a plot with no published price is off-market, unlike a house');
  assert.equal(isLandPublic(land(3_000_000, { price: { amount: 3_000_000, currency: 'SAR', onRequest: true } })), false);
});

test('land: the cap is in SAR equivalent, and a plot is recognised by kind or by type', () => {
  assert.equal(isLandPublic({ kind: 'land', price: { amount: 20_000_000, currency: 'USD' } }), false, '20M USD ≈ 75M SAR');
  assert.equal(isLandPublic({ type: 'plot', price: { amount: 1_000_000, currency: 'SAR' } }), true);
  assert.equal(isLandPublic({ type: 'Land', price: { amount: 60_000_000, currency: 'SAR' } }), false);
});

test('the land cap never touches houses or apartments, and the house cap never touches land', () => {
  assert.equal(isLandPublic({ kind: 'house', price: { amount: 500_000_000, currency: 'SAR' } }), true);
  assert.equal(isLandPublic({ kind: 'apartment', price: { amount: null, currency: 'SAR' } }), true);
  assert.equal(isHousePublic(land(500_000_000)), true);
  assert.equal(isHousePublic({ kind: 'house', price: { amount: HOUSE_PRICE_CAP + 1, currency: 'SAR' } }), false);
});

test('all three routes enforce the land cap from the one shared rule', () => {
  const src = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  assert.match(src('scripts/curate/build.mjs'), /isLandPublic/, 'build.mjs');
  assert.doesNotMatch(src('scripts/curate/build.mjs'), /const LAND_PRICE_CAP\s*=/, 'build.mjs must not keep its own copy of the cap');
  // Codex, final gate 2026-09-08: the curated set was filtered but WhatsApp-intake listings were
  // only checked for the house cap — a plot published from the group at SAR 50M+ would have
  // reached listings.json (validate would then fail the deploy, but the build must not emit it).
  const build = src('scripts/curate/build.mjs');
  assert.match(build, /const candidates = \[\.\.\.live, \.\.\.inbox\];/, 'build.mjs forms the COMBINED curated + intake set');
  assert.match(build, /candidates\.filter\(\(l\) => isHousePublic\(l\) && isLandPublic\(l\)\)/, 'and publishes only what passes BOTH caps');
  assert.match(src('scripts/sync-listings.mjs'), /isLandPublic/, 'sync-listings.mjs — the daily deploy path');
  assert.match(src('scripts/curate/validate.mjs'), /isLandPublic/, 'validate.mjs — the last gate before deploy');
});
