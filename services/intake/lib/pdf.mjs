// Thin wrapper around services/intake/extract_pdf.py (PyMuPDF via uv).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extract_pdf.py');
export const DEFAULT_PY_CMD = ['uv', 'run', '--with', 'pymupdf', 'python'];

/** `pyCmd` is an argv ARRAY. A string is accepted for old configs and split on whitespace. */
export function pyArgv(pyCmd) {
  if (Array.isArray(pyCmd) && pyCmd.length) return pyCmd.filter(Boolean).map(String);
  if (typeof pyCmd === 'string' && pyCmd.trim()) return pyCmd.trim().split(/\s+/);
  return [...DEFAULT_PY_CMD];
}

function run(cmd, args, { cwd, timeoutMs = 300000 } = {}) {
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

async function runScript(args, { pyCmd, timeoutMs }) {
  const argv = pyArgv(pyCmd);
  const { code, out, err } = await run(argv[0], [...argv.slice(1), SCRIPT, ...args], { timeoutMs: timeoutMs ?? 300000 });
  const line = out.trim().split('\n').filter(Boolean).pop();
  try {
    return JSON.parse(line);
  } catch {
    return { ok: false, error: `extract_pdf.py failed (exit ${code}): ${(err || out).trim().slice(-400) || 'no output'}` };
  }
}

/**
 * @param {string} pdfPath
 * @param {string} outDir  candidate images land in <outDir>/images/
 * @param {{pyCmd?:string[]|string, minSide?:number, maxPages?:number, maxCandidates?:number}} opts
 * @returns {Promise<object>} the extract_pdf.py JSON (ok:false + error on failure)
 */
export async function extractPdf(pdfPath, outDir, opts = {}) {
  if (!fs.existsSync(pdfPath)) return { ok: false, error: `no such file: ${pdfPath}` };
  fs.mkdirSync(outDir, { recursive: true });
  return runScript([
    pdfPath, outDir,
    '--min-side', String(opts.minSide ?? 700),
    '--max-pages', String(opts.maxPages ?? 60),
    '--max-candidates', String(opts.maxCandidates ?? 40),
  ], opts);
}

/**
 * Render EVERY page as a readable image, for a brochure with no text layer: the AI reads
 * these instead of a text layer that isn't there.
 *
 * `pages` (1-based numbers), `dir` and `minShortSide` are what the photo-region cropper
 * uses to re-render a handful of pages at the resolution a crop needs — a page whose long
 * side is ten times its short side is a sliver at any long-side cap, so the SHORT side is
 * what has to be asked for.
 * @returns {Promise<{ok:boolean, pageImages?:Array<{page:number,abs:string,width:number,height:number}>, error?:string}>}
 */
export async function renderPdfPages(pdfPath, outDir, opts = {}) {
  if (!fs.existsSync(pdfPath)) return { ok: false, error: `no such file: ${pdfPath}` };
  fs.mkdirSync(outDir, { recursive: true });
  return runScript([
    pdfPath, outDir,
    '--mode', 'pages',
    '--max-pages', String(opts.maxPages ?? 60),
    '--render-long-side', String(opts.longSide ?? 1600),
    ...(opts.minShortSide ? ['--render-min-short-side', String(opts.minShortSide)] : []),
    ...(opts.maxPixels ? ['--render-max-pixels', String(opts.maxPixels)] : []),
    ...(opts.dir ? ['--page-dir', opts.dir] : []),
    ...(opts.pages?.length ? ['--pages', opts.pages.join(',')] : []),
  ], opts);
}

/**
 * Render pages FOR LOOKING AT. A page more extreme than `maxAspect` is cut into overlapping
 * slices first; every view carries the normalised page rectangle it covers so a box drawn
 * on it maps back onto the page.
 * @returns {Promise<{ok:boolean, views?:Array<{id:number,page:number,slice:number,slices:number,abs:string,width:number,height:number,x0:number,y0:number,x1:number,y1:number}>, error?:string}>}
 */
export async function renderPdfViews(pdfPath, outDir, opts = {}) {
  if (!fs.existsSync(pdfPath)) return { ok: false, error: `no such file: ${pdfPath}` };
  fs.mkdirSync(outDir, { recursive: true });
  return runScript([
    pdfPath, outDir,
    '--mode', 'views',
    '--max-pages', String(opts.maxPages ?? 60),
    '--view-long-side', String(opts.longSide ?? 1600),
    ...(opts.maxPixels ? ['--render-max-pixels', String(opts.maxPixels)] : []),
    ...(opts.maxAspect ? ['--view-max-aspect', String(opts.maxAspect)] : []),
    ...(opts.dir ? ['--view-dir', opts.dir] : []),
    ...(opts.pages?.length ? ['--pages', opts.pages.join(',')] : []),
  ], opts);
}
