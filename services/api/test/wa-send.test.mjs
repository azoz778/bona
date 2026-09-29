/**
 * The one door every message to someone other than the owner goes out through: a 1:1
 * jid only, the owner's sending switch, limits shared by every sender, an outbox row
 * written before every call, and team members' replies that are never sent twice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createTeam } from '../lib/team.mjs';
import { createInboxStore } from '../lib/inbox/store.mjs';
import { createIngest } from '../lib/inbox/ingest.mjs';
import {
  createSender, replyJidFor, SEND_PER_MIN, SEND_PER_DAY, PER_RECIPIENT_PER_MIN, PER_USER_PER_MIN,
} from '../lib/wa-send.mjs';

const NOW = 1_790_500_000_000;
const DAY = 86_400_000;
const ENV = { EVOLUTION_API_URL: 'http://evo.test/', EVOLUTION_API_KEY: 'k', BONA_WA_INSTANCE: 'abdulaziz-personal' };
const OWNER_JID = '966593296933@s.whatsapp.net';
const CLIENT = '966511111111';
const CLIENT_JID = `${CLIENT}@s.whatsapp.net`;
const SID = 'sid_0123456789abcdef';

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
const netError = (code) => Object.assign(new Error('boom'), { cause: { code } });

/**
 * `reply(n)` answers the n-th HTTP call: `{ status, body }`, or `{ throws: err }` to
 * make the call itself fail. Each call also records how many outbox rows were
 * `pending` at that moment — the row must be written before the call, not after.
 */
function harness({ reply = () => ({ status: 201, body: { key: { id: 'KEY-1' } } }), env = ENV, limits, replies = true } = {}) {
  const s = openDb(':memory:');
  let clock = NOW;
  const team = createTeam(s, { now: () => clock });
  // Dashboard replies ship switched off (design D14). These tests are about what a reply
  // does once the owner has turned them on; `replies: false` is the state that ships.
  if (replies) team.setSetting('inbox_replies', '1');
  const inbox = createInboxStore(s, { now: () => clock });
  const calls = [];
  const logs = [];
  const pendingNow = () => s.db.prepare("SELECT COUNT(*) AS n FROM wa_outbox WHERE status = 'pending'").get().n;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body), pending: pendingNow() });
    const r = await reply(calls.length);
    if (r.throws) throw r.throws;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body ?? {}) };
  };
  const sender = createSender({ env, team, inbox, db: s, fetchImpl, now: () => clock, log: (o) => logs.push(o), limits });
  return { s, team, inbox, sender, calls, logs, now: () => clock, tick: (ms) => { clock += ms; } };
}

/** A result that reached the outbox carries its send id; the rest compares as it always did. */
function withoutSendId(out) {
  assert.match(out.sendId, /^SND-/);
  const rest = { ...out };
  delete rest.sendId;
  return rest;
}

const outboxRows = (h) => h.s.db.prepare('SELECT * FROM wa_outbox ORDER BY created, rowid').all();

let seedSeq = 0;
/** Rows written straight into the outbox, with a chosen age — the ledger a busy day leaves. */
function seedOutbox(h, n, { created = h.now(), jid = '966502000000@s.whatsapp.net', status = 'accepted', kind = 'staff' } = {}) {
  const stmt = h.s.db.prepare(`INSERT INTO wa_outbox (send_id, lead_id, jid, text, user_id, sender_kind, status, key_id, created, updated, error)
                               VALUES (?, NULL, ?, NULL, NULL, ?, ?, NULL, ?, ?, NULL)`);
  h.s.transaction(() => {
    for (let i = 0; i < n; i += 1) {
      seedSeq += 1;
      stmt.run(`SEED-${seedSeq}`, jid, kind, status, created, created);
    }
  });
}

/** An inbox chat with a phone jid and one message from the client a minute ago. */
function seedChat(h, patch = {}) {
  const lead = h.s.insertLead({
    lead_id: 'L-1', created: NOW - 3_600_000, updated: NOW - 3_600_000, phone_e164: CLIENT, wa_jid: CLIENT_JID,
    channel: 'whatsapp', match_method: 'ref', inbox_state: 'in', inbox_since: NOW - 3_600_000, ...patch,
  });
  h.inbox.upsertMessage({ key_id: `IN-${lead.lead_id}`, lead_id: lead.lead_id, jid: CLIENT_JID, direction: 'in', sender_kind: 'client', text: 'hi', ts: NOW - 60_000 });
  return lead;
}

const staffOf = (h) => h.team.addUser({ name: 'Sara', phone: '966500000077' });
/**
 * The revision `seedChat` leaves L-1 at: its one message is the chat's first row. A test
 * that stores more in L-1 before replying passes the revision its page was drawn at.
 */
const SEEN_REV = 1;
const replyArgs = (staff, patch = {}) => ({ sendId: SID, leadId: 'L-1', userId: staff.user_id, text: 'hello', seenRev: SEEN_REV, ...patch });

/* ------------------------------ the gate (Phase 1, kept) ------------------------------ */

test('sends the text to that number on the owner instance and returns the WhatsApp message id', async () => {
  const h = harness();
  const out = await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'hello', kind: 'code' });
  assert.deepEqual(withoutSendId(out), { ok: true, keyId: 'KEY-1', status: 201 });
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

test('bad_kind: "code" and "staff" are the real kinds in Phase 2; Dana waits for Phase 4', async () => {
  const h = harness();
  const jid = '966500000001@s.whatsapp.net';
  assert.deepEqual(await h.sender.sendTo({ jid, text: 'x', kind: 'reply' }), { ok: false, error: 'bad_kind' });
  assert.deepEqual(await h.sender.sendTo({ jid, text: 'x', kind: 'dana' }), { ok: false, error: 'bad_kind' });
  assert.deepEqual(await h.sender.sendTo({ jid, text: 'x', kind: 'note' }), { ok: false, error: 'bad_kind' });
  assert.deepEqual(await h.sender.sendTo({ jid, text: 'x' }), { ok: false, error: 'bad_kind' });
  assert.equal(h.calls.length, 0);
  assert.equal((await h.sender.sendTo({ jid, text: 'x', kind: 'staff' })).ok, true);
  h.s.close();
});

test('the sending switch stops everything except what is allowed to bypass it', async () => {
  const h = harness();
  h.team.setSetting('sending_enabled', '0');
  assert.deepEqual(await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' }), { ok: false, error: 'sending_disabled' });
  assert.deepEqual(await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'staff' }), { ok: false, error: 'sending_disabled' });
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
  // nor for a reply, even one addressed to the owner.
  assert.deepEqual(
    await h.sender.sendTo({ jid: OWNER_JID, text: 'x', kind: 'staff', bypassSwitch: true }),
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

test('a 4xx fails; a timeout is "uncertain", never retried here', async () => {
  const bad = harness({ reply: () => ({ status: 400, body: {} }) });
  assert.deepEqual(withoutSendId(await bad.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' })), { ok: false, error: 'http_400' });
  bad.s.close();

  const s = openDb(':memory:');
  const team = createTeam(s);
  const slow = createSender({
    env: ENV, team, inbox: createInboxStore(s), timeoutMs: 5,
    fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(abortError()))),
  });
  assert.deepEqual(withoutSendId(await slow.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' })), { ok: false, error: 'timeout', uncertain: true });
  s.close();
});

test('any 5xx (500, 502, 503, 504) is "uncertain": the request may well have gone through', async () => {
  for (const status of [500, 502, 503, 504]) {
    const h = harness({ reply: () => ({ status, body: {} }) });
    assert.deepEqual(
      withoutSendId(await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' })),
      { ok: false, error: `http_${status}`, uncertain: true },
      String(status),
    );
    h.s.close();
  }
});

test('only a 4xx is a definite HTTP failure: 400, 401, 404, 422 and 429 all fail', async () => {
  for (const status of [400, 401, 404, 422, 429]) {
    const h = harness({ reply: () => ({ status, body: {} }) });
    assert.deepEqual(
      withoutSendId(await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' })),
      { ok: false, error: `http_${status}` },
      String(status),
    );
    assert.equal(outboxRows(h)[0].status, 'failed', String(status));
    h.s.close();
  }
});

test('a definite pre-connection failure (refused, unknown host, DNS) is not "uncertain"', async () => {
  const s = openDb(':memory:');
  const team = createTeam(s);
  const inbox = createInboxStore(s);
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
    const sender = createSender({ env: ENV, team, inbox, fetchImpl: async () => { throw netError(code); } });
    assert.deepEqual(
      withoutSendId(await sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' })),
      { ok: false, error: 'network' },
      code,
    );
  }
  s.close();
});

test('any other thrown error is "network" but "uncertain" — we cannot tell if it sent', async () => {
  const s = openDb(':memory:');
  const team = createTeam(s);
  const inbox = createInboxStore(s);
  const causes = [
    netError('ECONNRESET'),
    Object.assign(new Error('mystery'), {}),
    new TypeError('fetch failed'),
  ];
  for (const err of causes) {
    const sender = createSender({ env: ENV, team, inbox, fetchImpl: async () => { throw err; } });
    assert.deepEqual(
      withoutSendId(await sender.sendTo({ jid: '966500000002@s.whatsapp.net', text: 'x', kind: 'code' })),
      { ok: false, error: 'network', uncertain: true },
      err.message,
    );
  }
  s.close();
});

test('a 2xx counts as sent only when the body carries a WhatsApp message id', async () => {
  const h = harness({ reply: () => ({ status: 200, body: { success: true, note: 'super-secret-body-marker' } }) });
  const out = await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' });
  assert.deepEqual(withoutSendId(out), { ok: false, error: 'no_ack', uncertain: true });
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
    env: ENV, team, inbox: createInboxStore(s), timeoutMs: 5, log: (o) => logs.push(o),
    fetchImpl: (url, init) => Promise.resolve({
      ok: true,
      status: 200,
      text: () => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(abortError()))),
    }),
  });
  assert.deepEqual(
    withoutSendId(await sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' })),
    { ok: false, error: 'no_ack', uncertain: true },
  );
  assert.ok(logs.some((l) => l.evt === 'wa.send.no_key'));
  s.close();
});

test('BONA_WA_NOTIFY=0 does not block a login code (only other kinds would need it)', async () => {
  const h = harness({ env: { ...ENV, BONA_WA_NOTIFY: '0' } });
  const out = await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' });
  assert.equal(out.ok, true);
  assert.deepEqual(await h.sender.sendTo({ jid: '966500000002@s.whatsapp.net', text: 'x', kind: 'staff' }), { ok: false, error: 'disabled' });
  assert.equal(h.calls.length, 1, 'the reply never reached the network');
  h.s.close();
});

test('no Evolution credentials: nothing is attempted', async () => {
  const h = harness({ env: {} });
  assert.deepEqual(await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' }), { ok: false, error: 'evolution-not-configured' });
  assert.equal(h.calls.length, 0);
  h.s.close();
});

/* ------------------------------ construction ------------------------------ */

test('createSender needs the inbox store; reply also needs the db', async () => {
  const s = openDb(':memory:');
  const team = createTeam(s);
  assert.throws(() => createSender({ env: ENV, team }), TypeError);
  assert.throws(() => createSender({ env: ENV, inbox: createInboxStore(s) }), TypeError);
  const noDb = createSender({ env: ENV, team, inbox: createInboxStore(s), fetchImpl: async () => { throw new Error('never called'); } });
  await assert.rejects(noDb.reply({ sendId: SID, leadId: 'L-1', userId: 'U', text: 'x', seenRev: 0 }), TypeError);
  s.close();
});

/* ------------------------------ the outbox ledger ------------------------------ */

test('every send is written to the outbox before the call, then marked with what came back', async () => {
  const cases = [
    { name: 'ok', reply: () => ({ status: 201, body: { key: { id: 'KEY-9' } } }), status: 'accepted', key_id: 'KEY-9', error: null },
    { name: 'timeout', reply: () => ({ throws: abortError() }), status: 'uncertain', key_id: null, error: 'timeout' },
    { name: '502', reply: () => ({ status: 502 }), status: 'uncertain', key_id: null, error: 'http_502' },
    { name: '504', reply: () => ({ status: 504 }), status: 'uncertain', key_id: null, error: 'http_504' },
    { name: 'no_ack', reply: () => ({ status: 200, body: { success: true } }), status: 'uncertain', key_id: null, error: 'no_ack' },
    { name: '400', reply: () => ({ status: 400 }), status: 'failed', key_id: null, error: 'http_400' },
    { name: 'refused', reply: () => ({ throws: netError('ECONNREFUSED') }), status: 'failed', key_id: null, error: 'network' },
    { name: 'reset', reply: () => ({ throws: netError('ECONNRESET') }), status: 'uncertain', key_id: null, error: 'network' },
  ];
  for (const c of cases) {
    const h = harness({ reply: c.reply });
    const out = await h.sender.sendTo({ jid: CLIENT_JID, text: 'hello', kind: 'staff', userId: 'USR-a', leadId: 'L-1' });
    assert.equal(h.calls.length, 1, c.name);
    assert.equal(h.calls[0].pending, 1, `${c.name}: the row was pending while the call was in flight`);
    assert.equal(out.ok, c.status === 'accepted', c.name);
    assert.equal(out.uncertain, c.status === 'uncertain' ? true : undefined, c.name);
    const row = h.inbox.getOutbox(out.sendId);
    assert.deepEqual(
      { lead_id: row.lead_id, jid: row.jid, text: row.text, user_id: row.user_id, sender_kind: row.sender_kind, status: row.status, key_id: row.key_id, error: row.error },
      { lead_id: 'L-1', jid: CLIENT_JID, text: 'hello', user_id: 'USR-a', sender_kind: 'staff', status: c.status, key_id: c.key_id, error: c.error },
      c.name,
    );
    assert.equal(row.created, NOW, c.name);
    h.s.close();
  }
});

test('a login code row keeps neither the code nor a lead', async () => {
  const h = harness();
  const out = await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'Your Bona code is 482915', kind: 'code', leadId: 'L-1' });
  assert.equal(out.ok, true);
  const row = h.inbox.getOutbox(out.sendId);
  assert.equal(row.sender_kind, 'code');
  assert.equal(row.text, null);
  assert.equal(row.lead_id, null);
  assert.equal(row.status, 'accepted');
  assert.ok(!JSON.stringify(outboxRows(h)).includes('482915'), 'the code is nowhere in the outbox');
  h.s.close();
});

test('a refusal before the call writes no row of its own', async () => {
  const h = harness();
  await h.sender.sendTo({ jid: '123456789@lid', text: 'x', kind: 'staff' });
  h.team.setSetting('sending_enabled', '0');
  await h.sender.sendTo({ jid: CLIENT_JID, text: 'x', kind: 'staff' });
  h.team.setSetting('sending_enabled', '1');
  for (let i = 0; i < PER_RECIPIENT_PER_MIN; i += 1) await h.sender.sendTo({ jid: CLIENT_JID, text: 'x', kind: 'staff' });
  assert.deepEqual(await h.sender.sendTo({ jid: CLIENT_JID, text: 'x', kind: 'staff' }), { ok: false, error: 'rate_limited' });
  assert.equal(outboxRows(h).length, PER_RECIPIENT_PER_MIN, 'only the sends that were attempted');
  h.s.close();
});

test('a refusal closes a row the caller already wrote, so it never lingers as pending', async () => {
  const h = harness();
  h.inbox.insertOutbox({ send_id: SID, lead_id: 'L-1', jid: CLIENT_JID, text: 'x', user_id: 'USR-a', sender_kind: 'staff' });
  h.team.setSetting('sending_enabled', '0');
  assert.deepEqual(
    await h.sender.sendTo({ jid: CLIENT_JID, text: 'x', kind: 'staff', userId: 'USR-a', leadId: 'L-1', sendId: SID }),
    { ok: false, error: 'sending_disabled', sendId: SID },
  );
  const row = h.inbox.getOutbox(SID);
  assert.equal(row.status, 'failed');
  assert.equal(row.error, 'sending_disabled');
  assert.equal(h.calls.length, 0);
  h.s.close();
});

test('a send id that has already been decided is never sent again', async () => {
  const h = harness();
  for (const status of ['uncertain', 'accepted', 'failed']) {
    const sendId = `${SID}_${status}`;
    h.inbox.insertOutbox({ send_id: sendId, lead_id: 'L-1', jid: CLIENT_JID, text: 'x', user_id: 'USR-a', sender_kind: 'staff', status });
    assert.deepEqual(
      await h.sender.sendTo({ jid: CLIENT_JID, text: 'x', kind: 'staff', userId: 'USR-a', leadId: 'L-1', sendId }),
      { ok: false, error: 'duplicate', sendId },
      status,
    );
    assert.equal(h.inbox.getOutbox(sendId).status, status, `${status} row left as it was`);
  }
  assert.equal(h.calls.length, 0);
  h.s.close();
});

test('a send id this file makes itself carries 64 random bits, so two sends in one millisecond never share a row', async () => {
  const h = harness();
  const ids = new Set();
  for (let i = 0; i < PER_RECIPIENT_PER_MIN; i += 1) {
    const out = await h.sender.sendTo({ jid: CLIENT_JID, text: 'x', kind: 'staff', userId: 'USR-a' });
    assert.match(out.sendId, /^SND-[0-9a-z]+-[0-9a-f]{16}$/);
    ids.add(out.sendId);
  }
  assert.equal(ids.size, PER_RECIPIENT_PER_MIN);
  assert.equal(outboxRows(h).length, PER_RECIPIENT_PER_MIN, 'one row per send');
  h.s.close();
});

test('a ledger write that fails after a 2xx with a key still answers ok, logged without the number or the text', async () => {
  const h = harness();
  const brittle = { ...h.inbox, updateOutbox: () => { throw Object.assign(new Error('disk full'), { code: 'ERR_SQLITE_ERROR' }); } };
  const logs = [];
  const sender = createSender({
    env: ENV, team: h.team, inbox: brittle, db: h.s, now: h.now, log: (o) => logs.push(o),
    fetchImpl: async () => ({ ok: true, status: 201, text: async () => JSON.stringify({ key: { id: 'KEY-7' } }) }),
  });
  const out = await sender.sendTo({ jid: CLIENT_JID, text: 'secret-ledger-marker', kind: 'staff', userId: 'USR-a', leadId: 'L-1' });
  assert.deepEqual(withoutSendId(out), { ok: true, keyId: 'KEY-7', status: 201 }, 'it went: saying otherwise would invite a second send');
  assert.equal(h.inbox.getOutbox(out.sendId).status, 'pending', 'left pending: the poller or the next restart settles it');
  const entry = logs.find((l) => l.evt === 'wa.send.ledger_failed');
  assert.ok(entry, 'the failed write is logged');
  assert.equal(entry.error, 'ERR_SQLITE_ERROR');
  const logged = JSON.stringify(logs);
  assert.ok(!logged.includes('secret-ledger-marker'));
  assert.ok(!logged.includes(CLIENT));
  h.s.close();
});

/* ------------------------------ the durable day cap ------------------------------ */

test('500 sends in the last 24 hours stop everyone but the owner — and a restart does not reset it', async () => {
  const h = harness();
  seedOutbox(h, SEND_PER_DAY, { created: NOW - 60_000 });
  assert.deepEqual(await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' }), { ok: false, error: 'rate_limited' });
  assert.deepEqual(await h.sender.sendTo({ jid: CLIENT_JID, text: 'x', kind: 'staff', userId: 'USR-a' }), { ok: false, error: 'rate_limited' });
  assert.ok(h.logs.some((l) => l.evt === 'wa.send.rate_limited' && l.limit === 'day'));
  assert.equal((await h.sender.sendTo({ jid: OWNER_JID, text: 'x', kind: 'code', bypassSwitch: true })).ok, true, "the owner's own code still goes");
  assert.equal(h.calls.length, 1);

  // A fresh process over the same file: the in-memory limiters are new, the ledger is not.
  const again = createSender({ env: ENV, team: h.team, inbox: createInboxStore(h.s, { now: h.now }), db: h.s, now: h.now, fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.deepEqual(await again.sendTo({ jid: '966500000003@s.whatsapp.net', text: 'x', kind: 'code' }), { ok: false, error: 'rate_limited' });
  h.s.close();
});

test('499 in the last 24 hours (codes and replies alike): one more goes, and that one fills the day', async () => {
  const h = harness();
  seedOutbox(h, 250, { created: NOW - 3_600_000, kind: 'code' });
  seedOutbox(h, SEND_PER_DAY - 1 - 250, { created: NOW - 3_600_000, kind: 'staff', status: 'uncertain' });
  assert.equal((await h.sender.sendTo({ jid: CLIENT_JID, text: 'x', kind: 'staff', userId: 'USR-a' })).ok, true);
  assert.deepEqual(await h.sender.sendTo({ jid: '966500000001@s.whatsapp.net', text: 'x', kind: 'code' }), { ok: false, error: 'rate_limited' });
  h.s.close();
});

test('rows older than 24 hours, rows to the owner and failed rows do not count', async () => {
  const h = harness();
  seedOutbox(h, SEND_PER_DAY, { created: NOW - DAY - 1 });
  seedOutbox(h, SEND_PER_DAY, { jid: OWNER_JID, kind: 'code' });
  seedOutbox(h, SEND_PER_DAY, { status: 'failed' });
  assert.equal((await h.sender.sendTo({ jid: CLIENT_JID, text: 'x', kind: 'staff', userId: 'USR-a' })).ok, true);
  h.s.close();
});

test('the day is rolling: a send becomes possible the moment the oldest of the 500 turns 24 hours old', async () => {
  const h = harness();
  seedOutbox(h, SEND_PER_DAY, { created: NOW - DAY + 1_000 });
  h.tick(1_000);
  assert.deepEqual(await h.sender.sendTo({ jid: CLIENT_JID, text: 'x', kind: 'staff' }), { ok: false, error: 'rate_limited' }, 'exactly 24 hours old still counts');
  h.tick(1);
  assert.equal((await h.sender.sendTo({ jid: CLIENT_JID, text: 'x', kind: 'staff' })).ok, true);
  h.s.close();
});

/* ------------------------------ per user ------------------------------ */

test('per user: 30 a minute from one team member; another member and a login code still go', async () => {
  // The shipped 20 a minute across everyone always refuses before one person's 30 could,
  // so the shared limit is widened here to reach the per-user one.
  const h = harness({ limits: { perMinute: 100 } });
  const to = (n) => `9665010${String(n).padStart(5, '0')}@s.whatsapp.net`;
  for (let i = 0; i < PER_USER_PER_MIN; i += 1) {
    assert.equal((await h.sender.sendTo({ jid: to(i), text: 'x', kind: 'staff', userId: 'USR-a' })).ok, true, `send ${i + 1}`);
  }
  assert.deepEqual(await h.sender.sendTo({ jid: to(100), text: 'x', kind: 'staff', userId: 'USR-a' }), { ok: false, error: 'rate_limited' });
  assert.equal((await h.sender.sendTo({ jid: to(101), text: 'x', kind: 'staff', userId: 'USR-b' })).ok, true, 'another member has their own allowance');
  assert.equal((await h.sender.sendTo({ jid: to(102), text: 'x', kind: 'code' })).ok, true, 'a login code has no member behind it');
  h.tick(60_000);
  assert.equal((await h.sender.sendTo({ jid: to(103), text: 'x', kind: 'staff', userId: 'USR-a' })).ok, true, 'refills');
  h.s.close();
});

/* ------------------------------ where a reply goes ------------------------------ */

test('replyJidFor: the phone jid (device suffix stripped), else the stored number, never a lid', () => {
  assert.equal(replyJidFor({ wa_jid: '966511111111@s.whatsapp.net' }), '966511111111@s.whatsapp.net');
  assert.equal(replyJidFor({ wa_jid: '966511111111:7@s.whatsapp.net' }), '966511111111@s.whatsapp.net');
  assert.equal(replyJidFor({ wa_jid: null, wa_lid: '123456789012@lid', phone_e164: '966522222222' }), '966522222222@s.whatsapp.net');
  assert.equal(replyJidFor({ wa_jid: '0501234567@s.whatsapp.net', phone_e164: '966533333333' }), '966533333333@s.whatsapp.net');
  assert.equal(replyJidFor({ wa_jid: null, wa_lid: '123456789012@lid', phone_e164: null }), null);
  assert.equal(replyJidFor({ phone_e164: '0501234567' }), null, 'a local-format number is not an address');
  assert.equal(replyJidFor({ phone_e164: '1234567' }), null, 'too short');
  assert.equal(replyJidFor(null), null);
});

/* ------------------------------ reply ------------------------------ */

test('reply: sent to the phone jid, stored as the member\'s message, and the chat marked answered', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h, { needs_human: 1 });
  assert.equal(h.inbox.revision('L-1'), SEEN_REV, 'the revision replyArgs says its page was drawn at');
  const out = await h.sender.reply(replyArgs(staff));
  assert.deepEqual(out, { ok: true, status: 'accepted', sendId: SID, keyId: 'KEY-1' });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].body, { number: CLIENT, text: 'hello' });

  const row = h.inbox.getOutbox(SID);
  assert.deepEqual(
    { lead_id: row.lead_id, jid: row.jid, text: row.text, user_id: row.user_id, sender_kind: row.sender_kind, status: row.status, key_id: row.key_id },
    { lead_id: 'L-1', jid: CLIENT_JID, text: 'hello', user_id: staff.user_id, sender_kind: 'staff', status: 'accepted', key_id: 'KEY-1' },
  );
  const last = h.inbox.messagesFor('L-1').at(-1);
  assert.deepEqual(
    { key_id: last.key_id, jid: last.jid, direction: last.direction, sender_kind: last.sender_kind, sender_user_id: last.sender_user_id, text: last.text, ts: last.ts, status: last.status },
    { key_id: 'KEY-1', jid: CLIENT_JID, direction: 'out', sender_kind: 'staff', sender_user_id: staff.user_id, text: 'hello', ts: NOW, status: 'sent' },
  );
  const lead = h.s.getLead('L-1');
  assert.equal(lead.handler_user_id, staff.user_id, 'the first to reply becomes the handler');
  assert.equal(lead.first_reply_ts, NOW);
  assert.equal(lead.needs_human, 0);
  assert.equal(lead.last_msg_ts, NOW);
  h.s.close();
});

test('reply: stored at the moment its send started, to the whole second — a client message during the round trip reads as newer, unread and stale', async () => {
  const h = harness({
    reply: () => {
      // While the call is out the client writes (WhatsApp stamps whole seconds), the poller
      // stores it, and the round trip takes its time.
      h.inbox.upsertMessage({ key_id: 'IN-during', lead_id: 'L-1', jid: CLIENT_JID, direction: 'in', sender_kind: 'client', text: 'and parking?', ts: NOW + 1_000 });
      h.tick(3_000);
      return { status: 201, body: { key: { id: 'KEY-1' } } };
    },
  });
  const staff = staffOf(h);
  seedChat(h);
  h.tick(700);
  assert.equal((await h.sender.reply(replyArgs(staff))).ok, true);
  assert.equal(h.inbox.getOutbox(SID).created, NOW + 700, 'the send started here');
  const mine = h.inbox.messageByKey('KEY-1');
  assert.equal(mine.ts, NOW, "the outbox row's created, floored to the second — not the moment WhatsApp answered");
  assert.deepEqual(h.inbox.messagesFor('L-1').map((m) => m.key_id), ['IN-L-1', 'KEY-1', 'IN-during'], 'the client\'s message reads after the reply that never saw it');
  assert.equal(h.inbox.newestTs('L-1'), NOW + 1_000);
  // A read mark up to the writer's own reply still counts the client's message unread…
  h.inbox.markRead(staff.user_id, 'L-1', mine.ts);
  assert.equal(h.inbox.listInbox({ userId: staff.user_id }).find((l) => l.lead_id === 'L-1').unread, 1);
  // …and another reply from the page the first was written on is held as stale.
  assert.deepEqual(await h.sender.reply(replyArgs(staff, { sendId: 'sid_fedcba9876543210' })), { ok: false, error: 'stale' });
  assert.equal(h.s.getLead('L-1').first_reply_ts, NOW + 3_700, "the watchdog's first reply is when WhatsApp took it");
  h.s.close();
});

test('reply: an existing handler and an earlier first reply are left alone', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h, { handler_user_id: 'USR-other', first_reply_ts: NOW - 5_000 });
  assert.equal((await h.sender.reply(replyArgs(staff))).ok, true);
  const lead = h.s.getLead('L-1');
  assert.equal(lead.handler_user_id, 'USR-other');
  assert.equal(lead.first_reply_ts, NOW - 5_000);
  h.s.close();
});

test('reply: the text goes out trimmed, with browser line breaks made plain', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h);
  assert.equal((await h.sender.reply(replyArgs(staff, { text: '  line one\r\nline two \r\n' }))).ok, true);
  assert.equal(h.calls[0].body.text, 'line one\nline two');
  assert.equal(h.inbox.getOutbox(SID).text, 'line one\nline two', 'the ledger holds what WhatsApp will hand back');
  h.s.close();
});

test('reply: bad_send_id for anything that is not a form send id', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h);
  for (const sendId of [undefined, null, 42, '', 'short', 'has spaces in it 0123', 'x'.repeat(65), 'sid_<script>alert1']) {
    assert.deepEqual(await h.sender.reply(replyArgs(staff, { sendId })), { ok: false, error: 'bad_send_id' }, String(sendId));
  }
  assert.equal(h.calls.length, 0);
  assert.equal(outboxRows(h).length, 0);
  h.s.close();
});

test('reply: a double submit with the same send id makes one call and returns the first answer', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h);
  assert.equal((await h.sender.reply(replyArgs(staff))).ok, true);
  assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: true, duplicate: true, status: 'accepted', sendId: SID, error: null });
  assert.equal(h.calls.length, 1);
  assert.equal(h.inbox.messagesFor('L-1').filter((m) => m.direction === 'out').length, 1);
  h.s.close();
});

test('reply: two submits at once make one call; the second is told the first is on its way', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h);
  const [first, second] = await Promise.all([h.sender.reply(replyArgs(staff)), h.sender.reply(replyArgs(staff))]);
  assert.deepEqual(first, { ok: true, status: 'accepted', sendId: SID, keyId: 'KEY-1' });
  assert.deepEqual(second, { ok: false, duplicate: true, status: 'pending', sendId: SID, error: 'pending', uncertain: true });
  assert.equal(h.calls.length, 1);
  h.s.close();
});

test('reply: an uncertain first attempt is never retried by a second submit', async () => {
  const h = harness({ reply: (n) => (n === 1 ? { status: 504 } : { status: 201, body: { key: { id: 'KEY-2' } } }) });
  const staff = staffOf(h);
  seedChat(h);
  assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: false, error: 'http_504', status: 'uncertain', sendId: SID, uncertain: true });
  assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: false, duplicate: true, status: 'uncertain', sendId: SID, error: 'http_504', uncertain: true });
  assert.equal(h.calls.length, 1, 'the second submit never reached the network');
  assert.equal(h.inbox.messagesFor('L-1').filter((m) => m.direction === 'out').length, 0, 'nothing stored: the poller decides once WhatsApp shows it');
  assert.equal(h.s.getLead('L-1').first_reply_ts, null);
  h.s.close();
});

test('reply: a 500 or a 503 is "not sure it went" — counted against the day, stored nowhere, never retried; a 400 failed', async () => {
  for (const status of [500, 503]) {
    const h = harness({ reply: (n) => (n === 1 ? { status } : { status: 201, body: { key: { id: 'KEY-2' } } }) });
    const staff = staffOf(h);
    seedChat(h);
    assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: false, error: `http_${status}`, status: 'uncertain', sendId: SID, uncertain: true }, String(status));
    const row = h.inbox.getOutbox(SID);
    assert.deepEqual({ status: row.status, error: row.error }, { status: 'uncertain', error: `http_${status}` }, String(status));
    assert.equal(h.inbox.countSentSince(NOW - DAY), 1, `${status}: it may have gone, so it counts against the day`);
    assert.deepEqual(
      await h.sender.reply(replyArgs(staff)),
      { ok: false, duplicate: true, status: 'uncertain', sendId: SID, error: `http_${status}`, uncertain: true },
      `${status}: a second submit is told the same`,
    );
    assert.equal(h.calls.length, 1, `${status}: never retried`);
    assert.equal(h.inbox.messagesFor('L-1').filter((m) => m.direction === 'out').length, 0, `${status}: not stored as sent`);
    assert.equal(h.s.getLead('L-1').first_reply_ts, null, String(status));
    h.s.close();
  }

  const h = harness({ reply: () => ({ status: 400 }) });
  const staff = staffOf(h);
  seedChat(h);
  assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: false, error: 'http_400', status: 'failed', sendId: SID });
  assert.equal(h.inbox.getOutbox(SID).status, 'failed');
  assert.equal(h.inbox.countSentSince(NOW - DAY), 0, 'a refused request never reached WhatsApp: it costs nothing');
  h.s.close();
});

test('reply: a send id reused on another chat or by another member is bad_send_id', async () => {
  const h = harness();
  const staff = staffOf(h);
  const other = h.team.addUser({ name: 'Omar', phone: '966500000088' });
  seedChat(h);
  seedChat(h, { lead_id: 'L-2', phone_e164: '966522222222', wa_jid: '966522222222@s.whatsapp.net' });
  assert.equal((await h.sender.reply(replyArgs(staff))).ok, true);
  assert.deepEqual(await h.sender.reply(replyArgs(staff, { leadId: 'L-2' })), { ok: false, error: 'bad_send_id' });
  assert.deepEqual(await h.sender.reply(replyArgs(other)), { ok: false, error: 'bad_send_id' });
  assert.equal(h.calls.length, 1);
  h.s.close();
});

test('reply: bad_text for empty, blank, oversized or missing text — and nothing is written', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h);
  for (const text of ['', '   \n\t ', 'a'.repeat(4097), undefined, null, 12]) {
    assert.deepEqual(await h.sender.reply(replyArgs(staff, { text })), { ok: false, error: 'bad_text' }, String(text).slice(0, 10));
  }
  assert.equal(h.calls.length, 0);
  assert.equal(outboxRows(h).length, 0);
  assert.equal((await h.sender.reply(replyArgs(staff, { text: 'a'.repeat(4096) }))).ok, true, '4096 exactly is fine');
  h.s.close();
});

test('reply: not_found, and not_in_inbox for an unsure, out or never-sorted chat', async () => {
  const h = harness();
  const staff = staffOf(h);
  assert.deepEqual(await h.sender.reply(replyArgs(staff, { leadId: 'L-nope' })), { ok: false, error: 'not_found' });
  seedChat(h, { lead_id: 'L-u', inbox_state: 'unsure', phone_e164: '966522222201', wa_jid: '966522222201@s.whatsapp.net' });
  seedChat(h, { lead_id: 'L-o', inbox_state: 'out', phone_e164: '966522222202', wa_jid: '966522222202@s.whatsapp.net' });
  seedChat(h, { lead_id: 'L-n', inbox_state: null, phone_e164: '966522222203', wa_jid: '966522222203@s.whatsapp.net' });
  for (const leadId of ['L-u', 'L-o', 'L-n']) {
    assert.deepEqual(await h.sender.reply(replyArgs(staff, { leadId })), { ok: false, error: 'not_in_inbox' }, leadId);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(outboxRows(h).length, 0);
  h.s.close();
});

test('reply: lid_only for a chat we only know by its lid ("reply from your phone")', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h, { phone_e164: null, wa_jid: null, wa_lid: '123456789012@lid' });
  assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: false, error: 'lid_only' });
  assert.equal(h.calls.length, 0);
  assert.equal(outboxRows(h).length, 0);
  h.s.close();
});

test('reply: excluded for a team number or a never-list number, even on an in chat', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h, { lead_id: 'L-t', phone_e164: '966500000077', wa_jid: '966500000077@s.whatsapp.net' });
  h.team.addNever({ phone: '966522222299' });
  seedChat(h, { lead_id: 'L-x', phone_e164: '966522222299', wa_jid: '966522222299@s.whatsapp.net' });
  assert.deepEqual(await h.sender.reply(replyArgs(staff, { leadId: 'L-t' })), { ok: false, error: 'excluded' });
  assert.deepEqual(await h.sender.reply(replyArgs(staff, { leadId: 'L-x' })), { ok: false, error: 'excluded' });
  assert.equal(h.calls.length, 0);
  assert.equal(outboxRows(h).length, 0);
  h.s.close();
});

test('reply: stale when a newer message exists (either direction) or the form did not say what revision it saw', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h);
  h.inbox.upsertMessage({ key_id: 'OUT-phone', lead_id: 'L-1', jid: CLIENT_JID, direction: 'out', sender_kind: 'owner_number', text: 'on it', ts: NOW - 10_000 });
  assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: false, error: 'stale' }, 'the owner answered from his phone meanwhile');
  const current = h.inbox.revision('L-1');
  for (const seenRev of [undefined, null, NaN, Infinity, -Infinity, 1.5, String(current), [current], {}]) {
    assert.deepEqual(await h.sender.reply(replyArgs(staff, { seenRev })), { ok: false, error: 'stale' }, String(seenRev));
  }
  assert.equal(h.calls.length, 0);
  assert.equal(outboxRows(h).length, 0);
  assert.equal((await h.sender.reply(replyArgs(staff, { seenRev: current }))).ok, true, 'having seen the newest, it goes');
  h.s.close();
});

test('reply: a second member on a page drawn before an accepted reply is stale, though that reply is stored in the same second as the newest message both saw', async () => {
  // WhatsApp takes three seconds to answer, as in the reproduction.
  const h = harness({ reply: () => { h.tick(3_000); return { status: 201, body: { key: { id: 'KEY-1' } } }; } });
  const sara = staffOf(h);
  const omar = h.team.addUser({ name: 'Omar', phone: '966500000088' });
  seedChat(h);
  // The newest message, stamped T on a whole second as WhatsApp stamps them.
  const T = NOW;
  h.inbox.upsertMessage({ key_id: 'IN-T', lead_id: 'L-1', jid: CLIENT_JID, direction: 'in', sender_kind: 'client', text: 'still free?', ts: T });
  // Sara and Omar both draw the chat now: revision R, newest message T.
  const R = h.inbox.revision('L-1');
  h.tick(700);
  const first = await h.sender.reply(replyArgs(sara, { seenRev: R }));
  assert.deepEqual(first, { ok: true, status: 'accepted', sendId: SID, keyId: 'KEY-1' });
  assert.equal(h.inbox.messageByKey('KEY-1').ts, T, "stored at the second its send started: T+700 ms floors to T");
  assert.equal(h.inbox.newestTs('L-1'), T, "so no timestamp can tell that Omar's page is out of date");
  const OTHER_SID = 'sid_fedcba9876543210';
  assert.deepEqual(await h.sender.reply(replyArgs(omar, { sendId: OTHER_SID, seenRev: R })), { ok: false, error: 'stale' });
  assert.equal(h.calls.length, 1, 'the client got one answer, not two');
  assert.equal(h.inbox.getOutbox(OTHER_SID), null, 'nothing written for the refused one');
  h.s.close();
});

test('reply: stale when a message is stored after the page was drawn, whatever its timestamp; a page drawn after it sends', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h);
  const drawn = h.inbox.revision('L-1');
  // The poller stores a client message it read late, stamped in the same second as the
  // newest message the page showed.
  h.inbox.upsertMessage({ key_id: 'IN-late', lead_id: 'L-1', jid: CLIENT_JID, direction: 'in', sender_kind: 'client', text: 'and parking?', ts: NOW - 60_000 });
  assert.deepEqual(await h.sender.reply(replyArgs(staff, { seenRev: drawn })), { ok: false, error: 'stale' });
  assert.equal(h.calls.length, 0);
  assert.equal(outboxRows(h).length, 0);
  assert.equal((await h.sender.reply(replyArgs(staff, { seenRev: h.inbox.revision('L-1') }))).ok, true, 'drawn after everything, it goes');
  assert.equal(h.calls.length, 1);
  h.s.close();
});

test('reply: stale when another member\'s send that may have gone was written after the page was drawn', async () => {
  const h = harness({ reply: (n) => (n === 1 ? { status: 504 } : { status: 201, body: { key: { id: 'KEY-2' } } }) });
  const sara = staffOf(h);
  const omar = h.team.addUser({ name: 'Omar', phone: '966500000088' });
  seedChat(h);
  const drawn = h.inbox.revision('L-1');
  assert.equal((await h.sender.reply(replyArgs(sara, { seenRev: drawn }))).uncertain, true);
  // Nothing new in the stored thread: only the outbox row that says "not sure it went".
  assert.equal(h.inbox.newestTs('L-1'), NOW - 60_000);
  const OTHER_SID = 'sid_fedcba9876543210';
  assert.deepEqual(await h.sender.reply(replyArgs(omar, { sendId: OTHER_SID, seenRev: drawn })), { ok: false, error: 'stale' });
  assert.equal(h.inbox.getOutbox(OTHER_SID), null, 'nothing written for the refused one');
  assert.equal(h.calls.length, 1);
  // A page drawn after it shows that bubble; from there the reply goes.
  assert.equal((await h.sender.reply(replyArgs(omar, { sendId: OTHER_SID, seenRev: h.inbox.revision('L-1') }))).ok, true);
  assert.equal(h.calls.length, 2);
  h.s.close();
});

test('reply: inactive_user for a member who has left the team, an unknown id or none — nothing written, nothing sent', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h);
  h.team.deactivateUser(staff.user_id);
  assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: false, error: 'inactive_user' });
  for (const userId of ['USR-nobody', null, undefined]) {
    assert.deepEqual(await h.sender.reply(replyArgs(staff, { userId })), { ok: false, error: 'inactive_user' }, String(userId));
  }
  assert.equal(h.calls.length, 0);
  assert.equal(outboxRows(h).length, 0, 'no row: nothing is pending, nothing counts against the day');
  const lead = h.s.getLead('L-1');
  assert.equal(lead.handler_user_id, null);
  assert.equal(lead.first_reply_ts, null);

  h.team.reactivateUser(staff.user_id);
  assert.equal((await h.sender.reply(replyArgs(staff))).ok, true, 'back on the team, the same form goes');
  h.s.close();
});

test('reply: the member is read again right before the outbox row, after the stale checks', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h);
  // The last thing read before the row is written: deactivated at that moment, nothing goes.
  const realRevision = h.inbox.revision;
  const inbox = { ...h.inbox, revision: (id) => { h.team.deactivateUser(staff.user_id); return realRevision(id); } };
  const sender = createSender({ env: ENV, team: h.team, inbox, db: h.s, fetchImpl: async () => { throw new Error('must not be called'); }, now: h.now });
  assert.deepEqual(await sender.reply(replyArgs(staff)), { ok: false, error: 'inactive_user' });
  assert.equal(outboxRows(h).length, 0);
  h.s.close();
});

test('reply: with the sending switch off nothing is sent and the row is closed as failed', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h);
  h.team.setSetting('sending_enabled', '0');
  assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: false, error: 'sending_disabled', status: 'failed', sendId: SID });
  assert.equal(h.calls.length, 0);
  const row = h.inbox.getOutbox(SID);
  assert.equal(row.status, 'failed');
  assert.equal(row.error, 'sending_disabled');
  const lead = h.s.getLead('L-1');
  assert.equal(lead.handler_user_id, null);
  assert.equal(lead.first_reply_ts, null);
  h.s.close();
});

test('reply: replies_off until the owner turns dashboard replies on — nothing written, nothing sent, codes still go', async () => {
  const h = harness({ replies: false, reply: (n) => ({ status: 201, body: { key: { id: `KEY-${n}` } } }) });
  const staff = staffOf(h);
  seedChat(h);
  assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: false, error: 'replies_off' });
  assert.equal(h.calls.length, 0);
  assert.equal(outboxRows(h).length, 0, 'no row, so the same send id still works once replies are on');
  const lead = h.s.getLead('L-1');
  assert.equal(lead.handler_user_id, null);
  assert.equal(lead.first_reply_ts, null);

  // A login code is not a reply: the team can still sign in while replies are off.
  const code = await h.sender.sendTo({ jid: '966500000077@s.whatsapp.net', text: 'Bona dashboard code: 123456 (valid 10 min)', kind: 'code' });
  assert.equal(code.ok, true);
  assert.equal(h.calls.length, 1);

  h.team.setSetting('inbox_replies', '1');
  assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: true, status: 'accepted', sendId: SID, keyId: 'KEY-2' });

  // Off again: the reply that went keeps its answer; a new one is refused before anything is written.
  h.team.setSetting('inbox_replies', '0');
  assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: true, duplicate: true, status: 'accepted', sendId: SID, error: null });
  assert.deepEqual(await h.sender.reply(replyArgs(staff, { sendId: 'sid_fedcba9876543210' })), { ok: false, error: 'replies_off' });
  assert.equal(h.inbox.getOutbox('sid_fedcba9876543210'), null);
  assert.equal(h.calls.length, 2);
  h.s.close();
});

test('reply: its own pending row is not counted twice against the day', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h);
  seedOutbox(h, SEND_PER_DAY - 1);
  assert.equal((await h.sender.reply(replyArgs(staff))).ok, true, '499 before it: this one is the 500th');

  const full = harness();
  const staff2 = staffOf(full);
  seedChat(full);
  seedOutbox(full, SEND_PER_DAY);
  assert.deepEqual(await full.sender.reply(replyArgs(staff2)), { ok: false, error: 'rate_limited', status: 'failed', sendId: SID });
  assert.equal(full.inbox.getOutbox(SID).status, 'failed');
  assert.equal(full.calls.length, 0);
  h.s.close();
  full.s.close();
});

test('reply: once sent, a failure to record it still answers ok (saying otherwise would invite a second send)', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h);
  const brittle = { ...h.inbox, upsertMessage: () => { throw Object.assign(new Error('disk full'), { code: 'ERR_SQLITE_ERROR' }); } };
  const logs = [];
  const sender = createSender({
    env: ENV, team: h.team, inbox: brittle, db: h.s, now: h.now, log: (o) => logs.push(o),
    fetchImpl: async () => ({ ok: true, status: 201, text: async () => JSON.stringify({ key: { id: 'KEY-7' } }) }),
  });
  assert.deepEqual(await sender.reply(replyArgs(staff)), { ok: true, status: 'accepted', sendId: SID, keyId: 'KEY-7' });
  assert.equal(h.inbox.getOutbox(SID).status, 'accepted', 'the ledger already says it went');
  assert.ok(logs.some((l) => l.evt === 'wa.reply.record_failed'));
  assert.ok(!JSON.stringify(logs).includes('hello'), 'never logs the text');
  h.s.close();
});

test('reply: a chat marked "Not a client" while the message was on its way stays purged', async () => {
  let answer;
  const h = harness({ reply: () => new Promise((resolve) => { answer = resolve; }) });
  const staff = staffOf(h);
  seedChat(h);
  const sending = h.sender.reply(replyArgs(staff));
  assert.equal(h.calls.length, 1, 'the call is in flight and WhatsApp has not answered yet');
  // Meanwhile the owner presses *Not a client* (a never-list add does the same).
  h.inbox.leaveInbox('L-1');
  answer({ status: 201, body: { key: { id: 'KEY-1' } } });
  assert.deepEqual(await sending, { ok: true, status: 'accepted', sendId: SID, keyId: 'KEY-1' }, 'it did go: saying otherwise would invite a second send');
  assert.equal(h.inbox.hasMessages('L-1'), false, 'no transcript is started again for a purged chat');
  const lead = h.s.getLead('L-1');
  assert.equal(lead.inbox_state, 'out');
  assert.equal(lead.last_msg_ts, null);
  assert.equal(lead.handler_user_id, null, 'nobody is made handler of a chat that left the inbox');
  assert.equal(lead.needs_human, 0);
  assert.equal(lead.first_reply_ts, NOW, 'the client was still answered, and the watchdog must know');
  assert.equal(h.inbox.countSentSince(NOW - DAY), 1, 'it still counts against the day');
  // A second submit of the same form is refused, never sent again: the purge left the
  // row as a stub that belongs to no chat.
  assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: false, error: 'bad_send_id' });
  assert.equal(h.calls.length, 1);
  h.s.close();
});

test('reply: the poller seeing the message go while the call is out wins over a failure that comes back later', async () => {
  for (const [name, failure] of [['timeout', { throws: abortError() }], ['500', { status: 500 }]]) {
    let answer;
    const h = harness({ reply: () => new Promise((resolve) => { answer = resolve; }) });
    const staff = staffOf(h);
    seedChat(h);
    const { ingest } = createIngest({ db: h.s, inbox: h.inbox, now: h.now });
    const sending = h.sender.reply(replyArgs(staff));
    // Meanwhile the poller reads WhatsApp's own copy and matches it to the pending row by its text.
    const seen = ingest(h.s.getLead('L-1'), {
      id: 'KEY-SEEN', jid: CLIENT_JID, jidAlt: null, fromMe: true, ts: NOW, text: 'hello', pushName: null,
      contextInfo: null, messageType: 'conversation', media: null, fileName: null, noise: false,
    });
    assert.deepEqual(seen, { stored: true, inserted: true, senderKind: 'staff' }, name);
    assert.equal(h.inbox.getOutbox(SID).status, 'accepted', `${name}: the poller has proof it went`);
    answer(failure);
    assert.deepEqual(await sending, { ok: true, status: 'accepted', sendId: SID, keyId: 'KEY-SEEN' }, `${name}: never "failed" for a message the thread shows`);
    const row = h.inbox.getOutbox(SID);
    assert.deepEqual({ status: row.status, key_id: row.key_id, error: row.error }, { status: 'accepted', key_id: 'KEY-SEEN', error: null }, name);
    assert.equal(h.inbox.countSentSince(NOW - DAY), 1, `${name}: still counted against the day`);
    assert.equal(h.inbox.messagesFor('L-1').filter((m) => m.direction === 'out').length, 1, `${name}: stored once`);
    assert.equal(h.s.getLead('L-1').first_reply_ts, NOW, name);
    assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: true, duplicate: true, status: 'accepted', sendId: SID, error: null }, name);
    assert.equal(h.calls.length, 1, name);
    assert.ok(h.logs.some((l) => l.evt === 'wa.send.seen_sent'), `${name}: logged`);
    h.s.close();
  }
});

test('reply: a ledger write that fails after a keyed 2xx still answers ok, and a second submit is not sent', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h);
  const brittle = { ...h.inbox, updateOutbox: () => { throw Object.assign(new Error('disk full'), { code: 'ERR_SQLITE_ERROR' }); } };
  let calls = 0;
  const sender = createSender({
    env: ENV, team: h.team, inbox: brittle, db: h.s, now: h.now,
    fetchImpl: async () => { calls += 1; return { ok: true, status: 201, text: async () => JSON.stringify({ key: { id: 'KEY-7' } }) }; },
  });
  assert.deepEqual(await sender.reply(replyArgs(staff)), { ok: true, status: 'accepted', sendId: SID, keyId: 'KEY-7' });
  assert.equal(h.inbox.messagesFor('L-1').at(-1).key_id, 'KEY-7', "stored as the member's message all the same");
  assert.deepEqual(
    await sender.reply(replyArgs(staff)),
    { ok: false, duplicate: true, status: 'pending', sendId: SID, error: 'pending', uncertain: true },
    'the row it could not update still stops the same form going twice',
  );
  assert.equal(calls, 1);
  h.s.close();
});

test('reply: stale while another reply to the chat is on its way; a send stuck pending past two minutes no longer holds it', async () => {
  let answer;
  const h = harness({ reply: (n) => (n === 1 ? new Promise((resolve) => { answer = resolve; }) : { status: 201, body: { key: { id: 'KEY-2' } } }) });
  const staff = staffOf(h);
  const other = h.team.addUser({ name: 'Omar', phone: '966500000088' });
  seedChat(h);
  const first = h.sender.reply(replyArgs(staff));
  // Omar saw the same newest message and answers at the same moment, from his own form.
  const OTHER_SID = 'sid_fedcba9876543210';
  assert.deepEqual(await h.sender.reply(replyArgs(other, { sendId: OTHER_SID })), { ok: false, error: 'stale' });
  assert.equal(h.inbox.getOutbox(OTHER_SID), null, 'nothing written for the refused one');
  answer({ status: 201, body: { key: { id: 'KEY-1' } } });
  assert.equal((await first).ok, true);
  assert.equal(h.calls.length, 1, 'the client got one answer, not two');
  h.s.close();

  // A row a crash left pending: still possibly in flight at two minutes exactly, not a moment later.
  const k = harness();
  const member = staffOf(k);
  seedChat(k);
  k.inbox.insertOutbox({ send_id: 'SND-stuck', lead_id: 'L-1', jid: CLIENT_JID, text: 'x', user_id: member.user_id, sender_kind: 'staff' });
  // A page drawn with the stuck row on it: only the row's age decides.
  const drawn = k.inbox.revision('L-1');
  k.tick(120_000);
  assert.deepEqual(await k.sender.reply(replyArgs(member, { seenRev: drawn })), { ok: false, error: 'stale' }, 'two minutes exactly');
  k.tick(1);
  assert.equal((await k.sender.reply(replyArgs(member, { seenRev: drawn }))).ok, true, 'past that it was cut off, not on its way');
  k.s.close();
});

test('reply: a chat purged and moved back in never sends an old form again, and its sends still count against the day', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h);
  assert.equal((await h.sender.reply(replyArgs(staff))).ok, true);
  h.inbox.leaveInbox('L-1');
  assert.equal(h.inbox.countSentSince(NOW - DAY), 1, 'the reply went, so it still counts');
  // The owner moves it back in, and the history has not come back (Evolution down, say),
  // so the stale check has nothing newer to see: the purge took the chat's revision to 0.
  h.inbox.setInboxState('L-1', 'in');
  assert.equal(h.inbox.revision('L-1'), 0);
  assert.deepEqual(await h.sender.reply(replyArgs(staff)), { ok: false, error: 'bad_send_id' });
  assert.equal(h.calls.length, 1);
  h.s.close();
});

test('reply: never logs the text or the number', async () => {
  const h = harness({ reply: () => ({ status: 500 }) });
  const staff = staffOf(h);
  seedChat(h);
  await h.sender.reply(replyArgs(staff, { text: 'secret-reply-marker' }));
  const logged = JSON.stringify(h.logs);
  assert.ok(!logged.includes('secret-reply-marker'));
  assert.ok(!logged.includes(CLIENT));
  h.s.close();
});

/* ------------------------------ after a restart ------------------------------ */

test('recoverInterrupted: at start-up EVERY pending send becomes uncertain, however young; nothing else changes', async () => {
  const h = harness();
  seedOutbox(h, 1, { created: NOW - 3_600_000, status: 'accepted' });
  seedOutbox(h, 1, { created: NOW - 3_600_000, status: 'failed' });
  seedOutbox(h, 1, { created: NOW - 121_000, status: 'pending' });
  seedOutbox(h, 1, { created: NOW - 60_000, status: 'pending' });
  // A few seconds old: the process that wrote it died mid-send, and a process that has just
  // started has no send of its own in flight — so it cannot still be on its way.
  seedOutbox(h, 1, { created: NOW - 3_000, status: 'pending' });
  seedOutbox(h, 1, { created: NOW, status: 'pending' });
  // A row stamped ahead of this clock (another process's clock ran fast) is no different.
  seedOutbox(h, 1, { created: NOW + 5_000, status: 'pending' });
  assert.equal(h.sender.recoverInterrupted(), 5);
  assert.deepEqual(outboxRows(h).map((r) => [r.status, r.error]), [
    ['accepted', null], ['failed', null],
    ['uncertain', 'interrupted'], ['uncertain', 'interrupted'], ['uncertain', 'interrupted'], ['uncertain', 'interrupted'], ['uncertain', 'interrupted'],
  ]);
  assert.equal(h.sender.recoverInterrupted(), 0, 'once');
  h.s.close();
});

test('recoverInterrupted: a reply the last process left pending seconds ago no longer holds the chat as stale', async () => {
  const h = harness();
  const staff = staffOf(h);
  seedChat(h);
  h.inbox.insertOutbox({ send_id: 'SND-cut-off', lead_id: 'L-1', jid: CLIENT_JID, text: 'x', user_id: staff.user_id, sender_kind: 'staff' });
  h.tick(5_000);
  assert.equal(h.sender.recoverInterrupted(), 1);
  assert.equal(h.inbox.getOutbox('SND-cut-off').status, 'uncertain');
  const drawn = h.inbox.revision('L-1');
  assert.equal((await h.sender.reply(replyArgs(staff, { seenRev: drawn }))).ok, true, 'shown as "not sure it went", not as a send on its way');
  h.s.close();
});
