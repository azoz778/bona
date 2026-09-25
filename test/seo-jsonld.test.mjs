/**
 * Structured-data and on-page SEO checks over the BUILT site (dist/), not the source: the assertions
 * are made against what actually ships, so they cannot pass on code that never reached the output.
 *
 *   npm run build && node --test test/seo-jsonld.test.mjs      (or: npm run test:dist)
 *
 * Why these checks exist (Search Console + live-SERP review, 2026-09-24):
 *   - URL inspection of six content pages listed the detected BreadcrumbList under the label "Unnamed item".
 *     That label is cosmetic: Search Console names a detected entity by its `name`, and a BreadcrumbList
 *     carried none. The breadcrumbs were valid and eligible; the label is not an error, a warning, or a
 *     ranking factor. Giving the list a `name` only makes the report readable.
 *   - The homepage meta description was 214 characters, well past the ~155–160 a conventional snippet shows.
 *   - The off-plan section ranks ~22 for its branded-residences query while its title/H1 said only
 *     "Off-plan residences", although the page's own intro copy is about branded residences.
 * Everything else here is a semantic guard: breadcrumb JSON-LD must mirror the visible trail, point at
 * pages that exist, and be referenced by the page's WebPage node; FAQPage questions must be the visible
 * ones; the bilingual canonical/hreflang pairing on the opportunity pages must stay intact.
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

// ---- load every built page once ------------------------------------------------------------------

function* htmlFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* htmlFiles(p);
    else if (e.name === 'index.html') yield p;
  }
}

const decode = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ');
const text = (html) => decode(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

function loadPage(file) {
  const html = readFileSync(file, 'utf8');
  const rel = path.relative(dist, path.dirname(file)).split(path.sep).filter(Boolean).join('/');
  const route = rel ? `/${rel}/` : '/';
  const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  let graph = null;
  if (ld) {
    const doc = JSON.parse(ld[1]);
    graph = Array.isArray(doc['@graph']) ? doc['@graph'] : [doc];
  }
  const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] ?? null;
  const description = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? null;
  const title = html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? null;
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? null;
  const noindex = /<meta name="robots" content="noindex/.test(html);
  const nav = html.match(/<nav aria-label="(?:Breadcrumb|مسار التنقل)"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? null;
  const visibleTrail = nav ? [...nav.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => text(m[1])) : null;
  const lang = html.match(/<html lang="([^"]+)" dir="([^"]+)"/);
  return {
    file, route, html, graph, canonical, noindex,
    description: description == null ? null : decode(description),
    title: title == null ? null : text(title),
    h1: h1 == null ? null : text(h1),
    visibleTrail,
    lang: lang?.[1] ?? null, dir: lang?.[2] ?? null,
    hreflang: Object.fromEntries([...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g)].map((m) => [m[1], m[2]])),
  };
}

const pages = [...htmlFiles(dist)].map(loadPage);
const indexable = pages.filter((p) => !p.noindex);
const byRoute = new Map(pages.map((p) => [p.route, p]));
const page = (route) => {
  const p = byRoute.get(route);
  assert.ok(p, `no built page for ${route}`);
  return p;
};
const nodesOf = (p, type) => (p.graph ?? []).filter((n) => (Array.isArray(n['@type']) ? n['@type'] : [n['@type']]).includes(type));
const withBreadcrumbs = indexable.filter((p) => nodesOf(p, 'BreadcrumbList').length);

assert.ok(pages.length > 20, `expected a full site in dist/, found ${pages.length} pages`);

// ---- source-of-truth for listing routes ------------------------------------------------------------
// src/pages/properties/[slug].astro (and /ar/) build an EN + AR page for every listings.json entry whose
// slug is not reserved, whatever its status. Read the JSON directly (no TS import) so the test decides
// "should this route exist?" from the same data the build used.

const listingsSource = JSON.parse(readFileSync(path.join(root, 'src', 'data', 'listings.json'), 'utf8'));
const sourceSlugs = new Set(listingsSource.map((l) => l.slug));
// Mirrors `reservedSlugs` in src/lib/listings.ts: kindSlug + categorySlug values, which are routes of their own.
const RESERVED_SLUGS = new Set(['houses', 'apartments', 'land', 'buildings', 'for-sale', 'for-rent', 'off-plan', 'international']);

/** Skip reason when the source data cannot produce a listing page for `slug`; null when the route must be built. */
function listingSkipReason(slug, source = sourceSlugs, reserved = RESERVED_SLUGS) {
  if (!source.has(slug)) return `"${slug}" is not in src/data/listings.json — the listing was delisted, so this listing-specific check no longer applies`;
  if (reserved.has(slug)) return `"${slug}" is a reserved section slug, so the route rule never builds a listing page for it`;
  return null;
}

/** The built page for a route the source says must exist; a missing route is a build regression, not a skip. */
function requireBuiltListing(route, built = byRoute) {
  const p = built.get(route);
  assert.ok(p, `${route}: the listing is in src/data/listings.json, so the route rule should have built it, but it is missing from dist/`);
  return p;
}

// ---- the cosmetic "Unnamed item" label in Search Console -----------------------------------------
// A nameless BreadcrumbList is still valid; Search Console just cannot label it. The `name` is a
// readability nicety for the report, not a fix for an error or an eligibility problem.

function assertNamedBreadcrumb(node, where) {
  assert.equal(typeof node.name, 'string', `${where}: BreadcrumbList has no \`name\`, so Search Console would label it "Unnamed item" (cosmetic, not an error)`);
  assert.ok(node.name.trim().length > 0, `${where}: BreadcrumbList name is empty`);
}

test('self-check: the "named breadcrumb" assertion can fail', () => {
  assert.throws(() => assertNamedBreadcrumb({ '@type': 'BreadcrumbList', itemListElement: [] }, 'probe'));
  assert.throws(() => assertNamedBreadcrumb({ '@type': 'BreadcrumbList', name: '  ' }, 'probe'));
});

test('every BreadcrumbList carries a name, so Search Console shows a label instead of "Unnamed item"', () => {
  assert.ok(withBreadcrumbs.length >= 6, `expected breadcrumbs on the content pages, found them on ${withBreadcrumbs.length}`);
  for (const p of withBreadcrumbs) {
    for (const node of nodesOf(p, 'BreadcrumbList')) assertNamedBreadcrumb(node, p.route);
  }
});

test('the breadcrumb name is the trail itself, in the page language', () => {
  for (const p of withBreadcrumbs) {
    const [node] = nodesOf(p, 'BreadcrumbList');
    // Same normalisation as breadcrumbJsonLd() in src/lib/seo.ts: trim each name, drop empties, join.
    // A failure here is a real trail mismatch, not a whitespace artefact of the implementation.
    const trail = node.itemListElement.map((it) => (it.name ?? '').trim()).filter(Boolean).join(' › ');
    assert.equal(node.name, trail, `${p.route}: the name should read as the visible trail`);
  }
});

// ---- breadcrumb semantics --------------------------------------------------------------------------

test('breadcrumb items are complete: ordered positions, non-empty names, absolute item URLs', () => {
  for (const p of withBreadcrumbs) {
    const [node] = nodesOf(p, 'BreadcrumbList');
    assert.ok(Array.isArray(node.itemListElement) && node.itemListElement.length >= 2, `${p.route}: a breadcrumb needs at least Home and the page`);
    node.itemListElement.forEach((it, i) => {
      assert.equal(it['@type'], 'ListItem', `${p.route} #${i + 1}`);
      assert.equal(it.position, i + 1, `${p.route} #${i + 1}: positions must be 1..n in order`);
      assert.equal(typeof it.name, 'string', `${p.route} #${i + 1}: ListItem without a name`);
      assert.ok(it.name.trim(), `${p.route} #${i + 1}: empty ListItem name`);
      assert.equal(typeof it.item, 'string', `${p.route} #${i + 1}: item must be the page URL`);
      assert.ok(it.item.startsWith(`${SITE}/`), `${p.route} #${i + 1}: item must be absolute on the canonical origin, got ${it.item}`);
    });
  }
});

test('every breadcrumb URL is a page that was actually built, and the last one is this page', () => {
  for (const p of withBreadcrumbs) {
    const [node] = nodesOf(p, 'BreadcrumbList');
    for (const it of node.itemListElement) {
      const route = it.item.slice(SITE.length);
      assert.ok(byRoute.has(route), `${p.route}: breadcrumb points at ${route}, which is not in dist/`);
    }
    const last = node.itemListElement.at(-1);
    assert.equal(last.item, p.canonical, `${p.route}: the last crumb must be the canonical URL`);
    assert.equal(node['@id'], `${p.canonical}#breadcrumb`, `${p.route}: BreadcrumbList @id`);
  }
});

test("the page's WebPage node references its BreadcrumbList by @id", () => {
  for (const p of withBreadcrumbs) {
    const [crumb] = nodesOf(p, 'BreadcrumbList');
    const webPage = (p.graph ?? []).find((n) => n['@id'] === `${p.canonical}#webpage`);
    assert.ok(webPage, `${p.route}: no WebPage-family node with @id ${p.canonical}#webpage`);
    assert.deepEqual(webPage.breadcrumb, { '@id': crumb['@id'] }, `${p.route}: WebPage.breadcrumb must point at the BreadcrumbList`);
  }
});

test('where a breadcrumb is visible, the JSON-LD names match it item for item', () => {
  const visible = withBreadcrumbs.filter((p) => p.visibleTrail);
  assert.ok(visible.length >= 4, `expected visible breadcrumbs on listing, FAQ and privacy pages; found ${visible.length}`);
  for (const p of visible) {
    const [node] = nodesOf(p, 'BreadcrumbList');
    assert.deepEqual(node.itemListElement.map((it) => it.name), p.visibleTrail, `${p.route}: JSON-LD breadcrumb differs from the one the visitor sees`);
  }
});

test('one BreadcrumbList per page, and the JSON-LD on every indexable page parses', () => {
  for (const p of indexable) {
    assert.ok(Array.isArray(p.graph) && p.graph.length > 0, `${p.route}: no JSON-LD @graph`);
    assert.ok(nodesOf(p, 'BreadcrumbList').length <= 1, `${p.route}: more than one BreadcrumbList`);
  }
});

// ---- homepage snippet --------------------------------------------------------------------------------

test('the homepage meta description fits a conventional snippet and keeps the positioning', () => {
  const en = page('/');
  const ar = page('/ar/');
  assert.ok(en.description, 'homepage has no meta description');
  assert.ok(en.description.length <= 160, `EN homepage description is ${en.description.length} chars; Google shows ~155–160 before cutting it off`);
  assert.match(en.description, /private luxury real estate boutique in Jeddah/, 'the positioning sentence must survive the cut');
  assert.match(en.description, /off-market/, 'off-market is part of the proposition');
  assert.ok(ar.description, 'Arabic homepage has no meta description');
  assert.ok(ar.description.length <= 160, `AR homepage description is ${ar.description.length} chars`);
  assert.match(ar.description, /بوتيك عقاري فاخر في جدة/);
  // The long-form description still belongs to the Organization / WebSite nodes, unchanged.
  const org = nodesOf(en, 'RealEstateAgent')[0];
  assert.match(org.description, /select international destinations/);
});

// ---- the off-plan opportunity page ----------------------------------------------------------------

test('the off-plan section names branded residences in its title, H1 and breadcrumb (EN)', () => {
  const p = page('/properties/off-plan/');
  assert.match(p.title, /^Off-plan and branded residences — Bona$/);
  assert.equal(p.h1, 'Off-plan and branded residences');
  const [crumb] = nodesOf(p, 'BreadcrumbList');
  assert.equal(crumb.itemListElement.at(-1).name, 'Off-plan and branded residences');
  const collection = nodesOf(p, 'CollectionPage')[0];
  assert.equal(collection.mainEntity.name, 'Off-plan and branded residences');
  assert.equal(collection.mainEntity.numberOfItems, collection.mainEntity.itemListElement.length);
});

// llms.txt is generated by scripts/og/gen-llms.mjs (page titles from marketing/page-meta.json, falling
// back to the generator's own labels) and copied from public/ into dist/. The site title comes from
// src/lib/i18n.ts, a separate source, so this check keeps the two from drifting apart. It compares the
// llms line against the BUILT page rather than a literal, so a future retitle only has to change one side
// for the test to point at the other.
test('llms.txt describes the off-plan page with the same title the built page carries', () => {
  const p = page('/properties/off-plan/');
  const llms = readFileSync(path.join(dist, 'llms.txt'), 'utf8');
  const line = llms.split('\n').find((l) => l.includes(`](${SITE}/properties/off-plan/)`));
  assert.ok(line, 'llms.txt has no entry for /properties/off-plan/');
  const llmsTitle = line.match(/^- \[([^\]]+)\]\(/)?.[1];
  assert.ok(llmsTitle, `could not parse the page title out of: ${line}`);
  const builtTitle = p.title.replace(/\s+—\s+Bona$/, '');
  assert.equal(llmsTitle, builtTitle, `llms.txt calls the off-plan page "${llmsTitle}" but the built <title> says "${builtTitle}"`);
  assert.equal(llmsTitle, p.h1, `llms.txt calls the off-plan page "${llmsTitle}" but the built H1 says "${p.h1}"`);
});

test('the Arabic off-plan section is unchanged and still the hreflang twin', () => {
  const p = page('/ar/properties/off-plan/');
  assert.equal(p.h1, 'مشاريع على الخارطة');
  assert.equal(p.dir, 'rtl');
  assert.equal(p.hreflang.en, `${SITE}/properties/off-plan/`);
  assert.equal(page('/properties/off-plan/').hreflang.ar, `${SITE}/ar/properties/off-plan/`);
});

// ---- the two Arabic listing opportunities: title, H1 and breadcrumb carry the exact names -------------
// Listings come and go with the portfolio sync, so whether one of these pages should exist is decided by
// the SOURCE data, not by what happens to be in dist/. The route rule (src/pages/properties/[slug].astro
// and its /ar/ twin) builds an EN and an AR page for every entry in src/data/listings.json whose slug is
// not a reserved section slug, regardless of status. So:
//   - slug absent from listings.json (or reserved)  → the listing was delisted; skip with an explicit reason.
//   - slug present in listings.json but not in dist/ → a build regression; fail loudly, never skip.
// While the page exists, every assertion below still applies in full.

test('self-check: the listing skip rule tells "absent from source" apart from "in source but not built"', () => {
  const source = new Set(['dari-q-al-salamah']);
  assert.match(listingSkipReason('no-such-listing', source), /not in src\/data\/listings\.json/);
  assert.equal(listingSkipReason('dari-q-al-salamah', source), null, 'a source-present slug must not be skipped');
  assert.match(listingSkipReason('houses', new Set(['houses'])), /reserved/);
  // The non-skipped path must FAIL, not pass quietly, when the built route is missing.
  assert.throws(() => requireBuiltListing('/properties/dari-q-al-salamah/', new Map()), /missing from dist\//);
  assert.equal(requireBuiltListing('/', byRoute).route, '/');
});

for (const [route, name] of [
  ['/ar/properties/dari-q-al-salamah/', 'شقق داري كيو، السلامة'],
  ['/ar/properties/darco-prime-waterfront-al-shati/', 'داركو برايم الواجهة البحرية، الشاطئ'],
  ['/properties/dari-q-al-salamah/', 'Dari Q Apartments, Al Salamah'],
  ['/properties/darco-prime-waterfront-al-shati/', 'Darco Prime Waterfront, Al-Shati'],
]) {
  const slug = route.replace(/^(?:\/ar)?\/properties\//, '').replace(/\/$/, '');
  const skip = listingSkipReason(slug) ?? false;
  test(`${route}: title, H1, breadcrumb and listing node all name "${name}"`, { skip }, () => {
    const p = requireBuiltListing(route);
    const ar = route.startsWith('/ar/');
    assert.equal(p.h1, name);
    assert.ok(p.title.startsWith(name), `title "${p.title}" should start with the listing name`);
    assert.ok(p.title.includes(ar ? 'جدة' : 'Jeddah'), 'the title carries the city');
    assert.ok(p.title.endsWith(ar ? '| بونا' : '| Bona'), 'brand suffix');
    const [crumb] = nodesOf(p, 'BreadcrumbList');
    assert.equal(crumb.itemListElement.at(-1).name, name);
    assert.equal(nodesOf(p, 'RealEstateListing')[0].name, name);
    assert.equal(p.canonical, `${SITE}${route}`);
    assert.equal(p.lang, ar ? 'ar' : 'en');
    assert.equal(p.dir, ar ? 'rtl' : 'ltr');
    assert.equal(p.hreflang['x-default'], `${SITE}${route.replace(/^\/ar\//, '/')}`);
  });
}

// ---- FAQ: schema only where the questions are visible ----------------------------------------------

test('FAQPage appears only on /faq/ and its questions are the visible ones', () => {
  for (const p of indexable) {
    const isFaq = /^(\/ar)?\/faq\/$/.test(p.route);
    assert.equal(nodesOf(p, 'FAQPage').length, isFaq ? 1 : 0, `${p.route}: FAQPage where ${isFaq ? 'expected' : 'no FAQ is visible'}`);
  }
  for (const route of ['/faq/', '/ar/faq/']) {
    const p = page(route);
    const [faq] = nodesOf(p, 'FAQPage');
    const questions = faq.mainEntity.map((q) => q.name);
    const visible = [...p.html.matchAll(/<summary[^>]*>[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => text(m[1]));
    assert.ok(questions.length >= 10, `${route}: only ${questions.length} questions`);
    assert.deepEqual(questions, visible, `${route}: FAQPage questions must be exactly the visible ones, in order`);
    for (const q of faq.mainEntity) {
      assert.equal(q['@type'], 'Question');
      assert.equal(q.acceptedAnswer['@type'], 'Answer');
      assert.ok(q.acceptedAnswer.text.length > 40, `${route}: thin answer for "${q.name}"`);
    }
  }
});

// ---- entity: no invented profiles ------------------------------------------------------------------

test('Organization sameAs lists only verified, live profiles', () => {
  const org = nodesOf(page('/'), 'RealEstateAgent')[0];
  assert.ok(Array.isArray(org.sameAs) && org.sameAs.includes('https://www.instagram.com/bonarealestatesa/'));
  for (const u of org.sameAs) {
    assert.ok(/^https:\/\/(www\.instagram\.com\/bonarealestatesa\/|wa\.me\/966593296933)$/.test(u), `unverified profile in sameAs: ${u}`);
  }
});
