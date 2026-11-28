import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createConciergeLifecycle } from '../src/components/concierge/lifecycle.mjs';
import { classifyPdf } from '../services/intake/lib/classify.mjs';
import { parseCaption } from '../services/intake/lib/commands.mjs';

const read = (relative) => readFile(new URL(relative, import.meta.url), 'utf8');
const decodeAttribute = (value) => value
  .replaceAll('&quot;', '"')
  .replaceAll('&#39;', "'")
  .replaceAll('&amp;', '&')
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>');

function conciergeConfig(html, route) {
  const value = html.match(/\bdata-concierge\b[^>]*\bdata-config="([^"]+)"/)?.[1];
  assert.ok(value, `${route}: Dana's server-rendered mount is missing its data-config boundary`);
  return JSON.parse(decodeAttribute(value));
}

test('the built English and Arabic entry points keep their locale and Dana mount', async () => {
  const entries = [
    { route: '/', file: '../dist/index.html', locale: 'en', dir: 'ltr', name: 'Dana' },
    { route: '/ar/', file: '../dist/ar/index.html', locale: 'ar', dir: 'rtl', name: 'دانة' },
  ];

  for (const entry of entries) {
    const html = await read(entry.file);
    assert.match(html, new RegExp(`<html lang="${entry.locale}" dir="${entry.dir}"`), `${entry.route}: document locale`);
    assert.match(html, /<main id="main"/, `${entry.route}: main entry point`);
    const config = conciergeConfig(html, entry.route);
    assert.equal(config.enabled, true, `${entry.route}: Dana should be enabled`);
    assert.equal(config.locale, entry.locale, `${entry.route}: Dana should inherit the page locale`);
    assert.equal(config.name, entry.name, `${entry.route}: Dana's localized name`);
  }
});

test('Dana initializes once per mount and releases the controller at Astro boundaries', () => {
  const first = { id: 'en-mount' };
  const second = { id: 'ar-mount' };
  let root = first;
  const calls = [];
  const lifecycle = createConciergeLifecycle({
    findRoot: () => root,
    bind: mount => calls.push(['bind', mount.id]),
    unbind: () => calls.push(['unbind']),
    dispose: () => calls.push(['dispose']),
  });

  lifecycle.pageLoad();
  lifecycle.pageLoad();
  root = null;
  lifecycle.pageLoad();
  root = second;
  lifecycle.pageLoad();
  lifecycle.beforeSwap();
  lifecycle.beforeSwap();
  lifecycle.pageHide();

  assert.deepEqual(calls, [
    ['bind', 'en-mount'],
    ['unbind'],
    ['bind', 'ar-mount'],
    ['unbind'],
    ['dispose'],
  ]);
});

test('a synthetic listing-intake fixture crosses the local brochure and caption parsers', async () => {
  const fixture = JSON.parse(await read('./fixtures/regression/listing-intake.json'));
  const brochure = classifyPdf(fixture.extraction, { fileName: fixture.fileName });
  assert.equal(brochure.ok, true, brochure.reason);

  const caption = parseCaption(fixture.caption);
  for (const [key, expected] of Object.entries(fixture.expected)) {
    assert.deepEqual(caption[key], expected, `caption.${key}`);
  }
});
