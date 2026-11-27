/**
 * The push policy (PLAN T11 test 11; DESIGN §4.2 "Push policy", critic G1): a stored client
 * message of a chat in auto mode pushes the team's phones only when the assistant is NOT going
 * to answer it. A legacy chat keeps today's push (DESIGN §2: without auto mode, today's
 * semantics), and so does every chat while no ownerTest is wired (index.mjs until PR-INT). A
 * hand-over still pushes from lib/dana-wa.mjs itself, unchanged. Nothing here contacts Retell
 * or Evolution: the Retell client is a double and the sender's fetch is a fake.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createTeam, isExcludedLead } from '../lib/team.mjs';
import { createInboxStore } from '../lib/inbox/store.mjs';
import { createSender } from '../lib/wa-send.mjs';
import { createInventory, WORKTREE_LISTINGS } from '../lib/inventory.mjs';
import { createDana } from '../lib/dana-wa.mjs';
import { createPushPolicy } from '../lib/push-policy.mjs';

const NOW = 1_795_935_600_000; // Sun 29 Nov 2026 10:00 Riyadh
const DAY = 86_400_000;
const SITE = 'https://bona-real-estate.com';
const ENV = { EVOLUTION_API_URL: 'http://evo.test/', EVOLUTION_API_KEY: 'k', BONA_WA_INSTANCE: 'bona-test', BONA_OWNER_JID: '966500000009@s.whatsapp.net' };
const LEAD = 'LEAD-20261129-0000aaaa';
const CLIENT = '966500000001';
const JID = `${CLIENT}@s.whatsapp.net`;

function recorder() {
  const seen = [];
  return {
    seen,
    alerts: { notify: (...a) => { seen.push(['notify', ...a]); return Promise.resolve({ users: 1 }); } },
  };
}

const AUTO = { autoMode: (lead) => lead?.lead_id === LEAD };

test('auto mode, and the assistant will answer this message: no phone push, only the wake', () => {
  const r = recorder();
  const asked = [];
  const policy = createPushPolicy({
    alerts: r.alerts, ownerTest: AUTO,
    dana: { eligible: (id, o) => { asked.push([id, o]); return { ok: true, lead: { lead_id: id } }; }, wake: (...a) => r.seen.push(['wake', ...a]) },
  });
  policy.onClientMessage(LEAD, NOW);
  assert.deepEqual(asked, [[LEAD, { ts: NOW }]], 'asked about this message, by its time');
  assert.deepEqual(r.seen, [['wake', LEAD, NOW]]);
});

test('a legacy chat (not in auto mode), or no ownerTest wired (index.mjs today): the push, as today, even while the assistant answers', () => {
  for (const ownerTest of [{ autoMode: () => false }, null]) {
    const r = recorder();
    const policy = createPushPolicy({
      alerts: r.alerts, ownerTest,
      dana: { eligible: (id) => ({ ok: true, lead: { lead_id: id } }), wake: (...a) => r.seen.push(['wake', ...a]) },
    });
    policy.onClientMessage(LEAD, NOW);
    assert.deepEqual(r.seen, [['notify', LEAD, { ts: NOW }], ['wake', LEAD, NOW]], ownerTest ? 'legacy chat' : 'no ownerTest');
  }
});

test('the assistant will not answer it (off, a person answered, a cap, lid-only…): the push goes first, then the wake, as today', () => {
  for (const reason of ['off', 'needs_human', 'human_recent', 'cap_day', 'lid_only', 'not_configured']) {
    const r = recorder();
    const policy = createPushPolicy({ alerts: r.alerts, ownerTest: AUTO, dana: { eligible: () => ({ ok: false, reason }), wake: (...a) => r.seen.push(['wake', ...a]) } });
    policy.onClientMessage(LEAD, NOW);
    assert.deepEqual(r.seen, [['notify', LEAD, { ts: NOW }], ['wake', LEAD, NOW]], reason);
  }
});

test('an eligibility check that throws, or a Dana without one, fails towards the push (a person hears of it)', () => {
  const r = recorder();
  createPushPolicy({ alerts: r.alerts, ownerTest: AUTO, dana: { eligible: () => { throw new Error('boom'); }, wake: (...a) => r.seen.push(['wake', ...a]) } })
    .onClientMessage(LEAD, NOW);
  assert.deepEqual(r.seen, [['notify', LEAD, { ts: NOW }], ['wake', LEAD, NOW]]);
  const r2 = recorder();
  createPushPolicy({ alerts: r2.alerts, ownerTest: AUTO, dana: { wake: (...a) => r2.seen.push(['wake', ...a]) } }).onClientMessage(LEAD, NOW);
  const r3 = recorder();
  createPushPolicy({ alerts: r3.alerts, ownerTest: { autoMode: () => { throw new Error('boom'); } }, dana: { eligible: (id) => ({ ok: true, lead: { lead_id: id } }), wake() {} } })
    .onClientMessage(LEAD, NOW);
  assert.deepEqual(r3.seen, [['notify', LEAD, { ts: NOW }]], 'an auto-mode check that throws pushes too');
  assert.deepEqual(r2.seen, [['notify', LEAD, { ts: NOW }], ['wake', LEAD, NOW]]);
  assert.throws(() => createPushPolicy({ dana: { wake() {} } }), TypeError);
  assert.throws(() => createPushPolicy({ alerts: r.alerts }), TypeError);
});

/** A real Dana (lib/dana-wa.mjs) on a fake Retell, with the policy in front of her as index.mjs wires it. */
function withDana({ enabled = true, failRetell = false, auto = true } = {}) {
  const db = openDb(':memory:');
  const clock = () => NOW;
  const team = createTeam(db, { now: clock });
  team.ensureOwner({ phone: '966500000009', name: 'Owner Example' });
  if (enabled) team.setSetting('dana_enabled', '1');
  const inbox = createInboxStore(db, { now: clock });
  const fetchImpl = async () => ({ ok: true, status: 201, text: async () => JSON.stringify({ key: { id: 'KEY-1' } }) });
  const sender = createSender({ env: ENV, team, inbox, db, fetchImpl, now: clock });
  const retell = {
    async createChat() { return { chat_id: 'chat_1', chat_status: 'ongoing' }; },
    async createChatCompletion() {
      if (failRetell) throw Object.assign(new Error('retell down'), { status: 500 });
      return { messages: [{ role: 'agent', content: 'Of course. Which district do you prefer?', message_id: 'm1' }] };
    },
  };
  const notified = [];
  const alerts = { notify: (id, o) => { notified.push([id, o]); return Promise.resolve({ users: 1 }); } };
  db.insertLead({
    lead_id: LEAD, created: NOW - DAY, updated: NOW - DAY, phone_e164: CLIENT, wa_jid: JID, name: 'Sara Example', channel: 'whatsapp',
    match_method: 'ref', stage: 'new', stage_ts: NOW - DAY, inbox_state: 'in', inbox_since: NOW - DAY,
  });
  const dana = createDana({
    db, inbox, team, sender, retell, alerts, inventory: createInventory({ file: WORKTREE_LISTINGS, siteUrl: SITE }), siteUrl: SITE,
    agentId: 'agent_wa', isExcludedLead: (l) => isExcludedLead(team, db, l), now: clock, batchMs: 0,
  });
  const policy = createPushPolicy({ alerts, dana, ownerTest: auto ? AUTO : { autoMode: () => false } });
  inbox.upsertMessage({ key_id: 'IN-1', lead_id: LEAD, jid: JID, direction: 'in', sender_kind: 'client', text: 'Is the villa still available?', ts: NOW - 5_000 });
  return { db, dana, policy, notified, close: async () => { await dana.stop(); db.close(); } };
}

test('with the real Dana answering an auto-mode chat: the client message makes no push', async () => {
  const h = withDana();
  try {
    h.policy.onClientMessage(LEAD, NOW - 5_000);
    await h.dana.flush();
    assert.deepEqual(h.notified, [], 'she answered; nobody was paged');
  } finally {
    await h.close();
  }
});

test('with the real Dana answering a legacy chat: the push, as today', async () => {
  const h = withDana({ auto: false });
  try {
    h.policy.onClientMessage(LEAD, NOW - 5_000);
    await h.dana.flush();
    assert.deepEqual(h.notified, [[LEAD, { ts: NOW - 5_000 }]]);
  } finally {
    await h.close();
  }
});

test('with Dana switched off: the client message pushes, as today', async () => {
  const h = withDana({ enabled: false });
  try {
    h.policy.onClientMessage(LEAD, NOW - 5_000);
    await h.dana.flush();
    assert.deepEqual(h.notified, [[LEAD, { ts: NOW - 5_000 }]]);
  } finally {
    await h.close();
  }
});

test('guard (green before): a hand-over still pushes from Dana herself, reason needs_human', async () => {
  const h = withDana({ failRetell: true });
  try {
    h.policy.onClientMessage(LEAD, NOW - 5_000);
    await h.dana.flush();
    assert.deepEqual(h.notified.filter(([, o]) => o.reason === 'needs_human'), [[LEAD, { reason: 'needs_human' }]]);
    assert.equal(h.db.getLead(LEAD).needs_human, 1);
  } finally {
    await h.close();
  }
});
