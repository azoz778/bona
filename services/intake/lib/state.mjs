// Durable state for the daemon: which messages we already handled, which groups we
// already greeted, and which PDF hashes are already live. Atomic writes (tmp + rename)
// so a kill mid-write cannot corrupt it.
import fs from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({
  version: 1,
  seenMessageIds: [],
  announcedGroups: [],
  bySha256: {}, // sha256 -> { slug, id, url, at }
  lastError: null,
  lastPublishedAt: null,
});

const MAX_SEEN = 2000;

export function createState(file) {
  let data = EMPTY();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = { ...EMPTY(), ...parsed };
  } catch { /* first run */ }
  const seen = new Set(data.seenMessageIds);

  function save() {
    data.seenMessageIds = [...seen].slice(-MAX_SEEN);
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
    save,
  };
}
