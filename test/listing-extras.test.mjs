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

test('unit sheet: fails past 90 days, and with a bad date', () => {
  const now = new Date('2026-10-02T00:00:00Z');
  assert.deepEqual(unitsSheetProblems({ updated: '2026-09-02', units: [{}] }, now), []);
  assert.match(unitsSheetProblems({ updated: '2026-06-01', units: [{}] }, now).join(), /123 days/);
  assert.match(unitsSheetProblems({ updated: 'soon', units: [{}] }, now).join(), /updated/);
});
