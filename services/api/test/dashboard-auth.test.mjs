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
  createAuth, COOKIE_NAME, TRY_COOKIE_NAME, parseCookies, hashEquals, generateCode, codeMessage, isCodeMessage,
  PHONE_CODES, GLOBAL_PER_MIN, CODE_TTL_MS, MAX_CODE_ATTEMPTS, DAY_MS,
  canonicalPhone, ipBucket, sendErrorLabel, USER_CODES_PER_HOUR, USER_CODES_PER_DAY,
} from '../lib/dashboard/auth.mjs';
import { normalisePhone } from '../lib/phone.mjs';

const NOW = 1_790_500_000_000;
const sha256 = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');
const codeOf = (text) => /(\d{6})/.exec(text ?? '')?.[1] ?? null;

function harness({ send = async () => ({ ok: true }), random = null, db = openDb(':memory:'), clockAt = NOW } = {}) {
  let clock = clockAt;
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
    get clock() { return clock; },
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
  const stranger = await asked(h, '0511111111', '3.3.3.3');
  assert.deepEqual(h.auth.verify(a.code, 'UA', { nonce: stranger.nonce }).error, 'bad_code', "another browser's nonce does not open this code");
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
  assert.deepEqual(h.auth.verify(pending.code, null, { nonce: pending.nonce }), { ok: false, error: 'bad_code' }, 'void, and answering like a decoy');
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

test('createAuth refuses to be built without a team store or a code sender', () => {
  const db = openDb(':memory:');
  const team = createTeam(db);
  assert.throws(() => createAuth({ db, sendCode: async () => ({ ok: true }) }), /needs the team store/);
  for (const sendCode of [undefined, null, 'send', {}]) {
    assert.throws(() => createAuth({ db, team, sendCode }), { name: 'TypeError', message: /needs a sendCode function/ });
  }
  assert.doesNotThrow(() => createAuth({ db, team, sendCode: async () => ({ ok: true }) }));
  db.close();
});

test('helpers: code shape, message, constant-time compare, cookies', () => {
  assert.equal(generateCode(() => 42), '000042');
  assert.equal(codeMessage('123456'), 'Bona dashboard code: 123456 (valid 10 min)');
  assert.equal(isCodeMessage(codeMessage(generateCode())), true, 'every code message is recognised');
  assert.equal(isCodeMessage(`  ${codeMessage('000042')}\n`), true, 'spaces around it aside');
  for (const other of ['Your viewing code is 123456', `${codeMessage('123456')} thanks`, codeMessage('12345'), null, 123456]) {
    assert.equal(isCodeMessage(other), false, String(other));
  }
  assert.equal(hashEquals(sha256('a'), sha256('a')), true);
  assert.equal(hashEquals(sha256('a'), sha256('b')), false);
  assert.equal(hashEquals('ab', 'abcd'), false);
  assert.deepEqual(parseCookies('a=1; bona_dash=x%20y; bad'), { a: '1', bona_dash: 'x y' });
  const h = harness();
  const res = h.res();
  h.auth.setCookie(res, 'f'.repeat(32));
  h.auth.setTryCookie(res, 'e'.repeat(32));
  assert.match(res.cookies[0], new RegExp(`^${COOKIE_NAME}=f{32}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000$`));
  // The try cookie only ever goes back to /dashboard/login/{code,verify}.
  assert.match(res.cookies[1], new RegExp(`^${TRY_COOKIE_NAME}=e{32}; HttpOnly; Secure; SameSite=Lax; Path=/dashboard/login; Max-Age=600$`));
  const cleared = h.res();
  h.auth.clearTryCookie(cleared);
  assert.ok(cleared.cookies.some((c) => c.includes('Path=/dashboard/login;') && c.includes('Max-Age=0')));
  assert.ok(cleared.cookies.some((c) => c.includes('Path=/;') && c.includes('Max-Age=0')), 'a pre-deploy Path=/ try cookie is cleared too');
  h.db.close();
});

/* -------------------- security review fixes (Task 6 follow-up) -------------------- */

const settle = () => new Promise((r) => setImmediate(r));

test('member-only work starts after the answer: nothing audited or sent when requestCode resolves', async () => {
  const h = harness();
  const order = [];
  const record = h.audit.record;
  h.audit.record = (o) => { order.push('audit'); return record(o); };
  const p = h.auth.requestCode({ phone: '0500000001', ip: '1.1.1.1' }).then((out) => { order.push('answered'); return out; });
  order.push('sync-return');
  const out = await p;
  assert.equal(out.ok, true);
  assert.deepEqual(order, ['sync-return', 'answered'], 'no member work in the synchronous or microtask phase');
  assert.equal(h.audit.recent(5).length, 0);
  assert.equal(h.sent.length, 0);
  await settle(); await settle();
  assert.deepEqual(order, ['sync-return', 'answered', 'audit']);
  assert.equal(h.audit.recent(5)[0].action, 'code_request');
  assert.equal(h.sent.length, 1);
  await h.auth.flush();
  h.db.close();
});

test('one canonical phone key: non-canonical spellings are refused or share a bucket', async () => {
  for (const input of ['966593296933', '+966 59 329 6933', '0593296933', '593296933', '00966593296933', '٠٥٩٣٢٩٦٩٣٣', '441234567890']) {
    const canon = canonicalPhone(input);
    assert.ok(canon, input);
    assert.equal(normalisePhone(canon), canon, `${input}: canonical form is a fixed point`);
    assert.ok(!canon.startsWith('0'), input);
  }
  assert.equal(canonicalPhone('0000966593296933'), null);
  assert.equal(canonicalPhone('00000593296933'), null);
  const h = harness();
  assert.deepEqual(await h.auth.requestCode({ phone: '0000966593296933', ip: '9.9.9.1' }), { ok: false, error: 'bad_phone' });
  assert.deepEqual(await h.auth.requestCode({ phone: '00000593296933', ip: '9.9.9.2' }), { ok: false, error: 'bad_phone' });
  // Every accepted spelling of the owner lands in the same per-phone bucket.
  for (const [i, phone] of ['966593296933', '00966593296933', '0593296933'].entries()) {
    assert.equal((await h.auth.requestCode({ phone, ip: `9.9.8.${i}` })).ok, true);
  }
  assert.deepEqual(await h.auth.requestCode({ phone: '+966593296933', ip: '9.9.7.1' }), { ok: false, error: 'rate_limited' });
  await h.auth.flush();
  h.db.close();
});

test('one live challenge per person: a newer code voids the older one', async () => {
  const h = harness();
  const a = await asked(h, '0500000001', '1.1.1.1');
  const b = await asked(h, '0500000001', '1.1.1.2');
  assert.deepEqual(h.auth.verify(a.code, null, { nonce: a.nonce }), { ok: false, error: 'used' });
  assert.equal(h.auth.verify(b.code, null, { nonce: b.nonce }).ok, true);
  // A stranger's request touches nobody's live challenge.
  const c = await asked(h, '0500000001', '1.1.1.3');
  await asked(h, '0511111111', '1.1.1.4');
  assert.equal(h.auth.verify(c.code, null, { nonce: c.nonce }).ok, true);
  h.db.close();
});

test('two codes then a wrong one on the first: a member, a stranger and a deactivated member answer alike', async () => {
  const h = harness({ random: () => 482913 });
  h.team.addUser({ name: 'Omar', phone: '0500000002', role: 'staff' });
  h.team.deactivateUser(h.team.getUserByPhone('966500000002').user_id);
  const answers = {};
  let n = 0;
  for (const [who, phone] of [['member', '0500000001'], ['stranger', '0511111111'], ['deactivated', '0500000002']]) {
    const first = await asked(h, phone, `9.0.0.${n += 1}`);
    const second = await asked(h, phone, `9.0.0.${n += 1}`);
    answers[who] = [
      h.auth.verify('000000', null, { nonce: first.nonce }),
      h.auth.verify('000000', null, { nonce: second.nonce }),
    ];
    if (who === 'member') {
      assert.ok(second.code, 'the member was sent a second code');
      assert.equal(h.auth.verify(second.code, null, { nonce: second.nonce }).ok, true, "the member's newest code still works");
    }
  }
  assert.deepEqual(answers.member, [{ ok: false, error: 'used' }, { ok: false, error: 'bad_code' }]);
  assert.deepEqual(answers.stranger, answers.member, 'a stranger reads exactly like a member');
  assert.deepEqual(answers.deactivated, answers.member, 'so does a deactivated member');
  // A request for one number never touches another number's live challenge.
  h.tick(60_000); // past the six-a-minute global cap
  const mine = await asked(h, '0500000001', '9.0.1.1');
  await asked(h, '0511111111', '9.0.1.2');
  assert.equal(h.auth.verify(mine.code, null, { nonce: mine.nonce }).ok, true);
  // Nothing phone-derived that could be brute-forced offline: the key is per process.
  for (const row of h.db.db.prepare('SELECT phone_key FROM auth_challenges').all()) {
    assert.match(row.phone_key, /^[0-9a-f]{64}$/);
    for (const d of ['966500000001', '966511111111', '966500000002']) assert.notEqual(row.phone_key, sha256(d));
  }
  h.db.close();
});

test('an over-budget decoy voids the older real code, exactly as a new real code would', async () => {
  const h = harness({ random: () => 482913 });
  let last = null;
  for (let i = 0; i < USER_CODES_PER_HOUR; i += 1) { last = await asked(h, '0500000001', `9.1.0.${i}`); assert.ok(last.msg); h.tick(4 * 60_000); }
  const over = await asked(h, '0500000001', '9.1.1.1');
  assert.equal(over.msg, null);
  assert.deepEqual(h.auth.verify('482913', null, { nonce: last.nonce }), { ok: false, error: 'used' });
  assert.deepEqual(h.auth.verify('482913', null, { nonce: over.nonce }), { ok: false, error: 'bad_code' });
  h.db.close();
});

test('a code in flight when its member is deactivated then answers like a decoy', async () => {
  const h = harness({ random: () => 482913 });
  const pending = await asked(h, '0500000001');
  const stranger = await asked(h, '0511111111', '9.2.0.1');
  h.team.deactivateUser(h.staff.user_id);
  assert.deepEqual(h.auth.verify('000000', null, { nonce: pending.nonce }), h.auth.verify('000000', null, { nonce: stranger.nonce }));
  assert.deepEqual(h.auth.verify(pending.code, null, { nonce: pending.nonce }), { ok: false, error: 'bad_code' }, 'the right code no longer opens anything');
  h.db.close();
});

test('per-person code budget: over five an hour the answer is a decoy', async () => {
  const h = harness({ random: () => 482913 });
  for (let i = 0; i < USER_CODES_PER_HOUR; i += 1) {
    assert.ok((await asked(h, '0500000001', `7.0.0.${i}`)).msg, `code ${i} sent`);
    h.tick(4 * 60_000);
  }
  const over = await asked(h, '0500000001', '7.0.1.1');
  assert.equal(over.ok, true);
  assert.match(over.nonce, /^[0-9a-f]{32}$/);
  assert.equal(over.msg, null, 'nothing sent over budget');
  assert.deepEqual(h.auth.verify('482913', null, { nonce: over.nonce }), { ok: false, error: 'bad_code' });
  h.db.close();
});

test('per-person code budget: the 11th code in a day is a decoy, and a restart keeps the count', async () => {
  const db = openDb(':memory:');
  const h = harness({ db, random: () => 482913 });
  for (let i = 0; i < USER_CODES_PER_DAY; i += 1) {
    assert.ok((await asked(h, '0500000001', `8.0.0.${i}`)).msg, `code ${i} sent`);
    h.tick(13 * 60_000);
  }
  const over = await asked(h, '0500000001', '8.0.1.1');
  assert.equal(over.msg, null, '11th in a day: no send');
  assert.deepEqual(h.auth.verify('482913', null, { nonce: over.nonce }), { ok: false, error: 'bad_code' });
  // A restart: a fresh createAuth on the same database (fresh in-memory limiters).
  const sent = [];
  const again = createAuth({
    db, team: h.team, audit: h.audit, cfg: {}, now: () => h.clock, random: () => 482913,
    sendCode: async (o) => { sent.push(o); return { ok: true }; },
  });
  const after = await again.requestCode({ phone: '0500000001', ip: '8.0.2.1' });
  await again.flush();
  assert.equal(after.ok, true);
  assert.equal(sent.length, 0, 'the budget survived the restart');
  // A day later the budget has refilled.
  h.tick(DAY_MS);
  const later = await again.requestCode({ phone: '0500000001', ip: '8.0.3.1' });
  await again.flush();
  assert.equal(sent.length, 1);
  assert.equal(again.verify('482913', null, { nonce: later.nonce }).ok, true);
  db.close();
});

test('expired challenges and sessions are pruned without a timer', async () => {
  const h = harness();
  const a = await asked(h, '0500000001', '6.0.0.1');
  const session = h.auth.verify(a.code, null, { nonce: a.nonce });
  assert.equal(session.ok, true);
  h.tick(31 * DAY_MS);
  await asked(h, '0511111111', '6.0.0.2');
  const n = (t) => h.db.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  assert.equal(n('auth_sessions'), 0, 'the expired session was pruned by a code request');
  assert.equal(n('auth_challenges'), 1, 'only the fresh challenge remains');
  // check() prunes too, at most once a minute, even for a token it has never seen.
  const b = await asked(h, '0500000001', '6.0.0.3');
  h.auth.verify(b.code, null, { nonce: b.nonce });
  h.tick(31 * DAY_MS);
  assert.equal(h.auth.check('a'.repeat(32)), null);
  assert.equal(n('auth_sessions'), 0, 'check() pruned the expired session');
  h.db.close();
});

test('send errors are logged by allowlisted label only', async () => {
  assert.equal(sendErrorLabel('http_500'), 'http_500');
  assert.equal(sendErrorLabel('sending_disabled'), 'sending_disabled');
  assert.equal(sendErrorLabel('966500000001@s.whatsapp.net refused'), 'other');
  assert.equal(sendErrorLabel(undefined), 'other');
  const h = harness({ send: async () => ({ ok: false, error: 'boom 966500000001' }) });
  await asked(h, '0500000001');
  assert.ok(h.logs.some((l) => l.evt === 'dash.code_send_failed' && l.reason === 'other'));
  const t = harness({ send: async () => { const e = new Error('966500000001'); e.code = '966500000001'; throw e; } });
  await asked(t, '0500000001');
  assert.ok(t.logs.some((l) => l.evt === 'dash.code_send_error' && l.error === 'other'));
  assert.ok(!JSON.stringify(t.logs).includes('966500000001'));
  h.db.close(); t.db.close();
});

test('IPv6 callers share an IP bucket per /64; IPv4-mapped addresses count as IPv4', async () => {
  assert.equal(ipBucket('1.2.3.4'), '1.2.3.4');
  assert.equal(ipBucket('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(ipBucket('2001:db8:0:1::1'), '2001:db8:0:1::/64');
  assert.equal(ipBucket('2001:DB8:0:1:ffff:1:2:3'), '2001:db8:0:1::/64');
  assert.equal(ipBucket('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(ipBucket('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(ipBucket(undefined), 'unknown');
  const h = harness();
  for (let i = 0; i < 3; i += 1) assert.equal((await h.auth.requestCode({ phone: `05444444${10 + i}`, ip: `2001:db8:0:1::${i + 1}` })).ok, true);
  assert.deepEqual(await h.auth.requestCode({ phone: '0544444420', ip: '2001:db8:0:1:ab::9' }), { ok: false, error: 'rate_limited' });
  assert.equal((await h.auth.requestCode({ phone: '0544444421', ip: '2001:db8:0:2::1' })).ok, true);
  h.tick(60_000);
  for (let i = 0; i < 3; i += 1) assert.equal((await h.auth.requestCode({ phone: `05555555${10 + i}`, ip: '5.6.7.8' })).ok, true);
  h.tick(60_000);
  assert.deepEqual(await h.auth.requestCode({ phone: '0555555520', ip: '::ffff:5.6.7.8' }), { ok: false, error: 'rate_limited' });
  h.db.close();
});
