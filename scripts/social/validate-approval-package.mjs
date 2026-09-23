#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PKG = path.join(ROOT, 'marketing', 'approval', '2026-09-23');
const MANIFEST = path.join(PKG, 'manifest.json');
const FFPROBE = process.env.BONA_FFPROBE_BIN || 'ffprobe';

export function luminance(hex) {
  const rgb = hex.replace('#', '').match(/.{2}/g).map((x) => parseInt(x, 16) / 255).map((x) => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
  return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
}
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + .05) / (lo + .05);
}
export function hasArabic(s) { return /[\u0600-\u06ff]/.test(String(s)); }
export function hasLatin(s) { return /[A-Za-z]/.test(String(s)); }

export function contentFitsSafeArea(bounds, safeArea, dimensions) {
  if (!bounds || !safeArea || !Array.isArray(dimensions) || dimensions.length !== 2) {
    return { valid: false, errors: ['missing content bounds, safe area, or dimensions'] };
  }
  const [width, height] = dimensions;
  const limits = { left: safeArea.left, top: safeArea.top, right: width - safeArea.right, bottom: height - safeArea.bottom };
  const errors = [];
  if (bounds.left < limits.left) errors.push(`left ${bounds.left} < ${limits.left}`);
  if (bounds.top < limits.top) errors.push(`top ${bounds.top} < ${limits.top}`);
  if (bounds.right > limits.right) errors.push(`right ${bounds.right} > ${limits.right}`);
  if (bounds.bottom > limits.bottom) errors.push(`bottom ${bounds.bottom} > ${limits.bottom}`);
  return { valid: errors.length === 0, errors };
}

export async function validatePackage({ root = ROOT, manifestPath = MANIFEST, ffprobe = FFPROBE } = {}) {
  const errors = [], checks = [];
  const ok = (name, detail) => checks.push({ name, status: 'pass', detail });
  const fail = (name, detail) => { checks.push({ name, status: 'fail', detail }); errors.push(`${name}: ${detail}`); };
  if (!fs.existsSync(manifestPath)) return { valid: false, errors: ['manifest: missing'], checks: [] };
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.brand === 'Bona' ? ok('brand', 'Bona') : fail('brand', `expected Bona, got ${manifest.brand}`);
  manifest.approvalStatus?.startsWith('AWAITING') ? ok('approval-gate', manifest.approvalStatus) : fail('approval-gate', 'missing awaiting-approval status');
  /No photography.*external media.*embedded audio/i.test(manifest.rights) ? ok('rights-declaration', manifest.rights) : fail('rights-declaration', 'incomplete rights declaration');
  if (/tk[\s-]?estate|tk-storage/i.test(JSON.stringify(manifest))) fail('cross-brand-dependency', 'manifest contains a forbidden cross-brand name or host'); else ok('cross-brand-dependency', 'none');

  for (const a of manifest.assets) {
    const f = path.join(root, a.path);
    const id = `${a.platform}:${path.basename(f)}`;
    if (!fs.existsSync(f)) { fail(`${id}:exists`, a.path); continue; }
    const stat = fs.statSync(f);
    stat.size > 0 ? ok(`${id}:size`, `${stat.size} bytes`) : fail(`${id}:size`, 'empty');
    const ratio = contrast(a.foreground, a.background);
    ratio >= 4.5 ? ok(`${id}:contrast`, ratio.toFixed(2)) : fail(`${id}:contrast`, `${ratio.toFixed(2)} < 4.5`);
    if (a.kind === 'image') {
      const sig = fs.readFileSync(f).subarray(0, 3).toString('hex');
      sig === 'ffd8ff' ? ok(`${id}:jpeg-signature`, sig) : fail(`${id}:jpeg-signature`, sig);
      const m = await sharp(f).metadata();
      (m.width === a.dimensions[0] && m.height === a.dimensions[1]) ? ok(`${id}:dimensions`, `${m.width}x${m.height}`) : fail(`${id}:dimensions`, `${m.width}x${m.height}`);
      ['srgb', 'rgb'].includes(m.space) ? ok(`${id}:colour-space`, m.space) : fail(`${id}:colour-space`, String(m.space));
      stat.size <= 8 * 1024 * 1024 ? ok(`${id}:platform-size`, `${(stat.size / 1024 / 1024).toFixed(2)} MiB`) : fail(`${id}:platform-size`, '>8 MiB');
    } else {
      const probe = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=index,codec_name,codec_type,width,height:format=duration,size', '-of', 'json', f], { encoding: 'utf8' });
      if (probe.status !== 0) { fail(`${id}:ffprobe`, probe.stderr.trim()); continue; }
      const data = JSON.parse(probe.stdout);
      const video = data.streams.find((s) => s.codec_type === 'video');
      const audio = data.streams.find((s) => s.codec_type === 'audio');
      video?.codec_name === 'h264' ? ok(`${id}:codec`, 'h264') : fail(`${id}:codec`, String(video?.codec_name));
      (video?.width === a.dimensions[0] && video?.height === a.dimensions[1]) ? ok(`${id}:dimensions`, `${video.width}x${video.height}`) : fail(`${id}:dimensions`, `${video?.width}x${video?.height}`);
      !audio && a.audio === false ? ok(`${id}:audio`, 'no audio stream') : fail(`${id}:audio`, 'audio stream present or manifest mismatch');
      const duration = Number(data.format.duration);
      duration >= 6 && duration <= 15 ? ok(`${id}:duration`, `${duration.toFixed(2)}s`) : fail(`${id}:duration`, `${duration}s outside 6–15s`);
    }
    const s = a.safeArea;
    const safeValues = s && [s.top, s.left, s.right, s.bottom];
    const validSafeArea = safeValues?.every((value) => Number.isFinite(value) && value >= 0)
      && s.left + s.right < a.dimensions[0]
      && s.top + s.bottom < a.dimensions[1];
    validSafeArea ? ok(`${id}:safe-area`, JSON.stringify(s)) : fail(`${id}:safe-area`, 'missing, invalid, or leaves no usable rectangle');
    const b = a.contentBounds;
    const validBounds = b && [b.left, b.top, b.right, b.bottom].every(Number.isFinite)
      && b.left <= b.right && b.top <= b.bottom;
    if (!validBounds) {
      fail(`${id}:content-bounds`, 'missing or invalid rendered-content bounds');
    } else if (validSafeArea) {
      const fit = contentFitsSafeArea(b, s, a.dimensions);
      fit.valid ? ok(`${id}:content-bounds`, JSON.stringify(b)) : fail(`${id}:content-bounds`, fit.errors.join('; '));
    }
  }

  for (const [name, captionPath] of Object.entries(manifest.captions)) {
    const f = path.join(root, captionPath);
    if (!fs.existsSync(f)) { fail(`captions:${name}`, 'missing'); continue; }
    const c = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const [platform, body] of Object.entries(c)) {
      if (platform === 'audioNote') continue;
      hasArabic(body) && hasLatin(body) ? ok(`caption:${name}:${platform}:bilingual`, `${body.length} chars`) : fail(`caption:${name}:${platform}:bilingual`, 'Arabic or English missing');
      if (/tk[\s-]?estate|tk-storage/i.test(body)) fail(`caption:${name}:${platform}:brand`, 'cross-brand text'); else ok(`caption:${name}:${platform}:brand`, 'Bona-only');
      if (/guarantee|guaranteed|خصم|عرض خاص|متاح الآن|available now/i.test(body)) fail(`caption:${name}:${platform}:claims`, 'promotional/availability claim found'); else ok(`caption:${name}:${platform}:claims`, 'no offer, guarantee, or availability claim');
      const limit = platform === 'instagram' ? 2200 : platform === 'tiktok' ? 2200 : 63206;
      body.length <= limit ? ok(`caption:${name}:${platform}:length`, `${body.length}/${limit}`) : fail(`caption:${name}:${platform}:length`, `${body.length}/${limit}`);
    }
  }
  const required = [['north-obhur', 'instagram'], ['north-obhur', 'facebook'], ['national-day-96', 'instagram'], ['national-day-96', 'instagram-story'], ['national-day-96', 'facebook'], ['national-day-96', 'tiktok']];
  for (const [pkg, platform] of required) manifest.assets.some((a) => a.package === pkg && a.platform === platform) ? ok(`coverage:${pkg}:${platform}`, 'present') : fail(`coverage:${pkg}:${platform}`, 'missing');
  return { valid: errors.length === 0, generatedAt: new Date().toISOString(), assets: manifest.assets.length, checks, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await validatePackage();
  fs.writeFileSync(path.join(PKG, 'validation-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ valid: report.valid, assets: report.assets, passed: report.checks.filter((c) => c.status === 'pass').length, failed: report.errors.length, report: path.relative(ROOT, path.join(PKG, 'validation-report.json')) }, null, 2));
  process.exit(report.valid ? 0 : 1);
}
