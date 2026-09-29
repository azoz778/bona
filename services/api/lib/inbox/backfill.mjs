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
 *     Never from further back than the chat's history floor (`leads.history_from`, set when
 *     it joined: 24 h before an automatic join, 30 days before an owner-button join;
 *     amendment A1): without the floor, opening the thread would store months of the
 *     owner's earlier private conversation. lib/inbox/ingest.mjs refuses anything older
 *     than the floor, whatever read brings it. And cheap (A2): about 3 s at most, whatever Evolution is
 *     doing, and the same chat is not read again within 5 s.
 *
 * Evolution files one WhatsApp chat under two jids (verified live 2026-09-28): what the
 * client sends and what the owner types on his phone sit under the chat's privacy-mode
 * `@lid`, with the client's phone jid alongside as `key.remoteJidAlt`; what the API sends to
 * a phone number sits under the phone jid itself. So one chat is three questions —
 * `remoteJidAlt` = phone jid, `remoteJid` = phone jid, `remoteJid` = lid — de-duplicated by
 * message id. The lid question is asked last, from a fresh read of the lead: the first two
 * can teach a lead its lid. What the two phone questions bring is stored together, oldest
 * first, before the lid question is asked; what only the lid question brings follows it.
 *
 * Only a record that answers the question asked is kept (amendment A9). Evolution applies
 * the key filter today, but a server that stops applying it — an upgrade that renames
 * `remoteJidAlt`, a proxy or a cache — would otherwise file every private chat on the
 * owner's personal WhatsApp inside the window under this one client's thread, for the whole
 * team to read for five years. Such records are counted and logged, never stored. The same
 * holds for the time window every question carries (A10): a record is kept only when its
 * time is inside it, so A1's floor never rests on Evolution's `messageTimestamp` filter
 * (2.3.7 already skips it unless both bounds are sent). A record with no time is outside
 * every window.
 *
 * Read-only, like lib/evolution.mjs: it only ever asks `POST /chat/findMessages`. What is
 * stored is decided by lib/inbox/ingest.mjs, record by record. A read that fails never
 * throws — the chat stays as it was, and the poller or the next refresh brings the messages
 * in. Nothing here logs a phone number, a lid or text.
 */
import { EvolutionError, PAGE_SIZE, findMessagesPage, oldestFirst } from '../evolution.mjs';
import { waConfig } from '../wa.mjs';
import { loggableName } from './loggable.mjs';
import { JOIN_HISTORY_MS, OWNER_HISTORY_MS, RETENTION_MS } from './store.mjs';

/**
 * An automatic join stores this much of the chat before the joining message; an owner-button
 * join (Move to Bona inbox, Add chat by phone number) this much. Defined beside the history
 * floor they set (lib/inbox/store.mjs `setInboxState`), and exported here as they always were.
 */
export { JOIN_HISTORY_MS, OWNER_HISTORY_MS };
/** Pages per question on a history read: 10 × 100 records is more than any real chat window. */
export const BACKFILL_MAX_PAGES = 10;
/** How many of the newest records a refresh asks for, per question. */
export const REFRESH_LIMIT = 50;

/** No single refresh question waits longer than this, whatever is left of the budget (A2). */
const REFRESH_REQUEST_MS = 2_500;
/** A refresh's whole budget, and the pause before the same chat is read again (A2). */
const REFRESH_BUDGET_MS = 3_000;
const REFRESH_PAUSE_MS = 5_000;
/** A time a caller may pass: a finite number from 0. Anything else reads the default — a NaN pause would switch the pause off. */
const isTime = (ms) => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0;
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

/**
 * What a failed read says about itself: a status or a kind of failure, never an error
 * message — one could carry a jid. The kind comes first: lib/evolution.mjs throws
 * `failed: timeout` / `failed: network` with the 2xx status when a body breaks off while it
 * is read, and that is a timeout or a network failure, not an HTTP one.
 */
function errorCode(err) {
  if (err instanceof EvolutionError) {
    const kind = / failed: (timeout|network)$/.exec(String(err.message))?.[1];
    if (kind) return kind;
    return err.status ? `http_${err.status}` : 'network';
  }
  return 'failed';
}

/**
 * Whether a record answers the question asked. A `remoteJidAlt` question also takes a record
 * filed under that jid itself: the normaliser drops an alt equal to the jid, so such a
 * record has no alt to compare, and it is the same chat.
 */
function answers(key, rec) {
  if (typeof key.remoteJidAlt === 'string') return rec.jidAlt === key.remoteJidAlt || rec.jid === key.remoteJidAlt;
  return rec.jid === key.remoteJid;
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
  /** lead_id → a refresh still reading that chat (settles, never rejects); removed when it lands. */
  const inflight = new Map();

  /** A logger that throws never breaks a read, nor the promise that it never throws. */
  function note(entry) {
    try { log(entry); } catch { /* the read goes on */ }
  }

  function failed(leadId, error, name = null) {
    note({ level: 'warn', evt: 'inbox.backfill.failed', leadId, error, ...(name ? { name } : {}) });
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
   * The three questions for one chat, each paged newest-first inside `[sinceMs, untilMs]`
   * (the `messageTimestamp` window every question carries, and the only records kept). With
   * a `deadline` (a refresh), each question waits at most what is left of it, and none
   * starts once it has passed; a question cut off by its own timeout is dropped the same
   * way. The tally then says `partial`, and the questions still inside the budget are asked.
   * Only a history read (`noteTruncation`) reports a question with more pages than it may
   * read: a refresh reads only the newest page on purpose. Once the chat has left the
   * inbox, nothing more is asked.
   */
  async function readChat(lead, { sinceMs, untilMs, offset, maxPages, noteTruncation, deadline = null }) {
    const leadId = lead.lead_id;
    const time = { gte: iso(sinceMs), lte: iso(untilMs) };
    const seen = new Set();
    const tally = { stored: 0, scanned: 0, truncated: false };
    /** The lead as it is now while it is still in the inbox, else null. */
    const stillIn = () => {
      const current = db.getLead(leadId);
      return current?.inbox_state === 'in' ? current : null;
    };

    /**
     * One question, paged. Each new record that answers it is added to `into` as its page
     * comes, so when a later page fails, what the earlier ones brought is still there to store.
     */
    async function ask(clause, key, into) {
      const where = { key, messageTimestamp: time };
      let foreign = 0;
      let outside = 0;
      try {
        for (let page = 1; page <= maxPages; page += 1) {
          let query = { where, page, offset };
          if (deadline !== null) {
            const left = deadline - now();
            if (left <= 0) {
              tally.partial = true;
              break;
            }
            // AbortSignal.timeout takes whole milliseconds only, and at least one.
            query = { ...query, timeoutMs: Math.max(1, Math.floor(Math.min(left, REFRESH_REQUEST_MS))) };
          }
          let answer;
          try {
            answer = await read(query);
          } catch (err) {
            // Out of time is what the budget is for: the read is partial, not failed (A2).
            // Anything else, and any timeout on a history read, fails the read.
            if (deadline === null || errorCode(err) !== 'timeout') throw err;
            tally.partial = true;
            break;
          }
          const records = Array.isArray(answer) ? answer : (Array.isArray(answer?.records) ? answer.records : []);
          tally.scanned += records.length;
          for (const rec of records) {
            if (!rec?.id || isGroupOrBroadcast(rec.jid)) continue;
            // Another chat's record, however it got here, is never filed under this lead (A9).
            if (!answers(key, rec)) {
              foreign += 1;
              continue;
            }
            // Nor one from outside the window asked for (A10): the floor is ours to keep.
            if (!(Number.isFinite(rec.ts) && rec.ts >= sinceMs && rec.ts <= untilMs)) {
              outside += 1;
              continue;
            }
            if (seen.has(rec.id)) continue;
            seen.add(rec.id);
            into.push(rec);
          }
          // Evolution says how many pages the question has; an answer that does not is read
          // until a short page, the way lib/evolution.mjs `fetchWindow` always has.
          const pages = Number.isFinite(answer?.pages) ? answer.pages : null;
          const more = pages === null ? records.length >= offset : page < pages;
          if (!more) break;
          if (page === maxPages && noteTruncation) {
            tally.truncated = true;
            note({
              level: 'warn', evt: 'inbox.backfill.truncated', leadId, clause, pages,
              total: Number.isFinite(answer?.total) ? answer.total : null, maxPages,
            });
          }
        }
      } finally {
        // Counts only: the moment an Evolution upgrade stops applying a filter shows here.
        if (foreign > 0) note({ level: 'warn', evt: 'inbox.backfill.foreign', leadId, clause, count: foreign });
        if (outside > 0) note({ level: 'warn', evt: 'inbox.backfill.outside_window', leadId, clause, count: outside });
      }
    }

    /** Oldest first, the order they happened in — like the poller. */
    async function store(records) {
      for (const rec of oldestFirst(records)) {
        const out = await ingest(db.getLead(leadId), rec);
        if (out?.stored && out.inserted) tally.stored += 1;
      }
    }

    const phoneJid = phoneJidOf(lead);
    if (phoneJid) {
      // Both phone questions, then stored together: what the owner typed (under the lid, the
      // phone as alt) and what the API sent (under the phone jid) interleave, and ingest
      // matches an outbox row and picks the handler by what it sees first. Whatever was
      // fetched is stored, also when a later page or the second question fails.
      const found = [];
      try {
        await ask('phone_alt', { remoteJidAlt: phoneJid }, found);
        if (stillIn()) await ask('phone', { remoteJid: phoneJid }, found);
      } finally {
        await store(found);
      }
    }
    // Read again: the chat may have left the inbox meanwhile (a chat the inbox has no
    // business with is not fetched), and the two questions above may have taught it its lid.
    const fresh = stillIn();
    if (fresh && isLid(fresh.wa_lid)) {
      const found = [];
      try {
        await ask('lid', { remoteJid: fresh.wa_lid }, found);
      } finally {
        await store(found);
      }
    }
    return tally;
  }

  /**
   * Store a chat's messages between `sinceTs` and `untilTs` (ms), never from before the
   * retention horizon: like a refresh, it must not store again what the daily purge removed
   * (the purge leaves a quiet chat `in` with no messages, which is just what the catch-up
   * picks). A window wholly older than the horizon asks nothing.
   * @returns {Promise<{ stored: number, scanned: number, truncated: boolean, skipped?: string } | { error: string }>}
   */
  async function history(lead, { sinceTs, untilTs = now(), maxPages = BACKFILL_MAX_PAGES } = {}) {
    if (!configured) return skipped('not_configured');
    const leadId = lead?.lead_id ?? null;
    if (!Number.isFinite(sinceTs) || !Number.isFinite(untilTs) || sinceTs > untilTs) return failed(leadId, 'bad_window');
    try {
      const { lead: current, skip } = inboxLead(leadId);
      if (skip) return skip;
      const since = Math.max(sinceTs, now() - RETENTION_MS);
      if (since > untilTs) return { stored: 0, scanned: 0, truncated: false };
      // Fewer pages may be asked for, never more: anything but a whole number from 1 reads the cap.
      const cap = Number.isInteger(maxPages) && maxPages >= 1 ? Math.min(maxPages, BACKFILL_MAX_PAGES) : BACKFILL_MAX_PAGES;
      return await readChat(current, {
        sinceMs: since, untilMs: untilTs, offset: PAGE_SIZE, maxPages: cap, noteTruncation: true,
      });
    } catch (err) {
      return failed(leadId, errorCode(err), loggableName(err));
    }
  }

  /**
   * Store a chat's newest `REFRESH_LIMIT` records per question, from its history floor to
   * now (A1). The floor is the chat's own (`history_from`: 24 h before an automatic join, 30
   * days before an owner-button join), else 24 h before it joined, and never past the
   * retention horizon, or a refresh would store again what the daily purge removed.
   * Reading only the newest page is the point, so `truncated` is always false: what lies
   * further back is the join history's to store, and a refresh saying otherwise would flag
   * every active chat.
   *
   * Bounded (A2): the thread page and the reply right after it both ask, so the same chat
   * is not read again within `minIntervalMs`; and the read keeps to `budgetMs`, each question
   * waiting at most 2.5 s or what is left. A question that runs out of its time — the reader
   * aborts it and throws a timeout — makes the result `partial`, like a spent budget, and
   * keeps what the questions before it stored; any other failure is `{ error }`. The time is
   * noted before the read, so a failing Evolution is not asked again on every click either.
   * A caller inside the pause while that read is still under way waits for it to land (it
   * keeps to its own budget) before it is told `recent`, so the stale-view check before a
   * send never runs on what the read in flight has not stored yet (A10). Either option that
   * is not a finite number from 0 reads its default. Never throws.
   * @returns {Promise<{ stored: number, scanned: number, truncated: false, partial?: true, skipped?: string }
   *          | { skipped: 'recent' } | { error: string }>}
   */
  async function refresh(lead, { budgetMs = REFRESH_BUDGET_MS, minIntervalMs = REFRESH_PAUSE_MS } = {}) {
    if (!configured) return skipped('not_configured');
    const leadId = lead?.lead_id ?? null;
    const budget = isTime(budgetMs) ? budgetMs : REFRESH_BUDGET_MS;
    const pause = isTime(minIntervalMs) ? minIntervalMs : REFRESH_PAUSE_MS;
    try {
      const { lead: current, skip } = inboxLead(leadId);
      if (skip) return skip;
      const t = now();
      const last = refreshedAt.get(leadId);
      if (last !== undefined && t - last < pause) {
        const pending = inflight.get(leadId);
        if (pending) await pending;
        return { skipped: 'recent' };
      }
      refreshedAt.delete(leadId); // re-added at the end: the most recently refreshed
      refreshedAt.set(leadId, t);
      if (refreshedAt.size > REFRESH_MEMORY) refreshedAt.delete(refreshedAt.keys().next().value);
      const own = Number.isFinite(current.history_from) ? current.history_from : (current.inbox_since ?? t) - JOIN_HISTORY_MS;
      const floor = Math.max(own, t - RETENTION_MS);
      const run = readChat(current, {
        sinceMs: floor, untilMs: t, offset: REFRESH_LIMIT, maxPages: 1, noteTruncation: false, deadline: t + budget,
      });
      const landed = run.then(() => {}, () => {});
      inflight.set(leadId, landed);
      let out;
      try {
        out = await run;
      } finally {
        if (inflight.get(leadId) === landed) inflight.delete(leadId);
      }
      if (out.partial) note({ level: 'warn', evt: 'inbox.refresh.partial', leadId, budgetMs: budget });
      return out;
    } catch (err) {
      return failed(leadId, errorCode(err), loggableName(err));
    }
  }

  return { configured, phoneJidOf, history, refresh };
}
