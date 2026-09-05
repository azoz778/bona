// Default-deny PDF gate (pattern from ~/kian-pipeline/kian_group_intake.py `classify_pdf`).
// A PDF is only accepted when it clearly looks like a property brochure. Everything else —
// invoices, IDs, contracts, bank statements, tax certificates — is rejected and NEVER copied
// into the repo. The AI pass is a second, independent gate; this one is cheap and runs first.

export const SENSITIVE_RE = new RegExp(
  [
    // Arabic
    'فاتورة', 'إيصال', 'سند قبض', 'سند صرف', 'كشف حساب', 'حوالة', 'تحويل بنكي', 'مبلغ مستلم',
    'الهوية الوطنية', 'بطاقة الهوية', 'سجل تجاري', 'شهادة تسجيل', 'ضريبة القيمة المضافة',
    'الرقم الضريبي', 'رخصة', 'جواز سفر', 'راتب', 'شيك', 'اتفاقية', 'عقد إيجار', 'عقد بيع',
    'صك', 'وكالة شرعية', 'كشف الحساب',
    // English
    'invoice', 'vat certificate', 'vat registration', 'receipt',
    'bank statement', 'account statement', 'estatement', 'iban', 'swift code',
    'passport', 'national id', 'identity card', 'commercial registration',
    'payslip', 'salary', 'cheque', 'purchase agreement', 'lease agreement',
    'non[- ]disclosure', 'power of attorney', 'terms and conditions',
  ].join('|'),
  'i',
);

// Positive brochure signals (Arabic + English). Deliberately property-specific.
export const PROPERTY_RE = new RegExp(
  [
    'مشروع', 'فيلا', 'شقة', 'شقق', 'بنتهاوس', 'دوبلكس', 'قصر', 'عمارة', 'أرض', 'مخطط',
    'غرف نوم', 'غرفة نوم', 'دورات مياه', 'دورة مياه', 'المساحة', 'صالة', 'مجلس', 'مطبخ',
    'الواجهة', 'للبيع', 'للإيجار', 'حي ', 'الدور', 'ريزيدنس', 'رزيدينس', 'سكني',
    'villa', 'apartment', 'penthouse', 'duplex', 'mansion', 'residence', 'townhouse',
    'bedroom', 'bathroom', 'sqm', 'sq\\.? ?m', 'square met', 'floor plan', 'for sale',
    'for rent', 'freehold', 'off[- ]plan', 'plot', 'majlis', 'living room', 'master suite',
    'developer', 'district', 'built[- ]up area',
  ].join('|'),
  'i',
);

const MIN_PAGES = 2;

/** Fold Arabic presentation forms back to base letters (see extract_pdf.py::collapse). */
export function normaliseArabic(s) {
  return String(s ?? '').normalize('NFKC').replace(/\u0640/g, '');
}

/**
 * @param {object} extraction  output of extract_pdf.py
 * @param {object} [opts]      { fileName, minPages }
 * @returns {{ok: boolean, reason: string}}
 */
export function classifyPdf(extraction, opts = {}) {
  const minPages = opts.minPages ?? MIN_PAGES;
  if (!extraction || extraction.ok === false) {
    return { ok: false, reason: extraction?.error || 'unreadable PDF' };
  }
  const text = normaliseArabic(extraction.text || '');
  const pages = Number(extraction.pages || 0);
  // File names use hyphens/underscores where the phrases use spaces ("bank-statement.pdf").
  const name = normaliseArabic(opts.fileName || '').replace(/[-_.]+/g, ' ');

  const sensitive = SENSITIVE_RE.exec(text) || SENSITIVE_RE.exec(name);
  if (sensitive) return { ok: false, reason: `looks like a private document ("${sensitive[0]}") — not published` };

  if (pages < minPages) return { ok: false, reason: `only ${pages} page${pages === 1 ? '' : 's'} — too short for a brochure` };

  const hit = PROPERTY_RE.exec(text);
  if (hit) return { ok: true, reason: `property brochure signals found ("${hit[0]}")` };

  // Image-heavy design PDF (Canva/Illustrator) with no extractable text layer at all.
  // Deliberately narrow: a document that HAS readable text but no property words is a
  // document about something else, and default-deny means it stays off the website.
  const images = Number(extraction.embeddedImageCount || 0);
  if (text.length < 40 && images >= pages * 2) {
    return { ok: true, reason: `image-heavy design PDF (${images} images / ${pages} pages)` };
  }

  return { ok: false, reason: 'no property-brochure signals — rejected (default-deny)' };
}
