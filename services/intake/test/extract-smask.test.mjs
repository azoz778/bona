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

// r6 #7: the r5 #8 fixture (MAKE_CAPPED, pages 1-4) plus 3 new unique soft-masked pictures past the cap (pages 5-7), then
// bitmap A over its whole page (page 8). argv[2] = "same": page 8 draws A's own xref, as in r5 #8. "graft": page 8 is a
// byte-identical copy of A under a NEW xref (inserted from a second document), so only the raw-bytes key can match it.
// r7 #8: "swap" is the graft with Width and Height swapped in the copy's dictionary (the same raw bytes, another
// picture), and "form" draws the grafted copy inside a form XObject (show_pdf_page), where it has no page-level name.
// r8 #7: "decode" is the graft with an inverting /Decode in the copy's dictionary (the same raw bytes and size, another
// picture). The other r8 modes draw A's own xref on page 8. "twice": A small, then over the page, under ONE name, and B
// small (a second repeat on that page). "raise" and "lower": a form XObject drawn FIRST whose own picture (a new one) is
// also named fzImg0, over the page with A at a quarter ("raise"), or small with A over the page ("lower"). "ocg": A over
// the page inside an OFF optional-content layer, then A small.
// Every mode ends with page 9, which draws page 4's and page 5's pictures again (their own xrefs, neither one kept).
const MAKE_CAP_WORK = `
import sys, io, json, hashlib, pymupdf
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
def mask():
    m = Image.new('L', (w, h), 255); m.paste(Image.new('L', (300, 200), 128), (100, 100)); return png(m)
doc = pymupdf.open()
a = png(noisy((200, 40, 40)))
others = [png(noisy(c)) for c in ((40, 200, 40), (40, 40, 200), (200, 200, 40))]
masked = [png(noisy(c)) for c in ((40, 200, 200), (200, 40, 200), (120, 120, 120))]
def put(d, stream, small=False, m=None):
    page = d.new_page(width=842, height=595)
    page.insert_image(pymupdf.Rect(40, 40, 200, 160) if small else page.rect, stream=stream, mask=m)
    page.insert_text((40, 580), 'Floor plan apartment bedroom')
put(doc, a, small=True)
for s in others: put(doc, s)
for s in masked: put(doc, s, m=mask())
xa, xb = doc[0].get_images(full=True)[0][0], doc[1].get_images(full=True)[0][0]
small = pymupdf.Rect(40, 40, 200, 160)
if sys.argv[2] in ('graft', 'swap', 'decode'):
    src = pymupdf.open(); put(src, a); doc.insert_pdf(src)
    if sys.argv[2] == 'swap':
        x = doc[7].get_images(full=True)[0][0]
        wd, ht = doc.xref_get_key(x, 'Width')[1], doc.xref_get_key(x, 'Height')[1]
        doc.xref_set_key(x, 'Width', ht); doc.xref_set_key(x, 'Height', wd)
    if sys.argv[2] == 'decode':
        doc.xref_set_key(doc[7].get_images(full=True)[0][0], 'Decode', '[1 0 1 0 1 0]')
elif sys.argv[2] == 'form':
    src = pymupdf.open(); put(src, a)
    page = doc.new_page(width=842, height=595)
    page.show_pdf_page(page.rect, src, 0)
elif sys.argv[2] == 'twice':
    page = doc.new_page(width=842, height=595)
    page.insert_image(small, xref=xa)
    page.insert_image(pymupdf.Rect(40, 400, 200, 520), xref=xb)
    c = page.get_contents()[-1]
    doc.update_stream(c, doc.xref_stream(c) + b'\\nq 765 0 0 595 38.5 0 cm /fzImg0 Do Q\\n')
elif sys.argv[2] in ('raise', 'lower'):
    src = pymupdf.open(); s = src.new_page(width=842, height=595)
    s.insert_image(s.rect if sys.argv[2] == 'raise' else small, stream=png(noisy((90, 90, 90))))
    page = doc.new_page(width=842, height=595)
    page.insert_image(pymupdf.Rect(0, 0, 421, 297.5) if sys.argv[2] == 'raise' else page.rect, xref=xa)
    page.show_pdf_page(page.rect, src, 0, overlay=False)
elif sys.argv[2] == 'ocg':
    ocg = doc.add_ocg('hidden', on=0)
    page = doc.new_page(width=842, height=595)
    page.insert_image(small, xref=xa)
    doc.xref_set_key(int(doc.xref_get_key(page.xref, 'Resources')[1].split()[0]), 'Properties', f'<</oc1 {ocg} 0 R>>')
    c = page.get_contents()[0]
    doc.update_stream(c, b'/OC /oc1 BDC q 765 0 0 595 38.5 0 cm /fzImg0 Do Q EMC\\n' + doc.xref_stream(c))
else:
    put(doc, a)
page = doc.new_page(width=842, height=595)
for p, r in ((3, pymupdf.Rect(0, 0, 421, 595)), (4, pymupdf.Rect(421, 0, 842, 595))):
    page.insert_image(r, xref=doc[p].get_images(full=True)[0][0])
doc.save(sys.argv[1])
doc = pymupdf.open(sys.argv[1])
i1, i8 = doc[0].get_images(full=True)[0], doc[7].get_images(full=True)[0]
x1, x8 = i1[0], i8[0]
raw = lambda x: hashlib.sha256(doc.xref_stream_raw(x)).hexdigest()
print(json.dumps({'same_xref': x1 == x8, 'same_raw': raw(x1) == raw(x8), 'size1': list(i1[2:4]), 'size8': list(i8[2:4]),
                  'in_form8': i8[-1] != 0, 'masks': [bool(doc[p].get_images(full=True)[0][1]) for p in (4, 5, 6)],
                  'names8': [[i[7], i[-1] != 0] for i in doc[7].get_images(full=True)],
                  'draws8': doc[7].read_contents().count(b'/fzImg0 Do'),
                  'shown8': len(doc[7].get_image_rects(x1)) if sys.argv[2] == 'ocg' else None,
                  'layers_on': [o['on'] for o in doc.get_ocgs().values()],
                  'decode': [doc.xref_get_key(x, 'Decode')[1] for x in (x1, x8)]}))
`;

// Runs extract_pdf.py as a module with call counters on extract_image, colour_ratio, flatten_on_white,
// placement_coverage, repeat_coverage and raw_key, and (r7 #8) on what decodes a picture inside PyMuPDF: Pixmap(doc, xref),
// Page.get_image_rects and MuPDF's fz_get_pixmap_from_image, and (r8 #7) on the content-stream pass that places a picture
// by its name (JM_image_reporter). A call counts as "past the cap" once images/ holds the 3 kept files (--max-candidates 3).
const CAP_WORK_HARNESS = `
import sys, io, os, json, contextlib, importlib.util
script, pdf, out = sys.argv[1:4]
spec = importlib.util.spec_from_file_location('extract_pdf', script)
x = importlib.util.module_from_spec(spec); spec.loader.exec_module(x)
import pymupdf
img_dir = os.path.join(out, 'images')
past = {'extract_image': [], 'colour_ratio': [], 'flatten_on_white': [], 'placement_coverage': [], 'repeat_coverage': [],
        'raw_key': [], 'pixmap_xref': [], 'get_image_rects': [], 'decode': [], 'reporter': []}
before = {k: 0 for k in past}
def wrap(name, fn, tag):
    def inner(*a, **k):
        t = tag(*a)
        if t is not None:
            if os.path.isdir(img_dir) and len(os.listdir(img_dir)) >= 3:
                past[name].append(t)
            else:
                before[name] += 1
        return fn(*a, **k)
    return inner
pymupdf.Document.extract_image = wrap('extract_image', pymupdf.Document.extract_image, lambda self, xref, *r: xref)
x.colour_ratio = wrap('colour_ratio', x.colour_ratio, lambda doc, xref: xref)
x.flatten_on_white = wrap('flatten_on_white', x.flatten_on_white, lambda doc, data, smask: smask)
x.placement_coverage = wrap('placement_coverage', x.placement_coverage, lambda page, xref: page.number + 1)
x.raw_key = wrap('raw_key', x.raw_key, lambda doc, xref, *r: xref)
if hasattr(x, 'repeat_coverage'):
    x.repeat_coverage = wrap('repeat_coverage', x.repeat_coverage, lambda page, info: page.number + 1)
pymupdf.Pixmap.__init__ = wrap('pixmap_xref', pymupdf.Pixmap.__init__,
    lambda self, *a: a[1] if len(a) == 2 and isinstance(a[0], pymupdf.Document) and isinstance(a[1], int) else None)
pymupdf.Page.get_image_rects = wrap('get_image_rects', pymupdf.Page.get_image_rects, lambda page, *r: page.number + 1)
pymupdf.mupdf.fz_get_pixmap_from_image = wrap('decode', pymupdf.mupdf.fz_get_pixmap_from_image, lambda *a: 1)
pymupdf.JM_image_reporter = wrap('reporter', pymupdf.JM_image_reporter, lambda *a: 1)
sys.argv = ['extract_pdf.py', pdf, out, '--min-side', '300', '--max-candidates', '3']
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    rc = x.main()
print(json.dumps({'rc': rc, 'res': json.loads(buf.getvalue().strip().split('\\n')[-1]), 'past': past, 'before': before}))
`;

function capWork(mode) {
  const base = path.join(os.homedir(), '.cache', 'bona-tests');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, `capwork-${mode}-`));
  try {
    const pdf = path.join(dir, 'capwork.pdf');
    const mk = spawnSync('uv', ['run', ...WITH, 'python', '-I', '-c', MAKE_CAP_WORK, pdf, mode], { encoding: 'utf8' });
    assert.equal(mk.status, 0, mk.stderr);
    const fixture = JSON.parse(mk.stdout.trim().split('\n').pop());
    const out = path.join(dir, 'out');
    const run = spawnSync('uv', ['run', ...WITH, 'python', '-I', '-c', CAP_WORK_HARNESS, SCRIPT, pdf, out], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const r = JSON.parse(run.stdout.trim().split('\n').pop());
    return { fixture, files: fs.readdirSync(path.join(out, 'images')).sort(), ...r };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Coverages of the three kept candidates as e892790 (r6 #7) gave them, with page 8 placed (same, graft) and not (swap).
// r8 #7: "raise" places A at a quarter of page 8 (382.5 x 297.5 pt): 0.2271.
const COVERAGE_PLACED = [0.9086, 0.9086, 0.9086];
const COVERAGE_UNPLACED = [0.037, 0.9086, 0.9086];
const COVERAGE_QUARTER = [0.2271, 0.9086, 0.9086];

// placed: the pages whose repeat is placed past the cap. decoded: the pages placed by placement_coverage (a repeat
// drawn inside a form XObject has no page-level name to place without decoding, r7 #8; nor has one whose name another
// image on the page carries, or one in a document with optional content, r8 #7).
function assertNoWorkPastCap(r, { placed = [8], decoded = [] } = {}) {
  assert.equal(r.rc, 0);
  assert.deepEqual(r.fixture.masks, [true, true, true], 'pages 5-7 are soft-masked pictures');
  assert.ok(r.before.extract_image >= 3 && r.before.colour_ratio >= 3 && r.before.placement_coverage >= 3
    && r.before.pixmap_xref >= 3 && r.before.get_image_rects >= 3 && r.before.decode >= 3,
    `the counters count: ${JSON.stringify(r.before)}`);
  assert.deepEqual(r.res.candidates.map((c) => c.page), [1, 2, 3], 'the cap keeps the first three pictures');
  assert.deepEqual(r.files, ['000.png', '001.png', '002.png'], 'nothing past the cap is written');
  assert.deepEqual(r.past.extract_image, [], 'no extract_image past the cap');
  assert.deepEqual(r.past.colour_ratio, [], 'no colour_ratio past the cap');
  assert.deepEqual(r.past.flatten_on_white, [], 'no flatten_on_white past the cap (pages 5-7 are soft-masked)');
  assert.deepEqual(r.past.repeat_coverage, placed, 'past the cap only a repeat of a kept picture is placed');
  assert.deepEqual(r.past.placement_coverage, decoded, 'past the cap a page-level repeat is placed by its name, not by get_image_rects');
  assert.deepEqual(r.past.get_image_rects, decoded, 'no get_image_rects past the cap for a page-level repeat');
  if (decoded.length === 0) {
    assert.deepEqual(r.past.pixmap_xref, [], 'no Pixmap(doc, xref) past the cap');
    assert.deepEqual(r.past.decode, [], 'no picture decoded past the cap');
  }
  // Pages 4-7 bring four pictures that are not kept; page 9 draws two of them again (r7 #8, Claude NB8).
  assert.ok(r.past.raw_key.length >= 4, `the raw-key counter counts: ${r.past.raw_key}`);
  assert.equal(new Set(r.past.raw_key).size, r.past.raw_key.length, `past the cap each picture's raw key is hashed once: ${r.past.raw_key}`);
}

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

  it('r6 #7, r7 #8: past the cap nothing is extracted, decoded or flattened; a repeat of a kept picture (same xref) only has its coverage placed, by its name', () => {
    const r = capWork('same');
    assert.equal(r.fixture.same_xref, true, 'page 8 draws the xref kept on page 1');
    assertNoWorkPastCap(r);
    // Page 8 draws A at 765 x 595 pt on an 842 x 595 pt page: 0.9086, not page 1's 0.037.
    assert.deepEqual(r.res.candidates.map((c) => c.coverage), COVERAGE_PLACED, 'the page-8 repeat covers its page');
  });

  it('r6 #7, r7 #8: past the cap a byte-identical copy of a kept picture under a NEW xref is matched by its raw-bytes key, with no decode', () => {
    const r = capWork('graft');
    assert.equal(r.fixture.same_xref, false, 'page 8 is a different object');
    assert.equal(r.fixture.same_raw, true, '... with the same raw (still compressed) stream');
    assertNoWorkPastCap(r);
    assert.deepEqual(r.res.candidates.map((c) => c.coverage), COVERAGE_PLACED, 'the page-8 copy covers its page');
  });

  it('r7 #8: past the cap the same raw bytes under a dictionary with Width and Height swapped are another picture, not a repeat', () => {
    const r = capWork('swap');
    assert.equal(r.fixture.same_xref, false, 'page 8 is a different object');
    assert.equal(r.fixture.same_raw, true, '... with the same raw (still compressed) stream');
    assert.deepEqual([r.fixture.size1, r.fixture.size8], [[900, 700], [700, 900]], '... read as 700 x 900, not 900 x 700');
    assertNoWorkPastCap(r, { placed: [] });
    assert.ok(r.res.candidates[0].coverage < 0.85, `coverage ${r.res.candidates[0].coverage}: page 8 is not a placement of A`);
    assert.deepEqual(r.res.candidates.map((c) => c.coverage), COVERAGE_UNPLACED);
  });

  it('r7 #8: past the cap a repeat drawn inside a form XObject is still placed (by get_image_rects), so a whole page is still a whole page', () => {
    const r = capWork('form');
    assert.equal(r.fixture.in_form8, true, 'page 8 draws the copy inside a form XObject');
    assert.equal(r.fixture.same_raw, true, '... with the same raw stream as A');
    assertNoWorkPastCap(r, { placed: [8], decoded: [8] });
    assert.ok(r.res.candidates[0].coverage >= 0.85, `coverage ${r.res.candidates[0].coverage}: the page-8 form draws A over its page`);
  });

  it('r8 #7: past the cap a picture drawn small, then over its page, under ONE name counts its LARGEST placement, from one reporter pass per page and no decode', () => {
    const r = capWork('twice');
    assert.equal(r.fixture.same_xref, true, 'page 8 draws the xref kept on page 1');
    assert.deepEqual(r.fixture.names8, [['fzImg0', false], ['fzImg1', false]], 'A and B, each under its own page-level name');
    assert.equal(r.fixture.draws8, 2, "A's one name is drawn twice: small, then over the page");
    assert.deepEqual(r.res.candidates.map((c) => c.coverage), COVERAGE_PLACED, 'the page-8 repeat covers its page');
    assertNoWorkPastCap(r, { placed: [8, 8] });
    assert.deepEqual(r.past.reporter, [1], "one content-stream pass places both of page 8's repeats");
  });

  it("r8 #7: past the cap a repeat whose name a form's own picture also carries is placed by placement_coverage: a quarter-page placement is not the form's whole page", () => {
    const r = capWork('raise');
    assert.equal(r.fixture.same_xref, true, 'page 8 draws the xref kept on page 1');
    assert.deepEqual(r.fixture.names8, [['fzImg0', false], ['fzImg0', true]], "A's page-level name is also the name of the form's own picture");
    assert.deepEqual(r.res.candidates.map((c) => c.coverage), COVERAGE_QUARTER, 'A covers a quarter of page 8, as e892790 placed it');
    assertNoWorkPastCap(r, { placed: [8], decoded: [8] });
  });

  it("r8 #7: past the cap a repeat whose name a form's own picture also carries is placed by placement_coverage: a whole page is not the form's small picture", () => {
    const r = capWork('lower');
    assert.equal(r.fixture.same_xref, true, 'page 8 draws the xref kept on page 1');
    assert.deepEqual(r.fixture.names8, [['fzImg0', false], ['fzImg0', true]], "A's page-level name is also the name of the form's own picture");
    assert.deepEqual(r.res.candidates.map((c) => c.coverage), COVERAGE_PLACED, 'A covers page 8, as e892790 placed it');
    assertNoWorkPastCap(r, { placed: [8], decoded: [8] });
  });

  it('r8 #7: past the cap a repeat in a document with optional content is placed by placement_coverage: a draw on an OFF layer is not a placement', () => {
    const r = capWork('ocg');
    assert.deepEqual(r.fixture.layers_on, [false], 'the document has one optional-content layer, OFF');
    assert.equal(r.fixture.draws8, 2, "A's name is drawn twice on page 8: over the page on the OFF layer, then small");
    assert.equal(r.fixture.shown8, 1, '... and only the small draw is shown');
    assert.deepEqual(r.res.candidates.map((c) => c.coverage), COVERAGE_UNPLACED, 'A stays small, as e892790 placed it');
    assertNoWorkPastCap(r, { placed: [8], decoded: [8] });
  });

  it('r8 #7 (NB11): past the cap the same raw bytes under another /Decode are another picture, not a repeat', () => {
    const r = capWork('decode');
    assert.equal(r.fixture.same_xref, false, 'page 8 is a different object');
    assert.equal(r.fixture.same_raw, true, '... with the same raw (still compressed) stream');
    assert.deepEqual([r.fixture.size1, r.fixture.size8], [[900, 700], [900, 700]], '... and the same size');
    assert.deepEqual(r.fixture.decode, ['null', '[1 0 1 0 1 0]'], '... read through an inverting /Decode');
    assertNoWorkPastCap(r, { placed: [] });
    assert.deepEqual(r.res.candidates.map((c) => c.coverage), COVERAGE_UNPLACED);
  });
});
