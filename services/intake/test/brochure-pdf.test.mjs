// services/intake/test/brochure-pdf.test.mjs
//
// brochure_pdf.py — the Bona brochure rebuilt from scratch in the TK design system.
// These run the REAL script over fixture listings (solid-colour photos and a floor plan made by
// Pillow), then read the PDF back with PyMuPDF in ONE process and check what reached the page:
// the page sequence, every model and price, the enquiry facts, the links, and that nothing the
// listing keeps for itself (developer sales contacts planted in `_intake` and stray keys) is printed.
// Skipped, not failed, when `uv` is not on PATH.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'brochure_pdf.py');
const SITE_PATH = path.join(HERE, '..', '..', '..', 'src', 'data', 'site.json');
const SITE = JSON.parse(fs.readFileSync(SITE_PATH, 'utf8'));
const UV = spawnSync('uv', ['--version']).status === 0;
const WITH = ['--with', 'weasyprint', '--with', 'segno', '--with', 'pillow', '--with', 'pymupdf'];
const ARABIC_INDIC = /[٠-٩۰-۹]/;

// Developer contact details planted where the brochure must never look.
const PLANTED = ['Araco Sales', '920032546', 'sales@araco-dev.example', 'araco-dev.example', 'Mr. Waleed'];

const MAKE_IMAGES = `
import sys, pathlib
from PIL import Image, ImageDraw
d = pathlib.Path(sys.argv[1])
for i, c in enumerate([(150, 110, 80), (60, 110, 150), (90, 140, 90), (160, 150, 130)], 1):
    Image.new('RGB', (1600, 1067), c).save(d / f'{i:02d}.jpg', quality=85)
plan = Image.new('RGB', (1200, 900), (255, 255, 255))
ImageDraw.Draw(plan).rectangle((150, 120, 1050, 780), outline=(0, 0, 0), width=12)
plan.save(d / 'plan-01.jpg', quality=85)
`;

// One process reads every PDF: per page its text and its link URIs.
const READ_PDFS = `
import sys, json, pymupdf
out = {}
for p in sys.argv[1:]:
    doc = pymupdf.open(p)
    out[p] = [{'text': pg.get_text(), 'links': [l.get('uri') for l in pg.get_links() if l.get('uri')]} for pg in doc]
print(json.dumps(out, ensure_ascii=False))
`;

const img = (slug, n, en, ar, focus) => ({
  src: `/listings/${slug}/${n}.jpg`, thumb: `/listings/${slug}/${n}-thumb.webp`,
  alt: { en, ar }, ...(focus ? { focus } : {}),
});

function projectListing() {
  const slug = 'test-heights-residences-jeddah';
  const t = { en: 'Test Heights Residences, Jeddah', ar: 'مساكن تست هايتس، جدة' };
  return {
    id: 'BONA-W901', slug, sourceRef: 'WA-20261117-ABCDEF', status: 'available', category: 'off-plan',
    type: 'apartment', kind: 'apartment', featured: false, title: t,
    location: { district: { en: 'Al Rawdah', ar: 'الروضة' }, city: { en: 'Jeddah', ar: 'جدة' },
      country: { en: 'Saudi Arabia', ar: 'المملكة العربية السعودية' }, countryCode: 'SA' },
    price: { amount: 319015, currency: 'SAR', from: true, period: null, onRequest: false, subsidisedAmount: 270425 },
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: null, yearBuilt: null, floors: null },
    images: [
      img(slug, '01', `Exterior — ${t.en}`, `الواجهة الخارجية — ${t.ar}`, { x: 0.5, y: 0.7 }),
      img(slug, '02', `Garden — ${t.en}`, `الحديقة — ${t.ar}`, { x: 0.4, y: 0.55 }),
      img(slug, '03', `Gym — ${t.en}`, `النادي الرياضي — ${t.ar}`, { x: 0.45, y: 0.6 }),
      img(slug, '04', `Lobby — ${t.en}`, `الردهة — ${t.ar}`, { x: 0.5, y: 0.5 }),
    ],
    videos: [],
    description: {
      en: 'Test Heights is a residential apartment project in Al Rawdah, Jeddah. The first phase is shown in this brochure.\n\n'
        + 'Two layouts are offered: Lulu 2 with two bedrooms and Nawras 2 with three bedrooms. Both have two bathrooms.\n\n'
        + 'Residents share a health club and a children\'s nursery. The structure carries a ten-year warranty.',
      ar: 'تست هايتس مشروع شقق سكنية في حي الروضة بجدة. يعرض هذا الكتيب مرحلته الأولى.\n\n'
        + 'يضم نموذجين: لؤلؤ ٢ بغرفتي نوم ونورس ٢ بثلاث غرف نوم، وفي كل منهما دورتا مياه.\n\n'
        + 'يتشارك السكان ناديًا صحيًا وحضانة أطفال، ويحمل الهيكل الإنشائي ضمانًا مدته ١٠ سنوات.',
    },
    highlights: { en: ['Two layouts'], ar: ['نموذجان'] },
    virtualTourUrl: null, brochureUrl: null,
    project: { name: { en: 'Test Heights', ar: 'تست هايتس' }, developer: { en: 'Example Developer', ar: 'المطور المثال' } },
    unit: null, map: null, mapPrecision: null, listedAt: '2026-11-17',
    models: [
      { name: { en: 'Lulu 2', ar: 'لؤلؤ 2' }, bedrooms: 2, bathrooms: 2, areaSqm: 79.77, rooms: null,
        availability: { en: 'Buildings G–P, first to seventh floor', ar: 'المباني G–P، من الدور ١ إلى ٧' },
        price: 319015, subsidisedPrice: 270425,
        floorPlan: { src: `/listings/${slug}/plan-01.jpg`, thumb: `/listings/${slug}/plan-01-thumb.webp` } },
      { name: { en: 'Nawras 2', ar: 'نورس 2' }, bedrooms: 3, bathrooms: 2, areaSqm: 105.02, rooms: null,
        availability: null, price: 419994, subsidisedPrice: 356024, floorPlan: null },
    ],
    amenities: { en: ['Health club', 'Children\'s nursery'], ar: ['نادٍ صحي', 'حضانة أطفال'] },
    nearby: { en: ['King Abdulaziz International Airport', 'Obhur beach'], ar: ['مطار الملك عبدالعزيز الدولي', 'شاطئ أبحر'] },
    warranties: { en: ['Structure · 10 years'], ar: ['الهيكل الإنشائي · ١٠ سنوات'] },
    // Never read by the brochure: the intake's provenance and stray keys carrying developer contacts.
    hidden: false,
    _intake: { caption: 'Araco Sales 920032546 sales@araco-dev.example', pdfFileName: 'araco-dev.example brochure.pdf',
      warnings: [], site: 'https://www.araco-dev.example' },
    salesContact: { name: 'Mr. Waleed', phone: '920032546', email: 'sales@araco-dev.example' },
  };
}

function singleListing() {
  const slug = 'garden-villa-al-rawdah';
  const t = { en: 'Garden Villa, Al Rawdah', ar: 'فيلا الحديقة، حي الروضة' };
  return {
    id: 'BONA-W902', slug, sourceRef: 'WA-20261117-FEDCBA', status: 'available', category: 'buy', type: 'villa',
    kind: 'house', featured: false, title: t,
    location: { district: { en: 'Al Rawdah', ar: 'الروضة' }, city: { en: 'Jeddah', ar: 'جدة' },
      country: { en: 'Saudi Arabia', ar: 'المملكة العربية السعودية' }, countryCode: 'SA' },
    price: { amount: null, currency: 'SAR', from: false, period: null, onRequest: true },
    specs: { beds: 4, baths: 6, areaSqm: 537, plotSqm: 625.5, yearBuilt: 2019, floors: 2 },
    images: [
      img(slug, '01', `Façade — ${t.en}`, `الواجهة — ${t.ar}`, null),
      img(slug, '02', `Living room — ${t.en}`, `غرفة المعيشة — ${t.ar}`, null),
      img(slug, '03', `Kitchen — ${t.en}`, `المطبخ — ${t.ar}`, null),
      img(slug, '04', `Garden — ${t.en}`, `الحديقة — ${t.ar}`, null),
    ],
    videos: [],
    description: {
      en: 'A four-bedroom villa on a quiet street in Al Rawdah.\n\nThe garden faces north and the plot is 625.5 sq m.',
      ar: 'فيلا بأربع غرف نوم في شارع هادئ بحي الروضة.\n\nتطل الحديقة على الشمال ومساحة الأرض ٦٢٥٫٥ مترًا مربعًا.',
    },
    highlights: { en: ['Four bedrooms'], ar: ['أربع غرف نوم'] },
    virtualTourUrl: null, brochureUrl: null, project: null, unit: null,
    map: { lat: 21.5501, lng: 39.1702 }, mapPrecision: 'exact', listedAt: '2026-11-17',
    _intake: { caption: 'Araco Sales 920032546' },
  };
}

describe('brochure_pdf.py — the TK-system Bona brochure', { skip: !UV && 'uv not installed' }, () => {
  let base;
  const runs = {};
  let pdfs = {};

  function run(name, listing, extra = []) {
    const dir = path.join(base, name);
    const files = path.join(dir, 'files');
    fs.mkdirSync(files, { recursive: true });
    const mk = spawnSync('uv', ['run', '--with', 'pillow', 'python', '-I', '-c', MAKE_IMAGES, files], { encoding: 'utf8' });
    assert.equal(mk.status, 0, mk.stderr);
    const listingPath = path.join(dir, 'listing.json');
    fs.writeFileSync(listingPath, typeof listing === 'string' ? listing : JSON.stringify(listing));
    const out = path.join(dir, 'brochure.pdf');
    const res = spawnSync('uv', ['run', ...WITH, 'python', '-I', SCRIPT, listingPath, files, SITE_PATH, out, ...extra],
      { encoding: 'utf8', timeout: 240000 });
    const lines = res.stdout.trim().split('\n').filter(Boolean);
    runs[name] = { status: res.status, lines, json: lines.length ? JSON.parse(lines[lines.length - 1]) : null, out, stderr: res.stderr };
    return runs[name];
  }

  // BROCHURE_TEST_KEEP=<dir> keeps the fixtures and PDFs there to look at (it is not cleaned up).
  const KEEP = process.env.BROCHURE_TEST_KEEP;

  before(() => {
    // Under ~/.cache, never straight in $HOME (and not /tmp, which is RAM on this host).
    const root = path.join(os.homedir(), '.cache', 'bona-tests');
    fs.mkdirSync(root, { recursive: true });
    base = KEEP ? (fs.mkdirSync(KEEP, { recursive: true }), KEEP) : fs.mkdtempSync(path.join(root, 'brochure-pdf-'));
    run('project', projectListing());
    run('single', singleListing());
    const ok = Object.values(runs).filter((r) => r.json?.ok).map((r) => r.out);
    if (ok.length) {
      const rd = spawnSync('uv', ['run', '--with', 'pymupdf', 'python', '-I', '-c', READ_PDFS, ...ok],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      assert.equal(rd.status, 0, rd.stderr);
      pdfs = JSON.parse(rd.stdout);
    }
  });

  after(() => { if (base && !KEEP) fs.rmSync(base, { recursive: true, force: true }); });

  const textOf = (name) => pdfs[runs[name].out].map((p) => p.text).join('\n');
  const flat = (s) => s.replace(/\s+/g, '').toLowerCase();   // tracked caps come out as "D E V E L O P E R"

  describe('a project with unit models (W023-like)', () => {
    it('prints one JSON line and succeeds', () => {
      const r = runs.project;
      assert.equal(r.status, 0, r.stderr.slice(-2000));
      assert.equal(r.lines.length, 1, `stdout must be ONE line: ${r.lines.join(' | ')}`);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.id, 'BONA-W901');
      assert.equal(r.json.bytes, fs.statSync(r.out).size);
    });

    it('has the spec page sequence: flysheet, cover, narrative, residences, one model page, photos, amenities, location', () => {
      const { kinds, pages } = runs.project.json;
      assert.equal(pages, kinds.length);
      assert.equal(pdfs[runs.project.out].length, pages);
      assert.deepEqual(kinds.slice(0, 2), ['flysheet', 'cover']);
      const seq = kinds.slice(2).filter((k, i, a) => i === 0 || a[i - 1] !== k);
      assert.deepEqual(seq, ['narrative', 'residences', 'model', 'photos', 'amenities', 'location'], kinds.join(','));
      assert.equal(kinds.filter((k) => k === 'residences').length, 1);
      assert.equal(kinds.filter((k) => k === 'model').length, 1, 'only the model with a floor plan gets a page');
      assert.equal(kinds.filter((k) => k === 'amenities').length, 1);
      assert.ok(kinds.filter((k) => k === 'photos').length >= 1);
    });

    it('lists every model in English and Arabic with its printed prices', () => {
      const text = textOf('project');
      for (const en of ['Lulu 2', 'Nawras 2']) assert.ok(flat(text).includes(flat(en)), en);
      for (const ar of ['لؤلؤ', 'نورس']) assert.ok(text.includes(ar), ar);
      for (const p of ['SAR 319,015', 'SAR 270,425', 'SAR 419,994', 'SAR 356,024']) assert.ok(text.includes(p), p);
      assert.ok(text.includes('270,425'));
      assert.ok(flat(text).includes('residence01of02'), 'model page runhead');
    });

    it('names the developer as text and carries the enquiry facts from site.json', () => {
      const text = textOf('project');
      assert.ok(flat(text).includes('developer'));
      assert.ok(text.includes('Example Developer'));
      assert.ok(text.includes(`FAL ${SITE.licences.fal}`));
      assert.ok(text.includes('BONA-W901'));
      for (const part of SITE.hours.en.split(', ')) assert.ok(text.includes(part), `hours: ${part}`);
      assert.ok(text.includes(SITE.phone.display));
      assert.ok(text.includes(SITE.email));
    });

    it('links the listing page (QR tile and button), WhatsApp and email', () => {
      const links = pdfs[runs.project.out].flatMap((p) => p.links);
      const url = `${SITE.url.replace(/\/+$/, '')}/properties/test-heights-residences-jeddah/`;
      assert.ok(links.filter((l) => l === url).length >= 2, `listing URL links: ${links.join(' ')}`);
      assert.ok(links.includes(`https://wa.me/${SITE.whatsapp.wa}`));
      assert.ok(links.includes(`mailto:${SITE.email}`));
      assert.ok(!links.some((l) => /google\.com\/maps/.test(l)), 'no map pin -> no Maps link');
    });

    it('prints nothing the listing keeps for itself (developer contacts in _intake / stray keys)', () => {
      const text = textOf('project');
      const links = pdfs[runs.project.out].flatMap((p) => p.links).join(' ');
      for (const s of PLANTED) {
        assert.ok(!text.includes(s) && !flat(text).includes(flat(s)), `printed: ${s}`);
        assert.ok(!links.includes(s), `linked: ${s}`);
      }
    });

    it('uses Western digits only (Arabic-Indic digits in the listing are converted)', () => {
      const text = textOf('project');
      assert.ok(!ARABIC_INDIC.test(text), text.match(ARABIC_INDIC)?.[0]);
      // PyMuPDF returns the mixed-direction run in either order, without the space ("سنوات10").
      assert.match(flat(text), /سنوات10|10سنوات/, 'the warranty years came through as 10');
    });

    it('marks developer renders as illustrative and drops the title from captions', () => {
      const text = flat(textOf('project'));
      for (const c of ['garden·illustrative', 'gym·illustrative', 'lobby·illustrative']) assert.ok(text.includes(c), c);
      assert.ok(!text.includes(flat('Garden — Test Heights')), 'caption keeps its " — <title>" suffix');
    });

    it('stays small', () => {
      assert.ok(runs.project.json.bytes < 6 * 1024 * 1024, `${runs.project.json.bytes} bytes`);
    });
  });

  describe('a single property (no project, no models, no amenities)', () => {
    it('has no residences, model or amenities pages', () => {
      const r = runs.single;
      assert.equal(r.status, 0, r.stderr.slice(-2000));
      assert.equal(r.json.ok, true);
      const { kinds } = r.json;
      assert.deepEqual(kinds.slice(0, 2), ['flysheet', 'cover']);
      assert.equal(kinds[kinds.length - 1], 'location');
      for (const k of ['residences', 'model', 'amenities']) assert.ok(!kinds.includes(k), `${k} page in ${kinds}`);
      assert.ok(kinds.includes('narrative') && kinds.includes('photos'));
    });

    it('builds the ledger from specs and says price on request', () => {
      const text = textOf('single');
      const f = flat(text);
      for (const lab of ['specification', 'bedrooms', 'bathrooms', 'area', 'plot', 'floors', 'yearbuilt']) assert.ok(f.includes(lab), lab);
      for (const v of ['04', '06', '537', '625.50', '2019', '02']) assert.ok(text.includes(v), v);
      assert.ok(f.includes('priceonrequest'));
      assert.ok(f.includes('theproperty'), 'runhead "The Property"');
      assert.ok(!ARABIC_INDIC.test(text));
      assert.ok(!text.includes('920032546'));
      assert.ok(!f.includes('illustrative'), 'not a project: no "Illustrative" captions');
    });

    it('links Google Maps for an exact pin', () => {
      const links = pdfs[runs.single.out].flatMap((p) => p.links);
      assert.ok(links.includes('https://www.google.com/maps?q=21.550100,39.170200'), links.join(' '));
    });
  });

  describe('failures', () => {
    it('a malformed listing -> ok:false JSON line, exit 1', () => {
      const r = run('malformed', { id: 'BONA-W903', slug: 'Not A Slug!', title: { en: 'x' } });
      assert.equal(r.status, 1);
      assert.equal(r.lines.length, 1, r.lines.join(' | '));
      assert.equal(r.json.ok, false);
      assert.equal(r.json.reason, 'error');
      assert.match(r.json.error, /slug/);
      assert.ok(!fs.existsSync(r.out));
    });

    it('a listing that is not JSON -> ok:false, exit 1', () => {
      const r = run('notjson', '{ nope');
      assert.equal(r.status, 1);
      assert.equal(r.json.ok, false);
      assert.match(r.json.error, /JSON/);
    });

    it('a photo missing from files-dir -> ok:false naming the file', () => {
      const l = singleListing();
      l.images.push(img(l.slug, '09', 'Pool', 'المسبح', null));
      const r = run('missing', l);
      assert.equal(r.status, 1);
      assert.equal(r.json.ok, false);
      assert.match(r.json.error, /09\.jpg/);
    });

    it('over --max-mb even after scaling -> too-large and no output file', () => {
      const r = run('toolarge', singleListing(), ['--max-mb', '0.02']);
      assert.equal(r.status, 1);
      assert.equal(r.json.ok, false);
      assert.equal(r.json.reason, 'too-large');
      assert.ok(!fs.existsSync(r.out));
    });
  });
});
