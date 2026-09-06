// The Bona-branded brochure: the facts that go on the page, where the file lands, and the
// Python that draws it.
//
// The rebrand_pdf.py tests below build a REAL fixture PDF with PyMuPDF and run the real
// script over it. They are the only place the drawing is exercised, and they exist because
// the two failures that actually happen are invisible to a mock:
//   - a downsample pass that silently empties every page (re-saving an already-saved
//     Document; see shrink_to_fit's docstring), and
//   - another agency's name reaching a page Bona added.
// They are skipped, not failed, when `uv` is not on PATH.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  DEFAULT_BROCHURE_PY_CMD, SCRIPT, brochureFacts, brochureFileIn, brochurePyArgv,
  brochureRepoPath, brochureUrlFor, buildBrandedBrochure, findSourcePdf, priceText,
} from '../lib/brochure.mjs';
import { ALLOWED_PATHS } from '../lib/publish.mjs';
import { loadConfig } from '../lib/env.mjs';

const LISTING = {
  id: 'BONA-W007',
  slug: 'garden-villa-al-rawdah',
  title: { en: 'Garden Villa, Al Rawdah', ar: 'فيلا الحديقة، حي الروضة' },
  location: {
    district: { en: 'Al Rawdah', ar: 'الروضة' },
    city: { en: 'Jeddah', ar: 'جدة' },
  },
  price: { amount: 4500000, currency: 'SAR', from: false, period: null, onRequest: false },
  project: { name: { en: 'Rawdah Gardens', ar: 'حدائق الروضة' }, developer: { en: 'Anwar Development', ar: 'أنوار للتطوير' } },
  brochureUrl: null,
  _intake: { pdfSha256: null, site: 'https://bona.azoz.uk', warnings: [] },
};

describe('priceText — exactly what the listing says, never a computed number', () => {
  it('formats an asking price', () => {
    assert.equal(priceText({ amount: 4500000, currency: 'SAR' }), 'SAR 4,500,000');
  });

  it('keeps the "from" of a project starting price', () => {
    assert.equal(priceText({ amount: 888000, currency: 'SAR', from: true }), 'From SAR 888,000');
  });

  it('prints the period on a rental', () => {
    assert.equal(priceText({ amount: 250000, currency: 'SAR', period: 'year' }), 'SAR 250,000 / year');
  });

  // TAQEEM: a listing with no printed price says so on the cover rather than showing a
  // number nobody printed.
  it('says price on request rather than inventing one', () => {
    assert.equal(priceText({ onRequest: true, amount: null }), 'Price on request');
    assert.equal(priceText(null), 'Price on request');
    assert.equal(priceText({ amount: 0, currency: 'SAR' }), 'Price on request');
  });
});

describe('brochureFacts — only fields the listing already validated', () => {
  it('takes the title, place, price, project and URL off the listing', () => {
    const f = brochureFacts(LISTING, { site: 'https://bona.azoz.uk' });
    assert.equal(f.id, 'BONA-W007');
    assert.equal(f.titleEn, 'Garden Villa, Al Rawdah');
    assert.equal(f.titleAr, 'فيلا الحديقة، حي الروضة');
    assert.equal(f.place, 'Al Rawdah, Jeddah');
    assert.equal(f.priceEn, 'SAR 4,500,000');
    assert.equal(f.project, 'Rawdah Gardens');
    assert.equal(f.developer, 'Anwar Development');
    assert.equal(f.url, 'https://bona.azoz.uk/properties/garden-villa-al-rawdah/');
  });

  it('never carries the description, the highlights or anything the model wrote free-form', () => {
    const f = brochureFacts({ ...LISTING, description: { en: 'x', ar: 'ص' }, highlights: { en: ['a'], ar: ['ب'] } }, {});
    assert.deepEqual(
      Object.keys(f).sort(),
      ['developer', 'id', 'place', 'priceEn', 'project', 'slug', 'titleAr', 'titleEn', 'url'],
    );
  });

  it('survives a listing with no project and no district', () => {
    const f = brochureFacts({ ...LISTING, project: null, location: { city: { en: 'Jeddah' } } }, {});
    assert.equal(f.project, null);
    assert.equal(f.developer, null);
    assert.equal(f.place, 'Jeddah');
  });

  it('trims the trailing slash off the site so the URL is never doubled', () => {
    assert.equal(brochureFacts(LISTING, { site: 'https://bona.azoz.uk/' }).url,
      'https://bona.azoz.uk/properties/garden-villa-al-rawdah/');
  });
});

describe('where the brochure lands', () => {
  it('is one file per listing, named for the site button that links to it', () => {
    assert.equal(brochureRepoPath('garden-villa-al-rawdah'), 'public/listings/garden-villa-al-rawdah/brochure.pdf');
    assert.equal(brochureFileIn('/tmp/stage/x'), path.join('/tmp/stage/x', 'brochure.pdf'));
    assert.equal(brochureUrlFor('https://bona.azoz.uk', 'garden-villa-al-rawdah'),
      'https://bona.azoz.uk/listings/garden-villa-al-rawdah/brochure.pdf');
  });

  // The brief asked for the brochure to be added to the staging allowlist; it did not need
  // adding — ALLOWED_PATHS matches on a `<allowed>/` prefix and already covers the whole
  // listing directory. This test is what stops that being quietly broken later.
  it('sits inside a path publish.mjs already allows, so nothing had to be widened', () => {
    const file = brochureRepoPath('garden-villa-al-rawdah');
    assert.ok(ALLOWED_PATHS.some((a) => file.startsWith(`${a}/`)), file);
    assert.ok(!ALLOWED_PATHS.some((a) => 'public/brochures/x.pdf'.startsWith(`${a}/`)),
      'a brochure written anywhere else must still be refused');
  });
});

describe('brochurePyArgv — an argv array, never a shell string', () => {
  it('defaults to the four packages the script needs', () => {
    assert.deepEqual(brochurePyArgv(undefined), DEFAULT_BROCHURE_PY_CMD);
    for (const pkg of ['pymupdf', 'segno', 'fonttools', 'brotli']) {
      assert.ok(DEFAULT_BROCHURE_PY_CMD.includes(pkg), pkg);
    }
  });

  it('accepts an array, and splits a legacy string on whitespace', () => {
    assert.deepEqual(brochurePyArgv(['python3']), ['python3']);
    assert.deepEqual(brochurePyArgv('  uv run  python '), ['uv', 'run', 'python']);
  });

  it('is what loadConfig hands the pipeline', () => {
    const cfg = loadConfig({ });
    assert.ok(Array.isArray(cfg.brochurePyCmd));
    assert.ok(cfg.brochurePyCmd.includes('segno'));
    assert.equal(cfg.maxBrochureMb, 25, 'the default cap is the branded output, not the original');
  });
});

describe('findSourcePdf — the original is found by content hash, not by a stored path', () => {
  let dir;
  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-src-'));
    fs.mkdirSync(path.join(dir, '2026-09-06'), { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-09-06', 'other.pdf'), 'not it');
    fs.writeFileSync(path.join(dir, '2026-09-06', 'MSGID.pdf'), 'the brochure bytes');
    // a work dir beside it, so the walk has a directory to skip past
    fs.mkdirSync(path.join(dir, '2026-09-06', 'MSGID', 'images'), { recursive: true });
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('finds the PDF a listing was published from', () => {
    assert.equal(findSourcePdf(dir, sha('the brochure bytes')), path.join(dir, '2026-09-06', 'MSGID.pdf'));
  });

  it('answers null rather than guessing when the download has been cleaned up', () => {
    assert.equal(findSourcePdf(dir, sha('a brochure nobody kept')), null);
    assert.equal(findSourcePdf(dir, null), null);
    assert.equal(findSourcePdf(path.join(dir, 'nope'), sha('x')), null);
  });
});

// ---------------------------------------------------------------------------------------
// The Python. Real PyMuPDF, a real fixture, the real script.
// ---------------------------------------------------------------------------------------
const uvAvailable = spawnSync('uv', ['--version'], { stdio: 'ignore' }).status === 0;

describe('rebrand_pdf.py', { skip: uvAvailable ? false : 'uv is not on PATH' }, () => {
  let dir;
  let fixture;
  const cfg = { ...loadConfig({}), site: 'https://bona.azoz.uk' };

  /** A three-page brochure with a photo on each page, built the way a designer's export is. */
  const makeFixture = (file, pages = 3, side = 900) => {
    const py = `
import pymupdf, random
doc = pymupdf.open()
random.seed(7)
for i in range(${pages}):
    page = doc.new_page(width=595, height=842)
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, ${side}, ${side}), False)
    for _ in range(4000):
        x, y = random.randrange(${side}), random.randrange(${side})
        pix.set_pixel(x, y, (random.randrange(256), random.randrange(256), random.randrange(256)))
    page.insert_image(pymupdf.Rect(40, 40, 555, 560), stream=pix.tobytes("jpg"))
    page.insert_text(pymupdf.Point(50, 640), "Marina Tower - developer page %d" % (i + 1), fontsize=13)
doc.save(${JSON.stringify(file)}, garbage=3, deflate=True)
print("ok")
`;
    execFileSync('uv', ['run', '--with', 'pymupdf', 'python', '-c', py], { encoding: 'utf8' });
  };

  /** A brochure whose first page is the odd size out, as several of the owner's are. */
  const makeMixedFixture = (file) => {
    const py = `
import pymupdf
doc = pymupdf.open()
doc.new_page(width=400, height=300).insert_text(pymupdf.Point(30, 40), "half spread", fontsize=11)
for i in range(3):
    doc.new_page(width=1920, height=1080).insert_text(pymupdf.Point(60, 90), "deck page %d" % (i + 1), fontsize=24)
doc.save(${JSON.stringify(file)}, garbage=3, deflate=True)
print("ok")
`;
    execFileSync('uv', ['run', '--with', 'pymupdf', 'python', '-c', py], { encoding: 'utf8' });
  };

  /**
   * Page text, image count and — for the overlap check — the bounding box of every text
   * block on the page, in reading order.
   */
  const pageOf = (pdf, pageIndex) => {
    const py = `
import pymupdf, json
doc = pymupdf.open(${JSON.stringify(pdf)})
page = doc[${pageIndex} if ${pageIndex} >= 0 else doc.page_count + ${pageIndex}]
blocks = [
    {"x0": b[0], "y0": b[1], "x1": b[2], "y1": b[3], "text": " ".join(b[4].split())}
    for b in page.get_text("blocks") if b[4].strip()
]
print(json.dumps({
    "pages": doc.page_count,
    "text": page.get_text(),
    "images": len(page.get_images(full=True)),
    "width": page.rect.width,
    "height": page.rect.height,
    "sizes": sorted({(round(p.rect.width), round(p.rect.height)) for p in doc}),
    "blocks": blocks,
}))
`;
    const out = execFileSync('uv', ['run', '--with', 'pymupdf', 'python', '-c', py], { encoding: 'utf8' });
    return JSON.parse(out.trim().split('\n').pop());
  };
  const textOf = pageOf;

  /**
   * Every pair of text blocks drawn on top of one another.
   *
   * Measured as a FRACTION of the shorter block, not in absolute points: two wrapped lines
   * of the same Arabic paragraph share a couple of points where the ascenders of one line
   * reach into the box of the next, and calling that a collision would only teach the test
   * to be ignored. A line actually drawn over another overlaps it almost entirely — the bug
   * this guards against had the Arabic strapline sitting on top of the English title.
   */
  const overlaps = (blocks, fraction = 0.45) => {
    const bad = [];
    for (let i = 0; i < blocks.length; i += 1) {
      for (let j = i + 1; j < blocks.length; j += 1) {
        const a = blocks[i];
        const b = blocks[j];
        const vertical = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        const horizontal = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const shortest = Math.min(a.y1 - a.y0, b.y1 - b.y0);
        const narrowest = Math.min(a.x1 - a.x0, b.x1 - b.x0);
        if (vertical > shortest * fraction && horizontal > narrowest * 0.25) {
          bad.push(`"${a.text}" x "${b.text}" (${vertical.toFixed(1)}pt of ${shortest.toFixed(1)}pt)`);
        }
      }
    }
    return bad;
  };

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-brochure-'));
    fixture = path.join(dir, 'developer.pdf');
    makeFixture(fixture);
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('the script is where lib/brochure.mjs says it is', () => {
    assert.ok(fs.existsSync(SCRIPT), SCRIPT);
  });

  it('adds exactly two pages — a Bona cover in front and an Enquire page at the back', async () => {
    const out = path.join(dir, 'out-basic.pdf');
    const res = await buildBrandedBrochure({ pdfPath: fixture, listing: LISTING, outPath: out, workDir: dir, cfg });
    assert.ok(res.ok, res.error);
    assert.equal(res.srcPages, 3);
    assert.equal(res.pages, 5);
    assert.ok(fs.existsSync(out));

    const cover = textOf(out, 0);
    assert.match(cover.text, /BONA/);
    assert.match(cover.text, /Garden Villa, Al Rawdah/);
    assert.match(cover.text, /SAR 4,500,000/);
    assert.match(cover.text, /FAL 1100313556/);
    assert.match(cover.text, /[؀-ۿ]/, 'the Arabic title must be on the cover');
  });

  it('leaves the developer\'s own page alone apart from the footer strip', async () => {
    const out = path.join(dir, 'out-footer.pdf');
    const res = await buildBrandedBrochure({ pdfPath: fixture, listing: LISTING, outPath: out, workDir: dir, cfg });
    assert.ok(res.ok, res.error);
    const inner = textOf(out, 1);            // page 1 = the developer's first page
    assert.match(inner.text, /Marina Tower - developer page 1/, 'their copy is untouched');
    assert.equal(inner.images, 1, 'their photo is untouched');
    assert.match(inner.text, /bona\.azoz\.uk/);
    assert.match(inner.text, /\+966 59 329 6933/);
    assert.match(inner.text, /FAL 1100313556/);
    assert.match(inner.text, /BONA-W007/, 'the footer carries the listing id');
  });

  it('closes with the listing URL, the WhatsApp link, the hours and the licence', async () => {
    const out = path.join(dir, 'out-enquire.pdf');
    const res = await buildBrandedBrochure({ pdfPath: fixture, listing: LISTING, outPath: out, workDir: dir, cfg });
    assert.ok(res.ok, res.error);
    const last = textOf(out, -1);
    assert.match(last.text, /bona\.azoz\.uk\/properties\/garden-villa-al-rawdah/);
    assert.match(last.text, /wa\.me\/966593296933/);
    assert.match(last.text, /10:00/);
    assert.match(last.text, /Bona Real Estate/);
    assert.match(last.text, /FAL 1100313556/);
    assert.equal(last.images, 1, 'the QR code is drawn on the Enquire page');
  });

  // The one rule that has teeth: the developer's brand stays on the developer's pages, and
  // no OTHER agency reaches a page Bona added.
  it('drops a fact that carries another agency or a contact detail rather than printing it', async () => {
    const out = path.join(dir, 'out-scrub.pdf');
    const listing = {
      ...LISTING,
      project: {
        name: { en: 'Marketed by TK Estates', ar: 'تي كيه' },
        developer: { en: 'Call +971 50 111 2233', ar: 'اتصل' },
      },
    };
    const res = await buildBrandedBrochure({ pdfPath: fixture, listing, outPath: out, workDir: dir, cfg });
    assert.ok(res.ok, res.error);
    assert.deepEqual(res.scrubbed.sort(), ['developer', 'project']);
    const cover = textOf(out, 0);
    assert.doesNotMatch(cover.text, /TK/);
    assert.doesNotMatch(cover.text, /971/);
    assert.match(cover.text, /Garden Villa, Al Rawdah/, 'the listing itself still publishes');
  });

  it('writes nothing at all when the output cannot be squeezed under the cap', async () => {
    const out = path.join(dir, 'out-toobig.pdf');
    const res = await buildBrandedBrochure({
      pdfPath: fixture, listing: LISTING, outPath: out, workDir: dir,
      cfg: { ...cfg, maxBrochureMb: 0.25 },
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'too-large');
    assert.match(res.error, /over the/);
    assert.ok(!fs.existsSync(out), 'a rejected brochure must never be left on disk to be committed');
    assert.ok(!fs.existsSync(`${out}.shrink`), 'no scratch file is left behind either');
  });

  // The failure that produced a 0.17 MB file of blank pages from a 70 MB brochure: shrinking
  // must never cost the pages their images.
  it('keeps the images when it has to downsample', async () => {
    const big = path.join(dir, 'big.pdf');
    makeFixture(big, 4, 1500);
    const out = path.join(dir, 'out-shrunk.pdf');
    const res = await buildBrandedBrochure({
      pdfPath: big, listing: LISTING, outPath: out, workDir: dir,
      cfg: { ...cfg, maxBrochureMb: 0.9 },
    });
    if (!res.ok) {
      assert.equal(res.reason, 'too-large', res.error);
      return;                                  // fine: it refused rather than shipping junk
    }
    assert.ok(res.bytes <= 0.9 * 1024 * 1024, `${res.bytes} bytes`);
    assert.ok(res.steps.length > 1, `expected a downsample pass, got ${res.steps.join(' → ')}`);
    const inner = textOf(out, 1);
    assert.equal(inner.images, 1, 'a downsample pass that empties the pages is worse than a big file');
    assert.match(inner.text, /developer page 1/);
  });

  // The brochures the owner is really sent are 16:9 decks, and one of them opens on a
  // half-spread. Laying the cover out by fractions of the page height put the wordmark off
  // the page on a 1080pt-high deck and stacked the Enquire page's lines on top of one
  // another; both are measured now, and these two tests are what keep them measured.
  describe('any page shape', () => {
    let mixed;
    let landscapeOut;

    before(() => {
      mixed = path.join(dir, 'deck.pdf');
      makeMixedFixture(mixed);
      landscapeOut = path.join(dir, 'out-deck.pdf');
    });

    it('gives the pages it adds the brochure\'s DOMINANT size, not page 1\'s', async () => {
      const res = await buildBrandedBrochure({ pdfPath: mixed, listing: LISTING, outPath: landscapeOut, workDir: dir, cfg });
      assert.ok(res.ok, res.error);
      const cover = pageOf(landscapeOut, 0);
      assert.equal(cover.width, 1920);
      assert.equal(cover.height, 1080);
      const enquire = pageOf(landscapeOut, -1);
      assert.equal(enquire.width, 1920);
      // the developer's own half-spread is left at its own size, untouched
      assert.deepEqual(cover.sizes, [[400, 300], [1920, 1080]]);
    });

    // The detector has to fire on the real bug, or the test below proves nothing.
    it('the overlap detector catches a line drawn on top of another', () => {
      const stacked = [
        { x0: 100, y0: 200, x1: 500, y1: 230, text: 'Al-Wareef Townhouse, Jeddah' },
        { x0: 120, y0: 202, x1: 480, y1: 232, text: 'للاستفسار والمعاينة' },
      ];
      assert.equal(overlaps(stacked).length, 1);
      const stackedLines = [
        { x0: 100, y0: 200, x1: 500, y1: 230, text: 'line one' },
        { x0: 100, y0: 228, x1: 500, y1: 258, text: 'line two, tight leading' },
      ];
      assert.deepEqual(overlaps(stackedLines), [], 'tight leading is not a collision');
    });

    it('never overlaps two lines, on the cover or the Enquire page, at any title length', async () => {
      const longTitle = {
        ...LISTING,
        title: {
          en: 'Nuzul Khayala Residences at Wajhat Al-Wareef, North Jeddah Waterfront District',
          ar: 'نزل خيالة ريزيدنسز في واجهة الوريف، حي الواجهة البحرية شمال جدة الجديدة',
        },
        project: {
          name: { en: 'Wajhat Al-Wareef Masterplan', ar: 'واجهة الوريف' },
          developer: { en: 'National Housing Company and Faisal Bin Saedan Real Estate Development', ar: 'الوطنية للإسكان' },
        },
      };
      for (const [label, listing, src] of [
        ['short title, portrait', LISTING, fixture],
        ['long title, portrait', longTitle, fixture],
        ['short title, 16:9 deck', LISTING, mixed],
        ['long title, 16:9 deck', longTitle, mixed],
      ]) {
        const out = path.join(dir, `out-overlap-${label.replace(/\W+/g, '-')}.pdf`);
        const res = await buildBrandedBrochure({ pdfPath: src, listing, outPath: out, workDir: dir, cfg });
        assert.ok(res.ok, `${label}: ${res.error}`);
        for (const [page, name] of [[0, 'cover'], [-1, 'enquire']]) {
          const bad = overlaps(pageOf(out, page).blocks);
          assert.deepEqual(bad, [], `${label} — ${name} overlaps: ${bad.join(', ')}`);
        }
      }
    });

    it('puts the wordmark on the cover whatever the page shape', async () => {
      for (const src of [fixture, mixed]) {
        const out = path.join(dir, `out-wordmark-${path.basename(src)}`);
        const res = await buildBrandedBrochure({ pdfPath: src, listing: LISTING, outPath: out, workDir: dir, cfg });
        assert.ok(res.ok, res.error);
        const cover = pageOf(out, 0);
        assert.match(cover.text, /B\s*O\s*N\s*A/, `no wordmark on the ${cover.width}x${cover.height} cover`);
        // …and inside the page, not off the top of it
        const mark = cover.blocks.find((b) => /^B\s*O?\s*N?\s*A?/.test(b.text));
        assert.ok(mark && mark.y0 > 0 && mark.y1 < cover.height, JSON.stringify(mark));
      }
    });
  });

  it('answers with a reason instead of throwing on a file that is not a PDF', async () => {
    const junk = path.join(dir, 'not.pdf');
    fs.writeFileSync(junk, 'this is not a pdf');
    const res = await buildBrandedBrochure({ pdfPath: junk, listing: LISTING, outPath: path.join(dir, 'x.pdf'), workDir: dir, cfg });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'input');
  });

  it('answers with a reason instead of throwing on a file that is not there', async () => {
    const res = await buildBrandedBrochure({
      pdfPath: path.join(dir, 'missing.pdf'), listing: LISTING, outPath: path.join(dir, 'y.pdf'), workDir: dir, cfg,
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'input');
  });
});
