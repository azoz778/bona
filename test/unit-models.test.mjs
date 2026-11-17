/**
 * Unit models ("Residences & prices", src/components/UnitModels.astro), checked over the BUILT site (dist/):
 * every listing that carries `models` shows the section on its English and Arabic page, with one table row and
 * one mobile card per model. Passes vacuously while no listing carries models.
 *
 *   npm run build && node --test test/unit-models.test.mjs      (or: npm run test:dist)
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const listings = JSON.parse(readFileSync(path.join(root, 'src/data/listings.json'), 'utf8'));
const withModels = listings.filter((l) => Array.isArray(l.models) && l.models.length > 0);
const count = (html, re) => (html.match(re) ?? []).length;

test('dist/ is built when any listing carries unit models', () => {
  if (!withModels.length) return;
  assert.ok(existsSync(path.join(dist, 'index.html')), `dist/ is missing — run \`npm run build\` first (looked in ${dist})`);
});

for (const l of withModels) {
  for (const [locale, prefix] of [['en', ''], ['ar', 'ar/']]) {
    test(`${l.id} (${locale}): Residences & prices shows all ${l.models.length} models as table rows and cards`, () => {
      const file = path.join(dist, `${prefix}properties/${l.slug}/index.html`);
      assert.ok(existsSync(file), `missing ${path.relative(root, file)}`);
      const html = readFileSync(file, 'utf8');
      assert.ok(html.includes('data-unit-models'), 'no data-unit-models section');
      assert.equal(count(html, /data-model-row="table"/g), l.models.length, 'table rows');
      assert.equal(count(html, /data-model-row="card"/g), l.models.length, 'mobile cards');
    });
  }
}
