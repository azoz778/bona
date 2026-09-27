/**
 * The one door every message to someone other than the owner goes out through: a 1:1
 * jid only, the owner's sending switch, and limits shared by every sender.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createTeam } from '../lib/team.mjs';
import { createSender, SEND_PER_MIN, PER_RECIPIENT_PER_MIN } from '../lib/wa-send.mjs';

const NOW = 1_790_500_000_000;
const ENV = { EVOLUTION_API_URL: 'http://evo.test/', EVOLUTION_API_KEY: 'k', BONA_WA_INSTANCE: 'abdulaziz-personal' };
const OWNER_JID = '966593296933@s.whatsapp.net';

function harness({ reply = () => ({ status: 201, body: { key: { id: 'KEY-1' } } }), env = ENV } = {}) {
  const s = openDb(':memory:');
  let clock = NOW;
  const team = createTeam(s, { now: () => clock });
  const calls = [];
  const logs = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = await reply(calls.length);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body ?? {}) };
  };
  const sender = createSender({ env, team, fetchImpl, now: () => clock, log: (o) => logs.push(o) });
  return { s, team, sender, calls, logs, tick: (ms) => { clock += ms; } };
}

test('sends the text to that number on the owner instance and returns the WhatsApp message id', async () => {
  const h = harness();
  const out = await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'hello', kind: 'code' });
  assert.deepEqual(out, { ok: true, keyId: 'KEY-1', status: 201 });
  assert.equal(h.calls[0].url, 'http://evo.test/message/sendText/abdulaziz-personal');
  assert.equal(h.calls[0].init.headers.apikey, 'k');
  assert.deepEqual(h.calls[0].body, { number: '966500000001', text: 'hello' });
  h.s.close();
});

test('never sends to a group, a lid, a broadcast, a local-format number or garbage', async () => {
  const h = harness();
  const bad = ['120363135705763548@g.us', '123456789@lid', 'status@broadcast', '966500000001', '', null, '0500000001@s.whatsapp.net'];
  for (const jid of bad) {
    assert.deepEqual(await h.sender.sendTo({ jid, text: 'x', kind: 'code' }), { ok: false, error: 'bad_recipient' }, String(jid));
  }
  assert.equal(h.calls.length, 0);
  h.s.close();
});

test('bad_text: empty, oversized, or not a string at all', async () => {
  const h = harness();
  const jid = '966500000001@s.whatsapp.net';
  assert.deepEqual(await h.sender.sendTo({ jid, text: '', kind: 'code' }), { ok: false, error: 'bad_text' });
  assert.deepEqual(await h.sender.sendTo({ jid, text: undefined, kind: 'code' }), { ok: false, error: 'bad_text' });
  assert.deepEqual(await h.sender.sendTo({ jid, text: 'a'.repeat(4097), kind: 'code' }), { ok: false, error: 'bad_text' });
  assert.equal(h.calls.length, 0, 'none of the bad texts reach the network');
  assert.equal((await h.sender.sendTo({ jid, text: 'a'.repeat(4096), kind: 'code' })).ok, true, '4096 exactly is fine');
  h.s.close();
});

test('bad_kind: only "code" is a real kind in Phase 1', async () => {
  const h = harness();
  const jid = '966500000001@s.whatsapp.net';
  assert.deepEqual(await h.sender.sendTo({ jid, text: 'x', kind: 'reply' }), { ok: false, error: 'bad_kind' });
  assert.deepEqual(await h.sender.sendTo({ jid, text: 'x' }), { ok: false, error: 'bad_kind' });
  assert.equal(h.calls.length, 0);
  h.s.close();
});

test('the sending switch stops everything except what is allowed to bypass it', async () => {
  const h = harness();
  h.team.setSetting('sending_enabled', '0');
  assert.deepEqual(await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' }), { ok: false, error: 'sending_disabled' });
  const owner = await h.sender.sendTo({ jid: OWNER_JID, text: 'x', kind: 'code', bypassSwitch: true });
  assert.equal(owner.ok, true, "the owner's own login code still goes, or he could never switch it back on");
  h.s.close();
});

test('bypassSwitch is decided here, not trusted from the caller: it only ever works for the owner\'s own code', async () => {
  const h = harness();
  h.team.setSetting('sending_enabled', '0');
  // a caller claiming bypassSwitch for someone other than the owner is still refused.
  assert.deepEqual(
    await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code', bypassSwitch: true }),
    { ok: false, error: 'sending_disabled' },
  );
  assert.equal(h.calls.length, 0, 'a non-owner bypass attempt never reaches the network');
  h.s.close();
});

test('limits: per recipient per minute, and across every sender', async () => {
  const h = harness();
  const one = '966500000001@s.whatsapp.net';
  for (let i = 0; i < PER_RECIPIENT_PER_MIN; i += 1) assert.equal((await h.sender.sendTo({ jid: one, text: 'x', kind: 'code' })).ok, true);
  assert.deepEqual(await h.sender.sendTo({ jid: one, text: 'x', kind: 'code' }), { ok: false, error: 'rate_limited' });
  let ok = PER_RECIPIENT_PER_MIN;
  for (let n = 2; ok < SEND_PER_MIN; n += 1) {
    if ((await h.sender.sendTo({ jid: `9665000000${String(n).padStart(2, '0')}@s.whatsapp.net`, text: 'x', kind: 'code' })).ok) ok += 1;
  }
  assert.deepEqual(await h.sender.sendTo({ jid: '966599999999@s.whatsapp.net', text: 'x', kind: 'code' }), { ok: false, error: 'rate_limited' });
  h.tick(60_000);
  assert.equal((await h.sender.sendTo({ jid: '966599999999@s.whatsapp.net', text: 'x', kind: 'code' })).ok, true, 'refills');
  h.s.close();
});

test('a limiter refusal leaves the other limiters untouched (peek before take)', async () => {
  const h = harness();
  const hot = '966500000001@s.whatsapp.net';
  for (let i = 0; i < PER_RECIPIENT_PER_MIN; i += 1) assert.equal((await h.sender.sendTo({ jid: hot, text: 'x', kind: 'code' })).ok, true);
  // burn a handful of refusals against the per-recipient limiter alone
  for (let i = 0; i < 5; i += 1) assert.deepEqual(await h.sender.sendTo({ jid: hot, text: 'x', kind: 'code' }), { ok: false, error: 'rate_limited' });
  // if those refusals had also charged the shared per-minute bucket, this would stall below SEND_PER_MIN
  let ok = PER_RECIPIENT_PER_MIN;
  for (let n = 100; ok < SEND_PER_MIN && n < 200; n += 1) {
    if ((await h.sender.sendTo({ jid: `966500000${n}@s.whatsapp.net`, text: 'x', kind: 'code' })).ok) ok += 1;
  }
  assert.equal(ok, SEND_PER_MIN, 'the refusals spent nothing from the shared bucket');
  h.s.close();
});

test("the owner's own jid skips the shared per-minute/per-day budget, but not the per-recipient one", async () => {
  const h = harness();
  for (let i = 0; i < PER_RECIPIENT_PER_MIN; i += 1) assert.equal((await h.sender.sendTo({ jid: OWNER_JID, text: 'x', kind: 'code' })).ok, true);
  assert.deepEqual(await h.sender.sendTo({ jid: OWNER_JID, text: 'x', kind: 'code' }), { ok: false, error: 'rate_limited' }, 'still capped per-recipient');
  // immediately after, in the same minute, a fresh recipient still gets the FULL shared allowance
  let ok = 0;
  for (let n = 0; ok < SEND_PER_MIN && n < 100; n += 1) {
    if ((await h.sender.sendTo({ jid: `96652220${String(n).padStart(4, '0')}@s.whatsapp.net`, text: 'x', kind: 'code' })).ok) ok += 1;
  }
  assert.equal(ok, SEND_PER_MIN, "the owner's sends never spent the shared budget");
  h.s.close();
});

test('bypass is still subject to the per-recipient limit', async () => {
  const h = harness();
  h.team.setSetting('sending_enabled', '0');
  for (let i = 0; i < PER_RECIPIENT_PER_MIN; i += 1) {
    assert.equal((await h.sender.sendTo({ jid: OWNER_JID, text: 'x', kind: 'code', bypassSwitch: true })).ok, true);
  }
  assert.deepEqual(
    await h.sender.sendTo({ jid: OWNER_JID, text: 'x', kind: 'code', bypassSwitch: true }),
    { ok: false, error: 'rate_limited' },
  );
  h.s.close();
});

test('an HTTP error fails; a timeout is "uncertain", never retried here', async () => {
  const bad = harness({ reply: () => ({ status: 500, body: {} }) });
  assert.deepEqual(await bad.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' }), { ok: false, error: 'http_500' });
  bad.s.close();

  const s = openDb(':memory:');
  const team = createTeam(s);
  const slow = createSender({
    env: ENV, team, timeoutMs: 5,
    fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  });
  assert.deepEqual(await slow.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' }), { ok: false, error: 'timeout', uncertain: true });
  s.close();
});

test('a 502 or 504 is "uncertain": the request may well have gone through', async () => {
  for (const status of [502, 504]) {
    const h = harness({ reply: () => ({ status, body: {} }) });
    assert.deepEqual(
      await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' }),
      { ok: false, error: `http_${status}`, uncertain: true },
      String(status),
    );
    h.s.close();
  }
});

test('a definite pre-connection failure (refused, unknown host, DNS) is not "uncertain"', async () => {
  const s = openDb(':memory:');
  const team = createTeam(s);
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
    const sender = createSender({
      env: ENV, team,
      fetchImpl: async () => { throw Object.assign(new Error('boom'), { cause: { code } }); },
    });
    assert.deepEqual(
      await sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' }),
      { ok: false, error: 'network' },
      code,
    );
  }
  s.close();
});

test('any other thrown error is "network" but "uncertain" — we cannot tell if it sent', async () => {
  const s = openDb(':memory:');
  const team = createTeam(s);
  const causes = [
    Object.assign(new Error('reset'), { cause: { code: 'ECONNRESET' } }),
    Object.assign(new Error('mystery'), {}),
    new TypeError('fetch failed'),
  ];
  for (const err of causes) {
    const sender = createSender({ env: ENV, team, fetchImpl: async () => { throw err; } });
    assert.deepEqual(
      await sender.sendTo({ jid: '966500000002@s.whatsapp.net', text: 'x', kind: 'code' }),
      { ok: false, error: 'network', uncertain: true },
      err.message,
    );
  }
  s.close();
});

test('a 2xx counts as sent only when the body carries a WhatsApp message id', async () => {
  const h = harness({ reply: () => ({ status: 200, body: { success: true, note: 'super-secret-body-marker' } }) });
  const out = await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' });
  assert.deepEqual(out, { ok: false, error: 'no_ack', uncertain: true });
  const entry = h.logs.find((l) => l.evt === 'wa.send.no_key');
  assert.ok(entry, 'logs that the ack was missing');
  assert.ok(!JSON.stringify(entry).includes('super-secret-body-marker'), 'never logs the response body');
  h.s.close();
});

test('a timeout while reading the body is also "no key", not "network"', async () => {
  const s = openDb(':memory:');
  const team = createTeam(s);
  const logs = [];
  const sender = createSender({
    env: ENV, team, timeoutMs: 5, log: (o) => logs.push(o),
    fetchImpl: (url, init) => Promise.resolve({
      ok: true,
      status: 200,
      text: () => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    }),
  });
  assert.deepEqual(
    await sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' }),
    { ok: false, error: 'no_ack', uncertain: true },
  );
  assert.ok(logs.some((l) => l.evt === 'wa.send.no_key'));
  s.close();
});

test('BONA_WA_NOTIFY=0 does not block a login code (only other kinds would need it)', async () => {
  const h = harness({ env: { ...ENV, BONA_WA_NOTIFY: '0' } });
  const out = await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' });
  assert.equal(out.ok, true);
  h.s.close();
});

test('no Evolution credentials: nothing is attempted', async () => {
  const h = harness({ env: {} });
  assert.deepEqual(await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' }), { ok: false, error: 'evolution-not-configured' });
  assert.equal(h.calls.length, 0);
  h.s.close();
});
