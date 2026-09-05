#!/usr/bin/env node
// Generates satellite stills for land plots from the tile proxy at dashboard.azoz.uk
// (Esri World Imagery, served same-origin by TK's land register; cached there).
// Usage: node scripts/curate/land-stills.mjs <PLOT-ID> <lat> <lng> [--force]
//   writes public/land/<PLOT-ID>.jpg      (z=17, 1024x768, centred on the pin)
//          public/land/<PLOT-ID>-z15.jpg  (z=15, 1024x768, wider context)
// Only plots with an exact pin (not a district pin) should be rendered — a still centred on a
// district-level pin would show the wrong block.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(ROOT, 'public', 'land');
const TILE_BASE = process.env.TK_TILE_BASE || 'https://dashboard.azoz.uk/land/tile/sat';
const TILE = 256;
const W = 1024, H = 768;

const [id, latArg, lngArg] = process.argv.slice(2);
const force = process.argv.includes('--force');
const lat = Number(latArg), lng = Number(lngArg);
if (!/^[A-Z]+-\d+$/.test(id || '') || !Number.isFinite(lat) || !Number.isFinite(lng)) {
  console.error('usage: land-stills.mjs <PLOT-ID> <lat> <lng> [--force]');
  process.exit(1);
}

function globalPx(lat, lng, z) {
  const n = 2 ** z * TILE;
  const x = ((lng + 180) / 360) * n;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  return { x, y };
}

async function fetchTile(z, x, y) {
  const url = `${TILE_BASE}/${z}/${x}/${y}.jpg`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'bona-curate/1.0' } });
      if (r.status === 200) return Buffer.from(await r.arrayBuffer());
      if (r.status < 500 && r.status !== 429) throw new Error(`HTTP ${r.status}`);
    } catch (e) { if (attempt === 2) throw new Error(`${url}: ${e.message}`); }
  }
  throw new Error(`${url}: still failing (429/5xx) after 3 attempts`);
}

async function still(z, out) {
  const c = globalPx(lat, lng, z);
  const left = Math.round(c.x - W / 2), top = Math.round(c.y - H / 2);
  const tx0 = Math.floor(left / TILE), ty0 = Math.floor(top / TILE);
  const tx1 = Math.floor((left + W - 1) / TILE), ty1 = Math.floor((top + H - 1) / TILE);
  const tiles = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    tiles.push({ input: await fetchTile(z, tx, ty), left: (tx - tx0) * TILE, top: (ty - ty0) * TILE });
  }
  const mosaicW = (tx1 - tx0 + 1) * TILE, mosaicH = (ty1 - ty0 + 1) * TILE;
  const ring = Buffer.from(`<svg width="${W}" height="${H}"><circle cx="${W / 2}" cy="${H / 2}" r="16" fill="none" stroke="#000" stroke-opacity="0.55" stroke-width="6"/><circle cx="${W / 2}" cy="${H / 2}" r="16" fill="none" stroke="#fff" stroke-width="2.5"/></svg>`);
  await sharp({ create: { width: mosaicW, height: mosaicH, channels: 3, background: '#111' } })
    .composite(tiles).png().toBuffer()
    .then((buf) => sharp(buf).extract({ left: left - tx0 * TILE, top: top - ty0 * TILE, width: W, height: H }).composite([{ input: ring }]).jpeg({ quality: 84, mozjpeg: true }).toFile(out));
  console.log(`wrote ${path.relative(ROOT, out)} (z=${z}, ${tiles.length} tiles)`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [z, suffix] of [[17, ''], [15, '-z15']]) {
  const out = path.join(OUT_DIR, `${id}${suffix}.jpg`);
  if (fs.existsSync(out) && !force) { console.log(`exists ${path.relative(ROOT, out)} (use --force to redo)`); continue; }
  await still(z, out);
}
