#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb } from '../lib/db.mjs';
import { importMetaSpend, validDay } from '../lib/meta-spend.mjs';

function value(argv, index, name) {
  const arg = argv[index];
  if (arg === name) {
    if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`${name} requires a value`);
    return [argv[index + 1], 2];
  }
  if (arg.startsWith(`${name}=`)) return [arg.slice(name.length + 1), 1];
  return null;
}

export function parseMetaSpendArgs(argv) {
  const out = { from: null, to: null, dryRun: true, json: false };
  for (let i = 0; i < argv.length;) {
    const from = value(argv, i, '--from');
    if (from) { out.from = from[0]; i += from[1]; continue; }
    const to = value(argv, i, '--to');
    if (to) { out.to = to[0]; i += to[1]; continue; }
    if (argv[i] === '--dry-run') { out.dryRun = true; i += 1; continue; }
    if (argv[i] === '--apply') { out.dryRun = false; i += 1; continue; }
    if (argv[i] === '--json') { out.json = true; i += 1; continue; }
    throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!out.from) throw new Error('--from is required');
  if (!out.to) throw new Error('--to is required');
  if (!validDay(out.from) || !validDay(out.to) || out.from > out.to) throw new Error('valid date range required');
  return out;
}

function envJson(name, fallback = {}) {
  if (!process.env[name]) return fallback;
  const value = JSON.parse(process.env[name]);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be a JSON object`);
  return value;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseMetaSpendArgs(argv);
  const accountId = process.env.BONA_META_AD_ACCOUNT_ID;
  const accessToken = process.env.BONA_META_MARKETING_TOKEN;
  if (!accountId || !accessToken) throw new Error('BONA_META_AD_ACCOUNT_ID and BONA_META_MARKETING_TOKEN are required');
  const dbFile = process.env.BONA_DB_FILE ?? path.join(process.env.BONA_DATA ?? path.join(os.homedir(), 'bona-data'), 'bona.db');
  const db = args.dryRun ? openDb(':memory:') : openDb(dbFile);
  try {
    const report = await importMetaSpend({
      db, accountId, accessToken, from: args.from, to: args.to, dryRun: args.dryRun,
      fxRates: envJson('BONA_META_SAR_RATES_JSON'),
    });
    process.stdout.write(`${JSON.stringify(report, null, args.json ? 2 : 0)}\n`);
    if (!report.ok) process.exitCode = 2;
    return report;
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main().catch((error) => {
  const token = process.env.BONA_META_MARKETING_TOKEN;
  const message = String(error?.message ?? error).slice(0, 300);
  process.stderr.write(`${JSON.stringify({ ok: false, error: token ? message.split(token).join('***') : message })}\n`);
  process.exitCode = 1;
});
