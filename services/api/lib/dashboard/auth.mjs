/**
 * Dashboard login: a one-time code sent to a team member's own WhatsApp.
 *
 * Who may log in is the `users` table (lib/team.mjs): the owner, seeded from
 * `BONA_OWNER_JID`, and the people he adds on the Team page. A person types their phone
 * number; if it belongs to an active member, six digits go to that member's WhatsApp from
 * the owner's number (the owner's own code goes to his own chat, as it always did).
 * Possession of that phone IS the credential.
 *
 * Nothing readable is stored: `auth_challenges` holds `sha256(code)` and `sha256(nonce)`,
 * `auth_sessions` holds `sha256(token)`. The code is written in exactly one place, the
 * WhatsApp message — never a log line, a response or the audit log.
 *
 * ## One challenge, one person, one browser
 *
 * A code request creates a challenge: the member it belongs to, the code's hash, and the
 * hash of a `bona_dash_try` nonce handed back as an HttpOnly cookie. `verify()` finds the
 * challenge by that nonce — never by the code — so a code only works in the browser that
 * asked for it and only for the person it was sent to, and five wrong guesses burn that
 * challenge alone. A stranger with no nonce cannot spend anyone's attempts.
 *
 * ## Nothing says who is on the team
 *
 * A number that is not an active member gets the same answer, the same cookie and a decoy
 * challenge whose hash no six digits can match. The answer is returned before the WhatsApp
 * message is sent, so neither the response nor its timing tells a stranger whether a
 * number belongs to the team. The cost: a send that fails is only in the log — the page
 * says "if that number is on the team, a code is on its way" either way.
 *
 * ## Limits
 *
 * Asked before any is charged (charging one and then being refused by the next is how a
 * caller spends an allowance that was never theirs): 3 codes per 10 minutes per phone
 * number and per IP, and across the service 6 a minute and 200 a day. The send itself
 * also passes the shared gate in lib/wa-send.mjs.
 */
import crypto from 'node:crypto';
import { createLimiter } from '../ratelimit.mjs';
import { normalisePhone } from '../phone.mjs';

export const COOKIE_NAME = 'bona_dash';
export const TRY_COOKIE_NAME = 'bona_dash_try';

/**
 * Arabic-Indic (٠-٩) and Eastern Arabic-Indic (۰-۹) digits folded to ASCII. An Arabic
 * keyboard is the normal case here: without this the code read off WhatsApp and typed
 * back would be stripped by `\D` and refused.
 */
export function normaliseDigits(input) {
  return String(input ?? '').replace(/[٠-٩۰-۹]/g, (d) => {
    const c = d.charCodeAt(0);
    return String(c >= 0x06F0 ? c - 0x06F0 : c - 0x0660);
  });
}

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;
export const PHONE_CODES = 3;
export const IP_CODES = 3;
export const CODE_WINDOW_MS = 10 * 60_000;
export const GLOBAL_PER_MIN = 6;
export const GLOBAL_DAILY_CODES = 200;
export const DAY_MS = 86_400_000;

const sha256 = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');

/** Six digits, uniformly drawn, leading zeros kept. */
export function generateCode(random = crypto.randomInt) {
  return String(random(0, 1_000_000)).padStart(6, '0');
}

/** The message a member receives. The only place the code is ever written. */
export const codeMessage = (code) => `Bona dashboard code: ${code} (valid 10 min)`;

/** Equal-length hex compare that does not leak where two values diverge. */
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

const isHex32 = (v) => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);

/**
 * @param {object} o
 * @param {ReturnType<import('../db.mjs').openDb>} o.db
 * @param {ReturnType<import('../team.mjs').createTeam>} o.team
 * @param {ReturnType<import('../audit.mjs').createAudit>} [o.audit]
 * @param {object} [o.cfg]  `dashCookieDays`
 * @param {(o: { jid: string, text: string, kind: 'code', bypassSwitch: boolean }) => Promise<{ ok?: boolean, error?: string }>} o.sendCode
 *   Shaped to be `sender.sendTo` from lib/wa-send.mjs as-is; that gate, not this file,
 *   decides whether `bypassSwitch` is honoured (only for the owner's own jid).
 */
export function createAuth({ db, team, audit = null, cfg = {}, sendCode, now = () => Date.now(), log = () => {}, random = crypto.randomInt } = {}) {
  if (!team) throw new TypeError('createAuth needs the team store');
  const cookieDays = Number(cfg.dashCookieDays ?? 30) > 0 ? Number(cfg.dashCookieDays ?? 30) : 30;
  const sessionTtlMs = cookieDays * DAY_MS;
  const perPhone = createLimiter({ capacity: PHONE_CODES, perMs: CODE_WINDOW_MS, now });
  const perIp = createLimiter({ capacity: IP_CODES, perMs: CODE_WINDOW_MS, now });
  const perMinute = createLimiter({ capacity: GLOBAL_PER_MIN, perMs: 60_000, now });
  const perDay = createLimiter({ capacity: GLOBAL_DAILY_CODES, perMs: DAY_MS, now });
  const inFlight = new Set();

  const stmts = new Map();
  const prep = (sql) => {
    let s = stmts.get(sql);
    if (!s) { s = db.db.prepare(sql); stmts.set(sql, s); }
    return s;
  };

  /**
   * Start a login for `phone`. Always `{ ok: true, nonce }` unless a limit refuses or the
   * input is not a phone number — see "Nothing says who is on the team" above.
   * @returns {Promise<{ ok: true, nonce: string } | { ok: false, error: 'rate_limited'|'bad_phone' }>}
   */
  async function requestCode({ phone, ip } = {}) {
    const digits = normalisePhone(normaliseDigits(phone));
    if (!digits) return { ok: false, error: 'bad_phone' };
    const gates = [
      [perMinute, 'dashcode:global'], [perDay, 'dashcode:daily'],
      [perIp, `dashcode:ip:${ip ?? 'unknown'}`], [perPhone, `dashcode:phone:${digits}`],
    ];
    if (gates.some(([limiter, key]) => !limiter.peek(key).ok)) {
      log({ level: 'warn', evt: 'dash.code_rate_limited' });
      return { ok: false, error: 'rate_limited' };
    }
    for (const [limiter, key] of gates) limiter.take(key);

    const t = now();
    const found = team.getUserByPhone(digits);
    const member = found && found.active ? found : null;
    const code = generateCode(random);
    const nonce = crypto.randomBytes(16).toString('hex');
    // A decoy's hash is of 32 random hex characters: no six digits can ever match it.
    const codeHash = sha256(member ? code : crypto.randomBytes(16).toString('hex'));
    prep('DELETE FROM auth_challenges WHERE expires < ?').run(t - DAY_MS);
    prep('INSERT INTO auth_challenges (challenge_id, user_id, code_hash, nonce_hash, created, expires, attempts, used) VALUES (?,?,?,?,?,?,0,0)')
      .run(`CH-${crypto.randomBytes(8).toString('hex')}`, member?.user_id ?? null, codeHash, sha256(nonce), t, t + CODE_TTL_MS);

    if (member) {
      // Everything member-only — the audit row included — runs after the answer is
      // returned, so the synchronous path is the same for a member and a stranger.
      const job = Promise.resolve()
        .then(() => audit?.record({ userId: member.user_id, action: 'code_request' }))
        .then(() => sendCode({ jid: member.wa_jid, text: codeMessage(code), kind: 'code', bypassSwitch: member.role === 'owner' }))
        .then((res) => {
          if (res?.ok) log({ evt: 'dash.code_sent', expiresInS: CODE_TTL_MS / 1000 });
          else log({ level: 'error', evt: 'dash.code_send_failed', reason: res?.error ?? 'unknown' });
        })
        // The error's code or name only: a thrown message could carry the recipient.
        .catch((err) => log({ level: 'error', evt: 'dash.code_send_error', error: String(err?.code ?? err?.name ?? 'unknown').slice(0, 60) }))
        .finally(() => inFlight.delete(job));
      inFlight.add(job);
    }
    return { ok: true, nonce };
  }

  /** Resolves once every code send started so far has finished. Tests and shutdown use it. */
  const flush = () => Promise.all([...inFlight]);

  const refuse = (error) => {
    log({ level: 'warn', evt: 'dash.login_failed', reason: error });
    return { ok: false, error };
  };

  /**
   * Redeem a code for a session.
   * @returns {{ ok: true, token: string, expires: number, user: object } | { ok: false, error: 'no_request'|'used'|'expired'|'attempts'|'bad_code' }}
   */
  function verify(code, ua = null, { nonce = null } = {}) {
    if (!isHex32(nonce)) return refuse('no_request');
    const t = now();
    return db.transaction(() => {
      const row = prep('SELECT * FROM auth_challenges WHERE nonce_hash = ?').get(sha256(nonce));
      if (!row) return refuse('no_request');
      if (row.used) return refuse('used');
      if (row.expires < t) return refuse('expired');
      if (row.attempts >= MAX_CODE_ATTEMPTS) return refuse('attempts');
      prep('UPDATE auth_challenges SET attempts = attempts + 1 WHERE challenge_id = ?').run(row.challenge_id);
      const cleaned = normaliseDigits(code).replace(/\D/g, '');
      if (cleaned.length !== 6 || !hashEquals(sha256(cleaned), row.code_hash) || !row.user_id) return refuse('bad_code');
      const user = team.getUser(row.user_id);
      if (!user || !user.active) return refuse('no_request');
      prep('UPDATE auth_challenges SET used = 1 WHERE challenge_id = ?').run(row.challenge_id);
      const token = crypto.randomBytes(16).toString('hex');
      const { expires } = db.createAuthSession(token, { now: t, ttlMs: sessionTtlMs, ua, userId: user.user_id });
      team.touchLogin(user.user_id);
      audit?.record({ userId: user.user_id, action: 'login' });
      log({ evt: 'dash.login', days: cookieDays, role: user.role });
      return { ok: true, token, expires, user: team.getUser(user.user_id) };
    });
  }

  /**
   * The active member behind a session token, or null. A session whose member has been
   * deactivated (or that belongs to nobody) is deleted on sight.
   */
  function check(token) {
    if (!isHex32(token)) return null;
    const row = db.checkAuthSession(token, { now: now() });
    if (!row || !hashEquals(sha256(token), row.token_hash)) return null;
    const user = row.user_id ? team.getUser(row.user_id) : null;
    if (!user || !user.active) {
      db.deleteAuthSession(token);
      return null;
    }
    return user;
  }

  function logout(token, user = null) {
    if (typeof token !== 'string' || !token) return false;
    if (user) audit?.record({ userId: user.user_id, action: 'logout' });
    return db.deleteAuthSession(token);
  }

  /* -------------------- cookies -------------------- */

  const attributes = 'HttpOnly; Secure; SameSite=Lax; Path=/';
  const cookieValue = (token) => `${COOKIE_NAME}=${token}; ${attributes}; Max-Age=${Math.round(cookieDays * 86_400)}`;
  const clearedCookie = () => `${COOKIE_NAME}=; ${attributes}; Max-Age=0`;
  const tryCookieValue = (nonce) => `${TRY_COOKIE_NAME}=${nonce}; ${attributes}; Max-Age=${CODE_TTL_MS / 1000}`;
  const clearedTryCookie = () => `${TRY_COOKIE_NAME}=; ${attributes}; Max-Age=0`;

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

  function readCookie(req) {
    const value = parseCookies(req?.headers?.cookie)[COOKIE_NAME];
    return isHex32(value) ? value : null;
  }
  function readTryCookie(req) {
    const value = parseCookies(req?.headers?.cookie)[TRY_COOKIE_NAME];
    return isHex32(value) ? value : null;
  }

  return {
    requestCode, verify, check, logout, flush,
    setCookie, clearCookie, readCookie,
    setTryCookie, clearTryCookie, readTryCookie,
    cookieValue, clearedCookie,
    cookieDays, sessionTtlMs,
  };
}
