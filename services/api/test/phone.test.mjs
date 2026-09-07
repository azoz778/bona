import test from 'node:test';
import assert from 'node:assert/strict';
import { westernDigits, normalisePhone } from '../lib/phone.mjs';

test('Arabic-Indic and Persian digits become Western digits, everything else is untouched', () => {
  assert.equal(westernDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789');
  assert.equal(westernDigits('۰۱۲۳۴۵۶۷۸۹'), '0123456789');
  assert.equal(westernDigits('+966 ٥٩ 329'), '+966 59 329');
  assert.equal(westernDigits(''), '');
  assert.equal(westernDigits(null), '');
});

test('every spelling of a Saudi mobile lands on the same 12 digits', () => {
  for (const raw of ['+966 59 329 6933', '0593296933', '593296933', '٠٥٩٣٢٩٦٩٣٣', '00966593296933', '966593296933', '+966-59-329-6933', '(059) 329 6933']) {
    assert.equal(normalisePhone(raw), '966593296933', raw);
  }
});

test('other countries keep their digits, without the plus or the 00', () => {
  assert.equal(normalisePhone('+971501234567'), '971501234567');
  assert.equal(normalisePhone('00971501234567'), '971501234567');
  assert.equal(normalisePhone('+44 20 7946 0958'), '442079460958');
});

test('a number that cannot be a phone is null, never a guess', () => {
  assert.equal(normalisePhone('12'), null);
  assert.equal(normalisePhone(''), null);
  assert.equal(normalisePhone('abc'), null);
  assert.equal(normalisePhone(null), null);
  assert.equal(normalisePhone(undefined), null);
  assert.equal(normalisePhone('1'.repeat(16)), null, 'E.164 tops out at 15 digits');
  assert.equal(normalisePhone('1'.repeat(15)), '1'.repeat(15));
  assert.equal(normalisePhone('12345678'), '12345678', 'eight digits is the floor');
});
