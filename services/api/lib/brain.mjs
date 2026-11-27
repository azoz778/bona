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
 * The loop (§3.4): rounds 1-3 `tool_choice:'auto'`, round 4 `'none'`; at most 6 tools (the rest
 * answer `tool_limit`); a tool not offered on the route answers `tool_not_offered` and never
 * runs; a thrown or slow tool (10 s) answers the WhatsApp `tool_failed` note; 15 s per model
 * call, 40 s per turn. The reply guard checks the final text; one repair call (the draft is
 * dropped, the note follows the last user/tool message), then `guard`. A `rate`, `down`,
 * `timeout` or `bad_response` restarts the whole turn on the backup model when at least 12 s
 * remain and BONA_BRAIN_BACKUP_MODE is `answer`; a refusal is never retried elsewhere.
 *
 * State (§4.1): quota/auth → `out` for 10 min (no call; the next turn after that tries; the free
 * GET /v1/models probe clears `auth` early), with the restart-safe `brain_out` marker and one
 * `brain_out` alert. After a restart with the marker set, the next turn tries at once, but
 * `health().ok` stays false until a turn or a classification works: the marker is a bare instant
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
 * (`brain_month_alerted`); the runaway stops (BONA_BRAIN_DAY_STOP_USD / _MONTH_STOP_USD) → `budget`.
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
import { minimise as defaultMinimise } from './brain/minimise.mjs';
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
const SOURCES = Object.freeze({ wa: 'bona-whatsapp', mail: 'bona-email', web: 'bona-web' });
const TEAM_PREFIX = '[Bona team member] ';
const CONTEXT_ROWS = 10;
const ROW_CHARS = 300;
const DAY_MS = 86_400_000;
const LEAD_ID_RE = /^LEAD-[A-Za-z0-9-]{1,60}$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
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
  const list = (Array.isArray(rows) ? rows : []).filter((m) => m && !exclude.has(m.key_id)).slice(-CONTEXT_ROWS);
  const turns = list.map((m) => ({ role: m.direction === 'in' ? 'user' : m.sender_kind === 'dana' ? 'assistant' : 'team', content: oneLine(defaultMinimise(String(textOrMedia(m))), ROW_CHARS) }));
  const size = () => turns.reduce((n, t) => n + t.content.length, 0);
  while (turns.length > 1 && size() > LIMITS.historyChars) turns.shift();
  return turns;
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
  const store = (k, v) => { try { team?.setSetting?.(k, v, { by: 'system' }); } catch { /* a marker write never breaks a turn */ } };
  const state = {
    // A marker from before a restart: not ok until a call works, but the next turn tries at once.
    outCode: configured && /^\d+$/.test(setting('brain_out')) ? 'restored' : null,
    outUntil: 0,
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
  }
  function clearOut() {
    if (state.outCode !== null || setting('brain_out') !== '') store('brain_out', '');
    state.outCode = null;
    state.outUntil = 0;
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
    return { day, month, dayMicro: d && d[1] === day ? Number(d[2]) : 0, monthMicro: m && m[1] === month ? Number(m[2]) : 0 };
  }
  function spend(micro) {
    if (!(micro > 0)) return;
    const cur = readSpend(now());
    const dayMicro = Math.min(cur.dayMicro + micro, 999_999_999_999_999);
    const monthMicro = Math.min(cur.monthMicro + micro, 999_999_999_999_999);
    state.spend = { ...state.spend, day: cur.day, dayMicro, month: cur.month, monthMicro };
    store('brain_usd_day', `${cur.day}:${dayMicro}`);
    store('brain_usd_month', `${cur.month}:${monthMicro}`);
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
  /** 'day' | 'month' when a runaway stop is reached (one alert per day or month), else null. */
  function overBudget() {
    const cur = readSpend(now());
    const which = cur.dayMicro >= usd.dayStop * 1e6 ? 'day' : cur.monthMicro >= usd.monthStop * 1e6 ? 'month' : null;
    if (which) {
      const period = which === 'day' ? cur.day : cur.month;
      if (state.stopAlerted[which] !== period) {
        state.stopAlerted[which] = period;
        tell('brain_spend', { stop: which });
      }
    }
    return which;
  }

  /* ---------------- one model call ---------------- */
  async function call(model, ctx, messages, toolChoice, acc, { retried = false, noRetry = false } = {}) {
    const left = ctx.deadline - now();
    if (left <= 0) return fail('timeout');
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
    say({ evt: 'brain.call', route: ctx.route, model, ms: now() - started, code: out.ok ? null : out.code, inTok: usage.in, cachedTok: usage.cached, outTok: usage.out, reasoningTok: usage.reasoning });
    if (!out.ok && out.code === 'rate') {
      noteRate(model);
      const wait = retryAfterMs(res?.headers);
      if (!noRetry && !retried && wait !== null && wait <= limits.rateRetryMaxMs && ctx.deadline - now() > wait) {
        await sleep(wait);
        return call(model, ctx, messages, toolChoice, acc, { retried: true });
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
  /** Answers every tool call of one response; returns the answers and how many tools have run this attempt. */
  async function runTools(calls, ctx, alreadyRun) {
    let n = alreadyRun;
    const jobs = calls.map((c) => {
      if (!ctx.offered.has(c.name)) {
        say({ evt: 'brain.bad_tool', name: TOOL_NAME_RE.test(c.name) ? c.name : 'unknown' });
        return { id: c.id, name: c.name, args: {}, result: TOOL_NOT_OFFERED, ok: false, ran: false };
      }
      const args = cleanArgs(c.name, c.args);
      if (n >= limits.tools) return { id: c.id, name: c.name, args, result: TOOL_LIMIT, ok: false, ran: false };
      n += 1;
      return runOne(c.name, args, ctx).then((r) => ({ id: c.id, name: c.name, args, result: r.result, ok: r.ok, ran: true }));
    });
    return { done: await Promise.all(jobs), ran: n };
  }

  /* ---------------- one attempt on one model ---------------- */
  async function attempt(model, ctx, acc) {
    const messages = [...ctx.base];
    const reported = [];
    const results = [];
    let toolsRun = 0;
    let rounds = 0;
    const passes = (text) => {
      const v = guard.checkReply(text, { toolResults: results, earlierReplies: ctx.earlier });
      for (const h of v.hits) say({ evt: 'brain.guard', leadId: ctx.logLead, kind: h.kind });
      return v.ok;
    };
    while (rounds < limits.answerCalls) {
      const choice = rounds === limits.answerCalls - 1 || toolsRun >= limits.tools ? 'none' : 'auto';
      const res = await call(model, ctx, messages, choice, acc);
      rounds += 1;
      if (!res.ok) return res;
      if (res.refusal) return fail('refusal');
      if (res.toolCalls.length) {
        if (choice === 'none') return fail('bad_response');
        messages.push(assistantMessage(res));
        const { done, ran } = await runTools(res.toolCalls, ctx, toolsRun);
        toolsRun = ran;
        for (const d of done) {
          messages.push({ role: 'tool', tool_call_id: d.id, content: d.result });
          reported.push(d);
          if (d.ran) results.push(d.result);
        }
        continue;
      }
      if (!res.text) return fail('bad_response');
      if (passes(res.text)) return { ok: true, model, rounds, text: res.text, calls: reported, repaired: false };
      // One repair call: the draft is dropped (never sent, never stored, never sent back), and
      // the note follows the last user or tool message (or the code-made context note).
      const fix = await call(model, ctx, [...messages, { role: 'system', content: REPAIR_NOTE }], 'none', acc);
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
   * before it learnt anything) only frees it, so the next caller tries again.
   */
  function endTrial(code) {
    const b = state.breaker;
    b.trial = false;
    if (code === undefined) return;
    if (code === 'down' || code === 'timeout') b.openUntil = now() + limits.breakerOpenMs;
    else { b.open = false; b.fails = []; }
  }
  /** After a turn that called a model: the out state, the breaker, the bug count. */
  function settle(code, wasTrial) {
    const t = now();
    const b = state.breaker;
    if (code === null) {
      clearOut();
      if (b.open || wasTrial) { b.open = false; b.fails = []; }
      b.trial = false;
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

  /** The conversation so far as chat messages: minimised, the newest 3,000 characters, same roles merged. */
  function historyMessages(history) {
    const kept = [];
    let size = 0;
    for (const h of [...(Array.isArray(history) ? history : [])].reverse()) {
      const role = h?.role;
      const text = typeof h?.content === 'string' ? h.content.trim() : '';
      if (!text || !['user', 'assistant', 'team'].includes(role)) continue;
      const content = minimise(role === 'team' ? `${TEAM_PREFIX}${text}` : text);
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
    if (overBudget()) return end(fail('budget'));
    if (state.outCode !== null && started < state.outUntil) return end(fail(state.outCode));
    const b = state.breaker;
    let trial = null;
    if (b.open) {
      if (started < b.openUntil || b.trial) return end(fail('down'));
      trial = {};
      b.trial = trial;
    }
    try {
      return await modelTurn(input, { route, language, system, leadId, logLead, started, end, wasTrial: trial !== null });
    } finally {
      // A throw before settle() (a bug of ours, never the provider) frees the trial, so the next
      // turn is the trial again instead of `down` with no call until a restart.
      if (trial && b.trial === trial) endTrial(undefined);
    }
  }

  /** The part of a turn that may call a model, once runTurn's gates passed. */
  async function modelTurn(input, { route, language, system, leadId, logLead, started, end, wasTrial }) {
    const answerBackup = backupMode === 'answer' && Boolean(models.backup) && models.backup !== models.main;
    const startOnBackup = inCooldown(started);
    if (startOnBackup && !answerBackup) return end(fail('rate'));

    const turnMs = Number.isFinite(input.deadlineMs) && input.deadlineMs > 0 ? Math.min(input.deadlineMs, limits.turnMs) : limits.turnMs;
    const offeredTools = toolsFor(route, Array.isArray(input.toolNames) ? input.toolNames : undefined);
    const ctx = {
      route, language, leadId, logLead,
      deadline: started + turnMs,
      tools: offeredTools,
      offered: new Set(offeredTools.map((t) => t.function.name)),
      cacheKey: cacheKey(route, language),
      safetyId: safetyIdentifier(leadId),
      earlier: (Array.isArray(input.earlierReplies) ? input.earlierReplies : []).filter((s) => typeof s === 'string'),
      base: [
        { role: 'system', content: system },
        ...historyMessages(input.history),
        // Masked before the clip, so a phone across the 4,000-character cut leaves no digit.
        { role: 'user', content: minimise(clientTurn({ batchText: clipChars(minimise(String(input.batchText ?? '')), limits.batchChars), leadFacts: input.leadFacts })) },
        { role: 'system', content: contextNote({ now: started, route, firstReply: Boolean(input.turnContext?.firstReply), autoMode: Boolean(input.autoMode) }) },
      ],
    };
    const acc = { usage: { in: 0, cached: 0, out: 0, reasoning: 0 }, micro: 0 };
    let model = startOnBackup ? models.backup : models.main;
    let backup = startOnBackup;
    let res = await attempt(model, ctx, acc);
    if (!res.ok && BACKUP_CODES.has(res.code) && !backup && answerBackup && ctx.deadline - now() >= limits.backupMinMs) {
      if (res.code === 'bad_response') noteBug();
      model = models.backup;
      backup = true;
      res = await attempt(model, ctx, acc);
    }
    if (!res.ok) {
      settle(res.code, wasTrial);
      return end(fail(res.code));
    }
    settle(null, wasTrial);
    state.lastTurnBackup = backup;
    return end({
      ok: true, model, backup, rounds: res.rounds, ms: now() - started, usd: acc.micro / 1e6, usage: acc.usage,
      toolCalls: res.calls.map(({ id, name, args, result, ok }) => ({ id, name, args, result, ok })),
      messages: retellMessages(res.calls.filter((c) => c.ran), res.text),
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
    try {
      if (!configured || typeof prompts.classify !== 'string' || !prompts.classify.trim()) return { error: 'off' };
      if (overBudget()) return { error: 'budget' };
      const t = now();
      if (state.outCode !== null && t < state.outUntil) return { error: state.outCode };
      if (b.open) {
        // Half-open after the 5 min: this call may be the one trial (once email is live, WhatsApp
        // may be quiet for hours; without this every mail would stay listed after a recovery).
        if (t < b.openUntil || b.trial) return { error: 'down' };
        trial = {};
        b.trial = trial;
      }
      // Each part is masked before it is clipped, so a phone across a cut leaves no digit.
      const masked = (v) => minimise(String(v ?? ''));
      const user = minimise(`From: ${oneLine(masked(input.fromName), 80)} (${oneLine(masked(input.fromDomain), 120)})\nSubject: ${oneLine(masked(input.subject), 200)}\n\n${clipChars(masked(input.text ?? input.text600), 600)}`);
      const ctx = {
        route: 'classify', tools: [], cacheKey: 'bona-classify-v1', responseFormat: CLASSIFY_FORMAT, deadline: t + limits.callMs,
        safetyId: typeof input.senderKey === 'string' && input.senderKey ? safetyIdentifier(`mail:${input.senderKey.toLowerCase()}`) : undefined,
      };
      const res = await call(models.classify, ctx, [{ role: 'system', content: prompts.classify.trim() }, { role: 'user', content: user }], undefined, null, { noRetry: true });
      trialCode = res.ok ? null : res.code;
      if (!res.ok) {
        if (OUT_CODES.has(res.code)) enterOut(res.code);
        return { error: res.code };
      }
      if (res.refusal) return { error: 'refusal' };
      let parsed = null;
      try { parsed = JSON.parse(res.text); } catch { parsed = null; }
      if (!parsed || !CLASSES.has(parsed.class) || typeof parsed.wants !== 'string') return { error: 'bad_response' };
      if (state.outCode !== null) clearOut();
      return { class: parsed.class, wants: oneLine(parsed.wants, 120) };
    } catch {
      return { error: 'bad_response' };
    } finally {
      if (trial && b.trial === trial) endTrial(trialCode);
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
    const ok = state.outCode === null && !state.breaker.open && state.lastProbeOk !== false && t - state.lastFailedAllAt >= limits.failedWindowMs;
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
