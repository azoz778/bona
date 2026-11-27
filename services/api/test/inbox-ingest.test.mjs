/**
 * One WhatsApp record of an inbox chat becomes one stored message: who sent it, whether it
 * is the dashboard's own send coming back, and what the lead learns from it. Real store,
 * real inbox store, real team accounts; the clock is injected so every time is exact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createTeam, learnTeamLid, isExcludedLead as isExcludedLeadOf } from '../lib/team.mjs';
import { createInboxStore } from '../lib/inbox/store.mjs';
import { createIngest, RESOLVE_WINDOW_MS, SEND_SKEW_MS } from '../lib/inbox/ingest.mjs';
import { codeMessage } from '../lib/dashboard/auth.mjs';
import { createBackfill } from '../lib/inbox/backfill.mjs';
import { createSender } from '../lib/wa-send.mjs';

const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const LEAD_ID = 'LEAD-20260928-0000aaaa';
const OTHER_LEAD_ID = 'LEAD-20260928-0000bbbb';
const PHONE = '966500000001';
const PHONE_JID = `${PHONE}@s.whatsapp.net`;
const LID = '111222333444555@lid';
const TEXT = 'Is BONA-W003 still available?';
const REPLY = 'Yes it is. When would you like to view it?';
const TYPED = 'Welcome, here is the brochure';
/** A client's number, a lid the poller learned for the staff member, and another chat's lid. */
const CLIENT = '966500000002';
const CLIENT_JID = `${CLIENT}@s.whatsapp.net`;
const TEAM_LID = '777666555444333@lid';
const OTHER_LID = '999888777666555@lid';

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

/**
 * `isExcludedLead` and `ownerPhone` are left out unless a test hands one in: the defaults read
 * the team tables and the owner account's number.
 */
function harness({ lead = {}, ownerUserId = null, isExcludedLead = null, ownerPhone = undefined } = {}) {
  const s = openDb(':memory:');
  let clock = NOW;
  const team = createTeam(s, { now: () => clock });
  const owner = team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const staff = team.addUser({ name: 'Sara Staff', phone: '0500000009', role: 'staff' });
  const inbox = createInboxStore(s, { now: () => clock });
  const logs = [];
  const { ingest } = createIngest({
    db: s, inbox, ownerUserId: ownerUserId ?? (() => owner.user_id), log: (o) => logs.push(o), now: () => clock,
    ...(isExcludedLead ? { isExcludedLead } : {}),
    ...(ownerPhone !== undefined ? { ownerPhone } : {}),
  });
  s.insertLead({ ...LEAD, ...lead });
  return { s, team, inbox, ingest, owner, staff, logs, lead: () => s.getLead(LEAD_ID), at: (t) => { clock = t; } };
}

const MESSAGE_FIELDS = ['key_id', 'lead_id', 'jid', 'direction', 'sender_kind', 'sender_user_id', 'text', 'media_type', 'ts'];
const pick = (row) => Object.fromEntries(MESSAGE_FIELDS.map((k) => [k, row[k]]));

/** Every phone number, lid, name and message text these tests use. None may reach a log line. */
const PERSONAL = [PHONE, CLIENT, '111222333444555', '777666555444333', '999888777666555', '966593296933', '966500000009', 'Sara', 'Abdulaziz', TEXT, REPLY, TYPED];
function assertClean(logs) {
  const out = JSON.stringify(logs);
  for (const needle of PERSONAL) assert.equal(out.includes(needle), false, 'a log line carries personal data');
}

test('a record from before the chat\'s history floor is refused: nothing stored, nothing learned', () => {
  const FLOOR = NOW - 86_400_000;
  // No lid yet: a record older than the floor must not teach it one.
  const h = harness({ lead: { history_from: FLOOR, wa_lid: null } });
  assert.deepEqual(h.ingest(h.lead(), rec({ id: 'OLD', ts: FLOOR - 1 })), { stored: false, reason: 'before_floor' });
  assert.deepEqual(h.ingest(h.lead(), rec({ id: 'OLD-OUT', fromMe: true, jidAlt: null, jid: PHONE_JID, ts: FLOOR - 60_000, text: TYPED })), { stored: false, reason: 'before_floor' });
  // Even a record naming a colleague's lid teaches the row nothing from before the floor.
  learnTeamLid(h.s, '966500000009', TEAM_LID);
  assert.deepEqual(h.ingest(h.lead(), rec({ id: 'OLD-TEAM', jid: TEAM_LID, jidAlt: null, ts: FLOOR - 1 })), { stored: false, reason: 'before_floor' });
  assert.equal(h.inbox.hasMessages(LEAD_ID), false);
  assert.equal(h.lead().wa_lid, null, 'nothing learned');
  assert.equal(h.ingest(h.lead(), rec({ id: 'EDGE', ts: FLOOR })).stored, true, 'exactly at the floor is inside it');
  assert.equal(h.ingest(h.lead(), rec({ id: 'UNDATED', ts: null })).stored, true, 'a record with no time is stored at now, after any floor');
  assert.equal(h.lead().wa_lid, LID, 'learned from a record inside the floor');
  // A chat with no floor recorded keeps every record, as before.
  const open = harness();
  assert.equal(open.ingest(open.lead(), rec({ id: 'ANY', ts: FLOOR - 90 * 86_400_000 })).stored, true);
  h.s.close();
  open.s.close();
});

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
  assert.equal(never.lead().inbox_state, 'in', 'it excludes itself and stays where it is: the daily sweep moves it');
  assert.equal(never.logs.some((e) => e.evt === 'inbox.refused_excluded'), false, 'a row that took the number is not reported');
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
  const refusal = (reason) => ({ level: 'warn', evt: 'inbox.refused_excluded', leadId: LEAD_ID, reason });
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
  assert.deepEqual(held.logs.filter((e) => e.evt === 'inbox.refused_excluded'), [refusal('held_by_other_lead')], 'one line: the lead id and a reason, no number');
  // Each refresh or catch-up reads the chat again: the same lead and reason is logged once.
  assert.deepEqual(held.ingest(held.lead(), rec()), { stored: false, reason: 'excluded' });
  assert.deepEqual(held.ingest(held.lead(), rec({ id: 'IN-H2' })), { stored: false, reason: 'excluded' });
  assert.equal(held.logs.filter((e) => e.evt === 'inbox.refused_excluded').length, 1, 'not again on a re-read');
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
  assert.deepEqual(other.logs.filter((e) => e.evt === 'inbox.refused_excluded'), [refusal('row_has_number')]);
  assertClean(other.logs);
  other.s.close();

});

test("a record the owner's number sent is checked by every number and lid it names, except the owner's own as its alt", () => {
  // A per-chat read (join history, catch-up, refresh) of a lid-only chat can hand over the
  // owner's message before any of the client's: its alt is the first sign of whose chat it
  // is. The poller screens a sent record's numbers too. Nothing is learned from a record we
  // sent: an outbound refusal writes nothing.
  const first = harness({ lead: { phone_e164: null, wa_jid: null } });
  first.team.addNever({ phone: PHONE, note: 'family' });
  const before = first.lead();
  assert.deepEqual(first.ingest(first.lead(), rec({ id: 'OWN-F', fromMe: true, text: TYPED })), { stored: false, reason: 'excluded' });
  assert.equal(first.inbox.hasMessages(LEAD_ID), false);
  assert.deepEqual(first.lead(), before, 'the row is not touched: no number learned, nobody made the handler');
  // The client's own record then teaches the row its number, as before.
  assert.deepEqual(first.ingest(first.lead(), rec()), { stored: false, reason: 'excluded' });
  assert.deepEqual([first.lead().phone_e164, first.lead().handler_user_id], [PHONE, null]);
  assertClean(first.logs);
  first.s.close();

  // Another lead holds the number, so the row can never learn it: every later record the
  // owner's number sends into the chat is still refused by the number it names.
  const held = harness({ lead: { phone_e164: null, wa_jid: null } });
  held.s.insertLead({ ...LEAD, lead_id: OTHER_LEAD_ID, wa_lid: null, inbox_state: 'out' });
  held.team.addNever({ phone: PHONE, note: 'family' });
  assert.deepEqual(held.ingest(held.lead(), rec()), { stored: false, reason: 'excluded' });
  assert.deepEqual(held.ingest(held.lead(), rec({ id: 'OWN-H', fromMe: true, text: TYPED, ts: NOW })), { stored: false, reason: 'excluded' });
  assert.equal(held.inbox.hasMessages(LEAD_ID), false);
  assert.deepEqual([held.lead().phone_e164, held.lead().handler_user_id, held.lead().last_msg_ts], [null, null, null]);
  assert.deepEqual(held.logs.filter((e) => e.evt === 'inbox.refused_excluded').map((e) => e.reason), ['held_by_other_lead', 'outbound']);
  assertClean(held.logs);
  held.s.close();

  // A team member's number as the alt is refused like any other.
  const staffAlt = harness({ lead: { phone_e164: null, wa_jid: null } });
  assert.deepEqual(staffAlt.ingest(staffAlt.lead(), rec({ id: 'OWN-T', fromMe: true, text: TYPED, jidAlt: '966500000009@s.whatsapp.net' })), { stored: false, reason: 'excluded' });
  staffAlt.s.close();

  // The owner's own number as a sent record's alt is the sender (`key.senderPn`), not the chat.
  const own = harness({ lead: { phone_e164: null, wa_jid: null } });
  const out = own.ingest(own.lead(), rec({ id: 'OWN-A', fromMe: true, text: TYPED, jidAlt: '966593296933@s.whatsapp.net' }));
  assert.deepEqual(out, { stored: true, inserted: true, senderKind: 'owner_number' });
  assert.equal(own.lead().handler_user_id, own.owner.user_id);
  // As the chat itself it is the owner's own chat, never a client's.
  assert.deepEqual(own.ingest(own.lead(), rec({ id: 'OWN-S', fromMe: true, text: TYPED, jid: '966593296933@s.whatsapp.net', jidAlt: null })), { stored: false, reason: 'excluded' });
  own.s.close();
});

test("a refused record teaches nothing to a row that holds a number or another chat's lid: a client's chat never excludes itself", () => {
  // Were the excluded number, or its lid, learned onto such a row, the row would exclude
  // itself: every read path would hide the client's chat, and the maintenance sweep (P2-20)
  // would take it out of the inbox and purge its transcript. Only a row that holds no number
  // learns one, and only from a record of its own chat that names one number.
  // Each with its own reason in the log line, so whoever looks into it can tell them apart.
  const cases = [
    // A form lead: its phone, no chat yet. The record's alt shows a never-list number.
    ['a phone and no jid', { phone_e164: CLIENT, wa_jid: null, wa_lid: null }, rec(), 'row_has_number'],
    // A phone-jid chat whose record comes under a lid the poller learned for a team member.
    ['a phone jid, a team lid', { phone_e164: CLIENT, wa_jid: CLIENT_JID, wa_lid: null }, rec({ jid: TEAM_LID, jidAlt: null }), 'row_has_number'],
    // A lid-only chat; the record comes under another chat's lid.
    ['another lid', { phone_e164: null, wa_jid: null, wa_lid: OTHER_LID }, rec(), 'other_chat'],
    // A lid-only chat; the record names two numbers, the first a never-list one.
    ['two numbers', { phone_e164: null, wa_jid: null, wa_lid: OTHER_LID }, rec({ jid: PHONE_JID, jidAlt: CLIENT_JID }), 'other_chat'],
    // A chat with no id yet; the record names a team lid and nothing the row could learn it by.
    ['a team lid alone', { phone_e164: null, wa_jid: null, wa_lid: null }, rec({ jid: TEAM_LID, jidAlt: null }), 'nothing_to_learn'],
  ];
  for (const [label, lead, record, reason] of cases) {
    const h = harness({ lead });
    h.team.addNever({ phone: PHONE, note: 'family' });
    learnTeamLid(h.s, '0500000009', TEAM_LID);
    const before = h.lead();
    assert.deepEqual(h.ingest(h.lead(), record), { stored: false, reason: 'excluded' }, label);
    assert.deepEqual(h.lead(), before, `${label}: the row is not touched`);
    assert.equal(h.inbox.hasMessages(LEAD_ID), false, label);
    assert.deepEqual(h.logs.filter((e) => e.evt === 'inbox.refused_excluded'), [{ level: 'warn', evt: 'inbox.refused_excluded', leadId: LEAD_ID, reason }], label);
    assert.equal(h.logs.some((e) => e.evt === 'inbox.learned'), false, label);
    assertClean(h.logs);
    // The client's own next message is still the client's.
    const own = rec({ id: 'IN-OWN', jid: lead.wa_lid ?? CLIENT_JID, jidAlt: null });
    assert.deepEqual(h.ingest(h.lead(), own), { stored: true, inserted: true, senderKind: 'client' }, `${label}: the chat is still a client's`);
    h.s.close();
  }

  // The rule stands whatever decides exclusion: a row that holds a phone takes no jid from a
  // refused record, not even one of its own number.
  const byJid = harness({ lead: { wa_jid: null, wa_lid: null }, isExcludedLead: (l) => l.wa_jid === PHONE_JID });
  const byJidBefore = byJid.lead();
  assert.deepEqual(byJid.ingest(byJid.lead(), rec()), { stored: false, reason: 'excluded' });
  assert.deepEqual(byJid.lead(), byJidBefore, 'the row is not touched');
  byJid.s.close();

  // A row that holds nothing yet takes the number the record names — its phone and phone jid
  // only, not the lid.
  const bare = harness({ lead: { phone_e164: null, wa_jid: null, wa_lid: null } });
  bare.team.addNever({ phone: PHONE, note: 'family' });
  assert.deepEqual(bare.ingest(bare.lead(), rec()), { stored: false, reason: 'excluded' });
  assert.deepEqual([bare.lead().phone_e164, bare.lead().wa_jid, bare.lead().wa_lid], [PHONE, PHONE_JID, null]);
  bare.s.close();
});

test('every number and lid a received record names is checked on its own', () => {
  // `jidsOf` keeps only the first phone jid and the first lid: a record whose jid and alt
  // name two different people must not have the second go unchecked.
  const phones = harness();
  phones.team.addNever({ phone: CLIENT, note: 'family' });
  assert.deepEqual(phones.ingest(phones.lead(), rec({ jid: PHONE_JID, jidAlt: CLIENT_JID })), { stored: false, reason: 'excluded' });
  assert.equal(phones.inbox.hasMessages(LEAD_ID), false);
  phones.s.close();

  const lids = harness();
  learnTeamLid(lids.s, '0500000009', TEAM_LID);
  assert.deepEqual(lids.ingest(lids.lead(), rec({ jid: LID, jidAlt: TEAM_LID })), { stored: false, reason: 'excluded' });
  assert.equal(lids.inbox.hasMessages(LEAD_ID), false);
  lids.s.close();
});

test('a login code coming back in a chat is never stored, and its outbox row is left as it was', () => {
  // Belt and braces: a code only ever goes to a team member, whose chat the exclusion above
  // already refuses. The code must still never reach wa_messages (design §4.2).
  const h = harness();
  // Worded so the code's own shape (next test) does not refuse it: only its message id can.
  const code = 'Your Bona sign-in code is 482913';
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

test("a login code's own text is refused even when its outbox row carries no message id, or is gone", () => {
  // The message id is the first defence, but a send that went uncertain never recorded one,
  // and the daily upkeep deletes code rows after two days (P2-18). Nor can the text match find
  // a code row: it has no lead and no text. So the code's own shape is refused too (P2-21).
  const code = codeMessage('482913');
  const keyless = harness();
  keyless.inbox.insertOutbox({ send_id: 'SND-code-2', jid: PHONE_JID, sender_kind: 'code', status: 'uncertain' });
  const before = keyless.inbox.getOutbox('SND-code-2');
  assert.deepEqual(
    keyless.ingest(keyless.lead(), rec({ id: 'CODE-2', fromMe: true, jid: PHONE_JID, jidAlt: null, text: code })),
    { stored: false, reason: 'code' },
  );
  assert.deepEqual(keyless.inbox.getOutbox('SND-code-2'), before, 'the row is not touched');
  assert.equal(keyless.inbox.hasMessages(LEAD_ID), false);
  assert.deepEqual([keyless.lead().handler_user_id, keyless.lead().last_msg_ts], [null, null]);
  keyless.s.close();

  const gone = harness();
  assert.deepEqual(gone.ingest(gone.lead(), rec({ id: 'CODE-3', fromMe: true, jid: PHONE_JID, jidAlt: null, text: code })), { stored: false, reason: 'code' });
  // A code relayed back into the chat is a live credential all the same.
  assert.deepEqual(gone.ingest(gone.lead(), rec({ id: 'CODE-4', text: ` ${code}\n` })), { stored: false, reason: 'code' });
  assert.equal(gone.inbox.hasMessages(LEAD_ID), false);
  // Only the code's own shape: a message that merely talks about a code is stored.
  assert.equal(gone.ingest(gone.lead(), rec({ id: 'OWN-C', fromMe: true, text: 'Your viewing code is 482913' })).stored, true);
  assert.equal(JSON.stringify(gone.logs).includes('482913'), false);
  gone.s.close();
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

test('the poller\'s match and the HTTP 2xx both mark a send accepted; whichever comes second, the first acceptance time stays (PLAN T07, PR-B2 #94)', () => {
  const SENT = NOW + 1_000;
  // wa-send.mjs on a 2xx with a key: updateOutbox(accepted, the key), always written.
  const httpOk = (h, key) => h.inbox.updateOutbox('SND-dana-2', { status: 'accepted', key_id: key });
  const record = rec({ id: 'DANA-2', fromMe: true, jid: PHONE_JID, jidAlt: null, text: REPLY, ts: SENT });
  const fresh = () => {
    const h = harness();
    h.at(SENT);
    h.inbox.insertOutbox({ send_id: 'SND-dana-2', lead_id: LEAD_ID, jid: PHONE_JID, text: REPLY, sender_kind: 'dana' });
    return h;
  };

  // The poller first: it matches WhatsApp's copy by its text while the call is still out; the 2xx comes back later.
  const a = fresh();
  a.at(SENT + 3_000);
  assert.equal(a.ingest(a.lead(), record).senderKind, 'dana');
  assert.deepEqual([a.inbox.getOutbox('SND-dana-2').status, a.inbox.getOutbox('SND-dana-2').updated], ['accepted', SENT + 3_000]);
  a.at(SENT + 12_000);
  httpOk(a, 'DANA-2');
  assert.deepEqual([a.inbox.getOutbox('SND-dana-2').key_id, a.inbox.getOutbox('SND-dana-2').updated], ['DANA-2', SENT + 3_000], 'poller, then 2xx');
  a.s.close();

  // The 2xx first; the poller reads WhatsApp's copy on its next tick and finds the row by its key.
  const b = fresh();
  b.at(SENT + 3_000);
  httpOk(b, 'DANA-2');
  b.at(SENT + 12_000);
  assert.equal(b.ingest(b.lead(), record).senderKind, 'dana');
  // A thread refresh reads it again later still.
  b.at(SENT + 60_000);
  assert.equal(b.ingest(b.lead(), record).senderKind, 'dana');
  assert.deepEqual([b.inbox.getOutbox('SND-dana-2').key_id, b.inbox.getOutbox('SND-dana-2').updated], ['DANA-2', SENT + 3_000], '2xx, then poller');
  b.s.close();
});

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

  // Nor half of one: a phone jid and its number name one person, so when another lead holds
  // either — a form lead's phone alone, or a jid alone — the row learns neither.
  for (const [label, holder] of [['phone only', { wa_jid: null }], ['jid only', { phone_e164: null }]]) {
    const f = harness({ lead: { phone_e164: null, wa_jid: null } });
    f.s.insertLead({ ...LEAD, lead_id: OTHER_LEAD_ID, wa_lid: null, ...holder });
    assert.equal(f.ingest(f.lead(), rec()).stored, true, label);
    assert.deepEqual([f.lead().phone_e164, f.lead().wa_jid], [null, null], label);
    f.s.close();
  }

  // Nor anything from a record of another chat: one under another lid, or one that shows
  // another number than the row's. The message is stored; the row keeps its own identity.
  for (const [label, lead] of [['another lid', { phone_e164: null, wa_jid: null, wa_lid: OTHER_LID }], ['another number', { phone_e164: CLIENT, wa_jid: null, wa_lid: null }]]) {
    const g = harness({ lead });
    const before = g.lead();
    assert.equal(g.ingest(g.lead(), rec()).stored, true, label);
    assert.deepEqual([g.lead().phone_e164, g.lead().wa_jid, g.lead().wa_lid], [before.phone_e164, before.wa_jid, before.wa_lid], label);
    g.s.close();
  }
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
  // The owner became the handler when the record was first read as his number's, and stays:
  // by then the chat has a handler, and ingest cannot tell an owner made handler by this
  // record from one who handled the chat already (P2-15 gives a handler only when none).
  assert.equal(h.lead().handler_user_id, h.owner.user_id);
  h.s.close();
});

test('a record read again never claims a send by its text: once stored, only its message id can change who sent it', () => {
  // The owner types "OK" and it is stored; three seconds later a staff reply "OK" goes
  // uncertain. A thread refresh reads the owner's record again. It must not resolve the staff
  // send (the reply may never have gone) nor relabel the owner's bubble as hers.
  const h = harness();
  const typed = rec({ id: 'OWN-R', fromMe: true, text: 'OK', ts: NOW });
  assert.equal(h.ingest(h.lead(), typed).senderKind, 'owner_number');
  h.at(NOW + 3_000);
  h.inbox.insertOutbox({ send_id: 'SND-later-1', lead_id: LEAD_ID, jid: PHONE_JID, text: 'OK', user_id: h.staff.user_id, sender_kind: 'staff', status: 'uncertain' });
  h.at(NOW + 60_000);
  assert.deepEqual(h.ingest(h.lead(), typed), { stored: true, inserted: false, senderKind: 'owner_number' });
  const row = h.inbox.getOutbox('SND-later-1');
  assert.deepEqual([row.status, row.key_id], ['uncertain', null], 'the staff send still shows it may not have gone');
  const [m] = h.inbox.messagesFor(LEAD_ID);
  assert.deepEqual([m.sender_kind, m.sender_user_id], ['owner_number', null]);
  assert.equal(h.logs.some((e) => e.evt === 'inbox.outbox.resolved'), false);
  h.s.close();
});

test('a record stamped before a send was written is not that send, beyond the clock\'s whole seconds', () => {
  // The owner typed "OK" before a staff reply "OK" went uncertain, and the record is read only
  // now. A send's record is stamped after its outbox row is written, so it can be that send
  // only when it is at most SEND_SKEW_MS older than the row.
  const cases = [['a minute before', NOW - 60_000, false], ['past the skew', NOW - SEND_SKEW_MS - 1, false], ['at the skew', NOW - SEND_SKEW_MS, true]];
  for (const [label, ts, resolved] of cases) {
    const h = harness();
    h.inbox.insertOutbox({ send_id: 'SND-after-1', lead_id: LEAD_ID, jid: PHONE_JID, text: 'OK', user_id: h.staff.user_id, sender_kind: 'staff', status: 'uncertain' });
    assert.equal(h.ingest(h.lead(), rec({ id: 'OWN-B', fromMe: true, text: 'OK', ts })).senderKind, resolved ? 'staff' : 'owner_number', label);
    const row = h.inbox.getOutbox('SND-after-1');
    assert.deepEqual([row.status, row.key_id], resolved ? ['accepted', 'OWN-B'] : ['uncertain', null], label);
    h.s.close();
  }
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

/* ---------------- follow-ups from the Task 9 reviews (2026-09-28) ---------------- */

test("the owner's own number as a sent record's alt is known by the instance's number, with no owner account to read it from", () => {
  // Deactivated or demoted, the owner row gives no user id. His number is still in `users`,
  // so read from his account it would be refused as a team number in every chat he answers.
  const OWN_ALT = '966593296933@s.whatsapp.net';
  const typed = (id) => rec({ id, fromMe: true, text: TYPED, jidAlt: OWN_ALT });
  for (const ownerPhone of ['966593296933', () => '966593296933']) {
    const h = harness({ ownerUserId: () => null, ownerPhone });
    assert.deepEqual(h.ingest(h.lead(), typed('OWN-N')), { stored: true, inserted: true, senderKind: 'owner_number' });
    assert.equal(h.lead().handler_user_id, null, 'no owner account, so nobody is made the handler');
    // As the chat itself it is still his own chat, never a client's.
    assert.deepEqual(h.ingest(h.lead(), rec({ id: 'OWN-S', fromMe: true, text: TYPED, jid: OWN_ALT, jidAlt: null })), { stored: false, reason: 'excluded' });
    assertClean(h.logs);
    h.s.close();
  }

  // Left out, it is read from the owner account, as before: with none, the alt is a team number.
  const noAccount = harness({ ownerUserId: () => null });
  assert.deepEqual(noAccount.ingest(noAccount.lead(), typed('OWN-D')), { stored: false, reason: 'excluded' });
  noAccount.s.close();
  const account = harness();
  assert.equal(account.ingest(account.lead(), typed('OWN-E')).senderKind, 'owner_number');
  account.s.close();
});

test('a record with no time of its own is stored at now, but never claims a send by its text; its message id still does', () => {
  for (const ts of [undefined, null, Number.NaN, String(NOW)]) {
    const label = String(ts);
    const h = harness();
    h.inbox.insertOutbox({ send_id: 'SND-nots-1', lead_id: LEAD_ID, jid: PHONE_JID, text: REPLY, user_id: h.staff.user_id, sender_kind: 'staff', status: 'uncertain' });
    const out = h.ingest(h.lead(), rec({ id: 'OUT-NT', fromMe: true, text: REPLY, ts }));
    assert.equal(out.senderKind, 'owner_number', label);
    const row = h.inbox.getOutbox('SND-nots-1');
    assert.deepEqual([row.status, row.key_id], ['uncertain', null], label);
    assert.equal(h.inbox.messagesFor(LEAD_ID)[0].ts, NOW, `${label}: stored at now()`);

    h.inbox.insertOutbox({ send_id: 'SND-nots-2', lead_id: LEAD_ID, jid: PHONE_JID, text: 'Photos attached', user_id: h.staff.user_id, sender_kind: 'staff' });
    h.inbox.updateOutbox('SND-nots-2', { status: 'accepted', key_id: 'OUT-NT2' });
    assert.equal(h.ingest(h.lead(), rec({ id: 'OUT-NT2', fromMe: true, text: 'Photos attached', ts })).senderKind, 'staff', label);
    h.s.close();
  }
});

test("a record carrying a login code's message id is refused whichever way it is filed, even as received, before anything is learned", () => {
  const h = harness({ lead: { phone_e164: null, wa_jid: null } });
  h.inbox.insertOutbox({ send_id: 'SND-code-5', jid: PHONE_JID, sender_kind: 'code' });
  h.inbox.updateOutbox('SND-code-5', { status: 'accepted', key_id: 'CODE-5' });
  const row = h.inbox.getOutbox('SND-code-5');
  const lead = h.lead();
  // Worded so the code's own shape does not refuse it: only its message id can.
  assert.deepEqual(h.ingest(h.lead(), rec({ id: 'CODE-5', text: 'Your Bona sign-in code is 482913' })), { stored: false, reason: 'code' });
  assert.equal(h.inbox.hasMessages(LEAD_ID), false);
  assert.deepEqual(h.inbox.getOutbox('SND-code-5'), row, 'the row is not touched');
  assert.deepEqual(h.lead(), lead, 'the row learns nothing from it');
  assert.equal(JSON.stringify(h.logs).includes('482913'), false);
  h.s.close();
});

test('a human outbound stored for the first time stamps last_human_out_ts; Dana and the client never do; a re-read never moves it back', () => {
  const h = harness();
  const lead = h.lead();
  const rec = (id, ts, fromMe, text) => ({ id, jid: lead.wa_jid, jidAlt: null, fromMe, ts, text, pushName: null, contextInfo: null, messageType: 'conversation' });
  assert.equal(h.ingest(lead, rec('IN-1', NOW - 50_000, false, 'hello')).stored, true);
  assert.equal(h.lead().last_human_out_ts, null, 'a client message is not a human answer');
  assert.deepEqual(h.ingest(lead, rec('OUT-1', NOW - 40_000, true, 'typed on the phone')), { stored: true, inserted: true, senderKind: 'owner_number' });
  assert.equal(h.lead().last_human_out_ts, NOW - 40_000);
  // A Dana send: the outbox row names the record by its id.
  h.inbox.insertOutbox({ send_id: 'SND-dana000000001', lead_id: lead.lead_id, jid: lead.wa_jid, text: 'from dana', sender_kind: 'dana' });
  h.inbox.updateOutbox('SND-dana000000001', { status: 'accepted', key_id: 'OUT-D' });
  assert.deepEqual(h.ingest(lead, rec('OUT-D', NOW - 30_000, true, 'from dana')), { stored: true, inserted: true, senderKind: 'dana' });
  assert.equal(h.lead().last_human_out_ts, NOW - 40_000, 'Dana is not a human');
  assert.deepEqual(h.ingest(lead, rec('OUT-0', NOW - 90_000, true, 'older, read by a history backfill')), { stored: true, inserted: true, senderKind: 'owner_number' });
  assert.equal(h.lead().last_human_out_ts, NOW - 40_000, 'never back');
  assert.deepEqual(h.ingest(lead, rec('OUT-1', NOW - 40_000, true, 'typed on the phone')), { stored: true, inserted: false, senderKind: 'owner_number' });
  assert.equal(h.lead().last_human_out_ts, NOW - 40_000);
  assertClean(h.logs);
});

/* -------------------- PR-F2b (DESIGN §7.1, critic C2): an owner note is refused by its key -------------------- */

test("an owner note coming back in a chat is refused by its outbox key, sent or received, before anything is written or learned", () => {
  // The owner's own chat joins only under the test switch (PR-A2); our notes to him sit in it.
  // A note's outbox row has no lead and no text, so only its message id can name it.
  const h = harness({ lead: { phone_e164: null, wa_jid: null } });
  const note = '*Bona — new enquiry*\nName: Sara\nPhone: +966500000002';
  h.inbox.insertOutbox({ send_id: 'SND-note-1', jid: PHONE_JID, sender_kind: 'note' });
  h.inbox.updateOutbox('SND-note-1', { status: 'accepted', key_id: 'NOTE-1' });
  const before = h.inbox.getOutbox('SND-note-1');
  assert.deepEqual(
    h.ingest(h.lead(), rec({ id: 'NOTE-1', fromMe: true, jid: PHONE_JID, jidAlt: null, text: note })),
    { stored: false, reason: 'note' },
  );
  // Filed as received (a lid chat, an Evolution quirk): refused before the lead learns a number from it.
  assert.deepEqual(h.ingest(h.lead(), rec({ id: 'NOTE-1', text: note })), { stored: false, reason: 'note' });
  assert.equal(h.inbox.hasMessages(LEAD_ID), false);
  assert.deepEqual(h.inbox.getOutbox('SND-note-1'), before, 'the row is not touched');
  assert.equal(h.lead().phone_e164, null, 'nothing is learned from a note');
  assert.equal(h.lead().handler_user_id, null, 'a note makes nobody the handler');
  assert.equal(h.lead().last_msg_ts, null);
  assertClean(h.logs);
  h.s.close();
});

test('a note record that also names an excluded number (the owner\'s own chat, filed as received) is refused by its key first: the lid-only row learns nothing', () => {
  // The exclusion branch learns the excluded number onto a lid-only row (it then excludes itself
  // and leaves the inbox at the daily sweep). For a note's own copy that lesson would be ours,
  // not the chat's, so the key is looked up before that branch runs.
  const h = harness({ lead: { phone_e164: null, wa_jid: null } });
  h.team.addNever({ phone: PHONE, note: 'stands in for the owner' });
  const note = '*Bona — new enquiry*\nName: Sara\nPhone: +966500000002';
  h.inbox.insertOutbox({ send_id: 'SND-note-2', jid: PHONE_JID, sender_kind: 'note' });
  h.inbox.updateOutbox('SND-note-2', { status: 'accepted', key_id: 'NOTE-2' });
  assert.deepEqual(h.ingest(h.lead(), rec({ id: 'NOTE-2', text: note })), { stored: false, reason: 'note' });
  assert.deepEqual([h.lead().phone_e164, h.lead().wa_jid, h.lead().wa_lid], [null, null, LID], 'no number learned from our own note');
  assert.equal(h.inbox.hasMessages(LEAD_ID), false);
  // The same record without a note row behind it is the excluded number's: the row learns it, as before.
  assert.deepEqual(h.ingest(h.lead(), rec({ id: 'IN-EXCL', text: TEXT })), { stored: false, reason: 'excluded' });
  assert.deepEqual([h.lead().phone_e164, h.lead().wa_jid], [PHONE, PHONE_JID]);
  assertClean(h.logs);
  h.s.close();
});

/* ---------------- PR-A2 (PLAN T07 tests 9-14; DESIGN §3.2): the test chat, commands, holds, media, the rollback guard ---------------- */

/** The owner (BONA_OWNER_JID), Bona's own number, the owner's test lead and another client's lead: test numbers only. */
const T_OWNER = '966500000010';
const T_OWNER_JID = `${T_OWNER}@s.whatsapp.net`;
const T_INSTANCE = '966500000020';
const T_INSTANCE_JID = `${T_INSTANCE}@s.whatsapp.net`;
const T_LEAD = 'LEAD-20261127-0000test';
const T_THIRD = 'LEAD-20261127-0000cccc';
const T_THIRD_JID = '966500000003@s.whatsapp.net';
const GREETING = 'Thank you for contacting Bona. We will reply as soon as we can.';
const T_DAY = 86_400_000;
const T_PERSONAL = [...PERSONAL, T_OWNER, T_INSTANCE, '966500000003', 'Owner Example', GREETING];

/**
 * The test switch the way lib/owner-test.mjs answers ingest and the team: `ok` is ownNumberOk
 * (Bona's own number, identity checked), `on` the test switch.
 */
function fakeSwitch({ ok = true, on = true } = {}) {
  return {
    ok, on,
    ownNumberOk() { return this.ok; },
    active() { return this.on && this.ok; },
    ownerDigits: () => T_OWNER,
    ownerLid: () => null,
  };
}

/**
 * The owner's test lead (inbox_via 'owner_test') and a client's chat (LEAD, joined by proof),
 * both `in`. The team reads the test switch (index.mjs hands it in), so while the test is on
 * the owner's number is a client's chat; ingest gets the switch and the notes.
 */
function testChat({ sw = fakeSwitch(), lead = {}, client = {}, withSwitch = true } = {}) {
  const s = openDb(':memory:');
  let clock = NOW;
  const now = () => clock;
  const team = createTeam(s, { now, ownerTest: sw });
  const owner = team.ensureOwner({ phone: T_OWNER, name: 'Owner Example' });
  const staff = team.addUser({ name: 'Sara Staff', phone: '0500000009', role: 'staff' });
  const inbox = createInboxStore(s, { now });
  const logs = [];
  const alerts = [];
  const notes = { alert: (code, meta) => { alerts.push({ code, meta: meta ?? null, at: clock }); return { queued: true }; } };
  const make = () => createIngest({
    db: s, inbox, ownerUserId: () => owner.user_id, ownerPhone: T_INSTANCE, notes, log: (o) => logs.push(o), now,
    isExcludedLead: (l) => isExcludedLeadOf(team, s, l),
    ...(withSwitch ? { ownerTest: sw } : {}),
  });
  s.insertLead({
    lead_id: T_LEAD, created: NOW - T_DAY, updated: NOW - T_DAY, phone_e164: T_OWNER, wa_jid: T_OWNER_JID, channel: 'whatsapp',
    match_method: 'owner_test', inbox_via: 'owner_test', stage: 'new', inbox_state: 'in', inbox_since: NOW - 3_600_000, history_from: NOW - 3_600_000, ...lead,
  });
  s.insertLead({ ...LEAD, ...client });
  return {
    s, team, owner, staff, inbox, logs, alerts, sw, notes, ingest: make().ingest, restart() { this.ingest = make().ingest; },
    lead: (id = T_LEAD) => s.getLead(id), at: (t) => { clock = t; }, now,
  };
}
/** An outbound record of the owner's test chat (Bona's number writing to him). */
const toOwner = (over = {}) => rec({ id: 'T-OUT', fromMe: true, jid: T_OWNER_JID, jidAlt: null, text: 'Sent from the Fold', ts: NOW - 30_000, ...over });

function assertCleanT(logs) {
  const out = JSON.stringify(logs);
  for (const needle of T_PERSONAL) assert.equal(out.includes(needle), false, 'a log line carries personal data');
}

test("the owner's test chat stores a sent record only when a staff or Dana outbox row is its send; anything else is test_chat_untracked", () => {
  const h = testChat({ lead: { needs_human: 1 } });
  // Typed on the Fold, a command confirmation, a note whose send went uncertain: none is his chat.
  assert.deepEqual(h.ingest(h.lead(), toOwner()), { stored: false, reason: 'test_chat_untracked' });
  assert.deepEqual(h.ingest(h.lead(), toOwner({ id: 'T-NOTE', text: '*Bona — test mode* ON' })), { stored: false, reason: 'test_chat_untracked' });
  // The poller's call alert from bona2 (call_alert.py, critic C3): no outbox row, a listing in it.
  const callAlert = '📞 Bona line call — missed\nListings: BONA-W012';
  assert.deepEqual(h.ingest(h.lead(), toOwner({ id: 'T-CALL', text: callAlert })), { stored: false, reason: 'test_chat_untracked' });
  // Critic I2 for real: nothing of it reached the chat's human clock, its hand-over flag or its handler.
  assert.deepEqual([h.lead().last_human_out_ts, h.lead().needs_human, h.lead().handler_user_id, h.inbox.countMessages(T_LEAD)], [null, 1, null, 0]);
  // A staff reply (by its id, and an uncertain one by its text) and a Dana send are his chat's.
  h.inbox.insertOutbox({ send_id: 'SND-t-staff', lead_id: T_LEAD, jid: T_OWNER_JID, text: 'From the dashboard', user_id: h.staff.user_id, sender_kind: 'staff' });
  h.inbox.updateOutbox('SND-t-staff', { status: 'accepted', key_id: 'T-STAFF' });
  assert.deepEqual(h.ingest(h.lead(), toOwner({ id: 'T-STAFF', text: 'From the dashboard' })), { stored: true, inserted: true, senderKind: 'staff' });
  h.inbox.insertOutbox({ send_id: 'SND-t-unsure', lead_id: T_LEAD, jid: T_OWNER_JID, text: 'Not sure it went', user_id: h.staff.user_id, sender_kind: 'staff', status: 'uncertain' });
  assert.equal(h.ingest(h.lead(), toOwner({ id: 'T-UNSURE', text: 'Not sure it went', ts: NOW + 1000 })).senderKind, 'staff');
  h.inbox.insertOutbox({ send_id: 'SND-t-dana', lead_id: T_LEAD, jid: T_OWNER_JID, text: 'Hello from the assistant', sender_kind: 'dana' });
  h.inbox.updateOutbox('SND-t-dana', { status: 'accepted', key_id: 'T-DANA' });
  assert.deepEqual(h.ingest(h.lead(), toOwner({ id: 'T-DANA', text: 'Hello from the assistant' })), { stored: true, inserted: true, senderKind: 'dana' });
  // His own messages are the client's.
  assert.deepEqual(h.ingest(h.lead(), rec({ id: 'T-IN', jid: T_OWNER_JID, jidAlt: null, text: 'Is the villa free?' })), { stored: true, inserted: true, senderKind: 'client' });
  assert.deepEqual(h.inbox.messagesFor(T_LEAD).map((m) => m.sender_kind).sort(), ['client', 'dana', 'staff', 'staff']);
  // Any other chat is as before: an untracked sent record is the owner's number.
  assert.deepEqual(h.ingest(h.lead(LEAD_ID), rec({ id: 'C-OUT', fromMe: true, jid: PHONE_JID, jidAlt: null, text: TYPED })), { stored: true, inserted: true, senderKind: 'owner_number' });
  assertCleanT(h.logs);
  h.s.close();
});

test('the Greeting/Away detector: one untracked sent text in two chats within 24 h → one greeting_away alert a day', () => {
  const h = testChat();
  h.s.insertLead({ ...LEAD, lead_id: T_THIRD, phone_e164: '966500000003', wa_jid: T_THIRD_JID, wa_lid: null });
  // The test chat's copy is dropped, the client's is stored: both count.
  h.ingest(h.lead(), toOwner({ id: 'G-1', text: GREETING, ts: NOW - 60_000 }));
  assert.deepEqual(h.alerts, []);
  // The same chat again is one chat.
  h.ingest(h.lead(), toOwner({ id: 'G-1b', text: GREETING, ts: NOW - 50_000 }));
  assert.deepEqual(h.alerts, []);
  assert.equal(h.ingest(h.lead(LEAD_ID), rec({ id: 'G-2', fromMe: true, jid: PHONE_JID, jidAlt: null, text: `  ${GREETING}`, ts: NOW - 30_000 })).senderKind, 'owner_number');
  assert.deepEqual(h.alerts.map((a) => a.code), ['greeting_away']);
  assert.equal(JSON.stringify(h.alerts).includes(GREETING), false, 'the alert carries no text');
  // A third chat the same (Riyadh) day: still one.
  h.ingest(h.lead(T_THIRD), rec({ id: 'G-3', fromMe: true, jid: T_THIRD_JID, jidAlt: null, text: GREETING, ts: NOW - 10_000 }));
  assert.equal(h.alerts.length, 1);
  // The next Riyadh day (NOW is 15:00 there), two chats again: one more.
  h.at(NOW + 12 * 3_600_000);
  h.ingest(h.lead(LEAD_ID), rec({ id: 'G-4', fromMe: true, jid: PHONE_JID, jidAlt: null, text: GREETING, ts: h.now() - 20_000 }));
  h.ingest(h.lead(T_THIRD), rec({ id: 'G-5', fromMe: true, jid: T_THIRD_JID, jidAlt: null, text: GREETING, ts: h.now() - 10_000 }));
  assert.equal(h.alerts.length, 2);
  assertCleanT(h.logs);
  h.s.close();

  // Not a greeting: a short reply in ONE chat (twice), photos with no caption in two chats, a tracked send,
  // an old record (a join's history), two days apart.
  const n = testChat();
  n.s.insertLead({ ...LEAD, lead_id: T_THIRD, phone_e164: '966500000003', wa_jid: T_THIRD_JID, wa_lid: null });
  n.ingest(n.lead(LEAD_ID), rec({ id: 'S-1', fromMe: true, jid: PHONE_JID, jidAlt: null, text: 'Ok', ts: NOW - 20_000 }));
  n.ingest(n.lead(LEAD_ID), rec({ id: 'S-2', fromMe: true, jid: PHONE_JID, jidAlt: null, text: 'Ok', ts: NOW - 15_000 }));
  n.ingest(n.lead(LEAD_ID), rec({ id: 'P-1', fromMe: true, jid: PHONE_JID, jidAlt: null, text: '', media: '[image]', ts: NOW - 12_000 }));
  n.ingest(n.lead(T_THIRD), rec({ id: 'P-2', fromMe: true, jid: T_THIRD_JID, jidAlt: null, text: '', media: '[image]', ts: NOW - 11_000 }));
  for (const [id, leadId, jid] of [['D-1', LEAD_ID, PHONE_JID], ['D-2', T_THIRD, T_THIRD_JID]]) {
    n.inbox.insertOutbox({ send_id: `SND-${id}`, lead_id: leadId, jid, text: GREETING, sender_kind: 'dana' });
    n.inbox.updateOutbox(`SND-${id}`, { status: 'accepted', key_id: id });
    n.ingest(n.lead(leadId), rec({ id, fromMe: true, jid, jidAlt: null, text: GREETING, ts: NOW - 5_000 }));
  }
  n.ingest(n.lead(LEAD_ID), rec({ id: 'O-1', fromMe: true, jid: PHONE_JID, jidAlt: null, text: `${GREETING} (old)`, ts: NOW - 3 * T_DAY }));
  n.ingest(n.lead(T_THIRD), rec({ id: 'O-2', fromMe: true, jid: T_THIRD_JID, jidAlt: null, text: `${GREETING} (old)`, ts: NOW - 30_000 }));
  assert.deepEqual(n.alerts, []);
  n.s.close();
});

test("the Greeting/Away detector survives a restart: the stored copy counts, and a day's alert already in the ledger is not sent again", () => {
  const h = testChat();
  h.s.insertLead({ ...LEAD, lead_id: T_THIRD, phone_e164: '966500000003', wa_jid: T_THIRD_JID, wa_lid: null });
  h.ingest(h.lead(LEAD_ID), rec({ id: 'R-1', fromMe: true, jid: PHONE_JID, jidAlt: null, text: GREETING, ts: NOW - 3_600_000 }));
  h.restart();
  h.ingest(h.lead(T_THIRD), rec({ id: 'R-2', fromMe: true, jid: T_THIRD_JID, jidAlt: null, text: GREETING, ts: NOW - 60_000 }));
  assert.deepEqual(h.alerts.map((a) => a.code), ['greeting_away']);
  // Restarted again: today's alert row (the ledger's `al:greeting_away:<hour>`) is there, so no second one today.
  const hour = Math.floor(NOW / 3_600_000);
  h.s.db.prepare(`INSERT INTO owner_notes (note_id, kind, lead_id, dedupe_key, due_ts, status, meta, created, updated)
                  VALUES ('NOTE-1', 'alert', NULL, ?, ?, 'sent', '{"alert":"greeting_away"}', ?, ?)`).run(`al:greeting_away:${hour}`, NOW, NOW, NOW);
  h.restart();
  h.ingest(h.lead(LEAD_ID), rec({ id: 'R-3', fromMe: true, jid: PHONE_JID, jidAlt: null, text: GREETING, ts: NOW - 20_000 }));
  assert.equal(h.alerts.length, 1);
  h.s.close();
});

test('the Greeting/Away detector has no shortest text: a short away message in English or Arabic, in two chats, raises the alert; in one chat it does not', () => {
  for (const away of ['Back tomorrow', 'بعود بكرة']) {
    // The test chat's dropped copy and a client's stored one.
    const h = testChat();
    h.ingest(h.lead(), toOwner({ id: 'A-1', text: away, ts: NOW - 60_000 }));
    assert.deepEqual(h.alerts, [], away);
    h.ingest(h.lead(LEAD_ID), rec({ id: 'A-2', fromMe: true, jid: PHONE_JID, jidAlt: null, text: away, ts: NOW - 30_000 }));
    assert.deepEqual(h.alerts.map((a) => a.code), ['greeting_away'], away);
    assert.equal(JSON.stringify([h.alerts, h.logs]).includes(away), false, 'neither the alert nor a log line carries the text');
    h.s.close();

    // Two clients' chats, across a restart: the stored copy of the first counts.
    const r = testChat();
    r.s.insertLead({ ...LEAD, lead_id: T_THIRD, phone_e164: '966500000003', wa_jid: T_THIRD_JID, wa_lid: null });
    r.ingest(r.lead(LEAD_ID), rec({ id: 'A-3', fromMe: true, jid: PHONE_JID, jidAlt: null, text: away, ts: NOW - 3_600_000 }));
    r.restart();
    r.ingest(r.lead(T_THIRD), rec({ id: 'A-4', fromMe: true, jid: T_THIRD_JID, jidAlt: null, text: ` ${away} `, ts: NOW - 60_000 }));
    assert.deepEqual(r.alerts.map((a) => a.code), ['greeting_away'], away);
    r.s.close();

    // One short reply in ONE chat, read again and sent again: one chat is no greeting.
    const one = testChat();
    one.ingest(one.lead(LEAD_ID), rec({ id: 'A-5', fromMe: true, jid: PHONE_JID, jidAlt: null, text: away, ts: NOW - 30_000 }));
    one.ingest(one.lead(LEAD_ID), rec({ id: 'A-5', fromMe: true, jid: PHONE_JID, jidAlt: null, text: away, ts: NOW - 30_000 }));
    one.ingest(one.lead(LEAD_ID), rec({ id: 'A-6', fromMe: true, jid: PHONE_JID, jidAlt: null, text: away, ts: NOW - 20_000 }));
    one.restart();
    one.ingest(one.lead(LEAD_ID), rec({ id: 'A-7', fromMe: true, jid: PHONE_JID, jidAlt: null, text: away, ts: NOW - 10_000 }));
    assert.deepEqual(one.alerts, [], away);
    one.s.close();
  }
});

test('a human message clears a hold that waits for a person (and needs_human, as before); a timed hold stays until its end', () => {
  const human = [
    ['a staff reply', (h) => {
      h.inbox.insertOutbox({ send_id: 'SND-h', lead_id: LEAD_ID, jid: PHONE_JID, text: REPLY, user_id: h.staff.user_id, sender_kind: 'staff' });
      h.inbox.updateOutbox('SND-h', { status: 'accepted', key_id: 'H-1' });
      return rec({ id: 'H-1', fromMe: true, jid: PHONE_JID, jidAlt: null, text: REPLY });
    }],
    ["the owner's phone", () => rec({ id: 'H-1', fromMe: true, jid: PHONE_JID, jidAlt: null, text: TYPED })],
  ];
  for (const [label, make] of human) {
    const h = testChat({ client: { needs_human: 1, dana_hold_reason: 'loop', dana_hold_until: null } });
    assert.equal(h.ingest(h.lead(LEAD_ID), make(h)).stored, true, label);
    assert.deepEqual([h.lead(LEAD_ID).dana_hold_reason, h.lead(LEAD_ID).dana_hold_until, h.lead(LEAD_ID).needs_human], [null, null, 0], label);
    h.s.close();
  }
  // Timed: it stays (its end lets the assistant answer again).
  const timed = testChat({ client: { dana_hold_reason: 'cap_chat', dana_hold_until: NOW + 3_600_000 } });
  timed.ingest(timed.lead(LEAD_ID), rec({ id: 'H-2', fromMe: true, jid: PHONE_JID, jidAlt: null, text: TYPED }));
  assert.deepEqual([timed.lead(LEAD_ID).dana_hold_reason, timed.lead(LEAD_ID).dana_hold_until], ['cap_chat', NOW + 3_600_000]);
  timed.s.close();
  // Neither the client nor the assistant is a person answering.
  const not = testChat({ client: { dana_hold_reason: 'send_failed', dana_hold_until: null } });
  not.ingest(not.lead(LEAD_ID), rec({ id: 'H-3' }));
  not.inbox.insertOutbox({ send_id: 'SND-d', lead_id: LEAD_ID, jid: PHONE_JID, text: 'From the assistant', sender_kind: 'dana' });
  not.inbox.updateOutbox('SND-d', { status: 'accepted', key_id: 'H-4' });
  assert.equal(not.ingest(not.lead(LEAD_ID), rec({ id: 'H-4', fromMe: true, jid: PHONE_JID, jidAlt: null, text: 'From the assistant' })).senderKind, 'dana');
  assert.equal(not.lead(LEAD_ID).dana_hold_reason, 'send_failed');
  // A human message read again (a refresh) is not a new one.
  not.ingest(not.lead(LEAD_ID), rec({ id: 'H-5', fromMe: true, jid: PHONE_JID, jidAlt: null, text: TYPED }));
  assert.equal(not.lead(LEAD_ID).dana_hold_reason, null);
  not.inbox.setNeedsHuman(LEAD_ID, 0);
  not.s.updateLead(LEAD_ID, { dana_hold_reason: 'loop' });
  not.ingest(not.lead(LEAD_ID), rec({ id: 'H-5', fromMe: true, jid: PHONE_JID, jidAlt: null, text: TYPED }));
  assert.equal(not.lead(LEAD_ID).dana_hold_reason, 'loop');
  not.s.close();
});

test('a brochure the assistant sent comes back as a document: matched by its caption, else by the fallback (same lead, 2 min) → dana, never owner_number', () => {
  const doc = (over = {}) => rec({ id: 'DOC-1', fromMe: true, jid: LID, jidAlt: PHONE_JID, media: '[document: BONA-W003.pdf]', text: 'BONA-W003 brochure', ts: NOW + 1000, ...over });
  const docRow = (h, over = {}) => h.inbox.insertOutbox({
    send_id: 'SND-doc', lead_id: LEAD_ID, jid: PHONE_JID, text: 'BONA-W003 brochure', sender_kind: 'dana', status: 'uncertain', media_kind: 'document', ...over,
  });
  // By its caption.
  const a = testChat();
  docRow(a);
  assert.deepEqual(a.ingest(a.lead(LEAD_ID), doc()), { stored: true, inserted: true, senderKind: 'dana' });
  assert.deepEqual([a.inbox.getOutbox('SND-doc').status, a.inbox.getOutbox('SND-doc').key_id], ['accepted', 'DOC-1']);
  assert.ok(a.logs.some((e) => e.evt === 'inbox.outbox.resolved' && e.via === 'text'));
  a.s.close();
  // No caption came back (or another one): the fallback, the oldest such row of the lead.
  for (const text of ['', 'brochure']) {
    const b = testChat();
    docRow(b);
    docRow(b, { send_id: 'SND-doc-2' });
    b.at(NOW + 5000);
    assert.equal(b.ingest(b.lead(LEAD_ID), doc({ text, ts: NOW + 90_000 })).senderKind, 'dana', JSON.stringify(text));
    assert.deepEqual([b.inbox.getOutbox('SND-doc').status, b.inbox.getOutbox('SND-doc-2').status], ['accepted', 'uncertain']);
    assert.ok(b.logs.some((e) => e.evt === 'inbox.outbox.resolved' && e.via === 'document'));
    b.s.close();
  }
  // Not the fallback: 2 min + 1 ms, another lead's row, a text row, an image, a record read again.
  const misses = [
    ['too late', {}, { text: '', ts: NOW + RESOLVE_WINDOW_MS + 1 }],
    ['another lead', { lead_id: OTHER_LEAD_ID }, { text: '' }],
    ['a text row', { media_kind: null, text: 'Here is the link' }, { text: '' }],
    ['an image', {}, { text: '', media: '[image]' }],
  ];
  for (const [label, row, over] of misses) {
    const c = testChat();
    docRow(c, row);
    assert.equal(c.ingest(c.lead(LEAD_ID), doc(over)).senderKind, 'owner_number', label);
    assert.equal(c.inbox.getOutbox('SND-doc').status, 'uncertain', label);
    c.s.close();
  }
  // In the owner's test chat a brochure send is his chat's too, not dropped.
  const t = testChat();
  t.inbox.insertOutbox({ send_id: 'SND-doc', lead_id: T_LEAD, jid: T_OWNER_JID, text: 'BONA-W003 brochure', sender_kind: 'dana', status: 'uncertain', media_kind: 'document' });
  assert.equal(t.ingest(t.lead(), toOwner({ id: 'T-DOC', media: '[document: BONA-W003.pdf]', text: '', ts: NOW + 1000 })).senderKind, 'dana');
  t.s.close();
});

test('a caption finds only a brochure row and a text only a text row: a Dana PDF never settles a staff send with the same words, nor a typed text the brochure', () => {
  const CAPTION = 'Here is the brochure';
  const doc = (over = {}) => rec({ id: 'DOC-1', fromMe: true, jid: LID, jidAlt: PHONE_JID, media: '[document: BONA-W003.pdf]', text: CAPTION, ts: NOW + 2000, ...over });
  const typed = (over = {}) => rec({ id: 'TXT-1', fromMe: true, jid: PHONE_JID, jidAlt: null, text: CAPTION, ts: NOW + 2000, ...over });
  const staffRow = (h) => h.inbox.insertOutbox({
    send_id: 'SND-staff', lead_id: LEAD_ID, jid: PHONE_JID, text: CAPTION, user_id: h.staff.user_id, sender_kind: 'staff', status: 'uncertain',
  });
  const docRow = (h) => h.inbox.insertOutbox({
    send_id: 'SND-doc', lead_id: LEAD_ID, jid: PHONE_JID, text: CAPTION, sender_kind: 'dana', status: 'uncertain', media_kind: 'document',
  });
  const status = (h) => [h.inbox.getOutbox('SND-staff')?.status ?? null, h.inbox.getOutbox('SND-doc')?.status ?? null];
  /** Both rows unsure, the older one first: the text lookup returns the oldest match, so each order is its own case. */
  const both = (first, second) => {
    const h = testChat({ client: { needs_human: 1 } });
    first(h);
    h.at(NOW + 500);
    second(h);
    return h;
  };
  for (const [label, order] of [['the staff send older', [staffRow, docRow]], ['the brochure older', [docRow, staffRow]]]) {
    // The brochure's own copy: Dana's, the staff send stays unsure, and nobody's human clock moves.
    const a = both(...order);
    assert.deepEqual(a.ingest(a.lead(LEAD_ID), doc()), { stored: true, inserted: true, senderKind: 'dana' }, label);
    assert.deepEqual(status(a), ['uncertain', 'accepted'], label);
    assert.equal(a.inbox.getOutbox('SND-doc').key_id, 'DOC-1', label);
    assert.deepEqual([a.lead(LEAD_ID).last_human_out_ts, a.lead(LEAD_ID).needs_human, a.lead(LEAD_ID).handler_user_id], [null, 1, null], label);
    a.s.close();
    // The staff text's own copy: the staff member's, the brochure stays unsure.
    const b = both(...order);
    assert.equal(b.ingest(b.lead(LEAD_ID), typed()).senderKind, 'staff', label);
    assert.deepEqual(status(b), ['accepted', 'uncertain'], label);
    b.s.close();
  }
  // No brochure row: a document with an unsure staff text's words is not that text (the owner's phone, as any untracked send).
  const c = testChat();
  staffRow(c);
  assert.equal(c.ingest(c.lead(LEAD_ID), doc()).senderKind, 'owner_number');
  assert.deepEqual(status(c), ['uncertain', null]);
  c.s.close();
  // No staff row: a typed text with the brochure's caption is not the brochure.
  const d = testChat();
  docRow(d);
  assert.equal(d.ingest(d.lead(LEAD_ID), typed()).senderKind, 'owner_number');
  assert.deepEqual(status(d), [null, 'uncertain']);
  d.s.close();
});

test('a `#dana` text is never a message, in any chat, either way it went, whichever read brings it (poller, join history, refresh)', async () => {
  const h = testChat();
  // With an invisible mark a phone keyboard slipped in, too: parseCommand takes those (owner-test.mjs), so ingest refuses them.
  for (const [id, text] of [['C-1', '#dana test on'], ['C-2', '  #DANA off'], ['C-3', '#dana foo'], ['C-4', '#Dana\tstatus'],
    ['C-5', '\u200F#dana status'], ['C-6', '\u200E#dana off'], ['C-7', '\u200B #dana off'], ['C-8', '\u2067#dana live on\u2069'], ['C-9', '\uFEFF#dana on']]) {
    assert.deepEqual(h.ingest(h.lead(LEAD_ID), rec({ id, text })), { stored: false, reason: 'command' }, text);
    assert.deepEqual(h.ingest(h.lead(LEAD_ID), rec({ id: `${id}-out`, fromMe: true, jid: PHONE_JID, jidAlt: null, text })), { stored: false, reason: 'command' }, `${text} sent`);
    assert.deepEqual(h.ingest(h.lead(), rec({ id: `${id}-t`, jid: T_OWNER_JID, jidAlt: null, text })), { stored: false, reason: 'command' }, `${text} in the test chat`);
  }
  // Not a command: the word inside a sentence, or a longer word.
  assert.equal(h.ingest(h.lead(LEAD_ID), rec({ id: 'N-1', text: 'is #dana the agent?' })).stored, true);
  assert.equal(h.ingest(h.lead(LEAD_ID), rec({ id: 'N-2', text: '#danavilla' })).stored, true);
  assert.equal(h.inbox.countMessages(T_LEAD), 0);
  // Through the join history and a thread refresh (lib/inbox/backfill.mjs hands every record to ingest).
  const records = [
    rec({ id: 'B-1', jid: PHONE_JID, jidAlt: null, text: '#dana test on', ts: NOW - 120_000 }),
    rec({ id: 'B-2', jid: PHONE_JID, jidAlt: null, text: 'A real question', ts: NOW - 60_000 }),
  ];
  const backfill = createBackfill({
    db: h.s, inbox: h.inbox, now: h.now, ingest: (l, r) => h.ingest(l, r),
    find: async ({ where }) => {
      const hits = records.filter((r) => (where.key.remoteJidAlt ? r.jidAlt === where.key.remoteJidAlt : r.jid === where.key.remoteJid));
      return { records: hits, total: hits.length, pages: 1 };
    },
  });
  await backfill.history(h.lead(LEAD_ID), { sinceTs: NOW - T_DAY });
  assert.deepEqual(h.inbox.messagesFor(LEAD_ID).map((m) => m.key_id).filter((k) => k.startsWith('B-')), ['B-2']);
  records.push(rec({ id: 'B-3', jid: PHONE_JID, jidAlt: null, text: '#dana live on', ts: NOW - 30_000 }));
  await backfill.refresh(h.lead(LEAD_ID), { minIntervalMs: 0 });
  assert.equal(h.inbox.messageByKey('B-3'), null);
  assertCleanT(h.logs);
  h.s.close();
});

test('the rollback guard: a lead that joined by the own rule or the test is refused (rule_off) while ownNumberOk is false, by ingest and by a refresh', async () => {
  for (const via of ['own_number', 'owner_test']) {
    const h = testChat({ sw: fakeSwitch({ ok: false }), client: { inbox_via: via } });
    assert.deepEqual(h.ingest(h.lead(LEAD_ID), rec({ id: 'RB-1' })), { stored: false, reason: 'rule_off' }, via);
    assert.deepEqual(h.ingest(h.lead(LEAD_ID), rec({ id: 'RB-2', fromMe: true, jid: PHONE_JID, jidAlt: null, text: TYPED })), { stored: false, reason: 'rule_off' }, `${via} sent`);
    const backfill = createBackfill({
      db: h.s, inbox: h.inbox, now: h.now, ingest: (l, r) => h.ingest(l, r),
      find: async ({ where }) => (where.key.remoteJid === PHONE_JID
        ? { records: [rec({ id: 'RB-3', jid: PHONE_JID, jidAlt: null, ts: NOW - 60_000 })], total: 1, pages: 1 }
        : { records: [], total: 0, pages: 0 }),
    });
    await backfill.refresh(h.lead(LEAD_ID), { minIntervalMs: 0 });
    assert.equal(h.inbox.countMessages(LEAD_ID), 0, `${via}: nothing stored by the refresh either`);
    // Once Bona's number checks out again, the chat is served as before.
    h.sw.ok = true;
    assert.equal(h.ingest(h.lead(LEAD_ID), rec({ id: 'RB-4' })).stored, true, via);
    h.s.close();
  }
  // A lead joined by proof (inbox_via NULL) is not this guard's.
  const proof = testChat({ sw: fakeSwitch({ ok: false }) });
  assert.equal(proof.ingest(proof.lead(LEAD_ID), rec({ id: 'RB-5' })).stored, true);
  // The owner's test lead too, and before the exclusion check (with ok false the test is not active).
  assert.deepEqual(proof.ingest(proof.lead(), rec({ id: 'RB-6', jid: T_OWNER_JID, jidAlt: null })), { stored: false, reason: 'rule_off' });
  proof.s.close();
  // No test switch handed in: fail closed.
  const bare = testChat({ withSwitch: false, client: { inbox_via: 'own_number' } });
  assert.deepEqual(bare.ingest(bare.lead(LEAD_ID), rec({ id: 'RB-7' })), { stored: false, reason: 'rule_off' });
  bare.s.close();
});

test("with the test switch off, the owner's test lead is the owner's number again: excluded, nothing stored", () => {
  const h = testChat({ sw: fakeSwitch({ on: false }) });
  assert.deepEqual(h.ingest(h.lead(), rec({ id: 'X-1', jid: T_OWNER_JID, jidAlt: null })), { stored: false, reason: 'excluded' });
  h.s.close();
});

/* ---------- the acceptance order at its two callers (PLAN T07, "Added 27 Nov"; PR-B2 #94) ---------- */

/** The real sender (lib/wa-send.mjs) over a test chat's store; Evolution is a fake on a test host. */
const SEND_ENV = {
  EVOLUTION_API_URL: 'http://evo.example.com', EVOLUTION_API_KEY: 'test-key', BONA_WA_INSTANCE: 'bona2',
  BONA_OWNER_JID: T_OWNER_JID, BONA_WA_INSTANCE_JID: T_INSTANCE_JID,
};

/**
 * Evolution answers 201 with `key` at `answerAt`; `during` runs while the call is out (the
 * poller's tick reading WhatsApp's own copy before the HTTP answer is back).
 */
function senderFor(h, { key, answerAt, during = null }) {
  h.team.setSetting('inbox_replies', '1');
  const fetchImpl = async () => {
    if (during) await during();
    h.at(answerAt);
    return { ok: true, status: 201, text: async () => JSON.stringify({ key: { id: key } }) };
  };
  return createSender({ env: SEND_ENV, team: h.team, inbox: h.inbox, db: h.s, fetchImpl, now: h.now, log: (o) => h.logs.push(o) });
}

test("the poller's match and wa-send's 2xx, in either order at the real callers: the first acceptance time stays, the copy is the row's own sender, and no owner's-number mute", async () => {
  const WROTE = NOW;
  const SEEN = NOW + 3_000;
  const ANSWERED = NOW + 12_000;
  const READ_AFTER = NOW + 20_000;
  const SENDS = {
    // Dana writes her row first (with the `covers_ts` it answers), then hands its id to the sender.
    dana: {
      leadId: LEAD_ID, key: 'WA-DANA-1', text: 'Hello from the assistant',
      async send(h, sender) {
        h.inbox.insertOutbox({ send_id: 'SND-dana-x', lead_id: LEAD_ID, jid: PHONE_JID, text: this.text, sender_kind: 'dana', covers_ts: NOW - 60_000 });
        const out = await sender.sendTo({ jid: PHONE_JID, text: this.text, kind: 'dana', leadId: LEAD_ID, sendId: 'SND-dana-x' });
        assert.equal(out.ok, true);
        return 'SND-dana-x';
      },
      echo() { return rec({ id: this.key, fromMe: true, jid: LID, jidAlt: PHONE_JID, text: this.text, ts: NOW + 1_000 }); },
    },
    // A team member's reply from the inbox thread (`reply` writes the row, sends, and stores the message itself).
    staff: {
      leadId: LEAD_ID, key: 'WA-STAFF-1', text: 'From the dashboard',
      async send(h, sender) {
        const out = await sender.reply({ sendId: 'sid_staff_0123456789', leadId: LEAD_ID, userId: h.staff.user_id, text: this.text, seenRev: h.inbox.revision(LEAD_ID) });
        assert.equal(out.ok, true, JSON.stringify(out));
        return 'sid_staff_0123456789';
      },
      echo() { return rec({ id: this.key, fromMe: true, jid: LID, jidAlt: PHONE_JID, text: this.text, ts: NOW + 1_000 }); },
    },
    // A note to the owner: the sender writes its row (no lead, no text). Its copy sits in his test chat.
    note: {
      leadId: T_LEAD, key: 'WA-NOTE-1', text: '*Bona — note*\nA new enquiry',
      async send(h, sender) {
        const out = await sender.sendTo({ jid: T_OWNER_JID, text: this.text, kind: 'note' });
        assert.equal(out.ok, true);
        return out.sendId;
      },
      echo() { return toOwner({ id: this.key, text: this.text, ts: NOW + 1_000 }); },
    },
  };
  const expectedKind = { dana: 'dana', staff: 'staff', note: null };

  for (const [kind, s] of Object.entries(SENDS)) {
    for (const order of ['poller first', '2xx first']) {
      const label = `${kind}, ${order}`;
      const h = testChat({ client: { needs_human: 1 } });
      h.at(WROTE);
      const results = [];
      const sender = senderFor(h, {
        key: s.key, answerAt: ANSWERED,
        during: order === 'poller first' ? () => { h.at(SEEN); results.push(h.ingest(h.lead(s.leadId), s.echo())); } : null,
      });
      const sendId = await s.send(h, sender);
      if (order === '2xx first') {
        h.at(READ_AFTER);
        results.push(h.ingest(h.lead(s.leadId), s.echo()));
      }
      // A thread refresh reads the copy once more, later still.
      h.at(NOW + 60_000);
      results.push(h.ingest(h.lead(s.leadId), s.echo()));

      const row = h.inbox.getOutbox(sendId);
      // A note's copy cannot be matched before its key is known (no text in its row): its first acceptance is the 2xx.
      const firstAccept = order === 'poller first' && kind !== 'note' ? SEEN : ANSWERED;
      assert.deepEqual([row.status, row.key_id, row.updated], ['accepted', s.key, firstAccept], label);
      const kinds = h.inbox.messagesFor(s.leadId).map((m) => m.sender_kind);
      if (expectedKind[kind]) {
        assert.deepEqual(kinds, [expectedKind[kind]], label);
        assert.equal(h.inbox.messageByKey(s.key)?.sender_kind, expectedKind[kind], label);
      } else {
        assert.deepEqual(kinds, [], `${label}: a note is never a bubble`);
        assert.ok(results.every((r) => r.stored === false && ['note', 'test_chat_untracked'].includes(r.reason)), `${label}: ${JSON.stringify(results)}`);
        assert.equal(results.at(-1).reason, 'note', label);
      }
      assert.equal(kinds.includes('owner_number'), false, `${label}: never the owner's number`);
      const l = h.lead(s.leadId);
      if (kind === 'staff') {
        // A team member answering is a person answering, as designed: their handler, never the owner's phone.
        assert.deepEqual([l.needs_human, l.handler_user_id], [0, h.staff.user_id], label);
      } else {
        // The assistant's own message and a note mute nothing: no human clock, the hand-over flag as it was.
        assert.equal(l.last_human_out_ts, null, label);
        assert.equal(h.lead(LEAD_ID).needs_human, 1, label);
      }
      assert.deepEqual(h.alerts, [], label);
      assertCleanT(h.logs);
      h.s.close();
    }
  }
});
