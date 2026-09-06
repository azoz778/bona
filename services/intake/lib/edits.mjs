// The `remove | hero | price | sold | hide | brochure` commands, applied to an inbox
// listing. File edits — the caller rebuilds, commits and replies.
import fs from 'node:fs';
import path from 'node:path';
import { brochureFileIn, brochureUrlFor, buildBrandedBrochure, findSourcePdf } from './brochure.mjs';
import { WARNING_CODES, findInbox } from './listing.mjs';
import { removeListingImages } from './images.mjs';

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
