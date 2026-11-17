// The Bona brochure: where the file lands, how lib/brochure.mjs calls brochure_pdf.py, and the
// `brochure <id>` rebuild.
//
// The drawing itself is exercised for real in brochure-pdf.test.mjs (WeasyPrint, real photos).
// Here the Python is replaced by an injected spawn that records its argv and answers with the
// JSON line the script prints, so these run in milliseconds and test the WIRING: which listing
// reaches the page (never `_intake`), which folder the photos are read from, which site.json,
// and what a failure turns into for the caller.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  DEFAULT_BROCHURE_PY_CMD, SCRIPT, brochureFileIn, brochurePyArgv, brochureRepoPath, brochureUrlFor,
  buildBrandedBrochure, findSourcePdf, publicListing,
} from '../lib/brochure.mjs';
import * as edits from '../lib/edits.mjs';
import { loadConfig } from '../lib/env.mjs';
import { writeInboxListing } from '../lib/listing.mjs';
import { ALLOWED_PATHS } from '../lib/publish.mjs';

const LISTING = {
  id: 'BONA-W007',
  slug: 'garden-villa-al-rawdah',
  title: { en: 'Garden Villa, Al Rawdah', ar: 'فيلا الحديقة، حي الروضة' },
  location: {
    district: { en: 'Al Rawdah', ar: 'الروضة' },
    city: { en: 'Jeddah', ar: 'جدة' },
  },
  price: { amount: 4500000, currency: 'SAR', from: false, period: null, onRequest: false },
  project: { name: { en: 'Rawdah Gardens', ar: 'حدائق الروضة' }, developer: { en: 'Anwar Development', ar: 'أنوار للتطوير' } },
  images: [{ src: '/listings/garden-villa-al-rawdah/01.jpg', alt: { en: 'Front', ar: 'الواجهة' } }],
  brochureUrl: null,
  hidden: false,
  _intake: { pdfSha256: 'abc', site: 'https://bona.azoz.uk', warnings: ['brochure-failed'], caption: 'call 0500000000' },
  _note: 'scratch',
};

/**
 * A stand-in for child_process.spawn: records every call and answers the way brochure_pdf.py
 * does — noise on stdout first (a stray print), the JSON result as the LAST line.
 */
function fakeSpawn({ result = { ok: true, bytes: 3041976, pages: 17, steps: ['measure', 'render', 'write'] }, code = 0, stdout = null, stderr = '', error = null, hang = false, writeOut = true } = {}) {
  const calls = [];
  const spawnImpl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = null;
    child.kill = (sig) => { child.killed = sig; setImmediate(() => child.emit('close', null, sig)); return true; };
    setImmediate(() => {
      if (error) { child.emit('error', error); return; }
      if (hang) return;
      const out = args[args.indexOf(SCRIPT) + 4];
      if (writeOut && result?.ok) fs.writeFileSync(out, '%PDF-1.7 fake brochure\n');
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.stdout.emit('data', Buffer.from(stdout ?? `a stray line\n${JSON.stringify(result)}\n`));
      child.emit('close', code);
    });
    return child;
  };
  return { spawnImpl, calls };
}

/** The positional arguments after SCRIPT, by name. */
const argsOf = (call) => {
  const i = call.args.indexOf(SCRIPT);
  const [listingJson, filesDir, siteJson, out] = call.args.slice(i + 1, i + 5);
  const flag = (name) => { const j = call.args.indexOf(name); return j < 0 ? null : call.args[j + 1]; };
  return { listingJson, filesDir, siteJson, out, maxMb: flag('--max-mb'), work: flag('--work') };
};

describe('where the brochure lands', () => {
  it('is one file per listing, named for the site button that links to it', () => {
    assert.equal(brochureRepoPath('garden-villa-al-rawdah'), 'public/listings/garden-villa-al-rawdah/brochure.pdf');
    assert.equal(brochureFileIn('/tmp/stage/x'), path.join('/tmp/stage/x', 'brochure.pdf'));
    assert.equal(brochureUrlFor('https://bona.azoz.uk', 'garden-villa-al-rawdah'),
      'https://bona.azoz.uk/listings/garden-villa-al-rawdah/brochure.pdf');
  });

  // The brief asked for the brochure to be added to the staging allowlist; it did not need
  // adding — ALLOWED_PATHS matches on a `<allowed>/` prefix and already covers the whole
  // listing directory. This test is what stops that being quietly broken later.
  it('sits inside a path publish.mjs already allows, so nothing had to be widened', () => {
    const file = brochureRepoPath('garden-villa-al-rawdah');
    assert.ok(ALLOWED_PATHS.some((a) => file.startsWith(`${a}/`)), file);
    assert.ok(!ALLOWED_PATHS.some((a) => 'public/brochures/x.pdf'.startsWith(`${a}/`)),
      'a brochure written anywhere else must still be refused');
  });

  it('is drawn by brochure_pdf.py, which sits where lib/brochure.mjs says it is', () => {
    assert.equal(path.basename(SCRIPT), 'brochure_pdf.py');
    assert.ok(fs.existsSync(SCRIPT), SCRIPT);
  });

  it('the old developer-PDF rebrand is gone', () => {
    for (const f of ['rebrand_pdf.py', 'rebrand-once.mjs']) {
      assert.equal(fs.existsSync(path.join(path.dirname(SCRIPT), f)), false, f);
    }
  });
});

describe('brochurePyArgv — an argv array, never a shell string', () => {
  // WeasyPrint is PINNED: the layout checks in brochure_pdf.py were tuned on its line breaking,
  // and a new release that wraps one line differently is a brochure that fails to build.
  it('defaults to a pinned WeasyPrint plus the three packages the script needs', () => {
    assert.deepEqual(brochurePyArgv(undefined), DEFAULT_BROCHURE_PY_CMD);
    assert.deepEqual(DEFAULT_BROCHURE_PY_CMD,
      ['uv', 'run', '--with', 'weasyprint==70.0', '--with', 'segno', '--with', 'pillow', '--with', 'pymupdf', 'python']);
  });

  it('accepts an array, and splits a legacy string on whitespace', () => {
    assert.deepEqual(brochurePyArgv(['python3']), ['python3']);
    assert.deepEqual(brochurePyArgv('  uv run  python '), ['uv', 'run', 'python']);
  });

  it('is what loadConfig hands the pipeline, unless BONA_BROCHURE_PY_CMD says otherwise', () => {
    const saved = process.env.BONA_BROCHURE_PY_CMD;
    try {
      delete process.env.BONA_BROCHURE_PY_CMD;
      const cfg = loadConfig({});
      assert.deepEqual(cfg.brochurePyCmd, DEFAULT_BROCHURE_PY_CMD);
      assert.equal(cfg.maxBrochureMb, 25);
      process.env.BONA_BROCHURE_PY_CMD = '/opt/py/bin/python3  ';
      assert.deepEqual(loadConfig({}).brochurePyCmd, ['/opt/py/bin/python3']);
    } finally {
      if (saved === undefined) delete process.env.BONA_BROCHURE_PY_CMD;
      else process.env.BONA_BROCHURE_PY_CMD = saved;
    }
  });
});

describe('publicListing — nothing the intake keeps for itself reaches the page', () => {
  it('drops _intake, every other _ key and hidden; keeps the published fields', () => {
    const pub = publicListing(LISTING);
    assert.equal('_intake' in pub, false);
    assert.equal('_note' in pub, false);
    assert.equal('hidden' in pub, false);
    assert.deepEqual(pub.title, LISTING.title);
    assert.deepEqual(pub.images, LISTING.images);
    assert.equal(LISTING._intake.pdfSha256, 'abc', 'the caller\'s object is not touched');
  });
});

describe('buildBrandedBrochure — the call into brochure_pdf.py', () => {
  let dir;
  let filesDir;
  let repo;
  const cfg = () => ({ repo, maxBrochureMb: 25, brochureTimeoutMs: 5000 });

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-brochure-'));
    filesDir = path.join(dir, 'stage', LISTING.slug);
    fs.mkdirSync(filesDir, { recursive: true });
    fs.writeFileSync(path.join(filesDir, '01.jpg'), 'jpg');
    repo = path.join(dir, 'repo');
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('runs the pinned interpreter in isolated mode on the listing JSON, the files dir, site.json and the output', async () => {
    const { spawnImpl, calls } = fakeSpawn();
    const workDir = path.join(dir, 'work-argv');
    const outPath = brochureFileIn(filesDir);
    const res = await buildBrandedBrochure({ listing: LISTING, filesDir, outPath, workDir, cfg: cfg(), spawnImpl });
    assert.ok(res.ok, res.error);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.cmd, 'uv');
    assert.deepEqual(call.args, [
      ...DEFAULT_BROCHURE_PY_CMD.slice(1), '-I', SCRIPT,
      path.join(workDir, 'brochure-listing.json'), filesDir, path.join(repo, 'src', 'data', 'site.json'), outPath,
      '--max-mb', '25', '--work', path.join(workDir, 'brochure-work'),
    ]);
    assert.ok(!call.opts?.shell, 'never through a shell');
  });

  it('writes the PUBLIC listing to workDir/brochure-listing.json — no _intake, no hidden', async () => {
    const { spawnImpl, calls } = fakeSpawn();
    const workDir = path.join(dir, 'work-json');
    await buildBrandedBrochure({ listing: LISTING, filesDir, outPath: path.join(dir, 'json.pdf'), workDir, cfg: cfg(), spawnImpl });
    const written = JSON.parse(fs.readFileSync(argsOf(calls[0]).listingJson, 'utf8'));
    assert.equal(argsOf(calls[0]).listingJson, path.join(workDir, 'brochure-listing.json'));
    assert.deepEqual(written, publicListing(LISTING));
    assert.ok(!JSON.stringify(written).includes('0500000000'), 'nothing from _intake');
  });

  it('honours BONA_BROCHURE_PY_CMD and BONA_MAX_BROCHURE_MB', async () => {
    const { spawnImpl, calls } = fakeSpawn();
    await buildBrandedBrochure({
      listing: LISTING, filesDir, outPath: path.join(dir, 'custom.pdf'), workDir: path.join(dir, 'work-custom'),
      cfg: { ...cfg(), brochurePyCmd: ['/opt/py/bin/python3'], maxBrochureMb: 12.5 }, spawnImpl,
    });
    assert.equal(calls[0].cmd, '/opt/py/bin/python3');
    assert.deepEqual(calls[0].args.slice(0, 2), ['-I', SCRIPT]);
    assert.equal(argsOf(calls[0]).maxMb, '12.5');
  });

  it('answers with what the script printed on its last line', async () => {
    const { spawnImpl } = fakeSpawn({ result: { ok: true, out: 'x', bytes: 1234, pages: 13, steps: ['measure', 'render', 'scale-0.75', 'write'], kinds: ['cover'] } });
    const res = await buildBrandedBrochure({ listing: LISTING, filesDir, outPath: path.join(dir, 'last.pdf'), workDir: path.join(dir, 'work-last'), cfg: cfg(), spawnImpl });
    assert.equal(res.ok, true);
    assert.equal(res.bytes, 1234);
    assert.equal(res.pages, 13);
    assert.deepEqual(res.steps, ['measure', 'render', 'scale-0.75', 'write']);
  });

  it('a failure line comes back as { ok: false } and an existing brochure is left where it is', async () => {
    const outPath = path.join(dir, 'kept.pdf');
    fs.writeFileSync(outPath, '%PDF the brochure already live');
    const { spawnImpl } = fakeSpawn({ result: { ok: false, reason: 'error', error: 'layout does not fit: page 4' }, code: 1 });
    const res = await buildBrandedBrochure({ listing: LISTING, filesDir, outPath, workDir: path.join(dir, 'work-fail'), cfg: cfg(), spawnImpl });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'error');
    assert.match(res.error, /layout does not fit/);
    assert.equal(fs.readFileSync(outPath, 'utf8'), '%PDF the brochure already live');
  });

  it('too-large says so in words the owner can act on, and keeps the script\'s figures for the journal', async () => {
    const { spawnImpl } = fakeSpawn({ result: { ok: false, reason: 'too-large', error: '30000000 bytes after scaling images to 0.55, cap 26214400' }, code: 1 });
    const res = await buildBrandedBrochure({ listing: LISTING, filesDir, outPath: path.join(dir, 'big.pdf'), workDir: path.join(dir, 'work-big'), cfg: cfg(), spawnImpl });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'too-large');
    assert.match(res.error, /over the 25 MB limit/);
    assert.match(res.detail, /30000000 bytes/);
  });

  it('a crash with no JSON line is a render failure carrying the tail of stderr', async () => {
    const { spawnImpl } = fakeSpawn({ stdout: '', stderr: 'Traceback …\nOSError: cannot load library libpango-1.0-0', code: 1 });
    const res = await buildBrandedBrochure({ listing: LISTING, filesDir, outPath: path.join(dir, 'crash.pdf'), workDir: path.join(dir, 'work-crash'), cfg: cfg(), spawnImpl });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'render');
    assert.match(res.error, /libpango/);
  });

  it('"ok" with no file on disk is not a brochure', async () => {
    const { spawnImpl } = fakeSpawn({ writeOut: false });
    const res = await buildBrandedBrochure({ listing: LISTING, filesDir, outPath: path.join(dir, 'ghost.pdf'), workDir: path.join(dir, 'work-ghost'), cfg: cfg(), spawnImpl });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'render');
  });

  it('a missing interpreter is a spawn failure, not a throw', async () => {
    const { spawnImpl } = fakeSpawn({ error: Object.assign(new Error('spawn uv ENOENT'), { code: 'ENOENT' }) });
    const res = await buildBrandedBrochure({ listing: LISTING, filesDir, outPath: path.join(dir, 'enoent.pdf'), workDir: path.join(dir, 'work-enoent'), cfg: cfg(), spawnImpl });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'spawn');
    assert.match(res.error, /ENOENT/);
  });

  it('a render that runs past BONA_BROCHURE_TIMEOUT_MS is killed and reported', async () => {
    const { spawnImpl, calls } = fakeSpawn({ hang: true });
    const res = await buildBrandedBrochure({
      listing: LISTING, filesDir, outPath: path.join(dir, 'slow.pdf'), workDir: path.join(dir, 'work-slow'),
      cfg: { ...cfg(), brochureTimeoutMs: 30 }, spawnImpl,
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'timeout');
    assert.match(res.error, /timed out after 30ms/);
    assert.equal(calls.length, 1);
  });

  it('a files folder that is not there is answered before anything is spawned', async () => {
    const { spawnImpl, calls } = fakeSpawn();
    const res = await buildBrandedBrochure({ listing: LISTING, filesDir: path.join(dir, 'nope'), outPath: path.join(dir, 'nope.pdf'), workDir: path.join(dir, 'work-nope'), cfg: cfg(), spawnImpl });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'input');
    assert.equal(calls.length, 0);
  });
});

describe('rebuildBrochure (`brochure <id>`) — from the repo\'s own files, no source PDF', () => {
  let repo;
  let slugDir;
  let inboxFile;
  const build = (spawnImpl, extra = {}) => edits.rebuildBrochure(repo, 'BONA-W007', {
    cfg: { repo: '/somewhere/else', intakeDir: path.join(repo, '..', 'empty-intake'), site: 'https://bona.azoz.uk', maxBrochureMb: 25, ...extra },
    workDir: path.join(repo, '..', 'work'),
    spawnImpl,
  });

  before(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-rebuild-'));
    repo = path.join(dir, 'repo');
    // The PDF the listing came from is long gone: no file anywhere hashes to _intake.pdfSha256.
    fs.mkdirSync(path.join(dir, 'empty-intake'), { recursive: true });
    inboxFile = writeInboxListing(repo, LISTING);
    slugDir = path.join(repo, 'public', 'listings', LISTING.slug);
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, '01.jpg'), 'jpg');
    fs.writeFileSync(path.join(slugDir, 'plan-01.jpg'), 'plan');
  });
  after(() => fs.rmSync(path.dirname(repo), { recursive: true, force: true }));

  it('the source PDF really is gone (the case this used to refuse)', () => {
    assert.equal(findSourcePdf(path.join(repo, '..', 'empty-intake'), LISTING._intake.pdfSha256), null);
  });

  it('a failed build changes nothing on the listing', async () => {
    const before_ = fs.readFileSync(inboxFile, 'utf8');
    const { spawnImpl } = fakeSpawn({ result: { ok: false, reason: 'error', error: 'layout does not fit' }, code: 1 });
    const res = await build(spawnImpl);
    assert.match(res.error, /could not be built for BONA-W007/);
    assert.equal(fs.readFileSync(inboxFile, 'utf8'), before_);
  });

  it('too-large is answered with the reason', async () => {
    const { spawnImpl } = fakeSpawn({ result: { ok: false, reason: 'too-large', error: '1 bytes, cap 0' }, code: 1 });
    const res = await build(spawnImpl, { maxBrochureMb: 3 });
    assert.match(res.error, /over the 3 MB limit/);
  });

  it('builds into public/listings/<slug> from the photos and plans already there, with this repo\'s site.json', async () => {
    const { spawnImpl, calls } = fakeSpawn();
    const res = await build(spawnImpl);
    assert.ok(res && !res.error, res?.error);
    const a = argsOf(calls[0]);
    assert.equal(a.filesDir, slugDir);
    assert.equal(a.out, path.join(slugDir, 'brochure.pdf'));
    assert.equal(a.siteJson, path.join(repo, 'src', 'data', 'site.json'), 'the repo being published, not whatever cfg.repo says');
    assert.ok(fs.existsSync(path.join(slugDir, 'brochure.pdf')));
    const sent = JSON.parse(fs.readFileSync(a.listingJson, 'utf8'));
    assert.equal('_intake' in sent, false);

    assert.equal(res.listing.brochureUrl, 'https://bona.azoz.uk/listings/garden-villa-al-rawdah/brochure.pdf');
    assert.equal(res.brochure.pages, 17);
    const saved = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
    assert.equal(saved.brochureUrl, res.listing.brochureUrl);
    assert.deepEqual(saved._intake.warnings, [], 'the stale brochure-failed note is cleared');
    assert.equal(saved._intake.pdfSha256, 'abc', 'the bookkeeping stays in the repo');
  });
});

// The sha lookup stays: the backfill (plan Task 9) uses it to find which listings can be re-run
// from their original PDF.
describe('findSourcePdf — the original is found by content hash, not by a stored path', () => {
  let dir;
  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-src-'));
    fs.mkdirSync(path.join(dir, '2026-09-06'), { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-09-06', 'other.pdf'), 'not it');
    fs.writeFileSync(path.join(dir, '2026-09-06', 'MSGID.pdf'), 'the brochure bytes');
    // a work dir beside it, so the walk has a directory to skip past
    fs.mkdirSync(path.join(dir, '2026-09-06', 'MSGID', 'images'), { recursive: true });
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('finds the PDF a listing was published from', () => {
    assert.equal(findSourcePdf(dir, sha('the brochure bytes')), path.join(dir, '2026-09-06', 'MSGID.pdf'));
  });

  it('answers null rather than guessing when the download has been cleaned up', () => {
    assert.equal(findSourcePdf(dir, sha('a brochure nobody kept')), null);
    assert.equal(findSourcePdf(dir, null), null);
    assert.equal(findSourcePdf(path.join(dir, 'nope'), sha('x')), null);
  });
});
