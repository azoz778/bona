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
export const ALLOWED_PATHS = ['public/listings', 'scripts/curate/inbox', 'src/data/listings.json'];
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
  let push = await run('git', ['push', remote, `HEAD:${branch}`], { cwd: repo });
  if (push.code !== 0) {
    // Someone else pushed while we were working — the tree is clean now that we have
    // committed, so a rebase is safe; then try once more.
    await gitPull(repo, { remote, branch });
    push = await run('git', ['push', remote, `HEAD:${branch}`], { cwd: repo });
  }
  if (push.code !== 0) {
    const err = new Error('git push failed — see the journal');
    err.detail = (push.err || push.out).slice(-600);
    throw err;
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

/** Copy the brochure into public/listings/<slug>/brochure.pdf. */
export function writeBrochure(repo, slug, pdfPath) {
  const dir = path.join(repo, 'public', 'listings', slug);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'brochure.pdf');
  fs.copyFileSync(pdfPath, dest);
  return dest;
}
