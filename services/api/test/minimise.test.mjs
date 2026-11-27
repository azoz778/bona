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

test('every realistic Saudi IBAN form is masked: SA + 22 digits with any spaces, dashes, dots or slashes between groups, any case, Arabic-Indic digits', () => {
  const run = '1234567890123456789012'; // 22 example digits, never a real account
  for (const [input, want] of [
    [`SA ${run}`, '[iban]'], // the Codex case: "SA", a space, then all 22 digits as one run
    [`SA${run}`, '[iban]'],
    [`sa${run}`, '[iban]'],
    ['sa12 3456 7890 1234 5678 9012', '[iban]'],
    ['SA 12 3456 7890 1234 5678 9012', '[iban]'],
    ['SA12-3456-7890-1234-5678-9012', '[iban]'],
    ['SA12.3456.7890.1234.5678.9012', '[iban]'],
    ['SA12/3456/7890/1234/5678/9012', '[iban]'],
    ['SA1234 5678 9012 3456 7890 12', '[iban]'],
    ['SA 1234 - 5678 - 9012 - 3456 - 7890 - 12', '[iban]'],
    ['SA١٢ ٣٤٥٦ ٧٨٩٠ ١٢٣٤ ٥٦٧٨ ٩٠١٢', '[iban]'],
    [`الآيبان SA ${run} شكراً`, 'الآيبان [iban] شكراً'],
    [`IBAN:SA${run}.`, 'IBAN:[iban].'],
  ]) assert.equal(minimise(input), want, input);
});

test('any long digit run that could be an account or card number (12+ digits, joined or not) is masked; a price range is not', () => {
  for (const [input, want] of [
    ['1234567890123456789012', '[account-number]'], // an IBAN without its "SA"
    ['account 1234567890123', 'account [account-number]'],
    ['حسابي ١٢٣٤٥٦٧٨٩٠١٢٣٤ بالراجحي', 'حسابي [account-number] بالراجحي'],
    ['card 1111 2222 3333 4444 thanks', 'card [account-number] thanks'],
    ['VISA 1111-2222-3333-4444', 'VISA [account-number]'],
    ['6080 1016 7519 1234 5678 90', '[account-number]'],
  ]) assert.equal(minimise(input), want, input);
  // A phone or ID shape at the start of a run is masked as that, the rest of the run on its own: no digit is left.
  for (const s of ['12 3456 7890 1234 5678 9012', '0512 3456 78 9012 3456 7890']) assert.doesNotMatch(minimise(s), /\d/, s);
  assert.equal(minimise('call 0500000000 12 bedrooms'), 'call [phone] 12 bedrooms', 'a phone then a count: the count stays');
  for (const s of ['budget 2950000-3100000', 'from 2,950,000 to 31,000,000', 'SAR 12 500 000', 'ref 12345678901', '1,234,567,890,123 riyals']) {
    assert.equal(minimise(s), s, s);
  }
});

test('phone digit groups separated by "/" or "_" are joined when the joined run has a phone shape; a slash date or a fraction is not', () => {
  for (const [input, want] of [
    ['055/123/4567', '[phone]'],
    ['+966/55/123/4567', '[phone]'],
    ['055_123_4567', '[phone]'],
    ['call 050 / 000 / 0000 please', 'call [phone] please'],
    ['٠٥٥/١٢٣/٤٥٦٧', '[phone]'],
  ]) assert.equal(minimise(input), want, input);
  for (const s of ['29/11/2026 10:30', '2026/11/29 9:00', 'from 29/11/2026 to 3/12/2026', '2026/2027 12 units', '3/4 bedrooms', 'unit_12_3']) {
    assert.equal(minimise(s), s, s);
  }
});

test('prices, areas, listing and unit ids, years and times are untouched (only the digits become ASCII)', () => {
  for (const s of ['SAR 2,950,000', '3.5 مليون', '12,500 m²', 'BONA-W012', 'BONA-014', '2026', 'B08-19', '10:00–19:00', 'from SAR 995,000',
    'plot of 1,200 sqm', '4 bedrooms, 3 baths', 'Sun 29 Nov 2026']) {
    assert.equal(minimise(s), s, s);
  }
  assert.equal(minimise('٣٫٥ مليون'), '3.5 مليون', 'Arabic-Indic digits become ASCII; the value is kept');
  assert.equal(minimise('٢٬٩٥٠٬٠٠٠ ريال'), '2,950,000 ريال');
});

test('a date is never joined into an ID or a phone (a date plus a time stays as written); a phone next to it is still masked', () => {
  for (const s of ['2026-11-29 10:30', '29-11-2026 10:30', '29.11.2026 10:30', '2026.11.29 9:00', 'from 2026-11-29 to 2026-12-03']) assert.equal(minimise(s), s, s);
  assert.equal(minimise('2026-11-29 0500000000'), '2026-11-29 [phone]');
  assert.equal(minimise('on 29-11-2026 call 050 000 0000'), 'on 29-11-2026 call [phone]');
});

test('a phone glued to a comma is masked: only a group that can be part of a comma price (3 digits after a comma, 1-3 before one) counts as one', () => {
  for (const [input, want] of [
    ['0500000000,0500000001', '[phone],[phone]'],
    ['my number 0500000000,3 bedrooms', 'my number [phone],3 bedrooms'],
    ['+966500000000,2', '[phone],2'],
    ['+966 500 000 000,2', '[phone],2'],
    ['1000000000,2', '[id-number],2'],
    ['budget 2,950,000 and 0500000000,thanks', 'budget 2,950,000 and [phone],thanks'],
  ]) assert.equal(minimise(input), want, input);
  for (const s of ['from 1,500,000 to 2,950,000', 'SAR 12,500,000', '1,234,567,890 riyals']) assert.equal(minimise(s), s, s);
});

test('names stay (booking needs them); anything that is not a string is the empty string', () => {
  assert.equal(minimise('I am Sara Example from Jeddah'), 'I am Sara Example from Jeddah');
  for (const v of [null, undefined, 42, {}, []]) assert.equal(minimise(v), '');
});
