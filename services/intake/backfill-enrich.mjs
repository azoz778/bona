#!/usr/bin/env node
// Backfill the listings the intake published before unit models and the Bona brochure existed.
//
//   node services/intake/backfill-enrich.mjs [options]
//     --repo <clone>          the publishing clone (default $BONA_REPO, else ~/bona-bot)
//     --plan-only             print the plan table and stop — nothing is run, nothing is written
//     --dry-run               run `run-once.mjs <pdf> --enrich <id> --dry-run` for every listing whose
//                             source PDF is found; brochure-only listings are only listed
//     --only <ids>            BONA-W002,BONA-W010 — just these (comma or space separated)
//     --model <name>          passed on to run-once (--model)
//     --continue-on-error     go on after a FAILED job (a quota/usage limit or a killed job always stops)
//     --include-enriched      also enrich again the listings that already carry unit models (skipped
//                             by default as "already enriched"; run-once still refuses a reading with
//                             less than the listing carries — no --force is passed)
//
// The plan (lib/backfill.mjs planBackfill): hidden, withdrawn and non-intake listings are skipped, and
// so are listings that already carry unit models (unless --include-enriched);
// a listing whose source PDF is still under $BONA_DATA/intake (found by content hash) is ENRICHED
// by run-once — unit models, amenities, nearby, warranties, floor plans and the new brochure, its
// copy untouched; one without gets only its Bona brochure rebuilt from what the repo holds
// (edits.rebuildBrochure), committed as `intake: rebuild brochure <id>`.
//
// Without --dry-run this COMMITS AND PUSHES, one listing at a time: run-once commits each enrich
// itself, and a brochure-only rebuild is committed here the way the daemon commits an edit (lock,
// clean clone, pull, edit, rebuild, commit + push, roll back on failure). Jobs never overlap: they
// run one after the other, and every one of them takes the intake lock the daemon uses.
//
// It stops on the first FAILED job (unless --continue-on-error); a REJECTED or refused listing is
// reported and skipped. It always stops at once on a usage/session limit, a quota or a 429, and on
// a job that was killed (SIGKILL — a memory limit), and prints the `--only …` that resumes it.
//
// Every job's output goes to $BONA_DATA/intake/backfill/<timestamp>/<id>.log, with run-once's
// work dir beside it (<id>-work/) and plan.txt + summary.json for the whole run.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegisterWithdrawals } from '../../scripts/curate/rules.mjs';
import {
  QUOTA_RE, classifyRun, formatPlanTable, makePdfFinder, parseOnly, planBackfill, resumeCommand, stopsBackfill, unknownIds,
} from './lib/backfill.mjs';
import { rebuildBrochure } from './lib/edits.mjs';
import { loadConfig } from './lib/env.mjs';
import { listInbox } from './lib/listing.mjs';
import { withLock } from './lib/lock.mjs';
import { say } from './lib/log.mjs';
import { assertCleanTree, gitCommitPush, gitPull, gitStatus, rebuild, resetTree, run } from './lib/publish.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..', '..');
const DEFAULT_RUN_ONCE = path.join(HERE, 'run-once.mjs');

const USAGE = 'usage: backfill-enrich.mjs [--repo <clone>] [--plan-only | --dry-run] [--only BONA-W002,BONA-W010] [--model <name>] [--continue-on-error] [--include-enriched]';
const FLAGS = new Set(['dry-run', 'plan-only', 'continue-on-error', 'include-enriched', 'help']);
// `run-once` is not in the usage on purpose: it points the backfill at a stand-in for the tests.
const OPTS = new Set(['repo', 'only', 'model', 'run-once']);

/** Strict: a typo in an option of a script that commits and pushes must not be ignored. */
function parseArgs(argv) {
  const out = { flags: new Set(), opts: {}, errors: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h') { out.flags.add('help'); continue; }
    if (!a.startsWith('--')) { out.errors.push(`unexpected argument "${a}"`); continue; }
    let name = a.slice(2);
    let value;
    const eq = name.indexOf('=');
    if (eq >= 0) { value = name.slice(eq + 1); name = name.slice(0, eq); }
    if (FLAGS.has(name)) { out.flags.add(name); continue; }
    if (!OPTS.has(name)) { out.errors.push(`unknown option --${name}`); continue; }
    if (value === undefined) { value = argv[i + 1]; i += 1; }
    if (value === undefined || value.startsWith('--')) out.errors.push(`--${name} needs a value`);
    else out.opts[name] = value;
  }
  return out;
}

/** What a brochure-only commit may stage — the same allowlist the daemon's edits use. */
const stagePaths = (slug) => [path.posix.join('public', 'listings', slug), path.posix.join('scripts', 'curate', 'inbox'), path.posix.join('src', 'data', 'listings.json')];

/** Keep at most this much of a child's output in memory for reading it; all of it goes to the log. */
const KEEP_CHARS = 4 * 1024 * 1024;

/**
 * Run one run-once child to completion, its stdout and stderr both appended to `logFile` as they
 * come. Resolves `{ code, signal, output }`; `output` is the tail of what it printed, with the
 * first quota/usage-limit line put in front when that line is older than the tail.
 */
function runChild(script, args, logFile) {
  return new Promise((resolve) => {
    const fd = fs.openSync(logFile, 'a');
    const write = (s) => { try { fs.writeSync(fd, s); } catch { /* the log is a convenience, never the job */ } };
    write(`$ ${process.execPath} ${[script, ...args].join(' ')}\n# started ${new Date().toISOString()}\n\n`);
    let kept = '';
    let quotaLine = null;
    const partial = { out: '', err: '' };
    const scan = (key, s) => {
      const lines = (partial[key] + s).split('\n');
      partial[key] = lines.pop();
      if (!quotaLine) quotaLine = lines.find((l) => QUOTA_RE.test(l)) ?? null;
    };
    const child = spawn(process.execPath, [script, ...args], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    for (const [key, stream] of [['out', child.stdout], ['err', child.stderr]]) {
      stream.setEncoding('utf8');
      stream.on('data', (s) => {
        write(s);
        scan(key, s);
        kept += s;
        if (kept.length > KEEP_CHARS) kept = kept.slice(-KEEP_CHARS);
      });
    }
    let done = false;
    const finish = (code, signal, extra = '') => {
      if (done) return;
      done = true;
      for (const key of ['out', 'err']) if (!quotaLine && QUOTA_RE.test(partial[key])) quotaLine = partial[key];
      write(`${extra}\n# exit ${code ?? '-'}${signal ? ` (${signal})` : ''} at ${new Date().toISOString()}\n`);
      try { fs.closeSync(fd); } catch { /* already closed */ }
      const output = quotaLine && !kept.includes(quotaLine) ? `${quotaLine}\n${kept}` : kept;
      resolve({ code, signal, output: `${output}${extra}` });
    };
    child.on('error', (err) => finish(-1, null, `\nFAILED: could not start run-once: ${err.message}`));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

/**
 * The brochure-only job: rebuild the Bona brochure from the listing and its published files, then
 * commit it — publishEdit()'s order in index.mjs: lock, clean clone, pull, edit, rebuild, commit +
 * push, and the clone rolled back on any failure. A clone with changes of its own is refused, not
 * cleaned: the backfill is run by hand, and what is in the clone may be someone's work.
 */
async function brochureOnly(cfg, item, { workDir }) {
  try {
    return await withLock(cfg.lockPath, async () => {
      const dirty = await gitStatus(cfg.repo);
      if (dirty) return { outcome: 'failed', line: `FAILED: ${cfg.repo} has uncommitted changes, which the backfill will not discard — commit or clean them first` };
      await assertCleanTree(cfg.repo);
      await gitPull(cfg.repo, { remote: cfg.gitRemote, branch: cfg.gitBranch });
      try {
        const res = await rebuildBrochure(cfg.repo, item.id, { cfg, workDir });
        if (!res) return { outcome: 'refused', line: `REFUSED: ${item.id} is not in the inbox any more` };
        if (res.error) {
          await resetTree(cfg.repo).catch(() => false);
          // Withdrawn, or too big even with its photos scaled down: a fact about this listing,
          // not a broken run. Anything else is the renderer failing.
          const refusal = /withdrawn|MB limit/i.test(res.error);
          return { outcome: refusal ? 'refused' : 'failed', line: `${refusal ? 'REFUSED' : 'FAILED'}: ${res.error}` };
        }
        await rebuild(cfg.repo);
        const push = await gitCommitPush(cfg.repo, `intake: rebuild brochure ${item.id}`, {
          remote: cfg.gitRemote, branch: cfg.gitBranch, paths: stagePaths(res.listing.slug),
        });
        const b = res.brochure || {};
        const size = typeof b.bytes === 'number' ? `${(b.bytes / 1048576).toFixed(1)} MB` : '? MB';
        return {
          outcome: 'ok',
          line: push.committed
            ? `brochure rebuilt (${b.pages ?? '?'} pages, ${size}) · pushed ${push.sha}`
            : `brochure rebuilt (${b.pages ?? '?'} pages, ${size}) · identical to the committed one, nothing to push`,
        };
      } catch (err) {
        const clean = await resetTree(cfg.repo).catch(() => false);
        err.rolledBack = clean;
        throw err;
      }
    }, { timeoutMs: cfg.lockWaitMs, label: `backfill brochure ${item.id}` });
  } catch (err) {
    return {
      outcome: 'failed',
      line: `FAILED: ${err.message}${err.rolledBack ? ' (the clone was rolled back)' : ''}`,
      detail: err.detail ?? null,
    };
  }
}

const COUNTED = ['ok', 'rejected', 'refused', 'failed', 'quota', 'killed', 'listed', 'not run'];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has('help')) { say(USAGE); process.exit(0); }
  if (args.errors.length) { for (const e of args.errors) say(e); say(USAGE); process.exit(2); }
  const planOnly = args.flags.has('plan-only');
  const dryRun = args.flags.has('dry-run');
  const continueOnError = args.flags.has('continue-on-error');
  const includeEnriched = args.flags.has('include-enriched');
  const model = args.opts.model || null;
  const runOnce = path.resolve(args.opts['run-once'] || DEFAULT_RUN_ONCE);

  const overrides = {};
  if (args.opts.repo) overrides.repo = path.resolve(args.opts.repo);
  if (model) overrides.claudeModel = model;
  const cfg = loadConfig(overrides);
  if (!fs.existsSync(path.join(cfg.repo, 'scripts', 'curate', 'build.mjs'))) {
    say(`--repo ${cfg.repo} does not look like the Bona repo (no scripts/curate/build.mjs)`);
    process.exit(2);
  }

  const listings = listInbox(cfg.repo).map((x) => x.listing);
  const only = parseOnly(args.opts.only);
  const unknown = unknownIds(listings, only);
  if (unknown.length) {
    say(`--only names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not in ${cfg.repo}/scripts/curate/inbox`);
    process.exit(2);
  }
  // Throws on a register that cannot be read: a takedown never fails open.
  const withdrawals = loadRegisterWithdrawals(cfg.repo);
  const finder = makePdfFinder(cfg.intakeDir);
  const plan = planBackfill(listings, { findPdf: finder, withdrawals, only, includeEnriched });

  say('');
  say(`══ Bona backfill ${planOnly ? '(plan only)' : dryRun ? '(dry run)' : '(LIVE — commits and pushes)'} ══`);
  say(`repo     ${cfg.repo}`);
  say(`sources  ${cfg.intakeDir} (${finder.hashed()} PDF(s) hashed)`);
  say('');
  const table = formatPlanTable(plan, { intakeDir: cfg.intakeDir });
  say(table);
  say('');
  if (planOnly) process.exit(0);

  const queue = plan.filter((p) => p.action !== 'skip');
  if (!queue.length) { say('Nothing to do.'); process.exit(0); }

  if (!dryRun) {
    const inside = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: cfg.repo });
    if (inside.code !== 0 || inside.out !== 'true') { say(`${cfg.repo} is not a git clone — the backfill commits, it needs one`); process.exit(2); }
    const dirty = await gitStatus(cfg.repo);
    if (dirty) {
      say(`${cfg.repo} has uncommitted changes, and --enrich refuses a dirty clone — commit or clean them first (run it in the publishing clone)`);
      process.exit(2);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logDir = path.join(cfg.intakeDir, 'backfill', stamp);
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'plan.txt'), `${table}\n`);

  const results = [];
  const resumeOpts = { repo: cfg.repo, dryRun, model, continueOnError, includeEnriched };
  let stopped = null;
  for (let i = 0; i < queue.length; i += 1) {
    const item = queue[i];
    const logFile = path.join(logDir, `${item.id}.log`);
    const workDir = path.join(logDir, `${item.id}-work`);
    const started = Date.now();
    let res;
    if (item.action === 'brochure-only' && dryRun) {
      res = { outcome: 'listed', line: 'brochure-only — rebuilt from the listing on a live run, nothing to preview here' };
    } else if (item.action === 'brochure-only') {
      say(`[${i + 1}/${queue.length}] ${item.id} brochure-only …`);
      res = await brochureOnly(cfg, item, { workDir });
      fs.writeFileSync(logFile, `${JSON.stringify({ id: item.id, action: item.action, ...res, at: new Date().toISOString() }, null, 2)}\n`);
    } else {
      say(`[${i + 1}/${queue.length}] ${item.id} enrich${dryRun ? ' (dry run)' : ''} …`);
      const argv = [item.pdf, '--enrich', item.id];
      if (dryRun) argv.push('--dry-run');
      argv.push('--repo', cfg.repo);
      if (model) argv.push('--model', model);
      argv.push('--work', workDir);
      const child = await runChild(runOnce, argv, logFile);
      res = classifyRun(child);
      res.code = child.code;
    }
    const secs = Math.round((Date.now() - started) / 1000);
    results.push({ id: item.id, action: item.action, ...res, seconds: secs });
    say(`${item.id.padEnd(10)} ${res.outcome.toUpperCase().padEnd(8)} ${res.line}${item.action === 'enrich' ? `  (${secs}s)` : ''}`);
    if (stopsBackfill(res.outcome, { continueOnError })) {
      stopped = { at: i, outcome: res.outcome, id: item.id };
      break;
    }
  }

  const remaining = stopped ? queue.slice(stopped.at).map((q) => q.id) : [];
  const counts = Object.fromEntries(COUNTED.map((k) => [k, 0]));
  for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  counts['not run'] = stopped ? queue.length - results.length : 0;

  say('');
  say('══ Backfill summary ══');
  say(COUNTED.filter((k) => counts[k]).map((k) => `${k} ${counts[k]}`).join(' · ') || 'nothing ran');
  if (stopped) {
    const why = {
      quota: 'a usage/session limit or quota was hit — wait for it to reset',
      killed: 'a job was killed — check the memory limit before anything else',
      failed: 'a job FAILED (see its log)',
    }[stopped.outcome];
    say(`STOPPED at ${stopped.id}: ${why}.`);
    say(`resume:  ${resumeCommand(remaining, resumeOpts)}`);
  } else {
    const failed = results.filter((r) => r.outcome === 'failed').map((r) => r.id);
    if (failed.length) say(`retry the failed ones:  ${resumeCommand(failed, resumeOpts)}`);
  }
  say(`logs:    ${logDir}`);
  fs.writeFileSync(path.join(logDir, 'summary.json'), `${JSON.stringify({
    startedAt: stamp, repo: cfg.repo, dryRun, model, continueOnError, includeEnriched, plan, results, counts, stopped, remaining,
  }, null, 2)}\n`);
  process.exit(stopped || counts.failed ? 1 : 0);
}

main().catch((err) => {
  say(`FAILED: ${err.message}`);
  if (err.detail) say(err.detail);
  if (process.env.BONA_DEBUG) say(err.stack);
  process.exit(1);
});
