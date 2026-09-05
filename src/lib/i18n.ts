export type Locale = 'en' | 'ar';
export const locales: Locale[] = ['en', 'ar'];
export const defaultLocale: Locale = 'en';

export function dir(locale: Locale): 'ltr' | 'rtl' { return locale === 'ar' ? 'rtl' : 'ltr'; }

/** Localised path: en => '/x/', ar => '/ar/x/'. Always trailing slash. */
export function localePath(locale: Locale, path = '/'): string {
  let p = path.startsWith('/') ? path : `/${path}`;
  if (!p.endsWith('/')) p += '/';
  return locale === 'en' ? p : `/ar${p}`;
}

/** Given a current pathname, return the equivalent path in the other locale. */
export function switchLocalePath(current: string, to: Locale): string {
  const stripped = current.replace(/^\/ar(?=\/|$)/, '') || '/';
  return localePath(to, stripped);
}

export function localeFromPath(pathname: string): Locale {
  return /^\/ar(\/|$)/.test(pathname) ? 'ar' : 'en';
}

/** Pick a localised string from {en, ar} objects, falling back to en. */
export function t<T = string>(obj: { en: T; ar?: T } | undefined | null, locale: Locale): T {
  if (!obj) return '' as unknown as T;
  return (obj[locale] ?? obj.en) as T;
}

const currencyLabel: Record<string, { en: string; ar: string }> = {
  SAR: { en: 'SAR', ar: 'ر.س' }, AED: { en: 'AED', ar: 'د.إ' }, EUR: { en: '€', ar: '€' }, USD: { en: '$', ar: '$' }, OMR: { en: 'OMR', ar: 'ر.ع' },
};

export function formatPrice(price: { amount: number | null; currency: string; from?: boolean; period?: string | null; onRequest?: boolean }, locale: Locale): string {
  if (!price || price.onRequest || price.amount == null) return locale === 'ar' ? 'السعر عند الطلب' : 'Price on request';
  const n = new Intl.NumberFormat('en-US').format(price.amount); // Western digits in both locales (Saudi convention for prices)
  const cur = currencyLabel[price.currency]?.[locale] ?? price.currency;
  const core = locale === 'ar' ? `${n} ${cur}` : (cur.length === 1 ? `${cur}${n}` : `${cur} ${n}`);
  const from = price.from ? (locale === 'ar' ? 'ابتداءً من ' : 'From ') : '';
  const period = price.period ? (locale === 'ar' ? (price.period === 'year' ? ' / سنوياً' : ' / شهرياً') : (price.period === 'year' ? ' / year' : ' / month')) : '';
  return `${from}${core}${period}`;
}

/** WhatsApp deep link with a pre-filled message. */
export function waLink(wa: string, message: string): string {
  return `https://wa.me/${wa}?text=${encodeURIComponent(message)}`;
}
