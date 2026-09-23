import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { iso, renderedContentBounds, riso } from '../social/lib/brand.mjs';
import { contentFitsSafeArea, contrast, hasArabic, hasLatin, luminance, validatePackage } from '../social/validate-approval-package.mjs';

test('approval package contrast calculation matches WCAG reference cases', () => {
  assert.equal(luminance('#000000'), 0);
  assert.equal(luminance('#ffffff'), 1);
  assert.equal(contrast('#000000', '#ffffff'), 21);
  assert.ok(contrast('#f5f1ea', '#0f1214') >= 4.5);
  assert.ok(contrast('#fffaf0', '#07583a') >= 4.5);
});

test('bilingual gate detects Arabic and Latin independently', () => {
  assert.equal(hasArabic('اليوم الوطني السعودي ٩٦'), true);
  assert.equal(hasLatin('Saudi National Day 96'), true);
  assert.equal(hasArabic('Saudi National Day 96'), false);
  assert.equal(hasLatin('اليوم الوطني السعودي ٩٦'), false);
});

test('mixed-direction footer runs use explicit Unicode isolation', () => {
  assert.equal(riso('٢٣ سبتمبر ٢٠٢٦'), '\u2067٢٣ سبتمبر ٢٠٢٦\u2069');
  assert.equal(iso('23 September 2026'), '\u206623 September 2026\u2069');
});

test('rendered content bounds must stay inside every safe-area edge', () => {
  const dimensions = [1080, 1920];
  const safeArea = { top: 190, right: 190, bottom: 430, left: 90 };
  assert.deepEqual(contentFitsSafeArea({ left: 90, top: 190, right: 890, bottom: 1490 }, safeArea, dimensions), { valid: true, errors: [] });
  assert.deepEqual(contentFitsSafeArea({ left: 89, top: 189, right: 891, bottom: 1491 }, safeArea, dimensions), {
    valid: false,
    errors: ['left 89 < 90', 'top 189 < 190', 'right 891 > 890', 'bottom 1491 > 1490'],
  });
});

test('rendered content bounds come from non-transparent output pixels', async () => {
  const overlay = await sharp({ create: { width: 10, height: 10, channels: 4, background: '#00000000' } })
    .composite([{ input: await sharp({ create: { width: 3, height: 2, channels: 4, background: '#ffffffff' } }).png().toBuffer(), left: 4, top: 5 }])
    .png().toBuffer();
  assert.deepEqual(await renderedContentBounds(overlay), { left: 4, top: 5, right: 7, bottom: 7 });
});

test('package validator rejects rendered content outside the declared safe area', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-approval-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await sharp({ create: { width: 100, height: 100, channels: 3, background: '#07583a' } }).jpeg().toFile(path.join(root, 'asset.jpg'));
  const manifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    brand: 'Bona',
    approvalStatus: 'AWAITING APPROVAL — DO NOT PUBLISH OR SCHEDULE',
    rights: 'No photography, external media, or embedded audio.',
    assets: [{ package: 'test', platform: 'instagram', path: 'asset.jpg', kind: 'image', dimensions: [100, 100], safeArea: { top: 10, right: 10, bottom: 10, left: 10 }, contentBounds: { left: 10, top: 10, right: 91, bottom: 90 }, foreground: '#fffaf0', background: '#07583a' }],
    captions: {},
  }));
  const report = await validatePackage({ root, manifestPath });
  assert.ok(report.errors.includes('instagram:asset.jpg:content-bounds: right 91 > 90'));
});
