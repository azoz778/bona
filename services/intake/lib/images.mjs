// Candidate images -> the files the site serves: public/listings/<slug>/NN.jpg (max 1920px,
// q82, metadata stripped) plus NN-thumb.webp (640px) for the card/rail.
// Names must match the validator's LOCAL regex: /^\/listings\/<slug>\/<[A-Za-z0-9-]+>\.(jpg|webp)$/
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export const MAX_SIDE = 1920;
export const THUMB_SIDE = 640;
export const JPEG_QUALITY = 82;

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
  for (const [i, pick] of picks.entries()) {
    const cand = byIndex.get(pick.index);
    if (!cand) continue;
    const n = i + 1;
    const base = pad(n);
    const file = path.join(outDir, `${base}.jpg`);
    const thumbFile = path.join(outDir, `${base}-thumb.webp`);
    const info = await sharp(cand.abs)
      .rotate()
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })  // sharp's 4:2:0 default: ~30% smaller, invisible on photos
      .toFile(file); // sharp drops EXIF/ICC unless withMetadata() is called
    await sharp(file)
      .resize({ width: THUMB_SIDE, height: THUMB_SIDE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 })
      .toFile(thumbFile);
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
  return out;
}

/** Remove a listing's whole image directory (used by `remove <id>`). */
export function removeListingImages(publicRoot, slug) {
  const dir = path.join(publicRoot, 'listings', slug);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}
