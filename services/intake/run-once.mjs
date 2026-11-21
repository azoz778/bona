#!/usr/bin/env node
// Run the intake pipeline on ONE local PDF, with no WhatsApp involved.
//
//   node services/intake/run-once.mjs <file.pdf> [options]
//     --dry-run            stop before writing anything (prints the listing + the ranking)
//     --no-git             write into the repo and rebuild, but never touch git or the remote
//     --repo <path>        target repo (default $BONA_REPO, else ~/bona-bot)
//     --caption "…"        pretend the owner sent this caption
//     --model <name>       override BONA_CLAUDE_MODEL
//     --work <path>        scratch dir (default $BONA_DATA/intake/manual/<timestamp>)
//     --json               print the whole report as JSON instead of the human summary
//     --replace <id>       re-run the brochure over the listing it already published (same id,
//                          slug, date and reference; new copy, price and photos). Refused for a
//                          listing with videos, a licence, or `hidden` — those are not carried over.
//     --enrich <id>        add ONLY the unit models (with floor plans), amenities / nearby /
//                          warranties and a new brochure to a listing published from this very PDF;
//                          its copy, photos, price and hand corrections stay as they are (the
//                          headline is adopted from the models only when it was on request).
//                          Not with --replace or --caption. Refused when the unit-model price check
//                          could not be completed (try again later), and — unless --force — when
//                          the reading has fewer models, fewer confirmed model prices or drops a fact
//                          list the listing already carries.
//     --force              with --enrich: accept a reading with less than the listing carries
//
// Without --dry-run and without --no-git this commits and pushes, exactly like the daemon.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './lib/env.mjs';
import { parseCaption } from './lib/commands.mjs';
import { withLock } from './lib/lock.mjs';
import { say } from './lib/log.mjs';
import * as msg from './lib/messages.mjs';
import { enrichMetaFor, replaceMetaFor } from './lib/listing.mjs';
import { processPdf, RejectError } from './lib/pipeline.mjs';
import { assertCleanTree, gitCommitPush, gitPull, gitStatus, resetTree } from './lib/publish.mjs';

function parseArgs(argv) {
  const out = { flags: new Set(), opts: {}, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run' || a === '--no-git' || a === '--json' || a === '--force') out.flags.add(a.slice(2));
    else if (a.startsWith('--')) { out.opts[a.slice(2)] = argv[i + 1]; i += 1; }
    else out.positional.push(a);
  }
  return out;
}

const money = (p) => (p.onRequest || !p.amount ? 'Price on request' : `${p.currency} ${p.amount.toLocaleString('en-US')}${p.period ? ` / ${p.period}` : ''}${p.from ? ' (from)' : ''}${typeof p.subsidisedAmount === 'number' ? ` · Sakani beneficiaries ${p.currency} ${p.subsidisedAmount.toLocaleString('en-US')}` : ''}`);

const plain = (p) => (p ? money(p) : '—');

/** What `--enrich` did (or, in a dry run, would do): the models, their prices, the headline, the plans. */
function printEnrichReport(r) {
  const e = r.enrich;
  const l = r.listing || r.listingPreview;
  say('');
  say('══ Bona intake — enrich ══════════════════════════════════════');
  say(`PDF        ${r.pdf}`);
  say(`           ${(r.bytes / 1048576).toFixed(2)} MB · ${r.pages} pages · sha ${r.sha256.slice(0, 12)}`);
  say(`AI         attempt ${r.aiMeta.attempt} · ${r.aiMeta.model} · ${(r.aiMeta.durationMs / 1000).toFixed(0)}s · $${(r.aiMeta.costUsd ?? 0).toFixed(3)}`);
  say('');
  say(`${r.id}   ${r.slug}`);
  say(`EN  ${l?.title?.en ?? '—'}`);
  say('');
  const refused = e.refusedPrices.length ? ` (${e.refusedPrices.map((n) => n.toLocaleString('en-US')).join(', ')})` : '';
  say(`Models     ${e.models} — ${e.pricedModels} priced · prices kept ${e.keptPrices} / refused ${e.refusedPrices.length}${refused}`);
  for (const m of l?.models ?? []) {
    say(`           ${m.name.en.padEnd(24)} ${m.price ? m.price.toLocaleString('en-US') : 'on request'}${m.subsidisedPrice ? ` · Sakani ${m.subsidisedPrice.toLocaleString('en-US')}` : ''}${m.floorPlan ? `  ${m.floorPlan.src}` : ''}`);
  }
  if (e.facts.length) say(`Facts      ${e.facts.map((k) => `${k} ${l[k].en.length}`).join(' · ')}`);
  const c = e.compare;
  if (c) {
    const lists = (f) => (f.length ? f.join(', ') : 'none');
    say(`Compared   models ${c.before.models} → ${c.after.models} · model prices ${c.before.prices} → ${c.after.prices} · floor plans ${c.before.plans} → ${c.after.plans} · fact lists ${lists(c.before.facts)} → ${lists(c.after.facts)}`
      + `${c.losses.length ? (c.forced ? '  (LESS than the listing carries — accepted with --force)' : '  (LESS than the listing carries)') : ''}`);
  }
  const cur = e.currency;
  const why = {
    'owner-price': 'the owner\'s own price stays; the models are published without prices',
    'currency-mismatch': `${cur?.established ? `the brochure prices its models in ${cur.reading}` : `the reading established no currency (its ${cur?.reading ?? 'none'} is a default, or the property is abroad)`}, `
      + `the listing is in ${cur?.listing ?? 'no currency'}: the models are published without prices`,
    unit: 'one specific unit: its own price stays',
    'single-property': 'not a development of two or more unit models: its own price stays, its models keep theirs',
    'no-model-prices': 'no model price was confirmed: the price stays as it is',
    adopted: 'was on request: the models\' confirmed headline is adopted',
    kept: 'equals the lowest model price: kept',
    refused: 'REFUSED',
  }[e.headline];
  say(`Headline   ${e.headline} — ${why}`);
  say(`           before ${plain(e.previousPrice)}`);
  if (e.priceChanged) say(`           after  ${plain(e.price)}`);
  if (e.refuse) say(`           ${e.refuse}`);
  say(`Plans      ${e.plans.length ? e.plans.join(' ') : 'none'}${e.removedPlans.length ? `  (removing ${e.removedPlans.join(' ')})` : ''}`);
  if (msg.planCheckLine(r.planCheck)) say(`           ${msg.planCheckLine(r.planCheck)}`);
  if (r.warnings?.length) {
    say('');
    for (const w of r.warnings) say(`  ! ${w}`);
  }
  say('');
  if (r.blocked) say(`WOULD BE REJECTED — ${r.blocked}`);
  if (r.dryRun) say('DRY RUN — nothing written.');
  else {
    say(`Wrote  ${r.file}`);
    say(`       brochure ${msg.enrichBrochureLine(r)}`);
    say(`       ${r.rebuild.validate.split('\n').pop()}`);
    say(r.push?.pushed ? `Pushed ${r.push.sha} — live in a few minutes at ${r.url}` : `Not pushed. Live URL ${r.url}`);
  }
  say('');
}

function printReport(r) {
  const l = r.listing || r.listingPreview;
  say('');
  say('══ Bona intake ══════════════════════════════════════════════');
  say(`PDF        ${r.pdf}`);
  say(`           ${(r.bytes / 1048576).toFixed(2)} MB · ${r.pages} pages · sha ${r.sha256.slice(0, 12)}`);
  say(`Gate       ${r.classify.ok ? 'accepted' : 'REJECTED'} — ${r.classify.reason}`);
  say(`Candidates ${r.candidates}${r.rendered ? ' (page renders — the PDF has no extractable photographs)' : ''}`);
  if (r.cropped) {
    const c = r.cropped;
    say(`Cropped    ${c.crops.length} photo region(s) out of ${c.pages.length} page(s) — ${c.boxes} box(es) on ${c.views} view(s), ${c.dropped.length} dropped`);
    say(`           why: ${c.why}${c.error ? ` · ${c.error}` : ''}`);
    for (const im of c.crops) say(`           #${String(im.index).padStart(2)}  p${im.page}  ${im.w}x${im.h}  ${String(im.room).padEnd(14)} ${im.note || ''}`);
  }
  say(`AI         attempt ${r.aiMeta.attempt} · ${r.aiMeta.model} · ${(r.aiMeta.durationMs / 1000).toFixed(0)}s · $${(r.aiMeta.costUsd ?? 0).toFixed(3)} · confidence ${r.ai.confidence}`);
  say('');
  say('── Listing ──────────────────────────────────────────────────');
  say(`${r.id}   ${r.slug}`);
  say(`EN  ${l.title.en}`);
  say(`AR  ${l.title.ar}`);
  say(`    ${l.type} · ${l.kind} · ${l.category} · ${l.location.district.en}, ${l.location.city.en}`);
  say(`    ${money(l.price)}`);
  const s = l.specs;
  say(`    beds ${s.beds ?? '—'} · baths ${s.baths ?? '—'} · ${s.areaSqm ?? '—'} sqm · plot ${s.plotSqm ?? '—'} · built ${s.yearBuilt ?? '—'} · floors ${s.floors ?? '—'}`);
  say('');
  for (const p of l.description.en.split('\n\n')) say(`    ${p}`);
  say('');
  for (const p of l.description.ar.split('\n\n')) say(`    ${p}`);
  say('');
  say(`    highlights EN  ${l.highlights.en.join(' · ')}`);
  say(`    highlights AR  ${l.highlights.ar.join(' · ')}`);
  say('');
  say('── Images (ranked) ──────────────────────────────────────────');
  const rows = r.images || r.picks.map((p) => ({ n: p.rank, candidate: p.index, room: p.room, reason: p.reason, src: `/listings/${r.slug}/${String(p.rank).padStart(2, '0')}.jpg` }));
  for (const im of rows) {
    say(`  ${im.n === 1 ? 'HERO' : `  ${String(im.n).padStart(2)}`}  #${String(im.candidate).padStart(2)}  ${String(im.room).padEnd(14)} ${im.src}`);
    if (im.reason) say(`        ${im.reason}`);
  }
  if (msg.planCheckLine(r.planCheck)) say(`  plans  ${msg.planCheckLine(r.planCheck)}`);
  if (r.excluded?.length) {
    say('');
    say('  excluded:');
    for (const x of r.excluded) say(`    #${String(x.index).padStart(2)}  ${x.reason || '(no reason given)'}`);
  }
  if (r.warnings?.length) {
    say('');
    say('── Warnings ─────────────────────────────────────────────────');
    for (const w of r.warnings) say(`  ! ${w}`);
  }
  say('');
  if (r.blocked) say(`WOULD BE REJECTED — ${r.blocked}`);
  if (r.dryRun) say(`DRY RUN — nothing written. Would publish ${r.url}`);
  else {
    say(`Wrote  ${r.file}`);
    say(`       ${r.images.length} photos in public/listings/${r.slug}/`);
    say(`       ${r.rebuild.validate.split('\n').pop()}`);
    say(r.push?.pushed ? `Pushed ${r.push.sha} — live in a few minutes at ${r.url}` : `Not pushed (--no-git). Live URL would be ${r.url}`);
  }
  say('');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pdf = args.positional[0];
  if (!pdf) {
    say('usage: run-once.mjs <file.pdf> [--dry-run] [--no-git] [--repo <path>] [--caption "…"] [--model <name>] [--replace <id> | --enrich <id> [--force]] [--json]');
    process.exit(2);
  }
  const pdfPath = path.resolve(pdf);
  if (!fs.existsSync(pdfPath)) { say(`no such file: ${pdfPath}`); process.exit(2); }

  const overrides = {};
  if (args.opts.repo) overrides.repo = path.resolve(args.opts.repo);
  if (args.opts.model) overrides.claudeModel = args.opts.model;
  const cfg = loadConfig(overrides);
  const dryRun = args.flags.has('dry-run');
  const noGit = args.flags.has('no-git') || dryRun;
  // A replacement deletes the old files and relies on git to bring them back if the run fails.
  if (args.opts.replace && args.flags.has('no-git') && !dryRun) {
    say('--replace needs git (it rolls a failed run back from the last commit): drop --no-git, or add --dry-run to preview');
    process.exit(2);
  }
  const enrich = 'enrich' in args.opts;
  // `--enrich --dry-run` would otherwise take "--dry-run" as the id and run for real.
  if (enrich && (!args.opts.enrich || args.opts.enrich.startsWith('--'))) { say('--enrich needs a listing id (--enrich BONA-W023)'); process.exit(2); }
  // Same for `--replace --dry-run`.
  if ('replace' in args.opts && (!args.opts.replace || args.opts.replace.startsWith('--'))) { say('--replace needs a listing id (--replace BONA-W023)'); process.exit(2); }
  if (enrich && args.opts.replace) { say('--enrich and --replace do not go together: --enrich adds unit models to the listing as it stands, --replace rewrites it'); process.exit(2); }
  // An enrichment replaces the plan files and the brochure and, like a replacement, is rolled back from git.
  if (enrich && args.flags.has('no-git') && !dryRun) {
    say('--enrich needs git (it rolls a failed run back from the last commit): drop --no-git, or add --dry-run to preview');
    process.exit(2);
  }
  if (args.flags.has('force') && !enrich) { say('--force goes with --enrich only (it accepts a reading with less than the listing carries)'); process.exit(2); }
  if (enrich && args.opts.caption !== undefined) {
    say('--enrich takes no --caption: its price is decided from the listing (send `price <id> …` to change it)');
    process.exit(2);
  }

  if (!fs.existsSync(path.join(cfg.repo, 'scripts', 'curate', 'build.mjs'))) {
    say(`--repo ${cfg.repo} does not look like the Bona repo (no scripts/curate/build.mjs)`);
    process.exit(2);
  }

  const caption = parseCaption(args.opts.caption || '');
  const work = args.opts.work
    ? path.resolve(args.opts.work)
    : path.join(cfg.intakeDir, 'manual', `${new Date().toISOString().replace(/[:.]/g, '-')}-${path.basename(pdfPath, '.pdf').slice(0, 40)}`);

  try {
    // Same order as the daemon: clean tree + pull BEFORE anything is written, because
    // build.mjs rewrites a tracked file and `git rebase` refuses to run over that.
    // --no-git / --dry-run never touch git at all, so a working checkout with other
    // people's uncommitted changes in it is safe to point at.
    const report = await withLock(cfg.lockPath, async () => {
      if (!noGit) {
        // assertCleanTree() RECOVERS a dirty clone by discarding its changes — right for a crashed
        // job, wrong for a replacement, whose guard must see the listing as it stands. Refuse instead.
        if (args.opts.replace || enrich) {
          const flag = enrich ? '--enrich' : '--replace';
          const dirty = await gitStatus(cfg.repo);
          if (dirty) throw new Error(`${flag}: ${cfg.repo} has uncommitted changes, which ${flag} will not discard — commit or clean them first (run it in the publishing clone)`);
        }
        await assertCleanTree(cfg.repo);
        await gitPull(cfg.repo, { remote: cfg.gitRemote, branch: cfg.gitBranch });
      }
      const meta = { pdfFileName: path.basename(pdfPath) };
      if (args.opts.replace) Object.assign(meta, replaceMetaFor(cfg.repo, args.opts.replace));
      if (enrich) {
        Object.assign(meta, enrichMetaFor(cfg.repo, args.opts.enrich));
        if (args.flags.has('force')) meta.enrich.force = true;
      }
      const r = await processPdf({
        pdfPath,
        cfg,
        caption,
        workDir: work,
        dryRun: dryRun || caption.dryRun,
        meta,
      });
      if (r.dryRun || noGit) return r;
      try {
        const message = meta.enrich
          ? `intake: enrich ${r.listing.title.en} (${r.id}) — unit models + brochure`
          : `intake: ${meta.replace ? 'replace ' : ''}${r.listing.title.en} (${r.id})`;
        r.push = await gitCommitPush(cfg.repo, message, {
          remote: cfg.gitRemote, branch: cfg.gitBranch,
          paths: [`public/listings/${r.slug}`, 'scripts/curate/inbox', 'src/data/listings.json'],
        });
      } catch (err) {
        await resetTree(cfg.repo, { dirs: [`public/listings/${r.slug}`] }).catch(() => false);
        err.rolledBack = true;
        throw err;
      }
      return r;
    }, { timeoutMs: cfg.lockWaitMs, label: `run-once ${path.basename(pdfPath)}` });
    if (args.flags.has('json')) say(JSON.stringify(report, null, 2));
    else if (report.enrich) printEnrichReport(report);
    else printReport(report);
    say(`work dir: ${work}`);
    process.exit(0);
  } catch (err) {
    // A retryable refusal (an --enrich whose price check could not finish, r2 #9) is a failure to run again,
    // not a verdict on the listing: FAILED, so the backfill stops on it and its resume runs it again.
    if (err instanceof RejectError && !err.retryable) {
      say('');
      say(`REJECTED at "${err.stage}": ${err.reason}`);
      say('Nothing was written to the repo.');
      say(`work dir: ${work}`);
      process.exit(1);
    }
    say(`FAILED: ${err.message}`);
    if (err.retryable) say('Nothing was written to the repo — run it again later.');
    if (err.detail) say(err.detail);
    if (err.rolledBack) say('The repo was rolled back — nothing of this run is left in it.');
    if (process.env.BONA_DEBUG) say(err.stack);
    say(`work dir: ${work}`);
    process.exit(1);
  }
}

main();
