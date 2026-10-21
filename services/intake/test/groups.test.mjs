import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedGroups, pollableGroups, scanDue, waitingConfigured, NO_GROUP_RESCAN_MS } from '../lib/groups.mjs';

const announced = (jid) => jid === '120363135705763548@g.us';

test('a configured, already-announced group is polled before discovery succeeds', () => {
  const out = seedGroups(['120363135705763548@g.us'], announced);
  assert.deepEqual(out, [{ id: '120363135705763548@g.us', subject: '(configured)', owner: null, seeded: true }]);
});

test('a configured group that was never announced waits for discovery (history must be marked first)', () => {
  assert.deepEqual(seedGroups(['999@g.us'], announced), []);
});

test('non-group jids, duplicates and junk are ignored', () => {
  const out = seedGroups(['120363135705763548@g.us', '120363135705763548@g.us', '966593296933@s.whatsapp.net', 42, ''], announced);
  assert.equal(out.length, 1);
});

test('an empty or missing configuration seeds nothing', () => {
  assert.deepEqual(seedGroups([], announced), []);
  assert.deepEqual(seedGroups(undefined, announced), []);
});

test('a selected group whose history could not be seeded is not polled', () => {
  const selected = [{ id: '120363135705763548@g.us', subject: 'PDF' }, { id: '999@g.us', subject: 'Bona new' }];
  assert.deepEqual(pollableGroups(selected, announced).map((g) => g.id), ['120363135705763548@g.us']);
  assert.deepEqual(pollableGroups(undefined, announced), []);
});

test('discovery off + a configured group pollable: one discovery per run, then never', () => {
  const t = 1e12;
  // first loop after a restart: the subject-matched groups are only found by a discovery
  assert.equal(scanDue({ now: t, lastScan: 0, scanMs: 0, pollable: 1 }), true);
  // that discovery failed (throttled): retried slowly, never every poll
  assert.equal(scanDue({ now: t + 60000, lastScan: t, scanMs: 0, pollable: 1 }), false);
  assert.equal(scanDue({ now: t + NO_GROUP_RESCAN_MS, lastScan: t, scanMs: 0, pollable: 1 }), true);
  // it succeeded: off for the rest of the run
  assert.equal(scanDue({ now: t + 365 * 864e5, lastScan: t, scanMs: 0, pollable: 1, discovered: true }), false);
});

test('discovery off + nothing pollable: scans once, then only every NO_GROUP_RESCAN_MS', () => {
  const t = 1e12;
  assert.equal(scanDue({ now: t, lastScan: 0, scanMs: 0, pollable: 0 }), true);
  assert.equal(scanDue({ now: t + NO_GROUP_RESCAN_MS - 1, lastScan: t, scanMs: 0, pollable: 0 }), false);
  assert.equal(scanDue({ now: t + NO_GROUP_RESCAN_MS, lastScan: t, scanMs: 0, pollable: 0 }), true);
  assert.ok(NO_GROUP_RESCAN_MS >= 30 * 60 * 1000);
});

test('an explicit cadence keeps the old behaviour (first loop scans, then every scanMs)', () => {
  const t = 1e12;
  assert.equal(scanDue({ now: t, lastScan: 0, scanMs: 300000, pollable: 1 }), true);
  assert.equal(scanDue({ now: t + 299999, lastScan: t, scanMs: 300000, pollable: 1 }), false);
  assert.equal(scanDue({ now: t + 300000, lastScan: t, scanMs: 300000, pollable: 1 }), true);
});

test('discovery off: a second configured group still waiting keeps the slow rescan alive', () => {
  const t = 1e12;
  const waiting = waitingConfigured(['120363135705763548@g.us', '999@g.us'], [{ id: '120363135705763548@g.us' }]);
  assert.equal(waiting, 1);
  assert.equal(scanDue({ now: t, lastScan: 0, scanMs: 0, pollable: 1, waiting, discovered: true }), true);
  assert.equal(scanDue({ now: t + 60000, lastScan: t, scanMs: 0, pollable: 1, waiting, discovered: true }), false);
  assert.equal(scanDue({ now: t + NO_GROUP_RESCAN_MS, lastScan: t, scanMs: 0, pollable: 1, waiting, discovered: true }), true);
});

test('waitingConfigured ignores non-group jids, duplicates and groups already polled', () => {
  assert.equal(waitingConfigured(['120363135705763548@g.us', '120363135705763548@g.us', '966593296933@s.whatsapp.net', 42], []), 1);
  assert.equal(waitingConfigured(['120363135705763548@g.us'], [{ id: '120363135705763548@g.us' }]), 0);
  assert.equal(waitingConfigured(undefined, undefined), 0);
});
