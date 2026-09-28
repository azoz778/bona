/**
 * Which chats the Bona inbox takes (design §4.1): only what is certain joins by itself, a
 * guess waits for the owner, the owner's own messages count only when they carry
 * something that can only be Bona, and nothing a message says ever moves a chat out of
 * `in` or `out`. Pure rules, so every case is a table row.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LISTING_ID_RE, BONA_WORD_RE, SITE_LINK_RE, INBOX_STATES,
  inboundSignal, ownerOutboundJoins, nextInboxState,
} from '../lib/inbox/eligibility.mjs';

/* ---------------- shared patterns ---------------- */

test('the states and patterns are what the store and the poller rely on', () => {
  assert.deepEqual(INBOX_STATES, ['in', 'unsure', 'out']);
  for (const re of [LISTING_ID_RE, BONA_WORD_RE, SITE_LINK_RE]) {
    assert.ok(re instanceof RegExp);
    assert.equal(re.global, false, `${re} has no /g, so .test() never carries a position over`);
    assert.equal(re.sticky, false, `${re} has no /y`);
  }
});

/* ---------------- a client's message ---------------- */

test('a client message is certain on a Ref code, ad context or a listing id', () => {
  for (const [text, hasAdMeta] of [
    ['Hello\nRef BONA-W003 · K7Q2XR', false],
    ['ref bona - k7q2xr', false],
    ['Ref K7Q2X', false],
    ['مرحبا، مهتم بالفيلا\nRef BONA-005: ABCDEF', false],
    ['', true],
    ['Hi, is this still available?', true],
    ['Is BONA-W012 still available?', false],
    ['bona-w012 price?', false],
    ['السلام عليكم، أبغى تفاصيل BONA-005', false],
    ['https://bona-real-estate.com/properties/bona-w003/', false],
  ]) {
    assert.equal(inboundSignal({ text, hasAdMeta }), 'certain', `${JSON.stringify(text)} ad=${hasAdMeta}`);
  }
});

test('the word bona on its own is only a guess', () => {
  for (const text of ['I saw Bona on Instagram', 'BONA', 'bona?', 'بونا', 'شفت إعلان بونا', 'BONA-W0031']) {
    assert.equal(inboundSignal({ text }), 'unsure', text);
  }
});

test('anything else says nothing, and text that is not a string reads as empty', () => {
  for (const text of ['Hello', 'Bonanza', 'kabona', 'Refund 12345', 'السلام عليكم', '']) {
    assert.equal(inboundSignal({ text }), null, JSON.stringify(text));
  }
  assert.equal(inboundSignal({ text: 'Hello', hasAdMeta: false }), null);
  assert.equal(inboundSignal({ text: null }), null);
  assert.equal(inboundSignal({ text: 42 }), null);
  assert.equal(inboundSignal({ text: { toString: () => 'BONA-W003' } }), null, 'never coerced');
  assert.equal(inboundSignal({}), null);
  assert.equal(inboundSignal(), null);
});

/* ---------------- a message the owner sends ---------------- */

test('the owner joins a chat by sending a Bona link or a listing id', () => {
  for (const text of [
    'https://bona-real-estate.com/properties/bona-w003/',
    'bona-real-estate.com',
    'www.bona-real-estate.com/ar/',
    'Have a look: https://www.bona-real-estate.com/villas?utm_source=wa',
    'Visit bona-real-estate.com.',
    'HTTPS://BONA-REAL-ESTATE.COM/EN/',
    'http://bona.azoz.uk/properties/',
    'bona.azoz.uk',
    'تفضل الرابط: https://bona-real-estate.com/ar/properties/',
    'الرابطbona-real-estate.com',
    'Details for BONA-W003 attached',
    'رقم العقار BONA-005',
  ]) {
    assert.equal(ownerOutboundJoins({ text }), true, text);
  }
});

test('lookalike links and plain mentions of bona do not join a chat', () => {
  for (const text of [
    'notbona-real-estate.com',
    'https://notbona-real-estate.com/x',
    'bona-real-estate.company',
    'bona-real-estate.co',
    'bona-realestate.com',
    'mybona.azoz.uk',
    'bona',
    'Bona villa is ready, call me',
    'بونا',
    'BONA-W0031',
    'Hello',
    '',
  ]) {
    assert.equal(ownerOutboundJoins({ text }), false, JSON.stringify(text));
  }
});

test('a document joins when its file name or caption says Bona or a listing id', () => {
  const doc = (fileName, text = null) => ({ text, fileName, media: fileName ? `[document: ${fileName}]` : '[document]' });
  for (const rec of [
    doc('Bona_Villa.pdf'),
    doc('Villa-Bona.pdf'),
    doc('BONA brochure.pdf'),
    doc('BONA-W003.pdf'),
    doc('brochure bona-005 v2.pdf'),
    doc('بونا - فيلا الشاطئ.pdf'),
    doc('villa.pdf', 'Brochure from Bona'),
    doc('villa.pdf', 'بروشور بونا'),
    doc(null, 'bona'),
  ]) {
    assert.equal(ownerOutboundJoins(rec), true, `${rec.fileName} / ${rec.text}`);
  }
  for (const rec of [
    doc('Bonanza.pdf'),
    doc('Kabona_offer.pdf'),
    doc('TK_Villa.pdf', 'here you go'),
    doc(null),
  ]) {
    assert.equal(ownerOutboundJoins(rec), false, `${rec.fileName} / ${rec.text}`);
  }
});

test('the word bona counts only on a document, never on plain text, a photo or a voice note', () => {
  assert.equal(ownerOutboundJoins({ text: 'bona', media: null }), false);
  assert.equal(ownerOutboundJoins({ text: 'bona', media: '[image]' }), false);
  assert.equal(ownerOutboundJoins({ text: 'Bona villa', media: '[voice note]' }), false);
  assert.equal(ownerOutboundJoins({ text: 'bona.azoz.uk/villas', media: '[image]' }), true, 'a link in a caption still counts');
  assert.equal(ownerOutboundJoins({ text: null, fileName: null, media: null }), false);
  assert.equal(ownerOutboundJoins({ text: null, fileName: 'Bona_Villa.pdf', media: '[document: Bona_Villa.pdf]' }), true, 'a document without a caption');
  assert.equal(ownerOutboundJoins({}), false);
  assert.equal(ownerOutboundJoins(), false);
});

/* ---------------- the next state ---------------- */

const SIGNALS = [null, 'unsure', 'certain'];
const METHODS = [null, 'ref', 'phone', 'ad_meta', 'keyword', 'time_window', 'concierge', 'form'];
const OPEN = [null, undefined, 'unsure'];

test('in and out never move on a message, whatever it says', () => {
  for (const current of ['in', 'out']) {
    for (const signal of SIGNALS) {
      for (const method of METHODS) assert.equal(nextInboxState(current, { signal, method }), current, `${current} ${signal} ${method}`);
    }
    assert.equal(nextInboxState(current), current);
  }
  assert.equal(nextInboxState('out', { signal: 'certain', method: 'ref' }), 'out', '"not a client" is never undone by a Ref code');
  assert.equal(nextInboxState('in', { signal: 'unsure', method: 'keyword' }), 'in', 'a guess never demotes a certain chat');
});

test('an undecided or unsure chat becomes in on anything certain, whatever rule matched it', () => {
  for (const current of OPEN) {
    for (const method of METHODS) assert.equal(nextInboxState(current, { signal: 'certain', method }), 'in', `${current} ${method}`);
  }
});

test('a guess — the word, or a keyword or click-window match — makes it unsure', () => {
  for (const current of OPEN) {
    for (const method of METHODS) assert.equal(nextInboxState(current, { signal: 'unsure', method }), 'unsure', `${current} unsure ${method}`);
    for (const method of ['keyword', 'time_window']) assert.equal(nextInboxState(current, { signal: null, method }), 'unsure', `${current} ${method}`);
  }
});

test('with no signal and no guessing rule the state is left as it was', () => {
  for (const method of [null, 'ref', 'phone', 'ad_meta', 'concierge', 'form']) {
    assert.equal(nextInboxState(null, { method }), null, `null ${method}`);
    assert.equal(nextInboxState(undefined, { method }), null, `undefined ${method}`);
    assert.equal(nextInboxState('unsure', { method }), 'unsure', `unsure ${method}`);
  }
  assert.equal(nextInboxState(null), null);
  assert.equal(nextInboxState(undefined), null);
  assert.equal(nextInboxState('unsure'), 'unsure');
});
