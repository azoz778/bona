// A flock-style advisory lock shared by the daemon and run-once.mjs, so two processes can
// never write the publishing clone at the same time. `open(…, 'wx')` is atomic on every
// filesystem we care about.
//
// A lock is taken from its holder ONLY when that holder is gone — `process.kill(pid, 0)`
// throwing ESRCH is the proof (crash, kill -9, `systemctl stop` mid-publish). Age is not
// proof of anything: one publish is an AI call, a full Astro build and a push over a Jeddah
// link, and an hour of that is a healthy job, not a dead one. Stealing on age alone put the
// daemon and run-once.mjs inside the repo phase at the same moment — two writers in one
// clone, which is the single thing this file exists to prevent.
//
// The one age rule left is a hard ceiling (`ceilingMs`, 6 h): nothing here legitimately
// runs that long, and after a reboot a recycled pid can look alive for ever.
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Six hours. No AI + build + push takes that; a lock this old is wreckage. */
export const LOCK_CEILING_MS = 6 * 60 * 60 * 1000;

/**
 * A lock file that STILL records no pid this long after it was written has no holder to
 * protect: the `writeSync` that stamps the pid follows the `open` by microseconds, so an
 * empty or half-written lock is what a `kill -9` in that gap leaves behind, and a live
 * holder can never look like one. Without this rule such a file would wedge every intake
 * job until the six-hour ceiling. It applies only when the file could be READ and had no
 * pid in it — a file we cannot read at all is assumed to be someone's, not wreckage.
 */
export const LOCK_ORPHAN_MS = 60 * 1000;

/**
 * Is the holder still running? EPERM means the pid exists but belongs to another user —
 * still alive. Only ESRCH (no such process) is permission to steal, and an unreadable or
 * missing pid is treated as alive: a half-written lock file belongs to a process that is
 * mid-`writeSync`, and waiting a few hundred milliseconds costs nothing.
 */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code !== 'ESRCH'; }
}

/**
 * The lock's contents, told apart three ways, because "I cannot read this file" and "this
 * file names nobody" call for opposite decisions:
 *   an object  — the holder, as it stamped itself;
 *   null       — read fine, but empty or not parseable JSON: nobody is recorded;
 *   undefined  — could not be read at all (a transient EACCES/EMFILE). Assume a holder.
 */
function holderOf(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

/**
 * @param {string} file
 * @param {{ timeoutMs?: number, ceilingMs?: number, orphanMs?: number, pollMs?: number, label?: string }} [opts]
 *   `timeoutMs` — how long to wait for a live holder before failing the job cleanly.
 *   `ceilingMs` — the age past which even a live-looking pid loses the lock.
 *   `orphanMs`  — the age past which a zero-length (pid-less) lock file is wreckage.
 * @returns {Promise<() => void>} release function (idempotent)
 */
export async function acquireLock(file, { timeoutMs = 900000, ceilingMs = LOCK_CEILING_MS, orphanMs = LOCK_ORPHAN_MS, pollMs = 250, label = '' } = {}) {
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
      let stat = null;
      try { stat = fs.statSync(file); } catch { /* released between the open and the stat */ }
      const age = stat ? Date.now() - stat.mtimeMs : 0;
      // Dead holder, a lock that names nobody, or wreckage past the hard ceiling. Nothing
      // else is stealable — least of all a holder that is merely taking its time.
      const ownerless = holder === null && age > orphanMs;
      if (stat && (!alive(holder?.pid) || ownerless || age > ceilingMs)) {
        fs.rmSync(file, { force: true });
        continue;
      }
      // The holder is alive and working. Wait it out, and fail the job cleanly rather than
      // barging into a repo phase somebody else is halfway through.
      if (Date.now() >= deadline) {
        throw new Error(`another intake job holds ${path.basename(file)} (pid ${holder?.pid ?? '?'}, ${Math.round(age / 1000)}s)`);
      }
      if (stat) await sleep(pollMs);   // gone already: try the open again straight away
    }
  }
}

/** Run `fn` while holding the lock. */
export async function withLock(file, fn, opts = {}) {
  const release = await acquireLock(file, opts);
  try { return await fn(); } finally { release(); }
}
