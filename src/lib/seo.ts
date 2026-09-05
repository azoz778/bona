/* SEO helpers — owned by the content/seo agent.
   Public API (imported by other agents — keep names/signatures stable):
     orgJsonLd(locale)              → RealEstateAgent/Organization JSON-LD (links to the founder Person)
     listingJsonLd(listing, locale) → RealEstateListing + residence + Offer JSON-LD (+ 3DModel tour via subjectOf)
     breadcrumbJsonLd(items)        → BreadcrumbList JSON-LD (items = [{name, path}])
     defaultOgImage                 → '/og-default.png'
   Round 2 — new pages (all return a plain object; pass to <Base jsonLd={…}>; Head dedupes by @id):
     personJsonLd(locale)                         → Person (founder) with hasCredential (REGA FAL)
     aboutPageJsonLd(locale, path?)               → [AboutPage, Person]
     collectionPageJsonLd({locale, path, title, description?, listings, image?, tours?})
                                                  → CollectionPage + ItemList (section pages, houses/apartments/land, /tours/)
     privacyPageJsonLd(locale, path?)             → WebPage for /privacy/ with dateModified
     webPageJsonLd({locale, path, title, …})      → WebPage | AboutPage | ContactPage | CollectionPage | ItemPage
     tourJsonLd(listing, locale)                  → 3DModel node for a Matterport tour (undefined when none)
     kindOf(listing) / kindPath(kind, locale) / withTours(listings) / pageKindFromPath(path)
   NOTE: Head.astro adds a WebPage-family node + the founder Person to every page automatically, so pages only
   need to pass what is specific to them (listing, breadcrumb, collection list). Passing a node with the same
   @id as an automatic one simply replaces it.
   Extras (safe to use): websiteJsonLd, absoluteUrl, alternates, pageTitle, ogLocale, listingPath, compact. */
import site from '../data/site.json';
import about from '../data/about.json';
import privacy from '../data/privacy.json';
import { localePath, switchLocalePath, formatPrice, type Locale } from './i18n';
import type { Listing } from './listings';

export const defaultOgImage = '/og-default.png';
export const ORG_ID = `${site.url}/#organization`;
export const WEBSITE_ID = `${site.url}/#website`;
export const FOUNDER_ID = `${site.url}/#founder`;

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
const waUrl = `https://wa.me/${site.whatsapp.wa}`;

// ---------- Round-2 listing fields (kind / project / unit / map) ----------
// listings.ts is owned by the site agent; these optional fields are read defensively here.
type Localised = { en?: string; ar?: string };
export type Kind = 'house' | 'apartment' | 'land' | 'building';
type ListingExt = Listing & {
  kind?: string | null;
  project?: { name?: Localised | null; developer?: Localised | null } | null;
  unit?: { floor?: string | number | null; block?: string | null; unitRef?: string | null } | null;
  map?: { lat: number; lng: number } | null;
};
const KIND_SET = new Set<string>(['house', 'apartment', 'land', 'building']);
import kindMapJson from '../data/kind-map.json';
const TYPE_TO_KIND: Record<string, Kind> = kindMapJson as Record<string, Kind>;

/** The listing's kind: explicit `kind` when valid, else derived from `type` (mirrors LISTING-SCHEMA.md). */
export function kindOf(listing: Pick<Listing, 'type'> & { kind?: string | null }): Kind | 'other' {
  const k = (listing.kind ?? '').toString().trim().toLowerCase();
  if (KIND_SET.has(k)) return k as Kind;
  return TYPE_TO_KIND[(listing.type ?? '').toString().trim().toLowerCase()] ?? 'other';
}

/** Section page for a kind (/properties/houses/ …); undefined for kinds without a section. */
export function kindPath(kind: string, locale: Locale): string | undefined {
  const seg: Record<string, string> = { house: 'houses', apartment: 'apartments', land: 'land', building: 'buildings' };
  return seg[kind] ? localePath(locale, `/properties/${seg[kind]}/`) : undefined;
}

/** Matterport (or any http[s]) tour URL, else undefined. */
export function tourUrl(listing: Pick<Listing, 'virtualTourUrl'>): string | undefined {
  const u = (listing.virtualTourUrl ?? '').toString().trim();
  return /^https?:\/\//i.test(u) ? u : undefined;
}

/** Listings that have a tour (for /tours/). Sold homes excluded. */
export function withTours(list: Listing[]): Listing[] {
  return list.filter((l) => tourUrl(l) && l.status !== 'sold'); // same rule as listings.withTours()
}

// ---------- Organization / RealEstateAgent / Person ----------

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

/** REGA FAL brokerage licence as an EducationalOccupationalCredential (shared by org + founder). */
function falCredential(locale: Locale, id: string | null | undefined) {
  if (!id) return undefined;
  const ar = L(locale) === 'ar';
  return {
    '@type': 'EducationalOccupationalCredential',
    '@id': `${site.url}/#fal-${id}`,
    credentialCategory: 'license',
    name: ar ? 'رخصة فال للوساطة العقارية' : 'FAL real estate brokerage licence',
    identifier: id,
    recognizedBy: {
      '@type': 'GovernmentOrganization',
      name: ar ? 'الهيئة العامة للعقار' : 'Real Estate General Authority (REGA)',
      url: 'https://rega.gov.sa/',
    },
  };
}

/** RealEstateAgent (+ Organization) JSON-LD for the site. Localised strings. */
export function orgJsonLd(locale: Locale): object {
  const l = L(locale);
  const ar = l === 'ar';
  const licences = site.licences as { fal: string | null; cr: string | null };
  const founded = ((about as unknown as { founded?: string }).founded) ?? ((about.stats ?? []).find((s) => /^\d{4}$/.test(String(s.value)))?.value);
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
    foundingDate: founded ?? undefined,
    foundingLocation: { '@type': 'Place', name: site.address[l].city, address: { '@type': 'PostalAddress', addressLocality: site.address.en.city, addressCountry: 'SA' } },
    founder: about.team?.length ? { '@id': FOUNDER_ID } : undefined,
    identifier: [
      licences.fal ? { '@type': 'PropertyValue', propertyID: 'REGA FAL', name: ar ? 'رخصة فال' : 'REGA FAL licence', value: licences.fal } : undefined,
      licences.cr ? { '@type': 'PropertyValue', propertyID: 'CR', name: ar ? 'السجل التجاري' : 'Commercial Registration', value: licences.cr } : undefined,
    ],
    hasCredential: falCredential(locale, licences.fal),
  });
}

/** Founder Person JSON-LD (from about.json → team[0]) with the FAL credential. */
export function personJsonLd(locale: Locale): object {
  const l = L(locale);
  const ar = l === 'ar';
  const m = (about.team ?? [])[0];
  if (!m) return compact({ '@context': 'https://schema.org', '@type': 'Person', '@id': FOUNDER_ID, worksFor: { '@id': ORG_ID } });
  const licence = (m.licence as string | null) ?? (site.licences as { fal: string | null }).fal;
  return compact({
    '@context': 'https://schema.org',
    '@type': 'Person',
    '@id': FOUNDER_ID,
    name: m.name[l] ?? m.name.en,
    alternateName: ar ? m.name.en : m.name.ar,
    jobTitle: m.role[l] ?? m.role.en,
    description: ar
      ? `${m.role.ar} في بونا، بوتيك عقاري خاص في جدة. وسيط عقاري مرخّص من الهيئة العامة للعقار.`
      : `${m.role.en} of Bona, a private real estate boutique in Jeddah. REGA-licensed real estate broker.`,
    image: m.photo ? absoluteUrl(m.photo as string) : undefined,
    url: absoluteUrl(localePath(locale, '/about/')),
    worksFor: { '@id': ORG_ID },
    affiliation: { '@id': ORG_ID },
    workLocation: { '@type': 'Place', address: postalAddress(locale) },
    knowsLanguage: ['ar', 'en'],
    knowsAbout: ar
      ? ['العقارات الفاخرة في جدة', 'الوساطة العقارية', 'العقارات خارج السوق', 'المشاريع على الخارطة']
      : ['Luxury real estate in Jeddah', 'Real estate brokerage', 'Off-market property', 'Off-plan developments'],
    hasCredential: falCredential(locale, licence),
    sameAs: [site.instagram.url],
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

// ---------- Web pages ----------

export type PageKind = 'WebPage' | 'AboutPage' | 'ContactPage' | 'CollectionPage' | 'ItemPage';

/** Which WebPage subtype a path is (locale prefix ignored). */
export function pageKindFromPath(path: string): PageKind {
  const p = (path || '/').replace(/^\/ar(?=\/|$)/, '') || '/';
  if (p === '/about/') return 'AboutPage';
  if (p === '/contact/') return 'ContactPage';
  if (p === '/tours/' || p === '/properties/') return 'CollectionPage';
  if (/^\/properties\/(for-sale|for-rent|off-plan|international|houses|apartments|land|buildings)\/$/.test(p)) return 'CollectionPage';
  if (/^\/properties\/[^/]+\/$/.test(p)) return 'ItemPage';
  return 'WebPage';
}

/** Generic WebPage-family node. @id = <url>#webpage so a page-supplied node overrides the automatic one. */
export function webPageJsonLd(opts: {
  locale: Locale; path: string; title: string; description?: string; type?: PageKind; image?: string;
  mainEntityId?: string; breadcrumbId?: string; datePublished?: string; dateModified?: string;
}): object {
  const url = absoluteUrl(opts.path);
  const type = opts.type ?? pageKindFromPath(opts.path);
  return compact({
    '@context': 'https://schema.org',
    '@type': type,
    '@id': `${url}#webpage`,
    url,
    name: opts.title,
    description: opts.description,
    inLanguage: L(opts.locale),
    isPartOf: { '@id': WEBSITE_ID },
    publisher: { '@id': ORG_ID },
    about: type === 'AboutPage' || type === 'ContactPage' ? { '@id': ORG_ID } : undefined,
    mainEntity: opts.mainEntityId ? { '@id': opts.mainEntityId } : type === 'AboutPage' ? { '@id': ORG_ID } : undefined,
    primaryImageOfPage: opts.image ? { '@type': 'ImageObject', url: absoluteUrl(opts.image) } : undefined,
    breadcrumb: opts.breadcrumbId ? { '@id': opts.breadcrumbId } : undefined,
    datePublished: opts.datePublished,
    dateModified: opts.dateModified,
  });
}

/** /about/: AboutPage (mainEntity = organization) + founder Person. */
export function aboutPageJsonLd(locale: Locale, path?: string): object[] {
  const l = L(locale);
  const p = path ?? localePath(locale, '/about/');
  const story = (about.story?.[l] ?? about.story?.en ?? []).join(' ');
  return [
    webPageJsonLd({ locale, path: p, type: 'AboutPage', title: l === 'ar' ? 'عن بونا' : 'About Bona', description: story.slice(0, 300) }),
    personJsonLd(locale),
  ];
}

/** /privacy/: WebPage with the policy's dates. */
export function privacyPageJsonLd(locale: Locale, path?: string): object {
  const l = L(locale);
  return webPageJsonLd({
    locale,
    path: path ?? localePath(locale, '/privacy/'),
    type: 'WebPage',
    title: privacy.title?.[l] ?? privacy.title?.en ?? 'Privacy policy',
    description: privacy.intro?.[l] ?? privacy.intro?.en,
    datePublished: privacy.updated,
    dateModified: privacy.updated,
  });
}

/** Section / kind / tours pages: CollectionPage whose mainEntity is an ItemList of the listings shown. */
export function collectionPageJsonLd(opts: {
  locale: Locale; path: string; title: string; description?: string; listings: Listing[]; image?: string; tours?: boolean;
}): object {
  const l = L(opts.locale);
  const url = absoluteUrl(opts.path);
  const shown = opts.tours ? withTours(opts.listings) : opts.listings;
  const items = shown.map((x, i) => {
    const pageUrl = absoluteUrl(listingPath(x, opts.locale));
    const name = x.title?.[l] ?? x.title?.en ?? x.id;
    const tour = opts.tours ? tourJsonLd(x, opts.locale) : undefined;
    return compact({
      '@type': 'ListItem',
      position: i + 1,
      url: pageUrl,
      name,
      image: x.images?.[0]?.src,
      item: tour,
    });
  });
  return compact({
    ...(webPageJsonLd({ locale: opts.locale, path: opts.path, type: 'CollectionPage', title: opts.title, description: opts.description, image: opts.image ?? shown[0]?.images?.[0]?.src }) as Record<string, unknown>),
    mainEntity: {
      '@type': 'ItemList',
      '@id': `${url}#list`,
      name: opts.title,
      numberOfItems: items.length,
      itemListOrder: 'https://schema.org/ItemListUnordered',
      itemListElement: items,
    },
  });
}

// ---------- Listings ----------

const residenceType: Record<string, string> = {
  villa: 'House',
  apartment: 'Apartment',
  penthouse: 'Apartment',
  mansion: 'SingleFamilyResidence',
  duplex: 'House',
  townhouse: 'House',
  chalet: 'House',
  building: 'ApartmentComplex',
  land: 'Place',
};
const kindResidenceType: Record<string, string> = { house: 'House', apartment: 'Apartment', land: 'Place', building: 'ApartmentComplex' };

const typeLabel: Record<string, { en: string; ar: string }> = {
  villa: { en: 'Villa', ar: 'فيلا' },
  apartment: { en: 'Apartment', ar: 'شقة' },
  penthouse: { en: 'Penthouse', ar: 'بنتهاوس' },
  mansion: { en: 'Mansion', ar: 'قصر' },
  duplex: { en: 'Duplex', ar: 'دوبلكس' },
  townhouse: { en: 'Townhouse', ar: 'تاون هاوس' },
  chalet: { en: 'Chalet', ar: 'شاليه' },
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

/** 3DModel node for a listing's virtual tour (Matterport). Undefined when the listing has no tour. */
export function tourJsonLd(listing: Listing, locale: Locale): object | undefined {
  const u = tourUrl(listing);
  if (!u) return undefined;
  const l = L(locale);
  const ar = l === 'ar';
  const pageUrl = absoluteUrl(listingPath(listing, locale));
  const name = listing.title?.[l] ?? listing.title?.en ?? listing.id;
  const isMatterport = /matterport\.com/i.test(u);
  return compact({
    '@type': '3DModel',
    '@id': `${pageUrl}#tour`,
    name: ar ? `جولة ثلاثية الأبعاد — ${name}` : `${name} — 3D tour`,
    description: ar ? `جولة افتراضية ثلاثية الأبعاد داخل ${name}.` : `Interactive 3D walkthrough of ${name}.`,
    url: u,
    embedUrl: u,
    encodingFormat: 'text/html',
    isAccessibleForFree: true,
    thumbnailUrl: listing.images?.[0]?.src,
    inLanguage: l,
    about: { '@id': `${pageUrl}#residence` },
    mainEntityOfPage: pageUrl,
    publisher: { '@id': ORG_ID },
    provider: isMatterport ? { '@type': 'Organization', name: 'Matterport', url: 'https://matterport.com/' } : undefined,
  });
}

/** RealEstateListing + residence (House/Apartment/…) + Offer JSON-LD for one listing. */
export function listingJsonLd(listing: Listing, locale: Locale): object {
  const x = listing as ListingExt;
  const l = L(locale);
  const ar = l === 'ar';
  const url = absoluteUrl(listingPath(listing, locale));
  const residenceId = `${url}#residence`;
  const name = listing.title?.[l] ?? listing.title?.en ?? listing.id;
  const description = (listing.description?.[l] ?? listing.description?.en ?? '').trim();
  const images = (listing.images ?? []).map((i) => i.src).filter(Boolean);
  const kind = kindOf(x);
  const residenceKind = residenceType[(listing.type || '').toLowerCase()] ?? kindResidenceType[kind] ?? 'Residence';
  const label = typeLabel[(listing.type || '').toLowerCase()]?.[l] ?? listing.type;
  const isRent = listing.category === 'rent';
  const price = listing.price ?? { amount: null, currency: 'SAR' };
  const hasPrice = !price.onRequest && typeof price.amount === 'number' && price.amount > 0;
  const currency = price.currency || 'SAR';
  const sqm = ar ? 'م²' : 'm²';
  const district = listing.location?.district?.[l] ?? listing.location?.district?.en ?? '';
  const tour = tourJsonLd(listing, locale) as { '@id': string } | undefined;
  const projectName = x.project?.name?.[l] ?? x.project?.name?.en;
  const developer = x.project?.developer?.[l] ?? x.project?.developer?.en;
  const floor = x.unit?.floor;

  const address = compact({
    '@type': 'PostalAddress',
    addressLocality: listing.location?.city?.[l] ?? listing.location?.city?.en,
    addressRegion: district || undefined,
    addressCountry: listing.location?.countryCode ?? 'SA',
  });

  const residence = compact({
    '@type': residenceKind,
    '@id': residenceId,
    name,
    description: description || undefined,
    url,
    image: images,
    address,
    geo: x.map && typeof x.map.lat === 'number' && typeof x.map.lng === 'number'
      ? { '@type': 'GeoCoordinates', latitude: x.map.lat, longitude: x.map.lng }
      : undefined,
    containedInPlace: projectName
      ? { '@type': kind === 'apartment' ? 'ApartmentComplex' : 'Place', name: projectName, address }
      : undefined,
    numberOfRooms: listing.specs?.beds ?? undefined,
    numberOfBedrooms: listing.specs?.beds ?? undefined,
    numberOfBathroomsTotal: listing.specs?.baths ?? undefined,
    floorLevel: floor !== undefined && floor !== null && floor !== '' ? String(floor) : undefined,
    floorSize: listing.specs?.areaSqm ? { '@type': 'QuantitativeValue', value: listing.specs.areaSqm, unitCode: 'MTK', unitText: sqm } : undefined,
    lotSize: listing.specs?.plotSqm ? { '@type': 'QuantitativeValue', value: listing.specs.plotSqm, unitCode: 'MTK', unitText: sqm } : undefined,
    yearBuilt: listing.specs?.yearBuilt ?? undefined,
    numberOfFloors: listing.specs?.floors ?? undefined,
    amenityFeature: (listing.highlights?.[l] ?? []).map((h) => ({ '@type': 'LocationFeatureSpecification', name: h, value: true })),
    additionalProperty: [
      developer ? { '@type': 'PropertyValue', name: ar ? 'المطوّر' : 'Developer', value: developer } : undefined,
      x.unit?.block ? { '@type': 'PropertyValue', name: ar ? 'المبنى' : 'Block', value: x.unit.block } : undefined,
      x.unit?.unitRef ? { '@type': 'PropertyValue', name: ar ? 'رقم الوحدة' : 'Unit', value: x.unit.unitRef } : undefined,
    ],
    subjectOf: tour,
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
    subjectOf: tour ? { '@id': tour['@id'] } : undefined,
    publisher: { '@id': ORG_ID },
    isPartOf: { '@id': WEBSITE_ID },
  });
}

// ---------- Breadcrumbs ----------

/** BreadcrumbList. items = [{name, path}] in order; path may be relative or absolute.
    @id = <last item URL>#breadcrumb so the page's WebPage node can reference it. */
export function breadcrumbJsonLd(items: { name: string; path: string }[]): object {
  const list = items ?? [];
  const last = list[list.length - 1];
  return compact({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    '@id': last ? `${absoluteUrl(last.path)}#breadcrumb` : undefined,
    itemListElement: list.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: absoluteUrl(it.path),
    })),
  });
}
