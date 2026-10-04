/**
 * Phone alerts for the Bona inbox (2026-09-27 design §5, Phase 3).
 *
 * A member's browser subscribes (lib/dashboard/routes.mjs → `subscribe`); the subscription
 * belongs to that member AND to the login session that posted it (P3-5), so a push reaches
 * only a device someone is still signed in on. A subscription is only ever bound to a live
 * session of the member posting it: a hash that is unknown, expired or another member's is
 * refused, so no row can start life pointing at a session that would never push. When the
 * poller stores a client message of an `in` chat, `notify` decides who hears of it, as the
 * chat is at that moment:
 *
 *   - the chat must be `in` the inbox and not a colleague's or a never-list number;
 *   - "needs a human" (Phase 4's hand-over) → every active member; otherwise its handler,
 *     when it has an active one; otherwise every active member; never `exceptUserId`;
 *   - at most one push per chat per member every two minutes (in memory), marked before the
 *     sends start, so a burst of messages is one alert;
 *   - a message more than 30 minutes old is not an alert (the poller catching up after an
 *     outage): it waits in the list as unread.
 *
 * The reason `check` (2026-10-04 design, U1–U4) is a chat that has just entered the Unsure
 * list: it must be `unsure` and not excluded, it goes to the active owners only (the Unsure
 * list is theirs), under the same two-minute and 30-minute rules, and each owner it is due
 * for is remembered in memory (`pendingCheck`) until a newer check replaces it or the chat
 * leaves the Unsure list. A check's two-minute mark is its own: it never quiets the
 * `inbound` alert of the same chat once the owner has moved it in.
 *
 * Each of the recipients' live devices gets one empty push (lib/push.mjs). 404/410 means the
 * browser dropped the subscription: the row goes. Anything else counts a failure and is
 * logged by its status only. Nothing is retried. `notify` never rejects. No endpoint, name,
 * number or message text is ever logged: counts and ids only.
 */
import { newId } from './db.mjs';
import { pushEndpoint, subscriptionKeys } from './push.mjs';

export const ALERT_EVERY_MS = 120_000;
export const ALERT_FRESH_MS = 30 * 60_000;
export const MAX_DEVICES_PER_USER = 10;
/**
 * How many (member, chat) marks the 2-minute rule remembers before it forgets the old ones:
 * a prune trigger, not a bound — fresh marks are never evicted (a three-member team never
 * gets near it).
 */
const MARKS_MAX = 5000;
/** The reasons a push can be sent for; anything else is logged as `other` and follows the `inbound` rules. */
const REASONS = new Set(['inbound', 'needs_human', 'check']);
/** The failure kinds lib/push.mjs `send` answers, plus `threw` for a send that rejected after all. */
const SEND_ERRORS = new Set(['timeout', 'network', 'bad_endpoint', 'threw']);

export function createAlerts({ db, pusher = null, isExcludedLead, now = () => Date.now(), log = () => {} }) {
  if (typeof isExcludedLead !== 'function') throw new TypeError('createAlerts needs isExcludedLead (lib/team.mjs)');
  const { transaction } = db;
  const stmts = new Map();
  const prep = (sql) => {
    let s = stmts.get(sql);
    if (!s) { s = db.db.prepare(sql); stmts.set(sql, s); }
    return s;
  };
  const marks = new Map(); // `${userId}\n${leadId}` → when that member was last alerted about that chat
  const checks = new Map(); // owner's user_id → { leadId, ts } of their newest "chat to check" alert (U4)
  const inflight = new Set();
  const say = (entry) => { try { log(entry); } catch { /* a logger never stops an alert */ } };

  /**
   * `created` says whether this endpoint is new (the INSERT ran) or was posted again (the
   * same device on every page load); `moved` that it was another member's until now (a
   * shared device signed in as someone else). The route logs those two, not every re-post.
   */
  function subscribe({ userId, sessionHash, endpoint, keys } = {}) {
    const url = pushEndpoint(endpoint);
    if (!url) return { ok: false, error: 'bad_endpoint' };
    const k = subscriptionKeys(keys);
    if (!k) return { ok: false, error: 'bad_keys' };
    if (typeof userId !== 'string' || !userId || typeof sessionHash !== 'string' || !sessionHash) return { ok: false, error: 'bad_request' };
    const t = now();
    return transaction(() => {
      if (!prep('SELECT 1 FROM auth_sessions WHERE token_hash = ? AND user_id = ? AND expires >= ?').get(sessionHash, userId, t)) return { ok: false, error: 'bad_request' };
      const prev = prep('SELECT user_id FROM push_subscriptions WHERE endpoint = ?').get(url) ?? null;
      const updated = prep(`UPDATE push_subscriptions SET user_id = ?, session_hash = ?, p256dh = ?, auth = ?, updated = ?, fail_count = 0
                            WHERE endpoint = ?`).run(userId, sessionHash, k.p256dh, k.auth, t, url).changes;
      if (!updated) {
        prep(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, session_hash, created, updated, last_ok, fail_count)
              VALUES (?,?,?,?,?,?,?,?,NULL,0)`).run(newId('PSH'), userId, url, k.p256dh, k.auth, sessionHash, t, t);
      }
      prep(`DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN
              (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY updated DESC, rowid DESC LIMIT ?)`)
        .run(userId, userId, MAX_DEVICES_PER_USER);
      return { ok: true, created: !updated, moved: Boolean(prev && prev.user_id !== userId) };
    });
  }

  function unsubscribe({ userId, endpoint } = {}) {
    const url = pushEndpoint(endpoint);
    if (!url || typeof userId !== 'string' || !userId) return false;
    return prep('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(url, userId).changes === 1;
  }

  const forgetSession = (sessionHash) => Number(prep('DELETE FROM push_subscriptions WHERE session_hash = ?').run(String(sessionHash ?? '')).changes);
  /** Sweeps every row whose session is NULL, gone, expired or another member's: none of those can ever push. */
  const pruneOrphans = () => Number(prep(`DELETE FROM push_subscriptions WHERE NOT EXISTS
      (SELECT 1 FROM auth_sessions a WHERE a.token_hash = push_subscriptions.session_hash AND a.user_id = push_subscriptions.user_id AND a.expires >= ?)`)
    .run(now()).changes);
  const countFor = (userId) => prep('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(String(userId ?? '')).n;

  function recipients(lead, { reason = 'inbound', exceptUserId = null } = {}) {
    const everyone = () => prep('SELECT user_id FROM users WHERE active = 1 ORDER BY user_id').all().map((r) => r.user_id);
    const owners = () => prep("SELECT user_id FROM users WHERE active = 1 AND role = 'owner' ORDER BY user_id").all().map((r) => r.user_id);
    let users;
    // A chat to check is in the Unsure list, which only the owners see (D9, U2).
    if (reason === 'check') users = owners();
    else if (reason === 'needs_human' || Number(lead?.needs_human) === 1) users = everyone();
    else if (lead?.handler_user_id && prep('SELECT 1 FROM users WHERE user_id = ? AND active = 1').get(lead.handler_user_id)) users = [lead.handler_user_id];
    else users = everyone();
    return users.filter((u) => u !== exceptUserId);
  }

  // A check is marked apart (U5: alert → Move within two minutes → the client's reply still alerts).
  const markKey = (userId, leadId, why = null) => (why === 'check' ? `check\n${userId}\n${leadId}` : `${userId}\n${leadId}`);
  function prune(t) {
    if (marks.size <= MARKS_MAX) return;
    for (const [k, at] of marks) if (t - at >= ALERT_EVERY_MS) marks.delete(k);
  }

  async function run(leadId, { reason, exceptUserId, ts }) {
    if (!pusher) return { skipped: 'off' };
    const why = REASONS.has(reason) ? reason : 'other';
    const t = now();
    if (ts != null && Number.isFinite(Number(ts)) && Number(ts) < t - ALERT_FRESH_MS) return { skipped: 'old' };
    const lead = db.getLead(leadId);
    if (why === 'check') {
      // A chat to check lives in the Unsure list (U1); once it joins or leaves, it is no check.
      if (!lead || lead.inbox_state !== 'unsure' || isExcludedLead(lead)) return { skipped: 'not_unsure' };
    } else if (!lead || lead.inbox_state !== 'in' || isExcludedLead(lead)) return { skipped: 'not_in_inbox' };
    // Nothing above the sends may await: the marks must be set before another notify for this chat runs.
    const due = recipients(lead, { reason: why, exceptUserId }).filter((u) => {
      const at = marks.get(markKey(u, leadId, why));
      return at === undefined || t - at >= ALERT_EVERY_MS;
    });
    if (!due.length) return { skipped: 'quiet' };
    const devices = prep(`SELECT s.id, s.user_id, s.endpoint FROM push_subscriptions s
        JOIN users u ON u.user_id = s.user_id AND u.active = 1
        JOIN auth_sessions a ON a.token_hash = s.session_hash AND a.user_id = s.user_id AND a.expires >= ?
        WHERE s.user_id IN (SELECT value FROM json_each(?))
        ORDER BY s.rowid`).all(t, JSON.stringify(due));
    if (!devices.length) return { skipped: 'no_devices' };
    // Every member due is marked, not only those a device was found for: the alert for this
    // burst is going out now, so a second message in the same two minutes is quiet for all of
    // them (a member who subscribes inside that window hears of the next burst).
    for (const u of due) marks.set(markKey(u, leadId, why), t);
    if (why === 'check') for (const u of due) checks.set(u, { leadId, ts: t });
    prune(t);
    const users = new Set(devices.map((d) => d.user_id));
    // A send that rejects after all is that device's failure, never the batch's.
    const answers = await Promise.all(devices.map(async (d) => ({
      d, a: await Promise.resolve().then(() => pusher.send(d.endpoint)).catch(() => ({ error: 'threw' })),
    })));
    // Each answer writes only to the row as it was when the push left (`updated <= t`): a device
    // re-posted during the send — by this member or, on a shared phone, by someone else — is a
    // new binding this answer says nothing about.
    let ok = 0;
    let gone = 0;
    let failed = 0;
    for (const { d, a } of answers) {
      if (a?.status >= 200 && a.status < 300) {
        ok += 1;
        prep('UPDATE push_subscriptions SET last_ok = ?, fail_count = 0 WHERE id = ? AND updated <= ?').run(now(), d.id, t);
      } else if (a?.status === 404 || a?.status === 410) {
        gone += 1;
        prep('DELETE FROM push_subscriptions WHERE id = ? AND updated <= ?').run(d.id, t);
      } else {
        failed += 1;
        prep('UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE id = ? AND updated <= ?').run(d.id, t);
        say({
          level: 'warn',
          evt: 'push.refused',
          ...(Number.isInteger(a?.status) ? { status: a.status } : { error: SEND_ERRORS.has(a?.error) ? a.error : 'unknown' }),
        });
      }
    }
    const out = { users: users.size, devices: devices.length, ok, gone, failed };
    say({ evt: 'push.sent', leadId, reason: why, ...out });
    return out;
  }

  /** The owner's newest "chat to check" alert, while that chat is still in the Unsure list (U4). */
  function pendingCheck(userId) {
    const id = String(userId ?? '');
    const c = checks.get(id);
    if (!c) return null;
    const lead = db.getLead(c.leadId);
    const owner = prep("SELECT 1 FROM users WHERE user_id = ? AND active = 1 AND role = 'owner'").get(id);
    if (!owner || !lead || lead.inbox_state !== 'unsure') { checks.delete(id); return null; }
    return { leadId: c.leadId, ts: c.ts };
  }

  /**
   * Pushes one alert about a chat to the members it is due for. Never rejects.
   * @returns {Promise<{ users: number, devices: number, ok: number, gone: number, failed: number }
   *   | { skipped: 'off' | 'old' | 'not_in_inbox' | 'not_unsure' | 'quiet' | 'no_devices' }
   *   | { error: 'failed' }>}
   */
  function notify(leadId, { reason = 'inbound', exceptUserId = null, ts = null } = {}) {
    const p = Promise.resolve()
      .then(() => run(String(leadId ?? ''), { reason, exceptUserId, ts }))
      .catch((err) => {
        // Only a plain error class name is logged: a message, or a name that is not one, could carry anything.
        say({ level: 'error', evt: 'push.failed', name: typeof err?.name === 'string' && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'Error' });
        return { error: 'failed' };
      });
    inflight.add(p);
    p.finally(() => inflight.delete(p));
    return p;
  }

  const flush = async () => { await Promise.allSettled([...inflight]); };

  return {
    configured: Boolean(pusher), publicKey: pusher?.publicKey ?? null,
    subscribe, unsubscribe, forgetSession, pruneOrphans, countFor, recipients, notify, pendingCheck, flush,
  };
}
