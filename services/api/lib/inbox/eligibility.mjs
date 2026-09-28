/**
 * Which WhatsApp chats belong in the Bona inbox (2026-09-27 design §4.1, D9 and D12).
 *
 * The team reads and answers these chats from the dashboard, and they arrive on the
 * owner's personal number, which his TK clients and private conversations share. So a
 * chat joins only on something that can only be about Bona:
 *
 *   - a client's message carrying a site Ref line (with its listing part, or a code a site
 *     session holds), click-to-WhatsApp ad context or a listing id (`BONA-W003`) is certain;
 *   - a client's message that only says "bona" / "بونا", or carries a bare Ref-shaped code
 *     no session holds, is a guess. It goes to the owner's Unsure list, never into the
 *     inbox by itself. The other guess, the ±15-min click window, arrives here as the
 *     lead's match method (`time_window`);
 *   - a message the OWNER sends joins a chat only when it carries a Bona site link, a
 *     listing id, or a document (a brochure) whose file name or caption says Bona or a
 *     listing id. Nothing else he types counts: "bona" in a text to a TK client proves
 *     nothing.
 *
 * The answer is stored on the lead (`leads.inbox_state`), and a message only ever moves it
 * forward: a guess can become certain, but `in` is never demoted by a later message and
 * `out` (the owner said "not a client") is never left automatically. Only the owner's
 * buttons move a chat out of either (lib/inbox/store.mjs `setInboxState`).
 *
 * Pure functions, no I/O and no logging: the poller asks, the store records.
 */
import { parseRef } from '../attribution.mjs';

/**
 * A whole listing id: `BONA-W003`, `bona-005` — not `BONA-W0031`, not `XBONA-W003`, and not
 * `BONA-W003٤` (`\b` knows only ASCII digits, so the Arabic-Indic and Persian ones are named).
 */
export const LISTING_ID_RE = /\bBONA-W?\d{3}(?![\w٠-٩۰-۹])/i;
/**
 * Our name as a word, in either script. A guess on its own: TK and private chats say it too.
 * Both scripts are bounded by anything that is not a letter or a mark, so `_`, digits and
 * punctuation end the word (`Bona_Villa.pdf`, `Bona2026.pdf`, `(بونا)`) while `Bonanza`,
 * `Bonaé` and the Arabic words that only contain the four letters do not count: كوبونات
 * (coupons), أبونا (our father), طلبونا, زبوناً … A clitic form (وبونا) is missed on purpose:
 * that fails safe, the owner still has the Move button.
 *
 * "bona fide" / "bona fides" is Latin, common in English real-estate papers ("Bona Fide
 * Purchaser Declaration"), and never our name.
 *
 * The bounds are `\p{…}` classes, which mean something only with the `u` flag: reuse this
 * pattern by calling `.test()` on it, or rebuild it with `'iu'`, never `'i'` alone.
 */
export const BONA_WORD_RE = /(?<![\p{L}\p{M}])(?:bona(?![\p{L}\p{M}])(?![\s_.-]*fides?(?![\p{L}\p{M}]))|بونا(?![\p{L}\p{M}]))/iu;
/**
 * The site (or its legacy host) as a link, with or without a scheme and `www.`. The
 * characters either side must not carry on a host name, so `notbona-real-estate.com`,
 * `bona-real-estate.company`, `bona-real-estate.com.evil.example`, `….com.السعودية`,
 * `bona.azoz.uk。evil.example` (browsers read `。．｡` as a dot in a host), `bona.azoz.uk_evil…`
 * and the user part of `bona.azoz.uk@evil.example`, `bona.azoz.uk.@evil.example` or
 * `bona.azoz.uk:443@evil.example` are not ours. A full stop that ends the text or is
 * followed by anything but a host character is allowed: a sentence can end with the link.
 * So is a port (`bona-real-estate.com:443/ar/`).
 *
 * After a colon, the `@` of user-info is looked for only within 256 characters, and a colon
 * followed by more than 256 characters with no space, `/` or `@` is refused as well (fewer
 * joins, never more). Unbounded, that look-ahead re-read the rest of the text from every
 * copy of the host in it (`bona.azoz.uk:bona.azoz.uk:…@`), quadratic in the text's length.
 */
export const SITE_LINK_RE = /(?:^|[^a-z0-9.-])(?:www\.)?(?:bona-real-estate\.com|bona\.azoz\.uk)(?![\p{L}\p{M}\p{N}_@-]|[.。．｡][\p{L}\p{M}\p{N}@]|:(?:[^\s/@]{0,256}@|[^\s/@]{257}))/iu;
export const INBOX_STATES = Object.freeze(['in', 'unsure', 'out']);

/**
 * Code points left out at the end of a document name that was cut (`fileNameTruncated`),
 * so nothing close to the cut is read: more than "bona", a separator and "fides".
 */
const CUT_MARGIN = 16;
/**
 * Our name at the very end of what is left of a cut name, where the characters left out
 * decide it: as the last word (`…Bona` of Bonanza, `…بونا` of بونات), or followed only by
 * separators and the start of "fides" (`…Bona fi` of "Bona fide", `…BONA-` of BONA-fide).
 * The same bounds and separators as `BONA_WORD_RE`: keep the two in step.
 */
const WORD_AT_END_RE = /(?<![\p{L}\p{M}])(?:bona[\s_.-]*(?:f(?:i(?:d(?:es?)?)?)?)?|بونا)$/iu;

/**
 * What a cut document name can be read by: all but its last `CUT_MARGIN` code points, and
 * without our name at the new end when what followed it could change how it reads.
 */
function readableCutName(name) {
  return Array.from(name).slice(0, -CUT_MARGIN).join('').replace(WORD_AT_END_RE, '');
}

/**
 * A Ref line exactly as the site writes it: `Ref BONA-W003 · K7Q2XR`, or `Ref BONA · K7Q2XR`
 * from a page without a listing (`refLine()` in src/scripts/attribution.js, EnquiryForm.astro).
 * The listing part and a separator are always there, and nothing carries the code on.
 * `parseRef` is looser — no separator needed, ASCII bounds — so it also reads "Ref bona
 * please" as listing BONA + code PLEASE. Every line this matches, parseRef reads too.
 */
const SITE_REF_RE = /\bRef\s+BONA(?:-W?\d{3})?\s*[·:|-]\s*[A-HJ-NP-Z2-9]{5,6}(?![\p{L}\p{N}_])/iu;

/** Anything that is not a string reads as empty: a record's text or caption may be null. */
const str = (v) => (typeof v === 'string' ? v : '');

/**
 * What one message from a client says about the chat.
 *
 * A Ref line is certain only in the shape the site writes it (`SITE_REF_RE`), or when the
 * poller found a site session holding the code (`refKnown`, from `db.getSessionByRef`).
 * `parseRef` checks only the shape, so a bare `Ref K7Q2X` is also "ref please", "Ref check
 * done" or a TK booking reference: a guess, never a join by itself. `hasAdMeta` and
 * `refKnown` count only when exactly `true`, like the text, never coerced. A site link
 * with no listing id is only a guess too (spec §4.1 does not name it); the owner decides.
 * @param {{ text?: unknown, hasAdMeta?: boolean, refKnown?: boolean }|null} [o]
 * @returns {'certain'|'unsure'|null}
 */
export function inboundSignal(o) {
  const { text = '', hasAdMeta = false, refKnown = false } = o ?? {};
  const t = str(text);
  const ref = parseRef(t);
  if (SITE_REF_RE.test(t) || (ref && refKnown === true)) return 'certain';
  if (hasAdMeta === true || LISTING_ID_RE.test(t)) return 'certain';
  if (ref || BONA_WORD_RE.test(t)) return 'unsure';
  return null;
}

/**
 * Does a message the owner sent make this a Bona chat (D12)? Takes a normalised record
 * (lib/evolution.mjs): `text` is the body or the caption, `media` the placeholder
 * (`[document: name]`, `[image]`, …) and `fileName` a document's cleaned name.
 *
 * A name cut at 120 code points (`fileNameTruncated`) may go on past the cut: "…Bonanza.pdf"
 * becomes "…Bona", "…Bona fide declaration.pdf" becomes "…Bona fi". So a cut name is read
 * without its last 16 code points (`CUT_MARGIN`) and without our name at the new end when
 * what was left out could change how it reads (`WORD_AT_END_RE`: "…Bona| fide" leaves
 * "…Bona"), and only by the word rule (an id at the new end may be the start of a longer
 * one, `BONA-W003` of `BONA-W0031`; a listing id still counts through its `BONA`). Whatever
 * is then found in it is found in the whole name too, so a cut name joins only where the
 * whole name would join. Any truthy flag counts as cut: that only ever means fewer joins.
 * @param {{ text?: unknown, fileName?: unknown, fileNameTruncated?: boolean, media?: unknown }|null} [o]
 * @returns {boolean}
 */
export function ownerOutboundJoins(o) {
  const { text = '', fileName = null, fileNameTruncated = false, media = null } = o ?? {};
  const t = str(text);
  if (SITE_LINK_RE.test(t) || LISTING_ID_RE.test(t)) return true;
  if (!str(media).startsWith('[document')) return false;
  if (BONA_WORD_RE.test(t)) return true;
  const name = str(fileName);
  if (fileNameTruncated) return BONA_WORD_RE.test(readableCutName(name));
  return LISTING_ID_RE.test(name) || BONA_WORD_RE.test(name);
}

/**
 * The chat's inbox state after one inbound message. `in` and `out` stay as they are; an
 * undecided or unsure chat becomes `in` on anything certain and `unsure` on a guess (the
 * word, or a lead the poller matched only by keyword or click window); otherwise it is
 * left as it was. A `current` that is not one of the three states reads as undecided
 * (the store's CHECK allows only those and NULL), so the answer is always a state or null.
 * @param {'in'|'unsure'|'out'|null|undefined} current
 * @param {{ signal?: 'certain'|'unsure'|null, method?: string|null }|null} [o]
 * @returns {'in'|'unsure'|'out'|null}
 */
export function nextInboxState(current, o) {
  const { signal = null, method = null } = o ?? {};
  const cur = INBOX_STATES.includes(current) ? current : null;
  if (cur === 'out' || cur === 'in') return cur;
  if (signal === 'certain') return 'in';
  if (signal === 'unsure' || method === 'keyword' || method === 'time_window') return 'unsure';
  return cur;
}
