// Turn the AI contract + the written image files into a listing object that satisfies
// src/data/LISTING-SCHEMA.md, and manage the inbox (scripts/curate/inbox/).
import fs from 'node:fs';
import path from 'node:path';
import { ROOMS } from '../../../scripts/curate/rooms.mjs';
import {
  FACT_LISTS, headlineFollowsModels, imageFocusProblems, INTAKE_ID_RE, isImageFocus as isFocus, isPublishable, licenceProblems, loadRegisterWithdrawals,
  LOCAL_LISTING_SRC, LOCAL_LISTING_THUMB, modelsProblems, subsidisedPriceProblems, videoEntryProblems, withdrawnAdvertising, withdrawnNotice,
} from '../../../scripts/curate/rules.mjs';
import { isFigure } from './model-prices.mjs';

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
  'subsidised-price-not-printed', // the model's Sakani price could not be confirmed -> regular price only
  'model-price-not-printed', // a unit model's price was not confirmed on its page -> that model shows no price
  'brochure-too-large',     // the brochure is still over BONA_MAX_BROCHURE_MB with its images scaled down
  'brochure-failed',        // brochure_pdf.py could not build the brochure at all
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

const copyPair = (v) => (v && typeof v === 'object' ? { en: v.en, ar: v.ar } : null);
const copyList = (v) => ({ en: [...v.en], ar: [...v.ar] });
const hasItems = (v) => Boolean(v) && Array.isArray(v.en) && Array.isArray(v.ar) && (v.en.length > 0 || v.ar.length > 0);

/**
 * The unit models as the site publishes them: only the fields validateAiResult() checked, copied
 * (never the AI's objects themselves), the floor plan as the `{ src, thumb }` writeFloorPlans() wrote
 * for that model position or null. Never the model's `evidence` (an internal citation) and never the
 * candidate index in `floorPlan`. Prices are copied as the price step left them (under the owner's
 * caption price it has already nulled them); a rental keeps no Sakani price, as on the headline.
 */
function publicModels(aiModels, floorPlans, { rent }) {
  const plans = new Map((Array.isArray(floorPlans) ? floorPlans : [])
    .filter((p) => Number.isInteger(p?.model)).map((p) => [p.model, { src: p.src, thumb: p.thumb }]));
  return (Array.isArray(aiModels) ? aiModels : []).flatMap((m, i) => {
    if (!m || typeof m !== 'object') return [];
    const price = isFigure(m.price) ? m.price : null;
    return [{
      name: copyPair(m.name),
      bedrooms: m.bedrooms ?? null,
      bathrooms: m.bathrooms ?? null,
      areaSqm: m.areaSqm ?? null,
      rooms: hasItems(m.rooms) ? copyList(m.rooms) : null,
      availability: copyPair(m.availability),
      price,
      subsidisedPrice: !rent && price !== null && isFigure(m.subsidisedPrice) && m.subsidisedPrice < price ? m.subsidisedPrice : null,
      floorPlan: plans.get(i) ?? null,
    }];
  });
}

/**
 * The unit models and the fact lists (amenities / nearby / warranties) a brochure reading publishes,
 * each left out when empty — the part of buildListing() that `run-once --enrich` adds to a listing
 * that is already live. `rent` = the listing is a rental (its models keep no Sakani price).
 */
export function modelsAndFacts(ai, floorPlans, { rent = false } = {}) {
  const models = publicModels(ai?.models, floorPlans, { rent });
  const facts = Object.fromEntries(Object.keys(FACT_LISTS).filter((k) => hasItems(ai?.[k])).map((k) => [k, copyList(ai[k])]));
  return { ...(models.length ? { models } : {}), ...facts };
}

/**
 * Assemble the listing JSON written to scripts/curate/inbox/<slug>.json.
 * Intake-only fields live under `_intake` and in `hidden`; build.mjs strips both.
 * `floorPlans` = writeFloorPlans()'s result (or, on a dry run, floorPlanTargets()'s paths):
 * `[{ model, src, thumb }]`, `model` being the position in `ai.models`.
 */
export function buildListing({ ai, images, slug, id, repo, caption = {}, meta = {}, site, now = new Date(), floorPlans = [] }) {
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
  // The Sakani (housing-subsidy) price is the brochure's second figure: kept only beside the
  // brochure's own published, higher price on a sale. The key is left OFF every other listing.
  const subsidised = price.subsidisedAmount;
  delete price.subsidisedAmount;
  if (!caption.price && !price.onRequest && l.category !== 'rent'
      && typeof price.amount === 'number' && price.amount > 0
      && typeof subsidised === 'number' && Number.isFinite(subsidised) && subsidised > 0 && subsidised < price.amount) {
    price.subsidisedAmount = subsidised;
  }
  // Optional, and left out entirely when empty: a listing without unit models or facts keeps its shape.
  const enrichment = modelsAndFacts(ai, floorPlans, { rent: l.category === 'rent' });

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
    ...enrichment,
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
  listing.images = images.map((im) => ({
    src: im.src, thumb: im.thumb, alt: altFor(im.room, listing),
    ...(isFocus(im.focus) ? { focus: { x: im.focus.x, y: im.focus.y } } : {}),
  }));
  return listing;
}

/**
 * Local mirror of the rules in scripts/curate/validate.mjs, so a bad listing is refused
 * BEFORE anything is written and the owner gets a one-line WhatsApp reason instead of a
 * broken build.
 */
export function checkListing(listing, { minImages = 4, maxImages = 10, withdrawals = [] } = {}) {
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
    e.push(...imageFocusProblems(im.focus, i));
  }
  if (!listing.price?.onRequest && !(typeof listing.price?.amount === 'number' && listing.price.amount > 0)) {
    e.push('price.amount must be > 0 unless onRequest');
  }
  e.push(...subsidisedPriceProblems(listing.price, listing.category));
  // Unit models, their floor plans and the fact lists — and the headline that must agree with them.
  e.push(...modelsProblems(listing));
  // Optional, like project/unit/map — but when present every entry is `{ src, poster }` in
  // the same site-local shapes the site validator demands (scripts/curate/rules.mjs), so a
  // listing this accepts can never fail the build afterwards.
  if (listing.videos !== undefined) {
    if (!Array.isArray(listing.videos)) e.push('videos must be an array when present');
    else for (const [i, v] of listing.videos.entries()) e.push(...videoEntryProblems(v, i));
  }
  // Also optional, and also the site validator's own rule rather than a copy of it: the REGA
  // licence the owner records with `licence <id> …` / `wafi <id> …` (lib/edits.mjs).
  e.push(...licenceProblems(listing.licence));
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
  // A withheld listing is refused HERE, not merely filtered out of listings.json later,
  // because the intake commits public/listings/<slug>/ photos and brochure.pdf — GitHub
  // Pages serves those directly, so a listing that is only filtered downstream still leaks
  // its pictures and the owner's full brochure.
  // A project whose advertising permission was withdrawn (rules.mjs WITHDRAWN_ADVERTISING, or a
  // flag in the review register passed as `withdrawals`) is refused however it comes back: a fresh
  // id, a new slug, a re-exported brochure — the name in its title or project still matches.
  const withdrawn = withdrawnAdvertising(listing, withdrawals);
  if (withdrawn) e.push(withdrawnNotice(withdrawn));
  else if (!isPublishable(listing)) {
    e.push('this listing is withheld from the public site by owner decision — share it on enquiry instead');
  }
  return e;
}

export function writeInboxListing(repo, listing) {
  const dir = inboxPath(repo);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${listing.slug}.json`);
  fs.writeFileSync(file, `${JSON.stringify(listing, null, 2)}\n`);
  return file;
}

/** Every key buildListing() writes (plus `licence`, which the pipeline leaves null): what a re-run rewrites. */
const REBUILT_KEYS = new Set([
  'id', 'slug', 'sourceRef', 'status', 'category', 'type', 'kind', 'featured', 'title', 'location', 'price', 'specs',
  'images', 'videos', 'description', 'highlights', 'virtualTourUrl', 'brochureUrl', 'project', 'unit', 'map',
  'mapPrecision', 'listedAt', 'hidden', 'licence', '_intake', 'models', 'amenities', 'nearby', 'warranties',
]);

/**
 * What `run-once --replace <id>` keeps from the listing it rewrites — or why it must not run.
 * A re-run rebuilds the listing from the brochure alone, so anything added to it since (a photo
 * note, an FAQ, an SEO title, video clips, a REGA licence, the owner's own price or cover photo,
 * featured or hidden) would be lost silently. Such a listing is refused rather than stripped.
 * @returns {{replace:true, id:string, slug:string, listedAt:string, sourceRef:string|null, status:string}}
 */
export function replaceMetaFor(repo, id) {
  const found = findInbox(repo, id);
  if (!found) throw new Error(`--replace ${id}: no inbox listing with that id`);
  const l = found.listing;
  const blockers = [];
  const extra = Object.keys(l).filter((k) => !REBUILT_KEYS.has(k));
  if (extra.length) blockers.push(`hand-added field(s) ${extra.join(', ')}`);
  if (Array.isArray(l.videos) && l.videos.length) blockers.push(`${l.videos.length} video(s)`);
  if (l.licence && Object.values(l.licence).some((v) => v !== null && v !== undefined && v !== '')) blockers.push('a licence');
  if (l.hidden) blockers.push('hidden: true');
  if (l.featured) blockers.push('featured: true');
  if (l.virtualTourUrl) blockers.push('a virtual tour'); // the intake always writes null: any value was added by hand
  const edits = l._intake?.edits;
  if (Array.isArray(edits) && edits.length) blockers.push(`the owner's own ${edits.join(' and ')} edit(s)`);
  if (blockers.length) throw new Error(`--replace ${id}: it has ${blockers.join('; ')}, which a re-run would not keep — do it by hand`);
  return { replace: true, id: l.id, slug: l.slug, listedAt: l.listedAt, sourceRef: l.sourceRef ?? null, status: l.status };
}

// ---- run-once --enrich <id> -------------------------------------------------------------------
// ~20 listings went live from WhatsApp PDFs before the intake read unit models; several were
// corrected by hand since (titles, districts, photos), so --replace refuses them. --enrich adds ONLY
// what the old intake could not read — the unit models with their floor plans, the fact lists, the
// headline those models prove when the listing had none — and rebuilds the brochure. Everything
// else in the listing stays exactly as it is.

/** The keys `--enrich` adds, replaces or removes (besides `price` and `brochureUrl`), in publish order. */
export const ENRICH_KEYS = Object.freeze(['models', ...Object.keys(FACT_LISTS)]);

/**
 * Which listing `run-once --enrich <id>` adds to — or why it must not. Refused: an unknown id, a
 * withdrawn listing (its own record or rules.mjs / the review register: nothing is published for it
 * again), one withheld by owner decision, a hidden one, and one that records no source PDF (the
 * brochure could not be matched to it). Hand-added fields, videos, a licence, the owner's own edits
 * do NOT block it: enrichment never rewrites them.
 * @returns {{enrich:{id:string, slug:string, existing:object}}}
 */
export function enrichMetaFor(repo, id) {
  const found = findInbox(repo, id);
  if (!found) throw new Error(`--enrich ${id}: no inbox listing with that id`);
  const l = found.listing;
  const withdrawn = withdrawnAdvertising(l, loadRegisterWithdrawals(repo));
  if (withdrawn) throw new Error(`--enrich ${l.id}: ${withdrawnNotice(withdrawn)}`);
  if (l.status === 'withdrawn') throw new Error(`--enrich ${l.id}: it was withdrawn (status "withdrawn") — nothing is published for it again`);
  if (!isPublishable(l)) throw new Error(`--enrich ${l.id}: it is withheld from the public site by owner decision`);
  if (l.hidden) throw new Error(`--enrich ${l.id}: it is hidden — \`show ${l.id}\` first if it should go back on the site`);
  if (typeof l._intake?.pdfSha256 !== 'string' || !l._intake.pdfSha256) {
    throw new Error(`--enrich ${l.id}: it records no source PDF (_intake.pdfSha256), so no brochure can be matched to it`);
  }
  return { enrich: { id: l.id, slug: l.slug, existing: l } };
}

const hasEnrichment = (k, v) => (k === 'models' ? Array.isArray(v) && v.length > 0 : hasItems(v));

/**
 * The listing `--enrich` writes: `existing` with ONLY the new run's enrichment taken from `built` (a
 * buildListing() / modelsAndFacts() result for the same brochure) — `models` and each fact list,
 * replaced by the new run's or REMOVED when it has none (an empty one counts as none) — and `price`
 * only when one is passed. Every other key is the listing's own, unchanged and in its own place, so
 * the file differs from the old one only by those keys. New keys go where the first enrichment key
 * was, else after `highlights` (where buildListing() puts them), else at the end. `brochureUrl` is the
 * caller's to set once the brochure is built. Pure: nothing passed in is changed or shared.
 */
export function mergeEnrichment(existing, built, { price } = {}) {
  const fresh = Object.fromEntries(ENRICH_KEYS.filter((k) => hasEnrichment(k, built?.[k])).map((k) => [k, structuredClone(built[k])]));
  const keys = Object.keys(existing ?? {});
  const firstEnrich = keys.findIndex((k) => ENRICH_KEYS.includes(k));
  const at = firstEnrich !== -1 ? firstEnrich : keys.includes('highlights') ? keys.indexOf('highlights') + 1 : keys.length;
  const own = keys.filter((k) => !ENRICH_KEYS.includes(k));
  const cut = keys.slice(0, at).filter((k) => !ENRICH_KEYS.includes(k)).length;
  const out = {};
  for (const k of own.slice(0, cut)) out[k] = structuredClone(existing[k]);
  Object.assign(out, fresh);
  for (const k of own.slice(cut)) out[k] = structuredClone(existing[k]);
  if (price !== undefined) out.price = structuredClone(price);
  return out;
}

const money = (p) => `${p?.currency ?? 'SAR'} ${Number(p?.amount).toLocaleString('en-US')}`;
/** A price's Sakani line for a refusal; "(no Sakani price)" only where that line is the whole difference. */
const sakani = (p, other) => (isFigure(p?.subsidisedAmount)
  ? ` (Sakani ${p.currency ?? 'SAR'} ${p.subsidisedAmount.toLocaleString('en-US')})`
  : p?.amount === other?.amount && isFigure(other?.subsidisedAmount) ? ' (no Sakani price)' : '');

/**
 * The headline `--enrich` publishes beside the unit models, decided from the EXISTING listing.
 * `alignedPrice` = alignHeadline() over the models as they will be published (null when none of them
 * kept a confirmed price). In order:
 *   - the owner set the price by WhatsApp (`_intake.edits` has 'price'): his price stays and the
 *     models lose theirs — the same rule as a caption price or a later `price <id>`;
 *   - `currencyMismatch` (the caller's finding, pipeline.mjs: the reading's model prices are in another
 *     currency than the listing's, or in one the reading did not establish — model-prices.mjs
 *     modelPriceCurrency): the price stays and the models lose theirs — the site prints every model
 *     price in the listing's `price.currency`;
 *   - one specific `unit`: its own price stays, and its models keep theirs (the validator exempts units);
 *   - no model kept a price: the price stays as it is, set or on request;
 *   - not a whole development of several unit models (rules.mjs headlineFollowsModels: no `project`, or
 *     fewer than two models — a single property, per-floor rows): its own price stays and its models
 *     keep theirs, exactly as for a unit;
 *   - on request: the models' confirmed headline is adopted — a printed figure the old intake could not read;
 *   - set: kept when it IS the lowest model price with the same Sakani line (marked `from` if it was
 *     not — what the validator requires of a headline taken from models); otherwise REFUSED with both
 *     figures, and nothing changes.
 * @returns {{price:object, dropModelPrices:boolean, refuse:string|null,
 *            decision:'owner-price'|'currency-mismatch'|'unit'|'single-property'|'no-model-prices'|'adopted'|'kept'|'refused'}}
 */
export function enrichHeadline(existing, models, alignedPrice, { currencyMismatch = false } = {}) {
  const current = existing?.price ?? null;
  const keep = (decision, dropModelPrices = false) => ({ price: current, dropModelPrices, refuse: null, decision });
  const edits = existing?._intake?.edits;
  if (Array.isArray(edits) && edits.includes('price')) return keep('owner-price', true);
  if (currencyMismatch) return keep('currency-mismatch', true);
  if (existing?.unit !== null && existing?.unit !== undefined) return keep('unit');
  const priced = (Array.isArray(models) ? models : []).some((m) => isFigure(m?.price));
  if (!priced || !alignedPrice || !isFigure(alignedPrice.amount)) return keep('no-model-prices');
  if (!headlineFollowsModels({ project: existing?.project, unit: null, models })) return keep('single-property');
  if (!current || current.onRequest) return { price: alignedPrice, dropModelPrices: false, refuse: null, decision: 'adopted' };
  const sameSakani = (current.subsidisedAmount ?? null) === (alignedPrice.subsidisedAmount ?? null);
  if (current.amount === alignedPrice.amount && sameSakani) {
    return { price: current.from === true ? current : { ...current, from: true }, dropModelPrices: false, refuse: null, decision: 'kept' };
  }
  const id = existing?.id ?? 'the listing';
  return {
    price: current,
    dropModelPrices: false,
    refuse: `${id} shows ${money(current)}${sakani(current, alignedPrice)} but the brochure's lowest model price is `
      + `${money(alignedPrice)}${sakani(alignedPrice, current)} — send \`price ${id} …\` or re-run with --replace`,
    decision: 'refused',
  };
}

/** Pick the images to publish from the model's ranking. */
export function orderedPicks(aiImages, { maxImages = 10 } = {}) {
  return (aiImages || [])
    .filter((im) => im && !im.exclude && Number.isInteger(im.index))
    .map((im) => ({ ...im, rank: Number.isFinite(im.rank) ? im.rank : 99 }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, maxImages)
    .map((im, i) => ({
      index: im.index, room: ROOMS[im.room] ? im.room : 'view', rank: i + 1, reason: im.reason ?? null,
      // Two decimals is a 1% step — finer than any crop can show. Anything malformed is dropped (= centred).
      focus: isFocus(im.focus) ? { x: Math.round(im.focus.x * 100) / 100, y: Math.round(im.focus.y * 100) / 100 } : null,
    }));
}
