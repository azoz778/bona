import listings from '../data/listings.json';
import site from '../data/site.json';
import { publicListing } from '../../scripts/social/lib/property-daily.mjs';

export const prerender = true;
export function GET() {
  return new Response(JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    advertiser: { ...site.advertiser, phone: site.phone.e164 },
    listings: listings.map(publicListing)
  }), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' } });
}
