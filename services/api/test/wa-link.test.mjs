/**
 * PR-L (PLAN T09; DESIGN §5.3, §6.4, §14): the WhatsApp link probe and the instance identity guard.
 * Nothing leaves the process: Evolution and Kuma are a fake fetch, the clock and the 10-minute timer
 * are fakes, and every number is a +966 50 000 0000-style test number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createWaLink, PROBE_EVERY_MS, IDENTITY_STALE_MS, IDENTITY_DOWN_AFTER, LINK_DOWN_AFTER, LINK_STABLE_MS,
} from '../lib/wa-link.mjs';

const NOW = 1_790_700_000_000;
const MIN = 60_000;
/** Bona's own number (BONA_WA_INSTANCE_JID) and the owner's personal one (BONA_OWNER_JID). */
const OWN = '966500000001';
const OWNER = '966500000009';
const KUMA = 'https://kuma.example.com/api/push/PUSHTOKEN0001';
const ENV = Object.freeze({
  EVOLUTION_API_URL: 'http://evo.example/', EVOLUTION_API_KEY: 'evo-key',
  BONA_WA_INSTANCE: 'bona-test', BONA_WA_INSTANCE_JID: `${OWN}@s.whatsapp.net`, BONA_OWNER_JID: `${OWNER}@s.whatsapp.net`,
  BONA_KUMA_WA_LINK_PUSH: KUMA,
});
const without = (key) => Object.fromEntries(Object.entries(ENV).filter(([k]) => k !== key));

/**
 * Evolution 2.3.7 and Kuma as one fake fetch. fetchInstances answers as the live server does
 * (verify/T00.md step 2: an array of one instance, its API key `token` next to `ownerJid`);
 * whatsappNumbers answers `[{ jid, exists, number, name }]`, or 400 "Connection Closed" when the
 * companion is logged out. `state` is what the test changes between probes; `hold` stalls every
 * request, `linkHold` only the whatsappNumbers one.
 */
function fakeEvolution() {
  const state = { ownerJid: `${OWN}@s.whatsapp.net`, identity: 'ok', link: 'ok', exists: true, hold: null, linkHold: null, kuma: 'ok' };
  const calls = [];
  const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const call = {
      url, host: u.host, path: u.pathname, query: Object.fromEntries(u.searchParams), method: init.method ?? 'GET',
      headers: init.headers ?? {}, body: init.body === undefined ? null : JSON.parse(init.body), redirect: init.redirect ?? null,
    };
    calls.push(call);
    if (state.hold) await state.hold;
    if (state.linkHold && u.pathname.startsWith('/chat/whatsappNumbers/')) await state.linkHold;
    if (u.pathname.startsWith('/api/push/')) {
      if (state.kuma === 'throw') throw Object.assign(new Error(`connect ECONNREFUSED ${url}`), { name: 'TypeError' });
      return state.kuma === 'http' ? resp(500, 'boom') : resp(200, { ok: true });
    }
    if (u.pathname === '/instance/fetchInstances') {
      if (state.identity === 'network') throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' });
      if (state.identity === 'http') return resp(500, { error: 'boom', token: 'INSTANCE-TOKEN-SECRET' });
      return resp(200, [{
        id: 'inst-1', name: u.searchParams.get('instanceName'), connectionStatus: 'open', ownerJid: state.ownerJid, number: '',
        profileName: 'Bona', token: 'INSTANCE-TOKEN-SECRET', integration: 'WHATSAPP-BAILEYS',
      }]);
    }
    if (u.pathname.startsWith('/chat/whatsappNumbers/')) {
      if (state.link === 'closed') return resp(400, { status: 400, error: 'Bad Request', response: { message: ['Connection Closed'] } });
      if (state.link === 'network') throw Object.assign(new Error('socket hang up'), { name: 'TypeError' });
      return resp(200, call.body.numbers.map((n) => ({ jid: `${n}@s.whatsapp.net`, exists: state.exists, number: n, name: 'Bona Real Estate' })));
    }
    return resp(404, { error: 'no such route' });
  };
  return {
    state, calls, fetchImpl,
    identityCalls: () => calls.filter((c) => c.path === '/instance/fetchInstances'),
    linkCalls: () => calls.filter((c) => c.path.startsWith('/chat/whatsappNumbers/')),
    kumaCalls: () => calls.filter((c) => c.path.startsWith('/api/push/')),
    beats: () => calls.filter((c) => c.path.startsWith('/api/push/')).map((c) => `${c.query.status}:${c.query.msg}`),
  };
}

/** A link over the fake Evolution, a fake clock, a fake 10-minute timer and a web-push spy. */
function scene({ env = ENV, alerts, log, ...over } = {}) {
  const evo = fakeEvolution();
  let clock = NOW;
  const timers = [];
  const schedule = (fn, ms) => {
    const t = { fn, ms, cancelled: false, fired: false, cancel() { t.cancelled = true; } };
    timers.push(t);
    return t;
  };
  const pushes = [];
  const logs = [];
  const spy = { notifyOwners: ({ reason } = {}) => { pushes.push(reason); return Promise.resolve({ users: 1, devices: 1, ok: 1, gone: 0, failed: 0 }); } };
  const link = createWaLink({
    env, alerts: alerts === undefined ? spy : alerts, fetchImpl: evo.fetchImpl, now: () => clock,
    log: log ?? ((e) => logs.push(e)), schedule, ...over,
  });
  const settle = async () => {
    await link.flush();
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  };
  const pending = () => timers.filter((t) => !t.cancelled && !t.fired);
  /** The next probe: the clock moves to when its timer is due, and the timer fires. */
  const fire = async () => {
    const live = pending();
    assert.equal(live.length, 1, 'exactly one probe is scheduled');
    const [t] = live;
    clock += t.ms;
    t.fired = true;
    t.fn();
    await settle();
  };
  return { evo, link, pushes, logs, timers, pending, fire, settle, tick: (ms) => { clock += ms; }, now: () => clock };
}

/* ---------------- test 1: the instance must be named, and never a personal one ---------------- */

test('identityOk is false when BONA_WA_INSTANCE is missing (the code default, the personal WhatsApp) or a personal instance; that instance is never probed', async () => {
  for (const [label, env] of [
    ['missing', without('BONA_WA_INSTANCE')],
    ['blank', { ...ENV, BONA_WA_INSTANCE: '' }],
    ['spaces', { ...ENV, BONA_WA_INSTANCE: '   ' }],
    ['abdulaziz-personal', { ...ENV, BONA_WA_INSTANCE: 'abdulaziz-personal' }],
    ['abdulaziz-personal, other case', { ...ENV, BONA_WA_INSTANCE: ' Abdulaziz-Personal ' }],
    ['named in BONA_WA_PERSONAL_INSTANCES', { ...ENV, BONA_WA_INSTANCE: 'owner-phone', BONA_WA_PERSONAL_INSTANCES: 'other, owner-phone' }],
  ]) {
    const s = scene({ env });
    assert.equal(s.link.identityOk(), false, label);
    s.link.start();
    await s.settle();
    await s.link.probe();
    assert.equal(s.link.identityOk(), false, label);
    assert.deepEqual(s.link.health(), { linkOk: true, identityOk: false }, label);
    assert.equal(s.evo.identityCalls().length + s.evo.linkCalls().length, 0, `${label}: nothing on that instance is asked, though it would answer with Bona's number`);
    assert.deepEqual(s.pushes, ['identity_mismatch'], `${label}: the JID says Bona's number, the instance cannot be it: one owner alert`);
    assert.deepEqual(s.evo.beats(), ['down:misconfigured'], `${label}: Kuma hears it once`);
    assert.equal(s.pending().length, 0, `${label}: no timer is armed`);
    assert.deepEqual(s.logs.filter((l) => l.evt === 'wa.link.off').map((l) => l.level), ['error'], label);
  }
});

test('the personal-number setup is never Bona\'s own number: no BONA_WA_INSTANCE_JID, an invalid one, or the owner\'s own number', async () => {
  for (const [label, env, why, alerted] of [
    ['no instance JID (the rollback to the personal number)', without('BONA_WA_INSTANCE_JID'), 'no_own_number', false],
    ['an instance JID that is not a phone jid', { ...ENV, BONA_WA_INSTANCE_JID: '123456789012345@lid' }, 'jid_invalid', false],
    ["the owner's own number as the instance JID", { ...ENV, BONA_WA_INSTANCE_JID: `${OWNER}@s.whatsapp.net` }, 'owner_number', true],
    ["the owner's number with a device suffix", { ...ENV, BONA_WA_INSTANCE_JID: `${OWNER}:7@s.whatsapp.net` }, 'owner_number', true],
    ['no Evolution URL', without('EVOLUTION_API_URL'), 'no_evolution', false],
    ['no Evolution key', without('EVOLUTION_API_KEY'), 'no_evolution', false],
  ]) {
    const s = scene({ env });
    s.link.start();
    await s.settle();
    assert.equal(s.link.identityOk(), false, label);
    assert.equal(s.link.linkOk(), true, `${label}: nothing probed, nothing known: the link is not called down`);
    assert.equal(s.evo.identityCalls().length + s.evo.linkCalls().length, 0, label);
    assert.deepEqual(s.pushes, alerted ? ['identity_mismatch'] : [], label);
    assert.deepEqual(s.evo.beats(), alerted ? ['down:misconfigured'] : [], label);
    assert.deepEqual(s.logs.filter((l) => l.evt === 'wa.link.off').map((l) => l.why), [why], label);
  }
});

test('a parsed config wins over the env: its personal instances and its Kuma URL', async () => {
  const s = scene({ env: { ...ENV, BONA_WA_INSTANCE: 'owner-phone' }, cfg: { waPersonalInstances: ['abdulaziz-personal', 'owner-phone'], kumaWaLinkPush: '' } });
  s.link.start();
  await s.settle();
  assert.equal(s.link.identityOk(), false);
  assert.equal(s.evo.identityCalls().length, 0);
  assert.deepEqual(s.pushes, ['identity_mismatch']);
  assert.deepEqual(s.evo.kumaCalls(), [], "the config's empty Kuma URL, not the env's");
  const t = scene({ cfg: { waPersonalInstances: ['abdulaziz-personal'], kumaWaLinkPush: 'http://127.0.0.1:3010/api/push/PUSHTOKEN0001' } });
  t.link.start();
  await t.settle();
  assert.equal(t.link.identityOk(), true);
  assert.deepEqual(t.evo.kumaCalls().map((c) => c.host), ['127.0.0.1:3010']);
});

test('createWaLink() with nothing configured is the stub: identity closed, the link up, start/stop arm nothing', () => {
  const l = createWaLink();
  assert.equal(l.identityOk(), false);
  assert.equal(l.linkOk(), true);
  assert.equal(l.linkStable(), false);
  assert.equal(l.start(), undefined);
  assert.equal(l.stop(), undefined);
  assert.deepEqual(l.health(), { linkOk: true, identityOk: false });
});

/* ---------------- test 2: the connected number decides ---------------- */

test("ownerJid digits equal to BONA_WA_INSTANCE_JID's → true; different → false at once, plus one alert", async () => {
  const s = scene();
  s.link.start();
  await s.settle();
  assert.equal(s.link.identityOk(), true);
  assert.deepEqual(s.link.health(), { linkOk: true, identityOk: true });
  assert.deepEqual(s.pushes, []);
  assert.deepEqual(s.evo.beats(), ['up:ok']);
  const [ask] = s.evo.identityCalls();
  assert.equal(ask.method, 'GET');
  assert.deepEqual(ask.query, { instanceName: 'bona-test' }, 'the configured instance, by name');
  assert.equal(ask.headers.apikey, 'evo-key');

  // The gateway now holds another number (re-paired): false at once, though the last match is only 10 min old.
  s.evo.state.ownerJid = `${OWNER}@s.whatsapp.net`;
  await s.fire();
  assert.equal(s.link.identityOk(), false);
  assert.deepEqual(s.link.health(), { linkOk: true, identityOk: false });
  assert.deepEqual(s.pushes, ['identity_mismatch']);
  assert.equal(s.evo.beats().at(-1), 'down:identity_mismatch');
  // Still the wrong number: Kuma keeps hearing it, the owner's phone does not buzz again.
  await s.fire();
  assert.equal(s.link.identityOk(), false);
  assert.deepEqual(s.pushes, ['identity_mismatch']);
  assert.equal(s.evo.beats().at(-1), 'down:identity_mismatch');
  // Back to Bona's number, then wrong again: a new incident, a new alert.
  s.evo.state.ownerJid = `${OWN}:23@s.whatsapp.net`;
  await s.fire();
  assert.equal(s.link.identityOk(), true, 'a device suffix is still the same number');
  assert.equal(s.evo.beats().at(-1), 'up:ok');
  s.evo.state.ownerJid = `${OWN}@lid`;
  await s.fire();
  assert.equal(s.link.identityOk(), false, 'a lid is not a phone number, even with the same digits');
  assert.deepEqual(s.pushes, ['identity_mismatch', 'identity_mismatch']);
});

test("the identity answer lands before the link probe: Bona's number back opens the guard while a stalled link probe is still out", async () => {
  const s = scene();
  s.evo.state.ownerJid = `${OWNER}@s.whatsapp.net`;
  s.link.start();
  await s.settle();
  assert.equal(s.link.identityOk(), false);
  let release;
  s.evo.state.linkHold = new Promise((r) => { release = r; });
  s.evo.state.ownerJid = `${OWN}@s.whatsapp.net`;
  const [timer] = s.pending();
  timer.fired = true;
  s.tick(timer.ms);
  timer.fn();
  for (let i = 0; i < 50 && s.evo.linkCalls().length < 1; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(s.evo.linkCalls().length, 1, 'the link probe is out, and stalls');
  assert.equal(s.link.identityOk(), true, 'Evolution has answered with Bona\'s number: true now, not when the link probe is done');
  const beats = s.evo.kumaCalls().length;
  release();
  s.evo.state.linkHold = null;
  await s.settle();
  assert.equal(s.evo.kumaCalls().length, beats + 1, 'one Kuma beat a round, once the round is done');
  assert.equal(s.evo.beats().at(-1), 'up:ok');
  assert.equal(s.pending().length, 1, 'the next probe is armed');
});

/* ---------------- an instance on another number is asked nothing more (WhatsApp safety) ---------------- */

test('while the instance holds another number, no link probe goes through it: the link keeps its value, Kuma hears the mismatch', async () => {
  const s = scene();
  s.link.start();
  await s.settle();
  await s.fire();
  assert.equal(s.link.linkStable(), true);
  const asked = s.evo.linkCalls().length;
  // Re-paired to another number (perhaps the owner's own WhatsApp): the round asks the identity and stops there.
  s.evo.state.ownerJid = `${OWNER}@s.whatsapp.net`;
  await s.fire();
  assert.equal(s.link.identityOk(), false);
  assert.equal(s.evo.linkCalls().length, asked, 'no POST /chat/whatsappNumbers through an instance on another number');
  assert.equal(s.link.linkOk(), true, 'linkOk keeps its value');
  assert.equal(s.link.linkStable(), false, 'no probe watched the link: the stable count starts again');
  assert.deepEqual(s.pushes, ['identity_mismatch']);
  assert.equal(s.evo.beats().at(-1), 'down:identity_mismatch');
  assert.equal(s.pending().length, 1, 'the round is done and the next one armed');
  // Still that number, then identity errors past 30 min: the last answer is still another number, so nothing is asked.
  await s.fire();
  s.evo.state.identity = 'network';
  for (let i = 0; i < 4; i += 1) await s.fire();
  assert.equal(s.evo.linkCalls().length, asked, 'no link probe until the identity matches again');
  assert.deepEqual(s.evo.beats().slice(-5), Array(5).fill('down:identity_mismatch'), 'one Kuma beat a round, all of them DOWN');
  assert.deepEqual(s.pushes, ['identity_mismatch'], 'one alert for the incident');
  // Bona's number again: the link probe comes back in the same round.
  s.evo.state.identity = 'ok';
  s.evo.state.ownerJid = `${OWN}@s.whatsapp.net`;
  await s.fire();
  assert.equal(s.link.identityOk(), true);
  assert.equal(s.evo.linkCalls().length, asked + 1);
  assert.equal(s.evo.beats().at(-1), 'up:ok');
  assert.equal(s.link.linkStable(), false, 'one good probe since');
  await s.fire();
  assert.equal(s.link.linkStable(), true, 'two good probes, 10 min apart');

  // A link already down stays down through the mismatch: no probe, no second web push, Kuma hears the mismatch.
  const t = scene();
  t.link.start();
  await t.settle();
  t.evo.state.link = 'closed';
  await t.fire();
  await t.fire();
  assert.equal(t.link.linkOk(), false);
  const before = t.evo.linkCalls().length;
  t.evo.state.ownerJid = `${OWNER}@s.whatsapp.net`;
  t.evo.state.link = 'ok';
  await t.fire();
  await t.fire();
  assert.equal(t.evo.linkCalls().length, before, 'nothing asked through it');
  assert.equal(t.link.linkOk(), false, 'linkOk keeps its value: the link would answer now, but nobody asked');
  assert.deepEqual(t.pushes, ['wa_link_down', 'identity_mismatch']);
  assert.deepEqual(t.evo.beats().slice(-2), ['down:identity_mismatch', 'down:identity_mismatch']);
  t.evo.state.ownerJid = `${OWN}@s.whatsapp.net`;
  await t.fire();
  assert.equal(t.link.linkOk(), true, 'the first probe after the match finds the link up');
  assert.equal(t.evo.beats().at(-1), 'up:ok');
  assert.deepEqual(t.pushes, ['wa_link_down', 'identity_mismatch']);
});

test('a mismatch, the identity check passing again, and the link going down are logged as events without a number', async () => {
  const s = scene();
  s.link.start();
  await s.settle();
  s.evo.state.ownerJid = `${OWNER}@s.whatsapp.net`;
  await s.fire();
  s.evo.state.ownerJid = `${OWN}@s.whatsapp.net`;
  await s.fire();
  const events = s.logs.filter((l) => l.evt === 'wa.identity').map((l) => `${l.ok}:${l.why}`);
  assert.deepEqual(events, ['true:match', 'false:mismatch', 'true:match']);
  assert.doesNotMatch(JSON.stringify(s.logs), /\d{6,}|evo-key|INSTANCE-TOKEN|PUSHTOKEN|kuma\.example|evo\.example/);
});

/* ---------------- test 3: before the first check, and errors ---------------- */

test('before the first check identityOk is false, and the first probe runs at start', async () => {
  const s = scene();
  let release;
  s.evo.state.hold = new Promise((r) => { release = r; });
  assert.equal(s.link.identityOk(), false, 'before start');
  await new Promise((r) => setImmediate(r));
  assert.equal(s.evo.calls.length, 0, 'constructing it contacts nothing');
  s.link.start();
  assert.equal(s.evo.identityCalls().length, 1, 'asked at once, before any timer fires');
  assert.equal(s.pending().length, 0, 'the next probe is armed only when this one is done');
  assert.equal(s.link.identityOk(), false, 'asked, not yet answered');
  assert.deepEqual(s.link.health(), { linkOk: true, identityOk: false });
  release();
  s.evo.state.hold = null;
  await s.settle();
  assert.equal(s.link.identityOk(), true);
  assert.equal(s.pending().length, 1);
});

test('an error keeps the last value for up to 30 minutes after the last answer, then false; no alert for an error', async () => {
  assert.equal(IDENTITY_STALE_MS, 30 * MIN);
  const s = scene();
  s.link.start();
  await s.settle();
  assert.equal(s.link.identityOk(), true);
  for (const kind of ['network', 'http', 'network']) {
    s.evo.state.identity = kind;
    await s.fire();
  }
  // Three failed probes: the last answer is exactly 30 min old now.
  assert.equal(s.now() - NOW, 30 * MIN);
  assert.equal(s.link.identityOk(), true, 'up to 30 min: the last value holds');
  assert.equal(s.evo.beats().at(-1), 'up:ok');
  s.tick(1);
  assert.equal(s.link.identityOk(), false, 'then it fails closed, without waiting for a probe');
  assert.deepEqual(s.link.health(), { linkOk: true, identityOk: false });
  assert.deepEqual(s.pushes, [], 'an error is no mismatch');
  await s.fire();
  assert.equal(s.link.identityOk(), false);
  assert.equal(s.evo.beats().at(-1), 'down:identity_unknown');
  assert.deepEqual(s.logs.filter((l) => l.evt === 'wa.link.probe_failed' && l.probe === 'identity').map((l) => l.code),
    ['network', 'bad_response', 'network', 'network']);
  // The gateway answers again: true at once.
  s.evo.state.identity = 'ok';
  await s.fire();
  assert.equal(s.link.identityOk(), true);
  assert.equal(s.evo.beats().at(-1), 'up:ok');
  assert.deepEqual(s.pushes, []);
});

test('an error before any answer leaves identity false; an instance with no number keeps the last value like an error', async () => {
  assert.equal(IDENTITY_DOWN_AFTER, 2);
  const s = scene();
  s.evo.state.identity = 'http';
  s.link.start();
  await s.settle();
  assert.equal(s.link.identityOk(), false);
  assert.deepEqual(s.evo.beats(), ['up:identity_pending'], 'one failed check is no outage: Kuma hears DOWN after two (DESIGN §14)');
  await s.fire();
  assert.equal(s.link.identityOk(), false);
  assert.deepEqual(s.evo.beats(), ['up:identity_pending', 'down:identity_unknown'], 'two in a row');
  s.evo.state.identity = 'ok';
  await s.fire();
  assert.equal(s.link.identityOk(), true);
  assert.equal(s.evo.beats().at(-1), 'up:ok');
  assert.deepEqual(s.pushes, []);

  const t = scene();
  t.link.start();
  await t.settle();
  t.evo.state.ownerJid = null;
  await t.fire();
  assert.equal(t.link.identityOk(), true, 'no number at the moment is not another number');
  assert.deepEqual(t.pushes, []);
  assert.equal(t.logs.filter((l) => l.evt === 'wa.link.probe_failed').at(-1).code, 'no_number');
  t.tick(IDENTITY_STALE_MS - PROBE_EVERY_MS + 1);
  assert.equal(t.link.identityOk(), false, '30 min on, it fails closed as after any error');
});

/* ---------------- test 4: the link ---------------- */

test('linkOk: two failed whatsappNumbers probes in a row → false, a Kuma push DOWN and a web push; one failure is not enough', async () => {
  assert.equal(LINK_DOWN_AFTER, 2);
  const s = scene();
  s.link.start();
  await s.settle();
  assert.equal(s.link.linkOk(), true);
  const [ask] = s.evo.linkCalls();
  assert.equal(ask.method, 'POST');
  assert.equal(ask.path, '/chat/whatsappNumbers/bona-test', 'the configured instance');
  assert.deepEqual(ask.body, { numbers: [OWN] }, "Bona's own number, digits only");
  assert.equal(ask.headers['User-Agent'], 'curl/8.5.0');

  s.evo.state.link = 'closed';
  await s.fire();
  assert.equal(s.link.linkOk(), true, 'one failure');
  assert.deepEqual(s.pushes, []);
  assert.equal(s.evo.beats().at(-1), 'up:ok');
  await s.fire();
  assert.equal(s.link.linkOk(), false, 'two in a row');
  assert.deepEqual(s.link.health(), { linkOk: false, identityOk: true });
  assert.deepEqual(s.pushes, ['wa_link_down']);
  assert.equal(s.evo.beats().at(-1), 'down:link_down');
  await s.fire();
  assert.deepEqual(s.pushes, ['wa_link_down'], 'one push per outage');
  assert.equal(s.evo.beats().at(-1), 'down:link_down', 'Kuma hears every probe');

  s.evo.state.link = 'ok';
  await s.fire();
  assert.equal(s.link.linkOk(), true);
  assert.equal(s.evo.beats().at(-1), 'up:ok');
  assert.deepEqual(s.logs.filter((l) => l.evt === 'wa.link').map((l) => l.ok), [false, true]);
});

test('linkOk: only failures in a row count; "not on WhatsApp" and a network error are failures too', async () => {
  const s = scene();
  s.link.start();
  await s.settle();
  for (const [kind, want] of [['closed', true], ['ok', true], ['network', true], ['ok', true], ['closed', true]]) {
    s.evo.state.link = kind;
    await s.fire();
    assert.equal(s.link.linkOk(), want, kind);
  }
  assert.deepEqual(s.pushes, []);
  s.evo.state.link = 'ok';
  s.evo.state.exists = false;
  await s.fire();
  assert.equal(s.link.linkOk(), false, 'closed, then exists:false: two in a row');
  assert.deepEqual(s.pushes, ['wa_link_down']);
  const codes = s.logs.filter((l) => l.evt === 'wa.link.probe_failed' && l.probe === 'link').map((l) => l.code);
  assert.deepEqual(codes, ['bad_response', 'network', 'bad_response', 'not_on_whatsapp']);
});

test('the sender is never called: every request is one of the two read probes or the Kuma push', async () => {
  const sent = [];
  const sender = { sendTo: async (o) => { sent.push(o); return { ok: true }; } };
  const s = scene({ sender, sendWhatsApp: async (t) => { sent.push(t); return { ok: true }; } });
  s.link.start();
  await s.settle();
  s.evo.state.link = 'closed';
  await s.fire();
  await s.fire();
  s.evo.state.ownerJid = `${OWNER}@s.whatsapp.net`;
  await s.fire();
  assert.deepEqual(s.pushes, ['wa_link_down', 'identity_mismatch']);
  assert.deepEqual(sent, [], 'no message to anyone, not even the owner');
  for (const c of s.evo.calls) {
    const kind = c.path === '/instance/fetchInstances' ? 'GET'
      : c.path === '/chat/whatsappNumbers/bona-test' ? 'POST'
        : c.path === '/api/push/PUSHTOKEN0001' ? 'GET' : 'other';
    assert.equal(c.method, kind, `${c.method} ${c.path}`);
  }
  assert.ok(!s.evo.calls.some((c) => c.path.startsWith('/message/')));
  const source = fs.readFileSync(new URL('../lib/wa-link.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /wa-send\.mjs|\bsendText\b|\bsendTo\b|\/message\//, 'the module cannot reach a sender');
});

/* ---------------- test 5: cadence, health ---------------- */

test('the cadence is 10 minutes: one round per timer, each one identity read and one link probe; start twice is one loop', async () => {
  assert.equal(PROBE_EVERY_MS, 10 * MIN);
  const s = scene();
  s.link.start();
  s.link.start();
  await s.settle();
  assert.equal(s.evo.identityCalls().length, 1);
  assert.equal(s.evo.linkCalls().length, 1);
  assert.deepEqual(s.pending().map((t) => t.ms), [PROBE_EVERY_MS]);
  for (let round = 2; round <= 4; round += 1) {
    await s.fire();
    assert.equal(s.evo.identityCalls().length, round);
    assert.equal(s.evo.linkCalls().length, round);
    assert.equal(s.evo.kumaCalls().length, round);
  }
  assert.equal(s.now() - NOW, 3 * PROBE_EVERY_MS);
  assert.ok(s.timers.every((t) => t.ms === PROBE_EVERY_MS));
});

test('stop ends the loop; a probe in flight at stop changes nothing; start again probes at once', async () => {
  const s = scene();
  s.link.start();
  await s.settle();
  s.link.stop();
  assert.equal(s.pending().length, 0, 'the timer is cancelled');
  assert.equal(s.link.identityOk(), true, 'what is known stays readable');

  const t = scene();
  t.link.start();
  await t.settle();
  let release;
  t.evo.state.hold = new Promise((r) => { release = r; });
  t.evo.state.ownerJid = `${OWNER}@s.whatsapp.net`;
  t.evo.state.link = 'closed';
  const [timer] = t.pending();
  timer.fired = true;
  t.tick(timer.ms);
  timer.fn();
  const asked = t.evo.calls.length;
  t.link.stop();
  release();
  t.evo.state.hold = null;
  await t.settle();
  assert.equal(t.evo.calls.length, asked, 'the stopped probe asks nothing more: no link probe, no Kuma push');
  assert.deepEqual(t.pushes, [], 'the stopped probe raises nothing');
  assert.equal(t.link.identityOk(), true, 'and records nothing');
  assert.equal(t.pending().length, 0, 'and arms nothing');
  const before = t.evo.kumaCalls().length;
  t.evo.state.ownerJid = `${OWN}@s.whatsapp.net`;
  t.evo.state.link = 'ok';
  t.link.start();
  assert.equal(t.evo.identityCalls().length, 3, 'a new first probe at once');
  await t.settle();
  assert.equal(t.evo.kumaCalls().length, before + 1);
  assert.equal(t.pending().length, 1);
});

test("a start after a stop forgets the last answer: false until this run's first check succeeds, however recent the old one", async () => {
  const s = scene();
  s.link.start();
  await s.settle();
  assert.equal(s.link.identityOk(), true);
  s.link.stop();
  assert.equal(s.link.identityOk(), true, 'stopped: what is known stays readable');
  let release;
  s.evo.state.hold = new Promise((r) => { release = r; });
  s.evo.state.identity = 'network';
  s.link.start();
  assert.equal(s.evo.identityCalls().length, 2, 'the new run asks at once');
  assert.equal(s.link.identityOk(), false, "the previous run's answer is not this run's");
  assert.deepEqual(s.link.health(), { linkOk: true, identityOk: false });
  release();
  s.evo.state.hold = null;
  await s.settle();
  assert.equal(s.link.identityOk(), false, 'the first check of this run failed: still false, though the old answer is not 30 min old');
  assert.equal(s.evo.beats().at(-1), 'up:identity_pending');
  s.evo.state.identity = 'ok';
  await s.fire();
  assert.equal(s.link.identityOk(), true, 'a fresh check opens it');
});

test("a start after a stop forgets the good-probe streak: linkStable needs two good probes of this run that span 10 minutes", async () => {
  const s = scene();
  s.link.start();
  await s.settle();
  await s.fire();
  assert.equal(s.link.linkStable(), true, 'two good probes, 10 min apart');
  s.link.stop();
  assert.equal(s.link.linkStable(), true, 'stopped: what is known stays readable');
  // While it was stopped, WhatsApp may have dropped and come back: nothing watched it.
  let release;
  s.evo.state.hold = new Promise((r) => { release = r; });
  s.link.start();
  assert.equal(s.link.linkStable(), false, "the previous run's streak is not this run's");
  release();
  s.evo.state.hold = null;
  await s.settle();
  assert.equal(s.link.linkOk(), true);
  assert.equal(s.link.linkStable(), false, 'one good probe of this run, right after the restart (DESIGN §6.4)');
  await s.fire();
  assert.equal(s.link.linkStable(), true, 'two good probes of this run, 10 min apart');
});

test('a start after a stop also forgets the failed-check count and the alerted mismatch: each run counts and alerts on its own', async () => {
  const s = scene();
  s.evo.state.identity = 'network';
  s.link.start();
  await s.settle();
  await s.fire();
  assert.equal(s.evo.beats().at(-1), 'down:identity_unknown', 'two failed checks in a row');
  s.link.stop();
  s.link.start();
  await s.settle();
  assert.equal(s.evo.beats().at(-1), 'up:identity_pending', "one failed check of this run: the last run's failures do not count");
  await s.fire();
  assert.equal(s.evo.beats().at(-1), 'down:identity_unknown', 'two of this run');

  s.evo.state.identity = 'ok';
  s.evo.state.ownerJid = `${OWNER}@s.whatsapp.net`;
  await s.fire();
  assert.deepEqual(s.pushes, ['identity_mismatch']);
  await s.fire();
  assert.deepEqual(s.pushes, ['identity_mismatch'], 'one alert per incident within a run');
  s.link.stop();
  s.link.start();
  await s.settle();
  assert.equal(s.link.identityOk(), false);
  assert.deepEqual(s.pushes, ['identity_mismatch', 'identity_mismatch'], 'a new run alerts on its own first mismatch');
  assert.equal(s.evo.beats().at(-1), 'down:identity_mismatch');
});

test('health() is booleans only; nothing in it, the log or a Kuma push carries a number, a key or the push token', async () => {
  const s = scene();
  s.link.start();
  await s.settle();
  s.evo.state.link = 'closed';
  await s.fire();
  await s.fire();
  s.evo.state.ownerJid = `${OWNER}@s.whatsapp.net`;
  await s.fire();
  s.evo.state.identity = 'http';
  await s.fire();
  assert.ok(s.logs.some((l) => l.evt === 'wa.link.probe_failed' && l.probe === 'link'), 'a failed link probe was logged');
  for (const c of [...s.evo.identityCalls(), ...s.evo.linkCalls()]) assert.equal(c.redirect, 'error', `${c.method} ${c.path}: a redirect is never followed`);
  const h = s.link.health();
  assert.deepEqual(Object.keys(h).sort(), ['identityOk', 'linkOk']);
  assert.ok(Object.values(h).every((v) => typeof v === 'boolean'));
  assert.doesNotMatch(JSON.stringify(h), /\d/);
  assert.doesNotMatch(JSON.stringify(s.logs), /\d{6,}|evo-key|INSTANCE-TOKEN|PUSHTOKEN|kuma\.example|evo\.example|Connection Closed|Bona Real Estate/);
  for (const c of s.evo.kumaCalls()) {
    assert.deepEqual(Object.keys(c.query).sort(), ['msg', 'status']);
    assert.match(c.query.status, /^(up|down)$/);
    assert.match(c.query.msg, /^(ok|identity_pending|link_down|identity_mismatch|identity_unknown|misconfigured)$/);
    assert.equal(c.redirect, 'error', 'a push URL that redirects is never followed');
    assert.equal(c.host, 'kuma.example.com');
  }
});

/* ---------------- the Kuma push URL ---------------- */

test('the Kuma push: https anywhere, http only to this machine, never with credentials; unset or invalid → no push, the probes go on', async () => {
  for (const [raw, pushed] of [
    [undefined, false],
    ['', false],
    ['not a url', false],
    ['http://kuma.example.com/api/push/PUSHTOKEN0001', false],
    ['https://user:pw@kuma.example.com/api/push/PUSHTOKEN0001', false],
    ['ftp://kuma.example.com/api/push/PUSHTOKEN0001', false],
    ['http://127.0.0.1:3010/api/push/PUSHTOKEN0001', true],
    ['http://localhost:3010/api/push/PUSHTOKEN0001', true],
    ['https://kuma.example.com/api/push/PUSHTOKEN0001?status=up&msg=OK&ping=', true],
  ]) {
    const env = raw === undefined ? without('BONA_KUMA_WA_LINK_PUSH') : { ...ENV, BONA_KUMA_WA_LINK_PUSH: raw };
    const s = scene({ env });
    s.link.start();
    await s.settle();
    assert.equal(s.link.identityOk(), true, String(raw));
    assert.equal(s.evo.linkCalls().length, 1, String(raw));
    assert.equal(s.evo.kumaCalls().length, pushed ? 1 : 0, String(raw));
    if (pushed) assert.deepEqual(s.evo.kumaCalls()[0].query, { status: 'up', msg: 'ok' }, 'the stored query is replaced, never added to');
    const invalid = s.logs.filter((l) => l.evt === 'wa.link.kuma_invalid').length;
    assert.equal(invalid, raw && !pushed ? 1 : 0, String(raw));
    assert.doesNotMatch(JSON.stringify(s.logs), /PUSHTOKEN|user:pw/);
  }
});

test('a Kuma that fails or throws is logged by category, and the probe carries on', async () => {
  for (const [kuma, code] of [['http', 'http'], ['throw', 'network']]) {
    const s = scene();
    s.evo.state.kuma = kuma;
    s.link.start();
    await s.settle();
    assert.equal(s.link.identityOk(), true);
    assert.equal(s.pending().length, 1, 'the next probe is armed all the same');
    const failed = s.logs.filter((l) => l.evt === 'wa.link.kuma_failed');
    assert.deepEqual(failed.map((l) => l.code), [code]);
    assert.doesNotMatch(JSON.stringify(s.logs), /PUSHTOKEN|ECONNREFUSED|kuma\.example/);
  }
});

/* ---------------- the stable link (DESIGN §6.4, for the backlog rule) ---------------- */

test('linkStable: true only once two good probes in a row span 10 minutes; a failure starts the count again', async () => {
  assert.equal(LINK_STABLE_MS, 10 * MIN);
  const s = scene();
  assert.equal(s.link.linkStable(), false, 'before any probe');
  s.link.start();
  await s.settle();
  assert.equal(s.link.linkStable(), false, 'one good probe');
  s.tick(PROBE_EVERY_MS);
  assert.equal(s.link.linkStable(), false, 'time alone proves nothing');
  s.tick(-PROBE_EVERY_MS);
  await s.fire();
  assert.equal(s.link.linkStable(), true, 'two good probes, 10 min apart');
  s.evo.state.link = 'closed';
  await s.fire();
  assert.equal(s.link.linkOk(), true, 'one failure leaves linkOk');
  assert.equal(s.link.linkStable(), false, 'but not the stable link');
  s.evo.state.link = 'ok';
  await s.fire();
  assert.equal(s.link.linkStable(), false, 'the link came back: the count starts again');
  await s.fire();
  assert.equal(s.link.linkStable(), true);
  s.evo.state.ownerJid = `${OWNER}@s.whatsapp.net`;
  await s.fire();
  assert.equal(s.link.linkOk(), true, 'a round on another number leaves linkOk as it was');
  assert.equal(s.link.linkStable(), false, 'but it probes no link, so the stable count starts again');
});

/* ---------------- robustness ---------------- */

test('an alerts or a logger that throws changes nothing: the state is kept, the probe never rejects', async () => {
  const s = scene({
    alerts: { notifyOwners: () => { throw new Error('push down'); } },
    log: () => { throw new Error('log down'); },
  });
  s.link.start();
  await s.settle();
  s.evo.state.link = 'closed';
  await s.fire();
  await s.fire();
  assert.equal(s.link.linkOk(), false);
  s.evo.state.ownerJid = `${OWNER}@s.whatsapp.net`;
  await s.fire();
  assert.equal(s.link.identityOk(), false);
  assert.equal(s.link.linkOk(), false);
  assert.equal(s.evo.beats().at(-1), 'down:identity_mismatch');
  assert.equal(s.pending().length, 1);
  await assert.doesNotReject(s.link.probe());

  const quiet = scene({ alerts: null });
  quiet.evo.state.ownerJid = `${OWNER}@s.whatsapp.net`;
  quiet.link.start();
  await quiet.settle();
  assert.equal(quiet.link.identityOk(), false, 'no alerts module: the guard still closes');
});

test('probe() outside the loop runs one round, and a second call while it runs is the same round', async () => {
  const s = scene();
  const a = s.link.probe();
  const b = s.link.probe();
  assert.equal(a, b);
  await a;
  assert.equal(s.evo.identityCalls().length, 1);
  assert.equal(s.link.identityOk(), true);
  assert.equal(s.pending().length, 0, 'only start() arms the timer');
});
