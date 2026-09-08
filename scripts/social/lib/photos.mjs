// Getting a listing's photographs onto disk, in the order they should be shown.
//
// PHOTO ORDER IS NOT DECIDED HERE. `listing.images` is already ranked: the WhatsApp intake
// pipeline (services/intake — prompt.md's image rubric, orderedPicks() in lib/listing.mjs,
// writeListingImages() in lib/images.mjs) had a model look at a labelled contact sheet of
// every candidate and put the hero at index 0, and curated listings were ordered by hand the
// same way. This module only resolves that order to files and drops the ones that will not
// decode. Re-sorting on filesize/entropy/aspect here would throw away the ranking.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './fonts.mjs';
import { sharp } from './brand.mjs';

/** Matches services/intake/lib/images.mjs — a hostile or silly-large image must not eat the box. */
export const MAX_INPUT_PIXELS = 50_000_000;
/** Hard cap on a downloaded photograph. The media host serves ~1-4 MB stills; 40 MB is
 *  generous for a raw upload and small enough that a bad or hostile URL cannot exhaust RAM
 *  before sharp ever sees the pixels. */
export const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;

const CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'bona-social', 'photos');

const isLocal = (src) => typeof src === 'string' && src.startsWith('/');
const isRemote = (src) => /^https?:\/\//i.test(String(src));

/** A site-local `/listings/<slug>/01.jpg` or `/land/<id>.jpg` maps straight into public/. */
export const publicPath = (src) => path.join(REPO_ROOT, 'public', String(src).replace(/^\//, ''));

/**
 * Fetch a remote photo once and keep it. 24 of the 46 listings still point at the media
 * host rather than public/listings, and a 20-reel run would otherwise re-download ~150 files.
 */
async function cached(url, { timeoutMs = 30000 } = {}) {
  fs.mkdirSync(CACHE, { recursive: true });
  const ext = (path.extname(new URL(url).pathname) || '.jpg').split('?')[0].slice(0, 5);
  const file = path.join(CACHE, crypto.createHash('sha1').update(url).digest('hex') + ext);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const tmp = `${file}.part`;
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      throw new Error(`content-length ${declared} over ${MAX_DOWNLOAD_BYTES}`);
    }
    // Stream it. res.arrayBuffer() would materialise the whole response first, so a URL
    // that lies about (or omits) content-length could exhaust memory before any cap ran.
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > MAX_DOWNLOAD_BYTES) { ac.abort(); throw new Error(`body over ${MAX_DOWNLOAD_BYTES} bytes`); }
      chunks.push(chunk);
    }
    if (!total) throw new Error('empty body');
    fs.writeFileSync(tmp, Buffer.concat(chunks, total));
    fs.renameSync(tmp, file); // never leave a half-written file where a later run trusts it
    return file;
  } finally {
    clearTimeout(timer);
    fs.rmSync(tmp, { force: true }); // no partial left behind on any error path
  }
}

/** @returns {Promise<string|null>} absolute path to a decodable file, or null. */
export async function resolveImage(image) {
  const src = image?.src;
  try {
    let file = null;
    if (isLocal(src)) { file = publicPath(src); if (!fs.existsSync(file)) return null; }
    else if (isRemote(src)) file = await cached(src);
    else return null;
    const meta = await sharp(file, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    if (!(meta.width > 0 && meta.height > 0)) return null;
    return file;
  } catch {
    return null;
  }
}

/**
 * The first `n` usable photographs of a listing, IN THE LISTING'S OWN RANKED ORDER.
 * @returns {Promise<Array<{file:string, image:object, index:number, width:number, height:number}>>}
 */
export async function bestPhotos(listing, n = 6) {
  const out = [];
  for (const [index, image] of (listing.images || []).entries()) {
    if (out.length >= n) break;
    const file = await resolveImage(image);
    if (!file) continue;
    const meta = await sharp(file, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    out.push({ file, image, index, width: meta.width, height: meta.height });
  }
  return out;
}

/**
 * Strip a uniform border, if the photograph has one.
 *
 * Photos that came out of a brochure PDF (every BONA-W### listing) regularly carry a baked-in
 * white margin — `alhayat-residence-al-salama/05.jpg` has ~62 px of pure white down each
 * side. Cover-cropping keeps it, and the reel then has white bars down the edges, which on a
 * luxury property reel just reads as broken.
 *
 * The guard matters more than the trim: `trim()` will happily eat half a photograph whose
 * lower third is a bright wall (it took 01.jpg of that same listing from 1484x1920 to
 * 1370x1027). So the result is only accepted when BOTH dimensions keep >= `minKeep` of the
 * original — a border, not a crop. `trim()` is called without a `background` so it takes its
 * reference from the corner pixel and handles a black letterbox as well as a white one.
 *
 * @returns {Promise<Buffer>} the trimmed image, or the original if the trim was rejected
 */
export async function trimUniformBorder(file, { threshold = 18, minKeep = 0.8 } = {}) {
  const base = await sharp(file, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().toBuffer({ resolveWithObject: true });
  try {
    const cut = await sharp(base.data, { limitInputPixels: MAX_INPUT_PIXELS })
      .trim({ threshold })
      .toBuffer({ resolveWithObject: true });
    const keptW = cut.info.width / base.info.width;
    const keptH = cut.info.height / base.info.height;
    const changed = cut.info.width !== base.info.width || cut.info.height !== base.info.height;
    if (changed && keptW >= minKeep && keptH >= minKeep) return cut.data;
  } catch {
    // A single-colour image makes trim() throw; that is not a reason to lose the photo.
  }
  return base.data;
}

/**
 * Cover-crop a photograph to `w`x`h`.
 *
 * `position` defaults to sharp's attention strategy: turning a 3:2 interior shot into 9:16
 * throws away two thirds of the width, and a centre crop regularly cuts a façade in half or
 * lands on a blank wall. Attention keeps the busiest region, which for architecture is the
 * building. `--centre` on the generators forces the predictable crop instead.
 */
export async function cover(file, w, h, { position = 'attention', quality = 92, trimBorder = true } = {}) {
  const pos = position === 'attention' ? sharp.strategy.attention : position === 'entropy' ? sharp.strategy.entropy : position;
  const input = trimBorder ? await trimUniformBorder(file) : file;
  return sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize({ width: Math.round(w), height: Math.round(h), fit: 'cover', position: pos, withoutEnlargement: false })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
}

/** Cover-crop straight to a file (used for the Ken Burns source stills). */
export async function coverToFile(file, out, w, h, opts = {}) {
  const buf = await cover(file, w, h, opts);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
  return out;
}

export const photoCacheDir = () => CACHE;
