/**
 * What a stored client message sets off (DESIGN §4.2 "Push policy", critic G1; PR-B2, task
 * T11). Before this file the poller's hook pushed the team's phones for EVERY client message
 * of an inbox chat, so once every chat is in the inbox the phones would buzz while the AI
 * assistant is answering. Now:
 *
 *   - the chat is in auto mode (lib/owner-test.mjs `autoMode(lead)`) AND the assistant will
 *     answer this message (lib/dana-wa.mjs `eligible(leadId, { ts })` is ok): no phone push,
 *     only the wake;
 *   - otherwise (a legacy chat, or the assistant switched off, a person answered lately, a cap,
 *     a lid-only chat, an old message, …): the phone push, then the wake, exactly as before
 *     (P3-9, P4-16);
 *   - a hand-over still pushes from lib/dana-wa.mjs itself (`alerts.notify(…, { reason:
 *     'needs_human' })`), untouched here, so a client the assistant could not help is never
 *     silent.
 * Legacy chats keep today's push because without auto mode the assistant works exactly as
 * today (DESIGN §2): before the go-live switch only the owner's test chat is in auto mode, and
 * after it every chat is. Built without `ownerTest` (index.mjs until PR-INT passes it), the
 * policy is today's hook for every chat.
 *
 * Both calls are fired, never awaited (`alerts.notify` never rejects; `dana.wake` only arms a
 * timer), so a slow push service or a slow model never slows the poller's tick. The check is
 * synchronous and reads only the store. A check that throws, or a Dana without one (a test
 * double), fails towards the push: a person hears of the message rather than nobody.
 */

/**
 * @typedef {object} PushPolicy
 * @property {(leadId: string, ts: number) => void} onClientMessage
 */

/**
 * @param {{ alerts: { notify: Function }, dana: { wake: Function, eligible?: Function },
 *           ownerTest?: { autoMode: Function }|null, log?: Function }} deps
 * @returns {PushPolicy}
 */
export function createPushPolicy({ alerts, dana, ownerTest = null, log = () => {} } = {}) {
  if (!alerts || typeof alerts.notify !== 'function') throw new TypeError('createPushPolicy needs the alerts');
  if (!dana || typeof dana.wake !== 'function') throw new TypeError('createPushPolicy needs Dana');

  /** Will the assistant answer this message of a chat in auto mode? Only an explicit yes to both counts. */
  function willAnswer(leadId, ts) {
    if (typeof dana.eligible !== 'function' || typeof ownerTest?.autoMode !== 'function') return false;
    try {
      const e = dana.eligible(leadId, { ts });
      return e?.ok === true && ownerTest.autoMode(e.lead ?? null) === true;
    } catch (err) {
      try { log({ level: 'warn', evt: 'push.policy_check_failed', error: err?.name ?? 'Error' }); } catch { /* the push goes on */ }
      return false;
    }
  }

  return {
    onClientMessage: (leadId, ts) => {
      if (!willAnswer(leadId, ts)) alerts.notify(leadId, { ts });
      dana.wake(leadId, ts);
    },
  };
}
