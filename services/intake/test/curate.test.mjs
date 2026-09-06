// Finding 12 — the rules the site builder and validator enforce, and the intake's local
// mirror of them. They are now ONE definition (scripts/curate/rules.mjs) imported by both
// sides, so this file checks the definition rather than that two copies still agree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FORBIDDEN, HYPE, INTAKE_ID_RE, isLocalSrc, LISTING_ID_RE, LOCAL_LAND_STILL,
  LOCAL_LISTING_SRC, LOCAL_LISTING_THUMB, LOCAL_LISTING_VIDEO, PHONE_RE,
} from '../../../scripts/curate/rules.mjs';
import { checkListing } from '../lib/listing.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('listing ids', () => {
  it('accepts both families, with room for the intake counter to grow', () => {
    for (const id of ['BONA-001', 'BONA-999', 'BONA-W001', 'BONA-W0123', 'BONA-W12345']) {
      assert.ok(LISTING_ID_RE.test(id), `${id} should be valid`);
    }
  });
  it('rejects everything else', () => {
    for (const id of ['BONA-1', 'BONA-W1', 'BONA-W12', 'BONA-1234', 'BONA-W123456', 'bona-001', 'BONA-W001 ', 'TK-001']) {
      assert.ok(!LISTING_ID_RE.test(id), `${id} should be rejected`);
    }
  });
  it('the intake only ever allocates the W family', () => {
    assert.ok(INTAKE_ID_RE.test('BONA-W004'));
    assert.ok(!INTAKE_ID_RE.test('BONA-004'));
  });
  it('validate.mjs uses the shared rule', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'curate', 'validate.mjs'), 'utf8');
    assert.match(src, /LISTING_ID_RE\.test\(l\.id/);
    assert.match(src, /from '\.\/rules\.mjs'/);
  });
});

describe('site-local image paths', () => {
  it('accepts exactly the two shapes the site serves', () => {
    assert.ok(LOCAL_LAND_STILL.test('/land/PLOT-12.jpg'));
    assert.ok(LOCAL_LISTING_SRC.test('/listings/five-bedroom-villa/01.jpg'));
    assert.ok(LOCAL_LISTING_THUMB.test('/listings/five-bedroom-villa/01-thumb.webp'));
    assert.ok(isLocalSrc('/land/PLOT-12.jpg') && isLocalSrc('/listings/villa/10.jpg'));
  });

  it('rejects the shapes the old loose regex let through', () => {
    const bad = [
      '/land/sub/dir.jpg',                     // land stills are flat
      '/land/plot.webp',                       // and always .jpg
      '/listings/villa/01.png',                // only jpg/webp
      '/listings/villa/cover.jpg',             // numbered files only
      '/listings/Villa/01.jpg',                // slugs are lowercase
      '/listings/villa/01-thumb.jpg',          // thumbs are webp
      '/listings/villa/a/b/01.jpg',
      '/listings/villa/01.jpg?v=2',
      '/listings/../secrets/01.jpg',
      'listings/villa/01.jpg',
    ];
    for (const s of bad) assert.ok(!isLocalSrc(s) && !LOCAL_LISTING_THUMB.test(s), `${s} should be rejected`);
  });

  it('a thumb is never accepted as a src, and vice versa', () => {
    assert.ok(!LOCAL_LISTING_SRC.test('/listings/villa/01-thumb.webp'));
    assert.ok(!LOCAL_LISTING_THUMB.test('/listings/villa/01.jpg'));
  });

  it('the intake refuses a listing the validator would refuse', () => {
    const listing = {
      id: 'BONA-W001',
      slug: 'five-bedroom-villa',
      title: { en: 'Five-Bedroom Villa', ar: 'فيلا بخمس غرف نوم' },
      price: { amount: 1, currency: 'SAR', onRequest: false, from: false, period: null },
      description: { en: 'a\n\nb', ar: 'أ\n\nب' },
      highlights: { en: ['a', 'b', 'c', 'd'], ar: ['أ', 'ب', 'ج', 'د'] },
      listedAt: '2026-09-06',
      images: new Array(4).fill(null).map((_, i) => ({
        src: `/listings/five-bedroom-villa/0${i + 1}.jpg`,
        thumb: `/listings/five-bedroom-villa/0${i + 1}-thumb.webp`,
        alt: { en: 'x', ar: 'س' },
      })),
    };
    assert.deepEqual(checkListing(listing), []);
    const broken = structuredClone(listing);
    broken.images[0].src = '/listings/five-bedroom-villa/cover.jpg';
    assert.ok(checkListing(broken).some((e) => /images\[0\]\.src/.test(e)));
    const brokenThumb = structuredClone(listing);
    brokenThumb.images[2].thumb = '/listings/five-bedroom-villa/03.webp';
    assert.ok(checkListing(brokenThumb).some((e) => /images\[2\]\.thumb/.test(e)));
  });
});

describe('site-local video paths', () => {
  it('accepts /listings/<slug>/v-nn.mp4', () => {
    assert.ok(LOCAL_LISTING_VIDEO.test('/listings/five-bedroom-villa/v-01.mp4'));
    assert.ok(LOCAL_LISTING_VIDEO.test('/listings/five-bedroom-villa/v-123.mp4'));
  });

  it('rejects a photo\'s shape and anything not the exact video shape', () => {
    for (const s of [
      '/listings/villa/01.jpg',           // a photo, not a video
      '/listings/villa/v-01.mp4?x=1',
      '/listings/villa/v-01.mov',         // only mp4
      '/listings/villa/01.mp4',           // missing the v- prefix
      '/listings/Villa/v-01.mp4',         // slugs are lowercase
      'listings/villa/v-01.mp4',
    ]) assert.ok(!LOCAL_LISTING_VIDEO.test(s), `${s} should be rejected`);
  });

  // checkListing() (services/intake) mirrors validate.mjs (scripts/curate) — a listing the
  // intake would publish must never then fail the site build.
  it('checkListing accepts a listing with videos and refuses a bad one', () => {
    const base = {
      id: 'BONA-W001', slug: 'five-bedroom-villa',
      title: { en: 'Five-Bedroom Villa', ar: 'فيلا بخمس غرف نوم' },
      price: { amount: 1, currency: 'SAR', onRequest: false, from: false, period: null },
      description: { en: 'a\n\nb', ar: 'أ\n\nب' },
      highlights: { en: ['a', 'b', 'c', 'd'], ar: ['أ', 'ب', 'ج', 'د'] },
      listedAt: '2026-09-06',
      images: new Array(4).fill(null).map((_, i) => ({
        src: `/listings/five-bedroom-villa/0${i + 1}.jpg`,
        thumb: `/listings/five-bedroom-villa/0${i + 1}-thumb.webp`,
        alt: { en: 'x', ar: 'س' },
      })),
    };
    assert.deepEqual(checkListing({ ...base, videos: [] }), [], 'empty videos array is fine');
    assert.deepEqual(checkListing({ ...base, videos: ['/listings/five-bedroom-villa/v-01.mp4'] }), []);
    assert.deepEqual(checkListing(base), [], 'no videos key at all is also fine (curated listings predate the field)');
    assert.ok(checkListing({ ...base, videos: 'not-an-array' }).some((e) => /videos must be an array/.test(e)));
    assert.ok(checkListing({ ...base, videos: ['/listings/five-bedroom-villa/01.jpg'] }).some((e) => /videos\[0\]/.test(e)));
  });
});

describe('copy rules', () => {
  it('catch any telephone number, Saudi or international', () => {
    for (const n of ['+966 55 123 4567', '+966551234567', '0551234567', '05 51 23 45 67', '+44 20 7946 0958', '+1 415 555 2671']) {
      assert.ok(PHONE_RE.test(`ring ${n}`), `${n} must be caught`);
      assert.ok(FORBIDDEN.some((re) => re.test(`ring ${n}`)));
    }
  });

  it('leave real listing copy alone', () => {
    for (const s of ['SAR 4,500,000', '537 sqm of built-up area', 'built in 2019', 'five bedrooms and 05 parking bays'.replace('05', 'five'), 'Jeddah 21589']) {
      assert.ok(!PHONE_RE.test(s), `${s} must not look like a phone number`);
      assert.ok(!HYPE.test(s));
    }
  });

  it('still catch the old brand', () => {
    assert.ok(FORBIDDEN.some((re) => re.test('Marketed by TK Estates')));
    assert.ok(FORBIDDEN.some((re) => re.test('see tk-estates.com')));
  });
});

describe('build.mjs', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts', 'curate', 'build.mjs'), 'utf8');
  it('stats BOTH src and thumb for every site-local image', () => {
    assert.match(src, /for \(const field of \['src', 'thumb'\]\)/);
    assert.equal((src.match(/for \(const field of \['src', 'thumb'\]\)/g) || []).length, 2, 'the inbox loop and the published loop');
  });
  it('reports the published set, not the pre-filter candidate list', () => {
    const line = /console\.log\(`wrote \$\{[^`]*`\)/.exec(src);
    assert.ok(line, 'summary line not found');
    assert.ok(!/\bout\.length\b/.test(line[0]), 'the summary must not count the dropped listings');
    assert.match(line[0], /published\.length/);
  });
});
