#!/usr/bin/env node
/* IndexNow submitter — pushes every URL from the built sitemap to https://api.indexnow.org/indexnow
   (Bing, Yandex, Seznam, Naver share the endpoint; Google does not use IndexNow).
   Usage:
     node scripts/indexnow.mjs                  # auto-detects dist/ or .builds/<x>/
     node scripts/indexnow.mjs --dir dist       # explicit build dir
     node scripts/indexnow.mjs --dry-run        # print the request(s) instead of sending
     node scripts/indexnow.mjs --only /properties/foo/,/ar/properties/foo/   # subset
   Key: site.indexNowKey (src/data/site.json) — the key file public/<key>.txt is served at the site root.
   Exit code is always 0 (non-fatal in CI); failures are printed. Node 22+, no dependencies. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const site = JSON.parse(fs.readFileSync(path.join(root, 'src/data/site.json'), 'utf8'));
const key = process.env.INDEXNOW_KEY || site.indexNowKey;
const origin = (process.env.SITE_URL || site.url).replace(/\/$/, '');
const host = new URL(origin).host;
const endpoint = 'https://api.indexnow.org/indexnow';
const dryRun = flag('--dry-run');

function findBuildDir() {
  const explicit = opt('--dir');
  if (explicit) return path.resolve(root, explicit);
  const dist = path.join(root, 'dist');
  if (fs.existsSync(path.join(dist, 'sitemap-index.xml'))) return dist;
  const builds = path.join(root, '.builds');
  if (fs.existsSync(builds)) {
    const cands = fs.readdirSync(builds).map((d) => path.join(builds, d)).filter((d) => fs.existsSync(path.join(d, 'sitemap-index.xml')))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (cands[0]) return cands[0];
  }
  return dist;
}

function locsFrom(xml) { return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].trim()); }
function localFileFor(url, dir) {
  const p = new URL(url).pathname;
  return path.join(dir, decodeURIComponent(p));
}

async function main() {
  if (!key || key.length < 8) { console.error('indexnow: no key configured (site.indexNowKey)'); return; }
  const dir = findBuildDir();
  const indexFile = path.join(dir, 'sitemap-index.xml');
  if (!fs.existsSync(indexFile)) { console.error(`indexnow: ${indexFile} not found — build first`); return; }
  const children = locsFrom(fs.readFileSync(indexFile, 'utf8'));
  let urls = [];
  for (const child of children) {
    const f = localFileFor(child, dir);
    if (!fs.existsSync(f)) { console.warn(`indexnow: child sitemap missing locally: ${f}`); continue; }
    urls.push(...locsFrom(fs.readFileSync(f, 'utf8')));
  }
  urls = [...new Set(urls)].filter((u) => !u.includes('/dashboard/'));
  // Re-home URLs on the configured origin (lets SITE_URL override the sitemap host after a domain move)
  urls = urls.map((u) => { try { const x = new URL(u); return origin + x.pathname + x.search; } catch { return u; } });
  const only = opt('--only');
  if (only) { const set = new Set(only.split(',').map((p) => origin + (p.startsWith('/') ? p : '/' + p))); urls = urls.filter((u) => set.has(u)); }
  if (!urls.length) { console.error('indexnow: no URLs found'); return; }

  const batches = [];
  for (let i = 0; i < urls.length; i += 10000) batches.push(urls.slice(i, i + 10000));
  console.log(`indexnow: ${urls.length} URL(s) from ${path.relative(root, dir)} → ${host} (${batches.length} batch${batches.length > 1 ? 'es' : ''})${dryRun ? ' [dry-run]' : ''}`);

  for (const [i, urlList] of batches.entries()) {
    const body = { host, key, keyLocation: `${origin}/${key}.txt`, urlList };
    if (dryRun) {
      console.log(`POST ${endpoint}\nContent-Type: application/json; charset=utf-8\n${JSON.stringify({ ...body, urlList: urlList.slice(0, 5).concat(urlList.length > 5 ? [`… +${urlList.length - 5} more`] : []) }, null, 2)}`);
      continue;
    }
    try {
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      const text = await res.text().catch(() => '');
      const meaning = { 200: 'OK', 202: 'Accepted (key validation pending)', 400: 'Bad request', 403: 'Forbidden — key file not found or mismatched', 422: 'Unprocessable — URLs not on host / key mismatch', 429: 'Too many requests' }[res.status] || '';
      console.log(`indexnow: batch ${i + 1} → HTTP ${res.status} ${meaning} ${text.slice(0, 200)}`.trim());
    } catch (e) {
      console.error(`indexnow: batch ${i + 1} failed: ${e.message}`);
    }
  }
}

main().catch((e) => console.error('indexnow: unexpected error', e?.message || e)).finally(() => process.exit(0));
