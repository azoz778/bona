/* Build-time numbers for the dashboard overview. Pure functions over the listings
   schema (src/data/LISTING-SCHEMA.md) so they keep working when the data agent
   swaps in the real inventory. */
import type { Listing } from '../listings';

export interface ListingStats {
  total: number;
  available: number;
  reserved: number;
  sold: number;
  featured: number;
  byCategory: { key: Listing['category']; label: string; count: number }[];
  byDistrict: { district: string; count: number }[];
  images: number;
  missingImages: number; // listings with fewer than 4 images (schema minimum)
  priceOnRequest: number;
}

const categoryOrder: { key: Listing['category']; label: string }[] = [
  { key: 'buy', label: 'For sale' },
  { key: 'rent', label: 'For rent' },
  { key: 'off-plan', label: 'Off-plan' },
  { key: 'international', label: 'International' },
];

export function listingStats(listings: Listing[], topDistricts = 8): ListingStats {
  const districts = new Map<string, number>();
  let images = 0, missingImages = 0, priceOnRequest = 0;
  for (const l of listings) {
    const d = (l.location?.district?.en || l.location?.city?.en || 'Unknown').trim();
    districts.set(d, (districts.get(d) ?? 0) + 1);
    const n = Array.isArray(l.images) ? l.images.length : 0;
    images += n;
    if (n < 4) missingImages++;
    if (l.price?.onRequest || l.price?.amount == null) priceOnRequest++;
  }
  const byDistrict = [...districts.entries()]
    .map(([district, count]) => ({ district, count }))
    .sort((a, b) => b.count - a.count || a.district.localeCompare(b.district))
    .slice(0, topDistricts);

  return {
    total: listings.length,
    available: listings.filter(l => l.status === 'available').length,
    reserved: listings.filter(l => l.status === 'reserved').length,
    sold: listings.filter(l => l.status === 'sold').length,
    featured: listings.filter(l => l.featured).length,
    byCategory: categoryOrder.map(c => ({ ...c, count: listings.filter(l => l.category === c.key).length })),
    byDistrict,
    images,
    missingImages,
    priceOnRequest,
  };
}

/** Compact figure for stat tiles: 1,284 / 12.9K / 4.2M. */
export function compact(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return new Intl.NumberFormat('en-US').format(n);
}

/** Slim listing summary handed to the browser (lead form select, share links). */
export interface ListingSummary { id: string; slug: string; title: string; titleAr: string; district: string; status: string; category: string }
export function summaries(listings: Listing[]): ListingSummary[] {
  return listings.map(l => ({
    id: l.id, slug: l.slug,
    title: l.title?.en ?? l.id, titleAr: l.title?.ar ?? '',
    district: l.location?.district?.en ?? '',
    status: l.status, category: l.category,
  }));
}
