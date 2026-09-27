/**
 * Dashboard login for a team: a code goes to the person's own WhatsApp, belongs to that
 * person and that browser, and says nothing about who is on the team. The clock is
 * injected, so limits and expiries are asserted exactly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../lib/db.mjs';
import { createTeam } from '../lib/team.mjs';
import { createAudit } from '../lib/audit.mjs';
import {
  createAuth, COOKIE_NAME, TRY_COOKIE_NAME, parseCookies, hashEquals, generateCode, codeMessage,
  PHONE_CODES, GLOBAL_PER_MIN, CODE_TTL_MS, MAX_CODE_ATTEMPTS,
} from '../lib/dashboard/auth.mjs';

const NOW = 1_790_500_000_000;
const sha256 = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');
const codeOf = (text) => /(\d{6})/.exec(text ?? '')?.[1] ?? null;

function harness({ send = async () => ({ ok: true }), random = null } = {}) {
  const db = openDb(':memory:');
  let clock = NOW;
  const team = createTeam(db, { now: () => clock });
  const owner = team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const staff = team.addUser({ name: 'Sara', phone: '0500000001', role: 'staff' });
  const audit = createAudit(db, { now: () => clock });
  const sent = [];
  const logs = [];
  const auth = createAuth({
    db, team, audit, cfg: { dashCookieDays: 30 },
    sendCode: async (o) => { sent.push(o); return send(o); },
    now: () => clock, log: (o) => logs.push(o),
    ...(random ? { random } : {}),
  });
  return {
    db, team, audit, auth, owner, staff, sent, logs,
    tick: (ms) => { clock += ms; },
    res: () => {
      const headers = {};
      return {
        getHeader: (k) => headers[k.toLowerCase()],
        setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
        get cookies() { const v = headers['set-cookie']; return v === undefined ? [] : (Array.isArray(v) ? v : [v]); },
      };
    },
  };
}

/** Ask for a code the way the login form does and read the digits off "the phone". */
async function asked(h, phone = '0500000001', ip = '1.1.1.1') {
  const before = h.sent.length;
  const out = await h.auth.requestCode({ phone, ip });
  await h.auth.flush();
  const msg = h.sent.length > before ? h.sent.at(-1) : null;
  return { ...out, msg, code: codeOf(msg?.text) };
}

test('a staff code goes to that person\'s own WhatsApp; the owner\'s may pass the sending switch', async () => {
  const h = harness();
  const s = await asked(h, '0500000001');
  assert.equal(s.ok, true);
  assert.match(s.nonce, /^[0-9a-f]{32}$/);
  assert.equal(s.msg.jid, '966500000001@s.whatsapp.net');
  assert.equal(s.msg.bypassSwitch, false);
  assert.equal(s.msg.text, codeMessage(s.code));
  const o = await asked(h, '+966 59 329 6933', '2.2.2.2');
  assert.equal(o.msg.jid, '966593296933@s.whatsapp.net');
  assert.equal(o.msg.bypassSwitch, true);
  h.db.close();
});

test('a number that is not an active member gets the same answer, a decoy, and no message', async () => {
  const h = harness();
  h.team.deactivateUser(h.staff.user_id);
  for (const phone of ['0511111111', '0500000001']) {
    const out = await asked(h, phone);
    assert.equal(out.ok, true, phone);
    assert.match(out.nonce, /^[0-9a-f]{32}$/);
    assert.equal(out.msg, null, `${phone}: nothing sent`);
    const res = h.auth.verify('123456', null, { nonce: out.nonce });
    assert.deepEqual(res, { ok: false, error: 'bad_code' }, 'a decoy answers exactly like a real code typed wrong');
  }
  assert.equal(h.db.db.prepare('SELECT COUNT(*) AS n FROM auth_challenges WHERE user_id IS NULL').get().n, 2);
  h.db.close();
});

test('a code opens a session for its own person, in its own browser, once', async () => {
  const h = harness();
  const a = await asked(h, '0500000001');
  assert.deepEqual(h.auth.verify(a.code, 'UA', { nonce: null }), { ok: false, error: 'no_request' });
  const other = await asked(h, '0500000001', '3.3.3.3');
  assert.deepEqual(h.auth.verify(a.code, 'UA', { nonce: other.nonce }).error, 'bad_code', "another browser's nonce does not open this code");
  const ok = h.auth.verify(a.code, 'UA', { nonce: a.nonce });
  assert.equal(ok.ok, true);
  assert.equal(ok.user.user_id, h.staff.user_id);
  assert.match(ok.token, /^[0-9a-f]{32}$/);
  assert.equal(h.auth.check(ok.token).user_id, h.staff.user_id, 'check() returns the person');
  assert.equal(h.team.getUser(h.staff.user_id).last_login, NOW);
  assert.deepEqual(h.auth.verify(a.code, 'UA', { nonce: a.nonce }), { ok: false, error: 'used' });
  assert.equal(h.audit.recent(5)[0].action, 'login');
  h.db.close();
});

test('five wrong guesses burn that challenge only; expiry is ten minutes', async () => {
  const h = harness();
  const a = await asked(h, '0500000001');
  for (let i = 0; i < MAX_CODE_ATTEMPTS; i += 1) {
    const wrong = a.code === '000000' ? '111111' : '000000';
    assert.equal(h.auth.verify(wrong, null, { nonce: a.nonce }).error, 'bad_code');
  }
  assert.deepEqual(h.auth.verify(a.code, null, { nonce: a.nonce }), { ok: false, error: 'attempts' });
  const b = await asked(h, '0500000001', '4.4.4.4');
  h.tick(CODE_TTL_MS + 1);
  assert.deepEqual(h.auth.verify(b.code, null, { nonce: b.nonce }), { ok: false, error: 'expired' });
  h.db.close();
});

test('Arabic-Indic digits are the same code', async () => {
  const h = harness();
  const a = await asked(h, '٠٥٠٠٠٠٠٠٠١');
  assert.equal(a.msg.jid, '966500000001@s.whatsapp.net', 'the phone field accepts Arabic digits too');
  const arabic = a.code.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
  assert.equal(h.auth.verify(arabic, null, { nonce: a.nonce }).ok, true);
  h.db.close();
});

test('deactivation ends a live session and voids a code in flight', async () => {
  const h = harness();
  const a = await asked(h, '0500000001');
  const session = h.auth.verify(a.code, null, { nonce: a.nonce });
  const pending = await asked(h, '0500000001', '5.5.5.5');
  h.team.deactivateUser(h.staff.user_id);
  assert.equal(h.auth.check(session.token), null);
  assert.deepEqual(h.auth.verify(pending.code, null, { nonce: pending.nonce }), { ok: false, error: 'no_request' });
  h.db.close();
});

test('limits: three per phone per ten minutes, six a minute overall, asked before charged', async () => {
  const h = harness();
  for (let i = 0; i < PHONE_CODES; i += 1) assert.equal((await asked(h, '0500000001', `10.0.0.${i}`)).ok, true);
  assert.deepEqual(await h.auth.requestCode({ phone: '0500000001', ip: '10.0.1.1' }), { ok: false, error: 'rate_limited' });
  // 10.0.1.1 was refused by the phone bucket; its own IP bucket was not charged.
  h.tick(60_000);
  for (let i = 0; i < 3; i += 1) assert.equal((await h.auth.requestCode({ phone: `05111111${10 + i}`, ip: '10.0.1.1' })).ok, true, `ip try ${i}`);
  h.tick(60_000);
  for (let i = 0; i < GLOBAL_PER_MIN; i += 1) assert.equal((await h.auth.requestCode({ phone: `05222222${10 + i}`, ip: `10.0.2.${i}` })).ok, true);
  assert.deepEqual(await h.auth.requestCode({ phone: '0533333333', ip: '10.0.3.1' }), { ok: false, error: 'rate_limited' });
  assert.deepEqual(await h.auth.requestCode({ phone: 'abc', ip: '10.0.3.2' }), { ok: false, error: 'bad_phone' });
  h.db.close();
});

test('nothing readable is stored and the code is never logged', async () => {
  // A fixed code that cannot occur inside the timestamps in the dump, so the test cannot flake.
  const h = harness({ random: () => 482913 });
  const a = await asked(h, '0500000001');
  const ok = h.auth.verify(a.code, null, { nonce: a.nonce });
  const dump = JSON.stringify([
    h.db.db.prepare('SELECT * FROM auth_challenges').all(),
    h.db.db.prepare('SELECT * FROM auth_sessions').all(),
    h.db.db.prepare('SELECT * FROM audit_log').all(),
    h.logs,
  ]);
  for (const secret of [a.code, a.nonce, ok.token]) assert.ok(!dump.includes(secret), 'secret leaked');
  assert.ok(dump.includes(sha256(a.nonce)));
  h.db.close();
});

test('a failed send is logged and the login page still says "sent"', async () => {
  const h = harness({ send: async () => ({ ok: false, error: 'http_500' }) });
  const a = await asked(h, '0500000001');
  assert.equal(a.ok, true);
  assert.ok(h.logs.some((l) => l.evt === 'dash.code_send_failed' && l.reason === 'http_500'));
  h.db.close();
});

test('helpers: code shape, message, constant-time compare, cookies', () => {
  assert.equal(generateCode(() => 42), '000042');
  assert.equal(codeMessage('123456'), 'Bona dashboard code: 123456 (valid 10 min)');
  assert.equal(hashEquals(sha256('a'), sha256('a')), true);
  assert.equal(hashEquals(sha256('a'), sha256('b')), false);
  assert.equal(hashEquals('ab', 'abcd'), false);
  assert.deepEqual(parseCookies('a=1; bona_dash=x%20y; bad'), { a: '1', bona_dash: 'x y' });
  const h = harness();
  const res = h.res();
  h.auth.setCookie(res, 'f'.repeat(32));
  h.auth.setTryCookie(res, 'e'.repeat(32));
  assert.match(res.cookies[0], new RegExp(`^${COOKIE_NAME}=f{32}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000$`));
  assert.match(res.cookies[1], new RegExp(`^${TRY_COOKIE_NAME}=e{32}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600$`));
  h.db.close();
});
