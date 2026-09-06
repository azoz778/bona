#!/usr/bin/env node
// Approximate (district-level) map pins.
//
// Most listings have no exact pin: the brochure carries no map link and TK's API has no
// coordinates. Rather than show nothing, the site shows the DISTRICT on a map, clearly
// labelled approximate. This script resolves each distinct district once against
// OpenStreetMap's Nominatim and writes the answers to src/data/district-pins.json, with
// the matched place name kept alongside so a wrong pin can be spotted by eye and pinned by
// hand. The site build reads only that JSON — it never calls the network.
//
//   node scripts/curate/district-pins.mjs            # fill in what is missing
//   node scripts/curate/district-pins.mjs --refresh  # re-resolve everything
//
// A pin edited by hand keeps `"source": "manual"` and is never overwritten.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'src', 'data', 'district-pins.json');
const UA = 'bona-listings-geocoder/1.0 (+https://bona.azoz.uk)';

/** A district pin must land within this far of its city, or it is the wrong place. */
const MAX_KM_FROM_CITY = 60;

/** City anchors, so a match in the wrong country is caught. Lat/lng from OSM city nodes. */
const CITY = {
  Jeddah: { lat: 21.5292, lng: 39.1611, cc: 'sa' },
  Riyadh: { lat: 24.7136, lng: 46.6753, cc: 'sa' },
  Dubai: { lat: 25.2048, lng: 55.2708, cc: 'ae' },
  Muscat: { lat: 23.5880, lng: 58.3829, cc: 'om' },
  Marbella: { lat: 36.5101, lng: -4.8824, cc: 'es' },
  'Le Vésinet': { lat: 48.8924, lng: 2.1329, cc: 'fr' },
};

// Only OSM's own place/boundary features can be a district. Everything else Nominatim
// returns for a district name — a bank, a compound, a golf resort, a road called after the
// district — merely SITS in one, and pinning the map to it would be a lie with decimals on
// it. This filter is why several districts resolve to nothing: that is the correct answer.
const PLACE_CLASSES = new Set(['place', 'boundary']);
const PLACE_TYPES = new Set([
  'suburb', 'neighbourhood', 'quarter', 'city_district', 'district', 'residential',
  'town', 'village', 'city', 'municipality', 'hamlet', 'administrative', 'locality', 'island',
]);

const km = (a, b) => {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function nominatim(q, cc) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '10');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('q', q);
  if (cc) url.searchParams.set('countrycodes', cc);
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
  if (!res.ok) throw new Error(`nominatim ${res.status}`);
  return res.json();
}

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/^(al|el)[\s-]+/, '').replace(/[\u200f\u200e]/g, '');

/**
 * Is this Nominatim row an actual district, rather than something standing inside one —
 * or the city itself?
 *
 * When Nominatim cannot match a district it happily answers with the city that contains it,
 * and a city row passes every type check. Pinning "Khayala Suburb" to the middle of Jeddah
 * would look like an answer and be none, so a row whose own name is the city is refused.
 *
 * @param {object} r            a Nominatim jsonv2 row
 * @param {string} [city]       the city we are looking inside
 * @param {string} [cityAr]     its Arabic name (OSM names Saudi places in Arabic)
 */
export function isDistrictRow(r, city, cityAr) {
  if (!r || !PLACE_CLASSES.has(r.category ?? r.class)) return false;
  if (!PLACE_TYPES.has(r.addresstype) && !PLACE_TYPES.has(r.type)) return false;
  const name = norm(r.name);
  if (name && [city, cityAr].filter(Boolean).some((c) => norm(c) === name)) return false;
  return true;
}

/** Resolve one district, or null when nothing trustworthy comes back. */
export async function resolveDistrict({ district, city, country, districtAr, cityAr }) {
  const anchor = CITY[city];
  // Saudi neighbourhoods are tagged in Arabic in OSM and barely at all in English, so the
  // Arabic phrasings go first; `حي X` ("X district") is how the boundary is usually named.
  const queries = [
    districtAr && cityAr && `${districtAr}، ${cityAr}`,
    districtAr && cityAr && `حي ${districtAr}، ${cityAr}`,
    `${district}, ${city}, ${country}`,
    `${district}, ${city}`,
  ].filter(Boolean);
  for (const q of queries) {
    let rows;
    try { rows = await nominatim(q, anchor?.cc); } catch { await sleep(1100); continue; }
    await sleep(1100);   // Nominatim asks for <= 1 request/second. Be a good citizen.
    for (const r of rows) {
      if (!isDistrictRow(r, city, cityAr)) continue;
      const lat = Number(r.lat), lng = Number(r.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (anchor && km(anchor, { lat, lng }) > MAX_KM_FROM_CITY) continue;
      return {
        lat: round6(lat), lng: round6(lng),
        source: 'nominatim', matched: r.display_name, osm: `${r.osm_type}/${r.osm_id}`,
        query: q, resolvedAt: new Date().toISOString().slice(0, 10),
      };
    }
  }
  return null;
}

/** Every distinct district in listings.json that has no exact pin of its own. */
export function districtsNeeded(listings) {
  const out = new Map();
  for (const l of listings) {
    // Only an EXACT pin means this listing needs no district entry. `listings.json` is
    // written with the district pins ALREADY applied by build.mjs, so treating any `map` as
    // "done" would make every pinned district look unused — and the prune below would
    // delete the very entries the build depends on.
    if (l.map && l.mapPrecision === 'exact') continue;
    const loc = l.location || {};
    const district = loc.district?.en, city = loc.city?.en, country = loc.country?.en;
    if (!district || !city) continue;
    const key = `${district}|${city}`;
    if (!out.has(key)) out.set(key, { district, city, country, districtAr: loc.district?.ar, cityAr: loc.city?.ar, ids: [] });
    out.get(key).ids.push(l.id);
  }
  return out;
}

export const pinKey = (districtEn, cityEn) => `${districtEn}|${cityEn}`;

async function main() {
  const refresh = process.argv.includes('--refresh');
  const listings = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'listings.json'), 'utf8'));
  const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  const needed = districtsNeeded(listings);

  for (const [key, { district, city, country, districtAr, cityAr, ids }] of needed) {
    const have = existing[key];
    if (have && (have.source === 'manual' || !refresh)) {
      console.log(`= ${key.padEnd(40)} ${have.lat}, ${have.lng}  (${have.source})`);
      continue;
    }
    const pin = await resolveDistrict({ district, city, country, districtAr, cityAr });
    if (!pin) {
      console.log(`✗ ${key.padEnd(40)} no trustworthy match — ${ids.join(', ')} keep their district text only`);
      continue;
    }
    existing[key] = pin;
    console.log(`+ ${key.padEnd(40)} ${pin.lat}, ${pin.lng}  ${pin.matched.slice(0, 60)}`);
  }

  // Drop pins for districts no listing uses any more, so the file stays honest.
  for (const key of Object.keys(existing)) if (!needed.has(key)) { delete existing[key]; console.log(`- ${key} (unused)`); }

  fs.writeFileSync(OUT, `${JSON.stringify(Object.fromEntries(Object.entries(existing).sort()), null, 2)}\n`);
  console.log(`\nwrote ${path.relative(ROOT, OUT)} — ${Object.keys(existing).length} district pin(s)`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
