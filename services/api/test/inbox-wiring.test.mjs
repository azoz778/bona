/**
 * The inbox as createApp wires it (2026-09-27 design §4): one inbox store behind the one
 * sender, the ingest and the backfill; a login code recorded in the outbox without its
 * text; a send the last process left pending given up on at start-up; and the daily
 * upkeep. Nothing leaves the process — the sender's fetch is a fake, and the backfill is
 * a spy where the test needs one. No server is listened on.
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
import { createInboxStore, RETENTION_MS } from '../lib/inbox/store.mjs';
import { JOIN_HISTORY_MS } from '../lib/inbox/backfill.mjs';

const NOW = 1_790_500_000_000;
const DAY = 86_400_000;
const ENV = { EVOLUTION_API_URL: 'http://evo.test/', EVOLUTION_API_KEY: 'k', BONA_WA_INSTANCE: 'abdulaziz-personal' };
const inventory = createInventory({ file: WORKTREE_LISTINGS, siteUrl: 'https://bona.azoz.uk' });

/**
 * createApp on an in-memory store with a pinned clock. `env` decides whether Evolution is
 * "there"; `config` overrides the rest (`waPoll: true` builds the poller).
 */
function build({ env = {}, config = {}, ...options } = {}) {
  const db = options.db ?? openDb(':memory:');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-inbox-wiring-'));
  const logs = [];
  let app;
  try {
    app = createApp({
      config: {
        port: 0, host: '127.0.0.1', siteUrl: 'https://bona.azoz.uk', publicApi: 'https://bona-api.azoz.uk',
        dataDir, inventoryFile: WORKTREE_LISTINGS, origins: DEFAULT_ORIGINS, toolToken: 'a'.repeat(32),
        retellApiKey: 'test', retellMock: true, chatAgentId: 'agent_chat', voiceAgentId: 'agent_voice',
        maxBodyBytes: 16 * 1024, chatRatePerMin: 30, tokenRatePerMin: 6, toolRatePerMin: 600, toolAuthFailRatePerMin: 10,
        allowQueryToken: false, maxChatsPerDay: 300, maxCallsPerDay: 60, maxTurnsPerSession: 40, dashCookieDays: 30,
        env, ids: {}, version: '1.0.0', trustedProxies: [],
        ...config,
      },
      inventory, probeRetell: async () => 'ok', sendWhatsApp: async () => ({ ok: true }),
      log: (e) => logs.push(e), now: () => NOW,
      ...options,
      db,
    });
  } catch (err) {
    // A build that throws leaves nothing behind either.
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw err;
  }
  return {
    app, db, logs,
    close: async () => {
      await app.dashboard.auth.flush();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test('createApp exposes the inbox pieces, and what the ingest stores the inbox store reads back', async () => {
  const h = build();
  try {
    const { app, db } = h;
    for (const fn of ['upsertMessage', 'messagesFor', 'listInbox', 'unreadTotal', 'retentionPurge']) {
      assert.equal(typeof app.inboxStore[fn], 'function', fn);
    }
    assert.equal(typeof app.ingest.ingest, 'function');
    assert.equal(typeof app.backfill.history, 'function');
    assert.equal(typeof app.backfill.refresh, 'function');
    assert.equal(app.backfill.configured, false, 'no Evolution credentials here: the backfill reads nothing');
    assert.equal(typeof app.sender.reply, 'function');
    assert.equal(typeof app.inboxMaintenance, 'function');

    // One store, not two: a record the ingest takes is a message the inbox store lists.
    db.insertLead({
      lead_id: 'LEAD-20260928-0000aaaa', created: NOW - DAY, updated: NOW - DAY, phone_e164: '966500000077',
      wa_jid: '966500000077@s.whatsapp.net', channel: 'whatsapp', match_method: 'ref', stage: 'new', stage_ts: NOW - DAY,
      inbox_state: 'in', inbox_since: NOW - DAY,
    });
    const out = await app.ingest.ingest(db.getLead('LEAD-20260928-0000aaaa'), {
      id: 'MSG-1', jid: '966500000077@s.whatsapp.net', jidAlt: null, fromMe: false, ts: NOW - 1000,
      text: 'is BONA-012 free?', pushName: null, contextInfo: null, messageType: 'conversation',
      media: null, fileName: null, noise: false,
    });
    assert.equal(out.stored, true);
    assert.deepEqual(app.inboxStore.messagesFor('LEAD-20260928-0000aaaa').map((m) => m.key_id), ['MSG-1']);
  } finally {
    await h.close();
  }
});

test('the ingest createApp builds keeps the one exclusion rule, and knows the instance\'s own number with no owner account to read it from', async () => {
  const h = build();
  try {
    const { app, db } = h;
    const chat = (id, phone) => db.insertLead({
      lead_id: id, created: NOW - DAY, updated: NOW - DAY, phone_e164: phone, wa_jid: `${phone}@s.whatsapp.net`,
      channel: 'whatsapp', match_method: 'ref', stage: 'new', stage_ts: NOW - DAY, inbox_state: 'in', inbox_since: NOW - DAY,
    });
    const rec = (over) => ({
      id: 'MSG-1', jid: null, jidAlt: null, fromMe: false, ts: NOW - 1000, text: 'hello', pushName: null,
      contextInfo: null, messageType: 'conversation', media: null, fileName: null, noise: false, ...over,
    });
    app.team.addNever({ phone: '0500000080' });
    chat('LEAD-never', '966500000080');
    assert.deepEqual(await app.ingest.ingest(db.getLead('LEAD-never'), rec({ jid: '966500000080@s.whatsapp.net' })), { stored: false, reason: 'excluded' });
    assert.equal(app.inboxStore.hasMessages('LEAD-never'), false);

    // The env owner deactivated while another owner runs the dashboard: his account yields
    // no user id, yet a message typed on his phone (his number as the sent record's alt)
    // still names only its sender — the instance's own number, handed to the ingest.
    app.team.addUser({ name: 'Second Owner', phone: '0500000090', role: 'owner' });
    app.team.deactivateUser(app.team.getUserByPhone('966593296933').user_id);
    chat('LEAD-client', '966500000077');
    const typed = rec({ id: 'OWN-1', fromMe: true, jid: '966500000077@s.whatsapp.net', jidAlt: '966593296933@s.whatsapp.net', text: 'on my way' });
    assert.deepEqual(await app.ingest.ingest(db.getLead('LEAD-client'), typed), { stored: true, inserted: true, senderKind: 'owner_number' });
    assert.equal(db.getLead('LEAD-client').handler_user_id, null, 'no active owner account, so nobody is made the handler');
  } finally {
    await h.close();
  }
});

test('every send the last process left pending is "uncertain" as soon as the app is built — one seconds old too', async () => {
  const db = openDb(':memory:');
  createInboxStore(db, { now: () => NOW - 10 * 60_000 }).insertOutbox({
    send_id: 'SND-left-pending', lead_id: 'LEAD-x', jid: '966500000077@s.whatsapp.net', text: 'hello', user_id: 'USR-1', sender_kind: 'staff',
  });
  // Written a few seconds before the restart: this process has no send in flight, so it is not on its way.
  createInboxStore(db, { now: () => NOW - 4_000 }).insertOutbox({
    send_id: 'SND-just-now', lead_id: 'LEAD-x', jid: '966500000077@s.whatsapp.net', text: 'hello again', user_id: 'USR-1', sender_kind: 'staff',
  });
  const h = build({ db });
  try {
    const row = h.app.inboxStore.getOutbox('SND-left-pending');
    assert.equal(row.status, 'uncertain', 'nobody knows whether it went, so it is never retried');
    assert.equal(row.error, 'interrupted');
    const young = h.app.inboxStore.getOutbox('SND-just-now');
    assert.deepEqual({ status: young.status, error: young.error }, { status: 'uncertain', error: 'interrupted' }, 'however young');
    assert.deepEqual(h.logs.filter((e) => e.evt === 'wa.send.interrupted'), [{ level: 'warn', evt: 'wa.send.interrupted', count: 2 }],
      'said once, as a count: never the number or the text');
  } finally {
    await h.close();
  }
});

test('the poller createApp builds stores a client\'s message in the inbox, reading through the one fetch', async () => {
  const LEAD = 'LEAD-20260928-0000bbbb';
  const JID = '966500000077@s.whatsapp.net';
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, where: body.where });
    // The poller's window read gets one inbound message of the chat; any other read (none
    // is expected: the chat is already in, so nothing joins) gets nothing.
    const records = body.where?.messageTimestamp ? [{
      key: { id: 'POLL-1', fromMe: false, remoteJid: JID }, pushName: null, messageType: 'conversation',
      message: { conversation: 'is it still available?' }, messageTimestamp: Math.floor((NOW - 5_000) / 1000),
    }] : [];
    return { ok: true, status: 200, text: async () => JSON.stringify({ messages: { total: records.length, pages: 1, currentPage: 1, records } }) };
  };
  const h = build({ env: ENV, config: { waPoll: true }, fetchImpl });
  try {
    const { app, db } = h;
    assert.ok(app.poller, 'BONA_WA_POLL on: the app has a poller');
    db.insertLead({
      lead_id: LEAD, created: NOW - DAY, updated: NOW - DAY, phone_e164: '966500000077', wa_jid: JID,
      channel: 'whatsapp', match_method: 'ref', stage: 'new', stage_ts: NOW - DAY, inbox_state: 'in', inbox_since: NOW - DAY,
    });

    const tally = await app.poller.tick();
    assert.equal(tally.stored, 1, 'the poller was handed the inbox: without it the message would be matched and dropped');
    assert.deepEqual(app.inboxStore.messagesFor(LEAD).map((m) => m.key_id), ['POLL-1']);
    assert.ok(calls.length >= 1);
    assert.ok(calls.every((c) => c.url === 'http://evo.test/chat/findMessages/abdulaziz-personal'), 'every read through the fetch createApp was given');
    assert.equal(calls[0].where.messageTimestamp.lte, new Date(NOW).toISOString(), 'on the clock createApp was given');
  } finally {
    await h.close();
  }
});

test('an ingest handed in as its bare function is the one the poller calls; any other shape fails the build', async () => {
  const JID = '966500000077@s.whatsapp.net';
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const records = body.where?.messageTimestamp ? [{
      key: { id: 'POLL-2', fromMe: false, remoteJid: JID }, pushName: null, messageType: 'conversation',
      message: { conversation: 'hello' }, messageTimestamp: Math.floor((NOW - 5_000) / 1000),
    }] : [];
    return { ok: true, status: 200, text: async () => JSON.stringify({ messages: { total: records.length, pages: 1, currentPage: 1, records } }) };
  };
  const seen = [];
  const ingest = async (lead, rec) => { seen.push([lead.lead_id, rec.id]); return { stored: true, inserted: true, senderKind: 'client' }; };
  const h = build({ env: ENV, config: { waPoll: true }, fetchImpl, ingest });
  try {
    const { app, db } = h;
    db.insertLead({
      lead_id: 'LEAD-bare', created: NOW - DAY, updated: NOW - DAY, phone_e164: '966500000077', wa_jid: JID,
      channel: 'whatsapp', match_method: 'ref', stage: 'new', stage_ts: NOW - DAY, inbox_state: 'in', inbox_since: NOW - DAY,
    });
    const tally = await app.poller.tick();
    assert.deepEqual(seen, [['LEAD-bare', 'POLL-2']]);
    assert.equal(tally.stored, 1);
    assert.equal(app.ingest.ingest, ingest, 'app.ingest keeps one shape whichever was handed in');
  } finally {
    await h.close();
  }

  // With the backfill handed in too, nothing else would notice: the poller would take a
  // null ingest for Phase 1 mode and store nothing, silently.
  const backfill = { configured: false, phoneJidOf: () => null, history: async () => ({}), refresh: async () => ({}) };
  for (const bad of [{}, { ingest: 'not a function' }, 42]) {
    assert.throws(() => build({ env: ENV, config: { waPoll: true }, fetchImpl, backfill, ingest: bad }), /options\.ingest must be/,
      `${JSON.stringify(bad)}: at build time, not on every record`);
  }
});

test('a login code goes out through the one real sender and leaves an outbox row without its text', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 201, text: async () => JSON.stringify({ key: { id: 'KEY-CODE-1' } }) };
  };
  const h = build({ env: ENV, fetchImpl });
  try {
    assert.equal(typeof h.app.inboxMaintenance, 'function', 'the inbox wiring this test relies on');
    const asked = await h.app.dashboard.auth.requestCode({ phone: '0593296933', ip: '127.0.0.1' });
    assert.equal(asked.ok, true);
    await h.app.dashboard.auth.flush();

    assert.equal(calls.length, 1, 'exactly one request, through the fetch createApp was given');
    assert.equal(calls[0].url, 'http://evo.test/message/sendText/abdulaziz-personal');
    assert.equal(calls[0].body.number, '966593296933');
    const code = /^Bona dashboard code: (\d{6}) \(valid 10 min\)$/.exec(calls[0].body.text)?.[1];
    assert.ok(code, 'the code went to WhatsApp');

    const rows = h.db.db.prepare('SELECT * FROM wa_outbox').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sender_kind, 'code');
    assert.equal(rows[0].text, null, 'a login code is never written anywhere but the WhatsApp message');
    assert.equal(rows[0].error, null);
    assert.equal(rows[0].status, 'accepted');
    assert.equal(rows[0].key_id, 'KEY-CODE-1');
    assert.equal(rows[0].jid, '966593296933@s.whatsapp.net');
    assert.equal(rows[0].lead_id, null);
    assert.ok(!JSON.stringify(h.logs).includes(code), 'nor in the log');
  } finally {
    await h.close();
  }
});

test('the daily upkeep: old transcripts and code rows go, stale sends become uncertain, empty chats get their history', async () => {
  const asked = [];
  const backfill = {
    configured: true,
    phoneJidOf: () => null,
    history: async (lead, { sinceTs, untilTs }) => {
      asked.push({ leadId: lead.lead_id, sinceTs, untilTs });
      return { stored: lead.lead_id === 'LEAD-empty' ? 3 : 0, scanned: 3, truncated: false };
    },
    refresh: async () => ({ stored: 0, scanned: 0, truncated: false }),
  };
  const h = build({ backfill });
  try {
    const { app, db } = h;
    const chat = (id, phone, since) => db.insertLead({
      lead_id: id, created: since, updated: since, phone_e164: phone, wa_jid: `${phone}@s.whatsapp.net`,
      channel: 'whatsapp', match_method: 'ref', stage: 'new', stage_ts: since, inbox_state: 'in', inbox_since: since,
    });
    chat('LEAD-old', '966500000077', NOW - 7 * 365 * DAY);
    chat('LEAD-recent', '966500000078', NOW - 30 * DAY);
    chat('LEAD-empty', '966500000079', NOW - 2 * DAY);
    app.inboxStore.upsertMessage({
      key_id: 'OLD-1', lead_id: 'LEAD-old', jid: '966500000077@s.whatsapp.net', direction: 'in', sender_kind: 'client',
      text: 'an old question', ts: NOW - RETENTION_MS - DAY,
    });
    app.inboxStore.upsertMessage({
      key_id: 'NEW-1', lead_id: 'LEAD-recent', jid: '966500000078@s.whatsapp.net', direction: 'in', sender_kind: 'client',
      text: 'a new question', ts: NOW - DAY,
    });
    // Outbox rows written at other moments: the same store over the same file, another clock.
    const at = (ts) => createInboxStore(db, { now: () => ts });
    const owner = '966593296933@s.whatsapp.net';
    const client = '966500000078@s.whatsapp.net';
    at(NOW - 3 * DAY).insertOutbox({ send_id: 'SND-code-three-days', jid: owner, sender_kind: 'code', status: 'accepted' });
    at(NOW - DAY).insertOutbox({ send_id: 'SND-code-one-day', jid: owner, sender_kind: 'code', status: 'accepted' });
    at(NOW - 3 * DAY).insertOutbox({ send_id: 'SND-staff-three-days', lead_id: 'LEAD-recent', jid: client, text: 'on my way', user_id: 'USR-1', sender_kind: 'staff', status: 'accepted' });
    at(NOW - 10 * 60_000).insertOutbox({ send_id: 'SND-stale', lead_id: 'LEAD-recent', jid: client, text: 'hello', user_id: 'USR-1', sender_kind: 'staff' });
    at(NOW - 30_000).insertOutbox({ send_id: 'SND-fresh', lead_id: 'LEAD-recent', jid: client, text: 'hello again', user_id: 'USR-1', sender_kind: 'staff' });

    const counts = await app.inboxMaintenance();
    assert.deepEqual(counts, { excludedOut: 0, purgedChats: 1, purgedMessages: 1, codeRows: 1, interrupted: 1, candidatesExpired: 0, dismissalsExpired: 0, caughtUp: 2, caughtUpStored: 3, caughtUpFailed: 0 });

    assert.equal(app.inboxStore.hasMessages('LEAD-old'), false, 'five years after the last message the transcript goes');
    assert.ok(db.getLead('LEAD-old'), 'the lead row stays: it is the attribution record');
    assert.equal(db.getLead('LEAD-old').last_msg_ts, null);
    assert.equal(app.inboxStore.hasMessages('LEAD-recent'), true);
    assert.equal(app.inboxStore.getOutbox('SND-code-three-days'), null);
    assert.ok(app.inboxStore.getOutbox('SND-code-one-day'), 'still inside the rolling day the cap counts');
    assert.ok(app.inboxStore.getOutbox('SND-staff-three-days'), 'a staff send that still belongs to a chat stays');
    assert.equal(app.inboxStore.getOutbox('SND-stale').status, 'uncertain');
    assert.equal(app.inboxStore.getOutbox('SND-stale').error, 'interrupted');
    assert.equal(app.inboxStore.getOutbox('SND-fresh').status, 'pending', 'a send still inside its two minutes is left alone');

    // Chats with nothing stored get the history an automatic join takes (amendment A3),
    // never further back than the retention horizon — or the purge above would be undone.
    assert.deepEqual([...asked].sort((a, b) => a.leadId.localeCompare(b.leadId)), [
      { leadId: 'LEAD-empty', sinceTs: NOW - 2 * DAY - JOIN_HISTORY_MS, untilTs: NOW },
      { leadId: 'LEAD-old', sinceTs: NOW - RETENTION_MS, untilTs: NOW },
    ]);

    assert.deepEqual(h.logs.find((e) => e.evt === 'inbox.maintenance'), { evt: 'inbox.maintenance', ...counts });
    assert.deepEqual(h.logs.find((e) => e.evt === 'inbox.catchup'), { evt: 'inbox.catchup', chats: 2, stored: 3, failed: 0 });
    const dump = JSON.stringify(h.logs);
    for (const secret of ['966500000077', '966500000078', 'an old question', 'hello']) assert.ok(!dump.includes(secret), secret);

    // One run at a time: a second call while the first is still fetching does nothing.
    const [first, second] = await Promise.all([app.inboxMaintenance(), app.inboxMaintenance()]);
    assert.deepEqual(second, { skipped: 'running' });
    assert.equal(first.purgedChats, 0);
  } finally {
    await h.close();
  }
});

test('the catch-up reads an empty chat from its durable history floor: an owner join\'s 30 days, not 24 h', async () => {
  const asked = [];
  const backfill = {
    configured: true,
    phoneJidOf: () => null,
    history: async (lead, { sinceTs, untilTs }) => { asked.push({ leadId: lead.lead_id, sinceTs, untilTs }); return { stored: 0, scanned: 0, truncated: false }; },
    refresh: async () => ({ stored: 0, scanned: 0, truncated: false }),
  };
  const h = build({ backfill });
  try {
    h.db.insertLead({
      lead_id: 'LEAD-moved', created: NOW - 60 * DAY, updated: NOW - DAY, phone_e164: '966500000077', wa_jid: '966500000077@s.whatsapp.net',
      channel: 'whatsapp', match_method: 'keyword', stage: 'new', stage_ts: NOW - 60 * DAY, inbox_state: 'in', inbox_since: NOW - DAY,
      history_from: NOW - DAY - 30 * DAY,
    });
    await h.app.inboxMaintenance();
    assert.deepEqual(asked, [{ leadId: 'LEAD-moved', sinceTs: NOW - DAY - 30 * DAY, untilTs: NOW }]);
  } finally {
    await h.close();
  }
});

test('the upkeep takes a colleague\'s or a never-list number\'s chat out of the inbox before any history is fetched', async () => {
  const asked = [];
  const backfill = {
    configured: true,
    phoneJidOf: () => null,
    history: async (lead) => { asked.push(lead.lead_id); return { stored: 0, scanned: 0, truncated: false }; },
    refresh: async () => ({ stored: 0, scanned: 0, truncated: false }),
  };
  const h = build({ backfill });
  try {
    const { app, db } = h;
    // Leads migration v4 sorted by how they matched, before anyone checked the numbers.
    const lead = (id, phone, state) => db.insertLead({
      lead_id: id, created: NOW - DAY, updated: NOW - DAY, phone_e164: phone, wa_jid: `${phone}@s.whatsapp.net`,
      channel: 'whatsapp', match_method: state === 'in' ? 'ad_meta' : 'keyword', stage: 'new', stage_ts: NOW - DAY,
      inbox_state: state, inbox_since: state === 'in' ? NOW - DAY : null,
    });
    app.team.addUser({ name: 'Sara', phone: '0500000001', role: 'staff' });
    app.team.addNever({ phone: '0500000080' });
    app.team.addNever({ phone: '0500000081' });
    lead('LEAD-staff', '966500000001', 'in');
    lead('LEAD-never', '966500000080', 'in');
    lead('LEAD-never-guess', '966500000081', 'unsure');
    lead('LEAD-client', '966500000077', 'in');
    // What the join history would have kept of the colleague's chat: her side of it.
    app.inboxStore.upsertMessage({
      key_id: 'T-1', lead_id: 'LEAD-staff', jid: '966500000001@s.whatsapp.net', direction: 'in', sender_kind: 'client',
      text: 'my code did not come', ts: NOW - 1000,
    });
    assert.equal(app.inboxStore.unreadTotal({ userId: 'USR-anyone' }), 1, 'the control: before the upkeep it counts');

    const counts = await app.inboxMaintenance();
    assert.deepEqual(counts, { excludedOut: 3, purgedChats: 0, purgedMessages: 0, codeRows: 0, interrupted: 0, candidatesExpired: 0, dismissalsExpired: 0, caughtUp: 1, caughtUpStored: 0, caughtUpFailed: 0 });
    for (const id of ['LEAD-staff', 'LEAD-never', 'LEAD-never-guess']) assert.equal(db.getLead(id).inbox_state, 'out', id);
    assert.equal(app.inboxStore.hasMessages('LEAD-staff'), false, 'her words are gone, not merely hidden');
    assert.equal(app.inboxStore.unreadTotal({ userId: 'USR-anyone' }), 0, 'and no badge counts them');
    assert.deepEqual(asked, ['LEAD-client'], 'history is fetched for the client alone');
    assert.equal(db.getLead('LEAD-client').inbox_state, 'in');

    assert.deepEqual(h.logs.find((e) => e.evt === 'inbox.excluded_out'), { level: 'warn', evt: 'inbox.excluded_out', count: 3 });
    const dump = JSON.stringify(h.logs);
    for (const secret of ['500000001', '500000080', '500000081', 'Sara', 'my code did not come']) assert.ok(!dump.includes(secret), secret);

    // Nothing left to take out: the next run finds nothing and says nothing about it.
    const again = await app.inboxMaintenance();
    assert.equal(again.excludedOut, 0);
    assert.equal(h.logs.filter((e) => e.evt === 'inbox.excluded_out').length, 1);
  } finally {
    await h.close();
  }
});

test('a catch-up read that fails leaves the thread a gap where its history belongs, and a later clean read takes it back', async () => {
  let h;
  const asked = [];
  const calls = {};
  const ok = { stored: 0, scanned: 0, truncated: false };
  /** Per chat, what each successive read answers. */
  const answers = {
    // Page 1 stored, then page 2 timed out: the chat has a message now, so no run asks again.
    'LEAD-partial': [async () => {
      h.app.inboxStore.upsertMessage({
        key_id: 'P-1', lead_id: 'LEAD-partial', jid: '966500000071@s.whatsapp.net', direction: 'in', sender_kind: 'client',
        text: 'the newest page', ts: NOW - DAY,
      });
      return { error: 'timeout' };
    }],
    // Nothing stored, then a clean read the next day: the gap was never true, so it goes.
    'LEAD-down': [async () => ({ error: 'http_502' }), async () => ok],
    // A read that got only part of the chat (more pages than it may read) proves nothing.
    'LEAD-huge': [async () => ({ error: 'network' }), async () => ({ ...ok, truncated: true })],
    // Marked Not a client while its read was failing: leaveInbox purged its gaps then.
    'LEAD-left': [async () => { h.app.inboxStore.leaveInbox('LEAD-left'); return { error: 'timeout' }; }],
    // Nothing was read for it: neither caught up nor failed.
    'LEAD-skipped': [async () => ({ ...ok, skipped: 'not_in_inbox' })],
  };
  const backfill = {
    configured: true,
    phoneJidOf: () => null,
    history: async (lead) => {
      asked.push(lead.lead_id);
      const n = calls[lead.lead_id] = (calls[lead.lead_id] ?? 0) + 1;
      const list = answers[lead.lead_id] ?? [async () => ok];
      return list[Math.min(n, list.length) - 1](lead);
    },
    refresh: async () => ok,
  };
  h = build({ backfill });
  try {
    const { app, db } = h;
    const chat = (id, phone, since) => db.insertLead({
      lead_id: id, created: since, updated: since, phone_e164: phone, wa_jid: `${phone}@s.whatsapp.net`,
      channel: 'whatsapp', match_method: 'ad_meta', stage: 'new', stage_ts: since, inbox_state: 'in', inbox_since: since,
    });
    chat('LEAD-partial', '966500000071', NOW - 5 * DAY);
    chat('LEAD-down', '966500000072', NOW - 4 * DAY);
    chat('LEAD-huge', '966500000073', NOW - 3 * DAY);
    chat('LEAD-left', '966500000074', NOW - 2 * DAY);
    chat('LEAD-skipped', '966500000075', NOW - DAY);
    const gap = (id, since) => ({
      key_id: `join:${id}:${since}`, lead_id: id, jid: null, ts: since - JOIN_HISTORY_MS, reason: 'history_failed',
    });

    const first = await app.inboxMaintenance();
    assert.deepEqual(first, { excludedOut: 0, purgedChats: 0, purgedMessages: 0, codeRows: 0, interrupted: 0, candidatesExpired: 0, dismissalsExpired: 0, caughtUp: 0, caughtUpStored: 0, caughtUpFailed: 4 });
    assert.deepEqual(h.logs.find((e) => e.evt === 'inbox.catchup'), { evt: 'inbox.catchup', chats: 0, stored: 0, failed: 4 },
      'a run where every read failed does not read like a run with nothing to do');
    // Keyed like the poller's join gap, at the start of the window the read was asked for.
    assert.deepEqual(app.inboxStore.gapsFor('LEAD-partial'), [gap('LEAD-partial', NOW - 5 * DAY)],
      'what page 1 brought is stored, and the thread says the rest could not be loaded');
    assert.deepEqual(app.inboxStore.gapsFor('LEAD-down'), [gap('LEAD-down', NOW - 4 * DAY)],
      'a client may write before the next run, and then this chat is never asked again');
    assert.deepEqual(app.inboxStore.gapsFor('LEAD-huge'), [gap('LEAD-huge', NOW - 3 * DAY)]);
    assert.deepEqual(app.inboxStore.gapsFor('LEAD-left'), [], 'a chat that left the inbox meanwhile gets no gap');
    assert.deepEqual(app.inboxStore.gapsFor('LEAD-skipped'), []);

    asked.length = 0;
    const second = await app.inboxMaintenance();
    assert.deepEqual(asked, ['LEAD-down', 'LEAD-huge', 'LEAD-skipped'], 'a chat with a message is never asked again: its gap is its only trace');
    assert.equal(second.caughtUp, 2);
    assert.equal(second.caughtUpFailed, 0);
    assert.deepEqual(app.inboxStore.gapsFor('LEAD-down'), [], 'the whole window was read after all');
    assert.deepEqual(app.inboxStore.gapsFor('LEAD-huge'), [gap('LEAD-huge', NOW - 3 * DAY)], 'a truncated read leaves it');
    assert.deepEqual(app.inboxStore.gapsFor('LEAD-partial'), [gap('LEAD-partial', NOW - 5 * DAY)]);

    // A gap that cannot be written is a log line, and the run goes on.
    chat('LEAD-gapless', '966500000076', NOW - DAY / 2);
    answers['LEAD-gapless'] = [async () => ({ error: 'timeout' })];
    app.inboxStore.addGap = () => { throw new Error('disk full for 966500000076'); };
    const third = await app.inboxMaintenance();
    assert.equal(third.caughtUpFailed, 1);
    assert.deepEqual(h.logs.filter((e) => e.evt === 'inbox.gap_failed'), [
      { level: 'warn', evt: 'inbox.gap_failed', leadId: 'LEAD-gapless', reason: 'history_failed' },
    ]);
    assert.equal(h.logs.filter((e) => e.evt === 'inbox.maintenance_failed').length, 0);

    const dump = JSON.stringify(h.logs);
    for (const secret of ['96650000007', 'the newest page', 'disk full']) assert.ok(!dump.includes(secret), secret);
  } finally {
    await h.close();
  }
});

test('a number that joins the team while the catch-up is fetching is not fetched after it', async () => {
  let h;
  const asked = [];
  const backfill = {
    configured: true,
    phoneJidOf: () => null,
    history: async (lead) => {
      asked.push(lead.lead_id);
      if (lead.lead_id === 'LEAD-first' && !h.app.team.getUserByPhone('966500000079')) {
        h.app.team.addUser({ name: 'New Hand', phone: '0500000079', role: 'staff' });
      }
      return { stored: 0, scanned: 0, truncated: false };
    },
    refresh: async () => ({ stored: 0, scanned: 0, truncated: false }),
  };
  h = build({ backfill });
  try {
    const { app, db } = h;
    const chat = (id, phone, since) => db.insertLead({
      lead_id: id, created: since, updated: since, phone_e164: phone, wa_jid: `${phone}@s.whatsapp.net`,
      channel: 'whatsapp', match_method: 'ad_meta', stage: 'new', stage_ts: since, inbox_state: 'in', inbox_since: since,
    });
    chat('LEAD-first', '966500000077', NOW - 2 * DAY);
    chat('LEAD-colleague', '966500000079', NOW - DAY);

    const counts = await app.inboxMaintenance();
    assert.deepEqual(asked, ['LEAD-first'], 'the list was read before she joined; the check before each read was not');
    assert.equal(counts.caughtUp, 1);
    assert.equal((await app.inboxMaintenance()).excludedOut, 1, 'and the next sweep puts her chat out');
    assert.deepEqual(asked, ['LEAD-first', 'LEAD-first']);
  } finally {
    await h.close();
  }
});

test('a step that fails is one log line naming the step and the kind of failure, never its message; the other steps still run', async () => {
  let fail = null;
  const backfill = {
    configured: true,
    phoneJidOf: () => null,
    history: async () => { if (fail) throw fail; return { stored: 0, scanned: 0, truncated: false }; },
    refresh: async () => ({ stored: 0, scanned: 0, truncated: false }),
  };
  let clockFails = false;
  const h = build({ backfill, now: () => { if (clockFails) throw new TypeError('clock for 966500000077'); return NOW; } });
  try {
    const { app, db } = h;
    db.insertLead({
      lead_id: 'LEAD-empty', created: NOW - DAY, updated: NOW - DAY, phone_e164: '966500000077', wa_jid: '966500000077@s.whatsapp.net',
      channel: 'whatsapp', match_method: 'ref', stage: 'new', stage_ts: NOW - DAY, inbox_state: 'in', inbox_since: NOW - DAY,
    });
    // A read that breaks its promise never to throw ends the catch-up, not the run. An error
    // message can carry a jid; its name and code are logged only in shapes that cannot.
    fail = Object.assign(new TypeError('no chat for 966500000077@s.whatsapp.net'), { code: 'ERR_SQLITE_ERROR' });
    const counts = await app.inboxMaintenance();
    assert.deepEqual(counts, { excludedOut: 0, purgedChats: 0, purgedMessages: 0, codeRows: 0, interrupted: 0, candidatesExpired: 0, dismissalsExpired: 0, caughtUp: 0, caughtUpStored: 0, caughtUpFailed: 0 });
    assert.deepEqual(h.logs.find((e) => e.evt === 'inbox.maintenance'), { evt: 'inbox.maintenance', ...counts }, 'the run still reports');
    fail = Object.assign(new Error('boom'), { name: 'Chat966500000077', code: '966500000077' });
    await app.inboxMaintenance();

    // A local step that fails reads null (not known), and the steps after it still run.
    fail = null;
    createInboxStore(db, { now: () => NOW - 10 * 60_000 }).insertOutbox({
      send_id: 'SND-stale', lead_id: 'LEAD-empty', jid: '966500000077@s.whatsapp.net', text: 'hello', user_id: 'USR-1', sender_kind: 'staff',
    });
    const purge = app.inboxStore.retentionPurge;
    app.inboxStore.retentionPurge = () => { throw Object.assign(new RangeError('966500000077'), { code: 'ERR_SQLITE_ERROR' }); };
    const partial = await app.inboxMaintenance();
    app.inboxStore.retentionPurge = purge;
    assert.equal(partial.purgedChats, null);
    assert.equal(partial.purgedMessages, null);
    assert.equal(partial.interrupted, 1, 'the stale send is marked all the same');
    assert.equal(partial.caughtUp, 1, 'and the catch-up runs');
    const sweep = app.inboxStore.listedLeads;
    app.inboxStore.listedLeads = () => { throw new Error('966500000077'); };
    const unswept = await app.inboxMaintenance();
    app.inboxStore.listedLeads = sweep;
    assert.equal(unswept.excludedOut, null);
    assert.equal(unswept.purgedChats, 0);

    // Only a failure outside every step fails the run, and it resolves all the same.
    clockFails = true;
    assert.deepEqual(await app.inboxMaintenance(), { error: 'failed' });
    clockFails = false;

    assert.deepEqual(h.logs.filter((e) => e.evt === 'inbox.maintenance_failed'), [
      { level: 'error', evt: 'inbox.maintenance_failed', step: 'catchup', name: 'TypeError', code: 'ERR_SQLITE_ERROR' },
      { level: 'error', evt: 'inbox.maintenance_failed', step: 'catchup', name: null, code: null },
      { level: 'error', evt: 'inbox.maintenance_failed', step: 'retention', name: 'RangeError', code: 'ERR_SQLITE_ERROR' },
      { level: 'error', evt: 'inbox.maintenance_failed', step: 'sweep', name: 'Error', code: null },
      { level: 'error', evt: 'inbox.maintenance_failed', step: 'run', name: 'TypeError', code: null },
    ]);
    assert.ok(!JSON.stringify(h.logs).includes('966500000077'), 'no number, in the message, the name or the code');

    assert.equal((await app.inboxMaintenance()).caughtUp, 1, 'a failed run does not leave the upkeep "running"');
  } finally {
    await h.close();
  }
});

test('upkeep never rejects, and a logger that throws costs no step and fails no finished run', async () => {
  const backfill = {
    configured: true,
    phoneJidOf: () => null,
    history: async () => ({ stored: 0, scanned: 0, truncated: false }),
    refresh: async () => ({ stored: 0, scanned: 0, truncated: false }),
  };
  const log = (e) => { if (String(e?.evt).startsWith('inbox.')) throw new Error('log sink down'); };
  let clockFails = false;
  const h = build({ backfill, log, now: () => { if (clockFails) throw new Error('clock'); return NOW; } });
  try {
    const { app, db } = h;
    const lead = (id, phone) => db.insertLead({
      lead_id: id, created: NOW - DAY, updated: NOW - DAY, phone_e164: phone, wa_jid: `${phone}@s.whatsapp.net`,
      channel: 'whatsapp', match_method: 'ref', stage: 'new', stage_ts: NOW - DAY, inbox_state: 'in', inbox_since: NOW - DAY,
    });
    app.team.addNever({ phone: '0500000080' });
    lead('LEAD-never', '966500000080');
    lead('LEAD-empty', '966500000077');
    createInboxStore(db, { now: () => NOW - 10 * 60_000 }).insertOutbox({
      send_id: 'SND-stale', lead_id: 'LEAD-empty', jid: '966500000077@s.whatsapp.net', text: 'hello', user_id: 'USR-1', sender_kind: 'staff',
    });
    assert.deepEqual(await app.inboxMaintenance(),
      { excludedOut: 1, purgedChats: 0, purgedMessages: 0, codeRows: 0, interrupted: 1, candidatesExpired: 0, dismissalsExpired: 0, caughtUp: 1, caughtUpStored: 0, caughtUpFailed: 0 },
      'the sweep\'s line threw, and every step after it ran; the closing lines threw, and the run is still a finished one');

    backfill.history = async () => { throw new Error('read failed'); };
    assert.equal((await app.inboxMaintenance()).caughtUp, 0, 'resolved, not rejected: the server calls it fire-and-forget');
    clockFails = true;
    assert.deepEqual(await app.inboxMaintenance(), { error: 'failed' }, 'even while it reports a failure');
  } finally {
    await h.close();
  }
});

test('without Evolution the upkeep still runs its local steps, and skips the catch-up without a word about it', async () => {
  const h = build();
  try {
    const { app, db } = h;
    assert.equal(app.backfill.configured, false);
    db.insertLead({
      lead_id: 'LEAD-empty', created: NOW - DAY, updated: NOW - DAY, phone_e164: '966500000077', wa_jid: '966500000077@s.whatsapp.net',
      channel: 'whatsapp', match_method: 'ref', stage: 'new', stage_ts: NOW - DAY, inbox_state: 'in', inbox_since: NOW - DAY,
    });
    const counts = await app.inboxMaintenance();
    assert.equal(counts.caughtUp, 0);
    assert.equal(counts.caughtUpStored, 0);
    assert.equal(h.logs.some((e) => e.evt === 'inbox.catchup'), false, 'no catch-up line when there is nothing to read from');
    assert.deepEqual(h.logs.find((e) => e.evt === 'inbox.maintenance'), { evt: 'inbox.maintenance', ...counts });
  } finally {
    await h.close();
  }
});

test('the daily upkeep prunes the real-estate chats to check: open ones after 30 days, dismissed ones after a year', async () => {
  const h = build();
  try {
    const { app, db } = h;
    // Rows written at other moments: the same store over the same file, another clock.
    const at = (ts) => createInboxStore(db, { now: () => ts });
    const note = (phone, ts) => app.inboxStore.noteCandidate({ phone, ts, words: ['villa'], dir: 'in' }).cand_id;
    const stale = note('966500000071', NOW - 31 * DAY);
    const fresh = note('966500000072', NOW - 29 * DAY);
    const oldNo = note('966500000073', NOW - 400 * DAY);
    const newNo = note('966500000074', NOW - 400 * DAY);
    at(NOW - 366 * DAY).dismissCandidate(oldNo);
    at(NOW - 10 * DAY).dismissCandidate(newNo);

    const counts = await app.inboxMaintenance();
    assert.equal(counts.candidatesExpired, 1);
    assert.equal(counts.dismissalsExpired, 1);
    assert.equal(app.inboxStore.getCandidate(stale), null);
    assert.ok(app.inboxStore.getCandidate(fresh));
    assert.equal(app.inboxStore.getCandidate(oldNo), null);
    assert.equal(app.inboxStore.getCandidate(newNo).state, 'dismissed', 'still not listed again');
    assert.deepEqual(h.logs.find((e) => e.evt === 'inbox.maintenance'), { evt: 'inbox.maintenance', ...counts });
    assert.ok(!JSON.stringify(h.logs).includes('96650000007'), 'counts only');

    // A step of its own, like every other: a prune that fails reads null and the run goes on.
    const prune = app.inboxStore.pruneCandidates;
    app.inboxStore.pruneCandidates = () => { throw new RangeError('966500000072'); };
    const partial = await app.inboxMaintenance();
    app.inboxStore.pruneCandidates = prune;
    assert.equal(partial.candidatesExpired, null);
    assert.equal(partial.dismissalsExpired, null);
    assert.equal(partial.codeRows, 0, 'the other steps still ran');
    assert.deepEqual(h.logs.filter((e) => e.evt === 'inbox.maintenance_failed'),
      [{ level: 'error', evt: 'inbox.maintenance_failed', step: 'candidates', name: 'RangeError', code: null }]);
    assert.ok(!JSON.stringify(h.logs).includes('96650000007'), 'no number in the failure either');
  } finally {
    await h.close();
  }
});
