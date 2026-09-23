#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { openDb } from '../lib/db.mjs';
import { planAttributionBackfill, applyAttributionBackfill, createRestrictedBackup, restoreRestrictedBackup } from '../lib/attribution-backfill.mjs';

function option(argv, i, name) {
  if (argv[i] === name) {
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${name} requires a ${name === '--rollback' ? 'manifest' : 'value'}`);
    return [argv[i + 1], 2];
  }
  if (argv[i].startsWith(`${name}=`)) return [argv[i].slice(name.length + 1), 1];
  return null;
}

export function parseBackfillArgs(argv) {
  const out = { dbFile: null, dryRun: true, json: false, rollbackManifest: null, force: false, apiOffline: false };
  for (let i = 0; i < argv.length;) {
    const db = option(argv, i, '--db');
    if (db) { out.dbFile = db[0]; i += db[1]; continue; }
    const rollback = option(argv, i, '--rollback');
    if (rollback) { out.rollbackManifest = rollback[0]; i += rollback[1]; continue; }
    if (argv[i] === '--dry-run') { out.dryRun = true; i += 1; continue; }
    if (argv[i] === '--apply') { out.dryRun = false; i += 1; continue; }
    if (argv[i] === '--json') { out.json = true; i += 1; continue; }
    if (argv[i] === '--force') { out.force = true; i += 1; continue; }
    if (argv[i] === '--confirm-api-offline') { out.apiOffline = true; i += 1; continue; }
    throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!out.dbFile) throw new Error('--db is required');
  return out;
}

function readonlyDb(file) {
  const raw = new DatabaseSync(file, { readOnly: true });
  const json = (v) => { try { return v == null ? null : JSON.parse(v); } catch { return null; } };
  return {
    db: raw,
    getSession(id) {
      const row = raw.prepare('SELECT * FROM sessions WHERE session_id = ?').get(String(id ?? ''));
      return row ? { ...row, first_touch: json(row.first_touch), last_touch: json(row.last_touch) } : null;
    },
    close() { raw.close(); },
  };
}

function publicReport(report) {
  return {
    ...report,
    changes: report.changes?.map(({ lead_id: ignored, ...change }) => change),
  };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseBackfillArgs(argv);
  const dbFile = path.resolve(args.dbFile);
  if (!fs.existsSync(dbFile)) throw new Error('database file does not exist');
  let report;
  if (args.rollbackManifest) {
    if (args.dryRun) throw new Error('--rollback requires --apply (a rollback is never a dry-run)');
    report = restoreRestrictedBackup(dbFile, path.resolve(args.rollbackManifest), {
      force: args.force,
      apiOffline: args.apiOffline,
    });
  } else if (args.dryRun) {
    const db = readonlyDb(dbFile);
    try { report = planAttributionBackfill(db); } finally { db.close(); }
  } else {
    const backup = createRestrictedBackup(dbFile);
    const db = openDb(dbFile);
    try {
      report = { ...applyAttributionBackfill(db), backup: { manifest: backup.manifestFile, sha256: backup.sha256 } };
    } finally {
      db.close();
    }
  }
  const safe = publicReport(report);
  process.stdout.write(`${JSON.stringify(safe, null, args.json ? 2 : 0)}\n`);
  return safe;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  try { main(); } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error).slice(0, 300) })}\n`);
    process.exitCode = 1;
  }
}
