// A walkthrough video on a listing: what is committed, and how it is made.
//
// Until 2026-09-06 the file was stored EXACTLY as WhatsApp sent it — no transcode, no
// thumbnail — because sharp, this service's only media library, does not read video. It now
// goes through the static ffmpeg at `cfg.ffmpegBin` (~/.local/bin/ffmpeg), because storing a
// phone clip verbatim in a git repo is a decision that cannot be taken back:
//
//   * H.264 + AAC in MP4, `-movflags +faststart` so the browser can start playing before the
//     file has finished arriving;
//   * capped at 1080p (long side <= 1920, short side <= 1080, aspect kept), so a 4K clip does
//     not go into the repo at 4K;
//   * re-encoded a second time, smaller, if the first pass misses `cfg.maxVideoMb`, and
//     SKIPPED rather than committed if it still does not fit;
//   * a poster frame beside it, so the listing page shows the property instead of a black
//     rectangle before the viewer presses play.
//
// Everything here spawns with an argv ARRAY and streams to files in the work dir. The video
// itself is never read into a Buffer: the daemon runs in a 2 GB cgroup and a clip can be
// 200 MB.
//
// Numbered on their OWN sequence, separate from the photos (`NN.jpg`), so adding or removing
// a video never renumbers or collides with a listing's photos:
//   public/listings/<slug>/v-NN.mp4          the clip
//   public/listings/<slug>/v-NN-poster.jpg   its poster frame
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

/** A listing may carry at most this many videos — plenty for a walkthrough + a few room clips. */
export const MAX_VIDEOS = 4;

/** The stored clip: long side <= 1920 AND short side <= 1080, whichever binds first. */
export const MAX_LONG_SIDE = 1920;
export const MAX_SHORT_SIDE = 1080;
/** The second, smaller pass, used only when the first misses the size cap. */
export const RETRY_LONG_SIDE = 1280;
export const RETRY_SHORT_SIDE = 720;
export const CRF = 26;
export const RETRY_CRF = 31;
export const AUDIO_KBPS = 128;
/** The poster frame: long side in pixels, and how far into the clip it is taken from. */
export const POSTER_LONG_SIDE = 1600;
export const POSTER_AT_SEC = 1;
/** Frames handed to the content matcher, and their long side. */
export const MATCH_FRAME_LONG_SIDE = 900;

const pad = (n) => String(n).padStart(2, '0');

/** The site-local paths a video and its poster are served from — the shapes checkListing()/validate.mjs expect. */
export const videoSrcFor = (slug, n) => `/listings/${slug}/v-${pad(n)}.mp4`;
export const videoPosterFor = (slug, n) => `/listings/${slug}/v-${pad(n)}-poster.jpg`;

/** Spawn with an argv array (never a shell), kill on timeout, collect stdout/stderr. */
export function runTool(bin, args, { timeoutMs = 600000, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { reject(e); return; }
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${path.basename(bin)} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    // ffmpeg is chatty on stderr; keep only the tail so a failure message never grows unbounded.
    child.stdout?.on('data', (d) => { out += d; if (out.length > 65536) out = out.slice(-65536); });
    child.stderr?.on('data', (d) => { err += d; if (err.length > 65536) err = err.slice(-65536); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

// ---- pure argv builders (tested on their own — nothing here touches the disk) -------------

/** ffprobe argv for one file: the first video stream's size, and the container duration. */
export const probeArgs = (input) => [
  '-v', 'error',
  '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height:format=duration',
  '-of', 'json',
  input,
];

/** ffprobe's JSON -> {width, height, durationSec}; anything unreadable comes back as null. */
export function parseProbe(stdout) {
  let j;
  try { j = JSON.parse(String(stdout || '')); } catch { return null; }
  const st = Array.isArray(j?.streams) ? j.streams[0] : null;
  const width = Number(st?.width);
  const height = Number(st?.height);
  const durationSec = Number(j?.format?.duration);
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height, durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null };
}

/**
 * The stored size for a clip: aspect kept, long side <= maxLong, short side <= maxShort,
 * never enlarged, both sides even (H.264 4:2:0 needs it).
 */
export function scaleTarget({ width, height }, { maxLong = MAX_LONG_SIDE, maxShort = MAX_SHORT_SIDE } = {}) {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0) || !(h > 0)) return null;
  const factor = Math.min(1, maxLong / Math.max(w, h), maxShort / Math.min(w, h));
  const even = (n) => Math.max(2, Math.round(n * factor / 2) * 2);
  return { width: even(w), height: even(h) };
}

/** ffmpeg argv for the stored clip. */
export const transcodeArgs = ({ input, output, width, height, crf = CRF, audioKbps = AUDIO_KBPS }) => [
  '-nostdin', '-v', 'error', '-y',
  '-i', input,
  '-map', '0:v:0', '-map', '0:a:0?',
  '-vf', `scale=${width}:${height}:flags=bicubic`,
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf),
  '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.0',
  '-c:a', 'aac', '-b:a', `${audioKbps}k`, '-ac', '2',
  // The moov atom in front: without it a browser must download the whole file before the
  // first frame, which on a 25 MB walkthrough is the difference between playing and not.
  '-movflags', '+faststart',
  output,
];

/** ffmpeg argv for ONE frame at `at` seconds. `-ss` before `-i` seeks instead of decoding. */
export const frameArgs = ({ input, output, at = 0, longSide = MATCH_FRAME_LONG_SIDE }) => [
  '-nostdin', '-v', 'error', '-y',
  ...(at > 0 ? ['-ss', at.toFixed(3)] : []),
  '-i', input,
  '-frames:v', '1',
  '-vf', `scale=${longSide}:${longSide}:force_original_aspect_ratio=decrease`,
  '-q:v', '3',
  output,
];

/**
 * `count` evenly spaced sample points inside a clip, at the MIDDLE of each equal slice — so
 * neither the first black frame nor the trailing fade is what the matcher is shown.
 * A clip whose duration ffprobe could not read is sampled once, at the start.
 */
export function frameTimes(durationSec, count = 4) {
  const n = Math.max(1, Math.min(8, Math.round(count)));
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [0];
  return Array.from({ length: n }, (_, i) => Number((durationSec * ((i + 0.5) / n)).toFixed(3)));
}

/** The poster is taken a moment in, never from frame 0 (which is often black or a fade-in). */
export const posterTime = (durationSec) => (Number.isFinite(durationSec) && durationSec > 0
  ? Math.min(POSTER_AT_SEC, durationSec / 2)
  : 0);

// ---- the steps themselves -----------------------------------------------------------------

/**
 * 3-4 evenly spaced frames of a clip, as files in `outDir`. One ffmpeg per frame, each one
 * seeking straight to its timestamp: the clip is never decoded end to end and never held in
 * memory. A frame ffmpeg could not produce is skipped, not fatal.
 * @returns {Promise<Array<{n:number, at:number, abs:string, width:number, height:number}>>}
 */
export async function extractFrames(input, outDir, {
  count = 4, durationSec = null, ffmpegBin, timeoutMs, longSide = MATCH_FRAME_LONG_SIDE, run = runTool,
} = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const frames = [];
  for (const [i, at] of frameTimes(durationSec, count).entries()) {
    const abs = path.join(outDir, `f${pad(i + 1)}.jpg`);
    try {
      const { code } = await run(ffmpegBin, frameArgs({ input, output: abs, at, longSide }), { timeoutMs });
      if (code !== 0 || !fs.existsSync(abs) || fs.statSync(abs).size === 0) { fs.rmSync(abs, { force: true }); continue; }
      const meta = await sharp(abs).metadata();
      frames.push({ n: i + 1, at, abs, width: meta.width ?? 0, height: meta.height ?? 0 });
    } catch {
      fs.rmSync(abs, { force: true });
    }
  }
  return frames;
}

/** ffprobe one file. Returns null when it cannot be read (a caller must cope). */
export async function probeVideo(input, { ffprobeBin, timeoutMs = 60000, run = runTool } = {}) {
  try {
    const { code, out } = await run(ffprobeBin, probeArgs(input), { timeoutMs });
    if (code !== 0) return null;
    return parseProbe(out);
  } catch {
    return null;
  }
}

/**
 * The clip as it will be committed: transcode, check the size, transcode once more smaller if
 * it missed, write the poster frame beside it.
 *
 * Nothing is returned as bytes — the caller gets paths, and `edits.addVideo()` hashes and
 * copies the FILE. The whole point is that a 200 MB download never becomes a 200 MB Buffer.
 *
 * @returns {Promise<{ok:true, file:string, poster:string|null, bytes:number, width:number,
 *                    height:number, durationSec:number|null, passes:Array<object>}
 *                 | {ok:false, reason:'too-large'|'ffmpeg', bytes?:number, error?:string, passes?:Array<object>}>}
 */
export async function prepareVideo({ input, outDir, cfg, run = runTool, logger = null }) {
  fs.mkdirSync(outDir, { recursive: true });
  const maxBytes = Math.max(1, cfg.maxVideoMb) * 1024 * 1024;
  const probe = await probeVideo(input, { ffprobeBin: cfg.ffprobeBin, run });
  // ffprobe could not read it: still try, at the full-size cap, from the source's own frame
  // size — ffmpeg will fail loudly if the file is not a video at all.
  const source = probe || { width: MAX_LONG_SIDE, height: MAX_SHORT_SIDE, durationSec: null };

  const attempts = [
    { maxLong: MAX_LONG_SIDE, maxShort: MAX_SHORT_SIDE, crf: CRF },
    { maxLong: RETRY_LONG_SIDE, maxShort: RETRY_SHORT_SIDE, crf: RETRY_CRF },
  ];
  const file = path.join(outDir, 'clip.mp4');
  const passes = [];
  let bytes = 0;
  for (const [i, a] of attempts.entries()) {
    const target = scaleTarget(source, a) || { width: MAX_LONG_SIDE, height: MAX_SHORT_SIDE };
    const { code, err } = await run(
      cfg.ffmpegBin,
      transcodeArgs({ input, output: file, width: target.width, height: target.height, crf: a.crf }),
      { timeoutMs: cfg.ffmpegTimeoutMs },
    );
    if (code !== 0 || !fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      return { ok: false, reason: 'ffmpeg', error: (err || `ffmpeg exited ${code}`).trim().slice(-300), passes };
    }
    bytes = fs.statSync(file).size;
    passes.push({ pass: i + 1, ...target, crf: a.crf, bytes });
    logger?.info?.('video.transcoded', { pass: i + 1, width: target.width, height: target.height, crf: a.crf, bytes });
    if (bytes <= maxBytes) {
      const poster = await writePoster(file, path.join(outDir, 'poster.jpg'), {
        ffmpegBin: cfg.ffmpegBin, timeoutMs: cfg.ffmpegTimeoutMs, durationSec: source.durationSec, run,
      });
      return { ok: true, file, poster, bytes, width: target.width, height: target.height, durationSec: source.durationSec, passes };
    }
  }
  // Two passes and it still does not fit: better a reply asking for a shorter clip than a
  // permanent entry in the repo's history.
  fs.rmSync(file, { force: true });
  return { ok: false, reason: 'too-large', bytes, passes };
}

/**
 * One frame of `input`, resized by sharp to POSTER_LONG_SIDE and written to `out`.
 * Returns the path, or null when no frame could be had — a listing without a poster still
 * plays, it just shows the hero photo instead.
 */
export async function writePoster(input, out, { ffmpegBin, timeoutMs, durationSec = null, longSide = POSTER_LONG_SIDE, run = runTool } = {}) {
  const raw = `${out}.frame.jpg`;
  try {
    const { code } = await run(ffmpegBin, frameArgs({ input, output: raw, at: posterTime(durationSec), longSide: 3840 }), { timeoutMs });
    if (code !== 0 || !fs.existsSync(raw)) return null;
    await sharp(raw)
      .resize({ width: longSide, height: longSide, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toFile(out);
    return out;
  } catch {
    return null;
  } finally {
    fs.rmSync(raw, { force: true });
  }
}

/**
 * Put ONE prepared clip (and its poster) into public/listings/<slug>/, next in line after
 * whatever the listing already has. Files are COPIED, never read into memory.
 * @param {{file:string, poster?:string|null}} media  prepareVideo() output
 * @param {string} outDir            public/listings/<slug>
 * @param {string} slug
 * @param {number} existingCount     listing.videos?.length ?? 0 — the caller already knows this
 * @returns {{n:number, src:string, poster:string|null, file:string, posterFile:string|null, bytes:number}}
 */
export function writeListingVideo(media, outDir, slug, existingCount = 0) {
  if (existingCount >= MAX_VIDEOS) {
    throw new Error(`a listing may carry at most ${MAX_VIDEOS} videos`);
  }
  const src = typeof media === 'string' ? { file: media } : (media || {});
  if (!src.file || !fs.existsSync(src.file)) throw new Error('no prepared video file to write');
  fs.mkdirSync(outDir, { recursive: true });
  const n = existingCount + 1;
  const file = path.join(outDir, `v-${pad(n)}.mp4`);
  fs.copyFileSync(src.file, file);
  let posterFile = null;
  if (src.poster && fs.existsSync(src.poster)) {
    posterFile = path.join(outDir, `v-${pad(n)}-poster.jpg`);
    fs.copyFileSync(src.poster, posterFile);
  }
  return {
    n,
    src: videoSrcFor(slug, n),
    poster: posterFile ? videoPosterFor(slug, n) : null,
    file,
    posterFile,
    bytes: fs.statSync(file).size,
  };
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
