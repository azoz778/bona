// The git side. These tests drive REAL git repositories in a temp dir — the bug they exist
// for (finding 1) was invisible to a mock: `git rebase` refuses to run when the working
// tree is dirty, and build.mjs dirties it by rewriting the tracked src/data/listings.json.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  ALLOWED_PATHS, assertCleanTree, gitCommitPush, gitPull, gitStatus, resetTree,
} from '../lib/publish.mjs';

const git = (cwd, ...args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  },
}).trim();

let root;
let origin;
let clone;

const write = (repo, rel, body) => {
  const file = path.join(repo, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-publish-'));
  origin = path.join(root, 'origin.git');
  clone = path.join(root, 'clone');
  git(root, 'init', '--bare', '-b', 'main', origin);
  git(root, 'clone', origin, clone);
  git(clone, 'config', 'user.email', 't@e');
  git(clone, 'config', 'user.name', 'T');
  write(clone, 'src/data/listings.json', '[]\n');
  write(clone, 'scripts/curate/inbox/_index.json', '{"nextSeq":1,"listings":{}}\n');
  write(clone, 'README.md', 'site\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-m', 'init');
  git(clone, 'push', 'origin', 'main');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('assertCleanTree — the clone must be pristine before a job starts', () => {
  it('passes straight through on a clean tree', async () => {
    assert.deepEqual(await assertCleanTree(clone), { clean: true, recovered: false });
  });

  it('recovers a tree a crashed job left dirty', async () => {
    write(clone, 'src/data/listings.json', '[{"dirty":true}]\n');            // tracked, modified
    write(clone, 'public/listings/villa/01.jpg', 'x');                        // untracked leftover
    write(clone, 'scripts/curate/inbox/villa.json', '{}');                    // untracked leftover
    const res = await assertCleanTree(clone);
    assert.equal(res.recovered, true);
    assert.equal(await gitStatus(clone), '');
    assert.equal(fs.existsSync(path.join(clone, 'public/listings/villa')), false);
    assert.equal(fs.readFileSync(path.join(clone, 'src/data/listings.json'), 'utf8'), '[]\n');
  });

  it('refuses to continue when the dirt is not the intake\'s to clean', async () => {
    write(clone, 'somebody-elses-work.txt', 'do not delete me');
    await assert.rejects(() => assertCleanTree(clone), /uncommitted path/);
    assert.equal(fs.existsSync(path.join(clone, 'somebody-elses-work.txt')), true);
  });

  it('never discards a TRACKED file outside its own paths', async () => {
    write(clone, 'README.md', 'someone was editing this');
    await assert.rejects(() => assertCleanTree(clone), /uncommitted path/);
    assert.equal(fs.readFileSync(path.join(clone, 'README.md'), 'utf8'), 'someone was editing this');
  });
});

describe('publish ordering — pull BEFORE anything is written', () => {
  it('git rebase fails once build.mjs has rewritten listings.json (the bug)', async () => {
    write(clone, 'src/data/listings.json', '[{"rebuilt":true}]\n');
    await assert.rejects(() => gitPull(clone, { remote: 'origin', branch: 'main' }), /git rebase failed/);
  });

  it('succeeds in the fixed order: clean, pull, then write', async () => {
    // someone else pushed in the meantime
    const other = path.join(root, 'other');
    git(root, 'clone', origin, other);
    git(other, 'config', 'user.email', 'o@e');
    git(other, 'config', 'user.name', 'O');
    write(other, 'src/data/listings.json', '[{"theirs":true}]\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-m', 'theirs');
    git(other, 'push', 'origin', 'main');

    await assertCleanTree(clone);
    await gitPull(clone, { remote: 'origin', branch: 'main' });
    assert.match(fs.readFileSync(path.join(clone, 'src/data/listings.json'), 'utf8'), /theirs/);
    write(clone, 'public/listings/villa/01.jpg', 'x');
    write(clone, 'scripts/curate/inbox/villa.json', '{"id":"BONA-W001"}');
    const res = await gitCommitPush(clone, 'intake: villa (BONA-W001)', { remote: 'origin', branch: 'main', paths: ['public/listings/villa', 'scripts/curate/inbox', 'src/data/listings.json'] });
    assert.equal(res.pushed, true);
    assert.equal(await gitStatus(clone), '');
  });
});

describe('gitCommitPush — an explicit allowlist, never `git add -A`', () => {
  it('stages only the allowlisted paths and leaves everything else alone', async () => {
    write(clone, 'public/listings/villa/01.jpg', 'x');
    write(clone, 'scripts/curate/inbox/villa.json', '{"id":"BONA-W001"}');
    write(clone, 'src/data/listings.json', '[{"villa":true}]\n');
    write(clone, 'notes-from-another-agent.md', 'work in progress');   // must NOT be committed
    write(clone, 'services/api/index.mjs', 'another agent\'s file');   // must NOT be committed

    const res = await gitCommitPush(clone, 'intake: villa (BONA-W001)', {
      remote: 'origin', branch: 'main',
      paths: ['public/listings/villa', 'scripts/curate/inbox', 'src/data/listings.json'],
    });
    assert.equal(res.committed, true);
    assert.deepEqual(res.staged.sort(), ['public/listings/villa/01.jpg', 'scripts/curate/inbox/villa.json', 'src/data/listings.json']);
    const committed = git(clone, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
    assert.ok(!committed.some((f) => /another-agent|services\/api/.test(f)), `stray files were committed: ${committed}`);
    assert.match(await gitStatus(clone), /notes-from-another-agent\.md/, 'the other agent\'s file is still there, untracked');
  });

  it('is a no-op when nothing in the allowlist changed', async () => {
    write(clone, 'untouched-by-intake.txt', 'hello');
    const res = await gitCommitPush(clone, 'intake: nothing', { remote: 'origin', branch: 'main' });
    assert.deepEqual(res, { committed: false, pushed: false, sha: null, staged: [] });
  });

  it('refuses a path outside the allowlist', async () => {
    await assert.rejects(
      () => gitCommitPush(clone, 'intake: sneaky', { remote: 'origin', branch: 'main', paths: ['.github/workflows'] }),
      /outside the intake allowlist/,
    );
  });

  it('the allowlist is exactly the three places the intake writes', () => {
    assert.deepEqual(ALLOWED_PATHS, ['public/listings', 'scripts/curate/inbox', 'src/data/listings.json']);
  });
});

describe('resetTree — a failed job leaves the clone clean for the next one', () => {
  it('deletes the new listing and restores every tracked file', async () => {
    write(clone, 'public/listings/villa/01.jpg', 'x');
    write(clone, 'public/listings/villa/01-thumb.webp', 'x');
    write(clone, 'scripts/curate/inbox/villa.json', '{"id":"BONA-W001"}');
    write(clone, 'src/data/listings.json', '[{"half-written":true}]\n');

    const clean = await resetTree(clone, { dirs: ['public/listings/villa'] });
    assert.equal(clean, true);
    assert.equal(await gitStatus(clone), '');
    assert.equal(fs.existsSync(path.join(clone, 'public/listings/villa')), false);
    assert.equal(fs.existsSync(path.join(clone, 'scripts/curate/inbox/villa.json')), false);
    assert.equal(fs.readFileSync(path.join(clone, 'src/data/listings.json'), 'utf8'), '[]\n');
  });

  it('leaves another agent\'s edits alone', async () => {
    write(clone, 'README.md', 'someone else was here');
    write(clone, 'src/data/listings.json', '[{"half-written":true}]\n');
    await resetTree(clone);
    assert.equal(fs.readFileSync(path.join(clone, 'README.md'), 'utf8'), 'someone else was here');
    assert.equal(fs.readFileSync(path.join(clone, 'src/data/listings.json'), 'utf8'), '[]\n');
    git(clone, 'checkout', '--', 'README.md');
  });

  it('will not delete outside the repo', async () => {
    const outside = path.join(root, 'keepme');
    fs.mkdirSync(outside);
    await resetTree(clone, { dirs: ['../keepme'] });
    assert.equal(fs.existsSync(outside), true);
  });

  it('leaves the clone able to pull again', async () => {
    write(clone, 'src/data/listings.json', '[{"dirty":true}]\n');
    await resetTree(clone);
    await gitPull(clone, { remote: 'origin', branch: 'main' });   // would throw if still dirty
  });
});

// Call-site guard for finding 1: the modules can be correct and the daemon still wrong if
// it pulls in the middle. These assert the ORDER the two entry points actually use.
describe('the entry points pull before they write, and never after', () => {
  const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

  for (const file of ['index.mjs', 'run-once.mjs']) {
    it(`${file} pulls before processPdf and not again afterwards`, () => {
      const src = read(file);
      const pull = src.indexOf(file === 'index.mjs' ? 'await prepareRepo()' : 'await gitPull(cfg.repo');
      const process_ = src.indexOf('processPdf({');
      const push = src.indexOf('gitCommitPush(cfg.repo');
      assert.ok(pull > 0 && process_ > 0 && push > 0, 'all three steps must be present');
      assert.ok(pull < process_, 'the pull must come BEFORE the pipeline writes anything');
      assert.ok(process_ < push, 'the push must come after');
      const between = src.slice(process_, push);
      assert.ok(!/gitPull\(/.test(between), 'nothing may pull between writing and committing');
      assert.ok(!/\brebuild\(cfg\.repo\)/.test(between), 'the rebuild belongs inside processPdf, before the commit');
    });

    it(`${file} stages an explicit path list, never the default`, () => {
      const src = read(file);
      for (const m of src.matchAll(/gitCommitPush\([\s\S]{0,400?}?\)/g)) {
        assert.match(m[0], /paths:/, `gitCommitPush without an explicit allowlist: ${m[0].slice(0, 80)}`);
      }
    });
  }

  it('index.mjs holds the lock across the whole repo phase', () => {
    const src = read('index.mjs');
    const lock = src.indexOf('withLock(cfg.lockPath, async () => {');
    assert.ok(lock > 0);
    const body = src.slice(lock, src.indexOf('label: `pdf ', lock));
    assert.match(body, /prepareRepo\(\)/);
    assert.match(body, /processPdf\(/);
    assert.match(body, /gitCommitPush\(/);
  });

  it('index.mjs never blocks the worker on the live check', () => {
    const src = read('index.mjs');
    assert.ok(!/await waitForLive\(/.test(src), 'the live check must be detached');
    assert.match(src, /function watchLive\(/);
  });

  it('index.mjs waits for the job in flight instead of exiting on SIGTERM', () => {
    const src = read('index.mjs');
    assert.match(src, /await waitForIdle\(\(\) => working/);
    const shutdown = src.slice(src.indexOf('async function shutdown'), src.indexOf('async function main'));
    const exitAt = shutdown.indexOf('process.exit(0)');
    const waitAt = shutdown.indexOf('waitForIdle');
    assert.ok(waitAt > 0 && exitAt > waitAt, 'the exit must come after the wait');
    assert.ok(!/setTimeout\([^)]*process\.exit/.test(src), 'no timer-based exit');
  });
});
