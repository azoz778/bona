/**
 * Phone normalisation for lead matching.
 *
 * A WhatsApp jid, a form field and a number Dana heard on a call all spell the same
 * person differently: `+966 59 329 6933`, `0593296933`, `٠٥٩٣٢٩٦٩٣٣`, `00966…`. Leads
 * merge on `phone_e164`, so every spelling has to land on one string — the E.164
 * digits without the plus (`966593296933`), which is also what a WhatsApp jid carries
 * before the `@`.
 *
 * Saudi mobiles get the country code added for the local forms (`05…`, `5…`); every
 * other country is taken as dialled. Anything that cannot be a phone number is `null`
 * — a lead may still be saved on its jid alone.
 */

const ARABIC_INDIC = /[٠-٩۰-۹]/g;

/** Arabic-Indic (٠-٩) and Persian (۰-۹) digits → 0-9. Everything else passes through. */
export function westernDigits(input) {
  return String(input ?? '').replace(ARABIC_INDIC, (d) => {
    const c = d.codePointAt(0);
    return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
  });
}

/**
 * @param {unknown} raw
 * @returns {string|null} E.164 digits (no `+`), 8–15 long, or null
 */
export function normalisePhone(raw) {
  let digits = westernDigits(raw).replace(/\D+/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  let m = /^0(5\d{8})$/.exec(digits);
  if (m) digits = `966${m[1]}`;
  else if (/^5\d{8}$/.test(digits)) digits = `966${digits}`;
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}
