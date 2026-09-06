// One PDF -> one published listing. Shared by run-once.mjs (manual) and index.mjs (daemon).
//
// Gates, in order — each one can stop the run with a one-line reason the owner reads on
// WhatsApp, and nothing is written to the repo until every gate has passed:
//   1. size/pages           (cheap, local)
//   2. classifyPdf          (default-deny keyword gate — invoices/IDs/statements never reach the AI)
//   2b. photo-region crop  (only when the pages ARE the pictures — see lib/photo-regions.mjs)
//   3. AI contract          (validateAiResult + copyProblems)  <- the real brochure/not-brochure gate
//   4. TAQEEM cross-check   (a price is published only when the NUMBER is actually printed)
//   5. checkListing         (mirror of scripts/curate/validate.mjs)
//   5b. the Bona-branded brochure (rebrand_pdf.py) — best effort, never fatal
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
import { brochureFileIn, brochureUrlFor, buildBrandedBrochure } from './brochure.mjs';
import { classifyPdf } from './classify.mjs';
import { writeConfinement } from './confine.mjs';
import { buildContactSheets } from './contact-sheet.mjs';
import { buildPrompt, confirmPriceEvidence, runListingAi } from './claude.mjs';
import { writeListingImages } from './images.mjs';
import {
  addWarningCode, buildListing, checkListing, findByPdfSha, inboxIds, nextListingId, orderedPicks,
  readIndex, seqAfter, slugify, takenSlugs, todayRiyadh, uniqueSlug, writeIndex, writeInboxListing,
} from './listing.mjs';
import { log } from './log.mjs';
import { extractPdf, renderPdfPages } from './pdf.mjs';
import { compositePages, cropPhotoRegions, modelFlagsComposites } from './photo-regions.mjs';
import { priceAppearsIn } from './price.mjs';
import { pinFromLinks } from './geo.mjs';
import { rebuild, resetTree } from './publish.mjs';

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

  const confinement = writeConfinement(workDir);
  // The rule count is one per sibling of every directory on the way to the work dir. Under
  // $BONA_DATA it is ~320; a work dir under a directory with thousands of siblings makes a
  // much larger settings file, which is still correct but slower for the CLI to load.
  const confineLog = confinement.ruleCount > 5000 ? log.warn : log.info;
  confineLog('intake.confined', { settings: confinement.file, denyRules: confinement.ruleCount });

  // --- 2b. photo-region cropping ------------------------------------------------
  // A deck exported one picture per page yields candidates that are whole pages: photo,
  // headline, logo and floor plan in one bitmap. Every one of them is rightly excluded by
  // the ranking step, and the run then dies at the photo gate. So when the pages ARE the
  // pictures, one extra confined call marks where the photographs are on them and they are
  // cut out; the crops go into the candidate list and are ranked like any other photograph.
  const composites = compositePages(extraction, { imageOnly: verdict.imageOnly });
  const ordinaryCandidates = extraction.candidates.length - composites.indices.length;
  let cropped = null;

  const runCrop = async (why) => {
    report.stage = 'crop';
    log.info('intake.cropping', { why, pages: composites.pages, ordinaryCandidates });
    const out = await cropPhotoRegions({
      pdfPath, workDir, pages: composites.pages, startIndex: extraction.candidates.length,
      cfg, settingsPath: confinement.file, logger: log,
    });
    log.info('intake.cropped', {
      why,
      pages: out.pages.length,
      views: out.views,
      boxes: out.boxes,
      crops: out.crops.length,
      dropped: out.dropped.length,
      costUsd: out.meta?.costUsd ?? null,
      error: out.error ?? null,
      rooms: out.crops.map((c) => c.room),
    });
    report.cropped = {
      why,
      pages: out.pages,
      views: out.views,
      boxes: out.boxes,
      crops: out.crops.map((c) => ({ index: c.index, page: c.page, w: c.width, h: c.height, room: c.room, note: c.note })),
      dropped: out.dropped,
      error: out.error ?? null,
    };
    if (out.crops.length) {
      extraction.candidates.push(...out.crops);
      report.candidates = extraction.candidates.length;
      report.warningCodes.push('photos-cropped');
      report.warnings.push(`${out.crops.length} photo(s) were cut out of the brochure's own pages — check the gallery`);
    }
    return out;
  };

  // Only when the brochure could not pass the photo gate on its own candidates: an ordinary
  // brochure with real photographs in it never pays for this call.
  if (composites.pages.length && ordinaryCandidates < cfg.minImages) {
    cropped = await runCrop(composites.reason);
  }

  // --- 3. AI ------------------------------------------------------------------
  report.stage = 'ai';
  const rubricPath = path.join(cfg.repo, 'scripts', 'curate', 'IMAGE-RUBRIC.md');
  const askModel = async () => {
    const sheets = await buildContactSheets(extraction.candidates, path.join(workDir, 'sheets'));
    report.sheets = sheets.map((s) => s.file);
    const prompt = buildPrompt({ extraction, sheets, caption, pageImages, rubricPath: fs.existsSync(rubricPath) ? rubricPath : null });
    fs.writeFileSync(path.join(workDir, 'prompt.txt'), prompt);
    return runListingAi({
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
  };
  let { result: ai, meta: aiMeta, attempt } = await askModel();
  fs.writeFileSync(path.join(workDir, 'ai.json'), `${JSON.stringify(ai, null, 2)}\n`);
  report.ai = ai;
  report.aiMeta = { ...aiMeta, attempt, model: cfg.claudeModel };
  log.info('intake.ai_done', { round: 1, attempt, costUsd: aiMeta.costUsd, durationMs: aiMeta.durationMs, reject: ai.reject, confidence: ai.confidence });
  if (ai.reject) throw new RejectError(ai.rejectReason || 'not a publishable property brochure', 'ai');

  // The rescue round. The geometry did not think this brochure needed cropping, but the
  // ranking step has just said in its own words that the candidates it refused are collages
  // and text pages — which is the same finding, arrived at by reading them. Crop and ask
  // once more, but only when the run would otherwise be rejected for want of photographs.
  let picks = orderedPicks(ai.images, { maxImages: cfg.maxImages });
  if (picks.length < cfg.minImages && !cropped && composites.pages.length
      && modelFlagsComposites(ai.images, composites.indices)) {
    cropped = await runCrop('the ranking step called the page-sized candidates collages');
    if (cropped.crops.length) {
      report.stage = 'ai';
      ({ result: ai, meta: aiMeta, attempt } = await askModel());
      fs.writeFileSync(path.join(workDir, 'ai.json'), `${JSON.stringify(ai, null, 2)}\n`);
      report.ai = ai;
      report.aiMeta = { ...aiMeta, attempt, model: cfg.claudeModel };
      log.info('intake.ai_done', { round: 2, attempt, costUsd: aiMeta.costUsd, durationMs: aiMeta.durationMs, reject: ai.reject, confidence: ai.confidence });
      if (ai.reject) throw new RejectError(ai.rejectReason || 'not a publishable property brochure', 'ai');
      picks = orderedPicks(ai.images, { maxImages: cfg.maxImages });
    }
  }

  // The model's `warnings` are free text from a model that just read an untrusted document.
  // They stay in ai.json: not in the listing, not in the reply.
  if (Array.isArray(ai.warnings) && ai.warnings.length) {
    report.warningCodes.push('model-flagged');
    report.warnings.push(`the model flagged ${ai.warnings.length} thing(s) to check by hand — they are in ai.json in the run's work dir`);
  }

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

  // --- 4b. map pin --------------------------------------------------------------
  // A brochure almost never prints coordinates, but it very often hides a Google Maps link
  // behind its location page. Two independent links must agree before we publish a pin —
  // brochures link landmarks too (one links King Abdulaziz airport), and a wrong pin is
  // worse than none. No pin here is not a failure: the site falls back to the district.
  report.stage = 'map';
  let mapPin = null;
  try {
    mapPin = await pinFromLinks(extraction.links);
  } catch (e) {
    log.warn('intake.map_failed', { error: String(e?.message || e) });
  }
  report.map = mapPin;
  log.info('intake.map', { links: (extraction.links || []).length, pin: mapPin });
  if (!mapPin && (extraction.links || []).some((l) => /maps/i.test(l.uri || ''))) {
    report.warningCodes.push('map-unconfirmed');
    report.warnings.push('the brochure has a map link but no two links agreed on one point, so the listing shows its district only');
  }

  // --- 5. images + listing ----------------------------------------------------
  report.stage = 'listing';
  report.picks = picks;
  report.excluded = (ai.images || []).filter((im) => im.exclude).map((im) => ({ index: im.index, reason: im.reason }));
  if (picks.length < cfg.minImages) {
    const why = cropped
      ? `even after cutting ${cropped.crops.length} photo region(s) out of its own pages`
      : (extraction.rendered ? 'the PDF has no extractable photographs, only page renders' : 'the rest were floor plans, logos or duplicates');
    const reason = `not enough usable photos — ${picks.length} of ${cfg.minImages} needed (${why})`;
    // A dry run is a preview: show the owner what WOULD have been published and why it
    // cannot be, instead of hiding the listing behind an early exit.
    if (!dryRun) throw new RejectError(reason, 'images');
    report.blocked = reason;
    report.warnings.push(reason);
    report.warningCodes.push('not-enough-photos');
  }

  // The last word on "have we published this before?", asked of the pulled repo itself and
  // therefore proof against a lost state file or a publish that `run-once.mjs` made. The
  // caller's own sha dedupe runs first and answers more kindly; this one is the backstop
  // that stands between a replay and a second listing id.
  if (!dryRun) {
    const twin = findByPdfSha(cfg.repo, report.sha256);
    if (twin) {
      const err = new RejectError(`this brochure is already published as ${twin.id} — ${cfg.site}/properties/${twin.slug}/`, 'duplicate');
      err.published = { id: twin.id, slug: twin.slug, url: `${cfg.site}/properties/${twin.slug}/` };
      throw err;
    }
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
      meta: { ...meta, sourceRef, pdfSha256: report.sha256, model: cfg.claudeModel, warningCodes: report.warningCodes, map: mapPin },
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

  const listing = buildListing({
    ai, images, slug, id, repo: cfg.repo, caption, site: cfg.site,
    meta: { ...meta, sourceRef, brochureUrl: null, pdfSha256: report.sha256, model: cfg.claudeModel, hidden: caption.hidden, warningCodes: report.warningCodes, map: mapPin },
  });
  const problems = checkListing(listing, { minImages: cfg.minImages, maxImages: cfg.maxImages });
  if (problems.length) {
    fs.rmSync(stageDir, { recursive: true, force: true });   // nothing reached the repo
    throw new RejectError(problems[0], 'validate');
  }

  // --- 5b. the Bona-branded brochure -------------------------------------------
  // Default ON: the owner's whole point is that a brochure he is sent comes back out under
  // his own brand. It is built from the FINAL listing (title, place, price as published),
  // into the staging dir, so it is promoted with the photos and rolled back with them.
  // A failure here never costs the listing — it publishes without a downloadable document.
  report.stage = 'brochure';
  if (caption.noBrochure) {
    report.brochure = { skipped: 'nobrochure' };
    log.info('intake.brochure_skipped', { slug, reason: 'nobrochure' });
  } else {
    const built = await buildBrandedBrochure({
      pdfPath, listing, outPath: brochureFileIn(stageDir), workDir, cfg,
    });
    report.brochure = built;
    if (built.ok) {
      listing.brochureUrl = brochureUrlFor(cfg.site, slug);
      log.info('intake.brochure_built', {
        slug, bytes: built.bytes, srcBytes: built.srcBytes, pages: built.pages,
        steps: built.steps, scrubbed: built.scrubbed,
      });
      if (built.scrubbed?.length) {
        report.warnings.push(`${built.scrubbed.length} fact(s) were left off the branded brochure because they carried a contact detail or another agency: ${built.scrubbed.join(', ')}`);
      }
    } else {
      const code = built.reason === 'too-large' ? 'brochure-too-large' : 'brochure-failed';
      report.warningCodes.push(code);
      addWarningCode(listing, code);
      report.warnings.push(built.reason === 'too-large'
        ? `${built.error} — the listing was published without a downloadable brochure`
        : 'the Bona-branded brochure could not be built, so the listing was published without one (the reason is in the journal)');
      log.warn('intake.brochure_failed', { slug, reason: built.reason, error: built.error });
    }
  }

  // --- 7. promote into the repo, then rebuild ----------------------------------
  report.stage = 'promote';
  const publicDir = path.join(cfg.repo, 'public', 'listings', slug);
  const listingDirs = [path.join('public', 'listings', slug)];
  try {
    fs.mkdirSync(path.dirname(publicDir), { recursive: true });
    // The branded brochure was staged alongside the photos, so it is promoted — and rolled
    // back — with them; nothing is copied into the repo out of band.
    fs.cpSync(stageDir, publicDir, { recursive: true });
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
