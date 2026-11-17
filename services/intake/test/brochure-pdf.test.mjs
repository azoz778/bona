// services/intake/test/brochure-pdf.test.mjs
//
// brochure_pdf.py — the Bona brochure rebuilt from scratch in the TK design system.
// These run the REAL script over fixture listings (solid-colour photos and floor plans made by
// Pillow), then read the PDFs back with PyMuPDF in ONE process and check what reached the page:
// the page sequence, every model and price, the enquiry facts, the links, the embedded images, and
// that nothing the listing keeps for itself (developer sales contacts planted in `_intake` and stray
// keys) is printed. The renders run three at a time; a few pure helpers are checked in one more
// Python process. Skipped, not failed, when `uv` is not on PATH.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ROOMS } from '../../../scripts/curate/rooms.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = path.join(HERE, '..');
const SCRIPT = path.join(SCRIPT_DIR, 'brochure_pdf.py');
const SITE_PATH = path.join(HERE, '..', '..', '..', 'src', 'data', 'site.json');
const SITE = JSON.parse(fs.readFileSync(SITE_PATH, 'utf8'));
const UV = spawnSync('uv', ['--version']).status === 0;
// WeasyPrint is pinned: the script reads its laid-out box tree, which is private API (see the script).
const WITH = ['--with', 'weasyprint==70.0', '--with', 'segno', '--with', 'pillow', '--with', 'pymupdf'];
const ARABIC_INDIC = /[٠-٩۰-۹]/;
const RENDERS_AT_ONCE = 3;

// Developer contact details planted where the brochure must never look.
const PLANTED = ['Araco Sales', '920032546', 'sales@araco-dev.example', 'araco-dev.example', 'Mr. Waleed'];

// 8 photos (01–08) and 2 floor plans, made once and copied into each fixture's files-dir.
const MAKE_IMAGES = `
import sys, pathlib
from PIL import Image, ImageDraw
d = pathlib.Path(sys.argv[1])
cols = [(150, 110, 80), (60, 110, 150), (90, 140, 90), (160, 150, 130), (120, 90, 140), (70, 70, 70), (180, 120, 60), (40, 120, 120)]
for i, c in enumerate(cols, 1):
    Image.new('RGB', (1600, 1067), c).save(d / f'{i:02d}.jpg', quality=85)
for n in (1, 2):
    plan = Image.new('RGB', (1200, 900), (255, 255, 255))
    ImageDraw.Draw(plan).rectangle((150, 120, 1050, 780), outline=(0, 0, 0), width=12 * n)
    plan.save(d / f'plan-{n:02d}.jpg', quality=85)
`;

// One process reads every PDF: per page its text and link URIs; per file every raster image XObject.
const READ_PDFS = `
import sys, json, pymupdf
out = {}
for p in sys.argv[1:]:
    doc = pymupdf.open(p)
    rasters = []
    for x in range(1, doc.xref_length()):
        if doc.xref_get_key(x, 'Subtype')[1] == '/Image':
            rasters.append([int(doc.xref_get_key(x, 'Width')[1]), int(doc.xref_get_key(x, 'Height')[1])])
    pages = [{'text': pg.get_text(), 'links': [l.get('uri') for l in pg.get_links() if l.get('uri')]} for pg in doc]
    out[p] = {'pages': pages, 'rasters': rasters}
print(json.dumps(out, ensure_ascii=False))
`;

// Pure helpers, each checked on its own (one failure does not hide the others).
const UNIT = String.raw`
import sys, json, io, types, contextlib, pathlib, time
sys.path.insert(0, sys.argv[1])
scratch = pathlib.Path(sys.argv[2])
import brochure_pdf as b
out = {}
def check(name, fn):
    try:
        out[name] = {'ok': True, 'value': fn()}
    except BaseException as e:
        out[name] = {'ok': False, 'error': f'{type(e).__name__}: {e}'}

def version_gate():
    saved = sys.modules.get('weasyprint')
    fake = types.ModuleType('weasyprint')
    fake.__version__ = '66.0'
    sys.modules['weasyprint'] = fake
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            code = b.main(['listing.json', 'files', 'site.json', 'out.pdf'])
    finally:
        if saved is None:
            sys.modules.pop('weasyprint', None)
        else:
            sys.modules['weasyprint'] = saved
    return {'code': code, 'line': buf.getvalue().strip()}
check('version', version_gate)
check('groups', lambda: {n: b.photo_groups(n) for n in range(0, 11)})
check('rooms', lambda: [list(v) for v in b.ROOM_LABELS.values()])
check('captions', lambda: [list(b.room_caption(*c)) for c in [
    ("Illustrative — developer's finished unit at Test Heights: Garden — Test Heights Residences, Jeddah",
     'صورة توضيحية — وحدة منجزة من المطوّر في تست هايتس: الحديقة — مساكن تست هايتس، جدة',
     'Test Heights Residences, Jeddah', 'مساكن تست هايتس، جدة', 'Test Heights', 'تست هايتس'),
    ('Gym — Test Heights Residences, Jeddah', 'النادي الرياضي — مساكن تست هايتس، جدة',
     'Test Heights Residences, Jeddah', 'مساكن تست هايتس، جدة', '', ''),
    ('Gym — An Older Title Of The Listing', 'النادي الرياضي — عنوان قديم للإعلان',
     'Test Heights Residences, Jeddah', 'مساكن تست هايتس، جدة', '', ''),
    ('Rooftop deck · Illustrative — Test Heights Residences, Jeddah', 'سطح · صورة توضيحية — مساكن تست هايتس، جدة',
     'Test Heights Residences, Jeddah', 'مساكن تست هايتس، جدة', '', ''),
]])

def stale_work():
    from PIL import Image
    files, work = scratch / 'files', scratch / 'work'
    files.mkdir(parents=True)
    work.mkdir()
    Image.new('RGB', (1600, 1067), (200, 30, 30)).save(files / '02.jpg', quality=90)
    first = b.Images(files, work).path('/listings/x/02.jpg', 'half', 0.75)
    c1 = Image.open(first).convert('RGB').getpixel((10, 10))
    time.sleep(0.05)
    Image.new('RGB', (1500, 1000), (30, 30, 200)).save(files / '02.jpg', quality=90)
    second = b.Images(files, work).path('/listings/x/02.jpg', 'half', 0.75)
    c2 = Image.open(second).convert('RGB').getpixel((10, 10))
    return {'first': list(c1), 'second': list(c2)}
check('stale', stale_work)

def fetcher():
    root = scratch / 'ok'
    root.mkdir()
    (root / 'a.txt').write_text('inside')
    (scratch / 'outside.txt').write_text('outside')
    f = b.LocalFetcher([root])
    res = {'inside': f.fetch((root / 'a.txt').as_uri()).read().decode()}
    for k, url in (('outside', (scratch / 'outside.txt').as_uri()),
                   ('dotdot', (root / 'a.txt').as_uri().replace('/a.txt', '/../outside.txt')),
                   ('http', 'https://example.com/x.png')):
        try:
            f.fetch(url)
            res[k] = 'fetched'
        except Exception:
            res[k] = 'refused'
    res['refused'] = len(f.refused)
    return res
check('fetcher', fetcher)
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
      img(slug, '04', `Lobby — ${t.en}`, `البهو — ${t.ar}`, { x: 0.5, y: 0.5 }),
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
      img(slug, '01', `Façade at night — ${t.en}`, `الواجهة ليلاً — ${t.ar}`, null),
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

// ---- adversarial and layout fixtures --------------------------------------------------------------
const INJ = {
  title: 'Inject <b>BOLD</b> & "quote" </div><a href="https://evil.example/t">EVIL</a>',
  desc: 'Para <img src="file:///etc/passwd"> one.</p><p>INJECTED PARA',
  model: '<i>Lulu</i> 2',
  avail: '<a href="https://evil.example/av">AVAIL</a>',
  amenity: '<u>Health</u> club',
  alt: 'Garden <img src=x onerror=1>',
  dev: '<a href="https://evil.example/dev">DEV</a>',
};

function injectListing() {
  const l = projectListing();
  l.title.en = INJ.title;
  l.description.en = `${INJ.desc}\n\nSecond <script>x()</script> para.`;
  l.models[0].name.en = INJ.model;
  l.models[0].availability.en = INJ.avail;
  l.amenities.en[0] = INJ.amenity;
  l.images[1].alt.en = `${INJ.alt} — ${l.title.en}`;
  l.project.developer.en = INJ.dev;
  return l;
}

// One paragraph per language, 24 numbered sentences each (~3,500 characters).
const LONG_EN = Array.from({ length: 24 }, (_, i) => `Mark${String(i + 1).padStart(2, '0')} the residences are arranged around a `
  + 'landscaped central garden with shaded walkways, seating and play areas for children, and every building has its own lobby.').join(' ');
const LONG_AR = Array.from({ length: 24 }, () => 'تتوزع المساكن حول حديقة مركزية منسقة تضم ممرات مظللة وجلسات ومناطق لعب للأطفال، '
  + 'ولكل مبنى من مباني المشروع ردهة مستقلة ومصاعد خاصة به وموقف للسيارات.').join(' ');

function longParaListing() {
  const l = projectListing();
  l.description = { en: LONG_EN, ar: LONG_AR };
  return l;
}

const BIG_NAMES = ['Lulu 2', 'Nawras 2', 'Saif 2', 'Saif 3', 'Marafi 3', 'Al Zumurrud 2', 'Al Fayrouz 1', 'Kahraman 2',
  'Yaqout 3', 'Murjan 1', 'Durra 4', 'Almas 5'];
function bigListing() {
  const l = projectListing();
  const slug = l.slug;
  l.models = BIG_NAMES.map((en, i) => ({
    name: { en, ar: `نموذج ${i + 1}` }, bedrooms: 2 + (i % 3), bathrooms: 2 + (i % 2), areaSqm: 80 + i * 11.5, rooms: null,
    availability: null, price: 300000 + i * 41000, subsidisedPrice: 250000 + i * 35000,
    floorPlan: i === 0 ? { src: `/listings/${slug}/plan-01.jpg`, thumb: null } : null,
  }));
  l.amenities = { en: Array.from({ length: 44 }, (_, i) => `Amenity number ${i + 1}`), ar: Array.from({ length: 44 }, (_, i) => `مرفق رقم ${i + 1}`) };
  l.nearby = { en: Array.from({ length: 12 }, (_, i) => `Nearby place ${i + 1}`), ar: Array.from({ length: 12 }, (_, i) => `مكان قريب ${i + 1}`) };
  l.warranties = { en: ['Structure · 10 years', 'Plumbing · 2 years'], ar: ['الهيكل الإنشائي · 10 سنوات', 'السباكة · سنتان'] };
  const rooms = ['Exterior', 'Garden', 'Gym', 'Lobby', 'Swimming pool', 'Kitchen', 'Bedroom', 'Bathroom'];
  const ar = ['الواجهة الخارجية', 'الحديقة', 'النادي الرياضي', 'البهو', 'المسبح', 'المطبخ', 'غرفة النوم', 'الحمام'];
  l.images = rooms.map((r, i) => img(slug, String(i + 1).padStart(2, '0'), `${r} — ${l.title.en}`, `${ar[i]} — ${l.title.ar}`, null));
  return l;
}

function refitListing() {
  const l = projectListing();
  l.models[0].availability = {
    en: 'Buildings G–P, first to seventh floor; sea-facing units in buildings A–C on the ninth to twelfth floors, subject to '
      + 'availability at contract, phase two only, corner units excluded, and the penthouse level offered separately by the '
      + 'developer on request.',
    ar: 'المباني G–P، من الأول إلى السابع؛ الوحدات المطلة على البحر في المباني A–C من التاسع إلى الثاني عشر، حسب التوفر عند '
      + 'التعاقد، المرحلة الثانية فقط، باستثناء الوحدات الركنية، ودور البنتهاوس يُعرض منفصلًا عند الطلب.',
  };
  return l;
}

function noFitListing() {
  const l = singleListing();
  l.title.en = Array.from({ length: 40 }, () => 'An Extraordinarily Long Title').join(' ');
  l.images = l.images.slice(0, 1);
  return l;
}

// A project unit: the intake writes every alt as "Illustrative — developer's finished unit at <project>: <room> — <title>".
function projUnitListing() {
  const l = projectListing();
  l.unit = { floor: 3, block: 'G', unitRef: null };
  const rooms = [['Exterior', 'الواجهة الخارجية'], ['Garden', 'الحديقة'], ['Satellite view of the surrounding area', 'صورة جوية للمنطقة المحيطة'],
    ['Gym', 'النادي الرياضي']];
  l.images = l.images.map((im, i) => ({
    ...im,
    alt: {
      en: `Illustrative — developer's finished unit at ${l.project.name.en}: ${rooms[i][0]} — ${l.title.en}`,
      ar: `صورة توضيحية — وحدة منجزة من المطوّر في ${l.project.name.ar}: ${rooms[i][1]} — ${l.title.ar}`,
    },
  }));
  return l;
}

// A single off-plan villa (no project) with a Sakani price and no amenities; 5 photos -> 4 in the gallery.
function offPlanSakaniListing() {
  const l = singleListing();
  l.id = 'BONA-W904';
  l.category = 'off-plan';
  l.price = { amount: 900000, currency: 'SAR', from: false, period: null, onRequest: false, subsidisedAmount: 800000 };
  l.images.push(img(l.slug, '05', `Bedroom — ${l.title.en}`, `غرفة النوم — ${l.title.ar}`, null));
  return l;
}

function decimalListing() {
  const l = singleListing();
  l.price = { amount: 185000.5, currency: 'SAR', from: false, period: 'year', onRequest: false };
  l.category = 'rent';
  return l;
}

const SEED = 'an earlier brochure that must survive a failed run';

describe('brochure_pdf.py — the TK-system Bona brochure', { skip: !UV && 'uv not installed' }, () => {
  let base;
  let imagesDir;
  const runs = {};
  let pdfs = {};
  let unit = {};

  // Writes the fixture (listing, files-dir, optional seeded output) and returns its render job.
  function prepare(name, listing, { extra = [], seed = false, setup } = {}) {
    const dir = path.join(base, name);
    const files = path.join(dir, 'files');
    fs.mkdirSync(files, { recursive: true });
    for (const f of fs.readdirSync(imagesDir)) fs.copyFileSync(path.join(imagesDir, f), path.join(files, f));
    const listingPath = path.join(dir, 'listing.json');
    fs.writeFileSync(listingPath, typeof listing === 'string' ? listing : JSON.stringify(listing));
    const out = path.join(dir, 'brochure.pdf');
    if (seed) fs.writeFileSync(out, SEED);
    if (setup) setup({ dir, files });
    return { name, out, args: ['run', ...WITH, 'python', '-I', SCRIPT, listingPath, files, SITE_PATH, out, ...extra] };
  }

  function exec(args) {
    return new Promise((resolve) => {
      const child = spawn('uv', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
      child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
  }

  async function renderAll(jobs) {
    const queue = [...jobs];
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const res = await exec(job.args);
        const lines = res.stdout.trim().split('\n').filter(Boolean);
        let json = null;
        try { json = lines.length ? JSON.parse(lines[lines.length - 1]) : null; } catch { /* asserted per test */ }
        runs[job.name] = { status: res.status, lines, json, out: job.out, stderr: res.stderr };
      }
    };
    await Promise.all(Array.from({ length: RENDERS_AT_ONCE }, worker));
  }

  // BROCHURE_TEST_KEEP=<dir> keeps the fixtures and PDFs there to look at (it is not cleaned up).
  const KEEP = process.env.BROCHURE_TEST_KEEP;

  before(async () => {
    // Under ~/.cache, never straight in $HOME (and not /tmp, which is RAM on this host).
    const root = path.join(os.homedir(), '.cache', 'bona-tests');
    fs.mkdirSync(root, { recursive: true });
    base = KEEP ? (fs.mkdirSync(KEEP, { recursive: true }), KEEP) : fs.mkdtempSync(path.join(root, 'brochure-pdf-'));
    imagesDir = path.join(base, '_images');
    fs.mkdirSync(imagesDir, { recursive: true });
    const mk = spawnSync('uv', ['run', '--with', 'pillow', 'python', '-I', '-c', MAKE_IMAGES, imagesDir], { encoding: 'utf8' });
    assert.equal(mk.status, 0, mk.stderr);

    const jobs = [
      prepare('project', projectListing()),
      prepare('single', singleListing()),
      prepare('inject', injectListing()),
      prepare('longpara', longParaListing()),
      prepare('big', bigListing()),
      prepare('refit', refitListing()),
      prepare('nofit', noFitListing(), { seed: true }),
      prepare('projunit', projUnitListing()),
      prepare('offplan', offPlanSakaniListing()),
      prepare('toolarge', singleListing(), { extra: ['--max-mb', '0.02'], seed: true }),
      prepare('malformed', { id: 'BONA-W903', slug: 'Not A Slug!', title: { en: 'x' } }, { seed: true }),
      prepare('notjson', '{ nope'),
      prepare('missing', (() => { const l = singleListing(); l.images.push(img(l.slug, '09', 'Pool', 'المسبح', null)); return l; })()),
      prepare('decimal', decimalListing()),
      prepare('traverse', (() => { const l = projectListing(); l.images[1].src = '/listings/x/../../etc/passwd'; return l; })()),
      prepare('traverse2', (() => { const l = projectListing(); l.images[1].src = `/listings/${l.slug}/../../secret.jpg`; return l; })(),
        { setup: ({ dir }) => fs.copyFileSync(path.join(imagesDir, '02.jpg'), path.join(dir, 'secret.jpg')) }),
      prepare('symlink', (() => { const l = projectListing(); l.images[1].src = `/listings/${l.slug}/09.jpg`; return l; })(), {
        setup: ({ dir, files }) => {
          fs.copyFileSync(path.join(imagesDir, '02.jpg'), path.join(dir, 'outside.jpg'));
          fs.symlinkSync(path.join(dir, 'outside.jpg'), path.join(files, '09.jpg'));
        },
      }),
    ];
    const unitDir = path.join(base, '_unit');
    fs.mkdirSync(unitDir, { recursive: true });
    const [unitRes] = await Promise.all([
      exec(['run', ...WITH, 'python', '-I', '-c', UNIT, SCRIPT_DIR, unitDir]),
      renderAll(jobs),
    ]);
    try { unit = JSON.parse(unitRes.stdout.trim().split('\n').pop()); } catch { unit = { _error: unitRes.stderr.slice(-2000) }; }

    const ok = Object.values(runs).filter((r) => r.json?.ok).map((r) => r.out);
    if (ok.length) {
      const rd = spawnSync('uv', ['run', '--with', 'pymupdf', 'python', '-I', '-c', READ_PDFS, ...ok],
        { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      assert.equal(rd.status, 0, rd.stderr);
      pdfs = JSON.parse(rd.stdout);
    }
  });

  after(() => { if (base && !KEEP) fs.rmSync(base, { recursive: true, force: true }); });

  const okRun = (name) => {
    const r = runs[name];
    assert.equal(r.status, 0, `${name}: ${r.lines.join(' | ')}\n${r.stderr.slice(-2000)}`);
    assert.equal(r.json.ok, true);
    return r;
  };
  const pagesOf = (name) => pdfs[okRun(name).out].pages;
  const textOf = (name) => pagesOf(name).map((p) => p.text).join('\n');
  const flat = (s) => s.replace(/\s+/g, '').toLowerCase();   // tracked caps come out as "D E V E L O P E R"
  const pagesOfKind = (name, kind) => okRun(name).json.kinds.map((k, i) => (k === kind ? pagesOf(name)[i] : null)).filter(Boolean);
  const failed = (name, re) => {
    const r = runs[name];
    assert.equal(r.status, 1, r.lines.join(' | '));
    assert.equal(r.lines.length, 1, `stdout must be ONE line: ${r.lines.join(' | ')}`);
    assert.equal(r.json.ok, false);
    if (re) assert.match(r.json.error, re);
    return r;
  };
  const unitValue = (name) => {
    const u = unit[name];
    assert.ok(u, `unit check ${name} did not run: ${unit._error ?? ''}`);
    assert.ok(u.ok, `${name}: ${u.error}`);
    return u.value;
  };

  describe('a project with unit models (W023-like)', () => {
    it('prints one JSON line and succeeds', () => {
      const r = okRun('project');
      assert.equal(r.lines.length, 1, `stdout must be ONE line: ${r.lines.join(' | ')}`);
      assert.equal(r.json.id, 'BONA-W901');
      assert.equal(r.json.bytes, fs.statSync(r.out).size);
    });

    it('has the spec page sequence: flysheet, cover, narrative, residences, one model page, photos, amenities, location', () => {
      const { kinds, pages } = okRun('project').json;
      assert.equal(pages, kinds.length);
      assert.equal(pagesOf('project').length, pages);
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
      const links = pagesOf('project').flatMap((p) => p.links);
      const url = `${SITE.url.replace(/\/+$/, '')}/properties/test-heights-residences-jeddah/`;
      assert.ok(links.filter((l) => l === url).length >= 2, `listing URL links: ${links.join(' ')}`);
      assert.ok(links.includes(`https://wa.me/${SITE.whatsapp.wa}`));
      assert.ok(links.includes(`mailto:${SITE.email}`));
      assert.ok(!links.some((l) => /google\.com\/maps/.test(l)), 'no map pin -> no Maps link');
    });

    it('prints nothing the listing keeps for itself (developer contacts in _intake / stray keys)', () => {
      const text = textOf('project');
      const links = pagesOf('project').flatMap((p) => p.links).join(' ');
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

    it('embeds exactly one raster image per photo and floor plan (logo and QR are vector)', () => {
      const { rasters } = pdfs[okRun('project').out];
      assert.equal(rasters.length, 4 + 1, JSON.stringify(rasters));
      for (const [w, h] of rasters) assert.ok(w >= 40 && h >= 40, `tiny image ${w}x${h}`);
    });

    it('stays small', () => {
      assert.ok(okRun('project').json.bytes < 6 * 1024 * 1024, `${runs.project.json.bytes} bytes`);
    });
  });

  describe('a single property (no project, no models, no amenities)', () => {
    it('has no residences, model or amenities pages', () => {
      const { kinds } = okRun('single').json;
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
      assert.ok(!f.includes('illustrative'), 'not a project and not off-plan: no "Illustrative" captions');
    });

    it('links Google Maps for an exact pin', () => {
      const links = pagesOf('single').flatMap((p) => p.links);
      assert.ok(links.includes('https://www.google.com/maps?q=21.550100,39.170200'), links.join(' '));
    });
  });

  describe('layout under load', () => {
    it('a 24-sentence paragraph (~3,500 characters a language) runs onto continuation pages, nothing lost or repeated', () => {
      assert.ok(LONG_EN.length > 3300 && LONG_AR.length > 3300, `${LONG_EN.length} / ${LONG_AR.length}`);
      const narr = pagesOfKind('longpara', 'narrative');
      assert.ok(narr.length >= 2, runs.longpara.json.kinds.join(','));
      const en = flat(narr.map((p) => p.text).join('\n'));
      const marks = en.match(/mark\d\d/g) ?? [];
      assert.equal(marks.length, 24, marks.join(' '));
      assert.equal(new Set(marks).size, 24);
      const ar = narr.map((p) => p.text).join('\n');
      assert.equal((ar.match(/منسقة/g) ?? []).length, 24, 'every Arabic sentence printed once');
      assert.equal(narr.filter((p) => flat(p.text).includes('ataglance')).length, 1, 'the ledger is on the first page only');
    });

    it('a residences table over 10 rows takes two pages; the price note is on the last', () => {
      const res = pagesOfKind('big', 'residences');
      assert.equal(res.length, 2, runs.big.json.kinds.join(','));
      const all = flat(res.map((p) => p.text).join('\n'));
      for (const n of BIG_NAMES) assert.ok(all.includes(flat(n)), n);
      assert.ok(!flat(res[0].text).includes('pricesasprinted'));
      assert.ok(flat(res[1].text).includes('pricesasprinted'));
    });

    it('amenities long enough for several pages are all printed; the terms row is on the last page only', () => {
      const am = pagesOfKind('big', 'amenities');
      assert.ok(am.length >= 2, runs.big.json.kinds.join(','));
      const all = flat(am.map((p) => p.text).join('\n'));
      for (let i = 1; i <= 44; i += 1) assert.ok(all.includes(`amenitynumber${i}`), `amenity ${i}`);
      for (let i = 1; i <= 12; i += 1) assert.ok(all.includes(`nearbyplace${i}`), `nearby ${i}`);
      assert.equal(am.filter((p) => p.text.includes('Example Developer')).length, 1);
      assert.ok(am[am.length - 1].text.includes('Example Developer'));
    });

    it('balances 7 gallery photos as 3 + 2 + 2', () => {
      const { kinds, photoPages } = okRun('big').json;
      assert.equal(kinds.filter((k) => k === 'photos').length, 3);
      assert.deepEqual(photoPages, [3, 2, 2]);
    });

    it('re-cuts a page that does not fit on the first try (steps record the refit)', () => {
      const r = okRun('refit');
      assert.ok(r.json.steps.some((s) => s.startsWith('refit')), r.json.steps.join(','));
      assert.ok(flat(textOf('refit')).includes(flat('offered separately by the developer on request')));
    });

    it('a layout that still does not fit fails, and leaves an existing output untouched', () => {
      const r = failed('nofit', /does not fit/);
      assert.equal(r.json.reason, 'error');
      assert.equal(fs.readFileSync(r.out, 'utf8'), SEED);
    });
  });

  describe('captions', () => {
    it('a project unit (intake alt "Illustrative — developer\'s finished unit at X: Room — Title") prints the room label once', () => {
      const text = textOf('projunit');
      const f = flat(text);
      for (const c of ['garden·illustrative', 'gym·illustrative']) assert.ok(f.includes(c), c);
      assert.ok(!f.includes(flat("developer's finished unit")), 'the alt prefix is not a caption');
      assert.ok(!text.includes('وحدة منجزة'), 'the Arabic alt prefix is not a caption');
      assert.ok(!f.includes('illustrative—'), 'no doubled marker');
      assert.equal((f.match(/illustrative/g) ?? []).length, 3, 'one marker per gallery photo');
      assert.equal((text.match(/صورة توضيحية/g) ?? []).length, 3);
      assert.ok(text.includes('الحديقة') && text.includes('النادي الرياضي'));
    });

    it('a caption never wraps: a long room label on a half plate stays on one line', () => {
      const lines = pagesOfKind('projunit', 'photos').flatMap((p) => p.text.split('\n'));
      const sat = lines.filter((l) => flat(l).includes('satellite'));
      assert.equal(sat.length, 1, sat.join(' | '));
      assert.ok(flat(sat[0]).includes('illustrative'), `wrapped: ${sat[0]}`);
    });

    it('an off-plan listing without a project labels its photos illustrative too', () => {
      const f = flat(textOf('offplan'));
      assert.ok(f.includes('livingroom·illustrative'), 'off-plan -> illustrative');
    });
  });

  describe('a single off-plan property with a Sakani price and no amenities page', () => {
    it('prints the Sakani price', () => {
      const { kinds } = okRun('offplan').json;
      assert.ok(!kinds.includes('amenities'));
      const text = textOf('offplan');
      assert.ok(flat(text).includes('sar900,000'), 'the price (cover meta, tracked caps)');
      assert.ok(text.includes('SAR 800,000'), 'the Sakani price reached the page');
      assert.ok(flat(text).includes('sakani'));
    });

    it('balances 4 gallery photos as 2 + 2, never 3 + 1', () => {
      assert.deepEqual(okRun('offplan').json.photoPages, [2, 2]);
    });
  });

  describe('escaping and file access', () => {
    it('HTML in the title, description, model, availability, amenity, alt and developer prints literally', () => {
      const f = flat(textOf('inject'));
      for (const s of [INJ.title, INJ.desc, INJ.model, INJ.avail, INJ.amenity, INJ.alt, INJ.dev]) {
        assert.ok(f.includes(flat(s)), `not printed literally: ${s}`);
      }
      assert.ok(f.includes(flat('<script>x()</script>')));
    });

    it('planted HTML adds no links and loads no file', () => {
      const links = pagesOf('inject').flatMap((p) => p.links);
      assert.ok(!links.some((l) => /evil\.example|passwd/.test(l)), links.join(' '));
      const allowed = (l) => l.startsWith(`${SITE.url.replace(/\/+$/, '')}/properties/`) || l === `https://wa.me/${SITE.whatsapp.wa}`
        || l === `mailto:${SITE.email}`;
      assert.ok(links.every(allowed), links.join(' '));
      assert.equal(pdfs[runs.inject.out].rasters.length, 4 + 1, 'photos + plans, nothing else');
    });

    it('a path climbing out of the listing folder is refused', () => {
      failed('traverse', /unusable image path/);
      failed('traverse2', /unusable image path/);
    });

    it('a file in files-dir that links outside it is refused', () => {
      failed('symlink', /outside files-dir/);
    });

    it('the WeasyPrint fetcher loads only from its own folders', () => {
      const v = unitValue('fetcher');
      assert.equal(v.inside, 'inside');
      assert.equal(v.outside, 'refused');
      assert.equal(v.dotdot, 'refused');
      assert.equal(v.http, 'refused');
      assert.equal(v.refused, 3);
    });
  });

  describe('helpers', () => {
    it('refuses a WeasyPrint other than 70.x at startup, as an ok:false line', () => {
      const v = unitValue('version');
      assert.equal(v.code, 1);
      const line = JSON.parse(v.line);
      assert.equal(line.ok, false);
      assert.match(line.error, /unsupported WeasyPrint 66\.0/);
    });

    it('groups gallery photos evenly (3s and 2s, a lone photo only when there is one)', () => {
      assert.deepEqual(unitValue('groups'), {
        0: [], 1: [1], 2: [2], 3: [3], 4: [2, 2], 5: [3, 2], 6: [3, 3], 7: [3, 2, 2], 8: [3, 3, 2], 9: [3, 3, 3], 10: [3, 3, 2, 2],
      });
    });

    it('carries the same room labels as scripts/curate/rooms.mjs', () => {
      assert.deepEqual(unitValue('rooms'), Object.values(ROOMS).map((r) => [r.en, r.ar]));
    });

    it('derives captions from the room label, whatever wraps it', () => {
      assert.deepEqual(unitValue('captions'), [
        ['Garden', 'الحديقة'],
        ['Gym', 'النادي الرياضي'],
        ['Gym', 'النادي الرياضي'],
        ['Rooftop deck', 'سطح'],
      ]);
    });

    it('a reused --work never serves a stale downsampled image', () => {
      const v = unitValue('stale');
      assert.ok(v.first[0] > 150 && v.first[2] < 80, `first ${v.first}`);
      assert.ok(v.second[2] > 150 && v.second[0] < 80, `second run reused the old file: ${v.second}`);
    });
  });

  describe('failures', () => {
    it('a malformed listing -> ok:false JSON line, exit 1, an existing output untouched', () => {
      const r = failed('malformed', /slug/);
      assert.equal(r.json.reason, 'error');
      assert.equal(fs.readFileSync(r.out, 'utf8'), SEED);
    });

    it('a listing that is not JSON -> ok:false, exit 1', () => {
      failed('notjson', /JSON/);
    });

    it('a photo missing from files-dir -> ok:false naming the file', () => {
      failed('missing', /09\.jpg/);
    });

    it('a price that is not a whole number -> ok:false (the printed figure is never rounded)', () => {
      failed('decimal', /whole number/);
    });

    it('over --max-mb even after scaling -> too-large, and an existing output is left untouched', () => {
      const r = failed('toolarge');
      assert.equal(r.json.reason, 'too-large');
      assert.equal(fs.readFileSync(r.out, 'utf8'), SEED);
    });
  });
});
