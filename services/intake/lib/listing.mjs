// Turn the AI contract + the written image files into a listing object that satisfies
// src/data/LISTING-SCHEMA.md, and manage the inbox (scripts/curate/inbox/).
import fs from 'node:fs';
import path from 'node:path';
import { ROOMS } from '../../../scripts/curate/rooms.mjs';
import { INTAKE_ID_RE, LOCAL_LISTING_SRC, LOCAL_LISTING_THUMB, videoEntryProblems } from '../../../scripts/curate/rules.mjs';

export const INBOX_DIR = path.join('scripts', 'curate', 'inbox');
export const INDEX_FILE = '_index.json';
export const RESERVED_SLUGS = new Set(['houses', 'apartments', 'land', 'buildings', 'for-sale', 'for-rent', 'off-plan', 'international', 'index']);

const AR_DIACRITICS = /[ً-ٰٟ]/g;

/** Lowercase-hyphenated, ASCII, <= 60 chars. Falls back to the district when the title is not Latin. */
export function slugify(...parts) {
  const raw = parts.filter(Boolean).join(' ');
  const s = raw
    .normalize('NFKD')
    .replace(AR_DIACRITICS, '')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[''`]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return s;
}

/** Make `base` unique against `taken`, appending -2, -3 … */
export function uniqueSlug(base, taken) {
  let slug = base || 'listing';
  if (RESERVED_SLUGS.has(slug)) slug = `${slug}-property`;
  if (!taken.has(slug)) return slug;
  for (let i = 2; i < 500; i += 1) {
    const next = `${slug}-${i}`;
    if (!taken.has(next)) return next;
  }
  return `${slug}-${Date.now()}`;
}

export function inboxPath(repo) { return path.join(repo, INBOX_DIR); }

export function readIndex(repo) {
  const file = path.join(inboxPath(repo), INDEX_FILE);
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { nextSeq: j.nextSeq ?? 1, listings: j.listings ?? {}, ...j };
  } catch {
    return { nextSeq: 1, listings: {} };
  }
}

export function writeIndex(repo, index) {
  const dir = inboxPath(repo);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`);
}

export function listInbox(repo) {
  const dir = inboxPath(repo);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== INDEX_FILE)
    .map((f) => {
      try { return { file: path.join(dir, f), listing: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }; } catch { return null; }
    })
    .filter(Boolean);
}

export function findInbox(repo, id) {
  return listInbox(repo).find((x) => String(x.listing.id).toUpperCase() === String(id).toUpperCase()) || null;
}

/** Every slug already in use, so a new listing never collides with the curated set. */
export function takenSlugs(repo) {
  const taken = new Set();
  try {
    for (const l of JSON.parse(fs.readFileSync(path.join(repo, 'src', 'data', 'listings.json'), 'utf8'))) taken.add(l.slug);
  } catch { /* not built yet */ }
  for (const { listing } of listInbox(repo)) taken.add(listing.slug);
  try {
    const src = fs.readFileSync(path.join(repo, 'scripts', 'curate', 'listings.source.mjs'), 'utf8');
    for (const m of src.matchAll(/slug:\s*'([^']+)'/g)) taken.add(m[1]);
  } catch { /* ignore */ }
  return taken;
}

/**
 * The listing a PDF already produced, found in the REPO rather than in the daemon's state
 * file. After a successful push the repo is the durable record: the state file can be lost,
 * rolled back or never have known (a `run-once.mjs` publish writes no state at all), and in
 * every one of those cases resending the brochure would otherwise mint a second listing.
 */
export function findByPdfSha(repo, sha) {
  if (!sha) return null;
  for (const { listing } of listInbox(repo)) {
    if (listing?._intake?.pdfSha256 === sha) return listing;
  }
  return null;
}

/** Every BONA-W id already present in the inbox. */
export function inboxIds(repo) {
  return listInbox(repo).map((x) => x.listing?.id).filter(Boolean);
}

/**
 * The next free id. `_index.json` is the counter, but it is a file in a repo that other
 * clones also push to: if a listing with a HIGHER number is already in the inbox (a pull
 * brought it in, or the counter was rolled back), that wins. Ids are never reused.
 */
export function nextListingId(index, existingIds = []) {
  const seqOf = (id) => {
    const m = /^BONA-W(\d{1,5})$/i.exec(String(id ?? ''));
    return m ? Number(m[1]) : 0;
  };
  const highest = existingIds.reduce((max, id) => Math.max(max, seqOf(id)), 0);
  const seq = Math.max(Number(index?.nextSeq) || 1, highest + 1);
  return `BONA-W${String(seq).padStart(3, '0')}`;
}

/** The counter value to store after `id` has been allocated. */
export function seqAfter(id) {
  const m = /^BONA-W(\d{1,5})$/i.exec(String(id ?? ''));
  return (m ? Number(m[1]) : 0) + 1;
}

/**
 * The ONLY values `_intake.warnings` may hold. The model's free-text `warnings` are never
 * committed — they are model output, they end up in a public repo, and nothing downstream
 * needs them; they stay in the run's ai.json instead.
 */
export const WARNING_CODES = new Set([
  'not-enough-photos',      // fewer publishable photographs than BONA_MIN_IMAGES (dry run only)
  'price-not-printed',      // the model's price was not in the PDF or the caption -> on request
  'brochure-too-large',     // the branded brochure is still over BONA_MAX_BROCHURE_MB after downsampling
  'brochure-failed',        // rebrand_pdf.py could not build the branded brochure at all
  'images-skipped',         // sharp could not decode one or more candidates
  'model-flagged',          // the model returned warnings; read them in the work dir's ai.json
  'photos-cropped',         // one or more photographs were cut out of a page that was one flattened picture
  'map-unconfirmed',        // the brochure links a map but no two links agreed on one point -> district only
]);

/**
 * Add a warning code to a listing that is already built. The brochure step runs AFTER
 * buildListing() — it needs the final, validated copy to print — so its warnings arrive
 * late. Same vocabulary rule as buildListing(): a code outside WARNING_CODES is dropped,
 * never written into a public repo.
 */
export function addWarningCode(listing, code) {
  if (!listing?._intake || !WARNING_CODES.has(code)) return listing;
  const warnings = new Set(listing._intake.warnings ?? []);
  warnings.add(code);
  listing._intake.warnings = [...warnings].filter((c) => WARNING_CODES.has(c));
  return listing;
}

const kindMap = (repo) => JSON.parse(fs.readFileSync(path.join(repo, 'src', 'data', 'kind-map.json'), 'utf8'));

/** yyyy-mm-dd in Riyadh, which is where the owner is. */
export function todayRiyadh(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function altFor(room, listing) {
  const r = ROOMS[room] || ROOMS.view;
  const base = { en: `${r.en} — ${listing.title.en}`, ar: `${r.ar} — ${listing.title.ar}` };
  if (listing.project && listing.unit) {
    return {
      en: `Illustrative — developer's finished unit at ${listing.project.name.en}: ${base.en}`,
      ar: `صورة توضيحية — وحدة منجزة من المطوّر في ${listing.project.name.ar}: ${base.ar}`,
    };
  }
  return base;
}

/**
 * Assemble the listing JSON written to scripts/curate/inbox/<slug>.json.
 * Intake-only fields live under `_intake` and in `hidden`; build.mjs strips both.
 */
export function buildListing({ ai, images, slug, id, repo, caption = {}, meta = {}, site, now = new Date() }) {
  const l = ai.listing;
  const kind = kindMap(repo)[l.type];
  if (!kind) throw new Error(`no kind mapping for type "${l.type}"`);

  const price = { ...l.price };
  if (caption.price) { price.amount = caption.price.amount; price.currency = caption.price.currency; price.onRequest = false; }
  if (caption.category) l.category = caption.category;
  if (l.category === 'rent') price.period = caption.period || price.period || 'year';
  else price.period = null;
  if (price.onRequest) price.amount = price.amount ?? null;
  price.from = Boolean(price.from);
  price.onRequest = Boolean(price.onRequest);

  const listing = {
    id,
    slug,
    sourceRef: meta.sourceRef ?? null,
    status: meta.status || 'available',
    category: l.category,
    type: l.type,
    kind,
    featured: false,
    title: l.title,
    location: l.location,
    price,
    specs: {
      beds: l.specs?.beds ?? null,
      baths: l.specs?.baths ?? null,
      areaSqm: l.specs?.areaSqm ?? null,
      plotSqm: l.specs?.plotSqm ?? null,
      yearBuilt: l.specs?.yearBuilt ?? null,
      floors: l.specs?.floors ?? null,
    },
    images: [],
    // Walkthrough clips added AFTER publish, one video message at a time — see `video <id>`
    // in edits.mjs. Always an array (never null) so a consumer can test .length like images,
    // and never populated here: a PDF never arrives with a video already attached to it.
    videos: [],
    description: { en: l.description.en.join('\n\n'), ar: l.description.ar.join('\n\n') },
    highlights: l.highlights,
    virtualTourUrl: null,
    brochureUrl: meta.brochureUrl ?? null,
    project: l.project ?? null,
    unit: l.unit ?? null,
    // Pin from the brochure's own Google Maps hyperlink (lib/geo.mjs), when two independent
    // links agreed on it. `mapPrecision` says how much to trust it: 'exact' is the pin the
    // developer published, 'district' a district centroid filled in later by the site
    // build. Null map => null precision; the site then shows the district text only.
    map: meta.map ?? null,
    mapPrecision: meta.map ? 'exact' : null,
    listedAt: meta.listedAt || todayRiyadh(now),
    hidden: Boolean(meta.hidden),
    _intake: {
      source: 'whatsapp',
      // Public repo: no WhatsApp identifiers, captions or file names — those live in the job/state records.
      pdfSha256: meta.pdfSha256 ?? null,
      model: meta.model ?? null,
      confidence: ai.confidence ?? null,
      // Codes only — never the model's free text (see WARNING_CODES).
      warnings: [...new Set(meta.warningCodes ?? [])].filter((c) => WARNING_CODES.has(c)),
      images: images.map((im) => ({ n: im.n, candidate: im.index, room: im.room })), // no model free text (reasons stay in the work dir)
      createdAt: new Date(now).toISOString(),
      site: site ?? null,
    },
  };
  listing.images = images.map((im) => ({ src: im.src, thumb: im.thumb, alt: altFor(im.room, listing) }));
  return listing;
}

/**
 * Local mirror of the rules in scripts/curate/validate.mjs, so a bad listing is refused
 * BEFORE anything is written and the owner gets a one-line WhatsApp reason instead of a
 * broken build.
 */
export function checkListing(listing, { minImages = 4, maxImages = 10 } = {}) {
  const e = [];
  const ARABIC = /[؀-ۿ]/;
  const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
  const isPair = (v) => v && isStr(v.en) && isStr(v.ar) && ARABIC.test(v.ar);
  if (!INTAKE_ID_RE.test(listing.id || '')) e.push(`id must match BONA-W### (got ${listing.id})`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(listing.slug || '')) e.push(`slug must be lowercase-hyphenated (got ${listing.slug})`);
  if (RESERVED_SLUGS.has(listing.slug)) e.push(`slug "${listing.slug}" collides with a section route`);
  if (!isPair(listing.title)) e.push('title.en/ar required');
  if (!Array.isArray(listing.images) || listing.images.length < minImages) {
    e.push(`not enough usable photos (${listing.images?.length ?? 0} of ${minImages} needed)`);
  } else if (listing.images.length > maxImages) e.push(`too many photos (${listing.images.length} > ${maxImages})`);
  for (const [i, im] of (listing.images || []).entries()) {
    // The SAME regexes the site validator uses (scripts/curate/rules.mjs), not a copy.
    if (!LOCAL_LISTING_SRC.test(im.src || '')) e.push(`images[${i}].src is not /listings/<slug>/<nn>.jpg`);
    if (!(im.thumb === null || LOCAL_LISTING_THUMB.test(im.thumb || ''))) e.push(`images[${i}].thumb is not /listings/<slug>/<nn>-thumb.webp`);
    if (!isPair(im.alt)) e.push(`images[${i}].alt.en/ar required`);
  }
  if (!listing.price?.onRequest && !(typeof listing.price?.amount === 'number' && listing.price.amount > 0)) {
    e.push('price.amount must be > 0 unless onRequest');
  }
  // Optional, like project/unit/map — but when present every entry is `{ src, poster }` in
  // the same site-local shapes the site validator demands (scripts/curate/rules.mjs), so a
  // listing this accepts can never fail the build afterwards.
  if (listing.videos !== undefined) {
    if (!Array.isArray(listing.videos)) e.push('videos must be an array when present');
    else for (const [i, v] of listing.videos.entries()) e.push(...videoEntryProblems(v, i));
  }
  if (!isStr(listing.description?.en) || !isStr(listing.description?.ar)) e.push('description.en/ar required');
  else {
    if (listing.description.en.split(/\n\n+/).length < 2) e.push('description.en needs at least 2 paragraphs');
    if (listing.description.ar.split(/\n\n+/).length < 2) e.push('description.ar needs at least 2 paragraphs');
  }
  for (const lang of ['en', 'ar']) {
    const h = listing.highlights?.[lang];
    if (!Array.isArray(h) || h.length < 4 || h.length > 6) e.push(`highlights.${lang} needs 4–6 items`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(listing.listedAt || '')) e.push(`bad listedAt ${listing.listedAt}`);
  return e;
}

export function writeInboxListing(repo, listing) {
  const dir = inboxPath(repo);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${listing.slug}.json`);
  fs.writeFileSync(file, `${JSON.stringify(listing, null, 2)}\n`);
  return file;
}

/** Pick the images to publish from the model's ranking. */
export function orderedPicks(aiImages, { maxImages = 10 } = {}) {
  return (aiImages || [])
    .filter((im) => im && !im.exclude && Number.isInteger(im.index))
    .map((im) => ({ ...im, rank: Number.isFinite(im.rank) ? im.rank : 99 }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, maxImages)
    .map((im, i) => ({ index: im.index, room: ROOMS[im.room] ? im.room : 'view', rank: i + 1, reason: im.reason ?? null }));
}
