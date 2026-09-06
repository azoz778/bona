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

/** Remove a listing's whole image directory (used by `remove <id>`). */
export function removeListingImages(publicRoot, slug) {
  const dir = path.join(publicRoot, 'listings', slug);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}
