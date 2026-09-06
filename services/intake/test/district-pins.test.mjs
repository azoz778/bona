// The gate that decides whether a Nominatim row is really a district.
// Every row below is a real response shape seen while pinning Bona's districts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDistrictRow, districtsNeeded, pinKey } from '../../../scripts/curate/district-pins.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('isDistrictRow', () => {
  it('accepts an administrative boundary (the Jeddah districts)', () => {
    assert.equal(isDistrictRow({ category: 'boundary', type: 'administrative', addresstype: 'neighbourhood' }), true);
  });

  it('accepts a place/neighbourhood (Meydan, Dubai)', () => {
    assert.equal(isDistrictRow({ category: 'place', type: 'neighbourhood', addresstype: 'neighbourhood' }), true);
  });

  it('rejects a bank that merely stands in the district', () => {
    // The first result Nominatim gave for "Al Nuzhah, Jeddah" was Al-Ahly Bank, 60 km off.
    assert.equal(isDistrictRow({ category: 'amenity', type: 'bank', addresstype: 'amenity' }), false);
  });

  it('rejects a golf resort inside the district (the Benahavís trap)', () => {
    assert.equal(isDistrictRow({ category: 'leisure', type: 'golf_course', addresstype: 'leisure' }), false);
  });

  it('rejects a road named after the district (the Al-Murjan trap)', () => {
    assert.equal(isDistrictRow({ category: 'highway', type: 'secondary', addresstype: 'road' }), false);
  });

  it('rejects the city itself standing in for a district it could not find', () => {
    // Nominatim answers an unmatched district query with the city. Pinning "Khayala Suburb"
    // to the middle of Jeddah would look like an answer and be none.
    assert.equal(isDistrictRow({ category: 'place', type: 'city', addresstype: 'city', name: 'Jeddah' }, 'Jeddah'), false);
    assert.equal(isDistrictRow({ category: 'boundary', type: 'administrative', addresstype: 'city', name: 'جدة' }, 'Jeddah', 'جدة'), false);
  });

  it('accepts a town or village that is a real place inside the city, not the city itself', () => {
    // Benahavís is a village near Marbella — a genuine answer for a Marbella listing.
    assert.equal(isDistrictRow({ category: 'boundary', type: 'administrative', addresstype: 'village', name: 'Benahavís' }, 'Marbella'), true);
    // Le Vésinet named for a Le Vésinet listing is the city fallback, not a district.
    assert.equal(isDistrictRow({ category: 'boundary', type: 'administrative', addresstype: 'town', name: 'Le Vésinet' }, 'Le Vésinet'), false);
  });

  it('rejects a shop, a building and junk', () => {
    assert.equal(isDistrictRow({ category: 'shop', type: 'supermarket', addresstype: 'shop' }), false);
    assert.equal(isDistrictRow({ category: 'building', type: 'school', addresstype: 'building' }), false);
    assert.equal(isDistrictRow(null), false);
    assert.equal(isDistrictRow({}), false);
  });
});

describe('districtsNeeded', () => {
  it('skips listings that already carry an exact pin', () => {
    const need = districtsNeeded([
      { id: 'A', map: { lat: 1, lng: 2 }, mapPrecision: 'exact', location: { district: { en: 'Pinned' }, city: { en: 'Jeddah' } } },
      { id: 'B', map: null, location: { district: { en: 'Unpinned' }, city: { en: 'Jeddah' } } },
    ]);
    assert.deepEqual([...need.keys()], ['Unpinned|Jeddah']);
  });

  it('still needs a district whose pin the BUILD filled in', () => {
    // listings.json is written with the district pins already applied. If a re-run read
    // those as "already pinned", the district would look unused and its entry would be
    // deleted from district-pins.json — and the next build would drop the pin entirely.
    const need = districtsNeeded([
      { id: 'A', map: { lat: 21.6, lng: 39.1 }, mapPrecision: 'district', location: { district: { en: 'Al Nuzhah' }, city: { en: 'Jeddah' } } },
    ]);
    assert.deepEqual([...need.keys()], ['Al Nuzhah|Jeddah']);
  });

  it('groups every listing sharing a district under one key', () => {
    const need = districtsNeeded([
      { id: 'A', location: { district: { en: 'Al Nuzhah' }, city: { en: 'Jeddah' } } },
      { id: 'B', location: { district: { en: 'Al Nuzhah' }, city: { en: 'Jeddah' } } },
    ]);
    assert.deepEqual(need.get('Al Nuzhah|Jeddah').ids, ['A', 'B']);
  });

  it('ignores a listing with no district', () => {
    assert.equal(districtsNeeded([{ id: 'A', location: {} }]).size, 0);
  });
});

describe('district-pins.json', () => {
  const pins = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'district-pins.json'), 'utf8'));
  const listings = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'listings.json'), 'utf8'));

  it('holds well-formed coordinates and provenance for every entry', () => {
    for (const [key, p] of Object.entries(pins)) {
      assert.ok(Number.isFinite(p.lat) && Math.abs(p.lat) <= 90, `${key}: lat`);
      assert.ok(Number.isFinite(p.lng) && Math.abs(p.lng) <= 180, `${key}: lng`);
      assert.ok(['nominatim', 'manual'].includes(p.source), `${key}: source`);
      // Provenance is the whole point: a pin nobody can trace back cannot be checked.
      assert.ok(typeof p.matched === 'string' && p.matched.length, `${key}: matched`);
    }
  });

  it('marks every district-level pin as approximate in listings.json', () => {
    for (const l of listings) {
      if (!l.map) { assert.equal(l.mapPrecision, null, `${l.id}: no pin => no precision`); continue; }
      assert.ok(['exact', 'district'].includes(l.mapPrecision), `${l.id}: ${l.mapPrecision}`);
      if (l.mapPrecision !== 'district') continue;
      const p = pins[pinKey(l.location.district.en, l.location.city.en)];
      assert.ok(p, `${l.id}: district pin missing from district-pins.json`);
      assert.deepEqual(l.map, { lat: p.lat, lng: p.lng }, `${l.id}: pin drifted from the table`);
    }
  });

  it('never gives a land plot a district centroid (they need the real plot pin)', () => {
    for (const l of listings) {
      if (l.kind === 'land') assert.equal(l.mapPrecision, 'exact', `${l.id}: land must be exact`);
    }
  });
});
