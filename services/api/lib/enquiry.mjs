/**
 * `POST /v1/enquiry` — the site's contact / sell / listing forms.
 *
 * The form posts here *before* it opens WhatsApp, so a lead lands even when the
 * visitor never sends the message. The body carries the same attribution ids the
 * events do, and the same `event_id` the browser pixel fires `Lead` with, so the
 * server-side `form_submit` and the Conversions API call de-duplicate against it.
 */
import { westernDigits, normalisePhone } from './phone.mjs';
import { cleanAttr, cleanAttrIds, cleanConsent, ID_RE } from './events.mjs';
import { newId } from './db.mjs';

export const FORMS = ['contact', 'sell', 'listing'];
export const PHONE_RE = /^\+?\d{7,15}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneLine = (v, max = 300) => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};
const multiLine = (v, max = 2000) => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return s ? s.slice(0, max) : null;
};

/**
 * The attribution ids may ride at the top level, inside `attr`, or in the site's
 * stored bundle shape (`attr.session.id` / `attr.session.ref`). Whichever the form
 * sends, malformed values are dropped, never refused.
 */
export function enquiryIds(body) {
  const b = isObject(body) ? body : {};
  const a = isObject(b.attr) ? b.attr : {};
  const s = isObject(a.session) ? a.session : {};
  return cleanAttrIds({
    anon_id: b.anon_id ?? a.anon_id,
    session_id: b.session_id ?? a.session_id ?? s.id,
    ref: b.ref ?? a.ref ?? s.ref,
    listing_id: b.listing_id ?? a.listing_id,
  });
}

/**
 * @returns {{ ok: true, enquiry: object } | { ok: false, error: 'bad_request', message: string }}
 */
export function validateEnquiry(body) {
  const bad = (message) => ({ ok: false, error: 'bad_request', message });
  if (!isObject(body)) return bad('body must be an object');

  const name = oneLine(body.name, 200);
  if (!name || name.length < 2) return bad('name is required');

  const phoneText = westernDigits(body.phone).replace(/[\s\-().]/g, '');
  const phone = PHONE_RE.test(phoneText) ? normalisePhone(phoneText) : null;
  if (!phone) return bad('phone must be 7 to 15 digits');

  const form = FORMS.includes(body.form) ? body.form : 'contact';
  const listingText = oneLine(body.listing_id, 16)?.toUpperCase() ?? null;
  const ids = enquiryIds(body);
  const eventText = oneLine(body.event_id, 64);

  return {
    ok: true,
    enquiry: {
      form, name, phone,
      interest: oneLine(body.interest), type: oneLine(body.type), budget: oneLine(body.budget), location: oneLine(body.location),
      message: multiLine(body.message),
      listing_id: listingText && ID_RE.listing_id.test(listingText) ? listingText : ids.listing_id,
      page: oneLine(body.page), locale: String(body.locale ?? '').toLowerCase().startsWith('ar') ? 'ar' : 'en',
      event_id: eventText && ID_RE.event_id.test(eventText) ? eventText : newId('ev'),
      ids, attr: cleanAttr(body.attr), consent: cleanConsent(body.consent),
    },
  };
}
