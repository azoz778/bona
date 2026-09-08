/**
 * Evolution API 2.3.7 (Baileys) — the READ half, for the WhatsApp poller.
 *
 * IMPORTANT: the instance this talks to (`abdulaziz-personal`) is the owner's
 * *personal* WhatsApp and is already consumed by another agent. This module only ever
 * calls `POST /chat/findMessages/{instance}`. It never sets a webhook, a websocket or
 * a rabbitmq consumer — doing so would steal the other agent's events — and it never
 * sends: the one outbound message the API service writes goes through `lib/wa.mjs`.
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
 *   - the `messageTimestamp` filter applies only when BOTH `gte` and `lte` are given.
 *   - the response is either `{ messages: { records: [...] } }` or a bare array.
 *   - `extendedTextMessage.text` is sometimes flattened into `message.conversation`.
 *   - an ad-origin / privacy-mode chat arrives as `…@lid` with a null `pushName`; the
 *     real phone jid is then on `key.remoteJidAlt`.
 */

/** Evolution never returns more than this many pages per window — a runaway is a bug. */
export const MAX_PAGES = 5;
/** `offset` in the request body: how many records one page holds. */
export const PAGE_SIZE = 100;

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
    ? [m.extendedTextMessage, m.imageMessage, m.videoMessage, m.documentMessage, m.conversationContextInfo]
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
 * One Evolution record, flattened to what the poller reasons about.
 * @typedef {{ id: string|null, jid: string|null, jidAlt: string|null, fromMe: boolean,
 *             ts: number|null, text: string, pushName: string|null,
 *             contextInfo: object|null, messageType: string|null }} NormalisedRecord
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
  };
}

/**
 * Oldest first, by timestamp. Evolution answers newest-first, and a caller that acts on
 * the records in that order sees the effect before the cause: a follow-up before the
 * message that creates the lead, a reply before the enquiry it answers. Records with no
 * usable timestamp keep their relative API order, reversed.
 */
export function oldestFirst(records) {
  return (records || [])
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (Number.isFinite(a.r?.ts) && Number.isFinite(b.r?.ts) && a.r.ts !== b.r.ts ? a.r.ts - b.r.ts : b.i - a.i))
    .map((x) => x.r);
}

/** Both shapes 2.3.7 answers with: `{ messages: { records: [...] } }` and a bare array. */
export function recordsOf(payload) {
  const box = payload?.messages ?? payload ?? {};
  if (Array.isArray(box)) return box;
  if (Array.isArray(box.records)) return box.records;
  return [];
}

/**
 * One page of the messages sent or received in a time window, across every chat.
 *
 * The `messageTimestamp` filter only bites when both bounds are present, so both are
 * required here; `fromMe` is deliberately not sent, because the server ignores it.
 *
 * @param {{ baseUrl: string, apiKey: string, instance: string,
 *           gte: number|string|Date, lte: number|string|Date,
 *           page?: number, offset?: number,
 *           fetchImpl?: typeof globalThis.fetch, timeoutMs?: number }} o
 * @returns {Promise<{ records: NormalisedRecord[], raw: any }>}
 */
export async function findMessagesWindow({
  baseUrl, apiKey, instance, gte, lte, page = 1, offset = PAGE_SIZE,
  fetchImpl = globalThis.fetch, timeoutMs = 10_000,
} = {}) {
  if (!baseUrl) throw new TypeError('evolution: baseUrl required');
  if (!instance) throw new TypeError('evolution: instance required');
  const root = String(baseUrl).replace(/\/+$/, '');
  const route = `/chat/findMessages/${encodeURIComponent(instance)}`;
  const body = { where: { messageTimestamp: { gte: toIso(gte), lte: toIso(lte) } }, page, offset };

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
  return { records: recordsOf(json).map(normaliseRecord), raw: json };
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
