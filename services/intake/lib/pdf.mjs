// Thin wrapper around services/intake/extract_pdf.py (PyMuPDF via uv).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extract_pdf.py');

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

/**
 * @param {string} pdfPath
 * @param {string} outDir  candidate images land in <outDir>/images/
 * @param {{pyCmd?:string, minSide?:number, maxPages?:number, maxCandidates?:number}} opts
 * @returns {Promise<object>} the extract_pdf.py JSON (ok:false + error on failure)
 */
export async function extractPdf(pdfPath, outDir, opts = {}) {
  if (!fs.existsSync(pdfPath)) return { ok: false, error: `no such file: ${pdfPath}` };
  fs.mkdirSync(outDir, { recursive: true });
  const pyCmd = (opts.pyCmd || 'uv run --with pymupdf python').split(/\s+/);
  const args = [
    ...pyCmd.slice(1),
    SCRIPT,
    pdfPath,
    outDir,
    '--min-side', String(opts.minSide ?? 700),
    '--max-pages', String(opts.maxPages ?? 60),
    '--max-candidates', String(opts.maxCandidates ?? 40),
  ];
  const { code, out, err } = await run(pyCmd[0], args, { timeoutMs: opts.timeoutMs ?? 300000 });
  const line = out.trim().split('\n').filter(Boolean).pop();
  try {
    const json = JSON.parse(line);
    if (json.ok === false) return json;
    return json;
  } catch {
    return { ok: false, error: `extract_pdf.py failed (exit ${code}): ${(err || out).trim().slice(-400) || 'no output'}` };
  }
}
