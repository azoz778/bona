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
import { normaliseRecord } from '../lib/evolution.mjs';

/* ---------------- shared patterns ---------------- */

test('the states and patterns are what the store and the poller rely on', () => {
  assert.deepEqual(INBOX_STATES, ['in', 'unsure', 'out']);
  for (const re of [LISTING_ID_RE, BONA_WORD_RE, SITE_LINK_RE]) {
    assert.ok(re instanceof RegExp);
    assert.equal(re.global, false, `${re} has no /g, so .test() never carries a position over`);
    assert.equal(re.sticky, false, `${re} has no /y`);
  }
  // The bounds are \p{…} classes, which mean something only with /u: rebuilt from `.source`
  // with 'i' alone, [\p{L}\p{M}] is a set of literal characters and كوبونات matches again.
  for (const re of [BONA_WORD_RE, SITE_LINK_RE]) assert.equal(re.unicode, true, `${re} needs /u`);
});

/* ---------------- a client's message ---------------- */

test('a client message is certain on a Ref code, ad context or a listing id', () => {
  for (const [text, hasAdMeta] of [
    ['Hello\nRef BONA-W003 · K7Q2XR', false],
    ['ref bona - k7q2xr', false],
    ['Ref BONA · K7Q2XR', false],
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

test('a Ref line in the site\'s own shape is certain; a bare code only when the poller knows it', () => {
  // The site always writes the listing part (`Ref BONA · K7Q2XR` on a page without one);
  // a bare code is a client retyping it, or plain English that happens to have the shape.
  assert.equal(inboundSignal({ text: 'Ref K7Q2X', refKnown: true }), 'certain', 'a code a site session holds');
  for (const text of [
    'Ref K7Q2X',
    'Can you send me the ref number?',
    'ref please',
    'Ref check done',
    'what is the ref 23456',
    'Ref thanks',
    'TK booking Ref ABCDEF',
  ]) {
    assert.equal(inboundSignal({ text }), 'unsure', `${text}: a guess, never a join by itself`);
    assert.equal(inboundSignal({ text, refKnown: false }), 'unsure', text);
  }
  for (const refKnown of ['true', 1, {}]) {
    assert.equal(inboundSignal({ text: 'Ref K7Q2X', refKnown }), 'unsure', `refKnown ${JSON.stringify(refKnown)} is not true`);
  }
});

test('the site\'s shape means the separator it writes and a whole code', () => {
  // parseRef also reads "Ref bona please" as listing BONA + code PLEASE. The site always
  // puts " · " between the two, so a line without a separator, or with more after the code,
  // is a guess — unless the poller found a session holding the code.
  for (const text of ['Ref Bonacheck', 'Ref bona please', 'ref bona thanks', 'Ref BONA K7Q2XR', 'Ref BONA · K7Q2XR٤', 'Ref BONA · K7Q2XR_']) {
    assert.equal(inboundSignal({ text }), 'unsure', text);
  }
  assert.equal(inboundSignal({ text: 'Ref bona please', refKnown: true }), 'certain', 'a session holds the code');
  for (const text of ['Ref BONA | K7Q2XR', 'Ref BONA-W003:K7Q2XR', 'Ref BONA · K7Q2XR.']) {
    assert.equal(inboundSignal({ text }), 'certain', text);
  }
});

test('ad context counts only when it is exactly true', () => {
  for (const hasAdMeta of ['false', 'true', 1, {}, []]) {
    assert.equal(inboundSignal({ text: 'Hello', hasAdMeta }), null, `hasAdMeta ${JSON.stringify(hasAdMeta)}`);
  }
});

test('the word bona on its own is only a guess', () => {
  for (const text of ['I saw Bona on Instagram', 'BONA', 'bona?', 'بونا', 'شفت إعلان بونا', 'BONA-W0031', 'BONA-W003٤', 'BONA-W003۴', 'بونا.', '(بونا)', 'بونا2', 'bona2', 'Bona_Villa']) {
    assert.equal(inboundSignal({ text }), 'unsure', text);
  }
});

test('a site link from a client, with no listing id, is only a guess: the owner decides', () => {
  // Spec §4.1 names a Ref code, ad context and a listing id; a bare site link is none of them.
  for (const text of ['https://bona-real-estate.com/ar/', 'bona.azoz.uk']) {
    assert.equal(inboundSignal({ text }), 'unsure', text);
  }
});

test('"bona fide" is Latin, not our name', () => {
  // Common in English real-estate papers: a "Bona Fide Purchaser Declaration" sent to a TK
  // buyer would otherwise pull that chat into the inbox with 24 h of history.
  const doc = (fileName, text = null) => ({ text, fileName, media: `[document: ${fileName}]` });
  for (const rec of [
    doc('Bona Fide Purchaser Declaration.pdf'),
    doc('offer.pdf', 'This is a bona fide offer'),
    doc('Bona_Fide.pdf'),
    doc('bona-fide buyer.pdf'),
    doc('BONA FIDES.pdf'),
  ]) {
    assert.equal(ownerOutboundJoins(rec), false, `${rec.fileName} / ${rec.text}`);
  }
  for (const text of ['is this a bona fide offer?', 'Bona-fide buyer', 'their bona  fides']) {
    assert.equal(inboundSignal({ text }), null, text);
    assert.equal(BONA_WORD_RE.test(text), false, text);
  }
  assert.equal(ownerOutboundJoins(doc('Bona_Villa.pdf')), true);
  assert.equal(ownerOutboundJoins(doc('offer.pdf', 'Bona villa, a bona fide offer')), true, 'the name next to the phrase still counts');
});

test('an Arabic word that only contains بونا is not the name', () => {
  for (const text of ['عندكم كوبونات؟', 'جابونا', 'أبونا', 'طلبونا نرسل لكم العقد', 'كن زبوناً معنا', 'جربونا', 'حاسبونا على الدفعة']) {
    assert.equal(inboundSignal({ text }), null, text);
    assert.equal(BONA_WORD_RE.test(text), false, text);
  }
});

test('anything else says nothing, and text that is not a string reads as empty', () => {
  for (const text of ['Hello', 'Bonanza', 'kabona', 'Bonaé', 'Refund 12345', 'السلام عليكم', '']) {
    assert.equal(inboundSignal({ text }), null, JSON.stringify(text));
  }
  assert.equal(inboundSignal({ text: 'Hello', hasAdMeta: false }), null);
  assert.equal(inboundSignal({ text: null }), null);
  assert.equal(inboundSignal({ text: 42 }), null);
  assert.equal(inboundSignal({ text: { toString: () => 'BONA-W003' } }), null, 'never coerced');
  assert.equal(inboundSignal({}), null);
  assert.equal(inboundSignal(), null);
  assert.equal(inboundSignal(null), null);
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
    'BONA-W003عندكم',
    'Is it bona.azoz.uk, or bona-real-estate.com?',
    '(bona-real-estate.com)',
    'bona-real-estate.com/',
    'https://bona-real-estate.com:443/ar/',
    'bona-real-estate.com: our site',
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
    'https://bona-real-estate.com.evil.example/x',
    'bona-real-estate.com.sa',
    'bona.azoz.uk.attacker.io',
    'https://bona.azoz.uk@evil.example/',
    'bona-real-estate.com@evil.example',
    // user-info with a port or a password, an Arabic top-level domain, the full stops that
    // browsers read as a dot in a host name, and a letter that carries the host on
    'https://bona.azoz.uk:443@evil.example/',
    'https://bona.azoz.uk:pass@evil.example/',
    'https://bona-real-estate.com.السعودية/',
    'https://bona.azoz.uk。evil.example/',
    'bona-real-estate.com．sa',
    'bona.azoz.uk｡evil.example',
    'bona-real-estate.comعندكم',
    'BONA-W003٤',
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
    doc('بونا_فيلا.pdf'),
    doc('فيلا-بونا.pdf'),
    doc('villa.pdf', 'Brochure from Bona'),
    doc('villa.pdf', 'بروشور بونا'),
    doc('villa.pdf', 'بروشور (بونا)'),
    doc('Bona2026.pdf'),
    doc(null, 'bona'),
  ]) {
    assert.equal(ownerOutboundJoins(rec), true, `${rec.fileName} / ${rec.text}`);
  }
  for (const rec of [
    doc('Bonanza.pdf'),
    doc('Kabona_offer.pdf'),
    doc('TK_Villa.pdf', 'here you go'),
    doc(null),
    // Arabic words that only contain the four letters: coupons, "our father", "they asked
    // us", a customer, "try us", "bill us". Each would pull a private or TK chat in.
    doc('كوبونات الخصم.pdf'),
    doc('أبونا.pdf'),
    doc('villa.pdf', 'طلبونا نرسل لكم العقد'),
    doc('villa.pdf', 'كن زبوناً معنا'),
    doc('villa.pdf', 'جربونا'),
    doc('villa.pdf', 'حاسبونا على الدفعة'),
    doc('Bonaé.pdf'),
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
  assert.equal(ownerOutboundJoins(null), false);
});

test('a document name cut at 120 characters cannot make a word or an id at the cut', () => {
  // Through normaliseRecord, which cuts the name: what follows the cut is unknown, so the
  // last word may be the start of a longer one (Bonanza cut to Bona).
  const rec = (fileName, caption) => normaliseRecord({
    key: { id: 'D1', fromMe: true, remoteJid: '1@lid' },
    message: { documentMessage: { fileName, ...(caption ? { caption } : {}) } },
  });
  const bonanza = rec('x'.repeat(115) + ' Bonanza.pdf');
  assert.ok(bonanza.fileName.endsWith(' Bona'), 'the cut leaves "Bona" at the end');
  assert.equal(bonanza.fileNameTruncated, true);
  assert.equal(ownerOutboundJoins(bonanza), false);
  // Anything before the cut still counts, and a caption is never cut.
  assert.equal(ownerOutboundJoins(rec('Bona brochure ' + 'x'.repeat(200) + '.pdf')), true);
  assert.equal(ownerOutboundJoins(rec('BONA-W003 ' + 'x'.repeat(200) + '.pdf')), true);
  assert.equal(ownerOutboundJoins(rec('x'.repeat(115) + ' Bonanza.pdf', 'brochure from Bona')), true);
  // A name that was not cut ends where it ends.
  const short = rec('Villa Bona');
  assert.equal(short.fileNameTruncated, false);
  assert.equal(ownerOutboundJoins(short), true);
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
    assert.equal(nextInboxState(current, null), current);
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
  assert.equal(nextInboxState(null, null), null);
  assert.equal(nextInboxState('unsure', null), 'unsure');
});

test('a state that is not one of the three reads as undecided, never passes through', () => {
  for (const current of ['bogus', '', 'IN', 0, {}]) {
    assert.equal(nextInboxState(current), null, JSON.stringify(current));
    assert.equal(nextInboxState(current, { method: 'phone' }), null, JSON.stringify(current));
    assert.equal(nextInboxState(current, { signal: 'unsure' }), 'unsure', JSON.stringify(current));
    assert.equal(nextInboxState(current, { signal: 'certain' }), 'in', JSON.stringify(current));
  }
});
