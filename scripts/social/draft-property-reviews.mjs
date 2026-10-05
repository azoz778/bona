#!/usr/bin/env node
// Drafts photo/caption reviews for in-scope listings: usable frames, one contact sheet per listing,
// drafts.json with caption previews. Never writes the review register, never uploads anything.
// Usage: node scripts/social/draft-property-reviews.mjs --out NEW_DIR [--ids BONA-001,BONA-022]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { SITE, imageUrl, sha256, fingerprint, advertiserFingerprint, policyRules, eligibility, captionFor } from './lib/property-daily.mjs';
import { frameProblem, contactSheet, disclosuresFor, liveCatalogue } from './lib/property-review.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function parseArgs(argv) {
  const a = { out: null, ids: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--ids') a.ids = String(argv[++i] ?? '').split(',').filter(Boolean);
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  if (!a.out) throw new Error('Usage: draft-property-reviews.mjs --out NEW_DIR [--ids BONA-001,BONA-022]');
  return a;
}
export async function main(argv = process.argv.slice(2), { fetchImpl = fetch, now = new Date(), root = ROOT, log = console.log } = {}) {
  const args = parseArgs(argv);
  const out = path.resolve(args.out);
  if (fs.existsSync(out)) throw new Error('Choose a new output directory; earlier drafts are preserved');
  const rules = policyRules(readJson(path.join(root, 'marketing/daily/property-policy.json')), now);
  const reviews = readJson(path.join(root, 'marketing/daily/property-reviews.json'));
  const live = await liveCatalogue(fetchImpl, now);
  const wanted = args.ids ? new Set(args.ids) : null;
  if (wanted) for (const id of wanted) if (!live.listings.some(p => p.id === id)) throw new Error(`${id} is not in the live catalogue`);
  const inScope = p => p.status === 'available' && rules.countries.includes(p.location?.countryCode) && rules.categories.includes(p.category);
  const listings = live.listings.filter(p => inScope(p) && (wanted ? wanted.has(p.id) : eligibility(p, reviews[p.id], live.advertiser, now, rules).length > 0));
  fs.mkdirSync(out, { recursive: true });
  const drafts = { generatedAt: now.toISOString(), catalogueGeneratedAt: live.generatedAt, advertiserSha256: advertiserFingerprint(live.advertiser), listings: {} };
  for (const p of listings) {
    const frames = [], rejected = [];
    for (const [i, im] of (p.images ?? []).slice(0, 10).entries()) {
      const index = i + 1;
      let url;
      try { url = imageUrl(im.src); } catch { rejected.push({ index, why: 'unapproved_source' }); continue; }
      try {
        const res = await fetchImpl(url, { redirect: 'error', headers: { 'User-Agent': 'BonaPropertyPublisher/1.0' }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) { rejected.push({ index, why: `http_${res.status}` }); continue; }
        const buffer = Buffer.from(await res.arrayBuffer());
        const meta = await sharp(buffer).metadata();
        const why = frameProblem({ contentType: res.headers.get('content-type'), bytes: buffer.length, width: meta.width, height: meta.height });
        if (why) { rejected.push({ index, why, width: meta.width, height: meta.height }); continue; }
        const file = path.join(p.id, `${index}.jpg`);
        fs.mkdirSync(path.join(out, p.id), { recursive: true });
        fs.writeFileSync(path.join(out, file), buffer);
        frames.push({ index, url, sha256: sha256(buffer), width: meta.width, height: meta.height, alt: im.alt, file, buffer });
      } catch (e) { rejected.push({ index, why: `fetch_failed: ${String(e.message).slice(0, 60)}` }); }
    }
    let sheet = null;
    if (frames.length) { sheet = `${p.id}.jpg`; fs.writeFileSync(path.join(out, sheet), await contactSheet(frames)); }
    const preview = { legalDisclosures: disclosuresFor(p), photos: [{ kind: p.category === 'off-plan' ? 'render' : 'photograph' }] };
    drafts.listings[p.id] = { title: p.title, category: p.category, type: p.type ?? null, city: p.location?.city?.en ?? null,
      factsSha256: fingerprint(p), page: `${SITE}/properties/${p.slug}/`, sheet, usable: frames.length,
      frames: frames.map(({ buffer, ...f }) => f), rejected, captionPreview: captionFor(p, live.advertiser, preview) };
    log(`${p.id.padEnd(10)} ${String(frames.length).padStart(2)} usable / ${(p.images ?? []).length}  ${p.title?.en ?? ''}`);
  }
  fs.writeFileSync(path.join(out, 'drafts.json'), JSON.stringify(drafts, null, 2) + '\n');
  log(`Drafted ${listings.length} listing(s) into ${out}; nothing approved, nothing uploaded.`);
  return drafts;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
