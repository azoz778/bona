/**
 * Evolution API 2.3.7 (Baileys) — the READ half, for the WhatsApp poller and the Bona inbox.
 *
 * IMPORTANT: the instance this talks to (`abdulaziz-personal`) is the owner's
 * *personal* WhatsApp and is already consumed by another agent. This module only ever
 * calls `POST /chat/findMessages/{instance}`. It never sets a webhook, a websocket or
 * a rabbitmq consumer — doing so would steal the other agent's events — and it never
 * sends: what the API service sends goes through `lib/wa-send.mjs` (login codes and,
 * from Phase 2, the team's replies) and `lib/wa.mjs` (the owner's note to himself).
 *
 * It asks two kinds of question, both through that one read-only route:
 *   - a time window across every chat (`readWindow`), for the poller;
 *   - one chat (`findMessagesPage` with `where.key.remoteJid` or `where.key.remoteJidAlt`),
 *     for the Bona inbox: a joining chat's history, and the refresh when a thread is
 *     opened (lib/inbox/backfill.mjs). A privacy-mode chat is stored under two jids —
 *     what the client sends and what the owner types under the lid, what the API sent
 *     to a phone number under the phone jid — so the inbox asks for both.
 * Reading is not keeping: the window read sees every chat on the number, and only the
 * callers decide what is stored (the inbox keeps chats in the Bona inbox, nothing else).
 *
 * `services/intake/lib/evolution.mjs` talks to the same instance for the brochure
 * daemon. The two are deliberately NOT shared: they are different services with
 * different lifecycles, so the request style is copied and the response shapes below
 * are the ones verified against the live instance on 2026-09-05.
 *
 * Quirks this module exists to absorb:
 *   - `offset` is the PAGE SIZE (default 50), `page` starts at 1, records come back
 *     newest-first.
 *   - the `fromMe` filter is ignored server-side — callers filter themselves.
 *   - the `messageTimestamp` filter applies only when BOTH `gte` and `lte` are given, and
 *     it compares whole seconds: both ISO bounds are cut down to the second, both inclusive.
 *   - `where.key.remoteJid` and `where.key.remoteJidAlt` narrow a read to one chat and
 *     combine with the time filter (verified live 2026-09-28).
 *   - the boxed answer states the size of everything the filter matched, not just this
 *     page (`total`, `pages`), so a reader can tell a complete read from a cut-off one.
 *   - the response is either `{ messages: { records: [...] } }` or a bare array.
 *   - `extendedTextMessage.text` is sometimes flattened into `message.conversation`.
 *   - an ad-origin / privacy-mode chat arrives as `…@lid` with a null `pushName`; the
 *     real phone jid is then on `key.remoteJidAlt`.
 */

/**
 * The most pages one read asks for; `readWindow` cuts a window that holds more than
 * `MAX_PAGES × PAGE_SIZE`.
 */
export const MAX_PAGES = 5;
/** `offset` in the request body: how many records one page holds. */
export const PAGE_SIZE = 100;
/**
 * How many times `readWindow` may halve a window that holds more than one read can reach:
 * 4 levels = at most 16 pieces of `MAX_PAGES × PAGE_SIZE`, about 8,000 messages.
 */
export const MAX_SPLIT_DEPTH = 4;

export class EvolutionError extends Error {
  /**
   * `message` holds only the route and the status. `body` is what Evolution answered an HTTP
   * error with, which can echo the filter (phone numbers) or message text: it stays readable
   * for a caller that asks for it, but is not enumerable, so logging or spreading the error
   * never carries it along. Log `err.message`, never `err.body`.
   */
  constructor(message, status, body) {
    super(message);
    this.name = 'EvolutionError';
    this.status = status;
    Object.defineProperty(this, 'body', { value: body, enumerable: false, writable: true, configurable: true });
  }
}

/**
 * A WhatsApp timestamp in milliseconds. Accepts unix seconds, unix milliseconds, a
 * numeric string, an ISO date and the Baileys Long `{ low, high }`.
 * @returns {number|null}
 */
export function toMs(value) {
  if (value === null || value === undefined) return null;
  let n = null;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) n = Number(s);
    else {
      const parsed = Date.parse(s);
      return Number.isFinite(parsed) ? parsed : null;
    }
  } else if (value instanceof Date) n = value.getTime();
  else if (typeof value === 'object' && typeof value.low === 'number') n = value.high ? value.high * 2 ** 32 + value.low : value.low;
  if (!Number.isFinite(n) || n <= 0) return null;
  // Anything below ~2001 in milliseconds is really seconds; WhatsApp sends both.
  return n > 1e12 ? Math.round(n) : Math.round(n * 1000);
}

/** A time bound for the request body: ms, Date or ISO string → ISO string. */
export function toIso(value) {
  const ms = toMs(value);
  if (ms === null) throw new TypeError('evolution: both gte and lte are required');
  return new Date(ms).toISOString();
}

/**
 * Baileys wraps the real message when the chat is on disappearing messages or the
 * sender used view-once. Unwrapped here so an ad-origin text inside an ephemeral chat
 * still reads as text.
 */
export function unwrapMessage(message, depth = 0) {
  const m = message;
  if (!m || typeof m !== 'object' || depth > 6) return m ?? null;
  const inner = innerOf(m);
  return inner ? unwrapMessage(inner, depth + 1) : m;
}

/** The wrappers `unwrapMessage` looks through, in the order it tries them. */
const WRAPPERS = [
  'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
  'documentWithCaptionMessage', 'editedMessage',
];

/** The message one wrapper in (the first wrapper that holds one), or null. */
function innerOf(m) {
  for (const wrapper of WRAPPERS) {
    const inner = m[wrapper]?.message;
    if (inner !== undefined && inner !== null) return inner;
  }
  return null;
}

/** The body or caption of a record, whichever shape it arrived in. `''` when there is none. */
export function textOf(record) {
  const m = unwrapMessage(record?.message);
  if (!m) return '';
  const text = m.conversation
    || m.extendedTextMessage?.text
    || m.imageMessage?.caption
    || m.videoMessage?.caption
    || m.documentMessage?.caption
    || m.documentWithCaptionMessage?.message?.documentMessage?.caption
    || m.buttonsResponseMessage?.selectedDisplayText
    || m.listResponseMessage?.title
    || '';
  return typeof text === 'string' ? text : '';
}

/**
 * The ad / referral context of a record. Baileys hangs it off the message part that
 * carries it (`extendedTextMessage.contextInfo` for a click-to-WhatsApp text) and
 * Evolution sometimes copies it to the top level as well.
 */
export function contextOf(record) {
  const m = unwrapMessage(record?.message);
  const parts = m && typeof m === 'object'
    ? [m.extendedTextMessage, m.imageMessage, m.videoMessage, m.documentMessage]
    : [];
  for (const part of parts) {
    const ctx = part && typeof part === 'object' ? part.contextInfo : null;
    if (ctx && typeof ctx === 'object') return ctx;
  }
  return record?.contextInfo && typeof record.contextInfo === 'object' ? record.contextInfo : null;
}

/** `966593296933:12@s.whatsapp.net` → `966593296933`. `''` for anything unusable. */
export const bareJid = (jid) => String(jid || '').split(':')[0].split('@')[0].replace(/[^0-9]/g, '');

/**
 * Every invisible character: controls, format characters (the bidi overrides, isolates and
 * marks, the zero-width space, the soft hyphen, the tag characters, the Arabic prepended
 * marks …) and the rest of Unicode's default-ignorable set (the combining grapheme joiner,
 * the Hangul fillers, variation selectors …) — matched by category, so no hand list can miss
 * one. A file name is chosen by whoever sent the file: a right-to-left override can make
 * `fdp.exe` read as `exe.pdf`, an invisible character makes two different names look the
 * same or hides text in one, and escaping for HTML does nothing about any of it, so they go
 * before the name is shown. Spared: the zero-width non-joiner and joiner (U+200C, U+200D),
 * which Persian text and emoji sequences need, and the variation selectors U+FE00–U+FE0F,
 * which only pick how the character before them is drawn (an emoji or a text heart). The tag
 * characters that spell a subdivision flag go too: England's flag shows as a plain black flag.
 */
const INVISIBLE_RE = /[[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]--[\u{200C}\u{200D}\u{FE00}-\u{FE0F}]]/gv;
/** Longest document name kept, in code points (an emoji is one, not two). */
const MAX_FILE_NAME = 120;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * At most `max` code points of `text`, cut only between graphemes, so a flag, an emoji
 * sequence or a letter with its vowel mark is kept whole or left out whole.
 */
function capCodePoints(text, max) {
  if (Array.from(text).length <= max) return text;
  let out = '';
  let used = 0;
  for (const { segment } of GRAPHEMES.segment(text)) {
    const size = Array.from(segment).length;
    if (used + size > max) break;
    out += segment;
    used += size;
  }
  return out;
}

/**
 * Runs of whitespace. JavaScript counts U+FEFF as whitespace, but it is a zero-width no-break
 * space: it goes with the invisible characters instead of becoming a space.
 */
const SPACES_RE = /[\s--\u{FEFF}]+/gv;

/** A sender-chosen file name made safe to show: `''` when nothing usable is left. */
function cleanFileName(name) {
  if (typeof name !== 'string') return '';
  // Whitespace first, so a tab or a line break between two words leaves a space, not a join.
  const flat = name.replace(SPACES_RE, ' ').replace(INVISIBLE_RE, '').replace(SPACES_RE, ' ').trim();
  return capCodePoints(flat, MAX_FILE_NAME).trim();
}

/**
 * What stands in for a media message in a transcript (2026-09-27 design §4.2): the kind
 * only, never the file. A caption, when there is one, is the record's `text`. `null` for a
 * text message and for kinds not listed here (the inbox shows those as `[message]`).
 * @returns {string|null}
 */
export function mediaOf(record) {
  const m = unwrapMessage(record?.message);
  if (!m || typeof m !== 'object') return null;
  // A voice note is an audioMessage with `ptt` set; staff answer it differently from a file.
  if (m.audioMessage) return m.audioMessage.ptt ? '[voice note]' : '[audio]';
  if (m.imageMessage) return '[image]';
  // ptvMessage is the round "video note".
  if (m.videoMessage || m.ptvMessage) return '[video]';
  if (m.documentMessage) {
    const name = cleanFileName(m.documentMessage.fileName);
    return name ? `[document: ${name}]` : '[document]';
  }
  if (m.locationMessage || m.liveLocationMessage) return '[location]';
  if (m.contactMessage || m.contactsArrayMessage) return '[contact]';
  if (m.stickerMessage) return '[sticker]';
  return null;
}

/**
 * Record kinds that change or decorate another message instead of being one: a delete or an
 * edit (protocol), a reaction (plain or encrypted), a poll vote, an edit event (`editedMessage`),
 * an album header (the photos arrive as records of their own), a pin, and "keep" in a
 * disappearing chat.
 *
 * Dropping an edit event here is only half of showing an edit: a stored copy of the original
 * shows the new text only if whoever stores it takes a changed text for an id it already holds
 * when the original is read again. Otherwise the pre-edit text stays.
 */
const NOISE_KINDS = new Set([
  'protocolMessage', 'reactionMessage', 'pollUpdateMessage', 'editedMessage',
  'encReactionMessage', 'albumMessage', 'pinInChatMessage', 'keepInChatMessage',
]);
/** Parts that ride along with a message and never carry anything a person wrote. */
const ENVELOPE_KEYS = new Set(['messageContextInfo', 'senderKeyDistributionMessage']);

/** True when an edit wrapper sits anywhere on the way in to the real message. */
function wrappedInEdit(message) {
  let m = message;
  for (let depth = 0; m && typeof m === 'object' && depth <= 6; depth += 1) {
    if (m.editedMessage) return true;
    m = innerOf(m);
  }
  return false;
}

/**
 * True for a record that is not a message of its own and must never become a bubble: one
 * of the `NOISE_KINDS` (by `messageType` or by a part of the unwrapped message), or a record
 * that is only encryption/device envelope. A record with no message body at all is NOT noise
 * — it may be a client message the phone could not decrypt, so it shows as `[message]` rather
 * than vanishing (design §4.3, no silent loss). Nor is an unknown kind: it too shows as
 * `[message]`.
 *
 * An edit wrapper (which `unwrapMessage` takes off) decides only for a record that names no
 * kind of its own. An edit event on the wire holds a protocolMessage, which is noise by its
 * content whatever the record's type says. But Baileys reports an edit as an update to the
 * ORIGINAL, its content set to `{ editedMessage: { message: <new content> } }`: a record that
 * says it is a `conversation` or an `imageMessage` and holds that is the client's message with
 * its new content, and is kept (whether Evolution 2.3.7 stores originals that way is not
 * verified; plan P2-14).
 */
export function isNoise(record) {
  const type = typeof record?.messageType === 'string' && record.messageType ? record.messageType : null;
  if (NOISE_KINDS.has(type)) return true;
  if (type === null && wrappedInEdit(record?.message)) return true;
  const m = unwrapMessage(record?.message);
  if (!m || typeof m !== 'object') return false;
  const keys = Object.keys(m);
  if (keys.some((k) => NOISE_KINDS.has(k))) return true;
  return keys.length > 0 && keys.every((k) => ENVELOPE_KEYS.has(k));
}

/**
 * One Evolution record, flattened to what the poller and the inbox reason about.
 * `media` is `mediaOf`'s placeholder, `fileName` a document's cleaned name (null for
 * anything else), `noise` is `isNoise`. A document's name is chosen by its sender and is
 * often a person's name or a phone number, so `media` and `fileName` are never logged —
 * the same care as `text`, `pushName` and the jids.
 * @typedef {{ id: string|null, jid: string|null, jidAlt: string|null, fromMe: boolean,
 *             ts: number|null, text: string, pushName: string|null,
 *             contextInfo: object|null, messageType: string|null,
 *             media: string|null, fileName: string|null, noise: boolean }} NormalisedRecord
 */
export function normaliseRecord(record) {
  const key = record?.key ?? {};
  const jid = typeof key.remoteJid === 'string' ? key.remoteJid : null;
  const alt = key.remoteJidAlt ?? record?.remoteJidAlt ?? key.senderPn ?? null;
  return {
    id: typeof key.id === 'string' && key.id ? key.id : null,
    jid,
    jidAlt: typeof alt === 'string' && alt && alt !== jid ? alt : null,
    fromMe: key.fromMe === true,
    ts: toMs(record?.messageTimestamp),
    text: textOf(record),
    pushName: typeof record?.pushName === 'string' && record.pushName ? record.pushName : null,
    contextInfo: contextOf(record),
    messageType: typeof record?.messageType === 'string' ? record.messageType : null,
    media: mediaOf(record),
    fileName: cleanFileName(unwrapMessage(record?.message)?.documentMessage?.fileName) || null,
    noise: isNoise(record),
  };
}

/**
 * Oldest first, by timestamp. Evolution answers newest-first, and a caller that acts on
 * the records in that order sees the effect before the cause: a follow-up before the
 * message that creates the lead, a reply before the enquiry it answers. A record with no
 * usable timestamp sorts last (there is nothing to place it by) and keeps its relative API
 * order, reversed — so the newest-first tail becomes an oldest-first tail.
 */
export function oldestFirst(records) {
  const at = (r) => (Number.isFinite(r?.ts) ? r.ts : Infinity);
  return (records || [])
    .map((r, i) => ({ r, i, ts: at(r) }))
    .sort((a, b) => (a.ts === b.ts ? b.i - a.i : a.ts - b.ts))
    .map((x) => x.r);
}

/**
 * The records array in either shape 2.3.7 answers with — `{ messages: { records: [...] } }`
 * or a bare array — or null when the payload holds neither.
 */
function recordsIn(payload) {
  const box = payload?.messages ?? payload ?? {};
  if (Array.isArray(box)) return box;
  if (Array.isArray(box?.records)) return box.records;
  return null;
}

/** Both shapes 2.3.7 answers with: `{ messages: { records: [...] } }` and a bare array. */
export function recordsOf(payload) {
  return recordsIn(payload) ?? [];
}

/** How a request that never produced a readable answer failed, in words safe to log. */
const failureOf = (err) => (err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network');

/** A size Evolution states about the whole filtered set, or null when it did not state one. */
const countOf = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

/** Refuses, before anything is sent, a `name` that is not a whole number of at least `min`. */
function requireWhole(name, value, min) {
  if (!Number.isInteger(value) || value < min) {
    throw new TypeError(`evolution: ${name} must be a whole number of at least ${min}`);
  }
}

/**
 * The `where.key` fields a read may use: the two the live probe of 2026-09-28 showed narrowing
 * a read to one chat. `key.id` is left out until a caller needs it and a read-only live probe
 * shows Evolution applies it — if it were ignored, `{ key: { id } }` would read every chat.
 */
const KEY_FILTERS = new Set(['remoteJid', 'remoteJidAlt']);
/** The `where.messageTimestamp` fields Evolution reads; it applies them only as a pair. */
const WINDOW_BOUNDS = new Set(['gte', 'lte']);
/** The top-level `where` fields a read may use. */
const WHERE_FIELDS = new Set(['key', 'messageTimestamp']);
/**
 * An ISO 8601 date-time with seconds and a zone (`2026-09-06T12:00:00.000Z`, `…+03:00`), as
 * `toIso` writes it, and a real one (`2026-13-45T…` is not). Anything else `Date.parse` happens
 * to read (`'2026'`, `'Sep 1'`, a date with no time or no zone) is refused.
 */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const isIsoDate = (value) => typeof value === 'string' && ISO_DATE_TIME.test(value) && Number.isFinite(Date.parse(value));
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const onlyFrom = (object, allowed) => Object.keys(object).every((field) => allowed.has(field));

/**
 * Whether Evolution would really narrow a read by `where`, and by nothing but what was meant.
 * It silently DROPS a key filter whose value is falsy (`{ key: { remoteJid: null } }` reads
 * every chat), ignores a time filter unless both bounds are given, and ignores any field it
 * does not know — so a chat named in the wrong place (`{ remoteJid, messageTimestamp }`) reads
 * every chat in the window. Any such slip would page through every chat on the owner's
 * personal WhatsApp, into whichever thread the caller files the answer under. So this is an
 * allowlist at every level: the top level holds only `key` and `messageTimestamp`, `key` only
 * non-empty string `remoteJid`/`remoteJidAlt`, `messageTimestamp` only ISO `gte` AND `lte`,
 * and at least one of the two is there. Anything else is refused, even beside a filter that
 * does narrow (`fromMe` included: the server ignores it, so it is never worth sending).
 */
function narrowsRead(where) {
  if (!isPlainObject(where) || !onlyFrom(where, WHERE_FIELDS)) return false;
  const { key, messageTimestamp: window } = where;
  if (key === undefined && window === undefined) return false;
  if (key !== undefined) {
    if (!isPlainObject(key) || !onlyFrom(key, KEY_FILTERS)) return false;
    const given = Object.values(key);
    if (given.length === 0 || !given.every((value) => typeof value === 'string' && value !== '')) return false;
  }
  if (window !== undefined) {
    if (!isPlainObject(window) || !onlyFrom(window, WINDOW_BOUNDS)) return false;
    if (!isIsoDate(window.gte) || !isIsoDate(window.lte)) return false;
  }
  return true;
}

/**
 * One page of the messages matching `where`, newest first.
 *
 * `where` goes to Evolution as given: `{ messageTimestamp: { gte, lte } }` (ISO strings —
 * both, or the filter is ignored) for a window across every chat, `{ key: { remoteJid } }`
 * or `{ key: { remoteJidAlt } }` for one chat, or a chat and a window together. A filter
 * Evolution would not apply — empty, a key with a null or empty jid, a one-sided window — or
 * one holding any other field (a misplaced `remoteJid`, `fromMe`, `key.id` …) is refused with
 * a TypeError before anything is sent (`narrowsRead`): it would page through every chat on
 * the owner's personal WhatsApp. A `page` or `offset` that is not a whole number of at least
 * 1 is refused the same way (offset 0 would quietly page by Evolution's default of 50).
 *
 * `total` and `pages` describe everything the filter matched, not this page, when the
 * answer is boxed; both are null for a bare array, and the caller then cannot tell a
 * complete read from a cut-off one.
 *
 * A 2xx is only an answer when it holds records. A body that breaks off while it is read
 * (the timeout can fire partway through), one that is not JSON (a proxy's error page) and
 * JSON with no records in it all throw an `EvolutionError`, like an HTTP error: returned as
 * no records, each would read as an empty window, and a caller would move past every
 * message in it. Evolution's own empty answer is `{ messages: { total: 0, records: [] } }`.
 *
 * @param {{ baseUrl: string, apiKey: string, instance: string, where: object,
 *           page?: number, offset?: number,
 *           fetchImpl?: typeof globalThis.fetch, timeoutMs?: number }} o
 * @returns {Promise<{ records: NormalisedRecord[], raw: any, total: number|null, pages: number|null }>}
 */
export async function findMessagesPage({
  baseUrl, apiKey, instance, where, page = 1, offset = PAGE_SIZE,
  fetchImpl = globalThis.fetch, timeoutMs = 10_000,
} = {}) {
  if (!baseUrl) throw new TypeError('evolution: baseUrl required');
  if (!instance) throw new TypeError('evolution: instance required');
  requireWhole('page', page, 1);
  requireWhole('offset', offset, 1);
  // Checked as it will be sent: JSON.stringify keeps only an object's own enumerable fields
  // and runs toJSON, so an inherited or hidden `remoteJid` would pass a check on the object
  // itself and still go out as `{"key":{}}` — every chat. What was checked is what is sent.
  let sent = null;
  try { sent = JSON.parse(JSON.stringify(where ?? null)); } catch { sent = null; }
  // The filter itself is never put in the message: it carries phone numbers.
  if (!narrowsRead(sent)) {
    throw new TypeError('evolution: where must name a chat (key.remoteJid or key.remoteJidAlt) or a whole window (messageTimestamp gte and lte), and hold nothing else');
  }
  const root = String(baseUrl).replace(/\/+$/, '');
  const route = `/chat/findMessages/${encodeURIComponent(instance)}`;
  const body = { where: sent, page, offset };

  let res;
  try {
    res = await fetchImpl(`${root}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: apiKey ?? '' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new EvolutionError(`POST ${route} failed: ${failureOf(err)}`, 0, null);
  }
  let text = '';
  let readError = null;
  try {
    if (typeof res.text === 'function') text = await res.text();
  } catch (err) {
    readError = err;
  }
  let json = null;
  let parsed = false;
  try {
    json = JSON.parse(text);
    parsed = true;
  } catch {
    json = text || null;
  }
  if (!res.ok) throw new EvolutionError(`POST ${route} -> HTTP ${res.status}`, res.status, json);
  // Nothing of what came back goes on these errors: it may be a page of someone's messages.
  if (readError) throw new EvolutionError(`POST ${route} failed: ${failureOf(readError)}`, res.status, null);
  if (!parsed) throw new EvolutionError(`POST ${route} -> HTTP ${res.status} but the answer is not JSON`, res.status, null);
  const records = recordsIn(json);
  if (!records) throw new EvolutionError(`POST ${route} -> HTTP ${res.status} but the answer holds no records`, res.status, null);
  return {
    records: records.map(normaliseRecord),
    raw: json,
    total: countOf(json?.messages?.total),
    pages: countOf(json?.messages?.pages),
  };
}

/**
 * One page of the messages sent or received in a time window, across every chat: the
 * poller's question, as `findMessagesPage` with the time filter filled in.
 *
 * The `messageTimestamp` filter only bites when both bounds are present, so both are
 * required here; `fromMe` is deliberately not sent, because the server ignores it.
 *
 * @param {{ baseUrl: string, apiKey: string, instance: string,
 *           gte: number|string|Date, lte: number|string|Date,
 *           page?: number, offset?: number,
 *           fetchImpl?: typeof globalThis.fetch, timeoutMs?: number }} o
 * @returns {Promise<{ records: NormalisedRecord[], raw: any, total: number|null, pages: number|null }>}
 */
export async function findMessagesWindow({ gte, lte, ...opts } = {}) {
  return findMessagesPage({ ...opts, where: { messageTimestamp: { gte: toIso(gte), lte: toIso(lte) } } });
}

/**
 * Every message in the window, paging while a page comes back full and stopping at
 * `MAX_PAGES`. Duplicate `key.id`s across pages (the window keeps moving under us) are
 * dropped.
 *
 * `truncated` is not a detail: records come back NEWEST first, so a window with more than
 * `maxPages × offset` messages in it yields the newest ones and the older ones are never
 * reachable — asking again returns the same newest page. The caller has to decide what
 * that means (the poller logs it and moves on: it happens only after downtime long enough
 * that the messages have been dealt with by hand anyway).
 *
 * @returns {Promise<{ records: NormalisedRecord[], pages: number, truncated: boolean }>}
 */
export async function fetchWindow({ maxPages = MAX_PAGES, offset = PAGE_SIZE, ...opts } = {}) {
  const records = [];
  const seen = new Set();
  let pages = 0;
  let truncated = false;
  for (let page = 1; page <= maxPages; page += 1) {
    const { records: batch, raw } = await findMessagesWindow({ ...opts, page, offset });
    pages = page;
    for (const rec of batch) {
      const key = rec.id ?? `${rec.jid}:${rec.ts}:${page}:${records.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push(rec);
    }
    if (recordsOf(raw).length < offset) break;
    if (page === maxPages) truncated = true;
  }
  return { records, pages, truncated };
}

/**
 * Every message in a time window across every chat, without silent loss (2026-09-27 design
 * §4.3; the full reasoning is decision P2-3 in the Phase 2 plan): each record at most once,
 * and what could not be read is counted in `missing` and flagged `truncated`, never dropped
 * quietly.
 *
 * Evolution answers newest first, orders by `messageTimestamp` alone and pages with
 * LIMIT/OFFSET, so the window is read in pieces:
 *   - A piece whose stated `total` is more than `maxPages × offset` is cut in two on a whole
 *     second — `[from, mid − 1 ms]` and `[mid, to]`, each keeping at least one second — and
 *     each half is read the same way, the older half first. Evolution compares whole seconds,
 *     so the halves neither overlap nor leave a second out.
 *   - A piece that fits is paged through, ids de-duplicated, reading on past its stated pages
 *     while it holds fewer rows than the largest `total` any page stated and the last page came
 *     back full (a late delivery pushed a record down a page). It is complete when its distinct
 *     ids reach that total, less the extra rows of an id repeated on ONE page (one page cannot
 *     return a row twice, so those are rows stored twice under one key.id, not a slide). A
 *     bare array states no total: the rows its pages held stand in for it.
 *   - A piece that comes back short (records slid between pages: same-second ties are not kept
 *     in one order across LIMIT/OFFSET values, and deliveries or deletions shift the pages) is
 *     cut and its halves re-read instead of being accepted. So is a bare-array piece stopped by
 *     the page cap with its last page full.
 * Only a piece that cannot be cut again — at `maxDepth`, or a single whole second — is kept
 * short: its shortfall goes into `missing` and `truncated` is set (a bare-array piece cut off
 * there is `truncated` and adds nothing to `missing`, since what lies past it cannot be
 * counted). The caller logs it and moves on: holding its cursor would re-read the same pages
 * for ever.
 *
 * Cost: at most `maxPages × (2^(maxDepth + 1) − 1)` requests — 155 with the defaults — and at
 * most `2^maxDepth` kept pieces (`pieces`).
 *
 * Known limits: page counts cannot see a record that leaves a piece cancelling one that
 * arrives (a slide then goes unreported; Evolution offers no snapshot read). `missing` is an
 * upper bound (a newcomer on a page already read, or a record that left mid-read, can count
 * one too many). A record with no id is kept and counted per copy. Two rows under one key.id
 * on different pages look like a slide and cost extra cuts; whether Evolution 2.3.7 stores
 * such rows at all is not verified (P2-3's open check).
 *
 * Within a piece the records keep Evolution's newest-first order (the poller sorts with
 * `oldestFirst`); the pieces come oldest first. A failed request throws as it is — nothing is
 * half-returned — so the caller keeps its cursor and asks again next time.
 *
 * @returns {Promise<{ records: NormalisedRecord[], pieces: number, truncated: boolean, missing: number }>}
 */
export async function readWindow({
  gte, lte, maxPages = MAX_PAGES, offset = PAGE_SIZE, maxDepth = MAX_SPLIT_DEPTH, ...opts
} = {}) {
  const gteMs = toMs(gte);
  const lteMs = toMs(lte);
  if (gteMs === null || lteMs === null) throw new TypeError('evolution: readWindow needs both gte and lte');
  // offset 0 would make every window "too big" and cut it to maxDepth for nothing.
  requireWhole('offset', offset, 1);
  requireWhole('maxPages', maxPages, 1);
  requireWhole('maxDepth', maxDepth, 0);
  const cap = maxPages * offset;
  const records = [];
  const seen = new Set();
  let pieces = 0;
  let truncated = false;
  let missing = 0;

  const readPage = (from, to, page) => findMessagesPage({
    ...opts, where: { messageTimestamp: { gte: toIso(from), lte: toIso(to) } }, page, offset,
  });

  /**
   * One piece paged through, `first` being its page 1. `kept` is what it returned, each id
   * once — counted in the piece alone, so a record some other piece returned still counts;
   * `size` is how many it says it holds: the largest `total` a page stated, or for a bare
   * array the rows its pages held; `storedTwice` counts, per id, the extra rows it had on the
   * one page that held the most of them; `cutOff` is a bare array stopped by the page cap with
   * its last page full.
   */
  async function readPiece(from, to, first) {
    const kept = [];
    const ids = new Set();
    // One LIMIT/OFFSET page cannot return one row twice: an id repeated on the same page is
    // that many rows stored under it, not a record that slid, so those rows are no shortfall.
    // Credited per id at the most it had on any ONE page, never summed over pages: the same
    // two rows can show up on two pages.
    const mostOnPage = new Map();
    let storedTwice = 0;
    const keep = (batch) => {
      const onPage = new Map();
      for (const rec of batch) {
        // A record with no id cannot be matched against anything, so it is kept as it is.
        if (rec.id) {
          const n = (onPage.get(rec.id) ?? 0) + 1;
          onPage.set(rec.id, n);
          // n climbs one at a time, so passing the id's best page is always by exactly one row.
          if (n > (mostOnPage.get(rec.id) ?? 1)) {
            mostOnPage.set(rec.id, n);
            storedTwice += 1;
          }
          if (ids.has(rec.id)) continue;
          ids.add(rec.id);
        }
        kept.push(rec);
      }
    };
    const boxed = first.total !== null;
    const stated = boxed ? Math.min(first.pages ?? Math.ceil(first.total / offset), maxPages) : maxPages;
    let total = first.total ?? 0;
    let rows = first.records.length;
    let last = rows;
    keep(first.records);
    for (let page = 2; page <= maxPages; page += 1) {
      const more = boxed ? page <= stated || (rows < total && last >= offset) : last >= offset;
      if (!more) break;
      const next = await readPage(from, to, page);
      keep(next.records);
      rows += next.records.length;
      last = next.records.length;
      total = Math.max(total, next.total ?? 0);
    }
    return { kept, size: boxed ? total : rows, storedTwice, cutOff: !boxed && last >= offset };
  }

  async function read(from, to, depth) {
    // Evolution compares whole seconds, so what can be cut is seconds, not milliseconds: a
    // piece that takes in two or more of them, however few ms wide ([x.999, x+1.000] is two).
    const lo = Math.floor(from / 1000);
    const hi = Math.floor(to / 1000);
    const canCut = hi > lo && depth < maxDepth;
    const cut = async () => {
      // The second the midpoint falls in, but never `from`'s own: each half keeps at least one
      // whole second (lo + 1 ≤ mid ≤ hi).
      const mid = Math.max(lo + 1, Math.floor((from + to) / 2000)) * 1000;
      await read(from, mid - 1, depth + 1);
      await read(mid, to, depth + 1);
    };
    const first = await readPage(from, to, 1);
    if (first.total !== null && first.total > cap && canCut) {
      await cut();
      return;
    }
    const piece = await readPiece(from, to, first);
    const short = Math.max(0, piece.size - piece.kept.length - piece.storedTwice);
    // A bare array stopped by the page cap has more past its last page: cut like a short piece.
    if ((short > 0 || piece.cutOff) && canCut) {
      await cut();
      return;
    }
    pieces += 1;
    for (const rec of piece.kept) {
      if (rec.id) {
        if (seen.has(rec.id)) continue;
        seen.add(rec.id);
      }
      records.push(rec);
    }
    if (short > 0 || piece.cutOff) truncated = true;
    missing += short;
  }

  await read(gteMs, lteMs, 0);
  return { records, pieces, truncated, missing };
}
