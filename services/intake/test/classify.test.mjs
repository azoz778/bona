import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyPdf, normaliseArabic, PROPERTY_RE, SENSITIVE_RE } from '../lib/classify.mjs';

const pdf = (over = {}) => ({ ok: true, pages: 8, text: '', embeddedImageCount: 20, candidates: [], ...over });

describe('classifyPdf — default deny', () => {
  it('rejects an unreadable PDF', () => {
    const v = classifyPdf({ ok: false, error: 'unreadable PDF: bad xref' });
    assert.equal(v.ok, false);
    assert.match(v.reason, /unreadable/);
  });

  it('rejects a PDF with no property signals at all', () => {
    const v = classifyPdf(pdf({ text: 'Minutes of the annual general meeting. Attendance list follows.' }));
    assert.equal(v.ok, false);
    assert.match(v.reason, /default-deny/);
  });

  it('rejects anything short', () => {
    const v = classifyPdf(pdf({ pages: 1, text: 'Villa for sale, 5 bedrooms' }));
    assert.equal(v.ok, false);
    assert.match(v.reason, /1 page/);
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

  it('accepts an image-heavy design PDF with no text layer', () => {
    const v = classifyPdf(pdf({ text: '', pages: 12, embeddedImageCount: 40 }));
    assert.equal(v.ok, true);
    assert.match(v.reason, /image-heavy/);
  });

  it('does not accept a text-free PDF that has no images either', () => {
    assert.equal(classifyPdf(pdf({ text: '', pages: 12, embeddedImageCount: 2 })).ok, false);
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
