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
 * The Arabic needs its own bounds: `بونا` sits inside كوبونات (coupons), أبونا (our father),
 * طلبونا, زبوناً … A letter or a mark (a vowel sign, tanween) either side means another word.
 */
export const BONA_WORD_RE = /\bbona\b|(?<![\p{L}\p{M}])بونا(?![\p{L}\p{M}])/iu;
/**
 * The site (or its legacy host) as a link, with or without a scheme and `www.`. The
 * characters either side must not carry on a host name, so `notbona-real-estate.com`,
 * `bona-real-estate.company`, `bona-real-estate.com.evil.example` and the user part of
 * `bona.azoz.uk@evil.example` are not ours. A full stop that ends the text or is followed
 * by anything but a host character is allowed: a sentence can end with the link.
 */
export const SITE_LINK_RE = /(?:^|[^a-z0-9.-])(?:www\.)?(?:bona-real-estate\.com|bona\.azoz\.uk)(?![a-z0-9@-]|\.[a-z0-9])/i;
export const INBOX_STATES = ['in', 'unsure', 'out'];

/**
 * "bona" / "بونا" in a document's name or caption, bounded in both scripts by anything that
 * is not a letter or a mark. `\b` would miss `Bona_Villa.pdf` (`_` counts as a word
 * character); the letter bound keeps `Bonanza.pdf` and كوبونات الخصم.pdf out. A clitic form
 * (وبونا) is missed on purpose: that fails safe, the owner still has the Move button.
 */
const DOC_BONA_RE = /(?<![\p{L}\p{M}])bona(?![\p{L}\p{M}])|(?<![\p{L}\p{M}])بونا(?![\p{L}\p{M}])/iu;

/** Anything that is not a string reads as empty: a record's text or caption may be null. */
const str = (v) => (typeof v === 'string' ? v : '');

/**
 * What one message from a client says about the chat.
 *
 * A Ref line is certain only in the shape the site writes it, with the listing part
 * (`Ref BONA-W003 · K7Q2XR`, or `Ref BONA · K7Q2XR` from a page without a listing), or when
 * the poller found a site session holding the code (`refKnown`, from `db.getSessionByRef`).
 * `parseRef` checks only the shape, so a bare `Ref K7Q2X` is also "ref please", "Ref check
 * done" or a TK booking reference: a guess, never a join by itself. `hasAdMeta` and
 * `refKnown` count only when exactly `true`, like the text, never coerced.
 * @param {{ text?: unknown, hasAdMeta?: boolean, refKnown?: boolean }} [o]
 * @returns {'certain'|'unsure'|null}
 */
export function inboundSignal({ text = '', hasAdMeta = false, refKnown = false } = {}) {
  const t = str(text);
  const ref = parseRef(t);
  if (ref && (ref.listingId || refKnown === true)) return 'certain';
  if (hasAdMeta === true || LISTING_ID_RE.test(t)) return 'certain';
  if (ref || BONA_WORD_RE.test(t)) return 'unsure';
  return null;
}

/**
 * Does a message the owner sent make this a Bona chat (D12)? Takes a normalised record
 * (lib/evolution.mjs): `text` is the body or the caption, `media` the placeholder
 * (`[document: name]`, `[image]`, …) and `fileName` a document's cleaned name.
 * @param {{ text?: unknown, fileName?: unknown, media?: unknown }} [o]
 * @returns {boolean}
 */
export function ownerOutboundJoins({ text = '', fileName = null, media = null } = {}) {
  const t = str(text);
  if (SITE_LINK_RE.test(t) || LISTING_ID_RE.test(t)) return true;
  if (!str(media).startsWith('[document')) return false;
  const name = str(fileName);
  return LISTING_ID_RE.test(name) || DOC_BONA_RE.test(name) || DOC_BONA_RE.test(t);
}

/**
 * The chat's inbox state after one inbound message. `in` and `out` stay as they are; an
 * undecided or unsure chat becomes `in` on anything certain and `unsure` on a guess (the
 * word, or a lead the poller matched only by keyword or click window); otherwise it is
 * left as it was.
 * @param {'in'|'unsure'|'out'|null|undefined} current
 * @param {{ signal?: 'certain'|'unsure'|null, method?: string|null }} [o]
 * @returns {'in'|'unsure'|'out'|null}
 */
export function nextInboxState(current, { signal = null, method = null } = {}) {
  if (current === 'out' || current === 'in') return current;
  if (signal === 'certain') return 'in';
  if (signal === 'unsure' || method === 'keyword' || method === 'time_window') return 'unsure';
  return current ?? null;
}
