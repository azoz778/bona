// Video attachments for a listing. Stored EXACTLY as WhatsApp sent them — no transcoding, no
// thumbnail: sharp (this service's only media library, see images.mjs) does not read video,
// and pulling in ffmpeg for one narrow feature is exactly the "materially larger
// architecture change" this fix is deliberately not making. See services/intake/README.md
// for the follow-up this leaves open (repo size; a real CDN upload path).
//
// Numbered on their OWN sequence, separate from the photos (`NN.jpg`), so adding or removing
// a video never renumbers or collides with a listing's photos:
//   public/listings/<slug>/v-NN.mp4
import fs from 'node:fs';
import path from 'node:path';

/** A listing may carry at most this many videos — plenty for a walkthrough + a few room clips. */
export const MAX_VIDEOS = 4;

const pad = (n) => String(n).padStart(2, '0');

/** The site-local path a video is served from — the same shape checkListing()/validate.mjs expect. */
export const videoSrcFor = (slug, n) => `/listings/${slug}/v-${pad(n)}.mp4`;

/**
 * Write ONE video buffer into public/listings/<slug>/, next in line after whatever the
 * listing already has.
 * @param {Buffer} buffer            the downloaded video, unmodified
 * @param {string} outDir            public/listings/<slug>
 * @param {string} slug
 * @param {number} existingCount     listing.videos?.length ?? 0 — the caller already knows this
 * @returns {{n:number, src:string, file:string, bytes:number}}
 */
export function writeListingVideo(buffer, outDir, slug, existingCount = 0) {
  if (existingCount >= MAX_VIDEOS) {
    throw new Error(`a listing may carry at most ${MAX_VIDEOS} videos`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const n = existingCount + 1;
  const file = path.join(outDir, `v-${pad(n)}.mp4`);
  fs.writeFileSync(file, buffer);
  return { n, src: videoSrcFor(slug, n), file, bytes: buffer.length };
}

// ---- which listing does a captionless clip belong to? ------------------------------------
//
// The owner does not caption videos. He drops the brochure and its clips in one burst —
// 2026-09-06, group "PDF Bona": the Knightsbridge PDF at 14:14:07, four mp4 clips at
// 14:14:19, four unrelated brochures at 14:16:06. The clips belong to the brochure sent
// twelve seconds before them, not to the ones two minutes after. So: nearest PDF in time.

/** A clip belongs to a brochure sent within this many seconds of it, either way round. */
export const MATCH_WINDOW_SEC = 15 * 60;
/** Two different listings this close to the clip (and to each other) are a tie: ask, never guess. */
export const MATCH_TIE_SEC = 60;

/** Send time of a job in unix seconds: `ts` (the WhatsApp timestamp) or, for records written before `ts` existed, `at`. */
const jobTs = (j) => {
  const ts = Number(j?.ts);
  if (Number.isFinite(ts) && ts > 0) return ts;
  const at = j?.at ? Date.parse(j.at) : NaN;
  return Number.isFinite(at) ? Math.round(at / 1000) : NaN;
};

/**
 * @param {{ts:number, jid:string}} video          the clip's send time (unix seconds) and group
 * @param {object[]} jobs                           every job record in the state file (state.raw.jobs values)
 * @param {(messageId:string)=>({id:string}|null)} publishedBy   state.publishedByMessage — which listing a PDF message published
 * @param {{windowSec?:number, tieSec?:number}} [opts]
 * @returns {{kind:'attach', listingId:string, pdfMessageId:string, deltaSec:number}
 *         | {kind:'wait', pdfMessageId:string}
 *         | {kind:'ambiguous', listingIds:string[]}
 *         | {kind:'none'}}
 */
export function pickListingForVideo(video, jobs, publishedBy, { windowSec = MATCH_WINDOW_SEC, tieSec = MATCH_TIE_SEC } = {}) {
  const ts = Number(video?.ts);
  if (!Number.isFinite(ts) || ts <= 0) return { kind: 'none' };
  const near = [];
  for (const j of jobs || []) {
    if (!j || j.jid !== video.jid || j.kind === 'video') continue;
    // A rejected, dry-run or failed brochure produced no listing to attach to.
    if (j.status !== 'pending' && j.status !== 'done') continue;
    const t = jobTs(j);
    if (!Number.isFinite(t)) continue;
    const delta = Math.abs(t - ts);
    if (delta <= windowSec) near.push({ job: j, delta });
  }
  if (!near.length) return { kind: 'none' };
  near.sort((a, b) => a.delta - b.delta);
  // The nearest brochure is still being published — or one close enough to tie with the
  // nearest is. Its listing id does not exist yet; come back when it has answered.
  const pending = near.find((n) => n.job.status === 'pending' && n.delta - near[0].delta <= tieSec);
  if (pending) return { kind: 'wait', pdfMessageId: pending.job.id };
  const resolved = [];
  for (const n of near) {
    const p = publishedBy(n.job.id);
    if (p?.id) resolved.push({ ...n, listingId: p.id });
  }
  if (!resolved.length) return { kind: 'none' };
  const best = resolved[0];
  const rivals = resolved.filter((r) => r.listingId !== best.listingId && r.delta - best.delta <= tieSec);
  if (rivals.length) return { kind: 'ambiguous', listingIds: [best.listingId, ...new Set(rivals.map((r) => r.listingId))] };
  return { kind: 'attach', listingId: best.listingId, pdfMessageId: best.job.id, deltaSec: best.delta };
}

/**
 * Should a parked clip (a pending video job carrying `waitSince`) go back in the queue?
 * Decided here, not in index.mjs, so the loop it must avoid is testable: a clip parked with
 * nothing to wait on wakes ONCE per new brochure job — `wakeSeen` is the ids of the brochure
 * jobs it has already been woken for — never every poll for the same rejected PDF until it
 * expires, and never missing one because two jobs share a timestamp (Codex review,
 * 2026-09-06: ids, not a timestamp cursor).
 * @param {object} job                  the parked video job
 * @param {object[]} jobs               every job record (state.raw.jobs values)
 * @param {{now?:number, waitMs:number}} opts
 * @returns {{wake:boolean, reason:string, seen?:string[]}}  `seen` = the new wakeSeen to persist
 */
export function wakeParkedClip(job, jobs, { now = Date.now(), waitMs } = {}) {
  if (!job?.waitSince) return { wake: false, reason: 'not-parked' };
  if (now - Date.parse(job.waitSince) > waitMs) return { wake: true, reason: 'expired' };
  if (job.waitingFor) {
    const target = (jobs || []).find((j) => j?.id === job.waitingFor);
    if (target && target.status === 'pending') return { wake: false, reason: 'brochure-still-publishing' };
    return { wake: true, reason: target ? `brochure-${target.status}` : 'brochure-gone' };
  }
  // Brochure jobs that appeared since the clip was parked (inclusive: same-millisecond `at`
  // counts) and have not woken it before.
  const seen = new Set(job.wakeSeen || []);
  const fresh = (jobs || []).filter((j) => j?.id && j.kind !== 'video' && j.jid === job.jid && !seen.has(j.id) && String(j.at) >= job.waitSince);
  if (!fresh.length) return { wake: false, reason: 'nothing-new' };
  return { wake: true, reason: 'new-brochure', seen: [...seen, ...fresh.map((j) => j.id)] };
}
