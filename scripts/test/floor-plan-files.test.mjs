// A unit model's floor plan is two site-local files (rules.mjs LOCAL_PLAN_SRC / LOCAL_PLAN_THUMB):
// plan-NN.jpg and plan-NN-thumb.webp. Like a photo or a walkthrough clip, a plan the listing names
// but public/ does not hold is a broken page, so scripts/curate/build.mjs refuses to build
// (rules.mjs localFilesOf lists every such file, for build.mjs and validate.mjs --head alike).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FILES = [
  'scripts/curate/build.mjs', 'scripts/curate/listings.source.mjs', 'scripts/curate/rooms.mjs', 'scripts/curate/rules.mjs',
  'scripts/curate/licences.json', 'scripts/curate/inbox', 'scripts/tk-gallery-data.json', 'scripts/tk-public-properties.snapshot.json',
  'src/data/site.json', 'src/data/kind-map.json', 'src/data/district-pins.json', 'src/lib/units-summary.mjs', 'marketing/daily/property-reviews.json',
];

/**
 * A copy of what build.mjs reads, under ~/.cache (not /tmp, which is RAM on this host). public/ is
 * symlinked folder by folder, except `own`: that one is a real folder of per-file links, so the test
 * can add a plan file without ever writing into the repository.
 */
function tree(own) {
  const base = path.join(os.homedir(), '.cache', 'bona-tests');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(base, 'floor-plan-files-')));
  for (const f of FILES) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
  }
  fs.mkdirSync(path.join(dir, 'public/listings'), { recursive: true });
  for (const d of fs.readdirSync(path.join(ROOT, 'public/listings'))) {
    const from = path.join(ROOT, 'public/listings', d);
    const to = path.join(dir, 'public/listings', d);
    if (d !== own) { fs.symlinkSync(from, to); continue; }
    fs.mkdirSync(to);
    for (const f of fs.readdirSync(from)) fs.symlinkSync(path.join(from, f), path.join(to, f));
  }
  fs.symlinkSync(path.join(ROOT, 'public/land'), path.join(dir, 'public/land'));
  return dir;
}
const build = (dir) => spawnSync(process.execPath, [path.join(dir, 'scripts/curate/build.mjs')], { cwd: dir, encoding: 'utf8' });

/** The first published intake listing whose photos are on disk: it gets one unit model with a plan. */
function pickInboxListing() {
  const inbox = path.join(ROOT, 'scripts/curate/inbox');
  for (const name of fs.readdirSync(inbox).filter((n) => n.endsWith('.json') && n !== '_index.json').sort()) {
    const l = JSON.parse(fs.readFileSync(path.join(inbox, name), 'utf8'));
    if (l.hidden || !l.slug || !Array.isArray(l.images) || !l.images.length) continue;
    if (fs.existsSync(path.join(ROOT, 'public/listings', l.slug))) return { name, listing: l };
  }
  return null;
}

test('build.mjs refuses a unit model whose floor plan or its thumbnail is not in public/, and builds once both are', () => {
  const picked = pickInboxListing();
  assert.ok(picked, 'an intake listing with its photos on disk');
  const { name, listing } = picked;
  const dir = tree(listing.slug);
  try {
    const file = path.join(dir, 'scripts/curate/inbox', name);
    // The plan must be missing at first, so take the first plan number the listing does not have on
    // disk: once a listing is enriched its own plan-01.jpg is there, and the build rightly accepts it.
    const pub = path.join(ROOT, 'public/listings', listing.slug);
    let n = 1;
    const nn = () => String(n).padStart(2, '0');
    while (n < 999 && (fs.existsSync(path.join(pub, `plan-${nn()}.jpg`)) || fs.existsSync(path.join(pub, `plan-${nn()}-thumb.webp`)))) n += 1;
    const plan = { src: `/listings/${listing.slug}/plan-${nn()}.jpg`, thumb: `/listings/${listing.slug}/plan-${nn()}-thumb.webp` };
    fs.writeFileSync(file, JSON.stringify({
      ...listing,
      models: [{ name: { en: 'A1', ar: 'نموذج A1' }, bedrooms: 2, bathrooms: 2, areaSqm: 120, rooms: null, availability: null, price: null, subsidisedPrice: null, floorPlan: plan }],
    }, null, 2));

    const none = build(dir);
    assert.notEqual(none.status, 0, 'no plan file: no build');
    assert.match(none.stderr, new RegExp(`inbox/${name}: models\\[0\\]\\.floorPlan\\.src missing: public${plan.src}`));

    fs.writeFileSync(path.join(dir, 'public', plan.src), 'jpg');
    const noThumb = build(dir);
    assert.notEqual(noThumb.status, 0, 'the plan without its thumbnail: no build');
    assert.match(noThumb.stderr, new RegExp(`inbox/${name}: models\\[0\\]\\.floorPlan\\.thumb missing: public${plan.thumb}`));

    fs.writeFileSync(path.join(dir, 'public', plan.thumb), 'webp');
    const both = build(dir);
    assert.equal(both.status, 0, both.stderr);
    const out = JSON.parse(fs.readFileSync(path.join(dir, 'src/data/listings.json'), 'utf8'));
    assert.deepEqual(out.find((l) => l.id === listing.id)?.models?.[0]?.floorPlan, plan);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
