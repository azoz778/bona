/**
 * The groups the daemon polls when WhatsApp will not tell it which groups exist.
 *
 * `discoverGroups()` asks Evolution for every group the number is in and keeps the ones the
 * owner created or configured. WhatsApp throttles that group-metadata query ("rate-overlimit",
 * surfaced by Evolution as an HTTP 500) — sometimes for hours. Before 2026-09-08 a restart
 * during such a throttle left the daemon with an empty group list and it polled nothing until
 * the throttle cleared, while retrying the throttled call every poll and keeping it tripped.
 *
 * A jid the owner wrote into BONA_WA_GROUP_JIDS is trusted by definition, so it can be polled
 * before discovery ever succeeds — but only a group that was already announced (seen once by a
 * successful discovery) is seeded: a never-seen group must still go through discovery's
 * "everything already in it is history" step, or an old brochure would publish on restart.
 */

/** @param {string[]} groupJids  @param {(jid: string) => boolean} isAnnounced */
export function seedGroups(groupJids, isAnnounced) {
  const out = [];
  for (const jid of groupJids ?? []) {
    if (typeof jid !== 'string' || !jid.endsWith('@g.us')) continue;
    if (!isAnnounced(jid)) continue;
    if (out.some((g) => g.id === jid)) continue;
    out.push({ id: jid, subject: '(configured)', owner: null, seeded: true });
  }
  return out;
}
