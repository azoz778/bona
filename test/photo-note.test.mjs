/**
 * Listings whose photos show another project (`photoNote`, see src/data/LISTING-SCHEMA.md), checked over the
 * BUILT site (dist/): the note is visible under the gallery, in the lightbox, on every card and on concierge
 * cards; no image label, link preview or structured data presents those photos as the listing; and the
 * knowledge file carries the note.
 *
 *   npm run build && node --test test/photo-note.test.mjs      (or: npm run test:dist)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const SITE = 'https://bona-real-estate.com';
assert.ok(existsSync(path.join(dist, 'index.html')), `dist/ is missing — run \`npm run build\` first (looked in ${dist})`);

const listings = JSON.parse(readFileSync(path.join(root, 'src/data/listings.json'), 'utf8'));
const noted = listings.filter((l) => l.photoNote);
const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

function* htmlFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* htmlFiles(p);
    else if (e.name === 'index.html') yield p;
  }
}
const pages = [...htmlFiles(dist)].map((file) => {
  const route = '/' + path.relative(dist, path.dirname(file)).split(path.sep).filter(Boolean).map((x) => `${x}/`).join('');
  return { route, locale: route.startsWith('/ar/') ? 'ar' : 'en', html: readFileSync(file, 'utf8') };
});
const byRoute = new Map(pages.map((p) => [p.route, p]));
const notesIn = (html) => [...html.matchAll(/data-photo-note[^>]*>([^<]*)</g)].map((m) => decode(m[1]).trim());
const jsonLdOf = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
const meta = (html, prop) => decode(html.match(new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)"`))?.[1] ?? '');
/** Every URL a listing's photos are served under (full size and thumbnail), as they appear in the HTML. */
const urlsOf = (l) => l.images.flatMap((im) => [im.src, im.thumb]).filter(Boolean).flatMap((u) => [u, u.startsWith('/') ? SITE + u : u]);

test('Dari II (BONA-026) carries a photo note', () => {
  assert.ok(noted.some((l) => l.id === 'BONA-026'));
});

for (const l of noted) {
  const urls = urlsOf(l);
  for (const locale of ['en', 'ar']) {
    const route = `${locale === 'ar' ? '/ar' : ''}/properties/${l.slug}/`;
    const note = l.photoNote[locale];

    test(`${l.id} ${route}: the note shows under the photo strip and in the lightbox`, () => {
      const p = byRoute.get(route);
      assert.ok(p, `${route} was built`);
      const notes = notesIn(p.html);
      assert.ok(notes.filter((n) => n === note).length >= 2, `strip + lightbox, got ${JSON.stringify(notes)}`);
    });

    test(`${l.id} ${route}: every label on the listing's photos carries the note; the link preview uses the brand image`, () => {
      const { html } = byRoute.get(route);
      const g0 = html.indexOf('data-gallery');
      const gallery = html.slice(g0, html.indexOf('</dialog>', g0));
      const imgs = [...gallery.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
      assert.ok(imgs.length >= l.images.length, 'gallery images found');
      for (const tag of imgs) {
        const alt = decode(tag.match(/\salt="([^"]*)"/)?.[1] ?? '');
        if (alt) assert.ok(alt.includes(note), `label without the note: ${alt}`);
      }
      for (const prop of ['og:image', 'og:image:secure_url', 'twitter:image']) {
        const v = meta(html, prop);
        assert.ok(v && !urls.includes(v), `${prop} is a photo of another project: ${v}`);
      }
    });
  }

  test(`${l.id}: every card for it, on every page, shows the note in the page language`, () => {
    let cards = 0;
    for (const p of pages) {
      for (const m of p.html.matchAll(/<article\b[^>]*data-listing[\s\S]*?<\/article>/g)) {
        if (!m[0].includes(`/properties/${l.slug}/"`)) continue;
        cards += 1;
        assert.ok(notesIn(m[0]).includes(l.photoNote[p.locale]), `${p.route}: card without the note`);
      }
    }
    assert.ok(cards >= 2, `cards found: ${cards}`);
  });

  test(`${l.id}: no page declares its photos in structured data or uses one as its link preview`, () => {
    for (const p of pages) {
      const ld = jsonLdOf(p.html);
      for (const u of urls) assert.ok(!ld.includes(`"${u}"`), `${p.route}: JSON-LD lists ${u}`);
      for (const prop of ['og:image', 'twitter:image']) assert.ok(!urls.includes(meta(p.html, prop)), `${p.route}: ${prop} is a photo of ${l.id}`);
    }
  });

  test(`${l.id}: concierge cards and the knowledge file carry the note`, () => {
    for (const locale of ['en', 'ar']) {
      const { html } = byRoute.get(locale === 'ar' ? '/ar/' : '/');
      const raw = html.match(/data-concierge data-config="([^"]*)"/)?.[1];
      if (!raw) continue; // concierge switched off (site.json): no chat cards to label
      assert.equal(JSON.parse(decode(raw)).photoNotes?.[l.slug], l.photoNote[locale], `${locale} concierge config`);
    }
    const full = readFileSync(path.join(dist, 'llms-full.txt'), 'utf8');
    const section = full.slice(full.indexOf(`- ID: ${l.id}`), full.indexOf('\n### ', full.indexOf(`- ID: ${l.id}`)));
    assert.ok(section.includes(`- Photo note: ${l.photoNote.en} / ${l.photoNote.ar}`), 'llms-full.txt');
  });
}
