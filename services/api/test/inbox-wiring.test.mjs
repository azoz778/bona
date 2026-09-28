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
  const app = createApp({
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

test('a send the last process left pending is "uncertain" as soon as the app is built', async () => {
  const db = openDb(':memory:');
  createInboxStore(db, { now: () => NOW - 10 * 60_000 }).insertOutbox({
    send_id: 'SND-left-pending', lead_id: 'LEAD-x', jid: '966500000077@s.whatsapp.net', text: 'hello', user_id: 'USR-1', sender_kind: 'staff',
  });
  const h = build({ db });
  try {
    const row = h.app.inboxStore.getOutbox('SND-left-pending');
    assert.equal(row.status, 'uncertain', 'nobody knows whether it went, so it is never retried');
    assert.equal(row.error, 'interrupted');
    assert.deepEqual(h.logs.filter((e) => e.evt === 'wa.send.interrupted'), [{ level: 'warn', evt: 'wa.send.interrupted', count: 1 }],
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
    assert.deepEqual(counts, { excludedOut: 0, purgedChats: 1, purgedMessages: 1, codeRows: 1, interrupted: 1, caughtUp: 2, caughtUpStored: 3 });

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
    assert.deepEqual(h.logs.find((e) => e.evt === 'inbox.catchup'), { evt: 'inbox.catchup', chats: 2, stored: 3 });
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
    assert.deepEqual(counts, { excludedOut: 3, purgedChats: 0, purgedMessages: 0, codeRows: 0, interrupted: 0, caughtUp: 1, caughtUpStored: 0 });
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

test('upkeep that fails is one log line that names the kind of failure, never its message, and the next run still runs', async () => {
  let fail = null;
  const backfill = {
    configured: true,
    phoneJidOf: () => null,
    history: async () => { if (fail) throw fail; return { stored: 0, scanned: 0, truncated: false }; },
    refresh: async () => ({ stored: 0, scanned: 0, truncated: false }),
  };
  const h = build({ backfill });
  try {
    const { app, db } = h;
    db.insertLead({
      lead_id: 'LEAD-empty', created: NOW - DAY, updated: NOW - DAY, phone_e164: '966500000077', wa_jid: '966500000077@s.whatsapp.net',
      channel: 'whatsapp', match_method: 'ref', stage: 'new', stage_ts: NOW - DAY, inbox_state: 'in', inbox_since: NOW - DAY,
    });
    // An error message can carry a jid; its name and code are logged only in shapes that cannot.
    fail = Object.assign(new TypeError('no chat for 966500000077@s.whatsapp.net'), { code: 'ERR_SQLITE_ERROR' });
    assert.deepEqual(await app.inboxMaintenance(), { error: 'failed' });
    fail = Object.assign(new Error('boom'), { name: 'Chat966500000077', code: '966500000077' });
    assert.deepEqual(await app.inboxMaintenance(), { error: 'failed' });
    assert.deepEqual(h.logs.filter((e) => e.evt === 'inbox.maintenance_failed'), [
      { level: 'error', evt: 'inbox.maintenance_failed', name: 'TypeError', code: 'ERR_SQLITE_ERROR' },
      { level: 'error', evt: 'inbox.maintenance_failed', name: null, code: null },
    ]);
    assert.ok(!JSON.stringify(h.logs).includes('966500000077'), 'no number, in the message, the name or the code');

    fail = null;
    assert.equal((await app.inboxMaintenance()).caughtUp, 1, 'a failed run does not leave the upkeep "running"');
  } finally {
    await h.close();
  }
});

test('upkeep never rejects, even when the logger throws while it reports a failure', async () => {
  const backfill = {
    configured: true,
    phoneJidOf: () => null,
    history: async () => { throw new Error('read failed'); },
    refresh: async () => ({ stored: 0, scanned: 0, truncated: false }),
  };
  const log = (e) => { if (String(e?.evt).startsWith('inbox.')) throw new Error('log sink down'); };
  const h = build({ backfill, log });
  try {
    h.db.insertLead({
      lead_id: 'LEAD-empty', created: NOW - DAY, updated: NOW - DAY, phone_e164: '966500000077', wa_jid: '966500000077@s.whatsapp.net',
      channel: 'whatsapp', match_method: 'ref', stage: 'new', stage_ts: NOW - DAY, inbox_state: 'in', inbox_since: NOW - DAY,
    });
    assert.deepEqual(await h.app.inboxMaintenance(), { error: 'failed' }, 'resolved, not rejected: the server calls it fire-and-forget');
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
