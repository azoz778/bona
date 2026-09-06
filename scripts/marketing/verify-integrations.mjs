#!/usr/bin/env node
/* verify-integrations — probes every marketing / tracking integration Bona depends on and
   writes the result into src/data/integrations.json (the dashboard's Integrations board).

     node scripts/marketing/verify-integrations.mjs             # probe, print, update the board
     node scripts/marketing/verify-integrations.mjs --dry-run   # no network, no file write: show what would be checked
     node scripts/marketing/verify-integrations.mjs --no-write  # probe and print only
     node scripts/marketing/verify-integrations.mjs --json      # machine-readable result on stdout

   Secrets come from ~/.secrets/*.env through services/api/lib/env.mjs and are never printed —
   only "present" / "empty". Public ids come from src/data/site.json → analytics.

   Checks (id → what "live" means):
     ga4        GA4_MEASUREMENT_ID + GA4_API_SECRET accepted by the Measurement Protocol debug endpoint
     meta-capi  META_PIXEL_ID + META_CAPI_TOKEN: a PageView test event reaches the dataset (test code)
                or, without a test code, the token can read the dataset
     meta-pixel site.json carries analytics.metaPixel and the live home page serves it
     snap       SNAP_PIXEL_ID + SNAP_CAPI_TOKEN accepted by Snap's /events/validate (+ site tag)
     gsc        the live home page carries <meta name="google-site-verification">
     bona-api   ${site.concierge.apiBase}/health answers ok
     retell     that /health says retell: "ok"
     evolution  EVOLUTION_API_URL answers (the WhatsApp poller's source)

   Statuses written: live | pending-owner (a key or id is missing — a checklist tells the owner
   what to do) | error (configured but the probe failed). Exit code is 0 unless --strict, which
   exits 1 when any row is "error". Node 22+, no dependencies. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../../services/api/lib/env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const DRY = flag('--dry-run');
const WRITE = !DRY && !flag('--no-write');
const JSON_OUT = flag('--json');
const STRICT = flag('--strict');
const TIMEOUT_MS = 10_000;
const UA = 'bona-verify-integrations/1.0 (+https://bona.azoz.uk)';

const SITE_FILE = path.join(root, 'src/data/site.json');
const BOARD_FILE = path.join(root, 'src/data/integrations.json');

/* ------------------------------------------------------------------ helpers */

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const present = (v) => typeof v === 'string' && v.trim().length > 0;
const trimSlash = (s) => String(s ?? '').replace(/\/+$/, '');

/** fetch with a timeout; returns { status, text, json } and never throws. */
async function probe(url, init = {}) {
  if (DRY) return { dry: true, url, method: init.method ?? 'GET' };
  try {
    const res = await fetch(url, {
      ...init,
      headers: { 'User-Agent': UA, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, ok: res.ok, text, json };
  } catch (err) {
    return { status: 0, ok: false, text: '', json: null, error: err?.message ?? String(err) };
  }
}

/** Strip anything that looks like a secret or token from a message before it is printed. */
function scrub(message, secrets) {
  let out = String(message ?? '');
  for (const s of secrets) if (present(s)) out = out.split(s).join('<redacted>');
  return out.replace(/access_token=[^&\s"]+/gi, 'access_token=<redacted>').slice(0, 300);
}

const row = (id, status, detail, extra = {}) => ({ id, status, detail: scrub(detail, extra.secrets ?? []), ...extra.fields });

/* ------------------------------------------------------------------ checks */

export async function checkGa4({ env, site, homeHtml }) {
  const mid = env.GA4_MEASUREMENT_ID;
  const secret = env.GA4_API_SECRET;
  const siteId = site.analytics?.ga4;
  const siteNote = present(siteId)
    ? (homeHtml == null ? `site tag ${siteId} in site.json` : homeHtml.includes(siteId) ? `site tag ${siteId} served` : `site tag ${siteId} in site.json but NOT on the live page (deploy pending?)`)
    : 'site tag missing: site.json → analytics.ga4';
  if (!present(mid) || !present(secret)) {
    return row('ga4', 'pending-owner', `GA4_MEASUREMENT_ID ${present(mid) ? 'present' : 'empty'}, GA4_API_SECRET ${present(secret) ? 'present' : 'empty'} in ~/.secrets/bona-marketing.env — docs/checklists/google-bona.md §1. ${siteNote}`);
  }
  const url = `https://www.google-analytics.com/debug/mp/collect?measurement_id=${encodeURIComponent(mid)}&api_secret=${encodeURIComponent(secret)}`;
  const res = await probe(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: 'verify.1', non_personalized_ads: true, events: [{ name: 'verify_ping', params: { engagement_time_msec: 1 } }] }),
  });
  if (res.dry) return row('ga4', 'pending-owner', `[dry-run] would POST ${url.replace(/api_secret=[^&]+/, 'api_secret=<redacted>')}. ${siteNote}`, { secrets: [secret] });
  if (res.status !== 200) return row('ga4', 'error', `debug/mp/collect HTTP ${res.status} ${res.error ?? res.text}`, { secrets: [secret] });
  const messages = Array.isArray(res.json?.validationMessages) ? res.json.validationMessages : [];
  if (messages.length) return row('ga4', 'error', `Measurement Protocol rejected the test event: ${messages.map((m) => `${m.validationCode ?? ''} ${m.description ?? ''}`.trim()).join('; ')}`, { secrets: [secret] });
  const status = present(siteId) && (homeHtml == null || homeHtml.includes(siteId)) ? 'live' : 'error';
  return row('ga4', status, `Measurement Protocol accepted a test event for ${mid}. ${siteNote}`, { secrets: [secret] });
}

export async function checkMetaCapi({ env, site }) {
  const pixel = env.META_PIXEL_ID;
  const token = env.META_CAPI_TOKEN;
  const testCode = env.META_TEST_EVENT_CODE;
  if (!present(pixel) || !present(token)) {
    return row('meta-capi', 'pending-owner', `META_PIXEL_ID ${present(pixel) ? 'present' : 'empty'}, META_CAPI_TOKEN ${present(token) ? 'present' : 'empty'} in ~/.secrets/bona-marketing.env — docs/checklists/meta-bona-portfolio.md §4–6`);
  }
  if (present(testCode)) {
    const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(pixel)}/events`;
    const body = {
      data: [{
        event_name: 'PageView',
        event_time: Math.floor(Date.now() / 1000),
        event_id: `verify-${Date.now()}`,
        action_source: 'website',
        event_source_url: `${trimSlash(site.url)}/`,
        user_data: { client_user_agent: UA },
      }],
      test_event_code: testCode,
      access_token: token,
    };
    const res = await probe(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.dry) return row('meta-capi', 'pending-owner', `[dry-run] would POST ${url} with one PageView test event (test_event_code present)`, { secrets: [token] });
    if (res.status === 200 && res.json?.events_received >= 1) {
      return row('meta-capi', 'live', `dataset ${pixel} received a PageView test event (test_event_code set — empty it once events show in Events Manager)`, { secrets: [token, testCode] });
    }
    return row('meta-capi', 'error', `POST /${pixel}/events HTTP ${res.status}: ${res.json?.error?.message ?? res.error ?? res.text}`, { secrets: [token, testCode] });
  }
  const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(pixel)}?fields=name,id&access_token=${encodeURIComponent(token)}`;
  const res = await probe(url);
  if (res.dry) return row('meta-capi', 'pending-owner', `[dry-run] would GET /v21.0/${pixel}?fields=name (no test_event_code set)`, { secrets: [token] });
  if (res.status === 200 && res.json?.id) return row('meta-capi', 'live', `token can read dataset ${pixel} ("${res.json.name ?? ''}"); set META_TEST_EVENT_CODE to also fire a test event`, { secrets: [token] });
  return row('meta-capi', 'error', `GET /${pixel} HTTP ${res.status}: ${res.json?.error?.message ?? res.error ?? res.text}`, { secrets: [token] });
}

export function checkSiteTag({ id, label, value, homeHtml, checklist, siteKey }) {
  if (!present(value)) return row(id, 'pending-owner', `${label} id missing: site.json → analytics.${siteKey} — ${checklist}`);
  if (homeHtml == null) return row(id, DRY ? 'pending-owner' : 'error', `${DRY ? '[dry-run] ' : ''}site.json carries ${label} ${value}; live page not fetched`);
  if (homeHtml.includes(value)) return row(id, 'live', `${label} ${value} is served by the live site (loads after consent)`);
  return row(id, 'error', `${label} ${value} is in site.json but the live home page does not serve it — deploy pending, or Head.astro not wired`);
}

export async function checkSnap({ env, site, homeHtml }) {
  const pixel = env.SNAP_PIXEL_ID;
  const token = env.SNAP_CAPI_TOKEN;
  const siteId = site.analytics?.snapPixel;
  const siteNote = present(siteId)
    ? (homeHtml == null ? `site tag ${siteId} in site.json` : homeHtml.includes(siteId) ? 'site tag served' : `site tag ${siteId} in site.json but NOT on the live page`)
    : 'site tag missing: site.json → analytics.snapPixel';
  if (!present(pixel) || !present(token)) {
    return row('snap', 'pending-owner', `SNAP_PIXEL_ID ${present(pixel) ? 'present' : 'empty'}, SNAP_CAPI_TOKEN ${present(token) ? 'present' : 'empty'} in ~/.secrets/bona-marketing.env — docs/checklists/snapchat-bona.md. ${siteNote}`);
  }
  const url = `https://tr.snapchat.com/v3/${encodeURIComponent(pixel)}/events/validate`;
  const body = {
    data: [{
      event_name: 'PAGE_VIEW',
      action_source: 'WEB',
      event_time: Date.now(),
      event_id: `verify-${Date.now()}`,
      event_source_url: `${trimSlash(site.url)}/`,
      user_data: { client_user_agent: UA },
    }],
  };
  const res = await probe(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  if (res.dry) return row('snap', 'pending-owner', `[dry-run] would POST ${url} with one PAGE_VIEW (Bearer token). ${siteNote}`, { secrets: [token] });
  if (res.status === 200 && !(res.json?.status === 'FAILED' || res.json?.reason)) {
    const status = present(siteId) && (homeHtml == null || homeHtml.includes(siteId)) ? 'live' : 'error';
    return row('snap', status, `Snap validated a PAGE_VIEW for pixel ${pixel}. ${siteNote}`, { secrets: [token] });
  }
  return row('snap', 'error', `POST /v3/${pixel}/events/validate HTTP ${res.status}: ${res.json?.reason ?? res.json?.status ?? res.error ?? res.text}`, { secrets: [token] });
}

export function checkGsc({ site, homeHtml }) {
  const expected = site.analytics?.gscVerification;
  if (homeHtml == null) {
    return row('gsc', present(expected) ? 'error' : 'pending-owner', `${DRY ? '[dry-run] ' : ''}live page not fetched; site.json → analytics.gscVerification ${present(expected) ? 'present' : 'missing'} — docs/checklists/google-bona.md §2`);
  }
  const m = homeHtml.match(/<meta[^>]+name=["']google-site-verification["'][^>]*content=["']([^"']+)["']/i)
    ?? homeHtml.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']google-site-verification["']/i);
  if (!m) return row('gsc', 'pending-owner', `no google-site-verification meta on ${trimSlash(site.url)}/ — paste the HTML-tag content into site.json → analytics.gscVerification (docs/checklists/google-bona.md §2)`);
  if (present(expected) && m[1] !== expected) return row('gsc', 'error', `live page serves a google-site-verification tag that differs from site.json (deploy pending?)`);
  return row('gsc', 'live', `google-site-verification tag served (${m[1].slice(0, 6)}…) — verify + submit sitemap-index.xml in Search Console if not done`);
}

export async function checkApi({ site }) {
  const base = trimSlash(site.concierge?.apiBase || 'https://bona-api.azoz.uk');
  const res = await probe(`${base}/health`);
  if (res.dry) return { api: row('bona-api', 'pending-owner', `[dry-run] would GET ${base}/health`), retell: row('retell', 'pending-owner', '[dry-run] from /health') };
  const h = res.json ?? {};
  const parts = [`HTTP ${res.status}`];
  if (h.version) parts.push(`v${h.version}`);
  if (h.inventory != null) parts.push(`inventory ${h.inventory}`);
  if (h.db) parts.push(`db ${h.db}`);
  if (h.poller?.lastRun) parts.push(`poller ${h.poller.lastRun}${h.poller.lag != null ? ` (lag ${h.poller.lag}s)` : ''}`);
  if (h.fanout) parts.push(`fan-out pending ${h.fanout.pending ?? 0} / failed ${h.fanout.failed ?? 0}`);
  const api = res.status === 200 && h.ok
    ? row('bona-api', 'live', `${base}/health ok — ${parts.join(', ')}`)
    : row('bona-api', 'error', `${base}/health ${res.error ?? parts.join(', ')} ${res.text ? res.text.slice(0, 120) : ''}`);
  const retell = res.status === 0
    ? row('retell', 'error', 'bona-api unreachable, Retell status unknown')
    : h.retell === 'ok'
      ? row('retell', 'live', `Retell reachable through bona-api${h.mock ? ' (mock mode!)' : ''}`)
      : row('retell', 'error', `/health reports retell: ${JSON.stringify(h.retell ?? null)} — key, balance or ids.json (services/README.md §8)`);
  return { api, retell };
}

export async function checkEvolution({ env }) {
  const base = trimSlash(env.EVOLUTION_API_URL);
  const key = env.EVOLUTION_API_KEY;
  if (!present(base)) return row('evolution', 'pending-owner', 'EVOLUTION_API_URL empty in ~/.secrets/evolution-api.env — the WhatsApp poller and lead notes need it');
  const res = await probe(`${base}/`, { headers: present(key) ? { apikey: key } : {} });
  if (res.dry) return row('evolution', 'pending-owner', `[dry-run] would GET ${base}/ (apikey ${present(key) ? 'present' : 'empty'})`, { secrets: [key] });
  if (res.status >= 200 && res.status < 500) {
    const v = res.json?.version ? ` v${res.json.version}` : '';
    return row('evolution', 'live', `Evolution API answers HTTP ${res.status}${v} at ${base}; instance ${env.BONA_WA_INSTANCE ?? '(unset)'}`, { secrets: [key] });
  }
  return row('evolution', 'error', `GET ${base}/ ${res.error ?? `HTTP ${res.status}`}`, { secrets: [key] });
}

/* ------------------------------------------------------------------ board */

const NEW_ROW_META = {
  'ga4': { name: 'Google Analytics 4', owner: 'owner', link: 'https://analytics.google.com/', action: 'docs/checklists/google-bona.md §1' },
  'meta-pixel': { name: 'Meta Pixel (site)', owner: 'owner', link: 'https://business.facebook.com/events_manager2', action: 'docs/checklists/meta-bona-portfolio.md §4' },
  'meta-capi': { name: 'Meta Conversions API', owner: 'owner', link: 'https://business.facebook.com/events_manager2', action: 'docs/checklists/meta-bona-portfolio.md §5–6' },
  'snap': { name: 'Snap Pixel + Conversions API', owner: 'owner', link: 'https://ads.snapchat.com/', action: 'docs/checklists/snapchat-bona.md' },
  'gsc': { name: 'Google Search Console', owner: 'owner', link: 'https://search.google.com/search-console', action: 'docs/checklists/google-bona.md §2' },
  'bona-api': { name: 'Concierge API (bona-api)', owner: 'agent', link: 'https://bona-api.azoz.uk/health', action: 'systemctl --user status bona-api cloudflared-bona' },
  'retell': { name: 'Retell (Dana)', owner: 'owner', link: 'https://dashboard.retellai.com/', action: 'services/README.md §5' },
  'evolution': { name: 'Evolution API (WhatsApp)', owner: 'agent', link: null, action: '~/.secrets/evolution-api.env' },
};

export function mergeBoard(board, results, checkedAt) {
  const list = Array.isArray(board) ? board.map((r) => ({ ...r })) : [];
  for (const r of results) {
    const idx = list.findIndex((x) => x.id === r.id);
    const patch = { status: r.status, detail: r.detail, checkedAt };
    if (idx >= 0) list[idx] = { ...list[idx], ...patch };
    else list.push({ id: r.id, ...(NEW_ROW_META[r.id] ?? { name: r.id, owner: 'owner', link: null, action: '' }), ...patch });
  }
  return list;
}

/* ------------------------------------------------------------------ main */

export async function run() {
  const env = loadEnv();
  const site = readJson(SITE_FILE, {});
  if (!site.url) throw new Error(`${SITE_FILE} has no url`);
  const analytics = site.analytics ?? {};

  // One fetch of the live home page serves the GSC check and the site-tag checks.
  let homeHtml = null;
  if (!DRY) {
    const res = await probe(`${trimSlash(site.url)}/`, { headers: { Accept: 'text/html' } });
    homeHtml = res.status === 200 ? res.text : null;
  }

  const results = [];
  results.push(await checkGa4({ env, site, homeHtml }));
  results.push(await checkMetaCapi({ env, site }));
  results.push(checkSiteTag({ id: 'meta-pixel', label: 'Meta Pixel', value: analytics.metaPixel, homeHtml, siteKey: 'metaPixel', checklist: 'docs/checklists/meta-bona-portfolio.md §4' }));
  results.push(await checkSnap({ env, site, homeHtml }));
  results.push(checkGsc({ site, homeHtml }));
  const { api, retell } = await checkApi({ site });
  results.push(api, retell);
  results.push(await checkEvolution({ env }));

  const checkedAt = new Date().toISOString();
  if (JSON_OUT) {
    console.log(JSON.stringify({ checkedAt, dryRun: DRY, results }, null, 2));
  } else {
    console.log(`verify-integrations — ${site.url}${DRY ? ' [dry-run: no network]' : ''} — ${checkedAt}`);
    for (const r of results) console.log(`${r.status.padEnd(13)} ${r.id.padEnd(11)} ${r.detail}`);
  }

  if (WRITE) {
    const board = readJson(BOARD_FILE, []);
    const merged = mergeBoard(board, results, checkedAt);
    fs.writeFileSync(BOARD_FILE, `${JSON.stringify(merged, null, 2)}\n`);
    if (!JSON_OUT) console.log(`\nupdated ${path.relative(root, BOARD_FILE)} (${results.length} rows)`);
  } else if (!JSON_OUT) {
    console.log(`\n${DRY ? 'dry-run' : '--no-write'}: ${path.relative(root, BOARD_FILE)} not written`);
  }

  const errors = results.filter((r) => r.status === 'error').length;
  const live = results.filter((r) => r.status === 'live').length;
  if (!JSON_OUT) console.log(`${live} live · ${results.length - live - errors} pending-owner · ${errors} error`);
  return { results, errors };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  run()
    .then(({ errors }) => { process.exitCode = STRICT && errors ? 1 : 0; })
    .catch((err) => { console.error(`verify-integrations: ${err?.message ?? err}`); process.exitCode = 1; });
}
