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
  constructor(message, status, body) {
    super(message);
    this.name = 'EvolutionError';
    this.status = status;
    this.body = body;
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
  if (ms === null) throw new TypeError('findMessagesWindow needs both gte and lte');
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
  const inner = m.ephemeralMessage?.message
    ?? m.viewOnceMessage?.message
    ?? m.viewOnceMessageV2?.message
    ?? m.viewOnceMessageV2Extension?.message
    ?? m.documentWithCaptionMessage?.message
    ?? m.editedMessage?.message
    ?? null;
  return inner ? unwrapMessage(inner, depth + 1) : m;
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
 * Control characters and the bidi overrides, isolates and marks. A file name is chosen by
 * whoever sent the file: a right-to-left override can make `fdp.exe` read as `exe.pdf`,
 * and escaping for HTML does nothing about that, so they go before the name is shown.
 */
const CONTROL_OR_BIDI_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** Longest document name kept, in code points (an emoji is one, not two). */
const MAX_FILE_NAME = 120;

/** A sender-chosen file name made safe to show: `''` when nothing usable is left. */
function cleanFileName(name) {
  if (typeof name !== 'string') return '';
  // Whitespace first, so a tab or a line break between two words leaves a space, not a join.
  const flat = name.replace(/\s+/g, ' ').replace(CONTROL_OR_BIDI_RE, '').replace(/\s+/g, ' ').trim();
  return Array.from(flat).slice(0, MAX_FILE_NAME).join('').trim();
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

/** Record kinds that change or decorate another message instead of being one. */
const NOISE_KINDS = new Set(['protocolMessage', 'reactionMessage', 'pollUpdateMessage']);
/** Parts that ride along with a message and never carry anything a person wrote. */
const ENVELOPE_KEYS = new Set(['messageContextInfo', 'senderKeyDistributionMessage']);

/**
 * True for a record that is not a message of its own and must never become a bubble:
 * a reaction, a protocol message (a delete, an edit), a poll vote, or a record that is
 * only encryption/device envelope. A record with no message body at all is NOT noise —
 * it may be a client message the phone could not decrypt, so it shows as `[message]`
 * rather than vanishing (design §4.3, no silent loss).
 */
export function isNoise(record) {
  if (NOISE_KINDS.has(record?.messageType)) return true;
  const m = unwrapMessage(record?.message);
  if (!m || typeof m !== 'object') return false;
  const keys = Object.keys(m);
  if (keys.some((k) => NOISE_KINDS.has(k))) return true;
  return keys.length > 0 && keys.every((k) => ENVELOPE_KEYS.has(k));
}

/**
 * One Evolution record, flattened to what the poller and the inbox reason about.
 * `media` is `mediaOf`'s placeholder, `fileName` a document's cleaned name (null for
 * anything else), `noise` is `isNoise`.
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

/** Both shapes 2.3.7 answers with: `{ messages: { records: [...] } }` and a bare array. */
export function recordsOf(payload) {
  const box = payload?.messages ?? payload ?? {};
  if (Array.isArray(box)) return box;
  if (Array.isArray(box.records)) return box.records;
  return [];
}

/** A size Evolution states about the whole filtered set, or null when it did not state one. */
const countOf = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

/**
 * One page of the messages matching `where`, newest first.
 *
 * `where` goes to Evolution as given: `{ messageTimestamp: { gte, lte } }` (ISO strings —
 * both, or the filter is ignored) for a window across every chat, `{ key: { remoteJid } }`
 * or `{ key: { remoteJidAlt } }` for one chat, or a chat and a window together. An empty
 * filter is refused: it would page through every chat on the owner's personal WhatsApp.
 * `fromMe` is never worth sending — the server ignores it.
 *
 * `total` and `pages` describe everything the filter matched, not this page, when the
 * answer is boxed; both are null for a bare array, and the caller then cannot tell a
 * complete read from a cut-off one.
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
  if (!where || typeof where !== 'object' || Array.isArray(where) || Object.keys(where).length === 0) {
    throw new TypeError('evolution: a where filter is required');
  }
  const root = String(baseUrl).replace(/\/+$/, '');
  const route = `/chat/findMessages/${encodeURIComponent(instance)}`;
  const body = { where, page, offset };

  let res;
  try {
    res = await fetchImpl(`${root}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: apiKey ?? '' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new EvolutionError(`POST ${route} failed: ${err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network'}`, 0, null);
  }
  const text = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) throw new EvolutionError(`POST ${route} -> HTTP ${res.status}`, res.status, json);
  return {
    records: recordsOf(json).map(normaliseRecord),
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
 * A message that arrives while a piece is being paged pushes that piece's older records one
 * place down: the next page repeats a record, and the oldest slides past the last page the
 * first answer stated. So ids are de-duplicated, a piece measures the records it KEPT — not
 * the rows its pages held — against the `total` its first answer stated, and it reads on
 * past the stated pages while that count is short and the pages still come back full. The
 * newcomer is stamped about now, the newest thing in the window, so the caller's next
 * window reaches it.
 *
 * Only a piece that is still too big when it cannot be cut again — at `maxDepth`, or under
 * two seconds wide with no whole second left to cut at — is read partially: its newest
 * `maxPages` pages, `truncated` set, and `missing` saying how many were left unread. A piece
 * whose kept count is still short when the page cap comes first is reported the same way.
 * The caller logs that and moves on; holding its cursor there would re-read the same newest
 * pages for ever.
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
    const stated = Math.min(first.pages ?? Math.ceil(first.total / offset), maxPages);
    for (let page = 2; page <= maxPages && (page <= stated || (kept < first.total && last >= offset)); page += 1) {
      const next = await readPage(from, to, page);
      kept += keep(next.records);
      last = next.records.length;
    }
    // Over the cap at the deepest level, or short when the page cap came first.
    if (kept < first.total) {
      truncated = true;
      missing += first.total - kept;
    }
  }

  await read(gteMs, lteMs, 0);
  return { records, pieces, truncated, missing };
}
