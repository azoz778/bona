// The Bona-branded brochure: the developer's PDF, re-published under Bona's cover, footer
// and enquiry page (services/intake/rebrand_pdf.py does the drawing).
//
// Why this exists: the owner is sent someone else's brochure and wants the property on the
// site with his brand on the document — not a raw copy of a competitor's PDF sitting on
// bona.azoz.uk. The developer's own pages are left exactly as they are (their brand belongs
// on their pages); what Bona adds is a cover, a footer strip and a closing "Enquire" page.
//
// Size is the reason this file has a cap at all: developer brochures run 50–80 MB, the repo
// is public and CI clones it on every build. The Python downsamples the images until the
// output fits `BONA_MAX_BROCHURE_MB` (25 by default) and refuses to write anything bigger —
// the listing is then published without a brochure and the owner is told why.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPT = path.join(HERE, '..', 'rebrand_pdf.py');
export const REPO_ROOT = path.join(HERE, '..', '..', '..');

/** PyMuPDF draws, segno makes the QR, fontTools+brotli turn public/fonts/*.woff2 into TTF. */
export const DEFAULT_BROCHURE_PY_CMD = [
  'uv', 'run', '--with', 'pymupdf', '--with', 'segno', '--with', 'fonttools', '--with', 'brotli', 'python',
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

/** The price exactly as the listing states it — never a computed or rounded one. */
export function priceText(price) {
  if (!price || price.onRequest || !(typeof price.amount === 'number' && price.amount > 0)) return 'Price on request';
  const amount = Number(price.amount).toLocaleString('en-US');
  const period = price.period ? ` / ${price.period}` : '';
  return `${price.from ? 'From ' : ''}${price.currency || 'SAR'} ${amount}${period}`;
}

/**
 * The facts the cover and the closing page print. Everything comes from the FINAL listing
 * object — the one that already passed copyProblems() and checkListing() — so no model free
 * text and no untrusted PDF text ever reaches the page. rebrand_pdf.py scrubs them again.
 */
export function brochureFacts(listing, { site } = {}) {
  const base = String(site || listing?._intake?.site || 'https://bona.azoz.uk').replace(/\/+$/, '');
  const district = listing?.location?.district?.en || '';
  const city = listing?.location?.city?.en || '';
  return {
    id: listing?.id ?? null,
    slug: listing?.slug ?? null,
    titleEn: listing?.title?.en ?? null,
    titleAr: listing?.title?.ar ?? null,
    place: [district, city].filter(Boolean).join(', ') || null,
    priceEn: priceText(listing?.price),
    project: listing?.project?.name?.en ?? null,
    developer: listing?.project?.developer?.en ?? null,
    url: listing?.slug ? `${base}/properties/${listing.slug}/` : base,
  };
}

function run(cmd, args, { cwd, timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/**
 * Build `<outPath>` from `<pdfPath>` with Bona's cover, footers and enquiry page.
 *
 * Never throws for a bad PDF or a failed render: returns `{ ok: false, error, reason }` so
 * the caller can publish the listing without a brochure instead of losing the whole run.
 *
 * @param {object} opts
 * @param {string}  opts.pdfPath    the developer's PDF (outside the repo)
 * @param {object}  opts.listing    the final listing object
 * @param {string}  opts.outPath    where to write the branded PDF
 * @param {string}  opts.workDir    scratch dir for the facts JSON
 * @param {object}  opts.cfg        loadConfig() result
 * @returns {Promise<{ok:boolean, bytes?:number, srcBytes?:number, pages?:number, steps?:string[],
 *                    scrubbed?:string[], error?:string, reason?:string}>}
 */
export async function buildBrandedBrochure({ pdfPath, listing, outPath, workDir, cfg = {} }) {
  if (!fs.existsSync(pdfPath)) return { ok: false, error: `no such file: ${pdfPath}`, reason: 'input' };
  const facts = brochureFacts(listing, { site: cfg.site });
  const scratch = workDir || path.dirname(outPath);
  fs.mkdirSync(scratch, { recursive: true });
  const factsFile = path.join(scratch, 'brochure-facts.json');
  fs.writeFileSync(factsFile, `${JSON.stringify(facts, null, 2)}\n`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const argv = brochurePyArgv(cfg.brochurePyCmd);
  const args = [
    ...argv.slice(1), SCRIPT, pdfPath, factsFile, outPath,
    '--max-mb', String(cfg.maxBrochureMb ?? 25),
    '--repo', cfg.assetRepo || REPO_ROOT,
  ];
  let res;
  try {
    res = await run(argv[0], args, { timeoutMs: cfg.brochureTimeoutMs ?? 600000 });
  } catch (err) {
    return { ok: false, error: err.message, reason: 'spawn' };
  }
  const line = res.out.trim().split('\n').filter(Boolean).pop();
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {
      ok: false,
      reason: 'render',
      error: `rebrand_pdf.py failed (exit ${res.code}): ${(res.err || res.out).trim().slice(-400) || 'no output'}`,
    };
  }
  if (!parsed.ok) {
    fs.rmSync(outPath, { force: true });
    return { ok: false, reason: parsed.reason || 'render', error: parsed.error || 'the branded brochure could not be built' };
  }
  return { ...parsed, facts };
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
