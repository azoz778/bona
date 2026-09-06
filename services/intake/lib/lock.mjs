// A flock-style advisory lock shared by the daemon and run-once.mjs, so two processes can
// never write the publishing clone at the same time. `open(…, 'wx')` is atomic on every
// filesystem we care about; a lock whose holder is gone (crash, kill -9) or whose file is
// older than `staleMs` is stolen rather than waited on forever.
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function holderOf(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * @returns {Promise<() => void>} release function (idempotent)
 */
export async function acquireLock(file, { timeoutMs = 900000, staleMs = 3600000, pollMs = 250, label = '' } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, `${JSON.stringify({ pid: process.pid, label, at: new Date().toISOString() })}\n`);
      fs.closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const own = holderOf(file);
        if (!own || own.pid === process.pid) fs.rmSync(file, { force: true });
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const holder = holderOf(file);
      let age = 0;
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { age = 0; }
      if ((holder && !alive(holder.pid)) || age > staleMs) {
        fs.rmSync(file, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`another intake job holds ${path.basename(file)} (pid ${holder?.pid ?? '?'})`);
      }
      await sleep(pollMs);
    }
  }
}

/** Run `fn` while holding the lock. */
export async function withLock(file, fn, opts = {}) {
  const release = await acquireLock(file, opts);
  try { return await fn(); } finally { release(); }
}
