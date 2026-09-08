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
 * never appears in a log line or in a response body — the only place it is ever
 * written is the WhatsApp message itself.
 *
 * Two limits stand in front of the sender, because every request costs the owner a
 * WhatsApp notification: three per ten minutes from one address, and one a minute
 * across the whole service. Five wrong guesses burn a code (`db.consumeAuthCode`),
 * which is what makes six digits enough.
 */
import crypto from 'node:crypto';
import { createLimiter } from '../ratelimit.mjs';

export const COOKIE_NAME = 'bona_dash';
export const CODE_TTL_MS = 10 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;
/** Per-IP: 3 codes per 10 minutes. Global: 1 code a minute, whoever asks. */
export const IP_CODES = 3;
export const IP_WINDOW_MS = 10 * 60_000;
export const GLOBAL_WINDOW_MS = 60_000;

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
  const sessionTtlMs = cookieDays * 86_400_000;
  const perIp = createLimiter({ capacity: IP_CODES, perMs: IP_WINDOW_MS, now });
  const global = createLimiter({ capacity: 1, perMs: GLOBAL_WINDOW_MS, now });

  /**
   * Send the owner a fresh code.
   * @returns {Promise<{ok: true} | {ok: false, error: 'rate_limited'|'send_failed'}>}
   */
  async function requestCode(ip) {
    const key = `dashcode:${ip ?? 'unknown'}`;
    if (!perIp.take(key).ok) {
      log({ level: 'warn', evt: 'dash.code_rate_limited', scope: 'ip' });
      return { ok: false, error: 'rate_limited' };
    }
    if (!global.take('dashcode:global').ok) {
      log({ level: 'warn', evt: 'dash.code_rate_limited', scope: 'global' });
      return { ok: false, error: 'rate_limited' };
    }
    const code = generateCode(random);
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
    log({ evt: 'dash.code_sent', expiresInS: CODE_TTL_MS / 1000 });
    return { ok: true };
  }

  /**
   * Redeem a code for a session token.
   * @returns {{ok: true, token: string, expires: number} | {ok: false, error: string}}
   */
  function verify(code, ua = null) {
    const cleaned = String(code ?? '').replace(/\D/g, '');
    const t = now();
    if (cleaned.length !== 6) {
      // Still charged against every live code: a six-digit guess is a guess whether or
      // not it arrived with punctuation around it.
      db.consumeAuthCode('', { now: t, maxAttempts: MAX_CODE_ATTEMPTS });
      return { ok: false, error: 'bad_code' };
    }
    const outcome = db.consumeAuthCode(cleaned, { now: t, maxAttempts: MAX_CODE_ATTEMPTS });
    if (!outcome.ok) {
      log({ level: 'warn', evt: 'dash.login_failed', reason: outcome.reason });
      return { ok: false, error: outcome.reason ?? 'bad_code' };
    }
    const token = crypto.randomBytes(16).toString('hex');
    const { expires } = db.createAuthSession(token, { now: t, ttlMs: sessionTtlMs, ua });
    log({ evt: 'dash.login', days: cookieDays });
    return { ok: true, token, expires };
  }

  /** Is this token a live session? Constant-time on the stored hash. */
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

  /* -------------------- cookie -------------------- */

  const cookieAttributes = `HttpOnly; Secure; SameSite=Lax; Path=/`;

  /** The `Set-Cookie` value for a fresh session. */
  const cookieValue = (token) => `${COOKIE_NAME}=${token}; ${cookieAttributes}; Max-Age=${Math.round(cookieDays * 86_400)}`;
  /** …and the one that removes it. */
  const clearedCookie = () => `${COOKIE_NAME}=; ${cookieAttributes}; Max-Age=0`;

  function setCookie(res, token) {
    res.setHeader('Set-Cookie', cookieValue(token));
    return res;
  }

  function clearCookie(res) {
    res.setHeader('Set-Cookie', clearedCookie());
    return res;
  }

  /** The session token the browser presented, or null. */
  function readCookie(req) {
    const value = parseCookies(req?.headers?.cookie)[COOKIE_NAME];
    return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) ? value : null;
  }

  return {
    requestCode, verify, check, logout,
    setCookie, clearCookie, readCookie, cookieValue, clearedCookie,
    cookieDays, sessionTtlMs,
  };
}
