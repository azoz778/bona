// Candidate images -> the files the site serves: public/listings/<slug>/NN.jpg (max 1920px,
// q82, metadata stripped) plus NN-thumb.webp (640px) for the card/rail.
// Names must match the validator's LOCAL regex: /^\/listings\/<slug>\/<[A-Za-z0-9-]+>\.(jpg|webp)$/
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export const MAX_SIDE = 1920;
export const THUMB_SIDE = 640;
export const JPEG_QUALITY = 82;
// Decompression-bomb cap, matching MAX_PIXELS in extract_pdf.py. sharp's own default is
// ~268 MP, which is enough to exhaust this box's RAM from a hostile PDF.
export const MAX_INPUT_PIXELS = 50_000_000;

const pad = (n) => String(n).padStart(2, '0');

/**
 * @param {Array<{index:number,abs:string}>} candidates    every extracted candidate
 * @param {Array<{index:number,room:string,rank:number}>} picks  kept images, already ordered
 * @param {string} outDir  public/listings/<slug>
 * @returns {Promise<Array<{n:number,index:number,room:string,src:string,thumb:string,file:string,thumbFile:string,width:number,height:number}>>}
 */
export async function writeListingImages(candidates, picks, outDir, slug) {
  const byIndex = new Map(candidates.map((c) => [c.index, c]));
  fs.mkdirSync(outDir, { recursive: true });
  const out = [];
  const skipped = [];
  let n = 0;
  for (const pick of picks) {
    const cand = byIndex.get(pick.index);
    if (!cand) continue;
    const base = pad(n + 1);
    const file = path.join(outDir, `${base}.jpg`);
    const thumbFile = path.join(outDir, `${base}-thumb.webp`);
    let info;
    try {
      // A candidate that sharp cannot decode (truncated, hostile, or over the pixel cap)
      // is SKIPPED, not fatal: the listing is still publishable if enough others survive,
      // and checkListing() refuses it when they do not.
      info = await sharp(cand.abs, { limitInputPixels: MAX_INPUT_PIXELS })
        .rotate()
        .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })  // sharp's 4:2:0 default: ~30% smaller, invisible on photos
        .toFile(file); // sharp drops EXIF/ICC unless withMetadata() is called
      await sharp(file, { limitInputPixels: MAX_INPUT_PIXELS })
        .resize({ width: THUMB_SIDE, height: THUMB_SIDE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 78 })
        .toFile(thumbFile);
    } catch (err) {
      fs.rmSync(file, { force: true });
      fs.rmSync(thumbFile, { force: true });
      skipped.push({ index: pick.index, error: err.message });
      continue;
    }
    n += 1;
    out.push({
      n,
      index: pick.index,
      room: pick.room,
      reason: pick.reason ?? null,
      focus: pick.focus ?? null,
      file,
      thumbFile,
      src: `/listings/${slug}/${base}.jpg`,
      thumb: `/listings/${slug}/${base}-thumb.webp`,
      width: info.width,
      height: info.height,
    });
  }
  out.skipped = skipped;
  return out;
}

// Floor plans: line drawings, published beside the photos as plan-NN.jpg (NN = the model's 1-based
// position in `models`) + plan-NN-thumb.webp — the shapes LOCAL_PLAN_SRC / LOCAL_PLAN_THUMB in
// scripts/curate/rules.mjs accept. A plan never enters the gallery: the ranking excluded it.
export const PLAN_SIDE = 1600;
export const PLAN_THUMB_SIDE = 480;
export const PLAN_JPEG_QUALITY = 85;

/**
 * Where each model's floor plan goes, without touching a file: one entry per model whose `floorPlan`
 * is a candidate index, in model order. `cand` is undefined when no candidate has that index. The dry
 * run previews these paths; writeFloorPlans() writes them.
 * @returns {Array<{model:number,index:number,cand:object|undefined,base:string,src:string,thumb:string}>}
 */
export function floorPlanTargets(candidates, models, slug) {
  const byIndex = new Map((candidates || []).map((c) => [c.index, c]));
  return (Array.isArray(models) ? models : []).flatMap((m, i) => {
    if (!Number.isInteger(m?.floorPlan)) return [];
    const base = `plan-${pad(i + 1)}`;
    return [{ model: i, index: m.floorPlan, cand: byIndex.get(m.floorPlan), base, src: `/listings/${slug}/${base}.jpg`, thumb: `/listings/${slug}/${base}-thumb.webp` }];
  });
}

/**
 * Write every model's floor plan into `outDir` (the staging dir, promoted with the photos): flattened
 * onto white (a transparent plan would otherwise turn black in a JPEG), inside PLAN_SIDE without
 * enlarging, JPEG q85; thumbnail inside PLAN_THUMB_SIDE, WebP q78. A candidate sharp cannot decode
 * (truncated, hostile, over the pixel cap) or that does not exist is skipped, never fatal: that model
 * publishes without a plan. The array carries `.skipped` ({ model, index, error }) for the caller to log.
 * @returns {Promise<Array<{model:number,index:number,src:string,thumb:string,file:string,thumbFile:string}>>}
 */
export async function writeFloorPlans(candidates, models, outDir, slug) {
  const out = [];
  const skipped = [];
  for (const t of floorPlanTargets(candidates, models, slug)) {
    if (!t.cand) { skipped.push({ model: t.model, index: t.index, error: `no candidate #${t.index}` }); continue; }
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${t.base}.jpg`);
    const thumbFile = path.join(outDir, `${t.base}-thumb.webp`);
    try {
      await sharp(t.cand.abs, { limitInputPixels: MAX_INPUT_PIXELS })
        .rotate()
        .flatten({ background: '#ffffff' })
        .resize({ width: PLAN_SIDE, height: PLAN_SIDE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: PLAN_JPEG_QUALITY, mozjpeg: true })
        .toFile(file);
      await sharp(file, { limitInputPixels: MAX_INPUT_PIXELS })
        .resize({ width: PLAN_THUMB_SIDE, height: PLAN_THUMB_SIDE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 78 })
        .toFile(thumbFile);
    } catch (err) {
      fs.rmSync(file, { force: true });
      fs.rmSync(thumbFile, { force: true });
      skipped.push({ model: t.model, index: t.index, error: err.message });
      continue;
    }
    out.push({ model: t.model, index: t.index, src: t.src, thumb: t.thumb, file, thumbFile });
  }
  out.skipped = skipped;
  return out;
}

/** Remove a listing's whole image directory (used by `remove <id>`). */
export function removeListingImages(publicRoot, slug) {
  const dir = path.join(publicRoot, 'listings', slug);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}
