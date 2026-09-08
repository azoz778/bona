#!/usr/bin/env node
// One listing -> one 9:16 1080x1920 vertical reel, 12-25 s, SILENT.
//
//   node scripts/social/make-reel.mjs --listing BONA-001
//   node scripts/social/make-reel.mjs --listing rihab-villas --photos 6 --seconds 18
//
// ---------------------------------------------------------------------------------------
// NO MUSIC, ON PURPOSE. The file has no audio stream at all (`-an`).
//   * Licensing: a commercial real-estate ad cannot ride on a track we have no licence for,
//     and "found on TikTok" is not a licence. A muted rights claim on Instagram or a Content
//     ID claim on YouTube also kills the post's reach.
//   * Reach: Instagram, TikTok and Snapchat all favour their OWN in-app audio library, and
//     that library is licensed FOR you at post time. A reel that arrives silent lets the
//     poster pick a trending track inside the app, which is both legal and better ranked.
//   So: add audio in the app when you post. Every caption queue.mjs writes for a reel says so.
// ---------------------------------------------------------------------------------------
//
// How it is built, and why this way — every stage is its own short ffmpeg, never one big
// filtergraph, because `xfade` buffers its ENTIRE first input and a six-segment chain peaked
// at 2.3 GB on a 20 s reel (measured). This box is shared; a long-running ffmpeg is also the
// one that gets killed when load spikes.
//   1. sharp cover-crops each ranked photograph to a supersampled 9:16 still.
//   2. ONE ffmpeg per still turns it into a Ken Burns segment (zoompan) — same reasoning as
//      services/intake/lib/video.mjs, which runs one ffmpeg per extracted frame.
//   3. ONE ffmpeg per cross-fade, folding segments into an accumulator two at a time
//      (~1.4 GB peak, ~2 s each). The CTA card is the last segment.
//   4. ONE final ffmpeg overlays the text layers and writes the deliverable.
//
// ARABIC: every Arabic glyph in this file arrives as a pre-rendered transparent PNG from
// lib/brand.mjs (sharp -> Pango -> HarfBuzz). ffmpeg's drawtext is NEVER used for Arabic:
// it draws unjoined, un-reordered letterforms. See lib/fonts.mjs.
import './lib/fonts.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runTool } from '../../services/intake/lib/video.mjs';
import { REEL } from './lib/brand.mjs';
import { ctaCard, hookLayer, lowerThird, markLayer } from './lib/cards.mjs';
import { bestPhotos, coverToFile } from './lib/photos.mjs';
import { hookFor, loadListings, subhookFor } from './lib/listing.mjs';
import { FFMPEG, OUT_ROOT, ensureDir, findListing, log, requireFfmpeg } from './lib/util.mjs';

const { values: a } = parseArgs({
  options: {
    listing: { type: 'string' }, photos: { type: 'string', default: '5' },
    seconds: { type: 'string', default: '20' }, out: { type: 'string' },
    centre: { type: 'boolean', default: false }, 'keep-work': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});
if (a.help || !a.listing) {
  console.log('usage: make-reel.mjs --listing <ID|slug> [--photos 4..7] [--seconds 12..25] [--out file.mp4] [--centre] [--keep-work]');
  process.exit(a.help ? 0 : 1);
}

const W = REEL.w;
const H = REEL.h;
const FPS = 30;
/** Cross-fade between segments, seconds. */
const X = 0.6;
/** How long the closing CTA card holds. */
const CTA_SEC = 3.8;
/** Ken Burns source resolution. 2x the output: zoompan crops on integer input pixels, so
 *  supersampling halves the per-frame rounding step and the pan stops stepping. */
const SS = 2;
const MIN_TOTAL = 12;
const MAX_TOTAL = 25;
/** Generous: this box is shared, and a loaded box turns a 2 s encode into a 4 min one. */
const FF_TIMEOUT = 600000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const nPhotos = clamp(parseInt(a.photos, 10) || 5, 4, 7);
const target = clamp(parseFloat(a.seconds) || 20, MIN_TOTAL, MAX_TOTAL);

/** Ken Burns move per segment: alternate zoom direction and drift axis so it never loops. */
const MOVES = [
  { zoom: 'in', x: 'centre', y: 'centre' },
  { zoom: 'out', x: 'centre', y: 'down' },
  { zoom: 'in', x: 'right', y: 'centre' },
  { zoom: 'out', x: 'left', y: 'centre' },
  { zoom: 'in', x: 'centre', y: 'up' },
  { zoom: 'out', x: 'right', y: 'down' },
  { zoom: 'in', x: 'left', y: 'up' },
];

/**
 * zoompan expressions for one segment.
 * `on` is the output frame index inside this segment, so every expression is a pure
 * function of time — no dependence on the previous frame's zoom, which is what makes
 * zoompan drift and stutter.
 */
function kenBurns(move, frames, { amount = 0.16 } = {}) {
  const n = Math.max(1, frames - 1);
  const p = `(on/${n})`;
  const z = move.zoom === 'in'
    ? `min(${(1 + amount).toFixed(4)},1+${amount.toFixed(4)}*${p})`
    : `max(1,${(1 + amount).toFixed(4)}-${amount.toFixed(4)}*${p})`;
  const span = (dim) => `(i${dim}-i${dim}/zoom)`;
  const axis = (kind, dim) => (
    kind === 'centre' ? `${span(dim)}/2`
      : kind === 'right' || kind === 'down' ? `${span(dim)}*(0.15+0.7*${p})`
        : `${span(dim)}*(0.85-0.7*${p})`
  );
  return { z, x: axis(move.x, 'w'), y: axis(move.y, 'h') };
}

const listings = loadListings();
const l = findListing(listings, a.listing);
requireFfmpeg();

const photos = await bestPhotos(l, nPhotos);
if (photos.length < 3) {
  console.error(`${l.id}: only ${photos.length} usable photograph(s) — a reel needs at least 3. Skipping.`);
  process.exit(2);
}
log(`${l.id} — ${photos.length} photos (listing order, hero first)`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), `bona-reel-${l.id}-`));
const cleanup = () => { if (!a['keep-work']) fs.rmSync(work, { recursive: true, force: true }); };

try {
  // ---- 1. stills -------------------------------------------------------------------
  const position = a.centre ? 'centre' : 'attention';
  const stills = [];
  for (const [i, p] of photos.entries()) {
    const out = path.join(work, `bg-${String(i).padStart(2, '0')}.jpg`);
    await coverToFile(p.file, out, W * SS, H * SS, { position, quality: 94 });
    stills.push(out);
  }

  // ---- 2. text layers (Pango -> transparent PNG) ------------------------------------
  const hook = hookFor(l);
  const sub = subhookFor(l);
  const layerFiles = {
    mark: path.join(work, 'mark.png'),
    hook: path.join(work, 'hook.png'),
    lower: path.join(work, 'lower.png'),
    cta: path.join(work, 'cta.png'),
  };
  fs.writeFileSync(layerFiles.mark, await markLayer(W, H, { size: 42, top: 96 }));
  fs.writeFileSync(layerFiles.hook, await hookLayer(W, H, { ar: hook.ar, en: sub.en }, { top: 330 }));
  fs.writeFileSync(layerFiles.lower, await lowerThird(W, H, l));
  fs.writeFileSync(layerFiles.cta, await ctaCard(W, H, { l }));

  // ---- 3. timeline -----------------------------------------------------------------
  // total = nP*d - nP*X + CTA  =>  d = (total - CTA + nP*X) / nP
  const nP = stills.length;
  const d = clamp((target - CTA_SEC + nP * X) / nP, 2.6, 4.8);
  const durations = [...Array(nP).fill(d), CTA_SEC];
  const total = durations.reduce((s, v) => s + v, 0) - (durations.length - 1) * X;
  if (total < MIN_TOTAL || total > MAX_TOTAL) log(`warning: reel is ${total.toFixed(1)}s, outside ${MIN_TOTAL}-${MAX_TOTAL}s`);
  // T_k = running length of the chain after k+1 segments; transition k starts at T_k - X.
  const T = [];
  durations.reduce((acc, v, i) => { const t = acc + v - (i ? X : 0); T[i] = t; return t; }, 0);
  const ctaStart = T[nP - 1] - X; // the photo section is fully gone after this + X

  // ---- 4. one segment per still -----------------------------------------------------
  const segs = [];
  for (const [i, still] of stills.entries()) {
    const frames = Math.round(d * FPS);
    const kb = kenBurns(MOVES[i % MOVES.length], frames);
    const out = path.join(work, `seg-${String(i).padStart(2, '0')}.mp4`);
    const vf = [
      `scale=${W * SS}:${H * SS}:force_original_aspect_ratio=increase`,
      `crop=${W * SS}:${H * SS}`,
      `zoompan=z='${kb.z}':x='${kb.x}':y='${kb.y}':d=1:s=${W}x${H}:fps=${FPS}`,
      'setsar=1',
      'format=yuv420p',
    ].join(',');
    const { code, err } = await runTool(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-framerate', String(FPS), '-loop', '1', '-t', d.toFixed(3), '-i', still,
      '-vf', vf, '-frames:v', String(frames),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-an', out,
    ], { timeoutMs: FF_TIMEOUT });
    if (code !== 0) throw new Error(`ffmpeg segment ${i}: ${err.trim().slice(-400)}`);
    segs.push(out);
  }
  // The CTA card is a still, held: no motion, so the eye lands on the phone number.
  const ctaSeg = path.join(work, 'seg-cta.mp4');
  {
    const { code, err } = await runTool(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-framerate', String(FPS), '-loop', '1', '-t', CTA_SEC.toFixed(3), '-i', layerFiles.cta,
      '-vf', `scale=${W}:${H},setsar=1,format=yuv420p`, '-frames:v', String(Math.round(CTA_SEC * FPS)),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-an', ctaSeg,
    ], { timeoutMs: FF_TIMEOUT });
    if (code !== 0) throw new Error(`ffmpeg cta: ${err.trim().slice(-400)}`);
  }
  segs.push(ctaSeg);

  // ---- 5. cross-fade, two clips at a time ------------------------------------------
  // xfade buffers its ENTIRE first input. Chaining all six segments in one filtergraph
  // therefore peaks at ~2.3 GB on a 20 s reel (measured with /usr/bin/time); doing it
  // pairwise holds it to ~1.4 GB and — the part that actually matters on a shared box —
  // turns one long ffmpeg into several 2-second ones, so a spike in load costs a retry
  // rather than the whole reel. Intermediates are CRF 12, which is visually transparent,
  // so the repeated encodes do not accumulate anything you can see.
  //
  // acc after pass k has duration T[k], so the next transition starts at T[k] - X.
  let acc = segs[0];
  for (let k = 0; k + 1 < segs.length; k++) {
    const next = path.join(work, `mont-${String(k).padStart(2, '0')}.mp4`);
    const { code, err } = await runTool(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', acc, '-i', segs[k + 1],
      '-filter_complex',
      `[0:v]setpts=PTS-STARTPTS,fps=${FPS}[a];[1:v]setpts=PTS-STARTPTS,fps=${FPS}[b];`
      + `[a][b]xfade=transition=fade:duration=${X}:offset=${(T[k] - X).toFixed(3)}[v]`,
      '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12',
      '-pix_fmt', 'yuv420p', '-an', next,
    ], { timeoutMs: FF_TIMEOUT });
    if (code !== 0) throw new Error(`ffmpeg xfade ${k}: ${err.trim().slice(-400)}`);
    // Free the input we have just consumed; six 1080x1920 intermediates add up.
    if (acc !== segs[0]) fs.rmSync(acc, { force: true });
    acc = next;
  }

  // ---- 6. text overlays -------------------------------------------------------------
  // Overlay windows. The hook owns the opening (it must be up inside the first 1.5 s);
  // the lower third comes in once the eye has landed; both are gone before the CTA card.
  const hookIn = 0.30;
  const hookOut = Math.min(4.4, ctaStart - 0.5);
  const lowerIn = 1.90;
  const wins = [
    { file: layerFiles.mark, in: 0.0, out: ctaStart, fadeIn: 0.6, fadeOut: 0.5 },
    { file: layerFiles.hook, in: hookIn, out: hookOut, fadeIn: 0.45, fadeOut: 0.5 },
    { file: layerFiles.lower, in: lowerIn, out: ctaStart, fadeIn: 0.7, fadeOut: 0.5 },
  ];

  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', acc];
  for (const w of wins) args.push('-framerate', String(FPS), '-loop', '1', '-t', total.toFixed(3), '-i', w.file);

  const chain = [];
  let last = '0:v';
  wins.forEach((wdw, i) => {
    chain.push(
      `[${i + 1}:v]format=rgba,`
      + `fade=t=in:st=${wdw.in.toFixed(2)}:d=${wdw.fadeIn}:alpha=1,`
      + `fade=t=out:st=${Math.max(0, wdw.out - wdw.fadeOut).toFixed(2)}:d=${wdw.fadeOut}:alpha=1[ov${i}]`,
    );
    const next = i === wins.length - 1 ? 'vout' : `b${i}`;
    chain.push(`[${last}][ov${i}]overlay=0:0:eof_action=pass:enable='between(t,${wdw.in.toFixed(2)},${wdw.out.toFixed(2)})'[${next}]`);
    last = next;
  });

  const out = a.out ? path.resolve(a.out) : path.join(OUT_ROOT, 'reels', `reel-${l.id}.mp4`);
  ensureDir(path.dirname(out));
  // Write beside the destination and rename on success. ffmpeg writes its output in place,
  // so a timeout (SIGKILL) leaves a headerless, unplayable MP4 sitting at the final path —
  // and anything that decides "already rendered" by testing existence then skips it forever.
  // The first batch run produced four such files exactly this way.
  const partial = `${out}.part`;
  args.push(
    '-filter_complex', chain.join(';'),
    '-map', '[vout]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high', '-level', '4.1',
    '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-movflags', '+faststart',
    '-an',                                     // silent by design — see the header
    '-t', total.toFixed(3),
    '-f', 'mp4',            // the .part suffix hides the container from ffmpeg's guesser
    partial,
  );
  let code;
  let err;
  try {
    ({ code, err } = await runTool(FFMPEG, args, { timeoutMs: FF_TIMEOUT }));
  } catch (e) {
    fs.rmSync(partial, { force: true });
    throw e;
  }
  if (code !== 0) { fs.rmSync(partial, { force: true }); throw new Error(`ffmpeg overlay: ${err.trim().slice(-800)}`); }
  fs.renameSync(partial, out);

  const bytes = fs.statSync(out).size;
  log(`reel → ${out}  ${total.toFixed(1)}s  ${(bytes / 1e6).toFixed(1)} MB  (silent)`);
  console.log(out);
} finally {
  if (a['keep-work']) log(`work dir kept: ${work}`);
  cleanup();
}
