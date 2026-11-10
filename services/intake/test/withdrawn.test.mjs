// BONA-W009 (Elvira Murjan): the developer withdrew permission to advertise it, and the owner
// ordered a full takedown. The intake is the one route that can put a listing back on the site by
// itself — from a WhatsApp command or simply because the brochure is sent again — so every path it
// has is checked here: `show`, `brochure`, `video`, a re-sent or re-exported brochure, `retry`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as edits from '../lib/edits.mjs';
import { checkListing, writeInboxListing } from '../lib/listing.mjs';
import { processPdf, RejectError, sha256File } from '../lib/pipeline.mjs';
import * as rules from '../../../scripts/curate/rules.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SLUG = 'elvira-murjan-townhouses-in-al-murjan';
const inboxJson = (slug) => JSON.parse(fs.readFileSync(path.join(REPO, 'scripts', 'curate', 'inbox', `${slug}.json`), 'utf8'));
const REGISTER = path.join('marketing', 'daily', 'property-reviews.json');
const flag = (extra = {}) => ({ status: 'withdrawn', reviewedAt: '2026-11-10T09:00:00Z', reviewer: 'test',
  withdrawnAdvertising: { at: '2026-11-10T09:00:00Z', requestedBy: 'test', reason: 'developer withdrew permission (fixture)', channels: ['website'], ...extra } });

describe('intake commands on a withdrawn listing', () => {
  let tmp;
  const ordinary = 'temp-villa';
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-withdrawn-'));
    fs.mkdirSync(path.join(tmp, 'scripts', 'curate', 'inbox'), { recursive: true });
    writeInboxListing(tmp, { ...inboxJson(SLUG), hidden: true });
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
});

describe('a withdrawn project sent to the intake again', () => {
  it('checkListing refuses it under a fresh id, slug and brochure hash', () => {
    const { hidden, ...base } = inboxJson(SLUG);
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

  it('the daemon answers a withdrawn brochure before the duplicate guard can call it "already published"', () => {
    const src = fs.readFileSync(path.join(REPO, 'services', 'intake', 'index.mjs'), 'utf8');
    const gate = src.indexOf('withdrawnAdvertising(');
    const dup = src.indexOf('state.duplicateGuard(');
    assert.ok(gate > 0 && dup > 0 && gate < dup, 'withdrawn check precedes the duplicate guard');
  });

  it('processPdf checks the model\'s listing for a withdrawn project before anything is written', () => {
    const src = fs.readFileSync(path.join(REPO, 'services', 'intake', 'lib', 'pipeline.mjs'), 'utf8');
    const ai = src.indexOf("if (ai.reject) throw new RejectError");
    const named = src.indexOf("'withdrawn'", ai);
    const write = src.indexOf('writeListingImages(');
    assert.ok(ai > 0 && named > ai && named < write, 'the withdrawn gate sits between the AI step and the first write');
  });
});
