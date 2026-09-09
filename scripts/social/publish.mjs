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
                              that last one is a hard stop even with --force-id, for as long as
                              the placeholder is in the caption.

   Selection: an entry is due when its KSA time is <= now and not older than --grace hours (6 by
   hand; the unit passes 3). Outside 17:00–23:59 KSA nothing is posted or written at all
   (deferred:quiet-hours, --force-id excepted): a Persistent=true catch-up at boot must not post
   at 02:00. Grace never exceeds the timer window: the last tick is 23:45 and the latest slot
   (21:05) + 3 h lapses at 00:05, so every slot gets its full grace inside the window and
   nothing is "still due" when the timer wakes the next day.
   Terminal ledger statuses are never retried: published, skipped:manual, skipped:no-image,
   skipped:missed, skipped:gave-up. `error` is retried on later runs, three times, then becomes
   skipped:gave-up — counting only errors that say something about the post: a network failure,
   an HTTP 5xx, a timeout or a rate limit is written with `transient: true` and does not count
   (the grace window bounds those retries anyway). Other skips (ad-licence, ad-licence-placeholder, caption, quota, no-jpeg)
   are re-evaluated every run and written to the ledger only when the status changes — the
   placeholder one against the caption as it is NOW, so a number pasted in during the grace
   window lets the post out.
   `published` is irrevocable: once any line says so, nothing appended later — and not
   --force-id — re-opens the id. An entry the calendar itself marks published is settled too.

   Never twice: a `publishing` line {containerId} is written BEFORE media_publish. If the run
   dies after that (crash, SIGKILL, a 5xx with the post already live), the id is in flight:
   never a candidate, never re-posted blind. Every live run starts by reconciling in-flight
   lines through GET /{containerId}?fields=status_code — PUBLISHED -> published (mediaId
   unknown); FINISHED -> media_publish again with the SAME creation_id; ERROR/EXPIRED -> error
   (retriable with a new container). If that GET fails or the container is still processing,
   the line stays in flight and a loud `needs-reconcile` line is logged for a human.
   SIGTERM/SIGINT set a flag read between entries only: the current publish always completes.

   Images: relative paths are prefixed with the site origin; a PNG (or anything not .jpg/.jpeg)
   is swapped for its .jpg/.jpeg twin if one exists; every URL is HEAD-checked (200 + image/jpeg)
   before a container is created. No twin served yet -> skipped:no-jpeg (re-checked every run
   while the slot is in its grace window: a deploy fixes it); no image at all, a local path or a
   non-https URL -> skipped:no-image (terminal: no deploy fixes that).

   Limits: at most 3 publishes per run, >= 60 s apart, and the run stops when the account's
   rolling 24 h quota (GET /{ig-id}/content_publishing_limit) is at 20 of 25.

   Ledger: ~/bona-data/ig/published.jsonl ($BONA_IG_LEDGER or --ledger override) — OUTSIDE the
   repo, so a branch switch can never hide it. One JSON line per outcome:
     {id, date, slot, kind, status, mediaId, permalink, ts, ...detail}
   The last line for an id is its current state. The lock file sits beside it.

   Flags:
     --dry-run          print every request, write nothing (the default when META_ACCESS_TOKEN is unset)
     --live             what the timer passes: with no META_ACCESS_TOKEN exit 1 loudly instead of
                        dry-running (a human without a token still gets the dry-run)
     --now 2026-09-09T18:30   pretend it is this KSA time (or an ISO time with a zone)
     --grace 6          hours after the slot during which an entry is still due (the unit passes 3)
     --limit 3          publishes per run (hard cap 3)
     --force-id <id>    publish one entry regardless of its time; still refuses REGA-blocked,
                        placeholder captions, reels and anything already published
     --source path      calendar file (default src/data/content-calendar.json)
     --ledger path      ledger file (default $BONA_IG_LEDGER or ~/bona-data/ig/published.jsonl)
     --json             machine-readable result on stdout (log lines go to stderr)

   Env (from ~/.secrets/bona-meta-graph.env under the timer):
     META_ACCESS_TOKEN  system-user token; unset -> dry-run (exit 1 under --live)
     IG_BUSINESS_ID     defaults to the account id of @bonarealestatesa
     GRAPH_VERSION      optional
     BONA_IG_LEDGER     ledger path (default ~/bona-data/ig/published.jsonl)

   Stops: an auth error (Graph code 190/10/200) or a rate limit (code 4/17/32/613, subcode
   2207051) ends the run at once — nothing after it can succeed — and the rest is deferred.

   Exit codes: 0 ok / nothing due · 1 config error · 2 one or more publish errors. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as nodeParseArgs } from 'node:util';
import { CAPTION_MAX_HASHTAGS, CAROUSEL_MAX, CAROUSEL_MIN, checkCaption, checkImageUrl, createGraph, GraphError } from './lib/graph.mjs';
import { indexLedger, lockPathFor, parseLedger, readLedgerFile, resolveLedgerPath, slug } from './lib/ledger.mjs';

export { indexLedger, parseLedger, slug };

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** Asia/Riyadh is UTC+3 all year — Saudi Arabia has no DST. */
export const KSA_OFFSET_MS = 3 * 3_600_000;
export const AD_LICENCE_TOKEN = '{{AD_LICENCE}}';
/** Any of these in a caption means the REGA licence number was never filled in. Hard stop. */
export const LICENCE_PLACEHOLDERS = [AD_LICENCE_TOKEN, '[add number before publishing]', '[يُضاف قبل النشر]'];
export const DEFAULTS = Object.freeze({
  source: 'src/data/content-calendar.json',
  /** null = $BONA_IG_LEDGER or ~/bona-data/ig/published.jsonl (lib/ledger.mjs); --ledger overrides. */
  ledger: null,
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
  /** Age fallback for a lock with no readable pid — matches the unit's TimeoutStartSec, after which no holder can be alive. */
  lockStaleMs: 25 * 60_000,
  defaultTime: '20:30',
});
/** Ledger statuses that end an entry's life. Everything else is re-evaluated next run. */
export const TERMINAL = new Set(['published', 'skipped:manual', 'skipped:no-image', 'skipped:missed', 'skipped:gave-up']);
/** What --force-id may override: the due window and these non-final outcomes. Never `published`. */
const FORCEABLE = new Set(['skipped:missed', 'skipped:gave-up', 'skipped:no-image', 'skipped:no-jpeg', 'skipped:quota', 'skipped:caption', 'error']);

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
/** The timer's window, KSA hours [17, 24). Nothing is posted outside it — not by a boot-time catch-up, not by a hand run at 02:00. */
export const WINDOW = Object.freeze({ fromHour: 17, toHour: 24 });
export const ksaHour = (ms) => new Date(ms + KSA_OFFSET_MS).getUTCHours();
export const isQuietHours = (ms) => { const h = ksaHour(ms); return h < WINDOW.fromHour || h >= WINDOW.toHour; };
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
      live: { type: 'boolean', default: false },
      now: { type: 'string' },
      grace: { type: 'string' },
      limit: { type: 'string' },
      'force-id': { type: 'string' },
      source: { type: 'string' },
      ledger: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const num = (v, name, d) => { if (v == null) return d; const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a number (got "${v}")`); return n; };
  return {
    dryRun: values['dry-run'],
    live: values.live,
    now: values.now,
    graceHours: num(values.grace, 'grace', DEFAULTS.graceHours),
    limit: Math.floor(num(values.limit, 'limit', DEFAULTS.limit)),
    forceId: values['force-id'] || null,
    source: values.source || DEFAULTS.source,
    ledger: values.ledger || null,
    json: values.json,
    help: values.help,
  };
}

// ---------------------------------------------------------------------------------------
// calendar entries
// ---------------------------------------------------------------------------------------
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
 * -> { ok:true, url }
 *  | { ok:false, reason:'no-image', detail, tried:[] }   structural: not hosted / not https — no
 *                                                        deploy fixes it, so the caller may stop
 *  | { ok:false, reason:'no-jpeg',  detail, tried }      the server answered but not with a JPEG
 *                                                        (404 before a deploy, wrong type, 5xx):
 *                                                        worth asking again next run
 *  | { ok:false, reason:'network',  detail, tried }      no answer at all
 */
export async function resolveImage(u, { base = DEFAULTS.siteBase, fetch: fetchImpl = globalThis.fetch, onCheck = () => {} } = {}) {
  const abs = absoluteImageUrl(u, base);
  if (!abs) return { ok: false, reason: 'no-image', detail: `${u} is not an https URL or a site path`, tried: [] };
  const stat = checkImageUrl(abs);
  if (stat.problems.length) return { ok: false, reason: 'no-image', detail: stat.problems[0], tried: [] };
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
// lock
// ---------------------------------------------------------------------------------------
const pidAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
/**
 * O_EXCL lock file. A lock whose holder is still alive is NEVER taken over, whatever its age
 * (a slow run is still a run; the unit's TimeoutStartSec is what ends it). Takeover happens
 * only when the holder is dead, or — when the file carries no readable pid — when it is older
 * than staleMs (by its ts, or its mtime if it is not even JSON). The takeover renames the
 * stale file to a unique name first (two takers cannot both "unlink then create"), then
 * re-reads what it created to make sure it is its own.
 */
export function acquireLock(file, { now = Date.now(), staleMs = DEFAULTS.lockStaleMs, pid = process.pid, isAlive = pidAlive } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine = JSON.stringify({ pid, ts: new Date(now).toISOString() });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, mine, { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, reason: e.message };
      let info = null;
      try { info = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (re) { if (re.code === 'ENOENT') continue; /* corrupt: no pid to ask */ }
      const holder = Number(info?.pid);
      let age = now - Date.parse(info?.ts);
      if (!Number.isFinite(age)) { try { age = now - fs.statSync(file).mtimeMs; } catch { age = NaN; } } // corrupt file: its mtime is the only clock
      const ageS = Number.isFinite(age) ? `${Math.round(age / 1000)} s old` : 'age unknown';
      if (Number.isInteger(holder) && holder > 0) {
        if (isAlive(holder)) return { ok: false, reason: `another run holds the lock (pid ${holder}, ${ageS})`, pid: holder, age };
      } else if (Number.isFinite(age) && age < staleMs) {
        return { ok: false, reason: `a lock without a readable pid is ${ageS} — waiting for it to go stale (${Math.round(staleMs / 60_000)} min)`, age };
      }
      // dead holder, or unreadable and stale: claim it by renaming — the rename is the atomic step
      const aside = `${file}.stale-${Date.now().toString(36)}-${pid}`;
      try { fs.renameSync(file, aside); fs.unlinkSync(aside); } catch { /* someone else claimed it first; the retry will tell */ }
      continue;
    }
    // wx succeeded: make sure the file still says it is ours before trusting it
    let back = null;
    try { back = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* fall through */ }
    if (!back || Number(back.pid) !== pid || back.ts !== JSON.parse(mine).ts) return { ok: false, reason: 'the lock was replaced under us — leaving it' };
    return { ok: true, release: () => { try { if (fs.readFileSync(file, 'utf8') === mine) fs.unlinkSync(file); } catch { /* already gone */ } } };
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
  // Published once = published forever, whatever was appended after it, and whatever the
  // calendar says. The calendar's own status counts too (gen-social copies the ledger into it,
  // and a human may mark a hand-published post there).
  const pub = rec?.published ?? null;
  if (pub || entry.status === 'published') {
    const where = pub ? `${pub.manual ? 'by hand' : 'by the publisher'}${pub.ts ? ` ${pub.ts}` : ''}${pub.permalink ? ` ${pub.permalink}` : ''}` : 'per the calendar (status: published)';
    return forced ? { status: 'refused:published', detail: `already published ${where} — never re-posted, not even with --force-id`, terminal: true } : { status: null };
  }
  if (rec?.inFlight) return forced ? { status: 'refused:publishing', detail: `container ${rec.inFlight.containerId ?? '?'} in flight since ${rec.inFlight.ts} — reconciled at the start of every live run, never re-posted blind`, terminal: true } : { status: null };
  if (latest && TERMINAL.has(latest) && !(forced && FORCEABLE.has(latest))) return { status: null };

  const at = scheduledAt(entry);
  const due = at <= now && now - at <= graceMs;
  const past = at <= now && now - at > graceMs;
  if (!forced && !due && !past) return { status: null };
  // The timer's window. A boot-time catch-up (Persistent=true) at 02:00, or a hand run at any
  // hour, sees due entries but must not post them or write anything — not even a skip line.
  // Re-evaluated in the window; by then a slot past its grace is `missed` the ordinary way.
  if (!forced && isQuietHours(now)) return { status: 'deferred:quiet-hours', detail: `${fmtKsa(now)} is outside the 17:00–23:59 KSA window — nothing posted, nothing written`, terminal: false };

  if (entry.adLicenceRequired || entry.blocked) return past && !forced ? { status: null } : { status: 'skipped:ad-licence', detail: 'REGA per-ad licence required — never automated', terminal: false };
  if (entry.kind === 'reel') return { status: 'skipped:manual', detail: 'reel: needs hosted video + in-app audio, post by hand', terminal: true };
  if (past && !forced) return { status: 'skipped:missed', detail: `slot ${fmtKsa(at)} passed more than ${Math.round(graceMs / 3_600_000)} h ago`, terminal: true };

  let caption;
  try { caption = composeCaption(entry, readCaption); } catch (e) { return { status: 'skipped:caption', detail: `caption unavailable: ${e.message}`, terminal: false }; }
  // Recomposed from the CURRENT caption every run: the owner may paste the real REGA number
  // inside the grace window, and then the post goes out. Still a hard stop while it is there.
  if (hasLicencePlaceholder(caption)) return { status: 'skipped:ad-licence-placeholder', detail: 'caption still carries a licence placeholder', terminal: false };
  const check = checkCaption(caption);
  if (entry.kind !== 'story' && check.problems.length) return { status: 'skipped:caption', detail: check.problems.join('; '), terminal: false };
  if (!entry.images.length) return { status: 'skipped:no-image', detail: 'entry has no image', terminal: true };
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
  const ledgerPath = resolveLedgerPath(o.ledger);
  const lockPath = o.lock ? path.resolve(o.lock) : lockPathFor(ledgerPath);
  const loadEntries = deps.loadEntries ?? (() => JSON.parse(fs.readFileSync(sourcePath, 'utf8')));
  const readLedger = deps.readLedger ?? (() => readLedgerFile(ledgerPath));
  const appendLedger = deps.appendLedger ?? ((rec) => { fs.mkdirSync(path.dirname(ledgerPath), { recursive: true }); fs.appendFileSync(ledgerPath, `${JSON.stringify(rec)}\n`); });
  const readCaption = deps.readCaption ?? ((file) => fs.readFileSync(path.join(ROOT, o.captions, file), 'utf8'));
  const wall = () => new Date(deps.wallClock ?? Date.now()).toISOString();
  const detailOf = (e) => (e instanceof GraphError ? e.detail : (e?.message || String(e)));
  const transientOf = (e) => Boolean(e instanceof GraphError && e.isTransient);

  const results = [];
  /** Every ledger line has the same head; the tail is whatever the outcome knows. */
  const rowOf = (entry, status, extra = {}) => ({
    id: entry.id, date: entry.date, slot: entry.time, kind: entry.kind, status, mediaId: extra.mediaId ?? null, permalink: extra.permalink ?? null, ts: wall(),
    ...(extra.containerId ? { containerId: extra.containerId } : {}), ...(extra.detail ? { detail: extra.detail } : {}), ...(extra.transient ? { transient: true } : {}),
    ...(extra.imageUrl ? { imageUrl: extra.imageUrl } : {}), ...(extra.imageUrls ? { imageUrls: extra.imageUrls } : {}),
  });
  const record = (entry, status, extra = {}) => { const row = rowOf(entry, status, extra); results.push({ ...row, topic: entry.topic }); return row; };
  const line = (entry, status, detail) => log(`${status.padEnd(30)} ${entry.id}  ${entry.date} ${entry.time}  ${String(entry.kind).padEnd(8)} ${entry.topic}${detail ? ` — ${detail}` : ''}`);
  /** What reaches the ledger: published/error and terminal skips always; other skips when the status changed; deferred/refused/needs-reconcile never. */
  let records = [];
  let ledger = new Map();
  const maybeWrite = (entry, status, extra, { terminal }) => {
    const row = record(entry, status, extra);
    if (dryRun || /^(deferred|refused|needs-reconcile)/.test(status)) return row;
    const prev = ledger.get(entry.id)?.latest?.status ?? null;
    if (terminal || status === 'published' || status === 'error' || prev !== status) { appendLedger(row); records.push(row); }
    return row;
  };

  // A signal never interrupts a publish: the flag is read between entries only, and the unit
  // gives the current one TimeoutStopSec to finish. Ctrl-C on a hand run behaves the same.
  let stopSignal = null;
  const onSignal = (sig) => { if (!stopSignal) log(`${sig} received — finishing the current entry, then stopping`); stopSignal = sig; };
  const stopRequested = deps.stopRequested ?? (() => stopSignal);
  if (deps.signals !== false) { process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal); }

  let lock = null;
  try {
    if (dryRun) log(`[dry-run] no token or --dry-run: requests are printed, the ledger is not written · now = ${fmtKsa(nowMs)} · source = ${path.relative(ROOT, sourcePath)} · ledger = ${ledgerPath}`);
    else log(`publish run · now = ${fmtKsa(nowMs)} · source = ${path.relative(ROOT, sourcePath)} · ledger = ${ledgerPath} · limit ${limit} · grace ${o.graceHours} h`);

    if (!dryRun && deps.lock !== false) {
      lock = acquireLock(lockPath, { now: deps.wallClock ?? Date.now() });
      if (!lock.ok) { log(`lock: ${lock.reason} — leaving this run to it`); return { code: 0, results, published: 0, errors: 0, skippedForLock: true }; }
    }

    let rawEntries;
    try { rawEntries = loadEntries(); } catch (e) { log(`config error: cannot read ${sourcePath}: ${e.message}`); return { code: 1, results, published: 0, errors: 0 }; }
    const list = Array.isArray(rawEntries) ? rawEntries : Array.isArray(rawEntries?.entries) ? rawEntries.entries : null;
    if (!list) { log(`config error: ${sourcePath} is neither an array nor {entries:[…]}`); return { code: 1, results, published: 0, errors: 0 }; }
    const entries = list.map(normaliseEntry).filter((e) => e.platform === 'instagram' && e.date);
    records = readLedger();
    ledger = indexLedger(records);

    if (o.forceId && !entries.some((e) => e.id === o.forceId)) { log(`config error: --force-id ${o.forceId} is not in ${path.relative(ROOT, sourcePath)}`); return { code: 1, results, published: 0, errors: 0 }; }

    const graph = deps.graph ?? createGraph({ token: deps.token, igId: deps.igId || DEFAULTS.igId, dryRun, fetch: fetchImpl, sleep, log: (s) => log(s), progress: () => {} });
    let published = 0, errors = 0, quota = null, stopped = null;
    const stopRun = (why, hint) => { stopped = why; log(`${why} error — stopping the run${hint ? `\nhint: ${hint}` : ''}`); };
    /** Auth and rate-limit errors end the run: nothing after them can succeed, and hammering a rate limit makes it worse. */
    const stopIfNeeded = (e) => { if (e instanceof GraphError && e.shouldStop) stopRun(e.isAuth ? 'auth' : 'rate-limit', e.hint); };
    /** Between entries only: a stop from an earlier error or a signal defers everything left. */
    const mustDefer = (entry) => {
      if (stopped) { line(entry, `deferred:${stopped}`, 'run stopped'); record(entry, `deferred:${stopped}`, { detail: `run stopped on ${stopped} error` }); return true; }
      const sig = stopRequested();
      if (sig) { line(entry, 'deferred:signal', `${sig} received — next run`); record(entry, 'deferred:signal', { detail: `${sig} received` }); return true; }
      return false;
    };

    // ---- reconcile: a `publishing` line with no outcome after it ------------------------
    // The container was FINISHED and media_publish was sent (or about to be) when the run died.
    // Ask Instagram what became of the container. Never re-post from here without an answer.
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (const [id, rec] of ledger) {
      if (!rec.inFlight || rec.published) continue;
      const fl = rec.inFlight;
      const entry = byId.get(id) ?? normaliseEntry({ id, date: fl.date, time: fl.slot, format: fl.kind, topic: '(no longer in the calendar)' });
      const cid = fl.containerId;
      if (dryRun) { line(entry, 'needs-reconcile', `container ${cid ?? '?'} in flight since ${fl.ts} — a live run asks Instagram what became of it`); record(entry, 'needs-reconcile', { detail: 'dry-run: not checked', containerId: cid }); continue; }
      if (mustDefer(entry)) continue;
      if (!cid) { errors++; line(entry, 'needs-reconcile', `publishing line from ${fl.ts} has no containerId — settle by hand: append a published or error line for ${id} to ${ledgerPath}`); record(entry, 'needs-reconcile', { detail: 'no containerId' }); continue; }
      let st;
      try { st = await graph.containerStatus(cid); }
      catch (e) {
        errors++;
        const detail = detailOf(e);
        line(entry, 'needs-reconcile', `GET /${cid} failed: ${detail.split('\n')[0]} — left in flight, NOT re-posted, checked again next run`);
        record(entry, 'needs-reconcile', { detail, containerId: cid });
        stopIfNeeded(e);
        continue;
      }
      if (st.statusCode === 'PUBLISHED') {
        line(entry, 'published', `container ${cid} reports PUBLISHED — reconciled; mediaId/permalink unknown`);
        maybeWrite(entry, 'published', { containerId: cid, detail: 'reconciled: container PUBLISHED after a crash; mediaId/permalink unknown' }, { terminal: true });
      } else if (st.statusCode === 'FINISHED') {
        if (isQuietHours(nowMs)) { line(entry, 'deferred:quiet-hours', `container ${cid} is FINISHED but ${fmtKsa(nowMs)} is outside the 17:00–23:59 KSA window — left in flight`); record(entry, 'deferred:quiet-hours', { detail: 'quiet hours', containerId: cid }); continue; }
        if (published >= limit) { line(entry, 'deferred:limit', `${limit} per run — container ${cid} stays in flight`); record(entry, 'deferred:limit', { detail: `${limit} per run`, containerId: cid }); continue; }
        if (published > 0) await sleep(o.gapMs);
        try {
          const r = await graph.publishContainer(cid);
          published++;
          line(entry, 'published', `${r.mediaId} ${r.permalink} — reconciled: media_publish re-sent for container ${cid}`);
          maybeWrite(entry, 'published', { mediaId: r.mediaId, permalink: r.permalink, containerId: cid, detail: 'reconciled: media_publish re-sent with the same creation_id' }, { terminal: true });
        } catch (e) {
          errors++;
          const detail = detailOf(e);
          line(entry, 'needs-reconcile', `media_publish for container ${cid} failed: ${detail.split('\n')[0]} — left in flight, NOT re-posted`);
          record(entry, 'needs-reconcile', { detail, containerId: cid });
          stopIfNeeded(e);
        }
      } else if (st.statusCode === 'ERROR' || st.statusCode === 'EXPIRED') {
        errors++;
        const detail = `container ${cid} ${st.statusCode}${st.status ? `: ${st.status}` : ''} — the post never went live`;
        line(entry, 'error', detail);
        maybeWrite(entry, 'error', { detail, containerId: cid }, { terminal: false });
      } else {
        line(entry, 'needs-reconcile', `container ${cid} is ${st.statusCode || 'unknown'} — left in flight, checked again next run`);
        record(entry, 'needs-reconcile', { detail: `container ${st.statusCode || 'unknown'}`, containerId: cid });
      }
    }
    ledger = indexLedger(records);

    // ---- what is due ----------------------------------------------------------------------
    const candidates = [];
    for (const entry of entries) {
      const d = decide(entry, { now: nowMs, graceMs, ledger, forceId: o.forceId, readCaption, maxErrors: o.maxErrors });
      if (!d.status) continue;
      if (d.status === 'candidate') { candidates.push({ entry, caption: d.caption, at: d.at, forced: d.forced }); continue; }
      line(entry, d.status, d.detail);
      maybeWrite(entry, d.status, { detail: d.detail }, { terminal: d.terminal });
    }
    candidates.sort((a, b) => a.at - b.at || a.entry.index - b.entry.index);
    const finish = () => {
      log(`done: ${published} published, ${errors} error(s), ${results.length - published - errors} skipped/deferred${dryRun ? ' (dry-run: nothing was sent or written)' : ''}`);
      return { code: errors ? 2 : 0, results, published, errors };
    };
    if (!candidates.length) { log('nothing due'); return finish(); }

    for (const c of candidates) {
      const { entry } = c;
      if (mustDefer(entry)) continue;
      if (published >= limit) { line(entry, 'deferred:limit', `${limit} per run — next run`); record(entry, 'deferred:limit', { detail: `${limit} per run` }); continue; }
      if (quota && quota.quotaUsage + published >= o.quotaStop) { line(entry, 'skipped:quota', `${quota.quotaUsage + published} of ${quota.quotaTotal} used in 24 h — stop at ${o.quotaStop}`); maybeWrite(entry, 'skipped:quota', { detail: 'daily quota guard' }, { terminal: false }); continue; }

      // images: absolute, JPEG (or a JPEG twin), HEAD-verified
      const want = entry.kind === 'carousel' ? entry.images.slice(0, CAROUSEL_MAX) : entry.images.slice(0, 1);
      const urls = []; let failure = null;
      for (const u of want) {
        const r = await resolveImage(u, { base: o.siteBase, fetch: fetchImpl, onCheck: (cand, v) => { if (dryRun) log(`[dry-run] HEAD ${cand} → ${v.detail}`); } });
        if (r.ok) urls.push(r.url); else { failure = r; break; }
      }
      if (failure) {
        // no-image is structural (terminal); no-jpeg is re-checked every run inside the grace
        // window — a 404 today is a deploy away from a 200 — and written once per status change.
        const status = failure.reason === 'network' ? 'error' : failure.reason === 'no-image' ? 'skipped:no-image' : 'skipped:no-jpeg';
        line(entry, status, failure.detail);
        maybeWrite(entry, status, { detail: failure.detail, transient: status === 'error' }, { terminal: status === 'skipped:no-image' });
        if (status === 'error') errors++;
        continue;
      }
      let kind = entry.kind;
      if (kind === 'carousel' && urls.length < CAROUSEL_MIN) { kind = 'post'; log(`  ${entry.id}: only one image — posting as a single image`); }
      const imgs = kind === 'carousel' ? { imageUrls: urls } : { imageUrl: urls[0] };

      // quota: read once, before the first publish of the run
      if (quota === null) {
        try { quota = await graph.publishingLimit(); }
        catch (e) { errors++; line(entry, 'error', `content_publishing_limit: ${e.message}`); maybeWrite(entry, 'error', { detail: e.message, transient: transientOf(e) }, { terminal: false }); stopIfNeeded(e); continue; }
        if (quota.quotaUsage >= o.quotaStop) { line(entry, 'skipped:quota', `${quota.quotaUsage} of ${quota.quotaTotal} used in 24 h — stop at ${o.quotaStop}`); maybeWrite(entry, 'skipped:quota', { detail: 'daily quota guard' }, { terminal: false }); continue; }
      }
      if (published > 0) { if (dryRun) log(`[dry-run] (would wait ${o.gapMs / 1000} s before the next publish)`); else await sleep(o.gapMs); }

      // The in-flight line goes to the ledger BEFORE media_publish. From that moment the entry
      // is never re-posted blind: whatever happens next is settled by the reconcile step above.
      let inFlight = null;
      const beforePublish = (cid) => {
        inFlight = cid;
        if (dryRun) { log(`[dry-run] (would write the publishing line for container ${cid})`); return; }
        appendLedger(rowOf(entry, 'publishing', { containerId: cid, ...imgs }));
        log(`  ${entry.id}: container ${cid} ready — publishing line written`);
      };
      try {
        const onStep = (s) => log(`  ${entry.id}: ${s}`);
        const r = kind === 'carousel' ? await graph.publishCarousel({ imageUrls: urls, caption: c.caption, onStep, beforePublish })
          : kind === 'story' ? await graph.publishStory({ imageUrl: urls[0], onStep, beforePublish })
            : await graph.publishImage({ imageUrl: urls[0], caption: c.caption, altText: entry.alt || undefined, onStep, beforePublish });
        published++;
        line(entry, 'published', `${r.mediaId} ${r.permalink}`);
        maybeWrite(entry, 'published', { mediaId: r.mediaId, permalink: r.permalink, containerId: r.containerId ?? inFlight, ...imgs }, { terminal: true });
      } catch (e) {
        errors++;
        const detail = detailOf(e);
        if (inFlight) {
          // media_publish may have gone through. Leave the publishing line as it is.
          line(entry, 'needs-reconcile', `media_publish for container ${inFlight} failed or its outcome is unknown: ${detail.split('\n')[0]} — left in flight, NOT re-posted, checked next run`);
          record(entry, 'needs-reconcile', { detail, containerId: inFlight });
        } else {
          line(entry, 'error', detail.split('\n')[0]);
          maybeWrite(entry, 'error', { detail, transient: transientOf(e) }, { terminal: false });
        }
        stopIfNeeded(e);
      }
    }
    return finish();
  } catch (e) {
    log(`fatal: ${e?.stack || e}`);
    return { code: 2, results, published: 0, errors: 1 };
  } finally {
    if (deps.signals !== false) { process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal); }
    lock?.release?.();
  }
}

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------
/** Every log line passes through this: the token never reaches the journal, dry-run or not. */
export const maskToken = (token) => (token ? (s) => String(s).split(token).join('<token>') : (s) => String(s));

export async function main(argv = process.argv.slice(2), env = process.env) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(`error: ${e.message}`); return 1; }
  if (opts.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\* ?/, '')); return 0; }
  let now;
  try { now = parseNow(opts.now); } catch (e) { console.error(`error: ${e.message}`); return 1; }
  const token = env.META_ACCESS_TOKEN || '';
  // Under the timer an empty token must not quietly become a dry-run every 15 minutes.
  if (opts.live && !token) { console.error('error: META_ACCESS_TOKEN missing — --live refuses to run without a token (set it in ~/.secrets/bona-meta-graph.env, or drop --live for a dry-run)'); return 1; }
  const dryRun = opts.dryRun || !token;
  const mask = maskToken(token);
  const log = opts.json ? (s) => console.error(mask(s)) : (s) => console.log(mask(s));
  const r = await run({ ...opts, dryRun }, { now, token, igId: env.IG_BUSINESS_ID, log });
  if (opts.json) console.log(JSON.stringify({ now: new Date(now).toISOString(), nowKsa: fmtKsa(now), dryRun, code: r.code, published: r.published, errors: r.errors, results: r.results }, null, 2));
  return r.code;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`fatal: ${e?.message || e}`); process.exitCode = 2; });
}
