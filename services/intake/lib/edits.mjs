// The `remove | hero | price | sold | hide | brochure` commands, applied to an inbox
// listing. File edits — the caller rebuilds, commits and replies.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { brochureFileIn, brochureUrlFor, buildBrandedBrochure, findSourcePdf } from './brochure.mjs';
import { WARNING_CODES, findInbox } from './listing.mjs';
import { removeListingImages } from './images.mjs';
import { MAX_VIDEOS, writeListingVideo } from './video.mjs';

/** @returns {{listing:object,file:string}|null} */
export function locate(repo, id) {
  return findInbox(repo, id);
}

function save(file, listing) {
  fs.writeFileSync(file, `${JSON.stringify(listing, null, 2)}\n`);
  return listing;
}

export function removeListing(repo, id) {
  const found = findInbox(repo, id);
  if (!found) return null;
  fs.rmSync(found.file, { force: true });
  removeListingImages(path.join(repo, 'public'), found.listing.slug);
  return found.listing;
}

/**
 * Promote the nth photo (1-based, as the owner sees them on the page) to the cover.
 * The array order IS the display order, so this is a move — the files keep their names.
 */
export function setHero(repo, id, n) {
  const found = findInbox(repo, id);
  if (!found) return null;
  const images = found.listing.images;
  if (!Number.isInteger(n) || n < 1 || n > images.length) {
    return { error: `photo ${n} does not exist — this listing has ${images.length}` };
  }
  const [moved] = images.splice(n - 1, 1);
  images.unshift(moved);
  const order = found.listing._intake?.images;
  if (Array.isArray(order) && order.length === images.length) {
    const [m] = order.splice(n - 1, 1);
    order.unshift(m);
  }
  return { listing: save(found.file, found.listing) };
}

export function setPrice(repo, id, { amount, currency, onRequest }) {
  const found = findInbox(repo, id);
  if (!found) return null;
  const p = found.listing.price;
  if (onRequest) { p.onRequest = true; p.amount = null; p.from = false; }
  else { p.onRequest = false; p.amount = amount; if (currency) p.currency = currency; }
  return { listing: save(found.file, found.listing) };
}

export function setStatus(repo, id, status) {
  const found = findInbox(repo, id);
  if (!found) return null;
  if (!['available', 'reserved', 'sold'].includes(status)) return { error: `unknown status "${status}"` };
  found.listing.status = status;
  return { listing: save(found.file, found.listing) };
}

export function setHidden(repo, id, hidden) {
  const found = findInbox(repo, id);
  if (!found) return null;
  found.listing.hidden = Boolean(hidden);
  return { listing: save(found.file, found.listing) };
}

/**
 * sha256 of a file, read a megabyte at a time. The stored clip is up to 25 MB and the daemon
 * lives in a 2 GB cgroup next to a `claude` process: nothing here reads a video into a Buffer.
 */
export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** The src of a video entry, whichever shape the listing carries it in. */
export const videoSrc = (v) => (typeof v === 'string' ? v : v?.src ?? '');

/**
 * Append one walkthrough video to an already-published listing — named by the owner
 * (`video <id>`), matched to its brochure by the burst rule, or recognised from its own
 * frames by lib/video-match.mjs. The clip has already been transcoded and given a poster
 * frame (lib/video.mjs `prepareVideo`); this copies both into the same
 * public/listings/<slug> directory the photos live in, and `remove <id>` already deletes
 * that whole directory, so a removed listing's videos go with it for free.
 *
 * The dedupe is on the STORED bytes — the transcoded file, not the download — because that
 * is what a replay would write a second time: ffmpeg is deterministic for a given input and
 * settings, so the same clip re-processed hashes the same. Identical bytes already on the
 * listing (a replay after a crash between the push and the job's close, or the owner sending
 * the same clip twice) come back as `duplicate` with the copy that is already there; nothing
 * is written, so nothing gets committed twice. This is the clip's counterpart of the PDF
 * sha256 guard in state.mjs.
 *
 * @param {{file:string, poster?:string|null}} media  what prepareVideo() produced
 * @returns {{listing:object,video:object,duplicate?:true}|{error:string}|null}
 */
export function addVideo(repo, id, media) {
  const found = findInbox(repo, id);
  if (!found) return null;
  const { listing } = found;
  const source = typeof media === 'string' ? { file: media } : (media || {});
  if (!source.file || !fs.existsSync(source.file)) return { error: `the prepared video for ${id} is not on disk any more — send the clip again.` };
  const existing = Array.isArray(listing.videos) ? listing.videos : [];
  const incoming = sha256File(source.file);
  const incomingBytes = fs.statSync(source.file).size;
  for (const [i, entry] of existing.entries()) {
    const src = videoSrc(entry);
    if (!src.startsWith('/')) continue;                       // a remote URL has no local bytes to compare
    const file = path.join(repo, 'public', src);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (st.size !== incomingBytes) continue;
    if (sha256File(file) === incoming) {
      return { listing, video: { n: i + 1, src, poster: typeof entry === 'string' ? null : entry?.poster ?? null, file, bytes: st.size }, duplicate: true };
    }
  }
  if (existing.length >= MAX_VIDEOS) {
    return { error: `${id} already has ${existing.length} video(s) — the limit is ${MAX_VIDEOS}.` };
  }
  const outDir = path.join(repo, 'public', 'listings', listing.slug);
  const written = writeListingVideo(source, outDir, listing.slug, existing.length);
  listing.videos = [...existing, { src: written.src, poster: written.poster }];
  return { listing: save(found.file, listing), video: written };
}

/**
 * `brochure <id>` — rebuild the Bona-branded PDF for a listing that is already live, from
 * the developer's original still sitting in `$BONA_DATA/intake/…`.
 *
 * The original is found by CONTENT HASH (`_intake.pdfSha256`), not by a path in the state
 * file: a listing published by `run-once.mjs` never wrote a state record, and a state file
 * can be lost, while the repo always remembers the sha of the PDF it came from.
 *
 * This is the command to reach for after `price` or a title fix — the brochure prints those
 * facts on its cover, so it goes stale when they change.
 *
 * @returns {Promise<{listing:object,brochure:object}|{error:string}|null>}
 */
export async function rebuildBrochure(repo, id, { cfg, workDir } = {}) {
  const found = findInbox(repo, id);
  if (!found) return null;
  const { listing } = found;
  const sha = listing?._intake?.pdfSha256;
  const source = findSourcePdf(cfg?.intakeDir, sha);
  if (!source) {
    return { error: `the original PDF for ${id} is not in ${cfg?.data ?? 'the data dir'} any more — send the brochure again to replace the listing` };
  }
  const outDir = path.join(repo, 'public', 'listings', listing.slug);
  const built = await buildBrandedBrochure({
    pdfPath: source, listing, outPath: brochureFileIn(outDir), workDir, cfg,
  });
  if (!built.ok) {
    return { error: built.reason === 'too-large' ? built.error : `the branded brochure could not be built for ${id} — the reason is in the journal` };
  }
  listing.brochureUrl = brochureUrlFor(cfg.site, listing.slug);
  // It worked this time: a stale "could not build" note must not survive on the listing.
  if (Array.isArray(listing._intake?.warnings)) {
    listing._intake.warnings = listing._intake.warnings
      .filter((c) => WARNING_CODES.has(c) && c !== 'brochure-too-large' && c !== 'brochure-failed');
  }
  return { listing: save(found.file, listing), brochure: built, source };
}
