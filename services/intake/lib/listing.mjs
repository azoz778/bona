// Turn the AI contract + the written image files into a listing object that satisfies
// src/data/LISTING-SCHEMA.md, and manage the inbox (scripts/curate/inbox/).
import fs from 'node:fs';
import path from 'node:path';
import { ROOMS } from '../../../scripts/curate/rooms.mjs';

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

export function nextListingId(index) {
  return `BONA-W${String(index.nextSeq ?? 1).padStart(3, '0')}`;
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
    description: { en: l.description.en.join('\n\n'), ar: l.description.ar.join('\n\n') },
    highlights: l.highlights,
    virtualTourUrl: null,
    brochureUrl: meta.brochureUrl ?? null,
    project: l.project ?? null,
    unit: l.unit ?? null,
    map: null,
    listedAt: meta.listedAt || todayRiyadh(now),
    hidden: Boolean(meta.hidden),
    _intake: {
      source: 'whatsapp',
      messageId: meta.messageId ?? null,
      groupJid: meta.groupJid ?? null,
      pdfSha256: meta.pdfSha256 ?? null,
      pdfFileName: meta.pdfFileName ?? null,
      caption: caption.text ?? null,
      model: meta.model ?? null,
      confidence: ai.confidence ?? null,
      warnings: ai.warnings ?? [],
      images: images.map((im) => ({ n: im.n, candidate: im.index, room: im.room, reason: im.reason })),
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
  if (!/^BONA-W\d{3}$/.test(listing.id || '')) e.push(`id must match BONA-W### (got ${listing.id})`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(listing.slug || '')) e.push(`slug must be lowercase-hyphenated (got ${listing.slug})`);
  if (RESERVED_SLUGS.has(listing.slug)) e.push(`slug "${listing.slug}" collides with a section route`);
  if (!isPair(listing.title)) e.push('title.en/ar required');
  if (!Array.isArray(listing.images) || listing.images.length < minImages) {
    e.push(`not enough usable photos (${listing.images?.length ?? 0} of ${minImages} needed)`);
  } else if (listing.images.length > maxImages) e.push(`too many photos (${listing.images.length} > ${maxImages})`);
  for (const [i, im] of (listing.images || []).entries()) {
    if (!/^\/listings\/[A-Za-z0-9-]+\/[A-Za-z0-9-]+\.jpg$/.test(im.src || '')) e.push(`images[${i}].src is not /listings/<slug>/<nn>.jpg`);
    if (!(im.thumb === null || /^\/listings\/[A-Za-z0-9-]+\/[A-Za-z0-9-]+\.webp$/.test(im.thumb || ''))) e.push(`images[${i}].thumb is not /listings/<slug>/<nn>-thumb.webp`);
    if (!isPair(im.alt)) e.push(`images[${i}].alt.en/ar required`);
  }
  if (!listing.price?.onRequest && !(typeof listing.price?.amount === 'number' && listing.price.amount > 0)) {
    e.push('price.amount must be > 0 unless onRequest');
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
