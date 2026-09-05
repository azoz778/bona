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
  images: { src: string; thumb?: string; alt?: Localised }[];
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
