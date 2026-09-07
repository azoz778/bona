#!/usr/bin/env node
/* domain-cutover — move the site from bona.azoz.uk to its own domain (bona.sa) and the API
   from bona-api.azoz.uk to api.<domain>, one logged step at a time, every step idempotent.

     node scripts/domain-cutover.mjs --domain bona.sa --api api.bona.sa --dry-run   # the plan, nothing changed
     node scripts/domain-cutover.mjs --domain bona.sa --api api.bona.sa             # do it
     node scripts/domain-cutover.mjs … --only dns,repo      # a subset of steps (zone,dns,repo,pages,tunnel,env,redirect)
     node scripts/domain-cutover.mjs … --skip pages         # everything but
     node scripts/domain-cutover.mjs … --offline            # dry-run without even the read-only lookups

   Before running for real the OWNER must have: registered the domain at nic.sa (Nafath), added the
   zone in the Cloudflare dashboard and changed the nameservers at nic.sa — step 1 checks and stops
   (exit 2) with those instructions if the zone is not there. The Cloudflare token comes from
   ~/.secrets/cloudflare.env (CLOUDFLARE_TOKEN), read inside Node only, never printed.

   Steps:
     1 zone      GET /zones?name=<domain> — the zone must exist and be visible to the token
     2 dns       apex A ×4 + AAAA ×4 → GitHub Pages (DNS-only), www CNAME azoz778.github.io (DNS-only),
                 <api label> CNAME <tunnel-id>.cfargotunnel.com (proxied); tunnel id from ~/.cloudflared/bona.yml
     3 repo      src/data/site.json (url, futureDomain, concierge.apiBase), public/CNAME, astro.config.mjs site,
                 public/robots.txt, services/api/lib/cors.mjs DEFAULT_ORIGINS (+ https://<domain>, https://www.<domain>)
     4 pages     gh api PUT repos/azoz778/bona/pages cname=<domain>; poll https_certificate.state; then https_enforced=true
     5 tunnel    ~/.cloudflared/bona.yml ingress hostname → <api host> (old host kept as a second entry);
                 cloudflared tunnel route dns --overwrite-dns bona <api host>
     6 env       ~/.secrets/bona-services.env BONA_PUBLIC_API / BONA_SITE via setEnvValues (never printed)
     7 redirect  Cloudflare redirect rule on the azoz.uk zone: bona.azoz.uk/* → https://<domain>/$1 (301),
                 + proxy the bona CNAME so the rule can fire; falls back to dashboard instructions on 403
     then prints the manual tail: provision.mjs, restart units, GA4 stream URL, Search Console, Meta domain,
     IndexNow, commit + push.

   --dry-run performs read-only lookups (zone, DNS records, Pages state) so the plan is concrete, prints
   every write it would make and edits nothing — not in the repo, not outside it. Node 22+, no deps. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnvFile, setEnvValues } from '../services/api/lib/env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();

export const GITHUB_PAGES_A = ['185.199.108.153', '185.199.109.153', '185.199.110.153', '185.199.111.153'];
export const GITHUB_PAGES_AAAA = ['2606:50c0:8000::153', '2606:50c0:8001::153', '2606:50c0:8002::153', '2606:50c0:8003::153'];
export const PAGES_CNAME_TARGET = 'azoz778.github.io';
export const REPO = 'azoz778/bona';
export const OLD_SITE_HOST = 'bona.azoz.uk';
export const OLD_API_HOST = 'bona-api.azoz.uk';
export const OLD_ZONE = 'azoz.uk';
export const STEPS = ['zone', 'dns', 'repo', 'pages', 'tunnel', 'env', 'redirect'];
const CF_API = 'https://api.cloudflare.com/client/v4';

/* ------------------------------------------------------------------ pure helpers (tested) */

export function parseArgs(argv) {
  const o = { dryRun: false, offline: false, only: null, skip: [], domain: null, api: null, certWaitMin: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--domain') o.domain = String(argv[++i] ?? '').toLowerCase();
    else if (a === '--api') o.api = String(argv[++i] ?? '').toLowerCase();
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--offline') { o.dryRun = true; o.offline = true; }
    else if (a === '--only') o.only = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--skip') o.skip = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--cert-wait') o.certWaitMin = Number(argv[++i]);
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (o.help) return o;
  if (!o.domain || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(o.domain)) throw new Error('--domain <apex domain> is required, e.g. --domain bona.sa');
  if (!o.api || !o.api.endsWith(`.${o.domain}`)) throw new Error(`--api must be a host under ${o.domain}, e.g. --api api.${o.domain}`);
  o.apiLabel = o.api.slice(0, -(o.domain.length + 1));
  if (!o.apiLabel || o.apiLabel.includes('.')) throw new Error(`--api must be exactly one label under ${o.domain} (Cloudflare's free certificate covers one level)`);
  for (const s of [...(o.only ?? []), ...o.skip]) if (!STEPS.includes(s)) throw new Error(`unknown step "${s}" — steps: ${STEPS.join(', ')}`);
  return o;
}

/** The DNS records the new zone must hold. */
export function desiredRecords(domain, apiLabel, tunnelId) {
  return [
    ...GITHUB_PAGES_A.map((ip) => ({ type: 'A', name: domain, content: ip, proxied: false })),
    ...GITHUB_PAGES_AAAA.map((ip) => ({ type: 'AAAA', name: domain, content: ip, proxied: false })),
    { type: 'CNAME', name: `www.${domain}`, content: PAGES_CNAME_TARGET, proxied: false },
    { type: 'CNAME', name: `${apiLabel}.${domain}`, content: `${tunnelId}.cfargotunnel.com`, proxied: true },
  ];
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/\.$/, '');

/**
 * What to create / update / delete so that `existing` (Cloudflare's list) matches `desired`.
 * Apex A/AAAA records that are not GitHub's are deleted (the apex must point at Pages only);
 * a CNAME with the right name but another target is updated in place; everything else is left alone.
 */
export function diffRecords(existing, desired) {
  const create = [];
  const update = [];
  const remove = [];
  const keep = [];
  for (const d of desired) {
    const same = existing.find((e) => e.type === d.type && norm(e.name) === norm(d.name) && norm(e.content) === norm(d.content));
    if (same) {
      if (Boolean(same.proxied) !== d.proxied) update.push({ id: same.id, ...d, reason: `proxied ${same.proxied} → ${d.proxied}` });
      else keep.push({ id: same.id, ...d });
      continue;
    }
    if (d.type === 'CNAME') {
      const other = existing.find((e) => e.type === 'CNAME' && norm(e.name) === norm(d.name));
      if (other) { update.push({ id: other.id, ...d, reason: `${other.content} → ${d.content}` }); continue; }
    }
    create.push(d);
  }
  const apex = desired.find((d) => d.type === 'A')?.name;
  for (const e of existing) {
    if ((e.type === 'A' || e.type === 'AAAA') && norm(e.name) === norm(apex)) {
      const wanted = desired.some((d) => d.type === e.type && norm(d.content) === norm(e.content));
      if (!wanted) remove.push({ id: e.id, type: e.type, name: e.name, content: e.content });
    }
  }
  return { create, update, remove, keep };
}

/** site.json edits as text replacements so the file's hand formatting survives. */
export function patchSiteJson(text, domain, apiHost) {
  const site = JSON.parse(text);
  let out = text;
  const swap = (re, replacement, what) => {
    const n = (out.match(re) ?? []).length;
    if (n !== 1) throw new Error(`site.json: expected exactly one ${what}, found ${n}`);
    out = out.replace(re, replacement);
  };
  swap(/"url":\s*"https?:\/\/[^"]+"/, `"url": "https://${domain}"`, '"url"');
  if (typeof site.futureDomain === 'string') swap(/"futureDomain":\s*"[^"]*"/, `"futureDomain": "${domain}"`, '"futureDomain"');
  if (site.concierge?.apiBase) swap(/"apiBase":\s*"https?:\/\/[^"]+"/, `"apiBase": "https://${apiHost}"`, '"apiBase"');
  JSON.parse(out); // still valid
  return out;
}

export function patchAstroConfig(text, domain) {
  const re = /site:\s*'https?:\/\/[^']+'/;
  if (!re.test(text)) throw new Error('astro.config.mjs: no site: entry found');
  return text.replace(re, `site: 'https://${domain}'`);
}

export function patchRobots(text, domain) {
  return text
    .replace(/^# https?:\/\/[^\s]+ \(future: [^)]+\)$/m, `# https://${domain}`)
    .replace(/https?:\/\/[a-z0-9.-]+\/sitemap-index\.xml/g, `https://${domain}/sitemap-index.xml`);
}

/** Add the new origins to DEFAULT_ORIGINS right after the first entry (the current site). */
export function patchCors(text, domain) {
  const add = [`https://${domain}`, `https://www.${domain}`].filter((o) => !text.includes(`'${o}'`));
  if (!add.length) return text;
  const m = text.match(/export const DEFAULT_ORIGINS = \[\n(\s*)'([^']+)',\n/);
  if (!m) throw new Error('cors.mjs: DEFAULT_ORIGINS array not found');
  const indent = m[1];
  const insert = add.map((o) => `${indent}'${o}',\n`).join('');
  return text.replace(m[0], `${m[0]}${insert}`);
}

/** New ingress: the api host first, the old host kept so nothing breaks while Retell and DNS catch up. */
export function patchTunnelConfig(text, apiHost, oldHost = OLD_API_HOST) {
  if (text.includes(`hostname: ${apiHost}\n`)) return text;
  const re = new RegExp(`(\\n\\s*- hostname: )${oldHost.replace(/\./g, '\\.')}(\\n(?:\\s{4,}.*\\n)*)`);
  const m = text.match(re);
  if (!m) throw new Error(`${oldHost} not found in the tunnel config ingress`);
  const block = m[0];
  const newBlock = block.replace(`- hostname: ${oldHost}`, `- hostname: ${apiHost}`);
  return text.replace(block, `${newBlock}${block}`);
}

export function tunnelIdFrom(text) {
  const m = String(text).match(/^tunnel:\s*([0-9a-f-]{36})\s*$/m);
  return m ? m[1] : null;
}

export function redirectRule(fromHost, toDomain) {
  return {
    description: `${fromHost} → ${toDomain} (domain cutover)`,
    expression: `(http.host eq "${fromHost}")`,
    action: 'redirect',
    action_parameters: {
      from_value: {
        status_code: 301,
        target_url: { expression: `concat("https://${toDomain}", http.request.uri.path)` },
        preserve_query_string: true,
      },
    },
    enabled: true,
  };
}

/* ------------------------------------------------------------------ side-effect helpers */

const log = (s = '') => console.log(s);
const say = (n, title) => log(`\n== ${n}. ${title}`);
const ok = (s) => log(`   ok   ${s}`);
const plan = (s) => log(`   plan ${s}`);
const skip = (s) => log(`   skip ${s}`);
const warn = (s) => log(`   !    ${s}`);

async function cf(token, method, url, body) {
  const res = await fetch(url.startsWith('http') ? url : `${CF_API}${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, ok: res.ok && json?.success !== false, json };
}

const cfError = (r) => (r.json?.errors ?? []).map((e) => `${e.code} ${e.message}`).join('; ') || `HTTP ${r.status}`;

function gh(args, { dryRun } = {}) {
  if (dryRun) { plan(`gh ${args.join(' ')}`); return { ok: true, dry: true, out: '' }; }
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ steps */

export async function run(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.help) { log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\* ?/, '')); return 0; }
  const active = (s) => (o.only ? o.only.includes(s) : true) && !o.skip.includes(s);
  const DRY = o.dryRun;
  const domain = o.domain;
  const apiHost = o.api;
  const siteUrl = `https://${domain}`;
  const apiUrl = `https://${apiHost}`;

  const cfEnv = loadEnvFile(path.join(HOME, '.secrets', 'cloudflare.env'));
  const token = cfEnv.CLOUDFLARE_TOKEN || cfEnv.CLOUDFLARE_API_TOKEN || cfEnv.CF_API_TOKEN || '';
  const tunnelFile = path.join(HOME, '.cloudflared', 'bona.yml');
  const tunnelText = fs.existsSync(tunnelFile) ? fs.readFileSync(tunnelFile, 'utf8') : '';
  const tunnelId = tunnelIdFrom(tunnelText);

  log(`domain-cutover ${OLD_SITE_HOST} → ${domain} · ${OLD_API_HOST} → ${apiHost}${DRY ? o.offline ? '  [offline dry-run]' : '  [dry-run: read-only lookups, no writes]' : ''}`);
  log(`   token ${token ? 'present' : 'MISSING'} in ~/.secrets/cloudflare.env · tunnel id ${tunnelId ?? 'not found in ~/.cloudflared/bona.yml'}`);
  if (!token && !o.offline) { warn('no CLOUDFLARE_TOKEN — Cloudflare steps will only be printed'); }
  const canRead = Boolean(token) && !o.offline;
  let exitCode = 0;

  /* 1. zone --------------------------------------------------------------- */
  let zoneId = null;
  if (active('zone')) {
    say(1, `Cloudflare zone ${domain}`);
    if (canRead) {
      const r = await cf(token, 'GET', `/zones?name=${encodeURIComponent(domain)}`);
      if (r.ok && r.json.result?.length) {
        zoneId = r.json.result[0].id;
        ok(`zone ${domain} found (${zoneId}, status ${r.json.result[0].status})`);
        if (r.json.result[0].status !== 'active') warn(`zone is "${r.json.result[0].status}" — the nameservers at nic.sa are not pointed at Cloudflare yet: ${(r.json.result[0].name_servers ?? []).join(', ')}`);
      } else {
        warn(r.ok ? `zone ${domain} is not visible to this token` : `zone lookup failed: ${cfError(r)}`);
        log(printOwnerZoneSteps(domain));
        if (!DRY) return 2;
        warn('(for real this stops here with exit 2; the dry-run goes on with <zone-id> placeholders)');
      }
    } else {
      plan(`GET ${CF_API}/zones?name=${domain}  → zone id`);
      log(printOwnerZoneSteps(domain));
    }
  }
  const Z = zoneId ?? '<zone-id>';

  /* 2. dns ---------------------------------------------------------------- */
  if (active('dns')) {
    say(2, `DNS records in ${domain}`);
    if (!tunnelId) { warn('tunnel id unknown — the api CNAME cannot be planned; run services/deploy/install.sh first'); }
    const desired = desiredRecords(domain, o.apiLabel, tunnelId ?? '<tunnel-id>');
    let existing = [];
    if (canRead && zoneId) {
      const r = await cf(token, 'GET', `/zones/${zoneId}/dns_records?per_page=500`);
      if (r.ok) existing = r.json.result ?? [];
      else warn(`could not list records: ${cfError(r)}`);
    }
    const d = diffRecords(existing, desired);
    for (const k of d.keep) ok(`${k.type.padEnd(5)} ${k.name} → ${k.content} (${k.proxied ? 'proxied' : 'DNS only'}) already there`);
    for (const c of d.create) {
      const line = `POST /zones/${Z}/dns_records ${c.type} ${c.name} → ${c.content} ${c.proxied ? 'proxied' : 'DNS only'}`;
      if (DRY || !zoneId) { plan(line); continue; }
      const r = await cf(token, 'POST', `/zones/${zoneId}/dns_records`, { ...c, ttl: 1 });
      r.ok ? ok(line) : warn(`${line} — ${cfError(r)}`);
    }
    for (const u of d.update) {
      const line = `PATCH /zones/${Z}/dns_records/${u.id} ${u.type} ${u.name} (${u.reason})`;
      if (DRY || !zoneId) { plan(line); continue; }
      const r = await cf(token, 'PATCH', `/zones/${zoneId}/dns_records/${u.id}`, { type: u.type, name: u.name, content: u.content, proxied: u.proxied, ttl: 1 });
      r.ok ? ok(line) : warn(`${line} — ${cfError(r)}`);
    }
    for (const x of d.remove) {
      const line = `DELETE /zones/${Z}/dns_records/${x.id} (${x.type} ${x.name} → ${x.content} is not GitHub Pages)`;
      if (DRY || !zoneId) { plan(line); continue; }
      const r = await cf(token, 'DELETE', `/zones/${zoneId}/dns_records/${x.id}`);
      r.ok ? ok(line) : warn(`${line} — ${cfError(r)}`);
    }
    if (!canRead || !zoneId) plan('(records listed above are the full desired set; existing ones are skipped when the zone can be read)');
  }

  /* 3. repo --------------------------------------------------------------- */
  if (active('repo')) {
    say(3, 'Repository edits');
    const edits = [
      ['src/data/site.json', (t) => patchSiteJson(t, domain, apiHost)],
      ['public/CNAME', () => `${domain}\n`],
      ['astro.config.mjs', (t) => patchAstroConfig(t, domain)],
      ['public/robots.txt', (t) => patchRobots(t, domain)],
      ['services/api/lib/cors.mjs', (t) => patchCors(t, domain)],
    ];
    for (const [rel, fn] of edits) {
      const file = path.join(root, rel);
      const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      let after;
      try { after = fn(before); } catch (err) { warn(`${rel}: ${err.message}`); continue; }
      if (after === before) { ok(`${rel} already up to date`); continue; }
      const was = new Set(before.split('\n'));
      const changed = after.split('\n').filter((l) => !was.has(l)).slice(0, 4).map((l) => l.trim());
      if (DRY) { plan(`edit ${rel}: ${changed.join(' | ')}`); continue; }
      fs.writeFileSync(file, after);
      ok(`edited ${rel}: ${changed.join(' | ')}`);
    }
    plan(`afterwards: git -C ${root} diff · commit "site: cutover to ${domain}" · push (the deploy publishes the new CNAME and sitemap)`);
  }

  /* 4. pages -------------------------------------------------------------- */
  if (active('pages')) {
    say(4, `GitHub Pages custom domain ${domain}`);
    let state = null;
    if (!o.offline) {
      const cur = gh(['api', `repos/${REPO}/pages`, '--jq', '{cname:.cname,https_enforced:.https_enforced,cert:.https_certificate.state}']);
      if (cur.ok) { try { state = JSON.parse(cur.out); } catch { /* ignore */ } }
      if (state) ok(`current: cname ${state.cname}, https_enforced ${state.https_enforced}, certificate ${state.cert}`);
      else warn(`gh api repos/${REPO}/pages failed: ${cur.err || 'not logged in?'}`);
    }
    if (state?.cname === domain) ok(`custom domain already ${domain}`);
    else {
      const r = gh(['api', '-X', 'PUT', `repos/${REPO}/pages`, '-f', `cname=${domain}`], { dryRun: DRY });
      if (!DRY) r.ok ? ok(`custom domain set to ${domain}`) : warn(`setting the domain failed: ${r.err}`);
    }
    if (DRY) {
      plan(`poll gh api repos/${REPO}/pages --jq .https_certificate.state until "approved" (up to ${o.certWaitMin} min)`);
      plan(`gh api -X PUT repos/${REPO}/pages -F https_enforced=true`);
    } else {
      const deadline = Date.now() + o.certWaitMin * 60_000;
      let cert = state?.cert;
      while (cert !== 'approved' && Date.now() < deadline) {
        await sleep(20_000);
        const p = gh(['api', `repos/${REPO}/pages`, '--jq', '.https_certificate.state']);
        cert = p.ok ? p.out : cert;
        log(`   …    certificate ${cert}`);
      }
      if (cert === 'approved') {
        const r = gh(['api', '-X', 'PUT', `repos/${REPO}/pages`, '-F', 'https_enforced=true']);
        r.ok ? ok('HTTPS enforced') : warn(`https_enforced failed: ${r.err}`);
      } else {
        warn(`certificate still "${cert}" — DNS may not have propagated; re-run with --only pages later`);
      }
    }
  }

  /* 5. tunnel ------------------------------------------------------------- */
  if (active('tunnel')) {
    say(5, `Tunnel ingress → ${apiHost}`);
    if (!tunnelText) warn(`${tunnelFile} not found — run services/deploy/install.sh first`);
    else {
      let after;
      try { after = patchTunnelConfig(tunnelText, apiHost); } catch (err) { after = null; warn(err.message); }
      if (after === tunnelText) ok(`${tunnelFile} already routes ${apiHost}`);
      else if (after) {
        if (DRY) plan(`edit ${tunnelFile}: add "- hostname: ${apiHost}" ingress before ${OLD_API_HOST} (both → localhost:4102)`);
        else { fs.writeFileSync(tunnelFile, after); ok(`${tunnelFile} updated (old host kept as a second ingress)`); }
      }
    }
    const cmd = ['--config', tunnelFile, 'tunnel', 'route', 'dns', '--overwrite-dns', 'bona', apiHost];
    if (DRY) plan(`cloudflared ${cmd.join(' ')}`);
    else {
      const bin = process.env.CLOUDFLARED || (fs.existsSync(path.join(HOME, '.local/bin/cloudflared')) ? path.join(HOME, '.local/bin/cloudflared') : 'cloudflared');
      const r = spawnSync(bin, cmd, { encoding: 'utf8' });
      r.status === 0 ? ok(`route dns ${apiHost} → tunnel bona`) : warn(`route dns failed: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
    }
    plan(`re-running install.sh later must use: BONA_API_HOSTNAME=${apiHost} bash services/deploy/install.sh`);
  }

  /* 6. env ---------------------------------------------------------------- */
  if (active('env')) {
    say(6, '~/.secrets/bona-services.env');
    const file = path.join(HOME, '.secrets', 'bona-services.env');
    const updates = { BONA_PUBLIC_API: apiUrl, BONA_SITE: siteUrl };
    const current = loadEnvFile(file);
    const pending = Object.entries(updates).filter(([k, v]) => current[k] !== v);
    if (!pending.length) ok('BONA_PUBLIC_API and BONA_SITE already set');
    else if (DRY) plan(`setEnvValues(${file}, { ${pending.map(([k, v]) => `${k}=${v}`).join(', ')} })`);
    else { const r = setEnvValues(file, Object.fromEntries(pending)); ok(`updated ${r.replaced.concat(r.appended).join(', ')} in ${file}`); }
  }

  /* 7. redirect ----------------------------------------------------------- */
  if (active('redirect')) {
    say(7, `Redirect ${OLD_SITE_HOST}/* → ${siteUrl}/$1 (301) on the ${OLD_ZONE} zone`);
    const rule = redirectRule(OLD_SITE_HOST, domain);
    let done = false;
    if (canRead) {
      const z = await cf(token, 'GET', `/zones?name=${OLD_ZONE}`);
      const oldZone = z.ok ? z.json.result?.[0]?.id : null;
      if (!oldZone) warn(`zone ${OLD_ZONE} not visible to this token (${z.ok ? 'zone-scoped token' : cfError(z)})`);
      else {
        // The bona CNAME must be proxied for an edge rule to fire (it is DNS-only today so GitHub could issue its cert).
        const rec = await cf(token, 'GET', `/zones/${oldZone}/dns_records?name=${OLD_SITE_HOST}`);
        const cname = rec.ok ? rec.json.result?.find((r) => r.type === 'CNAME') : null;
        if (cname && !cname.proxied) {
          if (DRY) plan(`PATCH /zones/${oldZone}/dns_records/${cname.id} {proxied:true}`);
          else { const p = await cf(token, 'PATCH', `/zones/${oldZone}/dns_records/${cname.id}`, { proxied: true }); p.ok ? ok(`${OLD_SITE_HOST} CNAME now proxied`) : warn(`proxying failed: ${cfError(p)}`); }
        } else if (cname) ok(`${OLD_SITE_HOST} CNAME already proxied`);
        const ep = await cf(token, 'GET', `/zones/${oldZone}/rulesets/phases/http_request_dynamic_redirect/entrypoint`);
        const existingRule = ep.ok ? (ep.json.result?.rules ?? []).find((r) => r.description === rule.description) : null;
        if (existingRule) { ok('redirect rule already present'); done = true; }
        else if (DRY) { plan(ep.ok ? `POST /zones/${oldZone}/rulesets/${ep.json.result.id}/rules ${JSON.stringify(rule)}` : `POST /zones/${oldZone}/rulesets {kind:zone, phase:http_request_dynamic_redirect, rules:[${JSON.stringify(rule)}]}`); done = true; }
        else {
          const r = ep.ok
            ? await cf(token, 'POST', `/zones/${oldZone}/rulesets/${ep.json.result.id}/rules`, rule)
            : await cf(token, 'POST', `/zones/${oldZone}/rulesets`, { name: 'default', kind: 'zone', phase: 'http_request_dynamic_redirect', rules: [rule] });
          if (r.ok) { ok('redirect rule created'); done = true; } else warn(`Rulesets API refused (${cfError(r)}) — do it in the dashboard:`);
        }
      }
    } else plan(`GET /zones?name=${OLD_ZONE} → PATCH the ${OLD_SITE_HOST} CNAME to proxied → POST redirect rule ${JSON.stringify(rule.expression)}`);
    if (!done) log(printRedirectSteps(domain));
  }

  /* tail ------------------------------------------------------------------ */
  log(`\n== Remaining manual steps (owner)`);
  log([
    `   1. Review and push the repo edits:  git -C ${root} diff && git commit -am "site: cutover to ${domain}" && git push`,
    `   2. node ${root}/services/api/retell/provision.mjs      # Retell tools + webhook move to ${apiUrl}`,
    `   3. systemctl --user restart bona-api cloudflared-bona   # picks up BONA_SITE / BONA_PUBLIC_API and the new ingress`,
    `   4. curl -s ${apiUrl}/health · curl -sI ${siteUrl}/ · curl -sI https://${OLD_SITE_HOST}/ (expect 301)`,
    `   5. GA4: Admin › Data streams › "Bona web" › edit the stream URL to ${siteUrl}`,
    `   6. Search Console: add the URL-prefix property ${siteUrl}/ (same meta tag) and submit ${siteUrl}/sitemap-index.xml`,
    `   7. Meta: Business settings › Brand safety › Domains › add ${domain} and verify (docs/checklists/meta-bona-portfolio.md §10)`,
    `   8. SITE_URL=${siteUrl} node ${root}/scripts/indexnow.mjs   # after the deploy`,
    `   9. Instagram bio link, WhatsApp Business profile website, Google Business Profile website → ${siteUrl}`,
    `  10. Uptime Kuma: add monitors for ${siteUrl}/ and ${apiUrl}/health`,
  ].join('\n'));
  return exitCode;
}

function printOwnerZoneSteps(domain) {
  return [
    `   Owner steps before this script can continue:`,
    `     a. Register ${domain} at https://nic.sa (log in with Nafath; a Saudi individual with a national ID may register a .sa;`,
    `        .com.sa needs a CR / trade name). Pay; the domain shows under "My domains".`,
    `     b. Cloudflare dashboard → Add a site → ${domain} → Free plan → Cloudflare lists two nameservers.`,
    `     c. nic.sa → the domain → Nameservers → replace with the two Cloudflare nameservers → save. Propagation up to 24 h;`,
    `        the zone turns "Active" in Cloudflare.`,
    `     d. The token in ~/.secrets/cloudflare.env must be allowed to read and edit DNS on ${domain} (and, for the redirect,`,
    `        on ${OLD_ZONE}): Cloudflare → My profile → API tokens → edit the token → Zone Resources: include both zones,`,
    `        permissions Zone:Read, DNS:Edit, Zone Settings:Read, and "Zone → Dynamic Redirect: Edit" for the rule.`,
    `     Then re-run this script.`,
  ].join('\n');
}

function printRedirectSteps(domain) {
  return [
    `   Dashboard steps for the redirect (2 min):`,
    `     a. Cloudflare → ${OLD_ZONE} → DNS → the CNAME "bona" → turn the cloud orange (Proxied) → Save.`,
    `     b. ${OLD_ZONE} → Rules → Redirect Rules → Create rule → name "bona.azoz.uk → ${domain}" →`,
    `        Custom filter expression: Hostname equals bona.azoz.uk → Then… Dynamic →`,
    `        Expression: concat("https://${domain}", http.request.uri.path) → Status code 301 → tick Preserve query string → Deploy.`,
    `     c. curl -sI https://${OLD_SITE_HOST}/ar/ → Location: https://${domain}/ar/`,
  ].join('\n');
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  run().then((code) => { process.exitCode = code; }).catch((err) => { console.error(`domain-cutover: ${err?.message ?? err}`); process.exitCode = 1; });
}
