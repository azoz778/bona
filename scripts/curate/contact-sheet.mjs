#!/usr/bin/env node
// Curation helper: renders a labelled contact sheet of one gallery folder so a curator can
// pick hero/room images by index. Usage: node scripts/curate/contact-sheet.mjs <folder> <out.jpg> [cols]
// Indices match scripts/tk-gallery-data.json order (the same indices listings.source.mjs uses).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [folder, out, colsArg] = process.argv.slice(2);
if (!folder || !out) { console.error('usage: contact-sheet.mjs <folder> <out.jpg> [cols]'); process.exit(1); }

const gallery = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'tk-gallery-data.json'), 'utf8')).filter((p) => p.folder === folder);
if (!gallery.length) { console.error(`no photos in folder "${folder}"`); process.exit(1); }

const W = 320, H = 220, cols = Number(colsArg || 5), rows = Math.ceil(gallery.length / cols);
const tiles = [];
for (const [i, p] of gallery.entries()) {
  const u = p.thumb || p.url;
  let buf;
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
  } catch (e) { console.error(i, 'fail', u, e.message); continue; }
  const img = await sharp(buf).resize(W, H, { fit: 'cover' }).toBuffer();
  const label = Buffer.from(`<svg width="${W}" height="${H}"><rect x="0" y="0" width="70" height="34" fill="black" fill-opacity="0.7"/><text x="8" y="26" font-size="24" font-family="sans-serif" font-weight="bold" fill="yellow">${i}</text></svg>`);
  tiles.push({ input: await sharp(img).composite([{ input: label, top: 0, left: 0 }]).toBuffer(), top: Math.floor(i / cols) * H, left: (i % cols) * W });
}
await sharp({ create: { width: cols * W, height: rows * H, channels: 3, background: '#222' } }).composite(tiles).jpeg({ quality: 80 }).toFile(out);
console.log(`wrote ${out}: ${gallery.length} images from "${folder}"`);
