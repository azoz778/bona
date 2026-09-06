// Durable state for the daemon: which messages we already handled, which groups we
// already greeted, which PDF hashes are already live, and — so that a crash between
// "seen" and "published" cannot lose a brochure — a record per PDF job. A job is written
// as `pending` BEFORE the message id is marked seen, and only becomes `done` once the
// pipeline has answered; `pendingJobs()` is replayed on startup.
// Atomic writes (tmp + rename) so a kill mid-write cannot corrupt it.
import fs from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({
  version: 2,
  seenMessageIds: [],
  announcedGroups: [],
  bySha256: {}, // sha256 -> { slug, id, url, at }
  jobs: {},     // messageId -> { id, jid, key, caption, fileName, pdfPath, status, attempts, at }
  lastError: null,
  lastPublishedAt: null,
});

const MAX_SEEN = 2000;
const MAX_JOBS = 200;
/** After this many failed runs a job stops being replayed on startup. */
export const MAX_JOB_ATTEMPTS = 3;

export function createState(file) {
  let data = EMPTY();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = { ...EMPTY(), ...parsed };
  } catch { /* first run */ }
  const seen = new Set(data.seenMessageIds);

  function pruneJobs() {
    const entries = Object.entries(data.jobs || {});
    if (entries.length <= MAX_JOBS) return;
    const done = entries.filter(([, j]) => j.status !== 'pending').sort((a, b) => String(a[1].at).localeCompare(String(b[1].at)));
    for (const [id] of done.slice(0, entries.length - MAX_JOBS)) delete data.jobs[id];
  }

  function save() {
    data.seenMessageIds = [...seen].slice(-MAX_SEEN);
    pruneJobs();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tmp, file);
  }

  return {
    get raw() { return data; },
    file,
    hasSeen: (id) => seen.has(id),
    markSeen(id) { if (id && !seen.has(id)) { seen.add(id); save(); } },
    /** Seed every id in a chat without acting on it (first run: do not republish history). */
    markSeenBulk(ids) {
      let changed = false;
      for (const id of ids) if (id && !seen.has(id)) { seen.add(id); changed = true; }
      if (changed) save();
    },
    isAnnounced: (jid) => data.announcedGroups.includes(jid),
    markAnnounced(jid) { if (!data.announcedGroups.includes(jid)) { data.announcedGroups.push(jid); save(); } },
    publishedFor: (sha) => data.bySha256[sha] || null,
    recordPublished(sha, info) { data.bySha256[sha] = { ...info, at: new Date().toISOString() }; data.lastPublishedAt = new Date().toISOString(); save(); },
    forgetPublished(predicate) {
      let changed = false;
      for (const [sha, info] of Object.entries(data.bySha256)) {
        if (predicate(info, sha)) { delete data.bySha256[sha]; changed = true; }
      }
      if (changed) save();
    },
    setError(err) { data.lastError = err ? { message: String(err), at: new Date().toISOString() } : null; save(); },

    // ---- durable PDF jobs -------------------------------------------------
    /** Record a job as `pending`. Call this BEFORE markSeen(), never after. */
    addJob(job) {
      if (!job?.id) return null;
      const existing = data.jobs[job.id];
      data.jobs[job.id] = {
        attempts: 0,
        ...existing,
        ...job,
        status: 'pending',
        at: existing?.at || new Date().toISOString(),
      };
      save();
      return data.jobs[job.id];
    },
    getJob: (id) => data.jobs[id] || null,
    updateJob(id, patch) {
      if (!data.jobs[id]) return null;
      data.jobs[id] = { ...data.jobs[id], ...patch };
      save();
      return data.jobs[id];
    },
    /** The pipeline answered (published, rejected, dry run): stop replaying it. */
    finishJob(id, outcome = 'done') {
      if (!data.jobs[id]) return null;
      data.jobs[id] = { ...data.jobs[id], status: outcome, doneAt: new Date().toISOString() };
      save();
      return data.jobs[id];
    },
    /** The job threw. Keep it pending until MAX_JOB_ATTEMPTS, then give up on it. */
    failJob(id, message) {
      const job = data.jobs[id];
      if (!job) return null;
      const attempts = (job.attempts ?? 0) + 1;
      data.jobs[id] = {
        ...job,
        attempts,
        lastError: message ? String(message).slice(0, 300) : null,
        status: attempts >= MAX_JOB_ATTEMPTS ? 'failed' : 'pending',
      };
      save();
      return data.jobs[id];
    },
    /** Oldest first, so a queue replayed on startup keeps its order. */
    pendingJobs() {
      return Object.values(data.jobs || {})
        .filter((j) => j.status === 'pending')
        .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    },
    save,
  };
}
