/**
 * Messages from the WhatsApp instance (`BONA_WA_INSTANCE`; Bona's own number since 2026-11-19)
 * to anyone other than the owner (2026-09-27 design §4.5).
 *
 * Phase 1 sent only login codes to team members. Phase 2 adds team members' replies to
 * clients (`reply`, below); Phase 4 will add Dana. There is still exactly one sender —
 * `app.sender` (`createSender` in index.mjs) — because every message spends the same
 * thing, the standing of one personal number on WhatsApp, and the per-minute limits live
 * in this object's memory: a second instance would be a second, independent budget.
 * Every send passes the same gate:
 *
 *   - a 1:1 phone jid only (`…@s.whatsapp.net`, digits not starting with the local trunk
 *     `0`). A group, a broadcast, an `…@lid`, or a local-format number that never got
 *     turned into an international one, is refused: `lid` digits are an opaque id, not a
 *     phone number (see wa-poller.mjs).
 *   - a real `kind` — 'code' (a login code), 'staff' (a team member's reply), 'dana'
 *     (Dana's WhatsApp answers, lib/dana-wa.mjs, which pass this same gate after her own
 *     caps) or 'note' (a note to the owner, lib/owner-notes.mjs; DESIGN §7.1) — and a `text`
 *     that is a non-empty string of at most 4096 characters. A 'dana' send must name the
 *     pending outbox row she wrote first (`sendId`), or it is refused `bad_send_id`: a Dana
 *     row is never born without the `covers_ts` it answers. A 'note' goes only to the
 *     owner's own jid (`BONA_OWNER_JID`); any other recipient is `bad_recipient`.
 *   - the owner's Sending switch (`settings.sending_enabled`). It is bypassed only when
 *     the recipient IS the owner's jid (`BONA_OWNER_JID`) AND the message is a login
 *     `code` — `bypassSwitch` is a hint from the caller, never trusted on its own, because
 *     a caller that could bypass the switch for anyone else could use it to spam past the
 *     owner's own kill switch. Without this the owner could never get back in to switch
 *     sending back on.
 *   - 8 a minute across every sender (DESIGN §6.3, PR-B3), 6 a minute to any one recipient
 *     and 30 a minute from any one team member, all asked before any is charged (see
 *     lib/ratelimit.mjs `peek`), and SEND_PER_DAY in any 24 hours by the warm-up tier of
 *     BONA_WA_LINKED_AT (100 / 180 / 300 on days 0-7 / 8-21 / 22+, lib/pacing.mjs TIERS; unset =
 *     100), counted from the outbox (below) so that a restart cannot hand out a fresh day.
 *     A login `code` or a `note` to the owner's jid or to the
 *     instance's own number (`BONA_WA_INSTANCE_JID`, the same number while that is unset)
 *     skips the shared per-minute and daily budget (still capped per-recipient), so a busy
 *     day of team-member codes cannot lock the owner out of logging in. Only those two
 *     kinds: Dana and a staff reply into the owner's own chat (his test chat) are paced
 *     like any client's (critic C13). A note pays its own per-recipient limit, keyed
 *     `note:to:<digits>`, never the `send:to:<digits>` that Dana's sends into the test chat
 *     use, so a burst of notes cannot make her next answer `rate_limited` (critic round 2 #9).
 *   - `BONA_WA_NOTIFY=0` (`cfg.enabled`) was built to stop the lead note, and stops team
 *     replies too (see services/README.md); a login `code` only needs Evolution to be
 *     configured (`baseUrl`/`apiKey`) — otherwise the owner could be locked out by an env
 *     var that was never about dashboard logins. Every other kind still needs it on.
 *
 *   - never first (DESIGN §6.1, PR-B3): a 'dana' row must answer a STORED client message of its
 *     chat (`covers_ts` = that message's ts) under 24 hours old, or it is refused `no_open_chat`.
 *   - a brochure (PR-B3): a 'dana' send with `document: { url, fileName }` goes to Evolution's
 *     sendMedia as a document by URL, its `text` the caption (never empty), its row written first
 *     with `media_kind` 'document', within 45 s (MEDIA_TIMEOUT_MS); a timeout is `uncertain`,
 *     never retried. The URL must be https and the file name end in `.pdf` (Evolution derives the
 *     type from it; T00 finding 6), or it is refused `bad_document`.
 *
 * A `rate_limited` refusal also says which limit: `limit: 'minute'|'day'`. A login `code` to anyone is
 * outside the shared minute and day (PR-B3 r2: the team can log in on a full day), capped per recipient.
 *
 * Every refusal carries its failure class (PR-B3, the breaker of lib/dana-wa.mjs): `failure:
 * 'local'` for this file's own refusals (a bad argument, the Sending switch, BONA_WA_NOTIFY,
 * no Evolution, a rate limit, never-first, a duplicate), `failure: 'evolution'` for what
 * Evolution answered or did not (a 4xx, a 5xx, a network error, a timeout, a 2xx with no key).
 *
 * Every send that passes the gate is written to `wa_outbox` BEFORE the HTTP call, then
 * marked with what came back. A login code's row has no text (a code is never written
 * anywhere but the WhatsApp message) and no lead, and neither has a note's (a note about a
 * client must never sit in the outbox as text, or under that client). The ledger is what makes the daily cap
 * survive a restart, what turns a send cut off by a crash into `uncertain` instead of
 * forgotten (`recoverInterrupted`), and what lets the poller tell a team member's reply
 * from the owner typing on his phone. The poller may see a message go (and mark its row
 * `accepted`) while the call is still out; a failure that comes back after that never
 * overwrites it, and the answer is ok — the thread already shows the message, and
 * "failed" would invite the member to type it again. If writing the result itself fails
 * (a full disk), that is logged and the call's answer still returned: a message that went
 * is never reported as an error.
 *
 * A send is `accepted` only when the response is 2xx AND its body carries a `key.id`
 * string — the WhatsApp message id. Anything else (a non-2xx status, a 2xx with no id, a
 * timeout reading the body, or any other thrown error) is a failure we come back with
 * honestly: `uncertain` whenever the message might still have gone out — any 5xx included.
 * Only a 4xx (Evolution turned the request away) and a handful of pre-connection errors
 * (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`) are treated as definitely-not-sent
 * (`failed`). Nothing here retries, and a send id that has been
 * decided once is never sent again: the reply form carries a `send_id`, and a second
 * submit of it gets the first one's answer back — an `uncertain` one included.
 *
 * The owner's new-lead note to his own chat stays in lib/wa.mjs: that one is a message to
 * himself. PR-F2b adds the 'note' kind but leaves that note where it is; PR-B2 (T11) moves it
 * onto this kind together with the notes ledger, which holds a note this gate refuses for now.
 * Until then no production caller sends a 'note'.
 */
import { createLimiter } from './ratelimit.mjs';
import { waConfig } from './wa.mjs';
import { randomId } from './store.mjs';
import { parseIsoInstant } from './config.mjs';
import { TIERS, tierIndex } from './pacing.mjs';

export const SEND_PER_MIN = TIERS[0].SEND_PER_MIN;
/** The day's cap per warm-up tier (days 0-7, 8-21, 22+ since BONA_WA_LINKED_AT). */
export const SEND_PER_DAY_TIERS = Object.freeze(TIERS.map((t) => t.SEND_PER_DAY));
/** The strictest day: the one in force while BONA_WA_LINKED_AT is unset. */
export const SEND_PER_DAY = SEND_PER_DAY_TIERS[0];
/** A document send's deadline (DESIGN §6.3; Evolution downloads the PDF before it answers). */
export const MEDIA_TIMEOUT_MS = 45_000;
/** "composing" blocks Evolution for its `delay` (T00 finding 5): never longer than this. */
export const PRESENCE_MAX_MS = 15_000;
export const PER_RECIPIENT_PER_MIN = 6;
export const PER_USER_PER_MIN = 30;
export const MAX_TEXT_LEN = 4096;
/**
 * The kinds that may be sent. 'dana' = Dana's WhatsApp answers (lib/dana-wa.mjs), which pass
 * this same gate after her own caps; 'note' = a note to the owner (lib/owner-notes.mjs).
 */
const VALID_KINDS = new Set(['code', 'staff', 'dana', 'note']);
/** The kinds outside the shared budget when they go to the owner or the instance's own number, and whose rows keep no text and no lead. */
const FREE_KINDS = new Set(['code', 'note']);
const PHONE_JID_RE = /^(\d{8,15})@s\.whatsapp\.net$/;
/** What the reply form's hidden `send_id` must look like; anything else is not ours. */
const SEND_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** Failures we can be sure never reached the other side — no ambiguity, so not "uncertain". */
const DEFINITE_NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
const DAY_MS = 86_400_000;
/** A brochure's file name: Evolution reads the type from its extension (T00 finding 6). */
const PDF_NAME_RE = /^[^/\\\u0000-\u001f]{1,120}\.pdf$/i;
/**
 * A send still `pending` this long after it was written is no longer on its way. The rule
 * for the reply stale guard and the daily upkeep (index.mjs); the start-up recovery needs
 * no cutoff at all (`recoverInterrupted`).
 */
export const INTERRUPTED_MS = 120_000;

/**
 * A Dana row's `error` may carry lib/dana-wa.mjs's mark ('outage_line', or 'cov:<rowid>': the stored client message the
 * row covers), alone or as `<mark>|<reason>` once the send went unsure. THE one parse of it (r13), for every reader:
 * `{ mark, reason }`. A failed row keeps its plain reason (it answers nothing, and the dashboard shows that reason).
 */
export function splitMark(error) {
  const s = typeof error === 'string' ? error : '';
  if (!s) return { mark: null, reason: null };
  const bar = s.indexOf('|');
  const head = bar >= 0 ? s.slice(0, bar) : s;
  if (head === 'outage_line' || /^cov:\d+$/.test(head)) return { mark: head, reason: bar >= 0 ? s.slice(bar + 1) || null : null };
  return { mark: null, reason: s };
}

/** A send id of this file's own: 64 random bits, so two sends in one millisecond never share a row. */
const newSendId = () => `SND-${Date.now().toString(36)}-${randomId(8)}`;

/** Strip a jid's device suffix (`966…:12@s.whatsapp.net` → `966…@s.whatsapp.net`) before comparing. */
const bareDigits = (jid) => String(jid ?? '').replace(/@.*$/, '').replace(/:.*$/, '');

/**
 * Where a reply to this lead goes: its phone jid (device suffix stripped), else its
 * stored phone number as a jid — or null for a chat we only know by its `@lid`, which is
 * an opaque id, not a number (spec §4.5: "reply from your phone").
 * @param {object|null} lead
 * @returns {string|null}
 */
export function replyJidFor(lead) {
  const m = /^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/.exec(String(lead?.wa_jid ?? ''));
  if (m && !m[1].startsWith('0')) return `${m[1]}@s.whatsapp.net`;
  const phone = String(lead?.phone_e164 ?? '');
  return /^[1-9]\d{7,14}$/.test(phone) ? `${phone}@s.whatsapp.net` : null;
}

/**
 * @param {{ env?: object, team: ReturnType<import('./team.mjs').createTeam>,
 *           inbox: ReturnType<import('./inbox/store.mjs').createInboxStore>,
 *           db?: ReturnType<import('./db.mjs').openDb>|null,
 *           fetchImpl?: typeof globalThis.fetch, now?: () => number, log?: Function, timeoutMs?: number,
 *           limits?: { perMinute?: number, perUser?: number } }} o
 */
export function createSender({
  env = {}, team, inbox, db = null, fetchImpl = globalThis.fetch, now = () => Date.now(), log = () => {}, timeoutMs = 8000, limits = {},
  mediaTimeoutMs = MEDIA_TIMEOUT_MS,
} = {}) {
  if (!team) throw new TypeError('createSender needs the team store (for the sending switch)');
  if (!inbox) throw new TypeError('createSender needs the inbox store (for the outbox and the daily cap)');
  const cfg = waConfig(env);
  // The switch bypass is the owner's (BONA_OWNER_JID): his login code must always get through,
  // or he could never switch sending back on. Outside the shared budget: his number and the
  // instance's own (BONA_WA_INSTANCE_JID) — one number while that is unset, as before the split.
  const ownerDigits = bareDigits(cfg.ownerJid);
  const unbudgeted = new Set([ownerDigits, bareDigits(cfg.instanceJid)].filter(Boolean));
  // The outbox holds bare jids, so these are compared in that form too.
  const unbudgetedJids = [...unbudgeted].map((d) => `${d}@s.whatsapp.net`);
  const perMinute = createLimiter({ capacity: limits.perMinute ?? SEND_PER_MIN, perMs: 60_000, now });
  const perRecipient = createLimiter({ capacity: PER_RECIPIENT_PER_MIN, perMs: 60_000, now });
  // With the shipped 20/min across everyone this cannot bind; it is here so that raising
  // the shared limit can never let one account alone send faster than this.
  const perUser = createLimiter({ capacity: limits.perUser ?? PER_USER_PER_MIN, perMs: 60_000, now });
  // The warm-up anchor (BONA_WA_LINKED_AT): the day's cap grows with the number's age (DESIGN §6.3).
  const linkedAt = parseIsoInstant(env.BONA_WA_LINKED_AT);
  const dayCap = () => SEND_PER_DAY_TIERS[tierIndex(now(), linkedAt)];
  let codesStmt = null;
  /**
   * What the shared day has spent: the outbox's count (`countSentSince` leaves out free-kind rows to the
   * unbudgeted jids), less the login codes to team members, which spend none of it (PR-B3 r2).
   */
  function daySent() {
    const since = now() - DAY_MS;
    let codes = 0;
    if (db?.db) {
      codesStmt ??= db.db.prepare(`SELECT COUNT(*) AS n FROM wa_outbox WHERE sender_kind = 'code' AND status IN ('pending','accepted','uncertain')
          AND created >= ? AND jid NOT IN (?, ?)`);
      codes = codesStmt.get(since, unbudgetedJids[0] ?? '', unbudgetedJids[1] ?? '').n;
    }
    return inbox.countSentSince(since, { excludeJids: unbudgetedJids }) - codes;
  }
  /** Is the shared day budget used up? Asked by lib/dana-wa.mjs before a paid model call (PR-B3 r2). */
  const dayFull = () => daySent() >= dayCap();
  let openStmt = null;
  /**
   * Never first (DESIGN §6.1): `coversTs` is a stored client message of this chat under 24 h old.
   * Read from the messages themselves; without the db store, from the chat's newest 200.
   */
  function openChat(leadId, coversTs) {
    if (typeof leadId !== 'string' || !leadId || !Number.isFinite(coversTs) || coversTs < now() - DAY_MS) return false;
    if (db?.db) {
      openStmt ??= db.db.prepare("SELECT 1 FROM wa_messages WHERE lead_id = ? AND direction = 'in' AND ts = ? LIMIT 1");
      return Boolean(openStmt.get(leadId, coversTs));
    }
    return inbox.messagesFor(leadId, { limit: 200 }).some((m) => m.direction === 'in' && m.ts === coversTs);
  }

  /**
   * The HTTP call and nothing else: what came back, as honestly as we can tell. A `document`
   * goes to sendMedia (by URL, the text as its caption) within the longer media deadline.
   * Every failure is Evolution's answer, or the lack of one: `failure: 'evolution'`.
   */
  async function post(number, text, kind, document = null) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), document ? mediaTimeoutMs : timeoutMs);
    const failed = (o) => ({ ok: false, ...o, failure: 'evolution' });
    try {
      let res;
      try {
        const route = document ? 'sendMedia' : 'sendText';
        const body = document
          ? { number, mediatype: 'document', mimetype: 'application/pdf', media: document.url, fileName: document.fileName, caption: text }
          : { number, text };
        res = await fetchImpl(`${cfg.baseUrl}/message/${route}/${encodeURIComponent(cfg.instance)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: cfg.apiKey },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        if (err?.name === 'AbortError') {
          log({ level: 'warn', evt: 'wa.send.uncertain', kind, error: 'timeout' });
          return failed({ error: 'timeout', uncertain: true });
        }
        const definite = DEFINITE_NETWORK_CODES.has(err?.cause?.code);
        log({ level: 'warn', evt: definite ? 'wa.send.failed' : 'wa.send.uncertain', kind, error: 'network' });
        return definite ? failed({ error: 'network' }) : failed({ error: 'network', uncertain: true });
      }

      if (!res.ok) {
        // Only a 4xx is Evolution turning the request away before it did anything. A 5xx
        // cannot say whether the message went: a 500 thrown after WhatsApp took it, a 503
        // from a proxy in front of a send that went, a 502/504 gateway.
        const refused = res.status >= 400 && res.status < 500;
        log({ level: 'warn', evt: refused ? 'wa.send.failed' : 'wa.send.uncertain', kind, status: res.status });
        return refused ? failed({ error: `http_${res.status}` }) : failed({ error: `http_${res.status}`, uncertain: true });
      }

      let text2xx;
      try {
        text2xx = await res.text();
      } catch {
        // The send may well have gone through — we just could not read the ack.
        log({ level: 'warn', evt: 'wa.send.no_key', kind });
        return failed({ error: 'no_ack', uncertain: true });
      }
      let keyId = null;
      try {
        const body = JSON.parse(text2xx);
        keyId = typeof body?.key?.id === 'string' ? body.key.id : null;
      } catch { keyId = null; }
      if (typeof keyId !== 'string') {
        log({ level: 'warn', evt: 'wa.send.no_key', kind });
        return failed({ error: 'no_ack', uncertain: true });
      }
      log({ evt: 'wa.send.ok', kind });
      return { ok: true, keyId, status: res.status };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {{ jid: string, text: string, kind: 'code'|'staff'|'dana'|'note', userId?: string|null, bypassSwitch?: boolean,
   *           leadId?: string|null, sendId?: string|null, document?: { url: string, fileName: string }|null }} o
   *   `document`: Dana's brochure (her row written first with media_kind 'document'; `text` is the caption)
   * @returns {Promise<{ ok: true, keyId: string, status?: number, sendId: string }
   *                 | { ok: false, error: string, failure: 'local'|'evolution', uncertain?: true, sendId?: string }>}
   *   `sendId` is there whenever an outbox row stands behind the answer. `status` here is
   *   the HTTP status of the 2xx that carried the key (201, say) — not an outbox status,
   *   which is what `reply`'s `status` is. It is absent when the call itself failed but the
   *   poller had already seen the message go: then `keyId` is the one the poller recorded.
   */
  async function sendTo({ jid, text, kind, userId = null, bypassSwitch = false, leadId = null, sendId = null, document = null } = {}) {
    const given = sendId ? String(sendId) : null;
    const givenRow = given ? inbox.getOutbox(given) : null;
    // Decided once — accepted, failed, or perhaps delivered — so never sent a second time.
    if (givenRow && givenRow.status !== 'pending') return { ok: false, error: 'duplicate', failure: 'local', sendId: given };
    // A refusal closes a row the caller already wrote, so it is never left `pending` —
    // which a restart would turn into "not sure it went" for a message that never left.
    // Every one of these is ours, not Evolution's: `failure: 'local'` (the breaker never counts it).
    const refuse = (error, extra = {}) => {
      if (givenRow) inbox.updateOutbox(given, { status: 'failed', error });
      return givenRow ? { ok: false, error, failure: 'local', ...extra, sendId: given } : { ok: false, error, failure: 'local', ...extra };
    };

    const m = PHONE_JID_RE.exec(String(jid ?? ''));
    if (!m || m[1].startsWith('0')) return refuse('bad_recipient');
    if (!VALID_KINDS.has(kind)) return refuse('bad_kind');
    // A note is the owner's alone: never to a client, a colleague or the Bona number itself.
    if (kind === 'note' && m[1] !== ownerDigits) return refuse('bad_recipient');
    // Dana writes her row first, with the `covers_ts` it answers; a bare Dana send never is.
    if (kind === 'dana' && !givenRow) return refuse('bad_send_id');
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_LEN) return refuse('bad_text');
    // A brochure is Dana's alone, on a document row she wrote first, by https URL as a .pdf.
    if (document !== null && document !== undefined) {
      const url = typeof document?.url === 'string' ? document.url : '';
      let https = false;
      try { https = new URL(url).protocol === 'https:'; } catch { https = false; }
      const named = typeof document?.fileName === 'string' && PDF_NAME_RE.test(document.fileName);
      if (kind !== 'dana' || givenRow?.media_kind !== 'document' || !https || !named) return refuse('bad_document');
    }
    // Never first (DESIGN §6.1): her row answers a stored client message of its chat, under 24 h old.
    if (kind === 'dana' && !openChat(givenRow.lead_id, givenRow.covers_ts)) return refuse('no_open_chat');

    const isOwner = m[1] === ownerDigits;
    // A caller's `bypassSwitch` is only ever honoured for the owner's own login code —
    // never trusted for anyone else, or it would be a way to spam past the kill switch.
    const bypassAllowed = bypassSwitch && kind === 'code' && isOwner;
    if (!bypassAllowed && !team.sendingEnabled()) return refuse('sending_disabled');
    // BONA_WA_NOTIFY stops the lead note and team replies (services/README.md); a login
    // code does not need it, or the owner could be locked out by an unrelated switch.
    if (kind !== 'code' && !cfg.enabled) return refuse('disabled');
    if (!cfg.baseUrl || !cfg.apiKey) return refuse('evolution-not-configured');

    // A login code to anyone (the owner, a team member) is outside the shared minute and day (PR-B3 r2):
    // on a busy day the team can still log in. Still capped per recipient.
    const free = (FREE_KINDS.has(kind) && unbudgeted.has(m[1])) || kind === 'code';
    const gates = free
      ? [[perRecipient, `${kind === 'note' ? 'note' : 'send'}:to:${m[1]}`]]
      : [[perMinute, 'send:minute'], [perRecipient, `send:to:${m[1]}`], ...(userId ? [[perUser, `send:user:${userId}`]] : [])];
    let dayFull = false;
    if (!free) {
      // The caller's own `pending` row is already in the count; it is this send, not an earlier one.
      const own = givenRow && givenRow.created >= now() - DAY_MS && givenRow.sender_kind !== 'code'
        && !(FREE_KINDS.has(givenRow.sender_kind) && unbudgetedJids.includes(givenRow.jid)) ? 1 : 0;
      dayFull = daySent() - own >= dayCap();
    }
    if (dayFull || gates.some(([limiter, key]) => !limiter.peek(key).ok)) {
      const limit = dayFull ? 'day' : 'minute';
      log({ level: 'warn', evt: 'wa.send.rate_limited', kind, limit });
      return refuse('rate_limited', { limit });
    }
    for (const [limiter, key] of gates) limiter.take(key);

    // Written before the call, so a crash in the middle leaves a trace (`recoverInterrupted`).
    const row = givenRow ?? inbox.insertOutbox({
      send_id: given ?? newSendId(),
      lead_id: FREE_KINDS.has(kind) ? null : leadId,
      jid: `${m[1]}@s.whatsapp.net`,
      text: FREE_KINDS.has(kind) ? null : text,
      user_id: userId,
      sender_kind: kind,
    }).row;

    const out = await post(m[1], text, kind, document ?? null);
    try {
      // A 2xx with a key names this send exactly, so it is always written.
      if (out.ok) {
        inbox.updateOutbox(row.send_id, { status: 'accepted', key_id: out.keyId });
      } else {
        // While the call was out the poller may have matched WhatsApp's own copy to this
        // row and marked it `accepted`: proof it went, which a failure coming back now must
        // not undo. No await separates this read from the write below.
        const current = inbox.getOutbox(row.send_id);
        if (current?.status === 'accepted' && current.key_id) {
          log({ level: 'warn', evt: 'wa.send.seen_sent', kind, error: out.error });
          return { ok: true, keyId: current.key_id, sendId: row.send_id };
        }
        // An unsure row keeps dana-wa's mark in this same write (`<mark>|<reason>`, r13): no second write a crash could lose.
        const keep = out.uncertain ? splitMark(current.error).mark : null;
        if (current?.status === 'pending') inbox.updateOutbox(row.send_id, { status: out.uncertain ? 'uncertain' : 'failed', error: keep ? `${keep}|${out.error}` : out.error });
      }
    } catch (err) {
      // The call's answer stands. The row stays `pending` until the poller matches it to
      // WhatsApp's copy or `markStalePending` (start-up, daily upkeep) makes it `uncertain`;
      // until then a second submit of the same form is told it is on its way.
      log({ level: 'error', evt: 'wa.send.ledger_failed', kind, error: err?.code ?? err?.name ?? 'error' });
    }
    return { ...out, sendId: row.send_id };
  }

  /** A second submit of a send id gets the first one's answer — never a second message. */
  function answerFor(row, { leadId, userId }) {
    if (row.sender_kind !== 'staff' || row.lead_id !== String(leadId ?? '') || row.user_id !== (userId ?? null)) {
      return { ok: false, error: 'bad_send_id' };
    }
    const out = {
      ok: row.status === 'accepted',
      duplicate: true,
      status: row.status,
      sendId: row.send_id,
      error: row.status === 'accepted' ? null : (row.error ?? row.status),
    };
    // Still on its way, or perhaps delivered: the thread says "not sure it went — check WhatsApp".
    if (row.status === 'uncertain' || row.status === 'pending') out.uncertain = true;
    return out;
  }

  /**
   * A team member's reply from the inbox thread (spec §4.5). Every check that can refuse
   * runs before anything is written, in this order, so the answer names the first reason.
   * @param {{ sendId: string, leadId: string, userId: string, text: string, seenRev: number }} o
   *   `seenRev` is the chat's revision (inbox `revision`) when the writer's page was drawn.
   * @returns {Promise<{ ok: true, status: 'accepted', sendId: string, keyId: string }
   *   | { ok: false, error: string, status?: string, sendId?: string, duplicate?: true, uncertain?: true }>}
   *   `status` here is the outbox status ('accepted', 'pending', 'uncertain', 'failed') —
   *   not the HTTP status `sendTo` reports.
   */
  async function reply({ sendId, leadId, userId, text, seenRev } = {}) {
    if (!db) throw new TypeError('reply needs the db store: pass `db` to createSender');
    if (typeof sendId !== 'string' || !SEND_ID_RE.test(sendId)) return { ok: false, error: 'bad_send_id' };
    const existing = inbox.getOutbox(sendId);
    if (existing) return answerFor(existing, { leadId, userId });
    // Replies to clients ship switched off; the owner turns them on from the Team page
    // (design D14: the first real client message from the dashboard is sent with him).
    // Asked before anything is written, so a refusal leaves no row and the same send id
    // still works once they are on. A send id decided above keeps its own answer.
    if (!team.repliesEnabled()) return { ok: false, error: 'replies_off' };

    // A browser posts a textarea's line breaks as CRLF; WhatsApp keeps LF. The outbox row
    // must hold exactly what WhatsApp will hand back, or the poller could not match it.
    const body = typeof text === 'string' ? text.replace(/\r\n?/g, '\n').trim() : '';
    if (!body || body.length > MAX_TEXT_LEN) return { ok: false, error: 'bad_text' };

    const lead = db.getLead(leadId);
    if (!lead) return { ok: false, error: 'not_found' };
    if (lead.inbox_state !== 'in') return { ok: false, error: 'not_in_inbox' };
    const jid = replyJidFor(lead);
    if (!jid) return { ok: false, error: 'lid_only' };
    if (team.isExcludedPhone(bareDigits(jid)) || (lead.phone_e164 && team.isExcludedPhone(lead.phone_e164))) {
      return { ok: false, error: 'excluded' };
    }
    // The form carries the chat's revision when the writer's page was drawn. Anything
    // written to the thread since — a message in either direction, whatever WhatsApp
    // stamped it, another send to this chat, whatever became of it, a send the page showed
    // on its way since settled (it may have gone), a message that could not be loaded, or
    // a purge of the chat — has moved the revision on: they are answering a conversation
    // that has moved on. The revision never goes down or comes back, so only the exact
    // number sends; one above it was never drawn (a forged form). Not the newest message
    // time: a reply is stored at the second its send started, so an accepted one can carry
    // the very timestamp another page shows as its newest, and that page would pass.
    if (!Number.isSafeInteger(seenRev) || seenRev !== inbox.revision(lead.lead_id)) return { ok: false, error: 'stale' };
    // Nor may it cross another reply to this chat that is still on its way, even one the
    // page showed as such: that one is stored only once WhatsApp answers. A row pending for
    // longer than a send can take was cut off by a restart (`recoverInterrupted`), not in
    // flight.
    const onItsWay = inbox.openOutboxFor(lead.lead_id, { sinceTs: now() - INTERRUPTED_MS }).some((r) => r.status === 'pending');
    if (onItsWay) return { ok: false, error: 'stale' };
    // The author, read again as the last thing before the row: a member deactivated while
    // the chat was being refreshed, or at any moment before, sends nothing — whoever called.
    // No await separates this from the row, and the row from the call.
    if (!team.getUser(userId)?.active) return { ok: false, error: 'inactive_user' };

    const ins = inbox.insertOutbox({
      send_id: sendId, lead_id: lead.lead_id, jid, text: body, user_id: userId ?? null, sender_kind: 'staff', status: 'pending',
    });
    if (!ins.inserted) return answerFor(ins.row, { leadId, userId });

    const out = await sendTo({ jid, text: body, kind: 'staff', userId: userId ?? null, leadId: lead.lead_id, sendId });
    if (!out.ok) {
      const res = { ok: false, error: out.error, status: out.uncertain ? 'uncertain' : 'failed', sendId };
      if (out.uncertain) res.uncertain = true;
      // Which limit refused it (the dashboard's copy may say "today" rather than "this minute").
      if (out.limit) res.limit = out.limit;
      return res;
    }

    try {
      const t = now();
      // The message is stored at the moment its send started — the outbox row's `created`,
      // floored to the whole second WhatsApp stamps its own messages with — not when
      // WhatsApp answered. A client message sent during the round trip is then newer than
      // the reply that never saw it: unread for its writer, and a stale view for the next
      // reply, instead of tucked in before it. The watchdog's first reply is when it went.
      const startedAt = Number.isFinite(ins.row?.created) ? ins.row.created : t;
      const storedTs = Math.floor(startedAt / 1000) * 1000;
      db.transaction(() => {
        // Re-read: the lead may have changed while the message was on its way. If the owner
        // marked it *Not a client*, or put its number on the never list, its transcript was
        // purged on purpose — storing this reply would start a new one for a chat he just
        // threw out, so only an `in` chat gets the message, the handler and the flag.
        const fresh = db.getLead(lead.lead_id);
        if (fresh?.inbox_state === 'in') {
          inbox.upsertMessage({
            key_id: out.keyId, lead_id: lead.lead_id, jid, direction: 'out', sender_kind: 'staff',
            sender_user_id: userId ?? null, text: body, ts: storedTs, status: 'sent',
          });
          if (!fresh.handler_user_id && userId) inbox.setHandler(lead.lead_id, userId);
          inbox.setNeedsHuman(lead.lead_id, 0);
          // The human clock Dana's 24 h silence runs on (P4-5).
          inbox.noteHumanOutbound(lead.lead_id, storedTs);
        }
        // The client was answered either way. The Hermes `bona-unanswered-leads` watchdog
        // reads this column.
        if (fresh && fresh.first_reply_ts == null) db.updateLead(lead.lead_id, { first_reply_ts: t });
      });
    } catch (err) {
      // The message went. Saying otherwise would invite a second send; the poller stores
      // it from WhatsApp's own copy, matched to this row by its key.
      log({ level: 'error', evt: 'wa.reply.record_failed', error: err?.code ?? err?.name ?? 'error' });
    }
    return { ok: true, status: 'accepted', sendId, keyId: out.keyId };
  }

  /**
   * On start-up: EVERY send still `pending` was cut off mid-flight, however young — a
   * process that has only just started has no send of its own on its way, and a row a few
   * seconds old left pending would hold its chat as "on its way" (stale) for two minutes.
   * Only the daily upkeep keeps the two-minute cutoff: by then this process may be sending.
   */
  const recoverInterrupted = () => inbox.markStalePending(Number.MAX_SAFE_INTEGER);

  /**
   * A read receipt and "composing" for Dana's brain turns (DESIGN §6.2; T00 verified the Evolution 2.3.7 shapes,
   * verify/T00.md). Neither is a message: no outbox row, no limiter, nothing against any budget, and never a
   * send failure for lib/dana-wa.mjs. A phone jid only: markMessageAsRead silently drops @lid keys (T00 finding 4),
   * so the caller names the phone jid; sendPresence blocks for `delay` ms (finding 5), so it is capped at 15 s and
   * the caller never awaits it inside a send. Both obey the Sending switch and BONA_WA_NOTIFY, and never throw.
   */
  async function chatCall(route, jid, body, ms) {
    const m = PHONE_JID_RE.exec(String(jid ?? ''));
    if (!m || m[1].startsWith('0')) return { ok: false, error: 'bad_recipient' };
    if (!team.sendingEnabled()) return { ok: false, error: 'sending_disabled' };
    if (!cfg.enabled) return { ok: false, error: 'disabled' };
    if (!cfg.baseUrl || !cfg.apiKey) return { ok: false, error: 'evolution-not-configured' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const res = await fetchImpl(`${cfg.baseUrl}/chat/${route}/${encodeURIComponent(cfg.instance)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: cfg.apiKey }, body: JSON.stringify(body(m[1])), signal: controller.signal,
      });
      await res.text?.().catch(() => '');
      log({ evt: `wa.${route === 'sendPresence' ? 'presence' : 'read'}`, ok: res.ok, status: res.status });
      return res.ok ? { ok: true } : { ok: false, error: `http_${res.status}` };
    } catch (err) {
      return { ok: false, error: err?.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  }
  const markRead = ({ jid, keyIds = [] } = {}) => {
    const ids = (Array.isArray(keyIds) ? keyIds : []).filter((k) => typeof k === 'string' && k);
    if (!ids.length) return Promise.resolve({ ok: false, error: 'nothing' });
    return chatCall('markMessageAsRead', jid, () => ({ readMessages: ids.map((id) => ({ id, fromMe: false, remoteJid: jid })) }), 5_000);
  };
  const presence = ({ jid, delayMs = 0 } = {}) => {
    const delay = Math.max(0, Math.min(PRESENCE_MAX_MS, Math.floor(Number(delayMs) || 0)));
    return chatCall('sendPresence', jid, (digits) => ({ number: digits, presence: 'composing', delay }), delay + 5_000);
  };

  return { sendTo, reply, recoverInterrupted, dayFull, markRead, presence };
}
