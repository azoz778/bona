// Listing data + the words that go on top of it.
//
// Two rules run through every function here and neither is negotiable:
//   TAQEEM  — a price is only ever the asking price printed in src/data/listings.json.
//             Nothing in this file estimates, rounds, ranges or "from"s a number that is
//             not there. No price => "السعر عند الطلب / Price on request".
//   REGA    — a post that promotes a SPECIFIC property carries an advertising-licence line.
//             adLicence() decides the basis per listing: a property in the Kingdom needs a
//             REGA per-ad licence number (`listing.licence.adNumber`, recorded with the
//             WhatsApp `licence` command) — until one exists the copy carries the
//             {{AD_LICENCE}} placeholder and queue.mjs marks the entry blocked. A property
//             OUTSIDE the Kingdom cannot get a REGA ad licence (they bind to a Saudi deed);
//             it is marketed under the developer's authorisation (owner decision
//             2026-09-09) and its copy says so instead of carrying the placeholder.
// Also: nothing in this repo's social output may mention TK Estates.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './fonts.mjs';
import { LICENCE_NUMBER_RE, isCalendarDate } from '../../curate/rules.mjs';

export const AD_LICENCE_TOKEN = '{{AD_LICENCE}}';

export const site = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src/data/site.json'), 'utf8'));
export const BASE = site.url.replace(/\/$/, '');
export const WA_DISPLAY = site.whatsapp.display;
export const WA_LINK = `https://wa.me/${site.whatsapp.wa}`;
export const FAL = site.licences.fal;

/** Every listing the site publishes, in file order (BONA-### is positional). */
export function loadListings() {
  const all = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src/data/listings.json'), 'utf8'));
  return all.filter((l) => Array.isArray(l.images) && l.images.length);
}

export const t = (o, lang) => (o?.[lang] ?? o?.en ?? '');
export const listingUrl = (l, lang = 'en') => `${BASE}${lang === 'ar' ? '/ar' : ''}/properties/${l.slug}/`;

// ---------- labels ----------
export const TYPE = {
  villa: { en: 'Villa', ar: 'فيلا' }, apartment: { en: 'Apartment', ar: 'شقة' },
  penthouse: { en: 'Penthouse', ar: 'بنتهاوس' }, mansion: { en: 'Mansion', ar: 'قصر' },
  duplex: { en: 'Duplex', ar: 'دوبلكس' }, townhouse: { en: 'Townhouse', ar: 'تاون هاوس' },
  building: { en: 'Building', ar: 'عمارة' }, land: { en: 'Land', ar: 'أرض' },
  chalet: { en: 'Chalet', ar: 'شاليه' }, residence: { en: 'Residence', ar: 'مسكن' },
};
export const CATEGORY = {
  buy: { en: 'For sale', ar: 'للبيع' }, rent: { en: 'For rent', ar: 'للإيجار' },
  'off-plan': { en: 'Off-plan', ar: 'على الخارطة' }, international: { en: 'International', ar: 'عقار دولي' },
};
const CUR = {
  SAR: { en: 'SAR', ar: 'ر.س' }, AED: { en: 'AED', ar: 'د.إ' }, EUR: { en: '€', ar: '€' },
  USD: { en: '$', ar: '$' }, OMR: { en: 'OMR', ar: 'ر.ع' },
};

export const typeLabel = (l, lang) => t(TYPE[l.type] ?? TYPE.villa, lang);
export const districtLabel = (l, lang) => t(l.location?.district, lang);
export const cityLabel = (l, lang) => t(l.location?.city, lang);
export const placeLabel = (l, lang) => {
  const d = districtLabel(l, lang);
  const c = cityLabel(l, lang);
  return d && c && d !== c ? `${d}، ${c}`.replace('، ', lang === 'ar' ? '، ' : ', ') : d || c;
};

/**
 * The only place a price becomes words. `onRequest`, a null amount, or anything unparseable
 * all collapse to "Price on request" — never to a guess.
 */
export function priceText(l, lang) {
  const p = l.price;
  if (!p || p.onRequest || p.amount == null || !Number.isFinite(Number(p.amount))) {
    return lang === 'ar' ? 'السعر عند الطلب' : 'Price on request';
  }
  const n = new Intl.NumberFormat('en-US').format(p.amount);
  const c = t(CUR[p.currency] ?? { en: p.currency, ar: p.currency }, lang);
  const core = lang === 'ar' ? `${n} ${c}` : c.length === 1 ? `${c}${n}` : `${c} ${n}`;
  const from = p.from ? (lang === 'ar' ? 'ابتداءً من ' : 'From ') : '';
  const per = p.period ? (lang === 'ar' ? (p.period === 'year' ? ' / سنوياً' : ' / شهرياً') : p.period === 'year' ? ' / year' : ' / month') : '';
  return `${from}${core}${per}`;
}
export const hasPrice = (l) => !!(l.price && !l.price.onRequest && l.price.amount != null);

/** Specs as chips, in the order a buyer scans them. Missing values are simply absent. */
export function specChips(l, lang) {
  const s = l.specs || {};
  const out = [];
  if (s.beds) out.push(lang === 'ar' ? `${s.beds} غرف نوم` : `${s.beds} bed`);
  if (s.baths) out.push(lang === 'ar' ? `${s.baths} دورات مياه` : `${s.baths} bath`);
  if (s.areaSqm) out.push(lang === 'ar' ? `${s.areaSqm} م²` : `${s.areaSqm} m²`);
  if (s.plotSqm && s.plotSqm !== s.areaSqm) out.push(lang === 'ar' ? `أرض ${s.plotSqm} م²` : `${s.plotSqm} m² plot`);
  return out;
}
export const specLine = (l, lang) => specChips(l, lang).join(' · ');

export const firstPara = (s) => String(s || '').trim().split(/\n\s*\n/)[0].trim();

/** Deterministic per-listing variation, so re-running the generator does not reshuffle copy. */
export function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
}
export const pickBy = (arr, key) => arr[hash(key) % arr.length];

// ---------- hooks (the first 1.5 s of a reel / slide 1 of a carousel) ----------
// Factual only. The site validator bans hype ("stunning", "dream home", …) and TAQEEM bans
// anything that reads as a valuation, so every hook here is a fact already in the listing.
const HOOKS = [
  {
    id: 'specs-place',
    when: (l) => l.specs?.beds && districtLabel(l, 'ar'),
    ar: (l) => `${l.specs.beds} غرف نوم في ${districtLabel(l, 'ar')}`,
    en: (l) => `${l.specs.beds} bedrooms in ${districtLabel(l, 'en')}`,
  },
  {
    id: 'area-place',
    when: (l) => l.specs?.areaSqm && districtLabel(l, 'ar'),
    ar: (l) => `${l.specs.areaSqm} م² في ${districtLabel(l, 'ar')}`,
    en: (l) => `${l.specs.areaSqm} m² in ${districtLabel(l, 'en')}`,
  },
  {
    id: 'inside',
    when: (l) => districtLabel(l, 'ar'),
    ar: (l) => `داخل ${typeLabel(l, 'ar')} في ${districtLabel(l, 'ar')}`,
    en: (l) => `Inside a ${typeLabel(l, 'en').toLowerCase()} in ${districtLabel(l, 'en')}`,
  },
  {
    id: 'highlight',
    when: (l) => (l.highlights?.ar || []).length && (l.highlights?.en || []).length,
    ar: (l) => `${l.highlights.ar[0]} · ${districtLabel(l, 'ar')}`,
    en: (l) => `${l.highlights.en[0]} · ${districtLabel(l, 'en')}`,
  },
  {
    id: 'plot',
    when: (l) => l.kind === 'land' && l.specs?.plotSqm,
    ar: (l) => `أرض ${l.specs.plotSqm} م² · ${districtLabel(l, 'ar')}`,
    en: (l) => `${l.specs.plotSqm} m² plot · ${districtLabel(l, 'en')}`,
  },
];

/** @returns {{ar:string,en:string,id:string}} */
export function hookFor(l) {
  const usable = HOOKS.filter((h) => { try { return h.when(l); } catch { return false; } });
  const h = usable.length ? pickBy(usable, l.id) : null;
  if (!h) return { id: 'title', ar: t(l.title, 'ar'), en: t(l.title, 'en') };
  return { id: h.id, ar: h.ar(l), en: h.en(l) };
}

/**
 * Category as it reads INSIDE the subhook sentence, not as a standalone chip.
 * CATEGORY's labels are nouns/titles ("International"); lowercasing them into
 * "${type} ${label}" produced broken copy — "Apartment international · AIDA,
 * Muscat", and in Arabic the worse "شقة عقار دولي". An international listing is
 * still simply for sale; the place label already says it is abroad.
 */
const SUBHOOK_CATEGORY = {
  buy: { en: 'for sale', ar: 'للبيع' },
  rent: { en: 'for rent', ar: 'للإيجار' },
  'off-plan': { en: 'off-plan', ar: 'على الخارطة' },
  international: { en: 'for sale', ar: 'للبيع' },
};

/** The line under the hook — always the place, never a claim. */
export const subhookFor = (l) => ({
  ar: `${typeLabel(l, 'ar')} ${t(SUBHOOK_CATEGORY[l.category] ?? SUBHOOK_CATEGORY.buy, 'ar')} · ${placeLabel(l, 'ar')}`,
  en: `${typeLabel(l, 'en')} ${t(SUBHOOK_CATEGORY[l.category] ?? SUBHOOK_CATEGORY.buy, 'en')} · ${placeLabel(l, 'en')}`,
});

// ---------- hashtags (ported from scripts/og/gen-social.mjs so both agree) ----------
const H = {
  core: ['#بونا', '#عقارات_جدة', '#جدة', '#عقارات_السعودية', '#jeddahrealestate', '#luxuryrealestate', '#jeddah', '#saudirealestate', '#bona'],
  villa: ['#فلل_جدة', '#فلل_للبيع_في_جدة', '#فلل_فاخرة_جدة', '#فيلا_للبيع', '#luxuryvilla', '#villaforsale', '#jeddahvillas', '#luxuryhomes'],
  apartment: ['#شقق_جدة', '#شقق_فاخرة_جدة', '#شقق_للبيع', '#luxuryapartment', '#jeddahapartments', '#apartmentforsale', '#luxuryliving'],
  penthouse: ['#بنتهاوس_جدة', '#بنتهاوس', '#شقق_فاخرة_جدة', '#penthouse', '#penthouselife', '#luxuryapartment', '#luxuryliving'],
  mansion: ['#قصور_جدة', '#قصر_للبيع', '#فلل_فاخرة_جدة', '#mansion', '#luxuryvilla', '#luxuryhomes', '#jeddahvillas'],
  townhouse: ['#تاون_هاوس', '#فلل_جدة', '#townhouse', '#luxuryhomes', '#jeddahvillas'],
  land: ['#اراضي_جدة', '#أرض_للبيع', '#landforsale', '#jeddahland', '#investinjeddah', '#استثمار_عقاري'],
  building: ['#عمارة_للبيع', '#عقارات_استثمارية', '#buildingforsale', '#investinjeddah', '#استثمار_عقاري'],
  duplex: ['#دوبلكس_جدة', '#دوبلكس_للبيع', '#فلل_جدة', '#duplex', '#luxuryhomes', '#jeddahvillas'],
  rent: ['#للإيجار', '#فلل_للإيجار_جدة', '#شقق_للإيجار_جدة', '#villaforrent', '#jeddahrentals', '#luxuryrental'],
  water: ['#عقارات_الشاطئ', '#واجهة_بحرية', '#waterfrontliving', '#beachfrontvilla', '#seaview', '#redsea'],
  edu: ['#نصائح_عقارية', '#دليل_المشتري', '#شراء_عقار', '#realestatetips', '#homebuyingtips', '#jeddahproperty', '#saudiproperty'],
  brand: ['#منازل_استثنائية', '#quietluxury', '#luxuryinteriors', '#architecture', '#jeddahlife', '#saudiluxury', '#عمارة'],
  intl: ['#عقارات_دولية', '#internationalproperty', '#luxuryhomes', '#secondhome'],
  district: {
    'al khalidiyah': ['#الخالدية', '#alkhalidiyah'], khalidiyah: ['#الخالدية', '#alkhalidiyah'],
    obhur: ['#أبحر', '#ابحر_الشمالية', '#obhur'], abhur: ['#أبحر', '#ابحر_الشمالية', '#obhur'],
    sheraa: ['#الشراع', '#أبحر', '#obhur'], bandar: ['#البندر', '#أبحر', '#obhur'],
    'al shati': ['#الشاطئ', '#حي_الشاطئ', '#alshati'], shati: ['#الشاطئ', '#alshati'],
    'al rawdah': ['#الروضة', '#alrawdah'], rawdah: ['#الروضة', '#alrawdah'],
    'al zahra': ['#الزهراء', '#alzahra'], zahra: ['#الزهراء', '#alzahra'],
    salamah: ['#السلامة', '#alsalamah'], salama: ['#السلامة', '#alsalamah'],
    mohammadiyah: ['#المحمدية', '#almohammadiyah'], nahda: ['#النهضة', '#alnahdah'],
    murjan: ['#المرجان', '#almurjan'], basateen: ['#البساتين', '#albasateen'],
    durrat: ['#درة_العروس', '#durratalarous'], andalus: ['#الأندلس', '#alandalus'], hamra: ['#الحمراء', '#alhamra'],
    nuzha: ['#النزهة', '#alnuzhah'], warf: ['#واجهة_الورف', '#alwarf'], wareef: ['#الوريف', '#alwareef'],
    rayyan: ['#الريان', '#alrayyan'], khayala: ['#الخيالة', '#khayala'], madinah: ['#المدينة_المنورة', '#madinah'],
    riyadh: ['#عقارات_الرياض', '#الرياض', '#riyadh'], 'wadi safar': ['#وادي_صفار', '#wadisafar'],
    dubai: ['#عقارات_دبي', '#دبي', '#dubai'], meydan: ['#ميدان', '#meydan', '#dubai'],
    muscat: ['#عقارات_عمان', '#مسقط', '#oman'], aida: ['#aidaoman', '#مسقط', '#oman'],
    cannes: ['#cannes', '#cotedazur', '#كان'], marbella: ['#marbella', '#costadelsol', '#ماربيا'],
    benahav: ['#marbella', '#benahavis', '#costadelsol'],
  },
};
export const uniq = (a) => [...new Set(a)];

export function hashtagsFor(l, { limit = 20 } = {}) {
  const d = `${districtLabel(l, 'en')} ${cityLabel(l, 'en')}`.toLowerCase();
  const dist = Object.entries(H.district).filter(([k]) => d.includes(k)).flatMap(([, v]) => v);
  const water = /beach|sea|water|corniche|obhur|durrat|shati|marina|creek|wharf|waterfront/i
    .test(`${d} ${t(l.title, 'en')} ${(l.highlights?.en || []).join(' ')}`) ? H.water.slice(0, 3) : [];
  const type = H[l.type] || H.villa;
  const cat = l.category === 'rent' ? H.rent.slice(0, 3) : l.category === 'international' ? H.intl.slice(0, 2) : [];
  // Rotate the core block per listing so twenty posts do not carry an identical first line.
  const rot = hash(l.id) % H.core.length;
  const core = [...H.core.slice(rot), ...H.core.slice(0, rot)].slice(0, 6);
  return uniq([...core, ...type.slice(0, 6), ...dist.slice(0, 3), ...water, ...cat, '#بونا', '#bona']).slice(0, limit);
}
export const editorialTags = ({ kind = 'edu', extra = [], limit = 18 } = {}) =>
  uniq([...H.core.slice(0, 7), ...(H[kind] || H.edu).slice(0, 7), ...extra, '#بونا', '#bona']).slice(0, limit);

// ---------- captions ----------
const refLine = (l, lang) => (lang === 'ar'
  ? `المرجع ${l.id} — واتساب ${WA_DISPLAY} أو الرابط في البايو.`
  : `Ref. ${l.id} — WhatsApp ${WA_DISPLAY} or the link in bio.`);

const SAUDI_RE = /saudi|\bksa\b|^sa$|السعودية|المملكة/i;
/**
 * Countries Bona actually markets property in outside the Kingdom. A listing whose country is
 * neither Saudi nor on this list is NOT foreign — it is `unknown-country` and stays blocked
 * until someone fixes the data or adds the country here. Compliance gating fails closed.
 */
export const FOREIGN_COUNTRIES = new Set([
  'oman', 'united arab emirates', 'uae', 'bahrain', 'qatar', 'kuwait', 'jordan', 'egypt', 'lebanon',
  'morocco', 'turkey', 'türkiye', 'cyprus', 'greece', 'spain', 'portugal', 'france', 'monaco', 'italy',
  'switzerland', 'austria', 'germany', 'netherlands', 'united kingdom', 'uk', 'georgia', 'montenegro',
  'bosnia and herzegovina', 'malaysia', 'indonesia', 'thailand', 'maldives', 'mauritius', 'seychelles',
  'united states', 'usa', 'canada', 'australia',
]);
const countryOf = (l) => String(l?.location?.country?.en ?? '').trim().toLowerCase();
export const isSaudi = (l) => { const c = countryOf(l); return !c || SAUDI_RE.test(c); };
/** Foreign = a stated, recognised non-Saudi country. Odd strings ("KSA", "Jeddah", garbage) never are. */
export const isForeign = (l) => !isSaudi(l) && FOREIGN_COUNTRIES.has(countryOf(l));

const riyadhDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(d);
/** Values that pass the intake's shape check but are obviously not a licence number. */
const JUNK_NUMBER_RE = /^(tbd|pending|none|null|todo|n\/?a|x+|0+|-+)$/i;

/**
 * On what basis may this property be advertised?
 *   developer-authorisation — outside the Kingdom; marketed under the developer's mandate.
 *   rega-ad-licence         — a REGA per-ad licence number is recorded and not expired.
 *   rega-pending            — Saudi property with no valid number yet: placeholder, blocked.
 *   unknown-country         — country string is neither Saudi nor in FOREIGN_COUNTRIES: blocked.
 * The number must satisfy the intake's LICENCE_NUMBER_RE (and not be junk or the placeholder);
 * `adExpiry`, when present, must be a real YYYY-MM-DD and not before today in Riyadh. Anything
 * malformed counts as no licence — a line REGA can't be shown is worse than none.
 */
export function adLicence(l, { today = new Date() } = {}) {
  if (!isSaudi(l)) {
    return isForeign(l)
      ? { basis: 'developer-authorisation', number: null, blocked: false }
      : { basis: 'unknown-country', number: null, blocked: true, country: l?.location?.country?.en ?? '' };
  }
  const n = typeof l?.licence?.adNumber === 'string' ? l.licence.adNumber.trim() : '';
  const validNumber = n !== '' && n !== AD_LICENCE_TOKEN && LICENCE_NUMBER_RE.test(n) && !JUNK_NUMBER_RE.test(n);
  const exp = typeof l?.licence?.adExpiry === 'string' ? l.licence.adExpiry.trim() : '';
  const validExpiry = exp === '' || (isCalendarDate(exp) && exp >= riyadhDay(today));
  if (validNumber && validExpiry) return { basis: 'rega-ad-licence', number: n, blocked: false };
  return { basis: 'rega-pending', number: null, blocked: true };
}

export const developerLine = (lang) => (lang === 'ar'
  ? 'عقار خارج المملكة — يُسوَّق بتفويض من المطوّر.'
  : 'Property outside Saudi Arabia — marketed under developer authorisation.');

/**
 * The licence line for a listing post. With no listing (old call sites) it is the REGA
 * placeholder line; with one it follows adLicence().
 */
export function adLicenceLine(lang, l = null) {
  const a = l ? adLicence(l) : { basis: 'rega-pending', number: null };
  if (a.basis === 'developer-authorisation') return developerLine(lang);
  const n = a.number ?? AD_LICENCE_TOKEN;
  return lang === 'ar' ? `رقم ترخيص الإعلان العقاري: ${n}` : `REGA advertising licence: ${n}`;
}

/** FAL is the brokerage licence — a real number, and unrelated to the per-ad licence above. */
export const falLine = (lang) => (lang === 'ar'
  ? `ترخيص فال ${FAL}`
  : `FAL licence ${FAL}`);

/**
 * The caption for a listing post. Hashtags are NOT included — they go in the first comment
 * (see firstCommentFor) so the caption reads as prose in the feed.
 */
export function captionFor(l, lang, { format = 'post' } = {}) {
  const lines = [];
  lines.push(t(l.title, lang));
  lines.push(placeLabel(l, lang));
  const specs = specLine(l, lang);
  if (specs) lines.push(specs);
  lines.push('');
  const body = firstPara(t(l.description, lang));
  if (body) lines.push(body);
  const hi = (l.highlights?.[lang] ?? l.highlights?.en ?? []).slice(0, 4);
  if (hi.length) lines.push(hi.join(' · '));
  lines.push('');
  lines.push(priceText(l, lang));
  lines.push(refLine(l, lang));
  if (format === 'reel') {
    lines.push(lang === 'ar'
      ? 'الفيديو بلا موسيقى — أضف صوتاً رائجاً عند النشر.'
      : 'Silent by design — add a trending audio when you post.');
  }
  lines.push(adLicenceLine(lang, l));
  lines.push(falLine(lang));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function firstCommentFor(l, lang) {
  const tags = hashtagsFor(l).join(' ');
  const link = lang === 'ar' ? `التفاصيل: ${listingUrl(l, 'ar')}` : `Details: ${listingUrl(l, 'en')}`;
  return `${link}\n\n${tags}`;
}

/**
 * Does this piece need a REGA per-ad licence? Saudi property posts do (satisfied or not);
 * foreign property is on the developer's authorisation; editorial never needs one.
 */
export const adLicenceRequired = (item) => item.pillar === 'listings' && !(item.listing && isForeign(item.listing));
