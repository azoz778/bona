// Evolution API v2 client — READ-ONLY except sendText.
//
// Shapes verified against the live instance `abdulaziz-personal` on 2026-09-05:
//   GET  /group/fetchAllGroups/{instance}?getParticipants=false
//        -> 200, a FLAT ARRAY of { id, subject, subjectOwner, subjectTime, pictureUrl,
//           size, creation, owner, restrict, announce, isCommunity, isCommunityAnnounce }
//   POST /chat/findMessages/{instance}  { where: { key: { remoteJid } }, page, offset }
//        -> 200 { messages: { total, pages, currentPage, records: [ {
//              id, key: { id, fromMe, remoteJid, participant? }, pushName, messageType,
//              message: { <type>: {...}, messageContextInfo }, messageTimestamp,
//              instanceId, source, contextInfo, MessageUpdate } ] } }
//           `offset` is the PAGE SIZE (`limit` is ignored); records are newest-first.
//   POST /chat/getBase64FromMediaMessage/{instance} { message: { key }, convertToMp4: false }
//        -> 201 { mediaType, fileName, size: { fileLength: {low,high,unsigned} }, mimetype,
//                 base64: "<b64>", buffer: null }
//   POST /message/sendText/{instance} { number, text, delay?, linkPreview? }
//
// NEVER call any /webhook/, /websocket/ or /rabbitmq/ route on this instance: another
// agent (Lisa) consumes its events and setting a webhook would steal them.
import { log } from './log.mjs';

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class EvolutionError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'EvolutionError';
    this.status = status;
    this.body = body;
  }
}

export function createEvolutionClient({ baseUrl, apiKey, instance, fetchImpl = fetch, retries = 3, timeoutMs = 120000 }) {
  if (!baseUrl) throw new Error('evolution: baseUrl required');
  const root = String(baseUrl).replace(/\/+$/, '');

  async function request(method, route, body) {
    let lastErr;
    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        const res = await fetchImpl(`${root}${route}`, {
          method,
          headers: { apikey: apiKey, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        let json;
        try { json = text ? JSON.parse(text) : null; } catch { json = text; }
        if (res.ok) return json; // Evolution answers 200 for reads and 201 for media/send
        if (!RETRYABLE.has(res.status) || attempt === retries - 1) {
          throw new EvolutionError(`${method} ${route} -> HTTP ${res.status}`, res.status, json);
        }
        lastErr = new EvolutionError(`${method} ${route} -> HTTP ${res.status}`, res.status, json);
      } catch (err) {
        if (err instanceof EvolutionError && !RETRYABLE.has(err.status)) throw err;
        lastErr = err;
        if (attempt === retries - 1) break;
      }
      await sleep(1000 * 2 ** attempt);
    }
    throw lastErr;
  }

  return {
    request,

    /** @returns {Promise<Array<{id:string,subject:string,size:number}>>} */
    async fetchAllGroups() {
      const json = await request('GET', `/group/fetchAllGroups/${instance}?getParticipants=false`);
      const arr = Array.isArray(json) ? json : json?.groups || [];
      return arr
        .filter((g) => g && typeof g.id === 'string')
        .map((g) => ({ id: g.id, subject: String(g.subject ?? ''), size: g.size ?? null }));
    },

    /**
     * Newest-first message records for one chat.
     * @returns {Promise<{total:number,pages:number,records:Array<object>}>}
     */
    async findMessages(remoteJid, { pageSize = 30, page = 1 } = {}) {
      const json = await request('POST', `/chat/findMessages/${instance}`, {
        where: { key: { remoteJid } },
        page,
        offset: pageSize,
      });
      const box = json?.messages ?? json ?? {};
      const records = Array.isArray(box) ? box : box.records || [];
      return { total: box.total ?? records.length, pages: box.pages ?? 1, records };
    },

    /** @returns {Promise<{fileName:string,mimetype:string,buffer:Buffer,mediaType:string}>} */
    async downloadMedia(messageKey) {
      const json = await request('POST', `/chat/getBase64FromMediaMessage/${instance}`, {
        message: { key: messageKey },
        convertToMp4: false,
      });
      if (!json?.base64) throw new EvolutionError('getBase64FromMediaMessage returned no base64', 200, null);
      return {
        fileName: json.fileName ?? null,
        mimetype: json.mimetype ?? null,
        mediaType: json.mediaType ?? null,
        buffer: Buffer.from(json.base64, 'base64'),
      };
    },

    /** The ONLY write. `number` may be a group jid. */
    async sendText(number, text, { linkPreview = false, delay = 0 } = {}) {
      log.info('wa.send', { to: number, chars: text.length });
      return request('POST', `/message/sendText/${instance}`, { number, text, linkPreview, delay });
    },

    async connectionState() {
      return request('GET', `/instance/connectionState/${instance}`);
    },
  };
}

/** documentMessage | documentWithCaptionMessage -> the inner documentMessage, else null. */
export function documentOf(record) {
  const m = record?.message;
  if (!m) return null;
  return m.documentMessage || m.documentWithCaptionMessage?.message?.documentMessage || null;
}

/** Caption / body text of any record shape we care about. */
export function textOf(record) {
  const m = record?.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    m.documentMessage?.caption ||
    m.imageMessage?.caption ||
    ''
  );
}

/** Baileys longs arrive as { low, high, unsigned }. */
export function fileLengthOf(doc) {
  const v = doc?.fileLength;
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v) || null;
  if (typeof v === 'object' && typeof v.low === 'number') return v.high ? v.high * 2 ** 32 + v.low : v.low;
  return null;
}

/**
 * Owner-only gate. Anything the owner did not author is ignored outright — this service
 * publishes to a public website, so a group member must never be able to drive it.
 */
export function isFromOwner(record, ownerJid) {
  if (record?.key?.fromMe === true) return true;
  const bare = (jid) => String(jid || '').split(':')[0].split('@')[0];
  const participant = record?.key?.participant || record?.participant;
  return Boolean(participant) && bare(participant) === bare(ownerJid);
}
