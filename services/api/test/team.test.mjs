/**
 * Team accounts: the schema they live in, the people, the never-a-client list, the
 * switches and the audit log. The clock is injected so every timestamp is exact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, SCHEMA_VERSION } from '../lib/db.mjs';

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
