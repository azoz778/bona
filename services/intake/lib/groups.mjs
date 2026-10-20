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

/**
 * Of the groups discovery selected, only those whose history is already marked as seen
 * (= announced) may be polled. A group whose history seeding failed stays out until the
 * next scan seeds it; polling it would treat every old message as new.
 * @param {{id: string}[]} selected  @param {(jid: string) => boolean} isAnnounced
 */
export function pollableGroups(selected, isAnnounced) {
  return (selected ?? []).filter((g) => g && typeof g.id === 'string' && isAnnounced(g.id));
}

/**
 * When an unconditional discovery is still needed although discovery is switched off: nothing
 * is pollable (a configured group was never announced, or no group is configured). Slow on
 * purpose — every scan costs the personal number one metadata query per group it is in.
 */
export const NO_GROUP_RESCAN_MS = 30 * 60 * 1000;

/**
 * Is a group-discovery scan (`/group/fetchAllGroups`) due now?
 *
 * One fetchAllGroups is NOT one WhatsApp query. Baileys' groupFetchAllParticipating emits
 * `groups.update` for every group the number is in, and Evolution answers each of those with
 * `updateGroupMetadataCache` -> `groupMetadata`: one scan = one query per group (~60+ on the
 * owner's number). Scanning every 5 min was ~670 `rate-overlimit` errors an hour on the
 * PERSONAL WhatsApp (2026-10-05 / 2026-10-21) — ban risk. So:
 *   - scanMs > 0  -> scan at that cadence (the first loop scans at once, as before);
 *   - scanMs <= 0 -> discovery is OFF once every configured group is pollable; while nothing
 *                    is pollable, or a configured group still waits for its first discovery
 *                    (never announced, or its history seeding failed), it falls back to a slow
 *                    NO_GROUP_RESCAN_MS cadence (Codex review 2026-10-21).
 * @param {{now:number,lastScan:number,scanMs:number,pollable:number,waiting?:number}} p
 *   `waiting` = configured group jids not yet pollable (see `waitingConfigured`).
 */
export function scanDue({ now, lastScan, scanMs, pollable, waiting = 0 }) {
  if (scanMs > 0) return now - lastScan >= scanMs;
  if (pollable > 0 && !(waiting > 0)) return false;
  return !lastScan || now - lastScan >= NO_GROUP_RESCAN_MS;
}

/**
 * How many configured group jids are not among the polled groups yet.
 * @param {string[]} groupJids  @param {{id:string}[]} polled
 */
export function waitingConfigured(groupJids, polled) {
  const ids = new Set((polled ?? []).map((g) => g?.id));
  return new Set((groupJids ?? []).filter((j) => typeof j === 'string' && j.endsWith('@g.us') && !ids.has(j))).size;
}
