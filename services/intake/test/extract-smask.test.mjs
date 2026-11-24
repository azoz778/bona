// services/intake/test/extract-smask.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'extract_pdf.py');
const UV = spawnSync('uv', ['--version']).status === 0;
const WITH = ['--with', 'pymupdf', '--with', 'pillow'];

// Fixture: 6 usable images (fewer than RENDER_THRESHOLD=3 would make the extractor rasterise
// pages instead). All 900x700 with the coloured block at x 200..700, y 200..500:
//   0 RGBA PNG (real alpha channel), block (80,160,60)
//   1 RGB PNG + 50 % mask (stream= + mask=), block (200,100,50)  -> expect (227,177,152)
//   2 grayscale JPEG + opaque mask, block 120                    -> must not fall back to black
//   3 CMYK JPEG + opaque mask, block reddish                     -> colour preserved
//   4 RGB JPEG, no mask at all, block (90,30,120)                -> left alone: no `flattened` key
//   5 RGB PNG + a HALF-SIZE mask (450x350, opaque over the block) -> resized: white corner, block (30,60,200)
const MAKE = `
import sys, io, pymupdf
from PIL import Image
w, h = 900, 700
doc = pymupdf.open()
def noisy(mode, block):                                    # busy everywhere, then the flat block on top (not "flat art")
    im = Image.new(mode, (w, h))
    px = im.load()
    for x in range(w):
        for y in range(h):
            v = (x * 7 % 256, y * 9 % 256, (x + y) * 5 % 256)
            px[x, y] = {'RGBA': v + (255,), 'RGB': v, 'L': v[0], 'CMYK': v + (10,)}[mode]
    im.paste(Image.new(mode, (500, 300), block), (200, 200))
    return im
def mask_img(alpha):
    m = Image.new('L', (w, h), 0)
    m.paste(Image.new('L', (500, 300), alpha), (200, 200))
    return m
def mask_png(alpha):
    b = io.BytesIO(); mask_img(alpha).save(b, 'PNG'); return b.getvalue()
def enc(im, fmt):
    b = io.BytesIO(); im.save(b, fmt); return b.getvalue()
def put(stream, mask=None):
    page = doc.new_page(width=842, height=595)
    if mask is None:
        page.insert_image(page.rect, stream=stream)
    else:
        page.insert_image(page.rect, stream=stream, mask=mask)
    page.insert_text((40, 40), 'Floor plan 105.02 m2 apartment bedroom')
im = noisy('RGBA', (80, 160, 60, 255))
a = mask_img(255)
a.paste(255, (0, 600, w, h))                                 # opaque busy strip at the bottom, or the colour census sees a flat image
im.putalpha(a)
put(enc(im, 'PNG'))
im = noisy('RGB', (200, 100, 50))
put(enc(im, 'PNG'), mask_png(128))
im = noisy('L', 120)
put(enc(im, 'JPEG'), mask_png(255))
im = noisy('CMYK', (0, 200, 200, 0))
put(enc(im, 'JPEG'), mask_png(255))
put(enc(noisy('RGB', (90, 30, 120)), 'JPEG'))
half = Image.new('L', (w // 2, h // 2), 0)
half.paste(Image.new('L', (250, 150), 255), (100, 100))      # the block, at half scale
b = io.BytesIO(); half.save(b, 'PNG')
put(enc(noisy('RGB', (30, 60, 200)), 'PNG'), b.getvalue())
doc.save(sys.argv[1])
`;

// A soft mask whose dictionary says it is bigger than MAX_PIXELS (50 MP) is never decoded: its size is
// read from its dictionary first, and the image keeps its raw stream (no `flattened` key). The honest
// 8000x8000 mask here (64 MP, a few KB compressed) WOULD be decoded and flattened without the guard.
// Three usable images, so the extractor does not fall back to page renders.
const MAKE_BOMB = `
import sys, io, json, pymupdf
from PIL import Image
w, h = 900, 700
def noisy(block):
    im = Image.new('RGB', (w, h))
    px = im.load()
    for x in range(w):
        for y in range(h):
            px[x, y] = (x * 7 % 256, y * 9 % 256, (x + y) * 5 % 256)
    im.paste(Image.new('RGB', (500, 300), block), (200, 200))
    return im
def png(im):
    b = io.BytesIO(); im.save(b, 'PNG'); return b.getvalue()
doc = pymupdf.open()
big = png(Image.new('L', (8000, 8000), 255))
for i in range(3):
    page = doc.new_page(width=842, height=595)
    stream = png(noisy((200, 100 + i * 40, 50)))
    if i == 0:
        page.insert_image(page.rect, stream=stream, mask=big)
    else:
        page.insert_image(page.rect, stream=stream)
    page.insert_text((40, 40), 'Floor plan 105.02 m2 apartment bedroom')
doc.save(sys.argv[1])
doc = pymupdf.open(sys.argv[1])
smask = doc[0].get_images(full=True)[0][1]
print(json.dumps([doc.xref_get_key(smask, 'Width')[1], doc.xref_get_key(smask, 'Height')[1]]))
`;

// mask_fits() reads the size from the dictionary and never decodes: a dictionary that lies about it is
// judged by what it says, and one without a size is not decoded at all.
const MASK_FITS = `
import sys, io, json, pymupdf
sys.path.insert(0, sys.argv[1])
import extract_pdf as x
from PIL import Image
def png(im):
    b = io.BytesIO(); im.save(b, 'PNG'); return b.getvalue()
doc = pymupdf.open()
page = doc.new_page(width=200, height=200)
page.insert_image(page.rect, stream=png(Image.new('RGB', (90, 70), (10, 20, 30))), mask=png(Image.new('L', (90, 70), 128)))
smask = doc[0].get_images(full=True)[0][1]
out = {'honest': x.mask_fits(doc, smask)}
doc.xref_set_key(smask, 'Width', '100000'); doc.xref_set_key(smask, 'Height', '100000')
out['lying'] = x.mask_fits(doc, smask)
doc.xref_set_key(smask, 'Width', '7071'); doc.xref_set_key(smask, 'Height', '7071')
out['at_cap'] = x.mask_fits(doc, smask)            # 49,999,041 px
doc.xref_set_key(smask, 'Width', '7072'); doc.xref_set_key(smask, 'Height', '7071')
out['over_cap'] = x.mask_fits(doc, smask)          # 50,006,112 px
doc.xref_set_key(smask, 'Width', 'null')
out['no_width'] = x.mask_fits(doc, smask)
doc.xref_set_key(smask, 'Width', '/Big')
out['not_a_number'] = x.mask_fits(doc, smask)
doc.xref_set_key(smask, 'Width', '90'); doc.xref_set_key(smask, 'Height', '70')
out['flate'] = x.mask_fits(doc, smask)
doc.xref_set_key(smask, 'Filter', '/JPXDecode')
out['jpx'] = x.mask_fits(doc, smask)              # a JPX stream decodes to ITS OWN size, whatever Width/Height say
doc.xref_set_key(smask, 'Filter', '[/FlateDecode /JPXDecode]')
out['jpx_in_array'] = x.mask_fits(doc, smask)
out['cap'] = x.MAX_PIXELS
print(json.dumps(out))
`;

// A JPXDecode soft mask decodes to the size in its own codestream — the dictionary's Width/Height are
// ignored — so mask_fits() cannot bound it: a 3000x3000 JPEG 2000 mask that declares 90x70 is never
// decoded, and its image keeps its raw stream. (Three usable images, so no page-render fallback.)
const MAKE_JPX = `
import sys, io, pymupdf
from PIL import Image
w, h = 900, 700
def noisy(block):
    im = Image.new('RGB', (w, h))
    px = im.load()
    for x in range(w):
        for y in range(h):
            px[x, y] = (x * 7 % 256, y * 9 % 256, (x + y) * 5 % 256)
    im.paste(Image.new('RGB', (500, 300), block), (200, 200))
    return im
def png(im):
    b = io.BytesIO(); im.save(b, 'PNG'); return b.getvalue()
doc = pymupdf.open()
for i in range(3):
    page = doc.new_page(width=842, height=595)
    stream = png(noisy((200, 100 + i * 40, 50)))
    if i == 0:
        page.insert_image(page.rect, stream=stream, mask=png(Image.new('L', (w, h), 128)))
    else:
        page.insert_image(page.rect, stream=stream)
    page.insert_text((40, 40), 'Floor plan 105.02 m2 apartment bedroom')
smask = doc[0].get_images(full=True)[0][1]
big = io.BytesIO(); Image.new('L', (3000, 3000), 128).save(big, 'JPEG2000'); big = big.getvalue()
doc.update_stream(smask, big, compress=False)
doc.xref_set_key(smask, 'Filter', '/JPXDecode')
doc.xref_set_key(smask, 'DecodeParms', 'null')
doc.xref_set_key(smask, 'Width', '%d' % w); doc.xref_set_key(smask, 'Height', '%d' % h)
doc.save(sys.argv[1])
doc = pymupdf.open(sys.argv[1])
m = pymupdf.Pixmap(doc, smask)
print('decoded', m.width, m.height, doc.xref_get_key(smask, 'Filter')[1], doc.xref_get_key(smask, 'Width')[1])
`;

// r3 #6: one bitmap drawn twice — first as a small preview (page 1), then over its whole page (page 4). Two other
// pictures fill pages 2 and 3 (three usable images: no page-render fallback).
const MAKE_TWICE = `
import sys, io, pymupdf
from PIL import Image
w, h = 900, 700
def noisy(block):
    im = Image.new('RGB', (w, h))
    px = im.load()
    for x in range(w):
        for y in range(h):
            px[x, y] = (x * 7 % 256, y * 9 % 256, (x + y) * 5 % 256)
    im.paste(Image.new('RGB', (300, 200), block), (100, 100))
    return im
def png(im):
    b = io.BytesIO(); im.save(b, 'PNG'); return b.getvalue()
doc = pymupdf.open()
a = png(noisy((200, 40, 40)))
for i, (stream, small) in enumerate([(a, True), (png(noisy((40, 200, 40))), False), (png(noisy((40, 40, 200))), False), (a, False)]):
    page = doc.new_page(width=842, height=595)
    page.insert_image(pymupdf.Rect(40, 40, 200, 160) if small else page.rect, stream=stream)
    page.insert_text((40, 580), 'Floor plan apartment bedroom')
doc.save(sys.argv[1])
`;

// r5 #8: the same as MAKE_TWICE, past the candidate cap. Page 1 draws bitmap A as a small preview, pages 2-4 fill
// their page with three other pictures, page 5 fills its page with A again. Run with --max-candidates 3: pages 1-3 are
// the three kept candidates, page 4's picture is one too many, and page 5 is A again, not a new candidate.
const MAKE_CAPPED = `
import sys, io, pymupdf
from PIL import Image
w, h = 900, 700
def noisy(block):
    im = Image.new('RGB', (w, h))
    px = im.load()
    for x in range(w):
        for y in range(h):
            px[x, y] = (x * 7 % 256, y * 9 % 256, (x + y) * 5 % 256)
    im.paste(Image.new('RGB', (300, 200), block), (100, 100))
    return im
def png(im):
    b = io.BytesIO(); im.save(b, 'PNG'); return b.getvalue()
doc = pymupdf.open()
a = png(noisy((200, 40, 40)))
others = [png(noisy(c)) for c in ((40, 200, 40), (40, 40, 200), (200, 200, 40))]
for stream, small in [(a, True), (others[0], False), (others[1], False), (others[2], False), (a, False)]:
    page = doc.new_page(width=842, height=595)
    page.insert_image(pymupdf.Rect(40, 40, 200, 160) if small else page.rect, stream=stream)
    page.insert_text((40, 580), 'Floor plan apartment bedroom')
doc.save(sys.argv[1])
`;

describe('extract_pdf.py - transparent images', { skip: !UV && 'uv not installed' }, () => {
  it('flattens soft-masked images onto white with straight alpha (rgba, 50 %, gray, cmyk, half-size mask), and leaves a plain one alone', () => {
    // Under ~/.cache, never straight in $HOME (and not /tmp, which is RAM on this host).
    const base = path.join(os.homedir(), '.cache', 'bona-tests');
    fs.mkdirSync(base, { recursive: true });
    const dir = fs.mkdtempSync(path.join(base, 'smask-'));
    try {
      const pdf = path.join(dir, 'plan.pdf');
      const mk = spawnSync('uv', ['run', ...WITH, 'python', '-I', '-c', MAKE, pdf], { encoding: 'utf8' });
      assert.equal(mk.status, 0, mk.stderr);
      const out = path.join(dir, 'out');
      const run = spawnSync('uv', ['run', ...WITH, 'python', '-I', SCRIPT, pdf, out, '--min-side', '300'], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const res = JSON.parse(run.stdout.trim().split('\n').pop());
      assert.equal(res.candidates.length, 6);
      assert.ok(res.candidates.every((c) => c.source === 'embedded'), JSON.stringify(res.candidates.map((c) => c.source)));
      assert.deepEqual(res.candidates.map((c) => c.page), [1, 2, 3, 4, 5, 6]);
      for (const i of [0, 1, 2, 3, 5]) assert.equal(res.candidates[i].flattened, true, `candidate ${i} has a soft mask and must be flattened`);
      assert.equal('flattened' in res.candidates[4], false, 'an image without a mask is written as it is, with no flattened key');
      // ONE probe process reads every file: corner pixel + interior pixel.
      const files = res.candidates.map((c) => c.abs);
      const probe = spawnSync('uv', ['run', '--with', 'pillow', 'python', '-I', '-c',
        'import sys, json; from PIL import Image\n' +
        'print(json.dumps([[Image.open(f).convert("RGB").getpixel(p) for p in ((5, 5), (450, 350))] for f in sys.argv[1:]]))',
        ...files], { encoding: 'utf8' });
      assert.equal(probe.status, 0, probe.stderr);
      const px = JSON.parse(probe.stdout.trim());
      const near = (a, b, tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
      // Candidate order follows page order: rgba, 50 % rgb, gray, cmyk, plain, half-size mask.
      const EXPECT = [[80, 160, 60], [227, 177, 152]];
      for (const i of [0, 1, 2, 3, 5]) assert.deepEqual(px[i][0], [255, 255, 255], `candidate ${i} corner not white`);
      assert.ok(!near(px[4][0], [255, 255, 255], 40), `the plain image keeps its own corner ${px[4][0]}`);
      assert.ok(near(px[4][1], [90, 30, 120], 12), `plain interior ${px[4][1]} (JPEG)`);
      assert.ok(near(px[5][1], [30, 60, 200]), `half-size mask: interior ${px[5][1]} keeps the block colour`);
      assert.ok(near(px[0][1], EXPECT[0]), `rgba interior ${px[0][1]}`);
      assert.ok(near(px[1][1], EXPECT[1]), `50% alpha interior ${px[1][1]} (premultiplied bug gives 177,152,140)`);
      // gray 120 fully opaque -> equal channels near 120 ; cmyk -> reddish (R high, G/B low)
      assert.ok(px[2][1][0] === px[2][1][1] && Math.abs(px[2][1][0] - 120) <= 3, `gray interior ${px[2][1]}`);
      assert.ok(px[3][1][0] > 200 && px[3][1][1] < 130 && px[3][1][2] < 100, `cmyk interior ${px[3][1]}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('never decodes a soft mask over MAX_PIXELS: its size comes from its dictionary, and the image keeps its raw stream', () => {
    const base = path.join(os.homedir(), '.cache', 'bona-tests');
    fs.mkdirSync(base, { recursive: true });
    const dir = fs.mkdtempSync(path.join(base, 'smask-bomb-'));
    try {
      const pdf = path.join(dir, 'bomb.pdf');
      const mk = spawnSync('uv', ['run', ...WITH, 'python', '-I', '-c', MAKE_BOMB, pdf], { encoding: 'utf8' });
      assert.equal(mk.status, 0, mk.stderr);
      assert.deepEqual(JSON.parse(mk.stdout.trim().split('\n').pop()), ['8000', '8000'], 'the fixture mask really is 64 MP');
      const out = path.join(dir, 'out');
      const run = spawnSync('uv', ['run', ...WITH, 'python', '-I', SCRIPT, pdf, out, '--min-side', '300'], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const res = JSON.parse(run.stdout.trim().split('\n').pop());
      assert.deepEqual(res.candidates.map((c) => c.page), [1, 2, 3]);
      assert.equal('flattened' in res.candidates[0], false, 'the oversized mask was not decoded: raw stream kept');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('mask_fits(): Width x Height from the dictionary against MAX_PIXELS; no readable size, no decode', () => {
    const r = spawnSync('uv', ['run', ...WITH, 'python', '-I', '-c', MASK_FITS, path.join(HERE, '..')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), {
      honest: true, lying: false, at_cap: true, over_cap: false, no_width: false, not_a_number: false,
      flate: true, jpx: false, jpx_in_array: false, cap: 50000000,
    });
  });

  it('never decodes a JPXDecode soft mask (its codestream, not its dictionary, sets its size): the image keeps its raw stream', () => {
    const base = path.join(os.homedir(), '.cache', 'bona-tests');
    fs.mkdirSync(base, { recursive: true });
    const dir = fs.mkdtempSync(path.join(base, 'smask-jpx-'));
    try {
      const pdf = path.join(dir, 'jpx.pdf');
      const mk = spawnSync('uv', ['run', ...WITH, 'python', '-I', '-c', MAKE_JPX, pdf], { encoding: 'utf8' });
      assert.equal(mk.status, 0, mk.stderr);
      assert.equal(mk.stdout.trim().split('\n').pop(), 'decoded 3000 3000 /JPXDecode 900', 'the fixture: a 3000x3000 JPX mask that declares 900x700');
      const out = path.join(dir, 'out');
      const run = spawnSync('uv', ['run', ...WITH, 'python', '-I', SCRIPT, pdf, out, '--min-side', '300'], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const res = JSON.parse(run.stdout.trim().split('\n').pop());
      assert.deepEqual(res.candidates.map((c) => c.page), [1, 2, 3]);
      assert.equal('flattened' in res.candidates[0], false, 'the JPX mask was not decoded: raw stream kept');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('r3 #6: a bitmap drawn more than once keeps its LARGEST coverage — a whole-page picture first seen as a small preview is still a whole page', () => {
    const base = path.join(os.homedir(), '.cache', 'bona-tests');
    fs.mkdirSync(base, { recursive: true });
    const dir = fs.mkdtempSync(path.join(base, 'twice-'));
    try {
      const pdf = path.join(dir, 'twice.pdf');
      const mk = spawnSync('uv', ['run', ...WITH, 'python', '-I', '-c', MAKE_TWICE, pdf], { encoding: 'utf8' });
      assert.equal(mk.status, 0, mk.stderr);
      const run = spawnSync('uv', ['run', ...WITH, 'python', '-I', SCRIPT, pdf, path.join(dir, 'out'), '--min-side', '300'], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const res = JSON.parse(run.stdout.trim().split('\n').pop());
      assert.equal(res.candidates.length, 3, 'the same bytes are one candidate');
      assert.equal(res.candidates[0].page, 1, 'first seen on page 1');
      // Page 4 draws it at 765 x 595 pt on an 842 x 595 pt page (its aspect ratio kept): 0.9086 — not page 1's 0.037.
      assert.ok(res.candidates[0].coverage >= 0.85, `coverage ${res.candidates[0].coverage}: the page-4 placement covers its page`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('r5 #8: past the candidate cap a repeat of a kept bitmap still raises its coverage, and the cap still keeps out new pictures', () => {
    const base = path.join(os.homedir(), '.cache', 'bona-tests');
    fs.mkdirSync(base, { recursive: true });
    const dir = fs.mkdtempSync(path.join(base, 'capped-'));
    try {
      const pdf = path.join(dir, 'capped.pdf');
      const mk = spawnSync('uv', ['run', ...WITH, 'python', '-I', '-c', MAKE_CAPPED, pdf], { encoding: 'utf8' });
      assert.equal(mk.status, 0, mk.stderr);
      const out = path.join(dir, 'out');
      const run = spawnSync('uv', ['run', ...WITH, 'python', '-I', SCRIPT, pdf, out, '--min-side', '300', '--max-candidates', '3'], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const res = JSON.parse(run.stdout.trim().split('\n').pop());
      assert.equal(res.rendered, false, 'three embedded candidates: no page-render fallback');
      assert.deepEqual(res.candidates.map((c) => c.page), [1, 2, 3], 'the cap keeps the first three pictures, and page 4 stays out');
      assert.deepEqual(fs.readdirSync(path.join(out, 'images')).sort(), ['000.png', '001.png', '002.png'], 'nothing past the cap is written');
      // Page 5 draws A at 765 x 595 pt on an 842 x 595 pt page: 0.9086, not page 1's 0.037.
      assert.ok(res.candidates[0].coverage >= 0.85, `coverage ${res.candidates[0].coverage}: the page-5 placement, past the cap, covers its page`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
