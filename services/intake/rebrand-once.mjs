#!/usr/bin/env node
// Build ONE Bona-branded brochure from a local PDF, with no WhatsApp and no repo involved.
//
//   node services/intake/rebrand-once.mjs <src.pdf> <listing.json> <out.pdf> [options]
//     --max-mb <n>     size cap for the output (default $BONA_MAX_BROCHURE_MB, else 25)
//     --site <url>     the site the listing URL and the QR point at (default $BONA_SITE)
//     --work <path>    where the facts JSON is written (default: next to <out.pdf>)
//     --json           print the raw result JSON instead of the human summary
//
// `<listing.json>` is either a full listing (`scripts/curate/inbox/<slug>.json`) or a bare
// facts object — `{ id, titleEn, titleAr, place, priceEn, project, developer, url }`.
//
// This is the loop to use when changing anything in rebrand_pdf.py: it runs the exact same
// code path the daemon does, so what comes out here is what the owner will get.
import fs from 'node:fs';
import path from 'node:path';
import { brochureFacts, buildBrandedBrochure } from './lib/brochure.mjs';
import { loadConfig } from './lib/env.mjs';
import { say } from './lib/log.mjs';

function parseArgs(argv) {
  const out = { flags: new Set(), opts: {}, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.flags.add('json');
    else if (a.startsWith('--')) { out.opts[a.slice(2)] = argv[i + 1]; i += 1; }
    else out.positional.push(a);
  }
  return out;
}

async function main() {
  const { flags, opts, positional } = parseArgs(process.argv.slice(2));
  const [src, listingFile, out] = positional;
  if (!src || !listingFile || !out) {
    say('usage: node services/intake/rebrand-once.mjs <src.pdf> <listing.json> <out.pdf> [--max-mb 25] [--site https://…] [--work dir] [--json]');
    process.exit(2);
  }
  for (const file of [src, listingFile]) {
    if (!fs.existsSync(file)) { say(`no such file: ${file}`); process.exit(2); }
  }

  const base = loadConfig();
  const cfg = {
    ...base,
    site: opts.site || base.site,
    maxBrochureMb: opts['max-mb'] ? Number(opts['max-mb']) : base.maxBrochureMb,
  };
  const listing = JSON.parse(fs.readFileSync(listingFile, 'utf8'));
  const workDir = opts.work || path.dirname(path.resolve(out));

  const started = Date.now();
  const result = await buildBrandedBrochure({ pdfPath: src, listing, outPath: out, workDir, cfg });
  if (flags.has('json')) {
    say(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
  say('');
  say('══ Bona brochure ════════════════════════════════════════════');
  say(`source     ${src}`);
  say(`           ${mb(fs.statSync(src).size)}`);
  if (!result.ok) {
    say(`FAILED     ${result.reason}: ${result.error}`);
    process.exit(1);
  }
  const facts = result.facts || brochureFacts(listing, { site: cfg.site });
  say(`output     ${result.out}`);
  say(`           ${mb(result.bytes)} · ${result.pages} pages (${result.srcPages} + cover + enquire) · cap ${mb(result.maxBytes)}`);
  say(`           ${((result.bytes / result.srcBytes) * 100).toFixed(0)}% of the original`);
  say(`steps      ${(result.steps || []).join(' → ')}`);
  say('');
  say('── Printed on the Bona pages ────────────────────────────────');
  say(`id         ${facts.id ?? '—'}`);
  say(`EN         ${facts.titleEn ?? '—'}`);
  say(`AR         ${facts.titleAr ?? '—'}`);
  say(`place      ${facts.place ?? '—'}`);
  say(`price      ${facts.priceEn ?? '—'}`);
  say(`project    ${[facts.project, facts.developer].filter(Boolean).join(' · ') || '—'}`);
  say(`url / QR   ${facts.url}`);
  if (result.scrubbed?.length) {
    say('');
    say(`⚠️  left off (contact detail or another agency): ${result.scrubbed.join(', ')}`);
  }
  say('');
  say(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  say('');
}

main().catch((err) => { say(`failed: ${err.message}`); process.exit(1); });
