// The REGA advertiser line on property posts (dist/social-catalogue.json `advertiser`) is what every approved
// property review hashes (scripts/social/lib/property-daily.mjs advertiserFingerprint, eligibility). The site's
// contact phone moved to Bona's own number on 2026-11-26 while the REGA ad licences still list the owner's
// number, so the advertiser keeps site.advertiser.phone: a change here stops every daily property post
// ("advertiser_changed_since_review") until the REGA records are updated and all reviews approved again.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { advertiserFingerprint } from '../scripts/social/lib/property-daily.mjs';

const read = (rel) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));

test('every approved property review still matches the advertiser the built site publishes', () => {
  const catalogue = read('../dist/social-catalogue.json');
  const site = read('../src/data/site.json');
  const reviews = read('../marketing/daily/property-reviews.json');
  const approved = Object.entries(reviews).filter(([, r]) => r && typeof r === 'object' && r.status === 'approved');
  assert.ok(approved.length > 0, 'there are approved reviews to protect');
  const fp = advertiserFingerprint(catalogue.advertiser);
  for (const [id, r] of approved) assert.equal(r.advertiserSha256, fp, `${id}: advertiser changed since review`);
  assert.equal(catalogue.advertiser.phone, site.advertiser.phone, 'the REGA-registered number, not the contact phone');
  assert.match(catalogue.advertiser.phone, /^\+\d{8,15}$/);
});
