// The Instagram publisher's ledger, and the entry ids it is keyed on — shared by
// scripts/social/publish.mjs (writes it) and scripts/og/gen-social.mjs (reads it back so a
// regenerated calendar shows what already went out). Node 22+, zero dependencies.
//
// The ledger lives OUTSIDE the git working tree, by default at
//   ~/bona-data/ig/published.jsonl          (BONA_IG_LEDGER overrides; the same convention
//                                            services/intake uses for ~/bona-data)
// because a branch switch in ~/bona must never hide the record of what was published, and
// a repo copy would go stale the moment the timer wrote a line. One JSON object per line;
// the file is append-only. Its lock file, .publish.lock, sits beside it.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Topic → id fragment. One definition, so the publisher derives the id gen-social wrote. */
export const slug = (str) => String(str ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');

/** What a post IS, independent of its id: the exact image URLs (in order) and the caption sent. Stored on published lines; a match within dedupeDays is a duplicate. */
export const contentHash = (imageUrls, caption) => createHash('sha1').update(JSON.stringify([imageUrls, String(caption ?? '')])).digest('hex');

export const LEDGER_ENV = 'BONA_IG_LEDGER';
export const DEFAULT_LEDGER_DIR = path.join(os.homedir(), 'bona-data', 'ig');
export const DEFAULT_LEDGER_PATH = path.join(DEFAULT_LEDGER_DIR, 'published.jsonl');

/** Where the ledger is: an explicit path (e.g. --ledger), else $BONA_IG_LEDGER, else the default. */
export function resolveLedgerPath(explicit = null, env = process.env) {
  const p = explicit || env[LEDGER_ENV] || DEFAULT_LEDGER_PATH;
  return path.resolve(String(p).replace(/^~(?=\/|$)/, os.homedir()));
}
/** The run lock is always next to the ledger, whatever the ledger path is. */
export const lockPathFor = (ledgerPath) => path.join(path.dirname(ledgerPath), '.publish.lock');

export function parseLedger(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && r.id && r.status) out.push(r); } catch { /* skip a corrupt line */ }
  }
  return out;
}
/** A missing ledger is an empty ledger (first run, or a box the timer has never run on). */
export function readLedgerFile(file) {
  try { return parseLedger(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
/**
 * Per-id view:
 *   latest     the last line — the entry's current state for everything re-evaluated per run
 *   published  the FIRST `published` line, if any. Irrevocable: whatever lines follow (a hand
 *              edit, a merge, a recovery script appending `error`), the post went out once and
 *              must never go out again
 *   inFlight   a `publishing` line (container created, media_publish attempted or about to be)
 *              with no `published` / `error` line after it — settled only by reconciliation
 *   errors     `error` lines since the last publish (what skipped:gave-up counts) — minus the
 *              ones flagged `transient` (network, 5xx, rate limit): those say nothing about
 *              the post, and the grace window already bounds how long they are retried
 */
export function indexLedger(records) {
  const m = new Map();
  for (const r of records) {
    const cur = m.get(r.id) || { latest: null, published: null, inFlight: null, errors: 0 };
    cur.latest = r;
    if (r.status === 'published') { cur.published ??= r; cur.inFlight = null; cur.errors = 0; }
    else if (r.status === 'publishing') cur.inFlight = r;
    else if (r.status === 'error') { cur.inFlight = null; if (!r.transient) cur.errors += 1; }
    m.set(r.id, cur);
  }
  return m;
}
