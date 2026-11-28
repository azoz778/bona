/**
 * The code stop-word check (DESIGN §4.1 "It does not rest on the model alone", critic round 2 #7;
 * DESIGN §9.2 step 12; PLAN T12 test 7b). Pure: no model, no store.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchStopWords, normalise, STOP_PHRASES, STOP_WORDS, DATA_PHRASES, PERSON_PHRASES, BARE_STOP_MAX_WORDS } from '../lib/stop-words.mjs';

test('stop words: normalising folds alef/hamza forms, taa marbuta, alef maqsura, tatweel, marks and case', () => {
  assert.equal(normalise('إيقاف'), 'ايقاف');
  assert.equal(normalise('أآإٱا'), 'ااااا');
  assert.equal(normalise('سياسة الخصوصية'), 'سياسه الخصوصيه');
  assert.equal(normalise('عليّ'), 'علي');
  assert.equal(normalise('الـــرد'), 'الرد');
  assert.equal(normalise('عَلى'), 'علي');
  assert.equal(normalise('  STOP  Replying '), 'stop replying');
  assert.equal(normalise(null), '');
});

test('stop words: the table (DESIGN §4.1), each list with its kind', () => {
  const cases = [
    // [text, expected kind or null]
    ['إيقاف', 'stop'],
    ['stop', 'stop'],
    ['Stop!', 'stop'],
    // T12 r1: the bare «وقف» / «توقف» are real-estate words; only their phrase forms stop.
    ['وقف', null],
    ['الأرض وقف؟', null],
    ['توقف المشروع؟', null],
    ['متى توقف البناء', null],
    ['توقف لو سمحت', null],
    ['وقف الرد', 'stop'],
    ['وقف الرد لو سمحت', 'stop'],
    ['كفى', 'stop'],
    ['please stop replying to me', 'stop'],
    ['stop messaging me, I found a house', 'stop'],
    ["don't message me again", 'stop'],
    ['do not contact me', 'stop'],
    ['unsubscribe', 'stop'],
    ['لا ترد عليّ', 'stop'],
    ['لا تراسل هذا الرقم', 'stop'],
    ['توقف عن الرد', 'stop'],
    ['لا تتواصل معي', 'stop'],
    ['احذف بياناتي', 'deletion'],
    ['delete my data please', 'deletion'],
    ['remove my data', 'deletion'],
    ['erase my data', 'deletion'],
    ['delete my number', 'deletion'],
    ['امسح بياناتي', 'deletion'],
    ['حذف بياناتي', 'deletion'],
    ['احذفوا رقمي', 'deletion'],
    ['سياسة الخصوصية', 'privacy'],
    ['what is your privacy policy?', 'privacy'],
    ['what do you do with my personal data', 'privacy'],
    ['PDPL', 'privacy'],
    ['my data', 'privacy'],
    ['بياناتي الشخصية وين تروح؟', 'privacy'],
    ['معلوماتي الشخصية', 'privacy'],
    ['حماية البيانات', 'privacy'],
    ['خصوصيتي مهمة', 'privacy'],
    // Everyday enquiry text: never a match (DESIGN §4.1 "NOT the bare words …").
    ['does the bus stop near the villa?', null],
    ['هل يوجد موقف سيارات خاص بالفيلا؟', null],
    ['is it privately owned?', null],
    ['أبي فيلا فيها خصوصية', null],
    ['هذه بياناتي: محمد، ميزانيتي 3 مليون', null],
    ['this is my number, call me', null],
    ['privacy', null],
    ['خصوصية', null],
    ['بياناتي', null],
    ['رقمي', null],
    ['my number', null],
    ['nonstop flights to Jeddah?', null],
    ['stopover', null],
    ['', null],
  ];
  for (const [text, kind] of cases) {
    const m = matchStopWords(text);
    assert.equal(m?.kind ?? null, kind, `"${text}"`);
  }
});

test('stop words: a bare stop word counts only in a message of at most 4 words; a phrase anywhere', () => {
  assert.equal(BARE_STOP_MAX_WORDS, 4);
  assert.equal(matchStopWords('ok stop it now')?.kind, 'stop', '4 words');
  assert.equal(matchStopWords('ok stop it now please'), null, '5 words');
  assert.equal(matchStopWords('ok so the price looks fine but please stop replying here')?.kind, 'stop', 'a phrase in a long message');
  assert.equal(matchStopWords('long text about villas and gardens and pools and then delete my data at the end')?.kind, 'deletion');
});

test('stop words: the person list is for email only (DESIGN §9.2): off unless asked', () => {
  assert.equal(matchStopWords('can I speak to a person'), null);
  assert.equal(matchStopWords('this is my number, call me'), null);
  assert.equal(matchStopWords('can I speak to a person', { person: true })?.kind, 'person');
  assert.equal(matchStopWords('اتصل بي', { person: true })?.kind, 'person');
  assert.equal(matchStopWords('أكلم شخص', { person: true })?.kind, 'person');
  assert.equal(matchStopWords('شخص', { person: true }), null, 'never the bare word');
  assert.equal(matchStopWords('agent', { person: true }), null, 'never the bare word');
  assert.equal(matchStopWords('stop', { person: true })?.kind, 'stop', 'stop and data still win');
});

test('stop words: the lists are frozen and each entry matches itself', () => {
  for (const list of [STOP_PHRASES, STOP_WORDS, DATA_PHRASES, PERSON_PHRASES]) {
    assert.equal(Object.isFrozen(list), true);
    assert.ok(list.length > 0);
  }
  for (const p of STOP_PHRASES) assert.equal(matchStopWords(p)?.kind, 'stop', p);
  for (const w of STOP_WORDS) assert.equal(matchStopWords(w)?.kind, 'stop', w);
  for (const p of DATA_PHRASES) assert.ok(['privacy', 'deletion'].includes(matchStopWords(p)?.kind), p);
  for (const p of PERSON_PHRASES) assert.equal(matchStopWords(p, { person: true })?.kind, 'person', p);
});
