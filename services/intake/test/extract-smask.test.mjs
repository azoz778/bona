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
});
