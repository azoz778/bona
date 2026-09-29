/**
 * The inbox store: every SQL statement behind the Bona inbox — stored messages, the send
 * outbox, read marks, unloadable-message gaps and the inbox columns on a lead. The clock
 * is injected, so every timestamp is exact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createTeam } from '../lib/team.mjs';
import {
  createInboxStore, RETENTION_MS, MAX_STORED_TEXT, SENDER_KINDS, OUTBOX_KINDS, OUTBOX_STATUSES, CANDIDATE_KEEP_MS, DISMISSED_KEEP_MS,
} from '../lib/inbox/store.mjs';
import { JOIN_HISTORY_MS, OWNER_HISTORY_MS } from '../lib/inbox/backfill.mjs';

const NOW = 1_790_500_000_000;
const DAY = 86_400_000;
const JID = '966500000001@s.whatsapp.net';
const OWNER_JID = '966593296933@s.whatsapp.net';

function harness() {
  const s = openDb(':memory:');
  let clock = NOW;
  const inbox = createInboxStore(s, { now: () => clock });
  const team = createTeam(s, { now: () => clock });
  return { s, inbox, team, tick: (ms) => { clock += ms; }, at: (t) => { clock = t; } };
}

/** A lead with only what a test needs; `over` wins. */
const lead = (s, id, over = {}) => s.insertLead({ lead_id: id, created: NOW - DAY, updated: NOW - DAY, channel: 'whatsapp', stage: 'new', ...over });
/** A chat in the Bona inbox. */
const chat = (s, id, over = {}) => lead(s, id, { wa_jid: JID, inbox_state: 'in', inbox_since: NOW - DAY, ...over });
const msg = (over = {}) => ({ key_id: 'K-1', lead_id: 'L-1', jid: JID, direction: 'in', sender_kind: 'client', text: 'hello', ts: NOW, ...over });
const out = (over = {}) => ({ send_id: 'SND-1', lead_id: 'L-1', jid: JID, text: 'on my way', user_id: 'USR-1', sender_kind: 'staff', ...over });
const count = (s, table) => s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const row = (s, keyId) => ({ ...s.db.prepare('SELECT * FROM wa_messages WHERE key_id = ?').get(keyId) });

test('the vocabularies are the ones the schema allows, and retention is five years', () => {
  assert.deepEqual(SENDER_KINDS, ['client', 'staff', 'dana', 'owner_number']);
  assert.deepEqual(OUTBOX_KINDS, ['staff', 'dana', 'code', 'note']);
  assert.deepEqual(OUTBOX_STATUSES, ['pending', 'accepted', 'failed', 'uncertain']);
  assert.equal(MAX_STORED_TEXT, 8000);
  assert.equal(RETENTION_MS, 157_788_000_000);
});

test('upsertMessage stores a message once; seen again it is not a second row', () => {
  const { s, inbox } = harness();
  chat(s, 'L-1');
  assert.deepEqual(inbox.upsertMessage(msg()), { inserted: true });
  assert.deepEqual(row(s, 'K-1'), {
    key_id: 'K-1', lead_id: 'L-1', jid: JID, direction: 'in', sender_kind: 'client', sender_user_id: null,
    text: 'hello', media_type: null, ts: NOW, status: null,
  });
  assert.equal(s.getLead('L-1').last_msg_ts, NOW);
  assert.deepEqual(inbox.upsertMessage(msg()), { inserted: false });
  assert.equal(count(s, 'wa_messages'), 1);
  s.close();
});

test('a message stored as the owner\'s number is upgraded to the staff member or Dana who sent it, never the other way', () => {
  const { s, inbox } = harness();
  chat(s, 'L-1');
  inbox.upsertMessage(msg({ key_id: 'K-out', direction: 'out', sender_kind: 'owner_number', text: 'on my way' }));
  inbox.upsertMessage(msg({ key_id: 'K-out', direction: 'out', sender_kind: 'staff', sender_user_id: 'USR-1', text: 'on my way' }));
  assert.equal(row(s, 'K-out').sender_kind, 'staff');
  assert.equal(row(s, 'K-out').sender_user_id, 'USR-1');
  // A later poll that cannot find the outbox row must not demote a known sender.
  inbox.upsertMessage(msg({ key_id: 'K-out', direction: 'out', sender_kind: 'owner_number', text: 'on my way' }));
  assert.equal(row(s, 'K-out').sender_kind, 'staff');
  assert.equal(row(s, 'K-out').sender_user_id, 'USR-1');
  inbox.upsertMessage(msg({ key_id: 'K-out', direction: 'out', sender_kind: 'dana', text: 'on my way' }));
  assert.equal(row(s, 'K-out').sender_kind, 'staff', 'only owner_number is ever upgraded');

  inbox.upsertMessage(msg({ key_id: 'K-dana', direction: 'out', sender_kind: 'owner_number', text: 'Hello from Bona' }));
  inbox.upsertMessage(msg({ key_id: 'K-dana', direction: 'out', sender_kind: 'dana', text: 'Hello from Bona' }));
  assert.equal(row(s, 'K-dana').sender_kind, 'dana');
  assert.equal(row(s, 'K-dana').sender_user_id, null);

  inbox.upsertMessage(msg({ key_id: 'K-in' }));
  inbox.upsertMessage(msg({ key_id: 'K-in', direction: 'out', sender_kind: 'staff', sender_user_id: 'USR-1', text: 'changed', jid: 'x@lid', ts: NOW + 5, media_type: '[image]' }));
  assert.deepEqual(row(s, 'K-in'), {
    key_id: 'K-in', lead_id: 'L-1', jid: JID, direction: 'in', sender_kind: 'client', sender_user_id: null,
    text: 'hello', media_type: null, ts: NOW, status: null,
  }, "a client's message is never anyone else's, and nothing else about it changes");
  s.close();
});

test('status is filled in or moved on by a write that carries one, and kept by a write that does not', () => {
  const { s, inbox } = harness();
  chat(s, 'L-1');
  inbox.upsertMessage(msg({ direction: 'out', sender_kind: 'owner_number' }));
  assert.equal(row(s, 'K-1').status, null);
  inbox.upsertMessage(msg({ direction: 'out', sender_kind: 'staff', sender_user_id: 'USR-1', status: 'sent' }));
  assert.equal(row(s, 'K-1').status, 'sent');
  inbox.upsertMessage(msg({ direction: 'out', sender_kind: 'owner_number' }));
  assert.equal(row(s, 'K-1').status, 'sent');
  inbox.upsertMessage(msg({ direction: 'out', sender_kind: 'owner_number', status: 'read' }));
  assert.equal(row(s, 'K-1').status, 'read');
  s.close();
});

test('the chat\'s last-message time only moves forward, and a message seen again keeps its first time', () => {
  const { s, inbox } = harness();
  chat(s, 'L-1');
  inbox.upsertMessage(msg({ key_id: 'K-1', ts: NOW }));
  inbox.upsertMessage(msg({ key_id: 'K-2', ts: NOW - 5000 }));
  assert.equal(s.getLead('L-1').last_msg_ts, NOW, 'an older message arriving late does not move it back');
  inbox.upsertMessage(msg({ key_id: 'K-3', ts: NOW + 5000 }));
  assert.equal(s.getLead('L-1').last_msg_ts, NOW + 5000);
  inbox.upsertMessage(msg({ key_id: 'K-1', ts: NOW + 99_999 }));
  assert.equal(s.getLead('L-1').last_msg_ts, NOW + 5000);
  assert.equal(row(s, 'K-1').ts, NOW);
  s.close();
});

test('stored text is capped at MAX_STORED_TEXT code points, never splitting a pair; a media message may have none', () => {
  const { s, inbox } = harness();
  chat(s, 'L-1');
  inbox.upsertMessage(msg({ key_id: 'K-long', text: 'a'.repeat(9000) }));
  assert.equal(row(s, 'K-long').text, 'a'.repeat(MAX_STORED_TEXT));
  inbox.upsertMessage(msg({ key_id: 'K-emoji', text: `${'a'.repeat(7999)}\u{1F600}b` }));
  const kept = row(s, 'K-emoji').text;
  assert.equal([...kept].length, MAX_STORED_TEXT);
  assert.ok(kept.endsWith('\u{1F600}'), 'the emoji is kept whole');
  inbox.upsertMessage(msg({ key_id: 'K-media', text: null, media_type: '[voice note]' }));
  assert.equal(row(s, 'K-media').text, null);
  assert.equal(row(s, 'K-media').media_type, '[voice note]');
  s.close();
});

test('upsertMessage refuses a bad direction or sender, and a missing key, lead or time', () => {
  const { s, inbox } = harness();
  chat(s, 'L-1');
  for (const bad of [
    { direction: 'sideways' }, { sender_kind: 'lisa' }, { sender_kind: undefined },
    // Only the client writes `in` (the schema's CHECK says so too): a mismatch is a bad sender.
    { direction: 'out' }, { sender_kind: 'staff' },
    { key_id: undefined }, { key_id: '' }, { lead_id: null },
    { ts: undefined }, { ts: null }, { ts: 'soon' },
  ]) {
    assert.throws(() => inbox.upsertMessage(msg(bad)), RangeError, JSON.stringify(bad));
  }
  assert.equal(count(s, 'wa_messages'), 0);
  assert.equal(s.getLead('L-1').last_msg_ts, null);
  s.close();
});

test('messagesFor returns the newest N of one chat, oldest first; a tie keeps the order they were stored in', () => {
  const { s, inbox } = harness();
  chat(s, 'L-1');
  chat(s, 'L-2');
  for (const [key, ts] of [['K-3', NOW + 3000], ['K-1', NOW + 1000], ['K-5', NOW + 5000], ['K-2', NOW + 2000], ['K-4a', NOW + 4000], ['K-4b', NOW + 4000]]) {
    inbox.upsertMessage(msg({ key_id: key, ts }));
  }
  inbox.upsertMessage(msg({ key_id: 'K-other', lead_id: 'L-2', ts: NOW + 9000 }));
  assert.deepEqual(inbox.messagesFor('L-1', { limit: 3 }).map((m) => m.key_id), ['K-4a', 'K-4b', 'K-5']);
  assert.deepEqual(inbox.messagesFor('L-1').map((m) => m.key_id), ['K-1', 'K-2', 'K-3', 'K-4a', 'K-4b', 'K-5']);
  assert.deepEqual(inbox.messagesFor('L-nope'), []);
  s.close();
});

test('newestTs and hasMessages look at one chat only', () => {
  const { s, inbox } = harness();
  chat(s, 'L-1');
  chat(s, 'L-2');
  assert.equal(inbox.newestTs('L-1'), null);
  assert.equal(inbox.hasMessages('L-1'), false);
  inbox.upsertMessage(msg({ key_id: 'K-1', ts: NOW }));
  inbox.upsertMessage(msg({ key_id: 'K-2', ts: NOW + 700, direction: 'out', sender_kind: 'owner_number' }));
  assert.equal(inbox.newestTs('L-1'), NOW + 700, 'either direction counts');
  assert.equal(inbox.hasMessages('L-1'), true);
  assert.equal(inbox.newestTs('L-2'), null);
  assert.equal(inbox.hasMessages('L-2'), false);
  s.close();
});

test('messageByKey returns the stored message with that WhatsApp id, or null', () => {
  const { s, inbox } = harness();
  chat(s, 'L-1');
  inbox.upsertMessage(msg({ key_id: 'K-1', direction: 'out', sender_kind: 'owner_number' }));
  assert.deepEqual([inbox.messageByKey('K-1').lead_id, inbox.messageByKey('K-1').sender_kind], ['L-1', 'owner_number']);
  assert.equal(inbox.messageByKey('K-nope'), null);
  assert.equal(inbox.messageByKey(null), null);
  assert.equal(inbox.messageByKey(''), null);
  s.close();
});

test('insertOutbox writes a pending row once; a second insert of the same send_id returns the row already there', () => {
  const { s, inbox, tick } = harness();
  const first = inbox.insertOutbox(out());
  assert.equal(first.inserted, true);
  assert.deepEqual(first.row, {
    send_id: 'SND-1', lead_id: 'L-1', jid: JID, text: 'on my way', user_id: 'USR-1', sender_kind: 'staff',
    status: 'pending', key_id: null, created: NOW, updated: NOW, error: null,
  });
  tick(1000);
  const again = inbox.insertOutbox(out({ text: 'something else', user_id: 'USR-2' }));
  assert.equal(again.inserted, false);
  assert.deepEqual(again.row, first.row);
  assert.equal(count(s, 'wa_outbox'), 1);
  s.close();
});

test('a login-code row never stores its text, whatever the caller passes', () => {
  const { s, inbox } = harness();
  const { row: code } = inbox.insertOutbox({ send_id: 'SND-code', jid: '966500000002@s.whatsapp.net', text: 'Bona dashboard code: 123456 (valid 10 min)', sender_kind: 'code' });
  assert.equal(code.text, null);
  assert.equal(code.lead_id, null);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM wa_outbox WHERE text LIKE '%123456%'").get().n, 0);
  s.close();
});

test('insertOutbox refuses an unknown kind or status and a missing send_id or jid', () => {
  const { s, inbox } = harness();
  for (const bad of [{ sender_kind: 'sms' }, { status: 'sent' }, { send_id: undefined }, { send_id: '' }, { jid: null }, { jid: '' }]) {
    assert.throws(() => inbox.insertOutbox(out(bad)), RangeError, JSON.stringify(bad));
  }
  assert.equal(count(s, 'wa_outbox'), 0);
  s.close();
});

test('getOutbox, outboxByKey and updateOutbox: a key is recorded, an error is capped, a missing field is kept', () => {
  const { s, inbox, tick } = harness();
  inbox.insertOutbox(out());
  inbox.insertOutbox(out({ send_id: 'SND-2' }));
  assert.equal(inbox.getOutbox('SND-nope'), null);
  assert.equal(inbox.outboxByKey(null), null);
  assert.equal(inbox.outboxByKey(''), null, 'rows still waiting for a key are not "the row for" an empty key');

  tick(2000);
  assert.equal(inbox.updateOutbox('SND-1', { status: 'accepted', key_id: 'KEY-9' }), true);
  const accepted = inbox.getOutbox('SND-1');
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.key_id, 'KEY-9');
  assert.equal(accepted.updated, NOW + 2000);
  assert.equal(accepted.created, NOW);
  assert.equal(inbox.outboxByKey('KEY-9').send_id, 'SND-1');
  assert.equal(inbox.outboxByKey('KEY-nope'), null);

  assert.equal(inbox.updateOutbox('SND-2', { status: 'failed', error: 'x'.repeat(500) }), true);
  assert.equal(inbox.getOutbox('SND-2').error.length, 200);
  inbox.updateOutbox('SND-2', { status: 'uncertain' });
  assert.equal(inbox.getOutbox('SND-2').error, 'x'.repeat(200), 'left out means kept');
  assert.equal(inbox.getOutbox('SND-2').key_id, null);
  inbox.updateOutbox('SND-2', { status: 'uncertain', error: null });
  assert.equal(inbox.getOutbox('SND-2').error, null, 'null clears');

  assert.equal(inbox.updateOutbox('SND-nope', { status: 'failed' }), false);
  assert.throws(() => inbox.updateOutbox('SND-1', { status: 'sent' }), RangeError);
  assert.throws(() => inbox.updateOutbox('SND-1', {}), RangeError);
  s.close();
});

test('resolveUncertain finds the oldest unresolved send of the same lead with the same text; accepted and keyed rows never match', () => {
  const { s, inbox, at } = harness();
  const text = 'see you at 5';
  at(NOW - 1000);
  inbox.insertOutbox(out({ send_id: 'SND-accepted', text, status: 'accepted' }));
  inbox.insertOutbox(out({ send_id: 'SND-keyed', text, status: 'uncertain' }));
  inbox.updateOutbox('SND-keyed', { status: 'uncertain', key_id: 'KEY-7' });
  inbox.insertOutbox(out({ send_id: 'SND-failed', text, status: 'failed' }));
  at(NOW);
  inbox.insertOutbox(out({ send_id: 'SND-old', text, status: 'uncertain' }));
  inbox.insertOutbox(out({ send_id: 'SND-other-text', text: 'see you at 6', status: 'uncertain' }));
  inbox.insertOutbox(out({ send_id: 'SND-other-lead', lead_id: 'L-2', text, status: 'uncertain' }));
  at(NOW + 10_000);
  inbox.insertOutbox(out({ send_id: 'SND-new', text }));

  assert.equal(inbox.resolveUncertain({ leadId: 'L-1', text, ts: NOW + 5000 }).send_id, 'SND-old', 'the oldest wins');
  assert.equal(inbox.resolveUncertain({ leadId: 'L-2', text, ts: NOW + 5000 }).send_id, 'SND-other-lead');
  assert.equal(inbox.resolveUncertain({ leadId: 'L-1', text: 'see you at 6', ts: NOW }).send_id, 'SND-other-text');
  assert.equal(inbox.resolveUncertain({ leadId: 'L-1', text: 'see you at 5 ', ts: NOW }), null, 'the text must be identical');
  assert.equal(inbox.resolveUncertain({ leadId: 'L-1', text: 'See you at 5', ts: NOW }), null);
  assert.equal(inbox.resolveUncertain({ leadId: 'L-1', text: null, ts: NOW }), null);
  assert.equal(inbox.resolveUncertain({ leadId: 'L-3', text, ts: NOW }), null);
  assert.equal(inbox.getOutbox('SND-old').status, 'uncertain', 'read-only: nothing is resolved here');
  assert.equal(inbox.getOutbox('SND-old').key_id, null);
  s.close();
});

test('resolveUncertain matches within two minutes of the send either way, edges included', () => {
  const { s, inbox } = harness();
  inbox.insertOutbox(out({ send_id: 'SND-edge', lead_id: 'L-3', text: 'ok', status: 'pending' }));
  const find = (ts, extra = {}) => inbox.resolveUncertain({ leadId: 'L-3', text: 'ok', ts, ...extra })?.send_id ?? null;
  assert.equal(find(NOW + 120_000), 'SND-edge');
  assert.equal(find(NOW + 120_001), null);
  assert.equal(find(NOW - 120_000), 'SND-edge');
  assert.equal(find(NOW - 120_001), null);
  assert.equal(find(NOW + 1000, { windowMs: 1000 }), 'SND-edge');
  assert.equal(find(NOW + 1001, { windowMs: 1000 }), null);
  s.close();
});

test('openOutboxFor lists the staff and Dana sends of one chat that did not surely go: newest 20, oldest first', () => {
  const { s, inbox, tick } = harness();
  inbox.insertOutbox(out({ send_id: 'SND-p' }));
  tick(1000);
  inbox.insertOutbox(out({ send_id: 'SND-u', sender_kind: 'dana', user_id: null, status: 'uncertain' }));
  tick(1000);
  inbox.insertOutbox(out({ send_id: 'SND-f', status: 'failed' }));
  tick(1000);
  inbox.insertOutbox(out({ send_id: 'SND-a', status: 'accepted' }));
  inbox.insertOutbox(out({ send_id: 'SND-code', sender_kind: 'code', status: 'failed' }));
  inbox.insertOutbox(out({ send_id: 'SND-note', sender_kind: 'note', status: 'failed' }));
  inbox.insertOutbox(out({ send_id: 'SND-x', lead_id: 'L-2', status: 'failed' }));
  assert.deepEqual(inbox.openOutboxFor('L-1').map((r) => r.send_id), ['SND-p', 'SND-u', 'SND-f']);
  assert.deepEqual(inbox.openOutboxFor('L-1', { sinceTs: NOW + 1000 }).map((r) => r.send_id), ['SND-u', 'SND-f']);

  for (let i = 1; i <= 20; i += 1) {
    tick(1000);
    inbox.insertOutbox(out({ send_id: `SND-f${String(i).padStart(2, '0')}`, status: 'failed' }));
  }
  const open = inbox.openOutboxFor('L-1').map((r) => r.send_id);
  assert.equal(open.length, 20);
  assert.equal(open[0], 'SND-f01');
  assert.equal(open[19], 'SND-f20');
  s.close();
});

test('countSentSince counts what may have gone in the window, and can leave the owner\'s own chat out', () => {
  const { s, inbox, at } = harness();
  const since = NOW - DAY;
  at(since - 1);
  inbox.insertOutbox(out({ send_id: 'SND-before', status: 'accepted' }));
  at(since);
  inbox.insertOutbox(out({ send_id: 'SND-edge', status: 'accepted' }));
  at(NOW);
  inbox.insertOutbox(out({ send_id: 'SND-p' }));
  inbox.insertOutbox(out({ send_id: 'SND-a', jid: '966500000002@s.whatsapp.net', status: 'accepted' }));
  inbox.insertOutbox(out({ send_id: 'SND-u', jid: '966500000003@s.whatsapp.net', status: 'uncertain' }));
  inbox.insertOutbox(out({ send_id: 'SND-f', jid: '966500000004@s.whatsapp.net', status: 'failed' }));
  inbox.insertOutbox({ send_id: 'SND-own', jid: OWNER_JID, sender_kind: 'code', status: 'accepted' });
  assert.equal(inbox.countSentSince(since), 5, 'the edge row counts; the failed one and the older one do not');
  assert.equal(inbox.countSentSince(since, { excludeJid: OWNER_JID }), 4);
  assert.equal(inbox.countSentSince(since + 1), 4);
  assert.equal(inbox.countSentSince(since, { excludeJid: null }), 5);
  s.close();
});

test('markStalePending turns pending rows older than the cutoff into uncertain (interrupted), once', () => {
  const { s, inbox, at } = harness();
  at(NOW - 200_000);
  inbox.insertOutbox(out({ send_id: 'SND-stale' }));
  inbox.insertOutbox(out({ send_id: 'SND-accepted', status: 'accepted' }));
  at(NOW - 300_000);
  inbox.insertOutbox(out({ send_id: 'SND-uncertain', status: 'uncertain' }));
  at(NOW - 120_000);
  inbox.insertOutbox(out({ send_id: 'SND-edge' }));
  at(NOW);
  inbox.insertOutbox(out({ send_id: 'SND-fresh' }));
  assert.equal(inbox.markStalePending(NOW - 120_000), 1);
  const stale = inbox.getOutbox('SND-stale');
  assert.equal(stale.status, 'uncertain');
  assert.equal(stale.error, 'interrupted');
  assert.equal(stale.updated, NOW);
  assert.equal(inbox.getOutbox('SND-edge').status, 'pending', 'exactly at the cutoff is not older than it');
  assert.equal(inbox.getOutbox('SND-fresh').status, 'pending');
  assert.equal(inbox.getOutbox('SND-accepted').status, 'accepted');
  assert.equal(inbox.getOutbox('SND-uncertain').error, null);
  assert.equal(inbox.markStalePending(NOW - 120_000), 0);
  s.close();
});

test('pruneCodeRows deletes login-code rows and purge stubs older than the cutoff, never a chat\'s sends', () => {
  const { s, inbox, at } = harness();
  at(NOW - 3 * DAY);
  inbox.insertOutbox({ send_id: 'SND-code-old', jid: JID, sender_kind: 'code', status: 'accepted' });
  inbox.insertOutbox(out({ send_id: 'SND-staff-old', status: 'accepted' }));
  // What purgeLead leaves of a send: no text, no chat.
  inbox.insertOutbox(out({ send_id: 'SND-stub-old', lead_id: null, text: null, status: 'accepted' }));
  at(NOW - DAY);
  inbox.insertOutbox({ send_id: 'SND-code-new', jid: JID, sender_kind: 'code', status: 'accepted' });
  inbox.insertOutbox(out({ send_id: 'SND-stub-new', lead_id: null, text: null, status: 'accepted' }));
  assert.equal(inbox.pruneCodeRows(NOW - 2 * DAY), 2);
  assert.equal(inbox.getOutbox('SND-code-old'), null);
  assert.equal(inbox.getOutbox('SND-stub-old'), null);
  assert.ok(inbox.getOutbox('SND-code-new'));
  assert.ok(inbox.getOutbox('SND-stub-new'));
  assert.ok(inbox.getOutbox('SND-staff-old'));
  s.close();
});

test('markRead never moves backwards, is per person, and shrugs off a chat with nothing to mark', () => {
  const { s, inbox } = harness();
  const mark = (user, leadId) => s.db.prepare('SELECT last_read_ts FROM inbox_reads WHERE user_id = ? AND lead_id = ?').get(user, leadId)?.last_read_ts ?? null;
  assert.equal(inbox.markRead('USR-1', 'L-1', NOW), true);
  assert.equal(mark('USR-1', 'L-1'), NOW);
  inbox.markRead('USR-1', 'L-1', NOW - 50);
  assert.equal(mark('USR-1', 'L-1'), NOW, 'an old page submitted late does not un-read anything');
  inbox.markRead('USR-1', 'L-1', NOW + 200);
  assert.equal(mark('USR-1', 'L-1'), NOW + 200);
  inbox.markRead('USR-2', 'L-1', NOW - 999);
  assert.equal(mark('USR-2', 'L-1'), NOW - 999);
  assert.equal(mark('USR-1', 'L-1'), NOW + 200);
  assert.equal(inbox.markRead('USR-1', 'L-1', null), false);
  assert.equal(inbox.markRead(null, 'L-1', NOW), false);
  assert.equal(inbox.markRead('USR-1', '', NOW), false);
  assert.equal(count(s, 'inbox_reads'), 2);
  s.close();
});

/**
 * Chats for the list tests. For a reader with no read marks and an account from before
 * every message: B has 2 unread, G 1; A was read up to its last inbound message; C has no
 * messages yet. D (no WhatsApp id), E (unsure) and F (out) are not inbox chats.
 */
function listScene() {
  const h = harness();
  const { s, inbox, team } = h;
  const owner = team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const sara = team.addUser({ name: 'Sara', phone: '0500000011' });
  const gone = team.addUser({ name: 'Gone', phone: '0500000012' });
  team.deactivateUser(gone.user_id);
  chat(s, 'A', { wa_jid: '966500000021@s.whatsapp.net', handler_user_id: sara.user_id, click_ids: { fbclid: 'IwAR1' } });
  chat(s, 'B', { wa_jid: null, wa_lid: '272516946294519@lid' });
  chat(s, 'C', { wa_jid: '966500000023@s.whatsapp.net', inbox_since: NOW - 1000 });
  chat(s, 'D', { wa_jid: null, phone_e164: '966500000024', channel: 'form' });
  chat(s, 'E', { wa_jid: '966500000025@s.whatsapp.net', inbox_state: 'unsure', inbox_since: null });
  chat(s, 'F', { wa_jid: '966500000026@s.whatsapp.net', inbox_state: 'out', inbox_since: null });
  chat(s, 'G', { wa_jid: '966500000027@s.whatsapp.net', handler_user_id: gone.user_id });
  inbox.upsertMessage(msg({ key_id: 'A-1', lead_id: 'A', text: 'is the villa free?', ts: NOW - 5000 }));
  inbox.upsertMessage(msg({ key_id: 'A-2', lead_id: 'A', direction: 'out', sender_kind: 'staff', sender_user_id: sara.user_id, text: 'yes, come on Sunday', ts: NOW - 4000 }));
  inbox.upsertMessage(msg({ key_id: 'B-1', lead_id: 'B', text: 'hello', ts: NOW - 9000 }));
  inbox.upsertMessage(msg({ key_id: 'B-2', lead_id: 'B', text: null, media_type: '[image]', ts: NOW - 8000 }));
  inbox.upsertMessage(msg({ key_id: 'E-1', lead_id: 'E', ts: NOW - 100 }));
  inbox.upsertMessage(msg({ key_id: 'F-1', lead_id: 'F', ts: NOW - 100 }));
  inbox.upsertMessage(msg({ key_id: 'G-1', lead_id: 'G', ts: NOW - 20_000 }));
  inbox.markRead(owner.user_id, 'A', NOW - 5000);
  return { ...h, owner, sara };
}

test('listInbox shows inbox chats only: unread first, then the most recent, with the last message and the handler', () => {
  const { s, inbox, owner } = listScene();
  const rows = inbox.listInbox({ userId: owner.user_id });
  assert.deepEqual(rows.map((r) => r.lead_id), ['B', 'G', 'C', 'A']);
  assert.deepEqual(rows.map((r) => r.unread), [2, 1, 0, 0]);

  const a = rows.find((r) => r.lead_id === 'A');
  assert.equal(a.last_text, 'yes, come on Sunday');
  assert.equal(a.last_media, null);
  assert.equal(a.last_direction, 'out');
  assert.equal(a.last_sender_kind, 'staff');
  assert.equal(a.handler_name, 'Sara');
  assert.equal(a.stage, 'new');
  assert.equal(a.inbox_state, 'in');
  assert.equal(a.last_msg_ts, NOW - 4000);
  assert.deepEqual(a.click_ids, { fbclid: 'IwAR1' }, 'JSON columns read the way getLead() reads them');

  const b = rows.find((r) => r.lead_id === 'B');
  assert.equal(b.last_text, null);
  assert.equal(b.last_media, '[image]');
  assert.equal(b.last_direction, 'in');
  assert.equal(b.last_sender_kind, 'client');
  assert.equal(b.handler_name, null);

  const c = rows.find((r) => r.lead_id === 'C');
  assert.equal(c.last_text, null);
  assert.equal(c.last_direction, null);
  assert.equal(rows.find((r) => r.lead_id === 'G').handler_name, null, 'a deactivated handler is nobody');

  assert.deepEqual(inbox.listInbox({ userId: owner.user_id, limit: 2 }).map((r) => r.lead_id), ['B', 'G']);
  s.close();
});

test('unread counts only messages after the person\'s read mark, or after their account was made', () => {
  const { s, inbox, owner, sara } = listScene();
  // Sara's account is newer than G's message: it is not unread for her.
  const late = inbox.listInbox({ userId: sara.user_id, userCreated: NOW - 10_000 });
  assert.deepEqual(late.map((r) => r.lead_id), ['A', 'B', 'C', 'G']);
  assert.deepEqual(late.map((r) => r.unread), [1, 2, 0, 0], 'A-1 is unread for Sara: the owner\'s read mark is his own');
  inbox.markRead(owner.user_id, 'B', NOW - 9000);
  assert.equal(inbox.listInbox({ userId: owner.user_id }).find((r) => r.lead_id === 'B').unread, 1);
  s.close();
});

test('unreadTotal is the same rule summed over every inbox chat, and nothing outside it', () => {
  const { s, inbox, owner, sara } = listScene();
  const sum = (rows) => rows.reduce((n, r) => n + r.unread, 0);
  assert.equal(inbox.unreadTotal({ userId: owner.user_id }), 3, 'E and F have unread messages but are not inbox chats');
  assert.equal(inbox.unreadTotal({ userId: owner.user_id }), sum(inbox.listInbox({ userId: owner.user_id })));
  assert.equal(inbox.unreadTotal({ userId: sara.user_id, userCreated: NOW - 10_000 }), 3);
  assert.equal(inbox.unreadTotal({ userId: sara.user_id, userCreated: NOW - 10_000 }), sum(inbox.listInbox({ userId: sara.user_id, userCreated: NOW - 10_000 })));
  inbox.markRead(owner.user_id, 'B', NOW);
  inbox.markRead(owner.user_id, 'G', NOW);
  assert.equal(inbox.unreadTotal({ userId: owner.user_id }), 0);
  assert.equal(inbox.unreadTotal({}), 4, 'no reader: every inbound message of every chat');
  s.close();
});

test('listInbox breaks a tie by the newest row', () => {
  const { s, inbox } = harness();
  chat(s, 'T-1', { inbox_since: NOW - 1000 });
  chat(s, 'T-2', { inbox_since: NOW - 1000 });
  assert.deepEqual(inbox.listInbox({ userId: 'USR-1' }).map((r) => r.lead_id), ['T-2', 'T-1']);
  s.close();
});

test('listUnsure and countUnsure: unsure or unplaced chats only, newest first, with the first message\'s snippet', () => {
  const { s, inbox } = harness();
  lead(s, 'U1', { created: NOW - 3000, wa_jid: '966500000031@s.whatsapp.net', inbox_state: 'unsure' });
  s.addTouchpoint({ lead_id: 'U1', ts: NOW - 3000, channel: 'whatsapp', event_type: 'lead_created', meta: { match_method: 'keyword', snippet: 'is this bona?' } });
  lead(s, 'U2', { created: NOW - 2000, wa_lid: '111222333@lid' });
  s.db.prepare('INSERT INTO touchpoints (id, lead_id, ts, event_type, meta) VALUES (?,?,?,?,?)').run('tp-bad', 'U2', NOW - 2000, 'lead_created', '{not json');
  lead(s, 'U3', { created: NOW - 500, phone_e164: '966500000033', inbox_state: 'unsure' });
  lead(s, 'U4', { created: NOW - 400, wa_jid: '966500000034@s.whatsapp.net', inbox_state: 'in' });
  lead(s, 'U5', { created: NOW - 300, wa_jid: '966500000035@s.whatsapp.net', inbox_state: 'out' });
  lead(s, 'U6', { created: NOW - 1000, wa_jid: '966500000036@s.whatsapp.net', inbox_state: 'unsure' });
  s.addTouchpoint({ lead_id: 'U6', ts: NOW - 900, channel: 'whatsapp', event_type: 'stage_change', meta: { snippet: 'not the first message' } });

  const rows = inbox.listUnsure();
  assert.deepEqual(rows.map((r) => r.lead_id), ['U6', 'U2', 'U1']);
  assert.deepEqual(rows.map((r) => r.snippet), [null, null, 'is this bona?'], 'bad JSON meta shows no snippet instead of failing');
  assert.equal(rows[1].inbox_state, null, 'a chat not placed yet counts as unsure');
  assert.equal(inbox.countUnsure(), 3);
  assert.deepEqual(inbox.listUnsure({ limit: 1 }).map((r) => r.lead_id), ['U6']);
  s.close();
});

test('addGap records a message that could not be read, once; gapsFor lists one chat oldest first', () => {
  const { s, inbox } = harness();
  assert.equal(inbox.addGap({ key_id: 'G-2', lead_id: 'L-1', jid: JID, ts: NOW + 10, reason: 'failed' }), true);
  assert.equal(inbox.addGap({ key_id: 'G-1', lead_id: 'L-1', ts: NOW, reason: 'failed' }), true);
  assert.equal(inbox.addGap({ key_id: 'G-1', lead_id: 'L-1', ts: NOW, reason: 'failed' }), false);
  inbox.addGap({ key_id: 'G-x', lead_id: 'L-2', ts: NOW, reason: 'failed' });
  assert.deepEqual(inbox.gapsFor('L-1'), [
    { key_id: 'G-1', lead_id: 'L-1', jid: null, ts: NOW, reason: 'failed' },
    { key_id: 'G-2', lead_id: 'L-1', jid: JID, ts: NOW + 10, reason: 'failed' },
  ]);
  assert.throws(() => inbox.addGap({ lead_id: 'L-1', ts: NOW, reason: 'failed' }), RangeError);
  s.close();
});

test('clearGap removes one gap by its key and says whether there was one', () => {
  const { s, inbox } = harness();
  inbox.addGap({ key_id: 'join:L-1:1', lead_id: 'L-1', ts: NOW - 1, reason: 'history_failed' });
  inbox.addGap({ key_id: 'K-2', lead_id: 'L-1', jid: JID, ts: NOW + 1, reason: 'failed' });
  assert.equal(inbox.clearGap('join:L-1:1'), true);
  assert.equal(inbox.clearGap('join:L-1:1'), false, 'already gone');
  assert.equal(inbox.clearGap(null), false);
  assert.deepEqual(inbox.gapsFor('L-1').map((g) => g.key_id), ['K-2']);
  s.close();
});

test('a message stored after all clears the gap its failure left; any other gap stays', () => {
  const { s, inbox } = harness();
  chat(s, 'L-1');
  inbox.addGap({ key_id: 'K-1', lead_id: 'L-1', jid: JID, ts: NOW, reason: 'failed' });
  inbox.addGap({ key_id: 'join:L-1:1', lead_id: 'L-1', ts: NOW - 1, reason: 'history_failed' });
  inbox.addGap({ key_id: 'K-2', lead_id: 'L-1', jid: JID, ts: NOW + 1, reason: 'failed' });
  inbox.upsertMessage(msg());
  assert.deepEqual(inbox.gapsFor('L-1').map((g) => g.key_id), ['join:L-1:1', 'K-2'],
    'the thread would otherwise show the message and "could not be loaded" for the same id');
  s.close();
});

test('setInboxState keeps the first joining time, sets it on joining, and clears it on leaving', () => {
  const { s, inbox, tick } = harness();
  lead(s, 'X', { wa_jid: JID, inbox_state: 'unsure' });
  lead(s, 'Y', { wa_jid: '966500000041@s.whatsapp.net' });
  lead(s, 'Z', { wa_jid: '966500000042@s.whatsapp.net', inbox_state: 'in', inbox_since: null });

  tick(1000);
  assert.equal(inbox.setInboxState('X', 'in', { since: NOW - 500 }), true);
  assert.equal(s.getLead('X').inbox_state, 'in');
  assert.equal(s.getLead('X').inbox_since, NOW - 500);
  assert.equal(s.getLead('X').updated, NOW + 1000);

  tick(1000);
  inbox.setInboxState('X', 'in', { since: NOW + 999 });
  assert.equal(s.getLead('X').inbox_since, NOW - 500, 'already in: the first joining time stays');
  assert.equal(s.getLead('X').updated, NOW + 2000);

  inbox.setInboxState('Y', 'in');
  assert.equal(s.getLead('Y').inbox_since, NOW + 2000, 'since defaults to now');
  inbox.setInboxState('Z', 'in', { since: NOW - 7 });
  assert.equal(s.getLead('Z').inbox_since, NOW - 7, 'an in chat missing its time gets one');

  inbox.setInboxState('X', 'unsure');
  assert.equal(s.getLead('X').inbox_state, 'unsure');
  assert.equal(s.getLead('X').inbox_since, null);
  inbox.setInboxState('X', 'in', { since: NOW + 3000 });
  assert.equal(s.getLead('X').inbox_since, NOW + 3000, 'joining again starts again');
  inbox.setInboxState('X', 'out');
  assert.equal(s.getLead('X').inbox_state, 'out');
  assert.equal(s.getLead('X').inbox_since, null);

  assert.throws(() => inbox.setInboxState('X', 'maybe'), RangeError);
  assert.throws(() => inbox.setInboxState('X', null), RangeError);
  assert.equal(s.getLead('X').inbox_state, 'out');
  assert.equal(inbox.setInboxState('L-nope', 'in'), false);
  s.close();
});

test('setInboxState records the history floor on joining, keeps it while the chat stays in, and clears it on leaving', () => {
  const { s, inbox } = harness();
  lead(s, 'X', { wa_jid: JID, inbox_state: 'unsure' });
  lead(s, 'Y', { wa_jid: '966500000041@s.whatsapp.net' });
  lead(s, 'Z', { wa_jid: '966500000042@s.whatsapp.net', inbox_state: 'in', inbox_since: NOW - DAY });

  assert.equal(inbox.setInboxState('X', 'in', { since: NOW, historyFrom: NOW - OWNER_HISTORY_MS }), true);
  assert.equal(s.getLead('X').history_from, NOW - OWNER_HISTORY_MS, 'the owner vouched: 30 days back');
  inbox.setInboxState('X', 'in', { since: NOW + 5, historyFrom: NOW + 5 - JOIN_HISTORY_MS });
  assert.equal(s.getLead('X').history_from, NOW - OWNER_HISTORY_MS, 'already in: the floor it joined with stays');
  inbox.setInboxState('Y', 'in', { since: NOW - 100 });
  assert.equal(s.getLead('Y').history_from, NOW - 100 - JOIN_HISTORY_MS, 'a join always has a floor: by default the 24 h an automatic join keeps');
  inbox.setInboxState('Z', 'in', { since: NOW, historyFrom: NOW - 7 });
  assert.equal(s.getLead('Z').history_from, NOW - 7, 'an in chat missing its floor gets one');

  inbox.setInboxState('X', 'unsure');
  assert.equal(s.getLead('X').history_from, null, 'back on the Unsure list: no floor');
  inbox.setInboxState('X', 'in', { since: NOW + 10, historyFrom: NOW + 10 - JOIN_HISTORY_MS });
  assert.equal(s.getLead('X').history_from, NOW + 10 - JOIN_HISTORY_MS, 'joining again starts again');
  inbox.setInboxState('X', 'out');
  assert.equal(s.getLead('X').history_from, null, 'out: no floor');
  inbox.setInboxState('Y', 'in', { since: NOW, historyFrom: NOW - DAY });
  inbox.leaveInbox('Y');
  assert.equal(s.getLead('Y').history_from, null, 'Not a client clears it too');
  s.close();
});

test('setHandler and setNeedsHuman write the lead and say whether there was one', () => {
  const { s, inbox } = harness();
  chat(s, 'L-1');
  assert.equal(inbox.setHandler('L-1', 'USR-1'), true);
  assert.equal(s.getLead('L-1').handler_user_id, 'USR-1');
  assert.equal(inbox.setHandler('L-1', null), true);
  assert.equal(s.getLead('L-1').handler_user_id, null);
  assert.equal(inbox.setHandler('L-nope', 'USR-1'), false);

  assert.equal(inbox.setNeedsHuman('L-1', 1), true);
  assert.equal(s.getLead('L-1').needs_human, 1);
  inbox.setNeedsHuman('L-1', 0);
  assert.equal(s.getLead('L-1').needs_human, 0);
  inbox.setNeedsHuman('L-1', true);
  assert.equal(s.getLead('L-1').needs_human, 1);
  assert.equal(inbox.setNeedsHuman('L-nope', 1), false);
  s.close();
});

/** Two chats with a transcript each; L-1 also has a login-code row that names it. */
function purgeScene() {
  const h = harness();
  const { s, inbox } = h;
  chat(s, 'L-1', { handler_user_id: 'USR-1', needs_human: 1 });
  chat(s, 'L-2', { wa_jid: '966500000002@s.whatsapp.net' });
  inbox.upsertMessage(msg({ key_id: 'K-1', ts: NOW - 2000 }));
  inbox.upsertMessage(msg({ key_id: 'K-2', direction: 'out', sender_kind: 'staff', sender_user_id: 'USR-1', ts: NOW - 1000 }));
  inbox.upsertMessage(msg({ key_id: 'K-9', lead_id: 'L-2', ts: NOW - 500 }));
  inbox.insertOutbox(out({ send_id: 'SND-staff' }));
  inbox.insertOutbox(out({ send_id: 'SND-dana', sender_kind: 'dana', user_id: null }));
  inbox.insertOutbox({ send_id: 'SND-code-lead', lead_id: 'L-1', jid: JID, sender_kind: 'code' });
  inbox.insertOutbox({ send_id: 'SND-code', jid: JID, sender_kind: 'code' });
  inbox.insertOutbox(out({ send_id: 'SND-l2', lead_id: 'L-2' }));
  inbox.addGap({ key_id: 'G-1', lead_id: 'L-1', ts: NOW - 1500, reason: 'failed' });
  inbox.addGap({ key_id: 'G-9', lead_id: 'L-2', ts: NOW - 400, reason: 'failed' });
  inbox.markRead('USR-1', 'L-1', NOW);
  inbox.markRead('USR-2', 'L-1', NOW);
  inbox.markRead('USR-1', 'L-2', NOW);
  return h;
}

test('purgeLead deletes one chat\'s transcript and keeps login-code rows and every other chat', () => {
  const { s, inbox } = purgeScene();
  assert.deepEqual(inbox.purgeLead('L-1'), { messages: 2, outbox: 2, gaps: 1, reads: 2 });
  const l1 = s.getLead('L-1');
  assert.equal(l1.last_msg_ts, null);
  assert.equal(l1.inbox_state, 'in', 'purging is not leaving');
  assert.equal(inbox.hasMessages('L-1'), false);
  assert.ok(inbox.getOutbox('SND-code-lead'));
  assert.ok(inbox.getOutbox('SND-code'));
  // A send of the last 24 hours stays as a stub: no text, no chat — still counted against
  // the day, and its send id still never goes out a second time.
  for (const id of ['SND-staff', 'SND-dana']) {
    const stub = inbox.getOutbox(id);
    assert.deepEqual(
      { lead_id: stub.lead_id, text: stub.text, jid: stub.jid, status: stub.status, created: stub.created },
      { lead_id: null, text: null, jid: JID, status: 'pending', created: NOW },
      id,
    );
  }
  assert.deepEqual(inbox.openOutboxFor('L-1'), []);
  assert.deepEqual(inbox.gapsFor('L-1'), []);

  assert.deepEqual(inbox.messagesFor('L-2').map((m) => m.key_id), ['K-9']);
  assert.equal(s.getLead('L-2').last_msg_ts, NOW - 500);
  assert.ok(inbox.getOutbox('SND-l2'));
  assert.equal(inbox.gapsFor('L-2').length, 1);
  assert.equal(count(s, 'inbox_reads'), 1);
  assert.deepEqual(inbox.purgeLead('L-1'), { messages: 0, outbox: 0, gaps: 0, reads: 0 });
  s.close();
});

test('purgeLead deletes a send older than 24 hours outright; one of exactly 24 hours is still a stub', () => {
  const { s, inbox, at } = harness();
  chat(s, 'L-1');
  at(NOW - DAY - 1);
  inbox.insertOutbox(out({ send_id: 'SND-older', status: 'accepted' }));
  at(NOW - DAY);
  inbox.insertOutbox(out({ send_id: 'SND-edge', status: 'accepted' }));
  at(NOW);
  const counted = inbox.countSentSince(NOW - DAY);
  assert.deepEqual(inbox.purgeLead('L-1'), { messages: 0, outbox: 2, gaps: 0, reads: 0 });
  assert.equal(inbox.getOutbox('SND-older'), null, 'out of the day window: nothing left to guard');
  assert.equal(inbox.getOutbox('SND-edge').text, null);
  assert.equal(inbox.countSentSince(NOW - DAY), counted, 'the day count is what it was before the purge');
  s.close();
});

test('leaveInbox moves a chat out, purges it, and clears its handler and needs-human flag', () => {
  const { s, inbox } = purgeScene();
  assert.deepEqual(inbox.leaveInbox('L-1'), { messages: 2, outbox: 2, gaps: 1, reads: 2 });
  const l1 = s.getLead('L-1');
  assert.equal(l1.inbox_state, 'out');
  assert.equal(l1.inbox_since, null);
  assert.equal(l1.handler_user_id, null);
  assert.equal(l1.needs_human, 0);
  assert.equal(l1.last_msg_ts, null);
  assert.equal(inbox.hasMessages('L-1'), false);
  assert.equal(inbox.hasMessages('L-2'), true);
  s.close();
});

test('leaveInbox is all or nothing: a failure half-way leaves the chat in, with its transcript', () => {
  const { s, inbox } = purgeScene();
  s.db.exec('DROP TABLE inbox_reads');
  assert.throws(() => inbox.leaveInbox('L-1'), /inbox_reads/);
  const l1 = s.getLead('L-1');
  assert.equal(l1.inbox_state, 'in');
  assert.equal(l1.handler_user_id, 'USR-1');
  assert.equal(l1.needs_human, 1);
  assert.equal(l1.last_msg_ts, NOW - 1000);
  assert.deepEqual(inbox.messagesFor('L-1').map((m) => m.key_id), ['K-1', 'K-2']);
  assert.ok(inbox.getOutbox('SND-staff'));
  s.close();
});

test('retentionPurge deletes the transcripts of chats silent since before the cutoff; lead rows stay', () => {
  const { s, inbox, at } = harness();
  const cutoff = NOW - RETENTION_MS;
  chat(s, 'OLD');
  chat(s, 'EDGE', { wa_jid: '966500000051@s.whatsapp.net' });
  chat(s, 'NEW', { wa_jid: '966500000052@s.whatsapp.net' });
  chat(s, 'EMPTY', { wa_jid: '966500000053@s.whatsapp.net', last_msg_ts: cutoff - 99 });
  inbox.upsertMessage(msg({ key_id: 'O-1', lead_id: 'OLD', ts: cutoff - 5000 }));
  inbox.upsertMessage(msg({ key_id: 'O-2', lead_id: 'OLD', ts: cutoff - 1 }));
  at(cutoff - 1);
  inbox.insertOutbox(out({ send_id: 'SND-old', lead_id: 'OLD' }));
  at(NOW);
  inbox.upsertMessage(msg({ key_id: 'E-1', lead_id: 'EDGE', ts: cutoff }));
  inbox.upsertMessage(msg({ key_id: 'N-1', lead_id: 'NEW', ts: NOW - 1000 }));

  assert.deepEqual(inbox.retentionPurge(cutoff), { leads: 1, messages: 2 });
  assert.ok(s.getLead('OLD'), 'the lead row stays: it is attribution data');
  assert.equal(s.getLead('OLD').last_msg_ts, null);
  assert.equal(inbox.hasMessages('OLD'), false);
  assert.equal(inbox.getOutbox('SND-old'), null);
  assert.equal(inbox.hasMessages('EDGE'), true, 'exactly at the cutoff is not older than it');
  assert.equal(inbox.hasMessages('NEW'), true);
  assert.equal(s.getLead('EMPTY').last_msg_ts, cutoff - 99, 'nothing to delete: not counted, not touched');
  assert.deepEqual(inbox.retentionPurge(cutoff), { leads: 0, messages: 0 });
  s.close();
});

test('statements are prepared once per store, not on every call', () => {
  const { s, inbox } = harness();
  chat(s, 'L-1');
  let prepares = 0;
  const realPrepare = s.db.prepare.bind(s.db);
  s.db.prepare = (sql) => { prepares += 1; return realPrepare(sql); };
  inbox.newestTs('L-1');
  inbox.newestTs('L-1');
  inbox.hasMessages('L-1');
  inbox.hasMessages('L-1');
  assert.equal(prepares, 2);
  s.db.prepare = realPrepare;
  s.close();
});

test('inChatsWithoutMessages: in chats with nothing stored yet, oldest joiner first (amendment A3)', () => {
  const { s, inbox } = harness();
  chat(s, 'L-new', { wa_jid: '966500000002@s.whatsapp.net', inbox_since: NOW - DAY });
  chat(s, 'L-old', { wa_jid: '966500000003@s.whatsapp.net', inbox_since: NOW - 3 * DAY });
  chat(s, 'L-lid', { wa_jid: null, wa_lid: '123456789@lid', inbox_since: NOW - 2 * DAY });
  chat(s, 'L-talked', { wa_jid: '966500000004@s.whatsapp.net' });
  inbox.upsertMessage(msg({ lead_id: 'L-talked' }));
  lead(s, 'L-form', { phone_e164: '966500000005', inbox_state: 'in', inbox_since: NOW - 4 * DAY });
  lead(s, 'L-unsure', { wa_jid: '966500000006@s.whatsapp.net', inbox_state: 'unsure' });
  lead(s, 'L-out', { wa_jid: '966500000007@s.whatsapp.net', inbox_state: 'out' });
  assert.deepEqual(inbox.inChatsWithoutMessages().map((l) => l.lead_id), ['L-old', 'L-lid', 'L-new'],
    'a chat with a message, a form lead with no chat, a guess and a "not a client" are not in it');
  assert.deepEqual(inbox.inChatsWithoutMessages({ limit: 1 }).map((l) => l.lead_id), ['L-old']);
  s.close();
});

test('listedLeads: every in lead (a chat or not) and every lead on the Unsure list, for the upkeep\'s exclusion sweep', () => {
  const { s, inbox } = harness();
  chat(s, 'L-in', { phone_e164: '966500000002', wa_jid: '966500000002@s.whatsapp.net' });
  lead(s, 'L-form', { phone_e164: '966500000005', inbox_state: 'in' });
  lead(s, 'L-unsure', { wa_jid: '966500000006@s.whatsapp.net', inbox_state: 'unsure' });
  lead(s, 'L-unplaced', { wa_lid: '123456789@lid' });
  lead(s, 'L-out', { wa_jid: '966500000007@s.whatsapp.net', inbox_state: 'out' });
  lead(s, 'L-legacy', { phone_e164: '966500000008', channel: 'form' });
  assert.deepEqual(inbox.listedLeads().map((l) => l.lead_id).sort(), ['L-form', 'L-in', 'L-unplaced', 'L-unsure'],
    'an in lead with no chat is swept too; a "not a client", and a lead that is neither in nor a chat, are not');
  assert.deepEqual(inbox.listedLeads().find((l) => l.lead_id === 'L-in'),
    { lead_id: 'L-in', phone_e164: '966500000002', wa_jid: '966500000002@s.whatsapp.net', wa_lid: null, inbox_state: 'in' },
    'only what the exclusion test reads');
  s.close();
});

/* ---------------- real-estate chats to check (D17) ---------------- */

const PHONE = '966500000077';
const PJID = `${PHONE}@s.whatsapp.net`;
const LID = '272516946294519@lid';
const cand = (s, id) => ({ ...s.db.prepare('SELECT * FROM inbox_candidates WHERE cand_id = ?').get(id) });

test('a candidate is kept 30 days after its last property message, a dismissed one a year', () => {
  assert.equal(CANDIDATE_KEEP_MS, 30 * DAY);
  assert.equal(DISMISSED_KEEP_MS, 365 * DAY);
});

test('noteCandidate makes one row per chat: who, when, which words and who wrote last — never what was written', () => {
  const { s, inbox, at } = harness();
  const first = inbox.noteCandidate({ jid: PJID, phone: PHONE, name: '  Umm   Khalid ', ts: NOW - 5000, words: ['شقة', 'إيجار'], dir: 'in' });
  assert.equal(first.state, 'open');
  assert.equal(first.created, true);
  assert.match(first.cand_id, /^CND-[0-9a-z]+-[0-9a-f]{4}$/);
  assert.deepEqual(cand(s, first.cand_id), {
    cand_id: first.cand_id, jid: PJID, lid: null, phone_e164: PHONE, name: 'Umm Khalid',
    first_ts: NOW - 5000, last_ts: NOW - 5000, hits: 1, words: 'شقة,إيجار', last_dir: 'in', state: 'open', updated: NOW,
  });

  // The same chat again, now by its lid with the phone jid alongside: the same row.
  at(NOW + 1000);
  const again = inbox.noteCandidate({ jid: PJID, lid: LID, name: 'Someone Else', ts: NOW - 1000, words: ['villa', 'شقة'], dir: 'out' });
  assert.deepEqual(again, { state: 'open', cand_id: first.cand_id, created: false });
  assert.deepEqual(cand(s, first.cand_id), {
    cand_id: first.cand_id, jid: PJID, lid: LID, phone_e164: PHONE, name: 'Umm Khalid',
    first_ts: NOW - 5000, last_ts: NOW - 1000, hits: 2, words: 'شقة,إيجار,villa', last_dir: 'out', state: 'open', updated: NOW + 1000,
  }, 'a name it has is kept; the lid it lacked is filled');

  // An older message read late (the poll overlap) counts, but moves neither the last time nor the last writer.
  inbox.noteCandidate({ lid: LID, ts: NOW - 9000, words: [], dir: 'in' });
  const row = cand(s, first.cand_id);
  assert.deepEqual([row.first_ts, row.last_ts, row.last_dir, row.hits], [NOW - 9000, NOW - 1000, 'out', 3]);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM inbox_candidates').get().n, 1);
  s.close();
});

test('noteCandidate keeps at most eight words, each once, no commas, strings only', () => {
  const { s, inbox } = harness();
  const { cand_id } = inbox.noteCandidate({ phone: PHONE, ts: NOW, words: ['villa', 'villa', 'a,b', 42, null, '  ', 'flat'], dir: 'in' });
  assert.equal(cand(s, cand_id).words, 'villa,a b,flat');
  inbox.noteCandidate({ phone: PHONE, ts: NOW, words: ['land', 'plot', 'rent', 'lease', 'sqm', 'broker', 'duplex'], dir: 'in' });
  assert.equal(cand(s, cand_id).words, 'villa,a b,flat,land,plot,rent,lease,sqm', 'the first eight, in order');
  assert.deepEqual(inbox.getCandidate(cand_id).words, ['villa', 'a b', 'flat', 'land', 'plot', 'rent', 'lease', 'sqm']);
  const none = inbox.noteCandidate({ jid: 'x@s.whatsapp.net', ts: NOW, dir: 'out' });
  assert.equal(cand(s, none.cand_id).words, null);
  assert.deepEqual(inbox.getCandidate(none.cand_id).words, []);
  s.close();
});

test('noteCandidate never fills an id another row already holds, and refuses a chat with no id, no time or no direction', () => {
  const { s, inbox } = harness();
  const byLid = inbox.noteCandidate({ lid: LID, ts: NOW, words: ['villa'], dir: 'in' });
  const byPhone = inbox.noteCandidate({ phone: PHONE, ts: NOW, words: ['flat'], dir: 'in' });
  // A record that shows both: found by its number first, and the lid stays with its own row.
  assert.equal(inbox.noteCandidate({ phone: PHONE, lid: LID, ts: NOW + 1, words: [], dir: 'in' }).cand_id, byPhone.cand_id);
  assert.equal(cand(s, byPhone.cand_id).lid, null);
  assert.equal(cand(s, byLid.cand_id).lid, LID);
  assert.throws(() => inbox.noteCandidate({ ts: NOW, dir: 'in' }), RangeError);
  assert.throws(() => inbox.noteCandidate({ phone: '  ', jid: '', ts: NOW, dir: 'in' }), RangeError);
  assert.throws(() => inbox.noteCandidate({ phone: PHONE, ts: 'soon', dir: 'in' }), RangeError);
  assert.throws(() => inbox.noteCandidate({ phone: PHONE, ts: NOW, dir: 'sideways' }), RangeError);
  assert.throws(() => inbox.noteCandidate(), RangeError);
  s.close();
});

test('a dismissed candidate stays dismissed: a later message neither reopens nor counts it, and only its ids are left', () => {
  const { s, inbox, at } = harness();
  const { cand_id } = inbox.noteCandidate({ jid: PJID, phone: PHONE, name: 'Umm Khalid', ts: NOW - 9000, words: ['villa'], dir: 'in' });
  inbox.noteCandidate({ phone: PHONE, ts: NOW - 1000, words: ['شقة'], dir: 'out' });
  at(NOW + 5000);
  assert.equal(inbox.dismissCandidate(cand_id), true);
  assert.equal(inbox.dismissCandidate(cand_id), false, 'once');
  assert.equal(inbox.dismissCandidate('CND-nope'), false);
  const row = cand(s, cand_id);
  assert.deepEqual(row, {
    cand_id, jid: PJID, lid: null, phone_e164: PHONE, name: null,
    first_ts: NOW + 5000, last_ts: NOW + 5000, hits: 0, words: null, last_dir: null, state: 'dismissed', updated: NOW + 5000,
  }, 'no name, words, count, last writer or message times: only the ids and when it was dismissed');
  at(NOW + 9000);
  assert.deepEqual(inbox.noteCandidate({ phone: PHONE, name: 'Umm Khalid', ts: NOW + 8000, words: ['شقة'], dir: 'in' }), { state: 'dismissed', cand_id, created: false });
  assert.deepEqual(cand(s, cand_id), row, 'not touched at all');
  assert.equal(inbox.countCandidates(), 0);
  assert.deepEqual(inbox.listCandidates(), []);
  s.close();
});

test('listCandidates and countCandidates: open rows only, the latest message first', () => {
  const { s, inbox } = harness();
  const a = inbox.noteCandidate({ phone: '966500000001', ts: NOW - 3000, words: ['villa'], dir: 'in' });
  const b = inbox.noteCandidate({ phone: '966500000002', ts: NOW - 1000, words: ['flat'], dir: 'out' });
  const c = inbox.noteCandidate({ phone: '966500000003', ts: NOW - 2000, words: ['land'], dir: 'in' });
  const d = inbox.noteCandidate({ phone: '966500000004', ts: NOW, words: ['plot'], dir: 'in' });
  inbox.dismissCandidate(d.cand_id);
  assert.deepEqual(inbox.listCandidates().map((r) => r.cand_id), [b.cand_id, c.cand_id, a.cand_id]);
  assert.deepEqual(inbox.listCandidates({ limit: 1 }).map((r) => r.cand_id), [b.cand_id]);
  assert.equal(inbox.countCandidates(), 3);
  assert.deepEqual(inbox.listCandidates()[0].words, ['flat']);
  assert.equal(inbox.getCandidate('CND-nope'), null);
  s.close();
});

test('listCandidates and countCandidates leave out a chat that has become a lead since, by its number, jid or lid', () => {
  const { s, inbox } = harness();
  const byPhone = inbox.noteCandidate({ phone: '966500000001', ts: NOW - 1000, words: ['villa'], dir: 'in' });
  const byJid = inbox.noteCandidate({ phone: '966500000002', jid: '966500000002@s.whatsapp.net', ts: NOW - 2000, words: ['villa'], dir: 'in' });
  const byLid = inbox.noteCandidate({ phone: '966500000003', lid: LID, ts: NOW - 3000, words: ['villa'], dir: 'in' });
  const stays = inbox.noteCandidate({ phone: '966500000004', ts: NOW - 4000, words: ['villa'], dir: 'in' });
  assert.equal(inbox.countCandidates(), 4);
  lead(s, 'LEAD-p', { phone_e164: '966500000001' });
  lead(s, 'LEAD-j', { wa_jid: '966500000002@s.whatsapp.net' });
  lead(s, 'LEAD-l', { wa_lid: LID });
  assert.deepEqual(inbox.listCandidates().map((r) => r.cand_id), [stays.cand_id]);
  assert.equal(inbox.countCandidates(), 1, 'the count is the list');
  // Still there to be read and removed: the lead decides, the row waits for the poller or the prune.
  for (const c of [byPhone, byJid, byLid]) assert.equal(inbox.getCandidate(c.cand_id).state, 'open');
  s.close();
});

test('removeCandidate and removeCandidatesFor: one row, or every row of a chat by any of its ids, open or dismissed', () => {
  const { s, inbox } = harness();
  const byPhone = inbox.noteCandidate({ phone: PHONE, ts: NOW, words: ['villa'], dir: 'in' });
  const byLid = inbox.noteCandidate({ lid: LID, ts: NOW, words: ['villa'], dir: 'in' });
  const other = inbox.noteCandidate({ phone: '966500000001', jid: '966500000001@s.whatsapp.net', ts: NOW, words: ['flat'], dir: 'in' });
  inbox.dismissCandidate(byLid.cand_id);
  assert.equal(inbox.removeCandidatesFor({ phone: PHONE, jid: PJID, lid: LID }), 2);
  assert.equal(inbox.getCandidate(byPhone.cand_id), null);
  assert.equal(inbox.getCandidate(byLid.cand_id), null);
  assert.ok(inbox.getCandidate(other.cand_id), 'another chat stays');
  assert.equal(inbox.removeCandidatesFor({}), 0, 'no id, nothing removed');
  assert.equal(inbox.removeCandidatesFor({ phone: null, jid: '', lid: undefined }), 0);
  assert.equal(inbox.removeCandidatesFor({ jid: '966500000001@s.whatsapp.net' }), 1);
  const last = inbox.noteCandidate({ phone: PHONE, ts: NOW, words: [], dir: 'in' });
  assert.equal(inbox.removeCandidate(last.cand_id), true);
  assert.equal(inbox.removeCandidate(last.cand_id), false);
  s.close();
});

test('pruneCandidates: open rows by their last message, dismissed rows by when they were dismissed; a cutoff is not older than itself', () => {
  const { s, inbox, at } = harness();
  const openOld = inbox.noteCandidate({ phone: '966500000001', ts: NOW - 31 * DAY, words: ['villa'], dir: 'in' });
  const openEdge = inbox.noteCandidate({ phone: '966500000002', ts: NOW - 30 * DAY, words: ['villa'], dir: 'in' });
  const openNew = inbox.noteCandidate({ phone: '966500000003', ts: NOW - DAY, words: ['villa'], dir: 'in' });
  const gone = inbox.noteCandidate({ phone: '966500000004', ts: NOW - 400 * DAY, words: ['villa'], dir: 'in' });
  const kept = inbox.noteCandidate({ phone: '966500000005', ts: NOW - 400 * DAY, words: ['villa'], dir: 'in' });
  at(NOW - 366 * DAY);
  inbox.dismissCandidate(gone.cand_id);
  at(NOW - 365 * DAY);
  inbox.dismissCandidate(kept.cand_id);
  at(NOW);
  assert.deepEqual(inbox.pruneCandidates({ openBefore: NOW - 30 * DAY, dismissedBefore: NOW - 365 * DAY }), { open: 1, dismissed: 1 });
  assert.equal(inbox.getCandidate(openOld.cand_id), null);
  assert.ok(inbox.getCandidate(openEdge.cand_id), 'exactly 30 days is not older than the cutoff');
  assert.ok(inbox.getCandidate(openNew.cand_id));
  assert.equal(inbox.getCandidate(gone.cand_id), null);
  assert.ok(inbox.getCandidate(kept.cand_id), 'dismissed exactly a year ago stays, so it is still not listed again');
  assert.deepEqual(inbox.pruneCandidates({ openBefore: 'x', dismissedBefore: null }), { open: 0, dismissed: 0 }, 'garbage deletes nothing');
  assert.deepEqual(inbox.pruneCandidates(), { open: 0, dismissed: 0 });
  s.close();
});
