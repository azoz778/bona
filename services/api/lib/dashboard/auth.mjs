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
 * Everything member-only (the audit row, the send, even a log line) runs in a later
 * macrotask (`setImmediate`), so it cannot run before the route has written its answer.
 * The synchronous database work — the member lookup, the budget count, the "void older
 * challenges" update and the insert — is the same on both paths; a stranger's budget
 * count simply uses a key that matches nothing.
 *
 * A challenge's whole life is the same too, so no verify() answer tells them apart: every
 * challenge for a number (real, decoy, or an over-budget decoy) voids that number's
 * older ones, keyed by `phone_key` — an HMAC of the number under a per-process random
 * key, never stored — so the first of two nonces answers 'used' for anyone. Attempts,
 * expiry and 'no_request' already behave alike. Deactivating a member turns their codes
 * in flight into decoys (lib/team.mjs) rather than deleting them.
 *
 * ## Limits
 *
 * Asked before any is charged (charging one and then being refused by the next is how a
 * caller spends an allowance that was never theirs): 3 codes per 10 minutes per phone
 * number and per IP (an IPv6 caller is keyed on its /64), and across the service 6 a
 * minute and 200 a day. The send itself also passes the shared gate in lib/wa-send.mjs.
 *
 * Those limiters live in memory. The one that bounds guessing lives in the database, so
 * a restart does not reset it: a number has at most ONE live challenge (a new code voids
 * its older unused ones, so guesses cannot be spread across several; after a restart the
 * pre-restart ones are left to expire, ten minutes at most), and at
 * most 5 real codes an hour and 10 a day, counted from their own `auth_challenges` rows.
 * Past that budget the request silently gets a decoy — same answer, same cookie, no
 * message. Worst case for an attacker: 10 codes x 5 guesses = 50 guesses in a million
 * per person per day. The count uses `auth_challenges`, not the audit log: the audit row
 * is written after the answer (above), so two quick requests would both miss it, and the
 * audit store is optional; a challenge row is written synchronously on every request.
 * Challenge rows are kept a day past expiry for exactly this count.
 *
 * Known limit (owner decision): anyone who knows a member's number can spend that
 * member's code budget, locking their NEW logins out for up to a day (a login DoS);
 * sessions already signed in are unaffected.
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
export const HOUR_MS = 3_600_000;
/** Real codes one person may be sent — persistent, see "Limits" in the header. */
export const USER_CODES_PER_HOUR = 5;
export const USER_CODES_PER_DAY = 10;
/** Expired challenges/sessions are swept at most this often, from requests — no timers. */
export const PRUNE_EVERY_MS = 60_000;

/**
 * The one spelling of a phone number used both as the per-phone limiter key and for the
 * member lookup. `normalisePhone` strips one `00` prefix per call, so `0000966…` would
 * otherwise be a second bucket for the same account; anything still starting with `0`
 * after normalising is refused. What is returned is a fixed point of `normalisePhone`
 * (the lookup re-normalises), so the limiter and the lookup see the same string.
 */
export function canonicalPhone(input) {
  const digits = normalisePhone(normaliseDigits(input));
  if (!digits || digits.startsWith('0')) return null;
  return normalisePhone(digits) === digits ? digits : null;
}

/**
 * The IP limiter's key: IPv4 as is, IPv4-mapped IPv6 (`::ffff:a.b.c.d`) as its IPv4,
 * and any other IPv6 address as its /64 — one subscriber usually holds a whole /64, so
 * keying on the full address would hand them 2^64 buckets.
 */
export function ipBucket(ip) {
  if (typeof ip !== 'string' || !ip.trim()) return 'unknown';
  let s = ip.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) return mapped[1];
  if (!s.includes(':')) return s;
  const split = (part) => {
    if (!part) return [];
    const out = part.split(':');
    const last = out.at(-1);
    if (last.includes('.')) {
      const q = last.split('.').map(Number);
      if (q.length !== 4 || q.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
      out.splice(-1, 1, ((q[0] << 8) | q[1]).toString(16), ((q[2] << 8) | q[3]).toString(16));
    }
    return out;
  };
  const halves = s.split('::');
  if (halves.length > 2) return s;
  const head = split(halves[0]);
  const tail = halves.length === 2 ? split(halves[1]) : [];
  if (!head || !tail) return s;
  let groups = head;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return s;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  }
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return s;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/** Send failures lib/wa-send.mjs can report. Anything else is logged as 'other'. */
const SEND_ERRORS = new Set([
  'bad_recipient', 'bad_kind', 'bad_text', 'sending_disabled', 'disabled', 'evolution-not-configured',
  'rate_limited', 'timeout', 'network', 'no_ack',
]);
export function sendErrorLabel(error) {
  const v = typeof error === 'string' ? error : '';
  return SEND_ERRORS.has(v) || /^http_\d{3}$/.test(v) ? v : 'other';
}

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
  // Refused here, not at the first login: a missing sender would otherwise surface only
  // as a code that never arrives, while the page still says "a code is on its way".
  if (typeof sendCode !== 'function') throw new TypeError('createAuth needs a sendCode function');
  const cookieDays = Number(cfg.dashCookieDays ?? 30) > 0 ? Number(cfg.dashCookieDays ?? 30) : 30;
  const sessionTtlMs = cookieDays * DAY_MS;
  const perPhone = createLimiter({ capacity: PHONE_CODES, perMs: CODE_WINDOW_MS, now });
  const perIp = createLimiter({ capacity: IP_CODES, perMs: CODE_WINDOW_MS, now });
  const perMinute = createLimiter({ capacity: GLOBAL_PER_MIN, perMs: 60_000, now });
  const perDay = createLimiter({ capacity: GLOBAL_DAILY_CODES, perMs: DAY_MS, now });
  const inFlight = new Set();
  let lastPrune = -Infinity;
  // Keys `auth_challenges.phone_key`. Generated here and never stored: the database never
  // holds a phone-derived value that could be brute-forced offline. After a restart the
  // older challenges simply are not voided by a new one; they expire within ten minutes,
  // the same for a member and a stranger.
  const phoneSecret = crypto.randomBytes(32);
  const phoneKey = (digits) => crypto.createHmac('sha256', phoneSecret).update(digits, 'utf8').digest('hex');

  const stmts = new Map();
  const prep = (sql) => {
    let s = stmts.get(sql);
    if (!s) { s = db.db.prepare(sql); stmts.set(sql, s); }
    return s;
  };

  /** Sweep expired challenges (kept a day for the budget count) and sessions, once a minute at most. */
  function prune(t) {
    if (t - lastPrune < PRUNE_EVERY_MS) return;
    lastPrune = t;
    prep('DELETE FROM auth_challenges WHERE expires < ?').run(t - DAY_MS);
    prep('DELETE FROM auth_sessions WHERE expires < ?').run(t);
  }

  /** Run `work` in a later macrotask — after the route has written its answer. */
  function later(work) {
    const job = new Promise((resolve) => { setImmediate(() => resolve(work())); })
      .catch((err) => log({ level: 'error', evt: 'dash.code_send_error', error: sendErrorLabel(err?.code) }))
      .finally(() => inFlight.delete(job));
    inFlight.add(job);
  }

  /**
   * Start a login for `phone`. Always `{ ok: true, nonce }` unless a limit refuses or the
   * input is not a phone number — see "Nothing says who is on the team" above.
   * @returns {Promise<{ ok: true, nonce: string } | { ok: false, error: 'rate_limited'|'bad_phone' }>}
   */
  async function requestCode({ phone, ip } = {}) {
    const digits = canonicalPhone(phone);
    if (!digits) return { ok: false, error: 'bad_phone' };
    const gates = [
      [perMinute, 'dashcode:global'], [perDay, 'dashcode:daily'],
      [perIp, `dashcode:ip:${ipBucket(ip)}`], [perPhone, `dashcode:phone:${digits}`],
    ];
    if (gates.some(([limiter, key]) => !limiter.peek(key).ok)) {
      log({ level: 'warn', evt: 'dash.code_rate_limited' });
      return { ok: false, error: 'rate_limited' };
    }
    for (const [limiter, key] of gates) limiter.take(key);

    const t = now();
    prune(t);
    const found = team.getUserByPhone(digits);
    const member = found && found.active ? found : null;
    // The same queries run for a stranger, with a user_id ('') that matches no row.
    const spent = prep('SELECT COUNT(*) AS day, COALESCE(SUM(created > ?), 0) AS hour FROM auth_challenges WHERE user_id = ? AND created > ?')
      .get(t - HOUR_MS, member?.user_id ?? '', t - DAY_MS);
    const real = member && spent.hour < USER_CODES_PER_HOUR && spent.day < USER_CODES_PER_DAY ? member : null;
    const code = generateCode(random);
    const nonce = crypto.randomBytes(16).toString('hex');
    // A decoy's hash is of 32 random hex characters: no six digits can ever match it.
    const codeHash = sha256(real ? code : crypto.randomBytes(16).toString('hex'));
    const key = phoneKey(digits);
    db.transaction(() => {
      // One live challenge per NUMBER, real or decoy alike: every new challenge voids the
      // number's older unused ones. Were only real codes to void, a stranger holding the
      // first of two nonces would see 'used' for a member and 'bad_code' for anyone else.
      // Voiding never un-counts: the budget above counts rows, used or not.
      prep('UPDATE auth_challenges SET used = 1 WHERE phone_key = ? AND used = 0').run(key);
      prep('INSERT INTO auth_challenges (challenge_id, user_id, code_hash, nonce_hash, created, expires, attempts, used, phone_key) VALUES (?,?,?,?,?,?,0,0,?)')
        .run(`CH-${crypto.randomBytes(8).toString('hex')}`, real?.user_id ?? null, codeHash, sha256(nonce), t, t + CODE_TTL_MS, key);
    });

    if (real) {
      later(async () => {
        audit?.record({ userId: real.user_id, action: 'code_request' });
        const res = await sendCode({ jid: real.wa_jid, text: codeMessage(code), kind: 'code', bypassSwitch: real.role === 'owner' });
        if (res?.ok) log({ evt: 'dash.code_sent', expiresInS: CODE_TTL_MS / 1000 });
        else log({ level: 'error', evt: 'dash.code_send_failed', reason: sendErrorLabel(res?.error) });
      });
    } else if (member) {
      later(() => log({ level: 'warn', evt: 'dash.code_budget_spent', role: member.role }));
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
    const t = now();
    prune(t);
    const row = db.checkAuthSession(token, { now: t });
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
  // The nonce only ever goes back to /dashboard/login/code and /dashboard/login/verify.
  const tryAttributes = 'HttpOnly; Secure; SameSite=Lax; Path=/dashboard/login';
  const tryCookieValue = (nonce) => `${TRY_COOKIE_NAME}=${nonce}; ${tryAttributes}; Max-Age=${CODE_TTL_MS / 1000}`;
  const clearedTryCookie = () => `${TRY_COOKIE_NAME}=; ${tryAttributes}; Max-Age=0`;
  // A try cookie set before the path was narrowed (Path=/) lives up to ten minutes; clear it too.
  const clearedLegacyTryCookie = () => `${TRY_COOKIE_NAME}=; ${attributes}; Max-Age=0`;

  function addCookie(res, value) {
    const existing = res.getHeader?.('Set-Cookie');
    const list = existing === undefined ? [] : (Array.isArray(existing) ? existing : [existing]);
    res.setHeader('Set-Cookie', [...list, value]);
    return res;
  }

  const setCookie = (res, token) => addCookie(res, cookieValue(token));
  const clearCookie = (res) => addCookie(res, clearedCookie());
  const setTryCookie = (res, nonce) => addCookie(res, tryCookieValue(nonce));
  const clearTryCookie = (res) => addCookie(addCookie(res, clearedTryCookie()), clearedLegacyTryCookie());

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
