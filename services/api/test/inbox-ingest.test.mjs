/**
 * One WhatsApp record of an inbox chat becomes one stored message: who sent it, whether it
 * is the dashboard's own send coming back, and what the lead learns from it. Real store,
 * real inbox store, real team accounts; the clock is injected so every time is exact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createTeam, learnTeamLid } from '../lib/team.mjs';
import { createInboxStore } from '../lib/inbox/store.mjs';
import { createIngest, RESOLVE_WINDOW_MS } from '../lib/inbox/ingest.mjs';

const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const LEAD_ID = 'LEAD-20260928-0000aaaa';
const OTHER_LEAD_ID = 'LEAD-20260928-0000bbbb';
const PHONE = '966500000001';
const PHONE_JID = `${PHONE}@s.whatsapp.net`;
const LID = '111222333444555@lid';
const TEXT = 'Is BONA-W003 still available?';
const REPLY = 'Yes it is. When would you like to view it?';
const TYPED = 'Welcome, here is the brochure';

/** A lead that is in the inbox, reached on a privacy-mode chat whose phone is known. */
const LEAD = {
  lead_id: LEAD_ID, created: NOW - 3_600_000, updated: NOW - 3_600_000, phone_e164: PHONE, wa_jid: PHONE_JID, wa_lid: LID,
  channel: 'whatsapp', match_method: 'ref', stage: 'new', inbox_state: 'in', inbox_since: NOW - 3_600_000,
};

/** One normalised record, as lib/evolution.mjs hands them over: inbound, under the lid, phone as alt. */
const rec = (over = {}) => ({
  id: 'IN-1', jid: LID, jidAlt: PHONE_JID, fromMe: false, ts: NOW - 60_000, text: TEXT, pushName: 'Sara',
  contextInfo: null, messageType: 'conversation', media: null, fileName: null, noise: false, ...over,
});

/** `isExcludedLead` is left out unless a test hands one in: the default reads the team tables. */
function harness({ lead = {}, ownerUserId = null, isExcludedLead = null } = {}) {
  const s = openDb(':memory:');
  const clock = NOW;
  const team = createTeam(s, { now: () => clock });
  const owner = team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const staff = team.addUser({ name: 'Sara Staff', phone: '0500000009', role: 'staff' });
  const inbox = createInboxStore(s, { now: () => clock });
  const logs = [];
  const { ingest } = createIngest({
    db: s, inbox, ownerUserId: ownerUserId ?? (() => owner.user_id), log: (o) => logs.push(o), now: () => clock,
    ...(isExcludedLead ? { isExcludedLead } : {}),
  });
  s.insertLead({ ...LEAD, ...lead });
  return { s, team, inbox, ingest, owner, staff, logs, lead: () => s.getLead(LEAD_ID) };
}

const MESSAGE_FIELDS = ['key_id', 'lead_id', 'jid', 'direction', 'sender_kind', 'sender_user_id', 'text', 'media_type', 'ts'];
const pick = (row) => Object.fromEntries(MESSAGE_FIELDS.map((k) => [k, row[k]]));

/** Every phone number, lid, name and message text these tests use. None may reach a log line. */
const PERSONAL = [PHONE, '111222333444555', '966593296933', '966500000009', 'Sara', 'Abdulaziz', TEXT, REPLY, TYPED];
function assertClean(logs) {
  const out = JSON.stringify(logs);
  for (const needle of PERSONAL) assert.equal(out.includes(needle), false, 'a log line carries personal data');
}

test('refuses a chat outside the inbox, a record with no id and noise — and stores nothing', () => {
  const h = harness();
  assert.throws(() => createIngest({ db: h.s }), TypeError);
  for (const state of [null, 'unsure', 'out']) {
    h.s.updateLead(LEAD_ID, { inbox_state: state });
    assert.deepEqual(h.ingest(h.lead(), rec()), { stored: false, reason: 'not_in_inbox' }, String(state));
  }
  // The row is read again: a chat marked "Not a client" a moment ago is not written back by
  // a caller still holding its old `in` row.
  assert.deepEqual(h.ingest({ ...LEAD }, rec()), { stored: false, reason: 'not_in_inbox' });
  assert.deepEqual(h.ingest(null, rec()), { stored: false, reason: 'not_in_inbox' });
  h.s.updateLead(LEAD_ID, { inbox_state: 'in' });
  assert.deepEqual(h.ingest(h.lead(), rec({ id: null })), { stored: false, reason: 'no_id' });
  assert.deepEqual(h.ingest(h.lead(), null), { stored: false, reason: 'no_id' });
  assert.deepEqual(h.ingest(h.lead(), rec({ noise: true, text: '' })), { stored: false, reason: 'noise' });
  assert.equal(h.inbox.hasMessages(LEAD_ID), false);
  h.s.close();
});

test("a team member's or a never-list chat stores nothing, whichever caller hands the record over", () => {
  // The staff member's own chat, `in` from before she joined the team (a migrated Ref lead).
  const member = harness({ lead: { phone_e164: '966500000009', wa_jid: '966500000009@s.whatsapp.net', wa_lid: null } });
  assert.deepEqual(member.ingest(member.lead(), rec({ jid: '966500000009@s.whatsapp.net', jidAlt: null })), { stored: false, reason: 'excluded' });
  assert.equal(member.inbox.hasMessages(LEAD_ID), false);
  assert.equal(member.lead().last_msg_ts, null);
  member.s.close();

  // No phone on the row, but its phone jid's number is on the never list.
  const never = harness({ lead: { phone_e164: null } });
  never.team.addNever({ phone: PHONE, note: 'family' });
  assert.deepEqual(never.ingest(never.lead(), rec()), { stored: false, reason: 'excluded' });
  assert.equal(never.lead().phone_e164, null, 'nothing is learned from it either');
  never.s.close();

  // Known only by a lid the poller learned for a team member.
  const lid = harness({ lead: { phone_e164: null, wa_jid: null } });
  learnTeamLid(lid.s, '0500000009', LID);
  assert.deepEqual(lid.ingest(lid.lead(), rec({ id: 'OWN-L', fromMe: true, text: TYPED })), { stored: false, reason: 'excluded' });
  assert.equal(lid.lead().handler_user_id, null);
  lid.s.close();

  // The check can be handed in instead of read from the team tables.
  const handed = harness({ isExcludedLead: (l) => l.lead_id === LEAD_ID });
  assert.deepEqual(handed.ingest(handed.lead(), rec()), { stored: false, reason: 'excluded' });
  handed.s.close();
});

test('a lid-only chat whose record shows a team or never-list number stores nothing: its row learns whose chat it is when it can, and the chat is never moved', () => {
  // A per-chat read (join history, catch-up, refresh) asks by the lid; the record's alt is
  // the first time the chat shows whose it is. The poller screens record jids; these callers do not.
  // Nothing is stored, but the row learns the number: it is then excluded by itself, so every
  // read path refuses it, the daily sweep takes it out, the poller maps the lid to it, and a
  // record the owner's number sends into the chat later is refused as well.
  const never = harness({ lead: { phone_e164: null, wa_jid: null } });
  never.team.addNever({ phone: PHONE, note: 'family' });
  assert.deepEqual(never.ingest(never.lead(), rec()), { stored: false, reason: 'excluded' });
  assert.equal(never.inbox.hasMessages(LEAD_ID), false);
  assert.deepEqual([never.lead().phone_e164, never.lead().wa_jid], [PHONE, PHONE_JID], 'the row now shows whose chat it is');
  assert.deepEqual(
    never.ingest(never.lead(), rec({ id: 'OWN-N', fromMe: true, jidAlt: null, text: TYPED })),
    { stored: false, reason: 'excluded' },
    'a later record from the owner\'s number is refused by the row itself',
  );
  assert.equal(never.inbox.hasMessages(LEAD_ID), false);
  assert.deepEqual([never.lead().handler_user_id, never.lead().last_msg_ts], [null, null]);
  assertClean(never.logs);
  never.s.close();

  const member = harness({ lead: { phone_e164: null, wa_jid: null } });
  assert.deepEqual(member.ingest(member.lead(), rec({ jidAlt: '966500000009@s.whatsapp.net' })), { stored: false, reason: 'excluded' });
  assert.equal(member.inbox.hasMessages(LEAD_ID), false);
  assert.equal(member.lead().phone_e164, '966500000009');
  assert.deepEqual(member.ingest(member.lead(), rec({ id: 'OWN-M', fromMe: true, jidAlt: null, text: TYPED })), { stored: false, reason: 'excluded' });
  member.s.close();

  // A row that cannot take the number — another lead holds it (phone_e164 is unique), or the
  // row already holds a different one — does not exclude itself. The record is still refused,
  // and nothing is stored or learned. Ingest never moves a chat or purges what it held: only
  // the owner's audited never-list add (P2-7) and the maintenance sweep (P2-20) do that.
  const NOT_HELD = { level: 'warn', evt: 'inbox.refused_excluded', reason: 'number_not_held' };
  const held = harness({ lead: { phone_e164: null, wa_jid: null } });
  held.s.insertLead({ ...LEAD, lead_id: OTHER_LEAD_ID, wa_lid: null, inbox_state: 'out' });
  assert.equal(held.ingest(held.lead(), rec({ id: 'IN-H0', jidAlt: null })).stored, true, 'nothing shows whose chat it is yet');
  held.inbox.setHandler(LEAD_ID, held.staff.user_id);
  held.inbox.setNeedsHuman(LEAD_ID, 1);
  held.team.addNever({ phone: PHONE, note: 'family' });
  const heldBefore = { lead: held.lead(), thread: held.inbox.messagesFor(LEAD_ID), other: held.s.getLead(OTHER_LEAD_ID) };
  assert.deepEqual(held.ingest(held.lead(), rec()), { stored: false, reason: 'excluded' });
  assert.deepEqual(
    [held.lead().inbox_state, held.lead().handler_user_id, held.lead().needs_human, held.lead().phone_e164, held.lead().wa_jid],
    ['in', held.staff.user_id, 1, null, null],
    'the chat stays in the inbox with its handler and "needs a human", and learns no number',
  );
  assert.deepEqual(held.lead(), heldBefore.lead, 'the row is not touched at all');
  assert.deepEqual(held.inbox.messagesFor(LEAD_ID), heldBefore.thread, 'its transcript is kept, and nothing is added');
  assert.deepEqual(held.s.getLead(OTHER_LEAD_ID), heldBefore.other, 'the lead that holds the number is left as it was');
  assert.deepEqual(held.logs.filter((e) => e.evt === NOT_HELD.evt), [NOT_HELD], 'one line, a reason and no id or number');
  assert.equal(held.logs.some((e) => e.evt === 'inbox.learned'), false);
  assertClean(held.logs);
  held.s.close();

  // The same when the row already holds another number: it learns nothing — not even the lid
  // the record came under, which belongs to the excluded number, not to this row's.
  const OTHER_PHONE_JID = '966500000002@s.whatsapp.net';
  const other = harness({ lead: { phone_e164: '966500000002', wa_jid: OTHER_PHONE_JID, wa_lid: null } });
  other.inbox.upsertMessage({
    key_id: 'IN-O0', lead_id: LEAD_ID, jid: OTHER_PHONE_JID, direction: 'in', sender_kind: 'client', text: TEXT, ts: NOW - 120_000,
  });
  other.inbox.setHandler(LEAD_ID, other.staff.user_id);
  other.inbox.setNeedsHuman(LEAD_ID, 1);
  other.team.addNever({ phone: PHONE, note: 'family' });
  const otherBefore = { lead: other.lead(), thread: other.inbox.messagesFor(LEAD_ID) };
  assert.deepEqual(other.ingest(other.lead(), rec()), { stored: false, reason: 'excluded' });
  assert.deepEqual(
    [other.lead().inbox_state, other.lead().handler_user_id, other.lead().needs_human, other.lead().phone_e164, other.lead().wa_lid],
    ['in', other.staff.user_id, 1, '966500000002', null],
  );
  assert.deepEqual(other.lead(), otherBefore.lead, 'the row is not touched at all');
  assert.deepEqual(other.inbox.messagesFor(LEAD_ID), otherBefore.thread, 'its transcript is kept, and nothing is added');
  assert.deepEqual(other.logs.filter((e) => e.evt === NOT_HELD.evt), [NOT_HELD]);
  assertClean(other.logs);
  other.s.close();

  // A row that learned the number excludes itself and stays where it is: the daily sweep moves it.
  const learnt = harness({ lead: { phone_e164: null, wa_jid: null } });
  learnt.team.addNever({ phone: PHONE, note: 'family' });
  learnt.ingest(learnt.lead(), rec());
  assert.equal(learnt.lead().inbox_state, 'in');
  assert.equal(learnt.logs.some((e) => e.evt === NOT_HELD.evt), false, 'a row that took the number is not reported');
  learnt.s.close();

  // Not from a record we sent: its alt may be the owner's own number, a team number.
  const own = harness({ lead: { phone_e164: null, wa_jid: null } });
  const out = own.ingest(own.lead(), rec({ id: 'OWN-A', fromMe: true, text: TYPED, jidAlt: '966593296933@s.whatsapp.net' }));
  assert.deepEqual(out, { stored: true, inserted: true, senderKind: 'owner_number' });
  own.s.close();
});

test('a login code coming back in a chat is never stored, and its outbox row is left as it was', () => {
  // Belt and braces: a code only ever goes to a team member, whose chat the exclusion above
  // already refuses. The code must still never reach wa_messages (design §4.2).
  const h = harness();
  const code = 'Bona dashboard code: 482913 (valid 10 min)';
  h.inbox.insertOutbox({ send_id: 'SND-code-1', jid: PHONE_JID, sender_kind: 'code' });
  h.inbox.updateOutbox('SND-code-1', { status: 'accepted', key_id: 'CODE-1' });
  const before = h.inbox.getOutbox('SND-code-1');
  assert.deepEqual(
    h.ingest(h.lead(), rec({ id: 'CODE-1', fromMe: true, jid: PHONE_JID, jidAlt: null, text: code })),
    { stored: false, reason: 'code' },
  );
  assert.equal(h.inbox.hasMessages(LEAD_ID), false);
  assert.deepEqual(h.inbox.getOutbox('SND-code-1'), before, 'the row is not touched');
  assert.equal(h.lead().handler_user_id, null, 'a login code makes nobody the handler');
  assert.equal(h.lead().last_msg_ts, null);
  assert.equal(JSON.stringify(h.logs).includes('482913'), false);
  h.s.close();
});

test("an inbound record is stored as the client's message and moves the chat's last-message time", () => {
  const h = harness();
  assert.deepEqual(h.ingest(h.lead(), rec()), { stored: true, inserted: true, senderKind: 'client' });
  const rows = h.inbox.messagesFor(LEAD_ID);
  assert.equal(rows.length, 1);
  assert.deepEqual(pick(rows[0]), {
    key_id: 'IN-1', lead_id: LEAD_ID, jid: LID, direction: 'in', sender_kind: 'client', sender_user_id: null,
    text: TEXT, media_type: null, ts: NOW - 60_000,
  });
  assert.equal(h.lead().last_msg_ts, NOW - 60_000);
  assert.equal(h.lead().handler_user_id, null, 'a client message makes nobody the handler');
  h.s.close();
});

test('media arrive as placeholders: a caption stays as text, an unknown bare message is "[message]"', () => {
  const h = harness();
  h.ingest(h.lead(), rec({ id: 'M-1', media: '[image]', text: 'Front view', messageType: 'imageMessage' }));
  h.ingest(h.lead(), rec({ id: 'M-2', media: '[voice note]', text: '', messageType: 'audioMessage', ts: NOW - 50_000 }));
  h.ingest(h.lead(), rec({ id: 'M-3', media: null, text: '', messageType: 'pollCreationMessageV3', ts: null }));
  const byId = Object.fromEntries(h.inbox.messagesFor(LEAD_ID).map((m) => [m.key_id, m]));
  assert.deepEqual([byId['M-1'].media_type, byId['M-1'].text], ['[image]', 'Front view']);
  assert.deepEqual([byId['M-2'].media_type, byId['M-2'].text], ['[voice note]', null]);
  assert.deepEqual([byId['M-3'].media_type, byId['M-3'].text], ['[message]', null]);
  assert.equal(byId['M-3'].ts, NOW, 'a record with no usable time is stamped with now');
  h.s.close();
});

test('an outbound record the dashboard sent is found by its message id: staff, that user, row accepted', () => {
  const h = harness();
  h.inbox.insertOutbox({ send_id: 'SND-key-1', lead_id: LEAD_ID, jid: PHONE_JID, text: REPLY, user_id: h.staff.user_id, sender_kind: 'staff' });
  h.inbox.updateOutbox('SND-key-1', { status: 'accepted', key_id: 'OUT-1' });
  const out = h.ingest(h.lead(), rec({ id: 'OUT-1', fromMe: true, jid: PHONE_JID, jidAlt: null, text: REPLY, ts: NOW + 1_000 }));
  assert.deepEqual(out, { stored: true, inserted: true, senderKind: 'staff' });
  const [m] = h.inbox.messagesFor(LEAD_ID);
  assert.deepEqual([m.direction, m.sender_kind, m.sender_user_id], ['out', 'staff', h.staff.user_id]);
  const row = h.inbox.getOutbox('SND-key-1');
  assert.deepEqual([row.status, row.key_id], ['accepted', 'OUT-1']);
  // The poller read the record before the reply had stored it: whoever replied first is still the handler.
  assert.equal(h.lead().handler_user_id, h.staff.user_id);
  assert.equal(h.logs.some((e) => e.evt === 'inbox.outbox.resolved'), false, 'an accepted row has nothing to resolve');
  h.s.close();
});

test('a Dana send found by its id is Dana\'s, and leaves "needs a human" and the handler alone', () => {
  const h = harness({ lead: { needs_human: 1 } });
  h.inbox.insertOutbox({ send_id: 'SND-dana-1', lead_id: LEAD_ID, jid: PHONE_JID, text: 'Hello, I am Dana', sender_kind: 'dana' });
  h.inbox.updateOutbox('SND-dana-1', { status: 'accepted', key_id: 'DANA-1' });
  const out = h.ingest(h.lead(), rec({ id: 'DANA-1', fromMe: true, jid: PHONE_JID, jidAlt: null, text: 'Hello, I am Dana' }));
  assert.equal(out.senderKind, 'dana');
  assert.equal(h.inbox.messagesFor(LEAD_ID)[0].sender_user_id, null);
  assert.equal(h.lead().needs_human, 1, 'Dana is not a human reply');
  assert.equal(h.lead().handler_user_id, null);
  h.s.close();
});

for (const status of ['uncertain', 'pending']) {
  test(`a reply left ${status} is resolved by its text within two minutes, at the lead, though it comes back under the lid`, () => {
    const h = harness({ lead: { needs_human: 1 } });
    // The reply went to the phone jid (the outbox row says so); the record comes back under the lid.
    h.inbox.insertOutbox({ send_id: 'SND-unsure-1', lead_id: LEAD_ID, jid: PHONE_JID, text: REPLY, user_id: h.staff.user_id, sender_kind: 'staff', status });
    const out = h.ingest(h.lead(), rec({ id: 'OUT-2', fromMe: true, jid: LID, jidAlt: PHONE_JID, text: REPLY, ts: NOW + RESOLVE_WINDOW_MS }));
    assert.deepEqual(out, { stored: true, inserted: true, senderKind: 'staff' });
    const row = h.inbox.getOutbox('SND-unsure-1');
    assert.deepEqual([row.status, row.key_id], ['accepted', 'OUT-2']);
    assert.equal(h.inbox.messagesFor(LEAD_ID)[0].sender_user_id, h.staff.user_id);
    assert.equal(h.lead().needs_human, 0, 'a staff reply is a human reply');
    assert.equal(h.lead().handler_user_id, h.staff.user_id);
    assert.ok(h.logs.some((e) => e.evt === 'inbox.outbox.resolved' && e.sendId === 'SND-unsure-1' && e.via === 'text'));
    assertClean(h.logs);
    h.s.close();
  });
}

test("two minutes and one millisecond, other words, or another chat: the owner's own number, and the row stays unsure", () => {
  const cases = [
    ['too late', { ts: NOW + RESOLVE_WINDOW_MS + 1, text: REPLY }, LEAD_ID],
    ['other words', { ts: NOW + 1_000, text: `${REPLY}!` }, LEAD_ID],
    ['another chat', { ts: NOW + 1_000, text: REPLY }, OTHER_LEAD_ID],
  ];
  for (const [label, over, outboxLead] of cases) {
    const h = harness();
    h.inbox.insertOutbox({ send_id: 'SND-unsure-2', lead_id: outboxLead, jid: PHONE_JID, text: REPLY, user_id: h.staff.user_id, sender_kind: 'staff', status: 'uncertain' });
    const out = h.ingest(h.lead(), rec({ id: 'OUT-3', fromMe: true, jid: LID, jidAlt: PHONE_JID, ...over }));
    assert.equal(out.senderKind, 'owner_number', label);
    const row = h.inbox.getOutbox('SND-unsure-2');
    assert.deepEqual([row.status, row.key_id], ['uncertain', null], label);
    assert.equal(h.inbox.messagesFor(LEAD_ID)[0].sender_user_id, null, label);
    h.s.close();
  }
});

test('an owner_number record makes the owner the handler only when nobody handles the chat', () => {
  const typed = rec({ id: 'OWN-1', fromMe: true, text: TYPED });

  const free = harness();
  assert.equal(free.ingest(free.lead(), typed).senderKind, 'owner_number');
  assert.equal(free.lead().handler_user_id, free.owner.user_id);
  free.s.close();

  const taken = harness();
  taken.inbox.setHandler(LEAD_ID, taken.staff.user_id);
  taken.ingest(taken.lead(), typed);
  assert.equal(taken.lead().handler_user_id, taken.staff.user_id, 'an existing handler is kept');
  taken.s.close();

  const noOwner = harness({ ownerUserId: () => null });
  noOwner.ingest(noOwner.lead(), typed);
  assert.equal(noOwner.lead().handler_user_id, null, 'no owner account, no handler');
  noOwner.s.close();
});

test('a human outbound clears "needs a human"; a client message does not', () => {
  const h = harness({ lead: { needs_human: 1 } });
  h.ingest(h.lead(), rec({ id: 'IN-9' }));
  assert.equal(h.lead().needs_human, 1);
  h.ingest(h.lead(), rec({ id: 'OWN-9', fromMe: true, text: TYPED, ts: NOW - 30_000 }));
  assert.equal(h.lead().needs_human, 0);
  h.s.close();
});

test('a lead learns its lid, phone jid and phone from a record it received, only into empty fields', () => {
  // Phone known, jids not yet: both come from the lid chat and its alt.
  const a = harness({ lead: { wa_jid: null, wa_lid: null } });
  a.ingest(a.lead(), rec());
  assert.deepEqual([a.lead().wa_lid, a.lead().wa_jid, a.lead().phone_e164], [LID, PHONE_JID, PHONE]);
  assert.ok(a.logs.some((e) => e.evt === 'inbox.learned' && e.fields.includes('wa_lid') && e.fields.includes('wa_jid')));
  assertClean(a.logs);
  a.s.close();

  // Never overwrites.
  const b = harness({ lead: { wa_lid: '999888777666555@lid' } });
  b.ingest(b.lead(), rec());
  assert.equal(b.lead().wa_lid, '999888777666555@lid');
  b.s.close();

  // A lid-only chat learns its phone.
  const c = harness({ lead: { phone_e164: null, wa_jid: null } });
  c.ingest(c.lead(), rec());
  assert.deepEqual([c.lead().phone_e164, c.lead().wa_jid], [PHONE, PHONE_JID]);
  c.s.close();

  // Not from a record we sent: its alt may be our own number.
  const d = harness({ lead: { wa_jid: null, wa_lid: null } });
  d.ingest(d.lead(), rec({ id: 'OWN-2', fromMe: true }));
  assert.deepEqual([d.lead().wa_lid, d.lead().wa_jid], [null, null]);
  d.s.close();

  // Never a phone or jid another lead already holds (phone_e164 is unique).
  const e = harness({ lead: { phone_e164: null, wa_jid: null } });
  e.s.insertLead({ ...LEAD, lead_id: OTHER_LEAD_ID, wa_lid: null });
  assert.equal(e.ingest(e.lead(), rec()).stored, true, 'the message is still stored');
  assert.deepEqual([e.lead().phone_e164, e.lead().wa_jid], [null, null]);
  e.s.close();
});

test('re-ingesting a record changes nothing: one row, and a reassignment to nobody is not undone', () => {
  const h = harness();
  const typed = rec({ id: 'OWN-3', fromMe: true, text: TYPED });
  assert.deepEqual(h.ingest(h.lead(), typed), { stored: true, inserted: true, senderKind: 'owner_number' });
  assert.equal(h.lead().handler_user_id, h.owner.user_id);
  h.inbox.setHandler(LEAD_ID, null); // someone reassigned the chat to nobody
  assert.deepEqual(h.ingest(h.lead(), typed), { stored: true, inserted: false, senderKind: 'owner_number' });
  assert.equal(h.lead().handler_user_id, null);
  h.ingest(h.lead(), rec());
  h.ingest(h.lead(), rec());
  assert.equal(h.inbox.messagesFor(LEAD_ID).length, 2);
  h.s.close();
});

test("a reply first stored as the owner's number becomes staff once its outbox row carries the message id", () => {
  const h = harness();
  h.inbox.insertOutbox({ send_id: 'SND-slow-1', lead_id: LEAD_ID, jid: PHONE_JID, text: REPLY, user_id: h.staff.user_id, sender_kind: 'staff' });
  const record = rec({ id: 'OUT-4', fromMe: true, jid: PHONE_JID, jidAlt: null, text: REPLY, ts: NOW + 3 * 60_000 });
  assert.equal(h.ingest(h.lead(), record).senderKind, 'owner_number', 'too far from the send to be matched by its text');
  h.inbox.updateOutbox('SND-slow-1', { status: 'accepted', key_id: 'OUT-4' }); // the slow send finally answered
  assert.deepEqual(h.ingest(h.lead(), record), { stored: true, inserted: false, senderKind: 'staff' });
  const [m] = h.inbox.messagesFor(LEAD_ID);
  assert.deepEqual([m.sender_kind, m.sender_user_id], ['staff', h.staff.user_id]);
  h.s.close();
});

test('logs carry ids and field names only — never text, a phone number, a lid or a name', () => {
  const h = harness({ lead: { wa_jid: null, wa_lid: null } });
  h.inbox.insertOutbox({ send_id: 'SND-log-1', lead_id: LEAD_ID, jid: PHONE_JID, text: REPLY, user_id: h.staff.user_id, sender_kind: 'staff', status: 'uncertain' });
  h.ingest(h.lead(), rec({ pushName: 'Sara' }));
  h.ingest(h.lead(), rec({ id: 'OUT-5', fromMe: true, text: REPLY, ts: NOW }));
  h.ingest(h.lead(), rec({ id: 'OWN-5', fromMe: true, text: TYPED, ts: NOW + 1_000 }));
  assert.ok(h.logs.length >= 2, 'the learning and the resolution were both logged');
  assertClean(h.logs);
  h.s.close();
});
