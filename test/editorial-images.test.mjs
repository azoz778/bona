/**
 * Editorial photographs on the brand pages (the home page's about block, /about/ and /sell/) come from
 * editorialPool() / editorialListing() / editorialImage() in src/lib/listings.ts. The /about/ and /sell/ photo is
 * also the page's og:image and its JSON-LD primaryImageOfPage, so a listing whose photos show another project
 * (`photoNote`) must never supply one, wherever intake happens to put it in the newest-first order. Each page labels
 * the photo (alt text) with the listing the photo came from.
 *
 * BONA-W021 pushed BONA-W019 (photoNote) into slot 2, and /about/ published W019's photo as its link preview and
 * page image. These checks run every slot rather than the slots the pages use today, so the next intake cannot do it again.
 *
 *   node --test test/editorial-images.test.mjs      (part of npm run test:dist; the built-page check needs `npm run build`)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

// listings.ts imports its JSON the Vite way, without `with { type: 'json' }`; give Node the attribute it asks for.
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    return r.url.endsWith('.json') && !context.importAttributes?.type ? { ...r, importAttributes: { ...context.importAttributes, type: 'json' } } : r;
  },
});
const { listings, ordered, imageAlt, editorialPool, editorialListing, editorialImage } = await import('../src/lib/listings.ts');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const NOTE = { en: 'Photos show the developer\'s completed sister project.', ar: 'الصور لمشروع سابق للمطوّر نفسه.' };
const photoUrls = (l) => l.images.flatMap((im) => [im.src, im.thumb]).filter(Boolean);

/** Every slot a page could ask for (the index wraps round the pool, so twice round), with every image pick. */
function assertEditorialSlots(list, label) {
  const pool = editorialPool(list);
  // Only listings without photos or with a photo note drop out; the rest keep the newest-first order.
  assert.deepEqual(pool.map((l) => l.id), ordered(list).filter((l) => l.images?.length && !l.photoNote).map((l) => l.id), `${label}: pool`);
  assert.ok(pool.length > 0, `${label}: the pool is empty`);
  // Units of one project share its photos; a shared photo still belongs to the listings without a note.
  const unnoted = new Set(list.filter((l) => !l.photoNote).flatMap(photoUrls));
  const noted = new Set(list.filter((l) => l.photoNote).flatMap(photoUrls).filter((u) => !unnoted.has(u)));
  for (let i = 0; i < pool.length * 2; i++) {
    const l = editorialListing(i, list);
    assert.equal(l, pool[i % pool.length], `${label}: slot ${i} wraps round the pool`);
    assert.ok(!l.photoNote, `${label}: slot ${i} is ${l.id}, whose photos show another project`);
    for (let pick = 0; pick <= 4; pick++) {
      const img = editorialImage(i, pick, list);
      assert.ok(l.images.includes(img), `${label}: slot ${i} pick ${pick} is not a photo of ${l.id}, the listing its label names`);
      assert.ok(!noted.has(img.src), `${label}: slot ${i} pick ${pick} is ${img.src}, a photo of another project`);
    }
  }
}

test('editorial slots on the live listings never use a photo-note listing', () => {
  assertEditorialSlots(listings, 'live');
});

test('wherever a photo-note listing sits in the newest-first order, no editorial slot uses it', () => {
  const withPhotos = ordered(listings).filter((l) => l.images?.length);
  assert.ok(withPhotos.length > 5, 'enough listings with photos to move a note through');
  for (const target of withPhotos) {
    const list = listings.map((l) => (l === target ? { ...l, photoNote: NOTE } : l));
    assertEditorialSlots(list, `note on ${target.id}`);
  }
  // A brand-new noted listing published newest, the W021 / W019 shape.
  const fresh = { ...withPhotos[0], id: 'BONA-W999', slug: 'noted-newest', listedAt: '2999-01-01', photoNote: NOTE,
    images: [1, 2, 3, 4].map((n) => ({ src: `/listings/noted-newest/0${n}.jpg` })) };
  assertEditorialSlots([fresh, ...listings], 'newest noted');
});

test('with every listing noted there is no editorial photo at all, and no label', () => {
  const list = listings.map((l) => ({ ...l, photoNote: NOTE }));
  assert.deepEqual(editorialPool(list), []);
  for (const i of [0, 1, 2, 3, 4]) {
    assert.equal(editorialListing(i, list), undefined);
    assert.equal(editorialImage(i, 1, list), undefined);
  }
});

// ---- The pages: each editorial photo is labelled with the listing at the same slot, from the same pool. ----

function* files(dir, ext) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p, ext);
    else if (e.name.endsWith(ext)) yield p;
  }
}
const rel = (p) => path.relative(root, p).split(path.sep).join('/');
/** `name = fn(N…` declarations in a page's frontmatter: variable → slot N. */
const declared = (src, fn) => new Map([...src.matchAll(new RegExp(`\\b(\\w+)\\s*=\\s*${fn}\\(\\s*(\\d+)\\s*(?:,\\s*(\\d+)\\s*)?\\)`, 'g'))]
  .map((m) => [m[1], { slot: Number(m[2]), pick: m[3] === undefined ? 1 : Number(m[3]) }]));
const pages = [...files(path.join(root, 'src'), '.astro')]
  .map((file) => ({ file: rel(file), src: readFileSync(file, 'utf8') }))
  .filter((p) => p.src.includes('editorialImage('))
  .map((p) => {
    const images = declared(p.src, 'editorialImage');
    const owners = declared(p.src, 'editorialListing');
    const labels = [...p.src.matchAll(/imageAlt\(\s*(\w+)\s*,\s*(\w+)\s*,/g)].filter((m) => images.has(m[1])).map((m) => ({ image: m[1], owner: m[2] }));
    return { ...p, images, owners, labels };
  });

test('every page that shows an editorial photo labels it with editorialListing() at the same slot', () => {
  assert.ok(pages.length >= 3, `pages with editorial photos: ${pages.map((p) => p.file).join(', ')}`);
  for (const p of pages) {
    assert.equal(p.images.size, (p.src.match(/\beditorialImage\(/g) ?? []).length, `${p.file}: every editorialImage() call is a \`name = editorialImage(N, pick)\` declaration`);
    for (const [name, { slot }] of p.images) {
      const uses = p.labels.filter((x) => x.image === name);
      assert.ok(uses.length > 0, `${p.file}: ${name} has no imageAlt() label`);
      for (const { owner } of uses) {
        assert.equal(p.owners.get(owner)?.slot, slot, `${p.file}: ${name} (slot ${slot}) is labelled with ${owner}, which is not editorialListing(${slot})`);
      }
    }
  }
});

/** Routes that render each page component: src/pages/**.astro files that import it, with their locale. */
const routesOf = (component) => [...files(path.join(root, 'src/pages'), '.astro')].flatMap((file) => {
  const src = readFileSync(file, 'utf8');
  const name = path.basename(component, '.astro');
  if (!new RegExp(`import ${name} from '[./]*/components/pages/${name}\\.astro'`).test(src)) return [];
  const dir = path.relative(path.join(root, 'src/pages'), path.dirname(file)).split(path.sep).filter(Boolean);
  const base = path.basename(file, '.astro');
  const route = '/' + [...dir, ...(base === 'index' ? [] : [base])].map((x) => `${x}/`).join('');
  return [{ route, locale: /locale="ar"/.test(src) ? 'ar' : 'en' }];
});
const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? decode(m[1]) : null; };

test('built pages: each editorial photo carries the alt text of the listing it came from', { skip: !existsSync(path.join(dist, 'index.html')) && 'dist/ missing: run `npm run build`' }, () => {
  let checked = 0;
  for (const p of pages) {
    const routes = routesOf(p.file);
    assert.ok(routes.length > 0, `${p.file}: no route renders it`);
    for (const { route, locale } of routes) {
      const html = readFileSync(path.join(dist, ...route.split('/').filter(Boolean), 'index.html'), 'utf8');
      const tags = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
      for (const [name, { slot, pick }] of p.images) {
        const img = editorialImage(slot, pick);
        const owner = editorialListing(slot);
        assert.ok(img && owner, `${p.file}: ${name} has a photo`);
        const shown = tags.filter((t) => attr(t, 'src') === img.src);
        assert.ok(shown.length > 0, `${route}: ${name} (${img.src}) is on the page`);
        for (const t of shown) assert.equal(attr(t, 'alt'), imageAlt(img, owner, locale), `${route}: ${name} label`);
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 8, `editorial photos checked: ${checked}`);
});
