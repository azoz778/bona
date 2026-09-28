/**
 * Which WhatsApp chats belong in the Bona inbox (2026-09-27 design §4.1, D9 and D12).
 *
 * The team reads and answers these chats from the dashboard, and they arrive on the
 * owner's personal number, which his TK clients and private conversations share. So a
 * chat joins only on something that can only be about Bona:
 *
 *   - a client's message carrying a site Ref code, click-to-WhatsApp ad context or a
 *     listing id (`BONA-W003`) is certain;
 *   - a client's message that only says "bona" / "بونا" is a guess. It goes to the
 *     owner's Unsure list, never into the inbox by itself. The other guess, the ±15-min
 *     click window, arrives here as the lead's match method (`time_window`);
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

/** A whole listing id: `BONA-W003`, `bona-005` — not `BONA-W0031`, not `XBONA-W003`. */
export const LISTING_ID_RE = /\bBONA-W?\d{3}\b/i;
/** Our name as a word, in either script. A guess on its own: TK and private chats say it too. */
export const BONA_WORD_RE = /\bbona\b|بونا/i;
/**
 * The site (or its legacy host) as a link, with or without a scheme and `www.`. The
 * characters either side must not carry on a host name, so `notbona-real-estate.com`
 * and `bona-real-estate.company` are not ours. A full stop straight after is allowed:
 * a sentence can end with the link.
 */
export const SITE_LINK_RE = /(?:^|[^a-z0-9.-])(?:www\.)?(?:bona-real-estate\.com|bona\.azoz\.uk)(?![a-z0-9-])/i;
export const INBOX_STATES = ['in', 'unsure', 'out'];

/**
 * "bona" in a document's name or caption, bounded by anything that is not a letter.
 * `\b` would miss `Bona_Villa.pdf` (`_` counts as a word character) and a letter-only
 * bound keeps `Bonanza.pdf` out.
 */
const DOC_BONA_RE = /(?:^|[^a-z])bona(?:[^a-z]|$)|بونا/i;

/** Anything that is not a string reads as empty: a record's text or caption may be null. */
const str = (v) => (typeof v === 'string' ? v : '');

/**
 * What one message from a client says about the chat.
 * @param {{ text?: unknown, hasAdMeta?: boolean }} [o]
 * @returns {'certain'|'unsure'|null}
 */
export function inboundSignal({ text = '', hasAdMeta = false } = {}) {
  const t = str(text);
  if (parseRef(t) || hasAdMeta || LISTING_ID_RE.test(t)) return 'certain';
  if (BONA_WORD_RE.test(t)) return 'unsure';
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
