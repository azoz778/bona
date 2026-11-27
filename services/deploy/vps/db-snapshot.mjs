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
//                the new copy.
//   --max-age-days N
//                afterwards also delete every snapshot in --out, of ANY label, whose UTC time in its name is more than
//                N days before this run's clock (default: none); never the copy just made, never a name this script
//                does not make (other files, sub-folders, temp files), never a name without a real UTC time.
//                deploy.sh passes --label deploy --keep 5 --max-age-days 30: the newest 5 deploy copies, and no copy
//                (a hand-made pre-v8 one too) after the first deploy once it is 30 days old (Codex r3 P1: the copies
//                hold conversations the live database has deleted). Nothing is deleted between deploys.
//
// node:sqlite (the VPS has no sqlite3 CLI). VACUUM INTO from a read-only connection is a read transaction
// on the live file: bona-api keeps writing meanwhile, the copy is one consistent point in time (WAL frames
// included), and the live file is never written. A database without Bona's schema (user_version 0, no
// leads table: a zero-byte file, say) is refused: a copy of it is no backup. The copy is made 0600 under a
// temporary name of its own run, opened again for PRAGMA integrity_check, and only when that says ok
// published under its final name with a hard link, which fails rather than replace a copy already there.
// A run holds its label's lock (release-backups/.bona-<label>.lock: its pid) from before the copy until after the
// prune, so two runs of one label never prune each other's copy; while the lock's run is alive another run of that
// label is refused, a lock whose run is gone (killed) is taken over (by one run only, see takeLock).
// Nothing from the database is printed except its schema version. Exit 0 = ok, 1 = failed (no file of this
// run left), 2 = usage.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const USAGE = 'usage: db-snapshot.mjs [--db FILE] [--out DIR] [--label a-z0-9-] [--keep N≥1] [--max-age-days N≥1]';
const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

class UsageError extends Error {}

/** The UTC time as it appears in a snapshot name: 2026-11-27T11:15:00.123Z → 20261127T111500Z. */
export function stamp(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

/** The snapshot names of one label (bona-<label>-<stamp>.db), and nothing else. */
const nameRe = (label) => new RegExp(`^bona-${label}-\\d{8}T\\d{6}Z\\.db$`);
/** A snapshot name of any label (LABEL_RE); group 1 is its stamp. */
const ANY_NAME_RE = /^bona-[a-z0-9][a-z0-9-]{0,39}-(\d{8}T\d{6}Z)\.db$/;

/** The time (ms) a stamp() stands for, or NaN when it is no real UTC time (20261341T000000Z: no 41st of a 13th month). */
export function stampTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) return NaN;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isFinite(t) && stamp(new Date(t)) === s ? t : NaN;
}

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

/** True while a process with this pid exists (EPERM: it exists, it is someone else's). */
function running(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Take the lock of `label` in `outDir` (Codex r2 P2: two runs of one label, each pruning all copies but its own,
 * would delete each other's). The lock file is written whole under a name of this run's own and then hard-linked
 * into place, so it is never seen half written; the link fails while another run's lock is there. That lock is
 * taken over only when its pid no longer runs (a run that was killed), and by one run only (Codex r3 P2: two runs
 * that read the same stale lock, the second one's delete removed the lock the first had just made): the stale lock is
 * set aside with an atomic rename to a name of this run's own, and only when the file it moved is the stale one it
 * read does the run go on; a live lock it moved instead (another run took over first) goes back, and the next pass
 * refuses. Returns the release function, which removes the lock only while it is still this run's.
 * `hooks.beforeTakeover` is for the tests: called after a lock was judged stale and before it is set aside.
 */
export function takeLock(outDir, label, hooks = {}) {
  const lock = path.join(outDir, `.bona-${label}.lock`);
  const mine = `${process.pid} ${randomBytes(6).toString('hex')}\n`;
  const tmp = `${lock}.${process.pid}.${randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, mine, { mode: 0o600, flag: 'wx' });
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        fs.linkSync(tmp, lock);
        break;
      } catch (err) {
        if (err?.code !== 'EEXIST' || attempt >= 3) throw err;
      }
      const held = readOrNull(lock);
      if (held === null) continue; // released in between: try again
      const pid = Number.parseInt(held, 10);
      if (running(pid)) {
        throw new Error(`another db-snapshot of --label ${label} is running (pid ${pid}); if it is not, remove ${lock}`);
      }
      // its run is gone: a stale lock
      hooks.beforeTakeover?.();
      const aside = `${lock}.${process.pid}.${randomBytes(6).toString('hex')}.stale`;
      try {
        fs.renameSync(lock, aside);
      } catch (err) {
        if (err?.code === 'ENOENT') continue; // another run took it over and is done already: try again
        throw err;
      }
      const moved = readOrNull(aside);
      if (moved !== held) {
        // another run's lock, taken over after this run read the stale one: it goes back where it was
        try {
          fs.linkSync(aside, lock);
        } catch (err) {
          if (err?.code === 'EEXIST') throw new Error(`the lock of --label ${label} changed hands while this run took over a stale one; run again`);
          throw err;
        } finally {
          fs.rmSync(aside, { force: true });
        }
        continue; // its run is alive: the next pass refuses
      }
      fs.rmSync(aside, { force: true });
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return () => {
    if (readOrNull(lock) === mine) fs.rmSync(lock, { force: true });
  };
}

/**
 * Copy `db` into `outDir`, check it, then prune that label down to `keep` (when given) and every label of copies older
 * than `maxAgeDays` days before `now` (when given), under the label's lock.
 * @returns {{ file: string, bytes: number, userVersion: number, pruned: string[], expired: string[] }}
 *   pruned = every snapshot this run deleted; expired = those of them deleted for their age.
 */
export function snapshotDb({ db, outDir, label = 'manual', keep = 0, maxAgeDays = 0, now = new Date() }) {
  if (!LABEL_RE.test(label)) throw new UsageError(`bad --label ${JSON.stringify(label)}`);
  if (!Number.isInteger(keep) || keep < 0) throw new UsageError(`bad --keep ${keep}`);
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 0) throw new UsageError(`bad --max-age-days ${maxAgeDays}`);
  if (!fs.existsSync(db)) throw new Error(`no database at ${db}`);

  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const release = takeLock(outDir, label);
  try {
    return snapshotLocked({ db, outDir, label, keep, maxAgeDays, now });
  } finally {
    release();
  }
}

function snapshotLocked({ db, outDir, label, keep, maxAgeDays, now }) {
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
  const expired = [];
  // Gone already (a run of another label pruned it by age meanwhile) is not an error, and not this run's deletion.
  const drop = (f) => {
    try {
      fs.rmSync(path.join(outDir, f));
    } catch (err) {
      if (err?.code === 'ENOENT') return false;
      throw err;
    }
    pruned.push(f);
    return true;
  };
  if (keep > 0) {
    // The copy just made always stays; of the others the newest keep - 1 by name. Names sort by time, but a
    // clock that went back can give older copies later names, and the new one must not be what goes.
    const others = fs.readdirSync(outDir).filter((f) => f !== name && nameRe(label).test(f)).sort().reverse();
    for (const f of others.slice(keep - 1)) drop(f);
  }
  if (maxAgeDays > 0) {
    // Every label: the snapshots hold conversations the live database has deleted since, whoever made them.
    const cutoff = now.getTime() - maxAgeDays * DAY_MS;
    for (const f of fs.readdirSync(outDir).sort()) {
      const m = f === name ? null : ANY_NAME_RE.exec(f);
      if (m && stampTime(m[1]) < cutoff && drop(f)) expired.push(f);
    }
  }
  return { file, bytes: fs.statSync(file).size, userVersion, pruned, expired };
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
      options: { db: { type: 'string' }, out: { type: 'string' }, label: { type: 'string' }, keep: { type: 'string' }, 'max-age-days': { type: 'string' } },
      allowPositionals: false,
      strict: true,
    }));
  } catch (err) {
    throw new UsageError(err.message);
  }
  const db = path.resolve(values.db ?? defaultDb());
  const keep = values.keep === undefined ? 0 : /^[1-9]\d{0,3}$/.test(values.keep) ? Number(values.keep) : NaN;
  if (Number.isNaN(keep)) throw new UsageError(`bad --keep ${JSON.stringify(values.keep)} (a whole number, 1 or more)`);
  const age = values['max-age-days'];
  const maxAgeDays = age === undefined ? 0 : /^[1-9]\d{0,4}$/.test(age) ? Number(age) : NaN;
  if (Number.isNaN(maxAgeDays)) throw new UsageError(`bad --max-age-days ${JSON.stringify(age)} (a whole number of days, 1 or more)`);
  const label = values.label ?? 'manual';
  if (!LABEL_RE.test(label)) throw new UsageError(`bad --label ${JSON.stringify(label)}`);
  return { db, outDir: path.resolve(values.out ?? path.join(path.dirname(db), 'release-backups')), label, keep, maxAgeDays };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const opts = parse(argv);
    const r = snapshotDb(opts);
    console.log(`ok snapshot ${r.file} (${r.bytes} bytes, user_version ${r.userVersion}, integrity ok, mode 0600)`);
    for (const f of r.pruned) console.log(r.expired.includes(f) ? `ok pruned ${f} (older than ${opts.maxAgeDays} days)` : `ok pruned ${f}`);
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
