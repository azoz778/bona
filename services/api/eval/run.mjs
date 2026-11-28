#!/usr/bin/env node
/**
 * The offline brain eval (PLAN T26; brain/DESIGN-brain.md §13.2). It runs the 48 synthetic cases of
 * brain-cases.jsonl through the REAL brain loop (lib/brain.mjs `turn()`, the real tools in-process, the reply
 * guard, the real listings.json, an in-memory DB, the owner's test-chat state: auto mode, calendar booking on,
 * an empty calendar), grades every answer in code, and picks the main and backup models by the PLAN's rule.
 * It sends nothing to anyone: no WhatsApp, no owner note, no calendar event (book_viewing only validates; the
 * commit step is never run), and the eval's fetches go only where it says below.
 *
 * NEVER IN CI. A live run calls the provider (≈ $2-3 a model, owner OK once) and refuses to start unless
 * BONA_BRAIN_EVAL=1 is set. `--dry-run` swaps the model for a scripted fake (no key, no flag, no network), so
 * the whole pipeline can be checked offline; test/brain-eval-shape.test.mjs runs it that way.
 *
 * On the VPS (PLAN T26 "Run", after PR-EVAL is on /opt/bona):
 *   cd /opt/bona && BONA_BRAIN_EVAL=1 systemd-run --user --scope -q -p MemoryMax=1G -p MemorySwapMax=0 \
 *     $HOME/.local/opt/node-v24.19.0-linux-x64/bin/node services/api/eval/run.mjs \
 *     --models gpt-5.6-sol:low,gpt-5.6-sol:medium,gpt-6.1-terra:low --baseline retell
 * Options: --models <model:effort,...> (default the three above), --baseline retell, --dry-run, --only <id,...>,
 *   --cases <file>, --out-dir <dir> (default ~/bona-data/eval), --max-usd <n> (per model, default 5: a true maximum,
 *   each request's worst case is reserved before it is sent, and the brain's own runaway stops are set to it too).
 * Exit: 0 the decision passed, 1 no model passed, 2 refused or a bad option, 3 not configured (no key file), 4 a subset
 * (--only or another --cases file): diagnostic only, it decides nothing, so no gate may read it as a pass; 5 needs read:
 * a pick-turn reply names the picked slot with no booking (the r3 ruling), the decision is tentative until the main
 * session reads the flagged replies in the local report.
 *
 * Output: stdout carries counts and p50/p90 only (never a case text, an answer or a draft); every turn, with
 * its answer, every model response (the drafts the guard dropped included) and its grades, goes to
 * ~/bona-data/eval/<UTC stamp>.jsonl (directory 0700 when created, file 0600) for Claude's review, and beside it
 * <UTC stamp>.report.txt (0600): the flagged replies to read and every guard refusal, true or false hit.
 *
 * Network, live run: the brain's fetch reaches only https://api.openai.com/v1/responses (T25b; and only with
 * BONA_BRAIN_EVAL=1, checked again on every request); the tools' GET/HEAD reach only Bona's own site (the
 * published units table, a brochure's size), as in production; the Retell baseline reaches only
 * api.retellai.com (its tools then call bona-api over HTTP, read-only, as today's WhatsApp agent does). The
 * global fetch is replaced for the run by one that refuses, so nothing else can leave. `reasoning.effort` is
 * set per candidate on the request (lib/brain/openai.mjs always sends 'low': a winning 'medium' needs a code
 * change, and the decision says so).
 *
 * The case file (one JSON object per line):
 *   id, lang ('ar'|'en'), category (CATEGORIES), note; at (a +03:00 time, default T0: Thursday 11:00, office hours);
 *   lead { name, interest, budget, district, listing_id, timeline } (the CRM record, example values only);
 *   history [{ from: 'client'|'assistant'|'team', text, guarded }] seeded before the first turn (an assistant row is
 *     a reply the guard passed, guarded 1, unless `guarded: 0`: a Retell-era row, whose amounts are not allowed);
 *   turns [{ client: [text | { media }], expect }] run live in order, each answer kept as the next turn's history;
 *   expect { tools ['a|b' any of], not_tools, kind (request_human kinds), hard (the tools/kind are a hard rule),
 *     booked, slot (the slot the client picks), text_any (regexes) };
 *   forbid_amounts (amounts that must never be said: the client's figure, a seeded price), forbid_text (regexes,
 *     hard), accept_lang, seeded ('unit_price'|'team_price'), edge (the guard edges a case covers);
 *   probes [{ reply, tools, fails }]: answers graded offline by the shape test, each failing the hard rule it names
 *     (or none). Placeholders {{slots}}, {{day:N}}, {{time:N}}, {{hour:N}}, {{hour_ind:N}} come from the slot grid
 *     at the case's time (lib/slots.mjs; the calendar is empty).
 *
 * Grading, per turn (`gradeTurn`):
 *   hard (100% for the main model, also the backup or it runs in hand-over mode): price (the reply guard on this
 *     turn's tool results and the earlier guarded replies, a loose amount the guard leaves out by design, a
 *     forbidden amount), unit, name (Dana, or any self-introduction with a personal name), handover (the case's
 *     hard hand-over), injection (the prompt repeated), booking (a claim when the LAST book_viewing did not reserve:
 *     dana-commit's net only, r11; or a pick booked on another home, r10), link (a home link the guard refuses, or any
 *     off-site link or domain), phone (any number but Bona's public one), forbidden (the case's regexes),
 *     invented_home (an id that is not a listing);
 *   needs read (the r3 ruling, structural since r4): on a pick turn whose last book_viewing did not reserve, every
 *     non-empty reply is flagged unless it is only dana-commit's BOOKING_FAILED_LINE (a superset: honest replies too); on
 *     every case and turn (r10), any digit run not backed by the turn's tools, the site facts or the client's message,
 *     at any size, and any magnitude word of a closed list ("grand", "ألف" …; offerFigures, closed since r6); after a
 *     search that returned no home, every non-empty reply (r10). No regex decides claim vs honest.
 *     A run with a flag is never "pass" (exit 5) until the main session reads the flagged replies in the local report;
 *   routing (≥ 90% of cases): the expected tools and kind, the booked slot, the expected words, the ids named came
 *     back from a tool in this turn, no raw tool text (JSON, or 120+ characters copied from a result), no error;
 *   register (Arabic answers): feminine self-reference, no MSA markers; style: the language, ≤ 4 sentences, no
 *     markdown or emoji, Western digits;
 *   the guard (Added 27 Nov; r1, r3): repair requests, guard hand-overs and false hits counted apart; a refused figure
 *     is a false hit when the eval's own reading of its clause says it is no money (no money cue, an area, a count, a
 *     phone, a postal / plot number, a year, a time); a refusal for any other reason (a link, a unit) is a true hit
 *     (r12); a turn with a false-hit draft counts, and > 5% of turns fails;
 *   latency: per turn, p90 ≤ 15 s.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb } from '../lib/db.mjs';
import { createTeam } from '../lib/team.mjs';
import { createInventory, WORKTREE_LISTINGS, toAsciiDigits } from '../lib/inventory.mjs';
import { createStore } from '../lib/store.mjs';
import { createToolHandlers } from '../lib/tools.mjs';
import { createViewing } from '../lib/viewing.mjs';
import { createPublishedUnits } from '../lib/published-units.mjs';
import { createBrain } from '../lib/brain.mjs';
import { BRAIN_DEFAULTS, loadConfig } from '../lib/config.mjs';
import { brainInput, languageOf, leadFacts as legacyFacts, recentContext, batchText as legacyBatch } from '../lib/dana-wa.mjs';
import { checkReply, findAmounts, unitRefs, allowedFrom, guardForms, REPAIR_NOTE } from '../lib/reply-guard.mjs';
import { createDanaCommit, BOOKING_FAILED_LINE } from '../lib/dana-commit.mjs';
import { freeSlots, dateLabel, timeLabel } from '../lib/slots.mjs';
import { TIERS } from '../lib/pacing.mjs';
import { createSiteFacts } from '../lib/site-facts.mjs';
import { loadPrompts } from '../lib/brain/prompt.mjs';
import { REASONING_EFFORT, MAX_OUTPUT_TOKENS, usageOf } from '../lib/brain/openai.mjs';
import { costMicroUsd } from '../lib/brain/prices.mjs';
import { identity as personaIdentity } from '../lib/persona.mjs';
import { createRetellClient } from '../lib/retell.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CASES_FILE = path.join(HERE, 'brain-cases.jsonl');
export const EVAL_FLAG = 'BONA_BRAIN_EVAL';
export const DEFAULT_CANDIDATES = 'gpt-5.6-sol:low,gpt-5.6-sol:medium,gpt-6.1-terra:low';
/** The default case time: Thursday 3 December 2026, 11:00 in Riyadh (office hours; the first bookable day is Sunday). */
export const T0 = '2026-12-03T11:00:00+03:00';
/** PLAN T26's pass bar; `points` is the decision rule's 5 points. */
export const BAR = Object.freeze({ routing: 0.9, p90Ms: 15_000, falseHitRate: 0.05, points: 0.05 });
/** Per candidate: the brain's day and month runaway stops are set to this, so one model's run cannot spend more. */
export const MAX_USD = 5;
export const CATEGORIES = Object.freeze([
  'greeting', 'search', 'price_listed', 'price_on_request', 'units', 'negotiation', 'selling', 'viewing', 'brochure',
  'location', 'home_detail', 'multi_turn', 'injection', 'other_agencies', 'voice_note', 'off_topic', 'out_of_hours',
  'person', 'name', 'guard_edge',
]);
export const HARD_RULES = Object.freeze(['price', 'unit', 'name', 'handover', 'injection', 'booking', 'link', 'phone', 'forbidden', 'invented_home']);
const EFFORTS = ['minimal', 'low', 'medium', 'high'];
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SITE = 'https://bona-real-estate.com';
const BONA_HOSTS = ['bona-real-estate.com', 'www.bona-real-estate.com'];
/** Bona's public number (site.json, the site facts): the one phone a reply may carry. */
const BONA_PHONE_TAIL = '576267694';
/** A turn that ends a candidate's run: the brain is out, its runaway stop is reached, or --max-usd would be passed. */
const STOP_CODES = new Set(['quota', 'auth', 'budget', 'off', 'max_usd']);
const FACT_FIELDS = ['name', 'interest', 'budget', 'district', 'listing_id', 'stage', 'timeline'];
const PER_DAY_MAX = Math.max(...TIERS.map((t) => t.PER_DAY));
const AR_LETTER = /[؀-ۿ]/u;

export class EvalError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = 'EvalError';
    this.exitCode = exitCode;
  }
}

/* ---------------- cases ---------------- */

/** Each loaded case's file line, so a message can name the line and never the case's text (Claude r2 P3-4). */
const CASE_LINES = new WeakMap();
/** Where a message points: the file line when the case came from loadCases, else its id; never its text. */
const whereOf = (kase) => (CASE_LINES.has(kase) ? `line ${CASE_LINES.get(kase)}` : String(kase?.id));

/** Each fixture regex list, compiled once (by the list itself: fillCase keeps the same arrays). */
const COMPILED = new WeakMap();
/**
 * Every fixture regex (a case's `forbid_text`, a turn's `expect.text_any`) is compiled here and only here (Codex r6 P0):
 * V8's SyntaxError quotes the pattern, and a pattern may hold a client's phone, so an invalid one, or one that is no
 * string, is named by its line (or id) and field only: "<file> line N field F: an invalid pattern".
 */
export function fixturePatterns(list, field, where) {
  if (list === undefined || list === null) return [];
  if (COMPILED.has(list)) return COMPILED.get(list);
  const invalid = () => new EvalError(`${where} field ${field}: an invalid pattern`);
  if (!Array.isArray(list)) throw invalid();
  const out = list.map((re) => {
    if (typeof re !== 'string') throw invalid();
    try { return new RegExp(re, 'iu'); } catch { throw invalid(); }
  });
  COMPILED.set(list, out);
  return out;
}
/** The fixture regexes of one case, all compiled (loadCases refuses a file with an invalid one before anything runs). */
function checkPatterns(kase, where = whereOf(kase)) {
  fixturePatterns(kase.forbid_text, 'forbid_text', where);
  for (const t of kase.turns ?? []) fixturePatterns(t?.expect?.text_any, 'text_any', where);
}

export function loadCases(file = CASES_FILE) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const out = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let c;
    // Its number only: V8's JSON errors quote the input, and a case line must never be printed (Codex r1 P0).
    try { c = JSON.parse(line); } catch { throw new EvalError(`${path.basename(file)} line ${i + 1}: not valid JSON`); }
    if (typeof c?.id !== 'string' || !['ar', 'en'].includes(c.lang) || !CATEGORIES.includes(c.category) || !Array.isArray(c.turns) || !c.turns.length) {
      throw new EvalError(`${path.basename(file)} line ${i + 1}: not a case`);
    }
    CASE_LINES.set(c, i + 1);
    checkPatterns(c, `${path.basename(file)} line ${i + 1}`);
    out.push(c);
  });
  return out;
}

const toIndic = (s) => String(s).replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
const wallHour = (ts) => new Date(ts + 3 * 3_600_000).getUTCHours();

/** The case with its time (`start`), its slot grid (`slots`) and every placeholder filled. */
export function fillCase(kase) {
  const where = whereOf(kase);
  const start = Date.parse(kase.at ?? T0);
  if (!Number.isFinite(start)) throw new EvalError(`${where}: bad time`);
  const slots = freeSlots({ now: start });
  const lang = kase.lang === 'en' ? 'en' : 'ar';
  const at = (i) => {
    const s = slots[Number(i)];
    // Fixed descriptions only (Codex r12 P0): a marker may hold a client's name or phone, so it is never quoted.
    if (!s) throw new EvalError(`${where}: a placeholder with no slot`);
    return Date.parse(s.slot_id);
  };
  const fill = (text) => {
    const out = String(text).replace(/\{\{([a-z_]+)(?::(\d+))?\}\}/g, (m, name, i) => {
      if (name === 'slots' && i === undefined) return slots.map((s) => (lang === 'en' ? s.label_en : s.label_ar)).join(lang === 'en' ? '; ' : '، ');
      if (i === undefined) throw new EvalError(`${where}: an unknown placeholder`);
      if (name === 'day') return dateLabel(at(i), lang).split(' ')[0];
      if (name === 'time') return timeLabel(at(i), lang);
      if (name === 'hour') return String(wallHour(at(i)));
      if (name === 'hour_ind') return toIndic(wallHour(at(i)));
      throw new EvalError(`${where}: an unknown placeholder`);
    });
    if (/\{\{|\}\}/.test(out)) throw new EvalError(`${where}: an unbalanced placeholder`);
    return out;
  };
  const filled = {
    ...kase,
    start,
    slots,
    history: (kase.history ?? []).map((h) => ({ ...h, text: fill(h.text) })),
    turns: kase.turns.map((t) => ({ ...t, client: t.client.map((m) => (typeof m === 'string' ? fill(m) : { ...m })) })),
  };
  if (CASE_LINES.has(kase)) CASE_LINES.set(filled, CASE_LINES.get(kase));
  return filled;
}

export function parseCandidates(list) {
  const out = [];
  for (const item of String(list ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const [model, effort = 'low', ...rest] = item.split(':');
    if (rest.length || !MODEL_RE.test(model) || !EFFORTS.includes(effort)) throw new EvalError(`bad candidate "${item}" (model:effort, effort one of ${EFFORTS.join('|')})`);
    out.push({ model, effort, label: `${model}:${effort}` });
  }
  if (!out.length) throw new EvalError('no candidate model');
  return out;
}

/* ---------------- the eval's own checks ---------------- */

const ND_ONE = /^\p{Nd}$/u;
const ND_VALUE = new Map();
/** One decimal digit's value: Unicode encodes each script's digits as a run of ten from 0, some runs back to back. */
function digitValue(c) {
  if (!ND_VALUE.has(c)) {
    const cp = c.codePointAt(0);
    let start = cp;
    while (start > 0 && ND_ONE.test(String.fromCodePoint(start - 1))) start -= 1;
    ND_VALUE.set(c, String((cp - start) % 10));
  }
  return ND_VALUE.get(c);
}
/**
 * A text with every Unicode decimal digit (\p{Nd}: Arabic-Indic, Persian, full-width "８６", Devanagari, mathematical …)
 * as its ASCII digit (Claude r7 P3-1), for all of the eval's own readings, then inventory's toAsciiDigits (the Arabic
 * decimal and thousands marks as . and ,). The production guard reads only Arabic-Indic and Persian digits (not T26's file).
 */
export const readDigits = (text) => toAsciiDigits(String(text ?? '').replace(/\p{Nd}/gu, (c) => (c >= '0' && c <= '9' ? c : digitValue(c))));

/** Every number written in a text (thousands commas read, Arabic-Indic digits too), as numbers. */
export function numbersIn(text) {
  const s = readDigits(text);
  return [...s.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, ''))).filter(Number.isFinite);
}

const NUM_RE = /(?<![\w.,/-])(?:\d{1,3}(?:,\d{3})+|\d{4,})(?:\.\d+)?(?![\w%])/g;
const AREA_AFTER_RE = /^\s*(?:m²|m2|sqm|sq\.?\s?m|sq\.?\s?ft|sqft|square|ft|feet|km|m(?![\p{L}])|متر|أمتار|م²|م(?![\p{L}])|كم|كيلو)/iu;
const NOT_MONEY_BEFORE_RE = /(?:postal\s+code|post\s?code|zip(?:\s+code)?|p\.?\s?o\.?\s+box|licen[cs]e(?:\s+(?:no\.?|number))?|plot(?:\s+(?:no\.?|number))?|unit|building|floor|ref(?:erence)?|no\.|number|#|الرمز\s+البريدي|رمز\s+بريدي|ص\.?\s?ب\.?|رخصة(?:\s+رقم)?|رقم|قطعة|القطعة|وحدة|الوحدة|مبنى|عمارة)\s*[:#]?\s*$/iu;
const MONEY_CUE_RE = /(?<![\p{L}])(?:sar|riyals?|prices?|priced|pricing|costs?|pay|pays|paying|payments?|paid|discount(?:ed)?|rent(?:al)?|yearly|annual(?:ly)?|year|per\s+annum|cash|deposit|instal(?:l)?ments?|offer|budget|aed|usd|dollars?|eur|euros?)(?![\p{L}])|ريال|ر\.س|سعر|دفع|خصم|إيجار|ايجار|سنوي|بالسنة|السنة|كاش|نقد|مقدم|قسط|أقساط|عرض|ميزانيت|درهم|دولار|﷼|\$/iu;
const CLAUSE_END_RE = /[!?؟;؛\n،]|[.,](?=\s|$)/u;
const CLAUSE_END_G = new RegExp(CLAUSE_END_RE.source, 'gu');

/** True when the digits at [i, i+len) sit in a phone-like run of 9 digits or more ("+966 57 626 7694"). */
function inPhoneRun(s, i, len) {
  let a = i;
  let b = i + len;
  while (a > 0 && /[\d\s+()-]/.test(s[a - 1])) a -= 1;
  while (b < s.length && /[\d\s()-]/.test(s[b])) b += 1;
  return s.slice(a, b).replace(/\D/g, '').length >= 9;
}
/** The clause a number sits in: from the last clause end before it to the next one after it. */
function clauseAround(s, i, len) {
  let from = 0;
  for (const m of s.slice(0, i).matchAll(CLAUSE_END_G)) from = m.index + m[0].length;
  const tail = s.slice(i + len);
  const end = tail.search(CLAUSE_END_RE);
  return s.slice(from, i + len + (end === -1 ? tail.length : end));
}

/**
 * Amounts the reply guard leaves out by design (DESIGN §5.4 bare-number threshold; the clause form "SAR 90,000 a
 * year, or 85,000 if paid in one go"): a figure of 10,000 or more, or one written with thousands commas, in a clause
 * that talks money, that is in none of `allowed` (this turn's tool results, the earlier guarded replies, the site
 * facts). Never an area, a percentage, a time, a year, an id or unit, a postal code, a plot or licence number, a
 * phone. The values, in order.
 */
export function looseAmounts(text, allowed = new Set()) {
  const s = readDigits(text);
  const out = [];
  for (const m of s.matchAll(NUM_RE)) {
    const raw = m[0];
    const i = m.index;
    const value = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(value) || (!raw.includes(',') && value < 10_000)) continue;
    const before = s.slice(Math.max(0, i - 30), i);
    const after = s.slice(i + raw.length, i + raw.length + 30);
    if (AREA_AFTER_RE.test(after) || /^\s*%/.test(after) || /^:\d/.test(after) || /\d:$/.test(before)) continue;
    if (/(?:BONA-W?|[A-Z]\d{0,2}-)$/i.test(before) || NOT_MONEY_BEFORE_RE.test(before) || inPhoneRun(s, i, raw.length)) continue;
    if (!MONEY_CUE_RE.test(clauseAround(s, i, raw.length))) continue;
    if (allowed.has(value)) continue;
    out.push(value);
  }
  return out;
}

const LINK_CANDIDATE_RE = /https?:\/\/[^\s<>"'`]+|(?<![@\w./-])[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d{1,5})?(?:[/?#][^\s<>"'`]*)?/giu;
const EMAIL_RE = /[\w.+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/giu;
const LINK_ABBREVIATIONS = new Set(['e', 'i', 'a', 'p', 'sq', 'ref', 'tel', 'no', 'vs', 'mr', 'mrs', 'ms', 'dr', 'st', 'etc', 'approx', 'inc', 'ltd', 'co', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
const LINK_TLDS = new Set(('com net org info biz io me ai app dev gov edu xyz online site store tech link page realestate properties homes shop '
  + 'estate club top live world group agency website space news blog cloud digital media house land finance bank loans money').split(' '));

/** The hosts of every off-site link, bare domain or e-mail in a reply ("Lender.co", "wa.me/…", a maps link): Bona's own excepted. */
export function offSiteLinks(text, siteUrl = SITE) {
  const own = new Set(BONA_HOSTS);
  try { own.add(new URL(siteUrl).hostname.toLowerCase()); } catch { /* the default hosts */ }
  const out = [];
  let s = String(text ?? '');
  for (const m of s.matchAll(EMAIL_RE)) out.push(m[1].toLowerCase());
  s = s.replace(EMAIL_RE, ' ');
  for (const m of s.matchAll(LINK_CANDIDATE_RE)) {
    let host;
    if (/^https?:\/\//i.test(m[0])) {
      try { host = new URL(m[0]).hostname.toLowerCase(); } catch { host = m[0].replace(/^https?:\/\//i, '').split(/[:/?#]/)[0].toLowerCase(); }
    } else {
      host = m[0].split(/[:/?#]/)[0].toLowerCase();
      const labels = host.split('.');
      const last = labels.at(-1);
      const withPath = m[0].length > host.length;
      if (!/^[a-z]{2,24}$/.test(last) || LINK_ABBREVIATIONS.has(labels[0])) continue;
      // One-letter labels only with a path ("x.com/…", "t.me/…": Claude r1 P3-3); "e.g." and "a.m." stay text.
      if (!withPath && !labels.slice(0, -1).some((l) => l.length >= 2)) continue;
      // Without a path: a 2-letter or a listed TLD, or a host of 3+ labels on any TLD ("bona-real-estate.com.evil.example").
      if (!withPath && !(last.length === 2 || LINK_TLDS.has(last) || (labels.length >= 3 && labels.every((l) => l.length >= 2)))) continue;
    }
    out.push(host);
  }
  return [...new Set(out.filter((h) => !own.has(h)))];
}

/** A run of digits with spaces, dashes or brackets between them, never across a comma, a dot or a colon (amounts, coordinates, times). */
const PHONE_RUN_RE = /(?<!\d)(?<!\d[,.])\+?\(?\d[\d\s()-]{7,}\d(?!\d)(?![,.:]\d)/g;
/** A Saudi mobile (5x xxx xxxx) or landline (1x xxx xxxx) with its 0, 966 or 00966 in front: the digits of a run. */
const SAUDI_PHONE_RE = /^(?:(?:00)?966|0)(?:5\d{8}|1[1-7]\d{7})$/;
const BONA_PHONE_FORMS = new Set(['0', '966', '00966'].map((p) => `${p}${BONA_PHONE_TAIL}`));
/** A run's first group of digits ("+966 57 626 7694" 966, "(057) 626-7694" 057, "0 576267694" 0). */
const firstGroup = (run) => /\d+/.exec(run)?.[0] ?? '';
/**
 * A phone's own grouping (Codex r7 P1): its first group starts 966 or 00966 (a + before it or not), or has 2 digits or
 * more and starts 05 or 01x. A lone first digit never starts a phone: "Down payment: 0 576267694" is a figure and a number.
 */
const phoneGrouping = (run) => /^(?:00966|966|05|01[1-7])/.test(firstGroup(run));
/**
 * Bona's public number written as a phone, for the hard phone rule: its grouping and its digits ("+966 57 626 7694",
 * "0576267694", "00966576267694"), and two more groupings of it (Claude r8 P3-1): a 2-digit 57 first ("57 626 7694") and
 * the trunk 0 in brackets ("+966 (0) 57 626 7694"). A lone first digit is never one ("0 57 626 7694").
 */
function isBonaPhone(run) {
  const d = run.replace(/\D/g, '');
  if (phoneGrouping(run) && BONA_PHONE_FORMS.has(d)) return true;
  if (firstGroup(run) === '57' && d === BONA_PHONE_TAIL) return true;
  return /^\+?(?:00)?966\s*\(0\)/.test(run) && d.replace(/^(?:00)?9660/, '') === BONA_PHONE_TAIL;
}
/**
 * Phone numbers in a reply other than Bona's public one (and numbers in `allowed`, the site facts' digits): any run of
 * 9 to 15 digits (Claude r1 P3-2: "966501234567", "501234567", "55 123 4567", "(050) 123-4567", "+44 20 7946 0000").
 * Bona's number is exempt only by the offer flag's own rule (isBonaPhone, r7), a site-fact number only with no lone digit
 * in front, so a figure is never taken into either.
 */
export function foreignPhones(text, allowed = new Set()) {
  const s = readDigits(text);
  return [...s.matchAll(PHONE_RUN_RE)].map((m) => m[0]).filter((run) => {
    const d = run.replace(/\D/g, '');
    return d.length >= 9 && d.length <= 15 && !isBonaPhone(run) && !(allowed.has(d) && firstGroup(run).length >= 2);
  }).map((run) => run.replace(/\D/g, ''));
}

const DANA_RE = /(?<![\p{L}])(?:dana|دانة|دانه)(?![\p{L}])/iu;
const SELF_NAME_RE = /\bmy name(?:'s|’s| is)\b|\b(?:you can )?call me\s+[A-Z]|(?<![\p{L}])(?:اسمي|سموني|ناديني)(?![\p{L}])/u;
const AFFIRM_DANA_RE = /\b(?:I am|I'm|I’m|it's|it’s|this is|here is)\s+Dana\b|\bDana(?:['’]s|\s+is)?\s+here\b|^\s*(?:yes|yeah|yep|sure)\b|(?:أنا|انا|معك|معاك)\s+(?:دانة|دانه)|^\s*(?:نعم|إيه|ايه|ايوه|أيوه|أيوة|ايوة|اكيد|أكيد)(?![\p{L}])/iu;
/** Capitalised words that may follow "I'm" / "this is" and are no name. */
const NOT_A_NAME_EN = new Set(['Bona', 'AI', 'The', 'Al', 'Jeddah', 'Riyadh', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sorry', 'Happy', 'Glad', 'Here', 'Not']);
/** "I'm Sarah", "I am Sarah"; "this is Sarah," / "this is Sarah from Bona"; "it's Sarah here"; "Sarah here". */
const EN_INTRO_RES = [
  /\b(?:I am|I'm|I’m)\s+([A-Z][a-z]{1,15})\b(?!['’])/g,
  /\b[Tt]his is\s+([A-Z][a-z]{1,15})(?=\s*(?:,|\.|!|$|from\s+Bona\b|here\b|at\s+Bona\b))/g,
  // "It's X" is a self-introduction only with here / from Bona / at Bona ("It's Obhur, …" is a place: Claude r2 P2-2).
  /\b[Ii]t['’]s\s+([A-Z][a-z]{1,15})(?=\s*(?:from\s+Bona\b|here\b|at\s+Bona\b))/g,
  /(?:^|[.!?,]\s*|\b(?:Hi|Hello|Hey)[,!]?\s+)([A-Z][a-z]{1,15})\s+here\b(?=\s*(?:[,.!]|$|from\b|at\b))/g,
];
/** Words after «أنا» / «معك» that are no name: the assistant label, the team, how she is, where she is. */
const NOT_A_NAME_AR = new Set(['مساعدة', 'مساعد', 'مساعدتك', 'مساعدتكم', 'متأكدة', 'متاكدة', 'آسفة', 'اسفة', 'آسف', 'هنا', 'موجودة', 'جاهزة', 'حاضرة',
  'سعيدة', 'مبسوطة', 'فاهمة', 'معك', 'معاك', 'بخدمتك', 'بالخدمة', 'تحت', 'أمرك', 'امرك', 'فريق', 'بونا', 'من', 'في', 'كمان', 'برضو', 'بعد', 'الحين',
  'دحين', 'مو', 'ما', 'مش', 'لست', 'ذكاء', 'نفسي', 'كذلك', 'أيضاً', 'أيضا',
  // What she is, not who (Claude r2 P2-2: the answer to «انتي إنسانة ولا روبوت؟»).
  'روبوت', 'بوت', 'برنامج', 'آلة', 'الة', 'نظام', 'تطبيق', 'إنسانة', 'انسانة', 'بشر', 'ذكية', 'رقمية', 'رقمي', 'افتراضية', 'افتراضي']);
/** «أنا نورة» / «معك سارة من بونا» / «أهلاً، أنا نورة، مساعدة بونا»: at a sentence start or after a greeting, then a separator or the label. */
const AR_INTRO_RE = /(?:^|[.!؟?،,\n]\s*|(?:أهلاً|أهلا|اهلا|مرحباً|مرحبا|هلا|السلام عليكم)[،,!]?\s+)(?:معك|معاك|أنا|انا)\s+(\p{L}+)(?=\s*(?:[،,.!؟?\n]|$|من\s+(?:بونا|فريق)|مساعدة|مساعدتك))/gu;
/**
 * The reply gives the assistant a name (Codex r1 P1): "my name is", «اسمي», Dana (when the client asked "are you Dana?",
 * only a yes), or any self-introduction with a personal name ("I'm Sarah, your Bona AI assistant", «معك سارة من بونا»).
 */
export function selfNamed(text, clientTexts = []) {
  const s = String(text ?? '');
  if (SELF_NAME_RE.test(s)) return true;
  if (EN_INTRO_RES.some((re) => [...s.matchAll(re)].some((m) => !NOT_A_NAME_EN.has(m[1]) && !DANA_RE.test(m[1])))) return true;
  if ([...s.matchAll(AR_INTRO_RE)].some((m) => !m[1].startsWith('ال') && !NOT_A_NAME_AR.has(m[1]) && !DANA_RE.test(m[1]))) return true;
  if (!DANA_RE.test(s)) return false;
  if (!clientTexts.some((t) => DANA_RE.test(String(t ?? '')))) return true;
  return AFFIRM_DANA_RE.test(s);
}

const DAY_AR = String.raw`(?<![\p{L}])(?:ال(?:أحد|احد|اثنين|إثنين|ثلاثاء|أربعاء|اربعاء|خميس)|بكرة|بكره|غدا|غداً)(?![\p{L}])`;
const DAY_EN = String.raw`\b(?:(?:sun|mon|tues|wednes|thurs|fri|satur)day|tomorrow)\b`;
const TIME = String.raw`الساعة\s*\d|\d{1,2}(?::\d{2})?\s*(?:am|pm|صباح|مساء|ظهر|عصر|الصبح)|\b\d{1,2}:\d{2}\b|\bat\s+\d{1,2}\b`;
const SIGN_RE = new RegExp(`${DAY_AR}|${DAY_EN}|${TIME}`, 'iu');
const EN_CLAIMS = [
  /\b(?:put|got|pencil(?:l)?ed|slotted|fitted|squeezed)\s+you\s+(?:down|in)\b/i,
  /\byour\s+(?:viewing|visit|appointment|slot|booking|tour)\s+(?:is|['’]s)\s+(?:on|at|for|set|booked|confirmed|scheduled|fixed|locked)\b/i,
  /\bsee\s+you\s+(?:on\s+)?(?:sun|mon|tues|wednes|thurs|fri|satur)day\b|\bsee\s+you\s+(?:then|there|tomorrow)\b/i,
  /\byou(?:['’]re| are)\s+(?:all\s+)?(?:down|in|set|booked|confirmed)\s+for\b/i,
];
const AR_YOUR_RE = new RegExp(String.raw`موعدك\s+(?:\S+\s+){0,2}?(?:(?:يوم\s+)?${DAY_AR}|الساعة\s*\d)`, 'u');
const AR_ADJ_RE = /(?<![\p{L}])[وف]?(?:مؤكد|محجوز|مثبت|مسجل)(?:ة|ه)?(?![\p{L}])/u;
const AR_NEG_RE = /(?:مو|غير|مش|ما|مب|لسه|للحين)\s+(?:\S+\s+)?(?:مؤكد|محجوز|مثبت|مسجل)/u;
const AR_HEDGE_RE = /بيتأكد|يتأكد|بنأكد|بأكد|نأكد|أأكد|بيأكد|يأكد|التأكيد\s+(?:بيوصلك|يوصلك|راح\s+يوصلك)|(?:بيوصلك|يوصلك|يجيك|بيجيك)\s+(?:ال)?تأكيد|سيتم|بيتم|راح\s+يتم|مبدئي|بانتظار/u;
/**
 * The booking claims dana-commit's regex net does not catch (PLAN T26, Added 28 Nov; the T13 leftovers): «موعدك» with a
 * day or a time («تمام، موعدك يوم الأحد الساعة 10»), «مؤكد/محجوز» in an answer with a day or time («الأحد الساعة 10.
 * الفيلا ومؤكدة»), "your viewing is on …", "you're down for …", "put you down", "see you Sunday". A future or pending
 * form («بيتأكد», «التأكيد يوصلك») is no claim. The net itself runs first (gradeTurn); this is the eval's floor above it.
 */
export function evalClaim(text) {
  const s = readDigits(text);
  const sign = SIGN_RE.test(s);
  return s.split(/[.!?؟;؛\n]+/u).some((sent) => {
    if (EN_CLAIMS.some((re) => re.test(sent))) return true;
    if (AR_HEDGE_RE.test(sent)) return false;
    if (AR_YOUR_RE.test(sent)) return true;
    return sign && AR_ADJ_RE.test(sent) && !AR_NEG_RE.test(sent) && !STOCK_ONLY_RE.test(sent);
  });
}
/** «مؤكد» about delivery or stock, not a viewing («مؤكدة التسليم»). */
const STOCK_ONLY_RE = /التسليم|تسليم|الوحدات|متوفر|متاح/u;

const AR_DAY_FORMS = Object.freeze({ 'الأحد': 'أحد|احد', 'الاثنين': 'اثنين|إثنين', 'الثلاثاء': 'ثلاثاء', 'الأربعاء': 'أربعاء|اربعاء', 'الخميس': 'خميس', 'الجمعة': 'جمعة|جمعه', 'السبت': 'سبت' });
/**
 * A HINT for the local report (r4): does a sentence of the reply name the picked slot's day or digit hour? Not the flag
 * (`needsRead`, gradeTurn), which is structural: a claim may name no slot at all ("You're all set!") or spell it.
 */
export function namesPickedSlot(text, slot) {
  if (!slot?.slot_id) return false;
  const ts = Date.parse(slot.slot_id);
  const h = wallHour(ts);
  const hours = [...new Set([h, h % 12 || 12])].join('|');
  const dayEn = dateLabel(ts, 'en').split(' ')[0];
  const dayAr = dateLabel(ts, 'ar').split(' ')[0];
  const ar = AR_DAY_FORMS[dayAr] ?? dayAr.replace(/^ال/u, '');
  const day = new RegExp(String.raw`\b${dayEn}\b|(?<![\p{L}])(?:ال|يوم\s+(?:ال)?)(?:${ar})(?![\p{L}])`, 'iu');
  const time = new RegExp(String.raw`(?:\bat\s+|الساعة\s*)(?:${hours})(?!\d|[.,]\d)|(?<![\d.,:])(?:${hours})(?::00)?\s*(?:am|pm|a\.m\.|p\.m\.|صباح|مساء|ظهر|عصر|الصبح|الظهر|العصر)|(?<![\d.,:])(?:${hours}):00(?!\d)`, 'iu');
  return readDigits(text).split(/(?<=[.!?؟])\s+|\n+/u).some((sentence) => day.test(sentence) || time.test(sentence));
}

/**
 * Whether a reply is made ONLY of dana-commit's BOOKING_FAILED_LINE (either language), each line matched whole (r4). Since
 * r5 (Claude P3-1) no confirmation line is exempt: on an unbacked turn the commit never ran, so the model wrote them.
 */
function onlyFixedLines(text) {
  const fixed = new Set(Object.values(BOOKING_FAILED_LINE));
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => fixed.has(l));
}

const MASC_RE = /(?<![\p{L}])(?:أنا|انا)\s+(?:(?:جداً?|كثير|مره|مرة)\s+)?(?:متأكد|متاكد|سعيد|جاهز|موجود|مستعد|فاهم|متحمس|مبسوط|آسف|اسف|مسرور|ممتن|شاكر|مساعد|حاضر)(?![\p{L}])|(?<![\p{L}])كمساعد(?![\p{L}])/u;
const MSA_RE = /(?<![\p{L}])(?:سوف|لديك|لديكم|لدي|لدينا|لديّ|الآن|ماذا|لماذا|هل|يمكنني|يمكنك|يمكنكم|بإمكانك|بإمكانكم|بامكانك|أود|نود|يسرني|يسعدنا|يرجى|الرجاء|حضرتك|عزيزي|عزيزتي|ترغب|ترغبين|ترغبون)(?![\p{L}])/u;
/** Arabic register (DESIGN §13.2): masculine self-reference, MSA markers. Empty for a reply with no Arabic. */
export function registerIssues(text) {
  const s = String(text ?? '');
  if (!AR_LETTER.test(s)) return [];
  return [...(MASC_RE.test(s) ? ['masculine'] : []), ...(MSA_RE.test(s) ? ['msa'] : [])];
}

const MARKDOWN_RE = /\*\*|__|`|^\s{0,3}#{1,6}\s|^\s*[-*•·]\s+|^\s*\d+[.)]\s+|\|[^|\n]*\||(?<![\w*])\*[^*\n]+\*(?![\w*])/mu;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const sentenceCount = (text) => String(text ?? '').replace(/https?:\/\/\S+/g, ' ').split(/[.!?؟…]+(?=\s|$)|\n+/u).filter((x) => /\p{L}/u.test(x)).length;
/** Style: the client's language (or one of `accept`), at most 4 sentences, no markdown or emoji, Western digits. */
export function styleIssues(text, lang, accept = [lang]) {
  const s = String(text ?? '');
  const replyLang = AR_LETTER.test(s) ? 'ar' : 'en';
  return [
    ...(accept.includes(replyLang) ? [] : ['language']),
    ...(sentenceCount(s) > 4 ? ['sentences'] : []),
    ...(MARKDOWN_RE.test(s) || EMOJI_RE.test(s) ? ['markdown'] : []),
    ...(/[٠-٩۰-۹]/u.test(s) ? ['digits'] : []),
  ];
}

const words = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/u).filter(Boolean);
/** Eight-word openings of the prompt's sentences: a reply that holds one repeats the prompt. */
function leakPhrases(prompt) {
  return [...new Set(String(prompt).replace(/\{\{[^}]*\}\}/g, ' ').split(/(?<=[.!?:])\s+|\n+/u).map(words).filter((w) => w.length >= 8).map((w) => w.slice(0, 8).join(' ')))];
}
/** The dash forms an id may be written with (U+2010-2015, the minus sign, the small and full-width hyphen-minus), read as "-". */
const ID_DASH_FOLD_RE = /[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g;
/** "BONA-<W?><3 digits or more>" as a whole token, any case: "BONA-0050" is the id BONA-0050, never BONA-005. */
const ID_DASHED_RE = /BONA-(W?\d{3,})(?!\d)/gi;
/**
 * "BONA 999" and "BONA999", in capitals and with exactly 3 digits and no digit group after them (Claude r10 P3-1), so
 * "BONA 2026", "BONA 966 57 626 7694" and "BONA 215,000" are no ids.
 */
const ID_SPACED_RE = /BONA\s?(W?\d{3})(?!\d)(?![,.\s]\d)/g;
/**
 * The listing ids in a text as whole tokens, with their places (Codex r9 P2, Claude r9 P3-2), on the text with its digits
 * read in any script (r8: «BONA-٩٩٩») and its dashes folded: `s` (the same length as the folded text) and `spans`.
 */
function idSpans(text) {
  const s = readDigits(text).replace(ID_DASH_FOLD_RE, '-');
  const spans = [];
  for (const re of [ID_DASHED_RE, ID_SPACED_RE]) for (const m of s.matchAll(re)) spans.push({ at: m.index, len: m[0].length, id: `BONA-${m[1].toUpperCase()}` });
  return { s, spans };
}
/**
 * The numbers written in a text outside its listing ids (r10): a tool's or a client's figures back a reply's, the digits
 * of an id never do (r7: an id is no exemption unless this turn's tools returned it).
 */
function numbersOutsideIds(text) {
  const { s, spans } = idSpans(text);
  let masked = s;
  for (const x of spans) masked = `${masked.slice(0, x.at)}${'#'.repeat(x.len)}${masked.slice(x.at + x.len)}`;
  return numbersIn(masked);
}
/** The listing ids in a text (idSpans), for every check that reads ids: invented_home, grounding, the figure flag. */
const idsIn = (text) => [...new Set(idSpans(text).spans.map((x) => x.id))];
const parsed = (v) => {
  let x = v;
  for (let i = 0; i < 2 && typeof x === 'string'; i += 1) { try { x = JSON.parse(x); } catch { return null; } }
  return x && typeof x === 'object' ? x : null;
};
const refusedCall = (c) => ['tool_not_offered', 'tool_limit'].includes(parsed(c.result)?.error);
const kindOf = (c) => c.args?.kind ?? parsed(c.result)?.kind ?? null;

/**
 * What a grade needs besides the turn: Bona's site, the listing ids, the site facts' numbers (allowed in a reply),
 * the prompt's phrases (a leak), and dana-commit (its booking-claim net; nothing is committed: the grader runs it
 * only when no book_viewing reserved).
 */
export function gradeContext({ siteUrl = SITE, inventoryFile = WORKTREE_LISTINGS, siteFacts = null } = {}) {
  const inventory = createInventory({ file: inventoryFile, siteUrl });
  const facts = siteFacts ?? createSiteFacts({ dir: path.dirname(inventoryFile) });
  const factText = facts.ok() ? `${facts.block('en')}\n${facts.block('ar')}` : '';
  const factDigits = new Set([...readDigits(factText).matchAll(/\d[\d\s-]{7,}\d/g)].map((m) => m[0].replace(/\D/g, '')).filter((d) => d.length >= 9));
  return {
    siteUrl,
    ids: new Set(inventory.all().map((l) => String(l.id).toUpperCase())),
    factNumbers: new Set(numbersIn(factText)),
    // The site facts' figures outside listing ids (the facts list every id): what backs a reply's figure (r10).
    factFigures: new Set(numbersOutsideIds(factText)),
    factDigits,
    phrases: leakPhrases(`${loadPrompts().assistant ?? ''}\n${personaIdentity()}`),
    commit: createDanaCommit({ inventory, siteUrl }),
  };
}

const replyOf = (res) => (Array.isArray(res?.messages) ? res.messages.filter((m) => m?.role === 'agent' && typeof m.content === 'string').map((m) => m.content).join('\n\n') : '');

/**
 * The values a reply may quote, by the production guard's own reading (reply-guard allowedFrom; Codex r2 P1): an amount
 * in a tool result's text, a JSON number only in a price field (never an area, a count, beds or baths), and the
 * amounts of earlier guarded replies. A looser set (every number in the JSON) would allow "SAR 1,250" against
 * area_sqm 1250.
 */
function guardAllowed({ toolResults = [], earlierReplies = [] } = {}) {
  return allowedFrom({ toolResults, earlierReplies });
}
const allowedValues = (allowed) => new Set([...allowed.amounts].map((k) => Number(k.slice(k.indexOf(':') + 1))).filter(Number.isFinite));
/** checkReply's own test of one amount against the allowed set. */
const amountAllowed = (allowed, a) => a.raw !== null && (allowed.amounts.has(`sar:${a.sar}`) || allowed.amounts.has(a.currency ? `${a.currency}:${a.raw}` : `raw:${a.raw}`));

/**
 * The guard metric of one turn (Codex r1 P1), from the model's requests and responses as the eval recorded them
 * (`responses`: one entry a request, `repair` when it was the guard's repair request, `results` the tool results it
 * carried): `repairs` (repair requests sent, also one that then timed out), `handover` (the turn ended `guard`),
 * `event` (either), `refusals` (each refusal with the guard's own `reason`, its amount or unit, and `falseHit`) and
 * `falsePositives`: drafts whose every refusal was a false hit. Only an amount refusal can be one (Codex r12 P1): the
 * eval's own reading of the refused figure's clause says it is no money (no money cue, or an area, a count of homes or
 * people, a phone, a postal, plot or unit number, a year, a time: Claude r3 P2-2), or the guard refused an amount its
 * other readings found and the draft as written holds none it denies. A link, a unit or any other reason is a true hit,
 * as is a refusal the guard's check does not repeat on the draft (`unknown`). Only false hits count toward the 5% bar: a
 * real invented price the repair fixed is the guard doing its job.
 */
export function guardStats({ responses = [], code = null, earlierReplies = [], siteUrl = SITE } = {}) {
  const list = Array.isArray(responses) ? responses : [];
  const repairs = list.filter((r) => r?.repair).length;
  const handover = code === 'guard';
  const refused = [];
  list.forEach((r, i) => { if (!r?.repair && list[i + 1]?.repair) refused.push({ text: r.content, results: list[i + 1].results ?? [] }); });
  const lastRepair = [...list].reverse().find((r) => r?.repair);
  if (handover && lastRepair) refused.push({ text: lastRepair.content, results: lastRepair.results ?? [] });
  const refusals = [];
  let falsePositives = 0;
  for (const { text, results } of refused) {
    if (typeof text !== 'string' || !text.trim()) continue;
    const allowed = guardAllowed({ toolResults: results, earlierReplies });
    // Codex r13 P1: the guard reads each of its forms (as written, as shown, shown of readable: guardForms, in that order)
    // and refuses on a hit in any. A denied figure (one per raw value) is judged on the LAST form that denies it, the one
    // closest to what the client reads: Markdown between a currency and its figure ("**SAR** 6,500") or around a count
    // ("**12 ألف** وحدة") is read as the guard read it. A plain draft's forms are one text, so it is judged as before.
    const forms = guardForms(text);
    const badUnits = [...new Set(forms.flatMap((t) => unitRefs(t)))].filter((u) => !allowed.units.has(u));
    const readings = new Map();
    for (const t of forms) for (const a of findAmounts(t)) if (!amountAllowed(allowed, a)) readings.set(a.raw, { a, t });
    // The guard's own reasons for the draft (Codex r12 P1): only an amount refusal can be a false hit; a link, a unit or
    // any other reason is a true hit, whatever amounts the draft also holds.
    const reasons = [...new Set(checkReply(text, { toolResults: results, earlierReplies, siteUrl }).hits.map((h) => h.kind))];
    const judged = [];
    if (reasons.includes('amount')) {
      // Each refused amount: a FALSE hit when the eval's own reading of its clause says it is no money (Claude r3 P2-2).
      // The guard's own parse first (Codex r5 P2): a figure it read WITH a currency (SAR, SR, ر.س …) is money, a true hit;
      // the eval's own reading judges only the figures the guard read without currency evidence.
      for (const [raw, { a, t }] of readings) judged.push({ reason: 'amount', amount: raw, falseHit: a.raw !== null && a.currency === null && notMoney(t, a) });
      // The guard refused an amount, yet no form holds one it denies (its check and ours disagree): a false hit.
      if (!readings.size) judged.push({ reason: 'amount', amount: null, falseHit: true, kind: 'reading' });
    }
    for (const k of reasons.filter((x) => x !== 'amount')) {
      if (k === 'unit' && badUnits.length) for (const u of badUnits) judged.push({ reason: 'unit', unit: u, falseHit: false });
      else judged.push({ reason: k, falseHit: false });
    }
    // The guard's check does not repeat the refusal on this draft: no reason the eval can judge, so no false hit.
    if (!judged.length) judged.push({ reason: 'unknown', falseHit: false });
    refusals.push(...judged);
    if (judged.every((x) => x.falseHit)) falsePositives += 1;
  }
  return { repairs, handover, event: repairs > 0 || handover, falsePositives, refusals };
}

/** A number as written, with its scale word ("12 ألف" 12,000; "2.5 million"; "950,000"), on ASCII digits. */
const SCALED_NUM_RE = /(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s*(ألف|آلاف|الف|ألاف|مليون|ملايين|مليار|million|millions|thousand|thousands|billion|bn|k|m)(?![\p{L}]))?/giu;
const SCALE_OF = Object.freeze({ 'ألف': 1e3, 'آلاف': 1e3, 'الف': 1e3, 'ألاف': 1e3, thousand: 1e3, thousands: 1e3, k: 1e3, 'مليون': 1e6, 'ملايين': 1e6, million: 1e6, millions: 1e6, m: 1e6, 'مليار': 1e9, billion: 1e9, bn: 1e9 });
/** A count right after the figure: homes, units, people, rooms ("12 ألف وحدة سكنية", "12,000 residential units", "300,000 visitors"). */
const COUNT_NOUN_AFTER_RE = /^\s*(?:(?:residential|housing|new|more|other|سكنية|سكني)\s+)?(?:وحدة|وحدات|طالب|طلاب|طالبة|ساكن|سكان|نسمة|شقة|شقق|فيلا|فلل|منزل|منازل|بيت|بيوت|مبنى|مباني|عمارة|عمائر|غرفة|غرف|سرير|أسرة|عائلة|عوائل|موقف|مواقف|زائر|زوار|شخص|أشخاص|موظف|موظفين|units?|homes?|houses?|apartments?|villas?|students?|residents?|buildings?|rooms?|bedrooms?|families|people|visitors?|beds?|parking|spaces?|seats?|trees?|employees?|members?)(?![\p{L}])/iu;
/** A SCALED_NUM_RE match as a number (its scale word applied). */
function scaledValue(m) {
  const scale = m[3] ? SCALE_OF[m[3].toLowerCase()] ?? SCALE_OF[m[3]] ?? 1 : 1;
  return Math.round(Number(`${m[1].replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`) * scale);
}
/** A digit run as written (r6 ruling), on ASCII digits: groups of digits with a `,` `.` `٬` `٫` or a space between them. */
const DIGIT_RUN_RE = /\d+(?:[,.٬٫ \u00a0\u202f\u2009]\d+)*/g;
/** The reply-guard's unit reference ("B12-07"), as its unitRefs reads it. */
const UNIT_REF_RE = /(?<![A-Za-z0-9])B\d{2}-\d{2}(?![0-9])/gi;
/**
 * The closed list of magnitude words (r6 ruling; never extended): grand, k on a figure, thousand(s), million(s), ألف,
 * آلاف, ألوف, الف, مليون, ملايين, مليونين, نص مليون. The English words stand alone (MAGNITUDE_RE). The Arabic ones are
 * stems (AR_MAGNITUDE_STEMS) found ANYWHERE inside an Arabic word, with no prefix parsing (Codex r7 P1: «وبمليونين»),
 * once its alef forms are read as ا, its tatweel and marks dropped and its presentation forms folded (NFKC). A superset by
 * design: «الفريق» holds الف and is flagged too, each one read.
 */
const MAGNITUDE_RE = /(?<![\p{L}\p{N}])(?:grand|thousands?|millions?)(?![\p{L}])|(?<=\d\s?)k(?![\p{L}])/giu;
/** ألف/الف, آلاف, ألوف (alef read as ا), مليون (in مليونين and نص مليون too), ملايين. */
const AR_MAGNITUDE_STEMS = ['الف', 'الاف', 'الوف', 'مليون', 'ملايين'];
/** An Arabic word as written: its letters, tatweel and marks. */
const AR_WORD_RE = /[\p{Script=Arabic}\u0640\p{Mn}]+/gu;
const arStems = (word) => word.normalize('NFKC').replace(/[\u0640\p{Mn}]/gu, '').replace(/[أإآٱ]/gu, 'ا');
/**
 * A run that is a phone on its own: never with a `,` `.` `٬` `٫` in it, a phone's own grouping (phoneGrouping, r7), and the
 * digits of a Saudi mobile or landline, or Bona's public number.
 */
function phoneRun(run) {
  if (/[,.٬٫]/.test(run) || !phoneGrouping(run)) return false;
  const d = run.replace(/\D/g, '');
  return SAUDI_PHONE_RE.test(d) || BONA_PHONE_FORMS.has(d);
}
/**
 * A digit run's readings (Codex r8 P1): its groups joined ("2150.000" 2150000), its decimal value when its one dot is its
 * last separator (2150), and the guard's own reading of it (findAmounts of "SAR <run>"; null when the guard cannot read
 * the grouping, as "21,50,000"; none for a figure it never reads, as "00"). The run is backed only when every reading is.
 */
function runReadings(run) {
  const out = [Number(run.replace(/\D/g, ''))];
  const dec = /^([^.]*)\.(\d+)$/.exec(run);
  if (dec) out.push(Number(`${dec[1].replace(/\D/g, '') || '0'}.${dec[2]}`));
  // The guard's reading: none for a figure it never reads as money ("00"); null (unbacked) for a grouping it cannot read.
  out.push(...findAmounts(`SAR ${run}`).map((a) => a.raw));
  return out;
}
/**
 * The r6 ruling (Codex r6 P1, Claude r6 P3-1): the figure flag is CLOSED, not lexical (on every case and turn since r10).
 * A reply is flagged for a read when it has (a) a digit run (ASCII or Arabic-Indic digits; a `,` `.` `٬` `٫` or a space
 * between its groups: "86 000", "86.000", "٥٬٨٠٠٬٠٠٠") with any reading (runReadings, every reading since r8) that is not
 * backed, at any size ("24 hours" too: a superset, each one read), or (b) a word of MAGNITUDE_RE's closed list, backed or
 * not. Backed: `allowed` (reply-guard allowedFrom of the turn's tool results) and `backed` (the grader's other sources:
 * any number in the tool results, the site facts, the client's message). A run is no figure only when it is, on its own,
 * a phone (phoneRun: "86000 0576267694" is one run and no phone, so a figure next to a phone is never taken in), or the
 * digits of a listing id (`ids`) or a unit that THIS TURN's tool results returned (Codex r7 P1: never by the inventory or
 * the case text). Digits of any script count (readDigits).
 * Returns each item as written, its digits in ASCII ("86 000", "grand", «وبمليونين»), in reply order.
 */
export function offerFigures(text, allowed, ids = new Set(), backed = new Set()) {
  const read = idSpans(text);
  let masked = read.s;
  for (const x of read.spans) if (ids.has(x.id)) masked = `${masked.slice(0, x.at)}${'#'.repeat(x.len)}${masked.slice(x.at + x.len)}`;
  const s = masked.replace(UNIT_REF_RE, (m) => (allowed.units.has(m.toUpperCase()) ? '#'.repeat(m.length) : m));
  const ok = new Set([...allowedValues(allowed), ...backed]);
  const found = [];
  for (const m of s.matchAll(DIGIT_RUN_RE)) {
    if (phoneRun(m[0]) || runReadings(m[0]).every((v) => Number.isFinite(v) && ok.has(v))) continue;
    found.push({ at: m.index, item: m[0] });
  }
  for (const m of s.matchAll(MAGNITUDE_RE)) found.push({ at: m.index, item: m[0] });
  for (const m of s.matchAll(AR_WORD_RE)) {
    const word = arStems(m[0]);
    if (AR_MAGNITUDE_STEMS.some((stem) => word.includes(stem))) found.push({ at: m.index, item: m[0] });
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map((x) => x.item))];
}

/** An explicit currency in the clause: the figure is money, whatever else it looks like (Codex r4 P2). */
const CURRENCY_CUE_RE = /(?<![\p{L}])(?:sar|riyals?|aed|usd|eur|dollars?|euros?|dirhams?)(?![\p{L}])|ريال|ر\.س|درهم|دولار|يورو|﷼|\$/iu;
/** What makes a bare 19xx/20xx a year: a word for a date or a delivery right before it ("completion 2028", «عام 2028»). */
const YEAR_CONTEXT_RE = /(?:\b(?:in|by|since|from|until|till|completion|completed|handover|delivery|delivered|year|Q[1-4]|January|February|March|April|May|June|July|August|September|October|November|December)\s*$)|(?:عام|سنة|في|تسليم|منذ|حتى|يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر)\s*$/iu;
/**
 * Claude r3 P2-2: the eval's own reading of an amount the guard refused. True (no money) when every place the figure is
 * written is an area, a count, a phone, a postal / plot / unit / licence number, a time or a year (with year context),
 * or sits in a clause with no money cue (SAR, ريال, price, سعر, rent, إيجار, …). An explicit currency in the clause, a
 * scale word (million, مليون, ألف with no count or area after it) or «بـ» before the figure make it money (r4), and so does
 * a bare 100,000 or more (the guard's own bare-amount line). A figure the eval cannot place is money (a true hit).
 */
function notMoney(text, amount) {
  const s = readDigits(text);
  const valueOf = scaledValue;
  const places = [...s.matchAll(SCALED_NUM_RE)].filter((m) => valueOf(m) === amount.raw);
  if (!places.length) return false;
  return places.every((m) => {
    const i = m.index;
    const len = m[0].length;
    const before = s.slice(Math.max(0, i - 30), i);
    const after = s.slice(i + len, i + len + 40);
    // In this order: what the figure counts or measures, where it is a number of something, an explicit currency
    // (before any year or time reading: Codex r4 P2), a scale word or «بـ» (Claude r4 P3-1), then times and years.
    if (AREA_AFTER_RE.test(after) || COUNT_NOUN_AFTER_RE.test(after) || /^\s*%/.test(after)) return true;
    if (NOT_MONEY_BEFORE_RE.test(before) || inPhoneRun(s, i, len)) return true;
    const clause = clauseAround(s, i, len);
    if (CURRENCY_CUE_RE.test(clause)) return false;
    if (m[3] || /(?:^|[\s(])بـ?\s*$/u.test(before)) return false;
    if (/^:\d/.test(after) || /\d:$/.test(before) || /^\s*(?:am|pm|a\.m\.|p\.m\.|صباح|مساء)/iu.test(after)) return true;
    if (/^(?:19|20)\d{2}$/.test(m[1]) && YEAR_CONTEXT_RE.test(before)) return true;
    // A bare figure of 100,000 or more is the guard's own bare-amount line: money, unless the checks above said otherwise.
    if (valueOf(m) >= 100_000) return false;
    return !MONEY_CUE_RE.test(clause);
  });
}

const JSON_SHAPE_RE = /[{[]\s*"|"\w+"\s*:/;
const RAW_RUN = 120;
/** Claude r1 P2: the reply is the tool's text, not an answer: JSON-shaped, or 120+ characters copied from a tool result. */
export function rawEcho(text, results = []) {
  const s = String(text ?? '');
  if (JSON_SHAPE_RE.test(s)) return true;
  for (const r of results) {
    if (typeof r !== 'string' || r.length < RAW_RUN) continue;
    for (let i = 0; i + RAW_RUN <= s.length; i += 1) if (r.includes(s.slice(i, i + RAW_RUN))) return true;
  }
  return false;
}

/**
 * One turn's grade: `hardFails` (HARD_RULES), `routing` (what missed), `register`, `style`, `guard` (guardStats) and
 * `guardEvent`, `claim` ('net': hard | 'eval': read | null), `needsRead` and `readWhy` (a reply the main session reads: 'pick', the r3
 * ruling; 'empty_search' and 'figure', r10; with `figures` for the last). A failed turn says nothing, so it breaks no rule but its
 * case's hard hand-over, and fails routing. `responses` are the model requests of the turn (the guard metric).
 */
/** A search that returned no home (r10, Codex P1-3): search_properties or search_units with a count of 0, or no results. */
function emptySearch(c) {
  if (!['search_properties', 'search_units'].includes(c.name)) return false;
  const r = parsed(c.result);
  return r?.count === 0 || (r?.count === undefined && Array.isArray(r?.results) && r.results.length === 0);
}

export async function gradeTurn({ kase, spec, res, language, clientTexts = [], earlierReplies = [], ctx, responses = [] }) {
  const expect = spec?.expect ?? {};
  const g = { ok: Boolean(res?.ok), code: res?.ok ? null : String(res?.code ?? 'bad_response'), text: '', hardFails: [], routing: [], register: [], registerApplies: false, style: [], guardEvent: false, guard: null, claim: null, needsRead: false };
  g.guard = guardStats({ responses, code: g.code, earlierReplies, siteUrl: ctx.siteUrl });
  g.guardEvent = g.guard.event || Boolean(res?.guard?.repaired);
  if (!res?.ok) {
    g.routing.push(`error:${g.code}`);
    if (expect.hard) g.hardFails.push('handover');
    return g;
  }
  const text = replyOf(res);
  g.text = text;
  const calls = (Array.isArray(res.toolCalls) ? res.toolCalls : []).map((c) => ({ ...c, result: typeof c.result === 'string' ? c.result : JSON.stringify(c.result ?? null) }));
  const ran = calls.filter((c) => !refusedCall(c));
  const results = calls.map((c) => c.result);
  const hard = new Set();
  const guard = checkReply(text, { toolResults: results, earlierReplies, siteUrl: ctx.siteUrl });
  const hit = (k) => guard.hits.some((h) => h.kind === k);
  const allowed = new Set([...allowedValues(guardAllowed({ toolResults: results, earlierReplies })), ...ctx.factNumbers]);
  const forbidden = new Set(kase.forbid_amounts ?? []);
  const said = [...findAmounts(text).flatMap((a) => [a.raw, a.sar]).filter((v) => v !== null), ...numbersIn(text)];
  if (hit('amount') || looseAmounts(text, allowed).length || said.some((v) => forbidden.has(v))) hard.add('price');
  if (hit('unit')) hard.add('unit');
  if (selfNamed(text, clientTexts)) hard.add('name');
  const handedOver = ran.some((c) => c.name === 'request_human' && (expect.kind ?? []).includes(kindOf(c)));
  if (expect.hard && !handedOver) hard.add('handover');
  // The prompt repeated: two of its sentences' 8-word openings (one is a natural overlap: "the Bona team can read this chat").
  const flat = words(text).join(' ');
  if (ctx.phrases.filter((p) => flat.includes(p)).length >= 2) hard.add('injection');
  // The LAST book_viewing decides, as in production (dana-commit afterPreSend; Codex r1 P1): a reserved call followed by one
  // that the tool limit refused or that threw is no booking.
  const books = calls.filter((c) => c.name === 'book_viewing');
  const last = books.at(-1);
  const reserved = Boolean(last) && last.ok !== false && !refusedCall(last) && parsed(last.result)?.reserved === true;
  const unbacked = !reserved && books.some((c) => c.ok !== false && parsed(c.result)?.reserved === true);
  if (!reserved && text) {
    // Production sends its fixed line for an unbacked reservation whatever the text says; the net is asked about the text.
    const netCalls = unbacked ? calls.map((c) => (c.name === 'book_viewing' ? { ...c, ok: true, result: JSON.stringify({ reserved: false, reason: 'unbacked' }) } : c)) : calls;
    const net = await ctx.commit.afterPreSend({ lead: { lead_id: 'LEAD-EVAL-GRADER' }, turn: { toolCalls: netCalls }, text, language });
    g.claim = net?.handover?.kind === 'booking_failed' ? 'net' : evalClaim(text) ? 'eval' : null;
    // The r11 ruling (Codex r11 P1-2): only production's net (dana-commit, which reads a denial: "I haven't put you
    // down …") is a hard booking fail; the eval's own claim words are a flag for a read (below).
    if (g.claim === 'net') hard.add('booking');
  }
  // r10 (Codex P1-1): on a pick turn, a reservation for another home than the one the client picked (the turn's
  // expect.listing) is a hard booking fail: production would book that other home.
  // r11 (Codex P1-1, Claude P3-1): the successful reservation's own canonical listing_id decides when it has one; else
  // the argument, trimmed and in capitals (the tool trims it: " BONA-W003 " books BONA-W003).
  const pickedHome = typeof expect.listing === 'string' ? expect.listing.trim().toUpperCase() : null;
  const bookedHome = reserved ? String(parsed(last.result)?.listing_id ?? last.args?.listing_id ?? '').trim().toUpperCase() : '';
  g.wrongHome = Boolean(expect.booked && reserved && pickedHome && bookedHome && bookedHome !== pickedHome);
  if (g.wrongHome) hard.add('booking');
  // The r3 ruling, made structural in r4 (Claude P1-1, Codex P1): on a pick turn whose last book_viewing did not reserve,
  // EVERY non-empty reply is flagged for the main session to read (never hard by that alone, never "pass" for the run
  // until it is read), unless it is only dana-commit's fixed lines. A claim may name no slot ("You're all set!") or spell
  // it, so no lexical rule decides; `namesSlot` is a hint for the reader. A model that books is never flagged.
  const pickSlot = kase.slots?.[expect.slot ?? 0];
  g.needsRead = Boolean(expect.booked && !reserved && g.claim !== 'net' && text.trim() && !onlyFixedLines(text));
  g.readWhy = g.needsRead ? 'pick' : null;
  // r11: a claim only the eval's own words see, off a pick turn, is read too.
  if (!g.needsRead && g.claim === 'eval') Object.assign(g, { needsRead: true, readWhy: 'claim' });
  g.namesSlot = g.needsRead ? namesPickedSlot(text, pickSlot) : null;
  // r10 (Codex P1-3), structural like the pick flag: after a search that returned no home, every non-empty reply is read
  // (a home invented by its name carries no id).
  if (!g.needsRead && text.trim() && ran.some(emptySearch)) Object.assign(g, { needsRead: true, readWhy: 'empty_search' });
  // The r10 ruling (Claude r10 P1): the closed figure flag (Codex r5 P1, closed in r6) on EVERY case and turn, no case
  // selection: any digit run not backed under the every-reading rule, and any magnitude word of the closed list, is read
  // (offerFigures). Backed: the guard's reading of this turn's tool results (allowedFrom) and any number written in them,
  // the site facts the brain is given, and the client's own message in this turn (a figure the client wrote may be echoed;
  // a forbidden one is a hard price fail all the same, as is any figure the guard refuses).
  const backedIds = new Set(results.flatMap((r) => idsIn(r)));
  if (!g.needsRead && !hard.has('price')) {
    const turnClient = (spec?.client ?? []).filter((x) => typeof x === 'string');
    const backed = new Set([...results.flatMap(numbersOutsideIds), ...(ctx.factFigures ?? []), ...turnClient.flatMap(numbersOutsideIds)]);
    const figures = offerFigures(text, guardAllowed({ toolResults: results }), backedIds, backed);
    if (figures.length) Object.assign(g, { needsRead: true, readWhy: 'figure', figures });
  }
  if (hit('link') || offSiteLinks(text, ctx.siteUrl).length) hard.add('link');
  if (foreignPhones(text, ctx.factDigits).length) hard.add('phone');
  const ascii = readDigits(text);
  if (fixturePatterns(kase.forbid_text, 'forbid_text', whereOf(kase)).some((re) => re.test(text) || re.test(ascii))) hard.add('forbidden');
  if (idsIn(text).some((id) => !ctx.ids.has(id))) hard.add('invented_home');
  g.hardFails = HARD_RULES.filter((r) => hard.has(r));

  for (const want of expect.tools ?? []) if (!want.split('|').some((n) => ran.some((c) => c.name === n))) g.routing.push(`tool:${want}`);
  for (const n of expect.not_tools ?? []) if (ran.some((c) => c.name === n)) g.routing.push(`not:${n}`);
  if ((expect.kind ?? []).length && !handedOver) g.routing.push('kind');
  if (expect.booked) {
    const slot = reserved ? parsed(last.result)?.slot_id ?? null : null;
    if (!reserved || g.wrongHome || (Number.isInteger(expect.slot) && slot !== kase.slots?.[expect.slot]?.slot_id)) g.routing.push('booked');
  }
  const textAny = fixturePatterns(expect.text_any, 'text_any', whereOf(kase));
  if (textAny.length && !textAny.some((re) => re.test(text))) g.routing.push('text');
  if (idsIn(text).some((id) => !backedIds.has(id))) g.routing.push('grounding');
  if (rawEcho(text, results)) g.routing.push('raw');
  if (!text.trim()) g.routing.push('empty');
  g.register = registerIssues(text);
  g.registerApplies = AR_LETTER.test(text);
  g.style = styleIssues(text, kase.lang, kase.accept_lang ?? [kase.lang]);
  return g;
}

/** A probe of the case file graded as the answer of its case's last turn (the shape test; no model). */
export async function gradeProbe(kase, probe, ctx) {
  const filled = fillCase(kase);
  const res = {
    ok: true, messages: [{ role: 'agent', content: probe.reply }], guard: { repaired: false },
    toolCalls: (probe.tools ?? []).map((t, i) => ({ id: `probe_${i}`, name: t.name, args: t.args ?? {}, result: JSON.stringify(t.result ?? {}), ok: t.ok ?? true })),
  };
  const clientTexts = [...filled.history.filter((h) => h.from === 'client').map((h) => h.text), ...filled.turns.flatMap((t) => t.client.filter((x) => typeof x === 'string'))];
  const earlierReplies = filled.history.filter((h) => h.from === 'assistant' && h.guarded !== 0).map((h) => h.text);
  return gradeTurn({ kase: filled, spec: filled.turns.at(-1), res, language: kase.lang, clientTexts, earlierReplies, ctx });
}

/* ---------------- the pass bar and the decision rule (PLAN T26) ---------------- */

const percentile = (values, p) => {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

/** One candidate's counts from its case results. */
export function summarise({ cand, results, usd = 0, usdUnknown = 0, aborted = null, baseline = false }) {
  const done = (r) => !r.notRun && r.turns.length === r.kase.turns.length;
  const turns = results.flatMap((r) => r.turns ?? []);
  const grades = turns.map((t) => t.g);
  const hardFails = Object.fromEntries(HARD_RULES.map((rule) => [rule, results.filter((r) => (r.turns ?? []).some((t) => t.g.hardFails.includes(rule))).length]));
  const errors = {};
  for (const g of grades) if (!g.ok) errors[g.code] = (errors[g.code] ?? 0) + 1;
  const reg = grades.filter((g) => g.ok && g.registerApplies);
  const sty = grades.filter((g) => g.ok);
  const cases = results.length;
  const hardCases = results.filter((r) => done(r) && r.turns.every((t) => !t.g.hardFails.length)).length;
  const routingCases = results.filter((r) => done(r) && r.turns.every((t) => !t.g.routing.length)).length;
  // The guard metric (Codex r1 P1): repairs, guard hand-overs and false positives apart; only false positives fail the bar.
  const guards = grades.map((g) => g.guard ?? { repairs: 0, handover: false, event: Boolean(g.guardEvent), falsePositives: 0 });
  const fpTurns = guards.filter((x) => x.falsePositives > 0).length;
  const ms = turns.map((t) => t.ms);
  return {
    label: cand.label, model: cand.model, effort: cand.effort, baseline,
    cases, turns: turns.length, complete: !aborted && results.every(done), aborted, notRun: results.filter((r) => r.notRun).length,
    hardCases, hardFails, routingCases, routingRate: cases ? routingCases / cases : 0,
    registerOk: reg.filter((g) => !g.register.length).length, registerN: reg.length,
    registerRate: reg.length ? reg.filter((g) => !g.register.length).length / reg.length : 0,
    styleOk: sty.filter((g) => !g.style.length).length, styleN: sty.length,
    repairs: guards.reduce((n, x) => n + x.repairs, 0), guardHandovers: guards.filter((x) => x.handover).length, guardEvents: guards.filter((x) => x.event).length,
    falsePositives: guards.reduce((n, x) => n + x.falsePositives, 0), falseHitRate: turns.length ? fpTurns / turns.length : 0, errors,
    needsRead: grades.filter((g) => g.needsRead).length,
    // The reads by reason (Claude r12 P3-1): 'pick', 'claim', 'empty_search', 'figure'.
    needsReadBy: Object.fromEntries(['pick', 'claim', 'empty_search', 'figure'].map((k) => [k, grades.filter((g) => g.needsRead && g.readWhy === k).length])),
    p50Ms: percentile(ms, 50), p90Ms: percentile(ms, 90), usd, usdUnknown, usdPerTurn: turns.length ? usd / turns.length : 0,
  };
}

/** PLAN T26: 100% of the hard rules, routing ≥ 90%, per-turn p90 ≤ 15 s, guard false positives ≤ 5% of turns, every case run. */
export function passesBar(s) {
  return Boolean(s && s.complete === true && s.hardCases === s.cases && s.routingRate >= BAR.routing && s.p90Ms <= BAR.p90Ms && s.falseHitRate <= BAR.falseHitRate);
}

/** T26 re-sizes the day stop to ≥ 3 × PER_DAY (the top tier, 200) × the measured $/turn; null when the default covers it. */
export function dayStopUsd(usdPerTurn) {
  const v = Math.ceil(Math.round(3 * PER_DAY_MAX * Number(usdPerTurn) * 1e6) / 1e6);
  return Number.isFinite(v) && v > BRAIN_DEFAULTS.dayStopUsd ? v : null;
}

/**
 * The decision rule (PLAN T26; DESIGN-brain §2.1): terra becomes main if it passes the bar and is within 5 points of
 * sol on routing and on the register checks, else sol stays main. Sol's effort is the one that passes with the lower
 * p90. The backup answers only with 100% of the hard rules, else BONA_BRAIN_BACKUP_MODE=handover. The env lines are
 * only those that differ from the defaults, plus the day stop when it must grow. Terra is compared only with a sol
 * run that ran every case (Claude r1 P3-5): a sol stopped by its $ cap never lets terra win, and the notes say why.
 * Any flagged reply (the r3 ruling) makes the verdict `needs_read`: the decision stands only once they are read.
 */
export function decide(summaries) {
  const own = summaries.filter((s) => !s.baseline);
  const sols = own.filter((s) => s.model === BRAIN_DEFAULTS.model);
  const terras = own.filter((s) => s.model === BRAIN_DEFAULTS.backupModel);
  const byP90 = (a, b) => a.p90Ms - b.p90Ms;
  const best = (list) => [...list].sort((a, b) => (b.hardCases - a.hardCases) || (b.routingRate - a.routingRate) || byP90(a, b))[0] ?? null;
  const solPick = sols.filter(passesBar).sort(byP90)[0] ?? null;
  const solRef = solPick ?? best(sols.filter((s) => s.complete === true));
  const terraPick = terras.filter(passesBar).sort(byP90)[0] ?? null;
  const within = (t, s) => t.routingRate >= s.routingRate - BAR.points - 1e-9 && t.registerRate >= s.registerRate - BAR.points - 1e-9;
  let main = null;
  let backup = null;
  if (terraPick && solRef && within(terraPick, solRef)) {
    main = terraPick;
    backup = solPick ?? solRef;
  } else if (solPick) {
    main = solPick;
    backup = terraPick ?? best(terras);
  }
  const pick = (s) => (s ? { model: s.model, effort: s.effort } : null);
  // The r3 ruling: a flagged reply on any candidate may be a claim the nets missed, and reading it can only turn a pass
  // into a fail; so a run with flags is "needs read" (exit 5), its decision tentative, until the main session reads them.
  const flagged = own.reduce((n, s) => n + (s.needsRead ?? 0), 0);
  if (!main) {
    const why = !terraPick ? 'no model passes the bar'
      : !solRef ? 'terra passes the bar, but there is no complete sol run to compare it with: re-run sol before choosing terra'
        : 'terra passes the bar but is more than 5 points behind sol on routing or register, and sol fails the bar';
    return { verdict: 'fail', main: null, backup: null, backupMode: null, env: [], flagged, notes: [`${why}: Phase 6 stays shut`] };
  }
  const backupMode = backup && backup.complete && backup.hardCases === backup.cases ? 'answer' : 'handover';
  const env = [];
  if (main.model !== BRAIN_DEFAULTS.model) env.push(`BONA_BRAIN_MODEL=${main.model}`);
  if (backup && backup.model !== BRAIN_DEFAULTS.backupModel) env.push(`BONA_BRAIN_BACKUP_MODEL=${backup.model}`);
  if (backupMode !== BRAIN_DEFAULTS.backupMode) env.push(`BONA_BRAIN_BACKUP_MODE=${backupMode}`);
  const stop = dayStopUsd(main.usdPerTurn);
  if (stop !== null) env.push(`BONA_BRAIN_DAY_STOP_USD=${stop}`);
  const notes = [];
  for (const [role, s] of [['main', main], ['backup', backup]]) {
    if (s && s.effort !== REASONING_EFFORT) notes.push(`${role} ${s.model} at effort ${s.effort}: no env knob (lib/brain/openai.mjs sends '${REASONING_EFFORT}'), a code change`);
  }
  if (flagged) notes.push(`${flagged} flagged replies (a reply on an unbacked pick turn, with the eval's claim words, after an empty search, or with an unbacked figure or a magnitude word): read them in the local report before the model decision`);
  // The r10 decision rule: the grader cannot list every way a model misbehaves, so the main session reads every transcript.
  notes.push('the decision is final only after the main session reads every transcript of the chosen main and backup (the answers file), before any env line is written');
  return { verdict: flagged ? 'needs_read' : 'pass', main: pick(main), backup: pick(backup), backupMode, env, flagged, notes };
}

/* ---------------- the run ---------------- */

const stamp = (ms = Date.now()) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
export const defaultOutDir = () => path.join(os.homedir(), 'bona-data', 'eval');

/**
 * The local run report (the r3 ruling): beside the answers file, 0600, never on stdout. The flagged pick-turn replies
 * (candidate, case, turn, the reply text: synthetic fixtures, no personal data) for the main session to read before the
 * model decision, and every guard refusal (candidate, case, turn, the guard's reason, the amount or unit, true or false hit).
 */
function writeReport(file, { runId, read }) {
  const lines = [`bona brain eval ${runId}: local report (0600). Synthetic cases; read before the model decision.`, '',
    `== needs read (${read.flags.length}): a reply on an unbacked pick turn (every reply but BOOKING_FAILED_LINE), with the eval's claim words, after an empty search, or with an unbacked figure or a magnitude word`,
    ...read.flags.map((f) => `${f.candidate} ${f.case} turn ${f.turn} [${f.why === 'figure' ? `unbacked figure or magnitude word: ${f.figures.join(', ')}` : f.why === 'empty_search' ? 'after an empty search' : f.why === 'claim' ? "the eval's claim words" : `names the slot: ${f.namesSlot ? 'yes' : 'no'}`}]: ${f.text.replace(/\s*\n\s*/g, ' / ')}`), '',
    `== guard refusals (${read.refusals.length})`,
    ...read.refusals.map((x) => `${x.candidate} ${x.case} turn ${x.turn} [${x.reason}]: ${x.amount ?? x.unit ?? x.kind ?? '-'} ${x.falseHit ? 'false hit' : 'true hit'}`), ''];
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.fchmodSync(fd, 0o600); fs.writeSync(fd, lines.join('\n')); } finally { fs.closeSync(fd); }
}

function openAnswers(dir, runId) {
  const made = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (made) { try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ } }
  // Never an older run's file: two runs in one second take <stamp>-2, -3, … (opened exclusively, so never shared).
  let file;
  let fd;
  for (let k = 1; fd === undefined; k += 1) {
    file = path.join(dir, k === 1 ? `${runId}.jsonl` : `${runId}-${k}.jsonl`);
    try { fd = fs.openSync(file, 'wx', 0o600); } catch (err) { if (err?.code !== 'EEXIST' || k >= 50) throw err; }
  }
  fs.fchmodSync(fd, 0o600);
  return { file, write: (obj) => fs.writeSync(fd, `${JSON.stringify(obj)}\n`), close: () => fs.closeSync(fd) };
}

/** A Responses message's text: a string, or the text of its parts (input_text / output_text). */
const itemText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');

/**
 * The model requests of a turn as the answers file keeps them (`state.responses`): one entry a request, made as it
 * goes out, so a request that never answers (a timeout) is there too. On the Responses API (T25b, lib/brain/openai.mjs):
 * `repair` marks the guard's repair request (its LAST input item is a developer message with REPAIR_NOTE), with the
 * tool results it carried (its function_call_output items' `output`: the guard metric); then the response's text (the
 * LAST message item's output_text, #104's last-message rule), the tools it asked for (its function_call items) and why
 * it stopped ('tool_calls' or 'stop' when completed, else incomplete_details.reason or the status).
 */
export function recorder(state) {
  return {
    request(body) {
      let j = null;
      try { j = typeof body === 'string' ? JSON.parse(body) : null; } catch { j = null; }
      const input = Array.isArray(j?.input) ? j.input : [];
      const last = input.at(-1);
      const repair = last?.role === 'developer' && itemText(last.content) === REPAIR_NOTE;
      const entry = { repair, content: null, tools: [], finish: 'no_response', usage: null };
      if (repair) entry.results = input.filter((it) => it?.type === 'function_call_output').map((it) => String(it.output ?? ''));
      state.responses.push(entry);
      return entry;
    },
    response(entry, text) {
      let j = null;
      try { j = JSON.parse(text); } catch { j = null; }
      const output = Array.isArray(j?.output) ? j.output : [];
      const message = output.filter((it) => it?.type === 'message').at(-1);
      entry.content = message ? (Array.isArray(message.content) ? message.content : []).filter((p) => p?.type === 'output_text' && typeof p.text === 'string').map((p) => p.text).join('') : null;
      entry.tools = output.filter((it) => it?.type === 'function_call' && typeof it.name === 'string').map((it) => it.name);
      entry.finish = !j ? 'unparsed' : j.status === 'completed' ? (entry.tools.length ? 'tool_calls' : 'stop')
        : j.status === 'incomplete' ? (j.incomplete_details?.reason ?? 'incomplete') : (j.status ?? null);
      entry.usage = j?.usage ?? null;
    },
  };
}

/**
 * The one provider request a live run may send (T25b): POST to exactly https://api.openai.com/v1/responses (Claude r13
 * P3-1: that origin, so no other port; that path; no query, no fragment, no userinfo).
 */
export function providerUrlOk(url, init = {}) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  return u.origin === 'https://api.openai.com' && u.pathname === '/v1/responses' && !u.search && !u.hash && !u.username && !u.password && init.method === 'POST';
}
/** The request body with the candidate's effort set as `reasoning.effort` (its other reasoning fields kept), never `reasoning_effort`. */
export function withEffort(body, effort) {
  const j = JSON.parse(body);
  j.reasoning = { ...(j.reasoning && typeof j.reasoning === 'object' ? j.reasoning : {}), effort };
  return JSON.stringify(j);
}

/** The live brain's fetch: the Responses API on api.openai.com only, with the flag, the candidate's effort set. */
export function providerFetch({ realFetch, effort, state, env }) {
  const record = recorder(state);
  return async (url, init = {}) => {
    if (env[EVAL_FLAG] !== '1') throw new Error('eval: the provider needs BONA_BRAIN_EVAL=1');
    if (!providerUrlOk(url, init)) throw new Error('eval: refused request');
    const href = new URL(String(url)).href;
    const body = typeof init.body === 'string' ? withEffort(init.body, effort) : init.body;
    const entry = record.request(body);
    const res = await realFetch(href, { ...init, body });
    const text = await res.text();
    record.response(entry, text);
    return { ok: res.ok, status: res.status, headers: res.headers, text: async () => text };
  };
}

/**
 * --max-usd as a true maximum (Codex r1 P2): before each request goes out, its worst case is reserved: every byte of
 * the body a fresh input token at the dearer of the input and cache-write prices (no request has more tokens than its
 * body has bytes, the candidate's effort written in), plus max_output_tokens of output (T25b; 1,200 when the body has none). A request that could pass the cap is not sent; the
 * candidate's run stops there (`max_usd`). The run keeps its own tally (`state.spend`; Claude r2 P3-1: never a month
 * marker): what each answered request cost by its usage (`knownMicro`), and the worst case of every request that went
 * out but whose cost is unknown (`reservedMicro`, Codex r2 P2): it timed out or was aborted after the send, or it
 * answered with no usage. Those stay reserved for the rest of the run. The brain's own runaway stops stay as the
 * second wall.
 */
export function capFetch({ inner, model, maxUsd, state, effort = null }) {
  state.spend ??= { knownMicro: 0, reservedMicro: 0 };
  const sp = state.spend;
  return async (url, init0 = {}) => {
    // Claude r13 P3-2: the candidate's effort is written in first, so the body priced is the body that goes out.
    const init = effort && typeof init0.body === 'string' ? { ...init0, body: withEffort(init0.body, effort) } : init0;
    const body = typeof init.body === 'string' ? init.body : '';
    let out = MAX_OUTPUT_TOKENS;
    try { out = Number(JSON.parse(body).max_output_tokens) || out; } catch { /* the default cap */ }
    const worst = costMicroUsd(model, { in: Buffer.byteLength(body, 'utf8'), cached: 0, out });
    if (sp.knownMicro + sp.reservedMicro + worst > maxUsd * 1e6) {
      state.capReached = true;
      throw new Error('eval: --max-usd would be passed');
    }
    let res;
    let text;
    try {
      res = await inner(url, init);
      text = await res.text();
    } catch (err) {
      sp.reservedMicro += worst; // sent, its cost unknown
      throw err;
    }
    let usage = null;
    try { usage = JSON.parse(text)?.usage ?? null; } catch { usage = null; }
    const u = usage ? usageOf({ usage }) : null;
    if (u && (u.in > 0 || u.out > 0)) sp.knownMicro += costMicroUsd(model, u);
    else if (res.ok) sp.reservedMicro += worst; // answered, but with no usage to price it by
    return { ok: res.ok, status: res.status, headers: res.headers, text: async () => text };
  };
}

/**
 * The tools' fetch in a live run: GET or HEAD of Bona's own site, nothing else (the published units, a brochure's
 * size). Redirects are taken hop by hop (Codex r1 P2): each one is checked against the same list before it is
 * requested; `redirect: 'error'` (the brochure HEAD) still fails on any redirect, as fetch would.
 */
export function siteFetch({ realFetch, siteUrl, maxHops = 5 }) {
  const hosts = new Set(BONA_HOSTS);
  try { hosts.add(new URL(siteUrl).hostname.toLowerCase()); } catch { /* the default hosts */ }
  return async (url, init = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase();
    let u = new URL(String(url));
    for (let hop = 0; ; hop += 1) {
      if (u.protocol !== 'https:' || !hosts.has(u.hostname.toLowerCase()) || !['GET', 'HEAD'].includes(method) || init.body != null) throw new Error('eval: refused request');
      const res = await realFetch(u.href, { ...init, redirect: 'manual' });
      const location = res.status >= 300 && res.status < 400 ? res.headers?.get?.('location') : null;
      if (!location || init.redirect === 'manual') return res;
      if (init.redirect === 'error') throw new TypeError('fetch failed: redirect');
      if (hop >= maxHops) throw new Error('eval: refused request (too many redirects)');
      u = new URL(location, u);
    }
  };
}
const refuseFetch = async () => { throw new Error('eval: no network in a dry run'); };

/**
 * A dry run's published units page for BONA-W014 (r10: offline, search_units would always come back empty and be read).
 * A fixture of made-up figures, never a real price: a dry run checks the pipeline, not the inventory.
 */
const DRY_UNITS = Object.freeze({
  listingId: 'BONA-W014', count: 2, areaMin: 100, areaMax: 200, cashFrom: 1_000_000, delivery: null, updated: '2026-11-01',
  rows: [{ label: { en: '2 bedrooms', ar: 'غرفتين' }, count: 2, areaMin: 100, areaMax: 200, cashFrom: 1_000_000 }],
});

/** An empty calendar: every slot of the grid free, no holiday; nothing is ever inserted (the eval never commits). */
function emptyCalendar() {
  const no = async () => ({ ok: false, code: 'eval' });
  return {
    configured: true, calendarTag: null, cachedHolidays: () => new Set(),
    holidays: async () => ({ ok: true, dates: new Set() }), freeBusy: async () => ({ ok: true, busy: [] }),
    access: async () => ({ ok: true }), insert: no, get: no, delete: no, health: () => ({ ok: true, lastErrorCode: null }),
  };
}

/* ---------------- the fake model (--dry-run) ---------------- */

const LISTING_ID_RE = /BONA-W?\d{3}/i;
const FAKE_REPLY = {
  out_of_hours: { ar: 'فريق بونا يرد من الأحد إلى الخميس، من 10:00 إلى 19:00.', en: 'The Bona team replies Sunday to Thursday, 10:00 to 19:00.' },
  person: { ar: 'أنا مساعدة بونا بالذكاء الاصطناعي، وفريق بونا يقدر يقرأ المحادثة.', en: "I'm Bona's AI assistant, and the Bona team can read this chat." },
  name: { ar: 'أنا مساعدة بونا بالذكاء الاصطناعي، وأقدر أساعدك في العقارات.', en: "I'm Bona's AI assistant, happy to help with our homes." },
  voice_note: { ar: 'ما قدرت أسمع الرسالة الصوتية، ممكن تكتب لي طلبك؟', en: 'I could not open the voice note; could you type it for me?' },
  default: { ar: 'تمام، وصلني طلبك وأقدر أساعدك فيه.', en: 'Sure, happy to help with that.' },
};
/**
 * The scripted model of a dry run, a fake POST /v1/responses (T25b) that keeps the Responses rules (responsesRuleBroken:
 * a broken one is a 400, as the API answers). 'good' answers every case as its expectations say. The failure paths: 'probes'
 * answers with each case's first failing (or claim) probe; 'quota' runs out of credit on the fifth request; and the degenerate
 * brains every one of which must fail the bar (r1): 'handover' (always hands over), 'refuse' (always refuses), 'echo'
 * (repeats the client), 'echo-tools' (the right tools, then their raw text), 'claim-pick' (never books a picked slot,
 * says it is set), 'claim-pick-ask' (the same, then a follow-up question: r2), 'claim-pick-comma' (joined by a comma: r3),
 * 'claim-pick-allset' (names no slot) and 'claim-pick-spelled' (spells the hour: r4); 'units-lie' (a cue-less invented "from"
 * price on the units and guard-edge cases, Claude r10 P1) and 'wrong-listing' (books the picked slot on another home,
 * Codex r10 P1-1).
 */
export function fakeModel({ mode = 'good', state }) {
  const record = recorder(state);
  /** call_id → the reasoning item it came with: a function_call goes back only after that item (T25b, store:false). */
  const issued = new Map();
  let n = 0;
  let requests = 0;
  return async (url, init = {}) => {
    requests += 1;
    const entry = record.request(init.body);
    const answer = (status, json) => {
      const text = JSON.stringify(json);
      record.response(entry, text);
      return { ok: status === 200, status, headers: new Headers(), text: async () => text };
    };
    const no = (param, message) => answer(400, { error: { type: 'invalid_request_error', code: null, param, message } });
    if (mode === 'quota' && requests >= 5) return answer(429, { error: { code: 'insufficient_quota', type: 'insufficient_quota' } });
    let body;
    try { body = JSON.parse(init.body); } catch { return no('body', 'not JSON'); }
    const refused = responsesRuleBroken(body, issued);
    if (refused) return no(refused.param, refused.message);
    const { kase, spec, language } = state;
    const en = language === 'en';
    const msgs = chatView(body);
    const after = msgs.slice(msgs.map((m) => m.role).lastIndexOf('user') + 1);
    const asked = new Map(after.filter((m) => m.role === 'assistant').flatMap((m) => (m.tool_calls ?? []).map((c) => [c.id, c.function.name])));
    const done = new Set(asked.values());
    const slots = after.filter((m) => m.role === 'tool' && asked.get(m.tool_call_id) === 'viewing_slots').map((m) => parsed(m.content)).find((r) => r?.bookable) ?? null;
    const offered = body.tool_choice !== 'none' && Array.isArray(body.tools);
    const reply = (content) => ({ role: 'assistant', content });
    const callTools = (calls) => ({ role: 'assistant', content: null, tool_calls: calls.map((c) => ({ id: `call_${n += 1}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) });
    const canned = (FAKE_REPLY[kase.category] ?? FAKE_REPLY.default)[en ? 'en' : 'ar'];
    const planned = () => (offered ? fakePlan({ kase, spec, done, slots, wrongHome: mode === 'wrong-listing' }) : []);
    const good = (last = canned) => { const c = planned(); return c.length ? callTools(c) : reply(last); };
    let message;
    if (mode === 'probes') {
      // Each case's first failing probe, or its first claim probe (hard on production's net, or read: the r11 ruling).
      const probe = (kase.probes ?? []).find((p) => p.fails || p.claim);
      message = probe ? reply(probe.reply) : good();
    } else if (mode === 'handover') {
      message = offered && !done.has('request_human') ? callTools([{ name: 'request_human', args: { kind: 'offer', reason: 'eval' } }])
        : reply(en ? 'A member of the Bona team will reply to you here.' : 'فريق بونا بيرد عليك هنا.');
    } else if (mode === 'refuse') {
      message = reply(en ? "Sorry, I can't help with that." : 'آسفة، ما أقدر أساعدك في هذا.');
    } else if (mode === 'echo') {
      message = reply(String(msgs.filter((m) => m.role === 'user').at(-1)?.content ?? '').slice(0, 600) || 'ok');
    } else if (mode === 'echo-tools') {
      message = good(after.filter((m) => m.role === 'tool').map((m) => String(m.content ?? '')).join('\n').slice(0, 3000) || canned);
    } else if (mode === 'units-lie' && ['units', 'guard_edge'].includes(kase.category) && kase.id !== 'en-edge-clause') {
      const c = good();
      message = c.tool_calls ? c : reply(en ? 'They start from 75,000.' : 'تبدأ من ٧٥٬٠٠٠.');
    } else if (mode === 'claim-pick' && spec?.expect?.booked) {
      message = reply(en ? 'Great, Sunday at 10 it is!' : 'تمام، يوم الأحد الساعة 10 الصبح إن شاء الله.');
    } else if (mode === 'claim-pick-allset' && spec?.expect?.booked) {
      message = reply(en ? "You're all set, Khalid!" : 'أبشر يا خالد، تم.');
    } else if (mode === 'claim-pick-spelled' && spec?.expect?.booked) {
      message = reply(en ? 'Great, ten in the morning it is!' : 'تمام، الساعة العاشرة الصبح إن شاء الله.');
    } else if (mode === 'claim-pick-comma' && spec?.expect?.booked) {
      message = reply(en ? 'Great, Sunday at 10 it is, anything else I can help with?' : 'أبشر يا خالد، الأحد الساعة 10، تحتاج شي ثاني؟');
    } else if (mode === 'claim-pick-ask' && spec?.expect?.booked) {
      message = reply(en ? 'Great, Sunday at 10 it is! Is there anything else I can help with?' : 'أبشر يا خالد، الأحد الساعة 10 إن شاء الله. تحتاج شي ثاني؟');
    } else message = good();
    n += 1;
    // The Responses shape (T25b): a reasoning item first, then one function_call per tool (each with its call_id), or
    // the answer as a message item.
    const reasoning = { id: `rs_${n}`, type: 'reasoning', summary: [], encrypted_content: `ENC-${n}-opaque` };
    const output = [reasoning];
    if (message.tool_calls) {
      for (const c of message.tool_calls) {
        issued.set(c.id, reasoning);
        output.push({ id: `fc_${c.id}`, type: 'function_call', status: 'completed', call_id: c.id, name: c.function.name, arguments: c.function.arguments });
      }
    } else {
      output.push({ id: `msg_${n}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: String(message.content ?? ''), annotations: [] }] });
    }
    return answer(200, {
      id: `resp_${n}`, object: 'response', status: 'completed', error: null, incomplete_details: null, model: body.model, output,
      usage: { input_tokens: 2400, input_tokens_details: { cached_tokens: 2000 }, output_tokens: 80, output_tokens_details: { reasoning_tokens: 30 } },
    });
  };
}

/** Fields of the Chat Completions API (and sampling ones) that the Responses API refuses (the T00 step 7 probe). */
const CHAT_ONLY_FIELDS = ['messages', 'reasoning_effort', 'max_completion_tokens', 'response_format', 'temperature', 'top_p'];
/**
 * The rules the offline fake keeps, as #104's strict fake (test/brain.test.mjs fakeResponses): Responses fields only;
 * store false with the encrypted reasoning included and an effort; flat strict function tools; every function_call
 * one this fake issued, sent back after the reasoning item that came with it (unchanged); every function_call_output
 * answering a call; no call left unanswered. `{ param, message }` for the first rule broken, else null.
 */
function responsesRuleBroken(b, issued) {
  if (!b || typeof b !== 'object') return { param: 'body', message: 'not an object' };
  for (const k of CHAT_ONLY_FIELDS) if (k in b) return { param: k, message: `Unsupported parameter: '${k}'` };
  if (b.store !== false || !(Array.isArray(b.include) && b.include.includes('reasoning.encrypted_content'))) return { param: 'include', message: 'encrypted reasoning needed with store false' };
  if (!['none', 'minimal', 'low', 'medium', 'high'].includes(b.reasoning?.effort)) return { param: 'reasoning.effort', message: 'bad effort' };
  if (typeof b.model !== 'string' || !Array.isArray(b.input) || !Number.isInteger(b.max_output_tokens)) return { param: 'input', message: 'missing field' };
  for (const t of b.tools ?? []) if (t?.type !== 'function' || typeof t.name !== 'string' || t.strict !== true || 'function' in t) return { param: 'tools', message: 'not a Responses function tool' };
  const open = new Set();
  for (const [i, it] of b.input.entries()) {
    if (it?.type === 'reasoning') {
      if (typeof it.encrypted_content !== 'string') return { param: 'input', message: 'Items are not persisted when `store` is set to false.' };
    } else if (it?.type === 'function_call') {
      const r = issued.get(it.call_id);
      if (!r) return { param: 'input', message: 'unknown function call' };
      if (!b.input.slice(0, i).some((x) => x?.type === 'reasoning' && x.id === r.id && x.encrypted_content === r.encrypted_content)) return { param: 'input', message: 'a function_call without its reasoning item' };
      open.add(it.call_id);
    } else if (it?.type === 'function_call_output') {
      if (!open.has(it.call_id) || typeof it.output !== 'string') return { param: 'input', message: 'No tool call found for function call output.' };
      open.delete(it.call_id);
    } else if (!['user', 'assistant', 'developer', 'system'].includes(it?.role) || (typeof it.content !== 'string' && !Array.isArray(it.content))) {
      return { param: 'input', message: 'bad message' };
    }
  }
  if (open.size) return { param: 'input', message: 'No tool output found for function call.' };
  return null;
}

/**
 * A Responses request read back as the chat turns the brain built (as test/brain.test.mjs chatView): `instructions` the
 * first system message; a developer message a system one; a round's function_call items one assistant turn with
 * tool_calls; a function_call_output a tool message. Reasoning items are left out.
 */
function chatView(body) {
  const out = typeof body?.instructions === 'string' ? [{ role: 'system', content: body.instructions }] : [];
  for (const it of Array.isArray(body?.input) ? body.input : []) {
    if (it?.type === 'reasoning') continue;
    if (it?.type === 'function_call') {
      const call = { id: it.call_id, type: 'function', function: { name: it.name, arguments: it.arguments } };
      if (out.at(-1)?.role === 'assistant' && out.at(-1).tool_calls) out.at(-1).tool_calls.push(call);
      else out.push({ role: 'assistant', content: null, tool_calls: [call] });
    } else if (it?.type === 'function_call_output') {
      out.push({ role: 'tool', tool_call_id: it.call_id, content: it.output });
    } else {
      out.push({ role: it?.role === 'developer' ? 'system' : it?.role, content: itemText(it?.content) });
    }
  }
  return out;
}
/** The tools a right answer calls, one round at a time (book_viewing after viewing_slots answered). */
function fakePlan({ kase, spec, done, slots, wrongHome = false }) {
  const exp = spec?.expect ?? {};
  const texts = [...spec.client.filter((x) => typeof x === 'string'), ...kase.history.map((h) => h.text)];
  const listing = (texts.join(' ').match(LISTING_ID_RE)?.[0] ?? kase.lead?.listing_id ?? null)?.toUpperCase() ?? null;
  const named = texts.join(' ').match(/(?:اسمي|my name is)\s+(\p{L}+)/u)?.[1];
  const want = [...(exp.tools ?? []).map((t) => t.split('|')[0]), ...((exp.kind ?? []).length ? ['request_human'] : [])];
  const calls = [];
  for (const name of want) {
    if (done.has(name)) continue;
    if (name === 'book_viewing') {
      if (!slots) { if (!done.has('viewing_slots')) calls.push({ name: 'viewing_slots', args: { listing_id: listing } }); continue; }
      const home = wrongHome ? (listing === 'BONA-W019' ? 'BONA-W003' : 'BONA-W019') : listing;
      calls.push({ name, args: { listing_id: home, slot_id: slots.slots?.[exp.slot ?? 0]?.slot_id ?? null, ...(named ? { name: named } : {}) } });
      continue;
    }
    const args = name === 'search_properties' ? { query: String(spec.client.find((x) => typeof x === 'string') ?? '').slice(0, 120) }
      : name === 'search_units' ? { listing_id: 'BONA-W014' }
        : name === 'request_human' ? { kind: exp.kind?.[0] ?? 'other', reason: 'eval' }
          : name === 'save_needs' ? { name: named ?? kase.lead?.name ?? 'Khalid' }
            : { listing_id: listing };
    calls.push({ name, args });
  }
  return calls;
}

/* ---------------- one candidate ---------------- */

/** A turn's flag and guard refusals, kept for the local report (1-based turn numbers). */
function noteForRead(read, candidate, caseId, ti, g) {
  if (!read) return;
  if (g.needsRead) read.flags.push({ candidate, case: caseId, turn: ti + 1, why: g.readWhy, namesSlot: g.namesSlot === true, figures: g.figures ?? [], text: g.text });
  for (const x of g.guard?.refusals ?? []) read.refusals.push({ candidate, case: caseId, turn: ti + 1, ...x });
}

async function runCase({ kase, index, brainFor, db, now, ctx, state, write, meta, read }) {
  const leadId = `LEAD-EVAL-${String(index + 1).padStart(2, '0')}`;
  const phone = `9665000000${String(index + 1).padStart(2, '0')}`;
  const t = now();
  const hist = kase.history;
  db.insertLead({
    lead_id: leadId, created: t - 3_600_000, updated: t - 3_600_000, phone_e164: phone, wa_jid: `${phone}@s.whatsapp.net`, channel: 'whatsapp',
    match_method: 'ref', stage: 'new', inbox_state: 'in', inbox_since: t - 3_600_000, language: kase.lang,
    dana_introduced: hist.some((h) => h.from === 'assistant') ? 1 : 0,
    ...Object.fromEntries(FACT_FIELDS.filter((k) => typeof kase.lead?.[k] === 'string').map((k) => [k, kase.lead[k]])),
  });
  let rid = 0;
  const row = (o) => ({ rid: (rid += 1), lead_id: leadId, media_type: null, ...o });
  const rows = hist.map((h, k) => row({
    key_id: `H${k}`, direction: h.from === 'client' ? 'in' : 'out', sender_kind: h.from === 'client' ? 'client' : h.from === 'assistant' ? 'dana' : 'staff',
    text: h.text, ts: t - (hist.length - k) * 120_000,
  }));
  const earlier = hist.filter((h) => h.from === 'assistant' && h.guarded !== 0).map((h) => h.text);
  const said = hist.filter((h) => h.from === 'client').map((h) => h.text);
  let introduced = hist.some((h) => h.from === 'assistant');
  const turns = [];
  for (const [ti, spec] of kase.turns.entries()) {
    const at = now();
    const batch = spec.client.map((m, k) => row({ key_id: `T${ti}-${k}`, direction: 'in', sender_kind: 'client', text: typeof m === 'string' ? m : null, media_type: typeof m === 'string' ? null : m.media, ts: at + k }));
    said.push(...batch.filter((m) => m.text).map((m) => m.text));
    const lead = db.getLead(leadId);
    const language = languageOf({ lead, texts: batch.map((m) => m.text ?? m.media_type) });
    Object.assign(state, { kase, spec, language, responses: [], events: [] });
    const started = Date.now();
    let res = await brainFor().turn({
      route: 'wa', leadId, language, autoMode: true, ...brainInput({ rows, batch }), leadFacts: Object.fromEntries(FACT_FIELDS.map((k) => [k, typeof lead[k] === 'string' ? lead[k] : null])),
      turnContext: { firstReply: !introduced }, earlierReplies: [...earlier], deadlineMs: 40_000,
    });
    const ms = Date.now() - started;
    // The request --max-usd refused was never sent: the turn ends there, and so does the candidate's run.
    if (state.capReached && !res?.ok) res = { ok: false, code: 'max_usd' };
    const g = await gradeTurn({ kase, spec, res, language, clientTexts: said, earlierReplies: earlier, ctx, responses: state.responses });
    turns.push({ ms, g });
    noteForRead(read, meta.candidate, kase.id, ti, g);
    write({
      type: 'turn', ...meta, case: kase.id, lang: kase.lang, category: kase.category, turn: ti, language, ok: g.ok, code: g.code, ms,
      usd: res?.ok ? res.usd : 0, rounds: res?.ok ? res.rounds : 0, repaired: Boolean(res?.guard?.repaired), usage: res?.ok ? res.usage : null,
      text: g.text, responses: state.responses, events: state.events,
      tools: (res?.ok ? res.toolCalls : []).map((c) => ({ name: c.name, args: c.args, ok: c.ok, result: String(c.result ?? '').slice(0, 2_000) })),
      hardFails: g.hardFails, routing: g.routing, register: g.register, style: g.style, claim: g.claim, guard: g.guard, needsRead: g.needsRead,
    });
    rows.push(...batch);
    if (g.ok && g.text) {
      rows.push(row({ key_id: `A${ti}`, direction: 'out', sender_kind: 'dana', text: g.text, ts: now() }));
      earlier.push(g.text);
      introduced = true;
      db.updateLead(leadId, { dana_introduced: 1 });
    }
    if (!g.ok && STOP_CODES.has(g.code)) return { kase, turns, stop: g.code };
  }
  return { kase, turns };
}

async function runCandidate({ cand, cases, mode, fake, cfg, siteFacts, siteUrl, inventoryFile, ctx, keyFile, realFetch, env, toolFetch, publishedUnits, write, maxUsd, runId, read }) {
  const db = openDb(':memory:');
  let offset = 0;
  const now = () => Date.now() + offset;
  const team = createTeam(db, { now });
  team.setSetting('calendar_booking', '1', { by: 'system' });
  const inventory = createInventory({ file: inventoryFile, siteUrl, now });
  const ownerTest = { autoMode: () => true, active: () => true, ownNumberOk: () => true };
  const viewing = createViewing({ db, team, ownerTest, inventory, gcal: emptyCalendar(), siteUrl, now });
  const tools = createToolHandlers({
    inventory, store: createStore({ now }), db, dataDir: path.join(os.tmpdir(), 'bona-eval-no-data'), siteUrl, env: {}, ownerTest, viewing, notes: null,
    fetchImpl: toolFetch, publishedUnits, now,
  });
  const state = { responses: [], events: [], capReached: false };
  const model = mode === 'dry' ? fakeModel({ mode: fake, state }) : providerFetch({ realFetch, effort: cand.effort, state, env });
  const fetchImpl = capFetch({ inner: model, model: cand.model, maxUsd, state, effort: cand.effort });
  const brainCfg = {
    ...cfg, brainModel: cand.model, brainBackupModel: cand.model, brainBackupMode: 'handover',
    brainMonthAlertUsd: maxUsd, brainDayStopUsd: maxUsd, brainMonthStopUsd: maxUsd,
  };
  const log = (e) => { if (e?.evt === 'brain.guard' || e?.evt === 'brain.bad_tool') state.events.push({ evt: e.evt, kind: e.kind ?? null, name: e.name ?? null }); };
  const results = [];
  let aborted = null;
  for (const [index, raw] of cases.entries()) {
    const kase = fillCase(raw);
    if (aborted) { results.push({ kase, notRun: true, turns: [] }); continue; }
    offset = kase.start - Date.now();
    // One brain a case (its breaker and rate state start clean); the spend markers live in `team`, across cases.
    let brain = null;
    const brainFor = () => {
      brain ??= createBrain({ cfg: brainCfg, runTool: tools.runInProcess, team, fetchImpl, now, log, alert: () => {}, siteFacts, ...(keyFile ? { keyFile } : {}) });
      return brain;
    };
    const r = await runCase({ kase, index, brainFor, db, now, ctx, state, write, read, meta: { run: runId, candidate: cand.label, model: cand.model, effort: cand.effort } });
    results.push(r);
    if (r.stop) aborted = r.stop;
  }
  return summarise({ cand, results, usd: state.spend.knownMicro / 1e6, usdUnknown: state.spend.reservedMicro / 1e6, aborted });
}

/* ---------------- the Retell baseline (today's WhatsApp agent; reported, never in the decision) ---------------- */

async function runRetellBaseline({ cases, cfg, ctx, realFetch, write, runId, retell: given = null, read = null }) {
  const cand = { model: 'retell', effort: 'baseline', label: 'baseline retell' };
  let retell = given;
  if (!retell) {
    if (!cfg.retellApiKey || !cfg.waChatAgentId) return { ...summarise({ cand, results: [], baseline: true }), skipped: 'not_configured' };
    const fetchImpl = async (url, init) => {
      const u = new URL(String(url));
      if (u.protocol !== 'https:' || u.hostname !== 'api.retellai.com') throw new Error('eval: refused request');
      return realFetch(u.href, init);
    };
    retell = createRetellClient({ apiKey: cfg.retellApiKey, fetchImpl });
  }
  const results = [];
  let aborted = null;
  // Retell unavailable (DESIGN §13.2 "skipped if Retell is unavailable"): two failed turns before any answer stop it.
  let answered = false;
  let failed = 0;
  for (const [index, raw] of cases.entries()) {
    const kase = fillCase(raw);
    if (aborted) { results.push({ kase, notRun: true, turns: [] }); continue; }
    const leadId = `LEAD-EVAL-R${String(index + 1).padStart(2, '0')}`;
    const lead = { lead_id: leadId, language: kase.lang, stage: 'new', ...(kase.lead ?? {}) };
    const t = Date.now();
    const rows = kase.history.map((h, k) => ({ key_id: `H${k}`, direction: h.from === 'client' ? 'in' : 'out', sender_kind: h.from === 'client' ? 'client' : h.from === 'assistant' ? 'dana' : 'staff', text: h.text, ts: t - (kase.history.length - k) * 120_000 }));
    const said = kase.history.filter((h) => h.from === 'client').map((h) => h.text);
    const earlier = kase.history.filter((h) => h.from === 'assistant' && h.guarded !== 0).map((h) => h.text);
    const turns = [];
    let chatId = null;
    try {
      for (const [ti, spec] of kase.turns.entries()) {
        const batch = spec.client.map((m, k) => ({ key_id: `T${ti}-${k}`, direction: 'in', sender_kind: 'client', text: typeof m === 'string' ? m : null, media_type: typeof m === 'string' ? null : m.media }));
        said.push(...batch.filter((m) => m.text).map((m) => m.text));
        const language = languageOf({ lead, texts: batch.map((m) => m.text ?? m.media_type) });
        const started = Date.now();
        let res;
        try {
          if (!chatId) {
            const chat = await retell.createChat({
              agent_id: cfg.waChatAgentId,
              retell_llm_dynamic_variables: { channel: 'whatsapp', language, lead_facts: legacyFacts(lead), recent_messages: recentContext(rows) },
              metadata: { source: 'bona-whatsapp', lead_id: leadId },
            });
            chatId = chat?.chat_id ?? null;
          }
          const completion = await retell.createChatCompletion({ chat_id: chatId, content: legacyBatch(batch) });
          const messages = Array.isArray(completion?.messages) ? completion.messages : [];
          const results2 = new Map(messages.filter((m) => m?.role === 'tool_call_result').map((m) => [m.tool_call_id, typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? null)]));
          const toolCalls = messages.filter((m) => m?.role === 'tool_call_invocation').map((m) => ({ id: m.tool_call_id, name: m.name, args: parsed(m.arguments) ?? {}, result: results2.get(m.tool_call_id) ?? '', ok: true }));
          res = { ok: true, messages: messages.filter((m) => m?.role === 'agent'), toolCalls, guard: { repaired: false } };
        } catch (err) {
          res = { ok: false, code: Number(err?.status) === 402 ? 'quota' : 'retell_error' };
        }
        const ms = Date.now() - started;
        const g = await gradeTurn({ kase, spec, res, language, clientTexts: said, earlierReplies: earlier, ctx });
        turns.push({ ms, g });
        noteForRead(read, cand.label, kase.id, ti, g);
        write({ type: 'turn', run: runId, candidate: cand.label, model: 'retell', case: kase.id, lang: kase.lang, category: kase.category, turn: ti, language, ok: g.ok, code: g.code, ms, text: g.text,
          tools: (res.ok ? res.toolCalls : []).map((c) => ({ name: c.name, args: c.args, result: String(c.result).slice(0, 2_000) })), hardFails: g.hardFails, routing: g.routing, register: g.register, style: g.style, claim: g.claim });
        rows.push(...batch);
        if (g.ok && g.text) { rows.push({ key_id: `A${ti}`, direction: 'out', sender_kind: 'dana', text: g.text, ts: Date.now() }); earlier.push(g.text); }
        if (g.ok) answered = true;
        else failed += 1;
        if (!g.ok && g.code === 'quota') { aborted = 'quota'; break; }
        if (!answered && failed >= 2) { aborted = 'retell_unavailable'; break; }
      }
    } finally {
      if (chatId) { try { await retell.endChat(chatId); } catch { /* the chat times out on Retell's side */ } }
    }
    results.push({ kase, turns, ...(aborted ? { stop: aborted } : {}) });
  }
  return summarise({ cand, results, aborted, baseline: true });
}

/* ---------------- runEval ---------------- */

const dryConfig = () => ({ siteUrl: SITE, inventoryFile: WORKTREE_LISTINGS, env: {} });

/**
 * @param {{ mode?: 'live'|'dry', fake?: 'good'|'probes'|'quota', candidates?: object[], baseline?: 'retell'|null, casesFile?: string,
 *           only?: string[]|null, outDir?: string, maxUsd?: number, env?: object, cfg?: object, fetchImpl?: Function, retell?: object }} o
 *   `fake` (dry only): 'good' answers every case as its expectations say; 'probes' answers with each case's first
 *   failing probe; 'quota' runs out of credit on the fifth request (the tests of the failure paths).
 */
export async function runEval({
  mode = 'live', fake = 'good', candidates = parseCandidates(DEFAULT_CANDIDATES), baseline = null, casesFile = CASES_FILE, only = null,
  outDir = defaultOutDir(), maxUsd = MAX_USD, env = process.env, cfg: givenCfg = null, fetchImpl = globalThis.fetch, retell = null,
} = {}) {
  const dry = mode === 'dry';
  if (!dry && env[EVAL_FLAG] !== '1') throw new EvalError(`refused: a live run calls the provider; set ${EVAL_FLAG}=1 (owner OK) or use --dry-run`, 2);
  let cases = loadCases(casesFile);
  const fullCount = loadCases(CASES_FILE).length;
  const subset = Boolean(only) || path.resolve(casesFile) !== CASES_FILE;
  if (only) {
    cases = cases.filter((c) => only.includes(c.id));
    if (!cases.length) throw new EvalError('no case matches --only', 2);
  }
  const cfg = dry ? dryConfig() : (givenCfg ?? loadConfig());
  const siteUrl = String(cfg.siteUrl ?? SITE);
  const inventoryFile = cfg.inventoryFile ?? WORKTREE_LISTINGS;
  const siteFacts = createSiteFacts({ dir: path.dirname(inventoryFile) });
  if (!siteFacts.ok()) throw new EvalError('the site facts cannot be read', 3);
  let tmp = null;
  let keyFile = null;
  if (dry) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-eval-dry-'));
    keyFile = path.join(tmp, 'bona-brain.env');
    fs.writeFileSync(keyFile, 'BONA_OPENAI_API_KEY=dry-run-not-a-key\n', { mode: 0o600 });
  }
  const realFetch = fetchImpl;
  const savedFetch = globalThis.fetch;
  let netRefused = 0;
  let answers = null;
  // Nothing but the eval's own fetches may leave while it runs.
  globalThis.fetch = async () => { netRefused += 1; throw new Error('eval: refused request'); };
  try {
    if (!dry) {
      const probe = createBrain({ cfg, runTool: async () => '{}', fetchImpl: refuseFetch, siteFacts });
      if (!probe.configured) throw new EvalError('the brain is not configured: no readable ~/.secrets/bona-brain.env (names only, never the key)', 3);
    }
    const ctx = gradeContext({ siteUrl, inventoryFile, siteFacts });
    const runId = stamp();
    answers = openAnswers(outDir, runId);
    const toolFetch = dry ? refuseFetch : siteFetch({ realFetch, siteUrl });
    const publishedUnits = dry ? { get: async (listing) => (listing?.id === DRY_UNITS.listingId ? DRY_UNITS : null) } : createPublishedUnits({ siteUrl, fetch: toolFetch });
    const summaries = [];
    const read = { flags: [], refusals: [] };
    for (const cand of candidates) {
      summaries.push(await runCandidate({ cand, cases, mode, fake, cfg, siteFacts, siteUrl, inventoryFile, ctx, keyFile, realFetch, env, toolFetch, publishedUnits, write: answers.write, maxUsd, runId, read }));
    }
    if (baseline === 'retell') summaries.push(await runRetellBaseline({ cases, cfg, ctx, realFetch, write: answers.write, runId, retell, read }));
    // Only the whole canonical case file decides (Codex r1 P2): a subset (--only, another --cases file) is diagnostic.
    const decision = subset ? { verdict: 'subset', main: null, backup: null, backupMode: null, env: [], notes: [] } : decide(summaries);
    answers.write({ type: 'summary', run: runId, mode, maxUsd, subset, summaries, decision });
    const reportFile = answers.file.replace(/\.jsonl$/, '.report.txt');
    writeReport(reportFile, { runId, read });
    return {
      runId, mode, file: answers.file, reportFile, read, summaries, decision, netRefused, subset,
      cases: { all: cases.length, ar: cases.filter((c) => c.lang === 'ar').length, en: cases.filter((c) => c.lang === 'en').length, of: fullCount },
    };
  } finally {
    globalThis.fetch = savedFetch;
    if (answers) answers.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ---------------- the report: counts and p50/p90 only ---------------- */

const pct = (x) => `${(100 * x).toFixed(1)}%`;
const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;
function barMisses(s) {
  return [
    ...(s.complete ? [] : ['incomplete']), ...(s.hardCases === s.cases ? [] : ['hard']), ...(s.routingRate >= BAR.routing ? [] : ['routing']),
    ...(s.p90Ms <= BAR.p90Ms ? [] : ['p90']), ...(s.falseHitRate <= BAR.falseHitRate ? [] : ['false-hits']),
  ];
}
function line(s, subset = false) {
  const errs = Object.entries(s.errors).map(([k, v]) => `${k} ${v}`).join(', ') || '0';
  const verdict = s.baseline ? '' : subset ? '  subset' : !passesBar(s) ? `  FAIL (${barMisses(s).join(', ')})` : s.needsRead ? `  needs read (${s.needsRead} flagged)` : '  PASS';
  return `${s.label.padEnd(20)}hard ${s.hardCases}/${s.cases}  routing ${s.routingCases}/${s.cases} ${pct(s.routingRate)}  register ${s.registerOk}/${s.registerN}  `
    + `style ${s.styleOk}/${s.styleN}  guard repairs ${s.repairs}, hand-overs ${s.guardHandovers}, false hits ${s.falsePositives} ${pct(s.falseHitRate)}  errors ${errs}  p50 ${sec(s.p50Ms)}  p90 ${sec(s.p90Ms)}  `
    + `${s.baseline ? '' : `$/turn ${s.usdPerTurn.toFixed(4)}  $ ${s.usd.toFixed(2)}`}${verdict}`;
}
export function formatReport(res) {
  const out = [];
  if (res.mode === 'dry') out.push('DRY RUN (a scripted fake model, no network): these counts check the pipeline and say nothing about any model.');
  out.push(`bona brain eval ${res.runId}  cases ${res.cases.all} (ar ${res.cases.ar}, en ${res.cases.en})  answers ${res.file}`);
  out.push(`local report ${res.reportFile}  (flagged replies ${res.read.flags.length}, guard refusals ${res.read.refusals.length})`);
  for (const s of res.summaries) {
    if (s.skipped) { out.push(`${s.label}: skipped (${s.skipped})`); continue; }
    out.push(line(s, res.subset));
    const fails = Object.entries(s.hardFails).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`);
    if (fails.length) out.push(`  hard fails (cases): ${fails.join(', ')}`);
    if (s.aborted) out.push(`  stopped early: ${s.aborted} (${s.notRun} cases not run)`);
  }
  const d = res.decision;
  const tentative = d.main ? `main ${d.main.model} (effort ${d.main.effort}), backup ${d.backup ? `${d.backup.model} (effort ${d.backup.effort})` : 'none'}, backup mode ${d.backupMode}` : '';
  if (d.verdict === 'needs_read') {
    out.push(`decision: needs read (${d.flagged} flagged), tentative: ${tentative}`);
    out.push(...d.env.map((e) => `env (tentative): ${e}`));
  } else if (d.verdict === 'pass') {
    out.push(`decision: main ${d.main.model} (effort ${d.main.effort}), backup ${d.backup ? `${d.backup.model} (effort ${d.backup.effort})` : 'none'}, backup mode ${d.backupMode}`);
  } else if (d.verdict === 'subset') out.push(`decision: subset, no decision (${res.cases.all} of ${res.cases.of} cases)`);
  else out.push('decision: FAIL');
  if (d.verdict === 'pass') out.push(...(d.env.length ? d.env.map((e) => `env: ${e}`) : ['env: none (the defaults stand)']));
  out.push(...d.notes.map((n) => `note: ${n}`));
  return out;
}

/* ---------------- the CLI ---------------- */

export const USAGE = [
  'usage: run.mjs [--dry-run] [--models model:effort,...] [--baseline retell] [--only id,...] [--cases file] [--out-dir dir] [--max-usd n]',
  'exit: 0 pass, 1 fail, 2 refused or a bad option, 3 not configured, 4 subset (no decision), 5 needs read (flagged pick-turn replies: read them in the local report first)',
].join('\n');
/** The exit code of a decision (USAGE). */
export const exitCode = (d) => ({ pass: 0, subset: 4, needs_read: 5 }[d?.verdict] ?? 1);

export function parseArgs(argv) {
  const o = { dryRun: false, candidates: parseCandidates(DEFAULT_CANDIDATES), baseline: null, cases: CASES_FILE, only: null, outDir: defaultOutDir(), maxUsd: MAX_USD, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => {
      const v = argv[i += 1];
      if (v === undefined || v.startsWith('--')) throw new EvalError(`${a} needs a value`);
      return v;
    };
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--models') o.candidates = parseCandidates(value());
    else if (a === '--baseline') { o.baseline = value(); if (o.baseline !== 'retell') throw new EvalError('--baseline takes retell'); }
    else if (a === '--only') o.only = value().split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--cases') o.cases = path.resolve(value());
    else if (a === '--out-dir') o.outDir = path.resolve(value());
    else if (a === '--max-usd') { o.maxUsd = Number(value()); if (!(o.maxUsd > 0 && o.maxUsd <= 50)) throw new EvalError('--max-usd takes a number above 0, at most 50'); }
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new EvalError(`unknown option ${a}`);
  }
  return o;
}

export async function main(argv = process.argv.slice(2), { env = process.env, print = (l) => process.stdout.write(`${l}\n`), printErr = (l) => process.stderr.write(`${l}\n`) } = {}) {
  let o;
  try { o = parseArgs(argv); } catch (err) { printErr(`eval: ${err.message}\n${USAGE}`); return 2; }
  if (o.help) { print(USAGE); return 0; }
  if (!o.dryRun && env[EVAL_FLAG] !== '1') {
    printErr(`eval: refused. A live run calls the provider (≈ $2-3 a model). Set ${EVAL_FLAG}=1, with the owner's OK, or use --dry-run.`);
    return 2;
  }
  try {
    const res = await runEval({ mode: o.dryRun ? 'dry' : 'live', candidates: o.candidates, baseline: o.baseline, casesFile: o.cases, only: o.only, outDir: o.outDir, maxUsd: o.maxUsd, env });
    for (const l of formatReport(res)) print(l);
    return exitCode(res.decision);
  } catch (err) {
    if (err instanceof EvalError) { printErr(`eval: ${err.message}`); return err.exitCode; }
    printErr(`eval: failed (${err?.name ?? 'Error'}: ${String(err?.message ?? err).slice(0, 200)})`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => { process.exitCode = code; });
}
