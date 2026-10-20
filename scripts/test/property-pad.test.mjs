// Padded 4:5 frames (owner, 2026-10-21): mixed-aspect listings are published with every frame
// centred whole on a 1080x1350 brand canvas, hosted under /social/property/<id>/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { PAD_FIT, PAD_ASPECT, MEDIA_SIZE, mediaBase, mediaUrl, aspectConsistent, eligibility, policyRules, sha256, fingerprint, advertiserFingerprint, reviewedCopy, entryFor, frameOrders, pickFrames } from '../social/lib/property-daily.mjs';
import { frameProblem, buildReview } from '../social/lib/property-review.mjs';
import { padFrame, PAD_BAND, writeMedia } from '../social/lib/property-media.mjs';
import { photos } from '../social/property-publish.mjs';
import { main as draft } from '../social/draft-property-reviews.mjs';
import { main as approve } from '../social/approve-property-review.mjs';
import { run as browserRun, mediaStyle } from '../social/browser-publish.mjs';

const SITE = 'https://bona-real-estate.com';
const now = new Date('2026-10-21T10:00:00Z');
const POLICY = { version: 1, mode: 'property-photography', time: '20:30', timezone: 'Asia/Riyadh', repeatDays: 14, catalogueUrl: `${SITE}/social-catalogue.json`, channels: ['instagram', 'facebook'], adLicence: { requirement: 'waived', by: 'owner', on: '2026-10-05' }, countries: ['SA'], categories: ['buy', 'rent', 'off-plan'], renders: 'off-plan-only', reviewValidDays: 90 };
const RULES = policyRules(POLICY, now);
const advertiser = { name: { ar: 'المعلن التجريبي', en: 'Fixture advertiser' }, fal: '1100000000', phone: '+966500000000' };
const jpeg = (width, height, background) => sharp({ create: { width, height, channels: 3, background } }).jpeg({ quality: 95 }).toBuffer();
const quiet = () => {};

function listing(id = 'BONA-P1', extra = {}) {
  return { id, slug: id.toLowerCase(), status: 'available', category: 'buy', type: 'apartment',
    location: { countryCode: 'SA', district: { ar: 'الروضة', en: 'Al Rawdah' }, city: { ar: 'جدة', en: 'Jeddah' } },
    title: { ar: 'شقة تجريبية', en: 'Fixture apartment' }, price: { amount: 1800000, currency: 'SAR', from: false, onRequest: false }, specs: { beds: 3 },
    images: [1, 2, 3, 4].map(i => ({ src: `/listings/${id.toLowerCase()}/${i}.jpg`, alt: { ar: `صورة ${i}`, en: `Photo ${i}` } })), licence: null, ...extra };
}
/** A padded review of frames with the given source sizes. */
function paddedReview(p, sizes, { media = i => ({ url: `${mediaBase(p.id)}pad-${i}.jpg`, sha256: sha256(`m${i}`), ...MEDIA_SIZE }) } = {}) {
  const r = { status: 'approved', reviewedAt: '2026-10-20T09:00:00Z', reviewer: 'fixture', factsSha256: fingerprint(p), advertiserSha256: advertiserFingerprint(advertiser),
    captionSha256: null, licenceEvidence: null, legalDisclosuresVerified: true,
    legalDisclosures: { ar: 'الأسعار المعروضة هي الأسعار المطلوبة وقابلة للتغيير.', en: 'Prices shown are asking prices and may change.' },
    photos: sizes.map(([width, height], i) => ({ url: SITE + p.images[i].src, sha256: sha256(`s${i}`), width, height, kind: 'photograph', visuallyApproved: true,
      alt: p.images[i].alt, fit: PAD_FIT, media: media(i) })) };
  r.captionSha256 = sha256(JSON.stringify(reviewedCopy(p, advertiser, r)));
  return r;
}
const unpadded = r => {
  const out = { ...r, photos: r.photos.map(({ fit, media, ...x }) => x) };
  return out;
};
const MIXED = [[1920, 1280], [1484, 1920], [1200, 1600]];

test('pad frame rules: a portrait source under 0.8 (down to 9:16) is fine padded; the size floor still applies to the source', () => {
  const f = { contentType: 'image/jpeg', bytes: 500_000 };
  assert.equal(frameProblem({ ...f, width: 1484, height: 1920 }), 'aspect', 'unpadded: Instagram would crop it');
  assert.equal(frameProblem({ ...f, width: 1484, height: 1920 }, { pad: true }), null);
  assert.equal(frameProblem({ ...f, width: 1080, height: 1920 }, { pad: true }), null, '9:16 is the narrowest');
  assert.equal(frameProblem({ ...f, width: 1080, height: 2000 }, { pad: true }), 'aspect');
  assert.equal(frameProblem({ ...f, width: 1000, height: 1500 }, { pad: true }), 'too_small', 'size floor applies to the source');
  assert.equal(PAD_ASPECT.min, 0.56);
});

test('padFrame: 1080x1350 JPEG, the photo whole and centred above the mark band, no crop or stretch, deterministic', async () => {
  const src = await jpeg(1484, 1920, '#cc3311');
  const a = await padFrame(src), b = await padFrame(src);
  assert.equal(sha256(a), sha256(b), 'same source bytes, same padded bytes');
  const meta = await sharp(a).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 1080, 1350]);
  const { data, info } = await sharp(a).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => [...data.slice((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
  const red = c => c[0] > 180 && c[1] < 90 && c[2] < 70, ink = c => c.every(v => v < 40);
  // 1484x1920 fitted into 1080x1230: 951x1230, so 64 px of ink each side and the band below.
  const boxH = 1350 - PAD_BAND, w = Math.round(1484 * boxH / 1920), left = Math.round((1080 - w) / 2);
  assert.ok(ink(px(left - 8, 600)) && ink(px(1080 - left + 8, 600)), 'ink either side');
  assert.ok(red(px(left + 8, 4)) && red(px(left + 8, boxH - 4)) && red(px(1080 - left - 8, 600)), 'the whole photo is there, edge to edge in height');
  assert.ok(ink(px(20, boxH + 10)), 'the band under the photo is ink');
  // A landscape source is fitted to the width with ink above and below.
  const wide = await sharp(await padFrame(await jpeg(1920, 1280, '#2255cc'))).raw().toBuffer({ resolveWithObject: true });
  const at = (x, y) => [...wide.data.slice((y * 1080 + x) * 3, (y * 1080 + x) * 3 + 3)];
  assert.ok(at(540, 100).every(v => v < 40) && at(540, 615)[2] > 150 && at(2, 615)[2] > 150, 'full width, ink above');
});

test('eligibility: a padded mixed-aspect set is eligible; the same frames unpadded are not', () => {
  const p = listing(), r = paddedReview(p, MIXED);
  assert.deepEqual(eligibility(p, r, advertiser, now, RULES), []);
  assert.equal(aspectConsistent(r.photos), true, 'padded frames all count at 4:5');
  const plain = unpadded(r);
  plain.captionSha256 = sha256(JSON.stringify(reviewedCopy(p, advertiser, plain)));
  const why = eligibility(p, plain, advertiser, now, RULES);
  assert.ok(why.includes('carousel_aspect_mismatch') && why.includes('photo_quality_or_provenance_unverified'), why.join());
});

test('eligibility: padded media must be this listing\'s hosted 1080x1350 JPEG with a hash, and the source keeps its own rules', () => {
  const p = listing();
  const bad = media => eligibility(p, paddedReview(p, MIXED, { media }), advertiser, now, RULES);
  assert.ok(bad(i => ({ url: `${mediaBase('BONA-OTHER')}pad-${i}.jpg`, sha256: sha256('x'), ...MEDIA_SIZE })).includes('padded_media_unverified'), 'another listing\'s folder');
  assert.ok(bad(i => ({ url: `https://example.com/social/property/BONA-P1/pad-${i}.jpg`, sha256: sha256('x'), ...MEDIA_SIZE })).includes('padded_media_unverified'));
  assert.ok(bad(i => ({ url: `${mediaBase(p.id)}pad-${i}.jpg`, sha256: sha256('x'), width: 1080, height: 1080 })).includes('padded_media_unverified'));
  assert.ok(bad(() => ({ url: `${mediaBase(p.id)}pad.jpg`, sha256: 'nope', ...MEDIA_SIZE })).includes('padded_media_unverified'));
  assert.ok(bad(() => null).includes('padded_media_unverified'));
  const fit = paddedReview(p, MIXED); fit.photos[1].fit = 'pad-1x1';
  assert.ok(eligibility(p, fit, advertiser, now, RULES).includes('padded_media_unverified'), 'unknown fit');
  assert.ok(eligibility(p, paddedReview(p, [[1920, 1280], [1000, 1500], [1200, 1600]]), advertiser, now, RULES).includes('photo_quality_or_provenance_unverified'), 'source under the size floor');
  assert.ok(eligibility(p, paddedReview(p, [[1920, 1280], [1080, 2100], [1200, 1600]]), advertiser, now, RULES).includes('photo_quality_or_provenance_unverified'), 'narrower than 9:16');
});

test('padded frames: Instagram gets the padded URLs; the journal keeps the source URLs; every repeat order qualifies', () => {
  const p = listing(), r = paddedReview(p, MIXED);
  const e = entryFor(p, r, advertiser, 'instagram', '2026-10-21');
  assert.deepEqual(e.images, r.photos.map(x => x.media.url));
  assert.equal(mediaUrl({ url: 'a', fit: PAD_FIT, media: { url: 'b' } }), 'b');
  assert.equal(mediaUrl({ url: 'a' }), 'a');
  assert.equal(frameOrders(r.photos).length, 6, 'with every slide at 4:5, every cover qualifies');
  const pick = pickFrames(r, [], 'instagram', p.id);
  assert.deepEqual(pick.images, r.photos.map(x => x.url));
});

test('publisher download: a padded frame checks its source and its padded bytes, and posts the padded bytes', async () => {
  const p = listing(), bytes = { src: await jpeg(1484, 1920, '#aa0000') };
  bytes.pad = await padFrame(bytes.src);
  const r = paddedReview(p, [[1484, 1920]], { media: () => ({ url: `${mediaBase(p.id)}pad-a.jpg`, sha256: sha256(bytes.pad), ...MEDIA_SIZE }) });
  r.photos[0].sha256 = sha256(bytes.src);
  const served = { [r.photos[0].url]: bytes.src, [r.photos[0].media.url]: bytes.pad };
  const seen = [];
  const fetchImpl = async url => { seen.push(url); return served[url] ? new Response(served[url], { headers: { 'content-type': 'image/jpeg' } }) : new Response('no', { status: 404 }); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-pad-'));
  const files = await photos(r, dir, false, fetchImpl);
  assert.deepEqual(seen, [r.photos[0].url, r.photos[0].media.url], 'source checked, then the padded variant');
  assert.equal(sha256(fs.readFileSync(files[0])), sha256(bytes.pad), 'the padded bytes are what is posted');
  const withSources = await photos(r, dir, false, fetchImpl, { sources: true });
  assert.equal(sha256(fs.readFileSync(withSources[0].source)), sha256(bytes.src));
  served[r.photos[0].media.url] = await padFrame(await jpeg(1484, 1920, '#00aa00'));
  await assert.rejects(photos(r, dir, true, fetchImpl), /changed since visual review/, 'changed padded bytes stop the run');
  served[r.photos[0].media.url] = bytes.pad; served[r.photos[0].url] = await jpeg(1484, 1920, '#0000aa');
  await assert.rejects(photos(r, dir, true, fetchImpl), /changed since visual review/, 'changed source bytes stop the run');
  fs.rmSync(dir, { recursive: true, force: true });
});

async function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-padworld-'));
  fs.mkdirSync(path.join(root, 'marketing/daily'), { recursive: true });
  fs.writeFileSync(path.join(root, 'marketing/daily/property-policy.json'), JSON.stringify(POLICY));
  fs.writeFileSync(path.join(root, 'marketing/daily/property-reviews.json'), '{}\n');
  const p = listing();
  const images = {
    [p.images[0].src]: await jpeg(1920, 1280, '#336699'), [p.images[1].src]: await jpeg(1484, 1920, '#669933'),
    [p.images[2].src]: await jpeg(1200, 1600, '#993366'), [p.images[3].src]: await jpeg(1080, 2100, '#999999'),
  };
  const fetchImpl = async url => {
    const u = new URL(url);
    if (u.pathname === '/social-catalogue.json') return Response.json({ version: 1, generatedAt: '2026-10-21T06:00:00Z', advertiser, listings: [p] });
    return images[u.pathname] ? new Response(images[u.pathname], { headers: { 'content-type': 'image/jpeg' } }) : new Response('missing', { status: 404 });
  };
  return { root, p, images, fetchImpl, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('draft keeps a portrait frame usable only padded and marks it; approve refuses it without --pad and pads it with --pad', async () => {
  const w = await world();
  try {
    const out = path.join(w.root, 'drafts');
    const d = await draft(['--out', out], { fetchImpl: w.fetchImpl, now, root: w.root, log: quiet });
    const frames = d.listings[w.p.id].frames;
    assert.deepEqual(frames.map(f => [f.index, Boolean(f.padOnly)]), [[1, false], [2, true], [3, true]]);
    assert.deepEqual(d.listings[w.p.id].rejected.map(x => [x.index, x.why]), [[4, 'aspect']], 'past 9:16 even padded');
    const args = ['--drafts', path.join(out, 'drafts.json'), '--reviewer', 'fixture reviewer', '--select', `${w.p.id}:1,2,3`];
    const no = await approve(args, { fetchImpl: w.fetchImpl, now, root: w.root, log: quiet });
    assert.equal(no.written, 0);
    assert.match(no.refused[0], /outside the 0\.8–1\.91 aspect; approve the listing padded \(--pad BONA-P1\)/);
    const yes = await approve([...args, '--pad', w.p.id], { fetchImpl: w.fetchImpl, now, root: w.root, log: quiet });
    assert.deepEqual([yes.written, yes.refused], [1, []]);
    const r = JSON.parse(fs.readFileSync(path.join(w.root, 'marketing/daily/property-reviews.json'), 'utf8'))[w.p.id];
    assert.ok(r.photos.every(x => x.fit === PAD_FIT && x.media.url.startsWith(`${SITE}/social/property/BONA-P1/pad-`)));
    for (const [i, x] of r.photos.entries()) {
      const file = path.join(w.root, 'public', new URL(x.media.url).pathname);
      const bytes = fs.readFileSync(file);
      assert.equal(sha256(bytes), x.media.sha256, 'the hosted file is the reviewed one');
      assert.equal(sha256(bytes), sha256(await padFrame(w.images[w.p.images[i].src])), 'rendered from the reviewed source');
    }
    assert.deepEqual(eligibility(w.p, r, advertiser, now, RULES), []);
    const again = await approve([...args, '--pad', w.p.id], { fetchImpl: w.fetchImpl, now, root: w.root, log: quiet });
    assert.equal(again.unchanged, 1, 'deterministic: re-approval is the same review');
    assert.match((await approve(['--drafts', path.join(out, 'drafts.json'), '--reviewer', 'x', '--select', `${w.p.id}:1,2,3`, '--pad', 'BONA-NOPE'], { fetchImpl: w.fetchImpl, now, root: w.root, log: quiet })).refused.join(), /BONA-NOPE: --pad without a --select/);
  } finally { w.cleanup(); }
});

test('writeMedia: content-addressed under public/social/property/<id>/, 1080x1350 JPEG only', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-media-'));
  const b = await padFrame(await jpeg(1600, 1200, '#123456'));
  const m = await writeMedia(root, 'BONA-P1', 'pad-x', b);
  assert.equal(m.url, `${SITE}/social/property/BONA-P1/pad-x-${sha256(b).slice(0, 12)}.jpg`);
  assert.ok(fs.existsSync(path.join(root, 'public/social/property/BONA-P1', path.basename(m.url))));
  await assert.rejects(writeMedia(root, 'BONA-P1', 'bad', await jpeg(1080, 1080, '#000')), /not a 1080x1350 JPEG/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('TikTok and LinkedIn: a padded review makes a 9:16 padded reel from the source photos and LinkedIn images without a second mark', async () => {
  const p = listing(), bytes = [await jpeg(1920, 1280, '#aa0000'), await jpeg(1484, 1920, '#00aa00'), await jpeg(1200, 1600, '#0000aa')];
  const pads = await Promise.all(bytes.map(b => padFrame(b)));
  const r = paddedReview(p, MIXED, { media: i => ({ url: `${mediaBase(p.id)}pad-${i}.jpg`, sha256: sha256(pads[i]), ...MEDIA_SIZE }) });
  r.photos.forEach((x, i) => { x.sha256 = sha256(bytes[i]); });
  r.captionSha256 = sha256(JSON.stringify(reviewedCopy(p, advertiser, r)));
  assert.deepEqual(mediaStyle(r), { pad: true });
  assert.deepEqual(mediaStyle(unpadded(r)), { pad: false });
  const served = Object.fromEntries(r.photos.flatMap((x, i) => [[x.url, bytes[i]], [x.media.url, pads[i]]]));
  const fetchImpl = async url => new Response(served[url], { headers: { 'content-type': 'image/jpeg' } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-padrun-'));
  const root = path.join(dir, 'repo');
  fs.mkdirSync(path.join(root, 'marketing/daily'), { recursive: true });
  fs.writeFileSync(path.join(root, 'marketing/daily/property-policy.json'), JSON.stringify(POLICY));
  fs.writeFileSync(path.join(root, 'marketing/daily/property-reviews.json'), JSON.stringify({ [p.id]: r }));
  fs.writeFileSync(path.join(root, 'marketing/daily/content.json'), '[]');
  const calls = [];
  const touch = f => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); return f; };
  const deps = { fal: '1100000000', fetchImpl, catalogue: async () => ({ listings: [p], advertiser }), downloadReviewedPhotos: photos,
    media: {
      propertyReel: (l, frames, lines, out, opts) => { calls.push(['reel', frames.map(f => sha256(fs.readFileSync(f))), opts]); return touch(out); },
      linkedinPropertyImages: async (frames, d, opts) => { calls.push(['li', frames.map(f => sha256(fs.readFileSync(f))), opts]); return frames.map((_, i) => touch(path.join(d, `li-${i}.jpg`))); },
    } };
  const at = { tiktok: new Date('2026-10-21T18:45:00Z'), linkedin: new Date('2026-10-21T06:30:00Z') };
  for (const channel of ['tiktok', 'linkedin']) {
    const res = await browserRun(channel, { renderOnly: true, env: { BONA_DATA: path.join(dir, 'data') }, root, now: at[channel], clock: () => at[channel], log: quiet, kind: 'property' }, deps);
    assert.equal(res.status, 'rendered');
  }
  assert.deepEqual(calls[0], ['reel', bytes.map(sha256), { fit: 'pad' }], 'the reel pads the source photos to 9:16');
  assert.deepEqual(calls[1], ['li', pads.map(sha256), { mark: false }], 'LinkedIn re-encodes the padded frames, no second mark');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reel padding: containToFile puts the whole frame on a 9:16 ink canvas, nothing cropped', async () => {
  const { containToFile } = await import('../social/lib/photos.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-contain-'));
  const src = path.join(dir, 'src.jpg'), out = path.join(dir, 'out.jpg');
  fs.writeFileSync(src, await jpeg(1484, 1920, '#cc3311'));
  await containToFile(src, out, 1080, 1920);
  const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height], [1080, 1920]);
  const px = (x, y) => [...data.slice((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
  // 1484x1920 fitted to 1080 wide is 1397 tall: ink bands of ~261 px above and below, the photo full width.
  assert.ok(px(540, 100).every(v => v < 40) && px(540, 1820).every(v => v < 40), 'ink above and below');
  assert.ok(px(3, 960)[0] > 180 && px(1076, 960)[0] > 180 && px(540, 270)[0] > 180 && px(540, 1650)[0] > 180, 'the photo edge to edge');
  fs.rmSync(dir, { recursive: true, force: true });
});
