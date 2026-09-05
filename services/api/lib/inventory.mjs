/**
 * Inventory: read `src/data/listings.json` from a repo checkout, search it, and turn
 * a listing into the compact `Card` the concierge widget renders.
 *
 * The file is generated (`scripts/curate/build.mjs`), so the service only ever reads
 * it. Price formatting mirrors `src/lib/i18n.ts` exactly — Western digits in both
 * locales, "Price on request" / "السعر عند الطلب" when there is no printed price.
 * Bona never estimates a price (TAQEEM), so an absent amount stays absent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `services/api/lib` → repo root of this worktree. */
export const WORKTREE_LISTINGS = path.resolve(HERE, '../../../src/data/listings.json');

export const RELOAD_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Locale helpers (mirrors of src/lib/i18n.ts + src/lib/listings.ts)    */
/* ------------------------------------------------------------------ */

const CURRENCY = {
  SAR: { en: 'SAR', ar: 'ر.س' },
  AED: { en: 'AED', ar: 'د.إ' },
  EUR: { en: '€', ar: '€' },
  USD: { en: '$', ar: '$' },
  OMR: { en: 'OMR', ar: 'ر.ع' },
};

/** Approximate SAR rates used ONLY for range filtering and sorting — never displayed. */
const SAR_RATE = { SAR: 1, AED: 1.02, USD: 3.75, EUR: 4.05, GBP: 4.75, OMR: 9.75 };

/** Mirrors src/data/kind-map.json; used only when a row has no explicit `kind`. */
export const KIND_BY_TYPE = {
  villa: 'house', mansion: 'house', duplex: 'house', palais: 'house', townhouse: 'house',
  chalet: 'house', house: 'house', apartment: 'apartment', penthouse: 'apartment',
  residence: 'apartment', studio: 'apartment', flat: 'apartment', land: 'land',
  plot: 'land', building: 'building', tower: 'building', office: 'building',
};
export const KINDS = ['house', 'apartment', 'land', 'building'];

export function kindOf(listing) {
  if (listing?.kind && KINDS.includes(listing.kind)) return listing.kind;
  return KIND_BY_TYPE[String(listing?.type ?? '').toLowerCase()] ?? 'house';
}

const TYPE_LABELS = {
  villa: { en: 'Villa', ar: 'فيلا' }, apartment: { en: 'Apartment', ar: 'شقة' },
  penthouse: { en: 'Penthouse', ar: 'بنتهاوس' }, mansion: { en: 'Mansion', ar: 'قصر' },
  land: { en: 'Land', ar: 'أرض' }, building: { en: 'Building', ar: 'عمارة' },
  duplex: { en: 'Duplex', ar: 'دوبلكس' }, townhouse: { en: 'Townhouse', ar: 'تاون هاوس' },
  chalet: { en: 'Chalet', ar: 'شاليه' }, office: { en: 'Office', ar: 'مكتب' },
  residence: { en: 'Residence', ar: 'مسكن' },
};
export const CATEGORY_LABELS = {
  buy: { en: 'For Sale', ar: 'للبيع' }, rent: { en: 'For Rent', ar: 'للإيجار' },
  'off-plan': { en: 'Off-Plan', ar: 'على الخارطة' }, international: { en: 'International', ar: 'عقارات دولية' },
};

export function typeLabel(type, locale = 'en') {
  const key = String(type ?? '').toLowerCase();
  const l = TYPE_LABELS[key];
  if (l) return l[locale] ?? l.en;
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : '';
}

/** Exactly the output of `formatPrice()` in src/lib/i18n.ts. */
export function formatPrice(price, locale = 'en') {
  if (!price || price.onRequest || price.amount == null) {
    return locale === 'ar' ? 'السعر عند الطلب' : 'Price on request';
  }
  const n = new Intl.NumberFormat('en-US').format(price.amount);
  const cur = CURRENCY[price.currency]?.[locale] ?? price.currency;
  const core = locale === 'ar' ? `${n} ${cur}` : cur.length === 1 ? `${cur}${n}` : `${cur} ${n}`;
  const from = price.from ? (locale === 'ar' ? 'ابتداءً من ' : 'From ') : '';
  const period = price.period
    ? locale === 'ar'
      ? price.period === 'year' ? ' / سنوياً' : ' / شهرياً'
      : price.period === 'year' ? ' / year' : ' / month'
    : '';
  return `${from}${core}${period}`;
}

/** Comparable SAR value for range filters; monthly rents annualised; unknown sorts last. */
export function sortablePrice(listing) {
  const p = listing?.price;
  if (!p || p.onRequest || p.amount == null) return Number.MAX_SAFE_INTEGER;
  const rate = SAR_RATE[p.currency] ?? 1;
  return Math.round((p.period === 'month' ? p.amount * 12 : p.amount) * rate);
}

/* ------------------------------------------------------------------ */
/* Text normalisation + free-text price parsing                        */
/* ------------------------------------------------------------------ */

const AR_INDIC = /[٠-٩۰-۹]/g;
const ARABIC_DIACRITICS = /[ً-ٰٟـ]/g;

/** Arabic-Indic (and extended) digits → ASCII; Arabic decimal/thousands marks → . and , */
export function toAsciiDigits(input) {
  return String(input ?? '')
    .replace(AR_INDIC, (d) => {
      const c = d.codePointAt(0);
      return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
    })
    .replace(/٫/g, '.')
    .replace(/٬/g, ',');
}

/** Fold a string for matching: lowercase, ASCII digits, Arabic letters unified, no punctuation. */
export function normalise(input) {
  return toAsciiDigits(input)
    .toLowerCase()
    .replace(ARABIC_DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'in', 'at', 'on', 'for', 'with', 'me', 'my', 'i', 'want', 'need',
  'looking', 'look', 'show', 'find', 'please', 'about', 'is', 'are', 'of', 'to', 'and',
  'al', 'and', 'any', 'you', 'have', 'do', 'got', 'near',
  'في', 'من', 'على', 'عن', 'الى', 'ابغى', 'ابي', 'اريد', 'ودي', 'عندكم', 'عندك', 'لو', 'سمحت', 'ممكن', 'هل', 'ال',
]);

/** Query tokens worth matching on. Drops stopwords and 1–2 character noise. */
export function tokenise(query) {
  return normalise(query)
    .split(' ')
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map((w) => (w.length >= 6 && w.startsWith('ال') ? w.slice(2) : w));
}

/** Latin suffixes that may sit straight after the digits ("4.5m", "750k"). */
const SUFFIX_MULTIPLIER = {
  k: 1e3, thousand: 1e3, thousands: 1e3,
  m: 1e6, mn: 1e6, mm: 1e6, mil: 1e6, million: 1e6, millions: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9, billions: 1e9,
};

/** Arabic multiplier words, matched as whole words (optionally prefixed by ب/و/ل). */
const AR_MULTIPLIERS = [
  [/^[بول]?(?:مليار|مليارات)$/u, 1e9],
  [/^[بول]?(?:مليون|ملايين|مليونين)$/u, 1e6],
  [/^[بول]?(?:الف|الاف|الفين)$/u, 1e3],
];

/**
 * Best-effort price parsing of free text: "4.5m", "4,500,000", "SAR 4.5 million",
 * "٤ ملايين", "٤٫٥ مليون", "750k". Returns a number in the listing currency (SAR
 * assumed) or null. Deliberately conservative — a wrong number is worse than none,
 * and Bona never estimates a price.
 */
export function parsePriceValue(input) {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  const raw = toAsciiDigits(input)
    .toLowerCase()
    .replace(ARABIC_DIACRITICS, '')
    .replace(/[أإآٱ]/gu, 'ا');
  if (!raw.trim()) return null;

  const m = raw.match(/(\d[\d,]*(?:\.\d+)?)\s*([a-z]*)/);
  let value = m ? Number(m[1].replace(/,/g, '')) : null;
  let multiplier = m && SUFFIX_MULTIPLIER[m[2]] ? SUFFIX_MULTIPLIER[m[2]] : 1;

  if (multiplier === 1) {
    const words = raw.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    outer: for (const w of words) {
      if (SUFFIX_MULTIPLIER[w]) { multiplier = SUFFIX_MULTIPLIER[w]; break; }
      for (const [re, mult] of AR_MULTIPLIERS) {
        if (re.test(w)) { multiplier = mult; break outer; }
      }
    }
  }

  if (value == null) {
    if (multiplier === 1) return null;
    value = /(?:^|\s)[بول]?(?:مليونين|الفين)(?:\s|$)/u.test(raw) ? 2 : 1;
  }
  if (!Number.isFinite(value)) return null;
  const out = Math.round(value * multiplier);
  return out > 0 ? out : null;
}

/* ------------------------------------------------------------------ */
/* Cards                                                               */
/* ------------------------------------------------------------------ */

export const propertyPath = (slug, locale) =>
  locale === 'ar' ? `/ar/properties/${slug}/` : `/properties/${slug}/`;

/** Local `/listings/…` and `/land/…` paths become absolute; remote URLs pass through. */
export function absoluteUrl(src, siteUrl) {
  if (!src) return null;
  const s = String(src);
  if (/^https?:\/\//i.test(s) || s.startsWith('data:')) return s;
  const base = String(siteUrl ?? '').replace(/\/+$/, '');
  return `${base}${s.startsWith('/') ? '' : '/'}${s}`;
}

/**
 * The Card contract consumed by the concierge widget (spec §3).
 * @returns {{id,slug,title,district,price,beds,baths,areaSqm,image,url}}
 */
export function toCard(listing, { siteUrl = 'https://bona.azoz.uk' } = {}) {
  if (!listing) return null;
  const img = listing.images?.[0] ?? null;
  const site = String(siteUrl).replace(/\/+$/, '');
  return {
    id: listing.id,
    slug: listing.slug,
    title: { en: listing.title?.en ?? '', ar: listing.title?.ar ?? listing.title?.en ?? '' },
    district: {
      en: listing.location?.district?.en ?? '',
      ar: listing.location?.district?.ar ?? listing.location?.district?.en ?? '',
    },
    price: { en: formatPrice(listing.price, 'en'), ar: formatPrice(listing.price, 'ar') },
    beds: listing.specs?.beds ?? null,
    baths: listing.specs?.baths ?? null,
    areaSqm: listing.specs?.areaSqm ?? null,
    image: {
      src: absoluteUrl(img?.src, site),
      thumb: absoluteUrl(img?.thumb ?? img?.src, site),
    },
    url: {
      en: `${site}${propertyPath(listing.slug, 'en')}`,
      ar: `${site}${propertyPath(listing.slug, 'ar')}`,
    },
  };
}

/** Compact row handed to the LLM by `search_properties` (kept small on purpose). */
export function toToolRow(listing, { siteUrl = 'https://bona.azoz.uk' } = {}) {
  const card = toCard(listing, { siteUrl });
  return {
    id: card.id,
    slug: card.slug,
    title_en: card.title.en,
    title_ar: card.title.ar,
    type: typeLabel(listing.type, 'en'),
    category: listing.category,
    district_en: card.district.en,
    district_ar: card.district.ar,
    city: listing.location?.city?.en ?? null,
    price_en: card.price.en,
    price_ar: card.price.ar,
    beds: card.beds,
    baths: card.baths,
    area_sqm: card.areaSqm,
    url_en: card.url.en,
    url_ar: card.url.ar,
  };
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

function haystack(listing) {
  const parts = [
    listing.title?.en, listing.title?.ar,
    listing.location?.district?.en, listing.location?.district?.ar,
    listing.location?.city?.en, listing.location?.city?.ar,
    listing.location?.country?.en, listing.location?.country?.ar,
    listing.type, typeLabel(listing.type, 'en'), typeLabel(listing.type, 'ar'),
    kindOf(listing),
    CATEGORY_LABELS[listing.category]?.en, CATEGORY_LABELS[listing.category]?.ar,
    listing.project?.name?.en, listing.project?.name?.ar,
    ...(listing.highlights?.en ?? []), ...(listing.highlights?.ar ?? []),
  ];
  return normalise(parts.filter(Boolean).join(' '));
}

const HAYSTACKS = new WeakMap();
function haystackOf(listing) {
  let h = HAYSTACKS.get(listing);
  if (h === undefined) { h = haystack(listing); HAYSTACKS.set(listing, h); }
  return h;
}

const STATUS_RANK = { available: 0, reserved: 1, sold: 2 };

/**
 * Filter + rank listings.
 * @param {Array} listings
 * @param {{kind?,type?,district?,category?,minPrice?,maxPrice?,beds?,query?,limit?,includeSold?}} q
 */
export function search(listings, q = {}) {
  const limit = Number.isFinite(q.limit) ? Math.max(1, Math.min(20, q.limit)) : 5;
  const wantKind = q.kind ? String(q.kind).toLowerCase().replace(/s$/, '') : null;
  const kind = wantKind && KINDS.includes(wantKind) ? wantKind : KIND_BY_TYPE[wantKind] ?? null;
  const typeKind = q.type ? KIND_BY_TYPE[String(q.type).toLowerCase()] ?? null : null;
  const wantType = q.type ? normalise(q.type) : null;
  const district = q.district ? normalise(q.district) : null;
  const category = q.category ? String(q.category).toLowerCase() : null;
  const minPrice = parsePriceValue(q.minPrice);
  const maxPrice = parsePriceValue(q.maxPrice);
  const beds = Number.isFinite(Number(q.beds)) && q.beds !== null && q.beds !== '' ? Number(q.beds) : null;
  const tokens = q.query ? tokenise(q.query) : [];

  const scored = [];
  for (const l of listings) {
    if (!l || typeof l !== 'object') continue;
    if (!q.includeSold && l.status === 'sold') continue;
    if (kind && kindOf(l) !== kind) continue;
    if (!kind && typeKind && kindOf(l) !== typeKind) continue;
    if (category && l.category !== category) continue;
    if (beds != null && !(Number(l.specs?.beds ?? 0) >= beds)) continue;

    const price = sortablePrice(l);
    const known = price !== Number.MAX_SAFE_INTEGER;
    if (minPrice != null && (!known || price < minPrice)) continue;
    if (maxPrice != null && (!known || price > maxPrice)) continue;

    const hay = haystackOf(l);
    let score = 0;
    if (district) {
      const d = normalise(`${l.location?.district?.en ?? ''} ${l.location?.district?.ar ?? ''} ${l.location?.city?.en ?? ''} ${l.location?.city?.ar ?? ''}`);
      const dTokens = tokenise(district);
      const hit = dTokens.length ? dTokens.some((t) => d.includes(t)) : d.includes(district);
      if (!hit) continue;
      score += 3;
    }
    if (wantType) {
      if (!hay.includes(wantType)) {
        if (!kind && !typeKind) continue;
      } else score += 2;
    }
    if (tokens.length) {
      const matched = tokens.filter((t) => hay.includes(t)).length;
      if (!matched) continue;
      score += matched * 2 + (matched === tokens.length ? 2 : 0);
    }
    if (l.featured) score += 1;
    scored.push({ listing: l, score, price });
  }

  scored.sort((a, b) =>
    b.score - a.score ||
    (STATUS_RANK[a.listing.status] ?? 3) - (STATUS_RANK[b.listing.status] ?? 3) ||
    a.price - b.price ||
    String(b.listing.listedAt ?? '').localeCompare(String(a.listing.listedAt ?? '')));

  return scored.slice(0, limit).map((s) => s.listing);
}

/** Exact lookup by id or slug (case-insensitive), then a loose title match. */
export function findOne(listings, ref) {
  if (!ref) return null;
  const needle = String(ref).trim().toLowerCase();
  const bare = needle.replace(/\/+$/, '').split('/').pop();
  const exact = listings.find(
    (l) => String(l.id).toLowerCase() === needle ||
      String(l.slug).toLowerCase() === needle ||
      String(l.slug).toLowerCase() === bare,
  );
  if (exact) return exact;
  const n = normalise(ref);
  if (n.length < 3) return null;
  return listings.find((l) => normalise(l.title?.en ?? '').includes(n) || normalise(l.title?.ar ?? '').includes(n)) ?? null;
}

/* ------------------------------------------------------------------ */
/* File source + hot reload                                           */
/* ------------------------------------------------------------------ */

/**
 * Which listings.json to serve.
 *   1. BONA_INVENTORY_FILE  2. $BONA_REPO/src/data/listings.json  3. this worktree's copy
 */
export function resolveInventoryFile(env = {}, { exists = fs.existsSync } = {}) {
  if (env.BONA_INVENTORY_FILE) return env.BONA_INVENTORY_FILE;
  if (env.BONA_REPO) {
    const candidate = path.join(env.BONA_REPO, 'src', 'data', 'listings.json');
    if (exists(candidate)) return candidate;
  }
  return WORKTREE_LISTINGS;
}

export function readInventoryFile(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new TypeError(`${file} is not a JSON array of listings`);
  return parsed;
}

/**
 * Inventory holder with a 10-minute lazy reload (and an mtime check, so an intake
 * publish shows up promptly). A failed reload keeps the last good copy.
 */
export function createInventory({ file, siteUrl = 'https://bona.azoz.uk', reloadMs = RELOAD_MS, now = () => Date.now(), read = readInventoryFile } = {}) {
  let listings = [];
  let loaded = false;
  let loadedAt = 0;
  let mtimeMs = 0;
  let lastError = null;

  function load() {
    try {
      listings = read(file);
      lastError = null;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch { mtimeMs = 0; }
    } catch (err) {
      lastError = err;
      if (!listings.length) listings = [];
    }
    loaded = true;
    loadedAt = now();
    return listings;
  }

  function maybeReload() {
    if (!loaded) return load();
    if (now() - loadedAt < reloadMs) return listings;
    let changed = true;
    try { changed = fs.statSync(file).mtimeMs !== mtimeMs; } catch { changed = true; }
    if (!changed) { loadedAt = now(); return listings; }
    return load();
  }

  return {
    file,
    siteUrl,
    get lastError() { return lastError; },
    all() { return maybeReload(); },
    count() { return maybeReload().length; },
    reload: load,
    search(q) { return search(maybeReload(), q); },
    find(ref) { return findOne(maybeReload(), ref); },
    card(listing) { return toCard(listing, { siteUrl }); },
    row(listing) { return toToolRow(listing, { siteUrl }); },
  };
}
