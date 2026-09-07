import test from 'node:test';
import assert from 'node:assert/strict';
import { REF_RE, REF_ALPHABET, parseRef, sourceFromTouch, isExternalTouch, referrerHost } from '../lib/attribution.mjs';

/* ---------------- Ref line ---------------- */

test('the Ref line is read out of a WhatsApp message in every spelling the site produces', () => {
  assert.deepEqual(parseRef('Hello\nRef BONA-W003 · K7Q2XR'), { listingId: 'BONA-W003', code: 'K7Q2XR' });
  assert.deepEqual(parseRef('ref bona - k7q2xr'), { listingId: 'BONA', code: 'K7Q2XR' });
  assert.deepEqual(parseRef('Ref K7Q2X'), { listingId: null, code: 'K7Q2X' });
  assert.deepEqual(parseRef('مرحبا، مهتم بالفيلا\nRef BONA-005: ABCDEF'), { listingId: 'BONA-005', code: 'ABCDEF' });
  assert.deepEqual(parseRef('Ref BONA-W012 | XYZ234 thanks'), { listingId: 'BONA-W012', code: 'XYZ234' });
});

test('things that are not a Ref line are left alone', () => {
  assert.equal(parseRef('no ref'), null);
  assert.equal(parseRef('Refund 12345'), null);
  assert.equal(parseRef('Ref 12345'), null, 'digits 0 and 1 are not in the alphabet');
  assert.equal(parseRef('Ref K7Q2XRZZ'), null, 'seven characters is not a code');
  assert.equal(parseRef(''), null);
  assert.equal(parseRef(null), null);
  assert.equal(REF_ALPHABET, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789');
  assert.ok(REF_RE instanceof RegExp);
});

/* ---------------- source resolution ---------------- */

test('UTMs win over everything else', () => {
  assert.deepEqual(
    sourceFromTouch({ utm_source: 'meta', utm_medium: 'paid', utm_campaign: 'villas_sep', utm_id: '1203', click_ids: { fbclid: 'x' }, referrer: 'https://www.google.com/' }),
    { source: 'meta', medium: 'paid', campaign: 'villas_sep', campaign_id: '1203', content: null, click_ids: { fbclid: 'x' } },
  );
  assert.deepEqual(
    sourceFromTouch({ utm_source: 'newsletter', utm_content: 'sep-issue' }),
    { source: 'newsletter', medium: '(not set)', campaign: null, campaign_id: null, content: 'sep-issue', click_ids: null },
  );
});

test('a click id names the platform when there is no UTM', () => {
  assert.deepEqual(sourceFromTouch({ click_ids: { fbclid: 'x' } }), { source: 'meta', medium: 'paid', campaign: null, campaign_id: null, content: null, click_ids: { fbclid: 'x' } });
  assert.equal(sourceFromTouch({ click_ids: { gclid: 'x' } }).source, 'google');
  assert.equal(sourceFromTouch({ click_ids: { gclid: 'x' } }).medium, 'cpc');
  assert.equal(sourceFromTouch({ click_ids: { gbraid: 'x' } }).source, 'google');
  assert.equal(sourceFromTouch({ click_ids: { wbraid: 'x' } }).source, 'google');
  assert.equal(sourceFromTouch({ click_ids: { ScCid: 'x' } }).source, 'snapchat');
  assert.equal(sourceFromTouch({ click_ids: { ttclid: 'x' } }).source, 'tiktok');
  assert.equal(sourceFromTouch({ click_ids: { ttclid: 'x' } }).medium, 'paid');
});

test('a referrer is a social or search host, or a plain referral', () => {
  assert.deepEqual(sourceFromTouch({ referrer: 'https://www.instagram.com/p/abc/' }), { source: 'instagram.com', medium: 'social_or_organic', campaign: null, campaign_id: null, content: null, click_ids: null });
  assert.equal(sourceFromTouch({ referrer: 'https://l.instagram.com/' }).source, 'l.instagram.com');
  assert.equal(sourceFromTouch({ referrer: 'https://www.google.com/' }).medium, 'social_or_organic');
  assert.equal(sourceFromTouch({ referrer: 'https://x.com/bona' }).medium, 'social_or_organic');
  assert.equal(sourceFromTouch({ referrer: 'https://blog.example.com/best-villas' }).source, 'blog.example.com');
  assert.equal(sourceFromTouch({ referrer: 'https://blog.example.com/best-villas' }).medium, 'referral');
  assert.equal(sourceFromTouch({ referrer: 'not a url' }).source, '(direct)');
  assert.equal(referrerHost('https://WWW.Facebook.com/x'), 'facebook.com');
  assert.equal(referrerHost(''), null);
});

test('nothing at all is a direct visit', () => {
  const direct = { source: '(direct)', medium: '(none)', campaign: null, campaign_id: null, content: null, click_ids: null };
  assert.deepEqual(sourceFromTouch(null), direct);
  assert.deepEqual(sourceFromTouch({}), direct);
  assert.deepEqual(sourceFromTouch({ referrer: '', click_ids: {}, utm_source: '' }), direct);
});

test('an external touch is a UTM, a click id, or a referrer from another site', () => {
  assert.equal(isExternalTouch({ utm_source: 'meta' }), true);
  assert.equal(isExternalTouch({ click_ids: { gclid: 'x' } }), true);
  assert.equal(isExternalTouch({ referrer: 'https://www.instagram.com/' }), true);
  assert.equal(isExternalTouch({ referrer: 'https://bona.azoz.uk/properties/' }), false, 'our own pages are not a new arrival');
  assert.equal(isExternalTouch({ referrer: 'https://www.bona.com.sa/' }), false);
  assert.equal(isExternalTouch({ referrer: 'https://bona.example/' , }, { ownHosts: ['bona.example'] }), false);
  assert.equal(isExternalTouch({}), false);
  assert.equal(isExternalTouch(null), false);
});
