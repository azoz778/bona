/**
 * Who did what on the dashboard (2026-09-27 design §3.1). Append-only; never a code,
 * never message text. A write that fails to be audited is logged, not thrown: the
 * owner's action already happened, and refusing to show it would only hide it.
 * The inbox actions carry no text and no number either: a reply is audited with its
 * send status, a handler change with the user it went to.
 *
 * `inbox_move` and `inbox_out` also stand for the owner's real-estate chats to check (D17):
 * *Move to Bona inbox* is `inbox_move` with the candidate as `target` (`CND-…`) and the lead
 * it became as `meta.lead_id`; *Not a client* is `inbox_out` with the candidate as `target`.
 * On a lead both have the lead (`LEAD-…`) as `target`. So the id's prefix tells the two
 * apart, and a lead's whole history is its `target` rows plus `inbox_move` rows whose
 * `meta.lead_id` is that lead.
 */
import { newId } from './db.mjs';

export const AUDIT_ACTIONS = [
  'login', 'logout', 'code_request',
  'team_add', 'team_deactivate', 'team_reactivate', 'team_role',
  'never_add', 'never_remove', 'setting',
  'stage', 'note',
  'reply_sent', 'inbox_move', 'inbox_out', 'inbox_add', 'handler',
];

export function createAudit(store, { now = () => Date.now(), log = () => {} } = {}) {
  const insert = store.db.prepare('INSERT INTO audit_log (id, ts, user_id, action, target, meta) VALUES (?,?,?,?,?,?)');
  // Ties on `ts` (two actions in one millisecond, or an injected clock) fall back to
  // insertion order: `id` ends in random characters, so it cannot order them.
  const latest = store.db.prepare('SELECT * FROM audit_log ORDER BY ts DESC, rowid DESC LIMIT ?');

  function record({ userId = null, action, target = null, meta = null } = {}) {
    if (!AUDIT_ACTIONS.includes(action)) throw new TypeError(`unknown audit action: ${action}`);
    try {
      insert.run(newId('AUD'), now(), userId, action, target == null ? null : String(target), meta == null ? null : JSON.stringify(meta));
    } catch (err) {
      log({ level: 'error', evt: 'audit.failed', action, error: String(err?.message ?? err).slice(0, 200) });
    }
  }

  function recent(limit = 50) {
    return latest.all(Math.max(1, Math.min(500, Number(limit) || 50))).map((r) => {
      let meta = null;
      try { meta = r.meta ? JSON.parse(r.meta) : null; } catch { meta = null; }
      return { ...r, meta };
    });
  }

  return { record, recent };
}
