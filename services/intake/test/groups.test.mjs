import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedGroups, pollableGroups } from '../lib/groups.mjs';

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
