// Derived media for the daily property register (owner, 2026-10-21): padded 4:5 frames. Rendered
// once, at approval (scripts/social/approve-property-review.mjs), written under
// public/social/property/<id>/ and served by the site like the reviewed daily pack's cards, because
// Instagram fetches every carousel image from a public URL (publish.mjs uploads nothing). The
// review records each file's SHA-256; the publishers download the hosted copy and check it, so
// nothing here runs at publication time.
import './fonts.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { C, centred, sharp, wordmark } from './brand.mjs';
import { MEDIA_SIZE, PAD_FIT, mediaBase, sha256 } from './property-daily.mjs';
import { trimUniformBorder } from './photos.mjs';

const { width: W, height: H } = MEDIA_SIZE;
/** The band under a padded photo that carries the BONA mark. */
export const PAD_BAND = 120;
export const PAD_BACKGROUND = C.ink;
export const jpeg = img => img.jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();

/** The small BONA mark centred in a band, as on the reels and the LinkedIn re-encodes. */
async function bandMark(top, { color = C.ivory, band = PAD_BAND } = {}) {
  const mark = await wordmark({ size: 30, color, arabic: false });
  return centred(mark, W, top + Math.round((band - mark.height) / 2));
}

/**
 * A frame padded to 4:5: the photo whole and centred (never cropped, never stretched) in the
 * 1080x1230 area above a 120 px band, on the brand ink, with the small BONA mark in the band.
 * Deterministic: the same source bytes give the same JPEG bytes.
 */
export async function padFrame(source) {
  const boxH = H - PAD_BAND;
  // A brochure photo's baked-in white margin is trimmed first (the reels' own guarded trim: a border, never a crop).
  const photo = await sharp(await trimUniformBorder(source)).rotate().resize({ width: W, height: boxH, fit: 'inside', withoutEnlargement: false }).toBuffer({ resolveWithObject: true });
  const { width: pw, height: ph } = photo.info;
  const layers = [
    { input: photo.data, left: Math.round((W - pw) / 2), top: Math.round((boxH - ph) / 2) },
    await bandMark(boxH),
  ];
  return jpeg(sharp({ create: { width: W, height: H, channels: 3, background: PAD_BACKGROUND } }).composite(layers));
}

// --------------------------------------------------------------------------------------- hosting
/** Where a derived file lives in the repository and on the site: content-addressed, so a changed render never reuses a URL. */
export function mediaTarget(root, id, name, bytes) {
  const file = `${name}-${sha256(bytes).slice(0, 12)}.jpg`;
  return { file: path.join(root, 'public', 'social', 'property', id, file), url: `${mediaBase(id)}${file}` };
}
/** Writes a derived JPEG under public/social/property/<id>/ and returns its media record. */
export async function writeMedia(root, id, name, bytes) {
  const meta = await sharp(bytes).metadata();
  if (meta.format !== 'jpeg' || meta.width !== W || meta.height !== H) throw new Error(`${id}: derived ${name} is not a ${W}x${H} JPEG`);
  const t = mediaTarget(root, id, name, bytes);
  fs.mkdirSync(path.dirname(t.file), { recursive: true });
  fs.writeFileSync(t.file, bytes);
  return { url: t.url, sha256: sha256(bytes), width: W, height: H, file: t.file };
}
export { PAD_FIT };
