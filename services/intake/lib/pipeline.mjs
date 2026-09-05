// One PDF -> one published listing. Shared by run-once.mjs (manual) and index.mjs (daemon).
//
// Gates, in order — each one can stop the run with a one-line reason the owner reads on
// WhatsApp, and nothing is written to the repo until every gate has passed:
//   1. size/pages           (cheap, local)
//   2. classifyPdf          (default-deny keyword gate — invoices/IDs/contracts never reach the AI)
//   3. AI contract          (validateAiResult + copyProblems)
//   4. checkListing         (mirror of scripts/curate/validate.mjs)
//   5. build.mjs + validate.mjs in the repo (the real thing)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { classifyPdf } from './classify.mjs';
import { buildContactSheets } from './contact-sheet.mjs';
import { buildPrompt, runListingAi } from './claude.mjs';
import { writeListingImages } from './images.mjs';
import {
  buildListing, checkListing, nextListingId, orderedPicks, readIndex, slugify,
  takenSlugs, uniqueSlug, writeIndex, writeInboxListing,
} from './listing.mjs';
import { log } from './log.mjs';
import { extractPdf } from './pdf.mjs';
import { rebuild, writeBrochure } from './publish.mjs';

export const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export class RejectError extends Error {
  constructor(reason, stage) {
    super(reason);
    this.name = 'RejectError';
    this.reason = reason;
    this.stage = stage;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.pdfPath
 * @param {object} opts.cfg          loadConfig() result
 * @param {object} opts.caption      parseCaption() result
 * @param {string} opts.workDir      scratch dir for extraction + sheets
 * @param {boolean} [opts.dryRun]    stop before writing to the repo
 * @param {object} [opts.meta]       messageId / groupJid / pdfFileName
 * @returns {Promise<object>} run report
 */
export async function processPdf({ pdfPath, cfg, caption = {}, workDir, dryRun = false, meta = {} }) {
  const started = Date.now();
  const report = { pdf: pdfPath, dryRun, stage: 'start', warnings: [] };
  const stat = fs.statSync(pdfPath);
  report.bytes = stat.size;
  report.sha256 = sha256File(pdfPath);

  if (stat.size > cfg.maxPdfMb * 1024 * 1024) {
    throw new RejectError(`PDF is ${(stat.size / 1048576).toFixed(1)} MB — the limit is ${cfg.maxPdfMb} MB`, 'size');
  }

  // --- 1. extract -------------------------------------------------------------
  report.stage = 'extract';
  fs.mkdirSync(workDir, { recursive: true });
  const extraction = await extractPdf(pdfPath, workDir, {
    pyCmd: cfg.pyCmd, minSide: cfg.minImageSide, maxPages: cfg.maxPdfPages,
  });
  if (extraction.ok === false) throw new RejectError(extraction.error, 'extract');
  report.pages = extraction.pages;
  report.candidates = extraction.candidates.length;
  report.rendered = extraction.rendered;
  log.info('intake.extracted', { pages: extraction.pages, candidates: extraction.candidates.length, rendered: extraction.rendered });

  // --- 2. default-deny gate ---------------------------------------------------
  report.stage = 'classify';
  const verdict = classifyPdf(extraction, { fileName: meta.pdfFileName || path.basename(pdfPath) });
  report.classify = verdict;
  log.info('intake.classified', verdict);
  if (!verdict.ok) throw new RejectError(verdict.reason, 'classify');

  // --- 3. AI ------------------------------------------------------------------
  report.stage = 'ai';
  const sheets = await buildContactSheets(extraction.candidates, path.join(workDir, 'sheets'));
  report.sheets = sheets.map((s) => s.file);
  const rubricPath = path.join(cfg.repo, 'scripts', 'curate', 'IMAGE-RUBRIC.md');
  const prompt = buildPrompt({ extraction, sheets, caption, rubricPath: fs.existsSync(rubricPath) ? rubricPath : null });
  fs.writeFileSync(path.join(workDir, 'prompt.txt'), prompt);
  const { result: ai, meta: aiMeta, attempt } = await runListingAi({
    prompt,
    cwd: workDir,
    model: cfg.claudeModel,
    fallbackModel: cfg.claudeFallbackModel,
    bin: cfg.claudeBin,
    addDirs: [workDir],
    timeoutMs: cfg.claudeTimeoutMs,
    candidateCount: extraction.candidates.length,
    logger: log,
  });
  fs.writeFileSync(path.join(workDir, 'ai.json'), `${JSON.stringify(ai, null, 2)}\n`);
  report.ai = ai;
  report.aiMeta = { ...aiMeta, attempt, model: cfg.claudeModel };
  report.warnings.push(...(ai.warnings || []));
  log.info('intake.ai_done', { attempt, costUsd: aiMeta.costUsd, durationMs: aiMeta.durationMs, reject: ai.reject, confidence: ai.confidence });
  if (ai.reject) throw new RejectError(ai.rejectReason || 'not a publishable property brochure', 'ai');

  // --- 4. images + listing ----------------------------------------------------
  report.stage = 'listing';
  const picks = orderedPicks(ai.images, { maxImages: cfg.maxImages });
  report.picks = picks;
  report.excluded = (ai.images || []).filter((im) => im.exclude).map((im) => ({ index: im.index, reason: im.reason }));
  if (picks.length < cfg.minImages) {
    throw new RejectError(
      `not enough usable photos — ${picks.length} of ${cfg.minImages} needed (${extraction.rendered ? 'the PDF has no extractable photographs, only page renders' : 'the rest were floor plans, logos or duplicates'})`,
      'images',
    );
  }

  const index = readIndex(cfg.repo);
  const id = meta.id || nextListingId(index);
  const baseSlug = slugify(ai.listing.title.en) || slugify(ai.listing.location?.district?.en, ai.listing.type) || `listing-${id.toLowerCase()}`;
  const slug = meta.slug || uniqueSlug(baseSlug, takenSlugs(cfg.repo));
  report.id = id;
  report.slug = slug;
  report.url = `${cfg.site}/properties/${slug}/`;

  const sourceRef = meta.messageId
    ? `WA-${(meta.listedAt || new Date().toISOString().slice(0, 10)).replace(/-/g, '')}-${String(meta.messageId).replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase()}`
    : `WA-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${report.sha256.slice(0, 6).toUpperCase()}`;

  if (dryRun) {
    report.stage = 'dry-run';
    report.listingPreview = buildListing({
      ai,
      images: picks.map((p) => ({ ...p, n: p.rank, src: `/listings/${slug}/${String(p.rank).padStart(2, '0')}.jpg`, thumb: `/listings/${slug}/${String(p.rank).padStart(2, '0')}-thumb.webp` })),
      slug, id, repo: cfg.repo, caption, site: cfg.site,
      meta: { ...meta, sourceRef, pdfSha256: report.sha256, model: cfg.claudeModel },
    });
    const problems = checkListing(report.listingPreview, { minImages: cfg.minImages, maxImages: cfg.maxImages });
    if (problems.length) report.warnings.push(...problems);
    report.durationMs = Date.now() - started;
    report.ok = true;
    return report;
  }

  // --- 5. write into the repo --------------------------------------------------
  report.stage = 'write';
  const publicDir = path.join(cfg.repo, 'public', 'listings', slug);
  const images = await writeListingImages(extraction.candidates, picks, publicDir, slug);
  report.images = images.map((im) => ({ n: im.n, candidate: im.index, room: im.room, src: im.src, w: im.width, h: im.height, reason: im.reason }));

  const brochureUrl = caption.publishBrochure ? `${cfg.site}/listings/${slug}/brochure.pdf` : null;
  if (brochureUrl) writeBrochure(cfg.repo, slug, pdfPath);

  const listing = buildListing({
    ai, images, slug, id, repo: cfg.repo, caption, site: cfg.site,
    meta: { ...meta, sourceRef, brochureUrl, pdfSha256: report.sha256, model: cfg.claudeModel, hidden: caption.hidden },
  });
  const problems = checkListing(listing, { minImages: cfg.minImages, maxImages: cfg.maxImages });
  if (problems.length) {
    fs.rmSync(publicDir, { recursive: true, force: true });
    throw new RejectError(problems[0], 'validate');
  }
  report.file = writeInboxListing(cfg.repo, listing);
  writeIndex(cfg.repo, { ...index, nextSeq: (index.nextSeq ?? 1) + 1, listings: { ...index.listings, [slug]: id } });
  report.listing = listing;

  // --- 6. rebuild the site data -------------------------------------------------
  report.stage = 'rebuild';
  report.rebuild = await rebuild(cfg.repo);
  report.durationMs = Date.now() - started;
  report.ok = true;
  report.stage = 'done';
  return report;
}
