/**
 * PR-BR (PLAN T25; brain/DESIGN-brain.md §11.2): data minimisation before any provider call.
 * Phone shapes, Saudi ID/Iqama numbers, IBANs and email addresses are masked after the digits
 * and the separators inside digit groups are normalised; prices, areas, listing ids and years
 * are left alone. Every number here is an example (+966 50 000 0000 style), never a real one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { minimise } from '../lib/brain/minimise.mjs';

test('phone shapes are masked after Arabic-Indic digits and the separators inside digit groups are normalised', () => {
  for (const [input, want] of [
    ['٠٥٠ ٠٠٠ ٠٠٠٠', '[phone]'],
    ['+966 50 000 0000', '[phone]'],
    ['050-000-0000', '[phone]'],
    ['00966500000000', '[phone]'],
    ['966500000000', '[phone]'],
    ['0500000000', '[phone]'],
    ['50 000 0000', '[phone]'],
    ['(050) 000.0000', '[phone]'],
    ['050 000 0000', '[phone]'],
    ['+44 20 0000 0000', '[phone]'],
    ['my number is 050 000 0000, call me', 'my number is [phone], call me'],
    ['رقمي ٠٥٠٠٠٠٠٠٠٠ اتصل علي', 'رقمي [phone] اتصل علي'],
    ['budget 2,950,000 and 0500000000', 'budget 2,950,000 and [phone]'],
  ]) assert.equal(minimise(input), want, input);
});

test('a Saudi ID/Iqama number, an IBAN (with or without spaces) and an email address are masked', () => {
  assert.equal(minimise('هويتي 1000000001'), 'هويتي [id-number]');
  assert.equal(minimise('iqama 2 000 000 001'), 'iqama [id-number]');
  assert.equal(minimise('IBAN SA00 0000 0000 0000 0000 0000 please'), 'IBAN [iban] please');
  assert.equal(minimise(`SA${'0'.repeat(22)}`), '[iban]');
  assert.equal(minimise('write to name@example.com or sara.k+1@mail.example.com'), 'write to [email] or [email]');
});

test('prices, areas, listing and unit ids, years and times are untouched (only the digits become ASCII)', () => {
  for (const s of ['SAR 2,950,000', '3.5 مليون', '12,500 m²', 'BONA-W012', 'BONA-014', '2026', 'B08-19', '10:00–19:00', 'from SAR 995,000',
    'plot of 1,200 sqm', '4 bedrooms, 3 baths', 'Sun 29 Nov 2026']) {
    assert.equal(minimise(s), s, s);
  }
  assert.equal(minimise('٣٫٥ مليون'), '3.5 مليون', 'Arabic-Indic digits become ASCII; the value is kept');
  assert.equal(minimise('٢٬٩٥٠٬٠٠٠ ريال'), '2,950,000 ريال');
});

test('names stay (booking needs them); anything that is not a string is the empty string', () => {
  assert.equal(minimise('I am Sara Example from Jeddah'), 'I am Sara Example from Jeddah');
  for (const v of [null, undefined, 42, {}, []]) assert.equal(minimise(v), '');
});
