/**
 * Per-chat reads from Evolution for the Bona inbox (2026-09-27 design §4.1, §4.3; P2-2).
 *
 * The poller reads every chat in one time window. This reads ONE chat, at two moments:
 *
 *   - `history`: a chat has just joined the inbox, so store what led up to the joining
 *     message — the preceding 24 h for an automatic join (the "Hi" before the Ref code, the
 *     owner's opening line), 30 days when the owner vouched for the chat himself.
 *   - `refresh`: someone opens a thread or is about to reply, so fetch its newest messages
 *     first — the page, and the stale-view check before a send, must not be one poll behind.
 *     Never from further back than the chat's history floor, 24 h before it joined
 *     (amendment A1): an automatic join only ever brings that much of a chat's past, and
 *     without the floor, opening the thread would store months of the owner's earlier
 *     private conversation. And cheap (A2): about 3 s at most, whatever Evolution is
 *     doing, and the same chat is not read again within 5 s.
 *
 * Evolution files one WhatsApp chat under two jids (verified live 2026-09-28): what the
 * client sends and what the owner types on his phone sit under the chat's privacy-mode
 * `@lid`, with the client's phone jid alongside as `key.remoteJidAlt`; what the API sends to
 * a phone number sits under the phone jid itself. So one chat is three questions —
 * `remoteJidAlt` = phone jid, `remoteJid` = phone jid, `remoteJid` = lid — de-duplicated by
 * message id. The lid question is asked last, from a fresh read of the lead: the first two
 * can teach a lead its lid.
 *
 * Read-only, like lib/evolution.mjs: it only ever asks `POST /chat/findMessages`. What is
 * stored is decided by lib/inbox/ingest.mjs, record by record. A read that fails never
 * throws — the chat stays as it was, and the poller or the next refresh brings the messages
 * in. Nothing here logs a phone number, a lid or text.
 */
import { EvolutionError, PAGE_SIZE, findMessagesPage, oldestFirst } from '../evolution.mjs';
import { waConfig } from '../wa.mjs';
import { RETENTION_MS } from './store.mjs';

/** An automatic join stores this much of the chat before the joining message. */
export const JOIN_HISTORY_MS = 24 * 3_600_000;
/** An owner-button join (Move to Bona inbox, Add chat by phone number) stores this much. */
export const OWNER_HISTORY_MS = 30 * 86_400_000;
/** Pages per question on a history read: 10 × 100 records is more than any real chat window. */
export const BACKFILL_MAX_PAGES = 10;
/** How many of the newest records a refresh asks for, per question. */
export const REFRESH_LIMIT = 50;

/** No single refresh question waits longer than this, whatever is left of the budget (A2). */
const REFRESH_REQUEST_MS = 2_500;
/** How many chats' last refresh times are kept; past that, the stalest is forgotten (A2). */
const REFRESH_MEMORY = 1_000;
const iso = (ms) => new Date(ms).toISOString();

const PHONE_JID_RE = /^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/;
/** International digits: 8–15 of them, never the local trunk `0` first (see wa-send.mjs). */
const PHONE_RE = /^[1-9]\d{7,14}$/;
const isLid = (jid) => typeof jid === 'string' && jid.endsWith('@lid');
/** A group or a broadcast is never a client's chat, whatever alt it happens to carry. */
const isGroupOrBroadcast = (jid) => typeof jid === 'string' && (jid.endsWith('@g.us') || jid.endsWith('@broadcast'));

/**
 * The lead's phone-number jid: its stored `@s.whatsapp.net` jid with any device suffix
 * stripped, else one built from `phone_e164`. Null for a chat known only by its lid —
 * a lid's digits are an opaque id, never a phone number.
 * @returns {string|null}
 */
export function phoneJidOf(lead) {
  const m = PHONE_JID_RE.exec(String(lead?.wa_jid ?? ''));
  if (m && !m[1].startsWith('0')) return `${m[1]}@s.whatsapp.net`;
  const phone = String(lead?.phone_e164 ?? '');
  return PHONE_RE.test(phone) ? `${phone}@s.whatsapp.net` : null;
}

/** What a failed read says about itself: a status or a kind of failure, never an error message — one could carry a jid. */
function errorCode(err) {
  if (err instanceof EvolutionError) {
    if (err.status) return `http_${err.status}`;
    return /timeout/.test(String(err.message)) ? 'timeout' : 'network';
  }
  return 'failed';
}

/**
 * @param {object} o
 * @param {object} [o.env]          for `waConfig`: Evolution URL, key and instance
 * @param {ReturnType<import('../db.mjs').openDb>} o.db
 * @param {(lead: object, rec: object) => any} o.ingest  lib/inbox/ingest.mjs `createIngest().ingest`
 * @param {(q: { where: object, page: number, offset: number, timeoutMs?: number }) => Promise<{ records: object[], total: number|null, pages: number|null }>} [o.find]
 *        injected in tests; defaults to `findMessagesPage` against the instance in `env`.
 *        A refresh adds `timeoutMs`, its per-question share of the budget.
 * @param {typeof globalThis.fetch} [o.fetchImpl]
 * @param {(e: object) => void} [o.log]
 * @param {() => number} [o.now]
 * @param {number} [o.timeoutMs]  a history question's timeout
 */
export function createBackfill({
  env = {}, db, ingest, find = null, fetchImpl = globalThis.fetch, log = () => {}, now = () => Date.now(), timeoutMs = 8000,
} = {}) {
  if (!db) throw new TypeError('createBackfill needs the store');
  if (typeof ingest !== 'function') throw new TypeError('createBackfill needs the ingest function');
  const wa = waConfig(env);
  const configured = Boolean(find) || Boolean(wa.baseUrl && wa.apiKey);
  const read = find ?? (({ where, page, offset, timeoutMs: requestMs = timeoutMs }) => findMessagesPage({
    baseUrl: wa.baseUrl, apiKey: wa.apiKey, instance: wa.instance, where, page, offset, fetchImpl, timeoutMs: requestMs,
  }));
  const skipped = (reason) => ({ stored: 0, scanned: 0, truncated: false, skipped: reason });
  /** lead_id → when it was last refreshed. A Map keeps insertion order, so the first key is the stalest. */
  const refreshedAt = new Map();

  function failed(leadId, error, name = null) {
    log({ level: 'warn', evt: 'inbox.backfill.failed', leadId, error, ...(name ? { name } : {}) });
    return { error };
  }

  /** The lead as it is now, or why a per-chat read has no business with it. */
  function inboxLead(leadId) {
    const lead = leadId ? db.getLead(leadId) : null;
    if (!lead) return { skip: skipped('not_found') };
    // Ingest would refuse every record of a chat that is not in the inbox anyway, and a
    // chat the inbox has no business with should not even be fetched.
    if (lead.inbox_state !== 'in') return { skip: skipped('not_in_inbox') };
    return { lead };
  }

  /**
   * The three questions for one chat, each paged newest-first inside `time` (the
   * `messageTimestamp` window every question carries). With a `deadline` (a refresh), each
   * question waits at most what is left of it, and none starts once it has passed: the
   * tally then says `partial`.
   */
  async function readChat(lead, { time, offset, maxPages, noteTruncation, deadline = null }) {
    const leadId = lead.lead_id;
    const seen = new Set();
    const tally = { stored: 0, scanned: 0, truncated: false };

    async function ask(clause, key) {
      const where = { key, messageTimestamp: time };
      const batch = [];
      for (let page = 1; page <= maxPages; page += 1) {
        let query = { where, page, offset };
        if (deadline !== null) {
          const left = deadline - now();
          if (left <= 0) {
            tally.partial = true;
            break;
          }
          query = { ...query, timeoutMs: Math.min(left, REFRESH_REQUEST_MS) };
        }
        const answer = await read(query);
        const records = Array.isArray(answer) ? answer : (Array.isArray(answer?.records) ? answer.records : []);
        tally.scanned += records.length;
        for (const rec of records) {
          if (!rec?.id || seen.has(rec.id) || isGroupOrBroadcast(rec.jid)) continue;
          seen.add(rec.id);
          batch.push(rec);
        }
        // Evolution says how many pages the question has; an answer that does not is read
        // until a short page, the way lib/evolution.mjs `fetchWindow` always has.
        const pages = Number.isFinite(answer?.pages) ? answer.pages : null;
        const more = pages === null ? records.length >= offset : page < pages;
        if (!more) break;
        if (page === maxPages) {
          tally.truncated = true;
          if (noteTruncation) {
            log({
              level: 'warn', evt: 'inbox.backfill.truncated', leadId, clause, pages,
              total: Number.isFinite(answer?.total) ? answer.total : null, maxPages,
            });
          }
        }
      }
      // Oldest first, the order they happened in — like the poller.
      for (const rec of oldestFirst(batch)) {
        const out = await ingest(db.getLead(leadId), rec);
        if (out?.stored && out.inserted) tally.stored += 1;
      }
    }

    const phoneJid = phoneJidOf(lead);
    if (phoneJid) {
      await ask('phone_alt', { remoteJidAlt: phoneJid });
      await ask('phone', { remoteJid: phoneJid });
    }
    // Read again: the two questions above may have taught this lead its lid.
    const lid = db.getLead(leadId)?.wa_lid ?? null;
    if (isLid(lid)) await ask('lid', { remoteJid: lid });
    return tally;
  }

  /**
   * Store a chat's messages between `sinceTs` and `untilTs` (ms).
   * @returns {Promise<{ stored: number, scanned: number, truncated: boolean, skipped?: string } | { error: string }>}
   */
  async function history(lead, { sinceTs, untilTs = now(), maxPages = BACKFILL_MAX_PAGES } = {}) {
    if (!configured) return skipped('not_configured');
    const leadId = lead?.lead_id ?? null;
    if (!Number.isFinite(sinceTs) || !Number.isFinite(untilTs)) return failed(leadId, 'bad_window');
    try {
      const { lead: current, skip } = inboxLead(leadId);
      if (skip) return skip;
      const cap = Math.max(1, Math.trunc(Number(maxPages)) || BACKFILL_MAX_PAGES);
      return await readChat(current, {
        time: { gte: iso(sinceTs), lte: iso(untilTs) }, offset: PAGE_SIZE, maxPages: cap, noteTruncation: true,
      });
    } catch (err) {
      return failed(leadId, errorCode(err), err?.name ?? null);
    }
  }

  /**
   * Store a chat's newest `REFRESH_LIMIT` records per question, from its history floor to
   * now (A1). The floor is 24 h before the chat joined — an owner-button join already stored
   * its 30 days when it joined, so a refresh never needs to reach further — and never past
   * the retention horizon, or a refresh would store again what the daily purge removed.
   * Reading only the newest page is the point, so a longer chat is not "truncated" news.
   *
   * Bounded (A2): the thread page and the reply right after it both ask, so the same chat
   * is not read again within `minIntervalMs`; and the read keeps to `budgetMs`, each question
   * waiting at most 2.5 s or what is left. The time is noted before the read, so a failing
   * Evolution is not asked again on every click either. Never throws.
   * @returns {Promise<{ stored: number, scanned: number, truncated: boolean, partial?: true, skipped?: string }
   *          | { skipped: 'recent' } | { error: string }>}
   */
  async function refresh(lead, { budgetMs = 3000, minIntervalMs = 5000 } = {}) {
    if (!configured) return skipped('not_configured');
    const leadId = lead?.lead_id ?? null;
    try {
      const { lead: current, skip } = inboxLead(leadId);
      if (skip) return skip;
      const t = now();
      const last = refreshedAt.get(leadId);
      if (last !== undefined && t - last < minIntervalMs) return { skipped: 'recent' };
      refreshedAt.delete(leadId); // re-added at the end: the most recently refreshed
      refreshedAt.set(leadId, t);
      if (refreshedAt.size > REFRESH_MEMORY) refreshedAt.delete(refreshedAt.keys().next().value);
      const floor = Math.max((current.inbox_since ?? t) - JOIN_HISTORY_MS, t - RETENTION_MS);
      const out = await readChat(current, {
        time: { gte: iso(floor), lte: iso(t) }, offset: REFRESH_LIMIT, maxPages: 1, noteTruncation: false, deadline: t + budgetMs,
      });
      if (out.partial) log({ level: 'warn', evt: 'inbox.refresh.partial', leadId, budgetMs });
      return out;
    } catch (err) {
      return failed(leadId, errorCode(err), err?.name ?? null);
    }
  }

  return { configured, phoneJidOf, history, refresh };
}
