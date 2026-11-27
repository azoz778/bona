/**
 * The own-number rule's one change to the inbox state rules (DESIGN §3.1, PLAN T06 test 10):
 * `nextInboxState(current, { own: true })` puts an undecided or unsure chat `in`, and leaves
 * `in` and `out` where they are. Without `own` (or with anything but `true`) every answer is
 * the old one, so the shared-number rule is byte-identical. inbox-eligibility.test.mjs is not
 * touched (PLAN §1.13); its table runs as it always did.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextInboxState } from '../lib/inbox/eligibility.mjs';

const STATES = [null, undefined, 'unsure', 'in', 'out', 'bogus'];
const SIGNALS = [null, 'certain', 'unsure'];
const METHODS = [null, 'ref', 'phone', 'ad_meta', 'keyword', 'time_window', 'own_number', 'owner_test', 'owner_outbound'];

test('own: an undecided or unsure chat joins, whatever the signal or the method', () => {
  for (const current of [null, undefined, 'unsure', 'bogus']) {
    for (const signal of SIGNALS) {
      for (const method of METHODS) {
        assert.equal(nextInboxState(current, { signal, method, own: true }), 'in', `${current} ${signal} ${method}`);
      }
    }
  }
});

test('own: "out" stays out and "in" stays in (the never list and "Not a client" are absolute)', () => {
  for (const signal of SIGNALS) {
    for (const method of METHODS) {
      assert.equal(nextInboxState('out', { signal, method, own: true }), 'out', `out ${signal} ${method}`);
      assert.equal(nextInboxState('in', { signal, method, own: true }), 'in', `in ${signal} ${method}`);
    }
  }
});

test('without own (absent, false, or not exactly true) the answers are the old ones, row by row', () => {
  // The old rule, written out: `in`/`out` stay; certain → in; unsure or a guessing method → unsure; else as it was.
  const GUESS = new Set(['keyword', 'time_window', 'ad_meta']);
  const old = (current, signal, method) => {
    const cur = ['in', 'unsure', 'out'].includes(current) ? current : null;
    if (cur === 'out' || cur === 'in') return cur;
    if (signal === 'certain') return 'in';
    if (signal === 'unsure' || GUESS.has(method)) return 'unsure';
    return cur;
  };
  for (const current of STATES) {
    for (const signal of SIGNALS) {
      for (const method of METHODS) {
        const want = old(current, signal, method);
        for (const own of [undefined, false, 0, 1, 'true', null]) {
          const o = own === undefined ? { signal, method } : { signal, method, own };
          assert.equal(nextInboxState(current, o), want, `${current} ${signal} ${method} own=${String(own)}`);
        }
      }
    }
  }
  assert.equal(nextInboxState(null), null);
  assert.equal(nextInboxState('unsure', null), 'unsure');
});
