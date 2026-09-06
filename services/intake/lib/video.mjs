// Video attachments for a listing. Stored EXACTLY as WhatsApp sent them — no transcoding, no
// thumbnail: sharp (this service's only media library, see images.mjs) does not read video,
// and pulling in ffmpeg for one narrow feature is exactly the "materially larger
// architecture change" this fix is deliberately not making. See services/intake/README.md
// for the follow-up this leaves open (repo size; a real CDN upload path).
//
// Numbered on their OWN sequence, separate from the photos (`NN.jpg`), so adding or removing
// a video never renumbers or collides with a listing's photos:
//   public/listings/<slug>/v-NN.mp4
import fs from 'node:fs';
import path from 'node:path';

/** A listing may carry at most this many videos — plenty for a walkthrough + a few room clips. */
export const MAX_VIDEOS = 4;

const pad = (n) => String(n).padStart(2, '0');

/** The site-local path a video is served from — the same shape checkListing()/validate.mjs expect. */
export const videoSrcFor = (slug, n) => `/listings/${slug}/v-${pad(n)}.mp4`;

/**
 * Write ONE video buffer into public/listings/<slug>/, next in line after whatever the
 * listing already has.
 * @param {Buffer} buffer            the downloaded video, unmodified
 * @param {string} outDir            public/listings/<slug>
 * @param {string} slug
 * @param {number} existingCount     listing.videos?.length ?? 0 — the caller already knows this
 * @returns {{n:number, src:string, file:string, bytes:number}}
 */
export function writeListingVideo(buffer, outDir, slug, existingCount = 0) {
  if (existingCount >= MAX_VIDEOS) {
    throw new Error(`a listing may carry at most ${MAX_VIDEOS} videos`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const n = existingCount + 1;
  const file = path.join(outDir, `v-${pad(n)}.mp4`);
  fs.writeFileSync(file, buffer);
  return { n, src: videoSrcFor(slug, n), file, bytes: buffer.length };
}
