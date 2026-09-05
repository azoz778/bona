import raw from '../data/listings.json';
import type { Locale } from './i18n';

export type Localised = { en: string; ar: string };
export interface Listing {
  id: string; slug: string; sourceRef?: string | null;
  status: 'available' | 'reserved' | 'sold';
  category: 'buy' | 'rent' | 'off-plan' | 'international';
  type: string; featured?: boolean;
  title: Localised;
  location: { district: Localised; city: Localised; country: Localised; countryCode: string };
  price: { amount: number | null; currency: string; from?: boolean; period?: string | null; onRequest?: boolean };
  specs: { beds?: number | null; baths?: number | null; areaSqm?: number | null; plotSqm?: number | null; yearBuilt?: number | null; floors?: number | null };
  images: { src: string; thumb?: string | null; alt?: Localised }[];
  description: Localised;
  highlights?: { en: string[]; ar: string[] };
  virtualTourUrl?: string | null; brochureUrl?: string | null; listedAt?: string;
}

export const listings: Listing[] = raw as Listing[];
export const featured = (): Listing[] => listings.filter(l => l.featured && l.status !== 'sold').slice(0, 9);
export const byCategory = (c: Listing['category']): Listing[] => listings.filter(l => l.category === c);
export const bySlug = (slug: string): Listing | undefined => listings.find(l => l.slug === slug);
export const categories: Listing['category'][] = ['buy', 'rent', 'off-plan', 'international'];
export const categoryLabel: Record<Listing['category'], Localised> = {
  buy: { en: 'For Sale', ar: 'للبيع' }, rent: { en: 'For Rent', ar: 'للإيجار' },
  'off-plan': { en: 'Off-Plan', ar: 'على الخارطة' }, international: { en: 'International', ar: 'عقارات دولية' },
};
export function localeTitle(l: Listing, locale: Locale) { return l.title[locale] ?? l.title.en; }

/* ---- Site-agent helpers (routing, labels, ordering) ---- */

/** URL segment for each category (/properties/<segment>/). */
export const categorySlug: Record<Listing['category'], string> = {
  buy: 'for-sale', rent: 'for-rent', 'off-plan': 'off-plan', international: 'international',
};
export const categoryFromSlug = (slug: string): Listing['category'] | undefined =>
  (Object.keys(categorySlug) as Listing['category'][]).find(c => categorySlug[c] === slug);

/** Property type labels. Unknown types fall back to a capitalised English word. */
const typeLabels: Record<string, Localised> = {
  villa: { en: 'Villa', ar: 'فيلا' }, apartment: { en: 'Apartment', ar: 'شقة' }, penthouse: { en: 'Penthouse', ar: 'بنتهاوس' },
  mansion: { en: 'Mansion', ar: 'قصر' }, land: { en: 'Land', ar: 'أرض' }, building: { en: 'Building', ar: 'عمارة' },
  duplex: { en: 'Duplex', ar: 'دوبلكس' }, townhouse: { en: 'Townhouse', ar: 'تاون هاوس' }, chalet: { en: 'Chalet', ar: 'شاليه' },
  office: { en: 'Office', ar: 'مكتب' }, residence: { en: 'Residence', ar: 'مسكن' },
};
export function typeLabel(type: string, locale: Locale): string {
  const key = (type || '').toLowerCase();
  const l = typeLabels[key];
  if (l) return l[locale] ?? l.en;
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : '';
}
/** Distinct property types present in a set of listings (for filter selects). */
export function typesIn(list: Listing[]): string[] {
  return [...new Set(list.map(l => (l.type || '').toLowerCase()).filter(Boolean))].sort();
}

/** Listings sorted newest first, available before reserved before sold. */
const statusRank: Record<Listing['status'], number> = { available: 0, reserved: 1, sold: 2 };
export function ordered(list: Listing[] = listings): Listing[] {
  return [...list].sort((a, b) => (statusRank[a.status] - statusRank[b.status]) || ((b.listedAt ?? '').localeCompare(a.listedAt ?? '')));
}

/** Comparable price for client-side sorting; on-request prices sort last. */
/** Approximate SAR conversion used ONLY for sorting (never displayed). */
const SAR_RATE: Record<string, number> = { SAR: 1, AED: 1.02, USD: 3.75, EUR: 4.05, GBP: 4.75, OMR: 9.75 };
/** Sort key: price normalised to SAR; monthly rents annualised; unknown/on-request sorts last. */
export function sortablePrice(l: Listing): number {
  if (!l.price || l.price.onRequest || l.price.amount == null) return Number.MAX_SAFE_INTEGER;
  const rate = SAR_RATE[l.price.currency] ?? 1;
  const annual = l.price.period === 'month' ? l.price.amount * 12 : l.price.amount;
  return Math.round(annual * rate);
}

/** Similar residences: same category, then same city, excluding the listing itself. */
export function similar(l: Listing, n = 3): Listing[] {
  const pool = listings.filter(x => x.slug !== l.slug && x.status !== 'sold');
  const sameCat = pool.filter(x => x.category === l.category);
  const sameCity = sameCat.filter(x => x.location.city.en === l.location.city.en);
  const rest = sameCat.filter(x => !sameCity.includes(x));
  const others = pool.filter(x => !sameCat.includes(x));
  return [...sameCity, ...rest, ...others].slice(0, n);
}

/** The hero image of the home page = first featured listing's first image. */
export function heroListing(): Listing | undefined { return featured()[0] ?? listings[0]; }

/** Editorial images for brand pages, drawn from the portfolio (never hard-coded URLs). `pick` chooses which image of each listing. */
export function editorialImage(index = 0, pick = 1): Listing['images'][number] | undefined {
  const pool = ordered(listings).filter(l => l.images?.length);
  if (!pool.length) return undefined;
  const l = pool[index % pool.length];
  return l.images[Math.min(pick, l.images.length - 1)] ?? l.images[0];
}

/** Alt text for an image in a locale, falling back to the listing title. */
export function imageAlt(img: { alt?: Localised } | undefined, l: Listing, locale: Locale): string {
  const a = img?.alt?.[locale] ?? img?.alt?.en;
  return a || localeTitle(l, locale);
}
