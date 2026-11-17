// One PDF -> one published listing. Shared by run-once.mjs (manual) and index.mjs (daemon).
//
// Gates, in order — each one can stop the run with a one-line reason the owner reads on
// WhatsApp, and nothing is written to the repo until every gate has passed:
//   0. withdrawn advertising (the brochure's bytes — before anything else, rules.mjs)
//   1. size/pages           (cheap, local)
//   2. classifyPdf          (default-deny keyword gate — invoices/IDs/statements never reach the AI)
//   2a. withdrawn advertising (the project's name in the brochure's own words: its text layer,
//       metadata, links, the file name it was sent under, the caption — before a model is paid)
//   2b. photo-region crop  (only when the pages ARE the pictures — see lib/photo-regions.mjs)
//   3. AI contract          (validateAiResult + copyProblems)  <- the real brochure/not-brochure gate
//   3b. withdrawn advertising (the project's name, as the model read it off the brochure — in the
//       title, the project, or anywhere in the copy it wrote: a brochure with no text layer)
//   4. TAQEEM cross-check   (a price is published only when the NUMBER is actually printed;
//                            every unit-model price is confirmed on its page image, model-prices.mjs)
//   5. checkListing         (mirror of scripts/curate/validate.mjs)
//   5b. the Bona brochure (brochure_pdf.py, from the staged listing) — best effort, never fatal
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
import { isDeepStrictEqual } from 'node:util';
import { BROCHURE_FILE, brochureFileIn, brochureUrlFor, buildBrandedBrochure } from './brochure.mjs';
import { classifyPdf } from './classify.mjs';
import { writeConfinement } from './confine.mjs';
import { buildContactSheets } from './contact-sheet.mjs';
import { buildPrompt, confirmModelPrices, confirmPriceEvidence, runListingAi } from './claude.mjs';
import { floorPlanTargets, removeListingImages, writeFloorPlans, writeListingImages } from './images.mjs';
import {
  addWarningCode, buildListing, checkListing, enrichHeadline, enrichMetaFor, findByPdfSha, findInbox, inboxIds, mergeEnrichment,
  modelsAndFacts, nextListingId, orderedPicks, readIndex, seqAfter, slugify, takenSlugs, todayRiyadh, uniqueSlug, writeIndex,
  writeInboxListing,
} from './listing.mjs';
import { log } from './log.mjs';
import { ABROAD_CURRENCIES, alignHeadline, checkModelPrices, countryCurrency, homeCurrency, isFigure, modelPriceCurrency } from './model-prices.mjs';
import { extractPdf, renderPdfPages } from './pdf.mjs';
import { compositePages, cropPhotoRegions, modelFlagsComposites } from './photo-regions.mjs';
import { priceAppearsIn, printedInCurrency, westernise } from './price.mjs';
import { isSubsidyPricePage, pricePagesToRender } from './price-pages.mjs';
import { pinFromLinks } from './geo.mjs';
import { changedSincePublished, committedUnchanged, rebuild, resetTree } from './publish.mjs';
import { FACT_LISTS, headlineFollowsModels, loadRegisterWithdrawals, withdrawnAdvertising, withdrawnNamedIn, withdrawnNotice } from '../../../scripts/curate/rules.mjs';

/** Words that make a figure in the copy a price: a currency, "price", "from"-style openers. */
const PRICE_CONTEXT_RE = /سعر|أسعار|اسعار|ريال|ر\.\s?س|ثمن|قيمة(?!\s*المضافة)|ابتداء|تبدأ|يبدأ|\b(?:SAR|SR|AED|USD|EUR|GBP|riyals?|prices?|priced|costs?|starting|starts)\b|[$€£﷼\u20c1]/i;

/** "Starting from" wording in a price's evidence: from / starting / starts at, ابتداءً من / إبتداء, يبدأ / تبدأ من. */
const FROM_WORDING_RE = /\b(?:from|starting|starts)\b|بتداء|[يت]بد[أا]/i;

/**
 * A measurement or a count: ONE figure followed straight away by its unit — "3 million square
 * metres", "120 m²", "1,710 units", "a 20 m street", "٣ ملايين متر مربع" (after westernise). These
 * are cut out of a sentence before a refused price is looked for in it, so only the mention that IS
 * the figure is excused, never a sentence that merely has an area in it somewhere. The digit run has
 * no spaces, so "from 319,015, 1,710 units" cannot swallow the price into the measurement. A bare
 * "m" is metres only with a space before it ("20 m"): written solid ("4.5m") it is millions, the
 * same rule priceAppearsIn applies.
 */
const MEASURE_G = new RegExp(String.raw`(?<![\d.,٫٬])\d+(?:[.,٫٬]\d{3})*(?:[.٫]\d+)?\s*(?:(?:million|thousand|mn|m|k|مليون|ملايين|ألف|آلاف|الف)\s*)?`
  + String.raw`(?:m²|m2(?!\d)|sq\.?\s?(?:m|ft)\b|square\s+(?:met|feet|foot)|met(?:re|er)s?\b|(?<=\s)m(?![a-z²\d])|ft\b|feet\b|hectares?\b|km\b|units?\b|buildings?\b|residents?\b|visitors?\b|trees?\b|`
  + String.raw`م²|م2|متر|هكتار|كم(?![\u0600-\u06ff])|م(?![\u0600-\u06ff])|وحد(?:ة|ات)|مبن[ىي]|مباني|ساكن|سكان|زائر|شجر)`, 'gi');
const withoutMeasures = (seg) => westernise(seg).replace(MEASURE_G, ' ');

export const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Every string in a model answer's listing (title, project, copy, highlights, …), for the name check. */
const stringsIn = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(stringsIn) : []);

const SENTENCE_END = /[.!?؟؛;\n]+(?=\s|$)/;
const pairText = (v) => [v?.en, v?.ar];
const listText = (v) => ['en', 'ar'].flatMap((k) => (Array.isArray(v?.[k]) ? v[k] : []));

/**
 * Every text a run publishes from the reading, cut into sentences, each `{ seg, where }`: the listing's
 * title, description and highlights (`listingCopy`, a publish — "the copy"), every unit model's name,
 * rooms and availability, and the fact lists (FACT_LISTS: amenities / nearby / warranties).
 */
function publishedText(ai, { listingCopy = true } = {}) {
  const l = ai?.listing;
  const groups = [
    ['the copy', listingCopy ? [...pairText(l?.title), ...listText(l?.description), ...listText(l?.highlights)] : []],
    ["a unit model's text", (Array.isArray(ai?.models) ? ai.models : []).flatMap((m) => [...pairText(m?.name), ...listText(m?.rooms), ...pairText(m?.availability)])],
    ['a fact list', Object.keys(FACT_LISTS).flatMap((k) => listText(ai?.[k]))],
  ];
  return groups.flatMap(([where, texts]) => texts.filter((x) => typeof x === 'string' && x)
    .flatMap((x) => x.split(SENTENCE_END)).map((seg) => ({ seg, where })));
}

/**
 * The copy guard: the first refused figure (`refused`, not among `published`) that a published text
 * still states as a price — `{ n, where }` — or null. A sentence with price wording counts whole;
 * otherwise only what is left once the measurements are cut out ("3 million square metres" is an area,
 * "the asking figure is 1,250,000 for a 120 m² flat" is still the refused price). A bare figure counts:
 * "Buildings G–P, 419,994 / 356,024" states 419,994.
 */
function refusedFigureIn(segments, refused, published) {
  const shown = new Set(published.filter((n) => typeof n === 'number' && n > 0));
  for (const n of refused) {
    if (shown.has(n)) continue;
    const hit = segments.find(({ seg }) => priceAppearsIn(seg, n) && (PRICE_CONTEXT_RE.test(seg) || priceAppearsIn(withoutMeasures(seg), n)));
    if (hit) return { n, where: hit.where };
  }
  return null;
}

/**
 * The withdrawal a model's reading of the brochure falls under, or null: by the listing's own fields
 * (rules.mjs withdrawnAdvertising: title, project name, slug) or by a withdrawn name anywhere in the
 * copy it wrote — a model can title a re-export generically and leave `project` empty.
 */
const withdrawnInAnswer = (listing, sha256, withdrawals) =>
  withdrawnAdvertising({ ...listing, _intake: { pdfSha256: sha256 } }, withdrawals)
  ?? withdrawnNamedIn(stringsIn(listing), withdrawals);

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
 * @param {object} [opts.meta]       messageId / groupJid / pdfFileName; or, for run-once --replace,
 *                                   { replace: true, id, slug, listedAt, sourceRef } of the listing to rewrite;
 *                                   or, for run-once --enrich, { enrich: { id, slug } } of the listing to
 *                                   add unit models, floor plans, fact lists and a new brochure to
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

  // --- replace: checked first, before a page is read or a model is paid ------------
  // `meta.replace` (run-once --replace <id>): re-run a brochure over the listing it already
  // published — same id, slug, date and reference, new copy, price and photos. Used after a fix to
  // the intake itself (2026-11-17: W023's prices were on pages the first run could not read).
  if (meta.replace) {
    if (!meta.id || !meta.slug) throw new Error('replace needs the id and slug of the listing it replaces');
    const current = findInbox(cfg.repo, meta.id);
    if (!current || current.listing.slug !== meta.slug) throw new Error(`${meta.id} is not in the inbox under ${meta.slug} — nothing to replace`);
    // The old photos are deleted before the new ones are copied in, and a failed run is rolled
    // back from git: so the listing as it stands must BE in git, unchanged, or it is lost.
    if (!dryRun && !(await committedUnchanged(cfg.repo, [path.join('public', 'listings', meta.slug), path.relative(cfg.repo, current.file)]))) {
      throw new Error(`${meta.id} has uncommitted changes (or is not in git) — commit or discard them before --replace`);
    }
    // A re-run rebuilds title, place, copy, photos and labels from the brochure, so any later
    // commit to the listing or its photos — a district corrected by hand, an Arabic name fixed, a
    // photo re-cropped, a WhatsApp edit made before edits were recorded — would be undone
    // silently. Only the commit that published it, and earlier replacements, may be in its history.
    if (!dryRun) {
      const changed = await changedSincePublished(cfg.repo, [path.relative(cfg.repo, current.file), path.join('public', 'listings', meta.slug)]);
      if (changed) throw new Error(`${meta.id} has been changed since it was published (${changed}) — a re-run would undo that; do it by hand`);
    }
  }

  // --- enrich: checked first too, before a page is read or a model is paid ------------
  // `meta.enrich` (run-once --enrich <id>): add the unit models, their floor plans, the fact lists and
  // a new brochure to a listing published before the intake could read them — and change nothing else
  // in it (enrichListing below). Hand corrections are kept, so there is no history rule; but it must be
  // the very PDF the listing was published from, and the listing must be in git, unchanged, because a
  // failed run is rolled back from the commit.
  const enrich = meta.enrich ? { id: meta.enrich.id, slug: meta.enrich.slug, force: meta.enrich.force === true } : null;
  let enrichTarget = null;
  if (enrich) {
    if (meta.replace) throw new Error('--enrich and --replace do not go together');
    if (!enrich.id || !enrich.slug) throw new Error('enrich needs the id and slug of the listing it enriches');
    if (caption.price) throw new Error('--enrich takes no caption price: the headline is decided from the listing (`price <id> …` changes it)');
    // enrichMetaFor()'s refusals again, on the listing as it stands now: unknown, withdrawn, withheld, hidden, no PDF hash.
    const { existing } = enrichMetaFor(cfg.repo, enrich.id).enrich;
    enrichTarget = findInbox(cfg.repo, enrich.id);
    if (!enrichTarget || existing.slug !== enrich.slug) throw new Error(`${enrich.id} is not in the inbox under ${enrich.slug} — nothing to enrich`);
    if (existing._intake.pdfSha256 !== report.sha256) {
      throw new RejectError(`this PDF is not the one ${existing.id} was published from (it has sha ${report.sha256.slice(0, 12)}…, the listing records ${existing._intake.pdfSha256.slice(0, 12)}…) — nothing was changed`, 'enrich');
    }
    if (!dryRun && !(await committedUnchanged(cfg.repo, [path.join('public', 'listings', enrich.slug), path.relative(cfg.repo, enrichTarget.file)]))) {
      throw new Error(`${enrich.id} has uncommitted changes (or is not in git) — commit or discard them before --enrich`);
    }
  }

  // --- 0. withdrawn advertising -------------------------------------------------
  // A brochure whose project the developer withdrew from advertising (rules.mjs
  // WITHDRAWN_ADVERTISING, or a flag in the clone's review register) is refused before a page of
  // it is read: no extraction, no model call, nothing staged. The same bytes are caught here; a
  // re-export is caught by name in its own words (2a) or in the model's reading of it (3b).
  const withdrawals = loadRegisterWithdrawals(cfg.repo);
  const withdrawnPdf = withdrawnAdvertising({ _intake: { pdfSha256: report.sha256 } }, withdrawals);
  if (withdrawnPdf) throw new RejectError(withdrawnNotice(withdrawnPdf), 'withdrawn');

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

  // --- 2a. withdrawn advertising, by the brochure's own words ------------------------
  // A re-export has new bytes, so gate 0 cannot see it, and the model can title it generically and
  // leave `project` empty, so 3b alone is not enough. What the document says about itself is read
  // here, before a model is paid to read it: its text layer, its metadata (title, subject, …), its
  // links, the file name it was sent under and the caption. Any mention is refused — the intake
  // republishes the brochure itself, so even a page that only names the project would advertise it.
  // Refused in a dry run too. After the classify gate, so a private document keeps its own answer.
  const namedInSource = withdrawnNamedIn([
    extraction.text, ...(extraction.pageText ?? []), ...stringsIn(extraction.meta ?? {}),
    ...(extraction.links ?? []).map((l) => l?.uri), meta.pdfFileName, caption.text,
  ], withdrawals);
  if (namedInSource) {
    throw new RejectError(`${withdrawnNotice(namedInSource)}. The brochure (its text, metadata, links or file name) or its caption names the project`, 'withdrawn');
  }

  // A brochure with no text layer is NOT accepted locally: every page is rendered and the
  // AI reads them. Default-deny still holds — it just happens one gate later.
  let pageImages = [];
  let pageReason = 'no-text';
  if (verdict.imageOnly) {
    report.stage = 'page-renders';
    const pages = await renderPdfPages(pdfPath, workDir, {
      pyCmd: cfg.pyCmd, maxPages: cfg.maxPdfPages, longSide: cfg.pageReadLongSide,
    });
    if (pages.ok === false) throw new RejectError(pages.error, 'extract');
    pageImages = pages.pageImages || [];
    report.pageImages = pageImages.length;
    log.info('intake.page_renders', { pages: pageImages.length, longSide: cfg.pageReadLongSide });
  } else {
    // A readable text layer can still be unreadable exactly where it matters: a font that maps
    // its digits to letters prints 270,425 on the page and "DIB,FDG" in the text. The pages that
    // talk about a price without a readable one are rendered so the model can look (price-pages.mjs).
    // A failed render costs only the price (it stays on request), never the listing.
    const pricePages = pricePagesToRender(extraction.pageText, { maxPages: cfg.maxPricePages });
    if (pricePages.length) {
      report.stage = 'page-renders';
      const pages = await renderPdfPages(pdfPath, workDir, {
        pyCmd: cfg.pyCmd, maxPages: cfg.maxPdfPages, longSide: cfg.pageReadLongSide,
        pages: pricePages, dir: 'price-pages',
      });
      if (pages.ok === false) {
        log.warn('intake.price_pages_failed', { pages: pricePages, error: pages.error });
      } else {
        pageImages = pages.pageImages || [];
        pageReason = 'price-pages';
        report.pricePages = pageImages.map((p) => p.page);
        log.info('intake.price_pages', { pages: report.pricePages, longSide: cfg.pageReadLongSide });
      }
    }
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
  // brochure with real photographs in it never pays for this call. Never for an enrichment, which
  // publishes no photograph (and so has no photo gate to pass).
  if (!enrich && composites.pages.length && ordinaryCandidates < cfg.minImages) {
    cropped = await runCrop(composites.reason);
  }

  // --- 3. AI ------------------------------------------------------------------
  report.stage = 'ai';
  const rubricPath = path.join(cfg.repo, 'scripts', 'curate', 'IMAGE-RUBRIC.md');
  const askModel = async () => {
    const sheets = await buildContactSheets(extraction.candidates, path.join(workDir, 'sheets'));
    report.sheets = sheets.map((s) => s.file);
    const prompt = buildPrompt({ extraction, sheets, caption, pageImages, pageReason, rubricPath: fs.existsSync(rubricPath) ? rubricPath : null });
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
      candidates: extraction.candidates,
      logger: log,
    });
  };
  let { result: ai, meta: aiMeta, attempt } = await askModel();
  fs.writeFileSync(path.join(workDir, 'ai.json'), `${JSON.stringify(ai, null, 2)}\n`);
  report.ai = ai;
  report.aiMeta = { ...aiMeta, attempt, model: cfg.claudeModel };
  log.info('intake.ai_done', { round: 1, attempt, costUsd: aiMeta.costUsd, durationMs: aiMeta.durationMs, reject: ai.reject, confidence: ai.confidence });
  if (ai.reject) throw new RejectError(ai.rejectReason || 'not a publishable property brochure', 'ai');
  // --- 3b. withdrawn advertising, by name ----------------------------------------
  // A re-exported brochure has new bytes but the same project: the title, project name or copy the
  // model wrote from it still names it — the one check that sees a brochure with no text layer.
  // Refused in a dry run too — there is nothing to preview.
  const withdrawnName = withdrawnInAnswer(ai.listing, report.sha256, withdrawals);
  if (withdrawnName) throw new RejectError(withdrawnNotice(withdrawnName), 'withdrawn');

  // The rescue round. The geometry did not think this brochure needed cropping, but the
  // ranking step has just said in its own words that the candidates it refused are collages
  // and text pages — which is the same finding, arrived at by reading them. Crop and ask
  // once more, but only when the run would otherwise be rejected for want of photographs.
  let picks = orderedPicks(ai.images, { maxImages: cfg.maxImages });
  if (!enrich && picks.length < cfg.minImages && !cropped && composites.pages.length
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
      const withdrawnAgain = withdrawnInAnswer(ai.listing, report.sha256, withdrawals);
      if (withdrawnAgain) throw new RejectError(withdrawnNotice(withdrawnAgain), 'withdrawn');
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
  const pageText = extraction.pageText ?? [];
  // A page that mentions subsidy beneficiaries prints TWO prices per unit. A number found in its
  // text layer proves the number is printed, not WHICH price it is — so text found only on such
  // pages never settles a price; the page image does (those pages are always rendered, see
  // price-pages.mjs). The caption is the owner's own words and always counts.
  const plainText = pageText.length ? pageText.filter((t) => !isSubsidyPricePage(t)).join('\n') : (extraction.text || '');
  const haystack = `${plainText}\n${caption.text || ''}`;
  // The country the property is in — the listing's own on an enrichment — and the currency it prices in,
  // when the site prints that one (model-prices.mjs homeCurrency). A figure printed with no currency at all
  // is taken for that currency only; a property abroad needs its currency printed beside the figure.
  const country = (enrichTarget ? enrichTarget.listing.location : ai.listing?.location)?.countryCode ?? ai.listing?.location?.countryCode;
  const home = homeCurrency(country);
  // The country's own currency, printed by the site or not: on its pages a bare "ريال" / ﷼ is ITS riyal —
  // an Omani "190,000 ريال" is 190,000 OMR, never 190,000 SAR (price.mjs riyalOf, claude.mjs currencyRule).
  const local = countryCurrency(country);
  // The "a price for one of its unit models counts" allowance is for a whole development quoted
  // "from" its cheapest model — never for one specific unit, and never for a price not marked `from`.
  const wholeDevelopment = Boolean(ai.listing?.project) && !ai.listing?.unit && price?.from === true;
  // Set by the first second-model call that hits a quota or session limit (the unit-model check, or
  // a printed() call below): every later call would fail the same way, so none is made, and what
  // could not be checked is worded "try again later" — the brochure is not blamed for our quota.
  let quotaHit = false;
  /**
   * Is `amount` printed as THIS price? In the plain text layer (headline only), or — confirmed by a
   * second model — on a rendered page. Evidence the model forgot is looked for in the rendered
   * pages' text, so a price it read from the text layer is still checked on its page. After a quota
   * error no call is made: `unchecked: true`, never confirmed. `uncheckedWhy` says why: 'quota', or
   * 'render' — a whole-property check whose page could not be rendered (wholeCheckPage).
   */
  const printed = async (amount, evidence, { subsidised = false, whole = false } = {}) => {
    // In the text: printed IN the price's currency, or bare where bare figures are in it (printedInCurrency).
    // "£1,250,000" is a price in pounds, never "1,250,000 SAR". `whole`: the figure must be the whole
    // property's price — which the text layer cannot tell from a floor's or a model's, so only a page can.
    const out = { inText: subsidised || whole ? false : printedInCurrency(haystack, amount, price.currency, { bareCounts: home === price.currency, home: local }), confirmed: null };
    if (out.inText) return out;
    // Only a page can settle a whole-property check, so its page is rendered when it was not, as the
    // model check renders a model's cited page (final review S2r). A render that fails means nothing was
    // looked at: unchecked ("try again later"), never "the brochure does not print it".
    if (whole && !quotaHit && !(await wholeCheckPage(amount, evidence))) {
      log.info('intake.price_evidence_skipped', { page: evidence?.page ?? null, subsidised, whole, reason: 'render' });
      return { ...out, unchecked: true, uncheckedWhy: 'render' };
    }
    if (!pageImages.length) return out;
    // The model's citation when it names a rendered page; otherwise the rendered page whose text
    // carries the number. Either way the second model looks at the page before anything counts.
    const citedRendered = evidence && pageImages.some((p) => p.page === evidence.page) ? evidence : null;
    const cited = citedRendered ?? (() => {
      const hit = pageImages.find((p) => priceAppearsIn(pageText[p.page - 1] ?? '', amount));
      return hit ? { page: hit.page, quote: String(amount) } : null; // the model's quote was about another page
    })();
    const page = cited && pageImages.find((p) => p.page === cited.page);
    if (!page) return out;
    if (quotaHit) {
      log.info('intake.price_evidence_skipped', { page: cited.page, subsidised, reason: 'quota' });
      return { ...out, unchecked: true, uncheckedWhy: 'quota' };
    }
    const check = await confirmPriceEvidence({
      pageImage: page.abs,
      amount,
      currency: price.currency,
      quote: cited.quote,
      subsidised,
      bareCounts: home === price.currency,
      home: local,
      project: wholeDevelopment,
      whole,
      subject: ai.listing?.title?.en,
      unit: ai.listing?.unit ?? null,
      bin: cfg.claudeBin,
      model: cfg.claudeModel,
      cwd: workDir,
      addDirs: [workDir],
      settingsPath: confinement.file,
    });
    out.confirmed = check.confirmed;
    log.info('intake.price_evidence', { page: cited.page, subsidised, whole, inferred: cited !== evidence, confirmed: check.confirmed, error: check.error ?? null, fatal: check.fatal === true });
    if (check.fatal) {
      quotaHit = true;
      return { ...out, unchecked: true, uncheckedWhy: 'quota' };
    }
    return out;
  };
  /** Why printed() could not check a figure, in words for the owner. */
  const uncheckedWhy = (ev) => (ev?.uncheckedWhy === 'render' ? 'its page could not be rendered for the check' : 'the AI quota ran out');
  // Pages rendered for a whole-property check that failed: not tried twice in one run.
  const unrenderable = new Set();
  /**
   * Makes sure the page a whole-property check needs is among the rendered pages: the evidence's page
   * when it cites one of the PDF's pages, else — no usable citation — a rendered page whose text carries
   * the figure, else the first page whose text does. Renders it (into `headline-pages`) when it is not
   * there yet. false only when that render failed; true otherwise, including when there is no page to
   * look at (printed() then finds none: nothing printed it).
   */
  const wholeCheckPage = async (amount, evidence) => {
    const pageCount = Number(extraction.pages);
    const inPdf = (n) => Number.isInteger(n) && n >= 1 && (!Number.isInteger(pageCount) || pageCount < 1 || n <= pageCount);
    const have = (n) => pageImages.some((p) => p.page === n);
    let want = inPdf(evidence?.page) ? evidence.page : null;
    if (want === null) {
      if (pageImages.some((p) => priceAppearsIn(pageText[p.page - 1] ?? '', amount))) return true;
      const i = pageText.findIndex((t) => priceAppearsIn(t ?? '', amount));
      want = i === -1 ? null : i + 1;
    }
    if (want === null || have(want)) return true;
    if (unrenderable.has(want)) return false;
    try {
      const more = await renderPdfPages(pdfPath, workDir, {
        pyCmd: cfg.pyCmd, maxPages: cfg.maxPdfPages, longSide: cfg.pageReadLongSide, pages: [want], dir: 'headline-pages',
      });
      const added = more.ok === false ? [] : (more.pageImages || []).filter((p) => p && p.page === want && typeof p.abs === 'string');
      if (!added.length) {
        log.warn('intake.headline_pages_failed', { pages: [want], error: more.ok === false ? more.error : 'page not returned' });
        unrenderable.add(want);
        return false;
      }
      pageImages.push(...added);
      report.headlinePages = [...(report.headlinePages ?? []), want];
      log.info('intake.headline_pages', { pages: [want], longSide: cfg.pageReadLongSide });
      return true;
    } catch (e) {
      log.warn('intake.headline_pages_failed', { pages: [want], error: String(e?.message || e) });
      unrenderable.add(want);
      return false;
    }
  };
  const rejectedPrices = [];
  // Every text the run publishes, sentence by sentence, each with where it comes from: the listing's
  // copy (a publish only — an enrichment keeps the listing's own), and the unit models' names, rooms
  // and availability and the fact lists, which both publish. A refused figure is looked for in all of it.
  const copySegments = publishedText(ai, { listingCopy: !enrich });
  const inCopy = (n) => copySegments.some(({ seg }) => priceAppearsIn(seg, n));

  // --- 4a. unit-model prices ------------------------------------------------------
  // A development sold as unit models prints a price (and often a Sakani price) per model. Each
  // figure is confirmed ON ITS PAGE IMAGE by a second model — one call per page, covering every
  // model on it, at most cfg.modelPriceConcurrency at once and at most cfg.maxModelPricePages pages — and never by the text
  // layer, which cannot tell which model a figure belongs to (model-prices.mjs). When any model keeps
  // a price, the headline of a whole development becomes the cheapest one, "from", and its own checks
  // below are skipped: its figures ARE confirmed model figures. The owner's caption price replaces them all,
  // and so does the price he set by WhatsApp on a listing being enriched (enrichHeadline): no figure is
  // checked that will not be published.
  const figuresOf = (m) => [m?.price, m?.subsidisedPrice].filter(isFigure);
  const ownerPriceEdit = Boolean(enrichTarget) && Array.isArray(enrichTarget.listing._intake?.edits) && enrichTarget.listing._intake.edits.includes('price');
  const modelFigures = Array.isArray(ai.models) ? ai.models.flatMap(figuresOf) : [];
  // The lowest model price AS READ, before any check takes one away: a reading that set its headline from
  // it (prompt.md: a whole development is "from" its cheapest model) carries exactly this figure, `from`.
  const readModelPrices = Array.isArray(ai.models) ? ai.models.map((m) => m?.price).filter(isFigure) : [];
  const readLowest = readModelPrices.length ? Math.min(...readModelPrices) : null;
  // The currency: the model prices are written and confirmed IN the reading's `price.currency`, which
  // counts only when model-prices.mjs modelPriceCurrency establishes it — for a property abroad (a country
  // whose currency the site does not print) only USD or EUR beside a price, elsewhere any beside a price,
  // on request only the country's own currency. When it is not established — or, on an enrichment, it is not the listing's
  // own currency (the site prints every model price in `price.currency`) — the models keep no price, and
  // none is checked: no figure is checked that will not be published. A figure the copy states is then
  // an unconfirmed one (the guard below).
  let currencyDrop = null;
  let readingCurrency = null;
  if (modelFigures.length && !caption.price && !ownerPriceEdit) {
    const listingCurrency = enrichTarget ? (enrichTarget.listing.price?.currency ?? null) : null;
    readingCurrency = modelPriceCurrency(price, country);
    const currency = { reading: price?.currency ?? null, established: readingCurrency !== null, listing: listingCurrency };
    if (enrich && (readingCurrency === null || readingCurrency !== listingCurrency)) currencyDrop = { decision: 'currency-mismatch', currency };
    else if (!enrich && readingCurrency === null) currencyDrop = { decision: 'currency-unconfirmed', currency };
  }
  // The owner's own figure — his caption price, or the price he set by WhatsApp on a listing being enriched.
  const ownerAmount = caption.price ? caption.price.amount : ownerPriceEdit ? (enrichTarget.listing.price?.amount ?? null) : null;
  let headlineFromModels = false;
  if (Array.isArray(ai.models) && ai.models.length && (caption.price || ownerPriceEdit || currencyDrop)) {
    for (const m of ai.models) {
      // Same rule as the model's own headline figure under a caption price: dropped, and refused
      // outright only if the copy states it (the owner's own figure excepted).
      for (const n of figuresOf(m)) if (currencyDrop || (n !== ownerAmount && inCopy(n))) rejectedPrices.push(n);
      if (m && typeof m === 'object') { m.price = null; m.subsidisedPrice = null; }
    }
    if (currencyDrop) {
      const { decision, currency } = currencyDrop;
      report.modelPrices = { models: ai.models.length, calls: 0, refused: [], incomplete: [], incompletePages: [], fatal: false, tooMany: null, decision, currency, dropped: modelFigures };
      log.info('intake.model_prices_dropped', { decision, ...currency, figures: modelFigures.length });
      report.warningCodes.push('model-price-not-printed');
      // Why the reading's currency does not count (model-prices.mjs modelPriceCurrency), as it is: abroad only
      // USD or EUR beside a price the reading read itself; at home a currency with no price of its own counts
      // only when it is the country's own. A USD reading abroad is not called "the default" (final review C2).
      const ownAmount = price?.onRequest === false && isFigure(price?.amount);
      const why = home === null
        ? `the property is in ${country ?? 'no recorded country'}, whose own currency the site does not print: there the models are priced only in ${ABROAD_CURRENCIES.join(' or ')}, beside a price the reading read itself — this reading has ${currency.reading ?? 'no currency'}${ownAmount ? '' : ' and no price of its own'}`
        : `${currency.reading ?? 'none'} is only the default — the reading has no price of its own, and it is not the currency of the country the property is in`;
      report.warnings.push(decision === 'currency-mismatch'
        ? `the brochure's unit-model prices are not in the listing's currency (${currency.listing ?? 'none'}): ${currency.established ? `they read as ${currency.reading}` : `the reading established no currency (${why})`}, so the models were published without prices`
        : `the unit-model prices were left off: their currency could not be established from the brochure (${why}) — the models show without them`);
    }
  } else if (modelFigures.length) {
    const mp = await checkModelPrices(ai.models, {
      pageImages,
      pageText,
      pageCount: Number(extraction.pages),
      maxPages: cfg.maxModelPricePages,
      concurrency: cfg.modelPriceConcurrency,
      // A page a model's evidence cites that was not rendered for the reading is rendered now, so
      // the second model can look at it. A failed render — or a throw — costs the models citing
      // those pages their prices ("try again later"), not the run: they are not moved to another page.
      render: async (pages) => {
        try {
          const more = await renderPdfPages(pdfPath, workDir, {
            pyCmd: cfg.pyCmd, maxPages: cfg.maxPdfPages, longSide: cfg.pageReadLongSide, pages, dir: 'model-pages',
          });
          if (more.ok === false) {
            log.warn('intake.model_pages_failed', { pages, error: more.error });
            return [];
          }
          const have = new Set(pageImages.map((p) => p.page));
          const added = (more.pageImages || []).filter((p) => !have.has(p.page));
          // Kept in pageImages on purpose: when every model price is refused, the headline's own
          // check below may confirm its figure on one of these pages — a second model still has to
          // see it printed there, exactly as on a page rendered for the reading.
          pageImages.push(...added);
          report.modelPages = added.map((p) => p.page);
          log.info('intake.model_pages', { pages: report.modelPages, longSide: cfg.pageReadLongSide });
          return added;
        } catch (e) {
          log.warn('intake.model_pages_failed', { pages, error: String(e?.message || e) });
          return [];
        }
      },
      confirm: async ({ page, abs, items }) => {
        // IN the currency the reading established, the figures printed in another one refused; a bare
        // figure counts only in the property's own country's currency.
        const res = await confirmModelPrices({
          pageImage: abs, items, currency: readingCurrency, bareCounts: readingCurrency !== null && readingCurrency === home, home: local, bin: cfg.claudeBin, model: cfg.claudeModel,
          cwd: workDir, addDirs: [workDir], settingsPath: confinement.file,
        });
        log.info('intake.model_price_evidence', { page, models: items.length, answers: res.answers.length, error: res.error, fatal: res.fatal });
        return res;
      },
    });
    ai.models = mp.models;
    rejectedPrices.push(...mp.refused);
    if (mp.fatal) quotaHit = true;
    // Two kinds of refusal, two warnings. `mp.incomplete`: figures whose check could not be done for
    // a reason that is ours, not the brochure's — their page did not render, the second model's call
    // failed, or nothing more was sent after a quota error ("try again later"). The rest of
    // `mp.refused` were looked at and not found printed, or had no page to look at.
    const { incomplete, incompletePages } = mp;
    const notPrinted = mp.refused.length - incomplete.length;
    report.modelPrices = { models: ai.models.length, calls: mp.calls, refused: mp.refused, incomplete, incompletePages, fatal: mp.fatal, tooMany: mp.tooMany };
    log.info('intake.model_prices', { models: ai.models.length, calls: mp.calls, refused: mp.refused.length, incomplete: incomplete.length, incompletePages, fatal: mp.fatal, tooMany: mp.tooMany });
    if (mp.refused.length) {
      report.warningCodes.push('model-price-not-printed');
      if (mp.tooMany) {
        report.warnings.push(`the brochure prices its unit models on too many pages to check (${mp.tooMany.pages}; at most ${mp.tooMany.max} are looked at), so no unit-model price was published — the models show without them`);
      } else {
        if (notPrinted > 0) {
          report.warnings.push(`${notPrinted} unit-model price(s) could not be confirmed on the brochure's own pages, so they were left off — the models show without them`);
        }
        if (incomplete.length) {
          report.warnings.push(`the check of ${incomplete.length} unit-model price(s) could not be completed (page${incompletePages.length === 1 ? '' : 's'} ${incompletePages.join(', ')}), so they were left off for now — try again later`);
        }
      }
    }
    // "From the cheapest model" is the price of a whole development (rules.mjs headlineFollowsModels: a
    // project, no specific unit, two models or more): a single property — one "model", per-floor rows —
    // and one specific unit keep their own price and the headline checks below; their models keep the
    // prices confirmed above. (An enrichment decides its headline from the listing.)
    if (!enrich && price && headlineFollowsModels({ project: ai.listing?.project, unit: ai.listing?.unit, models: ai.models })
        && ai.models.some((m) => isFigure(m?.price))) {
      const before = { amount: price.amount, subsidised: price.subsidisedAmount };
      alignHeadline(price, ai.models);
      headlineFromModels = true;
      report.priceEvidence = { inText: priceAppearsIn(haystack, price.amount), confirmed: true, fromModels: true };
      // The model's own headline figures are replaced here, not checked. One that is not a
      // confirmed model figure but is stated in the copy must still be printed (the copy guard).
      const kept = new Set(ai.models.flatMap(figuresOf));
      for (const [n, evidence, subsidised] of [[before.amount, ai.priceEvidence, false], [before.subsidised, ai.subsidisedPriceEvidence, true]]) {
        if (!isFigure(n) || kept.has(n) || mp.refused.includes(n) || !inCopy(n)) continue;
        const check = await printed(n, evidence, { subsidised });
        if (!check.inText && !check.confirmed) rejectedPrices.push(n);
      }
    }
  }
  // "From the cheapest model" is for a whole development only. A single property (no project) or one
  // specific unit whose reading took its headline from its models — the lowest model price as read,
  // `from` — is not published "From …" (a villa priced per floor is not "From" its ground floor): `from`
  // is cleared, and the figure must be confirmed on its page AS THE WHOLE PROPERTY'S PRICE by a second
  // model (`whole`: never by the text layer, which cannot tell a floor's price from the villa's), else
  // the listing is on request. A figure the brochure itself prints "starting from" that no model carries
  // keeps its `from`. (A project with one model is left to its own headline check, `from` and all.)
  // A single property (no project) with two priced models or more whose headline IS the lowest of them
  // takes the same path whatever `from` says (final review S1g): a villa read per floor with its headline
  // = the ground floor and `from` not set would otherwise pass the text layer on the floor's own line.
  // One specific unit is left out of that: priced like one of its project's models, `from` not set, the
  // figure is as likely the unit's own price, and its check asks for the unit's price on the page anyway.
  let ownPriceOnly = false;
  const readFrom = price?.from === true;
  const fromLowestModel = readFrom && (!ai.listing?.project || Boolean(ai.listing?.unit));
  const lowestOfSeveral = !ai.listing?.project && readModelPrices.length >= 2;
  if (!enrich && !caption.price && !headlineFromModels && price && !price.onRequest
      && isFigure(price.amount) && price.amount === readLowest && (fromLowestModel || lowestOfSeveral)) {
    price.from = false;
    ownPriceOnly = true;
    log.info('intake.headline_not_from_models', { amount: price.amount, from: fromLowestModel, project: Boolean(ai.listing?.project), unit: Boolean(ai.listing?.unit), models: readModelPrices.length });
  }
  // A single property (no project) with exactly ONE unit model whose price the brochure itself words
  // "starting from" (final review S2m) gets its `from` back — but only after a second model has
  // confirmed the figure on its page as the whole property's price, and only when the reading's own
  // evidence for it carries the from-wording. With one model there is no cheaper row to be "From", so the
  // from-wording is the brochure's; with two or more (floors, parts, layouts) `from` stays cleared,
  // whatever the evidence says. The least risky of the reviewer's two options: the evidence quote is the
  // model's, so it may only ADD the "From" a confirmed own price already earned, never a price.
  const keepsStartingFrom = () => readFrom && !ai.listing?.project && Array.isArray(ai.models) && ai.models.length === 1
    && report.priceEvidence?.confirmed === true && FROM_WORDING_RE.test(String(ai.priceEvidence?.quote ?? '').normalize('NFKC'));
  // An enrichment publishes none of the model's copy, map pin or photos, and decides its headline from
  // the listing (enrichHeadline): the model's own headline and Sakani checks, the copy guard, the map
  // and the photo steps below are for a publish only. Its unit-model prices are checked above, the same.
  if (enrich) {
    // The copy guard, over what an enrichment publishes: a figure taken away may not stay in a model's
    // name, rooms or availability or in a fact list. What the listing shows as its price, and every
    // model figure a second model confirmed, is published, not refused.
    const shown = enrichTarget.listing.price;
    const kept = [shown && !shown.onRequest ? shown.amount : null, shown?.subsidisedAmount, ...(Array.isArray(ai.models) ? ai.models : []).flatMap(figuresOf)];
    const stated = refusedFigureIn(copySegments, rejectedPrices, kept);
    if (stated) {
      throw new RejectError(`${stated.where} states the price ${stated.n.toLocaleString('en-US')}, which could not be confirmed on the brochure — `
        + `nothing was changed; run --enrich again later, the next reading may leave it out`, 'enrich');
    }
    return enrichListing({ report, ai, extraction, cfg, caption, workDir, dryRun, withdrawals, target: enrichTarget, started, currencyDrop, force: enrich.force });
  }

  // Under the owner's caption price the model's own figure is not published as the price — but if
  // it also wrote it into the copy, that figure must be printed in the brochure too.
  if (caption.price && price && typeof price.amount === 'number' && price.amount > 0
      && price.amount !== caption.price.amount && inCopy(price.amount)) {
    const check = await printed(price.amount, ai.priceEvidence);
    if (!check.inText && !check.confirmed) rejectedPrices.push(price.amount);
  }
  if (!headlineFromModels && !caption.price && price && !price.onRequest && typeof price.amount === 'number' && price.amount > 0) {
    report.priceEvidence = await printed(price.amount, ai.priceEvidence, { whole: ownPriceOnly });
    if (!report.priceEvidence.inText && !report.priceEvidence.confirmed) {
      log.warn('intake.price_unevidenced', { amount: price.amount, currency: price.currency, unchecked: report.priceEvidence.unchecked === true, why: report.priceEvidence.uncheckedWhy ?? null, whole: ownPriceOnly });
      rejectedPrices.push(price.amount);
      price.amount = null;
      price.onRequest = true;
      price.from = false;
      report.warningCodes.push('price-not-printed');
      report.warnings.push(report.priceEvidence.unchecked
        ? `the price could not be checked on the brochure (${uncheckedWhy(report.priceEvidence)}), so the listing says "price on request" for now — try again later, or send \`price <id> <amount>\` to set one`
        : ownPriceOnly
          ? 'the price read was the lowest unit-model price, which the brochure does not print as this single property\'s own price (a property is not "From" its cheapest model), so the listing says "price on request" — send `price <id> <amount>` to set one'
          : 'the price was not printed in the brochure, so the listing says "price on request" — send `price <id> <amount>` to set one');
    } else if (ownPriceOnly && keepsStartingFrom()) {
      price.from = true;
      report.warnings.push('the price read was its one unit model\'s; confirmed on its page as the property\'s own price, and shown "From" as the brochure words it (its evidence: "starting from")');
    } else if (ownPriceOnly) {
      report.warnings.push('the price read was the lowest unit-model price; a single property is not "From" its cheapest model, so it is shown as the property\'s own price (confirmed on its page)');
    }
  }
  // The subsidised (Sakani) price rides on the headline price: it is published only beside a
  // published brochure price, and only when a second model has seen it printed AS the subsidy
  // beneficiaries' price on a page image. The owner's caption price replaces both.
  if (!headlineFromModels && price && typeof price.subsidisedAmount === 'number') {
    const headline = !caption.price && !price.onRequest && typeof price.amount === 'number' && price.amount > 0;
    // Checked even under the owner's caption price: the price field drops the figure then (the
    // caption replaces both), but if the model also wrote it into the copy it must be a printed one.
    const evidence = (headline || (caption.price && inCopy(price.subsidisedAmount)))
      ? await printed(price.subsidisedAmount, ai.subsidisedPriceEvidence, { subsidised: true, whole: ownPriceOnly }) : null;
    report.subsidisedPriceEvidence = evidence;
    if (!evidence?.confirmed) {
      if (headline) {
        log.warn('intake.subsidised_price_unevidenced', { amount: price.subsidisedAmount, currency: price.currency, unchecked: evidence?.unchecked === true });
        report.warningCodes.push('subsidised-price-not-printed');
        report.warnings.push(evidence?.unchecked
          ? `the subsidised (Sakani) price could not be checked on the brochure (${uncheckedWhy(evidence)}), so only the regular price is shown for now — try again later`
          : 'the subsidised (Sakani) price could not be confirmed on the brochure, so only the regular price is shown');
      }
      if (price.subsidisedAmount > 0) rejectedPrices.push(price.subsidisedAmount);
      price.subsidisedAmount = null;
    }
  }

  // A price the check took away must not survive in the words: the site prints `price`, but a
  // figure in the title, description or highlights — or in a unit model's name, rooms or availability,
  // or a fact list — would still be read as a price. The same matcher that looks for the number in the
  // brochure looks for it in every published text, mention by mention (refusedFigureIn).
  // A figure that IS published — the headline, its Sakani price, a model price a second model saw
  // printed — is not a refused one, even when the same figure was refused for another model.
  const stated = refusedFigureIn(copySegments, rejectedPrices, caption.price
    ? [caption.price.amount]
    : [price && !price.onRequest ? price.amount : null, price?.subsidisedAmount, ...(Array.isArray(ai.models) ? ai.models : []).flatMap(figuresOf)]);
  if (stated) {
    const n = stated.n.toLocaleString('en-US');
    throw new RejectError(caption.price
      ? `${stated.where} states the price ${n}, which could not be confirmed on the brochure — send it again; the next reading may leave it out`
      : `${stated.where} states the price ${n}, which could not be confirmed on the brochure — resend with the price in the caption, or without it`, 'price');
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
    if (twin && !(meta.replace && twin.id === meta.id)) {
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
  const sourceRef = (meta.replace && meta.sourceRef) || `WA-${day}-${tail.toUpperCase()}`;

  if (dryRun) {
    report.stage = 'dry-run';
    // The paths writeFloorPlans() would write, for every plan whose candidate exists — no file is made.
    const floorPlans = floorPlanTargets(extraction.candidates, ai.models ?? [], slug).filter((t) => t.cand)
      .map(({ model, index, src, thumb }) => ({ model, index, src, thumb }));
    report.floorPlans = floorPlans.map((p) => ({ model: p.model, candidate: p.index, src: p.src }));
    report.listingPreview = buildListing({
      ai,
      images: picks.map((p) => ({ ...p, n: p.rank, src: `/listings/${slug}/${String(p.rank).padStart(2, '0')}.jpg`, thumb: `/listings/${slug}/${String(p.rank).padStart(2, '0')}-thumb.webp` })),
      floorPlans,
      slug, id, repo: cfg.repo, caption, site: cfg.site,
      meta: { ...meta, sourceRef, pdfSha256: report.sha256, model: cfg.claudeModel, warningCodes: report.warningCodes, map: mapPin },
    });
    const problems = checkListing(report.listingPreview, { minImages: cfg.minImages, maxImages: cfg.maxImages, withdrawals });
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
  // Each unit model's floor plan, staged beside the photos (plan-NN.jpg, NN = the model's position),
  // so it is promoted — and rolled back — with them. One that cannot be decoded costs that model its
  // plan, never the listing.
  const floorPlans = await writeFloorPlans(extraction.candidates, ai.models ?? [], stageDir, slug);
  if (floorPlans.skipped?.length) {
    if (!report.warningCodes.includes('images-skipped')) report.warningCodes.push('images-skipped');
    report.warnings.push(`${floorPlans.skipped.length} floor plan(s) could not be processed and were left out`);
    log.warn('intake.floor_plans_skipped', { skipped: floorPlans.skipped });
  }
  report.floorPlans = floorPlans.map((p) => ({ model: p.model, candidate: p.index, src: p.src }));

  const listing = buildListing({
    ai, images, floorPlans, slug, id, repo: cfg.repo, caption, site: cfg.site,
    meta: { ...meta, sourceRef, brochureUrl: null, pdfSha256: report.sha256, model: cfg.claudeModel, hidden: caption.hidden, warningCodes: report.warningCodes, map: mapPin },
  });
  const problems = checkListing(listing, { minImages: cfg.minImages, maxImages: cfg.maxImages, withdrawals });
  if (problems.length) {
    fs.rmSync(stageDir, { recursive: true, force: true });   // nothing reached the repo
    throw new RejectError(problems[0], 'validate');
  }

  // --- 5b. the Bona brochure ---------------------------------------------------
  // Default ON: the owner's whole point is that a brochure he is sent comes back out under
  // his own brand. It is drawn from scratch (brochure_pdf.py) out of the FINAL listing and the
  // photos and floor plans just staged, into the staging dir, so it is promoted with them and
  // rolled back with them. Nothing of the developer's PDF is re-published.
  // A failure here never costs the listing — it publishes without a downloadable document.
  report.stage = 'brochure';
  if (caption.noBrochure) {
    report.brochure = { skipped: 'nobrochure' };
    log.info('intake.brochure_skipped', { slug, reason: 'nobrochure' });
  } else {
    const built = await buildBrandedBrochure({
      listing, filesDir: stageDir, outPath: brochureFileIn(stageDir), workDir, cfg,
    });
    report.brochure = built;
    if (built.ok) {
      listing.brochureUrl = brochureUrlFor(cfg.site, slug);
      log.info('intake.brochure_built', { slug, bytes: built.bytes, pages: built.pages, steps: built.steps });
    } else {
      const code = built.reason === 'too-large' ? 'brochure-too-large' : 'brochure-failed';
      report.warningCodes.push(code);
      addWarningCode(listing, code);
      report.warnings.push(built.reason === 'too-large'
        ? `${built.error} — the listing was published without a downloadable brochure`
        : 'the Bona-branded brochure could not be built, so the listing was published without one (the reason is in the journal)');
      log.warn('intake.brochure_failed', { slug, reason: built.reason, error: built.error, detail: built.detail });
    }
  }

  // --- 7. promote into the repo, then rebuild ----------------------------------
  report.stage = 'promote';
  const publicDir = path.join(cfg.repo, 'public', 'listings', slug);
  const listingDirs = [path.join('public', 'listings', slug)];
  try {
    fs.mkdirSync(path.dirname(publicDir), { recursive: true });
    // A replacement starts from an empty folder: a photo (or brochure) the new run did not
    // publish must not stay reachable by URL. The rollback below restores the old files from git.
    if (meta.replace) removeListingImages(path.join(cfg.repo, 'public'), slug);
    // The branded brochure was staged alongside the photos, so it is promoted — and rolled
    // back — with them; nothing is copied into the repo out of band.
    fs.cpSync(stageDir, publicDir, { recursive: true });
    report.file = writeInboxListing(cfg.repo, listing);
    // Never wind the counter back: a replacement re-uses an id older than the newest one.
    writeIndex(cfg.repo, { ...index, nextSeq: Math.max(Number(index.nextSeq) || 0, seqAfter(id)), listings: { ...index.listings, [slug]: id } });
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

/**
 * What an enrichment would take away from the listing as it stands: `built` (modelsAndFacts() of the new
 * reading, its model prices and floor plans as they will be published) against `existing`. `before` /
 * `after` count the unit models, their published price figures (regular and Sakani) and their floor
 * plans, and name the fact lists carried; `losses` says, in words, every count that would go down and
 * every fact list that would go.
 */
export function compareEnrichment(existing, built) {
  const list = (models) => (Array.isArray(models) ? models : []);
  const figures = (models) => list(models).flatMap((m) => [m?.price, m?.subsidisedPrice]).filter(isFigure).length;
  const plans = (models) => list(models).filter((m) => m?.floorPlan && typeof m.floorPlan === 'object' && typeof m.floorPlan.src === 'string').length;
  const facts = (l) => Object.keys(FACT_LISTS).filter((k) => ['en', 'ar'].some((lang) => Array.isArray(l?.[k]?.[lang]) && l[k][lang].length > 0));
  const side = (l) => ({ models: list(l?.models).length, prices: figures(l?.models), plans: plans(l?.models), facts: facts(l) });
  const before = side(existing);
  const after = side(built);
  const losses = [];
  if (after.models < before.models) losses.push(`unit models ${before.models} → ${after.models}`);
  if (after.prices < before.prices) losses.push(`confirmed model prices ${before.prices} → ${after.prices}`);
  if (after.plans < before.plans) losses.push(`floor plans ${before.plans} → ${after.plans}`);
  const dropped = before.facts.filter((k) => !after.facts.includes(k));
  if (dropped.length) losses.push(`fact list${dropped.length === 1 ? '' : 's'} dropped: ${dropped.join(', ')}`);
  return { before, after, losses };
}

/** A floor-plan file in a listing's folder (rules.mjs LOCAL_PLAN_SRC / LOCAL_PLAN_THUMB). */
const PLAN_FILE_RE = /^plan-\d{2,3}(?:\.jpg|-thumb\.webp)$/;

/**
 * The rest of `run-once --enrich <id>`, once the brochure has been read and its unit-model prices
 * checked: build the models (with their floor plans) and the fact lists exactly as a publish would,
 * decide the headline from the EXISTING listing (enrichHeadline — a refusal changes nothing), merge
 * ONLY those into the listing (mergeEnrichment), check it like a publish (checkListing), then: replace
 * the floor-plan files in public/listings/<slug>/, draw the brochure from the merged listing and that
 * folder, write the inbox JSON and rebuild. Anything that fails after the first file is touched is
 * rolled back from git (resetTree), so the listing is exactly as it was. A dry run reports what would
 * change and writes nothing.
 */
async function enrichListing({ report, ai, extraction, cfg, caption, workDir, dryRun, withdrawals, target, started, currencyDrop = null, force = false }) {
  report.stage = 'enrich';
  const existing = target.listing;
  const { id, slug } = existing;
  report.id = id;
  report.slug = slug;
  report.url = `${cfg.site}/properties/${slug}/`;
  const publicDir = path.join(cfg.repo, 'public', 'listings', slug);
  const oldPlans = (fs.existsSync(publicDir) ? fs.readdirSync(publicDir) : []).filter((f) => PLAN_FILE_RE.test(f)).sort();

  // The floor plans, staged in the work dir (a dry run only names them), so nothing reaches the repo
  // before checkListing() has passed. A plan that cannot be decoded costs that model its plan.
  const stageDir = path.join(workDir, 'enrich', slug);
  fs.rmSync(stageDir, { recursive: true, force: true });
  let floorPlans;
  if (dryRun) {
    floorPlans = floorPlanTargets(extraction.candidates, ai.models ?? [], slug).filter((t) => t.cand)
      .map(({ model, index, src, thumb }) => ({ model, index, src, thumb }));
  } else {
    floorPlans = await writeFloorPlans(extraction.candidates, ai.models ?? [], stageDir, slug);
    if (floorPlans.skipped?.length) {
      report.warningCodes.push('images-skipped');
      report.warnings.push(`${floorPlans.skipped.length} floor plan(s) could not be processed and were left out`);
      log.warn('intake.floor_plans_skipped', { skipped: floorPlans.skipped });
    }
  }
  report.floorPlans = floorPlans.map((p) => ({ model: p.model, candidate: p.index, src: p.src }));

  // What a publish writes for the models and the facts — under the listing's OWN category (a rental's
  // models keep no Sakani price), whatever the model read this time.
  const built = modelsAndFacts(ai, floorPlans, { rent: existing.category === 'rent' });
  const models = built.models ?? [];
  const aligned = models.some((m) => isFigure(m.price)) && existing.price && typeof existing.price === 'object'
    ? alignHeadline(structuredClone(existing.price), models) : null;
  const head = enrichHeadline(existing, models, aligned, { currencyMismatch: currencyDrop?.decision === 'currency-mismatch' });
  if (head.dropModelPrices) for (const m of models) { m.price = null; m.subsidisedPrice = null; }
  const priceChanged = !isDeepStrictEqual(head.price, existing.price);
  const compare = compareEnrichment(existing, built);
  // Never write over a listing with less than it carries. An incomplete price check (a page that did
  // not render, a failed call, a quota) is ours, not the brochure's: when the listing already carries
  // model prices it could lose, nothing changes — try again later; a listing with none to lose gets the
  // models without the unchecked prices (the warning above says "try again later"), as a publish would.
  // A reading with fewer models, fewer confirmed model prices, fewer floor plans or a fact list fewer is
  // refused unless --force says it is right (the brochure really changed, or the old reading was wrong).
  const mp = report.modelPrices;
  const unchecked = mp && compare.before.prices > 0 && (mp.fatal || (mp.incomplete?.length ?? 0) > 0)
    ? `${mp.fatal ? 'the AI quota ran out during the unit-model price check' : `the check of ${mp.incomplete.length} unit-model price(s) could not be completed (page${mp.incompletePages.length === 1 ? '' : 's'} ${mp.incompletePages.join(', ')})`} — nothing was changed; try again later`
    : null;
  const degraded = compare.losses.length && !force
    ? `${id} already carries more than this reading: ${compare.losses.join('; ')} — nothing was changed; re-run with --force if the new reading is right`
    : null;
  const refuse = unchecked ?? head.refuse ?? degraded;
  report.enrich = {
    models: models.length,
    pricedModels: models.filter((m) => isFigure(m.price)).length,
    keptPrices: models.flatMap((m) => [m.price, m.subsidisedPrice]).filter(isFigure).length,
    refusedPrices: report.modelPrices?.refused ?? [],
    headline: head.decision,
    price: head.price,
    previousPrice: existing.price,
    priceChanged,
    refuse,
    currency: currencyDrop?.currency ?? null,
    compare: { ...compare, forced: compare.losses.length > 0 && force },
    facts: Object.keys(built).filter((k) => k !== 'models'),
    plans: floorPlans.map((p) => p.src),
    removedPlans: oldPlans,
  };
  log.info('intake.enrich', {
    id, models: models.length, kept: report.enrich.keptPrices, refused: report.enrich.refusedPrices.length,
    headline: head.decision, priceChanged, plans: floorPlans.length, removedPlans: oldPlans.length,
    losses: compare.losses, forced: report.enrich.compare.forced, unchecked: Boolean(unchecked),
  });
  if (refuse) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    if (!dryRun) throw new RejectError(refuse, 'enrich');
    report.blocked = refuse;
  }

  const merged = mergeEnrichment(existing, built, priceChanged ? { price: head.price } : {});
  const problems = checkListing(merged, { minImages: cfg.minImages, maxImages: cfg.maxImages, withdrawals });
  if (dryRun) {
    report.stage = 'dry-run';
    report.listingPreview = merged;
    if (problems.length) {
      report.warnings.push(...problems);
      report.blocked ??= problems[0];
    }
    report.durationMs = Date.now() - started;
    report.ok = true;
    return report;
  }
  if (problems.length) {
    fs.rmSync(stageDir, { recursive: true, force: true });   // nothing reached the repo
    throw new RejectError(problems[0], 'validate');
  }
  // Every other key is written back exactly as it was read; a file the intake did not write itself
  // (other indentation, escaped Arabic) comes back in the intake's own JSON layout, values unchanged.
  if (fs.readFileSync(target.file, 'utf8') !== `${JSON.stringify(existing, null, 2)}\n`) {
    report.warnings.push(`${path.basename(target.file)} was not in the intake's own JSON layout; it is rewritten in it (no value other than the enrichment changes)`);
  }

  try {
    report.stage = 'promote';
    fs.mkdirSync(publicDir, { recursive: true });
    // Every old plan goes first: a model the new reading numbers differently must not leave a plan
    // reachable by URL. The rollback below brings them back from git.
    for (const f of oldPlans) fs.rmSync(path.join(publicDir, f), { force: true });
    if (fs.existsSync(stageDir)) fs.cpSync(stageDir, publicDir, { recursive: true });

    // The brochure prints the merged listing, out of the listing's own folder (its photos as they are
    // now, the new plans). Drawn in the work dir and moved in whole, so a half-written file is never
    // served. A failure keeps the enrichment and the old brochure, and says so (as on a publish).
    report.stage = 'brochure';
    if (caption.noBrochure) {
      report.brochure = { skipped: 'nobrochure' };
      log.info('intake.brochure_skipped', { slug, reason: 'nobrochure' });
    } else {
      const out = path.join(workDir, 'enrich-brochure', BROCHURE_FILE);
      fs.rmSync(path.dirname(out), { recursive: true, force: true });
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const brochure = await buildBrandedBrochure({ listing: merged, filesDir: publicDir, outPath: out, workDir, cfg });
      report.brochure = brochure;
      if (brochure.ok) {
        const tmp = path.join(publicDir, `.${BROCHURE_FILE}.tmp`);
        fs.copyFileSync(out, tmp);
        fs.renameSync(tmp, brochureFileIn(publicDir));
        merged.brochureUrl = brochureUrlFor(cfg.site, slug);
        // As `brochure <id>`: a stale "could not build" note does not outlive a brochure that built.
        const w = merged._intake?.warnings;
        if (Array.isArray(w) && w.some((c) => c === 'brochure-failed' || c === 'brochure-too-large')) {
          merged._intake.warnings = w.filter((c) => c !== 'brochure-failed' && c !== 'brochure-too-large');
        }
        log.info('intake.brochure_built', { slug, bytes: brochure.bytes, pages: brochure.pages, steps: brochure.steps });
      } else {
        const code = brochure.reason === 'too-large' ? 'brochure-too-large' : 'brochure-failed';
        report.warningCodes.push(code);
        addWarningCode(merged, code);
        report.warnings.push(brochure.reason === 'too-large'
          ? `${brochure.error} — the listing keeps its old brochure`
          : 'the Bona-branded brochure could not be built, so the listing keeps its old one (the reason is in the journal)');
        log.warn('intake.brochure_failed', { slug, reason: brochure.reason, error: brochure.error, detail: brochure.detail });
      }
    }

    report.stage = 'write';
    fs.writeFileSync(target.file, `${JSON.stringify(merged, null, 2)}\n`);
    report.file = target.file;
    report.listing = merged;

    report.stage = 'rebuild';
    report.rebuild = await rebuild(cfg.repo);
  } catch (err) {
    // The listing was committed and unchanged (checked first), so git puts every file back as it was.
    const clean = await resetTree(cfg.repo);
    log.error('intake.rolled_back', { slug, stage: report.stage, clean, error: err.message, detail: err.detail });
    err.rolledBack = true;
    throw err;
  }
  report.durationMs = Date.now() - started;
  report.ok = true;
  report.stage = 'done';
  return report;
}
