import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyPdf, HARD_DENY_RE, normaliseArabic, propertySignals, PROPERTY_RE, SENSITIVE_RE, SOFT_DENY_RE,
} from '../lib/classify.mjs';

const pdf = (over = {}) => ({ ok: true, pages: 8, text: '', embeddedImageCount: 20, candidates: [], ...over });

describe('classifyPdf — default deny', () => {
  it('rejects an unreadable PDF', () => {
    const v = classifyPdf({ ok: false, error: 'unreadable PDF: bad xref' });
    assert.equal(v.ok, false);
    assert.match(v.reason, /unreadable/);
  });

  it('rejects a PDF with no property signals at all', () => {
    const v = classifyPdf(pdf({ text: 'Minutes of the annual general meeting. Attendance list follows. '.repeat(20) }));
    assert.equal(v.ok, false);
    assert.match(v.reason, /default-deny/);
  });

  it('accepts a one-page flyer with property signals (the AI gate decides) and still rejects an empty document', () => {
    const v = classifyPdf(pdf({ pages: 1, text: 'Villa for sale, 5 bedrooms' }));
    assert.equal(v.ok, true);
    const z = classifyPdf(pdf({ pages: 0, text: '' }));
    assert.equal(z.ok, false);
  });

  const privateDocs = [
    ['a tax invoice', 'Tax Invoice No 00018 — VAT 15% — total SAR 237,199'],
    ['a bank statement', 'Account statement — IBAN SA3410000001400036697006'],
    ['an Arabic receipt', 'سند قبض بمبلغ وقدره خمسون ألف ريال'],
    ['an ID', 'الهوية الوطنية — تاريخ الميلاد'],
    ['a contract', 'This purchase agreement is entered into between the parties'],
    ['a commercial registration', 'سجل تجاري رقم ٤٠٣٠...'],
    ['a payslip', 'Payslip — salary for the month of August'],
  ];
  for (const [label, text] of privateDocs) {
    it(`rejects ${label} even when it also mentions a property`, () => {
      const v = classifyPdf(pdf({ text: `${text}. Villa, 5 bedrooms, 600 sqm.` }));
      assert.equal(v.ok, false, `${label} must never be published`);
      assert.match(v.reason, /private document/);
    });
  }

  it('rejects on the file name alone', () => {
    const v = classifyPdf(pdf({ text: 'Villa for sale in Jeddah, 5 bedrooms' }), { fileName: 'bank-statement-august.pdf' });
    assert.equal(v.ok, false);
  });

  it('accepts an English brochure', () => {
    const v = classifyPdf(pdf({ text: 'A five bedroom villa in Al Khalidiyah. 600 sqm built-up area, for sale.' }));
    assert.equal(v.ok, true);
  });

  it('accepts an Arabic brochure', () => {
    const v = classifyPdf(pdf({ text: 'مشروع سكني في حي النزهة — شقة بمساحة ١٧٤ متراً مربعاً وثلاث غرف نوم' }));
    assert.equal(v.ok, true);
  });

  it('does not accept a text-free PDF that has no images either', () => {
    assert.equal(classifyPdf(pdf({ text: '', pages: 12, embeddedImageCount: 2 })).ok, false);
  });
});

// Finding 7 — an image-only brochure (Kian-Project-125.pdf is a real one) used to be
// rejected here with "no property-brochure signals". It must now reach the AI instead,
// which is the gate that actually decides.
describe('classifyPdf — brochures with no text layer', () => {
  const imageOnly = pdf({ text: 'A 4 2 138 990,000', pages: 14, embeddedImageCount: 84, candidates: new Array(13) });

  it('defers a sparse, image-heavy PDF to the AI instead of deciding locally', () => {
    const v = classifyPdf(imageOnly, { fileName: 'Kian-Project-125.pdf' });
    assert.equal(v.ok, true);
    assert.equal(v.imageOnly, true);
    assert.match(v.reason, /no readable text layer/);
    assert.match(v.reason, /AI/, 'the reason must say the AI decides, not that this was accepted');
  });

  it('does not mark a brochure with a real text layer as image-only', () => {
    const v = classifyPdf(pdf({ text: 'A five bedroom villa in Al Khalidiyah. '.repeat(40), pages: 8, embeddedImageCount: 30 }));
    assert.equal(v.ok, true);
    assert.equal(v.imageOnly, false);
  });

  it('defers a one-page text-free PDF to the AI gate instead of refusing it locally', () => {
    const v = classifyPdf(pdf({ text: '', pages: 1, embeddedImageCount: 40 }));
    assert.equal(v.ok, true);
    assert.equal(v.imageOnly, true);
  });

  it('still refuses a text-free document whose few words are a hard deny', () => {
    const v = classifyPdf(pdf({ text: 'Payslip August', pages: 6, embeddedImageCount: 40 }));
    assert.equal(v.ok, false);
    assert.match(v.reason, /private document/);
  });
});

// Finding 8 — two tiers. Absolute denials stay absolute; the words that legitimately show
// up inside a developer's brochure only deny a document with no property content of its own.
describe('classifyPdf — sensitive keyword tiers', () => {
  const withProperty = (t) => pdf({ text: `${t} A five bedroom villa in Al Khalidiyah, 600 sqm built-up area, for sale, with a majlis and a floor plan. `.repeat(3) });

  for (const word of ['passport', 'جواز سفر', 'national id', 'الهوية الوطنية', 'كشف حساب', 'bank statement', 'payslip', 'invoice']) {
    it(`hard-denies "${word}" however much property content surrounds it`, () => {
      const v = classifyPdf(withProperty(word));
      assert.equal(v.ok, false, `${word} must be absolute`);
      assert.match(v.reason, /private document/);
    });
  }

  for (const word of ['صك', 'رخصة', 'عقد إيجار', 'terms and conditions']) {
    it(`lets a real brochure through even though it prints "${word}"`, () => {
      const v = classifyPdf(withProperty(word));
      assert.equal(v.ok, true, `${word} must not deny a document that is plainly a brochure`);
    });
    it(`denies "${word}" when the document has no property content`, () => {
      const v = classifyPdf(pdf({ text: `${word} — page 1 of 8. `.repeat(20) }));
      assert.equal(v.ok, false);
    });
  }

  it('denies an IBAN that is the SUBJECT of the document', () => {
    assert.equal(classifyPdf(pdf({ text: 'IBAN SA3410000001400036697006 — account details' })).ok, false);
    assert.equal(classifyPdf(pdf({ text: 'anything' }), { fileName: 'my-iban.pdf' }).ok, false);
  });

  it('lets a brochure print the developer\'s IBAN halfway down', () => {
    const body = 'A five bedroom villa in Al Khalidiyah, 600 sqm built-up area, for sale. Majlis, living room, floor plan. '.repeat(4);
    const v = classifyPdf(pdf({ text: `${body} Reservation deposit: IBAN SA0380000000608010167519.` }));
    assert.equal(v.ok, true);
  });

  it('counts distinct property words', () => {
    assert.ok(propertySignals('villa bedroom sqm majlis') >= 4);
    assert.equal(propertySignals('minutes of the meeting'), 0);
  });

  it('keeps the two tiers disjoint and both inside SENSITIVE_RE', () => {
    for (const word of ['passport', 'invoice']) {
      assert.ok(HARD_DENY_RE.test(word) && SENSITIVE_RE.test(word));
      assert.ok(!SOFT_DENY_RE.test(word), `${word} must not be in the soft tier`);
    }
    for (const word of ['صك', 'terms and conditions']) {
      assert.ok(SOFT_DENY_RE.test(word) && SENSITIVE_RE.test(word));
      assert.ok(!HARD_DENY_RE.test(word), `${word} must not be in the hard tier`);
    }
  });
});

describe('normaliseArabic', () => {
  // Designer PDFs store Arabic as Presentation Forms-B with tatweel padding.
  // "\u0645\u0634\u0631\u0648\u0639" as Presentation Forms-B with tatweel padding,
  // exactly the way Illustrator writes it into a PDF.
  const presentation = '\uFEE3\u0640\uFEB7\u0640\uFEAE\uFEEE\uFECA';
  it('folds presentation forms and strips tatweel', () => {
    assert.equal(normaliseArabic(presentation), 'مشروع');
  });
  it('lets the property regex match presentation-form text', () => {
    assert.ok(!PROPERTY_RE.test(presentation), 'raw presentation forms do not match (this is why we normalise)');
    assert.ok(PROPERTY_RE.test(normaliseArabic(presentation)));
  });
  it('is applied by classifyPdf', () => {
    assert.equal(classifyPdf(pdf({ text: presentation })).ok, true);
  });
});

describe('regex hygiene', () => {
  it('the sensitive list covers every document type the owner named', () => {
    for (const word of ['invoice', 'receipt', 'IBAN', 'passport', 'payslip', 'فاتورة', 'عقد إيجار', 'كشف حساب']) {
      assert.ok(SENSITIVE_RE.test(word), `SENSITIVE_RE should match ${word}`);
    }
  });
  it('the property list does not accidentally match a private document word', () => {
    for (const word of ['invoice', 'IBAN', 'passport']) {
      assert.ok(!PROPERTY_RE.test(word), `PROPERTY_RE should not match ${word}`);
    }
  });
});
