#!/usr/bin/env node
// Render self-contained, approval-only social packages for 2026-09-23.
// All artwork is generated from Bona brand primitives: no remote media, stock, or audio.
import './lib/fonts.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { C, centred, fitText, rule, sharp, text, wordmark } from './lib/brand.mjs';
import { savePair } from './lib/util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'marketing', 'approval', '2026-09-23');
const FFMPEG = process.env.BONA_FFMPEG_BIN || 'ffmpeg';
const mkdir = (p) => fs.mkdirSync(p, { recursive: true });
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const clamp = (n) => Math.max(0, Math.round(n));

const PALETTE = {
  north: { bg: '#0f1214', bg2: '#183139', fg: '#f5f1ea', accent: '#c8a96a', muted: '#d9d0c1' },
  national: { bg: '#07583a', bg2: '#063c2a', fg: '#fffaf0', accent: '#e2c98f', muted: '#e9e2d5' },
};

function backdrop(w, h, p, variant = 0) {
  const step = Math.round(Math.min(w, h) / 9);
  const lines = Array.from({ length: 14 }, (_, i) => {
    const y = (i * step + variant * 37) % (h + step) - step;
    return `<path d="M -80 ${y} C ${w * .28} ${y - 90}, ${w * .66} ${y + 100}, ${w + 80} ${y - 20}" fill="none" stroke="${p.accent}" stroke-opacity=".10" stroke-width="2"/>`;
  }).join('');
  const archW = Math.round(w * .58), archX = Math.round((w - archW) / 2), archTop = Math.round(h * .18);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${p.bg}"/><stop offset="1" stop-color="${p.bg2}"/></linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>${lines}
    <path d="M ${archX} ${h * .82} V ${archTop + archW / 2} A ${archW / 2} ${archW / 2} 0 0 1 ${archX + archW} ${archTop + archW / 2} V ${h * .82}" fill="none" stroke="${p.accent}" stroke-opacity=".16" stroke-width="5"/>
    <circle cx="${w * .82}" cy="${h * .17}" r="${Math.round(w * .12)}" fill="none" stroke="${p.fg}" stroke-opacity=".07" stroke-width="2"/>
  </svg>`);
}

async function card({ w, h, palette, eyebrow, ar, en, number, footer, variant = 0, safe }) {
  const p = palette;
  const mark = await wordmark({ size: Math.round(w * .041), color: p.fg, accent: p.accent });
  const eb = await text({ text: eyebrow, face: 'en-body', size: Math.round(w * .027), color: p.accent, letterSpacing: 2.2, align: 'centre' });
  const maxW = Math.round(w * .79);
  const arImg = await fitText({ text: ar, face: 'ar-display', size: Math.round(w * .075), color: p.fg, width: maxW, align: 'centre', dir: 'rtl', lineHeight: 1.18 }, { maxHeight: Math.round(h * .24), minSize: 42 });
  const enImg = await fitText({ text: en, face: 'en-display', size: Math.round(w * .052), color: p.muted, width: maxW, align: 'centre', dir: 'ltr', lineHeight: 1.18 }, { maxHeight: Math.round(h * .18), minSize: 30 });
  const foot = await text({ text: footer, face: /[\u0600-\u06ff]/.test(footer) ? 'ar-body' : 'en-body', size: Math.round(w * .024), color: p.muted, width: maxW, align: 'centre', lineHeight: 1.3 });
  const layers = [{ input: backdrop(w, h, p, variant), top: 0, left: 0 }, centred(mark, w, safe.top), centred(eb, w, safe.top + mark.height + 34)];
  if (number) {
    const n = await text({ text: number, face: 'en-display', size: Math.round(w * .29), color: p.accent, opacity: .18, align: 'centre' });
    layers.push(centred(n, w, Math.round(h * .28)));
  }
  const arTop = Math.round(h * .45 - arImg.height / 2);
  layers.push(centred(arImg, w, arTop));
  layers.push({ input: await rule(Math.round(w * .13), 3, p.accent), top: clamp(arTop + arImg.height + 35), left: Math.round(w * .435) });
  layers.push(centred(enImg, w, arTop + arImg.height + 64));
  layers.push(centred(foot, w, h - safe.bottom - foot.height));
  return sharp({ create: { width: w, height: h, channels: 4, background: p.bg } }).composite(layers).png().toBuffer();
}

async function writeJpegPair(file, buf) {
  mkdir(path.dirname(file));
  return savePair(file.replace(/\.jpg$/i, '.png'), buf, sharp, { quality: 95 });
}

async function contactSheet(files, out, title) {
  const thumbs = [];
  for (const f of files) {
    const b = await sharp(f).resize({ width: 280, height: 350, fit: 'contain', background: '#0f1214' }).jpeg({ quality: 86 }).toBuffer();
    thumbs.push(b);
  }
  const W = Math.max(700, thumbs.length * 300 + 40), H = 450;
  const label = await text({ text: title, face: 'en-body', size: 30, color: C.ivory, width: W - 40, align: 'centre' });
  const layers = [centred(label, W, 26)];
  thumbs.forEach((b, i) => layers.push({ input: b, left: 20 + i * 300, top: 80 }));
  await sharp({ create: { width: W, height: H, channels: 3, background: C.ink } }).composite(layers).jpeg({ quality: 88 }).toFile(out);
}

const northDir = path.join(OUT, 'north-obhur');
const ndDir = path.join(OUT, 'national-day-96');
mkdir(northDir); mkdir(ndDir);
const northCopy = [
  ['NORTH OBHUR · DISTRICT GUIDE', 'دليل أبحر الشمالية', 'North Obhur district guide', 'محتوى تحريري · Editorial'],
  ['01 · START WITH THE ROUTE', 'ابدأ بمسارك اليومي', 'Start with your daily route', 'قارن الوصول والخدمات في الأوقات التي تهمك'],
  ['02 · VISIT, THEN REVISIT', 'عاين الموقع أكثر من مرة', 'Visit the location more than once', 'افحص الحركة والضوضاء وأعمال البناء في أوقات مختلفة'],
  ['03 · VERIFY THE VIEW', 'تحقّق من معنى «إطلالة بحرية»', 'Verify what “sea view” means', 'اسأل عمّا قد يُبنى أمامها وعن حدود الاستخدام'],
  ['04 · DEFINE YOUR NEEDS', 'حدّد احتياجك أولاً', 'Define your needs before viewing', 'الحي · الميزانية · التوقيت  |  bona-real-estate.com'],
];
const northIg = [], northFb = [];
for (let i = 0; i < northCopy.length; i++) {
  const [eyebrow, ar, en, footer] = northCopy[i];
  const safeIg = { top: 74, bottom: 92, left: 90, right: 90 };
  const safeFb = { top: 72, bottom: 82, left: 84, right: 84 };
  const ig = path.join(northDir, 'instagram', `${String(i + 1).padStart(2, '0')}.jpg`);
  const fb = path.join(northDir, 'facebook', `${String(i + 1).padStart(2, '0')}.jpg`);
  await writeJpegPair(ig, await card({ w: 1080, h: 1350, palette: PALETTE.north, eyebrow, ar, en, footer, variant: i, safe: safeIg }));
  await writeJpegPair(fb, await card({ w: 1080, h: 1080, palette: PALETTE.north, eyebrow, ar, en, footer, variant: i + 2, safe: safeFb }));
  northIg.push(ig); northFb.push(fb);
}
await contactSheet(northIg, path.join(northDir, 'preview-instagram.jpg'), 'Bona · North Obhur · Instagram 4:5 carousel');
await contactSheet(northFb, path.join(northDir, 'preview-facebook.jpg'), 'Bona · North Obhur · Facebook 1:1 carousel');

const nationalSlides = [
  ['SAUDI NATIONAL DAY · 23 SEPTEMBER 2026', 'اليوم الوطني السعودي ٩٦', 'Saudi National Day 96', 'كل عام والمملكة وشعبها بخير'],
  ['FROM BONA · من بونا', 'دارٌ تجمعنا', 'A home that brings us together', 'مع أطيب التمنيات من بونا · With warm wishes from Bona'],
];
const ndIg = [];
for (let i = 0; i < nationalSlides.length; i++) {
  const [eyebrow, ar, en, footer] = nationalSlides[i];
  const f = path.join(ndDir, 'instagram', `${String(i + 1).padStart(2, '0')}.jpg`);
  await writeJpegPair(f, await card({ w: 1080, h: 1350, palette: PALETTE.national, eyebrow, ar, en, footer, number: i === 0 ? '96' : null, variant: i + 4, safe: { top: 74, bottom: 92, left: 90, right: 90 } }));
  ndIg.push(f);
}
const story = path.join(ndDir, 'instagram', 'story-1080x1920.jpg');
await writeJpegPair(story, await card({ w: 1080, h: 1920, palette: PALETTE.national, eyebrow: nationalSlides[0][0], ar: nationalSlides[0][1], en: nationalSlides[0][2], footer: nationalSlides[0][3], number: '96', variant: 7, safe: { top: 190, bottom: 360, left: 90, right: 190 } }));
const fbNational = path.join(ndDir, 'facebook', 'feed-1200x1500.jpg');
await writeJpegPair(fbNational, await card({ w: 1200, h: 1500, palette: PALETTE.national, eyebrow: nationalSlides[0][0], ar: 'اليوم الوطني السعودي ٩٦\nكل عام والمملكة بخير', en: 'Saudi National Day 96\nWith warm wishes from Bona', footer: '23 SEPTEMBER 2026 · ٢٣ سبتمبر ٢٠٢٦', number: '96', variant: 8, safe: { top: 82, bottom: 102, left: 100, right: 100 } }));

const tkFrames = [];
const tkCopy = [
  ['SAUDI NATIONAL DAY · 96', 'اليوم الوطني السعودي ٩٦', 'Saudi National Day 96', '٢٣ سبتمبر ٢٠٢٦ · 23 September 2026'],
  ['A HOME THAT BRINGS US TOGETHER', 'دارٌ تجمعنا', 'A home that brings us together', 'من بونا · From Bona'],
  ['WITH WARM WISHES', 'كل عام والمملكة وشعبها بخير', 'Happy Saudi National Day', 'bona-real-estate.com'],
];
for (let i = 0; i < tkCopy.length; i++) {
  const [eyebrow, ar, en, footer] = tkCopy[i];
  const f = path.join(ndDir, 'tiktok', 'frames', `${String(i + 1).padStart(2, '0')}.png`);
  mkdir(path.dirname(f));
  fs.writeFileSync(f, await card({ w: 1080, h: 1920, palette: PALETTE.national, eyebrow, ar, en, footer, number: i === 0 ? '96' : null, variant: i + 9, safe: { top: 190, bottom: 430, left: 90, right: 190 } }));
  tkFrames.push(f);
}
const video = path.join(ndDir, 'tiktok', 'national-day-96-silent.mp4');
const ff = spawnSync(FFMPEG, ['-y', '-framerate', '1/2.4', '-i', path.join(ndDir, 'tiktok', 'frames', '%02d.png'), '-vf', "fps=30,format=yuv420p", '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-movflags', '+faststart', '-an', video], { encoding: 'utf8' });
if (ff.status !== 0) throw new Error(`ffmpeg failed: ${ff.stderr.slice(-1500)}`);
await contactSheet(tkFrames, path.join(ndDir, 'preview-tiktok.jpg'), 'Bona · Saudi National Day 96 · TikTok safe-area frames');
await contactSheet(ndIg, path.join(ndDir, 'preview-instagram.jpg'), 'Bona · Saudi National Day 96 · Instagram 4:5 + Story');
await contactSheet([fbNational], path.join(ndDir, 'preview-facebook.jpg'), 'Bona · Saudi National Day 96 · Facebook 4:5');

const captions = {
  northObhur: {
    instagram: `أبحر الشمالية ليست خياراً واحداً؛ تفاصيل الموقع هي التي تصنع الفرق. قبل أن تختار عقاراً، قارن مسارك اليومي، وزُر الموقع في أوقات مختلفة، وتحقّق من معنى الإطلالة وحدود الاستخدام.\n\nNorth Obhur is not one proposition; the exact location makes the difference. Before choosing a property, compare your daily route, revisit the site at different times, and verify what the view and access actually include.\n\nللبدء، شاركنا الحي والميزانية والتوقيت عبر الرابط في البايو.\nTo begin, share your preferred area, budget and timing through the link in bio.\n\n#بونا #أبحر_الشمالية #جدة #عقارات_جدة #Bona #NorthObhur #JeddahRealEstate`,
    facebook: `دليل بونا المختصر لأبحر الشمالية:\n• ابدأ بمسارك اليومي والخدمات التي تحتاجها.\n• عاين الموقع أكثر من مرة وفي أوقات مختلفة.\n• تحقّق من الإطلالة وما قد يؤثر فيها.\n• حدّد الحي والميزانية والتوقيت قبل مقارنة العقارات.\n\nBona’s short North Obhur guide:\n• Start with your daily route and essential services.\n• Visit the location more than once and at different times.\n• Verify the view and what may affect it.\n• Define your area, budget and timing before comparing properties.\n\nابدأ من: https://bona-real-estate.com\n#بونا #أبحر_الشمالية #NorthObhur`,
  },
  nationalDay96: {
    instagram: `في اليوم الوطني السعودي ٩٦، نحتفي بوطنٍ يجمعنا وبدارٍ نصنع فيها أجمل الذكريات.\n\nOn Saudi National Day 96, we celebrate the nation that brings us together and the homes where lasting memories are made.\n\nكل عام والمملكة وشعبها بخير.\nWith warm wishes from Bona.\n\n#اليوم_الوطني_السعودي #اليوم_الوطني96 #SaudiNationalDay96 #بونا #Bona`,
    facebook: `بمناسبة اليوم الوطني السعودي ٩٦، تتقدم بونا بأطيب التمنيات للمملكة وشعبها. نسأل الله أن يديم على وطننا الأمن والازدهار.\n\nOn Saudi National Day 96, Bona extends its warmest wishes to the Kingdom and its people. May our nation continue in security and prosperity.\n\nكل عام والمملكة بخير. | Happy Saudi National Day.`,
    tiktok: `اليوم الوطني السعودي ٩٦ 🇸🇦\nدارٌ تجمعنا. كل عام والمملكة وشعبها بخير.\n\nSaudi National Day 96. A home that brings us together.\n\n#اليوم_الوطني96 #SaudiNationalDay96 #بونا #Bona`,
    audioNote: 'No audio is embedded. At posting time, use silence or select a track from TikTok’s Commercial Music Library that is cleared for business use; approval of the final track remains a separate owner/platform check.',
  },
};
fs.writeFileSync(path.join(northDir, 'captions.json'), `${JSON.stringify(captions.northObhur, null, 2)}\n`);
fs.writeFileSync(path.join(ndDir, 'captions.json'), `${JSON.stringify(captions.nationalDay96, null, 2)}\n`);

const assets = [];
const addImages = (pkg, platform, files, dimensions, safeArea) => files.forEach((f) => assets.push({ package: pkg, platform, path: rel(f), kind: 'image', format: 'jpeg', dimensions, safeArea, foreground: pkg === 'north-obhur' ? PALETTE.north.fg : PALETTE.national.fg, background: pkg === 'north-obhur' ? PALETTE.north.bg : PALETTE.national.bg }));
addImages('north-obhur', 'instagram', northIg, [1080, 1350], { top: 74, right: 90, bottom: 92, left: 90 });
addImages('north-obhur', 'facebook', northFb, [1080, 1080], { top: 72, right: 84, bottom: 82, left: 84 });
addImages('national-day-96', 'instagram', ndIg, [1080, 1350], { top: 74, right: 90, bottom: 92, left: 90 });
addImages('national-day-96', 'instagram-story', [story], [1080, 1920], { top: 190, right: 190, bottom: 360, left: 90 });
addImages('national-day-96', 'facebook', [fbNational], [1200, 1500], { top: 82, right: 100, bottom: 102, left: 100 });
assets.push({ package: 'national-day-96', platform: 'tiktok', path: rel(video), kind: 'video', format: 'mp4', dimensions: [1080, 1920], safeArea: { top: 190, right: 190, bottom: 430, left: 90 }, audio: false, foreground: PALETTE.national.fg, background: PALETTE.national.bg });
const manifest = {
  approvalStatus: 'AWAITING ABDULAZIZ APPROVAL — DO NOT PUBLISH OR SCHEDULE',
  campaignDate: '2026-09-23',
  brand: 'Bona',
  rights: 'Original vector artwork generated locally from Bona brand primitives. No photography, third-party marks, external media, or embedded audio.',
  sourceRepair: { failedEntry: 'ig-2026-09-21-carousel-district-guide-north-obhur-al-sheraa-al-bandar', rootCause: 'The Instagram publisher requires JPEG; slide 2 referenced a remote PNG whose .jpg/.jpeg twins returned 404. All three sources were also hosted under a legacy cross-brand media namespace.', remedy: 'Replaced every remote/cross-brand dependency with deterministic Bona-owned vector artwork and rendered local sRGB JPEG exports.' },
  assets,
  captions: { northObhur: rel(path.join(northDir, 'captions.json')), nationalDay96: rel(path.join(ndDir, 'captions.json')) },
  previews: [rel(path.join(northDir, 'preview-instagram.jpg')), rel(path.join(northDir, 'preview-facebook.jpg')), rel(path.join(ndDir, 'preview-instagram.jpg')), rel(path.join(ndDir, 'preview-facebook.jpg')), rel(path.join(ndDir, 'preview-tiktok.jpg'))],
};
fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(OUT, 'APPROVAL.md'), `# Bona social approval package — 23 September 2026\n\n**Status: awaiting Abdulaziz approval. Do not publish or schedule.**\n\n## North Obhur\n- Instagram: five 1080×1350 JPEG slides.\n- Facebook: five 1080×1080 JPEG slides.\n- Editorial district guidance only; no property, price, availability, offer, endorsement, or licence claim.\n- Original Bona vector artwork replaces all TK-hosted sources.\n\n## Saudi National Day 96\n- Instagram: two 1080×1350 JPEG slides and one 1080×1920 Story.\n- Facebook: one 1200×1500 JPEG feed asset.\n- TikTok: silent 1080×1920 H.264 MP4 plus three PNG source frames.\n- Date wording: 23 September 2026 / اليوم الوطني السعودي ٩٦.\n- No official campaign logo or slogan is reproduced; no third-party asset or unlicensed audio is embedded.\n\n## Approval checklist\n- [ ] Arabic and English copy approved.\n- [ ] North Obhur guidance approved as editorial content.\n- [ ] Instagram crop/order approved.\n- [ ] Facebook adaptation approved.\n- [ ] TikTok motion and safe-area preview approved.\n- [ ] If TikTok audio is added, the exact track is approved from the Commercial Music Library.\n- [ ] Final publishing time approved separately.\n\nValidation: run \`node scripts/social/validate-approval-package.mjs\`.\n`);
console.log(OUT);
