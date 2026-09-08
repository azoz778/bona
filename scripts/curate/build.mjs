#!/usr/bin/env node
// Generates src/data/listings.json from scripts/curate/listings.source.mjs + scripts/tk-gallery-data.json.
// Usage: node scripts/curate/build.mjs
// Image src/thumb values are copied verbatim from the gallery file (never synthesised).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LISTINGS } from './listings.source.mjs';
import { ROOMS } from './rooms.mjs';
import { INTAKE_ID_RE, isLandPublic, isPublishable, LAND_PRICE_CAP, sarAmount, WITHHELD_LISTINGS } from './rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GALLERY = path.join(ROOT, 'scripts', 'tk-gallery-data.json');
const OUT = path.join(ROOT, 'src', 'data', 'listings.json');

// A brochure's public URL is a fact about where the site lives NOW, not about where it lived
// when the intake daemon first published the file. The stored value is whatever the daemon
// wrote at ingest, so after a domain move it is stale — and because this generator used to
// copy it through verbatim, every rebuild quietly reintroduced the old host. Recompute it
// from the site's own config; the stored value only decides WHETHER there is a brochure.
const SITE_URL = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'site.json'), 'utf8')).url.replace(/\/+$/, '');
const brochureUrlFor = (slug) => `${SITE_URL}/listings/${slug}/brochure.pdf`;

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
    brochureUrl: l.brochureUrl ? brochureUrlFor(l.slug) : null,
    project: l.project ?? null,
    unit: l.unit ?? null,
    map: l.map ?? null,
    listedAt: l.listedAt,
    licence: null, // filled from scripts/curate/licences.json below
  };
});

for (const l of out) {
  if (l.project && l.unit) {
    l.images = l.images.map((im) => ({ ...im, alt: { en: `Illustrative — developer's finished unit at ${l.project.name.en}: ${im.alt.en}`, ar: `صورة توضيحية — وحدة منجزة من المطوّر في ${l.project.name.ar}: ${im.alt.ar}` } }));
  }
}
// Owner rule (2026-09-05): the site publishes ONLY listings that exist in TK's live public list and are available there.
const API = JSON.parse(fs.readFileSync(new URL('../tk-public-properties.snapshot.json', import.meta.url), 'utf8')).data || [];
const apiById = new Map(API.map((r) => [String(r.id), r]));
// Owner decision 2026-09-06 (revises the 2026-09-05 21:00 blanket hold): land plots are published on
// the site when priced under SAR 50,000,000; plots at or above stay off-market and are excluded
// entirely (no listings.json entry, so no sitemap/OG/card can leak them) — the Land page carries a CTA
// instead. The rule itself is isLandPublic() in rules.mjs, shared with sync-listings.mjs and
// validate.mjs so the daily deploy cannot republish a plot whose price crossed the line.
const live = out.filter((l) => l.sourceRef && apiById.has(String(l.sourceRef)) && !/sold|reserved|rented|inactive|withdrawn/i.test(String(apiById.get(String(l.sourceRef)).status || '')) && isLandPublic(l));
console.log(`TK live list: kept ${live.length}, dropped ${out.length - live.length} (no sourceRef in the API, or not available there)`);

// ---- WhatsApp intake (services/intake) --------------------------------------------------
// Listings the owner published from his phone by dropping a brochure PDF into the Bona
// WhatsApp group. They are OWNER-AUTHORED, not TK stock, so they are EXEMPT from the TK
// live-list rule above; their images live in this repo under public/listings/<slug>/.
// `hidden: true` keeps one off the site without deleting it; `status: "sold"` publishes it
// with a Sold badge. `hidden` and `_intake` are intake bookkeeping and never reach the site.
const INBOX = path.join(ROOT, 'scripts', 'curate', 'inbox');
const inbox = [];
const inboxIdsSeen = new Set(); // every id on disk, hidden ones included — for the stale-withheld check
let inboxHidden = 0;
if (fs.existsSync(INBOX)) {
  for (const name of fs.readdirSync(INBOX).filter((n) => n.endsWith('.json') && n !== '_index.json').sort()) {
    const file = path.join(INBOX, name);
    let l;
    try { l = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`inbox/${name}: invalid JSON (${e.message})`); }
    if (l.id) inboxIdsSeen.add(l.id);
    if (l.hidden === true) { inboxHidden++; continue; }
    const { hidden, _intake, ...clean } = l;
    if (!KIND_OF[clean.type]) throw new Error(`inbox/${name}: no kind mapping for type "${clean.type}"`);
    clean.kind = KIND_OF[clean.type];
    clean.featured = Boolean(clean.featured);
    // Same reason as the curated set above: the daemon stamped this URL with whatever host
    // was configured the day the brochure arrived, so it must be re-derived, not trusted.
    if (clean.brochureUrl) clean.brochureUrl = brochureUrlFor(clean.slug);
    // REGA licence fields travel with the inbox JSON (the intake's `licence` / `wafi` commands write them there).
    clean.licence = clean.licence ?? null;
    for (const [i, im] of (clean.images ?? []).entries()) {
      // BOTH src and thumb: a listing whose thumbnail is missing renders a broken card,
      // and the site never regenerates one at build time.
      for (const field of ['src', 'thumb']) {
        const v = im[field];
        if (typeof v === 'string' && v.startsWith('/') && !fs.existsSync(path.join(ROOT, 'public', v))) {
          throw new Error(`inbox/${name}: images[${i}].${field} missing: public${v}`);
        }
      }
    }
    // The same rule for walkthrough clips: `{ src, poster }`, both site-local files that have
    // to exist, or the page renders a player pointing at a 404.
    for (const [i, v] of (clean.videos ?? []).entries()) {
      for (const field of ['src', 'poster']) {
        const p = v?.[field];
        if (typeof p === 'string' && p.startsWith('/') && !fs.existsSync(path.join(ROOT, 'public', p))) {
          throw new Error(`inbox/${name}: videos[${i}].${field} missing: public${p}`);
        }
      }
    }
    inbox.push(clean);
  }
}
if (inbox.length || inboxHidden) console.log(`WhatsApp intake: appended ${inbox.length} listing(s), ${inboxHidden} hidden`);

// Two rules decide what reaches the public site, both applied to the COMBINED curated +
// intake set so a listing can never slip in by route (the land rule filtered only the
// curated set until the Codex final gate of 2026-09-08 caught the intake path):
//   land     — at or above SAR 50,000,000, or with no published price (isLandPublic).
//   withheld — specific homes the owner has named (scripts/curate/rules.mjs). This replaced
//              a SAR 10,000,000 house cap on 2026-09-08: the owner meant to take two homes
//              down once, not to hide every expensive house a luxury brand publishes.
const candidates = [...live, ...inbox];
const overLandCap = candidates.filter((l) => !isLandPublic(l));
if (overLandCap.length) {
  console.log(`Land cap: excluded ${overLandCap.length} plot(s) at/above SAR ${LAND_PRICE_CAP.toLocaleString('en-US')} or without a published price — ${overLandCap.map((l) => `${l.id ?? l.slug} (${sarAmount(l.price) === null ? 'no price' : `${Math.round(sarAmount(l.price)).toLocaleString('en-US')} SAR eq.`})`).join(', ')}`);
}
const withheld = candidates.filter((l) => !isPublishable(l));
if (withheld.length) {
  console.log(`Withheld by owner decision: ${withheld.map((l) => l.id).join(', ')}`);
}
// Withholding a BONA-W### is only half a takedown. The intake committed that listing's photos
// and brochure.pdf under public/listings/<slug>/, and GitHub Pages serves those paths directly,
// so dropping it from listings.json leaves the pictures and the owner's full brochure fetchable
// by anyone who kept the link. Fail loudly rather than half-hide it: `remove <id>` in the
// WhatsApp group is the route that deletes the files.
const leaking = withheld.filter((l) => INTAKE_ID_RE.test(l.id ?? '') && fs.existsSync(path.join(ROOT, 'public', 'listings', l.slug)));
if (leaking.length) {
  throw new Error(`withheld intake listing(s) still have public assets: ${leaking.map((l) => `${l.id} (public/listings/${l.slug}/)`).join(', ')} — send \`remove <id>\` in the WhatsApp group, which deletes the files, instead of naming it in WITHHELD_LISTINGS`);
}
// An id in the list that matches nothing is a decision quietly doing nothing — say so, so a
// renamed or delisted listing does not leave a stale entry that hides a future namesake.
// Compare against every id we KNOW OF, not the publish candidates: `live` has already lost
// everything the TK list dropped, and `inbox` has lost the hidden ones, so judging staleness
// against those would call a deliberate hold "no longer exists".
const known = new Set([...out.map((l) => l.id), ...inboxIdsSeen]);
const stale = [...WITHHELD_LISTINGS].filter((id) => !known.has(id));
if (stale.length) console.warn(`Withheld list mentions ${stale.join(', ')}, which no longer exist — prune scripts/curate/rules.mjs`);
const published = candidates.filter((l) => isPublishable(l) && isLandPublic(l));

// ---- approximate map pins --------------------------------------------------------------
// Most listings have no exact pin: TK's API carries no coordinates and most brochures carry
// no map link. Rather than show nothing, fill in the DISTRICT centroid (src/data/
// district-pins.json, resolved once by scripts/curate/district-pins.mjs) and mark it
// `mapPrecision: "district"` so the page can label it approximate. An exact pin is never
// overwritten, and a district with no trustworthy pin stays null — the listing then shows
// its district as text only, which is the honest answer.
const DISTRICT_PINS = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'district-pins.json'), 'utf8'));
let exactPins = 0, districtPins = 0, noPin = 0;
for (const l of published) {
  if (l.map) { l.mapPrecision = l.mapPrecision || 'exact'; exactPins++; continue; }
  const pin = DISTRICT_PINS[`${l.location?.district?.en}|${l.location?.city?.en}`];
  if (pin) { l.map = { lat: pin.lat, lng: pin.lng }; l.mapPrecision = 'district'; districtPins++; }
  else { l.map = null; l.mapPrecision = null; noPin++; }
}
console.log(`Map pins: ${exactPins} exact, ${districtPins} district-level, ${noPin} without a pin`);

// ---- REGA advertising licences -----------------------------------------------------------
// Curated (TK-synced) listings have no home for a licence in listings.source.mjs, so the
// numbers live in scripts/curate/licences.json keyed by listing id:
//   { "BONA-015": { "adNumber": "7200012345", "adExpiry": "2027-03-01", "wafiNumber": null, "escrowAccount": null } }
// The site renders the advertiser + FAL line on every listing regardless; these add the
// per-listing advertisement licence (and the Wafi licence for off-plan) when the owner has one.
const LICENCES = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'curate', 'licences.json'), 'utf8'));
let licensed = 0;
for (const l of published) {
  const lc = LICENCES[l.id];
  if (lc && typeof lc === 'object') { l.licence = { adNumber: null, adExpiry: null, wafiNumber: null, escrowAccount: null, ...lc }; }
  if (l.licence && (l.licence.adNumber || l.licence.wafiNumber)) licensed++;
}
console.log(`REGA licences: ${licensed} of ${published.length} listings carry an advertisement or Wafi licence`);

// Every site-local image must actually exist in public/ — src AND thumb, for the curated
// set as well as the intake set, plus every video and its poster. A missing file is a broken
// page, so it fails the build.
for (const l of published) {
  for (const [i, im] of (l.images ?? []).entries()) {
    for (const field of ['src', 'thumb']) {
      const v = im[field];
      if (typeof v === 'string' && v.startsWith('/') && !fs.existsSync(path.join(ROOT, 'public', v))) {
        throw new Error(`${l.id} (${l.slug}): images[${i}].${field} missing: public${v}`);
      }
    }
  }
  for (const [i, vid] of (l.videos ?? []).entries()) {
    for (const field of ['src', 'poster']) {
      const v = vid?.[field];
      if (typeof v === 'string' && v.startsWith('/') && !fs.existsSync(path.join(ROOT, 'public', v))) {
        throw new Error(`${l.id} (${l.slug}): videos[${i}].${field} missing: public${v}`);
      }
    }
  }
}

fs.writeFileSync(OUT, JSON.stringify(published, null, 2) + '\n');
// The summary describes what was WRITTEN, not the pre-filter candidate list.
const counts = published.reduce((a, l) => ((a[l.category] = (a[l.category] || 0) + 1), a), {});
const kinds = published.reduce((a, l) => ((a[l.kind] = (a[l.kind] || 0) + 1), a), {});
const imgs = published.reduce((n, l) => n + l.images.length, 0);
console.log(`wrote ${path.relative(ROOT, OUT)}: ${published.length} listings (${live.length} curated + ${inbox.length} intake), ${imgs} images, featured ${published.filter((l) => l.featured).length}, ${JSON.stringify(counts)}, kinds ${JSON.stringify(kinds)}`);
