/**
 * The site-facts block (brain/DESIGN-brain.md §5.1): what replaces Retell's knowledge base, in
 * the cached prefix of every brain request. Built from src/data/site.json, about.json and
 * faq.json (the VPS sparse checkout holds `services` + `src/data`), plus a price-less index with
 * one line per published listing from listings.json, so the model can route ("do you have villas
 * in Obhur?") while every price, link and detail still comes from a tool.
 *
 * Rules, enforced here and not only by the tests:
 *   - no price, no unit: a listing contributes only id, title, district, city, kind, category
 *     (and "sold"/"reserved"); an about or FAQ paragraph that holds a money amount or a unit
 *     reference (reply-guard's own readers) is left out;
 *   - no privacy.json, no journal, no personal name (the advertiser, the team), no assistant
 *     name (site.json concierge.name is never read);
 *   - one deterministic plain-text block per language, at most MAX_FACT_TOKENS by a fixed
 *     tokens-per-character bound (FAQ answers shorten to their first paragraph, then the FAQ and
 *     the index are cut, firm facts first);
 *   - the four files are stat'ed at most every 30 s and rebuilt when one changes (the inventory
 *     pattern); a failed reload keeps the last good block. A failed first load is `ok() === false`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { findAmounts, unitRefs } from './reply-guard.mjs';

export const FACT_FILES = Object.freeze(['site.json', 'about.json', 'faq.json', 'listings.json']);
export const MAX_FACT_TOKENS = 6000;
export const STAT_MS = 30_000;

const ARABIC_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/gu;
/** A fixed upper bound: Arabic script at 2 characters a token, everything else at 3. */
export function estimateTokens(text) {
  const s = String(text ?? '');
  const arabic = (s.match(ARABIC_RE) ?? []).length;
  return Math.ceil(arabic / 2 + (Array.from(s).length - arabic) / 3);
}

const pick = (v, lang) => (v && typeof v === 'object' ? (v[lang] ?? v.en ?? '') : (v ?? ''));
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
/** A paragraph the block may carry: no money amount, no unit reference. */
const safe = (text) => {
  const s = clean(text);
  return s && findAmounts(s).length === 0 && unitRefs(s).length === 0 ? s : '';
};
const paragraphs = (v, lang) => {
  const p = pick(v, lang);
  return (Array.isArray(p) ? p : [p]).map(safe).filter(Boolean);
};

const LABELS = {
  en: {
    about: 'About Bona', name: 'Name', legal: 'Legal name', values: 'What Bona stands for', licence: 'Licence: REGA FAL brokerage licence',
    office: 'Office', hours: 'Office hours (Jeddah time)', contact: 'WhatsApp and phone', email: 'Email', site: 'Website', arabicSite: 'Arabic',
    markets: 'Markets', faq: 'Questions clients ask', index: 'Homes Bona lists (id · title · district, city · kind · category). Prices, links and details come only from the tools.',
    q: 'Q', a: 'A', list: ', ', status: { sold: 'sold', reserved: 'reserved' }, kind: { house: 'house', apartment: 'apartment', land: 'land', building: 'building' },
    category: { buy: 'buy', rent: 'rent', 'off-plan': 'off-plan', international: 'international' }, more: 'More homes are listed: use search_properties.',
  },
  ar: {
    about: 'عن بونا', name: 'الاسم', legal: 'الاسم الرسمي', values: 'ما تلتزم به بونا', licence: 'الرخصة: رخصة وساطة فال من الهيئة العامة للعقار رقم',
    office: 'المكتب', hours: 'ساعات العمل (بتوقيت جدة)', contact: 'واتساب والهاتف', email: 'البريد', site: 'الموقع', arabicSite: 'بالعربية',
    markets: 'الأسواق', faq: 'أسئلة يطرحها العملاء', index: 'العقارات التي تعرضها بونا (الرقم · العنوان · الحي، المدينة · النوع · الفئة). الأسعار والروابط والتفاصيل من الأدوات فقط.',
    q: 'س', a: 'ج', list: '، ', status: { sold: 'مباع', reserved: 'محجوز' }, kind: { house: 'منزل', apartment: 'شقة', land: 'أرض', building: 'مبنى' },
    category: { buy: 'للبيع', rent: 'للإيجار', 'off-plan': 'على الخارطة', international: 'دولي' }, more: 'هناك عقارات أخرى: استخدمي search_properties.',
  },
};

function firmFacts({ site = {}, about = {} }, lang) {
  const L = LABELS[lang];
  const lines = [L.about];
  const nameAr = clean(site.nameAr);
  lines.push(`${L.name}: ${clean(site.name)}${nameAr ? ` (${nameAr})` : ''}. ${L.legal}: ${clean(site.legalName)}.`);
  lines.push(...paragraphs(site.description, lang));
  lines.push(...paragraphs(about.story, lang));
  const values = (Array.isArray(about.values) ? about.values : [])
    .map((v) => [clean(pick(v?.title, lang)), safe(pick(v?.text, lang))]).filter(([t, x]) => t && x).map(([t, x]) => `${t}: ${x}`);
  if (values.length) lines.push(`${L.values}: ${values.join(' ')}`);
  if (/^\d{6,12}$/.test(String(site.licences?.fal ?? ''))) lines.push(`${L.licence} ${site.licences.fal}.`);
  const a = site.address?.[lang] ?? site.address?.en;
  if (a) lines.push(`${L.office}: ${[a.street, a.city, a.region, a.country].map(clean).filter(Boolean).join(L.list)}.`);
  if (pick(site.hours, lang)) lines.push(`${L.hours}: ${clean(pick(site.hours, lang))}.`);
  const phone = clean(site.whatsapp?.display ?? site.phone?.display);
  if (/^\+[\d ]{8,20}$/.test(phone)) lines.push(`${L.contact}: ${phone}.`);
  if (/^[^\s@]+@[^\s@]+$/.test(String(site.email ?? ''))) lines.push(`${L.email}: ${site.email}.`);
  if (/^https:\/\//.test(String(site.url ?? ''))) {
    const url = String(site.url).replace(/\/+$/, '');
    lines.push(`${L.site}: ${url} (${L.arabicSite}: ${url}/ar/).`);
  }
  const markets = (pick(site.markets, lang) || []).map(clean).filter(Boolean);
  if (markets.length) lines.push(`${L.markets}: ${markets.join(L.list)}.`);
  return lines.join('\n');
}

function faqLines({ faq = {} }, lang, { short = false } = {}) {
  const L = LABELS[lang];
  const items = Array.isArray(faq.items) ? faq.items : [];
  return items.map((it) => {
    const q = safe(pick(it?.q, lang));
    let a = paragraphs(it?.a, lang);
    if (short) a = a.slice(0, 1);
    return q && a.length ? `${L.q}: ${q}\n${L.a}: ${a.join(' ')}` : '';
  }).filter(Boolean);
}

function indexLines({ listings = [] }, lang) {
  const L = LABELS[lang];
  return (Array.isArray(listings) ? listings : [])
    .filter((l) => typeof l?.id === 'string' && /^BONA-[A-Z0-9-]{1,20}$/.test(l.id))
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .map((l) => {
      const title = safe(pick(l.title, lang));
      const place = [clean(pick(l.location?.district, lang)), clean(pick(l.location?.city, lang))].filter(Boolean).join(L.list);
      const parts = [l.id, title, place, L.kind[l.kind] ?? '', L.category[l.category] ?? ''];
      if (L.status[l.status]) parts.push(L.status[l.status]);
      return title ? parts.filter(Boolean).join(' · ') : '';
    })
    .filter(Boolean);
}

/**
 * @param {{ site?: object, about?: object, faq?: object, listings?: object[] }} data  the parsed files
 * @param {'ar'|'en'} language
 * @returns {string} the block, within MAX_FACT_TOKENS
 */
export function buildFacts(data, language) {
  const lang = language === 'en' ? 'en' : 'ar';
  const L = LABELS[lang];
  const firm = firmFacts(data ?? {}, lang);
  const index = indexLines(data ?? {}, lang);
  const assemble = (faq, idx, more) => [firm, faq.length ? `${L.faq}\n${faq.join('\n')}` : '', `${L.index}\n${idx.join('\n')}${more ? `\n${L.more}` : ''}`]
    .filter(Boolean).join('\n\n');
  let faq = faqLines(data ?? {}, lang);
  const full = assemble(faq, index, false);
  if (estimateTokens(full) <= MAX_FACT_TOKENS) return full;
  faq = faqLines(data ?? {}, lang, { short: true });
  const fits = (f, idx, more) => estimateTokens(assemble(f, idx, more)) <= MAX_FACT_TOKENS;
  if (fits(faq, index, false)) return assemble(faq, index, false);
  // Still over: keep the most FAQ items that fit with the whole index; if none fit, the most
  // index lines that fit with no FAQ. The firm facts always stay.
  const k = largest(faq.length, (n) => fits(faq.slice(0, n), index, false));
  if (k > 0) return assemble(faq.slice(0, k), index, false);
  const j = largest(index.length, (n) => fits([], index.slice(0, n), true));
  return assemble([], index.slice(0, Math.max(0, j)), true);
}

/** The largest n in [0, max] with ok(n), for an ok that holds up to some n and fails after it; -1 if ok(0) fails. */
function largest(max, ok) {
  if (!ok(0)) return -1;
  let lo = 0;
  let hi = max;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ok(mid)) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export function readFactFiles(dir) {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  const [site, about, faq, listings] = FACT_FILES.map(read);
  if (!Array.isArray(listings)) throw new TypeError('listings.json is not an array');
  return { site, about, faq, listings };
}

/**
 * @param {{ dir: string, now?: () => number, statMs?: number, read?: (dir: string) => object }} o
 *   `dir` holds the four files (the folder of cfg.inventoryFile)
 */
export function createSiteFacts({ dir, now = () => Date.now(), statMs = STAT_MS, read = readFactFiles } = {}) {
  let blocks = null;
  let mtimes = '';
  let statedAt = 0;
  let started = false;
  let version = 0;
  const stamp = () => FACT_FILES.map((f) => { try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch { return 0; } }).join(':');

  function load() {
    const m = stamp();
    try {
      const data = read(dir);
      blocks = { en: buildFacts(data, 'en'), ar: buildFacts(data, 'ar') };
      mtimes = m;
      version += 1;
    } catch {
      // Keep the last good copy; a first load that fails leaves the block empty and ok() false.
    }
    statedAt = now();
    started = true;
  }
  function fresh() {
    if (!started) { load(); return; }
    if (now() - statedAt < statMs) return;
    statedAt = now();
    if (stamp() !== mtimes) load();
  }

  return {
    ok() { fresh(); return blocks !== null; },
    block(language) { fresh(); return blocks ? blocks[language === 'en' ? 'en' : 'ar'] : ''; },
    version() { fresh(); return version; },
    reload: load,
  };
}
