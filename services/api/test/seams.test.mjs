/**
 * PR-F2b (PLAN T05; DESIGN §2, §7.1, §8.4; DESIGN-brain §3.2): the module seams the later PRs
 * fill. Every stub keeps today's behaviour, and createApp builds each one, injects it where its
 * real version will be read, and lets a test hand in its own. Nothing leaves the process: every
 * fetch is a fake and no test listens on a public address.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../index.mjs';
import { openDb } from '../lib/db.mjs';
import { createInventory, WORKTREE_LISTINGS } from '../lib/inventory.mjs';
import { DEFAULT_ORIGINS } from '../lib/cors.mjs';
import { leadNote } from '../lib/leads.mjs';
import { BATCH_MS, PER_DAY, PER_CHAT_PER_HOUR, MAX_LINKS } from '../lib/dana-wa.mjs';
import { SEND_PER_MIN, SEND_PER_DAY } from '../lib/wa-send.mjs';
import { createOwnerTest } from '../lib/owner-test.mjs';
import { createOwnerNotes, FORM_NOTIFY_WAIT_MS } from '../lib/owner-notes.mjs';
import { createViewing } from '../lib/viewing.mjs';
import { createWaLink } from '../lib/wa-link.mjs';
import { createPacing } from '../lib/pacing.mjs';
import { createPushPolicy } from '../lib/push-policy.mjs';
import { createDanaCommit } from '../lib/dana-commit.mjs';
import { createMail } from '../lib/mail/index.mjs';
import { createBrain } from '../lib/brain.mjs';

const NOW = 1_790_500_000_000;
const DAY = 86_400_000;
const SITE = 'https://bona.azoz.uk';
/** A test owner (BONA_OWNER_JID): the note goes to him, never to the code's default owner. */
const OWNER_DIGITS = '966500000009';
const ENV = { EVOLUTION_API_URL: 'http://evo.test/', EVOLUTION_API_KEY: 'k', BONA_WA_INSTANCE: 'abdulaziz-personal', BONA_OWNER_JID: `${OWNER_DIGITS}@s.whatsapp.net` };
const inventory = createInventory({ file: WORKTREE_LISTINGS, siteUrl: SITE });

/* ---------------- each stub keeps today's behaviour ---------------- */

test('owner-test stub: no test, no own rule, no auto mode, no command', () => {
  const t = createOwnerTest();
  assert.equal(t.active(), false);
  assert.equal(t.ownNumberOk(), false);
  assert.equal(t.autoMode({ lead_id: 'L-1', inbox_via: 'owner_test' }), false);
  assert.equal(t.autoMode(null), false);
  assert.equal(t.ownRuleFor({ jid: '966500000001@s.whatsapp.net' }), false);
  assert.equal(t.ownerLid(), null);
  assert.equal(t.command({ id: 'R-1', text: '#dana test on', fromMe: false }), false);
  assert.equal(t.onSettingChanged('owner_as_client', '1'), undefined);
  assert.deepEqual(t.health(), { rule: 'shared', ownerAsClient: false });
});

test('wa-link stub: identity fails closed, the link is taken as up, start/stop arm nothing', () => {
  const l = createWaLink();
  assert.equal(l.identityOk(), false);
  assert.equal(l.linkOk(), true);
  assert.equal(l.start(), undefined);
  assert.equal(l.stop(), undefined);
  assert.deepEqual(l.health(), { linkOk: true, identityOk: false });
});

test('viewing stub: nothing is bookable or booked; every hook is a no-op', async () => {
  const v = createViewing();
  assert.equal(v.configured, false);
  assert.deepEqual(await v.slots({ leadId: 'L-1' }), { bookable: false });
  assert.deepEqual(v.validate({ leadId: 'L-1' }), { ok: false, reason: 'off' });
  assert.deepEqual(await v.commitBooking({ leadId: 'L-1' }), { ok: false, reason: 'off' });
  assert.equal(v.cancelForLead('L-1'), 0);
  for (const fn of ['onTaskChange', 'onLeadLeaving', 'onPurge', 'tick']) assert.equal(v[fn]('L-1'), undefined, fn);
  assert.deepEqual(v.health(), { enabled: false, gcal: { configured: false, ok: false, lastErrorCode: null } });
});

test("pacing stub: today's 2 s batch, no typing floor, no queue, today's caps at any date", async () => {
  const p = createPacing();
  assert.equal(p.batchMs(), BATCH_MS);
  assert.equal(p.typingFloorMs({ chars: 400, newestTs: NOW }), 0);
  assert.equal(p.fifo(() => 'sent'), 'sent');
  assert.equal(await p.fifo(async () => 'sent later'), 'sent later');
  const today = { PER_DAY, PER_CHAT_PER_HOUR, MAX_LINKS, SEND_PER_MIN, SEND_PER_DAY };
  assert.deepEqual(p.tier(NOW), today);
  assert.deepEqual(p.tier(NOW + 30 * DAY), today, 'no warm-up tiers yet');
  p.tier(NOW).PER_DAY = 1;
  assert.equal(p.tier(NOW).PER_DAY, PER_DAY, 'a caller cannot change the caps for the next one');
});

test("push-policy stub: today's poller hook, the phone alert first and then Dana's wake", () => {
  const seen = [];
  const policy = createPushPolicy({
    alerts: { notify: (...a) => seen.push(['notify', ...a]) },
    dana: { wake: (...a) => seen.push(['wake', ...a]) },
  });
  assert.equal(policy.onClientMessage('L-1', NOW), undefined);
  assert.deepEqual(seen, [['notify', 'L-1', { ts: NOW }], ['wake', 'L-1', NOW]]);
  assert.throws(() => createPushPolicy({ dana: { wake() {} } }), TypeError);
});

test('dana-commit stub: an answer is its text, one text bubble', async () => {
  const c = createDanaCommit();
  assert.deepEqual(await c.afterPreSend({ lead: { lead_id: 'L-1' }, turn: { messages: [] }, text: 'Hello', language: 'en', coversTs: NOW }),
    { bubbles: [{ kind: 'text', text: 'Hello' }] });
});

test('mail stub: not configured, nothing started', () => {
  const m = createMail();
  assert.equal(m.start(), undefined);
  assert.equal(m.stop(), undefined);
  assert.deepEqual(m.health(), { configured: false, ok: false, lastErrorCode: null, replies: false });
});

test("brain stub (DESIGN-brain §3.2): not configured; a turn is 'off', never a network call", async () => {
  let fetched = 0;
  const b = createBrain({ fetchImpl: async () => { fetched += 1; }, runTool: async () => { throw new Error('no tool may run'); } });
  assert.equal(b.configured, false);
  assert.deepEqual(await b.turn({ route: 'wa', leadId: 'L-1', language: 'en', history: [], batchText: 'hi' }), { ok: false, code: 'off' });
  assert.deepEqual(await b.classify({ text: 'hi' }), { error: 'off' });
  assert.deepEqual(b.health(), { configured: false, ok: false, backup: false });
  assert.deepEqual(b.ops(), {});
  assert.equal(fetched, 0);
});

test('owner-notes (PR-B2 replaced the stub; test/owner-notes.test.mjs covers the ledger): built bare it has no ledger, sends nothing and has nothing stuck', async () => {
  const sent = [];
  const n = createOwnerNotes({ siteUrl: SITE, sendNote: async (t) => { sent.push(t); return { ok: true }; } });
  assert.equal(await n.leadEvent({ lead_id: 'L-1' }, { why: 'form', created: true }), undefined);
  for (const [fn, args] of [['handover', [{ lead_id: 'L-1' }, { kind: 'person' }]], ['booking', ['B-1', { told: true }]],
    ['stopped', [{ lead_id: 'L-1' }, 'stop']], ['alert', ['breaker', {}]], ['mail', [{ messageId: 'M-1' }]], ['command', ['R-1', '#dana status']]]) {
    assert.deepEqual(n[fn](...args), { queued: false, reason: 'no_ledger' }, fn);
  }
  assert.equal(n.onPurge('L-1'), undefined);
  await n.tick();
  assert.equal(sent.length, 0);
  assert.deepEqual(n.health(), { enabled: true, ok: true });
  assert.equal(FORM_NOTIFY_WAIT_MS, 4000, "today's wait for the form's note");
});

/* ---------------- createApp builds and injects every seam ---------------- */

function build({ env = {}, config = {}, ...options } = {}) {
  const db = options.db ?? openDb(':memory:');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-seams-'));
  const logs = [];
  const app = createApp({
    config: {
      port: 0, host: '127.0.0.1', siteUrl: SITE, publicApi: 'https://bona-api.azoz.uk',
      dataDir, inventoryFile: WORKTREE_LISTINGS, origins: DEFAULT_ORIGINS, toolToken: 'a'.repeat(32),
      retellApiKey: 'test', retellMock: true, chatAgentId: 'agent_chat', voiceAgentId: 'agent_voice',
      maxBodyBytes: 16 * 1024, chatRatePerMin: 30, tokenRatePerMin: 6, toolRatePerMin: 600, toolAuthFailRatePerMin: 10,
      allowQueryToken: false, maxChatsPerDay: 300, maxCallsPerDay: 60, maxTurnsPerSession: 40, dashCookieDays: 30,
      env, ids: {}, version: '1.0.0', trustedProxies: [],
      ...config,
    },
    inventory, probeRetell: async () => 'ok', log: (e) => logs.push(e), now: () => NOW,
    danaOnMock: true, danaBatchMs: 0,
    ...options,
    db,
  });
  return {
    app, db, logs,
    listen: () => new Promise((resolve) => app.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${app.server.address().port}`))),
    close: async () => {
      if (app.server.listening) await new Promise((resolve) => app.server.close(resolve));
      await app.dana.stop();
      await app.dashboard.auth.flush();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

const enquiry = (base, over = {}) => fetch(`${base}/v1/enquiry`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: SITE },
  body: JSON.stringify({ form: 'contact', name: 'Sara Example', phone: '0500000000', message: 'Interested in a villa', event_id: 'seams-form-0000001', ...over }),
});

/**
 * The form's owner note since PR-B2 (DESIGN §7.2): today's leadNote() lines byte for byte, then the
 * Lead link (index.mjs hands the notes no publicApi yet, so it is the config default's host).
 */
const formNote = (h, leadId) => `${leadNote(h.db.getLead(leadId), { siteUrl: SITE })}\nLead: https://api.bona-real-estate.com/dashboard/leads/${leadId}`;

test('createApp builds every seam module and exposes it; a module handed in is the one it uses', async () => {
  const mine = {
    ownerTest: createOwnerTest(), notes: createOwnerNotes(), viewing: createViewing(), waLink: createWaLink(), pacing: createPacing(),
    danaCommit: createDanaCommit(), mail: createMail(), brain: createBrain(),
  };
  const built = build({ sendWhatsApp: async () => ({ ok: true }) });
  const given = build({ sendWhatsApp: async () => ({ ok: true }), ...mine });
  try {
    for (const name of ['ownerTest', 'notes', 'viewing', 'waLink', 'pacing', 'pushPolicy', 'danaCommit', 'mail', 'brain']) {
      assert.ok(built.app[name] && typeof built.app[name] === 'object', `${name} is built`);
    }
    for (const [name, mod] of Object.entries(mine)) assert.equal(given.app[name], mod, `${name}: the one handed in`);
    assert.equal(built.app.brain.configured, false, 'no brain until PR-BR');
    assert.equal(built.app.viewing.configured, false);
  } finally {
    await built.close();
    await given.close();
  }
});

test("the form's owner note goes through notes.leadEvent (why 'form', created, the event id), then the Telegram hand-off as before", async () => {
  const calls = [];
  const notes = { ...createOwnerNotes(), leadEvent: async (lead, o) => { calls.push({ leadId: lead.lead_id, ...o }); } };
  const h = build({ sendWhatsApp: async () => { throw new Error('the form must not send its own note'); }, notes });
  try {
    const base = await h.listen();
    const res = await enquiry(base);
    assert.equal(res.status, 200);
    const { lead_id: leadId } = await res.json();
    assert.deepEqual(calls, [{ leadId, why: 'form', created: true, eventId: 'seams-form-0000001' }]);
    const again = await enquiry(base, { event_id: 'seams-form-0000002' });
    assert.equal(again.status, 200);
    assert.deepEqual(calls.at(-1), { leadId, why: 'form', created: false, eventId: 'seams-form-0000002' }, 'a merge is handed over too; the stub decides');
  } finally {
    await h.close();
  }
});

test("with a sendWhatsApp handed to createApp (the test seam), the form's note goes through it (today's lines + the Lead link), and the receipt says sent", async () => {
  const sent = [];
  const h = build({ sendWhatsApp: async (t) => { sent.push(t); return { ok: true }; } });
  try {
    const base = await h.listen();
    const { lead_id: leadId } = await (await enquiry(base)).json();
    assert.deepEqual(sent, [formNote(h, leadId)]);
    assert.equal(h.db.db.prepare('SELECT notify_status FROM enquiry_receipts').get().notify_status, 'sent');
  } finally {
    await h.close();
  }
});

/**
 * Today's transport for the owner's note (index.mjs at 13e4954): lib/wa.mjs `sendText` over the
 * GLOBAL fetch, to BONA_OWNER_JID. It answers ok on any 2xx, key or no key. Here the global fetch
 * is a fake Evolution for evo.test, the loopback passes through (the test's own requests), and
 * anything else throws, so nothing leaves the process. The fetch handed to createApp is the one
 * sender's: the form's note must never reach it.
 */
async function withTodaysTransport(fn) {
  const real = globalThis.fetch;
  const posts = [];
  const sender = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1:')) return real(url, init);
    if (!u.startsWith('http://evo.test/')) throw new Error(`no network in this test: ${u}`);
    posts.push({ url: u, apikey: init.headers?.apikey, body: JSON.parse(init.body) });
    return { ok: true, status: 201, text: async () => '{}' };
  };
  const senderFetch = async (url, init) => {
    sender.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 201, text: async () => JSON.stringify({ key: { id: `KEY-${sender.length}` } }) };
  };
  try {
    return await fn({
      senderFetch,
      sends: () => posts.filter((p) => p.url === 'http://evo.test/message/sendText/abdulaziz-personal').map((p) => p.body),
      posts: () => posts,
      senderCalls: () => sender,
    });
  } finally {
    globalThis.fetch = real;
  }
}
const receiptOf = (h, eventId) => h.db.db.prepare('SELECT notify_status FROM enquiry_receipts WHERE event_id=?').get(eventId).notify_status;
const outboxRows = (h) => h.db.db.prepare('SELECT COUNT(*) AS n FROM wa_outbox').get().n;

test("without one, the form's note goes today's way (lib/wa.mjs sendText to BONA_OWNER_JID, as at 13e4954): no outbox row, the one sender never asked, sent", async () => {
  await withTodaysTransport(async (evo) => {
    const h = build({ env: ENV, fetchImpl: evo.senderFetch });
    try {
      const base = await h.listen();
      const { lead_id: leadId } = await (await enquiry(base)).json();
      assert.deepEqual(evo.posts().map((p) => [p.url, p.apikey]), [['http://evo.test/message/sendText/abdulaziz-personal', 'k']]);
      assert.deepEqual(evo.sends(), [{ number: OWNER_DIGITS, text: formNote(h, leadId) }]);
      assert.deepEqual(evo.senderCalls(), [], 'not through the one sender (PR-INT moves the note onto kind note)');
      assert.equal(outboxRows(h), 0);
      assert.equal(receiptOf(h, 'seams-form-0000001'), 'sent', "today's rule: a 2xx is sent, with or without a message id");
    } finally {
      await h.close();
    }
  });
});

test("with BONA_WA_NOTIFY=0 the form's note is today's 'disabled': nothing posted, the receipt says uncertain", async () => {
  await withTodaysTransport(async (evo) => {
    const logs = [];
    const h = build({ env: { ...ENV, BONA_WA_NOTIFY: '0' }, fetchImpl: evo.senderFetch, log: (e) => logs.push(e) });
    try {
      const base = await h.listen();
      const { lead_id: leadId } = await (await enquiry(base)).json();
      assert.deepEqual(evo.posts(), []);
      assert.deepEqual(evo.senderCalls(), []);
      assert.equal(receiptOf(h, 'seams-form-0000001'), 'uncertain');
      assert.deepEqual(logs.find((e) => e.evt === 'lead.wa_failed'), { evt: 'lead.wa_failed', id: leadId, error: 'disabled' });
    } finally {
      await h.close();
    }
  });
});

test("the Sending switch never governed the form's note (13e4954) and still does not on today's transport: with Sending off it goes, sent", async () => {
  // The ledger holds a note the transport refuses for Sending off (`pending`; test/owner-notes.test.mjs);
  // today's transport (lib/wa.mjs) never refuses for it. PR-INT (T14) moves the note onto the one
  // sender's kind 'note', which does.
  await withTodaysTransport(async (evo) => {
    const h = build({ env: ENV, fetchImpl: evo.senderFetch });
    try {
      const base = await h.listen();
      h.app.team.setSetting('sending_enabled', '0');
      const { lead_id: leadId } = await (await enquiry(base)).json();
      assert.deepEqual(evo.sends(), [{ number: OWNER_DIGITS, text: formNote(h, leadId) }]);
      assert.deepEqual(evo.senderCalls(), []);
      assert.equal(outboxRows(h), 0);
      assert.equal(receiptOf(h, 'seams-form-0000001'), 'sent');
    } finally {
      await h.close();
    }
  });
});

test("the form's note is not on the one sender's note minute: 6 notes used up there do not touch it", async () => {
  await withTodaysTransport(async (evo) => {
    const h = build({ env: ENV, fetchImpl: evo.senderFetch });
    try {
      const base = await h.listen();
      const owner = `${OWNER_DIGITS}@s.whatsapp.net`;
      for (let i = 0; i < 6; i += 1) assert.equal((await h.app.sender.sendTo({ jid: owner, text: `note ${i}`, kind: 'note' })).ok, true, `note ${i}`);
      assert.deepEqual(await h.app.sender.sendTo({ jid: owner, text: 'note 7', kind: 'note' }), { ok: false, error: 'rate_limited' });
      const { lead_id: leadId } = await (await enquiry(base)).json();
      assert.deepEqual(evo.sends(), [{ number: OWNER_DIGITS, text: formNote(h, leadId) }], "the form's note, today's way");
      assert.equal(evo.senderCalls().length, 6, 'only the six notes sent through the one sender');
      assert.equal(outboxRows(h), 6);
      assert.equal(receiptOf(h, 'seams-form-0000001'), 'sent');
    } finally {
      await h.close();
    }
  });
});

test("a merge (the number enquired before) sends the owner no note, and its receipt says skipped (DESIGN §7.2, critic C11)", async () => {
  await withTodaysTransport(async (evo) => {
    const h = build({ env: ENV, fetchImpl: evo.senderFetch });
    try {
      const base = await h.listen();
      h.db.insertLead({
        lead_id: 'LEAD-20261127-0000dddd', created: NOW - DAY, updated: NOW - DAY, phone_e164: '966500000000', channel: 'form', stage: 'new',
      });
      const res = await enquiry(base);
      assert.equal(res.status, 200);
      const { lead_id: leadId } = await res.json();
      assert.equal(leadId, 'LEAD-20261127-0000dddd', 'a merge');
      assert.deepEqual(evo.posts(), [], 'no note');
      assert.equal(outboxRows(h), 0);
      assert.equal(receiptOf(h, 'seams-form-0000001'), 'skipped');
    } finally {
      await h.close();
    }
  });
});

test('a sendWhatsApp handed to createApp (the test seam) is the only transport: a refusal for now is asked once and held (pending), never sent another way', async () => {
  const sent = [];
  const h = build({ env: ENV, sendWhatsApp: async (t) => { sent.push(t); return { ok: false, error: 'rate_limited' }; } });
  try {
    const base = await h.listen();
    await (await enquiry(base)).json();
    assert.equal(sent.length, 1);
    assert.equal(receiptOf(h, 'seams-form-0000001'), 'pending', 'held by the ledger (PR-B2), sent when the transport takes it');
  } finally {
    await h.close();
  }
});

test('a chat purged from the inbox reaches viewing and owner-notes through the onPurge fan-out, once each, inside the purge', async () => {
  const seen = [];
  let db = null;
  const spy = (who) => (leadId) => seen.push({ who, leadId, inTx: db.db.isTransaction });
  db = openDb(':memory:');
  const h = build({
    db, sendWhatsApp: async () => ({ ok: true }),
    viewing: { ...createViewing(), onPurge: spy('viewing') },
    notes: { ...createOwnerNotes(), onPurge: spy('notes') },
  });
  try {
    db.insertLead({
      lead_id: 'LEAD-P', created: NOW - DAY, updated: NOW - DAY, phone_e164: '966500000077', wa_jid: '966500000077@s.whatsapp.net',
      channel: 'whatsapp', match_method: 'ref', stage: 'new', inbox_state: 'in', inbox_since: NOW - DAY,
    });
    h.app.inboxStore.leaveInbox('LEAD-P');
    assert.deepEqual(seen, [{ who: 'viewing', leadId: 'LEAD-P', inTx: true }, { who: 'notes', leadId: 'LEAD-P', inTx: true }]);
  } finally {
    await h.close();
  }
});

test("a client message the poller stores goes to the push policy's onClientMessage (today's alert + wake live there now)", async () => {
  const LEAD_ID = 'LEAD-20261127-0000cccc';
  const JID = '966500000066@s.whatsapp.net';
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const records = body.where?.messageTimestamp ? [{
      key: { id: 'POLL-S1', fromMe: false, remoteJid: JID }, pushName: null, messageType: 'conversation',
      message: { conversation: 'is it still available?' }, messageTimestamp: Math.floor((NOW - 5_000) / 1000),
    }] : [];
    return { ok: true, status: 200, text: async () => JSON.stringify({ messages: { total: records.length, pages: 1, currentPage: 1, records } }) };
  };
  const seen = [];
  const h = build({ env: ENV, config: { waPoll: true }, fetchImpl, sendWhatsApp: async () => ({ ok: true }), pushPolicy: { onClientMessage: (...a) => seen.push(a) } });
  try {
    h.db.insertLead({
      lead_id: LEAD_ID, created: NOW - DAY, updated: NOW - DAY, phone_e164: '966500000066', wa_jid: JID,
      channel: 'whatsapp', match_method: 'ref', stage: 'new', stage_ts: NOW - DAY, inbox_state: 'in', inbox_since: NOW - DAY,
    });
    assert.equal((await h.app.poller.tick()).stored, 1);
    assert.deepEqual(seen, [[LEAD_ID, Math.floor((NOW - 5_000) / 1000) * 1000]]);
    assert.equal(h.app.dana.status().pending, 0, 'the injected policy decided: no wake behind its back');
  } finally {
    await h.close();
  }
});

test('guard: a WhatsApp lead the poller creates still sends the owner exactly leadNote()\'s text', async () => {
  const SENDER = '966500000055@s.whatsapp.net';
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const records = body.where?.messageTimestamp ? [{
      key: { id: 'POLL-NEW-1', fromMe: false, remoteJid: SENDER }, pushName: 'Sara', messageType: 'conversation',
      message: { conversation: 'Hi, is this still available?\n\nRef BONA-W003 · K7Q2XR' }, messageTimestamp: Math.floor((NOW - 60_000) / 1000),
    }] : [];
    return { ok: true, status: 200, text: async () => JSON.stringify({ messages: { total: records.length, pages: 1, currentPage: 1, records } }) };
  };
  const sent = [];
  const h = build({ env: ENV, config: { waPoll: true }, fetchImpl, sendWhatsApp: async (t) => { sent.push(t); return { ok: true }; } });
  try {
    h.db.upsertSession({ session_id: 'seams-session-1', anon_id: 'b'.repeat(32), ref: 'K7Q2XR', started: NOW - 900_000, last_seen: NOW - 600_000, pages: 2, locale: 'en' });
    const tally = await h.app.poller.tick();
    assert.equal(tally.created, 1);
    const [lead] = h.db.listLeads({ limit: 5 });
    assert.deepEqual(sent, [leadNote(lead, { siteUrl: SITE })]);
  } finally {
    await h.close();
  }
});

test('a module without an onPurge hook has nothing to forget: the purge still runs', async () => {
  const h = build({ sendWhatsApp: async () => ({ ok: true }), viewing: { ...createViewing(), onPurge: undefined }, notes: { ...createOwnerNotes(), onPurge: undefined } });
  try {
    h.db.insertLead({
      lead_id: 'LEAD-Q', created: NOW - DAY, updated: NOW - DAY, phone_e164: '966500000078', wa_jid: '966500000078@s.whatsapp.net',
      channel: 'whatsapp', match_method: 'ref', stage: 'new', inbox_state: 'in', inbox_since: NOW - DAY,
    });
    h.app.inboxStore.leaveInbox('LEAD-Q');
    assert.equal(h.db.getLead('LEAD-Q').inbox_state, 'out');
  } finally {
    await h.close();
  }
});

test('/health reads each module through a filter: one that throws or answers text reads false / null, never a 500 or a leak', async () => {
  const h = build({
    sendWhatsApp: async () => ({ ok: true }),
    brain: { ...createBrain(), health: () => { throw new Error('sk-live-secret'); } },
    viewing: { ...createViewing(), health: () => ({ enabled: 'yes', gcal: { configured: true, ok: 1, lastErrorCode: 'calendar owner@example.com not found' } }) },
    mail: { ...createMail(), health: () => ({ configured: true, ok: true, lastErrorCode: 'timeout', replies: false }) },
    waLink: { ...createWaLink(), health: () => null },
  });
  try {
    const base = await h.listen();
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.dana.brainOk, false);
    assert.deepEqual(body.booking, { enabled: false, gcal: { configured: true, ok: false, lastErrorCode: null } });
    assert.deepEqual(body.mail, { configured: true, ok: true, lastErrorCode: 'timeout', replies: false }, 'a fixed enum code passes');
    assert.deepEqual(body.wa, { linkOk: false });
    assert.doesNotMatch(JSON.stringify(body), /sk-live|example\.com/);
  } finally {
    await h.close();
  }
});

test('/health: a health() that is async reads false / null as well, and one that rejects leaves no unhandled rejection behind', async () => {
  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on('unhandledRejection', onRejection);
  const h = build({
    sendWhatsApp: async () => ({ ok: true }),
    brain: { ...createBrain(), health: async () => { throw new Error('sk-live-secret'); } },
    mail: { ...createMail(), health: () => Promise.resolve({ configured: true, ok: true, lastErrorCode: null, replies: true }) },
  });
  try {
    const base = await h.listen();
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual([body.dana.brainOk, body.dana.brainBackup], [false, false]);
    assert.deepEqual(body.mail, { configured: false, ok: false, lastErrorCode: null, replies: false }, 'a promise is not an answer: health() is synchronous');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(rejections, [], 'the rejection was caught');
    assert.doesNotMatch(JSON.stringify(body), /sk-live/);
  } finally {
    process.off('unhandledRejection', onRejection);
    await h.close();
  }
});
