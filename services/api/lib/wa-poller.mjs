/**
 * The WhatsApp Ref-code poller.
 *
 * Most Bona enquiries arrive as a WhatsApp message, and a WhatsApp message on its own
 * says nothing about where the person came from. The site fixes that at the source: every
 * `wa.me` link is rewritten to prefill `… Ref BONA-W003 · K7Q2XR`, and the code is the
 * visitor's session. This loop reads the owner's inbound messages, finds that code, and
 * turns the message into a lead that knows its campaign.
 *
 * Read-only, by owner decision. The instance is the owner's *personal* WhatsApp, shared
 * with another agent: we poll `POST /chat/findMessages` and we never set a webhook. The
 * only thing this module writes back to WhatsApp is the owner's own new-lead note, and
 * only for a lead it just created.
 *
 * **Matched-only storage** (owner decision). A message is kept only when one of these is
 * true, in this order:
 *
 *   1. `ref`         — it carries a site Ref code (`Ref BONA-W003 · K7Q2XR`)
 *   2. `phone`       — the sender is already a lead (merge + `inbound_message` touchpoint)
 *   3. `ad_meta`     — it arrived with click-to-WhatsApp ad context
 *   4. `keyword`     — it says Bona / بونا / a listing id
 *   5. `time_window` — the sender is unknown, but a `whatsapp_click` from a lead-less
 *                      session landed within ±15 minutes (marked *inferred* in the note)
 *
 * Before any rule: a team member's number (active or not) and a number on the owner's
 * "never a client" list (lib/team.mjs) are skipped outright — not a lead, not a reply,
 * not stored. A chat that arrives as only an opaque `@lid` (no phone in `jid` or
 * `jidAlt`) cannot be checked against that list directly — unless its phone has already
 * been seen alongside it, from a message we RECEIVED (`lib/team.mjs` `learnTeamLid`; a
 * `fromMe` record's alt is not trusted for this — see the pairing code below for why), or
 * an existing LEAD already maps the lid to a phone (`leads.wa_lid` → `phone_e164` — the
 * case that catches a lead later put on the never list, or a team pairing that only ever
 * landed on an old lead row). Only once both of those come up empty is it counted
 * (`poll.lid_only_unexcludable`, logged only as a per-tick count at `info` level and kept
 * as a running total in `status()`), never logged with the lid itself, and — being
 * genuinely uncheckable — still judged by the rules below like any other message. A
 * lid-learning or lid/lead lookup that itself fails (a stale schema, say) never stalls
 * the tick: it is logged (`poll.lid_learn_failed`, no numbers or lids) or simply treated
 * as "not known", and the record in front of it is still handled. `isExcluded` itself
 * failing (a broken team lookup) is different: the record cannot be safely classified
 * either way, so it is deferred to the next tick (logged `poll.exclusion_check_failed`,
 * no numbers) rather than risking a wrong guess in either direction.
 *
 * Anything else — the owner's private conversations, which this loop can also see — is
 * discarded in memory. It is counted (`status().unmatched`) and never written to disk,
 * never logged, never sent anywhere. For the same reason nothing here logs a phone
 * number, a name or message text.
 *
 * **The Bona inbox** (2026-09-27 design §4). Wired only when `ingest` is passed; without it
 * this loop is exactly the matched-only poller described above. With it, a lead also
 * carries an inbox state, judged by lib/inbox/eligibility.mjs: a certain signal on an
 * inbound message (a Ref line as the site writes it or a code a site session holds, ad
 * context, a listing id) puts the chat `in`; a guess (the word "bona", a bare Ref-shaped
 * code no session holds, the click window) puts it on the owner's Unsure list; the owner's
 * own message puts a chat `in` only when it carries a Bona link or a listing number, or is a
 * property document that names neither TK nor Bona (D12, D16 — TK and private chats share
 * this number, so nothing else he sends counts; lib/inbox/eligibility.mjs has the rules).
 * Only `in` chats are kept as transcripts (lib/inbox/ingest.mjs), both directions, from the
 * joining message plus the 24 h before it. An `out` chat never comes back on its own.
 *
 * **Real-estate chats to check** (D17). A message that ends up with no lead behind it — a
 * stranger's that matched no rule, or the owner's to a stranger that did not join — but
 * uses property words (`propertyWordsIn`) or a property-document word (`PROPERTY_DOC_RE`),
 * or is a document of his that names TK, puts its chat on the owner's list
 * (lib/inbox/store.mjs `noteCandidate`) when the chat has a phone number: the number and
 * jid (and lid, when WhatsApp shows one), the name WhatsApp shows for a client (never the
 * owner's own, on a message he sent), the property words and the time. Never the text,
 * never a lead, never a note to anyone; the owner moves it into the inbox or marks it not a
 * client. A chat that becomes a lead leaves the list. Every other conversation is still
 * discarded exactly as above.
 */
import { parseRef } from './attribution.mjs';
import { MAX_PAGES, PAGE_SIZE, bareJid, oldestFirst, readWindow } from './evolution.mjs';
import { JOIN_HISTORY_MS } from './inbox/backfill.mjs';
import {
  BONA_WORD_RE, LISTING_ID_RE, MAX_PROPERTY_WORDS, PROPERTY_DOC_RE, inboundSignal, isTkDocument, nextInboxState, ownerOutboundJoins,
  propertyWordsIn,
} from './inbox/eligibility.mjs';
import { createOrMergeLead, leadNote } from './leads.mjs';
import { normalisePhone } from './phone.mjs';
import { isTeamLid, learnTeamLid } from './team.mjs';
import { waConfig } from './wa.mjs';

/** With no cursor yet, look back this far rather than at the whole history. */
export const FIRST_RUN_LOOKBACK_MS = 10 * 60_000;
/**
 * How far behind `now` a tick may leave the cursor. It bounds the steady state: without it
 * one stale message inside the overlap stays "the newest thing we saw" for ever, the cursor
 * sits still, and a quiet week ends with every tick asking Evolution for a week. It does
 * NOT bound the request — the first tick after downtime still asks for the whole gap, and
 * says `wa.poll.truncated` if even `readWindow`'s time-splitting cannot read the whole gap.
 */
export const MAX_WINDOW_MS = 10 * 60_000;
/** Every window reaches this far back behind the cursor: WhatsApp delivery is not instant. */
export const OVERLAP_MS = 120_000;
/**
 * `start()`'s interval when neither it nor `cfg.waPollMs` gives one: lib/config.mjs's default
 * (20 s since the inbox, P2-11). Kept as a copy so this file never loads the config module;
 * wa-poller.test.mjs checks the two agree.
 */
const DEFAULT_POLL_MS = 20_000;
/** How long a processed message id is remembered, so the overlap cannot double-count it. */
export const SEEN_TTL_MS = 7 * 86_400_000;
/** How close a `whatsapp_click` has to be for an unknown number to be inferred from it. */
export const CLICK_WINDOW_MS = 15 * 60_000;
/** How much of the first message is kept on a new lead. */
export const SNIPPET_MAX = 200;
/**
 * The one keyword rule: our name as a word, in either script, or a listing id — built from
 * the patterns lib/inbox/eligibility.mjs judges the inbox by, so a lead and its inbox state
 * never disagree about what counts. Rebuilt with `'iu'`, never `'i'` alone: the word's
 * bounds are `\p{…}` classes, which mean nothing without the `u` flag. So "عندكم كوبونات؟"
 * (coupons) and "a bona fide offer" are not our name (amendments A5, A8).
 */
export const KEYWORD_RE = new RegExp(`${BONA_WORD_RE.source}|${LISTING_ID_RE.source}`, 'iu');
/**
 * Our own new-lead note, read back out of the owner's chat. It says "Bona" in the first
 * line, so without this it would keyword-match and become an enquiry from ourselves.
 * `fromMe` normally keeps it out; this is the belt to that pair of braces.
 */
const OWN_NOTE_RE = /^\*?Bona — new enquiry\*?/;
/** How often one record may fail before it is written off rather than retried for ever. */
export const MAX_RECORD_ATTEMPTS = 3;
/** What the owner's list shows for a document of his that names TK (D16, D17). */
export const TK_DOCUMENT_WORD = 'tk document';
/**
 * What it shows for a property-document word (lib/inbox/eligibility.mjs `PROPERTY_DOC_RE`:
 * brochure, price list, بروشور …) in a message or a document's name that did not join.
 */
export const PROPERTY_DOCUMENT_WORD = 'property document';

/**
 * Why a record's chat belongs on the owner's list of real-estate chats to check (D17): the
 * property words in its text or caption and, for a document, in its file name — after
 * `tk document` when it is a document the owner sent that names TK, and `property document`
 * when the text, the caption or a document's name has a property-document word, in either
 * direction. So every owner-sent property document that did not join (it names Bona, or its
 * name was cut too close to the word, Task 15) is on the list, and so is a client asking
 * for "the price list". Canonical words only, never the text. A word at the end of a name
 * cut at 120 characters may be the start of a longer one; that only ever puts a chat on the
 * list to check, never in the inbox.
 * @returns {string[]} at most `MAX_PROPERTY_WORDS`
 */
export function candidateWordsOf(rec) {
  const text = typeof rec?.text === 'string' ? rec.text : '';
  const doc = typeof rec?.media === 'string' && rec.media.startsWith('[document');
  const name = doc && typeof rec.fileName === 'string' ? rec.fileName : '';
  const markers = [];
  if (rec?.fromMe === true && isTkDocument(rec)) markers.push(TK_DOCUMENT_WORD);
  if (PROPERTY_DOC_RE.test(text) || (name && PROPERTY_DOC_RE.test(name))) markers.push(PROPERTY_DOCUMENT_WORD);
  return [...markers, ...propertyWordsIn(name ? `${text}\n${name}` : text)].slice(0, MAX_PROPERTY_WORDS);
}

/**
 * What a failed step says about itself in a log line: the kind of error, never its message.
 * The per-record `try` covers matching, lead writes and the inbox store, and a message can
 * carry anything that step was handed, a number or a line of text included. So: the name
 * only when it is one of the kinds this loop meets (an injected error's name could be
 * anything), `code` only in Node's letters-and-underscores shape (`ERR_SQLITE_ERROR`,
 * `ECONNREFUSED`: no digits, so no number fits), and SQLite's numeric `errcode` (5 busy,
 * 19 a constraint), which is what tells one store failure from another.
 */
const LOGGED_ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'SqliteError', 'AbortError', 'TimeoutError', 'EvolutionError',
]);
const ERROR_CODE_RE = /^[A-Z][A-Z_]{1,63}$/;
function errorKind(err) {
  const kind = { error: typeof err?.name === 'string' && LOGGED_ERROR_NAMES.has(err.name) ? err.name : 'Error' };
  if (typeof err?.code === 'string' && ERROR_CODE_RE.test(err.code)) kind.code = err.code;
  if (Number.isInteger(err?.errcode)) kind.errcode = err.errcode;
  return kind;
}
/**
 * The codes lib/inbox/backfill.mjs answers a failed read with. Anything else an injected
 * backfill returns is logged as plain `failed`: its `error` is logged, so it may say only
 * what kind of failure it was.
 */
const HISTORY_ERROR_RE = /^(?:failed|timeout|network|bad_window|http_\d{3})$/;
const historyError = (e) => (typeof e === 'string' && HISTORY_ERROR_RE.test(e) ? e : 'failed');

const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''));
const str = (v, max = 300) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

/* ------------------------------------------------------------------ */
/* jids                                                                */
/* ------------------------------------------------------------------ */

const isGroup = (jid) => typeof jid === 'string' && jid.endsWith('@g.us');
const isBroadcast = (jid) => typeof jid === 'string' && (jid === 'status@broadcast' || jid.endsWith('@broadcast'));
const isLid = (jid) => typeof jid === 'string' && jid.endsWith('@lid');

/**
 * A chat this loop has no business reading: a group (Bona's listings are published from
 * one and the intake daemon owns it), a status broadcast, or the owner's own chat with
 * himself — which is where this service's notes are sent, so reading it back would make
 * the poller answer its own messages.
 */
export function isIgnorableChat(jid, ownerDigits = '') {
  if (!jid) return true;
  if (isGroup(jid) || isBroadcast(jid)) return true;
  if (ownerDigits && !isLid(jid) && bareJid(jid) === ownerDigits) return true;
  return false;
}

/**
 * Split a record's jids into what a lead stores. An ad-origin or privacy-mode chat
 * arrives as `…@lid`, whose digits are an opaque WhatsApp id and NOT a phone number —
 * so the phone only ever comes from the real jid (`key.remoteJidAlt` in that case), and
 * both are kept so the next message from either matches the same lead.
 * @returns {{ phone: string|null, waJid: string|null, waLid: string|null }}
 */
export function jidsOf({ jid = null, jidAlt = null } = {}) {
  let waJid = null;
  let waLid = null;
  for (const j of [jid, jidAlt]) {
    if (typeof j !== 'string' || !j) continue;
    if (isLid(j)) waLid ??= j;
    else if (!isGroup(j) && !isBroadcast(j)) waJid ??= j;
  }
  return { phone: waJid ? normalisePhone(bareJid(waJid)) : null, waJid, waLid };
}

/* ------------------------------------------------------------------ */
/* ad context                                                          */
/* ------------------------------------------------------------------ */

/**
 * The click-to-WhatsApp metadata Meta attaches to the first message of an ad-originated
 * chat. Kept verbatim (minus the ad's own copy) on the touchpoint, because it is the only
 * proof of where that person came from — there is no session and no Ref code.
 * @returns {object|null} null when this is an ordinary message
 */
export function adMetaOf(contextInfo) {
  const ctx = contextInfo && typeof contextInfo === 'object' ? contextInfo : null;
  if (!ctx) return null;
  const ad = ctx.externalAdReply && typeof ctx.externalAdReply === 'object' ? ctx.externalAdReply : null;
  const hasAd = Boolean(ad) || ctx.conversionSource || ctx.entryPointConversionSource || ctx.entryPointConversionApp || ctx.utm;
  if (!hasAd) return null;
  const meta = compact({
    source_id: str(ad?.sourceId, 64),
    source_type: str(ad?.sourceType, 64),
    source_app: str(ad?.sourceApp, 64),
    source_url: str(ad?.sourceUrl, 500),
    ctwa_clid: str(ad?.ctwaClid, 300),
    ad_ref: str(ad?.ref, 300),
    conversion_source: str(ctx.conversionSource, 64),
    entry_point_conversion_source: str(ctx.entryPointConversionSource, 64),
    entry_point_conversion_app: str(ctx.entryPointConversionApp, 64),
    utm: typeof ctx.utm === 'object' && ctx.utm !== null ? ctx.utm : str(ctx.utm, 300),
  });
  return Object.keys(meta).length ? meta : { external_ad: true };
}

/**
 * Where an ad-originated message came from, in the site's own attribution vocabulary.
 * A click-to-WhatsApp click id is proof the click was paid for even when the record does
 * not spell `Ads` out.
 * @returns {{ source: string, medium: string, campaign_id: string|null, click_ids: object|null, referrer: string|null }}
 */
export function adSourceOf(meta = {}) {
  const app = String(meta.source_app ?? meta.entry_point_conversion_app ?? '').toLowerCase();
  const conv = `${meta.conversion_source ?? ''} ${meta.entry_point_conversion_source ?? ''} ${meta.source_type ?? ''}`.toLowerCase();
  let source = 'whatsapp_ad';
  if (app.includes('instagram') || app === 'ig') source = 'instagram';
  else if (app.includes('facebook') || app === 'fb' || app.includes('messenger')) source = 'facebook';
  else if (conv.includes('instagram') || conv.includes('ig_')) source = 'instagram';
  else if (conv.includes('facebook') || conv.includes('fb')) source = 'facebook';
  return {
    source,
    medium: /ad/.test(conv) || meta.ctwa_clid ? 'paid' : 'social_or_organic',
    campaign_id: meta.source_id ?? null,
    click_ids: meta.ctwa_clid ? { ctwa_clid: meta.ctwa_clid } : null,
    referrer: meta.source_url ?? null,
  };
}

/** `BONA-W003` mentioned anywhere in the text as a whole id (`LISTING_ID_RE`), uppercased. */
export function listingIdIn(text) {
  const m = LISTING_ID_RE.exec(String(text ?? ''));
  return m ? m[0].toUpperCase() : null;
}

/* ------------------------------------------------------------------ */
/* The poller                                                          */
/* ------------------------------------------------------------------ */

/** The default when no team is wired: nothing is excluded. A stable reference, so the
 * poller can tell "no team passed" apart from "a team passed that excludes nobody yet". */
const NO_EXCLUSIONS = () => false;

/**
 * @param {object} o
 * @param {ReturnType<import('./db.mjs').openDb>} o.db
 * @param {object} o.cfg                                    loadConfig(): `env`, `siteUrl`, `dataDir`, `waPollMs`
 * @param {(w: { gte: number, lte: number }) => Promise<{ records: object[] }|object[]>} [o.findMessages]
 *        injected in tests; defaults to `readWindow()` against the instance in `cfg.env`,
 *        which splits a window too crowded to read in one go (lib/evolution.mjs)
 * @param {(text: string) => Promise<any>} [o.sendWhatsApp] the owner note sender
 * @param {(phone: string) => boolean} [o.isExcluded] `lib/team.mjs`'s `isExcludedPhone`:
 *        true for a team member's number (active or not) or a never-a-client number.
 *        Omitted by older wiring and by tests that predate team accounts — the poller
 *        then excludes nothing, exactly as before.
 * @param {typeof globalThis.fetch} [o.fetchImpl] what the default reader goes out through;
 *        left undefined, `findMessagesPage` falls back to the global fetch
 * @param {(obj: object) => void} [o.log]
 * @param {() => number} [o.now]
 * @param {ReturnType<import('./inbox/store.mjs').createInboxStore>} [o.inboxStore]
 *        inbox states and gaps; required whenever `ingest` is given
 * @param {((lead: object, rec: object) => object) | { ingest: Function }} [o.ingest]
 *        lib/inbox/ingest.mjs: stores one record of an `in` chat. Null (older wiring and
 *        every Phase 1 test) means no inbox at all — the poller behaves exactly as before.
 * @param {ReturnType<import('./inbox/backfill.mjs').createBackfill>} [o.backfill]
 *        pulls the 24 h before a join; without it a join stores from its own message on
 */
export function createPoller({
  db, cfg = {}, findMessages = null, sendWhatsApp = null, isExcluded = NO_EXCLUSIONS, log = () => {}, now = () => Date.now(),
  inboxStore = null, ingest = null, backfill = null, fetchImpl = undefined,
} = {}) {
  // `createIngest()` hands back `{ ingest }`; the bare function is accepted as well. Every
  // other shape is refused here rather than read as "no inbox": a wiring slip that passes
  // the wrong property would otherwise switch the whole inbox off without a word.
  const ingestOne = typeof ingest === 'function' ? ingest : (typeof ingest?.ingest === 'function' ? ingest.ingest : null);
  const inboxOn = Boolean(ingestOne);
  if (ingest != null && !inboxOn) throw new TypeError('createPoller: ingest must be a function or { ingest } (createIngest())');
  if (inboxOn && !inboxStore) throw new TypeError('createPoller: an inbox ingest needs the inbox store (for states and gaps)');
  if (backfill != null && !inboxOn) throw new TypeError('createPoller: a backfill without an ingest would be ignored; pass both, or neither');
  if (backfill != null && typeof backfill.history !== 'function') throw new TypeError('createPoller: backfill must be createBackfill() (it needs history)');
  const wa = waConfig(cfg.env ?? {});
  const instance = wa.instance;
  const ownerDigits = bareJid(wa.ownerJid);
  const configured = Boolean(findMessages) || Boolean(wa.baseUrl && wa.apiKey);
  // Whether a team is wired at all — not whether it currently excludes anyone — because an
  // uncheckable lid-only chat is worth counting the moment team accounts exist, even before
  // any pairing has been learned.
  const teamWired = isExcluded !== NO_EXCLUSIONS;
  const find = findMessages ?? (({ gte, lte }) => readWindow({
    baseUrl: wa.baseUrl, apiKey: wa.apiKey, instance, gte, lte, offset: PAGE_SIZE, maxPages: MAX_PAGES, fetchImpl,
  }));

  let timer = null;
  let busy = false;
  let matched = 0;
  /** Running total of `poll.lid_only_unexcludable` — `status()`'s quieter alternative to
   * a warn log firing on almost every tick with privacy-mode clients. */
  let lidOnlyUnexcludable = 0;
  let skipLogged = false;
  /**
   * Message ids this process has failed on → `{ attempts, ts, handled?, gap? }`. The
   * timestamp matters as much as the count: the cursor is held back to it, or the record
   * would fall out of the window and be neither retried nor written off. `handled` (inbox
   * only) is what `handleInbound` already did for a record that then failed in the inbox
   * steps after it, so a retry goes straight back to those steps instead of merging the
   * message into its lead again (one more touchpoint and `wa.lead` line per attempt). `gap`
   * (inbox only) is what `recordGapSafely` needs of the record — its id, jids and whether
   * it is noise, never its text — for when it is given up on after the window has moved
   * past it (the abandon loop in the tick), where the record itself is no longer in hand.
   */
  const failures = new Map();

  /* -------------------- lid learning, safely -------------------- */

  /**
   * `learnTeamLid`/`isTeamLid` (lib/team.mjs) run a raw SQL statement against `users`
   * that nothing else in this loop retries. Called from outside the per-record `try`
   * below, a schema-level failure there (a `wa_lid` column not yet migrated, say) would
   * otherwise bubble to the tick's own outer `catch`, fail the WHOLE window, and leave
   * the cursor stuck re-asking for the same records forever. Wrapped here instead: a
   * learning failure is logged (no numbers, no lids — just that it happened) and the
   * record is still excluded exactly as it would have been anyway; a lookup failure is
   * treated as "not known", the same as a genuinely unpaired lid.
   */
  function learnLidSafely(phone, lid) {
    try {
      learnTeamLid(db, phone, lid);
    } catch (err) {
      log({ level: 'warn', evt: 'poll.lid_learn_failed', error: String(err?.message ?? err) });
    }
  }
  function isTeamLidSafely(lid) {
    try {
      return isTeamLid(db, lid);
    } catch {
      return false;
    }
  }
  /**
   * The phone an existing LEAD already maps this lid to (`leads.wa_lid` → `phone_e164`) —
   * the other half of the pairing `isTeamLid` checks on `users`. `isTeamLid` alone misses
   * two cases: a lead who was later put on the never list, and a team member whose
   * `jidAlt` pairing only ever landed on an old lead row rather than on `users`. Both have
   * to be checked before classification and reply-handling reach the record. Never derived
   * from the lid's own digits — only an existing row that already carries both. Wrapped
   * like `isTeamLidSafely`: a lookup failure is "not known", not a stalled tick.
   */
  function leadPhoneForLidSafely(lid) {
    try {
      return db.getLeadByJid(lid)?.phone_e164 ?? null;
    } catch {
      return null;
    }
  }

  /**
   * `isExcluded` (`team.isExcludedPhone` in production) runs a raw SQL lookup against
   * `users` and `never_list` that nothing else in this loop retries. It is called from
   * the tick's per-record loop, before the retry-safe `try` further down that wraps
   * classification and reply-handling — those must never run before this has actually
   * decided whether the record even reaches them. Left unwrapped, a failure here would
   * bubble to the tick's own outer `catch`, fail the WHOLE window, and leave the cursor
   * stuck re-asking for it forever. Wrapped here instead: the failure is logged
   * (`poll.exclusion_check_failed`, no numbers) and reported as `ok: false`, which the
   * caller treats as "not decided yet" — the record is deferred to the next attempt via
   * the same `failures`/cursor bookkeeping a record that throws inside the `try` below
   * gets, never guessed at either way, never lost.
   */
  function isExcludedSafely(phone) {
    try {
      return { ok: true, excluded: isExcluded(phone) };
    } catch (err) {
      log({ level: 'warn', evt: 'poll.exclusion_check_failed', error: String(err?.message ?? err) });
      return { ok: false, excluded: false };
    }
  }

  /* -------------------- lookups -------------------- */

  const findLead = ({ phone, waJid, waLid }) => (phone ? db.getLeadByPhone(phone) : null)
    ?? (waJid ? db.getLeadByJid(waJid) : null)
    ?? (waLid ? db.getLeadByJid(waLid) : null)
    ?? null;

  /** The last listing this session actually looked at — the property the Ref belongs to. */
  function lastListingView(sessionId) {
    if (!sessionId) return null;
    const views = db.eventsForSession(sessionId, { limit: 200 }).filter((e) => e.name === 'listing_view' && e.listing_id);
    return views.length ? views[views.length - 1].listing_id : null;
  }

  /** Has this session already produced a lead? Any event of it carrying a lead id says yes. */
  const sessionHasLead = (sessionId) => Boolean(sessionId) && db.eventsForSession(sessionId, { limit: 200 }).some((e) => e.lead_id);

  /**
   * The `whatsapp_click` nearest in time to an unknown number's message, from a session
   * that has not become a lead yet. This is the weakest rule in the set — two visitors
   * clicking within the same quarter hour would be told apart by nothing — so the lead it
   * creates is marked `time_window` and the owner's note says *inferred*.
   */
  function closestClick(ts) {
    let best = null;
    for (const click of db.recentEvents({ name: 'whatsapp_click', sinceTs: ts - CLICK_WINDOW_MS, untilTs: ts + CLICK_WINDOW_MS, limit: 100 })) {
      if (!click.session_id || click.lead_id) continue;
      if (sessionHasLead(click.session_id)) continue;
      const distance = Math.abs((click.ts ?? ts) - ts);
      if (!best || distance < best.distance) best = { distance, click };
    }
    return best?.click ?? null;
  }

  /* -------------------- matching -------------------- */

  /**
   * Which rule, if any, keeps this message. Precedence is the spec's: the Ref code is the
   * only rule that knows the campaign for certain, so it wins even over a known sender.
   * @returns {object|null} null = discard
   */
  function classify({ text, contextInfo, existing, ts }) {
    const ref = parseRef(text);
    if (ref) {
      const session = db.getSessionByRef(ref.code);
      return {
        method: 'ref', ref: ref.code, sessionId: session?.session_id ?? null,
        listingId: ref.listingId ?? lastListingView(session?.session_id),
      };
    }
    if (existing) return { method: 'phone', listingId: listingIdIn(text) };

    const adMeta = adMetaOf(contextInfo);
    if (adMeta) return { method: 'ad_meta', adMeta, source: adSourceOf(adMeta), listingId: listingIdIn(text) };

    if (KEYWORD_RE.test(text)) return { method: 'keyword', listingId: listingIdIn(text) };

    const click = closestClick(ts);
    if (click) {
      return { method: 'time_window', sessionId: click.session_id, eventId: click.event_id, listingId: click.listing_id ?? null };
    }
    return null;
  }

  /* -------------------- one message -------------------- */

  /**
   * A message from the owner to somebody who is already a lead is the reply that stops the
   * response clock. Nothing is created here — an outbound message to a stranger is not a lead.
   */
  function recordReply(rec, ts) {
    const lead = findLead(jidsOf(rec));
    if (!lead || lead.first_reply_ts) return false;
    db.updateLead(lead.lead_id, { first_reply_ts: ts, updated: ts });
    return true;
  }

  async function handleInbound(rec, ts) {
    const jids = jidsOf(rec);
    const existing = findLead(jids);
    const text = typeof rec.text === 'string' ? rec.text : '';
    const match = classify({ text, contextInfo: rec.contextInfo, existing, ts });
    if (!match) return null;

    const { lead, created } = createOrMergeLead(db, {
      name: rec.pushName ?? null,
      phone: jids.phone,
      waJid: jids.waJid,
      waLid: jids.waLid,
      listingId: match.listingId ?? null,
      // The message body is kept only for a lead we are meeting for the first time, capped,
      // and only on the touchpoint — never as a transcript of the conversation.
      snippet: existing ? null : text.slice(0, SNIPPET_MAX) || null,
    }, {
      channel: 'whatsapp',
      matchMethod: match.method,
      sessionId: match.sessionId ?? null,
      ref: match.ref ?? null,
      adMeta: match.adMeta ?? null,
      // The enquiry happened when the message was sent, not when we noticed it: this is
      // what `first_inbound_ts` (and so every response time) is measured from.
      now: ts,
      dataDir: cfg.dataDir ?? undefined,
    });

    // An ad-originated lead has no session, so `createOrMergeLead` could only fall back to
    // "whatsapp, organic". The ad context is better than that, and it is all we will ever get.
    if (created && match.source && !lead.session_id) {
      const s = match.source;
      const touch = {
        ts, landing: null, referrer: s.referrer, utm_source: s.source, utm_medium: s.medium,
        utm_campaign: null, utm_content: null, utm_term: null, utm_id: s.campaign_id, click_ids: s.click_ids,
      };
      db.updateLead(lead.lead_id, {
        source: s.source, medium: s.medium, campaign_id: s.campaign_id, click_ids: s.click_ids,
        first_touch: touch, last_touch: touch, updated: ts,
      });
    }

    // The click that explains this message is marked as claimed, so the next unknown number
    // cannot be inferred from it too. It is deliberately NOT passed to `createOrMergeLead`
    // as `eventId`: that would fan the lead out under the click's own event id, and Meta —
    // which already heard `Contact` under it — would drop the `Lead` as a duplicate.
    if (match.eventId) db.setEventLead(match.eventId, lead.lead_id);

    const fresh = db.getLead(lead.lead_id) ?? lead;
    log({ evt: 'wa.lead', leadId: fresh.lead_id, created, match: match.method, source: fresh.source, listingId: fresh.listing_id ?? null });

    if (created && sendWhatsApp) {
      try {
        const res = await sendWhatsApp(leadNote(fresh, { siteUrl: cfg.siteUrl }));
        if (res && res.ok === false) log({ level: 'warn', evt: 'wa.note.failed', leadId: fresh.lead_id, error: res.error ?? 'unknown' });
      } catch (err) {
        log({ level: 'warn', evt: 'wa.note.failed', leadId: fresh.lead_id, error: String(err?.message ?? err) });
      }
    }
    // `refKnown`: `classify` found a site session holding the Ref code, which makes even a
    // bare `Ref K7Q2XR` certain for the inbox (amendment A6).
    return { method: match.method, created, lead: fresh, refKnown: match.method === 'ref' && Boolean(match.sessionId) };
  }

  /* -------------------- the Bona inbox -------------------- */

  /** One record into the transcript of an `in` chat, the lead read fresh (a backfill may just have filled its jids). */
  async function storeRecord(leadId, rec, tally) {
    const res = await ingestOne(db.getLead(leadId), rec);
    if (res?.stored) tally.stored += 1;
  }

  /**
   * A chat that has just joined: its state first — ingest refuses anything that is not
   * `in`, so the history below would otherwise be thrown away — then the 24 h before the
   * joining message, where the "Hi" before a Ref line or the owner's opening words live
   * (design §4.1). Counts only in the log line: never a number or a name.
   *
   * A history Evolution could not give us (`{ error }`) is not dropped silently (design
   * §4.3): the joining message is about to be stored, so the chat is no longer one the
   * daily catch-up asks again for (it only picks chats with nothing stored). A gap just
   * before the joining message makes the thread say "a message could not be loaded —
   * check WhatsApp" where that history belongs. If even that gap cannot be written, it is
   * logged (`inbox.gap_failed`) rather than thrown: a retry of the record would find the
   * chat already `in`, skip this join, and so never redo the history or its gap either.
   *
   * The gap goes only to a chat that is still `in` once the read is over: while it was
   * awaited the owner may have marked the chat Not a client, and `leaveInbox` purged its
   * gaps then; one written now would outlive that purge. The check and the insert run with
   * no `await` between them, so nothing in this process can move the chat in between.
   */
  async function join(leadId, ts, via, tally, extra = {}) {
    // The history floor goes with the state: nothing of this chat from before the 24 h is
    // ever stored, whichever read brings it (lib/inbox/ingest.mjs).
    inboxStore.setInboxState(leadId, 'in', { since: ts, historyFrom: ts - JOIN_HISTORY_MS });
    if (backfill) {
      const got = await backfill.history(db.getLead(leadId), { sinceTs: ts - JOIN_HISTORY_MS, untilTs: ts });
      if (got?.error) {
        log({ level: 'warn', evt: 'inbox.join_history_failed', leadId, error: historyError(got.error) });
        try {
          if (db.getLead(leadId)?.inbox_state === 'in') {
            inboxStore.addGap({ key_id: `join:${leadId}:${ts}`, lead_id: leadId, ts: ts - 1, reason: 'history_failed' });
          }
        } catch {
          log({ level: 'warn', evt: 'inbox.gap_failed', leadId, reason: 'history_failed' });
        }
      }
    }
    tally.joined += 1;
    log({ evt: 'inbox.join', leadId, via, ...extra });
  }

  /**
   * What an inbound message means for the inbox, once `handleInbound` has matched it. A
   * certain signal puts the chat `in`, a guess puts it on the Unsure list, and `in`/`out`
   * never move from here (lib/inbox/eligibility.mjs `nextInboxState`). Unsure keeps
   * nothing: a guessed chat is never stored or shown until the owner moves it in. A bare
   * Ref-shaped code is certain only when a site session holds it (`refKnown`, A6).
   *
   * Decided on the lead as it is NOW, not as `handleInbound` read it: the owner's note was
   * sent in between (and a retried record carries the lead from its first attempt), and a
   * chat the owner put `out` meanwhile — Not a client, the never list — must stay out.
   */
  async function inboxAfterInbound(rec, ts, { lead: seen, method, refKnown }, tally) {
    const lead = db.getLead(seen.lead_id);
    if (!lead) return;
    const text = typeof rec.text === 'string' ? rec.text : '';
    const signal = inboundSignal({ text, hasAdMeta: Boolean(adMetaOf(rec.contextInfo)), refKnown });
    const next = nextInboxState(lead.inbox_state, { signal, method });
    if (next === 'in' && lead.inbox_state !== 'in') await join(lead.lead_id, ts, 'inbound', tally);
    else if (next && next !== lead.inbox_state) inboxStore.setInboxState(lead.lead_id, next, { since: ts });
    if (next === 'in') await storeRecord(lead.lead_id, rec, tally);
  }

  /**
   * What the owner's own message means for the inbox, once `recordReply` has stamped the
   * reply clock exactly as before (the Hermes `bona-unanswered-leads` watchdog reads
   * `first_reply_ts`). In an `in` chat it is stored: typed on his phone or sent by Lisa,
   * which nothing can tell apart, unless lib/inbox/ingest.mjs finds our own dashboard send
   * in the outbox. An `out` chat never comes back on its own. Any other chat joins only on
   * a Bona link, a listing number or a property document that names neither TK nor Bona
   * (D12, D16), judged on the normalised record as it is, so a document name cut at 120
   * code points is read as cut, with what the whole name said (A8, `fileNameTk`,
   * `fileNameBona`). A stranger he writes to that way becomes an `owner_outbound` lead — no
   * ad fan-out and no new-lead note, because he started it (lib/leads.mjs `OWNER_METHODS`) —
   * with no name: a `fromMe` record's pushName is his own.
   *
   * Our own new-lead note passes that rule too (it carries a Bona link, the listing id and
   * a Ref line), and so does a Bona link he saves in his chat with himself. The tick skips
   * the owner's own chat and team and never-list numbers, but only where the record shows a
   * phone: his self-chat can arrive as a bare `@lid`, and its lid is practically never
   * learned (every self-chat message is `fromMe`). So two more checks sit here (A7). Our own
   * note is refused by its first line (`OWN_NOTE_RE`, which the tick applies to inbound
   * records only). And a lid alone never starts or joins a chat: a lid cannot be checked
   * against the team or never list, cannot be replied to (`lid_only`), and the exclusion
   * sweep cannot catch it later. So no NEW lead is made from a record with no phone, and an
   * existing lead that is not `in` joins only when the record or the lead carries a number
   * (a phone, or a phone jid) — for a lid-only record, the lead's number is the one the tick
   * checked for that lid. A lead known only by its lid keeps its state (Unsure stays on the
   * Unsure list); the owner can still move it in by hand, and for a stranger he has Add chat.
   */
  async function inboxAfterOutbound(rec, ts, tally) {
    const jids = jidsOf(rec);
    let lead = findLead(jids);
    if (lead?.inbox_state === 'out') return;
    if (lead?.inbox_state !== 'in') {
      if (OWN_NOTE_RE.test(String(rec.text ?? '').trimStart())) return;
      if (!ownerOutboundJoins(rec)) return;
      if (lead && !(jids.waJid || lead.phone_e164 || lead.wa_jid)) return;
      let created = false;
      if (!lead) {
        if (!jids.phone) return;
        const text = typeof rec.text === 'string' ? rec.text : '';
        const fileName = typeof rec.fileName === 'string' ? rec.fileName : '';
        ({ lead, created } = createOrMergeLead(db, {
          name: null, phone: jids.phone, waJid: jids.waJid, waLid: jids.waLid,
          listingId: listingIdIn(`${text} ${fileName}`),
        }, { channel: 'whatsapp', matchMethod: 'owner_outbound', now: ts, dataDir: cfg.dataDir ?? undefined }));
      }
      await join(lead.lead_id, ts, 'owner_outbound', tally, { created });
    }
    await storeRecord(lead.lead_id, rec, tally);
  }

  /**
   * A record of an `in` chat that has failed for the last time is not dropped silently
   * (design §4.2): its id, chat and time go to `wa_gaps`, and the thread shows "a message
   * could not be loaded — check WhatsApp" in its place. Never the text. "For the last time"
   * is either way the poller gives up: written off after `MAX_RECORD_ATTEMPTS`, or
   * abandoned once the window has moved past it (after an outage that can be after a
   * single try) — then `rec` is the `gap` its failure entry kept, which carries the same
   * fields. Called from the per-record `catch` and the abandon loop, so nothing in here may
   * throw. Not for noise (a reaction or an edit is never a bubble, so it is never a missing
   * one), nor for a record that is stored after all (a join's history reads the joining
   * message too). The log line carries no error text: an exception's message could carry a
   * number.
   */
  function recordGapSafely(rec, ts) {
    if (!inboxOn || rec.noise) return;
    let leadId = null;
    try {
      const lead = findLead(jidsOf(rec));
      if (lead?.inbox_state !== 'in') return;
      leadId = lead.lead_id;
      if (inboxStore.messageByKey?.(rec.id)) return;
      inboxStore.addGap({ key_id: rec.id, lead_id: leadId, jid: rec.jid ?? null, ts, reason: 'failed' });
    } catch {
      log({ level: 'warn', evt: 'inbox.gap_failed', leadId, reason: 'failed' });
    }
  }

  /**
   * D17: after a record is handled, a chat that is a lead leaves the owner's list of
   * real-estate chats to check (its inbox state rules now), and a chat that is not one goes
   * on it when the record gives a reason (`candidateWordsOf`) — only a person's chat with a
   * phone number. A WhatsApp channel (`…@newsletter`) is nobody's chat. A lid alone is not
   * noted, for the reasons A7 makes no lead of one: it cannot be checked against the team or
   * the never list (it may be a colleague whose lid is not learned yet), cannot be replied
   * to, and the exclusion sweep cannot catch it later. A client's name is kept, the name on
   * a record the owner sent is his own and never is. It is only a list for the owner to look
   * at, so it never fails the record: a failure is logged by its kind only (`errorKind`: no
   * message, so no numbers, no words) and the record is not retried for it — a retry would
   * handle the record a second time.
   *
   * Noise (an edit, a reaction …) is no message of its own, so it notes nothing: an edit's
   * text is the new text of a message already counted, and counting it again would also
   * move `last_ts`, and with it the 30-day deletion, later. It still takes a chat that has
   * become a lead off the list.
   *
   * Known edge, accepted: the note is written before the record is marked seen, and the two
   * are not one transaction (the list never fails the record, D17). If `waSeenAdd` throws
   * right after a note, the record is retried and noted again, so `hits` — the "N messages"
   * the owner's list shows — is one too high for that chat; its times and words come out the
   * same. It needs a failure between two synchronous writes, so it is left as it is.
   */
  function noteCandidateSafely(rec, ts, tally) {
    try {
      const jids = jidsOf(rec);
      if (jids.waJid && !jids.waJid.endsWith('@s.whatsapp.net')) return;
      if (!jids.phone && !jids.waJid && !jids.waLid) return;
      if (findLead(jids)) {
        inboxStore.removeCandidatesFor({ phone: jids.phone, jid: jids.waJid, lid: jids.waLid });
        return;
      }
      if (!jids.phone || rec.noise) return;
      const words = candidateWordsOf(rec);
      if (!words.length) return;
      const res = inboxStore.noteCandidate({
        jid: jids.waJid, lid: jids.waLid, phone: jids.phone, name: rec.fromMe ? null : (rec.pushName ?? null),
        ts, words, dir: rec.fromMe ? 'out' : 'in',
      });
      if (res.state === 'open') tally.candidates += 1;
    } catch (err) {
      log({ level: 'warn', evt: 'inbox.candidate_failed', ...errorKind(err) });
    }
  }

  /* -------------------- the tick -------------------- */

  /**
   * One pass: read the window since the cursor, keep what matches, move the cursor.
   *
   * Nothing in here may throw. An Evolution outage leaves the cursor exactly where it was,
   * so the window simply widens and the messages are picked up when it comes back; what
   * the outage does change is `status().lagS`, which is the number `/health` publishes.
   */
  async function tick() {
    if (busy) return { busy: true };
    busy = true;
    try {
      if (!configured) {
        // Once per process: a missing key is a standing state, not news on every tick.
        if (!skipLogged) { skipLogged = true; log({ evt: 'wa.poll.skipped', reason: 'evolution_not_configured' }); }
        return { skipped: 'not_configured' };
      }
      const t = now();
      const cursor = db.waCursorGet(instance);
      const since = Number.isFinite(cursor?.last_ts) && cursor.last_ts > 0 ? cursor.last_ts : t - FIRST_RUN_LOOKBACK_MS;
      const gte = Math.max(0, since - OVERLAP_MS);
      const lte = t;

      const answer = await find({ gte, lte, instance });
      const records = Array.isArray(answer) ? answer : (answer?.records ?? []);

      const tally = { scanned: records.length, matched: 0, unmatched: 0, created: 0, merged: 0, replies: 0, ignored: 0, lidOnlyUnexcludable: 0, stored: 0, joined: 0, candidates: 0 };
      let maxTs = 0;
      let oldestFailedTs = null;
      /**
       * Leaves a record exactly where one that throws inside the `try` further down
       * lands: not marked seen, the cursor held back (via `oldestFailedTs`) to include
       * it in the next window, and — if the failure outlives that — eventually written
       * off by the ordinary `floor`/abandon accounting below rather than retried forever.
       */
      const deferRecord = (id, ts) => {
        const existing = failures.get(id);
        failures.set(id, { ...existing, attempts: existing?.attempts ?? 0, ts });
        if (oldestFailedTs === null || ts < oldestFailedTs) oldestFailedTs = ts;
      };
      // Evolution answers newest-first. Handled in that order, a follow-up would be judged
      // before the Ref line that creates the lead, and a reply before the enquiry it answers.
      for (const rec of oldestFirst(records)) {
        const ts = Number.isFinite(rec?.ts) ? rec.ts : t;
        if (ts > maxTs && ts <= lte) maxTs = ts;

        // The owner's own chat can also arrive as a `@lid` whose alt is his number.
        const isOwnChat = Boolean(ownerDigits) && [rec?.jid, rec?.jidAlt].some((j) => j && !isLid(j) && bareJid(j) === ownerDigits);
        const isOwnNote = !rec?.fromMe && OWN_NOTE_RE.test(String(rec?.text ?? '').trimStart());
        if (!rec?.id || isOwnChat || isOwnNote || isIgnorableChat(rec.jid, ownerDigits)) {
          // A self-chat lid pairs with the owner's own number the same way a team
          // member's does — via `jidAlt` on a message that also shows the real jid — so
          // it is learned onto the owner's own `users` row here too: a later message that
          // arrives as that lid ALONE then reaches `isTeamLidSafely` below on its own and
          // is recognised as ours, not a client's. Same inbound-only guard as the team
          // pairing further down (see there for why), and it changes nothing else about
          // how an own-chat record is handled — it is still simply ignored.
          if (teamWired && isOwnChat && !rec.fromMe) {
            const ownLid = [rec?.jid, rec?.jidAlt].find(isLid);
            if (ownLid) learnLidSafely(ownerDigits, ownLid);
          }
          tally.ignored += 1;
          continue;
        }
        if (db.waSeenHas(rec.id)) { tally.ignored += 1; continue; }

        // A colleague is not a client (our own login codes to them even say "Bona"), and
        // the owner's never-a-client list is absolute. 2026-09-27 design §3.5.
        const recJids = jidsOf(rec);
        const phoneExclusion = recJids.phone ? isExcludedSafely(recJids.phone) : { ok: true, excluded: false };
        if (!phoneExclusion.ok) { deferRecord(rec.id, ts); continue; }
        if (phoneExclusion.excluded) {
          // WhatsApp pairs a privacy-mode `@lid` with the real jid via `jidAlt` on the
          // messages that carry both — the same correlation `jidsOf` already trusts for
          // leads. Remembering it here lets a later message that arrives as the lid ALONE
          // still be recognised as this same team member, without ever guessing a phone
          // from the lid's own digits.
          //
          // Only from a message WE received (`!rec.fromMe`), though: `key.senderPn` and
          // `key.remoteJidAlt` are folded into one `jidAlt` field by `lib/evolution.mjs`
          // `normaliseRecord`, with nothing left to tell which one an outbound record's
          // alt actually came from — and an outbound alt can be our own number for
          // reasons that have nothing to do with whose CHAT this is. Binding a client's
          // lid to a team member's phone from a bad pairing would be worse than the gap
          // this closes.
          if (teamWired && recJids.waLid && !rec.fromMe) learnLidSafely(recJids.phone, recJids.waLid);
          tally.ignored += 1;
          continue;
        }
        // A record that is only a `@lid` (no phone in `jid` or `jidAlt`) cannot be checked
        // against `isExcluded`, which only ever sees phone numbers — unless this lid was
        // already learned above from an earlier message that did carry the phone, or an
        // existing LEAD already maps it to a phone (a lead later put on the never list, or
        // a team member's pairing that only ever landed on an old lead row). What is left
        // uncaught after both of those is counted here, never logged with the lid itself,
        // and falls through to be judged by the ordinary rules below like any other message.
        if (teamWired && !recJids.phone && recJids.waLid) {
          if (isTeamLidSafely(recJids.waLid)) { tally.ignored += 1; continue; }
          const leadPhone = leadPhoneForLidSafely(recJids.waLid);
          if (leadPhone) {
            const leadExclusion = isExcludedSafely(leadPhone);
            if (!leadExclusion.ok) { deferRecord(rec.id, ts); continue; }
            if (leadExclusion.excluded) { tally.ignored += 1; continue; }
            // Resolved, and not excluded: an ordinary client, judged by the rules below
            // like any other message — not part of the uncheckable gap.
          } else if (!failures.has(rec.id)) {
            // A record already owed a retry (`failures` below) was counted the first time
            // it was found uncheckable; counting it again on every retry would inflate the
            // running total for one stuck record instead of the many distinct chats it is
            // meant to track.
            tally.lidOnlyUnexcludable += 1;
          }
        }

        let handled = inboxOn ? (failures.get(rec.id)?.handled ?? null) : null;
        try {
          if (rec.fromMe) {
            if (recordReply(rec, ts)) tally.replies += 1;
            if (inboxOn) await inboxAfterOutbound(rec, ts, tally);
          } else if (handled) {
            // Matched and merged on an earlier attempt; only the inbox steps failed.
            await inboxAfterInbound(rec, ts, handled, tally);
          } else {
            const out = await handleInbound(rec, ts);
            if (!out) tally.unmatched += 1;
            else {
              tally.matched += 1;
              if (out.created) tally.created += 1; else tally.merged += 1;
              if (inboxOn) {
                handled = out;
                await inboxAfterInbound(rec, ts, out, tally);
              }
            }
          }
          if (inboxOn) noteCandidateSafely(rec, ts, tally);
          // Remembered once it is safely handled, so a transient store failure costs a
          // retry rather than the lead. (One process owns this loop; two would need the
          // claim to be the INSERT itself.)
          db.waSeenAdd(rec.id, ts);
          failures.delete(rec.id);
        } catch (err) {
          // No content, no jid: a record that fails is a bug to fix, not a person to log.
          const attempts = (failures.get(rec.id)?.attempts ?? 0) + 1;
          const writtenOff = attempts >= MAX_RECORD_ATTEMPTS;
          if (writtenOff) {
            db.waSeenAdd(rec.id, ts);
            failures.delete(rec.id);
            recordGapSafely(rec, ts);
          } else {
            failures.set(rec.id, {
              attempts, ts,
              ...(handled ? { handled } : {}),
              ...(inboxOn ? { gap: { id: rec.id, jid: rec.jid ?? null, jidAlt: rec.jidAlt ?? null, noise: Boolean(rec.noise) } } : {}),
            });
            if (oldestFailedTs === null || ts < oldestFailedTs) oldestFailedTs = ts;
          }
          log({ level: 'warn', evt: 'wa.poll.record_failed', attempts, writtenOff, ...errorKind(err) });
        }
      }

      // A count, never a number or an id: this is the gap above, made visible without
      // reopening it. See the module header and `learnTeamLid`/`isTeamLid` (lib/team.mjs).
      // `info`, not `warn` — a privacy-mode client makes this fire on almost every tick,
      // and `status().lidOnlyUnexcludable` is the running total for anyone watching it.
      if (tally.lidOnlyUnexcludable) log({ level: 'info', evt: 'poll.lid_only_unexcludable', count: tally.lidOnlyUnexcludable });

      // `readWindow` splits a crowded window by time until every piece fits the page cap, so
      // this now takes a piece still over the cap at the deepest split — thousands of
      // messages inside a few minutes. Newest-first paging hides that piece's OLDEST
      // messages and asking again returns the same newest ones, so this is a loss, and it
      // says so, with how many it could not read (`missing`, from Evolution's own `total`).
      if (answer?.truncated) log({ level: 'warn', evt: 'wa.poll.truncated', scanned: records.length, missing: Number.isFinite(answer.missing) ? answer.missing : null, gte, lte });

      // Forward only, no further back than the newest message we saw, and never reaching
      // back more than one window: those three together are what keeps this cheap.
      const floor = lte - MAX_WINDOW_MS;
      let nextTs = Math.max(since, maxTs || lte, floor);
      // …except that a record we still owe a retry has to stay inside the next window, or
      // it is neither retried nor written off — it is simply lost, quietly. The floor still
      // applies, so one poison record can hold the cursor for three ticks, never for ever.
      if (oldestFailedTs !== null) nextTs = Math.max(floor, Math.min(nextTs, oldestFailedTs));
      db.waCursorSet(instance, { lastTs: nextTs, lastRun: t, unmatched: (cursor?.unmatched ?? 0) + tally.unmatched });

      // What the next window cannot reach will never come back: give up on it out loud
      // rather than counting attempts against a record that can no longer be tried. A
      // record of an `in` chat given up on this way is as lost as one written off, so it
      // leaves the same gap in the thread (`gap` is kept only by the per-record `catch`;
      // a record only ever deferred by `deferRecord` was never judged, so it has none).
      let abandoned = 0;
      for (const [id, failure] of failures) {
        if (failure.ts < nextTs - OVERLAP_MS) {
          failures.delete(id);
          abandoned += 1;
          if (failure.gap) recordGapSafely(failure.gap, failure.ts);
        }
      }
      if (abandoned) log({ level: 'warn', evt: 'wa.poll.abandoned', count: abandoned });
      db.pruneWaSeen(t - SEEN_TTL_MS);
      matched += tally.matched;
      lidOnlyUnexcludable += tally.lidOnlyUnexcludable;
      if (tally.matched || tally.replies || tally.stored || tally.joined || tally.candidates) log({ evt: 'wa.poll.tick', ...tally });
      return tally;
    } catch (err) {
      log({ level: 'warn', evt: 'wa.poll.failed', error: String(err?.message ?? err) });
      return { error: String(err?.message ?? err) };
    } finally {
      busy = false;
    }
  }

  /**
   * What `/health` publishes. `lagS` is the age of the last COMPLETED tick, not of the
   * newest message: a quiet Saturday must not read like an outage, and an outage — which
   * leaves the cursor untouched — must. `lidOnlyUnexcludable` is the running total of the
   * uncheckable-lid gap (module header), the quieter alternative to reading it off an
   * `info`-level log line per tick.
   */
  function status() {
    const cursor = db.waCursorGet(instance);
    const lastRun = cursor?.last_run ?? null;
    return {
      instance,
      configured,
      lastRun,
      lastTs: cursor?.last_ts ?? null,
      lagS: lastRun ? Math.max(0, Math.round((now() - lastRun) / 1000)) : null,
      unmatched: cursor?.unmatched ?? 0,
      matched,
      lidOnlyUnexcludable,
      running: Boolean(timer),
    };
  }

  function start({ intervalMs = cfg.waPollMs ?? DEFAULT_POLL_MS } = {}) {
    if (timer || !(intervalMs > 0)) return false;
    timer = setInterval(() => { tick().catch((err) => log({ level: 'warn', evt: 'wa.poll.failed', error: String(err?.message ?? err) })); }, intervalMs);
    // Polling must never be the reason the process stays alive.
    if (typeof timer.unref === 'function') timer.unref();
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop, status, get started() { return Boolean(timer); } };
}
