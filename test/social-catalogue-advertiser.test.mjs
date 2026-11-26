// The REGA advertiser line on property posts (dist/social-catalogue.json `advertiser`) is what every approved
// property review hashes (scripts/social/lib/property-daily.mjs advertiserFingerprint, eligibility). The site's
// contact phone moved to Bona's own number on 2026-11-26 while the REGA ad licences still list the owner's
// number, so the advertiser keeps site.advertiser.phone. Any change to it stops every daily property post
// ("advertiser_changed_since_review") until the reviews are drafted and approved again.
//
// Changing the advertiser on purpose (the owner has updated the REGA records):
//   1. In the same PR as the site.advertiser change, write marketing/daily/advertiser-change.json:
//        { "advertiserSha256": "<the fingerprint this test prints when it fails>",
//          "date": "YYYY-MM-DD", "reason": "REGA records updated to the new number" }
//      The test then lets approved reviews keep the old fingerprint, so CI and the deploy stay green.
//   2. After the deploy, draft and approve every property review again (draft-property-reviews.mjs and
//      approve-property-review.mjs read the LIVE catalogue, so this cannot happen before the merge).
//      Until then the daily property posts stop on their own; nothing else is affected.
// An advertiser that changes without that file, or with a fingerprint that is not the built one, still fails.
// No approved review at all (every property withdrawn) is a legitimate state: there is nothing to protect.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { advertiserFingerprint } from '../scripts/social/lib/property-daily.mjs';

const read = (rel) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
const CHANGE = new URL('../marketing/daily/advertiser-change.json', import.meta.url);

test('every approved property review still matches the advertiser the built site publishes, unless the change is declared', () => {
  const catalogue = read('../dist/social-catalogue.json');
  const site = read('../src/data/site.json');
  const reviews = read('../marketing/daily/property-reviews.json');
  const approved = Object.entries(reviews).filter(([, r]) => r && typeof r === 'object' && r.status === 'approved');
  const fp = advertiserFingerprint(catalogue.advertiser);
  const stale = approved.filter(([, r]) => r.advertiserSha256 !== fp).map(([id]) => id);
  if (stale.length) {
    const change = fs.existsSync(CHANGE) ? JSON.parse(fs.readFileSync(CHANGE, 'utf8')) : null;
    assert.equal(change?.advertiserSha256, fp,
      `${stale.join(', ')}: advertiser changed since review. The built advertiser's fingerprint is ${fp}. `
      + 'If the change is intended (REGA records updated), declare it in marketing/daily/advertiser-change.json '
      + 'and approve every property review again after the deploy (see this file\'s header).');
  }
  assert.equal(catalogue.advertiser.phone, site.advertiser.phone, 'the REGA-registered number, not the contact phone');
  assert.match(catalogue.advertiser.phone, /^\+\d{8,15}$/);
});
