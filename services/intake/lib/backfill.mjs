// The backfill of listings published before unit models and the Bona brochure existed: which of
// them get `run-once --enrich`, which only get their brochure rebuilt, which are left alone — and,
// once a run-once child has finished, what its output says happened.
//
// Everything here is a pure function of its arguments except makePdfFinder(), which reads the
// intake folder. backfill-enrich.mjs is the CLI that spawns the jobs and commits.
import fs from 'node:fs';
import path from 'node:path';
import { FACT_LISTS, INTAKE_ID_RE, isFigure, withdrawnAdvertising } from '../../../scripts/curate/rules.mjs';
import { sha256File } from './edits.mjs';
import { isSlug } from './listing.mjs';

/** What a plan row can say. `enrich` needs the developer's PDF; `brochure-only` does not. */
export const ACTIONS = Object.freeze(['enrich', 'brochure-only', 'skip']);

/** `--only BONA-W002,bona-w010 BONA-W011` → ['BONA-W002', 'BONA-W010', 'BONA-W011'], or null for "all". */
export function parseOnly(value) {
  if (value === undefined || value === null || value === true) return null;
  const ids = [...new Set(String(value).split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];
  return ids.length ? ids : null;
}

/** The `--only` ids that name no listing in `listings` (case-insensitive). */
export function unknownIds(listings, only) {
  if (!only?.length) return [];
  const have = new Set((listings || []).map((l) => String(l?.id ?? '').toUpperCase()));
  return only.filter((id) => !have.has(String(id).toUpperCase()));
}

const byId = (a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true });

/** A unit model that carries something an enrichment read off the brochure: a price, a Sakani price or a floor plan. */
const carriesSomething = (m) => Boolean(m) && typeof m === 'object'
  && (isFigure(m.price) || isFigure(m.subsidisedPrice) || (Boolean(m.floorPlan) && typeof m.floorPlan === 'object'));

/**
 * What an enrichment already put on a listing, in words — its unit models and every fact list it
 * carries (`amenities`, `nearby`, `warranties`) — or '' when it carries none. A listing published by
 * the new intake can carry fact lists and no models (a brochure that prints no unit types): it is
 * enriched all the same, and a re-read that drops one of its lists would be refused by run-once.
 * Its unit models count only when at least one carries a price or a floor plan (final review M8): models
 * with neither are what an enrichment leaves when its price check could not be completed (a quota, a
 * render that failed) — or a brochure that really prints none. Either way a re-read loses nothing
 * (run-once still refuses a reading with less than the listing carries), and it is the only way to fill
 * them, so such a listing is planned again; the cost is one more reading of a brochure that prints none.
 */
function enrichedWith(l) {
  const list = Array.isArray(l.models) ? l.models : [];
  const models = list.some(carriesSomething) ? [`${list.length} unit model(s)`] : [];
  const facts = Object.keys(FACT_LISTS).filter((k) => ['en', 'ar'].some((lang) => Array.isArray(l[k]?.[lang]) && l[k][lang].length > 0));
  return [...models, ...facts].join(', ');
}

/** Unit models that carry no price and no floor plan, on a listing whose models do not count as an enrichment: how many, else 0. */
function bareModels(l) {
  const list = Array.isArray(l.models) ? l.models : [];
  return list.length > 0 && !list.some(carriesSomething) ? list.length : 0;
}

/**
 * One row per inbox listing (narrowed by `only`), ordered by id:
 * `{ id, slug, title, action: 'enrich' | 'brochure-only' | 'skip', reason, pdf }`.
 *
 * Skipped, in this order: an id that is not an intake id (BONA-W###); a listing whose advertising
 * was withdrawn (rules.mjs WITHDRAWN_ADVERTISING, plus the review register's flags passed as
 * `withdrawals` — the same test edits.mjs withdrawnRefusal() applies) or whose record says
 * "withdrawn"; a hidden listing; a record without a slug; a listing that already carries unit models
 * with a price or a floor plan, or a fact list (amenities / nearby / warranties: "already enriched",
 * enrichedWith — unit models with neither are planned again; the backfill is for listings
 * published before the intake read them; with `includeEnriched` it is enriched again, and run-once
 * still refuses a reading with less than it carries) — unless it carries `plans-unchecked` and its PDF is found (r5 #11).
 * Everything else is `enrich` when its source PDF is found by content hash, else
 * `brochure-only`. `findPdf` is called only for the listings that are not skipped — every call can
 * mean hashing PDFs.
 *
 * @param {object[]} listings  inbox listing objects
 * @param {{findPdf:(sha:string)=>string|null, withdrawals?:object[], only?:string[]|null, includeEnriched?:boolean}} opts
 */
export function planBackfill(listings, { findPdf, withdrawals = [], only = null, includeEnriched = false } = {}) {
  if (typeof findPdf !== 'function') throw new TypeError('planBackfill needs findPdf(sha) → path|null');
  const want = only?.length ? new Set(only.map((s) => String(s).toUpperCase())) : null;
  const rows = [];
  for (const l of Array.isArray(listings) ? listings : []) {
    if (!l || typeof l !== 'object') continue;
    const id = String(l.id ?? '');
    if (want && !want.has(id.toUpperCase())) continue;
    const row = {
      id,
      slug: typeof l.slug === 'string' && l.slug ? l.slug : null,
      title: String(l.title?.en || l.title?.ar || ''),
      action: 'skip',
      reason: '',
      pdf: null,
    };
    const withdrawn = INTAKE_ID_RE.test(id) ? withdrawnAdvertising(l, withdrawals) : null;
    const enriched = enrichedWith(l);
    const sha = typeof l._intake?.pdfSha256 === 'string' && l._intake.pdfSha256 ? l._intake.pdfSha256 : null;
    // Published without the floor plans whose contact check did not finish (r5 #11): enriched again when its PDF
    // is here, already enriched or not — that adds them once checked. Looked up once, for such a listing only. Its
    // other plans may be live (a partial check): the reason names only the unchecked ones (r7 #9).
    const plansUnchecked = Array.isArray(l._intake?.warnings) && l._intake.warnings.includes('plans-unchecked');
    let pdf;
    const lookup = () => (pdf === undefined ? (pdf = (sha && findPdf(sha)) || null) : pdf);
    if (!INTAKE_ID_RE.test(id)) row.reason = 'not an intake listing (BONA-W###)';
    else if (withdrawn) row.reason = `advertising withdrawn (${withdrawn.reason})`;
    else if (l.status === 'withdrawn') row.reason = 'its record says withdrawn';
    else if (l.hidden) row.reason = 'hidden — not on the site';
    else if (!row.slug) row.reason = 'the record has no slug';
    else if (!isSlug(row.slug)) row.reason = `the record's slug ${JSON.stringify(row.slug)} is not a valid slug (lowercase-hyphenated) — fix the record first`;
    else if (enriched && !includeEnriched && !(plansUnchecked && lookup())) {
      row.reason = plansUnchecked
        ? `already enriched (${enriched}) — published without the floor plans whose contact check did not finish, but its source PDF is not in the intake folder`
        : `already enriched (${enriched}) — --include-enriched to enrich it again`;
    } else {
      lookup();
      row.pdf = pdf;
      row.action = pdf ? 'enrich' : 'brochure-only';
      row.reason = pdf
        ? 'source PDF found'
        : sha ? 'source PDF not in the intake folder — brochure rebuilt from the listing only'
          : 'no source PDF recorded — brochure rebuilt from the listing only';
      if (pdf && plansUnchecked) row.reason += ' (published without the floor plans whose contact check did not finish — enriched again)';
      else if (pdf && enriched) row.reason += ` (already has ${enriched} — enriched again)`;
      else if (pdf && bareModels(l)) row.reason += ` (its ${bareModels(l)} unit model(s) carry no price or floor plan — enriched again)`;
    }
    rows.push(row);
  }
  return rows.sort(byId);
}

/**
 * findSourcePdf() (lib/brochure.mjs) for many listings at once: the same walk — same folders, same
 * depth, files before sub-folders, the first match wins — but each folder is listed once and each
 * PDF hashed at most once, however many listings ask. The intake folder holds every brochure ever
 * sent (tens of 50–80 MB files); asking findSourcePdf once per listing would hash all of them
 * twenty times over. The equivalence is pinned in test/backfill.test.mjs.
 */
export function makePdfFinder(intakeDir, { maxDepth = 3, hashFile = sha256File } = {}) {
  const entries = new Map();
  const hashes = new Map();
  const list = (dir) => {
    if (!entries.has(dir)) {
      let e = null;
      try { e = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* unreadable: nothing here */ }
      entries.set(dir, e);
    }
    return entries.get(dir);
  };
  const hashOf = (file) => {
    if (!hashes.has(file)) {
      let h = null;
      try { h = hashFile(file); } catch { /* unreadable, skip */ }
      hashes.set(file, h);
    }
    return hashes.get(file);
  };
  const finder = (wantedSha) => {
    if (!wantedSha || !intakeDir || !fs.existsSync(intakeDir)) return null;
    const walk = (dir, depth) => {
      const here = list(dir);
      if (!here) return null;
      for (const entry of here) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.pdf')) continue;
        const file = path.join(dir, entry.name);
        if (hashOf(file) === wantedSha) return file;
      }
      if (depth <= 0) return null;
      for (const entry of here) {
        if (!entry.isDirectory()) continue;
        const found = walk(path.join(dir, entry.name), depth - 1);
        if (found) return found;
      }
      return null;
    };
    return walk(intakeDir, maxDepth);
  };
  finder.hashed = () => hashes.size;
  return finder;
}

// ---- reading a run-once child's output -------------------------------------------------------

/**
 * A usage, session or rate limit, a quota, or HTTP 429: the next job would fail the same way, so the
 * backfill stops at once. `429` only as a number of its own — not inside a price ("SAR 429,000"), a
 * hash or a timestamp.
 */
export const QUOTA_RE = /(?<![a-z])(?:usage|session|rate)[ _-]?limits?(?![a-z])|\bquotas?\b|too many requests|(?<![\w,.])429(?![\w,.])/i;

/** buildBrandedBrochure's too-large refusal (lib/brochure.mjs), word for word — not any "too large" or "MB limit" (r5 #11). */
const BROCHURE_TOO_LARGE_RE = /\bthe brochure is over the \d+(?:\.\d+)? MB limit even with its photos scaled down\b/;

const lastLines = (text, n = 3) => String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean).slice(-n);
const clip = (s, n = 220) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * What one `run-once.mjs <pdf> --enrich <id>` child ended in.
 *
 *   killed   — SIGKILL / status 137, a memory limit most likely: stop, never re-run blindly
 *   quota    — QUOTA_RE anywhere in the output, whatever the exit code: stop
 *   rejected — `REJECTED at "<stage>": …` (exit 1), or a dry run that says `WOULD BE REJECTED — …`
 *   refused  — `FAILED: --enrich <id>: …`, run-once's own refusal of that one listing (not in the
 *              inbox, withdrawn, hidden, a headline that disagrees with the models, …), or a brochure
 *              too large to build (r3 #7; its refusal text only, BROCHURE_TOO_LARGE_RE): skipped, the backfill goes on
 *   failed   — any other FAILED, any other non-zero exit, and the one refusal that is not about the
 *              listing: the clone has uncommitted changes (every later job would hit it too)
 *   ok       — exit 0
 *
 * @returns {{outcome:string, line:string}}
 */
export function classifyRun({ code, signal = null, output = '' }) {
  const text = String(output ?? '');
  if (signal === 'SIGKILL' || code === 137) {
    return { outcome: 'killed', line: 'killed (SIGKILL / 137 — most likely a memory limit; check `dmesg -T | grep oom-kill` before running anything again)' };
  }
  if (signal) return { outcome: 'killed', line: `stopped by ${signal}` };
  const quota = text.split('\n').find((l) => QUOTA_RE.test(l));
  if (quota) return { outcome: 'quota', line: clip(`quota/usage limit: ${quota.trim()}`) };
  const rejected = /^REJECTED at "([^"]*)":\s*(.*)$/m.exec(text);
  if (rejected) return { outcome: 'rejected', line: clip(`REJECTED at "${rejected[1]}": ${rejected[2]}`) };
  const failed = /^FAILED:\s*(.*)$/m.exec(text);
  if (failed && code !== 0) {
    const msg = failed[1].trim();
    // A brochure too large to build is a fact about that listing, not a broken run: skipped, the backfill goes on (r3 #7).
    const refused = (/^--enrich\s+BONA-W\d+:/i.test(msg) && !/uncommitted changes/i.test(msg)) || BROCHURE_TOO_LARGE_RE.test(msg);
    return { outcome: refused ? 'refused' : 'failed', line: clip(`${refused ? 'REFUSED' : 'FAILED'}: ${msg}`) };
  }
  if (code !== 0) return { outcome: 'failed', line: clip(`exit ${code}: ${lastLines(text).join(' | ') || 'no output'}`) };
  const would = /^WOULD BE REJECTED\s*[—-]\s*(.*)$/m.exec(text);
  if (would) return { outcome: 'rejected', line: clip(`WOULD BE REJECTED — ${would[1]}`) };
  const summary = summarizeRun(text);
  // A dry run reports a headline it would refuse (`Headline   refused — …`) and still exits 0.
  if (/^\s*Headline\s+refused\b/m.test(text)) {
    const why = text.split('\n').map((l) => l.trim()).find((l) => /re-run with --replace|send `price /.test(l));
    return { outcome: 'refused', line: clip(`REFUSED (headline)${why ? `: ${why}` : ''}${summary ? ` · ${summary}` : ''}`, 320) };
  }
  return { outcome: 'ok', line: summary ?? lastLines(text).join(' | ') };
}

const HEADLINE_DECISIONS = /\b(adopted|kept|refused|no-model-prices|currency-mismatch|single-property|unit|owner-price|owner)\b/i;

/**
 * One line out of a successful run's output: unit models found, model prices kept/refused, the
 * headline decision, the floor plans. Read from run-once's enrich report —
 *
 *   Models     8 — 6 priced · prices kept 6 / refused 2 (319,015, 420,000)
 *   Headline   adopted — was on request: the models' confirmed headline is adopted
 *   Plans      plan-01.jpg plan-02.jpg
 *
 * — and from the JSON log lines the pipeline writes (`intake.model_prices`, any event carrying a
 * headline `decision`) when the report says nothing; null when none of it is there, and the caller
 * then shows the last lines instead.
 */
export function summarizeRun(output) {
  const found = { models: null, kept: null, refused: null, headline: null, plans: null };
  const lines = String(output ?? '').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!j || typeof j !== 'object') continue;
    const ev = String(j.event ?? '');
    if (/model_prices$/.test(ev)) {
      if (Number.isInteger(j.models)) found.models = j.models;
      if (Number.isInteger(j.refused)) found.refused = j.refused;
      else if (Array.isArray(j.refused)) found.refused = j.refused.length;
      if (Number.isInteger(j.kept)) found.kept = j.kept;
    }
    if (/enrich|headline/i.test(ev)) {
      if (Number.isInteger(j.models)) found.models = j.models;
      if (Number.isInteger(j.kept)) found.kept = j.kept;
      if (Number.isInteger(j.refused)) found.refused = j.refused;
      const d = j.decision ?? j.headline?.decision ?? (typeof j.headline === 'string' ? j.headline : null);
      if (typeof d === 'string' && d) found.headline = d;
    }
  }
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('{')) continue;
    if (found.models === null) {
      const m = /^models?\b\D{0,24}(\d+)/i.exec(line) || /(\d+)\s+(?:unit[- ]?)?models?\b(?![- ]?price)/i.exec(line);
      if (m) found.models = Number(m[1]);
    }
    if (/price/i.test(line)) {
      if (found.kept === null) {
        const k = /\bkept\b\s*:?\s*(\d+)/i.exec(line) || /(\d+)\s+(?:\S+\s+){0,2}kept\b/i.exec(line);
        if (k) found.kept = Number(k[1]);
      }
      if (found.refused === null) {
        const r = /\brefused\b\s*:?\s*(\d+)/i.exec(line) || /(\d+)\s+(?:\S+\s+){0,2}refused\b/i.exec(line)
          || /(\d+)\s+unit-model price\(s\) could not be confirmed/i.exec(line);
        if (r) found.refused = Number(r[1]);
      }
    }
    if (found.headline === null && /\bheadline\b/i.test(line)) {
      // run-once's own line names the decision first: `Headline   <decision> — <why>`.
      const own = /^headline\s+([a-z][\w-]*)\s*(?:[—-]|$)/i.exec(line);
      const d = own ? null : HEADLINE_DECISIONS.exec(line.replace(/^.*?\bheadline\b/i, ''));
      found.headline = own ? own[1].toLowerCase() : d ? d[1].toLowerCase() : clip(line, 90);
    }
    if (found.plans === null) {
      const p = /^plans\s+(.*)$/i.exec(line);
      if (p) found.plans = /^none\b/i.test(p[1]) ? 0 : (p[1].split(/\s+\(/)[0].match(/\bplan-[\w.-]+/gi) ?? []).length;
    }
  }
  const parts = [];
  if (found.models !== null) parts.push(`models ${found.models}`);
  if (found.kept !== null || found.refused !== null) {
    parts.push(`prices kept ${found.kept ?? '?'} / refused ${found.refused ?? '?'}`);
  }
  if (found.headline !== null) parts.push(`headline ${found.headline}`);
  if (found.plans !== null) parts.push(`plans ${found.plans}`);
  return parts.length ? parts.join(' · ') : null;
}

/** Does this outcome end the backfill? quota and killed always; failed unless --continue-on-error. */
export function stopsBackfill(outcome, { continueOnError = false } = {}) {
  if (outcome === 'quota' || outcome === 'killed') return true;
  if (outcome === 'failed') return !continueOnError;
  return false;
}

/** The command that picks the backfill up again with exactly `ids`. */
export function resumeCommand(ids, { repo, dryRun = false, model = null, continueOnError = false, includeEnriched = false } = {}) {
  const parts = ['node services/intake/backfill-enrich.mjs'];
  if (repo) parts.push('--repo', repo);
  if (dryRun) parts.push('--dry-run');
  if (model) parts.push('--model', model);
  if (continueOnError) parts.push('--continue-on-error');
  if (includeEnriched) parts.push('--include-enriched');
  parts.push('--only', ids.join(','));
  return parts.join(' ');
}

const pad = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t.padEnd(n);
};

/**
 * The plan as a fixed-width table: id · title · action · source PDF · reason. The source PDF is
 * shown relative to the intake folder, whole (up to 72 characters) — it is what a reviewer opens.
 */
export function formatPlanTable(plan, { intakeDir = null } = {}) {
  const pdfCell = (row) => {
    if (row.action === 'skip') return '—';
    if (!row.pdf) return 'no';
    const rel = intakeDir ? path.relative(intakeDir, row.pdf) : row.pdf;
    return `yes ${rel.startsWith('..') ? row.pdf : rel}`;
  };
  const cells = plan.map((row) => ({ row, pdf: pdfCell(row) }));
  const pdfW = Math.min(72, Math.max('Source PDF'.length, ...cells.map((c) => c.pdf.length)));
  const head = `${pad('ID', 10)}  ${pad('Title', 42)}  ${pad('Action', 13)}  ${pad('Source PDF', pdfW)}  Reason`;
  const out = [head, '-'.repeat(head.length + 20)];
  for (const { row, pdf } of cells) {
    out.push(`${pad(row.id, 10)}  ${pad(row.title, 42)}  ${pad(row.action, 13)}  ${pad(pdf, pdfW)}  ${row.reason}`);
  }
  const count = (a) => plan.filter((r) => r.action === a).length;
  out.push('');
  out.push(`${plan.length} listing(s): ${count('enrich')} enrich · ${count('brochure-only')} brochure-only · ${count('skip')} skip`);
  return out.join('\n');
}
