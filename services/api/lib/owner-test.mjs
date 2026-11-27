/**
 * The owner's test switch and the per-lead "auto mode" (DESIGN §2, §3.2). STUB (PR-F2b): it
 * keeps today's behaviour, which is "no test, no own-number rule, no auto mode", so every
 * caller that reads it behaves exactly as before. PR-A2 (lib/owner-test.mjs, task T07)
 * replaces this file with the real switch; the interface below is the seam it fills.
 *
 * The real module answers, per DESIGN §2:
 *   ownNumberOk()  = wa.ownNumberFrom === 'instance' && link.identityOk()
 *   active()       = the test switch (`owner_as_client`) is on, ownNumberOk, and the owner's
 *                    digits differ from the instance's
 *   autoMode(lead) = ownNumberOk && (owner_test lead ? active() : own_number lead ? true : own_inbox === '1')
 *   ownRuleFor(jids), ownerLid(), command(rec) (the `#dana …` owner commands), onSettingChanged(k, v)
 * Until then each answers the value that means "today": false, null, or nothing at all.
 *
 * Nothing here reads a number, a setting or the network.
 */

/**
 * @typedef {object} OwnerTest
 * @property {() => boolean} active            the owner's test switch is in force (stub: false)
 * @property {() => boolean} ownNumberOk       the instance is Bona's own number and its identity checked out (stub: false)
 * @property {(lead: object|null) => boolean} autoMode  the new semantics apply to this lead (stub: false)
 * @property {(jids: object) => boolean} ownRuleFor     a chat joins under the own-number rule (stub: false)
 * @property {() => string|null} ownerLid      the owner's own @lid, for the poller's team-lid exception (stub: null)
 * @property {(rec: object) => boolean} command  an owner `#dana …` command was consumed (stub: false, never one)
 * @property {(key: string, value: string) => void} onSettingChanged  a Team-page switch changed (stub: nothing)
 * @property {() => { rule: 'own'|'shared', ownerAsClient: boolean }} health  the /health `inbox` keys this module owns
 */

/**
 * @param {object} [deps]  what the real module will need (team, wa config, the link guard, notes, log); the stub reads none
 * @returns {OwnerTest}
 */
export function createOwnerTest(deps = {}) {
  void deps;
  return {
    active: () => false,
    ownNumberOk: () => false,
    autoMode: () => false,
    ownRuleFor: () => false,
    ownerLid: () => null,
    command: () => false,
    onSettingChanged: () => {},
    health: () => ({ rule: 'shared', ownerAsClient: false }),
  };
}
