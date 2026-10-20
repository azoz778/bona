// Media for the browser publisher. Growth rule: never the identical file on two platforms —
// Instagram/Facebook post the reviewed frames (and the pack's 1080x1350 / 1080x1080 cards) as
// they are, so TikTok gets a 9:16 reel rendered from them and LinkedIn gets its own branded
// re-encode (property) or the dark 1080x1350 card variant (education).
import './fonts.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sharp, C } from './brand.mjs';
import { editorialCard, markLayer } from './cards.mjs';
import { renderCard } from './daily-card.mjs';
import { FFMPEG } from './util.mjs';

const SOCIAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function ff(args, timeout = 600_000) {
  const r = spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8', timeout });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${String(r.stderr || r.error?.message || '').trim().slice(-400)}`);
}

/** TikTok, property: make-reel.mjs from the approved frames, in review order, with the advertiser/FAL CTA lines. */
/** `fit: 'pad'` contains each frame on a 9:16 brand canvas instead of cover-cropping it. */
export function propertyReel(listing, frameFiles, licenceLines, out, { seconds = 20, fit = null } = {}) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const listingJson = path.join(path.dirname(out), `${listing.id}.listing.json`);
  fs.writeFileSync(listingJson, JSON.stringify(listing));
  const r = spawnSync(process.execPath, [path.join(SOCIAL, 'make-reel.mjs'), '--listing-json', listingJson, '--frames', frameFiles.join(','),
    '--licence-ar', licenceLines.ar, '--licence-en', licenceLines.en, '--seconds', String(seconds), '--out', out,
    ...(fit === 'pad' ? ['--fit', 'pad'] : [])],
  { encoding: 'utf8', timeout: 20 * 60_000, env: process.env });
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`make-reel failed (exit ${r.status}): ${String(r.stderr || '').trim().slice(-400)}`);
  return out;
}

/** The education item's cards at a given height (1920 story for TikTok, 1350 dark for LinkedIn). */
export async function educationCards(item, dir, { h, dark = false, prefix }) {
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  if (item.slides?.length) {
    for (const [i, slide] of item.slides.entries()) {
      const name = `${prefix}-${i + 1}.jpg`;
      await renderCard({ ...slide, dark, count: item.slides.length, seriesAr: 'بونا  /  ملاحظات عقارية', seriesEn: 'PROPERTY NOTES' }, i, h, name, dir, []);
      files.push(path.join(dir, name));
    }
  } else {
    const name = `${prefix}-1.jpg`;
    // Always the ink card: its English line is sand, which does not read on ivory. TikTok (1920) and LinkedIn (1350) differ in size.
    const png = await editorialCard(1080, h, { eyebrow: item.topic.ar, ar: item.card.ar, en: item.card.en });
    await sharp(png).flatten({ background: C.ink }).jpeg({ quality: 92, mozjpeg: true }).toFile(path.join(dir, name));
    files.push(path.join(dir, name));
  }
  return files;
}

/** TikTok, education: a silent 9:16 slideshow of the story-size cards with short fades. */
export async function educationReel(item, out) {
  const dir = path.join(path.dirname(out), 'cards');
  const cards = await educationCards(item, dir, { h: 1920, dark: false, prefix: 'tt' });
  const per = cards.length === 1 ? 9 : 7, fade = 0.5;
  const inputs = cards.flatMap(f => ['-loop', '1', '-framerate', '30', '-t', String(per), '-i', f]);
  // No fade-in on the first card: TikTok takes the first frame as the default cover.
  const chain = cards.map((_, i) => `[${i}:v]scale=1080:1920,setsar=1,format=yuv420p,${i ? `fade=t=in:st=0:d=${fade},` : ''}fade=t=out:st=${per - fade}:d=${fade}[v${i}]`);
  const filter = `${chain.join(';')};${cards.map((_, i) => `[v${i}]`).join('')}concat=n=${cards.length}:v=1:a=0[out]`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  ff([...inputs, '-filter_complex', filter, '-map', '[out]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart', '-an', '-f', 'mp4', `${out}.part`]);
  fs.renameSync(`${out}.part`, out);
  return out;
}

/** LinkedIn, property: each approved frame at 1200 px wide (aspect kept), the BONA wordmark bottom-left, its own JPEG.
    `mark: false` for padded frames, which already carry the mark in their band. */
export async function linkedinPropertyImages(frameFiles, dir, { mark: withMark = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const [i, f] of frameFiles.entries()) {
    const img = sharp(f).rotate().resize({ width: 1200, withoutEnlargement: false });
    const buf = await img.jpeg({ quality: 95 }).toBuffer();
    const file = path.join(dir, `li-${i + 1}.jpg`);
    if (!withMark) { await sharp(buf).jpeg({ quality: 88, mozjpeg: true }).toFile(file); out.push(file); continue; }
    const { width, height } = await sharp(buf).metadata();
    // markLayer centres the mark on a full canvas; crop its strip and put it bottom-left.
    const mark = await sharp(await markLayer(width, 140, { size: 30, top: 50 })).png().toBuffer();
    await sharp(buf).composite([{ input: mark, top: height - 140, left: 0 }]).jpeg({ quality: 88, mozjpeg: true }).toFile(file);
    out.push(file);
  }
  return out;
}
/** LinkedIn, education: the dark 1080x1350 card variant (Instagram had the light one, Facebook the square). */
export const linkedinEducationImages = (item, dir) => educationCards(item, dir, { h: 1350, dark: true, prefix: 'li' });
