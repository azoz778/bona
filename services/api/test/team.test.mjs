/**
 * Team accounts: the schema they live in, the people, the never-a-client list, the
 * switches and the audit log. The clock is injected so every timestamp is exact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, SCHEMA_VERSION } from '../lib/db.mjs';
import { createTeam, TeamError } from '../lib/team.mjs';
import { createAudit, AUDIT_ACTIONS } from '../lib/audit.mjs';

const NOW = 1_790_500_000_000;

test('schema v3 adds the team tables and a user on every session', () => {
  const s = openDb(':memory:');
  assert.equal(SCHEMA_VERSION, 3);
  assert.equal(s.db.prepare('PRAGMA user_version').get().user_version, 3);
  const tables = new Set(s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  for (const name of ['users', 'auth_challenges', 'audit_log', 'never_list', 'settings']) assert.ok(tables.has(name), name);
  const cols = s.db.prepare('PRAGMA table_info(auth_sessions)').all().map((c) => c.name);
  assert.ok(cols.includes('user_id'));
  s.createAuthSession('tok_one', { now: NOW, ttlMs: 1000, ua: 'UA', userId: 'USR-1' });
  assert.equal(s.checkAuthSession('tok_one', { now: NOW }).user_id, 'USR-1');
  s.close();
});

function teamHarness() {
  const s = openDb(':memory:');
  let clock = NOW;
  const team = createTeam(s, { now: () => clock });
  return { s, team, tick: (ms) => { clock += ms; } };
}
const codeOf = (fn) => { try { fn(); } catch (err) { return err instanceof TeamError ? err.code : `not a TeamError: ${err}`; } return null; };

test('ensureOwner seeds the owner once and hands him the sessions from before accounts existed', () => {
  const { s, team } = teamHarness();
  s.createAuthSession('tok_old', { now: NOW, ttlMs: 1000 });
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
  assert.equal(codeOf(() => team.setSetting('dana_enabled', '1')), 'bad_setting', 'Phase 4 adds that key');
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
