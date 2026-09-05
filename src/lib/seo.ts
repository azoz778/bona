/* STUB — owned by the seo-social agent. Keep these export names/signatures; other agents import them. */
import type { Locale } from './i18n';
import type { Listing } from './listings';

/** Organization / RealEstateAgent JSON-LD for the site (footer/home). */
export function orgJsonLd(_locale: Locale): object { return {}; }
/** Per-listing JSON-LD (RealEstateListing + Residence + Offer). */
export function listingJsonLd(_listing: Listing, _locale: Locale): object { return {}; }
/** BreadcrumbList JSON-LD. items = [{name, path}] */
export function breadcrumbJsonLd(_items: { name: string; path: string }[]): object { return {}; }
/** Default share image URL. */
export const defaultOgImage = '/og-default.png';
