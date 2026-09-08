// Small shared bits: where output goes, how a listing is looked up, logging.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './fonts.mjs';

/** Everything these scripts render lands under marketing/queue/ (media is gitignored). */
export const OUT_ROOT = process.env.BONA_SOCIAL_OUT || path.join(REPO_ROOT, 'marketing', 'queue');

export const ensureDir = (d) => { fs.mkdirSync(d, { recursive: true }); return d; };

/** Path relative to the repo root — what goes in queue.json, so the file is portable. */
export const relToRepo = (p) => path.relative(REPO_ROOT, path.resolve(p)).split(path.sep).join('/');

export function log(...args) {
  if (process.env.BONA_SOCIAL_QUIET === '1') return;
  process.stderr.write(`[social] ${args.join(' ')}\n`);
}

/** Look a listing up by id (BONA-001 / BONA-W003), slug, or a unique slug fragment. */
export function findListing(listings, ref) {
  if (!ref) throw new Error('no listing given (--listing BONA-001)');
  const key = String(ref).trim();
  const byId = listings.find((l) => l.id.toLowerCase() === key.toLowerCase());
  if (byId) return byId;
  const bySlug = listings.find((l) => l.slug === key);
  if (bySlug) return bySlug;
  const fuzzy = listings.filter((l) => l.slug.includes(key.toLowerCase()));
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) throw new Error(`"${ref}" matches ${fuzzy.length} listings: ${fuzzy.map((l) => l.id).join(', ')}`);
  throw new Error(`no listing "${ref}"`);
}

/** ffmpeg/ffprobe, the same static build services/intake uses (services/intake/lib/env.mjs). */
export const FFMPEG = process.env.BONA_FFMPEG_BIN || path.join(process.env.HOME || '', '.local/bin/ffmpeg');
export const FFPROBE = process.env.BONA_FFPROBE_BIN || path.join(process.env.HOME || '', '.local/bin/ffprobe');

export function requireFfmpeg() {
  if (!fs.existsSync(FFMPEG)) {
    throw new Error(`ffmpeg not found at ${FFMPEG} — set BONA_FFMPEG_BIN (services/intake uses the same static build).`);
  }
  return FFMPEG;
}

/**
 * Write a PNG and a JPEG twin beside it.
 *
 * PNG is the master (crisp type). The JPEG exists because Instagram's Graph API rejects
 * PNG outright — `scripts/instagram-post.mjs` checks for it — and several other publish
 * paths prefer JPEG too. queue.json carries both paths so the publisher picks.
 */
export async function savePair(pngPath, buf, sharp, { quality = 94 } = {}) {
  const fsx = await import('node:fs');
  const pathx = await import('node:path');
  fsx.mkdirSync(pathx.dirname(pngPath), { recursive: true });
  const jpg = pngPath.replace(/\.png$/i, '.jpg');
  // Write both to .part and rename, so a killed run never leaves a half-written file that a
  // later `--render` mistakes for a finished asset. (This is how four unplayable reels
  // survived a re-render on the first batch.)
  const pngPart = `${pngPath}.part`;
  const jpgPart = `${jpg}.part`;
  try {
    fsx.writeFileSync(pngPart, buf);
    await sharp(buf).flatten({ background: '#0f1214' }).jpeg({ quality, mozjpeg: true }).toFile(jpgPart);
    fsx.renameSync(pngPart, pngPath);
    fsx.renameSync(jpgPart, jpg);
  } finally {
    fsx.rmSync(pngPart, { force: true });
    fsx.rmSync(jpgPart, { force: true });
  }
  return { png: pngPath, jpg };
}
