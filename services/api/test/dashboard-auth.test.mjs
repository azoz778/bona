/**
 * Dashboard login. The clock is injected everywhere, so the rate limits and the
 * expiries are asserted exactly rather than waited for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../lib/db.mjs';
import { createAuth, COOKIE_NAME, parseCookies, hashEquals, generateCode, codeMessage } from '../lib/dashboard/auth.mjs';

const NOW = 1_757_200_000_000;
const sha256 = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');
/** The six digits out of the WhatsApp message — exactly what the owner reads off the phone. */
const codeOf = (text) => /(\d{6})/.exec(text)?.[1] ?? null;

function harness({ send = async () => ({ ok: true }), cfg = {} } = {}) {
  const db = openDb(':memory:');
  const sent = [];
  const logs = [];
  let clock = NOW;
  const auth = createAuth({
    db,
    cfg: { dashCookieDays: 30, ...cfg },
    sendWhatsApp: async (text) => { sent.push(text); return send(text); },
    now: () => clock,
    log: (obj) => logs.push(obj),
  });
  return {
    db, auth, sent, logs,
    tick: (ms) => { clock += ms; },
    get clock() { return clock; },
    /** A response double: only `setHeader` is used by the cookie helpers. */
    res: () => { const headers = {}; return { headers, setHeader: (k, v) => { headers[k.toLowerCase()] = v; } }; },
  };
}

/* ---------------- code request ---------------- */

test('requestCode sends six digits to the owner and stores only their hash', async () => {
  const h = harness();
  assert.deepEqual(await h.auth.requestCode('1.1.1.1'), { ok: true });
  assert.equal(h.sent.length, 1);
  const code = codeOf(h.sent[0]);
  assert.match(code, /^\d{6}$/);
  assert.equal(h.sent[0], `Bona dashboard code: ${code} (valid 10 min)`);

  const rows = h.db.db.prepare('SELECT * FROM auth_codes').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code_hash, sha256(code), 'the row must be the hash, not the code');
  assert.equal(rows[0].expires - rows[0].created, 10 * 60_000, 'ten minutes');
  assert.ok(!JSON.stringify(rows).includes(code), 'the plaintext code is nowhere in the table');
});

test('the code never reaches a log line', async () => {
  const h = harness();
  await h.auth.requestCode('1.1.1.1');
  const code = codeOf(h.sent[0]);
  const printed = JSON.stringify(h.logs);
  assert.ok(!printed.includes(code), `the log leaked the code: ${printed}`);
});

test('a fourth code inside ten minutes from one address is refused', async () => {
  const h = harness();
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(await h.auth.requestCode('9.9.9.9'), { ok: true }, `request ${i + 1}`);
    h.tick(61_000); // step past the global one-a-minute limit, stay inside the ten minutes
  }
  assert.deepEqual(await h.auth.requestCode('9.9.9.9'), { ok: false, error: 'rate_limited' });
  assert.equal(h.sent.length, 3, 'the refused request sent nothing');
  // Another address is unaffected by the first one's spending.
  assert.deepEqual(await h.auth.requestCode('8.8.8.8'), { ok: true });
});

test('one code a minute across the whole service, whoever asks', async () => {
  const h = harness();
  assert.deepEqual(await h.auth.requestCode('1.1.1.1'), { ok: true });
  assert.deepEqual(await h.auth.requestCode('2.2.2.2'), { ok: false, error: 'rate_limited' });
  h.tick(60_001);
  assert.deepEqual(await h.auth.requestCode('2.2.2.2'), { ok: true });
});

test('a WhatsApp that will not send is reported, not swallowed', async () => {
  const failing = harness({ send: async () => ({ ok: false, error: 'evolution-not-configured' }) });
  assert.deepEqual(await failing.auth.requestCode('1.1.1.1'), { ok: false, error: 'send_failed' });

  const throwing = harness({ send: async () => { throw new Error('network'); } });
  assert.deepEqual(await throwing.auth.requestCode('1.1.1.1'), { ok: false, error: 'send_failed' });
});

/* ---------------- verify ---------------- */

test('the right code opens a session; the token is 32 hex and stored hashed', async () => {
  const h = harness();
  await h.auth.requestCode('1.1.1.1');
  const code = codeOf(h.sent[0]);

  const out = h.auth.verify(code, 'Mozilla/5.0 (iPhone)');
  assert.equal(out.ok, true);
  assert.match(out.token, /^[0-9a-f]{32}$/);

  const rows = h.db.db.prepare('SELECT * FROM auth_sessions').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, sha256(out.token));
  assert.equal(rows[0].ua, 'Mozilla/5.0 (iPhone)');
  assert.equal(rows[0].expires - rows[0].created, 30 * 86_400_000);

  assert.equal(h.auth.check(out.token), true);
  assert.equal(h.auth.check('f'.repeat(32)), false, 'an unknown token is not a session');
  assert.equal(h.auth.check('not-hex'), false);
  assert.equal(h.auth.check(null), false);
});

test('a code is single use', async () => {
  const h = harness();
  await h.auth.requestCode('1.1.1.1');
  const code = codeOf(h.sent[0]);
  assert.equal(h.auth.verify(code).ok, true);
  const again = h.auth.verify(code);
  assert.equal(again.ok, false);
  assert.equal(again.error, 'used');
});

test('five wrong guesses burn the code', async () => {
  const h = harness();
  await h.auth.requestCode('1.1.1.1');
  const code = codeOf(h.sent[0]);
  const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
  for (let i = 0; i < 5; i += 1) assert.equal(h.auth.verify(wrong).ok, false, `guess ${i + 1}`);
  const out = h.auth.verify(code);
  assert.equal(out.ok, false, 'the real code is dead once five guesses have missed');
  assert.equal(out.error, 'attempts');
});

test('a code expires after ten minutes', async () => {
  const h = harness();
  await h.auth.requestCode('1.1.1.1');
  const code = codeOf(h.sent[0]);
  h.tick(10 * 60_000 + 1);
  assert.deepEqual(h.auth.verify(code), { ok: false, error: 'expired' });
});

test('a session expires with the cookie, and logout ends it early', async () => {
  const h = harness({ cfg: { dashCookieDays: 2 } });
  await h.auth.requestCode('1.1.1.1');
  const { token } = h.auth.verify(codeOf(h.sent[0]));
  assert.equal(h.auth.check(token), true);
  h.tick(2 * 86_400_000 + 1);
  assert.equal(h.auth.check(token), false, 'the session died with the cookie');

  const h2 = harness();
  await h2.auth.requestCode('1.1.1.1');
  const second = h2.auth.verify(codeOf(h2.sent[0])).token;
  assert.equal(h2.auth.logout(second), true);
  assert.equal(h2.auth.check(second), false);
  assert.equal(h2.auth.logout(second), false, 'logging out twice is not an error, just a no-op');
});

/* ---------------- cookie ---------------- */

test('the cookie is HttpOnly, Secure, SameSite=Lax and site-wide', async () => {
  const h = harness({ cfg: { dashCookieDays: 30 } });
  await h.auth.requestCode('1.1.1.1');
  const { token } = h.auth.verify(codeOf(h.sent[0]));

  const res = h.res();
  h.auth.setCookie(res, token);
  const cookie = res.headers['set-cookie'];
  assert.match(cookie, new RegExp(`^${COOKIE_NAME}=${token};`));
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', `Max-Age=${30 * 86_400}`]) {
    assert.ok(cookie.includes(flag), `${flag} missing from ${cookie}`);
  }

  const cleared = h.res();
  h.auth.clearCookie(cleared);
  assert.ok(cleared.headers['set-cookie'].includes('Max-Age=0'));

  assert.equal(h.auth.readCookie({ headers: { cookie: `other=1; ${COOKIE_NAME}=${token}` } }), token);
  assert.equal(h.auth.readCookie({ headers: { cookie: `${COOKIE_NAME}=nope` } }), null, 'a malformed token is not read');
  assert.equal(h.auth.readCookie({ headers: {} }), null);
});

test('parseCookies survives the junk a browser sends', () => {
  assert.deepEqual(parseCookies('a=1; b=two; =bad; c'), { a: '1', b: 'two' });
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('x=%E2%80%A6'), { x: '…' });
});

/* ---------------- primitives ---------------- */

test('hashEquals is length-safe and value-correct', () => {
  assert.equal(hashEquals(sha256('a'), sha256('a')), true);
  assert.equal(hashEquals(sha256('a'), sha256('b')), false);
  assert.equal(hashEquals('abcd', 'abcdef'), false, 'different lengths must not throw');
  assert.equal(hashEquals('', ''), false);
  assert.equal(hashEquals(null, undefined), false);
});

test('generateCode keeps leading zeros and codeMessage says how long it lives', () => {
  assert.equal(generateCode(() => 42), '000042');
  assert.equal(generateCode(() => 999_999), '999999');
  assert.equal(codeMessage('000042'), 'Bona dashboard code: 000042 (valid 10 min)');
});
