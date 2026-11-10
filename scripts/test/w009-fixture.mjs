// A frozen stand-in for BONA-W009 (Elvira Murjan) as the intake published it, for the tests that need
// a whole listing: a forged approval on every channel, a listings.json that carries it again, a
// re-import under a fresh id.
//
// The repository itself keeps only a TOMBSTONE of the real record
// (scripts/curate/inbox/elvira-murjan-townhouses-in-al-murjan.json). The developer withdrew the
// permission to advertise the project and the repository is public, so its marketing copy, photo list
// and brochure link are gone from it. What the withdrawal rule matches on is real here (the id, the
// slug, the project's names, the brochure's SHA-256); the copy, the photo labels and the developer are
// placeholders, so this file never becomes a second copy of the withdrawn listing.
export const W009_ID = 'BONA-W009';
export const W009_SLUG = 'elvira-murjan-townhouses-in-al-murjan';
export const W009_PDF_SHA256 = '7f6e4e4a4410e714fd9d717e1cad53dcd40fa4ddad0293de6a0f01cae5d403ea';

const ROOMS = ['exterior', 'facade_night', 'living', 'kitchen', 'master', 'bedroom', 'bathroom', 'terrace', 'pool', 'pool_night'];

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

/** The inbox record as it stood before the takedown (`hidden` and `_intake` included). */
export const W009_INBOX = deepFreeze({
  id: W009_ID,
  slug: W009_SLUG,
  sourceRef: null,
  status: 'available',
  category: 'off-plan',
  type: 'villa',
  kind: 'house',
  featured: false,
  title: { en: 'Elvira Murjan Townhouses in Al-Murjan', ar: 'منازل إلفيرا مرجان في حي المرجان' },
  location: {
    district: { en: 'Al-Murjan', ar: 'المرجان' },
    city: { en: 'Jeddah', ar: 'جدة' },
    country: { en: 'Saudi Arabia', ar: 'المملكة العربية السعودية' },
    countryCode: 'SA',
  },
  price: { amount: null, currency: 'SAR', from: false, period: null, onRequest: true },
  specs: { beds: 5, baths: 8, areaSqm: 630, plotSqm: 300, yearBuilt: null, floors: 3 },
  images: ROOMS.map((room, i) => {
    const n = String(i + 1).padStart(2, '0');
    return { src: `/listings/${W009_SLUG}/${n}.jpg`, thumb: `/listings/${W009_SLUG}/${n}-thumb.webp`, alt: { en: `Fixture photo ${n} (${room})`, ar: `صورة تجريبية ${n}` } };
  }),
  description: { en: 'Placeholder paragraph one.\n\nPlaceholder paragraph two.', ar: 'فقرة تجريبية أولى.\n\nفقرة تجريبية ثانية.' },
  highlights: { en: ['Fixture one', 'Fixture two', 'Fixture three', 'Fixture four'], ar: ['تجربة أولى', 'تجربة ثانية', 'تجربة ثالثة', 'تجربة رابعة'] },
  virtualTourUrl: null,
  brochureUrl: `https://bona-real-estate.com/listings/${W009_SLUG}/brochure.pdf`,
  project: { name: { en: 'Elvira Murjan', ar: 'إلفيرا مرجان' }, developer: { en: 'Fixture Developer', ar: 'مطور تجريبي' } },
  unit: null,
  map: null,
  listedAt: '2026-09-06',
  hidden: true,
  _intake: { source: 'whatsapp', pdfSha256: W009_PDF_SHA256, model: 'sonnet', confidence: 0.72, warnings: [], images: [], createdAt: '2026-09-06T11:36:26.618Z', site: 'https://bona-real-estate.com' },
});

/** A fresh, mutable copy of the pre-takedown inbox record. */
export const w009Inbox = () => structuredClone(W009_INBOX);

/** W009 as build.mjs published it to src/data/listings.json (and the live social catalogue served it). */
export function w009Listing() {
  const { hidden, _intake, ...l } = w009Inbox();
  return { ...l, licence: null, map: null, mapPrecision: null };
}
