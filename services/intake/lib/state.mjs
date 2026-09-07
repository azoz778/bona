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
  jobs: {},     // messageId -> { id, jid, key, caption, fileName, pdfPath, status, attempts, at, ts }
                //   video jobs add: kind:'video', fileLength, videoPath, waitingFor, waitSince, waitNotified, wakeSeen[],
                //   contentTried (the lib/video-match.mjs pass has been paid for once — a parked clip
                //   is re-queued on every new brochure and must not buy a model call each time) and
                //   contentSaw {listingId, confidence, candidates} (what that one pass concluded, kept
                //   because the clip usually parks afterwards and only asks about itself much later)
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

    /**
     * The "is this brochure already live?" question, asked on EVERY pass over a PDF —
     * a replay included.
     *
     * A replay used to be exempt, on the reasoning that a job only comes back when it
     * failed. It also comes back when it *succeeded* and the process died before the job
     * could be closed: the push has landed, the sha is recorded, and the downloaded PDF is
     * still on disk. Skipping the check there publishes the same brochure a second time —
     * a second listing id, a second commit, a second card on the site.
     *
     * Returns null when the job should go ahead, otherwise the listing that is already live
     * plus the outcome to close this job with: `done` when this very message is the one
     * that published it (our own push, finished late), `duplicate` when the owner has sent
     * a brochure that is already on the site.
     *
     * A dry run is exempt by design: it writes nothing and the owner asked for a preview.
     *
     * @param {{ sha: string, messageId?: string|null, dryRun?: boolean }} q
     */
    duplicateGuard({ sha, messageId = null, dryRun = false }) {
      if (dryRun) return null;
      const published = sha ? data.bySha256[sha] : null;
      if (!published) return null;
      const outcome = published.messageId && published.messageId === messageId ? 'done' : 'duplicate';
      return { published, outcome };
    },

    /**
     * The publish bookkeeping, as ONE atomic write: the sha becomes "already live" and the
     * job closes in the same tmp+rename. Two separate saves leave a window in between, and
     * a crash inside it is exactly the replay that publishes twice. Call this inside the
     * repo lock, the instant the push lands and BEFORE any reply goes out — a reply can be
     * retried, a second commit cannot be taken back.
     *
     * `messageId` is stored alongside the listing so a later replay can tell "my own push
     * finished" apart from "the owner sent this brochure again".
     */
    completePublish({ sha, messageId = null, id, slug, url }) {
      const at = new Date().toISOString();
      if (sha) data.bySha256[sha] = { id, slug, url, messageId, at };
      data.lastPublishedAt = at;
      if (messageId && data.jobs[messageId]) data.jobs[messageId] = { ...data.jobs[messageId], status: 'done', doneAt: at };
      save();
      return sha ? data.bySha256[sha] : null;
    },
    forgetPublished(predicate) {
      let changed = false;
      for (const [sha, info] of Object.entries(data.bySha256)) {
        if (predicate(info, sha)) { delete data.bySha256[sha]; changed = true; }
      }
      if (changed) save();
    },
    /**
     * A video job's close, as ONE write with what it produced — the counterpart of
     * completePublish() for a clip. Call it inside the repo lock the instant the push lands
     * (publishEdit's `onPushed`), never after the reply; and again for a replay that found
     * the clip already on the listing.
     */
    completeVideo({ messageId, id = null, src = null }) {
      if (!messageId || !data.jobs[messageId]) return null;
      const at = new Date().toISOString();
      data.jobs[messageId] = { ...data.jobs[messageId], status: 'done', doneAt: at, listingId: id, videoSrc: src, waitingFor: null };
      data.lastPublishedAt = at;
      save();
      return data.jobs[messageId];
    },
    /** The listing a PDF message published (completePublish keeps the message id), or null. */
    publishedByMessage(messageId) {
      if (!messageId) return null;
      for (const info of Object.values(data.bySha256)) if (info?.messageId === messageId) return info;
      return null;
    },
    /**
     * Un-see messages so the next poll handles them again, dropping any stale job record so
     * the replay starts clean. A recovery tool (services/intake/unsee.mjs) for messages an
     * older daemon swallowed — the daemon itself never calls this.
     * @returns {number} how many ids were actually forgotten
     */
    forgetSeen(ids) {
      let n = 0;
      for (const id of ids || []) {
        const wasSeen = seen.delete(id);
        const hadJob = Boolean(data.jobs[id]);
        if (hadJob) delete data.jobs[id];
        if (wasSeen || hadJob) n += 1;
      }
      if (n) save();
      return n;
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
    /**
     * The job threw. Keep it pending until MAX_JOB_ATTEMPTS, then give up on it.
     * Only a job still in flight can fail: one already closed — completePublish() /
     * completeVideo() ran and then the WhatsApp reply threw — stays closed. Reopening it
     * would replay a finished publish (Codex review, 2026-09-06).
     */
    failJob(id, message) {
      const job = data.jobs[id];
      if (!job) return null;
      if (job.status !== 'pending') return job;
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
