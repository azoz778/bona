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

/** Evolution never returns more than this many pages per window — a runaway is a bug. */
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
 * edit (protocol), a reaction (plain or encrypted), a poll vote, an edit that carries its new
 * text (Evolution rewrites the original record with it), an album header (the photos arrive
 * as records of their own), a pin, and "keep" in a disappearing chat.
 *
 * Dropping an edit here is only half of showing it: a stored copy of the original shows the
 * new text only if whoever stores it takes a changed text for an id it already holds when
 * the rewritten record is read again. Otherwise the pre-edit text stays.
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
 * of the `NOISE_KINDS` (by `messageType`, by a part of the message, or — for an edit — by
 * the wrapper `unwrapMessage` takes off), or a record that is only encryption/device
 * envelope. A record with no message body at all is NOT noise — it may be a client message
 * the phone could not decrypt, so it shows as `[message]` rather than vanishing (design
 * §4.3, no silent loss). Nor is an unknown kind: it too shows as `[message]`.
 */
export function isNoise(record) {
  if (NOISE_KINDS.has(record?.messageType)) return true;
  if (wrappedInEdit(record?.message)) return true;
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

/** The `where.key` fields Evolution matches on. */
const KEY_FILTERS = ['remoteJid', 'remoteJidAlt', 'id'];
const isIsoDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

/**
 * Whether Evolution would really narrow a read by `where`. It silently DROPS a key filter
 * whose value is falsy (`{ key: { remoteJid: null } }` reads every chat) and ignores a time
 * filter unless both bounds are given — and either slip would page through every chat on the
 * owner's personal WhatsApp, into whichever thread the caller files the answer under. So a
 * filter must name a chat or a message (`key.remoteJid`, `key.remoteJidAlt`, `key.id`) or a
 * whole window (`messageTimestamp` with ISO `gte` AND `lte`), and every one of those that is
 * present must be usable: a null jid beside a window is refused too, not read as the window.
 */
function narrowsRead(where) {
  if (!where || typeof where !== 'object' || Array.isArray(where)) return false;
  let applied = 0;
  if (where.key !== undefined) {
    const key = where.key;
    if (!key || typeof key !== 'object' || Array.isArray(key)) return false;
    const given = KEY_FILTERS.filter((field) => key[field] !== undefined);
    if (given.length === 0) return false;
    if (!given.every((field) => typeof key[field] === 'string' && key[field] !== '')) return false;
    applied += 1;
  }
  if (where.messageTimestamp !== undefined) {
    const window = where.messageTimestamp;
    if (!window || typeof window !== 'object' || !isIsoDate(window.gte) || !isIsoDate(window.lte)) return false;
    applied += 1;
  }
  return applied > 0;
}

/**
 * One page of the messages matching `where`, newest first.
 *
 * `where` goes to Evolution as given: `{ messageTimestamp: { gte, lte } }` (ISO strings —
 * both, or the filter is ignored) for a window across every chat, `{ key: { remoteJid } }`
 * or `{ key: { remoteJidAlt } }` for one chat, or a chat and a window together. A filter
 * Evolution would not apply — empty, a key with a null or empty jid, a one-sided window —
 * is refused with a TypeError before anything is sent (`narrowsRead`): it would page
 * through every chat on the owner's personal WhatsApp. `fromMe` is never worth sending —
 * the server ignores it.
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
  // Checked as it will be sent: JSON.stringify keeps only an object's own enumerable fields
  // and runs toJSON, so an inherited or hidden `remoteJid` would pass a check on the object
  // itself and still go out as `{"key":{}}` — every chat. What was checked is what is sent.
  let sent = null;
  try { sent = JSON.parse(JSON.stringify(where ?? null)); } catch { sent = null; }
  // The filter itself is never put in the message: it carries phone numbers.
  if (!narrowsRead(sent)) {
    throw new TypeError('evolution: where must name a chat (key.remoteJid, key.remoteJidAlt, key.id) or a whole window (messageTimestamp gte and lte)');
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
 * Every message in a time window across every chat, without silent loss (2026-09-27
 * design §4.3).
 *
 * Records come back NEWEST first and one read stops at `maxPages`, so paging alone cannot
 * reach the older messages of a window that holds more than `maxPages × offset` — asking
 * again returns the same newest pages. The boxed answer says how many the window holds
 * (`total`), so a window that is too big is cut in two on a whole second and each half is
 * read the same way, the older half first, down to `maxDepth` levels. Evolution compares
 * whole seconds, so the halves `[gte, mid - 1 ms]` and `[mid, lte]` neither overlap nor
 * leave a second out.
 *
 * A message that lands inside a piece while it is being paged pushes that piece's older
 * records one place down: the next page may repeat a record, and the oldest slides past the
 * last page the first answer stated. The newcomer need not be the newest thing in the
 * window — WhatsApp keeps the sender's timestamp, so what a phone delivers on reconnecting
 * lands wherever its time puts it, often mid-piece. So ids are de-duplicated, a piece counts
 * the records it KEPT — not the rows its pages held — and it reads on past the stated pages
 * while that count is short of the largest `total` any of its pages stated and the pages
 * still come back full.
 *
 * A piece is complete only when it kept as many records as the largest `total` any of its
 * pages stated. Anything short of that is `truncated`, and the shortfall is added to
 * `missing`: a piece that is still too big when it cannot be cut again — at `maxDepth`, or
 * under two seconds wide (narrower windows are never cut) — and is read partially, its newest
 * `maxPages` pages; a piece the page cap stops while it reads on for a late delivery; and a
 * newcomer that landed on a page already read, which this read never sees. That last one is
 * not left to the caller's next window: the poller reaches back only a couple of minutes, and
 * a window needs more than one page only when it catches up after downtime, when most of it
 * is older than that. The caller logs `missing` and moves on; holding its cursor there would
 * re-read the same newest pages for ever. A record that leaves the window mid-read can make
 * the count one too high — a warning too many, never a loss unreported. (A record with no id
 * is kept each time it comes back and so can hide one; Evolution gives every record an id.)
 *
 * A bare-array answer states no size. That piece falls back to paging until a short page,
 * exactly like `fetchWindow`; a cut-off there is `truncated`, and adds nothing to `missing`
 * because nobody can count it.
 *
 * Within a piece the records keep Evolution's newest-first order (the poller sorts with
 * `oldestFirst`); the pieces come oldest first. A failed request throws as it is — nothing
 * is half-returned — so the caller keeps its cursor and asks again next time.
 *
 * @returns {Promise<{ records: NormalisedRecord[], pieces: number, truncated: boolean, missing: number }>}
 */
export async function readWindow({
  gte, lte, maxPages = MAX_PAGES, offset = PAGE_SIZE, maxDepth = MAX_SPLIT_DEPTH, ...opts
} = {}) {
  const gteMs = toMs(gte);
  const lteMs = toMs(lte);
  if (gteMs === null || lteMs === null) throw new TypeError('readWindow needs both gte and lte');
  // offset 0 would make every window "too big" and cut it to maxDepth for nothing (and the
  // server would quietly page by 50 instead).
  if (!Number.isInteger(offset) || offset < 1) throw new TypeError('readWindow: offset must be a whole number of at least 1');
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new TypeError('readWindow: maxPages must be a whole number of at least 1');
  if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new TypeError('readWindow: maxDepth must be a whole number of at least 0');
  const records = [];
  const seen = new Set();
  let pieces = 0;
  let truncated = false;
  let missing = 0;

  /** Adds the records not kept yet, in order; returns how many that was. */
  const keep = (batch) => {
    let added = 0;
    for (const rec of batch) {
      // A record with no id cannot be matched against anything, so it is kept as it is.
      if (rec.id) {
        if (seen.has(rec.id)) continue;
        seen.add(rec.id);
      }
      records.push(rec);
      added += 1;
    }
    return added;
  };
  const readPage = (from, to, page) => findMessagesPage({
    ...opts, where: { messageTimestamp: { gte: toIso(from), lte: toIso(to) } }, page, offset,
  });

  async function read(from, to, depth) {
    const first = await readPage(from, to, 1);
    if (first.total === null) {
      pieces += 1;
      keep(first.records);
      let last = first.records.length;
      for (let page = 2; page <= maxPages && last >= offset; page += 1) {
        const next = await readPage(from, to, page);
        keep(next.records);
        last = next.records.length;
      }
      if (last >= offset) truncated = true;
      return;
    }
    const cap = maxPages * offset;
    if (first.total > cap && to - from >= 2000 && depth < maxDepth) {
      const mid = Math.floor((from + to) / 2000) * 1000;
      await read(from, mid - 1, depth + 1);
      await read(mid, to, depth + 1);
      return;
    }
    pieces += 1;
    // Kept, not rows on the pages: a repeat that a late arrival pushed down must not stand
    // in for the record it pushed past the last stated page.
    let kept = keep(first.records);
    let last = first.records.length;
    // The largest total any page of this piece has stated. A late delivery raises it, and
    // judged against the first answer's total alone, a piece whose later page held the
    // newcomer and no repeat would look complete with its oldest record still unread.
    let seenTotal = first.total;
    const readingOn = () => kept < seenTotal && last >= offset;
    const stated = Math.min(first.pages ?? Math.ceil(first.total / offset), maxPages);
    for (let page = 2; page <= maxPages && (page <= stated || readingOn()); page += 1) {
      const next = await readPage(from, to, page);
      kept += keep(next.records);
      last = next.records.length;
      seenTotal = Math.max(seenTotal, next.total ?? 0);
    }
    // Over the cap at the deepest level, short when the page cap came first, stopped by the
    // page cap while still reading on, or a newcomer on a page already read: all of them
    // leave the piece short of the largest total it was told. (Reading on implies short.)
    const unread = Math.max(0, seenTotal - kept);
    if (unread > 0) {
      truncated = true;
      missing += unread;
    }
  }

  await read(gteMs, lteMs, 0);
  return { records, pieces, truncated, missing };
}
