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
 *   POST /v1/call/token            { locale, page? }         -> { accessToken, callId }
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
import { appendJsonl, createOrMergeLead, leadNote } from './lib/leads.mjs';
import { sendText } from './lib/wa.mjs';
import { createDashboardRoutes } from './lib/dashboard/routes.mjs';

const GREETING = {
  en: "Hello, I'm Dana from Bona. How can I help you today?",
  ar: 'مرحباً، أنا دانة من بونا. كيف أقدر أساعدك؟',
};

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
  const retell = options.retell ?? createRetellClient({ apiKey: cfg.retellApiKey, mock: cfg.retellMock });
  // The queue behind `db.enqueueFanout()`. Constructed always, started only by the real
  // server (below): a test drains it by hand so nothing goes out on a timer.
  const fanout = options.fanout ?? createFanout({ db, cfg, log });
  const probeRetell = options.probeRetell ?? createHealthProbe(retell);
  const sendWhatsApp = options.sendWhatsApp ?? ((text) => sendText(text, { env: cfg.env }));
  // The WhatsApp Ref-code poller. Read-only, and only when `BONA_WA_POLL` says so —
  // constructing it contacts nothing; the real server (below) is what puts it on a timer.
  const poller = options.poller ?? (cfg.waPoll ? createPoller({ db, cfg, sendWhatsApp, log }) : null);
  const tools = createToolHandlers({
    inventory, units, store, db, dataDir: cfg.dataDir, siteUrl: cfg.siteUrl, env: cfg.env, sendWhatsApp, log,
  });

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
  const budget = options.budget ?? createBudget({
    maxChats: cfg.maxChatsPerDay ?? 300,
    maxCalls: cfg.maxCallsPerDay ?? 60,
    log,
  });
  const maxTurns = cfg.maxTurnsPerSession ?? 40;

  const startedAt = Date.now();

  // Built before the routes so the dashboard can read what the process is running —
  // notably `app.poller`, which another branch attaches — through one live reference
  // rather than a second wiring step. `server` and `handle` are added at the end.
  const app = {
    cfg, inventory, store, db, retell, tools, limiters, fanout, budget,
    poller: options.poller ?? null,
  };

  // The owner's dashboard. It owns its own auth (a WhatsApp one-time code), its own
  // security headers and its own limiter; nothing about it is CORS-enabled.
  const dashboard = options.dashboard ?? createDashboardRoutes({
    db, cfg, inventory, fanout, app, log, sendWhatsApp, probeRetell,
  });

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
        path: page?.url ?? null, props: { conversation_id: conversationId, locale, ref: attr.ref },
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
    return { accessToken: call.access_token, callId: call.call_id };
  }

  function callContext(callId) {
    const entry = store.getCall(callId);
    if (!entry) return { listings: [], updatedAt: null };
    return { listings: entry.cards, updatedAt: new Date(entry.updatedAt).toISOString() };
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
      now, dataDir: cfg.dataDir, raw: { form: q.form, page: q.page },
    });
    log({ evt: 'enquiry', leadId: lead.lead_id, created, form: q.form, source: lead.source, listingId: lead.listing_id });

    if (sendWhatsApp) {
      try {
        const res = await sendWhatsApp(leadNote(lead, { siteUrl: cfg.siteUrl }));
        if (!res?.ok) log({ evt: 'lead.wa_failed', id: lead.lead_id, error: res?.error ?? 'unknown' });
      } catch (err) {
        log({ evt: 'lead.wa_error', id: lead.lead_id, error: String(err?.message ?? err) });
      }
    }
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
      return sendRaw(res, 200, JSON.stringify(JSON.stringify({ error: 'tool_failed', note: 'Tell the visitor you cannot check that right now and offer WhatsApp +966 59 329 6933.' })));
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
  if (ownsDb) server.on('close', () => { fanout.stop(); poller?.stop(); db.close(); });

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
  // The WhatsApp poller. `BONA_WA_POLL=0` turns it off; without Evolution credentials it
  // starts and skips every tick rather than guessing a URL. It never sets a webhook.
  if (app.poller) {
    const pollStarted = app.poller.start({ intervalMs: app.cfg.waPollMs });
    jsonLog('info', { evt: 'wa.poll.init', started: pollStarted, everyMs: app.cfg.waPollMs, ...app.poller.status() });
  }
  app.server.listen(app.cfg.port, app.cfg.host, () => {
    jsonLog('info', { evt: 'listening', ...redacted(app.cfg) });
  });
  const shutdown = (signal) => {
    jsonLog('info', { evt: 'shutdown', signal });
    app.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
