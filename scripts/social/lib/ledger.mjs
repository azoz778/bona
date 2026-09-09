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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Topic → id fragment. One definition, so the publisher derives the id gen-social wrote. */
export const slug = (str) => String(str ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');

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
/** Per-id view: the latest record and how many `error` lines it has accumulated. */
export function indexLedger(records) {
  const m = new Map();
  for (const r of records) {
    const cur = m.get(r.id) || { latest: null, errors: 0 };
    cur.latest = r;
    cur.errors = r.status === 'error' ? cur.errors + 1 : (r.status === 'published' ? 0 : cur.errors);
    m.set(r.id, cur);
  }
  return m;
}
