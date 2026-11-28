#!/usr/bin/env node
/**
 * bona-api — the concierge backend behind Dana (دانة).
 *
 * The Bona site is a static Astro build on GitHub Pages, so anything dynamic lives
 * here: a small Node HTTP service (no framework) reached through the Cloudflare
 * tunnel `bona` at https://bona-api.azoz.uk.
 *
 *   GET  /health
 *   POST /v1/chat/session          { locale, page? }         -> { sessionId, greeting }
 *   POST /v1/chat/message          { sessionId, text, … }    -> { messages, actions, leadCaptured? }
 *   POST /v1/chat/end              { sessionId }             -> { ok }
 *   POST /v1/call/token            { locale, page? }         -> { accessToken, callId, transport?, url?, iceServers? }
 *   GET  /v1/call/:callId/context                            -> { listings, updatedAt }
 *   POST /v1/tools/<name>?token=   (Retell custom tools)
 *   POST /v1/retell/webhook?token= (Retell agent events)
 *   POST /v1/events                { v:1, event, event_id, … }  -> 204   (text/plain or JSON, ≤ 8 KB)
 *   POST /v1/enquiry               { form, name, phone, … }    -> { lead_id }
 *   GET  /dashboard/*              the owner's private dashboard (WhatsApp code login)
 *   *    /v1/admin/*               the same data as JSON, behind the same cookie
 *
 * Everything is JSON, `Cache-Control: no-store`, CORS-allowlisted, per-IP rate
 * limited, and bodies are capped at 16 KB (8 KB for events). The one exception is a
 * request that arrives on a legacy site host (see `lib/legacy.mjs`): it is 301'd to
 * `BONA_SITE` before any of that runs.
 */
import { createTelegramHandoffs } from './lib/telegram-handoff.mjs';
import { ensureHandoff, taskCounts } from './lib/lead-tasks.mjs';
import { previousEnquiry, saveEnquiryReceipt, recoverPendingNotifications } from './lib/enquiry-receipt.mjs';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { loadConfig, redacted } from './lib/config.mjs';
import { corsHeaders, isAllowedOrigin } from './lib/cors.mjs';
import { isLegacyHost, legacyRedirectUrl } from './lib/legacy.mjs';
import { createLimiter, clientIp, trustedPeer } from './lib/ratelimit.mjs';
import { openDb, newId } from './lib/db.mjs';
import { validateEvent, recordEvent, cleanAttrIds, MAX_BODY_BYTES as MAX_EVENT_BYTES } from './lib/events.mjs';
import { validateEnquiry } from './lib/enquiry.mjs';
import { createFanout } from './lib/fanout.mjs';
import { createPoller } from './lib/wa-poller.mjs';
import { importJsonl } from './lib/import-legacy.mjs';
import { createBudget } from './lib/budget.mjs';
import { createInventory } from './lib/inventory.mjs';
import { createUnits } from './lib/units.mjs';
import { createStore } from './lib/store.mjs';
import { createRetellClient, createHealthProbe, RetellError } from './lib/retell.mjs';
import { createToolHandlers, extractToken, tokenMatches, TOOL_NAMES } from './lib/tools.mjs';
import { extractActions } from './lib/actions.mjs';
import { appendJsonl, createOrMergeLead } from './lib/leads.mjs';
import { sendText, waConfig } from './lib/wa.mjs';
import { createTeam, TeamError, isExcludedLead } from './lib/team.mjs';
import { createAudit } from './lib/audit.mjs';
import { createSender, splitMark, INTERRUPTED_MS as INTERRUPTED_SEND_MS } from './lib/wa-send.mjs';
import { createInboxStore, RETENTION_MS, CANDIDATE_KEEP_MS, DISMISSED_KEEP_MS } from './lib/inbox/store.mjs';
import { createIngest } from './lib/inbox/ingest.mjs';
import { createBackfill, JOIN_HISTORY_MS } from './lib/inbox/backfill.mjs';
import { loggableName, loggableCode } from './lib/inbox/loggable.mjs';
import { bareJid } from './lib/evolution.mjs';
import { createPusher, vapidKeys, VAPID_SUBJECT_RE } from './lib/push.mjs';
import { createAlerts } from './lib/alerts.mjs';
import { createDana } from './lib/dana-wa.mjs';
import { createFundsWatch, fundsOutSince } from './lib/dana-funds.mjs';
import { createDashboardRoutes } from './lib/dashboard/routes.mjs';
// The module seams of the WhatsApp + email automation (PR-F2b; DESIGN §2, §7.1, §8.4). Each is a
// stub that keeps today's behaviour until its own PR replaces it (PLAN §1.13).
import { createOwnerTest } from './lib/owner-test.mjs';
import { createOwnerNotes } from './lib/owner-notes.mjs';
import { createViewing } from './lib/viewing.mjs';
import { createWaLink } from './lib/wa-link.mjs';
import { createPacing } from './lib/pacing.mjs';
import { createPushPolicy } from './lib/push-policy.mjs';
import { createDanaCommit } from './lib/dana-commit.mjs';
import { createMail } from './lib/mail/index.mjs';
import { createBrain } from './lib/brain.mjs';
import { createDailySummary, summaryOn, SUMMARY_HOUR, CATCH_UP_BEFORE_HOUR } from './lib/daily-summary.mjs';
import { dayKey, TZ_OFFSET_MS } from './lib/dashboard/stats.mjs';

/** The website chat's greeting when Retell sends none: nameless (brain migration, 27 Nov; PLAN T14). */
const GREETING = {
  en: "Hello, I'm Bona's AI assistant. How can I help you today?",
  ar: 'أهلاً، أنا مساعدة بونا الذكية. كيف أقدر أساعدك؟',
};

/** Login-code outbox rows and purged chats' send stubs exist only to count the day's sends; two days covers any rolling 24 h. */
const CODE_ROW_TTL_MS = 2 * 86_400_000;
/** How often the real server runs `app.inboxMaintenance()` (TIMERS 'upkeep'). */
const INBOX_UPKEEP_EVERY_MS = 24 * 3_600_000;
/**
 * The only error codes /health may name (DESIGN §5.4): a fixed enum, never upstream text, which
 * can carry a calendar id or an address. Anything else a module reports reads as null.
 */
const HEALTH_ERROR_CODES = new Set(['auth', 'forbidden', 'not_found', 'timeout', 'quota', 'network', 'bad_response']);
/**
 * The workers PR-INT puts on a clock (PLAN T14): the owner notes' pass, the daily summary's minute (with
 * the calendar's 05:00 reconcile), the hold and backlog sweep, the viewing worker, the brain's free
 * GET /v1/models probe, and the daily upkeep. The link probe keeps its own 10-minute loop (lib/wa-link.mjs).
 */
export const TIMERS = Object.freeze([
  ['notes', 5_000], ['summary', 60_000], ['sweep', 60_000], ['viewing', 5 * 60_000], ['brainProbe', 15 * 60_000], ['upkeep', INBOX_UPKEEP_EVERY_MS],
  // The identity watch (PR-INT r1): a link probe every 30 s until the instance is proven once (then the probe's own
  // 10-minute loop), and a wake for the chats Dana refused as `identity` meanwhile.
  ['identity', 30_000],
]);
/** The calendar's daily reconcile hour, Riyadh time (DESIGN §8.4); it also runs before the summary builds. */
const RECONCILE_HOUR = 5;
/** DESIGN §5.4: latencyOk = p90 ≤ 60 s over the answers' ring, once it holds 5 answers. */
const LATENCY_OK_MS = 60_000;
const LATENCY_MIN_ANSWERS = 5;
/**
 * The pre-update database copies (services/deploy/vps/db-snapshot.mjs) go after 29 days by their own UTC stamp, so a
 * once-a-day run never lets one pass the 30 days the privacy text promises (PLAN T14, "Added 27 Nov").
 */
const BACKUP_MAX_AGE_DAYS = 29;
const DAY_MS = 86_400_000;
/** A snapshot of any label (db-snapshot.mjs ANY_NAME_RE; group 1 its UTC stamp) and a killed run's temp copy (its PARTIAL_RE). */
const SNAPSHOT_NAME_RE = /^bona-[a-z0-9][a-z0-9-]{0,39}-(\d{8}T\d{6}Z)\.db$/;
const SNAPSHOT_PARTIAL_RE = /^\.bona-[a-z0-9][a-z0-9-]{0,39}-\d{8}T\d{6}Z\.db\.[1-9]\d{0,9}\.[0-9a-f]{12}\.partial$/;

/** The time (ms) a snapshot stamp (20261127T111500Z) stands for, or NaN when it is no real UTC time. */
function snapshotTime(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  if (!m) return NaN;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isFinite(t) && new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '') === stamp ? t : NaN;
}

/**
 * The daily backup prune of one release-backups folder (PLAN T14, "Added 27 Nov"): every snapshot whose stamp is
 * more than BACKUP_MAX_AGE_DAYS before `now`, and every temp copy whose file time is more than a day before it
 * (a younger one may be a run still writing it). Plain files only: a sub-folder or a link is never touched, nor
 * any other name. The rules of services/deploy/vps/db-snapshot.mjs `--max-age-days`, by name and age.
 * @returns {{ expired: number, abandoned: number }}
 */
export function pruneReleaseBackups(outDir, now) {
  const cutoff = now - BACKUP_MAX_AGE_DAYS * DAY_MS;
  const partialCutoff = now - DAY_MS;
  let expired = 0;
  let abandoned = 0;
  for (const name of fs.readdirSync(outDir).sort()) {
    const snap = SNAPSHOT_NAME_RE.exec(name);
    if (!snap && !SNAPSHOT_PARTIAL_RE.test(name)) continue;
    const file = path.join(outDir, name);
    let st;
    try { st = fs.lstatSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    if (snap ? !(snapshotTime(snap[1]) < cutoff) : !(st.mtimeMs < partialCutoff)) continue;
    try {
      fs.unlinkSync(file);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
    if (snap) expired += 1; else abandoned += 1;
  }
  return { expired, abandoned };
}
/** The tool_failed note on WhatsApp and email (critic round 2 #17a): no number, a person can help. */
const TOOL_FAILED_NOTE_CLIENT = 'Tell the client you cannot check that right now; a person can help.';
const TOOL_FAILED_NOTE_VISITOR = 'Tell the visitor you cannot check that right now and offer WhatsApp +966 57 626 7694.';

const jsonLog = (level, obj) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, ...obj });
  if (level === 'error') console.error(line); else console.log(line);
};

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

export function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extraHeaders,
  });
  res.end(body);
}

/** Raw JSON value (used for Retell tool results, which are JSON strings). */
function sendRaw(res, status, jsonText, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(jsonText),
    'Cache-Control': 'no-store',
    // The dashboard's page CSP trusts every same-origin GET (`script-src 'self'`), so no
    // answer on this origin may be sniffed into a script.
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(jsonText);
}

export async function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Stop reading but leave the socket alive long enough to answer 413.
        req.pause();
        reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJsonBody(text) {
  if (!text || !text.trim()) return {};
  const value = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('body must be a JSON object'), { code: 'BAD_BODY' });
  }
  return value;
}

const asLocale = (v) => (String(v ?? 'en').toLowerCase().startsWith('ar') ? 'ar' : 'en');
const asText = (v, max = 2000) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * A page title reaches the model verbatim as `{{page_title}}`, and the page it comes
 * from is under nobody's control once a link is shared. Brackets and braces are the
 * punctuation of instructions — markers, JSON, templates — so they come out, and the
 * whole thing is short enough that it cannot become a paragraph of its own.
 */
export const asPageTitle = (v, max = 80) =>
  String(v ?? '').replace(/[[\]{}<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

/** POST routes the browser widget may call. Anything else is 404 before any budget is spent. */
export const BROWSER_ROUTES = new Set(['/v1/chat/session', '/v1/chat/message', '/v1/chat/end', '/v1/call/token', '/v1/enquiry']);

/** The two routes that open something Retell bills for, and the day counter each one spends. */
export const BILLABLE_ROUTES = new Map([['/v1/chat/session', 'chats'], ['/v1/call/token', 'calls']]);

/**
 * Shape check for the billable routes, run *before* the day's budget is charged. A body
 * that is the wrong shape never reaches Retell, so it costs the owner nothing — and it must
 * not cost the day a unit either, or a script POSTing junk 300 times closes the concierge
 * until midnight in Jeddah for free.
 *
 * It is deliberately no stricter than the routes themselves. Both fields are optional (the
 * widget may send an empty object) and `page` may be a plain path string: the chat widget
 * sends `window.location.pathname` and the call widget passes the same string through, so
 * a check that insisted on `{ url, title }` would 400 every real visitor.
 */
export function assertBillableBody(body) {
  const bad = (message) => Object.assign(new Error(message), { code: 'BAD_BODY' });
  const { locale, page } = body;
  if (locale !== undefined && locale !== null && typeof locale !== 'string') throw bad('locale must be a string');
  if (page !== undefined && page !== null && typeof page !== 'string' && (typeof page !== 'object' || Array.isArray(page))) {
    throw bad('page must be a path or an object');
  }
  if (page && typeof page === 'object') {
    if (page.url !== undefined && page.url !== null && typeof page.url !== 'string') throw bad('page.url must be a string');
    if (page.title !== undefined && page.title !== null && typeof page.title !== 'string') throw bad('page.title must be a string');
  }
}

const isJsonContentType = (value) => /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i.test(String(value ?? '').trim());
/** `text/plain` (with or without a charset). The one media type a cross-origin `fetch`
    may send without a preflight, which is why the enquiry form uses it. */
const isPlainTextContentType = (value) => /^text\/plain\s*(?:;|$)/i.test(String(value ?? '').trim());

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

export function createApp(options = {}) {
  const cfg = options.config ?? loadConfig();
  const log = options.log ?? ((obj) => jsonLog(obj.level ?? 'info', obj));
  const inventory = options.inventory ?? createInventory({ file: cfg.inventoryFile, siteUrl: cfg.siteUrl });
  // Per-unit stock sits beside listings.json in the same checkout, so one path
  // decides both and a redeploy can never leave them pointing at different trees.
  const units = options.units ?? createUnits({
    file: path.join(path.dirname(cfg.inventoryFile), 'units.json'),
  });
  const store = options.store ?? createStore();
  const db = options.db ?? openDb(cfg.dbFile ?? path.join(cfg.dataDir, 'bona.db'));
  const ownsDb = !options.db;
  if (ownsDb) recoverPendingNotifications(db);
  const retell = options.retell ?? createRetellClient({ apiKey: cfg.retellApiKey, mock: cfg.retellMock });
  // The queue behind `db.enqueueFanout()`. Constructed always, started only by the real
  // server (below): a test drains it by hand so nothing goes out on a timer.
  const fanout = options.fanout ?? createFanout({ db, cfg, log });
  const probeRetell = options.probeRetell ?? createHealthProbe(retell);
  const sendWhatsApp = options.sendWhatsApp ?? ((text) => sendText(text, { env: cfg.env }));
  // Team accounts (2026-09-27 design §3). The owner is (re)seeded on every start from
  // BONA_OWNER_JID — which also hands him every session that predates accounts, so his
  // live login survives the deploy; everyone else is added on the Team page.
  // The owner test (lib/owner-test.mjs) is built below, from the team; the team reads it back through this
  // reference on every call, so the owner's own number is a client's chat while his test is on (DESIGN §3.2).
  let ownerTest = null;
  const team = options.team ?? createTeam(db, { log, ownerTest: () => ownerTest });
  // The owner (BONA_OWNER_JID) and the instance's own number (BONA_WA_INSTANCE_JID) are two
  // numbers since 2026-11-19 (design 2026-11-16 §11); unset, the second is the first.
  const wa = waConfig(cfg.env ?? {});
  try {
    team.ensureOwner({ phone: bareJid(wa.ownerJid), name: cfg.env?.BONA_OWNER_NAME ?? 'Abdulaziz' });
  } catch (err) {
    // A malformed BONA_OWNER_JID must not take the public site (chat, enquiries, Retell
    // tools) down with it. The dashboard stays usable for any account already stored,
    // and this line says loudly why a fresh owner could not be seeded.
    if (!(err instanceof TeamError)) throw err;
    log({ level: 'error', evt: 'team.owner_seed_failed', error: err.code });
  }
  const audit = options.audit ?? createAudit(db, { log });
  // The clock the inbox pieces, and the poller that feeds them, read. Only tests pin it;
  // everything else in this file keeps reading Date.now() as before.
  const clock = options.now ?? (() => Date.now());
  // The fetch the sender, the backfill and the poller go out through. A test hands in a
  // fake so nothing leaves the process; left undefined, each falls back to the global fetch.
  const fetchImpl = options.fetchImpl;
  // A chat's purge, fanned out (PR-F2b, critic round 2 #15): purgeLead calls it inside its own
  // transaction, before it deletes anything, so leaveInbox, the retention purge and the test
  // switch-off all reach the subscribers registered below (viewing, the owner-notes ledger)
  // without either ever editing the store. A subscriber writes rows only; one that throws rolls
  // the purge back.
  const purgeSubscribers = [];
  const onPurge = (leadId) => { for (const fn of purgeSubscribers) fn(leadId); };
  // The Bona inbox (2026-09-27 design §4): transcripts of inbox chats, the outbox every
  // send is written to before it goes, unread marks, and the gaps a thread owns up to.
  const inboxStore = options.inboxStore ?? createInboxStore(db, { now: clock, onPurge });
  // The ONE sender for messages from the owner's number to anyone else. Its per-minute
  // limits live in memory, so a second instance would be a second, independent budget;
  // the day's cap is counted from the outbox, so a restart no longer resets it.
  const sender = options.sender ?? createSender({ env: cfg.env ?? {}, team, inbox: inboxStore, db, fetchImpl, now: clock, log });
  // A send that was in flight when the last process died is not known to have failed:
  // it becomes "uncertain" — shown as such, never retried — rather than pending for ever.
  // Every pending row, however young: nothing has been sent from this process yet.
  const interrupted = sender.recoverInterrupted?.() ?? 0;
  if (interrupted) log({ level: 'warn', evt: 'wa.send.interrupted', count: interrupted });
  const sendCode = options.sendCode ?? ((o) => sender.sendTo({ ...o, kind: 'code' }));
  // The owner (BONA_OWNER_JID): a message typed on the instance's phone makes him the chat's
  // handler when it has none. Looked up on every call, so a change on the Team page is seen at once.
  const ownerDigits = bareJid(wa.ownerJid);
  // The instance's own number (digits, from BONA_WA_INSTANCE_JID; unset = the owner's, as
  // before the split): a sent record whose alt is this number names its sender, not the
  // chat — known even while the owner's account is deactivated or demoted.
  const selfDigits = bareJid(wa.instanceJid);
  // Not a phone jid (lib/wa.mjs PHONE_JID_RE): waConfig fell back to the owner's number; say it out loud.
  if (wa.ownNumberFrom === 'invalid') {
    // Never the value: only that it is not a phone jid.
    log({ level: 'error', evt: 'wa.instance_jid_invalid' });
  }
  const ownerUserId = () => {
    const owner = ownerDigits ? team.getUserByPhone(ownerDigits) : null;
    return owner && owner.active && owner.role === 'owner' ? owner.user_id : null;
  };
  // The inbox's one exclusion rule (lib/team.mjs), the same the upkeep and the routes use.
  const excludedLead = (lead) => isExcludedLead(team, db, lead);
  const handoffTelegram = createTelegramHandoffs({db,env:cfg.env??{},publicApi:cfg.publicApi,fetchImpl,isExcludedLead:excludedLead,log});
  const notifyHandoff = handoffTelegram.notifyLead;
  // Phone alerts (design §5, Phase 3). Keys from ~/.secrets/bona-services.env (generated once
  // by bin/vapid-keys.mjs); none, or a pair that does not match, means no alerts at all —
  // said once, loudly, never half-used. Neither key is ever logged: only whether the subject
  // passed, and /health's `push.configured`.
  const pushKeys = vapidKeys({ publicKey: cfg.vapidPublic, privateKey: cfg.vapidPrivate });
  // The subject is what a push service may write to about our pushes (RFC 8292): a mailto:
  // or https: URI, or Apple answers every push 403 without a word here.
  const pushSubject = VAPID_SUBJECT_RE.test(cfg.vapidSubject ?? '') ? cfg.vapidSubject : null;
  if ((cfg.vapidPublic || cfg.vapidPrivate) && !(pushKeys && pushSubject)) log({ level: 'error', evt: 'push.keys_invalid', keys: Boolean(pushKeys), subject: Boolean(pushSubject) });
  const alerts = options.alerts ?? createAlerts({
    db,
    pusher: pushKeys && pushSubject ? createPusher({ keys: pushKeys, subject: pushSubject, fetchImpl, now: clock }) : null,
    isExcludedLead: excludedLead, now: clock, log,
  });
  // The instance identity guard and the link probe (DESIGN §5.3, PR-L): identity fails closed until
  // the first probe; `startTimers` (the real server) starts its 10-minute loop.
  const waLink = options.waLink ?? createWaLink({ env: cfg.env ?? {}, alerts, fetchImpl, now: clock, log });
  // Built lazily below and read through these references, so each module can hold the others it needs.
  let notes = null;
  let viewing = null;
  let brain = null;
  let tools = null;
  let mail = null;
  // The owner's test switch, the per-lead auto mode and his `#dana …` commands (DESIGN §2, §3.2, PR-A2), with the
  // store, the inbox (the switch's lifecycle), the notes (his replies), the viewing module and the brain's health.
  ownerTest = options.ownerTest ?? createOwnerTest({
    cfg, team, wa, link: waLink, db, inbox: inboxStore, audit, notes: () => notes, viewing: () => viewing, brain: () => brain, log, now: clock,
  });
  // Viewing bookings (DESIGN §8, PR-B1) on the shared inventory; nothing is bookable until calendar_booking and a calendar.
  viewing = options.viewing ?? createViewing({ db, cfg, team, ownerTest, inventory, fetchImpl, log, now: clock });
  // Bona's AI assistant on the OpenAI API (DESIGN-brain §3, PR-BR): its tools run in-process (`runInProcess`, the five
  // WhatsApp tools answer nothing else), and its own alerts go to the owner notes unchanged; an outage for credit or
  // the key also pushes the owners' phones (reason `brain`). Without ~/.secrets/bona-brain.env it is not configured.
  // Only while the brain is in use (PR-INT r1, Codex P0-1): dana_brain '1', own_inbox '1', the owner's test, or an
  // own-number chat on a proven instance (auto mode, DESIGN §2). A key staged before any of them (a revoked one that
  // answers the models probe 401, say) is a journal line, never an owner note or a push.
  const brainInUse = () => {
    try {
      if (team.danaBrainEnabled?.() === true || team.ownInboxEnabled?.() === true || ownerTest.active?.() === true) return true;
      return ownerTest.ownNumberOk?.() === true
        && Boolean(db.db.prepare("SELECT 1 FROM leads WHERE inbox_state = 'in' AND inbox_via = 'own_number' LIMIT 1").get());
    } catch { return false; }
  };
  // The one outage alert (brain_out for quota or auth) the quiet sink held back (PR-INT r2): delivered, note and
  // push, once the brain enters use (a switch or the owner test on, seen on the notes tick or a setting change) while
  // the brain is still not answering; dropped once it answers again.
  let deferredBrainOut = null;
  const brainAlert = (code, meta) => {
    if (!brainInUse()) {
      log({ level: 'warn', evt: 'brain.alert_quiet', code: String(code).slice(0, 40), why: typeof meta?.code === 'string' ? meta.code.slice(0, 40) : null });
      if (code === 'brain_out' && (meta?.code === 'quota' || meta?.code === 'auth')) deferredBrainOut = { code, meta: { code: meta.code } };
      return;
    }
    deliverBrainAlert(code, meta);
  };
  const flushDeferredBrainAlert = () => {
    if (!deferredBrainOut) return;
    let out = false;
    try { out = brain?.health?.()?.ok !== true; } catch { out = false; }
    if (!out) { deferredBrainOut = null; return; }
    if (!brainInUse()) return;
    const { code, meta } = deferredBrainOut;
    deferredBrainOut = null;
    deliverBrainAlert(code, meta);
  };
  function deliverBrainAlert(code, meta) {
    try { notes?.alert?.(code, meta); } catch (err) { log({ level: 'error', evt: 'brain.alert_failed', code: String(code), name: loggableName(err) }); }
    if (code === 'brain_out' && (meta?.code === 'quota' || meta?.code === 'auth')) alerts.notifyOwners?.({ reason: 'brain' });
  }
  brain = options.brain ?? createBrain({
    cfg, runTool: (name, envelope) => tools.runInProcess(name, envelope), team, fetchImpl, now: clock, log, alert: brainAlert,
  });
  // The owner's notes (DESIGN §7, PR-B2): the ledger, paced and merged, sent through the one sender as kind 'note' (the
  // owner's jid only, its own `note:to:` limit, an outbox row without text or lead), held while Sending is off. A test
  // that hands createApp its own `sendWhatsApp` gets that as the transport instead (http.test.mjs's seam).
  const sendNote = options.sendWhatsApp ?? ((text) => sender.sendTo({ jid: wa.ownerJid, text, kind: 'note' }));
  notes = options.notes ?? createOwnerNotes({
    ledger: true, db, siteUrl: cfg.siteUrl, publicApi: cfg.publicApi, sendNote, team, ownerTest, inventory, brain, viewing, waLink,
    mail: { get configured() { return mail?.health?.()?.configured === true; }, health: () => mail?.health?.() ?? { configured: false } },
    log, now: clock,
  });
  // Each subscribes by its `onPurge(leadId)` (PR-B1: the lead's booked rows to cancel_pending;
  // PR-B2: the lead's owner_notes rows). A module without one has nothing to forget.
  purgeSubscribers.push((leadId) => viewing.onPurge?.(leadId), (leadId) => notes.onPurge?.(leadId));
  const given = options.ingest ?? createIngest({
    db, inbox: inboxStore, ownerUserId, ownerPhone: selfDigits || null, isExcludedLead: excludedLead, ownerTest, notes, log, now: clock,
  });
  // The backfill and the poller take the one-record function. A test may hand in either
  // shape, as createPoller allows; any other fails here, not on every record the poller reads.
  const ingestRecord = typeof given === 'function' ? given
    : (typeof given?.ingest === 'function' ? (lead, rec) => given.ingest(lead, rec) : null);
  if (!ingestRecord) throw new TypeError('options.ingest must be createIngest() or its ingest function');
  const ingest = typeof given === 'function' ? { ingest: given } : given;
  // Per-chat reads from Evolution: history when a chat joins, a refresh when a thread is
  // opened or answered. Read-only, like the poller; constructing it contacts nothing.
  const backfill = options.backfill ?? createBackfill({ env: cfg.env ?? {}, db, ingest: ingestRecord, inbox: inboxStore, fetchImpl, log, now: clock });
  // The Retell day budget (chats and calls), shared by the site's concierge and Dana.
  const budget = options.budget ?? createBudget({
    maxChats: cfg.maxChatsPerDay ?? 300,
    maxCalls: cfg.maxCallsPerDay ?? 60,
    log,
  });
  const maxTurns = cfg.maxTurnsPerSession ?? 40;
  // Dana on WhatsApp (design §6, Phase 4). Her own Retell chat agent (retell/provision.mjs
  // --whatsapp-only; never the site's), the one sender, the alerts for her hand-over, the
  // bounded per-chat re-read before she sends, and the Retell day budget. Without an agent id
  // she is not configured: nothing is sent, the Team page says so. She ships off (P4-3).
  // Never on the Retell mock unless a test opts in (`danaOnMock`): a mock's canned answer must
  // not reach a real client's WhatsApp. `danaBatchMs` is a test-only batch delay.
  const danaOnMock = Boolean(options.danaOnMock);
  if (!options.dana && cfg.retellMock && !danaOnMock) log({ level: 'warn', evt: 'dana.mock_off' });
  // Retell out of credit (2026-10-05 design R2): every Retell call Dana makes tells this watch
  // how it went; a 402 flags it in settings and pushes the owners, six hours apart at most.
  const funds = options.funds ?? createFundsWatch({ team, alerts, now: clock, log });
  // The concierge's tool handlers, built before Dana (PR-F2b) so the brain can run them
  // in-process through `runTool` (DESIGN-brain §3.4). Constructing them contacts nothing.
  tools = createToolHandlers({
    inventory, units, store, db, dataDir: cfg.dataDir, siteUrl: cfg.siteUrl, env: cfg.env, sendWhatsApp, notifyHandoff, ownerTest,
    viewing, notes, fetchImpl, log,
  });
  // Dana's human timing and caps (DESIGN §6.2-6.3, PR-B3). Stub: today's numbers.
  const pacing = options.pacing ?? createPacing({ cfg, now: clock });
  // What an answer becomes after preSend (DESIGN §8.3, PR-B4). Stub: one text bubble.
  const danaCommit = options.danaCommit ?? createDanaCommit({ viewing, notes, inventory, sender, log });
  // The Ops panel's 24-hour counts of what Dana did (DESIGN §5.4): answers, hand-overs and skips by
  // reason, read off her own journal lines (ids and codes only) as they pass, in memory, so a restart
  // starts them again. Her lines still go to the journal unchanged.
  const opsEvents = [];
  const OPS_EVENTS_MAX = 20_000;
  // The chats Dana refused as `identity` (the instance not proven yet): woken once it is (the `identity` tick).
  const identitySkipped = new Set();
  const danaLog = (e) => {
    try {
      if (e?.evt === 'dana.skipped' && e.reason === 'identity' && typeof e.leadId === 'string') identitySkipped.add(e.leadId);
      const kind = e?.evt === 'dana.answered' ? 'answered' : e?.evt === 'dana.skipped' ? 'skipped' : e?.evt === 'dana.handover' ? 'handover' : null;
      if (kind) {
        const why = kind === 'skipped' ? e.reason : kind === 'handover' ? e.why : null;
        opsEvents.push({ at: clock(), kind, why: typeof why === 'string' && /^[a-z_]{1,40}$/.test(why) ? why : 'other' });
        if (opsEvents.length > OPS_EVENTS_MAX) opsEvents.splice(0, opsEvents.length - OPS_EVENTS_MAX);
      }
    } catch { /* a count is never worth an answer */ }
    log(e);
  };
  // Dana on WhatsApp with every seam PR-B3 (lib/dana-wa.mjs) reads: the brain, the owner test, the
  // pacing, the commit, the notes, and the identity guard (`link` and `wa`, DESIGN §5.3).
  const dana = options.dana ?? createDana({
    db, inbox: inboxStore, team, sender, notifyHandoff, retell: cfg.retellMock && !danaOnMock ? null : retell, alerts, inventory, funds,
    siteUrl: cfg.siteUrl, agentId: cfg.waChatAgentId ?? null, isExcludedLead: excludedLead, backfill, budget, now: clock,
    brain, ownerTest, pacing, commit: danaCommit, notes, link: waLink, wa, log: danaLog,
    ...(Number.isFinite(options.danaBatchMs) ? { batchMs: options.danaBatchMs } : {}),
  });
  // What a stored client message sets off (PR-B2). Stub: today's hook — the phone alert, then
  // Dana's wake — moved out of the poller's wiring below unchanged.
  const pushPolicy = options.pushPolicy ?? createPushPolicy({ alerts, dana, ownerTest, log });
  // Bona's mailbox (DESIGN §9, PR-C2). Stub: not configured, nothing started.
  mail = options.mail ?? createMail({ cfg, db, brain, notes, log, now: clock });
  // The daily summary's minute step (DESIGN §7.3), queued through the notes; null when the notes cannot hold one.
  let dailySummary = null;
  try {
    dailySummary = createDailySummary({ db, team, notes, now: clock, log });
  } catch (err) {
    log({ level: 'warn', evt: 'notes.summary_unwired', name: loggableName(err) });
  }
  // The WhatsApp Ref-code poller. Read-only, and only when `BONA_WA_POLL` says so —
  // constructing it contacts nothing; the real server (below) is what puts it on a timer.
  // Handed the inbox, so every live client message of an `in` chat is stored as it is
  // read; without `ingest` it would run in Phase 1 mode and store nothing, silently.
  // A client message it stores goes to the push policy, which today raises the phone alert
  // (P3-9) and wakes Dana (P4-16): both fired, never awaited — `notify` never rejects, `wake`
  // only arms a timer — so a slow push service or a slow Retell never slows a tick.
  // `ownerTest`, `notes` and `link` are the seams PR-A1 (lib/wa-poller.mjs) reads; today's
  // poller ignores them.
  const poller = options.poller ?? (cfg.waPoll ? createPoller({
    db, cfg, sendWhatsApp, isExcluded: team.isExcludedPhone, log, now: clock, fetchImpl, inboxStore, ingest: ingestRecord, backfill,
    ownerTest, notes, link: waLink,
    onClientMessage: (leadId, ts) => pushPolicy.onClientMessage(leadId, ts),
    // A stranger's chat that has just entered the Unsure list: the owners' phones say
    // "new chat to check" (2026-10-04 design, U1/U2).
    onUnsureLead: (leadId, ts) => { alerts.notify(leadId, { reason: 'check', ts }); },
  }) : null);

  const perMin = 60_000;
  const limiters = {
    chat: createLimiter({ capacity: cfg.chatRatePerMin, perMs: perMin }),
    token: createLimiter({ capacity: cfg.tokenRatePerMin, perMs: perMin }),
    misc: createLimiter({ capacity: 120, perMs: perMin }),
    // First-party events are cheap and frequent (every page view, every click), so the
    // bucket is wide; the enquiry form creates a lead and messages the owner, so it is not.
    events: createLimiter({ capacity: cfg.eventsRatePerMin ?? 240, perMs: perMin }),
    enquiry: createLimiter({ capacity: cfg.enquiryRatePerMin ?? 6, perMs: perMin }),
    // Retell is allowed to call tools as often as a conversation needs; the tight
    // bucket only counts failed authentications, so guessing the token is pointless.
    tool: createLimiter({ capacity: cfg.toolRatePerMin ?? 600, perMs: perMin }),
    toolAuth: createLimiter({ capacity: cfg.toolAuthFailRatePerMin ?? 10, perMs: perMin }),
  };

  const startedAt = Date.now();

  // Built before the routes so the dashboard can read what the process is running —
  // notably `app.poller`, which another branch attaches — through one live reference
  // rather than a second wiring step. `server` and `handle` are added at the end.
  const app = {
    cfg, inventory, store, db, retell, tools, limiters, fanout, budget, team, audit, sender,
    inboxStore, ingest, backfill, alerts, dana, funds, handoffTelegram,
    ownerTest, notes, viewing, waLink, pacing, pushPolicy, danaCommit, mail, brain,
    poller: options.poller ?? null,
  };

  /**
   * The inbox's upkeep (P2-18, P2-20, amendment A3), run once at start-up and then daily
   * by the real server below. In order: a chat whose number is a colleague's or on the
   * never list leaves the inbox and its transcript goes (§3.5 — migration v4 sorted leads
   * by how they matched, and a number can join the team or the never list after its chat
   * joined); transcripts of chats silent for five years go (the lead rows stay — they are
   * the attribution record); login-code outbox rows, and the send stubs a purged chat
   * leaves, go once they are two days old (they only ever counted the day's sends); a
   * send left pending by a process that died becomes uncertain; the owner's list of
   * real-estate chats to check (D17) drops an open one 30 days after its last property
   * message and a dismissed one a year after he dismissed it; a phone's push subscription
   * whose login session is gone goes (P3-5: an expired session ends that device's alerts,
   * and the next signed-in page load re-posts it); then every `in` chat with
   * nothing stored yet gets the history an automatic join takes — never reaching past the
   * retention horizon, or the purge would be undone the same morning (at most 200 chats a
   * run: see `inChatsWithoutMessages` for the limit). Counts only in the log: never a
   * number, a name, a word of a message or an error's message. One run at a time, and it
   * never rejects: upkeep that fails is a line in the log, not a crashed server. Each step
   * runs on its own: one that throws is one `inbox.maintenance_failed` line naming it, its
   * count reads null (not known), and the steps after it still run; a logger that throws
   * costs nothing at all.
   *
   * A catch-up read that fails leaves the thread a gap, like the poller's join does (design
   * §4.3, "no silent loss"): see `catchupGap`. A later read of the same chat that comes back
   * whole takes it back.
   *
   * The sweep sees only what a row holds. A lid-only chat whose number another lead holds
   * (ingest's `held_by_other_lead`) never learns that number, so it stays in: its records
   * that name the excluded number are refused, those with no alt are still stored, until
   * the owner moves it out. Accepted (rare: 0 of 27 live leads are lid-only).
   */
  let upkeepRunning = false;
  app.inboxMaintenance = async function inboxMaintenance() {
    if (upkeepRunning) return { skipped: 'running' };
    upkeepRunning = true;
    const failed = (step, err) => upkeepLog({ level: 'error', evt: 'inbox.maintenance_failed', step, name: loggableName(err), code: loggableCode(err) });
    /** One local step on its own. */
    const step = (name, fn) => {
      try {
        return fn();
      } catch (err) {
        failed(name, err);
        return null;
      }
    };
    try {
      const t = clock();
      // First, so the catch-up below never fetches a private chat's history. The catch-up
      // checks each chat again right before its read, so a sweep that failed opens nothing up.
      const excludedOut = step('sweep', () => {
        let out = 0;
        for (const lead of inboxStore.listedLeads()) {
          if (!excludedLead(lead)) continue;
          inboxStore.leaveInbox(lead.lead_id);
          out += 1;
        }
        if (out) upkeepLog({ level: 'warn', evt: 'inbox.excluded_out', count: out });
        return out;
      });
      const retention = step('retention', () => inboxStore.retentionPurge(t - RETENTION_MS));
      // The owner's list of real-estate chats to check (D17): an open one 30 days after its
      // last property message, a dismissed one a year after he dismissed it.
      const candidates = step('candidates', () => inboxStore.pruneCandidates({ openBefore: t - CANDIDATE_KEEP_MS, dismissedBefore: t - DISMISSED_KEEP_MS }));
      // The pre-update database copies past 29 days (PLAN T14, "Added 27 Nov"); its own line, counts only.
      step('backups', () => pruneBackups(t));
      const counts = {
        excludedOut,
        purgedChats: retention?.leads ?? null,
        purgedMessages: retention?.messages ?? null,
        // Staff and Dana sends it deleted: a purged chat's, and old ones of chats with no message.
        purgedSends: retention?.outbox ?? null,
        codeRows: step('code_rows', () => inboxStore.pruneCodeRows(t - CODE_ROW_TTL_MS)),
        interrupted: step('interrupted', () => inboxStore.markStalePending(t - INTERRUPTED_SEND_MS)),
        candidatesExpired: candidates?.open ?? null,
        dismissalsExpired: candidates?.dismissed ?? null,
        // Phone alerts (P3-5): devices whose login session is gone (expired, or deleted by a
        // path that did not forget them). The README names this count.
        pushOrphans: step('push_orphans', () => alerts.pruneOrphans()),
        caughtUp: 0,
        caughtUpStored: 0,
        caughtUpFailed: 0,
      };
      if (backfill.configured) {
        try {
          for (const lead of inboxStore.inChatsWithoutMessages()) {
            // A number that joined the team while an earlier fetch was running is not fetched.
            if (excludedLead(lead)) continue;
            const joinedAt = lead.inbox_since ?? lead.created ?? t;
            // From the chat's own history floor (30 days back for an owner join), else the
            // 24 h an automatic join keeps.
            const floor = Number.isFinite(lead.history_from) ? lead.history_from : joinedAt - JOIN_HISTORY_MS;
            const sinceTs = Math.max(floor, t - RETENTION_MS);
            const got = await backfill.history(lead, { sinceTs, untilTs: t });
            // Keyed like the poller's join gap (wa-poller.mjs `join`), so one join never shows two.
            const gapKey = `join:${lead.lead_id}:${joinedAt}`;
            if (got?.error) {
              counts.caughtUpFailed += 1;
              catchupGap(lead.lead_id, gapKey, sinceTs);
            } else if (got && !got.skipped) {
              // (A chat that left the inbox meanwhile comes back `skipped`: nothing was read for it.)
              counts.caughtUp += 1;
              counts.caughtUpStored += Number(got.stored) || 0;
              // The whole window came back, so an earlier run's gap was never true. A read cut
              // at its page cap (`truncated`) proves nothing and leaves it.
              if (!got.truncated) inboxStore.clearGap(gapKey);
            }
          }
          upkeepLog({ evt: 'inbox.catchup', chats: counts.caughtUp, stored: counts.caughtUpStored, failed: counts.caughtUpFailed });
        } catch (err) {
          // A read that broke its promise never to throw ends the catch-up, not the run.
          failed('catchup', err);
        }
      }
      upkeepLog({ evt: 'inbox.maintenance', ...counts });
      return counts;
    } catch (err) {
      // Outside every step (the clock): the run fails, and the promise the server fires and
      // forgets still resolves.
      failed('run', err);
      return { error: 'failed' };
    } finally {
      upkeepRunning = false;
    }
  };

  /**
   * The daily backup prune (PLAN T14, "Added 27 Nov"; the D1 retention text promises 30 days): in
   * release-backups/ beside the database, every `bona-<label>-<UTC stamp>.db` whose stamp is more than 29 days
   * before the clock, and every `.bona-*.partial` a killed snapshot run left whose file time is over a day old.
   * Never anything else (another name, a sub-folder), and nothing at all without the folder (pruneReleaseBackups).
   * Logged as counts only.
   */
  function pruneBackups(t) {
    const dbFile = cfg.dbFile ?? (cfg.dataDir ? path.join(cfg.dataDir, 'bona.db') : null);
    if (!dbFile || dbFile === ':memory:') return null;
    const outDir = path.join(path.dirname(dbFile), 'release-backups');
    let isDir = false;
    try { isDir = fs.lstatSync(outDir).isDirectory(); } catch { isDir = false; }
    if (!isDir) return null;
    const r = pruneReleaseBackups(outDir, t);
    upkeepLog({ evt: 'backups.pruned', ...r });
    return r;
  }

  /** The upkeep's logger: one that throws costs no step, and never turns a finished run into a failed one. */
  function upkeepLog(entry) {
    try { log(entry); } catch { /* the upkeep goes on */ }
  }

  /**
   * The gap a failed catch-up read leaves at the start of the window it asked for, so the
   * thread says "a message could not be loaded — check WhatsApp" where the history belongs.
   * Written when part of the window was stored (the chat has a message now, so no run asks
   * for it again, and this is the only trace of what is missing), and when nothing was (a
   * client may write before the next run, and then the chat is never asked again either).
   * Only to a chat still `in`: `leaveInbox` purged its gaps, and one written now would
   * outlive that; the check and the insert run with no `await` between them. A gap that
   * cannot be written is logged (`inbox.gap_failed`), never thrown, as in the poller's join.
   */
  function catchupGap(leadId, key, ts) {
    try {
      if (db.getLead(leadId)?.inbox_state === 'in') inboxStore.addGap({ key_id: key, lead_id: leadId, ts, reason: 'history_failed' });
    } catch {
      upkeepLog({ level: 'warn', evt: 'inbox.gap_failed', leadId, reason: 'history_failed' });
    }
  }

  // The owner's dashboard. It owns its own auth (a WhatsApp one-time code), its own
  // security headers and its own limiter; nothing about it is CORS-enabled.
  // `ownerTest`, `onSettingChanged` and `hooks` are the seams PR-F2a / PR-A3 read in
  // lib/dashboard/routes.mjs: a Team-page switch that changed tells the test switch, a task set
  // to cancelled and a lead leaving tell the viewing bookings. Unread until then.
  const dashboard = options.dashboard ?? createDashboardRoutes({
    db, cfg, inventory, fanout, app, log, sendWhatsApp, probeRetell, team, audit, sendCode,
    inbox: inboxStore, sender, backfill, alerts, ownerTest,
    onSettingChanged: (key, value) => { ownerTest.onSettingChanged?.(key, value); flushDeferredBrainAlert(); },
    hooks: {
      onTaskChange: (task, patch) => viewing.onTaskChange?.(task, patch),
      onLeadLeaving: (leadId) => viewing.onLeadLeaving?.(leadId),
    },
    ops: () => opsCounts(),
  });

  /**
   * The Team page's Ops panel (DESIGN §5.4), owner only (routes.mjs draws it on the Team page): counts and
   * codes, never a name, a number or a word of a message. Dana's answers, hand-overs and skips by reason over
   * 24 h (her journal, `danaLog`), her latency ring, the sends that failed or went unsure (a non-null `error` on
   * any other row is lib/dana-wa.mjs's mark, `outage_line`, `cov:<rowid>` or `<mark>|<reason>`, read with
   * wa-send's splitMark: never a failure), the notes, the bookings, the month's turns, the chats an AI outage
   * holds, and the brain's own rows (brain.ops()). A part that cannot be read is left out.
   */
  function opsCounts() {
    const t = clock();
    const since = t - DAY_MS;
    while (opsEvents.length && opsEvents[0].at < since) opsEvents.shift();
    // Through a Map: a reason is data, never a key that could reach Object.prototype.
    const tally = (list) => Object.fromEntries(list.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map()));
    const out = {};
    const part = (fn) => { try { fn(); } catch { /* left out */ } };
    const seconds = (ms) => (typeof ms === 'number' && Number.isFinite(ms) ? `${Math.round(ms / 1000)} s` : '—');
    part(() => {
      const l = dana.latency?.() ?? {};
      out['Latency p50 / p90 (24 h)'] = Number(l.n) > 0 ? `${seconds(l.p50)} / ${seconds(l.p90)}` : 'no answers yet';
    });
    const events = opsEvents.filter((e) => e.at >= since);
    out['Answers (24 h)'] = events.filter((e) => e.kind === 'answered').length;
    out['Hand-overs (24 h)'] = tally(events.filter((e) => e.kind === 'handover').map((e) => e.why));
    out['Skips (24 h)'] = tally(events.filter((e) => e.kind === 'skipped').map((e) => e.why));
    part(() => {
      const rows = db.db.prepare("SELECT status, error FROM wa_outbox WHERE created >= ? AND status IN ('failed', 'uncertain')").all(since);
      const reason = (r) => {
        const why = r.status === 'failed' ? r.error : splitMark(r.error).reason;
        return typeof why === 'string' && /^[\w.-]{1,40}$/.test(why) ? why : 'unknown';
      };
      out['Send failures (24 h)'] = tally(rows.filter((r) => r.status === 'failed').map(reason));
      out['Sends unsure (24 h)'] = tally(rows.filter((r) => r.status === 'uncertain').map(reason));
    });
    part(() => {
      out['Owner notes (24 h)'] = Object.fromEntries(db.db.prepare('SELECT status, COUNT(*) AS n FROM owner_notes WHERE created >= ? GROUP BY status ORDER BY status').all(since).map((r) => [r.status, r.n]));
    });
    part(() => {
      out['Viewings booked (upcoming)'] = db.db.prepare("SELECT COUNT(*) AS n FROM viewing_bookings WHERE status = 'booked' AND start_ts >= ?").get(t).n;
    });
    part(() => {
      const d = new Date(t + TZ_OFFSET_MS);
      const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - TZ_OFFSET_MS;
      out['Assistant turns this month'] = inboxStore.countDanaTurns({ sinceTs: monthStart });
    });
    part(() => {
      out['Lid-only chats to check'] = db.db.prepare("SELECT COUNT(*) AS n FROM inbox_candidates WHERE state = 'open' AND phone_e164 IS NULL AND lid IS NOT NULL").get().n;
    });
    part(() => {
      out['Chats held by an AI outage'] = db.db.prepare("SELECT COUNT(*) AS n FROM leads WHERE inbox_state = 'in' AND dana_hold_reason = 'brain_out'").get().n;
    });
    part(() => {
      const o = brain.ops?.() ?? {};
      if (!o || typeof o !== 'object' || !Object.keys(o).length) return;
      const money = (v) => (typeof v === 'number' && Number.isFinite(v) ? `$${v.toFixed(2)}` : '—');
      out['AI turns by model (24 h)'] = o.turnsByModel ?? {};
      out['AI backup turns (24 h)'] = o.backupTurns ?? 0;
      out['AI errors by code (24 h)'] = o.errors ?? {};
      out['AI guard repairs / hand-overs (24 h)'] = `${o.guardRepairs ?? 0} / ${o.guardHandovers ?? 0}`;
      out['AI cached-token ratio'] = typeof o.cachedRatio === 'number' && Number.isFinite(o.cachedRatio) ? `${Math.round(o.cachedRatio * 100)}%` : '—';
      out['AI $ today / month'] = `${money(o.usdToday)} / ${money(o.usdMonth)}`;
      out['AI state'] = o.out ? 'out (not answering)' : o.breaker ? 'breaker open' : o.cooldown ? 'main model cooling down' : 'ok';
    });
    return out;
  }
  app.ops = opsCounts;

  /*
   * The timers (PLAN T14). Each tick is its own: one at a time, it never rejects, and one that throws is a
   * `timer.failed` line naming the timer and the kind of failure, never its message. INERT with the switches
   * off: the notes have nothing queued, the summary is off, the sweep finds no hold, the viewing worker and the
   * reconcile have no calendar (or nothing booked), the probe is $0 and only with a key, the link probe only reads.
   */
  let reconciled = { day: null, summary: null };
  async function summaryMinute() {
    const t = clock();
    const today = dayKey(t, TZ_OFFSET_MS);
    const hour = new Date(t + TZ_OFFSET_MS).getUTCHours();
    // The calendar's daily reconcile (DESIGN §8.4): from 05:00, and again before the summary builds.
    let summaryDue = false;
    try {
      summaryDue = Boolean(dailySummary) && hour >= SUMMARY_HOUR && hour < CATCH_UP_BEFORE_HOUR
        && String(team.getSetting('owner_summary_day') ?? '') !== today && summaryOn(team);
    } catch { summaryDue = false; }
    const at05 = hour >= RECONCILE_HOUR && reconciled.day !== today;
    const beforeSummary = summaryDue && reconciled.summary !== today;
    if (viewing.configured === true && (at05 || beforeSummary)) {
      reconciled = { day: today, summary: beforeSummary ? today : reconciled.summary };
      await viewing.reconcile?.();
    }
    return dailySummary?.minute();
  }
  const ticking = new Set();
  const tick = (name, fn) => async () => {
    if (ticking.has(name)) return undefined;
    ticking.add(name);
    try {
      return await fn();
    } catch (err) {
      try { log({ level: 'error', evt: 'timer.failed', timer: name, name: loggableName(err), code: loggableCode(err) }); } catch { /* the timer goes on */ }
      return undefined;
    } finally {
      ticking.delete(name);
    }
  };
  /**
   * The identity watch (PR-INT r1; DESIGN §5.3 stays: no send before the instance is proven). Until it has been
   * proven once, one link probe a tick (30 s), not the probe's 10 minutes. Whenever it is proven, each chat Dana
   * refused as `identity` meanwhile is woken for its newest client message; Dana's own rules (freshness included)
   * decide from there, as on main. Nothing at all on a shared number, which the guard never reads.
   */
  let identityProven = false;
  async function identityWatch() {
    if (wa.ownNumberFrom !== 'instance') return { woken: 0 };
    // The identity half alone (wa-link probeIdentity): no link probe, no Kuma beat, no failure count from this tick.
    if (!identityProven) await (waLink.probeIdentity ? waLink.probeIdentity() : waLink.probe?.());
    if (waLink.identityOk?.() !== true) return { woken: 0 };
    identityProven = true;
    let woken = 0;
    for (const leadId of [...identitySkipped]) {
      identitySkipped.delete(leadId);
      const ts = db.db.prepare("SELECT MAX(ts) AS ts FROM wa_messages WHERE lead_id = ? AND direction = 'in'").get(leadId)?.ts;
      if (Number.isFinite(ts)) { dana.wake(leadId, ts); woken += 1; }
    }
    return { woken };
  }
  app.ticks = {
    identity: tick('identity', identityWatch),
    notes: tick('notes', () => { flushDeferredBrainAlert(); return notes.tick?.(); }),
    summary: tick('summary', summaryMinute),
    sweep: tick('sweep', () => dana.sweep?.()),
    viewing: tick('viewing', () => viewing.tick?.()),
    brainProbe: tick('brainProbe', async () => {
      const out = brain.configured === true ? await brain.probe?.() : undefined;
      flushDeferredBrainAlert();
      return out;
    }),
    upkeep: () => app.inboxMaintenance(),
  };
  let running = null;
  /**
   * Put every worker on its clock (TIMERS) and start the link probe. The real server calls it once; a second call
   * starts nothing. `every(ms, fn)` / `clear(handle)` default to unref'd intervals (a test passes its own).
   * @returns {{ name: string, ms: number }[]}
   */
  app.startTimers = function startTimers({ every = null, clear = null } = {}) {
    if (running) return [];
    const on = every ?? ((ms, fn) => { const h = setInterval(() => { fn(); }, ms); h.unref?.(); return h; });
    running = { clear: clear ?? ((h) => clearInterval(h)), handles: TIMERS.map(([name, ms]) => on(ms, app.ticks[name])) };
    try { waLink.start?.(); } catch (err) { log({ level: 'error', evt: 'timer.failed', timer: 'link', name: loggableName(err) }); }
    return TIMERS.map(([name, ms]) => ({ name, ms }));
  };
  /**
   * The real server's start (isMain): the timers and the link probe, whose first round starts at once; the poller only
   * once that first round has answered (bounded by `firstProbeMs`), so no client message is read while the identity
   * guard is still pending. DESIGN §5.3 / T09-T12's rule stands as it is: identityOk is false until a round proves the
   * instance, so a first round that errors, or no Evolution to ask, leaves Dana's own-number chats unanswered until a
   * later round proves it (every 10 min). A shared-number setup (no BONA_WA_INSTANCE_JID) never reads the guard.
   * @returns {Promise<{ timers: { name: string, ms: number }[], pollStarted: boolean|null }>}
   */
  app.start = async function start({ every = null, clear = null, firstProbeMs = 15_000 } = {}) {
    const timers = app.startTimers({ every, clear });
    let timer = null;
    try {
      await Promise.race([
        Promise.resolve().then(() => waLink.probe?.()).catch(() => {}),
        new Promise((resolve) => { timer = setTimeout(resolve, firstProbeMs); timer.unref?.(); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (waLink.identityOk?.() === true) identityProven = true;
    // A shutdown meanwhile (SIGTERM inside the first ≤ 15 s) stopped the timers: the poller is not started after it.
    if (!running) return { timers, pollStarted: null };
    // The brain's $0 models probe, after the identity round (PR-INT r2): its alert sink then reads the instance as proven.
    app.ticks.brainProbe();
    const pollStarted = poller ? poller.start({ intervalMs: cfg.waPollMs }) : null;
    return { timers, pollStarted };
  };

  /** Every timer off, the link probe stopped, and the notes' own wake-up timer too (shutdown, tests). */
  app.stopTimers = function stopTimers() {
    if (running) {
      for (const h of running.handles) { try { running.clear(h); } catch { /* gone anyway */ } }
      running = null;
    }
    try { waLink.stop?.(); } catch { /* stopping */ }
  };

  function dynamicVariables({ locale, page, sessionId }) {
    return {
      locale,
      page_url: page?.url ? String(page.url).slice(0, 300) : `${cfg.siteUrl}/`,
      page_title: (page?.title ? asPageTitle(page.title) : '') || (locale === 'ar' ? 'بونا' : 'Bona'),
      ...(sessionId ? { session_id: sessionId } : {}),
    };
  }

  /**
   * What the server itself knows about a request, stored beside every event and
   * session: the client IP (`clientIp` rules), the user agent, and the country
   * Cloudflare stamps on the request — trusted only from the tunnel, like the IP.
   */
  function serverContext(req, ip) {
    const ua = String(req.headers['user-agent'] ?? '').slice(0, 300) || null;
    const cfCountry = trustedPeer(req, { trustedProxies: cfg.trustedProxies }) ? String(req.headers['cf-ipcountry'] ?? '') : '';
    const country = /^[A-Za-z]{2}$/.test(cfCountry) ? cfCountry.toUpperCase() : null;
    return { ip, ua, country, received: Date.now() };
  }

  /**
   * Retell `metadata` for a chat or call: the page and locale as before, plus the
   * visitor's attribution ids from the widget's optional `attr`. Retell hands the
   * object back on every tool call, which is how `create_lead` learns which session —
   * and so which campaign — the conversation belongs to. Malformed ids are simply
   * absent; a bad `attr` is never a reason to refuse a conversation.
   */
  function retellMetadata({ locale, page, attr }) {
    return { locale, page: page?.url ?? null, source: 'bona-web', ...cleanAttrIds(attr) };
  }

  /**
   * The server-side record that a concierge conversation opened, tied to the
   * visitor's session when the widget said which one. Best effort: a store failure
   * is logged and the conversation goes ahead.
   */
  function recordConciergeStart(name, { attr, page, locale, conversationId, server }) {
    try {
      const session = attr.session_id ? db.getSession(attr.session_id) : null;
      db.insertEvent({
        event_id: newId('ev'), ts: server?.received ?? Date.now(), name,
        anon_id: attr.anon_id ?? session?.anon_id ?? null, session_id: attr.session_id, lead_id: null, listing_id: attr.listing_id,
        path: page?.url ?? null, props: { conversation_id: conversationId, locale, ref: attr.ref, _consent_analytics: session?.consent_analytics === 1, _consent_ads: session?.consent_ads === 1 },
        src_first: session?.first_touch ?? null, src_last: session?.last_touch ?? null,
        ip: server?.ip ?? null, ua: server?.ua ?? null, country: server?.country ?? null,
      });
    } catch (err) {
      log({ level: 'error', evt: 'event.write_failed', name, error: String(err?.message ?? err) });
    }
  }

  /* -------------------- route handlers -------------------- */

  async function health() {
    const retellStatus = await probeRetell();
    // An empty portfolio is not a healthy concierge: Dana would answer every question
    // with "nothing matches". Say so out loud rather than serving it quietly.
    const inventoryOk = inventory.ok ? inventory.ok() : inventory.count() > 0;
    let dbStatus = 'error';
    try { dbStatus = db.ping() ? 'ok' : 'error'; } catch { dbStatus = 'error'; }
    const fanoutCounts = () => { try { return db.fanoutCounts(); } catch { return { pending: 0, sent: 0, failed: 0, skipped: 0 }; } };
    // Each seam module's own health (DESIGN §5.4), read so that /health only ever carries
    // booleans and fixed enums: a module that throws, or answers anything else, reads as
    // false / null rather than taking the report down or leaking its text. health() is
    // synchronous: a promise is no answer (it reads as {}), and one that rejects is caught here
    // rather than left to take the process down as an unhandled rejection.
    const read = (fn) => {
      try {
        const got = fn();
        if (got && typeof got.then === 'function') { Promise.resolve(got).catch(() => {}); return {}; }
        return got ?? {};
      } catch { return {}; }
    };
    const yes = (v) => v === true;
    const code = (v) => (HEALTH_ERROR_CODES.has(v) ? v : null);
    const owner = read(() => ownerTest.health());
    const danaHealth = read(() => dana.health?.());
    const latency = read(() => dana.latency?.());
    const answers = Number.isInteger(latency.n) ? latency.n : 0;
    const link = read(() => waLink.health());
    const brainHealth = read(() => brain.health());
    const booking = read(() => viewing.health());
    const noteHealth = read(() => notes.health());
    const mailHealth = read(() => mail.health());
    return {
      ok: inventoryOk,
      service: 'bona-api',
      version: cfg.version,
      uptimeS: Math.round((Date.now() - startedAt) / 1000),
      retell: retellStatus === 'ok' ? 'ok' : 'error',
      db: dbStatus,
      // What the ad platforms have and have not been told. `pending` that never falls is
      // the symptom of a fan-out that is queued but not draining.
      fanout: { ...fanoutCounts(), dests: fanout.dests(), running: fanout.started },
      // How far behind WhatsApp the poller is. Deliberately not part of `ok`: an Evolution
      // outage must not take the concierge down with it — it is a gap in attribution, not
      // a site that stopped answering.
      ...(poller ? { poller: poller.status() } : {}),
      // Phone alerts: only whether VAPID keys are loaded (P3-14) — never a key, a count of
      // devices, or anything a push carries.
      push: { configured: alerts.configured },
      leadReadiness: {...taskCounts(db),telegramConfigured:handoffTelegram.configured,telegramEnabled:handoffTelegram.enabled},
      // The Bona inbox's rule (DESIGN §3, §5.3): the own-number rule or the shared one, the
      // owner's test switch, and whether the instance's identity checked out.
      inbox: { rule: owner.rule === 'own' ? 'own' : 'shared', ownerAsClient: yes(owner.ownerAsClient), identityOk: yes(link.identityOk) },
      wa: { linkOk: yes(link.linkOk) },
      // Dana on WhatsApp (P4-17): whether her agent id is set, and the global switch — never a
      // chat, a count of answers, or anything she said.
      // `fundsOut`: Retell is refusing her for lack of credit (R2) — a yes or no, never when.
      // `brainOk` / `brainBackup` (DESIGN-brain §10) are NOT part of `ok`: an AI outage never
      // marks bona-api down, and neither does the breaker or a slow p90. `latencyOk` = p90 ≤ 60 s
      // over her answers' ring once it holds 5, else null (not known).
      dana: {
        configured: dana.configured === true, enabled: team.danaEnabled(), brainOk: yes(brainHealth.ok), brainBackup: yes(brainHealth.backup),
        fundsOut: fundsOutSince(team) !== null, breaker: yes(danaHealth.breaker),
        latencyOk: answers >= LATENCY_MIN_ANSWERS && typeof latency.p90 === 'number' && Number.isFinite(latency.p90) ? latency.p90 <= LATENCY_OK_MS : null,
      },
      booking: {
        enabled: yes(booking.enabled),
        gcal: { configured: yes(booking.gcal?.configured), ok: yes(booking.gcal?.ok), lastErrorCode: code(booking.gcal?.lastErrorCode) },
      },
      notes: { enabled: yes(noteHealth.enabled), ok: yes(noteHealth.ok) },
      mail: { configured: yes(mailHealth.configured), ok: yes(mailHealth.ok), lastErrorCode: code(mailHealth.lastErrorCode), replies: yes(mailHealth.replies) },
      inventory: inventory.count(),
      budget: budget.counters(),
      mock: cfg.retellMock || undefined,
    };
  }

  async function chatSession(body, server = {}) {
    const locale = asLocale(body.locale);
    const page = body.page && typeof body.page === 'object' ? body.page : null;
    if (!cfg.chatAgentId) {
      const err = new Error('chat agent not provisioned — run services/api/retell/provision.mjs');
      err.code = 'NOT_PROVISIONED';
      throw err;
    }
    const metadata = retellMetadata({ locale, page, attr: body.attr });
    const session = store.createSession({ chatId: null, locale, page });
    const chat = await retell.createChat({
      agent_id: cfg.chatAgentId,
      retell_llm_dynamic_variables: dynamicVariables({ locale, page, sessionId: session.sessionId }),
      metadata,
    });
    session.chatId = chat.chat_id;
    store.link(chat.chat_id, session.sessionId);
    const greeting = asText(chat.begin_message ?? chat.greeting ?? GREETING[locale], 500) || GREETING[locale];
    session.greeting = greeting;
    log({ evt: 'chat.session', sessionId: session.sessionId, locale, visitorSession: metadata.session_id });
    recordConciergeStart('concierge_chat_start', { attr: metadata, page, locale, conversationId: chat.chat_id, server });
    return { sessionId: session.sessionId, greeting };
  }

  async function chatMessage(body) {
    const session = store.getSession(String(body.sessionId ?? ''));
    if (!session) {
      const err = new Error('unknown or expired session');
      err.code = 'NO_SESSION';
      throw err;
    }
    const text = asText(body.text);
    if (!text) {
      const err = new Error('text is required');
      err.code = 'BAD_BODY';
      throw err;
    }
    if (session.turns >= maxTurns) {
      if (!session.limitLogged) {
        session.limitLogged = true;
        log({ level: 'warn', evt: 'session.limit', sessionId: session.sessionId, turns: session.turns, max: maxTurns });
      }
      const err = new Error('this conversation has reached its length limit');
      err.code = 'SESSION_LIMIT';
      throw err;
    }
    if (body.locale) session.locale = asLocale(body.locale);
    if (body.page && typeof body.page === 'object') session.page = body.page;
    session.turns += 1;

    const completion = await retell.createChatCompletion({ chat_id: session.chatId, content: text });
    const result = extractActions(completion?.messages ?? [], { inventory, siteUrl: cfg.siteUrl });
    for (const action of result.actions) {
      if (action.type === 'show_listing') store.addCard(session.sessionId, action.listing);
    }
    if (!result.messages.length) {
      result.messages.push({
        role: 'agent',
        text: session.locale === 'ar'
          ? 'عذراً، ما وصلتني إجابة. ممكن تعيد صياغة سؤالك؟'
          : "Sorry — I didn't catch that. Could you put it another way?",
      });
    }
    if (result.leadCaptured) session.leadCaptured = true;
    log({ evt: 'chat.message', sessionId: session.sessionId, turns: session.turns, actions: result.actions.length });
    return result;
  }

  async function chatEnd(body) {
    const sessionId = String(body.sessionId ?? '');
    const session = store.getSession(sessionId);
    if (session?.chatId) {
      try { await retell.endChat(session.chatId); } catch (err) { log({ level: 'warn', evt: 'chat.end_failed', error: String(err?.message ?? err) }); }
      try {
        appendJsonl(cfg.dataDir, 'chats.jsonl', {
          ts: new Date().toISOString(), sessionId, chatId: session.chatId,
          locale: session.locale, turns: session.turns, leadCaptured: session.leadCaptured,
          page: session.page?.url ?? null,
        });
      } catch { /* non-fatal */ }
    }
    store.endSession(sessionId);
    return { ok: true };
  }

  async function callToken(body, server = {}) {
    const locale = asLocale(body.locale);
    const page = body.page && typeof body.page === 'object' ? body.page : null;
    if (!cfg.voiceAgentId) {
      const err = new Error('voice agent not provisioned — run services/api/retell/provision.mjs');
      err.code = 'NOT_PROVISIONED';
      throw err;
    }
    const metadata = retellMetadata({ locale, page, attr: body.attr });
    const call = await retell.createWebCall({
      agent_id: cfg.voiceAgentId,
      retell_llm_dynamic_variables: dynamicVariables({ locale, page }),
      metadata,
    });
    store.createCall({ callId: call.call_id, locale, page });
    log({ evt: 'call.token', callId: call.call_id, locale, visitorSession: metadata.session_id });
    recordConciergeStart('concierge_call_start', { attr: metadata, page, locale, conversationId: call.call_id, server });
    return { accessToken: call.access_token, callId: call.call_id, ...webCallConnection(call) };
  }

  /** The v3 connection details the browser SDK's startCall() takes, passed through only when well-formed. */
  function webCallConnection(call) {
    const out = {};
    if (call.transport === 'livekit' || call.transport === 'gateway') out.transport = call.transport;
    if (typeof call.url === 'string' && /^(wss|https):\/\//.test(call.url)) out.url = call.url;
    const ice = Array.isArray(call.ice_servers) ? call.ice_servers.map(iceServer).filter(Boolean) : [];
    if (ice.length) out.iceServers = ice;   // none usable -> omitted, and the SDK keeps its default STUN
    return out;
  }

  /** One RTCIceServer, or null: stun:/turn:/turns: urls with a host (string or list); TURN needs string credentials. */
  function iceServer(s) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    const okUrl = (u) => typeof u === 'string' && u.length <= 512 && /^(stun|turns?):[A-Za-z0-9.\-[\]:]*[A-Za-z0-9\]](:\d{1,5})?(\?transport=(udp|tcp))?$/.test(u);
    let urls;
    if (typeof s.urls === 'string') urls = okUrl(s.urls) ? s.urls : null;
    else if (Array.isArray(s.urls)) { const list = s.urls.filter(okUrl); urls = list.length ? list : null; }
    if (!urls) return null;
    const out = { urls };
    for (const k of ['username', 'credential']) {
      if (s[k] === undefined) continue;
      if (typeof s[k] !== 'string') return null;
      out[k] = s[k];
    }
    // RTCPeerConnection rejects a turn:/turns: entry without both credentials (InvalidAccessError) — the whole call would fail.
    const turn = [].concat(urls).some(u => /^turns?:/.test(u));
    if (turn && (typeof out.username !== 'string' || typeof out.credential !== 'string')) return null;
    return out;
  }

  function callContext(callId) {
    const entry = store.getCall(callId);
    if (!entry) return { listings: [], updatedAt: null, ended: false };
    return { listings: entry.cards, updatedAt: new Date(entry.updatedAt).toISOString(), ended: entry.ended === true };
  }

  /**
   * The site's contact / sell / listing forms. Records a `form_submit` event under the
   * browser's own `event_id` (a no-op when the site already sent it), creates or
   * merges the lead, and tells the owner. Nothing here is billable.
   */
  async function enquiry(body, server) {
    const checked = validateEnquiry(body);
    if (!checked.ok) throw Object.assign(new Error(checked.message), { code: 'BAD_BODY' });
    const q = checked.enquiry;
    const now = server.received ?? Date.now();
    const result = db.transaction(() => {
    const previous = previousEnquiry(db, q);
    if (previous) return { previous };

    if (q.ids.anon_id && q.ids.session_id) {
      const ev = validateEvent({
        v: 1, event_id: q.event_id, ts: now, event: 'form_submit', anon_id: q.ids.anon_id, session_id: q.ids.session_id, ref: q.ids.ref,
        page: q.page, locale: q.locale, listing_id: q.listing_id, props: { form: q.form, cta: 'enquiry' }, attr: q.attr, consent: q.consent,
      }, { now });
      if (ev.ok) recordEvent(db, ev.event, server);
    }

    const notes = [q.message, q.type ? `Type: ${q.type}` : null, q.location ? `Location: ${q.location}` : null].filter(Boolean).join('\n') || null;
    const { lead, created } = createOrMergeLead(db, {
      name: q.name, phone: q.phone, interest: q.interest, budget: q.budget, listingId: q.listing_id, language: q.locale, district: q.location, notes,
    }, {
      channel: 'form', matchMethod: 'form', sessionId: q.ids.session_id, anonId: q.ids.anon_id, ref: q.ids.ref, eventId: q.event_id,
      now, dataDir: cfg.dataDir, consent: q.consent, raw: { form: q.form, page: q.page },
    });
    ensureHandoff(db, { leadId: lead.lead_id, source:'form', reason:'Enquiry received', details:{budget:q.budget,area:q.location,property_type:q.type}, now });
    saveEnquiryReceipt(db, q, lead.lead_id, now);
    // Every accepted enquiry, including an existing contact, gets one conversion event.
    if (db.getEvent(q.event_id)) db.enqueueFanout(q.event_id, ['meta','ga4','snap','tiktok'], { now });
    return { lead: db.getLead(lead.lead_id), created };
    }, {immediate:true});
    if (result.previous) return result.previous;
    const {lead,created} = result;
    log({ evt: 'enquiry', leadId: lead.lead_id, created, form: q.form, source: lead.source, listingId: lead.listing_id });

    // The owner's note (DESIGN §7.1): the notes module sends it through today's transport and
    // records the receipt's notify_status; the request waits for it for up to 4 s, as before.
    await notes.leadEvent(lead, { why: 'form', created, eventId: q.event_id });
    await notifyHandoff(lead.lead_id);
    return { lead_id: lead.lead_id };
  }

  function retellWebhook(body) {
    const event = String(body.event ?? body.event_type ?? 'unknown');
    const call = body.call ?? body.chat ?? body.data ?? {};
    const file = event.startsWith('chat_') || body.chat ? 'chats.jsonl' : 'calls.jsonl';
    const record = {
      ts: new Date().toISOString(),
      event,
      callId: call.call_id ?? call.chat_id ?? null,
      agentId: call.agent_id ?? null,
      status: call.call_status ?? null,
      durationMs: call.duration_ms ?? null,
      disconnectionReason: call.disconnection_reason ?? null,
      locale: call.metadata?.locale ?? null,
      page: call.metadata?.page ?? null,
      summary: call.call_analysis?.call_summary ?? null,
      sentiment: call.call_analysis?.user_sentiment ?? null,
      successful: call.call_analysis?.call_successful ?? null,
      transcript: typeof call.transcript === 'string' ? call.transcript.slice(0, 20_000) : null,
    };
    try { appendJsonl(cfg.dataDir, file, record); } catch (err) { log({ level: 'error', evt: 'webhook.write_failed', error: String(err?.message ?? err) }); }
    // The browser's gateway transport cannot see Dana hang up; the widget learns it from /v1/call/:id/context.
    if (event === 'call_ended' && record.callId) store.endCall(String(record.callId));
    log({ evt: 'retell.webhook', event, callId: record.callId });
    return { ok: true };
  }

  /* -------------------- dispatcher -------------------- */

  /** 413, then drop the connection: the rest of the oversized body is never read. */
  function sendTooLarge(req, res, cors) {
    res.on('finish', () => req.destroy());
    sendJson(res, 413, { error: 'payload_too_large' }, { ...cors, Connection: 'close' });
    return undefined;
  }

  /** Read + parse the body, or answer 413/400 and return `undefined`. */
  async function bodyOf(req, res, cors) {
    try {
      return parseJsonBody(await readBody(req, cfg.maxBodyBytes));
    } catch (err) {
      if (err?.code === 'BODY_TOO_LARGE') return sendTooLarge(req, res, cors);
      sendJson(res, 400, { error: 'invalid_json' }, cors);
      return undefined;
    }
  }

  /**
   * `POST /v1/events` — first-party events from the site. Outside the JSON-only gate
   * (the site posts `text/plain` so there is no preflight and `keepalive` works),
   * outside the Retell budget (nothing here costs money), on its own wide rate limit,
   * and with its own 8 KB cap. It is origin-checked fail-closed like every other browser
   * route: an origin that is not ours, or no origin at all, is refused. Success is an
   * empty 204.
   */
  async function eventsRoute({ req, res, origin, cors, ip }) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' }, cors);
    if (!isAllowedOrigin(origin, cfg.origins)) {
      log({ level: 'warn', evt: 'origin.rejected', path: '/v1/events', origin: origin ? String(origin).slice(0, 200) : null, ip });
      return sendJson(res, 403, { error: 'forbidden_origin' }, cors);
    }
    const gate = limiters.events.take(`events:${ip}`);
    if (!gate.ok) return sendJson(res, 429, { error: 'rate_limited' }, { ...cors, 'Retry-After': String(gate.retryAfterS) });

    let parsed;
    try {
      parsed = JSON.parse(await readBody(req, MAX_EVENT_BYTES));
    } catch (err) {
      if (err?.code === 'BODY_TOO_LARGE') return sendTooLarge(req, res, cors);
      return sendJson(res, 400, { error: 'bad_event', reason: 'json' }, cors);
    }
    const checked = validateEvent(parsed);
    if (!checked.ok) return sendJson(res, 400, { error: 'bad_event', reason: checked.reason }, cors);
    try {
      recordEvent(db, checked.event, serverContext(req, ip));
    } catch (err) {
      log({ level: 'error', evt: 'event.write_failed', name: checked.event.event, error: String(err?.message ?? err) });
      return sendJson(res, 500, { error: 'internal_error' }, cors);
    }
    res.writeHead(204, { ...cors, 'Cache-Control': 'no-store' });
    return res.end();
  }

  /**
   * Retell-facing routes. Authenticated *before* the body is read: an unauthenticated
   * caller must never get this process to buffer and parse 16 KB of its JSON. No CORS
   * either — these are server-to-server and must not be readable from a browser.
   */
  async function toolRoute({ req, res, url, p, ip, toolName }) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });

    const flood = limiters.tool.take(`tool:${ip}`);
    if (!flood.ok) return sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(flood.retryAfterS) });

    // Custom tools carry the token in a header (provisioning puts it there). Retell's
    // agent webhook has no way to send one — it offers only its own X-Retell-Signature
    // — so `?token=` stays valid on that single route.
    const token = extractToken({ url, headers: req.headers, allowQuery: cfg.allowQueryToken || !toolName });
    if (!tokenMatches(token, cfg.toolToken)) {
      const guess = limiters.toolAuth.take(`toolauth:${ip}`);
      log({ level: 'warn', evt: 'tool.unauthorised', path: p, ip, blocked: !guess.ok });
      if (!guess.ok) return sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(guess.retryAfterS) });
      return sendJson(res, 401, { error: 'unauthorised' });
    }

    const body = await bodyOf(req, res, {});
    if (body === undefined) return undefined;

    if (!toolName) return sendJson(res, 200, retellWebhook(body));
    if (!TOOL_NAMES.includes(toolName)) return sendJson(res, 404, { error: 'unknown_tool' });
    try {
      return sendRaw(res, 200, JSON.stringify(await tools.run(toolName, body)));
    } catch (err) {
      log({ level: 'error', evt: 'tool.failed', tool: toolName, error: String(err?.message ?? err) });
      // On WhatsApp or email the client is already talking to Bona's number or mailbox: no number to
      // offer, a person can help (critic round 2 #17a). The website concierge keeps today's note.
      const source = (body.call?.metadata ?? body.chat?.metadata ?? {})?.source;
      const note = source === 'bona-whatsapp' || source === 'bona-email' ? TOOL_FAILED_NOTE_CLIENT : TOOL_FAILED_NOTE_VISITOR;
      return sendRaw(res, 200, JSON.stringify(JSON.stringify({ error: 'tool_failed', note })));
    }
  }

  async function handle(req, res) {
    // The old site host, answered before anything else looks at the request. bona.azoz.uk
    // was the site until the move to bona-real-estate.com, and its DNS now points at this
    // API's tunnel — but there is nothing here for it, so every request it brings is sent
    // on to the same path on the new domain. Ahead of CORS, the rate limiters, the token
    // check and the routing table on purpose: someone following a two-year-old link must
    // get the page, not a 404 or a 401, and a host that has no routes here must not be
    // able to spend a bucket or a day's budget on the way to being told so.
    if (isLegacyHost(req.headers.host, cfg.legacyHosts)) {
      res.writeHead(301, {
        Location: legacyRedirectUrl(cfg.siteUrl, req.url),
        // Short, because the old host is a stepping stone: it stays cheap to change our
        // minds about where it points while the move is still settling.
        'Cache-Control': 'max-age=3600',
        'Content-Length': '0',
      });
      return res.end();
    }

    const origin = req.headers.origin;
    const cors = corsHeaders(origin, cfg.origins);
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' }, cors);
    }
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const ip = clientIp(req, { trustedProxies: cfg.trustedProxies });

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Cache-Control': 'no-store' });
      return res.end();
    }

    if (p === '/health' || p === '/') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' }, cors);
      const report = await health();
      return sendJson(res, report.ok ? 200 : 503, report, cors);
    }

    const callContextMatch = /^\/v1\/call\/([A-Za-z0-9_-]{1,128})\/context$/.exec(p);
    if (callContextMatch) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, cors);
      if (!limiters.misc.take(`ctx:${ip}`).ok) return sendJson(res, 429, { error: 'rate_limited' }, cors);
      return sendJson(res, 200, callContext(callContextMatch[1]), cors);
    }

    const toolMatch = /^\/v1\/tools\/([a-z_]{1,64})$/.exec(p);
    if (toolMatch || p === '/v1/retell/webhook') {
      return toolRoute({ req, res, url, p, ip, toolName: toolMatch?.[1] ?? null });
    }

    if (p === '/v1/events') return eventsRoute({ req, res, origin, cors, ip });

    // The private dashboard and its admin JSON, ahead of the browser routes on purpose:
    // they are authenticated by a cookie rather than by an origin, they answer HTML as
    // well as JSON, and they must never be handed the site's CORS headers.
    if (dashboard.owns(p)) return dashboard.handle({ req, res, url, p, ip });

    /* Browser-facing routes. */
    if (req.method !== 'POST' || !BROWSER_ROUTES.has(p)) return sendJson(res, 404, { error: 'not_found' }, cors);

    // CORS only stops a browser *reading* the answer — the request still ran and still
    // cost Retell money. So the origin is checked here, fail-closed: not just a stated
    // origin that is not ours, but no stated origin at all.
    //
    // This is defence in depth, not authentication. A non-browser caller can set any
    // header it likes, so this stops nothing determined — what it stops is the accidental
    // and the lazy: a scraper, a copied curl, a scripted client written without thinking
    // about it. Every real caller is a cross-origin fetch from the site, which the browser
    // always stamps with an Origin, so nothing legitimate loses by it. What actually
    // bounds the damage from a determined caller is the per-IP limiter and the daily
    // Retell budget, both of which sit below this.
    if (!isAllowedOrigin(origin, cfg.origins)) {
      log({ level: 'warn', evt: 'origin.rejected', path: p, origin: origin ? String(origin).slice(0, 200) : null, ip });
      return sendJson(res, 403, { error: 'forbidden_origin' }, cors);
    }
    // JSON-only, with one exception. `/v1/enquiry` also takes `text/plain`, because the
    // form posts the lead with `keepalive` in the same tick the page navigates to
    // WhatsApp: only a CORS "simple request" (no preflight) survives that hand-off on
    // mobile, and a preflight is exactly what `application/json` forces. Nothing
    // upstream is billed by an enquiry, and the Origin check above already refuses a
    // stated foreign origin. The chat and call routes — the ones that spend Retell
    // money — stay JSON-only, so a cross-site form post cannot reach them at all.
    const ct = req.headers['content-type'];
    if (!isJsonContentType(ct) && !(p === '/v1/enquiry' && isPlainTextContentType(ct))) {
      return sendJson(res, 415, { error: 'unsupported_media_type' }, cors);
    }

    const limiterKey = p === '/v1/call/token' ? 'token' : p === '/v1/enquiry' ? 'enquiry' : 'chat';
    const gate = limiters[limiterKey].take(`${limiterKey}:${ip}`);
    if (!gate.ok) return sendJson(res, 429, { error: 'rate_limited' }, { ...cors, 'Retry-After': String(gate.retryAfterS) });

    const body = await bodyOf(req, res, cors);
    if (body === undefined) return undefined;

    // The day's ceiling stands for money Retell actually takes, so it is charged only once
    // the body has parsed AND validated — malformed JSON never reached Retell and must not
    // burn the day — and given back below if the Retell call itself fails. `charged` holds
    // the unit that is still owed; it is cleared the moment Retell has answered.
    let charged = null;
    try {
      const kind = BILLABLE_ROUTES.get(p);
      if (kind) {
        assertBillableBody(body);
        if (!budget.take(kind)) return sendJson(res, 503, { error: 'budget_exhausted' }, cors);
        charged = kind;
      }
      let payload;
      switch (p) {
        case '/v1/chat/session': payload = await chatSession(body, serverContext(req, ip)); break;
        case '/v1/chat/message': payload = await chatMessage(body); break;
        case '/v1/chat/end': payload = await chatEnd(body); break;
        case '/v1/call/token': payload = await callToken(body, serverContext(req, ip)); break;
        case '/v1/enquiry': payload = await enquiry(body, serverContext(req, ip)); break;
        default: return sendJson(res, 404, { error: 'not_found' }, cors);
      }
      charged = null;
      return sendJson(res, 200, payload, cors);
    } catch (err) {
      // Nothing was opened upstream: a 402/429/5xx from Retell, a network error, a body the
      // handler itself refused, or an agent that was never provisioned. Hand the unit back.
      if (charged) budget.refund(charged);
      if (err?.code === 'NO_SESSION') return sendJson(res, 404, { error: 'session_not_found' }, cors);
      if (err?.code === 'ENQUIRY_CONFLICT') return sendJson(res, 409, { error: 'enquiry_conflict' }, cors);
      if (err?.code === 'BAD_BODY') return sendJson(res, 400, { error: 'bad_request', message: err.message }, cors);
      if (err?.code === 'SESSION_LIMIT') return sendJson(res, 429, { error: 'session_limit' }, cors);
      if (err?.code === 'NOT_PROVISIONED') return sendJson(res, 503, { error: 'not_provisioned', message: err.message }, cors);
      if (err instanceof RetellError) return sendRetellError(res, err, { p, cors });
      log({ level: 'error', evt: 'route.failed', path: p, status: 500, error: String(err?.message ?? err) });
      return sendJson(res, 500, { error: 'internal_error' }, cors);
    }
  }

  /**
   * Retell's own failures, told apart rather than flattened to 502:
   *   429 — Retell is throttling us; pass the backpressure (and its Retry-After) on.
   *   402 — the owner's Retell balance is empty. Nothing retries its way out of that,
   *         so it is 503 and it is shouted about in the log.
   *   anything else — 502, with no upstream body echoed back.
   */
  function sendRetellError(res, err, { p, cors }) {
    const status = Number(err.status);
    if (status === 429) {
      log({ level: 'warn', evt: 'retell.throttled', path: p, retryAfter: err.retryAfter ?? null });
      const retryAfter = /^\d+$/.test(String(err.retryAfter ?? '')) ? String(err.retryAfter) : null;
      return sendJson(res, 429, { error: 'rate_limited' }, { ...cors, ...(retryAfter ? { 'Retry-After': retryAfter } : {}) });
    }
    if (status === 402) {
      log({ level: 'error', evt: 'retell.billing', path: p, message: 'RETELL BALANCE EXHAUSTED — the concierge is down until the owner tops it up' });
      return sendJson(res, 503, { error: 'billing' }, cors);
    }
    log({ level: 'error', evt: 'route.failed', path: p, status: 502, upstream: status ?? null, error: String(err?.message ?? err) });
    return sendJson(res, 502, { error: 'upstream_error' }, cors);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log({ level: 'error', evt: 'unhandled', error: String(err?.stack ?? err) });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      else res.end();
    });
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  // The store is owned by the app when the app opened it; a caller who injected one
  // (tests, tools) closes it themselves.
  if (ownsDb) server.on('close', () => { app.stopTimers(); notes.stop?.(); fanout.stop(); poller?.stop(); app.dana.stop().catch(() => {}); db.close(); });

  app.server = server;
  app.handle = handle;
  app.dashboard = dashboard;
  app.poller = poller;
  return app;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const app = createApp();
  // The enquiries recorded before the store existed come in once; a rerun is a no-op.
  try {
    jsonLog('info', { evt: 'import.legacy', ...importJsonl(app.db, app.cfg.dataDir) });
  } catch (err) {
    jsonLog('error', { evt: 'import.legacy_failed', error: String(err?.message ?? err) });
  }
  // Ad-platform fan-out. Starting it with no credentials is not a waste: the worker
  // marks those rows `skipped` instead of letting a backlog build, and picks the real
  // destinations up the moment ~/.secrets/bona-marketing.env has them.
  const fanoutStarted = app.fanout.start();
  jsonLog('info', { evt: 'fanout.init', started: fanoutStarted, dests: app.fanout.dests(), everyMs: app.cfg.fanoutMs });
  // Inbox upkeep (P2-18): once now, then daily. It logs its own counts and never rejects
  // (the `.catch` only keeps a future slip from crashing the process); like the poller, it
  // is never the reason the process stays alive.
  app.inboxMaintenance().catch(() => {});
  // PR-INT's timers (TIMERS): the notes, the summary minute, the sweep, the viewing worker, the brain's
  // models probe and the daily upkeep, plus the link probe, whose first round runs now. The WhatsApp
  // poller starts once that round has answered (`app.start`): `BONA_WA_POLL=0` turns it off; without
  // Evolution credentials it starts and skips every tick rather than guessing a URL. It never sets a
  // webhook. The brain's probe runs once right after that round ($0, only with a key).
  app.start().then(({ timers, pollStarted }) => {
    jsonLog('info', { evt: 'timers.init', timers: timers.map((x) => x.name) });
    if (app.poller) jsonLog('info', { evt: 'wa.poll.init', started: pollStarted, everyMs: app.cfg.waPollMs, ...app.poller.status() });
  }).catch((err) => jsonLog('error', { evt: 'start.failed', name: loggableName(err) }));
  app.server.listen(app.cfg.port, app.cfg.host, () => {
    jsonLog('info', { evt: 'listening', ...redacted(app.cfg) });
  });
  const shutdown = async (signal) => {
    jsonLog('info', { evt: 'shutdown', signal });
    // Bounded as before: five seconds for the tick in flight, the pushes and the open connections.
    setTimeout(() => process.exit(0), 5000).unref();
    // The poller first — off its timer, and the tick in flight finished, so every alert it
    // raises and every Dana wake is in. Then Dana (armed batches dropped, the answers in flight
    // finished — each may raise a push) and the pushes on their way (each writes to the store:
    // `last_ok`, a gone device), given up to 4 s together: a Retell call can take 30 s. A run
    // cut before its send leaves no row — the next client message wakes her; one cut mid-send
    // is `uncertain` at start-up. Then the server, whose close stops the fan-out and the store.
    app.stopTimers();
    app.notes.stop?.();
    await app.poller?.stop();
    await Promise.race([
      Promise.resolve().then(() => app.dana.stop()).then(() => app.alerts.flush()),
      new Promise((r) => { setTimeout(r, 4000).unref(); }),
    ]);
    app.server.close(() => process.exit(0));
  };
  // Nothing in `shutdown` rejects (`stop` and `flush` swallow their own failures); should one
  // ever slip, an exit is still an exit, not a process hanging on a floating promise.
  process.on('SIGTERM', () => shutdown('SIGTERM').catch(() => process.exit(1)));
  process.on('SIGINT', () => shutdown('SIGINT').catch(() => process.exit(1)));
}
