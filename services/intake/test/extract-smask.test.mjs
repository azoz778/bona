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

const MAKE = `
import sys, fitz
from PIL import Image
import io
w, h = 900, 700
doc = fitz.open()
for k in range(3):                                       # >= RENDER_THRESHOLD distinct images, or the script rasterises pages instead
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))        # fully transparent ...
    for x in range(200, 700):
        for y in range(200, 500):
            img.putpixel((x, y), ((x * 3 + k) % 256, (y * 5) % 256, 60, 255)) # ... except a coloured "plan" block
    for x in range(0, w, 7):
        img.putpixel((x, 100 + k), (10, 200, 30, 255))   # a few colours so it is not "flat art"
    buf = io.BytesIO(); img.save(buf, 'PNG')
    page = doc.new_page(width=842, height=595)
    page.insert_image(page.rect, stream=buf.getvalue())
    page.insert_text((40, 40), 'Floor plan 105.02 m2 apartment bedroom')
doc.save(sys.argv[1])
`;

describe('extract_pdf.py — transparent images', { skip: !UV && 'uv not installed' }, () => {
  it('flattens an image with a soft mask onto white instead of black', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-smask-'));
    try {
      const pdf = path.join(dir, 'plan.pdf');
      const mk = spawnSync('uv', ['run', '--with', 'pymupdf', '--with', 'pillow', 'python', '-I', '-c', MAKE, pdf], { encoding: 'utf8' });
      assert.equal(mk.status, 0, mk.stderr);
      const out = path.join(dir, 'out');
      const run = spawnSync('uv', ['run', '--with', 'pymupdf', '--with', 'pillow', 'python', '-I', SCRIPT, pdf, out, '--min-side', '300'], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const res = JSON.parse(run.stdout.trim().split('\n').pop());
      assert.equal(res.candidates.length, 3);
      assert.ok(res.candidates.every((c) => c.source === 'embedded'), JSON.stringify(res.candidates.map((c) => c.source)));
      for (const c of res.candidates) {
        const probe = spawnSync('uv', ['run', '--with', 'pillow', 'python', '-I', '-c',
          'import sys; from PIL import Image; im = Image.open(sys.argv[1]).convert("RGB"); print(im.getpixel((5, 5)))', c.abs], { encoding: 'utf8' });
        assert.equal(probe.stdout.trim(), '(255, 255, 255)');
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
