import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeBoard, checkSiteTag, checkGsc } from '../marketing/verify-integrations.mjs';

test('mergeBoard updates rows by id and appends unknown ids with their metadata', () => {
  const board = [
    { id: 'website', name: 'Website', status: 'live', owner: 'agent', action: 'x', link: 'https://bona.azoz.uk/' },
    { id: 'ga4', name: 'Google Analytics 4', status: 'pending-owner', owner: 'owner', action: 'paste the id', link: 'https://analytics.google.com/' },
  ];
  const merged = mergeBoard(board, [
    { id: 'ga4', status: 'live', detail: 'accepted' },
    { id: 'bona-api', status: 'error', detail: 'down' },
  ], '2026-09-06T00:00:00.000Z');
  assert.equal(merged.length, 3);
  assert.deepEqual(merged[0], board[0], 'untouched rows are kept as they were');
  assert.equal(merged[1].status, 'live');
  assert.equal(merged[1].detail, 'accepted');
  assert.equal(merged[1].checkedAt, '2026-09-06T00:00:00.000Z');
  assert.equal(merged[1].action, 'paste the id', 'existing owner text survives');
  assert.equal(merged[2].id, 'bona-api');
  assert.equal(merged[2].name, 'Concierge API (bona-api)');
  assert.equal(merged[2].status, 'error');
  assert.equal(board.length, 2, 'input is not mutated');
});

test('a site tag is pending-owner when absent, live when served, error when in site.json but not on the page', () => {
  const base = { id: 'meta-pixel', label: 'Meta Pixel', siteKey: 'metaPixel', checklist: 'docs/x.md' };
  assert.equal(checkSiteTag({ ...base, value: null, homeHtml: '<html></html>' }).status, 'pending-owner');
  assert.equal(checkSiteTag({ ...base, value: '123456', homeHtml: '<script>fbq("init","123456")</script>' }).status, 'live');
  assert.equal(checkSiteTag({ ...base, value: '123456', homeHtml: '<html>nothing</html>' }).status, 'error');
});

test('the Search Console tag is found in either attribute order and compared with site.json', () => {
  const site = { url: 'https://bona.azoz.uk', analytics: { gscVerification: 'abc' } };
  assert.equal(checkGsc({ site, homeHtml: '<meta name="google-site-verification" content="abc">' }).status, 'live');
  assert.equal(checkGsc({ site, homeHtml: '<meta content="abc" name="google-site-verification">' }).status, 'live');
  assert.equal(checkGsc({ site, homeHtml: '<meta name="google-site-verification" content="zzz">' }).status, 'error');
  assert.equal(checkGsc({ site: { url: 'https://bona.azoz.uk', analytics: {} }, homeHtml: '<html></html>' }).status, 'pending-owner');
});
