/**
 * Dashboard login: a one-time code sent to the owner's own WhatsApp.
 *
 * There is exactly one user — the founder — so there is no password to leak, no
 * account to enumerate and no reset flow. Asking for a code sends six digits to the
 * number that is already the business's WhatsApp; typing them back sets a long-lived
 * cookie. Possession of that phone IS the credential.
 *
 * Nothing readable is stored: `auth_codes` holds `sha256(code)` and `auth_sessions`
 * holds `sha256(token)`, so a copy of `bona.db` grants nobody a session. The code
 * never appears in a log line or in a response — the only place it is ever written is
 * the WhatsApp message itself.
 *
 * ## Why a code is tied to the browser that asked for it
 *
 * `db.consumeAuthCode()` charges a wrong guess against *every* code still live, which
 * is what makes six digits enough to be safe: five misses burn the real one. On its
 * own, though, that hands any stranger a permanent lockout — five POSTs to
 * `/dashboard/login/verify` kill the code the owner is holding, and the sender is
 * capped at one code a minute globally, so the attacker wins the race for ever.
 *
 * So a code request also mints a `bona_dash_try` nonce, returned as an HttpOnly cookie
 * and remembered here beside that code's hash. `verify()` compares the typed code
 * against the code *that nonce was issued for*, and a guess that does not match never
 * reaches the store at all. The brute-force protection is unchanged — five wrong
 * guesses still burn the code — but only the browser that asked for a code can spend
 * its attempts, and a stranger with no nonce cannot spend anything.
 *
 * The binding lives in memory, so a restart voids a code in flight. That is the right
 * trade: the cost is one more tap on "send me a code", and the alternative is a column
 * in a table another workstream owns.
 *
 * Two limits stand in front of the sender, because every request costs the owner a
 * WhatsApp notification: three per ten minutes from one address, and — across the whole
 * service — one a minute and twenty a day. The daily ceiling is what turns a rotating
 * flood from 1,440 messages to the owner's personal phone into 20.
 */
import crypto from 'node:crypto';
import { createLimiter } from '../ratelimit.mjs';

export const COOKIE_NAME = 'bona_dash';
export const TRY_COOKIE_NAME = 'bona_dash_try';
export const CODE_TTL_MS = 10 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;
/** Per-IP: 3 codes per 10 minutes. Globally: 1 a minute, and 20 a day. */
export const IP_CODES = 3;
export const IP_WINDOW_MS = 10 * 60_000;
export const GLOBAL_WINDOW_MS = 60_000;
export const GLOBAL_DAILY_CODES = 20;
export const DAY_MS = 86_400_000;
/** Enough outstanding requests for any real browser; a flood cannot grow the map. */
export const MAX_PENDING = 64;

const sha256 = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');

/** Six digits, uniformly drawn, leading zeros kept. */
export function generateCode(random = crypto.randomInt) {
  return String(random(0, 1_000_000)).padStart(6, '0');
}

/** The message the owner receives. The only place the code is ever written. */
export const codeMessage = (code) => `Bona dashboard code: ${code} (valid 10 min)`;

/**
 * Equal-length hex compare that does not leak where two values diverge. A wrong
 * length is simply false — `timingSafeEqual` throws on mismatched buffers.
 */
export function hashEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

/** Parse a `Cookie:` header. Values are percent-decoded; a malformed one is skipped. */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const raw = part.slice(eq + 1).trim();
    try { out[name] = decodeURIComponent(raw); } catch { out[name] = raw; }
  }
  return out;
}

const isNonce = (v) => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);

/**
 * @param {object} o
 * @param {ReturnType<import('../db.mjs').openDb>} o.db
 * @param {object} o.cfg                                   loadConfig() — `dashCookieDays`
 * @param {(text: string) => Promise<{ok?: boolean}>} o.sendWhatsApp
 * @param {() => number} [o.now]
 * @param {(obj: object) => void} [o.log]
 */
export function createAuth({ db, cfg = {}, sendWhatsApp, now = () => Date.now(), log = () => {}, random = crypto.randomInt } = {}) {
  const cookieDays = Number(cfg.dashCookieDays ?? 30) > 0 ? Number(cfg.dashCookieDays ?? 30) : 30;
  const sessionTtlMs = cookieDays * DAY_MS;
  const perIp = createLimiter({ capacity: IP_CODES, perMs: IP_WINDOW_MS, now });
  const perMinute = createLimiter({ capacity: 1, perMs: GLOBAL_WINDOW_MS, now });
  const perDay = createLimiter({ capacity: GLOBAL_DAILY_CODES, perMs: DAY_MS, now });

  /** nonce hash → the code it was issued for. See the module header. */
  const pending = new Map();

  function prunePending(t) {
    for (const [key, entry] of pending) if (entry.expires < t) pending.delete(key);
    // Oldest first, so a flood evicts its own entries before the owner's.
    while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
  }

  /**
   * Send the owner a fresh code.
   * @returns {Promise<{ok: true, nonce: string} | {ok: false, error: 'rate_limited'|'send_failed'}>}
   *   `nonce` belongs in the `bona_dash_try` cookie; `verify` needs it back.
   */
  async function requestCode(ip) {
    // The global buckets are checked first so that a request refused because of someone
    // else's flood costs this address nothing of its own three.
    if (!perMinute.take('dashcode:global').ok || !perDay.take('dashcode:daily').ok) {
      log({ level: 'warn', evt: 'dash.code_rate_limited', scope: 'global' });
      return { ok: false, error: 'rate_limited' };
    }
    if (!perIp.take(`dashcode:${ip ?? 'unknown'}`).ok) {
      log({ level: 'warn', evt: 'dash.code_rate_limited', scope: 'ip' });
      return { ok: false, error: 'rate_limited' };
    }

    const code = generateCode(random);
    const nonce = crypto.randomBytes(16).toString('hex');
    const t = now();
    db.createAuthCode(code, { now: t, ttlMs: CODE_TTL_MS });
    let res = null;
    try {
      res = await sendWhatsApp?.(codeMessage(code));
    } catch (err) {
      // The message, not the error, is what could carry the code — but nothing from
      // this call is ever logged verbatim either way.
      log({ level: 'error', evt: 'dash.code_send_error', error: String(err?.message ?? err).slice(0, 200) });
      return { ok: false, error: 'send_failed' };
    }
    if (!res?.ok) {
      log({ level: 'error', evt: 'dash.code_send_failed', reason: res?.error ?? 'unknown' });
      return { ok: false, error: 'send_failed' };
    }
    prunePending(t);
    pending.set(sha256(nonce), { codeHash: sha256(code), expires: t + CODE_TTL_MS, attempts: 0 });
    log({ evt: 'dash.code_sent', expiresInS: CODE_TTL_MS / 1000 });
    return { ok: true, nonce };
  }

  /**
   * Redeem a code for a session token.
   *
   * The nonce decides whether this guess counts at all: without the one issued with a
   * code, a guess is refused here and the store never hears about it, so nobody but the
   * browser that asked can spend a code's five attempts.
   *
   * @param {string} code
   * @param {string|null} ua
   * @param {{ nonce?: string|null }} [o]
   * @returns {{ok: true, token: string, expires: number} | {ok: false, error: string}}
   */
  function verify(code, ua = null, { nonce = null } = {}) {
    const t = now();
    prunePending(t);
    const entry = isNonce(nonce) ? pending.get(sha256(nonce)) : null;
    if (!entry) {
      log({ level: 'warn', evt: 'dash.login_failed', reason: 'no_request' });
      return { ok: false, error: 'no_request' };
    }

    entry.attempts += 1;
    if (entry.attempts > MAX_CODE_ATTEMPTS) {
      pending.delete(sha256(nonce));
      log({ level: 'warn', evt: 'dash.login_failed', reason: 'attempts' });
      return { ok: false, error: 'attempts' };
    }

    const cleaned = String(code ?? '').replace(/\D/g, '');
    if (cleaned.length !== 6 || !hashEquals(sha256(cleaned), entry.codeHash)) {
      log({ level: 'warn', evt: 'dash.login_failed', reason: 'bad_code' });
      return { ok: false, error: 'bad_code' };
    }

    // Only ever reached with the right code, so the store's own "wrong guess" path —
    // which charges every live code — cannot be triggered from here. What it still
    // decides is single use and expiry, and those it owns.
    const outcome = db.consumeAuthCode(cleaned, { now: t, maxAttempts: MAX_CODE_ATTEMPTS });
    if (!outcome.ok) {
      pending.delete(sha256(nonce));
      log({ level: 'warn', evt: 'dash.login_failed', reason: outcome.reason });
      return { ok: false, error: outcome.reason ?? 'bad_code' };
    }
    pending.delete(sha256(nonce));

    const token = crypto.randomBytes(16).toString('hex');
    const { expires } = db.createAuthSession(token, { now: t, ttlMs: sessionTtlMs, ua });
    log({ evt: 'dash.login', days: cookieDays });
    return { ok: true, token, expires };
  }

  /**
   * Is this token a live session?
   *
   * The lookup is by primary key on `sha256(token)`, so the index has already decided
   * the answer; the `hashEquals` below is belt and braces on the row that comes back,
   * not the thing standing between an attacker and the account. What actually does
   * that is 128 bits of `randomBytes`, which no amount of timing tells anyone about.
   */
  function check(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) return false;
    const row = db.checkAuthSession(token, { now: now() });
    if (!row) return false;
    return hashEquals(sha256(token), row.token_hash);
  }

  function logout(token) {
    if (typeof token !== 'string' || !token) return false;
    return db.deleteAuthSession(token);
  }

  /* -------------------- cookies -------------------- */

  const attributes = 'HttpOnly; Secure; SameSite=Lax; Path=/';

  const cookieValue = (token) => `${COOKIE_NAME}=${token}; ${attributes}; Max-Age=${Math.round(cookieDays * 86_400)}`;
  const clearedCookie = () => `${COOKIE_NAME}=; ${attributes}; Max-Age=0`;
  /** The try nonce lives exactly as long as the code it belongs to. */
  const tryCookieValue = (nonce) => `${TRY_COOKIE_NAME}=${nonce}; ${attributes}; Max-Age=${CODE_TTL_MS / 1000}`;
  const clearedTryCookie = () => `${TRY_COOKIE_NAME}=; ${attributes}; Max-Age=0`;

  /** Append a `Set-Cookie`; a response may carry both the session and the try cookie. */
  function addCookie(res, value) {
    const existing = res.getHeader?.('Set-Cookie');
    const list = existing === undefined ? [] : (Array.isArray(existing) ? existing : [existing]);
    res.setHeader('Set-Cookie', [...list, value]);
    return res;
  }

  const setCookie = (res, token) => addCookie(res, cookieValue(token));
  const clearCookie = (res) => addCookie(res, clearedCookie());
  const setTryCookie = (res, nonce) => addCookie(res, tryCookieValue(nonce));
  const clearTryCookie = (res) => addCookie(res, clearedTryCookie());

  /** The session token the browser presented, or null. */
  function readCookie(req) {
    const value = parseCookies(req?.headers?.cookie)[COOKIE_NAME];
    return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) ? value : null;
  }

  /** The try nonce the browser presented, or null. */
  function readTryCookie(req) {
    const value = parseCookies(req?.headers?.cookie)[TRY_COOKIE_NAME];
    return isNonce(value) ? value : null;
  }

  return {
    requestCode, verify, check, logout,
    setCookie, clearCookie, readCookie,
    setTryCookie, clearTryCookie, readTryCookie,
    cookieValue, clearedCookie,
    cookieDays, sessionTtlMs,
    /** For tests and `/health`-style introspection: how many code requests are outstanding. */
    pendingCount: () => pending.size,
  };
}
