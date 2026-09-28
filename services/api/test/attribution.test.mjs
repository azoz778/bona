import test from 'node:test';
import assert from 'node:assert/strict';
import { REF_RE, REF_ALPHABET, parseRef, sourceFromTouch, isExternalTouch, referrerHost, normaliseTouch } from '../lib/attribution.mjs';

/* ---------------- Ref line ---------------- */

test('the Ref line is read out of a WhatsApp message in every spelling the site produces', () => {
  assert.deepEqual(parseRef('Hello\nRef BONA-W003 · K7Q2XR'), { listingId: 'BONA-W003', code: 'K7Q2XR' });
  assert.deepEqual(parseRef('ref bona - k7q2xr'), { listingId: 'BONA', code: 'K7Q2XR' });
  assert.deepEqual(parseRef('Ref K7Q2X'), { listingId: null, code: 'K7Q2X' });
  assert.deepEqual(parseRef('مرحبا، مهتم بالفيلا\nRef BONA-005: ABCDEF'), { listingId: 'BONA-005', code: 'ABCDEF' });
  assert.deepEqual(parseRef('Ref BONA-W012 | XYZ234 thanks'), { listingId: 'BONA-W012', code: 'XYZ234' });
});

test('every site shape, separator and line break reads as before', () => {
  for (const [text, want] of [
    ['Ref BONA-W003 · K7Q2XR', { listingId: 'BONA-W003', code: 'K7Q2XR' }],
    ['Ref BONA · K7Q2XR', { listingId: 'BONA', code: 'K7Q2XR' }],
    ['Ref K7Q2XR', { listingId: null, code: 'K7Q2XR' }],
    ['Ref BONA-W003 - K7Q2XR', { listingId: 'BONA-W003', code: 'K7Q2XR' }],
    ['Ref BONA-W003:K7Q2XR', { listingId: 'BONA-W003', code: 'K7Q2XR' }],
    ['Ref BONA-W003|K7Q2XR', { listingId: 'BONA-W003', code: 'K7Q2XR' }],
    ['Ref BONA-W003K7Q2XR', { listingId: 'BONA-W003', code: 'K7Q2XR' }],
    ['Ref · K7Q2XR', { listingId: null, code: 'K7Q2XR' }],
    ['Ref\nBONA-W003\n·\nK7Q2XR', { listingId: 'BONA-W003', code: 'K7Q2XR' }],
    ['Ref BONA · K7Q2XR', { listingId: 'BONA', code: 'K7Q2XR' }],
    ['Ref\tBONA\t-\tK7Q2XR', { listingId: 'BONA', code: 'K7Q2XR' }],
    ['Ref BONA-W2345Z', { listingId: 'BONA', code: 'W2345Z' }],
    // Only the shape is checked (lib/inbox/eligibility.mjs decides what a bare code is worth).
    ['ref please', { listingId: null, code: 'PLEASE' }],
    ['Ref bona please', { listingId: 'BONA', code: 'PLEASE' }],
    ['TK booking Ref ABCDEF', { listingId: null, code: 'ABCDEF' }],
  ]) {
    assert.deepEqual(parseRef(text), want, JSON.stringify(text));
  }
  for (const text of ['Refund 12345', 'Ref\n\n', 'Ref BONA', 'Ref BONA-W003 ·', 'xRef K7Q2XR']) {
    assert.equal(parseRef(text), null, JSON.stringify(text));
  }
});

test('the rewritten pattern finds the same line, listing and code as the old one', () => {
  // The pattern before 2026-09-28, kept here only to compare on short strings (it is cubic
  // on long runs of whitespace, see the next test). Same language, same captures.
  const OLD_REF_RE = /\bRef\s+(BONA(?:-W?\d{3})?)?\s*[·\-:|]?\s*([A-HJ-NP-Z2-9]{5,6})\b/i;
  const pieces = ['Ref', 'ref', 'Refund', ' ', '  ', '\n', ' ', '\t', 'BONA', 'bona', '-W003', '-005',
    '-W', '003', '·', ' · ', '-', ':', '|', 'K7Q2XR', 'k7q2x', 'ABCDEF', 'Z', '2', 'x', 'O', '1', 'please', 'é', '_', '٤'];
  const shape = (m) => (m ? [m.index, m[0], m[1] ?? null, m[2]] : null);
  let seed = 20260928;
  const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  for (let i = 0; i < 5000; i += 1) {
    let text = next() % 10 < 7 ? 'Ref' : '';
    for (let n = 1 + (next() % 8); n > 0; n -= 1) text += pieces[next() % pieces.length];
    assert.deepEqual(shape(REF_RE.exec(text)), shape(OLD_REF_RE.exec(text)), JSON.stringify(text));
  }
});

test('a long run of spaces after Ref is read in linear time', () => {
  // The old pattern had three whitespace runs that could share the same spaces
  // (`\s+ (BONA)? \s* [·-:|]? \s*`), so a failed match tried every split of them: 2,000
  // spaces took seconds, and any stranger's WhatsApp message (up to 65,536 characters)
  // could block the event loop, since the poller reads every inbound text with parseRef.
  for (const space of [' ', '\n', ' ']) {
    for (const text of [
      `Ref${space.repeat(20_000)}x`,
      `Ref BONA${space.repeat(20_000)}x`,
      `Ref BONA${space.repeat(10_000)}-${space.repeat(10_000)}x`,
      `Ref${space.repeat(10_000)}·${space.repeat(10_000)}x`,
    ]) {
      const started = performance.now();
      assert.equal(parseRef(text), null);
      const ms = performance.now() - started;
      assert.ok(ms < 100, `${JSON.stringify(space)} × ${text.length}: ${ms.toFixed(1)} ms`);
    }
  }
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

test('the canonical touch contract validates ids, aliases campaign ids, and records availability', () => {
  assert.deepEqual(normaliseTouch({
    ts: 10, utm_source: ' Meta ', utm_medium: ' Paid ', utm_campaign: 'Launch',
    campaign_id: ' 1203 ', utm_content: 'hero', listing_id: 'bona-w003',
    click_ids: { fbclid: ' click-1 ', bad: 'x', gclid: 'x'.repeat(301) },
  }), {
    ts: 10, landing: null, referrer: null, utm_source: 'meta', utm_medium: 'paid',
    utm_campaign: 'Launch', utm_content: 'hero', utm_term: null, utm_id: '1203',
    listing_id: 'BONA-W003', click_ids: { fbclid: 'click-1' }, unavailable_reason: null,
  });
  assert.equal(normaliseTouch({ campaign_id: '<script>', listing_id: 'TK-1' }).utm_id, null);
  assert.equal(normaliseTouch({ campaign_id: 'x'.repeat(65) }).utm_id, null);
  assert.equal(normaliseTouch({}).unavailable_reason, 'direct_or_unknown');
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
