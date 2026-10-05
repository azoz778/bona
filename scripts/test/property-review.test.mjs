import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { policyRules, eligibility, sha256 } from '../social/lib/property-daily.mjs';
import { frameProblem, aspectConsistent, parseSelection, disclosuresFor, buildReview, sameReview, liveCatalogue } from '../social/lib/property-review.mjs';
import { main as draft } from '../social/draft-property-reviews.mjs';
import { main as approve } from '../social/approve-property-review.mjs';

const now = new Date('2026-10-05T10:00:00Z');
const WAIVER = { version: 1, mode: 'property-photography', time: '20:30', timezone: 'Asia/Riyadh', repeatDays: 30, catalogueUrl: 'https://bona-real-estate.com/social-catalogue.json', channels: ['instagram', 'facebook'], adLicence: { requirement: 'waived', by: 'owner', on: '2026-10-05' }, countries: ['SA'], categories: ['buy', 'rent', 'off-plan'], renders: 'off-plan-only', reviewValidDays: 90 };
const advertiser = { name: { ar: 'المعلن التجريبي', en: 'Fixture advertiser' }, fal: '1100000000', phone: '+966500000000' };
const jpeg = (width, height, background) => sharp({ create: { width, height, channels: 3, background } }).jpeg().toBuffer();
async function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-review-'));
  fs.mkdirSync(path.join(root, 'marketing/daily'), { recursive: true });
  fs.writeFileSync(path.join(root, 'marketing/daily/property-policy.json'), JSON.stringify(WAIVER));
  fs.writeFileSync(path.join(root, 'marketing/daily/property-reviews.json'), '{}\n');
  const images = {
    '/listings/villa/1.jpg': await jpeg(1920, 1280, '#336699'),
    '/listings/villa/2.jpg': await jpeg(1920, 1280, '#669933'),
    '/listings/villa/3.jpg': await jpeg(1800, 1200, '#993366'),
    '/listings/villa/4.jpg': await jpeg(800, 600, '#999999'),
    '/listings/villa/5.jpg': await jpeg(1080, 1350, '#333333'),
  };
  const villa = { id: 'BONA-T1', slug: 'villa', status: 'available', category: 'buy', type: 'villa',
    location: { countryCode: 'SA', district: { ar: 'الشاطئ', en: 'Al Shati' }, city: { ar: 'جدة', en: 'Jeddah' } },
    title: { ar: 'فيلا تجريبية', en: 'Fixture villa' }, price: { amount: 5000000, currency: 'SAR', from: false, onRequest: false }, specs: { beds: 5 },
    images: Object.keys(images).map((src, i) => ({ src, alt: { ar: `صورة ${i + 1}`, en: `Photo ${i + 1}` } })), licence: null };
  const muscat = { ...villa, id: 'BONA-T2', slug: 'muscat', location: { ...villa.location, countryCode: 'OM' } };
  const state = { listings: [villa, muscat] };
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/social-catalogue.json') return Response.json({ version: 1, generatedAt: '2026-10-05T06:00:00Z', advertiser, listings: state.listings });
    const body = images[u.pathname];
    if (!body) return new Response('missing', { status: 404 });
    return new Response(body, { headers: { 'content-type': 'image/jpeg' } });
  };
  return { root, fetchImpl, state, villa, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('frame rules match the publisher: JPEG, at most 8 MB, at least 1080x720, aspect 0.8 to 1.91', () => {
  const ok = { contentType: 'image/jpeg', bytes: 500_000, width: 1920, height: 1280 };
  assert.equal(frameProblem(ok), null);
  assert.equal(frameProblem({ ...ok, contentType: 'image/png' }), 'not_jpeg');
  assert.equal(frameProblem({ ...ok, bytes: 8_000_001 }), 'too_large');
  assert.equal(frameProblem({ ...ok, width: 1024, height: 768 }), 'too_small');
  assert.equal(frameProblem({ ...ok, width: 1484, height: 1920 }), 'aspect');
  assert.equal(frameProblem({ ...ok, width: 1920, height: 960 }), 'aspect');
  assert.equal(frameProblem({ ...ok, width: 1080, height: 1350 }), null);
});
test('a carousel keeps frames within 15% of the first frame aspect, and selections are 3 to 6 distinct frames', () => {
  assert.equal(aspectConsistent([{ width: 1920, height: 1280 }, { width: 1800, height: 1200 }, { width: 1920, height: 1200 }]), true);
  assert.equal(aspectConsistent([{ width: 1920, height: 1280 }, { width: 1080, height: 1350 }]), false);
  assert.deepEqual(parseSelection('BONA-W013:1,2r,5p'), { id: 'BONA-W013', frames: [{ index: 1, kind: null }, { index: 2, kind: 'render' }, { index: 5, kind: 'photograph' }] });
  assert.throws(() => parseSelection('BONA-001:1,2'), /3–6 frames/);
  assert.throws(() => parseSelection('BONA-001:1,2,3,4,5,6,7'), /3–6 frames/);
  assert.throws(() => parseSelection('BONA-001:1,1,2'), /Duplicate/);
});
test('the live catalogue must be fresh JSON', async () => {
  const stale = async () => Response.json({ version: 1, generatedAt: '2026-10-01T00:00:00Z', advertiser, listings: [] });
  await assert.rejects(liveCatalogue(stale, now), /invalid or stale/);
  const html = async () => new Response('<html>', { headers: { 'content-type': 'text/html' } });
  await assert.rejects(liveCatalogue(html, now), /unavailable/);
});
test('a built review passes eligibility under the waiver, renders default for off-plan, and re-approval is idempotent', async () => {
  const w = await world();
  try {
    const rules = policyRules(WAIVER, now);
    const frames = [1, 2, 3].map(index => ({ index, url: `https://bona-real-estate.com/listings/villa/${index}.jpg`, sha256: sha256('x' + index), width: 1920, height: 1280, alt: { ar: 'صورة', en: 'Photo' } }));
    const r = buildReview(w.villa, advertiser, frames, parseSelection('BONA-T1:1,2,3'), { reviewedAt: '2026-10-05T09:00:00Z', reviewer: 'test' });
    assert.deepEqual(eligibility(w.villa, r, advertiser, now, rules), []);
    assert.equal(r.licenceEvidence, null);
    assert.deepEqual(r.legalDisclosures, disclosuresFor(w.villa));
    assert.ok(r.photos.every(x => x.kind === 'photograph' && x.visuallyApproved === true));
    const offPlan = { ...w.villa, category: 'off-plan' };
    const ro = buildReview(offPlan, advertiser, frames, parseSelection('BONA-T1:1,2,3p'), { reviewedAt: '2026-10-05T09:00:00Z', reviewer: 'test' });
    assert.deepEqual(ro.photos.map(x => x.kind), ['render', 'render', 'photograph']);
    assert.match(ro.legalDisclosures.en, /per the developer/);
    assert.deepEqual(eligibility(offPlan, ro, advertiser, now, rules), []);
    assert.throws(() => buildReview(w.villa, advertiser, frames, parseSelection('BONA-T1:1,2,9'), { reviewedAt: 'x', reviewer: 'y' }), /frame 9/);
    assert.equal(sameReview(r, { ...r, reviewedAt: '2026-10-06T09:00:00Z', reviewer: 'someone else' }), true);
    assert.equal(sameReview(r, { ...r, photos: r.photos.slice(0, 3).reverse() }), false);
  } finally { w.cleanup(); }
});
test('drafting writes usable frames, a contact sheet and drafts.json for in-scope listings only, and never touches the register', async () => {
  const w = await world();
  try {
    const out = path.join(w.root, 'drafts');
    const d = await draft(['--out', out], { fetchImpl: w.fetchImpl, now, root: w.root, log: () => {} });
    assert.deepEqual(Object.keys(d.listings), ['BONA-T1']);
    const t1 = d.listings['BONA-T1'];
    assert.deepEqual(t1.frames.map(f => f.index), [1, 2, 3, 5]);
    assert.deepEqual(t1.rejected, [{ index: 4, why: 'too_small', width: 800, height: 600 }]);
    for (const f of t1.frames) { assert.equal(sha256(fs.readFileSync(path.join(out, f.file))), f.sha256); assert.equal(f.buffer, undefined); }
    const sheet = await sharp(path.join(out, t1.sheet)).metadata();
    assert.equal(sheet.format, 'jpeg');
    assert.equal(sheet.width, 1440);
    assert.equal(fs.readFileSync(path.join(w.root, 'marketing/daily/property-reviews.json'), 'utf8'), '{}\n');
    assert.ok(fs.existsSync(path.join(out, 'drafts.json')));
    await assert.rejects(draft(['--out', out], { fetchImpl: w.fetchImpl, now, root: w.root, log: () => {} }), /new output directory/);
  } finally { w.cleanup(); }
});
test('approving writes eligible reviews, refuses rejected frames or changed listings, and re-approval leaves the register alone', async () => {
  const w = await world();
  try {
    const out = path.join(w.root, 'drafts');
    await draft(['--out', out], { fetchImpl: w.fetchImpl, now, root: w.root, log: () => {} });
    const drafts = path.join(out, 'drafts.json');
    const reg = path.join(w.root, 'marketing/daily/property-reviews.json');
    const run = (select, at = now, reviewer = 'test reviewer') => approve(['--drafts', drafts, '--reviewer', reviewer, '--select', select], { fetchImpl: w.fetchImpl, now: at, root: w.root, log: () => {} });
    assert.deepEqual(await run('BONA-T1:1,2,3'), { written: 1, unchanged: 0, refused: [] });
    const saved = JSON.parse(fs.readFileSync(reg, 'utf8'))['BONA-T1'];
    assert.equal(saved.reviewer, 'test reviewer');
    assert.equal(saved.photos.length, 3);
    assert.deepEqual(eligibility(w.villa, saved, advertiser, now, policyRules(WAIVER, now)), []);
    const before = fs.readFileSync(reg, 'utf8');
    assert.deepEqual(await run('BONA-T1:1,2,3', new Date('2026-10-05T11:00:00Z')), { written: 0, unchanged: 1, refused: [] });
    assert.equal(fs.readFileSync(reg, 'utf8'), before);
    const rejected = await run('BONA-T1:1,2,4', now, 'r');
    assert.equal(rejected.written, 0);
    assert.match(rejected.refused[0], /frame 4/);
    assert.match((await run('BONA-T1:1,2,5', now, 'r')).refused[0], /aspect/);
    w.state.listings = [{ ...w.villa, price: { ...w.villa.price, amount: 4900000 } }];
    assert.match((await run('BONA-T1:1,2,3', now, 'r')).refused[0], /changed since drafting/);
    assert.equal(fs.readFileSync(reg, 'utf8'), before);
  } finally { w.cleanup(); }
});
test('every entry in the repository review register is well-formed', () => {
  const reg = JSON.parse(fs.readFileSync(new URL('../../marketing/daily/property-reviews.json', import.meta.url), 'utf8'));
  for (const [id, r] of Object.entries(reg)) {
    assert.match(id, /^BONA-[A-Z]?\d+$/);
    assert.equal(r.status, 'approved', id);
    for (const k of ['factsSha256', 'advertiserSha256', 'captionSha256']) assert.match(r[k], /^[a-f0-9]{64}$/, `${id} ${k}`);
    assert.ok(Number.isFinite(Date.parse(r.reviewedAt)) && typeof r.reviewer === 'string' && r.reviewer.trim(), id);
    assert.equal(r.legalDisclosuresVerified, true, id);
    assert.ok(r.photos.length >= 3 && r.photos.length <= 6, id);
    for (const p of r.photos) {
      assert.match(p.url, /^https:\/\/(bona-real-estate\.com|tk-storage\.azoz\.uk)\/.+\.jpe?g$/i, id);
      assert.ok(['photograph', 'render'].includes(p.kind) && p.visuallyApproved === true && /^[a-f0-9]{64}$/.test(p.sha256), id);
    }
  }
});
