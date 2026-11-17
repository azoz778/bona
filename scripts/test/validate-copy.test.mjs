// The site validator's copy check (scripts/curate/validate.mjs) — the deploy's last gate for a
// contact detail or another brand in a listing's words. It shares FORBIDDEN and the digit normaliser
// with the WhatsApp intake (scripts/curate/rules.mjs), so a number written in Arabic-Indic or Persian
// digits is caught here too, and ordinary listing copy (./ordinary-copy-fixture.mjs) is left alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ORDINARY_COPY } from './ordinary-copy-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FILES = ['scripts/curate/validate.mjs', 'scripts/curate/rules.mjs', 'src/lib/units-summary.mjs', 'src/data/kind-map.json', 'src/data/listings.json'];

// Under ~/.cache, not os.tmpdir(): /tmp is RAM on this host.
const TMP_BASE = path.join(os.homedir(), '.cache', 'bona-tests');

/** A copy of just what validate.mjs reads, with listings.json rewritten by `edit`. */
function validateWith(edit) {
  fs.mkdirSync(TMP_BASE, { recursive: true });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TMP_BASE, 'validate-copy-')));
  try {
    for (const f of FILES) {
      fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
    }
    const file = path.join(dir, 'src/data/listings.json');
    const listings = JSON.parse(fs.readFileSync(file, 'utf8'));
    edit(listings);
    fs.writeFileSync(file, JSON.stringify(listings, null, 2));
    return spawnSync(process.execPath, [path.join(dir, 'scripts/curate/validate.mjs')], { cwd: dir, encoding: 'utf8' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('validate.mjs leaves ordinary listing copy alone, in both languages', () => {
  const res = validateWith((listings) => {
    const l = listings[0];
    l.description.en = `${l.description.en}\n\n${ORDINARY_COPY.join('\n\n')}`;
    l.description.ar = `${l.description.ar}\n\n${ORDINARY_COPY.join('\n\n')}`;
  });
  assert.equal(res.status, 0, res.stderr);
});

test('validate.mjs catches a contact number written in Arabic-Indic or Persian digits', () => {
  for (const leak of ['الرقم الموحد ٩٢٠٠٠١٢٣٤', 'جوال ٠٥٥١٢٣٤٥٦٧', 'هاتف ٠١٢٦٦٠١٢٣٤', 'الرقم المجاني ٨٠٠١٢٤٤٤٤٤', 'للتواصل ۰۵۵۱۲۳۴۵۶۷']) {
    let id;
    const res = validateWith((listings) => {
      const l = listings[0];
      id = l.id;
      l.description.ar = `${l.description.ar}\n\n${leak}`;
    });
    assert.equal(res.status, 1, `${leak} must fail the deploy`);
    assert.match(res.stderr, new RegExp(`${id}: description\\.ar mentions a contact detail or another brand: `), res.stderr);
  }
});

test('validate.mjs catches an ALL-CAPS domain, and names a leak as the copy writes it', () => {
  for (const [leak, shown] of [['Sales: ACME-HOMES.SA', 'ACME-HOMES.SA'], ['جوال ٠٥٥١٢٣٤٥٦٧', '٠٥٥١٢٣٤٥٦٧']]) {
    let id;
    const res = validateWith((listings) => {
      const l = listings[0];
      id = l.id;
      l.description.en = `${l.description.en}\n\n${leak}`;
    });
    assert.equal(res.status, 1, `${leak} must fail the deploy`);
    assert.ok(res.stderr.includes(`${id}: description.en mentions a contact detail or another brand: ${shown}`), res.stderr);
  }
});

// ---- unit models, floor plans and the project fact lists (rules.mjs modelsProblems) ------------
/** Give the first priced, whole-listing sale in listings.json two unit models, as the intake publishes them. */
function addModels(listings) {
  const l = listings.find((x) => x.category !== 'rent' && x.kind !== 'land' && !x.unit && !x.price?.onRequest && x.price?.amount > 0);
  l.price = { ...l.price, amount: 319015, from: true, onRequest: false, period: null, subsidisedAmount: 270425 };
  l.models = [
    {
      name: { en: 'Nawras 2', ar: 'نورس 2' }, bedrooms: 3, bathrooms: 2, areaSqm: 105.02,
      rooms: { en: ['Laundry'], ar: ['غرفة غسيل'] }, availability: { en: 'Buildings G–P', ar: 'المباني G–P' },
      price: 419994, subsidisedPrice: 356024,
      floorPlan: { src: `/listings/${l.slug}/plan-01.jpg`, thumb: `/listings/${l.slug}/plan-01-thumb.webp` },
    },
    { name: { en: 'Lulu', ar: 'لؤلؤ' }, bedrooms: 2, bathrooms: 2, areaSqm: 88, rooms: null, availability: null, price: 319015, subsidisedPrice: 270425, floorPlan: null },
  ];
  l.amenities = { en: ['Health club'], ar: ['نادٍ صحي'] };
  l.warranties = { en: ['Structure — 10 years'], ar: ['الهيكل الإنشائي — 10 سنوات'] };
  return l;
}

test('validate.mjs accepts unit models with floor plans and the fact lists', () => {
  const res = validateWith((listings) => { addModels(listings); });
  assert.equal(res.status, 0, res.stderr);
});

test('validate.mjs refuses a bad unit model, a headline that disagrees with the models, and a leak in the new fields', () => {
  const cases = [
    ['a Sakani price not below the price', (l) => { l.models[0].subsidisedPrice = 419994; }, 'models\\[0\\]\\.subsidisedPrice must be lower than its price'],
    ['a floor plan of another listing', (l) => { l.models[0].floorPlan.src = '/listings/someone-else/plan-01.jpg'; }, 'models\\[0\\]\\.floorPlan\\.src is not /listings/'],
    ['a headline that is not the cheapest model', (l) => { l.price.amount = 300000; }, 'price\\.amount must be the lowest unit-model price \\(319,015\\)'],
    ['the model\'s evidence', (l) => { l.models[1].evidence = { page: 3, quote: '319,015' }; }, 'models\\[1\\] has an unknown field "evidence"'],
    ['a phone number in a model name', (l) => { l.models[1].name.ar = 'لؤلؤ ٠٥٥١٢٣٤٥٦٧'; }, 'models\\[1\\]\\.name\\.ar mentions a contact detail or another brand'],
    ['amenities of unequal length', (l) => { l.amenities.ar.push('مسبح'); }, 'amenities\\.en and \\.ar must have the same length'],
  ];
  for (const [label, mutate, message] of cases) {
    let id;
    const res = validateWith((listings) => {
      const l = addModels(listings);
      id = l.id;
      mutate(l);
    });
    assert.equal(res.status, 1, `${label} must fail the deploy`);
    assert.match(res.stderr, new RegExp(`${id}: ${message}`), `${label}: ${res.stderr}`);
  }
});
