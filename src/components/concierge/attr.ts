/* The visitor's attribution handle, as sent with `/v1/chat/session` and `/v1/call/token` (spec §3.4, contract C4).
   Read from window.BONA_ATTR, which src/scripts/attribution.js maintains; when that script did not run (blocked,
   very old browser) the result is undefined and the request bodies stay exactly as they were. */

export interface VisitorAttr { anon_id: string; session_id: string; ref: string; listing_id: string | null }

const LISTING_RE = /^BONA-W?\d{3}$/;

export function visitorAttr(): VisitorAttr | undefined {
  try {
    const a = (window as { BONA_ATTR?: { anon_id?: unknown; session?: { id?: unknown; ref?: unknown } | null } }).BONA_ATTR;
    if (!a || typeof a.anon_id !== 'string' || !a.session || typeof a.session.id !== 'string' || typeof a.session.ref !== 'string') return undefined;
    const listing = document.body?.dataset.listing || '';
    return { anon_id: a.anon_id, session_id: a.session.id, ref: a.session.ref, listing_id: LISTING_RE.test(listing) ? listing : null };
  } catch { return undefined; }
}
