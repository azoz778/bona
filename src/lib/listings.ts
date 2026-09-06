import raw from '../data/listings.json';
import type { Locale } from './i18n';

export type Localised = { en: string; ar: string };
/** Round-2 section key. REQUIRED in the schema; derived from `type` here when a row is missing it. */
export type Kind = 'house' | 'apartment' | 'land' | 'building';
export interface Listing {
  id: string; slug: string; sourceRef?: string | null;
  status: 'available' | 'reserved' | 'sold';
  category: 'buy' | 'rent' | 'off-plan' | 'international';
  type: string; kind?: Kind; featured?: boolean;
  title: Localised;
  location: { district: Localised; city: Localised; country: Localised; countryCode: string };
  price: { amount: number | null; currency: string; from?: boolean; period?: string | null; onRequest?: boolean };
  specs: { beds?: number | null; baths?: number | null; areaSqm?: number | null; plotSqm?: number | null; yearBuilt?: number | null; floors?: number | null };
  images: { src: string; thumb?: string | null; alt?: Localised }[];
  /** Walkthrough clips (hosted URLs — site-local `/listings/<slug>/v-nn.mp4` or full https). Optional; added post-publish by the WhatsApp intake. */
  videos?: string[];
  description: Localised;
  highlights?: { en: string[]; ar: string[] };
  virtualTourUrl?: string | null; brochureUrl?: string | null; listedAt?: string;
  /** Units inside a development (e.g. Kian Residence). */
  project?: { name: Localised; developer?: Localised | null } | null;
  unit?: { floor?: string | number | null; block?: string | null; unitRef?: string | null } | null;
  /** Land plots: pin for a map link. */
  map?: { lat: number; lng: number } | null;
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
  const k = kindOf(l);
  const sameKind = pool.filter(x => kindOf(x) === k);
  const sameCat = sameKind.filter(x => x.category === l.category);
  const sameCity = sameCat.filter(x => x.location.city.en === l.location.city.en);
  const rest = sameCat.filter(x => !sameCity.includes(x));
  const kindOnly = sameKind.filter(x => !sameCat.includes(x));
  const others = pool.filter(x => !sameKind.includes(x));
  return [...sameCity, ...rest, ...kindOnly, ...others].slice(0, n);
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

/* ---- Round 2: kinds (Houses / Apartments / Land / Buildings) ---- */

export const kinds: Kind[] = ['house', 'apartment', 'land', 'building'];
import kindMapJson from '../data/kind-map.json';
/** Single type→kind map shared with seo.ts, the dashboard and the curate scripts (src/data/kind-map.json). */
export const kindByType: Record<string, Kind> = kindMapJson as Record<string, Kind>;
/** Section of a listing. Uses `kind` when present and valid, else derives it from `type` (schema rule). */
export function kindOf(l: Pick<Listing, 'kind' | 'type'>): Kind {
  if (l.kind && (kinds as string[]).includes(l.kind)) return l.kind;
  return kindByType[(l.type || '').toLowerCase()] ?? 'house';
}
/** URL segment for each kind (/properties/<segment>/). */
export const kindSlug: Record<Kind, string> = { house: 'houses', apartment: 'apartments', land: 'land', building: 'buildings' };
export const kindFromSlug = (slug: string): Kind | undefined => kinds.find(k => kindSlug[k] === slug);
export const kindLabel: Record<Kind, Localised> = {
  house: { en: 'House', ar: 'منزل' }, apartment: { en: 'Apartment', ar: 'شقة' }, land: { en: 'Land', ar: 'أرض' }, building: { en: 'Building', ar: 'عمارة' },
};
export const kindLabelPlural: Record<Kind, Localised> = {
  house: { en: 'Houses', ar: 'منازل' }, apartment: { en: 'Apartments', ar: 'شقق' }, land: { en: 'Land', ar: 'أراضٍ' }, building: { en: 'Buildings', ar: 'عمارات' },
};
export const byKind = (k: Kind): Listing[] => listings.filter(l => kindOf(l) === k);
/** Kinds that actually have listings today (drives optional pages/sections such as Land). */
export const kindsPresent = (): Kind[] => kinds.filter(k => byKind(k).length > 0);
/** Featured listings of one kind (up to n). If fewer than `min` are flagged featured, tops up with the newest available ones. */
export function featuredByKind(k: Kind, n = 6, min = 3): Listing[] {
  const pool = ordered(byKind(k)).filter(l => l.status !== 'sold');
  const feats = pool.filter(l => l.featured);
  const rest = pool.filter(l => !l.featured).slice(0, Math.max(0, min - feats.length));
  return [...feats, ...rest].slice(0, n);
}
/** Distinct categories present in a set of listings (for chip filters on kind pages). */
export function categoriesIn(list: Listing[]): Listing['category'][] {
  return categories.filter(c => list.some(l => l.category === c));
}
/** Slugs that are routes of their own and can never be used by a listing. */
export const reservedSlugs = new Set<string>([...Object.values(kindSlug), ...Object.values(categorySlug)]);

/* ---- Round 2: Matterport tours ---- */

/** Matterport model id when `virtualTourUrl` is a my.matterport.com/show/?m=<id> link, else null. */
export function matterportId(url?: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!/^(my\.)?matterport\.com$/i.test(u.hostname) || !/^\/show\/?$/.test(u.pathname)) return null;
    const id = u.searchParams.get('m');
    return id && /^[A-Za-z0-9_-]{4,64}$/.test(id) ? id : null;
  } catch { return null; }
}
export const hasTour = (l: Listing): boolean => matterportId(l.virtualTourUrl) !== null;
export function tourEmbedUrl(id: string): string {
  return `https://my.matterport.com/show/?m=${encodeURIComponent(id)}&brand=0&play=1&qs=1&help=0`;
}
/** Every listing with an embeddable tour, newest first. */
/** Listings with a live 3D tour (sold homes excluded). Shared by /tours/ and the SEO layer. */
export const withTours = (): Listing[] => ordered(listings).filter(l => hasTour(l) && l.status !== 'sold');

/** Top featured listings with a hero image, for the home slideshow. */
export function heroListings(n = 3): Listing[] {
  // Photographs only: renders/screenshots (PNG) are never hero material.
  const photo = (l: Listing) => l.images?.length && !/\.png(\?|$)|screenshot/i.test(l.images[0].src);
  const pool = featured().filter(photo);
  return (pool.length ? pool : listings.filter(l => l.images?.length)).slice(0, n);
}

/** Alt text for an image in a locale, falling back to the listing title. */
export function imageAlt(img: { alt?: Localised } | undefined, l: Listing, locale: Locale): string {
  const a = img?.alt?.[locale] ?? img?.alt?.en;
  return a || localeTitle(l, locale);
}

/** Categories that currently have at least one listing (empty sections are hidden from nav, chips and footer). */
export const nonEmptyCategories = (): Listing['category'][] => categories.filter(c => byCategory(c).some(l => l.status !== 'sold'));
export const hasCategory = (c: Listing['category']): boolean => nonEmptyCategories().includes(c);
