#!/usr/bin/env node
// Writes approved reviews into marketing/daily/property-reviews.json for frames a reviewer has looked at.
// Re-reads the live catalogue and the selected frames' bytes, refuses anything changed since drafting
// (listing facts, advertiser, photo bytes) or not eligible under the policy, and leaves an identical,
// still-eligible review untouched; an identical one that has expired is renewed.
// Usage: node scripts/social/approve-property-review.mjs --drafts DIR/drafts.json --reviewer "who looked" --select BONA-022:1,3,4 [--select …]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fingerprint, advertiserFingerprint, imageUrl, sha256, policyRules, eligibility } from './lib/property-daily.mjs';
import { buildReview, liveCatalogue, parseSelection, sameReview } from './lib/property-review.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function parseArgs(argv) {
  const a = { drafts: null, reviewer: null, select: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--drafts') { a.drafts = v; i++; }
    else if (k === '--reviewer') { a.reviewer = v; i++; }
    else if (k === '--select') { a.select.push(v); i++; }
    else throw new Error(`Unknown argument ${k}`);
  }
  if (!a.drafts || !a.reviewer?.trim() || !a.select.length) throw new Error('Usage: approve-property-review.mjs --drafts DIR/drafts.json --reviewer "who looked" --select BONA-ID:1,2,3 [--select …]');
  return a;
}
/** Fetches each selected frame again the way the draft script did; why its bytes cannot be approved, or null. */
async function photoBytesProblem(frames, fetchImpl) {
  for (const f of frames) {
    let bytes;
    try {
      const res = await fetchImpl(imageUrl(f.url), { redirect: 'error', headers: { 'User-Agent': 'BonaPropertyPublisher/1.0' }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return `photo bytes could not be re-checked (frame ${f.index}: http ${res.status})`;
      bytes = Buffer.from(await res.arrayBuffer());
    } catch { return `photo bytes could not be re-checked (frame ${f.index}: network)`; }
    if (sha256(bytes) !== f.sha256) return `photo bytes changed since drafting (frame ${f.index}) — draft it again`;
  }
  return null;
}
export async function main(argv = process.argv.slice(2), { fetchImpl = fetch, now = new Date(), root = ROOT, log = console.log } = {}) {
  const args = parseArgs(argv);
  const drafts = readJson(args.drafts);
  const rules = policyRules(readJson(path.join(root, 'marketing/daily/property-policy.json')), now);
  const registerPath = path.join(root, 'marketing/daily/property-reviews.json');
  const register = readJson(registerPath);
  const live = await liveCatalogue(fetchImpl, now);
  const advertiserChanged = advertiserFingerprint(live.advertiser) !== drafts.advertiserSha256;
  const refused = [];
  let written = 0, unchanged = 0;
  for (const raw of args.select) {
    let sel;
    try { sel = parseSelection(raw); } catch (e) { refused.push(e.message); continue; }
    const p = live.listings.find(x => x.id === sel.id), d = drafts.listings?.[sel.id];
    if (advertiserChanged) { refused.push(`${sel.id}: advertiser changed since drafting — draft again`); continue; }
    if (!p || !d) { refused.push(`${sel.id}: not in the live catalogue or the drafts`); continue; }
    if (d.factsSha256 !== fingerprint(p)) { refused.push(`${sel.id}: listing changed since drafting — draft it again`); continue; }
    let review;
    try { review = buildReview(p, live.advertiser, d.frames, sel, { reviewedAt: now.toISOString(), reviewer: args.reviewer.trim() }); }
    catch (e) { refused.push(e.message); continue; }
    const why = eligibility(p, review, live.advertiser, now, rules);
    if (why.length) { refused.push(`${sel.id}: ${why.join(', ')}`); continue; }
    const bytes = await photoBytesProblem(sel.frames.map(({ index }) => d.frames.find(f => f.index === index)), fetchImpl);
    if (bytes) { refused.push(`${sel.id}: ${bytes}`); continue; }
    const existing = register[sel.id];
    if (sameReview(existing, review) && !eligibility(p, existing, live.advertiser, now, rules).length) { unchanged++; continue; }
    register[sel.id] = review; written++;
  }
  if (written) {
    const sorted = Object.fromEntries(Object.keys(register).sort().map(k => [k, register[k]]));
    fs.writeFileSync(registerPath, JSON.stringify(sorted, null, 2) + '\n');
  }
  log(`Approved ${written}, unchanged ${unchanged}, refused ${refused.length}.`);
  for (const r of refused) log(`  refused ${r}`);
  return { written, unchanged, refused };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().then(r => { if (r.refused.length) process.exitCode = 1; }, e => { console.error(e.message); process.exitCode = 1; });
