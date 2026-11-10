// BONA-W009 (Elvira Murjan): the developer withdrew permission to advertise it, and the owner
// ordered a full takedown. The intake is the one route that can put a listing back on the site by
// itself — from a WhatsApp command or simply because the brochure is sent again — so every path it
// has is checked here: `show`, `brochure`, `video`, a re-sent or re-exported brochure, `retry`.
//
// The repository keeps only a TOMBSTONE of W009's inbox record (id, slug, names, brochure hash; no
// copy, photos or brochure link — the repository is public). The commands below run against that
// real tombstone; the tests that need a whole listing use the frozen stand-in in
// scripts/test/w009-fixture.mjs.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as edits from '../lib/edits.mjs';
import { checkListing, listInbox, writeInboxListing } from '../lib/listing.mjs';
import { statusReport } from '../lib/messages.mjs';
import { processPdf, RejectError, sha256File } from '../lib/pipeline.mjs';
import { candidateListings } from '../lib/video-match.mjs';
import * as rules from '../../../scripts/curate/rules.mjs';
import { w009Inbox } from '../../../scripts/test/w009-fixture.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SLUG = 'elvira-murjan-townhouses-in-al-murjan';
const inboxJson = (slug) => JSON.parse(fs.readFileSync(path.join(REPO, 'scripts', 'curate', 'inbox', `${slug}.json`), 'utf8'));
const REGISTER = path.join('marketing', 'daily', 'property-reviews.json');
const flag = (extra = {}) => ({ status: 'withdrawn', reviewedAt: '2026-11-10T09:00:00Z', reviewer: 'test',
  withdrawnAdvertising: { at: '2026-11-10T09:00:00Z', requestedBy: 'test', reason: 'developer withdrew permission (fixture)', channels: ['website'], ...extra } });

describe('intake commands on a withdrawn listing (the repository\'s own tombstone)', () => {
  let tmp;
  const ordinary = 'temp-villa';
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-withdrawn-'));
    fs.mkdirSync(path.join(tmp, 'scripts', 'curate', 'inbox'), { recursive: true });
    writeInboxListing(tmp, inboxJson(SLUG));
    writeInboxListing(tmp, {
      id: 'BONA-W001', slug: ordinary, status: 'available', hidden: true,
      title: { en: 'Temp Villa', ar: 'فيلا مؤقتة' },
      price: { amount: 1000000, currency: 'SAR', from: false, period: null, onRequest: false },
      images: [1, 2, 3, 4].map((n) => ({ src: `/listings/${ordinary}/0${n}.jpg`, thumb: null, alt: { en: 'x', ar: 'س' } })),
    });
    fs.mkdirSync(path.join(tmp, path.dirname(REGISTER)), { recursive: true });
    fs.writeFileSync(path.join(tmp, REGISTER), JSON.stringify({ 'BONA-W001': flag() }, null, 2));
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const hidden = (id) => edits.locate(tmp, id).listing.hidden;

  it('the record is the tombstone, hidden', () => {
    const { listing } = edits.locate(tmp, 'BONA-W009');
    assert.equal(listing.hidden, true);
    assert.equal(listing.images, undefined, 'no photo list to edit');
  });

  it('`show` is refused, and the listing stays hidden', () => {
    const res = edits.setHidden(tmp, 'BONA-W009', false);
    assert.match(res?.error ?? '', /marketing permission .*withdrawn/i);
    assert.equal(hidden('BONA-W009'), true);
  });

  it('`show` is refused for a listing flagged only in the review register', () => {
    assert.match(edits.setHidden(tmp, 'BONA-W001', false)?.error ?? '', /withdrawn/i);
    assert.equal(hidden('BONA-W001'), true);
  });

  it('`hide` still works — keeping a withdrawn listing off the site is always allowed', () => {
    assert.equal(edits.setHidden(tmp, 'BONA-W009', true).listing.hidden, true);
  });

  it('`hero` and `price` are refused with the withdrawal, not a crash on the tombstone', () => {
    const before_ = fs.readFileSync(edits.locate(tmp, 'BONA-W009').file, 'utf8');
    assert.match(edits.setHero(tmp, 'BONA-W009', 2)?.error ?? '', /marketing permission .*withdrawn/i);
    assert.match(edits.setPrice(tmp, 'BONA-W009', { amount: 5000000, currency: 'SAR' })?.error ?? '', /marketing permission .*withdrawn/i);
    assert.match(edits.setPrice(tmp, 'BONA-W009', { onRequest: true })?.error ?? '', /withdrawn/i);
    assert.equal(fs.readFileSync(edits.locate(tmp, 'BONA-W009').file, 'utf8'), before_, 'nothing rewritten');
    // and the same for a listing withdrawn only by its register flag, which still has its photos
    assert.match(edits.setHero(tmp, 'BONA-W001', 2)?.error ?? '', /withdrawn/i);
  });

  it('`available`, `reserved`, `sold`, `licence` and `wafi` are refused: the tombstone stays "withdrawn" and gains no field', () => {
    const file = edits.locate(tmp, 'BONA-W009').file;
    const before_ = fs.readFileSync(file, 'utf8');
    for (const status of ['available', 'reserved', 'sold']) {
      assert.match(edits.setStatus(tmp, 'BONA-W009', status)?.error ?? '', /marketing permission .*withdrawn/i, status);
    }
    assert.match(edits.setLicence(tmp, 'BONA-W009', { adNumber: '7200012345', adExpiry: '2099-01-01' })?.error ?? '', /marketing permission .*withdrawn/i);
    assert.match(edits.setLicence(tmp, 'BONA-W009', { clear: true })?.error ?? '', /withdrawn/i);
    assert.match(edits.setWafi(tmp, 'BONA-W009', { wafiNumber: '1234567890' })?.error ?? '', /withdrawn/i);
    assert.match(edits.setWafi(tmp, 'bona-w009', { clear: true })?.error ?? '', /withdrawn/i, 'the id as the owner may type it');
    assert.equal(fs.readFileSync(file, 'utf8'), before_, 'nothing rewritten');
    assert.equal(edits.locate(tmp, 'BONA-W009').listing.status, 'withdrawn');
    // and for a listing withdrawn only by its register flag, which still has a status to overwrite
    const flagged = fs.readFileSync(edits.locate(tmp, 'BONA-W001').file, 'utf8');
    assert.match(edits.setStatus(tmp, 'BONA-W001', 'available')?.error ?? '', /withdrawn/i);
    assert.match(edits.setLicence(tmp, 'BONA-W001', { adNumber: '7200012345', adExpiry: '2099-01-01' })?.error ?? '', /withdrawn/i);
    assert.equal(fs.readFileSync(edits.locate(tmp, 'BONA-W001').file, 'utf8'), flagged);
  });

  it('`brochure` is refused before it writes a brochure.pdf back under public/', async () => {
    const res = await edits.rebuildBrochure(tmp, 'BONA-W009', { cfg: { intakeDir: tmp, site: 'https://bona-real-estate.com' }, workDir: path.join(tmp, 'work') });
    assert.match(res?.error ?? '', /withdrawn/i);
    assert.equal(fs.existsSync(path.join(tmp, 'public', 'listings', SLUG)), false);
  });

  it('`video` is refused before a clip is copied under public/', () => {
    const clip = path.join(tmp, 'clip.mp4');
    fs.writeFileSync(clip, 'not really a video');
    const res = edits.addVideo(tmp, 'BONA-W009', { file: clip });
    assert.match(res?.error ?? '', /withdrawn/i);
    assert.equal(fs.existsSync(path.join(tmp, 'public', 'listings', SLUG)), false);
  });

  it('`status` still lists it, by its title, as hidden and withdrawn; a captionless clip is never matched to it', () => {
    const text = statusReport({ listings: listInbox(tmp).map((x) => x.listing), groups: [], lastError: null, queueLength: 0 });
    assert.match(text, /BONA-W009 · Elvira Murjan Townhouses in Al-Murjan _\(hidden\)_ _\(withdrawn\)_/);
    assert.ok(!candidateListings(tmp).some((c) => c.id === 'BONA-W009'));
  });

  it('`remove` still works on the tombstone (last: it deletes the record)', () => {
    assert.equal(edits.removeListing(tmp, 'BONA-W009')?.id, 'BONA-W009');
    assert.equal(edits.locate(tmp, 'BONA-W009'), null);
  });
});

describe('a withdrawn project sent to the intake again', () => {
  it('checkListing refuses it under a fresh id, slug and brochure hash', () => {
    const { hidden, ...base } = w009Inbox();
    const again = { ...base, id: 'BONA-W031', slug: `${SLUG}-2`, hidden: false,
      images: base.images.map((im, i) => ({ ...im, src: `/listings/${SLUG}-2/${String(i + 1).padStart(2, '0')}.jpg`, thumb: null })),
      _intake: { ...base._intake, pdfSha256: 'f'.repeat(64) } };
    const problems = checkListing(again);
    assert.ok(problems.some((p) => /marketing permission .*withdrawn/i.test(p)), problems.join(' | '));
  });

  it('checkListing refuses a listing the review register flags, and leaves an ordinary one alone', () => {
    const ordinary = inboxJson('baroque-palace-residence-hampstead');
    assert.ok(!checkListing(ordinary).some((p) => /withdrawn/i.test(p)), 'control');
    const withdrawals = rules.registerWithdrawals({ [ordinary.id]: flag() });
    assert.ok(checkListing(ordinary, { withdrawals }).some((p) => /withdrawn/i.test(p)));
  });

  it('processPdf refuses a withdrawn brochure before it reads a page of it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-withdrawn-pdf-'));
    try {
      const pdfPath = path.join(dir, 'brochure.pdf');
      fs.writeFileSync(pdfPath, '%PDF-1.4 the same brochure, sent again');
      const repo = path.join(dir, 'repo');
      fs.mkdirSync(path.join(repo, path.dirname(REGISTER)), { recursive: true });
      fs.writeFileSync(path.join(repo, REGISTER), JSON.stringify({ 'BONA-W077': flag({ pdfSha256: sha256File(pdfPath) }) }));
      // maxPdfMb 0 would reject ANY file at the size gate: the withdrawal has to be answered first.
      const cfg = { repo, maxPdfMb: 0, site: 'https://bona-real-estate.com' };
      await assert.rejects(
        processPdf({ pdfPath, cfg, caption: {}, workDir: path.join(dir, 'work') }),
        (err) => err instanceof RejectError && err.stage === 'withdrawn' && /withdrawn/i.test(err.reason),
      );
      assert.equal(fs.existsSync(path.join(dir, 'work')), false, 'nothing extracted');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('the permanent record knows W009\'s original brochure by its bytes', () => {
    const sha = inboxJson(SLUG)._intake.pdfSha256;
    assert.equal(rules.withdrawnAdvertising({ _intake: { pdfSha256: sha } })?.id, 'BONA-W009');
  });

  // handlePdf() lives in the daemon's entry module (index.mjs starts polling on import), so its
  // ordering is asserted on the source; the check it runs is withdrawnAdvertising() on the bytes,
  // tested just above.
  it('the daemon answers a withdrawn brochure before the duplicate guard can call it "already published"', () => {
    const src = fs.readFileSync(path.join(REPO, 'services', 'intake', 'index.mjs'), 'utf8');
    const gate = src.indexOf('withdrawnAdvertising(');
    const dup = src.indexOf('state.duplicateGuard(');
    assert.ok(gate > 0 && dup > 0 && gate < dup, 'withdrawn check precedes the duplicate guard');
  });
});

// ---------------------------------------------------------------- a re-export, end to end
// A re-exported brochure has NEW bytes, so gate 0 cannot see it: what it says about itself (its text
// layer, metadata, links, file name — gate 2a) or what the model writes from it (3b) has to name the
// project. These runs drive the real processPdf() through a fake extract_pdf.py
// (cfg.pyCmd) and a fake `claude` (cfg.claudeBin), so every step between the PDF and the repository
// is the production code. The fakes log each call to bin/calls.jsonl.

const FAKE_PY = `import fs from 'node:fs';
import path from 'node:path';
const cfg = JSON.parse(fs.readFileSync(new URL('./fake.json', import.meta.url), 'utf8'));
const [, , , , outDir, ...rest] = process.argv;          // node fake-py.mjs extract_pdf.py <pdf> <outDir> ...
const opt = (k) => { const i = rest.indexOf(k); return i === -1 ? null : rest[i + 1]; };
const mode = opt('--mode') ?? 'extract';
const pages = (opt('--pages') ?? '').split(',').filter(Boolean).map(Number);
const put = (rel) => { const abs = path.join(outDir, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.copyFileSync(cfg.photo, abs); return abs; };
fs.appendFileSync(new URL('./calls.jsonl', import.meta.url), JSON.stringify({ tool: 'py-' + mode, pages }) + '\\n');
const W = 1200, H = 900;
let out;
if (mode === 'extract') {
  const candidates = cfg.candidates.map((c, index) => {
    const file = 'images/c' + String(index).padStart(3, '0') + '.jpg';
    return { index, file, abs: put(file), width: W, height: H, page: c.page, source: 'embedded', coverage: c.coverage };
  });
  out = { ok: true, pages: cfg.pages, pageSizes: Array.from({ length: cfg.pages }, (_, i) => ({ page: i + 1, width: 842, height: 595 })),
    text: cfg.text, pageText: [cfg.text], candidates, rendered: false, embeddedImageCount: candidates.length, links: [], meta: cfg.pdfMeta };
} else if (mode === 'views') {
  const dir = opt('--view-dir') ?? 'views';
  out = { ok: true, views: pages.map((page, id) => ({ id, page, slice: 1, slices: 1, abs: put(dir + '/p' + page + '.jpg'), width: W, height: H, x0: 0, y0: 0, x1: 1, y1: 1 })) };
} else {
  const dir = opt('--page-dir') ?? 'pages';
  out = { ok: true, pageImages: pages.map((page) => ({ page, abs: put(dir + '/p' + page + '.jpg'), width: W, height: H })) };
}
process.stdout.write(JSON.stringify(out) + '\\n');
`;

const FAKE_CLAUDE = `import fs from 'node:fs';
const cfg = JSON.parse(fs.readFileSync(new URL('./fake.json', import.meta.url), 'utf8'));
const log = new URL('./calls.jsonl', import.meta.url);
const prompt = fs.readFileSync(0, 'utf8');
const regions = prompt.includes('Your only job is to say WHERE the photographs are');
const seen = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.tool === 'claude-listing').length : 0;
fs.appendFileSync(log, JSON.stringify({ tool: regions ? 'claude-regions' : 'claude-listing' }) + '\\n');
const answer = regions ? cfg.regions : cfg.listings[Math.min(seen, cfg.listings.length - 1)];
process.stdout.write(JSON.stringify({ is_error: false, result: JSON.stringify(answer), total_cost_usd: 0, duration_ms: 1, num_turns: 1, session_id: 'fake' }));
`;

const TEXT = 'Townhouse project in Al-Murjan district, Jeddah. Villa with 5 bedroom suites, 6 bathroom, 400 sqm built-up area. Off-plan, from the developer.';
const PLACE = {
  district: { en: 'Al-Murjan', ar: 'المرجان' }, city: { en: 'Jeddah', ar: 'جدة' },
  country: { en: 'Saudi Arabia', ar: 'المملكة العربية السعودية' }, countryCode: 'SA',
};
const ROOMS_ = ['exterior', 'living', 'kitchen', 'master', 'pool', 'terrace'];
/** A contract-valid model answer. `keep` are the candidate indices it publishes; `drop` the ones it excludes, with a reason. */
const modelAnswer = ({ title, project = null, keep, drop = [] }) => ({
  reject: false, rejectReason: null, confidence: 0.8, warnings: [],
  listing: {
    title, type: 'villa', category: 'off-plan', location: PLACE,
    price: { amount: null, currency: 'SAR', from: false, period: null, onRequest: true },
    specs: { beds: 5, baths: 6, areaSqm: 400, plotSqm: null, yearBuilt: null, floors: null },
    description: { en: ['One.', 'Two.'], ar: ['واحد.', 'اثنان.'] },
    highlights: { en: ['A', 'B', 'C', 'D'], ar: ['أ', 'ب', 'ج', 'د'] },
    project, unit: null,
  },
  images: [
    ...keep.map((index, i) => ({ index, room: ROOMS_[i % ROOMS_.length], rank: i + 1, hero: i === 0, exclude: false, reason: 'photograph' })),
    ...drop.map(([index, reason]) => ({ index, room: 'render', rank: null, hero: false, exclude: true, reason })),
  ],
});
const ELVIRA = { en: 'Elvira Townhouses, Al-Murjan', ar: 'تاون هاوس إلفيرا، المرجان' };
const ORDINARY = { en: 'Seaside Townhouses, Al-Murjan', ar: 'تاون هاوس على البحر، المرجان' };

async function rig({ candidates, listings, regions = null, pages = 3, text = TEXT, pdfMeta = {} }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bona-withdrawn-run-')));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const photo = path.join(bin, 'photo.jpg');
  const sharp = (await import('sharp')).default;
  await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#4a6b8a' } }).jpeg().toFile(photo);
  fs.writeFileSync(path.join(bin, 'fake.json'), JSON.stringify({ photo, candidates, listings, regions, pages, text, pdfMeta }));
  fs.writeFileSync(path.join(bin, 'fake-py.mjs'), FAKE_PY);
  fs.writeFileSync(path.join(bin, 'fake-claude.mjs'), FAKE_CLAUDE);
  const claude = path.join(bin, 'claude');
  fs.writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(claude, 0o755);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'src', 'data'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'src', 'data', 'kind-map.json'), path.join(repo, 'src', 'data', 'kind-map.json'));
  const pdfPath = path.join(dir, 'brochure.pdf');
  fs.writeFileSync(pdfPath, `%PDF-1.4 a re-export of a brochure ${crypto.randomUUID()}`);
  const cfg = {
    repo, site: 'https://bona-real-estate.com', maxPdfMb: 50, maxPdfPages: 60, minImageSide: 100, minImages: 4, maxImages: 10,
    pageReadLongSide: 1600, pyCmd: [process.execPath, path.join(bin, 'fake-py.mjs')], claudeBin: claude,
    claudeModel: 'sonnet', claudeFallbackModel: null, claudeTimeoutMs: 60000,
  };
  const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(repo, path.join(d, e.name))])) : []);
  return {
    cfg, pdfPath, repo, workDir: path.join(dir, 'work'),
    repoFiles: () => walk(repo).sort(),
    calls: () => (fs.existsSync(path.join(bin, 'calls.jsonl')) ? fs.readFileSync(path.join(bin, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).tool) : []),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const sixPhotos = Array.from({ length: 6 }, (_, i) => ({ page: 1 + (i % 3), coverage: 0.4 }));
const isWithdrawn = (err) => err instanceof RejectError && err.stage === 'withdrawn' && /marketing permission withdrawn for BONA-W009/.test(err.reason);

describe('processPdf, end to end: a re-exported Elvira brochure (new bytes) is refused by name', { timeout: 120000 }, () => {
  it('control: an ordinary brochure through the same rig gets past the name gate (dry run)', async () => {
    const r = await rig({ candidates: sixPhotos, listings: [modelAnswer({ title: ORDINARY, keep: [0, 1, 2, 3, 4] })] });
    try {
      const report = await processPdf({ pdfPath: r.pdfPath, cfg: r.cfg, caption: {}, workDir: r.workDir, dryRun: true });
      assert.equal(report.ok, true);
      assert.equal(report.stage, 'dry-run');
      assert.equal(report.listingPreview.title.en, ORDINARY.en);
      assert.ok(!report.warnings.some((w) => /withdrawn/i.test(w)), report.warnings.join(' | '));
      assert.deepEqual(r.calls(), ['py-extract', 'claude-listing']);
    } finally { r.cleanup(); }
  });

  it('the model names Elvira: rejected as withdrawn before any photo is staged or the repository is touched', async () => {
    const r = await rig({ candidates: sixPhotos, listings: [modelAnswer({ title: ELVIRA, keep: [0, 1, 2, 3, 4] })] });
    try {
      assert.equal(rules.withdrawnAdvertising({ _intake: { pdfSha256: sha256File(r.pdfPath) } }), null, 'fresh bytes: gate 0 cannot see it');
      const before_ = r.repoFiles();
      await assert.rejects(processPdf({ pdfPath: r.pdfPath, cfg: r.cfg, caption: {}, workDir: r.workDir }), isWithdrawn);
      assert.deepEqual(r.calls(), ['py-extract', 'claude-listing'], 'one model call, then nothing');
      assert.equal(fs.existsSync(path.join(r.workDir, 'publish')), false, 'no photo or brochure staged');
      assert.deepEqual(r.repoFiles(), before_, 'no inbox record, no _index.json, no public/listings, no rebuild output');
    } finally { r.cleanup(); }
  });

  it('…and only in the project\'s Arabic name: still refused', async () => {
    const project = { name: { en: 'Murjan Townhouses', ar: 'ألفيرا مرجان' }, developer: { en: 'A Developer', ar: 'مطور' } };
    const r = await rig({ candidates: sixPhotos, listings: [modelAnswer({ title: ORDINARY, project, keep: [0, 1, 2, 3, 4] })] });
    try {
      const before_ = r.repoFiles();
      await assert.rejects(processPdf({ pdfPath: r.pdfPath, cfg: r.cfg, caption: {}, workDir: r.workDir }), isWithdrawn);
      assert.equal(fs.existsSync(path.join(r.workDir, 'publish')), false);
      assert.deepEqual(r.repoFiles(), before_);
    } finally { r.cleanup(); }
  });

  it('the rescue round: an ordinary first read, then Elvira once the photos are cut out of the pages — refused', async () => {
    // Four ordinary photos and two page-sized composites (pages 2 and 3). Round one keeps two photos
    // and calls the composites collages, so the crop step runs and the model reads the brochure again;
    // the second read names Elvira.
    const candidates = [...Array.from({ length: 4 }, () => ({ page: 1, coverage: 0.4 })), { page: 2, coverage: 1 }, { page: 3, coverage: 1 }];
    const regions = { views: [0, 1].map((view) => ({ view, photos: [{ box: [0.02, 0.02, 0.48, 0.98], room: 'exterior' }, { box: [0.52, 0.02, 0.98, 0.98], room: 'living' }] })) };
    const round1 = modelAnswer({ title: ORDINARY, keep: [0, 1], drop: [[2, 'logo'], [3, 'floor plan'], [4, 'a collage of photos and text'], [5, 'a collage of photos and text']] });
    const round2 = modelAnswer({ title: ELVIRA, keep: [6, 7, 8, 9, 0], drop: [[1, 'duplicate']] });
    const r = await rig({ candidates, listings: [round1, round2], regions });
    try {
      const before_ = r.repoFiles();
      await assert.rejects(processPdf({ pdfPath: r.pdfPath, cfg: r.cfg, caption: {}, workDir: r.workDir }), isWithdrawn);
      assert.deepEqual(r.calls().filter((c) => c.startsWith('claude')), ['claude-listing', 'claude-regions', 'claude-listing'], 'the rescue round really ran');
      assert.ok(fs.readdirSync(path.join(r.workDir, 'images')).some((f) => /^c00[6-9]\.jpg$/.test(f)), 'the crops were cut');
      assert.equal(fs.existsSync(path.join(r.workDir, 'publish')), false, 'no photo or brochure staged');
      assert.deepEqual(r.repoFiles(), before_);
    } finally { r.cleanup(); }
  });

  // The model may title a re-export generically and leave `project` empty, so its answer alone is not
  // enough: the brochure's own words are read for the name too, before the model is paid to read it.
  for (const [what, extra] of [
    ['its text layer (English, upper case)', { text: `${TEXT} ELVIRA TOWNHOUSES — handover 2027.` }],
    ['its text layer (Arabic, another alef form)', { text: `${TEXT} مشروع ألفيرا في حي المرجان.` }],
    ['only its PDF metadata (the document title)', { pdfMeta: { title: 'Elvira Murjan - sales brochure v2', producer: 'Adobe InDesign' } }],
  ]) {
    it(`a generic model answer cannot hide it: Elvira named in ${what} is refused before the model is asked`, async () => {
      const r = await rig({ candidates: sixPhotos, listings: [modelAnswer({ title: ORDINARY, project: null, keep: [0, 1, 2, 3, 4] })], ...extra });
      try {
        assert.equal(rules.withdrawnAdvertising({ _intake: { pdfSha256: sha256File(r.pdfPath) } }), null, 'fresh bytes: gate 0 cannot see it');
        const before_ = r.repoFiles();
        await assert.rejects(processPdf({ pdfPath: r.pdfPath, cfg: r.cfg, caption: {}, workDir: r.workDir }), isWithdrawn);
        assert.deepEqual(r.calls(), ['py-extract'], 'refused on the extraction: no model call');
        assert.equal(fs.existsSync(path.join(r.workDir, 'publish')), false, 'no photo or brochure staged');
        assert.deepEqual(r.repoFiles(), before_, 'no inbox record, no _index.json, no public/listings, no rebuild output');
      } finally { r.cleanup(); }
    });
  }

  it('…or in the file name it was sent under, or a dry run: refused all the same', async () => {
    const r = await rig({ candidates: sixPhotos, listings: [modelAnswer({ title: ORDINARY, keep: [0, 1, 2, 3, 4] })] });
    try {
      const before_ = r.repoFiles();
      await assert.rejects(
        processPdf({ pdfPath: r.pdfPath, cfg: r.cfg, caption: {}, workDir: r.workDir, meta: { pdfFileName: 'elvira_murjan_brochure-v2.pdf' } }),
        isWithdrawn,
      );
      await assert.rejects(
        processPdf({ pdfPath: r.pdfPath, cfg: r.cfg, caption: { text: 'Elvira again, re-exported' }, workDir: r.workDir, dryRun: true }),
        isWithdrawn,
      );
      assert.deepEqual(r.calls(), ['py-extract', 'py-extract'], 'no model call either time');
      assert.deepEqual(r.repoFiles(), before_);
    } finally { r.cleanup(); }
  });

  it('a brochure with no text layer: the model\'s generic title does not hide Elvira named in its own description', async () => {
    const answer = modelAnswer({ title: ORDINARY, project: null, keep: [0, 1, 2, 3, 4] });
    answer.listing.description.en = ['Elvira brings 24 townhouses to Al-Murjan.', 'Two.'];
    const r = await rig({ candidates: sixPhotos, listings: [answer], text: '' });
    try {
      const before_ = r.repoFiles();
      await assert.rejects(processPdf({ pdfPath: r.pdfPath, cfg: r.cfg, caption: {}, workDir: r.workDir }), isWithdrawn);
      assert.equal(fs.existsSync(path.join(r.workDir, 'publish')), false);
      assert.deepEqual(r.repoFiles(), before_);
    } finally { r.cleanup(); }
  });

  it('a project flagged only in the review register is refused by name too', async () => {
    const r = await rig({ candidates: sixPhotos, listings: [modelAnswer({ title: ORDINARY, keep: [0, 1, 2, 3, 4] })] });
    try {
      fs.mkdirSync(path.join(r.repo, path.dirname(REGISTER)), { recursive: true });
      fs.writeFileSync(path.join(r.repo, REGISTER), JSON.stringify({ 'BONA-W077': flag({ names: ['Seaside Townhouses'] }) }));
      const before_ = r.repoFiles();
      await assert.rejects(
        processPdf({ pdfPath: r.pdfPath, cfg: r.cfg, caption: {}, workDir: r.workDir }),
        (err) => err instanceof RejectError && err.stage === 'withdrawn' && /BONA-W077/.test(err.reason),
      );
      assert.equal(fs.existsSync(path.join(r.workDir, 'publish')), false);
      assert.deepEqual(r.repoFiles(), before_);
    } finally { r.cleanup(); }
  });
});
