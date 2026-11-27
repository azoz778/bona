/**
 * Team accounts: the schema they live in, the people, the never-a-client list, the
 * switches and the audit log. The clock is injected so every timestamp is exact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb, SCHEMA_VERSION } from '../lib/db.mjs';
import { createTeam, SETTINGS_DEFAULTS, SETTINGS_ALLOWED, TeamError, isTeamLid, learnTeamLid, isExcludedLead } from '../lib/team.mjs';
import { createAudit, AUDIT_ACTIONS } from '../lib/audit.mjs';
import { jidsOf } from '../lib/wa-poller.mjs';

const NOW = 1_790_500_000_000;

test('schema v3 adds the team tables and a user on every session', () => {
  const s = openDb(':memory:');
  // db.test.mjs proves a v5 file upgrades to SCHEMA_VERSION and gains the v6 columns (no exact number is pinned here); this test only needs v3's tables.
  assert.ok(SCHEMA_VERSION >= 3);
  assert.equal(s.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  const tables = new Set(s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  for (const name of ['users', 'auth_challenges', 'audit_log', 'never_list', 'settings']) assert.ok(tables.has(name), name);
  const cols = s.db.prepare('PRAGMA table_info(auth_sessions)').all().map((c) => c.name);
  assert.ok(cols.includes('user_id'));
  s.createAuthSession('tok_one', { now: NOW, ttlMs: 1000, ua: 'UA', userId: 'USR-1' });
  assert.equal(s.checkAuthSession('tok_one', { now: NOW }).user_id, 'USR-1');
  s.close();
});

function teamHarness(opts = {}) {
  const s = openDb(':memory:');
  let clock = NOW;
  const team = createTeam(s, { now: () => clock, ...opts });
  return { s, team, tick: (ms) => { clock += ms; } };
}
const codeOf = (fn) => { try { fn(); } catch (err) { return err instanceof TeamError ? err.code : `not a TeamError: ${err}`; } return null; };

test('ensureOwner seeds the owner once and hands him the sessions from before accounts existed', () => {
  const { s, team } = teamHarness();
  // A session from before accounts: no user_id. createAuthSession no longer writes one.
  s.db.prepare('INSERT INTO auth_sessions (token_hash, created, expires, ua, user_id) VALUES (?,?,?,?,NULL)')
    .run(crypto.createHash('sha256').update('tok_old', 'utf8').digest('hex'), NOW, NOW + 1000, null);
  const owner = team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  assert.equal(owner.role, 'owner');
  assert.equal(owner.phone_e164, '966593296933');
  assert.equal(owner.wa_jid, '966593296933@s.whatsapp.net');
  assert.equal(s.checkAuthSession('tok_old', { now: NOW }).user_id, owner.user_id);
  const again = team.ensureOwner({ phone: '966593296933', name: 'Someone else' });
  assert.equal(again.user_id, owner.user_id, 'idempotent');
  assert.equal(team.listUsers().length, 1);
  s.close();
});

test('addUser normalises the phone and refuses bad or duplicate input', () => {
  const { s, team } = teamHarness();
  team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const sara = team.addUser({ name: '  Sara  ', phone: '0500000001', role: 'staff' });
  assert.equal(sara.name, 'Sara');
  assert.equal(sara.phone_e164, '966500000001');
  assert.equal(sara.active, 1);
  assert.equal(team.getUserByPhone('+966 50 000 0001').user_id, sara.user_id);
  assert.equal(codeOf(() => team.addUser({ name: '', phone: '0500000002' })), 'bad_name');
  assert.equal(codeOf(() => team.addUser({ name: 'X', phone: '12' })), 'bad_phone');
  assert.equal(codeOf(() => team.addUser({ name: 'X', phone: '0500000001' })), 'duplicate_phone');
  assert.equal(codeOf(() => team.addUser({ name: 'X', phone: '0500000003', role: 'admin' })), 'bad_role');
  s.close();
});

test('deactivating kills that person\'s sessions and codes at once; the last owner stays', () => {
  const { s, team } = teamHarness();
  const owner = team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const sara = team.addUser({ name: 'Sara', phone: '0500000001' });
  s.createAuthSession('tok_sara', { now: NOW, ttlMs: 86_400_000, userId: sara.user_id });
  s.db.prepare("INSERT INTO auth_challenges (challenge_id, user_id, code_hash, nonce_hash, created, expires) VALUES ('CH-1', ?, 'h', 'n', ?, ?)").run(sara.user_id, NOW, NOW + 1000);
  const off = team.deactivateUser(sara.user_id);
  assert.equal(off.active, 0);
  assert.equal(off.deactivated, NOW);
  assert.equal(s.checkAuthSession('tok_sara', { now: NOW }), null);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM auth_challenges WHERE user_id = ?').get(sara.user_id).n, 0);
  assert.equal(codeOf(() => team.deactivateUser(owner.user_id)), 'last_owner');
  assert.equal(codeOf(() => team.setRole(owner.user_id, 'staff')), 'last_owner');
  assert.equal(team.reactivateUser(sara.user_id).active, 1);
  team.setRole(sara.user_id, 'owner');
  assert.equal(team.deactivateUser(owner.user_id).active, 0, 'with a second owner the first can go');
  assert.equal(codeOf(() => team.deactivateUser('USR-nope')), 'not_found');
  s.close();
});

test('team numbers (active or not) and never-list numbers are excluded from client matching', () => {
  const { s, team } = teamHarness();
  team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const sara = team.addUser({ name: 'Sara', phone: '0500000001' });
  team.deactivateUser(sara.user_id);
  assert.equal(team.isExcludedPhone('966500000001'), true, 'a former employee is still not a client');
  assert.equal(team.isExcludedPhone('966511111111'), false);
  team.addNever({ phone: '0511111111', note: 'cousin', by: 'USR-x' });
  assert.equal(team.isExcludedPhone('966511111111'), true);
  assert.deepEqual(team.listNever().map((r) => r.phone_e164), ['966511111111']);
  assert.equal(team.removeNever('0511111111'), true);
  assert.equal(team.isExcludedPhone('966511111111'), false);
  assert.equal(codeOf(() => team.addNever({ phone: 'abc' })), 'bad_phone');
  s.close();
});

test('settings default to on, can be switched, and refuse unknown keys', () => {
  const { s, team } = teamHarness();
  assert.equal(team.sendingEnabled(), true);
  team.setSetting('sending_enabled', '0', { by: 'USR-1' });
  assert.equal(team.sendingEnabled(), false);
  assert.equal(s.db.prepare("SELECT updated_by FROM settings WHERE key = 'sending_enabled'").get().updated_by, 'USR-1');
  assert.equal(codeOf(() => team.setSetting('no_such_setting', '1')), 'bad_setting');
  s.close();
});

test('replies to clients from the dashboard ship off, go on only with an exact "1", and fail closed', () => {
  const { s, team } = teamHarness();
  assert.equal(team.getSetting('inbox_replies'), '0');
  assert.equal(team.repliesEnabled(), false, 'off until the owner turns them on (design D14)');
  assert.equal(team.sendingEnabled(), true, 'a separate switch: login codes do not wait for it');
  team.setSetting('inbox_replies', '1', { by: 'USR-1' });
  assert.equal(team.repliesEnabled(), true);
  assert.equal(s.db.prepare("SELECT updated_by FROM settings WHERE key = 'inbox_replies'").get().updated_by, 'USR-1');
  team.setSetting('inbox_replies', '0');
  assert.equal(team.repliesEnabled(), false);
  assert.equal(codeOf(() => team.setSetting('inbox_replies', 'yes')), 'bad_setting_value');
  assert.equal(codeOf(() => team.setSetting('inbox_replies', '')), 'bad_setting_value');
  s.db.prepare("INSERT OR REPLACE INTO settings (key, value, updated, updated_by) VALUES ('inbox_replies','true',?,NULL)").run(NOW);
  assert.equal(team.repliesEnabled(), false, "fail closed on anything but exactly '1'");
  s.close();
});

test('ensureOwner promotes an existing staff member found at the env phone number', () => {
  const { s, team } = teamHarness();
  team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const sara = team.addUser({ name: 'Sara', phone: '0500000001', role: 'staff' });
  const promoted = team.ensureOwner({ phone: '0500000001', name: 'Sara' });
  assert.equal(promoted.user_id, sara.user_id);
  assert.equal(promoted.role, 'owner');
  assert.equal(promoted.active, 1);
  s.close();
});

test('ensureOwner adds a new owner when the env phone changes; the old owner is left alone', () => {
  const { s, team } = teamHarness();
  const first = team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const second = team.ensureOwner({ phone: '966500000009', name: 'New Owner' });
  assert.notEqual(second.user_id, first.user_id);
  assert.equal(second.role, 'owner');
  assert.equal(second.active, 1);
  const stillOwner = team.getUser(first.user_id);
  assert.equal(stillOwner.role, 'owner');
  assert.equal(stillOwner.active, 1);
  assert.equal(team.listUsers().filter((u) => u.role === 'owner' && u.active).length, 2);
  s.close();
});

test('ensureOwner logs a bare event, with no phone or name, when the env phone differs from another active owner', () => {
  const events = [];
  const { s, team } = teamHarness({ log: (e) => events.push(e) });
  team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  assert.equal(events.length, 0, 'first-ever seeding is not a change');
  team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  assert.equal(events.length, 0, 'the same env phone again is not a change');
  team.ensureOwner({ phone: '966500000009', name: 'New Owner' });
  assert.equal(events.length, 1);
  assert.equal(events[0].evt, 'team.owner_env_changed');
  const dump = JSON.stringify(events[0]);
  assert.ok(!dump.includes('9665'), 'no phone digits in the log');
  assert.ok(!dump.includes('Abdulaziz') && !dump.includes('New Owner'), 'no names in the log');
  s.close();
});

test('ensureOwner defaults an owner with no name to "Owner", never the string "null"', () => {
  const { s, team } = teamHarness();
  const owner = team.ensureOwner({ phone: '966593296933', name: null });
  assert.equal(owner.name, 'Owner');
  const { s: s2, team: team2 } = teamHarness();
  const owner2 = team2.ensureOwner({ phone: '966593296933' });
  assert.equal(owner2.name, 'Owner');
  s.close(); s2.close();
});

test('ensureOwner still accepts the phone forms the env var and a bare jid produce', () => {
  const { s, team } = teamHarness();
  const a = team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const { s: s2, team: team2 } = teamHarness();
  const b = team2.ensureOwner({ phone: '+966 59 329 6933', name: 'Abdulaziz' });
  const { s: s3, team: team3 } = teamHarness();
  const c = team3.ensureOwner({ phone: '0593296933', name: 'Abdulaziz' });
  for (const owner of [a, b, c]) assert.equal(owner.phone_e164, '966593296933');
  s.close(); s2.close(); s3.close();
});

test('addUser and addNever reject a lid id, a device-suffixed jid, letters and an unconvertible local number', () => {
  const { s, team } = teamHarness();
  team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  for (const bad of ['272516946294519@lid', '966500000002:3@s.whatsapp.net', 'abc1234567', '0126543210']) {
    assert.equal(codeOf(() => team.addUser({ name: 'X', phone: bad })), 'bad_phone', bad);
    assert.equal(codeOf(() => team.addNever({ phone: bad })), 'bad_phone', bad);
  }
  s.close();
});

test('names are truncated by code point, stripped of control characters, and whitespace-collapsed', () => {
  const { s, team } = teamHarness();
  const cleaned = team.addUser({ name: 'Sa\u0000ra   Ali\t', phone: '0500000001' });
  assert.equal(cleaned.name, 'Sara Ali');
  const longName = `${'a'.repeat(80)}\u{1F600}`; // 81 code points; the emoji must not be split into a lone surrogate
  const truncated = team.addUser({ name: longName, phone: '0500000002' });
  assert.equal(truncated.name, 'a'.repeat(80));
  assert.equal([...truncated.name].length, 80);
  s.close();
});

test('names are stripped of bidi control characters, not just \\p{Cc} control characters', () => {
  const { s, team } = teamHarness();
  // U+202E (RLO) is category Cf, not Cc, so the old `\p{Cc}`-only strip left it in
  // place; U+200F (RLM) and U+2066 (LRI) are the same story. A name carrying one could
  // repaint everything rendered after it (e.g. the literal "(you)" marker on the Team
  // page) right-to-left, or hide characters a reviewer would otherwise see.
  const rlo = team.addUser({ name: 'Sara‮forcedRTL', phone: '0500000001' });
  assert.equal(rlo.name, 'SaraforcedRTL');
  const marks = team.addUser({ name: '‏Sara‎⁦Ali⁩؜', phone: '0500000002' });
  assert.equal(marks.name, 'SaraAli');
  s.close();
});

test('isExcludedPhone normalises its input and never throws on garbage', () => {
  const { s, team } = teamHarness();
  team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  team.addUser({ name: 'Sara', phone: '0500000001' });
  assert.equal(team.isExcludedPhone('+966 50 000 0001'), true, 'a loosely formatted team number still matches');
  assert.equal(team.isExcludedPhone('not a phone'), false);
  assert.equal(team.isExcludedPhone(''), false);
  assert.equal(team.isExcludedPhone(undefined), false);
  assert.equal(team.isExcludedPhone(null), false);
  assert.equal(team.isExcludedPhone(12345), false);
  s.close();
});

test('setSetting refuses a value outside the allowed set, and sendingEnabled fails closed on anything but \'1\'', () => {
  const { s, team } = teamHarness();
  assert.equal(codeOf(() => team.setSetting('sending_enabled', 'yes')), 'bad_setting_value');
  assert.equal(codeOf(() => team.setSetting('sending_enabled', '2')), 'bad_setting_value');
  s.db.prepare("INSERT OR REPLACE INTO settings (key, value, updated, updated_by) VALUES ('sending_enabled','yes',?,NULL)").run(NOW);
  assert.equal(team.sendingEnabled(), false, "fail closed on anything but exactly '1'");
  s.close();
});

test('reactivateUser runs its write inside a transaction and refuses an unknown id', () => {
  const s = openDb(':memory:');
  let txCalls = 0;
  const originalTransaction = s.transaction;
  const spiedStore = { ...s, transaction: (fn) => { txCalls += 1; return originalTransaction(fn); } };
  const team = createTeam(spiedStore, { now: () => NOW });
  team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const sara = team.addUser({ name: 'Sara', phone: '0500000001' });
  team.deactivateUser(sara.user_id);
  txCalls = 0;
  const reactivated = team.reactivateUser(sara.user_id);
  assert.equal(reactivated.active, 1);
  assert.equal(txCalls, 1, 'reactivateUser wraps its write in a transaction');
  assert.equal(codeOf(() => team.reactivateUser('USR-nope')), 'not_found');
  s.close();
});

test('demoting an owner is refused when the only other owner is inactive', () => {
  const { s, team } = teamHarness();
  const owner = team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const bob = team.addUser({ name: 'Bob', phone: '0500000002', role: 'owner' });
  team.deactivateUser(bob.user_id);
  assert.equal(codeOf(() => team.setRole(owner.user_id, 'staff')), 'last_owner');
  s.close();
});

test('deactivating an already-inactive user is a no-op, not an error', () => {
  const { s, team } = teamHarness();
  team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  const sara = team.addUser({ name: 'Sara', phone: '0500000001' });
  const first = team.deactivateUser(sara.user_id);
  const second = team.deactivateUser(sara.user_id);
  assert.deepEqual(second, first);
  s.close();
});

test('setRole refuses an unknown role', () => {
  const { s, team } = teamHarness();
  const owner = team.ensureOwner({ phone: '966593296933', name: 'Abdulaziz' });
  assert.equal(codeOf(() => team.setRole(owner.user_id, 'admin')), 'bad_role');
  s.close();
});

test('removeNever on a number that was never added returns false, not an error', () => {
  const { s, team } = teamHarness();
  assert.equal(team.removeNever('0511111111'), false);
  s.close();
});

test('learnTeamLid records a phone+lid pairing on the users row, and isTeamLid reads it back', () => {
  const { s, team } = teamHarness();
  const sara = team.addUser({ name: 'Sara', phone: '0500000001' });
  assert.equal(sara.wa_lid, null);
  assert.equal(isTeamLid(s, '272516946294519@lid'), false);

  assert.equal(learnTeamLid(s, '966500000001', '272516946294519@lid'), true);
  assert.equal(team.getUser(sara.user_id).wa_lid, '272516946294519@lid');
  assert.equal(isTeamLid(s, '272516946294519@lid'), true);

  // Learning it again, with the same lid, is a no-op — not an error, not a second write.
  assert.equal(learnTeamLid(s, '0500000001', '272516946294519@lid'), false);
  // A phone that is not on the team touches nothing.
  assert.equal(learnTeamLid(s, '966511111111', '999@lid'), false);
  assert.equal(isTeamLid(s, '999@lid'), false);
  // Garbage input never throws.
  assert.equal(learnTeamLid(s, '', '272516946294519@lid'), false);
  assert.equal(learnTeamLid(s, '966500000001', null), false);
  assert.equal(isTeamLid(s, null), false);
  assert.equal(isTeamLid(s, ''), false);
  s.close();
});

test('learnTeamLid and isTeamLid cache their prepared statements per store, rather than re-preparing on every call', () => {
  const { s, team } = teamHarness();
  team.addUser({ name: 'Sara', phone: '0500000001' });
  let prepares = 0;
  const realPrepare = s.db.prepare.bind(s.db);
  s.db.prepare = (sql) => { prepares += 1; return realPrepare(sql); };

  learnTeamLid(s, '966500000001', '111@lid');
  isTeamLid(s, '111@lid');
  isTeamLid(s, '111@lid');
  learnTeamLid(s, '966500000001', '222@lid');

  assert.equal(prepares, 2, 'one prepare per distinct statement text (the UPDATE, the SELECT), not per call');
  s.db.prepare = realPrepare;
  s.close();
});

test('the audit log records who did what, newest first, and refuses an unknown action', () => {
  const s = openDb(':memory:');
  let clock = NOW;
  const audit = createAudit(s, { now: () => clock });
  audit.record({ userId: 'USR-1', action: 'login' });
  clock += 1000;
  audit.record({ userId: 'USR-1', action: 'team_add', target: 'USR-2', meta: { role: 'staff' } });
  const [latest, first] = audit.recent(10);
  assert.equal(latest.action, 'team_add');
  assert.deepEqual(latest.meta, { role: 'staff' });
  assert.equal(first.action, 'login');
  assert.equal(first.ts, NOW);
  assert.throws(() => audit.record({ userId: 'USR-1', action: 'made_up' }), /unknown audit action/);
  assert.ok(AUDIT_ACTIONS.includes('stage'));
  s.close();
});

test('the audit log accepts the inbox actions, with a target and no text', () => {
  const s = openDb(':memory:');
  const audit = createAudit(s, { now: () => NOW });
  for (const action of ['reply_sent', 'inbox_move', 'inbox_out', 'inbox_add', 'handler']) {
    assert.ok(AUDIT_ACTIONS.includes(action), action);
    audit.record({ userId: 'USR-1', action, target: 'LEAD-1', meta: action === 'handler' ? { to: 'USR-2' } : null });
  }
  const rows = audit.recent(10);
  assert.deepEqual(rows.map((r) => r.action).sort(), ['handler', 'inbox_add', 'inbox_move', 'inbox_out', 'reply_sent']);
  assert.deepEqual(rows.find((r) => r.action === 'handler').meta, { to: 'USR-2' });
  assert.ok(rows.every((r) => r.target === 'LEAD-1'));
  s.close();
});

test('isExcludedLead: a lead is a colleague\'s or a never-list number\'s by its phone, its phone jid or a learned team lid', () => {
  const { s, team } = teamHarness();
  team.addUser({ name: 'Sara', phone: '0500000001', role: 'staff' });
  const gone = team.addUser({ name: 'Old Hand', phone: '0500000002', role: 'staff' });
  team.deactivateUser(gone.user_id);
  team.addNever({ phone: '0500000003' });
  learnTeamLid(s, '966500000001', '272516946294519@lid');
  const lead = (over) => ({ lead_id: 'LEAD-1', phone_e164: null, wa_jid: null, wa_lid: null, ...over });
  assert.equal(isExcludedLead(team, s, lead({ phone_e164: '966500000001' })), true, 'a team number');
  assert.equal(isExcludedLead(team, s, lead({ phone_e164: '966500000002' })), true, 'a deactivated one too');
  assert.equal(isExcludedLead(team, s, lead({ phone_e164: '966500000003' })), true, 'a never-list number');
  assert.equal(isExcludedLead(team, s, lead({ wa_jid: '966500000003:12@s.whatsapp.net' })), true, 'by its phone jid, device suffix and all');
  assert.equal(isExcludedLead(team, s, lead({ wa_lid: '272516946294519@lid' })), true, 'by a lid learned as a colleague\'s');
  assert.equal(isExcludedLead(team, s, lead({ phone_e164: '966500000077', wa_jid: '966500000077@s.whatsapp.net', wa_lid: '111@lid' })), false, 'a client');
  // A lid's digits are an opaque id, never a phone number, even when they spell a colleague's.
  assert.equal(isExcludedLead(team, s, lead({ wa_jid: '966500000001@lid' })), false);
  assert.equal(isExcludedLead(team, s, null), false);
  s.close();
});

test('isExcludedLead reads a jid the way ingest does, and only the identifiers it is handed', () => {
  const { s, team } = teamHarness();
  team.addNever({ phone: '0500000003' });
  const lead = (over) => ({ lead_id: 'LEAD-1', phone_e164: null, wa_jid: null, wa_lid: null, ...over });
  // Ingest (lib/inbox/ingest.mjs) takes a jid's number with lib/wa-poller.mjs `jidsOf`: any
  // jid that is not a lid, a group or a broadcast. The one exclusion rule must agree with it.
  const cases = [
    ['966500000003@s.whatsapp.net', true], ['966500000003:7@s.whatsapp.net', true], ['966500000003@c.us', true],
    ['966500000003@lid', false], ['966500000003@g.us', false], ['966500000003@broadcast', false], ['status@broadcast', false],
    ['966500000077@s.whatsapp.net', false], ['', false],
  ];
  for (const [jid, excluded] of cases) {
    assert.equal(isExcludedLead(team, s, lead({ wa_jid: jid })), excluded, jid);
    assert.equal(team.isExcludedPhone(jidsOf({ jid }).phone), excluded, `jidsOf agrees on ${jid}`);
  }
  // Callers hand in per-identifier views of a lead (ingest checks each number a record
  // names as if the row held it): the stored row is never read back by its id.
  s.insertLead({ lead_id: 'LEAD-1', created: NOW, updated: NOW, channel: 'whatsapp', stage: 'new', phone_e164: '966500000003' });
  assert.equal(isExcludedLead(team, s, lead({ wa_jid: '966500000077@s.whatsapp.net' })), false, 'the row\'s own phone is not looked up');
  assert.equal(isExcludedLead(team, s, s.getLead('LEAD-1')), true);
  s.close();
});

test('deactivating a member deletes their push subscriptions in the same transaction as their sessions (§3.4)', () => {
  const s = openDb(':memory:');
  const team = createTeam(s);
  team.ensureOwner({ phone: '966593296933' });
  const sara = team.addUser({ name: 'Sara', phone: '966500000001' });
  const omar = team.addUser({ name: 'Omar', phone: '966500000002' });
  const ins = s.db.prepare('INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, session_hash, created, updated) VALUES (?,?,?,?,?,?,1,1)');
  ins.run('P1', sara.user_id, 'https://fcm.googleapis.com/fcm/send/1', 'k', 'a', 'h1');
  ins.run('P2', sara.user_id, 'https://web.push.apple.com/2', 'k', 'a', 'h2');
  ins.run('P3', omar.user_id, 'https://fcm.googleapis.com/fcm/send/3', 'k', 'a', 'h3');
  team.deactivateUser(sara.user_id);
  const left = s.db.prepare('SELECT id FROM push_subscriptions ORDER BY id').all().map((r) => r.id);
  assert.deepEqual(left, ['P3']);
  team.reactivateUser(sara.user_id);
  assert.deepEqual(s.db.prepare('SELECT id FROM push_subscriptions ORDER BY id').all().map((r) => r.id), ['P3'], 'reactivating brings no device back');
  s.close();
});

test('dana_enabled: ships off, fails closed, and is a switch like the other two', () => {
  const { s, team } = teamHarness();
  assert.equal(SETTINGS_DEFAULTS.dana_enabled, '0');
  assert.deepEqual(SETTINGS_ALLOWED.dana_enabled, ['0', '1']);
  assert.equal(team.getSetting('dana_enabled'), '0');
  assert.equal(team.danaEnabled(), false);
  assert.equal(team.setSetting('dana_enabled', '1', { by: 'USR-1' }), '1');
  assert.equal(team.danaEnabled(), true);
  assert.equal(s.db.prepare("SELECT updated_by FROM settings WHERE key = 'dana_enabled'").get().updated_by, 'USR-1');
  assert.equal(codeOf(() => team.setSetting('dana_enabled', 'yes')), 'bad_setting_value');
  assert.equal(codeOf(() => team.setSetting('dana_enabled', '')), 'bad_setting_value');
  s.db.prepare("INSERT OR REPLACE INTO settings (key, value, updated, updated_by) VALUES ('dana_enabled','true',?,NULL)").run(NOW);
  assert.equal(team.danaEnabled(), false, 'only the exact string 1 is on');
  assert.equal(team.repliesEnabled(), false, 'the other switches are untouched');
  s.close();
});

test('dana_chat is an audit action', () => {
  const s = openDb(':memory:');
  const audit = createAudit(s, { now: () => NOW });
  audit.record({ userId: 'USR-1', action: 'dana_chat', target: 'LEAD-1', meta: { dana_off: 1 } });
  assert.deepEqual(audit.recent(1).map((r) => [r.action, r.target, r.meta]), [['dana_chat', 'LEAD-1', { dana_off: 1 }]]);
  s.close();
});

test('retell_funds_out / retell_funds_alerted: absent is \'\', only \'\' or a ms timestamp is stored, and the Team page form cannot set them', () => {
  const { s, team } = teamHarness();
  for (const key of ['retell_funds_out', 'retell_funds_alerted']) {
    assert.equal(SETTINGS_DEFAULTS[key], '', `${key} ships empty: fine`);
    assert.equal(team.getSetting(key), '');
    assert.equal(team.setSetting(key, String(NOW)), String(NOW));
    assert.equal(team.setSetting(key, ''), '');
    for (const bad of ['yes', '-1', '1.5', ' 1', '1e12', '12345678901234567', 'NaN']) {
      assert.equal(codeOf(() => team.setSetting(key, bad)), 'bad_setting_value', `${key} = ${bad}`);
    }
  }
  assert.deepEqual(SETTINGS_ALLOWED.dana_enabled, ['0', '1'], 'the switches keep their lists');
  s.close();
});

/* -------------------- the automation switches and markers (PLAN T04, DESIGN §5.1) -------------------- */

const NEW_SWITCHES = {
  own_inbox: ['0', 'ownInboxEnabled'],
  owner_as_client: ['0', 'ownerAsClientEnabled'],
  calendar_booking: ['0', 'calendarBookingEnabled'],
  owner_notes: ['1', 'ownerNotesEnabled'],
  email_replies: ['0', 'emailRepliesEnabled'],
  owner_mail_copy: ['1', 'ownerMailCopyEnabled'],
  dana_brain: ['0', 'danaBrainEnabled'],
};

test('the automation switches ship with their DESIGN §5.1 defaults, and only an exact "1" is on', () => {
  const { s, team } = teamHarness();
  for (const [key, [dflt, accessor]] of Object.entries(NEW_SWITCHES)) {
    assert.equal(SETTINGS_DEFAULTS[key], dflt, `${key} default`);
    assert.deepEqual(SETTINGS_ALLOWED[key], ['0', '1'], `${key} is a switch`);
    assert.equal(team.getSetting(key), dflt, `${key} read before any write`);
    assert.equal(typeof team[accessor], 'function', `${key} has an accessor`);
    assert.equal(team[accessor](), dflt === '1', `${key} accessor follows the default`);
    assert.equal(team.isOn(key), dflt === '1', `${key} isOn follows the default`);
    assert.equal(team.setSetting(key, '1', { by: 'USR-1' }), '1');
    assert.equal(team[accessor](), true);
    assert.equal(s.db.prepare('SELECT updated_by FROM settings WHERE key = ?').get(key).updated_by, 'USR-1');
    assert.equal(team.setSetting(key, '0'), '0');
    assert.equal(team[accessor](), false);
    for (const bad of ['', 'yes', 'on', 'true', '2', ' 1', '1 ']) {
      assert.equal(codeOf(() => team.setSetting(key, bad)), 'bad_setting_value', `${key} = ${JSON.stringify(bad)}`);
    }
    // Old or corrupt data written past setSetting: anything but the exact '1' is off,
    // even for the two switches that ship on.
    for (const corrupt of ['true', 'on', ' 1', '1.0', 'yes']) {
      s.db.prepare('INSERT OR REPLACE INTO settings (key, value, updated, updated_by) VALUES (?,?,?,NULL)').run(key, corrupt, NOW);
      assert.equal(team[accessor](), false, `${key} = ${JSON.stringify(corrupt)} is off`);
      assert.equal(team.isOn(key), false);
    }
  }
  assert.equal(team.isOn('no_such_setting'), false, 'an unknown key is never on');
  assert.equal(team.isOn('brain_out'), false, 'a marker is never a switch');
  s.close();
});

test('the automation switches are independent of each other and of the three switches that exist today', () => {
  const { s, team } = teamHarness();
  const snapshot = () => Object.fromEntries([...Object.keys(NEW_SWITCHES), 'sending_enabled', 'inbox_replies', 'dana_enabled'].map((k) => [k, team.getSetting(k)]));
  const before = snapshot();
  team.setSetting('own_inbox', '1');
  assert.deepEqual(snapshot(), { ...before, own_inbox: '1' });
  team.setSetting('dana_brain', '1');
  assert.deepEqual(snapshot(), { ...before, own_inbox: '1', dana_brain: '1' });
  assert.equal(team.danaEnabled(), false, 'dana_brain does not switch Dana on');
  s.close();
});

test('the instant markers (brain_out, mail_since, mail_from_ok) ship empty and take only \'\' or a ms timestamp', () => {
  const { s, team } = teamHarness();
  for (const key of ['brain_out', 'mail_since', 'mail_from_ok']) {
    assert.equal(SETTINGS_DEFAULTS[key], '', `${key} ships empty`);
    assert.equal(team.getSetting(key), '');
    assert.equal(team.setSetting(key, String(NOW)), String(NOW));
    assert.equal(team.setSetting(key, ''), '');
    for (const bad of ['yes', '-1', '1.5', ' 1', '1e12', '12345678901234567', 'NaN', '2026-11-27']) {
      assert.equal(codeOf(() => team.setSetting(key, bad)), 'bad_setting_value', `${key} = ${bad}`);
    }
  }
  s.close();
});

test('brainOutSince reads the brain_out marker as a ms instant, or null while the AI service is fine', () => {
  const { s, team } = teamHarness();
  assert.equal(team.brainOutSince(), null);
  team.setSetting('brain_out', String(NOW));
  assert.equal(team.brainOutSince(), NOW);
  team.setSetting('brain_out', '0');
  assert.equal(team.brainOutSince(), null, 'zero is not an instant');
  team.setSetting('brain_out', '');
  assert.equal(team.brainOutSince(), null);
  s.db.prepare("INSERT OR REPLACE INTO settings (key, value, updated, updated_by) VALUES ('brain_out','soon',?,NULL)").run(NOW);
  assert.equal(team.brainOutSince(), null, 'corrupt data is no instant');
  s.close();
});

test('brainOutSince is null for a stored value no clock can show: past a safe integer, or past the last date a Date holds', () => {
  const { s, team } = teamHarness();
  // Each fits the write pattern (16 digits at most), so only the read can refuse it; a banner
  // "not answering since — Riyadh time" would otherwise claim an outage from junk.
  for (const junk of ['9999999999999999', '9007199254740993', '8640000000000000', '8639999999999999']) {
    team.setSetting('brain_out', junk);
    assert.equal(team.brainOutSince(), null, junk);
  }
  const late = Date.UTC(9999, 11, 31, 20, 59);
  team.setSetting('brain_out', String(late));
  assert.equal(team.brainOutSince(), late, 'a far but real date is still an instant');
  s.close();
});

test('owner_summary_day takes \'\' or a YYYY-MM-DD day only', () => {
  const { s, team } = teamHarness();
  assert.equal(SETTINGS_DEFAULTS.owner_summary_day, '');
  assert.equal(team.setSetting('owner_summary_day', '2026-11-27'), '2026-11-27');
  assert.equal(team.setSetting('owner_summary_day', ''), '');
  for (const bad of ['2026-13-01', '2026-11-32', '2026-00-10', '26-11-27', '2026-11-27T08:00', String(NOW), '2026/11/27', ' 2026-11-27']) {
    assert.equal(codeOf(() => team.setSetting('owner_summary_day', bad)), 'bad_setting_value', bad);
  }
  s.close();
});

test('brain_usd_day / brain_usd_month take only YYYY-MM-DD:<int> / YYYY-MM:<int> micro-USD counters (or \'\')', () => {
  const { s, team } = teamHarness();
  assert.equal(SETTINGS_DEFAULTS.brain_usd_day, '');
  assert.equal(SETTINGS_DEFAULTS.brain_usd_month, '');
  for (const ok of ['2026-11-27:0', '2026-11-27:1234567', '2026-11-27:300000000', '']) {
    assert.equal(team.setSetting('brain_usd_day', ok), ok, ok);
  }
  for (const ok of ['2026-11:0', '2026-11:20000000', '']) {
    assert.equal(team.setSetting('brain_usd_month', ok), ok, ok);
  }
  const badDay = ['2026-11-27', '2026-11:5', '2026-11-27:', '2026-11-27:-1', '2026-11-27:1.5', '2026-11-27:01', '2026-13-27:5',
    '2026-11-32:5', '2026-11-27:5 ', '2026-11-27:1e9', '2026-11-27:12345678901234567', String(NOW)];
  for (const bad of badDay) assert.equal(codeOf(() => team.setSetting('brain_usd_day', bad)), 'bad_setting_value', `day ${bad}`);
  const badMonth = ['2026-11', '2026-11-27:5', '2026-13:5', '2026-00:5', '2026-11:', '2026-11:-1', '2026-11:1.5', '2026-11:007', '2026-11:5x'];
  for (const bad of badMonth) assert.equal(codeOf(() => team.setSetting('brain_usd_month', bad)), 'bad_setting_value', `month ${bad}`);
  s.close();
});

test('the month-alert markers take \'\' or YYYY-MM with an optional :80 / :100 level', () => {
  const { s, team } = teamHarness();
  for (const key of ['brain_month_alerted', 'dana_month_alerted']) {
    assert.equal(SETTINGS_DEFAULTS[key], '', `${key} ships empty`);
    for (const ok of ['2026-11', '2026-11:80', '2026-11:100', '']) assert.equal(team.setSetting(key, ok), ok, `${key} = ${ok}`);
    for (const bad of ['2026-13', '2026-11:50', '2026-11:', '2026-11-27', String(NOW), 'yes', '2026-11:80,100']) {
      assert.equal(codeOf(() => team.setSetting(key, bad)), 'bad_setting_value', `${key} = ${bad}`);
    }
  }
  s.close();
});

test('mail_cursor is an opaque state string: visible ASCII only, at most 256 characters', () => {
  const { s, team } = teamHarness();
  assert.equal(SETTINGS_DEFAULTS.mail_cursor, '');
  for (const ok of ['', 'sb2k', 'a1B2-c3_d4.e5:f6/g7+h8=', 'x'.repeat(256)]) assert.equal(team.setSetting('mail_cursor', ok), ok);
  for (const bad of ['has space', 'tab\there', 'line\nbreak', 'x'.repeat(257), 'ü']) {
    assert.equal(codeOf(() => team.setSetting('mail_cursor', bad)), 'bad_setting_value', JSON.stringify(bad));
  }
  s.close();
});

test('every setting key has an allowed list or pattern: none accepts any string', () => {
  for (const key of Object.keys(SETTINGS_DEFAULTS)) {
    const allowed = SETTINGS_ALLOWED[key];
    assert.ok(Array.isArray(allowed) || allowed instanceof RegExp, `${key} has no allowed values`);
    const dflt = SETTINGS_DEFAULTS[key];
    assert.ok(Array.isArray(allowed) ? allowed.includes(dflt) : allowed.test(dflt), `${key}'s default is itself allowed`);
  }
});

/* ---------------- PR-A2 (PLAN T07 test 3; DESIGN §3.2): the owner's test override ---------------- */

/**
 * A fake test switch the way lib/owner-test.mjs answers it: `active()` and BONA_OWNER_JID's
 * digits (`ownerDigits()`), and the owner's users-row lid while active (`ownerLid()`).
 */
function fakeOwnerTest(s, { ownerDigits = '966500000010', on = true } = {}) {
  const t = {
    on,
    active() { return this.on; },
    ownerDigits: () => ownerDigits,
    ownerLid() { return this.on ? (s.db.prepare('SELECT wa_lid FROM users WHERE phone_e164 = ?').get(ownerDigits)?.wa_lid ?? null) : null; },
  };
  return t;
}

test("the test override: while the test is active, only BONA_OWNER_JID's digits and his users-row lid stop being excluded", () => {
  const s = openDb(':memory:');
  let t = null;
  // Handed in as a function: index.mjs builds the test switch after the team (it reads the team).
  const team = createTeam(s, { now: () => NOW, ownerTest: () => t });
  team.ensureOwner({ phone: '966500000010', name: 'Owner' });
  team.addUser({ name: 'Second Owner', phone: '966500000011', role: 'owner' });
  team.addUser({ name: 'Colleague', phone: '966500000012', role: 'staff' });
  learnTeamLid(s, '966500000010', '100000000000010@lid');
  learnTeamLid(s, '966500000011', '100000000000011@lid');
  learnTeamLid(s, '966500000012', '100000000000012@lid');
  const lead = (over) => ({ lead_id: 'L-1', phone_e164: null, wa_jid: null, wa_lid: null, ...over });

  const before = () => {
    for (const phone of ['966500000010', '966500000011', '966500000012']) assert.equal(team.isExcludedPhone(phone), true, phone);
    for (const lid of ['100000000000010@lid', '100000000000011@lid', '100000000000012@lid']) {
      assert.equal(isExcludedLead(team, s, lead({ wa_lid: lid })), true, lid);
    }
  };
  before();
  t = fakeOwnerTest(s);
  // Active: the owner's number, phone jid and lid are a client's chat; nobody else's.
  assert.equal(team.isExcludedPhone('966500000010'), false);
  assert.equal(team.isExcludedPhone('+966 50 000 0010'), false, 'normalised like every other number');
  assert.equal(isExcludedLead(team, s, lead({ phone_e164: '966500000010', wa_jid: '966500000010@s.whatsapp.net', wa_lid: '100000000000010@lid' })), false);
  assert.equal(isExcludedLead(team, s, lead({ wa_lid: '100000000000010@lid' })), false, 'his lid alone');
  assert.equal(team.isExcludedPhone('966500000011'), true, 'another owner-role account stays excluded: never role-based');
  assert.equal(team.isExcludedPhone('966500000012'), true, 'the colleague stays excluded');
  assert.equal(isExcludedLead(team, s, lead({ wa_lid: '100000000000011@lid' })), true);
  assert.equal(isExcludedLead(team, s, lead({ wa_lid: '100000000000012@lid' })), true, "the colleague's lid stays excluded");
  // His lid with a colleague's number is still the colleague's chat.
  assert.equal(isExcludedLead(team, s, lead({ phone_e164: '966500000012', wa_lid: '100000000000010@lid' })), true);
  // The never list still wins over the override.
  team.addNever({ phone: '966500000010', note: 'test' });
  assert.equal(team.isExcludedPhone('966500000010'), true, 'a never-list number is never a client, the owner\'s included');
  team.removeNever('966500000010');
  // Off again, and a switch that throws: excluded (fail closed).
  t.on = false;
  before();
  t = { active() { throw new Error('state lost'); }, ownerDigits: () => '966500000010', ownerLid: () => '100000000000010@lid' };
  before();
  // Handed in as the module itself, too.
  const direct = createTeam(s, { now: () => NOW, ownerTest: fakeOwnerTest(s) });
  assert.equal(direct.isExcludedPhone('966500000010'), false);
  assert.equal(direct.isExcludedPhone('966500000011'), true);
  // No test switch handed in: exactly as before.
  const plain = createTeam(s, { now: () => NOW });
  assert.equal(plain.isExcludedPhone('966500000010'), true);
  assert.equal(isExcludedLead(plain, s, lead({ wa_lid: '100000000000010@lid' })), true);
  s.close();
});
