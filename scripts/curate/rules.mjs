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

// ---- withholding listings from the public site --------------------------------------
// Two separate owner rules, deliberately not merged:
//   land   — a SAR 50,000,000 cap (2026-09-06, in build.mjs): exact plot locations are
//            gated in TK's register, so the cap stands as a standing rule.
//   houses — a NAMED LIST (below): specific homes the owner took down, one decision each.
// A withheld listing is excluded ENTIRELY by scripts/curate/build.mjs — it gets no
// listings.json entry, so no page, card, sitemap entry or OG image can leak it. Enquiries
// are how those homes are shared.

/** Approximate SAR rates, for comparing prices against a cap. Mirrors src/lib/listings.ts. */
export const SAR_RATE = { SAR: 1, AED: 1.02, USD: 3.75, EUR: 4.05, GBP: 4.75, OMR: 9.75 };

/**
 * A listing's asking price in SAR, or null when there is no number to compare.
 *
 * Null is the important case: a price of "on request" is unknown, not cheap and not dear.
 * Every caller must decide for itself what to do with an unknown, and none may treat it as
 * zero. Monthly rents are annualised so a cap means the same thing for them.
 */
export function sarAmount(price) {
  // `onRequest` is the owner's word that no price is published. A number may still sit in
  // `amount` beside it — buildListing's `price.amount = price.amount ?? null` never clears
  // one — but it is not a price we may act on, so the answer is "unknown", not that figure.
  if (price?.onRequest) return null;
  const amount = price?.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null;
  const rate = SAR_RATE[price.currency];
  // Never fall back to 1: treating an unknown currency as SAR would under-count a price by
  // up to ~12x and publish a home the cap exists to hide. Fail loudly instead.
  if (!rate) throw new Error(`sarAmount: unknown currency "${price.currency}" (known: ${Object.keys(SAR_RATE).join(', ')})`);
  const annual = price.period === 'month' ? amount * 12 : amount;
  return annual * rate;
}

/**
 * Listings the owner has taken off the public site. Shared on enquiry instead.
 *
 * This began (2026-09-08) as a price cap — houses over SAR 10,000,000 — but the owner's
 * intent was to take these two homes down ONCE, not to install a standing rule. Corrected
 * the same day. A permanent cap is the wrong instrument for a luxury brand: it would
 * silently suppress the most valuable stock forever, including any brochure the WhatsApp
 * intake publishes months from now, and the reason would be long forgotten by then. Naming
 * the listings keeps each decision explicit, reversible, and visible in review.
 *
 * To publish one again, delete its id here.
 *
 * To withhold another, it matters where the listing came from. A curated BONA-### is TK
 * stock and owns nothing in this repo, so naming it here is the whole takedown. A BONA-W###
 * came from the WhatsApp intake, which committed its photos and brochure.pdf under
 * public/listings/<slug>/ — paths GitHub Pages serves directly — so naming it here would
 * hide the page and leave the brochure downloadable. Send `remove BONA-W###` in the group
 * instead; that deletes the files. build.mjs refuses to build if the two are confused.
 */
export const WITHHELD_LISTINGS = new Set(['BONA-002', 'BONA-028']);

/** May this listing be published on the public site? */
export function isPublishable(l) {
  return !WITHHELD_LISTINGS.has(l?.id);
}
