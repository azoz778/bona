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
 *   1. Every response carries `default-src 'none'`. An HTML page (P3-1) opens exactly
 *      four things to itself and nothing else: our own `/dashboard/app.js`, our own
 *      `/dashboard/sw.js`, fetches to this API and our own manifest. Nothing inline —
 *      `script-src 'self'` has no `'unsafe-inline'` — so a lead named `<script>` still
 *      has nowhere to run even if an escape were missed. JSON answers and redirects
 *      keep the plain `default-src 'none'`.
 *   2. What actually stops a cross-site write is `SameSite=Lax` — the cookie does not
 *      ride a cross-site POST at all — backed by the `Origin`/`Referer` check below.
 *      On top of that every write carries a marker: `X-Bona-Dash: 1` on a JSON call, a
 *      hidden `_dash=1` on a form. The header half is a real barrier (a cross-origin
 *      form cannot set one, and a `fetch` that does needs a preflight this API never
 *      answers for). The form field half is **not** a CSRF token — anyone can copy a
 *      hidden field — it is there so one code path serves both callers, and so a write
 *      that arrives without it is visibly not from one of our pages.
 *   3. `Origin` and `Referer`, when the browser states them, must be this API's own.
 *      Enforced on every `/v1/admin` request and on every dashboard write — but not on
 *      a dashboard page GET, because following a link from the site to the login is a
 *      normal way to arrive and would otherwise be refused.
 *
 * Phone numbers are masked everywhere a list is rendered and whole only on the one
 * page (and the one JSON route) that exists to show a single person's record.
 */
import { STAGES, tokenHash } from '../db.mjs';
import { createLimiter } from '../ratelimit.mjs';
import { enqueueStage } from '../fanout.mjs';
import { createStats, dayKey } from './stats.mjs';
import { createAuth } from './auth.mjs';
import { createTiktokAccounts, AccountsError } from '../tiktok-accounts.mjs';
import { tiktokAccountsPage, tiktokContinuePage, validateTiktokDraft } from './render-tiktok.mjs';
import { teamPage } from './render-team.mjs';
import { inboxPage, unsurePage, threadPage, INBOX_OK } from './render-inbox.mjs';
import { ASSETS } from './assets.mjs';
import { TeamError, isExcludedLead } from '../team.mjs';
import { createOrMergeLead } from '../leads.mjs';
import { normalisePhone } from '../phone.mjs';
import { randomId } from '../store.mjs';
import { replyJidFor } from '../wa-send.mjs';
import { OWNER_HISTORY_MS } from '../inbox/backfill.mjs';
import {
  knownError,
  loginPage, logoutPage, overviewPage, leadsPage, leadDetailPage, listingsPage, spendPage, integrationsPage, messagePage,
  maskPhone,
} from './render.mjs';

/** Set on every dashboard and admin response, HTML or JSON, success or failure. */
export const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  // `base-uri` does not inherit from `default-src`: without it an injected `<base>` would
  // redirect every root-relative link and form on the page.
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'",
  'X-Frame-Options': 'DENY',
  // `no-referrer` here is what broke the login: with no referrer at all Chrome sends
  // `Origin: null` on the login form's own same-origin POST, which is indistinguishable
  // from a sandboxed iframe and was refused. `same-origin` keeps the referrer off every
  // cross-site request — the reason the header is here — while still letting our own
  // pages identify themselves to our own endpoints.
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
};

/**
 * The CSP of an HTML page (design §5, P3-1): as locked as before, plus our own script, our
 * own service worker, fetches to ourselves (the pulse, the push subscription) and our own
 * manifest. Still no inline script: a lead's name that slipped past an escape cannot run.
 * JSON answers and redirects keep SECURITY_HEADERS' `default-src 'none'`.
 * `'self'` trusts every same-origin GET, so every route that answers a body must keep
 * `X-Content-Type-Options: nosniff`.
 */
export const PAGE_CSP = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; manifest-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'";
export const PAGE_SECURITY_HEADERS = { ...SECURITY_HEADERS, 'Content-Security-Policy': PAGE_CSP };
/** The service worker's own CSP: it loads nothing but the notification icon. */
const WORKER_CSP = "default-src 'none'; img-src 'self'";

export const MAX_NOTE = 2000;
/**
 * The reply route's body cap. A reply may be 4,096 characters (lib/wa-send.mjs
 * MAX_TEXT_LEN), and a form percent-encodes each one to at most nine bytes (a three-byte
 * UTF-8 character; a four-byte one is two of the 4,096): 36,864 bytes before the other
 * fields. Every other write keeps `cfg.maxBodyBytes`.
 */
export const REPLY_MAX_BODY_BYTES = 64 * 1024;
/**
 * How far past `REPLY_MAX_BODY_BYTES` a FORM reply is still read (and thrown away), so the
 * thread can be answered on a connection that stays. A refusal made mid-body has to close
 * the socket while the browser is still sending, and that close can cut the answer off —
 * a connection error instead of the page. Past this the rest is never read, and the
 * connection goes with the answer.
 */
export const REPLY_DRAIN_MAX_BYTES = 1024 * 1024;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `2026-09-08` and a date that exists. `9999-99-99` matches the shape and nothing else. */
export function isDay(value) {
  const s = String(value ?? '').trim();
  if (!DAY_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Does this request belong to the dashboard? Used by the server before anything else runs. */
const ownsDashboardPath = (p) => p === '/dashboard' || p.startsWith('/dashboard/') || p === '/v1/admin' || p.startsWith('/v1/admin/');

const isForm = (ct) => /^application\/x-www-form-urlencoded\s*(?:;|$)/i.test(String(ct ?? '').trim());
const isJson = (ct) => /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i.test(String(ct ?? '').trim());

const trimTo = (v, max) => {
  // A JSON caller can put an object where a string belongs; `String({})` would store
  // "[object Object]" as if the owner had typed it.
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).replace(/\r\n?/g, '\n').trim();
  return s ? s.slice(0, max) : null;
};
/** A JSON caller can send an object where a form field would be text; that is no text at all. */
const asText = (v) => (typeof v === 'string' ? v : '');
const posInt = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};
/**
 * The reply form's `seen_rev`: digits from a form, a number from JSON. Anything else is
 * NaN, which the sender reads as "cannot tell what you saw" and holds as stale.
 */
const asRev = (v) => {
  if (typeof v === 'number') return v;
  const s = typeof v === 'string' ? v.trim() : '';
  return /^\d{1,15}$/.test(s) ? Number(s) : NaN;
};

/**
 * Read a body with a hard cap; an oversized one is refused rather than buffered.
 *
 * With `drainTo` above `maxBytes`, a body over the cap but not past `drainTo` is still read
 * to its end — every byte past the cap thrown away — and refused only then, with
 * `drained: true`: nothing is left unread on the connection. Past `drainTo` (or with no
 * `drainTo`) reading stops at once and the refusal says `drained: false`.
 */
export function readBody(req, maxBytes, { drainTo = 0 } = {}) {
  const ceiling = Math.max(maxBytes, drainTo);
  const tooLarge = (drained) => Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE', drained });
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    let chunks = [];
    const onData = (chunk) => {
      size += chunk.length;
      if (size > ceiling) {
        req.off('data', onData);
        req.pause();
        reject(tooLarge(false));
        return;
      }
      if (size > maxBytes) {
        over = true;
        chunks = [];
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => (over ? reject(tooLarge(true)) : resolve(Buffer.concat(chunks).toString('utf8'))));
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
 * @param {ReturnType<import('../team.mjs').createTeam>} o.team   who may log in, and the Team page's data
 * @param {ReturnType<import('../audit.mjs').createAudit>} [o.audit]
 * @param {Function} [o.sendCode]                     the shared sender's `sendTo`, for login codes
 * @param {ReturnType<import('../inbox/store.mjs').createInboxStore>} [o.inbox]     the Bona inbox; without it the inbox pages are 404
 * @param {ReturnType<import('../wa-send.mjs').createSender>} [o.sender]             the one sender; its `reply` answers a chat
 * @param {ReturnType<import('../inbox/backfill.mjs').createBackfill>} [o.backfill]  per-chat Evolution reads: refresh, join history
 * @param {ReturnType<import('../alerts.mjs').createAlerts>} [o.alerts]              phone alerts (design §5); without it push is off and the pulse still works
 */
export function createDashboardRoutes({
  db, cfg = {}, inventory = null, fanout = null, app = null,
  sendWhatsApp = null, probeRetell = null,
  team = null, audit = null, sendCode = null,
  inbox = null, sender = null, backfill = null, alerts = null,
  auth = null, stats = null, tiktokAccounts = null, log = () => {}, now = () => Date.now(),
} = {}) {
  const statistics = stats ?? createStats({ db, now });
  const accounts = tiktokAccounts ?? createTiktokAccounts({ cfg, now });
  // Without the team store nobody can be identified. index.mjs always builds one (and
  // seeds the owner) before this runs, so a missing one is a wiring bug: say so at start-up
  // rather than serve a dashboard that can only ever refuse.
  if (!team) throw new TypeError('createDashboardRoutes needs the team store');
  const authenticator = auth ?? createAuth({ db, team, audit, cfg, sendCode, now, log });
  const maxBodyBytes = Number(cfg.maxBodyBytes ?? 16 * 1024);
  const limiters = {
    // The login is the one surface a stranger reaches, so guessing is capped separately
    // from the code sender (which `createAuth` limits by itself).
    verify: createLimiter({ capacity: 20, perMs: 60_000, now }),
    page: createLimiter({ capacity: 240, perMs: 60_000, now }),
  };

  /* -------------------- responses -------------------- */

  /** A page: the one kind of answer whose CSP opens our own script, worker, fetches and manifest (P3-1). */
  function sendHtml(res, status, html, extra = {}) {
    const body = Buffer.from(html, 'utf8');
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      ...PAGE_SECURITY_HEADERS,
      ...extra,
    });
    res.end(body);
  }

  /** One of the fixed app files (P3-2): public, GET/HEAD only, never cached. */
  function sendAsset(req, res, asset, p) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
    res.writeHead(200, {
      'Content-Type': asset.type,
      'Content-Length': asset.body.length,
      ...SECURITY_HEADERS,
      ...(p === '/dashboard/sw.js' ? { 'Content-Security-Policy': WORKER_CSP } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : asset.body);
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

  /**
   * Answer a body this route would not take.
   *
   * An oversized one is never finished being read, so the connection goes with the
   * answer: `Connection: close` makes Node end the socket once the 413 is out, rather
   * than leaving the unread remainder sitting on a keep-alive connection until the
   * request timeout clears it. The close is a FIN after the response — destroying the
   * socket outright would race the client's read of the very answer explaining why.
   */
  function refuseBody(req, res, parsed) {
    if (parsed.status === 413) return sendJson(res, 413, { error: parsed.error }, { Connection: 'close' });
    return sendJson(res, parsed.status, { error: parsed.error });
  }

  /** 303, so a re-load of the result page does not re-post the form. */
  function redirect(res, location, status = 303, extra = {}) {
    res.writeHead(status, { Location: location, 'Content-Length': '0', ...SECURITY_HEADERS, ...extra });
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
    // `Origin` is authoritative when the browser sends it, which it does on every
    // cross-origin POST. `Origin: null` — a sandboxed iframe, a `data:` URL — is not
    // one of ours, so it is refused like any other foreign origin. `SameSite=Lax`
    // would keep the cookie off those requests anyway; this is the check not
    // depending on it.
    //
    // This is only safe to state that plainly because `Referrer-Policy` is now
    // `same-origin`. Under `no-referrer` Chrome sent `Origin: null` on the login
    // form's OWN same-origin POST — the browser has no referrer to derive an origin
    // from — so the owner's real login was indistinguishable from a sandboxed frame
    // and was refused. Verified in a real browser: `no-referrer` produced
    // `Origin: null`, `same-origin` produced the page's own origin.
    const origin = req.headers.origin;
    if (origin !== undefined) return own.has(String(origin).trim().replace(/\/+$/, ''));
    // No `Origin` header at all — some browsers omit it on a same-site form POST. A
    // `Referer` naming a different site is still evidence of a cross-site post; an
    // unparseable one is not evidence of anything, and the cookie and the write
    // marker still stand behind this check.
    const referer = req.headers.referer;
    if (!referer) return true;
    try { return own.has(new URL(referer).origin); } catch { return true; }
  }

  /**
   * The write marker. See the module header for what it is and is not worth: the header
   * form is a barrier, the hidden field is not a token. A proxy that adds the header to
   * one that is already there hands us `"1, 1"`, so only the first value is read.
   */
  const hasMarker = (req, fields) =>
    String(req.headers['x-bona-dash'] ?? '').split(',')[0].trim() === '1' ||
    String(fields?._dash ?? '') === '1';

  const sessionToken = (req) => authenticator.readCookie(req);
  /**
   * The active member behind this request's cookie, or null. `check()` reads the
   * `users` row every time, so a deactivated person is out on their very next request.
   */
  const currentUser = (req) => {
    const token = sessionToken(req);
    return token ? authenticator.check(token) : null;
  };
  const signedIn = (req) => Boolean(currentUser(req));

  /**
   * Read and parse a write body. `drainFormTo` applies to a form body only (readBody's
   * `drainTo`); a JSON one over `maxBytes` is always left unread.
   * @returns {{ ok: true, fields: object, form: boolean } | { ok: false, status: number, error: string, form?: boolean, drained?: boolean }}
   */
  async function fieldsOf(req, maxBytes = maxBodyBytes, { drainFormTo = 0 } = {}) {
    const ct = req.headers['content-type'];
    const form = isForm(ct);
    if (!form && !isJson(ct)) return { ok: false, status: 415, error: 'unsupported_media_type' };
    let text;
    try {
      text = await readBody(req, maxBytes, { drainTo: form ? drainFormTo : 0 });
    } catch (err) {
      if (err?.code === 'BODY_TOO_LARGE') return { ok: false, status: 413, error: 'payload_too_large', form, drained: err.drained === true };
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
    if (!parsed.ok) return refuseBody(req, res, parsed);
    const out = await authenticator.requestCode({ phone: parsed.fields.phone, ip });
    if (!out.ok) {
      // A number that is not a number goes back to the first step to be retyped; a limit
      // stays on the code step (a code may already be on its way).
      const step = out.error === 'bad_phone' ? '' : 'step=code&';
      return toLogin(res, `?${step}error=${encodeURIComponent(out.error)}`, 303);
    }
    // The nonce is what lets this browser — and only this browser — spend the code's
    // five attempts. See the header of `auth.mjs`.
    authenticator.setTryCookie(res, out.nonce);
    return toLogin(res, '?step=code&sent=1', 303);
  }

  async function loginVerify({ req, res, ip }) {
    if (!sameOrigin(req)) {
      log({ level: 'warn', evt: 'dash.origin_rejected', path: '/dashboard/login/verify', ip });
      return toLogin(res, '?step=code&error=forbidden', 303);
    }
    if (!limiters.verify.take(`dashverify:${ip}`).ok) return toLogin(res, '?step=code&error=rate_limited', 303);
    const parsed = await fieldsOf(req);
    if (!parsed.ok) return refuseBody(req, res, parsed);

    const ua = String(req.headers['user-agent'] ?? '').slice(0, 300) || null;
    const out = authenticator.verify(parsed.fields.code, ua, { nonce: authenticator.readTryCookie(req) });
    if (!out.ok) {
      // A burnt or spent code is finished; take its nonce with it rather than leaving a
      // cookie that can only ever produce the same refusal.
      if (out.error === 'attempts' || out.error === 'used' || out.error === 'expired') authenticator.clearTryCookie(res);
      return toLogin(res, `?step=code&error=${encodeURIComponent(out.error)}`, 303);
    }
    authenticator.clearTryCookie(res);
    authenticator.setCookie(res, out.token);
    return redirect(res, '/dashboard');
  }

  /**
   * Logging out ends a session on the server, so it is a POST behind the same marker
   * and origin check as every other write. `SameSite=Lax` sends the cookie on a
   * top-level GET navigation, which would have let any page on the internet log the
   * owner out with a link; the GET here only offers the button.
   */
  async function logout({ req, res, ip }) {
    if (!sameOrigin(req)) {
      log({ level: 'warn', evt: 'dash.origin_rejected', path: '/dashboard/logout', ip });
      return toLogin(res, '?error=forbidden', 303);
    }
    const parsed = await fieldsOf(req);
    if (!parsed.ok) return refuseBody(req, res, parsed);
    if (!hasMarker(req, parsed.fields)) return toLogin(res, '?error=forbidden', 303);
    const token = sessionToken(req);
    if (token) {
      // This device's alerts end with its session (P3-5); the member's other devices keep
      // theirs. The subscriptions are keyed by the session's hash, never the token itself.
      alerts?.forgetSession(tokenHash(token));
      authenticator.logout(token, currentUser(req));
    }
    authenticator.clearCookie(res);
    authenticator.clearTryCookie(res);
    return toLogin(res, '', 303);
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
      { label: 'TikTok Accounts — app id', present: Boolean(cfg.tiktokAccountsAppId) },
      { label: 'TikTok Accounts — app secret', present: Boolean(cfg.tiktokAccountsAppSecret) },
      { label: 'TikTok Accounts — authorization URL', present: Boolean(cfg.tiktokAccountsAuthUrl) },
      { label: 'TikTok — Pixel ID', present: Boolean(cfg.tiktokPixelId) },
      { label: 'TikTok — Events API token', present: Boolean(cfg.tiktokEventsToken) },
      { label: 'TikTok — test mode', present: Boolean(cfg.tiktokTestEventCode), note: cfg.tiktokTestEventCode ? 'Test events only; remove code before production measurement' : 'No test code' },
      { label: 'Retell — API key', present: Boolean(cfg.retellApiKey) },
      { label: 'Retell — tool token', present: Boolean(cfg.toolToken) },
      { label: 'Evolution — owner WhatsApp', present: Boolean(env.EVOLUTION_API_URL && env.EVOLUTION_API_KEY), note: 'sends the login code and the lead notes' },
      { label: 'Phone alerts — VAPID keys', present: Boolean(alerts?.configured), note: 'generated once on the VPS by bin/vapid-keys.mjs' },
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
    for (const dest of ['meta', 'ga4', 'snap', 'tiktok']) {
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
      // The real poller (lib/wa-poller.mjs) reports `status()` with `lagS` in seconds; an older
      // or injected shape may offer `health()` with `lag` in milliseconds. Read either.
      const raw = typeof poller.status === 'function' ? poller.status()
        : typeof poller.health === 'function' ? poller.health() : poller;
      const health = raw && typeof raw === 'object' && raw.lagS !== undefined && raw.lag === undefined
        ? { ...raw, lag: raw.lagS === null ? null : raw.lagS * 1000 } : raw;
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
    const dests = (() => { try { return fanout?.dests?.() ?? { meta: false, ga4: false, snap: false, tiktok: false }; } catch { return { meta: false, ga4: false, snap: false, tiktok: false }; } })();
    return { counts, dests };
  }

  /* -------------------- who sees which lead -------------------- */
  //
  // An owner sees every lead. Anyone else sees only the leads of the Bona inbox: `in`, and
  // not under a colleague's or a never-list number (lib/team.mjs `isExcludedLead`). Every
  // other lead — a guess on the Unsure list, "not a client", one nobody has placed yet, a
  // TK or private chat that is a lead only for the statistics — is to them a lead that does
  // not exist: on no list, in no count, and 404 on its page, its JSON and its stage and
  // note writes. Its touchpoints keep the first message's snippet, so they are never shown
  // either. The aggregates (charts, sources, pipeline counts, response times) stay as they
  // are: numbers, with no person in them.

  const ownerSees = (me) => me?.role === 'owner';
  /** A lead of the Bona inbox: the only kind a staff member sees. */
  const inBonaInbox = (lead) => Boolean(lead) && lead.inbox_state === 'in' && !isExcludedLead(team, db, lead);
  /** The lead as `me` may see it, else null — the same null as a lead that does not exist. */
  function leadFor(me, leadId) {
    const lead = db.getLead(leadId);
    return lead && (ownerSees(me) || inBonaInbox(lead)) ? lead : null;
  }
  /** Rows per read of a staff member's filtered list: the most `waitingLeads` gives at once. */
  const STAFF_PAGE = 500;
  /**
   * Every lead `page` gives that a staff member may see, in its order: `in` leads from SQL,
   * each then put to the exclusion test, read to the end so a count is a count, not a slice.
   * @param {(o: { inboxState: 'in', limit: number, offset: number }) => object[]} page
   */
  function staffRows(page) {
    const out = [];
    for (let offset = 0; ; offset += STAFF_PAGE) {
      const rows = page({ inboxState: 'in', limit: STAFF_PAGE, offset });
      for (const lead of rows) if (inBonaInbox(lead)) out.push(lead);
      if (rows.length < STAFF_PAGE) return out;
    }
  }

  /* -------------------- HTML pages -------------------- */

  function overview({ res, url, me }) {
    const days = Math.max(1, Math.min(90, Number(url.searchParams.get('days')) || 14));
    // Every section is fetched defensively: one failing aggregate must not take the
    // whole desk page down, and the queue at the top is the part the owner actually
    // needs. `waitingTotal` is a real COUNT(*) — `waiting` is capped at 50, so its
    // length is a slice and must never be rendered as the headline number. A staff
    // member's queue is the Bona inbox's leads only, counted row by row.
    const safe = (label, fn, fallback) => {
      try {
        return fn();
      } catch (err) {
        log({ level: 'warn', evt: 'dash.section_failed', section: label, error: String(err?.message ?? err).slice(0, 200) });
        return fallback;
      }
    };
    const staffWaiting = ownerSees(me) ? null : safe('waiting', () => staffRows((o) => db.waitingLeads(o)), null);
    return sendHtml(res, 200, overviewPage({
      days,
      daily: safe('daily', () => statistics.overviewDaily(days), []),
      sources: safe('sources', () => statistics.sources(), []),
      matchQuality: safe('matchQuality', () => statistics.matchQuality(), []),
      pipeline: safe('pipeline', () => statistics.pipeline(), []),
      responseTimes: safe('responseTimes', () => statistics.responseTimes(), { median_min: null, p90_min: null, count: 0 }),
      waiting: ownerSees(me) ? safe('waiting', () => db.waitingLeads({ limit: 50 }), []) : (staffWaiting ?? []).slice(0, 50),
      waitingTotal: ownerSees(me) ? safe('waitingTotal', () => db.countWaitingLeads(), null) : (staffWaiting?.length ?? null),
      now: now(),
      me,
    }));
  }

  /** Cards per column. The counts beside them are a COUNT(*), never this slice. */
  const BOARD_CARDS = 500;

  function leads({ res, url, me }) {
    const stage = STAGES.includes(url.searchParams.get('stage')) ? url.searchParams.get('stage') : '';
    const q = String(url.searchParams.get('q') ?? '').slice(0, 100);
    const board = Object.fromEntries(STAGES.map((s) => [s, []]));
    // A staff member's board, list and total are the Bona inbox's leads only; the stage
    // counts are the pipeline's aggregate for everyone.
    const mine = ownerSees(me) ? null : staffRows((o) => db.listLeads(o));
    for (const lead of mine ? mine.slice(0, BOARD_CARDS) : db.listLeads({ limit: BOARD_CARDS })) board[lead.stage]?.push(lead);
    // The cards are the newest few hundred leads; the number on the column heading is the
    // truth. A count that quietly becomes a slice is worse than a slow page.
    const counts = Object.fromEntries(statistics.pipeline().map((p) => [p.stage, p.count]));
    const filter = { stage: stage || null, q: q || null };
    return sendHtml(res, 200, leadsPage({
      board,
      counts,
      leads: mine ? staffRows((o) => db.listLeads({ ...o, ...filter })).slice(0, 200) : db.listLeads({ ...filter, limit: 200 }),
      stage, q, now: now(), total: mine ? mine.length : db.countLeads(),
      me,
    }));
  }

  function leadDetail({ res, url, me }, leadId) {
    const lead = leadFor(me, leadId);
    if (!lead) return sendHtml(res, 404, messagePage({ title: 'Not found', message: 'No lead with that id.', me }));
    const saved = url.searchParams.get('ok');
    const error = url.searchParams.get('error');
    return sendHtml(res, 200, leadDetailPage({
      lead,
      journey: statistics.leadJourney(leadId),
      saved: saved === 'stage' || saved === 'note' ? saved : null,
      error: knownError(error),
      now: now(),
      me,
    }));
  }

  const listings = ({ res, me }) => sendHtml(res, 200, listingsPage({ rows: listingRows(), me }));

  /** How much of the spend ledger the page shows. The CPL table is unbounded and cheap. */
  const SPEND_WINDOW_DAYS = 90;

  function spend({ res, url, me }) {
    const today = dayKey(now());
    const fallbackFrom = dayKey(now() - SPEND_WINDOW_DAYS * 86_400_000);
    const requestedFrom = url.searchParams.get('from');
    const requestedTo = url.searchParams.get('to');
    let fromDay = isDay(requestedFrom) ? requestedFrom : fallbackFrom;
    let toDay = isDay(requestedTo) ? requestedTo : today;
    if (fromDay > toDay) [fromDay, toDay] = [toDay, fromDay];
    return sendHtml(res, 200, spendPage({
      rows: db.listSpend({ fromDay, toDay }).reverse(),
      windowDays: SPEND_WINDOW_DAYS,
      campaigns: statistics.cplByCampaign(),
      roi: statistics.roi({ fromDay, toDay }),
      fromDay,
      toDay,
      saved: url.searchParams.get('ok') === '1',
      error: knownError(url.searchParams.get('error')),
      today,
      me,
    }));
  }

  async function integrations({ res, me }) {
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
      me,
    }));
  }

  function teamView({ res, url, me }) {
    if (me.role !== 'owner') return sendHtml(res, 403, messagePage({ title: 'Owners only', message: 'Only an owner can open the Team page.', me }));
    return sendHtml(res, 200, teamPage({
      me,
      users: team.listUsers(),
      never: team.listNever(),
      sendingEnabled: team.sendingEnabled(),
      repliesEnabled: team.repliesEnabled(),
      danaEnabled: team.danaEnabled(),
      danaConfigured: Boolean(app?.dana?.configured),
      ok: url.searchParams.get('ok'),
      error: url.searchParams.get('error'),
    }));
  }

  async function tiktokCallback({ req, res, url }) {
    const noRef = { 'Referrer-Policy': 'no-referrer' };
    if (req.method !== 'GET') return sendHtml(res, 405, messagePage({ title: 'Invalid callback', message: 'Use the owner authorization flow.' }), noRef);
    const me = currentUser(req);
    let canonicalHost;
    try { canonicalHost = new URL(cfg.publicApi).host; } catch { /* fail closed */ }
    if (url.pathname !== '/dashboard/tiktok/callback/' || !me || me.role !== 'owner' || req.headers.host !== canonicalHost || !url.searchParams.has('state'))
      return sendHtml(res, 400, messagePage({ title: 'Authorization not completed', message: 'Start from the signed-in owner TikTok setup page. This callback does not accept unsolicited authorization codes.' }), noRef);
    try {
      await accounts.finish({ params: url.searchParams, session: sessionToken(req) });
      return redirect(res, '/dashboard/tiktok?ok=connected', 303, noRef);
    } catch (err) {
      const code = err instanceof AccountsError ? err.code : 'provider_failed';
      // Do not log the request URL, code, state, token or provider exception.
      return redirect(res, `/dashboard/tiktok?error=${encodeURIComponent(code)}`, 303, noRef);
    }
  }
  async function tiktokWrite({ req, res, me, fields }, operation) {
    if (operation === 'preview') return sendHtml(res, 200, tiktokAccountsPage({ me, state: accounts.status(), draft: validateTiktokDraft(fields, cfg.siteUrl, now()) }));
    try {
      if (operation === 'connect') return sendHtml(res, 200, tiktokContinuePage({ me, authorizationUrl: accounts.begin(sessionToken(req)) }), { 'Referrer-Policy': 'no-referrer' });
      if (operation === 'forget' && fields.confirm !== 'remove-local-grant') return sendJson(res, 400, { error: 'confirmation_required' });
      await accounts[operation]();
      return redirect(res, `/dashboard/tiktok?ok=${operation === 'refresh' ? 'refreshed' : operation === 'forget' ? 'forgotten' : 'revoked'}`);
    } catch (err) {
      const code = err instanceof AccountsError ? err.code : 'provider_failed';
      return redirect(res, `/dashboard/tiktok?error=${encodeURIComponent(code)}`);
    }
  }

  /* -------------------- writes -------------------- */

  /**
   * A form post came from one of our own pages and must land back on it; a JSON call
   * wants JSON. One helper so every write answers both callers correctly.
   */
  const answer = (res, { form, back, status, payload }) =>
    (form ? redirect(res, back) : sendJson(res, status, payload));

  function setStage({ res, fields, form, me }, leadId) {
    const lead = leadFor(me, leadId);
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

    const history = db.setStage(leadId, stage, { actor: me.name, note, valueSar, now: t });
    const updated = db.getLead(leadId);
    // The ad platforms hear about the moves they can bid on; the rest is just history.
    // The worker's bound method and the bare function are the same code — `fanout` is
    // optional in this factory only so a test can construct routes without a worker.
    const queue = fanout?.enqueueStage ?? ((lead, opts) => enqueueStage(db, lead, opts));
    const queued = queue(updated, { stage, valueSar: updated.value_sar, now: t });
    log({ evt: 'dash.stage', leadId, stage, dests: queued.dests });
    audit?.record({ userId: me.user_id, action: 'stage', target: leadId, meta: { stage } });

    return answer(res, {
      form, back: `${back}?ok=stage`, status: 200,
      payload: { ok: true, lead: withFullPhone(updated), stage: history, event_id: queued.event.event_id, dests: queued.dests },
    });
  }

  function addNote({ res, fields, form, me }, leadId) {
    const lead = leadFor(me, leadId);
    const back = `/dashboard/leads/${encodeURIComponent(leadId)}`;
    if (!lead) return answer(res, { form, back: '/dashboard/leads', status: 404, payload: { error: 'not_found' } });
    const note = trimTo(fields.note, MAX_NOTE);
    if (!note) return answer(res, { form, back: `${back}?error=empty_note`, status: 400, payload: { error: 'empty_note' } });

    const t = now();
    const touchpoint = db.transaction(() => {
      const tp = db.addTouchpoint({
        lead_id: leadId, ts: t, channel: 'manual', event_type: 'note',
        listing_id: lead.listing_id ?? null, meta: { note, actor: me.name, actor_id: me.user_id },
      });
      // Kept on the lead as well as in the journey: the owner's WhatsApp brief reads
      // `notes`, and a note nobody sees again is not worth typing.
      db.updateLead(leadId, { notes: lead.notes ? `${lead.notes}\n${note}` : note, updated: t });
      return tp;
    });
    log({ evt: 'dash.note', leadId });
    audit?.record({ userId: me.user_id, action: 'note', target: leadId });
    return answer(res, { form, back: `${back}?ok=note`, status: 200, payload: { ok: true, touchpoint_id: touchpoint.id } });
  }

  // `me` is accepted but not used yet: spend changes are audited with Phase 5's reports.
  function saveSpend({ res, fields, form, me: _me }) {
    const day = String(fields.day ?? '').trim();
    const platform = trimTo(fields.platform, 32)?.toLowerCase() ?? null;
    const spendSar = Number(fields.spend_sar);
    const bad = !isDay(day) || !platform || !Number.isFinite(spendSar) || spendSar < 0;
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

  function adminLeads({ res, url, me }) {
    const stageParam = url.searchParams.get('stage');
    const stage = STAGES.includes(stageParam) ? stageParam : null;
    const q = String(url.searchParams.get('q') ?? '').slice(0, 100) || null;
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100));
    if (!ownerSees(me)) {
      // `total` counts by stage alone, as the owner's does; both only what staff may see.
      const rows = staffRows((o) => db.listLeads({ ...o, stage, q }));
      const total = q ? staffRows((o) => db.listLeads({ ...o, stage })).length : rows.length;
      const shown = rows.slice(0, limit);
      return sendJson(res, 200, { count: shown.length, total, leads: shown.map(withMaskedPhone) });
    }
    const rows = db.listLeads({ stage, q, limit });
    return sendJson(res, 200, { count: rows.length, total: db.countLeads({ stage }), leads: rows.map(withMaskedPhone) });
  }

  function adminLead({ res, me }, leadId) {
    const lead = leadFor(me, leadId);
    if (!lead) return sendJson(res, 404, { error: 'not_found' });
    return sendJson(res, 200, {
      lead: withFullPhone(lead),
      journey: statistics.leadJourney(leadId),
      stage_history: db.stageHistory(leadId),
      touchpoints: db.touchpointsForLead(leadId),
    });
  }

  const adminListings = ({ res }) => sendJson(res, 200, { listings: listingRows() });

  /* -------------------- team (owner only) -------------------- */

  // The audit log records WHO acted and on WHICH id — never a phone number, a name or a
  // note: those live in `users` / `never_list`, and the log is not a second copy of them.
  const teamBack = (query) => `/dashboard/team?${query}`;
  function teamWrite({ res, form }, fn, okKey) {
    try {
      fn();
      return answer(res, { form, back: teamBack(`ok=${okKey}`), status: 200, payload: { ok: true } });
    } catch (err) {
      if (!(err instanceof TeamError)) throw err;
      return answer(res, {
        form, back: teamBack(`error=${encodeURIComponent(err.code)}`),
        status: err.code === 'not_found' || err.code === 'never_not_found' ? 404 : 400, payload: { error: err.code },
      });
    }
  }

  /**
   * A number that has just become a colleague's or a never-list one is never a client
   * (§3.5, P2-7): the chat stored under it, if any, leaves the inbox and its transcript
   * goes now, not at the next daily upkeep, and it leaves the owner's list of real-estate
   * chats to check (D17). Audited by lead id only. Built without the inbox (older tests,
   * tools), there is nothing stored to take out.
   */
  function leaveInboxFor(digits, me) {
    if (!inbox || !digits) return;
    inbox.removeCandidatesFor({ phone: digits, jid: `${digits}@s.whatsapp.net` });
    const lead = db.getLeadByPhone(digits) ?? db.getLeadByJid(`${digits}@s.whatsapp.net`);
    if (!lead || lead.inbox_state === 'out') return;
    inbox.leaveInbox(lead.lead_id);
    audit?.record({ userId: me.user_id, action: 'inbox_out', target: lead.lead_id });
  }

  function addPerson(ctx) {
    const { fields, me } = ctx;
    return teamWrite(ctx, () => {
      const u = team.addUser({ name: asText(fields.name), phone: asText(fields.phone), role: fields.role === 'owner' ? 'owner' : 'staff' });
      audit?.record({ userId: me.user_id, action: 'team_add', target: u.user_id, meta: { role: u.role } });
      leaveInboxFor(u.phone_e164, me);
    }, 'added');
  }

  /**
   * An owner can act on any account but their own, for the two moves that would take
   * their own access away — deactivating themselves or dropping their own role to
   * `staff`. This holds even with a second (or third) active owner in the room: the
   * point is not "would this leave zero owners" (`team.mjs`'s `last_owner` already
   * covers that) but "an owner's own access is someone else's to remove, never their
   * own click" — ask another owner, on purpose, rather than one mis-tap.
   */
  function guardSelfChange(userId, what, role, me) {
    if (userId !== me.user_id) return;
    if (what === 'deactivate' || (what === 'role' && role !== 'owner')) throw new TeamError('self_change');
  }

  function changePerson(ctx, userId, what) {
    const { fields, me } = ctx;
    const role = what === 'role' ? asText(fields.role) : null;
    return teamWrite(ctx, () => {
      guardSelfChange(userId, what, role, me);
      if (what === 'deactivate') {
        team.deactivateUser(userId);
        audit?.record({ userId: me.user_id, action: 'team_deactivate', target: userId });
        return;
      }
      if (what === 'reactivate') {
        team.reactivateUser(userId);
        audit?.record({ userId: me.user_id, action: 'team_reactivate', target: userId });
        return;
      }
      team.setRole(userId, role);
      audit?.record({ userId: me.user_id, action: 'team_role', target: userId, meta: { role } });
    }, what === 'deactivate' ? 'deactivated' : what === 'reactivate' ? 'reactivated' : 'role');
  }

  function neverWrite(ctx, remove) {
    const { fields, me } = ctx;
    if (remove) {
      return teamWrite(ctx, () => {
        const removed = team.removeNever(asText(fields.phone));
        if (!removed) throw new TeamError('never_not_found');
        audit?.record({ userId: me.user_id, action: 'never_remove' });
      }, 'never_removed');
    }
    return teamWrite(ctx, () => {
      const row = team.addNever({ phone: asText(fields.phone), note: asText(fields.note), by: me.user_id });
      audit?.record({ userId: me.user_id, action: 'never_add' });
      leaveInboxFor(row.phone_e164, me);
    }, 'never_added');
  }

  /** The owner's switches, as the Team page posts them: one per form. */
  const SWITCHES = ['sending_enabled', 'inbox_replies', 'dana_enabled'];

  function saveSetting(ctx) {
    const { fields, me } = ctx;
    return teamWrite(ctx, () => {
      // Exactly one switch per post, the way the Team page's buttons send it: none, or
      // two at once, is refused rather than guessed at.
      const keys = SWITCHES.filter((k) => Object.hasOwn(fields, k));
      if (keys.length !== 1) throw new TeamError('bad_setting');
      const [key] = keys;
      // Fails closed: `asText` turns anything that is not literally a string (a JSON
      // `false`, `null`, a number) into `''`, and `team.setSetting` itself refuses any
      // value outside `SETTINGS_ALLOWED` — including `''`, `"off"`, `"true"` — before
      // it ever reaches the row. Coercing here (the old `=== '0' ? '0' : '1'`) would
      // have defeated that check by handing it only ever '0' or '1' to approve.
      const value = asText(fields[key]);
      team.setSetting(key, value, { by: me.user_id });
      audit?.record({ userId: me.user_id, action: 'setting', target: key, meta: { value } });
    }, 'setting');
  }

  /* -------------------- the Bona inbox -------------------- */
  //
  // Phase 2 of the 2026-09-27 design (§4). Three rules hold on every route here; the
  // sender (lib/wa-send.mjs `reply`) checks the send-side ones again on its own:
  //
  //   1. A chat can be read or answered only while it is `in`, has a WhatsApp jid or lid
  //      (P2-1), and its number is neither a team member's nor on the never list (§3.5,
  //      P2-7). Anything else is the same 404, so no page tells anyone which numbers are
  //      guesses, private, or colleagues.
  //   2. Message text stays on the page it was typed on. A refused reply is drawn again
  //      with the words still in the box (P2-9); a redirect, the audit log and the
  //      process log carry ids and outcomes — never words, never numbers.
  //   3. The Unsure list, Move, Not a client and Add by phone are the owner's (D9).

  /** A colleague's or a never-list number, however the lead row holds it (lib/team.mjs). */
  const excludedLead = (lead) => isExcludedLead(team, db, lead);

  /** Rule 1: the one test every inbox read and write goes through first. */
  const openChat = (lead) => Boolean(lead && lead.inbox_state === 'in' && (lead.wa_jid || lead.wa_lid) && !excludedLead(lead));

  /**
   * The push key rides on `me` (P3-13): the VAPID public key when push is configured,
   * nothing otherwise. `layout` prints it as a meta tag for app.js; the inbox list draws
   * its Phone alerts panel only when it is there. Public by design — it is what every
   * browser hands the push service — so it is no secret on a page.
   */
  const withKey = (u) => (alerts?.configured ? { ...u, pushKey: alerts.publicKey } : u);

  /**
   * The signed-in person as a page draws them: their row plus `unread`, the Inbox badge,
   * and `pushKey`. The badge is summed over the very rows the inbox list shows, so it never
   * counts a chat rule 1 hides (the store's `unreadTotal` knows nothing of the team or the
   * never list). Unread chats sort first, so the list's cap only ever leaves out chats that
   * add 0. Built without the inbox (older tests, tools), the row stays as it was. A count
   * that fails is a missing badge, never a page that will not open.
   */
  function withUnread(user) {
    if (!inbox) return withKey(user);
    try {
      const rows = inbox.listInbox({ userId: user.user_id, userCreated: user.created ?? 0, limit: 1000 }).filter((l) => !excludedLead(l));
      return withKey({ ...user, unread: rows.reduce((n, r) => n + (Number(r.unread) || 0), 0) });
    } catch (err) {
      log({ level: 'warn', evt: 'dash.unread_failed', error: String(err?.message ?? err).slice(0, 200) });
      return withKey({ ...user, unread: 0 });
    }
  }

  /** `?ok=` codes the inbox pages know; own properties only, like `knownError`. */
  const inboxOk = (v) => (typeof v === 'string' && Object.hasOwn(INBOX_OK, v) ? v : null);
  const noSuchPage = (res, me) => sendHtml(res, 404, messagePage({ title: 'Not found', message: 'There is no such page.', me }));
  const notInInbox = (res, me) => sendHtml(res, 404, messagePage({ title: 'Not in the inbox', message: 'That chat is not in the Bona inbox.', me }));
  /** Rule 1's refusal for both callers: a form gets the page, JSON gets the code. */
  const refuseChat = (res, form, me) => (form ? notInInbox(res, withUnread(me)) : sendJson(res, 404, { error: 'not_in_inbox' }));
  /** One reply form's id: 24 hex characters, inside wa-send's SEND_ID_RE. */
  const newSendId = () => randomId(12);

  /**
   * Fetch the chat from WhatsApp before it is drawn or answered (P2-10), so a reply is
   * checked against what is really there rather than the last poll. The backfill bounds
   * it (amendment A2) and promises never to throw; this catch is for one that breaks the
   * promise. Either way a slow Evolution leaves the page with what is already stored.
   */
  async function refreshChat(lead) {
    if (!backfill) return;
    try {
      await backfill.refresh(lead);
    } catch (err) {
      log({ level: 'warn', evt: 'dash.refresh_failed', leadId: lead.lead_id, error: String(err?.message ?? err).slice(0, 200) });
    }
  }

  /** The owner vouched for this chat, so it brings its last 30 days (design §4.1). */
  async function joinHistory(leadId, t) {
    if (!backfill) return;
    try {
      await backfill.history(db.getLead(leadId), { sinceTs: t - OWNER_HISTORY_MS, untilTs: t });
    } catch (err) {
      log({ level: 'warn', evt: 'dash.history_failed', leadId, error: String(err?.message ?? err).slice(0, 200) });
    }
  }

  /**
   * A thread draws at least this many messages, every message from the oldest unread one
   * on plus this much before them, and never more than the most.
   */
  const THREAD_MESSAGES = 200;
  const THREAD_CONTEXT = 20;
  const THREAD_MOST = 1000;

  /**
   * Draw one chat and mark it read — up to the newest message the page drew, never "now":
   * a message the poller stores a moment later with an earlier WhatsApp timestamp must
   * still count as unread. `seenRev`, the chat's revision read with the messages drawn (no
   * await between them), rides in the form for the sender's stale-view guard; `seenTs`,
   * the newest message drawn, is the read mark and rides along too.
   *
   * Every unread message is drawn, not only the newest 200: the newest max(200, span + 20)
   * messages, at most 1,000, where the span is every message, both directions, from this
   * person's oldest unread one on — replies between unread messages take room on the page
   * too. The page says how many older ones it leaves out.
   */
  function renderThread(res, { status = 200, user, lead, draft = '', ok = null, error = null }) {
    const span = inbox.unreadSpan(lead.lead_id, { userId: user.user_id, userCreated: user.created ?? 0 });
    const messages = inbox.messagesFor(lead.lead_id, { limit: Math.min(THREAD_MOST, Math.max(THREAD_MESSAGES, span + THREAD_CONTEXT)) });
    const seenRev = inbox.revision(lead.lead_id);
    const hidden = Math.max(0, inbox.countMessages(lead.lead_id) - messages.length);
    const seenTs = messages.reduce((max, m) => (Number(m.ts) > max ? Number(m.ts) : max), 0);
    if (seenTs) inbox.markRead(user.user_id, lead.lead_id, seenTs);
    return sendHtml(res, status, threadPage({
      me: withUnread(user),
      lead,
      messages,
      hidden,
      gaps: inbox.gapsFor(lead.lead_id),
      outbox: inbox.openOutboxFor(lead.lead_id),
      // Everyone, not only the active: a reply keeps its author's name after they leave.
      // threadPage offers only active people as handlers.
      users: team.listUsers(),
      sendId: newSendId(),
      seenTs,
      seenRev,
      sendingEnabled: team.sendingEnabled(),
      canReply: replyJidFor(lead) !== null,
      repliesEnabled: team.repliesEnabled(),
      danaEnabled: team.danaEnabled(),
      danaConfigured: Boolean(app?.dana?.configured),
      draft,
      ok: inboxOk(ok),
      error: knownError(error),
      now: now(),
      // The same revision the reply form's stale guard carries: what the pulse compares (P3-12).
      pulseToken: String(seenRev),
    }));
  }

  /**
   * A real-estate chat to check (D17) whose number is a colleague's or a never-list one is
   * on no list and in no count, like a lead rule 1 hides: the store knows no team.
   */
  const excludedCandidate = (c) => excludedLead({ phone_e164: c.phone_e164, wa_jid: c.jid, wa_lid: c.lid });
  /**
   * The lead a chat to check has become since it was noted (a web form, *Add chat by phone
   * number* …), if any: that lead's own inbox state decides the chat from then on.
   */
  const leadOfCandidate = (c) => (c.phone_e164 ? db.getLeadByPhone(c.phone_e164) : null)
    ?? (c.jid ? db.getLeadByJid(c.jid) : null) ?? (c.lid ? db.getLeadByJid(c.lid) : null);
  /** The most chats to check the Unsure tab lists, and counts: one list for both. */
  const CANDIDATES_SHOWN = 200;
  /**
   * The owner's real-estate chats to check, as his Unsure tab lists and counts them. The
   * store already leaves out, in SQL, a chat that has become a lead; a colleague's or a
   * never-list number is left out here (one team check per row, at most 200 rows).
   */
  const candidatesShown = () => inbox.listCandidates({ limit: CANDIDATES_SHOWN }).filter((c) => !excludedCandidate(c));

  /** The Inbox list's rows for one person, in the list's own order, with rule 1 applied. */
  const inboxRowsFor = (me) => inbox.listInbox({ userId: me.user_id, userCreated: me.created ?? 0 }).filter((l) => !excludedLead(l));
  /** What the Inbox list is drawn from (P3-12): a change in any of it redraws the list. */
  const listToken = (rows) => `${rows.length}:${rows.reduce((n, r) => n + (Number(r.unread) || 0), 0)}:${rows.reduce((m, r) => Math.max(m, Number(r.last_msg_ts) || 0), 0)}`;

  /**
   * `GET /v1/admin/inbox/pulse[?lead=]`: what app.js compares with the page it has (P3-12).
   * The list's token is over exactly the rows the page draws; a thread's is its revision,
   * the number the reply form's stale guard uses. A chat the member may not read is 404
   * here as everywhere (rule 1): the pulse must not say whether a hidden chat moved.
   */
  function inboxPulse({ res, url, me }) {
    if (!inbox) return sendJson(res, 404, { error: 'not_found' });
    const leadId = url.searchParams.get('lead');
    if (leadId === null) return sendJson(res, 200, { token: listToken(inboxRowsFor(me)) });
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(leadId) || !openChat(db.getLead(leadId))) return sendJson(res, 404, { error: 'not_in_inbox' });
    return sendJson(res, 200, { token: String(inbox.revision(leadId)) });
  }

  /**
   * `GET /dashboard/push/open`: where a tapped alert lands (P3-4). The first row with
   * unread messages of the member's own list (unread first, newest first, rule 1 applied);
   * with nothing unread — a colleague read it first, or the tap came late — the newest
   * chat, which is the list's first row; with no chat at all, the list. The notification
   * carries nothing, so the chat is chosen here, signed in.
   */
  function pushOpen({ res, me }) {
    const rows = inbox ? inboxRowsFor(me) : [];
    const first = rows.find((r) => (Number(r.unread) || 0) > 0) ?? rows[0] ?? null;
    return redirect(res, first ? `/dashboard/inbox/${encodeURIComponent(first.lead_id)}` : '/dashboard/inbox', 302);
  }

  function inboxList({ res, url, me }) {
    if (!inbox) return noSuchPage(res, me);
    const ok = inboxOk(url.searchParams.get('ok'));
    const error = knownError(url.searchParams.get('error'));
    const owner = me.role === 'owner';
    if (url.searchParams.get('tab') === 'unsure') {
      if (!owner) return sendHtml(res, 403, messagePage({ title: 'Owners only', message: 'Only an owner can see the Unsure list.', me }));
      return sendHtml(res, 200, unsurePage({
        me, rows: inbox.listUnsure().filter((l) => !excludedLead(l)), candidates: candidatesShown(), ok, error, now: now(),
      }));
    }
    const rows = inboxRowsFor(me);
    return sendHtml(res, 200, inboxPage({
      me,
      rows,
      // Counted from the rows the Unsure tab shows (the guesses and the chats to check),
      // never the store's raw counts. Staff get none: the tab is not theirs.
      unsureCount: owner ? inbox.listUnsure({ limit: 1000 }).filter((l) => !excludedLead(l)).length + candidatesShown().length : 0,
      ok,
      error,
      now: now(),
      pulseToken: listToken(rows),
    }));
  }

  async function inboxThread({ res, url, user }, leadId) {
    if (!inbox) return noSuchPage(res, withUnread(user));
    if (!openChat(db.getLead(leadId))) return notInInbox(res, withUnread(user));
    await refreshChat(db.getLead(leadId));
    // Read again: the refresh may have learned the chat's lid or phone jid.
    const lead = db.getLead(leadId);
    if (!openChat(lead)) return notInInbox(res, withUnread(user));
    return renderThread(res, { user, lead, ok: url.searchParams.get('ok'), error: url.searchParams.get('error') });
  }

  /** How each of `sender.reply`'s refusals is answered: HTTP status, then the page's message code. */
  const REPLY_REFUSALS = {
    stale: [409, 'stale'],
    lid_only: [409, 'lid_only'],
    bad_text: [400, 'bad_text'],
    bad_send_id: [400, 'bad_send_id'],
    sending_disabled: [503, 'sending_disabled'],
    replies_off: [503, 'replies_off'],
    rate_limited: [429, 'reply_rate_limited'],
  };
  /** Refusals that mean the chat itself may not be answered (rule 1): no page of it is drawn. */
  const NOT_ANSWERABLE = new Set(['not_found', 'not_in_inbox', 'excluded']);
  /** A writer who is no longer signed in: a form goes to the login, JSON gets a 401. */
  const signedOut = (res, form) => (form ? toLogin(res, '', 303) : sendJson(res, 401, { error: 'unauthorised' }));

  async function inboxReply({ req, res, fields, form, me }, leadId) {
    if (!sender) return sendJson(res, 404, { error: 'not_found' });
    const back = `/dashboard/inbox/${encodeURIComponent(leadId)}`;
    // Asked here as well as in the sender, and before the refresh: a chat that is not in
    // the inbox must not cost an Evolution read, let alone a send.
    if (!openChat(db.getLead(leadId))) return refuseChat(res, form, me);
    await refreshChat(db.getLead(leadId));
    // The session, asked again now the refresh is done: it can take seconds, and a person
    // deactivated (or signed out) meanwhile must not send on the strength of a check made
    // before. The sender reads the member again right before its outbox row as well.
    if (!currentUser(req)) return signedOut(res, form);

    const text = asText(fields.text).replace(/\r\n?/g, '\n').trim();
    const out = await sender.reply({ sendId: asText(fields.send_id), leadId, userId: me.user_id, text, seenRev: asRev(fields.seen_rev) });
    if (out.error === 'inactive_user') return signedOut(res, form);
    const inFlight = out.duplicate && (out.status === 'pending' || out.status === 'uncertain');
    const outcome = out.ok ? 'accepted' : (out.uncertain || inFlight) ? 'uncertain' : 'failed';
    // Audited once per request that reached WhatsApp (sent, perhaps sent, or turned away
    // by it) — never a refusal made here first, never a resubmit — with the outcome only.
    const attempted = out.ok || out.uncertain || out.error === 'network' || String(out.error ?? '').startsWith('http_');
    if (!out.duplicate && attempted) {
      audit?.record({ userId: me.user_id, action: 'reply_sent', target: leadId, meta: { status: outcome } });
      log({ evt: 'dash.reply', leadId, status: outcome });
    }
    if (outcome === 'accepted') return answer(res, { form, back: `${back}?ok=sent`, status: 200, payload: { ok: true, status: outcome, send_id: out.sendId } });
    // It may well have gone. Say so and let the person look at WhatsApp: never retried,
    // and the words are not kept for a resubmit that could send them twice.
    if (outcome === 'uncertain') return answer(res, { form, back: `${back}?error=send_uncertain`, status: 202, payload: { ok: false, error: 'send_uncertain', send_id: out.sendId } });
    if (NOT_ANSWERABLE.has(out.error)) return refuseChat(res, form, me);
    // Anything else was turned away upstream (Evolution, the gate) or is a resubmit of a
    // send that failed: 503, never 502 or 504 — Cloudflare puts its own page in place of
    // those, and the thread with the words still in the box would never reach the writer.
    const [status, error] = !out.duplicate && Object.hasOwn(REPLY_REFUSALS, out.error) ? REPLY_REFUSALS[out.error] : [503, 'send_failed'];
    if (!form) return sendJson(res, status, { error });
    const lead = db.getLead(leadId);
    if (!openChat(lead)) return notInInbox(res, withUnread(me));
    // The page again, the words still in the box and a fresh send_id: nothing in a URL (P2-9).
    return renderThread(res, { status, user: me, lead, draft: text, error });
  }

  /**
   * A form reply whose body is over `REPLY_MAX_BODY_BYTES`: the thread again with `bad_text`
   * (the words were thrown away unread, so there is no draft to keep). Only a page is drawn
   * — no write, nothing sent — so it asks only what a page asks: a signed-in person, an open
   * chat.
   *
   * `drained`: the body was read to its end (it stopped short of `REPLY_DRAIN_MAX_BYTES`),
   * so this is the ordinary over-long-reply answer on a connection that stays. Otherwise the
   * rest was never read: 413, and the connection goes with the answer (refuseBody).
   */
  function replyTooLarge(req, res, leadId, drained) {
    if (!drained) res.setHeader('Connection', 'close');
    const me = currentUser(req);
    if (!me) return toLogin(res, '', 303);
    if (!inbox || !sender) return sendJson(res, 404, { error: 'not_found' });
    const lead = db.getLead(leadId);
    if (!openChat(lead)) return notInInbox(res, withUnread(me));
    const [status, error] = drained ? REPLY_REFUSALS.bad_text : [413, 'bad_text'];
    return renderThread(res, { status, user: me, lead, error });
  }

  function inboxHandler({ res, fields, form, me }, leadId) {
    const back = `/dashboard/inbox/${encodeURIComponent(leadId)}`;
    if (!openChat(db.getLead(leadId))) return refuseChat(res, form, me);
    // Anyone on the team may hand a chat to any active person, or to nobody (P2-15).
    const raw = asText(fields.user_id).trim();
    const target = raw ? team.getUser(raw) : null;
    if (raw && !(target && target.active)) return answer(res, { form, back: `${back}?error=bad_handler`, status: 400, payload: { error: 'bad_handler' } });
    const to = target ? target.user_id : null;
    inbox.setHandler(leadId, to);
    audit?.record({ userId: me.user_id, action: 'handler', target: leadId, meta: { to } });
    log({ evt: 'dash.handler', leadId });
    return answer(res, { form, back: `${back}?ok=handler`, status: 200, payload: { ok: true, handler_user_id: to } });
  }

  /**
   * The chat's Dana switches (P4-4): `dana_off` is anyone's on the team, `dana_test` — she
   * answers here even while off everywhere, the owner's way to try her on his own second
   * phone's chat — is the owner's alone. Exactly one of the two, '0' or '1', or nothing is
   * written. Audited with the switch and its value; the log line carries the lead id only.
   */
  function inboxDana({ res, fields, form, me }, leadId) {
    const back = `/dashboard/inbox/${encodeURIComponent(leadId)}`;
    if (!openChat(db.getLead(leadId))) return refuseChat(res, form, me);
    const keys = ['dana_off', 'dana_test'].filter((k) => Object.hasOwn(fields, k));
    const value = keys.length === 1 ? asText(fields[keys[0]]) : '';
    if (keys.length !== 1 || !['0', '1'].includes(value)) return answer(res, { form, back: `${back}?error=bad_dana`, status: 400, payload: { error: 'bad_dana' } });
    const [key] = keys;
    if (key === 'dana_test' && me.role !== 'owner') {
      log({ level: 'warn', evt: 'dash.owner_only', path: '/v1/admin/inbox/:id/dana' });
      return sendJson(res, 403, { error: 'owner_only' });
    }
    db.updateLead(leadId, { [key]: Number(value) });
    audit?.record({ userId: me.user_id, action: 'dana_chat', target: leadId, meta: { [key]: Number(value) } });
    log({ evt: 'dash.dana_chat', leadId, [key]: Number(value) });
    return answer(res, { form, back: `${back}?ok=dana`, status: 200, payload: { ok: true, [key]: Number(value) } });
  }

  async function inboxMove({ res, form, me }, leadId) {
    const lead = db.getLead(leadId);
    const leadPage = `/dashboard/leads/${encodeURIComponent(leadId)}`;
    if (!lead) return answer(res, { form, back: '/dashboard/inbox?error=not_a_chat', status: 404, payload: { error: 'not_found' } });
    if (excludedLead(lead)) return answer(res, { form, back: `${leadPage}?error=excluded`, status: 400, payload: { error: 'excluded' } });
    // Nothing to read a chat by: no jid, no lid, no phone to make a jid of.
    if (!lead.wa_jid && !lead.wa_lid && !lead.phone_e164) return answer(res, { form, back: `${leadPage}?error=not_a_chat`, status: 400, payload: { error: 'not_a_chat' } });
    const t = now();
    // He vouched for it: its last 30 days may be stored, and nothing older (ingest's floor).
    inbox.setInboxState(leadId, 'in', { since: t, historyFrom: t - OWNER_HISTORY_MS });
    // Off the owner's list of real-estate chats to check, if it was there (D17).
    inbox.removeCandidatesFor({ phone: lead.phone_e164, jid: lead.wa_jid, lid: lead.wa_lid });
    audit?.record({ userId: me.user_id, action: 'inbox_move', target: leadId });
    log({ evt: 'dash.inbox_move', leadId });
    await joinHistory(leadId, t);
    // A phone-only lead becomes a chat once its history names a jid; until then, the list.
    const back = openChat(db.getLead(leadId)) ? `/dashboard/inbox/${encodeURIComponent(leadId)}?ok=moved` : '/dashboard/inbox?ok=moved';
    return answer(res, { form, back, status: 200, payload: { ok: true, lead_id: leadId } });
  }

  function inboxOut({ res, form, me }, leadId) {
    const lead = db.getLead(leadId);
    if (!lead) return answer(res, { form, back: '/dashboard/inbox?error=not_a_chat', status: 404, payload: { error: 'not_found' } });
    // Not a client (design §4.1): out now, the transcript gone now, and it never comes
    // back on its own — only the owner's Move or Add brings it in again.
    const purged = inbox.leaveInbox(leadId);
    audit?.record({ userId: me.user_id, action: 'inbox_out', target: leadId });
    log({ evt: 'dash.inbox_out', leadId, messages: purged.messages });
    const back = lead.inbox_state === 'in' ? '/dashboard/inbox?ok=out' : '/dashboard/inbox?tab=unsure&ok=out';
    return answer(res, { form, back, status: 200, payload: { ok: true, purged } });
  }

  async function inboxAdd({ res, fields, form, me }) {
    const raw = asText(fields.phone);
    // A number the owner typed: never a lid or a jid, and international once normalised.
    const digits = /[@:a-zA-Z]/.test(raw) ? null : normalisePhone(raw);
    if (!digits || digits.startsWith('0')) return answer(res, { form, back: '/dashboard/inbox?error=bad_phone', status: 400, payload: { error: 'bad_phone' } });
    if (team.isExcludedPhone(digits)) return answer(res, { form, back: '/dashboard/inbox?error=excluded', status: 400, payload: { error: 'excluded' } });
    const t = now();
    // The one lead write path; `owner_added` never fans out and is born in the inbox (P2-5).
    const { lead } = createOrMergeLead(db, { phone: digits, waJid: `${digits}@s.whatsapp.net` }, {
      channel: 'whatsapp', matchMethod: 'owner_added', now: t, dataDir: cfg.dataDir,
    });
    inbox.setInboxState(lead.lead_id, 'in', { since: t, historyFrom: t - OWNER_HISTORY_MS });
    // A lead now: off the owner's list of real-estate chats to check (D17).
    inbox.removeCandidatesFor({ phone: digits, jid: `${digits}@s.whatsapp.net` });
    audit?.record({ userId: me.user_id, action: 'inbox_add', target: lead.lead_id });
    log({ evt: 'dash.inbox_add', leadId: lead.lead_id });
    await joinHistory(lead.lead_id, t);
    return answer(res, { form, back: `/dashboard/inbox/${encodeURIComponent(lead.lead_id)}?ok=added`, status: 200, payload: { ok: true, lead_id: lead.lead_id } });
  }

  /**
   * *Move to Bona inbox* on a real-estate chat to check (D17). The owner vouches for it, so
   * it becomes an `owner_added` lead through the one lead write path — no ad fan-out, no
   * new-lead note, born answered (P2-5) — goes `in`, brings its last 30 days, and leaves
   * the list. A colleague's or a never-list number is refused and taken off the list, and
   * so is a row with no phone number (a lid alone, or a WhatsApp channel's jid): A7 makes no
   * lead of one, and the poller notes none. Audited and logged by the candidate's and the
   * lead's ids, never a number.
   */
  async function candidateMove({ res, form, me }, candId) {
    const unsure = '/dashboard/inbox?tab=unsure';
    const c = inbox.getCandidate(candId);
    if (!c || c.state !== 'open') return answer(res, { form, back: `${unsure}&error=candidate_gone`, status: 404, payload: { error: 'not_found' } });
    if (!c.phone_e164 || (c.jid && !c.jid.endsWith('@s.whatsapp.net'))) {
      inbox.removeCandidate(c.cand_id);
      return answer(res, { form, back: `${unsure}&error=candidate_no_number`, status: 400, payload: { error: 'candidate_no_number' } });
    }
    const ids = { phone: c.phone_e164, jid: c.jid, lid: c.lid };
    const existing = leadOfCandidate(c);
    if (excludedCandidate(c) || (existing && excludedLead(existing))) {
      inbox.removeCandidatesFor(ids);
      return answer(res, { form, back: `${unsure}&error=excluded`, status: 400, payload: { error: 'excluded' } });
    }
    const t = now();
    const { lead } = createOrMergeLead(db, { name: c.name, phone: c.phone_e164, waJid: c.jid, waLid: c.lid }, {
      channel: 'whatsapp', matchMethod: 'owner_added', now: t, dataDir: cfg.dataDir,
    });
    inbox.setInboxState(lead.lead_id, 'in', { since: t, historyFrom: t - OWNER_HISTORY_MS });
    inbox.removeCandidatesFor(ids);
    audit?.record({ userId: me.user_id, action: 'inbox_move', target: c.cand_id, meta: { lead_id: lead.lead_id } });
    log({ evt: 'dash.candidate_move', candId: c.cand_id, leadId: lead.lead_id });
    await joinHistory(lead.lead_id, t);
    const back = openChat(db.getLead(lead.lead_id)) ? `/dashboard/inbox/${encodeURIComponent(lead.lead_id)}?ok=moved` : '/dashboard/inbox?ok=moved';
    return answer(res, { form, back, status: 200, payload: { ok: true, lead_id: lead.lead_id } });
  }

  /** *Not a client* on a real-estate chat to check: off the list, and not listed again (D17). */
  function candidateDismiss({ res, form, me }, candId) {
    const unsure = '/dashboard/inbox?tab=unsure';
    if (!inbox.dismissCandidate(candId)) return answer(res, { form, back: `${unsure}&error=candidate_gone`, status: 404, payload: { error: 'not_found' } });
    audit?.record({ userId: me.user_id, action: 'inbox_out', target: candId });
    log({ evt: 'dash.candidate_dismiss', candId });
    return answer(res, { form, back: `${unsure}&ok=dismissed`, status: 200, payload: { ok: true } });
  }

  /* -------------------- phone alerts -------------------- */

  /**
   * A member's own device, alerts on or off (P3-5, P3-6). Meant for JSON (a form body cannot
   * carry the nested keys and is refused as `bad_keys`); the row is bound to the session
   * making the call, so logging out here ends alerts here. The session is named by its hash
   * — what `auth_sessions` holds — never by the cookie's token. The endpoint and the keys are
   * validated in lib/alerts.mjs (only the real push services, a real P-256 point) and never
   * logged: the endpoint is a bearer capability. app.js re-posts a device on every page load
   * (P3-11), so only a device seen for the first time, or one that has changed hands (a
   * shared phone signed in as someone else), makes a log line.
   */
  function pushWrite({ req, res, fields, me }, p) {
    if (p === '/v1/admin/push/unsubscribe') {
      const removed = alerts ? alerts.unsubscribe({ userId: me.user_id, endpoint: fields.endpoint }) : false;
      if (removed) log({ evt: 'push.unsubscribed', userId: me.user_id });
      return sendJson(res, 200, { ok: true, removed });
    }
    if (!alerts?.configured) return sendJson(res, 503, { error: 'push_off' });
    const out = alerts.subscribe({ userId: me.user_id, sessionHash: tokenHash(sessionToken(req)), endpoint: fields.endpoint, keys: fields.keys });
    if (!out.ok) return sendJson(res, 400, { error: out.error });
    if (out.created || out.moved) log({ evt: 'push.subscribed', userId: me.user_id, moved: out.moved });
    return sendJson(res, 200, { ok: true });
  }

  /* -------------------- dispatch -------------------- */

  const LEAD_PATH = /^\/dashboard\/leads\/([A-Za-z0-9_-]{1,64})$/;
  const INBOX_PATH = /^\/dashboard\/inbox\/([A-Za-z0-9_-]{1,64})$/;
  const ADMIN_LEAD = /^\/v1\/admin\/leads\/([A-Za-z0-9_-]{1,64})(?:\/(stage|note))?$/;
  const ADMIN_TEAM = /^\/v1\/admin\/team\/([A-Za-z0-9_-]{1,64})\/(deactivate|reactivate|role)$/;
  const ADMIN_INBOX = /^\/v1\/admin\/inbox\/([A-Za-z0-9_-]{1,64})\/(reply|handler|move|out|dana)$/;
  /** Inbox writes only an owner makes (D9); reply and handler are anyone's on the team. */
  const OWNER_INBOX_WRITES = new Set(['move', 'out']);
  /** The owner's decisions on a real-estate chat to check (D17): his alone. */
  const ADMIN_CANDIDATE = /^\/v1\/admin\/inbox\/candidates\/([A-Za-z0-9_-]{1,64})\/(move|dismiss)$/;
  const OWNER_WRITES = new Set(['/v1/admin/team', '/v1/admin/never', '/v1/admin/never/remove', '/v1/admin/settings', '/v1/admin/inbox/add']);
  /** A member's own device's alerts (P3-5): anyone on the team, their own subscriptions only. */
  const PUSH_WRITES = new Set(['/v1/admin/push/subscribe', '/v1/admin/push/unsubscribe']);

  const owns = ownsDashboardPath;

  async function handleHtml({ req, res, url, p, ip }) {
    /* --- the app's fixed files: public, whoever asks (P3-2) --- */
    // `p` has its trailing slash stripped by index.mjs; `/dashboard/sw.js/` is not a file.
    const asset = ASSETS.get(p);
    if (asset && !url.pathname.endsWith('/')) return sendAsset(req, res, asset, p);
    if (p === '/dashboard/tiktok/callback') return tiktokCallback({ req, res, url });
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
    if (p === '/dashboard/logout') {
      if (req.method === 'POST') return logout({ req, res, ip });
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' });
      if (!signedIn(req)) return toLogin(res);
      return sendHtml(res, 200, logoutPage());
    }

    /* --- everything else needs a signed-in, active member --- */
    const user = currentUser(req);
    if (!user) return toLogin(res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' });
    // A thread marks itself read before it is drawn, so it counts its own badge.
    const threadMatch = INBOX_PATH.exec(p);
    if (threadMatch) return inboxThread({ res, url, user }, threadMatch[1]);
    // Every other signed-in page carries the person's unread count for the Inbox badge.
    const me = withUnread(user);

    // A tapped alert (P3-4): a redirect, so the notification itself carries nothing.
    if (p === '/dashboard/push/open') return pushOpen({ res, me });
    if (p === '/dashboard') return overview({ res, url, me });
    if (p === '/dashboard/leads') return leads({ res, url, me });
    const leadMatch = LEAD_PATH.exec(p);
    if (leadMatch) return leadDetail({ res, url, me }, leadMatch[1]);
    if (p === '/dashboard/listings') return listings({ res, me });
    if (p === '/dashboard/spend') return spend({ res, url, me });
    if (p === '/dashboard/integrations') return integrations({ res, me });
    if (p === '/dashboard/tiktok') {
      if (me.role !== 'owner') return sendHtml(res, 403, messagePage({ title: 'Owners only', message: 'Only an owner can manage TikTok authorization.', me }));
      return sendHtml(res, 200, tiktokAccountsPage({ me, state: accounts.status(), error: url.searchParams.get('error'), ok: url.searchParams.get('ok') }));
    }
    if (p === '/dashboard/team') return teamView({ res, url, me });
    if (p === '/dashboard/inbox') return inboxList({ res, url, me });
    return sendHtml(res, 404, messagePage({ title: 'Not found', message: 'There is no such page.', me }));
  }

  async function handleAdmin({ req, res, url, p, ip }) {
    const viewer = currentUser(req);
    if (!viewer) return sendJson(res, 401, { error: 'unauthorised' });
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
      if (p === '/v1/admin/leads') return adminLeads({ res, url, me: viewer });
      if (p === '/v1/admin/listings') return adminListings({ res });
      if (p === '/v1/admin/inbox/pulse') return inboxPulse({ res, url, me: viewer });
      if (leadMatch && !leadMatch[2]) return adminLead({ res, me: viewer }, leadMatch[1]);
      return sendJson(res, 404, { error: 'not_found' });
    }

    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });

    const tiktokMatch = /^\/v1\/admin\/tiktok\/(connect|refresh|revoke|forget|preview)$/.exec(p);
    if (tiktokMatch) {
      let origin;
      try { origin = new URL(cfg.publicApi).origin; } catch { /* fail closed */ }
      if (!origin || req.headers.origin !== origin) return sendHtml(res, 403, messagePage({ title: 'Request origin could not be verified', message: 'Open the TikTok setup page on the canonical API address in your signed-in owner browser and try again. Your browser must send its same-origin Origin header.' }));
    }
    const teamMatch = ADMIN_TEAM.exec(p);
    const inboxMatch = ADMIN_INBOX.exec(p);
    const candMatch = ADMIN_CANDIDATE.exec(p);
    const ownerWrite = Boolean(teamMatch || tiktokMatch || candMatch || OWNER_WRITES.has(p) || (inboxMatch && OWNER_INBOX_WRITES.has(inboxMatch[2])));
    const writes = (leadMatch && leadMatch[2]) || (p === '/v1/admin/spend' ? 'spend' : null)
      || ((inboxMatch || candMatch || p === '/v1/admin/inbox/add') ? 'inbox' : null) || (PUSH_WRITES.has(p) ? 'push' : null)
      || (ownerWrite ? 'team' : null);
    if (!writes) return sendJson(res, 404, { error: 'not_found' });

    const replyWrite = Boolean(inboxMatch && inboxMatch[2] === 'reply');
    const parsed = replyWrite
      ? await fieldsOf(req, Math.max(maxBodyBytes, REPLY_MAX_BODY_BYTES), { drainFormTo: REPLY_DRAIN_MAX_BYTES })
      : await fieldsOf(req, maxBodyBytes);
    if (!parsed.ok) {
      // A form reply too big even for its own cap comes back as the thread, with a message
      // a person can act on — never a raw JSON answer in the browser.
      if (replyWrite && parsed.status === 413 && parsed.form) return replyTooLarge(req, res, inboxMatch[1], parsed.drained);
      return refuseBody(req, res, parsed);
    }
    if (!hasMarker(req, parsed.fields)) {
      log({ level: 'warn', evt: 'dash.marker_missing', path: p, ip });
      return sendJson(res, 403, { error: 'forbidden', message: 'X-Bona-Dash: 1 (or _dash=1) is required on a write' });
    }
    // Asked again now the body is in: reading it can take as long as the client likes,
    // and a person deactivated (or demoted) meanwhile must not get the write through on
    // the strength of a check made before they were.
    const me = currentUser(req);
    if (!me) return sendJson(res, 401, { error: 'unauthorised' });
    if (ownerWrite && me.role !== 'owner') {
      const shown = teamMatch ? '/v1/admin/team/:id' : inboxMatch ? `/v1/admin/inbox/:id/${inboxMatch[2]}`
        : candMatch ? `/v1/admin/inbox/candidates/:id/${candMatch[2]}` : p;
      log({ level: 'warn', evt: 'dash.owner_only', path: shown });
      return sendJson(res, 403, { error: 'owner_only' });
    }

    const ctx = { res, fields: parsed.fields, form: parsed.form, me };
    if (tiktokMatch) return tiktokWrite({ ...ctx, req, me: withUnread(me) }, tiktokMatch[1]);
    if (writes === 'push') return pushWrite({ ...ctx, req }, p);
    if (writes === 'inbox') {
      // index.mjs always wires the inbox; routes built without it (older tests, tools) have none.
      if (!inbox) return sendJson(res, 404, { error: 'not_found' });
      if (candMatch) return candMatch[2] === 'move' ? candidateMove(ctx, candMatch[1]) : candidateDismiss(ctx, candMatch[1]);
      if (!inboxMatch) return inboxAdd(ctx);
      const [, leadId, what] = inboxMatch;
      if (what === 'reply') return inboxReply({ ...ctx, req }, leadId);
      if (what === 'handler') return inboxHandler(ctx, leadId);
      if (what === 'dana') return inboxDana(ctx, leadId);
      if (what === 'move') return inboxMove(ctx, leadId);
      return inboxOut(ctx, leadId);
    }
    if (writes === 'stage') return setStage(ctx, leadMatch[1]);
    if (writes === 'note') return addNote(ctx, leadMatch[1]);
    if (writes === 'spend') return saveSpend(ctx);
    if (teamMatch) return changePerson(ctx, teamMatch[1], teamMatch[2]);
    if (p === '/v1/admin/team') return addPerson(ctx);
    if (p === '/v1/admin/never') return neverWrite(ctx, false);
    if (p === '/v1/admin/never/remove') return neverWrite(ctx, true);
    if (p === '/v1/admin/settings') return saveSetting(ctx);
    return sendJson(res, 404, { error: 'not_found' });
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

  return { handle, owns, auth: authenticator, stats: statistics };
}
