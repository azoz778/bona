#!/usr/bin/env node
// Generates src/data/listings.json from scripts/curate/listings.source.mjs + scripts/tk-gallery-data.json.
// Usage: node scripts/curate/build.mjs
// Image src/thumb values are copied verbatim from the gallery file (never synthesised).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LISTINGS } from './listings.source.mjs';
import { ROOMS } from './rooms.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GALLERY = path.join(ROOT, 'scripts', 'tk-gallery-data.json');
const OUT = path.join(ROOT, 'src', 'data', 'listings.json');

const gallery = JSON.parse(fs.readFileSync(GALLERY, 'utf8'));
const byFolder = new Map();
for (const p of gallery) {
  if (!byFolder.has(p.folder)) byFolder.set(p.folder, []);
  byFolder.get(p.folder).push(p);
}

// kind is derived from type (LISTING-SCHEMA.md, Round 2): the site's Houses/Apartments sections key on it.
const KIND_OF = JSON.parse(fs.readFileSync(new URL('../../src/data/kind-map.json', import.meta.url), 'utf8'));

function resolveImage(listing, entry) {
  const spec = Array.isArray(entry) ? { folder: listing.folder, i: entry[0], room: entry[1] } : entry;
  const room = ROOMS[spec.room];
  if (!room) throw new Error(`${listing.slug}: unknown room key "${spec.room}"`);
  if (spec.local) {
    // Site-hosted still (land satellite frames under public/land, produced by land-stills.mjs).
    if (!/^\/land\/[A-Za-z0-9-]+\.jpg$/.test(spec.local)) throw new Error(`${listing.slug}: local image must be /land/<name>.jpg, got ${spec.local}`);
    if (!fs.existsSync(path.join(ROOT, 'public', spec.local))) throw new Error(`${listing.slug}: missing public${spec.local}`);
    return { src: spec.local, thumb: null, alt: { en: `${room.en} — ${listing.title.en}`, ar: `${room.ar} — ${listing.title.ar}` } };
  }
  const photos = byFolder.get(spec.folder);
  if (!photos) throw new Error(`${listing.slug}: unknown gallery folder "${spec.folder}"`);
  const p = photos[spec.i];
  if (!p) throw new Error(`${listing.slug}: index ${spec.i} out of range for folder "${spec.folder}" (${photos.length} photos)`);
  return {
    src: p.url,
    thumb: p.thumb || null,
    alt: { en: `${room.en} — ${listing.title.en}`, ar: `${room.ar} — ${listing.title.ar}` },
  };
}

const out = LISTINGS.map((l, idx) => {
  const images = l.images.map((e) => resolveImage(l, e));
  const seen = new Set();
  for (const im of images) {
    if (seen.has(im.src)) throw new Error(`${l.slug}: duplicate image ${im.src}`);
    seen.add(im.src);
  }
  const kind = KIND_OF[l.type];
  if (!kind) throw new Error(`${l.slug}: no kind mapping for type "${l.type}"`);
  return {
    id: `BONA-${String(idx + 1).padStart(3, '0')}`, // positional: append new listings at the END of LISTINGS, never insert
    slug: l.slug,
    sourceRef: l.sourceRef ?? null,
    status: l.status,
    category: l.category,
    type: l.type,
    kind,
    featured: Boolean(l.featured),
    title: l.title,
    location: l.location,
    price: l.price,
    specs: l.specs,
    images,
    description: { en: l.description.en.join('\n\n'), ar: l.description.ar.join('\n\n') },
    highlights: l.highlights,
    virtualTourUrl: l.virtualTourUrl ?? null,
    brochureUrl: l.brochureUrl ?? null,
    project: l.project ?? null,
    unit: l.unit ?? null,
    map: l.map ?? null,
    listedAt: l.listedAt,
  };
});

for (const l of out) {
  if (l.project && l.unit) {
    l.images = l.images.map((im) => ({ ...im, alt: { en: `Illustrative — developer's finished unit at ${l.project.name.en}: ${im.alt.en}`, ar: `صورة توضيحية — وحدة منجزة من المطوّر في ${l.project.name.ar}: ${im.alt.ar}` } }));
  }
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
const counts = out.reduce((a, l) => ((a[l.category] = (a[l.category] || 0) + 1), a), {});
const kinds = out.reduce((a, l) => ((a[l.kind] = (a[l.kind] || 0) + 1), a), {});
const imgs = out.reduce((n, l) => n + l.images.length, 0);
console.log(`wrote ${path.relative(ROOT, OUT)}: ${out.length} listings, ${imgs} images, featured ${out.filter((l) => l.featured).length}, ${JSON.stringify(counts)}, kinds ${JSON.stringify(kinds)}`);
