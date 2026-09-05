// Repo side: regenerate listings.json, validate it, commit and push, then wait for the
// page to go live. Everything here is skippable (`noGit`) so run-once.mjs can exercise the
// whole pipeline against a worktree without touching a remote.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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

const must = async (label, res) => {
  if (res.code !== 0) throw new Error(`${label} failed: ${(res.err || res.out).split('\n').slice(-4).join(' ').slice(0, 400)}`);
  return res;
};

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

export async function gitCommitPush(repo, message, { remote = 'origin', branch = 'main', author = 'Bona intake <intake@bona.azoz.uk>' } = {}) {
  await must('git add', await run('git', ['add', '-A'], { cwd: repo }));
  const status = await run('git', ['status', '--porcelain'], { cwd: repo });
  if (!status.out) return { committed: false, pushed: false, sha: null };
  await must('git commit', await run('git', ['commit', '-m', message, '--author', author], { cwd: repo, env: { GIT_AUTHOR_NAME: 'Bona intake', GIT_AUTHOR_EMAIL: 'intake@bona.azoz.uk', GIT_COMMITTER_NAME: 'Bona intake', GIT_COMMITTER_EMAIL: 'intake@bona.azoz.uk' } }));
  const sha = (await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo })).out;
  let push = await run('git', ['push', remote, `HEAD:${branch}`], { cwd: repo });
  if (push.code !== 0) {
    // Someone else pushed while we were working — rebase on top and try once more.
    await gitPull(repo, { remote, branch });
    push = await run('git', ['push', remote, `HEAD:${branch}`], { cwd: repo });
  }
  if (push.code !== 0) throw new Error(`git push failed: ${(push.err || push.out).slice(-300)}`);
  return { committed: true, pushed: true, sha };
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
