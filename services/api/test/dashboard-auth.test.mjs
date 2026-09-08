/**
 * Dashboard login. The clock is injected everywhere, so the rate limits and the
 * expiries are asserted exactly rather than waited for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../lib/db.mjs';
import { createAuth, COOKIE_NAME, TRY_COOKIE_NAME, parseCookies, hashEquals, generateCode, codeMessage } from '../lib/dashboard/auth.mjs';

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
    /** A response double: the cookie helpers only read and append `Set-Cookie`. */
    res: () => {
      const headers = {};
      return {
        headers,
        getHeader: (k) => headers[k.toLowerCase()],
        setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
        get cookies() { const v = headers['set-cookie']; return v === undefined ? [] : (Array.isArray(v) ? v : [v]); },
      };
    },
  };
}

/** Ask for a code and read back both halves of it: the digits and the browser's nonce. */
async function asked(h, ip = '1.1.1.1') {
  const out = await h.auth.requestCode(ip);
  return { ...out, code: codeOf(h.sent.at(-1) ?? '') };
}

/* ---------------- code request ---------------- */

test('requestCode sends six digits to the owner and stores only their hash', async () => {
  const h = harness();
  const out = await h.auth.requestCode('1.1.1.1');
  assert.equal(out.ok, true);
  assert.match(out.nonce, /^[0-9a-f]{32}$/, 'the request hands the browser a nonce to come back with');
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
    assert.equal((await h.auth.requestCode('9.9.9.9')).ok, true, `request ${i + 1}`);
    h.tick(61_000); // step past the global one-a-minute limit, stay inside the ten minutes
  }
  assert.deepEqual(await h.auth.requestCode('9.9.9.9'), { ok: false, error: 'rate_limited' });
  assert.equal(h.sent.length, 3, 'the refused request sent nothing');
  // Another address is unaffected by the first one's spending.
  h.tick(61_000);
  assert.equal((await h.auth.requestCode('8.8.8.8')).ok, true);
});

test('one code a minute across the whole service, whoever asks', async () => {
  const h = harness();
  assert.equal((await h.auth.requestCode('1.1.1.1')).ok, true);
  assert.deepEqual(await h.auth.requestCode('2.2.2.2'), { ok: false, error: 'rate_limited' });
  h.tick(60_001);
  assert.equal((await h.auth.requestCode('2.2.2.2')).ok, true);
});

test('a daily ceiling caps the flood, and refills fast enough not to be a lockout', async () => {
  const h = harness();
  // Drain it as fast as the one-a-minute bucket allows, from rotating addresses so the
  // per-IP limit never bites. The daily bucket refills while this runs, which is the
  // point: it paces the flood rather than stopping it dead.
  let sends = 0;
  let refused = 0;
  for (let i = 0; i < 200 && refused === 0; i += 1) {
    const out = await h.auth.requestCode(`10.0.${Math.floor(i / 250)}.${i % 250}`);
    if (out.ok) sends += 1; else refused += 1;
    h.tick(61_000);
  }
  assert.equal(refused, 1, 'the ceiling does eventually refuse');
  assert.ok(sends >= 60 && sends <= 66, `sixty-ish messages, not fourteen hundred — got ${sends}`);
  assert.equal(h.sent.length, sends);

  // And it is not a lockout: the bucket refills continuously, so the owner's next code
  // is about twenty-four minutes away rather than tomorrow.
  h.tick(25 * 60_000);
  assert.equal((await h.auth.requestCode('10.9.9.9')).ok, true);
});

test('one address cannot drain the whole service\'s day on its way to being refused', async () => {
  const h = harness();
  for (let i = 0; i < 3; i += 1) { assert.equal((await h.auth.requestCode('5.5.5.5')).ok, true); h.tick(61_000); }

  // Its own three are gone and the clock does not move, so the only limit refusing these
  // forty is the per-IP one — the shared minute still has a token to give. Every one of
  // them must cost the shared buckets nothing.
  for (let i = 0; i < 40; i += 1) {
    assert.deepEqual(await h.auth.requestCode('5.5.5.5'), { ok: false, error: 'rate_limited' }, `attempt ${i + 1}`);
  }
  assert.equal(h.sent.length, 3, 'nothing more was sent');

  // The proof: the day is still worth a full ceiling. Charge the globals before the
  // per-IP check and those forty refusals would have eaten most of it.
  let sends = 0;
  for (let i = 0; i < 120; i += 1) {
    if ((await h.auth.requestCode(`10.0.0.${i}`)).ok) sends += 1; else break;
    h.tick(61_000);
  }
  // Charging the globals before the per-IP check leaves about twenty here, not sixty.
  assert.ok(sends >= 50, `the refusals ate the day's ceiling — only ${sends} codes left in it`);
});

test('a global refusal is free for the address that hit it', async () => {
  const h = harness();
  assert.equal((await h.auth.requestCode('1.1.1.1')).ok, true);
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(await h.auth.requestCode('7.7.7.7'), { ok: false, error: 'rate_limited' }, 'refused by the one-a-minute bucket');
  }
  for (let i = 0; i < 3; i += 1) {
    h.tick(61_000);
    assert.equal((await h.auth.requestCode('7.7.7.7')).ok, true, `this address still has all three (${i + 1})`);
  }
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
  const { code, nonce } = await asked(h);

  const out = h.auth.verify(code, 'Mozilla/5.0 (iPhone)', { nonce });
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

test('a code is single use, and its nonce dies with it', async () => {
  const h = harness();
  const { code, nonce } = await asked(h);
  assert.equal(h.auth.verify(code, null, { nonce }).ok, true);
  assert.deepEqual(h.auth.verify(code, null, { nonce }), { ok: false, error: 'no_request' });
  assert.equal(h.auth.pendingCount(), 0);
});

test('five wrong guesses from the browser that asked burn its code', async () => {
  const h = harness();
  const { code, nonce } = await asked(h);
  const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(h.auth.verify(wrong, null, { nonce }), { ok: false, error: 'bad_code' }, `guess ${i + 1}`);
  }
  assert.deepEqual(h.auth.verify(code, null, { nonce }), { ok: false, error: 'attempts' },
    'the real code is dead once five guesses have missed');
});

test('a stranger cannot burn the code the owner is holding', async () => {
  const h = harness();
  const owner = await asked(h);

  // No nonce at all, a forged one, and one from a different request: none of these may
  // spend the owner's five attempts. Without this the login is a permanent lockout —
  // the sender is capped at one code a minute, so an attacker wins that race for ever.
  const forged = 'f'.repeat(32);
  for (let i = 0; i < 30; i += 1) {
    assert.deepEqual(h.auth.verify('000000', null, {}), { ok: false, error: 'no_request' });
    assert.deepEqual(h.auth.verify('000000', null, { nonce: forged }), { ok: false, error: 'no_request' });
    assert.deepEqual(h.auth.verify('000000', null, { nonce: 'not-a-nonce' }), { ok: false, error: 'no_request' });
  }

  const out = h.auth.verify(owner.code, null, { nonce: owner.nonce });
  assert.equal(out.ok, true, 'the owner still gets in');
  assert.match(out.token, /^[0-9a-f]{32}$/);
});

test('a second attacker who asks for their own code burns only their own', async () => {
  const h = harness();
  const owner = await asked(h, '1.1.1.1');
  h.tick(61_000);
  const attacker = await asked(h, '2.2.2.2');
  const wrong = String((Number(attacker.code) + 1) % 1_000_000).padStart(6, '0');
  for (let i = 0; i < 6; i += 1) h.auth.verify(wrong, null, { nonce: attacker.nonce });

  assert.equal(h.auth.verify(owner.code, null, { nonce: owner.nonce }).ok, true);
});

test('a code expires after ten minutes', async () => {
  const h = harness();
  const { code, nonce } = await asked(h);
  h.tick(10 * 60_000 + 1);
  assert.deepEqual(h.auth.verify(code, null, { nonce }), { ok: false, error: 'no_request' },
    'the binding expires with the code, so there is nothing left to guess against');
  assert.equal(h.auth.pendingCount(), 0);
});

test('a session expires with the cookie, and logout ends it early', async () => {
  const h = harness({ cfg: { dashCookieDays: 2 } });
  const first = await asked(h);
  const { token } = h.auth.verify(first.code, null, { nonce: first.nonce });
  assert.equal(h.auth.check(token), true);
  h.tick(2 * 86_400_000 + 1);
  assert.equal(h.auth.check(token), false, 'the session died with the cookie');

  const h2 = harness();
  const other = await asked(h2);
  const second = h2.auth.verify(other.code, null, { nonce: other.nonce }).token;
  assert.equal(h2.auth.logout(second), true);
  assert.equal(h2.auth.check(second), false);
  assert.equal(h2.auth.logout(second), false, 'logging out twice is not an error, just a no-op');
});

/* ---------------- cookie ---------------- */

test('the cookie is HttpOnly, Secure, SameSite=Lax and site-wide', async () => {
  const h = harness({ cfg: { dashCookieDays: 30 } });
  const { code, nonce } = await asked(h);
  const { token } = h.auth.verify(code, null, { nonce });

  const res = h.res();
  h.auth.setCookie(res, token);
  const cookie = res.cookies[0];
  assert.match(cookie, new RegExp(`^${COOKIE_NAME}=${token};`));
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', `Max-Age=${30 * 86_400}`]) {
    assert.ok(cookie.includes(flag), `${flag} missing from ${cookie}`);
  }

  const cleared = h.res();
  h.auth.clearCookie(cleared);
  assert.ok(cleared.cookies[0].includes('Max-Age=0'));

  // The try nonce is the same shape and lives exactly as long as the code.
  const tryRes = h.res();
  h.auth.setTryCookie(tryRes, nonce);
  assert.match(tryRes.cookies[0], new RegExp(`^${TRY_COOKIE_NAME}=${nonce};`));
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=600']) {
    assert.ok(tryRes.cookies[0].includes(flag), `${flag} missing from ${tryRes.cookies[0]}`);
  }
  assert.equal(h.auth.readTryCookie({ headers: { cookie: `${TRY_COOKIE_NAME}=${nonce}` } }), nonce);
  assert.equal(h.auth.readTryCookie({ headers: { cookie: `${TRY_COOKIE_NAME}=zzz` } }), null);

  // Both cookies can ride one response.
  const both = h.res();
  h.auth.setCookie(both, token);
  h.auth.clearTryCookie(both);
  assert.equal(both.cookies.length, 2);

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
