/**
 * What a stored client message sets off (DESIGN §7, PR-B2). STUB (PR-F2b): exactly today's
 * index.mjs poller hook, moved here: a phone alert for the owners (P3-9) and a wake for Dana
 * (P4-16), both fired, never awaited (`alerts.notify` never rejects; `dana.wake` only arms a
 * timer), so a slow push service or a slow model never slows the poller's tick. PR-B2 (task
 * T11) replaces this file (no push while Dana is answering the chat); the interface below is
 * the seam it fills.
 */

/**
 * @typedef {object} PushPolicy
 * @property {(leadId: string, ts: number) => void} onClientMessage
 */

/**
 * @param {{ alerts: { notify: Function }, dana: { wake: Function } }} deps
 * @returns {PushPolicy}
 */
export function createPushPolicy({ alerts, dana } = {}) {
  if (!alerts || typeof alerts.notify !== 'function') throw new TypeError('createPushPolicy needs the alerts');
  if (!dana || typeof dana.wake !== 'function') throw new TypeError('createPushPolicy needs Dana');
  return {
    onClientMessage: (leadId, ts) => { alerts.notify(leadId, { ts }); dana.wake(leadId, ts); },
  };
}
