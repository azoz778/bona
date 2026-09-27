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

function harness({ reply = () => ({ status: 201, body: { key: { id: 'KEY-1' } } }), env = ENV } = {}) {
  const s = openDb(':memory:');
  let clock = NOW;
  const team = createTeam(s, { now: () => clock });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = await reply(calls.length);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body ?? {}) };
  };
  const sender = createSender({ env, team, fetchImpl, now: () => clock });
  return { s, team, sender, calls, tick: (ms) => { clock += ms; } };
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

test('never sends to a group, a lid, a broadcast or garbage', async () => {
  const h = harness();
  for (const jid of ['120363135705763548@g.us', '123456789@lid', 'status@broadcast', '966500000001', '', null]) {
    assert.deepEqual(await h.sender.sendTo({ jid, text: 'x', kind: 'code' }), { ok: false, error: 'bad_recipient' }, String(jid));
  }
  assert.equal(h.calls.length, 0);
  h.s.close();
});

test('the sending switch stops everything except what is allowed to bypass it', async () => {
  const h = harness();
  h.team.setSetting('sending_enabled', '0');
  assert.deepEqual(await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' }), { ok: false, error: 'sending_disabled' });
  const owner = await h.sender.sendTo({ jid: '966593296933@s.whatsapp.net', text: 'x', kind: 'code', bypassSwitch: true });
  assert.equal(owner.ok, true, "the owner's own login code still goes, or he could never switch it back on");
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

test('no Evolution credentials: nothing is attempted', async () => {
  const h = harness({ env: {} });
  assert.deepEqual(await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' }), { ok: false, error: 'evolution-not-configured' });
  assert.equal(h.calls.length, 0);
  h.s.close();
});
