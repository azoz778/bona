#!/usr/bin/env node
// One listing -> a 4-6 slide bilingual carousel, 1080x1350 (Instagram 4:5) or 1080x1080.
//
//   node scripts/social/make-carousel.mjs --listing BONA-001
//   node scripts/social/make-carousel.mjs --listing BONA-W003 --slides 5 --square
//
// Shape: hook slide, then one slide per real feature, then a details slide carrying the
// printed price, then the CTA slide. Every slide is bilingual — Arabic leads, English sits
// beneath it — and every word on them comes out of listings.json. Nothing is written here
// that the listing does not already say.
import './lib/fonts.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { C, PORTRAIT, SQUARE, centred, fitText, rule, sharp, text } from './lib/brand.mjs';
import { canvas, captionBand, ctaCard, flatten, lowerThird, markLayer } from './lib/cards.mjs';
import { bestPhotos, cover } from './lib/photos.mjs';
import { hookFor, loadListings, subhookFor, t } from './lib/listing.mjs';
import { OUT_ROOT, ensureDir, findListing, log, savePair } from './lib/util.mjs';

const { values: a } = parseArgs({
  options: {
    listing: { type: 'string' }, slides: { type: 'string', default: '6' },
    square: { type: 'boolean', default: false }, out: { type: 'string' },
    centre: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  },
});
if (a.help || !a.listing) {
  console.log('usage: make-carousel.mjs --listing <ID|slug> [--slides 4..6] [--square] [--out <dir>] [--centre]');
  process.exit(a.help ? 0 : 1);
}

const { w: W, h: H } = a.square ? SQUARE : PORTRAIT;
const slideCount = Math.min(6, Math.max(4, parseInt(a.slides, 10) || 6));
const position = a.centre ? 'centre' : 'attention';
// 4:5 has no platform chrome to dodge — a carousel is a still image in the feed.
const BOTTOM = Math.round(H * 0.075);

const l = findListing(loadListings(), a.listing);

/**
 * The features a slide can talk about, in preference order:
 *   1. the listing's own `highlights` (owner-written, AR + EN, already paired)
 *   2. the photograph's `alt` text, which names the room ("Swimming pool — …")
 * Anything else would be invention.
 */
function features(photos) {
  const out = [];
  const hiAr = l.highlights?.ar ?? [];
  const hiEn = l.highlights?.en ?? [];
  for (let i = 0; i < Math.min(hiAr.length, hiEn.length); i++) out.push({ ar: hiAr[i], en: hiEn[i], from: 'highlight' });
  for (const p of photos) {
    const ar = t(p.image?.alt, 'ar');
    const en = t(p.image?.alt, 'en');
    // alt text is "<room> — <listing title>"; the room alone is the interesting half.
    const room = (s) => String(s).split('—')[0].trim();
    if (ar && en) out.push({ ar: room(ar), en: room(en), from: 'alt' });
  }
  return out.filter((f, i, arr) => f.ar && f.en && arr.findIndex((x) => x.ar === f.ar) === i);
}

const featureSlides = slideCount - 3; // hook + details + CTA are fixed
const photos = await bestPhotos(l, 1 + featureSlides + 1);
if (photos.length < 2) {
  console.error(`${l.id}: only ${photos.length} usable photograph(s) — a carousel needs at least 2. Skipping.`);
  process.exit(2);
}
const feats = features(photos.slice(1));
const hook = hookFor(l);
const sub = subhookFor(l);

const outDir = a.out ? path.resolve(a.out) : path.join(OUT_ROOT, 'carousels', l.id);
ensureDir(outDir);
const written = [];
const save = async (n, buf) => {
  const f = path.join(outDir, `${String(n).padStart(2, '0')}.png`);
  const { png } = await savePair(f, buf, sharp);
  written.push(png);
  return png;
};

// ---- 1. hook slide ------------------------------------------------------------------
{
  const photo = await cover(photos[0].file, W, H, { position });
  const layers = [await markLayer(W, H, { size: 36, top: Math.round(H * 0.055) })];
  layers.push(await captionBand(W, H, {
    eyebrow: null, ar: hook.ar, en: sub.en, bottom: BOTTOM + 64, arSize: 64, enSize: 30,
  }));
  const swipe = await text({ text: 'اسحب  ←', face: 'ar-body', size: 26, color: 'rgba(245,241,234,0.85)', letterSpacing: 1 });
  layers.push(await canvas(W, H).composite([centred(swipe, W, H - BOTTOM - 6)]).png().toBuffer());
  await save(1, await flatten(photo, layers, { w: W, h: H }));
}

// ---- 2..n. feature slides ------------------------------------------------------------
for (let i = 0; i < featureSlides; i++) {
  const p = photos[Math.min(i + 1, photos.length - 1)];
  const f = feats[i % Math.max(1, feats.length)] ?? { ar: t(l.title, 'ar'), en: t(l.title, 'en') };
  const photo = await cover(p.file, W, H, { position });
  const layers = [await markLayer(W, H, { size: 30, top: Math.round(H * 0.05) })];
  layers.push(await captionBand(W, H, {
    eyebrow: `${i + 1} / ${featureSlides}`, ar: f.ar, en: f.en, bottom: BOTTOM, arSize: 56, enSize: 28,
  }));
  await save(i + 2, await flatten(photo, layers, { w: W, h: H }));
}

// ---- n+1. details slide (the printed price, never a computed one) ---------------------
{
  const p = photos[Math.min(featureSlides + 1, photos.length - 1)];
  const photo = await cover(p.file, W, H, { position });
  const layers = [await markLayer(W, H, { size: 30, top: Math.round(H * 0.05) })];
  layers.push(await lowerThird(W, H, l, { bottom: BOTTOM, right: 90 }));
  await save(slideCount - 1, await flatten(photo, layers, { w: W, h: H }));
}

// ---- last. CTA -----------------------------------------------------------------------
await save(slideCount, await ctaCard(W, H, { l }));

log(`carousel → ${outDir}  (${written.length} slides, ${W}x${H})`);
for (const f of written) console.log(f);
