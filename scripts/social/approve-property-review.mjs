#!/usr/bin/env node
// Writes approved reviews into marketing/daily/property-reviews.json for frames a reviewer has looked at.
// Re-reads the live catalogue and the selected frames' bytes, refuses anything changed since drafting
// (listing facts, advertiser, photo bytes) or not eligible under the policy, and leaves an identical,
// still-eligible review untouched; an identical one that has expired is renewed.
// Usage: node scripts/social/approve-property-review.mjs --drafts DIR/drafts.json --reviewer "who looked" --select BONA-022:1,3,4 [--select …]
//          [--pad BONA-014[,BONA-044]] [--cards BONA-046:1,2] [--local-public DIR]
// --pad: every selected frame of that listing is published padded to 4:5 (owner, 2026-10-21): the
//   padded JPEGs are rendered here (lib/property-media.mjs) and written under public/social/property/<id>/,
//   which the site serves; commit them with the register. Mixed aspects are then fine, and a frame
//   narrower than 0.8 (down to 9:16) can be approved; the size floor still applies to the source.
// --cards BONA-ID:P,A: a land listing (policy `cards: "land-only"`) is published as a plot card set made
//   from its satellite stills P (the plot) and A (the area) (lib/property-cards.mjs): (a) the plot still,
//   (b) the facts, (c) the area still with district and city. Written under public/social/property/<id>/
//   like the padded frames; refused when the listing's facts are missing or contradict each other.
// --local-public DIR: the site's own images are read from DIR instead of the live site (see draft-property-reviews.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fingerprint, advertiserFingerprint, imageUrl, sha256, policyRules, eligibility, PAD_FIT } from './lib/property-daily.mjs';
import { buildReview, buildCardReview, liveCatalogue, localFetch, parseSelection, sameReview } from './lib/property-review.mjs';
import { refuseText } from './lib/facebook.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const ids = v => String(v ?? '').split(',').map(x => x.trim()).filter(Boolean);
function parseArgs(argv) {
  const a = { drafts: null, reviewer: null, select: [], pad: new Set(), cards: [], localPublic: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--drafts') { a.drafts = v; i++; }
    else if (k === '--reviewer') { a.reviewer = v; i++; }
    else if (k === '--select') { a.select.push(v); i++; }
    else if (k === '--pad') { for (const id of ids(v)) a.pad.add(id); i++; }
    else if (k === '--local-public') { a.localPublic = v; i++; }
    else if (k === '--cards') { a.cards.push(v); i++; }
    else throw new Error(`Unknown argument ${k}`);
  }
  if (!a.drafts || !a.reviewer?.trim() || !(a.select.length || a.cards.length)) throw new Error('Usage: approve-property-review.mjs --drafts DIR/drafts.json --reviewer "who looked" --select BONA-ID:1,2,3 [--select …] [--pad BONA-ID] [--cards BONA-ID:P,A] [--local-public DIR]');
  return a;
}
/** Fetches each selected frame again the way the draft script did: { problem } when its bytes cannot be approved, else { bytes } by website index. */
async function photoBytes(frames, fetchImpl) {
  const bytes = new Map();
  for (const f of frames) {
    let b;
    try {
      const res = await fetchImpl(imageUrl(f.url), { redirect: 'error', headers: { 'User-Agent': 'BonaPropertyPublisher/1.0' }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return { problem: `photo bytes could not be re-checked (frame ${f.index}: http ${res.status})` };
      b = Buffer.from(await res.arrayBuffer());
    } catch { return { problem: `photo bytes could not be re-checked (frame ${f.index}: network)` }; }
    if (sha256(b) !== f.sha256) return { problem: `photo bytes changed since drafting (frame ${f.index}) — draft it again` };
    bytes.set(f.index, b);
  }
  return { bytes };
}
/** The padded variant of each frame, rendered but not yet written: index → { record, bytes, file }. */
async function paddedVariants(root, id, frames, bytes) {
  const { padFrame, mediaTarget } = await import('./lib/property-media.mjs');
  const out = new Map();
  for (const f of frames) {
    const b = await padFrame(bytes.get(f.index));
    const t = mediaTarget(root, id, `pad-${f.sha256.slice(0, 8)}`, b);
    out.set(f.index, { record: { url: t.url, sha256: sha256(b), width: 1080, height: 1350 }, bytes: b, file: t.file });
  }
  return out;
}
export async function main(argv = process.argv.slice(2), { fetchImpl = fetch, now = new Date(), root = ROOT, log = console.log } = {}) {
  const args = parseArgs(argv);
  if (args.localPublic) fetchImpl = localFetch(args.localPublic, fetchImpl);
  const drafts = readJson(args.drafts);
  const rules = policyRules(readJson(path.join(root, 'marketing/daily/property-policy.json')), now);
  const registerPath = path.join(root, 'marketing/daily/property-reviews.json');
  const register = readJson(registerPath);
  const live = await liveCatalogue(fetchImpl, now);
  const advertiserChanged = advertiserFingerprint(live.advertiser) !== drafts.advertiserSha256;
  const refused = [], files = [];
  let written = 0, unchanged = 0;
  for (const raw of args.select) {
    let sel;
    try { sel = parseSelection(raw); } catch (e) { refused.push(e.message); continue; }
    const p = live.listings.find(x => x.id === sel.id), d = drafts.listings?.[sel.id];
    if (advertiserChanged) { refused.push(`${sel.id}: advertiser changed since drafting — draft again`); continue; }
    if (!p || !d) { refused.push(`${sel.id}: not in the live catalogue or the drafts`); continue; }
    if (d.factsSha256 !== fingerprint(p)) { refused.push(`${sel.id}: listing changed since drafting — draft it again`); continue; }
    const chosen = sel.frames.map(({ index }) => d.frames.find(f => f.index === index));
    if (chosen.some(f => !f)) { refused.push(`${sel.id}: frame ${sel.frames.find(({ index }) => !d.frames.some(f => f.index === index)).index} was not a usable draft frame`); continue; }
    const fetched = await photoBytes(chosen, fetchImpl);
    if (fetched.problem) { refused.push(`${sel.id}: ${fetched.problem}`); continue; }
    const pad = args.pad.has(sel.id);
    const variants = pad ? await paddedVariants(root, sel.id, chosen, fetched.bytes) : null;
    let review;
    try {
      review = buildReview(p, live.advertiser, d.frames, sel, { reviewedAt: now.toISOString(), reviewer: args.reviewer.trim(),
        ...(pad ? { fit: PAD_FIT, media: new Map([...variants].map(([i, v]) => [i, v.record])) } : {}) });
    } catch (e) { refused.push(e.message); continue; }
    const why = eligibility(p, review, live.advertiser, now, rules);
    if (why.length) { refused.push(`${sel.id}: ${why.join(', ')}`); continue; }
    for (const v of variants?.values() ?? []) { fs.mkdirSync(path.dirname(v.file), { recursive: true }); fs.writeFileSync(v.file, v.bytes); files.push(v.file); }
    const existing = register[sel.id];
    if (sameReview(existing, review) && !eligibility(p, existing, live.advertiser, now, rules).length) { unchanged++; continue; }
    register[sel.id] = review; written++;
  }
  for (const raw of args.cards) {
    const m = /^([A-Z]+-[A-Z]?\d+):(\d+),(\d+)$/.exec(String(raw));
    if (!m) { refused.push(`Bad --cards "${raw}" — use BONA-ID:P,A (plot still, area still)`); continue; }
    const id = m[1], p = live.listings.find(x => x.id === id), d = drafts.listings?.[id];
    if (advertiserChanged) { refused.push(`${id}: advertiser changed since drafting — draft again`); continue; }
    if (!p || !d) { refused.push(`${id}: not in the live catalogue or the drafts`); continue; }
    if (d.factsSha256 !== fingerprint(p)) { refused.push(`${id}: listing changed since drafting — draft it again`); continue; }
    const stills = [m[2], m[3]].map(n => (d.stills ?? []).find(s => s.index === Number(n)));
    if (stills.some(s => !s)) { refused.push(`${id}: still ${m[2]} or ${m[3]} is not a drafted listing still`); continue; }
    const fetched = await photoBytes(stills, fetchImpl);
    if (fetched.problem) { refused.push(`${id}: ${fetched.problem}`); continue; }
    const bad = (await import('./lib/property-cards.mjs')).cardStrings(p).map(refuseText).find(Boolean);
    if (bad) { refused.push(`${id}: card text refused: ${bad}`); continue; }
    let set;
    try {
      const { cardSet } = await import('./lib/property-cards.mjs');
      const still = s => ({ bytes: fetched.bytes.get(s.index), url: s.url, sha256: s.sha256, width: s.width, height: s.height });
      set = await cardSet(p, { plot: still(stills[0]), area: still(stills[1]) });
    } catch (e) { refused.push(e.message); continue; }
    const { mediaTarget } = await import('./lib/property-media.mjs');
    const cards = set.map(c => { const t = mediaTarget(root, id, `card-${c.card}`, c.bytes); return { ...c, url: t.url, file: t.file, sha256: sha256(c.bytes), width: 1080, height: 1350 }; });
    let review;
    try { review = buildCardReview(p, live.advertiser, cards, { reviewedAt: now.toISOString(), reviewer: args.reviewer.trim() }); }
    catch (e) { refused.push(e.message); continue; }
    const why = eligibility(p, review, live.advertiser, now, rules);
    if (why.length) { refused.push(`${id}: ${why.join(', ')}`); continue; }
    for (const c of cards) { fs.mkdirSync(path.dirname(c.file), { recursive: true }); fs.writeFileSync(c.file, c.bytes); files.push(c.file); }
    const existing = register[id];
    if (sameReview(existing, review) && !eligibility(p, existing, live.advertiser, now, rules).length) { unchanged++; continue; }
    register[id] = review; written++;
  }
  for (const id of args.pad) if (!args.select.some(s => String(s).startsWith(`${id}:`))) refused.push(`${id}: --pad without a --select for it`);
  if (written) {
    const sorted = Object.fromEntries(Object.keys(register).sort().map(k => [k, register[k]]));
    fs.writeFileSync(registerPath, JSON.stringify(sorted, null, 2) + '\n');
  }
  log(`Approved ${written}, unchanged ${unchanged}, refused ${refused.length}.`);
  for (const f of files) log(`  wrote ${path.relative(root, f)} (commit it with the register: the site serves it)`);
  for (const r of refused) log(`  refused ${r}`);
  return { written, unchanged, refused, ...(files.length ? { files } : {}) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().then(r => { if (r.refused.length) process.exitCode = 1; }, e => { console.error(e.message); process.exitCode = 1; });
