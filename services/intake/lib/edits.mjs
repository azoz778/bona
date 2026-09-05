// The `remove | hero | price | sold | hide` commands, applied to an inbox listing.
// Pure file edits — the caller rebuilds, commits and replies.
import fs from 'node:fs';
import path from 'node:path';
import { findInbox } from './listing.mjs';
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
