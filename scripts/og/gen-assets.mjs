#!/usr/bin/env node
/* Generates Bona's brand assets into public/:
     favicon.svg, favicon.ico (16/32/48 PNG-in-ICO), apple-touch-icon.png (180),
     icon-192.png, icon-512.png, icon-512-maskable.png, og-default.png (1200x630)
   Letterforms are real glyph outlines pulled from public/fonts/*.woff2 via fontkitten
   (an Astro dependency), so no system font / fontconfig is involved.
   Usage: node scripts/og/gen-assets.mjs            (writes files)
          node scripts/og/gen-assets.mjs --check    (only verifies the files exist) */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pub = path.join(root, 'public');
const site = JSON.parse(fs.readFileSync(path.join(root, 'src/data/site.json'), 'utf8'));

const IVORY = '#f5f1ea';
const INK = '#0f1214';
const CHAMPAGNE = '#c8a96a';

const outputs = ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'og-default.png'];

if (process.argv.includes('--check')) {
  const missing = outputs.filter((f) => !fs.existsSync(path.join(pub, f)));
  if (missing.length) { console.error('missing assets:', missing.join(', ')); process.exit(1); }
  console.log('assets ok'); process.exit(0);
}

// ---------- font → SVG path helpers ----------
let fontkitten = null;
try { fontkitten = (await import('fontkitten')).default ?? (await import('fontkitten')); } catch { /* fallback below */ }

function loadFont(file) {
  if (!fontkitten) return null;
  try { return fontkitten.create(fs.readFileSync(path.join(pub, 'fonts', file))); } catch (e) { console.warn('font load failed', file, e.message); return null; }
}

/** Lay out `text` as SVG <path> elements. Returns { svg, width, height, ascent, descent } in px. */
function layoutText(font, text, sizePx, letterSpacingEm = 0, fill = INK) {
  if (!font) return null;
  const scale = sizePx / font.unitsPerEm;
  const tracking = letterSpacingEm * sizePx;
  let x = 0;
  const parts = [];
  for (const ch of [...text]) {
    const cp = ch.codePointAt(0);
    const g = font.glyphForCodePoint(cp);
    if (!g) { x += sizePx * 0.3; continue; }
    if (ch !== ' ') {
      const d = g.path.toSVG();
      if (d) parts.push(`<path d="${d}" transform="translate(${x.toFixed(2)} 0) scale(${scale.toFixed(5)} ${(-scale).toFixed(5)})" fill="${fill}"/>`);
    }
    x += (g.advanceWidth ?? font.unitsPerEm * 0.5) * scale + tracking;
  }
  const width = x - tracking; // no trailing tracking
  return { svg: parts.join(''), width, ascent: font.ascent * scale, descent: -font.descent * scale, capHeight: (font.capHeight || font.unitsPerEm * 0.65) * scale };
}

function glyphBBox(font, ch, sizePx) {
  const g = font.glyphForCodePoint(ch.codePointAt(0));
  const scale = sizePx / font.unitsPerEm;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of g.path.commands) {
    const a = c.args ?? [];
    for (let i = 0; i + 1 < a.length; i += 2) { minX = Math.min(minX, a[i]); maxX = Math.max(maxX, a[i]); minY = Math.min(minY, a[i + 1]); maxY = Math.max(maxY, a[i + 1]); }
  }
  return { minX: minX * scale, maxX: maxX * scale, minY: minY * scale, maxY: maxY * scale, w: (maxX - minX) * scale, h: (maxY - minY) * scale };
}

const cormorant = loadFont('cormorant-600.woff2');
const montserrat = loadFont('montserrat-400.woff2');

// ---------- favicon.svg (B monogram) ----------
function monogramSvg(size = 512, { rounded = true, pad = 0 } = {}) {
  const r = rounded ? size * 0.18 : 0;
  let inner;
  if (cormorant) {
    const fontPx = size * 0.72;
    const bb = glyphBBox(cormorant, 'B', fontPx);
    const cx = size / 2 - (bb.minX + bb.w / 2);
    const cy = size / 2 + (bb.minY + bb.h / 2); // y is flipped
    const d = cormorant.glyphForCodePoint('B'.codePointAt(0)).path.toSVG();
    const scale = fontPx / cormorant.unitsPerEm;
    inner = `<path d="${d}" transform="translate(${cx.toFixed(2)} ${cy.toFixed(2)}) scale(${scale.toFixed(5)} ${(-scale).toFixed(5)})" fill="${INK}"/>`;
  } else {
    inner = `<text x="50%" y="50%" dominant-baseline="central" text-anchor="middle" font-family="Cormorant Garamond, Georgia, serif" font-weight="600" font-size="${size * 0.7}" fill="${INK}">B</text>`;
  }
  const ruleY = size * 0.86;
  const rule = `<rect x="${size * 0.36}" y="${ruleY}" width="${size * 0.28}" height="${Math.max(1, size * 0.008)}" fill="${CHAMPAGNE}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="${IVORY}"/>${inner}${rule}</svg>`;
}

// ---------- og-default.png ----------
function ogSvg(w = 1200, h = 630) {
  const parts = [`<rect width="${w}" height="${h}" fill="${IVORY}"/>`];
  // subtle frame
  parts.push(`<rect x="36" y="36" width="${w - 72}" height="${h - 72}" fill="none" stroke="${CHAMPAGNE}" stroke-opacity="0.45" stroke-width="1"/>`);
  const word = layoutText(cormorant, 'BONA', 176, 0.22);
  if (word) {
    const x = (w - word.width) / 2;
    const baseline = 320;
    parts.push(`<g transform="translate(${x.toFixed(2)} ${baseline})">${word.svg}</g>`);
  } else {
    parts.push(`<text x="50%" y="320" text-anchor="middle" font-family="Cormorant Garamond, Georgia, serif" font-weight="600" font-size="176" letter-spacing="38" fill="${INK}">BONA</text>`);
  }
  parts.push(`<rect x="${w / 2 - 60}" y="366" width="120" height="1.5" fill="${CHAMPAGNE}"/>`);
  const tag = layoutText(montserrat, 'PRIVATE LUXURY REAL ESTATE  ·  JEDDAH', 22, 0.28, '#3a3a38');
  if (tag) {
    parts.push(`<g transform="translate(${((w - tag.width) / 2).toFixed(2)} 428)">${tag.svg}</g>`);
  } else {
    parts.push(`<text x="50%" y="428" text-anchor="middle" font-family="Montserrat, Helvetica, Arial, sans-serif" font-size="22" letter-spacing="6" fill="#3a3a38">PRIVATE LUXURY REAL ESTATE · JEDDAH</text>`);
  }
  const ar = `<text x="50%" y="486" text-anchor="middle" direction="rtl" font-family="Amiri, IBM Plex Arabic, Noto Naskh Arabic, serif" font-size="30" fill="#3a3a38">${site.nameAr}</text>`;
  parts.push(ar);
  const url = layoutText(montserrat, (site.futureDomain || new URL(site.url).host).toLowerCase(), 18, 0.12, '#8a857c');
  if (url) parts.push(`<g transform="translate(${((w - url.width) / 2).toFixed(2)} 566)">${url.svg}</g>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join('')}</svg>`;
}

// ---------- ICO container (PNG entries) ----------
function buildIco(pngs /* [{size, buf}] */) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach((p, i) => {
    const o = i * 16;
    dir.writeUInt8(p.size >= 256 ? 0 : p.size, o); dir.writeUInt8(p.size >= 256 ? 0 : p.size, o + 1);
    dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(p.buf.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += p.buf.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.buf)]);
}

async function png(svg, size) {
  return sharp(Buffer.from(svg), { density: 300 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
}

// ---------- run ----------
fs.mkdirSync(pub, { recursive: true });
fs.writeFileSync(path.join(pub, 'favicon.svg'), monogramSvg(64));
const icoPngs = [];
for (const s of [16, 32, 48]) icoPngs.push({ size: s, buf: await png(monogramSvg(512, { rounded: false }), s) });
fs.writeFileSync(path.join(pub, 'favicon.ico'), buildIco(icoPngs));
fs.writeFileSync(path.join(pub, 'apple-touch-icon.png'), await png(monogramSvg(512, { rounded: false }), 180));
fs.writeFileSync(path.join(pub, 'icon-192.png'), await png(monogramSvg(512), 192));
fs.writeFileSync(path.join(pub, 'icon-512.png'), await png(monogramSvg(512), 512));
// maskable: letter kept inside the 80% safe zone → scale the monogram down on a full-bleed ivory square
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="${IVORY}"/><g transform="translate(76 76) scale(0.703)">${monogramSvg(512, { rounded: false }).replace(/^<svg[^>]*>|<\/svg>$/g, '').replace(/<rect[^>]*fill="#f5f1ea"\/>/, '')}</g></svg>`;
fs.writeFileSync(path.join(pub, 'icon-512-maskable.png'), await png(maskable, 512));
const og = await sharp(Buffer.from(ogSvg()), { density: 144 }).resize(1200, 630).png({ compressionLevel: 9 }).toBuffer();
fs.writeFileSync(path.join(pub, 'og-default.png'), og);

for (const f of outputs) console.log(`wrote public/${f} (${fs.statSync(path.join(pub, f)).size} B)`);
console.log(cormorant ? 'letterforms: Cormorant Garamond 600 outlines' : 'letterforms: fallback system serif (fontkitten unavailable)');
