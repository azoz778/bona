import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
const config = (file) => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8').match(/window\.BONA_TAGS=([^;]+);/)[1]);
test('the built internal dashboard excludes TikTok while public pages retain the configured Pixel', () => {
  assert.equal(config('../dist/dashboard/index.html').tiktokPixel, null);
  assert.equal(config('../dist/index.html').tiktokPixel, 'DASP9PBC77U0AVP50NEG');
});
