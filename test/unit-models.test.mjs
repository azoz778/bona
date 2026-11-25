/**
 * Unit models ("Residences & prices", src/components/UnitModels.astro), checked over the BUILT site (dist/).
 *
 * Today (whatever the data): a listing page with no models and no fact lists has no section, and the built CSS
 * carries the 48rem container query that switches cards to the table. For every listing that carries `models`,
 * on its English and Arabic page: one table row and one mobile card per model; plan links and images only from
 * the listing's own /listings/<slug>/plan-… files; the Sakani column and note only with a Sakani price; a rental
 * shows its period on every price; zero bedrooms reads "Studio"; row headers hold the model names only.
 *
 *   npm run build && node --test test/unit-models.test.mjs      (or: npm run test:dist)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const built = existsSync(path.join(dist, 'index.html'));
const skip = !built && 'dist/ missing: run `npm run build`';
const listings = JSON.parse(readFileSync(path.join(root, 'src/data/listings.json'), 'utf8'));
const LOCALES = [['en', ''], ['ar', 'ar/']];
const hasModels = (l) => Array.isArray(l.models) && l.models.length > 0;
const withModels = listings.filter(hasModels);
const count = (html, re) => (html.match(re) ?? []).length;
const pageFile = (l, prefix) => path.join(dist, `${prefix}properties/${l.slug}/index.html`);
const page = (l, prefix) => {
  const file = pageFile(l, prefix);
  assert.ok(existsSync(file), `missing ${path.relative(root, file)}`);
  return readFileSync(file, 'utf8');
};
/* The fact lists as UnitModels.astro reads them: the locale's list, else the English one, blank items dropped. */
const factItems = (l, locale) => ['amenities', 'nearby', 'warranties']
  .flatMap((k) => (l[k]?.[locale] ?? l[k]?.en ?? []).filter((x) => typeof x === 'string' && x.trim()));
const section = (html) => {
  const at = html.indexOf('<section id="residences"');
  assert.ok(at >= 0, 'no <section id="residences">');
  return html.slice(at, html.indexOf('</section>', at) + '</section>'.length);
};
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'").replace(/&amp;/g, '&');
const text = (s) => decode(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const isFigure = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

test('dist/ is built when any listing carries unit models', () => {
  if (!withModels.length) return;
  assert.ok(built, `dist/ is missing — run \`npm run build\` first (looked in ${dist})`);
});

test('a listing with no models and no fact lists has no Residences & prices section', { skip }, () => {
  let checked = 0;
  for (const l of listings.filter((x) => !hasModels(x))) {
    for (const [locale, prefix] of LOCALES) {
      if (factItems(l, locale).length) continue;
      assert.ok(!page(l, prefix).includes('data-unit-models'), `${l.id} (${locale}) shows an empty section`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'no listing page without models and fact lists was checked');
});

test('a listing with fact lists but no models shows them, with no table or cards', { skip }, () => {
  for (const l of listings.filter((x) => !hasModels(x))) {
    for (const [locale, prefix] of LOCALES) {
      if (!factItems(l, locale).length) continue;
      const html = section(page(l, prefix));
      assert.ok(html.includes('data-unit-facts'), `${l.id} (${locale}): no fact lists`);
      assert.equal(count(html, /data-model-row=/g), 0, `${l.id} (${locale}): model rows without models`);
    }
  }
});

test('the built CSS switches cards to the table on a 48rem container', { skip }, () => {
  const dir = path.join(dist, '_astro');
  const css = readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.ok(/\.\\@container\s*\{[^}]*container-type:\s*inline-size/.test(css), '.@container { container-type: inline-size } is missing');
  // the rules inside every `@container (width >= 48rem) { … }` block (one level of nested braces)
  const rules = [...css.matchAll(/@container\s*\((?:min-width:\s*48rem|width\s*>=\s*48rem)\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map((x) => x[1]).join('');
  assert.ok(/\.\\@3xl\\:block\s*\{\s*display:\s*block/.test(rules), '@container (width >= 48rem) { .@3xl:block } is missing');
  assert.ok(/\.\\@3xl\\:hidden\s*\{\s*display:\s*none/.test(rules), '@container (width >= 48rem) { .@3xl:hidden } is missing');
});

for (const l of withModels) {
  for (const [locale, prefix] of LOCALES) {
    const ar = locale === 'ar';
    const other = ar ? 'en' : 'ar';

    test(`${l.id} (${locale}): Residences & prices shows all ${l.models.length} models as table rows and cards`, () => {
      const html = page(l, prefix);
      assert.ok(html.includes('data-unit-models'), 'no data-unit-models section');
      assert.equal(count(html, /data-model-row="table"/g), l.models.length, 'table rows');
      assert.equal(count(html, /data-model-row="card"/g), l.models.length, 'mobile cards');
    });

    test(`${l.id} (${locale}): plans, Sakani, rent period, studio and row headers`, () => {
      const html = section(page(l, prefix));
      // plan links and images only from the listing's own folder (never javascript: or another listing's file)
      const own = `/listings/${l.slug}/plan-`;
      for (const [, attr, url] of html.matchAll(/\s(href|src)="([^"]*)"/g)) {
        assert.ok(decode(url).startsWith(own), `${attr}="${url}" is not under ${own}`);
      }
      // Sakani column and note only when a model has a Sakani price
      const sakani = l.models.some((m) => isFigure(m.subsidisedPrice));
      assert.equal(html.includes('data-models-sakani-note'), sakani, 'Sakani note');
      assert.equal(count(html, ar ? /<th scope="col"[^>]*>سعر مستفيدي الدعم<\/th>/g : /<th scope="col"[^>]*>Sakani price<\/th>/g), sakani ? 1 : 0, 'Sakani column');
      // a rental's prices carry its period, like the header price
      const priced = l.models.filter((m) => isFigure(m.price)).length + l.models.filter((m) => isFigure(m.subsidisedPrice)).length;
      if (l.category === 'rent' && l.price?.period && priced) {
        const suffix = ar ? (l.price.period === 'year' ? '/ سنوياً' : '/ شهرياً') : (l.price.period === 'year' ? '/ year' : '/ month');
        assert.equal(html.split(suffix).length - 1, priced * 2, `"${suffix}" on every price in the table and on the cards`);
        assert.ok(html.includes(ar ? '>الإيجار<' : '>Rent<'), 'the price column is labelled Rent');
      }
      // zero bedrooms reads "Studio" in the table cell
      const studios = l.models.filter((m) => m.bedrooms === 0).length;
      assert.equal(count(html, ar ? />استوديو<\/td>/g : />Studio<\/td>/g), studios, 'Studio cells');
      // a row header holds the model's name(s) only (rooms and availability are not repeated on every cell)
      const headers = [...html.matchAll(/<th scope="row"[^>]*>([\s\S]*?)<\/th>/g)].map((x) => text(x[1]));
      const names = l.models.map((m) => {
        const n = m.name?.[locale] ?? m.name?.en ?? '';
        const o = m.name?.[other]?.trim();
        return [n, o && o !== n.trim() ? o : ''].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      });
      assert.deepEqual(headers, names, 'row headers');
    });
  }
}
