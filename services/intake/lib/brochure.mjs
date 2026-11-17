// The Bona brochure: one bilingual A4 PDF built from scratch out of the published listing — its
// own fields, its photos and floor plans, and src/data/site.json — in the TK design system
// (services/intake/brochure_pdf.py does the drawing, with WeasyPrint).
//
// Why this exists: the owner is sent someone else's brochure and wants the property on the site
// with his brand on the document. Nothing of the developer's PDF is re-published: the brochure
// is drawn from the listing that already passed copyProblems() and checkListing(), so no model
// free text the validators did not see and no untrusted PDF text ever reaches a page, and the
// developer is named as text only.
//
// It needs only what the repo already holds (the listing JSON and `public/listings/<slug>/`), so
// `brochure <id>` can rebuild it long after the developer's original was cleaned out of
// $BONA_DATA.
//
// Size: the repo is public and CI clones it on every build. The Python scales the images down
// until the output fits `BONA_MAX_BROCHURE_MB` (25 by default) and refuses to write anything
// bigger — the listing is then published without a brochure and the owner is told why.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPT = path.join(HERE, '..', 'brochure_pdf.py');
export const REPO_ROOT = path.join(HERE, '..', '..', '..');

/**
 * WeasyPrint lays the pages out — PINNED, because brochure_pdf.py measures its text blocks and
 * checks the finished render box by box: a release that breaks one line differently is a
 * brochure that no longer fits. segno draws the QR, Pillow prepares the photos, PyMuPDF is used
 * by the script's own checks.
 */
export const DEFAULT_BROCHURE_PY_CMD = [
  'uv', 'run', '--with', 'weasyprint==70.0', '--with', 'segno', '--with', 'pillow', '--with', 'pymupdf', 'python',
];

/** The one name the site's "Download brochure" button points at. */
export const BROCHURE_FILE = 'brochure.pdf';

/** `pyCmd` is an argv ARRAY. A string is accepted for old configs and split on whitespace. */
export function brochurePyArgv(pyCmd) {
  if (Array.isArray(pyCmd) && pyCmd.length) return pyCmd.filter(Boolean).map(String);
  if (typeof pyCmd === 'string' && pyCmd.trim()) return pyCmd.trim().split(/\s+/);
  return [...DEFAULT_BROCHURE_PY_CMD];
}

/** Repo-relative path of a listing's brochure — inside `public/listings/<slug>`, which is
 *  already on the git staging allowlist in publish.mjs (ALLOWED_PATHS). */
export const brochureRepoPath = (slug) => path.posix.join('public', 'listings', slug, BROCHURE_FILE);
export const brochureFileIn = (dir) => path.join(dir, BROCHURE_FILE);
export const brochureUrlFor = (site, slug) => `${String(site).replace(/\/+$/, '')}/listings/${slug}/${BROCHURE_FILE}`;

/**
 * The listing as the site publishes it: no `_intake` (the caption, the source hash, the model's
 * bookkeeping), no other `_` key and no `hidden`. brochure_pdf.py ignores them too; this makes
 * sure they never reach its input file at all.
 */
export function publicListing(listing) {
  return Object.fromEntries(Object.entries(listing ?? {}).filter(([k]) => k !== 'hidden' && !k.startsWith('_')));
}

const TAIL = 16384;   // keep the end of each stream: the result line is last, a traceback ends there

function run(spawnImpl, cmd, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // Its own process group, so a timeout kills `uv` AND the python under it: a renderer left
      // running would write brochure.pdf after the caller had already given up on it.
      child = spawnImpl(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      reject(err);
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        if (child.pid > 0) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { child.kill('SIGKILL'); }
      reject(Object.assign(new Error(`${cmd} timed out after ${timeoutMs}ms`), { timeout: true }));
    }, timeoutMs);
    child.stdout?.on('data', (d) => { out = (out + d).slice(-TAIL); });
    child.stderr?.on('data', (d) => { err = (err + d).slice(-TAIL); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/**
 * Draw the brochure for `listing` into `outPath`, from the photos (`01.jpg…`) and floor plans
 * (`plan-NN.jpg`) in `filesDir`.
 *
 * Never throws: a failure is `{ ok: false, reason, error }` so the caller publishes the listing
 * without a brochure instead of losing the whole run. Nothing is deleted on failure — the script
 * writes through a temporary file, so an existing brochure at `outPath` stays as it was.
 *
 * @param {object} opts
 * @param {object}  opts.listing    the final listing object (its `_intake` is never passed on)
 * @param {string}  opts.filesDir   the listing's folder: the staging dir, or public/listings/<slug>
 * @param {string}  opts.outPath    where to write the PDF
 * @param {string}  opts.workDir    scratch: brochure-listing.json and the prepared images
 * @param {object}  opts.cfg        loadConfig() result; `cfg.repo` is the repo whose site.json is printed
 * @param {Function} [opts.spawnImpl] child_process.spawn, injectable for tests
 * @returns {Promise<{ok:boolean, bytes?:number, pages?:number, steps?:string[],
 *                    reason?:string, error?:string, detail?:string}>}
 */
export async function buildBrandedBrochure({ listing, filesDir, outPath, workDir, cfg = {}, spawnImpl = spawn }) {
  let isDir = false;
  try { isDir = fs.statSync(filesDir).isDirectory(); } catch { /* answered below */ }
  if (!isDir) return { ok: false, reason: 'input', error: `no such folder: ${filesDir}` };

  const scratch = workDir || path.dirname(outPath);
  fs.mkdirSync(scratch, { recursive: true });
  const listingJson = path.join(scratch, 'brochure-listing.json');
  fs.writeFileSync(listingJson, `${JSON.stringify(publicListing(listing), null, 2)}\n`);
  const siteJson = path.join(cfg.repo || REPO_ROOT, 'src', 'data', 'site.json');
  const maxMb = cfg.maxBrochureMb ?? 25;

  const argv = brochurePyArgv(cfg.brochurePyCmd);
  const args = [
    ...argv.slice(1), '-I', SCRIPT, listingJson, filesDir, siteJson, outPath,
    '--max-mb', String(maxMb), '--work', path.join(scratch, 'brochure-work'),
  ];
  let res;
  try {
    res = await run(spawnImpl, argv[0], args, { timeoutMs: cfg.brochureTimeoutMs ?? 600000 });
  } catch (err) {
    return { ok: false, reason: err.timeout ? 'timeout' : 'spawn', error: err.message };
  }
  const failed = () => ({
    ok: false,
    reason: 'render',
    error: `brochure_pdf.py failed (exit ${res.code}): ${(res.err || res.out).trim().slice(-400) || 'no output'}`,
  });
  const line = res.out.trim().split('\n').filter(Boolean).pop();
  let parsed;
  try { parsed = JSON.parse(line); } catch { return failed(); }
  if (!parsed || typeof parsed !== 'object') return failed();
  if (parsed.ok !== true) {
    if (parsed.reason === 'too-large') {
      return {
        ok: false,
        reason: 'too-large',
        error: `the brochure is over the ${maxMb} MB limit even with its photos scaled down`,
        detail: parsed.error || null,
      };
    }
    return { ok: false, reason: parsed.reason || 'render', error: parsed.error || 'the brochure could not be built' };
  }
  // A result line that says ok over a missing file would publish a button to a 404.
  if (res.code !== 0 || !fs.existsSync(outPath)) return failed();
  return { ok: true, bytes: parsed.bytes, pages: parsed.pages, steps: parsed.steps };
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * Find the PDF a listing was published from, by content hash, under `$BONA_DATA/intake`.
 * The downloads live at `<intakeDir>/<date>/<messageId>.pdf`; hashing beats trusting the
 * state file, which a `run-once.mjs` publish never wrote to at all.
 * @returns {string|null}
 */
export function findSourcePdf(intakeDir, wantedSha, { maxDepth = 3 } = {}) {
  if (!wantedSha || !intakeDir || !fs.existsSync(intakeDir)) return null;
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    // Files first: the download sits beside its work dir, so we usually never recurse.
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.pdf')) continue;
      const file = path.join(dir, entry.name);
      try { if (sha256(file) === wantedSha) return file; } catch { /* unreadable, skip */ }
    }
    if (depth <= 0) return null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = walk(path.join(dir, entry.name), depth - 1);
      if (found) return found;
    }
    return null;
  };
  return walk(intakeDir, maxDepth);
}
