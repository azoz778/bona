// Labelled contact sheet of local candidate images, so `claude -p` can look at every
// candidate in one Read. Same idea as scripts/curate/contact-sheet.mjs, but the inputs
// are files on disk (extracted from the PDF) rather than gallery URLs, and tiles use
// `fit: contain` so the model judges the real framing (landscape vs portrait matters
// for a hero) instead of a cropped square.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

// Decompression-bomb cap, matching extract_pdf.py::MAX_PIXELS and images.mjs.
const MAX_INPUT_PIXELS = 50_000_000;

const TILE_W = 440;
const TILE_H = 320;
const COLS = 5;
const PER_SHEET = 25;

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/**
 * @param {Array<{index:number,abs:string,width:number,height:number,page:number,source:string}>} candidates
 * @param {string} outDir
 * @returns {Promise<Array<{file:string, from:number, to:number, count:number}>>}
 */
export async function buildContactSheets(candidates, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const sheets = [];
  for (let start = 0; start < candidates.length; start += PER_SHEET) {
    const chunk = candidates.slice(start, start + PER_SHEET);
    const rows = Math.ceil(chunk.length / COLS);
    const tiles = [];
    for (const [i, c] of chunk.entries()) {
      let body;
      try {
        body = await sharp(c.abs, { limitInputPixels: MAX_INPUT_PIXELS })
          .resize(TILE_W, TILE_H, { fit: 'contain', background: { r: 24, g: 24, b: 24 } })
          .toBuffer();
      } catch {
        continue;
      }
      const ratio = c.height ? (c.width / c.height).toFixed(2) : '?';
      const label = Buffer.from(
        `<svg width="${TILE_W}" height="${TILE_H}">` +
        `<rect x="0" y="0" width="${TILE_W}" height="30" fill="black" fill-opacity="0.72"/>` +
        `<text x="8" y="22" font-size="20" font-family="sans-serif" font-weight="bold" fill="#ffd54a">#${c.index}</text>` +
        `<text x="60" y="22" font-size="15" font-family="sans-serif" fill="#e8e8e8">${esc(`${c.width}x${c.height}  ar ${ratio}  p${c.page}  ${c.source}`)}</text>` +
        '</svg>',
      );
      tiles.push({
        input: await sharp(body, { limitInputPixels: MAX_INPUT_PIXELS }).composite([{ input: label, top: 0, left: 0 }]).toBuffer(),
        top: Math.floor(i / COLS) * TILE_H,
        left: (i % COLS) * TILE_W,
      });
    }
    if (!tiles.length) continue;
    const file = path.join(outDir, `contact-sheet-${sheets.length + 1}.jpg`);
    await sharp({ create: { width: COLS * TILE_W, height: rows * TILE_H, channels: 3, background: '#181818' } })
      .composite(tiles)
      .jpeg({ quality: 82 })
      .toFile(file);
    sheets.push({ file, from: chunk[0].index, to: chunk[chunk.length - 1].index, count: chunk.length });
  }
  return sheets;
}
