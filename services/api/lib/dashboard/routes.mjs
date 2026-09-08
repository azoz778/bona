/**
 * The private dashboard and the admin JSON behind it.
 *
 * Mounted ahead of the browser routes for two prefixes: `/dashboard` (HTML the owner
 * reads) and `/v1/admin` (the same data as JSON, and every write). Both are gated by
 * the `bona_dash` cookie; HTML without one is redirected to the login, JSON without
 * one is 401. Nothing here is CORS-enabled, so no other origin can read a byte of it.
 *
 * Three things are deliberate:
 *
 *   1. Every response carries `default-src 'none'` — the pages have no JavaScript at
 *      all, so the strictest possible policy is also a free one, and a lead named
 *      `<script>` has nowhere to run even if an escape were missed.
 *   2. Writes require a marker the browser will not send by itself: `X-Bona-Dash: 1`
 *      on a JSON call, a hidden `_dash=1` on a form. With `SameSite=Lax` already
 *      keeping the cookie off cross-site POSTs, this is the second lock — a form on
 *      someone else's page cannot set a header and does not know the field.
 *   3. `Origin` and `Referer`, when the browser states them, must be this API's own.
 *      Checked on writes only: a GET is checked by nothing that matters, and a
 *      navigation arriving from the site itself is a normal way to reach the login.
 *
 * Phone numbers are masked everywhere a list is rendered and whole only on the one
 * page (and the one JSON route) that exists to show a single person's record.
 */
import { STAGES } from '../db.mjs';
import { createLimiter } from '../ratelimit.mjs';
import { enqueueStage } from '../fanout.mjs';
import { createStats, dayKey } from './stats.mjs';
import { createAuth } from './auth.mjs';
import {
  knownError,
  loginPage, overviewPage, leadsPage, leadDetailPage, listingsPage, spendPage, integrationsPage, messagePage,
  maskPhone, esc,
} from './render.mjs';

/** Set on every dashboard and admin response, HTML or JSON, success or failure. */
export const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

export const MAX_NOTE = 2000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const isForm = (ct) => /^application\/x-www-form-urlencoded\s*(?:;|$)/i.test(String(ct ?? '').trim());
const isJson = (ct) => /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i.test(String(ct ?? '').trim());

const trimTo = (v, max) => {
  // A JSON caller can put an object where a string belongs; `String({})` would store
  // "[object Object]" as if the owner had typed it.
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).replace(/\r\n?/g, '\n').trim();
  return s ? s.slice(0, max) : null;
};
const posInt = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

/** Read a body with a hard cap; an oversized one is refused rather than buffered. */
export function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
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

/**
 * @param {object} o
 * @param {ReturnType<import('../db.mjs').openDb>} o.db
 * @param {object} o.cfg
 * @param {object} [o.inventory]                       the listings holder
 * @param {object} [o.fanout]                          createFanout() — only `enqueueStage` and `dests` are used
 * @param {object} [o.app]                             the app object, read defensively for `poller`
 * @param {(text: string) => Promise<object>} [o.sendWhatsApp]
 * @param {() => Promise<string>} [o.probeRetell]
 */
export function createDashboardRoutes({
  db, cfg = {}, inventory = null, fanout = null, app = null,
  sendWhatsApp = null, probeRetell = null,
  auth = null, stats = null, log = () => {}, now = () => Date.now(),
} = {}) {
  const authenticator = auth ?? createAuth({ db, cfg, sendWhatsApp, now, log });
  const statistics = stats ?? createStats({ db, now });
  const maxBodyBytes = Number(cfg.maxBodyBytes ?? 16 * 1024);
  const limiters = {
    // The login is the one surface a stranger reaches, so guessing is capped separately
    // from the code sender (which `createAuth` limits by itself).
    verify: createLimiter({ capacity: 20, perMs: 60_000, now }),
    page: createLimiter({ capacity: 240, perMs: 60_000, now }),
  };

  /* -------------------- responses -------------------- */

  function sendHtml(res, status, html, extra = {}) {
    const body = Buffer.from(html, 'utf8');
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      ...SECURITY_HEADERS,
      ...extra,
    });
    res.end(body);
  }

  function sendJson(res, status, payload, extra = {}) {
    const body = Buffer.from(JSON.stringify(payload ?? null), 'utf8');
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      ...SECURITY_HEADERS,
      ...extra,
    });
    res.end(body);
  }

  /** 303, so a re-load of the result page does not re-post the form. */
  function redirect(res, location, status = 303) {
    res.writeHead(status, { Location: location, 'Content-Length': '0', ...SECURITY_HEADERS });
    res.end();
  }

  /** 302 for a navigation that never got started; 303 after a form post. */
  const toLogin = (res, query = '', status = 302) => redirect(res, `/dashboard/login${query}`, status);

  /* -------------------- gates -------------------- */

  /** The origins this API answers on: its public name, and the host it was asked for. */
  function ownOrigins(req) {
    const host = String(req.headers.host ?? '').trim();
    const out = new Set();
    if (cfg.publicApi) out.add(String(cfg.publicApi).replace(/\/+$/, ''));
    if (host) { out.add(`https://${host}`); out.add(`http://${host}`); }
    return out;
  }

  /** True unless the browser stated an origin (or referer) that is not ours. */
  function sameOrigin(req) {
    const own = ownOrigins(req);
    const origin = req.headers.origin;
    if (origin && origin !== 'null' && !own.has(String(origin).trim().replace(/\/+$/, ''))) return false;
    const referer = req.headers.referer;
    if (referer) {
      try { if (!own.has(new URL(referer).origin)) return false; } catch { return false; }
    }
    return true;
  }

  /** The marker a cross-site form cannot produce. */
  const hasMarker = (req, fields) => req.headers['x-bona-dash'] === '1' || String(fields?._dash ?? '') === '1';

  const sessionToken = (req) => authenticator.readCookie(req);
  const signedIn = (req) => {
    const token = sessionToken(req);
    return Boolean(token) && authenticator.check(token);
  };

  /**
   * Read and parse a write body.
   * @returns {{ ok: true, fields: object, form: boolean } | { ok: false, status: number, error: string }}
   */
  async function fieldsOf(req) {
    const ct = req.headers['content-type'];
    const form = isForm(ct);
    if (!form && !isJson(ct)) return { ok: false, status: 415, error: 'unsupported_media_type' };
    let text;
    try {
      text = await readBody(req, maxBodyBytes);
    } catch (err) {
      if (err?.code === 'BODY_TOO_LARGE') return { ok: false, status: 413, error: 'payload_too_large' };
      return { ok: false, status: 400, error: 'bad_request' };
    }
    if (form) return { ok: true, form: true, fields: Object.fromEntries(new URLSearchParams(text)) };
    try {
      const parsed = text.trim() ? JSON.parse(text) : {};
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, status: 400, error: 'bad_request' };
      return { ok: true, form: false, fields: parsed };
    } catch {
      return { ok: false, status: 400, error: 'invalid_json' };
    }
  }

  /* -------------------- login -------------------- */

  function loginView(req, url) {
    const step = url.searchParams.get('step') === 'code' ? 'code' : 'request';
    const error = url.searchParams.get('error');
    const sent = url.searchParams.get('sent') === '1';
    return loginPage({ step, error: knownError(error), sent });
  }

  async function loginCode({ req, res, ip }) {
    // Origin first: the login is the one surface a stranger reaches, and a stranger must
    // not be able to make this process buffer and parse their body before being refused.
    if (!sameOrigin(req)) {
      log({ level: 'warn', evt: 'dash.origin_rejected', path: '/dashboard/login/code', ip });
      return toLogin(res, '?error=forbidden', 303);
    }
    const parsed = await fieldsOf(req);
    if (!parsed.ok) return sendJson(res, parsed.status, { error: parsed.error });
    const out = await authenticator.requestCode(ip);
    if (!out.ok) return toLogin(res, `?step=code&error=${encodeURIComponent(out.error)}`, 303);
    return toLogin(res, '?step=code&sent=1', 303);
  }

  async function loginVerify({ req, res, ip }) {
    if (!sameOrigin(req)) {
      log({ level: 'warn', evt: 'dash.origin_rejected', path: '/dashboard/login/verify', ip });
      return toLogin(res, '?step=code&error=forbidden', 303);
    }
    if (!limiters.verify.take(`dashverify:${ip}`).ok) return toLogin(res, '?step=code&error=rate_limited', 303);
    const parsed = await fieldsOf(req);
    if (!parsed.ok) return sendJson(res, parsed.status, { error: parsed.error });

    const ua = String(req.headers['user-agent'] ?? '').slice(0, 300) || null;
    const out = authenticator.verify(parsed.fields.code, ua);
    if (!out.ok) return toLogin(res, `?step=code&error=${encodeURIComponent(out.error)}`, 303);
    authenticator.setCookie(res, out.token);
    return redirect(res, '/dashboard');
  }

  function logout({ req, res }) {
    const token = sessionToken(req);
    if (token) authenticator.logout(token);
    authenticator.clearCookie(res);
    return toLogin(res);
  }

  /* -------------------- read models -------------------- */

  const listingRows = () => statistics.listingFunnel(inventory);

  /** Which keys this process can see. Booleans only — never a value, never a prefix. */
  function keyPresence() {
    const env = cfg.env ?? {};
    return [
      { label: 'Meta — pixel id', present: Boolean(cfg.metaPixelId) },
      { label: 'Meta — Conversions API token', present: Boolean(cfg.metaCapiToken) },
      { label: 'Meta — test event code', present: Boolean(cfg.metaTestEventCode), note: 'optional, for Events Manager testing' },
      { label: 'GA4 — measurement id', present: Boolean(cfg.ga4MeasurementId) },
      { label: 'GA4 — Measurement Protocol secret', present: Boolean(cfg.ga4ApiSecret) },
      { label: 'Snapchat — pixel id', present: Boolean(cfg.snapPixelId) },
      { label: 'Snapchat — Conversions API token', present: Boolean(cfg.snapCapiToken) },
      { label: 'Retell — API key', present: Boolean(cfg.retellApiKey) },
      { label: 'Retell — tool token', present: Boolean(cfg.toolToken) },
      { label: 'Evolution — owner WhatsApp', present: Boolean(env.EVOLUTION_API_URL && env.EVOLUTION_API_KEY), note: 'sends the login code and the lead notes' },
    ];
  }

  /**
   * The last row each destination accepted. `fanout.ts` is when the row was queued
   * rather than when it went out, which for a queue that drains every twenty seconds
   * is the same answer to within a coffee sip.
   */
  function lastAccepted() {
    const out = {};
    const stmt = db.db.prepare("SELECT event_id, ts FROM fanout WHERE dest = ? AND status = 'sent' ORDER BY ts DESC, rowid DESC LIMIT 1");
    for (const dest of ['meta', 'ga4', 'snap']) {
      const row = stmt.get(dest);
      out[dest] = row ? { event_id: row.event_id, ts: row.ts } : null;
    }
    return out;
  }

  /**
   * The WhatsApp poller lives on another branch, so its shape is read defensively:
   * a missing poller is "not running here", never a 500 on the Integrations page.
   */
  function pollerStatus() {
    const poller = app?.poller;
    if (!poller) return null;
    try {
      const health = typeof poller.health === 'function' ? poller.health() : poller;
      if (!health || typeof health !== 'object') return null;
      const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
      const lastRun = n(health.lastRun ?? health.last_run);
      return {
        lastRun,
        lag: n(health.lag) ?? (lastRun === null ? null : Math.max(0, now() - lastRun)),
        unmatched: n(health.unmatched),
      };
    } catch (err) {
      log({ level: 'warn', evt: 'dash.poller_health_failed', error: String(err?.message ?? err).slice(0, 200) });
      return null;
    }
  }

  function fanoutView() {
    const counts = (() => { try { return db.fanoutCounts(); } catch { return { pending: 0, sent: 0, failed: 0, skipped: 0 }; } })();
    const dests = (() => { try { return fanout?.dests?.() ?? { meta: false, ga4: false, snap: false }; } catch { return { meta: false, ga4: false, snap: false }; } })();
    return { counts, dests };
  }

  /* -------------------- HTML pages -------------------- */

  function overview({ res, url }) {
    const days = Math.max(1, Math.min(90, Number(url.searchParams.get('days')) || 14));
    return sendHtml(res, 200, overviewPage({
      days,
      daily: statistics.overviewDaily(days),
      sources: statistics.sources(),
      matchQuality: statistics.matchQuality(),
      pipeline: statistics.pipeline(),
      responseTimes: statistics.responseTimes(),
    }));
  }

  function leads({ res, url }) {
    const stage = STAGES.includes(url.searchParams.get('stage')) ? url.searchParams.get('stage') : '';
    const q = String(url.searchParams.get('q') ?? '').slice(0, 100);
    const board = Object.fromEntries(STAGES.map((s) => [s, []]));
    for (const lead of db.listLeads({ limit: 500 })) board[lead.stage]?.push(lead);
    return sendHtml(res, 200, leadsPage({
      board,
      leads: db.listLeads({ stage: stage || null, q: q || null, limit: 200 }),
      stage, q, now: now(), total: db.countLeads(),
    }));
  }

  function leadDetail({ res, url }, leadId) {
    const lead = db.getLead(leadId);
    if (!lead) return sendHtml(res, 404, messagePage({ title: 'Not found', message: 'No lead with that id.' }));
    const saved = url.searchParams.get('ok');
    const error = url.searchParams.get('error');
    return sendHtml(res, 200, leadDetailPage({
      lead,
      journey: statistics.leadJourney(leadId),
      saved: saved === 'stage' || saved === 'note' ? saved : null,
      error: knownError(error),
      now: now(),
    }));
  }

  const listings = ({ res }) => sendHtml(res, 200, listingsPage({ rows: listingRows() }));

  function spend({ res, url }) {
    return sendHtml(res, 200, spendPage({
      rows: db.listSpend().reverse(),
      campaigns: statistics.cplByCampaign(),
      saved: url.searchParams.get('ok') === '1',
      error: knownError(url.searchParams.get('error')),
      today: dayKey(now()),
    }));
  }

  async function integrations({ res }) {
    let retell = 'unknown';
    try { retell = probeRetell ? await probeRetell() : (cfg.retellApiKey ? 'unknown' : 'error'); } catch { retell = 'error'; }
    let dbOk = false;
    try { dbOk = db.ping(); } catch { dbOk = false; }
    return sendHtml(res, 200, integrationsPage({
      keys: keyPresence(),
      fanout: fanoutView(),
      retell,
      poller: pollerStatus(),
      lastAccepted: lastAccepted(),
      db: { ok: dbOk, file: db.file ?? null },
    }));
  }

  /* -------------------- writes -------------------- */

  /**
   * A form post came from one of our own pages and must land back on it; a JSON call
   * wants JSON. One helper so every write answers both callers correctly.
   */
  const answer = (res, { form, back, status, payload }) =>
    (form ? redirect(res, back) : sendJson(res, status, payload));

  function setStage({ res, fields, form }, leadId) {
    const lead = db.getLead(leadId);
    if (!lead) return answer(res, { form, back: '/dashboard/leads', status: 404, payload: { error: 'not_found' } });

    const stage = String(fields.stage ?? '');
    const back = `/dashboard/leads/${encodeURIComponent(leadId)}`;
    if (!STAGES.includes(stage)) return answer(res, { form, back: `${back}?error=bad_stage`, status: 400, payload: { error: 'bad_stage', stages: STAGES } });

    const rawValue = fields.value_sar;
    const valueSar = rawValue === undefined || rawValue === null || String(rawValue).trim() === '' ? undefined : Number(rawValue);
    if (valueSar !== undefined && !(Number.isFinite(valueSar) && valueSar >= 0)) {
      return answer(res, { form, back: `${back}?error=bad_value`, status: 400, payload: { error: 'bad_value' } });
    }
    const note = trimTo(fields.note, MAX_NOTE);
    const t = now();

    const history = db.setStage(leadId, stage, { actor: 'owner', note, valueSar, now: t });
    const updated = db.getLead(leadId);
    // The ad platforms hear about the moves they can bid on; the rest is just history.
    const queued = typeof fanout?.enqueueStage === 'function'
      ? fanout.enqueueStage(updated, { stage, valueSar: updated.value_sar, now: t })
      : enqueueStage(db, updated, { stage, valueSar: updated.value_sar, now: t });
    log({ evt: 'dash.stage', leadId, stage, dests: queued.dests });

    return answer(res, {
      form, back: `${back}?ok=stage`, status: 200,
      payload: { ok: true, lead: withFullPhone(updated), stage: history, event_id: queued.event.event_id, dests: queued.dests },
    });
  }

  function addNote({ res, fields, form }, leadId) {
    const lead = db.getLead(leadId);
    const back = `/dashboard/leads/${encodeURIComponent(leadId)}`;
    if (!lead) return answer(res, { form, back: '/dashboard/leads', status: 404, payload: { error: 'not_found' } });
    const note = trimTo(fields.note, MAX_NOTE);
    if (!note) return answer(res, { form, back: `${back}?error=empty_note`, status: 400, payload: { error: 'empty_note' } });

    const t = now();
    const touchpoint = db.transaction(() => {
      const tp = db.addTouchpoint({
        lead_id: leadId, ts: t, channel: 'manual', event_type: 'note',
        listing_id: lead.listing_id ?? null, meta: { note, actor: 'owner' },
      });
      // Kept on the lead as well as in the journey: the owner's WhatsApp brief reads
      // `notes`, and a note nobody sees again is not worth typing.
      db.updateLead(leadId, { notes: lead.notes ? `${lead.notes}\n${note}` : note, updated: t });
      return tp;
    });
    log({ evt: 'dash.note', leadId });
    return answer(res, { form, back: `${back}?ok=note`, status: 200, payload: { ok: true, touchpoint_id: touchpoint.id } });
  }

  function saveSpend({ res, fields, form }) {
    const day = String(fields.day ?? '').trim();
    const platform = trimTo(fields.platform, 32)?.toLowerCase() ?? null;
    const spendSar = Number(fields.spend_sar);
    const bad = !DAY_RE.test(day) || !platform || !Number.isFinite(spendSar) || spendSar < 0;
    if (bad) return answer(res, { form, back: '/dashboard/spend?error=bad_request', status: 400, payload: { error: 'bad_request' } });

    db.upsertSpend({
      day,
      platform,
      campaign_id: trimTo(fields.campaign_id, 64) ?? '',
      campaign_name: trimTo(fields.campaign_name, 200),
      spend_sar: spendSar,
      clicks: posInt(fields.clicks),
      impressions: posInt(fields.impressions),
    });
    log({ evt: 'dash.spend', day, platform });
    return answer(res, { form, back: '/dashboard/spend?ok=1', status: 200, payload: { ok: true } });
  }

  /* -------------------- JSON views -------------------- */

  /** A list never carries a whole number; a record does. */
  const withMaskedPhone = (lead) => ({ ...lead, phone_e164: maskPhone(lead.phone_e164), phone_masked: true });
  const withFullPhone = (lead) => ({ ...lead, phone_masked: false });

  function adminStats({ res, url }) {
    const days = Math.max(1, Math.min(90, Number(url.searchParams.get('days')) || 14));
    return sendJson(res, 200, statistics.overview(days));
  }

  function adminLeads({ res, url }) {
    const stageParam = url.searchParams.get('stage');
    const stage = STAGES.includes(stageParam) ? stageParam : null;
    const q = String(url.searchParams.get('q') ?? '').slice(0, 100) || null;
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100));
    const rows = db.listLeads({ stage, q, limit });
    return sendJson(res, 200, { count: rows.length, total: db.countLeads({ stage }), leads: rows.map(withMaskedPhone) });
  }

  function adminLead({ res }, leadId) {
    const lead = db.getLead(leadId);
    if (!lead) return sendJson(res, 404, { error: 'not_found' });
    return sendJson(res, 200, {
      lead: withFullPhone(lead),
      journey: statistics.leadJourney(leadId),
      stage_history: db.stageHistory(leadId),
      touchpoints: db.touchpointsForLead(leadId),
    });
  }

  const adminListings = ({ res }) => sendJson(res, 200, { listings: listingRows() });

  /* -------------------- dispatch -------------------- */

  const LEAD_PATH = /^\/dashboard\/leads\/([A-Za-z0-9_-]{1,64})$/;
  const ADMIN_LEAD = /^\/v1\/admin\/leads\/([A-Za-z0-9_-]{1,64})(?:\/(stage|note))?$/;

  /** Does this request belong to us? Used by the server before anything else runs. */
  const owns = (p) => p === '/dashboard' || p.startsWith('/dashboard/') || p === '/v1/admin' || p.startsWith('/v1/admin/');

  async function handleHtml({ req, res, url, p, ip }) {
    /* --- login, the only pages reachable signed out --- */
    if (p === '/dashboard/login') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' });
      if (signedIn(req)) return redirect(res, '/dashboard', 302);
      return sendHtml(res, 200, loginView(req, url));
    }
    if (p === '/dashboard/login/code') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
      return loginCode({ req, res, ip });
    }
    if (p === '/dashboard/login/verify') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
      return loginVerify({ req, res, ip });
    }
    if (p === '/dashboard/logout') return logout({ req, res });

    /* --- everything else needs the cookie --- */
    if (!signedIn(req)) return toLogin(res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' });

    if (p === '/dashboard') return overview({ res, url });
    if (p === '/dashboard/leads') return leads({ res, url });
    const leadMatch = LEAD_PATH.exec(p);
    if (leadMatch) return leadDetail({ res, url }, leadMatch[1]);
    if (p === '/dashboard/listings') return listings({ res });
    if (p === '/dashboard/spend') return spend({ res, url });
    if (p === '/dashboard/integrations') return integrations({ res });
    return sendHtml(res, 404, messagePage({ title: 'Not found', message: 'There is no such page.' }));
  }

  async function handleAdmin({ req, res, url, p, ip }) {
    if (!signedIn(req)) return sendJson(res, 401, { error: 'unauthorised' });
    // A stated foreign origin on a route that answers with the owner's leads is refused
    // whatever the method — CORS would stop a browser reading it, but not a script that
    // is not a browser, and this costs nothing.
    if (!sameOrigin(req)) {
      log({ level: 'warn', evt: 'dash.origin_rejected', path: p, ip });
      return sendJson(res, 403, { error: 'forbidden_origin' });
    }

    const leadMatch = ADMIN_LEAD.exec(p);

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (p === '/v1/admin/stats') return adminStats({ res, url });
      if (p === '/v1/admin/leads') return adminLeads({ res, url });
      if (p === '/v1/admin/listings') return adminListings({ res });
      if (leadMatch && !leadMatch[2]) return adminLead({ res }, leadMatch[1]);
      return sendJson(res, 404, { error: 'not_found' });
    }

    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });

    const writes = (leadMatch && leadMatch[2]) || (p === '/v1/admin/spend' ? 'spend' : null);
    if (!writes) return sendJson(res, 404, { error: 'not_found' });

    const parsed = await fieldsOf(req);
    if (!parsed.ok) return sendJson(res, parsed.status, { error: parsed.error });
    if (!hasMarker(req, parsed.fields)) {
      log({ level: 'warn', evt: 'dash.marker_missing', path: p, ip });
      return sendJson(res, 403, { error: 'forbidden', message: 'X-Bona-Dash: 1 (or _dash=1) is required on a write' });
    }

    const ctx = { res, fields: parsed.fields, form: parsed.form };
    if (writes === 'stage') return setStage(ctx, leadMatch[1]);
    if (writes === 'note') return addNote(ctx, leadMatch[1]);
    return saveSpend(ctx);
  }

  /**
   * The entry point `index.mjs` mounts. Returns a promise that resolves once the
   * response has been written.
   */
  async function handle({ req, res, url, p, ip }) {
    if (!limiters.page.take(`dash:${ip}`).ok) return sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': '5' });
    try {
      if (p === '/v1/admin' || p.startsWith('/v1/admin/')) return await handleAdmin({ req, res, url, p, ip });
      return await handleHtml({ req, res, url, p, ip });
    } catch (err) {
      log({ level: 'error', evt: 'dash.failed', path: p, error: String(err?.message ?? err) });
      if (res.headersSent) return res.end();
      return sendJson(res, 500, { error: 'internal_error' });
    }
  }

  return { handle, owns, auth: authenticator, stats: statistics, esc };
}
