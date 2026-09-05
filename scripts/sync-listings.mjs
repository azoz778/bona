#!/usr/bin/env node
// Refreshes status + price.amount in src/data/listings.json from the TK public API.
// Node 22+, ESM, no dependencies. Safe to run in CI: network failure => exit 0 ("sync skipped").
// Only listings with a `sourceRef` matching an API `id` are touched; only `status` and
// `price.amount` are ever written, and the file is rewritten only if something changed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.TK_PUBLIC_API || 'https://dashboard.azoz.uk/api/public/properties';
const TIMEOUT_MS = 10_000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'src', 'data', 'listings.json');

const STATUS_MAP = { available: 'available', sold: 'sold', reserved: 'reserved' };

/** "SAR 8,499,000", "starting from SAR 1,200,000", "1,450,000", "EUR 38,000,000" -> { amount, currency } ; "Upon Request" -> null */
export function parsePrice(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t || /request/i.test(t)) return null;
  const cur = (t.match(/\b(SAR|AED|EUR|USD|OMR)\b/i) || [])[1];
  const num = t.replace(/[^\d.,]/g, ' ').match(/\d[\d,]*(?:\.\d+)?/);
  if (!num) return null;
  const amount = Number(num[0].replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount, currency: cur ? cur.toUpperCase() : null };
}

async function fetchApi() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API, { signal: ac.signal, headers: { accept: 'application/json', 'user-agent': 'bona-sync/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const rows = Array.isArray(json) ? json : json?.data;
    if (!Array.isArray(rows)) throw new Error('unexpected payload shape');
    return rows;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  let rows;
  try {
    rows = await fetchApi();
  } catch (e) {
    console.log(`sync skipped: ${e.name === 'AbortError' ? `timeout after ${TIMEOUT_MS / 1000}s` : e.message}`);
    return 0;
  }
  const byId = new Map(rows.map((r) => [String(r.id), r]));

  const listings = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const changes = [];
  let matched = 0;
  const missing = [];

  for (const l of listings) {
    if (!l.sourceRef) continue;
    const api = byId.get(String(l.sourceRef));
    if (!api) { missing.push(l.sourceRef); continue; }
    matched++;

    const status = STATUS_MAP[String(api.status || '').toLowerCase()];
    if (status && status !== l.status) {
      changes.push(`${l.id} status ${l.status} -> ${status}`);
      l.status = status;
    }

    const parsed = parsePrice(api.price ?? api.price_text);
    const apiCurrency = (parsed && parsed.currency) || (api.currency ? String(api.currency).toUpperCase() : null);
    if (parsed && apiCurrency && apiCurrency !== l.price.currency) {
      console.log(`sync: ${l.id} currency mismatch (API ${apiCurrency} vs local ${l.price.currency}) — price left unchanged`);
    } else if (parsed && apiCurrency === l.price.currency) {
      if (l.price.amount !== parsed.amount) {
        changes.push(`${l.id} price ${l.price.amount ?? 'null'} -> ${parsed.amount}`);
        l.price.amount = parsed.amount;
      }
    }
  }

  if (changes.length) {
    // Atomic replace: write a temp file next to the target, fsync, then rename over it.
    const tmp = `${FILE}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(listings, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, FILE);
  }
  const extra = missing.length ? `, ${missing.length} sourceRef(s) not in API: ${missing.join(' ')}` : '';
  console.log(`sync: ${rows.length} API rows, ${matched} matched, ${changes.length} change(s)${changes.length ? ' — ' + changes.join('; ') : ''}${extra}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code)).catch((e) => { console.log(`sync skipped: ${e.message}`); process.exit(0); });
}
