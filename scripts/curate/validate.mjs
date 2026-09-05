#!/usr/bin/env node
// Validates src/data/listings.json against src/data/LISTING-SCHEMA.md.
// Usage: node scripts/curate/validate.mjs [--head]
//   --head  also HEAD-request every remote image src/thumb (HTTP 200 required) and stat every
//           site-local still under public/; network, ~1 min.
// Exits 1 on any failure.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function matterportIdOf(value) {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value.trim());
    if (!/^(my\.)?matterport\.com$/i.test(u.hostname) || !/^\/show\/?$/.test(u.pathname)) return null;
    const id = u.searchParams.get('m');
    return id && /^[A-Za-z0-9_-]{4,64}$/.test(id) ? id : null;
  } catch { return null; }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = path.join(ROOT, 'src', 'data', 'listings.json');
const HEAD = process.argv.includes('--head');

const STATUS = new Set(['available', 'reserved', 'sold']);
const CATEGORY = new Set(['buy', 'rent', 'off-plan', 'international']);
const TYPE = new Set(['villa', 'apartment', 'penthouse', 'mansion', 'land', 'building', 'duplex']);
const KIND = new Set(['house', 'apartment', 'land', 'building']);
// kind is derived from type (schema, Round 2) — a listing whose kind disagrees with its type is an error.
const KIND_OF = { villa: 'house', mansion: 'house', duplex: 'house', palais: 'house', apartment: 'apartment', penthouse: 'apartment', land: 'land', building: 'building' };
const CURRENCY = new Set(['SAR', 'AED', 'EUR', 'USD', 'OMR']);
const PERIOD = new Set([null, 'year', 'month']);
const MEDIA = /^https:\/\/tk-storage\.azoz\.uk\/tk-estate-media\/media\/[^/]+\/[^/]+$/;
const THUMB = /^https:\/\/tk-storage\.azoz\.uk\/tk-estate-media\/website-thumbs\/[^/]+\.webp$/;
const LOCAL_STILL = /^\/land\/[A-Za-z0-9-]+\.jpg$/; // satellite stills for land plots, served from public/land
const ARABIC = /[؀-ۿ]/;
const FORBIDDEN = [/\bTK\b/i, /tk[- ]?estates?/i, /tk-estates\.com/i, /\+966 ?5[56] ?\d{3} ?\d{4}/]; // old brand + old phones
const HYPE = /\b(amazing|stunning|breathtaking|unparalleled|don't miss|dream home)\b/i;

const errors = [];
const err = (id, msg) => errors.push(`${id}: ${msg}`);

let data;
try {
  data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (e) {
  console.error(`cannot read/parse ${FILE}: ${e.message}`);
  process.exit(1);
}
if (!Array.isArray(data)) { console.error('listings.json must be an array'); process.exit(1); }
if (data.length < 24 || data.length > 80) err('file', `expected 24–80 listings, got ${data.length}`);

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isNumOrNull = (v) => v === null || (typeof v === 'number' && Number.isFinite(v));
const isLoc = (v) => v && isStr(v.en) && isStr(v.ar) && ARABIC.test(v.ar);
const checkCopy = (id, label, s) => {
  for (const re of FORBIDDEN) if (re.test(s)) err(id, `${label} mentions the old brand/phone: ${s.match(re)[0]}`);
  if (HYPE.test(s)) err(id, `${label} uses hype wording: "${s.match(HYPE)[0]}"`);
};
// Listings may share images only when they are units/pages of the same developer's project
// (developer renders are legitimately reused across units); everything else must be unique.
const shareKey = (l) => (l.project && l.project.developer && isStr(l.project.developer.en) ? `dev:${l.project.developer.en.trim().toLowerCase()}` : null);

const ids = new Set();
const slugs = new Set();
const srcs = new Map(); // src -> first listing
const heroes = new Map(); // hero src -> first listing (heroes are unique across the whole grid)

for (const l of data) {
  const id = l.id ?? '(no id)';
  if (!/^BONA-\d{3}$/.test(l.id ?? '')) err(id, 'id must match BONA-###');
  if (ids.has(l.id)) err(id, 'duplicate id'); ids.add(l.id);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(l.slug ?? '')) err(id, `slug must be lowercase-hyphenated: ${l.slug}`);
  if (slugs.has(l.slug)) err(id, `duplicate slug ${l.slug}`); slugs.add(l.slug);
  if (!(l.sourceRef === null || isStr(l.sourceRef))) err(id, 'sourceRef must be string or null');
  if (!STATUS.has(l.status)) err(id, `bad status ${l.status}`);
  if (!CATEGORY.has(l.category)) err(id, `bad category ${l.category}`);
  if (!TYPE.has(l.type)) err(id, `bad type ${l.type}`);
  if (!KIND.has(l.kind)) err(id, `kind is required and must be one of ${[...KIND].join('|')}, got ${l.kind}`);
  else if (KIND_OF[l.type] && KIND_OF[l.type] !== l.kind) err(id, `kind "${l.kind}" does not match type "${l.type}" (expected ${KIND_OF[l.type]})`);
  if (typeof l.featured !== 'boolean') err(id, 'featured must be boolean');
  const isLand = l.kind === 'land';

  if (!isLoc(l.title)) err(id, 'title.en/ar required (ar must be Arabic)');
  const loc = l.location ?? {};
  for (const k of ['district', 'city', 'country']) if (!isLoc(loc[k])) err(id, `location.${k}.en/ar required`);
  if (!/^[A-Z]{2}$/.test(loc.countryCode ?? '')) err(id, 'location.countryCode must be ISO-2');

  const p = l.price ?? {};
  if (!CURRENCY.has(p.currency)) err(id, `bad currency ${p.currency}`);
  if (typeof p.from !== 'boolean') err(id, 'price.from must be boolean');
  if (typeof p.onRequest !== 'boolean') err(id, 'price.onRequest must be boolean');
  if (!PERIOD.has(p.period)) err(id, `bad price.period ${p.period}`);
  if (!isNumOrNull(p.amount)) err(id, 'price.amount must be number or null');
  if (!p.onRequest && !(typeof p.amount === 'number' && p.amount > 0)) err(id, 'price.amount must be > 0 unless onRequest');
  if (l.category === 'rent' && !p.period) err(id, 'rent listings need price.period');
  if (l.category !== 'rent' && p.period) err(id, 'only rent listings may have price.period');

  const s = l.specs ?? {};
  for (const k of ['beds', 'baths', 'areaSqm', 'plotSqm', 'yearBuilt', 'floors']) if (!isNumOrNull(s[k])) err(id, `specs.${k} must be number or null`);
  if (isLand && !(typeof s.plotSqm === 'number' && s.plotSqm > 0)) err(id, 'land listings need specs.plotSqm > 0');

  const minImages = isLand ? 1 : 4;
  if (!Array.isArray(l.images) || l.images.length < minImages || l.images.length > 10) err(id, `need ${minImages}–10 images, got ${l.images?.length}`);
  for (const [i, im] of (l.images ?? []).entries()) {
    const src = im.src ?? '';
    if (isLand && LOCAL_STILL.test(src)) { /* site-local satellite still */ }
    else if (!MEDIA.test(src)) err(id, `images[${i}].src not a tk-storage media URL${isLand ? ' or /land/<name>.jpg still' : ''}`);
    if (!(im.thumb === null || THUMB.test(im.thumb))) err(id, `images[${i}].thumb must be null or a website-thumbs webp URL`);
    if (!isLoc(im.alt)) err(id, `images[${i}].alt.en/ar required`);
    const prev = srcs.get(src);
    if (prev && prev !== l) {
      const k = shareKey(l);
      if (!(k && k === shareKey(prev))) err(id, `images[${i}] reused from ${prev.id} (only units of the same developer may share images): ${src}`);
    } else if (prev === l) err(id, `images[${i}] duplicated within the listing: ${src}`);
    if (!prev) srcs.set(src, l);
    if (i === 0) {
      const h = heroes.get(src);
      if (h) err(id, `hero image also the hero of ${h.id} — vary heroes so the grid has no identical cards`);
      else heroes.set(src, l);
    }
  }

  if (!isLoc(l.description)) err(id, 'description.en/ar required');
  else {
    if (l.description.en.split(/\n\n+/).length < 2) err(id, 'description.en should have at least 2 paragraphs');
    if (l.description.ar.split(/\n\n+/).length < 2) err(id, 'description.ar should have at least 2 paragraphs');
  }
  const h = l.highlights ?? {};
  for (const lang of ['en', 'ar']) {
    if (!Array.isArray(h[lang]) || h[lang].length < 4 || h[lang].length > 6) err(id, `highlights.${lang} needs 4–6 items`);
    else for (const item of h[lang]) { if (!isStr(item)) err(id, `highlights.${lang} has an empty item`); if (lang === 'ar' && !ARABIC.test(item)) err(id, `highlights.ar item is not Arabic: ${item}`); }
  }
  if (Array.isArray(h.en) && Array.isArray(h.ar) && h.en.length !== h.ar.length) err(id, 'highlights.en and .ar must have the same length');

  for (const k of ['virtualTourUrl', 'brochureUrl']) if (!(l[k] === null || /^https:\/\//.test(l[k] ?? ''))) err(id, `${k} must be null or https URL`);
  if (l.virtualTourUrl && !(l.virtualTourUrl.startsWith('https://') && matterportIdOf(l.virtualTourUrl))) err(id, `virtualTourUrl must be a full Matterport URL with a valid m= id: ${l.virtualTourUrl}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(l.listedAt ?? '') || Number.isNaN(Date.parse(l.listedAt))) err(id, `bad listedAt ${l.listedAt}`);

  // Round 2 optional objects
  if (!(l.project === null || l.project === undefined)) {
    const pr = l.project;
    if (!(pr && typeof pr === 'object' && isLoc(pr.name) && isLoc(pr.developer))) err(id, 'project must be null or { name:{en,ar}, developer:{en,ar} }');
  }
  if (!(l.unit === null || l.unit === undefined)) {
    const u = l.unit;
    const ok = u && typeof u === 'object'
      && (u.floor === null || isStr(u.floor) || (typeof u.floor === 'number' && Number.isFinite(u.floor)))
      && (u.block === null || isStr(u.block)) && (u.unitRef === null || isStr(u.unitRef));
    if (!ok) err(id, 'unit must be null or { floor: string|number|null, block: string|null, unitRef: string|null }');
  }
  if (!(l.map === null || l.map === undefined)) {
    const m = l.map;
    const ok = m && typeof m === 'object' && typeof m.lat === 'number' && typeof m.lng === 'number' && Math.abs(m.lat) <= 90 && Math.abs(m.lng) <= 180;
    if (!ok) err(id, 'map must be null or { lat, lng } numbers');
  }
  if (isLand && !(l.map && typeof l.map.lat === 'number')) err(id, 'land listings need map.lat/lng (exact plot pin)');

  // copy hygiene
  for (const [label, str] of [['title.en', l.title?.en], ['title.ar', l.title?.ar], ['description.en', l.description?.en], ['description.ar', l.description?.ar], ['project.name.en', l.project?.name?.en], ['project.name.ar', l.project?.name?.ar], ...((h.en ?? []).map((x, i) => [`highlights.en[${i}]`, x])), ...((h.ar ?? []).map((x, i) => [`highlights.ar[${i}]`, x]))]) if (isStr(str)) checkCopy(id, label, str);
}

const featured = data.filter((l) => l.featured).length;
if (featured < 6 || featured > 9) err('file', `expected 6–9 featured listings, got ${featured}`);

async function headCheck() {
  const all = [...new Set(data.flatMap((l) => l.images.flatMap((im) => [im.src, im.thumb].filter(Boolean))))];
  const local = all.filter((u) => u.startsWith('/'));
  const urls = all.filter((u) => !u.startsWith('/'));
  for (const u of local) if (!fs.existsSync(path.join(ROOT, 'public', u))) err('head', `missing site-local still public${u}`);
  let i = 0; const bad = [];
  async function worker() {
    while (i < urls.length) {
      const u = urls[i++];
      let ok = false;
      for (let a = 0; a < 3 && !ok; a++) {
        try {
          const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15000);
          const r = await fetch(u, { method: 'HEAD', signal: ac.signal }); clearTimeout(t);
          if (r.status === 200) ok = true; else if (r.status < 500 && r.status !== 429) break;
        } catch { /* retry */ }
      }
      if (!ok) bad.push(u);
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker));
  for (const u of bad) err('head', `not HTTP 200: ${u}`);
  console.log(`HEAD-checked ${urls.length} URLs (${bad.length} failures), stat-checked ${local.length} local stills`);
}

if (HEAD) await headCheck();

if (errors.length) {
  console.error(`listings.json INVALID — ${errors.length} problem(s):`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
const imgs = data.reduce((n, l) => n + l.images.length, 0);
const byCat = data.reduce((a, l) => ((a[l.category] = (a[l.category] || 0) + 1), a), {});
const byKind = data.reduce((a, l) => ((a[l.kind] = (a[l.kind] || 0) + 1), a), {});
console.log(`listings.json OK — ${data.length} listings, ${imgs} images, ${featured} featured, ${JSON.stringify(byCat)}, kinds ${JSON.stringify(byKind)}`);
