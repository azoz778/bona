/**
 * The inbox as createApp wires it (2026-09-27 design §4): one inbox store behind the one
 * sender, the ingest and the backfill; a login code recorded in the outbox without its
 * text; a send the last process left pending given up on at start-up; and the daily
 * upkeep. Nothing leaves the process — the sender's fetch is a fake, and the backfill is
 * a spy where the test needs one. No server is listened on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../index.mjs';
import { openDb, tokenHash } from '../lib/db.mjs';
import { createInventory, WORKTREE_LISTINGS } from '../lib/inventory.mjs';
import { DEFAULT_ORIGINS } from '../lib/cors.mjs';
import { createInboxStore, RETENTION_MS } from '../lib/inbox/store.mjs';
import { JOIN_HISTORY_MS } from '../lib/inbox/backfill.mjs';
import { generateVapidKeys } from '../lib/push.mjs';
import { isExcludedLead } from '../lib/team.mjs';
import { createFakeBrain, brainReply, brainError } from '../lib/brain/fake.mjs';

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
      // Dana on the Retell mock only because a test says so; no 2 s batch wait here.
      danaOnMock: true, danaBatchMs: 0,
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
      await app.dana.stop();
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
    // The old chat's reply goes with its transcript, and is counted as a purged send.
    at(NOW - RETENTION_MS - DAY).insertOutbox({ send_id: 'SND-staff-old', lead_id: 'LEAD-old', jid: '966500000077@s.whatsapp.net', text: 'an old answer', user_id: 'USR-1', sender_kind: 'staff', status: 'accepted' });

    const counts = await app.inboxMaintenance();
    assert.deepEqual(counts, { excludedOut: 0, purgedChats: 1, purgedMessages: 1, purgedSends: 1, codeRows: 1, interrupted: 1, candidatesExpired: 0, dismissalsExpired: 0, pushOrphans: 0, caughtUp: 2, caughtUpStored: 3, caughtUpFailed: 0 });

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
    assert.deepEqual(counts, { excludedOut: 3, purgedChats: 0, purgedMessages: 0, purgedSends: 0, codeRows: 0, interrupted: 0, candidatesExpired: 0, dismissalsExpired: 0, pushOrphans: 0, caughtUp: 1, caughtUpStored: 0, caughtUpFailed: 0 });
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
    assert.deepEqual(first, { excludedOut: 0, purgedChats: 0, purgedMessages: 0, purgedSends: 0, codeRows: 0, interrupted: 0, candidatesExpired: 0, dismissalsExpired: 0, pushOrphans: 0, caughtUp: 0, caughtUpStored: 0, caughtUpFailed: 4 });
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
    assert.deepEqual(counts, { excludedOut: 0, purgedChats: 0, purgedMessages: 0, purgedSends: 0, codeRows: 0, interrupted: 0, candidatesExpired: 0, dismissalsExpired: 0, pushOrphans: 0, caughtUp: 0, caughtUpStored: 0, caughtUpFailed: 0 });
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
    assert.equal(partial.purgedSends, null);
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
      { excludedOut: 1, purgedChats: 0, purgedMessages: 0, purgedSends: 0, codeRows: 0, interrupted: 1, candidatesExpired: 0, dismissalsExpired: 0, pushOrphans: 0, caughtUp: 1, caughtUpStored: 0, caughtUpFailed: 0 },
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

test("the backfill createApp builds takes back a join's history gap once a thread refresh reads the whole join window", async () => {
  const JID = '966500000077@s.whatsapp.net';
  const LEAD = 'LEAD-20260929-0000cccc';
  // Every per-chat question: the chat's one message, inside the window, one page.
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const records = body.where?.key?.remoteJid === JID ? [{
      key: { id: 'HIST-1', fromMe: false, remoteJid: JID }, pushName: null, messageType: 'conversation',
      message: { conversation: 'hello' }, messageTimestamp: Math.floor((NOW - 3_600_000) / 1000),
    }] : [];
    return { ok: true, status: 200, text: async () => JSON.stringify({ messages: { total: records.length, pages: 1, currentPage: 1, records } }) };
  };
  const h = build({ env: ENV, fetchImpl });
  try {
    const { app, db } = h;
    db.insertLead({
      lead_id: LEAD, created: NOW - DAY, updated: NOW - DAY, phone_e164: '966500000077', wa_jid: JID,
      channel: 'whatsapp', match_method: 'ref', stage: 'new', stage_ts: NOW - DAY, inbox_state: 'in', inbox_since: NOW - DAY,
      history_from: NOW - DAY - JOIN_HISTORY_MS,
    });
    app.inboxStore.addGap({ key_id: `join:${LEAD}:${NOW - DAY}`, lead_id: LEAD, ts: NOW - DAY - 1, reason: 'history_failed' });
    const out = await app.backfill.refresh(db.getLead(LEAD));
    assert.equal(out.stored, 1);
    assert.deepEqual(app.inboxStore.gapsFor(LEAD), [], 'the join window came back whole');
  } finally {
    await h.close();
  }
});

/* -------------------- phone alerts (Phase 3): the trigger, the upkeep, the keys -------------------- */

const b64u = (b) => Buffer.from(b).toString('base64url');
const KEYS = { p256dh: b64u(Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)])), auth: b64u(crypto.randomBytes(16)) };

test('a client message the poller stores sends a phone alert through the one fetch; the upkeep prunes devices whose login is gone', async () => {
  const LEAD = 'LEAD-20260928-0000cccc';
  const JID = '966500000077@s.whatsapp.net';
  const pushes = [];
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://fcm.googleapis.com/')) {
      pushes.push({ url, init });
      return { status: 201, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    const body = JSON.parse(init.body);
    const records = body.where?.messageTimestamp ? [{
      key: { id: 'POLL-2', fromMe: false, remoteJid: JID }, pushName: null, messageType: 'conversation',
      message: { conversation: 'hello?' }, messageTimestamp: Math.floor((NOW - 5_000) / 1000),
    }] : [];
    return { ok: true, status: 200, text: async () => JSON.stringify({ messages: { total: records.length, pages: 1, currentPage: 1, records } }) };
  };
  const pair = generateVapidKeys();
  const h = build({ env: ENV, config: { waPoll: true, vapidPublic: pair.publicKey, vapidPrivate: pair.privateKey, vapidSubject: 'https://bona.azoz.uk' }, fetchImpl });
  try {
    const { app, db } = h;
    assert.equal(app.alerts.configured, true);
    db.insertLead({
      lead_id: LEAD, created: NOW - DAY, updated: NOW - DAY, phone_e164: '966500000077', wa_jid: JID,
      channel: 'whatsapp', match_method: 'ref', stage: 'new', stage_ts: NOW - DAY, inbox_state: 'in', inbox_since: NOW - DAY,
    });
    const sara = app.team.addUser({ name: 'Sara', phone: '966500000001', role: 'staff' });
    const token = 'ab'.repeat(16);
    db.createAuthSession(token, { now: NOW, userId: sara.user_id });
    assert.deepEqual(app.alerts.subscribe({ userId: sara.user_id, sessionHash: tokenHash(token), endpoint: 'https://fcm.googleapis.com/fcm/send/w1', keys: KEYS }), { ok: true, created: true, moved: false });

    const tally = await app.poller.tick();
    assert.equal(tally.stored, 1);
    await app.alerts.flush();
    assert.equal(pushes.length, 1, 'one device, one push');
    assert.equal(pushes[0].url, 'https://fcm.googleapis.com/fcm/send/w1');
    assert.equal(pushes[0].init.method, 'POST');
    assert.equal(pushes[0].init.body, undefined, 'payload-less (P3-10): no body at all, as lib/push.mjs sends it');
    assert.match(pushes[0].init.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    assert.ok(h.logs.some((l) => l.evt === 'push.sent' && l.ok === 1 && l.leadId === LEAD));
    assert.doesNotMatch(JSON.stringify(h.logs), /fcm\.googleapis|send\/w1|966500000077|hello\?/);

    assert.equal((await app.inboxMaintenance()).pushOrphans, 0);
    db.deleteAuthSession(token);
    assert.equal((await app.inboxMaintenance()).pushOrphans, 1, 'a device whose login is gone');
    assert.equal(app.alerts.countFor(sara.user_id), 0);
  } finally {
    await h.close();
  }
});

test('a stranger the poller puts in the Unsure list sends one "chat to check" push, to the owner\'s device only', async () => {
  const JID = '966500000099@s.whatsapp.net';
  const pushes = [];
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://fcm.googleapis.com/')) {
      pushes.push({ url, init });
      return { status: 201, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    const body = JSON.parse(init.body);
    const records = body.where?.messageTimestamp ? [{
      key: { id: 'POLL-U', fromMe: false, remoteJid: JID }, pushName: 'Stranger', messageType: 'conversation',
      message: { conversation: 'مرحبا بونا' }, messageTimestamp: Math.floor((NOW - 5_000) / 1000),
    }] : [];
    return { ok: true, status: 200, text: async () => JSON.stringify({ messages: { total: records.length, pages: 1, currentPage: 1, records } }) };
  };
  const pair = generateVapidKeys();
  const h = build({
    env: { ...ENV, BONA_OWNER_JID: '966593296933@s.whatsapp.net' },
    config: { waPoll: true, vapidPublic: pair.publicKey, vapidPrivate: pair.privateKey, vapidSubject: 'https://bona.azoz.uk' }, fetchImpl,
  });
  try {
    const { app, db } = h;
    const owner = db.db.prepare("SELECT user_id FROM users WHERE role = 'owner' AND active = 1").get();
    assert.ok(owner, 'the owner is seeded from BONA_OWNER_JID');
    const sara = app.team.addUser({ name: 'Sara', phone: '966500000001', role: 'staff' });
    const ownerToken = 'cd'.repeat(16);
    const saraToken = 'ef'.repeat(16);
    db.createAuthSession(ownerToken, { now: NOW, userId: owner.user_id });
    db.createAuthSession(saraToken, { now: NOW, userId: sara.user_id });
    assert.equal(app.alerts.subscribe({ userId: owner.user_id, sessionHash: tokenHash(ownerToken), endpoint: 'https://fcm.googleapis.com/fcm/send/own1', keys: KEYS }).ok, true);
    assert.equal(app.alerts.subscribe({ userId: sara.user_id, sessionHash: tokenHash(saraToken), endpoint: 'https://fcm.googleapis.com/fcm/send/staff1', keys: KEYS }).ok, true);

    await app.poller.tick();
    const lead = db.getLeadByJid(JID);
    assert.equal(lead?.inbox_state, 'unsure', 'a keyword guess: the Unsure list');
    await app.alerts.flush();
    assert.deepEqual(pushes.map((p) => p.url), ['https://fcm.googleapis.com/fcm/send/own1'], 'one push, to the owner; staff never hear of a chat to check');
    assert.ok(h.logs.some((l) => l.evt === 'push.sent' && l.reason === 'check' && l.leadId === lead.lead_id && l.ok === 1));
    assert.deepEqual(app.alerts.pendingCheck(owner.user_id), { leadId: lead.lead_id, ts: NOW, msgTs: NOW - 5_000 });
    assert.doesNotMatch(JSON.stringify(h.logs), /fcm\.googleapis|own1|staff1|966500000099|مرحبا|Stranger/);
  } finally {
    await h.close();
  }
});

test('without VAPID keys the app has no alerts; a pair that does not match is refused out loud', async () => {
  const off = build({});
  try { assert.equal(off.app.alerts.configured, false); } finally { await off.close(); }
  const a = generateVapidKeys();
  const b = generateVapidKeys();
  const broken = build({ config: { vapidPublic: a.publicKey, vapidPrivate: b.privateKey, vapidSubject: 'https://bona.azoz.uk' } });
  try {
    assert.equal(broken.app.alerts.configured, false);
    assert.ok(broken.logs.some((l) => l.evt === 'push.keys_invalid' && l.level === 'error' && l.keys === false && l.subject === true),
      'the line names the half that failed: the pair, not the subject');
    assert.doesNotMatch(JSON.stringify(broken.logs), new RegExp(`${a.publicKey}|${b.privateKey}`), 'never a key');
  } finally {
    await broken.close();
  }
  const badSubject = build({ config: { vapidPublic: a.publicKey, vapidPrivate: a.privateKey, vapidSubject: 'ops@example.com' } });
  try {
    assert.equal(badSubject.app.alerts.configured, false, 'a subject that is not mailto: or https: would earn a 403 from Apple');
    assert.ok(badSubject.logs.some((l) => l.evt === 'push.keys_invalid' && l.level === 'error' && l.keys === true && l.subject === false));
  } finally {
    await badSubject.close();
  }
});

test('a client message the poller stores wakes Dana; off she answers nobody, on she answers through the one sender with the disclosure', async () => {
  const LEAD = 'LEAD-20260930-0000eeee';
  const JID = '966500000088@s.whatsapp.net';
  const sends = [];
  let seq = 0;
  let readBack = false;
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/message/sendText/')) {
      sends.push(JSON.parse(init.body));
      return { ok: true, status: 201, text: async () => JSON.stringify({ key: { id: `KEY-D${sends.length}` } }) };
    }
    const body = JSON.parse(init.body);
    seq += 1;
    // One record per tick, and only for the first two: the first while she is off, the second on.
    // Once she has sent, the next read hands her own answer back from the owner's number
    // (P4-5) — once, and never before her send (her pre-send check reads the chat too).
    let records = body.where?.messageTimestamp && seq <= 2 ? [seq === 1 ? {
      key: { id: 'POLL-D1', fromMe: false, remoteJid: JID }, pushName: null, messageType: 'conversation',
      message: { conversation: 'hello, is anyone there?' }, messageTimestamp: Math.floor((NOW - 5_000) / 1000),
    } : {
      key: { id: 'POLL-D2', fromMe: false, remoteJid: JID }, pushName: null, messageType: 'conversation',
      message: { conversation: 'still there?' }, messageTimestamp: Math.floor((NOW - 4_000) / 1000),
    }] : [];
    if (body.where?.messageTimestamp && sends.length && !readBack) {
      readBack = true;
      records = [{
        key: { id: 'KEY-D1', fromMe: true, remoteJid: JID }, pushName: null, messageType: 'conversation',
        message: { conversation: sends[0].text }, messageTimestamp: Math.floor((NOW - 3_000) / 1000),
      }];
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ messages: { total: records.length, pages: 1, currentPage: 1, records } }) };
  };
  const h = build({ env: ENV, config: { waPoll: true, waChatAgentId: 'agent_wa', retellMock: true }, fetchImpl });
  try {
    const { app, db } = h;
    assert.equal(app.dana.configured, true);
    assert.equal(typeof app.dana.wake, 'function');
    db.insertLead({
      lead_id: LEAD, created: NOW - DAY, updated: NOW - DAY, phone_e164: '966500000088', wa_jid: JID,
      channel: 'whatsapp', match_method: 'ref', stage: 'new', stage_ts: NOW - DAY, inbox_state: 'in', inbox_since: NOW - DAY,
    });
    assert.equal((await app.poller.tick()).stored, 1);
    assert.equal(app.dana.status().pending, 1, 'the poller hook armed a batch, even while she is off');
    await app.dana.flush();
    await app.alerts.flush();
    assert.equal(sends.length, 0, 'Dana ships off (dana_enabled = 0)');
    assert.equal(db.getLead(LEAD).dana_chat_id, null);

    app.team.setSetting('dana_enabled', '1');
    assert.equal((await app.poller.tick()).stored, 1, 'the next client message, woken by the poller alone');
    await app.dana.flush();
    assert.equal(sends.length, 1);
    assert.equal(sends[0].number, '966500000088');
    assert.ok(sends[0].text.startsWith("Dana — Bona's AI assistant\n\n"), sends[0].text);
    assert.ok(sends[0].text.includes('Which district'), 'the Retell mock answered');
    const lead = db.getLead(LEAD);
    assert.match(lead.dana_chat_id, /^chat_mock_/);
    assert.equal(lead.dana_introduced, 1);
    assert.equal(typeof lead.first_reply_ts, 'number', 'Dana counts as a reply for the watchdog (2026-10-05 R1)');
    assert.equal(app.inboxStore.messagesFor(LEAD).filter((m) => m.sender_kind === 'dana').length, 1);
    assert.ok(h.logs.some((l) => l.evt === 'dana.answered' && l.leadId === LEAD && l.batch === 2), 'one answer for both unanswered messages');
    assert.doesNotMatch(JSON.stringify(h.logs), /966500000088|anyone there|chat_mock/);
    assert.deepEqual(app.dana.status(), { configured: true, enabled: true, pending: 0, inflight: 0 });

    // The next poll reads her answer back from the owner's number: still hers, still no stamp.
    const back = await app.poller.tick();
    assert.equal(back.replies, 0, 'her own message is not a reply');
    assert.equal(db.getLead(LEAD).first_reply_ts, lead.first_reply_ts, 'reading her message back stamps nothing again: the poller never stamps on her echo');
    assert.equal(db.getLead(LEAD).last_human_out_ts, lead.last_human_out_ts, 'nor the human clock (P4-5)');
    const danas = app.inboxStore.messagesFor(LEAD).filter((m) => m.sender_kind === 'dana');
    assert.equal(danas.length, 1, 'one dana message, not two');
    assert.equal(danas[0].key_id, 'KEY-D1');
    assert.equal(app.inboxStore.messagesFor(LEAD).filter((m) => m.direction === 'out').length, 1);
  } finally {
    await h.close();
  }
});

test('without a WhatsApp agent id Dana is not configured, and the app still builds and polls', async () => {
  const h = build({ env: ENV, config: { waPoll: true, retellMock: true } });
  try {
    assert.equal(h.app.dana.configured, false);
    await h.app.poller.tick();
    assert.equal(h.app.dana.status().pending, 0, 'not configured: a wake arms nothing');
    assert.equal(h.app.dana.status().configured, false);
    h.app.dana.wake('LEAD-x', NOW);
    await h.app.dana.flush();
    assert.equal(typeof h.app.dana.stop, 'function');
  } finally {
    await h.close();
  }
});

test('on the Retell mock Dana is off unless a test opts in, and says so once', async () => {
  const h = build({ env: ENV, config: { waPoll: true, retellMock: true, waChatAgentId: 'agent_wa' }, danaOnMock: undefined });
  try {
    assert.equal(h.app.dana.configured, false, 'a mock answer never reaches a real client');
    assert.equal(h.logs.filter((l) => l.evt === 'dana.mock_off' && l.level === 'warn').length, 1);
  } finally {
    await h.close();
  }
});

/* ---------------- Bona's own number: BONA_WA_INSTANCE_JID (2026-11-19, design §11) ---------------- */

test('BONA_WA_INSTANCE_JID set: the owner stays his own number, and a sent record whose alt is the Bona number names our sender', async () => {
  const BONA = '966576267694';
  const h = build({ env: { ...ENV, BONA_WA_INSTANCE: 'bona', BONA_WA_INSTANCE_JID: `${BONA}@s.whatsapp.net` } });
  try {
    const { app, db } = h;
    const owners = db.db.prepare("SELECT phone_e164 FROM users WHERE role = 'owner' AND active = 1").all().map((r) => r.phone_e164);
    assert.deepEqual(owners, ['966593296933'], 'seeded from BONA_OWNER_JID (its default here); the Bona number gets no account');
    db.insertLead({
      lead_id: 'LEAD-client', created: NOW - DAY, updated: NOW - DAY, phone_e164: '966500000077', wa_jid: '966500000077@s.whatsapp.net',
      channel: 'whatsapp', match_method: 'ref', stage: 'new', stage_ts: NOW - DAY, inbox_state: 'in', inbox_since: NOW - DAY,
    });
    const rec = (over) => ({
      id: 'X', jid: '966500000077@s.whatsapp.net', jidAlt: null, fromMe: true, ts: NOW - 1000, text: 'on my way', pushName: null,
      contextInfo: null, messageType: 'conversation', media: null, fileName: null, noise: false, ...over,
    });
    // Typed on the Bona phone: its own number as the alt names the sender; the owner becomes the handler.
    assert.deepEqual(await app.ingest.ingest(db.getLead('LEAD-client'), rec({ id: 'BONA-1', jidAlt: `${BONA}@s.whatsapp.net` })),
      { stored: true, inserted: true, senderKind: 'owner_number' });
    assert.equal(db.getLead('LEAD-client').handler_user_id, app.team.getUserByPhone('966593296933').user_id);
    // The owner's personal number is no longer our own: a sent record naming it is his chat, a team chat.
    assert.deepEqual(await app.ingest.ingest(db.getLead('LEAD-client'), rec({ id: 'OWN-2', jidAlt: '966593296933@s.whatsapp.net' })),
      { stored: false, reason: 'excluded' });
  } finally {
    await h.close();
  }
});

test('BONA_WA_INSTANCE_JID unset: a sent record whose alt is the owner\'s number names our sender, as before the split', async () => {
  const h = build({ env: ENV });
  try {
    const { app, db } = h;
    db.insertLead({
      lead_id: 'LEAD-client', created: NOW - DAY, updated: NOW - DAY, phone_e164: '966500000077', wa_jid: '966500000077@s.whatsapp.net',
      channel: 'whatsapp', match_method: 'ref', stage: 'new', stage_ts: NOW - DAY, inbox_state: 'in', inbox_since: NOW - DAY,
    });
    const rec = {
      id: 'OWN-1', jid: '966500000077@s.whatsapp.net', jidAlt: '966593296933@s.whatsapp.net', fromMe: true, ts: NOW - 1000, text: 'on my way',
      pushName: null, contextInfo: null, messageType: 'conversation', media: null, fileName: null, noise: false,
    };
    assert.deepEqual(await app.ingest.ingest(db.getLead('LEAD-client'), rec), { stored: true, inserted: true, senderKind: 'owner_number' });
    assert.ok(!h.logs.some((l) => l.evt === 'wa.instance_jid_invalid'));
  } finally {
    await h.close();
  }
});

test('a BONA_WA_INSTANCE_JID that is not a phone jid is said out loud at start-up (no value logged), the app still builds, and the owner\'s number stands in', async () => {
  for (const value of ['bona@s.whatsapp.net', '101010101010102@lid', '966576267694@g.us', 'bona']) {
    const h = build({ env: { ...ENV, BONA_WA_INSTANCE_JID: value } });
    try {
      const line = h.logs.find((l) => l.evt === 'wa.instance_jid_invalid');
      assert.ok(line && line.level === 'error', value);
      assert.doesNotMatch(JSON.stringify(line), /bona@|101010101010102|576267694|"bona"/);
      // As with the line unset: a sent record whose alt is the owner's number names our sender.
      const { app, db } = h;
      db.insertLead({
        lead_id: 'LEAD-client', created: NOW - DAY, updated: NOW - DAY, phone_e164: '966500000077', wa_jid: '966500000077@s.whatsapp.net',
        channel: 'whatsapp', match_method: 'ref', stage: 'new', stage_ts: NOW - DAY, inbox_state: 'in', inbox_since: NOW - DAY,
      });
      const rec = {
        id: 'OWN-1', jid: '966500000077@s.whatsapp.net', jidAlt: '966593296933@s.whatsapp.net', fromMe: true, ts: NOW - 1000, text: 'on my way',
        pushName: null, contextInfo: null, messageType: 'conversation', media: null, fileName: null, noise: false,
      };
      assert.deepEqual(await app.ingest.ingest(db.getLead('LEAD-client'), rec), { stored: true, inserted: true, senderKind: 'owner_number' }, value);
    } finally {
      await h.close();
    }
  }
  for (const value of ['966576267694@s.whatsapp.net', '966576267694', '966576267694:12@s.whatsapp.net']) {
    const h = build({ env: { ...ENV, BONA_WA_INSTANCE_JID: value } });
    try {
      assert.ok(!h.logs.some((l) => l.evt === 'wa.instance_jid_invalid'), value);
    } finally {
      await h.close();
    }
  }
});

/* ================================================================================================
 * PR-INT (PLAN T14): the real modules wired together. Every case below goes through createApp as
 * the server builds it; only the outside world is fake (Evolution, OpenAI, Google, Retell, the
 * push service). Numbers are examples (+966 50 000 00xx).
 * ============================================================================================== */

const T14 = Date.parse('2026-12-03T12:00:00+03:00'); // a Thursday, noon in Riyadh
const OWNER14 = '966500000009';
const BONA14 = '966500000010';
const ENV14 = {
  EVOLUTION_API_URL: 'http://evo.test/', EVOLUTION_API_KEY: 'k', BONA_WA_INSTANCE: 'bona-test',
  BONA_OWNER_JID: `${OWNER14}@s.whatsapp.net`, BONA_WA_INSTANCE_JID: `${BONA14}@s.whatsapp.net`,
};
const BRAIN_KEY = 'sk-test-not-a-real-key-000000000000';
const QUICK_PACING = { batchDelay: () => 0, typingFloorMs: () => 0, fifo: (fn) => fn() };
const jidOf = (digits) => `${digits}@s.whatsapp.net`;
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The identity guard as an answered probe would leave it (lib/wa-link.mjs): Bona's own number, proven. */
function provenLink({ identity = true } = {}) {
  return {
    started: 0, stopped: 0,
    identityOk: () => identity, linkOk: () => true, linkStable: () => true,
    start() { this.started += 1; return true; }, stop() { this.stopped += 1; },
    health: () => ({ identityOk: identity, linkOk: true }),
  };
}

/** A Retell double for the legacy WhatsApp agent: one canned answer. */
function legacyRetell() {
  const calls = [];
  return {
    calls,
    async createChat(body) { calls.push(['createChat', body]); return { chat_id: `chat_${calls.length}` }; },
    async createChatCompletion(body) { calls.push(['createChatCompletion', body]); return { messages: [{ role: 'agent', content: 'Retell here: which district?' }] }; },
    async endChat() { return null; },
    async createWebCall() { return { call_id: 'call_1', access_token: 'tok' }; },
  };
}

/** A key file in a temp HOME, read by the real brain (lib/brain.mjs) and nowhere else. */
function brainHome(root) {
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.secrets'), { recursive: true });
  fs.writeFileSync(path.join(home, '.secrets', 'bona-brain.env'), `BONA_OPENAI_API_KEY=${BRAIN_KEY}\n`, { mode: 0o600 });
  return home;
}

/**
 * createApp with the real modules, a moving clock, and one fake fetch for everything outside:
 * Evolution (sends recorded; the poller's window reads served from `evo.windows`), OpenAI (served from
 * `openai`, a queue of responses or functions), Google (a small calendar double) and the rest (200 {}).
 */
function rig14({ env = {}, config = {}, openai = [], google = null, realBrain = false, ...options } = {}) {
  let t = options.startAt ?? T14;
  const db = options.db ?? openDb(':memory:');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-t14-'));
  const logs = [];
  const evo = { sends: [], windows: [], other: [] };
  const ai = { calls: [], queue: [...openai] };
  const gq = { calls: [], events: new Map() };
  const seen = [];
  const evoState = { down: Boolean(options.evoDown), idDown: false, number: BONA14 };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    seen.push({ method: init.method ?? 'GET', url: u });
    if (u.startsWith('https://api.openai.com/')) {
      ai.calls.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
      const next = ai.queue.length ? ai.queue.shift() : { status: 200, json: { choices: [{ message: { role: 'assistant', content: 'Default answer.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } } };
      const r = typeof next === 'function' ? await next(init) : next;
      return reply(r.status, r.json);
    }
    if (u.startsWith('https://oauth2.googleapis.com/') || u.startsWith('https://www.googleapis.com/')) {
      gq.calls.push({ method: init.method ?? 'GET', url: u, body: init.body ?? null });
      if (u.startsWith('https://oauth2.googleapis.com/token')) return reply(200, { access_token: 'gtok', expires_in: 3600, token_type: 'Bearer' });
      if (google) {
        const got = await google({ method: init.method ?? 'GET', url: new URL(u), body: init.body ? JSON.parse(init.body) : null, events: gq.events });
        if (got) return reply(got.status, got.json);
      }
      return reply(404, { error: { code: 404 } });
    }
    if (u.startsWith('http://evo.test/')) {
      if (u.includes('/message/sendText/') || u.includes('/message/sendMedia/')) {
        evo.sends.push({ url: u, body: JSON.parse(init.body), at: t });
        return reply(201, { key: { id: `KEY-${evo.sends.length}` } });
      }
      if (u.includes('/instance/fetchInstances') || u.includes('/chat/whatsappNumbers/')) {
        if (evoState.down || (evoState.idDown && u.includes('/instance/fetchInstances'))) return reply(503, {});
        if (u.includes('/instance/fetchInstances') && evoState.answers?.length) {
          const a = evoState.answers.shift();
          await a.wait;
          return reply(200, [{ name: 'bona-test', ownerJid: jidOf(a.number), connectionStatus: 'open' }]);
        }
        if (u.includes('/instance/fetchInstances')) return reply(200, [{ name: 'bona-test', ownerJid: jidOf(evoState.number), connectionStatus: 'open' }]);
        return reply(200, [{ number: BONA14, exists: true }]);
      }
      if (u.includes('/chat/findMessages/')) {
        const body = JSON.parse(init.body);
        const records = body.where?.messageTimestamp && evo.windows.length ? evo.windows.shift() : [];
        return reply(200, { messages: { total: records.length, pages: 1, currentPage: 1, records } });
      }
      evo.other.push(u);
      return reply(200, {});
    }
    throw new Error(`no network in tests: ${u.slice(0, 40)}`);
  };
  const cfgEnv = { ...ENV14, ...env, ...(realBrain ? { HOME: brainHome(root) } : {}) };
  const retell = options.retell ?? legacyRetell();
  const app = createApp({
    config: {
      port: 0, host: '127.0.0.1', siteUrl: 'https://bona.azoz.uk', publicApi: 'https://bona-api.azoz.uk',
      dataDir: root, inventoryFile: WORKTREE_LISTINGS, origins: DEFAULT_ORIGINS, toolToken: 'a'.repeat(32),
      retellApiKey: 'test', retellMock: false, chatAgentId: 'agent_chat', voiceAgentId: 'agent_voice', waChatAgentId: 'agent_wa',
      maxBodyBytes: 16 * 1024, chatRatePerMin: 30, tokenRatePerMin: 6, toolRatePerMin: 600, toolAuthFailRatePerMin: 10,
      allowQueryToken: false, maxChatsPerDay: 300, maxCallsPerDay: 60, maxTurnsPerSession: 40, dashCookieDays: 30,
      ids: {}, version: '1.0.0', trustedProxies: [], waPoll: true, waPollMs: 20_000,
      ...config, env: cfgEnv,
    },
    db, inventory, probeRetell: async () => 'ok', retell, fetchImpl, now: () => t, log: (e) => logs.push(e),
    pacing: QUICK_PACING, danaBatchMs: 0,
    ...(realBrain ? {} : { brain: options.brain ?? createFakeBrain({ turns: options.turns ?? [] }) }),
    ...(options.waLink === null ? {} : { waLink: options.waLink ?? provenLink() }),
    ...Object.fromEntries(Object.entries(options).filter(([k]) => !['startAt', 'db', 'retell', 'brain', 'turns', 'waLink', 'evoDown'].includes(k))),
  });
  const rec = (digits, id, text, { fromMe = false, at = t - 5_000 } = {}) => ({
    key: { id, fromMe, remoteJid: jidOf(digits) }, pushName: fromMe ? null : 'Example', messageType: 'conversation',
    message: { conversation: text }, messageTimestamp: Math.floor(at / 1000),
  });
  const h = {
    app, db, logs, evo, ai, gq, retell, root, seen, evoState,
    get now() { return t; },
    advance(ms) { t += ms; },
    set(ms) { t = ms; },
    /** One poller read that serves these records, then Dana's runs and the pushes, landed. */
    async poll(...records) {
      evo.windows.push(records);
      const tally = await app.poller.tick();
      await app.dana.flush();
      await app.alerts.flush();
      return tally;
    },
    rec,
    sendsTo: (digits) => evo.sends.filter((s) => s.body.number === digits),
    notes: (where = '1 = 1') => db.db.prepare(`SELECT kind, dedupe_key, status, lead_id, meta FROM owner_notes WHERE ${where} ORDER BY created, rowid`).all()
      .map((r) => ({ ...r, meta: JSON.parse(r.meta ?? '{}') })),
    seedLead(id, digits, over = {}) {
      db.insertLead({
        lead_id: id, created: t - DAY, updated: t - DAY, phone_e164: digits, wa_jid: jidOf(digits), channel: 'whatsapp',
        match_method: 'ref', stage: 'new', stage_ts: t - DAY, inbox_state: 'in', inbox_since: t - DAY, ...over,
      });
      return db.getLead(id);
    },
    async close() {
      app.stopTimers?.();
      app.notes.stop?.();
      await app.dana.stop();
      await app.alerts.flush();
      await app.dashboard.auth.flush();
      if (!options.db) db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  return h;
}

test('T14 wiring: the team gets the owner test, so his own number is a client\'s chat only while his test is on', async () => {
  const h = rig14();
  try {
    const { app, db } = h;
    const lead = h.seedLead('LEAD-20261203-own00001', OWNER14, { inbox_via: 'owner_test', match_method: 'owner_test' });
    assert.equal(app.ownerTest.active(), false);
    assert.equal(app.team.isExcludedPhone(OWNER14), true, 'test off: the owner is a colleague, as today');
    assert.equal(isExcludedLead(app.team, db, lead), true);
    app.team.setSetting('owner_as_client', '1');
    assert.equal(app.ownerTest.active(), true);
    assert.equal(app.team.isExcludedPhone(OWNER14), false, 'test on: his number is the test client (DESIGN §3.2)');
    assert.equal(isExcludedLead(app.team, db, lead), false);
    app.team.addUser({ name: 'Sara', phone: '0500000001', role: 'staff' });
    assert.equal(app.team.isExcludedPhone('966500000001'), true, 'every other colleague stays excluded');
  } finally {
    await h.close();
  }
});

test('T14 wiring: the brain\'s own alerts reach notes.alert exactly as the brain sent them (brain_out quota/auth, brain_spend 80, 100, day and month stop, brain_bug); quota/auth push the owners with reason brain', async () => {
  const QUOTA = { status: 429, json: { error: { type: 'insufficient_quota', code: 'insufficient_quota' } } };
  const AUTH = { status: 401, json: { error: { type: 'invalid_request_error', code: 'invalid_api_key' } } };
  const BAD = { status: 200, json: { choices: [] } };
  const USAGE = { prompt_tokens: 10_000, prompt_tokens_details: { cached_tokens: 8_000 }, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 100 } };
  const OK = { status: 200, json: { choices: [{ message: { role: 'assistant', content: 'Which district do you like?' }, finish_reason: 'stop' }], usage: USAGE } };
  const turnArgs = (leadId) => ({
    route: 'wa', leadId, language: 'en', autoMode: true, history: [], batchText: 'Hi', leadFacts: {}, turnContext: { firstReply: true },
    toolNames: ['search_properties', 'request_human'], earlierReplies: [],
  });
  /** The real brain in use (dana_brain '1'), with a spy on the sink: what notes.alert receives, and what is pushed. */
  const wired = (o) => {
    const h = rig14({ realBrain: true, ...o });
    h.app.team.setSetting('dana_brain', '1');
    const sink = [];
    const pushed = [];
    const alert = h.app.notes.alert;
    h.app.notes.alert = (code, meta) => { sink.push([code, structuredClone(meta)]); return alert(code, meta); };
    const owners = h.app.alerts.notifyOwners;
    h.app.alerts.notifyOwners = (x) => { pushed.push(x?.reason ?? null); return owners(x); };
    return { h, sink, pushed };
  };
  for (const [res, code] of [[QUOTA, 'quota'], [AUTH, 'auth']]) {
    const { h, sink, pushed } = wired({ openai: [res, res, res] });
    try {
      assert.equal(h.app.brain.configured, true, 'the real brain, on the temp key');
      assert.deepEqual(await h.app.brain.turn(turnArgs('LEAD-20261203-brain001')), { ok: false, code });
      assert.deepEqual(sink, [['brain_out', { code }]], `${code}: the brain's payload, unchanged`);
      assert.equal(h.notes("kind = 'alert'").filter((r) => r.meta.alert === 'brain_out').length, 1);
      await h.app.alerts.flush();
      assert.deepEqual(pushed, ['brain'], `${code}: the owners' phones hear of it as reason brain`);
    } finally {
      await h.close();
    }
  }
  // Spend: one response costs $0.0192 (lib/brain/prices.mjs); a $0.022 month alert is crossed at 80% by the first, 100% by the second.
  {
    const { h, sink, pushed } = wired({ openai: [OK, OK], config: { brainMonthAlertUsd: 0.022, brainDayStopUsd: 1000, brainMonthStopUsd: 1000 } });
    try {
      assert.equal((await h.app.brain.turn(turnArgs('LEAD-20261203-brain002'))).ok, true);
      assert.equal((await h.app.brain.turn(turnArgs('LEAD-20261203-brain004'))).ok, true);
      assert.deepEqual(sink, [['brain_spend', { level: 80 }], ['brain_spend', { level: 100 }]]);
      assert.deepEqual(h.notes("kind = 'alert'").map((r) => r.meta.level), ['80', '100']);
      assert.deepEqual(pushed, [], 'a spend alert is a note, not a push');
    } finally {
      await h.close();
    }
  }
  for (const [config, stop] of [[{ brainDayStopUsd: 0.001, brainMonthStopUsd: 1000 }, 'day'], [{ brainDayStopUsd: 1000, brainMonthStopUsd: 0.001 }, 'month']]) {
    const { h, sink } = wired({ openai: [OK], config: { brainMonthAlertUsd: 1000, ...config } });
    try {
      assert.deepEqual(await h.app.brain.turn(turnArgs('LEAD-20261203-brain003')), { ok: false, code: 'budget' });
      assert.deepEqual(sink, [['brain_spend', { level: 'stop', stop }]], `the ${stop} stop, meta.stop included`);
      assert.match(h.notes("kind = 'alert'")[0].dedupe_key, /^al:brain_spend:stop:\d+$/);
    } finally {
      await h.close();
    }
  }
  {
    const { h, sink } = wired({ openai: Array(12).fill(BAD), config: { brainBackupMode: 'off' } });
    try {
      for (let i = 0; i < 4; i += 1) {
        assert.equal((await h.app.brain.turn(turnArgs(`LEAD-20261203-brainb0${i}`))).code, 'bad_response');
        h.advance(1_000);
      }
      assert.deepEqual(sink, [['brain_bug', {}]], 'one brain_bug alert');
    } finally {
      await h.close();
    }
  }
});

test('T14 wiring: the brain\'s alerts are journal lines only while the brain is not in use: a staged key answering the probe 401 queues no note and pushes nobody', async () => {
  const AUTH = { status: 401, json: { error: { code: 'invalid_api_key' } } };
  const quiet = rig14({ realBrain: true, openai: [AUTH] });
  try {
    const pushed = [];
    const owners = quiet.app.alerts.notifyOwners;
    quiet.app.alerts.notifyOwners = (x) => { pushed.push(x?.reason); return owners(x); };
    await quiet.app.ticks.brainProbe();
    assert.ok(quiet.ai.calls.some((c) => c.url.endsWith('/v1/models')), 'the probe tick asked GET /v1/models');
    assert.deepEqual(quiet.notes(), [], 'no owner note');
    await quiet.app.alerts.flush();
    assert.deepEqual(pushed, [], 'no push');
    assert.ok(quiet.logs.some((l) => l.evt === 'brain.alert_quiet' && l.code === 'brain_out' && l.why === 'auth'));
    assert.equal(quiet.app.brain.health().ok, false, 'the brain itself still knows it is out');
  } finally {
    await quiet.close();
  }
  const used = rig14({ realBrain: true, openai: [AUTH] });
  try {
    used.app.team.setSetting('dana_brain', '1');
    const pushed = [];
    const owners = used.app.alerts.notifyOwners;
    used.app.alerts.notifyOwners = (x) => { pushed.push(x?.reason); return owners(x); };
    await used.app.ticks.brainProbe();
    assert.equal(used.notes("kind = 'alert'").filter((r) => r.meta.alert === 'brain_out').length, 1, 'in use: the note');
    await used.app.alerts.flush();
    assert.deepEqual(pushed, ['brain']);
  } finally {
    await used.close();
  }
  const none = rig14({ turns: [] });
  try {
    await none.app.ticks.brainProbe();
    assert.equal(none.ai.calls.length, 0, 'no key, no probe');
  } finally {
    await none.close();
  }
});

test('T14 wiring: the brain runs its tools in-process (runTool → tools.runInProcess), the tools get the wired viewing, and the viewing the shared inventory', async () => {
  const listing = inventory.all().find((l) => l.slug && l.status === 'available' && l.location?.city?.en === 'Jeddah');
  assert.ok(listing, 'a bookable Jeddah home in listings.json');
  const toolCall = (name, args) => ({
    status: 200,
    json: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  });
  const done = { status: 200, json: { choices: [{ message: { role: 'assistant', content: 'Let me check that for you.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } } };
  const h = rig14({
    realBrain: true,
    openai: [toolCall('book_viewing', { listing_id: listing.id, slot_id: 'not-a-slot', name: 'Example Client' }), done],
    config: { gcalSaFile: '/nonexistent/example-sa.json', gcalCalendarId: 'test-calendar@example.com' },
  });
  try {
    const { app } = h;
    app.team.setSetting('calendar_booking', '1');
    const lead = h.seedLead('LEAD-20261203-tool0001', '966500000031', { inbox_via: 'own_number', match_method: 'own_number' });
    assert.equal(app.ownerTest.autoMode(lead), true, 'an own-number chat on a proven instance is in auto mode');
    const out = await app.brain.turn({
      route: 'wa', leadId: lead.lead_id, language: 'en', autoMode: true, history: [], batchText: 'Can I see it tomorrow?', leadFacts: {},
      turnContext: { firstReply: false }, toolNames: ['book_viewing', 'request_human'], earlierReplies: [],
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    const call = out.toolCalls.find((c) => c.name === 'book_viewing');
    assert.ok(call, 'the model\'s book_viewing ran');
    const result = JSON.parse(call.result);
    assert.notEqual(result.reason, 'not_in_process', 'in-process, not the HTTP route\'s refusal');
    assert.notEqual(result.reason, 'off', 'the tools reached the wired viewing module (booking on, a calendar set)');
    assert.notEqual(result.reason, 'listing', 'the viewing module reads the shared inventory');
    assert.equal(result.reason, 'slot', 'it went as far as the slot id: viewing.validate, which writes nothing');
    assert.equal(h.db.db.prepare('SELECT COUNT(*) AS n FROM viewing_bookings').get().n, 0);
    // The HTTP route still refuses the WhatsApp tools.
    const http = JSON.parse(await app.tools.run('book_viewing', { args: { listing_id: listing.id, slot_id: 'x' }, chat: { metadata: { source: 'bona-whatsapp', lead_id: lead.lead_id } } }));
    assert.equal(http.reason, 'not_in_process');
  } finally {
    await h.close();
  }
});

test('T14 wiring: the tools get the notes and the fetch, Dana gets the link and the wa config, the push policy the owner test', async () => {
  const h = rig14({ waLink: provenLink({ identity: false }) });
  try {
    const { app } = h;
    app.team.setSetting('dana_enabled', '1');
    // The identity guard (DESIGN §5.3): Bona's own number, not proven → Dana answers nobody, the legacy chat included.
    const lead = h.seedLead('LEAD-20261203-dana0001', '966500000032');
    assert.deepEqual(app.dana.eligible(lead.lead_id, { ts: h.now - 5_000 }).reason, 'identity');
    // create_lead's note goes through the notes ledger (a concierge lead: due at once), so a merge sends none.
    const before = h.notes().length;
    await app.tools.run('create_lead', { args: { name: 'Example Buyer', phone: '0500000033' }, chat: { chat_id: 'c1', metadata: { source: 'bona-web' } } });
    await app.tools.run('create_lead', { args: { name: 'Example Buyer', phone: '0500000033', budget: '2 million' }, chat: { chat_id: 'c2', metadata: { source: 'bona-web' } } });
    const rows = h.notes("kind = 'new_client'").slice(before);
    assert.equal(rows.length, 1, 'one new-client note row for the created lead, none for the merge');
    // The push policy reads the owner test: a chat in auto mode the assistant will answer pushes nobody's phone.
    assert.equal(typeof app.pushPolicy.onClientMessage, 'function');
  } finally {
    await h.close();
  }
  const h2 = rig14();
  try {
    // The tools' fetch is the app's: send_brochure's HEAD (auto mode, Bona's own site only) goes through it.
    const withBrochure = inventory.all().find((l) => typeof l.brochureUrl === 'string' && l.brochureUrl.trim() && !['BONA-W011', 'BONA-W018', 'BONA-W024'].includes(l.id));
    assert.ok(withBrochure, 'a listing with a brochure');
    {
      const auto = h2.seedLead('LEAD-20261203-broc0001', '966500000035', { inbox_via: 'own_number', match_method: 'own_number', dana_introduced: 1 });
      const r = JSON.parse(await h2.app.tools.runInProcess('send_brochure', { args: { listing_id: withBrochure.id }, chat: { chat_id: 'w1', metadata: { source: 'bona-whatsapp', lead_id: auto.lead_id } } }));
      assert.ok(h2.seen.some((c) => c.method === 'HEAD'), `the HEAD went through the app's fetch: ${JSON.stringify(r)}`);
    }
  } finally {
    await h2.close();
  }
});

test('T14 timers: startTimers puts every worker on its clock (notes 5 s, summary 1 min, sweep 1 min, viewing 5 min, brain probe 15 min, link probe, daily upkeep) and stopTimers takes them off', async () => {
  const link = provenLink();
  const h = rig14({ waLink: link });
  try {
    const { app } = h;
    const timers = [];
    const started = app.startTimers({ every: (ms, fn) => { const id = { ms, fn, cleared: false }; timers.push(id); return id; }, clear: (id) => { id.cleared = true; } });
    const by = Object.fromEntries(started.map((s) => [s.name, s.ms]));
    assert.deepEqual(by, { notes: 5_000, summary: 60_000, sweep: 60_000, viewing: 300_000, brainProbe: 900_000, upkeep: 86_400_000, identity: 30_000 });
    assert.equal(link.started, 1, 'the link probe starts (its own 10-min loop)');
    for (const tm of timers) await tm.fn(); // each tick never throws
    assert.equal(app.startTimers({ every: () => ({}), clear: () => {} }).length, 0, 'a second start starts nothing');
    app.stopTimers();
    assert.ok(timers.every((tm) => tm.cleared), 'every interval cleared');
    assert.equal(link.stopped, 1);
  } finally {
    await h.close();
  }
});

test('T14 timers: the 1-minute sweep re-wakes a chat whose hold ended', async () => {
  const h = rig14({ turns: [brainReply('Thanks for waiting. Which district do you like?')] });
  try {
    const { app, db } = h;
    app.team.setSetting('dana_enabled', '1');
    const lead = h.seedLead('LEAD-20261203-swp00001', '966500000034', { inbox_via: 'own_number', match_method: 'own_number' });
    await app.ingest.ingest(lead, { id: 'SW-1', jid: jidOf('966500000034'), jidAlt: null, fromMe: false, ts: h.now - 15 * 60_000, text: 'Hello?', pushName: null, contextInfo: null, messageType: 'conversation', media: null, fileName: null, noise: false });
    db.updateLead(lead.lead_id, { dana_hold_reason: 'cap_chat', dana_hold_until: h.now - 1 });
    const timers = [];
    const started = app.startTimers({ every: (ms, fn) => { const id = { ms, fn }; timers.push(id); return id; }, clear: () => {} });
    const sweep = timers[started.findIndex((s) => s.name === 'sweep')];
    assert.equal(h.sendsTo('966500000034').length, 0);
    await sweep.fn();
    await app.dana.flush();
    assert.equal(h.sendsTo('966500000034').length, 1, 'woken by the sweep, answered once');
  } finally {
    await h.close();
  }
});

/* ---------------- PLAN T14 test 3: the in-process end to end ---------------- */

const danaOnly = (sends) => sends.filter((s) => !String(s.body.text ?? '').startsWith('*Bona'));
const noteSends = (sends) => sends.filter((s) => String(s.body.text ?? '').startsWith('*Bona'));

test('T14 e2e: the owner\'s test lead is answered by the brain; a legacy lead (dana_brain 0) by the Retell agent, as today', async () => {
  const h = rig14({ turns: [brainReply('Hello! Which area of Jeddah do you like?')] });
  try {
    const { app } = h;
    app.team.setSetting('dana_enabled', '1');
    app.team.setSetting('owner_as_client', '1');
    await h.poll(h.rec(OWNER14, 'O-1', 'Hi, I am looking for a villa'));
    const ownerLead = h.db.listLeads({ limit: 10 }).find((l) => l.phone_e164 === OWNER14);
    assert.ok(ownerLead, 'his test chat joined');
    assert.equal(ownerLead.inbox_via, 'owner_test');
    const toOwner = danaOnly(h.sendsTo(OWNER14));
    assert.equal(toOwner.length, 1, 'one answer to his test chat');
    assert.match(toOwner[0].body.text, /Which area of Jeddah/);
    assert.equal(app.brain.calls.length, 1, 'the brain answered');
    assert.equal(h.retell.calls.filter(([n]) => n === 'createChatCompletion').length, 0, 'Retell never saw the test chat');

    const legacy = h.seedLead('LEAD-20261203-lgcy0001', '966500000041');
    await h.poll(h.rec('966500000041', 'C-1', 'is it still available?'));
    const toClient = h.sendsTo('966500000041');
    assert.equal(toClient.length, 1);
    assert.match(toClient[0].body.text, /Retell here: which district\?/, 'the legacy chat on today\'s Retell agent');
    assert.match(toClient[0].body.text, /^Dana — /, 'with today\'s legacy wording');
    assert.equal(app.brain.calls.length, 1, 'a legacy chat never reaches the brain');
    assert.equal(h.db.getLead(legacy.lead_id).dana_introduced, 1);
  } finally {
    await h.close();
  }
});

test('T14 e2e: the outage case: 429 then quota → one holding line, a brain_out note, no second line in the chat; recovery answers the next message', async () => {
  const h = rig14({ turns: [brainError('rate'), brainError('quota'), brainReply('We are back: which district do you like?')] });
  try {
    const { app } = h;
    app.team.setSetting('dana_enabled', '1');
    const lead = h.seedLead('LEAD-20261203-out00001', '966500000042', { inbox_via: 'own_number', match_method: 'own_number' });
    const order = [];
    const { alert, handover } = app.notes;
    app.notes.alert = (code, meta) => { order.push(['alert', code, { ...meta }]); return alert(code, meta); };
    app.notes.handover = (l, o) => { order.push(['handover', o?.kind]); return handover(l, o); };
    await h.poll(h.rec('966500000042', 'C-1', 'Hello, is the villa available?'));
    assert.deepEqual(order, [['alert', 'brain_out', { code: 'rate' }], ['handover', 'brain']], 'the alert with the turn\'s exact code, BEFORE the hand-over (T12 note)');
    assert.equal(app.brain.calls.length, 1, 'the 429 (rate) turn');
    assert.equal(danaOnly(h.sendsTo('966500000042')).length, 1, 'one holding line');
    assert.equal(h.db.getLead(lead.lead_id).dana_hold_reason, 'brain_out');
    // The 1-minute sweep: nothing before the 10-minute hold ends; then the retry meets the quota: the hold extends, no line.
    h.advance(61_000);
    await app.ticks.sweep();
    await app.dana.flush();
    assert.equal(app.brain.calls.length, 1, 'no retry inside the hold');
    h.advance(10 * 60_000);
    await app.ticks.sweep();
    await app.dana.flush();
    assert.equal(app.brain.calls.length, 2, 'the sweep retried once the hold ended (quota)');
    const held = danaOnly(h.sendsTo('966500000042'));
    assert.equal(held.length, 1, `still one holding line: ${JSON.stringify(held.map((s) => s.body.text))}`);
    assert.doesNotMatch(held[0].body.text, /We are back/);
    const out = h.notes("kind = 'alert'").filter((r) => r.meta.alert === 'brain_out');
    assert.equal(out.length, 1, 'one brain_out note');
    assert.equal(out[0].meta.code, 'down', 'the ledger keeps rate as down (owner-notes brainCode)');
    assert.equal(order.filter(([k]) => k === 'alert').length, 1, 'the retry that met the quota raised no second alert (same outage)');

    h.advance(30_000);
    await h.poll(h.rec('966500000042', 'C-2', 'Hello??', { at: h.now - 1_000 }));
    assert.equal(danaOnly(h.sendsTo('966500000042')).length, 1, 'no second line in the same chat');

    h.advance(11 * 60_000);
    await app.ticks.sweep();
    await app.dana.flush();
    const after = danaOnly(h.sendsTo('966500000042'));
    assert.equal(after.length, 2, 'recovery: the waiting message is answered');
    assert.match(after[1].body.text, /We are back/);
    assert.equal(h.notes("kind = 'alert'").filter((r) => r.meta.alert === 'brain_out').length, 1, 'still one outage note');
  } finally {
    await h.close();
  }
});

test('T14 e2e: with own_inbox on, a stranger\'s "Hi" joins, is answered, and a new_client note is queued, then goes through the one sender as kind note', async () => {
  const h = rig14({ turns: [brainReply('Hello! How can I help you find a home?')] });
  try {
    const { app } = h;
    app.team.setSetting('dana_enabled', '1');
    app.team.setSetting('own_inbox', '1');
    await h.poll(h.rec('966500000043', 'C-1', 'Hi'));
    const lead = h.db.listLeads({ limit: 10 }).find((l) => l.phone_e164 === '966500000043');
    assert.ok(lead, 'the stranger joined');
    assert.equal(lead.inbox_via, 'own_number');
    assert.equal(danaOnly(h.sendsTo('966500000043')).length, 1, 'answered');
    const queued = h.notes("kind = 'new_client'");
    assert.equal(queued.length, 1);
    assert.equal(queued[0].lead_id, lead.lead_id);
    h.advance(25_000);
    await app.notes.tick();
    const notes = noteSends(h.sendsTo(OWNER14));
    assert.equal(notes.length, 1, 'the note went to the owner');
    assert.match(notes[0].body.text, /^\*Bona — new enquiry\*/);
    assert.equal(h.notes("kind = 'new_client'")[0].status, 'sent');
    const row = h.db.db.prepare("SELECT * FROM wa_outbox WHERE sender_kind = 'note'").get();
    assert.ok(row, 'an outbox row of kind note');
    assert.equal(row.text, null, 'without its text');
    assert.equal(row.lead_id, null);
    assert.equal(row.jid, jidOf(OWNER14));
  } finally {
    await h.close();
  }
});

test('T14 e2e: a booking → a calendar event, the confirmation to the client and a booking note', async () => {
  const listing = inventory.all().find((l) => l.slug && l.status === 'available' && l.location?.city?.en === 'Jeddah');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const saDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-t14-sa-'));
  const saFile = path.join(saDir, 'sa.json');
  fs.writeFileSync(saFile, JSON.stringify({ type: 'service_account', client_email: 'robot@example.iam.gserviceaccount.com', private_key: privateKey }), { mode: 0o600 });
  const google = ({ method, url, body, events }) => {
    const p = url.pathname;
    if (p.endsWith('/freeBusy')) return { status: 200, json: { calendars: Object.fromEntries(body.items.map((i) => [i.id, { busy: [] }])) } };
    if (method === 'GET' && p.endsWith('/events') && url.searchParams.get('fields') === 'accessRole') return { status: 200, json: { accessRole: 'writer' } };
    if (method === 'GET' && p.endsWith('/events')) return { status: 200, json: { items: [] } };
    if (method === 'POST' && p.endsWith('/events')) { const ev = { ...body, status: 'confirmed' }; events.set(body.id, ev); return { status: 200, json: ev }; }
    const m = /\/events\/([^/]+)$/.exec(p);
    if (m && method === 'GET') { const ev = events.get(m[1]); return ev ? { status: 200, json: ev } : { status: 404, json: {} }; }
    return null;
  };
  let slot = null;
  const h = rig14({
    google,
    config: { gcalSaFile: saFile, gcalCalendarId: 'test-calendar@example.com' },
    turns: [() => brainReply('Booked for you.', { tools: [{ name: 'book_viewing', args: { listing_id: listing.id, slot_id: slot, name: 'Example Client' }, result: { reserved: true, slot_id: slot, listing_id: listing.id } }] })],
  });
  try {
    const { app, db } = h;
    app.team.setSetting('dana_enabled', '1');
    app.team.setSetting('calendar_booking', '1');
    const lead = h.seedLead('LEAD-20261203-book0001', '966500000044', { inbox_via: 'own_number', match_method: 'own_number', name: 'Example Client' });
    const offered = await app.viewing.slots({ leadId: lead.lead_id, listingId: listing.id });
    assert.equal(offered.bookable, true, JSON.stringify(offered));
    slot = offered.slots[0].slot_id;
    await h.poll(h.rec('966500000044', 'C-1', `Can I see ${listing.id} on the first slot?`));
    const inserted = h.gq.calls.filter((c) => c.method === 'POST' && /\/calendars\/[^/]+\/events/.test(c.url));
    assert.equal(inserted.length, 1, 'one event in the calendar');
    const booking = db.db.prepare('SELECT * FROM viewing_bookings').get();
    assert.equal(booking.status, 'booked');
    assert.equal(booking.client_told, 1, 'the confirmation reached the client');
    const toClient = danaOnly(h.sendsTo('966500000044'));
    assert.ok(toClient.length >= 1);
    assert.doesNotMatch(toClient.map((s) => s.body.text).join('\n'), /Booked for you\./, 'the code-built confirmation, not the model\'s words');
    assert.equal(h.notes("kind = 'booking'").length, 1, 'a booking note');
  } finally {
    await h.close();
    fs.rmSync(saDir, { recursive: true, force: true });
  }
});

test('T14 e2e: a hand-over → the chat flagged and a hand-over note queued', async () => {
  const h = rig14({ turns: [brainReply('A colleague will take this over shortly.', { tools: [{ name: 'request_human', args: { kind: 'offer' }, result: { ok: true, kind: 'offer' } }] })] });
  try {
    const { app } = h;
    app.team.setSetting('dana_enabled', '1');
    const lead = h.seedLead('LEAD-20261203-hand0001', '966500000045', { inbox_via: 'own_number', match_method: 'own_number' });
    await h.poll(h.rec('966500000045', 'C-1', 'I want to make an offer on the villa'));
    assert.equal(h.db.getLead(lead.lead_id).needs_human, 1, 'the chat waits for a person');
    const ho = h.notes("kind = 'handover'");
    assert.equal(ho.length, 1, 'one hand-over note');
    assert.equal(ho[0].lead_id, lead.lead_id);
  } finally {
    await h.close();
  }
});

test('T14 e2e: a staff reply from Bona\'s phone → the assistant stays out (human_recent)', async () => {
  const h = rig14({ turns: [brainReply('Should never be sent.')] });
  try {
    const { app } = h;
    app.team.setSetting('dana_enabled', '1');
    const lead = h.seedLead('LEAD-20261203-staf0001', '966500000046', { inbox_via: 'own_number', match_method: 'own_number' });
    await h.poll(h.rec('966500000046', 'S-1', 'Hello, this is Sara from Bona', { fromMe: true, at: h.now - 60_000 }));
    h.advance(10_000);
    await h.poll(h.rec('966500000046', 'C-1', 'Thanks Sara', { at: h.now - 1_000 }));
    assert.equal(danaOnly(h.sendsTo('966500000046')).length, 0);
    assert.equal(app.brain.calls.length, 0);
    assert.ok(h.logs.some((l) => l.evt === 'dana.skipped' && l.leadId === lead.lead_id && l.reason === 'human_recent'), 'skipped: human_recent');
  } finally {
    await h.close();
  }
});

test('T14 e2e: `#dana test on` / `#dana test off` from the owner → the switch and its lifecycle, each with a reply note', async () => {
  const h = rig14({ turns: [brainReply('Hello! What are you looking for?')] });
  try {
    const { app, db } = h;
    app.team.setSetting('dana_enabled', '1');
    await h.poll(h.rec(OWNER14, 'CMD-1', '#dana test on'));
    assert.equal(app.team.getSetting('owner_as_client'), '1', 'applied');
    assert.equal(h.notes("kind = 'command'").length, 1, 'a reply note');
    h.advance(30_000);
    await h.poll(h.rec(OWNER14, 'O-1', 'Hi, a test question', { at: h.now - 1_000 }));
    const ownerLead = db.listLeads({ limit: 10 }).find((l) => l.phone_e164 === OWNER14);
    assert.equal(ownerLead?.inbox_state, 'in', 'his test chat is in');
    assert.equal(danaOnly(h.sendsTo(OWNER14)).length, 1, 'and answered');
    // His reply note goes to his own chat through the one sender; its echo, read back, is refused by key (never a message).
    h.advance(30_000);
    await app.notes.tick();
    const note = noteSends(h.sendsTo(OWNER14)).at(-1);
    assert.ok(note, 'the command reply note went');
    const keyId = `KEY-${h.evo.sends.indexOf(note) + 1}`;
    await h.poll({ key: { id: keyId, fromMe: true, remoteJid: jidOf(OWNER14) }, pushName: null, messageType: 'conversation', message: { conversation: note.body.text }, messageTimestamp: Math.floor((h.now - 1_000) / 1000) });
    assert.ok(!app.inboxStore.messagesFor(ownerLead.lead_id).some((m) => m.key_id === keyId), 'the note\'s echo is never stored in his test chat');
    h.advance(30_000);
    await h.poll(h.rec(OWNER14, 'CMD-2', '#dana test off', { at: h.now - 1_000 }));
    assert.equal(app.team.getSetting('owner_as_client'), '0');
    assert.notEqual(db.getLead(ownerLead.lead_id)?.inbox_state ?? 'gone', 'in', 'the lifecycle took his test chat out');
    assert.equal(h.notes("kind = 'command'").length, 2);
    assert.ok(!app.inboxStore.messagesFor(ownerLead.lead_id).some((m) => /#dana/.test(m.text ?? '')), 'a command is never stored as a message');
  } finally {
    await h.close();
  }
});

test('T14 e2e: a restart in the middle of the queue → the note goes once, never twice', async () => {
  const db = openDb(':memory:');
  try {
    const a = rig14({ db });
    a.app.team.setSetting('sending_enabled', '0');
    await a.app.tools.run('create_lead', { args: { name: 'Example Buyer', phone: '0500000047' }, chat: { chat_id: 'c1', metadata: { source: 'bona-web' } } });
    await a.app.notes.tick();
    assert.equal(a.notes("kind = 'new_client'")[0].status, 'queued', 'Sending off: held, not lost');
    assert.equal(noteSends(a.evo.sends).length, 0);
    await a.close();

    const b = rig14({ db, startAt: T14 + 60_000 });
    b.app.team.setSetting('sending_enabled', '1');
    await b.app.notes.tick();
    assert.equal(noteSends(b.evo.sends).length, 1, 'sent after the restart, once Sending is back on');
    await b.close();

    const c = rig14({ db, startAt: T14 + 5 * 60_000 });
    await c.app.notes.tick();
    assert.equal(noteSends(c.evo.sends).length, 0, 'and never again after another restart');
    assert.equal(c.notes("kind = 'new_client'")[0].status, 'sent');
    await c.close();
  } finally {
    db.close();
  }
});

/* ---------------- INERT at the next restart (PLAN §0) ---------------- */

test('T14 inert: the wired app with default settings starts its timers and sends nothing to anyone, changes no switch, and a legacy chat is answered as on main', async () => {
  for (const env of [{}, { BONA_WA_INSTANCE_JID: '' }]) {
    const h = rig14({ env, turns: [brainReply('never')] });
    try {
      const { app, db } = h;
      const settings = () => db.db.prepare('SELECT key, value FROM settings ORDER BY key').all().map((r) => `${r.key}=${r.value}`);
      const before = settings();
      const timers = [];
      app.startTimers({ every: (ms, fn) => { timers.push(fn); return {}; }, clear: () => {} });
      for (let i = 0; i < 2; i += 1) {
        for (const fn of timers) await fn();
        h.advance(5 * 60_000);
      }
      await app.notes.tick();
      assert.deepEqual(h.evo.sends, [], 'nothing sent by any timer');
      assert.deepEqual(settings(), before, 'no switch, no marker written');
      assert.deepEqual(h.notes(), [], 'no owner note queued');

      // A legacy chat, exactly as main: Dana off answers nobody; on, today's Retell agent with the Dana disclosure.
      h.seedLead('LEAD-20261203-inrt0001', '966500000048');
      await h.poll(h.rec('966500000048', 'C-1', 'hello, is anyone there?'));
      assert.equal(h.evo.sends.length, 0, 'dana_enabled 0 (the default): nobody answers');
      app.team.setSetting('dana_enabled', '1');
      h.advance(1_000);
      await h.poll(h.rec('966500000048', 'C-2', 'still there?', { at: h.now - 500 }));
      const sends = h.sendsTo('966500000048');
      assert.equal(sends.length, 1);
      assert.match(sends[0].body.text, /^Dana — Bona's AI assistant\n\nRetell here: which district\?/);
      assert.equal(app.brain.calls.length, 0, 'dana_brain 0: the brain is never asked');
      assert.deepEqual(noteSends(h.evo.sends), [], 'and no owner note for a legacy chat\'s answer');
    } finally {
      await h.close();
    }
  }
});

/* ---------------- the daily backup prune (PLAN T14, "Added 27 Nov") ---------------- */

test('T14 upkeep: the daily run deletes release-backup copies past 29 days by their UTC stamp and killed runs\' partials past a day, and nothing else', async () => {
  const h = rig14();
  try {
    const dir = path.join(h.root, 'release-backups');
    fs.mkdirSync(dir, { mode: 0o700 });
    const stampOf = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
    const D = 86_400_000;
    const files = {
      old: `bona-deploy-${stampOf(h.now - 40 * D)}.db`,
      justOver: `bona-pre-v8-${stampOf(h.now - 29 * D - 60_000)}.db`,
      young: `bona-deploy-${stampOf(h.now - 28 * D)}.db`,
      foreign: 'notes.txt',
      lookalike: `bona-deploy-${stampOf(h.now - 40 * D)}.db.bak`,
      oldPartial: `.bona-deploy-${stampOf(h.now - 3 * D)}.db.4242.0123456789ab.partial`,
      freshPartial: `.bona-deploy-${stampOf(h.now)}.db.4243.0123456789ab.partial`,
    };
    for (const f of Object.values(files)) fs.writeFileSync(path.join(dir, f), 'x');
    const sub = path.join(dir, `bona-deploy-${stampOf(h.now - 90 * D)}.db`.replace('.db', '-dir.db'));
    fs.mkdirSync(sub);
    const oldDir = path.join(dir, `bona-deploy-${stampOf(h.now - 90 * D)}.db`);
    fs.mkdirSync(oldDir);
    fs.utimesSync(path.join(dir, files.oldPartial), new Date(h.now - 2 * D), new Date(h.now - 2 * D));
    fs.utimesSync(path.join(dir, files.freshPartial), new Date(h.now - 3_600_000), new Date(h.now - 3_600_000));
    // The partials' age is their file time against the app's clock: pin the wall clock near it for this run.
    await h.app.inboxMaintenance();
    const left = fs.readdirSync(dir).sort();
    assert.ok(!left.includes(files.old), 'a 40-day copy goes');
    assert.ok(!left.includes(files.justOver), 'a copy just past 29 days goes (any label)');
    assert.ok(left.includes(files.young), 'a 28-day copy stays');
    assert.ok(left.includes(files.foreign) && left.includes(files.lookalike), 'a name the snapshot never makes stays');
    assert.ok(!left.includes(files.oldPartial), 'a killed run\'s partial over a day old goes');
    assert.ok(left.includes(files.freshPartial), 'a fresh partial (a run still writing) stays');
    assert.ok(fs.statSync(oldDir).isDirectory() && fs.statSync(sub).isDirectory(), 'a sub-folder is never touched');
    const line = h.logs.find((l) => l.evt === 'backups.pruned');
    assert.deepEqual(line, { evt: 'backups.pruned', expired: 2, abandoned: 1 }, 'counts only, never a file name');
  } finally {
    await h.close();
  }
});

test('T14 upkeep: no release-backups folder is no error and no log line', async () => {
  const h = rig14();
  try {
    await h.app.inboxMaintenance();
    assert.ok(!h.logs.some((l) => l.evt === 'backups.pruned' || (l.evt === 'inbox.maintenance_failed' && l.step === 'backups')));
  } finally {
    await h.close();
  }
});

/* ---------------- PLAN T14 test 2: the Ops panel ---------------- */

test('T14-2 the Ops panel is the owner\'s only and shows the latency, answers and skips, send failures (marks are not failures), and the AI rows', async () => {
  const brain = createFakeBrain({ turns: [brainReply('Which district do you like?')] });
  brain.ops = () => ({
    turnsByModel: { 'gpt-test': 3 }, backupTurns: 1, errors: { quota: 1, timeout: 2 }, guardRepairs: 2, guardHandovers: 1, cachedRatio: 0.8,
    usdToday: 0.12, usdMonth: 3.4, p50Ms: 900, p90Ms: 2_100, out: false, breaker: false, cooldown: false,
  });
  const h = rig14({ brain });
  try {
    const { app, db } = h;
    app.team.setSetting('dana_enabled', '1');
    h.seedLead('LEAD-20261203-ops00001', '966500000052', { inbox_via: 'own_number', match_method: 'own_number' });
    await h.poll(h.rec('966500000052', 'C-1', 'Hello, a villa please'));
    const staffed = h.seedLead('LEAD-20261203-ops00002', '966500000053', { inbox_via: 'own_number', match_method: 'own_number' });
    db.updateLead(staffed.lead_id, { last_human_out_ts: h.now - 60_000 });
    await h.poll(h.rec('966500000053', 'C-2', 'ok'));
    // Outbox marks (wa-send splitMark): an accepted row that names what it covers, an unsure one with its reason, a real failure.
    const put = (id, status, error) => {
      app.inboxStore.insertOutbox({ send_id: id, lead_id: staffed.lead_id, jid: jidOf('966500000053'), text: 'x', user_id: null, sender_kind: 'staff' });
      app.inboxStore.updateOutbox(id, { status, error });
    };
    put('SND-mark-accepted', 'accepted', 'cov:12');
    put('SND-mark-unsure', 'uncertain', 'outage_line|timeout');
    put('SND-real-failure', 'failed', 'network');

    const ops = app.ops();
    assert.equal(ops['Answers (24 h)'], 1);
    assert.deepEqual(ops['Skips (24 h)'], { human_recent: 1 });
    assert.match(String(ops['Latency p50 / p90 (24 h)']), /^\d+ s \/ \d+ s$/);
    assert.deepEqual(ops['Send failures (24 h)'], { network: 1 }, 'a failed row by its reason; marks are not failures');
    assert.deepEqual(ops['Sends unsure (24 h)'], { timeout: 1 }, 'an unsure row by the reason after its mark');
    assert.deepEqual(ops['AI turns by model (24 h)'], { 'gpt-test': 3 });
    assert.deepEqual(ops['AI errors by code (24 h)'], { quota: 1, timeout: 2 });
    assert.equal(ops['AI guard repairs / hand-overs (24 h)'], '2 / 1');
    assert.equal(ops['AI cached-token ratio'], '80%');
    assert.equal(ops['AI $ today / month'], '$0.12 / $3.40');
    assert.doesNotMatch(JSON.stringify(ops), /966500000052|966500000053|villa|Hello/, 'never a number or a client\'s words');

    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const form = (p, fields, cookie) => fetch(base + p, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
      body: new URLSearchParams({ _dash: '1', ...fields }).toString(),
    });
    const cookieOf = (res, name) => (res.headers.getSetCookie() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1);
    const login = async (phone, digits) => {
      const before = h.sendsTo(digits).length;
      const asked = await form('/dashboard/login/code', { phone });
      await app.dashboard.auth.flush();
      const code = /(\d{6})/.exec(h.sendsTo(digits).slice(before).at(-1)?.body.text ?? '')?.[1];
      assert.ok(code, 'a login code went out');
      const verified = await form('/dashboard/login/verify', { code }, cookieOf(asked, 'bona_dash_try'));
      return cookieOf(verified, 'bona_dash');
    };
    try {
      const owner = await login('0500000009', OWNER14);
      const page = await (await fetch(`${base}/dashboard/team`, { headers: { Cookie: owner } })).text();
      for (const row of ['Latency p50 / p90 (24 h)', 'Answers (24 h)', 'Skips (24 h)', 'AI turns by model (24 h)', 'AI errors by code (24 h)', 'AI guard repairs / hand-overs (24 h)', 'AI cached-token ratio', 'AI $ today / month']) {
        assert.ok(page.includes(`<td>${row.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</td>`), row);
      }
      assert.match(page, /<td>Skips \(24 h\)<\/td><td>human_recent 1<\/td>/);
      app.team.addUser({ name: 'Sara', phone: '0500000001', role: 'staff' });
      const staff = await login('0500000001', '966500000001');
      const res = await fetch(`${base}/dashboard/team`, { headers: { Cookie: staff }, redirect: 'manual' });
      const body = await res.text();
      assert.notEqual(res.status, 200, 'staff never see the Team page');
      assert.doesNotMatch(body, /Answers \(24 h\)|AI turns by model/);
    } finally {
      await new Promise((resolve) => app.server.close(resolve));
    }
  } finally {
    await h.close();
  }
});

/* ---------------- the boot: the link probe's first round before the poller (PR-INT inertness) ---------------- */

const noIntervals = { every: () => ({}), clear: () => {} };

test('T14 boot: app.start runs the first link probe at once and starts the poller only after it, so a legacy own-number chat is answered at once', async () => {
  const h = rig14({ waLink: null });
  try {
    const { app } = h;
    assert.equal(app.waLink.identityOk(), false, 'before the first round: fail closed (T09)');
    app.team.setSetting('dana_enabled', '1');
    let identityWhenPollerStarted = null;
    app.poller.start = () => { identityWhenPollerStarted = app.waLink.identityOk(); return true; };
    const out = await app.start(noIntervals);
    assert.equal(out.pollStarted, true);
    assert.equal(identityWhenPollerStarted, true, 'the poller starts only once the instance is proven');
    assert.ok(h.seen.some((c) => c.url.includes('/instance/fetchInstances')), 'the first round ran at boot, not 10 min later');
    // A legacy chat on Bona's own number (dana_brain 0): answered by today's Retell agent at once.
    h.seedLead('LEAD-20261203-boot0001', '966500000061');
    await h.poll(h.rec('966500000061', 'C-1', 'Is the villa still available?'));
    const sends = h.sendsTo('966500000061');
    assert.equal(sends.length, 1, 'no 10-minute gap');
    assert.match(sends[0].body.text, /^Dana — Bona's AI assistant\n\nRetell here/);
    assert.ok(!h.logs.some((l) => l.evt === 'dana.skipped' && l.reason === 'identity'));
  } finally {
    h.app.stopTimers();
    await h.close();
  }
});

test('T14 boot: a first round that errors keeps T09/T12\'s fail-closed rule (the own-number chat waits for a proving round); a shared-number setup is answered as today either way', async () => {
  // Own number, Evolution failing the identity check: Dana answers nobody on it (DESIGN §5.3), and the poller still starts.
  const down = rig14({ waLink: null, evoDown: true });
  try {
    down.app.team.setSetting('dana_enabled', '1');
    down.app.poller.start = () => true;
    const out = await down.app.start(noIntervals);
    assert.equal(out.pollStarted, true, 'a failed probe never stops the poller');
    assert.equal(down.app.waLink.identityOk(), false);
    down.seedLead('LEAD-20261203-boot0002', '966500000062');
    await down.poll(down.rec('966500000062', 'C-1', 'hello?'));
    assert.equal(down.sendsTo('966500000062').length, 0, 'fail closed: not proven, not answered');
    assert.ok(down.logs.some((l) => l.evt === 'dana.skipped' && l.reason === 'identity'));
  } finally {
    down.app.stopTimers();
    await down.close();
  }
  // Shared number (no BONA_WA_INSTANCE_JID): the guard is never read; today's legacy answer, probe or none.
  const shared = rig14({ waLink: null, evoDown: true, env: { BONA_WA_INSTANCE_JID: '' } });
  try {
    shared.app.team.setSetting('dana_enabled', '1');
    shared.app.poller.start = () => true;
    await shared.app.start(noIntervals);
    shared.seedLead('LEAD-20261203-boot0003', '966500000063');
    await shared.poll(shared.rec('966500000063', 'C-1', 'hello?'));
    assert.equal(shared.sendsTo('966500000063').length, 1, 'shared number: answered as today');
  } finally {
    shared.app.stopTimers();
    await shared.close();
  }
});

/* ---------------- PR-INT r1: the identity watch, the Greeting/Away wiring, the 24 h latency, the timers ---------------- */

test('T14 identity: fetchInstances 503 while findMessages works → no push, no reply on the own number; the watch probes every 30 s until proven, then the waiting message is answered', async () => {
  const h = rig14({ waLink: null, evoDown: true });
  try {
    const { app } = h;
    app.team.setSetting('dana_enabled', '1');
    const pushed = [];
    const owners = app.alerts.notifyOwners;
    app.alerts.notifyOwners = (x) => { pushed.push(x?.reason); return owners(x); };
    app.poller.start = () => true;
    await app.start(noIntervals);
    assert.equal(app.waLink.identityOk(), false);
    h.seedLead('LEAD-20261203-idnt0001', '966500000064');
    await h.poll(h.rec('966500000064', 'C-1', 'Is the villa still available?'));
    await app.alerts.flush();
    assert.equal(h.sendsTo('966500000064').length, 0, 'not proven: no reply (DESIGN §5.3)');
    assert.ok(!pushed.includes('identity_mismatch'), 'unproven is not a mismatch: no push');
    const probes = () => h.seen.filter((c) => c.url.includes('/instance/fetchInstances')).length;
    const before = probes();
    h.advance(30_000);
    await app.ticks.identity();
    assert.equal(probes(), before + 1, 'unproven: one probe a 30-s tick, not 10 min');
    h.evoState.down = false;
    h.advance(30_000);
    assert.deepEqual(await app.ticks.identity(), { woken: 1 });
    await app.dana.flush();
    const sends = h.sendsTo('966500000064');
    assert.equal(sends.length, 1, 'proven: the refused message is answered');
    assert.match(sends[0].body.text, /Retell here/);
    const after = probes();
    h.advance(30_000);
    await app.ticks.identity();
    assert.equal(probes(), after, 'proven once: the tick probes no more (the probe\'s own 10-min loop)');
    await app.alerts.flush();
    assert.ok(!pushed.includes('identity_mismatch'));
  } finally {
    h.app.stopTimers();
    await h.close();
  }
});

test('T14 identity: a mismatch the boot probe established is pushed once by the link probe (PR-L, Dana on or off), and Dana\'s refusal adds no second push', async () => {
  for (const on of [true, false]) {
    const h = rig14({ waLink: null });
    try {
      const { app } = h;
      h.evoState.number = '966500000099';
      if (on) app.team.setSetting('dana_enabled', '1');
      const pushed = [];
      const owners = app.alerts.notifyOwners;
      app.alerts.notifyOwners = (x) => { pushed.push(x?.reason); return owners(x); };
      app.poller.start = () => true;
      await app.start(noIntervals);
      assert.equal(app.waLink.identityMismatch(), true);
      await app.waLink.flush?.();
      h.seedLead(`LEAD-20261203-mism000${on ? 1 : 2}`, '966500000065');
      await h.poll(h.rec('966500000065', 'C-1', 'hello'));
      await app.alerts.flush();
      assert.equal(h.sendsTo('966500000065').length, 0);
      assert.deepEqual(pushed, ['identity_mismatch'], 'one push for the incident: the link probe\'s, never a second from Dana');
    } finally {
      h.app.stopTimers();
      await h.close();
    }
  }
});

test('T14 boot: a shutdown during app.start\'s first probe never starts the poller after it', async () => {
  const link = { ...provenLink(), probe: () => new Promise(() => {}) };
  const h = rig14({ waLink: link });
  try {
    let started = 0;
    h.app.poller.start = () => { started += 1; return true; };
    const p = h.app.start({ ...noIntervals, firstProbeMs: 50 });
    h.app.stopTimers();
    assert.deepEqual((await p).pollStarted, null);
    assert.equal(started, 0);
  } finally {
    await h.close();
  }
});

test('T14 wiring: the ingest gets the notes for the Greeting/Away alert, delivered only while the automation is on: default settings send nothing; with the owner test on, one alert', async () => {
  for (const on of [false, true]) {
    const h = rig14();
    try {
      if (on) h.app.team.setSetting('owner_as_client', '1');
      h.seedLead('LEAD-20261203-grta0001', '966500000066');
      h.seedLead('LEAD-20261203-grta0002', '966500000067');
      const reply = 'Thanks, we will call you back shortly.';
      await h.poll(h.rec('966500000066', 'AWAY-1', reply, { fromMe: true, at: h.now - 20_000 }), h.rec('966500000067', 'AWAY-2', reply, { fromMe: true, at: h.now - 10_000 }));
      h.advance(60_000);
      await h.poll(h.rec('966500000066', 'AWAY-3', reply, { fromMe: true, at: h.now - 5_000 }));
      await h.app.notes.tick();
      const rows = h.notes("kind = 'alert'").filter((r) => r.meta.alert === 'greeting_away');
      if (on) {
        assert.equal(rows.length, 1, 'owner test on: exactly one al:greeting_away row');
        assert.match(rows[0].dedupe_key, /^al:greeting_away:\d+$/);
      } else {
        assert.deepEqual(rows, [], 'automation off: no alert row');
        assert.deepEqual(noteSends(h.evo.sends), [], 'and nothing sent to the owner');
        assert.ok(h.logs.some((l) => l.evt === 'inbox.greeting_away_quiet'), 'a journal line only');
      }
    } finally {
      await h.close();
    }
  }
});

test('T14 Ops and /health: the latency reads the last 24 h only; the lid-only count is in Ops', async () => {
  const h = rig14();
  try {
    const { app, db } = h;
    app.team.setSetting('dana_enabled', '1');
    for (let i = 0; i < 5; i += 1) {
      h.seedLead(`LEAD-20261203-late000${i}`, `96650000007${i}`);
      await h.poll(h.rec(`96650000007${i}`, `L-${i}`, 'hello?', { at: h.now - 70_000 }));
    }
    assert.equal(app.dana.latency().n, 5);
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const health = async () => (await (await fetch(`http://127.0.0.1:${app.server.address().port}/health`)).json()).dana.latencyOk;
    try {
      assert.equal(await health(), false, 'five answers of 70 s: p90 over 60 s');
      assert.match(String(app.ops()['Latency p50 / p90 (24 h)']), /^7\d s \/ 7\d s$/);
      h.advance(25 * 3_600_000);
      assert.equal(await health(), null, 'a day later those answers say nothing');
      assert.equal(app.ops()['Latency p50 / p90 (24 h)'], 'no answers yet');
    } finally {
      await new Promise((resolve) => app.server.close(resolve));
    }
    assert.equal(app.ops()['Lid-only chats to check'], 0);
    db.db.prepare("INSERT INTO inbox_candidates (cand_id, lid, first_ts, last_ts, updated) VALUES ('CAND-lid1', '101010101010101@lid', ?, ?, ?)").run(h.now, h.now, h.now);
    assert.equal(app.ops()['Lid-only chats to check'], 1);
  } finally {
    await h.close();
  }
});

test('T14 timers: the summary minute queues the 08:00 summary (not at 07:59), and the calendar reconcile runs from 05:00 and again before the summary; the probe tick probes', async () => {
  const at = (hh, mm) => Date.parse(`2026-12-03T${hh}:${mm}:00+03:00`);
  const h = rig14({ startAt: at('04', '59'), config: { gcalSaFile: '/nonexistent/example-sa.json', gcalCalendarId: 'test-calendar@example.com' } });
  try {
    const { app } = h;
    app.team.setSetting('owner_as_client', '1');
    let reconciled = 0;
    const real = app.viewing.reconcile;
    app.viewing.reconcile = async () => { reconciled += 1; return real(); };
    await app.ticks.summary();
    assert.equal(reconciled, 0, '04:59: no reconcile yet');
    h.set(at('05', '00'));
    await app.ticks.summary();
    await app.ticks.summary();
    assert.equal(reconciled, 1, '05:00: once a day');
    h.set(at('07', '59'));
    await app.ticks.summary();
    assert.equal(h.notes("kind = 'summary'").length, 0, '07:59: no summary');
    h.set(at('08', '00'));
    await app.ticks.summary();
    assert.equal(reconciled, 2, 'again before the summary builds');
    const sum = h.notes("kind = 'summary'");
    assert.equal(sum.length, 1);
    assert.match(sum[0].dedupe_key, /^sum:2026-12-03$/);
    await app.ticks.summary();
    assert.equal(h.notes("kind = 'summary'").length, 1, 'one a day');
    assert.equal(reconciled, 2);
  } finally {
    await h.close();
  }
});

test('T14 identity: an hour of 30-s identity ticks with fetchInstances 503 asks whatsappNumbers no more than the probe\'s own loop does, and a 60-s blip never makes the link down', async () => {
  const h = rig14({ waLink: null });
  try {
    const { app } = h;
    h.evoState.idDown = true;
    const pushed = [];
    const owners = app.alerts.notifyOwners;
    app.alerts.notifyOwners = (x) => { pushed.push(x?.reason); return owners(x); };
    app.poller.start = () => true;
    await app.start(noIntervals);
    const numbers = () => h.seen.filter((c) => c.url.includes('/chat/whatsappNumbers/')).length;
    const boot = numbers();
    assert.equal(boot, 1, 'the boot round asked the link once');
    for (let i = 0; i < 120; i += 1) {
      h.advance(30_000);
      await app.ticks.identity();
    }
    assert.ok(numbers() - boot <= 6, `whatsappNumbers ${numbers() - boot} times from the ticks`);
    assert.equal(numbers(), boot, 'the identity tick never runs the link half');
    assert.ok(h.seen.filter((c) => c.url.includes('/instance/fetchInstances')).length >= 120, 'the identity half, every tick');
    assert.equal(app.waLink.linkOk(), true);
    await app.alerts.flush();
    assert.ok(!pushed.includes('wa_link_down') && !pushed.includes('identity_mismatch'), JSON.stringify(pushed));
  } finally {
    h.app.stopTimers();
    await h.close();
  }
});

test('T14 brain: an auth outage seen before the brain is in use is held, then delivered once (note and push) when the owner test turns on without a restart', async () => {
  const AUTH = { status: 401, json: { error: { code: 'invalid_api_key' } } };
  const h = rig14({ realBrain: true, openai: [AUTH, AUTH, AUTH] });
  try {
    const { app } = h;
    const pushed = [];
    const owners = app.alerts.notifyOwners;
    app.alerts.notifyOwners = (x) => { pushed.push(x?.reason); return owners(x); };
    await app.ticks.brainProbe();
    await app.ticks.notes();
    await app.alerts.flush();
    assert.deepEqual(h.notes(), [], 'not in use: no note');
    assert.deepEqual(pushed, []);
    app.team.setSetting('owner_as_client', '1');
    assert.equal(app.ownerTest.active(), true);
    await app.ticks.notes();
    await app.alerts.flush();
    const out = h.notes("kind = 'alert'").filter((r) => r.meta.alert === 'brain_out');
    assert.equal(out.length, 1, 'the held outage note, once');
    assert.equal(out[0].meta.code, 'auth');
    assert.deepEqual(pushed, ['brain'], 'and its push, once');
    await app.ticks.notes();
    await app.ticks.brainProbe();
    await app.alerts.flush();
    assert.deepEqual(pushed, ['brain'], 'never twice');
  } finally {
    await h.close();
  }
});

test('T14 boot: the brain\'s models probe runs after the first identity round', async () => {
  const h = rig14({ waLink: null, realBrain: true, openai: [{ status: 200, json: { data: [] } }] });
  try {
    h.app.poller.start = () => true;
    await h.app.start(noIntervals);
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 20 && !h.seen.some((c) => c.url.endsWith('/v1/models')); i += 1) await new Promise((r) => setImmediate(r));
    const idAt = h.seen.findIndex((c) => c.url.includes('/instance/fetchInstances'));
    const probeAt = h.seen.findIndex((c) => c.url.endsWith('/v1/models'));
    assert.ok(idAt >= 0 && probeAt > idAt, `identity first (${idAt}), then the models probe (${probeAt})`);
  } finally {
    h.app.stopTimers();
    await h.close();
  }
});

/* ---------------- PR-INT r3: stale identity answers, notes on an unproven instance, the held outage across a restart ---------------- */

test('T14 identity: a late fast-check answer never overwrites a newer mismatch: no wake, and the mismatch stays', async () => {
  const h = rig14({ waLink: null });
  try {
    const { app } = h;
    app.team.setSetting('dana_enabled', '1');
    h.evoState.idDown = true;
    app.startTimers(noIntervals);
    await app.waLink.probe();
    h.seedLead('LEAD-20261203-stal0001', '966500000068');
    await h.poll(h.rec('966500000068', 'C-1', 'hello?'));
    assert.equal(h.sendsTo('966500000068').length, 0, 'refused while unproven');
    h.evoState.idDown = false;
    let release;
    h.evoState.answers = [{ wait: new Promise((r) => { release = r; }), number: BONA14 }, { wait: null, number: '966500000099' }];
    const fast = app.ticks.identity();
    await new Promise((r) => setImmediate(r));
    await app.waLink.probe();
    assert.equal(app.waLink.identityMismatch(), true, 'the full round recorded the mismatch');
    release();
    assert.deepEqual(await fast, { woken: 0 }, 'the late answer of the earlier check is ignored');
    assert.equal(app.waLink.identityMismatch(), true, 'the mismatch stays');
    assert.equal(app.waLink.identityOk(), false);
    await app.dana.flush();
    assert.equal(h.sendsTo('966500000068').length, 0, 'no wake, no send');
  } finally {
    h.app.stopTimers();
    await h.close();
  }
});

test('T14 notes: on Bona\'s own number a queued note is held while the instance is not proven (mismatch after a restart), then goes once it is', async () => {
  const db = openDb(':memory:');
  try {
    const a = rig14({ db });
    a.app.team.setSetting('sending_enabled', '0');
    assert.equal(a.app.notes.alert('breaker').queued, true);
    await a.close();
    const b = rig14({ db, waLink: null, startAt: T14 + 60_000 });
    try {
      b.app.team.setSetting('sending_enabled', '1');
      b.evoState.number = '966500000099';
      b.app.poller.start = () => true;
      await b.app.start(noIntervals);
      assert.equal(b.app.waLink.identityMismatch(), true);
      b.advance(60_000);
      await b.app.notes.tick();
      assert.equal(noteSends(b.evo.sends).length, 0, 'nothing through an instance that failed identity');
      assert.equal(b.notes("kind = 'alert'")[0].status, 'queued', 'held, never dropped');
      b.evoState.number = BONA14;
      await b.app.waLink.probe();
      assert.equal(b.app.waLink.identityOk(), true);
      b.advance(60_000);
      await b.app.notes.tick();
      b.advance(60_000);
      await b.app.notes.tick();
      assert.equal(noteSends(b.evo.sends).length, 1, 'proven: it goes, once');
      assert.equal(b.notes("kind = 'alert'")[0].status, 'sent');
    } finally {
      b.app.stopTimers();
      await b.close();
    }
  } finally {
    db.close();
  }
});

test('T14 brain: a persisted outage restored at start while the brain is not in use is held across the restart and delivered at the first moment of use', async () => {
  const AUTH = { status: 401, json: { error: { code: 'invalid_api_key' } } };
  const db = openDb(':memory:');
  try {
    const a = rig14({ db, realBrain: true, openai: [AUTH] });
    await a.app.ticks.brainProbe();
    assert.notEqual(a.app.team.brainOutSince(), null, 'the brain kept its marker');
    assert.deepEqual(a.notes(), []);
    await a.close();
    const b = rig14({ db, realBrain: true, startAt: T14 + 60_000 });
    try {
      const pushed = [];
      const owners = b.app.alerts.notifyOwners;
      b.app.alerts.notifyOwners = (x) => { pushed.push(x?.reason); return owners(x); };
      await b.app.ticks.notes();
      assert.deepEqual(b.notes(), [], 'not in use: still held');
      b.app.team.setSetting('owner_as_client', '1');
      await b.app.ticks.notes();
      await b.app.alerts.flush();
      assert.equal(b.notes("kind = 'alert'").filter((r) => r.meta.alert === 'brain_out').length, 1, 'delivered once at the first use');
      assert.deepEqual(pushed, ['brain']);
      await b.app.ticks.notes();
      await b.app.alerts.flush();
      assert.deepEqual(pushed, ['brain'], 'once');
    } finally {
      await b.close();
    }
  } finally {
    db.close();
  }
});

test('T14 brain: a held outage alert is dropped when the brain recovers (the models probe answers 200) before it is in use', async () => {
  const AUTH = { status: 401, json: { error: { code: 'invalid_api_key' } } };
  const h = rig14({ realBrain: true, openai: [AUTH, { status: 200, json: { data: [] } }] });
  try {
    const { app } = h;
    const pushed = [];
    const owners = app.alerts.notifyOwners;
    app.alerts.notifyOwners = (x) => { pushed.push(x?.reason); return owners(x); };
    await app.ticks.brainProbe();
    await app.ticks.brainProbe();
    assert.equal(app.brain.health().ok, true, 'the key works again');
    app.team.setSetting('owner_as_client', '1');
    await app.ticks.notes();
    await app.alerts.flush();
    assert.deepEqual(h.notes(), [], 'nothing stale delivered');
    assert.deepEqual(pushed, []);
  } finally {
    await h.close();
  }
});

/* ---------------- PR-INT r4 ---------------- */

test('T14 brain: a restored held alert is dropped once this process\'s models probe answers 200 (key replaced across the restart)', async () => {
  const AUTH = { status: 401, json: { error: { code: 'invalid_api_key' } } };
  const db = openDb(':memory:');
  try {
    const a = rig14({ db, realBrain: true, openai: [AUTH] });
    await a.app.ticks.brainProbe();
    assert.notEqual(a.app.team.brainOutSince(), null);
    await a.close();
    const b = rig14({ db, realBrain: true, openai: [{ status: 200, json: { data: [] } }], startAt: T14 + 60_000 });
    try {
      const pushed = [];
      const owners = b.app.alerts.notifyOwners;
      b.app.alerts.notifyOwners = (x) => { pushed.push(x?.reason); return owners(x); };
      await b.app.ticks.brainProbe();
      b.app.team.setSetting('owner_as_client', '1');
      await b.app.ticks.notes();
      await b.app.alerts.flush();
      assert.deepEqual(b.notes(), [], 'no stale note');
      assert.deepEqual(pushed, [], 'no stale push');
    } finally {
      await b.close();
    }
  } finally {
    db.close();
  }
});

test('T14 brain: a restart during an outage with the owner test already on holds nothing, so its push is not repeated once the instance is proven', async () => {
  const AUTH = { status: 401, json: { error: { code: 'invalid_api_key' } } };
  const db = openDb(':memory:');
  try {
    const a = rig14({ db, realBrain: true, openai: [AUTH] });
    a.app.team.setSetting('owner_as_client', '1');
    await a.app.ticks.brainProbe();
    await a.close();
    let proven = false;
    const link = { ...provenLink(), identityOk: () => proven, health: () => ({ identityOk: proven, linkOk: true }) };
    const b = rig14({ db, realBrain: true, waLink: link, startAt: T14 + 60_000 });
    try {
      const pushed = [];
      const owners = b.app.alerts.notifyOwners;
      b.app.alerts.notifyOwners = (x) => { pushed.push(x?.reason); return owners(x); };
      await b.app.ticks.notes();
      proven = true;
      await b.app.ticks.notes();
      await b.app.alerts.flush();
      assert.deepEqual(pushed, [], 'the alert went before the restart; not again');
    } finally {
      await b.close();
    }
  } finally {
    db.close();
  }
});

test('T14 timers: the 5-s notes tick skips its pass while the own-number identity is unproven', async () => {
  for (const identity of [false, true]) {
    const h = rig14({ waLink: provenLink({ identity }) });
    try {
      let passes = 0;
      const real = h.app.notes.tick;
      h.app.notes.tick = () => { passes += 1; return real(); };
      await h.app.ticks.notes();
      assert.equal(passes, identity ? 1 : 0);
    } finally {
      await h.close();
    }
  }
});
