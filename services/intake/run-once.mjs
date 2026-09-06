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
//
// Without --dry-run and without --no-git this commits and pushes, exactly like the daemon.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './lib/env.mjs';
import { parseCaption } from './lib/commands.mjs';
import { withLock } from './lib/lock.mjs';
import { say } from './lib/log.mjs';
import { processPdf, RejectError } from './lib/pipeline.mjs';
import { assertCleanTree, gitCommitPush, gitPull, resetTree } from './lib/publish.mjs';

function parseArgs(argv) {
  const out = { flags: new Set(), opts: {}, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run' || a === '--no-git' || a === '--json') out.flags.add(a.slice(2));
    else if (a.startsWith('--')) { out.opts[a.slice(2)] = argv[i + 1]; i += 1; }
    else out.positional.push(a);
  }
  return out;
}

const money = (p) => (p.onRequest || !p.amount ? 'Price on request' : `${p.currency} ${p.amount.toLocaleString('en-US')}${p.period ? ` / ${p.period}` : ''}${p.from ? ' (from)' : ''}`);

function printReport(r) {
  const l = r.listing || r.listingPreview;
  say('');
  say('══ Bona intake ══════════════════════════════════════════════');
  say(`PDF        ${r.pdf}`);
  say(`           ${(r.bytes / 1048576).toFixed(2)} MB · ${r.pages} pages · sha ${r.sha256.slice(0, 12)}`);
  say(`Gate       ${r.classify.ok ? 'accepted' : 'REJECTED'} — ${r.classify.reason}`);
  say(`Candidates ${r.candidates}${r.rendered ? ' (page renders — the PDF has no extractable photographs)' : ''}`);
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
    say('usage: run-once.mjs <file.pdf> [--dry-run] [--no-git] [--repo <path>] [--caption "…"] [--model <name>] [--json]');
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
        await assertCleanTree(cfg.repo);
        await gitPull(cfg.repo, { remote: cfg.gitRemote, branch: cfg.gitBranch });
      }
      const r = await processPdf({
        pdfPath,
        cfg,
        caption,
        workDir: work,
        dryRun: dryRun || caption.dryRun,
        meta: { pdfFileName: path.basename(pdfPath) },
      });
      if (r.dryRun || noGit) return r;
      try {
        r.push = await gitCommitPush(cfg.repo, `intake: ${r.listing.title.en} (${r.id})`, {
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
    else printReport(report);
    say(`work dir: ${work}`);
    process.exit(0);
  } catch (err) {
    if (err instanceof RejectError) {
      say('');
      say(`REJECTED at "${err.stage}": ${err.reason}`);
      say('Nothing was written to the repo.');
      say(`work dir: ${work}`);
      process.exit(1);
    }
    say(`FAILED: ${err.message}`);
    if (err.detail) say(err.detail);
    if (err.rolledBack) say('The repo was rolled back — nothing of this run is left in it.');
    if (process.env.BONA_DEBUG) say(err.stack);
    say(`work dir: ${work}`);
    process.exit(1);
  }
}

main();
