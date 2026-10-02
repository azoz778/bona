/** Shape rules for the optional listing fields faq / seoTitle / projectFacts, and the unit-sheet age rule. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { faqProblems, seoTitleProblems, projectFactsProblems, unitsSheetProblems } from '../scripts/curate/rules.mjs';

const q = (id) => ({ id, q: { en: 'Who builds it?', ar: 'من المطور؟' }, a: { en: ['Darco Real Estate Company.'], ar: ['شركة داركو العقارية.'] } });

test('faq: absent is fine, a good list is fine', () => {
  assert.deepEqual(faqProblems(undefined), []);
  assert.deepEqual(faqProblems([q('developer'), q('handover'), q('sizes')]), []);
});

test('faq: 3–8 items, unique kebab ids, both languages, Arabic really Arabic', () => {
  assert.match(faqProblems([q('a'), q('b')]).join(), /3–8/);
  assert.match(faqProblems([q('a'), q('a'), q('b')]).join(), /duplicate/);
  assert.match(faqProblems([q('Bad Id'), q('b'), q('c')]).join(), /id/);
  const noAr = { ...q('c'), a: { en: ['x'], ar: [] } };
  assert.match(faqProblems([q('a'), q('b'), noAr]).join(), /a\.ar/);
  const latinAr = { ...q('c'), q: { en: 'x', ar: 'not arabic' } };
  assert.match(faqProblems([q('a'), q('b'), latinAr]).join(), /q\.ar/);
});

test('seoTitle: both languages, at most 70 characters', () => {
  assert.deepEqual(seoTitleProblems(undefined), []);
  assert.deepEqual(seoTitleProblems({ en: 'Darco Prime Apartments for Sale', ar: 'شقق داركو برايم للبيع' }), []);
  assert.match(seoTitleProblems({ en: 'x' }).join(), /ar/);
  assert.match(seoTitleProblems({ en: 'x'.repeat(71), ar: 'شقق' }).join(), /70/);
});

test('projectFacts: positive integers only', () => {
  assert.deepEqual(projectFactsProblems(undefined), []);
  assert.deepEqual(projectFactsProblems({ totalUnits: 534, buildings: 22 }), []);
  assert.match(projectFactsProblems({ totalUnits: 0 }).join(), /totalUnits/);
  assert.match(projectFactsProblems({ buildings: 2.5 }).join(), /buildings/);
  assert.match(projectFactsProblems({ floors: 3 }).join(), /unknown/);
});

test('unit sheet warnings: none while fresh, a heads-up from day 76, hidden past 90, bad or future dates', () => {
  const now = new Date('2026-10-02T00:00:00Z');
  assert.deepEqual(unitsSheetProblems({ listingId: 'X', updated: '2026-09-02' }, now), []);
  assert.match(unitsSheetProblems({ listingId: 'X', updated: '2026-07-15' }, now).join(), /79 days old: its prices come off/);
  assert.match(unitsSheetProblems({ listingId: 'X', updated: '2026-06-01' }, now).join(), /123 days old .*hidden/);
  assert.match(unitsSheetProblems({ listingId: 'X', updated: '2026-02-30' }, now).join(), /no real YYYY-MM-DD/);
  assert.match(unitsSheetProblems({ listingId: 'X', updated: '2026-11-01' }, now).join(), /future/);
});

test('faq placeholders must be ones the sheet can fill', () => {
  const ok = { id: 'price', q: { en: 'Price?', ar: 'السعر؟' }, a: { en: ['From SAR {cashFrom}.'], ar: ['من {cashFrom} ريال.'] } };
  assert.deepEqual(faqProblems([q('a'), q('b'), ok]), []);
  const bad = { ...ok, a: { en: ['From SAR {price}.'], ar: ['من {cashFrom} ريال.'] } };
  assert.match(faqProblems([q('a'), q('b'), bad]).join(), /unknown placeholder \{price\}/);
});

test('malformed optional fields come back as problems, never as a crash (Codex review)', () => {
  assert.deepEqual(projectFactsProblems(534), ['projectFacts must be an object']);
  assert.deepEqual(seoTitleProblems('title'), ['seoTitle must be { en, ar }']);
  assert.match(faqProblems([q('a'), q('b'), null]).join(), /faq\[2\] must be an object/);
  const strAnswer = { ...q('c'), a: { en: 'not an array', ar: ['نص'] } };
  assert.match(faqProblems([q('a'), q('b'), strAnswer]).join(), /a\.en must be a non-empty array/);
});

test('placeholders: never in questions, no unbalanced or malformed braces in answers (Codex review)', () => {
  const inQ = { ...q('c'), q: { en: 'Price as of {sheetDate}?', ar: 'السعر؟' } };
  assert.match(faqProblems([q('a'), q('b'), inQ]).join(), /q\.en may not contain/);
  const typo = { ...q('c'), a: { en: ['From SAR {cash-from}.'], ar: ['من ريال.'] } };
  assert.match(faqProblems([q('a'), q('b'), typo]).join(), /unknown placeholder \{cash-from\}/);
  const stray = { ...q('c'), a: { en: ['From SAR {cashFrom.'], ar: ['من ريال.'] } };
  assert.match(faqProblems([q('a'), q('b'), stray]).join(), /unbalanced/);
});

test('an impossible delivery is reported, not rolled over (Codex review)', () => {
  const now = new Date('2026-10-02T00:00:00Z');
  assert.match(unitsSheetProblems({ listingId: 'X', updated: '2026-09-02', delivery: '2028-13' }, now).join(), /impossible delivery/);
  assert.deepEqual(unitsSheetProblems({ listingId: 'X', updated: '2026-09-02', delivery: '2028-06' }, now), []);
});
