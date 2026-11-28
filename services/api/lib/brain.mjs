/**
 * Bona's AI assistant on the OpenAI API (brain/DESIGN-brain.md §2-§4, §10; PLAN T25, PR-BR).
 * Zero dependencies: Chat Completions over `fetch`, the tools run in-process through the
 * concierge handlers (`runTool` = tools.run), and the output is Retell-shaped, so dana-wa's
 * `answerFrom` / `handoffDetails`, actions' `extractActions` and dana-commit read it unchanged.
 *
 * INERT until PR-B3 (T12) calls `turn()`: building it reads files only (the key file, then the
 * prompt and the site facts), never the network, and starts no timer. Without
 * `~/.secrets/bona-brain.env` (one name, BONA_OPENAI_API_KEY; read here only, never through
 * env.mjs, so the key is never in `cfg.env`, which every tool handler sees) it is
 * `configured: false` and every turn is `off`. A generic OPENAI_API_KEY anywhere is ignored, and
 * the key goes to no host but a PROVIDERS one.
 *
 * `~` is the HOME of the configured environment (`cfg.env.HOME`; the bona-api unit sets it, and
 * lib/env.mjs finds ~/.secrets through the same HOME), never `os.homedir()` on its own: an app or
 * a test built with its own env (`env: {}`) reads no real key. deploy.sh runs the full suite on
 * the VPS as the key's owner before every restart, so a test must never pick the key up.
 *
 *   turn({ route:'wa'|'mail'|'web', leadId, language:'ar'|'en', autoMode, history, batchText, leadFacts,
 *          turnContext:{ firstReply }, toolNames, earlierReplies, deadlineMs = 40 000 })
 *     → { ok:true, model, backup, rounds, ms, usd, usage:{in, cached, out, reasoning},
 *         toolCalls:[{id, name, args, result, ok}], messages:[Retell-shaped], guard:{ repaired } }
 *     | { ok:false, code }  (lib/brain/errors.mjs)
 *   history:   [{ role:'user'|'assistant'|'team', content }] (historyFromInbox builds it from the inbox)
 *   earlierReplies: the texts of this lead's earlier replies the guard passed (wa_outbox dana rows with
 *              guarded=1; T12); their amounts are allowed again. Email and web hand in none.
 *
 * The loop (§3.4): rounds 1-3 `tool_choice:'auto'`, round 4 `'none'`; at most 6 tools, request_human
 * included (the rest answer `tool_limit`; in a batch request_human runs first, so the cap never
 * refuses it while a tool is left);
 * a tool not offered on the route answers `tool_not_offered` and never runs; a thrown or slow
 * tool (10 s) answers the WhatsApp `tool_failed` note; 15 s per model call, 40 s per turn. The
 * reply guard checks the final text; one repair call (the draft is dropped, the note follows the
 * last user/tool message), then `guard`. A response cut off at the token cap is `bad_response`.
 * A `rate`, `down`, `timeout` or `bad_response` restarts the whole turn on the backup model when
 * at least 12 s remain and BONA_BRAIN_BACKUP_MODE is `answer`; a refusal is never retried
 * elsewhere. The caps are per turn (§2.4): the backup restart gets only what the main model left
 * of the 4 answer calls, the 1 repair call and the 6 tools, inside the same 40 s (tools only
 * read, so running them again is safe). Every request sent uses up a call, answered or not (an
 * HTTP error, a network error, a timeout, a rate-limit retry); one never sent (a runaway stop, no
 * time left) does not. A turn with no answer call left starts no backup and makes no retry.
 *
 * State (§4.1): quota/auth → `out` for 10 min (no call; then one half-open trial, a turn or a
 * classification, while the others get the out code with no call until it answers; the free
 * GET /v1/models probe clears `auth` early), with the restart-safe `brain_out` marker and one
 * `brain_out` alert. The out gate is checked before every paid request, as the runaway stops
 * are: a turn already in flight when another caller opens the outage sends no further round,
 * backup or repair (it ends with the out code and leaves the out state as it is), and only the
 * trial's success ends an outage (an answer to a request sent before it opened proves nothing).
 * After a restart with the marker set, the next turn is the trial at once, but `health().ok`
 * stays false until a turn or a classification works: the marker is a bare instant
 * (team.mjs), so it cannot say whether the outage was `auth` (a probe would prove the fix) or
 * `quota` (a probe proves nothing), and a key swap plus restart (§2.3) stays red until a client
 * writes (T14/T18: the Kuma "Bona AI" monitor). 3 rate limits in 5 min → the main model cools
 * down for 60 s (turns start on the backup). 3 turns that fail on every model in 10 min
 * (down/timeout) → the breaker opens for 5 min, then one trial (a WhatsApp turn or, when WhatsApp
 * is quiet, a mail classification). 3 bad responses in an hour → one `brain_bug` alert.
 *
 * Money (§2.4): every response's usage × lib/brain/prices.mjs → the restart-safe markers
 * `brain_usd_day` (`YYYY-MM-DD:<micro-USD>`) and `brain_usd_month` (`YYYY-MM:<micro-USD>`),
 * Riyadh time; `brain_spend` alerts at 80% and 100% of BONA_BRAIN_MONTH_ALERT_USD
 * (`brain_month_alerted`); the runaway stops (BONA_BRAIN_DAY_STOP_USD / _MONTH_STOP_USD) → `budget`,
 * checked before every paid request (each round, the backup, the repair, a classification) and
 * after every response: the request that crosses a stop ends its turn at once with `budget` (also
 * when it carried the answer) and the stop alert goes out in that turn, once per day or month.
 * `health().ok` is false while a stop is reached.
 *
 * Alerts go to the injected `alert(code, meta)` (T14 wires it to the owner notes and web push);
 * meta holds codes and levels only. The journal has no text and no digits from a client:
 * brain.call {route, model, ms, code, inTok, cachedTok, outTok, reasoningTok},
 * brain.turn {leadId, model, backup, rounds, tools, ms, usd, code}, brain.guard {leadId, kind},
 * brain.bad_tool {name}, brain.probe {ok, code}. `turn()` and `classify()` never reject.
 */
import path from 'node:path';
import { loadEnvFile } from './env.mjs';
import { BRAIN_DEFAULTS } from './config.mjs';
import { WORKTREE_LISTINGS } from './inventory.mjs';
import { createSiteFacts } from './site-facts.mjs';
import { checkReply, REPAIR_NOTE } from './reply-guard.mjs';
import { identity as personaIdentity } from './persona.mjs';
import { DEFAULT_BASE_URL, providerFor } from './brain/providers.mjs';
import { codeFromHttp, codeFromThrown, BACKUP_CODES, OUT_CODES, CODES } from './brain/errors.mjs';
import { requestBody, parseCompletion, assistantMessage, safetyIdentifier, cacheKey, retryAfterMs, usageOf, CHAT_PATH, MODELS_PATH } from './brain/openai.mjs';
import { toolsFor, routeToolNames, schemaArgNames } from './brain/tool-schemas.mjs';
import { loadPrompts, systemPrompt, contextNote, clientTurn, PROMPT_DIR, CHANNEL_SECTIONS } from './brain/prompt.mjs';
import { minimise as defaultMinimise, minimiseParts } from './brain/minimise.mjs';
import { costMicroUsd as defaultCost } from './brain/prices.mjs';

export const KEY_NAME = 'BONA_OPENAI_API_KEY';
export const KEY_FILE_NAME = 'bona-brain.env';

export const LIMITS = Object.freeze({
  callMs: 15_000, toolMs: 10_000, turnMs: 40_000, backupMinMs: 12_000, answerCalls: 4, repairCalls: 1, tools: 6, toolResultChars: 4_000,
  historyChars: 3_000, batchChars: 4_000, outMs: 10 * 60_000, rateCooldownMs: 60_000, rateWindowMs: 5 * 60_000, rateCount: 3, rateRetryMaxMs: 3_000,
  breakerCount: 3, breakerWindowMs: 10 * 60_000, breakerOpenMs: 5 * 60_000, bugCount: 3, bugWindowMs: 60 * 60_000, failedWindowMs: 10 * 60_000,
});

/** What a tool call answers when it is refused or fails (never dropped: every tool_call gets an answer). */
const TOOL_FAILED = JSON.stringify({ error: 'tool_failed', note: 'say you cannot check that right now; a person can help' });
const TOOL_NOT_OFFERED = JSON.stringify({ error: 'tool_not_offered' });
const TOOL_LIMIT = JSON.stringify({ error: 'tool_limit', note: 'answer with what you already have' });
/** The hand-over tool (it only notes the hand-over, tools.mjs): it runs first in a batch, so the 6-tool cap never refuses it while a tool is left. */
const HANDOVER_TOOL = 'request_human';
const SOURCES = Object.freeze({ wa: 'bona-whatsapp', mail: 'bona-email', web: 'bona-web' });
const TEAM_PREFIX = '[Bona team member] ';
const CONTEXT_ROWS = 10;
const ROW_CHARS = 300;
const DAY_MS = 86_400_000;
const LEAD_ID_RE = /^LEAD-[A-Za-z0-9-]{1,60}$/;
/** A tool name the journal may carry (`brain.bad_tool`): no digits, so a made-up name never logs a number. */
const TOOL_NAME_RE = /^[a-z][a-z_]{0,39}$/;
const OFF = Object.freeze({ ok: false, code: 'off' });
const fail = (code) => ({ ok: false, code });

const CLASSIFY_FORMAT = Object.freeze({
  type: 'json_schema',
  json_schema: {
    name: 'mail_class',
    strict: true,
    schema: {
      type: 'object', additionalProperties: false, required: ['class', 'wants'],
      properties: { class: { type: 'string', enum: ['client', 'not_client', 'unsure'] }, wants: { type: 'string' } },
    },
  },
});
const CLASSES = new Set(['client', 'not_client', 'unsure']);

/** The key from bona-brain.env, or null: one printable token, nothing else read from the file. */
export function readKey(file) {
  const v = loadEnvFile(file)[KEY_NAME];
  return typeof v === 'string' && /^[\x21-\x7e]{8,512}$/.test(v) ? v : null;
}

const clipChars = (s, max) => Array.from(String(s ?? '')).slice(0, max).join('');
const oneLine = (v, max) => clipChars(String(v ?? '').replace(/\s+/g, ' ').trim(), max);
const textOrMedia = (m) => (typeof m?.text === 'string' && m.text.trim() ? m.text.trim() : (m?.media_type ?? '[message]'));

/**
 * The conversation so far as role turns, from the inbox rows (dana-wa's recentContext rule: the
 * last 10 rows, each at most 300 characters, together at most 3,000, the newest kept). Client
 * rows are `user`, Dana's `assistant`, every other outbound row (staff, the owner's number) `team`.
 * Each row is masked before it is clipped, so a phone across the cut never leaves part of it.
 */
export function historyFromInbox(rows, { exclude = new Set() } = {}) {
  return inboxTurn(rows, { exclude }).history;
}

/**
 * What a turn gets from the inbox rows, as dana-wa hands them to turn() (PLAN T12): `history` (historyFromInbox's
 * turns: the rows not in `exclude`), `batchText` (the client's rows in `exclude`, this batch, one per line) and
 * `batchParts` (those rows, one each: hand them to turn() so their boundaries hold through its masking). The
 * client's rows, the batch's included, are masked as ONE series (minimiseParts) before any is clipped, so a number
 * split across two of them, or cut by the 300-character clip, never leaves a piece in clear (Codex r10, r11); ours
 * are masked on their own.
 */
export function inboxTurn(rows, { exclude = new Set() } = {}) {
  const all = (Array.isArray(rows) ? rows : []).filter(Boolean);
  const texts = all.map((m) => String(textOrMedia(m)));
  const ins = all.flatMap((m, i) => (m.direction === 'in' ? [i] : []));
  const masked = texts.map((t) => defaultMinimise(t));
  minimiseParts(ins.map((i) => texts[i])).forEach((t, k) => { masked[ins[k]] = t; });
  const batchParts = all.flatMap((m, i) => (exclude.has(m.key_id) && m.direction === 'in' ? [masked[i]] : []));
  const batchText = batchParts.join('\n');
  const list = all.map((m, i) => ({ m, text: masked[i] })).filter(({ m }) => !exclude.has(m.key_id)).slice(-CONTEXT_ROWS);
  const turns = list.map(({ m, text }) => ({ role: m.direction === 'in' ? 'user' : m.sender_kind === 'dana' ? 'assistant' : 'team', content: oneLine(text, ROW_CHARS) }));
  const size = () => turns.reduce((n, t) => n + t.content.length, 0);
  while (turns.length > 1 && size() > LIMITS.historyChars) turns.shift();
  return { history: turns, batchText, batchParts };
}

/** Retell-shaped messages: each tool call's invocation and result, then the answer. */
export function retellMessages(toolCalls, text) {
  const out = [];
  for (const c of Array.isArray(toolCalls) ? toolCalls : []) {
    out.push({ role: 'tool_call_invocation', tool_call_id: c.id, name: c.name, arguments: JSON.stringify(c.args ?? {}) });
    out.push({ role: 'tool_call_result', tool_call_id: c.id, content: typeof c.result === 'string' ? c.result : JSON.stringify(c.result ?? null) });
  }
  if (typeof text === 'string' && text) out.push({ role: 'agent', content: text });
  return out;
}

const riyadhDay = (ms) => new Date(Number(ms) + 3 * 3_600_000).toISOString().slice(0, 10);
const percentile = (values, p) => {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

/**
 * @param {object} deps
 * @param {object} [deps.cfg]  loadConfig(): the models, the backup mode and the $ knobs (never the key)
 * @param {(name: string, envelope: object) => Promise<string>} [deps.runTool]  tools.run
 * @param {object} [deps.team]  createTeam(): the brain_* markers
 * @param {Function} [deps.fetchImpl]
 * @param {() => number} [deps.now]
 * @param {(e: object) => void} [deps.log]
 * @param {(code: string, meta: object) => void} [deps.alert]  brain_out / brain_spend / brain_bug (T14 wires it)
 * @param {string} [deps.keyFile]  default <HOME>/.secrets/bona-brain.env, HOME = deps.home, else cfg.env.HOME
 *   (never os.homedir(): no HOME in the configured env, no key)
 * @param {string} [deps.home]
 * @param {string} [deps.baseUrl]  default https://api.openai.com/v1; refused unless a PROVIDERS host
 * @param {object} [deps.siteFacts]  default createSiteFacts over the folder of cfg.inventoryFile
 * @param {string} [deps.promptDir]  default services/api/prompts
 * @param {object} [deps.limits]  test-only overrides of LIMITS
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 */
export function createBrain(deps = {}) {
  const {
    cfg = {}, runTool = null, team = null, fetchImpl = globalThis.fetch, now = () => Date.now(), log = () => {}, alert = () => {},
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), minimise = defaultMinimise, guard = { checkReply }, prices = { costMicroUsd: defaultCost },
  } = deps;
  const limits = { ...LIMITS, ...(deps.limits ?? {}) };
  const envHome = typeof cfg.env?.HOME === 'string' && path.isAbsolute(cfg.env.HOME) ? cfg.env.HOME : null;
  const home = deps.home ?? envHome;
  const keyFile = deps.keyFile ?? (home ? path.join(home, '.secrets', KEY_FILE_NAME) : null);
  const baseUrl = String(deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const models = {
    main: cfg.brainModel ?? BRAIN_DEFAULTS.model,
    backup: cfg.brainBackupModel ?? BRAIN_DEFAULTS.backupModel,
    classify: cfg.brainClassifyModel ?? BRAIN_DEFAULTS.classifyModel,
  };
  const backupMode = cfg.brainBackupMode ?? BRAIN_DEFAULTS.backupMode;
  const usd = {
    alert: cfg.brainMonthAlertUsd ?? BRAIN_DEFAULTS.monthAlertUsd,
    dayStop: cfg.brainDayStopUsd ?? BRAIN_DEFAULTS.dayStopUsd,
    monthStop: cfg.brainMonthStopUsd ?? BRAIN_DEFAULTS.monthStopUsd,
  };
  const say = (e) => { try { log(e); } catch { /* a journal failure never breaks a turn */ } };
  const tell = (code, meta) => { try { alert(code, meta); } catch { /* the alert sink is best effort */ } };

  /* ---------------- configuration: files only, never the network ---------------- */
  let key = null;
  let prompts = { assistant: null, classify: null };
  let siteFacts = null;
  const setupFailure = (() => {
    if (!providerFor(`${baseUrl}/`)) return 'host';
    if (typeof fetchImpl !== 'function' || typeof runTool !== 'function') return 'deps';
    key = keyFile ? readKey(keyFile) : null;
    if (!key) return 'key';
    prompts = loadPrompts({ dir: deps.promptDir ?? PROMPT_DIR });
    if (typeof prompts.assistant !== 'string') return 'prompt';
    siteFacts = deps.siteFacts ?? createSiteFacts({ dir: path.dirname(cfg.inventoryFile ?? WORKTREE_LISTINGS), now });
    if (!siteFacts.ok()) return 'facts';
    try {
      for (const route of Object.keys(CHANNEL_SECTIONS)) {
        for (const l of ['en', 'ar']) systemPrompt({ template: prompts.assistant, route, siteFacts: siteFacts.block(l), identity: personaIdentity() });
      }
    } catch {
      return 'prompt';
    }
    if (!systemPrompt({ template: prompts.assistant, route: 'wa', siteFacts: siteFacts.block('en'), identity: personaIdentity() })) return 'prompt';
    return null;
  })();
  const configured = setupFailure === null;
  if (!configured) key = null;

  const promptCache = new Map();
  function promptFor(route, language) {
    const facts = siteFacts.block(language);
    const k = `${route}|${language}`;
    const hit = promptCache.get(k);
    if (hit && hit.facts === facts) return hit.text;
    let text = null;
    try { text = systemPrompt({ template: prompts.assistant, route, siteFacts: facts, identity: personaIdentity() }); } catch { text = null; }
    promptCache.set(k, { facts, text });
    return text;
  }

  /* ---------------- state ---------------- */
  const setting = (k) => { try { return team?.getSetting?.(k) ?? ''; } catch { return ''; } };
  /** A marker write; never breaks a turn. True when it was saved (or there is no store). */
  const store = (k, v) => { try { team?.setSetting?.(k, v, { by: 'system' }); return true; } catch { return false; } };
  const state = {
    // A marker from before a restart: not ok until a call works, but the next turn tries at once.
    outCode: configured && /^\d+$/.test(setting('brain_out')) ? 'restored' : null,
    outUntil: 0,
    /** The one request after the out window (or after a restart with the marker): the half-open trial, else null. */
    outTrial: null,
    breaker: { fails: [], open: false, openUntil: 0, trial: false },
    rate: { events: [], cooldownUntil: 0 },
    bugs: [],
    bugAlertedAt: -Infinity,
    lastFailedAllAt: -Infinity,
    lastProbeOk: null,
    lastTurnBackup: false,
    stopAlerted: { day: null, month: null },
    spend: { day: '', dayMicro: 0, month: '', monthMicro: 0, alerted: '' },
    turns: [],
  };

  function enterOut(code) {
    const t = now();
    if (state.outCode === null) {
      tell('brain_out', { code });
      if (!/^\d+$/.test(setting('brain_out'))) store('brain_out', String(t));
    }
    state.outCode = code;
    state.outUntil = t + limits.outMs;
    state.outTrial = null;
  }
  function clearOut() {
    if (state.outCode !== null || setting('brain_out') !== '') store('brain_out', '');
    state.outCode = null;
    state.outUntil = 0;
    state.outTrial = null;
  }
  /**
   * The out gate (§4.1), for a turn and a classification alike: the code to fail with and make no call, or null.
   * Inside the 10 minutes nobody calls; after them (or after a restart with the marker) exactly one caller is the
   * half-open trial (`takeOutTrial`) and the others fail until it answers: an answer clears `out`, a quota or auth
   * answer starts another 10 minutes, anything else (no answer, a throw of ours) frees it for the next caller.
   * A restored marker does not say quota or auth, so the others get `down`, as the open breaker's do.
   */
  function outBlocked(t) {
    if (state.outCode === null || (t >= state.outUntil && !state.outTrial)) return null;
    return state.outCode === 'restored' ? 'down' : state.outCode;
  }
  /**
   * The out gate before one paid request (`call`): null when there is no outage or this caller holds the trial
   * (`ctx.outTrial`), else the code to stop with. A caller that passed runTurn's or classify's gate before the
   * outage opened holds no trial, so its next request is never sent.
   */
  function outGate(ctx) {
    if (state.outCode === null || ownsOutTrial(ctx.outTrial)) return null;
    return state.outCode === 'restored' ? 'down' : state.outCode;
  }
  function ownsOutTrial(token) {
    return Boolean(token) && state.outTrial === token;
  }
  /** A success ends the outage only from the trial; with no outage it clears a stray marker, as before. */
  function clearOutAfter(token) {
    if (state.outCode === null || ownsOutTrial(token)) clearOut();
  }
  /** Past the gate while `out`: this caller is the trial. Its token, freed with `freeOutTrial` when the caller ends. */
  function takeOutTrial() {
    if (state.outCode === null) return null;
    state.outTrial = {};
    return state.outTrial;
  }
  function freeOutTrial(token) {
    if (token && state.outTrial === token) state.outTrial = null;
  }
  const inCooldown = (t) => t < state.rate.cooldownUntil;
  function noteRate(model) {
    if (model !== models.main) return;
    const t = now();
    state.rate.events = [...state.rate.events.filter((x) => t - x < limits.rateWindowMs), t];
    if (state.rate.events.length >= limits.rateCount) {
      state.rate.cooldownUntil = t + limits.rateCooldownMs;
      state.rate.events = [];
    }
  }
  function noteBug() {
    const t = now();
    state.bugs = [...state.bugs.filter((x) => t - x < limits.bugWindowMs), t];
    if (state.bugs.length >= limits.bugCount && t - state.bugAlertedAt >= limits.bugWindowMs) {
      state.bugAlertedAt = t;
      tell('brain_bug', {});
    }
  }

  /* ---------------- money ---------------- */
  function readSpend(t) {
    const day = riyadhDay(t);
    const month = day.slice(0, 7);
    if (!team) {
      return { day, month, dayMicro: state.spend.day === day ? state.spend.dayMicro : 0, monthMicro: state.spend.month === month ? state.spend.monthMicro : 0 };
    }
    const d = /^(\d{4}-\d{2}-\d{2}):(\d{1,15})$/.exec(setting('brain_usd_day'));
    const m = /^(\d{4}-\d{2}):(\d{1,15})$/.exec(setting('brain_usd_month'));
    // Never less than this process counted: a total the store refused to save still counts (Codex r14).
    const mine = { day: state.spend.day === day ? state.spend.dayMicro : 0, month: state.spend.month === month ? state.spend.monthMicro : 0 };
    return {
      day, month,
      dayMicro: Math.max(d && d[1] === day ? Number(d[2]) : 0, mine.day),
      monthMicro: Math.max(m && m[1] === month ? Number(m[2]) : 0, mine.month),
    };
  }
  /**
   * Save this process's spend totals; false when the store refused (a full disk, a locked file). While they cannot be
   * saved the meter fails closed (stopReached()): no paid request goes out until a save works again (Codex r14).
   */
  function flushSpend() {
    if (!team || !state.spend.day) return true;
    const s = state.spend;
    const okDay = store('brain_usd_day', `${s.day}:${s.dayMicro}`);
    const okMonth = store('brain_usd_month', `${s.month}:${s.monthMicro}`);
    const ok = okDay && okMonth;
    if (!ok && !state.meterBroken) say({ level: 'error', evt: 'brain.meter_failed' });
    state.meterBroken = !ok;
    return ok;
  }
  function spend(micro) {
    if (!(micro > 0)) return;
    const cur = readSpend(now());
    const dayMicro = Math.min(cur.dayMicro + micro, 999_999_999_999_999);
    const monthMicro = Math.min(cur.monthMicro + micro, 999_999_999_999_999);
    state.spend = { ...state.spend, day: cur.day, dayMicro, month: cur.month, monthMicro };
    flushSpend();
    const level = monthMicro >= usd.alert * 1e6 ? 100 : monthMicro >= usd.alert * 0.8 * 1e6 ? 80 : 0;
    if (!level) return;
    const marked = /^(\d{4}-\d{2}):(80|100)$/.exec(team ? setting('brain_month_alerted') : state.spend.alerted);
    const done = marked && marked[1] === cur.month ? Number(marked[2]) : 0;
    if (level > done) {
      tell('brain_spend', { level });
      state.spend.alerted = `${cur.month}:${level}`;
      store('brain_month_alerted', `${cur.month}:${level}`);
    }
  }
  /** 'day' | 'month' when a runaway stop is reached, else null. No alert (health() reads it too). */
  function stopReached() {
    const cur = readSpend(now());
    const which = cur.dayMicro >= usd.dayStop * 1e6 ? 'day' : cur.monthMicro >= usd.monthStop * 1e6 ? 'month' : null;
    return which ? { which, period: which === 'day' ? cur.day : cur.month } : null;
  }
  /** True while the spend totals cannot be saved: no paid request may be SENT (a response already paid for still counts). */
  const meterBlocked = () => state.meterBroken && !flushSpend();
  /** 'day' | 'month' when a runaway stop is reached (one alert per day or month), else null. */
  function overBudget() {
    const stop = stopReached();
    if (!stop) return null;
    if (state.stopAlerted[stop.which] !== stop.period) {
      state.stopAlerted[stop.which] = stop.period;
      tell('brain_spend', { stop: stop.which });
    }
    return stop.which;
  }

  /* ---------------- one model call ---------------- */
  /**
   * One paid request. A runaway stop is checked before it is sent and again after its response is
   * counted: a request that crosses a stop answers `budget` (its alert goes out now), so the turn
   * stops at once and never sends the next round, the backup or the repair. The out gate is checked
   * before it is sent too (`outGate`): an outage opened by another caller meanwhile answers its out
   * code, marked `gated` (nothing was sent, nothing learnt), so the turn ends on the outage path.
   * With a `slot` ('answer' or 'repair') every request sent takes one from the turn's allowance
   * (`ctx.allow[slot]`), whatever comes back; a rate-limit retry only when one is left.
   */
  async function call(model, ctx, messages, toolChoice, acc, { retried = false, noRetry = false, slot = null } = {}) {
    if (overBudget() || meterBlocked()) return fail('budget');
    const held = outGate(ctx);
    if (held) return { ...fail(held), gated: true };
    // While the breaker is open only the half-open trial's own requests go out: a turn whose first request was sent
    // before it opened sends no further round (Codex r12), gated (nothing sent, nothing learnt).
    if (state.breaker.open && (ctx.trial ?? null) !== state.breaker.trial) return { ...fail('down'), gated: true };
    const left = ctx.deadline - now();
    if (left <= 0) return fail('timeout');
    if (slot) ctx.allow[slot] -= 1;
    const body = requestBody({ model, messages, tools: ctx.tools, toolChoice, cacheKey: ctx.cacheKey, safetyId: ctx.safetyId, responseFormat: ctx.responseFormat });
    const started = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(limits.callMs, left)));
    let res = null;
    let text = '';
    let thrown = null;
    try {
      res = await fetchImpl(`${baseUrl}${CHAT_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      thrown = err;
    } finally {
      clearTimeout(timer);
    }
    let json = null;
    if (!thrown) { try { json = JSON.parse(text); } catch { json = null; } }
    const usage = json ? usageOf(json) : { in: 0, cached: 0, out: 0, reasoning: 0 };
    const micro = prices.costMicroUsd(model, usage);
    if (acc) {
      for (const k of ['in', 'cached', 'out', 'reasoning']) acc.usage[k] += usage[k];
      acc.micro += micro;
    }
    spend(micro);
    let out;
    if (thrown) out = fail(codeFromThrown(thrown));
    else if (!res.ok) out = fail(codeFromHttp(res.status, json));
    else out = json ? parseCompletion(json) : fail('bad_response');
    if (overBudget()) out = fail('budget');
    say({ evt: 'brain.call', route: ctx.route, model, ms: now() - started, code: out.ok ? null : out.code, inTok: usage.in, cachedTok: usage.cached, outTok: usage.out, reasoningTok: usage.reasoning });
    if (!out.ok && out.code === 'rate') {
      noteRate(model);
      const wait = retryAfterMs(res?.headers);
      if (!noRetry && !retried && wait !== null && wait <= limits.rateRetryMaxMs && ctx.deadline - now() > wait && (!slot || ctx.allow[slot] > 0)) {
        await sleep(wait);
        // The retry is a request of its own: as the last answer call of the turn, the model must answer.
        const again = slot === 'answer' && ctx.allow.answer === 1 ? 'none' : toolChoice;
        return call(model, ctx, messages, again, acc, { retried: true, slot });
      }
    }
    return out;
  }

  /* ---------------- tools ---------------- */
  /** Only the arguments the tool's schema knows, without the nulls strict mode sends for "not given". */
  function cleanArgs(name, args) {
    const known = new Set(schemaArgNames(name));
    return Object.fromEntries(Object.entries(args ?? {}).filter(([k, v]) => known.has(k) && v !== null && v !== undefined));
  }
  async function runOne(name, args, ctx) {
    const envelope = {
      chat: {
        chat_id: `${ctx.route}:${ctx.leadId}`,
        metadata: { source: SOURCES[ctx.route], lead_id: ctx.leadId },
        retell_llm_dynamic_variables: { language: ctx.language, locale: ctx.language },
      },
      args,
    };
    const ms = Math.max(0, Math.min(limits.toolMs, ctx.deadline - now()));
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => runTool(name, envelope)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('tool_timeout')), ms); }),
      ]);
      const s = typeof result === 'string' ? result : JSON.stringify(result ?? null);
      return { result: s.slice(0, limits.toolResultChars), ok: true };
    } catch {
      return { result: TOOL_FAILED, ok: false };
    } finally {
      clearTimeout(timer);
    }
  }
  /**
   * Answers every tool call of one response, in the order asked, taking each tool from the turn's allowance
   * (`ctx.allow.tools`, shared with the backup restart). request_human counts too, but it takes its tool
   * first, so the hand-over is never refused while a tool is left (a batch of 6 searches and a hand-over
   * runs the hand-over and 5 searches).
   */
  async function runTools(calls, ctx) {
    const order = [...calls.keys()].sort((a, b) => Number(calls[b].name === HANDOVER_TOOL) - Number(calls[a].name === HANDOVER_TOOL));
    const jobs = new Array(calls.length);
    for (const k of order) {
      const c = calls[k];
      if (!ctx.offered.has(c.name)) {
        say({ evt: 'brain.bad_tool', name: TOOL_NAME_RE.test(c.name) ? c.name : 'unknown' });
        jobs[k] = { id: c.id, name: c.name, args: {}, result: TOOL_NOT_OFFERED, ok: false, ran: false };
        continue;
      }
      const args = cleanArgs(c.name, c.args);
      if (ctx.allow.tools <= 0) {
        jobs[k] = { id: c.id, name: c.name, args, result: TOOL_LIMIT, ok: false, ran: false };
        continue;
      }
      ctx.allow.tools -= 1;
      jobs[k] = runOne(c.name, args, ctx).then((r) => ({ id: c.id, name: c.name, args, result: r.result, ok: r.ok, ran: true }));
    }
    return Promise.all(jobs);
  }

  /* ---------------- one attempt on one model ---------------- */
  /**
   * The repair request (§5.4): the same messages, then the note right after the last user or tool
   * message. With tool rounds that is the last tool message; without, it is the client turn, so the
   * code-made context note (the only message after it) moves just before the client turn.
   */
  function repairMessages(messages) {
    const last = messages.at(-1);
    const base = last?.role === 'system' && messages.at(-2)?.role === 'user' ? [...messages.slice(0, -2), last, messages.at(-2)] : messages;
    return [...base, { role: 'system', content: REPAIR_NOTE }];
  }

  /** One attempt on one model, inside the turn's allowance (`ctx.allow`: answer calls, repair calls, tools). */
  async function attempt(model, ctx, acc) {
    const { allow } = ctx;
    const messages = [...ctx.base];
    const reported = [];
    const results = [];
    let rounds = 0;
    const passes = (text) => {
      const v = guard.checkReply(text, { toolResults: results, earlierReplies: ctx.earlier, siteUrl: cfg.siteUrl });
      for (const h of v.hits) say({ evt: 'brain.guard', leadId: ctx.logLead, kind: h.kind });
      return v.ok;
    };
    while (allow.answer > 0) {
      // The last answer call of the turn (round 4), or no tool left: the model must answer.
      const choice = allow.answer === 1 || allow.tools <= 0 ? 'none' : 'auto';
      const res = await call(model, ctx, messages, choice, acc, { slot: 'answer' });
      rounds += 1;
      if (!res.ok) return res;
      if (res.refusal) return fail('refusal');
      if (res.toolCalls.length) {
        // Tools on the last answer call (round 4, or a retry that became it) leave nothing to answer with.
        if (choice === 'none' || allow.answer <= 0) return fail('bad_response');
        messages.push(assistantMessage(res));
        for (const d of await runTools(res.toolCalls, ctx)) {
          messages.push({ role: 'tool', tool_call_id: d.id, content: d.result });
          reported.push(d);
          if (d.ran) results.push(d.result);
          // A hand-over the model asked for is kept for the turn, so a backup restart still carries it (Codex r13).
          if (d.ran && d.name === HANDOVER_TOOL && ctx.handover && !ctx.handover.includes(d)) ctx.handover.push(d);
        }
        continue;
      }
      if (!res.text) return fail('bad_response');
      if (passes(res.text)) return { ok: true, model, rounds, text: res.text, calls: reported, repaired: false };
      // One repair call a turn: the draft is dropped (never sent, never stored, never sent back).
      if (allow.repair <= 0) return fail('guard');
      const fix = await call(model, ctx, repairMessages(messages), 'none', acc, { slot: 'repair' });
      if (!fix.ok) return fix;
      if (fix.refusal) return fail('refusal');
      if (fix.toolCalls.length || !fix.text || !passes(fix.text)) return fail('guard');
      return { ok: true, model, rounds, text: fix.text, calls: reported, repaired: true };
    }
    return fail('bad_response');
  }

  /* ---------------- bookkeeping ---------------- */
  function record(entry) {
    const t = now();
    state.turns = [...state.turns.filter((x) => t - x.at < DAY_MS), { at: t, ...entry }].slice(-5000);
  }
  /**
   * The end of the half-open trial (a turn or a classification): down/timeout open the breaker
   * for another 5 min, any answer from the provider closes it, and `undefined` (the trial threw
   * before it learnt anything) or `budget` (a runaway stop ended it, maybe before any request)
   * only frees it, so the next caller tries again.
   */
  function endTrial(code) {
    const b = state.breaker;
    b.trial = false;
    if (code === undefined || code === 'budget') return;
    if (code === 'down' || code === 'timeout') b.openUntil = now() + limits.breakerOpenMs;
    else { b.open = false; b.fails = []; }
  }
  /** After a turn that called a model: the out state (cleared only by the out trial, `outTrial`), the breaker, the bug count. */
  function settle(code, wasTrial, outTrial) {
    const t = now();
    const b = state.breaker;
    if (code === null) {
      clearOutAfter(outTrial);
      // Only the half-open trial closes an open breaker: any other answer while it is open came from a request sent
      // before it opened (Codex r11).
      // ...and only the trial frees its slot: a late answer from before must not let a second trial in (Claude r16).
      if (wasTrial) { b.open = false; b.fails = []; b.trial = false; }
      return;
    }
    if (OUT_CODES.has(code)) enterOut(code);
    if (BACKUP_CODES.has(code) || OUT_CODES.has(code)) state.lastFailedAllAt = t;
    if (code === 'bad_response') noteBug();
    if (wasTrial) {
      endTrial(code);
      return;
    }
    if (code === 'down' || code === 'timeout') {
      b.fails = [...b.fails.filter((x) => t - x < limits.breakerWindowMs), t];
      if (!b.open && b.fails.length >= limits.breakerCount) {
        b.open = true;
        b.openUntil = t + limits.breakerOpenMs;
        tell('brain_out', { code: 'down' });
      }
    }
  }

  /**
   * The conversation so far as chat messages: each row minimised, then clipped to 300 characters (also
   * when the caller did not build the history with historyFromInbox), the newest 3,000 characters, same
   * roles merged.
   */
  function historyMessages(history) {
    const kept = [];
    let size = 0;
    for (const h of [...(Array.isArray(history) ? history : [])].reverse()) {
      const role = h?.role;
      const text = typeof h?.content === 'string' ? h.content.trim() : '';
      if (!text || !['user', 'assistant', 'team'].includes(role)) continue;
      const body = clipChars(minimise(text), ROW_CHARS);
      const content = role === 'team' ? `${TEAM_PREFIX}${body}` : body;
      if (kept.length && size + content.length > limits.historyChars) break;
      size += content.length;
      kept.unshift({ role: role === 'team' ? 'assistant' : role, content });
    }
    const merged = [];
    for (const m of kept) {
      if (merged.at(-1)?.role === m.role) merged.at(-1).content += `\n\n${m.content}`;
      else merged.push({ ...m });
    }
    return merged;
  }

  /**
   * The client's own rows (the history's `user` rows, then this batch), masked as one text (minimiseParts): a
   * number split across two of the client's messages, a reply of ours between them or not, is masked in both
   * pieces (Codex r9). Only the client's rows: an amount in our reply never joins a client's number.
   */
  function clientRows(history, batchParts) {
    const rows = Array.isArray(history) ? history : [];
    const parts = batchParts.map((p) => (typeof p === 'string' ? p : ''));
    const at = rows.flatMap((h, i) => (h?.role === 'user' && typeof h.content === 'string' ? [i] : []));
    const masked = minimiseParts([...at.map((i) => rows[i].content), ...parts]);
    const out = rows.slice();
    at.forEach((i, k) => { out[i] = { ...rows[i], content: masked[k] }; });
    return { history: out, batch: masked.slice(at.length).join('\n') };
  }

  /* ---------------- turn ---------------- */
  async function runTurn(input) {
    const route = input.route;
    if (!configured || !Object.hasOwn(SOURCES, route) || !routeToolNames(route).length) return OFF;
    const language = input.language === 'en' ? 'en' : 'ar';
    const system = promptFor(route, language);
    if (!system) return OFF;
    const leadId = String(input.leadId ?? '');
    const logLead = LEAD_ID_RE.test(leadId) ? leadId : null;
    const started = now();
    const end = (out) => {
      const ms = now() - started;
      say({ evt: 'brain.turn', leadId: logLead, model: out.ok ? out.model : null, backup: Boolean(out.ok && out.backup), rounds: out.ok ? out.rounds : 0, tools: out.ok ? out.toolCalls.length : 0, ms, usd: out.ok ? out.usd : 0, code: out.ok ? null : out.code });
      record({ ok: out.ok, model: out.ok ? out.model : null, backup: Boolean(out.ok && out.backup), ms, code: out.ok ? null : out.code, repaired: Boolean(out.ok && out.guard?.repaired), in: out.ok ? out.usage.in : 0, cached: out.ok ? out.usage.cached : 0 });
      return out;
    };
    // Gates that make no model call: the runaway stops, `out`, the open breaker, a cooling main model without a backup.
    if (overBudget() || meterBlocked()) return end(fail('budget'));
    const outCode = outBlocked(started);
    if (outCode) return end(fail(outCode));
    const b = state.breaker;
    if (b.open && (started < b.openUntil || b.trial)) return end(fail('down'));
    let trial = null;
    if (b.open) {
      trial = {};
      b.trial = trial;
    }
    const outTrial = takeOutTrial();
    try {
      return await modelTurn(input, { route, language, system, leadId, logLead, started, end, wasTrial: trial !== null, trial, outTrial });
    } finally {
      // A throw before settle() (a bug of ours, never the provider) frees the trial, so the next
      // turn is the trial again instead of `down` with no call until a restart.
      if (trial && b.trial === trial) endTrial(undefined);
      // settle() has moved `out` on by now (cleared, or another 10 minutes); any other end frees the out trial.
      freeOutTrial(outTrial);
    }
  }

  /** The part of a turn that may call a model, once runTurn's gates passed. */
  async function modelTurn(input, { route, language, system, leadId, logLead, started, end, wasTrial, trial = null, outTrial }) {
    const answerBackup = backupMode === 'answer' && Boolean(models.backup) && models.backup !== models.main;
    const startOnBackup = inCooldown(started);
    if (startOnBackup && !answerBackup) return end(fail('rate'));

    const turnMs = Number.isFinite(input.deadlineMs) && input.deadlineMs > 0 ? Math.min(input.deadlineMs, limits.turnMs) : limits.turnMs;
    const offeredTools = toolsFor(route, Array.isArray(input.toolNames) ? input.toolNames : undefined);
    const client = clientRows(input.history, Array.isArray(input.batchParts) ? input.batchParts : [String(input.batchText ?? '')]);
    const ctx = {
      route, language, leadId, logLead, outTrial, trial,
      // request_human calls that ran in any attempt of this turn (attempt()): the result always carries them.
      handover: [],
      deadline: started + turnMs,
      // The per-turn caps (§2.4), shared by the main attempt and the backup restart.
      allow: { answer: limits.answerCalls, repair: limits.repairCalls, tools: limits.tools },
      tools: offeredTools,
      offered: new Set(offeredTools.map((t) => t.function.name)),
      cacheKey: cacheKey(route, language),
      safetyId: safetyIdentifier(leadId),
      earlier: (Array.isArray(input.earlierReplies) ? input.earlierReplies : []).filter((s) => typeof s === 'string'),
      base: [
        { role: 'system', content: system },
        ...historyMessages(client.history),
        // The batch is masked (clientRows, its messages as parts) before the 4,000-character clip, and never masked
        // again as one joined text, so two of its messages keep their boundary (Codex r12); clientTurn masks the CRM
        // facts before it clips them.
        { role: 'user', content: clientTurn({ batchText: clipChars(client.batch, limits.batchChars), leadFacts: input.leadFacts }) },
        { role: 'system', content: contextNote({ now: started, route, firstReply: Boolean(input.turnContext?.firstReply), autoMode: Boolean(input.autoMode) }) },
      ],
    };
    const acc = { usage: { in: 0, cached: 0, out: 0, reasoning: 0 }, micro: 0 };
    let model = startOnBackup ? models.backup : models.main;
    let backup = startOnBackup;
    let res = await attempt(model, ctx, acc);
    // The backup restart gets what is left of the turn: the time, the answer and repair calls, the tools.
    if (!res.ok && !res.gated && BACKUP_CODES.has(res.code) && !backup && answerBackup && ctx.deadline - now() >= limits.backupMinMs && ctx.allow.answer > 0) {
      if (res.code === 'bad_response') noteBug();
      model = models.backup;
      backup = true;
      res = await attempt(model, ctx, acc);
    }
    if (!res.ok) {
      // Stopped by the out gate (another caller opened the outage): no request was sent, so the out state, the
      // breaker and the bug count stay as they are (runTurn's finally frees a breaker trial).
      if (!res.gated) settle(res.code, wasTrial, outTrial);
      return end(fail(res.code));
    }
    settle(null, wasTrial, outTrial);
    state.lastTurnBackup = backup;
    // A hand-over the main model asked for before it failed stays in the backup's result (dana-wa hands over on it).
    const calls = [...ctx.handover.filter((c) => !res.calls.includes(c)), ...res.calls];
    return end({
      ok: true, model, backup, rounds: res.rounds, ms: now() - started, usd: acc.micro / 1e6, usage: acc.usage,
      toolCalls: calls.map(({ id, name, args, result, ok }) => ({ id, name, args, result, ok })),
      messages: retellMessages(calls.filter((c) => c.ran), res.text),
      guard: { repaired: res.repaired },
    });
  }

  async function turn(input = {}) {
    try {
      return await runTurn(input ?? {});
    } catch {
      say({ evt: 'brain.turn', leadId: null, model: null, backup: false, rounds: 0, tools: 0, ms: 0, usd: 0, code: 'bad_response' });
      return fail('bad_response');
    }
  }

  /* ---------------- the mail classifier (DESIGN-brain §7): no tools, no site facts, fail closed ---------------- */
  async function classify(input = {}) {
    const b = state.breaker;
    let trial = null;
    let trialCode;
    let outTrial = null;
    try {
      if (!configured || typeof prompts.classify !== 'string' || !prompts.classify.trim()) return { error: 'off' };
      if (overBudget() || meterBlocked()) return { error: 'budget' };
      const t = now();
      const outCode = outBlocked(t);
      if (outCode) return { error: outCode };
      if (b.open) {
        // Half-open after the 5 min: this call may be the one trial (once email is live, WhatsApp
        // may be quiet for hours; without this every mail would stay listed after a recovery).
        if (t < b.openUntil || b.trial) return { error: 'down' };
        trial = {};
        b.trial = trial;
      }
      outTrial = takeOutTrial(); // the out trial too, the same way
      // Each part is masked before it is clipped, so a phone across a cut leaves no digit.
      const masked = (v) => minimise(String(v ?? ''));
      const user = minimise(`From: ${oneLine(masked(input.fromName), 80)} (${oneLine(masked(input.fromDomain), 120)})\nSubject: ${oneLine(masked(input.subject), 200)}\n\n${clipChars(masked(input.text ?? input.text600), 600)}`);
      const ctx = {
        route: 'classify', tools: [], cacheKey: 'bona-classify-v1', responseFormat: CLASSIFY_FORMAT, deadline: t + limits.callMs, outTrial, trial,
        safetyId: typeof input.senderKey === 'string' && input.senderKey ? safetyIdentifier(`mail:${input.senderKey.toLowerCase()}`) : undefined,
      };
      const res = await call(models.classify, ctx, [{ role: 'system', content: prompts.classify.trim() }, { role: 'user', content: user }], undefined, null, { noRetry: true });
      trialCode = res.gated ? undefined : res.ok ? null : res.code;
      if (!res.ok) {
        if (OUT_CODES.has(res.code) && !res.gated) enterOut(res.code);
        return { error: res.code };
      }
      if (res.refusal) return { error: 'refusal' };
      let parsed = null;
      try { parsed = JSON.parse(res.text); } catch { parsed = null; }
      if (!parsed || !CLASSES.has(parsed.class) || typeof parsed.wants !== 'string') return { error: 'bad_response' };
      // Only the out trial's answer ends an outage; one to a request sent before it opened proves nothing.
      if (state.outCode !== null) clearOutAfter(outTrial);
      return { class: parsed.class, wants: oneLine(parsed.wants, 120) };
    } catch {
      return { error: 'bad_response' };
    } finally {
      if (trial && b.trial === trial) endTrial(trialCode);
      freeOutTrial(outTrial);
    }
  }

  /* ---------------- the free models probe ($0; T14 runs it every 15 min) ---------------- */
  async function probe() {
    if (!configured) return { ok: false, code: 'off' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limits.callMs);
    let out;
    try {
      const res = await fetchImpl(`${baseUrl}${MODELS_PATH}`, { method: 'GET', headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
      await res.text().catch(() => '');
      out = res.ok ? { ok: true } : { ok: false, code: codeFromHttp(res.status, null) };
    } catch (err) {
      out = { ok: false, code: codeFromThrown(err) };
    } finally {
      clearTimeout(timer);
    }
    state.lastProbeOk = out.ok;
    // A models list says the key works; it says nothing about credit, so only `auth` clears.
    if (out.ok && state.outCode === 'auth') clearOut();
    if (!out.ok && out.code === 'auth') enterOut('auth');
    say({ evt: 'brain.probe', ok: out.ok, code: out.ok ? null : out.code });
    return out;
  }

  /* ---------------- /health (booleans only) and the owner's Ops rows ---------------- */
  function health() {
    if (!configured) return { configured: false, ok: false, backup: false };
    const t = now();
    const ok = state.outCode === null && !state.breaker.open && state.lastProbeOk !== false && t - state.lastFailedAllAt >= limits.failedWindowMs
      && !stopReached(); // a runaway stop answers every turn `budget`; the alert went out with the turn that hit it
    return { configured: true, ok, backup: inCooldown(t) || state.lastTurnBackup };
  }
  function ops() {
    if (!configured) return {};
    const t = now();
    const day = state.turns.filter((x) => t - x.at < DAY_MS);
    const good = day.filter((x) => x.ok);
    const turnsByModel = {};
    for (const x of good) turnsByModel[x.model] = (turnsByModel[x.model] ?? 0) + 1;
    const errors = {};
    for (const x of day) if (!x.ok && CODES.includes(x.code)) errors[x.code] = (errors[x.code] ?? 0) + 1;
    const tokens = good.reduce((a, x) => ({ in: a.in + x.in, cached: a.cached + x.cached }), { in: 0, cached: 0 });
    const spent = readSpend(t);
    return {
      turnsByModel,
      backupTurns: good.filter((x) => x.backup).length,
      errors,
      guardRepairs: good.filter((x) => x.repaired).length,
      guardHandovers: day.filter((x) => x.code === 'guard').length,
      cachedRatio: tokens.in ? Math.round((tokens.cached / tokens.in) * 1000) / 1000 : 0,
      usdToday: spent.dayMicro / 1e6,
      usdMonth: spent.monthMicro / 1e6,
      p50Ms: percentile(good.map((x) => x.ms), 50),
      p90Ms: percentile(good.map((x) => x.ms), 90),
      out: state.outCode !== null,
      breaker: state.breaker.open,
      cooldown: inCooldown(t),
    };
  }

  return {
    get configured() { return configured; },
    turn, classify, probe, health, ops,
  };
}
