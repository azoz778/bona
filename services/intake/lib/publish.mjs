// Repo side: git hygiene, regenerating listings.json, committing and pushing, then the live
// check. Everything here is skippable (`noGit`) so run-once.mjs can exercise the whole
// pipeline against a worktree without touching a remote.
//
// ORDER MATTERS (this was the bug that broke every publish): `git rebase` refuses to run
// with unstaged changes, and build.mjs rewrites the TRACKED file src/data/listings.json.
// So the pull happens BEFORE anything is written:
//
//     assertCleanTree() -> gitPull() -> write -> rebuild() -> gitCommitPush()
//
// and never in the middle. gitCommitPush still re-pulls AFTER committing (the tree is clean
// then) when the remote moved under us.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The only paths the intake is ever allowed to stage. Nothing else is committed. */
// `public/listings` is a PREFIX, so everything a listing owns is already covered:
// `public/listings/<slug>/NN.jpg`, `NN-thumb.webp` and the Bona-branded
// `public/listings/<slug>/brochure.pdf`. Nothing new had to be added for the brochure —
// underAllowed() below matches on the `<allowed>/` prefix, and publish.test.mjs pins it.
// `scripts/curate/licences.json` is where a CURATED listing's REGA numbers live (the intake's
// `licence`/`wafi` commands, lib/edits.mjs) — the one tracked file outside the inbox those
// commands write. It is on this list rather than a special case so a failed licence edit is
// reverted by revertOwnPaths() like everything else.
export const ALLOWED_PATHS = ['public/listings', 'scripts/curate/inbox', 'scripts/curate/licences.json', 'src/data/listings.json'];
/** Where a crashed job can leave untracked files behind. */
export const SCRATCH_PATHS = ['public/listings', 'scripts/curate/inbox'];

export function run(cmd, args, { cwd, timeoutMs = 600000, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e.message) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.trim(), err: err.trim() }); });
  });
}

/**
 * Throw with a GENERIC message. The stderr of git/node goes to `err.detail` (journal only)
 * and never into a WhatsApp reply — build output can quote file contents.
 */
const must = async (label, res) => {
  if (res.code !== 0) {
    const err = new Error(`${label} failed — see the journal`);
    err.detail = (res.err || res.out).split('\n').slice(-6).join('\n').slice(0, 1200);
    err.label = label;
    throw err;
  }
  return res;
};

/**
 * True when every path is tracked by git and unchanged from HEAD — the condition for deleting
 * it, because a rollback (resetTree) can only bring back what HEAD holds.
 */
export async function committedUnchanged(repo, paths) {
  for (const p of paths) {
    const tracked = await run('git', ['ls-files', '--error-unmatch', '--', p], { cwd: repo });
    if (tracked.code !== 0) return false;
  }
  const status = await run('git', ['status', '--porcelain', '--', ...paths], { cwd: repo });
  return status.code === 0 && status.out === '';
}

/**
 * Commits the intake makes over a published listing that a re-run rebuilds anyway (never its publish
 * commit): `--replace`, `--enrich`, the backfill's brochure rebuild (backfill-enrich.mjs) and the
 * WhatsApp `brochure <id>` command (index.mjs: "intake: branded brochure (<id>)").
 */
const INTAKE_REBUILDS = ['intake: replace ', 'intake: enrich ', 'intake: rebuild brochure ', 'intake: branded brochure ('];

/**
 * Why a published listing may NOT be rebuilt from its brochure, or null when it may: every commit
 * touching `paths` must be the one that published it or a later `intake: replace …`, `intake: enrich …`,
 * `intake: rebuild brochure …` (backfill-enrich.mjs) or `intake: branded brochure (<id>)` (the WhatsApp
 * `brochure <id>` command) run — an enrichment or a brochure rebuild adds only what a re-run rebuilds
 * anyway: unit models, floor plans, fact lists, the brochure. Anything else (a hand fix, a re-crop, an
 * edit) is reported. A shallow clone cannot show the history, so it is refused rather than trusted.
 */
export async function changedSincePublished(repo, paths) {
  const shallow = await run('git', ['rev-parse', '--is-shallow-repository'], { cwd: repo });
  if (shallow.code !== 0 || shallow.out !== 'false') return 'its git history could not be read in full';
  // One log over all the paths, so the commits come back in history order (newest first).
  const r = await run('git', ['log', '--format=%H%x09%s', '--', ...paths], { cwd: repo });
  if (r.code !== 0) return 'its git history could not be read';
  const commits = r.out.split('\n').filter(Boolean).map((line) => line.split('\t').slice(1).join('\t'));
  if (!commits.length) return 'it is not in git';
  // The oldest commit on these paths must be the intake's own publish commit ("intake: <title> (<id>)").
  // If it is not — a hand rename moved the files, so their history starts at the rename — the real
  // history cannot be read from these paths, and the listing is refused.
  const origin = commits[commits.length - 1];
  if (!origin.startsWith('intake: ') || INTAKE_REBUILDS.some((p) => origin.startsWith(p))) {
    return `its history starts at "${origin.slice(0, 60)}", not at the intake's publish commit`;
  }
  const later = commits.slice(0, -1);
  const others = later.filter((subject) => !INTAKE_REBUILDS.some((p) => subject.startsWith(p)));
  return others.length ? `${others.length} later commit(s), e.g. "${others[0].slice(0, 60)}"` : null;
}

export async function gitStatus(repo) {
  return (await run('git', ['status', '--porcelain'], { cwd: repo })).out;
}

/**
 * Undo the intake's OWN paths and nothing else. Deliberately not `git checkout -- .`: if a
 * tracked file outside the allowlist has been modified, that is somebody else's work and the
 * job stops rather than silently discarding it.
 */
async function revertOwnPaths(repo) {
  for (const p of ALLOWED_PATHS) {
    // A path that is not in HEAD (no inbox yet) is not an error worth failing on.
    await run('git', ['checkout', '--', p], { cwd: repo });
  }
  await run('git', ['clean', '-fd', '--', ...SCRATCH_PATHS], { cwd: repo });
}

/**
 * The publishing clone must be pristine before a job starts, or `git rebase` refuses to run.
 * A previous crash can leave it dirty; that is recoverable (everything the intake writes is
 * reproducible), so clean it once and re-check.
 * @returns {Promise<{clean:true, recovered:boolean}>}
 */
export async function assertCleanTree(repo) {
  const before = await gitStatus(repo);
  if (!before) return { clean: true, recovered: false };
  await revertOwnPaths(repo);
  const after = await gitStatus(repo);
  if (after) {
    const err = new Error(`the publishing clone has ${after.split('\n').length} uncommitted path(s) that could not be cleaned — see the journal`);
    err.detail = after.slice(0, 1200);
    throw err;
  }
  return { clean: true, recovered: true };
}

/**
 * Undo everything a failed job wrote, so the next job starts from a clean clone.
 * @param {{dirs?:string[]}} opts dirs = repo-relative directories to delete outright
 */
export async function resetTree(repo, { dirs = [] } = {}) {
  for (const d of dirs) {
    const abs = path.resolve(repo, d);
    if (abs.startsWith(path.resolve(repo) + path.sep)) fs.rmSync(abs, { recursive: true, force: true });
  }
  await revertOwnPaths(repo);
  return (await gitStatus(repo)) === '';
}

/** node scripts/curate/build.mjs && node scripts/curate/validate.mjs */
export async function rebuild(repo) {
  const build = await must('build.mjs', await run(process.execPath, ['scripts/curate/build.mjs'], { cwd: repo }));
  const validate = await must('validate.mjs', await run(process.execPath, ['scripts/curate/validate.mjs'], { cwd: repo }));
  return { build: build.out, validate: validate.out };
}

export async function gitPull(repo, { remote = 'origin', branch = 'main' } = {}) {
  await must('git fetch', await run('git', ['fetch', remote, branch], { cwd: repo }));
  return must('git rebase', await run('git', ['rebase', `${remote}/${branch}`], { cwd: repo }));
}

const underAllowed = (p) => ALLOWED_PATHS.some((a) => p === a || p.startsWith(`${a}/`));

/**
 * Stage ONLY an explicit allowlist — never `git add -A` on the whole tree, which would sweep
 * up whatever else happens to be in the clone.
 * @param {string[]} [opts.paths] repo-relative paths (default ALLOWED_PATHS)
 */
export async function gitCommitPush(repo, message, { remote = 'origin', branch = 'main', paths = ALLOWED_PATHS } = {}) {
  for (const p of paths) {
    if (!underAllowed(p)) throw new Error(`refusing to stage "${p}": outside the intake allowlist`);
    const res = await run('git', ['add', '-A', '--', p], { cwd: repo });
    // A path that neither exists nor is tracked (e.g. no inbox yet) is not an error.
    if (res.code !== 0 && !/did not match any files/i.test(`${res.err} ${res.out}`)) await must(`git add ${p}`, res);
  }
  const staged = (await run('git', ['diff', '--cached', '--name-only'], { cwd: repo })).out;
  if (!staged) return { committed: false, pushed: false, sha: null, staged: [] };
  const stagedPaths = staged.split('\n').filter(Boolean);
  const stray = stagedPaths.filter((p) => !underAllowed(p));
  if (stray.length) {
    await run('git', ['reset'], { cwd: repo });
    throw new Error(`refusing to commit ${stray.length} path(s) outside the intake allowlist — see the journal`);
  }
  const author = { GIT_AUTHOR_NAME: 'Bona intake', GIT_AUTHOR_EMAIL: 'intake@bona.azoz.uk', GIT_COMMITTER_NAME: 'Bona intake', GIT_COMMITTER_EMAIL: 'intake@bona.azoz.uk' };
  await must('git commit', await run('git', ['commit', '-m', message], { cwd: repo, env: author }));
  const sha = (await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo })).out;
  /** HEAD is in the remote-tracking branch: on the remote already, whoever committed it (r2 #7). */
  const onRemote = async () => (await run('git', ['merge-base', '--is-ancestor', 'HEAD', `${remote}/${branch}`], { cwd: repo })).code === 0;
  /**
   * HEAD is the job's own commit — not on the remote, and carrying this job's author and message. A rebase
   * rewrites it, or drops it when the remote already has the same change (r2 #7).
   */
  const headIsOurs = async () => {
    if (await onRemote()) return false;
    const [name, email, ...body] = (await run('git', ['log', '-1', '--format=%an%x1f%ae%x1f%B', 'HEAD'], { cwd: repo })).out.split('\x1f');
    return name === author.GIT_AUTHOR_NAME && email === author.GIT_AUTHOR_EMAIL && body.join('\x1f').trim() === message.trim();
  };
  /** The job's own commit, as committed — its content is what a dropped rebase must find on the remote (r3 #8). */
  const committedSha = (await run('git', ['rev-parse', 'HEAD'], { cwd: repo })).out;
  let push = await run('git', ['push', remote, `HEAD:${branch}`], { cwd: repo });
  let failure = null;
  if (push.code !== 0) {
    // Someone else pushed while we were working — the tree is clean now that we have
    // committed, so a rebase is safe; then try once more.
    try {
      await gitPull(repo, { remote, branch });
      // The rebase dropped the job's commit: the remote's history already has that patch. It is published only
      // when the remote still holds its content (r3 #8: upstream may have applied the same change and reverted
      // it) — else the job failed, and nothing is reset off the remote's commits.
      if (await onRemote()) {
        const same = (await run('git', ['diff', '--quiet', committedSha, 'HEAD', '--', ...stagedPaths], { cwd: repo })).code === 0;
        if (same) {
          const upstream = (await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo })).out;
          return { committed: true, pushed: true, upstream: true, sha: upstream, staged: stagedPaths };
        }
        throw Object.assign(new Error('git push failed — the remote had this change and reverted it, so it was not published — see the journal'), { upstreamReverted: true });
      }
      push = await run('git', ['push', remote, `HEAD:${branch}`], { cwd: repo });
    } catch (err) {
      // A conflict leaves the rebase half done: abort it, so HEAD is the job's commit again (Codex r1 #7).
      await run('git', ['rebase', '--abort'], { cwd: repo });
      failure = err;
    }
  }
  if (!failure && push.code !== 0) {
    failure = new Error('git push failed — see the journal');
    failure.detail = (push.err || push.out).slice(-600);
  }
  if (failure) {
    // The commit never reached the remote: take it off HEAD — only when HEAD is still the job's own commit,
    // never one the remote branch contains (r2 #7) — so the clone matches the remote again and no later job's
    // push carries it (Codex r1 #7). Its files stay in the working tree, unstaged, for the caller's resetTree().
    if (await headIsOurs()) {
      const undo = await run('git', ['reset', '-q', 'HEAD~1'], { cwd: repo });
      failure.uncommitted = undo.code === 0;
    }
    throw failure;
  }
  return { committed: true, pushed: true, sha, staged: stagedPaths };
}

/** Poll the live URL until it answers 200 (GitHub Pages needs ~2–3 min). */
export async function waitForLive(url, { timeoutMs = 600000, intervalMs = 20000, fetchImpl = fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
      if (res.status === 200) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Copy a PDF into public/listings/<slug>/brochure.pdf.
 *
 * The pipeline no longer uses this: it stages the BRANDED brochure inside the run's staging
 * directory (see lib/brochure.mjs), which is promoted and rolled back with the photos. Kept
 * for a manual repair — putting a hand-made brochure on a listing — and because it is the
 * one place that names the path.
 */
export function writeBrochure(repo, slug, pdfPath) {
  const dir = path.join(repo, 'public', 'listings', slug);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'brochure.pdf');
  fs.copyFileSync(pdfPath, dest);
  return dest;
}
