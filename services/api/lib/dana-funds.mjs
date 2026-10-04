/**
 * Retell's out-of-credit watch (2026-10-05 design R2).
 *
 * Dana's first real client got only the hand-over line because Retell answered 402 and
 * nobody knew why. lib/dana-wa.mjs now tells this watch about every Retell call it makes:
 * a 402 is `out()`, any call that works is `ok()`; no other status is about money.
 *
 * The state lives in `settings`, so it survives a restart:
 *
 *   - `retell_funds_out`: when Retell started refusing (ms), `''` while it is fine. Set on the
 *     first 402 of an outage, kept through the next ones, cleared by the next call that works.
 *   - `retell_funds_alerted`: when the owners were last pushed about it (ms). Never cleared:
 *     a balance that flaps cannot alert more than once every six hours.
 *
 * Clients are unchanged: the failed completion still becomes a hand-over. The owners' push is
 * the owner-wide `funds` alert (lib/alerts.mjs `notifyOwners`); the Team page shows a red banner
 * while the flag is set, and /health says `dana.fundsOut`.
 *
 * Nothing here logs a name, a number, a text or an endpoint. `out` and `ok` never throw: a
 * watch that breaks must never cost a client their answer or their hand-over.
 */

export const FUNDS_ALERT_EVERY_MS = 6 * 3_600_000;

/** A stored instant as a number, or null for `''`, absent, or anything that is not one. */
const instant = (v) => {
  const n = Number(v);
  return typeof v === 'string' && /^\d{1,16}$/.test(v) && n > 0 ? n : null;
};

/** Since when Retell has been refusing Dana for lack of credit (ms), or null while it is fine. */
export const fundsOutSince = (team) => instant(team.getSetting('retell_funds_out'));

/**
 * @param {object} o
 * @param {ReturnType<import('./team.mjs').createTeam>} o.team   getSetting / setSetting
 * @param {{ notifyOwners: Function }|null} [o.alerts]
 */
export function createFundsWatch({ team, alerts = null, now = () => Date.now(), log = () => {} } = {}) {
  if (!team || typeof team.getSetting !== 'function' || typeof team.setSetting !== 'function') throw new TypeError('createFundsWatch needs the team store (settings)');
  const say = (entry) => { try { log(entry); } catch { /* a logger never stops the watch */ } };
  const failed = (err) => say({ level: 'error', evt: 'dana.funds_failed', name: typeof err?.name === 'string' && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'Error' });

  /**
   * Retell said 402. The flag first (an outage starts once), then the owners — unless they
   * heard within six hours. Resolves when the push has been answered; never rejects.
   */
  function out() {
    try {
      const t = now();
      if (fundsOutSince(team) === null) {
        team.setSetting('retell_funds_out', String(t));
        say({ level: 'warn', evt: 'dana.funds_out' });
      }
      if (!alerts) return Promise.resolve(null);
      const last = instant(team.getSetting('retell_funds_alerted'));
      if (last !== null && t - last < FUNDS_ALERT_EVERY_MS) return Promise.resolve(null);
      // Stored before the push leaves: a second 402 during the send is quiet.
      team.setSetting('retell_funds_alerted', String(t));
      return Promise.resolve(alerts.notifyOwners({ reason: 'funds' })).catch((err) => { failed(err); return null; });
    } catch (err) {
      failed(err);
      return Promise.resolve(null);
    }
  }

  /** A Retell call worked: the outage, if any, is over. The alert time stays. */
  function ok() {
    try {
      if (fundsOutSince(team) === null) return;
      team.setSetting('retell_funds_out', '');
      say({ evt: 'dana.funds_ok' });
    } catch (err) {
      failed(err);
    }
  }

  function status() {
    try {
      return { out: fundsOutSince(team), alerted: instant(team.getSetting('retell_funds_alerted')) };
    } catch {
      return { out: null, alerted: null };
    }
  }

  return { out, ok, status };
}
