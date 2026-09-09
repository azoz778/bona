#!/usr/bin/env node
/* Unattended Instagram publisher for @bonarealestatesa — Node 22+, zero dependencies.
   Runs from a systemd user timer (ops/systemd/bona-ig-publish.timer, every 15 min 17:00–23:59
   Asia/Riyadh), publishes whatever the calendar says is due, records the outcome, exits.

   SOURCE OF TRUTH: src/data/content-calendar.json (written by scripts/og/gen-social.mjs).
   Not marketing/queue/queue.json. Reasons:
     * it is the Instagram calendar — one entry per post, with the caption (AR+EN), hashtags,
       alt text, `adLicenceRequired`, a stable `id` and a KSA `time`;
     * its images are already PUBLIC HTTPS URLs (the site's own media and the media host), which
       is what the Graph API needs. queue.json points at locally rendered PNG/JPEG files under
       marketing/queue/ that are not hosted anywhere, and this script must not upload anything;
     * the dashboard reads the same file, so what the owner sees is what goes out.
   `--source` can point at another file (queue.json's shape is understood too) but its assets
   would have to be hosted first.

   What goes out unattended:  post (single image), carousel (2–10 images), story (image).
   What never does:           reel (needs hosted video + an in-app audio pick — logged once as
                              skipped:manual), anything `adLicenceRequired`/`blocked` (REGA per-ad
                              licence not issued), and any caption still carrying a licence
                              placeholder ({{AD_LICENCE}} or the calendar's bracketed line) —
                              that last one is a hard stop even with --force-id.

   Selection: an entry is due when its KSA time is <= now and not older than --grace hours (6).
   Terminal ledger statuses are never retried: published, skipped:manual, skipped:no-jpeg,
   skipped:ad-licence-placeholder, skipped:missed, skipped:gave-up. `error` is retried on later
   runs, three times, then becomes skipped:gave-up. Other skips (ad-licence, caption, quota) are
   re-evaluated every run and written to the ledger only when the status changes.

   Images: relative paths are prefixed with the site origin; a PNG (or anything not .jpg/.jpeg)
   is swapped for its .jpg/.jpeg twin if one exists; every URL is HEAD-checked (200 + image/jpeg)
   before a container is created. No twin -> skipped:no-jpeg, with the URLs tried in the log.

   Limits: at most 3 publishes per run, >= 60 s apart, and the run stops when the account's
   rolling 24 h quota (GET /{ig-id}/content_publishing_limit) is at 20 of 25.

   Ledger: marketing/queue/published.jsonl — one JSON line per outcome:
     {id, date, slot, kind, status, mediaId, permalink, ts, ...detail}
   The last line for an id is its current state. Committed to git on purpose (see README).

   Flags:
     --dry-run          print every request, write nothing (the default when META_ACCESS_TOKEN is unset)
     --now 2026-09-09T18:30   pretend it is this KSA time (or an ISO time with a zone)
     --grace 6          hours after the slot during which an entry is still due
     --limit 3          publishes per run (hard cap 3)
     --force-id <id>    publish one entry regardless of its time; still refuses REGA-blocked,
                        placeholder captions, reels and anything already published
     --source path      calendar file (default src/data/content-calendar.json)
     --json             machine-readable result on stdout (log lines go to stderr)

   Env (from ~/.secrets/bona-meta-graph.env under the timer):
     META_ACCESS_TOKEN  system-user token; unset -> dry-run
     IG_BUSINESS_ID     defaults to the account id of @bonarealestatesa
     GRAPH_VERSION      optional

   Exit codes: 0 ok / nothing due · 1 config error · 2 one or more publish errors. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as nodeParseArgs } from 'node:util';
import { CAPTION_MAX_HASHTAGS, CAROUSEL_MAX, CAROUSEL_MIN, checkCaption, checkImageUrl, createGraph, GraphError } from './lib/graph.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** Asia/Riyadh is UTC+3 all year — Saudi Arabia has no DST. */
export const KSA_OFFSET_MS = 3 * 3_600_000;
export const AD_LICENCE_TOKEN = '{{AD_LICENCE}}';
/** Any of these in a caption means the REGA licence number was never filled in. Hard stop. */
export const LICENCE_PLACEHOLDERS = [AD_LICENCE_TOKEN, '[add number before publishing]', '[يُضاف قبل النشر]'];
export const DEFAULTS = Object.freeze({
  source: 'src/data/content-calendar.json',
  ledger: 'marketing/queue/published.jsonl',
  lock: 'marketing/queue/.publish.lock',
  captions: 'marketing/captions',
  siteBase: 'https://bona-real-estate.com',
  // The public account id of @bonarealestatesa (ops/NEXT-SESSION.md). Not a secret; env wins.
  igId: '17841427688957180',
  graceHours: 6,
  limit: 3,
  maxPerRun: 3,
  gapMs: 60_000,
  quotaStop: 20,
  maxErrors: 3,
  lockStaleMs: 20 * 60_000,
  defaultTime: '20:30',
});
/** Ledger statuses that end an entry's life. Everything else is re-evaluated next run. */
export const TERMINAL = new Set(['published', 'skipped:manual', 'skipped:no-jpeg', 'skipped:ad-licence-placeholder', 'skipped:missed', 'skipped:gave-up']);
/** What --force-id may override: the due window and these non-final outcomes. Never `published`. */
const FORCEABLE = new Set(['skipped:missed', 'skipped:gave-up', 'skipped:no-jpeg', 'skipped:quota', 'skipped:caption', 'error']);

// ---------------------------------------------------------------------------------------
// time
// ---------------------------------------------------------------------------------------
export function ksaToEpoch(date, time = '00:00') {
  const [y, mo, d] = String(date).split('-').map(Number);
  const [h, mi] = String(time).split(':').map(Number);
  if (![y, mo, d, h, mi].every(Number.isFinite)) throw new Error(`bad KSA date/time: ${date} ${time}`);
  return Date.UTC(y, mo - 1, d, h, mi) - KSA_OFFSET_MS;
}
export function fmtKsa(ms) {
  const s = new Date(ms + KSA_OFFSET_MS).toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 16)} KSA`;
}
/** `--now`: a KSA wall-clock time like 2026-09-09T18:30, or an ISO time carrying its own zone. */
export function parseNow(s) {
  if (s == null || s === '') return Date.now();
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2}))?)?$/);
  if (m) return ksaToEpoch(m[1], m[2] || '00:00') + (m[3] ? Number(m[3]) * 1000 : 0);
  const t = Date.parse(s);
  if (Number.isFinite(t) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(String(s))) return t;
  throw new Error(`--now must be a KSA time like 2026-09-09T18:30, or an ISO time with a zone (got "${s}")`);
}

// ---------------------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------------------
export function parseArgs(argv) {
  const { values } = nodeParseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean', default: false },
      now: { type: 'string' },
      grace: { type: 'string' },
      limit: { type: 'string' },
      'force-id': { type: 'string' },
      source: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const num = (v, name, d) => { if (v == null) return d; const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a number (got "${v}")`); return n; };
  return {
    dryRun: values['dry-run'],
    now: values.now,
    graceHours: num(values.grace, 'grace', DEFAULTS.graceHours),
    limit: Math.floor(num(values.limit, 'limit', DEFAULTS.limit)),
    forceId: values['force-id'] || null,
    source: values.source || DEFAULTS.source,
    json: values.json,
    help: values.help,
  };
}

// ---------------------------------------------------------------------------------------
// calendar entries
// ---------------------------------------------------------------------------------------
export const slug = (str) => String(str ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
const KIND = { image: 'post', video: 'reel', short: 'reel', post: 'post', carousel: 'carousel', reel: 'reel', story: 'story' };

/** Accept a content-calendar.json entry (or a queue.json one) and give it the shape this file uses. */
export function normaliseEntry(raw, index = 0) {
  const kindRaw = raw.surface || raw.format || 'post';
  const kind = KIND[kindRaw] || kindRaw;
  const images = Array.isArray(raw.images) && raw.images.length ? raw.images
    : raw.image ? [raw.image]
      : Array.isArray(raw.assetsJpg) && raw.assetsJpg.length ? raw.assetsJpg
        : Array.isArray(raw.assets) ? raw.assets : [];
  const topic = typeof raw.topic === 'string' ? raw.topic : raw.topic?.en || raw.pieceKey || '';
  const id = raw.id || (raw.launch ? `ig-launch-${String(raw.launch).padStart(2, '0')}` : `ig-${raw.date}-${kind}-${slug(topic) || index}`);
  return {
    id, index, date: raw.date, time: raw.time || DEFAULTS.defaultTime, platform: raw.platform || 'instagram', kind,
    topic, images: images.filter(Boolean), caption: raw.caption ?? '', hashtags: Array.isArray(raw.hashtags) ? raw.hashtags : [],
    alt: typeof raw.alt === 'string' ? raw.alt : raw.alt?.en || null, launch: raw.launch ?? null,
    adLicenceRequired: Boolean(raw.adLicenceRequired), blocked: Boolean(raw.blocked), status: raw.status || 'planned',
  };
}
export const scheduledAt = (e) => ksaToEpoch(e.date, e.time);

/** The text the API gets. Launch posts use their hand-checked caption file; the rest AR — EN + tags. */
export function composeCaption(entry, readCaption) {
  if (entry.launch) return readCaption(`launch-${String(entry.launch).padStart(2, '0')}.txt`);
  const cap = entry.caption;
  const ar = typeof cap === 'string' ? cap : cap?.ar;
  const en = typeof cap === 'string' ? '' : cap?.en;
  const tags = entry.hashtags.filter(Boolean).slice(0, CAPTION_MAX_HASHTAGS);
  return [[ar, en].filter(Boolean).join('\n\n—\n\n'), tags.join(' ')].filter(Boolean).join('\n\n');
}
export const hasLicencePlaceholder = (text) => LICENCE_PLACEHOLDERS.some((p) => String(text ?? '').includes(p));

// ---------------------------------------------------------------------------------------
// images
// ---------------------------------------------------------------------------------------
/** Site-relative -> absolute. A bare local path (marketing/queue/…) is not hosted: null. */
export function absoluteImageUrl(u, base = DEFAULTS.siteBase) {
  if (!u) return null;
  const s = String(u).trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/')) return `${base.replace(/\/$/, '')}${s}`;
  return null;
}
/** URLs worth trying, in order: the URL itself if it is a JPEG, else its .jpg then .jpeg twin. */
export function jpegCandidates(abs) {
  const u = new URL(abs);
  if (/\.jpe?g$/i.test(u.pathname)) return [abs];
  const stem = u.pathname.replace(/\.[a-z0-9]+$/i, '');
  return ['.jpg', '.jpeg'].map((ext) => { const c = new URL(u); c.pathname = `${stem}${ext}`; return c.toString(); });
}
/** HEAD (GET with a 1-byte range if HEAD is refused). ok = 200/206 and an image/jpeg content-type. */
export async function verifyJpeg(url, fetchImpl = globalThis.fetch, { timeoutMs = 15_000 } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 405 || res.status === 501) {
      res = await fetchImpl(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      try { await res.body?.cancel?.(); } catch { /* not interested in the bytes */ }
    }
  } catch (e) {
    return { ok: false, network: true, status: 0, contentType: null, detail: e?.message || String(e) };
  }
  const contentType = (res.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
  const ok = (res.status === 200 || res.status === 206) && /^image\/jpe?g$/.test(contentType);
  return { ok, network: false, status: res.status, contentType, detail: `${res.status} ${contentType || '-'}` };
}
/**
 * Resolve one calendar image to a verified public JPEG URL.
 * -> { ok:true, url } | { ok:false, reason:'no-jpeg'|'network'|'not-hosted', detail, tried }
 */
export async function resolveImage(u, { base = DEFAULTS.siteBase, fetch: fetchImpl = globalThis.fetch, onCheck = () => {} } = {}) {
  const abs = absoluteImageUrl(u, base);
  if (!abs) return { ok: false, reason: 'not-hosted', detail: `${u} is not an https URL or a site path`, tried: [] };
  const stat = checkImageUrl(abs);
  if (stat.problems.length) return { ok: false, reason: 'no-jpeg', detail: stat.problems[0], tried: [] };
  const tried = [];
  let network = null;
  for (const cand of jpegCandidates(abs)) {
    const v = await verifyJpeg(cand, fetchImpl);
    onCheck(cand, v);
    tried.push(`${cand} → ${v.detail}`);
    if (v.ok) return { ok: true, url: cand, tried };
    if (v.network) network = v;
  }
  if (network) return { ok: false, reason: 'network', detail: network.detail, tried };
  return { ok: false, reason: 'no-jpeg', detail: `no public JPEG (${tried.join('; ')})`, tried };
}

// ---------------------------------------------------------------------------------------
// ledger
// ---------------------------------------------------------------------------------------
export function parseLedger(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && r.id && r.status) out.push(r); } catch { /* skip a corrupt line */ }
  }
  return out;
}
export function readLedgerFile(file) {
  try { return parseLedger(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
/** Per-id view: the latest record and how many `error` lines it has accumulated. */
export function indexLedger(records) {
  const m = new Map();
  for (const r of records) {
    const cur = m.get(r.id) || { latest: null, errors: 0 };
    cur.latest = r;
    cur.errors = r.status === 'error' ? cur.errors + 1 : (r.status === 'published' ? 0 : cur.errors);
    m.set(r.id, cur);
  }
  return m;
}

// ---------------------------------------------------------------------------------------
// lock
// ---------------------------------------------------------------------------------------
const pidAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
/** O_EXCL lock file with stale-lock takeover (older than staleMs, or the holder is gone). */
export function acquireLock(file, { now = Date.now(), staleMs = DEFAULTS.lockStaleMs, pid = process.pid, isAlive = pidAlive } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid, ts: new Date(now).toISOString() }), { flag: 'wx' });
      return { ok: true, release: () => { try { fs.unlinkSync(file); } catch { /* already gone */ } } };
    } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, reason: e.message };
      let info = {};
      try { info = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* corrupt = stale */ }
      const age = now - Date.parse(info.ts);
      const fresh = Number.isFinite(age) && age >= 0 && age < staleMs;
      if (fresh && isAlive(Number(info.pid))) return { ok: false, reason: `another run holds the lock (pid ${info.pid}, ${Math.round(age / 1000)} s old)`, pid: info.pid, age };
      try { fs.unlinkSync(file); } catch { /* raced; the retry will tell */ }
    }
  }
  return { ok: false, reason: 'could not acquire the lock' };
}

// ---------------------------------------------------------------------------------------
// decisions
// ---------------------------------------------------------------------------------------
/**
 * Pure: what to do with one entry right now. Returns { status, detail, terminal, candidate }.
 * status 'candidate' means "publishable, subject to image checks and the run's limits";
 * status null means "not this run" (future, or already settled) and nothing is logged.
 */
export function decide(entry, { now, graceMs, ledger, forceId = null, readCaption, maxErrors = DEFAULTS.maxErrors }) {
  const forced = forceId != null && entry.id === forceId;
  if (forceId != null && !forced) return { status: null };
  if (entry.platform !== 'instagram') return { status: null };
  const rec = ledger.get(entry.id);
  const latest = rec?.latest?.status ?? null;
  if (latest === 'published') return forced ? { status: 'refused:published', detail: `already published ${rec.latest.ts}${rec.latest.permalink ? ` ${rec.latest.permalink}` : ''} — remove the ledger line to re-post`, terminal: true } : { status: null };
  if (latest && TERMINAL.has(latest) && !(forced && FORCEABLE.has(latest))) return { status: null };

  const at = scheduledAt(entry);
  const due = at <= now && now - at <= graceMs;
  const past = at <= now && now - at > graceMs;
  if (!forced && !due && !past) return { status: null };

  if (entry.adLicenceRequired || entry.blocked) return past && !forced ? { status: null } : { status: 'skipped:ad-licence', detail: 'REGA per-ad licence required — never automated', terminal: false };
  if (entry.kind === 'reel') return { status: 'skipped:manual', detail: 'reel: needs hosted video + in-app audio, post by hand', terminal: true };
  if (past && !forced) return { status: 'skipped:missed', detail: `slot ${fmtKsa(at)} passed more than ${Math.round(graceMs / 3_600_000)} h ago`, terminal: true };

  let caption;
  try { caption = composeCaption(entry, readCaption); } catch (e) { return { status: 'skipped:caption', detail: `caption unavailable: ${e.message}`, terminal: false }; }
  if (hasLicencePlaceholder(caption)) return { status: 'skipped:ad-licence-placeholder', detail: 'caption still carries a licence placeholder', terminal: true };
  const check = checkCaption(caption);
  if (entry.kind !== 'story' && check.problems.length) return { status: 'skipped:caption', detail: check.problems.join('; '), terminal: false };
  if (!entry.images.length) return { status: 'skipped:no-jpeg', detail: 'entry has no image', terminal: true };
  if (!forced && (rec?.errors ?? 0) >= maxErrors) return { status: 'skipped:gave-up', detail: `${rec.errors} errors — not retrying (use --force-id to try again)`, terminal: true };
  return { status: 'candidate', caption: check.text, at, forced };
}

// ---------------------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------------------
export async function run(opts = {}, deps = {}) {
  const o = { ...DEFAULTS, ...opts };
  const nowMs = deps.now ?? Date.now();
  const graceMs = (o.graceHours ?? DEFAULTS.graceHours) * 3_600_000;
  const limit = Math.max(0, Math.min(o.limit ?? DEFAULTS.limit, DEFAULTS.maxPerRun));
  const dryRun = Boolean(o.dryRun);
  const log = deps.log ?? ((s) => console.log(s));
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const sourcePath = path.isAbsolute(o.source) ? o.source : path.join(ROOT, o.source);
  const ledgerPath = path.isAbsolute(o.ledger) ? o.ledger : path.join(ROOT, o.ledger);
  const lockPath = path.isAbsolute(o.lock) ? o.lock : path.join(ROOT, o.lock);
  const loadEntries = deps.loadEntries ?? (() => JSON.parse(fs.readFileSync(sourcePath, 'utf8')));
  const readLedger = deps.readLedger ?? (() => readLedgerFile(ledgerPath));
  const appendLedger = deps.appendLedger ?? ((rec) => { fs.mkdirSync(path.dirname(ledgerPath), { recursive: true }); fs.appendFileSync(ledgerPath, `${JSON.stringify(rec)}\n`); });
  const readCaption = deps.readCaption ?? ((file) => fs.readFileSync(path.join(ROOT, o.captions, file), 'utf8'));
  const results = [];
  const record = (entry, status, extra = {}) => {
    const row = { id: entry.id, date: entry.date, slot: entry.time, kind: entry.kind, status, mediaId: extra.mediaId ?? null, permalink: extra.permalink ?? null, ts: new Date(deps.wallClock ?? Date.now()).toISOString(), ...(extra.detail ? { detail: extra.detail } : {}), ...(extra.imageUrl ? { imageUrl: extra.imageUrl } : {}), ...(extra.imageUrls ? { imageUrls: extra.imageUrls } : {}) };
    results.push({ ...row, topic: entry.topic });
    return row;
  };
  const line = (entry, status, detail) => log(`${status.padEnd(30)} ${entry.id}  ${entry.date} ${entry.time}  ${entry.kind.padEnd(8)} ${entry.topic}${detail ? ` — ${detail}` : ''}`);
  const maybeWrite = (entry, status, extra, ledger, { terminal }) => {
    const row = record(entry, status, extra);
    if (dryRun) return;
    const prev = ledger.get(entry.id)?.latest?.status ?? null;
    if (terminal || status === 'published' || status === 'error' || prev !== status) appendLedger(row);
  };

  let lock = null;
  try {
    if (dryRun) log(`[dry-run] no token or --dry-run: requests are printed, the ledger is not written · now = ${fmtKsa(nowMs)} · source = ${path.relative(ROOT, sourcePath)}`);
    else log(`publish run · now = ${fmtKsa(nowMs)} · source = ${path.relative(ROOT, sourcePath)} · limit ${limit} · grace ${o.graceHours} h`);

    if (!dryRun && deps.lock !== false) {
      lock = acquireLock(lockPath, { now: deps.wallClock ?? Date.now() });
      if (!lock.ok) { log(`lock: ${lock.reason} — leaving this run to it`); return { code: 0, results, published: 0, errors: 0, skippedForLock: true }; }
    }

    let rawEntries;
    try { rawEntries = loadEntries(); } catch (e) { log(`config error: cannot read ${sourcePath}: ${e.message}`); return { code: 1, results, published: 0, errors: 0 }; }
    const list = Array.isArray(rawEntries) ? rawEntries : Array.isArray(rawEntries?.entries) ? rawEntries.entries : null;
    if (!list) { log(`config error: ${sourcePath} is neither an array nor {entries:[…]}`); return { code: 1, results, published: 0, errors: 0 }; }
    const entries = list.map(normaliseEntry).filter((e) => e.platform === 'instagram' && e.date);
    const ledger = indexLedger(readLedger());

    if (o.forceId && !entries.some((e) => e.id === o.forceId)) { log(`config error: --force-id ${o.forceId} is not in ${path.relative(ROOT, sourcePath)}`); return { code: 1, results, published: 0, errors: 0 }; }

    const candidates = [];
    for (const entry of entries) {
      const d = decide(entry, { now: nowMs, graceMs, ledger, forceId: o.forceId, readCaption, maxErrors: o.maxErrors });
      if (!d.status) continue;
      if (d.status === 'candidate') { candidates.push({ entry, caption: d.caption, at: d.at, forced: d.forced }); continue; }
      line(entry, d.status, d.detail);
      if (d.status.startsWith('refused:')) { record(entry, d.status, { detail: d.detail }); continue; }
      maybeWrite(entry, d.status, { detail: d.detail }, ledger, { terminal: d.terminal });
    }
    candidates.sort((a, b) => a.at - b.at || a.entry.index - b.entry.index);
    if (!candidates.length) { log('nothing due'); return { code: 0, results, published: 0, errors: 0 }; }

    const graph = deps.graph ?? createGraph({ token: deps.token, igId: deps.igId || DEFAULTS.igId, dryRun, fetch: fetchImpl, sleep, log: (s) => log(s), progress: () => {} });
    let published = 0, errors = 0, quota = null;
    for (const [i, c] of candidates.entries()) {
      const { entry } = c;
      if (published >= limit) { line(entry, 'deferred:limit', `${limit} per run — next run`); record(entry, 'deferred:limit', { detail: `${limit} per run` }); continue; }
      if (quota && quota.quotaUsage + published >= o.quotaStop) { line(entry, 'skipped:quota', `${quota.quotaUsage + published} of ${quota.quotaTotal} used in 24 h — stop at ${o.quotaStop}`); maybeWrite(entry, 'skipped:quota', { detail: 'daily quota guard' }, ledger, { terminal: false }); continue; }

      // images: absolute, JPEG (or a JPEG twin), HEAD-verified
      const want = entry.kind === 'carousel' ? entry.images.slice(0, CAROUSEL_MAX) : entry.images.slice(0, 1);
      const urls = []; let failure = null;
      for (const u of want) {
        const r = await resolveImage(u, { base: o.siteBase, fetch: fetchImpl, onCheck: (cand, v) => { if (dryRun) log(`[dry-run] HEAD ${cand} → ${v.detail}`); } });
        if (r.ok) urls.push(r.url); else { failure = r; break; }
      }
      if (failure) {
        const status = failure.reason === 'network' ? 'error' : 'skipped:no-jpeg';
        line(entry, status, failure.detail);
        maybeWrite(entry, status, { detail: failure.detail }, ledger, { terminal: status !== 'error' });
        if (status === 'error') errors++;
        continue;
      }
      let kind = entry.kind;
      if (kind === 'carousel' && urls.length < CAROUSEL_MIN) { kind = 'post'; log(`  ${entry.id}: only one image — posting as a single image`); }

      // quota: read once, before the first publish of the run
      if (quota === null) {
        try { quota = await graph.publishingLimit(); }
        catch (e) { line(entry, 'error', `content_publishing_limit: ${e.message}`); maybeWrite(entry, 'error', { detail: e.message }, ledger, { terminal: false }); errors++; if (e instanceof GraphError && e.isAuth) { log(`auth error — stopping the run\nhint: ${e.hint}`); break; } continue; }
        if (quota.quotaUsage >= o.quotaStop) { line(entry, 'skipped:quota', `${quota.quotaUsage} of ${quota.quotaTotal} used in 24 h — stop at ${o.quotaStop}`); maybeWrite(entry, 'skipped:quota', { detail: 'daily quota guard' }, ledger, { terminal: false }); continue; }
      }
      if (published > 0) { if (dryRun) log(`[dry-run] (would wait ${o.gapMs / 1000} s before the next publish)`); else await sleep(o.gapMs); }

      try {
        const onStep = (s) => log(`  ${entry.id}: ${s}`);
        const r = kind === 'carousel' ? await graph.publishCarousel({ imageUrls: urls, caption: c.caption, onStep })
          : kind === 'story' ? await graph.publishStory({ imageUrl: urls[0], onStep })
            : await graph.publishImage({ imageUrl: urls[0], caption: c.caption, altText: entry.alt || undefined, onStep });
        published++;
        line(entry, 'published', `${r.mediaId} ${r.permalink}`);
        maybeWrite(entry, 'published', { mediaId: r.mediaId, permalink: r.permalink, ...(kind === 'carousel' ? { imageUrls: urls } : { imageUrl: urls[0] }) }, ledger, { terminal: true });
      } catch (e) {
        errors++;
        const detail = e instanceof GraphError ? e.detail : (e?.message || String(e));
        line(entry, 'error', detail.split('\n')[0]);
        maybeWrite(entry, 'error', { detail }, ledger, { terminal: false });
        if (e instanceof GraphError && e.isAuth) { log(`auth error — stopping the run${e.hint ? `\nhint: ${e.hint}` : ''}`); for (const rest of candidates.slice(i + 1)) { line(rest.entry, 'deferred:auth', 'run stopped'); record(rest.entry, 'deferred:auth', { detail: 'run stopped on auth error' }); } break; }
      }
    }
    log(`done: ${published} published, ${errors} error(s), ${results.length - published - errors} skipped/deferred${dryRun ? ' (dry-run: nothing was sent or written)' : ''}`);
    return { code: errors ? 2 : 0, results, published, errors };
  } catch (e) {
    log(`fatal: ${e?.stack || e}`);
    return { code: 2, results, published: 0, errors: 1 };
  } finally {
    lock?.release?.();
  }
}

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------
export async function main(argv = process.argv.slice(2), env = process.env) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(`error: ${e.message}`); return 1; }
  if (opts.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\* ?/, '')); return 0; }
  let now;
  try { now = parseNow(opts.now); } catch (e) { console.error(`error: ${e.message}`); return 1; }
  const token = env.META_ACCESS_TOKEN || '';
  const dryRun = opts.dryRun || !token;
  const log = opts.json ? (s) => console.error(s) : (s) => console.log(s);
  const r = await run({ ...opts, dryRun }, { now, token, igId: env.IG_BUSINESS_ID, log });
  if (opts.json) console.log(JSON.stringify({ now: new Date(now).toISOString(), nowKsa: fmtKsa(now), dryRun, code: r.code, published: r.published, errors: r.errors, results: r.results }, null, 2));
  return r.code;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`fatal: ${e?.message || e}`); process.exitCode = 2; });
}
