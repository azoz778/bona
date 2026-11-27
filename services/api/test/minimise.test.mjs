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


/* Codex r2 P0: a separator or a digit form the masks did not know split one number into short groups. */
const DASHES = ['\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2015', '\u2212', '\uFE58', '\uFE63', '\uFF0D', '\u00AD'];
const SPACES = ['\u00A0', '\u202F', '\u2002', '\u2007', '\u2009', '\u205F', '\u3000', '\u1680'];
const INVISIBLE = ['\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF', '\u200E', '\u200F', '\u061C'];
const hex = (s) => [...s].map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');

test('every Unicode dash, hyphen or minus between digit groups joins them: a phone, an IBAN and an ID are masked', () => {
  for (const d of DASHES) {
    assert.equal(minimise(`call 050${d}000${d}0000 please`), 'call [phone] please', hex(d));
    assert.equal(minimise(`call 050 ${d} 000 0000`), 'call [phone]', `spaced ${hex(d)}`);
    assert.equal(minimise(`+966${d}50${d}000${d}0000`), '[phone]', hex(d));
    assert.equal(minimise(`IBAN SA12${d}3456${d}7890${d}1234${d}5678${d}9012 thanks`), 'IBAN [iban] thanks', hex(d));
    assert.equal(minimise(`هويتي 1000${d}000${d}001`), 'هويتي [id-number]', hex(d));
  }
});

test('every Unicode space separator between digit groups joins them: a phone, an IBAN and an ID are masked', () => {
  for (const sp of SPACES) {
    assert.equal(minimise(`call 050${sp}000${sp}0000 please`), 'call [phone] please', hex(sp));
    assert.equal(minimise(`+966${sp}50${sp}000${sp}0000`), '[phone]', hex(sp));
    assert.equal(minimise(`IBAN SA12${sp}3456${sp}7890${sp}1234${sp}5678${sp}9012 thanks`), 'IBAN [iban] thanks', hex(sp));
    assert.equal(minimise(`iqama 2${sp}000${sp}000${sp}001`), 'iqama [id-number]', hex(sp));
  }
});

test('zero-width and direction marks inside or around a number never split it: a phone, an IBAN, an ID and an email are masked', () => {
  for (const z of INVISIBLE) {
    assert.equal(minimise(`call 0500${z}000000 please`), 'call [phone] please', `inside ${hex(z)}`);
    assert.equal(minimise(`call 050${z} ${z}000${z}-${z}0000 please`), 'call [phone] please', `padding a gap ${hex(z)}`);
    assert.equal(minimise(`IBAN SA12${z}3456${z} ${z}7890 1234 5678 9012 thanks`), 'IBAN [iban] thanks', hex(z));
    assert.equal(minimise(`iqama 1000${z}000${z}001`), 'iqama [id-number]', hex(z));
    assert.equal(minimise(`mail na${z}me@example.com`), 'mail [email]', hex(z));
  }
  // Marks that wrap a number stay as written around the mask.
  assert.equal(minimise('\u202A+966 50 000 0000\u202C'), '\u202A[phone]\u202C');
  assert.equal(minimise('\u2066050 000 0000\u2069'), '\u2066[phone]\u2069');
});

test('every decimal digit form (Arabic-Indic, Persian, fullwidth, Devanagari, mathematical) becomes ASCII, so the masks see the number', () => {
  const ar = (s) => s.replace(/\d/g, (d) => String.fromCodePoint(0x0660 + Number(d)));
  const fa = (s) => s.replace(/\d/g, (d) => String.fromCodePoint(0x06F0 + Number(d)));
  const fw = (s) => s.replace(/\d/g, (d) => String.fromCodePoint(0xFF10 + Number(d)));
  const dev = (s) => s.replace(/\d/g, (d) => String.fromCodePoint(0x0966 + Number(d)));
  const math = (s) => s.replace(/\d/g, (d) => String.fromCodePoint(0x1D7CE + Number(d)));
  for (const [input, want] of [
    [ar('050\u2011000\u20110000'), '[phone]'],
    [fa('050 000 0000'), '[phone]'],
    [fw('050\uFF0D000\uFF0D0000'), '[phone]'],
    [dev('0500000000'), '[phone]'],
    [math('050 000 0000'), '[phone]'],
    [`\uFF0B${fw('966 50 000 0000')}`, '[phone]'],
    [`\uFF08${fw('050')}\uFF09 ${fw('000 0000')}`, '[phone]'],
    [`SA${ar('12\u20113456\u20117890\u20111234\u20115678\u20119012')}`, '[iban]'],
    [`id ${fa('1000000001')}`, 'id [id-number]'],
    [`card ${fw('1111 2222 3333 4444')}`, 'card [account-number]'],
  ]) assert.equal(minimise(input), want, hex(input));
  assert.equal(minimise(`unit ${fw('7')}, ${math('3')} rooms, ${dev('12')} m`), 'unit 7, 3 rooms, 12 m', 'a short number is only made ASCII');
});

test('text that is not a number stays exactly as written, whatever its dashes and spaces (only digits become ASCII)', () => {
  for (const s of ['10:00\u201319:00', 'BONA\u2011W012', 'from 29\u201311\u20132026 to 3\u201312\u20132026', '29\u201311\u20132026 10:30', 'SAR\u00A02,950,000',
    'B08\u201119', '3\u00A0\u2013\u00A04 bedrooms', 'Sun\u202F29\u202FNov\u202F2026', 'السعر\u200F 2,950,000 ريال']) {
    assert.equal(minimise(s), s, hex(s));
  }
});

test('a budget range of two thousand-grouped amounts on a dash or a slash stays as written; a 12+ digit run never passes as one', () => {
  for (const s of ['2.950.000 - 3.100.000', 'budget 2950000 / 3100000', '2 950 000 - 3 100 000', '2.950.000/3.100.000', 'SAR 2.950.000 \u2013 3.100.000',
    '2950000 - 3.100.000', 'budget 950.000 - 1.200.000 riyals', 'budget 2950000-3100000']) {
    assert.equal(minimise(s), s, s);
  }
  for (const [input, want] of [
    ['123456789012 - 1000', '[account-number]'],
    ['123.456.789.012 - 3.100.000', '[account-number]'],
    ['1111 2222 3333 - 4444', '[account-number]'],
    ['account 1234567890123 / 5000', 'account [account-number]'],
    ['2.950.000 - 3.100.000 - 4.000.000', '[account-number]'],
    ['2950 / 500000000', '2950 / [phone]'],
  ]) assert.equal(minimise(input), want, input);
});
