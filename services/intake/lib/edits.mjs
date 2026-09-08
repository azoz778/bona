// The `remove | hero | price | sold | hide | brochure | licence | wafi` commands, applied to
// a listing. File edits — the caller rebuilds, commits and replies.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { licenceProblems } from '../../../scripts/curate/rules.mjs';
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

// ---- REGA advertising licences ------------------------------------------------------------
// Two homes, one command. An intake listing carries `licence` inside its own inbox JSON; a
// CURATED listing (BONA-###) is generated from listings.source.mjs and has nowhere to put one,
// so its numbers live in scripts/curate/licences.json keyed by id and build.mjs merges them
// back on (see the "REGA advertising licences" block there). The owner types the same command
// either way — which file it lands in is not his problem.
export const LICENCES_FILE = path.join('scripts', 'curate', 'licences.json');
export const LISTINGS_JSON = path.join('src', 'data', 'listings.json');

/** Every key the site knows about, so a stored licence is never a partial object. */
const EMPTY_LICENCE = { adNumber: null, adExpiry: null, wafiNumber: null, escrowAccount: null };

const licencesPath = (repo) => path.join(repo, LICENCES_FILE);

/**
 * scripts/curate/licences.json, as `{ [listingId]: licence }`.
 *
 * ONLY a genuinely absent file bootstraps to an empty set. Anything else — unreadable,
 * invalid JSON, a half-written file, JSON that is not an object of listings — THROWS, because
 * the caller's next move is to write the file back out: swallowing the error would rewrite it
 * with just the one key being set and silently delete every other listing's licence. A throw
 * reaches index.mjs::publishEdit, which restores the clone with resetTree() and answers the
 * group with the generic failure line, leaving the broken file for the owner to fix.
 *
 * The result has NO PROTOTYPE: the keys come from a file and are looked up with a string that
 * arrived in a WhatsApp message, so a lookup must never fall through to Object.prototype.
 */
export function readLicences(repo) {
  const file = licencesPath(repo);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return Object.create(null);
    throw err;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (cause) {
    // Generic message, detail on `err.detail` — publish.mjs::must()'s rule. `err.message`
    // reaches the group through `status` ("Last error: …"), and a parser message is one Node
    // release away from quoting the bytes it choked on.
    const err = new Error(`${LICENCES_FILE} is not valid JSON — refusing to overwrite it. See the journal.`);
    err.detail = cause.message;
    throw err;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${LICENCES_FILE} must be a JSON object of listing id -> licence`);
  }
  const all = Object.create(null);
  for (const [k, v] of Object.entries(data)) all[k] = v;
  return all;
}

/** Sorted by id, so two edits months apart produce a readable diff instead of a reshuffle. */
function writeLicences(repo, all) {
  const sorted = Object.fromEntries(Object.keys(all).sort().map((k) => [k, all[k]]));
  fs.writeFileSync(licencesPath(repo), `${JSON.stringify(sorted, null, 2)}\n`);
  return sorted;
}

/**
 * A CURATED listing, read back from the built src/data/listings.json.
 *
 * That file is the only place in the repo where the curated set exists as data rather than as
 * a module to execute, and it is committed, so it answers "is BONA-015 a real listing?"
 * without importing listings.source.mjs into the daemon.
 * @returns {{listing:object, curated:true}|null}
 */
export function locateCurated(repo, id) {
  const want = String(id).toUpperCase();
  let all;
  try { all = JSON.parse(fs.readFileSync(path.join(repo, LISTINGS_JSON), 'utf8')); } catch { return null; }
  const listing = Array.isArray(all) ? all.find((l) => String(l?.id).toUpperCase() === want) : null;
  return listing ? { listing, curated: true } : null;
}

/**
 * The licence a listing should END UP with: the one it has, plus the fields this command sets,
 * or minus the fields it clears. An all-null block is not a licence — it becomes `null`, which
 * is what the site reads as "advertiser + FAL line only, no per-listing number".
 */
function nextLicence(current, patch, clearKeys) {
  const next = { ...EMPTY_LICENCE, ...(current ?? {}) };
  if (patch) {
    // Only the fields actually GIVEN are set. `wafi <id> <no>` must not blank the ad licence
    // just because its patch carries no adNumber…
    const given = Object.entries(patch).filter(([, v]) => v !== undefined);
    // …and a patch that sets nothing at all is a caller bug, not a request to clear the
    // block. Clearing is its own argument and its own command; an all-undefined patch used to
    // look identical to one and wiped a licence the owner had recorded.
    if (!given.length) throw new Error('licence patch has no field to set — use { clear: true } to remove one');
    for (const [k, v] of given) next[k] = v;
  } else {
    for (const k of clearKeys) next[k] = null;
  }
  return Object.values(next).some((v) => v !== null && v !== undefined && v !== '') ? next : null;
}

/**
 * Write the licence onto whichever of the two homes this id has.
 *
 * Validated with scripts/curate/rules.mjs::licenceProblems BEFORE anything is written — the
 * SAME function validate.mjs runs on the built listings.json. A licence that would fail the
 * site build never reaches a commit, so the daemon cannot push a tree that then refuses to
 * rebuild.
 * @returns {{listing:object,licence:object|null,curated:boolean}|{error:string}|null}
 */
function applyLicence(repo, id, patch, clearKeys) {
  const want = String(id).toUpperCase();
  const found = findInbox(repo, want);
  if (found) {
    const licence = nextLicence(found.listing.licence, patch, clearKeys);
    const problems = licenceProblems(licence);
    if (problems.length) return { error: problems.join('; ') };
    found.listing.licence = licence;
    return { listing: save(found.file, found.listing), licence, curated: false };
  }
  const curated = locateCurated(repo, want);
  if (!curated) return null;
  const all = readLicences(repo);
  const licence = nextLicence(all[want], patch, clearKeys);
  const problems = licenceProblems(licence);
  if (problems.length) return { error: problems.join('; ') };
  if (licence) all[want] = licence;
  else delete all[want];
  writeLicences(repo, all);
  return { listing: curated.listing, licence, curated: true };
}

/** `licence <id> <adNumber> <YYYY-MM-DD>` — or `licence <id> clear`. */
export function setLicence(repo, id, { adNumber, adExpiry, clear = false } = {}) {
  return applyLicence(repo, id, clear ? null : { adNumber, adExpiry }, ['adNumber', 'adExpiry']);
}

/** `wafi <id> <number>` — or `wafi <id> clear`. */
export function setWafi(repo, id, { wafiNumber, clear = false } = {}) {
  return applyLicence(repo, id, clear ? null : { wafiNumber }, ['wafiNumber']);
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
