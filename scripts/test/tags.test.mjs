/* src/scripts/tags.js — the consent-gated tag loader.
   Two promises are tested here, because both are load-bearing and neither is visible in a build:
     1. a tag whose id is null in site.json → analytics is inert: nothing is requested, ever;
     2. nothing third-party is requested before the visitor has accepted in the consent banner. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWindow } from './dom.mjs';

const IDS = { ga4: 'G-ABC123', metaPixel: '111222333', snapPixel: 'aaaa-bbbb', tiktokPixel: 'CTIK123' };

const HOSTS = {
  ga: 'googletagmanager.com',
  meta: 'connect.facebook.net',
  snap: 'sc-static.net',
  tiktok: 'analytics.tiktok.com',
};

const asked = (injected, key) => injected.filter((u) => u.includes(HOSTS[key])).length;

test('with every id null nothing is requested, whatever the visitor accepted', () => {
  const dom = makeWindow({ tags: { ga4: null, metaPixel: null, snapPixel: null, tiktokPixel: null }, consent: { v: 1, analytics: true, ads: true, ts: 1 } });
  dom.run('tags.js');
  assert.deepEqual(dom.injected, [], 'this is the state the site ships in today');
  // And it still does not throw when something asks it to load again.
  dom.win.bonaTagsLoad();
  assert.deepEqual(dom.injected, []);
});

test('with real ids but no consent record, nothing is requested', () => {
  const dom = makeWindow({ tags: IDS, consent: null });
  dom.run('tags.js');
  assert.deepEqual(dom.injected, [], 'the banner has not been answered yet');
  assert.equal(dom.win.gtag, undefined, 'not even the gtag stub exists yet');
});

test('"Essential only" is a refusal, not a partial yes', () => {
  const dom = makeWindow({ tags: IDS });
  dom.run('tags.js');
  dom.setConsent(false, false);
  dom.win.bonaTagsLoad();
  assert.deepEqual(dom.injected, []);
});

test('accepting analytics alone loads GA4 and nothing else', () => {
  const dom = makeWindow({ tags: IDS });
  dom.run('tags.js');
  dom.setConsent(true, false);
  dom.win.bonaTagsLoad();
  assert.equal(asked(dom.injected, 'ga'), 1);
  assert.equal(asked(dom.injected, 'meta'), 0);
  assert.equal(asked(dom.injected, 'snap'), 0);
  assert.equal(asked(dom.injected, 'tiktok'), 0, 'the ad pixels ride on the ads choice, not the analytics one');
  // Consent Mode v2: analytics granted, everything advertising still denied.
  const update = dom.win.dataLayer.map((a) => [...a]).filter((a) => a[0] === 'consent' && a[1] === 'update').pop();
  assert.deepEqual({ ...update[2] }, { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
});

test('accepting everything loads all four, each exactly once', () => {
  const dom = makeWindow({ tags: IDS });
  dom.run('tags.js');
  dom.setConsent(true, true);
  dom.win.bonaTagsLoad();
  for (const key of Object.keys(HOSTS)) assert.equal(asked(dom.injected, key), 1, key);
  assert.ok(dom.injected.some((u) => u.includes(`id=${IDS.ga4}`)), 'the GA4 id travels in the loader URL');
  assert.ok(dom.injected.some((u) => u.includes(`sdkid=${IDS.tiktokPixel}`)), 'the TikTok id travels in the loader URL');
  // Loading twice must not give the owner two pixels on one page.
  dom.win.bonaTagsLoad();
  for (const key of Object.keys(HOSTS)) assert.equal(asked(dom.injected, key), 1, `${key} after a second load`);
});

test('a partly configured site loads only what it has ids for', () => {
  const dom = makeWindow({ tags: { ga4: IDS.ga4, metaPixel: null, snapPixel: null, tiktokPixel: IDS.tiktokPixel } });
  dom.run('tags.js');
  dom.setConsent(true, true);
  dom.win.bonaTagsLoad();
  assert.equal(asked(dom.injected, 'ga'), 1);
  assert.equal(asked(dom.injected, 'tiktok'), 1);
  assert.equal(asked(dom.injected, 'meta'), 0);
  assert.equal(asked(dom.injected, 'snap'), 0);
});

test('every loaded tag is told about the page it woke up on, once', () => {
  const dom = makeWindow({ tags: IDS });
  dom.run('tags.js');
  dom.setConsent(true, true);
  dom.win.bonaTagsLoad();

  const gaEvents = dom.win.dataLayer.map((a) => [...a]).filter((a) => a[0] === 'event' && a[1] === 'page_view');
  assert.equal(gaEvents.length, 1);
  assert.deepEqual(dom.win.fbq.queue.map((a) => [...a]).filter((a) => a[0] === 'track' && a[1] === 'PageView').length, 1);
  assert.equal(dom.win.snaptr.queue.filter((a) => a[1] === 'PAGE_VIEW').length, 1);
  assert.equal(dom.win.ttq.filter((a) => a[0] === 'page').length, 1);

  // Asking again on the same URL is not another page view.
  dom.win.bonaTagsLoad();
  assert.equal(dom.win.dataLayer.map((a) => [...a]).filter((a) => a[0] === 'event' && a[1] === 'page_view').length, 1);
});

test('the loader never throws, whatever the storage or the config does', () => {
  const dom = makeWindow({ tags: IDS });
  // A browser with site data blocked throws on read, which must not take the page down.
  dom.win.localStorage.getItem = () => { throw new Error('SecurityError'); };
  assert.doesNotThrow(() => dom.run('tags.js'));
  assert.deepEqual(dom.injected, []);

  const junk = makeWindow({ tags: 'not-an-object', consent: { v: 1, analytics: true, ads: true, ts: 1 } });
  assert.doesNotThrow(() => junk.run('tags.js'));
  assert.deepEqual(junk.injected, []);
});
