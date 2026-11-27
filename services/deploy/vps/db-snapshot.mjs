#!/usr/bin/env node
// services/deploy/vps/db-snapshot.mjs — a consistent, integrity-checked copy of bona.db (PR-INFRA, 2026-11-27).
// Run ON THE VPS with the pinned node (lib.sh NODE_BIN): deploy.sh runs it after the tests and before the
// restart, because the new code applies its schema migrations at start; by hand before a schema PR merges:
//   ~/.local/opt/node-v24.19.0-linux-x64/bin/node /opt/bona/services/deploy/vps/db-snapshot.mjs --label pre-v8
//
//   --db FILE    the database (default: $BONA_DB_FILE, else $BONA_DATA/bona.db, else ~/bona-data/bona.db)
//   --out DIR    where the copy goes (default: release-backups/ beside the database; created 0700)
//   --label L    a-z, 0-9 and '-', at most 40 (default: manual); the copy is bona-<L>-<UTC time>.db
//   --keep N     afterwards delete all but the newest N copies of THIS label (default: delete nothing): the
//                copy just made and the N-1 newest others by name, so a clock that went back never costs
//                the new copy. deploy.sh passes --label deploy --keep 5, so a hand-made pre-v8 copy is never pruned.
//
// node:sqlite (the VPS has no sqlite3 CLI). VACUUM INTO from a read-only connection is a read transaction
// on the live file: bona-api keeps writing meanwhile, the copy is one consistent point in time (WAL frames
// included), and the live file is never written. A database without Bona's schema (user_version 0, no
// leads table: a zero-byte file, say) is refused: a copy of it is no backup. The copy is made 0600 under a
// temporary name of its own run, opened again for PRAGMA integrity_check, and only when that says ok
// published under its final name with a hard link, which fails rather than replace a copy already there.
// Nothing from the database is printed except its schema version. Exit 0 = ok, 1 = failed (no file of this
// run left), 2 = usage.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const USAGE = 'usage: db-snapshot.mjs [--db FILE] [--out DIR] [--label a-z0-9-] [--keep N≥1]';
const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

class UsageError extends Error {}

/** The UTC time as it appears in a snapshot name: 2026-11-27T11:15:00.123Z → 20261127T111500Z. */
export function stamp(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

/** The snapshot names of one label (bona-<label>-<stamp>.db), and nothing else. */
const nameRe = (label) => new RegExp(`^bona-${label}-\\d{8}T\\d{6}Z\\.db$`);

/**
 * Give `from` the name `to` without ever replacing a file already called `to` (another run's snapshot of the
 * same second): a hard link fails with EEXIST, where a rename would overwrite. Then `from` goes.
 */
export function publishNew(from, to) {
  try {
    fs.linkSync(from, to);
  } catch (err) {
    if (err?.code === 'EEXIST') throw new Error(`${to} already exists`);
    throw err;
  }
  fs.unlinkSync(from);
}

/**
 * Copy `db` into `outDir`, check it, then prune that label down to `keep` (when given).
 * @returns {{ file: string, bytes: number, userVersion: number, pruned: string[] }}
 */
export function snapshotDb({ db, outDir, label = 'manual', keep = 0, now = new Date() }) {
  if (!LABEL_RE.test(label)) throw new UsageError(`bad --label ${JSON.stringify(label)}`);
  if (!Number.isInteger(keep) || keep < 0) throw new UsageError(`bad --keep ${keep}`);
  if (!fs.existsSync(db)) throw new Error(`no database at ${db}`);

  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const name = `bona-${label}-${stamp(now)}.db`;
  const file = path.join(outDir, name);
  // This run's own temporary name: two runs in the same second never share (or delete) one.
  const partial = path.join(outDir, `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.partial`);
  if (fs.existsSync(file)) throw new Error(`${file} already exists`);

  let userVersion;
  const mask = process.umask(0o077); // the copy is born 0600, never readable by others for a moment
  try {
    const src = new DatabaseSync(db, { readOnly: true });
    try {
      src.exec('PRAGMA busy_timeout = 10000');
      userVersion = src.prepare('PRAGMA user_version').get().user_version;
      if (!(userVersion >= 1)) throw new Error(`${db} is not a Bona database (user_version ${userVersion}: no schema), so a copy of it is no backup`);
      src.prepare('VACUUM INTO ?').run(partial);
    } finally {
      src.close();
    }
    fs.chmodSync(partial, 0o600);
    const copy = new DatabaseSync(partial, { readOnly: true });
    let check;
    let copyVersion;
    let leads;
    try {
      check = copy.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check);
      copyVersion = copy.prepare('PRAGMA user_version').get().user_version;
      leads = copy.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'leads'").get().n;
    } finally {
      copy.close();
    }
    if (check.length !== 1 || check[0] !== 'ok') throw new Error(`integrity_check on the copy: ${check.slice(0, 3).join('; ')}`);
    if (copyVersion !== userVersion) throw new Error(`the copy has user_version ${copyVersion}, the database ${userVersion}`);
    if (leads !== 1) throw new Error(`${db} is not a Bona database (no leads table), so a copy of it is no backup`);
    publishNew(partial, file);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  } finally {
    process.umask(mask);
  }

  const pruned = [];
  if (keep > 0) {
    // The copy just made always stays; of the others the newest keep - 1 by name. Names sort by time, but a
    // clock that went back can give older copies later names, and the new one must not be what goes.
    const others = fs.readdirSync(outDir).filter((f) => f !== name && nameRe(label).test(f)).sort().reverse();
    for (const f of others.slice(keep - 1)) {
      fs.rmSync(path.join(outDir, f));
      pruned.push(f);
    }
  }
  return { file, bytes: fs.statSync(file).size, userVersion, pruned };
}

/** The defaults the API itself uses for its database (lib/config.mjs). */
function defaultDb(env = process.env) {
  if (env.BONA_DB_FILE) return env.BONA_DB_FILE;
  return path.join(env.BONA_DATA || path.join(os.homedir(), 'bona-data'), 'bona.db');
}

function parse(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { db: { type: 'string' }, out: { type: 'string' }, label: { type: 'string' }, keep: { type: 'string' } },
      allowPositionals: false,
      strict: true,
    }));
  } catch (err) {
    throw new UsageError(err.message);
  }
  const db = path.resolve(values.db ?? defaultDb());
  const keep = values.keep === undefined ? 0 : /^[1-9]\d{0,3}$/.test(values.keep) ? Number(values.keep) : NaN;
  if (Number.isNaN(keep)) throw new UsageError(`bad --keep ${JSON.stringify(values.keep)} (a whole number, 1 or more)`);
  const label = values.label ?? 'manual';
  if (!LABEL_RE.test(label)) throw new UsageError(`bad --label ${JSON.stringify(label)}`);
  return { db, outDir: path.resolve(values.out ?? path.join(path.dirname(db), 'release-backups')), label, keep };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const r = snapshotDb(parse(argv));
    console.log(`ok snapshot ${r.file} (${r.bytes} bytes, user_version ${r.userVersion}, integrity ok, mode 0600)`);
    for (const f of r.pruned) console.log(`ok pruned ${f}`);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`db-snapshot: ${err.message}\n${USAGE}`);
      return 2;
    }
    console.error(`db-snapshot: failed: ${err?.message ?? err}`);
    return 1;
  }
}

const isMain = () => {
  try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (isMain()) process.exitCode = main();
