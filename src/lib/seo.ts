/* SEO helpers — owned by the seo-social agent.
   Public API (imported by other agents — keep names/signatures stable):
     orgJsonLd(locale)              → RealEstateAgent/Organization JSON-LD
     listingJsonLd(listing, locale) → RealEstateListing + residence + Offer JSON-LD
     breadcrumbJsonLd(items)        → BreadcrumbList JSON-LD (items = [{name, path}])
     defaultOgImage                 → '/og-default.png'
   Extras (safe to use): websiteJsonLd, absoluteUrl, alternates, pageTitle, ogLocale, listingPath, compact. */
import site from '../data/site.json';
import { localePath, switchLocalePath, formatPrice, type Locale } from './i18n';
import type { Listing } from './listings';

export const defaultOgImage = '/og-default.png';
export const ORG_ID = `${site.url}/#organization`;
export const WEBSITE_ID = `${site.url}/#website`;

/** Absolute URL on the canonical site origin. Already-absolute URLs pass through. */
export function absoluteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return new URL(path, site.url).href;
}

/** hreflang alternates for a path in either locale: { en, ar, xDefault } (absolute). */
export function alternates(path: string): { en: string; ar: string; xDefault: string } {
  const en = absoluteUrl(switchLocalePath(path, 'en'));
  const ar = absoluteUrl(switchLocalePath(path, 'ar'));
  return { en, ar, xDefault: en };
}

/** Append the brand suffix unless the title already names the brand. */
export function pageTitle(title: string, locale: Locale): string {
  const t = (title ?? '').trim();
  const brand = locale === 'ar' ? site.nameAr : site.name;
  if (!t) return brand;
  if (t.includes(site.name) || t.includes(site.nameAr)) return t;
  return `${t} | ${brand}`;
}

export function ogLocale(locale: Locale): string { return locale === 'ar' ? 'ar_SA' : 'en_US'; }

/** Strip undefined/null/empty values recursively so JSON-LD never carries "undefined". */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) {
    return (value.map(compact).filter((v) => v !== undefined && v !== null) as unknown) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'number' && Number.isNaN(v)) continue;
      const c = compact(v);
      if (Array.isArray(c) && c.length === 0) continue;
      if (typeof c === 'string' && c === '') continue;
      out[k] = c;
    }
    return out as T;
  }
  return value;
}

const L = (locale: Locale): 'en' | 'ar' => (locale === 'ar' ? 'ar' : 'en');

// ---------- Organization / RealEstateAgent ----------

function postalAddress(locale: Locale) {
  const a = site.address[L(locale)];
  return {
    '@type': 'PostalAddress',
    streetAddress: a.street,
    addressLocality: a.city,
    addressRegion: a.region,
    postalCode: a.postalCode,
    addressCountry: 'SA',
  };
}

/** RealEstateAgent (+ Organization) JSON-LD for the site. Localised strings. */
export function orgJsonLd(locale: Locale): object {
  const l = L(locale);
  const ar = l === 'ar';
  const waUrl = `https://wa.me/${site.whatsapp.wa}`;
  const licences = site.licences as { fal: string | null; cr: string | null };
  return compact({
    '@context': 'https://schema.org',
    '@type': ['RealEstateAgent', 'Organization'],
    '@id': ORG_ID,
    name: ar ? site.nameAr : site.name,
    alternateName: ar ? site.name : site.nameAr,
    legalName: site.legalName,
    slogan: site.tagline[l],
    description: site.description[l],
    url: site.url,
    logo: { '@type': 'ImageObject', url: absoluteUrl('/icon-512.png'), width: 512, height: 512 },
    image: absoluteUrl(defaultOgImage),
    telephone: site.phone.e164,
    email: (site.email as string | null) ?? undefined,
    contactPoint: [
      {
        '@type': 'ContactPoint',
        contactType: 'sales',
        telephone: site.whatsapp.e164,
        url: waUrl,
        name: ar ? 'واتساب' : 'WhatsApp',
        availableLanguage: ['en', 'ar'],
        areaServed: 'SA',
      },
    ],
    address: postalAddress(locale),
    geo: { '@type': 'GeoCoordinates', latitude: site.geo.lat, longitude: site.geo.lng },
    areaServed: site.markets[l].map((name) => ({ '@type': 'Place', name })),
    sameAs: [site.instagram.url, waUrl],
    openingHours: 'Su-Th 10:00-19:00',
    openingHoursSpecification: [
      {
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'],
        opens: '10:00',
        closes: '19:00',
      },
    ],
    priceRange: '$$$$',
    currenciesAccepted: 'SAR',
    knowsLanguage: ['en', 'ar'],
    identifier: [
      licences.fal ? { '@type': 'PropertyValue', propertyID: 'REGA FAL', name: ar ? 'رخصة فال' : 'REGA FAL licence', value: licences.fal } : undefined,
      licences.cr ? { '@type': 'PropertyValue', propertyID: 'CR', name: ar ? 'السجل التجاري' : 'Commercial Registration', value: licences.cr } : undefined,
    ],
    hasCredential: licences.fal
      ? {
          '@type': 'EducationalOccupationalCredential',
          credentialCategory: 'license',
          name: ar ? 'رخصة فال للوساطة العقارية' : 'FAL real estate brokerage licence',
          identifier: licences.fal,
          recognizedBy: {
            '@type': 'GovernmentOrganization',
            name: ar ? 'الهيئة العامة للعقار' : 'Real Estate General Authority (REGA)',
            url: 'https://rega.gov.sa/',
          },
        }
      : undefined,
  });
}

/** WebSite JSON-LD (no SearchAction by design — the site has no search endpoint). */
export function websiteJsonLd(locale: Locale): object {
  const l = L(locale);
  return compact({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': WEBSITE_ID,
    name: l === 'ar' ? site.nameAr : site.name,
    alternateName: l === 'ar' ? site.name : site.nameAr,
    url: site.url,
    description: site.description[l],
    inLanguage: ['en', 'ar'],
    publisher: { '@id': ORG_ID },
  });
}

// ---------- Listings ----------

const residenceType: Record<string, string> = {
  villa: 'House',
  apartment: 'Apartment',
  penthouse: 'Apartment',
  mansion: 'SingleFamilyResidence',
  duplex: 'House',
  building: 'ApartmentComplex',
  land: 'Place',
};

const typeLabel: Record<string, { en: string; ar: string }> = {
  villa: { en: 'Villa', ar: 'فيلا' },
  apartment: { en: 'Apartment', ar: 'شقة' },
  penthouse: { en: 'Penthouse', ar: 'بنتهاوس' },
  mansion: { en: 'Mansion', ar: 'قصر' },
  duplex: { en: 'Duplex', ar: 'دوبلكس' },
  building: { en: 'Building', ar: 'عمارة' },
  land: { en: 'Land', ar: 'أرض' },
};

/** Listing page path in a locale (shared convention: /properties/<slug>/). */
export function listingPath(listing: Pick<Listing, 'slug'>, locale: Locale): string {
  return localePath(locale, `/properties/${listing.slug}/`);
}

function availability(status: Listing['status']): string {
  if (status === 'sold') return 'https://schema.org/SoldOut';
  if (status === 'reserved') return 'https://schema.org/LimitedAvailability';
  return 'https://schema.org/InStock';
}

/** RealEstateListing + residence (House/Apartment/…) + Offer JSON-LD for one listing. */
export function listingJsonLd(listing: Listing, locale: Locale): object {
  const l = L(locale);
  const ar = l === 'ar';
  const url = absoluteUrl(listingPath(listing, locale));
  const residenceId = `${url}#residence`;
  const name = listing.title?.[l] ?? listing.title?.en ?? listing.id;
  const description = (listing.description?.[l] ?? listing.description?.en ?? '').trim();
  const images = (listing.images ?? []).map((i) => i.src).filter(Boolean);
  const kind = residenceType[listing.type] ?? 'Residence';
  const label = typeLabel[listing.type]?.[l] ?? listing.type;
  const isRent = listing.category === 'rent';
  const price = listing.price ?? { amount: null, currency: 'SAR' };
  const hasPrice = !price.onRequest && typeof price.amount === 'number' && price.amount > 0;
  const currency = price.currency || 'SAR';
  const sqm = ar ? 'م²' : 'm²';
  const district = listing.location?.district?.[l] ?? listing.location?.district?.en ?? '';

  const address = compact({
    '@type': 'PostalAddress',
    addressLocality: listing.location?.city?.[l] ?? listing.location?.city?.en,
    addressRegion: district || undefined,
    addressCountry: listing.location?.countryCode ?? 'SA',
  });

  const residence = compact({
    '@type': kind,
    '@id': residenceId,
    name,
    description: description || undefined,
    url,
    image: images,
    address,
    numberOfRooms: listing.specs?.beds ?? undefined,
    numberOfBedrooms: listing.specs?.beds ?? undefined,
    numberOfBathroomsTotal: listing.specs?.baths ?? undefined,
    floorSize: listing.specs?.areaSqm ? { '@type': 'QuantitativeValue', value: listing.specs.areaSqm, unitCode: 'MTK', unitText: sqm } : undefined,
    lotSize: listing.specs?.plotSqm ? { '@type': 'QuantitativeValue', value: listing.specs.plotSqm, unitCode: 'MTK', unitText: sqm } : undefined,
    yearBuilt: listing.specs?.yearBuilt ?? undefined,
    numberOfFloors: listing.specs?.floors ?? undefined,
    amenityFeature: (listing.highlights?.[l] ?? []).map((h) => ({ '@type': 'LocationFeatureSpecification', name: h, value: true })),
    tourBookingPage: listing.virtualTourUrl ?? undefined,
  });

  const businessFunction = isRent ? 'http://purl.org/goodrelations/v1#LeaseOut' : 'http://purl.org/goodrelations/v1#Sell';
  const priceSpec = hasPrice && isRent
    ? {
        '@type': 'UnitPriceSpecification',
        price: price.amount,
        priceCurrency: currency,
        unitCode: price.period === 'month' ? 'MON' : 'ANN',
        unitText: price.period === 'month' ? (ar ? 'شهرياً' : 'per month') : (ar ? 'سنوياً' : 'per year'),
      }
    : undefined;

  const offer = compact(
    price.from && hasPrice
      ? {
          '@type': 'AggregateOffer',
          lowPrice: price.amount,
          priceCurrency: currency,
          offerCount: 1,
          availability: availability(listing.status),
          businessFunction,
          url,
          seller: { '@id': ORG_ID },
          itemOffered: { '@id': residenceId },
        }
      : {
          '@type': 'Offer',
          price: hasPrice ? price.amount : undefined,
          priceCurrency: currency,
          priceSpecification: priceSpec,
          description: hasPrice ? undefined : (ar ? 'السعر عند الطلب' : 'Price on request'),
          availability: availability(listing.status),
          businessFunction,
          url,
          seller: { '@id': ORG_ID },
          itemOffered: { '@id': residenceId },
          validFrom: listing.listedAt ?? undefined,
        },
  );

  return compact({
    '@context': 'https://schema.org',
    '@type': 'RealEstateListing',
    '@id': `${url}#listing`,
    name,
    headline: district ? `${label} · ${district}` : label,
    description: description || `${name} — ${formatPrice(price, l)}`,
    url,
    inLanguage: l,
    image: images,
    datePosted: listing.listedAt ?? undefined,
    identifier: listing.id,
    leaseLength: isRent && price.period ? { '@type': 'QuantitativeValue', value: 1, unitCode: price.period === 'month' ? 'MON' : 'ANN' } : undefined,
    about: { '@id': residenceId },
    mainEntity: residence,
    offers: offer,
    publisher: { '@id': ORG_ID },
    isPartOf: { '@id': WEBSITE_ID },
  });
}

// ---------- Breadcrumbs ----------

/** BreadcrumbList. items = [{name, path}] in order; path may be relative or absolute. */
export function breadcrumbJsonLd(items: { name: string; path: string }[]): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: (items ?? []).map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: absoluteUrl(it.path),
    })),
  };
}
