/**
 * The WhatsApp Ref-code poller.
 *
 * Most Bona enquiries arrive as a WhatsApp message, and a WhatsApp message on its own
 * says nothing about where the person came from. The site fixes that at the source: every
 * `wa.me` link is rewritten to prefill `… Ref BONA-W003 · K7Q2XR`, and the code is the
 * visitor's session. This loop reads the owner's inbound messages, finds that code, and
 * turns the message into a lead that knows its campaign.
 *
 * Read-only, by owner decision. The instance (`BONA_WA_INSTANCE`) is Bona's own WhatsApp since
 * 2026-11-19 (before that, the owner's personal one, shared with another agent): we poll
 * `POST /chat/findMessages` and we never set a webhook. The only thing this module writes back
 * to WhatsApp is the owner's new-lead note, and only for a lead it just created.
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
 * inbound message (a Ref line as the site writes it or a code a site session holds, real ad
 * evidence, a listing id) puts the chat `in`; a guess (the word "bona", a bare Ref-shaped
 * code no session holds, the click window, ad context from an organic entry point) puts it
 * on the owner's Unsure list; the owner's
 * own message puts a chat `in` only when it carries a Bona link or a listing number, or is a
 * property document that names neither TK nor Bona (D12, D16 — TK and private chats share
 * this number, so nothing else he sends counts; lib/inbox/eligibility.mjs has the rules).
 * Only `in` chats are kept as transcripts (lib/inbox/ingest.mjs), both directions, from the
 * joining message plus the 24 h before it. An `out` chat never comes back on its own.
 *
 * **Real-estate chats to check** (D17). A message that ends up with no lead behind it — a
 * stranger's that matched no rule, or the owner's to a stranger that did not join — but
 * uses property words (`propertyWordsIn`) or mentions a property document (a brochure, or a
 * floor plan, price list … next to a property word; any document word on a document the
 * owner sent: `candidateWordsOf`), or is a document of his that names TK, puts its chat on
 * the owner's list (lib/inbox/store.mjs `noteCandidate`) when the chat has a phone number:
 * the number and jid (and lid, when WhatsApp shows one), the name WhatsApp shows for a
 * client (never the owner's own, on a message he sent), the property words and the time.
 * Never the text, never a lead, never a note to anyone; the owner moves it into the inbox or
 * marks it not a client. A chat that becomes a lead leaves the list. Every other
 * conversation is still discarded exactly as above.
 *
 * **Bona's own number** (DESIGN §3.1-3.2, PR-A1). While the configured number is Bona's own
 * (`BONA_WA_INSTANCE_JID` is a phone jid: `ownNumberFrom` 'instance'), these hold on top of the
 * rules above:
 *   - whatever the switches say, no chat with a phone is put on the list to check (the privacy
 *     page no longer describes that list for Bona's number), and the first tick after a start
 *     asks the store to drop the open rows with a phone already there
 *     (`pruneCandidates({ phones: true })`, PR-A2);
 *   - whatever the switches say, a chat the owner marked *Not a client* on that list
 *     (`dismissedCandidateFor`, PR-A2) is held: no lead, no join, nothing stored, by its phone,
 *     jid or lid (the record's or its lead's), whichever rule would have taken it, in either
 *     direction (a `fromMe` Bona link too), and the mark is never removed by the poller;
 *   - whatever the switches say, a chat with no number anywhere (an `@lid` with no phone alt, and
 *     no lead with a phone for it) never makes a lead or joins, whatever it carries (a Ref, ad
 *     evidence, a keyword, a click);
 *   - under the own-number rule (`ownerTest.ownRuleFor`, lib/owner-test.mjs: the identity check
 *     passed and `own_inbox` is on) every 1:1 chat with a phone joins `in` (`own_number`, and
 *     `leads.inbox_via` is stamped at the join); a lid-only chat is listed instead (the ids, the
 *     name, the times, never the text); an old `out` chat or a dismissed one that writes is
 *     noted for the owner (`old_out_wrote`, once a day);
 *   - under the owner's test switch his own chat joins as a client's (`owner_test`), from the
 *     moment the switch went on, and Bona's own lines to him (notes, call alerts) never start or
 *     join it.
 * Before the team check, an owner `#dana …` command goes to `ownerTest.command`, which consumes
 * it: never stored, never a lead. The own rule and the test also need the poller's own ask of the
 * identity check (`ownerTest.ownNumberOk`), at the first attempt and again at a retry (fail
 * closed), and a chat that joined under either is left alone while that check fails (the
 * rollback guard): not joined again, not stored, so nobody is woken. Without `ownerTest` there is
 * no own rule, no test and no command, but the first three holds above still apply on Bona's
 * number (with the inbox wired). On the personal number (`ownNumberFrom` 'owner' or 'invalid')
 * every rule is the shared one above, exactly.
 */
import { parseRef } from './attribution.mjs';
import { MAX_PAGES, PAGE_SIZE, bareJid, oldestFirst, readWindow } from './evolution.mjs';
import { JOIN_HISTORY_MS } from './inbox/backfill.mjs';
import {
  BONA_WORD_RE, LISTING_ID_RE, MAX_PROPERTY_WORDS, PROPERTY_DOC_RE, hasAdEvidence, inboundSignal, isTkDocument, mentionsPropertyDocument,
  nextInboxState, ownerOutboundJoins, propertyWordsIn,
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
 * Our own notes to the owner, read back out of his chat: the header of every kind
 * lib/owner-notes.mjs sends (DESIGN §7.1; the new-enquiry one is leadNote()'s first line, and a
 * merged note starts with its first note's). A note says "Bona" and mostly a listing id or a
 * site link, so without this it would keyword-match and become an enquiry from ourselves, or
 * join the owner's chat. `fromMe` normally keeps it out; this is the belt to that pair of braces.
 *
 * The WHOLE first line, exactly as a note renders it: `*Bona — alert*` (the stars balanced, or
 * none), then the end of the line or of the text; only the command reply's `*Bona — test mode*`
 * may carry its ` ON` / ` OFF` (DESIGN §7.2). A prefix is not enough: a client's
 * "Bona — email me the floor plan for BONA-W003" starts the same way, and dropping it would lose
 * an enquiry (T06-9 pins both sides; lib/owner-notes.mjs keeps every header on its own line).
 */
export const OWN_NOTE_RE = /^(\*?)Bona — (?:(?:new enquiry|hand-over|viewing booked|assistant stopped|daily summary|alert|email)\1|test mode\1(?: (?:ON|OFF))?)[ \t]*(?:\r?\n|$)/;
/** What the owner's list shows for a chat WhatsApp shows by its lid alone (DESIGN §3.1): no words of its own. */
export const LID_ONLY_WORD = 'lid-only';
/** Riyadh is UTC+3 all year: the day an `old_out_wrote` note is counted in. */
const RIYADH_OFFSET_MS = 3 * 3_600_000;
/** How often one record may fail before it is written off rather than retried for ever. */
export const MAX_RECORD_ATTEMPTS = 3;
/** What the owner's list shows for a document of his that names TK (D16, D17). */
export const TK_DOCUMENT_WORD = 'tk document';
/**
 * What it shows for a property document in a message or a document's name that did not join:
 * a brochure, or a floor plan, price list … next to a property word
 * (lib/inbox/eligibility.mjs `mentionsPropertyDocument`), or any property-document word
 * (`PROPERTY_DOC_RE`) on a document the owner sent.
 */
export const PROPERTY_DOCUMENT_WORD = 'property document';

/**
 * Why a record's chat belongs on the owner's list of real-estate chats to check (D17): the
 * property words in its text or caption and, for a document, in its file name — after
 * `tk document` when it is a document the owner sent that names TK, and `property document`
 * when the record mentions a property document.
 *
 * - A document the owner sent: any property-document word (`PROPERTY_DOC_RE`) in its caption
 *   or file name. So every owner-sent property document that did not join — it names Bona, its
 *   name was cut too close to the word (Task 15), or it is a price list with no property word
 *   beside it (D16 owner answer: it may be TK fit-out work) — is on the list.
 * - Any other record, in either direction (a client's or a stranger's message or file, the
 *   owner's own text): only a property document by D16's own test (`mentionsPropertyDocument`:
 *   a brochure, or a floor plan, price list … with a property word beside it), read in the text
 *   or caption and in a document's file name each on its own. A document word alone is as
 *   often an everyday word — a travel plan (مخطط للسفر), a car's payment plan, a restaurant's
 *   price list, a car manual (كتيب السيارة) — and keeps no stranger's number or name (final
 *   review, 2026-09-29).
 *
 * Canonical words only, never the text. A word at the end of a name cut at 120 characters may
 * be the start of a longer one; that only ever puts a chat on the list to check, never in the
 * inbox.
 * @returns {string[]} at most `MAX_PROPERTY_WORDS`
 */
export function candidateWordsOf(rec) {
  const text = typeof rec?.text === 'string' ? rec.text : '';
  const doc = typeof rec?.media === 'string' && rec.media.startsWith('[document');
  const name = doc && typeof rec.fileName === 'string' ? rec.fileName : '';
  const markers = [];
  if (rec?.fromMe === true && isTkDocument(rec)) markers.push(TK_DOCUMENT_WORD);
  const ownerDocument = rec?.fromMe === true && doc;
  const mentions = ownerDocument ? (s) => PROPERTY_DOC_RE.test(s) : mentionsPropertyDocument;
  if (mentions(text) || (name && mentions(name))) markers.push(PROPERTY_DOCUMENT_WORD);
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
const isNewsletter = (jid) => typeof jid === 'string' && jid.endsWith('@newsletter');

/**
 * A chat this loop has no business reading: a group (Bona's listings are published from
 * one and the intake daemon owns it), a status broadcast, a WhatsApp channel (`…@newsletter`:
 * a channel the instance follows posts listings all day, and nobody in it is a client; DESIGN
 * §3.1, the one change to the shared rule, and it only narrows it), or the owner's own chat
 * with himself — which is where this service's notes are sent, so reading it back would make
 * the poller answer its own messages.
 */
export function isIgnorableChat(jid, ownerDigits = '') {
  if (!jid) return true;
  if (isGroup(jid) || isBroadcast(jid) || isNewsletter(jid)) return true;
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
 * @param {(leadId: string, ts: number) => void} [o.onClientMessage]
 *        Phase 3 phone alerts: called, never awaited, when a client record the poller read
 *        is stored in an `in` chat (design §5, P3-9), with the record's time as the tick
 *        settled it (its own, or the tick's when it has none). Never for a join's history, the
 *        owner's side, or anything the poller did not read itself; one that throws is a
 *        `poll.alert_failed` warn line, not a failed record.
 * @param {(leadId: string, ts: number) => void} [o.onUnsureLead]
 *        "New chat to check" alerts (2026-10-04 design, U1): called, never awaited, when an
 *        inbound record moves a lead INTO the Unsure list — a new lead, or one that had no
 *        inbox state yet (a form or web-chat lead's first WhatsApp message with no sure signal
 *        included) — with the record's time. Never for a chat already Unsure writing
 *        again, a join, or the owner's side; one that throws is a `poll.alert_failed` warn line.
 * @param {object} [o.ownerTest] lib/owner-test.mjs (PR-A2): `ownRuleFor(jids)`, `active()`,
 *        `ownNumberOk()`, `ownerLid()` and `command(rec)` (sync or async), read on Bona's own
 *        number only (module header). Every answer is checked for exactly `true` (or a lid), and
 *        one that throws means "no": the rule of today. `ownRuleFor()` and `active()` count only
 *        while `ownNumberOk()` says yes as well (fail closed). Omitted (older wiring, the Phase 1
 *        tests), there is no own rule, no test and no command.
 * @param {object} [o.notes] lib/owner-notes.mjs: the new-enquiry note goes through
 *        `notes.leadEvent(lead, { why, created, ts })` — why 'wa' for a lead this loop created
 *        under the shared rule, 'joined' for a chat that joined under the own rule or the test
 *        (one call per chat either way) — and the old-chat note through `notes.alert`. Omitted,
 *        the new-enquiry note goes through `sendWhatsApp` exactly as before, and there is no alert.
 */
export function createPoller({
  db, cfg = {}, findMessages = null, sendWhatsApp = null, isExcluded = NO_EXCLUSIONS, log = () => {}, now = () => Date.now(),
  inboxStore = null, ingest = null, backfill = null, fetchImpl = undefined, onClientMessage = null, onUnsureLead = null,
  ownerTest = null, notes = null,
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
  // The instance's own number (BONA_WA_INSTANCE_JID; unset = BONA_OWNER_JID, as before the
  // split): its chat with itself is never read, and a sent record whose alt is it is ours.
  const ownerDigits = bareJid(wa.instanceJid);
  const configured = Boolean(findMessages) || Boolean(wa.baseUrl && wa.apiKey);
  // Whether a team is wired at all — not whether it currently excludes anyone — because an
  // uncheckable lid-only chat is worth counting the moment team accounts exist, even before
  // any pairing has been learned.
  const teamWired = isExcluded !== NO_EXCLUSIONS;
  const find = findMessages ?? (({ gte, lte }) => readWindow({
    baseUrl: wa.baseUrl, apiKey: wa.apiKey, instance, gte, lte, offset: PAGE_SIZE, maxPages: MAX_PAGES, fetchImpl,
  }));
  // Bona's own number is the configured one (module header): only then do the own rule, the
  // test switch, the dismissed-chat hold and the no-phone-row rule apply.
  const bonaNumber = wa.ownNumberFrom === 'instance';
  // The owner's personal number (BONA_OWNER_JID). Only when it is not the instance's own is his
  // chat a chat on this instance at all; when it is, his chat is the self-chat, never read.
  const ownerPhone = normalisePhone(bareJid(wa.ownerJid));
  const ownerApart = Boolean(ownerPhone) && ownerPhone !== normalisePhone(ownerDigits);
  // BONA_WA_LINKED_AT (lib/config.mjs `waLinkedAt`, ms): what "before the move" means for an old
  // `out` chat or a dismissed one. Unset: every mark counts as before it (the owner is told).
  const linkedAt = Number.isFinite(cfg.waLinkedAt) ? cfg.waLinkedAt : null;

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
  /** Whether this process has asked the store to drop the open rows with a phone (Bona's number, once per start). */
  let prunedPhones = false;
  /** `<lead or candidate>:<Riyadh day>` keys this process has raised `old_out_wrote` for: one a chat a day (the ledger keys it the same way). */
  const alerted = new Set();

  /* -------------------- the test switch and the own rule, safely -------------------- */

  /**
   * One answer of lib/owner-test.mjs. It reads settings and the identity guard, which nothing
   * here retries; a throw, a missing method or no module at all is `fallback`, the answer that
   * means "today". Logged by the error's kind only (no message, so no number).
   */
  function askTest(name, fallback, ...args) {
    if (!ownerTest || typeof ownerTest[name] !== 'function') return fallback;
    try {
      return ownerTest[name](...args);
    } catch (err) {
      log({ level: 'warn', evt: 'poll.owner_test_failed', call: name, ...errorKind(err) });
      return fallback;
    }
  }
  /** Bona's number, and its identity checked out (DESIGN §5.3): the rollback guard's key. */
  const ownNumberOk = () => bonaNumber && askTest('ownNumberOk', false) === true;
  /**
   * The owner's test switch is in force (and his number is not the instance's). lib/owner-test.mjs
   * folds the identity check into `active()` and `ownRuleFor()` itself; the poller asks it again on
   * its own (fail closed), so an answer that disagrees with `ownNumberOk()` is today's rule.
   */
  const testActive = () => ownerApart && ownNumberOk() && askTest('active', false) === true;
  /** The owner's own lid (his users row), for the team-lid exception and to know his chat by lid. */
  function ownerLid() {
    const lid = askTest('ownerLid', null);
    return isLid(lid) ? lid : null;
  }
  /**
   * The own-number rule holds for these jids (lib/owner-test.mjs decides: identity, own_inbox, the
   * test), and the identity check, asked here too (fail closed, as `testActive`), passed.
   */
  const ownRuleOn = (jids) => inboxOn && ownNumberOk() && askTest('ownRuleFor', false, jids) === true;
  /**
   * The rollback guard as it stands NOW (DESIGN §4.2 `rule_off`, §13): a chat that joined under
   * the own rule is held while the identity check fails, and the owner's test chat while his test
   * is not in force. Asked again after every `await` on the way to a store or a wake (the identity
   * probe can answer while a history read or a note is out), not only when the record came in.
   */
  function ruleOff(lead) {
    if (!lead?.inbox_via) return false;
    if (!ownNumberOk()) return true;
    return lead.inbox_via === 'owner_test' && !testActive();
  }

  /** The owner's own chat (his personal number, or his lid), seen on this instance. */
  function isOwnerChat(jids, lead = null) {
    if (!ownerApart) return false;
    const phone = jids.phone ?? lead?.phone_e164 ?? null;
    if (phone) return phone === ownerPhone;
    const lid = ownerLid();
    return Boolean(lid) && (jids.waLid === lid || lead?.wa_lid === lid);
  }

  /**
   * A 1:1 person chat's phone (DESIGN §3.1): the record's own (a phone jid, or a lid whose alt
   * is one), else, for a lid-only record of a lead the tick already knows, the lead's: the
   * number the tick checked against the team and the never list for that lid. A group, a
   * broadcast, a channel or a lid nobody knows has none.
   */
  function personPhone(jids, lead = null) {
    if (jids.waJid) return jids.waJid.endsWith('@s.whatsapp.net') ? jids.phone : null;
    return jids.waLid ? (lead?.phone_e164 ?? null) : null;
  }

  /**
   * A chat with no number anywhere on Bona's number (DESIGN §3.1, "Lid-only records"): the record
   * shows none (an `@lid` with no phone alt) and no lead the tick knows for it has one. It never
   * makes a lead or joins, whatever it carries (a Ref, ad evidence, a keyword, a click): a lid
   * cannot be checked against the team or the never list, cannot be replied to, and the exclusion
   * sweep cannot catch it later (A7). Under the own rule it is listed as `lid-only` instead
   * (noteCandidateSafely). A lead the owner moved `in` by hand is not joining, so it is stored.
   */
  const numberless = (jids, lead = null) => bonaNumber && inboxOn && !jids.phone && !lead?.phone_e164;

  let testSinceStmt = null;
  /**
   * When the owner's test went on: the `updated` stamp of `owner_as_client` while it is '1'
   * (DESIGN §3.1, "The owner's test join"). His chat's history floor, and nothing he sent before
   * it joins. Null when there is none to read.
   */
  function testSince() {
    try {
      testSinceStmt ??= db.db.prepare("SELECT value, updated FROM settings WHERE key = 'owner_as_client'");
      const row = testSinceStmt.get();
      return row && row.value === '1' && Number.isFinite(row.updated) ? row.updated : null;
    } catch {
      return null;
    }
  }

  /**
   * Which rule an inbound record of this chat is under (DESIGN §3.1-3.2), on Bona's number with
   * the inbox wired: `owner` = the owner's own chat, which is a client's only under his test
   * (`ownerTest`) and from when it went on; `own` = the own-number rule for a 1:1 chat with a
   * phone. Neither, anywhere else: today's rule.
   */
  function ruleFor(jids, lead, ts) {
    const none = { owner: false, ownerTest: false, own: false };
    if (!bonaNumber || !inboxOn) return none;
    if (isOwnerChat(jids, lead)) {
      const phone = personPhone(jids, lead);
      const since = testSince();
      const on = Boolean(phone) && testActive() && (since === null || ts >= since)
        && askTest('ownRuleFor', false, { ...jids, phone }) === true;
      return { owner: true, ownerTest: on, own: false };
    }
    return { ...none, own: Boolean(personPhone(jids, lead)) && ownRuleOn(jids) };
  }

  /** Whether `ownerTest.command` took this record (an owner `#dana …` command). A throw is "no". */
  async function commandSafely(rec) {
    if (!ownerTest || typeof ownerTest.command !== 'function') return false;
    try {
      return (await ownerTest.command(rec)) === true;
    } catch (err) {
      log({ level: 'warn', evt: 'poll.command_failed', ...errorKind(err) });
      return false;
    }
  }

  /* -------------------- the owner's notes, safely -------------------- */

  /**
   * The new-enquiry note (DESIGN §7.2): through the notes module when there is one, which
   * decides what goes and when (PR-F2b's stub: a created lead's leadNote() at once, as before).
   * Without one, exactly today's send. A note is never the reason a record fails.
   */
  async function leadEventSafely(lead, o) {
    if (notes && typeof notes.leadEvent === 'function') {
      try {
        await notes.leadEvent(lead, o);
      } catch (err) {
        log({ level: 'warn', evt: 'wa.note.failed', leadId: lead.lead_id, ...errorKind(err) });
      }
      return;
    }
    if (!o.created || !sendWhatsApp) return;
    try {
      const res = await sendWhatsApp(leadNote(lead, { siteUrl: cfg.siteUrl }));
      if (res && res.ok === false) log({ level: 'warn', evt: 'wa.note.failed', leadId: lead.lead_id, error: res.error ?? 'unknown' });
    } catch (err) {
      log({ level: 'warn', evt: 'wa.note.failed', leadId: lead.lead_id, error: String(err?.message ?? err) });
    }
  }

  const riyadhDay = (t) => new Date(t + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
  /** A mark (an `inbox_out` or a dismissal) made before the move to Bona's number, or never made at all. */
  const beforeLink = (ts) => linkedAt === null || !Number.isFinite(ts) || ts < linkedAt;

  /**
   * `old_out_wrote` (DESIGN §7.2): a chat the owner marked before the move wrote to Bona's number
   * under the own rule; the note names nobody. One a chat a day from this process; the ledger
   * keys it by the same day, so a restart does not repeat it either.
   */
  function oldOutWrote(meta) {
    if (!notes || typeof notes.alert !== 'function') return;
    const day = riyadhDay(now());
    const key = `${meta.leadId ?? meta.candId}:${day}`;
    if (alerted.has(key)) return;
    for (const k of alerted) if (!k.endsWith(`:${day}`)) alerted.delete(k);
    alerted.add(key);
    try {
      const res = notes.alert('old_out_wrote', meta);
      if (res && typeof res.then === 'function') res.catch((err) => log({ level: 'warn', evt: 'poll.alert_failed', ...errorKind(err) }));
    } catch (err) {
      log({ level: 'warn', evt: 'poll.alert_failed', ...errorKind(err) });
    }
  }

  let lastOutStmt = null;
  /**
   * An `out` lead wrote under the own rule (DESIGN §1.2, critic round 2 #12). "Before the move"
   * = its newest `inbox_out` audit row (the owner's *Not a client*) is older than
   * BONA_WA_LINKED_AT, or it has none (the old shared-number rule's own outs). A lead marked out
   * on Bona's number stays silent, as today.
   */
  function oldOutLeadWrote(lead) {
    let marked = null;
    try {
      lastOutStmt ??= db.db.prepare("SELECT MAX(ts) AS ts FROM audit_log WHERE action = 'inbox_out' AND target = ?");
      marked = lastOutStmt.get(lead.lead_id)?.ts ?? null;
    } catch (err) {
      log({ level: 'warn', evt: 'poll.old_out_check_failed', leadId: lead.lead_id, ...errorKind(err) });
      return;
    }
    if (beforeLink(marked)) oldOutWrote({ leadId: lead.lead_id });
  }

  /**
   * A *Not a client* on the list to check holds on Bona's number (DESIGN §3.1; PLAN T06 tests 16,
   * 16b, 16c, 16d): a record of a chat whose phone, jid or lid is on a dismissed row makes no lead,
   * joins nothing and stores nothing, under the own rule or the shared one, in either direction:
   * a dismissed caller's Ref line, and a `fromMe` Bona link or listing id (typed on the phone, a
   * staff send, a WhatsApp Business Greeting/Away message) alike. It is asked before any branch
   * of the tick, so noise (a reaction, an edit, a delete) is held too, and the list's cleanup
   * (noteCandidateSafely) never runs for a held record: the mark is never removed by the poller,
   * only the owner's own action on the dashboard brings such a chat in. A lead already `in` is not
   * held: its own inbox state rules (the owner moved it in). Under the own rule, a mark made before
   * the move is noted for the owner when the chat writes (an inbound message only: noise is no
   * message of its own). The store's `dismissedCandidateFor` is PR-A2's; until it is there nothing
   * is held.
   *
   * The ids asked are the record's AND those of the lead it resolves to (`findLead`), which every
   * branch below judges the record by: a lid-only record of a lead whose number the owner
   * dismissed before a web form made that lead (and WhatsApp later paired it with the lid) is
   * held, as is a number record of a lead paired with a dismissed hidden-number chat's lid.
   * @returns {boolean} held
   */
  function heldAsDismissed(rec) {
    if (!bonaNumber || !inboxOn || typeof inboxStore.dismissedCandidateFor !== 'function') return false;
    const jids = jidsOf(rec);
    if (!jids.phone && !jids.waJid && !jids.waLid) return false;
    const lead = findLead(jids);
    if (lead?.inbox_state === 'in') return false;
    let row = inboxStore.dismissedCandidateFor({ phone: jids.phone, jid: jids.waJid, lid: jids.waLid });
    if (!row && lead) {
      // Only the lead's ids the record does not carry already: those were just asked.
      const other = (v, seen) => (v && v !== seen ? v : null);
      const ids = { phone: other(lead.phone_e164, jids.phone), jid: other(lead.wa_jid, jids.waJid), lid: other(lead.wa_lid, jids.waLid) };
      if (ids.phone || ids.jid || ids.lid) row = inboxStore.dismissedCandidateFor(ids);
    }
    if (!row) return false;
    if (!rec.fromMe && !rec.noise && ownRuleOn(jids) && !isOwnerChat(jids, lead) && beforeLink(row.updated)) oldOutWrote({ candId: row.cand_id });
    return true;
  }

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
    // The owner's own lid while his test switch is on (DESIGN §3.2, `exceptLid`): his chat is a
    // client's then. His only, never by role: a colleague's lid stays a colleague's.
    const except = testActive() ? ownerLid() : null;
    if (except && lid === except) return false;
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
   *
   * On Bona's number (`rule`, `ruleFor`): the owner's own chat is a client's only under his
   * test, and then always `owner_test` (a merge into his lead when there is one), never a Ref,
   * ad or click lead of his own, so no ad platform hears of his test; and under the own-number
   * rule a 1:1 chat with a phone that nothing else matched is `own_number`, the last resort.
   * @returns {object|null} null = discard
   */
  function classify({ text, contextInfo, existing, ts, rule = null }) {
    if (rule?.owner) {
      if (!rule.ownerTest) return null;
      return existing
        ? { method: 'phone', listingId: listingIdIn(text) }
        : { method: 'owner_test', listingId: parseRef(text)?.listingId ?? listingIdIn(text) };
    }
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
    if (rule?.own) return { method: 'own_number', listingId: null };
    return null;
  }

  /* -------------------- one message -------------------- */

  /**
   * A message from the owner to somebody who is already a lead is the reply that stops the
   * response clock. Nothing is created here — an outbound message to a stranger is not a lead.
   */
  function recordReply(seen, ts) {
    const lead = seen ? db.getLead(seen.lead_id) : null;
    if (!lead || lead.first_reply_ts) return false;
    db.updateLead(lead.lead_id, { first_reply_ts: ts, updated: ts });
    return true;
  }

  /**
   * Dana's own message read back (P4-5): she sends from the owner's number, so the next
   * poll sees it as a `fromMe` record, and it must not stamp `first_reply_ts` — the Hermes
   * `bona-unanswered-leads` watchdog reads that column as "a human answered". Asked after
   * ingest has run for the record: an accepted Dana send carries its WhatsApp key in the
   * outbox, and an `uncertain` one that ingest matched by exact text (P2-17) has been given
   * the key and stored as `dana` by then. Only with the inbox wired: without it nothing
   * knows Dana, and the Phase-1 poller stamps as before. A lookup that throws counts as
   * "not Dana" — the reply clock is the older contract.
   */
  function isDanaRecordSafely(rec) {
    if (!inboxOn || !rec.id) return false;
    try {
      return inboxStore.outboxByKey?.(rec.id)?.sender_kind === 'dana'
        || inboxStore.messageByKey?.(rec.id)?.sender_kind === 'dana';
    } catch {
      return false;
    }
  }

  async function handleInbound(rec, ts) {
    const jids = jidsOf(rec);
    const existing = findLead(jids);
    // On Bona's number a chat with no number anywhere makes no lead, by any rule (`numberless`).
    if (!existing && numberless(jids)) return null;
    const text = typeof rec.text === 'string' ? rec.text : '';
    const rule = ruleFor(jids, existing, ts);
    const match = classify({ text, contextInfo: rec.contextInfo, existing, ts, rule });
    if (!match) return null;

    const merge = () => createOrMergeLead(db, {
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
    // The owner's test lead is born with no inbox state (as PR-A2's reopenOwnerTest leaves an old
    // one): lib/leads.mjs creates an owner-started chat `in` with the ordinary 24 h floor
    // (OWNER_METHODS), and his chat may be `in` only with its marker and his test's floor, which
    // `join` writes in one transaction. Undone in the creation's own transaction (re-entrant), so
    // a join that fails leaves no `in` chat a second message of his in the same window would be
    // stored into (and wake Dana) unstamped.
    const { lead, created } = match.method !== 'owner_test' ? merge() : db.transaction(() => {
      const made = merge();
      if (!made.created) return made;
      db.updateLead(made.lead.lead_id, { inbox_state: null, inbox_since: null, history_from: null });
      return { ...made, lead: db.getLead(made.lead.lead_id) ?? made.lead };
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

    // The new-enquiry note for a lead this loop just created, as before — unless the chat joins
    // under the own rule or the test, whose join tells the owner instead (why 'joined', DESIGN
    // §7.2): one note a chat either way.
    if (created && !rule.own && !rule.ownerTest) await leadEventSafely(fresh, { why: 'wa', created: true, ts });
    // `refKnown`: `classify` found a site session holding the Ref code, which makes even a
    // bare `Ref K7Q2XR` certain for the inbox (amendment A6). `own` / `ownerTest`: the rule this
    // record was judged under, kept for a retry of the inbox steps.
    return {
      method: match.method, created, lead: fresh, refKnown: match.method === 'ref' && Boolean(match.sessionId),
      own: rule.own, ownerTest: rule.ownerTest,
    };
  }

  /* -------------------- the Bona inbox -------------------- */

  /**
   * One record into the transcript of an `in` chat, the lead read fresh (a backfill may just
   * have filled its jids). `ts` is the record's time as the tick settled it (its own, or the
   * tick's when it carries none) — the one the alert reports. Returns what ingest said (or null).
   */
  async function storeRecord(leadId, rec, ts, tally) {
    const res = await ingestOne(db.getLead(leadId), rec);
    if (res?.stored) tally.stored += 1;
    // A client wrote in an inbox chat: phone alerts (Phase 3, P3-9). Whether this stored it or
    // a thread refresh had a moment before, the poller reads each record once, so this is its
    // first sight of it (a record retried after `waSeenAdd` failed fires again; the two-minute
    // mark in lib/alerts.mjs keeps that quiet at the 20 s interval). Never awaited; one that
    // throws is a warn line, not a failed record. Not for a chat the rollback guard holds as it
    // stands after ingest's `await` (`ruleOff`): refusing the record is ingest's (PR-A2), the
    // wake is the poller's.
    if (res?.stored && res.senderKind === 'client' && onClientMessage && !ruleOff(db.getLead(leadId))) {
      try {
        onClientMessage(leadId, ts);
      } catch {
        log({ level: 'warn', evt: 'poll.alert_failed', leadId });
      }
    }
    return res ?? null;
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
   *
   * `inboxVia` (DESIGN §3.1, §11.1) stamps how the chat joined beyond the proof rules —
   * 'own_number' or 'owner_test' — at the join, onto a lead that has none; it is never
   * rewritten. `floor` is the owner's test join (critic round 2 #3): his chat's floor is the
   * moment his test went on, set even where a join of his before left another one, and there is
   * no 24 h history read, which would store his earlier texts (`#dana test on` included) as a
   * client's.
   */
  async function join(leadId, ts, via, tally, extra = {}, { inboxVia = null, floor = null } = {}) {
    const testFloor = Number.isFinite(floor) ? floor : null;
    // The history floor goes with the state: nothing of this chat from before the 24 h is
    // ever stored, whichever read brings it (lib/inbox/ingest.mjs). The state, the marker and the
    // test floor are one transaction (the inbox store writes through this same db): a failure
    // part-way leaves the chat as it was, never `in` without the marker the rollback guard reads,
    // which a retry (finding it `in` already) would not write again.
    db.transaction(() => {
      inboxStore.setInboxState(leadId, 'in', { since: ts, historyFrom: testFloor ?? ts - JOIN_HISTORY_MS });
      if (inboxVia || testFloor !== null) {
        const current = db.getLead(leadId);
        const patch = {};
        if (inboxVia && current && current.inbox_via == null) patch.inbox_via = inboxVia;
        if (testFloor !== null) patch.history_from = testFloor;
        if (Object.keys(patch).length) db.updateLead(leadId, patch);
      }
    });
    if (backfill && testFloor === null) {
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
   * never move from here (lib/inbox/eligibility.mjs `nextInboxState`). A known lead with no
   * inbox state (a form or web-chat enquiry) whose message carries no sure signal enters
   * the Unsure list too (U1, amended), and either way the owners are told (`onUnsureLead`).
   * Unsure keeps no transcript: the chat is drawn only on the owners' Unsure page, never in
   * the team's inbox, until an owner moves it in. A bare
   * Ref-shaped code is certain only when a site session holds it (`refKnown`, A6), and ad
   * context only when it is real ad evidence (`hasAdEvidence`: a click id, a conversion
   * source, the ctwa_ad entry point, an ad source type). An organic entry point — a wa.me
   * link, WhatsApp search, a tapped number — still makes an `ad_meta` lead for the
   * statistics, and that lead goes to the Unsure list.
   *
   * Decided on the lead as it is NOW, not as `handleInbound` read it: the owner's note was
   * sent in between (and a retried record carries the lead from its first attempt), and a
   * chat the owner put `out` meanwhile — Not a client, the never list — must stay out.
   *
   * On Bona's number (`own`, `ownerTest`: the rule `handleInbound` judged the record under):
   * under the own rule an undecided or unsure chat joins whatever the message says (stamped
   * 'own_number'), and an old `out` one is noted for the owner; the owner's test chat joins
   * from when his test went on (stamped 'owner_test'). Such a join tells the owner (why
   * 'joined') before the record is stored, so a store failure retried later cannot lose it. A
   * chat stamped either way is left alone while the identity check fails, and his test chat while
   * his test is off (the rollback guard, `ruleOff`), asked when the record comes in and again
   * after every `await` of a join (its history read, its note). The rule a record was judged under is asked again here, not trusted from its first attempt
   * (fail closed): the identity check AND the switch behind it, so a retry after the identity
   * check lapsed, or after the own rule went off (`#dana live off`), is today's rule, and the
   * owner's own message once his test is no longer in force is a colleague's (held, never stored).
   *
   * A chat with no number anywhere (`numberless`) does not join, whatever the message carries: it
   * keeps its state (an undecided one goes to Unsure, as any guess), and nothing is stored unless
   * the owner had already moved it `in`.
   */
  async function inboxAfterInbound(rec, ts, { lead: seen, method, refKnown, created = false, own: ownThen = false, ownerTest: testThen = false }, tally) {
    const lead = db.getLead(seen.lead_id);
    if (!lead) return;
    if (ruleOff(lead)) { tally.held += 1; return; }
    // `ownRuleOn` = the identity check and `ownRuleFor` (own_inbox) as they are now; `testActive`
    // = the identity check and the test switch as they are now.
    const own = ownThen && ownRuleOn(jidsOf(rec));
    const isTest = testThen && testActive();
    if (testThen && !isTest) { tally.held += 1; return; }
    const text = typeof rec.text === 'string' ? rec.text : '';
    const signal = inboundSignal({ text, hasAdMeta: hasAdEvidence(adMetaOf(rec.contextInfo)), refKnown });
    // The owner's test chat has no state until it joins (`handleInbound` creates it so), so his
    // test joins it here like any undecided chat under the own rule.
    let next = nextInboxState(lead.inbox_state, { signal, method, own: own || isTest });
    if (next === 'in' && lead.inbox_state !== 'in' && numberless(jidsOf(rec), lead)) next = null;
    if (next === 'in' && lead.inbox_state !== 'in') {
      const inboxVia = isTest ? 'owner_test' : (own ? 'own_number' : null);
      const floor = isTest ? (testSince() ?? ts) : null;
      await join(lead.lead_id, ts, 'inbound', tally, inboxVia ? { inboxVia } : {}, { inboxVia, floor });
      // The rollback guard again, as it is after the join's history read and again after the note
      // (`ruleOff`): a lapse while either was out holds the record — no note after the read, no
      // store, no wake. The chat stays `in` and stamped, so the guard holds its next records too.
      if (ruleOff(db.getLead(lead.lead_id))) { tally.held += 1; return; }
      if (inboxVia) {
        await leadEventSafely(db.getLead(lead.lead_id) ?? lead, { why: 'joined', created, ts });
        if (ruleOff(db.getLead(lead.lead_id))) { tally.held += 1; return; }
      }
    } else if (own && lead.inbox_state === 'out') {
      oldOutLeadWrote(lead);
    } else {
      // A known lead with no inbox state yet (a website-form or web-chat lead) whose WhatsApp
      // message carries no sure signal is already drawn on the Unsure list (it has a jid now,
      // lib/inbox/store.mjs UNSURE_CHAT): it enters `unsure` explicitly, once (U1, amended).
      // Strictly NULL: `in` and `out` never move from here.
      const target = next ?? (lead.inbox_state == null ? 'unsure' : null);
      if (target && target !== lead.inbox_state) {
        inboxStore.setInboxState(lead.lead_id, target, { since: ts });
        // The chat has just entered the Unsure list from the client's side: the owners are told (U1).
        if (target === 'unsure' && onUnsureLead) {
          try { onUnsureLead(lead.lead_id, ts); } catch { log({ level: 'warn', evt: 'poll.alert_failed', leadId: lead.lead_id }); }
        }
      }
    }
    if (next === 'in') await storeRecord(lead.lead_id, rec, ts, tally);
  }

  /**
   * What the owner's own message means for the inbox; `recordReply` stamps the reply clock
   * right after this (the Hermes `bona-unanswered-leads` watchdog reads `first_reply_ts`),
   * unless the record turns out to be Dana's own (P4-5). In an `in` chat it is stored: typed on his phone or sent by Lisa,
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
   *
   * The owner's own chat (DESIGN §3.1, critic round 2 #4): what Bona sends him — notes, the
   * phone line's call alerts ("Listings: BONA-W012"), command replies — never starts or joins
   * his chat; his test chat joins only on his own message. Once it is `in`, ingest decides what
   * of it is kept (PR-A2). And a chat that joined under the own rule or the test is left alone
   * while the identity check fails, or his test chat while his test is off (the rollback guard,
   * `ruleOff`), asked again after a join's history read.
   *
   * Returns whether ingest stored the record: in the owner's own chat that alone may stamp the
   * reply clock (the tick), since nothing else Bona sends him there is an answer to his test.
   */
  async function inboxAfterOutbound(rec, ts, tally) {
    const jids = jidsOf(rec);
    let lead = findLead(jids);
    if (isOwnerChat(jids, lead) && lead?.inbox_state !== 'in') return false;
    if (ruleOff(lead)) { tally.held += 1; return false; }
    if (lead?.inbox_state === 'out') return false;
    if (lead?.inbox_state !== 'in') {
      if (OWN_NOTE_RE.test(String(rec.text ?? '').trimStart())) return false;
      if (!ownerOutboundJoins(rec)) return false;
      if (lead && !(jids.waJid || lead.phone_e164 || lead.wa_jid)) return false;
      let created = false;
      if (!lead) {
        if (!jids.phone) return false;
        const text = typeof rec.text === 'string' ? rec.text : '';
        const fileName = typeof rec.fileName === 'string' ? rec.fileName : '';
        ({ lead, created } = createOrMergeLead(db, {
          name: null, phone: jids.phone, waJid: jids.waJid, waLid: jids.waLid,
          listingId: listingIdIn(`${text} ${fileName}`),
        }, { channel: 'whatsapp', matchMethod: 'owner_outbound', now: ts, dataDir: cfg.dataDir ?? undefined }));
      }
      await join(lead.lead_id, ts, 'owner_outbound', tally, { created });
      if (ruleOff(db.getLead(lead.lead_id))) { tally.held += 1; return false; }
    }
    const res = await storeRecord(lead.lead_id, rec, ts, tally);
    return res?.stored === true;
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
   * become a lead off the list (`dropCandidateRows`).
   *
   * Known edge, accepted: the note is written before the record is marked seen, and the two
   * are not one transaction (the list never fails the record, D17). If `waSeenAdd` throws
   * right after a note, the record is retried and noted again, so `hits` — the "N messages"
   * the owner's list shows — is one too high for that chat; its times and words come out the
   * same. It needs a failure between two synchronous writes, so it is left as it is.
   *
   * On Bona's own number (DESIGN §3.1, PR #87 review rounds 1-2) no chat with a phone is
   * noted, whatever the switches say: the privacy page no longer describes that list there. A
   * lid-only chat is noted instead, under the own rule only and from its inbound records only:
   * `lid-only` for its words, the name WhatsApp shows, the times and the count, so the row
   * keeps no more than the page's hidden-number sentence lists (never who wrote last but the
   * client, never the text).
   */
  function noteCandidateSafely(rec, ts, tally) {
    try {
      const jids = jidsOf(rec);
      if (jids.waJid && !jids.waJid.endsWith('@s.whatsapp.net')) return;
      if (!jids.phone && !jids.waJid && !jids.waLid) return;
      const lead = findLead(jids);
      if (lead) {
        dropCandidateRows(jids, lead);
        return;
      }
      if (rec.noise) return;
      if (!jids.phone) {
        if (rec.fromMe || jids.waJid || !jids.waLid || isOwnerChat(jids) || !ownRuleOn(jids)) return;
        const res = inboxStore.noteCandidate({
          jid: null, lid: jids.waLid, phone: null, name: rec.pushName ?? null, ts, words: [LID_ONLY_WORD], dir: 'in',
        });
        if (res.state === 'open') tally.candidates += 1;
        return;
      }
      if (bonaNumber) return;
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

  /**
   * A chat that became a lead leaves the list: its rows go, its inbox state rules now. On Bona's
   * number, while that lead is not `in`, only its OPEN rows go, id by id: a dismissed row is the
   * owner's *Not a client* (`heldAsDismissed`), which only his own action ends. The hold already
   * keeps a dismissed chat's records away from here; this keeps the mark when it lands while a
   * record is being handled (after the hold was asked, before this cleanup). Without PR-A2's
   * `dismissedCandidateFor` the store cannot tell the two apart and nothing is held yet, so every
   * row goes, as today; off Bona's number, and for a lead the owner moved in, as today too.
   */
  function dropCandidateRows(jids, lead) {
    const ids = { phone: jids.phone, jid: jids.waJid, lid: jids.waLid };
    if (!bonaNumber || lead.inbox_state === 'in' || typeof inboxStore.dismissedCandidateFor !== 'function') {
      inboxStore.removeCandidatesFor(ids);
      return;
    }
    for (const [kind, id] of Object.entries(ids)) {
      if (id && !inboxStore.dismissedCandidateFor({ [kind]: id })) inboxStore.removeCandidatesFor({ [kind]: id });
    }
  }

  /* -------------------- the tick -------------------- */

  /**
   * One pass: read the window since the cursor, keep what matches, move the cursor.
   *
   * Nothing in here may throw. An Evolution outage leaves the cursor exactly where it was,
   * so the window simply widens and the messages are picked up when it comes back; what
   * the outage does change is `status().lagS`, which is the number `/health` publishes.
   *
   * One at a time: a tick that finds one running answers `{ busy: true }` at once. The
   * running one's promise is kept so `stop()` can hand it back — a shutdown waits for the
   * tick in flight (and the alert it may raise) before it flushes the alerts and closes.
   */
  let running = Promise.resolve();
  async function tick() {
    if (busy) return { busy: true };
    const p = tickInner();
    running = p.catch(() => {});
    return p;
  }

  async function tickInner() {
    busy = true;
    try {
      if (!configured) {
        // Once per process: a missing key is a standing state, not news on every tick.
        if (!skipLogged) { skipLogged = true; log({ evt: 'wa.poll.skipped', reason: 'evolution_not_configured' }); }
        return { skipped: 'not_configured' };
      }
      // Bona's number keeps no open row with a phone (noteCandidateSafely): the first tick after
      // a start drops the ones already there (PR-A2's option; dismissed rows stay, they carry the
      // owner's "Not a client"). Retried next tick if it fails.
      if (inboxOn && bonaNumber && !prunedPhones) {
        try {
          inboxStore.pruneCandidates({ phones: true });
          prunedPhones = true;
        } catch (err) {
          log({ level: 'warn', evt: 'inbox.candidates_prune_failed', ...errorKind(err) });
        }
      }
      const t = now();
      const cursor = db.waCursorGet(instance);
      const since = Number.isFinite(cursor?.last_ts) && cursor.last_ts > 0 ? cursor.last_ts : t - FIRST_RUN_LOOKBACK_MS;
      const gte = Math.max(0, since - OVERLAP_MS);
      const lte = t;

      const answer = await find({ gte, lte, instance });
      const records = Array.isArray(answer) ? answer : (answer?.records ?? []);

      const tally = {
        scanned: records.length, matched: 0, unmatched: 0, created: 0, merged: 0, replies: 0, ignored: 0, lidOnlyUnexcludable: 0, stored: 0, joined: 0,
        candidates: 0, commands: 0, held: 0,
      };
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

        // An owner command (`#dana …`, DESIGN §3.2), before the team drop: his number is a
        // colleague's while his test is off. lib/owner-test.mjs decides and acts; a record it
        // takes is consumed here, whichever switch is on: marked seen, never stored, never a
        // lead, nobody woken. An edit or a reaction is never a command.
        if (!rec.noise && await commandSafely(rec)) {
          tally.commands += 1;
          try { db.waSeenAdd(rec.id, ts); } catch (err) { log({ level: 'warn', evt: 'poll.command_seen_failed', ...errorKind(err) }); }
          continue;
        }

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
          // Only from a message WE received (`!rec.fromMe`), though: an outbound record's
          // alt can still be our own number for reasons that have nothing to do with whose
          // CHAT this is (`key.senderPn` always is, which is why `lib/evolution.mjs`
          // `normaliseRecord` leaves it out of a sent record's `jidAlt`). Binding a client's
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
        let held = false;
        try {
          // A chat the owner marked "Not a client" on the list to check, on Bona's number, is held
          // before any branch, noise included (`heldAsDismissed`): no lead, no join, nothing stored,
          // and the list's cleanup below never runs for it, so its row is left as he left it.
          held = heldAsDismissed(rec);
          if (rec.noise) {
            // A reaction, an edit, a delete (lib/evolution.mjs `isNoise`) is no message of
            // its own, whoever sent it: it never goes through the merge (no touchpoint, no
            // `first_inbound_ts`, no reopened add), never answers a lead, never creates one
            // (not from a Ref line or a Bona link in an edit's new text either) and never
            // moves a chat's inbox state. Ingest would refuse to store it anyway. The
            // candidate list below still hears of it (a held chat's never), only to take a
            // chat that has become a lead off the list.
            tally.ignored += 1;
          } else if (rec.fromMe) {
            // The lead as it is BEFORE the inbox steps: a stranger this record makes into an
            // `owner_outbound` lead is not stamped by it (as before). The stamp itself waits
            // for ingest, which is what tells Dana's own message from a human's
            // (`isDanaRecordSafely`). An ingest that throws stamps nothing on that attempt:
            // the record's kind is unknown, and an `uncertain` Dana send that ingest matches
            // by text has no key until it succeeds, so it would read as human. The retry
            // stamps once ingest succeeds. The cost: a human record whose ingest fails on
            // every attempt and is written off never stamps `first_reply_ts`, so the Hermes
            // watchdog nags about a lead that was answered — the harmless direction; a Dana
            // record silencing the watchdog for an unanswered lead is the harmful one.
            //
            // A held chat (above) is held on this side too: no lead, no join, nothing stored, the
            // mark kept. The reply clock of a lead it already has still stamps: that writes no message.
            //
            // Except in the owner's own chat on Bona's number (DESIGN §3.1-3.2): what Bona sends him
            // there — the phone line's call alerts, notes, command replies — is no answer to his
            // test, so only a record ingest stored in his `in` test chat stamps it (ingest decides
            // what of that chat is kept, PR-A2). Before he writes, or while his chat is held,
            // nothing does.
            const seen = findLead(jidsOf(rec));
            const ownerSide = bonaNumber && inboxOn && isOwnerChat(jidsOf(rec), seen);
            let stored = false;
            if (held) tally.held += 1;
            else if (inboxOn) stored = await inboxAfterOutbound(rec, ts, tally);
            if ((!ownerSide || stored) && !isDanaRecordSafely(rec) && recordReply(seen, ts)) tally.replies += 1;
          } else if (held) {
            tally.held += 1;
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
          if (inboxOn && !held) noteCandidateSafely(rec, ts, tally);
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
      if (tally.matched || tally.replies || tally.stored || tally.joined || tally.candidates || tally.commands || tally.held) log({ evt: 'wa.poll.tick', ...tally });
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
      ownNumber: wa.ownNumberFrom,
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

  /** Takes the loop off its timer; resolves once the tick in flight, if any, has finished. */
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    return running;
  }

  return { tick, start, stop, status, get started() { return Boolean(timer); } };
}
