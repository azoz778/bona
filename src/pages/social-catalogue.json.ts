import listings from '../data/listings.json';
import site from '../data/site.json';
import { publicListing } from '../../scripts/social/lib/property-daily.mjs';

export const prerender = true;
export function GET() {
  return new Response(JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    // The REGA advertiser line on property posts: the number on the REGA ad licences (site.advertiser.phone),
    // not the site's contact phone, which moved to Bona's own number on 2026-11-26. Every approved property
    // review hashes this object (property-daily.mjs advertiserFingerprint); changing it needs the REGA records
    // updated and all reviews drafted and approved again (test/social-catalogue-advertiser.test.mjs).
    advertiser: { ...site.advertiser, phone: site.advertiser.phone ?? site.phone.e164 },
    listings: listings.map(publicListing)
  }), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' } });
}
