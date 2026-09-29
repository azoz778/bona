/**
 * Which chats the Bona inbox takes (design §4.1): only what is certain joins by itself, a
 * guess waits for the owner, the owner's own messages count only when they carry
 * something that can only be Bona, and nothing a message says ever moves a chat out of
 * `in` or `out`. Pure rules, so every case is a table row.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  LISTING_ID_RE, BONA_WORD_RE, SITE_LINK_RE, PROPERTY_DOC_RE, TK_RE, PROPERTY_WORD_RE, MAX_PROPERTY_WORDS, INBOX_STATES,
  // The two kinds of document word and the property words (owner answer, 2026-09-28).
  BROCHURE_RE, QUALIFIED_DOC_RE, PROPERTY_NOUN_RE,
  inboundSignal, ownerOutboundJoins, isTkDocument, namesTk, namesBona, propertyWordsIn, nextInboxState, hasAdEvidence, PROPERTY_WORD_FORMS,
  mentionsPropertyDocument,
} from '../lib/inbox/eligibility.mjs';
import { normaliseRecord } from '../lib/evolution.mjs';

/* ---------------- shared patterns ---------------- */

test('the states and patterns are what the store and the poller rely on', () => {
  assert.deepEqual(INBOX_STATES, ['in', 'unsure', 'out']);
  assert.ok(Object.isFrozen(INBOX_STATES), 'nothing that imports the list can change it');
  for (const re of [LISTING_ID_RE, BONA_WORD_RE, SITE_LINK_RE, PROPERTY_DOC_RE, TK_RE, PROPERTY_WORD_RE]) {
    assert.ok(re instanceof RegExp);
    assert.equal(re.global, false, `${re} has no /g, so .test() never carries a position over`);
    assert.equal(re.sticky, false, `${re} has no /y`);
  }
  // The bounds are \p{…} classes, which mean something only with /u: rebuilt from `.source`
  // with 'i' alone, [\p{L}\p{M}] is a set of literal characters and كوبونات matches again.
  for (const re of [BONA_WORD_RE, SITE_LINK_RE, PROPERTY_DOC_RE, TK_RE, PROPERTY_WORD_RE]) assert.equal(re.unicode, true, `${re} needs /u`);
  for (const re of [PROPERTY_DOC_RE, TK_RE, PROPERTY_WORD_RE]) assert.equal(re.ignoreCase, true, `${re} ignores case`);
  for (const re of [BROCHURE_RE, QUALIFIED_DOC_RE, PROPERTY_NOUN_RE]) {
    assert.ok(re instanceof RegExp);
    assert.equal(re.global, false, `${re} has no /g`);
    assert.equal(re.sticky, false, `${re} has no /y`);
    assert.equal(re.unicode, true, `${re} needs /u`);
    assert.equal(re.ignoreCase, true, `${re} ignores case`);
  }
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
  assert.equal(inboundSignal({ text: 'Bona villa, a bona fide offer' }), 'unsure', 'the name next to the phrase still counts');
  assert.equal(ownerOutboundJoins(doc('Bona Fide Purchaser Declaration - Brochure.pdf')), true, 'a brochure joins, whatever Latin is on it');
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
    // a full stop before the user-info's @, and an underscore carrying the host on
    'https://bona.azoz.uk.@evil.example/',
    'https://bona.azoz.uk_evil.example/',
    // user-info is looked for 256 characters after the colon; longer than that is refused too
    `https://bona.azoz.uk:${'a'.repeat(300)}@evil.example/`,
    `https://bona.azoz.uk:${'a'.repeat(300)} more`,
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

test('a property document the owner sends joins the chat, from any developer (D16)', () => {
  const doc = (fileName, text = null) => ({ text, fileName, media: fileName ? `[document: ${fileName}]` : '[document]' });
  for (const rec of [
    // A brochure joins on its own (owner, 2026-09-28).
    doc('Knightsbridge_Phase 2_Brochure_EN.pdf'),
    doc('brochure2.pdf'),
    doc('Brochures.zip'),
    doc('بروشور المشروع.pdf'),
    doc('البروشور.pdf'),
    doc('بروشورات.pdf'),
    doc('scan.pdf', 'هذا البروشور'),
    // The other document words join next to a property word in the same name or caption.
    doc('Villa floor plan.pdf'),
    doc('مخطط فيلا.pdf'),
    doc('Project price list.pdf'),
    doc('Unit payment plan.pdf'),
    doc('قائمة أسعار الشقق.pdf'),
    doc('Tower A fact sheet.pdf'),
    doc('doc.pdf', 'price list for the villa'),
    doc('Villa_Floor-Plan_Type-A.pdf'),
    doc('Apartments floorplan.pdf'),
    doc('Townhouse pricelist.pdf'),
    doc('Plots master-plan.pdf'),
    doc('Properties fact sheets.pdf'),
    doc('كتيّب المشروع.pdf'),
    doc('مخططات الفلل.pdf'),
    doc('قائمة_الاسعار_عقارات.pdf'),
    doc('جدول الدفعات - الوحدة 12.pdf'),
    doc('خطة السداد - شقة.pdf'),
    doc('مخطط أرض.pdf'),
    doc(null, 'Floor plan of the penthouse'),
    // Or next to a listing id or a site link, which join any document by themselves.
    doc('floor plan BONA-W003.pdf'),
    doc('Price List Sep.pdf', 'BONA-W003'),
    doc('BONA-W003 brochure.pdf'),
    doc('Brochure BONA-W014.pdf'),
    doc('BONA-W003.pdf'),
    doc('Villa_BONA-W003_EN.pdf'),
    doc('Bona Villa BONA-W003 brochure.pdf'),
    doc('bona-real-estate.com villa.pdf'),
    // In a file name `_` stands for a space, for a site link as for a listing id, and the
    // extension is not part of the host.
    doc('bona-real-estate.com_brochure.pdf'),
    doc('bona-real-estate.com.pdf'),
    doc('Villa_bona.azoz.uk_EN.pdf'),
    doc('bona.azoz.uk.PDF'),
    doc('Bona brochure.pdf', 'https://bona-real-estate.com/ar/'),
    doc('scan.pdf', 'BONA-005'),
    doc('scan.pdf', 'https://bona-real-estate.com/ar/'),
  ]) {
    assert.equal(ownerOutboundJoins(rec), true, `${rec.fileName} / ${rec.text}`);
  }
});

test('the other document words need a property word, a listing id or a link next to them: TK design work uses them too (owner answer, D16)', () => {
  // Floor plans, price lists, payment plans, master plans, fact sheets, booklets and plans
  // (مخطط) are fit-out papers as often as property papers. Alone they do not join; they are
  // still property-document words (PROPERTY_DOC_RE), which Task 16 lists for the owner.
  const doc = (fileName, text = null) => ({ text, fileName, media: fileName ? `[document: ${fileName}]` : '[document]' });
  for (const rec of [
    doc('Floor-Plan_Type-A.pdf'),
    doc('Price List Sep.pdf'),
    doc('payment_plan.pdf'),
    doc('مخطط الدور الأرضي.pdf'),
    doc('قائمة الأسعار.pdf'),
    doc('Payment plan - kitchen works.pdf'),
    doc('مخطط الكهرباء.pdf'),
    doc('كتيب الصيانة.pdf'),
    doc('Master plan.pdf'),
    doc('جدول الدفعات - أعمال الديكور.pdf'),
    doc('floorplan.pdf'),
    doc('pricelist.pdf'),
    doc('Fact sheet 2026.pdf'),
    doc('كتيب.pdf'),
    doc('المخططات.pdf'),
    doc('قائمة_الاسعار.pdf'),
    doc('جدول الأسعار.pdf'),
    doc('خطة الدفع.pdf'),
    doc('خطة السداد.pdf'),
    doc('جدول السداد.pdf'),
    doc('doc.pdf', 'price list attached'),
    doc(null, 'Floor plan'),
    // A property word counts only as its own word ...
    doc('Landscape floor plan.pdf'),
    doc('Unity price list.pdf'),
    doc('Villager fact sheet.pdf'),
    doc('مخطط الأرض.pdf'),
    // العمارة with the article is also architecture (العمارة الداخلية, interior architecture,
    // which TK's design work draws): the owner's word is عمارة, without it.
    doc('مخطط العمارة الداخلية.pdf'),
    doc('مخطط العمارة الداخلية - مطبخ.pdf'),
    // ... and only in the same name or caption as the document word.
    doc('Price List.pdf', 'for the villa'),
    doc('villa.pdf', 'price list'),
  ]) {
    assert.equal(ownerOutboundJoins(rec), false, `${rec.fileName} / ${rec.text}`);
    assert.equal(PROPERTY_DOC_RE.test(`${rec.fileName ?? ''} ${rec.text ?? ''}`), true, `${rec.fileName} / ${rec.text}: still a property-document word`);
  }
});

test('the property words are the owner\'s list as it stands: unit, project and مشروع let a fit-out paper join (open for the owner)', () => {
  // Some of the owner's property words (2026-09-28) are also fit-out words, or other words
  // altogether (land in Land Cruiser, compound in compound interest), so these join today.
  // Whether unit, project and مشروع should go, or a fit-out word (kitchen, أعمال, ديكور,
  // كهرباء …) next to them should keep the chat out, is his call (context.md, D16): an answer
  // changes this test on purpose.
  const doc = (fileName) => ({ text: null, fileName, media: `[document: ${fileName}]` });
  for (const fileName of ['Kitchen unit price list.pdf', 'AC unit fact sheet.pdf', 'Payment plan - kitchen project.pdf',
    'جدول الدفعات - مشروع الديكور.pdf', 'Floor plan - villa kitchen.pdf', 'Toyota Land Cruiser price list.pdf',
    'Compound interest fact sheet.pdf', 'مخطط كهرباء الفيلا.pdf', 'مخطط عمارة داخلية.pdf']) {
    assert.equal(ownerOutboundJoins(doc(fileName)), true, fileName);
  }
});

test('namesTk and namesBona read a caption or a name as it is and with its spaces and invisible characters cleaned', () => {
  for (const s of ['TK', 'تي  كي', 'تى - كى', 'تي. كي', 'تي _ كي', 'T\u200BK', 'T\u200CK', 'X\u200BTK', 'تي\u200Dكي', `تي${' '.repeat(50)}كي`]) {
    assert.equal(namesTk(s), true, JSON.stringify(s));
  }
  for (const s of ['', 'TKO', 'بلاستيكي', 'تي كيس', 'تي , كي', 'تي -- - كي', 'St.Kitts']) {
    assert.equal(namesTk(s), false, JSON.stringify(s));
  }
  for (const s of ['Bona', 'B\u200Bona', 'بو\u200Cنا', 'Bona\u200Bfide', 'Bona  Villa']) {
    assert.equal(namesBona(s), true, JSON.stringify(s));
  }
  for (const s of ['', 'Bonanza', 'bona  fide', 'كوبونات']) {
    assert.equal(namesBona(s), false, JSON.stringify(s));
  }
});

test('the three document patterns: a brochure, a document word that needs a property word, the property words', () => {
  for (const s of ['brochure', 'Brochures', 'بروشور', 'البروشور', 'بروشورات', 'x_Brochure_EN']) {
    assert.equal(BROCHURE_RE.test(s), true, s);
    assert.equal(QUALIFIED_DOC_RE.test(s), false, s);
    assert.equal(PROPERTY_DOC_RE.test(s), true, s);
  }
  for (const s of ['floor plan', 'Floor-Plans', 'floorplan', 'price_list', 'pricelists', 'payment plan', 'Master-Plan', 'fact sheets',
    'كتيب', 'كتيّب', 'الكتيب', 'مخطط', 'مخططات', 'المخطط', 'قائمة الأسعار', 'قائمة الاسعار', 'قائمة أسعار', 'جدول الأسعار', 'جدول_الاسعار',
    'خطة الدفع', 'خطة السداد', 'جدول الدفعات', 'جدول السداد']) {
    assert.equal(QUALIFIED_DOC_RE.test(s), true, s);
    assert.equal(BROCHURE_RE.test(s), false, s);
    assert.equal(PROPERTY_DOC_RE.test(s), true, s);
  }
  for (const s of ['brochureX', 'Brochureware', 'وبروشور', 'floor', 'plan', 'Floor Planner', 'Price Listing', 'datasheet', 'كتيبة', 'مخططين']) {
    assert.equal(PROPERTY_DOC_RE.test(s), false, s);
  }
  for (const s of ['villa', 'Villas', 'apartment', 'units', 'Project', 'towers', 'residence', 'Townhouses', 'duplex', 'penthouse',
    'compound', 'plots', 'land', 'property', 'properties', 'Tower_A', '3villas', 'villa2',
    'فيلا', 'الفيلا', 'فلل', 'فله', 'فلة', 'شقة', 'شقق', 'الشقق', 'شقه', 'مشروع', 'المشروع', 'مشاريع', 'وحدة', 'الوحدات', 'برج', 'أبراج',
    'عمارة', 'دوبلكس', 'بنتهاوس', 'تاون هاوس', 'مجمع سكني', 'أرض', 'ارض', 'أراضي', 'عقار', 'العقارات']) {
    assert.equal(PROPERTY_NOUN_RE.test(s), true, s);
  }
  // Longer words that only start with one, and أرض with the article (the ground; الأرضي is the ground floor).
  // العمارة with the article is also architecture: the owner's word is عمارة without it.
  for (const s of ['Villager', 'Landscape', 'Unity', 'Projector', 'Propertyless', 'Compounding', 'الأرض', 'الأرضي', 'وحده', 'العمارة']) {
    assert.equal(PROPERTY_NOUN_RE.test(s), false, s);
  }
});

test('mentionsPropertyDocument: a brochure, or another document word with a property word beside it — the test a document joins by', () => {
  for (const s of ['the brochure please', 'ابغى البروشور', 'Villa_Brochure_EN.pdf', 'send me the floor plan of the unit', 'مخطط أرض في الشمال',
    'price list for the project', 'جدول الدفعات - مشروع الشاطئ', 'Payment plan - Tower B', 'كتيب المشروع']) {
    assert.equal(mentionsPropertyDocument(s), true, s);
  }
  for (const s of ['عندي مخطط للسفر بكرة', 'مخطط الشاطئ', 'المخطط', 'what is the payment plan for the car?', 'send me the price list of the restaurant',
    'كتيب السيارة', 'خطة السداد للقرض', 'fact sheet for the fund', 'Price List Sep.pdf', 'Payment plan - kitchen works.pdf', 'مخطط الكهرباء.pdf',
    'كتيب الصيانة.pdf', 'brochureX', 'villa', '', null, undefined, 42, { text: 'brochure' }]) {
    assert.equal(mentionsPropertyDocument(s), false, String(s));
  }
});

test('the word Bona, or any other file, no longer joins a chat by itself, and a document that names Bona needs a listing id or a link (D16)', () => {
  const doc = (fileName, text = null) => ({ text, fileName, media: fileName ? `[document: ${fileName}]` : '[document]' });
  // Bona AB makes wood-floor finishes, with brochures, price lists and fact sheets of its own:
  // TK Estate & Design sends them to TK clients.
  for (const rec of [
    doc('Bona Traffic HD datasheet.pdf'),
    doc('Bona Traffic HD brochure.pdf'),
    doc('Bona Price List 2026.pdf'),
    doc('Bona Traffic HD Fact Sheet.pdf'),
    doc('Bona_Villa_Brochure.pdf'),
    doc('بروشور بونا.pdf'),
    doc('brochure.pdf', 'Bona'),
    doc('Floor plan.pdf', 'from بونا'),
    doc('Bona Villa floor plan.pdf'),
    doc('Bona.pdf'),
    doc('Bona_Villa.pdf'),
    doc('بونا - فيلا الشاطئ.pdf'),
    doc('villa.pdf', 'Files from Bona'),
    doc(null, 'bona'),
    doc('Invoice 1234.pdf'),
    doc('XBONA-W003.pdf'),
    doc('BONA-W0031.pdf'),
    doc('Stock brochureX.pdf'),
    doc('Brochureware.pdf'),
    doc('datasheet.pdf'),
    doc('Floor.pdf'),
    doc('وبروشور.pdf'),
    doc('Bona Fide Purchaser Declaration.pdf'),
    doc(null),
    // Our name with an invisible character in it, or a run of spaces, is still our name.
    doc('brochure.pdf', 'B\u200Bona'),
    doc('B\u200Cona Villa Brochure.pdf'),
    doc('brochure.pdf', 'from   بو\u200Dنا'),
    // A site link is read in a file name with `_` as a space and without the extension; a
    // host that only starts like ours is still not ours, and the name then says Bona.
    doc('bona-real-estate.company_profile.pdf'),
    doc('bona-real-estate.com.evil.pdf'),
    doc('bona-real-estate.com-brochure.pdf'),
  ]) {
    assert.equal(ownerOutboundJoins(rec), false, `${rec.fileName} / ${rec.text}`);
  }
  // "brochure" typed as text, or on a photo, is not a document.
  for (const media of [null, '[image]', '[voice note]']) {
    assert.equal(ownerOutboundJoins({ text: 'BONA brochure', media }), false, String(media));
    assert.equal(ownerOutboundJoins({ text: 'price list', media }), false, String(media));
    assert.equal(ownerOutboundJoins({ text: 'villa floor plan', media }), false, String(media));
  }
  assert.equal(ownerOutboundJoins({ text: 'bona.azoz.uk/villas', media: '[image]' }), true, 'a link in a caption still counts');
  assert.equal(ownerOutboundJoins({ text: 'BONA-W003 on the photo', media: '[image]' }), true, 'so does a listing id');
});

test('a longer host in a file name is not ours: only a document\'s own extension comes off, and `_` is a space only where nothing can carry the host on (A7)', () => {
  const doc = (fileName) => ({ text: null, fileName, media: `[document: ${fileName}]` });
  const read = (fileName) => normaliseRecord({ key: { id: 'D5', fromMe: true }, message: { documentMessage: { fileName } } });
  for (const fileName of [
    // A7: a longer host is someone else's, in a file name as in a text.
    'bona-real-estate.com.sa',
    'bona-real-estate.com.sa.pdf',
    'bona.azoz.uk.evil',
    // `_` then a run with a full stop in it carries the host on ...
    'bona-real-estate.com_evil.example',
    'bona.azoz.uk_evil.example.pdf',
    'bona.azoz.uk_x_y.example.pdf',
    'bona.azoz.uk_evil。example.pdf',
    // ... and with `@` or `:` it makes the host the user part of another one.
    'bona.azoz.uk_x@evil.example.pdf',
    'bona.azoz.uk_:443@evil.example.pdf',
    // `.zip` is a top-level domain too, so it does not come off as an extension.
    'bona-real-estate.com.zip',
    // Fewer joins: a full stop after `_` is read as carrying the host on, even in a version.
    'bona-real-estate.com_brochure.v2.pdf',
  ]) {
    assert.equal(ownerOutboundJoins(doc(fileName)), false, fileName);
    assert.equal(ownerOutboundJoins(read(fileName)), false, `${fileName}, read from Evolution`);
    assert.equal(ownerOutboundJoins({ text: fileName, media: '[image]' }), false, `${fileName} in a caption`);
  }
  // `_` followed by no full stop, `@` or `:` before the next space could only make a top-level
  // domain no one can have (`com_brochure`): there it is a space, as for a listing id.
  for (const fileName of ['bona-real-estate.com_brochure.pdf', 'bona-real-estate.com.pdf', 'Villa_bona.azoz.uk_EN.pdf', 'bona.azoz.uk.PDF',
    'bona-real-estate.com_villa_EN.docx', 'bona-real-estate.com_Phase 2.v3.pdf', 'bona.azoz.uk_ar', 'Villa_bona-real-estate.com.JPEG']) {
    assert.equal(ownerOutboundJoins(doc(fileName)), true, fileName);
    assert.equal(ownerOutboundJoins(read(fileName)), true, `${fileName}, read from Evolution`);
  }
});

test('a document that names TK never joins, whatever else it says, and isTkDocument says so (D16, D17)', () => {
  const doc = (fileName, text = null) => ({ text, fileName, media: fileName ? `[document: ${fileName}]` : '[document]' });
  for (const rec of [
    doc('TK Brochure Villa.pdf'),
    doc('brochure.pdf', 'TK Estates brochure'),
    doc('بروشور تي كي.pdf'),
    doc('بروشور تى كى.pdf'),
    doc('بروشور تي كى.pdf'),
    doc('T.K. Estates brochure.pdf'),
    doc('TK_Price_List.pdf'),
    doc('tk-estates floor plan.pdf'),
    doc('TKEstates brochure.pdf'),
    doc('Brochure BONA-W014 TK.pdf'),
    doc('scan.pdf', 'TK · https://bona-real-estate.com/ar/'),
    doc('Brochure.pdf', 'from تي كي'),
    doc('TK villa floor plan.pdf'),
    // A caption is not cleaned the way a file name is: two spaces (a common phone typo), a
    // spaced hyphen or a line break between the two Arabic words still name TK ...
    doc('scan.pdf', 'بروشور تي  كي'),
    doc('scan.pdf', 'بروشور تى  كى'),
    doc('scan.pdf', 'بروشور تي - كي'),
    doc('scan.pdf', 'بروشور تي\n\n  كي'),
    doc('بروشور تي - كي.pdf'),
    doc('بروشور تي _ كي.pdf'),
    // ... and so does TK with an invisible character inside it, in a caption or in the
    // joiners a file name keeps (U+200C, U+200D).
    doc('Brochure.pdf', 'T\u200BK'),
    doc('Brochure.pdf', 'T\u2060K\uFEFF'),
    doc('T\u200CK Brochure.pdf'),
    doc('T\u200DK Brochure.pdf'),
    doc('بروشور تي\u200Cكي.pdf'),
    // What the invisible character ends counts as well ("X\u200BTK" reads "XTK"): both readings
    // are asked, and either keeps the chat out.
    doc('Brochure.pdf', 'X\u200BTK'),
  ]) {
    assert.equal(ownerOutboundJoins(rec), false, `${rec.fileName} / ${rec.text}`);
    assert.equal(isTkDocument(rec), true, `${rec.fileName} / ${rec.text}`);
  }
  // TK only as part of a longer word or number, and Arabic words that only contain the letters.
  for (const rec of [doc('TKO brochure.pdf'), doc('Brochure TK2.pdf'), doc('Stock brochure.pdf', 'atk ok'), doc('St.Kitts brochure.pdf'),
    doc('بروشور بلاستيكي.pdf'), doc('مخطط فيلا بلاستيكى.pdf'), doc('بلاستيكى villa floor plan.pdf'), doc('brochure.pdf', 'أوتوماتيكي')]) {
    assert.equal(isTkDocument(rec), false, `${rec.fileName} / ${rec.text}`);
    assert.equal(ownerOutboundJoins(rec), true, `${rec.fileName} / ${rec.text}`);
  }
  // Only a document is a TK document: text and photos keep the rules they had.
  assert.equal(isTkDocument({ text: 'TK brochure', media: null }), false);
  assert.equal(isTkDocument({ text: 'TK brochure', media: '[image]' }), false);
  assert.equal(ownerOutboundJoins({ text: 'TK · BONA-W003', media: null }), true, 'a listing id in a text still joins');
  assert.equal(isTkDocument({}), false);
  assert.equal(isTkDocument(), false);
  assert.equal(isTkDocument(null), false);
  assert.equal(isTkDocument({ fileName: 42, text: {}, media: '[document]' }), false);
});

test('a cut name is TK or Bona by what the whole name said and by what is left of it; without the answer it may be either', () => {
  const cutName = `Villa Brochure ${'x'.repeat(100)}`;
  const cut = (over = {}) => ({ fileName: cutName, fileNameTruncated: true, fileNameTk: false, fileNameBona: false, media: `[document: ${cutName}]`, ...over });
  const withFlag = (key, v) => {
    const rec = cut();
    if (v === undefined) delete rec[key]; else rec[key] = v;
    return rec;
  };
  assert.equal(ownerOutboundJoins(cut()), true, 'the whole name named neither');
  assert.equal(isTkDocument(cut()), false);
  assert.equal(ownerOutboundJoins(cut({ fileNameTk: true })), false, 'it named TK, past the cut');
  assert.equal(isTkDocument(cut({ fileNameTk: true })), true);
  assert.equal(ownerOutboundJoins(cut({ fileNameBona: true })), false, 'it named Bona, past the cut');
  assert.equal(isTkDocument(cut({ fileNameBona: true })), false, 'which is not TK');
  for (const v of [undefined, null, 0, 'false']) {
    assert.equal(ownerOutboundJoins(withFlag('fileNameTk', v)), false, `TK unknown (${JSON.stringify(v)}): fewer joins, never more`);
    assert.equal(isTkDocument(withFlag('fileNameTk', v)), true, JSON.stringify(v));
    assert.equal(ownerOutboundJoins(withFlag('fileNameBona', v)), false, `Bona unknown (${JSON.stringify(v)})`);
  }
  // What is left of the name counts too, whatever the bits say ("…TK" may be the start of "…TKO").
  const shows = (fileName) => cut({ fileName, media: `[document: ${fileName}]` });
  assert.equal(ownerOutboundJoins(shows(`Villa Brochure TK ${'x'.repeat(100)}`)), false);
  assert.equal(isTkDocument(shows(`Villa Brochure TK ${'x'.repeat(100)}`)), true);
  assert.equal(ownerOutboundJoins(shows(`Bona Villa Brochure ${'x'.repeat(100)}`)), false);
  assert.equal(ownerOutboundJoins(shows(`Bona Villa BONA-W003 ${'x'.repeat(100)}`)), true, 'a listing id still joins');
  // A name that was not cut is read as it is; a bit of exactly true still counts.
  const whole = (over = {}) => ({ fileName: 'Villa Brochure.pdf', media: '[document: Villa Brochure.pdf]', ...over });
  assert.equal(ownerOutboundJoins(whole()), true);
  assert.equal(ownerOutboundJoins(whole({ fileNameTk: true })), false);
  assert.equal(ownerOutboundJoins(whole({ fileNameBona: true })), false);
});

/** A document record sent by the owner, through normaliseRecord (which cuts the name). */
const ownerDoc = (fileName) => normaliseRecord({
  key: { id: 'D1', fromMe: true, remoteJid: '1@lid' },
  message: { documentMessage: { fileName } },
});
/** The same document if its whole name had been kept (normaliseRecord cleans before it cuts). */
const wholeDoc = (fileName) => ({ text: '', fileName, fileNameTruncated: false, media: `[document: ${fileName}]` });

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
  // "…BrochureX.pdf" cut straight after "Brochure": the word is not read at the cut.
  const brochureX = rec(`${'x'.repeat(111)} BrochureX.pdf`);
  assert.ok(brochureX.fileName.endsWith(' Brochure'), 'the cut leaves "Brochure" at the end');
  assert.equal(ownerOutboundJoins(brochureX), false);
  assert.equal(ownerOutboundJoins(wholeDoc(`${'x'.repeat(111)} BrochureX.pdf`)), false, 'nor does the whole name join');
  // Anything before the cut still counts, and a caption is never cut.
  assert.equal(ownerOutboundJoins(rec('Villa brochure ' + 'x'.repeat(200) + '.pdf')), true);
  assert.equal(ownerOutboundJoins(rec('Villa floor plan ' + 'x'.repeat(200) + '.pdf')), true);
  assert.equal(ownerOutboundJoins(rec('BONA-W003 ' + 'x'.repeat(200) + '.pdf')), true);
  assert.equal(ownerOutboundJoins(rec(`${'x'.repeat(111)} BrochureX.pdf`, 'price list for the villa')), true);
  // But "Bona" left at the cut may be our name as much as the start of Bonanza, so it keeps
  // a caption's brochure out, as our name does anywhere on a document (fewer joins, never more).
  assert.equal(ownerOutboundJoins(rec('x'.repeat(115) + ' Bonanza.pdf', 'the brochure')), false);
  // TK or Bona past the cut is still there: the record says so (fileNameTk, fileNameBona).
  assert.equal(ownerOutboundJoins(rec('Villa brochure ' + 'x'.repeat(200) + ' TK.pdf')), false);
  assert.equal(ownerOutboundJoins(rec('Villa brochure ' + 'x'.repeat(200) + ' Bona.pdf')), false);
  assert.equal(ownerOutboundJoins(rec('BONA-W003 brochure ' + 'x'.repeat(200) + ' Bona.pdf')), true, 'a listing id joins whatever names Bona');
  // A first grapheme longer than the whole cap leaves no name at all, but the whole name
  // still said TK or Bona, so a caption's brochure stays out.
  for (const tail of [' TK.pdf', ' Bona.pdf']) {
    const zalgo = rec(`a${'\u0301'.repeat(120)}${tail}`, 'brochure');
    assert.equal(zalgo.fileName, null, 'nothing of the name is left');
    assert.equal(ownerOutboundJoins(zalgo), false, tail);
    assert.equal(ownerOutboundJoins({ ...zalgo, text: 'brochure BONA-W003' }), tail === ' Bona.pdf', `${tail}: a listing id still beats our name, never TK`);
  }
  // A name that was not cut ends where it ends.
  const short = rec('Villa Brochure');
  assert.equal(short.fileNameTruncated, false);
  assert.equal(ownerOutboundJoins(short), true);
});

test('a cut name never joins where the whole name would not: "bona fide", Bonanza, BrochureX, TK and Bona AB at every cut', () => {
  // Reading the cut as if a letter followed it turned "…Bona fi|de declaration" into
  // "…Bona fix", which is not the Latin phrase, so the cut name joined. Leaving the end out
  // is not enough on its own either: "…Bona| fide" left "…Bona" at the new end. The same
  // goes for a property word at the cut (…Brochure|X, …Price List|ing, …Villa|ger,
  // …Land|scape), a listing id (…BONA-W003|1), a TK brochure, whichever side of the cut TK
  // falls, and Bona AB's papers.
  let cuts = 0;
  for (const tail of ['Bona fide declaration.pdf', 'Bonanza.pdf', 'Bona-fides.pdf', 'بونات.pdf',
    'BrochureX.pdf', 'Price Listing.pdf', 'Floor Planner.pdf', 'BONA-W0031.pdf', '_TK Brochure.pdf', 'Brochure TK.pdf',
    'بروشور تي كي.pdf', 'بروشور تى كى.pdf', '_T.K. Brochure.pdf', 'Bona Traffic HD datasheet.pdf', 'Bona Traffic HD brochure.pdf',
    'Bona Price List 2026.pdf', 'Floor plan Landscape.pdf', 'Price list Unity.pdf', 'Villager price list.pdf', '_TK villa floor plan.pdf']) {
    for (const sep of [' ', '_', '-', '1']) {
      for (let pad = 80; pad <= 125; pad += 1) {
        const name = `${'x'.repeat(pad)}${sep}${tail}`;
        const rec = ownerDoc(name);
        if (rec.fileNameTruncated) cuts += 1;
        assert.equal(ownerOutboundJoins(wholeDoc(name)), false, `${pad} ${tail}: the whole name does not join`);
        assert.equal(ownerOutboundJoins(rec), false, `${pad} ${JSON.stringify(sep)} ${tail}: nor may the cut one`);
      }
    }
  }
  assert.ok(cuts > 1500, `the longer ones are cut (${cuts})`);
});

test('a brochure at every cut: the whole name joins, the cut one only where what is read holds the word', () => {
  let cuts = 0;
  let cutJoins = 0;
  for (const tail of ['Brochure.pdf', 'Villa Floor Plan.pdf', 'BONA-W003 plan.pdf', 'قائمة أسعار الشقق.pdf']) {
    for (const sep of [' ', '_', '-']) {
      for (let pad = 80; pad <= 125; pad += 1) {
        const name = `${'x'.repeat(pad)}${sep}${tail}`;
        const rec = ownerDoc(name);
        assert.equal(ownerOutboundJoins(wholeDoc(name)), true, `${pad} ${tail}: the whole name joins`);
        if (!rec.fileNameTruncated) {
          assert.equal(ownerOutboundJoins(rec), true, `${pad} ${tail}: not cut, so it joins`);
          continue;
        }
        cuts += 1;
        if (ownerOutboundJoins(rec)) cutJoins += 1;
      }
    }
  }
  assert.ok(cuts > 200, `the longer ones are cut (${cuts})`);
  // Each word sits in the last 16 code points of what a cut leaves, so no cut one joins by
  // it: a missed join, which the owner's list of real-estate chats catches (D17; Task 16
  // notes it there as a `property document`).
  assert.equal(cutJoins, 0);
  // A property word before the cut, TK after it: the whole name names TK, so neither joins.
  for (const word of ['Brochure', 'BONA-W003', 'Villa Floor Plan', 'بروشور']) {
    for (let pad = 90; pad <= 130; pad += 5) {
      const name = `${word} ${'x'.repeat(pad)} TK.pdf`;
      assert.equal(ownerOutboundJoins(wholeDoc(name)), false, `${word} ${pad}: the whole name names TK`);
      assert.equal(ownerOutboundJoins(ownerDoc(name)), false, `${word} ${pad}: so the cut one does not join`);
    }
  }
  // Our name before the cut or after it: such a document joins only by a listing id, cut or not.
  for (let pad = 90; pad <= 130; pad += 5) {
    for (const [name, joins] of [
      [`Brochure ${'x'.repeat(pad)} Bona.pdf`, false],
      [`Bona ${'x'.repeat(pad)} Brochure.pdf`, false],
      [`BONA-W003 ${'x'.repeat(pad)} Bona.pdf`, true],
    ]) {
      assert.equal(ownerOutboundJoins(wholeDoc(name)), joins, `${name.slice(0, 12)} ${pad}: the whole name`);
      assert.equal(ownerOutboundJoins(ownerDoc(name)), joins, `${name.slice(0, 12)} ${pad}: the one the record carries`);
    }
  }
});

test('a cut name joins only where the whole name joins, whatever the name is made of', () => {
  // Names built from the pieces that decide the rules, cut through normaliseRecord at every
  // kind of place: whenever the cut record joins, the whole name must join too. The pieces
  // are picked by mulberry32: the old `(seed * 1103515245 + 12345) & 0x7fffffff` repeats in
  // its low bits, so with 48 pieces `% pieces.length` reached only 10 of them (51 now).
  const pieces = ['bona', 'Bona', 'BONA', 'بونا', 'fide', 'fides', 'fi', 'f', 'fid', 'nza', 'x', 'é', 'ſ', ' ', ' ',
    '_', '-', '.', '-W003', '-005', 'W', '1', '٤', '\u0301', 'ت', 'BONA-W003', 'BONA-005', 'pdf', '(', 'ب', 'bon', 'de', 's',
    'brochure', 'Brochure', 'floor', 'Plan', 'price', 'list', 'بروشور', 'مخطط', 'قائمة', 'الأسعار', 'X', 'TK', 'tk', 'تي', 'كي',
    'تى', 'كى', 'T.K.'];
  let seed = 20260928;
  const next = () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
  let cuts = 0;
  let cutJoins = 0;
  let keptOutByTk = 0;
  let keptOutByBona = 0;
  for (let i = 0; i < 4000; i += 1) {
    let name = `${'x'.repeat(60 + (next() % 45))} `;
    while (Array.from(name).length < 125 + (next() % 15)) name += pieces[next() % pieces.length];
    const rec = ownerDoc(name);
    if (!rec.fileNameTruncated) continue;
    cuts += 1;
    // Would have joined but for TK, or our name, in the part of the whole name the cut hid.
    if (rec.fileNameTk && ownerOutboundJoins({ ...rec, fileNameTk: false })) keptOutByTk += 1;
    if (rec.fileNameBona && ownerOutboundJoins({ ...rec, fileNameBona: false })) keptOutByBona += 1;
    if (!ownerOutboundJoins(rec)) continue;
    cutJoins += 1;
    const whole = name.replace(/\s+/g, ' ').trim();
    assert.equal(ownerOutboundJoins(wholeDoc(whole)), true, JSON.stringify(name));
  }
  assert.ok(cuts > 3900, `the names are cut (${cuts})`);
  assert.ok(cutJoins > 150, `and a cut name can still join (${cutJoins})`);
  assert.ok(keptOutByTk > 2, `and TK in the whole name keeps some out (${keptOutByTk})`);
  assert.ok(keptOutByBona > 50, `and so does our name (${keptOutByBona})`);
});

test('a cut name joins by a document word and a property word only where the whole name joins', () => {
  // The same sweep for the words the owner's answer of 2026-09-28 added: a floor plan, price
  // list … joins only with a property word, and in a cut name each of the two must be whole
  // inside what is read (…Villa|ger, …Land|scape, …floor plan|ner). Brochures, ids, TK and
  // Bona are left out here (the sweep above has them), so every cut join is by the pair.
  const pieces = ['floor', 'plan', 'Plan', 'plans', 'floor plan', 'price_list', 'price', 'list', 'payment', 'master', 'fact', 'sheet',
    'مخطط', 'مخططات', 'كتيب', 'قائمة', 'أسعار', 'الأسعار', 'villa', 'Villa', 'villas', 'unit', 'land', 'Land', 'scape', 'ger', 'ity',
    'y', 's', 'X', 'ſ', 'فيلا', 'الشقق', 'شقة', 'أرض', 'ال', 'ات', 'ي', 'x', ' ', ' ', ' ', ' ', ' ', ' ', '_', '_', '-', '.', '1', '٤', '\u0301'];
  let seed = 20260929;
  const next = () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
  let cuts = 0;
  let cutJoins = 0;
  let missedAtCut = 0;
  for (let i = 0; i < 3000; i += 1) {
    let name = `${'x'.repeat(30 + (next() % 60))} `;
    while (Array.from(name).length < 125 + (next() % 15)) name += pieces[next() % pieces.length];
    const rec = ownerDoc(name);
    if (!rec.fileNameTruncated) continue;
    cuts += 1;
    const whole = ownerOutboundJoins(wholeDoc(name.replace(/\s+/g, ' ').trim()));
    if (ownerOutboundJoins(rec)) {
      cutJoins += 1;
      assert.equal(whole, true, JSON.stringify(name));
    } else if (whole) {
      missedAtCut += 1;
    }
  }
  assert.ok(cuts > 2900, `the names are cut (${cuts})`);
  assert.ok(cutJoins > 30, `a cut name can join by the pair (${cutJoins})`);
  // A pair the cut reaches is not read: a missed join, never a wrong one (the owner's list catches it, D17).
  assert.ok(missedAtCut > 30, `and some whole names join where the cut one does not (${missedAtCut})`);
});

test('any truthy cut flag reads the name as cut: that only ever means fewer joins', () => {
  const doc = (fileName, over = {}) => ({ fileName, fileNameTk: false, fileNameBona: false, media: '[document: …]', ...over });
  const name = `${'x'.repeat(100)} Brochure`;
  assert.equal(ownerOutboundJoins(doc(name)), true, 'uncut, it ends with the word');
  for (const fileNameTruncated of [true, 1, 'yes']) {
    assert.equal(ownerOutboundJoins(doc(name, { fileNameTruncated })), false, String(fileNameTruncated));
  }
  assert.equal(ownerOutboundJoins(doc(`Villa_Brochure ${'x'.repeat(100)}`, { fileNameTruncated: true })), true, 'far from the cut, the word counts');
  assert.equal(ownerOutboundJoins(doc(`BONA-W003 ${'x'.repeat(100)}`, { fileNameTruncated: true })), true, 'and so does a listing id');
  assert.equal(ownerOutboundJoins(doc(`bona-real-estate.com ${'x'.repeat(100)}`, { fileNameTruncated: true })), false, 'a site link is not read in a cut name');
  assert.equal(ownerOutboundJoins(doc(`bona-real-estate.com ${'x'.repeat(100)}`)), true, 'it is in a whole one');
  // A document word that needs a property word needs it inside what is read, and whole there.
  assert.equal(ownerOutboundJoins(doc(`Villa floor plan ${'x'.repeat(100)}`, { fileNameTruncated: true })), true, 'both far from the cut');
  assert.equal(ownerOutboundJoins(doc(`Floor plan ${'x'.repeat(95)} Villa`, { fileNameTruncated: true })), false, 'the property word sits in what is not read');
  assert.equal(ownerOutboundJoins(doc(`Floor plan ${'x'.repeat(95)} Villa`)), true, 'it is read in a whole one');
  // "…Land" at the end of what is read may be "…Landscape": nothing after it inside what is read.
  const land = `Floor plan ${'x'.repeat(84)} Landscape_garden.pdf`;
  assert.equal(ownerOutboundJoins(doc(land, { fileNameTruncated: true })), false, 'Land at the edge of what is read');
  assert.equal(ownerOutboundJoins(doc(`${land.slice(0, -16)}`)), true, 'read as a whole name, it would join');
});

/* ---------------- property words (D17) ---------------- */

test('property words come out as the forms the owner\'s list shows: each once, in order, at most eight', () => {
  assert.equal(MAX_PROPERTY_WORDS, 8);
  for (const [text, words] of [
    ['عندكم شقة للإيجار؟', ['شقة', 'إيجار']],
    ['the villa is 3M', ['villa']],
    ['villa for sale', ['villa', 'for sale']],
    ['Villas and apartments for rent, 300m², 4 bedrooms', ['villa', 'apartment', 'rent']],
    ['A rental? Two rentals, 2 properties, one property', ['rent', 'property']],
    ['Real-estate, real estate, RealEstate', ['real estate']],
    ['FOR SALE: DUPLEX penthouse Town House', ['for sale', 'duplex', 'penthouse', 'townhouse']],
    ['الفيلا فله فلل فلة فيلا', ['فيلا']],
    ['شقه، الشقق، شقق', ['شقة']],
    ['ايجار الإيجار للايجار للإيجار', ['إيجار']],
    ['أرض للبيع', ['للبيع']],
    ['عقار العقارات دوبلكس البنتهاوس', ['عقار', 'دوبلكس', 'بنتهاوس']],
    ['تاون هاوس في مجمع سكني', ['تاون هاوس']],
    ['villa apartment rent for sale real estate property duplex penthouse townhouse', ['villa', 'apartment', 'rent', 'for sale', 'real estate', 'property', 'duplex', 'penthouse']],
  ]) {
    assert.deepEqual(propertyWordsIn(text), words, text);
  }
});

test('every form of a property word counts on its own, singular and plural, with and without the article', () => {
  // One string with several forms passes as soon as any one of them matches, so each form
  // is asked alone: "عقار العقارات" once hid a pattern that needed the plural (عقارا + ت?).
  for (const [word, forms] of [
    ['villa', ['villa', 'villas']],
    ['apartment', ['apartment', 'apartments']],
    ['rent', ['rent', 'rental', 'rentals', 'for rent']],
    ['for sale', ['for sale', 'for-sale', 'for_sale']],
    ['real estate', ['real estate', 'real-estate', 'realestate']],
    ['property', ['property', 'properties']],
    ['duplex', ['duplex', 'duplexes']],
    ['penthouse', ['penthouse', 'penthouses']],
    ['townhouse', ['townhouse', 'town house', 'townhouses']],
    ['فيلا', ['فيلا', 'الفيلا', 'فلل', 'الفلل', 'فلة', 'فله']],
    ['شقة', ['شقة', 'الشقة', 'شقه', 'شقق', 'الشقق']],
    ['إيجار', ['إيجار', 'ايجار', 'الإيجار', 'للإيجار', 'للايجار']],
    ['للبيع', ['للبيع']],
    ['عقار', ['عقار', 'العقار', 'عقارات', 'العقارات']],
    ['دوبلكس', ['دوبلكس', 'الدوبلكس']],
    ['بنتهاوس', ['بنتهاوس', 'البنتهاوس']],
    ['تاون هاوس', ['تاون هاوس', 'تاونهاوس']],
  ]) {
    for (const form of forms) assert.deepEqual(propertyWordsIn(form), [word], form);
  }
});

test('the property words are strong real-estate terms only, and the privacy page names exactly them (D17)', () => {
  assert.deepEqual(PROPERTY_WORD_FORMS, [
    'villa', 'apartment', 'rent', 'for sale', 'real estate', 'property', 'duplex', 'penthouse', 'townhouse',
    'فيلا', 'شقة', 'إيجار', 'للبيع', 'عقار', 'دوبلكس', 'بنتهاوس', 'تاون هاوس',
  ]);
  assert.ok(Object.isFrozen(PROPERTY_WORD_FORMS));
  // The page promises that only these words keep a chat (src/data/privacy.json): it lists
  // every one of them, in both languages, and none of the words the code no longer counts.
  const policy = JSON.parse(fs.readFileSync(new URL('../../../src/data/privacy.json', import.meta.url), 'utf8'));
  const s = policy.sections.find((x) => x.id === 'whatsapp-conversations');
  const exception = { en: s.body.en.find((p) => p.startsWith('There is one narrow exception')), ar: s.body.ar.find((p) => p.startsWith('وهناك استثناء محدود')) };
  for (const locale of ['en', 'ar']) {
    assert.ok(exception[locale], `${locale}: the exception paragraph`);
    for (const word of PROPERTY_WORD_FORMS) assert.ok(exception[locale].includes(word), `${locale} lists ${word}`);
    for (const word of ['land', 'flat', 'plot', 'compound', 'listing', 'bedroom', 'broker', 'lease', 'commission', 'sqm']) {
      assert.doesNotMatch(exception[locale], new RegExp(`\\b${word}`, 'i'), `${locale} does not list ${word}`);
    }
    for (const word of ['أرض', 'غرفة', 'صك', 'سمسار', 'عمولة']) assert.ok(!exception[locale].includes(word), `${locale} does not list ${word}`);
  }
});

test('the privacy page says what a property document is: a brochure, or another kind only with a property word; any kind on a document the owner sends (D17)', () => {
  // The poller's rule (wa-poller.mjs candidateWordsOf, mentionsPropertyDocument): a plan, a
  // price list or a booklet on its own keeps nothing, so the page must not suggest it does.
  const policy = JSON.parse(fs.readFileSync(new URL('../../../src/data/privacy.json', import.meta.url), 'utf8'));
  const s = policy.sections.find((x) => x.id === 'whatsapp-conversations');
  const en = s.body.en.find((p) => p.startsWith('There is one narrow exception'));
  const ar = s.body.ar.find((p) => p.startsWith('وهناك استثناء محدود'));
  assert.doesNotMatch(en, /such as a brochure, a floor plan or a price list/, 'a floor plan or a price list alone does not keep a chat');
  assert.match(en, /a brochure, or a floor plan, plan, price list, payment plan, master plan, fact sheet or booklet mentioned together with a property/);
  assert.match(en, /A plan, a price list or a booklet mentioned on its own does not count/);
  assert.match(en, /sends a document whose name or caption calls it a brochure, floor plan, plan, price list, payment plan, master plan, fact sheet or booklet/);
  assert.doesNotMatch(ar, /مستند عقاري مثل بروشور أو مخطط أو قائمة أسعار/);
  assert.match(ar, /بروشور، أو مخطط أو قائمة أسعار أو خطة دفع أو نشرة معلومات أو كتيب مذكوراً مع عقار/);
  assert.match(ar, /ولا يكفي ذكر مخطط أو قائمة أسعار أو كتيب وحده/);
  assert.match(ar, /أرسل مالك بونا مستنداً يصفه اسمه أو النص المرفق به بأنه بروشور أو مخطط أو قائمة أسعار أو خطة دفع أو نشرة معلومات أو كتيب/);
});

test('a property word is found by its own named group, never by its position among the groups', () => {
  // Labels by position would all shift the day a word's source gains a plain ( ) group.
  const m = PROPERTY_WORD_RE.exec('a duplex for sale');
  assert.ok(m?.groups, 'one named group per word');
  assert.deepEqual(Object.keys(m.groups).filter((k) => m.groups[k] !== undefined), ['w6'], 'duplex is the seventh word');
  assert.ok(Object.keys(m.groups).every((k, i) => k === `w${i}`), 'named w0, w1 … in the table\'s order');
  assert.deepEqual(propertyWordsIn('a duplex for sale'), ['duplex', 'for sale']);
});

test('only strong property terms count: everyday words, words that only contain one, and non-strings are no property words', () => {
  // Everyday words that are also real-estate words (land, flat, plot, compound, listing,
  // bedroom, broker, lease, commission, sqm; أرض, غرفة, مخطط, صك, سمسار, عمولة) are not
  // on the list: "My flight will land at 9" is nobody's property enquiry.
  for (const text of ['My flight will land at 9', 'flat tyre', 'غرفة النوم', 'a plot twist', 'compound interest', 'the listing', '4 bedrooms',
    'my broker', 'car lease', 'sales commission', '250 sqm', '300m²', 'أرض', 'ارض', 'الأراضي', 'مجمع سكني', 'مخطط الشاطئ', 'الصك', 'السمسار', 'العمولة',
    'for', 'sale', 'on sale', 'he rents', 'forsale',
    'Hello', 'villager', 'parent', 'current', 'island', 'landlord', 'flatter', 'rented a car', 'plotted',
    'commissioner', 'broken', 'propertyX', 'km²', 'طحت على الأرض', 'الغرفة باردة', 'والفيلا', 'بالإيجار', 'كوبونات', 'Bona', '']) {
    assert.deepEqual(propertyWordsIn(text), [], text);
    assert.equal(PROPERTY_WORD_RE.test(text), false, text);
  }
  for (const text of [null, undefined, 42, {}, ['villa']]) assert.deepEqual(propertyWordsIn(text), [], String(text));
  assert.equal(PROPERTY_WORD_RE.test('a villa'), true);
  assert.equal(PROPERTY_WORD_RE.lastIndex, 0, 'no /g: nothing is carried over');
});

/* ---------------- time ---------------- */

/**
 * How long `call` takes, in milliseconds: the fastest of five runs of it. One run's wall
 * time can be stretched by a garbage-collection pause or by other processes loading the
 * machine (a full-suite run under CPU load once failed a 100 ms check on a single run, and
 * the fastest of three once took 1,087 ms against a 500 ms limit while another heavy
 * process loaded the machine), so a time check takes the minimum of five runs of the same
 * call and allows 2,000 ms (`TIME_LIMIT_MS`). It stops at the first run under the limit:
 * the minimum of all five would be under it too, so the verdict is the same in a fifth of
 * the time. That still catches what the check is for: a quadratic pattern such as `\s+x`
 * takes about 8 s on a 200,000-character input and the old cubic Ref pattern minutes, on
 * every run, while these linear ones stay in single digits.
 */
const TIME_LIMIT_MS = 2_000;
function fastestOfFive(call) {
  let fastest = Infinity;
  for (let run = 0; run < 5 && fastest >= TIME_LIMIT_MS; run += 1) {
    const started = performance.now();
    call();
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
}

test('no text makes the rules slow: every input is read in linear time', () => {
  // Every inbound WhatsApp text reaches inboundSignal and every owner message
  // ownerOutboundJoins, up to 65,536 characters. Each case below defeated a pattern with a
  // run that could be re-read from many places; at 200,000 characters a quadratic pattern
  // takes seconds (`fastestOfFive`) while a linear one stays in single digits.
  const fill = (unit, n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const inputs = (n) => [
    `Ref${' '.repeat(n)}x`, `Ref${'\n'.repeat(n)}x`, `Ref${'\u00A0'.repeat(n)}x`,
    `Ref BONA${' '.repeat(n / 2)}-${' '.repeat(n / 2)}x`, fill('Ref BONA - ', n), fill('Ref BONA · K7Q2X', n),
    `bona${' '.repeat(n)}x`, `bona${fill('_.- ', n)}x`, fill('bona ', n), fill('bona fi', n), fill('bona_', n),
    fill('بونا ', n), fill('BONA-W00', n), fill('BONA-W003٤', n),
    `${fill('bona.azoz.uk:', n)}@`, `${fill('bona-real-estate.com:', n)}@`, `${fill('www.bona.azoz.uk:', n)}@`,
    fill('bona.azoz.uk.', n), fill('bona.azoz.uk@', n), fill('bona.azoz.uk_', n),
    fill('floor ', n), fill('floor-', n), fill('floor_plan', n), fill('brochur', n), fill('brochureX', n), fill('price ', n),
    fill('payment_', n), fill('fact sheet', n), fill('قائمة ', n), fill('جدول ال', n), fill('خطة ', n), fill('البروشور', n), fill('كتي', n),
    fill('floor plan ', n), fill('price list_', n), fill('قائمة أسعار ', n), fill('villa', n), fill('villax', n), fill('town ', n),
    fill('town_house', n), fill('propert', n), fill('الفيل', n), fill('تاون ', n), fill('مجمع ', n), fill('الشقق', n), fill('floor plan land', n),
    fill('tk', n), fill('tk ', n), fill('tk-estate', n), fill('tk_', n), fill('تي ', n), fill('تي', n), fill('تيكي', n),
    fill('t.k', n), fill('t.', n), fill('تى ', n), fill('تى', n), fill('تيكى', n),
    fill('تي  كي', n), fill('تى  كى', n), fill('تي - كي', n), fill('تي    ', n), fill('تي - ', n), fill('تى _ .', n),
    `تي${' '.repeat(n)}كي`, `T${'\u200B'.repeat(n)}K`, fill('T\u200C', n), fill('\u200D ', n), fill(' \uFEFF\n', n),
    fill('bona.azoz.uk_', n), fill('bona-real-estate.com.', n), `bona-real-estate.com${'.pdf'.repeat(n / 4)}`,
    `bona.azoz.uk_${'x'.repeat(n)}`, `bona.azoz.uk_${'_'.repeat(n)}.pdf`, fill('bona-real-estate.com_x', n), fill('bona.azoz.uk_x ', n),
    fill('villa ', n), fill('villax', n), fill('real ', n), fill('town-', n), fill('rent', n), fill('الفي', n), fill('ال', n),
    fill('تاون ', n), fill('مجمع ', n), fill('شقة ', n),
  ];
  const calls = [
    ['inboundSignal', (s) => inboundSignal({ text: s })],
    ['ownerOutboundJoins text', (s) => ownerOutboundJoins({ text: s })],
    ['ownerOutboundJoins caption', (s) => ownerOutboundJoins({ text: s, media: '[document: x.pdf]' })],
    ['ownerOutboundJoins name', (s) => ownerOutboundJoins({ fileName: s, media: '[document: x.pdf]' })],
    ['ownerOutboundJoins cut name', (s) => ownerOutboundJoins({ fileName: s, fileNameTruncated: true, fileNameTk: false, fileNameBona: false, media: '[document: x.pdf]' })],
    ['isTkDocument', (s) => isTkDocument({ text: s, fileName: s, media: '[document: x.pdf]' })],
    ['PROPERTY_DOC_RE', (s) => PROPERTY_DOC_RE.test(s)],
    ['BROCHURE_RE', (s) => BROCHURE_RE.test(s)],
    ['QUALIFIED_DOC_RE', (s) => QUALIFIED_DOC_RE.test(s)],
    ['PROPERTY_NOUN_RE', (s) => PROPERTY_NOUN_RE.test(s)],
    ['TK_RE', (s) => TK_RE.test(s)],
    ['namesTk', (s) => namesTk(s)],
    ['namesBona', (s) => namesBona(s)],
    ['propertyWordsIn', (s) => propertyWordsIn(s)],
    ['PROPERTY_WORD_RE', (s) => PROPERTY_WORD_RE.test(s)],
  ];
  for (const n of [20_000, 200_000]) {
    for (const [i, s] of inputs(n).entries()) {
      for (const [label, call] of calls) {
        const ms = fastestOfFive(() => call(s));
        assert.ok(ms < TIME_LIMIT_MS, `${label}, input ${i} × ${n}: ${ms.toFixed(1)} ms`);
      }
    }
  }
});

/* ---------------- ad evidence (D15) ---------------- */

/**
 * The entry points every ad_meta lead in the live db came from (2026-09-29: 11, 4 and 2 of
 * the 17): a wa.me link, WhatsApp's own search, a tapped phone number. Organic, all of them.
 */
const ORGANIC_ENTRY = ['click_to_chat_link', 'global_search_new_chat', 'phone_number_hyperlink']
  .map((source) => ({ entry_point_conversion_source: source, entry_point_conversion_app: 'whatsapp' }));
/** A real click-to-WhatsApp ad, as lib/wa-poller.mjs `adMetaOf` keeps it. */
const CTWA = { source_id: '120210987654321', source_type: 'ad', source_app: 'instagram', source_url: 'https://fb.me/ad', ctwa_clid: 'ARZ1xyz', conversion_source: 'FB_Ads' };

test('only real ad evidence is ad context: a click id, a conversion source, a ctwa_ad entry point or an ad source type (D15)', () => {
  for (const meta of ORGANIC_ENTRY) assert.equal(hasAdEvidence(meta), false, meta.entry_point_conversion_source);
  assert.equal(hasAdEvidence(CTWA), true);
  for (const meta of [{ ctwa_clid: 'ARZ1xyz' }, { conversion_source: 'FB_Ads' }, { entry_point_conversion_source: 'ctwa_ad' }, { source_type: 'ad' }, { source_type: 'AD' },
    { source_type: 'Ads' }, { source_type: ' ad\t' }]) {
    assert.equal(hasAdEvidence(meta), true, JSON.stringify(meta));
  }
  // The source type is the token "ad" (or "ads"), not any word with the two letters in it.
  for (const source_type of ['broadcast', 'thread', 'upload', 'shadow', 'download', 'ad_hoc', 'adult', 'lead', 'a d', 'ad ad', '\u00a0ad', 'ad\u200b', '']) {
    assert.equal(hasAdEvidence({ source_type }), false, JSON.stringify(source_type));
  }
  for (const meta of [
    null, undefined, 'ctwa_ad', {}, { external_ad: true }, { utm: { utm_source: 'facebook' } }, { source_type: 'post', source_app: 'instagram' },
    { ctwa_clid: '' }, { ctwa_clid: '   ' }, { ctwa_clid: 123 }, { conversion_source: '' }, { entry_point_conversion_source: 'CTWA_AD' },
    { entry_point_conversion_app: 'facebook' }, { source_id: '120210987654321' },
  ]) assert.equal(hasAdEvidence(meta), false, JSON.stringify(meta));
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

test('a guess — the word, or a keyword, click-window or ad-context match with no ad evidence — makes it unsure', () => {
  for (const current of OPEN) {
    for (const method of METHODS) assert.equal(nextInboxState(current, { signal: 'unsure', method }), 'unsure', `${current} unsure ${method}`);
    // An ad_meta lead whose message carried no ad evidence (an organic entry point) comes
    // with no certain signal: it is the owner's to decide.
    for (const method of ['keyword', 'time_window', 'ad_meta']) assert.equal(nextInboxState(current, { signal: null, method }), 'unsure', `${current} ${method}`);
  }
});

test('with no signal and no guessing rule the state is left as it was', () => {
  for (const method of [null, 'ref', 'phone', 'concierge', 'form']) {
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
