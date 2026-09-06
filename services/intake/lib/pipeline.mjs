// One PDF -> one published listing. Shared by run-once.mjs (manual) and index.mjs (daemon).
//
// Gates, in order — each one can stop the run with a one-line reason the owner reads on
// WhatsApp, and nothing is written to the repo until every gate has passed:
//   1. size/pages           (cheap, local)
//   2. classifyPdf          (default-deny keyword gate — invoices/IDs/statements never reach the AI)
//   3. AI contract          (validateAiResult + copyProblems)  <- the real brochure/not-brochure gate
//   4. TAQEEM cross-check   (a price is published only when the NUMBER is actually printed)
//   5. checkListing         (mirror of scripts/curate/validate.mjs)
//   6. build.mjs + validate.mjs in the repo (the real thing)
//
// The caller is responsible for the git side and MUST have brought the clone up to date
// BEFORE calling: build.mjs rewrites the tracked src/data/listings.json, and `git rebase`
// refuses to run with unstaged changes.
//
// Files are written into a staging directory inside the work dir and promoted into the repo
// only once checkListing() has passed; if the repo-side rebuild then fails, resetTree()
// puts the clone back exactly as it was, so the next job starts clean.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { classifyPdf } from './classify.mjs';
import { writeConfinement } from './confine.mjs';
import { buildContactSheets } from './contact-sheet.mjs';
import { buildPrompt, confirmPriceEvidence, runListingAi } from './claude.mjs';
import { writeListingImages } from './images.mjs';
import {
  buildListing, checkListing, inboxIds, nextListingId, orderedPicks, readIndex, seqAfter,
  slugify, takenSlugs, todayRiyadh, uniqueSlug, writeIndex, writeInboxListing,
} from './listing.mjs';
import { log } from './log.mjs';
import { extractPdf, renderPdfPages } from './pdf.mjs';
import { priceAppearsIn } from './price.mjs';
import { rebuild, resetTree, writeBrochure } from './publish.mjs';

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
 * @param {string} opts.workDir      scratch dir for extraction + sheets + staging
 * @param {boolean} [opts.dryRun]    stop before writing to the repo
 * @param {object} [opts.meta]       messageId / groupJid / pdfFileName
 * @returns {Promise<object>} run report
 */
export async function processPdf({ pdfPath, cfg, caption = {}, workDir, dryRun = false, meta = {} }) {
  const started = Date.now();
  // `warnings` are OUR sentences (safe to send to WhatsApp); `warningCodes` are the fixed
  // vocabulary written into the listing. Model free text belongs in neither.
  const report = { pdf: pdfPath, dryRun, stage: 'start', warnings: [], warningCodes: [] };
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

  // A brochure with no text layer is NOT accepted locally: every page is rendered and the
  // AI reads them. Default-deny still holds — it just happens one gate later.
  let pageImages = [];
  if (verdict.imageOnly) {
    report.stage = 'page-renders';
    const pages = await renderPdfPages(pdfPath, workDir, {
      pyCmd: cfg.pyCmd, maxPages: cfg.maxPdfPages, longSide: cfg.pageReadLongSide,
    });
    if (pages.ok === false) throw new RejectError(pages.error, 'extract');
    pageImages = pages.pageImages || [];
    report.pageImages = pageImages.length;
    log.info('intake.page_renders', { pages: pageImages.length, longSide: cfg.pageReadLongSide });
  }

  // --- 3. AI ------------------------------------------------------------------
  report.stage = 'ai';
  const sheets = await buildContactSheets(extraction.candidates, path.join(workDir, 'sheets'));
  report.sheets = sheets.map((s) => s.file);
  const rubricPath = path.join(cfg.repo, 'scripts', 'curate', 'IMAGE-RUBRIC.md');
  const prompt = buildPrompt({ extraction, sheets, caption, pageImages, rubricPath: fs.existsSync(rubricPath) ? rubricPath : null });
  fs.writeFileSync(path.join(workDir, 'prompt.txt'), prompt);
  const confinement = writeConfinement(workDir);
  // The rule count is one per sibling of every directory on the way to the work dir. Under
  // $BONA_DATA it is ~320; a work dir under a directory with thousands of siblings makes a
  // much larger settings file, which is still correct but slower for the CLI to load.
  const confineLog = confinement.ruleCount > 5000 ? log.warn : log.info;
  confineLog('intake.confined', { settings: confinement.file, denyRules: confinement.ruleCount });
  const { result: ai, meta: aiMeta, attempt } = await runListingAi({
    prompt,
    cwd: workDir,
    model: cfg.claudeModel,
    fallbackModel: cfg.claudeFallbackModel,
    bin: cfg.claudeBin,
    addDirs: [workDir],
    settingsPath: confinement.file,
    timeoutMs: cfg.claudeTimeoutMs,
    candidateCount: extraction.candidates.length,
    logger: log,
  });
  fs.writeFileSync(path.join(workDir, 'ai.json'), `${JSON.stringify(ai, null, 2)}\n`);
  report.ai = ai;
  report.aiMeta = { ...aiMeta, attempt, model: cfg.claudeModel };
  // The model's `warnings` are free text from a model that just read an untrusted document.
  // They stay in ai.json: not in the listing, not in the reply.
  if (Array.isArray(ai.warnings) && ai.warnings.length) {
    report.warningCodes.push('model-flagged');
    report.warnings.push(`the model flagged ${ai.warnings.length} thing(s) to check by hand — they are in ai.json in the run's work dir`);
  }
  log.info('intake.ai_done', { attempt, costUsd: aiMeta.costUsd, durationMs: aiMeta.durationMs, reject: ai.reject, confidence: ai.confidence });
  if (ai.reject) throw new RejectError(ai.rejectReason || 'not a publishable property brochure', 'ai');

  // --- 4. TAQEEM cross-check ---------------------------------------------------
  // A price may only be published when the number is really printed. The model is not
  // trusted to have read one: look it up in the text layer and in the caption, and for a
  // brochure with no text layer make a second `claude -p` look at the page it cited.
  report.stage = 'price';
  const price = ai.listing?.price;
  if (!caption.price && price && !price.onRequest && typeof price.amount === 'number' && price.amount > 0) {
    const haystack = `${extraction.text || ''}\n${caption.text || ''}`;
    let evidenced = priceAppearsIn(haystack, price.amount);
    report.priceEvidence = { inText: evidenced, confirmed: null };
    if (!evidenced && pageImages.length && ai.priceEvidence) {
      const page = pageImages.find((p) => p.page === ai.priceEvidence.page);
      if (page) {
        const check = await confirmPriceEvidence({
          pageImage: page.abs,
          amount: price.amount,
          currency: price.currency,
          quote: ai.priceEvidence.quote,
          bin: cfg.claudeBin,
          model: cfg.claudeModel,
          cwd: workDir,
          addDirs: [workDir],
          settingsPath: confinement.file,
        });
        evidenced = check.confirmed;
        report.priceEvidence.confirmed = check.confirmed;
        log.info('intake.price_evidence', { page: ai.priceEvidence.page, confirmed: check.confirmed, error: check.error ?? null });
      }
    }
    if (!evidenced) {
      log.warn('intake.price_unevidenced', { amount: price.amount, currency: price.currency });
      price.amount = null;
      price.onRequest = true;
      price.from = false;
      report.warningCodes.push('price-not-printed');
      report.warnings.push('the price was not printed in the brochure, so the listing says "price on request" — send `price <id> <amount>` to set one');
    }
  }

  // --- 5. images + listing ----------------------------------------------------
  report.stage = 'listing';
  const picks = orderedPicks(ai.images, { maxImages: cfg.maxImages });
  report.picks = picks;
  report.excluded = (ai.images || []).filter((im) => im.exclude).map((im) => ({ index: im.index, reason: im.reason }));
  if (picks.length < cfg.minImages) {
    const reason = `not enough usable photos — ${picks.length} of ${cfg.minImages} needed (${extraction.rendered ? 'the PDF has no extractable photographs, only page renders' : 'the rest were floor plans, logos or duplicates'})`;
    // A dry run is a preview: show the owner what WOULD have been published and why it
    // cannot be, instead of hiding the listing behind an early exit.
    if (!dryRun) throw new RejectError(reason, 'images');
    report.blocked = reason;
    report.warnings.push(reason);
    report.warningCodes.push('not-enough-photos');
  }

  const index = readIndex(cfg.repo);
  const id = meta.id || nextListingId(index, inboxIds(cfg.repo));
  const baseSlug = slugify(ai.listing.title.en) || slugify(ai.listing.location?.district?.en, ai.listing.type) || `listing-${id.toLowerCase()}`;
  const slug = meta.slug || uniqueSlug(baseSlug, takenSlugs(cfg.repo));
  report.id = id;
  report.slug = slug;
  report.url = `${cfg.site}/properties/${slug}/`;

  const day = (meta.listedAt || todayRiyadh()).replace(/-/g, '');
  const tail = meta.messageId ? String(meta.messageId).replace(/[^A-Za-z0-9]/g, '').slice(0, 6) : report.sha256.slice(0, 6);
  const sourceRef = `WA-${day}-${tail.toUpperCase()}`;

  if (dryRun) {
    report.stage = 'dry-run';
    report.listingPreview = buildListing({
      ai,
      images: picks.map((p) => ({ ...p, n: p.rank, src: `/listings/${slug}/${String(p.rank).padStart(2, '0')}.jpg`, thumb: `/listings/${slug}/${String(p.rank).padStart(2, '0')}-thumb.webp` })),
      slug, id, repo: cfg.repo, caption, site: cfg.site,
      meta: { ...meta, sourceRef, pdfSha256: report.sha256, model: cfg.claudeModel, warningCodes: report.warningCodes },
    });
    const problems = checkListing(report.listingPreview, { minImages: cfg.minImages, maxImages: cfg.maxImages });
    if (problems.length) report.warnings.push(...problems);
    report.durationMs = Date.now() - started;
    report.ok = true;
    return report;
  }

  // --- 6. stage the files OUTSIDE the repo -------------------------------------
  report.stage = 'write';
  const stageDir = path.join(workDir, 'publish', slug);
  fs.rmSync(stageDir, { recursive: true, force: true });
  const images = await writeListingImages(extraction.candidates, picks, stageDir, slug);
  if (images.skipped?.length) {
    report.warningCodes.push('images-skipped');
    report.warnings.push(`${images.skipped.length} photo(s) could not be processed and were left out`);
    log.warn('intake.images_skipped', { skipped: images.skipped });
  }
  report.images = images.map((im) => ({ n: im.n, candidate: im.index, room: im.room, src: im.src, w: im.width, h: im.height, reason: im.reason }));

  // #brochure commits the PDF itself. Cap it: the repo is cloned on every CI run, and a
  // 10 MB developer brochure per listing adds up fast.
  let brochureUrl = null;
  const publishBrochure = caption.publishBrochure && stat.size <= cfg.maxBrochureMb * 1024 * 1024;
  if (caption.publishBrochure && !publishBrochure) {
    report.warningCodes.push('brochure-too-large');
    report.warnings.push(`the PDF is ${(stat.size / 1048576).toFixed(1)} MB, over the ${cfg.maxBrochureMb} MB limit for #brochure — the listing was published without it`);
  }
  if (publishBrochure) brochureUrl = `${cfg.site}/listings/${slug}/brochure.pdf`;

  const listing = buildListing({
    ai, images, slug, id, repo: cfg.repo, caption, site: cfg.site,
    meta: { ...meta, sourceRef, brochureUrl, pdfSha256: report.sha256, model: cfg.claudeModel, hidden: caption.hidden, warningCodes: report.warningCodes },
  });
  const problems = checkListing(listing, { minImages: cfg.minImages, maxImages: cfg.maxImages });
  if (problems.length) {
    fs.rmSync(stageDir, { recursive: true, force: true });   // nothing reached the repo
    throw new RejectError(problems[0], 'validate');
  }

  // --- 7. promote into the repo, then rebuild ----------------------------------
  report.stage = 'promote';
  const publicDir = path.join(cfg.repo, 'public', 'listings', slug);
  const listingDirs = [path.join('public', 'listings', slug)];
  try {
    fs.mkdirSync(path.dirname(publicDir), { recursive: true });
    fs.cpSync(stageDir, publicDir, { recursive: true });
    if (publishBrochure) writeBrochure(cfg.repo, slug, pdfPath);
    report.file = writeInboxListing(cfg.repo, listing);
    writeIndex(cfg.repo, { ...index, nextSeq: seqAfter(id), listings: { ...index.listings, [slug]: id } });
    report.listing = listing;

    report.stage = 'rebuild';
    report.rebuild = await rebuild(cfg.repo);
  } catch (err) {
    // Anything from here on leaves the clone dirty; put it back so the NEXT job can pull.
    const clean = await resetTree(cfg.repo, { dirs: listingDirs });
    log.error('intake.rolled_back', { slug, stage: report.stage, clean, error: err.message, detail: err.detail });
    err.rolledBack = true;
    throw err;
  }
  report.durationMs = Date.now() - started;
  report.ok = true;
  report.stage = 'done';
  return report;
}
