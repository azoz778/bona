#!/usr/bin/env node
// Validates src/data/listings.json against src/data/LISTING-SCHEMA.md.
// Usage: node scripts/curate/validate.mjs [--head]
//   --head  also HEAD-request every image src/thumb (HTTP 200 required); network, ~1 min.
// Exits 1 on any failure.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = path.join(ROOT, 'src', 'data', 'listings.json');
const HEAD = process.argv.includes('--head');

const STATUS = new Set(['available', 'reserved', 'sold']);
const CATEGORY = new Set(['buy', 'rent', 'off-plan', 'international']);
const TYPE = new Set(['villa', 'apartment', 'penthouse', 'mansion', 'land', 'building', 'duplex']);
const CURRENCY = new Set(['SAR', 'AED', 'EUR', 'USD', 'OMR']);
const PERIOD = new Set([null, 'year', 'month']);
const MEDIA = /^https:\/\/tk-storage\.azoz\.uk\/tk-estate-media\/media\/[^/]+\/[^/]+$/;
const THUMB = /^https:\/\/tk-storage\.azoz\.uk\/tk-estate-media\/website-thumbs\/[^/]+\.webp$/;
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
if (data.length < 24 || data.length > 32) err('file', `expected 24–32 listings, got ${data.length}`);

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isNumOrNull = (v) => v === null || (typeof v === 'number' && Number.isFinite(v));
const isLoc = (v) => v && isStr(v.en) && isStr(v.ar) && ARABIC.test(v.ar);
const checkCopy = (id, label, s) => {
  for (const re of FORBIDDEN) if (re.test(s)) err(id, `${label} mentions the old brand/phone: ${s.match(re)[0]}`);
  if (HYPE.test(s)) err(id, `${label} uses hype wording: "${s.match(HYPE)[0]}"`);
};

const ids = new Set();
const slugs = new Set();
const srcs = new Set();

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
  if (typeof l.featured !== 'boolean') err(id, 'featured must be boolean');

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

  if (!Array.isArray(l.images) || l.images.length < 4 || l.images.length > 10) err(id, `need 4–10 images, got ${l.images?.length}`);
  for (const [i, im] of (l.images ?? []).entries()) {
    if (!MEDIA.test(im.src ?? '')) err(id, `images[${i}].src not a tk-storage media URL`);
    if (!(im.thumb === null || THUMB.test(im.thumb))) err(id, `images[${i}].thumb must be null or a website-thumbs webp URL`);
    if (!isLoc(im.alt)) err(id, `images[${i}].alt.en/ar required`);
    if (srcs.has(im.src)) err(id, `images[${i}] reused across listings: ${im.src}`);
    srcs.add(im.src);
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(l.listedAt ?? '') || Number.isNaN(Date.parse(l.listedAt))) err(id, `bad listedAt ${l.listedAt}`);

  // copy hygiene
  for (const [label, s] of [['title.en', l.title?.en], ['title.ar', l.title?.ar], ['description.en', l.description?.en], ['description.ar', l.description?.ar], ...((h.en ?? []).map((x, i) => [`highlights.en[${i}]`, x])), ...((h.ar ?? []).map((x, i) => [`highlights.ar[${i}]`, x]))]) if (isStr(s)) checkCopy(id, label, s);
}

const featured = data.filter((l) => l.featured).length;
if (featured < 6 || featured > 9) err('file', `expected 6–9 featured listings, got ${featured}`);

async function headCheck() {
  const urls = [...new Set(data.flatMap((l) => l.images.flatMap((im) => [im.src, im.thumb].filter(Boolean))))];
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
  console.log(`HEAD-checked ${urls.length} URLs, ${bad.length} failures`);
}

if (HEAD) await headCheck();

if (errors.length) {
  console.error(`listings.json INVALID — ${errors.length} problem(s):`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
const imgs = data.reduce((n, l) => n + l.images.length, 0);
console.log(`listings.json OK — ${data.length} listings, ${imgs} images, ${featured} featured`);
