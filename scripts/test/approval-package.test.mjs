import test from 'node:test';
import assert from 'node:assert/strict';
import { contrast, hasArabic, hasLatin, luminance } from '../social/validate-approval-package.mjs';

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
