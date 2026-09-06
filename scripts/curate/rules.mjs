// Validation rules shared by the site validator (scripts/curate/validate.mjs), the site
// builder and the WhatsApp intake (services/intake/lib/{claude,listing}.mjs). One
// definition, so a listing the intake accepts can never fail the build afterwards.

/** Words the house voice never uses. */
export const HYPE_WORDS = ['amazing', 'stunning', 'breathtaking', 'unparalleled', "don't miss", 'dream home'];
export const HYPE = new RegExp(`\\b(${HYPE_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');

/**
 * Any telephone number: Saudi mobile in international form (+9665…), Saudi local (05…),
 * or any international number (+<country code>…). Listings carry no contact details — the
 * site renders those itself — so a number in the copy is always a leak from someone else's
 * brochure.
 */
export const PHONE_RE = /(?:\+?966[\s.-]?5\d(?:[\s.-]?\d){7}|(?<![\d+])0[\s.-]?5(?:[\s.-]?\d){8}(?!\d)|\+\d{1,3}[\s.-]?\d(?:[\s.-]?\d){6,13})/;

/** The old brand, other agencies, and contact details. */
export const FORBIDDEN = [/\bTK\b/i, /tk[- ]?estates?/i, /tk-estates\.com/i, PHONE_RE];

// ---- identifiers ---------------------------------------------------------------------
// BONA-### is a curated listing (positional, from listings.source.mjs); BONA-W### is one
// published from WhatsApp (counter in scripts/curate/inbox/_index.json). Up to 5 digits so
// the intake counter has somewhere to go.
export const LISTING_ID_RE = /^(BONA-\d{3}|BONA-W\d{3,5})$/;
export const INTAKE_ID_RE = /^BONA-W\d{3,5}$/;

// ---- site-local image paths ------------------------------------------------------------
// Exactly two shapes are served straight out of public/, and nothing else:
//   /land/<PLOT>.jpg                     land satellite stills (scripts/land-stills.mjs)
//   /listings/<slug>/<nn>.jpg            WhatsApp-intake photos (services/intake)
//   /listings/<slug>/<nn>-thumb.webp     …and their thumbnails
// Consumers must not prefix these with a CDN host.
export const LOCAL_LAND_STILL = /^\/land\/[A-Za-z0-9-]+\.jpg$/;
export const LOCAL_LISTING_SRC = /^\/listings\/[a-z0-9]+(?:-[a-z0-9]+)*\/\d{2,3}\.jpg$/;
export const LOCAL_LISTING_THUMB = /^\/listings\/[a-z0-9]+(?:-[a-z0-9]+)*\/\d{2,3}-thumb\.webp$/;
// /listings/<slug>/v-<nn>.mp4          walkthrough videos added post-publish (services/intake,
// /listings/<slug>/v-<nn>-poster.jpg    lib/video.mjs) and the poster frame ffmpeg cut out of
// each one. A separate `v-` prefix from the photos' <nn>.jpg so the two numbering tracks can
// never collide.
export const LOCAL_LISTING_VIDEO = /^\/listings\/[a-z0-9]+(?:-[a-z0-9]+)*\/v-\d{2,3}\.mp4$/;
export const LOCAL_LISTING_VIDEO_POSTER = /^\/listings\/[a-z0-9]+(?:-[a-z0-9]+)*\/v-\d{2,3}-poster\.jpg$/;

/**
 * One entry of `videos[]`: `{ src, poster }`. `src` is a site-local clip or a full https URL
 * (for a future non-intake source); `poster` is the site-local poster frame beside it, an
 * https URL, or null when ffmpeg could not cut one (the page then falls back to the hero
 * photo). ONE definition, shared by scripts/curate/validate.mjs and the intake's own
 * checkListing(), so the intake can never write something the site build then rejects.
 * @returns {string[]} problems (empty = good)
 */
export function videoEntryProblems(v, i) {
  const e = [];
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return [`videos[${i}] must be { src, poster } — a bare string is the pre-2026-09-06 shape`];
  }
  if (!(LOCAL_LISTING_VIDEO.test(v.src ?? '') || /^https:\/\//.test(v.src ?? ''))) {
    e.push(`videos[${i}].src is not /listings/<slug>/v-nn.mp4 or an https URL: ${v.src}`);
  }
  if (!(v.poster === null || v.poster === undefined
        || LOCAL_LISTING_VIDEO_POSTER.test(v.poster) || /^https:\/\//.test(v.poster))) {
    e.push(`videos[${i}].poster must be null, /listings/<slug>/v-nn-poster.jpg or an https URL: ${v.poster}`);
  }
  return e;
}
export const isLocalSrc = (s) => LOCAL_LAND_STILL.test(s) || LOCAL_LISTING_SRC.test(s);
