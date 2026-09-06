// Default-deny PDF gate (pattern from ~/kian-pipeline/kian_group_intake.py `classify_pdf`).
// A PDF only reaches the AI when it plausibly looks like a property brochure. Everything
// else — invoices, IDs, contracts, bank statements, tax certificates — is rejected and
// NEVER copied into the repo.
//
// Two tiers of sensitive keyword, because one flat list was both too strict and too loose:
//   HARD_DENY — a passport, a national ID, a bank statement, a payslip, an invoice or a tax
//               certificate is never a brochure, whatever else the page says. Absolute.
//   SOFT_DENY — صك (title deed), رخصة (licence), عقد إيجار (lease), "terms and conditions",
//               a printed IBAN line: all of these legitimately appear INSIDE a developer's
//               brochure, so they only deny when the document carries no strong property
//               signal of its own.
//
// The AI pass is a second, independent gate; this one is cheap and runs first.

const HARD_DENY = [
  // Arabic — identity, banking, payroll, tax, registration
  'جواز سفر', 'الهوية الوطنية', 'هوية وطنية', 'بطاقة الهوية', 'بطاقة هوية',
  'كشف حساب', 'كشف الحساب', 'حوالة بنكية', 'تحويل بنكي',
  'قسيمة راتب', 'مسير رواتب', 'إشعار راتب',
  'فاتورة', 'إيصال', 'سند قبض', 'سند صرف', 'مبلغ مستلم', 'شيك',
  'ضريبة القيمة المضافة', 'الرقم الضريبي', 'شهادة تسجيل', 'سجل تجاري',
  'عقد بيع', 'اتفاقية', 'وكالة شرعية',
  // English
  'passport', 'national id', 'identity card', 'id card',
  'bank statement', 'account statement', 'estatement', 'e[- ]statement', 'swift code',
  'payslip', 'pay slip', 'salary slip', 'payroll',
  'invoice', 'receipt', 'vat certificate', 'vat registration', 'tax registration',
  'commercial registration', 'zakat',
  'purchase agreement', 'non[- ]disclosure', 'power of attorney', 'cheque', 'salary',
];

// Deliberately short. Each of these has a high false-positive rate on real brochures: a
// developer prints his licence number, a title deed number, the lease terms of a rental
// unit, the terms and conditions of a reservation, and his company IBAN for the deposit.
const SOFT_DENY = [
  'صك', 'رخصة', 'عقد إيجار', 'الشروط والأحكام', 'آيبان', 'الآيبان',
  'iban', 'licence', 'license', 'lease agreement', 'terms and conditions',
];

const join = (list) => new RegExp(list.join('|'), 'i');

export const HARD_DENY_RE = join(HARD_DENY);
export const SOFT_DENY_RE = join(SOFT_DENY);
/** Kept for callers that only want "is this word sensitive at all". */
export const SENSITIVE_RE = join([...HARD_DENY, ...SOFT_DENY]);

// Positive brochure signals (Arabic + English). Deliberately property-specific.
const PROPERTY_TOKENS = [
  'مشروع', 'فيلا', 'شقة', 'شقق', 'بنتهاوس', 'دوبلكس', 'قصر', 'عمارة', 'أرض', 'مخطط',
  'غرف نوم', 'غرفة نوم', 'دورات مياه', 'دورة مياه', 'المساحة', 'صالة', 'مجلس', 'مطبخ',
  'الواجهة', 'للبيع', 'للإيجار', 'حي ', 'الدور', 'ريزيدنس', 'رزيدينس', 'سكني',
  'villa', 'apartment', 'penthouse', 'duplex', 'mansion', 'residence', 'townhouse',
  'bedroom', 'bathroom', 'sqm', 'sq\\.? ?m', 'square met', 'floor plan', 'for sale',
  'for rent', 'freehold', 'off[- ]plan', 'plot', 'majlis', 'living room', 'master suite',
  'developer', 'district', 'built[- ]up area',
];
export const PROPERTY_RE = join(PROPERTY_TOKENS);

const MIN_PAGES = 1; // one-page flyers and site plans go to the AI gate, which decides (owner sent one 2026-09-06)
/** Below this many characters per page there is effectively no text layer to read. */
export const SPARSE_CHARS_PER_PAGE = 40;
/** How many DISTINCT property words make a document's own property signal "strong". */
export const STRONG_PROPERTY_SIGNALS = 3;

/** Fold Arabic presentation forms back to base letters (see extract_pdf.py::collapse). */
export function normaliseArabic(s) {
  return String(s ?? '').normalize('NFKC').replace(/ـ/g, '');
}

/** How many distinct property words the document uses. */
export function propertySignals(text) {
  const t = String(text ?? '');
  let n = 0;
  for (const token of PROPERTY_TOKENS) if (new RegExp(token, 'i').test(t)) n += 1;
  return n;
}

/**
 * @param {object} extraction  output of extract_pdf.py
 * @param {object} [opts]      { fileName, minPages }
 * @returns {{ok: boolean, reason: string, imageOnly?: boolean, signals?: number}}
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

  const hard = HARD_DENY_RE.exec(text) || HARD_DENY_RE.exec(name);
  if (hard) return { ok: false, reason: `looks like a private document ("${hard[0]}") — not published` };

  // An IBAN is the SUBJECT of a document when it is in the file name or opens the text;
  // a developer's payment line halfway down a brochure is not.
  const ibanRe = /iban|الآيبان|آيبان/i;
  if (ibanRe.test(name) || ibanRe.test(text.slice(0, 200))) {
    return { ok: false, reason: 'looks like a private document ("IBAN") — not published' };
  }

  if (pages < minPages) return { ok: false, reason: `only ${pages} page${pages === 1 ? '' : 's'} — too short for a brochure` };

  const signals = propertySignals(text);
  const soft = SOFT_DENY_RE.exec(text) || SOFT_DENY_RE.exec(name);
  if (soft && signals < STRONG_PROPERTY_SIGNALS) {
    return { ok: false, reason: `looks like a legal or financial document ("${soft[0]}") with no property content — not published`, signals };
  }

  // A brochure designed in Canva/Illustrator often carries no text layer at all. That is
  // NOT a local accept: the page renders go to the AI, which is the gate that decides.
  const images = Number(extraction.embeddedImageCount || 0);
  const candidates = Array.isArray(extraction.candidates) ? extraction.candidates.length : 0;
  const perPage = text.length / Math.max(1, pages);
  const imageHeavy = images >= pages || candidates >= Math.max(2, Math.ceil(pages / 2)) || Boolean(extraction.rendered);
  const imageOnly = perPage < SPARSE_CHARS_PER_PAGE && imageHeavy;

  const hit = PROPERTY_RE.exec(text);
  if (hit) return { ok: true, reason: `property brochure signals found ("${hit[0]}")`, imageOnly, signals };
  if (imageOnly) {
    return {
      ok: true,
      imageOnly: true,
      signals,
      reason: `no readable text layer (${perPage.toFixed(0)} chars/page over ${pages} pages, ${images} images) — the AI reads the pages and decides`,
    };
  }

  return { ok: false, reason: 'no property-brochure signals — rejected (default-deny)', signals };
}
