/**
 * PR-A1 (PLAN T06, DESIGN §3.1): the own-number join, in lib/wa-poller.mjs. The owner's test
 * switch and the own-number rule are lib/owner-test.mjs's (PR-A2, T07); here they are a FAKE
 * handed to the poller, so every case pins what the poller does with each answer. The notes
 * are a fake too (lib/owner-notes.mjs is PR-B2's), except where a test says it uses today's
 * stub. Evolution is never contacted: the poller reads a queue of windows and the join's
 * history reads a fixed pool.
 *
 * Numbers are example ones (+966 50 000 00xx) except Bona's own public number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createTeam, learnTeamLid, isExcludedLead } from '../lib/team.mjs';
import { createAudit } from '../lib/audit.mjs';
import * as pollerModule from '../lib/wa-poller.mjs';
import { createBackfill, JOIN_HISTORY_MS } from '../lib/inbox/backfill.mjs';
import { createIngest, RESOLVE_WINDOW_MS, SEND_SKEW_MS } from '../lib/inbox/ingest.mjs';
import { createInboxStore } from '../lib/inbox/store.mjs';
import { createOwnerTest } from '../lib/owner-test.mjs';
import { createOwnerNotes } from '../lib/owner-notes.mjs';
import { createPushPolicy } from '../lib/push-policy.mjs';
import { leadNote } from '../lib/leads.mjs';

const { createPoller } = pollerModule;

const NOW = Date.UTC(2026, 11, 3, 9, 0, 0); // Thu 3 Dec 2026, 12:00 Riyadh
const DAY = 86_400_000;
const HOUR = 3_600_000;
const SITE = 'https://bona-real-estate.com';
/** BONA_WA_LINKED_AT, 2026-11-26T05:25:00+03:00. */
const LINKED_AT = Date.UTC(2026, 10, 26, 2, 25, 0);

const OWNER_DIGITS = '966500000001';
const OWNER = `${OWNER_DIGITS}@s.whatsapp.net`;
const OWNER_LID = '100000000000001@lid';
const BONA = '966576267694@s.whatsapp.net';
/** Bona's own number configured (ownNumberFrom 'instance'). */
const SPLIT = { BONA_OWNER_JID: OWNER, BONA_WA_INSTANCE: 'bona2', BONA_WA_INSTANCE_JID: BONA };
/** The personal number (BONA_WA_INSTANCE_JID removed: ownNumberFrom 'owner'), and a JID that is not one ('invalid'). */
const PERSONAL = { BONA_OWNER_JID: OWNER };
const INVALID = { BONA_OWNER_JID: OWNER, BONA_WA_INSTANCE: 'bona2', BONA_WA_INSTANCE_JID: 'bona2' };

const digitsOf = (n) => `9665000000${String(n).padStart(2, '0')}`;
const jidOf = (n) => `${digitsOf(n)}@s.whatsapp.net`;
const STRANGER = jidOf(10);
const COLLEAGUE_DIGITS = digitsOf(20);
const COLLEAGUE_LID = '200000000000020@lid';

/** One normalised record, as lib/evolution.mjs hands them over. */
const msg = (over = {}) => ({
  id: 'KEY1', jid: STRANGER, jidAlt: null, fromMe: false, ts: NOW - 60_000,
  text: '', pushName: 'Sara', contextInfo: null, messageType: 'conversation', ...over,
});

/**
 * The fake test switch (PR-A2's interface), driven by one state object a test may change.
 * `identityLapsed` makes it inconsistent on purpose: `ownNumberOk()` says no while `active()`,
 * `ownRuleFor()` and the harness's team and ingest emulation still say yes, so a case pins that
 * the poller asks the identity check itself (fail closed) instead of trusting the other answers.
 */
function fakeOwnerTest(state, calls) {
  const isOwner = (jids) => jids?.phone === OWNER_DIGITS || jids?.waLid === OWNER_LID;
  return {
    active: () => state.active && state.ownNumberOk,
    ownNumberOk: () => state.ownNumberOk && !state.identityLapsed,
    autoMode: () => false,
    ownRuleFor: (jids) => { calls.ownRuleFor.push(jids); return state.ownNumberOk && (state.ownInbox || (state.active && isOwner(jids))); },
    ownerLid: () => OWNER_LID,
    command: (rec) => {
      calls.command.push(rec.id);
      if (state.commandImpl) return state.commandImpl(rec);
      const byOwner = rec.jid === OWNER || rec.jid === OWNER_LID || rec.jidAlt === OWNER;
      return !rec.fromMe && byOwner && /^\s*#dana\b/i.test(String(rec.text ?? ''));
    },
    onSettingChanged: () => {},
    health: () => ({ rule: 'own', ownerAsClient: Boolean(state.active) }),
  };
}

function fakeNotes(calls) {
  const nothing = () => {};
  return {
    leadEvent: async (lead, o) => { calls.leadEvent.push({ leadId: lead.lead_id, ...o }); },
    alert: (code, meta) => { calls.alert.push([code, meta]); return { queued: true }; },
    handover: nothing, booking: nothing, stopped: nothing, mail: nothing, command: nothing, onPurge: nothing, tick: nothing,
    health: () => ({ enabled: true, ok: true }),
  };
}

/** PR-A2's `dismissedCandidateFor` (PLAN T07 test 16), stubbed on the store until it lands. */
function dismissedFor(db, { phone = null, jid = null, lid = null } = {}) {
  for (const [col, v] of [['phone_e164', phone], ['jid', jid], ['lid', lid]]) {
    if (!v) continue;
    const row = db.db.prepare(`SELECT * FROM inbox_candidates WHERE ${col} = ? AND state = 'dismissed'`).get(v);
    if (row) return { ...row };
  }
  return null;
}

/** Evolution's per-chat read over a fixed pool (the join history and the refresh). */
function chatReader(pool) {
  return async ({ where = {}, page = 1, offset = 100 } = {}) => {
    const key = where.key ?? {};
    const t = where.messageTimestamp ?? null;
    const hits = pool
      .filter((r) => (key.remoteJid === undefined || r.jid === key.remoteJid)
        && (key.remoteJidAlt === undefined || r.jidAlt === key.remoteJidAlt)
        && (!t || (r.ts >= Date.parse(t.gte) && r.ts <= Date.parse(t.lte))))
      .sort((a, b) => b.ts - a.ts);
    return { records: hits.slice((page - 1) * offset, page * offset), total: hits.length, pages: Math.max(1, Math.ceil(hits.length / offset)) };
  };
}

/**
 * The poller wired the way index.mjs wires it: the real db, inbox store, ingest and backfill,
 * the push policy in front of a fake Dana, a fake test switch and fake notes (`notes: 'stub'`
 * hands in today's PR-F2b stub over the same `sendWhatsApp` instead; `ownerTest: 'stub'`
 * today's stub; `ownerTest: null` / `notes: null` none at all, the older wiring). The poller's
 * exclusion and ingest's emulate PR-A2's override: the owner's number and lid are not team
 * while the fake test is active.
 */
function harness({
  env = SPLIT, state = {}, history = [], ownerTest = 'fake', notes = 'fake', dismissedLookup = true, owner = false, cfg = {}, ingestFails = 0,
  beforeIngest = null,
} = {}) {
  const db = openDb(':memory:');
  let clock = NOW;
  const now = () => clock;
  const logs = [];
  const log = (o) => logs.push(o);
  const st = { ownNumberOk: true, ownInbox: false, active: false, ...state };
  const calls = { ownRuleFor: [], command: [], leadEvent: [], alert: [], wake: [], notify: [], history: [], excluded: [], prune: [] };
  const team = createTeam(db, { now });
  if (owner) {
    team.ensureOwner({ phone: OWNER_DIGITS, name: 'Owner Example' });
    learnTeamLid(db, OWNER_DIGITS, OWNER_LID);
  }
  const inbox = createInboxStore(db, { now });
  if (dismissedLookup) inbox.dismissedCandidateFor = (ids) => dismissedFor(db, ids);
  const realPrune = inbox.pruneCandidates;
  inbox.pruneCandidates = (o) => { calls.prune.push(o); return realPrune(o); };
  const ownerish = (l) => st.active && st.ownNumberOk
    && (l?.phone_e164 === OWNER_DIGITS || String(l?.wa_jid ?? '').startsWith(`${OWNER_DIGITS}@`) || l?.wa_lid === OWNER_LID);
  const ingestor = createIngest({
    db, inbox, ownerUserId: () => null, ownerPhone: String(env.BONA_WA_INSTANCE_JID ?? '').split('@')[0] || OWNER_DIGITS,
    isExcludedLead: (l) => !ownerish(l) && isExcludedLead(team, db, l), log, now,
  });
  const ingest = (lead, rec) => ingestor.ingest(lead, rec);
  // The poller's own ingest may fail its first `ingestFails` calls (a busy store); the backfill keeps the real one.
  // `beforeIngest(lead, rec)` runs first on each of the poller's calls (a case that changes a switch there).
  let fails = ingestFails;
  const pollerIngest = (lead, rec) => {
    if (beforeIngest) beforeIngest(lead, rec);
    if (fails > 0) { fails -= 1; throw new Error('store busy'); }
    return ingest(lead, rec);
  };
  const backfill = createBackfill({ env: {}, db, ingest, inbox, find: chatReader(history), log, now });
  const realHistory = backfill.history;
  backfill.history = (lead, w) => { calls.history.push({ leadId: lead?.lead_id ?? null, ...w }); return realHistory(lead, w); };
  const policy = createPushPolicy({
    alerts: { notify: (leadId) => { calls.notify.push(leadId); } },
    dana: { wake: (leadId, ts) => { calls.wake.push([leadId, ts]); } },
  });
  const sent = [];
  const sendWhatsApp = async (text) => { sent.push(text); return { ok: true }; };
  const ot = ownerTest === 'fake' ? fakeOwnerTest(st, calls) : ownerTest === 'stub' ? createOwnerTest() : ownerTest;
  const nt = notes === 'fake' ? fakeNotes(calls) : notes === 'stub' ? createOwnerNotes({ db, siteUrl: SITE, sendNote: sendWhatsApp, log }) : notes;
  const queue = [];
  const poller = createPoller({
    db,
    cfg: { env, siteUrl: SITE, waPollMs: 0, waLinkedAt: LINKED_AT, ...cfg },
    findMessages: async () => ({ records: queue.length ? queue.shift() : [] }),
    sendWhatsApp,
    isExcluded: (d) => { calls.excluded.push(d); return !(st.active && st.ownNumberOk && d === OWNER_DIGITS) && team.isExcludedPhone(d); },
    inboxStore: inbox, ingest: pollerIngest, backfill,
    onClientMessage: (leadId, ts) => policy.onClientMessage(leadId, ts),
    ...(ot ? { ownerTest: ot } : {}),
    ...(nt ? { notes: nt } : {}),
    log, now,
  });
  return {
    db, team, inbox, ingestor, backfill, poller, logs, sent, calls, state: st,
    push: (records) => queue.push(records),
    tick: () => poller.tick(),
    setClock: (t) => { clock = t; },
    leads: () => db.listLeads({ limit: 50 }),
    rows: (leadId) => db.db.prepare('SELECT key_id, direction, sender_kind FROM wa_messages WHERE lead_id = ? ORDER BY ts').all(leadId)
      .map((r) => [r.key_id, r.direction, r.sender_kind]),
    messages: () => db.db.prepare('SELECT COUNT(*) AS n FROM wa_messages').get().n,
    candidates: () => db.db.prepare('SELECT * FROM inbox_candidates ORDER BY first_ts').all().map((r) => ({ ...r })),
    fanout: () => db.db.prepare('SELECT COUNT(*) AS n FROM fanout').get().n,
    lead: (id) => db.getLead(id),
    close: () => db.close(),
  };
}

/** A lead row as the store keeps it. */
function seedLead(h, id, n, over = {}) {
  h.db.insertLead({
    lead_id: id, created: NOW - 3 * DAY, updated: NOW - 3 * DAY, phone_e164: digitsOf(n), wa_jid: jidOf(n), channel: 'whatsapp',
    match_method: 'ref', stage: 'new', stage_ts: NOW - 3 * DAY, ...over,
  });
  return h.db.getLead(id);
}

/** A dismissed "Chats to check" row, dismissed at `at` (its `updated`). */
function seedDismissed(h, { candId, phone = null, jid = null, lid = null, at }) {
  h.db.db.prepare(`INSERT INTO inbox_candidates (cand_id, jid, lid, phone_e164, name, first_ts, last_ts, hits, words, last_dir, state, updated)
                   VALUES (?,?,?,?,NULL,?,?,0,NULL,NULL,'dismissed',?)`).run(candId, jid, lid, phone, at, at, at);
}

const noLogLeak = (h, ...needles) => {
  const dump = JSON.stringify(h.logs);
  for (const n of needles) assert.ok(!dump.includes(n), `no log line carries ${n}`);
};

/* ---------------- 1-2: the own rule joins a chat ---------------- */

test('T06-1 own rule: a stranger\'s "Hi" on Bona\'s number joins in, is stored, inbox_via own_number, wakes Dana, one "joined" note event', async () => {
  const h = harness({ state: { ownInbox: true } });
  h.push([msg({ id: 'HI1', text: 'Hi' })]);
  const tally = await h.tick();
  assert.equal(tally.created, 1);
  assert.equal(tally.joined, 1);
  const [lead] = h.leads();
  assert.equal(lead.match_method, 'own_number');
  assert.equal(lead.inbox_state, 'in');
  assert.equal(lead.inbox_via, 'own_number');
  assert.equal(lead.history_from, NOW - 60_000 - JOIN_HISTORY_MS, 'the usual 24 h history floor');
  assert.deepEqual(h.rows(lead.lead_id), [['HI1', 'in', 'client']]);
  assert.deepEqual(h.calls.wake, [[lead.lead_id, NOW - 60_000]], 'dana.wake, through the push policy');
  assert.deepEqual(h.calls.leadEvent, [{ leadId: lead.lead_id, why: 'joined', created: true, ts: NOW - 60_000 }]);
  assert.equal(h.calls.history.length, 1, 'the 24 h before the join are read');
  assert.equal(h.sent.length, 0, 'the notes module sends, not the poller');
  noLogLeak(h, '966500000010', 'Sara');
  h.close();
});

test('T06-1 with today\'s notes stub: an own-number create sends today\'s note exactly once (not a create note and a join note)', async () => {
  const h = harness({ state: { ownInbox: true }, notes: 'stub' });
  h.push([msg({ id: 'HI1', text: 'Hi' })]);
  await h.tick();
  const [lead] = h.leads();
  assert.deepEqual(h.sent, [leadNote(lead, { siteUrl: SITE })]);
  h.close();
});

test('T06-2 own rule: an unsure lead joins (inbox_via own_number); a lead in by proof keeps NULL; an out lead stays out', async () => {
  const h = harness({ state: { ownInbox: true } });
  seedLead(h, 'LEAD-uns', 11, { inbox_state: 'unsure', inbox_since: NOW - DAY });
  seedLead(h, 'LEAD-in', 12, { inbox_state: 'in', inbox_since: NOW - DAY, history_from: NOW - 2 * DAY });
  seedLead(h, 'LEAD-out', 13, { inbox_state: 'out' });
  h.push([
    msg({ id: 'U1', jid: jidOf(11), text: 'any news?' }),
    msg({ id: 'I1', jid: jidOf(12), ts: NOW - 50_000, text: 'thanks' }),
    msg({ id: 'O1', jid: jidOf(13), ts: NOW - 40_000, text: 'hello again' }),
  ]);
  await h.tick();
  assert.equal(h.lead('LEAD-uns').inbox_state, 'in');
  assert.equal(h.lead('LEAD-uns').inbox_via, 'own_number', 'stamped at the join');
  assert.deepEqual(h.rows('LEAD-uns'), [['U1', 'in', 'client']]);
  assert.equal(h.lead('LEAD-in').inbox_via, null, 'in by proof: never rewritten');
  assert.equal(h.lead('LEAD-in').history_from, NOW - 2 * DAY);
  assert.deepEqual(h.rows('LEAD-in'), [['I1', 'in', 'client']]);
  assert.equal(h.lead('LEAD-out').inbox_state, 'out');
  assert.equal(h.lead('LEAD-out').inbox_via, null);
  assert.deepEqual(h.rows('LEAD-out'), []);
  assert.deepEqual(h.calls.wake.map(([id]) => id), ['LEAD-uns', 'LEAD-in'], 'no wake for the out lead');
  assert.deepEqual(h.calls.leadEvent, [{ leadId: 'LEAD-uns', why: 'joined', created: false, ts: NOW - 60_000 }],
    'a returning unsure lead is a join (G13); the proof lead was in already');
  h.close();
});

test('T06-1/6 a joining record whose store fails is retried without a second join or a second "joined" note', async () => {
  for (const owner of [false, true]) {
    const h = harness({ state: owner ? { active: true } : { ownInbox: true }, owner, ingestFails: 1 });
    const rec = owner
      ? msg({ id: 'J1', jid: OWNER, pushName: 'Owner Example', text: 'Hi' })
      : msg({ id: 'J1', text: 'Hi' });
    h.push([rec]);
    const first = await h.tick(); // eslint-disable-line no-await-in-loop
    assert.equal(first.joined, 1);
    assert.equal(first.stored, 0, 'the store failed');
    h.push([rec]);
    const second = await h.tick(); // eslint-disable-line no-await-in-loop
    const what = owner ? 'owner test' : 'own number';
    assert.equal(second.joined, 0, `${what}: joined once`);
    assert.equal(second.stored, 1, `${what}: stored on the retry`);
    const [lead] = h.leads();
    assert.equal(lead.inbox_via, owner ? 'owner_test' : 'own_number', what);
    assert.equal(h.calls.leadEvent.length, 1, `${what}: one note event`);
    assert.equal(h.db.countLeads(), 1, what);
    h.close();
  }
});

test('T06-1/6 a join is all or nothing: a failure writing inbox_via leaves the chat as it was, and the retry joins it stamped, with one "joined" note', async () => {
  for (const owner of [false, true]) {
    const h = harness({ state: owner ? { active: true } : { ownInbox: true }, owner });
    const realUpdate = h.db.updateLead;
    let fails = 1;
    h.db.updateLead = (id, patch = {}) => {
      if (fails > 0 && patch.inbox_via !== undefined) { fails -= 1; throw new Error('store busy'); }
      return realUpdate(id, patch);
    };
    const rec = owner
      ? msg({ id: 'J1', jid: OWNER, pushName: 'Owner Example', text: 'Hi' })
      : msg({ id: 'J1', text: 'Hi' });
    h.push([rec]);
    const first = await h.tick(); // eslint-disable-line no-await-in-loop
    const what = owner ? 'owner test' : 'own number';
    assert.equal(fails, 0, `${what}: the marker write failed once`);
    assert.equal(first.joined, 0, `${what}: no join on the first attempt`);
    assert.equal(h.messages(), 0, `${what}: nothing stored on the first attempt`);
    const [before] = h.leads();
    assert.equal(before.inbox_via, null, what);
    // Neither chat is left `in` without its marker (a proof join's look): not the own-number one,
    // and not the owner's test lead either, which lib/leads.mjs (OWNER_METHODS) would create `in`
    // with the ordinary 24 h floor before the join wrote its marker and his test's floor.
    assert.equal(before.inbox_state, null, `${what}: the state went back with the marker`);
    assert.equal(before.inbox_since, null, `${what}: and its time`);
    assert.equal(before.history_from, null, `${what}: and the floor too`);
    h.push([rec]);
    const second = await h.tick(); // eslint-disable-line no-await-in-loop
    assert.equal(second.joined, 1, `${what}: the retry joins`);
    assert.equal(second.stored, 1, `${what}: and stores`);
    const [lead] = h.leads();
    assert.equal(lead.inbox_state, 'in', what);
    assert.equal(lead.inbox_via, owner ? 'owner_test' : 'own_number', `${what}: stamped`);
    assert.equal(h.calls.leadEvent.length, 1, `${what}: one "joined" note`);
    assert.equal(h.calls.wake.length, 1, `${what}: woken once`);
    h.close();
  }
});

test('T06-6 a failed first test join leaves no `in` lead behind: a second message of his in the same window joins it stamped, from his test\'s floor', async () => {
  const T = NOW - 120_000;
  const atIngest = [];
  const h = harness({
    state: { active: true }, owner: true,
    beforeIngest: (lead, rec) => {
      const l = h.db.getLead(lead.lead_id);
      atIngest.push([rec.id, l.inbox_state, l.inbox_via, l.history_from]);
    },
  });
  h.setClock(T);
  h.team.setSetting('owner_as_client', '1');
  h.setClock(NOW);
  const realUpdate = h.db.updateLead;
  let fails = 1;
  h.db.updateLead = (id, patch = {}) => {
    if (fails > 0 && patch.inbox_via !== undefined) { fails -= 1; throw new Error('store busy'); }
    return realUpdate(id, patch);
  };
  const J1 = msg({ id: 'J1', jid: OWNER, pushName: 'Owner Example', ts: NOW - 60_000, text: 'Hi' });
  const J2 = msg({ id: 'J2', jid: OWNER, pushName: 'Owner Example', ts: NOW - 50_000, text: 'is BONA-W003 still free?' });
  h.push([J1, J2]);
  const first = await h.tick();
  assert.equal(fails, 0, 'the first join\'s marker write failed');
  assert.equal(h.db.countLeads(), 1);
  assert.equal(first.joined, 1, 'the second message joins the chat');
  assert.deepEqual(atIngest, [['J2', 'in', 'owner_test', T]], 'never stored into a chat without its marker and his floor');
  const [lead] = h.leads();
  assert.equal(lead.match_method, 'owner_test');
  assert.equal(lead.inbox_state, 'in');
  assert.equal(lead.inbox_via, 'owner_test');
  assert.equal(lead.history_from, T, 'the floor is the moment the test went on, not 24 h back');
  assert.deepEqual(h.rows(lead.lead_id), [['J2', 'in', 'client']]);
  assert.equal(h.calls.leadEvent.length, 1, 'one "joined" note');
  assert.deepEqual(h.calls.wake, [[lead.lead_id, NOW - 50_000]]);
  // The first message is retried into the chat as it now is.
  h.push([J1, J2]);
  const second = await h.tick();
  assert.equal(second.joined, 0);
  assert.deepEqual(h.rows(lead.lead_id), [['J1', 'in', 'client'], ['J2', 'in', 'client']]);
  assert.equal(h.lead(lead.lead_id).inbox_via, 'owner_test');
  assert.equal(h.lead(lead.lead_id).history_from, T);
  assert.equal(h.calls.leadEvent.length, 1, 'still one "joined" note');
  h.close();
});

/* ---------------- 3: chats nobody is a client in ---------------- */

test('T06-3 newsletter, group, broadcast and status are ignored under the own rule', async () => {
  const h = harness({ state: { ownInbox: true } });
  h.push([
    msg({ id: 'G1', jid: '120363000000000001@g.us', text: 'Hi BONA-W003' }),
    msg({ id: 'S1', jid: 'status@broadcast', text: 'villa for sale' }),
    msg({ id: 'B1', jid: '1700000000@broadcast', text: 'Hi' }),
    msg({ id: 'N1', jid: '12036302524@newsletter', pushName: 'Villas', text: 'Bona villa for sale BONA-W003' }),
    msg({ id: 'N2', jid: '120363025246125486@newsletter', pushName: 'Jeddah Villas', text: 'Hi' }),
  ]);
  const tally = await h.tick();
  assert.equal(tally.ignored, 5);
  assert.equal(h.db.countLeads(), 0);
  assert.deepEqual(h.candidates(), []);
  assert.equal(h.messages(), 0);
  h.close();
});

test('T06-3 a WhatsApp channel is ignored under the shared rule too (no ownerTest wired at all)', async () => {
  const h = harness({ env: PERSONAL, ownerTest: null, notes: null });
  h.push([msg({ id: 'N1', jid: '12036302524@newsletter', pushName: 'Villas', text: 'Bona has a new villa, BONA-W003' })]);
  const tally = await h.tick();
  assert.equal(tally.ignored, 1);
  assert.equal(h.db.countLeads(), 0, 'a channel post naming Bona is not an enquiry');
  assert.equal(h.sent.length, 0);
  h.close();
});

/* ---------------- 4: lid-only chats are listed, never joined ---------------- */

test('T06-4 own rule: a lid-only "Hi" is not stored and goes on Chats to check as lid-only with its name; only inbound records note it', async () => {
  const LID = '300000000000030@lid';
  const h = harness({ state: { ownInbox: true } });
  h.push([
    msg({ id: 'L1', jid: LID, pushName: 'Maha', ts: NOW - 90_000, text: 'Hi' }),
    msg({ id: 'L2', jid: LID, fromMe: true, pushName: null, ts: NOW - 60_000, text: 'Hello, who is this? villa for sale' }),
    msg({ id: 'L3', jid: LID, pushName: 'Maha', ts: NOW - 30_000, text: 'السلام عليكم' }),
  ]);
  await h.tick();
  assert.equal(h.db.countLeads(), 0, 'never joined');
  assert.equal(h.messages(), 0, 'nothing stored');
  const rows = h.candidates();
  assert.equal(rows.length, 1);
  const [r] = rows;
  assert.deepEqual(
    [r.lid, r.jid, r.phone_e164, r.name, r.words, r.last_dir, r.hits, r.first_ts, r.last_ts, r.state],
    [LID, null, null, 'Maha', 'lid-only', 'in', 2, NOW - 90_000, NOW - 30_000, 'open'],
    'ids, the name, and when its messages were sent; never the text, never who wrote last but the client',
  );
  assert.equal(h.calls.wake.length, 0);
  noLogLeak(h, '300000000000030', 'Maha');
  h.close();
});

test('T06-4 without the own rule a lid-only chat is noted nowhere (as today)', async () => {
  const LID = '300000000000031@lid';
  for (const state of [{ ownInbox: false }, { ownInbox: true, ownNumberOk: false }]) {
    const h = harness({ state });
    h.push([msg({ id: 'L1', jid: LID, pushName: 'Maha', text: 'Hi, is the villa still for sale?' })]);
    await h.tick(); // eslint-disable-line no-await-in-loop
    assert.deepEqual(h.candidates(), [], JSON.stringify(state));
    assert.equal(h.db.countLeads(), 0);
    h.close();
  }
});

/* ---------------- 4b: a chat with no number anywhere never makes a lead on Bona's number ---------------- */

test('T06-4b on Bona\'s number a lid-only chat never makes a lead or joins, whatever it carries (a Ref, ad evidence, a listing id, a click)', async () => {
  const lid = (n) => `3000000000000${n}@lid`;
  for (const state of [{ ownInbox: true }, { ownInbox: false }, { ownInbox: true, ownNumberOk: false }]) {
    const h = harness({ state, notes: 'stub' });
    seedSession(h);
    h.db.insertEvent({ event_id: 'ev-click-own', ts: NOW - 70_000, name: 'whatsapp_click', session_id: 'clk-own-1', anon_id: 'd'.repeat(32) });
    h.push([
      msg({ id: 'R1', jid: lid(51), pushName: 'Maha', ts: NOW - 90_000, text: 'Hello\nRef BONA-W003 · K7Q2XR' }),
      msg({
        id: 'A1', jid: lid(52), pushName: 'Noor', ts: NOW - 80_000, text: 'Hi',
        contextInfo: { conversionSource: 'FB_Ads', externalAdReply: { sourceType: 'ad', sourceId: '120000000000000001', ctwaClid: 'example-clid' } },
      }),
      msg({ id: 'K1', jid: lid(53), pushName: 'Reem', ts: NOW - 70_000, text: 'Is BONA-W003 still available?' }),
      msg({ id: 'T1', jid: lid(54), pushName: 'Lama', ts: NOW - 60_000, text: 'Hi' }),
    ]);
    const tally = await h.tick(); // eslint-disable-line no-await-in-loop
    const what = JSON.stringify(state);
    assert.equal(h.db.countLeads(), 0, `${what}: no lead from a chat with no number`);
    assert.equal(tally.joined, 0, what);
    assert.equal(h.messages(), 0, `${what}: nothing stored`);
    assert.equal(h.sent.length, 0, `${what}: no new-enquiry note`);
    assert.equal(h.db.getEvent('ev-click-own').lead_id ?? null, null, `${what}: the click is not claimed`);
    const ownRule = state.ownInbox && state.ownNumberOk !== false;
    assert.deepEqual(h.candidates().map((r) => [r.lid, r.phone_e164, r.words, r.last_dir]),
      ownRule ? [51, 52, 53, 54].map((n) => [lid(n), null, 'lid-only', 'in']) : [],
      `${what}: listed as lid-only under the own rule only, as today`);
    noLogLeak(h, '300000000000051', 'Maha');
    h.close();
  }
});

test('T06-4b on Bona\'s number a lead known only by its lid does not join on a Ref (it keeps its state); one already in is still stored', async () => {
  const LID_A = '300000000000061@lid';
  const LID_B = '300000000000062@lid';
  for (const state of [{ ownInbox: true }, { ownInbox: false }]) {
    const h = harness({ state });
    seedSession(h);
    const base = { created: NOW - 3 * DAY, updated: NOW - 3 * DAY, channel: 'whatsapp', match_method: 'ref', stage: 'new', stage_ts: NOW - 3 * DAY };
    h.db.insertLead({ ...base, lead_id: 'LEAD-lid', wa_lid: LID_A, inbox_state: 'unsure', inbox_since: NOW - DAY });
    h.db.insertLead({ ...base, lead_id: 'LEAD-lid-in', wa_lid: LID_B, inbox_state: 'in', inbox_since: NOW - DAY, history_from: NOW - 2 * DAY });
    h.push([
      msg({ id: 'R1', jid: LID_A, ts: NOW - 90_000, text: 'Hello\nRef BONA-W003 · K7Q2XR' }),
      msg({ id: 'R2', jid: LID_B, ts: NOW - 80_000, text: 'thanks' }),
    ]);
    const tally = await h.tick(); // eslint-disable-line no-await-in-loop
    const what = JSON.stringify(state);
    assert.equal(tally.joined, 0, what);
    assert.equal(h.lead('LEAD-lid').inbox_state, 'unsure', `${what}: no number anywhere, so no join`);
    assert.equal(h.lead('LEAD-lid').inbox_via, null, what);
    assert.deepEqual(h.rows('LEAD-lid'), [], what);
    assert.deepEqual(h.rows('LEAD-lid-in'), [['R2', 'in', 'client']], `${what}: a chat the owner moved in is not a join`);
    assert.deepEqual(h.calls.wake.map(([id]) => id), ['LEAD-lid-in'], what);
    assert.equal(h.db.countLeads(), 2, what);
    h.close();
  }
});

test('T06-4b guard: off Bona\'s number a lid-only Ref still makes a lead and joins, as today', async () => {
  for (const env of [PERSONAL, INVALID]) {
    const h = harness({ env, state: { ownInbox: true }, notes: 'stub' });
    seedSession(h);
    h.push([msg({ id: 'R1', jid: '300000000000071@lid', text: 'Hello\nRef BONA-W003 · K7Q2XR' })]);
    await h.tick(); // eslint-disable-line no-await-in-loop
    const [lead] = h.leads();
    assert.equal(lead?.match_method, 'ref', JSON.stringify(env));
    assert.equal(lead?.inbox_state, 'in', JSON.stringify(env));
    h.close();
  }
});

/* ---------------- 5: colleagues stay colleagues ---------------- */

test('T06-5 a colleague (users row + lid) stays excluded with the test on, by phone and by lid, even with a Ref line', async () => {
  for (const state of [{ active: true }, { active: true, ownInbox: true }]) {
    const h = harness({ state, owner: true });
    h.team.addUser({ name: 'Mona', phone: COLLEAGUE_DIGITS, role: 'staff' });
    learnTeamLid(h.db, COLLEAGUE_DIGITS, COLLEAGUE_LID);
    h.push([
      msg({ id: 'C1', jid: `${COLLEAGUE_DIGITS}@s.whatsapp.net`, pushName: 'Mona', text: 'Hi' }),
      msg({ id: 'C2', jid: COLLEAGUE_LID, pushName: 'Mona', ts: NOW - 50_000, text: 'Ref BONA-W003 · K7Q2XR' }),
      msg({ id: 'C3', jid: COLLEAGUE_LID, pushName: 'Mona', ts: NOW - 40_000, text: 'Hi' }),
    ]);
    const tally = await h.tick(); // eslint-disable-line no-await-in-loop
    assert.equal(tally.ignored, 3, JSON.stringify(state));
    assert.equal(h.db.countLeads(), 0);
    assert.deepEqual(h.candidates(), []);
    h.close();
  }
});

/* ---------------- 6: the owner joins only under his test ---------------- */

test('T06-6 the owner joins only while the test is active: method owner_test, inbox_via owner_test, no ad fan-out', async () => {
  const h = harness({ state: { active: false }, owner: true });
  h.push([msg({ id: 'OW0', jid: OWNER, pushName: 'Owner Example', ts: NOW - 300_000, text: 'Hi' })]);
  await h.tick();
  assert.equal(h.db.countLeads(), 0, 'test off: his number is a colleague\'s, ignored');

  h.setClock(NOW - 120_000);
  h.team.setSetting('owner_as_client', '1');
  h.setClock(NOW);
  h.state.active = true;
  h.push([msg({ id: 'OW1', jid: OWNER, pushName: 'Owner Example', ts: NOW - 60_000, text: 'Hi' })]);
  const tally = await h.tick();
  assert.equal(tally.joined, 1);
  const [lead] = h.leads();
  assert.equal(lead.phone_e164, OWNER_DIGITS);
  assert.equal(lead.match_method, 'owner_test');
  assert.equal(lead.inbox_via, 'owner_test');
  assert.equal(lead.inbox_state, 'in');
  assert.equal(h.fanout(), 0, 'no ad platform is told about the owner\'s own test');
  assert.deepEqual(h.rows(lead.lead_id), [['OW1', 'in', 'client']]);
  assert.deepEqual(h.calls.wake, [[lead.lead_id, NOW - 60_000]]);
  assert.deepEqual(h.calls.leadEvent, [{ leadId: lead.lead_id, why: 'joined', created: true, ts: NOW - 60_000 }]);
  h.close();
});

test("T06-6 the owner's test lead made by the poller starts his reply clock as a client's does: first_inbound_ts is his first message, first_reply_ts empty until a person answers (Codex PR #96 r6)", async () => {
  const h = harness({ state: { active: false }, owner: true });
  h.setClock(NOW - 120_000);
  h.team.setSetting('owner_as_client', '1');
  h.setClock(NOW);
  h.state.active = true;
  h.push([msg({ id: 'OW1', jid: OWNER, pushName: 'Owner Example', ts: NOW - 60_000, text: 'Hi' })]);
  assert.equal((await h.tick()).joined, 1);
  const [lead] = h.leads();
  assert.equal(lead.match_method, 'owner_test');
  assert.equal(lead.first_inbound_ts, NOW - 60_000, 'his first message starts the clock');
  assert.equal(lead.first_reply_ts, null, 'nobody has answered yet');
  // The first dashboard reply (its key recorded) stops it.
  const staff = h.team.addUser({ name: 'Mona', phone: COLLEAGUE_DIGITS, role: 'staff' });
  h.setClock(NOW - 31_000);
  h.inbox.insertOutbox({ send_id: 'SND-first', lead_id: lead.lead_id, jid: OWNER, text: 'Hello, how can we help?', user_id: staff.user_id, sender_kind: 'staff' });
  h.inbox.updateOutbox('SND-first', { status: 'accepted', key_id: 'STAFF1' });
  h.setClock(NOW);
  h.push([msg({ id: 'STAFF1', jid: OWNER, fromMe: true, pushName: null, ts: NOW - 30_000, text: 'Hello, how can we help?' })]);
  const tally = await h.tick();
  assert.equal(tally.replies, 1, 'the reply clock stamps');
  assert.equal(h.lead(lead.lead_id).first_reply_ts, NOW - 30_000, 'the first staff reply stops it');
  h.close();
});

test('T06-6 the owner never joins as own_number: with own_inbox on but the test off, he stays a colleague', async () => {
  const h = harness({ state: { ownInbox: true, active: false }, owner: true });
  h.push([msg({ id: 'OW1', jid: OWNER, pushName: 'Owner Example', text: 'Hi' })]);
  await h.tick();
  assert.equal(h.db.countLeads(), 0);
  h.close();
});

/* ---------------- 7: today's rule wherever the own rule is off ---------------- */

/** The records every rule-off case reads: a Ref, a keyword, a "Hi", a property question, the owner writing about a villa. */
const MIXED = () => [
  msg({ id: 'M1', jid: jidOf(31), pushName: 'Ali', ts: NOW - 90_000, text: 'Hello\nRef BONA-W003 · K7Q2XR' }),
  msg({ id: 'M2', jid: jidOf(32), pushName: 'Huda', ts: NOW - 80_000, text: 'Is this Bona?' }),
  msg({ id: 'M3', jid: jidOf(33), pushName: 'Omar', ts: NOW - 70_000, text: 'Hi' }),
  msg({ id: 'M4', jid: jidOf(34), pushName: 'Umm Khalid', ts: NOW - 60_000, text: 'is the villa still for sale?' }),
  msg({ id: 'M5', jid: jidOf(35), fromMe: true, pushName: null, ts: NOW - 50_000, text: 'the apartment is for rent' }),
];
function snapshot(h) {
  return {
    leads: h.leads().map((l) => [l.phone_e164, l.match_method, l.inbox_state, l.inbox_via, l.history_from]).sort(),
    messages: h.db.db.prepare('SELECT key_id, direction, sender_kind FROM wa_messages ORDER BY key_id').all().map((r) => ({ ...r })),
    candidates: h.candidates().map((r) => [r.phone_e164, r.jid, r.lid, r.name, r.words, r.last_dir, r.hits]),
    sent: h.sent.length,
  };
}
function seedSession(h) {
  h.db.upsertSession({ session_id: 'own-session-1', anon_id: 'c'.repeat(32), ref: 'K7Q2XR', started: NOW - 900_000, last_seen: NOW - 600_000, pages: 2, locale: 'en' });
}

test('T06-7 guard: on the personal number (ownNumber owner or invalid) it is today\'s rule exactly, whatever the test switch answers', async () => {
  for (const env of [PERSONAL, INVALID]) {
    const today = harness({ env, ownerTest: null, notes: null });
    seedSession(today);
    today.push(MIXED());
    await today.tick(); // eslint-disable-line no-await-in-loop
    // A switch that says yes to everything: the poller still never applies the own rule off Bona's number.
    const h = harness({ env, state: { ownInbox: true, active: true }, notes: 'stub' });
    seedSession(h);
    h.push(MIXED());
    await h.tick(); // eslint-disable-line no-await-in-loop
    assert.deepEqual(snapshot(h), snapshot(today), JSON.stringify(env));
    assert.equal(snapshot(today).candidates.length, 2, 'the shared rule keeps its property-word list');
    assert.deepEqual(h.calls.prune, [], 'no prune off Bona\'s number');
    today.close();
    h.close();
  }
});

test('T06-7 on Bona\'s number with own_inbox off, or before the identity check: today\'s rule, except no property-word row', async () => {
  for (const state of [{ ownInbox: false }, { ownInbox: true, ownNumberOk: false }, { ownInbox: false, ownNumberOk: false, active: true }]) {
    const h = harness({ state, notes: 'stub' });
    seedSession(h);
    h.push(MIXED());
    await h.tick(); // eslint-disable-line no-await-in-loop
    const s = snapshot(h);
    const what = JSON.stringify(state);
    assert.deepEqual(s.leads, [
      ['966500000031', 'ref', 'in', null, NOW - 90_000 - JOIN_HISTORY_MS],
      ['966500000032', 'keyword', 'unsure', null, null],
    ], what);
    assert.deepEqual(s.messages, [{ key_id: 'M1', direction: 'in', sender_kind: 'client' }], what);
    assert.deepEqual(s.candidates, [], `${what}: no chat with a phone is listed on Bona's number`);
    assert.equal(s.sent, 2, `${what}: today's new-enquiry note for each created lead`);
    h.close();
  }
});

test('T06-7 rollback guard: a lead with inbox_via set, while ownNumberOk is false, is not stored, not woken, never joins', async () => {
  const h = harness({ state: { ownNumberOk: false, ownInbox: true } });
  seedSession(h);
  seedLead(h, 'LEAD-via', 41, { inbox_state: 'in', inbox_since: NOW - DAY, history_from: NOW - 2 * DAY, inbox_via: 'own_number' });
  seedLead(h, 'LEAD-uv', 42, { inbox_state: 'unsure', inbox_since: NOW - DAY, inbox_via: 'own_number' });
  seedLead(h, 'LEAD-ot', 43, { inbox_state: null, inbox_via: 'owner_test' });
  h.push([
    msg({ id: 'V1', jid: jidOf(41), ts: NOW - 90_000, text: 'still there?' }),
    msg({ id: 'V2', jid: jidOf(41), fromMe: true, pushName: null, ts: NOW - 80_000, text: 'yes, see BONA-W003' }),
    msg({ id: 'V3', jid: jidOf(42), ts: NOW - 70_000, text: 'Ref BONA-W003 · K7Q2XR' }),
    msg({ id: 'V4', jid: jidOf(43), ts: NOW - 60_000, text: 'Is BONA-W003 available?' }),
  ]);
  const tally = await h.tick();
  assert.equal(tally.joined, 0);
  assert.deepEqual(h.rows('LEAD-via'), [], 'neither direction is stored');
  assert.equal(h.lead('LEAD-uv').inbox_state, 'unsure', 'a Ref line does not join it on the shared rule');
  assert.equal(h.lead('LEAD-ot').inbox_state, null);
  assert.deepEqual(h.calls.wake, []);
  assert.equal(h.messages(), 0);
  h.close();
});

test('T06-7 fail closed: a switch whose ownRuleFor and active say yes while ownNumberOk says no is today\'s rule (the poller asks it itself)', async () => {
  const today = harness({ state: { ownInbox: false }, notes: 'stub' });
  seedSession(today);
  today.push(MIXED());
  await today.tick();
  const h = harness({ state: { ownInbox: true, active: true, identityLapsed: true }, notes: 'stub', owner: true });
  seedSession(h);
  h.push([
    ...MIXED(),
    // The owner's lid: a colleague's while the identity check fails, whatever active() says.
    msg({ id: 'OWN-LID', jid: OWNER_LID, pushName: 'Owner Example', ts: NOW - 40_000, text: 'Hi' }),
    msg({ id: 'OWN-PH', jid: OWNER, pushName: 'Owner Example', ts: NOW - 30_000, text: 'Hi' }),
  ]);
  const tally = await h.tick();
  assert.deepEqual(snapshot(h), snapshot(today), 'no own-number join, no owner test join');
  assert.equal(tally.joined, 1, 'only the Ref joins, by its proof');
  assert.equal(tally.ignored, 1, 'the owner\'s lid is a team lid again');
  assert.equal(h.leads().filter((l) => l.phone_e164 === OWNER_DIGITS).length, 0, 'no lead for the owner');
  today.close();
  h.close();
});

test('T06-7 fail closed at retry time: a record judged under the own rule or the test, retried after the identity check lapsed, joins nothing', async () => {
  for (const owner of [false, true]) {
    const h = harness({ state: owner ? { active: true } : { ownInbox: true }, owner });
    const realSet = h.inbox.setInboxState;
    let fails = 1;
    h.inbox.setInboxState = (...a) => {
      if (fails > 0) { fails -= 1; throw new Error('store busy'); }
      return realSet(...a);
    };
    const rec = owner
      ? msg({ id: 'J1', jid: OWNER, pushName: 'Owner Example', text: 'Hi' })
      : msg({ id: 'J1', text: 'Hi' });
    h.push([rec]);
    const first = await h.tick(); // eslint-disable-line no-await-in-loop
    const what = owner ? 'owner test' : 'own number';
    assert.equal(first.joined, 0, `${what}: the join failed on the first attempt`);
    h.state.identityLapsed = true;
    h.push([rec]);
    const second = await h.tick(); // eslint-disable-line no-await-in-loop
    assert.equal(second.joined, 0, `${what}: no join on the retry`);
    assert.equal(h.messages(), 0, `${what}: nothing stored`);
    const [lead] = h.leads();
    assert.equal(lead.inbox_via, null, `${what}: never stamped`);
    if (!owner) assert.equal(lead.inbox_state, 'unsure', 'today\'s rule: a "Hi" with no signal from a known lead goes to Unsure');
    else assert.equal(lead.inbox_state, null, 'his test lead is not left `in` without its marker');
    assert.deepEqual(h.calls.wake, [], what);
    assert.deepEqual(h.calls.leadEvent, [], what);
    h.close();
  }
});

test('T06-7 fail closed at retry time: the switches are read again too, so a retry after "#dana live off" (or the test going off) joins nothing', async () => {
  for (const owner of [false, true]) {
    const h = harness({ state: owner ? { active: true } : { ownInbox: true }, owner });
    const realSet = h.inbox.setInboxState;
    let fails = 1;
    h.inbox.setInboxState = (...a) => {
      if (fails > 0) { fails -= 1; throw new Error('store busy'); }
      return realSet(...a);
    };
    const rec = owner
      ? msg({ id: 'J1', jid: OWNER, pushName: 'Owner Example', text: 'Hi' })
      : msg({ id: 'J1', text: 'Hi' });
    h.push([rec]);
    const first = await h.tick(); // eslint-disable-line no-await-in-loop
    const what = owner ? 'owner test' : 'own number';
    assert.equal(first.joined, 0, `${what}: the join failed on the first attempt`);
    // The identity check still passes; only the switch changed in between.
    if (owner) h.state.active = false; else h.state.ownInbox = false;
    h.push([rec]);
    const second = await h.tick(); // eslint-disable-line no-await-in-loop
    assert.equal(second.joined, 0, `${what}: no join on the retry`);
    assert.equal(h.messages(), 0, `${what}: nothing stored`);
    const leads = h.leads();
    assert.equal(leads.length, 1, what);
    assert.equal(leads[0].inbox_via, null, `${what}: never stamped`);
    if (!owner) assert.equal(leads[0].inbox_state, 'unsure', 'today\'s rule: a "Hi" with no signal from a known lead goes to Unsure');
    else assert.equal(leads[0].inbox_state, null, 'his test lead is not left `in` without its marker');
    assert.deepEqual(h.calls.wake, [], `${what}: Dana is not woken`);
    assert.deepEqual(h.calls.leadEvent, [], what);
    h.close();
  }
});

test('T06-7 an identity lapse while a join reads its history holds the record: the chat is in and stamped, but nothing is stored, no wake, no "joined" note', async () => {
  // Inbound under the own rule, and a fromMe Bona link into an Unsure chat that joined under it before.
  for (const side of ['inbound', 'outbound']) {
    const h = harness({ state: { ownInbox: true } });
    if (side === 'outbound') seedLead(h, 'LEAD-uv', 42, { inbox_state: 'unsure', inbox_since: NOW - DAY, inbox_via: 'own_number' });
    const realHistory = h.backfill.history;
    let reads = 0;
    h.backfill.history = async (lead, w) => {
      reads += 1;
      const got = await realHistory(lead, w);
      h.state.identityLapsed = true; // the probe answered "mismatch" while the read was out
      return got;
    };
    h.push([side === 'inbound'
      ? msg({ id: 'HI1', text: 'Hi' })
      : msg({ id: 'OUT1', jid: jidOf(42), fromMe: true, pushName: null, text: 'see BONA-W003' })]);
    const tally = await h.tick(); // eslint-disable-line no-await-in-loop
    assert.equal(reads, 1, `${side}: the join read its history`);
    assert.equal(tally.joined, 1, `${side}: the join was written before the read`);
    assert.equal(tally.held, 1, `${side}: then the record is held`);
    assert.equal(tally.stored, 0, side);
    assert.equal(h.messages(), 0, `${side}: nothing stored`);
    const [lead] = h.leads();
    assert.equal(lead.inbox_state, 'in', side);
    assert.equal(lead.inbox_via, 'own_number', `${side}: the rollback guard's key is there for the next record`);
    assert.deepEqual(h.calls.wake, [], `${side}: Dana is not woken`);
    assert.deepEqual(h.calls.notify, [], `${side}: no phone alert`);
    assert.deepEqual(h.calls.leadEvent, [], `${side}: no "joined" note`);
    h.close();
  }
});

test('T06-7 an identity lapse (or the test going off) while the "joined" note is out holds the joining record: not stored, no wake', async () => {
  const cases = [
    { what: 'own number, identity', state: { ownInbox: true }, owner: false, lapse: (st) => { st.identityLapsed = true; } },
    { what: 'owner test, identity', state: { active: true }, owner: true, lapse: (st) => { st.identityLapsed = true; } },
    { what: 'owner test, test off', state: { active: true }, owner: true, lapse: (st) => { st.active = false; } },
  ];
  for (const c of cases) {
    const events = [];
    let h = null;
    const notes = {
      ...fakeNotes({ leadEvent: [], alert: [] }),
      leadEvent: async (lead, o) => { events.push({ leadId: lead.lead_id, ...o }); c.lapse(h.state); },
    };
    h = harness({ state: c.state, owner: c.owner, notes });
    h.push([c.owner
      ? msg({ id: 'J1', jid: OWNER, pushName: 'Owner Example', text: 'Hi' })
      : msg({ id: 'J1', text: 'Hi' })]);
    const tally = await h.tick(); // eslint-disable-line no-await-in-loop
    assert.equal(tally.joined, 1, c.what);
    assert.equal(events.length, 1, `${c.what}: the note went before the lapse`);
    assert.equal(tally.held, 1, `${c.what}: held after it`);
    assert.equal(h.messages(), 0, `${c.what}: nothing stored`);
    assert.deepEqual(h.calls.wake, [], `${c.what}: Dana is not woken`);
    assert.deepEqual(h.calls.notify, [], `${c.what}: no phone alert`);
    h.close();
  }
});

test('T06-7 an identity lapse while the record is being stored still keeps Dana asleep (the guard sits right before the wake)', async () => {
  for (const owner of [false, true]) {
    let h = null;
    h = harness({
      state: owner ? { active: true } : { ownInbox: true }, owner,
      beforeIngest: () => { h.state.identityLapsed = true; },
    });
    h.push([owner
      ? msg({ id: 'J1', jid: OWNER, pushName: 'Owner Example', text: 'Hi' })
      : msg({ id: 'J1', text: 'Hi' })]);
    await h.tick(); // eslint-disable-line no-await-in-loop
    const what = owner ? 'owner test' : 'own number';
    // Refusing the record itself is ingest's (PR-A2, `rule_off`); the wake is the poller's.
    assert.deepEqual(h.calls.wake, [], `${what}: Dana is not woken`);
    assert.deepEqual(h.calls.notify, [], `${what}: no phone alert`);
    h.close();
  }
});

/* ---------------- 8: owner commands ---------------- */

test('T06-8 a "#dana test on" record goes to ownerTest.command before the team drop and is consumed: seen, not stored, no wake', async () => {
  for (const active of [false, true]) {
    for (const jid of [OWNER, OWNER_LID]) {
      const h = harness({ state: { active }, owner: true });
      h.push([msg({ id: 'CMD1', jid, pushName: 'Owner Example', text: '#dana test on' })]);
      const tally = await h.tick(); // eslint-disable-line no-await-in-loop
      const what = `active=${active} by ${jid === OWNER ? 'phone' : 'lid'}`;
      assert.deepEqual(h.calls.command, ['CMD1'], what);
      assert.deepEqual(h.calls.excluded, [], `${what}: before the team drop (no exclusion asked)`);
      assert.equal(tally.commands, 1, what);
      assert.equal(h.db.waSeenHas('CMD1'), true, `${what}: marked seen`);
      assert.equal(h.db.countLeads(), 0, what);
      assert.equal(h.messages(), 0, what);
      assert.deepEqual(h.calls.wake, [], what);
      noLogLeak(h, '#dana', '966500000001', '100000000000001');
      h.close();
    }
  }
});

test('T06-8 a record command() does not take goes on as before; one it takes asynchronously is consumed; one that throws is logged, not fatal', async () => {
  const h = harness({ state: { active: false }, owner: true });
  h.push([
    msg({ id: 'N1', jid: OWNER, text: 'how are you' }),
    msg({ id: 'N2', jid: jidOf(51), ts: NOW - 50_000, text: '#dana test on' }),
  ]);
  const t1 = await h.tick();
  assert.deepEqual(h.calls.command, ['N1', 'N2']);
  assert.equal(t1.commands, 0, 'not the owner, or not a command: not consumed');
  assert.equal(t1.ignored, 1, 'handled the usual way: the owner is a colleague while his test is off');
  assert.equal(t1.unmatched, 1, "a stranger's '#dana' text is judged like any other");

  h.state.commandImpl = async () => true;
  h.push([msg({ id: 'A1', jid: OWNER, ts: NOW - 40_000, text: '#dana status' })]);
  assert.equal((await h.tick()).commands, 1);

  h.state.commandImpl = () => { throw new Error('boom 966500000001'); };
  h.push([msg({ id: 'T1', jid: OWNER, ts: NOW - 30_000, text: '#dana summary' })]);
  const t3 = await h.tick();
  assert.equal(t3.commands, 0);
  assert.ok(h.logs.some((l) => l.evt === 'poll.command_failed'));
  assert.equal(h.db.countLeads(), 0);
  noLogLeak(h, 'boom', '966500000001');
  h.close();
});

/* ---------------- 9: our own notes, read back ---------------- */

test('T06-9 OWN_NOTE_RE matches all 8 note headers (the renamed "assistant stopped" included) and no client text', () => {
  const re = pollerModule.OWN_NOTE_RE;
  assert.ok(re instanceof RegExp, 'exported');
  const headers = ['new enquiry', 'hand-over', 'viewing booked', 'assistant stopped', 'daily summary', 'test mode', 'alert', 'email'];
  for (const h of headers) {
    assert.ok(re.test(`*Bona — ${h}*\nName: Sara`), h);
    assert.ok(re.test(`Bona — ${h}`), `${h}, no stars`);
  }
  for (const text of [
    'Bona — new enquiry', // today's header still matches
    '*Bona — hand-over*\nSara (WhatsApp)\n\n*Bona — new enquiry*\nName: Ali',
  ]) assert.ok(re.test(text), text);
  for (const text of [
    'Hi Bona, is the villa still for sale?', 'Bona - new enquiry', 'bona — new enquiry', '*Bona — Dana stopped*', 'Hello\n*Bona — alert*',
    'Ref BONA-W003 · K7Q2XR', 'مرحبا بونا', '*Bona* — alert', 'Bona —alert', 'I saw Bona — alert me when it is free',
  ]) assert.ok(!re.test(text), text);
});

test('T06-9 a header line may carry what the note renders after it on that line: the daily summary\'s date (DESIGN §7.3), a hand-over\'s name and reason', () => {
  const re = pollerModule.OWN_NOTE_RE;
  for (const text of [
    '*Bona — daily summary* · Thu 27 Nov',
    '*Bona — daily summary* · Thu 27 Nov\nNew clients: 6 (WhatsApp 5 · email 1) — 2 booked a viewing',
    '*Bona — daily summary* · Thu 27 Nov (covers 2 days)\r\nAI: 41 answers',
    '*Bona — hand-over* · Sara (WhatsApp) · asked for a person\nLast message: "…"',
    '*Bona — test mode* ON · as a client\nBONA-W012',
    'Bona — alert · link down',
  ]) assert.ok(re.test(text), text);
  for (const text of [
    '*Bona — daily summary* Thu 27 Nov', '*Bona — daily summary*· Thu 27 Nov', '*Bona — daily summary* ·Thu 27 Nov',
    '*Bona — daily summary*s · Thu', 'Bona — summary · Thu 27 Nov', '*Bona — daily summary · Thu 27 Nov',
  ]) assert.ok(!re.test(text), text);
});

/** Codex PR #96 r4: a client's message whose FIRST line is exactly a header, the rest of it his question. */
const HEADER_FIRST = 'Bona — email\nPlease send me the floor plan for BONA-W003';

test('T06-9 on Bona\'s number no inbound record is judged by its text: a client\'s message that opens with a header line is stored and wakes Dana, switches off and on', async () => {
  for (const state of [{ ownInbox: false, active: false }, { ownInbox: true, active: true }]) {
    const h = harness({ state, owner: true });
    seedLead(h, 'LEAD-in', 67, { inbox_state: 'in', inbox_since: NOW - DAY, history_from: NOW - 2 * DAY });
    h.push([
      msg({ id: 'E1', jid: jidOf(67), ts: NOW - 90_000, text: HEADER_FIRST }),
      msg({ id: 'E2', jid: jidOf(65), ts: NOW - 80_000, text: HEADER_FIRST }),
      msg({ id: 'E3', jid: jidOf(66), ts: NOW - 70_000, text: '*Bona — daily summary* · Thu 27 Nov\nis BONA-W012 still free?' }),
    ]);
    const tally = await h.tick(); // eslint-disable-line no-await-in-loop
    const what = JSON.stringify(state);
    assert.equal(tally.ignored, 0, `${what}: none of them is our own note`);
    assert.deepEqual(h.rows('LEAD-in'), [['E1', 'in', 'client']], `${what}: stored in its inbox chat`);
    const fresh = h.leads().filter((l) => l.lead_id !== 'LEAD-in');
    assert.deepEqual(fresh.map((l) => [l.phone_e164, l.listing_id, l.inbox_state]).sort(), [
      ['966500000065', 'BONA-W003', 'in'], ['966500000066', 'BONA-W012', 'in'],
    ], `${what}: enquiries with a listing id, as any client's`);
    for (const l of fresh) assert.equal(h.rows(l.lead_id).length, 1, `${what}: ${l.phone_e164} stored`);
    assert.deepEqual(h.calls.wake.map(([id]) => id).sort(), ['LEAD-in', ...fresh.map((l) => l.lead_id)].sort(), `${what}: Dana is woken for each`);
    h.close();
  }
});

test('T06-9 the owner\'s own message in his test chat is never a note by its text: the same lines inbound from him join and are stored', async () => {
  const h = harness({ state: { active: true }, owner: true });
  h.push([msg({ id: 'HIS1', jid: OWNER, pushName: 'Owner Example', ts: NOW - 60_000, text: HEADER_FIRST })]);
  const t1 = await h.tick();
  assert.equal(t1.ignored, 0);
  const [lead] = h.leads();
  assert.equal(lead?.inbox_via, 'owner_test', 'his test chat joins on it');
  assert.deepEqual(h.rows(lead.lead_id), [['HIS1', 'in', 'client']]);
  assert.deepEqual(h.calls.wake, [[lead.lead_id, NOW - 60_000]]);
  // A summary he sends back to Bona's number (a forward, a paste) is his message too.
  h.push([msg({ id: 'HIS2', jid: OWNER, pushName: 'Owner Example', ts: NOW - 30_000, text: '*Bona — daily summary* · Thu 27 Nov\nwhy 2 hand-overs?' })]);
  await h.tick();
  assert.deepEqual(h.rows(lead.lead_id), [['HIS1', 'in', 'client'], ['HIS2', 'in', 'client']]);
  h.close();
});

test('T06-9 our own note in the owner\'s chat on Bona\'s number is never his chat\'s: known by its outbox key, else by its header line (the summary\'s date included)', async () => {
  const h = harness({ state: { active: true }, owner: true });
  h.db.insertLead({
    lead_id: 'LEAD-own', created: NOW - DAY, updated: NOW - DAY, phone_e164: OWNER_DIGITS, wa_jid: OWNER, wa_lid: OWNER_LID,
    channel: 'whatsapp', match_method: 'owner_test', stage: 'new', inbox_state: 'in', inbox_since: NOW - DAY, history_from: NOW - DAY,
    inbox_via: 'owner_test',
  });
  // A note whose send came back with its message id: its outbox row (no text, no lead) names it, whatever its first line says.
  h.inbox.insertOutbox({ send_id: 'SND-note', jid: OWNER, sender_kind: 'note', status: 'pending' });
  h.inbox.updateOutbox('SND-note', { status: 'accepted', key_id: 'NOTE-BY-KEY' });
  h.push([
    // A send that went uncertain recorded no id: its header line is the net.
    msg({ id: 'SUM', jid: OWNER, fromMe: true, pushName: null, ts: NOW - 90_000,
      text: `*Bona — daily summary* · Thu 27 Nov\nNew clients: 6 (WhatsApp 5 · email 1)\nWaiting for you: 3 → ${SITE}/dashboard/inbox` }),
    msg({ id: 'NOTE-BY-KEY', jid: OWNER, fromMe: true, pushName: null, ts: NOW - 80_000, text: 'Sara (WhatsApp) asked for a person\nBONA-W012' }),
    msg({ id: 'BYLID', jid: OWNER_LID, fromMe: true, pushName: null, ts: NOW - 70_000, text: `*Bona — alert* · link down\n${SITE}/dashboard/inbox` }),
  ]);
  const tally = await h.tick();
  assert.equal(tally.ignored, 3, 'all three are our own notes');
  assert.equal(h.messages(), 0, 'nothing stored in his test chat');
  assert.equal(tally.replies, 0, 'a note is no reply to his test');
  assert.equal(h.lead('LEAD-own').first_reply_ts, null);
  assert.equal(h.lead('LEAD-own').updated, NOW - DAY);
  // An answer in his chat that is not a note is still his chat's.
  h.push([msg({ id: 'REAL', jid: OWNER, fromMe: true, pushName: null, ts: NOW - 30_000, text: 'we will send the floor plan today' })]);
  const t2 = await h.tick();
  assert.equal(t2.ignored, 0);
  assert.deepEqual(h.rows('LEAD-own').map(([k, d]) => [k, d]), [['REAL', 'out']]);
  h.close();
});

/** Codex PR #96 r5: a dashboard reply (or Dana's) in the owner's test chat whose FIRST line is exactly a header line. */
const REPLY_HEADER_FIRST = 'Bona — email\nWe will send the floor plan for BONA-W003 today';

/** The owner's test chat, `in`, waiting for a person (`needs_human`), nobody handling it yet. */
function ownerTestChat(h) {
  h.db.insertLead({
    lead_id: 'LEAD-own', created: NOW - DAY, updated: NOW - DAY, phone_e164: OWNER_DIGITS, wa_jid: OWNER, wa_lid: OWNER_LID,
    channel: 'whatsapp', match_method: 'owner_test', stage: 'new', inbox_state: 'in', inbox_since: NOW - DAY, history_from: NOW - DAY,
    inbox_via: 'owner_test', needs_human: 1,
  });
}

test('T06-9 a staff reply in the owner\'s test chat that opens with a header line and whose send went uncertain is ingest\'s to reconcile by its exact text: stored as staff, the human-reply updates done', async () => {
  for (const status of ['uncertain', 'pending']) {
    const h = harness({ state: { active: true }, owner: true });
    ownerTestChat(h);
    const staff = h.team.addUser({ name: 'Mona', phone: COLLEAGUE_DIGITS, role: 'staff' });
    // The dashboard writes its row before the HTTP call; the 2xx never came back (or has not yet), so no key.
    h.setClock(NOW - 61_000);
    h.inbox.insertOutbox({ send_id: 'SND-staff', lead_id: 'LEAD-own', jid: OWNER, text: REPLY_HEADER_FIRST, user_id: staff.user_id, sender_kind: 'staff' });
    if (status === 'uncertain') h.inbox.updateOutbox('SND-staff', { status: 'uncertain' });
    h.setClock(NOW);
    h.push([msg({ id: 'STAFF1', jid: OWNER, fromMe: true, pushName: null, ts: NOW - 60_000, text: REPLY_HEADER_FIRST })]);
    const tally = await h.tick(); // eslint-disable-line no-await-in-loop
    assert.equal(tally.ignored, 0, `${status}: not our own note`);
    assert.deepEqual(h.rows('LEAD-own'), [['STAFF1', 'out', 'staff']], `${status}: stored as the staff reply it is`);
    const row = h.inbox.getOutbox('SND-staff');
    assert.deepEqual([row.status, row.key_id], ['accepted', 'STAFF1'], `${status}: the send is resolved by its text`);
    const lead = h.lead('LEAD-own');
    assert.equal(lead.last_human_out_ts, NOW - 60_000, `${status}: a person answered`);
    assert.equal(lead.needs_human, 0, `${status}: the hand-over flag is cleared`);
    assert.equal(lead.handler_user_id, staff.user_id, `${status}: the one who answered handles it`);
    assert.equal(tally.replies, 1, `${status}: the reply clock stamps`);
    assert.equal(lead.first_reply_ts, NOW - 60_000);
    h.close();
  }
});

test('T06-9 an outbox row the record\'s key names settles it in the owner\'s chat: a staff or Dana send that opens with a header line is never dropped as a note', async () => {
  const h = harness({ state: { active: true }, owner: true });
  ownerTestChat(h);
  const staff = h.team.addUser({ name: 'Mona', phone: COLLEAGUE_DIGITS, role: 'staff' });
  h.setClock(NOW - 120_000);
  h.inbox.insertOutbox({ send_id: 'SND-dana', lead_id: 'LEAD-own', jid: OWNER, text: REPLY_HEADER_FIRST, sender_kind: 'dana' });
  h.inbox.updateOutbox('SND-dana', { status: 'accepted', key_id: 'DANA-K' });
  h.inbox.insertOutbox({ send_id: 'SND-staff', lead_id: 'LEAD-own', jid: OWNER, text: '*Bona — alert*\nthe villa is still free', user_id: staff.user_id, sender_kind: 'staff' });
  h.inbox.updateOutbox('SND-staff', { status: 'accepted', key_id: 'STAFF-K' });
  h.setClock(NOW);
  h.push([msg({ id: 'DANA-K', jid: OWNER, fromMe: true, pushName: null, ts: NOW - 110_000, text: REPLY_HEADER_FIRST })]);
  const t1 = await h.tick();
  assert.equal(t1.ignored, 0, 'Dana\'s answer is no note');
  assert.deepEqual(h.rows('LEAD-own'), [['DANA-K', 'out', 'dana']]);
  assert.equal(t1.replies, 0, 'Dana\'s own message is no human reply');
  assert.equal(h.lead('LEAD-own').first_reply_ts, null);
  assert.equal(h.lead('LEAD-own').needs_human, 1);
  // By its key, even with no text match to fall back on (the record's text differs from the row's).
  h.push([msg({ id: 'STAFF-K', jid: OWNER_LID, fromMe: true, pushName: null, ts: NOW - 100_000, text: '*Bona — alert*\nthe villa is still free (edited)' })]);
  const t2 = await h.tick();
  assert.equal(t2.ignored, 0, 'the staff reply is no note');
  assert.deepEqual(h.rows('LEAD-own'), [['DANA-K', 'out', 'dana'], ['STAFF-K', 'out', 'staff']]);
  assert.equal(t2.replies, 1);
  assert.equal(h.lead('LEAD-own').needs_human, 0);
  assert.equal(h.lead('LEAD-own').handler_user_id, staff.user_id);
  h.close();
});

test('T06-9 guard: a note with no key in the owner\'s chat is still dropped by its header line when no open staff or Dana send of his chat matches it as ingest would', async () => {
  const h = harness({ state: { active: true }, owner: true });
  ownerTestChat(h);
  const staff = h.team.addUser({ name: 'Mona', phone: COLLEAGUE_DIGITS, role: 'staff' });
  const ts = NOW - 60_000;
  const note = `*Bona — alert* · link down\n${SITE}/dashboard/inbox`;
  const sends = [
    // A different text, open.
    ['SND-other', ts - 1_000, 'uncertain', `*Bona — alert* · link up\n${SITE}/dashboard/inbox`, null],
    // The same text, but already resolved by another record's key.
    ['SND-done', ts - 1_000, 'accepted', note, 'OTHER-K'],
    // The same text, but failed: it never reached WhatsApp.
    ['SND-failed', ts - 1_000, 'failed', note, null],
    // The same text, open, but outside ingest's window either way (RESOLVE_WINDOW_MS, SEND_SKEW_MS).
    ['SND-old', ts - RESOLVE_WINDOW_MS - 1_000, 'uncertain', note, null],
    ['SND-late', ts + SEND_SKEW_MS + 1_000, 'uncertain', note, null],
  ];
  for (const [id, created, status, text, key] of sends) {
    h.setClock(created);
    h.inbox.insertOutbox({ send_id: id, lead_id: 'LEAD-own', jid: OWNER, text, user_id: staff.user_id, sender_kind: 'staff' });
    if (status !== 'pending') h.inbox.updateOutbox(id, { status, ...(key ? { key_id: key } : {}) });
  }
  // A note's own row keeps no text (lib/inbox/store.mjs): an uncertain note is never found by it.
  h.setClock(ts - 1_000);
  h.inbox.insertOutbox({ send_id: 'SND-note', jid: OWNER, text: note, sender_kind: 'note' });
  h.inbox.updateOutbox('SND-note', { status: 'uncertain' });
  h.setClock(NOW);
  h.push([msg({ id: 'NOTE1', jid: OWNER, fromMe: true, pushName: null, ts, text: note })]);
  const tally = await h.tick();
  assert.equal(tally.ignored, 1, 'our own note');
  assert.equal(h.messages(), 0, 'nothing stored in his test chat');
  assert.equal(tally.replies, 0);
  assert.deepEqual(['SND-other', 'SND-old', 'SND-late'].map((id) => h.inbox.getOutbox(id).status), ['uncertain', 'uncertain', 'uncertain'], 'no send was resolved by it');
  assert.equal(h.lead('LEAD-own').needs_human, 1);
  assert.equal(h.lead('LEAD-own').first_reply_ts, null);
  h.close();
});

test('T06-9 the edges of the text match are ingest\'s own (RESOLVE_WINDOW_MS, SEND_SKEW_MS): a send written exactly at either edge is reconciled, not dropped', async () => {
  for (const offset of [-RESOLVE_WINDOW_MS, SEND_SKEW_MS]) {
    const h = harness({ state: { active: true }, owner: true });
    ownerTestChat(h);
    const ts = NOW - 60_000;
    h.setClock(ts + offset);
    h.inbox.insertOutbox({ send_id: 'SND-staff', lead_id: 'LEAD-own', jid: OWNER, text: REPLY_HEADER_FIRST, sender_kind: 'staff', status: 'uncertain' });
    h.setClock(NOW);
    h.push([msg({ id: 'EDGE', jid: OWNER, fromMe: true, pushName: null, ts, text: REPLY_HEADER_FIRST })]);
    const tally = await h.tick(); // eslint-disable-line no-await-in-loop
    assert.equal(tally.ignored, 0, `offset ${offset}`);
    assert.deepEqual(h.rows('LEAD-own'), [['EDGE', 'out', 'staff']], `offset ${offset}`);
    h.close();
  }
});

test('T06-9 on Bona\'s number a fromMe message in a client\'s chat is never a note by its text: it is stored, and joins, as any of his', async () => {
  const h = harness({ state: { ownInbox: false } });
  seedLead(h, 'LEAD-in', 68, { inbox_state: 'in', inbox_since: NOW - DAY, history_from: NOW - 2 * DAY });
  h.push([
    msg({ id: 'F1', jid: jidOf(68), fromMe: true, pushName: null, ts: NOW - 90_000, text: '*Bona — daily summary* · Thu 27 Nov\nyour viewing is at 12:00' }),
    msg({ id: 'F2', jid: jidOf(69), fromMe: true, pushName: null, ts: NOW - 80_000, text: `*Bona — new enquiry*\nBONA-W003 ${SITE}/properties/bona-w003/` }),
  ]);
  const tally = await h.tick();
  assert.equal(tally.ignored, 0);
  assert.deepEqual(h.rows('LEAD-in').map(([k, d]) => [k, d]), [['F1', 'out']], 'stored in its inbox chat');
  const made = h.leads().find((l) => l.phone_e164 === digitsOf(69));
  assert.deepEqual([made?.match_method, made?.inbox_state], ['owner_outbound', 'in'], 'a Bona link he sends a stranger joins, as today');
  assert.deepEqual(h.rows(made.lead_id).map(([k, d]) => [k, d]), [['F2', 'out']]);
  h.close();
});

test('T06-9 guard: on the personal number the belt is today\'s, byte for byte: only a new-enquiry first line is skipped; any other header is a client\'s', async () => {
  for (const env of [PERSONAL, INVALID]) {
    const h = harness({ env, ownerTest: null, notes: null });
    h.push([
      // Today's: our new-lead note read back as inbound, here by a bare lid (wa-poller.test.mjs pins the same).
      msg({ id: 'N1', jid: '272516946294519@lid', ts: NOW - 95_000, text: '*Bona — new enquiry*\nName: Sara\nProperty: BONA-W003' }),
      msg({ id: 'N2', jid: jidOf(67), fromMe: true, pushName: null, ts: NOW - 92_000, text: `*Bona — new enquiry*\nBONA-W003 ${SITE}/properties/bona-w003/` }),
      msg({ id: 'E1', jid: jidOf(65), ts: NOW - 90_000, text: HEADER_FIRST }),
      msg({ id: 'E2', jid: jidOf(66), ts: NOW - 80_000, text: '*Bona — alert*\nis BONA-W012 still free?' }),
      msg({ id: 'F1', jid: jidOf(68), fromMe: true, pushName: null, ts: NOW - 70_000, text: `*Bona — alert*\nBONA-W005 ${SITE}/properties/bona-w005/` }),
    ]);
    const tally = await h.tick(); // eslint-disable-line no-await-in-loop
    const what = JSON.stringify(env);
    assert.equal(tally.ignored, 1, `${what}: only the inbound new-enquiry note`);
    assert.deepEqual(h.leads().map((l) => [l.phone_e164, l.match_method, l.listing_id]).sort(), [
      ['966500000065', 'keyword', 'BONA-W003'], ['966500000066', 'keyword', 'BONA-W012'], ['966500000068', 'owner_outbound', 'BONA-W005'],
    ], `${what}: a fromMe new-enquiry note makes no lead (today); the rest are as any message`);
    h.close();
  }
});

test('T06-9 OWN_NOTE_RE takes a whole header line only: a client message that merely starts like one is never dropped', async () => {
  const re = pollerModule.OWN_NOTE_RE;
  for (const text of [
    'Bona — email me the floor plan for BONA-W003',
    'Bona — alert me when BONA-W003 is free',
    '*Bona — alert* me when BONA-W003 is free',
    'Bona — new enquiry about BONA-W003',
    'Bona — test mode? is BONA-W003 real',
    '*Bona — email*please send the price list',
    '*Bona — daily summary*s',
    '*Bona — test mode* ONLY BONA-W003',
    '*Bona — alert', 'Bona — alert*', '**Bona — alert**',
  ]) assert.ok(!re.test(text), text);
  for (const text of [
    '*Bona — alert*', 'Bona — email', '*Bona — alert*\r\nBONA-W012', '*Bona — daily summary* \nBONA-W012',
    '*Bona — test mode* ON\nAs a client: BONA-W012', '*Bona — test mode* OFF',
  ]) assert.ok(re.test(text), text);

  const h = harness({ state: { ownInbox: false }, notes: 'stub' });
  seedLead(h, 'LEAD-in', 67, { inbox_state: 'in', inbox_since: NOW - DAY, history_from: NOW - 2 * DAY });
  h.push([
    msg({ id: 'E1', jid: jidOf(65), ts: NOW - 90_000, text: 'Bona — email me the floor plan for BONA-W003' }),
    msg({ id: 'E2', jid: jidOf(66), ts: NOW - 80_000, text: '*Bona — alert* me when BONA-W003 is free' }),
    msg({ id: 'E3', jid: jidOf(67), ts: NOW - 70_000, text: 'Bona — email me the price list please' }),
  ]);
  const tally = await h.tick();
  assert.equal(tally.ignored, 0, 'none of them is our own note');
  assert.deepEqual(h.leads().filter((l) => l.lead_id !== 'LEAD-in').map((l) => [l.phone_e164, l.listing_id, l.inbox_state]).sort(), [
    ['966500000065', 'BONA-W003', 'in'], ['966500000066', 'BONA-W003', 'in'],
  ], 'enquiries with a listing id, as any client\'s');
  assert.deepEqual(h.rows('LEAD-in'), [['E3', 'in', 'client']], 'stored in an inbox chat');
  h.close();
});

/* ---------------- 11: the (z) cases with today's stubs wired in ---------------- */

test('T06-11 guard: with today\'s stubs wired, the owner\'s personal chat on Bona\'s number is still a team chat, and a client Ref still sends one note', async () => {
  const h = harness({ ownerTest: 'stub', notes: 'stub', owner: true });
  const note = leadNote({ name: 'Sara', phone_e164: '966500000000', listing_id: 'BONA-W003', channel: 'whatsapp', created: NOW }, { siteUrl: SITE });
  seedSession(h);
  h.push([
    msg({ id: 'P-NOTE', fromMe: true, jid: OWNER, pushName: null, ts: NOW - 90_000, text: note }),
    msg({ id: 'P-IN', jid: OWNER, pushName: 'Owner Example', ts: NOW - 80_000, text: 'Ref BONA-W003 · K7Q2XR' }),
  ]);
  const t1 = await h.tick();
  assert.equal(t1.ignored, 2);
  assert.equal(h.db.countLeads(), 0);
  assert.equal(h.sent.length, 0);
  h.push([msg({ id: 'C1', jid: jidOf(70), ts: NOW - 30_000, text: 'Hello\nRef BONA-W003 · K7Q2XR' })]);
  const t2 = await h.tick();
  assert.equal(t2.created, 1);
  const [lead] = h.leads();
  assert.deepEqual(h.sent, [leadNote(lead, { siteUrl: SITE })], 'one note, today\'s text, through the notes stub');
  assert.equal(lead.inbox_via, null);
  h.close();
});

/* ---------------- 12: the owner's fromMe records never touch his lead ---------------- */

const NOTE_HEADS = ['new enquiry', 'hand-over', 'viewing booked', 'assistant stopped', 'daily summary', 'test mode', 'alert', 'email'];
function ownerFromMe() {
  const out = [
    msg({ id: 'CALL', jid: OWNER, fromMe: true, pushName: null, ts: NOW - 300_000,
      text: '📞 Bona line call — Thu 3 Dec 11:40\nCaller: +966 50 000 0011\nListings: BONA-W012' }),
    msg({ id: 'MERGED', jid: OWNER, fromMe: true, pushName: null, ts: NOW - 290_000,
      text: `*Bona — hand-over*\nSara (WhatsApp)\nLead: ${SITE}/dashboard/leads/LEAD-x\n\n*Bona — new enquiry*\nProperty: BONA-W012\n${SITE}` }),
    msg({ id: 'BYLID', jid: OWNER_LID, fromMe: true, pushName: null, ts: NOW - 280_000, text: `*Bona — alert*\nBONA-W012 ${SITE}/properties/bona-w012/` }),
  ];
  NOTE_HEADS.forEach((x, i) => out.push(msg({
    id: `NOTE${i}`, jid: OWNER, fromMe: true, pushName: null, ts: NOW - 270_000 + i * 1000,
    text: `*Bona — ${x}*\nProperty: BONA-W012\n${SITE}/properties/bona-w012/`,
  })));
  return out;
}

test('T06-12 with the test on, Bona\'s fromMe lines to the owner (call alerts, every note, a merged note) create no lead and join nothing', async () => {
  const h = harness({ state: { active: true }, owner: true });
  h.push(ownerFromMe());
  const tally = await h.tick();
  assert.equal(h.db.countLeads(), 0, 'his lead is not created from our own lines');
  assert.equal(tally.joined, 0);
  assert.equal(h.messages(), 0);
  // His own inbound message is what joins.
  h.push([msg({ id: 'HIS', jid: OWNER, pushName: 'Owner Example', ts: NOW - 60_000, text: 'Hi' })]);
  await h.tick();
  const [lead] = h.leads();
  assert.equal(lead.inbox_via, 'owner_test');
  assert.deepEqual(h.rows(lead.lead_id), [['HIS', 'in', 'client']]);
  h.close();
});

test('T06-12 his lead existing but not in (unsure, or reset by the test switch): our lines still join nothing, store nothing and never answer him', async () => {
  for (const inboxState of ['unsure', null]) {
    const h = harness({ state: { active: true }, owner: true });
    h.db.insertLead({
      lead_id: 'LEAD-own', created: NOW - DAY, updated: NOW - DAY, phone_e164: OWNER_DIGITS, wa_jid: OWNER, wa_lid: OWNER_LID,
      channel: 'whatsapp', match_method: 'owner_test', stage: 'new', inbox_state: inboxState, inbox_via: 'owner_test',
    });
    h.push(ownerFromMe());
    const tally = await h.tick(); // eslint-disable-line no-await-in-loop
    const what = String(inboxState);
    assert.equal(tally.joined, 0, what);
    assert.equal(h.lead('LEAD-own').inbox_state, inboxState);
    assert.equal(h.db.countLeads(), 1);
    assert.equal(h.messages(), 0);
    // A call alert or a note is no reply to his test: the reply clock is left for a real one.
    assert.equal(tally.replies, 0, `${what}: no reply counted`);
    assert.equal(h.lead('LEAD-own').first_reply_ts, null, `${what}: first_reply_ts untouched`);
    assert.equal(h.lead('LEAD-own').updated, NOW - DAY, `${what}: updated untouched`);
    h.close();
  }
});

test('T06-12 guard: a fromMe reply to a client\'s lead that is not in still stamps the reply clock, as today', async () => {
  const h = harness({ state: { active: true, ownInbox: true }, owner: true });
  seedLead(h, 'LEAD-uns', 11, { inbox_state: 'unsure', inbox_since: NOW - DAY });
  h.push([msg({ id: 'R1', jid: jidOf(11), fromMe: true, pushName: null, ts: NOW - 60_000, text: 'we will call you' })]);
  const tally = await h.tick();
  assert.equal(tally.replies, 1);
  assert.equal(h.lead('LEAD-uns').first_reply_ts, NOW - 60_000);
  h.close();
});

/* ---------------- 13: the test join's history floor ---------------- */

test('T06-13 the owner\'s test join takes its floor from the switch: history_from = T, no history read, earlier texts never stored', async () => {
  const T = NOW - 120_000;
  const CMD = msg({ id: 'CMD-ON', jid: OWNER, pushName: 'Owner Example', ts: T - 1000, text: '#dana test on' });
  const OLD = msg({ id: 'OLD', jid: OWNER, pushName: 'Owner Example', ts: T - HOUR, text: 'see you tomorrow' });
  const HI = msg({ id: 'HI', jid: OWNER, pushName: 'Owner Example', ts: NOW - 60_000, text: 'Hi' });
  for (const existing of [false, true]) {
    const h = harness({ state: { active: true }, owner: true, history: [OLD, CMD, HI] });
    h.setClock(T);
    h.team.setSetting('owner_as_client', '1');
    h.setClock(NOW);
    if (existing) {
      // As PR-A2's reopenOwnerTest leaves it: no state, no floor.
      h.db.insertLead({
        lead_id: 'LEAD-own', created: NOW - 5 * DAY, updated: NOW - 5 * DAY, phone_e164: OWNER_DIGITS, wa_jid: OWNER,
        channel: 'whatsapp', match_method: 'owner_test', stage: 'new', inbox_state: null, history_from: null, inbox_via: 'owner_test',
      });
    }
    h.push([CMD, HI]);
    const tally = await h.tick(); // eslint-disable-line no-await-in-loop
    const what = existing ? 'existing lead' : 'new lead';
    assert.equal(tally.commands, 1, what);
    const [lead] = h.leads();
    assert.equal(lead.inbox_state, 'in', what);
    assert.equal(lead.inbox_via, 'owner_test', what);
    assert.equal(lead.history_from, T, `${what}: the floor is the moment the test went on`);
    assert.deepEqual(h.calls.history, [], `${what}: no 24 h history read`);
    assert.deepEqual(h.rows(lead.lead_id), [['HI', 'in', 'client']], what);
    // Whatever read brings them later, the texts before T never reach wa_messages.
    assert.deepEqual(h.ingestor.ingest(lead, CMD), { stored: false, reason: 'before_floor' }, what);
    await h.backfill.refresh(lead, { minIntervalMs: 0 }); // eslint-disable-line no-await-in-loop
    assert.deepEqual(h.rows(lead.lead_id), [['HI', 'in', 'client']], `${what}: a refresh stores nothing before T`);
    h.close();
  }
});

test('T06-13 an owner\'s message sent before the test went on does not join his chat', async () => {
  const T = NOW - 60_000;
  const h = harness({ state: { active: true }, owner: true });
  h.setClock(T);
  h.team.setSetting('owner_as_client', '1');
  h.setClock(NOW);
  h.push([msg({ id: 'EARLY', jid: OWNER, pushName: 'Owner Example', ts: T - 5000, text: 'Hi' })]);
  const tally = await h.tick();
  assert.equal(tally.joined, 0);
  assert.equal(h.db.countLeads(), 0);
  h.close();
});

/* ---------------- 14: old out leads ---------------- */

test('T06-14 an out lead marked before the link (or never) writes under the own rule: not stored, no wake, one old_out_wrote alert a day', async () => {
  const h = harness({ state: { ownInbox: true } });
  const audit = createAudit(h.db, { now: () => LINKED_AT - DAY });
  seedLead(h, 'LEAD-none', 81, { inbox_state: 'out' });
  seedLead(h, 'LEAD-before', 82, { inbox_state: 'out' });
  seedLead(h, 'LEAD-after', 83, { inbox_state: 'out' });
  audit.record({ action: 'inbox_out', target: 'LEAD-before' });
  audit.record({ action: 'inbox_out', target: 'LEAD-after' });
  createAudit(h.db, { now: () => LINKED_AT + HOUR }).record({ action: 'inbox_out', target: 'LEAD-after' });
  h.push([
    msg({ id: 'A1', jid: jidOf(81), ts: NOW - 90_000, text: 'Hi' }),
    msg({ id: 'A2', jid: jidOf(81), ts: NOW - 80_000, text: 'Hi again' }),
    msg({ id: 'B1', jid: jidOf(82), ts: NOW - 70_000, text: 'Hello' }),
    msg({ id: 'C1', jid: jidOf(83), ts: NOW - 60_000, text: 'Hello' }),
  ]);
  await h.tick();
  assert.deepEqual(h.calls.alert, [['old_out_wrote', { leadId: 'LEAD-none' }], ['old_out_wrote', { leadId: 'LEAD-before' }]],
    'once a day per lead; a lead marked out on Bona\'s number stays silent');
  assert.equal(h.messages(), 0);
  assert.deepEqual(h.calls.wake, []);
  for (const id of ['LEAD-none', 'LEAD-before', 'LEAD-after']) assert.equal(h.lead(id).inbox_state, 'out', id);
  h.setClock(NOW + DAY);
  h.push([msg({ id: 'A3', jid: jidOf(81), ts: NOW + DAY - 10_000, text: 'Hi?' })]);
  await h.tick();
  assert.equal(h.calls.alert.length, 3, 'the next day: one more');
  h.close();
});

test('T06-14 without the own rule an old out lead stays silent, as today', async () => {
  const h = harness({ state: { ownInbox: false } });
  seedLead(h, 'LEAD-none', 81, { inbox_state: 'out' });
  h.push([msg({ id: 'A1', jid: jidOf(81), text: 'Hi BONA-W003' })]);
  await h.tick();
  assert.deepEqual(h.calls.alert, []);
  h.close();
});

/* ---------------- 15: no property-word record on Bona's number ---------------- */

test('T06-15 on Bona\'s number no chat with a phone is listed, with own_inbox 0 or 1, before or after the identity check', async () => {
  for (const state of [{ ownInbox: false }, { ownInbox: true, ownNumberOk: false }, { ownInbox: true }]) {
    const h = harness({ state });
    h.push([
      msg({ id: 'Q1', jid: jidOf(91), pushName: 'Umm Khalid', ts: NOW - 60_000, text: 'is the villa still for sale?' }),
      msg({ id: 'Q2', jid: jidOf(92), fromMe: true, pushName: null, ts: NOW - 50_000, text: 'the apartment is for rent' }),
    ]);
    await h.tick(); // eslint-disable-line no-await-in-loop
    const what = JSON.stringify(state);
    assert.deepEqual(h.candidates(), [], what);
    if (!state.ownInbox || state.ownNumberOk === false) {
      assert.equal(h.db.countLeads(), 0, `${what}: not a lead`);
      assert.equal(h.messages(), 0, `${what}: not stored`);
    }
    h.close();
  }
});

test('T06-15 the first tick after a start on Bona\'s number prunes the open phone rows once; dismissed rows stay; never off Bona\'s number', async () => {
  const h = harness({ state: { ownInbox: false } });
  seedDismissed(h, { candId: 'CND-dis', phone: digitsOf(93), jid: jidOf(93), at: NOW - 10 * DAY });
  await h.tick();
  await h.tick();
  assert.deepEqual(h.calls.prune, [{ phones: true }], 'once per start');
  assert.equal(h.candidates().length, 1, 'the dismissed row stays');
  h.close();
  for (const env of [PERSONAL, INVALID]) {
    const p = harness({ env, state: { ownInbox: true } });
    await p.tick(); // eslint-disable-line no-await-in-loop
    assert.deepEqual(p.calls.prune, [], JSON.stringify(env));
    p.close();
  }
});

/* ---------------- 16: a "Not a client" on Chats to check holds ---------------- */

test('T06-16 own rule: a chat dismissed on Chats to check (by phone, jid or lid) is not stored, not woken, never joined, no lead', async () => {
  const h = harness({ state: { ownInbox: true } });
  const HIDDEN_LID = '400000000000040@lid';
  seedDismissed(h, { candId: 'CND-phone', phone: digitsOf(101), at: LINKED_AT - DAY });
  seedDismissed(h, { candId: 'CND-jid', jid: jidOf(102), at: LINKED_AT - 2 * DAY });
  seedDismissed(h, { candId: 'CND-lid', lid: HIDDEN_LID, at: LINKED_AT - 3 * DAY });
  seedDismissed(h, { candId: 'CND-after', phone: digitsOf(104), jid: jidOf(104), at: LINKED_AT + DAY });
  h.push([
    msg({ id: 'D1', jid: jidOf(101), ts: NOW - 90_000, text: 'Hi' }),
    msg({ id: 'D2', jid: jidOf(102), ts: NOW - 85_000, text: 'Hi' }),
    // The hidden-number chat whose number WhatsApp now shows: held by its lid.
    msg({ id: 'D3', jid: HIDDEN_LID, jidAlt: jidOf(103), ts: NOW - 80_000, text: 'Hi' }),
    msg({ id: 'D4', jid: jidOf(104), ts: NOW - 75_000, text: 'Hi' }),
    msg({ id: 'D5', jid: jidOf(101), ts: NOW - 70_000, text: 'Ref BONA-W003 · K7Q2XR' }),
  ]);
  const tally = await h.tick();
  assert.equal(h.db.countLeads(), 0, 'no lead');
  assert.equal(tally.joined, 0);
  assert.equal(h.messages(), 0);
  assert.deepEqual(h.calls.wake, []);
  assert.deepEqual(h.calls.leadEvent, []);
  assert.deepEqual(h.calls.alert, [
    ['old_out_wrote', { candId: 'CND-phone' }], ['old_out_wrote', { candId: 'CND-jid' }], ['old_out_wrote', { candId: 'CND-lid' }],
  ], 'a mark made before the move: one note a day each; one made on bona2 stays silent');
  assert.equal(h.candidates().filter((r) => r.state === 'dismissed').length, 4, 'the marks stay');
  noLogLeak(h, '966500000101', '400000000000040');
  h.close();
});

test('T06-16b/16c on Bona\'s number a dismissed caller\'s Ref line joins nothing, with own_inbox 0 or during an identity lapse', async () => {
  for (const state of [{ ownInbox: false }, { ownInbox: true, ownNumberOk: false }]) {
    const h = harness({ state });
    seedSession(h);
    seedDismissed(h, { candId: 'CND-phone', phone: digitsOf(111), jid: jidOf(111), at: LINKED_AT - DAY });
    h.push([msg({ id: 'R1', jid: jidOf(111), text: 'Hello\nRef BONA-W003 · K7Q2XR' })]);
    const tally = await h.tick(); // eslint-disable-line no-await-in-loop
    const what = JSON.stringify(state);
    assert.equal(h.db.countLeads(), 0, `${what}: no lead`);
    assert.equal(tally.joined, 0, what);
    assert.equal(h.messages(), 0, what);
    assert.deepEqual(h.calls.alert, [], `${what}: the alert is the own rule's`);
    assert.equal(h.candidates()[0].state, 'dismissed', what);
    h.close();
  }
});

test('T06-16 off Bona\'s number the dismissal is today\'s (a Ref joins); and before PR-A2 adds the lookup, nothing is held', async () => {
  const p = harness({ env: PERSONAL, state: { ownInbox: true } });
  seedSession(p);
  seedDismissed(p, { candId: 'CND-phone', phone: digitsOf(111), jid: jidOf(111), at: LINKED_AT - DAY });
  p.push([msg({ id: 'R1', jid: jidOf(111), text: 'Hello\nRef BONA-W003 · K7Q2XR' })]);
  await p.tick();
  assert.equal(p.leads()[0]?.inbox_state, 'in', 'the personal number: today\'s rule exactly');
  p.close();
  const h = harness({ state: { ownInbox: false }, dismissedLookup: false });
  seedSession(h);
  seedDismissed(h, { candId: 'CND-phone', phone: digitsOf(111), jid: jidOf(111), at: LINKED_AT - DAY });
  h.push([msg({ id: 'R1', jid: jidOf(111), text: 'Hello\nRef BONA-W003 · K7Q2XR' })]);
  await h.tick();
  assert.equal(h.leads()[0]?.inbox_state, 'in', 'no lookup on the store yet: the Ref joins as today');
  h.close();
});

test('T06-16d on Bona\'s number the mark holds on the outbound path too: a fromMe Bona link or listing id in a dismissed chat makes no lead, joins nothing, keeps the mark', async () => {
  const HIDDEN_LID = '400000000000041@lid';
  for (const state of [{ ownInbox: true }, { ownInbox: false }, { ownInbox: true, ownNumberOk: false }]) {
    const h = harness({ state });
    seedSession(h);
    seedDismissed(h, { candId: 'CND-phone', phone: digitsOf(121), jid: jidOf(121), at: LINKED_AT - DAY });
    seedDismissed(h, { candId: 'CND-lid', lid: HIDDEN_LID, at: LINKED_AT - DAY });
    seedDismissed(h, { candId: 'CND-lead', phone: digitsOf(123), at: LINKED_AT - DAY });
    // A form lead with the same number, never in: the mark holds for it as on the inbound path.
    seedLead(h, 'LEAD-uns', 123, { inbox_state: 'unsure', inbox_since: NOW - DAY, match_method: 'form', channel: 'form' });
    h.push([
      // Typed on the phone, a staff send or a WhatsApp Business auto-message: all are fromMe.
      msg({ id: 'S1', jid: jidOf(121), fromMe: true, pushName: null, ts: NOW - 90_000, text: `${SITE}/properties/bona-w003/` }),
      msg({ id: 'S2', jid: jidOf(121), fromMe: true, pushName: null, ts: NOW - 85_000, text: 'BONA-W003 is still available' }),
      msg({ id: 'S3', jid: HIDDEN_LID, jidAlt: jidOf(122), fromMe: true, pushName: null, ts: NOW - 80_000, text: 'See BONA-W005' }),
      msg({ id: 'S4', jid: jidOf(123), fromMe: true, pushName: null, ts: NOW - 75_000, text: `${SITE}/properties/bona-w007/` }),
      // Then the client answers with a Ref line: still held (16, 16b).
      msg({ id: 'R1', jid: jidOf(121), ts: NOW - 70_000, text: 'Hello\nRef BONA-W003 · K7Q2XR' }),
    ]);
    const tally = await h.tick(); // eslint-disable-line no-await-in-loop
    const what = JSON.stringify(state);
    assert.equal(tally.joined, 0, what);
    assert.deepEqual(h.leads().map((l) => l.lead_id), ['LEAD-uns'], `${what}: no lead made`);
    assert.equal(h.lead('LEAD-uns').inbox_state, 'unsure', what);
    assert.equal(h.messages(), 0, `${what}: nothing stored`);
    assert.deepEqual(h.calls.wake, [], what);
    assert.deepEqual(h.calls.leadEvent, [], what);
    assert.deepEqual(h.candidates().map((r) => [r.cand_id, r.state]).sort(), [
      ['CND-lead', 'dismissed'], ['CND-lid', 'dismissed'], ['CND-phone', 'dismissed'],
    ], `${what}: every mark stays`);
    const ownRule = state.ownInbox && state.ownNumberOk !== false;
    assert.deepEqual(h.calls.alert, ownRule ? [['old_out_wrote', { candId: 'CND-phone' }]] : [],
      `${what}: only the client's own message is "the chat wrote"`);
    h.close();
  }
});

test('T06-16d on Bona\'s number noise in a dismissed chat (a reaction or an edit, inbound or fromMe) keeps the mark: a later Ref or "Hi" joins nothing', async () => {
  for (const state of [{ ownInbox: true }, { ownInbox: false }]) {
    const h = harness({ state });
    seedSession(h);
    seedDismissed(h, { candId: 'CND-lead', phone: digitsOf(131), at: LINKED_AT - DAY });
    // A form lead with the same number, never in: before the fix the noise's cleanup found it and deleted the mark.
    seedLead(h, 'LEAD-uns', 131, { inbox_state: 'unsure', inbox_since: NOW - DAY, match_method: 'form', channel: 'form' });
    const cleanups = [];
    const realRemove = h.inbox.removeCandidatesFor;
    h.inbox.removeCandidatesFor = (ids) => { cleanups.push(ids); return realRemove(ids); };
    h.push([
      msg({ id: 'N1', jid: jidOf(131), ts: NOW - 95_000, text: '', messageType: 'reactionMessage', noise: true }),
      msg({ id: 'N2', jid: jidOf(131), fromMe: true, pushName: null, ts: NOW - 90_000, text: '', messageType: 'reactionMessage', noise: true }),
      msg({ id: 'N3', jid: jidOf(131), ts: NOW - 85_000, text: 'Ref BONA-W003 · K7Q2XR', messageType: null, noise: true }),
      msg({ id: 'N4', jid: jidOf(131), fromMe: true, pushName: null, ts: NOW - 80_000, text: `${SITE}/properties/bona-w003/`, messageType: null, noise: true }),
      msg({ id: 'R1', jid: jidOf(131), ts: NOW - 70_000, text: 'Hello\nRef BONA-W003 · K7Q2XR' }),
      msg({ id: 'H1', jid: jidOf(131), ts: NOW - 60_000, text: 'Hi' }),
    ]);
    const tally = await h.tick(); // eslint-disable-line no-await-in-loop
    const what = JSON.stringify(state);
    assert.deepEqual(h.candidates().map((r) => [r.cand_id, r.state]), [['CND-lead', 'dismissed']], `${what}: the mark stays`);
    assert.deepEqual(cleanups, [], `${what}: a held record, noise included, never reaches the list's cleanup`);
    assert.equal(tally.joined, 0, what);
    assert.deepEqual(h.leads().map((l) => [l.lead_id, l.inbox_state]), [['LEAD-uns', 'unsure']], `${what}: no lead made, none joined`);
    assert.equal(h.messages(), 0, `${what}: nothing stored`);
    assert.deepEqual(h.calls.wake, [], `${what}: Dana is not woken`);
    assert.deepEqual(h.calls.leadEvent, [], what);
    const ownRule = state.ownInbox;
    assert.deepEqual(h.calls.alert, ownRule ? [['old_out_wrote', { candId: 'CND-lead' }]] : [],
      `${what}: noise is not "the chat wrote"; the client's own message is, once a day`);
    h.close();
  }
});

test('T06-16d on Bona\'s number the cleanup of a chat whose lead is not in removes only its open rows: a mark that lands while the record is handled stays', async () => {
  const LID = '400000000000142@lid';
  for (const state of [{ ownInbox: true }, { ownInbox: false }]) {
    const h = harness({ state });
    seedLead(h, 'LEAD-a', 141, { inbox_state: 'out', match_method: 'form', channel: 'form' });
    seedLead(h, 'LEAD-b', 142, { inbox_state: 'out', match_method: 'form', channel: 'form' });
    seedDismissed(h, { candId: 'CND-a', phone: digitsOf(141), at: LINKED_AT + DAY });
    // An open hidden-number row of LEAD-b's chat, listed before WhatsApp showed its number.
    h.db.db.prepare(`INSERT INTO inbox_candidates (cand_id, jid, lid, phone_e164, name, first_ts, last_ts, hits, words, last_dir, state, updated)
                     VALUES ('CND-b', NULL, ?, NULL, NULL, ?, ?, 1, 'lid-only', 'in', 'open', ?)`).run(LID, NOW - DAY, NOW - DAY, NOW - DAY);
    // The owner's "Not a client" on CND-a lands after the hold check of A1 and before its cleanup.
    let missed = false;
    h.inbox.dismissedCandidateFor = (ids) => {
      if (!missed && ids.phone === digitsOf(141)) { missed = true; return null; }
      return dismissedFor(h.db, ids);
    };
    h.push([
      msg({ id: 'A1', jid: jidOf(141), ts: NOW - 70_000, text: 'Hi' }),
      msg({ id: 'B1', jid: LID, jidAlt: jidOf(142), ts: NOW - 60_000, text: 'Hi' }),
    ]);
    await h.tick(); // eslint-disable-line no-await-in-loop
    const what = JSON.stringify(state);
    assert.ok(missed, `${what}: the hold check ran first`);
    assert.deepEqual(h.candidates().map((r) => [r.cand_id, r.state]), [['CND-a', 'dismissed']],
      `${what}: the mark stays; the open row of a lead's chat goes`);
    h.close();
  }
});

test('T06-16e on Bona\'s number a mark holds by the ids of the lead a record resolves to: a lid-only record of a lead whose number was dismissed (or a number record of one whose lid was) joins nothing, inbound or fromMe', async () => {
  const LID_A = '400000000000151@lid';
  const LID_B = '400000000000152@lid';
  const cases = [
    {
      // The owner dismissed the chat by its number; a web form then made a lead for that number,
      // and WhatsApp later paired it with a lid and shows the chat by that lid alone.
      name: 'number dismissed, lid-only record', jid: LID_A, candId: 'CND-phone',
      seed: (h) => {
        seedDismissed(h, { candId: 'CND-phone', phone: digitsOf(151), jid: jidOf(151), at: LINKED_AT - DAY });
        seedLead(h, 'LEAD-x', 151, { wa_jid: null, wa_lid: LID_A, match_method: 'form', channel: 'form' });
      },
    },
    {
      // A hidden-number chat dismissed by its lid; a lead with a number, paired with that lid
      // later, writes by its number alone.
      name: 'lid dismissed, number record', jid: jidOf(152), candId: 'CND-lid',
      seed: (h) => {
        seedDismissed(h, { candId: 'CND-lid', lid: LID_B, at: LINKED_AT - DAY });
        seedLead(h, 'LEAD-x', 152, { wa_lid: LID_B, match_method: 'form', channel: 'form' });
      },
    },
  ];
  for (const state of [{ ownInbox: true }, { ownInbox: false }]) {
    for (const c of cases) {
      for (const fromMe of [false, true]) {
        const h = harness({ state });
        seedSession(h);
        c.seed(h);
        h.push(fromMe
          ? [
            msg({ id: 'X1', jid: c.jid, fromMe: true, pushName: null, ts: NOW - 90_000, text: `${SITE}/properties/bona-w003/` }),
            msg({ id: 'X2', jid: c.jid, fromMe: true, pushName: null, ts: NOW - 80_000, text: 'BONA-W005 is still available' }),
          ]
          : [
            msg({ id: 'X1', jid: c.jid, ts: NOW - 90_000, text: 'Hi' }),
            msg({ id: 'X2', jid: c.jid, ts: NOW - 80_000, text: 'Hello\nRef BONA-W003 · K7Q2XR' }),
          ]);
        const tally = await h.tick(); // eslint-disable-line no-await-in-loop
        const what = `${JSON.stringify(state)} ${c.name} ${fromMe ? 'fromMe' : 'inbound'}`;
        assert.equal(tally.joined, 0, what);
        assert.equal(tally.held, 2, `${what}: both records held`);
        assert.deepEqual(h.leads().map((l) => [l.lead_id, l.inbox_state, l.inbox_via]), [['LEAD-x', null, null]],
          `${what}: no lead made, the lead keeps its state`);
        assert.equal(h.messages(), 0, `${what}: nothing stored`);
        assert.deepEqual(h.calls.wake, [], `${what}: Dana is not woken`);
        assert.deepEqual(h.calls.leadEvent, [], what);
        assert.deepEqual(h.candidates().map((r) => [r.cand_id, r.state]), [[c.candId, 'dismissed']], `${what}: the mark stays`);
        assert.deepEqual(h.calls.alert, state.ownInbox && !fromMe ? [['old_out_wrote', { candId: c.candId }]] : [],
          `${what}: a mark from before the move is noted once when the client writes under the own rule`);
        h.close();
      }
    }
  }
});
