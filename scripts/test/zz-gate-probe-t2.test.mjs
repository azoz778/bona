// Throwaway gate test T2 (2026-11-25): fails on purpose so `ci` is red. Must never reach main.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('gate probe T2 fails on purpose', () => {
  assert.equal(1, 2, 'deliberate failure: auto-merge must wait for a red ci');
});
